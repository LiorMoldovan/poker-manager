import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { ReactNode, CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  getAllPolls, getAllPlayers, getSettings, saveSettings,
  createPoll, castVote, cancelPoll, manuallyClosePoll,
  setPollVotingLock,
  updatePollMeta,
  deletePoll,
  adminCastVote, adminDeleteVote,
  subscribeToPollChanges, unsubscribeFromPollChanges,
  getMyPollChangeSubscriptions,
  getMyVoteChangeNotifs, setMyVoteChangeNotifs,
  getGroupId,
  getPlayerStats, getAllGames,
} from '../database/storage';
import { formatHebrewHalf } from '../utils/calculations';
import { useTranslation } from '../i18n';
import type { TranslationKey } from '../i18n/translations';
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh';
import { usePermissions } from '../App';
import {
  runSchedulerSweep,
  sendInvitationToPermanentMembers,
  sendConfirmedNotifications,
  sendCancellationNotifications,
  sendVoteChangeNotifications,
} from '../utils/scheduleNotifications';
import { captureAndSplit, shareFiles } from '../utils/sharing';
import type { GamePoll, GamePollDate, RsvpResponse, Player, Settings } from '../types';
import PollCardCompact from './scheduleLab/PollCardCompact';

// Render a modal as a direct child of <body>. This is critical for
// `position: fixed` overlays: any ancestor with a non-`none` transform,
// filter, perspective, or backdrop-filter promotes itself to the
// containing block for fixed-position descendants — clipping the overlay
// to that ancestor's box instead of the viewport. Cards in this tab
// commonly carry residual transforms from entry animations, so without
// a portal the overlay would be clipped to the card and the modal's
// pinned footer (Save button) ends up off-screen on mobile. Rendering
// at <body> guarantees the overlay anchors to the actual viewport.
export const ModalPortal = ({ children }: { children: ReactNode }) =>
  typeof document !== 'undefined' ? createPortal(children, document.body) : null;

// ─── Helpers ───────────────────────────────────────────

export const fmtHebrewDate = (d: GamePollDate): string => {
  try {
    const dt = new Date(`${d.proposedDate}T${d.proposedTime || '21:00'}`);
    const wd = dt.toLocaleDateString('he-IL', { weekday: 'long' });
    const day = dt.getDate();
    const mon = dt.getMonth() + 1;
    // Middle dot (`·`) between the three semantic chunks (weekday,
    // date, time) gives the field its rhythm — without it the
    // string `יום חמישי 7/5 21:00` reads as one run-on phrase
    // because plain spaces don't visually segment "weekday | date |
    // time". The separator is non-punctuation, RTL-safe, and only
    // appears between segments that actually exist (no `·` after
    // the date when no time was set).
    const time = d.proposedTime ? ` · ${d.proposedTime.slice(0, 5)}` : '';
    return `${wd} · ${day}/${mon}${time}`;
  } catch {
    return d.proposedDate;
  }
};

// Compact format for tight horizontal slots (DateCompetitionStrip rows).
// Drops the time and lets the caller decide about location — the strip
// sits directly above the per-date detail block which carries the full
// fmtHebrewDate + location, so omitting them here is loss-free for the
// reader and saves ~50px of width per row, which is the difference
// between fitting on a 360px viewport and ellipsis-truncating.
export const fmtHebrewDateCompact = (d: GamePollDate): string => {
  try {
    const dt = new Date(`${d.proposedDate}T${d.proposedTime || '21:00'}`);
    const wd = dt.toLocaleDateString('he-IL', { weekday: 'long' });
    const day = dt.getDate();
    const mon = dt.getMonth() + 1;
    return `${wd} · ${day}/${mon}`;
  } catch {
    return d.proposedDate;
  }
};

