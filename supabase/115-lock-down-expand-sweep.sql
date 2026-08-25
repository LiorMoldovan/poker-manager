-- 115 — the expansion sweep is cron-only
--
-- Migration 114 created fn_sweep_expand_polls with the default EXECUTE grant,
-- leaving it callable by anon and authenticated over PostgREST. It is
-- SECURITY DEFINER and iterates every group's polls, so no client should reach
-- it. pg_cron runs as the postgres superuser and is unaffected by these
-- revokes. Members still expand through expand_game_poll, which checks
-- membership before delegating.
--
-- NOTE: fn_sweep_auto_create_polls and fn_sweep_pending_notification_jobs have
-- the same exposure and predate this migration. They are deliberately left
-- alone here — hardening them is a separate, wider change.

REVOKE ALL ON FUNCTION public.fn_sweep_expand_polls() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_sweep_expand_polls() FROM anon;
REVOKE ALL ON FUNCTION public.fn_sweep_expand_polls() FROM authenticated;
