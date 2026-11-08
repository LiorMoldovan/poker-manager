-- ============================================================
-- Migration 147: Smart Waitlist & Permanent Player Priority
-- ============================================================
-- 1. When an admin explicitly chooses 'waitlist' (via admin_cast_poll_vote),
--    NEVER auto-upgrade to 'yes'. Always respect the admin's explicit choice.
-- 2. Non-permanent players (guests and permanent guests) are no longer
--    completely blocked during the exclusive permanent window.
--    Instead, if an guest votes 'yes' (or an admin votes 'yes' for them),
--    they are placed on the 'waitlist' if the remaining open seats
--    are needed to guarantee spots for all unvoted permanent players
--    and permanent 'maybe' voters.
--    Only if open seats > (unvoted permanent players + permanent maybe voters)
--    can an guest take a seat as 'yes'.
-- 3. In fn_promote_waitlist_for_date: unvoted permanent players hold seats
--    during the hold window, preventing waitlisted guests from being promoted
--    ahead of unvoted permanent players until the window elapses or seats open.
-- 4. In fn_cleanup_and_promote_on_vote_change: trigger runs on INSERT of
--    response 'no' so releasing an unvoted seat immediately promotes the waitlist.
-- ============================================================

-- ── 1. Update fn_promote_waitlist_for_date ──

