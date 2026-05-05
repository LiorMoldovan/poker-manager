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
  | 'reminder' | 'target_filled';

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
    // target_filled mirrors the at-target 'confirmed' audience —
    // yes-voters on the pinned date. Resolved inline by the sender so
    // we can short-circuit when there's no confirmed_date_id yet.
    case 'target_filled':
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

// ── Message builders ──
//
// Each lifecycle event produces a `BuiltMessage` with two distinct
// payloads:
//   * pushTitle / pushBody — short notification rendered on the lock
//     screen. iOS truncates around ~110 chars; we stay well under.
//   * emailSubject / emailBody(name) — long-form, personalized email.
//     The lambda receives the recipient's display name so each email
//     opens with "היי {name}," without us fanning the data through
//     dispatch().
// Both payloads tell the same story at different fidelities — the email
// never contradicts the push. Hebrew throughout (group communication is
// Hebrew-first); English isn't routed through i18n here on purpose to
// keep the build helpers literal-readable and easy to tweak.

export type BuiltMessage = {
  pushTitle: string;
  pushBody: string;
  emailSubject: string;
  emailBody: (recipientName: string) => string;
};

function emailGreeting(name: string): string {
  return name ? `היי ${name},\n\n` : '';
}

// Trailing CTA + clickable link. The push channel already carries a
// relative deep link in its payload, so the email needs the absolute URL
// (most email clients auto-linkify bare URLs).
function emailCtaBlock(poll: GamePoll, label: string): string {
  const link = emailVoteLink(poll);
  return link ? `\n\n👉 ${label}: ${link}` : '';
}

function formatDateBullet(d: GamePollDate, defaultLoc?: string | null): string {
  const loc = d.location || defaultLoc;
  return `• ${formatHebrewDateTime(d)}${loc ? ` — ${loc}` : ''}`;
}

export function buildInvitationMessage(poll: GamePoll): BuiltMessage {
  const dateLines = poll.dates
    .map(d => formatDateBullet(d, poll.defaultLocation))
    .join('\n');
  const deadline = buildReminderDeadlineLine(poll);
  const subject = '🃏 ערב פוקר חדש — הצביעו!';
  return {
    pushTitle: subject,
    pushBody: `הוצעו ${poll.dates.length} תאריכים. היכנסו והצביעו 📅`,
    emailSubject: subject,
    emailBody: (name) =>
      emailGreeting(name) +
      'נפתחה הצבעה לערב פוקר חדש 🃏\n\n' +
      `📅 התאריכים המוצעים:\n${dateLines}\n\n` +
      `🎯 יעד: ${poll.targetPlayerCount} שחקנים` +
      (deadline ? `\n${deadline}` : '') +
      emailCtaBlock(poll, 'להצבעה'),
  };
}

export function buildExpandedMessage(poll: GamePoll): BuiltMessage {
  const dateLines = poll.dates
    .map(d => formatDateBullet(d, poll.defaultLocation))
    .join('\n');
  const deadline = buildReminderDeadlineLine(poll);
  return {
    pushTitle: '🎯 ההצבעה פתוחה לכולם',
    pushBody: 'הקבוצה צריכה עוד שחקנים — היכנסו והצביעו 📅',
    emailSubject: '🎯 ההצבעה פתוחה — הצטרפו',
    emailBody: (name) =>
      emailGreeting(name) +
      'הקבוצה צריכה עוד שחקנים! ההצבעה לערב הפוקר עברה לשלב פתוח לכולם.\n\n' +
      `📅 התאריכים הפתוחים:\n${dateLines}\n\n` +
      `🎯 יעד: ${poll.targetPlayerCount} שחקנים` +
      (deadline ? `\n${deadline}` : '') +
      emailCtaBlock(poll, 'להצבעה'),
  };
}

