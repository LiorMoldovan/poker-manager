// Auto-notify question reporters when an admin resolves their training report.
// Sends both push (short summary) + email (full nicely-formatted message).
// If the admin used AI to analyze/fix, the rich acceptText/rejectText is used.
// Otherwise a generic outcome message is built from the action that was taken.

import type { PoolScenario, TrainingFlagReport } from '../types';
import { getGroupId, getPlayerEmailForNotification } from '../database/supabaseCache';
import { proxySendPush, proxySendBroadcastEmail } from './apiProxy';

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

const REASON_LABELS: Record<string, string> = {
  wrong_answer: 'התשובה הנכונה שגויה',
  unclear_question: 'השאלה לא ברורה',
  wrong_for_home_game: 'מתאים למקצועי אבל לא למשחק ביתי',
  other: 'אחר',
};

function uniqueReporterNames(reports: TrainingFlagReport[]): string[] {
  const seen = new Set<string>();
  for (const r of reports) {
    const n = (r.playerName || '').trim();
    if (n && !seen.has(n)) seen.add(n);
  }
  return [...seen];
}

function buildQuestionContext(scenario: PoolScenario | null | undefined): string {
  if (!scenario) return '';
  const correct = scenario.options?.find(o => o.isCorrect);
  const lines = [
    scenario.yourCards ? `🃏 קלפים: ${scenario.yourCards}` : '',
    scenario.boardCards?.trim() ? `🂠 בורד: ${scenario.boardCards.trim()}` : '',
    scenario.situation ? `📋 ${scenario.situation}` : '',
    correct ? `✅ תשובה נכונה: ${correct.text}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

function reporterCommentBlock(reports: TrainingFlagReport[], reporterName: string): string {
  const my = reports.find(r => r.playerName === reporterName);
  if (!my) return '';
  const reasonLabel = REASON_LABELS[my.reason] || my.reason;
  const comment = my.comment ? ` — "${my.comment}"` : '';
  return `💬 הדיווח שלך: ${reasonLabel}${comment}`;
}

function genericOutcomeText(outcome: ReportResolutionOutcome): string {
  switch (outcome) {
    case 'accept_removed':
      return 'תודה רבה על הדיווח! 🙏\nהדיווח התקבל והשאלה הוסרה מהמאגר. הציון שלך על השאלה הזו אותר ותוקן כך שהוא לא נספר לרעתך.';
    case 'accept_fixed':
      return 'תודה רבה על הדיווח! 🙏\nהדיווח התקבל — השאלה תוקנה ועודכנה במאגר בעקבות ההערה שלך. עכשיו היא נכונה לכולם.';
    case 'reject_kept':
      return 'תודה על הדיווח! 🙏\nבדקנו אותו בעיון, אך החלטנו שהשאלה תקינה כפי שהיא והיא נשארת במאגר. הניקוד שלך על השאלה הזו לא משתנה.';
  }
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

function pickAiText(outcome: ReportResolutionOutcome, ai?: AiResolutionText | null): string {
  if (!ai) return '';
  if (outcome === 'reject_kept') return (ai.rejectText || '').trim();
  // accept_removed / accept_fixed
  return (ai.acceptText || ai.rejectText || '').trim();
}

function buildFullMessage(
  reporterName: string,
  scenario: PoolScenario,
  reports: TrainingFlagReport[],
  outcome: ReportResolutionOutcome,
  ai?: AiResolutionText | null,
): string {
  const greeting = `היי ${reporterName}! 🎯\n\nלגבי הדיווח שלך על שאלת אימון:`;
  const ctx = buildQuestionContext(scenario);
  const myComment = reporterCommentBlock(reports, reporterName);
  const aiText = pickAiText(outcome, ai);
  const body = aiText || genericOutcomeText(outcome);
  return [greeting, '', ctx, myComment, '', body, '', '— Poker Manager 🃏']
    .filter((part, i, arr) => {
      // collapse consecutive blank lines
      if (part !== '') return true;
      return arr[i - 1] !== '';
    })
    .join('\n');
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
  const { reports, scenario, outcome, ai } = opts;

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

  // Push: one batched call per group (server filters by player names).
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

  // Email: per-reporter (each gets a personalized full message including their own comment).
  await Promise.allSettled(names.map(async (name) => {
    try {
      const info = await getPlayerEmailForNotification(groupId, name);
      if (!info?.email) return;
      const fullMessage = buildFullMessage(name, scenario, reports, outcome, ai);
      const ok = await proxySendBroadcastEmail({
        to: info.email,
        subject: title,
        message: fullMessage,
        senderName: 'Poker Training',
      });
      if (ok) result.emailsSent++;
      else result.errors.push(`email failed: ${name}`);
    } catch (err) {
      result.errors.push(`email ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }));

  if (result.errors.length > 0) {
    console.warn('[training-report-notify] partial errors:', result.errors);
  }

  return result;
}
