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
  | 'creation' | 'expanded' | 'confirmed' | 'cancellation' | 'vote_change'
  | 'reminder';

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
    // Reminder recipients are computed in the UI (per-poll non-voter
    // list) and passed to sendReminderNotifications directly. This
    // branch is unreachable but kept for exhaustiveness.
    case 'reminder':
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
  // RTL strategy: prepend U+200F (RLM, Right-to-Left Mark) to force the
  // paragraph's bidi direction to RTL. The RLM is invisible and zero-
  // width, but as the first strong directional character it tells the
  // email client's Unicode bidi algorithm to resolve the whole message
  // as RTL — regardless of whether the first VISIBLE character is
  // Hebrew (most messages), a player name that might be in English
  // (vote_change body), an emoji, or a digit. Without this hint, an
  // English-named voter triggering a vote_change could end up rendered
  // LTR in some clients. The marker is part of standard Unicode bidi
  // and works in plain text — no HTML, no template change required.
  const rawEmailBody = link ? `${body}\n\n${linkLabel}: ${link}` : body;
  const emailBody = `\u200F${rawEmailBody}`;
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

// ── Reminder (manual, admin-triggered) ──
// Sends a "please make sure you've voted" ping to a caller-supplied list
// of player names. NOT claim-gated — reminder is an explicit admin action
// that can be re-issued (e.g. day before the game). Recipients are
// computed in the UI against the live poll, since the picker needs the
// list to render its checkboxes too.
//
// Recipients can fall into TWO categories:
//   * Ghosts — registered members who have zero vote rows on this poll
//   * Partial — voted on at least one date but is silent on at least
//               one other date (silence is itself a missing answer)
//
// Push and email use DIFFERENT bodies (unlike the other lifecycle events
// where the dispatch helper sends the same body to both):
//   * Push stays short and neutral — works for both ghosts and partials
//     without claiming "you haven't voted" (which would be a lie for
//     partial voters).
//   * Email is richer: shows the live per-date count so the recipient
//     can see what the rest of the group is leaning toward, plus a
//     wording that explicitly calls out both cases.

const TITLE_REMINDER = '📣 תזכורת להצבעה';

function buildReminderPush(poll: GamePoll, dates: GamePollDate[]): { title: string; body: string } {
  const dateLines = dates
    .map(d => `• ${formatHebrewDateTime(d)}${d.location ? ` — ${d.location}` : ''}`)
    .join('\n');
  return {
    title: TITLE_REMINDER,
    body: `יעד: ${poll.targetPlayerCount} שחקנים. תאריכים פתוחים:\n${dateLines}\n\nהיכנסו והשלימו את ההצבעה 📅`,
  };
}

// Hebrew remaining-time formatter. Mirrors the wording style of the in-
// app PollTimer banner ("3 ימים 8 שע׳") so the email reads consistently
// with what the recipient sees on the poll card. Email bodies are
// Hebrew-only (group communication is Hebrew-first), so we don't route
// this through i18n — the inline literals match the values of the
// `schedule.timer.fmt*` Hebrew keys.
function formatReminderRemainingHebrew(ms: number): string {
  if (ms <= 60_000) return 'פחות מדקה';
  const totalMin = Math.floor(ms / 60_000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin - days * 60 * 24) / 60);
  const minutes = totalMin - days * 60 * 24 - hours * 60;
  if (days >= 1) {
    return hours > 0 ? `${days} ימים ${hours} שע׳` : `${days} ימים`;
  }
  if (hours >= 1) {
    return minutes > 0 ? `${hours} שע׳ ${minutes} דק׳` : `${hours} שע׳`;
  }
  return `${minutes} דק׳`;
}

// Phase-aware deadline line. Uses the same source of truth as the in-app
// PollTimer (`createdAt + expansionDelayHours` for `open`, soonest
// upcoming proposed date for `expanded`). Returns null if there's no
// meaningful countdown to surface (already past the deadline, or the
// poll is in a phase the reminder doesn't apply to). The phrasing is
// phase-specific so an "open" poll doesn't lie about closing — it
// expands, it doesn't close.
function buildReminderDeadlineLine(poll: GamePoll): string | null {
  const now = Date.now();
  if (poll.status === 'open') {
    const start = new Date(poll.createdAt).getTime();
    const end = start + poll.expansionDelayHours * 3600_000;
    const remaining = end - now;
    if (remaining <= 0) return null;
    return `⏳ ההצבעה תיפתח לכולם בעוד ${formatReminderRemainingHebrew(remaining)}`;
  }
  if (poll.status === 'expanded') {
    const stamps = poll.dates
      .map(d => {
        const time = d.proposedTime || '21:00';
        const ts = new Date(`${d.proposedDate}T${time}`).getTime();
        return Number.isFinite(ts) ? ts : 0;
      })
      .filter(ts => ts > 0);
    const upcoming = stamps.find(ts => ts > now);
    if (!upcoming) return null;
    return `⏳ ההצבעה נסגרת בעוד ${formatReminderRemainingHebrew(upcoming - now)}`;
  }
  return null;
}

