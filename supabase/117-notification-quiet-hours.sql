-- 117 — Quiet hours for notification delivery
--
-- Problem: notification dispatch runs 24/7. A vote cast at 02:00 pushes at
-- 02:00. Quiet hours existed only on fn_sweep_expand_polls, which governs
-- when a poll opens to guests, not when anyone is told about it.
--
-- Approach: a `run_after` stamp on each job rather than a time gate on the
-- consumers. Gating the consumers would strand deferred work, because
-- fn_sweep_pending_notification_jobs is the only thing that reconsiders a
-- job that was skipped at insert time — it must keep running through the
-- night so it can release the backlog the moment the window opens.
--
-- Window is 07:00-23:00 Asia/Jerusalem. It starts an hour earlier than the
-- expansion sweep on purpose: settings.schedule_auto_create_time is 07:30,
-- so an 08:00 start would delay the weekly Sunday invite.
--
-- Only two functions insert into notification_jobs — enqueue_poll_notification
-- for the five lifecycle kinds, enqueue_notification for everything else — so
-- the stamp lands in exactly two places despite four trigger paths.

-- ── 1. Delivery-slot helper ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_next_delivery_slot()
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_local  TIMESTAMP;  -- Israel wall clock
  v_hour   INT;
  v_target TIMESTAMP;
BEGIN
  v_local := now() AT TIME ZONE 'Asia/Jerusalem';
  v_hour  := EXTRACT(HOUR FROM v_local);

  -- Inside the window: deliver immediately.
  IF v_hour >= 7 AND v_hour < 23 THEN
    RETURN now();
  END IF;

  IF v_hour < 7 THEN
    -- Small hours: this morning at 07:00.
    v_target := date_trunc('day', v_local) + interval '7 hours';
  ELSE
    -- 23:00 or later: tomorrow morning at 07:00.
    v_target := date_trunc('day', v_local) + interval '1 day' + interval '7 hours';
  END IF;

  -- Back to an absolute instant. AT TIME ZONE resolves DST for us; Israel
  -- shifts at 02:00, so 07:00 always exists on both transition days.
  RETURN v_target AT TIME ZONE 'Asia/Jerusalem';
END;
$$;

REVOKE ALL ON FUNCTION public.fn_next_delivery_slot() FROM PUBLIC, anon, authenticated;

-- ── 2. Column ──────────────────────────────────────────────────────────────
--
-- Existing rows take the ALTER's now(), which is already in the past by the
-- time anything reads it, so the backlog is unaffected by this migration.

ALTER TABLE notification_jobs
  ADD COLUMN IF NOT EXISTS run_after TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_notification_jobs_due
  ON notification_jobs (run_after)
  WHERE status IN ('pending', 'running');

-- ── 3. Stamp on insert: lifecycle kinds ────────────────────────────────────
--
-- Unchanged from the deployed body except for the run_after column.