export function buildConfirmedMessage(
  poll: GamePoll,
  confirmedDate: GamePollDate,
  yesNames: string[],
): BuiltMessage {
  const loc = confirmedDate.location || poll.defaultLocation;
  const dateLine = formatHebrewDateTime(confirmedDate);
  const locLine = loc ? `📍 ${loc}\n` : '';
  return {
    pushTitle: '✅ המשחק נסגר!',
    pushBody: `${dateLine}${loc ? ` — ${loc}` : ''}`,
    emailSubject: '✅ נסגר! ניפגש בערב פוקר 🃏',
    emailBody: (name) =>
      emailGreeting(name) +
      'הצבעת ערב הפוקר נסגרה — ניפגש 🎉\n\n' +
      `📅 ${dateLine}\n` +
      locLine +
      `👥 ${yesNames.length} שחקנים מאושרים: ${yesNames.join(', ')}` +
      emailCtaBlock(poll, 'לפרטים') +
      '\n\nנתראה על השולחן! 🃏',
  };
}

// Final "we're complete" announcement — fires when a confirmed-below-
// target poll reaches its seat target via additional yes-votes. Audience
// is the same as the original at-target confirmed message (yes-voters
// on the pinned date), but the copy explicitly acknowledges the wait
// just resolved instead of announcing the lock-in itself.
export function buildTargetFilledMessage(
  poll: GamePoll,
  confirmedDate: GamePollDate,
  yesNames: string[],
): BuiltMessage {
  const loc = confirmedDate.location || poll.defaultLocation;
  const dateLine = formatHebrewDateTime(confirmedDate);
  const locLine = loc ? `📍 ${loc}\n` : '';
  return {
    pushTitle: '🎉 המשחק מלא — ניפגש!',
    pushBody: `${dateLine}${loc ? ` — ${loc}` : ''}`,
    emailSubject: '🎉 המשחק מלא — ניפגש בערב פוקר 🃏',
    emailBody: (name) =>
      emailGreeting(name) +
      'נסגרה השורה — המשחק מלא 🎉\n\n' +
      `📅 ${dateLine}\n` +
      locLine +
      `👥 ${yesNames.length} שחקנים מאושרים: ${yesNames.join(', ')}` +
      emailCtaBlock(poll, 'לפרטים') +
      '\n\nנתראה על השולחן! 🃏',
  };
}

// ── Confirmed-below-target ──
// Two audiences when an admin pins a date before the seat target was hit:
//   * "yes" audience   — players already RSVP'd yes on the pinned date.
//     Tone: "you're locked in, help us recruit the rest."
//   * "others" audience — everyone else who's relevant (eligible permanents
//     + permanent_guest/guest if expanded + anyone who already voted on
//     a different date/response). Tone: "we picked this date, voting is
//     now limited to it, please confirm attendance."
// Both bodies surface the live missing count — that's the whole point of
// the ping. The count is a snapshot at send time, which is fine because
// the urgency it conveys is what we're trying to communicate.

export function buildConfirmedBelowTargetYesMessage(
  poll: GamePoll,
  confirmedDate: GamePollDate,
  yesCount: number,
  missing: number,
): BuiltMessage {
  const loc = confirmedDate.location || poll.defaultLocation;
  const dateLine = formatHebrewDateTime(confirmedDate);
  const locLine = loc ? `📍 ${loc}\n` : '';
  const missingPhrase = missing === 1
    ? 'שחקן אחרון וסוגרים!'
    : `חסרים עוד ${missing} שחקנים`;
  const subject = '✅ התאריך נבחר — אתם בפנים';
  return {
    pushTitle: subject,
    pushBody: `${dateLine}${loc ? ` — ${loc}` : ''} · ${missingPhrase}`,
    emailSubject: subject,
    emailBody: (name) =>
      emailGreeting(name) +
      'נבחר תאריך לערב הפוקר 🎯\nאתם רשומים, אבל עוד חסרים שחקנים כדי לסגור.\n\n' +
      `📅 ${dateLine}\n` +
      locLine +
      `👥 ${yesCount}/${poll.targetPlayerCount} מאושרים — ${missingPhrase}\n\n` +
      'אם מכירים מישהו שיכול להצטרף, תפיצו את הלינק 🤝' +
      emailCtaBlock(poll, 'לפרטים'),
  };
}

