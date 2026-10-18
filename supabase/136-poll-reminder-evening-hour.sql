-- ==============================================================================
-- Migration 136: Evening Poll Reminder Hour Config (Default 18:00)
--
-- 1. Adds schedule_reminder_evening_time and schedule_reminder_noon_time to settings.
-- 2. Adds reminder_evening_time to game_polls (allows per-poll override).
-- 3. Updates create_game_poll, fn_sweep_auto_create_polls, and update_game_poll_meta
--    to support the customizable reminder evening hour (default 18:00).
-- 4. Updates fn_sweep_poll_reminders default to 18:00 (instead of 19:00) and reads
--    per-poll / per-group configuration.
-- ==============================================================================

-- ── 1. Schema additions ────────────────────────────────────────────────────────
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS schedule_reminder_evening_time TEXT DEFAULT '18:00',
  ADD COLUMN IF NOT EXISTS schedule_reminder_noon_time    TEXT DEFAULT '12:00';

ALTER TABLE public.game_polls
  ADD COLUMN IF NOT EXISTS reminder_evening_time TEXT DEFAULT '18:00';

-- Backfill existing rows so active polls take the 18:00 reminder immediately
UPDATE public.settings
   SET schedule_reminder_evening_time = '18:00'
 WHERE schedule_reminder_evening_time IS NULL;

UPDATE public.settings
   SET schedule_reminder_noon_time = '12:00'
 WHERE schedule_reminder_noon_time IS NULL;

UPDATE public.game_polls
   SET reminder_evening_time = '18:00'
 WHERE reminder_evening_time IS NULL;


