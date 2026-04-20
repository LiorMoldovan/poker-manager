-- Migration 014: Delete group (owner) and Leave group (member) RPCs

-- Owner-only: permanently delete a group and all its data
-- All child tables use ON DELETE CASCADE, so deleting the group row cascades automatically
CREATE OR REPLACE FUNCTION delete_group(p_group_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Must be the group owner
  IF NOT EXISTS (
    SELECT 1 FROM groups
    WHERE id = p_group_id AND created_by = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Only the group owner can delete the group';
  END IF;

  -- Delete the group — all child rows cascade
  DELETE FROM groups WHERE id = p_group_id;
END;
$$;

-- Any member (except the owner) can leave a group
CREATE OR REPLACE FUNCTION leave_group(p_group_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Owner cannot leave — must transfer ownership or delete the group
  IF EXISTS (
    SELECT 1 FROM groups
    WHERE id = p_group_id AND created_by = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Group owner cannot leave. Transfer ownership first or delete the group.';
  END IF;

  -- Must be a member
  IF NOT EXISTS (
    SELECT 1 FROM group_members
    WHERE group_id = p_group_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not a member of this group';
  END IF;

  DELETE FROM group_members
  WHERE group_id = p_group_id AND user_id = auth.uid();
END;
$$;
