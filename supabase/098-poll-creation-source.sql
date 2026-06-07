-- ============================================================================
-- Migration 098: track HOW a poll was opened (admin vs auto-schedule)
-- ============================================================================
--
-- Adds a small audit trail to each poll so the UI can show who opened it:
--   * created_source  — 'admin' (a person opened it) or 'auto' (the weekly
--                        auto-schedule opened it, client OR server path).
--   * created_by_name — denormalized display name of the opening admin,
--                        snapshotted at creation time. NULL for 'auto'.
--
-- Why denormalize the name? group_members (user_id → display_name / player)
-- is NOT loaded into the client cache, so a viewer can't resolve created_by
-- (a user_id) to a name. Storing the name on the poll lets every viewer show
-- "opened by X" without an extra fetch, and doubles as an audit snapshot (a
-- later rename doesn't rewrite history).
--
-- create_game_poll gains an optional p_source param (defaults to 'admin', so
-- existing callers are unaffected) and resolves the creator's name. The
-- server cron from migration 097 stamps 'auto' with a NULL name.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, guarded CHECK, CREATE OR REPLACE.
-- ============================================================================

ALTER TABLE game_polls
  ADD COLUMN IF NOT EXISTS created_source text NOT NULL DEFAULT 'admin';

ALTER TABLE game_polls
  ADD COLUMN IF NOT EXISTS created_by_name text;

DO $$
BEGIN
  ALTER TABLE game_polls
    ADD CONSTRAINT game_polls_created_source_chk
    CHECK (created_source IN ('admin', 'auto'));
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

-- ── create_game_poll: add p_source + resolve creator name ──
-- Adding a trailing param with a default would otherwise leave the OLD 7-arg
-- overload in place alongside the new one, making a 7-arg named call ambiguous
-- (PostgREST PGRST203). Drop the old signature first; the new 8-arg version is
-- a strict superset (callable identically with 7 args via the p_source default).
DROP FUNCTION IF EXISTS public.create_game_poll(uuid, jsonb, integer, integer, text, boolean, text);

CREATE OR REPLACE FUNCTION public.create_game_poll(
  p_group_id uuid,
  p_dates jsonb,
  p_target integer DEFAULT 8,
  p_expansion_delay integer DEFAULT 48,
  p_default_location text DEFAULT NULL::text,
  p_allow_maybe boolean DEFAULT true,
  p_note text DEFAULT NULL::text,
  p_source text DEFAULT 'admin'
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

  -- Snapshot the opening admin's display name (prefer the member's explicit
  -- display_name, fall back to their linked player's name).
  SELECT COALESCE(NULLIF(gm.display_name, ''), pl.name)
    INTO v_creator_name
    FROM group_members gm
    LEFT JOIN players pl ON pl.id = gm.player_id
   WHERE gm.user_id = auth.uid() AND gm.group_id = p_group_id
   LIMIT 1;

  INSERT INTO game_polls (
    group_id, created_by, status, target_player_count,
    expansion_delay_hours, default_location, allow_maybe, note,
    created_source, created_by_name
  )
  VALUES (
    p_group_id, auth.uid(), 'open', p_target,
    p_expansion_delay, p_default_location, p_allow_maybe, p_note,
    v_source, CASE WHEN v_source = 'auto' THEN NULL ELSE v_creator_name END
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

-- ── Server cron (migration 097): stamp 'auto' on the polls it opens ──
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
      created_source, created_by_name
    ) VALUES (
      v_g.group_id, v_owner, 'open', COALESCE(v_g.dtarget, 7),
      COALESCE(v_g.ddelay, 48), NULL, COALESCE(v_g.dmaybe, true), NULL,
      'auto', NULL
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

-- ── Backfill existing polls' creator name (informational; new column only) ──
-- Leaves created_source = 'admin' (the default) for all historical rows — we
-- can't retroactively tell which past polls were auto-opened, and treating
-- them as admin-opened is the safe, non-misleading default.
UPDATE game_polls p
SET created_by_name = COALESCE(NULLIF(gm.display_name, ''), pl.name)
FROM group_members gm
LEFT JOIN players pl ON pl.id = gm.player_id
WHERE gm.user_id = p.created_by
  AND gm.group_id = p.group_id
  AND p.created_by_name IS NULL;
