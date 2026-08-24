-- ============================================================
-- Migration 108: the browser worker stops poisoning jobs it can't send
-- Run in Supabase SQL Editor after 107-no-duplicate-pick-announcements.sql
-- (Idempotent — CREATE OR REPLACE + a self-limiting one-time UPDATE.)
--
-- Why: `notification_jobs` is drained by two independent workers.
--   * Server (migration 066): `/api/notification-worker`, claims via
--     `claim_notification_job_internal`, handles EVERY kind.
--   * Browser (`src/utils/notificationWorker.ts`), claims via
--     `claim_notification_job` — but `runJob` only implements five kinds
--     (creation / expanded / confirmed / cancellation / target_filled).
--
--   `claim_notification_job` never filtered on kind, so the browser could
--   win the race for a `vote_change` (or trivia/training/reminder) job.
--   The claim already flipped the row to 'running' and incremented
--   `attempts` server-side; the client then recognised the kind as
--   unhandled, logged a warning, and returned NULL — which the drain loop
--   reads as "queue empty" and breaks on. The row was never completed and
--   never released, so `last_error` stayed NULL.
--
--   Three lost races later `attempts = 3`, and the claim's own
--   `attempts < 3` predicate makes the row permanently unclaimable — even
--   by the server worker, and even after the 5-minute lease expires. It
--   sits in 'running' forever. Because `idx_notification_jobs_active_uniq`
--   is UNIQUE on (poll_id, kind) WHERE status IN ('pending','running'),
--   that corpse then swallows every future enqueue of the same kind for
--   that poll: `enqueue_*` treats the unique_violation as "already
--   queued" and returns quietly.
--
--   Net effect: vote-change notifications died mid-poll, permanently, and
--   nobody could tell. Measured before this migration: 10 of the last 11
--   polls had a wedged `vote_change` row, in every case the NEWEST one for
--   that poll, and 101 subsequent vote events across those polls produced
--   zero jobs. On the poll that was live when this was found (edb1d40b)
--   the channel died 2026-08-23 07:42 and 16 vote events went unannounced.
--   One `training_report_resolved` row wedged the same way.
--
--   This matters more since migration 106: with the auto-lock gone the
--   roster legitimately churns until game night, so "X dropped out" is
--   exactly the signal admins need and exactly the one going missing.
--
-- Fix, three parts:
--   1. `claim_notification_job` hands the browser only the kinds the
--      browser can actually dispatch. The unhandled-kind path stops
--      existing rather than being handled better. The server worker is
--      untouched — it claims through `claim_notification_job_internal`
--      and still sees every kind.
--   2. `release_notification_job` lets a claimer hand a job back without
--      burning the attempt, so a future kind mismatch (a new kind added
--      server-side before the client learns it) degrades into a no-op
--      instead of a wedge.
--   3. A self-healing reap inside the claim, plus a one-time cleanup of
--      the rows already wedged, so the blocked (poll_id, kind) slots free
--      up. `attempts >= 3` + a lease older than an hour is abandoned by
--      any definition — a real in-flight dispatch takes seconds.
--
-- Sends nothing: `trg_http_dispatch_notification_job` fires AFTER INSERT
--   only (WHEN new.status = 'pending'), so UPDATEing existing rows cannot
--   dispatch a push or an email. No poll, date, vote or settings row is
--   touched by this migration. The wedged rows are marked terminal
--   'failed' rather than replayed, so the stale events they describe stay
--   unannounced — only the NEXT real vote change notifies.
-- ============================================================

-- 1. Browser claim — kind-filtered + self-healing ----------------------
-- Kind list mirrors the switch in `runJob` (src/utils/notificationWorker.ts).
-- Adding a kind to that switch means adding it here; leaving it out is
-- safe (the server worker covers every kind).
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

  -- Retire rows that exhausted their attempts while still 'running'. The
  -- claim predicate below can never pick them up again, so without this
  -- they hold their unique-index slot forever and mute that (poll, kind)
  -- channel. Scoped to the caller's group so a member can only heal their
  -- own queue.
  --
  -- Table alias is load-bearing: this function's RETURNS TABLE declares
  -- `attempts` (and id/poll_id/kind) as PL/pgSQL OUT variables, so a bare
  -- column reference here raises 42702 "column reference is ambiguous"
  -- and every claim call fails.
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
$$;

GRANT EXECUTE ON FUNCTION public.claim_notification_job(UUID) TO authenticated;

-- 2. release_notification_job — hand a claim back, unharmed ------------
-- For a claimer that finds it cannot dispatch the job after all. Undoes
-- the claim's attempt increment so the job keeps its full retry budget
-- for the worker that CAN send it. Restricted to the row this caller
-- currently holds, so it can't reset a peer's in-flight dispatch.
CREATE OR REPLACE FUNCTION public.release_notification_job(
  p_job_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_group_id UUID;
BEGIN
  SELECT group_id INTO v_group_id FROM notification_jobs WHERE id = p_job_id;

  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'invalid_job';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM group_members
    WHERE group_id = v_group_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not_member';
  END IF;

  -- Back to 'pending' does NOT re-dispatch: the pg_net trigger is
  -- AFTER INSERT only. The pg_cron sweep picks it up within the minute.
  UPDATE notification_jobs
     SET status     = 'pending',
         claimed_at = NULL,
         claimed_by = NULL,
         attempts   = GREATEST(attempts - 1, 0)
   WHERE id         = p_job_id
     AND status     = 'running'
     AND claimed_by = auth.uid();
END;
$$;

GRANT EXECUTE ON FUNCTION public.release_notification_job(UUID) TO authenticated;

-- 3. One-time cleanup of the already-wedged rows -----------------------
-- Same predicate as the in-claim reap, but across all groups, because the
-- reap only runs when a member of that group next drains their queue.
-- Self-limiting: once these are 'failed' the UPDATE matches nothing.
UPDATE notification_jobs
   SET status       = 'failed',
       completed_at = now(),
       last_error   = COALESCE(last_error, 'abandoned while running (migration 108 cleanup)')
 WHERE status   = 'running'
   AND attempts >= 3
   AND claimed_at < now() - interval '1 hour';

-- ============================================================
-- DONE — Verify with:
--   -- 1. No wedged rows left, and nothing new sent:
--   SELECT status, count(*) FROM notification_jobs GROUP BY status;
--   --    'running' should only ever hold rows claimed in the last minutes.
--
--   -- 2. The unique-index slots are free again — a fresh enqueue of the
--   --    same (poll_id, kind) now succeeds instead of silently dedup'ing:
--   SELECT p.id, p.status,
--          EXISTS (SELECT 1 FROM notification_jobs j
--                   WHERE j.poll_id = p.id AND j.kind = 'vote_change'
--                     AND j.status IN ('pending','running')) AS slot_taken
--     FROM game_polls p WHERE p.status IN ('open','expanded','confirmed');
--
--   -- 3. The browser claim can no longer see a vote_change job. As a
--   --    member of the group, with a pending vote_change row present:
--   SELECT * FROM claim_notification_job('<group_id>');  -- returns 0 rows
-- ============================================================
