-- 045: Security + performance hardening (Supabase advisor cleanup)
--
-- Why this exists:
--   Supabase's database advisor (`get_advisors`) flagged three classes of
--   real-but-low-blast-radius issues. This migration addresses the safe,
--   mechanical, high-value subset of them:
--
--     1. Eight functions had a mutable `search_path` (Supabase lint
--        `function_search_path_mutable`). Without a pinned search_path, a
--        malicious actor with CREATE-on-some-schema rights could in principle
--        shadow built-in identifiers. Real risk in this project is low, but
--        pinning is one-line-per-function hygiene that the rest of the
--        codebase already follows on newer overloads of `create_group` and
--        `join_group_by_invite`.
--
--     2. 84 RLS policies referenced `auth.uid()` un-wrapped (Supabase lint
--        `auth_rls_initplan`). Postgres re-evaluates the call once per row
--        scanned. Wrapping it as `(SELECT auth.uid())` lets PG cache the
--        value once per query — same semantics, big speedup on tables like
--        `activity_log` (20K rows).
--
--     3. Three foreign-key columns lacked covering indexes that are queried
--        on every owner check / activity dashboard / member→player lookup.
--
-- What this migration does NOT touch (deliberate):
--   - REVOKE on anon-callable SECURITY DEFINER RPCs (needs per-function audit
--     to avoid breaking signup / public share flows).
--   - Super-admin RLS gap (24 tables) — needs decision on whether super
--     admin uses service_role bypass or explicit per-table policy.
--   - HaveIBeenPwned check — dashboard toggle, not SQL.
--   - `game-comics` storage bucket — pending decision on listing requirement.
--   - `multiple_permissive_policies` consolidation — risky logic merge,
--     defer until proven needed.
--   - Drop-unused-indexes — cosmetic; harmless to leave.
--
-- Idempotent:
--   Re-running this file is a no-op. ALTER FUNCTION ... SET search_path is
--   idempotent. CREATE INDEX IF NOT EXISTS skips existing indexes. The
--   policy-rewrite DO block uses a placeholder swap so wrapping is performed
--   exactly once per `auth.uid()` occurrence regardless of input state.
--
-- Rollback:
--   The migration is wrapped in a single transaction. Any failure rolls all
--   three parts back. To manually revert after a successful apply:
--     - ALTER FUNCTION ... RESET search_path on the eight functions
--     - DROP INDEX on the three new indexes
--     - Re-rewrite policies replacing `(SELECT auth.uid())` → `auth.uid()`
--   None of this should be necessary; the changes are semantics-preserving.

BEGIN;

