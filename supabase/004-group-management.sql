-- ============================================================
-- Phase 4: Group Management — RPCs, schema tweaks, indexes
-- Run AFTER 002-auth-support.sql has been applied.
-- ============================================================

-- 1. Add display_name to group_members (for showing account name in member list)
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS display_name TEXT;

-- 2. Add per-group API key columns to settings
ALTER TABLE settings ADD COLUMN IF NOT EXISTS gemini_api_key TEXT;
ALTER TABLE settings ADD COLUMN IF NOT EXISTS elevenlabs_api_key TEXT;

-- 3. Partial unique index: prevent two members linking to the same player
CREATE UNIQUE INDEX IF NOT EXISTS idx_gm_unique_player
  ON group_members(group_id, player_id) WHERE player_id IS NOT NULL;

-- 4. Fix group_members.player_id FK to SET NULL on player delete
--    (so deleting a player unlinks the member instead of blocking)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'group_members_player_id_fkey'
      AND table_name = 'group_members'
  ) THEN
    ALTER TABLE group_members DROP CONSTRAINT group_members_player_id_fkey;
  END IF;
  ALTER TABLE group_members
    ADD CONSTRAINT group_members_player_id_fkey
    FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE SET NULL;
END;
$$;

-- ============================================================
-- RPCs (all SECURITY DEFINER to bypass RLS, with internal checks)
-- ============================================================

-- 5. Updated create_group: accepts display_name, auto-creates player for owner
CREATE OR REPLACE FUNCTION create_group(group_name TEXT, display_name TEXT DEFAULT NULL)
RETURNS JSON AS $$
DECLARE
  new_group_id UUID;
  new_code TEXT;
  owner_name TEXT;
  new_player_id UUID;
