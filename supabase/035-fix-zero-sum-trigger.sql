-- ============================================================
-- Phase 35: Fix zero-sum trigger firing on metadata-only upserts
-- Run in Supabase SQL Editor.
-- ============================================================
--
-- Problem
-- -------
-- The check_game_zero_sum trigger (006-supabase-improvements.sql)
-- validates that SUM(game_players.profit) ≈ 0 whenever a game's
-- status transitions to 'completed'. The intent of the original IF:
--
--   IF NEW.status = 'completed'
--      AND (OLD.status IS NULL OR OLD.status <> 'completed') THEN ...
--
-- was to fire ONLY on the live→completed transition. But the trigger
-- is `BEFORE INSERT OR UPDATE`, and PostgreSQL fires BEFORE INSERT
-- triggers (with OLD = NULL) for *every* `INSERT ... ON CONFLICT DO
-- UPDATE` — even when the row already exists and the statement ends
-- up doing an UPDATE.
--
-- The app upserts the games row for many post-completion writes
-- (AI summary, comic, paid settlements, forecast comment, chip gap,
-- etc.). Each such upsert re-fires this validator. If the stored
-- profits carry any historical drift — e.g. a game finalized in an
-- older app version, or after a manual edit — the trigger now throws
-- the user-facing toast "Save failed: games/upsert — Game profits
-- must sum to zero. Current sum: -2".
--
-- Fix
-- ---
-- Rewrite the function to validate only on a *real* transition:
--   • UPDATE path: OLD.status really was non-completed before.
--   • INSERT path: no row with that id exists yet (i.e. a true brand
--     new insert, not the insert phase of an upsert).
-- ============================================================

CREATE OR REPLACE FUNCTION check_game_zero_sum()
RETURNS TRIGGER AS $$
DECLARE
  total NUMERIC;
  is_real_completion BOOLEAN;
BEGIN
  -- A "real" completion is either:
  --   1. UPDATE where the row was previously not completed, OR
  --   2. INSERT of a brand-new row (id not already present).
  -- The second branch is what excludes the BEFORE INSERT phase of
  -- INSERT...ON CONFLICT DO UPDATE for an already-existing game.
  is_real_completion := (
    NEW.status = 'completed' AND (
      (TG_OP = 'UPDATE' AND (OLD.status IS NULL OR OLD.status <> 'completed'))
      OR
      (TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM games WHERE id = NEW.id))
    )
  );

  IF is_real_completion THEN
    SELECT COALESCE(SUM(profit), 0) INTO total
    FROM game_players
    WHERE game_id = NEW.id;

    IF ABS(total) > 0.01 THEN
      RAISE EXCEPTION 'Game profits must sum to zero. Current sum: %', total;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger definition is unchanged — keep it BEFORE INSERT OR UPDATE
-- so the function is the only thing that needs migration. (Re-create
-- defensively in case it's missing in some environments.)
DROP TRIGGER IF EXISTS trg_game_zero_sum ON games;
CREATE TRIGGER trg_game_zero_sum
  BEFORE INSERT OR UPDATE ON games
  FOR EACH ROW
  EXECUTE FUNCTION check_game_zero_sum();

-- ============================================================
-- DONE — Verify with:
--   SELECT prosrc FROM pg_proc WHERE proname = 'check_game_zero_sum';
-- The function body should reference `is_real_completion`.
-- ============================================================
