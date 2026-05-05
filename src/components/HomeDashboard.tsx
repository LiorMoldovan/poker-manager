// Premium home-tab dashboard. Rendered for every authenticated role
// (members + admins + super-admin previews). Layout, top → bottom:
//
//   1. Admin-only "Start New Game" CTA (smooth-scrolls to the player picker
//      anchor element with id="player-picker-anchor" rendered by NewGameScreen).
//   2. Schedule card — confirmed poll with live countdown OR open-poll CTA OR
//      a soft empty state inviting the user to view the schedule tab.
//   3. Personal hero card — 4 stat tiles with count-up animation on first
//      paint, plus a records subtitle (biggest win + longest win streak).
//   4. Last game card — winner + your profit (color-coded).
//   5. Monthly leaderboard — top 3 by total profit this calendar month with
//      podium emojis. Highlights the current player's row when present.
//   6. Trivia — single-line "did-you-know" line from real cache data,
//      deterministically chosen by day-of-year so it changes daily but
//      stays consistent within a day.
//
// All cards stagger-fade-in via the existing `contentFadeIn` keyframe with
// per-card animation-delay so the screen feels intentional on first load.
// All data reads are synchronous in-memory cache lookups (cheap), and the
// component re-renders on `supabase-cache-updated` because parent state
// (playerStats / players) refreshes via `useRealtimeRefresh` upstream.
//
// Premium polish: subtle gradients on hero-tier cards, soft shadows, lift-on-
// hover where supported, color-coded streak/profit tiles, count-up animation
// only on first mount (subsequent re-renders set the value instantly to
// avoid a flicker on cache events).

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { PlayerStats } from '../types';
import { getAllPolls, getAllGames, getAllGamePlayers } from '../database/storage';
import { formatCurrency } from '../utils/calculations';
import { useTranslation, type TranslationKey } from '../i18n';
import { hapticTap } from '../utils/haptics';

interface HomeDashboardProps {
  playerName: string | null;
  playerStats: PlayerStats[];
  isAdmin: boolean;
  trainingEnabled: boolean;
  // True while an unfinished game (live or chip-entry) belongs to this
  // group. The "Start New Game" CTA is suppressed in that state — the
  // resume-active-game banner above the dashboard already tells the
  // admin to either resume or abandon, and clicking "start new" while
  // a game is active would just hit the existing `activeGameExists`
  // error path inside NewGameScreen.
  hasActiveGame: boolean;
}

export function HomeDashboard({ playerName, playerStats, isAdmin, hasActiveGame }: HomeDashboardProps) {
  const showAdminCta = isAdmin && !hasActiveGame;
  const { t } = useTranslation();
  const navigate = useNavigate();

  // ── My player stats (looked up by name; cheap) ──
  const myStats = useMemo(
    () => (playerName ? playerStats.find(s => s.playerName === playerName) ?? null : null),
    [playerName, playerStats],
  );

  // ── Cache-derived computations. Recomputed each render; the parent
  //    re-renders on every `supabase-cache-updated` event (via
  //    useRealtimeRefresh → loadPlayers → setPlayerStats), so these
  //    stay live without their own subscription. ──
  const polls = getAllPolls();
  const allGames = getAllGames();
  const allGamePlayers = getAllGamePlayers();

  // Most relevant active poll: prefer a confirmed-but-not-yet-started game
  // (the action is "show up"), then a still-open / expanding poll (the
  // action is "vote"). Cancelled / expired / already-played polls are noise.
  const activePoll = useMemo(
    () =>
      polls.find(p => p.status === 'confirmed' && !p.confirmedGameId)
      ?? polls.find(p => p.status === 'open' || p.status === 'expanded')
      ?? null,
    [polls],
  );

  // Last completed game (most recent by date).
  const lastGame = useMemo(() => {
    const completed = allGames
      .filter(g => g.status === 'completed')
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return completed[0] ?? null;
  }, [allGames]);

  // ── Card click handlers ──
  const goSchedule = () => { hapticTap(); navigate('/settings?tab=schedule'); };
  const goStats = () => { hapticTap(); navigate('/statistics'); };
  const goLastGame = () => { if (lastGame) { hapticTap(); navigate(`/game/${lastGame.id}`, { state: { from: 'home' } }); } };
  // CTA navigates to the dedicated /new-game action screen — the dashboard
  // is the home surface, the form lives one route deeper.
  const goNewGame = () => { hapticTap(); navigate('/new-game'); };

  // Card stagger delay (ms) — kept short so the dashboard feels responsive
  // not laggy. Each tier of card uses index * STEP for animation-delay.
  const STEP = 60;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', marginBottom: '0.5rem' }}>
      {showAdminCta && <StartNewGameCta order={0} step={STEP} t={t} onClick={goNewGame} />}
      <ScheduleCard order={showAdminCta ? 1 : 0} step={STEP} t={t} poll={activePoll} onClick={goSchedule} />
      {myStats && <PersonalHeroCard order={showAdminCta ? 2 : 1} step={STEP} t={t} stats={myStats} onClick={goStats} />}
      {lastGame && (
        <LastGameCard
          order={showAdminCta ? 3 : 2}
          step={STEP}
          t={t}
          gameId={lastGame.id}
          gameDate={lastGame.date}
          gamePlayers={allGamePlayers.filter(gp => gp.gameId === lastGame.id)}
          playerName={playerName}
          onClick={goLastGame}
        />
      )}
      <MonthlyLeaderboardCard
        order={showAdminCta ? 4 : 3}
        step={STEP}
        t={t}
        games={allGames}
        gamePlayers={allGamePlayers}
        playerName={playerName}
        onClick={goStats}
      />
      <TriviaCard
        order={showAdminCta ? 5 : 4}
        step={STEP}
        t={t}
        games={allGames}
        gamePlayers={allGamePlayers}
        playerStats={playerStats}
      />
    </div>
  );
}

