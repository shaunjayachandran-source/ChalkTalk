/**
 * Vercel Cron worker: drains kb_research_queue, researches each topic for
 * real using Claude's server-side web_search tool, and auto-merges into
 * kb_entries ONLY when the result is genuinely sourced.
 *
 * THE "NO GUESSING" CONTRACT (see claude/knowledge-base-architecture.md):
 *   1. Never write a kb_entries row from model pretrained knowledge alone.
 *   2. The model must use the web_search tool; its own claim of being
 *      "sourced" is not trusted -- every URL it reports as a source is
 *      checked in code against the citation blocks the tool ACTUALLY
 *      returned (data Anthropic itself populates from real search results,
 *      not something the model can freely invent). Any self-reported
 *      source URL that doesn't appear in the real citation set fails the
 *      whole run -- see verifyCitations() below.
 *   3. Fewer than 2 independently-cited sources -> outcome
 *      'insufficient_evidence', nothing merged, logged for review.
 *   4. Every run (merged or not) is logged to kb_research_runs, so
 *      "auto-merge if sourced" stays auditable, not a black box.
 *   5. Never downgrade an existing 'seed_verified' row. If a topic already
 *      has a seed entry, this worker only ADDS structure/sources to it via
 *      manual review, never silently overwrites via auto-merge.
 *
 * Destination: api/research-knowledge.js
 * Trigger: Vercel Cron (see vercel.json) -- Vercel signs its own cron
 * requests with `Authorization: Bearer $CRON_SECRET`; this handler rejects
 * anything else. Requires env vars: SUPABASE_SERVICE_ROLE_KEY (already set
 * for other api/ files), ANTHROPIC_API_KEY (already set), CRON_SECRET (new
 * -- generate one and set it in both Vercel project settings and here).
 *
 * RETRY NOTE (added after a real production incident -- see
 * claude/known-failure-modes.md, Deployment / Vercel Pipeline section):
 * the very first two live cron/manual invocations both hit a 504 from
 * Supabase's REST endpoint on the initial queue fetch specifically -- a
 * direct SQL query against the same table via the Supabase SQL editor
 * responded instantly, and no matching Postgres-level log entry existed
 * for either failed request, meaning the request never reached the
 * database engine at all. That isolates the fault to the Supabase REST/
 * connection layer for this specific (service-role) request path, not a
 * bug in the query and not the database itself. fetchPendingTopics()
 * below retries that one call a couple of times before giving up, and the
 * handler now always returns real JSON on failure instead of crashing
 * unhandled -- so a repeat of this shows up as a clean, readable error
 * (or quietly succeeds on retry) instead of a bare 500 with no body.
 */

import { getSupabase, slugify, isStale, enqueueResearchTopic } from "./_lib/knowledge-base.js";
// Research/citation-gate logic now lives in a shared module so this cron
// worker and generate-brief.js's synchronous in-request research fallback
// (added Sep 15, 2026) can't silently drift out of sync -- see
// api/_lib/kb-research.js for the full rationale. Behavior here is
// unchanged; this is a relocation, not a rewrite.
import { researchTopic, verifyCitations, buildKbEntryUpsertPayload } from "./_lib/kb-research.js";

const MAX_TOPICS_PER_RUN = 5; // keep each cron invocation well under Vercel's function timeout
const QUEUE_FETCH_MAX_ATTEMPTS = 3; // 1 initial try + 2 retries
const QUEUE_FETCH_RETRY_DELAY_MS = 750;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retrying wrapper around the one Supabase call that has actually failed in
 * production so far (see the RETRY NOTE at the top of this file). Retries a
 * genuine thrown/rejected error (e.g. a gateway timeout) as well as a
 * {data, error} result with error set -- either shape gets one more chance
 * before this gives up and lets the caller decide what to do. Every attempt
 * (success or failure) is logged so a real incident is visible in Vercel's
 * logs, not silently swallowed.
 */
