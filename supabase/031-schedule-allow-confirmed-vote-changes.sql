-- ============================================================
-- Migration 031: Schedule polls — allow vote changes after confirmation
-- Run in Supabase SQL Editor after 030-schedule-vote-change-notifications.sql
-- (Idempotent — uses CREATE OR REPLACE.)
--
-- Why: Until now, once a poll auto-closed to 'confirmed' the entire
--   voting flow was frozen. Members who'd RSVP'd "yes" couldn't drop
--   out, late "no→yes" pivots couldn't be recorded, and admins
--   couldn't keep the roster honest after the game was announced. The
--   user feedback was straightforward: "people can change their mind,
--   the game is still happening — let them update their RSVP and let
--   admins see the truth."
--
-- Behavior:
--   * cast_poll_vote, admin_cast_poll_vote, admin_delete_poll_vote now
--     accept status IN ('open','expanded','confirmed') instead of just
--     ('open','expanded'). 'cancelled' and 'expired' stay locked —
--     those aren't "the game is happening" states.
--   * Original tier eligibility is preserved on confirmed polls. A
--     poll that confirmed straight from 'open' (permanent-only phase)
--     keeps that gate; a poll that reached 'expanded' first stays open
--     to all tiers. We detect this via expanded_at IS NULL.
--   * Confirmation is one-way. The auto-close trigger (defined in
--     022-game-scheduling.sql) only re-confirms while status is
--     ('open','expanded'), so vote changes on a confirmed poll cannot
--     accidentally pick a different date. The status, confirmed_date,
--     and confirmed_at columns are immutable once set — vote churn is
--     reflected in the live counts only. Admins can manually cancel
--     the poll if too many drop out.
--   * admin_cast_poll_vote and admin_delete_poll_vote remain admin-
--     only via is_schedule_admin() — confirmed status doesn't bypass
--     that check.
-- ============================================================

-- 1. cast_poll_vote — member self-RSVP, allow on confirmed --------------
CREATE OR REPLACE FUNCTION cast_poll_vote(
  p_date_id   UUID,
  p_response  TEXT,
  p_comment   TEXT DEFAULT NULL
)
RETURNS SETOF game_polls AS $$
DECLARE
  v_poll        game_polls%ROWTYPE;
  v_player_id   UUID;
  v_player_type TEXT;
BEGIN
  SELECT p.* INTO v_poll
    FROM game_polls p
    JOIN game_poll_dates d ON d.poll_id = p.id
    WHERE d.id = p_date_id;

  IF v_poll.id IS NULL THEN
    RAISE EXCEPTION 'invalid_date_id';
  END IF;

  -- 'cancelled' / 'expired' remain blocked. 'confirmed' is now allowed
  -- so members can change their mind after the game is locked in.
  IF v_poll.status NOT IN ('open', 'expanded', 'confirmed') THEN
    RAISE EXCEPTION 'poll_locked';
  END IF;

  SELECT gm.player_id INTO v_player_id
    FROM group_members gm
    WHERE gm.user_id = auth.uid() AND gm.group_id = v_poll.group_id;

  IF v_player_id IS NULL THEN
    RAISE EXCEPTION 'no_player_link';
  END IF;

  SELECT type INTO v_player_type FROM players WHERE id = v_player_id;
  IF v_player_type IS NULL THEN
    RAISE EXCEPTION 'no_player_link';
  END IF;

  -- Tier gate: keep the same eligibility the poll had at confirmation.
  --   * 'open'      → permanents only (unchanged).
  --   * 'expanded'  → all tiers (unchanged).
  --   * 'confirmed' → if expanded_at is NULL the poll confirmed during
  --     the permanents-only phase, so non-permanents still aren't
  --     allowed. Otherwise the poll had reached expanded once, so all
  --     tiers can update.
  IF v_poll.status = 'open' AND v_player_type <> 'permanent' THEN
    RAISE EXCEPTION 'tier_not_allowed';
  END IF;
  IF v_poll.status = 'confirmed'
     AND v_poll.expanded_at IS NULL
     AND v_player_type <> 'permanent' THEN
    RAISE EXCEPTION 'tier_not_allowed';
  END IF;

  IF p_response NOT IN ('yes', 'no', 'maybe') THEN
    RAISE EXCEPTION 'invalid_response';
  END IF;

  IF p_response = 'maybe' AND NOT v_poll.allow_maybe THEN
    RAISE EXCEPTION 'maybe_not_allowed';
  END IF;

  INSERT INTO game_poll_votes (
    poll_id, date_id, player_id, user_id, response, comment, voted_at,
    cast_by_user_id
  )
  VALUES (
    v_poll.id, p_date_id, v_player_id, auth.uid(), p_response, p_comment, now(),
    auth.uid()
  )
  ON CONFLICT (date_id, player_id) DO UPDATE
    SET response        = EXCLUDED.response,
        comment         = EXCLUDED.comment,
        voted_at        = EXCLUDED.voted_at,
        user_id         = EXCLUDED.user_id,
        cast_by_user_id = EXCLUDED.cast_by_user_id;

  RETURN QUERY SELECT * FROM game_polls WHERE id = v_poll.id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 2. admin_cast_poll_vote — proxy on behalf, allow on confirmed ---------
