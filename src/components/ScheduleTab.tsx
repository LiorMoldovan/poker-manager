import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getAllPolls, getAllPlayers, getActiveGame, getSettings, saveSettings, createGame, getPlayerStats,
  createPoll, castVote, cancelPoll, manuallyClosePoll,
  updatePollTarget, updatePollExpansionDelay,
  linkPollToGame,
  adminCastVote, adminDeleteVote,
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
} from '../utils/scheduleNotifications';
import {
  shareToWhatsApp, generatePollInvitationText,
  generatePollConfirmationText, generatePollCancellationText,
} from '../utils/sharing';
import {
  generateAIForecasts, getGeminiApiKey, type PlayerForecastData, type ForecastResult,
} from '../utils/geminiAI';
import type { GamePoll, GamePollDate, RsvpResponse, GameForecast, Player, Settings } from '../types';

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

const ARCHIVE_DAYS = 30;
const isOldFinishedPoll = (p: GamePoll): boolean => {
  if (p.status !== 'cancelled' && p.status !== 'expired' && !(p.status === 'confirmed' && p.confirmedGameId)) {
    return false;
  }
  const created = new Date(p.createdAt).getTime();
  return Date.now() - created > ARCHIVE_DAYS * 24 * 60 * 60 * 1000;
};

const errMsg = (e: unknown): string => {
  if (e && typeof e === 'object' && 'message' in e) {
    return String((e as { message: unknown }).message ?? '');
  }
  return String(e ?? '');
};

