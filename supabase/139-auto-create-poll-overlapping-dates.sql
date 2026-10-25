-- ==============================================================================
-- Migration 139: Auto-Create Poll Checks Target Date Overlap, Not Any Future Poll
-- ==============================================================================
--
-- Why:
-- In `fn_sweep_auto_create_polls()` (migrations 097/134/136), the `v_has_active` guard
-- checked:
--   SELECT EXISTS (
--     SELECT 1 FROM game_polls p
--     WHERE p.group_id = v_g.group_id
--       AND (p.status IN ('open','expanded')
--            OR (p.status = 'confirmed' AND p.confirmed_game_id IS NULL))
--       AND EXISTS (
--         SELECT 1 FROM game_poll_dates d
--         WHERE d.poll_id = p.id AND d.proposed_date >= v_today
--       )
--   )
--
-- If ANY active poll in the group had ANY proposed date >= today (e.g. an ad-hoc
-- special game created by an admin like "ערב בחירות" on Monday 26/10),
-- `v_has_active` evaluated to true. The function stamped `schedule_auto_created_at = now()`
-- and exited — completely suppressing the scheduled weekly poll (for Thursday-Saturday
-- 29/10 - 31/10) for the entire week!
--
-- Fix:
-- 1. Compute `v_dates` (the upcoming target dates for this weekly schedule) FIRST.
-- 2. Only consider an existing active poll as covering this trigger if it proposes
--    at least one of the SAME target dates:
--    `d.proposed_date IN (SELECT (jsonb_array_elements_text(v_dates))::date)`
--    AND `d.disabled_at IS NULL`.
-- 3. Maintain cron-only security lockdown on `fn_sweep_auto_create_polls()`.
-- 4. One-time healing: Reset `schedule_auto_created_at` for groups where the auto-create
--    schedule was enabled for today (Sunday) but was falsely suppressed at 08:30
--    without creating a poll today, and trigger `fn_sweep_auto_create_polls()` so
--    today's pending weekly poll is created and dispatched immediately.
-- ==============================================================================

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

    -- Build proposed target dates FIRST so we can check if an active poll
    -- actually covers ANY of the target dates, rather than blocking on ANY
    -- unrelated future poll (e.g. an ad-hoc Monday election game).
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

    -- An actionable poll already covers one of the proposed target dates for this trigger
    SELECT EXISTS (
      SELECT 1 FROM game_polls p
      WHERE p.group_id = v_g.group_id
        AND (p.status IN ('open','expanded')
             OR (p.status = 'confirmed' AND p.confirmed_game_id IS NULL))
        AND EXISTS (
          SELECT 1 FROM game_poll_dates d
          WHERE d.poll_id = p.id
            AND d.disabled_at IS NULL
            AND d.proposed_date IN (
              SELECT (jsonb_array_elements_text(v_dates))::date
            )
        )
    ) INTO v_has_active;

    IF v_has_active THEN
      UPDATE settings SET schedule_auto_created_at = now() WHERE group_id = v_g.group_id;
      CONTINUE;
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

REVOKE ALL ON FUNCTION public.fn_sweep_auto_create_polls() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_sweep_auto_create_polls() FROM anon;
REVOKE ALL ON FUNCTION public.fn_sweep_auto_create_polls() FROM authenticated;

-- ── 2. One-time healing for today ─────────────────────────────────────────────
-- Reset sentinel for groups where auto-create was enabled for today (Sunday)
-- but falsely suppressed at 08:30 without creating any poll today.
UPDATE public.settings s
SET schedule_auto_created_at = '2026-10-18 05:30:00+00'
WHERE s.schedule_auto_create_enabled = true
  AND s.schedule_auto_create_day = 0
  AND s.schedule_auto_created_at >= '2026-10-25 00:00:00+00'
  AND NOT EXISTS (
    SELECT 1 FROM public.game_polls p
    WHERE p.group_id = s.group_id
      AND p.created_source = 'auto'
      AND p.created_at >= '2026-10-25 00:00:00+00'
  );

-- Trigger immediate execution so today's poll opens and dispatches right away
SELECT public.fn_sweep_auto_create_polls();
