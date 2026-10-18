-- ============================================================================
-- Migration 135: Immediate poll creation notifications + Push notifications log
-- ============================================================================
-- 1. Ensure poll creation notifications dispatch immediately upon poll opening,
--    without relying on trigger timing or on any user opening the client app.
--    - fn_sweep_auto_create_polls() now explicitly calls:
--        PERFORM public.enqueue_poll_notification(v_poll_id, 'creation');
--      immediately after inserting game_poll_dates.
--    - Added backstop sweep for any open poll from the last 48h without a creation job.
--    - create_game_poll() also directly enqueues creation notification.
--
-- 2. Audit log table for Push Notifications (push_notifications_log)
--    Mirrors email_usage_log so group admins / super admins can review all
--    recent push notifications, delivery counts, target players, and details.
-- ============================================================================

-- ── 1. Update fn_sweep_auto_create_polls ──────────────────────────────────────
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

    -- Catch-up age guard: if trigger occurred > 6 hours ago, treat as stale
    IF v_now_local - v_trigger_local > interval '6 hours' THEN
      IF v_g.last_fired < v_trigger_ts THEN
        UPDATE settings SET schedule_auto_created_at = now() WHERE group_id = v_g.group_id;
      END IF;
      CONTINUE;
    END IF;

    -- Already fired for this trigger window?
    IF v_g.last_fired >= v_trigger_ts THEN
      CONTINUE;
    END IF;

    -- An actionable poll already covers this trigger?
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

    -- DIRECT IMMEDIATE ENQUEUE:
    -- Enqueue the creation notification immediately after dates are stored.
    -- This guarantees sub-second dispatch to the worker without waiting for client app open.
    PERFORM public.enqueue_poll_notification(v_poll_id, 'creation');

    RAISE NOTICE 'auto-create: opened poll % and enqueued notification for group %', v_poll_id, v_g.group_id;
  END LOOP;

  -- Backstop sweep: ensure any open poll created in the last 48 hours
  -- that somehow missed its creation notification gets enqueued immediately.
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


-- ── 2. Update create_game_poll RPC with explicit enqueue ──────────────────────
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

  -- Explicit creation notification enqueue right after dates exist
  PERFORM public.enqueue_poll_notification(v_poll_id, 'creation');

  RETURN v_poll_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.create_game_poll(uuid, jsonb, integer, integer, text, boolean, text, text, integer)
  TO authenticated;


-- ── 3. Table push_notifications_log ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.push_notifications_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID REFERENCES public.groups(id) ON DELETE CASCADE NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT,
  target_player_names TEXT[] DEFAULT '{}',
  sent_count INT DEFAULT 0,
  total_count INT DEFAULT 0,
  details JSONB DEFAULT '[]'::JSONB,
  success BOOLEAN NOT NULL DEFAULT true,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS push_notifications_log_group_sent_idx
  ON public.push_notifications_log (group_id, sent_at DESC);

ALTER TABLE public.push_notifications_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS push_notifications_log_select ON public.push_notifications_log;
CREATE POLICY push_notifications_log_select ON public.push_notifications_log
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.group_members gm
      WHERE gm.group_id = push_notifications_log.group_id
        AND gm.user_id = auth.uid()
        AND gm.role = 'admin'
    )
    OR EXISTS (
      SELECT 1 FROM public.super_admins sa
      WHERE sa.user_id = auth.uid()
    )
  );

GRANT ALL ON public.push_notifications_log TO service_role;
GRANT SELECT ON public.push_notifications_log TO authenticated;


-- ── 4. RPC get_push_notifications_summary ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_push_notifications_summary(
  p_group_id UUID,
  p_limit INT DEFAULT 25
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER STABLE
SET search_path = 'public'
AS $$
DECLARE
  result JSONB;
BEGIN
  IF current_user != 'postgres' AND COALESCE(auth.role(), '') != 'service_role' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.group_members gm
      WHERE gm.group_id = p_group_id AND gm.user_id = auth.uid() AND gm.role = 'admin'
    ) AND NOT EXISTS (
      SELECT 1 FROM public.super_admins sa WHERE sa.user_id = auth.uid()
    ) THEN
      RAISE EXCEPTION 'forbidden' USING errcode = '42501';
    END IF;
  END IF;

  SELECT jsonb_build_object(
    'total_sent', coalesce((
      SELECT sum(sent_count) FROM public.push_notifications_log
      WHERE group_id = p_group_id AND success
    ), 0),
    'active_subscribers', coalesce((
      SELECT jsonb_agg(DISTINCT player_name) FROM public.push_subscriptions
      WHERE group_id = p_group_id AND player_name IS NOT NULL
    ), '[]'::jsonb),
    'recent', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', id,
        'sent_at', sent_at,
        'kind', kind,
        'title', title,
        'body', body,
        'url', url,
        'target_player_names', target_player_names,
        'sent_count', sent_count,
        'total_count', total_count,
        'details', details,
        'success', success
      ) ORDER BY sent_at DESC)
      FROM (
        SELECT * FROM public.push_notifications_log
        WHERE group_id = p_group_id
        ORDER BY sent_at DESC
        LIMIT p_limit
      ) r
    ), '[]'::jsonb)
  ) INTO result;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_push_notifications_summary(UUID, INT)
  TO authenticated, service_role;
