-- ChalkTalk — is_program_plan_active() and wiring into the publish trigger.
-- Run in Supabase's SQL Editor. Prompt 9 of claude/pricing-pages-build-prompts.md.
--
-- PRECONDITION: do NOT run this until supabase/migrations/program-plan-capture.sql
-- has been applied AND its verification select shows every existing program with a
-- non-null plan and billing_status. If that hasn't happened yet, stop here and run
-- that migration first.
--
-- ⚠ THIS IS NOT INERT ON ARRIVAL. Unlike the billing_status half (which stays inert
-- until Stripe exists and can set past_due/canceled), the trial-expiry half below
-- takes effect the moment this migration is applied, for every program whose plan is
-- 'trial' -- i.e. any new signup between now and whenever it converts to a paid plan.
-- The 8 (or more -- see note below) programs live before this migration are already
-- backfilled off "trial" onto college_d1 by the earlier migration, so they are
-- unaffected. Confirm this immediate effect is what you want before running it.
--
-- CORRECTION TO EARLIER REASONING: the program-plan-capture.sql migration's comments
-- named Dartmouth as the program whose live narration this schema had to protect,
-- following claude/pricing-billing-engineering-anchors.md's claim that Dartmouth has
-- "a live, already-shipped narration feature." Reading the ACTUAL live code
-- (api/generate-narration.js) while building this migration found that claim to be
-- wrong: the real narration pilot gate there is
-- NARRATION_PILOT_PROGRAM_SLUGS = ["st-marys-saints-calgary"] -- a program not
-- previously mentioned anywhere in the pricing docs or the original list of 8 live
-- programs. Dartmouth's real live pilot is the PLAYER/PARENT LOGIN feature
-- (api/invite-viewer.js's PILOT_PROGRAM_SLUGS = ["dartmouth"]), not narration. This
-- doesn't break anything already applied -- program-plan-capture.sql's backfill
-- matches ALL existing rows (not a slug list), so St. Mary's Saints Calgary is
-- already covered by the blanket college_d1 backfill -- but the comments there are
-- now known to be based on an incorrect premise, and Shaun should know a 9th live
-- program (St. Mary's Saints Calgary) exists that wasn't in the original inventory.

-- ─────────────────────────────────────
-- 1. is_program_plan_active(p_program_id)
--
-- Follows the exact pattern of is_program_head_coach() / is_program_member() in
-- supabase/schema.sql. Returns TRUE unless EITHER:
--   (a) billing_status is in ('past_due', 'canceled'); or
--   (b) plan = 'trial' AND now() > plan_started_at + interval '5 days'
--       (D2/D7: the trial window -- 5 is hardcoded here to match
--       api/_lib/plan-limits.js's trialLengthDays; there is no shared config
--       between SQL and JS in this codebase, so a future change to the trial
--       length must be made in BOTH places).
-- A NULL plan or billing_status, or a missing programs row, returns TRUE
-- ("no plan set" = allowed, per the risk analysis in
-- claude/pricing-billing-engineering-anchors.md Section 7). The coalesce(...,
-- true) at the outer level is what makes that hold even when the inner boolean
-- expression itself evaluates to NULL (e.g. plan is null, or plan_started_at is
-- null on a program somehow missing it).
-- ─────────────────────────────────────
create or replace function public.is_program_plan_active(p_program_id uuid)
returns boolean
language sql
security definer
set search_path to 'public'
as $function$
  select coalesce(
    (
      select
        p.billing_status not in ('past_due', 'canceled')
        and not (
          p.plan = 'trial'
          and p.plan_started_at is not null
          and now() > p.plan_started_at + interval '5 days'
        )
      from programs p
      where p.id = p_program_id
    ),
    true
  );
$function$;

-- ─────────────────────────────────────
-- 2. Wire it into block_unauthorized_publish() ONLY -- not
--    block_unauthorized_hide(). A past_due (or trial-expired) program can still
--    HIDE plays: taking content down is never blocked by billing, only PUBLISH is
--    gated. The coach can still manage what they already built; they just can't
--    publish anything new until they convert or Shaun manually extends
--    plan_started_at (e.g. `update programs set plan_started_at = now() where
--    id = ...` to reset a trial's clock).
--
--    This re-creates the function with the SAME body as supabase/schema.sql's
--    current block_unauthorized_publish(), plus one added check -- the existing
--    can_publish check is untouched, this only adds a second condition.
-- ─────────────────────────────────────
create or replace function public.block_unauthorized_publish()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.status = 'published' and (old.status is distinct from 'published') then
    if not exists (
      select 1 from program_coaches
      where program_id = new.program_id
        and coach_id = auth.uid()
        and can_publish = true
    ) then
      raise exception 'You do not have permission to publish this play.';
    end if;

    if not is_program_plan_active(new.program_id) then
      raise exception 'This program''s plan is not active (trial expired, or billing past due) -- publishing is paused until it''s resolved. Hiding/unhiding existing plays still works.';
    end if;
  end if;
  return new;
end;
$function$;

-- The trigger itself already exists (trg_block_unauthorized_publish, per
-- supabase/schema.sql) and references this function by name -- `create or
-- replace function` updates its body in place without needing to touch the
-- trigger definition.

-- ─────────────────────────────────────
-- 3. Verify (run after applying, and send the result back):
-- ─────────────────────────────────────
-- select slug, plan, billing_status, plan_started_at,
--        is_program_plan_active(id) as active
-- from programs order by slug;
--
-- Expected: every existing live program (including st-marys-saints-calgary, per the
-- correction above) shows active = true, since they're all on college_d1 with
-- billing_status = 'trialing'. A brand new test program left on plan='trial' with
-- plan_started_at older than 5 days should show active = false.