// Per-date current state. We render every response bucket (yes / maybe /
// no) so the recipient can see the live trend at a glance — important
// context when they're deciding whether to commit. `maybe` is conditional
// on poll.allowMaybe (some groups disable it). Lines start with the date
// (which is a Hebrew weekday name produced by formatHebrewDateTime), so
// each line's first strong directional character is RTL — bidi resolves
// the whole line as RTL automatically. Counters inside the line are
// numeric and render correctly within the RTL context.
//
// `recipientName` (when provided) gets a personal Hebrew greeting at the
// top — turns the email from a faceless broadcast into a personal nudge
// without changing any of the live state below.
function buildReminderEmailBody(poll: GamePoll, recipientName?: string): string {
  const target = poll.targetPlayerCount;
  const stateLines = poll.dates.map(d => {
    let yes = 0, maybe = 0, no = 0;
    for (const v of poll.votes) {
      if (v.dateId !== d.id) continue;
      if (v.response === 'yes') yes++;
      else if (v.response === 'maybe') maybe++;
      else if (v.response === 'no') no++;
    }
    const loc = d.location ? ` — ${d.location}` : '';
    const tally: string[] = [`✅ ${yes}/${target}`];
    if (poll.allowMaybe && maybe > 0) tally.push(`🤔 ${maybe}`);
    if (no > 0) tally.push(`❌ ${no}`);
    return `• ${formatHebrewDateTime(d)}${loc}\n  ${tally.join(' · ')}`;
  }).join('\n\n');

  // Generic disclaimer covering BOTH cases. The wording deliberately
  // doesn't claim "you haven't voted" — it asks the recipient to verify,
  // which reads correctly whether they're a ghost or a partial voter.
  const greeting = recipientName ? `היי ${recipientName},\n\n` : '';
  const intro = 'זו תזכורת להצבעה על המשחק הבא. אם עוד לא הצבעת, או שהצבעת רק על חלק מהתאריכים — בבקשה היכנסו והשלימו את ההצבעה.';
  const deadlineLine = buildReminderDeadlineLine(poll);
  const deadlineBlock = deadlineLine ? `\n\n${deadlineLine}` : '';
  const stateHeader = '📊 מצב ההצבעה כרגע:';

  return `${greeting}${intro}${deadlineBlock}\n\n${stateHeader}\n${stateLines}`;
}

export async function sendReminderNotifications(
  poll: GamePoll,
  recipientNames: string[],
): Promise<void> {
  if (recipientNames.length === 0) return;

  const settings = getSettings();
  const pushEnabled = settings.schedulePushEnabled !== false; // default true
  const emailsEnabled = settings.scheduleEmailsEnabled === true;

  // ── Push ──
  if (pushEnabled) {
    const { title, body } = buildReminderPush(poll, poll.dates);
    try {
      await proxySendPush({
        groupId: poll.groupId,
        title,
        body,
        targetPlayerNames: recipientNames,
        url: deepLinkUrl(poll.id),
      });
    } catch (err) {
      console.warn('[schedule-notify/reminder] push failed:', err);
    }
  } else {
    console.log('[schedule-notify/reminder] push disabled by group setting');
  }

  // ── Email ──
  if (!emailsEnabled) {
    console.log(`[schedule-notify/reminder] emails disabled by group setting, skipping ${recipientNames.length} recipients`);
    return;
  }
  const link = emailVoteLink(poll);
  // Trailing CTA + link line. Hebrew-first label keeps the bidi direction
  // RTL (the URL inside an RTL paragraph correctly renders LTR within an
  // RTL context — i.e. URL on the left, label on the right, which is the
  // expected Hebrew-email layout). Computed once outside the loop because
  // it doesn't vary per recipient.
  const cta = link ? `\n\n👉 להצבעה ולפרטים נוספים: ${link}` : '';

  await Promise.allSettled(recipientNames.map(async (name) => {
    try {
      const info = await getPlayerEmailForNotification(poll.groupId, name);
      if (!info?.email) return;
      // Per-recipient body: greeting uses the player's name, everything
      // else (deadline / state / cta) is identical for every recipient.
      const baseBody = buildReminderEmailBody(poll, name);
      const fullBody = `${baseBody}${cta}`;
      // Force RTL paragraph direction with a leading RLM (Right-to-Left
      // Mark, U+200F). It's invisible and zero-width, but as the first
      // strong directional character it tells the email client's Unicode
      // bidi algorithm to resolve the whole paragraph as RTL — even in
      // clients that would otherwise default to LTR. Critical for emails
      // whose first visible character could be punctuation, an emoji,
      // or a digit.
      const rtlBody = `\u200F${fullBody}`;
      const ok = await proxySendBroadcastEmail({
        to: info.email,
        subject: TITLE_REMINDER,
        message: rtlBody,
        senderName: 'Poker Manager',
      });
      if (!ok) console.warn(`[schedule-notify/reminder] email failed for ${name}`);
    } catch (err) {
      console.warn(`[schedule-notify/reminder] email error for ${name}:`, err);
    }
  }));
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