// ─── Card primitives ────────────────────────────────────────────────────

const baseCardStyle = (
  order: number,
  step: number,
  extra?: React.CSSProperties,
): React.CSSProperties => ({
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: '0.75rem 0.9rem',
  cursor: extra?.cursor ?? 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: '0.7rem',
  // Reuse the existing `contentFadeIn` keyframe for stagger entrance.
  // `backwards` ensures the from-state applies before the delay starts so
  // we don't see a flash of fully-rendered cards before they animate in.
  animation: `contentFadeIn 0.35s cubic-bezier(0.2, 0.8, 0.2, 1) ${order * step}ms backwards`,
  ...extra,
});

interface SectionProps {
  order: number;
  step: number;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

// ─── 1. Admin-only "Start New Game" hero CTA ────────────────────────────

function StartNewGameCta({ order, step, t, onClick }: SectionProps & { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        ...baseCardStyle(order, step),
        background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.18), rgba(16, 185, 129, 0.06))',
        border: '1px solid rgba(16, 185, 129, 0.45)',
        fontFamily: 'inherit',
        textAlign: 'inherit' as React.CSSProperties['textAlign'],
        color: 'var(--text)',
        // No `appearance: button` — keeps the native button styles out so
        // the gradient renders cleanly in Safari / Chromium alike.
      }}
    >
      <span style={{ fontSize: '1.6rem', flexShrink: 0 }}>🃏</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text)' }}>
          {t('home.startNewGame.title')}
        </div>
        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
          {t('home.startNewGame.helper')}
        </div>
      </div>
      <span style={{ fontSize: '1rem', color: '#10b981', flexShrink: 0, fontWeight: 700 }}>‹</span>
    </button>
  );
}

// ─── 2. Schedule card ──────────────────────────────────────────────────

interface ScheduleCardProps extends SectionProps {
  poll: ReturnType<typeof getAllPolls>[number] | null;
  onClick: () => void;
}

