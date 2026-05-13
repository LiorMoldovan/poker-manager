// Server-side notification dispatcher.
//
// The pg_net trigger on notification_jobs INSERT (and the pg_cron sweep
// every minute) call this Edge Function with `{ job_id, kind }` in the
// body and the shared secret in `X-Worker-Secret`. The worker:
//
//   1. Claims the job via the service-role-aware RPC
//      (claim_notification_job_internal). The claim is atomic via
//      `FOR UPDATE SKIP LOCKED`, so a duplicate webhook+sweep race ends
//      with one winner and one no-op.
//   2. Reads context from the DB using the service-role client (the
//      worker has no user JWT — RLS would otherwise hide everything).
//   3. Builds a Hebrew push title/body and email subject/body from
//      simple templates. The per-kind message builders mirror the spirit
//      of the rich client-side helpers in `src/utils/scheduleNotifications.ts`
//      but trade gender-aware conjugation (`verbForName`) for plain
//      neutral Hebrew. Result: every push/email lands reliably even when
//      no client is online — the original goal of this rebuild.
//   4. Resolves the recipient player names for that kind. Each kind has
//      a different audience rule (creation = permanent members,
//      target_filled = yes-voters on the pinned date, vote_change =
//      admins/owners/super-admins/subscribers, trivia_report_filed =
//      super-admins, etc.).
//   5. POSTs to /api/send-push and (if email is enabled for the group)
//      to /api/send-email per recipient, using `X-Worker-Secret` so
//      those endpoints accept the call without a user JWT and switch to
//      service-role DB access for their internal queries.
//   6. Marks the job done (or failed, with attempts incremented) via
//      complete_notification_job_internal. Failures with retries left
//      flip back to `pending`; the next pg_cron sweep retries. Three
//      attempts max, then terminal `failed`.
//
// The worker is best-effort per-channel: a push failure doesn't block
// the email leg, and vice versa. The job is marked `done` if AT LEAST
// ONE channel succeeded — partial delivery is preferable to repeating
// the whole job and double-pushing the channel that already worked.
// Total channel failure flips the job to `failed` after the third try.

import { verifyAuth } from './_auth';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const config = { runtime: 'edge' };

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ursjltxklmxmapfvkttj.supabase.co';

// Owner group identifier — only this group can broadcast email (cost
// control: EmailJS is one shared free-tier account). Mirror of the
// /api/send-email check; computed once per cold start.
const OWNER_GROUP_ID = process.env.OWNER_GROUP_ID || '';

// ─── Shared types ──────────────────────────────────────────────────────────

type Kind =
  | 'creation' | 'expanded' | 'confirmed' | 'cancellation' | 'target_filled'
  | 'vote_change' | 'reminder'
  | 'trivia_report_filed' | 'trivia_report_resolved'
  | 'training_report_filed' | 'training_report_resolved' | 'training_milestone';

interface Job {
  id: string;
  group_id: string;
  poll_id: string | null;
  kind: Kind;
  attempts: number;
  payload: Record<string, unknown>;
}

interface BuiltMessage {
  pushTitle: string;
  pushBody: string;
  emailSubject: string;
  // emailBody is plain text; the existing /api/send-email wraps it in an
  // RTL-direction HTML envelope before handing to EmailJS.
  emailBody: string;
  // Deep-link URL relative to the app origin (used in the push payload).
  url: string;
}

interface DispatchPlan {
  message: BuiltMessage;
  recipientPlayerNames: string[];
  groupId: string;
  // When true, the email leg is skipped entirely (group has emails off,
  // or kind is push-only by design — trivia/training reports).
  pushOnly: boolean;
  // When true, the push leg is skipped (group has push disabled). Email
  // can still fire if pushOnly is also false. Both flags being true =
  // the job is a no-op (planForJob returns null in that case).
  emailOnly: boolean;
}

// ─── Service-role Supabase client (RLS bypassed) ───────────────────────────

let _supabase: SupabaseClient | null = null;
function db(): SupabaseClient {
  if (_supabase) return _supabase;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY missing');
  _supabase = createClient(SUPABASE_URL, serviceKey, {
    auth: { persistSession: false },
  });
  return _supabase;
}

// ─── Hebrew formatters ─────────────────────────────────────────────────────

// Resolve the Hebrew weekday for a YYYY-MM-DD calendar date.
// IMPORTANT: do NOT combine the date with the wall-clock time and then
// pass timeZone:'Asia/Jerusalem' to toLocaleDateString. The Edge runtime
// is in UTC, so `new Date('2026-05-14T21:00')` parses as 2026-05-14T21:00Z;
// shifting that to Asia/Jerusalem (UTC+3 in DST) bumps it past midnight
// to 2026-05-15 and the weekday renders one day late ("14/5 יום שישי"
// instead of "14/5 יום חמישי"). Anchor at noon UTC and read the weekday
// in UTC so the calendar date is immune to any reasonable TZ offset.
function hebrewWeekdayForDate(dateIso: string): string {
  const d = new Date(`${dateIso}T12:00:00Z`);
  return d.toLocaleDateString('he-IL', { weekday: 'long', timeZone: 'UTC' });
}

