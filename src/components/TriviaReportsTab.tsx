// Super-admin inbox for trivia question reports.
//
// Mirrors the spirit of TrainingAdminTab but is intentionally much
// smaller — trivia questions are dynamic (built each session from
// live data) so there is no "scenario" to fix in the DB. Resolution
// here is a triage decision: the super-admin reviews the captured
// question + correct/chosen answer + reporter comment, and either
// dismisses (the original answer was correct) or marks resolved
// (a fix was made — typically by editing src/utils/triviaGenerator.ts
// and shipping the next deploy). The note field stores any free-text
// context the super-admin wants to leave for themselves.
//
// Data flow:
//   - Reads `trivia_reports` directly via supabase-js. RLS gives
//     super-admins access to every row across every group.
//   - Writes go through the `resolve_trivia_report` RPC (which
//     enforces the super-admin check itself) and a direct DELETE
//     for cleanup (allowed by RLS for super-admins).
//
// Companion features (added to mirror TrainingAdminTab affordances):
//   - Mode filter chips so a super-admin can narrow to group-mode
//     vs players-mode reports without scanning N cards.
//   - Bulk actions ("dismiss all in filter", "delete all in
//     filter") that respect the active status + mode filters.
//   - Per-report "verify in app" deep link that picks the most
//     relevant in-app screen (statistics vs history) based on a
//     template_id heuristic — so the super-admin can manually
//     check the answer without writing SQL.
//   - Players sub-view also exposes a per-player "clear history"
//     button (and a global "clear all"), since trivia_sessions has
//     no other cleanup UX. Super-admin only via RLS.
//   - On resolve / dismiss we ping the original reporter via push
//     so they know their flag was triaged (mirrors training).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../database/supabaseClient';
import { useTranslation } from '../i18n';
import { usePermissions } from '../App';
import { getGroupId } from '../database/supabaseCache';
import { getAllPlayers } from '../database/storage';
import type { Player } from '../types';
import { notifyReporterOfTriviaResolution } from '../utils/triviaReportNotifications';
import {
  fetchAllDeletedTriviaTemplates,
  deleteTriviaTemplate,
  restoreTriviaTemplate,
  loadDeletedTriviaTemplates,
  subscribeRealtimeDeletedTemplates,
  type DeletedTriviaTemplateRow,
} from '../utils/triviaDeletedTemplates';

type ReportStatus = 'pending' | 'resolved' | 'dismissed';
type ReportReason = 'wrong_answer' | 'unclear_question' | 'other';
type ReportMode = 'group' | 'players';
type ModeFilter = 'all' | ReportMode;

interface TriviaReportRow {
  id: string;
  group_id: string;
  user_id: string;
  player_name: string;
  template_id: string;
  mode: ReportMode;
  question_text: string;
  correct_answer: string;
  chosen_answer: string | null;
  reason: ReportReason;
  comment: string | null;
  status: ReportStatus;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
}

type FilterTab = ReportStatus | 'all';
type ViewTab = 'reports' | 'players';

// Per-player adoption + accuracy stats for the super-admin monitoring
// view. Pulled from `fetch_trivia_leaderboard` (same RPC the landing
// screen leaderboard uses) so the numbers always agree with what
// players see. We include accuracy + last-played to surface dormant
// players and outliers without needing a second round trip.
interface PlayerStatsRow {
  player_name: string;
  games: number;
  total_questions: number;
  total_correct: number;
  accuracy: number | null;
  best_score: number;
  last_played: string;
}

// ── Verify deep link heuristic ──────────────────────────────────
// Map a template id to the most useful in-app screen for the
// super-admin to manually verify the captured answer, AND when the
// template carries a time-window suffix (`_thisYear`, `_lastYear`,
// `_last30Days`, etc.) pre-load the matching period filter on the
// destination screen so the admin doesn't have to fiddle with
// pickers. The trivia generator names templates with descriptive
// prefixes — we lean on that instead of maintaining a hand-curated
// table per template (which would silently rot every time we add
// a factory).
//
// Returned shape mirrors what react-router's navigate() takes:
//   { to: '/statistics', state: { timePeriod: 'year', selectedYear: 2025 } }
// State is consumed by StatisticsScreen's locationState reader
// (existing code path used by record drill-downs).
//
// Window keys we recognize on the template id (suffix-style):
//   _thisYear     → year filter on current calendar year
//   _lastYear     → year filter on previous calendar year
//   _last30Days   → recent activity, no period preset (admin can
//                   scan recent games on /history)
//   _last90Days   → same as 30d
//   _last10Games  → most-recent games, route to /history
// Without any window suffix, we fall back to all-time stats.
//
// Routing buckets:
//   - History-heavy templates (game counts, single-game records,
//     popular-day, tightest game, chips moved, avg players, large
//     game by date, recent N games) → /history.
//   - Everything else (player profit/games/podium/best-night/avg/
//     win-rate, group leaderboards, rebuy king, etc.) → /statistics.
//   - Fallback: /statistics.
type TimePeriod = 'all' | 'year' | 'h1' | 'h2' | 'month' | 'custom';
interface VerifyTarget {
  to: string;
  state?: {
    timePeriod?: TimePeriod;
    selectedYear?: number;
    selectedMonth?: number;
    // viewMode + playerInfo together drive StatisticsScreen's
    // scroll-to-and-highlight effect (existing code path used by
    // record drill-downs). When present we land directly on the
    // player's card instead of forcing the admin to scroll.
    viewMode?: 'table' | 'players' | 'records';
    playerInfo?: { playerId: string; playerName: string };
  };
}

