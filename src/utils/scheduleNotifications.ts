// Schedule notifications: push + email fan-out for poll lifecycle events.
// All helpers are claim-gated via claim_poll_notifications so multiple online
// clients can race to send and exactly one wins.

import type { GamePoll, GamePollDate, GamePollVote, RsvpResponse } from '../types';
import {
  getAllPlayers, getAllPolls, claimPollNotifications,
  getPlayerEmailForNotification, getSettings,
  getPollChangeRecipients,
} from '../database/storage';
import { proxySendPush, proxySendBroadcastEmail } from './apiProxy';

type NotificationKind =
  | 'creation' | 'expanded' | 'confirmed' | 'cancellation' | 'vote_change';

// ── Helpers ──

function formatHebrewDateTime(date: GamePollDate): string {
  try {
    const d = new Date(`${date.proposedDate}T${date.proposedTime || '21:00'}`);
    const weekday = d.toLocaleDateString('he-IL', { weekday: 'long' });
    const day = d.getDate();
    const month = d.getMonth() + 1;
    const time = date.proposedTime ? ` ${date.proposedTime.slice(0, 5)}` : '';
    return `${weekday} ${day}/${month}${time}`;
  } catch {
    return date.proposedDate;
  }
}

function deepLinkUrl(pollId: string): string {
  return `/settings?tab=schedule&pollId=${encodeURIComponent(pollId)}`;
}

// Absolute share URL for the email body (push uses the relative deep link
// above; email clients render bare URLs as auto-linkified hyperlinks, so
// we always need an absolute origin). Prefers the short share slug — same
// form WhatsApp shares emit — and falls back to the full UUID for polls
// that pre-date the slug migration or rows that haven't been hydrated yet.
function emailVoteLink(poll: GamePoll): string | null {
  if (typeof window === 'undefined') return null;
  const token = poll.shareSlug ?? poll.id;
  return `${window.location.origin}/p/${encodeURIComponent(token)}`;
}

function resolveRecipientPlayerIds(poll: GamePoll, kind: NotificationKind): string[] {
  const players = getAllPlayers();
  switch (kind) {
    case 'creation':
      return players
        .filter(p => p.type === 'permanent')
        .map(p => p.id);
    case 'expanded':
      return players
        .filter(p => p.type === 'permanent_guest' || p.type === 'guest')
        .map(p => p.id);
    case 'confirmed': {
      if (!poll.confirmedDateId) return [];
      return Array.from(new Set(
        poll.votes
          .filter(v => v.dateId === poll.confirmedDateId && v.response === 'yes')
          .map(v => v.playerId)
      ));
    }
    case 'cancellation': {
      const ids = new Set<string>();
      for (const v of poll.votes) ids.add(v.playerId);
      return Array.from(ids);
    }
    // vote_change recipients are resolved server-side via
    // get_poll_change_recipients (admins/owners/super-admins ∪ subscribers),
    // not from the local player roster — so this branch is unreachable
    // through the dispatch path but kept here for type-exhaustiveness.
    case 'vote_change':
      return [];
  }
}

function playerNamesForIds(playerIds: string[]): string[] {
  const players = getAllPlayers();
  const map = new Map(players.map(p => [p.id, p.name]));
  const names: string[] = [];
  for (const id of playerIds) {
    const name = map.get(id);
    if (name) names.push(name);
  }
  return names;
}

// Build message bodies
function buildInvitationBody(_poll: GamePoll, dates: GamePollDate[]): { title: string; body: string } {
  const dateLines = dates.map(d => `• ${formatHebrewDateTime(d)}${d.location ? ` — ${d.location}` : ''}`).join('\n');
  return {
    title: '🃏 ערב פוקר חדש — הצביעו!',
    body: `הוצעו ${dates.length} תאריכים:\n${dateLines}\n\nהיכנסו לאפליקציה והצביעו 📅`,
  };
}

function buildConfirmedBody(poll: GamePoll, confirmedDate: GamePollDate, playerNames: string[]): { title: string; body: string } {
  const loc = confirmedDate.location || poll.defaultLocation;
  return {
    title: '✅ המשחק נסגר!',
    body: `${formatHebrewDateTime(confirmedDate)}${loc ? ` — ${loc}` : ''}\nשחקנים שאישרו: ${playerNames.join(', ')}`,
  };
}

function buildExpandedBody(_poll: GamePoll, dates: GamePollDate[]): { title: string; body: string } {
  const dateLines = dates.map(d => `• ${formatHebrewDateTime(d)}`).join('\n');
  return {
    title: '🎯 הוזמנתם להצביע',
    body: `התאריכים שעדיין פתוחים:\n${dateLines}\n\nהקבוצה זקוקה לעוד שחקנים — היכנסו והצביעו 📅`,
  };
}