function ScheduleCard({ order, step, t, poll, onClick }: ScheduleCardProps) {
  // Empty state — gives users a tap target into the schedule tab even when
  // there's no active poll, which is a common state right after a game.
  if (!poll) {
    return (
      <div onClick={onClick} style={baseCardStyle(order, step)}>
        <span style={{ fontSize: '1.5rem', flexShrink: 0 }}>🗓</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '0.88rem', fontWeight: 700, color: 'var(--text)' }}>
            {t('home.schedule.emptyTitle')}
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
            {t('home.schedule.emptyHelper')}
          </div>
        </div>
        <span style={ChevronStyle}>‹</span>
      </div>
    );
  }

  // Confirmed poll → show the actual date + a friendly countdown ribbon.
  // Open / expanded poll → call to vote.
  const isConfirmed = poll.status === 'confirmed';
  let dateLabel = '';
  let countdown: string | null = null;
  let location: string | null = null;
  // Below-target = the admin pinned a date before the seat target was
  // reached (the "fill-pinned-first" flow). We surface "X seats left"
  // on the home card so members see the recruitment ask without having
  // to open the schedule tab.
  let missingSeats = 0;
  if (isConfirmed && poll.confirmedDateId) {
    const d = poll.dates.find(x => x.id === poll.confirmedDateId);
    if (d?.proposedDate) {
      const dt = new Date(`${d.proposedDate}T${d.proposedTime || '20:00'}`);
      dateLabel = dt.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric' });
      // proposedTime may arrive as "HH:MM" or "HH:MM:SS" depending on
      // the source (manual edit vs DB Time column). Trim to HH:MM so the
      // card never shows a stray ":00" suffix.
      if (d.proposedTime) {
        const hhmm = d.proposedTime.slice(0, 5);
        dateLabel += ` · ${hhmm}`;
      }
      countdown = computeCountdown(d.proposedDate, d.proposedTime, t);
      // Per-date location wins; fall back to the poll-level default
      // (matches how the schedule tab and notifications resolve location).
      location = (d.location && d.location.trim()) || (poll.defaultLocation && poll.defaultLocation.trim()) || null;
    }
    const yesCount = poll.votes.filter(v => v.dateId === poll.confirmedDateId && v.response === 'yes').length;
    missingSeats = Math.max(0, poll.targetPlayerCount - yesCount);
  }

  return (
    <div
      onClick={onClick}
      style={baseCardStyle(order, step, isConfirmed
        ? {
          background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.16), rgba(16, 185, 129, 0.04))',
          border: '1px solid rgba(16, 185, 129, 0.40)',
        }
        : undefined)}
    >
      <span style={{ fontSize: '1.5rem', flexShrink: 0 }}>{isConfirmed ? '🎯' : '🗳'}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Header line: title + (when confirmed) the date inline as a
            secondary fragment, then the countdown / seats-left pills.
            Keeping the date on the same row saves a vertical line on the
            home dashboard — the date is the headline once the night is
            set, so it deserves headline placement. */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: '0.88rem', fontWeight: 700, color: 'var(--text)' }}>
            {isConfirmed ? t('home.schedule.confirmedTitle') : t('home.schedule.openTitle')}
            {isConfirmed && dateLabel && (
              <span style={{
                fontWeight: 500, color: 'var(--text-muted)',
                marginInlineStart: '0.4rem',
              }}>
                · {dateLabel}
              </span>
            )}
            {isConfirmed && location && (
              <span style={{
                fontWeight: 500, color: 'var(--text-muted)',
                marginInlineStart: '0.4rem',
              }}>
                · 📍 {location}
              </span>
            )}
          </span>
          {countdown && (
            <span style={{
              fontSize: '0.65rem', fontWeight: 700,
              padding: '2px 8px', borderRadius: 999,
              background: 'rgba(16, 185, 129, 0.18)',
              color: '#10b981',
              border: '1px solid rgba(16, 185, 129, 0.4)',
            }}>{countdown}</span>
          )}
          {/* Recruitment-aware "seats left" pill. Only shown for a
              confirmed-but-below-target poll so members can tell at a
              glance that the night still needs them. Indigo (not amber)
              keeps the tone informative rather than alarming — the
              decision was made in the schedule-tab banner refresh. */}
          {isConfirmed && missingSeats > 0 && (
            <span style={{
              fontSize: '0.65rem', fontWeight: 700,
              padding: '2px 8px', borderRadius: 999,
              background: 'rgba(99, 102, 241, 0.16)',
              color: '#a5b4fc',
              border: '1px solid rgba(99, 102, 241, 0.4)',
            }}>
              {missingSeats === 1
                ? t('home.schedule.missingOne')
                : t('home.schedule.missingMany', { n: missingSeats })}
            </span>
          )}
        </div>
        {/* Optional subtitle line. Date + location now live in the
            header span, so a confirmed poll usually needs no second
            row. We only render one when:
              * the poll is open/expanded (call-to-vote helper), or
              * the poll is confirmed but the date couldn't be resolved
                (defensive fallback — generic "tap for details"). */}
        {!isConfirmed && (
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
            {t('home.schedule.openHelper')}
          </div>
        )}
        {isConfirmed && !dateLabel && (
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
            {t('home.schedule.confirmedHelper')}
          </div>
        )}
      </div>
      <span style={ChevronStyle}>‹</span>
    </div>
  );
}

