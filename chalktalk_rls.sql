-- coaches
ALTER TABLE coaches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "coaches_select_own"
  ON coaches FOR SELECT
  USING (id = auth.uid());
CREATE POLICY "coaches_insert_own"
  ON coaches FOR INSERT
  WITH CHECK (id = auth.uid());
CREATE POLICY "coaches_update_own"
  ON coaches FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());
-- ─────────────────────────────────────
-- programs
ALTER TABLE programs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "programs_select_own"
  ON programs FOR SELECT
  USING (coach_id = auth.uid());
CREATE POLICY "programs_insert_own"
  ON programs FOR INSERT
  WITH CHECK (coach_id = auth.uid());
CREATE POLICY "programs_update_own"
  ON programs FOR UPDATE
  USING (coach_id = auth.uid())
  WITH CHECK (coach_id = auth.uid());
CREATE POLICY "programs_delete_own"
  ON programs FOR DELETE
  USING (coach_id = auth.uid());
-- ─────────────────────────────────────
-- playbooks
ALTER TABLE playbooks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "playbooks_select_coach"
  ON playbooks FOR SELECT
  USING (
    program_id IN (
      SELECT id FROM programs WHERE coach_id = auth.uid()
    )
    OR
    (
      status = 'published'
      AND program_id IN (
        SELECT program_id FROM team_members
        WHERE active = true
          AND token = current_setting('app.member_token', true)
      )
    )
  );
CREATE POLICY "playbooks_insert_coach"
  ON playbooks FOR INSERT
  WITH CHECK (
    program_id IN (
      SELECT id FROM programs WHERE coach_id = auth.uid()
    )
  );
CREATE POLICY "playbooks_update_coach"
  ON playbooks FOR UPDATE
  USING (
    program_id IN (
      SELECT id FROM programs WHERE coach_id = auth.uid()
    )
  )
  WITH CHECK (
    program_id IN (
      SELECT id FROM programs WHERE coach_id = auth.uid()
    )
  );
CREATE POLICY "playbooks_delete_coach"
  ON playbooks FOR DELETE
  USING (
    program_id IN (
      SELECT id FROM programs WHERE coach_id = auth.uid()
    )
  );
-- ─────────────────────────────────────
-- team_members
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "team_members_select_coach"
  ON team_members FOR SELECT
  USING (
    program_id IN (
      SELECT id FROM programs WHERE coach_id = auth.uid()
    )
    OR
    token = current_setting('app.member_token', true)
  );
CREATE POLICY "team_members_insert_coach"
  ON team_members FOR INSERT
  WITH CHECK (
    program_id IN (
      SELECT id FROM programs WHERE coach_id = auth.uid()
    )
  );
CREATE POLICY "team_members_update_coach"
  ON team_members FOR UPDATE
  USING (
    program_id IN (
      SELECT id FROM programs WHERE coach_id = auth.uid()
    )
  )
  WITH CHECK (
    program_id IN (
      SELECT id FROM programs WHERE coach_id = auth.uid()
    )
  );
CREATE POLICY "team_members_delete_coach"
  ON team_members FOR DELETE
  USING (
    program_id IN (
      SELECT id FROM programs WHERE coach_id = auth.uid()
    )
  );
