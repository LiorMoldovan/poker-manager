-- ============================================================
-- Migration 039: Schedule polls — admin-toggleable voting lock
-- Run in Supabase SQL Editor after 038-schedule-repin-confirmed.sql
-- (Idempotent — uses CREATE OR REPLACE / IF NOT EXISTS / DROP+ADD pattern.)
--
-- Why: Once a poll is confirmed-below-target (admin pinned a date but
--   yes-count is still under the seat target — see 031), voting stays
--   live so latecomers can join and dropouts can drop. That's the
--   *intended* design for most polls. But there's a real ~12–24h gap
--   between "admin shared the game with the lineup" and "admin starts
--   the game" where members occasionally flip yes↔no overnight, and
--   the admin doesn't yet want to commit to the canonical NewGameScreen
--   start-game flow (which creates a forecast row, opens TTS, etc.)
--   just to freeze the lineup.
--
--   This migration adds an admin-flippable soft lock that's separate
--   from the poll status:
--     * Status keeps its meaning (open / expanded / confirmed / cancelled / expired).
--     * `voting_locked_at` is a timestamp side-channel: NULL = open
--       to votes, NOT NULL = frozen until admin unlocks.
--     * It's reversible — admin can lock + unlock as needed without
--       touching status, dates, votes, or notification flags.
--
-- Behavior:
--   * New column `game_polls.voting_locked_at TIMESTAMPTZ NULL`.
--   * New RPC `set_poll_voting_lock(p_poll_id, p_locked)`. Admin-only.
--     Idempotent (locking a locked poll refreshes the timestamp;
--     unlocking an unlocked poll is a no-op). Only valid on
--     'open' / 'expanded' / 'confirmed' polls — terminal states
--     (cancelled / expired) reject because the lock is irrelevant
--     once voting is permanently closed by status.
--   * `cast_poll_vote`, `admin_cast_poll_vote`, `admin_delete_poll_vote`
--     all gain a guard: when `voting_locked_at IS NOT NULL`, raise
--     'voting_locked'. The lock applies even to admin proxy actions —
--     if the admin wants to record a vote-on-behalf they unlock first
--     (avoids a footgun where the admin locks "for everyone" but can
--     still poke the lineup themselves).
--   * The `auto_close_poll_on_vote` trigger still fires (it gates on
--     status, not on this lock), but since no votes can be inserted/
--     updated while locked, in practice it never re-fires.
--
-- UI counterpart: src/components/ScheduleTab.tsx exposes a
--   "🔒 נעל הצבעה" / "🔓 שחרר הצבעה" toggle button on PollCard's
--   action row (admin only) that calls this RPC and re-renders.
--   The RSVP buttons grey out with a "voting locked" tooltip while
--   `voting_locked_at` is set. Both sides need to be deployed
--   together — the SQL grants the gate, the UI surfaces it.
-- ============================================================

-- 1. Schema change ----------------------------------------------------
ALTER TABLE game_polls
  ADD COLUMN IF NOT EXISTS voting_locked_at TIMESTAMPTZ NULL;

-- 2. Toggle RPC --------------------------------------------------------
CREATE OR REPLACE FUNCTION set_poll_voting_lock(
  p_poll_id  UUID,
  p_locked   BOOLEAN
)
RETURNS VOID AS $$
DECLARE
  v_group_id UUID;
  v_status   TEXT;
BEGIN
  SELECT group_id, status
    INTO v_group_id, v_status
    FROM game_polls
   WHERE id = p_poll_id;

  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'invalid_poll';
  END IF;

  IF NOT is_schedule_admin(v_group_id) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  -- Lock only makes sense on active voting states. Cancelled / expired
  -- polls are already terminal — no votes are accepted regardless of
  -- this flag, so toggling it would be misleading UI noise.
  IF v_status NOT IN ('open', 'expanded', 'confirmed') THEN
    RAISE EXCEPTION 'poll_locked';
  END IF;

  UPDATE game_polls
     SET voting_locked_at = CASE WHEN p_locked THEN now() ELSE NULL END
   WHERE id = p_poll_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION set_poll_voting_lock(UUID, BOOLEAN) TO authenticated;

-- 3. cast_poll_vote — block when locked --------------------------------
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

  IF v_poll.status NOT IN ('open', 'expanded', 'confirmed') THEN
    RAISE EXCEPTION 'poll_locked';
  END IF;

  -- Migration 039: admin-toggleable soft lock. Status stays as-is;
  -- this guard short-circuits regardless of the active voting state.
  IF v_poll.voting_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'voting_locked';
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

-- 4. admin_cast_poll_vote — block when locked --------------------------
-- The lock applies even to admin proxy actions: if the admin wants to
-- adjust a member's RSVP they unlock first. This avoids a footgun where
-- the lock conveys "frozen lineup" to members but the admin can still
-- silently poke the lineup, contradicting what was advertised.
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

  IF v_poll.voting_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'voting_locked';
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

-- 5. admin_delete_poll_vote — block when locked ------------------------
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

  IF v_poll.voting_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'voting_locked';
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
--   -- Lock and confirm the column flips:
--   SELECT set_poll_voting_lock('<poll_id>'::uuid, true);
--   SELECT voting_locked_at FROM game_polls WHERE id = '<poll_id>';
--
--   -- Voting is now blocked even on an open/expanded/confirmed poll:
--   SELECT cast_poll_vote('<date_id>'::uuid, 'yes');  -- raises 'voting_locked'
--
--   -- Unlock and re-vote:
--   SELECT set_poll_voting_lock('<poll_id>'::uuid, false);
--   SELECT cast_poll_vote('<date_id>'::uuid, 'yes');  -- succeeds
-- ============================================================
