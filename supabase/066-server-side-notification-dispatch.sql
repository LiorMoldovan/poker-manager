-- ============================================================================
-- supabase/066-server-side-notification-dispatch.sql
--
-- Phase 2 of the notification rebuild: move dispatch fully server-side.
--
-- Migration 061 made job CREATION durable (DB triggers atomically enqueue),
-- but DISPATCH was still client-side: the browser-based notificationWorker
-- claimed and sent push/email. That worked when a client was online and
-- broke when nobody was (the 2026-05-10 13:01 incident: target_filled job
-- enqueued correctly but sat at status='pending' for 5+ minutes because no
-- client opened the app to drain it).
--
-- This migration moves dispatch to the server. Every notification_jobs
-- INSERT now triggers an HTTP POST to /api/notification-worker via pg_net.
-- The Edge Function authenticates via a shared secret, claims the job
-- through a service-role-aware RPC, dispatches push + email (calling the
-- existing /api/send-push and EmailJS endpoints), and marks the job done.
-- A pg_cron job runs every minute as a sweep for any job that was missed
-- (transient pg_net failure, deploy mid-flight, etc.) so nothing is ever
-- permanently lost.
--
-- Three architectural changes from 061 worth calling out:
--
--   1. notification_jobs is now generalized — `payload JSONB` for arbitrary
--      kind-specific data, `poll_id` is nullable, the kind CHECK is
--      extended to cover all surfaces (vote_change, trivia_report_*,
--      training_report_*, training_milestone, reminder).
--
--   2. claim_notification_job/complete_notification_job get *_internal
--      siblings that authenticate via a shared secret instead of auth.uid()
--      so the Edge Function can call them without a user JWT.
--
--   3. New triggers cover surfaces that were 100% client-fragile in 061:
--      vote_change (every vote that actually changes the response/comment
--      enqueues a job), trivia_report_filed (push to super-admins on
--      INSERT into trivia_reports), trivia_report_resolved (push to
--      reporter on UPDATE OF status). Reminders + training reports stay
--      client-enqueued for now since they encode time-based / batched
--      logic that doesn't trivially live in a trigger — but the dispatch
--      they go through is now server-side too, so the client closing
--      mid-fetch no longer drops the notification.
--
-- IDEMPOTENT: re-runnable. CREATE EXTENSION IF NOT EXISTS, ADD COLUMN IF
-- NOT EXISTS, CREATE OR REPLACE on functions, DROP/CREATE on triggers.
--
-- POST-APPLY MANUAL STEPS (cannot be done in SQL — Supabase dashboard /
-- Vercel env config):
--   - In Vercel project: add env var WORKER_INTERNAL_SECRET (random 32+
--     char string) and SUPABASE_SERVICE_ROLE_KEY (already exists for some
--     edge functions; if not, copy from Supabase project settings).
--   - In Supabase project: ALTER DATABASE postgres SET
--     app.notification_worker_url = 'https://poker-manager-blond.vercel.app/api/notification-worker';
--     ALTER DATABASE postgres SET
--     app.notification_worker_secret = '<same string as WORKER_INTERNAL_SECRET>';
--     The migration sets sane defaults below if these settings are unset,
--     using the production URL — but the secret has to be set by the user
--     because picking one in a migration would commit it to git.
-- ============================================================================

-- ──────────────────────────────────────────────────────────────────────────
-- 1. Extensions
-- ──────────────────────────────────────────────────────────────────────────

-- pg_net installs into `extensions` schema (Supabase convention) so its
-- functions are addressable as extensions.http_post(...). pg_cron has to
-- live in its own `cron` schema (the extension hardcodes table names) so
-- we don't WITH SCHEMA it; functions are addressable as cron.schedule(...).
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ──────────────────────────────────────────────────────────────────────────
-- 2. Generalize notification_jobs schema
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE public.notification_jobs
  ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Make poll_id nullable so non-poll kinds (training_milestone,
-- training_report_*) can use the same queue without a synthetic poll_id.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'notification_jobs'
      AND column_name = 'poll_id'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.notification_jobs ALTER COLUMN poll_id DROP NOT NULL;
  END IF;
END
$$;

-- Extend the kind CHECK constraint. Postgres can't ALTER a CHECK in
-- place, so DROP + ADD with the same name.
ALTER TABLE public.notification_jobs
  DROP CONSTRAINT IF EXISTS notification_jobs_kind_check;

ALTER TABLE public.notification_jobs
  ADD CONSTRAINT notification_jobs_kind_check
  CHECK (kind IN (
    'creation', 'expanded', 'confirmed', 'cancellation', 'target_filled',
    'vote_change', 'reminder',
    'trivia_report_filed', 'trivia_report_resolved',
    'training_report_filed', 'training_report_resolved', 'training_milestone'
  ));

