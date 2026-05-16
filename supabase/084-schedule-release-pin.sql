-- ============================================================
-- Migration 084: Release a manually-pinned poll date
-- Run in Supabase SQL Editor after 083-super-admin-read-rpc-bypass.sql
-- (Idempotent — uses CREATE OR REPLACE.)
--
-- Why: Migrations 022 / 038 / 051 gave admins two related affordances:
--   * Pin a date (manual_close_game_poll) — admin overrides whatever
--     the auto-close trigger picked, or picks early before any date
--     hit target.
--   * Re-pin to a different date — admin changes their mind, votes
--     stay, members are re-notified.
--
--   What was missing: undoing a pin without committing to a different
--   date. Real use-case: admin pinned a date based on early signal,
--   then a runner-up date overtakes it but neither has hit target yet.
--   The admin wants the poll to go back to "open recruitment" mode so
--   the auto-close trigger can re-fire on whichever date hits target
--   first — exactly the original flow. Today the only option is to
--   re-pin to one of the proposed dates (commits prematurely) or
--   cancel the poll outright (destroys all votes).
--
-- Behavior:
--   * Reverts a confirmed poll back to its prior recruitment phase:
--       - status='confirmed' → status='expanded' if expanded_at IS NOT NULL,
--         else status='open'.
--       - confirmed_date_id → NULL
--       - confirmed_at → NULL
--   * Resets confirmed_notifications_sent_at + target_filled_notifications_sent_at
--     so a future pin (auto-close or manual) re-fires the notification flow
--     fresh. Without this reset the next pin would silently swallow the
--     "we picked a date" announcement.
--   * Blocks the release once a game record has been linked to this poll
--     (confirmed_game_id IS NOT NULL): the game row carries the date as
--     a column, so removing the pin would orphan the linked game. Admins
--     who genuinely need to undo a pinned + game-started poll must delete
--     the game first.
--   * Only 'confirmed' polls can be released; 'open' / 'expanded' have
--     nothing to release, 'cancelled' / 'expired' are terminal.
--   * Same admin / poll-existence / membership gates as manual_close.
--
-- UI counterpart: src/components/PollCard.tsx surfaces a "🔓 שחרר נעילה"
--   button on the pinned tile (replacing the hidden "📌 בחר" affordance
--   on the already-pinned date). Both sides ship together — SQL grants
--   the permission, UI surfaces the affordance.
-- ============================================================

CREATE OR REPLACE FUNCTION release_game_poll_pin(
  p_poll_id  UUID
)
RETURNS VOID AS $$
DECLARE
  v_group_id   UUID;
  v_expanded   TIMESTAMPTZ;
  v_game_id    UUID;
  v_status     TEXT;
BEGIN
  SELECT group_id, expanded_at, confirmed_game_id, status
    INTO v_group_id, v_expanded, v_game_id, v_status
    FROM game_polls
   WHERE id = p_poll_id;

  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'invalid_poll';
  END IF;

  IF NOT is_schedule_admin(v_group_id) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  IF v_game_id IS NOT NULL THEN
    -- Mirrors manual_close's confirmed_game_id guard. A pinned poll
    -- with a game record is "settled in the real world" — releasing
    -- the pin would desync the game row's date column from the poll.
    RAISE EXCEPTION 'game_already_started';
  END IF;

  IF v_status <> 'confirmed' THEN
    -- Nothing to release. Either already in recruitment mode or terminal.
    -- Raising here (rather than silently no-op'ing) makes accidental
    -- double-clicks surface as a clear error in the UI instead of
    -- looking like a successful no-op.
    RAISE EXCEPTION 'not_pinned';
  END IF;

  UPDATE game_polls
     SET status = CASE
                    WHEN v_expanded IS NOT NULL THEN 'expanded'
                    ELSE 'open'
                  END,
         confirmed_date_id = NULL,
         confirmed_at = NULL,
         confirmed_notifications_sent_at = NULL,
         target_filled_notifications_sent_at = NULL
   WHERE id = p_poll_id
     AND status = 'confirmed'
     AND confirmed_game_id IS NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION release_game_poll_pin(UUID) TO authenticated;

-- ============================================================
-- DONE — Verify with:
--   -- A confirmed poll without a linked game; should flip back to
--   -- 'open' (or 'expanded' if expanded_at IS NOT NULL) and clear
--   -- the pin metadata.
--   SELECT release_game_poll_pin('<poll_id>'::uuid);
--   SELECT status, confirmed_date_id, confirmed_at
--     FROM game_polls WHERE id = '<poll_id>'::uuid;
--
--   -- Same poll, called again — raises 'not_pinned' (already released).
--   SELECT release_game_poll_pin('<poll_id>'::uuid);
--
--   -- A confirmed poll with confirmed_game_id set — raises
--   -- 'game_already_started'.
--   SELECT release_game_poll_pin('<poll_with_game_id>'::uuid);
-- ============================================================