CREATE OR REPLACE FUNCTION public.fn_promote_waitlist_for_date(
  p_date_id UUID
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_poll                game_polls%ROWTYPE;
  v_proposed_date       DATE;
  v_proposed_time       TEXT;
  v_location            TEXT;
  v_disabled_at         TIMESTAMPTZ;
  v_yes_count           INT;
  v_hold_count          INT;
  v_unvoted_perm_count  INT;
  v_holds_active        BOOLEAN;
  v_promoted_cnt        INT := 0;
  v_cand                RECORD;
  v_dow_he              TEXT;
  v_date_str            TEXT;
  v_when_str            TEXT;
  v_loc_str             TEXT;
  v_push_title          TEXT;
  v_push_body           TEXT;
  v_email_subj          TEXT;
  v_email_body          TEXT;
  v_link                TEXT;
BEGIN
  IF p_date_id IS NULL THEN
    RETURN 0;
  END IF;

  -- Serialize seat checks on this date
  PERFORM 1 FROM game_poll_dates WHERE id = p_date_id FOR UPDATE;

  SELECT p.* INTO v_poll
    FROM game_polls p
    JOIN game_poll_dates d ON d.poll_id = p.id
   WHERE d.id = p_date_id;

  IF v_poll.id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT proposed_date, proposed_time, location, disabled_at
    INTO v_proposed_date, v_proposed_time, v_location, v_disabled_at
    FROM game_poll_dates
   WHERE id = p_date_id;

  IF v_disabled_at IS NOT NULL THEN
    RETURN 0;
  END IF;

  IF v_poll.status NOT IN ('open', 'expanded', 'confirmed')
     OR v_poll.voting_locked_at IS NOT NULL
     OR v_poll.confirmed_game_id IS NOT NULL THEN
    RETURN 0;
  END IF;

  -- If poll is pinned to another enabled date, do not promote on unpinned dates
  IF v_poll.confirmed_date_id IS NOT NULL
     AND p_date_id <> v_poll.confirmed_date_id
     AND EXISTS (
       SELECT 1 FROM game_poll_dates
        WHERE id = v_poll.confirmed_date_id AND disabled_at IS NULL
     ) THEN
    RETURN 0;
  END IF;

  FOR v_cand IN
    SELECT v.id, v.player_id, pl.name AS player_name, pl.type AS player_type
      FROM game_poll_votes v
      JOIN players pl ON pl.id = v.player_id
     WHERE v.date_id = p_date_id
       AND v.response = 'waitlist'
     ORDER BY v.voted_at ASC, v.id ASC
  LOOP
    -- Refresh poll row in case an earlier iteration confirmed the poll
    SELECT * INTO v_poll FROM game_polls WHERE id = v_poll.id;

    IF v_poll.status NOT IN ('open', 'expanded', 'confirmed')
       OR v_poll.voting_locked_at IS NOT NULL
       OR v_poll.confirmed_game_id IS NOT NULL THEN
      EXIT;
    END IF;

    IF v_poll.confirmed_date_id IS NOT NULL
       AND p_date_id <> v_poll.confirmed_date_id
       AND EXISTS (
         SELECT 1 FROM game_poll_dates
          WHERE id = v_poll.confirmed_date_id AND disabled_at IS NULL
       ) THEN
      EXIT;
    END IF;

    SELECT count(*) INTO v_yes_count
      FROM game_poll_votes
     WHERE date_id = p_date_id AND response = 'yes';

    IF v_yes_count >= v_poll.target_player_count THEN
      EXIT;
    END IF;

    IF v_cand.player_type <> 'permanent' THEN
      v_holds_active := (v_poll.expanded_at IS NULL AND now() < v_poll.created_at
                        + make_interval(hours => v_poll.expansion_delay_hours + v_poll.maybe_hold_hours));
      IF v_holds_active THEN
        SELECT count(*) INTO v_hold_count
          FROM game_poll_votes gpv
          JOIN players pl ON pl.id = gpv.player_id
         WHERE gpv.date_id = p_date_id
           AND gpv.response = 'maybe'
           AND pl.type = 'permanent';

        SELECT count(*) INTO v_unvoted_perm_count
          FROM players pl
         WHERE pl.group_id = v_poll.group_id
           AND pl.type = 'permanent'
           AND NOT EXISTS (
             SELECT 1 FROM game_poll_votes gpv
              WHERE gpv.date_id = p_date_id
                AND gpv.player_id = pl.id
           );

        -- Respect pure FIFO & permanent reservations: if the #1 waitlisted player is an guest
        -- and the remaining seat(s) are held by permanent 'maybe' voters OR unvoted permanent players,
        -- wait until they vote / hold releases or another 'yes' voter drops.
        IF v_yes_count + v_hold_count + v_unvoted_perm_count >= v_poll.target_player_count THEN
          EXIT;
        END IF;
      END IF;
    END IF;

    -- Promote from waitlist -> yes
    UPDATE game_poll_votes
       SET response = 'yes',
           voted_at = now()
     WHERE id = v_cand.id;

    v_promoted_cnt := v_promoted_cnt + 1;

    -- Build Hebrew date/time copy for personal notification
    v_dow_he := CASE extract(dow FROM v_proposed_date)::int
      WHEN 0 THEN 'יום ראשון'
      WHEN 1 THEN 'יום שני'
      WHEN 2 THEN 'יום שלישי'
      WHEN 3 THEN 'יום רביעי'
      WHEN 4 THEN 'יום חמישי'
      WHEN 5 THEN 'יום שישי'
      WHEN 6 THEN 'יום שבת'
      ELSE ''
    END;

    v_date_str := to_char(v_proposed_date, 'DD/MM');
    v_when_str := v_date_str || ' (' || v_dow_he || ')';
    IF v_proposed_time IS NOT NULL AND length(trim(v_proposed_time)) > 0 THEN
      v_when_str := v_when_str || ' ב-' || substring(v_proposed_time FROM 1 FOR 5);
    END IF;

    v_loc_str := COALESCE(v_location, v_poll.default_location);

    v_push_title := '🎉 נכנסת למשחק מהמתנה!';
    v_push_body := 'התפנה מקום ב-' || v_when_str || ' — שובצת אוטומטית בהרכב!';

    v_email_subj := '🎉 התפנה מקום — נכנסת להרכב ב-' || v_when_str;
    v_email_body := '<p>היי ' || v_cand.player_name || ',</p>'
      || '<p>שחקן ביטל את הגעתו והתפנה מקום ב-<strong>' || v_when_str || '</strong>.</p>'
      || '<p>מכיוון שהיית ראשון ברשימת ההמתנה, <strong>שובצת אוטומטית בהרכב המשחק!</strong></p>'
      || CASE WHEN v_loc_str IS NOT NULL AND length(trim(v_loc_str)) > 0
              THEN '<p>📍 מיקום: ' || v_loc_str || '</p>' ELSE '' END
      || '<p>אם חל שינוי בתוכניות שלך, אנא עדכן בהקדם בהצבעה כדי לפנות מקום לבא בתור.</p>';

    v_link := '/schedule?pollId=' || v_poll.id::text;

    PERFORM enqueue_notification(
      'waitlist_promoted',
      v_poll.group_id,
      v_poll.id,
      jsonb_build_object(
        'recipient_player_id', v_cand.player_id,
        'date_id',             p_date_id,
        'url',                 v_link,
        'push_title',          v_push_title,
        'push_body',           v_push_body,
        'email_subject',       v_email_subj,
        'email_body',          v_email_body
      )
    );
  END LOOP;

  RETURN v_promoted_cnt;
END;
$function$;


-- ── 2. Update fn_cleanup_and_promote_on_vote_change ──

CREATE OR REPLACE FUNCTION public.fn_cleanup_and_promote_on_vote_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM fn_cleanup_player_poll_preference(OLD.poll_id, OLD.player_id);
    IF OLD.response IN ('yes', 'maybe') THEN
      PERFORM fn_promote_waitlist_for_date(OLD.date_id);
    END IF;
    RETURN OLD;
  END IF;

  -- INSERT or UPDATE
  PERFORM fn_cleanup_player_poll_preference(NEW.poll_id, NEW.player_id);

  IF TG_OP = 'INSERT' THEN
    -- If a permanent player voted 'no', it released an unvoted reservation on this date!
    PERFORM fn_promote_waitlist_for_date(NEW.date_id);
  ELSIF TG_OP = 'UPDATE'
     AND (
       (OLD.response IN ('yes', 'maybe') AND NEW.response <> 'yes' AND OLD.response IS DISTINCT FROM NEW.response)
       OR (OLD.response = 'yes' AND NEW.response = 'maybe')
     ) THEN
    PERFORM fn_promote_waitlist_for_date(OLD.date_id);
  END IF;

  RETURN NEW;
END;
$function$;


-- ── 3. Update cast_poll_vote (Self-Voting) ──

CREATE OR REPLACE FUNCTION public.cast_poll_vote(
  p_date_id uuid,
  p_response text,
  p_comment text DEFAULT NULL::text
)
RETURNS SETOF game_polls
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_poll                game_polls%ROWTYPE;
  v_player_id           UUID;
  v_player_type         TEXT;
  v_date_disabled       BOOLEAN;
  v_already_yes         BOOLEAN;
  v_yes_count           INT;
  v_hold_count          INT;
  v_unvoted_perm_count  INT;
  v_holds_active        BOOLEAN;
  v_effective_response  TEXT;
  v_seat_blocked        BOOLEAN;
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

  IF p_response NOT IN ('yes', 'no', 'maybe', 'waitlist') THEN
    RAISE EXCEPTION 'invalid_response';
  END IF;

  IF p_response = 'maybe' AND NOT v_poll.allow_maybe THEN
    RAISE EXCEPTION 'maybe_not_allowed';
  END IF;

  v_effective_response := p_response;

  SELECT (response = 'yes') INTO v_already_yes
    FROM game_poll_votes
   WHERE date_id = p_date_id AND player_id = v_player_id
   LIMIT 1;

  IF p_response = 'yes' THEN
    IF NOT COALESCE(v_already_yes, FALSE) THEN
      SELECT count(*) INTO v_yes_count
        FROM game_poll_votes
       WHERE date_id = p_date_id AND response = 'yes';

      IF v_yes_count >= v_poll.target_player_count THEN
        -- If table is genuinely full, place on waitlist instead of hard error
        v_effective_response := 'waitlist';
      ELSIF v_player_type <> 'permanent' THEN
        v_holds_active := (v_poll.expanded_at IS NULL AND now() < v_poll.created_at
                          + make_interval(hours => v_poll.expansion_delay_hours + v_poll.maybe_hold_hours));

        IF v_holds_active THEN
          SELECT
            count(*) FILTER (WHERE gpv.response = 'yes'),
            count(*) FILTER (WHERE gpv.response = 'maybe' AND pl.type = 'permanent')
            INTO v_yes_count, v_hold_count
          FROM game_poll_votes gpv
          JOIN players pl ON pl.id = gpv.player_id
          WHERE gpv.date_id = p_date_id
            AND gpv.player_id <> v_player_id;

          SELECT count(*) INTO v_unvoted_perm_count
            FROM players pl
           WHERE pl.group_id = v_poll.group_id
             AND pl.type = 'permanent'
             AND NOT EXISTS (
               SELECT 1 FROM game_poll_votes gpv
                WHERE gpv.date_id = p_date_id
                  AND gpv.player_id = pl.id
             );

          -- If remaining seats are needed to protect unvoted permanent players + permanent maybe voters,
          -- route guest to waitlist:
          IF v_yes_count + v_hold_count + v_unvoted_perm_count >= v_poll.target_player_count THEN
            v_effective_response := 'waitlist';
          END IF;
        END IF;
      END IF;
    END IF;
  ELSIF p_response = 'waitlist' THEN
    SELECT count(*) INTO v_yes_count
      FROM game_poll_votes
     WHERE date_id = p_date_id
       AND response = 'yes'
       AND player_id <> v_player_id;

    v_seat_blocked := (v_yes_count >= v_poll.target_player_count)
      OR (
        COALESCE(v_already_yes, FALSE)
        AND EXISTS (
          SELECT 1 FROM game_poll_votes
           WHERE date_id = p_date_id
             AND response = 'waitlist'
             AND player_id <> v_player_id
        )
      );

    IF NOT v_seat_blocked AND v_player_type <> 'permanent' THEN
      v_holds_active := (v_poll.expanded_at IS NULL AND now() < v_poll.created_at
                        + make_interval(hours => v_poll.expansion_delay_hours + v_poll.maybe_hold_hours));
      IF v_holds_active THEN
        SELECT
          count(*) FILTER (WHERE gpv.response = 'yes'),
          count(*) FILTER (WHERE gpv.response = 'maybe' AND pl.type = 'permanent')
          INTO v_yes_count, v_hold_count
        FROM game_poll_votes gpv
        JOIN players pl ON pl.id = gpv.player_id
        WHERE gpv.date_id = p_date_id
          AND gpv.player_id <> v_player_id;

        SELECT count(*) INTO v_unvoted_perm_count
          FROM players pl
         WHERE pl.group_id = v_poll.group_id
           AND pl.type = 'permanent'
           AND NOT EXISTS (
             SELECT 1 FROM game_poll_votes gpv
              WHERE gpv.date_id = p_date_id
                AND gpv.player_id = pl.id
           );

        IF v_yes_count + v_hold_count + v_unvoted_perm_count >= v_poll.target_player_count THEN
          v_seat_blocked := TRUE;
        END IF;
      END IF;
    END IF;

    -- If a seat actually opened right as the player clicked waitlist, seat them immediately!
    IF NOT v_seat_blocked THEN
      v_effective_response := 'yes';
    END IF;
  END IF;

  INSERT INTO game_poll_votes (
    poll_id, date_id, player_id, user_id, response, comment, voted_at
  )
  VALUES (
    v_poll.id, p_date_id, v_player_id, auth.uid(),
    v_effective_response, p_comment, now()
  )
  ON CONFLICT (date_id, player_id) DO UPDATE
    SET response = EXCLUDED.response,
        comment  = EXCLUDED.comment,
        voted_at = CASE
          -- Preserve FIFO queue timestamp when editing comment on an existing waitlist row
          WHEN game_poll_votes.response = 'waitlist' AND EXCLUDED.response = 'waitlist'
            THEN game_poll_votes.voted_at
          ELSE now()
        END;

  RETURN QUERY
    SELECT * FROM game_polls WHERE id = v_poll.id;
END;
$function$;


-- ── 4. Update admin_cast_poll_vote (Proxy Voting) ──

CREATE OR REPLACE FUNCTION public.admin_cast_poll_vote(
  p_date_id uuid,
  p_voter_player_id uuid,
  p_response text,
  p_comment text DEFAULT NULL::text
)
RETURNS SETOF game_polls
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_poll                game_polls%ROWTYPE;
  v_player_group        UUID;
  v_player_user         UUID;
  v_player_type         TEXT;
  v_date_disabled       BOOLEAN;
  v_already_yes         BOOLEAN;
  v_yes_count           INT;
  v_hold_count          INT;
  v_unvoted_perm_count  INT;
  v_holds_active        BOOLEAN;
  v_effective_response  TEXT;
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

  IF p_response NOT IN ('yes', 'no', 'maybe', 'waitlist') THEN
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

  v_effective_response := p_response;

  SELECT (response = 'yes') INTO v_already_yes
    FROM game_poll_votes
   WHERE date_id = p_date_id AND player_id = p_voter_player_id
   LIMIT 1;

  IF p_response = 'yes' THEN
    IF NOT COALESCE(v_already_yes, FALSE) THEN
      SELECT count(*) INTO v_yes_count
        FROM game_poll_votes
       WHERE date_id = p_date_id AND response = 'yes';

      IF v_yes_count >= v_poll.target_player_count THEN
        -- If table is genuinely full, place on waitlist
        v_effective_response := 'waitlist';
      ELSIF v_player_type <> 'permanent' THEN
        v_holds_active := (v_poll.expanded_at IS NULL AND now() < v_poll.created_at
                          + make_interval(hours => v_poll.expansion_delay_hours + v_poll.maybe_hold_hours));

        IF v_holds_active THEN
          SELECT
            count(*) FILTER (WHERE gpv.response = 'yes'),
            count(*) FILTER (WHERE gpv.response = 'maybe' AND pl.type = 'permanent')
            INTO v_yes_count, v_hold_count
          FROM game_poll_votes gpv
          JOIN players pl ON pl.id = gpv.player_id
          WHERE gpv.date_id = p_date_id
            AND gpv.player_id <> p_voter_player_id;

          SELECT count(*) INTO v_unvoted_perm_count
            FROM players pl
           WHERE pl.group_id = v_poll.group_id
             AND pl.type = 'permanent'
             AND NOT EXISTS (
               SELECT 1 FROM game_poll_votes gpv
                WHERE gpv.date_id = p_date_id
                  AND gpv.player_id = pl.id
             );

          -- If open seats are needed to protect unvoted permanent players + permanent maybe voters:
          IF v_yes_count + v_hold_count + v_unvoted_perm_count >= v_poll.target_player_count THEN
            v_effective_response := 'waitlist';
          END IF;
        END IF;
      END IF;
    END IF;
  ELSIF p_response = 'waitlist' THEN
    -- Admin explicitly requested waitlist: ALWAYS respect admin's choice, NEVER auto-upgrade!
    v_effective_response := 'waitlist';
  END IF;

  INSERT INTO game_poll_votes (
    poll_id, date_id, player_id, user_id, response, comment, voted_at,
    cast_by_user_id
  )
  VALUES (
    v_poll.id, p_date_id, p_voter_player_id, v_player_user,
    v_effective_response, p_comment, now(),
    auth.uid()
  )
  ON CONFLICT (date_id, player_id) DO UPDATE
    SET response        = EXCLUDED.response,
        comment         = EXCLUDED.comment,
        voted_at        = CASE
          -- Preserve FIFO queue timestamp when editing comment on an existing waitlist row
          WHEN game_poll_votes.response = 'waitlist' AND EXCLUDED.response = 'waitlist'
            THEN game_poll_votes.voted_at
          ELSE now()
        END,
        cast_by_user_id = auth.uid();

  RETURN QUERY
    SELECT * FROM game_polls WHERE id = v_poll.id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.cast_poll_vote(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_cast_poll_vote(uuid, uuid, text, text) TO authenticated;