function formatHebrewDateTime(dateIso: string, timeStr: string | null): string {
  try {
    const t = timeStr ? timeStr.slice(0, 5) : '21:00';
    const weekday = hebrewWeekdayForDate(dateIso);
    const day = Number(dateIso.slice(8, 10));
    const month = Number(dateIso.slice(5, 7));
    return `${day}/${month} ${weekday} ${t}`;
  } catch {
    return dateIso;
  }
}

function formatHebrewDateTimeVerbose(dateIso: string, timeStr: string | null): string {
  try {
    const t = timeStr ? timeStr.slice(0, 5) : null;
    const weekday = hebrewWeekdayForDate(dateIso);
    const day = Number(dateIso.slice(8, 10));
    const month = Number(dateIso.slice(5, 7));
    const timeLabel = t ? ` בשעה ${t}` : '';
    return `תאריך ${day}/${month}, ${weekday}${timeLabel}`;
  } catch {
    return dateIso;
  }
}

function deepLinkUrl(pollId: string): string {
  return `/settings?tab=schedule&pollId=${encodeURIComponent(pollId)}`;
}

// Absolute URL for email bodies (push uses the relative path above).
function emailVoteLink(pollIdOrSlug: string): string {
  return `${resolvePublicOrigin()}/p/${encodeURIComponent(pollIdOrSlug)}`;
}

// Two-NBSP indent so HTML email's `white-space: normal` doesn't collapse
// the visual hierarchy. Same trick the client-side builders use.
const I = '\u00a0\u00a0';

function emailGreeting(name: string): string {
  return name ? `היי ${name},\n\n` : '';
}

// ─── Poll context loader ───────────────────────────────────────────────────

interface PollCtx {
  poll: {
    id: string;
    group_id: string;
    status: string;
    target_player_count: number;
    confirmed_date_id: string | null;
    default_location: string | null;
    cancellation_reason: string | null;
    share_slug: string | null;
  };
  dates: Array<{
    id: string;
    proposed_date: string;
    proposed_time: string | null;
    location: string | null;
  }>;
  votes: Array<{
    player_id: string;
    date_id: string;
    response: string;
    user_id: string | null;
    created_at: string;
  }>;
  playersById: Map<string, { id: string; name: string; type: string }>;
  playersByName: Map<string, { id: string; name: string; type: string }>;
}

async function loadPollCtx(pollId: string): Promise<PollCtx | null> {
  const sb = db();
  const [pollRes, datesRes, votesRes, playersRes] = await Promise.all([
    sb.from('game_polls').select('id, group_id, status, target_player_count, confirmed_date_id, default_location, cancellation_reason, share_slug').eq('id', pollId).maybeSingle(),
    sb.from('game_poll_dates').select('id, proposed_date, proposed_time, location').eq('poll_id', pollId).order('proposed_date'),
    sb.from('game_poll_votes').select('player_id, date_id, response, user_id, created_at').eq('poll_id', pollId),
    // Deferred: load all players in the group (cheap, one query) so the
    // recipient resolver and confirmed-line builder have name + type.
    sb.from('players').select('id, name, type, group_id'),
  ]);
  if (pollRes.error || !pollRes.data) return null;
  const groupId = (pollRes.data as { group_id: string }).group_id;
  const playersRaw = (playersRes.data || []) as Array<{ id: string; name: string; type: string; group_id: string }>;
  const groupPlayers = playersRaw.filter(p => p.group_id === groupId);
  const playersById = new Map(groupPlayers.map(p => [p.id, p]));
  const playersByName = new Map(groupPlayers.map(p => [p.name, p]));
  return {
    poll: pollRes.data as PollCtx['poll'],
    dates: (datesRes.data || []) as PollCtx['dates'],
    votes: (votesRes.data || []) as PollCtx['votes'],
    playersById,
    playersByName,
  };
}

// ─── Recipient resolution ──────────────────────────────────────────────────

// Returns the names of yes-voters on the pinned date, ordered by RSVP time
// (matches the client builder so the confirmed-line ordering is consistent).
function yesVoterNamesOnPinnedDate(ctx: PollCtx): string[] {
  const dateId = ctx.poll.confirmed_date_id;
  if (!dateId) return [];
  return ctx.votes
    .filter(v => v.date_id === dateId && v.response === 'yes')
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map(v => ctx.playersById.get(v.player_id)?.name)
    .filter((n): n is string => Boolean(n));
}

function permanentNames(ctx: PollCtx): string[] {
  const out: string[] = [];
  for (const p of ctx.playersById.values()) {
    if (p.type === 'permanent') out.push(p.name);
  }
  return out;
}

