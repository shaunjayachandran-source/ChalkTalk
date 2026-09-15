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

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
const MIN_DISTINCT_SOURCES = 2;
const MAX_TOPICS_PER_RUN = 5; // keep each cron invocation well under Vercel's function timeout
const QUEUE_FETCH_MAX_ATTEMPTS = 3; // 1 initial try + 2 retries
const QUEUE_FETCH_RETRY_DELAY_MS = 750;

const RESEARCH_SYSTEM_PROMPT = `You are a basketball research assistant for ChalkTalk, a coaching-playbook
product. You are given the name of an offensive or defensive system a coach
typed or said aloud, which is NOT YET in ChalkTalk's knowledge base. Your job
is to research it for real using the web_search tool and produce a single
structured JSON entry -- or say plainly that you could not find enough to be
confident.

HARD RULES:
- You MUST use the web_search tool at least once before answering. Do not
  answer from memory alone.
- Every factual/structural claim in your output (personnel, spacing,
  formation, key reads, who runs it) must be something you actually found in
  a search result during this conversation, not something you already knew
  before searching. If your prior knowledge and the search results agree,
  cite the search result anyway -- citations are what make this trustworthy,
  not correctness alone.
- If your searches turn up fewer than 2 independent, credible sources that
  substantively describe this system, DO NOT pad the entry with guesses. Set
  "insufficient_evidence": true and explain what you found and didn't find.
- Never fabricate a URL, title, or quote. Only report sources you actually
  retrieved via the tool this turn.
- Basketball terminology is often used loosely online (the same name can mean
  different things at different levels). If sources disagree or the term is
  ambiguous, say so in "notes" rather than picking one interpretation
  silently.

Respond with your reasoning first if useful, then end your response with
exactly one fenced code block, \`\`\`json ... \`\`\`, containing an object with
this exact shape:

{
  "insufficient_evidence": false,
  "system_name": "Canonical name, Title Case",
  "category": "offense" | "defense",
  "formation": "e.g. 4-out 1-in, 2-3, 1-3-1, or null if not applicable",
  "aliases": ["lowercase alt names/abbreviations"],
  "summary": "2-4 sentence plain-language description a parent could follow",
  "structure": {
    "personnel": "who's involved and where they start",
    "key_action": "the core mechanism (screen, cut, read, trap, etc.)",
    "common_variations": "brief note on notable variants, if any"
  },
  "coaching_level": "youth" | "high-school" | "college" | "pro" | null,
  "sources": [
    { "url": "https://...", "title": "...", "cited_text": "short quote or paraphrase of what this source told you" }
  ],
  "notes": "anything uncertain, disputed, or worth a human reviewer's attention"
}`;

function extractJsonBlock(text) {
  const m = text.match(/```json\s*([\s\S]*?)```/i);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// Pulls every citation Anthropic itself attached to the response's text
// blocks. These come from the tool's own search results -- the model
// cannot inject an arbitrary URL into this array, which is exactly why it's
// the ground truth we check self-reported sources against, not the other
// way around.
function extractRealCitations(contentBlocks) {
  const seen = new Map(); // url -> {url, title}
  for (const block of contentBlocks || []) {
    if (block.type !== "text" || !Array.isArray(block.citations)) continue;
    for (const c of block.citations) {
      if (c.type === "web_search_result_location" && c.url) {
        seen.set(c.url, { url: c.url, title: c.title || null });
      }
    }
  }
  return [...seen.values()];
}

function countSearchToolResults(contentBlocks) {
  return (contentBlocks || []).filter((b) => b.type === "web_search_tool_result").length;
}

/**
 * The code-level gate. Never trust the model's "sources" array on its own
 * word -- cross-check every reported URL against citations Anthropic itself
 * attached from real search results this turn.
 */
function verifyCitations(parsed, realCitations) {
  const realUrls = new Set(realCitations.map((c) => c.url));
  const reported = Array.isArray(parsed.sources) ? parsed.sources : [];

  if (reported.length === 0) {
    return { ok: false, reason: "model reported zero sources" };
  }

  const unverified = reported.filter((s) => !realUrls.has(s.url));
  if (unverified.length > 0) {
    return {
      ok: false,
      reason: `${unverified.length} reported source(s) do not match any real citation this run actually returned: ${unverified.map((s) => s.url).join(", ")}`,
    };
  }

  const distinctVerified = new Set(reported.map((s) => s.url));
  if (distinctVerified.size < MIN_DISTINCT_SOURCES) {
    return {
      ok: false,
      reason: `only ${distinctVerified.size} distinct verified source(s), need at least ${MIN_DISTINCT_SOURCES}`,
    };
  }

  return { ok: true };
}

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

async function researchTopic(topic) {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      system: RESEARCH_SYSTEM_PROMPT,
      tools: [
        {
          type: "web_search_20260318",
          name: "web_search",
          max_uses: 5,
          // Restricted to Shaun's designated first research spots (Sep 15,
          // 2026) rather than the open web -- these are coach-vetted
          // reference sites, not generic search results. allowed_domains
          // and blocked_domains are mutually exclusive on this tool (a 400
          // error if both are set), so this is a hard allowlist: a topic
          // not covered on either site will correctly fail the citation
          // gate as insufficient_evidence rather than silently falling
          // back to broader, unvetted search results. Widen this list
          // (or drop it) once coverage from just these two proves too
          // narrow in practice -- not yet tested against a real run.
          allowed_domains: [
            "coachesclipboard.net",
            "www.coachesclipboard.net",
            "basketballforcoaches.com",
            "www.basketballforcoaches.com",
          ],
        },
      ],
      messages: [
        {
          role: "user",
          content: `Research this basketball system for ChalkTalk's knowledge base: "${topic}"`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error researching "${topic}": ${errText}`);
  }

  const data = await res.json();
  const textBlocks = (data.content || []).filter((b) => b.type === "text");
  const fullText = textBlocks.map((b) => b.text).join("\n");
  const parsed = extractJsonBlock(fullText);
  const realCitations = extractRealCitations(data.content);
  const searchCallCount = countSearchToolResults(data.content);

  return { parsed, realCitations, searchCallCount, rawContent: data.content };
}

async function processQueueRow(supabase, row) {
  let outcome;
  let entryId = null;
  let notes = "";
  let citationsForLog = [];
  let modelOutput = null;

  try {
    const { parsed, realCitations, searchCallCount } = await researchTopic(row.topic);
    citationsForLog = realCitations;
    modelOutput = parsed;

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
          const upsertPayload = {
            system_name: parsed.system_name,
            slug: slugify(parsed.system_name),
            aliases: parsed.aliases || [],
            category: parsed.category,
            formation: parsed.formation || null,
            summary: parsed.summary,
            structure: parsed.structure || {},
            sources: parsed.sources,
            confidence: "auto_merged_sourced",
            coaching_level: parsed.coaching_level || null,
            updated_at: new Date().toISOString(),
            last_verified_at: new Date().toISOString(),
          };

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
