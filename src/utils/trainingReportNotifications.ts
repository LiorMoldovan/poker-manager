// Auto-notify question reporters when an admin resolves their training report.
// Sends a short push summary only. Email was retired in v5.43 to keep us
// inside the EmailJS free quota — admins now review training resolutions in
// the UI (Settings → Training tab). The `ai` parameter is still accepted on
// the public API so callers don't have to change, and so we can revive a
// richer push payload (or in-app feed) without another caller migration.

import type { PoolScenario, TrainingFlagReport } from '../types';
import { getGroupId } from '../database/supabaseCache';
import { getSuperAdminPlayerNamesInGroup } from '../database/storage';
import { proxySendPush } from './apiProxy';

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

// Best-effort: never throws. Failures are logged but don't block the resolution flow.
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

  // Push only: one batched call per group (server filters by player names).
  // Email was retired in v5.43 — admins review resolutions in the UI.
  try {
    const pushRes = await proxySendPush({
      groupId,
      title,
      body: shortBody,
      targetPlayerNames: names,
      url: '/settings?tab=training',
    });
    if (pushRes && typeof pushRes.sent === 'number') result.pushSent = pushRes.sent;
  } catch (err) {
    result.errors.push(`push: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (result.errors.length > 0) {
    console.warn('[training-report-notify] partial errors:', result.errors);
  }

  return result;
}

// ─── Super-admin notifications ──────────────────────────────────────────
// When email fan-out for training events was retired in v5.43, super-admins
// were left with no signal that something needed their attention — they
// only saw new reports / milestone-pending insights when they manually
// opened Settings → Training. The two helpers below restore that signal
// as a quiet push (deep-linked to the Training tab) without bringing back
// any email. Both are best-effort and never throw.

// Fired once per session with the count + first reason of newly-flagged
// questions in that session. We deliberately don't push per-flag to avoid
// hammering super-admins during a long quiz with several reports.
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
    await proxySendPush({
      groupId,
      title,
      body,
      targetPlayerNames: targets,
      url: '/settings?tab=training',
    });
  } catch (err) {
    console.warn('[training-super-admin-notify/reports] push failed:', err);
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
    await proxySendPush({
      groupId,
      title,
      body,
      targetPlayerNames: targets,
      url: '/settings?tab=training',
    });
  } catch (err) {
    console.warn('[training-super-admin-notify/milestone] push failed:', err);
  }
}
