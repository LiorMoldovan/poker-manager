// Auto-notify question reporters when an admin resolves their training report.
// Sends a short push summary only. Email was retired in v5.43 to keep us
// inside the EmailJS free quota — admins now review training resolutions in
// the UI (Settings → Training tab). The `ai` parameter is still accepted on
// the public API so callers don't have to change, and so we can revive a
// richer push payload (or in-app feed) without another caller migration.

import type { PoolScenario, TrainingFlagReport } from '../types';
import { getGroupId } from '../database/supabaseCache';
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
