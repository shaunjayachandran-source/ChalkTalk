/**
 * POST /api/invite-viewer
 * Body: { programId, teamMemberId, email }
 *
 * The real "Invite Player/Parent Login" endpoint -- the login-tier
 * counterpart to api/invite-coach.js, for the new player/parent account
 * system (Dartmouth pilot, Sep 15, 2026). Sends a real Supabase Auth
 * invite (same mechanism as invite-coach.js) and links the resulting
 * account to an existing `team_members` roster row via `viewer_accounts`.
 *
 * DELIBERATE PILOT GATE: this only works for programs in
 * PILOT_PROGRAM_SLUGS below. This is a genuine, code-enforced restriction
 * (not just an operational "please only use this for Dartmouth" note),
 * per Shaun's explicit Sep 15, 2026 answer to build this for Dartmouth
 * first before any wider rollout. Widen or remove this array once the
 * pilot proves out -- it's the only thing gating this feature to one
 * program, everything else here is general-purpose.
 *
 * "A parent holds the login for a below-high-school athlete" is handled
 * simply: the coach invites the PARENT's email address against the
 * ATHLETE's own team_members row. There's no separate parent-vs-athlete
 * schema branching needed because play visibility in this app has never
 * been per-athlete, only per-program (see api/team-access.js) -- so
 * whoever holds the login for a given roster row sees exactly what that
 * row's role already sees today via access_links.
 *
 * Authorization mirrors invite-coach.js's two-step pattern: validate the
 * caller's own coach session (RLS-scoped), confirm the team_member row
 * they're inviting for actually belongs to that program (also RLS-scoped,
 * via the caller's own session client), THEN switch to the service-role
 * client narrowly for the invite + the viewer_accounts write -- per the
 * locked permission matrix, "send invites" is available to all four coach
 * roles, not head-coach-only like invite-coach.js.
 */

import { createClient } from "@supabase/supabase-js";
import { validateCoachSession } from "./_lib/validate-session.js";

const SUPABASE_URL = "https://dvilirimxnkaghqyoueh.supabase.co";

// Dartmouth-only pilot, per Shaun's explicit Sep 15, 2026 rollout choice.
// Widen this list (or delete the check below) once the pilot proves out.
const PILOT_PROGRAM_SLUGS = ["dartmouth"];

const ALLOWED_ROLES = ["athlete", "parent"];

// Player/parent invite links land on the PLAYER login page (Sep 25, 2026 --
// previously no redirect was passed, so they fell back to Supabase's Site
// URL, the coach login.html, and then the coach dashboard). Must be listed
// under Supabase Auth -> URL Configuration -> Redirect URLs.
const SITE_ORIGIN = process.env.SITE_ORIGIN || "https://chalktalk-sand.vercel.app";

function getServiceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient(SUPABASE_URL, key);
}

function sendJson(res, status, body) {
  res.status(status).json(body);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  const { programId, teamMemberId, email } = req.body || {};

  if (!programId || !teamMemberId || !email) {
    return sendJson(res, 400, { error: "programId, teamMemberId, and email are all required" });
  }

  const session = await validateCoachSession(req, programId);
  if (!session.ok) {
    return sendJson(res, session.status, { error: session.error });
  }

  // Step 2: confirm this program is actually in the pilot -- checked via
  // the caller's own session-scoped client, so RLS is still what gates
  // the read itself; the slug allowlist is the pilot gate specifically.
  const { data: programRow, error: programErr } = await session.supabase
    .from("programs")
    .select("slug, name")
    .eq("id", programId)
    .maybeSingle();

  if (programErr || !programRow) {
    return sendJson(res, 403, { error: "Program not found, or you don't have access to it" });
  }

  if (!PILOT_PROGRAM_SLUGS.includes(programRow.slug)) {
    return sendJson(res, 403, {
      error: "Player/parent logins are currently limited to the Dartmouth pilot. Ask Shaun before enabling this for another program.",
    });
  }

  // Step 3: confirm the team_member row is real, belongs to this program,
  // and is an athlete/parent row (not a coach role -- use invite-coach for
  // that tier).
  const { data: memberRow, error: memberErr } = await session.supabase
    .from("team_members")
    .select("id, role, name")
    .eq("id", teamMemberId)
    .eq("program_id", programId)
    .maybeSingle();

  if (memberErr || !memberRow) {
    return sendJson(res, 404, { error: "Team member not found on this program" });
  }

  if (!ALLOWED_ROLES.includes(memberRow.role)) {
    return sendJson(res, 400, {
      error: `A login can only be invited for an athlete or parent roster row (this row is "${memberRow.role}"). Use /api/invite-coach for coaching staff.`,
    });
  }

  let serviceClient;
  try {
    serviceClient = getServiceClient();
  } catch (err) {
    console.error("[invite-viewer]", err.message);
    return sendJson(res, 500, { error: "Server misconfiguration" });
  }

  // Personalises the invite email. `audience: "viewer"` (and `isParent`)
  // are what the Supabase "Invite user" template branches on -- simple
  // truthy flags rather than comparing role strings, because Go templates
  // error when comparing a missing value, which would break coach invites
  // that don't carry these fields.
  const { data: inviterRow } = await serviceClient
    .from("coaches")
    .select("display_name")
    .eq("id", session.user.id)
    .maybeSingle();

  const { data: inviteData, error: inviteErr } = await serviceClient.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${SITE_ORIGIN}/player-login.html`,
    data: {
      audience: "viewer",
      role: memberRow.role,
      ...(memberRow.role === "parent" ? { isParent: "yes" } : {}),
      programName: programRow.name || "",
      inviterName: inviterRow?.display_name || "",
      athleteName: memberRow.name || "",
    },
  });

  if (inviteErr) {
    // Same posture as invite-coach.js: don't try to silently look up and
    // reuse an existing account for a different roster row -- surface it
    // clearly instead of guessing.
    return sendJson(res, 409, {
      error: `Couldn't invite ${email}: ${inviteErr.message}. If they already have a ChalkTalk login, attach them to this roster row directly via SQL instead.`,
    });
  }

  const newViewerId = inviteData.user.id;

  // onConflict on team_member_id: re-inviting the same roster row (e.g. a
  // parent's email was mistyped the first time) replaces which login
  // controls that row's access. This deliberately does NOT clean up the
  // old auth user if one existed -- a known v1 limitation, same posture as
  // invite-coach.js not handling account reassignment automatically.
  const { error: viewerUpsertErr } = await serviceClient
    .from("viewer_accounts")
    .upsert(
      { id: newViewerId, program_id: programId, team_member_id: teamMemberId, invited_email: email },
      { onConflict: "team_member_id" }
    );

  if (viewerUpsertErr) {
    return sendJson(res, 500, {
      error: `Invite sent, but failed to link the account to this roster row: ${viewerUpsertErr.message}. Attach it manually via SQL.`,
    });
  }

  return sendJson(res, 200, { ok: true, email, teamMemberId, role: memberRow.role, name: memberRow.name });
}
