-- ============================================================
-- Migration 038: Allow admins to re-pin the confirmed date
-- Run in Supabase SQL Editor after 037-enforce-seat-cap.sql
-- (Idempotent — uses CREATE OR REPLACE.)
--
-- Why: Multi-date polls auto-confirm onto whichever date crosses the
--   yes-target first (see auto_close_poll_on_vote in 022). When two
--   dates hit the same yes-count at the same target — a "tie at the
--   line" — the trigger picks one based on insert order, which is
--   effectively random from the admin's perspective. The admin then
--   has no way to switch the lock-in to the runner-up tie-mate even
--   though both are equally viable nights.
--
--   The same gap exists when an admin simply changes their mind:
--   maybe the auto-confirmed Tuesday turns out worse than the runner-
--   up Thursday once the full roster is in. Until now the only escape
--   was cancelling the poll outright (destroys all votes) — which is
--   way too heavy for "actually let's go with the other date."
--
-- Behavior:
--   * `manual_close_game_poll` now accepts status IN ('open',
--     'expanded', 'confirmed'). Calling it on a confirmed poll
--     re-points `confirmed_date_id` to the new date and refreshes
--     `confirmed_at`. 'cancelled' / 'expired' (terminal states)
--     remain locked.
--   * `confirmed_at` is refreshed on every successful re-pin so the
--     "confirmed at" timestamp reflects the most recent admin
--     decision (useful for ordering / audit).
--   * `confirmed_notifications_sent_at` is reset to NULL on re-pin
--     so the cancellation/notification machinery picks up the new
--     decision and re-notifies recipients about the actual locked-in
--     date. Without this reset, members who were already notified
--     about the prior pick would never hear about the switch.
--   * Admin auth / poll-ownership / valid-date-for-poll checks are
--     unchanged — same gates as the original RPC.
--   * Re-pinning to the *currently* confirmed date is a no-op (the
--     UPDATE matches but writes the same values — confirmed_at gets
--     refreshed, which is harmless). Callers can rely on this for
--     idempotent retries.
--
-- UI counterpart: src/components/ScheduleTab.tsx now shows the "pick
--   this date" button on every per-date row (including confirmed
--   polls), disabled on the currently-pinned date. Both sides need
--   to be deployed together — the SQL grants the permission, the
--   UI surfaces the affordance.
-- ============================================================

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

  -- Loosened from migration 024: confirmed polls can now be re-pinned
  -- to a different proposed date (tie-breaker / change-of-mind flow).
  -- 'cancelled' / 'expired' stay locked — terminal states are terminal.
  -- We always reset confirmed_notifications_sent_at on the write so a
  -- re-pin re-fires the notification flow on the new date; this is a
  -- no-op when the row was already 'open'/'expanded' (no prior notif).
  --
  -- Also block re-pin once a game record has been linked to this poll
  -- (confirmed_game_id IS NOT NULL): the game row carries the *date*
  -- as a column, so silently switching the poll's confirmed date
  -- would desync the two and confuse the lineup / scoreboard / share
  -- flows. Admins who genuinely need to move a created game must
  -- delete or unlink it first; the WHERE filter just no-ops in that
  -- case so callers see no error but also no change.
  UPDATE game_polls
     SET status = 'confirmed',
         confirmed_date_id = p_date_id,
         confirmed_at = now(),
         confirmed_notifications_sent_at = NULL
   WHERE id = p_poll_id
     AND status IN ('open', 'expanded', 'confirmed')
     AND confirmed_game_id IS NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION manual_close_game_poll(UUID, UUID) TO authenticated;

-- ============================================================
-- DONE — Verify with:
--   -- A confirmed poll with two proposed dates A and B (currently
--   -- pinned on A); should now succeed and flip the lock to B.
--   SELECT manual_close_game_poll('<poll_id>'::uuid, '<date_b_id>'::uuid);
--
--   -- Same poll, called again with the same date_b_id — idempotent
--   -- no-op (same row, same values, refreshed confirmed_at).
--   SELECT manual_close_game_poll('<poll_id>'::uuid, '<date_b_id>'::uuid);
--
--   -- A cancelled poll's id; should still be a no-op (no row matches
--   -- the WHERE), confirmed_date_id stays whatever it was.
--   SELECT manual_close_game_poll('<cancelled_poll_id>'::uuid, '<any_date_id>'::uuid);
-- ============================================================
