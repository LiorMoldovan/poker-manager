-- ══════════════════════════════════════════════
-- Migration 020: Fix zero-sum trigger for batch upserts
-- Run manually in Supabase SQL Editor
--
-- Problem: trg_game_players_zero_sum fires FOR EACH ROW during a
-- batch upsert. After the first row is updated, the trigger checks
-- the sum of ALL game_players for that game — but only one row has
-- the new profit, so the partial sum ≠ 0 and the trigger rejects
-- the entire batch. This silently prevents game_players profits
-- from being saved to Supabase after a game is completed.
--
-- Fix: Make the trigger a CONSTRAINT trigger with DEFERRABLE
-- INITIALLY DEFERRED, so it only fires at transaction commit time
-- (after ALL rows in the batch have been updated).
-- ══════════════════════════════════════════════

-- Drop the old row-level trigger
DROP TRIGGER IF EXISTS trg_game_players_zero_sum ON game_players;

-- Recreate as a deferrable constraint trigger
CREATE CONSTRAINT TRIGGER trg_game_players_zero_sum
  AFTER INSERT OR UPDATE OF profit ON game_players
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION check_game_players_zero_sum();

-- ══════════════════════════════════════════════
-- DONE — Verify with:
--   SELECT tgname, tgdeferrable, tginitdeferred
--   FROM pg_trigger WHERE tgname = 'trg_game_players_zero_sum';
-- Expected: tgdeferrable=true, tginitdeferred=true
-- ══════════════════════════════════════════════
