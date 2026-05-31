-- =========================================================================
-- Migration 091 — Block status='completed' when 0 game_players exist
-- =========================================================================
-- Created: 2026-05-31
-- Incident: 5ecedefe-8dff-48f0-9cea-6f8a6f5ccd96 (Poker Night, אייל, May 31)
--
-- Symptom
--   Completed game appears in History as "0 players • 0 buy-ins" — the
--   game row exists with status='completed' and completed_at set, but
--   there are zero rows in game_players for that game_id.
--
-- Root cause
--   Client local cache had all 7 players (verified by the auto game-end
--   backup taken at the moment of completion, which serializes from local
--   cache and recorded 7 valid game_players). The client-side push of
--   game_players to Supabase via pushToSupabase[GAME_PLAYERS] failed
--   silently — logSyncError only logs to console — and the failure was
--   never surfaced to the user. The subsequent status flip to 'completed'
--   succeeded because the existing check_game_zero_sum trigger only
--   verifies ABS(SUM(profit))>0.01, which passes vacuously for 0 rows
--   (SUM is 0). Net result: a phantom completed game in the DB.
--
--   This was the same pattern Lior had seen "3-4 times in a row" over
--   prior weeks. Earlier sessions misdiagnosed it as a delete/wipe issue
--   (because we had no audit trail and assumed rows had existed and been
--   removed). Migrations 088 (immutability + completed_at + audit log)
--   and 090 (audit triggers SECURITY DEFINER so they actually run under
--   user JWT) eliminated the delete-wipe vector AND gave us audit data
--   that proved this incident was a SYNC failure, not a delete.
--
-- The fix
--   Extend check_game_zero_sum to also raise check_violation when the
--   first real transition to 'completed' is attempted with zero
--   game_players for that game_id. This turns a silent data-loss bug
--   into a loud, recoverable error: chip entry submission will fail,
--   the user is told why, and they refresh + re-submit (by which time
--   any transient network/RLS issue is more likely to be resolved).
--
-- Scope
--   - One function replaced (CREATE OR REPLACE, idempotent).
--   - Branch only fires on the FIRST transition to 'completed' (the
--     existing is_real_completion gate). Existing completed games with
--     non-zero rosters are unaffected.
--   - No schema changes, no new tables, no new triggers, no RLS changes.
--
-- Sandbox-verified (live DB, 2026-05-31)
--   - test1_0p_blocked    : completing with 0 players → RAISE 23514 ✓
--   - test2_valid_completes: completing with 2 valid 0-sum players → ok ✓
--
-- Follow-up (NOT in this migration)
--   - Client: surface logSyncError failures to the user (toast/banner)
--     so a silent sync drop never goes unnoticed. Without it, the user
--     will hit the loud DB error on completion instead of game creation.
--   - Client: re-attempt the game_players upsert atomically on chip-
--     entry submission, with per-row error reporting on conflict.
-- =========================================================================

CREATE OR REPLACE FUNCTION public.check_game_zero_sum()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  total NUMERIC;
  player_count INT;
  is_real_completion BOOLEAN;
BEGIN
  -- A "real" completion is either:
  --   1. UPDATE where the row was previously not completed, OR
  --   2. INSERT of a brand-new row (id not already present).
  is_real_completion := (
    NEW.status = 'completed' AND (
      (TG_OP = 'UPDATE' AND (OLD.status IS NULL OR OLD.status <> 'completed'))
      OR
      (TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM games WHERE id = NEW.id))
    )
  );

  IF is_real_completion THEN
    -- Mig 091: refuse completion when the roster never reached the DB.
    SELECT COUNT(*) INTO player_count
    FROM game_players
    WHERE game_id = NEW.id;

    IF player_count = 0 THEN
      RAISE EXCEPTION
        'Cannot complete game % with 0 players. The roster never reached the database '
        '(likely a silent sync failure during game creation). Refresh the app and '
        're-enter chip counts so the players sync to the server before marking complete. '
        'See migration 091 for context.',
        NEW.id
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT COALESCE(SUM(profit), 0) INTO total
    FROM game_players
    WHERE game_id = NEW.id;

    IF ABS(total) > 0.01 THEN
      RAISE EXCEPTION 'Game profits must sum to zero. Current sum: %', total;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- Sanity (inline, runs at apply time)
DO $$
DECLARE
  has_guard BOOLEAN;
BEGIN
  SELECT (pg_get_functiondef('public.check_game_zero_sum'::regproc) LIKE '%Cannot complete game % with 0 players%')
    INTO has_guard;
  IF NOT has_guard THEN
    RAISE EXCEPTION 'Mig 091 sanity failed: 0-player guard not present in check_game_zero_sum body';
  END IF;
  RAISE NOTICE 'Mig 091 installed: completion with 0 game_players is now blocked at the DB.';
END $$;
