-- ============================================================================
-- Migration 134: Fix retroactive auto-create poll on schedule change
-- ============================================================================
--
-- Why: When an admin modified `schedule_auto_create_time` (e.g. from 07:30 to 08:30)
-- or `schedule_auto_create_day`, the sentinel `schedule_auto_created_at` still held
-- the timestamp of the prior fire under the OLD schedule.
--
-- In `fn_sweep_auto_create_polls()`, the most recent anchor for (sday, stime) was
-- computed by walking backwards up to 7 days. Because 08:30 was later in the day
-- than 07:30, the anchor for the previous Sunday evaluated to 08:30, which was
-- greater than the recorded `last_fired` (07:30). Once the active game completed,
-- the cron sweep treated the newly configured time as a "missed trigger" from
-- days ago and immediately auto-opened a poll in the middle of the night.
--
-- Fix:
--   1. Trigger on `settings`: Automatically stamp `schedule_auto_created_at = now()`
--      whenever `schedule_auto_create_day` or `schedule_auto_create_time` changes,
--      or when `schedule_auto_create_enabled` transitions to true. Any schedule
--      change takes effect strictly from NOW forward.
--   2. Catch-up age guard in `fn_sweep_auto_create_polls()`: if the trigger anchor
--      is older than 6 hours (`v_now_local - v_trigger_local > interval '6 hours'`),
--      it is not a legitimate cron delay/hiccup but a stale trigger. The function
--      advances the sentinel to `now()` and skips without creating a poll.
--   3. Maintain cron-only security lockdown on `fn_sweep_auto_create_polls()`.
-- ============================================================================

-- 1. Trigger function to reset auto-create sentinel on schedule change
CREATE OR REPLACE FUNCTION public.fn_handle_settings_auto_create_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF (NEW.schedule_auto_create_day IS DISTINCT FROM OLD.schedule_auto_create_day
      OR NEW.schedule_auto_create_time IS DISTINCT FROM OLD.schedule_auto_create_time
      OR (NEW.schedule_auto_create_enabled = true AND OLD.schedule_auto_create_enabled IS NOT TRUE))
  THEN
    NEW.schedule_auto_created_at := now();
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_settings_auto_create_change ON public.settings;
CREATE TRIGGER trg_settings_auto_create_change
  BEFORE UPDATE ON public.settings
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_handle_settings_auto_create_change();

-- 2. Update sweep function with catch-up age guard
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

    -- Catch-up age guard: if the trigger occurred more than 6 hours ago,
    -- this is a stale trigger (e.g. days ago in the past, or past schedule change).
    -- Advance the sentinel to now and do NOT create a poll.
    IF v_now_local - v_trigger_local > interval '6 hours' THEN
      IF v_g.last_fired < v_trigger_ts THEN
        UPDATE settings SET schedule_auto_created_at = now() WHERE group_id = v_g.group_id;
      END IF;
      CONTINUE;
    END IF;

    -- Already fired for this trigger window (or a later one)? Nothing to do.
    IF v_g.last_fired >= v_trigger_ts THEN
      CONTINUE;
    END IF;

    -- An actionable poll with a still-upcoming date already covers this trigger
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

-- 3. Security lockdown: cron runs as postgres superuser, revoke from client roles
REVOKE ALL ON FUNCTION public.fn_sweep_auto_create_polls() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_sweep_auto_create_polls() FROM anon;
REVOKE ALL ON FUNCTION public.fn_sweep_auto_create_polls() FROM authenticated;
