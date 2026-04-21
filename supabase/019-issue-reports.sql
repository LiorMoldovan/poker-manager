-- ============================================================
-- Migration 019: Issue Reports
-- Run in Supabase SQL Editor after 018
--
-- Lets group members submit bug reports / feature requests.
-- Owner sees all reports in-app; email notification on submit.
-- ============================================================

CREATE TABLE issue_reports (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id        UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  reporter_name   TEXT NOT NULL,
  reporter_user_id UUID REFERENCES auth.users(id),
  category        TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  device          TEXT,
  status          TEXT NOT NULL DEFAULT 'open',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE issue_reports ENABLE ROW LEVEL SECURITY;

-- Members can insert reports for their own group
CREATE POLICY "Members can insert reports"
  ON issue_reports FOR INSERT
  WITH CHECK (
    group_id IN (SELECT gm.group_id FROM group_members gm WHERE gm.user_id = auth.uid())
  );

-- Members can read their own reports
CREATE POLICY "Users can read own reports"
  ON issue_reports FOR SELECT
  USING (reporter_user_id = auth.uid());

-- Admins can read all reports in their group
CREATE POLICY "Admins can read group reports"
  ON issue_reports FOR SELECT
  USING (
    group_id IN (
      SELECT gm.group_id FROM group_members gm
      WHERE gm.user_id = auth.uid() AND gm.role = 'admin'
    )
  );

-- Admins can update status (resolve/close)
CREATE POLICY "Admins can update reports"
  ON issue_reports FOR UPDATE
  USING (
    group_id IN (
      SELECT gm.group_id FROM group_members gm
      WHERE gm.user_id = auth.uid() AND gm.role = 'admin'
    )
  );

-- Reporter can delete their own report
CREATE POLICY "Users can delete own reports"
  ON issue_reports FOR DELETE
  USING (reporter_user_id = auth.uid());

-- Admins can delete reports in their group
CREATE POLICY "Admins can delete group reports"
  ON issue_reports FOR DELETE
  USING (
    group_id IN (
      SELECT gm.group_id FROM group_members gm
      WHERE gm.user_id = auth.uid() AND gm.role = 'admin'
    )
  );

-- Super admins can delete any report
CREATE POLICY "Super admins can delete all reports"
  ON issue_reports FOR DELETE
  USING (
    EXISTS (SELECT 1 FROM super_admins WHERE user_id = auth.uid())
  );

-- Super admins can read all reports across all groups
CREATE POLICY "Super admins can read all reports"
  ON issue_reports FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM super_admins WHERE user_id = auth.uid())
  );

-- Super admins can update any report
CREATE POLICY "Super admins can update all reports"
  ON issue_reports FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM super_admins WHERE user_id = auth.uid())
  );

-- RPC: get group owner email (SECURITY DEFINER to access auth.users)
-- Any group member can call it — returns only the owner's email
CREATE OR REPLACE FUNCTION get_group_owner_email(p_group_id UUID)
RETURNS TEXT AS $$
DECLARE
  caller_group UUID;
  owner_email TEXT;
BEGIN
  SELECT gm.group_id INTO caller_group
    FROM group_members gm
    WHERE gm.user_id = auth.uid() AND gm.group_id = p_group_id;
  IF caller_group IS NULL THEN
    RAISE EXCEPTION 'Not a member of this group';
  END IF;

  SELECT u.email INTO owner_email
    FROM groups g
    JOIN auth.users u ON u.id = g.created_by
    WHERE g.id = p_group_id;

  RETURN owner_email;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
