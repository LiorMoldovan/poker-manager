import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  getAllPolls, getAllPlayers, getSettings, saveSettings,
  createPoll, castVote, cancelPoll, manuallyClosePoll,
  updatePollMeta,
  deletePoll,
  adminCastVote, adminDeleteVote,
  subscribeToPollChanges, unsubscribeFromPollChanges,
  getMyPollChangeSubscriptions,
  getMyVoteChangeNotifs, setMyVoteChangeNotifs,
  getGroupId,
} from '../database/storage';
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

// Render a modal as a direct child of <body>. This is critical for
// `position: fixed` overlays: any ancestor with a non-`none` transform,
// filter, perspective, or backdrop-filter promotes itself to the
// containing block for fixed-position descendants — clipping the overlay
// to that ancestor's box instead of the viewport. Cards in this tab
// commonly carry residual transforms from entry animations, so without
// a portal the overlay would be clipped to the card and the modal's
// pinned footer (Save button) ends up off-screen on mobile. Rendering
// at <body> guarantees the overlay anchors to the actual viewport.
const ModalPortal = ({ children }: { children: ReactNode }) =>
  typeof document !== 'undefined' ? createPortal(children, document.body) : null;

// ─── Helpers ───────────────────────────────────────────

const fmtHebrewDate = (d: GamePollDate): string => {
  try {
    const dt = new Date(`${d.proposedDate}T${d.proposedTime || '21:00'}`);
    const wd = dt.toLocaleDateString('he-IL', { weekday: 'long' });
    const day = dt.getDate();
    const mon = dt.getMonth() + 1;
    const time = d.proposedTime ? ` ${d.proposedTime.slice(0, 5)}` : '';
    return `${wd} ${day}/${mon}${time}`;
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

// Archive a finished poll IF either:
//   * it's older than ARCHIVE_DAYS (the long-tail rule), OR
//   * there's at least one actionable poll alongside it (the "we've moved
//     on" signal — a new poll, a confirmed game waiting to start, etc.).
// Active polls are never archived.
const shouldArchive = (p: GamePoll, hasActionable: boolean): boolean => {
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

export default function ScheduleTab() {
  const { t, isRTL } = useTranslation();
  const { role, isOwner, isSuperAdmin, playerName } = usePermissions();
  const navigate = useNavigate();

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
    if (msg.includes('poll_locked')) return t('schedule.errorPollLocked');
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

  // Partition polls into active vs archive.
  // Two-pass: first detect whether any poll is actionable (voting open or
  // start-game pending), then route each finished poll through shouldArchive
  // with that signal. This is what implements the "new poll → previous
  // round's finished polls collapse to history" UX.
  const { activePolls, archivePolls } = useMemo(() => {
    const hasActionable = polls.some(isActionablePoll);
    const a: GamePoll[] = [];
    const h: GamePoll[] = [];
    for (const p of polls) {
      if (shouldArchive(p, hasActionable)) h.push(p);
      else a.push(p);
    }
    return { activePolls: a, archivePolls: h };
  }, [polls]);

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

  const handleManualClose = async (poll: GamePoll, dateId: string) => {
    if (!confirm(t('schedule.manualClose') + '?')) return;
    try {
      await manuallyClosePoll(poll.id, dateId);
      // Re-fetch the freshly confirmed poll and trigger notifications
      const fresh = getAllPolls().find(p => p.id === poll.id);
      if (fresh && fresh.status === 'confirmed') {
        sendConfirmedNotifications(fresh).catch(() => {});
      }
    } catch (e) { showMsg('error', handleRpcError(e)); }
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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <h2 style={{
            margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--text)',
            // Allow ellipsis on extreme narrow viewports without forcing the
            // action buttons (⚙️ + Create) to wrap below.
            minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            📅 {t('schedule.tabTitle')}
          </h2>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {isAdmin && (
              <button
                onClick={() => setShowConfig(s => !s)}
                title={t('schedule.config')}
                style={{
                  padding: '8px 10px', borderRadius: 8,
                  border: '1px solid var(--border)', background: 'transparent',
                  color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14,
                }}>
                ⚙️
              </button>
            )}
            {isAdmin && (
              <button
                onClick={() => setShowCreateModal(true)}
                style={{
                  padding: '8px 14px', borderRadius: 8, border: 'none',
                  background: 'var(--primary)', color: '#fff', fontWeight: 600, cursor: 'pointer',
                }}>
                {activePolls.length === 0 && archivePolls.length === 0
                  ? t('schedule.empty.createFirst')
                  : t('schedule.create')}
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
        <PollCard
          key={poll.id}
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
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────

interface PollCardProps {
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

  const canVote = useMemo(() => {
    if (!currentPlayer) return { allowed: false, reason: 'no_player_link' as const };
    // Voting is allowed on open / expanded / confirmed. Confirmed-state
    // voting (added in migration 031) lets members "change their mind"
    // — drop out, add a late "yes", etc. — without un-confirming the
    // game. Cancelled and expired stay locked.
    if (poll.status === 'cancelled' || poll.status === 'expired') {
      return { allowed: false, reason: 'poll_locked' as const };
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
  }, [poll.status, poll.expandedAt, currentPlayer]);

  // Admin proxy-vote modal state — keyed by date id; null when closed.
  const [proxyDateId, setProxyDateId] = useState<string | null>(null);

  // Confirmed date helpers
  const confirmedDate = poll.dates.find(d => d.id === poll.confirmedDateId);
  const confirmedPlayers = useMemo(() => {
    if (!confirmedDate) return [] as Player[];
    return poll.votes
      .filter(v => v.dateId === confirmedDate.id && v.response === 'yes')
      .map(v => playerById.get(v.playerId))
      .filter((p): p is Player => !!p);
  }, [confirmedDate, poll.votes, playerById]);

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
  const statusLabelKey = `schedule.status${poll.status.charAt(0).toUpperCase() + poll.status.slice(1)}`;

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
  ) => {
    if (isSharing) return;
    setShareMode(mode);
    setIsSharing(true);
    try {
      // Wait for two animation frames so React has committed the share-card DOM
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (!shareCardRef.current) return;
      const files = await captureAndSplit(shareCardRef.current, baseName, { backgroundColor: '#0f172a' });
      await shareFiles(files, title);
    } catch (e) {
      onError(handleRpcError(e));
    } finally {
      setIsSharing(false);
      setShareMode(null);
    }
  }, [isSharing, onError, handleRpcError]);

  const handleShareInvitation = () => captureShare('invitation', `poker-poll-invitation-${poll.id.slice(0, 8)}`, t('schedule.share.invitationTitle'));
  const handleShareConfirmation = () => captureShare('confirmation', `poker-poll-confirmed-${poll.id.slice(0, 8)}`, t('schedule.share.confirmationTitle'));
  const handleShareCancellation = () => captureShare('cancellation', `poker-poll-cancelled-${poll.id.slice(0, 8)}`, t('schedule.share.cancellationTitle'));

  const statusMeta = STATUS_META[poll.status] || STATUS_META.open;

  return (
    <div className="card poll-card" style={{ padding: 14, marginBottom: 12, borderRight: `4px solid ${statusColor[poll.status] || 'var(--border)'}` }}>
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
            {t(statusLabelKey as TranslationKey)}
          </span>
          {poll.status !== 'confirmed' && poll.status !== 'cancelled' && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {t('schedule.targetProgress', { count: bestDateYes, target: poll.targetPlayerCount })}
            </span>
          )}
          {isExpansionDue && (
            <span style={{ fontSize: 11, color: '#f59e0b' }} title={t('schedule.timer.openPhaseDue')}>⏰</span>
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

      {/* Confirmed banner — keeps the green "this date is locked in"
          identity but exposes the live voter list in full so members
          can still see who's in / out / maybe even after auto-close.
          Voting is server-locked once status='confirmed' (cast_poll_vote
          rejects), but the breakdown remains useful: admins can still
          proxy-vote to backfill / correct the roster, and changes to
          existing rows (e.g. someone updated their comment) flow in via
          realtime. */}
      {poll.status === 'confirmed' && confirmedDate && (() => {
        const s = dateStats.get(confirmedDate.id) || {
          yes: 0, maybe: 0, no: 0, voters: [], proxyCount: 0,
        };
        const myVote = currentUserVoteByDate.get(confirmedDate.id);
        // Confirmed-state vote changes (migration 031). The poll stays
        // confirmed regardless of how the count moves — confirmation is
        // one-way. We surface a "below target" warning so the admin
        // sees at a glance when too many people have dropped out and
        // can manually cancel if needed.
        const missing = Math.max(0, poll.targetPlayerCount - s.yes);
        const isBelowTarget = missing > 0;
        return (
          <div className={`poll-confirmed-banner${isBelowTarget ? ' poll-confirmed-banner--below-target' : ''}`}>
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
            {/* Below-target warning — the confirmation count has dropped
                below the configured target since the game was locked in.
                Surfaces in the green banner so admins can see at a glance
                whether to cancel/re-poll. We don't auto-revert status —
                that decision belongs to the organizer. */}
            {isBelowTarget && (
              <div style={{
                padding: '6px 10px', borderRadius: 6, marginBottom: 8,
                background: 'rgba(234, 179, 8, 0.12)',
                border: '1px solid rgba(234, 179, 8, 0.35)',
                color: '#eab308', fontSize: 12, fontWeight: 600,
              }}>
                {t('schedule.belowTarget', { count: s.yes, missing })}
              </div>
            )}
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
                const disabled = !canVote.allowed;
                return (
                  <button
                    key={resp}
                    disabled={disabled}
                    onClick={() => onVote(poll, confirmedDate.id, resp)}
                    title={
                      canVote.allowed ? '' :
                      canVote.reason === 'no_player_link' ? t('schedule.errorNoPlayerLink') :
                      canVote.reason === 'tier_not_allowed' ? t('schedule.errorTierNotAllowed') :
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
                  title={t('schedule.proxy.modalTitle')}
                  className="poll-rsvp-btn"
                  style={{
                    padding: '6px 10px', borderRadius: 8,
                    border: '1px solid rgba(16, 185, 129, 0.4)',
                    background: 'rgba(16, 185, 129, 0.12)',
                    color: '#34d399', fontSize: 11, fontWeight: 600, cursor: 'pointer',
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

      {/* Per-date rows (only for open/expanded; confirmed already shown above) */}
      {(poll.status === 'open' || poll.status === 'expanded') && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {poll.dates.map(d => {
            const s = dateStats.get(d.id) || { yes: 0, maybe: 0, no: 0, voters: [], proxyCount: 0 };
            const myVote = currentUserVoteByDate.get(d.id);
            const loc = d.location || poll.defaultLocation;
            return (
              <div key={d.id} className="poll-date-row" style={{
                padding: 10, borderRadius: 8, background: 'var(--surface-elevated, var(--surface))',
                border: '1px solid var(--border)',
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
                    const disabled = !canVote.allowed;
                    return (
                      <button
                        key={resp}
                        disabled={disabled}
                        onClick={() => onVote(poll, d.id, resp)}
                        title={
                          canVote.allowed ? '' :
                          canVote.reason === 'no_player_link' ? t('schedule.errorNoPlayerLink') :
                          canVote.reason === 'tier_not_allowed' ? t('schedule.errorTierNotAllowed') :
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
                      title={t('schedule.proxy.modalTitle')}
                      className="poll-rsvp-btn"
                      style={{
                        padding: '6px 10px', borderRadius: 8,
                        border: '1px solid rgba(16, 185, 129, 0.4)',
                        background: 'rgba(16, 185, 129, 0.12)',
                        color: '#34d399', fontSize: 11, fontWeight: 600, cursor: 'pointer',
                      }}>{t('schedule.proxy.add')}</button>
                  )}
                </div>
                {/* Live voter lists — visible to everyone */}
                <VoterGroups
                  voters={s.voters}
                  playerById={playerById}
                  userIdToPlayerName={userIdToPlayerName}
                  allowMaybe={poll.allowMaybe}
                  t={t}
                />
                {/* Per-date footer — vote counts are visible to everyone, the
                    manual-close action is admin-only. Sits below the voter
                    list so the date row reads top→bottom: header, RSVP,
                    chips, summary + admin commit. The three count pills
                    mirror the RSVP / voter-chip color scheme so the same
                    "yes / maybe / no" identity carries through the row. */}
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  gap: 8, marginTop: 8, paddingTop: 6,
                  borderTop: '1px dashed var(--border)',
                }}>
                  <VoteCountPills
                    yes={s.yes}
                    maybe={s.maybe}
                    no={s.no}
                    allowMaybe={poll.allowMaybe}
                    t={t}
                  />
                  {isAdmin && (
                    <button
                      onClick={() => onManualClose(d.id)}
                      className="poll-ghost-btn"
                      style={{
                        padding: '4px 10px', borderRadius: 6,
                        border: '1px dashed var(--border)', background: 'transparent',
                        color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer',
                      }}>{t('schedule.manualClose')}</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
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
        {(poll.status === 'open' || poll.status === 'expanded') && (
          <button onClick={handleShareInvitation} disabled={isSharing} style={shareBtn}>
            {isSharing ? t('common.capturing') : t('common.share')}
          </button>
        )}
        {/* Vote-change subscription toggle — members only, active polls only.
            Admins/owners are server-side always-recipients so they don't need
            this button (and we hide it to keep the action row tight). */}
        {!isAdmin && (poll.status === 'open' || poll.status === 'expanded') && (
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
        {poll.status === 'confirmed' && confirmedDate && (
          <button onClick={handleShareConfirmation} disabled={isSharing} style={shareBtn}>
            {isSharing ? t('common.capturing') : t('common.share')}
          </button>
        )}
        {poll.status === 'cancelled' && isAdmin && (
          <button onClick={handleShareCancellation} disabled={isSharing} style={shareBtn}>
            {isSharing ? t('common.capturing') : t('common.share')}
          </button>
        )}
        {isAdmin && (poll.status === 'open' || poll.status === 'expanded') && (
          <>
            {/* One consolidated edit button — opens EditPollModal where the
                admin can adjust note, default location, target, expansion
                delay, and allow_maybe in a single submit. */}
            <button onClick={onEdit} style={ghostBtn}>✎ {t('schedule.editPoll')}</button>
            <button onClick={onCancel} style={{ ...ghostBtn, color: '#ef4444', borderColor: '#ef4444' }}>
              {t('schedule.cancelPoll')}
            </button>
          </>
        )}
        {/* Delete (permanent) — admin-only, available in any state.
            For active polls we recommend Cancel first via the confirm copy.
            No auto-margin: that consumes all leftover row space and forces
            the button to wrap to its own line on narrow (≤360px) viewports.
            Letting it flow naturally with the rest keeps the action row
            tightly packed on mobile while still working fine on desktop. */}
        {isAdmin && (
          <button
            onClick={onDelete}
            title={t('schedule.deletePoll')}
            style={{
              ...ghostBtn, color: '#ef4444',
              border: '1px dashed rgba(239, 68, 68, 0.5)',
            }}>
            {t('schedule.deletePoll')}
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
              t={t}
            />
          </div>
        </div>
      )}
    </div>
  );
}

const ghostBtn: React.CSSProperties = {
  padding: '6px 10px', borderRadius: 6,
  border: '1px solid var(--border)', background: 'transparent',
  color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer',
};

// App-standard compact share pill (mirrors StatisticsScreen / GraphsScreen).
const shareBtn: React.CSSProperties = {
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

interface PollTimerProps {
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

function PollTimer({ poll, now, t }: PollTimerProps) {
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

interface VoteCountPillsProps {
  yes: number;
  maybe: number;
  no: number;
  allowMaybe: boolean;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

function VoteCountPills({ yes, maybe, no, allowMaybe, t }: VoteCountPillsProps) {
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

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
      {pills.map((p, i) => {
        const active = p.value > 0;
        return (
          <span
            key={i}
            className="poll-count-pill"
            title={`${p.value} ${p.label}`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '2px 9px', borderRadius: 999,
              background: active ? p.bg : 'transparent',
              color: active ? p.color : 'var(--text-muted)',
              border: `1px solid ${active ? `${p.color}55` : 'var(--border)'}`,
              fontSize: 11,
              fontWeight: active ? 700 : 500,
              fontVariantNumeric: 'tabular-nums',
              opacity: active ? 1 : 0.55,
              lineHeight: 1.2,
              animationDelay: `${i * 40}ms`,
            }}
          >
            <span aria-hidden style={{ fontSize: 10 }}>{p.symbol}</span>
            {p.value}
          </span>
        );
      })}
    </span>
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

interface VoterGroupsProps {
  voters: VoterRow[];
  playerById: Map<string, Player>;
  // Maps a vote's cast_by_user_id → player display name. Used to render
  // the "נוסף ע״י <admin name>" byline on proxy chips. Empty entries
  // (admin who has never self-voted) gracefully fall back to a generic
  // "by admin" label.
  userIdToPlayerName: Map<string, string>;
  allowMaybe: boolean;
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

function VoterGroups({ voters, playerById, userIdToPlayerName, allowMaybe, t }: VoterGroupsProps) {
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
// Date typography for the share cards: split the day-of-week, calendar day,
// and time onto distinct visual tiers so the date "reads" at a glance even
// in a compressed WhatsApp preview. Keeps Hebrew RTL by relying on
// document direction rather than hard-coding alignment.
function ShareDateLabel({
  date, color, muted,
}: { date: GamePollDate; color: string; muted: string }) {
  const d = new Date(date.proposedDate);
  const dayOfWeek = isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString('he-IL', { weekday: 'long' });
  const dayMonth = isNaN(d.getTime())
    ? date.proposedDate
    : `${d.getDate()}/${d.getMonth() + 1}`;
  const time = (date.proposedTime || '').trim();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
      {dayOfWeek && (
        <span style={{
          fontSize: 14, fontWeight: 700, color, letterSpacing: 0.2, lineHeight: 1.15,
        }}>{dayOfWeek}</span>
      )}
      <span style={{ fontSize: 12, color: muted, lineHeight: 1.2 }}>
        {dayMonth}{time && ` · ${time}`}
      </span>
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
  const phaseColor = poll.status === 'expanded' ? ACCENT_GREEN : ACCENT_BLUE;
  const phaseLabel = poll.status === 'expanded'
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
      display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14,
    }}>
      <span style={{
        padding: '4px 10px', borderRadius: 999,
        background: `${phaseColor}1f`, color: phaseColor,
        border: `1px solid ${phaseColor}55`,
        fontSize: 11, fontWeight: 700, letterSpacing: 0.3,
      }}>
        {poll.status === 'expanded' ? '🌐' : '⭐'} {phaseLabel}
      </span>
      {opensToAllAt && (
        <span style={{
          padding: '4px 10px', borderRadius: 999,
          background: 'rgba(148, 163, 184, 0.10)', color: TEXT_MUTED,
          border: `1px solid rgba(148, 163, 184, 0.25)`,
          fontSize: 11, fontWeight: 600,
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

type VoterRow = {
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
type DateStat = { yes: number; maybe: number; no: number; voters: VoterRow[]; proxyCount: number };

interface PollShareCardProps {
  mode: 'invitation' | 'confirmation' | 'cancellation';
  poll: GamePoll;
  dateStats: Map<string, DateStat>;
  playerById: Map<string, Player>;
  confirmedDate: GamePollDate | undefined;
  confirmedPlayers: Player[];
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

function PollShareCard({ mode, poll, dateStats, playerById, confirmedDate, confirmedPlayers, t }: PollShareCardProps) {
  // Shared visual tokens
  const BG_OUTER = '#0f172a';        // slate-900 — page background
  const BG_CARD = '#1e293b';         // slate-800 — card surface
  const BORDER = 'rgba(148, 163, 184, 0.18)';
  const TEXT = '#f8fafc';
  const TEXT_MUTED = '#94a3b8';
  const ACCENT_BLUE = '#3b82f6';
  const ACCENT_GREEN = '#10b981';
  const ACCENT_RED = '#ef4444';

  // Header palette per mode
  const headerByMode = {
    invitation: { emoji: '🃏', title: t('schedule.share.invitationTitle'), color: ACCENT_BLUE },
    confirmation: { emoji: '✅', title: t('schedule.share.confirmationTitle'), color: ACCENT_GREEN },
    cancellation: { emoji: '❌', title: t('schedule.share.cancellationTitle'), color: ACCENT_RED },
  } as const;
  const header = headerByMode[mode];

  // Best-vote count for invitation progress bar
  let bestYes = 0;
  for (const s of dateStats.values()) if (s.yes > bestYes) bestYes = s.yes;
  const targetPct = Math.min(100, Math.round((bestYes / Math.max(1, poll.targetPlayerCount)) * 100));

  return (
    <div style={{
      width: 520,
      padding: 20,
      background: BG_OUTER,
      direction: 'rtl',
      fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      color: TEXT,
      lineHeight: 1.4,
    }}>
      <div style={{
        background: BG_CARD,
        border: `1px solid ${BORDER}`,
        borderRadius: 14,
        padding: 18,
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          paddingBottom: 12,
          borderBottom: `1px solid ${BORDER}`,
          marginBottom: 14,
        }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: `${header.color}22`, fontSize: 22,
          }}>{header.emoji}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: TEXT }}>{header.title}</div>
            <div style={{ fontSize: 12, color: TEXT_MUTED, marginTop: 2 }}>
              {new Date(poll.createdAt).toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' })}
            </div>
          </div>
        </div>

        {/* Body — varies by mode */}
        {mode === 'invitation' && (
          <PollShareInvitationBody
            poll={poll}
            dateStats={dateStats}
            playerById={playerById}
            bestYes={bestYes}
            targetPct={targetPct}
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

        {/* Footer — branded wordmark + tagline. The accent line above
            visually anchors the brand to the card without competing with
            the mode-specific accent in the body. */}
        <div style={{
          marginTop: 18,
          paddingTop: 12,
          borderTop: `1px solid ${BORDER}`,
          textAlign: 'center',
        }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            fontSize: 13, fontWeight: 700, color: TEXT,
            letterSpacing: 1.5, textTransform: 'uppercase',
          }}>
            <span style={{ fontSize: 14 }}>🃏</span>
            <span>{t('schedule.share.footer')}</span>
          </div>
          <div style={{
            fontSize: 10, color: TEXT_MUTED, letterSpacing: 1.2,
            textTransform: 'uppercase', marginTop: 3, opacity: 0.7,
          }}>
            {t('schedule.share.tagline')}
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

function PollShareInvitationBody({
  poll, dateStats, playerById, bestYes, targetPct, t, tokens,
}: {
  poll: GamePoll;
  dateStats: Map<string, DateStat>;
  playerById: Map<string, Player>;
  bestYes: number;
  targetPct: number;
  t: PollShareCardProps['t'];
  tokens: ShareTokens;
}) {
  const { TEXT, TEXT_MUTED, BORDER, ACCENT_BLUE = '#3b82f6', ACCENT_GREEN = '#10b981' } = tokens;
  return (
    <>
      {/* Phase + deadline pills — actionable context for recipients who
          might not know whether they can vote yet. */}
      <SharePhaseBadge
        poll={poll}
        t={t}
        tokens={{ TEXT, TEXT_MUTED, ACCENT_BLUE, ACCENT_GREEN }}
      />

      {/* Target progress meter */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
          <span style={{ fontSize: 12, color: TEXT_MUTED }}>🎯 {t('schedule.share.target')}</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: TEXT }}>
            {t('schedule.share.targetProgress', { count: bestYes, target: poll.targetPlayerCount })}
          </span>
        </div>
        <div style={{ height: 6, background: 'rgba(148, 163, 184, 0.15)', borderRadius: 4, overflow: 'hidden' }}>
          <div style={{
            width: `${targetPct}%`, height: '100%',
            background: `linear-gradient(90deg, ${ACCENT_BLUE}, ${ACCENT_GREEN})`,
            borderRadius: 4,
          }} />
        </div>
      </div>

      {/* Proposed dates */}
      <div style={{ fontSize: 12, color: TEXT_MUTED, marginBottom: 8, fontWeight: 600, letterSpacing: 0.3 }}>
        📅 {t('schedule.share.proposedDates')}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {poll.dates.map(d => {
          const s = dateStats.get(d.id) || { yes: 0, maybe: 0, no: 0, voters: [], proxyCount: 0 };
          const loc = d.location || poll.defaultLocation;
          // Group voters by response, in display order yes → maybe → no
          const voterGroups: { resp: RsvpResponse; color: string; tint: string; symbol: string; label: string; rows: VoterRow[] }[] = [
            { resp: 'yes',   color: ACCENT_GREEN, tint: 'rgba(16, 185, 129, 0.10)', symbol: '✓', label: t('schedule.voters.yes'),   rows: s.voters.filter(v => v.response === 'yes') },
            { resp: 'maybe', color: '#eab308',    tint: 'rgba(234, 179, 8, 0.10)',  symbol: '?', label: t('schedule.voters.maybe'), rows: s.voters.filter(v => v.response === 'maybe') },
            { resp: 'no',    color: '#f87171',    tint: 'rgba(239, 68, 68, 0.08)',  symbol: '✕', label: t('schedule.voters.no'),    rows: s.voters.filter(v => v.response === 'no') },
          ];
          return (
            <div key={d.id} style={{
              padding: '10px 12px',
              background: 'rgba(15, 23, 42, 0.5)',
              border: `1px solid ${BORDER}`,
              borderRadius: 8,
              display: 'flex', flexDirection: 'column', gap: 8,
            }}>
              {/* Top row — date + count pills */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <ShareDateLabel date={d} color={TEXT} muted={TEXT_MUTED} />
                  {loc && (
                    <div style={{ fontSize: 12, color: TEXT_MUTED, marginTop: 4 }}>
                      📍 {loc}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <span style={{
                    padding: '3px 8px', borderRadius: 12, fontSize: 11, fontWeight: 700,
                    background: 'rgba(16, 185, 129, 0.15)', color: ACCENT_GREEN,
                  }}>✓ {s.yes}</span>
                  {poll.allowMaybe && (
                    <span style={{
                      padding: '3px 8px', borderRadius: 12, fontSize: 11, fontWeight: 700,
                      background: 'rgba(234, 179, 8, 0.15)', color: '#eab308',
                    }}>? {s.maybe}</span>
                  )}
                  <span style={{
                    padding: '3px 8px', borderRadius: 12, fontSize: 11, fontWeight: 700,
                    background: 'rgba(239, 68, 68, 0.12)', color: '#f87171',
                  }}>✕ {s.no}</span>
                </div>
              </div>

              {/* Voter chips, grouped yes → maybe → no (only groups with voters) */}
              {s.voters.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {voterGroups.map(g => {
                    if (g.rows.length === 0) return null;
                    if (g.resp === 'maybe' && !poll.allowMaybe) return null;
                    return (
                      <div key={g.resp} style={{
                        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6,
                        padding: '6px 8px', borderRadius: 6,
                        background: g.tint,
                        border: `1px solid ${g.color}33`,
                      }}>
                        <span style={{
                          fontSize: 11, fontWeight: 700, color: g.color,
                          padding: '2px 8px', borderRadius: 10,
                          background: `${g.color}22`,
                        }}>
                          {g.symbol} {g.label} · {g.rows.length}
                        </span>
                        {g.rows.map(v => {
                          const name = playerById.get(v.playerId)?.name || '—';
                          return (
                            <span
                              key={`${g.resp}-${v.playerId}`}
                              style={{
                                fontSize: 12, color: TEXT,
                                padding: '2px 8px', borderRadius: 10,
                                background: 'rgba(255, 255, 255, 0.05)',
                                border: `1px solid ${BORDER}`,
                                display: 'inline-flex', alignItems: 'center', gap: 4,
                              }}>
                              {name}
                              {v.isProxy && <span style={{ color: '#eab308', fontSize: 10 }}>★</span>}
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

      {poll.note && (
        <div style={{
          marginTop: 12, padding: '10px 12px',
          background: 'rgba(59, 130, 246, 0.08)',
          borderInlineStart: `3px solid ${ACCENT_BLUE}`,
          borderRadius: 6, fontSize: 13, color: TEXT,
        }}>
          📝 {poll.note}
        </div>
      )}

      <div style={{
        marginTop: 14, padding: '8px 12px',
        textAlign: 'center', fontSize: 12, color: TEXT_MUTED,
        background: 'rgba(59, 130, 246, 0.06)', borderRadius: 6,
      }}>
        🃏 {t('schedule.share.invitationCallToAction')}
      </div>
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
      {/* Confirmed date hero — large, centered "trophy" treatment. */}
      <div style={{
        padding: 16,
        background: `linear-gradient(135deg, rgba(16, 185, 129, 0.18), rgba(16, 185, 129, 0.05))`,
        border: `1px solid rgba(16, 185, 129, 0.40)`,
        borderRadius: 12,
        marginBottom: 14,
        textAlign: 'center',
      }}>
        {(() => {
          const d = new Date(confirmedDate.proposedDate);
          const dayOfWeek = isNaN(d.getTime()) ? '' : d.toLocaleDateString('he-IL', { weekday: 'long' });
          const dayMonth = isNaN(d.getTime()) ? confirmedDate.proposedDate : `${d.getDate()}/${d.getMonth() + 1}`;
          const time = (confirmedDate.proposedTime || '').trim();
          return (
            <>
              <div style={{ fontSize: 13, color: ACCENT_GREEN, fontWeight: 600, letterSpacing: 1, marginBottom: 4 }}>
                🗓 {dayOfWeek}
              </div>
              <div style={{ fontSize: 26, fontWeight: 800, color: TEXT, letterSpacing: 0.5, lineHeight: 1.1 }}>
                {dayMonth}
              </div>
              {time && (
                <div style={{ fontSize: 15, color: TEXT, fontWeight: 600, marginTop: 4 }}>
                  {time}
                </div>
              )}
            </>
          );
        })()}
        {loc && (
          <div style={{ fontSize: 14, color: ACCENT_GREEN, fontWeight: 500, marginTop: 8 }}>
            📍 {loc}
          </div>
        )}
      </div>

      {/* Confirmed players */}
      <div style={{ fontSize: 12, color: TEXT_MUTED, marginBottom: 8, fontWeight: 600, letterSpacing: 0.3 }}>
        👥 {t('schedule.share.confirmedPlayers')} ({confirmedPlayers.length})
      </div>
      <div style={{
        padding: 12,
        background: 'rgba(15, 23, 42, 0.5)',
        border: `1px solid ${BORDER}`,
        borderRadius: 8,
        display: 'flex', flexWrap: 'wrap', gap: 6,
      }}>
        {confirmedPlayers.length > 0 ? confirmedPlayers.map(p => (
          <span key={p.id} style={{
            padding: '5px 10px',
            background: 'rgba(16, 185, 129, 0.12)',
            border: `1px solid rgba(16, 185, 129, 0.25)`,
            borderRadius: 14,
            fontSize: 12,
            color: TEXT,
            fontWeight: 500,
          }}>
            {p.name}
          </span>
        )) : (
          <span style={{ color: TEXT_MUTED, fontSize: 13 }}>—</span>
        )}
      </div>

      {poll.note && (
        <div style={{
          marginTop: 12, padding: '10px 12px',
          background: 'rgba(16, 185, 129, 0.06)',
          borderInlineStart: `3px solid ${ACCENT_GREEN}`,
          borderRadius: 6, fontSize: 13, color: TEXT,
        }}>
          📝 {poll.note}
        </div>
      )}

      <div style={{
        marginTop: 14, padding: '8px 12px',
        textAlign: 'center', fontSize: 12, color: TEXT_MUTED,
        background: 'rgba(16, 185, 129, 0.06)', borderRadius: 6,
      }}>
        🃏 {t('schedule.share.confirmationFarewell')}
      </div>
    </>
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
      {/* Which game was cancelled — show the proposed dates so recipients
          have context even when the admin didn't add a note or reason.
          No vote breakdown here: counts are no longer actionable. */}
      <div style={{ fontSize: 12, color: TEXT_MUTED, marginBottom: 8, fontWeight: 600, letterSpacing: 0.3 }}>
        📅 {t('schedule.share.proposedDates')}
      </div>
      <div style={{
        padding: 12, marginBottom: 12,
        background: 'rgba(15, 23, 42, 0.5)',
        border: `1px solid ${BORDER}`,
        borderRadius: 8,
        display: 'flex', flexDirection: 'column', gap: 6,
      }}>
        {poll.dates.map(d => {
          const loc = d.location || poll.defaultLocation;
          return (
            <div key={d.id} style={{
              display: 'flex', justifyContent: 'space-between',
              alignItems: 'center', gap: 10,
              opacity: 0.7,
              textDecoration: 'line-through',
              textDecorationColor: 'rgba(239, 68, 68, 0.6)',
            }}>
              <ShareDateLabel date={d} color={TEXT} muted={TEXT_MUTED} />
              {loc && (
                <span style={{ fontSize: 12, color: TEXT_MUTED, whiteSpace: 'nowrap' }}>
                  📍 {loc}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {poll.note && (
        <div style={{
          padding: '10px 12px', marginBottom: 10,
          background: 'rgba(148, 163, 184, 0.08)',
          borderInlineStart: `3px solid ${TEXT_MUTED}`,
          borderRadius: 6, fontSize: 13, color: TEXT,
        }}>
          📝 {poll.note}
        </div>
      )}
      {poll.cancellationReason && (
        <div style={{
          padding: '12px 14px',
          background: 'rgba(239, 68, 68, 0.10)',
          border: `1px solid rgba(239, 68, 68, 0.3)`,
          borderRadius: 8,
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: ACCENT_RED, marginBottom: 4, letterSpacing: 0.3 }}>
            💬 {t('schedule.share.cancellationReason')}
          </div>
          <div style={{ fontSize: 14, color: TEXT, lineHeight: 1.5 }}>
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
  const [target, setTarget] = useState(settings.scheduleDefaultTarget ?? 8);
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

function ProxyVoteModal(props: ProxyVoteModalProps) {
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
  // Cap only matters during the active phase. Once the poll is
  // 'confirmed' the auto-close trigger has already locked in the
  // game and won't re-fire (it gates on status IN open/expanded), so
  // accepting more "yes" votes can't accidentally re-confirm a
  // different date. Admins might want to add a late-arriving guest to
  // the roster, and the cap would otherwise block that. Skip the
  // cap entirely on confirmed polls.
  const enforceCap = poll.status === 'open' || poll.status === 'expanded';
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

  const handleDelete = async () => {
    if (!onlySelectedId || !singleExistingVote) return;
    const player = players.find(p => p.id === onlySelectedId);
    if (!confirm(t('schedule.proxy.confirmDelete', { name: player?.name || '' }))) return;
    setSubmitting(true);
    try {
      await adminDeleteVote(dateId, onlySelectedId);
      onSuccess(t('schedule.proxy.deleted'));
      onClose();
    } catch (e) {
      onError(handleRpcError(e));
    } finally {
      setSubmitting(false);
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
                Hidden on confirmed polls (enforceCap=false): the cap
                no longer applies post-confirmation since the auto-
                close trigger can't re-fire on a confirmed row. */}
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
          {/* Delete is only meaningful for a single existing vote. With
              bulk select active we hide it to avoid an ambiguous "delete
              5 votes" — the admin can do that explicitly per row. */}
          {selectedCount === 1 && singleExistingVote && (
            <button
              className="btn btn-danger btn-sm"
              onClick={handleDelete}
              disabled={submitting}
              style={{ opacity: submitting ? 0.6 : 1 }}>
              {t('schedule.proxy.deleteVote')}
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
            {submitting
              ? '...'
              : selectedCount > 1
                ? t('schedule.proxy.saveCount', { count: selectedCount })
                : (singleExistingVote ? t('schedule.proxy.editVote') : t('schedule.proxy.add'))}
          </button>
        </div>
      </div>
    </div>
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
  const [defaultTarget, setDefaultTarget] = useState<number>(initial.scheduleDefaultTarget ?? 8);
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
      setDefaultTarget(fresh.scheduleDefaultTarget ?? 8);
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
    const clamped = Math.max(2, Math.min(12, defaultTarget || 8));
    if (clamped !== defaultTarget) setDefaultTarget(clamped);
    const persisted = getSettings().scheduleDefaultTarget ?? 8;
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
