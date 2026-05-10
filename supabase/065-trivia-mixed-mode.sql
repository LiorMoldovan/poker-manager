-- 065 — Allow 'mixed' as a third value in trivia_sessions.mode and
--       trivia_reports.mode, to support the new "play questions from
--       both pools" option on the trivia landing screen.
--
-- Why this exists:
--   v5.47.0 trivia game (migration 063) only had two modes — 'group'
--   (questions about the crew) and 'players' (questions about
--   specific people). The new landing page (this release) lets users
--   pick a third option, "mixed", which draws from both pools.
--   The CHECK constraints on `trivia_sessions.mode` and
--   `trivia_reports.mode` reject anything outside that two-value
--   list, so we need to extend both.
--
-- Why a separate migration:
--   Keeping the table-creation migration (063 / 064) untouched lets
--   anyone running an old DB snapshot apply 063→064→065 in order
--   without surprises. Postgres CHECK constraints cannot be ALTER-ed
--   in place; the standard pattern is DROP + ADD with the same name.

ALTER TABLE trivia_sessions
  DROP CONSTRAINT IF EXISTS trivia_sessions_mode_check;

ALTER TABLE trivia_sessions
  ADD CONSTRAINT trivia_sessions_mode_check
  CHECK (mode IN ('group', 'players', 'mixed'));

ALTER TABLE trivia_reports
  DROP CONSTRAINT IF EXISTS trivia_reports_mode_check;

ALTER TABLE trivia_reports
  ADD CONSTRAINT trivia_reports_mode_check
  CHECK (mode IN ('group', 'players', 'mixed'));

-- ============================================================
-- Verify with:
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--   WHERE conrelid IN ('trivia_sessions'::regclass, 'trivia_reports'::regclass)
--     AND conname LIKE '%_mode_check';
-- ============================================================