export function buildConfirmedBelowTargetOthersMessage(
  poll: GamePoll,
  confirmedDate: GamePollDate,
  yesCount: number,
  missing: number,
): BuiltMessage {
  const loc = confirmedDate.location || poll.defaultLocation;
  const dateLine = formatHebrewDateTime(confirmedDate);
  const locLine = loc ? `📍 ${loc}\n` : '';
  const seatsPhrase = missing === 1
    ? 'נשאר מקום אחד פנוי'
    : `נשארו ${missing} מקומות פנויים`;
  return {
    pushTitle: '🪑 חסרים שחקנים למשחק',
    pushBody: `${dateLine}${loc ? ` — ${loc}` : ''} · ${seatsPhrase}`,
    emailSubject: '🪑 נקבע תאריך — נשארו מקומות פנויים',
    emailBody: (name) =>
      emailGreeting(name) +
      'נקבע תאריך לערב הפוקר! עוד יש מקומות פנויים — אם זה מתאים לכם, אנחנו רוצים אתכם בפנים 🤝\n\n' +
      `📅 ${dateLine}\n` +
      locLine +
      `👥 ${yesCount}/${poll.targetPlayerCount} מאושרים — ${seatsPhrase}\n\n` +
      'ההצבעה כעת רק על התאריך הזה.' +
      emailCtaBlock(poll, 'לאישור הגעה'),
  };
}

// Resolves the "everyone else" audience for the confirmed-below-target
// case. We want to nudge anyone who could fill the missing seats:
//   * Eligible permanent players (always eligible per canVote).
//   * permanent_guest / guest players IF the poll already expanded.
//   * Anyone who already cast any vote on the poll (any tier, any
//     response) — they're clearly engaged with this round.
// Then subtract the "yes on pinned date" set so each player ends up in
// exactly one audience.
function resolveConfirmedBelowTargetOthers(
  poll: GamePoll,
  yesOnPinned: Set<string>,
): string[] {
  const players = getAllPlayers();
  const expandedReached = !!poll.expandedAt;
  const ids = new Set<string>();
  for (const p of players) {
    if (p.type === 'permanent') ids.add(p.id);
    else if (expandedReached && (p.type === 'permanent_guest' || p.type === 'guest')) ids.add(p.id);
  }
  for (const v of poll.votes) ids.add(v.playerId);
  for (const id of yesOnPinned) ids.delete(id);
  return Array.from(ids);
}

export function buildCancellationMessage(poll: GamePoll): BuiltMessage {
  const reasonLine = poll.cancellationReason
    ? `\n💬 הסיבה: ${poll.cancellationReason}`
    : '';
  return {
    pushTitle: '❌ ערב הפוקר בוטל',
    pushBody: poll.cancellationReason
      ? `הסיבה: ${poll.cancellationReason}`
      : 'נתראה בפעם הבאה 🃏',
    emailSubject: '❌ ערב הפוקר בוטל',
    emailBody: (name) =>
      emailGreeting(name) +
      'ערב הפוקר בוטל לפעם הזו 😔' +
      reasonLine +
      '\n\nנתראה בפעם הבאה! 🃏',
  };
}

