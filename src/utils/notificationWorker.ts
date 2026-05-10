// Notification job worker — drains the notification_jobs queue.
//
// Architecture (migration 061):
//   * DB triggers atomically enqueue jobs in `notification_jobs` when a
//     poll lifecycle transition happens (status change on game_polls,
//     yes-vote crossing target on game_poll_votes).
//   * Any logged-in group member's browser runs this worker on:
//       - ScheduleTab mount (via runSchedulerSweep)
//       - Realtime cache updates (game_polls / game_poll_votes / notification_jobs)
//       - 60s interval while the app is foreground
//   * The worker claims one job at a time via SELECT FOR UPDATE SKIP LOCKED
//     (server-side in claim_notification_job RPC), runs the matching
//     dispatchX helper from `scheduleNotifications.ts`, and marks the job
//     done via complete_notification_job. The legacy
//     *_notifications_sent_at sentinel is mirrored on success (handled in
//     the RPC) so existing UI labels and sweep logic stay consistent.
//
// Why this fixes the 2026-05-10 incident: the actor's browser is no longer
// in the critical path. The job is durable in Postgres the moment the
// lifecycle transition commits. Even if the actor's tab closes immediately,
// any other online member (or the actor themselves on next mount) drains
// the queue. Up to 3 attempts per job before terminal `failed` status, and
// a 5-min lease on `running` jobs auto-recovers worker crashes.

import {
  claimNotificationJobRpc, completeNotificationJobRpc,
  preemptTargetFilledJobRpc, refreshPollsNow,
  type ClaimedNotificationJob, type NotificationJobKind,
} from '../database/supabaseCache';
import { getAllPolls, getGroupId } from '../database/storage';
import {
  dispatchInvitation, dispatchExpanded, dispatchConfirmed,
  dispatchCancellation, dispatchTargetFilled,
} from './scheduleNotifications';
import type { GamePoll } from '../types';

// Per-tab guard against stampedes. Realtime can fire many events in close
// succession (a vote insert + 5 status updates within 100ms during an
// at-target auto-close), and we don't want each one to spawn its own
// drain loop. The lock releases as soon as the in-flight loop ends.
let workerRunning = false;

// Soft rate-limit so a tab that's getting hammered with realtime events
// doesn't churn through claim RPCs. 1.5s is plenty — long enough to
// coalesce bursts, short enough that a fresh job from a peer client gets
// picked up well before the recipient closes their app.
const MIN_RUN_GAP_MS = 1500;
let lastRunStartedAt = 0;

// Hard cap on claims per drain pass. Catches a bug where the queue keeps
// returning the same job (shouldn't happen — claim is atomic — but
// belt-and-suspenders against an infinite loop).
const MAX_CLAIMS_PER_RUN = 25;

export async function processNotificationJobs(): Promise<void> {
  if (workerRunning) return;
  const now = Date.now();
  if (now - lastRunStartedAt < MIN_RUN_GAP_MS) return;

  const groupId = getGroupId();
  if (!groupId) return;

  workerRunning = true;
  lastRunStartedAt = now;

  try {
    // Refresh polls cache once at the start of the drain. The DB has the
    // freshest state but our in-memory `getAllPolls()` reads the cache,
    // and a job that just enqueued may reference a poll whose realtime
    // tick hasn't landed yet. This single refresh covers the burst.
    await refreshPollsNow();

    let drained = 0;
    while (drained < MAX_CLAIMS_PER_RUN) {
      const job = await claimNotificationJobRpc(groupId);
      if (!job) break;
      drained++;

      try {
        await runJob(job);
        await completeNotificationJobRpc(job.id, true);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[notification-worker] ${job.kind} ${job.pollId} failed (attempt ${job.attempts}):`, msg);
        await completeNotificationJobRpc(job.id, false, msg.slice(0, 500));
      }
    }

    if (drained > 0) {
      console.log(`[notification-worker] drained ${drained} job${drained === 1 ? '' : 's'}`);
    }
  } finally {
    workerRunning = false;
  }
}

async function runJob(job: ClaimedNotificationJob): Promise<void> {
  const poll = findPollOrThrow(job.pollId, job.kind);

  switch (job.kind) {
    case 'creation':
      await dispatchInvitation(poll);
      return;
    case 'expanded':
      await dispatchExpanded(poll);
      return;
    case 'confirmed': {
      const result = await dispatchConfirmed(poll);
      // At-target confirmation: preempt any pending 'target_filled' job
      // for this poll. Without this the recipient gets "המשחק נסגר!"
      // followed almost immediately by "המשחק מלא — ניפגש!" — same
      // information, twice.
      if (result?.atTargetConfirm) {
        await preemptTargetFilledJobRpc(poll.id);
      }
      return;
    }
    case 'cancellation':
      await dispatchCancellation(poll);
      return;
    case 'target_filled':
      await dispatchTargetFilled(poll);
      return;
  }
  // Exhaustiveness guard
  const _exhaustive: never = job.kind;
  throw new Error(`unhandled job kind: ${String(_exhaustive)}`);
}

function findPollOrThrow(pollId: string, kind: NotificationJobKind): GamePoll {
  const poll = getAllPolls().find(p => p.id === pollId);
  if (!poll) {
    throw new Error(`poll ${pollId} not found in cache for kind=${kind}`);
  }
  return poll;
}
