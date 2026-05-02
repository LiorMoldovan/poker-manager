-- ============================================================================
-- Migration 042: align settings.min_transfer column default with the frontend
-- ============================================================================
--
-- The frontend's `DEFAULT_SETTINGS` (`src/database/storage.ts`) treats
-- `minTransfer = 5` as the new-group default — this is the threshold below
-- which post-game settlement transfers are skipped. The column default in
-- the original schema (`supabase/schema.sql:150`) was `20`, which leaked
-- into every new group because the `create_group()` RPC (defined in
-- `supabase/004-group-management.sql`) inserts a settings row with only
-- `group_id` and lets every other column fall back to its schema default.
-- Result: members hitting the new-group wizard saw "Minimum transfer = 20"
-- instead of the frontend-advertised `5`, then had to manually drop it on
-- their first game session.
--
-- This migration just flips the column default to `5`. Existing groups are
-- intentionally left alone — many of them have legitimate non-default values
-- chosen by their owners, so a blanket UPDATE would be destructive. Owners
-- whose groups were stamped with `20` solely from the old default can lower
-- it themselves in Settings → Game.
-- ============================================================================

ALTER TABLE settings ALTER COLUMN min_transfer SET DEFAULT 5;

-- Sanity check: surface the new default so the migration log shows the result.
DO $$
DECLARE
  current_default TEXT;
BEGIN
  SELECT column_default INTO current_default
  FROM information_schema.columns
  WHERE table_name = 'settings' AND column_name = 'min_transfer';

  RAISE NOTICE 'settings.min_transfer column default is now: %', current_default;
END $$;
