// Schedule notifications: push + email fan-out for poll lifecycle events.
// All helpers are claim-gated via claim_poll_notifications so multiple online
// clients can race to send and exactly one wins.

import type { GamePoll, GamePollDate, GamePollVote, RsvpResponse } from '../types';
import {
  getAllPlayers, getAllPolls, claimPollNotifications,
  getPlayerEmailForNotification, getSettings,
  getPollChangeRecipients,
} from '../database/storage';
import { proxySendPush, proxySendBroadcastEmail, type EmailKind } from './apiProxy';
import { verbForName, getPlayerGender, type VerbKey } from './hebrewGender';

type NotificationKind =
  | 'creation' | 'expanded' | 'confirmed' | 'cancellation' | 'vote_change'
  | 'reminder' | 'target_filled';

// Internal poll-event names don't perfectly match the EmailKind taxonomy
// (which is shared across all email-sending flows in the app). This map
// keeps the email-usage breakdown legible: every poll-driven email shows up
// under one of the schedule-lifecycle kinds in the Settings AI usage card.
function notificationKindToEmailKind(kind: NotificationKind): EmailKind {
  switch (kind) {
    case 'creation':     return 'invitation';
    case 'expanded':     return 'expanded';
    case 'confirmed':    return 'confirmed';
    case 'cancellation': return 'cancelled';
    case 'vote_change':  return 'new_vote';
    case 'reminder':     return 'reminder';
    case 'target_filled':return 'target_filled';
  }
}

// ── Helpers ──

function formatHebrewDateTime(date: GamePollDate): string {
  try {
    const d = new Date(`${date.proposedDate}T${date.proposedTime || '21:00'}`);
    const weekday = d.toLocaleDateString('he-IL', { weekday: 'long' });
    const day = d.getDate();
    const month = d.getMonth() + 1;
    const time = date.proposedTime ? ` ${date.proposedTime.slice(0, 5)}` : '';
    // Date-first ordering: numerical date precedes the weekday name
    // ("7/5 יום חמישי 21:00") so the calendar value catches the
    // reader's eye first — the weekday is contextual colour. Applied
    // everywhere this helper is used (vote events, confirmation
    // emails, multi-date bullet lists, reminders).
    return `${day}/${month} ${weekday}${time}`;
  } catch {
    return date.proposedDate;
  }
}

// Verbose, label-prefixed variant for "main event" confirmation emails
// where the date IS the headline and the email has room to breathe. The
// compact `formatHebrewDateTime` form (`7/5 יום חמישי 21:00`) is still
// used inside multi-date bullet lists where labels would clutter the row.
//
// Output shape: "תאריך 7/5, יום חמישי, שעה 21:00"
//   * "תאריך" + numeric date first, matching the date-first ordering of
//     the compact form.
//   * Weekday name middle for context.
//   * "שעה" + HH:MM last so the time is the final pinpoint.
function formatHebrewDateTimeVerbose(date: GamePollDate): string {
  try {
    const d = new Date(`${date.proposedDate}T${date.proposedTime || '21:00'}`);
    const weekday = d.toLocaleDateString('he-IL', { weekday: 'long' });
    const day = d.getDate();
    const month = d.getMonth() + 1;
    // "בשעה" (preposition "at the hour") flows naturally after the
    // weekday without a comma, so the line reads as one phrase rather
    // than three comma-separated fragments. Drops a punctuation
    // character on every email and feels more conversational.
    const timeLabel = date.proposedTime
      ? ` בשעה ${date.proposedTime.slice(0, 5)}`
      : '';
    return `תאריך ${day}/${month}, ${weekday}${timeLabel}`;
  } catch {
    return date.proposedDate;
  }
}

