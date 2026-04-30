-- ============================================================
-- Migration 034: Allow editing poll metadata after confirmation
-- Run in Supabase SQL Editor after 028-schedule-edit-poll.sql
-- (Idempotent — uses CREATE OR REPLACE.)
--
-- Why: Migration 028's `update_game_poll_meta` was gated to
--   status IN ('open', 'expanded'). Once a poll auto-confirmed,
--   the admin lost the ability to adjust the target — even
--   though the count can still drop afterwards (a yes-voter
--   changes their mind via migration 031). The product call:
--   if the admin's "good number" was 7 and one player drops,
--   the admin should be able to lower the target to 6 to
--   reflect the new locked-in roster — without having to
--   cancel and re-poll.
--
-- Behavior change:
--   * `update_game_poll_meta` now also accepts `confirmed`.
--     `cancelled` and `expired` (terminal states) remain locked.
--   * The threshold-recheck UPDATE at the bottom is unchanged —
--     it's a no-op on already-confirmed polls (its own gate
--     still excludes 'confirmed'), which is exactly what we
--     want: editing a confirmed poll should never re-confirm
--     it (it's already confirmed) and should never silently
--     un-confirm it.
--   * Hiding fields that don't apply post-confirmation
--     (e.g. expansion_delay) is the UI's job, same as today —
--     the RPC stays accepting of any caller-provided values.
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
  -- Loosened from migration 028 to also include 'confirmed' so admins
  -- can lower the target after lock-in (e.g. 7→6 once one player drops).
  -- 'cancelled' / 'expired' stay locked — terminal states are terminal.
  UPDATE game_polls
     SET target_player_count   = p_target,
         expansion_delay_hours = p_expansion_delay,
         note                  = NULLIF(p_note, ''),
         default_location      = NULLIF(p_default_location, ''),
         allow_maybe           = COALESCE(p_allow_maybe, allow_maybe)
   WHERE id = p_poll_id
     AND status IN ('open', 'expanded', 'confirmed');

  -- Threshold re-eval: a lowered target on an open/expanded poll can
  -- flip it to 'confirmed' immediately. Already-confirmed polls are
  -- excluded by this UPDATE's own status filter, which is correct —
  -- editing a confirmed poll should never silently re-confirm it onto
  -- a different date.
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
