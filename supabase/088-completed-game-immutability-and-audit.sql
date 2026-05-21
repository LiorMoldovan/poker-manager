-- ============================================================================
-- Migration 088: permanent completed-game immutability + comprehensive audit log
-- ============================================================================
--
-- 2026-05-21 — Lior reports for the FOURTH time that a completed game's
-- roster vanished. May 20 21:00 game (group "Poker Night", id 8b02cfcb-…)
-- had all 8 game_players at the auto game-end backup (02:39 IL), and 0
-- rows by the time Lior checked at ~09:45. ALL FIVE existing guard
-- triggers (043/050/051/076/077) were ENABLED at the moment of the wipe.
--
-- Forensics from activity_log:
--   • 03:07:53 IL — last activity before the gap (קוראן, Home, member)
--   • 08:26:22 → 08:26:58 — חרדון (admin) navigates Home → Statistics →
--     History → "Game Details" (= GameSummaryScreen route).
--     Session duration: 1 minute. No "Chip Entry" screen logged because
--     activity_log writes are throttled (2-min cooldown) and his app
--     session ended before the next push.
--   • 09:32:15 — Lior first sees the wipe.
--
-- Attack vector (now understood):
--   1. חרדון opens GameSummaryScreen for the completed game.
--   2. Taps "פתח מחדש ספירת ז'יטונים" / "Reopen Chip Entry" (whether
--      intentionally or by mis-tap), which calls
--      updateGameStatus(gameId, 'chip_entry') in storage.ts.
--   3. updateGameStatus detects a 'completed → chip_entry' downgrade and
--      routes through the sanctioned RPC reopen_completed_game(uuid).
--   4. The RPC sets app.allow_completed_reopen=1 (transaction-local) and
--      UPDATEs games.status to 'chip_entry'. Migration 077's downgrade
--      guard honors the flag and lets this through.
--   5. games.status is now 'chip_entry'. The BEFORE-DELETE row trigger
--      from migration 050 (block_completed_game_player_delete) reads the
--      CURRENT parent status — sees 'chip_entry', not 'completed' — and
--      ALLOWS subsequent direct DELETEs on game_players.
--   6. Something between 08:27 and 09:30 — a stale tab on another device,
--      a delayed Realtime echo, an iterative client-side garbage-collect
--      — issues per-row DELETEs of all 8 game_players. Each one slips
--      through 050 (parent.status='chip_entry') AND 051 (each statement
--      affects 1 row, not bulk).
--   7. Status eventually flips back to 'completed' (via legitimate chip
--      entry completion, or via a stale tab pushing a completed games row).
--
-- Why the fix below is structural rather than another client patch:
--   The fundamental invariant is "game_players for a completed game are
--   immutable at the row level — direct DELETEs are never allowed." The
--   prior implementation (050) bound this invariant to the CURRENT
--   games.status value, which created a window of vulnerability during
--   any reopen. The fix is to make the invariant time-monotonic: once a
--   game has EVER been completed, its game_players are sealed. A reopen
--   is allowed to UPDATE chip counts / profits (because chip entry only
--   ever UPDATEs game_players, never DELETEs them), but cannot remove
--   rows.
--
-- This migration:
--   1. Adds games.completed_at TIMESTAMPTZ — set the moment a game first
--      reaches status='completed', never cleared (backfilled with NOW()
--      for existing completed games — exact timestamp doesn't matter for
--      the invariant; non-NULL is what counts).
--   2. Adds BEFORE-UPDATE trigger on games that auto-sets completed_at
--      on the first 'X → completed' transition, and BLOCKS any UPDATE
--      that clears completed_at while status is still / again completed.
--   3. Rewrites block_completed_game_player_delete to gate on
--      `parent.completed_at IS NOT NULL` instead of
--      `parent.status = 'completed'`. Cascade-from-games still exempted
--      via pg_trigger_depth(). app.cascade_group_delete escape still
--      honored. NEW escape: app.allow_completed_game_player_update — but
--      we DO NOT add a "delete during reopen" escape, because chip entry
--      doesn't need one.
--   4. Adds new `game_audit_log` table that records EVERY:
--        - status change on games (UPDATE OF status, regardless of who/why)
--        - game_players DELETE attempt (regardless of whether allowed)
--        - reopen_completed_game RPC invocation
--      with: occurred_at, actor_id (auth.uid()), actor_email, op,
--      target_game_id, before/after JSONB, current_setting flags, error
--      message (if blocked). RLS: group admins/owner + super admin
--      can SELECT for their group.
--      The point: if this EVER happens again, we don't investigate
--      blindly — we look at the audit log and see exactly who did what.
--
-- Sandbox-tested before applying via BEGIN/inner-block/RAISE EXCEPTION
-- rollback pattern (5 cases: cascade-delete-on-completed,
-- direct-delete-during-reopen, direct-delete-on-live, profit-update-on-
-- reopened, status-downgrade-via-RPC). All pass.
-- ============================================================================

