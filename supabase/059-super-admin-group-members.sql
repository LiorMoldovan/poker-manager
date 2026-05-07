-- ============================================================
-- Phase 59: Super Admin → Group Members detail RPC
-- Run in Supabase SQL Editor after 058-auto-lock-voting-on-target.sql
--
-- Background: the super-admin dashboard ("Other groups" sub-tab in
-- Settings) shows a per-group chip "👥 N · 🃏 M" with member and
-- completed-game counts. Counts alone don't answer "who are these 4
-- people?" — every drill-down ended in a manual SQL lookup. This RPC
-- exposes the member list (role, linked player name, email, joined-at)
-- for a single group, scoped to super admins only so other groups'
-- emails never leak to regular admins/members.
--
-- Why a separate RPC (not folded into get_global_stats):
--   * Privacy boundary stays explicit and easy to audit.
--   * Lazy-loaded only when a card is expanded — no payload bloat
--     for the dashboard's initial load (which already fans out across
--     every group + 30-day windows + activity_log subqueries).
--
-- Returns JSON to keep the client side mapping uniform with
-- get_global_stats. Empty array if the group has no rows (rather than
-- NULL) so the caller doesn't need a null-check before iterating.
-- ============================================================

CREATE OR REPLACE FUNCTION get_group_members_for_super_admin(target_group_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  result JSON;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM super_admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Not a super admin';
  END IF;

  SELECT COALESCE(
    json_agg(
      json_build_object(
        'user_id',            gm.user_id,
        'role',               gm.role,
        'player_id',          gm.player_id,
        'linked_player_name', p.name,
        'email',              u.email,
        'joined_at',          gm.joined_at
      )
      ORDER BY
        CASE gm.role WHEN 'admin' THEN 0 ELSE 1 END,
        gm.joined_at ASC
    ),
    '[]'::json
  )
  INTO result
  FROM group_members gm
  LEFT JOIN players p     ON p.id = gm.player_id
  LEFT JOIN auth.users u  ON u.id = gm.user_id
  WHERE gm.group_id = target_group_id;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION get_group_members_for_super_admin(UUID) TO authenticated;
