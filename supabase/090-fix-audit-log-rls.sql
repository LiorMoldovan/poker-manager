-- ============================================================================
-- Migration 090: fix audit-log RLS so the mig 088 triggers can actually write
-- ============================================================================
--
-- 2026-05-23 — Lior reports "Save failed: games/upsert — new row violates
-- row-level security policy for table \"game_audit_log\"" toast when
-- completing a game on his phone.
--
-- Root cause (entirely my fault — mig 088):
--   game_audit_log was created with RLS enabled and only two policies:
--     • gal_admin_select (SELECT, for admin/owner/super-admin reads)
--     • gal_super_admin_delete (DELETE, for super-admin cleanup)
--   There is NO INSERT policy. The mig 088 comments asserted "Service
--   role / table owner bypasses RLS implicitly — the trigger functions
--   run as the table owner (postgres), which is exempt." That's WRONG.
--   PL/pgSQL trigger functions execute with the privileges of the
--   INVOKER unless declared SECURITY DEFINER. The two audit trigger
--   functions from mig 088 (`audit_log_games_status` and
--   `audit_log_game_player_delete`) were NOT marked SECURITY DEFINER.
--   So when a regular authenticated user finished a game, the trigger
--   fired in the user's RLS context, tried to INSERT into
--   game_audit_log, no INSERT policy matched, and the whole transaction
--   rolled back — taking the games upsert with it.
--
-- The only reason the mig 088 sandbox tests passed is that I ran them
-- via the Supabase Management API, which executes as the database
-- superuser (rdsadmin) and bypasses RLS unconditionally. Real-user
-- writes never got tested. Lesson logged.
--
-- THIS MIGRATION
--
-- Marks both audit trigger functions SECURITY DEFINER so they run as
-- the function owner (postgres), which owns game_audit_log and
-- bypasses its RLS. We keep RLS enabled and intentionally keep the
-- "no INSERT policy" stance — direct user INSERTs via PostgREST stay
-- blocked, only the triggers can write. Readers are still gated by the
-- existing admin/owner/super-admin SELECT policy. SECURITY DEFINER
-- does NOT change auth.uid() (JWT context is session-level, not
-- function-level), so the actor_id column still records the real
-- authenticated user, not postgres.
--
-- Why I'm not adding an INSERT policy instead:
--   • An INSERT policy would let authenticated users craft arbitrary
--     audit rows directly via PostgREST. That defeats the point of an
--     append-only audit log.
--   • SECURITY DEFINER is the standard PostgreSQL pattern for "I want
--     a trigger that escalates privilege to write to a protected
--     internal table on behalf of any user". It's explicit, scoped to
--     the function, and survives any future RLS policy tightening.
--
-- IDEMPOTENT: ALTER FUNCTION ... SECURITY DEFINER is a no-op if already
-- set. Re-runnable.
-- ============================================================================

ALTER FUNCTION public.audit_log_games_status()        SECURITY DEFINER;
ALTER FUNCTION public.audit_log_game_player_delete()  SECURITY DEFINER;

-- Sanity: verify both flipped. Inline verification so future readers
-- (and future me) can confirm at-a-glance the migration did its job.
DO $$
DECLARE
  v_status_secdef BOOLEAN;
  v_delete_secdef BOOLEAN;
BEGIN
  SELECT prosecdef INTO v_status_secdef
    FROM pg_proc WHERE proname = 'audit_log_games_status';
  SELECT prosecdef INTO v_delete_secdef
    FROM pg_proc WHERE proname = 'audit_log_game_player_delete';

  IF v_status_secdef IS NOT TRUE OR v_delete_secdef IS NOT TRUE THEN
    RAISE EXCEPTION
      'Migration 090 sanity failed — audit_log_games_status secdef=%, audit_log_game_player_delete secdef=%',
      v_status_secdef, v_delete_secdef;
  END IF;

  RAISE NOTICE 'Migration 090 installed: audit triggers now SECURITY DEFINER, RLS no longer blocks game completion.';
END $$;

-- ============================================================================
-- Self-verification (run after applying):
--
-- a) Both flipped:
--    SELECT proname, prosecdef FROM pg_proc
--    WHERE proname IN ('audit_log_games_status', 'audit_log_game_player_delete');
--    Expected: prosecdef = true for both.
--
-- b) Smoke under authenticated role:
--    BEGIN;
--    SET LOCAL ROLE authenticated;
--    SELECT set_config('request.jwt.claim.sub', '<any-valid-user-uuid>', true);
--    UPDATE games SET status = status WHERE id = '<some-completed-game>';
--    -- (Same-value UPDATE wouldn't fire the audit trigger since the
--    -- trigger gates on `OLD.status IS DISTINCT FROM NEW.status`.
--    -- For a meaningful test, do a status flip from a non-completed
--    -- staging row, or write a dedicated test row.)
--    ROLLBACK;
--    Expected: no "violates row-level security policy" error.
--
-- c) Reader gate still enforced:
--    BEGIN;
--    SET LOCAL ROLE authenticated;
--    SELECT set_config('request.jwt.claim.sub', '<random-non-admin-uuid>', true);
--    SELECT count(*) FROM game_audit_log;
--    Expected: 0 (RLS denies non-admin reads).
--    ROLLBACK;
-- ============================================================================
