-- ============================================================================
-- Migration 076: fix delete_group so it actually deletes the group
-- ============================================================================
--
-- 2026-05-13 — Lior clicks "🗑️ מחק קבוצה" on the test group "ניסיון", types
-- the group name to confirm, and the delete silently fails: no error toast,
-- no deletion. Investigation shows TWO compounding bugs that together make
-- `delete_group` unable to clean up a group with any games:
--
--   (1) FK ordering during cascade from `groups`.
--       The original `delete_group` body was just:
--           DELETE FROM groups WHERE id = p_group_id;
--       relying on `ON DELETE CASCADE` from every child table back to
--       `groups`. But `game_players.player_id → players(id)` is `NO ACTION`
--       (intentional — see migration 050 / the UI's `playerHasGames()` guard
--       that prevents deleting a player who still has games). When PG
--       cascades the `groups → players` delete, it must validate that no
--       `game_players` row still references each deleted player. PG does
--       not always cascade `games → game_players` BEFORE cascading
--       `groups → players`, so the FK check fails:
--           "update or delete on table 'players' violates foreign key
--            constraint 'game_players_player_id_fkey' on table 'game_players'"
--       This was reproduced live on group b7dc39cf-… (1 game, 3 players)
--       before authoring this migration.
--
--   (2) Bulk-delete guards from migrations 043/050/051 also fire on the
--       way through. `block_bulk_direct_delete` rejects any direct
--       DELETE on `games` or `players` that touches >1 row when called
--       without a cascade-from-parent context. Migration 051 added a
--       cascade-from-`games` detector to the `game_players` branch but
--       explicitly stated `games` and `players` are top-level "no
--       inbound FKs" — overlooking the inbound FK from `groups`. So even
--       if we hand-orchestrated the cleanup inside `delete_group`, those
--       guards would still abort the bulk DELETE on `games` and on
--       `players`.
--
--   (3) `block_completed_game_player_delete` (migration 050) is a
--       BEFORE-ROW trigger on `game_players` that blocks direct deletes
--       of rows whose parent game is `completed`. The standard
--       `deleteGame` flow gets past it via `pg_trigger_depth() > 1`
--       (cascade context). A manual `delete_group` cleanup does NOT have
--       depth > 1 on its first DELETE — it would be blocked too.
--
-- Fix shape (matches the pattern recommended in LESSONS.md 2026-05-08):
--   • Introduce a TRANSACTION-LOCAL flag `app.cascade_group_delete = '1'`,
--     set by `delete_group` and read by both guard functions via
--     `current_setting(..., true)`. When the flag is set, the guards
--     allow the delete. The flag is automatically cleared at COMMIT/
--     ROLLBACK because we use `set_config(..., is_local => true)`, so it
--     cannot leak to other connections or to subsequent queries on the
--     same connection. SECURITY DEFINER on `delete_group` ensures only
--     the verified group owner can set the flag.
--   • Rewrite `delete_group` to do the cleanup in correct dependency
--     order (game_players → games → players → groups) so the
--     `game_players.player_id → players` FK is satisfied before
--     `players` rows are removed. The final `DELETE FROM groups` then
--     handles the remaining cascade-safe tables (settings,
--     group_members, chip_values, notifications, etc.) — none of which
--     have NO-ACTION FKs that could block.
--
-- Why a flag instead of relaxing the FK or the triggers entirely:
--   • The `NO ACTION` FK on `game_players.player_id → players` is doing
--     real work — it stops the UI's "delete a player" path from
--     silently destroying their historical game rows. We must not turn
--     it into `ON DELETE CASCADE`.
--   • The bulk-delete and completed-game guards are load-bearing safety
--     nets that have caught real production bugs (see comments in 043,
--     050, 051). We must not weaken them globally; we just need a
--     sanctioned, audited escape hatch for the one operation that
--     legitimately wipes a whole group's worth of data.
--   • Transaction-local + SECURITY DEFINER + owner-verified is the
--     standard sandboxed-escape pattern for exactly this case.
--
-- Sandbox verification done on the live DB before applying (BEGIN/inner
-- block / RAISE EXCEPTION to roll back):
--   pre : games=1 players=3 members=1 settings=1
--   post: games=0 players=0 members=0 settings=0      (cascade succeeded)
--   plus three regression cases with the flag NOT set, all correctly
--   blocked (bulk DELETE on games / bulk DELETE on players / direct
--   DELETE on a completed-game game_players row).
-- ============================================================================

-- ─── 1. Update block_bulk_direct_delete to honor the cascade flag ──────────

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
  -- Sanctioned bulk operation set by the delete_group RPC. Transaction-local,
  -- so it cannot leak. SECURITY DEFINER on the RPC plus owner verification
  -- ensures only the group owner can flip this.
  IF current_setting('app.cascade_group_delete', true) = '1' THEN
    RETURN NULL;
  END IF;

  -- Existing fallback: PG row-level cascade context (kept defensively).
  IF pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;

  -- Existing cascade-from-games detection for game_players (migration 051).
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
      '(cascade handles the rest). To remove an entire group, call the '
      'delete_group(uuid) RPC (which sets app.cascade_group_delete and '
      'orchestrates the cleanup). This guard exists because stale clients '
      'previously wiped completed-game rosters via implicit garbage '
      'collection (see migration 043 + 051 + 076 comments for context).',
      table_label, affected
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

