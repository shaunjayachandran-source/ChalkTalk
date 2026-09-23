/**
 * Shared usage-counting helper for the plan system. Single source of
 * truth for "how do we count current usage against a plan's caps" --
 * every enforcement/read endpoint that needs a live count (this file's
 * getPlanUsage(), used by api/program-plan-summary.js) counts EXACTLY
 * the same rows the enforcement endpoints themselves gate on, so the
 * dashboard's displayed usage can never drift from what's actually
 * enforced:
 *   - coaches: program_coaches rows for this program (api/invite-coach.js's
 *     own coachCap check counts the same table the same way).
 *   - rosterLogins: viewer_accounts rows for this program (api/invite-viewer.js's
 *     rosterCap check).
 *   - playbooks: plays rows for this program with status='published' AND
 *     hidden=false (D5's "active" definition, api/generate-playbook.js's
 *     playbookCap check).
 *
 * This file does NOT import plan-limits.js's caps itself -- it only counts
 * current usage. The caller (api/program-plan-summary.js) pairs this
 * usage with getPlanLimits() to know what each number means against its
 * cap.
 */

export async function getPlanUsage(supabase, programId) {
  const [coachResult, viewerResult, playbookResult] = await Promise.all([
    supabase
      .from("program_coaches")
      .select("coach_id", { count: "exact", head: true })
      .eq("program_id", programId),
    supabase
      .from("viewer_accounts")
      .select("id", { count: "exact", head: true })
      .eq("program_id", programId),
    supabase
      .from("plays")
      .select("id", { count: "exact", head: true })
      .eq("program_id", programId)
      .eq("status", "published")
      .eq("hidden", false),
  ]);

  const errors = [coachResult.error, viewerResult.error, playbookResult.error].filter(Boolean);
  if (errors.length) {
    throw new Error(`Could not compute plan usage: ${errors.map((e) => e.message).join("; ")}`);
  }

  return {
    coaches: coachResult.count || 0,
    rosterLogins: viewerResult.count || 0,
    playbooks: playbookResult.count || 0,
  };
}