BEGIN
  new_code := substr(md5(random()::text), 1, 6);
  owner_name := COALESCE(NULLIF(TRIM(display_name), ''), split_part(
    (SELECT email FROM auth.users WHERE id = auth.uid()), '@', 1
  ));

  INSERT INTO groups (name, created_by, invite_code)
  VALUES (group_name, auth.uid(), new_code)
  RETURNING id INTO new_group_id;

  INSERT INTO players (group_id, name, type, gender)
  VALUES (new_group_id, owner_name, 'permanent', 'male')
  RETURNING id INTO new_player_id;

  INSERT INTO group_members (group_id, user_id, role, display_name, player_id)
  VALUES (new_group_id, auth.uid(), 'admin', owner_name, new_player_id);

  INSERT INTO settings (group_id) VALUES (new_group_id);

  RETURN json_build_object(
    'group_id', new_group_id,
    'invite_code', new_code,
    'player_id', new_player_id
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 6. Updated join_group_by_invite: populates display_name
CREATE OR REPLACE FUNCTION join_group_by_invite(code TEXT, display_name TEXT DEFAULT NULL)
RETURNS JSON AS $$
DECLARE
  found_group_id UUID;
  found_group_name TEXT;
  member_name TEXT;
BEGIN
  SELECT id, name INTO found_group_id, found_group_name
  FROM groups WHERE invite_code = code;

  IF found_group_id IS NULL THEN
    RAISE EXCEPTION 'Invalid invite code';
  END IF;

  member_name := COALESCE(NULLIF(TRIM(display_name), ''), split_part(
    (SELECT email FROM auth.users WHERE id = auth.uid()), '@', 1
  ));

  INSERT INTO group_members (group_id, user_id, role, display_name)
  VALUES (found_group_id, auth.uid(), 'member', member_name)
  ON CONFLICT (group_id, user_id) DO NOTHING;

  RETURN json_build_object('group_id', found_group_id, 'group_name', found_group_name);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 7. Updated link_member_to_player: checks uniqueness
CREATE OR REPLACE FUNCTION link_member_to_player(target_player_id UUID)
RETURNS VOID AS $$
DECLARE
  target_group UUID;
BEGIN
  SELECT group_id INTO target_group FROM players WHERE id = target_player_id;

  IF EXISTS (
    SELECT 1 FROM group_members
    WHERE group_id = target_group AND player_id = target_player_id AND user_id != auth.uid()
  ) THEN
    RAISE EXCEPTION 'Player already linked to another member';
  END IF;

  UPDATE group_members
  SET player_id = target_player_id
  WHERE user_id = auth.uid() AND group_id = target_group;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 8. Self-create player and link: for new users not in the player list
CREATE OR REPLACE FUNCTION self_create_and_link(player_name TEXT)
RETURNS JSON AS $$
DECLARE
  caller_group UUID;
  new_player_id UUID;
BEGIN
  SELECT group_id INTO caller_group
  FROM group_members WHERE user_id = auth.uid() LIMIT 1;

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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 9. Update member role (owner-aware security)
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
  IF new_role NOT IN ('admin', 'member', 'viewer') THEN
    RAISE EXCEPTION 'Invalid role';
  END IF;

  SELECT gm.group_id, gm.role INTO caller_group, caller_role
  FROM group_members gm WHERE gm.user_id = auth.uid() LIMIT 1;

  IF caller_role != 'admin' THEN
    RAISE EXCEPTION 'Only admins can change roles';
  END IF;

  SELECT created_by INTO group_owner FROM groups WHERE id = caller_group;

  -- Cannot modify the owner's role
  IF target_user_id = group_owner THEN
    RAISE EXCEPTION 'Cannot change the group owner role';
  END IF;

  SELECT gm.role INTO target_role
  FROM group_members gm WHERE gm.user_id = target_user_id AND gm.group_id = caller_group;

  IF target_role IS NULL THEN
    RAISE EXCEPTION 'User is not in this group';
  END IF;

  -- Only the owner can modify another admin
  IF target_role = 'admin' AND auth.uid() != group_owner THEN
    RAISE EXCEPTION 'Only the group owner can change admin roles';
  END IF;

  UPDATE group_members
  SET role = new_role
  WHERE user_id = target_user_id AND group_id = caller_group;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 10. Remove group member (owner-aware security)
CREATE OR REPLACE FUNCTION remove_group_member(target_user_id UUID)
RETURNS VOID AS $$
DECLARE
  caller_group UUID;
  caller_role TEXT;
  target_role TEXT;
  group_owner UUID;
BEGIN
  SELECT gm.group_id, gm.role INTO caller_group, caller_role
  FROM group_members gm WHERE gm.user_id = auth.uid() LIMIT 1;

  IF caller_role != 'admin' THEN
    RAISE EXCEPTION 'Only admins can remove members';
  END IF;

  SELECT created_by INTO group_owner FROM groups WHERE id = caller_group;

  -- Cannot remove the owner
  IF target_user_id = group_owner THEN
    RAISE EXCEPTION 'Cannot remove the group owner. Transfer ownership first.';
  END IF;

  SELECT gm.role INTO target_role
  FROM group_members gm WHERE gm.user_id = target_user_id AND gm.group_id = caller_group;

  IF target_role IS NULL THEN
    RAISE EXCEPTION 'User is not in this group';
  END IF;

  -- Only owner can remove an admin
  IF target_role = 'admin' AND auth.uid() != group_owner THEN
    RAISE EXCEPTION 'Only the group owner can remove admins';
  END IF;

  DELETE FROM group_members
  WHERE user_id = target_user_id AND group_id = caller_group;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 11. Transfer ownership
CREATE OR REPLACE FUNCTION transfer_ownership(new_owner_id UUID)
RETURNS VOID AS $$
DECLARE
  caller_group UUID;
  group_owner UUID;
  target_membership UUID;
BEGIN
  SELECT gm.group_id INTO caller_group
  FROM group_members gm WHERE gm.user_id = auth.uid() LIMIT 1;

  SELECT created_by INTO group_owner FROM groups WHERE id = caller_group;

  IF auth.uid() != group_owner THEN
    RAISE EXCEPTION 'Only the group owner can transfer ownership';
  END IF;

  SELECT gm.id INTO target_membership
  FROM group_members gm WHERE gm.user_id = new_owner_id AND gm.group_id = caller_group;

  IF target_membership IS NULL THEN
    RAISE EXCEPTION 'Target user is not a member of this group';
  END IF;

  -- Ensure new owner is admin
  UPDATE group_members SET role = 'admin'
  WHERE user_id = new_owner_id AND group_id = caller_group;

  -- Transfer ownership
  UPDATE groups SET created_by = new_owner_id WHERE id = caller_group;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 12. Regenerate invite code (owner only)
CREATE OR REPLACE FUNCTION regenerate_invite_code()
RETURNS TEXT AS $$
DECLARE
  caller_group UUID;
  group_owner UUID;
  new_code TEXT;
BEGIN
  SELECT gm.group_id INTO caller_group
  FROM group_members gm WHERE gm.user_id = auth.uid() LIMIT 1;

  SELECT created_by INTO group_owner FROM groups WHERE id = caller_group;

  IF auth.uid() != group_owner THEN
    RAISE EXCEPTION 'Only the group owner can regenerate the invite code';
  END IF;

  new_code := substr(md5(random()::text), 1, 6);
  UPDATE groups SET invite_code = new_code WHERE id = caller_group;

  RETURN new_code;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 13. Player invites table — personal invite codes tied to a specific player
CREATE TABLE IF NOT EXISTS player_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  invite_code TEXT NOT NULL UNIQUE,
  created_by UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_by UUID REFERENCES auth.users(id),
  used_at TIMESTAMPTZ,
  UNIQUE(group_id, player_id)
);

