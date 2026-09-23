/**
 * POST /api/invite-viewer
 * Body: { programId, teamMemberId, email }
 *
 * The real "Invite Player/Parent Login" endpoint -- the login-tier
 * counterpart to api/invite-coach.js, for the player/parent account
 * system (Dartmouth pilot, Sep 15, 2026). Sends a real Supabase Auth
 * invite (same mechanism as invite-coach.js) and links the resulting
 * account to an existing `team_members` roster row via `viewer_accounts`.
 *
 * PLAN-GATED (Phase 2, Prompt 7, changed 2026-09-23): this used to be
 * hard-restricted to a Dartmouth-only slug allowlist
 * (PILOT_PROGRAM_SLUGS). That's now replaced with a real plan check --
 * getPlanLimits(program.plan).viewerLoginsIncluded -- so this works for
 * every program on a plan that includes player/parent logins (D4:
 * defaulted to every HS-and-above tier, matching how Coach's Eye Audio
 * already draws that line), not just one hardcoded slug. Dartmouth keeps
 * working because its plan (college_d1, per the 2026-09-23 backfill)
 * resolves viewerLoginsIncluded: true -- no special-case needed.
 *
 * ROSTER-CAP CHECK (same commit): also added alongside the plan-gate
 * change rather than as a separate later change, per
 * claude/pricing-billing-engineering-anchors.md's explicit warning about
 * ending up with two independent gates doing the same job. IMPORTANT
 * SCOPE NOTE: this counts `viewer_accounts` rows (logins issued through
 * THIS endpoint), not `team_members` rows (roster size) -- see the gap
 * flagged in api/_lib/plan-limits.js's header comment: no API endpoint in
 * this repo inserts team_members rows, so a cap on total roster size
 * can't be enforced here. What this DOES fully stop is a trial program
 * (rosterCap: 0) ever having a player/parent login issued.
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
import { getPlanLimits } from "./_lib/plan-limits.js";

const SUPABASE_URL = "https://dvilirimxnkaghqyoueh.supabase.co";

const ALLOWED_ROLES = ["athlete", "parent"];

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

  // Step 2: resolve this program's plan (checked via the caller's own
  // session-scoped client, so RLS is still what gates the read itself)
  // and confirm player/parent logins are actually included on it.
  const { data: programRow, error: programErr } = await session.supabase
    .from("programs")
    .select("slug, plan")
    .eq("id", programId)
    .maybeSingle();

  if (programErr || !programRow) {
    return sendJson(res, 403, { error: "Program not found, or you don't have access to it" });
  }

  const limits = getPlanLimits(programRow.plan);
  if (!limits.viewerLoginsIncluded) {
    return sendJson(res, 403, {
      error: "Player/parent logins are not included on this program's current plan. Ask about upgrading to add them.",
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

  // Roster-login cap check -- see header comment on scope. Re-inviting a
  // login for the SAME roster row (e.g. a mistyped parent email) is
  // exempted: it replaces an existing viewer_accounts row, not a new one.
  if (limits.rosterCap !== null) {
    const { data: existingViewer } = await serviceClient
      .from("viewer_accounts")
      .select("id")
      .eq("team_member_id", teamMemberId)
      .maybeSingle();

    if (!existingViewer) {
      const { count, error: countErr } = await serviceClient
        .from("viewer_accounts")
        .select("id", { count: "exact", head: true })
        .eq("program_id", programId);
      if (countErr) {
        return sendJson(res, 500, { error: `Could not check current roster login count: ${countErr.message}` });
      }
      if ((count || 0) >= limits.rosterCap) {
        return sendJson(res, 403, {
          error: `This program's plan allows up to ${limits.rosterCap} player/parent login(s), and it's already at that limit. Ask about upgrading to add more.`,
        });
      }
    }
  }

  const { data: inviteData, error: inviteErr } = await serviceClient.auth.admin.inviteUserByEmail(email);

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
