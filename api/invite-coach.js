/**
 * POST /api/invite-coach
 * Body: { programId, email, role, canPublish, name? }
 *
 * The real "Invite Coach" endpoint -- replaces the fully manual process of
 * Shaun going into Supabase Auth's Users panel, inviting a coach by hand,
 * then running SQL to insert their `coaches` + `program_coaches` rows.
 * That manual path is exactly what surfaced as a hard blocker onboarding
 * LSU/Dartmouth's full staffs (Aug 19, 2026 QA round).
 *
 * Two-step authorization, mirroring api/team-access.js's pattern of "verify
 * narrowly with the caller's own session, then use the service-role key
 * only for the specific privileged action already authorized":
 *
 *   1. validateCoachSession() confirms the caller has a real, current
 *      Supabase session AND that `programId` is visible to them under RLS.
 *   2. A second, stricter check confirms the caller is specifically
 *      head_coach on that program -- per the locked permission matrix,
 *      managing other coaches on a program is head_coach only. This is
 *      checked with the caller's own session-scoped client, so RLS (not
 *      application code) is still what actually gates the read.
 *
 * Only after both checks pass does this switch to the service-role client,
 * narrowly to invite the new user and write their `coaches` +
 * `program_coaches` rows -- a service-role client is used here (rather than
 * relying on the session client's own RLS insert policy) because this
 * project's `coaches` table RLS has never been directly inspected, and
 * getting that wrong would either silently fail or need guessing at a
 * policy that was never confirmed. Narrowly bypassing RLS for a write that
 * was already independently authorized above is safer than assuming.
 */

import { createClient } from "@supabase/supabase-js";
import { validateCoachSession } from "./_lib/validate-session.js";

const SUPABASE_URL = "https://dvilirimxnkaghqyoueh.supabase.co";

const ALLOWED_ROLES = ["assistant_coach", "graduate_assistant", "dbo"];

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

  const { programId, email, role, canPublish, name } = req.body || {};

  if (!programId || !email || !role) {
    return sendJson(res, 400, { error: "programId, email, and role are all required" });
  }
  if (!ALLOWED_ROLES.includes(role)) {
    return sendJson(res, 400, {
      error: `role must be one of: ${ALLOWED_ROLES.join(", ")} (use the Supabase Auth panel directly for a second head_coach)`,
    });
  }

  const session = await validateCoachSession(req, programId);
  if (!session.ok) {
    return sendJson(res, session.status, { error: session.error });
  }

  // Step 2: confirm the caller is head_coach on this specific program,
  // using their own session-scoped client so RLS enforces the read.
  const { data: callerRow, error: callerErr } = await session.supabase
    .from("program_coaches")
    .select("role")
    .eq("program_id", programId)
    .eq("coach_id", session.user.id)
    .maybeSingle();

  if (callerErr || !callerRow || callerRow.role !== "head_coach") {
    return sendJson(res, 403, { error: "Only the head coach can invite other coaches onto this program" });
  }

  let serviceClient;
  try {
    serviceClient = getServiceClient();
  } catch (err) {
    console.error("[invite-coach]", err.message);
    return sendJson(res, 500, { error: "Server misconfiguration" });
  }

  const { data: inviteData, error: inviteErr } = await serviceClient.auth.admin.inviteUserByEmail(email);

  if (inviteErr) {
    // Most common real case: this email already has an account. We don't
    // try to silently look up and reuse an existing user here -- surfacing
    // it clearly is safer than guessing which existing account was meant.
    return sendJson(res, 409, {
      error: `Couldn't invite ${email}: ${inviteErr.message}. If they already have a ChalkTalk account, attach them to this program directly via SQL instead.`,
    });
  }

  const newCoachId = inviteData.user.id;

    const trimmedName = typeof name === "string" ? name.trim() : "";

  const { error: coachUpsertErr } = await serviceClient
    .from("coaches")
    .upsert(
      { id: newCoachId, email, ...(trimmedName ? { display_name: trimmedName } : {}) },
      { onConflict: "id" }
    );

  if (coachUpsertErr) {
    return sendJson(res, 500, {
      error: `Invite sent, but failed to create their coach record: ${coachUpsertErr.message}. Attach them manually via SQL.`,
    });
  }

  const { error: programCoachErr } = await serviceClient
    .from("program_coaches")
    .upsert(
      { program_id: programId, coach_id: newCoachId, role, can_publish: !!canPublish },
      { onConflict: "program_id,coach_id" }
    );

  if (programCoachErr) {
    return sendJson(res, 500, {
      error: `Invite sent and coach record created, but failed to attach them to this program: ${programCoachErr.message}. Attach them manually via SQL.`,
    });
  }

  return sendJson(res, 200, { ok: true, email, role, canPublish: !!canPublish, name: trimmedName || null });
}