// Build the seat-fill status line in natural Hebrew, branching by the
// gap between confirmed and target. Hebrew has different phrasings for
// 0 / 1 / many in both the players phrase ("אף שחקן" / "שחקן אחד" /
// "{N} שחקנים") and the remaining phrase ("מקום אחרון" singular vs
// "{N} מקומות" plural), so a single template can't cover all cases.
//
// Scenarios:
//   - yesCount === 0  → "אף שחקן עוד לא אישר מתוך {target} מקומות,
//                        נשארו עוד {target} מקומות"
//   - yesCount === 1  → "שחקן אחד אישר מתוך {target} מקומות,
//                        נשארו עוד {N} מקומות"
//   - 2 ≤ yesCount < target ─ same shape with "{N} שחקנים אישרו"
//   - one seat left   → "…, נשאר עוד מקום אחרון"
//   - exactly target  → "…, כל המקומות מלאים" (drop the "מתוך" math —
//                        it's redundant when full)
//   - over target     → "{N} שחקנים אישרו לתאריך זה" (the original
//                        target is no longer the relevant frame —
//                        expansion is a positive signal, not an
//                        overflow)
export function buildSeatStateLine(yesCount: number, target: number): string {
  let playersPhrase: string;
  if (yesCount === 0) playersPhrase = 'אף שחקן עוד לא אישר';
  else if (yesCount === 1) playersPhrase = 'שחקן אחד אישר';
  else playersPhrase = `${yesCount} שחקנים אישרו`;

  const remaining = target - yesCount;

  if (remaining < 0) {
    return `${playersPhrase} לתאריך זה`;
  }
  if (remaining === 0) {
    return `${playersPhrase} — כל המקומות מלאים`;
  }
  if (remaining === 1) {
    return `${playersPhrase} מתוך ${target} מקומות, נשאר עוד מקום אחרון`;
  }
  return `${playersPhrase} מתוך ${target} מקומות, נשארו עוד ${remaining} מקומות`;
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

// "Voting closes at" deadline tailored for the invitation/reminder
// emails to permanent members. They can already vote, so the
// "ההצבעה תיפתח לכולם" expansion countdown isn't relevant — what
// matters is when voting effectively ends, i.e. when the earliest
// upcoming proposed date arrives. Drops the ⏳ emoji to match the
// cleaner template style. Returns null if every proposed date is
// already in the past (defensive — fresh polls always have at
// least one upcoming).
function buildPollClosesAtLine(poll: GamePoll): string | null {
  const now = Date.now();
  const stamps = poll.dates
    .map(d => {
      const time = d.proposedTime || '21:00';
      const ts = new Date(`${d.proposedDate}T${time}`).getTime();
      return Number.isFinite(ts) ? ts : 0;
    })
    .filter(ts => ts > now)
    .sort((a, b) => a - b);
  if (stamps.length === 0) return null;
  return `ההצבעה נסגרת בעוד ${formatReminderRemainingHebrew(stamps[0] - now)}`;
}

// Decide between a single shared "מיקום – {loc}" line below the
// bullets vs. inline per-date locations. Most groups schedule every
// proposed date at the same default location (the host's home), so
// repeating the name on every bullet is noise. When dates do differ
// — a rare case where the admin set a custom per-date location —
// we fall back to the inline-per-bullet form so each date stays
// unambiguous.
function buildDatesAndLocationBlock(poll: GamePoll): { dateLines: string; locationLine: string } {
  const allShareDefault =
    !!poll.defaultLocation &&
    poll.dates.every(d => !d.location || d.location === poll.defaultLocation);
  if (allShareDefault) {
    const dateLines = poll.dates
      .map(d => `• ${formatHebrewDateTime(d)}`)
      .join('\n');
    return { dateLines, locationLine: `מיקום – ${poll.defaultLocation}` };
  }
  const dateLines = poll.dates
    .map(d => formatDateBullet(d, poll.defaultLocation))
    .join('\n');
  return { dateLines, locationLine: '' };
}

export function buildInvitationMessage(poll: GamePoll): BuiltMessage {
  const { dateLines, locationLine } = buildDatesAndLocationBlock(poll);
  const deadline = buildPollClosesAtLine(poll);
  const subject = '🃏 ערב פוקר חדש — הצביעו!';
  // Two-NBSP indent for the labelled rows ("התאריכים הפתוחים", "יעד",
  // "ההצבעה נסגרת", CTA). The bullets and the location line stay
  // unindented as visual anchors. Email-RTL wrapper uses
  // `white-space: normal` so regular spaces would collapse.
  const I = '\u00a0\u00a0';
  const link = emailVoteLink(poll);
  const ctaBlock = link ? `\n\n${I}👉 להצבעה: ${link}` : '';

  return {
    pushTitle: subject,
    pushBody: `הוצעו ${poll.dates.length} תאריכים. היכנסו והצביעו 📅`,
    emailSubject: subject,
    emailBody: (name) =>
      emailGreeting(name) +
      'ההצבעה לערב הפוקר עדיין פתוחה.\n\n' +
      `${I}📅 התאריכים הפתוחים:\n${dateLines}\n\n` +
      (locationLine ? `📍 ${locationLine}\n\n` : '') +
      `${I}🎯 יעד: ${poll.targetPlayerCount} שחקנים` +
      (deadline ? `\n${I}⏳ ${deadline}` : '') +
      ctaBlock +
      '\n\n— Poker Manager',
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
  const dateLineCompact = formatHebrewDateTime(confirmedDate);
  const dateLineVerbose = formatHebrewDateTimeVerbose(confirmedDate);
  const locLine = loc ? `מיקום - ${loc}\n` : '';
  return {
    pushTitle: '✅ המשחק נסגר!',
    // Push body stays compact — small notification surface, every char
    // counts. Email body uses the verbose label-prefixed format.
    pushBody: `${dateLineCompact}${loc ? ` — ${loc}` : ''}`,
    emailSubject: '✅ נסגר! ניפגש בערב פוקר 🃏',
    emailBody: (name) =>
      emailGreeting(name) +
      'נבחר תאריך — המשחק נסגר 🎉\n\n' +
      `${dateLineVerbose}\n` +
      locLine +
      `${yesNames.length} שחקנים אישרו: ${yesNames.join(', ')}` +
      emailCtaBlock(poll, 'לפרטים') +
      '\n\nתגיעו בזמן!',
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
  const dateLineCompact = formatHebrewDateTime(confirmedDate);
  const dateLineVerbose = formatHebrewDateTimeVerbose(confirmedDate);

  const yesCount = yesNames.length;
  // Confirmed-players phrase, with name list. Same shape as the
  // sibling confirmed-below-target builders for visual consistency
  // across the four "the date is set" emails.
  let confirmedLine: string;
  if (yesCount === 0) {
    confirmedLine = '0 שחקנים אישרו';
  } else if (yesCount === 1) {
    confirmedLine = `שחקן אחד אישר: ${yesNames[0]}.`;
  } else {
    confirmedLine = `${yesCount} שחקנים אישרו: ${yesNames.join(', ')}.`;
  }

  // Conditional seats line. By design this builder fires when target
  // was just hit (yesCount >= target → missing === 0), so the line
  // is normally omitted entirely. We compute it defensively in case
  // the call-site contract drifts (e.g. expansion paths firing this
  // builder for a not-quite-full state).
  const missing = Math.max(0, poll.targetPlayerCount - yesCount);
  const seatsLine = missing === 0
    ? ''
    : missing === 1
      ? '\n🪑 נשאר עוד מקום אחרון'
      : `\n🪑 נשארו עוד ${missing} מקומות`;

  // Two-NBSP indent for the details "card" — the email-RTL wrapper
  // would otherwise collapse the leading whitespace.
  const I = '\u00a0\u00a0';
  const locLine = loc ? `${I}📍 מיקום - ${loc}\n` : '';
  const link = emailVoteLink(poll);
  const ctaBlock = link ? `\n\n${I}👉 לפרטים: ${link}` : '';

  return {
    pushTitle: '🎉 המשחק מלא — ניפגש!',
    pushBody: `${dateLineCompact}${loc ? ` — ${loc}` : ''}`,
    emailSubject: '🎉 המשחק מלא — ניפגש בערב פוקר 🃏',
    emailBody: (name) =>
      emailGreeting(name) +
      'הצבעת ערב הפוקר נסגרה — ניפגש 🎉\n\n' +
      `${I}📅 ${dateLineVerbose}\n` +
      locLine +
      `${I}👥 ${confirmedLine}` +
      seatsLine +
      ctaBlock +
      '\n\nנתראה על השולחן! 🃏\n\n— Poker Manager',
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
  const dateLineCompact = formatHebrewDateTime(confirmedDate);
  const dateLineVerbose = formatHebrewDateTimeVerbose(confirmedDate);

  // Confirmed-players list, ordered by RSVP commit time. Same shape
  // as the "others" variant — first to RSVP shows up first.
  const playersById = new Map(getAllPlayers().map(p => [p.id, p.name]));
  const confirmedNames = poll.votes
    .filter(v => v.dateId === confirmedDate.id && v.response === 'yes')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(v => playersById.get(v.playerId))
    .filter((n): n is string => Boolean(n));

  let confirmedLine: string;
  if (confirmedNames.length === 0) {
    confirmedLine = `${yesCount} שחקנים אישרו`;
  } else if (yesCount === 1) {
    confirmedLine = `שחקן אחד אישר: ${confirmedNames[0]}.`;
  } else {
    confirmedLine = `${yesCount} שחקנים אישרו: ${confirmedNames.join(', ')}.`;
  }

  // Remaining-seats phrase (same singular/plural rules as the
  // "others" variant for consistency across the two paired emails).
  const seatsPhrase = missing === 1
    ? 'נשאר עוד מקום אחרון'
    : `נשארו עוד ${missing} מקומות`;

  // Hero #2: addresses the recipient personally. "אתה רשום" (m.) /
  // "את רשומה" (f.) — both pronoun and adjective swap, so a verb-
  // table swap isn't enough; we branch on the resolved gender here.
  // The seat-availability tail flips with `missing` (singular vs
  // plural). Falls back to the masculine form when the recipient
  // isn't a known player (no gender on file).
  const gender = getPlayerGender;
  const seatTail = missing === 1
    ? 'אבל עוד יש מקום פנוי'
    : `אבל עוד יש ${missing} מקומות פנויים`;

  // Two-NBSP indent so the email-RTL wrapper's `white-space: normal`
  // doesn't collapse the visual hierarchy. Same trick used in the
  // "others" sibling email.
  const I = '\u00a0\u00a0';
  const locLine = loc ? `${I}📍 מיקום - ${loc}\n` : '';
  const link = emailVoteLink(poll);
  const ctaBlock = link ? `\n\n${I}👉 לפרטים: ${link}` : '';

  const subject = '✅ התאריך נבחר — אתם בפנים';
  return {
    pushTitle: subject,
    pushBody: `${dateLineCompact}${loc ? ` — ${loc}` : ''} · ${seatsPhrase}`,
    emailSubject: subject,
    emailBody: (name) => {
      const youRegistered = gender(name) === 'female' ? 'את רשומה' : 'אתה רשום';
      return (
        emailGreeting(name) +
        'נבחר תאריך לערב הפוקר 🎯\n' +
        `${youRegistered}, ${seatTail}.\n\n` +
        `${I}📅 ${dateLineVerbose}\n` +
        locLine +
        `${I}👥 ${confirmedLine}\n` +
        `🪑 ${seatsPhrase}\n\n` +
        'אם יש לכם אורח שרוצה להצטרף — תעדכנו 🤝' +
        ctaBlock +
        '\n\n— Poker Manager'
      );
    },
  };
}

export function buildConfirmedBelowTargetOthersMessage(
  poll: GamePoll,
  confirmedDate: GamePollDate,
  yesCount: number,
  missing: number,
): BuiltMessage {
  const loc = confirmedDate.location || poll.defaultLocation;
  const dateLineCompact = formatHebrewDateTime(confirmedDate);
  const dateLineVerbose = formatHebrewDateTimeVerbose(confirmedDate);

  // Resolve the names of the players who already RSVP'd "yes" on the
  // pinned date, ordered by RSVP time (createdAt) so the list reads
  // as a chronological commit order — first to confirm shows up
  // first. Falls back gracefully if a vote's playerId can't be
  // resolved (deleted player).
  const playersById = new Map(getAllPlayers().map(p => [p.id, p.name]));
  const confirmedNames = poll.votes
    .filter(v => v.dateId === confirmedDate.id && v.response === 'yes')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(v => playersById.get(v.playerId))
    .filter((n): n is string => Boolean(n));

  // Player count phrase, with the names list when we have any.
  // Hebrew counted-noun shape:
  //   1   → "שחקן אחד אישר: {name}."
  //   2+  → "{N} שחקנים אישרו: {names}."
  // We never reach yesCount === 0 here (the function only fires on
  // a confirmed-below-target pin, which requires ≥ 1 yes-voter), but
  // the fallback is present in case the call-site contract drifts.
  let confirmedLine: string;
  if (confirmedNames.length === 0) {
    confirmedLine = `${yesCount} שחקנים אישרו`;
  } else if (yesCount === 1) {
    confirmedLine = `שחקן אחד אישר: ${confirmedNames[0]}.`;
  } else {
    confirmedLine = `${yesCount} שחקנים אישרו: ${confirmedNames.join(', ')}.`;
  }

  // Remaining-seats phrase with singular/plural Hebrew agreement.
  // We use "נשאר עוד מקום אחרון" for the last seat (specific
  // wording requested) and "נשארו עוד {N} מקומות" for the plural.
  const seatsPhrase = missing === 1
    ? 'נשאר עוד מקום אחרון'
    : `נשארו עוד ${missing} מקומות`;

  // Two-NBSP indent for the "details card" — the email-RTL wrapper
  // uses `white-space: normal` and would collapse regular spaces, so
  // \u00a0 (non-breaking space) is required to make the indent
  // survive Gmail / Outlook rendering.
  const I = '\u00a0\u00a0';
  const locLine = loc ? `${I}📍 מיקום - ${loc}\n` : '';
  const link = emailVoteLink(poll);
  const ctaBlock = link ? `\n\n${I}👉 לאישור הגעה: ${link}` : '';

  return {
    pushTitle: '🪑 חסרים שחקנים למשחק',
    pushBody: `${dateLineCompact}${loc ? ` — ${loc}` : ''} · ${seatsPhrase}`,
    emailSubject: '🪑 נקבע תאריך — נשארו מקומות פנויים',
    emailBody: (name) =>
      emailGreeting(name) +
      'נקבע תאריך לערב הפוקר! 🎯\n' +
      `עוד יש מקומות פנויים, ${verbForName('invited', name)} להצביע 🤝\n\n` +
      `${I}📅 ${dateLineVerbose}\n` +
      locLine +
      `${I}👥 ${confirmedLine}\n` +
      `🪑 ${seatsPhrase}\n\n` +
      'ההצבעה כעת רק על התאריך הזה.' +
      ctaBlock +
      '\n\n— Poker Manager',
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
      'ערב הפוקר בוטל 😔' +
      reasonLine +
      '\n\nנתראה בפעם הבאה! 🃏',
  };
}

// Fan out push + email. Push uses the shared body for the whole group
// (one API call, server filters subscriptions by name). Email is built
// per-recipient so we can inject a personal greeting. Both channels are
// independently gated by group settings — the WhatsApp share buttons +
// in-app banners always work regardless.
// Per-kind email allowlist — emails are reserved for the events members
// genuinely shouldn't miss. Noisy / informational kinds (creation,
// expanded, vote_change) are push-only. Introduced in v5.43 to keep us
// inside the EmailJS free quota; push fan-out remains unchanged for every
// kind so subscribers still get realtime updates if they have push set up.
// Layered ON TOP of the group-level `scheduleEmailsEnabled` toggle — both
// must be true for an email to go out.
const EMAIL_ALLOWLIST: ReadonlySet<NotificationKind> = new Set<NotificationKind>([
  'confirmed',
  'target_filled',
  'cancellation',
  'reminder',
]);

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

  if (!EMAIL_ALLOWLIST.has(kind)) {
    console.log(`[schedule-notify/${kind}] email skipped (push-only kind)`);
    return;
  }

  if (!emailsEnabled) {
    console.log(`[schedule-notify/${kind}] emails disabled by group setting, skipping ${recipientNames.length} recipients`);
    return;
  }

  await Promise.allSettled(recipientNames.map(async (name) => {
    try {
      const info = await getPlayerEmailForNotification(poll.groupId, name);
      if (!info?.email) return;
      // RTL alignment is handled centrally in `proxySendBroadcastEmail`
      // — it wraps the body in an HTML `<div dir="rtl" ...>` block
      // which forces right-to-left paragraph alignment in every email
      // client. We used to prepend a U+200F RLM here, but that only
      // steered paragraph-level bidi resolution and didn't override
      // the EmailJS template's `text-align: left` CSS, which left
      // some clients still aligned to the left.
      const ok = await proxySendBroadcastEmail({
        to: info.email,
        subject: msg.emailSubject,
        message: msg.emailBody(name),
        senderName: 'Poker Manager',
        kind: notificationKindToEmailKind(kind),
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

// RSVP response → Hebrew verb (past-tense for yes/no, future-tense for
// maybe). All three are gender-bound — "אישר" is male, "אישרה" is
// female. The actual conjugation is done per-voter at message-build
// time via `verbForName`; this map only declares which semantic verb
// to look up. Keeps the notification copy gender-correct (see
// rule: stop emitting `/ה` slash-forms).
const RESPONSE_VERB_KEY: Record<RsvpResponse, VerbKey> = {
  yes: 'confirmed',
  maybe: 'willUpdate',
  no: 'declined',
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
  // Gender-aware: "ליאור אישר" (male) vs "מיכל אישרה" (female). Verb
  // tracks the voter, NOT the admin proxy editor — the proxy tag below
  // already credits the editor separately, the verb describes what
  // *the voter* is on record as.
  const verbKey = RESPONSE_VERB_KEY[vote.response];
  const responseLabel = verbKey ? verbForName(verbKey, voterName) : vote.response;
  const proxyTag = changedByName && changedByName !== voterName
    ? ` (ע״י ${changedByName})`
    : '';
  // Distinct title so the lock-screen preview tells subscribers
  // immediately whether this is fresh activity or a flip — the body
  // ("7/5 יום חמישי 21:00 — ליאור אישר") reads identically for both
  // cases.
  const title = isNewVote ? '🗳️ הצבעה חדשה' : '🔄 הצבעה עודכנה';
  // Date-led summary: the calendar slot is the highest-information
  // payload (when? what's the slot?), so it leads. Actor + verb come
  // after an em-dash. The verb stands alone grammatically without
  // its old "לתאריך" preposition because the dash already signals
  // "for this date — X did Y".
  const summary = dateLine
    ? `${dateLine} — ${voterName}${proxyTag} ${responseLabel}`.trim()
    : `${voterName}${proxyTag} ${responseLabel}`.trim();
  // Live yes count for that date — gives the subscriber the seat-fill
  // status without making them open the app. `poll.votes` is the post-
  // write snapshot (caller passes the refreshed poll), so we count
  // directly with no off-by-one.
  const yesCount = poll.votes.filter(
    v => v.dateId === vote.dateId && v.response === 'yes',
  ).length;
  const stateLine = `📊 ${buildSeatStateLine(yesCount, poll.targetPlayerCount)}`;
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
      // RTL alignment is applied centrally inside
      // `proxySendBroadcastEmail` (HTML wrapper with `dir="rtl"`).
      const baseBody = buildReminderEmailBody(poll, name);
      const fullBody = `${baseBody}${cta}`;
      const ok = await proxySendBroadcastEmail({
        to: info.email,
        subject: TITLE_REMINDER,
        message: fullBody,
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

