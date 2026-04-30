-- ============================================================
-- Migration 037: Schedule polls — enforce seat cap on yes-votes
-- Run in Supabase SQL Editor after 036-cancel-confirmed-poll.sql
-- (Idempotent — uses CREATE OR REPLACE.)
--
-- Why: Until now, target_player_count was the auto-confirm trigger
--   only — once a poll auto-closed, members and admins could keep
--   adding fresh 'yes' votes (or upgrading 'maybe'/'no' → 'yes'),
--   pushing the roster past the cap the admin chose. Real reproduction
--   from production: a poll with target=7 reached 7 yes, auto-confirmed,
--   then a member changed their 'maybe' → 'yes' and the count silently
--   went to 8.
--
--   The fix turns target_player_count into a hard cap: 'yes' inserts /
--   updates that would push the live yes-count past target are rejected
--   with seat_full. The cap applies on every active state ('open',
--   'expanded', 'confirmed') so it also protects against the race where
--   two members hit "yes" the moment the count hits target-1 — only the
--   first one transitions the poll to 'confirmed', the second hits the
--   cap. (Idempotent re-votes — player already 'yes' on this date —
--   don't change the count and are still allowed.)
--
-- Behavior:
--   * cast_poll_vote and admin_cast_poll_vote both raise 'seat_full'
--     when a non-yes → yes upgrade would push live yes-count past
--     target_player_count.
--   * Same-vote re-submits ('yes' → 'yes' with a new comment) stay
--     allowed — the count is unchanged.
--   * 'no' / 'maybe' inserts and updates are unaffected (no cap on
--     non-yes responses).
--   * If admins need more capacity, they raise target_player_count via
--     edit_game_poll (migration 034 lets them edit confirmed polls)
--     and then proxy-vote.
--   * 'cancelled' / 'expired' are still rejected earlier with
--     'poll_locked' before this check ever runs.
--
-- Verify:
--   -- Setup: poll with target=7, 7 'yes' on a date, plus a 'maybe' from player X.
--   -- Player X tries to upgrade to 'yes':
--   SELECT cast_poll_vote('<date_id>', 'yes');         -- raises seat_full
--   SELECT cast_poll_vote('<date_id>', 'no');          -- ok (count goes down to 6)
--   SELECT admin_cast_poll_vote('<date_id>', '<player_y>', 'yes');  -- ok if seat freed
-- ============================================================

-- 1. cast_poll_vote — member self-RSVP, with seat-cap on yes upgrades --
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
  v_already_yes BOOLEAN;
  v_yes_count   INT;
BEGIN
  -- Take a row lock on the target date *first* so concurrent yes-votes
  -- on the same date serialize through the cap check below. Voters on
  -- different dates don't block each other (the lock is per-row and
  -- transactional, released on COMMIT/ROLLBACK). Without this the cap
  -- check has a small race window: two simultaneous yes-votes both
  -- read count=N and both INSERT, ending at N+2.
  PERFORM 1 FROM game_poll_dates WHERE id = p_date_id FOR UPDATE;

  SELECT p.* INTO v_poll
    FROM game_polls p
    JOIN game_poll_dates d ON d.poll_id = p.id
    WHERE d.id = p_date_id;

  IF v_poll.id IS NULL THEN
    RAISE EXCEPTION 'invalid_date_id';
  END IF;

  -- 'cancelled' / 'expired' remain blocked. 'confirmed' is still
  -- allowed so members can change their mind after the game is locked.
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
  --   * 'confirmed' → if expanded_at IS NULL the poll confirmed during
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

  -- Seat-cap enforcement on yes-upgrades. We only care about the case
  -- where this vote would *increase* the live yes-count for this date:
  -- a player who's already 'yes' re-submitting 'yes' is a no-op for
  -- the count. Concurrent yes-votes serialize through the FOR UPDATE
  -- lock on game_poll_dates taken at the top of this function, so the
  -- COUNT(*) read here is consistent with all earlier-committed votes.
  IF p_response = 'yes' THEN
    SELECT (response = 'yes') INTO v_already_yes
      FROM game_poll_votes
     WHERE date_id = p_date_id AND player_id = v_player_id
     LIMIT 1;

    IF NOT COALESCE(v_already_yes, FALSE) THEN
      SELECT COUNT(*) INTO v_yes_count
        FROM game_poll_votes
       WHERE date_id = p_date_id AND response = 'yes';
      IF v_yes_count >= v_poll.target_player_count THEN
        RAISE EXCEPTION 'seat_full';
      END IF;
    END IF;
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

-- 2. admin_cast_poll_vote — proxy on behalf, with seat-cap on yes ------
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
  v_already_yes   BOOLEAN;
  v_yes_count     INT;
BEGIN
  -- Same FOR UPDATE lock as cast_poll_vote — see notes there. Admin
  -- proxy votes share the cap with self-votes, so they go through the
  -- same serialization point.
  PERFORM 1 FROM game_poll_dates WHERE id = p_date_id FOR UPDATE;

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

  -- Same seat-cap logic as cast_poll_vote, scoped to the proxied
  -- player. ProxyVoteModal already enforces this client-side, but the
  -- server check is the source of truth and protects against direct
  -- RPC calls / client-side spoofing.
  IF p_response = 'yes' THEN
    SELECT (response = 'yes') INTO v_already_yes
      FROM game_poll_votes
     WHERE date_id = p_date_id AND player_id = p_voter_player_id
     LIMIT 1;

    IF NOT COALESCE(v_already_yes, FALSE) THEN
      SELECT COUNT(*) INTO v_yes_count
        FROM game_poll_votes
       WHERE date_id = p_date_id AND response = 'yes';
      IF v_yes_count >= v_poll.target_player_count THEN
        RAISE EXCEPTION 'seat_full';
      END IF;
    END IF;
  END IF;

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

-- ============================================================
-- DONE — Verify with the queries listed at the top of this file.
-- ============================================================
