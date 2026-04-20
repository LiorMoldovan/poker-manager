-- ══════════════════════════════════════════════
-- Migration 008: Realtime Publication + Zero-Sum Hardening
-- Run manually in Supabase SQL Editor
-- ══════════════════════════════════════════════

-- ══════════════════════════════════════════════
-- 1. Add missing tables to Realtime publication
--    The client subscribes to 15 tables, but only 11 were in the publication.
--    These 4 were missing: period_markers, tts_pools, group_members, groups.
--    Uses DO block to skip tables already in the publication.
-- ══════════════════════════════════════════════

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY['period_markers', 'tts_pools', 'group_members', 'groups'])
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND tablename = tbl
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I', tbl);
      RAISE NOTICE 'Added % to supabase_realtime', tbl;
    ELSE
      RAISE NOTICE '% already in supabase_realtime, skipping', tbl;
    END IF;
  END LOOP;
END $$;

-- ══════════════════════════════════════════════
-- 2. Zero-sum enforcement on game_players profit changes
--    The existing trigger (006) only fires when games.status → 'completed'.
--    This adds a trigger on game_players so editing profits on an
--    already-completed game is also validated.
-- ══════════════════════════════════════════════

CREATE OR REPLACE FUNCTION check_game_players_zero_sum()
RETURNS TRIGGER AS $$
DECLARE
  game_status TEXT;
  total NUMERIC;
BEGIN
  SELECT status INTO game_status FROM games WHERE id = NEW.game_id;

  IF game_status = 'completed' THEN
    SELECT COALESCE(SUM(profit), 0) INTO total
    FROM game_players WHERE game_id = NEW.game_id;

    IF ABS(total) > 0.01 THEN
      RAISE EXCEPTION 'Zero-sum violation: game_players profits sum to % (game %)', total, NEW.game_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_game_players_zero_sum ON game_players;
CREATE TRIGGER trg_game_players_zero_sum
  AFTER INSERT OR UPDATE OF profit ON game_players
  FOR EACH ROW
  EXECUTE FUNCTION check_game_players_zero_sum();

-- ══════════════════════════════════════════════
-- DONE — Verify with:
--   SELECT tablename FROM pg_publication_tables
--     WHERE pubname = 'supabase_realtime' ORDER BY tablename;
--   SELECT tgname FROM pg_trigger
--     WHERE tgname = 'trg_game_players_zero_sum';
-- ══════════════════════════════════════════════
