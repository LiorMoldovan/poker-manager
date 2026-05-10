-- ============================================================================
-- supabase/061-notification-job-queue.sql
--
-- Durable, server-enqueued notification job queue for poll lifecycle events.
--
-- BACKGROUND
--
-- Until v5.47.0, the schedule notification flow was:
--   1. Client calls `claim_poll_notifications(poll, kind)` -> sentinel set
--   2. Client THEN fires push + email proxies
-- If step 2 was interrupted (browser closed, tab backgrounded, network died),
-- the sentinel was already burned and `runSchedulerSweep` could not recover.
-- Diagnosed in incident 2026-05-10 (poll 16259f05): admin pinned a date,
-- closed the app within 30s, ZERO emails reached the proxy, and the
-- recovery sweep was permanently disabled by the burned sentinel.
--
-- THIS MIGRATION
--
-- Replaces the claim-then-deliver pattern with a durable queue:
--   * Triggers on game_polls (status transitions) and game_poll_votes
--     (target_filled detection) atomically enqueue rows in
--     `notification_jobs` within the same transaction as the lifecycle
--     transition. Cannot be lost.
--   * Workers (any logged-in group member's browser) claim jobs via
--     SELECT FOR UPDATE SKIP LOCKED, run the existing TS dispatch logic,
--     and mark the job done.
--   * 5-minute lease: a "running" job whose claim is older than 5 min is
--     re-claimable (handles worker crashes mid-dispatch).
--   * Up to 3 attempts per job before terminal `failed`.
--   * Legacy `*_notifications_sent_at` columns on game_polls are still
--     mirrored to (set by `complete_notification_job` on success) for
--     back-compat with the existing UI labels and recovery sweep.
--
-- IDEMPOTENT: re-runnable. All CREATE OR REPLACE / IF NOT EXISTS.
-- ============================================================================

-- ──────────────────────────────────────────────────────────────────────────
-- 1. Queue table
-- ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.notification_jobs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id     UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  poll_id      UUID NOT NULL REFERENCES public.game_polls(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN (
                 'creation','expanded','confirmed','cancellation','target_filled'
               )),
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                 'pending','running','done','failed'
               )),
  attempts     INT  NOT NULL DEFAULT 0,
  claimed_at   TIMESTAMPTZ,
  claimed_by   UUID,
  completed_at TIMESTAMPTZ,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Worker lookups: pending OR stale-running jobs ordered by creation
CREATE INDEX IF NOT EXISTS idx_notification_jobs_active
  ON public.notification_jobs (group_id, created_at)
  WHERE status IN ('pending','running');

-- Admin observation queries: jobs by group and status
CREATE INDEX IF NOT EXISTS idx_notification_jobs_group_status
  ON public.notification_jobs (group_id, status);

-- Idempotency: at most ONE active (pending|running) job per (poll_id, kind).
-- Triggers can re-enqueue freely; the conflict path no-ops if a sibling job
-- is already queued. Done/failed terminal rows do not block re-enqueueing
-- (e.g. a re-pin after a cancellation will produce a new 'confirmed' row).
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_jobs_active_uniq
  ON public.notification_jobs (poll_id, kind)
  WHERE status IN ('pending','running');

-- updated_at trigger (mirrors the project's existing pattern)
CREATE OR REPLACE FUNCTION public.tg_notification_jobs_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notification_jobs_updated_at ON public.notification_jobs;
CREATE TRIGGER trg_notification_jobs_updated_at
  BEFORE UPDATE ON public.notification_jobs
  FOR EACH ROW EXECUTE FUNCTION public.tg_notification_jobs_updated_at();

-- ──────────────────────────────────────────────────────────────────────────
-- 2. RLS — read for group members, no direct writes
-- ──────────────────────────────────────────────────────────────────────────

ALTER TABLE public.notification_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notification_jobs_member_select ON public.notification_jobs;
CREATE POLICY notification_jobs_member_select
  ON public.notification_jobs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.group_members gm
      WHERE gm.group_id = notification_jobs.group_id
        AND gm.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.super_admins sa WHERE sa.user_id = auth.uid()
    )
  );

-- No INSERT/UPDATE/DELETE policies: writes happen exclusively via the
-- SECURITY DEFINER RPCs below, which enforce their own membership checks.

-- ──────────────────────────────────────────────────────────────────────────
-- 3. RPCs
-- ──────────────────────────────────────────────────────────────────────────

