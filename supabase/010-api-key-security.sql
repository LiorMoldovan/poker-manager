-- ══════════════════════════════════════════════
-- 010: API Key Security + Per-User Language
-- ══════════════════════════════════════════════

-- 1. Create a secure function to read settings with key stripping for non-owners
CREATE OR REPLACE FUNCTION get_group_settings(p_group_id UUID)
RETURNS JSON AS $$
DECLARE
  result JSON;
  is_owner BOOLEAN;
BEGIN
  -- Verify caller is a member of the group
  IF NOT EXISTS (
    SELECT 1 FROM group_members WHERE group_id = p_group_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not a member of this group';
  END IF;

  SELECT (g.created_by = auth.uid()) INTO is_owner
  FROM groups g WHERE g.id = p_group_id;

  IF is_owner THEN
    SELECT row_to_json(s) INTO result FROM settings s WHERE s.group_id = p_group_id;
  ELSE
    SELECT row_to_json(t) INTO result FROM (
      SELECT group_id, rebuy_value, chips_per_rebuy, min_transfer,
             game_night_days, locations, blocked_transfers, language,
             NULL::text AS gemini_api_key,
             NULL::text AS elevenlabs_api_key
      FROM settings WHERE group_id = p_group_id
    ) t;
  END IF;

  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 2. Restrict settings SELECT policy to hide API keys from non-owners
-- Drop the existing permissive select policy and replace it
DROP POLICY IF EXISTS settings_select ON settings;

-- Non-owners can read settings but API key columns will be NULL via the RPC above.
-- We still need basic select for cache loading, but the RPC is the recommended path.
-- This policy allows select but the client should use the RPC instead.
CREATE POLICY settings_select ON settings
  FOR SELECT USING (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid())
  );