ALTER TABLE player_invites ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'pi_admin_read' AND tablename = 'player_invites') THEN
    CREATE POLICY pi_admin_read ON player_invites FOR SELECT
      USING (group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid() AND role = 'admin'));
  END IF;
END $$;

-- 14. Create a personal invite for a specific player (admin only)
CREATE OR REPLACE FUNCTION create_player_invite(target_player_id UUID)
RETURNS JSON AS $$
DECLARE
  caller_group UUID;
  caller_role TEXT;
  player_group UUID;
  player_name_val TEXT;
  new_code TEXT;
  existing_code TEXT;
BEGIN
  SELECT gm.group_id, gm.role INTO caller_group, caller_role
  FROM group_members gm WHERE gm.user_id = auth.uid() LIMIT 1;

  IF caller_role != 'admin' THEN
    RAISE EXCEPTION 'Only admins can create player invites';
  END IF;

  SELECT group_id, name INTO player_group, player_name_val
  FROM players WHERE id = target_player_id;

  IF player_group IS NULL OR player_group != caller_group THEN
    RAISE EXCEPTION 'Player not found in your group';
  END IF;

  -- Check if player is already linked to a member
  IF EXISTS (
    SELECT 1 FROM group_members
    WHERE group_id = caller_group AND player_id = target_player_id
  ) THEN
    RAISE EXCEPTION 'Player is already linked to a member';
  END IF;

  -- Return existing unused invite if one exists
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 15. Join group via personal player invite (auto-links to player)
CREATE OR REPLACE FUNCTION join_group_by_player_invite(code TEXT, display_name TEXT DEFAULT NULL)
RETURNS JSON AS $$
DECLARE
  inv RECORD;
  member_name TEXT;
  found_group_name TEXT;
BEGIN
  SELECT pi.*, p.name AS player_name
  INTO inv
  FROM player_invites pi
  JOIN players p ON p.id = pi.player_id
  WHERE pi.invite_code = code AND pi.used_by IS NULL;

  IF inv IS NULL THEN
    RETURN NULL;
  END IF;

  member_name := COALESCE(NULLIF(TRIM(display_name), ''), split_part(
    (SELECT email FROM auth.users WHERE id = auth.uid()), '@', 1
  ));

  SELECT name INTO found_group_name FROM groups WHERE id = inv.group_id;

  -- Insert as member with player already linked
  INSERT INTO group_members (group_id, user_id, role, display_name, player_id)
  VALUES (inv.group_id, auth.uid(), 'member', member_name, inv.player_id)
  ON CONFLICT (group_id, user_id) DO UPDATE SET player_id = EXCLUDED.player_id;

  -- Mark invite as used
  UPDATE player_invites
  SET used_by = auth.uid(), used_at = now()
  WHERE id = inv.id;

  RETURN json_build_object(
    'group_id', inv.group_id,
    'group_name', found_group_name,
    'player_id', inv.player_id,
    'player_name', inv.player_name
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 16. Unlink member from player (admin/owner)
CREATE OR REPLACE FUNCTION unlink_member_player(target_user_id UUID)
RETURNS VOID AS $$
DECLARE
  caller_group UUID;
  caller_role TEXT;
BEGIN
  SELECT gm.group_id, gm.role INTO caller_group, caller_role
  FROM group_members gm WHERE gm.user_id = auth.uid() LIMIT 1;

  IF caller_role != 'admin' THEN
    RAISE EXCEPTION 'Only admins can unlink players';
  END IF;

  UPDATE group_members
  SET player_id = NULL
  WHERE user_id = target_user_id AND group_id = caller_group;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 17. Add a registered user to the group by email (admin only, optional player linking)
CREATE OR REPLACE FUNCTION add_member_by_email(
  target_email TEXT,
  target_player_id UUID DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  caller_group UUID;
  caller_role TEXT;
  target_user_id UUID;
  target_display TEXT;
BEGIN
  SELECT gm.group_id, gm.role INTO caller_group, caller_role
  FROM group_members gm WHERE gm.user_id = auth.uid() LIMIT 1;

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
$$ LANGUAGE plpgsql SECURITY DEFINER;
