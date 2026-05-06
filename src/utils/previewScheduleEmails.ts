// Schedule-email preview helper. Sends synthetic samples of each
// poker-night email variant to a target inbox so we (or the super
// admin) can eyeball the rendered output in a real client without
// re-creating poll states organically.
//
// Two entry points:
//   * `previewAllScheduleEmails(toEmail)` — back-compat, sends every
//     variant in lifecycle order. Wired to `window.previewAllScheduleEmails`
//     for one-shot console use on the deployed Vercel site.
//   * `previewScheduleEmail(toEmail, variant)` — single variant; what
//     the in-app super-admin tester in the Notifications tab calls.
//
// Either way the synthetic poll fixture and the real `build*Message`
// builders from `scheduleNotifications.ts` are the source of truth —
// no copy-paste of email copy here.

import type { GamePoll, GamePollDate, GamePollVote } from '../types';
import { proxySendBroadcastEmail } from './apiProxy';
import {
  buildInvitationMessage,
  buildExpandedMessage,
  buildConfirmedMessage,
  buildConfirmedBelowTargetYesMessage,
  buildConfirmedBelowTargetOthersMessage,
  buildTargetFilledMessage,
  buildCancellationMessage,
  buildVoteEventMessage,
  type BuiltMessage,
} from './scheduleNotifications';