function guestAndPermanentGuestNames(ctx: PollCtx): string[] {
  const out: string[] = [];
  for (const p of ctx.playersById.values()) {
    if (p.type === 'permanent_guest' || p.type === 'guest') out.push(p.name);
  }
  return out;
}

function allParticipantNames(ctx: PollCtx): string[] {
  const seen = new Set<string>();
  for (const v of ctx.votes) {
    const name = ctx.playersById.get(v.player_id)?.name;
    if (name) seen.add(name);
  }
  // Cancellation also pings everyone who could have voted — admins
  // + permanents — so they know not to wait.
  for (const p of ctx.playersById.values()) {
    if (p.type === 'permanent') seen.add(p.name);
  }
  return Array.from(seen);
}

// Server-side equivalent of get_poll_change_recipients RPC — admins,
// super-admins, and per-poll change subscribers minus the actor.
async function voteChangeRecipientNames(pollId: string, actorUserId: string | null): Promise<string[]> {
  const sb = db();
  // The existing RPC is SECURITY DEFINER but checks auth.uid(). We have
  // no user — go straight at the underlying tables via service-role.
  const { data: poll } = await sb.from('game_polls').select('group_id').eq('id', pollId).maybeSingle();
  if (!poll) return [];
  const groupId = (poll as { group_id: string }).group_id;

  const [members, supers, subs] = await Promise.all([
    sb.from('group_members')
      .select('user_id, role, schedule_vote_change_notifs, player_id')
      .eq('group_id', groupId),
    sb.from('super_admins').select('user_id'),
    sb.from('game_poll_change_subscribers').select('user_id').eq('poll_id', pollId),
  ]);
  const memberRows = (members.data || []) as Array<{ user_id: string; role: string; schedule_vote_change_notifs: boolean | null; player_id: string }>;
  const superSet = new Set(((supers.data || []) as Array<{ user_id: string }>).map(r => r.user_id));
  const subSet   = new Set(((subs.data   || []) as Array<{ user_id: string }>).map(r => r.user_id));

  // Resolve player names by joining group_members.player_id → players.name.
  const playerIds = memberRows.map(m => m.player_id).filter(Boolean);
  const { data: players } = playerIds.length
    ? await sb.from('players').select('id, name').in('id', playerIds)
    : { data: [] as Array<{ id: string; name: string }> };
  const nameById = new Map(((players || []) as Array<{ id: string; name: string }>).map(p => [p.id, p.name]));

  const out = new Set<string>();
  for (const m of memberRows) {
    if (m.user_id === actorUserId) continue;
    if (m.schedule_vote_change_notifs === false) continue;
    const isAdmin       = m.role === 'admin';
    const isSuper       = superSet.has(m.user_id);
    const isSubscriber  = subSet.has(m.user_id);
    if (!(isAdmin || isSuper || isSubscriber)) continue;
    const name = nameById.get(m.player_id);
    if (name) out.add(name);
  }
  return Array.from(out);
}

async function superAdminPlayerNamesInGroup(groupId: string): Promise<string[]> {
  const sb = db();
  // Reuse the existing RPC — it's SECURITY DEFINER and works for the
  // service role too (it doesn't reference auth.uid() in its body).
  const { data, error } = await sb.rpc('get_super_admin_player_names_in_group', { p_group_id: groupId });
  if (error || !data) return [];
  return data as string[];
}

// ─── Message builders (one per kind) ───────────────────────────────────────

// Each builder produces a BuiltMessage. They're intentionally simpler than
// the client-side builders in scheduleNotifications.ts — they drop the
// gender-aware verb conjugations (`verbForName`) in favor of neutral
// Hebrew. This is the deliberate trade for full server-side reliability.

function buildCreationMessage(ctx: PollCtx): BuiltMessage {
  const dateLines = ctx.dates.map(d => {
    const loc = d.location || ctx.poll.default_location;
    return `• ${formatHebrewDateTime(d.proposed_date, d.proposed_time)}${loc ? ` — ${loc}` : ''}`;
  }).join('\n');
  const subject = '🃏 ערב פוקר חדש — הצביעו!';
  const datesCount = ctx.dates.length;
  const pushBody = datesCount === 1
    ? 'הוצע תאריך אחד. היכנסו והצביעו 📅'
    : `הוצעו ${datesCount} תאריכים. היכנסו והצביעו 📅`;
  const cta = `\n\n${I}👉 להצבעה: ${emailVoteLink(ctx.poll.share_slug || ctx.poll.id)}`;
  return {
    pushTitle: subject,
    pushBody,
    emailSubject: subject,
    emailBody:
      'נפתחה הצבעה חדשה לערב פוקר.\n\n' +
      `${I}📅 התאריכים המוצעים:\n${dateLines}\n\n` +
      `${I}🎯 יעד: ${ctx.poll.target_player_count} שחקנים` +
      cta,
    url: deepLinkUrl(ctx.poll.id),
  };
}

