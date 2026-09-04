/**
 * GET /api/team-access?token=<token>
 *
 * The real reader-side of the access_links system. A player/parent/coach
 * opens their personal link (my-playbook.html?token=...), that page calls
 * this endpoint, and this is the only thing in the app that turns a raw
 * token into actual content.
 *
 * Uses the service-role key deliberately: an anonymous visitor has no
 * Supabase session at all, so the anon/publishable key (which is RLS-scoped
 * to a logged-in coach's own programs) can't read access_links, plays, or
 * programs for this request no matter what. This endpoint is the one place
 * that's allowed to bypass RLS, and it does so narrowly -- it only ever
 * reads the one program a valid token actually points to.
 *
 * On success: returns that program's public branding fields, the team
 * member's name/role, and every currently-published play for that program
 * -- including the real storage_url. This is the one place in the whole
 * app that hands that out to someone who isn't a logged-in coach.
 *
 * On any failure (missing token, not found, revoked, expired): the exact
 * same generic { ok:false } response -- deliberately not distinguishing
 * *why* it failed, so a wrong guess can't be used to fish for which
 * failure mode applies.
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://dvilirimxnkaghqyoueh.supabase.co";

const GENERIC_FAILURE = "This link isn't valid, has been revoked, or has expired. Ask your coach for a new one.";

function getServiceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient(SUPABASE_URL, key);
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fail(res) {
  return res.status(200).json({ ok: false, error: GENERIC_FAILURE });
}

export default async function handler(req, res) {
  const token = typeof req.query.token === "string" ? req.query.token.trim() : "";
  if (!token) return fail(res);

  let supabase;
  try {
    supabase = getServiceClient();
  } catch (err) {
    console.error("[team-access]", err.message);
    return res.status(500).json({ ok: false, error: "Server misconfiguration." });
  }

  const tokenHash = await sha256Hex(token);

  const { data: link, error: linkErr } = await supabase
    .from("access_links")
    .select("id, program_id, team_member_id, role, revoked_at, expires_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (linkErr || !link) return fail(res);
  if (link.revoked_at) return fail(res);
  if (link.expires_at && new Date(link.expires_at) <= new Date()) return fail(res);

  const [{ data: program }, { data: teamMember }, { data: plays }] = await Promise.all([
    supabase
      .from("programs")
      .select(
        "name, level, crest_label, crest_font, crest_image_url, crest_svg, color_primary, color_secondary, league_label, venue_label, location_label"
      )
      .eq("id", link.program_id)
      .maybeSingle(),
    link.team_member_id
      ? supabase.from("team_members").select("name, role").eq("id", link.team_member_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("plays")
      .select("id, title, play_type, sub_category, phase_count, court_type, storage_url, updated_at")
    .eq("program_id", link.program_id)
      .eq("status", "published")
      .order("updated_at", { ascending: false }),
  ]);

  if (!program) return fail(res);

  // Best-effort -- a failed last_used_at write shouldn't block someone
  // from seeing their own playbook.
  supabase
    .from("access_links")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", link.id)
    .then(({ error }) => {
      if (error) console.error("[team-access] failed to update last_used_at:", error.message);
    });

  return res.status(200).json({
    ok: true,
    role: link.role,
    memberName: teamMember?.name || null,
    program,
    plays: plays || [],
  });
}
