-- ============================================================
-- Migration 101: Permanent "maybe" seat-hold (guest grace window)
-- Run after 100-global-stats-snapshots.sql. Idempotent.
--
-- WHY
-- Today a poll opens permanents-only, then flips to 'expanded' after
-- expansion_delay_hours so guests can vote too (migration 022/086). A
-- 'maybe' reserves NOTHING — only 'yes' counts toward the target, and
-- the auto_close_poll_on_vote trigger confirms + locks voting once
-- yes >= target.
--
-- New requirement: once the poll opens to guests, a PERMANENT player who
-- voted 'maybe' should keep his seat reserved for a configurable grace
-- window (default 48h, measured from expansion). During that window guests
-- may vote, but may NOT take a held seat. After the window expires the
-- held seat is released and guests can claim it.
--
-- DESIGN (confirmed with the user)
--   * Hold clock starts at expansion (expanded_at), not at the maybe vote.
--   * A held 'maybe' never auto-confirms the game — only real 'yes' does.
--     The hold purely blocks GUESTS from those slots until it expires.
--   * The hold blocks GUESTS only. Other permanents can still vote 'yes'
--     freely (a definite yes beats a tentative maybe).
--   * Only type = 'permanent' maybes reserve a seat (permanent_guest /
--     guest maybes do not).
--   * Window length is editable per group (settings.schedule_default_
--     maybe_hold_hours) and stored per poll (game_polls.maybe_hold_hours).
--
-- IMPLEMENTATION NOTE
-- Seat capping currently lives ONLY in the client + the auto-confirm lock
-- (migration 037's server cap was dropped when 086 rewrote cast_poll_vote).
-- To make a held seat actually block a guest we must reject the guest's
-- 'yes' in cast_poll_vote / admin_cast_poll_vote BEFORE it can trigger the
-- auto-confirm and steal the slot. We add a narrow, guest-only check
-- (raises 'seat_held') plus a FOR UPDATE race guard. We deliberately do
-- NOT re-introduce a broad permanent-side cap — that would silently change
-- vote behavior for every group beyond what was asked.
--
-- VERIFY: see the rolled-back DO blocks the agent ran against live data.
-- ============================================================

-- 1. Schema -------------------------------------------------------------
ALTER TABLE game_polls
  ADD COLUMN IF NOT EXISTS maybe_hold_hours INTEGER NOT NULL DEFAULT 48;

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS schedule_default_maybe_hold_hours INTEGER NOT NULL DEFAULT 48;

-- 2. create_game_poll — add p_maybe_hold_hours --------------------------
-- Adding a defaulted param creates a NEW overload rather than replacing
-- the 8-arg one, which would make 8-arg calls ambiguous (PGRST203). Drop
-- the old signature first, then define the 9-arg version. All callers go
-- through the 9-arg form (the client passes p_maybe_hold_hours).
DROP FUNCTION IF EXISTS public.create_game_poll(uuid, jsonb, integer, integer, text, boolean, text, text);

CREATE OR REPLACE FUNCTION public.create_game_poll(
  p_group_id        uuid,
  p_dates           jsonb,
  p_target          integer DEFAULT 8,
  p_expansion_delay integer DEFAULT 48,
  p_default_location text   DEFAULT NULL,
  p_allow_maybe     boolean DEFAULT true,
  p_note            text    DEFAULT NULL,
  p_source          text    DEFAULT 'admin',
  p_maybe_hold_hours integer DEFAULT 48
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_poll_id      UUID;
  v_date_count   INT;
  v_date         JSONB;
  v_source       TEXT := CASE WHEN p_source = 'auto' THEN 'auto' ELSE 'admin' END;
  v_creator_name TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM group_members
    WHERE group_id = p_group_id AND user_id = auth.uid() AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  v_date_count := jsonb_array_length(COALESCE(p_dates, '[]'::jsonb));
  IF v_date_count < 1 THEN
    RAISE EXCEPTION 'invalid_date_count';
  END IF;

  IF p_target < 2 THEN
    RAISE EXCEPTION 'invalid_target';
  END IF;

  SELECT COALESCE(NULLIF(gm.display_name, ''), pl.name)
    INTO v_creator_name
    FROM group_members gm
    LEFT JOIN players pl ON pl.id = gm.player_id
   WHERE gm.user_id = auth.uid() AND gm.group_id = p_group_id
   LIMIT 1;

  INSERT INTO game_polls (
    group_id, created_by, status, target_player_count,
    expansion_delay_hours, default_location, allow_maybe, note,
    created_source, created_by_name, maybe_hold_hours
  )
  VALUES (
    p_group_id, auth.uid(), 'open', p_target,
    p_expansion_delay, p_default_location, p_allow_maybe, p_note,
    v_source, CASE WHEN v_source = 'auto' THEN NULL ELSE v_creator_name END,
    GREATEST(0, COALESCE(p_maybe_hold_hours, 48))
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
$function$;

-- 3. cast_poll_vote — member self-RSVP, with permanent-maybe hold -------
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
  -- check below reads a count consistent with all earlier-committed
  -- votes. Per-row, transactional — voters on other dates don't block.
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

  -- Tier gate (migration 086, time-based): non-permanents blocked while the
  -- poll is still permanents-only (not expanded AND within the delay window).
  IF v_player_type <> 'permanent'
     AND v_poll.expanded_at IS NULL
     AND now() < v_poll.created_at + make_interval(hours => v_poll.expansion_delay_hours) THEN
    RAISE EXCEPTION 'tier_not_allowed';
  END IF;

  IF p_response NOT IN ('yes', 'no', 'maybe') THEN
    RAISE EXCEPTION 'invalid_response';
  END IF;

  IF p_response = 'maybe' AND NOT v_poll.allow_maybe THEN
    RAISE EXCEPTION 'maybe_not_allowed';
  END IF;

  -- Permanent-maybe seat hold (guest grace window). Only a GUEST acquiring
  -- a NEW 'yes' seat can be blocked: while the hold window is live
  -- (expanded_at set AND now < expanded_at + maybe_hold_hours), every
  -- permanent who voted 'maybe' on this date holds one seat against guests.
  -- A guest may claim a seat only if yes + held < target. Permanents are
  -- never blocked here (a definite yes beats a tentative maybe), and an
  -- idempotent re-vote ('yes' while already 'yes') is always allowed.
  IF p_response = 'yes' AND v_player_type <> 'permanent' THEN
    SELECT (response = 'yes') INTO v_already_yes
      FROM game_poll_votes
     WHERE date_id = p_date_id AND player_id = v_player_id
     LIMIT 1;

    IF NOT COALESCE(v_already_yes, FALSE) THEN
      v_holds_active := v_poll.expanded_at IS NOT NULL
                        AND now() < v_poll.expanded_at + make_interval(hours => v_poll.maybe_hold_hours);

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

-- 4. admin_cast_poll_vote — proxy on behalf, same hold rule -------------
-- The proxied player's tier decides the hold: an admin seating a GUEST
-- into a held slot is blocked the same way a guest self-vote is (the
-- admin can free the seat by changing the permanent's maybe, or wait for
-- the window to expire). Seating a permanent is never hold-blocked.
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

  -- Same guest-only hold check as cast_poll_vote, scoped to the proxied
  -- player's tier.
  IF p_response = 'yes' AND v_player_type <> 'permanent' THEN
    SELECT (response = 'yes') INTO v_already_yes
      FROM game_poll_votes
     WHERE date_id = p_date_id AND player_id = p_voter_player_id
     LIMIT 1;

    IF NOT COALESCE(v_already_yes, FALSE) THEN
      v_holds_active := v_poll.expanded_at IS NOT NULL
                        AND now() < v_poll.expanded_at + make_interval(hours => v_poll.maybe_hold_hours);

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

-- 5. Server auto-create cron — carry the group's hold-hours default -----
CREATE OR REPLACE FUNCTION public.fn_sweep_auto_create_polls()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tz            CONSTANT text := 'Asia/Jerusalem';
  v_now_local     timestamp;
  v_today         date;
  v_dow_today     int;
  v_g             RECORD;
  v_trigger_local timestamp;
  v_trigger_ts    timestamptz;
  v_owner         uuid;
  v_poll_id       uuid;
  v_days          int[];
  v_dates         jsonb;
  v_d             int;
  v_date          date;
  v_has_active    boolean;
BEGIN
  v_now_local := (now() AT TIME ZONE v_tz);
  v_today     := v_now_local::date;
  v_dow_today := extract(dow from v_today)::int;

  FOR v_g IN
    SELECT s.group_id, s.game_night_days,
           s.schedule_auto_create_day AS sday,
           s.schedule_auto_create_time AS stime,
           s.schedule_auto_created_at AS last_fired,
           s.schedule_default_time AS dtime,
           s.schedule_default_target AS dtarget,
           s.schedule_default_delay_hours AS ddelay,
           s.schedule_default_allow_maybe AS dmaybe,
           s.schedule_default_maybe_hold_hours AS dhold
    FROM settings s
    WHERE s.schedule_auto_create_enabled = true
    FOR UPDATE OF s
  LOOP
    DECLARE
      v_i  int := 0;
      cand timestamp := v_today::timestamp + (COALESCE(v_g.stime, '18:00'))::time;
    BEGIN
      LOOP
        EXIT WHEN extract(dow from cand)::int = v_g.sday AND cand <= v_now_local;
        cand := cand - interval '1 day';
        v_i := v_i + 1;
        EXIT WHEN v_i > 8;
      END LOOP;
      v_trigger_local := cand;
    END;
    v_trigger_ts := v_trigger_local AT TIME ZONE v_tz;

    IF v_g.last_fired IS NULL THEN
      UPDATE settings SET schedule_auto_created_at = now() WHERE group_id = v_g.group_id;
      CONTINUE;
    END IF;

    IF v_g.last_fired >= v_trigger_ts THEN
      CONTINUE;
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM game_polls p
      WHERE p.group_id = v_g.group_id
        AND (p.status IN ('open','expanded')
             OR (p.status = 'confirmed' AND p.confirmed_game_id IS NULL))
        AND EXISTS (
          SELECT 1 FROM game_poll_dates d
          WHERE d.poll_id = p.id AND d.proposed_date >= v_today
        )
    ) INTO v_has_active;

    IF v_has_active THEN
      UPDATE settings SET schedule_auto_created_at = now() WHERE group_id = v_g.group_id;
      CONTINUE;
    END IF;

    SELECT array_agg(DISTINCT e::int) INTO v_days
    FROM jsonb_array_elements_text(COALESCE(v_g.game_night_days, '[]'::jsonb)) e;

    v_dates := '[]'::jsonb;
    IF v_days IS NULL OR array_length(v_days, 1) IS NULL THEN
      v_dates := jsonb_build_array(to_char(v_today, 'YYYY-MM-DD'));
    ELSE
      FOREACH v_d IN ARRAY v_days LOOP
        v_date  := v_today + ((v_d - v_dow_today + 7) % 7);
        v_dates := v_dates || jsonb_build_array(to_char(v_date, 'YYYY-MM-DD'));
      END LOOP;
    END IF;

    SELECT created_by INTO v_owner FROM groups WHERE id = v_g.group_id;
    IF v_owner IS NULL THEN
      CONTINUE;
    END IF;

    INSERT INTO game_polls (
      group_id, created_by, status, target_player_count,
      expansion_delay_hours, default_location, allow_maybe, note,
      created_source, created_by_name, maybe_hold_hours
    ) VALUES (
      v_g.group_id, v_owner, 'open', COALESCE(v_g.dtarget, 7),
      COALESCE(v_g.ddelay, 48), NULL, COALESCE(v_g.dmaybe, true), NULL,
      'auto', NULL, COALESCE(v_g.dhold, 48)
    ) RETURNING id INTO v_poll_id;

    INSERT INTO game_poll_dates (poll_id, proposed_date, proposed_time, location)
    SELECT v_poll_id, val::date, NULLIF(v_g.dtime, '')::time, NULL
    FROM jsonb_array_elements_text(v_dates) val
    ORDER BY val::date;

    UPDATE settings SET schedule_auto_created_at = now() WHERE group_id = v_g.group_id;

    RAISE NOTICE 'auto-create: opened poll % for group %', v_poll_id, v_g.group_id;
  END LOOP;
END;
$function$;

-- ============================================================
-- DONE — verify with rolled-back DO blocks before relying on it.
-- ============================================================
