-- ============================================================
-- Migration 104: Maybe seat-hold v2 — gate the guest invite, re-clock the hold
-- Run after 103-cleanup-duplicate-auto-poll-jun14.sql. Idempotent
-- (CREATE OR REPLACE only — no DROP, no data DML).
--
-- WHY
-- Migration 101 reserved a seat for a permanent's 'maybe' but did three
-- things the user wants changed:
--   1. It ALWAYS expanded the poll to guests at created_at + expansion_delay,
--      even when every remaining seat was held by a 'maybe' (so guests were
--      invited to a poll where they could not actually take a seat).
--   2. It surfaced a guest-facing "reserved for regulars" line (handled in the
--      client; not here).
--   3. The hold clock ran from expanded_at, so a poll we now intentionally
--      DON'T expand (all seats held) would never release its hold.
--
-- CONFIRMED MODEL
-- Per enabled date: free_for_guests = target - total_yes - pending_permanent_maybes.
-- A permanent 'maybe' reserves one seat while now < cap, where
--   cap = created_at + (expansion_delay_hours + maybe_hold_hours).
--   * Open to guests (stamp expanded_at / flip to 'expanded') once the
--     expansion delay has elapsed AND at least one enabled date has
--     free_for_guests > 0. Re-evaluated on every sweep + after each vote, so a
--     'maybe' -> 'no' (or the cap passing) that frees a seat triggers opening.
--   * While open, a guest 'yes' is allowed only up to free_for_guests (the
--     existing 'seat_held' check, re-clocked to the cap). Each held seat
--     releases at cap.
--   * Permanents are never blocked by the hold. maybe_hold_hours = 0 behaves
--     like no hold (cap == expansion-delay moment).
--
-- Examples (target 7):
--   4 yes + 1 maybe -> free 2 -> open now, cap guests at 2, maybe held to cap.
--   6 yes + 1 maybe -> free 0 -> do NOT invite guests; open when the maybe
--                       resolves to 'no' or cap passes (free becomes 1).
--
-- WHAT THIS MIGRATION CHANGES (all via CREATE OR REPLACE)
--   * cast_poll_vote / admin_cast_poll_vote:
--       - tier gate window widened from expansion_delay_hours to
--         (expansion_delay_hours + maybe_hold_hours) so guests are not let in
--         during the hold window before expanded_at is stamped.
--       - seat_held hold clock re-based from expanded_at to
--         created_at + (expansion_delay_hours + maybe_hold_hours).
--   * expand_game_poll: only stamps expanded_at when an enabled date still has
--     a free guest seat (target - yes - active permanent-maybe holds > 0).
--
-- VERIFY: see the rolled-back, role-switched DO blocks the agent ran.
-- ============================================================

-- 1. cast_poll_vote — member self-RSVP -------------------------------------
CREATE OR REPLACE FUNCTION public.cast_poll_vote(
  p_date_id  uuid,
  p_response text,
  p_comment  text DEFAULT NULL
)
RETURNS SETOF game_polls
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
  -- Serialize concurrent yes-votes on the same date so the seat / hold
  -- check below reads a count consistent with all earlier-committed votes.
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

  -- Tier gate (time-based, migration 086/104). Non-permanents are blocked
  -- while the poll has not yet opened to guests (expanded_at IS NULL) AND we
  -- are still inside the permanents-only window. The window now runs to the
  -- cap (expansion_delay + maybe_hold) so a delayed-because-all-seats-held
  -- poll doesn't let guests in early via the bare expansion-delay clock.
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

  -- Permanent-maybe seat hold (guest cap). A GUEST acquiring a NEW 'yes' seat
  -- is blocked while the hold window is live (now < cap) if yes + held seats
  -- already meet target. Permanents are never blocked; an idempotent re-vote
  -- ('yes' while already 'yes') is always allowed.
  IF p_response = 'yes' AND v_player_type <> 'permanent' THEN
    SELECT (response = 'yes') INTO v_already_yes
      FROM game_poll_votes
     WHERE date_id = p_date_id AND player_id = v_player_id
     LIMIT 1;

    IF NOT COALESCE(v_already_yes, FALSE) THEN
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
$function$;

-- 2. admin_cast_poll_vote — proxy on behalf, same hold rule ----------------
CREATE OR REPLACE FUNCTION public.admin_cast_poll_vote(
  p_date_id         uuid,
  p_voter_player_id uuid,
  p_response        text,
  p_comment         text DEFAULT NULL
)
RETURNS SETOF game_polls
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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

  -- Same guest-only hold cap as cast_poll_vote, scoped to the proxied
  -- player's tier and re-clocked to the cap.
  IF p_response = 'yes' AND v_player_type <> 'permanent' THEN
    SELECT (response = 'yes') INTO v_already_yes
      FROM game_poll_votes
     WHERE date_id = p_date_id AND player_id = p_voter_player_id
     LIMIT 1;

    IF NOT COALESCE(v_already_yes, FALSE) THEN
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
$function$;

-- 3. expand_game_poll — only open to guests when a seat is genuinely free ---
-- Adds a free-seat gate to the existing time-gated UPDATE (migration 086).
-- For each enabled date: target - yes - active-permanent-maybe-holds. The
-- maybe subtraction only counts while now < cap (after the cap the holds have
-- released). The poll opens as soon as ANY enabled date has a free seat.
CREATE OR REPLACE FUNCTION public.expand_game_poll(p_poll_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_group_id UUID;
BEGIN
  SELECT group_id INTO v_group_id FROM game_polls WHERE id = p_poll_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'invalid_poll';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM group_members
    WHERE group_id = v_group_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not_member';
  END IF;

  UPDATE game_polls gp
     SET expanded_at = now(),
         status = CASE WHEN status = 'open' THEN 'expanded' ELSE status END
   WHERE gp.id = p_poll_id
     AND gp.expanded_at IS NULL
     AND gp.status IN ('open', 'confirmed')
     AND now() - gp.created_at >= make_interval(hours => gp.expansion_delay_hours)
     AND EXISTS (
       SELECT 1
         FROM game_poll_dates d
        WHERE d.poll_id = gp.id
          AND d.disabled_at IS NULL
          AND gp.target_player_count
              - (SELECT count(*) FROM game_poll_votes v
                  WHERE v.date_id = d.id AND v.response = 'yes')
              - CASE WHEN now() < gp.created_at
                                  + make_interval(hours => gp.expansion_delay_hours + gp.maybe_hold_hours)
                     THEN (SELECT count(*) FROM game_poll_votes v
                            JOIN players pl ON pl.id = v.player_id
                            WHERE v.date_id = d.id
                              AND v.response = 'maybe'
                              AND pl.type = 'permanent')
                     ELSE 0
                END
              > 0
     );
END;
$function$;

-- ============================================================
-- DONE — verify with rolled-back, role-switched DO blocks before relying on it.
-- ============================================================
