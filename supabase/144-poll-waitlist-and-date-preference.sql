-- ============================================================
-- Migration 144: Formal Waitlist & Multi-Date Preference
-- ============================================================
-- 1. Adds 'waitlist' to game_poll_votes.response CHECK constraint.
-- 2. Adds is_preferred BOOLEAN NOT NULL DEFAULT FALSE to game_poll_votes
--    with partial unique index (poll_id, player_id) WHERE is_preferred = TRUE
--    so a voter can mark at most one date as preferred per poll.
-- 3. Adds 'waitlist_promoted' to notification_jobs.kind CHECK constraint
--    and enqueue_notification() allowlist.
-- 4. Adds fn_cleanup_player_poll_preference(p_poll_id, p_player_id) to
--    auto-reset is_preferred when a voter drops below 2 positive
--    ('yes'/'waitlist') enabled dates on a poll.
-- 5. Adds fn_promote_waitlist_for_date(p_date_id) + trigger on
--    game_poll_votes so waitlisted players are promoted in strict FIFO
--    order (voted_at ASC, id ASC) whenever a seat opens (yes -> no/maybe,
--    delete, permanent maybe -> no during hold window, hold window expiry,
--    or target_player_count increase), enqueuing a personal notification.
-- 6. Updates cast_poll_vote & admin_cast_poll_vote to accept 'waitlist',
--    auto-upgrade 'waitlist' to 'yes' if a seat is actually open at cast
--    time, and preserve FIFO voted_at when updating a waitlist comment.
-- 7. Adds set_poll_preferred_date & admin_set_poll_preferred_date RPCs.
-- 8. Updates update_poll_target, update_game_poll_meta,
--    set_game_poll_date_disabled, and fn_sweep_expand_polls.
-- ============================================================

-- ── 1. Schema updates on game_poll_votes ──

ALTER TABLE public.game_poll_votes
  DROP CONSTRAINT IF EXISTS game_poll_votes_response_check;

ALTER TABLE public.game_poll_votes
  ADD CONSTRAINT game_poll_votes_response_check
  CHECK (response IN ('yes', 'no', 'maybe', 'waitlist'));

ALTER TABLE public.game_poll_votes
  ADD COLUMN IF NOT EXISTS is_preferred BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_game_poll_votes_one_preferred
  ON public.game_poll_votes (poll_id, player_id)
  WHERE is_preferred = TRUE;

-- ── 2. Notification queue support for 'waitlist_promoted' ──

ALTER TABLE public.notification_jobs
  DROP CONSTRAINT IF EXISTS notification_jobs_kind_check;

ALTER TABLE public.notification_jobs
  ADD CONSTRAINT notification_jobs_kind_check
  CHECK (kind IN (
    'creation', 'expanded', 'confirmed', 'cancellation', 'target_filled',
    'vote_change', 'reminder', 'reminder_no_vote', 'reminder_maybe',
    'trivia_report_filed', 'trivia_report_resolved',
    'training_report_filed', 'training_report_resolved', 'training_milestone',
    'date_excluded', 'waitlist_promoted'
  ));

