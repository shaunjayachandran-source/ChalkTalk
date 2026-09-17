/**
 * POST /api/kb-review-approve
 *
 * Admin-token gated (same pattern as kb-review-queue.js). The write side of
 * the in-page KB review workflow built Sep 17, 2026 (see
 * claude/chalktalk-part2-rebuild-status.md) -- replaces the old chat-driven
 * "tell Claude which sources to keep, Claude writes a SQL script, run it in
 * Supabase" loop with a direct write from /kb-review.html.
 *
 * Two actions:
 *
 *   action: "approve" -- upserts a kb_entries row from the reviewed
 *     (and possibly hand-edited) fields, with confidence forced to
 *     'seed_verified' (a human picked every source here, same posture as
 *     SQL--add-coach-curated-kb-entries.sql). `sources` in the request body
 *     is the reviewer's OWN filtered list -- the page sends only the
 *     sources the reviewer left checked, so which links are kept vs.
 *     ignored is a real per-source decision made in the UI, not all-or-
 *     nothing. An empty sources array is allowed (e.g. "1-4 High" was
 *     deliberately entered with zero sources as a formation-only entry --
 *     see the rebuild status doc) but category/systemName/summary are
 *     still required, since those aren't optional on kb_entries.
 *
 *   action: "reject" -- does NOT touch kb_entries. Sets
 *     kb_research_queue.admin_action='dismissed' (+ admin_reviewed_at) so
 *     it stops showing as open on the review page, without pretending a
 *     kb_entries row exists. Use this for a topic that shouldn't be added
 *     at all (bad topic, duplicate, out of scope) -- distinct from
 *     "already added" (a real kb_entries row).
 *
 * Both actions require the kb_research_queue.admin_action / admin_reviewed_at
 * columns added by SQL--add-kb-review-admin-columns.sql (run once before
 * this endpoint is used) -- see kb-review-queue.js's header comment for why
 * kb_research_queue.status alone (already 'done' for every processed cron
 * run, reviewed or not) can't carry this signal.
 *
 * Both actions require `queueId` (kb_research_queue.id) so the queue row can
 * be updated -- a review card with no queueId (shouldn't happen in practice
 * since every run kb-review-queue.js surfaces is joined to one, but guarded
 * here anyway) can still approve into kb_entries, it just can't clear a
 * queue row that doesn't exist.
 */

import { getSupabase, slugify } from "./_lib/knowledge-base.js";
import { validateAdminToken } from "./_lib/validate-admin.js";

function sendJson(res, status, body) {
  res.status(status).json(body);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  const auth = validateAdminToken(req);
  if (!auth.ok) {
    return sendJson(res, auth.status, { error: auth.error });
  }

  const body = req.body || {};
  const { action, queueId } = body;

  if (action !== "approve" && action !== "reject") {
    return sendJson(res, 400, { error: "action must be 'approve' or 'reject'" });
  }

  const supabase = getSupabase();

  try {
    if (action === "reject") {
      if (!queueId) {
        return sendJson(res, 400, { error: "queueId is required to reject a topic" });
      }
      const { error } = await supabase
        .from("kb_research_queue")
        .update({ admin_action: "dismissed", admin_reviewed_at: new Date().toISOString() })
        .eq("id", queueId);
      if (error) throw error;
      return sendJson(res, 200, { ok: true, action: "reject", queueId });
    }

    // action === "approve"
    const systemName = (body.systemName || "").trim();
    const category = (body.category || "").trim();
    const summary = (body.summary || "").trim();
    if (!systemName || !category || !summary) {
      return sendJson(res, 400, { error: "systemName, category, and summary are all required to approve" });
    }
    if (category !== "offense" && category !== "defense") {
      return sendJson(res, 400, { error: "category must be 'offense' or 'defense'" });
    }

    // Sources are exactly what the reviewer left checked in the UI -- may
    // legitimately be an empty array (e.g. a formation-only entry with no
    // single canonical source, like 1-4 High).
    const sources = Array.isArray(body.sources)
      ? body.sources
          .filter((s) => s && s.url)
          .map((s) => ({ url: s.url, title: s.title || null, cited_text: s.cited_text || null }))
      : [];

    const aliases = Array.isArray(body.aliases)
      ? body.aliases.map((a) => String(a).trim().toLowerCase()).filter(Boolean)
      : [];

    const slug = slugify(body.slug || systemName);

    const payload = {
      system_name: systemName,
      slug,
      aliases,
      category,
      formation: body.formation || null,
      summary,
      structure: body.structure && typeof body.structure === "object" ? body.structure : {},
      sources,
      confidence: "seed_verified",
      coaching_level: body.coachingLevel || null,
      updated_at: new Date().toISOString(),
      last_verified_at: new Date().toISOString(),
    };

    const { data: upserted, error: upsertError } = await supabase
      .from("kb_entries")
      .upsert(payload, { onConflict: "slug" })
      .select("slug, system_name, source_count:sources")
      .single();
    if (upsertError) throw upsertError;

    if (queueId) {
      const { error: queueError } = await supabase
        .from("kb_research_queue")
        .update({ admin_action: "approved", admin_reviewed_at: new Date().toISOString() })
        .eq("id", queueId);
      // A queue-update failure shouldn't undo a successful kb_entries write
      // -- the entry is real either way, so this is logged, not thrown.
      if (queueError) console.error("[kb-review-approve] kb_entries written but queue status update failed:", queueError.message);
    }

    return sendJson(res, 200, {
      ok: true,
      action: "approve",
      slug: upserted.slug,
      systemName: upserted.system_name,
      sourceCount: sources.length,
    });
  } catch (err) {
    console.error("[kb-review-approve]", err.message);
    return sendJson(res, 502, { error: `Couldn't save this review decision: ${err.message}` });
  }
}
