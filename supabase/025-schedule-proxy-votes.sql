-- ============================================================
-- Migration 025: Schedule feature — admin proxy votes
-- Run in Supabase SQL Editor after 024-schedule-roles.sql
-- (Idempotent — safe to re-run; uses CREATE OR REPLACE + IF NOT EXISTS.)
--
-- Adds the ability for group admins / owners / platform super-admins to
-- cast or edit votes on behalf of any player in the group's roster —
-- primarily to cover players who refuse to register.
--
-- Key design points:
--   * `game_poll_votes.user_id` becomes nullable so unregistered players
--     (no auth row) can have a vote recorded for them.
--   * New column `cast_by_user_id` tracks the auth user who actually
--     cast / last-edited the vote. For self-cast votes this equals
--     `user_id`. For admin-proxy votes it's the admin's auth uid.
--   * A vote is "proxy" iff cast_by_user_id IS NOT NULL AND
--     (user_id IS NULL OR cast_by_user_id <> user_id). Computed at read.
--   * If the actual player later self-casts (via `cast_poll_vote`),
--     the upsert resets `cast_by_user_id = auth.uid()` so the proxy
--     marker disappears — the player wins.
--   * Admin overrides tier/allow_maybe checks BUT cannot modify a closed
--     poll (status NOT IN open/expanded). This avoids surprise re-opens.
-- ============================================================

-- 1. Schema changes ------------------------------------------------------

ALTER TABLE game_poll_votes
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE game_poll_votes
  ADD COLUMN IF NOT EXISTS cast_by_user_id UUID
    REFERENCES auth.users(id) ON DELETE SET NULL;

-- Backfill existing rows: every existing vote was self-cast, so
-- cast_by_user_id mirrors user_id.
UPDATE game_poll_votes
   SET cast_by_user_id = user_id
 WHERE cast_by_user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_game_poll_votes_cast_by
  ON game_poll_votes(cast_by_user_id);

-- 2. Update cast_poll_vote to populate cast_by_user_id -------------------
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

  IF v_poll.status NOT IN ('open', 'expanded') THEN
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

  IF v_poll.status = 'open' AND v_player_type <> 'permanent' THEN
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

-- 3. New RPC: admin_cast_poll_vote ---------------------------------------
-- Admin / owner / super_admin can vote on behalf of any player in the
-- group, bypassing tier and allow_maybe rules. Cannot operate on a closed
-- poll (status NOT IN open/expanded).
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

  IF v_poll.status NOT IN ('open', 'expanded') THEN
    RAISE EXCEPTION 'poll_locked';
  END IF;

  IF NOT is_schedule_admin(v_poll.group_id) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  IF p_response NOT IN ('yes', 'no', 'maybe') THEN
    RAISE EXCEPTION 'invalid_response';
  END IF;

  -- Player must belong to the poll's group. We allow voting for any
  -- registered or unregistered player in the roster.
  SELECT group_id INTO v_player_group FROM players WHERE id = p_voter_player_id;
  IF v_player_group IS NULL THEN
    RAISE EXCEPTION 'invalid_player';
  END IF;
  IF v_player_group <> v_poll.group_id THEN
    RAISE EXCEPTION 'player_not_in_group';
  END IF;

  -- Resolve the player's auth user (if linked); otherwise NULL.
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

GRANT EXECUTE ON FUNCTION admin_cast_poll_vote(UUID, UUID, TEXT, TEXT) TO authenticated;

-- 4. New RPC: admin_delete_poll_vote -------------------------------------
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

  IF v_poll.status NOT IN ('open', 'expanded') THEN
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

GRANT EXECUTE ON FUNCTION admin_delete_poll_vote(UUID, UUID) TO authenticated;

-- ============================================================
-- DONE — Verify with:
--   SELECT id, player_id, user_id, cast_by_user_id, response
--     FROM game_poll_votes LIMIT 5;
--
--   -- Cast a proxy vote (admin only):
--   SELECT * FROM admin_cast_poll_vote(
--     '<date-id>'::uuid, '<player-id>'::uuid, 'yes', 'בא בטוח, שלח לי הודעה'
--   );
-- ============================================================
