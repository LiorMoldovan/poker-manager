-- ============================================================
-- Migration 024: Schedule feature — broaden admin role checks
-- Run in Supabase SQL Editor after 022-game-scheduling.sql
-- (Idempotent — uses CREATE OR REPLACE.)
--
-- Why: 022 only allowed group_members.role = 'admin' to invoke schedule
--   admin actions. Group owners are already covered (the create-group RPC
--   inserts them with role='admin'), but platform-level super_admins were
--   not — they would receive 'not_admin' on every schedule admin action.
--
-- This migration:
--   1. Introduces helper `is_schedule_admin(p_group_id)` returning TRUE for
--      group admins (incl. owners) AND platform super_admins.
--   2. Replaces the inline role check in every admin-only schedule RPC with
--      the helper, so gating is uniform and easy to audit.
--   3. Leaves vote/expand RPCs untouched (cast_poll_vote = any member with
--      a player link; expand_game_poll = any member, time-gated).
-- ============================================================

CREATE OR REPLACE FUNCTION is_schedule_admin(p_group_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM group_members
    WHERE group_id = p_group_id
      AND user_id = auth.uid()
      AND role = 'admin'
  ) OR EXISTS (
    SELECT 1 FROM super_admins WHERE user_id = auth.uid()
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION is_schedule_admin(UUID) TO authenticated;

-- ─── 1. create_game_poll ───
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
  IF NOT is_schedule_admin(p_group_id) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  v_date_count := jsonb_array_length(COALESCE(p_dates, '[]'::jsonb));
  IF v_date_count < 2 OR v_date_count > 5 THEN
    RAISE EXCEPTION 'invalid_date_count';
  END IF;

  IF p_target < 2 THEN
    RAISE EXCEPTION 'invalid_target';
  END IF;

  INSERT INTO game_polls (
    group_id, created_by, target_player_count, expansion_delay_hours,
    default_location, allow_maybe, note
  )
  VALUES (
    p_group_id, auth.uid(), p_target, p_expansion_delay,
    p_default_location, p_allow_maybe, NULLIF(TRIM(p_note), '')
  )
  RETURNING id INTO v_poll_id;

  FOR v_date IN SELECT jsonb_array_elements(p_dates) LOOP
    INSERT INTO game_poll_dates (
      poll_id, proposed_date, proposed_time, location
    )
    VALUES (
      v_poll_id,
      (v_date->>'proposed_date')::date,
      NULLIF(v_date->>'proposed_time', '')::time,
      NULLIF(v_date->>'location', '')
    );
  END LOOP;

  RETURN v_poll_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ─── 2. cancel_game_poll ───
CREATE OR REPLACE FUNCTION cancel_game_poll(
  p_poll_id  UUID,
  p_reason   TEXT DEFAULT NULL
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

  UPDATE game_polls
     SET status = 'cancelled',
         cancellation_reason = NULLIF(TRIM(p_reason), '')
   WHERE id = p_poll_id
     AND status IN ('open', 'expanded');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ─── 3. manual_close_game_poll (admin override) ───
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
         confirmed_at = now()
   WHERE id = p_poll_id
     AND status IN ('open', 'expanded');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ─── 4. update_poll_target — re-runs threshold check after target change ───
CREATE OR REPLACE FUNCTION update_poll_target(
  p_poll_id    UUID,
  p_new_target INT
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

  IF p_new_target < 2 THEN
    RAISE EXCEPTION 'invalid_target';
  END IF;

  UPDATE game_polls SET target_player_count = p_new_target
   WHERE id = p_poll_id AND status IN ('open', 'expanded');

  -- Re-evaluate threshold so a lowered target can confirm immediately.
  SELECT date_id, count(*) INTO v_winning_date, v_yes_cnt
    FROM game_poll_votes
    WHERE poll_id = p_poll_id AND response = 'yes'
    GROUP BY date_id
    ORDER BY count(*) DESC, date_id ASC
    LIMIT 1;

  IF v_winning_date IS NOT NULL AND v_yes_cnt >= p_new_target THEN
    UPDATE game_polls
       SET status = 'confirmed',
           confirmed_date_id = v_winning_date,
           confirmed_at = now()
     WHERE id = p_poll_id
       AND status IN ('open', 'expanded');
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ─── 5. update_poll_expansion_delay (admin only, only while poll is open) ───
CREATE OR REPLACE FUNCTION update_poll_expansion_delay(
  p_poll_id   UUID,
  p_new_delay INT
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

  IF p_new_delay < 0 THEN
    RAISE EXCEPTION 'invalid_delay';
  END IF;

  UPDATE game_polls SET expansion_delay_hours = p_new_delay
   WHERE id = p_poll_id AND status = 'open';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ─── 6. link_poll_to_game ───
CREATE OR REPLACE FUNCTION link_poll_to_game(
  p_poll_id  UUID,
  p_game_id  UUID
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
    SELECT 1 FROM games WHERE id = p_game_id AND group_id = v_group_id
  ) THEN
    RAISE EXCEPTION 'game_not_in_group';
  END IF;

  UPDATE game_polls SET confirmed_game_id = p_game_id
   WHERE id = p_poll_id AND confirmed_game_id IS NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================
-- DONE — Verify with:
--   SELECT is_schedule_admin('<your-group-id>'::uuid);
--     -- TRUE for: group admins, group owners, platform super_admins.
--     -- FALSE for: regular members, non-members.
-- ============================================================
