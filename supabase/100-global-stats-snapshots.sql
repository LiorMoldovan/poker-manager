-- ============================================================================
-- Migration 100: daily snapshots of platform totals → growth deltas
-- ============================================================================
--
-- Super Admin asked to see how the overall player count and registered-user
-- count CHANGE over time (not just the current totals). There was no history
-- to diff against, so this adds a tiny once-a-day snapshot:
--
--   * global_stats_snapshots — one row per (Israel) day with total_players
--     and total_users, matching get_global_stats' exact definitions
--     (players = count(*) FROM players; users = count(DISTINCT user_id)
--     FROM group_members).
--   * fn_capture_global_stats_snapshot() — upserts today's row; run daily by
--     pg_cron and seeded once here so there's an immediate baseline.
--   * get_global_stats() now also returns players_delta_7d / _30d and
--     users_delta_7d / _30d (current minus the closest snapshot on-or-before
--     today-7 / today-30; falls back to the earliest snapshot, then to the
--     current value → 0 when no history exists yet).
--
-- Deltas read 0 until snapshots accumulate (history starts today). Cross-
-- device & persistent. Idempotent: IF NOT EXISTS, guarded policy, CREATE OR
-- REPLACE, unschedule+schedule.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.global_stats_snapshots (
  snapshot_date date PRIMARY KEY,
  total_players integer NOT NULL,
  total_users   integer NOT NULL,
  captured_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.global_stats_snapshots ENABLE ROW LEVEL SECURITY;

-- Read-only to super admins; no write policies → only the SECURITY DEFINER
-- capture function (which runs as table owner) can insert/update.
DO $$
BEGIN
  CREATE POLICY global_stats_snapshots_super_admin_read
    ON public.global_stats_snapshots
    FOR SELECT
    USING (EXISTS (SELECT 1 FROM super_admins WHERE user_id = auth.uid()));
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

CREATE OR REPLACE FUNCTION public.fn_capture_global_stats_snapshot()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO global_stats_snapshots (snapshot_date, total_players, total_users)
  VALUES (
    (now() AT TIME ZONE 'Asia/Jerusalem')::date,
    (SELECT count(*) FROM players),
    (SELECT count(DISTINCT user_id) FROM group_members)
  )
  ON CONFLICT (snapshot_date) DO UPDATE
    SET total_players = excluded.total_players,
        total_users   = excluded.total_users,
        captured_at   = now();
END;
$function$;

-- Seed today's baseline immediately.
SELECT public.fn_capture_global_stats_snapshot();

-- Daily capture at 21:15 UTC (~00:15 Israel) — end-of-day snapshot.
DO $$
BEGIN
  PERFORM cron.unschedule('capture-global-stats-snapshot');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'capture-global-stats-snapshot',
  '15 21 * * *',
  $$SELECT public.fn_capture_global_stats_snapshot();$$
);