// Compute the countdown label for a confirmed poll. Calendar-day diff so
// "tomorrow" means the next calendar day regardless of the time-of-day
// difference. "today" applies even if the start time has already passed
// — the night still belongs to that calendar day until midnight.
function computeCountdown(
  proposedDate: string,
  proposedTime: string | null | undefined,
  t: SectionProps['t'],
): string | null {
  const target = new Date(`${proposedDate}T${proposedTime || '20:00'}`);
  if (Number.isNaN(target.getTime())) return null;
  const now = new Date();
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const targetDayStart = new Date(target); targetDayStart.setHours(0, 0, 0, 0);
  const diffDays = Math.round((targetDayStart.getTime() - todayStart.getTime()) / 86_400_000);
  if (diffDays < 0) return null;
  if (diffDays === 0) return t('home.schedule.countdownToday');
  if (diffDays === 1) return t('home.schedule.countdownTomorrow');
  if (diffDays <= 14) return t('home.schedule.countdownDays', { days: diffDays });
  return null; // 14+ days out is too far to feel like a countdown.
}

// ─── 3. Personal hero ──────────────────────────────────────────────────

interface PersonalHeroCardProps extends SectionProps {
  stats: PlayerStats;
  onClick: () => void;
}

function PersonalHeroCard({ order, step, t, stats, onClick }: PersonalHeroCardProps) {
  // Animate the four headline numbers from 0 → final on first paint.
  // Subsequent re-renders (e.g. realtime cache update) skip the animation
  // and reflect the new value immediately to avoid value-jump flicker.
  const games = useCountUp(stats.gamesPlayed);
  const winPct = useCountUp(Math.round(stats.winPercentage));
  const total = useCountUp(Math.round(stats.totalProfit));
  // Streak is signed: positive = wins, negative = losses. Animate magnitude
  // and re-sign for display.
  const streakMag = useCountUp(Math.abs(stats.currentStreak));
  const streakSign = stats.currentStreak >= 0 ? 1 : -1;
  const streak = streakMag * streakSign;

  const hasStreak = Math.abs(stats.currentStreak) >= 1;
  const streakLabel = hasStreak
    ? (streak > 0 ? t('home.personal.streakWins', { n: streakMag }) : t('home.personal.streakLosses', { n: streakMag }))
    : t('home.personal.streakNone');

  // Records subtitle — biggest win and longest win streak. Kept compact
  // (one line) to avoid duplicating /statistics. Hidden when the player
  // has never won (mostly fresh accounts) so we don't render a bare "₪0".
  const hasRecords = stats.biggestWin > 0 || stats.longestWinStreak > 0;
  const recordsLine = hasRecords
    ? t('home.personal.records', {
      biggest: formatCurrency(stats.biggestWin),
      streak: stats.longestWinStreak,
    })
    : '';

  return (
    <div
      onClick={onClick}
      style={baseCardStyle(order, step, {
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: '0.55rem',
        background: 'linear-gradient(135deg, rgba(168, 85, 247, 0.12), rgba(168, 85, 247, 0.02))',
        border: '1px solid rgba(168, 85, 247, 0.30)',
      })}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <span style={{ fontSize: '1rem' }}>📊</span>
        <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text)', flex: 1 }}>
          {t('home.personal.title')}
        </span>
        <span style={ChevronStyle}>‹</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.4rem' }}>
        <StatTile label={t('home.personal.games')} value={String(games)} />
        <StatTile label={t('home.personal.winRate')} value={`${winPct}%`} />
        <StatTile
          label={t('home.personal.total')}
          value={formatCurrency(total)}
          accent={total > 0 ? 'win' : total < 0 ? 'loss' : undefined}
        />
        <StatTile
          label={t('home.personal.streakLabel')}
          value={hasStreak ? `${streakSign > 0 ? '+' : '−'}${streakMag}` : '—'}
          accent={hasStreak ? (streak > 0 ? 'win' : 'loss') : undefined}
        />
      </div>
      {recordsLine && (
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.4 }}>
          {recordsLine}
        </div>
      )}
      {!recordsLine && (
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textAlign: 'center', lineHeight: 1.4 }}>
          {streakLabel}
        </div>
      )}
    </div>
  );
}