// Find the player a question is about by scanning the question
// text for any group-roster name. We deliberately avoid storing a
// `subject_player_id` column on `trivia_reports` (would require a
// migration AND every template author to remember to set it) — the
// question text always names the subject explicitly, so a roster
// scan is enough for ~all real cases. Returns null when:
//   - 0 names match (group-mode questions like "מי שיחק...")
//   - 2+ names match (multi-subject questions like "X vs Y") —
//     ambiguous, skip the highlight rather than guess wrong
// We also prefer the LONGEST matching name when one is a prefix
// of another (e.g. "ליאור" vs "ליאור מ.") so we don't shorten the
// match accidentally.
function findSubjectPlayer(
  questionText: string,
  players: Player[],
): Player | null {
  const matches = players
    .filter(p => p.name && questionText.includes(p.name))
    // Sort longest-first so a name that's a prefix of another
    // doesn't win when both technically match.
    .sort((a, z) => z.name.length - a.name.length);
  if (matches.length === 0) return null;
  // If multiple distinct names match (not just prefix overlap), skip.
  // We treat overlapping prefixes as the same logical subject.
  const distinct = matches.filter(m =>
    !matches.some(other => other !== m && other.name.includes(m.name)),
  );
  if (distinct.length !== 1) return null;
  return distinct[0];
}

function verifyTargetFor(
  templateId: string,
  questionText: string,
  mode: ReportMode,
  players: Player[],
): VerifyTarget {
  const id = templateId.toLowerCase();
  const historyKeywords = [
    'gamescount', 'largestgame', 'chipsmoved', 'avgplayers',
    'tightestgame', 'mostpopularday', 'longestgap', 'biggestsinglewin',
    'biggestsingleloss', 'last10games',
  ];
  const isHistoryHeavy = historyKeywords.some(k => id.includes(k));

  // Time-window suffix detection. Templates from factories.ts use
  // an underscored window key after the stat name; older hand-coded
  // templates have no suffix at all (treated as all-time).
  const currentYear = new Date().getFullYear();
  const state: NonNullable<VerifyTarget['state']> = {};

  if (id.includes('thisyear')) {
    state.timePeriod = 'year';
    state.selectedYear = currentYear;
  } else if (id.includes('lastyear')) {
    state.timePeriod = 'year';
    state.selectedYear = currentYear - 1;
  } else if (id.includes('last30days') || id.includes('last90days')) {
    // Recent-window questions are best verified on /history
    // (scan most-recent games visually). Statistics doesn't have
    // a "last N days" preset, so we don't try to pre-load one.
    return { to: '/history' };
  }

  if (isHistoryHeavy) {
    // History-heavy templates with a year window can still benefit
    // from /history — but stats-with-year is usually more useful
    // for the super-admin (per-player aggregate is what the
    // generator actually computed). Send to /history without
    // state, no year filter exists there.
    return { to: '/history' };
  }

  // Player-subject deep link: when the question is about a single
  // identifiable player from the roster, drop the admin straight
  // onto that player's card on the statistics screen. We only do
  // this for player-mode reports — group-mode questions ("מי שיחק
  // הכי הרבה...") name a player as the answer, not the subject,
  // so highlighting a roster name from the question text would be
  // wrong.
  if (mode === 'players') {
    const subject = findSubjectPlayer(questionText, players);
    if (subject) {
      state.viewMode = 'players';
      state.playerInfo = { playerId: subject.id, playerName: subject.name };
    }
  }

  const hasState = Object.keys(state).length > 0;
  return { to: '/statistics', state: hasState ? state : undefined };
}

