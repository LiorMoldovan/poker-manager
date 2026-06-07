-- ============================================================================
-- Migration 097: server-side exact-time auto-create-poll trigger
-- ============================================================================
--
-- Until now the weekly auto-create-poll (migration 050) was CLIENT-driven: it
-- only fired when an admin happened to have the Schedule tab open at-or-after
-- the configured (day, HH:MM). If nobody was looking at 10:00, the poll opened
-- late — whenever an admin next loaded the tab (catch-up). It also had a
-- cross-device race that occasionally created duplicate polls (see migration
-- 093).
--
-- This migration moves the trigger SERVER-side so the poll opens within ~1
-- minute of the configured time regardless of who's online:
--
--   * fn_sweep_auto_create_polls() — runs every minute (pg_cron), walks every
--     group with the schedule enabled, and opens a poll when the configured
--     (weekday, time) moment has passed since `schedule_auto_created_at`.
--   * Reuses the EXISTING poll pipeline: it inserts directly into game_polls
--     with status 'open', which fires `trg_enqueue_poll_notification` →
--     `enqueue_poll_notification(.., 'creation')` → the existing per-minute
--     notification sweep delivers push/email. No new delivery code.
--
-- Why insert directly instead of calling create_game_poll()? That RPC checks
-- auth.uid() for admin — there is NO authenticated user under pg_cron, so the
-- check would fail. The function is SECURITY DEFINER and replicates the same
-- INSERTs, attributing the poll to the group OWNER (groups.created_by) since
-- game_polls.created_by is NOT NULL.
--
-- Timezone: the configured time is Israel wall-clock (all groups are IL). The
-- function computes the trigger in 'Asia/Jerusalem' (DST-aware). If a group in
-- another timezone is ever added, this constant must become per-group.
--
-- Coexistence with the client trigger: both share the `schedule_auto_created_at`
-- sentinel, so once the server fires and stamps it, the client effect sees it's
-- already fired and skips. The client path is intentionally LEFT IN PLACE as a
-- fallback (e.g. if pg_cron is paused). The server reading live DB state (not
-- stale React state) also avoids the migration-093 duplicate race for the
-- server path, and the per-row FOR UPDATE lock prevents overlapping sweeps from
-- double-firing.
--
-- Idempotent: CREATE OR REPLACE for the function; the cron job is unscheduled
-- (if present) then re-scheduled.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_sweep_auto_create_polls()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tz            CONSTANT text := 'Asia/Jerusalem';
  v_now_local     timestamp;   -- Israel wall-clock "now"
  v_today         date;
  v_dow_today     int;         -- 0=Sun .. 6=Sat
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
    SELECT s.group_id,
           s.game_night_days,
           s.schedule_auto_create_day      AS sday,
           s.schedule_auto_create_time      AS stime,
           s.schedule_auto_created_at       AS last_fired,
           s.schedule_default_time          AS dtime,
           s.schedule_default_target        AS dtarget,
           s.schedule_default_delay_hours   AS ddelay,
           s.schedule_default_allow_maybe   AS dmaybe
    FROM settings s
    WHERE s.schedule_auto_create_enabled = true
    FOR UPDATE OF s
  LOOP
    -- Most recent (sday, stime) occurrence at-or-before now (Israel local).
    -- Start from today at the configured time, walk back up to 7 days to the
    -- matching weekday — mirrors the client's computePreviousScheduledTrigger.
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

    -- First-enable guard (mirrors client v6.8.4): if never fired, initialize
    -- the sentinel to NOW and wait for the NEXT scheduled trigger instead of
    -- catching up immediately.
    IF v_g.last_fired IS NULL THEN
      UPDATE settings SET schedule_auto_created_at = now() WHERE group_id = v_g.group_id;
      CONTINUE;
    END IF;

    -- Already fired for this trigger window (or a later one)? Nothing to do.
    IF v_g.last_fired >= v_trigger_ts THEN
      CONTINUE;
    END IF;

    -- An actionable poll with a still-upcoming date already covers this
    -- trigger → stamp the sentinel and skip (mirror the client guard so we
    -- don't pile a second poll on top of a live one).
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

    -- Build proposed dates: the soonest upcoming (today inclusive) occurrence
    -- of each configured game-night weekday. Equivalent to the client's
    -- buildAutoPollDates (one date per configured weekday, chronological).
    SELECT array_agg(DISTINCT e::int) INTO v_days
    FROM jsonb_array_elements_text(COALESCE(v_g.game_night_days, '[]'::jsonb)) e;

    v_dates := '[]'::jsonb;
    IF v_days IS NULL OR array_length(v_days, 1) IS NULL THEN
      -- No game nights configured → single date = today (client falls back to today).
      v_dates := jsonb_build_array(to_char(v_today, 'YYYY-MM-DD'));
    ELSE
      FOREACH v_d IN ARRAY v_days LOOP
        v_date  := v_today + ((v_d - v_dow_today + 7) % 7);
        v_dates := v_dates || jsonb_build_array(to_char(v_date, 'YYYY-MM-DD'));
      END LOOP;
    END IF;

    -- Attribute the poll to the group owner (created_by is NOT NULL).
    SELECT created_by INTO v_owner FROM groups WHERE id = v_g.group_id;
    IF v_owner IS NULL THEN
      CONTINUE;  -- can't attribute → skip safely (don't stamp; retry next run)
    END IF;

    -- Open the poll. status 'open' fires trg_enqueue_poll_notification.
    INSERT INTO game_polls (
      group_id, created_by, status, target_player_count,
      expansion_delay_hours, default_location, allow_maybe, note
    ) VALUES (
      v_g.group_id, v_owner, 'open', COALESCE(v_g.dtarget, 7),
      COALESCE(v_g.ddelay, 48), NULL, COALESCE(v_g.dmaybe, true), NULL
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

-- Schedule the per-minute sweep (idempotent: drop the old job if it exists).
DO $$
BEGIN
  PERFORM cron.unschedule('auto-create-polls-sweep');
EXCEPTION WHEN OTHERS THEN
  NULL;  -- job didn't exist yet
END $$;

SELECT cron.schedule(
  'auto-create-polls-sweep',
  '* * * * *',
  $$SELECT public.fn_sweep_auto_create_polls();$$
);
