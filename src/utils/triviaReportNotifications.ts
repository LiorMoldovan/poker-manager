// Push notifications for the trivia reports flow.
//
// Mirrors `trainingReportNotifications.ts` pattern but is much
// simpler — trivia reports don't have an AI auto-fix step, so the
// resolution outcomes collapse to two cases (resolved / dismissed)
// and the reporter notification body matches that.
//
// Both helpers are best-effort and never throw — push failures
// must NEVER block the report flow they're attached to. We log to
// console.warn on failure and return cleanly so the caller can
// continue.
//
// Deep-link target: `/settings?tab=triviaReports` — same shape the
// training notifications use (?tab=training), routed through the
// settings tab id system.

import { getGroupId } from '../database/supabaseCache';
import { getSuperAdminPlayerNamesInGroup } from '../database/storage';
import { proxySendPush } from './apiProxy';

// Two outcomes only — trivia doesn't have the training "AI fixed
// the question" middle case because trivia questions are dynamic
// (a fix means editing the generator code and shipping a deploy,
// which the reporter doesn't see synchronously).
export type TriviaResolutionOutcome =
  | 'accept' // resolved — admin accepted the report; fix coming in next deploy
  | 'reject'; // dismissed — admin reviewed and the question was actually correct

interface ReporterTarget {
  reporterName: string;
}

interface NotifyReporterOpts extends ReporterTarget {
  outcome: TriviaResolutionOutcome;
  // Question text is captured on the report row so the reporter
  // can recognize WHICH report just got resolved (they may have
  // filed multiple). Trimmed by the push payload sender if too long.
  questionText: string;
}

// ── Player → super-admin notification ─────────────────────────────
//
// Fired the moment a player submits a trivia report. Pushes a
// single per-report ping (as opposed to training, which batches
// per-session) because trivia reports come in much more sparingly
// — the admin actually wants to know about each one.
export async function notifySuperAdminsOfTriviaReport(opts: {
  reporterName: string;
  reason: 'wrong_answer' | 'unclear_question' | 'other';
  questionText: string;
}): Promise<void> {
  const { reporterName, reason, questionText } = opts;
  if (!reporterName) return;

  const groupId = getGroupId();
  if (!groupId) {
    console.warn('[trivia-super-admin-notify] no group id');
    return;
  }

  const names = await getSuperAdminPlayerNamesInGroup(groupId);
  // Don't ping the reporter if they're a super-admin themselves —
  // they just filed the report, they obviously already know.
  const targets = names.filter(n => n !== reporterName);
  if (targets.length === 0) return;

  // Hebrew copy mirrors the training equivalent so both report
  // streams feel consistent in the super-admin's notification list.
  const reasonLabel: Record<typeof reason, string> = {
    wrong_answer: 'תשובה שגויה',
    unclear_question: 'שאלה לא ברורה',
    other: 'דיווח כללי',
  };
  const title = '🚩 דיווח חדש על שאלת חידון';
  // Body shows reporter + reason + a short slice of the question
  // so the admin can decide on-the-spot whether to open the app.
  // 80 chars is the empirical sweet spot for push body display
  // without iOS truncating mid-word.
  const snippet = questionText.length > 80
    ? `${questionText.slice(0, 77)}...`
    : questionText;
  const body = `${reporterName} (${reasonLabel[reason]}) — ${snippet}`;

  try {
    await proxySendPush({
      groupId,
      title,
      body,
      targetPlayerNames: targets,
      url: '/settings?tab=triviaReports',
    });
  } catch (err) {
    console.warn('[trivia-super-admin-notify] push failed:', err);
  }
}

// ── Super-admin → reporter notification ───────────────────────────
//
// Fired after `resolve_trivia_report` succeeds, so the reporter
// learns the outcome of THEIR specific report. Uses the captured
// `player_name` from the report row (NOT auth.users) so we hit the
// player even if they signed up with a different display name in
// auth.
export async function notifyReporterOfTriviaResolution(
  opts: NotifyReporterOpts,
): Promise<void> {
  const { reporterName, outcome, questionText } = opts;
  if (!reporterName) return;

  const groupId = getGroupId();
  if (!groupId) {
    console.warn('[trivia-reporter-notify] no group id');
    return;
  }

  const title = outcome === 'accept'
    ? '✅ הדיווח שלך התקבל'
    : 'ℹ️ הדיווח שלך נבדק';
  const body = outcome === 'accept'
    ? 'נטפל בשאלה — תיקון יישלח בעדכון הקרוב'
    : 'החלטנו שהשאלה תקינה';
  // Append a 60-char snippet of the original question so the
  // reporter knows WHICH of their reports just got triaged.
  const snippet = questionText.length > 60
    ? `${questionText.slice(0, 57)}...`
    : questionText;
  const fullBody = `${body} — "${snippet}"`;

  try {
    await proxySendPush({
      groupId,
      title,
      body: fullBody,
      targetPlayerNames: [reporterName],
      url: '/settings?tab=triviaReports',
    });
  } catch (err) {
    console.warn('[trivia-reporter-notify] push failed:', err);
  }
}