/**
 * PROACTIVE STALENESS SWEEP (added so the KB grows/refreshes on its own
 * 6-hour schedule instead of only reacting to a coach naming an unknown
 * system -- see claude/chalktalk-part2-rebuild-status.md, "Yes to both --
 * immediately"). Runs once at the top of every cron invocation, before the
 * normal queue drain below.
 *
 * Only ever re-queues 'auto_merged_sourced' rows -- a seed_verified row
 * (the 20 coach-curated systems) is never auto-requeued here; those are
 * curated content, not something this sweep should silently touch, same
 * rule processQueueRow() already enforces on the merge side.
 *
 * Reuses isStale() (age > STALE_AFTER_DAYS, already written and exported
 * from knowledge-base.js but never called anywhere until now) and
 * enqueueResearchTopic() (already does its own dedup against any
 * pending/running row for the same slug, so this is safe to run every
 * single cron tick without creating duplicate queue rows).
 *
 * Deliberately best-effort: any failure here is logged and swallowed, not
 * thrown -- a broken sweep must never block the normal queue drain below
 * it from running.
 */
async function enqueueStaleEntries(supabase) {
  try {
    const { data: entries, error } = await supabase
      .from("kb_entries")
      .select("id, system_name, last_verified_at, confidence")
      .eq("confidence", "auto_merged_sourced");

    if (error) throw error;

    const stale = (entries || []).filter(isStale);
    if (stale.length === 0) {
      console.log("[research-knowledge] staleness sweep: nothing stale");
      return { checked: entries ? entries.length : 0, queued: 0 };
    }

    let queued = 0;
    for (const entry of stale) {
      try {
        const queueId = await enqueueResearchTopic(entry.system_name, {
          reason: "staleness_sweep",
          requestedBy: "system",
        });
        if (queueId) queued++;
      } catch (err) {
        console.log(`[research-knowledge] staleness sweep: failed to enqueue "${entry.system_name}": ${err.message}`);
      }
    }
    console.log(`[research-knowledge] staleness sweep: ${stale.length} stale entr${stale.length === 1 ? "y" : "ies"}, ${queued} newly queued`);
    return { checked: entries.length, stale: stale.length, queued };
  } catch (err) {
    console.log(`[research-knowledge] staleness sweep failed (non-fatal, queue drain continues): ${err.message}`);
    return { checked: 0, queued: 0, error: err.message };
  }
}