const TriviaReportsTab: React.FC = () => {
  const { t, language } = useTranslation();
  const { isSuperAdmin } = usePermissions();
  const navigate = useNavigate();
  const isRtl = language === 'he';

  const [reports, setReports] = useState<TriviaReportRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterTab>('pending');
  const [modeFilter, setModeFilter] = useState<ModeFilter>('all');
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);
  // Per-row note input (free-text context the super-admin can save
  // alongside a resolve/dismiss action).
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  // Top-level view switcher: report inbox vs per-player monitoring.
  const [view, setView] = useState<ViewTab>('reports');
  const [playerStats, setPlayerStats] = useState<PlayerStatsRow[] | null>(null);
  const [playerStatsLoading, setPlayerStatsLoading] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState<string | null>(null);
  const [cleanupMsg, setCleanupMsg] = useState<string | null>(null);
  // Roster used by the per-report "verify" deep link to find which
  // player a player-mode question is about (by scanning the question
  // text). Loaded once on mount from the in-memory cache; we don't
  // need realtime sync because the admin re-opens the tab if a new
  // player joins.
  const groupPlayers = useMemo<Player[]>(() => getAllPlayers(), []);

  // Deleted-templates state — the kill-switch list. Loaded on mount,
  // refreshed on realtime, mutated optimistically by deleteFromPool /
  // restoreFromPool.
  const [deletedTemplates, setDeletedTemplates] = useState<DeletedTriviaTemplateRow[]>([]);
  const [poolBusyId, setPoolBusyId] = useState<string | null>(null);

  const fetchReports = useCallback(async () => {
    if (!isSuperAdmin) return;
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase
      .from('trivia_reports')
      .select('*')
      .order('created_at', { ascending: false });
    setLoading(false);
    if (err) {
      setError(err.message);
      return;
    }
    setReports((data as TriviaReportRow[]) ?? []);
  }, [isSuperAdmin]);

  useEffect(() => {
    void fetchReports();
  }, [fetchReports]);

  // Per-player monitoring data is fetched lazily when the super-admin
  // opens the Players sub-view, then kept in state until they refresh
  // or leave the tab. Re-uses fetch_trivia_leaderboard so what the
  // super-admin sees here is exactly what players see on the landing
  // screen — single source of truth.
  const fetchPlayerStats = useCallback(async () => {
    if (!isSuperAdmin) return;
    setPlayerStatsLoading(true);
    setError(null);
    const gid = getGroupId();
    if (!gid) {
      setPlayerStats([]);
      setPlayerStatsLoading(false);
      return;
    }
    const { data, error: err } = await supabase.rpc('fetch_trivia_leaderboard', { p_group_id: gid });
    setPlayerStatsLoading(false);
    if (err) {
      setError(err.message);
      setPlayerStats([]);
      return;
    }
    setPlayerStats((data as PlayerStatsRow[]) ?? []);
  }, [isSuperAdmin]);

  useEffect(() => {
    if (view === 'players' && playerStats === null && !playerStatsLoading) {
      void fetchPlayerStats();
    }
  }, [view, playerStats, playerStatsLoading, fetchPlayerStats]);

  // Load + subscribe to the per-group "deleted templates" list. Mounted
  // once when the super-admin opens the tab; the realtime subscription
  // refreshes the list (and the in-memory exclusion set used by the
  // trivia generator on every device) whenever a delete or restore
  // happens — including from another super-admin on another device.
  const refreshDeletedTemplates = useCallback(async () => {
    const gid = getGroupId();
    if (!gid) return;
    const rows = await fetchAllDeletedTriviaTemplates(gid);
    setDeletedTemplates(rows);
  }, []);

  useEffect(() => {
    if (!isSuperAdmin) return;
    const gid = getGroupId();
    if (!gid) return;
    void loadDeletedTriviaTemplates(gid).then(() => refreshDeletedTemplates());
    const unsubscribe = subscribeRealtimeDeletedTemplates(gid);
    const onCacheUpdate = () => { void refreshDeletedTemplates(); };
    window.addEventListener('supabase-cache-updated', onCacheUpdate);
    return () => {
      unsubscribe();
      window.removeEventListener('supabase-cache-updated', onCacheUpdate);
    };
  }, [isSuperAdmin, refreshDeletedTemplates]);

  // Aggregate header for the Players sub-view: total quizzes, total
  // questions answered, group-wide accuracy. Computed from the same
  // rows so totals always match the table below them.
  const playerAggregates = useMemo(() => {
    if (!playerStats || playerStats.length === 0) {
      return { players: 0, quizzes: 0, questions: 0, correct: 0, accuracy: null as number | null };
    }
    let quizzes = 0, questions = 0, correct = 0;
    for (const r of playerStats) {
      quizzes += r.games;
      questions += r.total_questions;
      correct += r.total_correct;
    }
    return {
      players: playerStats.length,
      quizzes,
      questions,
      correct,
      accuracy: questions > 0 ? Math.round((correct / questions) * 100) : null,
    };
  }, [playerStats]);

  const setBusy = (id: string, busy: boolean) => {
    setBusyIds(prev => {
      const next = new Set(prev);
      if (busy) next.add(id); else next.delete(id);
      return next;
    });
  };

  // Wraps the actual RPC call. We pass the report row in so we can
  // (a) skip the round-trip to re-fetch it for the reporter notify,
  // and (b) only fire the notification when the status actually
  // transitions to a triaged state (resolved/dismissed) — re-opens
  // shouldn't ping the reporter.
  const callResolve = async (
    row: TriviaReportRow,
    status: ReportStatus,
    note: string | null,
  ) => {
    setBusy(row.id, true);
    setError(null);
    const { error: err } = await supabase.rpc('resolve_trivia_report', {
      p_report_id: row.id,
      p_status: status,
      p_note: note,
    });
    setBusy(row.id, false);
    if (err) {
      setError(err.message || t('triviaReports.error'));
      return;
    }
    // Best-effort reporter notification. Mirror training: only fire
    // on accept (resolved) or reject (dismissed); a re-open is a
    // workflow-internal action the reporter shouldn't be paged for.
    if (status === 'resolved' || status === 'dismissed') {
      void notifyReporterOfTriviaResolution({
        reporterName: row.player_name,
        outcome: status === 'resolved' ? 'accept' : 'reject',
        questionText: row.question_text,
      });
    }
    await fetchReports();
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm(t('triviaReports.confirmDelete'))) return;
    setBusy(id, true);
    setError(null);
    const { error: err } = await supabase
      .from('trivia_reports')
      .delete()
      .eq('id', id);
    setBusy(id, false);
    if (err) {
      setError(err.message || t('triviaReports.error'));
      return;
    }
    await fetchReports();
  };

  // ── Pool kill-switch ─────────────────────────────────────────
  // "Delete this question from the pool" — adds the report's
  // template_id to `trivia_deleted_templates` so it never generates
  // again for this group. ALSO resolves the report (since we acted
  // on it) with a note explaining the question was removed, so the
  // reporter gets the "your report was accepted" push.
  const handleDeleteFromPool = async (row: TriviaReportRow) => {
    const confirm = window.confirm(
      t('triviaReports.confirmDeleteFromPool').replace('{template}', row.template_id),
    );
    if (!confirm) return;
    const gid = getGroupId();
    if (!gid) return;
    setBusy(row.id, true);
    setError(null);
    const reasonText = noteDrafts[row.id]?.trim() || row.comment?.trim() || null;
    const result = await deleteTriviaTemplate(gid, row.template_id, reasonText);
    if (!result.ok) {
      setBusy(row.id, false);
      setError(result.error || t('triviaReports.error'));
      return;
    }
    // Best-effort resolve so the report inbox reflects "we acted on
    // this". The report status flip is non-fatal — if it fails the
    // template is already removed from the pool, which was the
    // primary user intent.
    if (row.status === 'pending') {
      const noteForReport = t('triviaReports.poolDeletedNote');
      await supabase.rpc('resolve_trivia_report', {
        p_report_id: row.id,
        p_status: 'resolved',
        p_note: noteForReport,
      });
      void notifyReporterOfTriviaResolution({
        reporterName: row.player_name,
        outcome: 'accept',
        questionText: row.question_text,
      });
    }
    setBusy(row.id, false);
    await fetchReports();
    await refreshDeletedTemplates();
  };

  const handleRestoreFromPool = async (templateId: string) => {
    if (!window.confirm(t('triviaReports.confirmRestore').replace('{template}', templateId))) return;
    const gid = getGroupId();
    if (!gid) return;
    setPoolBusyId(templateId);
    setError(null);
    const result = await restoreTriviaTemplate(gid, templateId);
    setPoolBusyId(null);
    if (!result.ok) {
      setError(result.error || t('triviaReports.error'));
      return;
    }
    await refreshDeletedTemplates();
  };

  // ── Bulk actions ─────────────────────────────────────────────
  // Operate on whatever the active filter currently shows. We fan
  // out individual RPC/DELETE calls instead of one big SQL — keeps
  // the RLS audit trail per-row and lets us notify each reporter
  // (which a single bulk update couldn't do).
  const filtered = useMemo(() => {
    let rows = filter === 'all' ? reports : reports.filter(r => r.status === filter);
    if (modeFilter !== 'all') rows = rows.filter(r => r.mode === modeFilter);
    return rows;
  }, [reports, filter, modeFilter]);

  const handleBulkDismiss = async () => {
    if (filtered.length === 0) return;
    const pending = filtered.filter(r => r.status === 'pending');
    if (pending.length === 0) return;
    if (!window.confirm(t('triviaReports.bulk.confirmDismiss').replace('{n}', String(pending.length)))) return;
    setBulkBusy(true);
    setBulkMsg(null);
    setError(null);
    let done = 0;
    for (const row of pending) {
      const { error: err } = await supabase.rpc('resolve_trivia_report', {
        p_report_id: row.id,
        p_status: 'dismissed',
        p_note: null,
      });
      if (!err) {
        done++;
        // Notify each reporter that their flag was dismissed.
        void notifyReporterOfTriviaResolution({
          reporterName: row.player_name,
          outcome: 'reject',
          questionText: row.question_text,
        });
      }
    }
    setBulkBusy(false);
    setBulkMsg(t('triviaReports.bulk.done').replace('{n}', String(done)));
    await fetchReports();
  };

  const handleBulkDelete = async () => {
    if (filtered.length === 0) return;
    if (!window.confirm(t('triviaReports.bulk.confirmDelete').replace('{n}', String(filtered.length)))) return;
    setBulkBusy(true);
    setBulkMsg(null);
    setError(null);
    const ids = filtered.map(r => r.id);
    const { error: err } = await supabase
      .from('trivia_reports')
      .delete()
      .in('id', ids);
    setBulkBusy(false);
    if (err) {
      setError(err.message || t('triviaReports.error'));
      return;
    }
    setBulkMsg(t('triviaReports.bulk.done').replace('{n}', String(ids.length)));
    await fetchReports();
  };

  // ── Sessions cleanup ────────────────────────────────────────
  // Wipes trivia_sessions rows in the current group, optionally
  // scoped to a single player. RLS allows super-admins (and group
  // admins) to DELETE — see migration 063.
  const handleClearPlayerHistory = async (playerName: string) => {
    if (!window.confirm(t('triviaReports.players.confirmCleanup').replace('{name}', playerName))) return;
    const gid = getGroupId();
    if (!gid) return;
    setCleanupBusy(playerName);
    setCleanupMsg(null);
    setError(null);
    const { error: err, count } = await supabase
      .from('trivia_sessions')
      .delete({ count: 'exact' })
      .eq('group_id', gid)
      .eq('player_name', playerName);
    setCleanupBusy(null);
    if (err) {
      setError(err.message || t('triviaReports.error'));
      return;
    }
    setCleanupMsg(t('triviaReports.players.cleanupDone').replace('{n}', String(count ?? 0)));
    setPlayerStats(null);
    await fetchPlayerStats();
  };

  const handleClearAllHistory = async () => {
    if (!window.confirm(t('triviaReports.players.confirmCleanupAll'))) return;
    const gid = getGroupId();
    if (!gid) return;
    setCleanupBusy('__all__');
    setCleanupMsg(null);
    setError(null);
    const { error: err, count } = await supabase
      .from('trivia_sessions')
      .delete({ count: 'exact' })
      .eq('group_id', gid);
    setCleanupBusy(null);
    if (err) {
      setError(err.message || t('triviaReports.error'));
      return;
    }
    setCleanupMsg(t('triviaReports.players.cleanupDone').replace('{n}', String(count ?? 0)));
    setPlayerStats(null);
    await fetchPlayerStats();
  };

  // ── Permission gate ───────────────────────────────────────────
  if (!isSuperAdmin) {
    return (
      <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-muted)' }}>
        {t('triviaReports.notSuperAdmin')}
      </div>
    );
  }

  const reasonLabel = (r: ReportReason) => {
    switch (r) {
      case 'wrong_answer': return t('triviaReports.reason.wrongAnswer');
      case 'unclear_question': return t('triviaReports.reason.unclear');
      case 'other': return t('triviaReports.reason.other');
    }
  };

  const statusBadgeColor = (s: ReportStatus) => {
    switch (s) {
      case 'pending': return { bg: 'rgba(245, 158, 11, 0.15)', fg: '#f59e0b' };
      case 'resolved': return { bg: 'rgba(34, 197, 94, 0.15)', fg: '#22c55e' };
      case 'dismissed': return { bg: 'rgba(148, 163, 184, 0.15)', fg: '#94a3b8' };
    }
  };

  const statusLabel = (s: ReportStatus) => {
    switch (s) {
      case 'pending': return t('triviaReports.status.pending');
      case 'resolved': return t('triviaReports.status.resolved');
      case 'dismissed': return t('triviaReports.status.dismissed');
    }
  };

  const formatDate = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleString(language === 'he' ? 'he-IL' : 'en-US', {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  const filterCount = (status: FilterTab) =>
    status === 'all' ? reports.length : reports.filter(r => r.status === status).length;

  return (
    <div style={{ direction: isRtl ? 'rtl' : 'ltr' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem' }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>{t('triviaReports.title')}</div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{t('triviaReports.subtitle')}</div>
        </div>
        <button
          onClick={view === 'reports' ? fetchReports : fetchPlayerStats}
          disabled={view === 'reports' ? loading : playerStatsLoading}
          style={{
            background: 'var(--surface)', border: '1px solid var(--border)',
            color: 'var(--text)', padding: '0.35rem 0.75rem', borderRadius: 8,
            cursor: 'pointer', fontSize: '0.72rem', fontWeight: 600,
          }}
        >
          🔄 {t('triviaReports.refresh')}
        </button>
      </div>

      {/* View switcher: report inbox vs per-player monitoring */}
      <div style={{
        display: 'flex', gap: '0.4rem', marginBottom: '0.7rem',
        borderBottom: '1px solid var(--border)', paddingBottom: '0.4rem',
      }}>
        {(['reports', 'players'] as ViewTab[]).map(v => {
          const active = view === v;
          return (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                padding: '0.4rem 0.85rem', borderRadius: 8, fontSize: '0.78rem',
                border: 'none', background: 'transparent',
                color: active ? 'var(--primary)' : 'var(--text-muted)',
                fontWeight: active ? 700 : 500, cursor: 'pointer',
                borderBottom: active ? '2px solid var(--primary)' : '2px solid transparent',
                marginBottom: -5,
              }}
            >
              {t(`triviaReports.view.${v}` as `triviaReports.view.${typeof v}`)}
            </button>
          );
        })}
      </div>

      {/* Filter tabs (only on Reports view) */}
      {view === 'reports' && (
      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginBottom: '0.45rem' }}>
        {(['pending', 'resolved', 'dismissed', 'all'] as FilterTab[]).map(f => {
          const active = filter === f;
          const count = filterCount(f);
          return (
            <button
              key={f}
              onClick={() => setFilter(f)}
              style={{
                padding: '0.3rem 0.65rem', borderRadius: 999, fontSize: '0.7rem',
                border: active ? '1px solid var(--primary)' : '1px solid var(--border)',
                background: active ? 'rgba(59, 130, 246, 0.12)' : 'var(--surface)',
                color: active ? 'var(--primary)' : 'var(--text)',
                cursor: 'pointer', fontWeight: active ? 700 : 500,
                display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
              }}
            >
              <span>{t(`triviaReports.filter.${f}` as `triviaReports.filter.${typeof f}`)}</span>
              {count > 0 && (
                <span style={{
                  fontSize: '0.6rem', padding: '0 5px', borderRadius: 8,
                  background: active ? 'var(--primary)' : 'var(--border)',
                  color: active ? '#fff' : 'var(--text-muted)', fontWeight: 700,
                }}>{count}</span>
              )}
            </button>
          );
        })}
      </div>
      )}

      {/* Mode filter chips — narrow status filter to a specific
          mode (group / players). Independent of the status filter
          above; both compose. */}
      {view === 'reports' && (
      <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginBottom: '0.7rem' }}>
        {(['all', 'group', 'players'] as ModeFilter[]).map(mf => {
          const active = modeFilter === mf;
          return (
            <button
              key={mf}
              onClick={() => setModeFilter(mf)}
              style={{
                padding: '0.25rem 0.55rem', borderRadius: 6, fontSize: '0.65rem',
                border: active ? '1px solid var(--primary)' : '1px solid var(--border)',
                background: active ? 'rgba(59, 130, 246, 0.08)' : 'transparent',
                color: active ? 'var(--primary)' : 'var(--text-muted)',
                cursor: 'pointer', fontWeight: active ? 700 : 500,
              }}
            >
              {t(`triviaReports.modeFilter.${mf}` as `triviaReports.modeFilter.${typeof mf}`)}
            </button>
          );
        })}
      </div>
      )}

      {/* Bulk action bar — only meaningful with at least one row */}
      {view === 'reports' && filtered.length > 0 && (
        <div style={{
          display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.6rem',
          alignItems: 'center',
        }}>
          {filter === 'pending' && (
            <button
              onClick={handleBulkDismiss}
              disabled={bulkBusy}
              style={{
                padding: '0.3rem 0.6rem', borderRadius: 6, fontSize: '0.65rem',
                background: 'rgba(148,163,184,0.15)', border: '1px solid var(--border)',
                color: 'var(--text)', cursor: bulkBusy ? 'wait' : 'pointer',
                fontWeight: 600, opacity: bulkBusy ? 0.5 : 1,
              }}
            >
              ✕ {t('triviaReports.bulk.dismissAll')} ({filtered.filter(r => r.status === 'pending').length})
            </button>
          )}
          <button
            onClick={handleBulkDelete}
            disabled={bulkBusy}
            style={{
              padding: '0.3rem 0.6rem', borderRadius: 6, fontSize: '0.65rem',
              background: 'transparent', border: '1px solid rgba(239,68,68,0.3)',
              color: '#ef4444', cursor: bulkBusy ? 'wait' : 'pointer',
              fontWeight: 600, opacity: bulkBusy ? 0.5 : 1,
            }}
          >
            🗑 {t('triviaReports.bulk.deleteAll')} ({filtered.length})
          </button>
          {bulkMsg && (
            <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
              {bulkMsg}
            </span>
          )}
        </div>
      )}

      {error && (
        <div style={{
          padding: '0.5rem 0.7rem', marginBottom: '0.6rem',
          background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.25)',
          borderRadius: 8, color: '#ef4444', fontSize: '0.78rem',
        }}>
          {error}
        </div>
      )}

      {view === 'reports' && loading && reports.length === 0 && (
        <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
          {t('triviaReports.loading')}
        </div>
      )}

      {view === 'reports' && !loading && filtered.length === 0 && (
        <div style={{ padding: '1.25rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
          {t('triviaReports.empty')}
        </div>
      )}

      {/* Report cards */}
      {view === 'reports' && (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
        {filtered.map(r => {
          const sb = statusBadgeColor(r.status);
          const busy = busyIds.has(r.id);
          const noteValue = noteDrafts[r.id] ?? '';
          return (
            <div key={r.id} className="card" style={{ padding: '0.85rem 1rem' }}>
              {/* Header row: status + mode + reporter + date */}
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                gap: '0.5rem', marginBottom: '0.45rem', flexWrap: 'wrap',
              }}>
                <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{
                    fontSize: '0.65rem', padding: '0.18rem 0.55rem', borderRadius: 999,
                    background: sb.bg, color: sb.fg, fontWeight: 700,
                  }}>{statusLabel(r.status)}</span>
                  <span style={{
                    fontSize: '0.65rem', padding: '0.18rem 0.5rem', borderRadius: 999,
                    background: 'var(--surface)', border: '1px solid var(--border)',
                    color: 'var(--text-muted)', fontWeight: 600,
                  }}>
                    {r.mode === 'group' ? t('triviaReports.mode.group') : t('triviaReports.mode.players')}
                  </span>
                  <span style={{
                    fontSize: '0.65rem', padding: '0.18rem 0.5rem', borderRadius: 999,
                    background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', fontWeight: 700,
                  }}>{reasonLabel(r.reason)}</span>
                </div>
                <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
                  {r.player_name} · {formatDate(r.created_at)}
                </div>
              </div>

              {/* Question + answers */}
              <div style={{
                fontSize: '0.92rem', fontWeight: 600, color: 'var(--text)',
                marginBottom: '0.45rem', lineHeight: 1.35,
              }}>
                {r.question_text}
              </div>

              <div style={{
                display: 'grid', gridTemplateColumns: '1fr', gap: '0.25rem',
                fontSize: '0.78rem', marginBottom: r.comment ? '0.45rem' : '0.6rem',
              }}>
                <div>
                  <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>
                    {t('triviaReports.col.correct')}:
                  </span>
                  {' '}
                  <span style={{ color: '#22c55e', fontWeight: 700 }}>{r.correct_answer}</span>
                </div>
                <div>
                  <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>
                    {t('triviaReports.col.chosen')}:
                  </span>
                  {' '}
                  <span style={{ color: r.chosen_answer ? '#ef4444' : 'var(--text-muted)', fontWeight: 600 }}>
                    {r.chosen_answer ?? t('triviaReports.noChosen')}
                  </span>
                </div>
              </div>

              {r.comment && (
                <div style={{
                  fontSize: '0.78rem', padding: '0.5rem 0.65rem',
                  background: 'rgba(99, 102, 241, 0.08)',
                  border: '1px solid rgba(99, 102, 241, 0.2)',
                  borderRadius: 8, marginBottom: '0.5rem',
                  color: 'var(--text)', lineHeight: 1.4,
                }}>
                  💬 {r.comment}
                </div>
              )}

              {r.resolution_note && (
                <div style={{
                  fontSize: '0.72rem', padding: '0.4rem 0.6rem',
                  background: 'rgba(148, 163, 184, 0.08)',
                  border: '1px solid rgba(148, 163, 184, 0.2)',
                  borderRadius: 8, marginBottom: '0.5rem',
                  color: 'var(--text-muted)', fontStyle: 'italic',
                }}>
                  📝 {r.resolution_note}
                </div>
              )}

              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.5rem',
              }}>
                <div style={{
                  fontSize: '0.62rem', color: 'var(--text-muted)',
                  fontFamily: 'monospace',
                }}>
                  {t('triviaReports.col.template')}: {r.template_id}
                </div>
                {/* Verify deep link — opens the most relevant
                    in-app screen so the super-admin can manually
                    cross-check the captured answer. When the
                    template carries a time-window suffix
                    (`_thisYear`, `_lastYear`, …) we also pre-load
                    the matching period filter so the admin doesn't
                    have to reach for the year picker. */}
                <button
                  type="button"
                  onClick={() => {
                    const target = verifyTargetFor(r.template_id, r.question_text, r.mode, groupPlayers);
                    navigate(target.to, target.state ? { state: target.state } : undefined);
                  }}
                  title={t('triviaReports.verify.title')}
                  style={{
                    padding: '0.25rem 0.55rem', borderRadius: 6,
                    fontSize: '0.65rem', fontWeight: 600,
                    background: 'rgba(99,102,241,0.1)',
                    color: '#a5b4fc',
                    border: '1px solid rgba(99,102,241,0.2)',
                    cursor: 'pointer',
                  }}
                >
                  {t('triviaReports.verify.label')}
                </button>
              </div>

              {/* Action row: textarea + buttons */}
              {r.status === 'pending' ? (
                <>
                  <textarea
                    value={noteValue}
                    onChange={e => setNoteDrafts(prev => ({ ...prev, [r.id]: e.target.value }))}
                    placeholder={t('triviaReports.note.placeholder')}
                    rows={2}
                    style={{
                      width: '100%', padding: '0.45rem 0.55rem', borderRadius: 8,
                      fontSize: '0.75rem', background: 'var(--surface)', color: 'var(--text)',
                      border: '1px solid var(--border)', resize: 'vertical',
                      direction: isRtl ? 'rtl' : 'ltr', fontFamily: 'inherit',
                      boxSizing: 'border-box', marginBottom: '0.5rem',
                    }}
                  />
                  <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                    <button
                      onClick={() => callResolve(r, 'resolved', noteValue.trim() || null)}
                      disabled={busy}
                      style={{
                        background: '#22c55e', color: '#0f172a', border: 'none',
                        padding: '0.4rem 0.85rem', borderRadius: 8,
                        cursor: busy ? 'default' : 'pointer',
                        fontSize: '0.72rem', fontWeight: 700, opacity: busy ? 0.5 : 1,
                      }}
                    >
                      ✓ {t('triviaReports.action.resolve')}
                    </button>
                    <button
                      onClick={() => callResolve(r, 'dismissed', noteValue.trim() || null)}
                      disabled={busy}
                      style={{
                        background: 'rgba(148, 163, 184, 0.2)', color: 'var(--text)',
                        border: '1px solid var(--border)',
                        padding: '0.4rem 0.85rem', borderRadius: 8,
                        cursor: busy ? 'default' : 'pointer',
                        fontSize: '0.72rem', fontWeight: 600, opacity: busy ? 0.5 : 1,
                      }}
                    >
                      ✕ {t('triviaReports.action.dismiss')}
                    </button>
                    {/* Pool kill-switch — the question type is removed
                        from future trivia rounds for this group. The
                        report itself is auto-resolved + the reporter
                        is pinged. Distinct from "Delete report" below
                        (which only deletes the paperwork). */}
                    <button
                      onClick={() => handleDeleteFromPool(r)}
                      disabled={busy}
                      title={t('triviaReports.action.deleteQuestionTitle')}
                      style={{
                        background: 'rgba(239, 68, 68, 0.12)', color: '#ef4444',
                        border: '1px solid rgba(239, 68, 68, 0.4)',
                        padding: '0.4rem 0.85rem', borderRadius: 8,
                        cursor: busy ? 'default' : 'pointer',
                        fontSize: '0.72rem', fontWeight: 700, opacity: busy ? 0.5 : 1,
                      }}
                    >
                      🗑 {t('triviaReports.action.deleteQuestion')}
                    </button>
                    <button
                      onClick={() => handleDelete(r.id)}
                      disabled={busy}
                      title={t('triviaReports.action.deleteReportTitle')}
                      style={{
                        background: 'transparent', color: 'var(--text-muted)',
                        border: '1px solid var(--border)',
                        padding: '0.4rem 0.7rem', borderRadius: 8,
                        cursor: busy ? 'default' : 'pointer',
                        fontSize: '0.7rem', fontWeight: 600, opacity: busy ? 0.5 : 1,
                        marginInlineStart: 'auto',
                      }}
                    >
                      🗂 {t('triviaReports.action.deleteReport')}
                    </button>
                  </div>
                </>
              ) : (
                <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                  <button
                    onClick={() => callResolve(r, 'pending', null)}
                    disabled={busy}
                    style={{
                      background: 'var(--surface)', border: '1px solid var(--border)',
                      color: 'var(--text)', padding: '0.4rem 0.85rem', borderRadius: 8,
                      cursor: busy ? 'default' : 'pointer',
                      fontSize: '0.72rem', fontWeight: 600, opacity: busy ? 0.5 : 1,
                    }}
                  >
                    ↺ {t('triviaReports.action.reopen')}
                  </button>
                  {/* Pool kill-switch — also exposed on already-triaged
                      reports so an admin can revisit and remove the
                      template later (e.g. after a second report on the
                      same template_id). */}
                  <button
                    onClick={() => handleDeleteFromPool(r)}
                    disabled={busy}
                    title={t('triviaReports.action.deleteQuestionTitle')}
                    style={{
                      background: 'rgba(239, 68, 68, 0.12)', color: '#ef4444',
                      border: '1px solid rgba(239, 68, 68, 0.4)',
                      padding: '0.4rem 0.85rem', borderRadius: 8,
                      cursor: busy ? 'default' : 'pointer',
                      fontSize: '0.72rem', fontWeight: 700, opacity: busy ? 0.5 : 1,
                    }}
                  >
                    🗑 {t('triviaReports.action.deleteQuestion')}
                  </button>
                  <button
                    onClick={() => handleDelete(r.id)}
                    disabled={busy}
                    title={t('triviaReports.action.deleteReportTitle')}
                    style={{
                      background: 'transparent', color: 'var(--text-muted)',
                      border: '1px solid var(--border)',
                      padding: '0.4rem 0.7rem', borderRadius: 8,
                      cursor: busy ? 'default' : 'pointer',
                      fontSize: '0.7rem', fontWeight: 600, opacity: busy ? 0.5 : 1,
                      marginInlineStart: 'auto',
                    }}
                  >
                    🗂 {t('triviaReports.action.deleteReport')}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      )}

      {/* ── Deleted templates ────────────────────────────────────
          The kill-switch list. Shown only when there's at least
          one entry — empty state would just be noise. Each row
          shows what was removed, when, and by whom (best-effort
          via deleted_by uuid; full name not joined to keep this
          screen single-query). Restore button reverses the
          deletion via the `restore_trivia_template` RPC; realtime
          on `trivia_deleted_templates` then updates every client's
          generator pool within seconds. */}
      {view === 'reports' && deletedTemplates.length > 0 && (
        <div style={{ marginTop: '1.25rem' }}>
          <div style={{
            fontSize: '0.78rem', fontWeight: 700, color: 'var(--text)',
            marginBottom: '0.4rem', display: 'flex', alignItems: 'center', gap: '0.4rem',
          }}>
            🗑 {t('triviaReports.deletedTemplates.title')}
            <span style={{
              fontSize: '0.65rem', padding: '0.1rem 0.45rem', borderRadius: 999,
              background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444', fontWeight: 700,
            }}>{deletedTemplates.length}</span>
          </div>
          <div style={{
            fontSize: '0.7rem', color: 'var(--text-muted)',
            marginBottom: '0.55rem', lineHeight: 1.4,
          }}>
            {t('triviaReports.deletedTemplates.subtitle')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
            {deletedTemplates.map(d => {
              const busyRestore = poolBusyId === d.template_id;
              return (
                <div
                  key={d.template_id}
                  className="card"
                  style={{
                    padding: '0.55rem 0.75rem',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    gap: '0.55rem', flexWrap: 'wrap',
                  }}
                >
                  <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                    <div style={{
                      fontSize: '0.78rem', fontWeight: 700, color: 'var(--text)',
                      fontFamily: 'monospace', wordBreak: 'break-all',
                    }}>
                      {d.template_id}
                    </div>
                    {d.reason && (
                      <div style={{
                        fontSize: '0.7rem', color: 'var(--text-muted)',
                        marginTop: '0.2rem', fontStyle: 'italic', lineHeight: 1.35,
                      }}>
                        💬 {d.reason}
                      </div>
                    )}
                    <div style={{
                      fontSize: '0.62rem', color: 'var(--text-muted)',
                      marginTop: '0.2rem',
                    }}>
                      {formatDate(d.deleted_at)}
                    </div>
                  </div>
                  <button
                    onClick={() => handleRestoreFromPool(d.template_id)}
                    disabled={busyRestore || poolBusyId !== null}
                    title={t('triviaReports.deletedTemplates.restoreTitle')}
                    style={{
                      padding: '0.35rem 0.75rem', borderRadius: 8,
                      fontSize: '0.7rem', fontWeight: 700,
                      background: 'rgba(34, 197, 94, 0.12)', color: '#22c55e',
                      border: '1px solid rgba(34, 197, 94, 0.3)',
                      cursor: busyRestore ? 'wait' : (poolBusyId !== null ? 'default' : 'pointer'),
                      opacity: busyRestore || poolBusyId !== null ? 0.6 : 1,
                      flex: '0 0 auto',
                    }}
                  >
                    ↺ {t('triviaReports.deletedTemplates.restore')}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Players sub-view: per-player adoption + accuracy ─────── */}
      {view === 'players' && (
        <div>
          {playerStatsLoading && playerStats === null && (
            <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              {t('triviaReports.loading')}
            </div>
          )}

          {playerStats && playerStats.length === 0 && (
            <div style={{ padding: '1.25rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              {t('triviaReports.players.empty')}
            </div>
          )}

          {playerStats && playerStats.length > 0 && (
            <>
              {/* Aggregate header */}
              <div className="card" style={{
                padding: '0.7rem 0.9rem', marginBottom: '0.5rem',
                display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.5rem',
              }}>
                {[
                  { label: t('triviaReports.players.summary.players'), value: playerAggregates.players },
                  { label: t('triviaReports.players.summary.quizzes'), value: playerAggregates.quizzes },
                  { label: t('triviaReports.players.summary.questions'), value: playerAggregates.questions },
                  { label: t('triviaReports.players.summary.accuracy'),
                    value: playerAggregates.accuracy === null ? '—' : `${playerAggregates.accuracy}%` },
                ].map((c, i) => (
                  <div key={i} style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--text)' }}>{c.value}</div>
                    <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)' }}>{c.label}</div>
                  </div>
                ))}
              </div>

              {/* Group cleanup bar — wipes ALL trivia_sessions in
                  this group. Behind a confirm dialog because it's
                  irreversible. Group admins also have RLS DELETE
                  on trivia_sessions, but this UI is super-admin
                  only by tab gate so we don't double-guard. */}
              <div style={{
                display: 'flex', justifyContent: 'flex-end',
                marginBottom: '0.6rem',
              }}>
                <button
                  onClick={handleClearAllHistory}
                  disabled={cleanupBusy !== null}
                  style={{
                    padding: '0.35rem 0.7rem', borderRadius: 6,
                    fontSize: '0.65rem', fontWeight: 600,
                    background: 'transparent',
                    color: '#ef4444',
                    border: '1px solid rgba(239,68,68,0.3)',
                    cursor: cleanupBusy ? 'wait' : 'pointer',
                    opacity: cleanupBusy ? 0.5 : 1,
                  }}
                >
                  {cleanupBusy === '__all__' ? '⏳' : t('triviaReports.players.cleanupAll')}
                </button>
              </div>

              {cleanupMsg && (
                <div style={{
                  padding: '0.45rem 0.6rem', marginBottom: '0.6rem',
                  background: 'rgba(34,197,94,0.08)',
                  border: '1px solid rgba(34,197,94,0.2)',
                  borderRadius: 8, color: '#22c55e',
                  fontSize: '0.75rem', textAlign: 'center',
                }}>
                  ✓ {cleanupMsg}
                </div>
              )}

              {/* Per-player table */}
              <div className="card" style={{ padding: '0.6rem 0.4rem' }}>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
                    <thead>
                      <tr style={{ color: 'var(--text-muted)' }}>
                        <th style={{ textAlign: isRtl ? 'right' : 'left', padding: '0.35rem 0.55rem', fontWeight: 700 }}>
                          {t('triviaReports.players.col.name')}
                        </th>
                        <th style={{ textAlign: 'center', padding: '0.35rem 0.5rem', fontWeight: 700 }}>
                          {t('triviaReports.players.col.quizzes')}
                        </th>
                        <th style={{ textAlign: 'center', padding: '0.35rem 0.5rem', fontWeight: 700 }}>
                          {t('triviaReports.players.col.questions')}
                        </th>
                        <th style={{ textAlign: 'center', padding: '0.35rem 0.5rem', fontWeight: 700 }}>
                          {t('triviaReports.players.col.accuracy')}
                        </th>
                        <th style={{ textAlign: 'center', padding: '0.35rem 0.5rem', fontWeight: 700 }}>
                          {t('triviaReports.players.col.best')}
                        </th>
                        <th style={{ textAlign: isRtl ? 'left' : 'right', padding: '0.35rem 0.55rem', fontWeight: 700 }}>
                          {t('triviaReports.players.col.last')}
                        </th>
                        <th style={{ padding: '0.35rem 0.4rem' }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...playerStats]
                        .sort((a, z) => z.games - a.games)
                        .map((row, i) => {
                        const accuracy = row.accuracy === null ? '—' : `${Math.round(row.accuracy)}%`;
                        const last = row.last_played ? formatDate(row.last_played) : '—';
                        const isBusy = cleanupBusy === row.player_name;
                        return (
                          <tr key={row.player_name} style={{
                            borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                          }}>
                            <td style={{ padding: '0.4rem 0.55rem', fontWeight: 600 }}>
                              {row.player_name}
                            </td>
                            <td style={{ textAlign: 'center', padding: '0.4rem 0.5rem' }}>
                              {row.games}
                            </td>
                            <td style={{ textAlign: 'center', padding: '0.4rem 0.5rem' }}>
                              {row.total_correct} / {row.total_questions}
                            </td>
                            <td style={{ textAlign: 'center', padding: '0.4rem 0.5rem', fontWeight: 700,
                              color: row.accuracy === null ? 'var(--text-muted)'
                                : row.accuracy >= 70 ? '#22c55e'
                                : row.accuracy >= 50 ? '#f59e0b'
                                : '#ef4444',
                            }}>
                              {accuracy}
                            </td>
                            <td style={{ textAlign: 'center', padding: '0.4rem 0.5rem' }}>
                              {row.best_score}
                            </td>
                            <td style={{
                              textAlign: isRtl ? 'left' : 'right',
                              padding: '0.4rem 0.55rem',
                              fontSize: '0.7rem', color: 'var(--text-muted)',
                            }}>
                              {last}
                            </td>
                            <td style={{ padding: '0.4rem 0.4rem', textAlign: 'center' }}>
                              <button
                                onClick={() => handleClearPlayerHistory(row.player_name)}
                                disabled={cleanupBusy !== null}
                                title={t('triviaReports.players.cleanup')}
                                style={{
                                  padding: '0.2rem 0.4rem', borderRadius: 4,
                                  fontSize: '0.6rem',
                                  background: 'transparent', color: '#ef4444',
                                  border: '1px solid rgba(239,68,68,0.25)',
                                  cursor: cleanupBusy ? 'wait' : 'pointer',
                                  opacity: cleanupBusy ? 0.5 : 1,
                                }}
                              >
                                {isBusy ? '⏳' : '🗑'}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default TriviaReportsTab;
