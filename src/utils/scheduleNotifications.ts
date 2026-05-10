// Schedule notifications: push + email fan-out for poll lifecycle events.
//
// Architecture (v5.48.0+, migration 061):
// Lifecycle transitions on game_polls / game_poll_votes atomically enqueue
// jobs via DB triggers. The notificationWorker (`utils/notificationWorker.ts`)
// claims jobs and calls the dispatchX helpers exported here. The legacy
// sendX wrappers (kept as no-op shims) used to claim+dispatch directly
// from the actor's browser, which lost notifications when the actor's
// tab closed mid-fetch (see incident 2026-05-10, poll 16259f05).
//
// Reminder + vote-change notifications still fire fresh (no queue) since
// they're not claim-gated and a missed one is acceptable noise.

import type { GamePoll, GamePollDate, GamePollVote, RsvpResponse } from '../types';
import {
  getAllPlayers, getAllPolls,
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

// Per-date "X confirmed" tally line, NBSP-indented under the bullet.
// Hidden entirely when no one's RSVP'd "yes" yet for that date — keeps
// freshly-opened polls clean (every bullet bare) and progressively
// reveals state as votes come in. Singular vs plural agreement matters
// in Hebrew: "אישר שחקן אחד" (m. sg. + counted noun) vs the bare
// plural "אישרו N" for 2+. The text leads with the Hebrew verb so the
// bidi resolver anchors the line as RTL on the very first strong
// character, avoiding the digit-Hebrew-digit-Hebrew-digit shuffling
// that some clients render awkwardly.
function buildPerDateYesTally(yesCount: number, target: number): string | null {
  if (yesCount === 0) return null;
  // Three-NBSP indent so the tally visually nests under the bullet
  // even though `white-space: normal` collapses regular leading spaces
  // in the email's HTML body.
  const indent = '\u00a0\u00a0\u00a0';
  if (yesCount === 1) {
    return `${indent}✅ אישר שחקן אחד מתוך ${target}`;
  }
  return `${indent}✅ אישרו ${yesCount} מתוך ${target}`;
}

// Decide between a single shared "מיקום - {loc}" line below the
// bullets vs. inline per-date locations. Most groups schedule every
// proposed date at the same default location (the host's home), so
// repeating the name on every bullet is noise. When dates do differ
// — a rare case where the admin set a custom per-date location —
// we fall back to the inline-per-bullet form so each date stays
// unambiguous. Each bullet may be followed by a NBSP-indented
// "✅ אישרו N מתוך target" line whenever that date already has
// yes-votes — gives recipients an at-a-glance sense of which slot
// the group is trending toward.
function buildDatesAndLocationBlock(poll: GamePoll): { dateLines: string; locationLine: string } {
  // Pre-compute yes counts per date so the bullet builder is O(N)
  // instead of doing a votes-filter inside the loop.
  const yesByDateId = new Map<string, number>();
  for (const v of poll.votes) {
    if (v.response !== 'yes') continue;
    yesByDateId.set(v.dateId, (yesByDateId.get(v.dateId) ?? 0) + 1);
  }

  const renderBullet = (d: GamePollDate, withInlineLocation: boolean): string => {
    const head = withInlineLocation
      ? formatDateBullet(d, poll.defaultLocation)
      : `• ${formatHebrewDateTime(d)}`;
    const tally = buildPerDateYesTally(
      yesByDateId.get(d.id) ?? 0,
      poll.targetPlayerCount,
    );
    return tally ? `${head}\n${tally}` : head;
  };

  const allShareDefault =
    !!poll.defaultLocation &&
    poll.dates.every(d => !d.location || d.location === poll.defaultLocation);

  if (allShareDefault) {
    const dateLines = poll.dates.map(d => renderBullet(d, false)).join('\n');
    return { dateLines, locationLine: `מיקום - ${poll.defaultLocation}` };
  }
  const dateLines = poll.dates.map(d => renderBullet(d, true)).join('\n');
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

  // Push body picks singular vs plural based on the proposed-date count
  // ("הוצע תאריך אחד" vs "הוצעו N תאריכים"). Polls almost always have
  // ≥ 2 dates so the singular branch is rare, but it's the right thing
  // when an admin opens a vote on a single anchor date.
  const datesCount = poll.dates.length;
  const pushBody = datesCount === 1
    ? 'הוצע תאריך אחד. היכנסו והצביעו 📅'
    : `הוצעו ${datesCount} תאריכים. היכנסו והצביעו 📅`;

  return {
    pushTitle: subject,
    pushBody,
    emailSubject: subject,
    emailBody: (name) =>
      emailGreeting(name) +
      'נפתחה הצבעה חדשה לערב פוקר.\n\n' +
      `${I}📅 התאריכים המוצעים:\n${dateLines}\n\n` +
      (locationLine ? `📍 ${locationLine}\n\n` : '') +
      `${I}🎯 יעד: ${poll.targetPlayerCount} שחקנים` +
      (deadline ? `\n${I}⏳ ${deadline}` : '') +
      ctaBlock,
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

// At-target confirmation — fires when an admin pins a date AND the seat
// target is already met at that moment. Same recipient experience as
// the post-pin "target filled" follow-up (date locked, table full), so
// the body uses the same NBSP-indented details "card" with the 📅/📍/👥
// trio. Subject and push title stay distinct ("נסגר!" vs "המשחק מלא")
// so the two flows remain identifiable in email logs and on the lock
// screen.
export function buildConfirmedMessage(
  poll: GamePoll,
  confirmedDate: GamePollDate,
  yesNames: string[],
): BuiltMessage {
  const loc = confirmedDate.location || poll.defaultLocation;
  const dateLineCompact = formatHebrewDateTime(confirmedDate);
  const dateLineVerbose = formatHebrewDateTimeVerbose(confirmedDate);

  const yesCount = yesNames.length;
  // Player count phrase: same Hebrew counted-noun shape as the sibling
  // "date is set" templates so all four read consistently.
  let confirmedLine: string;
  if (yesCount === 0) {
    confirmedLine = '0 שחקנים אישרו';
  } else if (yesCount === 1) {
    confirmedLine = `שחקן אחד אישר: ${yesNames[0]}.`;
  } else {
    confirmedLine = `${yesCount} שחקנים אישרו: ${yesNames.join(', ')}.`;
  }

  // Two-NBSP indent for the details card. Same trick as the sibling
  // builders — the email-RTL wrapper uses `white-space: normal` and
  // would otherwise collapse the leading whitespace.
  const I = '\u00a0\u00a0';
  const locLine = loc ? `${I}📍 מיקום - ${loc}\n` : '';
  const link = emailVoteLink(poll);
  const ctaBlock = link ? `\n\n${I}👉 לפרטים: ${link}` : '';

  return {
    pushTitle: '✅ המשחק נסגר!',
    // Push body stays compact — small notification surface, every char
    // counts. Email body uses the verbose label-prefixed format.
    pushBody: `${dateLineCompact}${loc ? ` — ${loc}` : ''}`,
    emailSubject: '✅ נסגר! ניפגש בערב פוקר 🃏',
    emailBody: (name) =>
      emailGreeting(name) +
      'הצבעת ערב הפוקר נסגרה — ניפגש 🎉\n\n' +
      `${I}📅 ${dateLineVerbose}\n` +
      locLine +
      `${I}👥 ${confirmedLine}` +
      ctaBlock +
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
      // Whole email is singular 2nd-person — match it on the trailing
      // "guest recruitment" nudge too. `verbForName('updateImp', name)`
      // resolves to "עדכן" / "עדכני" via the player's stored gender;
      // the pronoun "לך" is gender-flexible, so only the verb branches.
      const updateVerb = verbForName('updateImp', name);
      return (
        emailGreeting(name) +
        'נבחר תאריך לערב הפוקר 🎯\n' +
        `${youRegistered}, ${seatTail}.\n\n` +
        `${I}📅 ${dateLineVerbose}\n` +
        locLine +
        `${I}👥 ${confirmedLine}\n` +
        `🪑 ${seatsPhrase}\n\n` +
        `אם יש לך אורח שמתאים לו להצטרף — ${updateVerb} 🤝` +
        ctaBlock
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
      ctaBlock,
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
  // Also drop anyone who explicitly voted NO on the pinned date — they
  // already told us this date doesn't work for them, so the
  // "join us, חסר אחד" recruitment email is just noise to them and
  // burns quota. They still get push (the channel they didn't opt out
  // of) and can see the live date in the app. A maybe-vote stays in
  // the audience because "maybe" implies undecided, where a nudge
  // CAN flip them. Cancellation/reminder/etc. flows are unaffected —
  // a no-voter still gets the cancellation email if the poll is
  // cancelled, because that's the state they actually need.
  const noOnPinned = new Set(
    poll.votes
      .filter(v => v.dateId === poll.confirmedDateId && v.response === 'no')
      .map(v => v.playerId)
  );
  for (const id of noOnPinned) ids.delete(id);
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
// genuinely shouldn't miss. `vote_change` stays push-only because it
// fires on every RSVP cast / change and would flood the EmailJS quota.
// `expanded` IS in the allowlist (added v5.44.2) — when a poll opens up
// to permanent_guests + guests after the 48h delay, those members are
// often less engaged with push and rely on email to even know the
// invitation came through. Skipping email for `expanded` was the
// original v5.43.0 cut, but it muted the most important moment for
// non-permanent members. Quota-wise it costs ~9 emails per expansion
// (6 perm_guest + ~3 linked guests in this group), still well inside
// the 200/mo cap. `creation` is in the allowlist for the same reason —
// open polls are important enough that the invitation goes out as both
// push and email. Layered ON TOP of the group-level
// `scheduleEmailsEnabled` toggle — both must be true for an email to
// go out.
const EMAIL_ALLOWLIST: ReadonlySet<NotificationKind> = new Set<NotificationKind>([
  'creation',
  'expanded',
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
  options?: {
    // When set, push goes to `recipientNames` but email is restricted
    // to this narrower list. Used by `sendTargetFilledNotifications` to
    // celebrate the fill via push for ALL yes-voters while only emailing
    // the NEW yes-voter(s) who didn't already get the
    // `confirmed-below-target-yes` email at pin time. Saves up to 6
    // duplicate emails per messy poll (v5.44.2 quota optimization).
    emailRecipientNames?: string[];
  },
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

  const emailNames = options?.emailRecipientNames ?? recipientNames;
  if (emailNames.length === 0) {
    console.log(`[schedule-notify/${kind}] email skipped (no fresh recipients after dedup)`);
    return;
  }
  if (emailNames.length < recipientNames.length) {
    console.log(`[schedule-notify/${kind}] email deduped: ${recipientNames.length} push, ${emailNames.length} email`);
  }

  await Promise.allSettled(emailNames.map(async (name) => {
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
      const r = await proxySendBroadcastEmail({
        to: info.email,
        subject: msg.emailSubject,
        message: msg.emailBody(name),
        senderName: 'Poker Manager',
        kind: notificationKindToEmailKind(kind),
      });
      if (!r.ok) console.warn(`[schedule-notify/${kind}] email failed for ${name}: ${r.error || 'unknown'}`);
    } catch (err) {
      console.warn(`[schedule-notify/${kind}] email error for ${name}:`, err);
    }
  }));
}

// ── Public API ──
//
// dispatchX functions: pure dispatch — no claim-gate. Called by the
// notification worker (utils/notificationWorker.ts) once it has claimed
// a job from the queue. They return:
//   { atTargetConfirm: true } from `dispatchConfirmed` when the poll was
//   confirmed AT-target (yesCount >= target), so the worker can preempt
//   the redundant 'target_filled' job. Otherwise undefined.
// Errors thrown by these functions surface to the worker, which marks
// the job failed (with retry up to attempts=3).

export type DispatchResult = { atTargetConfirm?: boolean } | void;

export async function dispatchInvitation(poll: GamePoll): Promise<void> {
  const recipientIds = resolveRecipientPlayerIds(poll, 'creation');
  const names = playerNamesForIds(recipientIds);
  await dispatch(poll, 'creation', buildInvitationMessage(poll), names);
}

export async function dispatchExpanded(poll: GamePoll): Promise<void> {
  const recipientIds = resolveRecipientPlayerIds(poll, 'expanded');
  const names = playerNamesForIds(recipientIds);
  await dispatch(poll, 'expanded', buildExpandedMessage(poll), names);
}

export async function dispatchConfirmed(poll: GamePoll): Promise<DispatchResult> {
  if (!poll.confirmedDateId) throw new Error('poll has no confirmedDateId');
  const confirmedDate = poll.dates.find(d => d.id === poll.confirmedDateId);
  if (!confirmedDate) throw new Error('confirmed date not in poll.dates');

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
    // At-target: single "ניפגש בערב פוקר" flow to yes-voters. We tell the
    // worker to preempt the 'target_filled' job (if one was enqueued by
    // the trigger in the same xact, which the trigger normally avoids
    // via its 500ms-since-confirmed_at guard, but defensive belt-and-
    // suspenders for the case where confirmed_at lags slightly).
    await dispatch(
      poll,
      'confirmed',
      buildConfirmedMessage(poll, confirmedDate, yesNames),
      yesNames,
    );
    return { atTargetConfirm: true };
  }

  // Below target: split the audience and tailor the copy. Both dispatches
  // run in parallel under one Promise.allSettled — partial failure is
  // acceptable (the worker still marks the job done since at least one
  // audience got their message; the other will be retried via the sweep
  // recovery if its sentinel is still null).
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
  return undefined;
}

export async function dispatchCancellation(poll: GamePoll): Promise<void> {
  const recipientIds = resolveRecipientPlayerIds(poll, 'cancellation');
  const names = playerNamesForIds(recipientIds);
  await dispatch(poll, 'cancellation', buildCancellationMessage(poll), names);
}

// Fires when a confirmed-below-target poll reaches its seat target via
// post-pin yes-votes. Yes-voters on the pinned date get a final
// "המשחק מלא — ניפגש!" announcement. Skipped when the seat target
// hasn't actually been reached yet (caller bug — the trigger only
// enqueues this kind when count >= target, but defensive).
export async function dispatchTargetFilled(poll: GamePoll): Promise<void> {
  if (poll.status !== 'confirmed' || !poll.confirmedDateId) {
    throw new Error('target_filled fired on non-confirmed poll');
  }
  const yesVotes = poll.votes.filter(
    v => v.dateId === poll.confirmedDateId && v.response === 'yes'
  );
  const yesPlayerIds = Array.from(new Set(yesVotes.map(v => v.playerId)));
  if (yesPlayerIds.length < poll.targetPlayerCount) {
    throw new Error('target_filled fired below target');
  }
  const confirmedDate = poll.dates.find(d => d.id === poll.confirmedDateId);
  if (!confirmedDate) throw new Error('confirmed date not in poll.dates');
  const yesNames = playerNamesForIds(yesPlayerIds);

  // Email-dedup: anyone whose yes-vote on the pinned date predates the
  // confirmed broadcast already received the `confirmed-below-target-yes`
  // email at pin time ("we picked Friday — חסר אחד"). Emailing them again
  // a day later with "המשחק מלא" is redundant copy on the same context;
  // push still fires for everyone (the celebratory buzz is the point).
  // Only the NEW yes-voter(s) — whose vote was cast after the confirm
  // broadcast — get the email so they know they're now in the game.
  // Falls back to "email everyone" when `confirmedNotificationsSentAt`
  // is null (legacy polls or polls where the confirm dispatch failed
  // entirely — better to over-email than silently drop "you're in").
  const cutoffMs = poll.confirmedNotificationsSentAt
    ? new Date(poll.confirmedNotificationsSentAt).getTime()
    : null;
  const emailIds = cutoffMs == null
    ? yesPlayerIds
    : Array.from(new Set(
        yesVotes
          .filter(v => new Date(v.votedAt).getTime() > cutoffMs)
          .map(v => v.playerId)
      ));
  const emailNames = playerNamesForIds(emailIds);

  await dispatch(
    poll,
    'target_filled',
    buildTargetFilledMessage(poll, confirmedDate, yesNames),
    yesNames,
    { emailRecipientNames: emailNames },
  );
}

// ── Deprecated shims ──
//
// Retained as no-ops so older call-sites in ScheduleTab.tsx don't crash
// during the rollout window. The DB triggers in migration 061 enqueue the
// notification job atomically with the lifecycle transition, and the
// worker drains it. All remaining call-sites should be removed; these
// shims will be deleted in a follow-up cleanup pass.

export async function sendInvitationToPermanentMembers(_poll: GamePoll): Promise<void> {
  // No-op: handled by trg_enqueue_poll_notification + notificationWorker.
}

export async function sendConfirmedNotifications(_poll: GamePoll): Promise<void> {
  // No-op: handled by trg_enqueue_poll_notification + notificationWorker.
}

export async function sendExpandedInvitations(_poll: GamePoll): Promise<void> {
  // No-op: handled by trg_enqueue_poll_notification + notificationWorker.
}

export async function sendCancellationNotifications(_poll: GamePoll): Promise<void> {
  // No-op: handled by trg_enqueue_poll_notification + notificationWorker.
}

export async function sendTargetFilledNotifications(_poll: GamePoll): Promise<void> {
  // No-op: handled by trg_enqueue_target_filled_on_vote + notificationWorker.
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
    // Hebrew counted-noun: 1 day uses the singular construct
    // "יום אחד", 2+ uses the cardinal-then-plural "{N} ימים".
    const dayWord = days === 1 ? 'יום אחד' : `${days} ימים`;
    return hours > 0 ? `${dayWord} ${hours} שע׳` : dayWord;
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

// Per-date current state. We surface ONLY the yes-count per date — the
// maybe / no buckets used to render here too, but the email is meant to
// nudge the recipient to commit, not to dump the full vote breakdown.
// Layout: bullet (`• {date}`) followed by an NBSP-indented
// `✅ אישרו N מתוך target` line whenever that date has any yes-votes.
// Singular vs plural agreement matters in Hebrew — "אישר שחקן אחד מתוך 7"
// for N=1, "אישרו N מתוך 7" for 2+. Dates with zero yes-votes show as
// a bare bullet (no second line) so the body stays clean and never
// shouts "0/7" at the reader.
//
// Per-date location is intentionally dropped: virtually every group
// shares the default location across all proposed dates, so repeating
// it on every line is noise. The recipient already knows the location
// from the original invitation; this email is about completing votes.
//
// `recipientName` (when provided) gets a personal Hebrew greeting at
// the top AND drives gender-aware imperative on the closing line —
// `השלם` (m.) / `השלימי` (f.) via `verbForName('completeImp', …)` so
// the whole body stays singular 2nd-person and grammatically agrees.
function buildReminderEmailBody(poll: GamePoll, recipientName?: string): string {
  const target = poll.targetPlayerCount;
  const stateLines = poll.dates.map(d => {
    const head = `• ${formatHebrewDateTime(d)}`;
    const tally = buildPerDateYesTally(
      poll.votes.reduce(
        (n, v) => n + (v.dateId === d.id && v.response === 'yes' ? 1 : 0),
        0,
      ),
      target,
    );
    return tally ? `${head}\n${tally}` : head;
  }).join('\n');

  // Generic intro covering ALL THREE recipient cases the picker pulls
  // in: ghosts (zero votes), partial voters (missing at least one
  // date), and maybe-voters (answered every date but at least one is
  // "אעדכן" — i.e. still not a final answer). The closing imperative
  // is gender-aware singular via `completeImp`, so the body reads
  // consistently in 2nd-person regardless of the recipient.
  const greeting = recipientName ? `היי ${recipientName},\n\n` : '';
  const completeVerb = verbForName('completeImp', recipientName ?? '');
  // Split into three readable blocks: an opening header, the
  // conditions (single line — the recipient just needs to recognise
  // their case), and the call-to-action on its own line so it stands
  // out at the bottom of the paragraph.
  const intro =
    'זו תזכורת להצבעה על המשחק הבא.'
    + '\n\n'
    + 'אם עוד לא הצבעת, הצבעת רק על חלק מהתאריכים, או שסימנת "אעדכן" ועדיין לא נתת תשובה סופית —'
    + '\n'
    + `בבקשה ${completeVerb} את ההצבעה.`;
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
      const r = await proxySendBroadcastEmail({
        to: info.email,
        subject: TITLE_REMINDER,
        message: fullBody,
        senderName: 'Poker Manager',
      });
      if (!r.ok) console.warn(`[schedule-notify/reminder] email failed for ${name}: ${r.error || 'unknown'}`);
    } catch (err) {
      console.warn(`[schedule-notify/reminder] email error for ${name}:`, err);
    }
  }));
}

// ── Lazy sweep: called from ScheduleTab on mount and after each realtime tick ──
//
// Two responsibilities:
//   1. Lazy expansion: poll older than `expansion_delay_hours` flips to
//      'expanded' (the lifecycle trigger then enqueues the 'expanded' job).
//   2. Backfill enqueue: any poll whose state implies a notification is owed
//      (status set, sentinel still null) but whose original lifecycle trigger
//      never fired (e.g. row pre-dates migration 061). The
//      enqueue_poll_notification RPC is idempotent on (poll_id, kind), so
//      re-enqueueing rows that DID fire is a safe no-op.
//   3. Drain the queue via the notification worker.

export async function runSchedulerSweep(): Promise<void> {
  const polls = getAllPolls();
  const now = Date.now();

  // Lazy import to avoid a circular dep on storage / cache RPCs in this
  // file's static graph. Same reason the expansion call below uses one.
  const cacheMod = await import('../database/supabaseCache');

  for (const poll of polls) {
    // Lazy expansion: if expansion_delay_hours elapsed and the poll is
    // still 'open', flip status to 'expanded'. The DB trigger will then
    // enqueue the 'expanded' notification.
    if (poll.status === 'open' && poll.creationNotificationsSentAt) {
      const created = new Date(poll.createdAt).getTime();
      const delayMs = poll.expansionDelayHours * 60 * 60 * 1000;
      if (now - created >= delayMs) {
        import('../database/storage').then(m => m.expandPoll(poll.id))
          .catch(err => console.warn('runSchedulerSweep/expand', err));
      }
    }

    // Backfill enqueue for legacy polls whose triggers never ran.
    // Idempotent — the partial unique index on (poll_id, kind) where
    // status IN ('pending','running') makes redundant enqueues a no-op.
    if (poll.status === 'open' && !poll.creationNotificationsSentAt) {
      cacheMod.enqueuePollNotificationRpc?.(poll.id, 'creation').catch(() => {});
    }
    if (poll.status === 'expanded' && !poll.expandedNotificationsSentAt) {
      cacheMod.enqueuePollNotificationRpc?.(poll.id, 'expanded').catch(() => {});
    }
    if (poll.status === 'confirmed' && !poll.confirmedNotificationsSentAt) {
      cacheMod.enqueuePollNotificationRpc?.(poll.id, 'confirmed').catch(() => {});
    }
    if (poll.status === 'cancelled' && !poll.cancellationNotificationsSentAt) {
      cacheMod.enqueuePollNotificationRpc?.(poll.id, 'cancellation').catch(() => {});
    }
    if (poll.status === 'confirmed'
        && poll.confirmedDateId
        && !poll.targetFilledNotificationsSentAt) {
      const yesCount = poll.votes.reduce(
        (n, v) => n + (v.dateId === poll.confirmedDateId && v.response === 'yes' ? 1 : 0),
        0,
      );
      if (yesCount >= poll.targetPlayerCount) {
        cacheMod.enqueuePollNotificationRpc?.(poll.id, 'target_filled').catch(() => {});
      }
    }
  }

  // Drain the queue. Worker is idempotent and rate-limited; calling it
  // every sweep is intentional.
  const workerMod = await import('./notificationWorker');
  workerMod.processNotificationJobs().catch(err =>
    console.warn('runSchedulerSweep/worker', err));
}

