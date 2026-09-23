-- ChalkTalk — Plan capture columns on `programs` (schema + backfill ONLY).
-- Run these statements in order in Supabase's SQL Editor.
--
-- This is Prompt 4 of claude/pricing-pages-build-prompts.md. It adds the
-- columns and backfills existing rows. It deliberately creates NO trigger,
-- RLS policy, or function: nothing reads these columns yet, so running it
-- changes no behavior for any coach, player, or parent.
--
-- ORDER: run this BEFORE merging the feature/plan-capture branch. That
-- branch's provision-program.js writes `plan` into every new programs row;
-- if the code goes live first, new program creation fails because the
-- column doesn't exist.

-- ─────────────────────────────────────
-- 1. New columns on `programs` (all nullable, safe defaults)
--    Note: ADD COLUMN ... DEFAULT fills existing rows with the default,
--    so every current row becomes 'trial' / 'trialing' / now() here.
--    Step 2 then sets the real plan.
-- ─────────────────────────────────────
alter table programs add column if not exists plan text default 'trial';
alter table programs add column if not exists billing_status text default 'trialing';
alter table programs add column if not exists stripe_customer_id text;
alter table programs add column if not exists stripe_subscription_id text;
alter table programs add column if not exists plan_started_at timestamptz default now();

-- ─────────────────────────────────────
-- 2. Backfill: every program that exists today is a comped pilot on
--    college_d1 (Shaun's decision, 2026-09-23).
--
--    This intentionally matches ALL existing rows rather than a slug list:
--    only dartmouth, lsu, monarchs and rpcs have slugs committed to this
--    repo (programs/*.json). Concordia Prep, Hilton Head Prep and the two
--    Harvard programs don't, so a slug list would risk missing them. It
--    also catches melo/dematha if they have rows. Check the select in
--    step 3 afterward; if any row should NOT be comped, change it by hand.
--
--    HARD REQUIREMENT, NOT A PLACEHOLDER: Dartmouth must be on a plan that
--    includes Coach's Eye Audio (hs, college, or college_d1). Its narration
--    feature is live, and a later plan check would otherwise silently turn
--    it off. college_d1 satisfies this; the assertion below enforces it.
-- ─────────────────────────────────────
update programs
set plan = 'college_d1',
    billing_status = 'trialing'
where plan is null or plan = 'trial';

do $$
begin
  if exists (select 1 from programs where slug = 'dartmouth'
             and coalesce(plan, '') not in ('hs', 'college', 'college_d1')) then
    raise exception 'Dartmouth is not on a narration-included plan; fix before continuing';
  end if;
end $$;

-- ─────────────────────────────────────
-- 3. Verify (run after applying, and send the result back):
-- ─────────────────────────────────────
-- select slug, plan, billing_status, plan_started_at from programs order by slug;
--
-- Expected: every live program listed with plan = 'college_d1',
-- billing_status = 'trialing', no NULLs. If a program you expected (e.g.
-- LSU, RPCS, Monarchs, which were built with the static build_site.py
-- system) is missing, it has no Supabase row yet. That's fine for now;
-- note it so it gets a plan when it's provisioned.