// Build PlayerForecastData[] for the simple in-tab forecast generation
const buildPlayerForecastData = (playerIds: string[]): PlayerForecastData[] => {
  const players = getAllPlayers();
  const byId = new Map(players.map(p => [p.id, p]));
  const allStats = getPlayerStats();
  const statsById = new Map(allStats.map(s => [s.playerId, s]));
  const result: PlayerForecastData[] = [];
  for (const id of playerIds) {
    const p = byId.get(id);
    if (!p) continue;
    const stats = statsById.get(p.id);
    const lastGameDate = stats?.lastGameResults?.[0]?.date;
    const daysSince = lastGameDate
      ? Math.floor((Date.now() - new Date(lastGameDate).getTime()) / (1000 * 60 * 60 * 24))
      : 999;
    result.push({
      name: p.name,
      isFemale: p.gender === 'female',
      gamesPlayed: stats?.gamesPlayed || 0,
      totalProfit: stats?.totalProfit || 0,
      avgProfit: stats?.avgProfit || 0,
      winCount: stats?.winCount || 0,
      lossCount: stats?.lossCount || 0,
      winPercentage: stats?.winPercentage || 0,
      currentStreak: stats?.currentStreak || 0,
      bestWin: stats?.biggestWin || 0,
      worstLoss: stats?.biggestLoss ? -Math.abs(stats.biggestLoss) : 0,
      gameHistory: (stats?.lastGameResults || []).slice(0, 20).map(g => {
        const dt = new Date(g.date);
        const dd = String(dt.getDate()).padStart(2, '0');
        const mm = String(dt.getMonth() + 1).padStart(2, '0');
        return { profit: g.profit, date: `${dd}/${mm}/${dt.getFullYear()}`, gameId: g.gameId };
      }),
      daysSinceLastGame: daysSince,
      isActive: daysSince <= 60,
    });
  }
  return result;
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
  const [activeStartPanelPollId, setActiveStartPanelPollId] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);

  const reload = useCallback(() => {
    setPolls(getAllPolls());
    setPlayers(getAllPlayers());
  }, []);

  useEffect(() => { reload(); }, [reload]);
  useRealtimeRefresh(reload);

  // Periodic re-tick so "expansion is due" UI updates without realtime
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Run scheduler sweep on mount and after each realtime/data change
  useEffect(() => {
    runSchedulerSweep().catch(err => console.warn('runSchedulerSweep failed:', err));
  }, [polls.length]);

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

  // Partition polls into active vs archive
  const { activePolls, archivePolls } = useMemo(() => {
    const a: GamePoll[] = [];
    const h: GamePoll[] = [];
    for (const p of polls) {
      if (isOldFinishedPoll(p)) h.push(p);
      else a.push(p);
    }
    return { activePolls: a, archivePolls: h };
  }, [polls]);

  // ── Vote handler ──
  const handleVote = async (_poll: GamePoll, dateId: string, response: RsvpResponse) => {
    try {
      const updated = await castVote(dateId, response);
      // If this vote crossed the threshold, fire confirmed notifications
      if (updated.status === 'confirmed' && !updated.confirmedNotificationsSentAt) {
        sendConfirmedNotifications(updated).catch(err =>
          console.warn('sendConfirmedNotifications failed:', err));
      }
    } catch (e) {
      showMsg('error', handleRpcError(e));
    }
  };

  // ── Admin action handlers ──
  const handleEditTarget = async (poll: GamePoll) => {
    const input = prompt(`${t('schedule.editTarget')} (${poll.targetPlayerCount}):`);
    if (!input) return;
    const n = parseInt(input.trim(), 10);
    if (Number.isNaN(n) || n < 2) { showMsg('error', t('schedule.errorMinTarget')); return; }
    try {
      await updatePollTarget(poll.id, n);
    } catch (e) { showMsg('error', handleRpcError(e)); }
  };

  const handleEditExpansionDelay = async (poll: GamePoll) => {
    const input = prompt(`${t('schedule.editExpansionDelay')} (${poll.expansionDelayHours}):`);
    if (!input) return;
    const n = parseInt(input.trim(), 10);
    if (Number.isNaN(n) || n < 0) { showMsg('error', t('schedule.errorGeneric')); return; }
    try {
      await updatePollExpansionDelay(poll.id, n);
    } catch (e) { showMsg('error', handleRpcError(e)); }
  };

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

  // ── Render ──
  return (
    <div style={{ direction: 'rtl', textAlign: isRTL ? 'right' : 'left' }}>
      {/* Header */}
      <div className="card" style={{ marginBottom: 12, padding: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--text)' }}>
              📅 {t('schedule.tabTitle')}
            </h2>
            <span style={{
              fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 12,
              background: 'rgba(234, 179, 8, 0.15)', color: '#eab308',
              border: '1px solid rgba(234, 179, 8, 0.4)',
            }}>
              {t('schedule.trialBadge')}
            </span>
          </div>
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
          onEditTarget={() => handleEditTarget(poll)}
          onEditDelay={() => handleEditExpansionDelay(poll)}
          onManualClose={(dateId) => handleManualClose(poll, dateId)}
          onCancel={() => setShowCancelModal({ pollId: poll.id })}
          onShareInvitation={() => shareToWhatsApp(generatePollInvitationText(poll, poll.dates))}
          onShareConfirmation={(playerNames) => shareToWhatsApp(generatePollConfirmationText(
            poll,
            poll.dates.find(d => d.id === poll.confirmedDateId)!,
            playerNames,
          ))}
          onShareCancellation={() => shareToWhatsApp(generatePollCancellationText(poll))}
          startPanelOpen={activeStartPanelPollId === poll.id}
          onOpenStartPanel={() => setActiveStartPanelPollId(poll.id)}
          onCloseStartPanel={() => setActiveStartPanelPollId(null)}
          onLinked={() => setActiveStartPanelPollId(null)}
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
              {archivePolls.map(p => (
                <div key={p.id} className="settings-row" style={{ padding: '10px 12px' }}>
                  <div style={{ flex: 1 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {new Date(p.createdAt).toLocaleDateString('he-IL')} ·
                    </span>
                    {' '}
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                      {p.status === 'cancelled' ? t('schedule.statusCancelled')
                        : p.status === 'expired' ? t('schedule.statusExpired')
                        : t('schedule.gameStarted')}
                    </span>
                    {p.cancellationReason && (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                        {p.cancellationReason}
                      </div>
                    )}
                  </div>
                </div>
              ))}
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
  onEditTarget: () => void;
  onEditDelay: () => void;
  onManualClose: (dateId: string) => void;
  onCancel: () => void;
  onShareInvitation: () => void;
  onShareConfirmation: (playerNames: string[]) => void;
  onShareCancellation: () => void;
  startPanelOpen: boolean;
  onOpenStartPanel: () => void;
  onCloseStartPanel: () => void;
  onLinked: () => void;
  onError: (text: string) => void;
  onSuccess: (text: string) => void;
  handleRpcError: (e: unknown) => string;
  navigate: ReturnType<typeof useNavigate>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

function PollCard(props: PollCardProps) {
  const {
    poll, players, currentPlayer, isAdmin, now,
    onVote, onEditTarget, onEditDelay, onManualClose, onCancel,
    onShareInvitation, onShareConfirmation, onShareCancellation,
    startPanelOpen, onOpenStartPanel, onCloseStartPanel, onLinked,
    onError, onSuccess, handleRpcError, navigate, t,
  } = props;

  const playerById = useMemo(() => new Map(players.map(p => [p.id, p])), [players]);

  // Compute per-date yes/maybe/no counts + proxy-vote breakdown
  const dateStats = useMemo(() => {
    type DateStat = {
      yes: number; maybe: number; no: number;
      voters: { playerId: string; response: RsvpResponse; isProxy: boolean }[];
      proxyCount: number;
    };
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
      s.voters.push({ playerId: v.playerId, response: v.response, isProxy });
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
    if (poll.status === 'open' && currentPlayer.type !== 'permanent') return { allowed: false, reason: 'tier_not_allowed' as const };
    if (poll.status !== 'open' && poll.status !== 'expanded') return { allowed: false, reason: 'poll_locked' as const };
    return { allowed: true as const };
  }, [poll.status, currentPlayer]);

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

  // Status pill color
  const statusColor: Record<string, string> = {
    open: '#3b82f6',
    expanded: '#eab308',
    confirmed: '#10b981',
    cancelled: '#ef4444',
    expired: 'var(--text-muted)',
  };
  const statusLabelKey = `schedule.status${poll.status.charAt(0).toUpperCase() + poll.status.slice(1)}`;

  // Expansion-due indicator
  const expansionDueAt = new Date(poll.createdAt).getTime() + poll.expansionDelayHours * 3600_000;
  const isExpansionDue = poll.status === 'open' && now >= expansionDueAt;

  return (
    <div className="card" style={{ padding: 14, marginBottom: 12, borderRight: `4px solid ${statusColor[poll.status] || 'var(--border)'}` }}>
      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            padding: '3px 10px', borderRadius: 10, fontSize: 11, fontWeight: 700,
            background: `${statusColor[poll.status] || '#888'}22`,
            color: statusColor[poll.status] || 'var(--text-muted)',
          }}>{t(statusLabelKey as TranslationKey)}</span>
          {poll.status !== 'confirmed' && poll.status !== 'cancelled' && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {t('schedule.targetProgress', { count: bestDateYes, target: poll.targetPlayerCount })}
            </span>
          )}
          {isExpansionDue && (
            <span style={{ fontSize: 11, color: '#eab308' }}>⏰</span>
          )}
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {new Date(poll.createdAt).toLocaleDateString('he-IL')}
        </div>
      </div>

      {poll.note && (
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>
          {t('schedule.notePrefix')} {poll.note}
        </div>
      )}

      {/* Confirmed banner */}
      {poll.status === 'confirmed' && confirmedDate && (
        <div style={{
          padding: 12, borderRadius: 8, marginBottom: 10,
          background: 'rgba(16, 185, 129, 0.10)', border: '1px solid rgba(16, 185, 129, 0.3)',
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>
            ✅ {fmtHebrewDate(confirmedDate)}
            {(confirmedDate.location || poll.defaultLocation) && (
              <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                {` — ${confirmedDate.location || poll.defaultLocation}`}
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {t('schedule.confirmedPlayers')} ({confirmedPlayers.length}): {confirmedPlayers.map(p => p.name).join(', ')}
          </div>
        </div>
      )}

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
              <div key={d.id} style={{
                padding: 10, borderRadius: 6, background: 'var(--surface-elevated, var(--surface))',
                border: '1px solid var(--border)',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
                    {fmtHebrewDate(d)}
                    {loc && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>{` — ${loc}`}</span>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
                    {s.proxyCount > 0 && (
                      <span title={t('schedule.proxy.proxyTag')} style={{
                        padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600,
                        background: 'rgba(234, 179, 8, 0.15)', color: '#eab308',
                        border: '1px solid rgba(234, 179, 8, 0.4)',
                      }}>
                        {t('schedule.proxy.tagline', { count: s.proxyCount })}
                      </span>
                    )}
                    <span>{t('schedule.voteCounts', { yes: s.yes, maybe: s.maybe, no: s.no })}</span>
                  </div>
                </div>
                {/* RSVP buttons */}
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
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
                        style={{
                          padding: '6px 12px', borderRadius: 6,
                          border: active ? `2px solid ${colorMap[resp]}` : '1px solid var(--border)',
                          background: active ? `${colorMap[resp]}22` : 'transparent',
                          color: active ? colorMap[resp] : 'var(--text)',
                          fontWeight: active ? 700 : 500, fontSize: 13,
                          cursor: disabled ? 'not-allowed' : 'pointer',
                          opacity: disabled ? 0.4 : 1,
                        }}>{labelMap[resp]}</button>
                    );
                  })}
                  {isAdmin && (
                    <>
                      <button
                        onClick={() => setProxyDateId(d.id)}
                        title={t('schedule.proxy.modalTitle')}
                        style={{
                          padding: '6px 10px', borderRadius: 6,
                          border: '1px solid rgba(16, 185, 129, 0.4)',
                          background: 'rgba(16, 185, 129, 0.15)',
                          color: '#34d399', fontSize: 11, fontWeight: 500, cursor: 'pointer',
                          marginInlineStart: 'auto',
                        }}>{t('schedule.proxy.add')}</button>
                      <button
                        onClick={() => onManualClose(d.id)}
                        style={{
                          padding: '6px 10px', borderRadius: 6,
                          border: '1px dashed var(--border)', background: 'transparent',
                          color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer',
                        }}>{t('schedule.manualClose')}</button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        {/* Start Scheduled Game — admin-only. Members see the confirmed
            poll details but can't launch the game (DB also enforces this
            via the createGame ownership/admin checks). */}
        {isAdmin && poll.status === 'confirmed' && confirmedDate && !poll.confirmedGameId && (
          <button
            onClick={onOpenStartPanel}
            style={{
              padding: '8px 14px', borderRadius: 8, border: 'none',
              background: 'var(--primary)', color: '#fff', fontWeight: 600, cursor: 'pointer',
            }}>{t('schedule.startScheduledGame')}</button>
        )}
        {poll.status === 'confirmed' && poll.confirmedGameId && (
          <span style={{ fontSize: 13, fontWeight: 600, color: '#10b981' }}>
            ✓ {t('schedule.gameStarted')}
          </span>
        )}
        {(poll.status === 'open' || poll.status === 'expanded') && (
          <button
            onClick={onShareInvitation}
            style={{
              padding: '6px 12px', borderRadius: 6, border: '1px solid #25d366',
              background: 'rgba(37, 211, 102, 0.10)', color: '#25d366',
              fontSize: 13, fontWeight: 500, cursor: 'pointer',
            }}>📱 {t('schedule.shareWhatsApp')}</button>
        )}
        {poll.status === 'confirmed' && confirmedDate && (
          <button
            onClick={() => onShareConfirmation(confirmedPlayers.map(p => p.name))}
            style={{
              padding: '6px 12px', borderRadius: 6, border: '1px solid #25d366',
              background: 'rgba(37, 211, 102, 0.10)', color: '#25d366',
              fontSize: 13, fontWeight: 500, cursor: 'pointer',
            }}>📱 {t('schedule.shareWhatsApp')}</button>
        )}
        {poll.status === 'cancelled' && isAdmin && (
          <button
            onClick={onShareCancellation}
            style={{
              padding: '6px 12px', borderRadius: 6, border: '1px solid #25d366',
              background: 'rgba(37, 211, 102, 0.10)', color: '#25d366',
              fontSize: 13, fontWeight: 500, cursor: 'pointer',
            }}>📱 {t('schedule.shareWhatsApp')}</button>
        )}
        {isAdmin && (poll.status === 'open' || poll.status === 'expanded') && (
          <>
            <button onClick={onEditTarget} style={ghostBtn}>{t('schedule.editTarget')}</button>
            {poll.status === 'open' && (
              <button onClick={onEditDelay} style={ghostBtn}>{t('schedule.editExpansionDelay')}</button>
            )}
            <button onClick={onCancel} style={{ ...ghostBtn, color: '#ef4444', borderColor: '#ef4444' }}>
              {t('schedule.cancelPoll')}
            </button>
          </>
        )}
      </div>

      {/* Start Scheduled Game edit panel — admin-only */}
      {isAdmin && startPanelOpen && poll.status === 'confirmed' && confirmedDate && !poll.confirmedGameId && (
        <StartGamePanel
          poll={poll}
          confirmedDate={confirmedDate}
          confirmedPlayers={confirmedPlayers}
          allPlayers={players}
          onClose={onCloseStartPanel}
          onLinked={onLinked}
          onError={onError}
          onSuccess={onSuccess}
          handleRpcError={handleRpcError}
          navigate={navigate}
          t={t}
        />
      )}

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
    </div>
  );
}

const ghostBtn: React.CSSProperties = {
  padding: '6px 10px', borderRadius: 6,
  border: '1px solid var(--border)', background: 'transparent',
  color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer',
};

// ─── Start Game Panel ───
interface StartGamePanelProps {
  poll: GamePoll;
  confirmedDate: GamePollDate;
  confirmedPlayers: Player[];
  allPlayers: Player[];
  onClose: () => void;
  onLinked: () => void;
  onError: (text: string) => void;
  onSuccess: (text: string) => void;
  handleRpcError: (e: unknown) => string;
  navigate: ReturnType<typeof useNavigate>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

function StartGamePanel(props: StartGamePanelProps) {
  const { poll, confirmedDate, confirmedPlayers, allPlayers, onClose, onLinked, onError, onSuccess, handleRpcError, navigate, t } = props;

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set(confirmedPlayers.map(p => p.id)));
  const [location, setLocation] = useState<string>(confirmedDate.location || poll.defaultLocation || '');
  const [forecasts, setForecasts] = useState<ForecastResult[] | null>(null);
  const [forecastLoading, setForecastLoading] = useState(false);
  const [forecastError, setForecastError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const toggleId = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const generateForecast = async () => {
    setForecastError(null);
    if (!getGeminiApiKey()) {
      setForecastError(t('schedule.errorGeneric'));
      return;
    }
    setForecastLoading(true);
    try {
      const data = buildPlayerForecastData(Array.from(selectedIds));
      const result = await generateAIForecasts(data, undefined, undefined, location || undefined, undefined);
      setForecasts(result);
    } catch (e) {
      setForecastError(handleRpcError(e));
    } finally {
      setForecastLoading(false);
    }
  };

  const handleStart = async () => {
    // Active game guard
    const active = getActiveGame();
    if (active) {
      const goLive = confirm(t('schedule.activeGameWarning') + '\n\n' + t('schedule.goToActiveGame') + '?');
      if (goLive) navigate(`/live-game/${active.id}`);
      return;
    }

    if (selectedIds.size === 0) { onError(t('schedule.errorGeneric')); return; }

    setStarting(true);
    try {
      const fcs: GameForecast[] | undefined = forecasts
        ? forecasts.map(f => ({
            playerName: f.name,
            expectedProfit: f.expectedProfit,
            highlight: f.highlight,
            sentence: f.sentence,
            isSurprise: f.isSurprise,
          }))
        : undefined;
      const newGame = createGame(Array.from(selectedIds), location || undefined, fcs);
      try {
        await linkPollToGame(poll.id, newGame.id);
        onSuccess(t('schedule.gameStarted'));
        onLinked();
        navigate(`/live-game/${newGame.id}`);
      } catch (linkErr) {
        // Game was created, just the link failed; surface error and stay open for retry
        onError(t('schedule.errorLinkFailed'));
        console.error('linkPollToGame failed:', linkErr);
      }
    } catch (e) {
      onError(handleRpcError(e));
    } finally {
      setStarting(false);
    }
  };

  const settings = getSettings();
  const knownLocations = settings.locations || [];

  return (
    <div style={{
      marginTop: 12, padding: 12, borderRadius: 8,
      background: 'var(--surface-elevated, var(--surface))',
      border: '1px solid var(--border)',
    }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10, color: 'var(--text)' }}>
        {t('schedule.editBeforeStart')}
      </div>

      {/* Location picker */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
          {t('schedule.locationLabel')}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {knownLocations.map(loc => (
            <button
              key={loc}
              onClick={() => setLocation(location === loc ? '' : loc)}
              style={{
                padding: '6px 12px', borderRadius: 6,
                border: location === loc ? '2px solid var(--primary)' : '1px solid var(--border)',
                background: location === loc ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
                color: location === loc ? 'var(--primary)' : 'var(--text-muted)',
                fontSize: 13, cursor: 'pointer',
              }}>{loc}</button>
          ))}
          <input
            type="text"
            value={knownLocations.includes(location) ? '' : location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="..."
            style={{
              padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)',
              background: 'var(--surface)', color: 'var(--text)', fontSize: 13, minWidth: 140,
            }}
          />
        </div>
      </div>

      {/* Player selection */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>
          {t('schedule.confirmedPlayers')} ({selectedIds.size})
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {allPlayers.map(p => {
            const selected = selectedIds.has(p.id);
            return (
              <button
                key={p.id}
                onClick={() => toggleId(p.id)}
                style={{
                  padding: '6px 12px', borderRadius: 6,
                  border: selected ? '2px solid var(--primary)' : '1px solid var(--border)',
                  background: selected ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
                  color: selected ? 'var(--primary)' : 'var(--text-muted)',
                  fontSize: 13, cursor: 'pointer',
                }}>
                {p.name}
              </button>
            );
          })}
        </div>
      </div>

      {/* Forecast section */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            onClick={generateForecast}
            disabled={forecastLoading || selectedIds.size === 0}
            style={{
              padding: '8px 12px', borderRadius: 6, border: '1px solid var(--border)',
              background: 'transparent', color: 'var(--text)', fontSize: 13,
              cursor: forecastLoading ? 'wait' : 'pointer', opacity: forecastLoading ? 0.6 : 1,
            }}>
            {forecasts ? t('schedule.regenerateForecast') : t('schedule.generateForecast')}
            {forecastLoading && ' ...'}
          </button>
        </div>
        {forecastError && (
          <div style={{ marginTop: 6, fontSize: 12, color: '#ef4444' }}>{forecastError}</div>
        )}
        {forecasts && forecasts.length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
            {forecasts.map(f => (
              <div key={f.name} style={{
                fontSize: 12, padding: '4px 8px', borderRadius: 4,
                background: 'var(--surface)', color: 'var(--text-muted)',
              }}>
                <strong style={{ color: 'var(--text)' }}>{f.name}</strong>: {f.sentence}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={handleStart}
          disabled={starting || selectedIds.size === 0}
          style={{
            padding: '10px 16px', borderRadius: 8, border: 'none',
            background: 'var(--primary)', color: '#fff', fontWeight: 600,
            cursor: starting ? 'wait' : 'pointer', opacity: starting ? 0.7 : 1,
          }}>{starting ? '...' : t('schedule.startScheduledGame')}</button>
        <button
          onClick={onClose}
          style={{
            padding: '10px 14px', borderRadius: 8,
            border: '1px solid var(--border)', background: 'transparent',
            color: 'var(--text-muted)', cursor: 'pointer',
          }}>{t('schedule.skipForecast') === t('schedule.skipForecast') ? '✕' : ''}</button>
      </div>
    </div>
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

  const addDate = () => {
    setDates(prev => [...prev, { proposedDate: '', proposedTime: defaultTime }]);
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
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input
                    type="date"
                    lang="he-IL"
                    value={d.proposedDate}
                    min={todayIso()}
                    onChange={(e) => updateDate(idx, { proposedDate: e.target.value })}
                    style={{
                      ...inputBase, flex: 1, minWidth: 0,
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
          <button onClick={addDate} style={{ ...lightGreenBtn, marginTop: 4 }}>{t('schedule.addDate')}</button>
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
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text)' }}>
            <input type="checkbox" checked={allowMaybe} onChange={(e) => setAllowMaybe(e.target.checked)} />
            {t('schedule.allowMaybe')}
          </label>
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
  const date = poll.dates.find(d => d.id === dateId);
  const [search, setSearch] = useState('');
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
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

  // Existing vote for the chosen player on this date (used to prefill + show edit/delete)
  const existingVote = useMemo(() => {
    if (!selectedPlayerId) return null;
    return poll.votes.find(v => v.dateId === dateId && v.playerId === selectedPlayerId) ?? null;
  }, [selectedPlayerId, poll.votes, dateId]);

  // When user picks a player who already has a vote, prefill the form
  useEffect(() => {
    if (existingVote) {
      setResponse(existingVote.response);
      setComment(existingVote.comment || '');
    } else {
      setResponse('yes');
      setComment('');
    }
  }, [existingVote]);

  const selectedPlayer = selectedPlayerId
    ? players.find(p => p.id === selectedPlayerId) ?? null
    : null;

  const handleSubmit = async () => {
    if (!selectedPlayerId) return;
    setSubmitting(true);
    try {
      await adminCastVote(dateId, selectedPlayerId, response, comment || undefined);
      onSuccess(existingVote ? t('schedule.proxy.savedUpdated') : t('schedule.proxy.savedAdded'));
      onClose();
    } catch (e) {
      onError(handleRpcError(e));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedPlayerId || !existingVote) return;
    if (!confirm(t('schedule.proxy.confirmDelete', { name: selectedPlayer?.name || '' }))) return;
    setSubmitting(true);
    try {
      await adminDeleteVote(dateId, selectedPlayerId);
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
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480, direction: 'rtl' }}>
        <div className="modal-header">
          <h3 className="modal-title">{t('schedule.proxy.modalTitle')}</h3>
          <button className="modal-close" onClick={onClose} aria-label={t('common.close')}>×</button>
        </div>
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
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
            {t('schedule.proxy.selectPlayer')}
          </div>
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
                  const selected = p.id === selectedPlayerId;
                  return (
                    <button
                      key={p.id}
                      onClick={() => setSelectedPlayerId(p.id)}
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        width: '100%', padding: '8px 10px',
                        border: 'none', borderBottom: '1px solid var(--border)',
                        background: selected ? 'rgba(16, 185, 129, 0.15)' : 'transparent',
                        color: selected ? '#34d399' : 'var(--text)',
                        fontSize: 13, cursor: 'pointer', textAlign: 'right',
                      }}>
                      <span>{p.name}</span>
                      {has && (
                        <span style={{ fontSize: 11, color: responseLabels[has.response].color, fontWeight: 600 }}>
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

        {/* Response picker — only when a player is selected */}
        {selectedPlayerId && (
          <>
            {existingVote && (
              <div style={{
                fontSize: 12, color: 'var(--text-muted)', marginBottom: 6,
                padding: '6px 10px', borderRadius: 6,
                background: 'rgba(234, 179, 8, 0.08)',
              }}>
                {t('schedule.proxy.currentVote', { response: responseLabels[existingVote.response].label })}
              </div>
            )}

            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
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

        <div className="actions" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>
            {t('common.cancel')}
          </button>
          {existingVote && (
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
            disabled={submitting || !selectedPlayerId}
            style={{
              ...lightGreenBtn,
              padding: '8px 16px', fontSize: 13, fontWeight: 600,
              cursor: submitting ? 'wait' : 'pointer',
              opacity: (submitting || !selectedPlayerId) ? 0.5 : 1,
            }}>
            {submitting ? '...' : (existingVote ? t('schedule.proxy.editVote') : t('schedule.proxy.add'))}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Schedule Config Panel (admin-only group settings) ───

interface ScheduleConfigPanelProps {
  onSuccess: (text: string) => void;
  onError: (text: string) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

function ScheduleConfigPanel(props: ScheduleConfigPanelProps) {
  const { onSuccess, t } = props;
  const initial = getSettings();
  const [pushEnabled, setPushEnabled] = useState<boolean>(initial.schedulePushEnabled !== false);
  const [emailsEnabled, setEmailsEnabled] = useState<boolean>(initial.scheduleEmailsEnabled === true);
  const [defaultTarget, setDefaultTarget] = useState<number>(initial.scheduleDefaultTarget ?? 8);
  const [defaultDelay, setDefaultDelay] = useState<number>(initial.scheduleDefaultDelayHours ?? 48);
  const [defaultTime, setDefaultTime] = useState<string>(initial.scheduleDefaultTime ?? '21:00');
  const [defaultAllowMaybe, setDefaultAllowMaybe] = useState<boolean>(initial.scheduleDefaultAllowMaybe !== false);

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

  // Number inputs persist on blur to avoid writing on every keystroke
  const commitDefaultTarget = () => {
    const clamped = Math.max(2, Math.min(12, defaultTarget || 8));
    if (clamped !== defaultTarget) setDefaultTarget(clamped);
    if (clamped !== (initial.scheduleDefaultTarget ?? 8)) {
      void persist({ scheduleDefaultTarget: clamped });
    }
  };

  const commitDefaultDelay = () => {
    const clamped = Math.max(0, Math.min(240, defaultDelay || 0));
    if (clamped !== defaultDelay) setDefaultDelay(clamped);
    if (clamped !== (initial.scheduleDefaultDelayHours ?? 48)) {
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

  const rowStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer',
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

      <label style={rowStyle}>
        <input
          type="checkbox"
          checked={pushEnabled}
          onChange={(e) => handlePushToggle(e.target.checked)}
          style={{ marginTop: 3 }}
        />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
            🔔 {t('schedule.config.pushEnabled')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
            {t('schedule.config.pushHelper')}
          </div>
        </div>
      </label>

      <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />

      <label style={rowStyle}>
        <input
          type="checkbox"
          checked={emailsEnabled}
          onChange={(e) => handleEmailsToggle(e.target.checked)}
          style={{ marginTop: 3 }}
        />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
            ✉️ {t('schedule.config.emailsEnabled')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
            {t('schedule.config.emailsHelper')}
          </div>
        </div>
      </label>

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
        <div style={{ flex: 1, minWidth: 130 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
            {t('schedule.config.defaultTime')}
          </div>
          <Time24Picker value={defaultTime} onChange={handleDefaultTime} />
        </div>
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text)', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={defaultAllowMaybe}
          onChange={(e) => handleDefaultAllowMaybe(e.target.checked)}
        />
        {t('schedule.config.defaultAllowMaybe')}
      </label>
    </div>
  );
}

// ─── 24-hour Time Picker ───
// Native <input type="time"> falls back to OS locale on Chromium/Edge and
// happily renders 12-hour AM/PM regardless of the `lang` attribute. This
// component forces a guaranteed 24-hour HH:MM picker via two <select>s.

interface Time24PickerProps {
  value: string; // "HH:MM" 24h
  onChange: (next: string) => void;
}

function Time24Picker({ value, onChange }: Time24PickerProps) {
  const [hStr = '21', mStr = '00'] = (value || '21:00').split(':');
  const hour = Math.max(0, Math.min(23, parseInt(hStr, 10) || 0));
  const minute = Math.max(0, Math.min(59, parseInt(mStr, 10) || 0));

  const pad = (n: number) => n.toString().padStart(2, '0');
  const emit = (h: number, m: number) => onChange(`${pad(h)}:${pad(m)}`);

  const selectStyle: React.CSSProperties = {
    ...inputBase, width: 'auto', padding: '8px 6px', textAlign: 'center',
    appearance: 'none', cursor: 'pointer',
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 4, flex: 'none',
      direction: 'ltr', // time renders as HH:MM regardless of parent direction
    }}>
      <select
        value={pad(hour)}
        onChange={(e) => emit(parseInt(e.target.value, 10), minute)}
        style={selectStyle}
        aria-label="hour"
      >
        {Array.from({ length: 24 }, (_, i) => (
          <option key={i} value={pad(i)}>{pad(i)}</option>
        ))}
      </select>
      <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>:</span>
      <select
        value={pad(minute - (minute % 5))}
        onChange={(e) => emit(hour, parseInt(e.target.value, 10))}
        style={selectStyle}
        aria-label="minute"
      >
        {Array.from({ length: 12 }, (_, i) => i * 5).map(m => (
          <option key={m} value={pad(m)}>{pad(m)}</option>
        ))}
      </select>
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
