-- ============================================================
-- Phase 8: Multi-Group Support
-- Run in Supabase SQL Editor after 007-permissions-overhaul.sql
--
-- Adds p_group_id parameter to 9 RPCs so they work correctly
-- when a user belongs to multiple groups. Uses DEFAULT NULL
-- for backward compatibility: if NULL, falls back to LIMIT 1.
-- ============================================================

-- ══════════════════════════════════════════════
-- 1. self_create_and_link
-- ══════════════════════════════════════════════

CREATE OR REPLACE FUNCTION self_create_and_link(
  player_name TEXT,
  p_group_id UUID DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  caller_group UUID;
  new_player_id UUID;
BEGIN
  IF p_group_id IS NOT NULL THEN
    SELECT group_id INTO caller_group
    FROM group_members WHERE user_id = auth.uid() AND group_id = p_group_id;
  ELSE
    SELECT group_id INTO caller_group
    FROM group_members WHERE user_id = auth.uid()
    ORDER BY joined_at LIMIT 1;
  END IF;

  IF caller_group IS NULL THEN
    RAISE EXCEPTION 'Not a member of any group';
  END IF;

  INSERT INTO players (group_id, name, type, gender)
  VALUES (caller_group, player_name, 'permanent', 'male')
  RETURNING id INTO new_player_id;

  UPDATE group_members
  SET player_id = new_player_id
  WHERE user_id = auth.uid() AND group_id = caller_group;

  RETURN json_build_object('player_id', new_player_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ══════════════════════════════════════════════
-- 2. update_member_role
-- ══════════════════════════════════════════════

CREATE OR REPLACE FUNCTION update_member_role(
  target_user_id UUID,
  new_role TEXT,
  p_group_id UUID DEFAULT NULL
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

  IF p_group_id IS NOT NULL THEN
    SELECT gm.group_id, gm.role INTO caller_group, caller_role
    FROM group_members gm WHERE gm.user_id = auth.uid() AND gm.group_id = p_group_id;
  ELSE
    SELECT gm.group_id, gm.role INTO caller_group, caller_role
    FROM group_members gm WHERE gm.user_id = auth.uid()
    ORDER BY gm.joined_at LIMIT 1;
  END IF;

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
-- 3. remove_group_member
-- ══════════════════════════════════════════════

CREATE OR REPLACE FUNCTION remove_group_member(
  target_user_id UUID,
  p_group_id UUID DEFAULT NULL
)
RETURNS VOID AS $$
DECLARE
  caller_group UUID;
  caller_role TEXT;
  target_role TEXT;
  group_owner UUID;
BEGIN
  IF p_group_id IS NOT NULL THEN
    SELECT gm.group_id, gm.role INTO caller_group, caller_role
    FROM group_members gm WHERE gm.user_id = auth.uid() AND gm.group_id = p_group_id;
  ELSE
    SELECT gm.group_id, gm.role INTO caller_group, caller_role
    FROM group_members gm WHERE gm.user_id = auth.uid()
    ORDER BY gm.joined_at LIMIT 1;
  END IF;

  IF caller_role != 'admin' THEN
    RAISE EXCEPTION 'Only admins can remove members';
  END IF;

  SELECT created_by INTO group_owner FROM groups WHERE id = caller_group;

  IF target_user_id = group_owner THEN
    RAISE EXCEPTION 'Cannot remove the group owner. Transfer ownership first.';
  END IF;

  SELECT gm.role INTO target_role
  FROM group_members gm WHERE gm.user_id = target_user_id AND gm.group_id = caller_group;

  IF target_role IS NULL THEN
    RAISE EXCEPTION 'User is not in this group';
  END IF;

  IF target_role = 'admin' AND auth.uid() != group_owner THEN
    RAISE EXCEPTION 'Only the group owner can remove admins';
  END IF;

  DELETE FROM group_members
  WHERE user_id = target_user_id AND group_id = caller_group;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ══════════════════════════════════════════════
-- 4. transfer_ownership
-- ══════════════════════════════════════════════

CREATE OR REPLACE FUNCTION transfer_ownership(
  new_owner_id UUID,
  p_group_id UUID DEFAULT NULL
)
RETURNS VOID AS $$
DECLARE
  caller_group UUID;
  group_owner UUID;
  target_membership UUID;
BEGIN
  IF p_group_id IS NOT NULL THEN
    SELECT gm.group_id INTO caller_group
    FROM group_members gm WHERE gm.user_id = auth.uid() AND gm.group_id = p_group_id;
  ELSE
    SELECT gm.group_id INTO caller_group
    FROM group_members gm WHERE gm.user_id = auth.uid()
    ORDER BY gm.joined_at LIMIT 1;
  END IF;

  SELECT created_by INTO group_owner FROM groups WHERE id = caller_group;

  IF auth.uid() != group_owner THEN
    RAISE EXCEPTION 'Only the group owner can transfer ownership';
  END IF;

  SELECT gm.id INTO target_membership
  FROM group_members gm WHERE gm.user_id = new_owner_id AND gm.group_id = caller_group;

  IF target_membership IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of this group';
  END IF;

  UPDATE group_members SET role = 'admin'
  WHERE user_id = new_owner_id AND group_id = caller_group;

  UPDATE groups SET created_by = new_owner_id WHERE id = caller_group;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ══════════════════════════════════════════════
-- 5. regenerate_invite_code
-- ══════════════════════════════════════════════

CREATE OR REPLACE FUNCTION regenerate_invite_code(
  p_group_id UUID DEFAULT NULL
)
RETURNS TEXT AS $$
DECLARE
  caller_group UUID;
  group_owner UUID;
  new_code TEXT;
BEGIN
  IF p_group_id IS NOT NULL THEN
    SELECT gm.group_id INTO caller_group
    FROM group_members gm WHERE gm.user_id = auth.uid() AND gm.group_id = p_group_id;
  ELSE
    SELECT gm.group_id INTO caller_group
    FROM group_members gm WHERE gm.user_id = auth.uid()
    ORDER BY gm.joined_at LIMIT 1;
  END IF;

  SELECT created_by INTO group_owner FROM groups WHERE id = caller_group;

  IF auth.uid() != group_owner THEN
    RAISE EXCEPTION 'Only the group owner can regenerate the invite code';
  END IF;

  new_code := substr(md5(random()::text), 1, 6);
  UPDATE groups SET invite_code = new_code WHERE id = caller_group;

  RETURN new_code;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ══════════════════════════════════════════════
-- 6. create_player_invite
-- ══════════════════════════════════════════════

CREATE OR REPLACE FUNCTION create_player_invite(
  target_player_id UUID,
  p_group_id UUID DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  caller_group UUID;
  caller_role TEXT;
  player_group UUID;
  player_name_val TEXT;
  new_code TEXT;
  existing_code TEXT;
BEGIN
  IF p_group_id IS NOT NULL THEN
    SELECT gm.group_id, gm.role INTO caller_group, caller_role
    FROM group_members gm WHERE gm.user_id = auth.uid() AND gm.group_id = p_group_id;
  ELSE
    SELECT gm.group_id, gm.role INTO caller_group, caller_role
    FROM group_members gm WHERE gm.user_id = auth.uid()
    ORDER BY gm.joined_at LIMIT 1;
  END IF;

  IF caller_role != 'admin' THEN
    RAISE EXCEPTION 'Only admins can create player invites';
  END IF;

  SELECT group_id, name INTO player_group, player_name_val
  FROM players WHERE id = target_player_id;

  IF player_group IS NULL OR player_group != caller_group THEN
    RAISE EXCEPTION 'Player not found in your group';
  END IF;

  IF EXISTS (
    SELECT 1 FROM group_members
    WHERE group_id = caller_group AND player_id = target_player_id
  ) THEN
    RAISE EXCEPTION 'Player is already linked to a member';
  END IF;

  SELECT invite_code INTO existing_code
  FROM player_invites
  WHERE group_id = caller_group AND player_id = target_player_id AND used_by IS NULL;

  IF existing_code IS NOT NULL THEN
    RETURN json_build_object(
      'invite_code', existing_code,
      'player_name', player_name_val,
      'already_existed', true
    );
  END IF;

  new_code := substr(md5(random()::text || clock_timestamp()::text), 1, 8);

  INSERT INTO player_invites (group_id, player_id, invite_code, created_by)
  VALUES (caller_group, target_player_id, new_code, auth.uid())
  ON CONFLICT (group_id, player_id)
  DO UPDATE SET invite_code = EXCLUDED.invite_code, used_by = NULL, used_at = NULL, created_at = now();

  RETURN json_build_object(
    'invite_code', new_code,
    'player_name', player_name_val,
    'already_existed', false
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ══════════════════════════════════════════════
-- 7. unlink_member_player
-- ══════════════════════════════════════════════

CREATE OR REPLACE FUNCTION unlink_member_player(
  target_user_id UUID,
  p_group_id UUID DEFAULT NULL
)
RETURNS VOID AS $$
DECLARE
  caller_group UUID;
  caller_role TEXT;
BEGIN
  IF p_group_id IS NOT NULL THEN
    SELECT gm.group_id, gm.role INTO caller_group, caller_role
    FROM group_members gm WHERE gm.user_id = auth.uid() AND gm.group_id = p_group_id;
  ELSE
    SELECT gm.group_id, gm.role INTO caller_group, caller_role
    FROM group_members gm WHERE gm.user_id = auth.uid()
    ORDER BY gm.joined_at LIMIT 1;
  END IF;

  IF caller_role != 'admin' THEN
    RAISE EXCEPTION 'Only admins can unlink players';
  END IF;

  UPDATE group_members
  SET player_id = NULL
  WHERE user_id = target_user_id AND group_id = caller_group;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ══════════════════════════════════════════════
-- 8. fetch_group_members_with_email
-- ══════════════════════════════════════════════

CREATE OR REPLACE FUNCTION fetch_group_members_with_email(
  p_group_id UUID DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  caller_group UUID;
  caller_role TEXT;
  result JSON;
BEGIN
  IF p_group_id IS NOT NULL THEN
    SELECT gm.group_id, gm.role INTO caller_group, caller_role
    FROM group_members gm WHERE gm.user_id = auth.uid() AND gm.group_id = p_group_id;
  ELSE
    SELECT gm.group_id, gm.role INTO caller_group, caller_role
    FROM group_members gm WHERE gm.user_id = auth.uid()
    ORDER BY gm.joined_at LIMIT 1;
  END IF;

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
-- 9. add_member_by_email
-- ══════════════════════════════════════════════

CREATE OR REPLACE FUNCTION add_member_by_email(
  target_email TEXT,
  target_player_id UUID DEFAULT NULL,
  p_group_id UUID DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  caller_group UUID;
  caller_role TEXT;
  target_user_id UUID;
  target_display TEXT;
BEGIN
  IF p_group_id IS NOT NULL THEN
    SELECT gm.group_id, gm.role INTO caller_group, caller_role
    FROM group_members gm WHERE gm.user_id = auth.uid() AND gm.group_id = p_group_id;
  ELSE
    SELECT gm.group_id, gm.role INTO caller_group, caller_role
    FROM group_members gm WHERE gm.user_id = auth.uid()
    ORDER BY gm.joined_at LIMIT 1;
  END IF;

  IF caller_role != 'admin' THEN
    RAISE EXCEPTION 'Only admins can add members';
  END IF;

  SELECT id INTO target_user_id
  FROM auth.users WHERE email = lower(trim(target_email));

  IF target_user_id IS NULL THEN
    RAISE EXCEPTION 'No registered user with this email';
  END IF;

  IF EXISTS (
    SELECT 1 FROM group_members WHERE group_id = caller_group AND user_id = target_user_id
  ) THEN
    RAISE EXCEPTION 'User is already a member of this group';
  END IF;

  target_display := split_part(target_email, '@', 1);

  INSERT INTO group_members (group_id, user_id, role, display_name, player_id)
  VALUES (caller_group, target_user_id, 'member', target_display, target_player_id);

  RETURN json_build_object(
    'user_id', target_user_id,
    'display_name', target_display,
    'player_id', target_player_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ══════════════════════════════════════════════
-- DONE — Verify with:
--   SELECT proname, pronargs FROM pg_proc
--     WHERE proname IN (
--       'self_create_and_link', 'update_member_role', 'remove_group_member',
--       'transfer_ownership', 'regenerate_invite_code', 'create_player_invite',
--       'unlink_member_player', 'fetch_group_members_with_email', 'add_member_by_email'
--     );
-- ══════════════════════════════════════════════
