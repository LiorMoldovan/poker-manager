-- ============================================================
-- Phase 61: Super-admin bypass for fetch_group_members_with_email
-- Run in Supabase SQL Editor after 060-super-admin-cross-group-access.sql
--
-- Goal: let a super admin observing a non-member group read that group's
-- member list (with emails) from the Settings > Group tab.
--
-- Background:
--   * Migration 060 already opened the RLS wall for super-admins on
--     every group-scoped table (`super_admins_full_access` policy), so a
--     direct `select * from group_members where group_id = ?` works.
--   * BUT `fetch_group_members_with_email` is a SECURITY DEFINER RPC
--     that BYPASSES RLS and instead authorizes by reading the caller's
--     own `group_members` row. That row doesn't exist for a super admin
--     observing a foreign group, so the RPC raises 'Not a member of any
--     group' — which is exactly what blocks the Group page from
--     rendering for them.
--
-- Strategy: add an explicit super-admin escape hatch at the top of the
-- RPC. If the caller is in `super_admins`, accept the supplied
-- `p_group_id` (or fail if none was supplied) and treat them as an
-- admin for visibility purposes — meaning they get emails too. We do
-- NOT widen any of the *mutation* RPCs in this migration; observer
-- mode is read-only by current product decision (the UI hides all
-- write affordances). Future migration can extend the same bypass to
-- update_member_role / remove_group_member / transfer_ownership /
-- regenerate_invite_code / unlink_member_player / add_member_by_email
-- / create_player_invite when "owner-equivalent observer" is wired
-- end-to-end.
--
-- Idempotent: CREATE OR REPLACE the existing function, no schema
-- changes, no policy changes. Re-applying does nothing harmful.
-- ============================================================

CREATE OR REPLACE FUNCTION fetch_group_members_with_email(
  p_group_id UUID DEFAULT NULL
)
RETURNS JSON AS $$
DECLARE
  caller_group UUID;
  caller_role TEXT;
  is_super_admin BOOLEAN;
  is_admin BOOLEAN;
  result JSON;
BEGIN
  -- Super-admin escape hatch (added in 061). Must come BEFORE the
  -- membership lookup, otherwise the lookup's NULL result raises and
  -- the bypass never executes. Super admins always receive emails
  -- (treated as admin for visibility), regardless of whether they're
  -- a real member of the target group.
  is_super_admin := EXISTS (SELECT 1 FROM super_admins WHERE user_id = auth.uid());

  IF is_super_admin THEN
    -- A specific group_id is required when the caller has no
    -- membership row to fall back on. The "current group" semantics
    -- below are membership-derived, so they're meaningless here.
    IF p_group_id IS NULL THEN
      RAISE EXCEPTION 'p_group_id is required for super-admin observer calls';
    END IF;
    caller_group := p_group_id;
    is_admin := TRUE;
  ELSE
    -- Original logic from migration 013, unchanged.
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
  END IF;

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

-- ============================================================
-- DONE — Verify with:
--   -- As a super admin, observing a foreign group:
--   SELECT fetch_group_members_with_email('<some-other-groups-uuid>'::uuid);
--   -- As a regular admin in your own group (existing behavior preserved):
--   SELECT fetch_group_members_with_email();
-- ============================================================
