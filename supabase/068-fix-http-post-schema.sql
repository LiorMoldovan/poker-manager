-- =================================================================
-- 068-fix-http-post-schema.sql
--
-- Fixes a critical bug introduced in 066: the webhook trigger and
-- pg_cron sweep functions referenced extensions.http_post, but
-- Supabase pre-installs pg_net in the `net` schema (not `extensions`).
-- The `CREATE EXTENSION pg_net WITH SCHEMA extensions IF NOT EXISTS`
-- in 066 short-circuited because pg_net was already installed at
-- `net`, so the requested relocation never happened.
--
-- Both functions had `EXCEPTION WHEN OTHERS THEN RAISE NOTICE` blocks,
-- so every dispatch attempt silently failed without an error reaching
-- any caller — explaining why no notifications were going out post-066.
--
-- This migration is a pure CREATE OR REPLACE on both function bodies,
-- swapping `extensions.http_post(...)` for `net.http_post(...)`.
-- Triggers / cron jobs / signatures unchanged.
-- =================================================================

-- 1) Webhook trigger function — fires on every notification_jobs INSERT
CREATE OR REPLACE FUNCTION public.fn_http_dispatch_notification_job()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url    TEXT;
  v_secret TEXT;
BEGIN
  SELECT value INTO v_url    FROM worker_config WHERE key = 'notification_worker_url';
  SELECT value INTO v_secret FROM worker_config WHERE key = 'notification_worker_secret';

  IF v_url IS NULL OR v_url = '' OR v_secret IS NULL OR v_secret = '' THEN
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Worker-Secret', v_secret
    ),
    body    := jsonb_build_object('job_id', NEW.id, 'kind', NEW.kind)
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'fn_http_dispatch_notification_job failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

-- 2) pg_cron sweep function — fires every minute, retries pending-too-long jobs
CREATE OR REPLACE FUNCTION public.fn_sweep_pending_notification_jobs()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url    TEXT;
  v_secret TEXT;
  v_job    RECORD;
BEGIN
  SELECT value INTO v_url    FROM worker_config WHERE key = 'notification_worker_url';
  SELECT value INTO v_secret FROM worker_config WHERE key = 'notification_worker_secret';
  IF v_url IS NULL OR v_url = '' OR v_secret IS NULL OR v_secret = '' THEN
    RETURN;
  END IF;

  FOR v_job IN
    SELECT id, kind FROM notification_jobs
    WHERE status = 'pending'
      AND attempts < 3
      AND created_at < now() - interval '90 seconds'
    ORDER BY created_at
    LIMIT 50
  LOOP
    BEGIN
      PERFORM net.http_post(
        url     := v_url,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'X-Worker-Secret', v_secret
        ),
        body    := jsonb_build_object('job_id', v_job.id, 'kind', v_job.kind)
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'sweep: http_post failed for job %: %', v_job.id, SQLERRM;
    END;
  END LOOP;
END;
$$;
