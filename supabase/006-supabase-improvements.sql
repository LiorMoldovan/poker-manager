-- ============================================================
-- Phase 6: Supabase-Native Improvements
-- Run in Supabase SQL Editor after 005-security-hardening.sql
-- ============================================================

-- ══════════════════════════════════════════════
-- 1. Zero-Sum Validation Trigger
-- Prevents saving a completed game where profits don't sum to zero.
-- Only fires when game status changes to 'completed'.
-- ══════════════════════════════════════════════

CREATE OR REPLACE FUNCTION check_game_zero_sum()
RETURNS TRIGGER AS $$
DECLARE
  total NUMERIC;
BEGIN
  IF NEW.status = 'completed' AND (OLD.status IS NULL OR OLD.status <> 'completed') THEN
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

DROP TRIGGER IF EXISTS trg_game_zero_sum ON games;
CREATE TRIGGER trg_game_zero_sum
  BEFORE INSERT OR UPDATE ON games
  FOR EACH ROW
  EXECUTE FUNCTION check_game_zero_sum();

-- ══════════════════════════════════════════════
-- 2. Server-Side Game Statistics RPC
-- Returns per-player aggregate stats without transferring
-- all game data to the client for computation.
-- ══════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_player_stats(p_group_id UUID)
RETURNS TABLE (
  player_id UUID,
  player_name TEXT,
  games_played BIGINT,
  total_profit NUMERIC,
  total_rebuys BIGINT,
  biggest_win NUMERIC,
  biggest_loss NUMERIC,
  avg_profit NUMERIC,
  win_count BIGINT,
  loss_count BIGINT,
  current_streak INTEGER
) AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM group_members WHERE group_id = p_group_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not a member of this group';
  END IF;

  RETURN QUERY
  SELECT
    gp.player_id,
    gp.player_name,
    COUNT(*)::BIGINT AS games_played,
    SUM(gp.profit) AS total_profit,
    SUM(gp.rebuys)::BIGINT AS total_rebuys,
    MAX(gp.profit) AS biggest_win,
    MIN(gp.profit) AS biggest_loss,
    AVG(gp.profit) AS avg_profit,
    COUNT(*) FILTER (WHERE gp.profit > 0)::BIGINT AS win_count,
    COUNT(*) FILTER (WHERE gp.profit < 0)::BIGINT AS loss_count,
    0 AS current_streak
  FROM game_players gp
  JOIN games g ON g.id = gp.game_id
  WHERE g.group_id = p_group_id
    AND g.status = 'completed'
  GROUP BY gp.player_id, gp.player_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ══════════════════════════════════════════════
-- 3. Game Count by Status — lightweight check
-- ══════════════════════════════════════════════

CREATE OR REPLACE FUNCTION get_game_counts(p_group_id UUID)
RETURNS TABLE (
  status TEXT,
  cnt BIGINT
) AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM group_members WHERE group_id = p_group_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not a member of this group';
  END IF;

  RETURN QUERY
  SELECT g.status, COUNT(*)::BIGINT
  FROM games g
  WHERE g.group_id = p_group_id
  GROUP BY g.status;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ══════════════════════════════════════════════
-- 4. Additional Performance Indexes
-- Based on common query patterns in the app.
-- ══════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_chronicle_profiles_group
  ON chronicle_profiles(group_id);

CREATE INDEX IF NOT EXISTS idx_graph_insights_group
  ON graph_insights(group_id);

CREATE INDEX IF NOT EXISTS idx_tts_pools_game
  ON tts_pools(game_id);

CREATE INDEX IF NOT EXISTS idx_players_group
  ON players(group_id);

CREATE INDEX IF NOT EXISTS idx_settings_group
  ON settings(group_id);

CREATE INDEX IF NOT EXISTS idx_chip_values_group
  ON chip_values(group_id);

-- ══════════════════════════════════════════════
-- 5. Cleanup: auto-delete old activity log entries (>90 days)
-- Runs via pg_cron or can be called manually.
-- ══════════════════════════════════════════════

CREATE OR REPLACE FUNCTION cleanup_old_activity(days_to_keep INTEGER DEFAULT 90)
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
  caller_group UUID;
BEGIN
  SELECT gm.group_id INTO caller_group
  FROM group_members gm
  JOIN groups g ON g.id = gm.group_id
  WHERE gm.user_id = auth.uid() AND g.created_by = auth.uid()
  LIMIT 1;

  IF caller_group IS NULL THEN
    RAISE EXCEPTION 'Only the group owner can clean up activity logs';
  END IF;

  DELETE FROM activity_log
  WHERE group_id = caller_group
    AND timestamp < NOW() - (days_to_keep || ' days')::INTERVAL;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ══════════════════════════════════════════════
-- 6. Cloud Backups Table
-- Stores point-in-time snapshots of group data.
-- Replaces the old in-memory-only backup (which was lost on refresh).
-- ══════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS backups (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id    UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  type        TEXT NOT NULL DEFAULT 'manual' CHECK (type IN ('auto', 'manual')),
  trigger     TEXT CHECK (trigger IS NULL OR trigger IN ('friday', 'game-end')),
  data        JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_backups_group ON backups(group_id, created_at DESC);

ALTER TABLE backups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "backups_select" ON backups;
CREATE POLICY "backups_select" ON backups
  FOR SELECT USING (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "backups_insert" ON backups;
CREATE POLICY "backups_insert" ON backups
  FOR INSERT WITH CHECK (
    group_id IN (
      SELECT gm.group_id FROM group_members gm
      WHERE gm.user_id = auth.uid() AND gm.role = 'admin'
    )
  );

DROP POLICY IF EXISTS "backups_delete" ON backups;
CREATE POLICY "backups_delete" ON backups
  FOR DELETE USING (
    group_id IN (
      SELECT gm.group_id FROM group_members gm
      WHERE gm.user_id = auth.uid() AND gm.role = 'admin'
    )
  );

-- Keep max 5 backups per group (run periodically or after each backup)
CREATE OR REPLACE FUNCTION prune_old_backups(p_group_id UUID, max_backups INTEGER DEFAULT 5)
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM group_members
    WHERE group_id = p_group_id AND user_id = auth.uid() AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Only admins can prune backups';
  END IF;

  WITH ranked AS (
    SELECT id, ROW_NUMBER() OVER (ORDER BY created_at DESC) AS rn
    FROM backups WHERE group_id = p_group_id
  )
  DELETE FROM backups WHERE id IN (
    SELECT id FROM ranked WHERE rn > max_backups
  );
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ══════════════════════════════════════════════
-- 7. Add language column to settings (for i18n)
-- ══════════════════════════════════════════════

ALTER TABLE settings ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'he';

-- ══════════════════════════════════════════════
-- DONE — Verify with:
--   SELECT proname FROM pg_proc WHERE proname IN
--     ('check_game_zero_sum', 'get_player_stats', 'get_game_counts', 'cleanup_old_activity');
--   SELECT column_name FROM information_schema.columns WHERE table_name = 'settings' AND column_name = 'language';
-- ══════════════════════════════════════════════