CREATE OR REPLACE FUNCTION admin_cast_poll_vote(
  p_date_id          UUID,
  p_voter_player_id  UUID,
  p_response         TEXT,
  p_comment          TEXT DEFAULT NULL
)
RETURNS SETOF game_polls AS $$
DECLARE
  v_poll          game_polls%ROWTYPE;
  v_player_group  UUID;
  v_player_user   UUID;
BEGIN
  SELECT p.* INTO v_poll
    FROM game_polls p
    JOIN game_poll_dates d ON d.poll_id = p.id
   WHERE d.id = p_date_id;

  IF v_poll.id IS NULL THEN
    RAISE EXCEPTION 'invalid_date_id';
  END IF;

  IF v_poll.status NOT IN ('open', 'expanded', 'confirmed') THEN
    RAISE EXCEPTION 'poll_locked';
  END IF;

  IF NOT is_schedule_admin(v_poll.group_id) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  IF p_response NOT IN ('yes', 'no', 'maybe') THEN
    RAISE EXCEPTION 'invalid_response';
  END IF;

  SELECT group_id INTO v_player_group FROM players WHERE id = p_voter_player_id;
  IF v_player_group IS NULL THEN
    RAISE EXCEPTION 'invalid_player';
  END IF;
  IF v_player_group <> v_poll.group_id THEN
    RAISE EXCEPTION 'player_not_in_group';
  END IF;

  SELECT gm.user_id INTO v_player_user
    FROM group_members gm
   WHERE gm.player_id = p_voter_player_id
     AND gm.group_id  = v_poll.group_id
   LIMIT 1;

  INSERT INTO game_poll_votes (
    poll_id, date_id, player_id, user_id, response, comment, voted_at,
    cast_by_user_id
  )
  VALUES (
    v_poll.id, p_date_id, p_voter_player_id, v_player_user,
    p_response, p_comment, now(),
    auth.uid()
  )
  ON CONFLICT (date_id, player_id) DO UPDATE
    SET response        = EXCLUDED.response,
        comment         = EXCLUDED.comment,
        voted_at        = EXCLUDED.voted_at,
        user_id         = EXCLUDED.user_id,
        cast_by_user_id = EXCLUDED.cast_by_user_id;

  RETURN QUERY SELECT * FROM game_polls WHERE id = v_poll.id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 3. admin_delete_poll_vote — proxy delete, allow on confirmed ----------
CREATE OR REPLACE FUNCTION admin_delete_poll_vote(
  p_date_id          UUID,
  p_voter_player_id  UUID
)
RETURNS SETOF game_polls AS $$
DECLARE
  v_poll  game_polls%ROWTYPE;
BEGIN
  SELECT p.* INTO v_poll
    FROM game_polls p
    JOIN game_poll_dates d ON d.poll_id = p.id
   WHERE d.id = p_date_id;

  IF v_poll.id IS NULL THEN
    RAISE EXCEPTION 'invalid_date_id';
  END IF;

  IF v_poll.status NOT IN ('open', 'expanded', 'confirmed') THEN
    RAISE EXCEPTION 'poll_locked';
  END IF;

  IF NOT is_schedule_admin(v_poll.group_id) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  DELETE FROM game_poll_votes
   WHERE date_id   = p_date_id
     AND player_id = p_voter_player_id;

  RETURN QUERY SELECT * FROM game_polls WHERE id = v_poll.id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================
-- DONE — Verify with:
--   -- A confirmed poll's date_id; should now succeed.
--   SELECT cast_poll_vote('<confirmed_date_id>'::uuid, 'no');
--
--   -- A cancelled poll's date_id; should still raise 'poll_locked'.
--   SELECT cast_poll_vote('<cancelled_date_id>'::uuid, 'yes');
-- ============================================================
