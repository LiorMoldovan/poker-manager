-- ============================================================================
-- Migration 043: server-side bulk-DELETE guard on the at-risk tables
-- ============================================================================
--
-- Sunday 2026-05-03 we lost the entire `game_players` roster (8 rows) for
-- Saturday's completed game. The `games` row stayed intact but every
-- `game_players` row got deleted from Supabase, breaking the WhatsApp
-- pay-link (`/game-summary/<id>?pay=1`) for the whole group. Recovered
-- from the auto game-end backup, but the recovery was wiped within
-- minutes by the same code path that caused the original wipe — proof
-- the bug was actively running in production.
--
-- Root cause is in `src/database/supabaseCache.ts`: the `pushToSupabase`
-- function treats the **local in-memory cache as authoritative for
-- deletes** in three sync paths (PLAYERS, GAMES, GAME_PLAYERS). After
-- upserting local rows it ALSO runs `SELECT id FROM <table> WHERE
-- <scope>` and then `DELETE` on every server id NOT in local — i.e.
-- "if I don't have it, it must be garbage". When local is incomplete
-- (1000-row PostgREST clamp on `fetchByGameIds`, partial fetch on
-- transient RLS / network blip, mid-init device, stale background tab,
-- replayed pagehide flush from a previous session), the diff says
-- "delete everything" and the server gets shredded.
--
-- The client fix ships in v5.34.2 (upsert-only flushes, explicit deletes
-- on user-action paths, paginated `fetchByGameIds`). But every client
-- in the group is on a stale bundle until they reload, and we cannot
-- realistically ask each member ("close and reopen the app") in a chat
-- of 20+ people. The existing `/api/version` deploy-id poll runs every
-- 5 minutes (`src/main.tsx`), so all clients eventually pick up the new
-- bundle on their own — but DURING those 5 minutes a stale client can
-- still corrupt the server.
--
-- This migration plugs that gap at the database layer by adding a
-- statement-level BEFORE DELETE trigger on the three at-risk tables
-- (`game_players`, `games`, `players`) that REJECTS any direct DELETE
-- statement affecting more than one row. The destructive
-- `DELETE WHERE id IN (...)` patterns from the old bundle therefore
-- fail with a clear error (the sync flush logs it via `logSyncError`)
-- and the server stays consistent. Single-row direct deletes still
-- pass — that's all the new v5.34.2 client uses (`deleteGame`,
-- `deletePlayer`, `removeGamePlayer`, `removeSharedExpense`, plus the
-- per-game forecast/settlement replace which deletes by `game_id` —
-- typically 0–10 rows per game; we apply the multi-row exception there
-- below with a higher threshold). FK CASCADE deletes (e.g.
-- `DELETE FROM games` cascading to `game_players`) are detected via
-- `pg_trigger_depth() > 1` and allowed through, so deleting a whole
-- game still removes its full footprint atomically.
--
-- This is intentionally a permanent guardrail, not a temporary patch:
-- "no client should ever bulk-delete from these tables without going
-- through a cascade or a single-row statement" is a healthy invariant
-- that we want to preserve forever, and it neutralises any future
-- regression of the same shape.
-- ============================================================================

-- ─── 1. Reusable single-row guard ────────────────────────────────────────────
-- For tables where the new client only ever deletes ONE row at a time
-- (game_players, players, games). FK CASCADE deletes go through at
-- depth > 1 and are allowed.
CREATE OR REPLACE FUNCTION block_bulk_direct_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  affected INT;
  table_label TEXT := TG_TABLE_NAME;
BEGIN
  -- Allow CASCADE deletes (these fire from internal FK triggers, so
  -- pg_trigger_depth() is > 1). The new client's `deleteGame` relies
  -- on the games → game_players cascade; we must not block that path.
  IF pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(*) INTO affected FROM old_table;

  IF affected > 1 THEN
    RAISE EXCEPTION
      'Bulk DELETE on % blocked: % rows in one statement is not allowed. '
      'Direct DELETEs on this table must be single-row (DELETE WHERE id = $1). '
      'To remove a whole game including its dependents, DELETE the games row '
      '(cascade handles the rest). This guard exists because stale clients '
      'previously wiped completed-game rosters via implicit garbage collection '
      '(see migration 043 comment for context).',
      table_label, affected
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END $$;

-- ─── 2. Attach the guard to the three highest-blast-radius tables ───────────

DROP TRIGGER IF EXISTS guard_no_bulk_delete ON game_players;
CREATE TRIGGER guard_no_bulk_delete
  BEFORE DELETE ON game_players
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION block_bulk_direct_delete();

DROP TRIGGER IF EXISTS guard_no_bulk_delete ON games;
CREATE TRIGGER guard_no_bulk_delete
  BEFORE DELETE ON games
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION block_bulk_direct_delete();

DROP TRIGGER IF EXISTS guard_no_bulk_delete ON players;
CREATE TRIGGER guard_no_bulk_delete
  BEFORE DELETE ON players
  REFERENCING OLD TABLE AS old_table
  FOR EACH STATEMENT
  EXECUTE FUNCTION block_bulk_direct_delete();

-- ─── 3. Sanity check: surface what's now in place ───────────────────────────

DO $$
DECLARE
  trig_count INT;
BEGIN
  SELECT COUNT(*) INTO trig_count
  FROM pg_trigger
  WHERE tgname = 'guard_no_bulk_delete'
    AND NOT tgisinternal;

  RAISE NOTICE 'Bulk-delete guard installed on % tables (expected 3).', trig_count;

  IF trig_count <> 3 THEN
    RAISE WARNING
      'Expected 3 guard_no_bulk_delete triggers but found %. '
      'Inspect with: SELECT tgname, tgrelid::regclass FROM pg_trigger WHERE tgname = ''guard_no_bulk_delete'';',
      trig_count;
  END IF;
END $$;

-- ─── 4. Self-verification queries (run manually after applying this file) ───
--
-- a) Confirm the guard rejects a bulk delete (this should ERROR; we use a
--    plain SELECT-COUNT pre-check so we don't actually destroy any data
--    when running in a transaction that's then rolled back). The expected
--    failure code is 23514 / message containing "Bulk DELETE on game_players
--    blocked".
--
--    BEGIN;
--      SAVEPOINT sp;
--      DELETE FROM game_players
--        WHERE game_id = (SELECT id FROM games ORDER BY created_at DESC LIMIT 1);
--      -- Should raise 'Bulk DELETE on game_players blocked: N rows...'
--      ROLLBACK TO sp;
--    ROLLBACK;
--
-- b) Confirm CASCADE still works (single-row direct delete on games
--    cascades to multi-row delete on game_players, which the guard must
--    allow because pg_trigger_depth() > 1). Use a throwaway test game in
--    a sandbox group, or just rely on the existing `deleteGame` UI path —
--    if it works, the cascade path is healthy.
--
-- c) Confirm single-row direct deletes still pass:
--    BEGIN;
--      SAVEPOINT sp;
--      DELETE FROM game_players WHERE id = '<some-id>';
--      ROLLBACK TO sp;
--    ROLLBACK;
