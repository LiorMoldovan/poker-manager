-- ============================================================================
-- Migration 077: block stale clients from downgrading games.status from
-- "completed" → "live"/"chip_entry" via blanket upsert
-- ============================================================================
--
-- 2026-05-15 02:50 IDT — Lior reports for the THIRD weekend in a row that
-- a just-completed game shows "0 שחקנים • 0 קניות" on the History card.
-- The game on May 14 (סגל, Poker Night group) had:
--
--   • games row intact (status='completed', date+location, sharedExpenses,
--     forecasts (8), period_markers (1) — all preserved)
--   • game_players for that game: 0 rows (8 should exist)
--   • auto game-end backup taken 6h after completion: STILL has all 8
--     game_players rows
--
-- So the wipe is AFTER game completion, AFTER the backup, and ONLY affects
-- the game_players table. Same shape as the 2026-05-03 (migration 043 era)
-- and 2026-05-08 (migration 050 + 051 era) incidents — yet both prior
-- migrations are still in place and verified-correct on this DB. The
-- guard fires correctly when status='completed', and bulk deletes are
-- still blocked. Something is bypassing the guard.
--
-- Root-cause hypothesis (proven by code audit, this commit):
--
--   1. The TypeScript GAMES-table sync in supabaseCache.ts was a
--      BLANKET upsert: every push fired `upsert(localGamesArray)` for
--      ALL games in local memory, not just the ones the user had
--      actually mutated this debounce window. The `gameLocalWriteAt`
--      marker was used to gate child-table reconciliation but NOT the
--      games row upsert itself.
--
--   2. A stale tab on Device B that had cached this game with
--      status='live' from the live-game phase (before chip entry / end)
--      would, on ANY unrelated local action that triggered a games sync
--      (creating a new game, editing forecasts, opening LiveGameScreen,
--      a poll vote landing in the same debounce window), push its stale
--      version of the games row back to the server — flipping the
--      status column from 'completed' BACK to 'live'.
--
--   3. With status='live' on the server, the BEFORE-DELETE row guard
--      (block_completed_game_player_delete) reads the parent's CURRENT
--      status, sees 'live', and allows the delete to proceed.
--
--   4. From there, ANY client (the stale tab itself, or another tab on
--      a different device that received the realtime echo of "game X is
--      now live") now sees the game as a live one. If a user clicks
--      "remove player" on a player whose rebuys=1 (the only remove-player
--      affordance, on LiveGameScreen), each removeGamePlayer call issues
--      a single-row DELETE that the BEFORE-DELETE guard now lets through.
--      Iterating over the roster wipes it one row at a time, just like
--      the May 7 incident (migration 050 prologue).
--
-- The TypeScript fix (this commit, v5.61.0): the GAMES sync now upserts
-- ONLY the games whose `gameLocalWriteAt` marker was set when the flush
-- started. A purely-passive stale tab — no local writes, just rendering
-- — can no longer push anything to the server, so it cannot revive a
-- stale status. Every legitimate write path (createGame,
-- updateGameStatus, updateGame, updateGameChipGap, addSharedExpense,
-- removeSharedExpense, updateSharedExpense, saveForecastAccuracy,
-- saveForecastComment, saveGameAiSummary, saveGameComic, clearGameComic,
-- linkForecastToGame) already calls markGameLocallyWritten, so the
-- legitimate flow is unaffected.
--
-- This migration is the DB-level belt-and-suspenders: even if a future
-- client bug, a stale bundle still in the wild, or a manual SQL session
-- attempts to write status='live' over an existing 'completed' games
-- row, the trigger below rejects the UPDATE outright.
--
-- The only legitimate `completed → chip_entry` transition is the
-- "Reopen Chip Entry" button on GameSummaryScreen (admin-only). It now
-- routes through the new SECURITY DEFINER RPC `reopen_completed_game`,
-- which sets a transaction-local flag the trigger honors.
-- =============================================================================

-- ─── 1. Status-monotonic guard on games UPDATE ──────────────────────────────

CREATE OR REPLACE FUNCTION block_completed_status_downgrade()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Sanctioned escape A: full-group cascade delete (delete_group RPC,
  -- migration 076). When a group is being torn down the games rows are
  -- DELETEd, but if any pre-delete UPDATE happens it should still be
  -- allowed.
  IF current_setting('app.cascade_group_delete', true) = '1' THEN
    RETURN NEW;
  END IF;

  -- Sanctioned escape B: explicit reopen-completed-game RPC. The only
  -- legitimate `completed → chip_entry` transition. RPC is admin-gated.
  IF current_setting('app.allow_completed_reopen', true) = '1' THEN
    RETURN NEW;
  END IF;

  -- Cascade context (defensive — UPDATE shouldn't fire from an outer
  -- DELETE cascade in this schema, but cheap to check).
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  -- Status not changing → trivially allowed (covers the common case
  -- where some other column on the games row is being updated).
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- Forward transitions are fine: live → chip_entry → completed.
  -- The ONLY rejected transition is "was completed, now isn't".
  IF OLD.status = 'completed' AND NEW.status <> 'completed' THEN
    RAISE EXCEPTION
      'Cannot downgrade games row % from "completed" to "%". '
      'Once a game is marked completed, its status is immutable except '
      'via the reopen_completed_game(uuid) RPC, which sets a '
      'transaction-local flag this trigger honors. This guard exists '
      'because stale tabs were reverting status="completed" → "live" '
      'via a blanket games upsert (the games sync used to push every '
      'local game, even untouched ones). Once status flipped, the '
      'BEFORE-DELETE guard on game_players (migration 050) read the '
      'now-stale status and allowed the roster to be wiped one row at '
      'a time. See migration 077 comments + git history for v5.61.0.',
      OLD.id, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_completed_status_downgrade ON games;
CREATE TRIGGER guard_completed_status_downgrade
  BEFORE UPDATE OF status ON games
  FOR EACH ROW EXECUTE FUNCTION block_completed_status_downgrade();

COMMENT ON FUNCTION block_completed_status_downgrade IS
  'Migration 077 — Rejects UPDATEs that revert games.status from "completed". '
  'Honors app.cascade_group_delete (delete_group RPC) and '
  'app.allow_completed_reopen (reopen_completed_game RPC) escape flags. '
  'Defends against stale-tab blanket upserts re-living completed games, '
  'which had been the recurring cause of weekend roster wipes.';

-- ─── 2. Sanctioned reopen-completed-game RPC ────────────────────────────────

-- The "Reopen Chip Entry" button on GameSummaryScreen calls this. It is
-- admin-only (group owner OR group admin). It flips the transaction-local
-- escape flag and updates status; the flag clears at COMMIT, so it can't
-- leak to other connections.

CREATE OR REPLACE FUNCTION reopen_completed_game(p_game_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group_id  UUID;
  v_caller    UUID := auth.uid();
  v_authorized BOOLEAN;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT group_id INTO v_group_id FROM games WHERE id = p_game_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'Game % not found', p_game_id;
  END IF;

  -- Admin OR owner OR super-admin. Mirrors the existing UI gates so the
  -- RPC isn't a privilege-escalation surface.
  v_authorized :=
    EXISTS (SELECT 1 FROM groups g
             WHERE g.id = v_group_id AND g.created_by = v_caller)
    OR EXISTS (SELECT 1 FROM group_members gm
                WHERE gm.group_id = v_group_id
                  AND gm.user_id = v_caller
                  AND gm.role = 'admin')
    OR EXISTS (SELECT 1 FROM super_admins sa
                WHERE sa.user_id = v_caller);

  IF NOT v_authorized THEN
    RAISE EXCEPTION 'Only group admins or the owner can reopen a completed game';
  END IF;

  PERFORM set_config('app.allow_completed_reopen', '1', true);

  UPDATE games SET status = 'chip_entry' WHERE id = p_game_id;
END;
$$;

REVOKE ALL ON FUNCTION reopen_completed_game(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reopen_completed_game(UUID) TO authenticated;

COMMENT ON FUNCTION reopen_completed_game IS
  'Migration 077 — Sanctioned escape for the only legitimate '
  'completed→chip_entry transition (the GameSummaryScreen "Reopen Chip '
  'Entry" admin button). Sets app.allow_completed_reopen flag honored by '
  'block_completed_status_downgrade. Admin-gated.';