function buildExpandedMessage(ctx: PollCtx): BuiltMessage {
  const dateLines = ctx.dates.map(d => {
    const loc = d.location || ctx.poll.default_location;
    return `• ${formatHebrewDateTime(d.proposed_date, d.proposed_time)}${loc ? ` — ${loc}` : ''}`;
  }).join('\n');
  return {
    pushTitle: '🎯 ההצבעה פתוחה לכולם',
    pushBody: 'הקבוצה צריכה עוד שחקנים — היכנסו והצביעו 📅',
    emailSubject: '🎯 ההצבעה פתוחה — הצטרפו',
    emailBody:
      'הקבוצה צריכה עוד שחקנים! ההצבעה לערב הפוקר עברה לשלב פתוח לכולם.\n\n' +
      `📅 התאריכים הפתוחים:\n${dateLines}\n\n` +
      `🎯 יעד: ${ctx.poll.target_player_count} שחקנים\n\n` +
      `👉 להצבעה: ${emailVoteLink(ctx.poll.share_slug || ctx.poll.id)}`,
    url: deepLinkUrl(ctx.poll.id),
  };
}

function buildConfirmedMessage(ctx: PollCtx): BuiltMessage | null {
  const dateRow = ctx.dates.find(d => d.id === ctx.poll.confirmed_date_id);
  if (!dateRow) return null;
  const loc = dateRow.location || ctx.poll.default_location;
  const dateCompact = formatHebrewDateTime(dateRow.proposed_date, dateRow.proposed_time);
  const dateVerbose = formatHebrewDateTimeVerbose(dateRow.proposed_date, dateRow.proposed_time);
  const yesNames = yesVoterNamesOnPinnedDate(ctx);
  const yesCount = yesNames.length;
  let confirmedLine: string;
  if (yesCount === 0) confirmedLine = '0 שחקנים אישרו';
  else if (yesCount === 1) confirmedLine = `שחקן אחד אישר: ${yesNames[0]}.`;
  else confirmedLine = `${yesCount} שחקנים אישרו: ${yesNames.join(', ')}.`;
  const locLine = loc ? `${I}📍 מיקום - ${loc}\n` : '';
  const cta = `\n\n${I}👉 לפרטים: ${emailVoteLink(ctx.poll.share_slug || ctx.poll.id)}`;
  return {
    pushTitle: '✅ המשחק נסגר!',
    pushBody: `${dateCompact}${loc ? ` — ${loc}` : ''}`,
    emailSubject: '✅ נסגר! ניפגש בערב פוקר 🃏',
    emailBody:
      'הצבעת ערב הפוקר נסגרה — ניפגש 🎉\n\n' +
      `${I}📅 ${dateVerbose}\n` +
      locLine +
      `${I}👥 ${confirmedLine}` +
      cta +
      '\n\nנתראה על השולחן! 🃏',
    url: deepLinkUrl(ctx.poll.id),
  };
}

function buildTargetFilledMessage(ctx: PollCtx): BuiltMessage | null {
  const dateRow = ctx.dates.find(d => d.id === ctx.poll.confirmed_date_id);
  if (!dateRow) return null;
  const loc = dateRow.location || ctx.poll.default_location;
  const dateCompact = formatHebrewDateTime(dateRow.proposed_date, dateRow.proposed_time);
  const dateVerbose = formatHebrewDateTimeVerbose(dateRow.proposed_date, dateRow.proposed_time);
  const yesNames = yesVoterNamesOnPinnedDate(ctx);
  const yesCount = yesNames.length;
  let confirmedLine: string;
  if (yesCount === 0) confirmedLine = '0 שחקנים אישרו';
  else if (yesCount === 1) confirmedLine = `שחקן אחד אישר: ${yesNames[0]}.`;
  else confirmedLine = `${yesCount} שחקנים אישרו: ${yesNames.join(', ')}.`;
  const locLine = loc ? `${I}📍 מיקום - ${loc}\n` : '';
  const cta = `\n\n${I}👉 לפרטים: ${emailVoteLink(ctx.poll.share_slug || ctx.poll.id)}`;
  return {
    pushTitle: '🎉 המשחק מלא — ניפגש!',
    pushBody: `${dateCompact}${loc ? ` — ${loc}` : ''}`,
    emailSubject: '🎉 המשחק מלא — ניפגש בערב פוקר 🃏',
    emailBody:
      'הצבעת ערב הפוקר נסגרה — ניפגש 🎉\n\n' +
      `${I}📅 ${dateVerbose}\n` +
      locLine +
      `${I}👥 ${confirmedLine}` +
      cta +
      '\n\nנתראה על השולחן! 🃏',
    url: deepLinkUrl(ctx.poll.id),
  };
}

