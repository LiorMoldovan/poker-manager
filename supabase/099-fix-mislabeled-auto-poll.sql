-- ============================================================================
-- Migration 099: one-off label fix — the active poll was auto-opened
-- ============================================================================
--
-- Poll c092a36f (group d1998bed) was opened by the weekly auto-schedule on
-- Sun 07/06 10:09 IL — created_at 07:09:15Z is exactly 1s after the schedule
-- sentinel (schedule_auto_created_at = 07:09:14.996Z), the unmistakable
-- auto-create signature.
--
-- It predates migration 098, so it had no created_source at creation and
-- defaulted to 'admin'; 098's backfill then named it after its created_by
-- (the owner, Lior) — surfacing in the UI as "opened by Lior" instead of
-- "opened automatically". This corrects that single row.
--
-- Scope: ONLY this poll. Older confirmed/expired polls can't be reliably
-- classified auto-vs-manual from stored data (created_by only records who was
-- online, not whether the open was automatic), so they're intentionally left
-- as-is. Idempotent (fixed UUID + already-admin guard).
-- ============================================================================

UPDATE game_polls
SET created_source = 'auto',
    created_by_name = NULL
WHERE id = 'c092a36f-e8cd-4101-8b72-9e61b532d0ed'::uuid
  AND created_source = 'admin';