-- ─── 1. games.completed_at — the "ever-completed" marker ────────────────────

ALTER TABLE games
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

COMMENT ON COLUMN games.completed_at IS
  'Migration 088 — Set automatically the first time games.status transitions '
  'to ''completed''. NEVER cleared (the BEFORE-UPDATE trigger blocks any '
  'attempt). Used by block_completed_game_player_delete to determine '
  'whether a game is permanently in "immutable roster" mode, regardless '
  'of current status (covers the reopen-chip-entry window where status '
  'temporarily flips back to chip_entry).';

-- Backfill: every existing completed game gets a non-NULL completed_at.
-- We use COALESCE(now()) — the exact value doesn't matter, only that it's
-- non-NULL. Idempotent: re-runs do not overwrite.
UPDATE games
SET completed_at = COALESCE(completed_at, now())
WHERE status = 'completed' AND completed_at IS NULL;

-- ─── 2. Auto-set completed_at on status → completed; block clearing ─────────

CREATE OR REPLACE FUNCTION manage_games_completed_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Auto-set on first 'X → completed' transition.
  IF NEW.status = 'completed' AND (OLD.status IS DISTINCT FROM 'completed')
     AND NEW.completed_at IS NULL THEN
    NEW.completed_at := now();
  END IF;

  -- Block any UPDATE that nulls out completed_at. Once set, sealed.
  -- (Cascade-group-delete is the only sanctioned full wipe, and it
  -- DELETEs the games row rather than UPDATEing it, so this branch
  -- doesn't need an escape.)
  IF OLD.completed_at IS NOT NULL AND NEW.completed_at IS NULL THEN
    RAISE EXCEPTION
      'Cannot clear games.completed_at on row % — it is sealed. '
      'Once a game has been completed, completed_at is permanent.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_manage_games_completed_at ON games;
CREATE TRIGGER trg_manage_games_completed_at
  BEFORE UPDATE ON games
  FOR EACH ROW
  EXECUTE FUNCTION manage_games_completed_at();

-- ─── 3. Tighten block_completed_game_player_delete to use completed_at ─────

CREATE OR REPLACE FUNCTION block_completed_game_player_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  parent_completed_at TIMESTAMPTZ;
BEGIN
  -- Sanctioned escape: full-group cascade delete (delete_group RPC).
  IF current_setting('app.cascade_group_delete', true) = '1' THEN
    RETURN OLD;
  END IF;

  -- Cascade-from-parent exemption: DELETE FROM games … cascades via the
  -- ON DELETE CASCADE FK to game_players. The cascade fires with
  -- pg_trigger_depth() > 1. This is the legitimate "delete this whole
  -- game" path (deleteGame in storage.ts).
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  SELECT completed_at INTO parent_completed_at
  FROM games WHERE id = OLD.game_id;

  -- Game no longer exists (orphan cleanup path) — let it through.
  IF parent_completed_at IS NULL THEN
    -- Belt-and-suspenders: ALSO check current status, just in case a
    -- game somehow has completed_at=NULL but status='completed' (would
    -- only happen if the games row was INSERTed without going through
    -- the trigger flow, e.g. via a backup restore that skipped the
    -- trigger). Read current status as a fallback gate.
    DECLARE
      parent_status TEXT;
    BEGIN
      SELECT status INTO parent_status FROM games WHERE id = OLD.game_id;
      IF parent_status IS NULL THEN
        RETURN OLD;
      END IF;
      IF parent_status = 'completed' THEN
        RAISE EXCEPTION
          'Cannot delete game_players row % for completed game % (status check). '
          'Completed games are immutable at the row level.',
          OLD.id, OLD.game_id
          USING ERRCODE = 'check_violation';
      END IF;
      RETURN OLD;
    END;
  END IF;

  -- Primary path: parent has been completed at some point. Sealed.
  RAISE EXCEPTION
    'Cannot delete game_players row % for game % (completed at %). '
    'Once a game has been completed, its game_players are PERMANENTLY '
    'immutable at the row level — they can only be removed via the '
    'whole-game cascade DELETE (DELETE FROM games WHERE id = $1) or '
    'via the delete_group(uuid) RPC. Reopening chip entry for edits '
    'does NOT enable deletes; chip entry only UPDATEs profit/chip_counts. '
    'This guard exists because reopen→delete→re-complete had been the '
    'recurring weekend roster-wipe vector — see migration 088 comments.',
    OLD.id, OLD.game_id, parent_completed_at
    USING ERRCODE = 'check_violation';
END;
$$;

-- ─── 4. Audit-log infrastructure ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS game_audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  group_id    UUID,
  game_id     UUID,
  actor_id    UUID,
  actor_email TEXT,
  op          TEXT NOT NULL CHECK (op IN (
    'STATUS_UPDATE',
    'GAME_PLAYER_DELETE_ATTEMPT',
    'REOPEN_RPC',
    'DELETE_GROUP_RPC',
    'GAME_INSERT',
    'GAME_DELETE'
  )),
  before_value JSONB,
  after_value  JSONB,
  flags        JSONB,
  error_message TEXT,
  notes        TEXT
);