function buildCancellationMessage(ctx: PollCtx): BuiltMessage {
  const reason = ctx.poll.cancellation_reason?.trim();
  const reasonLine = reason ? `\n\nסיבה: ${reason}` : '';
  return {
    pushTitle: '❌ ההצבעה בוטלה',
    pushBody: 'ערב הפוקר בוטל הפעם — נתראה במשחק הבא 🃏',
    emailSubject: '❌ ערב הפוקר בוטל',
    emailBody:
      'ערב הפוקר בוטל הפעם.' +
      reasonLine +
      '\n\nנתראה במשחק הבא 🃏',
    url: deepLinkUrl(ctx.poll.id),
  };
}

function buildVoteChangeMessage(
  ctx: PollCtx,
  payload: Record<string, unknown>,
): BuiltMessage | null {
  const dateId   = payload.date_id   as string | undefined;
  const playerId = payload.player_id as string | undefined;
  const response = payload.response  as string | undefined;
  const isNew    = payload.is_new_vote === true;
  if (!dateId || !playerId || !response) return null;
  const dateRow = ctx.dates.find(d => d.id === dateId);
  const player  = ctx.playersById.get(playerId);
  if (!dateRow || !player) return null;
  const responseLabel: Record<string, string> = {
    yes: 'מגיע',
    no: 'לא מגיע',
    maybe: 'אעדכן',
  };
  const verb = isNew ? 'הצביע' : 'עדכן הצבעה';
  const dateLabel = formatHebrewDateTime(dateRow.proposed_date, dateRow.proposed_time);
  const text = `${player.name} ${verb}: ${responseLabel[response] || response} — ${dateLabel}`;
  return {
    pushTitle: '🗳 שינוי בהצבעה',
    pushBody: text,
    emailSubject: `🗳 ${player.name} ${verb}`,
    emailBody:
      `${text}\n\n` +
      `👉 לצפייה בהצבעה: ${emailVoteLink(ctx.poll.share_slug || ctx.poll.id)}`,
    url: deepLinkUrl(ctx.poll.id),
  };
}

function buildTriviaReportFiledMessage(payload: Record<string, unknown>): BuiltMessage {
  const reporter = String(payload.reporter_name || 'שחקן');
  const reason   = String(payload.reason || 'other');
  const question = String(payload.question_text || '');
  const reasonLabel: Record<string, string> = {
    wrong_answer: 'תשובה שגויה',
    unclear_question: 'שאלה לא ברורה',
    other: 'דיווח כללי',
  };
  const snippet = question.length > 80 ? `${question.slice(0, 77)}...` : question;
  const body = `${reporter} (${reasonLabel[reason] || reason}) — ${snippet}`;
  return {
    pushTitle: '🚩 דיווח חדש על שאלת חידון',
    pushBody: body,
    emailSubject: '🚩 דיווח חדש על שאלת חידון',
    emailBody: body,
    url: '/settings?tab=triviaReports',
  };
}

function buildTriviaReportResolvedMessage(payload: Record<string, unknown>): BuiltMessage {
  const outcome = String(payload.outcome || 'accept');
  const question = String(payload.question_text || '');
  const snippet = question.length > 80 ? `${question.slice(0, 77)}...` : question;
  const isAccept = outcome === 'accept';
  return {
    pushTitle: isAccept ? '✅ הדיווח שלך התקבל' : 'ℹ️ הדיווח שלך נבדק',
    pushBody: isAccept
      ? `הדיווח התקבל — השאלה תתוקן בעדכון הבא. ${snippet}`
      : `החלטנו שהשאלה תקינה — היא נשארת במאגר. ${snippet}`,
    emailSubject: isAccept ? '✅ הדיווח שלך התקבל' : 'ℹ️ הדיווח שלך נבדק',
    emailBody: isAccept
      ? `הדיווח שהגשת התקבל. השאלה תתוקן בעדכון הבא של המשחק.\n\nשאלה: ${question}`
      : `הדיווח שהגשת נבדק. החלטנו שהשאלה תקינה — היא נשארת במאגר.\n\nשאלה: ${question}`,
    url: '/settings?tab=triviaReports',
  };
}

// Generic builder for pre-built payloads — reminders + training reports
// + training milestones enqueue with a complete `{ title, body, ... }`
// payload because the client side knows the ad-hoc context (per-recipient
// reminder lists, batched flag counts, milestone numbers). The worker
// just unwraps and dispatches.
function buildFromPayload(payload: Record<string, unknown>): BuiltMessage | null {
  const t = String(payload.push_title || payload.title || '');
  const b = String(payload.push_body  || payload.body  || '');
  if (!t || !b) return null;
  return {
    pushTitle: t,
    pushBody: b,
    emailSubject: String(payload.email_subject || t),
    emailBody:    String(payload.email_body    || b),
    url:          String(payload.url           || '/'),
  };
}

// ─── Plan resolution ───────────────────────────────────────────────────────

