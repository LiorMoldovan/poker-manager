-- ============================================================
-- Migration 107: Re-picking the same date stops re-announcing it
-- Run in Supabase SQL Editor after 106-pin-funnels-voting-no-auto-lock.sql
-- (Idempotent — ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE.)
--
-- Why: `enqueue_poll_notification` blocks a duplicate announcement
--   purely by checking the matching `*_notifications_sent_at` sentinel
--   (stamped by `complete_notification_job` once a send succeeds).
--   `manual_close_game_poll` clears BOTH the `confirmed` and the
--   `target_filled` sentinel on every pin. Migration 038 did that on
--   purpose so switching to a DIFFERENT date re-announces — correct.
--   But it also fires when the pin lands back on the date members were
--   already told about, and then two independent paths re-send:
--     1. `fn_enqueue_poll_notification_on_change` on the status flip.
--     2. `runSchedulerSweep`'s backfill enqueue in
--        `src/utils/scheduleNotifications.ts`, which enqueues any
--        'confirmed' / 'target_filled' whose sentinel is NULL.
--
--   The 📌 chip is hidden on the already-pinned tile, so the way an
--   admin lands back on the same date is release-then-pick — which is
--   exactly the dance they were using to escape the auto-lock that
--   migration 106 just removed. `release_game_poll_pin` clears
--   `confirmed_date_id` but is deliberately silent, so members never
--   learn the pick was undone and the re-pick reads to them as a
--   duplicate.
--
--   Measured on the live DB: 5 of the last 9 polls sent the "we picked
--   a date" push 2–3 times, and 3 of them sent "the game is full"
--   2–3 times.
--
-- Fix: remember which date members were last told about, in a new
--   `game_polls.confirmed_notified_date_id` column, and clear the two
--   sentinels only when the incoming pick differs from it. The column
--   survives a pin release (that's the whole point) and is stamped by
--   both paths that can confirm a date:
--     * `manual_close_game_poll` — stamps unconditionally; either it
--       just cleared the sentinels and an announcement is about to go
--       out, or the sentinels were kept because this date was already
--       announced. Both end states are "the last announced date is
--       p_date_id".
--     * `auto_close_poll_on_vote` — stamps inside the same UPDATE that
--       flips an open/expanded poll to confirmed, so a target-driven
--       auto-confirm is recorded too.
--
--   Deliberately NOT changed: `release_game_poll_pin` leaves the column
--   alone, and the sentinels themselves keep their existing meaning and
--   their existing writer (`complete_notification_job`).
--
-- Net effect: a genuine switch to another date still announces; landing
--   back on the already-announced date is silent.
-- ============================================================

-- 1. Bookkeeping column -----------------------------------------------
-- ON DELETE SET NULL: if the date row itself is removed (poll edited),
-- the marker clears and the next pick is free to announce again.
ALTER TABLE game_polls
  ADD COLUMN IF NOT EXISTS confirmed_notified_date_id UUID
    REFERENCES game_poll_dates(id) ON DELETE SET NULL;

COMMENT ON COLUMN game_polls.confirmed_notified_date_id IS
  'The proposed date members were last told about via a confirmed/target_filled push. Survives release_game_poll_pin so re-picking the same date does not re-announce it. Migration 107.';

-- 2. Backfill ----------------------------------------------------------
-- Existing polls that already announced a pick get the marker set to
-- the date that was announced. Without this, the first re-pick after
-- this migration would still re-blast. Write-only bookkeeping — it can
-- never cause a send, it can only suppress a duplicate one.
UPDATE game_polls
   SET confirmed_notified_date_id = confirmed_date_id
 WHERE confirmed_notified_date_id IS NULL
   AND confirmed_date_id IS NOT NULL
   AND confirmed_notifications_sent_at IS NOT NULL;

-- 3. manual_close_game_poll — reset sentinels only on a real switch ----
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

  -- Bare column references in a SET expression read the OLD row, so
  -- `confirmed_notified_date_id` here is the date members were last
  -- told about. Only a genuine switch re-opens the notification gate.
  UPDATE game_polls
     SET status = 'confirmed',
         confirmed_date_id = p_date_id,
         confirmed_at = now(),
         confirmed_notifications_sent_at = CASE
           WHEN confirmed_notified_date_id IS DISTINCT FROM p_date_id
           THEN NULL ELSE confirmed_notifications_sent_at END,
         target_filled_notifications_sent_at = CASE
           WHEN confirmed_notified_date_id IS DISTINCT FROM p_date_id
           THEN NULL ELSE target_filled_notifications_sent_at END,
         confirmed_notified_date_id = p_date_id
   WHERE id = p_poll_id
     AND status IN ('open', 'expanded', 'confirmed')
     AND confirmed_game_id IS NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION manual_close_game_poll(UUID, UUID) TO authenticated;

-- 4. auto_close_poll_on_vote — record target-driven confirmations ------
-- Same body as migration 106 (auto-confirm only, never auto-lock) plus
-- the marker stamp, so a poll that confirmed itself on the target is
-- also protected against a later same-date re-pick re-announcing.
CREATE OR REPLACE FUNCTION auto_close_poll_on_vote()
RETURNS TRIGGER AS $$
DECLARE
  v_target         INT;
  v_yes_cnt        INT;
  v_date_disabled  BOOLEAN;
BEGIN
  IF NEW.response <> 'yes' THEN
    RETURN NEW;
  END IF;

  SELECT (disabled_at IS NOT NULL) INTO v_date_disabled
    FROM game_poll_dates WHERE id = NEW.date_id;

  IF v_date_disabled THEN
    RETURN NEW;
  END IF;

  SELECT target_player_count INTO v_target
    FROM game_polls WHERE id = NEW.poll_id;

  SELECT count(*) INTO v_yes_cnt
    FROM game_poll_votes
    WHERE date_id = NEW.date_id AND response = 'yes';

  IF v_yes_cnt >= v_target THEN
    UPDATE game_polls
       SET status = 'confirmed',
           confirmed_date_id = NEW.date_id,
           confirmed_at = now(),
           confirmed_notified_date_id = NEW.date_id
     WHERE id = NEW.poll_id
       AND status IN ('open', 'expanded');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

-- ============================================================
-- DONE — Verify with:
--   -- 1. Column + backfill:
--   SELECT count(*) FILTER (WHERE confirmed_notified_date_id IS NOT NULL) AS marked,
--          count(*) FILTER (WHERE confirmed_notifications_sent_at IS NOT NULL) AS announced
--     FROM game_polls;   -- marked should equal announced for pinned polls
--
--   -- 2. Behavioral sandbox (roll back at the end):
--   --    a. Pick date A on a fresh poll   -> a 'confirmed' job appears.
--   --    b. Release the pin, pick A again  -> NO new 'confirmed' job.
--   --    c. Pick date B instead            -> a new 'confirmed' job appears.
--
--   Trap when writing that sandbox: `release_game_poll_pin` sets
--   `app.suppress_poll_notifications` with is_local => true, which is
--   TRANSACTION scoped, not function scoped. In production each RPC is
--   its own transaction so the flag dies at commit, but a sandbox that
--   calls release and then keeps going in the same transaction silences
--   every later enqueue and reports false negatives. Reset the flag to
--   'false' after each release call to emulate the commit boundary.
-- ============================================================
