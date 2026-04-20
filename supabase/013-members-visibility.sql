-- ============================================================
-- Phase 13: Members Visibility Fix
-- Run in Supabase SQL Editor after 012-push-subs-update-policy.sql
--
-- Problem: Non-admin members can't see other group members because
-- fetch_group_members_with_email raises exception for non-admins,
-- and the fallback direct query hits a self-referential RLS policy
-- that doesn't resolve correctly.
--
-- Fix: Allow ALL group members to call the RPC.
-- Admins get emails, members get email = NULL.
-- ============================================================

CREATE OR REPLACE FUNCTION fetch_group_members_with_email(
  p_group_id UUID DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  caller_group UUID;
  caller_role TEXT;
  is_admin BOOLEAN;
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

  IF caller_group IS NULL THEN
    RAISE EXCEPTION 'Not a member of any group';
  END IF;

  is_admin := (caller_role = 'admin');

  SELECT json_agg(row_to_json(t)) INTO result
  FROM (
    SELECT
      gm.user_id,
      gm.display_name,
      gm.role,
      gm.player_id,
      p.name AS player_name,
      CASE WHEN is_admin THEN au.email ELSE NULL END AS email
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