async function planForJob(job: Job): Promise<DispatchPlan | null> {
  const { kind, group_id, poll_id, payload } = job;
  const sb = db();

  // Per-group push/email gates from `settings`.
  const { data: settings } = await sb.from('settings')
    .select('schedule_push_enabled, schedule_emails_enabled')
    .eq('group_id', group_id)
    .maybeSingle();
  const pushEnabled = (settings as { schedule_push_enabled?: boolean } | null)?.schedule_push_enabled !== false;
  const emailsEnabled = (settings as { schedule_emails_enabled?: boolean } | null)?.schedule_emails_enabled === true;
  // Email is also gated to the owner group at the network layer; mirror
  // here so we don't even queue email work for non-owner groups.
  const emailAllowedForGroup = !!OWNER_GROUP_ID && group_id === OWNER_GROUP_ID && emailsEnabled;
  const emailOnly = !pushEnabled;

  // ── Poll-context kinds ──
  if (poll_id && (
    kind === 'creation' || kind === 'expanded' || kind === 'confirmed'
    || kind === 'cancellation' || kind === 'target_filled' || kind === 'vote_change'
  )) {
    const ctx = await loadPollCtx(poll_id);
    if (!ctx) return null;

    let message: BuiltMessage | null = null;
    let recipientPlayerNames: string[] = [];
    let pushOnly = false;

    if (kind === 'creation') {
      message = buildCreationMessage(ctx);
      recipientPlayerNames = permanentNames(ctx);
    } else if (kind === 'expanded') {
      message = buildExpandedMessage(ctx);
      recipientPlayerNames = guestAndPermanentGuestNames(ctx);
    } else if (kind === 'confirmed') {
      message = buildConfirmedMessage(ctx);
      recipientPlayerNames = yesVoterNamesOnPinnedDate(ctx);
    } else if (kind === 'target_filled') {
      message = buildTargetFilledMessage(ctx);
      recipientPlayerNames = yesVoterNamesOnPinnedDate(ctx);
    } else if (kind === 'cancellation') {
      message = buildCancellationMessage(ctx);
      recipientPlayerNames = allParticipantNames(ctx);
    } else if (kind === 'vote_change') {
      message = buildVoteChangeMessage(ctx, payload);
      const actorUid = (payload.actor_user_id as string | null | undefined) ?? null;
      recipientPlayerNames = await voteChangeRecipientNames(poll_id, actorUid);
      // Filter out the actor from recipient list by name as a backstop.
      const actorPlayerId = payload.player_id as string | undefined;
      if (actorPlayerId) {
        const actorName = ctx.playersById.get(actorPlayerId)?.name;
        if (actorName) {
          recipientPlayerNames = recipientPlayerNames.filter(n => n !== actorName);
        }
      }
    }

    if (!message) return null;
    // pushOnly = true when the group can't broadcast email (email disabled
    // in settings or non-owner group) OR the kind itself is push-only by
    // design (none in this branch — all poll lifecycle kinds support both
    // channels).
    return {
      message,
      recipientPlayerNames,
      groupId: group_id,
      pushOnly: !emailAllowedForGroup || pushOnly,
      emailOnly,
    };
  }

  // ── Trivia kinds (push only by design — email retired in v5.43) ──
  if (kind === 'trivia_report_filed') {
    const reporter = String(payload.reporter_name || '');
    const supers = await superAdminPlayerNamesInGroup(group_id);
    const targets = supers.filter(n => n !== reporter);
    return {
      message: buildTriviaReportFiledMessage(payload),
      recipientPlayerNames: targets,
      groupId: group_id,
      pushOnly: true,
      emailOnly,
    };
  }
  if (kind === 'trivia_report_resolved') {
    const reporter = String(payload.reporter_name || '');
    return {
      message: buildTriviaReportResolvedMessage(payload),
      recipientPlayerNames: reporter ? [reporter] : [],
      groupId: group_id,
      pushOnly: true,
      emailOnly,
    };
  }

  // ── Reminder, training_*, anything else: payload IS the message ──
  const message = buildFromPayload(payload);
  if (!message) return null;
  const recipientNames = Array.isArray(payload.recipient_player_names)
    ? (payload.recipient_player_names as string[])
    : [];
  // Reminders go to email if the group has it on. Training kinds are
  // push-only by convention (we retired training emails in v5.43).
  const trainingKind = kind === 'training_report_filed'
    || kind === 'training_report_resolved'
    || kind === 'training_milestone';
  return {
    message,
    recipientPlayerNames: recipientNames,
    groupId: group_id,
    pushOnly: trainingKind || !emailAllowedForGroup,
    emailOnly,
  };
}

// ─── Dispatch ──────────────────────────────────────────────────────────────

async function postSendPush(plan: DispatchPlan): Promise<{ ok: boolean; status: number; bodyText: string }> {
  const url = new URL('/api/send-push', resolveInternalOrigin()).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: workerRequestHeaders(),
    body: JSON.stringify({
      groupId: plan.groupId,
      title: plan.message.pushTitle,
      body: plan.message.pushBody,
      targetPlayerNames: plan.recipientPlayerNames,
      url: plan.message.url,
    }),
  });
  const text = await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, bodyText: text };
}

