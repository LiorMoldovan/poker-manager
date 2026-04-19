-- 009: Settlement auto-close + notifications + email support
-- Run this in the Supabase SQL Editor

-- 1. Add auto_closed flag to paid_settlements
ALTER TABLE paid_settlements ADD COLUMN IF NOT EXISTS auto_closed BOOLEAN NOT NULL DEFAULT false;

-- 2. Notifications table
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id    UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  data        JSONB,
  read        BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read);
CREATE INDEX IF NOT EXISTS idx_notifications_group ON notifications(group_id);

-- 3. RLS for notifications
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY notif_select ON notifications FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY notif_insert ON notifications FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM group_members
      WHERE group_id = notifications.group_id AND user_id = auth.uid()
    )
  );

CREATE POLICY notif_update ON notifications FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY notif_delete ON notifications FOR DELETE
  USING (auth.uid() = user_id);

-- 4. Add to Realtime publication
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'notifications'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE notifications;
  END IF;
END $$;

-- 5. RPC: resolve player name to user_id within a group
CREATE OR REPLACE FUNCTION get_user_id_for_player(p_group_id UUID, p_player_name TEXT)
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER
AS $$
  SELECT gm.user_id FROM group_members gm
  JOIN players p ON p.id = gm.player_id
  WHERE gm.group_id = p_group_id AND p.name = p_player_name
  LIMIT 1;
$$;

-- 6. RPC: get player's email for notification (only if caller is in same group)
CREATE OR REPLACE FUNCTION get_player_email_for_notification(p_group_id UUID, p_player_name TEXT)
RETURNS TABLE(target_user_id UUID, email TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM group_members WHERE group_id = p_group_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not a member of this group';
  END IF;

  RETURN QUERY
    SELECT gm.user_id, au.email::TEXT
    FROM group_members gm
    JOIN players p ON p.id = gm.player_id
    JOIN auth.users au ON au.id = gm.user_id
    WHERE gm.group_id = p_group_id AND p.name = p_player_name
    LIMIT 1;
END;
$$;