function StatTile({ label, value, accent }: { label: string; value: string; accent?: 'win' | 'loss' }) {
  const valueColor = accent === 'win' ? '#10b981' : accent === 'loss' ? '#ef4444' : 'var(--text)';
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '0.45rem 0.2rem', borderRadius: 8,
      background: 'rgba(255,255,255,0.025)',
      border: '1px solid rgba(255,255,255,0.04)',
    }}>
      <span style={{
        fontSize: '0.95rem', fontWeight: 800, color: valueColor,
        fontFeatureSettings: '"tnum"', // tabular numerals so digits don't jiggle
        lineHeight: 1.1,
      }}>
        {value}
      </span>
      <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: '0.15rem', textAlign: 'center' }}>
        {label}
      </span>
    </div>
  );
}

// ─── 4. Last game card ─────────────────────────────────────────────────

interface LastGameCardProps extends SectionProps {
  gameId: string;
  gameDate: string;
  gamePlayers: { playerName: string; profit: number }[];
  playerName: string | null;
  onClick: () => void;
}

function LastGameCard({ order, step, t, gameDate, gamePlayers, playerName, onClick }: LastGameCardProps) {
  const dateLabel = new Date(gameDate).toLocaleDateString('he-IL', {
    weekday: 'long', day: 'numeric', month: 'numeric',
  });

  let myProfit: number | null = null;
  if (playerName) {
    const me = gamePlayers.find(p => p.playerName === playerName);
    if (me) myProfit = me.profit;
  }

  // Winner = top profit player. Falls back gracefully if the array is
  // somehow empty (shouldn't happen — completed games always have players).
  let winnerName = '';
  let winnerProfit = -Infinity;
  for (const p of gamePlayers) {
    if (p.profit > winnerProfit) {
      winnerName = p.playerName;
      winnerProfit = p.profit;
    }
  }
  if (winnerProfit === -Infinity) winnerName = '';

  return (
    <div onClick={onClick} style={baseCardStyle(order, step)}>
      <span style={{ fontSize: '1.5rem', flexShrink: 0 }}>🏆</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '0.88rem', fontWeight: 700, color: 'var(--text)' }}>
          {t('home.lastGame.title')} · {dateLabel}
        </div>
        <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
          {winnerName && t('home.lastGame.winner', { name: winnerName })}
          {myProfit !== null && (
            <>
              {winnerName ? ' · ' : ''}
              <span style={{
                color: myProfit > 0 ? '#10b981' : myProfit < 0 ? '#ef4444' : 'var(--text-muted)',
                fontWeight: 600,
              }}>
                {myProfit > 0
                  ? t('home.lastGame.myProfit', { profit: formatCurrency(myProfit) })
                  : myProfit < 0
                    ? t('home.lastGame.myLoss', { amount: formatCurrency(Math.abs(myProfit)) })
                    : t('home.lastGame.myEven')}
              </span>
            </>
          )}
        </div>
      </div>
      <span style={ChevronStyle}>‹</span>
    </div>
  );
}

// ─── 5. Monthly leaderboard ────────────────────────────────────────────

interface LeaderboardProps extends SectionProps {
  games: ReturnType<typeof getAllGames>;
  gamePlayers: ReturnType<typeof getAllGamePlayers>;
  playerName: string | null;
  onClick: () => void;
}

