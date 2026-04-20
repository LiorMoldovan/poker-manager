-- 012: Add missing UPDATE policy for push_subscriptions
-- Required for upsert (ON CONFLICT DO UPDATE) to work with RLS
-- Run this in the Supabase SQL Editor

DROP POLICY IF EXISTS push_subs_update ON push_subscriptions;

CREATE POLICY push_subs_update ON push_subscriptions FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
