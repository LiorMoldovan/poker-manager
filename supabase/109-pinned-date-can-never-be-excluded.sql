-- ============================================================
-- Migration 109: the pinned date can never be an excluded date
-- Run in Supabase SQL Editor after 108-browser-worker-claims-only-dispatchable-kinds.sql
-- (Idempotent — CREATE OR REPLACE only.)
--
-- Why: migration 106 made the funnel a server rule — with a date pinned,
--   every OTHER date raises 'date_not_picked'. That is correct, but it
--   assumes the pinned date is itself votable. If the pin sits on an
--   excluded date, `cast_poll_vote` refuses everything at once: the
--   pinned date as 'date_disabled' (it's excluded) and every other date
--   as 'date_not_picked' (it isn't the pin). Voting is frozen for the
--   whole group, members see the same "voting is closed" dead end that
--   106 set out to remove, and nothing in the UI explains it. Before 106
--   the rival dates still accepted votes server-side, so this state was
--   survivable; now it isn't.
--
--   `set_game_poll_date_disabled` already refuses to exclude the pinned
--   date ('date_is_pinned'). The inverse was never enforced, and two
--   paths could produce it:
--
--   1. `update_game_poll_meta` / `update_poll_target` re-evaluate the
--      "winning" date on every call and pick the max-yes date without
--      filtering `disabled_at`. So an admin editing ANY poll meta field
--      — note, location, target — on an open/expanded poll could silently
--      confirm onto a date they had deliberately excluded, as long as
--      that date still held the most yes votes. Realistic route: the
--      popular night loses its host, the admin releases the pin and
--      excludes that date to push everyone onto the other one, and the
--      next edit re-pins the excluded night. No client involvement, no
--      warning. The location field is exactly what the host-rotation
--      suggestion invites admins to edit.
--
--   2. `manual_close_game_poll` never checked `disabled_at`, so the 📌
--      action would accept an excluded date. `PollCard.tsx` hides the pin
--      chip on an excluded tile, so this is unreachable through the UI —
--      but a client-only guard on a server invariant is precisely the
--      pattern 106 was fixing elsewhere.
--
--   Live data when this was written: 16 dates excluded across 8 polls, so
--   exclusion is routine here; 0 polls currently pinned to an excluded
--   date, so nothing needs repairing.
--
-- Fix, defence in depth:
--   * Both auto-confirm RPCs only consider enabled dates.
--   * `manual_close_game_poll` rejects an excluded date ('date_disabled',
--     already mapped client-side to the "date is excluded" message).
--   * `cast_poll_vote` / `admin_cast_poll_vote` only enforce the funnel
--     while the pin is on a votable date, so even if some future path
--     recreates the state, voting degrades to "all dates open" instead of
--     "no dates open". A poll can never be frozen by this again.
--
-- Also fixed here: `update_poll_target` confirms a poll and lets the
--   announcement fire, but never stamped `confirmed_notified_date_id`, so
--   a later re-pin of that same date would clear the sentinel and
--   re-announce — the duplicate class migration 107 removed. It has no UI
--   call site today (exported through storage.ts, never called), so this
--   is closing a latent hole, not a live bug.
--
--   Deliberately NOT stamped in `update_game_poll_meta`: that path
--   pre-stamps the sentinels to SUPPRESS the announcement, so the poll is
--   "confirmed but never announced". Leaving the marker NULL there means a
--   later 📌 on the same date still announces it once — the message
--   members never got.
-- ============================================================

-- 1. manual_close_game_poll — refuse to pin an excluded date -----------
-- Body is migration 107's, plus the guard. The notification-sentinel
-- logic is unchanged.
CREATE OR REPLACE FUNCTION public.manual_close_game_poll(
  p_poll_id  UUID,
  p_date_id  UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
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

  -- Mirror of the 'date_is_pinned' guard in set_game_poll_date_disabled:
  -- the pin and the exclusion are mutually exclusive states, enforced
  -- from both directions.
  IF EXISTS (
    SELECT 1 FROM game_poll_dates
     WHERE id = p_date_id AND disabled_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'date_disabled';
  END IF;

  -- Bare column references in a SET expression read the OLD row, so
  -- `confirmed_notified_date_id` here is the date members were last
  -- told about. Only a genuine switch re-opens the notification gate.
  UPDATE game_polls
     SET status = 'confirmed',
         confirmed_date_id = p_date_id,
         confirmed_at = now(),
         confirmed_notifications_sent_at = CASE
           WHEN confirmed_notified_date_id IS DISTINCT FROM p_date_id
           THEN NULL ELSE confirmed_notifications_sent_at END,
         target_filled_notifications_sent_at = CASE
           WHEN confirmed_notified_date_id IS DISTINCT FROM p_date_id
           THEN NULL ELSE target_filled_notifications_sent_at END,
         confirmed_notified_date_id = p_date_id
   WHERE id = p_poll_id
     AND status IN ('open', 'expanded', 'confirmed')
     AND confirmed_game_id IS NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.manual_close_game_poll(UUID, UUID) TO authenticated;

-- 2. update_game_poll_meta — auto-confirm skips excluded dates ---------
CREATE OR REPLACE FUNCTION public.update_game_poll_meta(
  p_poll_id           UUID,
  p_target            INTEGER,
  p_expansion_delay   INTEGER,
  p_note              TEXT,
  p_default_location  TEXT,
  p_allow_maybe       BOOLEAN,
  p_maybe_hold_hours  INTEGER DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
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

  IF p_maybe_hold_hours IS NOT NULL AND p_maybe_hold_hours < 0 THEN
    RAISE EXCEPTION 'invalid_delay';
  END IF;

  PERFORM set_config('app.suppress_poll_notifications', 'true', true);

  UPDATE game_polls
     SET target_player_count   = p_target,
         expansion_delay_hours = p_expansion_delay,
         maybe_hold_hours      = COALESCE(p_maybe_hold_hours, maybe_hold_hours),
         note                  = NULLIF(p_note, ''),
         default_location      = NULLIF(p_default_location, ''),
         allow_maybe           = COALESCE(p_allow_maybe, allow_maybe)
   WHERE id = p_poll_id
     AND status IN ('open', 'expanded', 'confirmed');

  -- Excluded dates are not candidates. Without the join an edit could
  -- confirm onto a date the admin had deliberately taken off the table,
  -- which post-106 freezes voting outright.
  SELECT v.date_id, count(*) INTO v_winning_date, v_yes_cnt
    FROM game_poll_votes v
    JOIN game_poll_dates d ON d.id = v.date_id
    WHERE v.poll_id = p_poll_id
      AND v.response = 'yes'
      AND d.disabled_at IS NULL
    GROUP BY v.date_id
    ORDER BY count(*) DESC, v.date_id ASC
    LIMIT 1;

  IF v_winning_date IS NOT NULL AND v_yes_cnt >= p_target THEN
    UPDATE game_polls
       SET status = 'confirmed',
           confirmed_date_id = v_winning_date,
           confirmed_at = NOW()
     WHERE id = p_poll_id
       AND status IN ('open', 'expanded');

    UPDATE game_polls
       SET confirmed_notifications_sent_at =
             COALESCE(confirmed_notifications_sent_at, NOW()),
           target_filled_notifications_sent_at = CASE
             WHEN v_yes_cnt >= p_target
               THEN COALESCE(target_filled_notifications_sent_at, NOW())
             ELSE target_filled_notifications_sent_at
           END
     WHERE id = p_poll_id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_game_poll_meta(UUID, INTEGER, INTEGER, TEXT, TEXT, BOOLEAN, INTEGER) TO authenticated;

-- 3. update_poll_target — same filter, plus the 107 marker -------------
CREATE OR REPLACE FUNCTION public.update_poll_target(
  p_poll_id    UUID,
  p_new_target INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
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
  -- Excluded dates are not candidates (see update_game_poll_meta).
  SELECT v.date_id, count(*) INTO v_winning_date, v_yes_cnt
    FROM game_poll_votes v
    JOIN game_poll_dates d ON d.id = v.date_id
    WHERE v.poll_id = p_poll_id
      AND v.response = 'yes'
      AND d.disabled_at IS NULL
    GROUP BY v.date_id
    ORDER BY count(*) DESC, v.date_id ASC
    LIMIT 1;

  IF v_winning_date IS NOT NULL AND v_yes_cnt >= p_new_target THEN
    -- Unlike update_game_poll_meta this path lets the announcement fire,
    -- so record what members were told about (migration 107) — otherwise
    -- a later re-pin of the same date would announce it twice.
    UPDATE game_polls
       SET status = 'confirmed',
           confirmed_date_id = v_winning_date,
           confirmed_at = now(),
           confirmed_notified_date_id = v_winning_date
     WHERE id = p_poll_id
       AND status IN ('open', 'expanded');
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.update_poll_target(UUID, INTEGER) TO authenticated;

-- 4. cast_poll_vote — the funnel needs a votable pin -------------------
-- Body is migration 106's, with the funnel guard qualified. Everything
-- else (seat cap, permanent-maybe hold, tier gate) is untouched.
CREATE OR REPLACE FUNCTION public.cast_poll_vote(
  p_date_id   UUID,
  p_response  TEXT,
  p_comment   TEXT DEFAULT NULL
)
RETURNS SETOF game_polls
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
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

  -- Once a date is picked, it's the only votable date. Releasing the pin
  -- (release_game_poll_pin clears confirmed_date_id) re-opens all of
  -- them. Qualified on the pin being votable itself: a pin stranded on
  -- an excluded date must not refuse every date at once and freeze the
  -- poll — migration 109.
  IF v_poll.confirmed_date_id IS NOT NULL
     AND p_date_id <> v_poll.confirmed_date_id
     AND EXISTS (
       SELECT 1 FROM game_poll_dates
        WHERE id = v_poll.confirmed_date_id AND disabled_at IS NULL
     ) THEN
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

    -- Only an upgrade INTO 'yes' can overfill; a re-cast of an existing
    -- 'yes' leaves the count untouched.
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
$$;

GRANT EXECUTE ON FUNCTION public.cast_poll_vote(UUID, TEXT, TEXT) TO authenticated;

-- 5. admin_cast_poll_vote — same funnel qualification ------------------
CREATE OR REPLACE FUNCTION public.admin_cast_poll_vote(
  p_date_id          UUID,
  p_voter_player_id  UUID,
  p_response         TEXT,
  p_comment          TEXT DEFAULT NULL
)
RETURNS SETOF game_polls
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
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
     AND p_date_id <> v_poll.confirmed_date_id
     AND EXISTS (
       SELECT 1 FROM game_poll_dates
        WHERE id = v_poll.confirmed_date_id AND disabled_at IS NULL
     ) THEN
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
$$;

GRANT EXECUTE ON FUNCTION public.admin_cast_poll_vote(UUID, UUID, TEXT, TEXT) TO authenticated;

-- ============================================================
-- DONE — Verify with:
--   -- 1. Invariant holds across all polls (expect 0):
--   SELECT count(*) FROM game_polls p
--     JOIN game_poll_dates d ON d.id = p.confirmed_date_id
--    WHERE d.disabled_at IS NOT NULL;
--
--   -- 2. Behavioral sandbox (roll back at the end):
--   --    a. Exclude the max-yes date on an open poll, then call
--   --       update_game_poll_meta -> poll stays open, no pin on the
--   --       excluded date.
--   --    b. manual_close_game_poll on an excluded date -> 'date_disabled'.
--   --    c. Force confirmed_date_id onto an excluded date directly, then
--   --       cast_poll_vote on another date -> succeeds (no deadlock).
-- ============================================================
