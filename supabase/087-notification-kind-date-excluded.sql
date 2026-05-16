-- ============================================================
-- Migration 087: Allow 'date_excluded' notification job kind
-- Run in Supabase SQL Editor after 086-pin-during-open-keeps-expansion-clock.sql.
-- (Idempotent — drop+add the CHECK constraint by name.)
--
-- Why: Migration 086 (schedule-exclude-date, applied as
--   `085_schedule_exclude_date` due to a same-day numbering collision —
--   see file header in supabase/086-schedule-exclude-date.sql) gave
--   admins a `set_game_poll_date_disabled` RPC that pulls a date out of
--   the active candidate set. Today that's a silent action: the in-app
--   poll card visibly redraws, the WhatsApp share card (post-087 fix)
--   correctly shows the date as ❌ הוצא, and every outbound reminder /
--   expansion / invitation message we send from here on out correctly
--   omits the excluded date. Members who happen to open the app after
--   the exclusion see the truth.
--
--   What's missing: an active broadcast. If a member voted "yes" on
--   the now-excluded date five minutes ago and isn't looking at their
--   phone, they have no way to know the candidate set just changed
--   without re-opening the poll. The other lifecycle events that
--   restructure a poll (pin, cancel) DO fire push + email — exclusion
--   was the gap.
--
--   This migration is the first half of closing that gap: it widens
--   the notification_jobs.kind CHECK constraint so client-initiated
--   exclusion notifications can enqueue under their own kind label,
--   distinct from `cancellation` (which terminates the poll outright)
--   and `expanded` (which broadens the audience). The client-side
--   half — `sendDateExcludedNotifications` in scheduleNotifications.ts
--   and the fire-on-success in ScheduleTab — ships in the same merge.
--
-- Behavior:
--   * Drops the existing notification_jobs_kind_check constraint and
--     re-creates it with one additional allowed value: 'date_excluded'.
--   * No data migration — existing rows already conform.
--   * No trigger or RPC change here. Date-excluded jobs are enqueued
--     from the client via `enqueue_notification(p_kind, p_group_id,
--     p_poll_id, p_payload)` (defined in migration 066), the same path
--     reminder/training notifications use. We deliberately do NOT add
--     a DB trigger on `game_poll_dates.disabled_at` because:
--       1. The recipient list and the user-visible Hebrew copy live in
--          client code (with i18n + verbForName hooks), where a
--          trigger function can't reach.
--       2. The exclude action is small and synchronous; if the client
--          dies between the RPC and the enqueue call, the worst case
--          is "members find out next time they open the app" — the
--          same fallback we have for `reminder` and `training_*`.
-- ============================================================

ALTER TABLE public.notification_jobs
  DROP CONSTRAINT IF EXISTS notification_jobs_kind_check;

ALTER TABLE public.notification_jobs
  ADD CONSTRAINT notification_jobs_kind_check
  CHECK (kind IN (
    'creation', 'expanded', 'confirmed', 'cancellation', 'target_filled',
    'vote_change', 'reminder',
    'trivia_report_filed', 'trivia_report_resolved',
    'training_report_filed', 'training_report_resolved', 'training_milestone',
    'date_excluded'
  ));
