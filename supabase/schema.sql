-- ChalkTalk — live access-control schema, reconstructed from the running
-- Supabase project via direct introspection (pg_policies, pg_proc,
-- pg_views) on 2026-09-11. This is not a migration to run against the
-- current database -- every object here already exists there. It exists so
-- the real, currently-enforced security model lives in git instead of only
-- inside Supabase's SQL editor.
--
-- KEEP THIS FILE IN SYNC. Any time a policy, trigger, function, or view is
-- changed directly in the Supabase SQL editor, update this file in the
-- same sitting.

-- =====================================================================
-- Helper functions (program_coaches)
-- =====================================================================

create or replace function public.is_program_head_coach(p_program_id uuid)
returns boolean
language sql
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1 from program_coaches
    where program_id = p_program_id and coach_id = auth.uid() and role = 'head_coach'
  );
$function$;

create or replace function public.is_program_member(p_program_id uuid)
returns boolean
language sql
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1 from program_coaches
    where program_id = p_program_id and coach_id = auth.uid()
  );
$function$;

-- =====================================================================
-- RLS — programs
-- =====================================================================

alter table programs enable row level security;

drop policy if exists "programs_select_member" on programs;
create policy "programs_select_member"
  on programs for select
  using (
    id in (select program_id from program_coaches where coach_id = auth.uid())
  );

drop policy if exists "programs_insert_creator" on programs;
create policy "programs_insert_creator"
  on programs for insert
  with check (coach_id = auth.uid());

drop policy if exists "programs_update_member" on programs;
create policy "programs_update_member"
  on programs for update
  using (
    id in (select program_id from program_coaches where coach_id = auth.uid())
  )
  with check (
    id in (select program_id from program_coaches where coach_id = auth.uid())
  );

-- NOTE: written as an inline subquery rather than calling
-- is_program_head_coach(id) the way program_coaches's own policies do below
-- -- functionally identical, just a stylistic inconsistency in the live
-- system, documented as-is.
drop policy if exists "programs_delete_head_coach" on programs;
create policy "programs_delete_head_coach"
  on programs for delete
  using (
    id in (
      select program_id from program_coaches
      where coach_id = auth.uid() and role = 'head_coach'
    )
  );

-- =====================================================================
-- RLS — program_coaches
-- =====================================================================

alter table program_coaches enable row level security;

drop policy if exists "program_coaches_select_member" on program_coaches;
create policy "program_coaches_select_member"
  on program_coaches for select
  using (is_program_member(program_id));

drop policy if exists "program_coaches_insert_head_coach" on program_coaches;
create policy "program_coaches_insert_head_coach"
  on program_coaches for insert
  with check (is_program_head_coach(program_id));

drop policy if exists "program_coaches_update_head_coach" on program_coaches;
create policy "program_coaches_update_head_coach"
  on program_coaches for update
  using (is_program_head_coach(program_id))
  with check (is_program_head_coach(program_id));

drop policy if exists "program_coaches_delete_head_coach" on program_coaches;
create policy "program_coaches_delete_head_coach"
  on program_coaches for delete
  using (is_program_head_coach(program_id));

-- =====================================================================
-- RLS — plays
-- =====================================================================

alter table plays enable row level security;

drop policy if exists "plays_select_member" on plays;
create policy "plays_select_member"
  on plays for select
  using (
    program_id in (select program_id from program_coaches where coach_id = auth.uid())
  );

drop policy if exists "plays_insert_member" on plays;
create policy "plays_insert_member"
  on plays for insert
  with check (
    program_id in (select program_id from program_coaches where coach_id = auth.uid())
  );

drop policy if exists "plays_update_member" on plays;
create policy "plays_update_member"
  on plays for update
  using (
    program_id in (select program_id from program_coaches where coach_id = auth.uid())
  )
  with check (
    program_id in (select program_id from program_coaches where coach_id = auth.uid())
  );

-- Delete is deliberately narrower: only head_coach, assistant_coach, or dbo
-- -- matching dashboard.html's canManage check exactly.
drop policy if exists "plays_delete_senior" on plays;
create policy "plays_delete_senior"
  on plays for delete
  using (
    program_id in (
      select program_id from program_coaches
      where coach_id = auth.uid()
        and role = any (array['head_coach', 'assistant_coach', 'dbo'])
    )
  );

-- =====================================================================
-- Triggers — plays
-- =====================================================================

create or replace function public.block_unauthorized_hide()
returns trigger
language plpgsql
security definer
as $function$
begin
  if new.hidden is distinct from old.hidden then
    if not exists (
      select 1 from program_coaches
      where program_id = new.program_id
        and coach_id = auth.uid()
        and role in ('head_coach','assistant_coach','dbo')
    ) then
      raise exception 'Only a head coach, assistant coach, or DBO can hide or unhide a play.';
    end if;
  end if;
  return new;
end;
$function$;

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
  end if;
  return new;
end;
$function$;

drop trigger if exists "plays_block_unauthorized_hide" on plays;
create trigger "plays_block_unauthorized_hide"
  before update on plays
  for each row execute function block_unauthorized_hide();

drop trigger if exists "trg_block_unauthorized_publish" on plays;
create trigger "trg_block_unauthorized_publish"
  before update on plays
  for each row execute function block_unauthorized_publish();

-- =====================================================================
-- Public views (anonymous-safe, used by team.html + subpages)
-- =====================================================================

create or replace view team_directory as
select
  id, slug, name, level, coach_name, hero_photo_url, photo_credit_label,
  photo_credit_url, crest_label, crest_font, color_primary, color_secondary,
  coach_name_public, crest_image_url, crest_svg, league_label, venue_label,
  location_label
from programs;

create or replace view play_directory as
select
  program_id, title, play_type, phase_count, court_type, updated_at,
  sub_category
from plays
where status = 'published' and hidden = false;
