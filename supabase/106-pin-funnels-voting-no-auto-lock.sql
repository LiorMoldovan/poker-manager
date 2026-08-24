-- ============================================================
-- Migration 106: Picking a date funnels voting, it never freezes it
-- Run in Supabase SQL Editor after 105-rebuys-numeric-half-buyin.sql
-- (Idempotent — uses CREATE OR REPLACE.)
--
-- Why: The intended semantics of the 📌 pick action are "this is the
--   night — everyone still voting should vote on THIS date". Migration
--   058 broke that: it made `auto_close_poll_on_vote` stamp
--   `voting_locked_at = now()` the moment the picked date reached
--   `target_player_count`. Because `cast_poll_vote` treats
--   `voting_locked_at` as a global freeze, hitting the target silenced
--   every date INCLUDING the picked one — nobody could drop out, no
--   replacement could take a freed seat, and members got the message
--   "ההצבעה ננעלה ע״י מנהל הקבוצה" even though no admin had touched
--   the 🔒 toggle.
--
--   Observed on poll edb1d40b (group "Poker Night", target 8): admin
--   picked the Aug 29 date on Aug 23 13:25 IL at 6 yes; the trigger
--   locked voting an hour later when a proxy yes filled the target.
--   The admins then released + re-picked the date three times in 24h
--   purely to clear the lock the trigger kept re-applying.
--
-- Behavior after this migration:
--   * `auto_close_poll_on_vote` still auto-confirms an open/expanded
--     poll onto the date that crosses target, but no longer writes
--     `voting_locked_at`. The ONLY way voting_locked_at gets set is
--     the explicit admin 🔒 toggle (`set_poll_voting_lock`), which is
--     what the column was introduced for in migration 039.
--   * `cast_poll_vote` / `admin_cast_poll_vote` reject a vote on any
--     date OTHER than the picked one once a poll has a
--     `confirmed_date_id` ('date_not_picked'). Previously the server
--     allowed it and only the client suppressed it — and the client
--     only did so while the picked date was still below target, so a
--     full picked date silently re-opened its rivals.
--   * `cast_poll_vote` / `admin_cast_poll_vote` re-gain the hard seat
--     cap ('seat_full') that migration 037 introduced and the
--     101/104 seat-hold rewrite dropped for permanents. With the
--     auto-lock gone this is the only server-side barrier against a
--     9th yes on an 8-seat game, and it must apply to every tier.
--     Idempotent re-votes (already 'yes' → 'yes') stay allowed, and
--     'no' / 'maybe' are never capped — that's what frees a seat.
--   * The permanent-maybe seat hold ('seat_held', migration 104) is
--     unchanged and still only gates non-permanents.
--
-- Net effect on the picked date: 'yes' is refused only when the seats
--   are genuinely full, 'no' / 'maybe' always work, and a freed seat
--   is immediately claimable by the next person — no admin unlock
--   needed anywhere in the flow.
--
-- Existing rows: this migration does NOT clear `voting_locked_at` on
--   polls that the old trigger already locked. Those polls are all
--   archived or game-linked; an admin can still 🔓 any of them.
--
-- Client counterpart: `src/components/PollCard.tsx` widens the
--   fill-the-picked-date freeze from "confirmed AND below target" to
--   "a date is picked", matching the new server guard. Both sides
--   ship together.
-- ============================================================

-- 1. auto_close_poll_on_vote — auto-confirm only, never auto-lock ------
CREATE OR REPLACE FUNCTION auto_close_poll_on_vote()
RETURNS TRIGGER AS $$
DECLARE
  v_target         INT;
  v_yes_cnt        INT;
  v_date_disabled  BOOLEAN;
BEGIN
  IF NEW.response <> 'yes' THEN
    RETURN NEW;
  END IF;

  SELECT (disabled_at IS NOT NULL) INTO v_date_disabled
    FROM game_poll_dates WHERE id = NEW.date_id;

  IF v_date_disabled THEN
    RETURN NEW;
  END IF;

  SELECT target_player_count INTO v_target
    FROM game_polls WHERE id = NEW.poll_id;

  SELECT count(*) INTO v_yes_cnt
    FROM game_poll_votes
    WHERE date_id = NEW.date_id AND response = 'yes';

  IF v_yes_cnt >= v_target THEN
    -- Row-locked WHERE guard, race-safe between concurrent yes-casts.
    -- Filling the target is a *confirmation* signal, not a "stop
    -- voting" signal: the roster still needs to churn (drop-outs and
    -- their replacements) right up to game night.
    UPDATE game_polls
       SET status = 'confirmed',
           confirmed_date_id = NEW.date_id,
           confirmed_at = now()
     WHERE id = NEW.poll_id
       AND status IN ('open', 'expanded');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

