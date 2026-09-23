/**
 * The single source of truth for what each ChalkTalk plan includes.
 * Every enforcement point (api/invite-coach.js, api/invite-viewer.js,
 * api/generate-playbook.js, api/generate-narration.js, and the
 * dashboard's plan-summary endpoint) imports getPlanLimits() from here
 * rather than hardcoding its own copy of these numbers -- matching this
 * project's existing "never a third un-synced copy" discipline (see the
 * phase/anchor tables in api/generate-playbook.js for the same pattern
 * applied elsewhere).
 *
 * Source of truth for the NUMBERS themselves:
 *   claude/pricing-tiering-architecture.md, Section 3 (youth/hs/college),
 *   and claude/pricing-pages-build-prompts.md, Section 0 (decisions
 *   D2-D4) for trial/club/college_d1, which Section 3 doesn't define
 *   directly.
 *
 * rosterCap counts player/parent seats. coachCap counts `program_coaches`
 * rows. playbookCap counts active (published, not hidden -- decision D5)
 * `plays` rows. null means "no cap" (unlimited), never "0" -- 0 is a
 * real, enforced cap (see "trial" below, which is 0 on purpose).
 *
 * IMPORTANT GAP, flagged rather than silently closed: this repo has no
 * API endpoint that inserts `team_members` rows -- roster management
 * appears to happen via a direct client-side Supabase insert under RLS,
 * not through anything in api/. That means rosterCap, as enforced by
 * api/invite-viewer.js, only actually caps how many PLAYER/PARENT LOGINS
 * get issued through that endpoint (viewer_accounts rows) -- it does not
 * stop a coach from adding more team_members rows directly. Closing that
 * fully would need either a new "add roster member" API endpoint or a
 * Postgres trigger on `team_members` insert; neither exists today.
 */

export const PLAN_LIMITS = {
  // Trial (D2, answered 2026-09-23): 5 days, 1 login (the inviting head
  // coach only -- no additional coaches), 0 player/parent logins, 1
  // playbook set, no narration. trialLengthDays is read by
  // is_program_plan_active() (supabase/migrations/plan-active-trigger.sql)
  // -- this file only exports the number, it does not enforce the
  // countdown itself. Converting to a paid plan (a future
  // api/stripe-webhook.js, Phase 3) changes `programs.plan`, and every
  // limit below is resolved live from that column every time it's
  // checked -- there is no separate "narration enabled" flag to flip on
  // conversion.
  trial: {
    rosterCap: 0,
    coachCap: 1,
    playbookCap: 1,
    narrationIncluded: false,
    viewerLoginsIncluded: false,
    trialLengthDays: 5,
  },
  youth: {
    rosterCap: 10,
    coachCap: 2,
    playbookCap: 9,
    narrationIncluded: false,
    viewerLoginsIncluded: false,
  },
  // D3: Club/AAU's own roster/coach caps are not defined anywhere in the
  // pricing doc (it's described only as an "Org Pack (5-10 Teams)") --
  // left null (uncapped) rather than inventing a number, per Shaun's
  // explicit instruction. Revisit once he supplies real numbers.
  club: {
    rosterCap: null,
    coachCap: null,
    playbookCap: null,
    narrationIncluded: true,
    // D4: viewer logins extended to every HS-and-above tier here,
    // matching the same "HS and above" line Coach's Eye Audio already
    // draws in the pricing doc (brief.level !== "youth"). Shaun has not
    // separately confirmed this for the player/parent login feature --
    // flag if this default is wrong.
    viewerLoginsIncluded: true,
  },
  hs: {
    rosterCap: 36,
    coachCap: 6,
    playbookCap: null,
    narrationIncluded: true,
    viewerLoginsIncluded: true,
  },
  college: {
    rosterCap: 15,
    coachCap: null,
    playbookCap: null,
    narrationIncluded: true,
    viewerLoginsIncluded: true,
    scoutTeamBranch: true,
  },
  // D3: D1's own roster/coach caps also aren't defined in the pricing
  // doc's Section 3 (only Youth/HS/College columns exist there) --
  // borrowing College's numbers per the doc's stated default, not a real
  // confirmed D1 figure.
  college_d1: {
    rosterCap: 15,
    coachCap: null,
    playbookCap: null,
    narrationIncluded: true,
    viewerLoginsIncluded: true,
    scoutTeamBranch: true,
  },
};

// Unknown/null plan resolves permissive -- same "no plan set = allowed"
// rule supabase/migrations/plan-active-trigger.sql applies. This is
// deliberately NOT what a new signup gets: api/_lib/provision-program.js
// always defaults a new row's plan to the literal string "trial", never
// null or an unrecognized value -- this branch only protects a program
// some other tool wrote a bad plan value into.
export const PERMISSIVE_LIMITS = {
  rosterCap: null,
  coachCap: null,
  playbookCap: null,
  narrationIncluded: true,
  viewerLoginsIncluded: true,
};

export function getPlanLimits(planName) {
  return PLAN_LIMITS[planName] || PERMISSIVE_LIMITS;
}
