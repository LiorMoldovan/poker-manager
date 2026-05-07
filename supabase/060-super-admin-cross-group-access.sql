-- ============================================================
-- Phase 60: Super-admin cross-group observer access
-- Run in Supabase SQL Editor after 059-super-admin-group-members.sql
--
-- Goal: let a super admin pick any group from the existing top-bar
-- group switcher (even one they aren't a member of) and use the app
-- there with owner-equivalent powers, while staying invisible to that
-- group's members (no group_members row, no activity_log entry, no
-- push subscription). The "invisibility" pieces are enforced
-- client-side; the SQL piece below is just removing the RLS wall that
-- currently blocks any read/write outside the caller's memberships.
--
-- Strategy: add a single PERMISSIVE policy "super_admins_full_access"
-- on every group-scoped (or game-scoped) table. PostgreSQL combines
-- permissive policies with OR, so the existing membership-based
-- policies keep their meaning for everyone else; super-admins simply
-- get a parallel grant. We DROP-then-CREATE so the migration is
-- idempotent.
--
-- Scope: tables with a `group_id` or `game_id` column, plus `groups`
-- itself (which keys on `id`). We deliberately do NOT add this policy
-- to platform tables like `super_admins`, `system_config`, or
-- `email_*_log` — super admins shouldn't grant themselves, and those
-- tables already have their own dedicated policies.
--
-- New RPC: `list_all_groups_for_super_admin()` returns id+name of
-- every group, used by the client to populate the switcher with
-- non-member groups.
-- ============================================================

DO $$
DECLARE
  t RECORD;
  policy_sql TEXT;
BEGIN
  FOR t IN
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relrowsecurity = TRUE
      AND (
        EXISTS (
          SELECT 1 FROM information_schema.columns col
          WHERE col.table_schema = 'public'
            AND col.table_name = c.relname
            AND col.column_name IN ('group_id', 'game_id')
        )
        OR c.relname = 'groups'
      )
  LOOP
    -- Drop first so re-running this migration is safe.
    EXECUTE format(
      'DROP POLICY IF EXISTS super_admins_full_access ON public.%I',
      t.table_name
    );
    -- Permissive ALL grant for super admins. Both USING and WITH CHECK
    -- so SELECT/INSERT/UPDATE/DELETE all work; PostgreSQL OR-combines
    -- this with whichever membership-scoped policies the table already
    -- has.
    policy_sql := format(
      'CREATE POLICY super_admins_full_access ON public.%I '
      || 'AS PERMISSIVE FOR ALL TO authenticated '
      || 'USING (EXISTS (SELECT 1 FROM public.super_admins sa WHERE sa.user_id = auth.uid())) '
      || 'WITH CHECK (EXISTS (SELECT 1 FROM public.super_admins sa WHERE sa.user_id = auth.uid()))',
      t.table_name
    );
    EXECUTE policy_sql;
  END LOOP;
END$$;

-- ─── Group list RPC for the switcher ───
-- Used by the client to populate the GroupSwitcher modal with every
-- group on the platform. Member-scoped fields like role / playerId are
-- omitted because they're meaningless for non-member groups; the
-- switcher renders a distinct "👁 observer" badge instead of the
-- normal role pill in that case.

CREATE OR REPLACE FUNCTION list_all_groups_for_super_admin()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  result JSON;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM super_admins WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION 'Not a super admin';
  END IF;

  SELECT COALESCE(
    json_agg(
      json_build_object(
        'group_id',     g.id,
        'group_name',   g.name,
        'created_at',   g.created_at,
        'created_by',   g.created_by,
        'invite_code',  g.invite_code,
        'training_enabled', g.training_enabled,
        'member_count', (SELECT count(*) FROM group_members gm WHERE gm.group_id = g.id)
      )
      ORDER BY g.created_at DESC
    ),
    '[]'::json
  )
  INTO result
  FROM groups g;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION list_all_groups_for_super_admin() TO authenticated;