-- ─── 2. Update block_completed_game_player_delete to honor the same flag ────

CREATE OR REPLACE FUNCTION block_completed_game_player_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  parent_status TEXT;
BEGIN
  -- Same sanctioned-escape as block_bulk_direct_delete.
  IF current_setting('app.cascade_group_delete', true) = '1' THEN
    RETURN OLD;
  END IF;

  -- Existing cascade-context exemption (DELETE FROM games … cascade).
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  SELECT status INTO parent_status FROM games WHERE id = OLD.game_id;

  IF parent_status IS NULL THEN
    RETURN OLD;
  END IF;

  IF parent_status = 'completed' THEN
    RAISE EXCEPTION
      'Cannot delete game_players row % for completed game %. '
      'Completed games are immutable at the row level — the only way to '
      'remove rows from a completed game is to delete the games row '
      '(cascade handles the rest) or to remove the entire group via the '
      'delete_group(uuid) RPC. This guard exists because stale or '
      'misbehaving clients have repeatedly wiped completed-game rosters '
      'via iterative single-row deletes (see migration 050 + 076 comments '
      'for context).',
      OLD.id, OLD.game_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN OLD;
END;
$$;

-- ─── 3. Rewrite delete_group to do an ordered, flag-sanctioned cleanup ─────

CREATE OR REPLACE FUNCTION delete_group(p_group_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Verify owner. Same check as the original function — only the user who
  -- created the group can delete it. SECURITY DEFINER bypasses RLS, so this
  -- gate is the only authorization guarantee for the destructive work below.
  IF NOT EXISTS (
    SELECT 1 FROM groups
    WHERE id = p_group_id AND created_by = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Only the group owner can delete the group';
  END IF;

  -- Flip the transaction-local flag. The guard triggers
  -- (block_bulk_direct_delete + block_completed_game_player_delete) read
  -- this and allow the bulk + completed-row deletes below. Because it's
  -- `is_local => true`, the setting is cleared automatically at COMMIT /
  -- ROLLBACK and is not visible to any other backend.
  PERFORM set_config('app.cascade_group_delete', '1', true);

  -- Ordered cleanup. Each step is a single statement that the guard triggers
  -- now allow because of the flag.
  --
  -- 1. Drop game_players first. They reference players (NO ACTION) AND
  --    games (CASCADE). Removing them up front frees both parent tables to
  --    be deleted in any order below without FK violation.
  DELETE FROM game_players
   WHERE game_id IN (SELECT id FROM games WHERE group_id = p_group_id);

  -- 2. Drop games. Cascade-children left intact (shared_expenses,
  --    period_markers, tts_pools, game_forecasts, paid_settlements all have
  --    ON DELETE CASCADE; chip_count_feedback / game_polls /
  --    pending_forecasts have ON DELETE SET NULL).
  DELETE FROM games WHERE group_id = p_group_id;

  -- 3. Drop players. game_players.player_id is already empty for these
  --    players (step 1), so the NO-ACTION FK is satisfied. Cascade-children
  --    (player_traits, game_poll_votes, player_invites) get cleaned up via
  --    their own ON DELETE CASCADE.
  DELETE FROM players WHERE group_id = p_group_id;

  -- 4. Drop the group itself. All remaining child tables
  --    (settings, group_members, chip_values, chronicle_profiles,
  --    game_polls, push_subscriptions, training_*, trivia_*, notifications,
  --    notification_jobs, activity_log, backups, issue_reports,
  --    chip_count_*, graph_insights, pending_forecasts, player_invites)
  --    have group_id → groups ON DELETE CASCADE, none have NO-ACTION
  --    inbound FKs that could block, and none of them carry the bulk
  --    guard, so the cascade completes cleanly.
  DELETE FROM groups WHERE id = p_group_id;
END;
$$;

-- ─── 4. Sanity check ────────────────────────────────────────────────────────

DO $$
DECLARE
  guard_count INT;
BEGIN
  SELECT COUNT(*) INTO guard_count
  FROM pg_trigger
  WHERE tgname IN ('guard_no_bulk_delete', 'guard_completed_game_player_delete')
    AND NOT tgisinternal;
  IF guard_count <> 4 THEN
    RAISE WARNING
      'Expected 4 guard triggers (3 guard_no_bulk_delete + 1 guard_completed_game_player_delete) but found %.',
      guard_count;
  ELSE
    RAISE NOTICE
      'delete_group rewritten; bulk-delete and completed-game guards now honor app.cascade_group_delete.';
  END IF;
END $$;