// Synthetic poll seed — shaped to exercise location, multiple proposed
// dates, partial vote roster, and a cancellation reason. Numbers chosen
// to make the various variants render meaningful copy (target=7 with 6
// yes-votes => "שחקן אחרון וסוגרים" singular variant).
function makeSyntheticPoll(): { poll: GamePoll; pinned: GamePollDate; sampleVote: GamePollVote } {
  const now = new Date();
  const inDays = (days: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const iso = now.toISOString();
  const dates: GamePollDate[] = [
    { id: 'date-thu', pollId: 'preview-poll', proposedDate: inDays(2), proposedTime: '21:00', location: 'מיקום ליאור', createdAt: iso },
    { id: 'date-fri', pollId: 'preview-poll', proposedDate: inDays(3), proposedTime: '21:00', location: null,         createdAt: iso },
    { id: 'date-sat', pollId: 'preview-poll', proposedDate: inDays(4), proposedTime: '21:00', location: null,         createdAt: iso },
  ];
  const mkVote = (id: string, playerId: string): GamePollVote => ({
    id, pollId: 'preview-poll', dateId: 'date-thu', playerId, userId: null, response: 'yes',
    comment: null, votedAt: iso, createdAt: iso, castByUserId: null,
  });
  const votes: GamePollVote[] = [
    mkVote('v1', 'p1'), mkVote('v2', 'p2'), mkVote('v3', 'p3'),
    mkVote('v4', 'p4'), mkVote('v5', 'p5'), mkVote('v6', 'p6'),
  ];
  const poll: GamePoll = {
    id: 'preview-poll',
    groupId: 'preview-group',
    createdBy: 'preview-user',
    createdAt: new Date(now.getTime() - 2 * 3600_000).toISOString(),
    status: 'open',
    targetPlayerCount: 7,
    expansionDelayHours: 48,
    expandedAt: null,
    confirmedDateId: 'date-thu',
    confirmedAt: now.toISOString(),
    confirmedGameId: null,
    note: null,
    defaultLocation: 'מיקום ליאור',
    allowMaybe: true,
    cancellationReason: 'אמיר חולה — נדחה לשבוע הבא',
    votingLockedAt: null,
    shareSlug: 'preview',
    creationNotificationsSentAt: null,
    expandedNotificationsSentAt: null,
    confirmedNotificationsSentAt: null,
    cancellationNotificationsSentAt: null,
    targetFilledNotificationsSentAt: null,
    dates,
    votes,
  };
  // Vote-change preview: a "no → yes" flip from דניאל would be the most
  // representative event (it both adds urgency and could be what closes
  // the poll). The vote object below mirrors what the real flow passes.
  const sampleVote = votes[0];
  return { poll, pinned: dates[0], sampleVote };
}

// Player-name list for the confirmed messages. Synthetic — purely for
// roster line readability in the preview email.
const PREVIEW_NAMES = ['ליאור', 'אמיר', 'דניאל', 'יואב', 'אסף', 'רן', 'איתי'];

// Lifecycle order matters for the "all" run: the inbox should look like
// a real poll's timeline, not a random grab bag. Each entry is a tiny
// closure that builds the actual `BuiltMessage` lazily so the work only
// runs when that variant is requested.
export type ScheduleEmailVariantId =
  | 'invitation'
  | 'expanded'
  | 'confirmed-at-target'
  | 'confirmed-below-target-yes'
  | 'confirmed-below-target-others'
  | 'target-filled'
  | 'cancellation'
  | 'vote-change';

interface VariantSpec {
  id: ScheduleEmailVariantId;
  build: () => BuiltMessage;
}

function buildVariants(): VariantSpec[] {
  const { poll, pinned, sampleVote } = makeSyntheticPoll();
  const yesCount = poll.votes.filter(v => v.dateId === pinned.id && v.response === 'yes').length;
  const missing = Math.max(0, poll.targetPlayerCount - yesCount);

  return [
    { id: 'invitation',                    build: () => buildInvitationMessage({ ...poll, status: 'open' }) },
    { id: 'expanded',                      build: () => buildExpandedMessage({ ...poll, status: 'expanded', expandedAt: new Date().toISOString() }) },
    { id: 'confirmed-at-target',           build: () => buildConfirmedMessage({ ...poll, status: 'confirmed' }, pinned, PREVIEW_NAMES) },
    { id: 'confirmed-below-target-yes',    build: () => buildConfirmedBelowTargetYesMessage({ ...poll, status: 'confirmed' }, pinned, yesCount, missing) },
    { id: 'confirmed-below-target-others', build: () => buildConfirmedBelowTargetOthersMessage({ ...poll, status: 'confirmed' }, pinned, yesCount, missing) },
    { id: 'target-filled',                 build: () => buildTargetFilledMessage({ ...poll, status: 'confirmed' }, pinned, PREVIEW_NAMES) },
    { id: 'cancellation',                  build: () => buildCancellationMessage({ ...poll, status: 'cancelled' }) },
    { id: 'vote-change',                   build: () => buildVoteEventMessage({ ...poll, status: 'open' }, sampleVote, 'דניאל', null, false) },
  ];
}

export const SCHEDULE_EMAIL_VARIANTS: ScheduleEmailVariantId[] = [
  'invitation',
  'expanded',
  'confirmed-at-target',
  'confirmed-below-target-yes',
  'confirmed-below-target-others',
  'target-filled',
  'cancellation',
  'vote-change',
];

async function sendOne(
  toEmail: string,
  variant: ScheduleEmailVariantId,
  msg: BuiltMessage,
  index: number,
): Promise<{ variant: ScheduleEmailVariantId; ok: boolean }> {
  // Tag the subject so multiple previews in a single inbox stay sortable
  // and don't get mistaken for live poll mail. Index keeps them ordered
  // even when sent in parallel.
  const subject = `[preview/${index + 1}-${variant}] ${msg.emailSubject}`;
  // RTL wrapping is applied centrally in `proxySendBroadcastEmail`,
  // so the preview behaves IDENTICALLY to a real send — same
  // `<div dir="rtl">` block, same alignment in the inbox.
  const ok = await proxySendBroadcastEmail({
    to: toEmail,
    subject,
    message: msg.emailBody('ליאור'),
    senderName: 'Poker Manager',
  });
  return { variant, ok };
}

function isValidEmail(s: string): boolean {
  // Same minimal sanity check used in the broadcast proxy — anything
  // stricter belongs server-side. We just want to fail fast on obvious
  // typos before hitting EmailJS's quota.
  return !!s && s.includes('@') && s.length >= 5;
}

// Send one specific variant. Powers the in-app super-admin tester so the
// user can preview a single template at a time without spamming their
// inbox with all eight.
export async function previewScheduleEmail(
  toEmail: string,
  variant: ScheduleEmailVariantId,
): Promise<{ variant: ScheduleEmailVariantId; ok: boolean }> {
  if (!isValidEmail(toEmail)) {
    throw new Error('previewScheduleEmail: pass a valid email address');
  }
  const variants = buildVariants();
  const spec = variants.find(v => v.id === variant);
  if (!spec) throw new Error(`previewScheduleEmail: unknown variant "${variant}"`);
  const idx = variants.indexOf(spec);
  return sendOne(toEmail, spec.id, spec.build(), idx);
}

// Send every variant. Kept for the console one-shot and the "all" UI
// option. Serial dispatch keeps inbox arrival order = lifecycle order
// and is gentler on the EmailJS endpoint.
export async function previewAllScheduleEmails(
  toEmail: string,
): Promise<Array<{ variant: ScheduleEmailVariantId; ok: boolean }>> {
  if (!isValidEmail(toEmail)) {
    throw new Error('previewAllScheduleEmails: pass a valid email address');
  }
  const variants = buildVariants();
  const results: Array<{ variant: ScheduleEmailVariantId; ok: boolean }> = [];
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    results.push(await sendOne(toEmail, v.id, v.build(), i));
  }
  return results;
}

// Attach to window so it's reachable from the console after a deployed
// build. Done in a side-effect import from App.tsx's dev bootstrap path.
declare global {
  interface Window {
    previewAllScheduleEmails?: typeof previewAllScheduleEmails;
    previewScheduleEmail?: typeof previewScheduleEmail;
  }
}

if (typeof window !== 'undefined') {
  window.previewAllScheduleEmails = previewAllScheduleEmails;
  window.previewScheduleEmail = previewScheduleEmail;
}