-- ── get_global_stats: add players/users growth deltas (7d & 30d) ──
-- Preserves every existing field; adds four delta numbers computed from the
-- snapshot history.
CREATE OR REPLACE FUNCTION public.get_global_stats()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  result    JSON;
  v_players INT := (SELECT count(*) FROM players);
  v_users   INT := (SELECT count(DISTINCT user_id) FROM group_members);
  v_p7  INT; v_p30 INT; v_u7 INT; v_u30 INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM super_admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Not a super admin';
  END IF;

  v_p7  := COALESCE((SELECT total_players FROM global_stats_snapshots WHERE snapshot_date <= current_date - 7  ORDER BY snapshot_date DESC LIMIT 1),
                    (SELECT total_players FROM global_stats_snapshots ORDER BY snapshot_date ASC LIMIT 1), v_players);
  v_p30 := COALESCE((SELECT total_players FROM global_stats_snapshots WHERE snapshot_date <= current_date - 30 ORDER BY snapshot_date DESC LIMIT 1),
                    (SELECT total_players FROM global_stats_snapshots ORDER BY snapshot_date ASC LIMIT 1), v_players);
  v_u7  := COALESCE((SELECT total_users FROM global_stats_snapshots WHERE snapshot_date <= current_date - 7  ORDER BY snapshot_date DESC LIMIT 1),
                    (SELECT total_users FROM global_stats_snapshots ORDER BY snapshot_date ASC LIMIT 1), v_users);
  v_u30 := COALESCE((SELECT total_users FROM global_stats_snapshots WHERE snapshot_date <= current_date - 30 ORDER BY snapshot_date DESC LIMIT 1),
                    (SELECT total_users FROM global_stats_snapshots ORDER BY snapshot_date ASC LIMIT 1), v_users);

  SELECT json_build_object(
    'total_groups', (SELECT count(*) FROM groups),
    'total_users', v_users,
    'total_games', (SELECT count(*) FROM games),
    'total_players', v_players,
    'players_delta_7d',  v_players - v_p7,
    'players_delta_30d', v_players - v_p30,
    'users_delta_7d',    v_users - v_u7,
    'users_delta_30d',   v_users - v_u30,
    'total_active_users_7d', (
      SELECT count(DISTINCT player_name)
      FROM activity_log
      WHERE timestamp > now() - interval '7 days'
        AND player_name IS NOT NULL
    ),
    'total_training_players', (
      SELECT count(DISTINCT ta.player_name)
      FROM training_answers ta
      WHERE EXISTS (
        SELECT 1 FROM jsonb_array_elements(ta.sessions) AS s
        WHERE (s->>'date')::timestamptz > now() - interval '7 days'
      )
    ),
    'groups', (
      SELECT COALESCE(json_agg(g ORDER BY g.created_at DESC), '[]'::json)
      FROM (
        SELECT
          gr.id,
          gr.name,
          gr.created_at,
          gr.created_by,
          gr.training_enabled,
          owner_u.email AS owner_email,
          (SELECT count(*) FROM group_members gm WHERE gm.group_id = gr.id) AS member_count,
          (SELECT count(*) FROM players p WHERE p.group_id = gr.id) AS player_count,
          (SELECT count(*) FROM games ga WHERE ga.group_id = gr.id) AS game_count,
          (SELECT count(*) FROM games ga WHERE ga.group_id = gr.id AND ga.status = 'completed') AS completed_game_count,
          (SELECT max(ga.date) FROM games ga WHERE ga.group_id = gr.id) AS last_game_date,
          (SELECT count(DISTINCT al.player_name)
           FROM activity_log al
           WHERE al.group_id = gr.id AND al.timestamp > now() - interval '7 days'
             AND al.player_name IS NOT NULL
          ) AS active_users_7d,
          (SELECT count(*)
           FROM activity_log al
           WHERE al.group_id = gr.id AND al.timestamp > now() - interval '30 days'
          ) AS sessions_30d,
          (SELECT count(*)
           FROM training_answers ta
           WHERE ta.group_id = gr.id
             AND EXISTS (
               SELECT 1 FROM jsonb_array_elements(ta.sessions) AS s
               WHERE (s->>'date')::timestamptz > now() - interval '7 days'
             )
          ) AS training_players,
          (SELECT count(*)
           FROM training_answers ta WHERE ta.group_id = gr.id
          ) AS training_players_total,
          (SELECT COALESCE(
            json_agg(json_build_object('screen', sq.screen, 'users', sq.user_count) ORDER BY sq.user_count DESC),
            '[]'::json
          )
           FROM (
             SELECT s.screen, count(DISTINCT al2.player_name) AS user_count
             FROM activity_log al2,
                  jsonb_array_elements_text(al2.screens_visited) AS s(screen)
             WHERE al2.group_id = gr.id
               AND al2.player_name IS NOT NULL
             GROUP BY s.screen
             ORDER BY user_count DESC
             LIMIT 8
           ) sq
          ) AS feature_adoption
        FROM groups gr
        LEFT JOIN auth.users owner_u ON owner_u.id = gr.created_by
      ) g
    ),
    'orphaned_groups', (
      SELECT COALESCE(json_agg(og), '[]'::json)
      FROM (
        SELECT gr.id, gr.name, gr.created_at, gr.created_by
        FROM groups gr
        WHERE NOT EXISTS (
          SELECT 1 FROM auth.users au WHERE au.id = gr.created_by
        )
      ) og
    )
  ) INTO result;

  RETURN result;
END;
$function$;