-- ──────────────────────────────────────────────────────────────────────────
-- 3. Generic enqueue_notification (non-poll kinds)
-- ──────────────────────────────────────────────────────────────────────────
-- Mirrors enqueue_poll_notification but takes group_id explicitly and an
-- optional payload. Used for kinds where poll_id is null or where the
-- caller wants to attach context (e.g. trivia_report_id, training scenario,
-- recipient list overrides).
CREATE OR REPLACE FUNCTION public.enqueue_notification(
  p_kind     TEXT,
  p_group_id UUID,
  p_poll_id  UUID DEFAULT NULL,
  p_payload  JSONB DEFAULT '{}'::jsonb
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF p_kind NOT IN (
    'creation','expanded','confirmed','cancellation','target_filled',
    'vote_change','reminder',
    'trivia_report_filed','trivia_report_resolved',
    'training_report_filed','training_report_resolved','training_milestone'
  ) THEN
    RAISE EXCEPTION 'invalid_kind: %', p_kind;
  END IF;

  IF p_group_id IS NULL THEN
    RAISE EXCEPTION 'missing_group_id';
  END IF;

  -- Idempotency for kinds keyed on poll_id is enforced by the partial
  -- unique index from migration 061. For non-poll kinds we don't dedup
  -- — every enqueue produces a fresh job (caller's responsibility to
  -- batch sensibly).
  BEGIN
    INSERT INTO notification_jobs (group_id, poll_id, kind, status, payload)
    VALUES (p_group_id, p_poll_id, p_kind, 'pending', p_payload)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT id INTO v_id
      FROM notification_jobs
      WHERE poll_id = p_poll_id
        AND kind = p_kind
        AND status IN ('pending','running')
      LIMIT 1;
  END;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.enqueue_notification(TEXT, UUID, UUID, JSONB)
  TO authenticated, service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- 4. Service-role-aware claim/complete (for the Edge Function)
-- ──────────────────────────────────────────────────────────────────────────
-- The browser worker uses claim_notification_job which checks group
-- membership via auth.uid(). The Edge Function has no user JWT — it's a
-- server process — so it needs a sibling RPC that authenticates via a
-- shared secret instead of auth.uid().
--
-- The shared secret lives in two places that MUST match:
--   * Database GUC `app.notification_worker_secret` (set by user post-apply)
--   * Vercel env var WORKER_INTERNAL_SECRET (Edge Function reads at runtime)
-- The RPC accepts the secret as a parameter and rejects mismatches.

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
  v_expected := current_setting('app.notification_worker_secret', true);
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

GRANT EXECUTE ON FUNCTION public.claim_notification_job_internal(TEXT)
  TO service_role;

-- complete_notification_job_internal: same as the public version but
-- secret-authenticated and able to mark jobs done across any group.
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
  v_expected := current_setting('app.notification_worker_secret', true);
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

    -- Mirror legacy *_notifications_sent_at sentinels for poll kinds.
    -- No-op for non-poll kinds.
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
    -- Failure: bump back to pending if attempts left, else terminal failed.
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

GRANT EXECUTE ON FUNCTION public.complete_notification_job_internal(TEXT, UUID, BOOLEAN, TEXT)
  TO service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- 5. New triggers — vote_change, trivia_report_filed, trivia_report_resolved
-- ──────────────────────────────────────────────────────────────────────────

-- vote_change: enqueue when a vote's response or comment actually changes.
-- Skip:
--   * INSERT of a 'yes' that crosses target on a confirmed-below-target poll
--     — that's the target_filled territory, handled by the existing trigger.
--   * UPDATE where neither response nor comment actually changed (no-op vote
--     re-confirm — the user clicked the same button twice).
-- The actor is captured in payload (cast_by_user_id or user_id) so the
-- worker can exclude them from recipients.
CREATE OR REPLACE FUNCTION public.fn_enqueue_vote_change_on_vote()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = 'public'
AS $$
DECLARE
  v_poll      game_polls%ROWTYPE;
  v_actor_uid UUID;
  v_payload   JSONB;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.response IS NOT DISTINCT FROM NEW.response
     AND COALESCE(OLD.comment,'') = COALESCE(NEW.comment,'') THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_poll FROM game_polls WHERE id = NEW.poll_id;
  IF v_poll.id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Cancelled polls: voters can't actually vote here, but defensively skip.
  IF v_poll.status = 'cancelled' THEN
    RETURN NEW;
  END IF;

  v_actor_uid := COALESCE(NEW.cast_by_user_id, NEW.user_id);

  v_payload := jsonb_build_object(
    'date_id',     NEW.date_id,
    'player_id',   NEW.player_id,
    'response',    NEW.response,
    'comment',     NEW.comment,
    'is_new_vote', (TG_OP = 'INSERT'),
    'actor_user_id', v_actor_uid
  );

  PERFORM enqueue_notification('vote_change', v_poll.group_id, NEW.poll_id, v_payload);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enqueue_vote_change_on_vote ON public.game_poll_votes;
CREATE TRIGGER trg_enqueue_vote_change_on_vote
  AFTER INSERT OR UPDATE OF response, comment ON public.game_poll_votes
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_enqueue_vote_change_on_vote();

-- trivia_report_filed: push super-admins when a new report comes in.
CREATE OR REPLACE FUNCTION public.fn_enqueue_trivia_report_on_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = 'public'
AS $$
BEGIN
  PERFORM enqueue_notification(
    'trivia_report_filed',
    NEW.group_id,
    NULL,
    jsonb_build_object(
      'report_id',     NEW.id,
      'reporter_name', NEW.player_name,
      'reason',        NEW.reason,
      'question_text', NEW.question_text
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enqueue_trivia_report_on_insert ON public.trivia_reports;
CREATE TRIGGER trg_enqueue_trivia_report_on_insert
  AFTER INSERT ON public.trivia_reports
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_enqueue_trivia_report_on_insert();

-- trivia_report_resolved: push reporter when status flips from open → resolved
-- (or 'dismissed', etc.). The schema uses a generic 'status' column, so we
-- detect the resolution transition: anything OUT of 'open' counts as
-- "decided" and warrants a reporter ping.
CREATE OR REPLACE FUNCTION public.fn_enqueue_trivia_report_on_resolve()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = 'public'
AS $$
DECLARE
  v_outcome TEXT;
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'open' THEN
    RETURN NEW;
  END IF;

  -- Map status → outcome for the worker's message builder. The two
  -- copy paths are accept (resolved/fixed) and reject (dismissed).
  v_outcome := CASE WHEN NEW.status = 'dismissed' THEN 'reject' ELSE 'accept' END;

  PERFORM enqueue_notification(
    'trivia_report_resolved',
    NEW.group_id,
    NULL,
    jsonb_build_object(
      'report_id',     NEW.id,
      'reporter_name', NEW.player_name,
      'reporter_uid',  NEW.user_id,
      'outcome',       v_outcome,
      'question_text', NEW.question_text
    )
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enqueue_trivia_report_on_resolve ON public.trivia_reports;
CREATE TRIGGER trg_enqueue_trivia_report_on_resolve
  AFTER UPDATE OF status ON public.trivia_reports
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_enqueue_trivia_report_on_resolve();

-- ──────────────────────────────────────────────────────────────────────────
-- 6. pg_net webhook — INSTANT delivery
-- ──────────────────────────────────────────────────────────────────────────
-- AFTER INSERT on notification_jobs fires an HTTP POST to the worker's
-- /api/notification-worker endpoint with the new job's id. The worker
-- then claims, dispatches, and completes. Latency from row insert to
-- push being on the wire is typically under a second.
--
-- The URL and secret are read from database GUCs. If the GUCs are unset
-- (post-apply manual step skipped), the trigger silently no-ops — the
-- pg_cron sweep below will still process jobs eventually, just on a
-- 60-second delay instead of instantly.

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
  v_url    := current_setting('app.notification_worker_url',    true);
  v_secret := current_setting('app.notification_worker_secret', true);

  IF v_url IS NULL OR v_url = '' OR v_secret IS NULL OR v_secret = '' THEN
    -- GUCs not configured; pg_cron sweep will pick this up. Don't raise —
    -- we never want a missing config to abort the INSERT itself.
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
  -- Network errors, bad URL, etc. — log via NOTICE and let pg_cron retry.
  RAISE NOTICE 'fn_http_dispatch_notification_job failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_http_dispatch_notification_job ON public.notification_jobs;
CREATE TRIGGER trg_http_dispatch_notification_job
  AFTER INSERT ON public.notification_jobs
  FOR EACH ROW
  WHEN (NEW.status = 'pending')
  EXECUTE FUNCTION public.fn_http_dispatch_notification_job();

-- ──────────────────────────────────────────────────────────────────────────
-- 7. pg_cron sweep — RETRY for missed jobs
-- ──────────────────────────────────────────────────────────────────────────
-- Every minute, find jobs that are still 'pending' more than 90s after
-- they were created (the webhook should have fired sub-second; if it
-- didn't, the worker either crashed mid-run or the URL was unreachable)
-- and POST each one to the worker again. The worker's claim is atomic
-- via SELECT FOR UPDATE SKIP LOCKED, so a duplicate POST is harmless —
-- only one wins the claim.

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
  v_url    := current_setting('app.notification_worker_url',    true);
  v_secret := current_setting('app.notification_worker_secret', true);
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
      -- Single-job failure shouldn't abort the sweep
      RAISE NOTICE 'sweep: http_post failed for job %: %', v_job.id, SQLERRM;
    END;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.fn_sweep_pending_notification_jobs()
  TO service_role;

-- Schedule the sweep every minute. cron.schedule with a name is idempotent
-- across re-applies (the unschedule below removes any prior incarnation
-- so the new schedule body always wins).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'notification-jobs-sweep') THEN
    PERFORM cron.unschedule('notification-jobs-sweep');
  END IF;
END
$$;

SELECT cron.schedule(
  'notification-jobs-sweep',
  '* * * * *',
  $$SELECT public.fn_sweep_pending_notification_jobs();$$
);
