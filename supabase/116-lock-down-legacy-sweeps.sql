-- 116 — the remaining cron sweeps are not client-callable either
--
-- fn_sweep_auto_create_polls and fn_sweep_pending_notification_jobs both carried
-- the default PUBLIC EXECUTE grant, so any anonymous PostgREST caller could
-- invoke them. Both are SECURITY DEFINER and both iterate every group, so
-- neither belongs on the client surface. The notification sweep is the sharper
-- edge: draining the dispatch queue on demand is a push-spam lever.
--
-- This was never deliberate. Migration 066 explicitly granted the notification
-- sweep to service_role and nothing else; the anon reach came from the implicit
-- PUBLIC grant that ships with every new function. That service_role grant is
-- re-applied below so the original intent survives.
--
-- pg_cron runs as the postgres superuser and is unaffected. Neither function has
-- a caller anywhere in the app or the edge functions — only comments reference
-- them by name.

REVOKE ALL ON FUNCTION public.fn_sweep_auto_create_polls() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_sweep_auto_create_polls() FROM anon;
REVOKE ALL ON FUNCTION public.fn_sweep_auto_create_polls() FROM authenticated;

REVOKE ALL ON FUNCTION public.fn_sweep_pending_notification_jobs() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_sweep_pending_notification_jobs() FROM anon;
REVOKE ALL ON FUNCTION public.fn_sweep_pending_notification_jobs() FROM authenticated;

GRANT EXECUTE ON FUNCTION public.fn_sweep_pending_notification_jobs()
  TO service_role;
