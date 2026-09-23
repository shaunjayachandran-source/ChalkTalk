/**
 * The one allow-list of plan names the backend accepts. Must match
 * public/admin.html's <select name="plan"> and the Google Form Apps Script.
 *
 * Capture only: nothing reads these to enforce limits yet. Numeric caps
 * will live in api/_lib/plan-limits.js (Phase 2 of
 * claude/pricing-pages-build-prompts.md).
 */
export const ALLOWED_PLANS = ["trial", "youth", "club", "hs", "college", "college_d1"];

export function normalizePlan(value) {
  return ALLOWED_PLANS.includes(value) ? value : "trial";
}