CREATE OR REPLACE FUNCTION public.enqueue_notification(
  p_kind text,
  p_group_id uuid,
  p_poll_id uuid DEFAULT NULL::uuid,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id UUID;
BEGIN
  IF p_kind NOT IN (
    'creation','expanded','confirmed','cancellation','target_filled',
    'vote_change','reminder',
    'reminder_no_vote','reminder_maybe',
    'trivia_report_filed','trivia_report_resolved',
    'training_report_filed','training_report_resolved','training_milestone',
    'date_excluded','waitlist_promoted'
  ) THEN
    RAISE EXCEPTION 'invalid_kind: %', p_kind;
  END IF;

  IF p_group_id IS NULL THEN
    RAISE EXCEPTION 'missing_group_id';
  END IF;

  BEGIN
    INSERT INTO notification_jobs (group_id, poll_id, kind, status, payload, run_after)
    VALUES (p_group_id, p_poll_id, p_kind, 'pending', p_payload, fn_next_delivery_slot())
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    UPDATE notification_jobs
       SET payload = p_payload
     WHERE poll_id = p_poll_id
       AND kind    = p_kind
       AND status  = 'pending'
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
      SELECT id INTO v_id
        FROM notification_jobs
        WHERE poll_id = p_poll_id
          AND kind = p_kind
          AND status IN ('pending','running')
        LIMIT 1;
    END IF;
  END;

  RETURN v_id;
END;
$function$;

-- ── 3. Self-cleaning date preference helper ──

CREATE OR REPLACE FUNCTION public.fn_cleanup_player_poll_preference(
  p_poll_id UUID,
  p_player_id UUID
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_pos_cnt INT;
BEGIN
  IF p_poll_id IS NULL OR p_player_id IS NULL THEN
    RETURN;
  END IF;

  -- Clear preference on any vote that is no longer positive or is on a disabled date
  UPDATE game_poll_votes v
     SET is_preferred = FALSE
   WHERE v.poll_id = p_poll_id
     AND v.player_id = p_player_id
     AND v.is_preferred = TRUE
     AND (
       v.response NOT IN ('yes', 'waitlist')
       OR EXISTS (
         SELECT 1 FROM game_poll_dates d
          WHERE d.id = v.date_id AND d.disabled_at IS NOT NULL
       )
     );

  -- Count remaining enabled positive ('yes' or 'waitlist') dates for this player on this poll
  SELECT count(*) INTO v_pos_cnt
    FROM game_poll_votes v
    JOIN game_poll_dates d ON d.id = v.date_id
   WHERE v.poll_id = p_poll_id
     AND v.player_id = p_player_id
     AND v.response IN ('yes', 'waitlist')
     AND d.disabled_at IS NULL;

  -- Preference is only meaningful when a voter has 2+ positive dates
  IF v_pos_cnt < 2 THEN
    UPDATE game_poll_votes
       SET is_preferred = FALSE
     WHERE poll_id = p_poll_id
       AND player_id = p_player_id
       AND is_preferred = TRUE;
  END IF;
END;
$function$;

-- ── 4. FIFO Waitlist Auto-Promotion Engine ──

CREATE OR REPLACE FUNCTION public.fn_promote_waitlist_for_date(
  p_date_id UUID
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_poll          game_polls%ROWTYPE;
  v_proposed_date DATE;
  v_proposed_time TEXT;
  v_location      TEXT;
  v_disabled_at   TIMESTAMPTZ;
  v_yes_count     INT;
  v_hold_count    INT;
  v_holds_active  BOOLEAN;
  v_promoted_cnt  INT := 0;
  v_cand          RECORD;
  v_dow_he        TEXT;
  v_date_str      TEXT;
  v_when_str      TEXT;
  v_loc_str       TEXT;
  v_push_title    TEXT;
  v_push_body     TEXT;
  v_email_subj    TEXT;
  v_email_body    TEXT;
  v_link          TEXT;
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
      v_holds_active := now() < v_poll.created_at
                        + make_interval(hours => v_poll.expansion_delay_hours + v_poll.maybe_hold_hours);
      IF v_holds_active THEN
        SELECT count(*) INTO v_hold_count
          FROM game_poll_votes gpv
          JOIN players pl ON pl.id = gpv.player_id
         WHERE gpv.date_id = p_date_id
           AND gpv.response = 'maybe'
           AND pl.type = 'permanent';

        -- Respect pure FIFO: if the #1 waitlisted player is a guest and the remaining
        -- seat(s) are still held by permanent 'maybe' voters, wait until the hold
        -- releases or another 'yes' voter drops.
        IF v_yes_count + v_hold_count >= v_poll.target_player_count THEN
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
    END;
    v_date_str := to_char(v_proposed_date, 'DD/MM');
    v_when_str := v_dow_he || ' ' || v_date_str
                  || CASE WHEN COALESCE(v_proposed_time, '') <> '' THEN ' ב-' || v_proposed_time ELSE '' END;
    v_loc_str  := COALESCE(NULLIF(v_location, ''), NULLIF(v_poll.default_location, ''));

    v_push_title := '🎉 התפנה מקום — נכנסת למשחק!';
    v_push_body  := v_when_str
                    || CASE WHEN v_loc_str IS NOT NULL THEN ' — ' || v_loc_str ELSE '' END
                    || ' · הועברת אוטומטית מרשימת ההמתנה ל"מגיע" ✓';
    v_email_subj := '🎉 התפנה מקום — נכנסת למשחק הפוקר!';
    v_link       := 'https://poker-manager-blond.vercel.app/p/' || COALESCE(v_poll.share_slug, v_poll.id::text);
    v_email_body := 'חדשות מעולות! התפנה מקום והועברת אוטומטית מרשימת ההמתנה לרשימת המגיעים ✓' || E'\n\n'
                    || '📅 ' || v_when_str || E'\n'
                    || CASE WHEN v_loc_str IS NOT NULL THEN '📍 מיקום: ' || v_loc_str || E'\n' ELSE '' END
                    || E'\n👉 לפרטי המשחק: ' || v_link;

    -- Pass p_poll_id := NULL so multiple simultaneous promotions on the same poll
    -- do not collide on idx_notification_jobs_active_uniq (poll_id, kind).
    PERFORM enqueue_notification(
      'waitlist_promoted',
      v_poll.group_id,
      NULL,
      jsonb_build_object(
        'poll_id',       v_poll.id,
        'date_id',       p_date_id,
        'player_id',     v_cand.player_id,
        'push_title',    v_push_title,
        'push_body',     v_push_body,
        'email_subject', v_email_subj,
        'email_body',    v_email_body,
        'url',           '/schedule?pollId=' || v_poll.id::text,
        'recipient_player_names', jsonb_build_array(v_cand.player_name)
      )
    );
  END LOOP;

  RETURN v_promoted_cnt;
END;
$function$;

-- ── 5. Trigger on game_poll_votes for preference cleanup & waitlist promotion ──

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

  IF TG_OP = 'UPDATE'
     AND OLD.response IN ('yes', 'maybe')
     AND NEW.response <> 'yes'
     AND OLD.response IS DISTINCT FROM NEW.response THEN
    PERFORM fn_promote_waitlist_for_date(OLD.date_id);
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_cleanup_and_promote_on_vote_change ON public.game_poll_votes;

CREATE TRIGGER trg_cleanup_and_promote_on_vote_change
  AFTER INSERT OR UPDATE OF response OR DELETE ON public.game_poll_votes
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_cleanup_and_promote_on_vote_change();

-- ── 6. Update cast_poll_vote & admin_cast_poll_vote ──

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
  v_poll               game_polls%ROWTYPE;
  v_player_id          UUID;
  v_player_type        TEXT;
  v_date_disabled      BOOLEAN;
  v_already_yes        BOOLEAN;
  v_yes_count          INT;
  v_hold_count         INT;
  v_holds_active       BOOLEAN;
  v_effective_response TEXT;
  v_seat_blocked       BOOLEAN;
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

  IF v_player_type <> 'permanent'
     AND v_poll.expanded_at IS NULL
     AND now() < v_poll.created_at
                 + make_interval(hours => v_poll.expansion_delay_hours + v_poll.maybe_hold_hours) THEN
    RAISE EXCEPTION 'tier_not_allowed';
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
            AND gpv.player_id <> v_player_id;

          IF v_yes_count + v_hold_count >= v_poll.target_player_count THEN
            RAISE EXCEPTION 'seat_held';
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
    poll_id, date_id, player_id, user_id, response, comment, voted_at,
    cast_by_user_id
  )
  VALUES (
    v_poll.id, p_date_id, v_player_id, auth.uid(), v_effective_response, p_comment, now(),
    auth.uid()
  )
  ON CONFLICT (date_id, player_id) DO UPDATE
    SET response        = EXCLUDED.response,
        comment         = EXCLUDED.comment,
        -- Preserve FIFO queue position if already on waitlist and updating comment/re-tapping
        voted_at        = CASE
                            WHEN game_poll_votes.response = 'waitlist' AND EXCLUDED.response = 'waitlist'
                            THEN game_poll_votes.voted_at
                            ELSE EXCLUDED.voted_at
                          END,
        user_id         = EXCLUDED.user_id,
        cast_by_user_id = EXCLUDED.cast_by_user_id;

  RETURN QUERY SELECT * FROM game_polls WHERE id = v_poll.id;
END;
$function$;

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
  v_poll               game_polls%ROWTYPE;
  v_player_group       UUID;
  v_player_user        UUID;
  v_player_type        TEXT;
  v_date_disabled      BOOLEAN;
  v_already_yes        BOOLEAN;
  v_yes_count          INT;
  v_hold_count         INT;
  v_holds_active       BOOLEAN;
  v_effective_response TEXT;
  v_seat_blocked       BOOLEAN;
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
  ELSIF p_response = 'waitlist' THEN
    SELECT count(*) INTO v_yes_count
      FROM game_poll_votes
     WHERE date_id = p_date_id
       AND response = 'yes'
       AND player_id <> p_voter_player_id;

    v_seat_blocked := (v_yes_count >= v_poll.target_player_count)
      OR (
        COALESCE(v_already_yes, FALSE)
        AND EXISTS (
          SELECT 1 FROM game_poll_votes
           WHERE date_id = p_date_id
             AND response = 'waitlist'
             AND player_id <> p_voter_player_id
        )
      );

    IF NOT v_seat_blocked AND v_player_type <> 'permanent' THEN
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
          v_seat_blocked := TRUE;
        END IF;
      END IF;
    END IF;

    IF NOT v_seat_blocked THEN
      v_effective_response := 'yes';
    END IF;
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
                            WHEN game_poll_votes.response = 'waitlist' AND EXCLUDED.response = 'waitlist'
                            THEN game_poll_votes.voted_at
                            ELSE EXCLUDED.voted_at
                          END,
        user_id         = EXCLUDED.user_id,
        cast_by_user_id = EXCLUDED.cast_by_user_id;

  RETURN QUERY SELECT * FROM game_polls WHERE id = v_poll.id;
END;
$function$;

-- ── 7. RPCs for setting preferred date ──

CREATE OR REPLACE FUNCTION public.set_poll_preferred_date(
  p_poll_id uuid,
  p_date_id uuid DEFAULT NULL::uuid
)
RETURNS SETOF game_polls
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_poll      game_polls%ROWTYPE;
  v_player_id UUID;
  v_pos_cnt   INT;
BEGIN
  SELECT * INTO v_poll FROM game_polls WHERE id = p_poll_id;
  IF v_poll.id IS NULL THEN
    RAISE EXCEPTION 'invalid_poll';
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

  -- Clear any existing preferred flag on this poll for this player first
  -- (satisfies the partial unique index before setting the new one).
  UPDATE game_poll_votes
     SET is_preferred = FALSE
   WHERE poll_id = p_poll_id
     AND player_id = v_player_id
     AND is_preferred = TRUE;

  IF p_date_id IS NOT NULL THEN
    -- Ensure the voter has at least 2 positive ('yes'/'waitlist') enabled dates
    SELECT count(*) INTO v_pos_cnt
      FROM game_poll_votes v
      JOIN game_poll_dates d ON d.id = v.date_id
     WHERE v.poll_id = p_poll_id
       AND v.player_id = v_player_id
       AND v.response IN ('yes', 'waitlist')
       AND d.disabled_at IS NULL;

    IF v_pos_cnt < 2 THEN
      RAISE EXCEPTION 'need_multiple_positive_dates';
    END IF;

    UPDATE game_poll_votes v
       SET is_preferred = TRUE
      FROM game_poll_dates d
     WHERE v.poll_id = p_poll_id
       AND v.date_id = p_date_id
       AND v.player_id = v_player_id
       AND v.response IN ('yes', 'waitlist')
       AND d.id = v.date_id
       AND d.disabled_at IS NULL;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'preferred_date_not_positive';
    END IF;
  END IF;

  RETURN QUERY SELECT * FROM game_polls WHERE id = p_poll_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_set_poll_preferred_date(
  p_poll_id uuid,
  p_voter_player_id uuid,
  p_date_id uuid DEFAULT NULL::uuid
)
RETURNS SETOF game_polls
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_poll      game_polls%ROWTYPE;
  v_pos_cnt   INT;
BEGIN
  SELECT * INTO v_poll FROM game_polls WHERE id = p_poll_id;
  IF v_poll.id IS NULL THEN
    RAISE EXCEPTION 'invalid_poll';
  END IF;

  IF NOT is_schedule_admin(v_poll.group_id) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  IF v_poll.status NOT IN ('open', 'expanded', 'confirmed') THEN
    RAISE EXCEPTION 'poll_locked';
  END IF;

  IF v_poll.voting_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'voting_locked';
  END IF;

  UPDATE game_poll_votes
     SET is_preferred = FALSE
   WHERE poll_id = p_poll_id
     AND player_id = p_voter_player_id
     AND is_preferred = TRUE;

  IF p_date_id IS NOT NULL THEN
    SELECT count(*) INTO v_pos_cnt
      FROM game_poll_votes v
      JOIN game_poll_dates d ON d.id = v.date_id
     WHERE v.poll_id = p_poll_id
       AND v.player_id = p_voter_player_id
       AND v.response IN ('yes', 'waitlist')
       AND d.disabled_at IS NULL;

    IF v_pos_cnt < 2 THEN
      RAISE EXCEPTION 'need_multiple_positive_dates';
    END IF;

    UPDATE game_poll_votes v
       SET is_preferred = TRUE
      FROM game_poll_dates d
     WHERE v.poll_id = p_poll_id
       AND v.date_id = p_date_id
       AND v.player_id = p_voter_player_id
       AND v.response IN ('yes', 'waitlist')
       AND d.id = v.date_id
       AND d.disabled_at IS NULL;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'preferred_date_not_positive';
    END IF;
  END IF;

  RETURN QUERY SELECT * FROM game_polls WHERE id = p_poll_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.set_poll_preferred_date(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_poll_preferred_date(uuid, uuid, uuid) TO authenticated;

-- ── 8. Update update_poll_target, update_game_poll_meta, set_game_poll_date_disabled, fn_sweep_expand_polls ──

CREATE OR REPLACE FUNCTION public.update_poll_target(
  p_poll_id uuid,
  p_new_target integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_poll         game_polls%ROWTYPE;
  v_winning_date UUID;
  v_yes_cnt      INT;
  v_d            RECORD;
BEGIN
  SELECT * INTO v_poll FROM game_polls WHERE id = p_poll_id;
  IF v_poll.id IS NULL THEN
    RAISE EXCEPTION 'invalid_poll';
  END IF;

  IF NOT is_schedule_admin(v_poll.group_id) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  IF p_new_target < 2 THEN
    RAISE EXCEPTION 'invalid_target';
  END IF;

  UPDATE game_polls SET target_player_count = p_new_target
   WHERE id = p_poll_id AND status IN ('open', 'expanded', 'confirmed');

  -- Promote waitlisted players if target increased
  IF v_poll.confirmed_date_id IS NOT NULL THEN
    PERFORM fn_promote_waitlist_for_date(v_poll.confirmed_date_id);
  ELSE
    FOR v_d IN
      SELECT d.id
        FROM game_poll_dates d
        LEFT JOIN game_poll_votes v ON v.date_id = d.id AND v.response = 'yes'
       WHERE d.poll_id = p_poll_id
         AND d.disabled_at IS NULL
       GROUP BY d.id, d.proposed_date
       ORDER BY count(v.id) DESC,
                count(v.id) FILTER (WHERE v.is_preferred) DESC,
                d.proposed_date ASC
    LOOP
      PERFORM fn_promote_waitlist_for_date(v_d.id);
    END LOOP;
  END IF;

  SELECT v.date_id, count(*) INTO v_winning_date, v_yes_cnt
    FROM game_poll_votes v
    JOIN game_poll_dates d ON d.id = v.date_id
   WHERE v.poll_id = p_poll_id
     AND v.response = 'yes'
     AND d.disabled_at IS NULL
   GROUP BY v.date_id
   ORDER BY count(*) DESC,
            count(*) FILTER (WHERE v.is_preferred) DESC,
            v.date_id ASC
   LIMIT 1;

  IF v_winning_date IS NOT NULL AND v_yes_cnt >= p_new_target THEN
    UPDATE game_polls
       SET status = 'confirmed',
           confirmed_date_id = v_winning_date,
           confirmed_at = now(),
           confirmed_notified_date_id = v_winning_date
     WHERE id = p_poll_id
       AND status IN ('open', 'expanded');
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_game_poll_meta(
  p_poll_id uuid,
  p_target integer,
  p_expansion_delay integer,
  p_note text,
  p_default_location text,
  p_allow_maybe boolean,
  p_maybe_hold_hours integer DEFAULT NULL::integer,
  p_reminder_evening_time text DEFAULT NULL::text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_poll         game_polls%ROWTYPE;
  v_winning_date UUID;
  v_yes_cnt      INT;
  v_d            RECORD;
BEGIN
  SELECT * INTO v_poll FROM game_polls WHERE id = p_poll_id;
  IF v_poll.id IS NULL THEN
    RAISE EXCEPTION 'invalid_poll';
  END IF;

  IF NOT is_schedule_admin(v_poll.group_id) THEN
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
         allow_maybe           = COALESCE(p_allow_maybe, allow_maybe),
         reminder_evening_time = COALESCE(NULLIF(p_reminder_evening_time, ''), reminder_evening_time)
   WHERE id = p_poll_id
     AND status IN ('open', 'expanded', 'confirmed');

  -- Promote waitlisted players if target increased or hold window shortened
  IF v_poll.confirmed_date_id IS NOT NULL THEN
    PERFORM fn_promote_waitlist_for_date(v_poll.confirmed_date_id);
  ELSE
    FOR v_d IN
      SELECT d.id
        FROM game_poll_dates d
        LEFT JOIN game_poll_votes v ON v.date_id = d.id AND v.response = 'yes'
       WHERE d.poll_id = p_poll_id
         AND d.disabled_at IS NULL
       GROUP BY d.id, d.proposed_date
       ORDER BY count(v.id) DESC,
                count(v.id) FILTER (WHERE v.is_preferred) DESC,
                d.proposed_date ASC
    LOOP
      PERFORM fn_promote_waitlist_for_date(v_d.id);
    END LOOP;
  END IF;

  SELECT v.date_id, count(*) INTO v_winning_date, v_yes_cnt
    FROM game_poll_votes v
    JOIN game_poll_dates d ON d.id = v.date_id
   WHERE v.poll_id = p_poll_id
     AND v.response = 'yes'
     AND d.disabled_at IS NULL
   GROUP BY v.date_id
   ORDER BY count(*) DESC,
            count(*) FILTER (WHERE v.is_preferred) DESC,
            v.date_id ASC
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
$function$;

CREATE OR REPLACE FUNCTION public.set_game_poll_date_disabled(
  p_date_id uuid,
  p_disabled boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_poll_id        UUID;
  v_group_id       UUID;
  v_status         TEXT;
  v_confirmed_did  UUID;
  v_game_id        UUID;
  v_current_state  BOOLEAN;
  v_enabled_left   INT;
  v_r              RECORD;
BEGIN
  SELECT d.poll_id, p.group_id, p.status, p.confirmed_date_id, p.confirmed_game_id,
         (d.disabled_at IS NOT NULL)
    INTO v_poll_id, v_group_id, v_status, v_confirmed_did, v_game_id,
         v_current_state
    FROM game_poll_dates d
    JOIN game_polls p ON p.id = d.poll_id
   WHERE d.id = p_date_id;

  IF v_poll_id IS NULL THEN
    RAISE EXCEPTION 'invalid_date_id';
  END IF;

  IF NOT is_schedule_admin(v_group_id) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  IF v_status NOT IN ('open', 'expanded', 'confirmed') THEN
    RAISE EXCEPTION 'poll_locked';
  END IF;

  IF v_game_id IS NOT NULL THEN
    RAISE EXCEPTION 'game_already_started';
  END IF;

  IF p_disabled AND v_confirmed_did = p_date_id THEN
    RAISE EXCEPTION 'date_is_pinned';
  END IF;

  IF p_disabled AND NOT v_current_state THEN
    SELECT count(*) INTO v_enabled_left
      FROM game_poll_dates
     WHERE poll_id = v_poll_id
       AND id <> p_date_id
       AND disabled_at IS NULL;
    IF v_enabled_left = 0 THEN
      RAISE EXCEPTION 'last_enabled_date';
    END IF;
  END IF;

  UPDATE game_poll_dates
     SET disabled_at = CASE WHEN p_disabled THEN now() ELSE NULL END
   WHERE id = p_date_id;

  -- If disabling a date, clean up preferences for any voter who now has < 2 enabled positive dates
  IF p_disabled THEN
    FOR v_r IN
      SELECT DISTINCT player_id
        FROM game_poll_votes
       WHERE poll_id = v_poll_id AND is_preferred = TRUE
    LOOP
      PERFORM fn_cleanup_player_poll_preference(v_poll_id, v_r.player_id);
    END LOOP;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_sweep_expand_polls()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tz   CONSTANT text := 'Asia/Jerusalem';
  v_hour int;
  v_p    RECORD;
  v_d    RECORD;
BEGIN
  v_hour := extract(hour from (now() AT TIME ZONE v_tz))::int;
  IF v_hour < 8 OR v_hour >= 23 THEN
    RETURN;
  END IF;

  FOR v_p IN
    SELECT id FROM game_polls
     WHERE expanded_at IS NULL
       AND status IN ('open', 'confirmed')
       AND confirmed_game_id IS NULL
  LOOP
    PERFORM fn_expand_poll_internal(v_p.id);
  END LOOP;

  -- Also promote waitlisted players on polls whose permanent 'maybe' hold window has elapsed
  FOR v_d IN
    SELECT DISTINCT d.id, d.proposed_date
      FROM game_polls p
      JOIN game_poll_dates d ON d.poll_id = p.id
      JOIN game_poll_votes w ON w.date_id = d.id AND w.response = 'waitlist'
     WHERE p.status IN ('open', 'expanded', 'confirmed')
       AND p.confirmed_game_id IS NULL
       AND p.voting_locked_at IS NULL
       AND d.disabled_at IS NULL
       AND (p.confirmed_date_id IS NULL OR d.id = p.confirmed_date_id)
       AND now() >= p.created_at + make_interval(hours => p.expansion_delay_hours + p.maybe_hold_hours)
     ORDER BY d.proposed_date ASC
  LOOP
    PERFORM fn_promote_waitlist_for_date(v_d.id);
  END LOOP;
END;
$function$;

