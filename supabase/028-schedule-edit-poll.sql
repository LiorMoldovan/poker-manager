-- ============================================================
-- Migration 028: Schedule feature — consolidated edit-poll RPC
-- Run in Supabase SQL Editor after 024-schedule-roles.sql
-- (Idempotent — uses CREATE OR REPLACE.)
--
-- Why: The UI used to expose two separate prompts ("Edit target",
--   "Edit expansion delay") and offered no way to edit the poll's
--   note, default_location, or allow_maybe at all. This RPC exposes
--   one atomic editor over all the safely-editable poll metadata so
--   admins can fix typos / adjust target / etc. with a single modal.
--
-- Behavior:
--   * Admin-only (uses is_schedule_admin from migration 024).
--   * Only mutates while poll is in 'open' or 'expanded' state.
--   * Empty strings for note/default_location are normalized to NULL
--     so the caller can clear them.
--   * After updating target, re-evaluates the yes-vote winner so a
--     lowered target can flip the poll to 'confirmed' immediately.
--     Same logic as update_poll_target.
--   * expansion_delay is stored regardless of status (open/expanded)
--     since it only takes effect while open, but a future re-open
--     wouldn't see a stale value anyway.
-- ============================================================

CREATE OR REPLACE FUNCTION update_game_poll_meta(
  p_poll_id          UUID,
  p_target           INT,
  p_expansion_delay  INT,
  p_note             TEXT,
  p_default_location TEXT,
  p_allow_maybe      BOOLEAN
)
RETURNS VOID AS $$
DECLARE
  v_group_id     UUID;
  v_winning_date UUID;
  v_yes_cnt      INT;
BEGIN
  SELECT group_id INTO v_group_id FROM game_polls WHERE id = p_poll_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'invalid_poll';
  END IF;

  IF NOT is_schedule_admin(v_group_id) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  IF p_target IS NULL OR p_target < 2 THEN
    RAISE EXCEPTION 'invalid_target';
  END IF;

  IF p_expansion_delay IS NULL OR p_expansion_delay < 0 THEN
    RAISE EXCEPTION 'invalid_delay';
  END IF;

  -- Atomic update of all metadata fields.
  -- NULLIF(_, '') so empty input clears the optional text fields cleanly.
  -- COALESCE on allow_maybe so passing NULL keeps the current value.
  UPDATE game_polls
     SET target_player_count   = p_target,
         expansion_delay_hours = p_expansion_delay,
         note                  = NULLIF(p_note, ''),
         default_location      = NULLIF(p_default_location, ''),
         allow_maybe           = COALESCE(p_allow_maybe, allow_maybe)
   WHERE id = p_poll_id
     AND status IN ('open', 'expanded');

  -- Mirror update_poll_target: re-run threshold check so a lowered
  -- target can confirm the poll on the spot without waiting for the
  -- next vote to fire the auto-close trigger.
  SELECT date_id, count(*) INTO v_winning_date, v_yes_cnt
    FROM game_poll_votes
    WHERE poll_id = p_poll_id AND response = 'yes'
    GROUP BY date_id
    ORDER BY count(*) DESC, date_id ASC
    LIMIT 1;

  IF v_winning_date IS NOT NULL AND v_yes_cnt >= p_target THEN
    UPDATE game_polls
       SET status = 'confirmed',
           confirmed_date_id = v_winning_date,
           confirmed_at = NOW()
     WHERE id = p_poll_id
       AND status IN ('open', 'expanded');
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION update_game_poll_meta(UUID, INT, INT, TEXT, TEXT, BOOLEAN) TO authenticated;
