-- =============================================================================
-- Migration 155: Roster Change & Forecast Mismatch Notifications
-- =============================================================================
-- 1. Fix waitlist_promoted: passes `recipient_player_names` and `recipient_player_name`
--    alongside `recipient_player_id`, with p_poll_id := NULL so multiple simultaneous
--    promotions do not collide on idx_notification_jobs_active_uniq.
-- 2. New notification kind 'roster_change': when a player cancels and a waitlisted
--    player is promoted into a confirmed or full game, broadcasts a roster change
--    notification (push to whole group, email to confirmed attendees).
-- 3. New notification kind 'forecast_mismatch': when an active pending forecast exists
--    whose players do not match the new lineup after promotion, alerts admins that
--    the forecast needs updating.
-- 4. Updates notification_jobs_kind_check and enqueue_notification to recognize
--    'roster_change' and 'forecast_mismatch'.
-- =============================================================================

-- ── 1. Update notification_jobs CHECK constraint ─────────────────────────────
ALTER TABLE public.notification_jobs
  DROP CONSTRAINT IF EXISTS notification_jobs_kind_check;

ALTER TABLE public.notification_jobs
  ADD CONSTRAINT notification_jobs_kind_check CHECK (
    kind IN (
      'creation', 'expanded', 'confirmed', 'cancellation', 'target_filled',
      'vote_change', 'reminder', 'reminder_no_vote', 'reminder_maybe',
      'trivia_report_filed', 'trivia_report_resolved',
      'training_report_filed', 'training_report_resolved', 'training_milestone',
      'date_excluded', 'waitlist_promoted',
      'roster_change', 'forecast_mismatch'
    )
  );

-- ── 2. Update enqueue_notification ───────────────────────────────────────────
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
    'date_excluded','waitlist_promoted',
    'roster_change','forecast_mismatch'
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

