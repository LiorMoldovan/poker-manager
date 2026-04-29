-- ============================================================
-- Migration 032: Schedule feature — per-admin vote-change opt-out
-- Run in Supabase SQL Editor after 031-schedule-allow-confirmed-vote-changes.sql
-- (Idempotent — uses CREATE OR REPLACE / IF NOT EXISTS.)
--
-- Why: Admins were auto-subscribed to every vote-change push, with no
--   way to mute them. For groups with chatty rosters (lots of late
--   pivots) this fires constantly and drowns out the four major-update
--   notifications (creation / expansion / confirmation / cancellation).
--   This migration adds a per-(user, group) preference so each admin
--   can independently opt out of vote_change pings without affecting
--   the major notifications.
--
-- Behavior:
--   * Default ON for everyone — preserves existing behavior so admins
--     who never touch this toggle keep getting pings exactly as before.
--   * Per-group: an admin who manages multiple groups can opt out for
--     a noisy group while leaving a quieter one alone.
--   * Master switch: even if the user is also in
--     game_poll_change_subscribers (opted in per-poll), flipping this
--     off mutes them. The toggle is meant to be the ground truth for
--     "should I receive vote-change pings in this group at all".
--   * Major-update notifications (creation / expansion / confirmation /
--     cancellation) are unaffected — they go through different
--     resolvers and don't read this flag.
--
-- Storage: a column on group_members. group_members already has one
--   row per (user, group), so this fits naturally without a new table.
-- ============================================================

-- 1. Per-(user, group) preference column ---------------------------------
ALTER TABLE group_members
  ADD COLUMN IF NOT EXISTS schedule_vote_change_notifs BOOLEAN NOT NULL DEFAULT TRUE;

-- 2. Read / write RPCs ---------------------------------------------------
-- Idempotent reader; returns TRUE for a not-yet-set row (default).
CREATE OR REPLACE FUNCTION get_my_vote_change_notifs(p_group_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_enabled BOOLEAN;
BEGIN
  SELECT schedule_vote_change_notifs INTO v_enabled
    FROM group_members
   WHERE group_id = p_group_id
     AND user_id  = auth.uid();
  -- NULL only when the caller isn't a member of the group, which
  -- shouldn't happen via the UI but we return TRUE rather than NULL
  -- so the client can render a sensible default in any race.
  RETURN COALESCE(v_enabled, TRUE);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- Writer: lets each user set their own preference for a group they're
-- a member of. No admin gate — every member can manage their own
-- notification flag (members default to TRUE but never get pinged
-- unless they also opt in via subscribe_to_poll_changes per-poll, so
-- the flag is mostly meaningful for admins/owners/super-admins).
CREATE OR REPLACE FUNCTION set_my_vote_change_notifs(
  p_group_id UUID,
  p_enabled  BOOLEAN
)
RETURNS VOID AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM group_members
     WHERE group_id = p_group_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not_member';
  END IF;

  UPDATE group_members
     SET schedule_vote_change_notifs = COALESCE(p_enabled, TRUE)
   WHERE group_id = p_group_id
     AND user_id  = auth.uid();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION get_my_vote_change_notifs(UUID)            TO authenticated;
GRANT EXECUTE ON FUNCTION set_my_vote_change_notifs(UUID, BOOLEAN)   TO authenticated;

-- 3. Recipient resolver — honor the new opt-out --------------------------
-- Mirrors the version from 030-schedule-vote-change-notifications.sql but
-- adds a final filter on the group_members flag, so a user who has
-- toggled the preference off is excluded regardless of which inclusion
-- path matched (admin / super-admin / opted-in subscriber).
CREATE OR REPLACE FUNCTION get_poll_change_recipients(p_poll_id UUID)
RETURNS TABLE(player_name TEXT, role TEXT) AS $$
DECLARE
  v_group_id UUID;
BEGIN
  SELECT group_id INTO v_group_id FROM game_polls WHERE id = p_poll_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'invalid_poll';
  END IF;

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
         )
     -- Per-(user, group) opt-out (migration 032). Defaults to TRUE on
     -- the column itself so legacy rows match the prior behavior.
     AND gm.schedule_vote_change_notifs = TRUE;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- ============================================================
-- DONE — Verify with:
--   -- Read your own preference for a group:
--   SELECT get_my_vote_change_notifs('<group-id>'::uuid);
--
--   -- Mute yourself:
--   SELECT set_my_vote_change_notifs('<group-id>'::uuid, FALSE);
--
--   -- Confirm you fall out of the recipient list for a live poll:
--   SELECT * FROM get_poll_change_recipients('<poll-id>'::uuid);
-- ============================================================
