-- Corrected role-taxonomy migration.
-- The previous version failed because ADD CONSTRAINT validates every
-- existing row immediately -- so old values ('player'/'coach') have to be
-- remapped to the new 6-value set BEFORE the constraint is added, not after.
-- Run this whole block at once in the Supabase SQL Editor.

-- 1. Remap existing rows to the new role vocabulary FIRST.
update team_members set role = 'athlete' where role = 'player';
update team_members set role = 'head_coach' where role = 'coach';
update access_links set role = 'athlete' where role = 'player';
update access_links set role = 'head_coach' where role = 'coach';

-- 2. Now that no row holds an old value, add the new constraints.
alter table team_members drop constraint if exists team_members_role_check;
alter table team_members add constraint team_members_role_check
  check (role in ('head_coach','assistant_coach','graduate_assistant','dbo','athlete','parent'));

alter table access_links drop constraint if exists access_links_role_check;
alter table access_links add constraint access_links_role_check
  check (role in ('head_coach','assistant_coach','graduate_assistant','dbo','athlete','parent'));