async function postSendEmailFor(name: string, email: string, plan: DispatchPlan): Promise<{ ok: boolean; status: number; bodyText: string }> {
  const url = new URL('/api/send-email', resolveInternalOrigin()).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: workerRequestHeaders(),
    body: JSON.stringify({
      to: email,
      subject: plan.message.emailSubject,
      groupId: plan.groupId,
      kind: 'broadcast',
      message: emailGreeting(name) + plan.message.emailBody,
      senderName: 'Poker Manager',
    }),
  });
  const text = await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, bodyText: text };
}

// Public origin used in customer-facing URLs (emails, deep links).
// Always prefer the stable production alias — Vercel's auto-injected
// VERCEL_URL points at the deployment-specific URL, which is gated by
// Deployment Protection when "Standard Protection" / "Vercel
// Authentication" is enabled, so it would render an SSO wall instead
// of the app for any recipient who follows the link.
function resolvePublicOrigin(): string {
  if (process.env.PUBLIC_APP_ORIGIN) return process.env.PUBLIC_APP_ORIGIN;
  return 'https://poker-manager-blond.vercel.app';
}

// Internal origin used by the worker to call /api/send-push and
// /api/send-email on the same deployment. We MUST NOT use VERCEL_URL
// here for the same reason as above: that URL is behind Deployment
// Protection on Standard Protection deployments, so the worker's
// self-call gets intercepted by Vercel's SSO wall and returns an HTML
// 401 ("Authentication Required") long before our handler runs.
// Sticking to the production alias keeps the call public; the request
// is still authenticated end-to-end by the X-Worker-Secret header that
// /api/_auth.verifyAuth checks.
function resolveInternalOrigin(): string {
  if (process.env.WORKER_INTERNAL_ORIGIN) return process.env.WORKER_INTERNAL_ORIGIN;
  return resolvePublicOrigin();
}

// Headers for worker→worker HTTP calls. Includes the shared secret
// expected by /api/_auth, plus an optional Vercel Protection Bypass
// header so the call still works if someone deliberately points
// WORKER_INTERNAL_ORIGIN at a Deployment-Protected URL (e.g. a
// preview deploy for testing). The bypass secret is only set in
// envs that enable Deployment Protection; in production with the
// public alias it's an unused no-op.
function workerRequestHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Worker-Secret': process.env.WORKER_INTERNAL_SECRET || '',
  };
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypass) headers['x-vercel-protection-bypass'] = bypass;
  return headers;
}

async function fetchEmailsFor(groupId: string, names: string[]): Promise<Array<{ name: string; email: string }>> {
  if (names.length === 0) return [];
  // Can't reuse get_player_email_for_notification — it gates on
  // auth.uid() ∈ group_members, which is NULL when called via service
  // role. Go straight at the underlying tables: the service role can
  // see auth.users (it's the only client with that privilege).
  const sb = db();
  // 1. Resolve player_id for each name, scoped to the group.
  const { data: players } = await sb
    .from('players')
    .select('id, name')
    .eq('group_id', groupId)
    .in('name', names);
  const idsByName = new Map<string, string>();
  for (const row of (players || []) as Array<{ id: string; name: string }>) {
    idsByName.set(row.name, row.id);
  }
  if (idsByName.size === 0) return [];

  // 2. Resolve user_id for each player via group_members.
  const playerIds = Array.from(idsByName.values());
  const { data: members } = await sb
    .from('group_members')
    .select('player_id, user_id')
    .eq('group_id', groupId)
    .in('player_id', playerIds);
  const userByPlayerId = new Map<string, string>();
  for (const row of (members || []) as Array<{ player_id: string; user_id: string }>) {
    userByPlayerId.set(row.player_id, row.user_id);
  }

  // 3. Resolve emails via auth.admin.listUsers — the service role's
  // dedicated path. We could also `select email from auth.users where
  // id = any(...)` but listUsers is the supported, future-proof API.
  // For a small group (<100 users) this is fast.
  const userIds = Array.from(new Set(userByPlayerId.values())).filter(Boolean);
  if (userIds.length === 0) return [];
  const emailByUserId = new Map<string, string>();
  // The Supabase auth-admin API doesn't have a "by-id-list" lookup,
  // but it does support per-id lookup. Parallelize.
  const results = await Promise.allSettled(
    userIds.map(uid => sb.auth.admin.getUserById(uid)),
  );
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const u = r.value.data?.user;
    if (u?.id && u.email) emailByUserId.set(u.id, u.email);
  }

  const out: Array<{ name: string; email: string }> = [];
  for (const [name, playerId] of idsByName.entries()) {
    const userId = userByPlayerId.get(playerId);
    if (!userId) continue;
    const email = emailByUserId.get(userId);
    if (email) out.push({ name, email });
  }
  return out;
}

