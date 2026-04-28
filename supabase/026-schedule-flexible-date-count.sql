-- ============================================================
-- Migration 026: Schedule polls — flexible date count
-- Run in Supabase SQL Editor after 025-schedule-proxy-votes.sql
-- (Idempotent — safe to re-run; uses CREATE OR REPLACE.)
--
-- Removes the "between 2 and 5 dates" constraint on `create_game_poll`.
-- Organizers may now publish a poll with a single proposed date and add
-- more dates only if they want to. The only remaining hard rule is that
-- at least one valid future date must be provided.
-- ============================================================

CREATE OR REPLACE FUNCTION create_game_poll(
  p_group_id          UUID,
  p_dates             JSONB,
  p_target            INT DEFAULT 8,
  p_expansion_delay   INT DEFAULT 48,
  p_default_location  TEXT DEFAULT NULL,
  p_allow_maybe       BOOLEAN DEFAULT TRUE,
  p_note              TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  v_poll_id    UUID;
  v_date_count INT;
  v_date       JSONB;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM group_members
    WHERE group_id = p_group_id AND user_id = auth.uid() AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  v_date_count := jsonb_array_length(COALESCE(p_dates, '[]'::jsonb));
  -- At least one date is still required; no upper bound.
  IF v_date_count < 1 THEN
    RAISE EXCEPTION 'invalid_date_count';
  END IF;

  IF p_target < 2 THEN
    RAISE EXCEPTION 'invalid_target';
  END IF;

  INSERT INTO game_polls (
    group_id, created_by, status, target_player_count,
    expansion_delay_hours, default_location, allow_maybe, note
  )
  VALUES (
    p_group_id, auth.uid(), 'open', p_target,
    p_expansion_delay, p_default_location, p_allow_maybe, p_note
  )
  RETURNING id INTO v_poll_id;

  FOR v_date IN SELECT * FROM jsonb_array_elements(p_dates)
  LOOP
    IF (v_date->>'proposed_date')::DATE < CURRENT_DATE THEN
      RAISE EXCEPTION 'past_date';
    END IF;

    INSERT INTO game_poll_dates (poll_id, proposed_date, proposed_time, location)
    VALUES (
      v_poll_id,
      (v_date->>'proposed_date')::DATE,
      NULLIF(v_date->>'proposed_time', '')::TIME,
      NULLIF(v_date->>'location', '')
    );
  END LOOP;

  RETURN v_poll_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