-- 2. cast_poll_vote — funnel to the picked date + hard seat cap --------
CREATE OR REPLACE FUNCTION cast_poll_vote(
  p_date_id   UUID,
  p_response  TEXT,
  p_comment   TEXT DEFAULT NULL
)
RETURNS SETOF game_polls AS $$
DECLARE
  v_poll          game_polls%ROWTYPE;
  v_player_id     UUID;
  v_player_type   TEXT;
  v_date_disabled BOOLEAN;
  v_already_yes   BOOLEAN;
  v_yes_count     INT;
  v_hold_count    INT;
  v_holds_active  BOOLEAN;
BEGIN
  PERFORM 1 FROM game_poll_dates WHERE id = p_date_id FOR UPDATE;

  SELECT p.* INTO v_poll
    FROM game_polls p
    JOIN game_poll_dates d ON d.poll_id = p.id
    WHERE d.id = p_date_id;

  IF v_poll.id IS NULL THEN
    RAISE EXCEPTION 'invalid_date_id';
  END IF;

  SELECT (disabled_at IS NOT NULL) INTO v_date_disabled
    FROM game_poll_dates WHERE id = p_date_id;

  IF v_date_disabled THEN
    RAISE EXCEPTION 'date_disabled';
  END IF;

  IF v_poll.status NOT IN ('open', 'expanded', 'confirmed') THEN
    RAISE EXCEPTION 'poll_locked';
  END IF;

  IF v_poll.voting_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'voting_locked';
  END IF;

  -- Once a date is picked, it's the only votable date. Releasing the
  -- pin (release_game_poll_pin clears confirmed_date_id) re-opens all
  -- of them.
  IF v_poll.confirmed_date_id IS NOT NULL
     AND p_date_id <> v_poll.confirmed_date_id THEN
    RAISE EXCEPTION 'date_not_picked';
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

  IF v_player_type <> 'permanent'
     AND v_poll.expanded_at IS NULL
     AND now() < v_poll.created_at
                 + make_interval(hours => v_poll.expansion_delay_hours + v_poll.maybe_hold_hours) THEN
    RAISE EXCEPTION 'tier_not_allowed';
  END IF;

  IF p_response NOT IN ('yes', 'no', 'maybe') THEN
    RAISE EXCEPTION 'invalid_response';
  END IF;

  IF p_response = 'maybe' AND NOT v_poll.allow_maybe THEN
    RAISE EXCEPTION 'maybe_not_allowed';
  END IF;

  IF p_response = 'yes' THEN
    SELECT (response = 'yes') INTO v_already_yes
      FROM game_poll_votes
     WHERE date_id = p_date_id AND player_id = v_player_id
     LIMIT 1;

    -- Only an upgrade INTO 'yes' can overfill; a re-cast of an
    -- existing 'yes' leaves the count untouched.
    IF NOT COALESCE(v_already_yes, FALSE) THEN
      SELECT count(*) INTO v_yes_count
        FROM game_poll_votes
       WHERE date_id = p_date_id AND response = 'yes';

      IF v_yes_count >= v_poll.target_player_count THEN
        RAISE EXCEPTION 'seat_full';
      END IF;

      -- Permanent-maybe seat hold (104): a permanent who answered
      -- 'maybe' keeps a seat reserved against guests until the hold
      -- window closes. Permanents are never blocked by holds.
      IF v_player_type <> 'permanent' THEN
        v_holds_active := now() < v_poll.created_at
                          + make_interval(hours => v_poll.expansion_delay_hours + v_poll.maybe_hold_hours);

        IF v_holds_active THEN
          SELECT
            count(*) FILTER (WHERE gpv.response = 'yes'),
            count(*) FILTER (WHERE gpv.response = 'maybe' AND pl.type = 'permanent')
            INTO v_yes_count, v_hold_count
          FROM game_poll_votes gpv
          JOIN players pl ON pl.id = gpv.player_id
          WHERE gpv.date_id = p_date_id
            AND gpv.player_id <> v_player_id;

          IF v_yes_count + v_hold_count >= v_poll.target_player_count THEN
            RAISE EXCEPTION 'seat_held';
          END IF;
        END IF;
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