function MonthlyLeaderboardCard({ order, step, t, games, gamePlayers, playerName, onClick }: LeaderboardProps) {
  const top3 = useMemo(() => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
    const monthGameIds = new Set(
      games
        .filter(g => g.status === 'completed')
        .filter(g => {
          const ts = new Date(g.date).getTime();
          return ts >= monthStart && ts < monthEnd;
        })
        .map(g => g.id),
    );
    if (monthGameIds.size === 0) return [];
    const byPlayer = new Map<string, { name: string; profit: number; games: number }>();
    for (const gp of gamePlayers) {
      if (!monthGameIds.has(gp.gameId)) continue;
      const cur = byPlayer.get(gp.playerName) ?? { name: gp.playerName, profit: 0, games: 0 };
      cur.profit += gp.profit;
      cur.games += 1;
      byPlayer.set(gp.playerName, cur);
    }
    return [...byPlayer.values()]
      .sort((a, b) => b.profit - a.profit)
      .slice(0, 3);
  }, [games, gamePlayers]);

  if (top3.length === 0) {
    return (
      <div onClick={onClick} style={baseCardStyle(order, step)}>
        <span style={{ fontSize: '1.5rem', flexShrink: 0 }}>🏅</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '0.88rem', fontWeight: 700, color: 'var(--text)' }}>
            {t('home.leaderboard.title')}
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
            {t('home.leaderboard.empty')}
          </div>
        </div>
        <span style={ChevronStyle}>‹</span>
      </div>
    );
  }

  const medals = ['🥇', '🥈', '🥉'];

  return (
    <div
      onClick={onClick}
      style={baseCardStyle(order, step, {
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: '0.45rem',
      })}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
        <span style={{ fontSize: '1rem' }}>🏅</span>
        <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text)', flex: 1 }}>
          {t('home.leaderboard.title')}
        </span>
        <span style={ChevronStyle}>‹</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
        {top3.map((p, i) => {
          const isMe = playerName !== null && p.name === playerName;
          return (
            <div
              key={p.name}
              style={{
                display: 'flex', alignItems: 'center', gap: '0.5rem',
                padding: '0.35rem 0.5rem', borderRadius: 7,
                background: isMe
                  ? 'rgba(16, 185, 129, 0.12)'
                  : 'rgba(255,255,255,0.025)',
                border: isMe
                  ? '1px solid rgba(16, 185, 129, 0.35)'
                  : '1px solid rgba(255,255,255,0.04)',
              }}
            >
              <span style={{ fontSize: '0.95rem', flexShrink: 0 }}>{medals[i]}</span>
              <span style={{
                flex: 1, fontSize: '0.78rem', fontWeight: isMe ? 700 : 600,
                color: 'var(--text)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {p.name}{isMe ? ` ${t('home.leaderboard.you')}` : ''}
              </span>
              <span style={{
                fontSize: '0.78rem', fontWeight: 700, fontFeatureSettings: '"tnum"',
                color: p.profit > 0 ? '#10b981' : p.profit < 0 ? '#ef4444' : 'var(--text-muted)',
                flexShrink: 0,
              }}>
                {p.profit > 0 ? '+' : ''}{formatCurrency(p.profit)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── 6. Trivia ─────────────────────────────────────────────────────────

interface TriviaProps extends SectionProps {
  games: ReturnType<typeof getAllGames>;
  gamePlayers: ReturnType<typeof getAllGamePlayers>;
  playerStats: PlayerStats[];
}

function TriviaCard({ order, step, t, games, gamePlayers, playerStats }: TriviaProps) {
  const trivia = useMemo(() => buildTriviaList(games, gamePlayers, playerStats, t), [games, gamePlayers, playerStats, t]);

  // Initial pick is a deterministic daily rotation — `dayOfYear % len` so
  // the same fact shows for the whole UTC day across all devices on first
  // load. After that the user can tap-to-cycle through the rest. We don't
  // persist the index across navigations on purpose: every fresh visit to
  // the home tab starts on "today's" fact, which is what most users want.
  const initialIndex = useMemo(() => {
    if (trivia.length === 0) return 0;
    const dayOfYear = Math.floor(
      (Date.now() - new Date(new Date().getUTCFullYear(), 0, 0).getTime()) / 86_400_000,
    );
    return dayOfYear % trivia.length;
  }, [trivia.length]);

  const [index, setIndex] = useState(initialIndex);
  // Keep index in range if the trivia list shrinks (e.g. data changes).
  const safeIndex = trivia.length > 0 ? index % trivia.length : 0;

  if (trivia.length === 0) return null;

  const pick = trivia[safeIndex];
  const canCycle = trivia.length > 1;

  const handleClick = () => {
    if (!canCycle) return;
    hapticTap();
    setIndex(i => (i + 1) % trivia.length);
  };

  return (
    <div
      onClick={handleClick}
      style={baseCardStyle(order, step, {
        cursor: canCycle ? 'pointer' : 'default',
        background: 'rgba(255,255,255,0.025)',
        gap: '0.6rem',
      })}
    >
      {/* `key` retriggers contentFadeIn on the inner content so the swap
          between facts gets a soft fade instead of a hard cut. The outer
          card animation (entrance stagger) is preserved. */}
      <span
        key={`icon-${safeIndex}`}
        style={{
          fontSize: '1.2rem',
          flexShrink: 0,
          animation: 'contentFadeIn 0.25s ease-out',
        }}
      >
        {pick.icon}
      </span>
      <div
        key={`text-${safeIndex}`}
        style={{
          flex: 1,
          minWidth: 0,
          animation: 'contentFadeIn 0.25s ease-out',
        }}
      >
        <div style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: '0.4rem',
          fontSize: '0.65rem',
          color: 'var(--text-muted)',
          fontWeight: 700,
          letterSpacing: 0.3,
        }}>
          <span>{t('home.trivia.title')}</span>
          {canCycle && (
            <span style={{
              fontSize: '0.6rem',
              fontWeight: 600,
              opacity: 0.55,
              letterSpacing: 0,
            }}>
              {t('home.trivia.tapForNext', { current: safeIndex + 1, total: trivia.length })}
            </span>
          )}
        </div>
        <div style={{ fontSize: '0.78rem', color: 'var(--text)', fontWeight: 600, marginTop: '0.1rem', lineHeight: 1.4 }}>
          {pick.text}
        </div>
      </div>
      {canCycle && <span style={ChevronStyle}>‹</span>}
    </div>
  );
}

function buildTriviaList(
  games: ReturnType<typeof getAllGames>,
  gamePlayers: ReturnType<typeof getAllGamePlayers>,
  playerStats: PlayerStats[],
  t: SectionProps['t'],
): { icon: string; text: string }[] {
  const list: { icon: string; text: string }[] = [];
  const yearStart = new Date(new Date().getFullYear(), 0, 1).getTime();
  const yearGameIds = new Set(
    games
      .filter(g => g.status === 'completed' && new Date(g.date).getTime() >= yearStart)
      .map(g => g.id),
  );
  const yearGP = gamePlayers.filter(gp => yearGameIds.has(gp.gameId));

  // 1. Biggest single win this year.
  let biggest = { name: '', profit: 0 };
  for (const gp of yearGP) {
    if (gp.profit > biggest.profit) biggest = { name: gp.playerName, profit: gp.profit };
  }
  if (biggest.profit > 0) {
    list.push({
      icon: '🏆',
      text: t('home.trivia.biggestWin', { profit: formatCurrency(biggest.profit), name: biggest.name }),
    });
  }

  // 2. Most active player this year.
  if (yearGP.length > 0) {
    const counts = new Map<string, number>();
    for (const gp of yearGP) counts.set(gp.playerName, (counts.get(gp.playerName) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= 3) {
      list.push({
        icon: '💪',
        text: t('home.trivia.mostActive', { name: top[0], games: top[1] }),
      });
    }
  }

  // 3. Total games played this year.
  if (yearGameIds.size >= 3) {
    list.push({ icon: '📅', text: t('home.trivia.gamesThisYear', { count: yearGameIds.size }) });
  }

  // 4. Longest active win streak across the group.
  let streakLeader = { name: '', streak: 0 };
  for (const ps of playerStats) {
    if (ps.currentStreak > streakLeader.streak) {
      streakLeader = { name: ps.playerName, streak: ps.currentStreak };
    }
  }
  if (streakLeader.streak >= 2) {
    list.push({
      icon: '🔥',
      text: t('home.trivia.streakLeader', { name: streakLeader.name, n: streakLeader.streak }),
    });
  }

  // 5. Total chips moved across the year. Profits sum to zero so the
  //    absolute sum is double the total movement; halve to express the
  //    actual net amount that changed hands.
  let absSum = 0;
  for (const gp of yearGP) absSum += Math.abs(gp.profit);
  const moved = Math.round(absSum / 2);
  if (moved > 0) {
    list.push({ icon: '💰', text: t('home.trivia.chipsMoved', { amount: formatCurrency(moved) }) });
  }

  return list;
}

// ─── Helpers ───────────────────────────────────────────────────────────

const ChevronStyle: React.CSSProperties = {
  fontSize: '0.85rem', color: 'var(--text-muted)', flexShrink: 0, opacity: 0.6,
};

// `useCountUp` — animate from 0 to `target` over `duration` ms on first
// mount. Subsequent target changes (e.g. cache refresh) snap to the new
// value to avoid jumpy re-animations every time realtime fires. Easing is
// a soft ease-out-cubic — fast at start, gentle at end.
function useCountUp(target: number, duration = 700): number {
  const [value, setValue] = useState(0);
  const animatedRef = useRef(false);

  useEffect(() => {
    // Always reflect the latest target — but only ANIMATE the first time.
    if (animatedRef.current) {
      setValue(target);
      return;
    }
    animatedRef.current = true;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(target * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);

  return value;
}
