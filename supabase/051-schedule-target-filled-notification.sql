-- ============================================================
-- Migration 051: "Target filled" follow-up notification
-- Run in Supabase SQL Editor after 050-schedule-auto-create.sql
-- (Idempotent — uses IF NOT EXISTS / CREATE OR REPLACE.)
--
-- Why: When an admin manually pins a date BEFORE the seat target
--   was reached (the confirmed-below-target flow added in the
--   client), we send two tailored notifications: "you're in" to
--   yes-voters and "we picked a date, please join" to the others.
--   After that, the missing slot eventually fills via normal
--   yes-votes — but no notification fires because
--   `confirmed_notifications_sent_at` was already burned at pin
--   time. The yes-voters are left wondering "is the game on for
--   sure?" until they reopen the app.
--
--   This migration adds a separate `target_filled_notifications_sent_at`
--   column with an independent claim slot so the client can fire a
--   final "המשחק מלא — ניפגש!" announcement without disturbing the
--   existing confirmed-flow timestamp. The two events are different
--   things (the pin vs. the seat-fill) and deserve independent
--   idempotency.
--
-- Behavior:
--   * New TIMESTAMPTZ column on `game_polls`, nullable, defaults
--     NULL.
--   * `claim_poll_notifications` accepts a new kind 'target_filled'.
--     First caller wins as usual.
--   * When the original confirmed notification was already an
--     at-target announcement (poll was created at target / hit
--     target before the admin pinned), the client preemptively
--     claims 'target_filled' too — so the seat-fill follow-up
--     can't double-fire on top of "המשחק נסגר!". See the
--     `sendConfirmedNotifications` at-target branch.
--   * `manual_close_game_poll` now also resets this column to NULL
--     on every re-pin. A fresh pin starts with a fresh "filled"
--     claim slot — the previous date's filled state isn't
--     relevant any more.
-- ============================================================

-- 1. Add the column. Idempotent — `IF NOT EXISTS` guards reruns.
ALTER TABLE game_polls
  ADD COLUMN IF NOT EXISTS target_filled_notifications_sent_at TIMESTAMPTZ;

-- 2. Extend claim_poll_notifications with the new kind.
CREATE OR REPLACE FUNCTION claim_poll_notifications(
  p_poll_id  UUID,
  p_kind     TEXT
)
RETURNS BOOLEAN AS $$
DECLARE
  v_updated INT;
BEGIN
  IF p_kind NOT IN ('creation', 'expanded', 'confirmed', 'cancellation', 'target_filled') THEN
    RAISE EXCEPTION 'invalid_kind';
  END IF;

  -- Caller must be a member of the poll's group (RLS-equivalent check)
  IF NOT EXISTS (
    SELECT 1 FROM game_polls p
    JOIN group_members gm ON gm.group_id = p.group_id
    WHERE p.id = p_poll_id AND gm.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not_member';
  END IF;

  IF p_kind = 'creation' THEN
    UPDATE game_polls SET creation_notifications_sent_at = now()
      WHERE id = p_poll_id AND creation_notifications_sent_at IS NULL;
  ELSIF p_kind = 'expanded' THEN
    UPDATE game_polls SET expanded_notifications_sent_at = now()
      WHERE id = p_poll_id AND expanded_notifications_sent_at IS NULL;
  ELSIF p_kind = 'confirmed' THEN
    UPDATE game_polls SET confirmed_notifications_sent_at = now()
      WHERE id = p_poll_id AND confirmed_notifications_sent_at IS NULL;
  ELSIF p_kind = 'cancellation' THEN
    UPDATE game_polls SET cancellation_notifications_sent_at = now()
      WHERE id = p_poll_id AND cancellation_notifications_sent_at IS NULL;
  ELSIF p_kind = 'target_filled' THEN
    UPDATE game_polls SET target_filled_notifications_sent_at = now()
      WHERE id = p_poll_id AND target_filled_notifications_sent_at IS NULL;
  END IF;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 3. manual_close_game_poll now also resets `target_filled_notifications_sent_at`
--    on re-pin. A re-pin can change which date is the "current target":
--    e.g. the old date may have been at target while the new one isn't,
--    or vice versa. Resetting the slot here lets the client decide
--    fresh whether to fire a target-filled notification on the new
--    pinned date.
CREATE OR REPLACE FUNCTION manual_close_game_poll(
  p_poll_id  UUID,
  p_date_id  UUID
)
RETURNS VOID AS $$
DECLARE
  v_group_id UUID;
BEGIN
  SELECT group_id INTO v_group_id FROM game_polls WHERE id = p_poll_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'invalid_poll';
  END IF;

  IF NOT is_schedule_admin(v_group_id) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM game_poll_dates WHERE id = p_date_id AND poll_id = p_poll_id
  ) THEN
    RAISE EXCEPTION 'invalid_date_for_poll';
  END IF;

  UPDATE game_polls
     SET status = 'confirmed',
         confirmed_date_id = p_date_id,
         confirmed_at = now(),
         confirmed_notifications_sent_at = NULL,
         target_filled_notifications_sent_at = NULL
   WHERE id = p_poll_id
     AND status IN ('open', 'expanded', 'confirmed')
     AND confirmed_game_id IS NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION manual_close_game_poll(UUID, UUID) TO authenticated;

-- ============================================================
-- DONE — Verify with:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='game_polls'
--      AND column_name='target_filled_notifications_sent_at';
--   -- expect 1 row
--
--   -- First call returns true, subsequent calls return false until
--   -- manual_close re-pins the date.
--   SELECT claim_poll_notifications('<poll_id>'::uuid, 'target_filled');
--
--   -- Re-pin flow: column should be reset back to NULL afterwards.
--   SELECT manual_close_game_poll('<poll_id>'::uuid, '<other_date_id>'::uuid);
--   SELECT target_filled_notifications_sent_at FROM game_polls WHERE id='<poll_id>';
-- ============================================================
