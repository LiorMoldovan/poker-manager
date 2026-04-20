-- ============================================================
-- Migration 017: Add player_count to get_global_stats RPC
-- Run in Supabase SQL Editor after 016
--
-- Adds per-group player_count to the global stats response
-- so the super admin dashboard can show players vs registered.
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
          (SELECT max(ga.date) FROM games ga WHERE ga.group_id = gr.id) AS last_game_date
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