CREATE OR REPLACE FUNCTION public.enqueue_poll_notification(p_poll_id uuid, p_kind text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_group_id UUID;
  v_sentinel TIMESTAMPTZ;
  v_id       UUID;
BEGIN
  IF p_kind NOT IN ('creation','expanded','confirmed','cancellation','target_filled') THEN
    RAISE EXCEPTION 'invalid_kind: %', p_kind;
  END IF;

  SELECT
    group_id,
    CASE p_kind
      WHEN 'creation'      THEN creation_notifications_sent_at
      WHEN 'expanded'      THEN expanded_notifications_sent_at
      WHEN 'confirmed'     THEN confirmed_notifications_sent_at
      WHEN 'cancellation'  THEN cancellation_notifications_sent_at
      WHEN 'target_filled' THEN target_filled_notifications_sent_at
    END
    INTO v_group_id, v_sentinel
  FROM game_polls
  WHERE id = p_poll_id;

  IF v_group_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_sentinel IS NOT NULL THEN
    RETURN NULL;
  END IF;

  BEGIN
    INSERT INTO notification_jobs (group_id, poll_id, kind, status, run_after)
    VALUES (v_group_id, p_poll_id, p_kind, 'pending', fn_next_delivery_slot())
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
$function$;

-- ── 4. Stamp on insert: generic kinds, plus payload refresh on conflict ────
--
-- idx_notification_jobs_active_uniq collapses repeat enqueues for the same
-- (poll, kind) while one is still active. Deferring overnight makes that
-- collision routine rather than rare: several votes between 23:00 and 07:00
-- fold into one job. The old handler returned the existing id and discarded
-- the newer payload, so the morning ping would name whoever voted first.
-- Refresh it — but only while the row is still 'pending', so a job already
-- being delivered is never mutated underneath the worker.

CREATE OR REPLACE FUNCTION public.enqueue_notification(
  p_kind     text,
  p_group_id uuid,
  p_poll_id  uuid  DEFAULT NULL::uuid,
  p_payload  jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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

  BEGIN
    INSERT INTO notification_jobs (group_id, poll_id, kind, status, payload, run_after)
    VALUES (p_group_id, p_poll_id, p_kind, 'pending', p_payload, fn_next_delivery_slot())
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    UPDATE notification_jobs
       SET payload = p_payload
     WHERE poll_id = p_poll_id
       AND kind    = p_kind
       AND status  = 'pending'
    RETURNING id INTO v_id;

    -- Already claimed and running: leave it alone, just return its id.
    IF v_id IS NULL THEN
      SELECT id INTO v_id
        FROM notification_jobs
        WHERE poll_id = p_poll_id
          AND kind = p_kind
          AND status IN ('pending','running')
        LIMIT 1;
    END IF;
  END;

  RETURN v_id;
END;
$function$;

-- ── 5. Respect run_after in the browser claim ──────────────────────────────

CREATE OR REPLACE FUNCTION public.claim_notification_job(p_group_id uuid)
RETURNS TABLE(id uuid, poll_id uuid, kind text, attempts integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM group_members
    WHERE group_id = p_group_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not_member';
  END IF;

  -- Retire rows that exhausted their attempts while still 'running'. The
  -- claim predicate below can never pick them up again, so without this
  -- they hold their unique-index slot forever and mute that (poll, kind)
  -- channel. Scoped to the caller's group so a member can only heal their
  -- own queue.
  --
  -- Table alias is load-bearing: this function's RETURNS TABLE declares
  -- `attempts` (and id/poll_id/kind) as PL/pgSQL OUT variables, so a bare
  -- column reference here raises 42702 and every claim call fails.
  UPDATE notification_jobs nj
     SET status       = 'failed',
         completed_at = now(),
         last_error   = COALESCE(nj.last_error, 'abandoned while running (lease expired, attempts exhausted)')
   WHERE nj.group_id   = p_group_id
     AND nj.status     = 'running'
     AND nj.attempts  >= 3
     AND nj.claimed_at < now() - interval '1 hour';

  RETURN QUERY
  WITH claimed AS (
    SELECT j.id
    FROM notification_jobs j
    WHERE j.group_id = p_group_id
      AND (
        j.status = 'pending'
        OR (j.status = 'running' AND j.claimed_at < now() - interval '5 minutes')
      )
      AND j.attempts < 3
      -- Quiet hours (migration 117): not due yet.
      AND j.run_after <= now()
      -- Only what the browser can dispatch. Anything else is the server
      -- worker's job, and claiming it here would strand it.
      AND j.kind IN ('creation', 'expanded', 'confirmed', 'cancellation', 'target_filled')
    ORDER BY j.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE notification_jobs nj
     SET status     = 'running',
         claimed_at = now(),
         claimed_by = auth.uid(),
         attempts   = nj.attempts + 1
    FROM claimed
   WHERE nj.id = claimed.id
  RETURNING nj.id, nj.poll_id, nj.kind, nj.attempts;
END;
$function$;

-- ── 6. Respect run_after in the server claim ───────────────────────────────

CREATE OR REPLACE FUNCTION public.claim_notification_job_internal(p_secret text)
RETURNS TABLE(id uuid, group_id uuid, poll_id uuid, kind text, attempts integer, payload jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
      -- Quiet hours (migration 117): not due yet.
      AND j.run_after <= now()
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
$function$;

-- ── 7. Respect run_after in the every-minute sweep ─────────────────────────
--
-- This sweep is deliberately NOT time-gated itself. It runs every minute
-- around the clock and is the mechanism that releases the overnight backlog
-- within a minute of 07:00. Adding a window here would leave deferred jobs
-- unreachable.

CREATE OR REPLACE FUNCTION public.fn_sweep_pending_notification_jobs()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
      AND run_after <= now()
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
$function$;

-- ── 8. Skip the insert-time dispatch for deferred jobs ─────────────────────
--
-- Guard lives in the function rather than the trigger's WHEN clause so this
-- migration never has to drop and recreate a live trigger. The sweep in
-- section 7 picks the job up once it comes due.

CREATE OR REPLACE FUNCTION public.fn_http_dispatch_notification_job()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_url    TEXT;
  v_secret TEXT;
BEGIN
  IF NEW.run_after > now() THEN
    RETURN NEW;
  END IF;

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
$function$;