-- ── 2. Update create_game_poll RPC ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_game_poll(
  p_group_id              uuid,
  p_dates                 jsonb,
  p_target                integer DEFAULT 8,
  p_expansion_delay       integer DEFAULT 48,
  p_default_location      text    DEFAULT NULL,
  p_allow_maybe           boolean DEFAULT true,
  p_note                  text    DEFAULT NULL,
  p_source                text    DEFAULT 'admin',
  p_maybe_hold_hours      integer DEFAULT 48,
  p_reminder_evening_time text    DEFAULT '18:00'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_poll_id               UUID;
  v_date_count            INT;
  v_date                  JSONB;
  v_source                TEXT := CASE WHEN p_source = 'auto' THEN 'auto' ELSE 'admin' END;
  v_creator_name          TEXT;
  v_default_reminder_time TEXT;
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

  SELECT COALESCE(NULLIF(s.schedule_reminder_evening_time, ''), '18:00')
    INTO v_default_reminder_time
    FROM settings s
   WHERE s.group_id = p_group_id;

  INSERT INTO game_polls (
    group_id, created_by, status, target_player_count,
    expansion_delay_hours, default_location, allow_maybe, note,
    created_source, created_by_name, maybe_hold_hours,
    reminder_evening_time
  )
  VALUES (
    p_group_id, auth.uid(), 'open', p_target,
    p_expansion_delay, p_default_location, p_allow_maybe, p_note,
    v_source, CASE WHEN v_source = 'auto' THEN NULL ELSE v_creator_name END,
    GREATEST(0, COALESCE(p_maybe_hold_hours, 48)),
    COALESCE(NULLIF(p_reminder_evening_time, ''), v_default_reminder_time, '18:00')
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

  -- Explicit creation notification enqueue right after dates exist
  PERFORM public.enqueue_poll_notification(v_poll_id, 'creation');

  RETURN v_poll_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.create_game_poll(uuid, jsonb, integer, integer, text, boolean, text, text, integer, text)
  TO authenticated;


-- ── 3. Update update_game_poll_meta RPC ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_game_poll_meta(
  p_poll_id               uuid,
  p_target                integer,
  p_expansion_delay       integer,
  p_note                  text,
  p_default_location      text,
  p_allow_maybe           boolean,
  p_maybe_hold_hours      integer DEFAULT NULL::integer,
  p_reminder_evening_time text    DEFAULT NULL::text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
         allow_maybe           = COALESCE(p_allow_maybe, allow_maybe),
         reminder_evening_time = COALESCE(NULLIF(p_reminder_evening_time, ''), reminder_evening_time)
   WHERE id = p_poll_id
     AND status IN ('open', 'expanded', 'confirmed');

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
$function$;

GRANT EXECUTE ON FUNCTION public.update_game_poll_meta(uuid, integer, integer, text, text, boolean, integer, text)
  TO authenticated;


-- ── 4. Update fn_sweep_auto_create_polls ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_sweep_auto_create_polls()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tz            text := 'Asia/Jerusalem';
  v_now_local     timestamp;
  v_today         date;
  v_dow_today     int;
  v_g             record;
  v_trigger_local timestamp;
  v_trigger_ts    timestamptz;
  v_has_active    boolean;
  v_days          int[];
  v_dates         jsonb;
  v_d             int;
  v_date          date;
  v_owner         uuid;
  v_poll_id       uuid;
BEGIN
  v_now_local := (now() AT TIME ZONE v_tz);
  v_today     := v_now_local::date;
  v_dow_today := EXTRACT(DOW FROM v_today)::int;

  FOR v_g IN
    SELECT
      s.group_id,
      s.schedule_auto_create_day   AS trig_day,
      s.schedule_auto_create_time  AS trig_time,
      s.schedule_auto_created_at   AS last_fired,
      s.schedule_default_target    AS dtarget,
      s.schedule_default_delay_hours AS ddelay,
      s.schedule_default_time      AS dtime,
      s.schedule_default_allow_maybe AS dmaybe,
      s.schedule_default_maybe_hold_hours AS dhold,
      s.schedule_reminder_evening_time AS reminder_time,
      s.game_night_days
    FROM settings s
    WHERE s.schedule_auto_create_enabled = true
  LOOP
    IF v_g.trig_day IS NULL OR v_g.trig_time IS NULL THEN
      CONTINUE;
    END IF;

    v_trigger_local := (v_today - ((v_dow_today - v_g.trig_day + 7) % 7))
                       + NULLIF(v_g.trig_time, '')::time;

    IF v_now_local < v_trigger_local THEN
      v_trigger_local := v_trigger_local - interval '7 days';
    END IF;

    v_trigger_ts := v_trigger_local AT TIME ZONE v_tz;

    IF v_g.last_fired IS NULL THEN
      UPDATE settings SET schedule_auto_created_at = now() WHERE group_id = v_g.group_id;
      CONTINUE;
    END IF;

    IF v_now_local - v_trigger_local > interval '6 hours' THEN
      IF v_g.last_fired < v_trigger_ts THEN
        UPDATE settings SET schedule_auto_created_at = now() WHERE group_id = v_g.group_id;
      END IF;
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
      created_source, created_by_name, maybe_hold_hours,
      reminder_evening_time
    ) VALUES (
      v_g.group_id, v_owner, 'open', COALESCE(v_g.dtarget, 7),
      COALESCE(v_g.ddelay, 48), NULL, COALESCE(v_g.dmaybe, true), NULL,
      'auto', NULL, COALESCE(v_g.dhold, 48),
      COALESCE(NULLIF(v_g.reminder_time, ''), '18:00')
    ) RETURNING id INTO v_poll_id;

    INSERT INTO game_poll_dates (poll_id, proposed_date, proposed_time, location)
    SELECT v_poll_id, val::date, NULLIF(v_g.dtime, '')::time, NULL
    FROM jsonb_array_elements_text(v_dates) val
    ORDER BY val::date;

    UPDATE settings SET schedule_auto_created_at = now() WHERE group_id = v_g.group_id;

    PERFORM public.enqueue_poll_notification(v_poll_id, 'creation');

    RAISE NOTICE 'auto-create: opened poll % and enqueued notification for group %', v_poll_id, v_g.group_id;
  END LOOP;

  FOR v_poll_id IN
    SELECT p.id FROM game_polls p
    WHERE p.status = 'open'
      AND p.creation_notifications_sent_at IS NULL
      AND p.created_at >= now() - interval '48 hours'
      AND NOT EXISTS (
        SELECT 1 FROM notification_jobs nj
        WHERE nj.poll_id = p.id
          AND nj.kind = 'creation'
          AND nj.status IN ('pending', 'running', 'done')
      )
  LOOP
    PERFORM public.enqueue_poll_notification(v_poll_id, 'creation');
    RAISE NOTICE 'auto-create: backfilled creation notification for open poll %', v_poll_id;
  END LOOP;
END;
$function$;


-- ── 5. Update fn_sweep_poll_reminders ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_sweep_poll_reminders(
  p_noon_hour    INT DEFAULT 12,
  p_evening_hour INT DEFAULT 18
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_poll        RECORD;
  v_expansion   TIMESTAMPTZ;
  v_release     TIMESTAMPTZ;
  v_slot_time   TIMESTAMPTZ;
  v_names       TEXT[];
  v_title       TEXT;
  v_body        TEXT;
  v_yes_cnt     INT;
  v_evening_hr  INT;
  v_noon_hr     INT;
BEGIN
  FOR v_poll IN
    SELECT p.id, p.group_id, p.created_at, p.expanded_at, p.status,
           p.expansion_delay_hours, p.maybe_hold_hours,
           p.target_player_count, p.confirmed_date_id,
           COALESCE(
             NULLIF(split_part(p.reminder_evening_time, ':', 1), '')::int,
             NULLIF(split_part(s.schedule_reminder_evening_time, ':', 1), '')::int,
             p_evening_hour,
             18
           ) AS evening_hour,
           COALESCE(
             NULLIF(split_part(s.schedule_reminder_noon_time, ':', 1), '')::int,
             p_noon_hour,
             12
           ) AS noon_hour
      FROM game_polls p
      LEFT JOIN settings s ON s.group_id = p.group_id
     WHERE p.status IN ('open','expanded','confirmed')
       AND p.created_at > now() - interval '14 days'
  LOOP
    IF v_poll.status = 'confirmed' THEN
      IF v_poll.confirmed_date_id IS NULL THEN
        CONTINUE;
      END IF;
      SELECT count(*) INTO v_yes_cnt
        FROM game_poll_votes
       WHERE date_id = v_poll.confirmed_date_id AND response = 'yes';
      IF v_yes_cnt >= v_poll.target_player_count THEN
        CONTINUE;
      END IF;
    END IF;

    v_expansion := v_poll.created_at + make_interval(hours => v_poll.expansion_delay_hours);
    v_release   := v_expansion + make_interval(hours => COALESCE(v_poll.maybe_hold_hours, 48));

    v_evening_hr := CASE WHEN p_evening_hour != 18 THEN p_evening_hour ELSE v_poll.evening_hour END;
    v_noon_hr    := CASE WHEN p_noon_hour != 12 THEN p_noon_hour ELSE v_poll.noon_hour END;

    -- ── reminder_no_vote ──
    IF v_poll.expanded_at IS NULL THEN
      FOR v_slot IN 1..2 LOOP
        v_slot_time := fn_reminder_slot_at(v_expansion, 1, CASE v_slot WHEN 1 THEN v_noon_hr ELSE v_evening_hr END);

        CONTINUE WHEN v_slot_time <= v_poll.created_at;
        CONTINUE WHEN now() < v_slot_time OR now() >= v_slot_time + interval '2 hours';
        CONTINUE WHEN EXISTS (
          SELECT 1 FROM poll_reminder_log
           WHERE poll_id = v_poll.id AND kind = 'reminder_no_vote' AND slot = v_slot
        );

        SELECT array_agg(pl.name ORDER BY pl.name) INTO v_names
          FROM players pl
         WHERE pl.group_id = v_poll.group_id
           AND pl.type     = 'permanent'
           AND NOT EXISTS (
             SELECT 1 FROM game_poll_votes v
              WHERE v.poll_id = v_poll.id AND v.player_id = pl.id
           );

        IF v_names IS NULL OR array_length(v_names, 1) IS NULL THEN
          INSERT INTO poll_reminder_log (poll_id, kind, slot)
          VALUES (v_poll.id, 'reminder_no_vote', v_slot)
          ON CONFLICT DO NOTHING;
          CONTINUE;
        END IF;

        IF v_slot = 1 THEN
          v_title := '🃏 טרם הצבעת בסקר';
          v_body  := 'מחר הסקר נפתח גם לאורחים. כדאי להצביע היום ולשמור מקום';
        ELSE
          v_title := '⏰ הזדמנות אחרונה לפני האורחים';
          v_body  := 'מחר המקומות נפתחים לכולם. מי שעוד לא הצביע — עכשיו הזמן';
        END IF;

        PERFORM enqueue_notification(
          'reminder_no_vote',
          v_poll.group_id,
          v_poll.id,
          jsonb_build_object(
            'push_title', v_title,
            'push_body',  v_body,
            'url',        '/schedule?pollId=' || v_poll.id::text,
            'recipient_player_names', to_jsonb(v_names)
          )
        );

        INSERT INTO poll_reminder_log (poll_id, kind, slot)
        VALUES (v_poll.id, 'reminder_no_vote', v_slot)
        ON CONFLICT DO NOTHING;
      END LOOP;
    END IF;

    -- ── reminder_maybe ──
    FOR v_slot IN 1..2 LOOP
      v_slot_time := fn_reminder_slot_at(v_release, CASE v_slot WHEN 1 THEN 2 ELSE 1 END, v_evening_hr);

      CONTINUE WHEN v_slot_time <= v_poll.created_at;
      CONTINUE WHEN now() < v_slot_time OR now() >= v_slot_time + interval '2 hours';
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM poll_reminder_log
         WHERE poll_id = v_poll.id AND kind = 'reminder_maybe' AND slot = v_slot
      );

      SELECT array_agg(pl.name ORDER BY pl.name) INTO v_names
        FROM players pl
       WHERE pl.group_id = v_poll.group_id
         AND pl.type     = 'permanent'
         AND EXISTS (
           SELECT 1 FROM game_poll_votes v
            WHERE v.poll_id = v_poll.id AND v.player_id = pl.id AND v.response = 'maybe'
         )
         AND NOT EXISTS (
           SELECT 1 FROM game_poll_votes v
            WHERE v.poll_id = v_poll.id AND v.player_id = pl.id AND v.response = 'yes'
         );

      IF v_names IS NULL OR array_length(v_names, 1) IS NULL THEN
        INSERT INTO poll_reminder_log (poll_id, kind, slot)
        VALUES (v_poll.id, 'reminder_maybe', v_slot)
        ON CONFLICT DO NOTHING;
        CONTINUE;
      END IF;

      IF v_slot = 1 THEN
        v_title := '🤔 עדיין "אעדכן"';
        v_body  := 'המקום שמור עד מחרתיים. אישור מוקדם עוזר לסגור את הערב';
      ELSE
        v_title := '⏳ המקום משתחרר מחר';
        v_body  := 'בלי אישור הגעה, המקום ייפתח לשאר השחקנים מחר';
      END IF;

      PERFORM enqueue_notification(
        'reminder_maybe',
        v_poll.group_id,
        v_poll.id,
        jsonb_build_object(
          'push_title', v_title,
          'push_body',  v_body,
          'url',        '/schedule?pollId=' || v_poll.id::text,
          'recipient_player_names', to_jsonb(v_names)
        )
      );

      INSERT INTO poll_reminder_log (poll_id, kind, slot)
      VALUES (v_poll.id, 'reminder_maybe', v_slot)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_sweep_poll_reminders(INT,INT) FROM PUBLIC, anon, authenticated;

SELECT cron.unschedule('poll-reminders-sweep')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'poll-reminders-sweep');

SELECT cron.schedule('poll-reminders-sweep', '*/15 * * * *', 'SELECT public.fn_sweep_poll_reminders();');