-- =============================================================================
-- Part 1 — Pin search_path on the 8 advisor-flagged functions
-- =============================================================================
-- All eight functions reference only objects in `public` (and some qualified
-- `auth.users` / `auth.uid()` calls — the qualifications mean search_path
-- doesn't need `auth` in it). `public, pg_temp` is the Supabase recommended
-- minimum: `public` for own tables, `pg_temp` last so it can't be hijacked.

ALTER FUNCTION public.check_game_zero_sum()                                SET search_path = public, pg_temp;
ALTER FUNCTION public.check_game_players_zero_sum()                        SET search_path = public, pg_temp;
ALTER FUNCTION public.auto_close_poll_on_vote()                            SET search_path = public, pg_temp;
ALTER FUNCTION public.block_bulk_direct_delete()                           SET search_path = public, pg_temp;
ALTER FUNCTION public.get_user_id_for_player(uuid, text)                   SET search_path = public, pg_temp;
ALTER FUNCTION public.get_player_email_for_notification(uuid, text)        SET search_path = public, pg_temp;
ALTER FUNCTION public.create_group(text)                                   SET search_path = public, pg_temp;
ALTER FUNCTION public.join_group_by_invite(text)                           SET search_path = public, pg_temp;

-- =============================================================================
-- Part 2 — High-impact FK indexes
-- =============================================================================
-- groups.created_by      : every "is owner?" check JOINs on this
-- activity_log.user_id   : 20K-row table, queried on owner activity dashboard
-- group_members.player_id: used in member↔player linking lookups
--
-- The other 12 unindexed FKs flagged by the advisor are on tables with ≤20
-- rows where Postgres prefers a sequential scan anyway; adding indexes there
-- would be wasted disk + write overhead.

CREATE INDEX IF NOT EXISTS idx_groups_created_by      ON public.groups(created_by);
CREATE INDEX IF NOT EXISTS idx_activity_log_user_id   ON public.activity_log(user_id);
CREATE INDEX IF NOT EXISTS idx_group_members_player_id ON public.group_members(player_id);

-- =============================================================================
-- Part 3 — Wrap `auth.uid()` in `(SELECT auth.uid())` across all RLS policies
-- =============================================================================
-- Per Supabase docs, this changes per-row evaluation to per-query (init-plan)
-- evaluation. Functionally identical; just faster. Applied via ALTER POLICY,
-- which preserves the policy name, role, and command — only the expression
-- text changes.
--
-- Idempotent strategy:
--   For each `qual` / `with_check` expression containing `auth.uid()`:
--     1. Temporarily swap any *already-wrapped* `(SELECT auth.uid())` with a
--        unique placeholder string.
--     2. Wrap any remaining bare `auth.uid()` with `(SELECT auth.uid())`.
--     3. Restore the placeholders to `(SELECT auth.uid())`.
--   Net effect: every occurrence ends up wrapped exactly once. Re-running
--   the migration finds nothing to change and skips the ALTER.

DO $migration$
DECLARE
  pol record;
  new_qual text;
  new_check text;
  altered_count int := 0;
  scanned_count int := 0;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname, cmd, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND (
        (qual       IS NOT NULL AND qual       LIKE '%auth.uid()%')
        OR
        (with_check IS NOT NULL AND with_check LIKE '%auth.uid()%')
      )
  LOOP
    scanned_count := scanned_count + 1;
    new_qual  := pol.qual;
    new_check := pol.with_check;

    -- Idempotent wrap on qual
    IF new_qual IS NOT NULL THEN
      new_qual := replace(new_qual, '(SELECT auth.uid())', '__AUTH_UID_PLACEHOLDER__');
      new_qual := replace(new_qual, 'auth.uid()',          '(SELECT auth.uid())');
      new_qual := replace(new_qual, '__AUTH_UID_PLACEHOLDER__', '(SELECT auth.uid())');
    END IF;

    -- Idempotent wrap on with_check
    IF new_check IS NOT NULL THEN
      new_check := replace(new_check, '(SELECT auth.uid())', '__AUTH_UID_PLACEHOLDER__');
      new_check := replace(new_check, 'auth.uid()',          '(SELECT auth.uid())');
      new_check := replace(new_check, '__AUTH_UID_PLACEHOLDER__', '(SELECT auth.uid())');
    END IF;

    -- Skip the ALTER if nothing actually changed (already fully wrapped)
    IF new_qual IS NOT DISTINCT FROM pol.qual AND new_check IS NOT DISTINCT FROM pol.with_check THEN
      CONTINUE;
    END IF;

    -- ALTER POLICY syntax differs by command type:
    --   INSERT          → only WITH CHECK
    --   SELECT/DELETE   → only USING
    --   UPDATE/ALL      → USING (+ optional WITH CHECK)
    IF pol.cmd = 'INSERT' THEN
      EXECUTE format(
        'ALTER POLICY %I ON %I.%I WITH CHECK (%s)',
        pol.policyname, pol.schemaname, pol.tablename, new_check
      );
    ELSIF pol.cmd IN ('SELECT', 'DELETE') THEN
      EXECUTE format(
        'ALTER POLICY %I ON %I.%I USING (%s)',
        pol.policyname, pol.schemaname, pol.tablename, new_qual
      );
    ELSE  -- UPDATE or ALL
      IF new_check IS NOT NULL THEN
        EXECUTE format(
          'ALTER POLICY %I ON %I.%I USING (%s) WITH CHECK (%s)',
          pol.policyname, pol.schemaname, pol.tablename, new_qual, new_check
        );
      ELSE
        EXECUTE format(
          'ALTER POLICY %I ON %I.%I USING (%s)',
          pol.policyname, pol.schemaname, pol.tablename, new_qual
        );
      END IF;
    END IF;

    altered_count := altered_count + 1;
  END LOOP;

  RAISE NOTICE 'Migration 045: scanned % policies referencing auth.uid(), altered % to use (SELECT auth.uid())', scanned_count, altered_count;
END
$migration$;

COMMIT;

-- =============================================================================
-- Verification queries (run these after applying — should return zero rows)
-- =============================================================================
--
-- 1) All eight target functions should now have a search_path set:
--      SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, p.proconfig
--      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--      WHERE n.nspname = 'public'
--        AND p.proname IN ('check_game_zero_sum','check_game_players_zero_sum',
--                          'auto_close_poll_on_vote','block_bulk_direct_delete',
--                          'get_user_id_for_player','get_player_email_for_notification',
--                          'create_group','join_group_by_invite')
--        AND (p.proconfig IS NULL
--             OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'));
--      -- Expected: 0 rows.
--
-- 2) Three new indexes should exist:
--      SELECT indexname FROM pg_indexes
--      WHERE schemaname = 'public'
--        AND indexname IN ('idx_groups_created_by',
--                          'idx_activity_log_user_id',
--                          'idx_group_members_player_id');
--      -- Expected: 3 rows.
--
-- 3) No RLS policy should still reference bare `auth.uid()`:
--      SELECT schemaname, tablename, policyname
--      FROM pg_policies
--      WHERE schemaname = 'public'
--        AND (
--          (qual       LIKE '%auth.uid()%' AND qual       NOT LIKE '%(SELECT auth.uid())%')
--          OR
--          (with_check LIKE '%auth.uid()%' AND with_check NOT LIKE '%(SELECT auth.uid())%')
--        );
--      -- Expected: 0 rows.
