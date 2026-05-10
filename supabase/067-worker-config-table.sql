-- ============================================================================
-- supabase/067-worker-config-table.sql
--
-- Companion to 066. Supabase doesn't allow `ALTER DATABASE postgres SET
-- app.foo = '...'` for custom GUCs unless you're a superuser, which the
-- migration tooling isn't. Switch from `current_setting('app.foo')` to a
-- tiny `worker_config(key, value)` table that the four notification
-- functions read at runtime.
--
-- The table holds the worker URL and shared secret. RLS denies anon and
-- authenticated roles entirely — only the service role (and SECURITY
-- DEFINER functions) can read or write the rows. The MCP tooling runs
-- as a privileged role, so the seed inserts below set the values directly.
--
-- IDEMPOTENT: re-runnable. CREATE TABLE IF NOT EXISTS, ON CONFLICT DO
-- UPDATE on the seeds, CREATE OR REPLACE on the functions.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.worker_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.worker_config ENABLE ROW LEVEL SECURITY;

-- No RLS policies = no row visibility for anon/authenticated. Service
-- role bypasses RLS, and SECURITY DEFINER functions running as the
-- function owner can read freely.

-- Replace the four 066 functions to read from this table instead of
-- current_setting('app.notification_worker_*'). Trigger / RPC bindings
-- already point at these names, so the swap is transparent to callers.

CREATE OR REPLACE FUNCTION public.fn_http_dispatch_notification_job()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
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

  PERFORM extensions.http_post(
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

CREATE OR REPLACE FUNCTION public.fn_sweep_pending_notification_jobs()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
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
      PERFORM extensions.http_post(
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

CREATE OR REPLACE FUNCTION public.claim_notification_job_internal(
  p_secret TEXT
) RETURNS TABLE(
  id        UUID,
  group_id  UUID,
  poll_id   UUID,
  kind      TEXT,
  attempts  INT,
  payload   JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_expected TEXT;
BEGIN
  SELECT value INTO v_expected FROM worker_config WHERE key = 'notification_worker_secret';
  IF v_expected IS NULL OR v_expected = '' OR p_secret IS NULL OR p_secret <> v_expected THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  RETURN QUERY
  WITH claimed AS (
    SELECT j.id
    FROM notification_jobs j
    WHERE (
        j.status = 'pending'
        OR (j.status = 'running' AND j.claimed_at < now() - interval '5 minutes')
      )
      AND j.attempts < 3
    ORDER BY j.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE notification_jobs nj
     SET status     = 'running',
         claimed_at = now(),
         attempts   = nj.attempts + 1
    FROM claimed
   WHERE nj.id = claimed.id
  RETURNING nj.id, nj.group_id, nj.poll_id, nj.kind, nj.attempts, nj.payload;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_notification_job_internal(
  p_secret        TEXT,
  p_job_id        UUID,
  p_success       BOOLEAN,
  p_error_message TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_expected TEXT;
  v_kind     TEXT;
  v_poll_id  UUID;
  v_attempts INT;
BEGIN
  SELECT value INTO v_expected FROM worker_config WHERE key = 'notification_worker_secret';
  IF v_expected IS NULL OR v_expected = '' OR p_secret IS NULL OR p_secret <> v_expected THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  SELECT kind, poll_id, attempts
    INTO v_kind, v_poll_id, v_attempts
    FROM notification_jobs WHERE id = p_job_id;
  IF v_kind IS NULL THEN
    RAISE EXCEPTION 'job_not_found';
  END IF;

  IF p_success THEN
    UPDATE notification_jobs
       SET status       = 'done',
           completed_at = now(),
           last_error   = NULL
     WHERE id = p_job_id;

    IF v_poll_id IS NOT NULL THEN
      IF v_kind = 'creation' THEN
        UPDATE game_polls SET creation_notifications_sent_at = now()
          WHERE id = v_poll_id AND creation_notifications_sent_at IS NULL;
      ELSIF v_kind = 'expanded' THEN
        UPDATE game_polls SET expanded_notifications_sent_at = now()
          WHERE id = v_poll_id AND expanded_notifications_sent_at IS NULL;
      ELSIF v_kind = 'confirmed' THEN
        UPDATE game_polls SET confirmed_notifications_sent_at = now()
          WHERE id = v_poll_id AND confirmed_notifications_sent_at IS NULL;
      ELSIF v_kind = 'cancellation' THEN
        UPDATE game_polls SET cancellation_notifications_sent_at = now()
          WHERE id = v_poll_id AND cancellation_notifications_sent_at IS NULL;
      ELSIF v_kind = 'target_filled' THEN
        UPDATE game_polls SET target_filled_notifications_sent_at = now()
          WHERE id = v_poll_id AND target_filled_notifications_sent_at IS NULL;
      END IF;
    END IF;
  ELSE
    IF v_attempts >= 3 THEN
      UPDATE notification_jobs
         SET status     = 'failed',
             last_error = p_error_message
       WHERE id = p_job_id;
    ELSE
      UPDATE notification_jobs
         SET status     = 'pending',
             last_error = p_error_message,
             claimed_at = NULL
       WHERE id = p_job_id;
    END IF;
  END IF;
END;
$$;

-- ── Seed the URL. The secret is set by the operator after the Vercel
--    env var is configured (so the two values stay in lockstep). Keeping
--    the secret out of git is the whole reason we have the table — never
--    insert it from a committed migration. ────────────────────────────
INSERT INTO public.worker_config(key, value)
VALUES ('notification_worker_url', 'https://poker-manager-blond.vercel.app/api/notification-worker')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