async function fetchPendingTopics(supabase) {
  let lastError = null;
  for (let attempt = 1; attempt <= QUEUE_FETCH_MAX_ATTEMPTS; attempt++) {
    try {
      const { data, error } = await supabase
        .from("kb_research_queue")
        .select("*")
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(MAX_TOPICS_PER_RUN);

      if (error) {
        lastError = new Error(error.message);
      } else {
        if (attempt > 1) {
          console.log(`[research-knowledge] queue fetch succeeded on attempt ${attempt}/${QUEUE_FETCH_MAX_ATTEMPTS}`);
        }
        return data;
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }

    console.log(`[research-knowledge] queue fetch attempt ${attempt}/${QUEUE_FETCH_MAX_ATTEMPTS} failed: ${lastError.message}`);
    if (attempt < QUEUE_FETCH_MAX_ATTEMPTS) {
      await sleep(QUEUE_FETCH_RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

async function processQueueRow(supabase, row) {
  let outcome;
  let entryId = null;
  let notes = "";
  let citationsForLog = [];
  let modelOutput = null;

  try {
    const { parsed, realCitations, searchCallCount, rawContent } = await researchTopic(row.topic);
    citationsForLog = realCitations;
    modelOutput = parsed;

    // TEMPORARY DIAGNOSTIC (added Sep 16, 2026) -- extractRealCitations()
    // has returned an empty array on every single run since this cron went
    // live Sep 15, 2026 (confirmed via kb_research_runs.citations across 5
    // separate topics), which fails every citation gate regardless of how
    // well-sourced the model's actual research was. Rather than guess at
    // why, dump the raw content blocks Anthropic actually returned so the
    // real shape can be inspected directly in Vercel's runtime logs. Remove
    // this block once extractRealCitations() is confirmed fixed against the
    // real shape -- it's verbose by design, not meant to stay.
    if (realCitations.length === 0) {
      console.log(
        `[research-knowledge] DIAGNOSTIC raw content for "${row.topic}" (citations extraction returned empty):`,
        JSON.stringify(rawContent).slice(0, 8000)
      );
    }

    if (searchCallCount === 0) {
      outcome = "error";
      notes = "model never invoked web_search";
    } else if (!parsed) {
      outcome = "error";
      notes = "could not parse a JSON block from the model's response";
    } else if (parsed.insufficient_evidence) {
      outcome = "insufficient_evidence";
      notes = parsed.notes || "model reported insufficient evidence";
    } else {
      const gate = verifyCitations(parsed, realCitations);
      if (!gate.ok) {
        outcome = "needs_review";
        notes = `citation gate failed: ${gate.reason}`;
      } else {
        // Never let an auto-merge silently overwrite a coach-curated seed row.
        const { data: existingSeed } = await supabase
          .from("kb_entries")
          .select("id, confidence")
          .eq("slug", row.normalized_slug || slugify(row.topic))
          .maybeSingle();

        if (existingSeed && existingSeed.confidence === "seed_verified") {
          outcome = "needs_review";
          notes = `a seed_verified entry already exists for this slug -- auto-merge never overwrites a seed row; flagged for manual review of whether to enrich it`;
        } else {
          const upsertPayload = buildKbEntryUpsertPayload(parsed, slugify(parsed.system_name));

          const { data: inserted, error: upsertError } = await supabase
            .from("kb_entries")
            .upsert(upsertPayload, { onConflict: "slug" })
            .select("id")
            .single();

          if (upsertError) throw upsertError;
          entryId = inserted.id;
          outcome = "merged";
          notes = `merged with ${new Set(parsed.sources.map((s) => s.url)).size} verified source(s)`;
        }
      }
    }
  } catch (err) {
    outcome = "error";
    notes = String(err && err.message ? err.message : err);
  }

  await supabase.from("kb_research_runs").insert({
    queue_id: row.id,
    entry_id: entryId,
    outcome,
    citations: citationsForLog,
    model_output: modelOutput,
    notes,
  });

  await supabase
    .from("kb_research_queue")
    .update({
      status: outcome === "merged" ? "done" : outcome === "error" ? "failed" : "done",
      attempts: (row.attempts || 0) + 1,
      last_error: outcome === "error" ? notes : null,
      finished_at: new Date().toISOString(),
    })
    .eq("id", row.id);

  console.log(`[research-knowledge] "${row.topic}" -> ${outcome}: ${notes}`);
  return { topic: row.topic, outcome, notes };
}

export default async function handler(req, res) {
  const authHeader = req.headers["authorization"];
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const supabase = getSupabase();

  // Proactive step, runs before the normal drain below: top up the queue
  // with anything stale so the KB refreshes itself on this same 6-hour
  // schedule instead of only reacting to a coach naming an unknown system.
  const sweepResult = await enqueueStaleEntries(supabase);

  let pending;
  try {
    pending = await fetchPendingTopics(supabase);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.log(`[research-knowledge] queue fetch failed after ${QUEUE_FETCH_MAX_ATTEMPTS} attempt(s): ${message}`);
    res.status(500).json({ error: `queue fetch failed after ${QUEUE_FETCH_MAX_ATTEMPTS} attempt(s): ${message}`, staleness_sweep: sweepResult });
    return;
  }

  if (!pending || pending.length === 0) {
    res.status(200).json({ processed: 0, results: [], staleness_sweep: sweepResult });
    return;
  }

  const claimedIds = pending.map((r) => r.id);
  await supabase
    .from("kb_research_queue")
    .update({ status: "running", claimed_at: new Date().toISOString() })
    .in("id", claimedIds);

  const results = [];
  for (const row of pending) {
    results.push(await processQueueRow(supabase, row));
  }

  res.status(200).json({ processed: results.length, results, staleness_sweep: sweepResult });
}
