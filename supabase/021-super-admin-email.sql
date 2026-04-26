-- ============================================================
-- Phase 21: Super Admin Email RPC
-- Run in Supabase SQL Editor after 020-fix-zero-sum-trigger.sql
--
-- Adds RPC to get super admin email(s) for notifications.
-- Any group member can call it (SECURITY DEFINER to access auth.users).
-- ============================================================

CREATE OR REPLACE FUNCTION get_super_admin_emails()
RETURNS TEXT[] AS $$
DECLARE
  emails TEXT[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM group_members WHERE user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not authenticated as a group member';
  END IF;

  SELECT array_agg(u.email)
    INTO emails
    FROM super_admins sa
    JOIN auth.users u ON u.id = sa.user_id;

  RETURN COALESCE(emails, ARRAY[]::TEXT[]);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
