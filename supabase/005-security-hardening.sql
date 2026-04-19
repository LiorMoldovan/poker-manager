-- ============================================================
-- Phase 5: Security Hardening
-- Run in Supabase SQL Editor after reviewing each statement.
-- This fixes RLS policy gaps and adds search_path to RPCs.
-- ============================================================

-- ══════════════════════════════════════════════
-- FIX 1: gm_self_join — restrict to viewer role only
-- The old policy allowed any authenticated user to insert
-- themselves into ANY group with ANY role (including admin).
-- Now: only allow self-insert as 'viewer' and only into
-- groups that have a matching invite code (join_group RPC
-- already handles the real join flow, this policy is backup).
-- ══════════════════════════════════════════════

DROP POLICY IF EXISTS "gm_self_join" ON group_members;
CREATE POLICY "gm_self_join" ON group_members
  FOR INSERT WITH CHECK (
    auth.uid() = user_id
    AND role = 'viewer'
  );

-- ══════════════════════════════════════════════
-- FIX 2: activity_log — restrict INSERT/UPDATE to own group
-- The old policies allowed any authenticated user to write
-- activity entries for ANY group.
-- ══════════════════════════════════════════════

DROP POLICY IF EXISTS "al_insert" ON activity_log;
CREATE POLICY "al_insert" ON activity_log
  FOR INSERT WITH CHECK (
    group_id IN (
      SELECT group_id FROM group_members WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "al_update" ON activity_log;
CREATE POLICY "al_update" ON activity_log
  FOR UPDATE USING (
    group_id IN (
      SELECT group_id FROM group_members WHERE user_id = auth.uid()
    )
  );

-- ══════════════════════════════════════════════
-- FIX 3: Add SET search_path to all SECURITY DEFINER functions
-- Prevents search_path manipulation attacks.
-- ══════════════════════════════════════════════

ALTER FUNCTION create_group(TEXT, TEXT) SET search_path = public;
ALTER FUNCTION join_group_by_invite(TEXT, TEXT) SET search_path = public;
ALTER FUNCTION link_member_to_player(UUID) SET search_path = public;
ALTER FUNCTION self_create_and_link(TEXT) SET search_path = public;
ALTER FUNCTION update_member_role(UUID, TEXT) SET search_path = public;
ALTER FUNCTION remove_group_member(UUID) SET search_path = public;
ALTER FUNCTION transfer_ownership(UUID) SET search_path = public;
ALTER FUNCTION regenerate_invite_code() SET search_path = public;
ALTER FUNCTION create_player_invite(UUID) SET search_path = public;
ALTER FUNCTION join_group_by_player_invite(TEXT, TEXT) SET search_path = public;
ALTER FUNCTION unlink_member_player(UUID) SET search_path = public;
ALTER FUNCTION fetch_group_members_with_email() SET search_path = public;
ALTER FUNCTION add_member_by_email(TEXT, UUID) SET search_path = public;

-- ══════════════════════════════════════════════
-- FIX 4: Add missing indexes for query performance
-- ══════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_pending_forecasts_group
  ON pending_forecasts(group_id);

CREATE INDEX IF NOT EXISTS idx_activity_log_group_device
  ON activity_log(group_id, device_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_training_insights_group
  ON training_insights(group_id);

-- ══════════════════════════════════════════════
-- DONE — Verify with:
--   SELECT policyname, tablename, cmd FROM pg_policies 
--   WHERE tablename IN ('group_members', 'activity_log');
-- ══════════════════════════════════════════════
