// Training report notifications — server-dispatched via the
// notification_jobs queue (migration 066, v5.49.0).
//
// Three flows trigger pushes from the training UI:
//   1. notifyReportersOfResolution — when an admin resolves training
//      reports (player learns whether their flag was accepted/dismissed).
//   2. notifySuperAdminsOfReports — when a player flags one or more
//      questions in a training session (super-admins get a single
//      batched ping per session).
//   3. notifySuperAdminsOfMilestone — when a player crosses a 100-question
//      milestone (super-admins get notified to review fresh insights).
//
// Previously these called /api/send-push directly from the actor's
// browser, which lost the push if the actor's tab closed mid-fetch.
// All three now enqueue a `training_*` job into notification_jobs with
// the fully-built push payload; the server worker drains the queue and
// dispatches via /api/send-push, regardless of who's online or what
// version their cached client is running.
//
// The kind enum + DB CHECK constraint (migration 066) covers:
//   training_report_filed     — super-admins
//   training_report_resolved  — reporters
//   training_milestone        — super-admins
// Email is not used for training (retired in v5.43); the worker treats
// these as push-only by convention.

import type { PoolScenario, TrainingFlagReport } from '../types';
import { getGroupId, enqueueNotificationRpc } from '../database/supabaseCache';
import { getSuperAdminPlayerNamesInGroup } from '../database/storage';

export type ReportResolutionOutcome =
  | 'accept_removed' // admin deleted the question (report accepted, question gone)
  | 'accept_fixed'   // admin replaced the question with an AI-fixed version
  | 'reject_kept';   // admin dismissed the report (question stays as-is)

export interface AiResolutionText {
  verdict: string;
  explanation?: string;
  acceptText?: string;
  rejectText?: string;
}

function uniqueReporterNames(reports: TrainingFlagReport[]): string[] {
  const seen = new Set<string>();
  for (const r of reports) {
    const n = (r.playerName || '').trim();
    if (n && !seen.has(n)) seen.add(n);
  }
  return [...seen];
}

function shortPushBody(outcome: ReportResolutionOutcome): { title: string; body: string } {
  switch (outcome) {
    case 'accept_removed':
      return { title: '✅ הדיווח שלך התקבל', body: 'השאלה הוסרה מהמאגר והציון שלך תוקן' };
    case 'accept_fixed':
      return { title: '✅ הדיווח שלך התקבל', body: 'השאלה תוקנה בעקבות הדיווח שלך' };
    case 'reject_kept':
      return { title: 'ℹ️ הדיווח שלך נבדק', body: 'החלטנו שהשאלה תקינה — היא נשארת במאגר' };
  }
}

export interface NotifyReportersOptions {
  reports: TrainingFlagReport[];
  scenario: PoolScenario | null | undefined;
  outcome: ReportResolutionOutcome;
  ai?: AiResolutionText | null;
}

export interface NotifyReportersResult {
  attempted: number;
  pushSent: number;
  emailsSent: number;
  errors: string[];
}

// Best-effort: never throws. The enqueue call is the only network step;
// failure there means the DB rejected the row (auth, RLS, etc.) and is
// logged but not surfaced to the caller.
export async function notifyReportersOfResolution(
  opts: NotifyReportersOptions,
): Promise<NotifyReportersResult> {
  const result: NotifyReportersResult = { attempted: 0, pushSent: 0, emailsSent: 0, errors: [] };
  const { reports, scenario, outcome } = opts;

  if (!reports || reports.length === 0 || !scenario) return result;

  const groupId = getGroupId();
  if (!groupId) {
    result.errors.push('no group id');
    return result;
  }

  const names = uniqueReporterNames(reports);
  if (names.length === 0) return result;
  result.attempted = names.length;

  const { title, body: shortBody } = shortPushBody(outcome);

  try {
    await enqueueNotificationRpc('training_report_resolved', groupId, {
      push_title: title,
      push_body: shortBody,
      recipient_player_names: names,
      url: '/settings?tab=training',
    });
    // We optimistically count enqueue success as "sent" — actual delivery
    // happens server-side and may partially fail per-subscription, but
    // the caller only needs to know we successfully handed the job off.
    result.pushSent = names.length;
  } catch (err) {
    result.errors.push(`enqueue: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (result.errors.length > 0) {
    console.warn('[training-report-notify] enqueue errors:', result.errors);
  }

  return result;
}

// Fired once per session with the count of newly-flagged questions.
// We don't push per-flag to avoid hammering super-admins during a long
// quiz with several reports.
export async function notifySuperAdminsOfReports(opts: {
  reports: TrainingFlagReport[];
  reporterName: string;
}): Promise<void> {
  const { reports, reporterName } = opts;
  if (!reports || reports.length === 0) return;

  const groupId = getGroupId();
  if (!groupId) {
    console.warn('[training-super-admin-notify/reports] no group id');
    return;
  }

  const names = await getSuperAdminPlayerNamesInGroup(groupId);
  // Don't ping the reporter if they happen to be a super-admin themselves.
  const targets = names.filter(n => n !== reporterName);
  if (targets.length === 0) return;

  const count = reports.length;
  const title = '🚩 דיווח חדש על שאלת אימון';
  const body = count === 1
    ? `${reporterName} דיווח על שאלה — לבדיקה`
    : `${reporterName} דיווח על ${count} שאלות — לבדיקה`;

  try {
    await enqueueNotificationRpc('training_report_filed', groupId, {
      push_title: title,
      push_body: body,
      recipient_player_names: targets,
      url: '/settings?tab=training',
    });
  } catch (err) {
    console.warn('[training-super-admin-notify/reports] enqueue failed:', err);
  }
}

// Fired when a player crosses a 100-question milestone. Super-admins are
// notified so they can review (or, if the group has no Gemini key, manually
// regenerate) the player's coaching insights. Auto-regen still runs when
// the key is present — this push is purely informational.
export async function notifySuperAdminsOfMilestone(opts: {
  playerName: string;
  milestone: number;
  hasApiKey: boolean;
}): Promise<void> {
  const { playerName, milestone, hasApiKey } = opts;
  if (!playerName || !milestone) return;

  const groupId = getGroupId();
  if (!groupId) {
    console.warn('[training-super-admin-notify/milestone] no group id');
    return;
  }

  const names = await getSuperAdminPlayerNamesInGroup(groupId);
  // Don't ping the player who just crossed the milestone.
  const targets = names.filter(n => n !== playerName);
  if (targets.length === 0) return;

  const title = `🎯 ${playerName} חצה ${milestone} שאלות`;
  const body = hasApiKey
    ? 'תובנות חדשות נוצרו — מומלץ לעבור עליהן'
    : 'יש לרענן ידנית את התובנות בלשונית האימון';

  try {
    await enqueueNotificationRpc('training_milestone', groupId, {
      push_title: title,
      push_body: body,
      recipient_player_names: targets,
      url: '/settings?tab=training',
    });
  } catch (err) {
    console.warn('[training-super-admin-notify/milestone] enqueue failed:', err);
  }
}
