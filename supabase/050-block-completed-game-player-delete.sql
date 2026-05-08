-- ============================================================================
-- Migration 050: protect game_players from any direct delete once the parent
-- game is `completed`
-- ============================================================================
--
-- Friday 2026-05-08 03:44 — Lior reports for the SECOND week in a row that a
-- completed game's roster vanishes a few minutes after the game ends. The
-- `games` row stays (status='completed', date+location intact), but every
-- `game_players` row for that game gets wiped. The History card then shows
-- "0 שחקנים • 0 קניות" instead of the real result, settlements break, and the
-- statistics screen forgets the game ever happened. Same shape as the
-- 2026-05-03 incident that triggered migration 043.
--
-- Verification on the live DB before authoring this migration:
--   • games row 21a01bec-…-2981 (May 7, "אייל"): status=completed, intact.
--   • game_players for that game: 0 rows.
--   • backups row 2bad11f4-… (auto, trigger=game-end, created_at
--     2026-05-08 00:13:15 UTC — 6h after the game ended) STILL contains the
--     7 player rows for that game. So the wipe happened AFTER the game-end
--     backup was taken, in the ~30 minutes before the user noticed.
--
-- Why the v5.34.2 / migration-043 hardening did not catch it:
--   • `block_bulk_direct_delete` only rejects DELETE statements that affect
--     more than one row in a single statement (the OLD client's "delete every
--     server row not in local" garbage-collector pattern). It deliberately
--     passes single-row deletes through so the v5.34.2 client can issue
--     `DELETE FROM game_players WHERE id = $1` (the legitimate "player didn't
--     show up" button on a LIVE game), and so cascade deletes from
--     `DELETE FROM games WHERE id = $1` can do their job.
--   • A stale client running iterative single-row deletes (a `for`-loop that
--     calls `supabase.from('game_players').delete().eq('id', ...)` per row)
--     therefore slips through one row at a time. Each individual statement is
--     a "1-row direct DELETE" — perfectly legal under the old guard — and the
--     net effect is the same wipe.
--   • The RLS policy `gp_delete` lets ANY group member (admin OR member,
--     migration 007 collapsed viewer into member) delete ANY game_players row
--     in the group. There is no "but only if the game is still live"
--     constraint. So a stale or mis-acting client has full permission.
--
-- The structural problem: `game_players` rows for a `completed` game are
-- IMMUTABLE BUSINESS DATA. Once chip-entry has been finalized, the zero-sum
-- has been verified, and the row sits in history, no client should ever issue
-- a direct DELETE against it. The only legitimate way to remove such a row is
-- by removing its parent `games` row (deliberate user "delete game" action,
-- which cascades). No code path in the current TypeScript client calls
-- `removeGamePlayer` against a completed game — that handler is reachable only
-- from `LiveGameScreen`, and even there it gates on `rebuys <= 1`. So we can
-- safely declare a hard DB-level invariant: "you can't directly DELETE a
-- game_players row whose game is completed; cascade is the only path."
--
-- Implementation: BEFORE DELETE row-level trigger that
--   1. Checks `pg_trigger_depth() > 1` and exits early if so. Cascade deletes
--      from `games` removal travel through internal FK triggers, which raises
--      `pg_trigger_depth()` above 1, so a real "delete this whole game"
--      action still removes everything atomically.
--   2. Looks up the parent `games.status` and rejects the delete if it is
--      'completed'. Live, chip_entry, or NULL games still allow direct
--      single-row deletes (the "player didn't show up" path on a live game).
--   3. Uses a clear ERRCODE + message so any sync-error logger surfaces what
--      happened ("Cannot delete game_players for completed game …").
--
-- This is the layered companion to migration 043, not a replacement. Together:
--   • 043 stops bulk-shaped wipes anywhere in the at-risk tables.
--   • 050 stops single-row wipes specifically for completed-game rosters,
--     which 043 was structurally incapable of catching.
--
-- Symmetry note: we deliberately DO NOT add the same per-row guard to
-- `shared_expenses`, `game_forecasts`, `paid_settlements`, or `period_markers`.
--   • `paid_settlements` are CREATED post-completion (mark a debt as paid),
--     so locking deletes there would break legitimate "undo paid" UX.
--   • `game_forecasts` are deleted-then-reinserted by `pushToSupabase`'s
--     per-game reconciliation every time an admin saves anything on the
--     completed game (e.g. AI summary). Locking deletes there would break
--     every save on a completed game.
--   • `shared_expenses` and `period_markers` are similarly reconciled.
--   • The user-visible "the game disappeared" symptom is driven entirely by
--     `game_players` (it's the only table the History card and Statistics
--     screen read player counts and profits from). Protect that one table
--     and the bug class is closed.
--
-- This is intentionally a permanent guardrail — the invariant "completed-game
-- rosters are read-only at the row level" is part of the data model, not a
-- temporary patch. If we ever introduce a legitimate "edit a completed game's
-- roster" feature in the future, that path will go through a SECURITY DEFINER
-- RPC (which runs as table owner and is exempt from RLS — but NOT from this
-- trigger; the trigger is a hard rule on the table itself, regardless of who
-- the caller is). The right way to add such a feature would be: replace this
-- trigger with one that whitelists the new RPC via `current_setting()` flags,
-- not bypass the rule.
-- ============================================================================

-- ─── 1. The guard function ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION block_completed_game_player_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  parent_status TEXT;
BEGIN
  -- Allow cascade deletes (e.g. DELETE FROM games … cascades via the FK to
  -- game_players). Cascade fires from internal FK triggers, which sets
  -- pg_trigger_depth() > 1. The user-action `deleteGame` path in storage.ts
  -- relies on this: it issues a single-row DELETE on `games`, the FK cascade
  -- removes children, and we must not block the cascade.
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  SELECT status INTO parent_status
  FROM games
  WHERE id = OLD.game_id;

  -- If the parent game no longer exists we're in some unusual orphan-cleanup
  -- path; let it through.
  IF parent_status IS NULL THEN
    RETURN OLD;
  END IF;

  IF parent_status = 'completed' THEN
    RAISE EXCEPTION
      'Cannot delete game_players row % for completed game %. '
      'Completed games are immutable at the row level — the only way to '
      'remove rows from a completed game is to delete the games row '
      '(cascade handles the rest). This guard exists because stale or '
      'misbehaving clients have repeatedly wiped completed-game rosters '
      'via iterative single-row deletes (see migration 050 comment for '
      'context).',
      OLD.id, OLD.game_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN OLD;
END;
$$;

-- ─── 2. Attach the trigger ──────────────────────────────────────────────────
-- BEFORE DELETE so the row never actually leaves the table on a blocked call
-- (vs. the existing `guard_no_bulk_delete` which is statement-level AFTER —
-- both abort the statement, but BEFORE here is cleaner because the per-row
-- check has its decision before any work happens).

DROP TRIGGER IF EXISTS guard_completed_game_player_delete ON game_players;
CREATE TRIGGER guard_completed_game_player_delete
  BEFORE DELETE ON game_players
  FOR EACH ROW
  EXECUTE FUNCTION block_completed_game_player_delete();

-- ─── 3. Sanity check ────────────────────────────────────────────────────────

DO $$
DECLARE
  trig_count INT;
BEGIN
  SELECT COUNT(*) INTO trig_count
  FROM pg_trigger
  WHERE tgname = 'guard_completed_game_player_delete'
    AND NOT tgisinternal;

  IF trig_count <> 1 THEN
    RAISE WARNING
      'Expected 1 guard_completed_game_player_delete trigger but found %. '
      'Inspect with: SELECT tgname, tgrelid::regclass FROM pg_trigger WHERE tgname = ''guard_completed_game_player_delete'';',
      trig_count;
  ELSE
    RAISE NOTICE 'guard_completed_game_player_delete trigger installed on game_players.';
  END IF;
END $$;

-- ─── 4. Self-verification (run manually after applying) ─────────────────────
--
-- a) DIRECT delete on a row whose game is completed must FAIL:
--    BEGIN;
--      SAVEPOINT sp;
--      DELETE FROM game_players WHERE id = (
--        SELECT gp.id FROM game_players gp
--        JOIN games g ON g.id = gp.game_id
--        WHERE g.status = 'completed' LIMIT 1
--      );
--      -- Should raise: "Cannot delete game_players row …"
--      ROLLBACK TO sp;
--    ROLLBACK;
--
-- b) DIRECT delete on a row whose game is live/chip_entry must SUCCEED.
--
-- c) CASCADE delete (DELETE FROM games WHERE id = …) must SUCCEED end-to-end —
--    the trigger fires at depth > 1 and exits early, allowing the cascade to
--    sweep all dependents.
