-- ============================================================================
-- supabase/090-schedule-email-event-filter.sql
--
-- 2026-05-21 — Per-kind email allowlist for schedule notifications.
--
-- Until now the `settings.schedule_emails_enabled` boolean was a single
-- master switch: either every poll-lifecycle email blasted out (open,
-- expanded, confirmed, target_filled, cancelled, reminder, date_excluded)
-- or none did. Lior wants finer control to manage his EmailJS monthly
-- quota — e.g. send the "ערב פוקר חדש" invitation by email (high signal,
-- members need to know a vote is open) but suppress the rest and let
-- WhatsApp / push cover the rest.
--
-- Design:
--   * Add ONE new JSONB column `schedule_email_kinds` instead of seven
--     new boolean columns. Each settings row gets a small object like
--     `{"creation":true,"expanded":true,"confirmed":true,"target_filled":true,
--       "cancellation":true,"reminder":true,"date_excluded":true}`.
--   * Default ALL keys to `true` so existing groups with the master toggle
--     ON keep their current behavior (every email kind still fires). The
--     UI surfaces individual toggles so admins can flip specific ones off.
--   * The master `schedule_emails_enabled` flag stays as the kill switch
--     — both client and server check `master ON && per_kind[kind] !== false`
--     before sending. Master OFF short-circuits per-kind entirely.
--
-- Why JSONB and not seven booleans:
--   * Adding/removing notification kinds in the future (e.g. when we add
--     a new "poll-extended" event) becomes a code-only change, no
--     migration.
--   * The set of kinds is enumerated by the client/server code anyway —
--     storing them in one column reads as a "filter object" rather than
--     scattered flags.
--   * Querying per-kind is rare (the worker reads the whole row for a
--     job's group_id already), so we don't lose meaningful index access.
--
-- This migration is purely additive (new column, idempotent default).
-- No data is mutated. Safe to re-apply.
-- ============================================================================

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS schedule_email_kinds JSONB
  NOT NULL
  DEFAULT '{
    "creation": true,
    "expanded": true,
    "confirmed": true,
    "target_filled": true,
    "cancellation": true,
    "reminder": true,
    "date_excluded": true
  }'::jsonb;

COMMENT ON COLUMN public.settings.schedule_email_kinds IS
  'Per-event email allowlist for schedule notifications. Keys: creation, '
  'expanded, confirmed, target_filled, cancellation, reminder, date_excluded. '
  'Each true/false. Gated together with schedule_emails_enabled (master) — '
  'master OFF short-circuits this entirely. Migration 090 (2026-05-21).';

-- Backfill: any settings rows created before this column existed get the
-- default object via the DEFAULT clause above (NOT NULL on ADD COLUMN
-- populates existing rows with the default). Verify nothing slipped
-- through with NULL — defensive in case a future migration drops the
-- NOT NULL or someone manually nulls the column.
UPDATE public.settings
   SET schedule_email_kinds = '{
     "creation": true,
     "expanded": true,
     "confirmed": true,
     "target_filled": true,
     "cancellation": true,
     "reminder": true,
     "date_excluded": true
   }'::jsonb
 WHERE schedule_email_kinds IS NULL;
