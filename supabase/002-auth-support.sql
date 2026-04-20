-- ============================================================
-- Phase 2: Auth support — invite codes + player linking
-- Run AFTER schema.sql has been applied.
-- ============================================================

-- Add invite code to groups (used for join flow)
ALTER TABLE groups ADD COLUMN IF NOT EXISTS invite_code TEXT UNIQUE;

-- Link group members to their player record
ALTER TABLE group_members ADD COLUMN IF NOT EXISTS player_id UUID REFERENCES players(id);

-- Function: create a group + add creator as admin + generate invite code
CREATE OR REPLACE FUNCTION create_group(group_name TEXT)
RETURNS JSON AS $$
DECLARE
  new_group_id UUID;
  new_code TEXT;
BEGIN
  new_code := substr(md5(random()::text), 1, 6);

  INSERT INTO groups (name, created_by, invite_code)
  VALUES (group_name, auth.uid(), new_code)
  RETURNING id INTO new_group_id;

  INSERT INTO group_members (group_id, user_id, role)
  VALUES (new_group_id, auth.uid(), 'admin');

  RETURN json_build_object('group_id', new_group_id, 'invite_code', new_code);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function: join a group by invite code (adds user as member)
CREATE OR REPLACE FUNCTION join_group_by_invite(code TEXT)
RETURNS JSON AS $$
DECLARE
  found_group_id UUID;
  found_group_name TEXT;
BEGIN
  SELECT id, name INTO found_group_id, found_group_name
  FROM groups WHERE invite_code = code;

  IF found_group_id IS NULL THEN
    RAISE EXCEPTION 'Invalid invite code';
  END IF;

  INSERT INTO group_members (group_id, user_id, role)
  VALUES (found_group_id, auth.uid(), 'member')
  ON CONFLICT (group_id, user_id) DO NOTHING;

  RETURN json_build_object('group_id', found_group_id, 'group_name', found_group_name);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function: link a group member to a player record
CREATE OR REPLACE FUNCTION link_member_to_player(target_player_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE group_members
  SET player_id = target_player_id
  WHERE user_id = auth.uid()
    AND group_id = (SELECT group_id FROM players WHERE id = target_player_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
