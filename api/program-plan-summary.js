/**
 * GET /api/program-plan-summary?programId=...
 *
 * Read-only endpoint for the dashboard's "Plan & Billing" card (Phase 2,
 * Prompt 10). Returns the program's current plan, that plan's limits
 * (api/_lib/plan-limits.js), live usage counts against those limits
 * (api/_lib/plan-usage.js), and trial-expiry info -- everything the card
 * needs in one call, computed the same way the enforcement endpoints
 * (invite-coach.js, invite-viewer.js, generate-playbook.js,
 * generate-narration.js) already compute it, so the number the dashboard
 * shows and the number actually enforced can never drift apart.
 *
 * Auth: same validateCoachSession(req, programId) pattern as every other
 * program-scoped endpoint. Deliberately no admin/can_publish gate --
 * this is read-only, and every coach role on a program should be able to
 * see its own plan status, matching the bar the rest of the dashboard
 * already uses for viewing (as opposed to managing) program data.
 *
 * Trial expiry: computed here in JS from plan_started_at +
 * trialLengthDays (api/_lib/plan-limits.js), mirroring the SQL logic in
 * supabase/migrations/plan-active-trigger.sql's is_program_plan_active().
 * There is no shared config between SQL and JS in this codebase (see that
 * migration's own comment) -- a future change to the trial length must be
 * made in BOTH places, and this endpoint's `active` value is meant to
 * always agree with what that SQL function would return for the same
 * program.
 *
 * Response (JSON):
 *   {
 *     plan, billingStatus, planStartedAt,
 *     active: boolean,                  // mirrors is_program_plan_active()
 *     trialDaysRemaining: number|null,  // null when plan isn't "trial"
 *     limits: { rosterCap, coachCap, playbookCap, narrationIncluded, viewerLoginsIncluded },
 *     usage: { coaches, rosterLogins, playbooks },
 *   }
 *   or { error: string } with an appropriate status code
 */

import { validateCoachSession } from "./_lib/validate-session.js";
import { getPlanLimits } from "./_lib/plan-limits.js";
import { getPlanUsage } from "./_lib/plan-usage.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return sendJson(res, { error: "Method not allowed" }, 405);
  }

  const programId = req.query && req.query.programId;
  if (!programId) {
    return sendJson(res, { error: "programId is required" }, 400);
  }

  const authResult = await validateCoachSession(req, programId);
  if (!authResult.ok) {
    return sendJson(res, { error: authResult.error }, authResult.status);
  }
  const { supabase } = authResult;

  const { data: programRow, error: programErr } = await supabase
    .from("programs")
    .select("plan, billing_status, plan_started_at")
    .eq("id", programId)
    .maybeSingle();

  if (programErr || !programRow) {
    return sendJson(res, { error: "Program not found, or you don't have access to it" }, 403);
  }

  const plan = programRow.plan || "trial";
  const limits = getPlanLimits(plan);
  const billingStatus = programRow.billing_status || "trialing";

  // Mirrors is_program_plan_active() (supabase/migrations/plan-active-trigger.sql):
  // inactive if billing_status is past_due/canceled, or if this is an
  // expired trial. A missing plan_started_at is treated as "not expired"
  // -- the same permissive default the SQL function uses for a null
  // field (coalesce(..., true) there).
  let trialDaysRemaining = null;
  let active = billingStatus !== "past_due" && billingStatus !== "canceled";
  if (plan === "trial" && limits.trialLengthDays != null && programRow.plan_started_at) {
    const startedAt = new Date(programRow.plan_started_at).getTime();
    const elapsedDays = (Date.now() - startedAt) / (1000 * 60 * 60 * 24);
    trialDaysRemaining = Math.max(0, Math.ceil(limits.trialLengthDays - elapsedDays));
    if (elapsedDays > limits.trialLengthDays) {
      active = false;
    }
  }

  let usage;
  try {
    usage = await getPlanUsage(supabase, programId);
  } catch (err) {
    return sendJson(res, { error: err.message }, 500);
  }

  return sendJson(res, {
    plan,
    billingStatus,
    planStartedAt: programRow.plan_started_at,
    active,
    trialDaysRemaining,
    limits: {
      rosterCap: limits.rosterCap,
      coachCap: limits.coachCap,
      playbookCap: limits.playbookCap,
      narrationIncluded: limits.narrationIncluded,
      viewerLoginsIncluded: limits.viewerLoginsIncluded,
    },
    usage,
  });
}

function sendJson(res, obj, status = 200) {
  res.status(status).json(obj);
}