CREATE INDEX IF NOT EXISTS game_audit_log_group_idx ON game_audit_log(group_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS game_audit_log_game_idx  ON game_audit_log(game_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS game_audit_log_actor_idx ON game_audit_log(actor_id, occurred_at DESC);

ALTER TABLE game_audit_log ENABLE ROW LEVEL SECURITY;

-- Group admin / owner SELECT, plus super admin SELECT/DELETE.
DROP POLICY IF EXISTS gal_admin_select ON game_audit_log;
CREATE POLICY gal_admin_select ON game_audit_log FOR SELECT TO authenticated USING (
  EXISTS (
    SELECT 1 FROM group_members gm
    WHERE gm.group_id = game_audit_log.group_id
      AND gm.user_id = auth.uid()
      AND gm.role = 'admin'
  )
  OR EXISTS (
    SELECT 1 FROM groups g WHERE g.id = game_audit_log.group_id AND g.created_by = auth.uid()
  )
  OR EXISTS (
    SELECT 1 FROM super_admins sa WHERE sa.user_id = auth.uid()
  )
);

DROP POLICY IF EXISTS gal_super_admin_delete ON game_audit_log;
CREATE POLICY gal_super_admin_delete ON game_audit_log FOR DELETE TO authenticated USING (
  EXISTS (SELECT 1 FROM super_admins sa WHERE sa.user_id = auth.uid())
);

-- Service role (for trigger writes) bypasses RLS implicitly — the
-- trigger functions run as the table owner (postgres), which is exempt.

-- ─── 5. Audit triggers ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION audit_log_games_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO game_audit_log (
      group_id, game_id, actor_id, op,
      before_value, after_value, flags
    )
    VALUES (
      NEW.group_id, NEW.id, auth.uid(), 'STATUS_UPDATE',
      jsonb_build_object('status', OLD.status, 'completed_at', OLD.completed_at),
      jsonb_build_object('status', NEW.status, 'completed_at', NEW.completed_at),
      jsonb_build_object(
        'cascade_group_delete', current_setting('app.cascade_group_delete', true),
        'allow_completed_reopen', current_setting('app.allow_completed_reopen', true),
        'trigger_depth', pg_trigger_depth()
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_games_status ON games;
CREATE TRIGGER trg_audit_games_status
  AFTER UPDATE OF status ON games
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_games_status();

CREATE OR REPLACE FUNCTION audit_log_game_player_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  parent_game RECORD;
BEGIN
  SELECT id, group_id, status, completed_at INTO parent_game
  FROM games WHERE id = OLD.game_id;

  INSERT INTO game_audit_log (
    group_id, game_id, actor_id, op,
    before_value, flags, notes
  )
  VALUES (
    parent_game.group_id, OLD.game_id, auth.uid(), 'GAME_PLAYER_DELETE_ATTEMPT',
    jsonb_build_object(
      'game_player_id', OLD.id,
      'player_id',      OLD.player_id,
      'player_name',    OLD.player_name,
      'profit',         OLD.profit,
      'rebuys',         OLD.rebuys,
      'parent_status',  parent_game.status,
      'parent_completed_at', parent_game.completed_at
    ),
    jsonb_build_object(
      'cascade_group_delete', current_setting('app.cascade_group_delete', true),
      'allow_completed_reopen', current_setting('app.allow_completed_reopen', true),
      'trigger_depth', pg_trigger_depth()
    ),
    CASE
      WHEN pg_trigger_depth() > 1 THEN 'cascade-from-games'
      WHEN current_setting('app.cascade_group_delete', true) = '1' THEN 'delete_group RPC'
      ELSE 'direct-delete'
    END
  );

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_game_player_delete ON game_players;
CREATE TRIGGER trg_audit_game_player_delete
  BEFORE DELETE ON game_players
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_game_player_delete();

-- ─── 6. Wrap reopen_completed_game to also audit-log ───────────────────────

CREATE OR REPLACE FUNCTION reopen_completed_game(p_game_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group_id   UUID;
  v_caller     UUID := auth.uid();
  v_authorized BOOLEAN;
  v_email      TEXT;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT group_id INTO v_group_id FROM games WHERE id = p_game_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'Game % not found', p_game_id;
  END IF;

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

  -- Capture the caller's email for the audit log (best-effort).
  SELECT email INTO v_email FROM auth.users WHERE id = v_caller;

  INSERT INTO game_audit_log (
    group_id, game_id, actor_id, actor_email, op, notes
  )
  VALUES (
    v_group_id, p_game_id, v_caller, v_email, 'REOPEN_RPC',
    'reopen_completed_game RPC invoked'
  );

  PERFORM set_config('app.allow_completed_reopen', '1', true);

  UPDATE games SET status = 'chip_entry' WHERE id = p_game_id;
END;
$$;

REVOKE ALL ON FUNCTION reopen_completed_game(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reopen_completed_game(UUID) TO authenticated;

-- ─── 7. Sanity ──────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_completed_no_ts INT;
  v_audit_triggers INT;
BEGIN
  SELECT COUNT(*) INTO v_completed_no_ts
  FROM games WHERE status = 'completed' AND completed_at IS NULL;

  IF v_completed_no_ts > 0 THEN
    RAISE WARNING '% completed games still have NULL completed_at (backfill incomplete)',
      v_completed_no_ts;
  END IF;

  SELECT COUNT(*) INTO v_audit_triggers
  FROM pg_trigger
  WHERE tgname IN ('trg_audit_games_status', 'trg_audit_game_player_delete',
                   'trg_manage_games_completed_at')
    AND NOT tgisinternal;

  IF v_audit_triggers <> 3 THEN
    RAISE WARNING 'Expected 3 new triggers from mig 088 but found %', v_audit_triggers;
  ELSE
    RAISE NOTICE 'Migration 088 installed: completed_at invariant + audit logging active.';
  END IF;
END $$;

-- ─── 8. Self-verification queries (run after applying) ─────────────────────
--
-- a) Backfill check
--    SELECT COUNT(*) FROM games WHERE status='completed' AND completed_at IS NULL;
--    Expected: 0
--
-- b) Try to DELETE a game_player for a completed game DIRECTLY → must FAIL
--    (already tested above; this version blocks on completed_at IS NOT NULL)
--
-- c) Try to clear completed_at via UPDATE → must FAIL
--    UPDATE games SET completed_at = NULL WHERE id = (any completed game);
--
-- d) Cascade DELETE FROM games on a completed game → must SUCCEED
--    (game_players cascade-removed via pg_trigger_depth() > 1 exemption)
--
-- e) reopen_completed_game(id) → must SUCCEED and write to game_audit_log
--    BUT subsequent DIRECT DELETE on game_players still FAILS
--    (status is now chip_entry, but completed_at is non-NULL — the new
--    invariant catches it)
