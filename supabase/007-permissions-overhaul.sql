-- ============================================================
-- Phase 7: Permissions Overhaul
-- Run in Supabase SQL Editor after 006-supabase-improvements.sql
--
-- Changes:
--   1. super_admins table (platform-level admin)
--   2. training_enabled flag on groups
--   3. Viewer role removal (migrate to member)
--   4. Fix update_member_role RPC (remove viewer)
--   5. Fix gm_self_join RLS (viewer → member)
--   6. Fix fetch_group_members_with_email sort
--   7. get_global_stats RPC (super admin)
--   8. reassign_group_owner RPC (super admin)
-- ============================================================

-- ══════════════════════════════════════════════
-- 1. Super Admins Table
-- Platform-level admin(s) with cross-group visibility.
-- ══════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS super_admins (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE super_admins ENABLE ROW LEVEL SECURITY;

CREATE POLICY "super_admins_read_self" ON super_admins
  FOR SELECT USING (auth.uid() = user_id);

-- ══════════════════════════════════════════════
-- 2. Training Enabled Flag on Groups
-- Super admin toggles per group from dashboard.
-- ══════════════════════════════════════════════

ALTER TABLE groups ADD COLUMN IF NOT EXISTS training_enabled BOOLEAN NOT NULL DEFAULT false;

-- ══════════════════════════════════════════════
-- 3. Remove Viewer Role
-- Migrate all viewers to members, then tighten
-- the CHECK constraint.
-- ══════════════════════════════════════════════

UPDATE group_members SET role = 'member' WHERE role = 'viewer';

ALTER TABLE group_members DROP CONSTRAINT IF EXISTS group_members_role_check;
ALTER TABLE group_members ADD CONSTRAINT group_members_role_check
  CHECK (role IN ('admin', 'member'));

-- ══════════════════════════════════════════════
-- 4. Fix update_member_role — remove 'viewer' from whitelist
-- ══════════════════════════════════════════════

CREATE OR REPLACE FUNCTION update_member_role(
  target_user_id UUID,
  new_role TEXT
)
RETURNS VOID AS $$
DECLARE
  caller_group UUID;
  caller_role TEXT;
  target_role TEXT;
  group_owner UUID;
BEGIN
  IF new_role NOT IN ('admin', 'member') THEN
    RAISE EXCEPTION 'Invalid role';
  END IF;

  SELECT gm.group_id, gm.role INTO caller_group, caller_role
  FROM group_members gm WHERE gm.user_id = auth.uid() LIMIT 1;

  IF caller_role != 'admin' THEN
    RAISE EXCEPTION 'Only admins can change roles';
  END IF;

  SELECT created_by INTO group_owner FROM groups WHERE id = caller_group;

  IF target_user_id = group_owner THEN
    RAISE EXCEPTION 'Cannot change the group owner role';
  END IF;

  SELECT gm.role INTO target_role
  FROM group_members gm WHERE gm.user_id = target_user_id AND gm.group_id = caller_group;

  IF target_role IS NULL THEN
    RAISE EXCEPTION 'User is not in this group';
  END IF;

  IF target_role = 'admin' AND auth.uid() != group_owner THEN
    RAISE EXCEPTION 'Only the group owner can change admin roles';
  END IF;

  UPDATE group_members
  SET role = new_role
  WHERE user_id = target_user_id AND group_id = caller_group;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ══════════════════════════════════════════════
-- 5. Fix gm_self_join RLS — viewer → member
-- Backup policy for direct inserts (RPCs handle real joins).
-- ══════════════════════════════════════════════

DROP POLICY IF EXISTS "gm_self_join" ON group_members;
CREATE POLICY "gm_self_join" ON group_members
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    AND role = 'member'
  );

-- ══════════════════════════════════════════════
-- 6. Fix fetch_group_members_with_email sort
-- Remove implicit viewer ELSE clause.
-- ══════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fetch_group_members_with_email()
RETURNS JSON AS $$
DECLARE
  caller_group UUID;
  caller_role TEXT;
  result JSON;
BEGIN
  SELECT gm.group_id, gm.role INTO caller_group, caller_role
  FROM group_members gm WHERE gm.user_id = auth.uid() LIMIT 1;

  IF caller_role != 'admin' THEN
    RAISE EXCEPTION 'Only admins can view member emails';
  END IF;

  SELECT json_agg(row_to_json(t)) INTO result
  FROM (
    SELECT
      gm.user_id,
      gm.display_name,
      gm.role,
      gm.player_id,
      p.name AS player_name,
      au.email
    FROM group_members gm
    LEFT JOIN players p ON p.id = gm.player_id
    LEFT JOIN auth.users au ON au.id = gm.user_id
    WHERE gm.group_id = caller_group
    ORDER BY
      CASE gm.role WHEN 'admin' THEN 0 WHEN 'member' THEN 1 END,
      gm.display_name
  ) t;

  RETURN COALESCE(result, '[]'::json);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ══════════════════════════════════════════════
-- 7. Global Stats RPC (super admin only)
-- Returns cross-group statistics + orphan detection.
-- ══════════════════════════════════════════════

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

-- ══════════════════════════════════════════════
-- 8. Reassign Group Owner (super admin only)
-- For orphaned groups or manual ownership transfer.
-- ══════════════════════════════════════════════

CREATE OR REPLACE FUNCTION reassign_group_owner(
  target_group_id UUID,
  new_owner_id UUID
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  target_membership RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM super_admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Not a super admin';
  END IF;

  SELECT gm.id, gm.role INTO target_membership
  FROM group_members gm
  WHERE gm.user_id = new_owner_id AND gm.group_id = target_group_id;

  IF target_membership.id IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of this group';
  END IF;

  UPDATE group_members SET role = 'admin'
  WHERE user_id = new_owner_id AND group_id = target_group_id;

  UPDATE groups SET created_by = new_owner_id
  WHERE id = target_group_id;
END;
$$;

-- ══════════════════════════════════════════════
-- 9. Toggle Training (super admin only)
-- Used from the super admin dashboard.
-- ══════════════════════════════════════════════

CREATE OR REPLACE FUNCTION toggle_group_training(
  target_group_id UUID,
  enabled BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM super_admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Not a super admin';
  END IF;

  UPDATE groups SET training_enabled = enabled
  WHERE id = target_group_id;
END;
$$;

-- ══════════════════════════════════════════════
-- DONE — Verify with:
--   SELECT * FROM super_admins;
--   SELECT column_name FROM information_schema.columns
--     WHERE table_name = 'groups' AND column_name = 'training_enabled';
--   SELECT conname FROM pg_constraint
--     WHERE conname = 'group_members_role_check';
--   SELECT proname FROM pg_proc
--     WHERE proname IN ('get_global_stats', 'reassign_group_owner', 'toggle_group_training');
-- ══════════════════════════════════════════════
