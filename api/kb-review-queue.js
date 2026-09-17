/**
 * GET /api/kb-review-queue
 *
 * Admin-token gated (same as list-pending-programs.js). Powers the "Review
 * Queue" panel on /kb-review.html -- the live replacement for the one-off
 * claude.ai artifact snapshot built during the Sep 16, 2026 debugging
 * session (see claude/chalktalk-part2-rebuild-status.md). That snapshot
 * couldn't refresh itself; this endpoint queries kb_research_runs directly
 * so the page is always current.
 *
 * Returns every kb_research_runs row whose outcome needed a human look
 * (needs_review or insufficient_evidence), newest first, joined back to its
 * topic on kb_research_queue. Each row includes the model's self-reported
 * `sources` (from model_output) plus the real, tool-verified `citations` --
 * both are useful to a human reviewer for different reasons: `sources` is
 * what the model claims it used (with titles/quotes), `citations` is the
 * ground truth of what the search tool actually returned this run.
 *
 * UPDATED Sep 17, 2026 (in-page approve/reject build, see
 * claude/chalktalk-part2-rebuild-status.md): now also returns `queueId` and
 * the rest of the model's structured output (aliases, formation, summary,
 * structure, coachingLevel) so /kb-review.html can render an editable
 * approve form instead of Shaun having to describe curation decisions in
 * chat for a Claude-written SQL script. See api/kb-review-approve.js for
 * the write side.
 *
 * Requires two new nullable columns on kb_research_queue, added via
 * SQL--add-kb-review-admin-columns.sql (small additive ALTER TABLE, must be
 * run once before this endpoint/the approve endpoint work):
 *   admin_action text check (admin_action in ('approved','dismissed'))
 *   admin_reviewed_at timestamptz
 * status='done' alone isn't enough to tell "the cron finished this run and
 * it needs a human look" apart from "a human already looked and dismissed
 * it" -- research-knowledge.js sets status='done' for BOTH a successful
 * merge and a needs_review/insufficient_evidence outcome (only a hard
 * 'error' gets 'failed'). admin_action is the real, separate signal for
 * whether a human has acted on this row yet.
 *
 * Deliberately does NOT try to hide rows that have already been resolved by
 * a manual kb_entries insert (see SQL--add-coach-curated-kb-entries.sql) --
 * kb_research_runs has no "resolved" flag, and adding one is a real schema
 * decision, not something to sneak into a read endpoint. For now the page
 * cross-references against kb_entries.slug client-side (a row whose topic
 * already has a matching kb_entries row is shown as "already added").
 */

import { getSupabase } from "./_lib/knowledge-base.js";
import { validateAdminToken } from "./_lib/validate-admin.js";

function sendJson(res, status, body) {
  res.status(status).json(body);
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  const auth = validateAdminToken(req);
  if (!auth.ok) {
    return sendJson(res, auth.status, { error: auth.error });
  }

  const supabase = getSupabase();

  try {
    const { data: runs, error: runsError } = await supabase
      .from("kb_research_runs")
      .select("id, queue_id, outcome, notes, citations, model_output, created_at")
      .in("outcome", ["needs_review", "insufficient_evidence"])
      .order("created_at", { ascending: false })
      .limit(100);
    if (runsError) throw runsError;

    const queueIds = [...new Set((runs || []).map((r) => r.queue_id).filter(Boolean))];
    let queueById = {};
    if (queueIds.length > 0) {
      const { data: queueRows, error: queueError } = await supabase
        .from("kb_research_queue")
        .select("id, topic, normalized_slug, reason, requested_by, status, admin_action, admin_reviewed_at, created_at")
        .in("id", queueIds);
      if (queueError) throw queueError;
      queueById = Object.fromEntries((queueRows || []).map((q) => [q.id, q]));
    }

    // One run per topic slug, most recent only -- older repeated failures on
    // the same topic (e.g. three historical "5-Out Motion Offense" runs)
    // just add noise once the newest one is what actually matters.
    const seenSlugs = new Set();
    const deduped = [];
    for (const run of runs || []) {
      const queue = queueById[run.queue_id] || null;
      const slug = queue ? queue.normalized_slug : run.id;
      if (seenSlugs.has(slug)) continue;
      seenSlugs.add(slug);
      const mo = run.model_output || {};
      deduped.push({
        runId: run.id,
        queueId: run.queue_id || null,
        outcome: run.outcome,
        notes: run.notes,
        citations: run.citations || [],
        sources: mo.sources || [],
        systemName: mo.system_name || null,
        category: mo.category || null,
        formation: mo.formation || null,
        aliases: mo.aliases || [],
        summary: mo.summary || "",
        structure: mo.structure || {},
        coachingLevel: mo.coaching_level || null,
        createdAt: run.created_at,
        topic: queue ? queue.topic : null,
        normalizedSlug: queue ? queue.normalized_slug : null,
        reason: queue ? queue.reason : null,
        requestedBy: queue ? queue.requested_by : null,
        adminAction: queue ? queue.admin_action : null,
        adminReviewedAt: queue ? queue.admin_reviewed_at : null,
      });
    }

    // Cross-reference against kb_entries so the page can show "already
    // added" for anything a manual SQL pass, the new approve endpoint, or a
    // later successful auto-merge has already resolved, instead of showing
    // it as still pending forever.
    const { data: entries, error: entriesError } = await supabase
      .from("kb_entries")
      .select("slug, system_name, confidence, last_verified_at");
    if (entriesError) throw entriesError;
    const entryBySlug = Object.fromEntries((entries || []).map((e) => [e.slug, e]));

    for (const row of deduped) {
      const slug = row.normalizedSlug;
      row.alreadyInKb = slug ? Boolean(entryBySlug[slug]) : false;
      row.dismissed = row.adminAction === "dismissed";
    }

    return sendJson(res, 200, { ok: true, pending: deduped });
  } catch (err) {
    console.error("[kb-review-queue]", err.message);
    return sendJson(res, 502, { error: `Couldn't load the review queue: ${err.message}` });
  }
}
