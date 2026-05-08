-- ============================================================================
-- Migration 051: fix the cascade-detection in block_bulk_direct_delete
-- ============================================================================
--
-- Discovered while testing migration 050: the cascade exemption in the
-- existing `block_bulk_direct_delete` function (migration 043) is broken.
-- The function tries to detect "this DELETE was triggered by an FK CASCADE,
-- not by a direct user statement" with `pg_trigger_depth() > 1`. That works
-- for ROW-LEVEL triggers (cascade BEFORE-DELETE row triggers fire at depth
-- 2), but NOT for STATEMENT-LEVEL triggers, which is exactly what 043 is.
--
-- Empirical proof, run on this very project's DB before authoring this fix:
--
--    -- two child rows, parent ON DELETE CASCADE
--    DELETE FROM _test_parent WHERE id = 1;
--    -- → BEFORE DELETE row trigger:        pg_trigger_depth() = 2  ✅
--    -- → AFTER  DELETE statement trigger: pg_trigger_depth() = 1  ❌
--
-- So when the existing trigger fires at the end of a cascade DELETE on
-- game_players (statement context, depth = 1), the `IF pg_trigger_depth() > 1`
-- check does NOT exit early, the function proceeds to count `old_table`,
-- sees N > 1, and raises 'Bulk DELETE on game_players blocked'. The cascade
-- (and thus the originating `DELETE FROM games WHERE id = …` from
-- `deleteGame` in storage.ts) gets aborted.
--
-- This means: since migration 043 shipped (v5.34.2, May 3), the
-- `deleteGame` UI flow has been silently broken for any completed game with
-- 2 or more `game_players` rows. The local cache pretended the delete
-- worked, but the server rejected it; the next realtime refresh would have
-- brought the game back. The user hasn't reported this only because they
-- haven't tried to delete a multi-player game in the last 5 days.
--
-- Two-part fix:
--   1. For `game_players` cascade (the only table where cascade is even
--      possible — `games` and `players` are top-level, nothing cascades INTO
--      them), detect cascade by checking whether the OLD rows' parent `games`
--      row still exists. In a cascade triggered by `DELETE FROM games WHERE
--      id = X`, the parent row is removed BEFORE the child cascade fires;
--      so by the time `block_bulk_direct_delete` runs as an AFTER-STATEMENT
--      trigger on `game_players`, every OLD row's `game_id` will reference
--      a games row that no longer exists. Direct bulk DELETEs on
--      `game_players` (the v5.34.2-pre garbage-collection pattern, or any
--      future client bug of the same shape) leave the parent intact.
--   2. Keep `pg_trigger_depth() > 1` as a fallback for any future ROW-LEVEL
--      cascade scenarios (defensive). It costs nothing and adds belt-and-
--      suspenders protection if Postgres internals change.
--
-- For `games` and `players` — both top-level tables with no inbound FKs —
-- there's no cascade context to detect. The existing logic (single-row OK,
-- bulk REJECTED) is exactly right for them and stays unchanged below.
--
-- Net result after this migration:
--   • `DELETE FROM games WHERE id = $1` (single-row direct, the deleteGame
--     UI flow) → cascade fires on game_players → AFTER-STATEMENT
--     `block_bulk_direct_delete` runs → sees parent games gone → exits
--     early → cascade completes → game and all children removed atomically.
--   • Stale-client bulk garbage-collect pattern on game_players (rows
--     spanning still-alive games) → trigger sees parents intact → blocks.
--   • Single-row direct DELETE on game_players for a LIVE game (the
--     legitimate `removeGamePlayer` path) → 1 row, not bulk → trigger
--     exits via the `affected > 1` short-circuit → delete proceeds.
--   • Single-row direct DELETE on game_players for a COMPLETED game →
--     migration 050's row-level guard rejects it before this trigger even
--     gets to run.
-- ============================================================================

-- ─── 1. Replace the function body. Trigger definitions stay as-is. ─────────

CREATE OR REPLACE FUNCTION block_bulk_direct_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  affected INT;
  parents_all_gone BOOLEAN;
  table_label TEXT := TG_TABLE_NAME;
BEGIN
  -- (Defensive) Fallback for ROW-LEVEL cascade contexts. AFTER-STATEMENT
  -- triggers don't see depth > 1 from RI cascade, but if Postgres ever
  -- changes that, this short-circuit keeps us safe.
  IF pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;

  -- For `game_players` specifically, detect cascade by parent-existence.
  -- In a cascade triggered by `DELETE FROM games WHERE id = X`, the parent
  -- games row is gone by the time this AFTER-STATEMENT trigger fires.
  -- Direct bulk DELETE on game_players (the bug we're guarding against)
  -- leaves the parent intact.
  --
  -- Edge case: a user could legitimately delete multiple games in one
  -- transaction (multi-row DELETE FROM games), which would cascade on
  -- game_players. We don't currently support that flow in the client, but
  -- if/when we do, this check still works: every OLD row's parent will be
  -- gone after the games multi-row delete commits the cascade.
  IF table_label = 'game_players' THEN
    SELECT NOT EXISTS (
      SELECT 1 FROM old_table o
      WHERE EXISTS (SELECT 1 FROM games g WHERE g.id = o.game_id)
    ) INTO parents_all_gone;
    IF parents_all_gone THEN
      RETURN NULL;
    END IF;
  END IF;

  SELECT COUNT(*) INTO affected FROM old_table;

  IF affected > 1 THEN
    RAISE EXCEPTION
      'Bulk DELETE on % blocked: % rows in one statement is not allowed. '
      'Direct DELETEs on this table must be single-row (DELETE WHERE id = $1). '
      'To remove a whole game including its dependents, DELETE the games row '
      '(cascade handles the rest). This guard exists because stale clients '
      'previously wiped completed-game rosters via implicit garbage collection '
      '(see migration 043 + 051 comment for context).',
      table_label, affected
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

-- The triggers themselves don't change — they were defined in 043 and the
-- function rewrite above takes effect immediately for all of them.

-- ─── 2. Sanity verification ────────────────────────────────────────────────

DO $$
DECLARE
  trig_count INT;
BEGIN
  SELECT COUNT(*) INTO trig_count
  FROM pg_trigger
  WHERE tgname = 'guard_no_bulk_delete'
    AND NOT tgisinternal;

  IF trig_count <> 3 THEN
    RAISE WARNING
      'Expected 3 guard_no_bulk_delete triggers (game_players, games, players) but found %.',
      trig_count;
  ELSE
    RAISE NOTICE 'block_bulk_direct_delete updated; cascade-detection now parent-existence-based for game_players.';
  END IF;
END $$;

-- ─── 3. Self-verification queries (run manually after applying) ────────────
--
-- a) Cascade DELETE FROM games WHERE id = (multi-player completed game)
--    must SUCCEED (game + all 7+ children removed atomically). Use a
--    sandbox row inside BEGIN…ROLLBACK to test without losing data.
--
-- b) Direct multi-row DELETE FROM game_players WHERE game_id = (live game
--    with 8 players) must FAIL with 'Bulk DELETE on game_players blocked'.
--
-- c) Direct single-row DELETE FROM game_players WHERE id = $1 on a LIVE
--    game must SUCCEED (the legitimate removeGamePlayer path).
--
-- d) Direct single-row DELETE FROM game_players WHERE id = $1 on a
--    COMPLETED game must FAIL with the migration-050 message (row-level
--    guard fires first, before this statement-level guard ever runs).
