/**
 * GET /api/my-teams
 * Header: Authorization: Bearer <viewer's Supabase access token>
 *
 * The real-login counterpart to api/team-access.js's token-based lookup --
 * for a player/parent who signed in with a real username+password account
 * (see public/player-login.html / api/invite-viewer.js) instead of a
 * tokenless access_links link. Returns the same shape of data
 * (program branding + every currently-published, non-hidden play) so
 * public/player-home.html can reuse the same rendering as
 * public/my-playbook.html.
 *
 * Named "my-teams" rather than "my-team" (singular) because a future
 * account could plausibly be linked to more than one roster row (e.g. a
 * parent with two kids on two different teams) -- today's schema is 1:1
 * (one viewer_accounts row per team_member row, see the migration SQL),
 * so this always returns exactly one team for now, but the response
 * shape is a `teams` array so that isn't a breaking change to add later.
 */

import { createClient } from "@supabase/supabase-js";
import { validateViewerSession } from "./_lib/validate-viewer-session.js";

const SUPABASE_URL = "https://dvilirimxnkaghqyoueh.supabase.co";

function getServiceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient(SUPABASE_URL, key);
}

export default async function handler(req, res) {
  const session = await validateViewerSession(req);
  if (!session.ok) {
    return res.status(session.status).json({ ok: false, error: session.error, expired: session.expired || false });
  }

  let service;
  try {
    service = getServiceClient();
  } catch (err) {
    console.error("[my-teams]", err.message);
    return res.status(500).json({ ok: false, error: "Server misconfiguration" });
  }

  const [{ data: program }, { data: plays }] = await Promise.all([
    service
      .from("programs")
      .select(
        "id, name, level, crest_label, crest_font, crest_image_url, crest_svg, color_primary, color_secondary, league_label, venue_label, location_label"
      )
      .eq("id", session.viewerAccount.program_id)
      .maybeSingle(),
    service
      .from("plays")
      .select("id, title, play_type, sub_category, phase_count, court_type, storage_url, updated_at")
      .eq("program_id", session.viewerAccount.program_id)
      .eq("status", "published")
      .eq("hidden", false)
      .order("updated_at", { ascending: false }),
  ]);

  if (!program) {
    return res.status(404).json({ ok: false, error: "Program not found" });
  }

  return res.status(200).json({
    ok: true,
    teams: [
      {
        program,
        memberName: session.teamMember?.name || null,
        role: session.teamMember?.role || null,
        plays: plays || [],
      },
    ],
  });
}
