-- Migration 016: RPC to get member counts for multiple groups
-- Needed because the self-referential RLS on group_members doesn't resolve
-- correctly for direct SELECT queries via PostgREST.

CREATE OR REPLACE FUNCTION get_group_member_counts(p_group_ids UUID[])
RETURNS TABLE(group_id UUID, member_count BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
    SELECT gm.group_id, COUNT(*)::BIGINT AS member_count
    FROM group_members gm
    WHERE gm.group_id = ANY(p_group_ids)
      AND gm.group_id IN (
        SELECT gm2.group_id FROM group_members gm2 WHERE gm2.user_id = auth.uid()
      )
    GROUP BY gm.group_id;
END;
$$;
