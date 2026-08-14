-- ChalkTalk — Coach names, hero photos, and explicit play sub-categories.
-- Run these statements in order in Supabase's SQL Editor.
--
-- NOTE ON team_directory / play_directory: this repo does not have a saved
-- CREATE VIEW statement for either view (they appear to have been created
-- directly in the Supabase SQL Editor in an earlier session and never
-- committed to a file here). The `create or replace view` statements below
-- were reconstructed from the exact columns every public page currently
-- selects from them (id, slug, name, level for team_directory; program_id,
-- title, play_type, phase_count, court_type, updated_at for play_directory),
-- plus the new columns this task adds. If your live view actually exposes
-- additional columns beyond what's listed here, add them back into the
-- SELECT list before running -- `create or replace view` fully replaces the
-- view's column list, it does not merge with what's already there.

-- ─────────────────────────────────────
-- 1. New columns on `programs`
-- ─────────────────────────────────────
alter table programs add column if not exists coach_name text;
alter table programs add column if not exists hero_photo_url text;
alter table programs add column if not exists photo_credit_label text;
alter table programs add column if not exists photo_credit_url text;

-- ─────────────────────────────────────
-- 2. New column on `plays`
-- ─────────────────────────────────────
alter table plays add column if not exists sub_category text;
-- Deliberately no CHECK constraint here: the allowed value set differs by
-- category (offense uses "press_break", defense uses "press"), and that
-- cross-column rule is enforced in application code (api/generate-playbook.js)
-- rather than the database, to keep this simple.

-- ─────────────────────────────────────
-- 3. Views — DO NOT RUN THIS SECTION YET.
--
-- `create or replace view` fully replaces the view's column list -- it does
-- not merge with what's already there. Since the original CREATE VIEW
-- statements for team_directory/play_directory aren't saved anywhere I have
-- access to (they were run directly in the SQL Editor in an earlier session),
-- the version below is a reconstruction and may be WRONG -- in particular
-- I guessed play_directory filters on a `status = 'published'` column,
-- which may not actually exist on your `plays` table, and there could be
-- other real columns your live view exposes that aren't listed here.
--
-- Run this check FIRST and send me the results before running anything
-- below it in this section:
--
--   select column_name from information_schema.columns
--   where table_name = 'team_directory' order by ordinal_position;
--
--   select column_name from information_schema.columns
--   where table_name = 'play_directory' order by ordinal_position;
--
-- Once I see the real column lists I'll send back a corrected version of
-- the two `create or replace view` statements guaranteed not to drop or
-- break anything. The reconstruction below is left in as a reference only
-- -- do not run it as-is.
-- ─────────────────────────────────────
-- create or replace view team_directory as
-- select
--   id,
--   slug,
--   name,
--   level,
--   coach_name,
--   hero_photo_url,
--   photo_credit_label,
--   photo_credit_url
-- from programs;
--
-- create or replace view play_directory as
-- select
--   program_id,
--   title,
--   play_type,
--   sub_category,
--   phase_count,
--   court_type,
--   updated_at
-- from plays
-- where status = 'published';

-- ─────────────────────────────────────
-- 4. Backfill real data for LSU and Dartmouth.
--    (melo-16u and dematha are left with all four new columns NULL —
--    no coach name, no hero photo — so they keep the existing
--    gradient-crest hero and generic "players, parents & coaches" line.)
-- ─────────────────────────────────────
update programs
set
  coach_name = 'Will Wade',
  hero_photo_url = 'https://commons.wikimedia.org/wiki/Special:FilePath/Pete%20Maravich%20Assembly%20Center%20(Baton%20Rouge%2C%20Louisiana).jpg',
  photo_credit_label = 'Photo via Wikimedia Commons',
  photo_credit_url = 'https://commons.wikimedia.org/wiki/File:Pete_Maravich_Assembly_Center_(Baton_Rouge,_Louisiana).jpg'
where slug = 'lsu';

update programs
set
  coach_name = 'Brett MacConnell',
  hero_photo_url = 'https://commons.wikimedia.org/wiki/Special:FilePath/Dartmouth%20College%20campus%202007-10-03%20Thompson%20Arena.JPG',
  photo_credit_label = 'Photo via Wikimedia Commons',
  photo_credit_url = 'https://commons.wikimedia.org/wiki/File:Dartmouth_College_campus_2007-10-03_Thompson_Arena.JPG'
where slug = 'dartmouth';

-- ─────────────────────────────────────
-- 5. sub_category backfill for existing offense/defense plays.
--
-- JUDGMENT CALL: run this ONLY if you actually have existing rows in
-- `plays` with category = offense or defense (check with the SELECT
-- below first). If that SELECT returns 0 rows, skip the UPDATE entirely —
-- there is nothing to backfill. If it returns rows, the UPDATE below
-- defaults every one of them to 'man' (the most common/default scheme),
-- since there's no reliable automated way to tell man/zone/press apart
-- for plays that were built before this field existed. Review and
-- manually correct any specific plays afterward directly in Supabase's
-- table editor (plays.sub_category) if 'man' isn't right for them.
-- ─────────────────────────────────────

-- Run this first to see if a backfill is even needed:
-- select id, program_id, title, play_type, sub_category from plays
-- where play_type in ('offense','defense') and sub_category is null;

update plays
set sub_category = 'man'
where play_type in ('offense', 'defense') and sub_category is null;
