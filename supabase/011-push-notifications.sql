-- 011: Push Notification Subscriptions
-- Run this in the Supabase SQL Editor

-- 1. Push subscriptions table
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id    UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  player_name TEXT,
  endpoint    TEXT NOT NULL,
  keys_p256dh TEXT NOT NULL,
  keys_auth   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_push_subs_group ON push_subscriptions(group_id);
CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);

-- 2. RLS
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Users can manage their own subscriptions
CREATE POLICY push_subs_select ON push_subscriptions FOR SELECT
  USING (
    auth.uid() = user_id
    OR EXISTS (
      SELECT 1 FROM group_members gm
      WHERE gm.group_id = push_subscriptions.group_id
        AND gm.user_id = auth.uid()
        AND gm.role = 'admin'
    )
  );

CREATE POLICY push_subs_insert ON push_subscriptions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY push_subs_delete ON push_subscriptions FOR DELETE
  USING (auth.uid() = user_id);