-- enqueue_poll_notification: idempotently push a job. Called from triggers
-- (which run as the user who drove the transition) and is SECURITY DEFINER
-- so the trigger context can write into the queue regardless of RLS.
CREATE OR REPLACE FUNCTION public.enqueue_poll_notification(
  p_poll_id UUID,
  p_kind    TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_group_id UUID;
  v_id       UUID;
BEGIN
  IF p_kind NOT IN ('creation','expanded','confirmed','cancellation','target_filled') THEN
    RAISE EXCEPTION 'invalid_kind: %', p_kind;
  END IF;

  SELECT group_id INTO v_group_id FROM game_polls WHERE id = p_poll_id;
  IF v_group_id IS NULL THEN
    -- Poll deleted or never existed; silently no-op so trigger context
    -- doesn't blow up an in-flight UPDATE on an unrelated row.
    RETURN NULL;
  END IF;

  -- Try to insert a fresh pending row. If a sibling pending/running row
  -- already exists for (poll_id, kind), the partial unique index makes
  -- this a no-op. ON CONFLICT cannot reference partial indexes by column
  -- list, so we rely on the index raising and catch via WHEN unique_violation.
  BEGIN
    INSERT INTO notification_jobs (group_id, poll_id, kind, status)
    VALUES (v_group_id, p_poll_id, p_kind, 'pending')
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

GRANT EXECUTE ON FUNCTION public.enqueue_poll_notification(UUID, TEXT)
  TO authenticated, service_role;

-- claim_notification_job: atomic SELECT FOR UPDATE SKIP LOCKED claim.
-- Picks the oldest pending OR stale-running job (lease > 5 min expired)
-- with attempts < 3, marks it 'running', returns it to the worker.
-- Returns 0 rows when the queue is empty.
CREATE OR REPLACE FUNCTION public.claim_notification_job(
  p_group_id UUID
) RETURNS TABLE(
  id        UUID,
  poll_id   UUID,
  kind      TEXT,
  attempts  INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM group_members
    WHERE group_id = p_group_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not_member';
  END IF;

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
$$;

GRANT EXECUTE ON FUNCTION public.claim_notification_job(UUID) TO authenticated;

-- complete_notification_job: mark a claimed job done OR failed.
--   * On success: status='done', mirror to legacy *_notifications_sent_at.
--   * On failure with attempts < 3: revert to 'pending' for retry.
--   * On failure with attempts >= 3: status='failed' (terminal).
CREATE OR REPLACE FUNCTION public.complete_notification_job(
  p_job_id   UUID,
  p_success  BOOLEAN,
  p_error    TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_group_id  UUID;
  v_poll_id   UUID;
  v_kind      TEXT;
  v_attempts  INT;
BEGIN
  SELECT group_id, poll_id, kind, attempts
    INTO v_group_id, v_poll_id, v_kind, v_attempts
  FROM notification_jobs WHERE id = p_job_id;

  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'invalid_job';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM group_members
    WHERE group_id = v_group_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not_member';
  END IF;

  IF p_success THEN
    UPDATE notification_jobs
       SET status       = 'done',
           completed_at = now(),
           last_error   = NULL
     WHERE id = p_job_id;

    -- Legacy sentinel mirror: keep the *_notifications_sent_at columns
    -- on game_polls in sync so the UI labels and the existing recovery
    -- sweep continue to work without changes.
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
  ELSE
    -- Retry path
    IF v_attempts < 3 THEN
      UPDATE notification_jobs
         SET status     = 'pending',
             claimed_at = NULL,
             claimed_by = NULL,
             last_error = p_error
       WHERE id = p_job_id;
    ELSE
      UPDATE notification_jobs
         SET status       = 'failed',
             completed_at = now(),
             last_error   = p_error
       WHERE id = p_job_id;
    END IF;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.complete_notification_job(UUID, BOOLEAN, TEXT)
  TO authenticated;

-- preempt_target_filled_job: when the worker processes a 'confirmed' job
-- whose pinned date already meets the seat target (at-target confirmation),
-- the immediate "המשחק מלא" follow-up would be redundant noise stacked on
-- top of "המשחק נסגר!". This RPC marks any pending/running 'target_filled'
-- job for the same poll as done, and burns the legacy sentinel so the
-- recovery sweep cannot re-fire it. Mirrors the original v5.34.x semantics
-- of `claimPollNotifications(poll.id, 'target_filled')` inside
-- `sendConfirmedNotifications`.
CREATE OR REPLACE FUNCTION public.preempt_target_filled_job(
  p_poll_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_group_id UUID;
BEGIN
  SELECT group_id INTO v_group_id FROM game_polls WHERE id = p_poll_id;
  IF v_group_id IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM group_members
    WHERE group_id = v_group_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not_member';
  END IF;

  UPDATE notification_jobs
     SET status       = 'done',
         completed_at = now(),
         last_error   = 'preempted_by_at_target_confirmed'
   WHERE poll_id = p_poll_id
     AND kind    = 'target_filled'
     AND status IN ('pending','running');

  UPDATE game_polls
     SET target_filled_notifications_sent_at = now()
   WHERE id = p_poll_id
     AND target_filled_notifications_sent_at IS NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.preempt_target_filled_job(UUID)
  TO authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 4. Triggers — auto-enqueue on lifecycle transitions
-- ──────────────────────────────────────────────────────────────────────────

-- game_polls trigger: status INSERT or transition.
--   * INSERT (status = 'open')              -> enqueue 'creation'
--   * UPDATE status from anything to 'expanded'   -> enqueue 'expanded'
--   * UPDATE status from anything to 'confirmed'  -> enqueue 'confirmed'
--   * UPDATE status from anything to 'cancelled'  -> enqueue 'cancellation'
-- The trigger fires AFTER, so the row state is committed. The job is
-- inserted in the same transaction; if the UPDATE rolls back, the
-- enqueue rolls back with it. Atomic.
CREATE OR REPLACE FUNCTION public.fn_enqueue_poll_notification_on_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = 'public'
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'open' THEN
      PERFORM enqueue_poll_notification(NEW.id, 'creation');
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF NEW.status = 'expanded' THEN
      PERFORM enqueue_poll_notification(NEW.id, 'expanded');
    ELSIF NEW.status = 'confirmed' THEN
      PERFORM enqueue_poll_notification(NEW.id, 'confirmed');
    ELSIF NEW.status = 'cancelled' THEN
      PERFORM enqueue_poll_notification(NEW.id, 'cancellation');
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enqueue_poll_notification ON public.game_polls;
CREATE TRIGGER trg_enqueue_poll_notification
  AFTER INSERT OR UPDATE OF status ON public.game_polls
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_enqueue_poll_notification_on_change();

-- game_poll_votes trigger: detect 'target_filled' (yes-vote on a confirmed-
-- below-target poll that JUST crossed the seat target). Skips when the
-- poll's confirmed_at is within ~500ms of now() — that's the at-target
-- auto-close case where 'confirmed' alone covers the announcement and
-- the worker will preempt this job via preempt_target_filled_job.
CREATE OR REPLACE FUNCTION public.fn_enqueue_target_filled_on_vote()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = 'public'
AS $$
DECLARE
  v_poll    game_polls%ROWTYPE;
  v_yes_cnt INT;
BEGIN
  IF NEW.response <> 'yes' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_poll FROM game_polls WHERE id = NEW.poll_id;
  IF v_poll.id IS NULL OR v_poll.status <> 'confirmed' THEN
    RETURN NEW;
  END IF;
  IF v_poll.confirmed_date_id IS NULL OR NEW.date_id <> v_poll.confirmed_date_id THEN
    RETURN NEW;
  END IF;

  -- Skip when confirmation just happened in the same xact (auto_close trigger
  -- ran first and immediately hit at-target). The 'confirmed' worker
  -- handles preemption.
  IF v_poll.confirmed_at IS NOT NULL
     AND now() - v_poll.confirmed_at < interval '500 milliseconds' THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_yes_cnt
    FROM game_poll_votes
    WHERE date_id = v_poll.confirmed_date_id AND response = 'yes';

  IF v_yes_cnt >= v_poll.target_player_count THEN
    PERFORM enqueue_poll_notification(v_poll.id, 'target_filled');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enqueue_target_filled_on_vote ON public.game_poll_votes;
CREATE TRIGGER trg_enqueue_target_filled_on_vote
  AFTER INSERT OR UPDATE OF response ON public.game_poll_votes
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_enqueue_target_filled_on_vote();

-- ──────────────────────────────────────────────────────────────────────────
-- 5. Realtime publication: workers wake on new jobs
-- ──────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'notification_jobs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.notification_jobs;
  END IF;
END
$$;
