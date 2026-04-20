-- ============================================================
-- Migration 018: Add activity + training stats to get_global_stats
-- Run in Supabase SQL Editor after 017
--
-- Per-group: active_users_7d, sessions_30d, training_players, training_questions
-- Platform-wide: total_active_users_7d, total_training_players
-- ============================================================

CREATE OR REPLACE FUNCTION get_global_stats()
RETURNS JSON
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  result JSON;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM super_admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Not a super admin';
  END IF;

  SELECT json_build_object(
    'total_groups', (SELECT count(*) FROM groups),
    'total_users', (SELECT count(DISTINCT user_id) FROM group_members),
    'total_games', (SELECT count(*) FROM games),
    'total_players', (SELECT count(*) FROM players),
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
$$;
