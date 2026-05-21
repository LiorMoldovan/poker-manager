-- ============================================================
-- Migration 091: enqueue_poll_notification honors the per-kind sentinel
-- Run in Supabase SQL Editor after 090-target-filled-sentinel-gate.sql
-- (Idempotent — CREATE OR REPLACE only.)
--
-- Why: Today (2026-05-21 11:00 IL) Lior enabled the auto-create toggle for
--   the first time. Two bugs co-fired:
--
--   1. ScheduleTab's auto-create useEffect treats `scheduleAutoCreatedAt
--      IS NULL` as "we missed last Sunday — catch up now". That's a
--      separate fix in TS (see v6.8.4 ScheduleTab change shipping
--      alongside this migration).
--
--   2. The 'creation' notification job ran TWICE:
--        - 11:00:52 (IL): trigger trg_enqueue_poll_notification_on_change
--          fires on the INSERT into game_polls. Job #1 enqueued + worker
--          drains it → 11 emails to permanents → sentinel
--          creation_notifications_sent_at stamped at 11:01:00.
--        - 11:01:01 (IL): runSchedulerSweep on ScheduleTab re-runs (its
--          deps changed when the poll INSERT landed in cache via
--          realtime). It reads poll.creationNotificationsSentAt from
--          the in-memory cache, which had NOT YET caught the sentinel
--          update (cache has a 500ms debounce + realtime ordering). So
--          the sweep called enqueue_poll_notification(id, 'creation')
--          AGAIN. The partial unique index on (poll_id, kind) WHERE
--          status IN ('pending','running') did not block it because
--          job #1 was already in 'done' state. Job #2 enqueued + worker
--          drained it → another 10 emails (same audience), netting
--          11 permanents × 2 = 21 sent (one dedupe along the way).
--
-- The duplicate-enqueue is a class bug, not a target_filled-specific bug.
-- Mig 090 fixed exactly this pattern for 'target_filled' by adding a
-- sentinel guard inside the trigger function. Same fix belongs inside
-- enqueue_poll_notification itself so it covers EVERY kind without
-- needing a per-trigger patch.
--
-- Fix: enqueue_poll_notification now reads the per-kind sentinel
--   (creation_notifications_sent_at / expanded_notifications_sent_at /
--   confirmed_notifications_sent_at / cancellation_notifications_sent_at /
--   target_filled_notifications_sent_at) from game_polls BEFORE
--   attempting the INSERT. If non-null, the function returns NULL
--   (no-op). This is the SAME canonical "already announced" check
--   complete_notification_job uses when stamping the sentinel; reading
--   it here just closes the cache-staleness window.
--
-- Race coverage (each window traced):
--   * Trigger fires on INSERT → sentinel NULL → INSERT succeeds (no
--     change vs today).
--   * Sweep runs during job execution → sentinel still NULL → falls
--     through to the partial unique index, which catches the duplicate
--     because the pending/running job is still there. No change.
--   * Sweep runs AFTER job done → sentinel now non-null → new check
--     fires → RPC returns NULL. **This is the bug fix.**
--   * Sweep runs on a poll that was completed in a previous cycle but
--     whose status field is stale → sentinel non-null → skip. No
--     surprise: the work is already done.
--   * Legacy polls created before mig 061 with sentinel stamped by
--     old code → skip. We don't want to re-fan-out 2-week-old events.
--
-- No related path silently regresses:
--   * Release-pin → re-pin same date: mig 089 already preserves the
--     sentinel across release_pin, so the gate correctly skips.
--   * Release-pin → re-pin a different date: the status trigger nulls
--     confirmed_notifications_sent_at and target_filled_notifications_sent_at
--     (mig 089's stay-set rule applies to the SAME date only). So the
--     fresh enqueue sees NULL → proceeds. Correct.
--   * Cancellation of a previously-confirmed poll: cancellation has
--     its own sentinel, untouched by other kinds' sentinels. Each kind
--     is gated independently. Correct.
-- ============================================================

CREATE OR REPLACE FUNCTION public.enqueue_poll_notification(
  p_poll_id UUID,
  p_kind    TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_group_id     UUID;
  v_sentinel     TIMESTAMPTZ;
  v_id           UUID;
BEGIN
  IF p_kind NOT IN ('creation','expanded','confirmed','cancellation','target_filled') THEN
    RAISE EXCEPTION 'invalid_kind: %', p_kind;
  END IF;

  -- Read group_id AND the per-kind sentinel in a single SELECT.
  -- Sentinel = the *_notifications_sent_at column matching p_kind.
  -- Non-null sentinel means a job for this (poll, kind) has already
  -- run to completion (or been explicitly preempted, e.g. via
  -- preempt_target_filled_job). In either case the work is done and
  -- we must not enqueue a redundant job.
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
    -- Poll deleted or never existed; silently no-op so trigger context
    -- doesn't blow up an in-flight UPDATE on an unrelated row.
    RETURN NULL;
  END IF;

  -- NEW (mig 091): canonical "already announced" gate.
  IF v_sentinel IS NOT NULL THEN
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

-- ============================================================
-- DONE — Verify with:
--
--   -- 1. Function body has the new sentinel guard:
--   SELECT pg_get_functiondef('public.enqueue_poll_notification'::regproc);
--
--   -- 2. Repro of today's bug — the second 'creation' enqueue is now a no-op:
--   --    (Run against a freshly INSERTed poll where the worker has already
--   --     stamped creation_notifications_sent_at. The function returns NULL.)
--   SELECT public.enqueue_poll_notification(
--     '<some_poll_id_with_creation_sentinel_set>'::uuid, 'creation'
--   );
--
--   -- 3. New fresh polls still work — sentinel NULL → real job enqueued:
--   --    (No live test possible without inserting a poll; covered by the
--   --     existing trigger trg_enqueue_poll_notification_on_insert path.)
-- ============================================================
