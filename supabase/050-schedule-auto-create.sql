-- ============================================================================
-- Migration 050: settings columns for auto-create-poll schedule
-- ============================================================================
--
-- Adds four columns to `settings` so each group can configure a weekly
-- automatic-poll-creation schedule (off by default). When the toggle is on
-- and any admin loads the Schedule tab at-or-after the most recent
-- (day_of_week, time) occurrence, the client opens a new poll using the
-- group's existing default-poll values for shape (target / delay /
-- allow-maybe / proposed date = nextGameNightIso).
--
-- - `schedule_auto_create_enabled` BOOLEAN — master toggle. Default false
--   so every existing group keeps current behaviour.
-- - `schedule_auto_create_day` INTEGER — 0 (Sun) .. 6 (Sat). Default 0
--   (Sunday) since "open the next poll on Sunday evening" matches the
--   most common rhythm (last-week's game on Thu/Sat → schedule mid-week
--   game by Sunday evening). Constraint enforces 0..6.
-- - `schedule_auto_create_time` TEXT — 'HH:MM' 24h, default '18:00'.
--   Format-checked by a CHECK constraint to keep junk out of the column
--   without forcing a separate domain type.
-- - `schedule_auto_created_at` TIMESTAMPTZ — re-fire guard. Set to NOW()
--   each time the client triggers an auto-create (or detects an active
--   poll already covers this trigger). Used to ensure each weekly trigger
--   fires at most once across all admins on all devices.
--
-- ALL columns are NULLABLE on the timestamp + NOT NULL on the config
-- columns to mirror the pattern set by the existing schedule_default_*
-- columns (added in migration 023). Using `IF NOT EXISTS` so the
-- migration is idempotent.
-- ============================================================================

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS schedule_auto_create_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS schedule_auto_create_day INTEGER NOT NULL DEFAULT 0;

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS schedule_auto_create_time TEXT NOT NULL DEFAULT '18:00';

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS schedule_auto_created_at TIMESTAMPTZ;

-- Range checks. Wrapped in DO blocks with IF NOT EXISTS guards so re-runs
-- are no-ops instead of "constraint already exists" errors.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'settings_schedule_auto_create_day_range'
  ) THEN
    ALTER TABLE settings
      ADD CONSTRAINT settings_schedule_auto_create_day_range
      CHECK (schedule_auto_create_day BETWEEN 0 AND 6);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'settings_schedule_auto_create_time_format'
  ) THEN
    ALTER TABLE settings
      ADD CONSTRAINT settings_schedule_auto_create_time_format
      CHECK (schedule_auto_create_time ~ '^[0-2][0-9]:[0-5][0-9]$');
  END IF;
END $$;

-- Sanity check
DO $$
DECLARE
  col_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO col_count
  FROM information_schema.columns
  WHERE table_name = 'settings'
    AND column_name IN (
      'schedule_auto_create_enabled',
      'schedule_auto_create_day',
      'schedule_auto_create_time',
      'schedule_auto_created_at'
    );

  RAISE NOTICE 'auto-create-poll columns present on settings: % / 4', col_count;
END $$;