const todayIso = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Pick the soonest upcoming date (today included) whose weekday is one of the
// configured game-night days. Falls back to today if the setting is empty,
// so the modal always pre-fills *something* sensible.
const nextGameNightIso = (gameNightDays: number[] | undefined): string => {
  const days = gameNightDays && gameNightDays.length ? gameNightDays : null;
  const d = new Date();
  if (days) {
    for (let offset = 0; offset < 14; offset++) {
      if (days.includes(d.getDay())) break;
      d.setDate(d.getDate() + 1);
    }
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Returns the next game-night ISO date strictly AFTER the given anchor.
// Used when the admin clicks "Add date" so each new row defaults to the
// next configured game-night day (e.g. Tue → Thu in a Tue/Thu group).
// Falls back to anchor + 7 days if no game-night days are configured.
const isoToDate = (iso: string): Date | null => {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(n => parseInt(n, 10));
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d);
  return Number.isNaN(dt.getTime()) ? null : dt;
};

const formatIso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const nextGameNightAfter = (anchorIso: string, gameNightDays: number[] | undefined): string => {
  const days = gameNightDays && gameNightDays.length ? gameNightDays : null;
  const anchor = isoToDate(anchorIso) || new Date();
  const d = new Date(anchor);
  d.setDate(d.getDate() + 1);
  if (!days) {
    // No configured game nights — fall back to one week later so adding
    // dates still produces distinct, sensible defaults.
    d.setDate(anchor.getDate() + 7);
    return formatIso(d);
  }
  for (let offset = 0; offset < 14; offset++) {
    if (days.includes(d.getDay())) break;
    d.setDate(d.getDate() + 1);
  }
  return formatIso(d);
};

// Vote is treated as "changed" when voted_at - created_at exceeds this
// threshold. Same tolerance used by VoterGroups for the "✎ עודכן" badge.
// Matches the SQL-level reasoning in 029-schedule-vote-history.sql.
const VOTE_CHANGE_DETECTION_MS = 5_000;

const ARCHIVE_DAYS = 30;

// A poll is "finished" once nothing actionable can happen on it: cancelled,
// expired, or confirmed AND the resulting game has actually been started
// (confirmedGameId is set). A confirmed poll where the admin hasn't clicked
// "התחל משחק" yet is NOT finished — the start-game button must stay visible
// in the active section.
const isFinishedPoll = (p: GamePoll): boolean =>
  p.status === 'cancelled'
  || p.status === 'expired'
  || (p.status === 'confirmed' && !!p.confirmedGameId);

// A poll is "actionable" if voting is live or a start-game action is pending.
// Used to determine whether older finished polls should be auto-archived
// even if they're younger than ARCHIVE_DAYS — once a new round of activity
// begins, the previous round's done-and-dusted polls are clutter.
const isActionablePoll = (p: GamePoll): boolean =>
  p.status === 'open'
  || p.status === 'expanded'
  || (p.status === 'confirmed' && !p.confirmedGameId);

// True when every proposed date on the poll is strictly before "today".
// We compare end-of-day for the latest date against the caller-supplied
// today-start: a poll whose latest date is yesterday counts as past-dated;
// a poll whose latest date is today is still live (the game might be
// happening right now); a poll with at least one future date is never
// past-dated even if other proposals already lapsed.
const isPastDatedPoll = (p: GamePoll, todayStartTs: number): boolean => {
  if (!p.dates || p.dates.length === 0) return false;
  let latestEndOfDayTs = 0;
  for (const d of p.dates) {
    if (!d.proposedDate) continue;
    // 'YYYY-MM-DD' parsed at end-of-day local time so a date marked
    // "today" is treated as still-live until midnight rolls over.
    const ts = new Date(`${d.proposedDate}T23:59:59`).getTime();
    if (Number.isNaN(ts)) continue;
    if (ts > latestEndOfDayTs) latestEndOfDayTs = ts;
  }
  // No parseable date → can't decide → leave it active.
  if (latestEndOfDayTs === 0) return false;
  return latestEndOfDayTs < todayStartTs;
};

// Archive a poll IF any of:
//   * every proposed date is strictly before today (the "the game date
//     already passed, nothing left to do" rule — applies to ANY status,
//     including open/expanded/confirmed-without-game; once the date is
//     in the past the poll is dead weight regardless), OR
//   * it's a finished poll (cancelled / expired / confirmed-with-game-
//     started) AND there's at least one actionable poll alongside it
//     (the "we've moved on" signal), OR
//   * it's a finished poll older than ARCHIVE_DAYS (the long-tail rule).
// Active polls with at least one future date stay active.
const shouldArchive = (
  p: GamePoll,
  hasActionable: boolean,
  todayStartTs: number,
): boolean => {
  if (isPastDatedPoll(p, todayStartTs)) return true;
  if (!isFinishedPoll(p)) return false;
  if (hasActionable) return true;
  const created = new Date(p.createdAt).getTime();
  return Date.now() - created > ARCHIVE_DAYS * 24 * 60 * 60 * 1000;
};

const errMsg = (e: unknown): string => {
  if (e && typeof e === 'object' && 'message' in e) {
    return String((e as { message: unknown }).message ?? '');
  }
  return String(e ?? '');
};

// ─── Component ─────────────────────────────────────────

interface DraftDate {
  proposedDate: string;
  proposedTime: string;
}

const DEFAULT_GAME_TIME = '21:00';

export interface ScheduleTabProps {
  // Picks which `PollCard` body to render for each poll. Both variants
  // share the exact same data flow, voting / proxy / share / edit /
  // lock / cancel / delete handlers, and modal stack — only the visual
  // layout differs.
  //   * 'compact' — the cleaner one-tile-per-date layout (PollCardCompact).
  //                 Default; shipped to every user from v5.x onward.
  //   * 'legacy'  — the original chrome (status pill + competition
  //                 strip + per-date detail rows + summary footer).
  //                 Kept around behind a super-admin-only sub-tab as a
  //                 fallback while the new layout proves itself in
  //                 production. Will be removed once we're confident.
  variant?: 'legacy' | 'compact';
}

export default function ScheduleTab({ variant = 'compact' }: ScheduleTabProps = {}) {
  const { t, isRTL } = useTranslation();
  const { role, isOwner, isSuperAdmin, playerName } = usePermissions();
  const navigate = useNavigate();
  const location = useLocation();

  // Deep-link target: when a recipient taps the share-card URL
  // (`/settings?tab=schedule&poll=<id>`), the SettingsScreen handles the
  // tab switch (`?tab=schedule`) and we read `?poll=<id>` here to
  // scroll the matching PollCard into view and pulse a highlight ring.
  // After handling, we strip the `poll` param via `navigate(..., {
  // replace: true })` so a refresh doesn't re-trigger the highlight
  // and the back button stays clean.
  const [highlightedPollId, setHighlightedPollId] = useState<string | null>(null);

  // Admin gate: group admin OR group owner OR platform super-admin.
  // Mirrors the canonical check used elsewhere (e.g. App.tsx).
  const isAdmin = role === 'admin' || isOwner || isSuperAdmin;

  const [polls, setPolls] = useState<GamePoll[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [now, setNow] = useState(Date.now());
  const [actionMsg, setActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState<{ pollId: string } | null>(null);
  const [editPoll, setEditPoll] = useState<GamePoll | null>(null);
  const [deletePollConfirm, setDeletePollConfirm] = useState<GamePoll | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [manualClosePending, setManualClosePending] = useState<{ poll: GamePoll; dateId: string } | null>(null);
  const [manualCloseSubmitting, setManualCloseSubmitting] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  // Set of poll IDs the current user has opted in to receive vote-change
  // notifications for. Loaded once on mount and updated optimistically by
  // the toggle button. Admins/owners are always notified (server-side) so
  // we don't need to track their state here.
  const [subscribedPollIds, setSubscribedPollIds] = useState<Set<string>>(() => new Set());

  const reload = useCallback(() => {
    setPolls(getAllPolls());
    setPlayers(getAllPlayers());
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useRealtimeRefresh(reload);

  // Load the current user's vote-change subscriptions once on mount. We
  // don't subscribe to realtime updates here because subscriptions are
  // per-user and only the user's own clicks change them — toggling refreshes
  // local state directly.
  useEffect(() => {
    let cancelled = false;
    getMyPollChangeSubscriptions()
      .then(ids => { if (!cancelled) setSubscribedPollIds(new Set(ids)); })
      .catch(err => console.warn('getMyPollChangeSubscriptions failed:', err));
    return () => { cancelled = true; };
  }, []);

  // Periodic re-tick so "expansion is due" UI updates without realtime
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Deep-link handler: scroll to and highlight the poll referenced by
  // `?poll=<id>`. Runs whenever the URL changes OR `polls` finishes
  // loading (the param can arrive before polls are populated, so we
  // re-check on each polls update). We do not include the highlighted
  // poll in active list explicitly — if the poll has been archived
  // since the share, the lookup misses gracefully and we just leave
  // the user on the Schedule tab without scrolling. Future iteration
  // could auto-expand the archive when the target is archived.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const targetPollId = params.get('poll');
    if (!targetPollId) return;
    if (polls.length === 0) return; // wait for polls to load
    if (!polls.some(p => p.id === targetPollId)) {
      // Poll not in current visible set (archived / wrong group / deleted).
      // Strip the param so we don't keep retrying as the user navigates.
      params.delete('poll');
      navigate({ pathname: location.pathname, search: params.toString() ? `?${params.toString()}` : '' }, { replace: true });
      return;
    }
    // Defer to next paint so PollCards have committed to the DOM.
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(`poll-card-${targetPollId}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        setHighlightedPollId(targetPollId);
      }
      // Strip `poll` from the URL after handling so refresh / back
      // doesn't re-trigger. Preserve `tab=schedule` (and any other
      // params) by mutating the same URLSearchParams.
      params.delete('poll');
      navigate(
        { pathname: location.pathname, search: params.toString() ? `?${params.toString()}` : '' },
        { replace: true }
      );
    });
    return () => cancelAnimationFrame(raf);
  }, [location.search, location.pathname, polls, navigate]);

  // Auto-clear the highlight after the pulse animation finishes (~2s),
  // so re-clicking the same deep-link from the same session can re-pulse.
  useEffect(() => {
    if (!highlightedPollId) return;
    const timer = setTimeout(() => setHighlightedPollId(null), 2200);
    return () => clearTimeout(timer);
  }, [highlightedPollId]);

  const handleToggleSubscription = async (pollId: string) => {
    const isSubscribed = subscribedPollIds.has(pollId);
    // Optimistic update — flip the local Set immediately so the button
    // reflects the new state without waiting for the round-trip.
    setSubscribedPollIds(prev => {
      const next = new Set(prev);
      if (isSubscribed) next.delete(pollId);
      else next.add(pollId);
      return next;
    });
    try {
      if (isSubscribed) {
        await unsubscribeFromPollChanges(pollId);
        showMsg('success', t('schedule.subscribe.unsubscribed'));
      } else {
        await subscribeToPollChanges(pollId);
        showMsg('success', t('schedule.subscribe.subscribed'));
      }
    } catch (e) {
      // Roll back on failure.
      setSubscribedPollIds(prev => {
        const next = new Set(prev);
        if (isSubscribed) next.add(pollId);
        else next.delete(pollId);
        return next;
      });
      showMsg('error', handleRpcError(e));
    }
  };

  // Run scheduler sweep on mount and whenever a poll's status or
  // notification-claim flags change. Previous version only re-ran on
  // polls.length changes, which missed key transitions:
  //   - status: open → expanded (sweep itself triggers expand_poll, but
  //     the resulting 'expanded' state never re-ran the sweep so
  //     sendExpandedInvitations would wait until the next mount).
  //   - status: open/expanded → confirmed via auto-close from a vote
  //     cast on another client.
  //   - any *NotificationsSentAt becoming non-null (so we don't repeat
  //     sweep work that already claimed the notifications).
  // The string key dedups multiple quick realtime updates that produce
  // the same effective state, while still firing the sweep promptly when
  // anything notification-relevant has changed.
  const sweepKey = polls
    .map(p => [
      p.id, p.status,
      p.creationNotificationsSentAt ?? '',
      p.expandedNotificationsSentAt ?? '',
      p.confirmedNotificationsSentAt ?? '',
      p.cancellationNotificationsSentAt ?? '',
    ].join(':'))
    .join('|');
  useEffect(() => {
    runSchedulerSweep().catch(err => console.warn('runSchedulerSweep failed:', err));
  }, [sweepKey]);

  const showMsg = (type: 'success' | 'error', text: string) => {
    setActionMsg({ type, text });
    setTimeout(() => setActionMsg(null), 3500);
  };

  // Map error code from RPC to localized message
  const handleRpcError = (e: unknown): string => {
    const msg = errMsg(e);
    // 'voting_locked' is the migration-039 admin soft-lock; 'poll_locked'
    // is the long-standing terminal-status guard. Order matters — the
    // raw error message can contain both phrases when nested, so we
    // match the more specific one first.
    if (msg.includes('voting_locked')) return t('schedule.errorVotingLocked');
    if (msg.includes('poll_locked')) return t('schedule.errorPollLocked');
    if (msg.includes('seat_full')) return t('schedule.errorSeatFull');
    if (msg.includes('no_player_link')) return t('schedule.errorNoPlayerLink');
    if (msg.includes('tier_not_allowed')) return t('schedule.errorTierNotAllowed');
    if (msg.includes('past_date')) return t('schedule.errorPastDate');
    if (msg.includes('invalid_target')) return t('schedule.errorMinTarget');
    if (msg.includes('maybe_not_allowed')) return t('schedule.errorMaybeNotAllowed');
    if (msg.includes('invalid_date_count')) return t('schedule.errorInvalidDateCount');
    if (msg.includes('not_admin') || msg.includes('not_member')) return t('schedule.errorNotAdmin');
    return t('schedule.errorGeneric');
  };

  // Current user's player record (linked via playerName)
  const currentPlayer = useMemo<Player | null>(() => {
    if (!playerName) return null;
    return players.find(p => p.name === playerName) || null;
  }, [players, playerName]);

  // Day-bucket key: changes once when the calendar day rolls over.
  // We can't depend on `now` directly here — the heartbeat tick updates
  // it every second, which would re-run the partition memo every second
  // for no useful change. Day-bucket is stable for ~24h at a time, so
  // the memo only re-evaluates on poll change or midnight rollover.
  const dayBucket = Math.floor(now / (24 * 60 * 60 * 1000));

  // Partition polls into active vs archive.
  // Two-pass: first detect whether any poll is actionable (voting open or
  // start-game pending) AND has a future date, then route each poll
  // through shouldArchive with that signal plus today's start-of-day
  // timestamp (used by the past-dated rule). This implements both the
  // "new poll → previous round's finished polls collapse to history" UX
  // and the "the game date already passed → archive" auto-cleanup.
  const { activePolls, archivePolls } = useMemo(() => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayStartTs = todayStart.getTime();
    // Live-actionable = currently voting OR confirmed-waiting-to-start
    // AND has at least one future date. A past-dated open poll doesn't
    // count as "new round of activity" — it's junk that's about to
    // archive itself, so we don't let it drag finished polls along.
    const hasActionable = polls.some(p =>
      isActionablePoll(p) && !isPastDatedPoll(p, todayStartTs)
    );
    const a: GamePoll[] = [];
    const h: GamePoll[] = [];
    for (const p of polls) {
      if (shouldArchive(p, hasActionable, todayStartTs)) h.push(p);
      else a.push(p);
    }
    return { activePolls: a, archivePolls: h };
    // dayBucket is read implicitly via the deps array — it's the
    // signal that today rolled over; the memo body still uses
    // `new Date()` for the actual timestamp.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polls, dayBucket]);

  // ── Vote handler ──
  const handleVote = async (poll: GamePoll, dateId: string, response: RsvpResponse) => {
    // Snapshot the current player's response on this date BEFORE calling the
    // RPC. We need this to distinguish a "real change" (yes→no) from a
    // "no-op re-click" (yes→yes), since the server bumps voted_at on
    // every cast_poll_vote call regardless. Without this guard, repeatedly
    // tapping the same active button would spam vote_change notifications
    // because the voted_at vs created_at delta crosses the 5-second
    // threshold immediately.
    const previousVote = currentPlayer
      ? poll.votes.find(v => v.dateId === dateId && v.playerId === currentPlayer.id)
      : null;
    const previousResponse = previousVote?.response ?? null;
    try {
      const updated = await castVote(dateId, response);
      // If this vote crossed the threshold, fire confirmed notifications
      if (updated.status === 'confirmed' && !updated.confirmedNotificationsSentAt) {
        sendConfirmedNotifications(updated).catch(err =>
          console.warn('sendConfirmedNotifications failed:', err));
      }
      // Vote-change notification: fire only if this was an UPDATE that
      // actually CHANGED the response. The voted_at-vs-created_at delta
      // tells us "row existed before"; the previousResponse comparison
      // tells us "the response differs now". Both must be true to avoid
      // pinging admins on a same-response re-click.
      const myVote = updated.votes.find(
        v => v.dateId === dateId && v.playerId === currentPlayer?.id,
      );
      if (myVote && currentPlayer && previousResponse !== null && previousResponse !== response) {
        const delta = new Date(myVote.votedAt).getTime() - new Date(myVote.createdAt).getTime();
        if (delta > VOTE_CHANGE_DETECTION_MS) {
          sendVoteChangeNotifications(updated, myVote, currentPlayer.name, null)
            .catch(err => console.warn('sendVoteChangeNotifications failed:', err));
        }
      }
    } catch (e) {
      showMsg('error', handleRpcError(e));
    }
  };

  // ── Admin action handlers ──
  // Note: editing target / expansion delay / note / location / allow_maybe is
  // now consolidated into EditPollModal (single "Edit" button on PollCard)
  // backed by the update_game_poll_meta RPC. Keeping the call site here so
  // future per-field shortcuts can still be wired in if needed.

  // Opens the in-app manual-close confirmation modal. Native confirm()
  // was unreliable across browsers/embeddings (see deletePollConfirm) and
  // its OS-styled chrome breaks the app's premium look.
  const handleManualClose = (poll: GamePoll, dateId: string) => {
    setManualClosePending({ poll, dateId });
  };

  const performManualClose = async () => {
    if (!manualClosePending || manualCloseSubmitting) return;
    setManualCloseSubmitting(true);
    try {
      const requestedDateId = manualClosePending.dateId;
      const isRepin = manualClosePending.poll.status === 'confirmed';
      await manuallyClosePoll(manualClosePending.poll.id, requestedDateId);
      // Re-fetch the freshly confirmed poll and check whether the RPC
      // actually took effect. The SQL refuses to UPDATE if the status
      // filter excludes the row (e.g., on a confirmed poll when
      // migration 038 isn't applied yet) — `error` stays null and the
      // call resolves cleanly, but the row never changed. We detect
      // that here so the admin sees a clear "nothing happened, check
      // your DB migrations" message instead of clicking a button that
      // silently does nothing. Same check covers the after-game-
      // started guard from 038 (confirmed_game_id IS NOT NULL → no-op).
      const fresh = getAllPolls().find(p => p.id === manualClosePending.poll.id);
      const dateLabel = (() => {
        const d = manualClosePending.poll.dates.find(x => x.id === requestedDateId);
        return d ? fmtHebrewDate(d) : '';
      })();
      if (!fresh || fresh.status !== 'confirmed' || fresh.confirmedDateId !== requestedDateId) {
        showMsg('error', t('schedule.manualCloseNoop'));
      } else {
        sendConfirmedNotifications(fresh).catch(() => {});
        showMsg('success', t(
          isRepin ? 'schedule.manualRepinSuccess' : 'schedule.manualCloseSuccess',
          { date: dateLabel },
        ));
      }
      setManualClosePending(null);
    } catch (e) {
      showMsg('error', handleRpcError(e));
    } finally {
      setManualCloseSubmitting(false);
    }
  };

  // Opens the in-app delete-confirmation modal. Native confirm() was
  // unreliable across browsers/embeddings, so we route through a styled
  // modal that matches the rest of the app (see SettingsScreen patterns).
  const handleDeletePoll = (poll: GamePoll) => {
    setDeletePollConfirm(poll);
  };

  const performDeletePoll = async () => {
    if (!deletePollConfirm || deleteSubmitting) return;
    setDeleteSubmitting(true);
    try {
      await deletePoll(deletePollConfirm.id);
      showMsg('success', t('schedule.deletePollSuccess'));
      setDeletePollConfirm(null);
    } catch (e) {
      showMsg('error', handleRpcError(e));
    } finally {
      setDeleteSubmitting(false);
    }
  };

  // ── Render ──
  return (
    <div style={{ direction: 'rtl', textAlign: isRTL ? 'right' : 'left' }}>
      {/* Header */}
      <div className="card" style={{ marginBottom: 12, padding: 14 }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          // Single-line layout on phones — the heading + ⚙️ + create-CTA used
          // to wrap to two rows at 320–375px. Trimming labels (HE: "פתיחת
          // הצבעה" → "+ הצבעה"; EN: "Open poll" → "+ Poll") and tightening
          // the gear chip lets the row hold one line down to a 280px card.
          // `min-width: 0` on the h2 lets the title truncate rather than
          // force a wrap, and `flex-shrink: 0` on the action group keeps
          // the buttons their natural size.
          gap: 6,
        }}>
          <h2 style={{
            margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--text)',
            minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            📅 {t('schedule.tabTitle')}
          </h2>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
            {/* Primary first in DOM order so under RTL it sits at the
                right (where the eye lands), settings gear demotes
                to the left as a secondary chip. */}
            {isAdmin && (
              <button
                onClick={() => setShowCreateModal(true)}
                style={{
                  padding: '7px 12px', borderRadius: 8, border: 'none',
                  background: 'var(--primary)', color: '#fff', fontWeight: 600,
                  fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap',
                }}>
                {activePolls.length === 0 && archivePolls.length === 0
                  ? t('schedule.empty.createFirst')
                  : t('schedule.create')}
              </button>
            )}
            {isAdmin && (
              <button
                onClick={() => setShowConfig(s => !s)}
                title={t('schedule.config')}
                style={{
                  padding: '7px 9px', borderRadius: 8,
                  border: '1px solid var(--border)', background: 'transparent',
                  color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14,
                  lineHeight: 1,
                }}>
                ⚙️
              </button>
            )}
          </div>
        </div>
        {showConfig && isAdmin && (
          <ScheduleConfigPanel
            onSuccess={(text) => showMsg('success', text)}
            onError={(text) => showMsg('error', text)}
            t={t}
          />
        )}
        {actionMsg && (
          <div style={{
            marginTop: 10, padding: '8px 12px', borderRadius: 6,
            background: actionMsg.type === 'success' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
            color: actionMsg.type === 'success' ? '#10b981' : '#ef4444',
            fontSize: 13,
          }}>
            {actionMsg.text}
          </div>
        )}
      </div>

      {/* Empty state — CTA lives in the header to keep a single
          create button across both empty and populated states. */}
      {activePolls.length === 0 && archivePolls.length === 0 && (
        <div className="card" style={{ padding: 24, textAlign: 'center' }}>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8, color: 'var(--text)' }}>
            {t('schedule.empty.heading')}
          </div>
          <div style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            {t('schedule.empty.explainer')}
          </div>
        </div>
      )}

      {/* Active polls */}
      {activePolls.map(poll => (
        <div
          key={poll.id}
          id={`poll-card-${poll.id}`}
          className={highlightedPollId === poll.id ? 'poll-card-deeplink-highlight' : undefined}
        >
        {/* Card body picker: same props go into both variants — the
            two render the exact same data with the same handlers,
            differing only in visual layout. Compact lives in a
            sandbox tab while we validate full feature parity. */}
        {variant === 'compact' ? (
          <PollCardCompact
            poll={poll}
            players={players}
            currentPlayer={currentPlayer}
            isAdmin={isAdmin}
            now={now}
            onVote={handleVote}
            onEdit={() => setEditPoll(poll)}
            onManualClose={(dateId) => handleManualClose(poll, dateId)}
            onCancel={() => setShowCancelModal({ pollId: poll.id })}
            onDelete={() => handleDeletePoll(poll)}
            isSubscribed={subscribedPollIds.has(poll.id)}
            onToggleSubscription={() => handleToggleSubscription(poll.id)}
            onError={(text) => showMsg('error', text)}
            onSuccess={(text) => showMsg('success', text)}
            handleRpcError={handleRpcError}
            navigate={navigate}
            t={t}
          />
        ) : (
          <PollCard
            poll={poll}
            players={players}
            currentPlayer={currentPlayer}
            isAdmin={isAdmin}
            now={now}
            onVote={handleVote}
            onEdit={() => setEditPoll(poll)}
            onManualClose={(dateId) => handleManualClose(poll, dateId)}
            onCancel={() => setShowCancelModal({ pollId: poll.id })}
            onDelete={() => handleDeletePoll(poll)}
            isSubscribed={subscribedPollIds.has(poll.id)}
            onToggleSubscription={() => handleToggleSubscription(poll.id)}
            onError={(text) => showMsg('error', text)}
            onSuccess={(text) => showMsg('success', text)}
            handleRpcError={handleRpcError}
            navigate={navigate}
            t={t}
          />
        )}
        </div>
      ))}

      {/* Archive (history) */}
      {archivePolls.length > 0 && (
        <div className="card" style={{ padding: 12, marginTop: 12 }}>
          <button
            onClick={() => setShowHistory(s => !s)}
            style={{
              width: '100%', textAlign: isRTL ? 'right' : 'left',
              padding: '8px 12px', borderRadius: 6,
              background: 'transparent', border: '1px solid var(--border)',
              color: 'var(--text)', fontSize: 14, fontWeight: 600, cursor: 'pointer',
            }}>
            {showHistory ? t('schedule.closeHistory') : `${t('schedule.history')} (${archivePolls.length})`}
          </button>
          {showHistory && (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {archivePolls.map(p => {
                const confirmedDate = p.dates.find(d => d.id === p.confirmedDateId);
                const yesCount = p.votes.filter(v => v.dateId === p.confirmedDateId && v.response === 'yes').length;
                const statusBg = p.status === 'cancelled' ? 'rgba(239, 68, 68, 0.10)'
                  : p.status === 'expired' ? 'rgba(234, 179, 8, 0.10)'
                  : 'rgba(16, 185, 129, 0.10)';
                const statusColor = p.status === 'cancelled' ? '#ef4444'
                  : p.status === 'expired' ? '#eab308'
                  : '#10b981';
                const statusLabel = p.status === 'cancelled' ? t('schedule.statusCancelled')
                  : p.status === 'expired' ? t('schedule.statusExpired')
                  : t('schedule.gameStarted');
                return (
                  <div key={p.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '10px 12px', borderRadius: 6,
                    background: 'var(--surface-elevated, var(--surface))',
                    border: '1px solid var(--border)',
                  }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{
                          padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700,
                          background: statusBg, color: statusColor,
                          border: `1px solid ${statusColor}55`,
                        }}>
                          {statusLabel}
                        </span>
                        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          {new Date(p.createdAt).toLocaleDateString('he-IL')}
                        </span>
                        {confirmedDate && (
                          <span style={{ fontSize: 12, color: 'var(--text)' }}>
                            📅 {fmtHebrewDate(confirmedDate)}
                            {yesCount > 0 && (
                              // Past-tense label ("אישרו" / "Confirmed"),
                              // not the action-oriented vote button text
                              // ("מגיע" / "I'm in"), since this is an
                              // archived/confirmed poll showing how many
                              // players ended up confirmed.
                              <span style={{ color: 'var(--text-muted)' }}>{` · ${yesCount} ${t('schedule.voters.yes')}`}</span>
                            )}
                          </span>
                        )}
                      </div>
                      {p.cancellationReason && (
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                          💬 {p.cancellationReason}
                        </div>
                      )}
                      {p.note && !p.cancellationReason && (
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                          {p.note}
                        </div>
                      )}
                    </div>
                    {isAdmin && (
                      <button
                        onClick={() => handleDeletePoll(p)}
                        title={t('schedule.deletePoll')}
                        style={{
                          padding: '6px 10px', borderRadius: 6,
                          border: '1px dashed rgba(239, 68, 68, 0.5)',
                          background: 'transparent', color: '#ef4444',
                          fontSize: 12, fontWeight: 500, cursor: 'pointer',
                          flex: 'none',
                        }}>
                        {t('schedule.deletePollShort')}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Create Poll modal */}
      {showCreateModal && (
        <CreatePollModal
          onClose={() => setShowCreateModal(false)}
          onError={(text) => showMsg('error', text)}
          onSuccess={(text) => showMsg('success', text)}
          handleRpcError={handleRpcError}
          t={t}
        />
      )}

      {/* Cancel Poll modal */}
      {showCancelModal && (
        <CancelPollModal
          pollId={showCancelModal.pollId}
          onClose={() => setShowCancelModal(null)}
          onError={(text) => showMsg('error', text)}
          onSuccess={(text) => showMsg('success', text)}
          handleRpcError={handleRpcError}
          t={t}
        />
      )}

      {/* Edit Poll modal — single consolidated editor for note, target,
          expansion delay, default location, and allow_maybe. Replaces the
          old per-field prompt() flows. */}
      {editPoll && (
        <EditPollModal
          poll={editPoll}
          onClose={() => setEditPoll(null)}
          onError={(text) => showMsg('error', text)}
          onSuccess={(text) => showMsg('success', text)}
          handleRpcError={handleRpcError}
          t={t}
        />
      )}

      {/* Delete Poll confirmation modal — admin-only destructive action.
          Active polls show an additional warning recommending Cancel first. */}
      {deletePollConfirm && (() => {
        const isActive = deletePollConfirm.status === 'open' || deletePollConfirm.status === 'expanded';
        return (
          <ModalPortal>
          <div className="modal-overlay" onClick={() => !deleteSubmitting && setDeletePollConfirm(null)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h3 className="modal-title">{t('schedule.deletePollConfirmTitle')}</h3>
                <button
                  className="modal-close"
                  onClick={() => setDeletePollConfirm(null)}
                  disabled={deleteSubmitting}
                  aria-label={t('common.close')}
                >×</button>
              </div>
              {isActive && (
                <p style={{ marginBottom: '0.75rem', color: '#ef4444', fontWeight: 600 }}>
                  ⚠️ {t('schedule.deletePollConfirmActive')}
                </p>
              )}
              <p className="text-muted" style={{ fontSize: '0.9rem', marginBottom: '1rem', lineHeight: 1.5 }}>
                {t('schedule.deletePollConfirm')}
              </p>
              <div className="actions">
                <button
                  className="btn btn-secondary"
                  onClick={() => setDeletePollConfirm(null)}
                  disabled={deleteSubmitting}
                >
                  {t('common.cancel')}
                </button>
                <button
                  className="btn"
                  onClick={performDeletePoll}
                  disabled={deleteSubmitting}
                  style={{
                    background: '#ef4444', color: '#fff', fontWeight: 600,
                    opacity: deleteSubmitting ? 0.7 : 1,
                    cursor: deleteSubmitting ? 'wait' : 'pointer',
                  }}
                >
                  {deleteSubmitting ? '...' : t('schedule.deletePollConfirmAction')}
                </button>
              </div>
            </div>
          </div>
          </ModalPortal>
        );
      })()}

      {/* Manual close confirmation modal — admin-only. Replaces the
          native confirm() dialog so the UX matches the rest of the app
          (premium chrome, RTL-aware, dismiss-on-overlay). The action
          flips the poll to 'confirmed' on the chosen date and drops
          the other proposed dates, so we surface the date prominently. */}
      {manualClosePending && (() => {
        const date = manualClosePending.poll.dates.find(d => d.id === manualClosePending.dateId);
        const dateLabel = date ? fmtHebrewDate(date) : '';
        // Re-pin path uses different copy than initial close so the
        // modal accurately reflects the action: "lock in" vs "switch
        // the lock to". Detected by whether the poll is already in
        // a confirmed state when the admin opened the dialog.
        const isRepin = manualClosePending.poll.status === 'confirmed';
        const titleKey       = isRepin ? 'schedule.manualRepinConfirmTitle'  : 'schedule.manualCloseConfirmTitle';
        const bodyKey        = isRepin ? 'schedule.manualRepinConfirmBody'   : 'schedule.manualCloseConfirmBody';
        const actionLabelKey = isRepin ? 'schedule.manualRepinConfirmAction' : 'schedule.manualCloseConfirmAction';
        return (
          <ModalPortal>
          <div className="modal-overlay" onClick={() => !manualCloseSubmitting && setManualClosePending(null)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h3 className="modal-title">{t(titleKey)}</h3>
                <button
                  className="modal-close"
                  onClick={() => setManualClosePending(null)}
                  disabled={manualCloseSubmitting}
                  aria-label={t('common.close')}
                >×</button>
              </div>
              <p className="text-muted" style={{ fontSize: '0.9rem', marginBottom: '1rem', lineHeight: 1.5 }}>
                {t(bodyKey, { date: dateLabel })}
              </p>
              <div className="actions">
                <button
                  className="btn btn-secondary"
                  onClick={() => setManualClosePending(null)}
                  disabled={manualCloseSubmitting}
                >
                  {t('common.cancel')}
                </button>
                <button
                  className="btn"
                  onClick={performManualClose}
                  disabled={manualCloseSubmitting}
                  style={{
                    background: '#10b981', color: '#fff', fontWeight: 600,
                    opacity: manualCloseSubmitting ? 0.7 : 1,
                    cursor: manualCloseSubmitting ? 'wait' : 'pointer',
                  }}
                >
                  {manualCloseSubmitting ? '...' : t(actionLabelKey)}
                </button>
              </div>
            </div>
          </div>
          </ModalPortal>
        );
      })()}
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────

export interface PollCardProps {
  poll: GamePoll;
  players: Player[];
  currentPlayer: Player | null;
  isAdmin: boolean;
  now: number;
  onVote: (poll: GamePoll, dateId: string, response: RsvpResponse) => void;
  onEdit: () => void;
  onManualClose: (dateId: string) => void;
  isSubscribed: boolean;
  onToggleSubscription: () => void;
  onCancel: () => void;
  onDelete: () => void;
  onError: (text: string) => void;
  onSuccess: (text: string) => void;
  handleRpcError: (e: unknown) => string;
  navigate: ReturnType<typeof useNavigate>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

function PollCard(props: PollCardProps) {
  const {
    poll, players, currentPlayer, isAdmin, now,
    onVote, onEdit, onManualClose, onCancel, onDelete,
    isSubscribed, onToggleSubscription,
    onError, onSuccess, handleRpcError, navigate, t,
  } = props;

  const playerById = useMemo(() => new Map(players.map(p => [p.id, p])), [players]);

  // Compute per-date yes/maybe/no counts + proxy-vote breakdown
  const dateStats = useMemo(() => {
    const stats = new Map<string, DateStat>();
    for (const d of poll.dates) {
      stats.set(d.id, { yes: 0, maybe: 0, no: 0, voters: [], proxyCount: 0 });
    }
    for (const v of poll.votes) {
      const s = stats.get(v.dateId);
      if (!s) continue;
      s[v.response]++;
      // A vote is "proxy" iff cast_by_user_id is set AND differs from the
      // voter's own user_id (or the voter is unregistered i.e. user_id NULL).
      const isProxy = !!v.castByUserId && (v.userId == null || v.castByUserId !== v.userId);
      s.voters.push({
        playerId: v.playerId,
        response: v.response,
        isProxy,
        votedAt: v.votedAt,
        createdAt: v.createdAt,
        castByUserId: v.castByUserId ?? null,
      });
      if (isProxy) s.proxyCount++;
    }
    return stats;
  }, [poll]);

  // Best (most yes) date
  const bestDateYes = useMemo(() => {
    let max = 0;
    for (const s of dateStats.values()) { if (s.yes > max) max = s.yes; }
    return max;
  }, [dateStats]);

  // Resolve user_id → player.name for proxy-vote attribution. We derive
  // the mapping from every self-cast vote across all polls — when
  // userId === castByUserId, the playerId on that row tells us which
  // player belongs to that auth user. Admins are typically permanent
  // players who self-vote on at least one poll, so this covers the
  // common case without requiring a server RPC. Falls back to a
  // generic label when the actor has never voted themselves.
  const userIdToPlayerName = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of getAllPolls()) {
      for (const v of p.votes) {
        if (!v.userId || v.castByUserId !== v.userId) continue;
        const name = playerById.get(v.playerId)?.name;
        if (name) m.set(v.userId, name);
      }
    }
    return m;
    // poll dependency catches incoming realtime updates; playerById covers
    // roster edits. We intentionally don't include getAllPolls() in deps
    // because it returns the same in-memory snapshot mutated in place,
    // and the cache-update event triggers PollCard re-renders via the
    // parent's useRealtimeRefresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poll, playerById]);

  // Per-date current-user vote
  const currentUserVoteByDate = useMemo(() => {
    const m = new Map<string, RsvpResponse>();
    if (!currentPlayer) return m;
    for (const v of poll.votes) {
      if (v.playerId === currentPlayer.id) m.set(v.dateId, v.response);
    }
    return m;
  }, [poll.votes, currentPlayer]);

  // Migration 039: admin-toggleable soft lock on still-active polls.
  // When set, the SQL guard rejects every vote RPC with 'voting_locked'.
  // Boolean form derived once; used everywhere RSVP / proxy buttons gate.
  const isVotingLocked = !!poll.votingLockedAt;

  const canVote = useMemo(() => {
    if (!currentPlayer) return { allowed: false, reason: 'no_player_link' as const };
    // Voting is allowed on open / expanded / confirmed. Confirmed-state
    // voting (added in migration 031) lets members "change their mind"
    // — drop out, add a late "yes", etc. — without un-confirming the
    // game. Cancelled and expired stay locked.
    if (poll.status === 'cancelled' || poll.status === 'expired') {
      return { allowed: false, reason: 'poll_locked' as const };
    }
    // Migration 039: admin-flipped soft lock. Independent of status —
    // freezes all votes (including admin proxies) until unlocked.
    if (isVotingLocked) {
      return { allowed: false, reason: 'voting_locked' as const };
    }
    // Tier gate. Mirrors the SQL in 031:
    //   * 'open'      → permanents only (the original 48h window).
    //   * 'expanded'  → all tiers.
    //   * 'confirmed' → preserve the eligibility the poll had at the
    //     moment it was confirmed. expanded_at NULL means it confirmed
    //     during the permanents-only phase, so non-permanents stay out.
    if (poll.status === 'open' && currentPlayer.type !== 'permanent') {
      return { allowed: false, reason: 'tier_not_allowed' as const };
    }
    if (poll.status === 'confirmed'
        && !poll.expandedAt
        && currentPlayer.type !== 'permanent') {
      return { allowed: false, reason: 'tier_not_allowed' as const };
    }
    return { allowed: true as const };
  }, [poll.status, poll.expandedAt, currentPlayer, isVotingLocked]);

  // Admin proxy-vote modal state — keyed by date id; null when closed.
  const [proxyDateId, setProxyDateId] = useState<string | null>(null);

  // Per-date "show voters" toggle. Keyed by date.id, value=true means
  // expanded. Default is collapsed (empty Set ⇒ all collapsed) so the
  // schedule tab stays compact on mobile — a confirmed date with 6+
  // proxy-voter chips can otherwise push the card past 500px tall and
  // bury the action row + share buttons below the fold. Tapping the
  // header / "show voters" toggle in a row expands just that row's
  // chip list. State is local to the card; resets on remount (e.g.
  // after a tab switch), which is fine — the collapsed view always
  // shows the count totals so the user never loses critical info.
  const [expandedVoterDates, setExpandedVoterDates] = useState<Set<string>>(() => new Set());
  const toggleVotersExpanded = (dateId: string) => {
    setExpandedVoterDates(prev => {
      const next = new Set(prev);
      if (next.has(dateId)) next.delete(dateId); else next.add(dateId);
      return next;
    });
  };

  // Share-target chooser modal. Only opens when a poll is in the
  // genuinely-ambiguous "confirmed-below-target" state where BOTH
  // sharing the invitation (recruiting) and sharing the confirmation
  // (announcing) make sense. Open / expanded polls share the
  // invitation directly with one tap; confirmed-at-target polls
  // share the confirmation directly. Only the rare ambiguous state
  // pays the cost of an extra modal step — and gets a one-line
  // explanation in return so the admin understands why two options
  // exist instead of guessing from two near-identical button labels.
  const [shareChooserOpen, setShareChooserOpen] = useState(false);

  // Confirmed date helpers
  const confirmedDate = poll.dates.find(d => d.id === poll.confirmedDateId);
  const confirmedPlayers = useMemo(() => {
    if (!confirmedDate) return [] as Player[];
    return poll.votes
      .filter(v => v.dateId === confirmedDate.id && v.response === 'yes')
      .map(v => playerById.get(v.playerId))
      .filter((p): p is Player => !!p);
  }, [confirmedDate, poll.votes, playerById]);

  // Seat-open detection on a confirmed poll. Confirmation is one-way at
  // the SQL level (migration 031) — status, confirmed_date, and
  // confirmed_at stay pinned. But when the yes-count slips below target
  // (someone dropped out post-lock-in), voting is *effectively* open
  // again on that locked date, and the card should read that way: same
  // chrome as an open/expanded poll, same date row, same share-card
  // mode (invitation, not confirmation). We derive a `visualStatus` for
  // chrome decisions; behavior keys still off `poll.status` where the
  // distinction matters (e.g. tier gate on cast_poll_vote, the
  // auto-confirm trigger that only re-fires while status='open'/'expanded').
  const confirmedDateYes = confirmedDate
    ? (dateStats.get(confirmedDate.id)?.yes ?? 0)
    : 0;
  const isConfirmedBelowTarget =
    poll.status === 'confirmed' && confirmedDateYes < poll.targetPlayerCount;
  const visualStatus: typeof poll.status = isConfirmedBelowTarget
    ? (poll.expandedAt ? 'expanded' : 'open')
    : poll.status;

  // Status palette + icon glyphs.
  // Notes:
  //   * `expanded` is intentionally amber-orange (#f97316) so it doesn't
  //     collide with the maybe / proxy yellows used elsewhere in the card.
  //   * Each status carries a tiny glyph that prefixes the pill so users
  //     can scan a long poll list without reading every label.
  const STATUS_META: Record<string, { color: string; icon: string }> = {
    open:      { color: '#3b82f6', icon: '🔵' },
    expanded:  { color: '#f97316', icon: '🟠' },
    confirmed: { color: '#10b981', icon: '✅' },
    cancelled: { color: '#ef4444', icon: '🛑' },
    expired:   { color: '#94a3b8', icon: '⌛' },
  };
  const statusColor: Record<string, string> = {
    open: STATUS_META.open.color,
    expanded: STATUS_META.expanded.color,
    confirmed: STATUS_META.confirmed.color,
    cancelled: STATUS_META.cancelled.color,
    expired: STATUS_META.expired.color,
  };

  // Expansion-due indicator
  const expansionDueAt = new Date(poll.createdAt).getTime() + poll.expansionDelayHours * 3600_000;
  const isExpansionDue = poll.status === 'open' && now >= expansionDueAt;

  // ─── WhatsApp screenshot share ─────────────────────────
  const shareCardRef = useRef<HTMLDivElement>(null);
  const [shareMode, setShareMode] = useState<'invitation' | 'confirmation' | 'cancellation' | null>(null);
  const [isSharing, setIsSharing] = useState(false);

  const captureShare = useCallback(async (
    mode: 'invitation' | 'confirmation' | 'cancellation',
    baseName: string,
    title: string,
    caption: string,
  ) => {
    if (isSharing) return;
    setShareMode(mode);
    setIsSharing(true);
    try {
      // Wait for two animation frames so React has committed the share-card DOM
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (!shareCardRef.current) return;
      const files = await captureAndSplit(shareCardRef.current, baseName, { backgroundColor: '#0f172a' });
      await shareFiles(files, title, caption);
    } catch (e) {
      onError(handleRpcError(e));
    } finally {
      setIsSharing(false);
      setShareMode(null);
    }
  }, [isSharing, onError, handleRpcError]);

  // Build the per-mode caption: a short Hebrew/English line that matches
  // the mode's intent (vote / view details / heads-up about cancellation),
  // followed by a deep-link URL on its own line. WhatsApp linkifies URLs
  // in captions, so the recipient gets a tappable link that lands them
  // directly on the Schedule tab and scrolls to *this specific poll*
  // instead of just the app's home page.
  //
  // The URL uses the short-form `/p/<token>` route (App.tsx →
  // PollDeepLinkRedirect). `<token>` is the 6-char base32 share slug
  // (migration 040) when available, falling back to the full poll
  // UUID for old in-flight rows that haven't been backfilled yet
  // (the migration backfills on apply, so this is a transient
  // window). The slug form lands as `https://app.com/p/7g4xq2`
  // (~52 chars total) — short enough to fit on a single tappable
  // line in WhatsApp on every phone, vs the UUID form which often
  // wraps mid-uuid into a noisy multi-line blob.
  //
  // The route handler accepts both shapes and resolves the slug to
  // a UUID via `resolve_poll_share_slug` before redirecting, so old
  // long-form share links from earlier versions keep working.
  //
  // The bare origin still appears INSIDE the share image (a clean,
  // typeable fallback) — only the WhatsApp caption gets the deep
  // link, so the image stays uncluttered.
  //
  // Falls back to caption-only when window isn't available (SSR).
  const buildShareCaption = (mode: 'invitation' | 'confirmation' | 'cancellation'): string => {
    const captionKey = (
      mode === 'invitation'   ? 'schedule.share.captionInvitation' :
      mode === 'confirmation' ? 'schedule.share.captionConfirmation' :
                                'schedule.share.captionCancellation'
    ) as TranslationKey;
    const line = t(captionKey);
    if (typeof window === 'undefined') return line;
    const linkToken = poll.shareSlug ?? poll.id;
    const deepLink = `${window.location.origin}/p/${encodeURIComponent(linkToken)}`;
    return `${line}\n${deepLink}`;
  };

  const handleShareInvitation = () => captureShare(
    'invitation',
    `poker-poll-invitation-${poll.id.slice(0, 8)}`,
    t('schedule.share.invitationTitle'),
    buildShareCaption('invitation'),
  );
  const handleShareConfirmation = () => captureShare(
    'confirmation',
    `poker-poll-confirmed-${poll.id.slice(0, 8)}`,
    t('schedule.share.confirmationTitle'),
    buildShareCaption('confirmation'),
  );
  const handleShareCancellation = () => captureShare(
    'cancellation',
    `poker-poll-cancelled-${poll.id.slice(0, 8)}`,
    t('schedule.share.cancellationTitle'),
    buildShareCaption('cancellation'),
  );

  // Lock / unlock toggle (migration 039). Reversible single-click
  // action — no confirmation modal, no destructive consequences. The
  // RPC is idempotent at the SQL level, but we still gate on a local
  // submitting flag so a double-tap doesn't fire two requests in
  // flight. Success/error toasts surface the new state so the admin
  // gets immediate confirmation.
  const [lockSubmitting, setLockSubmitting] = useState(false);
  const handleToggleVotingLock = async () => {
    if (lockSubmitting) return;
    setLockSubmitting(true);
    const nextLocked = !isVotingLocked;
    try {
      await setPollVotingLock(poll.id, nextLocked);
      onSuccess(nextLocked
        ? t('schedule.votingLockedSuccess')
        : t('schedule.votingUnlockedSuccess'));
    } catch (e) {
      onError(handleRpcError(e));
    } finally {
      setLockSubmitting(false);
    }
  };

  // Chrome (status pill, border, progress, hints) follows visualStatus
  // so a confirmed-below-target poll reads as voting-open. Behavior
  // (vote eligibility, auto-confirm trigger, share button defaults)
  // continues to key off poll.status where the distinction matters.
  const statusMeta = STATUS_META[visualStatus] || STATUS_META.open;
  const visualStatusLabelKey = `schedule.status${visualStatus.charAt(0).toUpperCase() + visualStatus.slice(1)}`;

  return (
    <div className="card poll-card" style={{ padding: 14, marginBottom: 12, borderRight: `4px solid ${statusColor[visualStatus] || 'var(--border)'}` }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            className="poll-status-pill"
            style={{
              background: `${statusMeta.color}1f`,
              color: statusMeta.color,
              borderColor: `${statusMeta.color}55`,
            }}>
            <span aria-hidden style={{ fontSize: 10 }}>{statusMeta.icon}</span>
            {t(visualStatusLabelKey as TranslationKey)}
          </span>
          {visualStatus !== 'confirmed' && visualStatus !== 'cancelled' && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {t('schedule.targetProgress', { count: bestDateYes, target: poll.targetPlayerCount })}
            </span>
          )}
          {/* Open-seats hint during voting — same friendly copy used after
              confirmation. Surfaces only when at least one yes-vote is in
              and the count is still below target, so a fresh poll with
              0 yes-votes doesn't shout "7 seats still open" the moment it
              opens. Includes confirmed-below-target via visualStatus. */}
          {(visualStatus === 'open' || visualStatus === 'expanded')
            && bestDateYes > 0
            && bestDateYes < poll.targetPlayerCount && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
              💡 {(poll.targetPlayerCount - bestDateYes) === 1
                ? t('schedule.openSeats.singular')
                : t('schedule.openSeats.plural', { missing: poll.targetPlayerCount - bestDateYes })}
            </span>
          )}
          {isExpansionDue && (
            <span style={{ fontSize: 11, color: '#f59e0b' }} title={t('schedule.timer.openPhaseDue')}>⏰</span>
          )}
          {/* Voting-locked badge (migration 039). Renders inline next
              to the status pill so the locked state is visible at a
              glance — admins scanning the polls list immediately see
              which polls are frozen, and members get a clear "voting
              is locked" cue before tapping the (disabled) RSVP buttons.
              Yellow tinted to match the same warning palette used by
              the lock toggle button below in the action row. */}
          {isVotingLocked && (
            <span
              title={t('schedule.errorVotingLocked')}
              style={{
                fontSize: 11, fontWeight: 600,
                padding: '2px 8px', borderRadius: 999,
                background: 'rgba(250, 204, 21, 0.14)',
                color: '#facc15',
                border: '1px solid rgba(250, 204, 21, 0.40)',
              }}
            >
              {t('schedule.votingLockedBadge')}
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {new Date(poll.createdAt).toLocaleDateString('he-IL')}
        </div>
      </div>

      {/* Phase-aware countdown banner. Hidden on cancelled/expired polls. */}
      <PollTimer poll={poll} now={now} t={t} />

      {poll.note && (
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>
          {t('schedule.notePrefix')} {poll.note}
        </div>
      )}

      {/* Confirmed banner — only when the seat is full. When the
          yes-count slips below target post-lock-in, we skip the
          banner and fall through to the open-poll date list below
          (see visualStatus), so the card reads as "voting still open
          for the missing seat" instead of "GAME LOCKED IN". The
          green pulse + ✅ identity is reserved for the at-target,
          truly-locked state. */}
      {/* Confirmed banner — only for single-date confirmed polls. With
          2+ dates we show the competition strip + full per-date list
          below instead, so the winner stays visible alongside the
          competition. The "this game is locked in" identity then
          comes from the status pill + the strip's ✅ on the leader
          row, which avoids a heavy double-render of the confirmed
          date's RSVP buttons + voter list. */}
      {poll.status === 'confirmed' && !isConfirmedBelowTarget && confirmedDate && poll.dates.length < 2 && (() => {
        const s = dateStats.get(confirmedDate.id) || {
          yes: 0, maybe: 0, no: 0, voters: [], proxyCount: 0,
        };
        const myVote = currentUserVoteByDate.get(confirmedDate.id);
        // This branch only renders when the seat is FULL — drops below
        // target are handled by the open-poll layout below (visualStatus
        // pivot). So the open-seats CTA / button highlight that lived
        // here are unnecessary now.
        return (
          <div className="poll-confirmed-banner">
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              flexWrap: 'wrap', gap: 6, marginBottom: 8,
            }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
                ✅ {fmtHebrewDate(confirmedDate)}
                {(confirmedDate.location || poll.defaultLocation) && (
                  <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                    {` — ${confirmedDate.location || poll.defaultLocation}`}
                  </span>
                )}
              </div>
              <div style={{
                fontSize: 12, color: 'var(--text-muted)',
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                {s.proxyCount > 0 && (
                  <span title={t('schedule.proxy.taglineTooltip')} style={{
                    padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
                    background: 'rgba(250, 204, 21, 0.14)', color: '#facc15',
                    border: '1px solid rgba(250, 204, 21, 0.40)',
                  }}>
                    {t('schedule.proxy.tagline', { count: s.proxyCount })}
                  </span>
                )}
                <VoteCountPills
                  yes={s.yes}
                  maybe={s.maybe}
                  no={s.no}
                  allowMaybe={poll.allowMaybe}
                  t={t}
                />
              </div>
            </div>
            {/* Inline RSVP buttons — members can still change their mind
                after confirmation (migration 031 loosened cast_poll_vote
                to allow status='confirmed'). canVote enforces the same
                tier eligibility the poll had at confirmation, so a poll
                that confirmed during the permanents-only phase stays
                permanent-only. */}
            <div style={{
              display: 'flex', gap: 6, marginTop: 4, marginBottom: 8, flexWrap: 'wrap',
              alignItems: 'center',
            }}>
              {(['yes', 'maybe', 'no'] as RsvpResponse[]).map(resp => {
                if (resp === 'maybe' && !poll.allowMaybe) return null;
                const active = myVote === resp;
                const colorMap: Record<RsvpResponse, string> = {
                  yes: '#10b981', maybe: '#eab308', no: '#ef4444',
                };
                const labelMap: Record<RsvpResponse, string> = {
                  yes: t('schedule.rsvpYes'),
                  maybe: t('schedule.rsvpMaybe'),
                  no: t('schedule.rsvpNo'),
                };
                // Seat-cap on yes upgrades. The SQL is the source of
                // truth (migration 037 raises 'seat_full'), but we
                // disable the button proactively so users get instant
                // feedback instead of a round-trip error toast. Idempotent
                // re-votes ('yes' → 'yes') stay enabled because the
                // server treats them as a no-op (count unchanged).
                const wouldOverfill =
                  resp === 'yes' && !active && s.yes >= poll.targetPlayerCount;
                const disabled = !canVote.allowed || wouldOverfill;
                return (
                  <button
                    key={resp}
                    disabled={disabled}
                    onClick={() => onVote(poll, confirmedDate.id, resp)}
                    title={
                      wouldOverfill ? t('schedule.errorSeatFull') :
                      canVote.allowed ? '' :
                      canVote.reason === 'no_player_link' ? t('schedule.errorNoPlayerLink') :
                      canVote.reason === 'tier_not_allowed' ? t('schedule.errorTierNotAllowed') :
                      canVote.reason === 'voting_locked' ? t('schedule.errorVotingLocked') :
                      t('schedule.errorPollLocked')
                    }
                    className={`poll-rsvp-btn${active ? ' poll-rsvp-btn--active' : ''}`}
                    style={{
                      padding: '6px 12px', borderRadius: 8,
                      border: active ? `1.5px solid ${colorMap[resp]}` : '1px solid var(--border)',
                      background: active ? `${colorMap[resp]}1f` : 'transparent',
                      color: active ? colorMap[resp] : 'var(--text)',
                      fontWeight: active ? 700 : 500, fontSize: 13,
                      cursor: disabled ? 'not-allowed' : 'pointer',
                      opacity: disabled ? 0.4 : 1,
                    }}>{labelMap[resp]}</button>
                );
              })}
              {isAdmin && (
                <button
                  onClick={() => setProxyDateId(confirmedDate.id)}
                  disabled={isVotingLocked}
                  title={isVotingLocked
                    ? t('schedule.errorVotingLocked')
                    : t('schedule.proxy.modalTitle')}
                  className="poll-rsvp-btn"
                  style={{
                    padding: '6px 10px', borderRadius: 8,
                    border: '1px solid rgba(16, 185, 129, 0.4)',
                    background: 'rgba(16, 185, 129, 0.12)',
                    color: '#34d399', fontSize: 11, fontWeight: 600,
                    cursor: isVotingLocked ? 'not-allowed' : 'pointer',
                    opacity: isVotingLocked ? 0.4 : 1,
                  }}>{t('schedule.proxy.add')}</button>
              )}
            </div>
            {/* Helper hint for members — only when voting is allowed.
                Keeps the affordance discoverable without nagging users
                whose tier excludes them or whose link is broken. */}
            {canVote.allowed && (
              <div style={{
                fontSize: 11, color: 'var(--text-muted)', marginBottom: 8,
                fontStyle: 'italic',
              }}>
                {t('schedule.confirmedCanChange')}
              </div>
            )}
            {/* Full voter breakdown — yes / maybe / no groups, same
                component used for live polls. Realtime updates flow
                in continuously so the roster reflects every change. */}
            <VoterGroups
              voters={s.voters}
              playerById={playerById}
              userIdToPlayerName={userIdToPlayerName}
              allowMaybe={poll.allowMaybe}
              t={t}
            />
          </div>
        );
      })()}

      {/* Cancelled reason */}
      {poll.status === 'cancelled' && poll.cancellationReason && (
        <div style={{
          padding: 10, borderRadius: 6, marginBottom: 10,
          background: 'rgba(239, 68, 68, 0.08)', fontSize: 13, color: 'var(--text-muted)',
        }}>
          💬 {poll.cancellationReason}
        </div>
      )}

      {/* Per-date rows. Renders for:
            - open / expanded polls (visualStatus pivot pulls confirmed-
              below-target into this branch too — voting is back live).
            - multi-date confirmed-at-target polls (so the competition
              strip + all proposed dates stay visible alongside the
              winner; admins can re-pin to a runner-up if needed).
          Single-date confirmed-at-target polls are handled by the
          dedicated confirmed banner above — re-rendering the same date
          here would double-print the RSVP controls and voter list.
          Migration 031 allows vote changes on confirmed polls so
          members can flip yes↔no on the locked date and record votes
          on runner-up dates (useful when a seat slips and someone
          wants to signal "I'd come Thursday but not Tuesday"). */}
      {(visualStatus === 'open' || visualStatus === 'expanded'
        || (visualStatus === 'confirmed' && poll.dates.length >= 2)) && (
        <>
        {/* At-a-glance scoreboard above the detail rows. Renders whenever
            there are 2+ proposed dates, including confirmed polls — the
            strip highlights the locked-in date with a ✅ glyph (when at
            target) or just the green left-rail (when below target) so
            the admin's pick stays visible alongside the competition. */}
        {poll.dates.length >= 2 && (
          <DateCompetitionStrip
            poll={poll}
            dateStats={dateStats}
            // Only mark a date with the ✅ glyph when the poll is
            // *truly* confirmed and at-target. Confirmed-below-target
            // pivots to visualStatus='open' (seats reopened) so the
            // previously-locked date drops the ✅ — the strip's
            // pinned-date override (which uses the raw poll value)
            // still keeps the green left-rail on that row, so the
            // admin's pick stays visually anchored without claiming
            // the seat is full.
            confirmedDateId={visualStatus === 'confirmed' ? confirmedDate?.id ?? null : null}
            // Surface the pick/re-pin button right inside the strip
            // for admins. The strip is the comparison layer; if a tie
            // forces a choice, the button needs to live where admins
            // are looking.
            isAdmin={isAdmin}
            onManualClose={onManualClose}
            t={t}
          />
        )}
        {/* Per-date detail rows. Higher gap (12 vs 8) + box-shadow on
            each card so the rows visually pop apart from each other on
            mobile — without this the muted-on-muted backgrounds make
            the rows blend into one continuous block. The shadow stays
            very subtle on dark mode (low alpha) so it doesn't fight
            the card chrome above.

            Section heading mirrors the strip's "🗳 השוואה בין תאריכים"
            so both sections read as labeled siblings — the strip is
            the at-a-glance scoreboard, this is the per-date drill-
            down. Without the heading the strip and the detail cards
            blur into one undifferentiated stack on mobile. Only
            shown for multi-date polls; single-date polls don't have
            a strip above to distinguish from. */}
        {poll.dates.length >= 2 && (
          <div style={{
            fontSize: 11, fontWeight: 700, color: 'var(--text-muted)',
            letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 6,
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <span aria-hidden>📋</span>
            <span>{t('schedule.dateBreakdownHeading')}</span>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {poll.dates.map(d => {
            const s = dateStats.get(d.id) || { yes: 0, maybe: 0, no: 0, voters: [], proxyCount: 0 };
            const myVote = currentUserVoteByDate.get(d.id);
            const loc = d.location || poll.defaultLocation;
            const isPinnedHere = poll.confirmedDateId === d.id;
            return (
              // Pinned date gets a soft green tint + slightly stronger
              // border so the same "this is the picked date" identity
              // carries across the strip and the per-date row. Other
              // rows use a neutral elevated surface with a subtle
              // outline so each one reads as a distinct card.
              <div key={d.id} className="poll-date-row" style={{
                padding: 10, borderRadius: 8,
                background: isPinnedHere
                  ? 'rgba(16, 185, 129, 0.06)'
                  : 'var(--surface-elevated, var(--surface))',
                border: `1px solid ${isPinnedHere ? 'rgba(16, 185, 129, 0.40)' : 'var(--border)'}`,
                boxShadow: '0 1px 2px rgba(0, 0, 0, 0.18)',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
                    {fmtHebrewDate(d)}
                    {loc && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>{` — ${loc}`}</span>}
                  </div>
                  {/* Proxy badge stays on the date header (it's a *quality*
                      indicator about how the votes were collected). Uses
                      gold (#facc15) which is visually distinct from the
                      yellow `maybe` color so admins can tell them apart at
                      a glance. The raw vote counts have been moved to the
                      per-date footer alongside the manual-close action. */}
                  {s.proxyCount > 0 && (
                    <span title={t('schedule.proxy.taglineTooltip')} style={{
                      padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
                      background: 'rgba(250, 204, 21, 0.14)', color: '#facc15',
                      border: '1px solid rgba(250, 204, 21, 0.40)',
                    }}>
                      {t('schedule.proxy.tagline', { count: s.proxyCount })}
                    </span>
                  )}
                </div>
                {/* RSVP buttons.
                    flexWrap: lets the admin actions (proxy / manual-close)
                    drop to a second line on narrow viewports instead of
                    horizontally overflowing the card. */}
                <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                  {(['yes', 'maybe', 'no'] as RsvpResponse[]).map(resp => {
                    if (resp === 'maybe' && !poll.allowMaybe) return null;
                    const active = myVote === resp;
                    const colorMap: Record<RsvpResponse, string> = { yes: '#10b981', maybe: '#eab308', no: '#ef4444' };
                    const labelMap: Record<RsvpResponse, string> = {
                      yes: t('schedule.rsvpYes'), maybe: t('schedule.rsvpMaybe'), no: t('schedule.rsvpNo'),
                    };
                    // Per-date seat-cap on yes upgrades. Same rule as
                    // the confirmed-banner branch: block 'yes' only when
                    // it would push *this* date's yes-count past target,
                    // and only when the user isn't already 'yes' on it.
                    const wouldOverfill =
                      resp === 'yes' && !active && s.yes >= poll.targetPlayerCount;
                    const disabled = !canVote.allowed || wouldOverfill;
                    return (
                      <button
                        key={resp}
                        disabled={disabled}
                        onClick={() => onVote(poll, d.id, resp)}
                        title={
                          wouldOverfill ? t('schedule.errorSeatFull') :
                          canVote.allowed ? '' :
                          canVote.reason === 'no_player_link' ? t('schedule.errorNoPlayerLink') :
                          canVote.reason === 'tier_not_allowed' ? t('schedule.errorTierNotAllowed') :
                          canVote.reason === 'voting_locked' ? t('schedule.errorVotingLocked') :
                          t('schedule.errorPollLocked')
                        }
                        className={`poll-rsvp-btn${active ? ' poll-rsvp-btn--active' : ''}`}
                        style={{
                          padding: '6px 12px', borderRadius: 8,
                          border: active ? `1.5px solid ${colorMap[resp]}` : '1px solid var(--border)',
                          background: active ? `${colorMap[resp]}1f` : 'transparent',
                          color: active ? colorMap[resp] : 'var(--text)',
                          fontWeight: active ? 700 : 500, fontSize: 13,
                          cursor: disabled ? 'not-allowed' : 'pointer',
                          opacity: disabled ? 0.4 : 1,
                        }}>{labelMap[resp]}</button>
                    );
                  })}
                  {isAdmin && (
                    <button
                      onClick={() => setProxyDateId(d.id)}
                      disabled={isVotingLocked}
                      title={isVotingLocked
                        ? t('schedule.errorVotingLocked')
                        : t('schedule.proxy.modalTitle')}
                      className="poll-rsvp-btn"
                      style={{
                        padding: '6px 10px', borderRadius: 8,
                        border: '1px solid rgba(16, 185, 129, 0.4)',
                        background: 'rgba(16, 185, 129, 0.12)',
                        color: '#34d399', fontSize: 11, fontWeight: 600,
                        cursor: isVotingLocked ? 'not-allowed' : 'pointer',
                        opacity: isVotingLocked ? 0.4 : 1,
                      }}>{t('schedule.proxy.add')}</button>
                  )}
                </div>
                {/* Voter list — collapsed by default to keep each
                    per-date card compact on mobile. Tapping the
                    toggle expands the chip list. The toggle is a
                    full-width dashed button whose label includes the
                    total voter count so the user knows how many
                    names are hidden without expanding. When there
                    are zero voters we render nothing here (no chips,
                    no toggle) — the count pills in the footer
                    already say "0 / 0 / 0" which is enough. */}
                {s.voters.length > 0 && (() => {
                  const expanded = expandedVoterDates.has(d.id);
                  return (
                    <>
                      <button
                        onClick={() => toggleVotersExpanded(d.id)}
                        className="poll-ghost-btn"
                        style={{
                          marginTop: 8,
                          width: '100%',
                          padding: '6px 10px', borderRadius: 6,
                          border: '1px dashed var(--border)', background: 'transparent',
                          color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer',
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                          fontWeight: 600,
                        }}
                        aria-expanded={expanded}
                      >
                        <span aria-hidden>{expanded ? '▲' : '▼'}</span>
                        <span>
                          {expanded
                            ? t('schedule.voters.hideList')
                            : `${t('schedule.voters.showList')} (${s.voters.length})`}
                        </span>
                      </button>
                      {expanded && (
                        <VoterGroups
                          voters={s.voters}
                          playerById={playerById}
                          userIdToPlayerName={userIdToPlayerName}
                          allowMaybe={poll.allowMaybe}
                          t={t}
                        />
                      )}
                    </>
                  );
                })()}
                {/* Per-date footer — vote counts are visible to everyone, the
                    manual-close action is admin-only. Sits below the voter
                    list so the date row reads top→bottom: header, RSVP,
                    chips, summary + admin commit. The three count pills
                    mirror the RSVP / voter-chip color scheme so the same
                    "yes / maybe / no" identity carries through the row.
                    The "סיכום:" / "Summary:" label sits ABOVE the pill row
                    rather than inline because the large-variant pills
                    (with words after numbers, e.g. "✓ 6 מגיעים") already
                    push the row to wrap on narrow viewports — putting the
                    label inline would either force an awkward second-line
                    label or steal width from the pills themselves. The
                    pill row keeps its existing dashed top border so the
                    summary block still reads as visually separated from
                    the voter chips above. */}
                <div style={{
                  marginTop: 8, paddingTop: 6,
                  borderTop: '1px dashed var(--border)',
                }}>
                  <div style={{
                    fontSize: 11, fontWeight: 700, color: 'var(--text-muted)',
                    letterSpacing: 0.6, textTransform: 'uppercase',
                    marginBottom: 6,
                  }}>
                    {t('schedule.dateSummaryLabel')}
                  </div>
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    gap: 8, flexWrap: 'wrap',
                  }}>
                  <VoteCountPills
                    yes={s.yes}
                    maybe={s.maybe}
                    no={s.no}
                    allowMaybe={poll.allowMaybe}
                    t={t}
                  />
                  {/* Per-date pick / re-pin button is gone (v5.32.1).
                      Multi-date polls expose it in the upper
                      DateCompetitionStrip scoreboard rows; single-date
                      polls have no equivalent because there's nothing
                      to "pick between" with a single option, and admins
                      can start a game with the current yes-count via
                      the standard new-game flow without formally
                      pinning the poll first. The PollManualCloseModal
                      (and the underlying onManualClose handler / SQL
                      RPC) stays around because the strip still uses it
                      for multi-date polls. */}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        </>
      )}

      {/* Action buttons */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        {/* Start Scheduled Game — admin-only. Routes to the canonical
            NewGameScreen (`/`) with poll context so it shares the same
            forecast/publish/TTS flow as the standard new-game button.
            The pollId is consumed there to link poll → game on creation. */}
        {isAdmin && poll.status === 'confirmed' && confirmedDate && !poll.confirmedGameId && (
          <button
            onClick={() => {
              // Active-game guard mirrors NewGameScreen's check; we let the
              // canonical screen handle the resume prompt rather than block
              // here, so navigate either way.
              navigate('/', {
                state: {
                  fromPoll: {
                    pollId: poll.id,
                    playerIds: confirmedPlayers.map(p => p.id),
                    location: confirmedDate.location || poll.defaultLocation || undefined,
                  },
                },
              });
            }}
            style={{
              // Sized to match the surrounding pill buttons (ghostBtn /
              // shareBtn) so the action row stays on one line on a 360px
              // viewport instead of forcing the start-game button onto its
              // own row. Bold + primary fill keeps it visually dominant.
              padding: '6px 12px', borderRadius: 6, border: 'none',
              background: 'var(--primary)', color: '#fff',
              fontWeight: 600, fontSize: 12, cursor: 'pointer',
            }}>{t('schedule.startScheduledGame')}</button>
        )}
        {poll.status === 'confirmed' && poll.confirmedGameId && (
          <span style={{ fontSize: 13, fontWeight: 600, color: '#10b981' }}>
            ✓ {t('schedule.gameStarted')}
          </span>
        )}
        {/* Share button(s).
            Three cases — collapsed onto a single visible button so
            the action row stays compact:
              - Open / expanded            → 1 button → "📤 שתף הצבעה" → directly captures the invitation.
              - Confirmed at target        → 1 button → "📤 שתף משחק"  → directly captures the confirmation. (rendered below alongside other confirmed-only chrome)
              - Confirmed BELOW target     → 1 button → "📤 שתף ▾"     → opens a chooser modal listing both options PLUS
                                              a one-line explanation of why both apply. The
                                              ambiguous case earns a tap because the choice
                                              is non-obvious; the unambiguous cases stay
                                              one-tap (no regression).
            Earlier this row showed BOTH buttons side-by-side in the
            below-target case, but the labels were near-identical
            ("שתף הצבעה" / "שתף משחק") and admins couldn't tell from
            scanning which one to pick — losing the readability win
            we got from labeling each share with WHAT it shares. The
            chooser modal restores that clarity by spelling out the
            INTENT ("recruit more players" vs. "announce it's
            locked") next to each option. */}
        {(poll.status === 'open' || poll.status === 'expanded') && !isConfirmedBelowTarget && (
          <button onClick={handleShareInvitation} disabled={isSharing} style={shareBtn}>
            {isSharing ? t('common.capturing') : t('schedule.share.shareInvitationLabel')}
          </button>
        )}
        {isConfirmedBelowTarget && (
          <button
            onClick={() => setShareChooserOpen(true)}
            disabled={isSharing}
            style={shareBtn}
            title={t('schedule.share.chooserTitle')}
          >
            {isSharing ? t('common.capturing') : t('schedule.share.shareMenuLabel')}
          </button>
        )}
        {/* Vote-change subscription toggle — members only, active polls
            only. Includes confirmed-below-target via visualStatus so
            members can subscribe to the "seat reopened" notifications.
            Admins/owners are server-side always-recipients. */}
        {!isAdmin && (visualStatus === 'open' || visualStatus === 'expanded') && (
          <button
            onClick={onToggleSubscription}
            title={isSubscribed
              ? t('schedule.subscribe.tooltipOn')
              : t('schedule.subscribe.tooltipOff')}
            style={{
              ...shareBtn,
              color: isSubscribed ? '#34d399' : 'var(--text-muted)',
              borderColor: isSubscribed ? 'rgba(16, 185, 129, 0.5)' : 'var(--border)',
              background: isSubscribed ? 'rgba(16, 185, 129, 0.10)' : 'var(--surface)',
            }}>
            {isSubscribed ? t('schedule.subscribe.on') : t('schedule.subscribe.off')}
          </button>
        )}
        {poll.status === 'confirmed' && confirmedDate && !isConfirmedBelowTarget && (
          <button onClick={handleShareConfirmation} disabled={isSharing} style={shareBtn}>
            {isSharing ? t('common.capturing') : t('schedule.share.shareConfirmationLabel')}
          </button>
        )}
        {poll.status === 'cancelled' && isAdmin && (
          <button onClick={handleShareCancellation} disabled={isSharing} style={shareBtn}>
            {isSharing ? t('common.capturing') : t('common.share')}
          </button>
        )}
        {isAdmin && (poll.status === 'open' || poll.status === 'expanded' || poll.status === 'confirmed') && (
          /* One consolidated edit button — opens EditPollModal where the
              admin can adjust note, default location, target, expansion
              delay, and allow_maybe in a single submit. Available on
              confirmed polls too (migration 034) so an admin can lower
              the target if someone drops post-lock-in. */
          <button onClick={onEdit} style={ghostBtn}>✎ {t('schedule.editPoll')}</button>
        )}
        {/* Forced wrap point: pushes the "finalizing" cluster (lock,
            cancel, delete) onto a second visual row so they don't sit
            shoulder-to-shoulder with the constructive actions (start,
            share, edit). Implemented as a zero-height flex item that
            consumes 100% of the row's basis — flexbox completes the
            current line and continues on the next. Admin-only since
            the wrap only matters when those buttons are about to render
            below it. */}
        {isAdmin && (poll.status === 'open' || poll.status === 'expanded' || poll.status === 'confirmed') && (
          <div style={{ flexBasis: '100%', height: 0 }} aria-hidden />
        )}
        {/* Lock / unlock voting (migration 039). Admin-only. Visible on
            still-active polls (open / expanded / confirmed). When the
            poll is unlocked the button reads "🔒 נעל הצבעה" and toggles
            the lock on; when locked it reads "🔓 שחרר הצבעה" and toggles
            it back off. Sits at the head of the second-row cluster
            (lock → cancel → delete) — the cluster's mental model is
            "actions that finalize / wind down the poll", and locking
            voting is the lightest of the three (reversible, just
            freezes RSVPs); placing it leftmost in RTL puts it first
            in reading order so admins see the safest option first. */}
        {isAdmin && (poll.status === 'open' || poll.status === 'expanded' || poll.status === 'confirmed') && (
          <button
            onClick={handleToggleVotingLock}
            disabled={lockSubmitting}
            title={isVotingLocked
              ? t('schedule.unlockVotesTooltip')
              : t('schedule.lockVotesTooltip')}
            style={{
              ...ghostBtn,
              color: isVotingLocked ? '#34d399' : '#facc15',
              borderColor: isVotingLocked
                ? 'rgba(16, 185, 129, 0.5)'
                : 'rgba(250, 204, 21, 0.5)',
              background: isVotingLocked
                ? 'rgba(16, 185, 129, 0.10)'
                : 'rgba(250, 204, 21, 0.10)',
              opacity: lockSubmitting ? 0.6 : 1,
              cursor: lockSubmitting ? 'wait' : 'pointer',
            }}
          >
            {isVotingLocked
              ? t('schedule.unlockVotes')
              : t('schedule.lockVotes')}
          </button>
        )}
        {isAdmin && (poll.status === 'open' || poll.status === 'expanded' || poll.status === 'confirmed') && (
          /* Cancel — also visible on confirmed polls (migration 036) so
             an admin can pull the plug if too many drop after the lock-in.
             The cancel modal collects an optional reason which is sent
             as a cancellation notification, so members aren't left
             wondering why the announced game disappeared. Label uses
             the short form ('בטל' / 'Cancel') so the second-row cluster
             stays compact; the modal title that opens on click uses
             the full form ('schedule.cancelPoll') for unambiguous intent.
             Tooltip carries the full label so hover still discloses
             that this cancels the poll, not just the action. */
          <button
            onClick={onCancel}
            title={t('schedule.cancelPoll')}
            style={{ ...ghostBtn, color: '#ef4444', borderColor: '#ef4444' }}
          >
            {t('schedule.cancelPollShort')}
          </button>
        )}
        {/* Delete (permanent) — admin-only, available in any state.
            For active polls we recommend Cancel first via the confirm copy.
            Sits on the second visual row alongside Cancel (the destructive
            cluster) so admins don't tap one when meaning the other.
            Same short-label / long-tooltip pattern as the cancel button:
            visible label is the short form (deletePollShort); hovering
            shows the full long form (deletePoll) so the "permanently"
            warning is still discoverable. */}
        {isAdmin && (
          <button
            onClick={onDelete}
            title={t('schedule.deletePoll')}
            style={{
              ...ghostBtn, color: '#ef4444',
              border: '1px dashed rgba(239, 68, 68, 0.5)',
            }}>
            {t('schedule.deletePollShort')}
          </button>
        )}
      </div>

      {/* Admin proxy-vote modal — admin/owner/super_admin only */}
      {isAdmin && proxyDateId && (
        <ProxyVoteModal
          poll={poll}
          dateId={proxyDateId}
          players={players}
          onClose={() => setProxyDateId(null)}
          onSuccess={onSuccess}
          onError={onError}
          handleRpcError={handleRpcError}
          t={t}
        />
      )}

      {/* Share-target chooser modal — only opens for the rare
          confirmed-below-target case where both invitation and
          confirmation shares make sense. Lightweight: just a title
          and the same compact share pills the action row already
          uses, side-by-side, so the user sees the two options in
          their familiar form (no big primary buttons, no extra
          body copy) and picks. Picking either option closes the
          modal and triggers the existing share handler; the
          off-screen capture infrastructure handles the rest. */}
      {shareChooserOpen && (
        <ModalPortal>
          <div
            className="modal-overlay"
            onClick={() => !isSharing && setShareChooserOpen(false)}
          >
            <div className="modal" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h3 className="modal-title">{t('schedule.share.chooserTitle')}</h3>
                <button
                  className="modal-close"
                  onClick={() => setShareChooserOpen(false)}
                  disabled={isSharing}
                  aria-label={t('common.close')}
                >×</button>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                <button
                  onClick={() => {
                    setShareChooserOpen(false);
                    handleShareInvitation();
                  }}
                  disabled={isSharing}
                  style={shareBtn}
                >
                  {t('schedule.share.shareInvitationLabel')}
                </button>
                <button
                  onClick={() => {
                    setShareChooserOpen(false);
                    handleShareConfirmation();
                  }}
                  disabled={isSharing}
                  style={shareBtn}
                >
                  {t('schedule.share.shareConfirmationLabel')}
                </button>
              </div>
            </div>
          </div>
        </ModalPortal>
      )}

      {/* Off-screen premium screenshot card (rendered only while sharing) */}
      {shareMode && (
        <div style={{
          position: 'fixed', left: -10000, top: 0,
          pointerEvents: 'none',
          // Force LTR direction container so RTL inheritance from the modal
          // tree doesn't confuse the screenshot. The card's own content sets
          // direction: 'rtl' for Hebrew text alignment.
          direction: 'ltr',
        }} aria-hidden="true">
          <div ref={shareCardRef}>
            <PollShareCard
              mode={shareMode}
              poll={poll}
              dateStats={dateStats}
              playerById={playerById}
              confirmedDate={confirmedDate}
              confirmedPlayers={confirmedPlayers}
              // window.location.origin matches the convention already
              // used in SettingsScreen for invite links — keeps the
              // share card environment-agnostic (works on localhost,
              // preview, and production without a hardcoded URL).
              appUrl={typeof window !== 'undefined' ? window.location.origin : undefined}
              t={t}
            />
          </div>
        </div>
      )}
    </div>
  );
}

export const ghostBtn: React.CSSProperties = {
  padding: '6px 10px', borderRadius: 6,
  border: '1px solid var(--border)', background: 'transparent',
  color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer',
};

// App-standard compact share pill (mirrors StatisticsScreen / GraphsScreen).
export const shareBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem',
  padding: '0.4rem 0.8rem', fontSize: '0.75rem',
  background: 'var(--surface)', color: 'var(--text-muted)',
  border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer',
};

// ─── ToggleSwitch ──────────────────────────────────────
// iOS-style green/grey toggle. Replaces native <input type="checkbox">
// for boolean settings so we don't render the OS-default blue check
// (which clashes with the app's green primary palette).

interface ToggleSwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel?: string;
  disabled?: boolean;
}

function ToggleSwitch({ checked, onChange, ariaLabel, disabled }: ToggleSwitchProps) {
  const TRACK_W = 40;
  const TRACK_H = 22;
  const THUMB = 16;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      style={{
        position: 'relative',
        width: TRACK_W,
        height: TRACK_H,
        borderRadius: TRACK_H / 2,
        border: 'none',
        padding: 0,
        flexShrink: 0,
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: checked ? 'var(--primary)' : 'rgba(148, 163, 184, 0.35)',
        opacity: disabled ? 0.5 : 1,
        transition: 'background 0.18s ease',
        direction: 'ltr',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: (TRACK_H - THUMB) / 2,
          left: checked ? TRACK_W - THUMB - (TRACK_H - THUMB) / 2 : (TRACK_H - THUMB) / 2,
          width: THUMB,
          height: THUMB,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 2px rgba(0, 0, 0, 0.25)',
          transition: 'left 0.18s ease',
        }}
      />
    </button>
  );
}

// ─── PollTimer ────────────────────────────────────────
// Phase-aware countdown banner shown at the top of every active poll card.
// Three phases mapped to the poll status:
//   * open      — "Permanents only · expands in {time}" (tick toward
//                  createdAt + expansionDelayHours).
//   * expanded  — "Open to all · closes in {time}" (tick toward the next
//                  upcoming proposed date/time; falls back to the latest
//                  proposed date once all are in the past).
//   * confirmed — "Game starts in {time}" (tick toward the confirmed
//                  date+time; flips to a "starting now" / "started" state
//                  in the last 30 minutes / past the start).
// cancelled / expired polls hide the timer entirely.
//
// Re-renders happen via the parent's `now` tick (1 min cadence). That's
// the right granularity — second-by-second motion would be noise on a
// poll page that mostly sits in multi-hour windows.

export interface PollTimerProps {
  poll: GamePoll;
  now: number;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

const SOON_WINDOW_MS = 30 * 60 * 1000;
const STARTED_WINDOW_MS = 30 * 60 * 1000;

const formatRemainingMs = (
  ms: number,
  t: PollTimerProps['t'],
): string => {
  if (ms <= 60_000) return t('schedule.timer.fmtSeconds');
  const totalMin = Math.floor(ms / 60_000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin - days * 60 * 24) / 60);
  const minutes = totalMin - days * 60 * 24 - hours * 60;
  if (days >= 1) {
    return hours > 0
      ? t('schedule.timer.fmtDays', { d: days, h: hours })
      : t('schedule.timer.fmtDaysShort', { d: days });
  }
  if (hours >= 1) {
    return minutes > 0
      ? t('schedule.timer.fmtHours', { h: hours, m: minutes })
      : t('schedule.timer.fmtHoursShort', { h: hours });
  }
  return t('schedule.timer.fmtMinutes', { m: minutes });
};

const getDateRowTimestamp = (d: GamePollDate): number => {
  const time = d.proposedTime || '21:00';
  const ts = new Date(`${d.proposedDate}T${time}`).getTime();
  return Number.isFinite(ts) ? ts : 0;
};

export function PollTimer({ poll, now, t }: PollTimerProps) {
  if (poll.status === 'cancelled' || poll.status === 'expired') return null;

  let color = '#3b82f6';
  let bg = 'rgba(59, 130, 246, 0.10)';
  let border = 'rgba(59, 130, 246, 0.30)';
  let label = '';
  let progress: number | null = null;
  let isSoon = false;

  if (poll.status === 'open') {
    color = '#3b82f6';
    bg = 'rgba(59, 130, 246, 0.10)';
    border = 'rgba(59, 130, 246, 0.30)';
    const start = new Date(poll.createdAt).getTime();
    const end = start + poll.expansionDelayHours * 3600_000;
    const remaining = end - now;
    if (remaining <= 0) {
      label = t('schedule.timer.openPhaseDue');
      progress = 1;
    } else {
      label = t('schedule.timer.openPhase', { time: formatRemainingMs(remaining, t) });
      const total = end - start;
      progress = total > 0 ? Math.max(0, Math.min(1, (now - start) / total)) : 1;
    }
  } else if (poll.status === 'expanded') {
    color = '#f97316';
    bg = 'rgba(249, 115, 22, 0.10)';
    border = 'rgba(249, 115, 22, 0.30)';
    // Soonest upcoming proposed date — the de-facto deadline. If every
    // proposed date is already in the past, fall back to the latest one
    // so the banner still reads "expired" instead of going blank.
    const stamps = poll.dates.map(getDateRowTimestamp).filter(ts => ts > 0);
    const upcoming = stamps.find(ts => ts > now);
    const target = upcoming ?? (stamps.length ? Math.max(...stamps) : now);
    const remaining = target - now;
    if (remaining <= 0) {
      label = t('schedule.timer.expandedPhaseDue');
    } else {
      label = t('schedule.timer.expandedPhase', { time: formatRemainingMs(remaining, t) });
    }
    // No clean baseline for a progress bar in this phase (no fixed start),
    // so we omit it and let the text countdown carry the load.
    progress = null;
  } else if (poll.status === 'confirmed') {
    color = '#10b981';
    bg = 'rgba(16, 185, 129, 0.10)';
    border = 'rgba(16, 185, 129, 0.30)';
    const confirmed = poll.dates.find(d => d.id === poll.confirmedDateId);
    if (!confirmed) return null;
    const target = getDateRowTimestamp(confirmed);
    const remaining = target - now;
    if (remaining <= -STARTED_WINDOW_MS) {
      label = t('schedule.timer.confirmedNow');
      isSoon = true;
    } else if (remaining <= SOON_WINDOW_MS) {
      label = t('schedule.timer.confirmedSoon');
      isSoon = true;
    } else {
      label = t('schedule.timer.confirmedPhase', { time: formatRemainingMs(remaining, t) });
    }
    const start = poll.confirmedAt
      ? new Date(poll.confirmedAt).getTime()
      : new Date(poll.createdAt).getTime();
    const total = target - start;
    progress = total > 0 ? Math.max(0, Math.min(1, (now - start) / total)) : 1;
  } else {
    return null;
  }

  return (
    <div
      className={isSoon ? 'poll-timer--soon' : undefined}
      style={{
        marginBottom: 10,
        padding: '8px 12px',
        borderRadius: 8,
        background: bg,
        border: `1px solid ${border}`,
        display: 'flex', flexDirection: 'column', gap: 6,
      }}>
      <div style={{ fontSize: 13, fontWeight: 600, color, lineHeight: 1.35 }}>
        {label}
      </div>
      {progress !== null && (
        <div style={{
          height: 4,
          borderRadius: 2,
          background: 'rgba(255, 255, 255, 0.06)',
          overflow: 'hidden',
        }}>
          <div style={{
            width: `${Math.round(progress * 100)}%`,
            height: '100%',
            background: color,
            transition: 'width 0.6s cubic-bezier(0.16, 1, 0.3, 1)',
          }} />
        </div>
      )}
    </div>
  );
}

// ─── VoteCountPills ────────────────────────────────────
// Compact summary of yes / maybe / no counts for a single poll-date.
// Active counts get a tinted pill in the response color, zeros are dimmed
// so the eye locks onto the live numbers. Mirrors the RSVP button + voter
// chip palette so the visual identity is consistent across the date row.

export interface VoteCountPillsProps {
  yes: number;
  maybe: number;
  no: number;
  allowMaybe: boolean;
  // Layout variant — see comments in the body for the rationale of each.
  //   'compact' (default) — tight inline pills used inside the
  //     DateCompetitionStrip's single-line rows where horizontal space
  //     is at a premium. Symbol-only, small font.
  //   'large' — prominent pills used in the per-date detail row footer
  //     and the confirmed banner. Bigger font, more padding, an
  //     inline Hebrew label after the count so the meaning is
  //     unambiguous at a glance ("✓ 6 מגיעים" rather than "✓ 6").
  size?: 'compact' | 'large';
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

export function VoteCountPills({ yes, maybe, no, allowMaybe, size = 'compact', t }: VoteCountPillsProps) {
  type Pill = { value: number; color: string; bg: string; symbol: string; label: string };
  const pills: Pill[] = [
    { value: yes,   color: '#10b981', bg: 'rgba(16, 185, 129, 0.10)', symbol: '✓', label: t('schedule.rsvpYes') },
  ];
  if (allowMaybe) {
    // "?" reads more universally as "uncertain" than "~" which most users
    // associate with strikethrough or approximation.
    pills.push({ value: maybe, color: '#eab308', bg: 'rgba(234, 179, 8, 0.10)', symbol: '?', label: t('schedule.rsvpMaybe') });
  }
  pills.push({ value: no, color: '#ef4444', bg: 'rgba(239, 68, 68, 0.10)', symbol: '✗', label: t('schedule.rsvpNo') });

  const isLarge = size === 'large';
  const containerGap = isLarge ? 8 : 3;
  const pillPadding = isLarge ? '4px 10px' : '2px 7px';
  const pillGap = isLarge ? 5 : 3;
  const pillFontSize = isLarge ? 13 : 11;
  const symbolFontSize = isLarge ? 13 : 10;

  return (
    // Non-wrapping inline cluster — when these pills sit inside the
    // DateCompetitionStrip's per-row top line they MUST stay on the
    // same line as the date label and pick button, otherwise the row
    // breaks into two visual lines on a 360px viewport. Padding +
    // gaps are tuned tight enough that ✓N + ?N + ✗N fits even when
    // N reaches double digits. The 'large' variant relaxes those
    // constraints (it lives in the per-date detail row footer where
    // there's a full row of horizontal space) and adds the response
    // label after the count for instant readability.
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: containerGap, flexShrink: 0 }}>
      {pills.map((p, i) => {
        const active = p.value > 0;
        return (
          <span
            key={i}
            className="poll-count-pill"
            title={`${p.value} ${p.label}`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: pillGap,
              padding: pillPadding, borderRadius: 999,
              background: active ? p.bg : 'transparent',
              color: active ? p.color : 'var(--text-muted)',
              border: `1px solid ${active ? `${p.color}55` : 'var(--border)'}`,
              fontSize: pillFontSize,
              fontWeight: active ? 700 : 500,
              fontVariantNumeric: 'tabular-nums',
              opacity: active ? 1 : 0.55,
              lineHeight: 1.2,
              animationDelay: `${i * 40}ms`,
            }}
          >
            <span aria-hidden style={{ fontSize: symbolFontSize }}>{p.symbol}</span>
            {p.value}
            {isLarge && (
              <span style={{ fontSize: pillFontSize - 2, fontWeight: 500, opacity: 0.85 }}>
                {p.label}
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}

// Progress-bar palette for the date competition strip.
//
// Every bar — leader or not — uses the SAME continuous gradient that
// ends in green on the closure side (the side the bar grows toward as
// it fills to target). The gradient image is sized to span the *full
// track* via background-size + background-position, then clipped by
// the bar's width.
//
// Stop positions are explicit (not evenly distributed) and biased
// heavily toward green: the warm tones (red→orange→yellow) are
// compressed into the first ~25% of the gradient and the back half
// is solid green. That means a bar at 50% already reveals the green
// stop on its leading edge, and a bar at 100% reads as "fully green"
// (the last 50%+ of the palette is saturated green) — which matches
// how a thermometer should feel: warm when far from target, decisively
// green once close to / at target.
//
// Crucially, bar color is purely a function of the date's own pct to
// target — leader designation does NOT change the palette. Otherwise a
// stale "leader" with fewer yes-votes ends up with a more advanced
// (greener) bar than a runner-up that's actually further along, which
// reads as a contradiction. Leader status is communicated through the
// row's left-rail border, the bold weight, and (when the poll is
// confirmed at target) the ✅ glyph — never through a different bar
// color.
const PROGRESS_PALETTE_STOPS: ReadonlyArray<readonly [string, string]> = [
  ['#ef4444', '0%'],    // red — far from target
  ['#f97316', '8%'],    // orange — early warm tail
  ['#facc15', '18%'],   // yellow — getting going
  ['#84cc16', '30%'],   // lime  — green starts kicking in
  ['#10b981', '50%'],   // emerald — solid green from halfway
  ['#10b981', '100%'],  // emerald — saturated tail
];

export function buildProgressGradient(isRTL: boolean): string {
  const dir = isRTL ? 'to left' : 'to right';
  const stops = PROGRESS_PALETTE_STOPS.map(([c, p]) => `${c} ${p}`).join(', ');
  return `linear-gradient(${dir}, ${stops})`;
}

// background-size value that scales the gradient image to the full
// track width regardless of how wide the visible bar is. At pct=50 the
// image is 200% of the bar (=100% of track); at pct=100 the image is
// 100% of bar (=100% of track). pct=0 is degenerate (bar is invisible)
// — return any safe value, callers skip the inner div in practice via
// width:0% so the size doesn't matter.
export function progressBackgroundSize(pct: number): string {
  const safe = Math.max(pct, 0.5);
  return `${(100 / safe) * 100}% 100%`;
}

// ─── DateCompetitionStrip ─────────────────────────────
// At-a-glance scoreboard for multi-date polls. Pinned above the per-date
// detail rows so admins/voters can compare which proposed date is winning
// without scrolling through each date's voter list. Renders whenever the
// poll has 2+ proposed dates — including confirmed polls (both at-target
// and below-target) so the comparison stays visible after a pick.
//
// Leader signaling:
//   - Green left-rail + bold weight on the pinned date when the poll is
//     confirmed (using the raw poll.confirmedDateId, so it survives the
//     visualStatus pivot to 'open' on below-target polls).
//   - Otherwise green rail on the unique vote leader (>0 yes, no tie).
//   - The ✅ glyph keys off the visualStatus-aware confirmedDateId prop
//     so it appears only when truly at-target; below-target keeps the
//     rail but drops the lock-in glyph.
//   - 🏆 was removed: its "leader at target but not pinned" semantics
//     produced a confusing read in tie scenarios where admins had
//     manually picked a different date than the vote leader.

interface DateCompetitionStripProps {
  poll: GamePoll;
  dateStats: Map<string, DateStat>;
  // When set, this date is treated as the leader regardless of yes-count
  // ties. Used when the poll is already confirmed: the locked-in date is
  // the actual winner even if a runner-up later catches up on yes-votes.
  confirmedDateId?: string | null;
  // Admin-only: surfaces a per-row "pick this date" affordance directly
  // inside the strip so admins can resolve a tie without scrolling
  // down to the per-date detail rows. The strip is the most prominent
  // comparison view on the card; if the action only lives below it,
  // tied scenarios feel like a dead-end. When isAdmin is false (or
  // onManualClose is omitted) the button is suppressed and the strip
  // renders read-only.
  isAdmin?: boolean;
  onManualClose?: (dateId: string) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

function DateCompetitionStrip({ poll, dateStats, confirmedDateId, isAdmin, onManualClose, t }: DateCompetitionStripProps) {
  const { isRTL } = useTranslation();
  // Leader (= green left-rail + bold weight) selection:
  //
  //   1. If the poll is confirmed and has a pinned date, the pin
  //      ALWAYS wins the leader role — even when the seat has
  //      slipped below target (visualStatus='open'). The admin made
  //      a choice; the strip should keep that choice highlighted so
  //      the pin doesn't visually disappear when one yes-voter drops
  //      out. This is independent of the `confirmedDateId` prop
  //      (which is the visualStatus-aware version, null in below-
  //      target) — for leader-styling we use the raw poll value.
  //
  //   2. Otherwise (open / expanded / no pin yet) we fall back to
  //      the unique vote leader. Ties on top get no leader at all
  //      — keeps the visual honest until either a tie-breaker pick
  //      happens or the count breaks the tie.
  //
  // The ✅ glyph still keys off the visualStatus-aware prop, so:
  //   - confirmed-at-target → ✅ on the pinned row
  //   - confirmed-below-target → green rail on the pinned row but
  //     no ✅ (the seat is reopened; rail says "this is the pick"
  //     without the lock-in semantics of ✅)
  let leaderId: string | null = null;
  let topYes = 0;
  let topCount = 0;
  for (const d of poll.dates) {
    const y = dateStats.get(d.id)?.yes ?? 0;
    if (y > topYes) topYes = y;
  }
  if (topYes > 0) {
    for (const d of poll.dates) {
      const y = dateStats.get(d.id)?.yes ?? 0;
      if (y === topYes) { topCount++; leaderId = d.id; }
    }
    if (topCount !== 1) leaderId = null;
  }
  if (poll.status === 'confirmed'
      && poll.confirmedDateId
      && poll.dates.some(d => d.id === poll.confirmedDateId)) {
    // Pinned-date override — wins regardless of yes-count tie-break,
    // both for at-target (visualStatus='confirmed') and below-target
    // (visualStatus pivots to 'open' but the pick still stands).
    leaderId = poll.confirmedDateId;
  }
  const showTieHint = topCount >= 2 && topYes >= poll.targetPlayerCount;

  return (
    // Strip is the "scoreboard panel" — a labeled outer container that
    // visually reads as one cohesive widget distinct from the per-date
    // detail cards below it. We use a soft indigo (#6366f1) tint
    // because the per-row backgrounds inside the panel are tinted in
    // the per-date palette (green for leader, slate for runners-up),
    // and indigo doesn't collide with any of those — making the
    // panel↔row contrast obvious. The subtle gradient + blue-shaded
    // shadow give the panel a "scoreboard" feel that's distinct from
    // the standard card chrome elsewhere on the screen. The section
    // heading sits inside the panel border (not above it) so the
    // panel + heading + rows feel like one unit.
    <div style={{
      marginBottom: 14,
      padding: '10px 12px',
      borderRadius: 10,
      border: '1px solid rgba(99, 102, 241, 0.32)',
      background: 'linear-gradient(180deg, rgba(99, 102, 241, 0.12) 0%, rgba(99, 102, 241, 0.06) 100%)',
      boxShadow: '0 1px 4px rgba(99, 102, 241, 0.18)',
    }}>
      <div style={{
        fontSize: 11, fontWeight: 700, color: '#a5b4fc',
        letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 8,
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <span aria-hidden>🗳</span>
        <span>{t('schedule.competition.heading')}</span>
      </div>
      {showTieHint && (
        <div style={{
          marginBottom: 8,
          padding: '6px 10px',
          borderRadius: 6,
          background: 'rgba(234, 179, 8, 0.10)',
          border: '1px dashed rgba(234, 179, 8, 0.45)',
          color: 'var(--text)',
          fontSize: 12, fontWeight: 600, lineHeight: 1.4,
        }}>
          {t('schedule.competition.tieHint')}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {poll.dates.map(d => {
          const s = dateStats.get(d.id) || { yes: 0, maybe: 0, no: 0, voters: [], proxyCount: 0 };
          const isLeader = d.id === leaderId;
          const pct = Math.min(100, Math.round((s.yes / Math.max(1, poll.targetPlayerCount)) * 100));
          // Note: location intentionally NOT pulled here — the compact
          // strip layout drops it to keep rows on a single line at
          // mobile widths. The full date + time + location render in
          // the per-date detail row directly below this strip.
          // Glyph rule: ONLY ✅ — and only when this row is the
          // truly-confirmed lock-in (visualStatus='confirmed' makes
          // the parent pass confirmedDateId; we just match on it).
          //
          // The 🏆 emoji used to fire on "leader at target but not
          // confirmed", which produced a confusing artifact: when an
          // admin manually pins a date that's below-target, the
          // *vote* leader is some other row, and 🏆 jumped to that
          // row even though admin's pick was elsewhere — reading as
          // "your pick lost" even though nothing was lost. With the
          // pick affordance now first-class, "leader by yes count"
          // is sufficiently signaled by the green left-rail + bold
          // weight; no emoji is needed for that state.
          const isConfirmedHere = confirmedDateId === d.id;
          const leaderGlyph: string | null = isConfirmedHere ? '✅' : null;
          return (
            // Each row is its own bordered card so the strip reads as a
            // *list of dates* rather than a wall of text. Non-leader rows
            // get a soft surface tint + outline; the leader row keeps the
            // brighter green rail + green-tint background as the
            // "currently winning / pinned" highlight. The contrast
            // between the two states is what carries the leader signal
            // — the user reported the previous flat-on-flat look made
            // the strip feel like one undifferentiated block.
            <div key={d.id} style={{
              display: 'flex', flexDirection: 'column', gap: 6,
              padding: '8px 10px',
              borderRadius: 8,
              // Per-row card sits ON TOP of the indigo scoreboard panel,
              // so we lift each row to a neutral surface (var(--surface))
              // to read as a "card on the panel" rather than blending
              // into the indigo wash. Leader keeps its green identity
              // (rail + green tint) which now contrasts cleanly with
              // both the indigo panel and the neutral non-leader rows.
              border: `1px solid ${isLeader ? 'rgba(16, 185, 129, 0.45)' : 'rgba(148, 163, 184, 0.30)'}`,
              borderInlineStart: isLeader
                ? '3px solid #10b981'
                : `1px solid rgba(148, 163, 184, 0.30)`,
              background: isLeader
                ? 'rgba(16, 185, 129, 0.12)'
                : 'var(--surface)',
            }}>
              {/* Top row: date label (left-aligned in RTL = inline-start)
                  + pills + pick button. NO flexWrap — on narrow mobile
                  viewports we'd rather truncate the date label with an
                  ellipsis than break the row into two visual lines.
                  The pills and pick button are flexShrink:0 so they
                  always render whole; the date label is the only
                  shrinkable piece, which is the right trade-off (date
                  recognition reads fine even when truncated to "יום
                  חמישי 30/4…"). */}
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                gap: 8,
              }}>
                {/* Compact date label — `fmtHebrewDateCompact` drops the
                    time, and we deliberately omit the location too.
                    Both still appear in the per-date detail row directly
                    below the strip, so the reader doesn't lose any
                    information; the strip stays a one-line scoreboard
                    even on a 360px viewport. */}
                <div style={{
                  fontSize: 12.5, fontWeight: isLeader ? 700 : 600, color: 'var(--text)',
                  display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: '1 1 auto',
                  overflow: 'hidden',
                }}>
                  {leaderGlyph && (
                    <span
                      aria-label={t('schedule.competition.leader')}
                      title={t('schedule.competition.leader')}
                      style={{ fontSize: 13, flexShrink: 0 }}
                    >{leaderGlyph}</span>
                  )}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {fmtHebrewDateCompact(d)}
                  </span>
                </div>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  flexShrink: 0,
                }}>
                  <VoteCountPills
                    yes={s.yes}
                    maybe={s.maybe}
                    no={s.no}
                    allowMaybe={poll.allowMaybe}
                    t={t}
                  />
                  {/* Per-row pick / re-pin affordance — admin-only,
                      same rules as the per-date detail row's button.
                      Gates on the raw poll.confirmedDateId so the
                      button is hidden on the currently-pinned date
                      in BOTH at-target and below-target reopen
                      states. Earlier we showed it on the pinned row
                      in below-target (visualStatus pivots to 'open'
                      so confirmedDateId-prop is null), but the
                      modal it opened — "switch the locked-in date
                      to <same date>" — read as a confusing no-op.
                      Other (non-pinned) rows still get the button
                      so admins can shift the lock during a tie or
                      change-of-mind. */}
                  {isAdmin
                    && onManualClose
                    && poll.confirmedDateId !== d.id
                    && !poll.confirmedGameId
                    && (
                    <button
                      onClick={() => onManualClose(d.id)}
                      className="poll-ghost-btn"
                      // Visible label is the short form ('בחר' / 'Pick')
                      // because the strip row is single-line and every
                      // pixel of the date label deserves to win over a
                      // verbose verb. The full status-aware form
                      // ('בחר תאריך' / 'סגור על תאריך זה' for pre-confirm,
                      // 'בחר תאריך' / 'switch the locked-in date' for
                      // re-pin) lives in the title attribute so hover
                      // (desktop) / long-press (mobile) still discloses
                      // the action's intent. The confirmation modal that
                      // opens on click ALSO shows the full long form, so
                      // there's no ambiguity at the point of commit.
                      title={poll.status === 'confirmed'
                        ? t('schedule.manualRepin')
                        : t('schedule.manualClose')}
                      style={{
                        padding: '2px 7px', borderRadius: 6,
                        border: '1px dashed var(--border)', background: 'transparent',
                        color: 'var(--text-muted)', fontSize: 10.5, cursor: 'pointer',
                        whiteSpace: 'nowrap', flexShrink: 0,
                      }}>{t('schedule.manualPickShort')}</button>
                  )}
                </div>
              </div>
              <div style={{
                height: 4, background: 'rgba(148, 163, 184, 0.18)',
                borderRadius: 999, overflow: 'hidden',
              }}>
                <div style={{
                  width: `${pct}%`, height: '100%',
                  background: buildProgressGradient(isRTL),
                  backgroundSize: progressBackgroundSize(pct),
                  backgroundPosition: isRTL ? 'right center' : 'left center',
                  borderRadius: 999,
                  transition: 'width 0.3s ease',
                }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── VoterGroups ───────────────────────────────────────
// Renders the live voter list for one poll-date, grouped yes → maybe → no.
// Visible to everyone (members + admins).
//   * Proxy votes get a small star marker.
//   * Each voter chip shows the time the vote was cast.
//   * If the vote was edited after creation (voted_at > created_at + 5s),
//     a small "✎" badge appears to flag the change. Hovering the chip
//     reveals the full original→latest history in a tooltip.

export interface VoterGroupsProps {
  voters: VoterRow[];
  playerById: Map<string, Player>;
  // Maps a vote's cast_by_user_id → player display name. Used to render
  // the "נוסף ע״י <admin name>" byline on proxy chips. Empty entries
  // (admin who has never self-voted) gracefully fall back to a generic
  // "by admin" label.
  userIdToPlayerName: Map<string, string>;
  allowMaybe: boolean;
  // When set, the matching voter chip gets a small "(you)" badge so
  // the current member can spot themselves at a glance instead of
  // scanning every name in the list. Defaults to no highlight.
  // Currently only used by the Compact PollCard variant.
  highlightPlayerId?: string | null;
  // Localised label rendered inside the highlight badge. Required
  // when `highlightPlayerId` is set; ignored otherwise.
  youLabel?: string;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

// Tolerance window (ms) for treating voted_at == created_at as "no change".
// Same INSERT writes both columns via two now() evaluations that can land a
// few microseconds apart on slow nodes; 5s is a comfortable cushion.
const VOTE_CHANGE_TOLERANCE_MS = 5000;

// Compact "D.M HH:MM" — always includes the date so users can tell at a glance
// when the vote was cast, even on day-boundary edge cases (e.g. 00:23 votes
// previously rendered as just "00:23" and looked like "today").
const fmtVoteTime = (iso: string): string => {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const time = d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
    return `${d.getDate()}.${d.getMonth() + 1} ${time}`;
  } catch {
    return '';
  }
};

const fmtVoteDateTime = (iso: string): string => {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('he-IL', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '';
  }
};

export function VoterGroups({ voters, playerById, userIdToPlayerName, allowMaybe, highlightPlayerId, youLabel, t }: VoterGroupsProps) {
  const groups: { response: RsvpResponse; label: string; color: string; tint: string }[] = [
    { response: 'yes',   label: t('schedule.voters.yes'),   color: '#10b981', tint: 'rgba(16, 185, 129, 0.12)' },
    { response: 'maybe', label: t('schedule.voters.maybe'), color: '#eab308', tint: 'rgba(234, 179, 8, 0.12)' },
    { response: 'no',    label: t('schedule.voters.no'),    color: '#ef4444', tint: 'rgba(239, 68, 68, 0.10)' },
  ];

  const byResponse = new Map<RsvpResponse, VoterRow[]>();
  for (const g of groups) byResponse.set(g.response, []);
  for (const v of voters) {
    const arr = byResponse.get(v.response);
    if (arr) arr.push(v);
  }
  // Most-recent first inside each group so the latest activity is at the top.
  for (const arr of byResponse.values()) {
    arr.sort((a, b) => new Date(b.votedAt).getTime() - new Date(a.votedAt).getTime());
  }

  if (voters.length === 0) return null;

  return (
    // Vertical list of groups — yes / maybe / no — each group is a
    // titled section with one voter per row. Per user feedback the old
    // inline-chip layout read as a soup of badges; a real list is
    // easier to scan, especially on mobile.
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
      {groups.map(g => {
        if (g.response === 'maybe' && !allowMaybe) return null;
        const list = byResponse.get(g.response) || [];
        if (list.length === 0) return null;
        return (
          <div key={g.response} style={{
            borderRadius: 6,
            background: g.tint,
            border: `1px solid ${g.color}33`,
            overflow: 'hidden',
          }}>
            {/* Group header — label + count, full width. */}
            <div style={{
              padding: '6px 10px',
              fontSize: 11, fontWeight: 700, color: g.color,
              background: `${g.color}1a`,
              borderBottom: `1px solid ${g.color}22`,
            }}>
              {g.label} · {list.length}
            </div>
            {/* Voters list — one row per voter. */}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {list.map((v, idx) => {
                const name = playerById.get(v.playerId)?.name || '—';
                const time = fmtVoteTime(v.votedAt);
                const wasChanged =
                  new Date(v.votedAt).getTime() - new Date(v.createdAt).getTime()
                    > VOTE_CHANGE_TOLERANCE_MS;
                const adminName = v.isProxy && v.castByUserId
                  ? userIdToPlayerName.get(v.castByUserId) ?? null
                  : null;
                const proxyByline = v.isProxy
                  ? (adminName
                      ? t('schedule.voters.proxyBy', { name: adminName })
                      : t('schedule.voters.proxyByGeneric'))
                  : null;
                const tooltipParts: string[] = [];
                if (proxyByline) tooltipParts.push(proxyByline);
                tooltipParts.push(t('schedule.voters.votedAt', { time: fmtVoteDateTime(v.votedAt) }));
                if (wasChanged) {
                  tooltipParts.push(t('schedule.voters.changedFrom', { time: fmtVoteDateTime(v.createdAt) }));
                }
                return (
                  <div
                    key={`${g.response}-${v.playerId}`}
                    className="poll-voter-chip"
                    title={tooltipParts.join('\n')}
                    style={{
                      display: 'flex', alignItems: 'center',
                      justifyContent: 'space-between', gap: 8,
                      padding: '6px 10px',
                      // Subtle separator between rows; first row skips it.
                      borderTop: idx === 0 ? 'none' : `1px solid ${g.color}1f`,
                      // Stagger entrance for a soft cascading reveal as votes
                      // stream in via realtime.
                      animationDelay: `${Math.min(idx, 6) * 35}ms`,
                    }}>
                    {/* Left: name + change pill stacked over proxy byline. */}
                    <div style={{
                      display: 'flex', flexDirection: 'column',
                      alignItems: 'flex-start', gap: 2, minWidth: 0, flex: '1 1 auto',
                    }}>
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        flexWrap: 'wrap',
                      }}>
                        <span style={{
                          fontSize: 13, color: 'var(--text)', fontWeight: 600,
                        }}>
                          {name}
                        </span>
                        {v.isProxy && (
                          <span style={{ color: '#facc15', fontSize: 11 }} aria-hidden>★</span>
                        )}
                        {wasChanged && (
                          <span style={{
                            color: '#60a5fa', fontSize: 10, fontWeight: 600,
                            padding: '0 6px', borderRadius: 6,
                            background: 'rgba(96, 165, 250, 0.15)',
                            border: '1px solid rgba(96, 165, 250, 0.3)',
                          }}>
                            ✎ {t('schedule.voters.changed')}
                          </span>
                        )}
                        {highlightPlayerId === v.playerId && youLabel && (
                          <span style={{
                            color: '#a5b4fc', fontSize: 10, fontWeight: 700,
                            padding: '0 6px', borderRadius: 6,
                            background: 'rgba(99, 102, 241, 0.15)',
                            border: '1px solid rgba(99, 102, 241, 0.40)',
                          }}>
                            {youLabel}
                          </span>
                        )}
                      </div>
                      {proxyByline && (
                        <span style={{
                          color: '#facc15', fontSize: 10, fontWeight: 500,
                        }}>
                          ★ {proxyByline}
                        </span>
                      )}
                    </div>
                    {/* Right: vote timestamp, muted. */}
                    {time && (
                      <span style={{
                        color: 'var(--text-muted)', fontSize: 11,
                        whiteSpace: 'nowrap', flexShrink: 0,
                      }}>
                        {time}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── PollShareCard helpers ─────────────────────────────

// Strip seconds from a "HH:MM:SS" stored time so the share card shows
// "21:00" rather than "21:00:00". Returns the original string if it
// doesn't match the HH:MM(:SS) shape, so legacy data isn't dropped.
function fmtShareTime(raw: string | null | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  const m = /^(\d{1,2}):(\d{2})/.exec(trimmed);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : trimmed;
}

// Hebrew locale's full weekday name returns "יום שבת". When we already
// label the column as "יום" we'd be saying it twice — strip the prefix
// so the value reads as just "שבת".
function shortHebrewWeekday(d: Date): string {
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('he-IL', { weekday: 'long' })
    .replace(/^יום\s+/, '');
}

// Current half-year window (H1 = Jan–Jun, H2 = Jul–Dec) used for the
// share-card period leaderboard. Mirrors the H1/H2 logic in
// StatisticsScreen.getDateFilter so the table matches what users see in
// the stats tab. Returns the same {start, end} shape getPlayerStats
// expects, with end inclusive of the entire last day.
function getCurrentHalfYearFilter(): { start: Date; end: Date; isH1: boolean; year: number } {
  const now = new Date();
  const year = now.getFullYear();
  const isH1 = now.getMonth() < 6;
  return {
    start: new Date(year, isH1 ? 0 : 6, 1, 0, 0, 0, 0),
    end: new Date(year, isH1 ? 5 : 11, isH1 ? 30 : 31, 23, 59, 59, 999),
    isH1,
    year,
  };
}

// Compact date+time label used in the invitation and cancellation
// per-date rows. Day-of-week, date, and time share a single bold
// headline ("שלישי · 5 במאי · 21:00") so the "when" reads as one
// unit. Earlier iterations split time onto its own muted line, but
// the user feedback was clear: the hour deserves the same prominence
// as the date — there's no other "when" detail competing for it.
// Falls back gracefully when any piece is missing (parse failure on
// the date, or no time set on the poll).
function ShareDateLabel({
  date, color, muted: _muted,
}: { date: GamePollDate; color: string; muted: string }) {
  const d = new Date(date.proposedDate);
  const dayOfWeek = shortHebrewWeekday(d);
  const dayMonth = isNaN(d.getTime())
    ? date.proposedDate
    : d.toLocaleDateString('he-IL', { day: 'numeric', month: 'long' });
  const time = fmtShareTime(date.proposedTime);
  const headlineParts = [dayOfWeek, dayMonth, time].filter(Boolean);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
      {headlineParts.length > 0 && (
        <span style={{
          fontSize: 30, fontWeight: 700, color, letterSpacing: 0.2, lineHeight: 1.15,
        }}>{headlineParts.join(' · ')}</span>
      )}
    </div>
  );
}

// Confirmation hero — boarding-pass layout. Four IDENTICAL columns
// (day · date · time · location), each with a small uppercase label on
// top and a same-sized value below, separated by hairline dividers.
// The accent stripe (top inner shadow + tinted gradient) carries all
// the color so the data values stay typographically uniform — that
// uniformity is what makes the four facts read as a single horizontal
// strip rather than four competing focal points.
function ShareBoardingHero({
  date, location, accent, accentTint, tokens,
}: {
  date: GamePollDate;
  location: string | null;
  accent: string;
  accentTint: string;
  tokens: { TEXT: string; TEXT_MUTED: string };
}) {
  const { TEXT, TEXT_MUTED } = tokens;
  const d = new Date(date.proposedDate);
  const valid = !isNaN(d.getTime());
  const dayOfWeek = shortHebrewWeekday(d);
  const dayMonth = valid
    ? d.toLocaleDateString('he-IL', { day: 'numeric', month: 'long' })
    : date.proposedDate;
  const time = fmtShareTime(date.proposedTime);

  const Segment = ({ label, value }: { label: string; value: string }) => (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 10,
      padding: '0 10px', minWidth: 0,
    }}>
      <span style={{
        fontSize: 18, color: TEXT_MUTED, letterSpacing: 1.5,
        textTransform: 'uppercase', fontWeight: 600,
      }}>{label}</span>
      <span style={{
        fontSize: 30, fontWeight: 700, color: TEXT,
        lineHeight: 1.15, letterSpacing: 0.1,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        maxWidth: '100%',
      }}>{value}</span>
    </div>
  );

  const Divider = () => (
    <div style={{
      width: 1, alignSelf: 'stretch',
      background: 'rgba(148, 163, 184, 0.20)',
      margin: '8px 0',
    }} />
  );

  return (
    <div style={{
      position: 'relative',
      padding: '30px 12px 28px',
      marginBottom: 26,
      background: `linear-gradient(180deg, ${accentTint}, rgba(15, 23, 42, 0.35))`,
      border: `1px solid ${accent}55`,
      borderRadius: 20,
      display: 'flex', alignItems: 'stretch',
      // Subtle accent stripe along the top inner edge — reads as the
      // boarding-pass "stub" cut without competing with the main border.
      boxShadow: `inset 0 1px 0 0 ${accent}33`,
    }}>
      <Segment label="יום" value={dayOfWeek || '—'} />
      <Divider />
      <Segment label="תאריך" value={dayMonth} />
      <Divider />
      <Segment label="שעה" value={time || '—'} />
      <Divider />
      <Segment label="מיקום" value={location ? `📍 ${location}` : 'נעדכן'} />
    </div>
  );
}

// Phase + deadline pill row for the invitation card. The phase indicator
// is THE most actionable piece of info for non-permanent players who get
// the share in a group chat: it tells them whether they can vote yet.
function SharePhaseBadge({
  poll, t, tokens,
}: {
  poll: GamePoll;
  t: PollShareCardProps['t'];
  tokens: { TEXT: string; TEXT_MUTED: string; ACCENT_BLUE: string; ACCENT_GREEN: string };
}) {
  const { TEXT_MUTED, ACCENT_BLUE, ACCENT_GREEN } = tokens;
  // Derived voting phase. For confirmed-below-target polls (rendered as
  // invitation cards via the visualStatus pivot), poll.status is
  // 'confirmed' but voting is effectively in its prior phase — use
  // expandedAt to pick the right label so the recipient sees an
  // accurate "open to all" / "permanents only" caption.
  const isExpandedPhase =
    poll.status === 'expanded'
    || (poll.status === 'confirmed' && !!poll.expandedAt);
  const phaseColor = isExpandedPhase ? ACCENT_GREEN : ACCENT_BLUE;
  const phaseLabel = isExpandedPhase
    ? t('schedule.share.phaseExpanded')
    : t('schedule.share.phaseOpen');
  // Absolute opens-to-all timestamp — recipients see a static image, so
  // a relative "in X hours" countdown would go stale immediately.
  let opensToAllAt: string | null = null;
  if (poll.status === 'open') {
    const t0 = new Date(poll.createdAt).getTime();
    const tExpand = t0 + (poll.expansionDelayHours * 3600_000);
    const dt = new Date(tExpand);
    if (!isNaN(dt.getTime())) {
      opensToAllAt = dt.toLocaleString('he-IL', {
        weekday: 'short', day: 'numeric', month: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    }
  }
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 26,
    }}>
      <span style={{
        padding: '10px 22px', borderRadius: 999,
        background: `${phaseColor}1f`, color: phaseColor,
        border: `1px solid ${phaseColor}55`,
        fontSize: 23, fontWeight: 700, letterSpacing: 0.3,
      }}>
        {isExpandedPhase ? '🌐' : '⭐'} {phaseLabel}
      </span>
      {opensToAllAt && (
        <span style={{
          padding: '10px 22px', borderRadius: 999,
          background: 'rgba(148, 163, 184, 0.10)', color: TEXT_MUTED,
          border: `1px solid rgba(148, 163, 184, 0.25)`,
          fontSize: 23, fontWeight: 600,
        }}>
          ⏰ {t('schedule.share.opensToAllOn', { date: opensToAllAt })}
        </span>
      )}
    </div>
  );
}

// ─── PollShareCard ─────────────────────────────────────
// Premium-styled card rendered off-screen and converted to PNG by html2canvas
// for WhatsApp sharing. Mirrors the dark-navy aesthetic of GameSummaryScreen.

export type VoterRow = {
  playerId: string;
  response: RsvpResponse;
  isProxy: boolean;
  votedAt: string;
  createdAt: string;
  // user_id of the actor who last cast / edited this row (auth.uid()
  // captured server-side). Used by VoterGroups to render the proxy
  // byline ("נוסף ע״י <name>") instead of a generic "admin" label.
  // null for legacy rows or self-cast votes where attribution is moot.
  castByUserId: string | null;
};
export type DateStat = { yes: number; maybe: number; no: number; voters: VoterRow[]; proxyCount: number };

interface PollShareCardProps {
  mode: 'invitation' | 'confirmation' | 'cancellation';
  poll: GamePoll;
  dateStats: Map<string, DateStat>;
  playerById: Map<string, Player>;
  confirmedDate: GamePollDate | undefined;
  confirmedPlayers: Player[];
  // App origin (e.g. https://poker-manager.vercel.app). Used in the
  // invitation card's "registered members only" footnote so recipients
  // who don't have the app yet have a URL to type in. Passed in from
  // the call site (typically window.location.origin) so the card stays
  // pure / SSR-safe.
  appUrl?: string;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

export function PollShareCard({ mode, poll, dateStats, playerById, confirmedDate, confirmedPlayers, appUrl, t }: PollShareCardProps) {
  // Shared visual tokens
  const BG_OUTER = '#0f172a';        // slate-900 — page background
  const BG_CARD = '#1e293b';         // slate-800 — card surface
  const BORDER = 'rgba(148, 163, 184, 0.18)';
  const TEXT = '#f8fafc';
  const TEXT_MUTED = '#94a3b8';
  const ACCENT_BLUE = '#3b82f6';
  const ACCENT_GREEN = '#10b981';
  const ACCENT_RED = '#ef4444';

  // Best-vote count for invitation progress bar (also used in the
  // header subtitle so the title strip carries meaningful status).
  let bestYes = 0;
  for (const s of dateStats.values()) if (s.yes > bestYes) bestYes = s.yes;
  const targetPct = Math.min(100, Math.round((bestYes / Math.max(1, poll.targetPlayerCount)) * 100));

  // Header palette + per-mode meta. Confirmation needs no subtitle —
  // the title and the date hero already tell the whole story. Invitation
  // and cancellation keep a short subtitle since their state is more
  // ambiguous from the title alone. The previous status pill ("✓ סגור"
  // / "✕ בוטל" / "🗳 הצביעו") doubled what the title already says, so
  // it's gone — the colored emoji badge on the leading edge carries the
  // mode color cleanly without textual repetition.
  type HeaderMeta = { emoji: string; title: string; color: string; subtitle?: string };
  const headerByMode: Record<typeof mode, HeaderMeta> = {
    invitation: {
      emoji: '🃏',
      title: t('schedule.share.invitationTitle'),
      color: ACCENT_BLUE,
      subtitle: t('schedule.share.headerSubtitleInvitation'),
    },
    confirmation: {
      emoji: '🥳',
      title: t('schedule.share.confirmationTitle'),
      color: ACCENT_GREEN,
    },
    cancellation: {
      emoji: '❌',
      title: t('schedule.share.cancellationTitle'),
      color: ACCENT_RED,
      subtitle: t('schedule.share.headerSubtitleCancellation'),
    },
  };
  const header = headerByMode[mode];

  return (
    <div style={{
      // 900 px gives WhatsApp a tall portrait card with room for a real
      // typographic hierarchy. With html2canvas's default scale of 2 the
      // output is 1800 px wide — comfortably above retina densities and
      // still inside the size budget WhatsApp recompresses to.
      width: 900,
      padding: 32,
      background: BG_OUTER,
      direction: 'rtl',
      fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      color: TEXT,
      lineHeight: 1.4,
    }}>
      <div style={{
        background: BG_CARD,
        border: `1px solid ${BORDER}`,
        borderRadius: 22,
        padding: 32,
        boxShadow: '0 14px 36px rgba(0, 0, 0, 0.42)',
      }}>
        {/* Header — centered "stamp" layout. Tile uses a gentle linear
            gradient + a faint top-edge highlight to feel like a glossy
            badge instead of a flat tint, but stays restrained (no
            outer glow, no tilt, no halo on the title). The divider is
            a short centered hairline split by a small accent dot —
            just enough personality to break up the wall-to-wall
            border without screaming. Title color/size unchanged. */}
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          gap: 16,
          marginBottom: 28,
        }}>
          <div style={{
            width: 92, height: 92, borderRadius: 24,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: `linear-gradient(160deg, ${header.color}33 0%, ${header.color}14 100%)`,
            fontSize: 50,
            boxShadow: [
              `inset 0 0 0 1px ${header.color}55`,
              `inset 0 1px 0 rgba(255, 255, 255, 0.14)`,
              `0 4px 14px rgba(0, 0, 0, 0.32)`,
            ].join(', '),
          }}>{header.emoji}</div>
          <div style={{
            fontSize: 36, fontWeight: 800, color: TEXT,
            letterSpacing: 0.2, lineHeight: 1.2, textAlign: 'center',
          }}>{header.title}</div>
          {header.subtitle && (
            <div style={{
              fontSize: 23, color: TEXT_MUTED, lineHeight: 1.35,
              textAlign: 'center',
            }}>
              {header.subtitle}
            </div>
          )}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            marginTop: 10,
          }}>
            <span style={{ height: 1, width: 80, background: `${header.color}40` }} />
            <span style={{
              width: 6, height: 6, borderRadius: 999,
              background: header.color,
            }} />
            <span style={{ height: 1, width: 80, background: `${header.color}40` }} />
          </div>
        </div>

        {/* Body — varies by mode. Invitation mode is reused for both
            truly-open polls AND confirmed-below-target ones (where the
            visualStatus pivot makes voting effectively reopen). The
            invitation body deliberately renders both states the same
            way — no ✅ marker, no date collapse — so recipients always
            see the full slate of proposed dates with live counts and
            understand voting is back in play. */}
        {mode === 'invitation' && (
          <PollShareInvitationBody
            poll={poll}
            dateStats={dateStats}
            playerById={playerById}
            bestYes={bestYes}
            targetPct={targetPct}
            appUrl={appUrl}
            t={t}
            tokens={{ TEXT, TEXT_MUTED, BORDER, ACCENT_BLUE, ACCENT_GREEN }}
          />
        )}

        {mode === 'confirmation' && confirmedDate && (
          <PollShareConfirmationBody
            poll={poll}
            confirmedDate={confirmedDate}
            confirmedPlayers={confirmedPlayers}
            t={t}
            tokens={{ TEXT, TEXT_MUTED, BORDER, ACCENT_GREEN }}
          />
        )}

        {mode === 'cancellation' && (
          <PollShareCancellationBody
            poll={poll}
            t={t}
            tokens={{ TEXT, TEXT_MUTED, BORDER, ACCENT_RED }}
          />
        )}

        {/* Footer — single-line branded wordmark. The old uppercase
            tagline ("Schedule · Track · Train") read like a marketing
            slogan in a friend-group share, so it's gone — the wordmark
            alone is enough to identify the source. */}
        <div style={{
          marginTop: 30,
          paddingTop: 20,
          borderTop: `1px solid ${BORDER}`,
          textAlign: 'center',
        }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 10,
            fontSize: 22, fontWeight: 700, color: TEXT_MUTED,
            letterSpacing: 1.8, textTransform: 'uppercase',
          }}>
            <span style={{ fontSize: 24 }}>🃏</span>
            <span>{t('schedule.share.footer')}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── PollShareCard — body subcomponents ────────────────

type ShareTokens = {
  TEXT: string; TEXT_MUTED: string; BORDER: string;
  ACCENT_BLUE?: string; ACCENT_GREEN?: string; ACCENT_RED?: string;
};

// ─── ShareDateCompetitionStrip ─────────────────────────
// Multi-date poll scoreboard for the WhatsApp share image. Renders one
// row per proposed date with the date label, ✓/?/✕ count pills, and a
// thin progress bar. Same shape/intent as the in-app DateCompetitionStrip
// but tuned for the 900-wide rasterised card. See that component's
// header for the full leader/glyph rules — both strips share the
// pinned-date override + ✅-only-at-target semantics.

function ShareDateCompetitionStrip({
  poll, dateStats, confirmedDateId, t, tokens,
}: {
  poll: GamePoll;
  dateStats: Map<string, DateStat>;
  // When set, this date is treated as the leader regardless of the
  // yes-count tie-break. Used for confirmed-below-target polls so the
  // locked-in date stays highlighted with ✅ even if a runner-up has
  // briefly caught up on yes-votes.
  confirmedDateId?: string | null;
  t: PollShareCardProps['t'];
  tokens: ShareTokens;
}) {
  const { TEXT, TEXT_MUTED, BORDER, ACCENT_GREEN = '#10b981' } = tokens;

  // Mirror the in-app DateCompetitionStrip leader rules:
  //   1. Pinned-date override — if the poll is confirmed and has a
  //      pinned date, that row is the leader regardless of yes-count
  //      ties or below-target slips. Uses the raw poll value so the
  //      pin stays highlighted even when the prop is null (below
  //      target / invitation share).
  //   2. Otherwise the unique vote leader wins; ties produce no
  //      leader row.
  let leaderId: string | null = null;
  let topYes = 0;
  for (const d of poll.dates) {
    const y = dateStats.get(d.id)?.yes ?? 0;
    if (y > topYes) topYes = y;
  }
  if (topYes > 0) {
    let count = 0;
    for (const d of poll.dates) {
      const y = dateStats.get(d.id)?.yes ?? 0;
      if (y === topYes) { count++; leaderId = d.id; }
    }
    if (count !== 1) leaderId = null;
  }
  if (poll.status === 'confirmed'
      && poll.confirmedDateId
      && poll.dates.some(d => d.id === poll.confirmedDateId)) {
    leaderId = poll.confirmedDateId;
  }

  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{
        fontSize: 24, color: TEXT_MUTED, fontWeight: 700,
        letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 12,
      }}>
        🗳 {t('schedule.competition.heading')}
      </div>
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 8,
        padding: '14px 18px',
        background: 'rgba(15, 23, 42, 0.55)',
        border: `1px solid ${BORDER}`,
        borderRadius: 14,
      }}>
        {poll.dates.map(d => {
          const s = dateStats.get(d.id) || { yes: 0, maybe: 0, no: 0, voters: [], proxyCount: 0 };
          const isLeader = d.id === leaderId;
          const pct = Math.min(100, Math.round((s.yes / Math.max(1, poll.targetPlayerCount)) * 100));
          // Same glyph rule as the in-app DateCompetitionStrip — see
          // there for the rationale. ✅ for the locked-in date only;
          // the leader-at-target trophy was dropped because it
          // jumped to the vote-leader (not the admin's pick) once a
          // poll dropped below target, producing a misleading
          // "your pick lost" read. Green rail + bold weight handle
          // the leading-row signal on their own.
          const isConfirmedHere = confirmedDateId === d.id;
          const leaderGlyph: string | null = isConfirmedHere ? '✅' : null;
          return (
            // data-share-split lets the rasterised image splitter cut
            // between strip rows when a long-date list pushes the
            // overall share past the slice height cap. Without an
            // anchor here the splitter would default to a flat-pixel
            // boundary which can land mid-row and chop a date off.
            <div key={d.id} data-share-split="true" style={{
              display: 'flex', flexDirection: 'column', gap: 6,
              padding: '8px 12px',
              borderRadius: 10,
              borderInlineStart: isLeader ? `4px solid ${ACCENT_GREEN}` : '4px solid transparent',
              background: isLeader ? `${ACCENT_GREEN}14` : 'transparent',
            }}>
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                gap: 12,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                  {leaderGlyph && (
                    <span style={{ fontSize: 22 }} aria-label={t('schedule.competition.leader')}>
                      {leaderGlyph}
                    </span>
                  )}
                  <ShareDateLabel date={d} color={TEXT} muted={TEXT_MUTED} />
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <span style={{
                    padding: '7px 16px', borderRadius: 999, fontSize: 22, fontWeight: 700,
                    background: `${ACCENT_GREEN}26`, color: ACCENT_GREEN,
                    border: `1px solid ${ACCENT_GREEN}55`,
                  }}>✓ {s.yes}</span>
                  {poll.allowMaybe && (
                    <span style={{
                      padding: '7px 16px', borderRadius: 999, fontSize: 22, fontWeight: 700,
                      background: 'rgba(234, 179, 8, 0.18)', color: '#eab308',
                      border: '1px solid rgba(234, 179, 8, 0.45)',
                    }}>? {s.maybe}</span>
                  )}
                  <span style={{
                    padding: '7px 16px', borderRadius: 999, fontSize: 22, fontWeight: 700,
                    background: 'rgba(239, 68, 68, 0.16)', color: '#f87171',
                    border: '1px solid rgba(239, 68, 68, 0.40)',
                  }}>✕ {s.no}</span>
                </div>
              </div>
              <div style={{
                height: 5, background: 'rgba(148, 163, 184, 0.18)',
                borderRadius: 999, overflow: 'hidden',
              }}>
                <div style={{
                  width: `${pct}%`, height: '100%',
                  // Share card is always rendered RTL — gradient direction
                  // is fixed accordingly so green lands on the closure
                  // (target-reached) side of the bar.
                  background: buildProgressGradient(true),
                  backgroundSize: progressBackgroundSize(pct),
                  backgroundPosition: 'right center',
                  borderRadius: 999,
                }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PollShareInvitationBody({
  poll, dateStats, playerById, bestYes, targetPct, appUrl, t, tokens,
}: {
  poll: GamePoll;
  dateStats: Map<string, DateStat>;
  playerById: Map<string, Player>;
  bestYes: number;
  targetPct: number;
  // App origin URL — appended as a plain-text footnote so recipients
  // who don't have the app yet know where to register. Optional so
  // tests / SSR can omit it.
  appUrl?: string;
  t: PollShareCardProps['t'];
  tokens: ShareTokens;
}) {
  const { TEXT, TEXT_MUTED, BORDER, ACCENT_BLUE = '#3b82f6', ACCENT_GREEN = '#10b981' } = tokens;
  // Multi-date polls drop the per-date voter chip lists entirely. The
  // competition strip already carries the date + count breakdown, and
  // dragging the full voter chips into the rasterised PNG ballooned the
  // height past WhatsApp's slice budget — every multi-date share
  // ended up cut. A single "open the app for voter details" callout is
  // a much better trade: the share stays one image, recipients still
  // see WHO has voted via the strip's vote counts, and the deep link
  // in the footer takes them to full per-date voter lists in-app.
  //
  // Invitation mode is now reserved for truly-open polls (status='open'
  // or 'expanded'). Confirmed polls — including the below-target case
  // where seats have slipped and voting is effectively reopened in-app
  // — route to PollShareConfirmationBody instead, so the share image
  // truthfully reflects "the date is picked" even when more votes are
  // still being collected. See the share-button gates in PollCard.
  const isMultiDate = poll.dates.length >= 2;
  return (
    <>
      {/* Phase + deadline pills — actionable context for recipients who
          might not know whether they can vote yet. */}
      <SharePhaseBadge
        poll={poll}
        t={t}
        tokens={{ TEXT, TEXT_MUTED, ACCENT_BLUE, ACCENT_GREEN }}
      />

      {/* Target progress meter — single-date polls only. For multi-date
          polls this top-level "best yes vs target" bar would just be a
          duplicate of the strongest row inside the competition strip
          (the leader's bar carries the same number, with the same
          gradient palette), so we drop it entirely. The strip's per-
          date bars already make target progress legible and the
          recipients save ~120px of vertical space. Single-date polls
          don't render the strip, so the global meter is still the
          only "how close are we?" signal there. */}
      {!isMultiDate && (
        <div style={{ marginBottom: 28 }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            marginBottom: 16,
          }}>
            <span style={{
              fontSize: 24, color: TEXT_MUTED, fontWeight: 700,
              letterSpacing: 1.5, textTransform: 'uppercase',
            }}>🎯 {t('schedule.share.target')}</span>
            <span style={{
              padding: '9px 22px', borderRadius: 999,
              background: `${ACCENT_GREEN}1a`, color: ACCENT_GREEN,
              border: `1px solid ${ACCENT_GREEN}55`,
              fontSize: 24, fontWeight: 700, letterSpacing: 0.3,
            }}>
              {t('schedule.share.targetProgress', { count: bestYes, target: poll.targetPlayerCount })}
            </span>
          </div>
          <div style={{
            height: 16, background: 'rgba(148, 163, 184, 0.15)',
            borderRadius: 8, overflow: 'hidden',
          }}>
            <div style={{
              width: `${targetPct}%`, height: '100%',
              background: `linear-gradient(90deg, ${ACCENT_BLUE}, ${ACCENT_GREEN})`,
              borderRadius: 8,
            }} />
          </div>
        </div>
      )}

      {/* Multi-date competition strip — at-a-glance scoreboard so
          recipients can compare dates without scanning the full per-date
          lists below. Renders for every multi-date poll. Invitation
          mode is reserved for open/expanded polls (no pin yet) so we
          deliberately pass confirmedDateId=null — every proposed date
          is still in the running and a ✅ marker would mislead
          recipients into thinking the slate is already settled.
          Confirmed polls render via PollShareConfirmationBody, which
          has its own pinned-date hero treatment. */}
      {isMultiDate && (
        <ShareDateCompetitionStrip
          poll={poll}
          dateStats={dateStats}
          confirmedDateId={null}
          t={t}
          tokens={tokens}
        />
      )}

      {/* Per-date detail blocks — single-date polls only. Multi-date
          shares drop these entirely (the strip above already carries
          the count breakdown) and surface a CTA pointing recipients
          to the app for the full voter lists. This keeps the share
          short enough to render as a single PNG even with 5+ dates. */}
      {!isMultiDate && (
      <>
      <div style={{
        fontSize: 24, color: TEXT_MUTED, fontWeight: 700,
        letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 16,
      }}>
        📅 {t('schedule.share.proposedDates')}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {poll.dates.map(d => {
          const s = dateStats.get(d.id) || { yes: 0, maybe: 0, no: 0, voters: [], proxyCount: 0 };
          const loc = d.location || poll.defaultLocation;
          // Group voters by response in display order yes → maybe → no.
          // Empty groups are filtered at render time.
          const voterGroups: { resp: RsvpResponse; color: string; tint: string; symbol: string; label: string; rows: VoterRow[] }[] = [
            { resp: 'yes',   color: ACCENT_GREEN, tint: 'rgba(16, 185, 129, 0.10)', symbol: '✓', label: t('schedule.voters.yes'),   rows: s.voters.filter(v => v.response === 'yes') },
            { resp: 'maybe', color: '#eab308',    tint: 'rgba(234, 179, 8, 0.10)',  symbol: '?', label: t('schedule.voters.maybe'), rows: s.voters.filter(v => v.response === 'maybe') },
            { resp: 'no',    color: '#f87171',    tint: 'rgba(239, 68, 68, 0.08)',  symbol: '✕', label: t('schedule.voters.no'),    rows: s.voters.filter(v => v.response === 'no') },
          ];
          return (
            <div
              key={d.id}
              data-share-split="true"
              style={{
                padding: '20px 26px',
                background: 'rgba(15, 23, 42, 0.55)',
                border: `1px dashed ${BORDER}`,
                borderRadius: 18,
                display: 'flex', flexDirection: 'column', gap: 18,
              }}
            >
              {/* Top row — date label (+ location) on the inline-start
                  side, count cluster on the inline-end side. Single-date
                  layout is the only path that renders the per-date block
                  now, so we always show the count cluster and full
                  voter chips below. */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14 }}>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <ShareDateLabel date={d} color={TEXT} muted={TEXT_MUTED} />
                    {loc && (
                      <div style={{ fontSize: 25, color: TEXT_MUTED, marginTop: 10 }}>
                        📍 {loc}
                      </div>
                    )}
                  </div>
                </div>
                <div style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'flex-end',
                  gap: 9, flexShrink: 0,
                }}>
                  <span style={{
                    fontSize: 17, color: TEXT_MUTED, fontWeight: 700,
                    letterSpacing: 1.2, textTransform: 'uppercase',
                  }}>
                    {t('schedule.share.currentStatus')}
                  </span>
                  <div style={{ display: 'flex', gap: 9 }}>
                    <span style={{
                      padding: '9px 18px', borderRadius: 999, fontSize: 24, fontWeight: 700,
                      background: `${ACCENT_GREEN}26`, color: ACCENT_GREEN,
                      border: `1px solid ${ACCENT_GREEN}55`,
                      letterSpacing: 0.2,
                    }}>✓ {s.yes}</span>
                    {poll.allowMaybe && (
                      <span style={{
                        padding: '9px 18px', borderRadius: 999, fontSize: 24, fontWeight: 700,
                        background: 'rgba(234, 179, 8, 0.18)', color: '#eab308',
                        border: '1px solid rgba(234, 179, 8, 0.45)',
                        letterSpacing: 0.2,
                      }}>? {s.maybe}</span>
                    )}
                    <span style={{
                      padding: '9px 18px', borderRadius: 999, fontSize: 24, fontWeight: 700,
                      background: 'rgba(239, 68, 68, 0.16)', color: '#f87171',
                      border: '1px solid rgba(239, 68, 68, 0.40)',
                      letterSpacing: 0.2,
                    }}>✕ {s.no}</span>
                  </div>
                </div>
              </div>

              {/* Voter chips grouped yes → maybe → no. */}
              {s.voters.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {voterGroups.map(g => {
                    if (g.rows.length === 0) return null;
                    if (g.resp === 'maybe' && !poll.allowMaybe) return null;
                    return (
                      <div key={g.resp} style={{
                        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10,
                        padding: '10px 14px', borderRadius: 12,
                        background: g.tint,
                        border: `1px solid ${g.color}33`,
                      }}>
                        <span style={{
                          fontSize: 19, fontWeight: 700, color: g.color,
                          padding: '6px 16px', borderRadius: 999,
                          background: `${g.color}26`,
                          letterSpacing: 0.4, textTransform: 'uppercase',
                        }}>
                          {g.symbol} {g.label} · {g.rows.length}
                        </span>
                        {g.rows.map(v => {
                          const name = playerById.get(v.playerId)?.name || '—';
                          return (
                            <span
                              key={`${g.resp}-${v.playerId}`}
                              style={{
                                fontSize: 24, color: TEXT,
                                padding: '7px 18px', borderRadius: 14,
                                background: 'rgba(255, 255, 255, 0.05)',
                                border: `1px solid ${BORDER}`,
                                display: 'inline-flex', alignItems: 'center', gap: 7,
                                fontWeight: 500,
                              }}>
                              {name}
                              {v.isProxy && <span style={{ color: '#eab308', fontSize: 18 }}>★</span>}
                            </span>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
      </>
      )}

      {/* Multi-date polls: skip the per-date voter chip walls (they
          ballooned the share past WhatsApp's slice budget) and replace
          with a CTA pointing recipients to the app for full voter
          details. The competition strip above already carries the
          per-date count breakdown so recipients see the standings at a
          glance — only the per-name list lives in-app. */}
      {isMultiDate && (
        <div style={{
          marginTop: 4,
          padding: '18px 24px',
          background: 'rgba(59, 130, 246, 0.08)',
          border: `1px dashed ${ACCENT_BLUE}66`,
          borderRadius: 14,
          fontSize: 24, fontWeight: 600, color: TEXT, lineHeight: 1.5,
          textAlign: 'center',
        }}>
          {t('schedule.share.viewVotersInApp')}
        </div>
      )}

      {poll.note && (
        <div style={{
          marginTop: 22, padding: '20px 26px',
          background: 'rgba(59, 130, 246, 0.08)',
          borderInlineStart: `5px solid ${ACCENT_BLUE}`,
          borderRadius: 10, fontSize: 24, color: TEXT, lineHeight: 1.5,
        }}>
          📝 {poll.note}
        </div>
      )}

      {/* Registered-members-only footnote. Sits below the dates / admin
          note so it doesn't compete with the call-to-action above, but
          stays inside the card body (not the brand footer) so it's
          clearly attached to the invitation itself. The URL renders
          with the protocol stripped for readability — the full origin
          stays the underlying value so a recipient typing it works
          either way. The note is dashed-outlined to read as
          "fine print" rather than another action box. */}
      {appUrl && (
        <div style={{
          marginTop: 22, padding: '16px 22px',
          background: 'rgba(148, 163, 184, 0.06)',
          border: `1px dashed ${BORDER}`,
          borderRadius: 12,
          display: 'flex', flexDirection: 'column', gap: 8,
          textAlign: 'center',
        }}>
          <div style={{
            fontSize: 20, color: TEXT_MUTED, lineHeight: 1.45,
          }}>
            🔒 {t('schedule.share.registeredOnlyNote')}
          </div>
          {/* Register label + URL. Label stays in the parent's RTL flow
              so Hebrew reads naturally; the URL itself is force-LTR
              via dir="ltr" so the domain segments don't flip under the
              RTL container. */}
          <div style={{
            display: 'flex', justifyContent: 'center', alignItems: 'center',
            gap: 10, flexWrap: 'wrap',
            fontSize: 23, fontWeight: 700, color: ACCENT_BLUE,
            letterSpacing: 0.3,
          }}>
            <span aria-hidden>👉</span>
            <span>{t('schedule.share.registerLabel')}:</span>
            <span dir="ltr">{appUrl.replace(/^https?:\/\//, '')}</span>
          </div>
        </div>
      )}
    </>
  );
}

function PollShareConfirmationBody({
  poll, confirmedDate, confirmedPlayers, t, tokens,
}: {
  poll: GamePoll;
  confirmedDate: GamePollDate;
  confirmedPlayers: Player[];
  t: PollShareCardProps['t'];
  tokens: ShareTokens;
}) {
  const { TEXT, TEXT_MUTED, BORDER, ACCENT_GREEN = '#10b981' } = tokens;
  const loc = confirmedDate.location || poll.defaultLocation;
  return (
    <>
      {/* Boarding-pass hero — four columns (day · date · time · location)
          separated by hairline dividers. Date numeral is the visual
          anchor; everything else is supporting metadata. */}
      <ShareBoardingHero
        date={confirmedDate}
        location={loc || null}
        accent={ACCENT_GREEN}
        accentTint="rgba(16, 185, 129, 0.12)"
        tokens={{ TEXT, TEXT_MUTED }}
      />

      {/* Admin note — sits right under the hero so it reads as a host
          message attached to the booking, not as an afterthought. Keeps
          the boarding-pass aesthetic with the accent stripe on the
          inline-start edge. */}
      {poll.note && (
        <div style={{
          marginBottom: 22, padding: '18px 24px',
          background: 'rgba(16, 185, 129, 0.08)',
          borderInlineStart: `5px solid ${ACCENT_GREEN}`,
          borderRadius: 10, fontSize: 22, color: TEXT, lineHeight: 1.5,
        }}>
          📝 {poll.note}
        </div>
      )}

      {/* Unified attendees table — replaces the old "names manifest" +
          separate stats table. Lists every confirmed player as a row
          with their current half-year stats (rank/medal, profit, avg,
          games, win%). Players who haven't played yet this period
          appear at the bottom with em-dashes. The visual format mirrors
          the StatisticsScreen share-table so recipients see a familiar
          layout. */}
      <PollSharePeriodLeaderboard
        confirmedPlayers={confirmedPlayers}
        t={t}
        tokens={{ TEXT, TEXT_MUTED, BORDER, ACCENT_GREEN }}
      />
    </>
  );
}

// Unified attendees + period stats table — every confirmed player gets
// a row with their current half-year stats (sourced from the same
// PlayerStats the Statistics tab uses so numbers line up). Players who
// haven't played in the current period are shown at the bottom with
// em-dashes for stats, so the table doubles as the "who's coming"
// roster. Visual format mirrors the StatisticsScreen share-table:
// a centered metadata caption with a hairline divider, then a clean
// borderless table with row separators. Returns null only if there
// are no confirmed players (the rest of the share card already has
// no useful content in that case).
function PollSharePeriodLeaderboard({
  confirmedPlayers, t, tokens,
}: {
  confirmedPlayers: Player[];
  t: PollShareCardProps['t'];
  tokens: { TEXT: string; TEXT_MUTED: string; BORDER: string; ACCENT_GREEN: string };
}) {
  const { TEXT, TEXT_MUTED, BORDER, ACCENT_GREEN } = tokens;

  if (confirmedPlayers.length === 0) return null;

  // Compute the rows lazily — this component only mounts while the
  // share card is being captured off-screen (~1 frame) so a plain
  // const is fine; useMemo would just add ceremony.
  const period = getCurrentHalfYearFilter();
  const allPeriodGames = getAllGames().filter(g => {
    if (g.status !== 'completed') return false;
    const d = new Date(g.date || g.createdAt);
    return d >= period.start && d <= period.end;
  });

  const allPeriodStats = getPlayerStats({ start: period.start, end: period.end })
    .filter(s => s.gamesPlayed > 0)
    .sort((a, b) => b.totalProfit - a.totalProfit);

  // Period-overall rank (1-based) — recipients see how each attendee
  // sits in the broader season, not just within the confirmed group.
  // Ranks may therefore not be contiguous in the table, which is the
  // intended signal.
  const rankByPlayer = new Map<string, number>();
  const statsById = new Map<string, typeof allPeriodStats[number]>();
  allPeriodStats.forEach((s, i) => {
    rankByPlayer.set(s.playerId, i + 1);
    statsById.set(s.playerId, s);
  });

  type Row = {
    playerId: string;
    name: string;
    stats: typeof allPeriodStats[number] | null;
    rank: number | null;
  };
  const withStats: Row[] = [];
  const withoutStats: Row[] = [];
  confirmedPlayers.forEach(p => {
    const s = statsById.get(p.id) ?? null;
    const r = rankByPlayer.get(p.id) ?? null;
    (s ? withStats : withoutStats).push({
      playerId: p.id, name: p.name, stats: s, rank: r,
    });
  });
  // Within "with stats" we honor the period leaderboard order
  // (already DESC by profit). "Without stats" stays in confirmed-list
  // order so the host's intended ordering is preserved at the bottom.
  withStats.sort((a, b) => (b.stats!.totalProfit - a.stats!.totalProfit));
  const rows: Row[] = [...withStats, ...withoutStats];

  const periodLabel = formatHebrewHalf(period.isH1 ? 1 : 2, period.year);

  // Medal emoji for top 3 overall in the period; only awarded when
  // the player actually has positive profit (matches StatisticsScreen
  // getMedal — a #1 with negative profit doesn't get a gold medal).
  const medalFor = (rank: number | null, profit: number) => {
    if (rank == null || profit <= 0) return '';
    if (rank === 1) return ' 🥇';
    if (rank === 2) return ' 🥈';
    if (rank === 3) return ' 🥉';
    return '';
  };

  // Signed thousand-separated profit ("+1,432" / "-180"). Single
  // leading LRM mark wraps the sign+digits run so the sign sits on
  // the correct side of the number in an RTL cell (mirrors
  // formatCurrency).
  const fmtSignedProfit = (n: number) => {
    const rounded = Math.round(n);
    const sign = rounded > 0 ? '+' : rounded < 0 ? '-' : '';
    return `\u200E${sign}${Math.abs(rounded).toLocaleString('en-US')}`;
  };

  // Header row format mirrors StatisticsScreen exactly: centered
  // muted caption with the timeframe, total games count, and the
  // attendee tally — all separated by middle-dot bullets, with a
  // hairline divider before the table itself.
  const cellPad = '14px 12px';
  const headerCellStyle: CSSProperties = {
    fontSize: 18, color: TEXT_MUTED, fontWeight: 700,
    letterSpacing: 0.6, textTransform: 'uppercase',
    padding: '10px 12px', whiteSpace: 'nowrap',
  };
  const dashCellColor = 'rgba(148, 163, 184, 0.55)';

  return (
    <div>
      {/* Two-side metadata caption: participants pill anchored to the
          inline-start (visually right in RTL) so it's the first thing
          recipients see; period meta on the inline-end (visually left)
          as supporting context. Hairline divider underneath echoes the
          StatisticsScreen share-table rhythm. */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 16, flexWrap: 'wrap',
        marginBottom: 14,
        paddingBottom: 12,
        borderBottom: `1px solid ${BORDER}`,
      }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          padding: '9px 20px', borderRadius: 999,
          background: `${ACCENT_GREEN}1f`, color: ACCENT_GREEN,
          border: `1px solid ${ACCENT_GREEN}55`,
          fontSize: 23, fontWeight: 700, letterSpacing: 0.3,
        }}>
          ✓ {confirmedPlayers.length} {t('schedule.share.confirmedPlayers')}
        </span>
        <span style={{
          fontSize: 21, color: TEXT_MUTED, fontWeight: 600,
          letterSpacing: 0.2,
        }}>
          📊 {periodLabel}
          {' • '}{t('stats.gamesCount', { count: allPeriodGames.length })}
        </span>
      </div>
      <table style={{
        width: '100%', borderCollapse: 'collapse',
        fontSize: 22, color: TEXT, lineHeight: 1.25,
        tableLayout: 'fixed',
      }}>
        <thead>
          <tr>
            <th style={{ ...headerCellStyle, width: '11%', textAlign: 'right' }}>
              {t('stats.rankCol')}
            </th>
            <th style={{ ...headerCellStyle, textAlign: 'right' }}>
              {t('stats.playerCol')}
            </th>
            <th style={{ ...headerCellStyle, width: '20%', textAlign: 'right' }}>
              {t('stats.profitCol')}
            </th>
            <th style={{ ...headerCellStyle, width: '15%', textAlign: 'right' }}>
              {t('stats.avgCol')}
            </th>
            <th style={{ ...headerCellStyle, width: '11%', textAlign: 'center' }}>
              {t('stats.gamesCol')}
            </th>
            <th style={{ ...headerCellStyle, width: '13%', textAlign: 'center' }}>
              {t('stats.winRateCol')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const profit = row.stats?.totalProfit ?? 0;
            const avg = row.stats?.avgProfit ?? 0;
            const profitColor = !row.stats ? dashCellColor
              : profit > 0 ? ACCENT_GREEN
              : profit < 0 ? '#f87171' : TEXT_MUTED;
            const avgColor = !row.stats ? dashCellColor
              : avg > 0 ? ACCENT_GREEN
              : avg < 0 ? '#f87171' : TEXT_MUTED;
            const winColor = !row.stats ? dashCellColor
              : row.stats.winPercentage >= 50 ? ACCENT_GREEN : '#f87171';
            return (
              <tr key={row.playerId} style={{
                borderTop: i === 0 ? 'none' : `1px solid ${BORDER}`,
              }}>
                <td style={{
                  padding: cellPad, textAlign: 'right',
                  fontWeight: 700, color: TEXT,
                  whiteSpace: 'nowrap',
                }}>
                  {row.rank != null ? (
                    <>{row.rank}{medalFor(row.rank, profit)}</>
                  ) : (
                    <span style={{ color: dashCellColor }}>—</span>
                  )}
                </td>
                <td style={{
                  padding: cellPad, textAlign: 'right',
                  fontWeight: 600, whiteSpace: 'nowrap',
                  overflow: 'hidden', textOverflow: 'ellipsis',
                  color: TEXT,
                }}>
                  {row.name}
                </td>
                <td style={{
                  padding: cellPad, textAlign: 'right',
                  fontWeight: 700, color: profitColor, whiteSpace: 'nowrap',
                }}>
                  {row.stats ? fmtSignedProfit(profit) : '—'}
                </td>
                <td style={{
                  padding: cellPad, textAlign: 'right',
                  fontWeight: 600, color: avgColor, whiteSpace: 'nowrap',
                }}>
                  {row.stats ? fmtSignedProfit(avg) : '—'}
                </td>
                <td style={{
                  padding: cellPad, textAlign: 'center',
                  fontWeight: 600, whiteSpace: 'nowrap',
                  color: row.stats ? TEXT : dashCellColor,
                }}>
                  {row.stats ? row.stats.gamesPlayed : '—'}
                </td>
                <td style={{
                  padding: cellPad, textAlign: 'center',
                  fontWeight: 700, color: winColor, whiteSpace: 'nowrap',
                }}>
                  {row.stats ? `${Math.round(row.stats.winPercentage)}%` : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Rank explanation — small muted footnote so recipients
          understand that the # column reflects each player's overall
          period standing (not their order within the participants
          list). Italics keep it as a subtle clarifying note. */}
      <div style={{
        marginTop: 14,
        fontSize: 18,
        color: TEXT_MUTED,
        fontStyle: 'italic',
        textAlign: 'center',
        lineHeight: 1.4,
        opacity: 0.85,
      }}>
        ℹ️ {t('schedule.share.periodRankNote')}
      </div>
    </div>
  );
}

function PollShareCancellationBody({
  poll, t, tokens,
}: {
  poll: GamePoll;
  t: PollShareCardProps['t'];
  tokens: ShareTokens;
}) {
  const { TEXT, TEXT_MUTED, BORDER, ACCENT_RED = '#ef4444' } = tokens;
  return (
    <>
      {/* Section title — matches the uppercase rhythm used in the
          confirmation/invitation cards so all three feel like family. */}
      <div style={{
        fontSize: 22, color: TEXT_MUTED, fontWeight: 700,
        letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 16,
      }}>
        📅 {t('schedule.share.proposedDates')}
      </div>
      <div style={{
        padding: '18px 24px', marginBottom: 22,
        background: 'rgba(15, 23, 42, 0.55)',
        border: `1px dashed ${BORDER}`,
        borderRadius: 18,
        display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        {poll.dates.map(d => {
          const loc = d.location || poll.defaultLocation;
          return (
            <div key={d.id} style={{
              display: 'flex', justifyContent: 'space-between',
              alignItems: 'center', gap: 18,
              opacity: 0.65,
              textDecoration: 'line-through',
              textDecorationColor: 'rgba(239, 68, 68, 0.55)',
              textDecorationThickness: 2.5,
            }}>
              <ShareDateLabel date={d} color={TEXT} muted={TEXT_MUTED} />
              {loc && (
                <span style={{ fontSize: 22, color: TEXT_MUTED, whiteSpace: 'nowrap' }}>
                  📍 {loc}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {poll.note && (
        <div style={{
          padding: '18px 24px', marginBottom: 18,
          background: 'rgba(148, 163, 184, 0.08)',
          borderInlineStart: `5px solid ${TEXT_MUTED}`,
          borderRadius: 10, fontSize: 22, color: TEXT, lineHeight: 1.5,
        }}>
          📝 {poll.note}
        </div>
      )}
      {poll.cancellationReason && (
        <div style={{
          padding: '20px 26px',
          background: `linear-gradient(135deg, rgba(239, 68, 68, 0.14), rgba(239, 68, 68, 0.04))`,
          border: `1px solid ${ACCENT_RED}55`,
          borderRadius: 18,
        }}>
          <div style={{
            fontSize: 22, color: ACCENT_RED, fontWeight: 700,
            letterSpacing: 1.5, textTransform: 'uppercase', marginBottom: 8,
          }}>
            💬 {t('schedule.share.cancellationReason')}
          </div>
          <div style={{ fontSize: 22, color: TEXT, lineHeight: 1.5 }}>
            {poll.cancellationReason}
          </div>
        </div>
      )}
    </>
  );
}

// ─── Create Poll Modal ───
interface CreatePollModalProps {
  onClose: () => void;
  onError: (text: string) => void;
  onSuccess: (text: string) => void;
  handleRpcError: (e: unknown) => string;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

function CreatePollModal(props: CreatePollModalProps) {
  const { onClose, onError, onSuccess, handleRpcError, t } = props;

  const settings = getSettings();
  // Group-level defaults (still editable per-poll). Fall back to legacy
  // hardcoded values if the settings columns aren't populated yet.
  const defaultTime = settings.scheduleDefaultTime || DEFAULT_GAME_TIME;
  const [target, setTarget] = useState(settings.scheduleDefaultTarget ?? 7);
  const [delay, setDelay] = useState(settings.scheduleDefaultDelayHours ?? 48);
  const [allowMaybe, setAllowMaybe] = useState(settings.scheduleDefaultAllowMaybe !== false);
  const [defaultLocation, setDefaultLocation] = useState('');
  const [note, setNote] = useState('');
  const [dates, setDates] = useState<DraftDate[]>([
    { proposedDate: nextGameNightIso(settings.gameNightDays), proposedTime: defaultTime },
  ]);
  const [submitting, setSubmitting] = useState(false);

  // Field-level validation state — populated only after the user clicks
  // "Publish" once, so the modal doesn't shout at them while typing.
  interface FieldErrors {
    dateCount?: boolean;
    pastDateIdx?: Set<number>;
    duplicateDateIdx?: Set<number>;
    target?: boolean;
  }
  const [errors, setErrors] = useState<FieldErrors>({});
  const hasErrors = !!(
    errors.dateCount || errors.target
    || (errors.pastDateIdx && errors.pastDateIdx.size > 0)
    || (errors.duplicateDateIdx && errors.duplicateDateIdx.size > 0)
  );

  const knownLocations = settings.locations || [];

  const updateDate = (idx: number, patch: Partial<DraftDate>) => {
    setDates(prev => prev.map((d, i) => i === idx ? { ...d, ...patch } : d));
    // Clear date-related errors as the user fixes them
    if (errors.pastDateIdx?.has(idx) || errors.duplicateDateIdx?.has(idx) || errors.dateCount) {
      setErrors(prev => {
        const nextPast = new Set(prev.pastDateIdx); nextPast.delete(idx);
        const nextDup = new Set(prev.duplicateDateIdx); nextDup.delete(idx);
        return {
          ...prev,
          dateCount: false,
          pastDateIdx: nextPast.size ? nextPast : undefined,
          duplicateDateIdx: nextDup.size ? nextDup : undefined,
        };
      });
    }
  };

  // No min/max constraint on number of dates — the organizer chooses what
  // makes sense for their group. Server (migration 026) accepts ≥1 date
  // with no upper bound; this UI matches that. DO NOT reintroduce a 2-5
  // (or any other) limit without explicit user request — see
  // .cursor/rules/schedule-poll-dates.mdc.

  const addDate = () => {
    setDates(prev => {
      // Anchor the new date on the latest already-proposed date in the list,
      // so consecutive "Add date" clicks walk forward through the configured
      // game-night days (e.g. Tue → Thu → next Tue → next Thu).
      const lastIso = [...prev]
        .map(d => d.proposedDate)
        .filter(Boolean)
        .sort()
        .pop() || '';
      const nextIso = nextGameNightAfter(lastIso, settings.gameNightDays);
      return [...prev, { proposedDate: nextIso, proposedTime: defaultTime }];
    });
    if (errors.dateCount) setErrors(prev => ({ ...prev, dateCount: false }));
  };

  const removeDate = (idx: number) => {
    if (dates.length <= 1) return;
    setDates(prev => prev.filter((_, i) => i !== idx));
    setErrors({}); // indices shift, simplest is to reset
  };

  const handleSubmit = async () => {
    // Build a structured error map so we can highlight the offending fields
    // and show a single inline banner — the parent toast was hard to spot.
    const next: FieldErrors = {};
    const filledDates = dates.filter(d => d.proposedDate.trim());
    // Only "no dates at all" is invalid — server requires ≥1.
    if (filledDates.length < 1) {
      next.dateCount = true;
    }
    const today = todayIso();
    const pastSet = new Set<number>();
    dates.forEach((d, i) => {
      if (d.proposedDate && d.proposedDate < today) pastSet.add(i);
    });
    if (pastSet.size) next.pastDateIdx = pastSet;

    // Duplicate detection on the (date+time) tuple — leaving date empty is
    // still allowed (only filled rows count for duplicates).
    const seen = new Map<string, number>(); // key -> first index
    const dupSet = new Set<number>();
    dates.forEach((d, i) => {
      if (!d.proposedDate) return;
      const key = `${d.proposedDate}T${d.proposedTime || ''}`;
      if (seen.has(key)) {
        dupSet.add(seen.get(key)!);
        dupSet.add(i);
      } else {
        seen.set(key, i);
      }
    });
    if (dupSet.size) next.duplicateDateIdx = dupSet;

    if (target < 2) next.target = true;

    setErrors(next);
    if (next.dateCount || next.target || next.pastDateIdx || next.duplicateDateIdx) {
      // Stay in the modal; the inline banner + red borders tell the story.
      return;
    }

    setSubmitting(true);
    try {
      const newPoll = await createPoll({
        dates: filledDates.map(d => ({
          proposedDate: d.proposedDate,
          proposedTime: d.proposedTime || null,
          location: null,
        })),
        targetPlayerCount: target,
        expansionDelayHours: delay,
        defaultLocation: defaultLocation || null,
        allowMaybe,
        note: note || null,
      });
      // Fire-and-forget invitation broadcast
      sendInvitationToPermanentMembers(newPoll).catch(err =>
        console.warn('sendInvitationToPermanentMembers failed:', err));
      onSuccess(t('schedule.invitationSent'));
      onClose();
    } catch (e) {
      onError(handleRpcError(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalPortal>
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480, direction: 'rtl' }}>
        <div className="modal-header">
          <h3 className="modal-title">{t('schedule.create')}</h3>
          <button className="modal-close" onClick={onClose} aria-label={t('common.close')}>×</button>
        </div>

        {/* Dates */}
        <div style={{ marginBottom: 12 }}>
          <div style={{
            fontSize: 12, marginBottom: 4,
            color: errors.dateCount ? '#ef4444' : 'var(--text-muted)',
            fontWeight: errors.dateCount ? 600 : 400,
          }}>
            {t('schedule.dateRangeHint')}
          </div>
          {dates.map((d, idx) => {
            const isPast = errors.pastDateIdx?.has(idx);
            const isDup = errors.duplicateDateIdx?.has(idx);
            const dateInvalid = isPast || isDup || (errors.dateCount && !d.proposedDate);
            return (
              <div key={idx} style={{ marginBottom: 6 }}>
                {/* flexWrap so the time picker / remove button drop to a
                    second row on narrow viewports (≤340px) instead of
                    squeezing the native date input below ~100px, where
                    iOS truncates "DD/MM/YYYY" inside the field. */}
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    type="date"
                    lang="he-IL"
                    value={d.proposedDate}
                    min={todayIso()}
                    onChange={(e) => updateDate(idx, { proposedDate: e.target.value })}
                    style={{
                      ...inputBase, flex: '1 1 140px', minWidth: 140,
                      borderColor: dateInvalid ? '#ef4444' : 'var(--border)',
                      boxShadow: dateInvalid ? '0 0 0 2px rgba(239,68,68,0.18)' : undefined,
                    }}
                  />
                  <Time24Picker
                    value={d.proposedTime}
                    onChange={(v) => updateDate(idx, { proposedTime: v })}
                  />
                  {dates.length > 1 && (
                    <button onClick={() => removeDate(idx)} style={ghostBtn}>×</button>
                  )}
                </div>
                {(isPast || isDup) && (
                  <div style={{ fontSize: 11, color: '#ef4444', marginTop: 3, paddingInlineStart: 2 }}>
                    {isPast ? t('schedule.errorPastDate') : t('schedule.errorDuplicateDates')}
                  </div>
                )}
              </div>
            );
          })}
          <button onClick={addDate} style={{ ...lightGreenBtn, marginTop: 4 }}>
            {t('schedule.addDate')}
          </button>
        </div>

        {/* Target / Delay / Maybe */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 130 }}>
            <div style={{
              fontSize: 12, marginBottom: 4,
              color: errors.target ? '#ef4444' : 'var(--text-muted)',
              fontWeight: errors.target ? 600 : 400,
            }}>{t('schedule.targetCount')}</div>
            <input type="number" min={2} value={target}
              onChange={(e) => {
                setTarget(parseInt(e.target.value, 10) || 2);
                if (errors.target) setErrors(prev => ({ ...prev, target: false }));
              }}
              style={{
                ...inputBase,
                borderColor: errors.target ? '#ef4444' : 'var(--border)',
                boxShadow: errors.target ? '0 0 0 2px rgba(239,68,68,0.18)' : undefined,
              }} />
            {errors.target && (
              <div style={{ fontSize: 11, color: '#ef4444', marginTop: 3 }}>
                {t('schedule.errorMinTarget')}
              </div>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 130 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>{t('schedule.expansionDelay')}</div>
            <input type="number" min={0} value={delay}
              onChange={(e) => setDelay(parseInt(e.target.value, 10) || 0)} style={inputBase} />
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text)' }}>
            <ToggleSwitch
              checked={allowMaybe}
              onChange={setAllowMaybe}
              ariaLabel={t('schedule.allowMaybe')}
            />
            <span>{t('schedule.allowMaybe')}</span>
          </div>
        </div>

        {/* Default location */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>{t('schedule.defaultLocation')}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {knownLocations.map(loc => (
              <button key={loc} onClick={() => setDefaultLocation(defaultLocation === loc ? '' : loc)}
                style={{
                  padding: '4px 10px', borderRadius: 4,
                  border: defaultLocation === loc ? '2px solid var(--primary)' : '1px solid var(--border)',
                  background: defaultLocation === loc ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
                  color: defaultLocation === loc ? 'var(--primary)' : 'var(--text-muted)',
                  fontSize: 12, cursor: 'pointer',
                }}>{loc}</button>
            ))}
            <input type="text" value={knownLocations.includes(defaultLocation) ? '' : defaultLocation}
              onChange={(e) => setDefaultLocation(e.target.value)}
              placeholder={t('schedule.locationPlaceholder')}
              style={{ ...inputBase, flex: 1, minWidth: 120 }} />
          </div>
        </div>

        {/* Note */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>{t('schedule.note')}</div>
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)}
            placeholder={t('schedule.notePlaceholder')} style={inputBase} />
        </div>

        {/* Inline validation banner */}
        {hasErrors && (
          <div role="alert" style={{
            marginBottom: 12, padding: '8px 12px', borderRadius: 6,
            background: 'rgba(239, 68, 68, 0.12)',
            border: '1px solid rgba(239, 68, 68, 0.45)',
            color: '#ef4444', fontSize: 12, fontWeight: 600, lineHeight: 1.5,
          }}>
            ⚠️ {t('schedule.formErrorsHeading')}
          </div>
        )}

        {/* Buttons */}
        <div className="actions" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button onClick={handleSubmit} disabled={submitting}
            style={{
              ...lightGreenBtn,
              padding: '8px 16px', fontSize: 13, fontWeight: 600,
              cursor: submitting ? 'wait' : 'pointer',
              opacity: submitting ? 0.6 : 1,
            }}>{submitting ? '...' : t('schedule.createSubmit')}</button>
        </div>
      </div>
    </div>
    </ModalPortal>
  );
}

// ─── Cancel Poll Modal ───
interface CancelPollModalProps {
  pollId: string;
  onClose: () => void;
  onError: (text: string) => void;
  onSuccess: (text: string) => void;
  handleRpcError: (e: unknown) => string;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

function CancelPollModal(props: CancelPollModalProps) {
  const { pollId, onClose, onError, onSuccess, handleRpcError, t } = props;
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      await cancelPoll(pollId, reason || undefined);
      // Re-fetch and trigger cancellation notifications
      const poll = getAllPolls().find(p => p.id === pollId);
      if (poll && poll.status === 'cancelled') {
        sendCancellationNotifications(poll).catch(() => {});
      }
      onSuccess(t('schedule.cancellationSent'));
      onClose();
    } catch (e) {
      onError(handleRpcError(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalPortal>
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480, direction: 'rtl' }}>
        <div className="modal-header">
          <h3 className="modal-title">{t('schedule.cancelPoll')}</h3>
          <button className="modal-close" onClick={onClose} aria-label={t('common.close')}>×</button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
          {t('schedule.cancellationReasonLabel')}
        </div>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, 280))}
          placeholder={t('schedule.cancellationReasonPlaceholder')}
          rows={3}
          style={{ ...inputBase, resize: 'vertical', marginBottom: 4 }}
        />
        <div className="actions" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-danger btn-sm" onClick={handleSubmit} disabled={submitting}
            style={{ opacity: submitting ? 0.6 : 1, cursor: submitting ? 'wait' : 'pointer' }}>
            {submitting ? '...' : t('schedule.cancelConfirm')}
          </button>
        </div>
      </div>
    </div>
    </ModalPortal>
  );
}

// ─── Edit Poll Modal ───
// Single consolidated editor for the safely-editable poll metadata. Replaces
// two separate prompt() flows (target, expansion delay) and exposes editing
// for the previously-uneditable fields (note, default location, allow_maybe).
// The expansion-delay row is hidden on 'expanded' polls since it no longer
// affects behavior at that point.

interface EditPollModalProps {
  poll: GamePoll;
  onClose: () => void;
  onError: (text: string) => void;
  onSuccess: (text: string) => void;
  handleRpcError: (e: unknown) => string;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

function EditPollModal(props: EditPollModalProps) {
  const { poll, onClose, onError, onSuccess, handleRpcError, t } = props;

  const [note, setNote] = useState(poll.note || '');
  const [defaultLocation, setDefaultLocation] = useState(poll.defaultLocation || '');
  const [target, setTarget] = useState(poll.targetPlayerCount);
  const [expansionDelay, setExpansionDelay] = useState(poll.expansionDelayHours);
  const [allowMaybe, setAllowMaybe] = useState(poll.allowMaybe);
  const [submitting, setSubmitting] = useState(false);

  // Group-level location presets (managed in Settings → Locations) — show
  // them as one-click chips so editing matches the CreatePollModal flow
  // and admins don't have to re-type "בית של דני" every time.
  const knownLocations = getSettings().locations || [];

  const showExpansionDelay = poll.status === 'open';

  const handleSubmit = async () => {
    if (submitting) return;
    if (!Number.isFinite(target) || target < 2) {
      onError(t('schedule.errorMinTarget'));
      return;
    }
    if (!Number.isFinite(expansionDelay) || expansionDelay < 0) {
      onError(t('schedule.errorGeneric'));
      return;
    }
    setSubmitting(true);
    try {
      await updatePollMeta(poll.id, {
        target: Math.floor(target),
        expansionDelay: Math.floor(expansionDelay),
        note: note.trim() || null,
        defaultLocation: defaultLocation.trim() || null,
        allowMaybe,
      });
      // Lowering the target can flip the poll to 'confirmed' inside the
      // RPC (mirrors update_poll_target's threshold re-eval). Detect that
      // here and broadcast confirmation notifications immediately —
      // otherwise the runSchedulerSweep recovery only fires on
      // polls.length changes, leaving the notification stuck for hours.
      const refreshed = getAllPolls().find(p => p.id === poll.id);
      if (refreshed
          && refreshed.status === 'confirmed'
          && !refreshed.confirmedNotificationsSentAt) {
        sendConfirmedNotifications(refreshed).catch(err =>
          console.warn('sendConfirmedNotifications failed:', err));
      }
      onSuccess(t('schedule.editPollSaved'));
      onClose();
    } catch (e) {
      onError(handleRpcError(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalPortal>
    <div className="modal-overlay" onClick={() => !submitting && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480, direction: 'rtl' }}>
        <div className="modal-header">
          <h3 className="modal-title">{t('schedule.editPollTitle')}</h3>
          <button
            className="modal-close"
            onClick={onClose}
            disabled={submitting}
            aria-label={t('common.close')}
          >×</button>
        </div>
        <p className="text-muted" style={{ fontSize: '0.85rem', marginBottom: '1rem', lineHeight: 1.5 }}>
          {t('schedule.editPollSubtitle')}
        </p>

        {/* Note */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
            {t('schedule.fieldNote')}
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 280))}
            placeholder={t('schedule.notePlaceholder')}
            rows={3}
            style={{ ...inputBase, resize: 'vertical' }}
          />
        </div>

        {/* Default location — chips from Settings → Locations + free-form
            input. Selecting a chip toggles it; the input clears so the
            chip remains the visible source of truth. Typing into the
            input deselects all chips automatically (since the value no
            longer matches any preset). */}
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
            {t('schedule.fieldDefaultLocation')}
          </label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {knownLocations.map(loc => (
              <button
                key={loc}
                type="button"
                onClick={() => setDefaultLocation(defaultLocation === loc ? '' : loc)}
                disabled={submitting}
                style={{
                  padding: '4px 10px', borderRadius: 4,
                  border: defaultLocation === loc ? '2px solid var(--primary)' : '1px solid var(--border)',
                  background: defaultLocation === loc ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
                  color: defaultLocation === loc ? 'var(--primary)' : 'var(--text-muted)',
                  fontSize: 12,
                  cursor: submitting ? 'wait' : 'pointer',
                  opacity: submitting ? 0.6 : 1,
                }}
              >{loc}</button>
            ))}
            <input
              type="text"
              value={knownLocations.includes(defaultLocation) ? '' : defaultLocation}
              onChange={(e) => setDefaultLocation(e.target.value.slice(0, 120))}
              placeholder={t('schedule.fieldDefaultLocationPlaceholder')}
              disabled={submitting}
              style={{ ...inputBase, flex: 1, minWidth: 120 }}
            />
          </div>
        </div>

        {/* Target + expansion delay row */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 140px', minWidth: 140 }}>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
              {t('schedule.fieldTarget')}
            </label>
            <input
              type="number"
              min={2}
              max={20}
              value={target}
              onChange={(e) => setTarget(parseInt(e.target.value, 10) || 0)}
              style={inputBase}
            />
          </div>
          {showExpansionDelay && (
            <div style={{ flex: '1 1 140px', minWidth: 140 }}>
              <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
                {t('schedule.fieldExpansionDelay')}
              </label>
              <input
                type="number"
                min={0}
                max={168}
                value={expansionDelay}
                onChange={(e) => setExpansionDelay(parseInt(e.target.value, 10) || 0)}
                style={inputBase}
              />
            </div>
          )}
        </div>

        {/* Allow "I'll update" toggle */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12, marginBottom: 16,
        }}>
          <span style={{ fontSize: 13, color: 'var(--text)' }}>
            {t('schedule.fieldAllowMaybe')}
          </span>
          <ToggleSwitch
            checked={allowMaybe}
            onChange={setAllowMaybe}
            ariaLabel={t('schedule.fieldAllowMaybe')}
            disabled={submitting}
          />
        </div>

        <div className="actions" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary btn-sm" onClick={onClose} disabled={submitting}>
            {t('common.cancel')}
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={handleSubmit}
            disabled={submitting}
            style={{ opacity: submitting ? 0.6 : 1, cursor: submitting ? 'wait' : 'pointer' }}
          >
            {submitting ? '...' : t('schedule.editPollSave')}
          </button>
        </div>
      </div>
    </div>
    </ModalPortal>
  );
}

// ─── Admin Proxy-Vote Modal ───
// Lets admins / owners / super-admins cast or edit a vote on behalf of any
// player in the group's roster (typically used for unregistered players).

interface ProxyVoteModalProps {
  poll: GamePoll;
  dateId: string;
  players: Player[];
  onClose: () => void;
  onSuccess: (text: string) => void;
  onError: (text: string) => void;
  handleRpcError: (e: unknown) => string;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

export function ProxyVoteModal(props: ProxyVoteModalProps) {
  const { poll, dateId, players, onClose, onSuccess, onError, handleRpcError, t } = props;
  // Admin's player name — used to attribute the change in the notification
  // body and to skip pinging the actor about their own action.
  const { playerName: actorName } = usePermissions();
  const date = poll.dates.find(d => d.id === dateId);
  const [search, setSearch] = useState('');
  // Multi-select: clicking a player toggles their inclusion. Same response
  // and comment are applied to every selected player on submit. Lets admins
  // sweep "everyone confirmed in WhatsApp" in one shot instead of one click
  // per player.
  const [selectedPlayerIds, setSelectedPlayerIds] = useState<Set<string>>(() => new Set());
  const [response, setResponse] = useState<RsvpResponse>('yes');
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Inline-modal flag for the "Delete this vote?" confirmation. Replaces
  // the old native confirm() so the UX matches the rest of the app.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Group filtered players by type. Order: permanent → permanent_guest → guest,
  // matching the convention used in SettingsScreen and other admin lists.
  // Within each group, players are sorted alphabetically (Hebrew collation).
  const groupedPlayers = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? players.filter(p => p.name.toLowerCase().includes(q))
      : players;
    const order: Player['type'][] = ['permanent', 'permanent_guest', 'guest'];
    const labels: Record<Player['type'], string> = {
      permanent: t('schedule.proxy.typePermanent'),
      permanent_guest: t('schedule.proxy.typeGuest'),
      guest: t('schedule.proxy.typeOccasional'),
    };
    return order
      .map(type => ({
        type,
        label: labels[type],
        items: list
          .filter(p => p.type === type)
          .sort((a, b) => a.name.localeCompare(b.name, 'he')),
      }))
      .filter(g => g.items.length > 0);
  }, [players, search, t]);

  const totalShown = groupedPlayers.reduce((n, g) => n + g.items.length, 0);
  const selectedCount = selectedPlayerIds.size;
  const onlySelectedId = selectedCount === 1
    ? selectedPlayerIds.values().next().value as string
    : null;

  // ─── Slot-cap logic ─────────────────────────────────────
  // Target headcount is a 'yes' quota: only 'yes' votes consume slots.
  // 'no' / 'maybe' have no cap. The cap is computed against the CURRENT
  // server state (existing yes votes for this date) plus how many
  // currently-selected players would become NEW yes votes after submit
  // (selected players who don't already have a 'yes' on this date).
  // A selected player who already has 'yes' is a no-op — selecting them
  // again doesn't increase the count, so they don't count against the cap.
  const currentYesCount = useMemo(
    () => poll.votes.filter(v => v.dateId === dateId && v.response === 'yes').length,
    [poll.votes, dateId],
  );
  // Cap is enforced in every active state — including 'confirmed'.
  // Target is the seat cap, not just the auto-confirm trigger: a poll
  // with target=8 and yes=7 has exactly one open seat, and the admin
  // can fill that 8th seat via proxy but should not be able to push
  // the roster past target. If the admin needs more capacity (e.g.
  // a late-arriving guest beyond plan), they raise the target via
  // the Edit button (migration 034 allows editing confirmed polls)
  // and then proxy-vote. 'cancelled' / 'expired' don't expose the
  // proxy button at all, so the gate doesn't need to handle them.
  const enforceCap = poll.status === 'open'
    || poll.status === 'expanded'
    || poll.status === 'confirmed';
  const slotsRemaining = Math.max(0, poll.targetPlayerCount - currentYesCount);
  const selectedNewYesCount = useMemo(() => {
    let n = 0;
    for (const id of selectedPlayerIds) {
      const existing = poll.votes.find(v => v.dateId === dateId && v.playerId === id);
      if (existing?.response !== 'yes') n++;
    }
    return n;
  }, [selectedPlayerIds, poll.votes, dateId]);
  // Spots left to add — only meaningful when bulk-casting 'yes' AND
  // the poll is still in its active phase.
  const isYesResponse = response === 'yes';
  const slotsLeftForSelection = enforceCap && isYesResponse
    ? slotsRemaining - selectedNewYesCount
    : Infinity;
  // Submit guard: if user toggled response from 'no'/'maybe' → 'yes' after
  // selecting more players than the cap allows, block submit and surface
  // the cause rather than silently pruning the selection.
  const capExceeded = enforceCap && isYesResponse && slotsLeftForSelection < 0;

  // When exactly ONE player is selected and they already have a vote, the
  // form prefills with that vote so the admin can quickly edit it. With
  // multi-select active, prefill is skipped — there's no single "current"
  // vote to show, and the admin's intent is to bulk-set a new value.
  const singleExistingVote = useMemo(() => {
    if (!onlySelectedId) return null;
    return poll.votes.find(v => v.dateId === dateId && v.playerId === onlySelectedId) ?? null;
  }, [onlySelectedId, poll.votes, dateId]);

  // Selected players who currently have a vote on this date — drives the
  // "Delete N votes" CTA in the footer when multi-select is active.
  // (Players selected without an existing vote are silently skipped from
  // the delete list — there's nothing to delete for them — but they don't
  // block the delete: the admin can pick "5 selected, 3 with votes" and
  // the button cleanly removes only the 3.)
  const selectedExistingVotes = useMemo(() => {
    return poll.votes.filter(v =>
      v.dateId === dateId && selectedPlayerIds.has(v.playerId),
    );
  }, [selectedPlayerIds, poll.votes, dateId]);

  // Track which player's existing vote (if any) currently drives the form
  // prefill. We use a ref so transitions like "select A (had 'yes' + comment)
  // → switch to B (no existing vote)" can clear the carry-over without
  // wiping mid-typing edits during pure multi-select expansion.
  const lastPrefillFromPlayerIdRef = useRef<string | null>(null);

  useEffect(() => {
    // Case 1: single-select with an existing vote → prefill from it.
    if (singleExistingVote) {
      setResponse(singleExistingVote.response);
      setComment(singleExistingVote.comment || '');
      lastPrefillFromPlayerIdRef.current = singleExistingVote.playerId;
      return;
    }
    // Case 2: single-select with NO existing vote, but the form was
    // previously prefilled from a different player's existing vote. Reset
    // so the admin doesn't accidentally inherit A's "yes" + comment when
    // they switched to B who never voted.
    if (onlySelectedId && lastPrefillFromPlayerIdRef.current
        && lastPrefillFromPlayerIdRef.current !== onlySelectedId) {
      setResponse('yes');
      setComment('');
      lastPrefillFromPlayerIdRef.current = null;
      return;
    }
    // Case 3: nothing selected → forget the carry-over so the next
    // selection makes its own decision via the rules above.
    if (selectedCount === 0) {
      lastPrefillFromPlayerIdRef.current = null;
    }
    // Case 4: multi-select active (≥2). Preserve whatever the admin typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [singleExistingVote?.id, onlySelectedId, selectedCount]);

  const togglePlayer = (id: string) => {
    setSelectedPlayerIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        return next;
      }
      // Block ADD if response is 'yes' and the target headcount would be
      // exceeded. Players who already have a 'yes' vote can always be
      // selected — toggling them is a no-op for the cap (server treats
      // it as an UPDATE with the same response and doesn't double-count).
      if (isYesResponse) {
        const existing = poll.votes.find(v => v.dateId === dateId && v.playerId === id);
        const wouldBeNewYes = existing?.response !== 'yes';
        if (wouldBeNewYes && slotsLeftForSelection <= 0) {
          return prev;
        }
      }
      next.add(id);
      return next;
    });
  };

  const clearSelection = () => setSelectedPlayerIds(new Set());

  const handleSubmit = async () => {
    if (selectedCount === 0) return;
    // Defensive guard: the cap is enforced at toggle-time, but a user
    // could over-select while response='no' then switch to 'yes'. Block
    // submit in that case so we never push the date past its target.
    if (capExceeded) return;
    setSubmitting(true);
    // Snapshot per-player previous (response, comment) BEFORE the bulk cast.
    // We need this so vote_change notifications fire only for rows whose
    // response actually changed — not for re-confirms (admin re-bulks
    // "yes" for 8 players who already had yes). The server bumps voted_at
    // on every cast; the response/comment delta is the only reliable
    // "real change" signal.
    const ids = Array.from(selectedPlayerIds);
    const previousByPlayer = new Map<string, { response: RsvpResponse; comment: string | null } | null>();
    for (const id of ids) {
      const prev = poll.votes.find(v => v.dateId === dateId && v.playerId === id);
      previousByPlayer.set(id, prev ? { response: prev.response, comment: prev.comment ?? null } : null);
    }
    try {
      // Sequential by design: keeps RLS / auto-close trigger ordering
      // predictable, and any single failure surfaces with full context.
      // For typical N=1..15 selections this is well under a second total.
      for (const id of ids) {
        await adminCastVote(dateId, id, response, comment || undefined);
      }
      // Fire vote-change notifications only for rows where the response or
      // comment actually changed AND the row pre-existed (so it was an
      // UPDATE, not an INSERT). This filters out:
      //   - Fresh proxy votes (no `prev` in the snapshot) — those are not
      //     "changes", they're new entries.
      //   - Re-confirms with identical response/comment — silent no-ops.
      const refreshed = getAllPolls().find(p => p.id === poll.id);
      const newComment = comment || null;
      if (refreshed) {
        for (const id of ids) {
          const prev = previousByPlayer.get(id);
          if (!prev) continue;
          if (prev.response === response && prev.comment === newComment) continue;
          const refreshedVote = refreshed.votes.find(
            v => v.dateId === dateId && v.playerId === id,
          );
          const player = players.find(p => p.id === id);
          if (refreshedVote && player) {
            sendVoteChangeNotifications(refreshed, refreshedVote, player.name, actorName)
              .catch(err => console.warn('sendVoteChangeNotifications failed:', err));
          }
        }
      }
      // If this bulk-cast tipped the poll into 'confirmed' (auto-close
      // trigger fired server-side), broadcast the confirmation banner
      // immediately. Without this, the runSchedulerSweep recovery only
      // re-runs when polls.length changes — a confirmed-via-proxy poll
      // could otherwise wait until the next poll create/delete to ping
      // members. claimPollNotifications inside sendConfirmedNotifications
      // is atomic, so this is safe vs the sweep firing concurrently.
      if (refreshed
          && refreshed.status === 'confirmed'
          && !refreshed.confirmedNotificationsSentAt) {
        sendConfirmedNotifications(refreshed).catch(err =>
          console.warn('sendConfirmedNotifications failed:', err));
      }
      onSuccess(
        selectedCount > 1
          ? t('schedule.proxy.savedBulk', { count: selectedCount })
          : (singleExistingVote ? t('schedule.proxy.savedUpdated') : t('schedule.proxy.savedAdded'))
      );
      onClose();
    } catch (e) {
      onError(handleRpcError(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = () => {
    if (selectedExistingVotes.length === 0) return;
    setConfirmingDelete(true);
  };

  const performDelete = async () => {
    if (selectedExistingVotes.length === 0) return;
    setSubmitting(true);
    try {
      // `adminDeleteVote` is a per-row RPC — there's no bulk variant —
      // so we serialize the deletions to keep error reporting clear.
      // Failures stop on first error so partial deletes are obvious.
      let deleted = 0;
      for (const v of selectedExistingVotes) {
        await adminDeleteVote(dateId, v.playerId);
        deleted++;
      }
      onSuccess(
        deleted > 1
          ? t('schedule.proxy.deletedBulk', { count: deleted })
          : t('schedule.proxy.deleted')
      );
      onClose();
    } catch (e) {
      onError(handleRpcError(e));
      setSubmitting(false);
      setConfirmingDelete(false);
    }
  };

  const responseLabels: Record<RsvpResponse, { label: string; color: string }> = {
    yes:   { label: t('schedule.rsvpYes'),   color: '#10b981' },
    maybe: { label: t('schedule.rsvpMaybe'), color: '#eab308' },
    no:    { label: t('schedule.rsvpNo'),    color: '#ef4444' },
  };

  return (
    <ModalPortal>
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          maxWidth: 480,
          direction: 'rtl',
          // Pin the footer: convert the modal into a column flex with a
          // scrolling middle section. The .modal CSS sets max-height: 90vh
          // and overflow-y: auto — we override overflow here so the footer
          // stays put while only the body scrolls.
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Static header */}
        <div className="modal-header" style={{ flexShrink: 0 }}>
          <h3 className="modal-title">{t('schedule.proxy.modalTitle')}</h3>
          <button className="modal-close" onClick={onClose} aria-label={t('common.close')}>×</button>
        </div>

        {/* Scrollable body — grows to fill available space; everything that
            could overflow lives in here. */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.5 }}>
            {t('schedule.proxy.modalHelper')}
          </div>
          {date && (
            <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: 10, fontWeight: 600 }}>
              📅 {fmtHebrewDate(date)}
            </div>
          )}

          {/* Player picker */}
          <div style={{ marginBottom: 10 }}>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              gap: 8, marginBottom: 4, flexWrap: 'wrap',
            }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {t('schedule.proxy.selectPlayer')}
              </div>
              {selectedCount > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{
                    fontSize: 11, fontWeight: 700,
                    padding: '2px 8px', borderRadius: 10,
                    background: 'rgba(16, 185, 129, 0.15)', color: '#34d399',
                    border: '1px solid rgba(16, 185, 129, 0.4)',
                  }}>
                    {t('schedule.proxy.selectedCount', { count: selectedCount })}
                  </span>
                  <button
                    onClick={clearSelection}
                    style={{
                      padding: '2px 8px', borderRadius: 10, fontSize: 11,
                      border: '1px solid var(--border)', background: 'transparent',
                      color: 'var(--text-muted)', cursor: 'pointer',
                    }}>
                    {t('schedule.proxy.clearSelection')}
                  </button>
                </div>
              )}
            </div>
            {/* Slot hint — only relevant for the 'yes' response since
                target headcount caps yes-votes only. Switches color on
                full so the admin sees the constraint at a glance.
                Shown in every active phase including 'confirmed' —
                target is the seat cap, so admins can fill the
                remaining spots up to target but not beyond. To exceed
                target, raise it via the poll's Edit button first. */}
            {enforceCap && isYesResponse && (
              <div style={{
                fontSize: 11, fontWeight: 600,
                marginBottom: 6,
                color: slotsRemaining === 0
                  ? '#ef4444'
                  : (slotsLeftForSelection <= 0 ? '#eab308' : 'var(--text-muted)'),
              }}>
                {slotsRemaining === 0
                  ? t('schedule.proxy.slotsFull')
                  : t('schedule.proxy.slotsRemaining', { count: slotsLeftForSelection })}
              </div>
            )}
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('schedule.proxy.searchPlaceholder')}
              style={{ ...inputBase, marginBottom: 6 }}
            />
            <div style={{
              maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)',
              borderRadius: 6, background: 'var(--surface)',
            }}>
              {totalShown === 0 && (
                <div style={{ padding: 12, fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>
                  {t('schedule.proxy.noPlayers')}
                </div>
              )}
              {groupedPlayers.map(group => (
                <div key={group.type}>
                  <div style={{
                    position: 'sticky', top: 0, zIndex: 1,
                    padding: '6px 10px', fontSize: 11, fontWeight: 700,
                    color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5,
                    background: 'var(--surface-elevated, var(--surface))',
                    borderBottom: '1px solid var(--border)',
                  }}>
                    {group.label} <span style={{ fontWeight: 400, opacity: 0.7 }}>({group.items.length})</span>
                  </div>
                  {group.items.map(p => {
                    const has = poll.votes.find(v => v.dateId === dateId && v.playerId === p.id);
                    const selected = selectedPlayerIds.has(p.id);
                    // When response='yes' and the cap is reached, additional
                    // players that don't already have a 'yes' vote can't be
                    // added — visually disable them. Selected rows and rows
                    // for players already at 'yes' (toggling them is a
                    // no-op for the cap) remain interactive.
                    const wouldBeNewYes = has?.response !== 'yes';
                    const blocked = !selected
                      && isYesResponse
                      && wouldBeNewYes
                      && slotsLeftForSelection <= 0;
                    return (
                      <button
                        key={p.id}
                        onClick={() => togglePlayer(p.id)}
                        disabled={blocked}
                        title={blocked ? t('schedule.proxy.slotsFull') : undefined}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          width: '100%', padding: '8px 10px', gap: 8,
                          border: 'none', borderBottom: '1px solid var(--border)',
                          background: selected ? 'rgba(16, 185, 129, 0.15)' : 'transparent',
                          color: selected ? '#34d399' : 'var(--text)',
                          fontSize: 13,
                          cursor: blocked ? 'not-allowed' : 'pointer',
                          opacity: blocked ? 0.4 : 1,
                          textAlign: 'right',
                          // minWidth: 0 lets the name text shrink/ellipsis
                          // instead of pushing the response label off-screen
                          // on narrow viewports.
                          minWidth: 0,
                        }}>
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', gap: 8,
                          flex: 1, minWidth: 0,
                          // Long Hebrew names (e.g. "פלוני אלמוני המבוגר")
                          // get truncated rather than wrapping — keeps each
                          // row a clean single line.
                          overflow: 'hidden', whiteSpace: 'nowrap',
                          textOverflow: 'ellipsis',
                        }}>
                          {/* Visual checkbox — clearer than relying on
                              row tint alone for multi-select state. */}
                          <span
                            aria-hidden="true"
                            style={{
                              width: 16, height: 16, borderRadius: 4,
                              border: `1.5px solid ${selected ? '#10b981' : 'var(--border)'}`,
                              background: selected ? '#10b981' : 'transparent',
                              color: '#fff', fontSize: 11, fontWeight: 700,
                              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                              flexShrink: 0,
                            }}>
                            {selected ? '✓' : ''}
                          </span>
                          <span style={{
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            minWidth: 0,
                          }}>{p.name}</span>
                        </span>
                        {has && (
                          <span style={{
                            fontSize: 11, color: responseLabels[has.response].color, fontWeight: 600,
                            flexShrink: 0,
                          }}>
                            {responseLabels[has.response].label}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          {/* Response picker — visible whenever ≥1 player is selected. */}
          {selectedCount > 0 && (
            <>
              {/* "Current vote" hint only makes sense for a single-edit. */}
              {singleExistingVote && (
                <div style={{
                  fontSize: 12, color: 'var(--text-muted)', marginBottom: 6,
                  padding: '6px 10px', borderRadius: 6,
                  background: 'rgba(234, 179, 8, 0.08)',
                }}>
                  {t('schedule.proxy.currentVote', { response: responseLabels[singleExistingVote.response].label })}
                </div>
              )}
              {/* Cap-exceeded inline error: shown when the admin pre-selected
                  players with a non-'yes' response and then switched the
                  response to 'yes' such that the projected count would
                  break the target. We don't auto-prune the selection —
                  the admin chooses whom to deselect. */}
              {capExceeded && (
                <div style={{
                  fontSize: 12, fontWeight: 600, marginBottom: 6,
                  padding: '6px 10px', borderRadius: 6,
                  background: 'rgba(239, 68, 68, 0.12)',
                  color: '#ef4444',
                  border: '1px solid rgba(239, 68, 68, 0.4)',
                }}>
                  ⚠️ {t('schedule.proxy.capExceeded')}
                </div>
              )}

              <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
                {(['yes', 'maybe', 'no'] as RsvpResponse[]).map(resp => {
                  if (resp === 'maybe' && !poll.allowMaybe) return null;
                  const active = response === resp;
                  const c = responseLabels[resp].color;
                  return (
                    <button
                      key={resp}
                      onClick={() => setResponse(resp)}
                      style={{
                        padding: '8px 14px', borderRadius: 6,
                        border: active ? `2px solid ${c}` : '1px solid var(--border)',
                        background: active ? `${c}22` : 'transparent',
                        color: active ? c : 'var(--text)',
                        fontWeight: active ? 700 : 500, fontSize: 13, cursor: 'pointer',
                      }}>{responseLabels[resp].label}</button>
                  );
                })}
              </div>

              <div style={{ marginBottom: 12 }}>
                <input
                  type="text"
                  value={comment}
                  onChange={(e) => setComment(e.target.value.slice(0, 280))}
                  placeholder={t('schedule.commentPlaceholder')}
                  style={inputBase}
                />
              </div>
            </>
          )}
        </div>

        {/* Pinned footer — always visible, never scrolls off.
            flexWrap lets Cancel/Delete/Save spill onto a second line
            on very narrow viewports (≤340px wide) instead of forcing
            a horizontal scroll inside the modal. */}
        <div className="actions" style={{
          flexShrink: 0,
          marginTop: 12,
          paddingTop: 12,
          borderTop: '1px solid var(--border)',
          justifyContent: 'flex-end',
          flexWrap: 'wrap',
          rowGap: 8,
        }}>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>
            {t('common.cancel')}
          </button>
          {/* Delete shows up whenever any selected player has an
              existing vote on this date. Single-select reads "Delete
              vote", bulk-select reads "Delete N votes" — selected
              players without a current vote are silently skipped at
              perform time (nothing to delete for them). */}
          {selectedExistingVotes.length > 0 && (
            <button
              className="btn btn-danger btn-sm"
              onClick={handleDelete}
              disabled={submitting}
              style={{ opacity: submitting ? 0.6 : 1 }}>
              {selectedExistingVotes.length === 1
                ? t('schedule.proxy.deleteVote')
                : t('schedule.proxy.deleteVotesBulk', { count: selectedExistingVotes.length })}
            </button>
          )}
          <button
            onClick={handleSubmit}
            disabled={submitting || selectedCount === 0 || capExceeded}
            style={{
              ...lightGreenBtn,
              padding: '8px 16px', fontSize: 13, fontWeight: 600,
              cursor: submitting ? 'wait' : 'pointer',
              opacity: (submitting || selectedCount === 0 || capExceeded) ? 0.5 : 1,
            }}>
            {submitting ? '...' : t('common.save')}
          </button>
        </div>
      </div>
    </div>
    {/* Nested confirm-delete modal — stacks above the proxy modal via a
        second ModalPortal so the .modal-overlay's fixed positioning
        keeps it anchored to the viewport regardless of the parent's
        overflow/transform context. */}
    {confirmingDelete && selectedExistingVotes.length > 0 && (() => {
      const isBulk = selectedExistingVotes.length > 1;
      const singlePlayer = !isBulk
        ? players.find(p => p.id === selectedExistingVotes[0].playerId)
        : null;
      // For bulk we list player names so the admin sees exactly which
      // votes will go. The list collapses gracefully on narrow modals
      // — names wrap with comma separators rather than each on a line.
      const bulkNames = isBulk
        ? selectedExistingVotes
            .map(v => players.find(p => p.id === v.playerId)?.name || '?')
            .join(', ')
        : '';
      return (
        <ModalPortal>
          <div className="modal-overlay" onClick={() => !submitting && setConfirmingDelete(false)}>
            <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 380, direction: 'rtl' }}>
              <div className="modal-header">
                <h3 className="modal-title">
                  {isBulk ? t('schedule.proxy.confirmDeleteTitleBulk') : t('schedule.proxy.confirmDeleteTitle')}
                </h3>
                <button
                  className="modal-close"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={submitting}
                  aria-label={t('common.close')}
                >×</button>
              </div>
              <p className="text-muted" style={{ fontSize: '0.9rem', marginBottom: isBulk ? '0.5rem' : '1rem', lineHeight: 1.5 }}>
                {isBulk
                  ? t('schedule.proxy.confirmDeleteBulk', { count: selectedExistingVotes.length })
                  : t('schedule.proxy.confirmDelete', { name: singlePlayer?.name || '' })}
              </p>
              {isBulk && (
                <div style={{
                  fontSize: '0.78rem', color: 'var(--text)',
                  marginBottom: '1rem', lineHeight: 1.5,
                  padding: '0.5rem 0.65rem', borderRadius: 6,
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  wordBreak: 'break-word',
                }}>
                  {bulkNames}
                </div>
              )}
              <div className="actions">
                <button
                  className="btn btn-secondary"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={submitting}
                >
                  {t('common.cancel')}
                </button>
                <button
                  className="btn"
                  onClick={performDelete}
                  disabled={submitting}
                  style={{
                    background: '#ef4444', color: '#fff', fontWeight: 600,
                    opacity: submitting ? 0.7 : 1,
                    cursor: submitting ? 'wait' : 'pointer',
                  }}
                >
                  {submitting
                    ? '...'
                    : isBulk
                      ? t('schedule.proxy.deleteVotesBulk', { count: selectedExistingVotes.length })
                      : t('schedule.proxy.deleteVote')}
                </button>
              </div>
            </div>
          </div>
        </ModalPortal>
      );
    })()}
    </ModalPortal>
  );
}

// ─── Schedule Config Panel (admin-only group settings) ───

interface ScheduleConfigPanelProps {
  onSuccess: (text: string) => void;
  onError: (text: string) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

function ScheduleConfigPanel(props: ScheduleConfigPanelProps) {
  const { onSuccess, onError, t } = props;
  const initial = getSettings();
  const [pushEnabled, setPushEnabled] = useState<boolean>(initial.schedulePushEnabled !== false);
  const [emailsEnabled, setEmailsEnabled] = useState<boolean>(initial.scheduleEmailsEnabled === true);
  const [defaultTarget, setDefaultTarget] = useState<number>(initial.scheduleDefaultTarget ?? 7);
  const [defaultDelay, setDefaultDelay] = useState<number>(initial.scheduleDefaultDelayHours ?? 48);
  const [defaultTime, setDefaultTime] = useState<string>(initial.scheduleDefaultTime ?? '21:00');
  const [defaultAllowMaybe, setDefaultAllowMaybe] = useState<boolean>(initial.scheduleDefaultAllowMaybe !== false);
  // Per-(user, group) vote-change opt-out (migration 032). Optimistic
  // UI: assume ON until the server reports the persisted value, since
  // that's the default for fresh accounts and avoids a "flicker off"
  // on first paint.
  const [voteChangeNotifs, setVoteChangeNotifs] = useState<boolean>(true);

  // Re-sync local state when the underlying settings change (e.g. after a
  // realtime refresh) so the toggles never silently revert without telling
  // the user that the persist round-trip failed.
  useEffect(() => {
    const sync = () => {
      const fresh = getSettings();
      setPushEnabled(fresh.schedulePushEnabled !== false);
      setEmailsEnabled(fresh.scheduleEmailsEnabled === true);
      setDefaultTarget(fresh.scheduleDefaultTarget ?? 7);
      setDefaultDelay(fresh.scheduleDefaultDelayHours ?? 48);
      setDefaultTime(fresh.scheduleDefaultTime ?? '21:00');
      setDefaultAllowMaybe(fresh.scheduleDefaultAllowMaybe !== false);
    };
    window.addEventListener('supabase-cache-updated', sync);
    return () => window.removeEventListener('supabase-cache-updated', sync);
  }, []);

  // Load the user's vote-change opt-out preference once on mount. It
  // lives on group_members (per-user, per-group) rather than the
  // group-wide settings cache, so it has its own fetch.
  useEffect(() => {
    const groupId = getGroupId();
    if (!groupId) return;
    let cancelled = false;
    getMyVoteChangeNotifs(groupId)
      .then(enabled => { if (!cancelled) setVoteChangeNotifs(enabled); })
      .catch(err => console.warn('getMyVoteChangeNotifs failed:', err));
    return () => { cancelled = true; };
  }, []);

  type Patch = Partial<Pick<Settings,
    | 'schedulePushEnabled' | 'scheduleEmailsEnabled'
    | 'scheduleDefaultTarget' | 'scheduleDefaultDelayHours'
    | 'scheduleDefaultTime' | 'scheduleDefaultAllowMaybe'
  >>;
  const persist = async (next: Patch) => {
    saveSettings({ ...getSettings(), ...next });
    onSuccess(t('schedule.config.saved'));
  };

  const handlePushToggle = (checked: boolean) => {
    setPushEnabled(checked);
    void persist({ schedulePushEnabled: checked });
  };

  const handleEmailsToggle = (checked: boolean) => {
    setEmailsEnabled(checked);
    void persist({ scheduleEmailsEnabled: checked });
  };

  // Number inputs persist on blur to avoid writing on every keystroke.
  // We compare against the CURRENT persisted value (read fresh from cache),
  // not the snapshot taken at mount — otherwise typing 10 → blur (saves) →
  // typing 8 → blur would silently no-op because 8 still matches the stale
  // mount-time `initial.scheduleDefaultTarget`, and the change wouldn't be
  // persisted.
  const commitDefaultTarget = () => {
    const clamped = Math.max(2, Math.min(12, defaultTarget || 7));
    if (clamped !== defaultTarget) setDefaultTarget(clamped);
    const persisted = getSettings().scheduleDefaultTarget ?? 7;
    if (clamped !== persisted) {
      void persist({ scheduleDefaultTarget: clamped });
    }
  };

  const commitDefaultDelay = () => {
    const clamped = Math.max(0, Math.min(240, defaultDelay || 0));
    if (clamped !== defaultDelay) setDefaultDelay(clamped);
    const persisted = getSettings().scheduleDefaultDelayHours ?? 48;
    if (clamped !== persisted) {
      void persist({ scheduleDefaultDelayHours: clamped });
    }
  };

  const handleDefaultTime = (next: string) => {
    setDefaultTime(next);
    void persist({ scheduleDefaultTime: next });
  };

  const handleDefaultAllowMaybe = (checked: boolean) => {
    setDefaultAllowMaybe(checked);
    void persist({ scheduleDefaultAllowMaybe: checked });
  };

  // Vote-change opt-out toggle. Optimistic local state; rolls back on
  // server failure so the UI never lies about the persisted value.
  const handleVoteChangeNotifsToggle = async (checked: boolean) => {
    const groupId = getGroupId();
    if (!groupId) return;
    setVoteChangeNotifs(checked);
    try {
      await setMyVoteChangeNotifs(groupId, checked);
      onSuccess(t('schedule.config.saved'));
    } catch (err) {
      console.warn('setMyVoteChangeNotifs failed:', err);
      setVoteChangeNotifs(!checked);
      onError(t('schedule.errorGeneric'));
    }
  };

  const rowStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '8px 0',
  };

  return (
    <div style={{
      marginTop: 10, padding: 12, borderRadius: 8,
      background: 'var(--surface-elevated, var(--surface))',
      border: '1px solid var(--border)',
    }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 10 }}>
        ⚙️ {t('schedule.config.title')}
      </div>

      <div style={rowStyle}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
            🔔 {t('schedule.config.pushEnabled')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
            {t('schedule.config.pushHelper')}
          </div>
        </div>
        <ToggleSwitch
          checked={pushEnabled}
          onChange={handlePushToggle}
          ariaLabel={t('schedule.config.pushEnabled')}
        />
      </div>

      <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />

      <div style={rowStyle}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
            ✉️ {t('schedule.config.emailsEnabled')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
            {t('schedule.config.emailsHelper')}
          </div>
        </div>
        <ToggleSwitch
          checked={emailsEnabled}
          onChange={handleEmailsToggle}
          ariaLabel={t('schedule.config.emailsEnabled')}
        />
      </div>

      <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />

      {/* Per-admin opt-out for vote_change pings. Group-wide push and
          email toggles above gate the channel for everyone; this row
          is the personal "should the chatty vote-change notifications
          ping me specifically" preference. Per (user, group). */}
      <div style={rowStyle}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
            {t('schedule.config.voteChangeNotifs')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
            {t('schedule.config.voteChangeNotifsHelper')}
          </div>
        </div>
        <ToggleSwitch
          checked={voteChangeNotifs}
          onChange={handleVoteChangeNotifsToggle}
          ariaLabel={t('schedule.config.voteChangeNotifs')}
        />
      </div>

      <div style={{ height: 1, background: 'var(--border)', margin: '12px 0 8px' }} />

      {/* Defaults for new polls */}
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>
        🎯 {t('schedule.config.defaultsTitle')}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.5 }}>
        {t('schedule.config.defaultsHelper')}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <div style={{ flex: 1, minWidth: 130 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
            {t('schedule.config.defaultTarget')}
          </div>
          <input
            type="number" min={2} max={12}
            value={defaultTarget}
            onChange={(e) => setDefaultTarget(parseInt(e.target.value, 10) || 0)}
            onBlur={commitDefaultTarget}
            style={inputBase}
          />
        </div>
        <div style={{ flex: 1, minWidth: 130 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
            {t('schedule.config.defaultDelayHours')}
          </div>
          <input
            type="number" min={0} max={240}
            value={defaultDelay}
            onChange={(e) => setDefaultDelay(parseInt(e.target.value, 10) || 0)}
            onBlur={commitDefaultDelay}
            style={inputBase}
          />
        </div>
        <div style={{
          flex: 1, minWidth: 130,
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {t('schedule.config.defaultTime')}
          </div>
          <Time24Picker value={defaultTime} onChange={handleDefaultTime} />
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 13, color: 'var(--text)' }}>
        <span style={{ flex: 1 }}>{t('schedule.config.defaultAllowMaybe')}</span>
        <ToggleSwitch
          checked={defaultAllowMaybe}
          onChange={handleDefaultAllowMaybe}
          ariaLabel={t('schedule.config.defaultAllowMaybe')}
        />
      </div>
    </div>
  );
}

// ─── 24-hour Time Picker ───
// Native <input type="time"> falls back to OS locale on Chromium/Edge and
// happily renders 12-hour AM/PM regardless of the `lang` attribute. This
// component forces a guaranteed 24-hour HH:MM picker via two free-typed
// number inputs (clamped + padded on blur).

interface Time24PickerProps {
  value: string; // "HH:MM" 24h
  onChange: (next: string) => void;
}

function Time24Picker({ value, onChange }: Time24PickerProps) {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const [hStr = '21', mStr = '00'] = (value || '21:00').split(':');
  const validHour = Math.max(0, Math.min(23, parseInt(hStr, 10) || 0));
  const validMinute = Math.max(0, Math.min(59, parseInt(mStr, 10) || 0));

  // Local draft state lets the user type freely (e.g. type "1" then "9" to
  // mean 19 — without React snapping the field to "01" mid-stream). We
  // commit + clamp + pad on blur or Enter.
  const [hourDraft, setHourDraft] = useState(pad(validHour));
  const [minuteDraft, setMinuteDraft] = useState(pad(validMinute));

  // Re-sync drafts when the parent's value changes externally (e.g. a
  // settings reload). We deliberately depend only on `value`.
  useEffect(() => {
    setHourDraft(pad(validHour));
    setMinuteDraft(pad(validMinute));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const emit = (h: number, m: number) => onChange(`${pad(h)}:${pad(m)}`);

  const commitHour = () => {
    const n = Math.max(0, Math.min(23, parseInt(hourDraft, 10) || 0));
    setHourDraft(pad(n));
    if (n !== validHour) emit(n, validMinute);
  };
  const commitMinute = () => {
    const n = Math.max(0, Math.min(59, parseInt(minuteDraft, 10) || 0));
    setMinuteDraft(pad(n));
    if (n !== validMinute) emit(validHour, n);
  };

  const numInputStyle: React.CSSProperties = {
    ...inputBase,
    width: 44, padding: '8px 6px', textAlign: 'center',
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 4, flex: 'none',
      direction: 'ltr', // time renders as HH:MM regardless of parent direction
    }}>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={2}
        value={hourDraft}
        onChange={(e) => setHourDraft(e.target.value.replace(/[^0-9]/g, ''))}
        onBlur={commitHour}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        onFocus={(e) => e.target.select()}
        style={numInputStyle}
        aria-label="hour"
        placeholder="HH"
      />
      <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>:</span>
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={2}
        value={minuteDraft}
        onChange={(e) => setMinuteDraft(e.target.value.replace(/[^0-9]/g, ''))}
        onBlur={commitMinute}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        onFocus={(e) => e.target.select()}
        style={numInputStyle}
        aria-label="minute"
        placeholder="MM"
      />
    </div>
  );
}

// ─── Shared inline styles ───

const inputBase: React.CSSProperties = {
  padding: '8px 10px', borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--surface)', color: 'var(--text)', fontSize: 13, width: '100%',
};

// Soft / light-green outlined button — matches the existing pill style
// used elsewhere in the app (e.g. the Schedule tab pill in the settings nav).
const lightGreenBtn: React.CSSProperties = {
  padding: '6px 12px', borderRadius: 6,
  border: '1px solid rgba(16, 185, 129, 0.4)',
  background: 'rgba(16, 185, 129, 0.15)',
  color: '#34d399',
  fontSize: 13, fontWeight: 500, cursor: 'pointer',
};