-- ── 3. Update fn_promote_waitlist_for_date ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_promote_waitlist_for_date(
  p_date_id UUID,
  p_replaced_player_id UUID DEFAULT NULL
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_poll                 game_polls%ROWTYPE;
  v_proposed_date        DATE;
  v_proposed_time        TEXT;
  v_location             TEXT;
  v_disabled_at          TIMESTAMPTZ;
  v_yes_count            INT;
  v_hold_count           INT;
  v_unvoted_perm_count   INT;
  v_holds_active         BOOLEAN;
  v_promoted_cnt         INT := 0;
  v_cand                 RECORD;
  v_dow_he               TEXT;
  v_date_str             TEXT;
  v_when_str             TEXT;
  v_loc_str              TEXT;
  v_push_title           TEXT;
  v_push_body            TEXT;
  v_email_subj           TEXT;
  v_email_body           TEXT;
  v_link                 TEXT;
  v_dropped_player_name  TEXT;
  v_pf                   RECORD;
  v_pf_player_ids        JSONB;
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

  IF p_replaced_player_id IS NOT NULL THEN
    SELECT name INTO v_dropped_player_name FROM players WHERE id = p_replaced_player_id;
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

    v_email_subj := '🎉 התפנה מקום — נכנסת למשחק הפוקר!';
    v_email_body := 'שחקן ביטל את הגעתו והתפנה מקום ב-' || v_when_str || '.' || E'\n'
      || 'מכיוון שהיית ראשון ברשימת ההמתנה, שובצת אוטומטית בהרכב המשחק!' || E'\n\n'
      || CASE WHEN v_loc_str IS NOT NULL AND length(trim(v_loc_str)) > 0
              THEN '📍 מיקום: ' || v_loc_str || E'\n' ELSE '' END
      || 'אם חל שינוי בתוכניות שלך, אנא עדכן בהקדם בהצבעה כדי לפנות מקום לבא בתור.' || E'\n\n'
      || '👉 לצפייה ועדכון בהצבעה: https://poker-manager-blond.vercel.app/p/' || COALESCE(v_poll.share_slug, v_poll.id::text);

    v_link := '/schedule?pollId=' || v_poll.id::text;

    -- 1. Personal notification for promoted player (Pass poll_id=NULL so multiple promotions don't collide on active uniq index)
    PERFORM enqueue_notification(
      'waitlist_promoted',
      v_poll.group_id,
      NULL,
      jsonb_build_object(
        'poll_id',                v_poll.id,
        'date_id',                p_date_id,
        'player_id',              v_cand.player_id,
        'recipient_player_id',    v_cand.player_id,
        'recipient_player_name',  v_cand.player_name,
        'recipient_player_names', jsonb_build_array(v_cand.player_name),
        'url',                    v_link,
        'push_title',             v_push_title,
        'push_body',              v_push_body,
        'email_subject',          v_email_subj,
        'email_body',             v_email_body
      )
    );

    -- 2. If the game was confirmed or is full, broadcast a roster update announcement to the group
    IF v_poll.status = 'confirmed' OR (v_yes_count + 1 >= v_poll.target_player_count) THEN
      PERFORM enqueue_notification(
        'roster_change',
        v_poll.group_id,
        v_poll.id,
        jsonb_build_object(
          'date_id',              p_date_id,
          'promoted_player_id',   v_cand.player_id,
          'promoted_player_name', v_cand.player_name,
          'dropped_player_id',    p_replaced_player_id,
          'dropped_player_name',  v_dropped_player_name
        )
      );
    END IF;

    -- 3. Check for pending forecast mismatch and notify admins if needed
    SELECT * INTO v_pf
      FROM pending_forecasts
     WHERE group_id = v_poll.group_id
       AND linked_game_id IS NULL
     ORDER BY created_at DESC
     LIMIT 1;

    IF v_pf.id IS NOT NULL THEN
      v_pf_player_ids := to_jsonb(v_pf.player_ids);
      IF (p_replaced_player_id IS NOT NULL AND (p_replaced_player_id::text = ANY(SELECT jsonb_array_elements_text(v_pf_player_ids))))
         OR NOT (v_cand.player_id::text = ANY(SELECT jsonb_array_elements_text(v_pf_player_ids))) THEN
        PERFORM enqueue_notification(
          'forecast_mismatch',
          v_poll.group_id,
          v_poll.id,
          jsonb_build_object(
            'date_id',              p_date_id,
            'promoted_player_id',   v_cand.player_id,
            'promoted_player_name', v_cand.player_name,
            'dropped_player_id',    p_replaced_player_id,
            'dropped_player_name',  v_dropped_player_name,
            'forecast_id',          v_pf.id
          )
        );
      END IF;
    END IF;

  END LOOP;

  RETURN v_promoted_cnt;
END;
$function$;

-- Backward-compatible 1-arg overload
CREATE OR REPLACE FUNCTION public.fn_promote_waitlist_for_date(p_date_id UUID)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  RETURN fn_promote_waitlist_for_date(p_date_id, NULL);
END;
$$;

-- ── 4. Update fn_cleanup_and_promote_on_vote_change ──────────────────────────
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
      PERFORM fn_promote_waitlist_for_date(OLD.date_id, OLD.player_id);
    END IF;
    RETURN OLD;
  END IF;

  -- INSERT or UPDATE
  PERFORM fn_cleanup_player_poll_preference(NEW.poll_id, NEW.player_id);

  IF TG_OP = 'INSERT' THEN
    -- If a permanent player voted 'no', it released an unvoted reservation on this date!
    PERFORM fn_promote_waitlist_for_date(NEW.date_id, NULL);
  ELSIF TG_OP = 'UPDATE'
     AND (
       (OLD.response IN ('yes', 'maybe') AND NEW.response <> 'yes' AND OLD.response IS DISTINCT FROM NEW.response)
       OR (OLD.response = 'yes' AND NEW.response = 'maybe')
     ) THEN
    PERFORM fn_promote_waitlist_for_date(OLD.date_id, OLD.player_id);
  END IF;

  RETURN NEW;
END;
$function$;