// Fan out push + email. Push uses the shared body for the whole group
// (one API call, server filters subscriptions by name). Email is built
// per-recipient so we can inject a personal greeting. Both channels are
// independently gated by group settings — the WhatsApp share buttons +
// in-app banners always work regardless.
async function dispatch(
  poll: GamePoll,
  kind: NotificationKind,
  msg: BuiltMessage,
  recipientNames: string[],
): Promise<void> {
  if (recipientNames.length === 0) {
    console.log(`[schedule-notify/${kind}] no recipients, skipping`);
    return;
  }

  const settings = getSettings();
  const pushEnabled = settings.schedulePushEnabled !== false;
  const emailsEnabled = settings.scheduleEmailsEnabled === true;

  if (pushEnabled) {
    try {
      await proxySendPush({
        groupId: poll.groupId,
        title: msg.pushTitle,
        body: msg.pushBody,
        targetPlayerNames: recipientNames,
        url: deepLinkUrl(poll.id),
      });
    } catch (err) {
      console.warn(`[schedule-notify/${kind}] push failed:`, err);
    }
  } else {
    console.log(`[schedule-notify/${kind}] push disabled by group setting`);
  }

  if (!emailsEnabled) {
    console.log(`[schedule-notify/${kind}] emails disabled by group setting, skipping ${recipientNames.length} recipients`);
    return;
  }

  await Promise.allSettled(recipientNames.map(async (name) => {
    try {
      const info = await getPlayerEmailForNotification(poll.groupId, name);
      if (!info?.email) return;
      // Force RTL paragraph direction with a leading RLM (U+200F). The
      // marker is invisible and zero-width but, as the first strong
      // directional character, tells the email client's bidi algorithm
      // to resolve the whole message as RTL — even when the first
      // VISIBLE character is an emoji, digit, or English name.
      const rtlBody = `\u200F${msg.emailBody(name)}`;
      const ok = await proxySendBroadcastEmail({
        to: info.email,
        subject: msg.emailSubject,
        message: rtlBody,
        senderName: 'Poker Manager',
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
  await dispatch(poll, 'creation', buildInvitationMessage(poll), names);
}

export async function sendConfirmedNotifications(poll: GamePoll): Promise<void> {
  if (!poll.confirmedDateId) return;
  const claimed = await claimPollNotifications(poll.id, 'confirmed');
  if (!claimed) return;
  const confirmedDate = poll.dates.find(d => d.id === poll.confirmedDateId);
  if (!confirmedDate) return;

  // Pinned-date yes-voters are always one of the two audiences. Computing
  // the set up front (instead of via resolveRecipientPlayerIds) lets us
  // cheaply derive the count, the missing gap, and the "others" audience
  // off the same source of truth.
  const yesOnPinnedSet = new Set(
    poll.votes
      .filter(v => v.dateId === poll.confirmedDateId && v.response === 'yes')
      .map(v => v.playerId)
  );
  const yesNames = playerNamesForIds(Array.from(yesOnPinnedSet));
  const yesCount = yesOnPinnedSet.size;
  const missing = Math.max(0, poll.targetPlayerCount - yesCount);

  if (missing === 0) {
    // Seat target reached at the same moment as the confirmed transition
    // — single "ניפגש בערב פוקר" flow to yes-voters. We preemptively
    // burn the `target_filled` claim too so the post-pin "המשחק מלא"
    // follow-up can't double-fire on top of "המשחק נסגר!" — they'd be
    // saying the same thing one after the other.
    await Promise.allSettled([
      dispatch(
        poll,
        'confirmed',
        buildConfirmedMessage(poll, confirmedDate, yesNames),
        yesNames,
      ),
      claimPollNotifications(poll.id, 'target_filled'),
    ]);
    return;
  }

  // Below target: split the audience and tailor the copy. Both dispatches
  // share the same `kind` ("confirmed") so they're treated as a single
  // logical event by the dispatcher's logging — the claim was already
  // burned at function entry, so racing senders won't double-send.
  const otherIds = resolveConfirmedBelowTargetOthers(poll, yesOnPinnedSet);
  const otherNames = playerNamesForIds(otherIds);

  await Promise.allSettled([
    dispatch(
      poll,
      'confirmed',
      buildConfirmedBelowTargetYesMessage(poll, confirmedDate, yesCount, missing),
      yesNames,
    ),
    dispatch(
      poll,
      'confirmed',
      buildConfirmedBelowTargetOthersMessage(poll, confirmedDate, yesCount, missing),
      otherNames,
    ),
  ]);
}

export async function sendExpandedInvitations(poll: GamePoll): Promise<void> {
  const claimed = await claimPollNotifications(poll.id, 'expanded');
  if (!claimed) return;
  const recipientIds = resolveRecipientPlayerIds(poll, 'expanded');
  const names = playerNamesForIds(recipientIds);
  await dispatch(poll, 'expanded', buildExpandedMessage(poll), names);
}

export async function sendCancellationNotifications(poll: GamePoll): Promise<void> {
  const claimed = await claimPollNotifications(poll.id, 'cancellation');
  if (!claimed) return;
  const recipientIds = resolveRecipientPlayerIds(poll, 'cancellation');
  const names = playerNamesForIds(recipientIds);
  await dispatch(poll, 'cancellation', buildCancellationMessage(poll), names);
}

// Fires when a confirmed-below-target poll reaches its seat target via
// post-pin yes-votes. Yes-voters on the pinned date get a final
// "המשחק מלא — ניפגש!" announcement so they know the wait is over and
// the lineup is locked. Idempotent via the migration-051 claim slot:
// at-target confirmed transitions claim the slot preemptively (see
// sendConfirmedNotifications), so this function no-ops in that path.
// Skipped when:
//   * Poll has no confirmed_date_id (still open / cancelled / expired).
//   * The seat target hasn't actually been reached yet (caller bug).
//   * Claim slot is already burned (already sent, or preemptively
//     claimed by the at-target confirmed flow).
export async function sendTargetFilledNotifications(poll: GamePoll): Promise<void> {
  if (poll.status !== 'confirmed' || !poll.confirmedDateId) return;
  const yesPlayerIds = Array.from(new Set(
    poll.votes
      .filter(v => v.dateId === poll.confirmedDateId && v.response === 'yes')
      .map(v => v.playerId)
  ));
  if (yesPlayerIds.length < poll.targetPlayerCount) return;
  const claimed = await claimPollNotifications(poll.id, 'target_filled');
  if (!claimed) return;
  const confirmedDate = poll.dates.find(d => d.id === poll.confirmedDateId);
  if (!confirmedDate) return;
  const yesNames = playerNamesForIds(yesPlayerIds);
  await dispatch(
    poll,
    'target_filled',
    buildTargetFilledMessage(poll, confirmedDate, yesNames),
    yesNames,
  );
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

export function buildVoteEventMessage(
  poll: GamePoll,
  vote: GamePollVote,
  voterName: string,
  changedByName: string | null,
  isNewVote: boolean,
): BuiltMessage {
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
  const summary = `${voterName}${proxyTag} ${responseLabel} לתאריך ${dateLine}`.trim();
  // Live yes count for that date — gives the subscriber the seat-fill
  // status without making them open the app. `poll.votes` is the post-
  // write snapshot (caller passes the refreshed poll), so we count
  // directly with no off-by-one.
  const yesCount = poll.votes.filter(
    v => v.dateId === vote.dateId && v.response === 'yes',
  ).length;
  const stateLine = `📊 ${yesCount}/${poll.targetPlayerCount} מאושרים לתאריך זה`;
  return {
    pushTitle: title,
    pushBody: summary,
    emailSubject: title,
    emailBody: (name) =>
      emailGreeting(name) +
      `${summary}\n\n${stateLine}` +
      emailCtaBlock(poll, 'לצפייה בהצבעה'),
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
  const msg = buildVoteEventMessage(
    poll, vote, voterName, changedByName, options?.isNewVote ?? false,
  );
  await dispatch(poll, 'vote_change', msg, names);
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

  // Generic disclaimer covering ALL THREE recipient cases the picker
  // pulls in: ghosts (zero votes), partial voters (missing at least
  // one date), and maybe-voters (answered every date but at least one
  // is "אעדכן" — i.e. still not a final answer). The wording asks the
  // recipient to confirm/finalize their answer rather than claiming
  // "you haven't voted", so it reads correctly for any of the three.
  const greeting = recipientName ? `היי ${recipientName},\n\n` : '';
  const intro = 'זו תזכורת להצבעה על המשחק הבא. אם עוד לא הצבעת, הצבעת רק על חלק מהתאריכים, או שסימנת "אעדכן" ועדיין לא נתת תשובה סופית — בבקשה היכנסו והשלימו את ההצבעה.';
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

    // 4b. Target-filled recovery (migration 051) — confirmed poll whose
    //     pinned date has reached the seat target but the post-pin
    //     "המשחק מלא" notification hasn't fired yet. Re-checks every
    //     sweep so a yes-vote that closes the gap eventually triggers
    //     the announcement even if the in-flight client crashed before
    //     dispatching. Claim slot keeps it idempotent.
    if (poll.status === 'confirmed'
        && poll.confirmedDateId
        && !poll.targetFilledNotificationsSentAt) {
      const yesCount = poll.votes.reduce(
        (n, v) => n + (v.dateId === poll.confirmedDateId && v.response === 'yes' ? 1 : 0),
        0,
      );
      if (yesCount >= poll.targetPlayerCount) {
        sendTargetFilledNotifications(poll).catch(err =>
          console.warn('runSchedulerSweep/target_filled', err));
      }
    }

    // 5. Cancellation notifications recovery
    if (poll.status === 'cancelled' && !poll.cancellationNotificationsSentAt) {
      sendCancellationNotifications(poll).catch(err =>
        console.warn('runSchedulerSweep/cancellation', err));
    }
  }
}