GRANT EXECUTE ON FUNCTION cast_poll_vote(UUID, TEXT, TEXT) TO authenticated;

-- 3. admin_cast_poll_vote — same two guards on the proxy path ----------
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
  v_player_type   TEXT;
  v_date_disabled BOOLEAN;
  v_already_yes   BOOLEAN;
  v_yes_count     INT;
  v_hold_count    INT;
  v_holds_active  BOOLEAN;
BEGIN
  PERFORM 1 FROM game_poll_dates WHERE id = p_date_id FOR UPDATE;

  SELECT p.* INTO v_poll
    FROM game_polls p
    JOIN game_poll_dates d ON d.poll_id = p.id
   WHERE d.id = p_date_id;

  IF v_poll.id IS NULL THEN
    RAISE EXCEPTION 'invalid_date_id';
  END IF;

  SELECT (disabled_at IS NOT NULL) INTO v_date_disabled
    FROM game_poll_dates WHERE id = p_date_id;

  IF v_date_disabled THEN
    RAISE EXCEPTION 'date_disabled';
  END IF;

  IF v_poll.status NOT IN ('open', 'expanded', 'confirmed') THEN
    RAISE EXCEPTION 'poll_locked';
  END IF;

  IF v_poll.voting_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'voting_locked';
  END IF;

  IF v_poll.confirmed_date_id IS NOT NULL
     AND p_date_id <> v_poll.confirmed_date_id THEN
    RAISE EXCEPTION 'date_not_picked';
  END IF;

  IF NOT is_schedule_admin(v_poll.group_id) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  IF p_response NOT IN ('yes', 'no', 'maybe') THEN
    RAISE EXCEPTION 'invalid_response';
  END IF;

  SELECT group_id, type INTO v_player_group, v_player_type
    FROM players WHERE id = p_voter_player_id;
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

  IF p_response = 'yes' THEN
    SELECT (response = 'yes') INTO v_already_yes
      FROM game_poll_votes
     WHERE date_id = p_date_id AND player_id = p_voter_player_id
     LIMIT 1;

    IF NOT COALESCE(v_already_yes, FALSE) THEN
      SELECT count(*) INTO v_yes_count
        FROM game_poll_votes
       WHERE date_id = p_date_id AND response = 'yes';

      IF v_yes_count >= v_poll.target_player_count THEN
        RAISE EXCEPTION 'seat_full';
      END IF;

      IF v_player_type <> 'permanent' THEN
        v_holds_active := now() < v_poll.created_at
                          + make_interval(hours => v_poll.expansion_delay_hours + v_poll.maybe_hold_hours);

        IF v_holds_active THEN
          SELECT
            count(*) FILTER (WHERE gpv.response = 'yes'),
            count(*) FILTER (WHERE gpv.response = 'maybe' AND pl.type = 'permanent')
            INTO v_yes_count, v_hold_count
          FROM game_poll_votes gpv
          JOIN players pl ON pl.id = gpv.player_id
          WHERE gpv.date_id = p_date_id
            AND gpv.player_id <> p_voter_player_id;

          IF v_yes_count + v_hold_count >= v_poll.target_player_count THEN
            RAISE EXCEPTION 'seat_held';
          END IF;
        END IF;
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

GRANT EXECUTE ON FUNCTION admin_cast_poll_vote(UUID, UUID, TEXT, TEXT) TO authenticated;

-- ============================================================
-- DONE — Verify with:
--   -- 1. The trigger no longer references the lock column:
--   SELECT position('voting_locked_at' in prosrc) = 0 AS lock_removed
--     FROM pg_proc WHERE proname = 'auto_close_poll_on_vote';
--
--   -- 2. Both vote RPCs carry the two new guards:
--   SELECT proname,
--          position('date_not_picked' in prosrc) > 0 AS funnels,
--          position('seat_full' in prosrc) > 0 AS caps
--     FROM pg_proc
--    WHERE proname IN ('cast_poll_vote', 'admin_cast_poll_vote');
--
--   -- 3. Behavioral sandbox (roll back at the end):
--   --    a. Picked date at target-1, cast yes as a real user →
--   --       succeeds, voting_locked_at stays NULL.
--   --    b. Same date now at target, another user casts yes →
--   --       'seat_full'.
--   --    c. A player who is 'yes' casts 'no' → succeeds (seat freed).
--   --    d. The user from (b) retries yes → succeeds.
--   --    e. Any user votes on a NON-picked date → 'date_not_picked'.
-- ============================================================
