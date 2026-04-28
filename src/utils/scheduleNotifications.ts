// Schedule notifications: push + email fan-out for poll lifecycle events.
// All helpers are claim-gated via claim_poll_notifications so multiple online
// clients can race to send and exactly one wins.

import type { GamePoll, GamePollDate } from '../types';
import {
  getAllPlayers, getAllPolls, claimPollNotifications,
  getPlayerEmailForNotification, getSettings,
} from '../database/storage';
import { proxySendPush, proxySendBroadcastEmail } from './apiProxy';

type NotificationKind = 'creation' | 'expanded' | 'confirmed' | 'cancellation';

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
    body: `${formatHebrewDateTime(confirmedDate)}${loc ? ` — ${loc}` : ''}\nשחקנים מאושרים: ${playerNames.join(', ')}`,
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
  await Promise.allSettled(playerNames.map(async (name) => {
    try {
      const info = await getPlayerEmailForNotification(poll.groupId, name);
      if (!info?.email) {
        return;
      }
      const ok = await proxySendBroadcastEmail({
        to: info.email,
        subject: title,
        message: body,
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

