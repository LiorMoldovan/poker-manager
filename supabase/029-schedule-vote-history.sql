-- ============================================================
-- Migration 029: Schedule feature — vote history (created_at)
-- Run in Supabase SQL Editor after 025-schedule-proxy-votes.sql
-- (Idempotent — safe to re-run.)
--
-- Why: The voter list in the UI showed only WHO voted, never WHEN
--   or whether the vote was changed afterwards. We track this by
--   recording the original creation time on each row in addition to
--   the existing `voted_at` (last cast/edit time).
--
-- Detection rule (client-side):
--   * Vote is "fresh"     when voted_at ≈ created_at  (delta ≤ 5s).
--   * Vote was "changed"  when voted_at >  created_at + 5s.
--   We use a tolerance because the same INSERT writes both columns
--   via DEFAULT now(), and the two now() evaluations can land a few
--   microseconds apart on slow-running statements.
--
-- RPC compatibility:
--   * cast_poll_vote / admin_cast_poll_vote both INSERT with an
--     explicit column list that does NOT include created_at, so the
--     DEFAULT now() applies on the initial INSERT path. Their
--     ON CONFLICT DO UPDATE clauses also do NOT mention created_at,
--     so the original creation timestamp is preserved on every edit.
--     ⇒ No RPC changes are needed by this migration.
-- ============================================================

ALTER TABLE game_poll_votes
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Backfill rows that existed before this migration: their created_at
-- defaulted to now() at column-add time, which is later than their
-- real voted_at. Reset created_at = voted_at for those rows so the
-- "changed" indicator does not fire spuriously on legacy data.
-- Idempotent: subsequent runs find no rows where created_at > voted_at.
UPDATE game_poll_votes
   SET created_at = voted_at
 WHERE created_at > voted_at;

CREATE INDEX IF NOT EXISTS idx_game_poll_votes_created_at
  ON game_poll_votes(created_at);

-- ============================================================
-- DONE — Verify with:
--   SELECT id, response, created_at, voted_at,
--          (voted_at - created_at) > interval '5 seconds' AS was_changed
--     FROM game_poll_votes
--     ORDER BY voted_at DESC LIMIT 10;
-- ============================================================