function buildCancellationBody(poll: GamePoll): { title: string; body: string } {
  const reason = poll.cancellationReason ? `\nסיבה: ${poll.cancellationReason}` : '';
  return {
    title: '❌ ההצבעה בוטלה',
    body: `הצבעת ערב הפוקר בוטלה.${reason}`,
  };
}

// Fan out push + email to a list of player names (idempotent for the caller).
async function dispatch(poll: GamePoll, kind: NotificationKind, title: string, body: string, playerNames: string[]): Promise<void> {
  if (playerNames.length === 0) {
    console.log(`[schedule-notify/${kind}] no recipients, skipping`);
    return;
  }

  // Both channels are independently gated by group settings.
  // WhatsApp share buttons + in-app banners always work regardless.
  const settings = getSettings();
  const pushEnabled = settings.schedulePushEnabled !== false; // default true if undefined
  const emailsEnabled = settings.scheduleEmailsEnabled === true;

  // Push: one call with targetPlayerNames (server filters subscriptions by name).
  if (pushEnabled) {
    const url = deepLinkUrl(poll.id);
    await proxySendPush({
      groupId: poll.groupId,
      title,
      body,
      targetPlayerNames: playerNames,
      url,
    });
  } else {
    console.log(`[schedule-notify/${kind}] push disabled by group setting`);
  }

  if (!emailsEnabled) {
    console.log(`[schedule-notify/${kind}] emails disabled by group setting, skipping ${playerNames.length} recipients`);
    return;
  }
  const senderName = 'Poker Manager';
  // Append a clickable deep link to the email body. The push channel
  // already carries a `url`, but the email body was previously
  // text-only — recipients had to remember to open the app manually.
  // EmailJS broadcast template renders `message` and most clients
  // auto-linkify bare URLs, so a plain "label: <url>" line is enough.
  const link = emailVoteLink(poll);
  const linkLabel = kind === 'creation' || kind === 'expanded'
    ? 'להצבעה'
    : 'לפרטים';
  const emailBody = link ? `${body}\n\n${linkLabel}: ${link}` : body;
  await Promise.allSettled(playerNames.map(async (name) => {
    try {
      const info = await getPlayerEmailForNotification(poll.groupId, name);
      if (!info?.email) {
        return;
      }
      const ok = await proxySendBroadcastEmail({
        to: info.email,
        subject: title,
        message: emailBody,
        senderName,
      });
      if (!ok) console.warn(`[schedule-notify/${kind}] email failed for ${name}`);
    } catch (err) {
      console.warn(`[schedule-notify/${kind}] email error for ${name}:`, err);
    }
  }));
}

// ── Public API ──

export async function sendInvitationToPermanentMembers(poll: GamePoll): Promise<void> {
  const claimed = await claimPollNotifications(poll.id, 'creation');
  if (!claimed) return;
  const recipientIds = resolveRecipientPlayerIds(poll, 'creation');
  const names = playerNamesForIds(recipientIds);
  const { title, body } = buildInvitationBody(poll, poll.dates);
  await dispatch(poll, 'creation', title, body, names);
}

export async function sendConfirmedNotifications(poll: GamePoll): Promise<void> {
  if (!poll.confirmedDateId) return;
  const claimed = await claimPollNotifications(poll.id, 'confirmed');
  if (!claimed) return;
  const recipientIds = resolveRecipientPlayerIds(poll, 'confirmed');
  const names = playerNamesForIds(recipientIds);
  const confirmedDate = poll.dates.find(d => d.id === poll.confirmedDateId);
  if (!confirmedDate) return;
  const { title, body } = buildConfirmedBody(poll, confirmedDate, names);
  await dispatch(poll, 'confirmed', title, body, names);
}

export async function sendExpandedInvitations(poll: GamePoll): Promise<void> {
  const claimed = await claimPollNotifications(poll.id, 'expanded');
  if (!claimed) return;
  const recipientIds = resolveRecipientPlayerIds(poll, 'expanded');
  const names = playerNamesForIds(recipientIds);
  const { title, body } = buildExpandedBody(poll, poll.dates);
  await dispatch(poll, 'expanded', title, body, names);
}

export async function sendCancellationNotifications(poll: GamePoll): Promise<void> {
  const claimed = await claimPollNotifications(poll.id, 'cancellation');
  if (!claimed) return;
  const recipientIds = resolveRecipientPlayerIds(poll, 'cancellation');
  const names = playerNamesForIds(recipientIds);
  const { title, body } = buildCancellationBody(poll);
  await dispatch(poll, 'cancellation', title, body, names);
}

