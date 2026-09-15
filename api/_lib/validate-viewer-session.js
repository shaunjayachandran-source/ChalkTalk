/**
 * Session-based auth helper for the new player/parent login tier
 * (Dartmouth pilot, Sep 15, 2026) -- the real-login counterpart to
 * api/_lib/validate-session.js's coach-tier validateCoachSession(), for
 * the tier that used to be tokenless-only (access_links).
 *
 * A player/parent is a real Supabase Auth user (see api/invite-viewer.js),
 * with a `viewer_accounts` row linking that auth user to exactly one
 * `team_members` row (and therefore one program). The browser sends the
 * Supabase access token in an `Authorization: Bearer <token>` header, same
 * convention as the coach tier, and this helper:
 *
 *   1. Verifies the token is a real, current Supabase session.
 *   2. Looks up the matching `viewer_accounts` row via the service-role
 *      client (viewer_accounts has RLS enabled with zero policies -- it's
 *      only ever read here, narrowly, after independently confirming the
 *      token is real; see the migration SQL for the full rationale).
 *   3. Enforces the LOCKED ROLLING 2-HOUR SESSION requirement (see
 *      claude/chalktalk-part2-rebuild-status.md -- "Locked requirement,
 *      Sep 3, 2026," resolved rolling/sliding per Shaun's Sep 15, 2026
 *      answer, not a hard expiry). This is deliberately NOT the same
 *      thing as Supabase Auth's own JWT/refresh-token lifetime, which
 *      would otherwise silently renew forever -- `viewer_activity` is a
 *      separate, app-owned idle timer that every authorized request both
 *      checks and extends. A request arriving after 2+ hours of no
 *      activity is rejected with `expired: true` even if the Supabase
 *      session itself is technically still valid, so the client can force
 *      a real re-login with username+password as required.
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://dvilirimxnkaghqyoueh.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_hhEb5Mj8QS1Byv8_Ne6FIw_NbZHbu9-";

const ROLLING_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours, locked requirement

function extractBearerToken(req) {
  const header = req.headers && req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim();
}

function getServiceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient(SUPABASE_URL, key);
}

/**
 * Validates the request's Authorization header as a logged-in player or
 * parent viewer account. Returns:
 *   { ok: true, user, viewerAccount, teamMember }
 *   { ok: false, error, status, expired? }  -- expired:true specifically
 *                                               means "valid login, but the
 *                                               2-hour idle window lapsed,"
 *                                               distinct from a genuinely
 *                                               invalid/unrecognized token,
 *                                               so the client can show a
 *                                               clearer message.
 */
export async function validateViewerSession(req) {
  const token = extractBearerToken(req);
  if (!token) {
    return { ok: false, error: "Missing or invalid Authorization header", status: 401 };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });

  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData || !userData.user) {
    return { ok: false, error: "Invalid or expired session -- please log in again", status: 401 };
  }

  let service;
  try {
    service = getServiceClient();
  } catch (err) {
    console.error("[validate-viewer-session]", err.message);
    return { ok: false, error: "Server misconfiguration", status: 500 };
  }

  const { data: viewerAccount, error: vaErr } = await service
    .from("viewer_accounts")
    .select("id, program_id, team_member_id")
    .eq("id", userData.user.id)
    .maybeSingle();

  if (vaErr || !viewerAccount) {
    return { ok: false, error: "This account isn't set up as a player/parent viewer.", status: 403 };
  }

  const now = new Date();
  const { data: activity } = await service
    .from("viewer_activity")
    .select("last_seen_at")
    .eq("viewer_account_id", viewerAccount.id)
    .maybeSingle();

  if (activity && now.getTime() - new Date(activity.last_seen_at).getTime() > ROLLING_WINDOW_MS) {
    return {
      ok: false,
      error: "Your session has been idle too long. Please log in again.",
      status: 401,
      expired: true,
    };
  }

  // Rolling extension: every authorized request pushes the idle clock
  // forward, so an actively-browsing parent never gets cut off mid-use --
  // only genuine idleness past 2 hours triggers the check above.
  await service
    .from("viewer_activity")
    .upsert({ viewer_account_id: viewerAccount.id, last_seen_at: now.toISOString() }, { onConflict: "viewer_account_id" });

  const { data: teamMember } = await service
    .from("team_members")
    .select("name, role")
    .eq("id", viewerAccount.team_member_id)
    .maybeSingle();

  return { ok: true, user: userData.user, viewerAccount, teamMember };
}