async function dispatch(plan: DispatchPlan): Promise<{ pushOk: boolean; emailOk: boolean; errors: string[] }> {
  const errors: string[] = [];
  let pushOk = false;
  let emailOk = false;

  // ── Push (skip when group has push disabled) ──
  if (!plan.emailOnly && plan.recipientPlayerNames.length > 0) {
    try {
      const r = await postSendPush(plan);
      if (r.ok) {
        pushOk = true;
      } else {
        errors.push(`push ${r.status}: ${r.bodyText.slice(0, 200)}`);
      }
    } catch (err) {
      errors.push(`push: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    pushOk = true; // push disabled by group setting → not an error
  }

  // ── Email (skip when pushOnly) ──
  if (!plan.pushOnly && plan.recipientPlayerNames.length > 0) {
    try {
      const recipients = await fetchEmailsFor(plan.groupId, plan.recipientPlayerNames);
      if (recipients.length === 0) {
        // No emails on file for the recipients — not an error, just nothing
        // to send. Email leg counts as "ok" in this case so the job
        // doesn't show as a failure for a perfectly normal state.
        emailOk = true;
      } else {
        const results = await Promise.allSettled(
          recipients.map(({ name, email }) => postSendEmailFor(name, email, plan)),
        );
        let anyOk = false;
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value.ok) anyOk = true;
          else if (r.status === 'fulfilled') errors.push(`email ${r.value.status}: ${r.value.bodyText.slice(0, 200)}`);
          else errors.push(`email: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
        }
        emailOk = anyOk;
      }
    } catch (err) {
      errors.push(`email: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    emailOk = true; // push-only kinds: email is "n/a", not "failed"
  }

  return { pushOk, emailOk, errors };
}

// ─── Top-level handler ─────────────────────────────────────────────────────

async function claimJob(): Promise<Job | null> {
  const sb = db();
  const secret = process.env.WORKER_INTERNAL_SECRET || '';
  const { data, error } = await sb.rpc('claim_notification_job_internal', { p_secret: secret });
  if (error) {
    console.warn('[notification-worker] claim error:', error.message);
    return null;
  }
  if (!data || (Array.isArray(data) && data.length === 0)) return null;
  const row = Array.isArray(data) ? data[0] : data;
  return row as Job;
}

async function completeJob(jobId: string, success: boolean, errorMessage: string | null): Promise<void> {
  const sb = db();
  const secret = process.env.WORKER_INTERNAL_SECRET || '';
  const { error } = await sb.rpc('complete_notification_job_internal', {
    p_secret: secret,
    p_job_id: jobId,
    p_success: success,
    p_error_message: errorMessage,
  });
  if (error) console.warn('[notification-worker] complete error:', error.message);
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // Worker secret authentication. The pg_net trigger sends the secret in
  // X-Worker-Secret; user-JWT auth is rejected for this endpoint.
  const auth = await verifyAuth(req);
  if (!auth.ok) return auth.response;
  if (auth.mode !== 'worker') {
    return new Response(JSON.stringify({ error: { message: 'worker secret required' } }), {
      status: 403, headers: JSON_HEADERS,
    });
  }

  // Body is informational — we still claim from the queue to be sure we
  // operate on the canonical row and to handle the "duplicate webhook +
  // sweep" race correctly via SELECT FOR UPDATE SKIP LOCKED.
  let bodyJson: { job_id?: string; kind?: string } = {};
  try { bodyJson = await req.json(); } catch { /* ignore */ }
  void bodyJson;

  // ── Drain up to N jobs per invocation ──
  // The webhook fires per-row, so usually one invocation handles one job
  // and returns. The pg_cron sweep also fires one POST per job. But to be
  // resilient against a fleet of stuck jobs piling up, we drain a small
  // batch per call. 10 is enough to keep up with a busy poll night
  // without exceeding Vercel's Edge timeout (default 25s).
  const MAX_PER_INVOCATION = 10;
  const stats = { processed: 0, pushOk: 0, emailOk: 0, failed: 0 };

  for (let i = 0; i < MAX_PER_INVOCATION; i++) {
    const job = await claimJob();
    if (!job) break;
    stats.processed += 1;
    try {
      const plan = await planForJob(job);
      if (!plan) {
        // Nothing to dispatch — settings forbid push+email, recipients are empty,
        // poll deleted, etc. Mark done so the queue doesn't keep retrying.
        await completeJob(job.id, true, null);
        continue;
      }
      const r = await dispatch(plan);
      if (r.pushOk) stats.pushOk += 1;
      if (r.emailOk) stats.emailOk += 1;
      const success = r.pushOk || r.emailOk;
      const errMsg = success ? null : r.errors.join(' | ').slice(0, 480);
      if (!success) stats.failed += 1;
      await completeJob(job.id, success, errMsg);
    } catch (err) {
      stats.failed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[notification-worker] job error:', job.id, msg);
      await completeJob(job.id, false, msg.slice(0, 480));
    }
  }

  return new Response(JSON.stringify({ ok: true, ...stats }), { headers: JSON_HEADERS });
}
