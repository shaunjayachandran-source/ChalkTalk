/**
 * GET /api/get-narration?playId=<uuid>
 *
 * Item 2 (Auditory Narration): public, read-only lookup of a published
 * play's narration data (per-phase audio URL + player-segment timings).
 *
 * WHY THIS EXISTS AS ITS OWN ENDPOINT: the generated playbook shell
 * (buildShellHtml in generate-playbook.js) is uploaded to Vercel Blob
 * with access:"public" and served directly from there -- there is no
 * server-rendering step and no auth context once a coach or parent opens
 * that URL. narration_json is written to the `plays` row well after that
 * HTML was generated (generate-narration.js runs post-publish, often
 * after the shell was already uploaded), so it can't be baked into the
 * page at build time either. This endpoint is what the shell's own
 * playback JS calls at runtime to find out whether narration exists yet.
 *
 * Deliberately unauthenticated: a published, non-hidden play's diagrams
 * and sidebar content are already public via that same Blob URL, so
 * exposing its narration audio/timings through here adds no new
 * disclosure -- same trust boundary as the page itself. Anything not
 * currently status='published' and hidden=false is treated as "nothing
 * to show" rather than erroring, so this can't be used to confirm the
 * existence of an in-review or hidden play by probing playIds.
 *
 * Response (JSON):
 *   { generated: boolean, narration: [{ phaseNumber, audioUrl, timings, error? }] | null }
 *   or { error: string } with an appropriate status code
 */

import { getSupabase } from "./_lib/knowledge-base.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return sendJson(res, { error: "Method not allowed" }, 405);
  }

  const playId = req.query && req.query.playId;
  if (!playId || typeof playId !== "string") {
    return sendJson(res, { error: "Missing playId" }, 400);
  }

  let supabase;
  try {
    supabase = getSupabase();
  } catch (err) {
    return sendJson(res, { error: err.message }, 500);
  }

  const { data: play, error } = await supabase
    .from("plays")
    .select("status, hidden, narration_enabled, narration_json")
    .eq("id", playId)
    .maybeSingle();

  if (error) {
    return sendJson(res, { error: `Failed to load play: ${error.message}` }, 500);
  }

  if (!play || play.status !== "published" || play.hidden || !play.narration_enabled) {
    // Not an error case -- an in-review/hidden/opted-out play simply has
    // nothing to show here. Same shape as "narration not generated yet"
    // so this response never leaks which of those is actually true.
    return sendJson(res, { generated: false, narration: null });
  }

  return sendJson(res, {
    generated: Array.isArray(play.narration_json),
    narration: Array.isArray(play.narration_json) ? play.narration_json : null,
  });
}

function sendJson(res, obj, status = 200) {
  res.status(status).json(obj);
}
