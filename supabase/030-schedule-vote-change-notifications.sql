-- ============================================================
-- Migration 030: Schedule feature — vote-change notifications opt-in
-- Run in Supabase SQL Editor after 029-schedule-vote-history.sql
-- (Idempotent — safe to re-run.)
--
-- Why: Group admins / owners / super-admins are always informed when
--   someone changes a vote, but regular members shouldn't get spammed
--   by default. This migration adds an opt-in mechanism so members
--   can subscribe (per-poll) to vote-change pings, plus a recipient-
--   resolver RPC that the client uses to fan out push + email.
--
-- Tables:
--   * game_poll_change_subscribers (poll_id, user_id) — PK
--
-- RPCs:
--   * subscribe_to_poll_changes(p_poll_id)        — opt in for current user
--   * unsubscribe_from_poll_changes(p_poll_id)    — opt out for current user
--   * get_my_poll_change_subscriptions()          — list of poll IDs the
--                                                   current user follows
--   * get_poll_change_recipients(p_poll_id)       — player names of all
--                                                   users who should receive
--                                                   the notification (admins,
--                                                   owners, super-admins, and
--                                                   opted-in members)
-- ============================================================

-- 1. Subscriber table -----------------------------------------------------
CREATE TABLE IF NOT EXISTS game_poll_change_subscribers (
  poll_id       UUID NOT NULL REFERENCES game_polls(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  subscribed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (poll_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_poll_change_subs_user
  ON game_poll_change_subscribers(user_id);

ALTER TABLE game_poll_change_subscribers ENABLE ROW LEVEL SECURITY;

-- Members of the poll's group can read all subscribers (small, harmless).
DROP POLICY IF EXISTS "members read poll change subscribers"
  ON game_poll_change_subscribers;
CREATE POLICY "members read poll change subscribers"
  ON game_poll_change_subscribers FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM game_polls gp
      JOIN group_members gm ON gm.group_id = gp.group_id
      WHERE gp.id = game_poll_change_subscribers.poll_id
        AND gm.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM super_admins WHERE user_id = auth.uid()
    )
  );

-- All writes go through SECURITY DEFINER RPCs below, so deny direct DML.
DROP POLICY IF EXISTS "no direct dml on poll change subscribers"
  ON game_poll_change_subscribers;
CREATE POLICY "no direct dml on poll change subscribers"
  ON game_poll_change_subscribers FOR ALL
  USING (false) WITH CHECK (false);

-- 2. Subscribe / unsubscribe ---------------------------------------------
CREATE OR REPLACE FUNCTION subscribe_to_poll_changes(p_poll_id UUID)
RETURNS VOID AS $$
DECLARE
  v_group_id UUID;
BEGIN
  SELECT group_id INTO v_group_id FROM game_polls WHERE id = p_poll_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'invalid_poll';
  END IF;

  -- Caller must be in the group (super-admins always implicitly subscribed).
  IF NOT EXISTS (
    SELECT 1 FROM group_members
     WHERE group_id = v_group_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not_member';
  END IF;

  INSERT INTO game_poll_change_subscribers (poll_id, user_id)
  VALUES (p_poll_id, auth.uid())
  ON CONFLICT (poll_id, user_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION unsubscribe_from_poll_changes(p_poll_id UUID)
RETURNS VOID AS $$
BEGIN
  DELETE FROM game_poll_change_subscribers
   WHERE poll_id = p_poll_id AND user_id = auth.uid();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 3. Read current user's subscriptions -----------------------------------
CREATE OR REPLACE FUNCTION get_my_poll_change_subscriptions()
RETURNS TABLE(poll_id UUID) AS $$
  SELECT poll_id FROM game_poll_change_subscribers
   WHERE user_id = auth.uid();
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- 4. Resolve recipients for a vote-change event --------------------------
-- Returns ONE row per recipient with their player_name (used by the push
-- server's targetPlayerNames filter and the email lookup helper) and the
-- reason category they qualify (so future code can specialize messaging).
--
-- Recipients = (group admins ∪ super-admins in this group ∪ opted-in members),
-- where each user must be linked to a player via group_members.player_id
-- so we have a name to address.
CREATE OR REPLACE FUNCTION get_poll_change_recipients(p_poll_id UUID)
RETURNS TABLE(player_name TEXT, role TEXT) AS $$
DECLARE
  v_group_id UUID;
BEGIN
  SELECT group_id INTO v_group_id FROM game_polls WHERE id = p_poll_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'invalid_poll';
  END IF;

  -- Caller must be in the group OR a super-admin (clients shouldn't be
  -- able to enumerate other groups' admin rosters).
  IF NOT (
    EXISTS (SELECT 1 FROM group_members WHERE group_id = v_group_id AND user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM super_admins WHERE user_id = auth.uid())
  ) THEN
    RAISE EXCEPTION 'not_member';
  END IF;

  RETURN QUERY
  SELECT DISTINCT
         p.name AS player_name,
         CASE
           WHEN gm.role = 'admin'           THEN 'admin'
           WHEN sa.user_id IS NOT NULL      THEN 'super_admin'
           ELSE                                  'subscriber'
         END AS role
    FROM group_members gm
    JOIN players p ON p.id = gm.player_id
    LEFT JOIN super_admins sa
           ON sa.user_id = gm.user_id
    LEFT JOIN game_poll_change_subscribers s
           ON s.user_id = gm.user_id
          AND s.poll_id = p_poll_id
   WHERE gm.group_id = v_group_id
     AND (
           gm.role = 'admin'
        OR sa.user_id IS NOT NULL
        OR s.user_id IS NOT NULL
         );
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION subscribe_to_poll_changes(UUID)        TO authenticated;
GRANT EXECUTE ON FUNCTION unsubscribe_from_poll_changes(UUID)    TO authenticated;
GRANT EXECUTE ON FUNCTION get_my_poll_change_subscriptions()     TO authenticated;
GRANT EXECUTE ON FUNCTION get_poll_change_recipients(UUID)       TO authenticated;

-- ============================================================
-- DONE — Verify with:
--   SELECT subscribe_to_poll_changes('<poll-id>'::uuid);
--   SELECT * FROM get_my_poll_change_subscriptions();
--   SELECT * FROM get_poll_change_recipients('<poll-id>'::uuid);
-- ============================================================