// ── Vote-event notifications ──
// Fires every time a vote row is created (initial cast) OR updated
// (response/comment changed). Recipients are resolved server-side via
// get_poll_change_recipients: admins, owners, super-admins, plus members
// who opted in via the subscription button. Each recipient may also have
// muted via the per-group schedule_vote_change_notifs flag — that filter
// runs in the RPC, so we don't repeat it here.
//
// NOT claim-gated: each vote event is its own discrete signal. If the same
// client fires twice for the same event, the recipient list resolution is
// idempotent and the worst case is a duplicate ping — far better than
// missing a real cast/change.

const RESPONSE_LABEL: Record<RsvpResponse, string> = {
  yes: 'אישר',
  maybe: 'יעדכן',
  no: 'סירב',
};

function buildVoteEventBody(
  poll: GamePoll,
  vote: GamePollVote,
  voterName: string,
  changedByName: string | null,
  isNewVote: boolean,
): { title: string; body: string } {
  const date = poll.dates.find(d => d.id === vote.dateId);
  const dateLine = date ? formatHebrewDateTime(date) : '';
  const responseLabel = RESPONSE_LABEL[vote.response] ?? vote.response;
  const proxyTag = changedByName && changedByName !== voterName
    ? ` (ע״י ${changedByName})`
    : '';
  // Distinct title so the lock-screen preview tells subscribers
  // immediately whether this is fresh activity or a flip — the body
  // ("ליאור אישר לתאריך…") reads identically for both cases.
  const title = isNewVote ? '🗳️ הצבעה חדשה' : '🔄 הצבעה עודכנה';
  return {
    title,
    body: `${voterName}${proxyTag} ${responseLabel} לתאריך ${dateLine}`.trim(),
  };
}

export async function sendVoteChangeNotifications(
  poll: GamePoll,
  vote: GamePollVote,
  voterName: string,
  changedByName: string | null,
  options?: { isNewVote?: boolean },
): Promise<void> {
  let recipients: { playerName: string }[] = [];
  try {
    recipients = await getPollChangeRecipients(poll.id);
  } catch (err) {
    console.warn('[schedule-notify/vote_change] recipient lookup failed:', err);
    return;
  }
  // Don't notify the actor about their own action. The actor is whoever
  // physically clicked — for self-votes that's the voter, for admin proxy
  // edits that's the admin (changedByName). Filtering them out avoids
  // pinging the user who just clicked the button.
  const actorName = changedByName ?? voterName;
  const names = recipients
    .map(r => r.playerName)
    .filter(name => name !== actorName);
  if (names.length === 0) return;
  const { title, body } = buildVoteEventBody(
    poll, vote, voterName, changedByName, options?.isNewVote ?? false,
  );
  await dispatch(poll, 'vote_change', title, body, names);
}

// ── Lazy sweep: called from ScheduleTab on mount and after each realtime tick ──

export async function runSchedulerSweep(): Promise<void> {
  const polls = getAllPolls();
  const now = Date.now();

  for (const poll of polls) {
    // 1. Recover from failed creation broadcast (any group member can trigger)
    if (poll.status === 'open' && !poll.creationNotificationsSentAt) {
      sendInvitationToPermanentMembers(poll).catch(err =>
        console.warn('runSchedulerSweep/creation', err));
    }

    // 2. Lazy expansion: if 48h elapsed and still open, try to expand
    if (poll.status === 'open' && poll.creationNotificationsSentAt) {
      const created = new Date(poll.createdAt).getTime();
      const delayMs = poll.expansionDelayHours * 60 * 60 * 1000;
      if (now - created >= delayMs) {
        // Lazy import to avoid a circular dep on storage in this file's static graph
        import('../database/storage').then(m => m.expandPoll(poll.id))
          .catch(err => console.warn('runSchedulerSweep/expand', err));
      }
    }

    // 3. Expanded notifications recovery
    if (poll.status === 'expanded' && !poll.expandedNotificationsSentAt) {
      sendExpandedInvitations(poll).catch(err =>
        console.warn('runSchedulerSweep/expanded', err));
    }

    // 4. Confirmed notifications recovery
    if (poll.status === 'confirmed' && !poll.confirmedNotificationsSentAt) {
      sendConfirmedNotifications(poll).catch(err =>
        console.warn('runSchedulerSweep/confirmed', err));
    }

    // 5. Cancellation notifications recovery
    if (poll.status === 'cancelled' && !poll.cancellationNotificationsSentAt) {
      sendCancellationNotifications(poll).catch(err =>
        console.warn('runSchedulerSweep/cancellation', err));
    }
  }
}

