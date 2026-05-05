// Home-tab dashboard. Rendered for every authenticated role
// (members + admins + super-admin previews).
//
// Layout (top → bottom). The order encodes an information-hierarchy
// principle: primary action → upcoming context → recent news →
// evergreen status → group context → secondary discovery → flavor.
//   1. Start New Game — admin-only CTA, suppressed while a game is live
//   2. Schedule — what's next: confirmed game / open poll / empty
//   3. Last Game — what just happened (recent news beats evergreen)
//   4. Personal — how am I doing (4 stat tiles + summary line)
//   5. Monthly leaderboard — where do I stand
//   6. Training — secondary discovery feature, opt-in per group
//   7. Trivia — tap-to-cycle "did you know" facts (flavor)
//
// Design system: every section renders through the single `HomeCard`
// primitive defined below. The primitive owns padding, typography,
// border, shadow, and the entrance stagger animation, so the page
// reads as one cohesive surface — no per-card patching of icon
// sizes / title weights / subtitle treatments.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { PlayerStats } from '../types';
import { getAllPolls, getAllGames, getAllGamePlayers } from '../database/storage';
import { formatCurrency, cleanNumber } from '../utils/calculations';
import { useTranslation, type TranslationKey } from '../i18n';
import { hapticTap } from '../utils/haptics';
import { getSharedProgress } from '../utils/pokerTraining';

// ─── Design tokens ──────────────────────────────────────────────────────
// Every dashboard card MUST consume these instead of hard-coding sizes,
// otherwise we'll drift back into the per-card-patch problem.
const CARD_PADDING = '0.85rem 0.95rem';
const CARD_RADIUS = 12;
const CARD_GAP = '0.7rem';
const CARD_BODY_GAP = '0.55rem';
const ICON_SIZE = '1.5rem';
const TITLE_SIZE = '0.88rem';
const TITLE_WEIGHT = 700;
const SUBTITLE_SIZE = '0.72rem';
const STACK_GAP = '0.6rem'; // distance between cards

// "Me" highlight tokens — match the app-wide convention used in
// StatisticsScreen / SharedTrainingScreen so the current player is
// rendered in the same blue tint everywhere.
const ME_BG = 'rgba(59, 130, 246, 0.14)';
const ME_BORDER = 'rgba(59, 130, 246, 0.45)';
const ME_NAME_COLOR = '#60a5fa';

// Profit tints, reused across cards to keep wins / losses uniform.
const WIN_COLOR = '#10b981';
const LOSS_COLOR = '#ef4444';

// ─── HomeDashboard ──────────────────────────────────────────────────────

interface HomeDashboardProps {
  playerName: string | null;
  playerStats: PlayerStats[];
  isAdmin: boolean;
  trainingEnabled: boolean;
  // True while an unfinished game (live or chip-entry) belongs to this
  // group. The "Start New Game" CTA is suppressed in that state — the
  // resume-active-game banner above the dashboard already tells the
  // admin to either resume or abandon.
  hasActiveGame: boolean;
}

export function HomeDashboard({ playerName, playerStats, isAdmin, trainingEnabled, hasActiveGame }: HomeDashboardProps) {
  const showAdminCta = isAdmin && !hasActiveGame;
  const { t } = useTranslation();
  const navigate = useNavigate();

  const myStats = useMemo(
    () => (playerName ? playerStats.find(s => s.playerName === playerName) ?? null : null),
    [playerName, playerStats],
  );

  // Cache reads — synchronous, recomputed each render. The parent
  // re-renders on `supabase-cache-updated` (via useRealtimeRefresh),
  // so these stay live without their own subscription.
  const polls = getAllPolls();
  const allGames = getAllGames();
  const allGamePlayers = getAllGamePlayers();

  // Most relevant active poll: confirmed-pending-game wins over open.
  const activePoll = useMemo(
    () =>
      polls.find(p => p.status === 'confirmed' && !p.confirmedGameId)
      ?? polls.find(p => p.status === 'open' || p.status === 'expanded')
      ?? null,
    [polls],
  );

  const lastGame = useMemo(() => {
    const completed = allGames
      .filter(g => g.status === 'completed')
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return completed[0] ?? null;
  }, [allGames]);

  // Days since this user last played a completed game (regardless of
  // which game it was). Used by LastGameCard to surface an
  // encouragement line when the displayed last game didn't include
  // them. `myStats.lastGameResults` is already sorted most-recent-first
  // by the stats pipeline, so [0] is the user's most recent game.
  // `null` means the user has never played a completed game.
  const daysSinceMyLastGame = useMemo(() => {
    const lastDate = myStats?.lastGameResults?.[0]?.date;
    if (!lastDate) return null;
    const ms = Date.now() - new Date(lastDate).getTime();
    return Math.max(0, Math.floor(ms / 86_400_000));
  }, [myStats]);

  const goSchedule = () => { hapticTap(); navigate('/settings?tab=schedule'); };
  const goLastGame = () => { if (lastGame) { hapticTap(); navigate(`/game/${lastGame.id}`, { state: { from: 'home' } }); } };
  const goNewGame = () => { hapticTap(); navigate('/new-game'); };
  // Tap on the personal card → open Statistics → Players tab and
  // scroll to the user's own player card. Statistics already wires
  // this up via the `playerInfo` location-state field (see
  // StatisticsScreen.tsx, the savedPlayerInfo effect).
  const goPersonal = () => {
    hapticTap();
    if (myStats) {
      navigate('/statistics', {
        state: {
          viewMode: 'players',
          playerInfo: { playerId: myStats.playerId, playerName: myStats.playerName },
        },
      });
    } else {
      navigate('/statistics');
    }
  };
  // Tap on the leaderboard card → open Statistics filtered to the
  // current calendar month, which is exactly what the leaderboard
  // previews. The table view shows all players ranked for that
  // month, so a tap drills into the same data the card hints at.
  const goLeaderboard = () => {
    hapticTap();
    const now = new Date();
    navigate('/statistics', {
      state: {
        viewMode: 'table',
        timePeriod: 'month',
        selectedYear: now.getFullYear(),
        selectedMonth: now.getMonth() + 1,
      },
    });
  };

  // Stagger delay (ms) between successive cards. Short enough that the
  // user perceives the page as instant, long enough that the cards
  // visibly arrive in sequence.
  const STEP = 60;
  let order = 0;
  const next = () => order++;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: STACK_GAP, marginBottom: '0.5rem' }}>
      {showAdminCta && <StartNewGameCta order={next()} step={STEP} t={t} onClick={goNewGame} />}
      <ScheduleCard order={next()} step={STEP} t={t} poll={activePoll} onClick={goSchedule} />
      {lastGame && (
        <LastGameCard
          order={next()}
          step={STEP}
          t={t}
          gameDate={lastGame.date}
          gamePlayers={allGamePlayers.filter(gp => gp.gameId === lastGame.id)}
          playerName={playerName}
          daysSinceMyLastGame={daysSinceMyLastGame}
          onClick={goLastGame}
        />
      )}
      {myStats && <PersonalCard order={next()} step={STEP} t={t} stats={myStats} onClick={goPersonal} />}
      <LeaderboardCard
        order={next()}
        step={STEP}
        t={t}
        games={allGames}
        gamePlayers={allGamePlayers}
        playerName={playerName}
        onClick={goLeaderboard}
      />
      {trainingEnabled && (
        <TrainingCard
          order={next()}
          step={STEP}
          t={t}
          playerName={playerName}
          stats={myStats}
          onClick={() => { hapticTap(); navigate('/shared-training'); }}
        />
      )}
      <TriviaCard
        order={next()}
        step={STEP}
        t={t}
        games={allGames}
        gamePlayers={allGamePlayers}
        playerStats={playerStats}
      />
    </div>
  );
}

// ─── Card primitive ─────────────────────────────────────────────────────

interface HomeCardProps {
  order: number;
  step: number;
  icon: string;
  title: string;
  // Single line by default; long values are clamped to 2 lines so a
  // long location / fact text never blows the card height out.
  subtitle?: React.ReactNode;
  // Right-aligned slot — pills, cycling indicator, etc.
  accessory?: React.ReactNode;
  // Below-row content slot — stat-tile grids, podium rows, etc.
  body?: React.ReactNode;
  // 'success' tints the card with a green gradient. Reserved for the
  // single primary CTA on screen so we don't end up with a wall of
  // green that loses its meaning.
  accent?: 'default' | 'success';
  onClick?: () => void;
  as?: 'div' | 'button';
}

function HomeCard({
  order,
  step,
  icon,
  title,
  subtitle,
  accessory,
  body,
  accent = 'default',
  onClick,
  as = 'div',
}: HomeCardProps) {
  const accentStyle: React.CSSProperties = accent === 'success'
    ? {
      background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.18), rgba(16, 185, 129, 0.04))',
      border: '1px solid rgba(16, 185, 129, 0.42)',
    }
    : {
      background: 'var(--surface)',
      border: '1px solid transparent',
    };

  const wrapStyle: React.CSSProperties = {
    ...accentStyle,
    borderRadius: CARD_RADIUS,
    padding: CARD_PADDING,
    boxShadow: 'var(--card-shadow)',
    cursor: onClick ? 'pointer' : 'default',
    display: 'flex',
    flexDirection: 'column',
    gap: body ? CARD_BODY_GAP : 0,
    width: '100%',
    fontFamily: 'inherit',
    color: 'var(--text)',
    textAlign: 'inherit' as React.CSSProperties['textAlign'],
    animation: `contentFadeIn 0.35s cubic-bezier(0.2, 0.8, 0.2, 1) ${order * step}ms backwards`,
  };

  const inner = (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: CARD_GAP }}>
        <span aria-hidden style={{ fontSize: ICON_SIZE, lineHeight: 1, flexShrink: 0 }}>{icon}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: '0.5rem',
            justifyContent: 'space-between',
          }}>
            <span style={{
              fontSize: TITLE_SIZE,
              fontWeight: TITLE_WEIGHT,
              color: 'var(--text)',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {title}
            </span>
            {accessory && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.3rem',
                flexShrink: 0,
              }}>
                {accessory}
              </div>
            )}
          </div>
          {subtitle && (
            <div style={{
              fontSize: SUBTITLE_SIZE,
              color: 'var(--text-muted)',
              marginTop: '0.2rem',
              lineHeight: 1.45,
              // Cap subtitle at 2 lines so a long fact / location can't
              // distort the card height. ellipsis on overflow.
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}>
              {subtitle}
            </div>
          )}
        </div>
      </div>
      {body}
    </>
  );

  if (as === 'button') {
    return (
      <button onClick={onClick} style={wrapStyle}>{inner}</button>
    );
  }
  return (
    <div onClick={onClick} style={wrapStyle}>{inner}</div>
  );
}

interface SectionProps {
  order: number;
  step: number;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

// ─── 1. Start New Game (admin) ──────────────────────────────────────────

function StartNewGameCta({ order, step, t, onClick }: SectionProps & { onClick: () => void }) {
  return (
    <HomeCard
      order={order}
      step={step}
      as="button"
      icon="🃏"
      title={t('home.startNewGame.title')}
      subtitle={t('home.startNewGame.helper')}
      accent="success"
      onClick={onClick}
    />
  );
}

// ─── 2. Schedule ────────────────────────────────────────────────────────

interface ScheduleCardProps extends SectionProps {
  poll: ReturnType<typeof getAllPolls>[number] | null;
  onClick: () => void;
}

function ScheduleCard({ order, step, t, poll, onClick }: ScheduleCardProps) {
  if (!poll) {
    return (
      <HomeCard
        order={order}
        step={step}
        icon="🗓"
        title={t('home.schedule.emptyTitle')}
        subtitle={t('home.schedule.emptyHelper')}
        onClick={onClick}
      />
    );
  }

  const isConfirmed = poll.status === 'confirmed';

  if (isConfirmed) {
    let dateLabel = '';
    let countdown: string | null = null;
    let location: string | null = null;
    let missingSeats = 0;

    if (poll.confirmedDateId) {
      const d = poll.dates.find(x => x.id === poll.confirmedDateId);
      if (d?.proposedDate) {
        const dt = new Date(`${d.proposedDate}T${d.proposedTime || '20:00'}`);
        dateLabel = dt.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric' });
        if (d.proposedTime) {
          dateLabel += ` · ${d.proposedTime.slice(0, 5)}`;
        }
        countdown = computeCountdown(d.proposedDate, d.proposedTime, t);
        location = (d.location && d.location.trim()) || (poll.defaultLocation && poll.defaultLocation.trim()) || null;
      }
      const yesCount = poll.votes.filter(v => v.dateId === poll.confirmedDateId && v.response === 'yes').length;
      missingSeats = Math.max(0, poll.targetPlayerCount - yesCount);
    }

    // Subtitle is a single inline line. NO redundant emojis (the title
    // already carries 🎯) — the dot separator is enough.
    const subtitle = dateLabel ? (
      <>
        {dateLabel}
        {location && (
          <>
            <span style={{ marginInline: '0.4rem', opacity: 0.6 }}>·</span>
            {location}
          </>
        )}
      </>
    ) : t('home.schedule.confirmedHelper');

    const accessory = (countdown || missingSeats > 0) ? (
      <>
        {countdown && <Pill text={countdown} tone="success" />}
        {missingSeats > 0 && (
          <Pill
            text={missingSeats === 1
              ? t('home.schedule.missingOne')
              : t('home.schedule.missingMany', { n: missingSeats })}
            tone="info"
          />
        )}
      </>
    ) : undefined;

    return (
      <HomeCard
        order={order}
        step={step}
        icon="🎯"
        title={t('home.schedule.confirmedTitle')}
        subtitle={subtitle}
        accessory={accessory}
        onClick={onClick}
      />
    );
  }

  return (
    <HomeCard
      order={order}
      step={step}
      icon="🗳"
      title={t('home.schedule.openTitle')}
      subtitle={t('home.schedule.openHelper')}
      onClick={onClick}
    />
  );
}

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

// ─── 3. Personal ────────────────────────────────────────────────────────

interface PersonalCardProps extends SectionProps {
  stats: PlayerStats;
  onClick: () => void;
}

function PersonalCard({ order, step, t, stats, onClick }: PersonalCardProps) {
  // Animate the headline numbers from 0 → final on first paint.
  const games = useCountUp(stats.gamesPlayed);
  const winPct = useCountUp(Math.round(stats.winPercentage));
  const total = useCountUp(Math.round(stats.totalProfit));
  const streakMag = useCountUp(Math.abs(stats.currentStreak));
  const streakSign = stats.currentStreak >= 0 ? 1 : -1;
  const hasStreak = Math.abs(stats.currentStreak) >= 1;

  // Subtitle: prefer the records line if any wins exist, else the
  // streak summary. We do NOT duplicate streak info (it's already a
  // tile) — when records aren't available the subtitle just falls back
  // to a generic encouragement.
  const hasRecords = stats.biggestWin > 0 || stats.longestWinStreak > 0;
  const subtitle = hasRecords
    ? t('home.personal.records', {
      biggest: formatCurrency(stats.biggestWin),
      streak: stats.longestWinStreak,
    })
    : t('home.personal.encouragement');

  const body = (
    // `minmax(0, 1fr)` (instead of plain `1fr`) prevents a track
    // from growing past its share when a long currency value like
    // `₪123,456` is wider than the equal-width slice. Without this,
    // a single big number would stretch its tile and squeeze the
    // others on small screens.
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: '0.4rem' }}>
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
        accent={hasStreak ? (streakSign > 0 ? 'win' : 'loss') : undefined}
      />
    </div>
  );

  return (
    <HomeCard
      order={order}
      step={step}
      icon="📊"
      title={t('home.personal.title')}
      subtitle={subtitle}
      body={body}
      onClick={onClick}
    />
  );
}

function StatTile({ label, value, accent }: { label: string; value: string; accent?: 'win' | 'loss' }) {
  const valueColor = accent === 'win' ? WIN_COLOR : accent === 'loss' ? LOSS_COLOR : 'var(--text)';
  // `minWidth: 0` is critical inside a grid: without it the tile's
  // intrinsic min-content is its widest child, so a 7-char currency
  // value would force the tile (and the whole grid track) wider on
  // narrow screens. Combined with text-overflow on the value/label
  // spans, this keeps every tile exactly equal in width and clips
  // any pathological-length value with an ellipsis.
  const clipStyle: React.CSSProperties = {
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      padding: '0.45rem 0.2rem', borderRadius: 8,
      background: 'rgba(255,255,255,0.025)',
      border: '1px solid rgba(255,255,255,0.04)',
      minWidth: 0,
    }}>
      <span style={{
        fontSize: '0.95rem', fontWeight: 800, color: valueColor,
        fontFeatureSettings: '"tnum"',
        lineHeight: 1.1,
        ...clipStyle,
      }}>
        {value}
      </span>
      <span style={{
        fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: '0.15rem', textAlign: 'center',
        ...clipStyle,
      }}>
        {label}
      </span>
    </div>
  );
}

// ─── 4. Last game ───────────────────────────────────────────────────────

interface LastGameCardProps extends SectionProps {
  gameDate: string;
  gamePlayers: { playerName: string; profit: number }[];
  playerName: string | null;
  // Days since this user last played a completed game. `null` if they
  // have never played. Only used to render an "encouragement" line
  // when the user did NOT participate in the displayed last game.
  daysSinceMyLastGame: number | null;
  onClick: () => void;
}

function LastGameCard({ order, step, t, gameDate, gamePlayers, playerName, daysSinceMyLastGame, onClick }: LastGameCardProps) {
  const dateLabel = new Date(gameDate).toLocaleDateString('he-IL', {
    weekday: 'long', day: 'numeric', month: 'numeric',
  });

  let myProfit: number | null = null;
  if (playerName) {
    const me = gamePlayers.find(p => p.playerName === playerName);
    if (me) myProfit = me.profit;
  }

  let winnerName = '';
  let winnerProfit = -Infinity;
  for (const p of gamePlayers) {
    if (p.profit > winnerProfit) {
      winnerName = p.playerName;
      winnerProfit = p.profit;
    }
  }
  if (winnerProfit === -Infinity) winnerName = '';

  const profitText = myProfit === null ? null
    : myProfit > 0 ? t('home.lastGame.myProfit', { profit: formatCurrency(myProfit) })
      : myProfit < 0 ? t('home.lastGame.myLoss', { amount: formatCurrency(Math.abs(myProfit)) })
        : t('home.lastGame.myEven');
  const profitColor = myProfit === null ? 'inherit'
    : myProfit > 0 ? WIN_COLOR : myProfit < 0 ? LOSS_COLOR : 'inherit';

  // My finishing place when I participated. Sorted desc by profit so
  // place 1 = winner. We skip place 1 because the "winner: …" segment
  // already says it. Multi-player games only — a 1-player roster is a
  // data anomaly we don't dignify with a place label.
  let myPlaceText: string | null = null;
  if (myProfit !== null && playerName && gamePlayers.length >= 2) {
    const sorted = [...gamePlayers].sort((a, b) => b.profit - a.profit);
    const place = sorted.findIndex(p => p.playerName === playerName) + 1;
    if (place >= 2) {
      myPlaceText = t('home.lastGame.myPlace', { place });
    }
  }

  // Encouragement line when the user did NOT participate. Five tiers
  // (plus a "never played" fallback) tuned to common cadences for
  // friendly poker nights, escalating from gentle nudge to "we miss
  // you". Each message is name-prefixed so it's unmistakably
  // addressed to *this* viewer rather than reading like a generic
  // marketing line:
  //
  //   * never played   → "{name}, join your first game"
  //   * 0–7 days       → "{name}, you missed this one — see you next time"
  //   * 8–30 days      → "{name}, {days} days without a table — join us?"
  //   * 31–90 days     → "{name}, {weeks} weeks without a game — come back"
  //   * 91–180 days    → "{name}, {months} months without a game — we miss you!"
  //   * 181+ days      → "{name}, over half a year away — come back!"
  //
  // We only render this when `playerName` is set so unlinked viewers
  // (extremely rare) don't see a line addressed to them.
  // Color escalates from neutral indigo (recruitment tone) to amber
  // (warm "miss you" tone) as the absence grows, so the longer the
  // gap the warmer/more attention-grabbing the line.
  let absentText: string | null = null;
  let absentColor = 'inherit';
  if (myProfit === null && playerName) {
    const name = playerName;
    if (daysSinceMyLastGame === null) {
      absentText = t('home.lastGame.absentNeverPlayed', { name });
      absentColor = '#a5b4fc';
    } else if (daysSinceMyLastGame <= 7) {
      absentText = t('home.lastGame.absentRecent', { name });
      absentColor = '#a5b4fc';
    } else if (daysSinceMyLastGame <= 30) {
      absentText = t('home.lastGame.absentDays', { name, days: daysSinceMyLastGame });
      absentColor = '#a5b4fc';
    } else if (daysSinceMyLastGame <= 90) {
      const weeks = Math.floor(daysSinceMyLastGame / 7);
      absentText = t('home.lastGame.absentWeeks', { name, weeks });
      absentColor = '#fbbf24';
    } else if (daysSinceMyLastGame <= 180) {
      // 30-day months are the cleanest unit for "a few months ago"
      // copy — calendar months would drift and require dedicated
      // diff math for a tiny readability win.
      const months = Math.max(2, Math.round(daysSinceMyLastGame / 30));
      absentText = t('home.lastGame.absentMonths', { name, months });
      absentColor = '#fbbf24';
    } else {
      absentText = t('home.lastGame.absentLong', { name });
      absentColor = '#fbbf24';
    }
  }

  const subtitle = (
    <>
      {dateLabel}
      {winnerName && (
        <>
          <span style={{ marginInline: '0.4rem', opacity: 0.6 }}>·</span>
          {t('home.lastGame.winner', { name: winnerName })}
        </>
      )}
      {myPlaceText && (
        <>
          <span style={{ marginInline: '0.4rem', opacity: 0.6 }}>·</span>
          <span style={{ fontWeight: 600 }}>{myPlaceText}</span>
        </>
      )}
      {profitText && (
        <>
          <span style={{ marginInline: '0.4rem', opacity: 0.6 }}>·</span>
          <span style={{ color: profitColor, fontWeight: 600 }}>{profitText}</span>
        </>
      )}
      {absentText && (
        <>
          <span style={{ marginInline: '0.4rem', opacity: 0.6 }}>·</span>
          <span style={{ color: absentColor, fontWeight: 600 }}>{absentText}</span>
        </>
      )}
    </>
  );

  return (
    <HomeCard
      order={order}
      step={step}
      icon="🏆"
      title={t('home.lastGame.title')}
      subtitle={subtitle}
      onClick={onClick}
    />
  );
}

// ─── 5. Monthly leaderboard ─────────────────────────────────────────────

interface LeaderboardProps extends SectionProps {
  games: ReturnType<typeof getAllGames>;
  gamePlayers: ReturnType<typeof getAllGamePlayers>;
  playerName: string | null;
  onClick: () => void;
}

function LeaderboardCard({ order, step, t, games, gamePlayers, playerName, onClick }: LeaderboardProps) {
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
      <HomeCard
        order={order}
        step={step}
        icon="🏅"
        title={t('home.leaderboard.title')}
        subtitle={t('home.leaderboard.empty')}
        onClick={onClick}
      />
    );
  }

  const medals = ['🥇', '🥈', '🥉'];
  const body = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
      {top3.map((p, i) => {
        const isMe = playerName !== null && p.name === playerName;
        return (
          <div
            key={p.name}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.5rem',
              padding: '0.35rem 0.5rem', borderRadius: 7,
              background: isMe ? ME_BG : 'rgba(255,255,255,0.025)',
              border: isMe ? `1px solid ${ME_BORDER}` : '1px solid rgba(255,255,255,0.04)',
            }}
          >
            <span style={{ fontSize: '0.95rem', flexShrink: 0 }}>{medals[i]}</span>
            <span style={{
              flex: 1,
              // `min-width: 0` is required for a flex child with
              // `text-overflow: ellipsis` to actually shrink below its
              // intrinsic content width. Without it a long Hebrew name
              // would push the profit pill off-card on a narrow screen.
              minWidth: 0,
              fontSize: '0.78rem', fontWeight: isMe ? 700 : 600,
              color: isMe ? ME_NAME_COLOR : 'var(--text)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {p.name}
            </span>
            <span style={{
              fontSize: '0.78rem', fontWeight: 700, fontFeatureSettings: '"tnum"',
              color: p.profit > 0 ? WIN_COLOR : p.profit < 0 ? LOSS_COLOR : 'var(--text-muted)',
              flexShrink: 0,
            }}>
              {/* No '+' prefix — green color + medal podium already
                  signal "winning". Negative values still get a native
                  '−' from the formatter so losses are unambiguous. */}
              {formatCurrency(p.profit)}
            </span>
          </div>
        );
      })}
    </div>
  );

  return (
    <HomeCard
      order={order}
      step={step}
      icon="🏅"
      title={t('home.leaderboard.title')}
      body={body}
      onClick={onClick}
    />
  );
}

// ─── 6. Trivia ──────────────────────────────────────────────────────────

interface TriviaProps extends SectionProps {
  games: ReturnType<typeof getAllGames>;
  gamePlayers: ReturnType<typeof getAllGamePlayers>;
  playerStats: PlayerStats[];
}

function TriviaCard({ order, step, t, games, gamePlayers, playerStats }: TriviaProps) {
  const trivia = useMemo(
    () => buildTriviaList(games, gamePlayers, playerStats, t),
    [games, gamePlayers, playerStats, t],
  );

  // Initial pick is a deterministic daily rotation — same fact for the
  // whole UTC day across all devices on first load. After that the
  // user can tap-to-cycle through the rest.
  const initialIndex = useMemo(() => {
    if (trivia.length === 0) return 0;
    const dayOfYear = Math.floor(
      (Date.now() - new Date(new Date().getUTCFullYear(), 0, 0).getTime()) / 86_400_000,
    );
    return dayOfYear % trivia.length;
  }, [trivia.length]);

  const [index, setIndex] = useState(initialIndex);
  const safeIndex = trivia.length > 0 ? index % trivia.length : 0;

  if (trivia.length === 0) return null;

  const pick = trivia[safeIndex];
  const canCycle = trivia.length > 1;

  const handleClick = canCycle
    ? () => { hapticTap(); setIndex(i => (i + 1) % trivia.length); }
    : undefined;

  // The fact's icon becomes the card icon, and the title is the
  // standard trivia label. We `key` the inner spans by index so a
  // crossfade plays on each tap — but the entrance stagger on the
  // outer card stays untouched.
  const accessory = canCycle ? (
    <span style={{
      fontSize: '0.65rem',
      color: 'var(--text-muted)',
      fontWeight: 600,
      opacity: 0.8,
      fontFeatureSettings: '"tnum"',
    }}>
      {safeIndex + 1}/{trivia.length}
    </span>
  ) : undefined;

  return (
    <div key={`trivia-${safeIndex}`} style={{ animation: 'contentFadeIn 0.25s ease-out' }}>
      <HomeCard
        order={order}
        step={step}
        icon={pick.icon}
        title={t('home.trivia.title')}
        subtitle={pick.text}
        accessory={accessory}
        onClick={handleClick}
      />
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
  const playersByGame = new Map<string, typeof yearGP>();
  for (const gp of yearGP) {
    const arr = playersByGame.get(gp.gameId);
    if (arr) arr.push(gp);
    else playersByGame.set(gp.gameId, [gp]);
  }

  // Recently-active = appeared in any completed game in the last 60
  // days. Used to gate facts that reference a player's "current" state
  // (e.g. streak leader) so a frozen streak from someone who quit
  // doesn't haunt the card forever.
  const recentCutoff = Date.now() - 60 * 86_400_000;
  const recentGameIds = new Set(
    games
      .filter(g => g.status === 'completed' && new Date(g.date).getTime() >= recentCutoff)
      .map(g => g.id),
  );
  const recentPlayerNames = new Set<string>();
  for (const gp of gamePlayers) {
    if (recentGameIds.has(gp.gameId)) recentPlayerNames.add(gp.playerName);
  }

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

  // 2. Biggest single loss this year.
  let worst = { name: '', loss: 0 };
  for (const gp of yearGP) {
    if (gp.profit < worst.loss) worst = { name: gp.playerName, loss: gp.profit };
  }
  if (worst.loss < -50) {
    list.push({
      icon: '❄️',
      text: t('home.trivia.biggestLoss', { amount: formatCurrency(Math.abs(worst.loss)), name: worst.name }),
    });
  }

  // 3. Most active player this year.
  if (yearGP.length > 0) {
    const counts = new Map<string, number>();
    for (const gp of yearGP) counts.set(gp.playerName, (counts.get(gp.playerName) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= 3) {
      list.push({ icon: '💪', text: t('home.trivia.mostActive', { name: top[0], games: top[1] }) });
    }
  }

  // 4. Most #1 finishes this year.
  if (yearGameIds.size >= 3) {
    const wins = new Map<string, number>();
    for (const gameId of yearGameIds) {
      const players = playersByGame.get(gameId);
      if (!players || players.length === 0) continue;
      let winner = players[0];
      for (const p of players) if (p.profit > winner.profit) winner = p;
      if (winner.profit > 0) wins.set(winner.playerName, (wins.get(winner.playerName) ?? 0) + 1);
    }
    const topWinner = [...wins.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topWinner && topWinner[1] >= 2) {
      list.push({ icon: '👑', text: t('home.trivia.mostWins', { name: topWinner[0], count: topWinner[1] }) });
    }
  }

  // 5. Total games played this year.
  if (yearGameIds.size >= 3) {
    list.push({ icon: '📅', text: t('home.trivia.gamesThisYear', { count: yearGameIds.size }) });
  }

  // 6. Unique players this year.
  const uniquePlayers = new Set(yearGP.map(gp => gp.playerName));
  if (uniquePlayers.size >= 5) {
    list.push({ icon: '👥', text: t('home.trivia.uniquePlayers', { count: uniquePlayers.size }) });
  }

  // 7. Most popular location this year.
  const locationCounts = new Map<string, number>();
  for (const g of games) {
    if (g.status !== 'completed') continue;
    if (new Date(g.date).getTime() < yearStart) continue;
    if (!g.location) continue;
    locationCounts.set(g.location, (locationCounts.get(g.location) ?? 0) + 1);
  }
  const topLocation = [...locationCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topLocation && topLocation[1] >= 3) {
    list.push({
      icon: '📍',
      text: t('home.trivia.popularLocation', { location: topLocation[0], count: topLocation[1] }),
    });
  }

  // 8. Longest active win streak — recently-active players only.
  let streakLeader = { name: '', streak: 0 };
  for (const ps of playerStats) {
    if (!recentPlayerNames.has(ps.playerName)) continue;
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

  // 9. Most rebuys ever in a single game this year.
  let mostRebuys = { name: '', count: 0 };
  for (const gp of yearGP) {
    if (gp.rebuys > mostRebuys.count) mostRebuys = { name: gp.playerName, count: gp.rebuys };
  }
  if (mostRebuys.count >= 4) {
    list.push({
      icon: '🔁',
      text: t('home.trivia.mostRebuysSingle', { count: mostRebuys.count, name: mostRebuys.name }),
    });
  }

  // 10. Total rebuys this year.
  let totalRebuys = 0;
  for (const gp of yearGP) totalRebuys += gp.rebuys;
  if (totalRebuys >= 30) {
    list.push({ icon: '🎰', text: t('home.trivia.totalRebuys', { count: totalRebuys }) });
  }

  // 11. Biggest 1st-vs-2nd gap in a single game this year.
  let biggestMargin = { winner: '', runnerUp: '', margin: 0 };
  for (const gameId of yearGameIds) {
    const players = playersByGame.get(gameId);
    if (!players || players.length < 2) continue;
    const sorted = [...players].sort((a, b) => b.profit - a.profit);
    const margin = sorted[0].profit - sorted[1].profit;
    if (margin > biggestMargin.margin) {
      biggestMargin = {
        winner: sorted[0].playerName,
        runnerUp: sorted[1].playerName,
        margin,
      };
    }
  }
  if (biggestMargin.margin > 100) {
    list.push({
      icon: '🚀',
      text: t('home.trivia.biggestMargin', {
        margin: formatCurrency(biggestMargin.margin),
        winner: biggestMargin.winner,
        runnerUp: biggestMargin.runnerUp,
      }),
    });
  }

  // 12. Total chips moved across the year. Profits sum to zero so the
  //     absolute sum is double the total movement; halve to express the
  //     actual net amount that changed hands.
  let absSum = 0;
  for (const gp of yearGP) absSum += Math.abs(gp.profit);
  const moved = Math.round(absSum / 2);
  if (moved > 0) {
    list.push({ icon: '💰', text: t('home.trivia.chipsMoved', { amount: formatCurrency(moved) }) });
  }

  // ── 13. Biggest single win / loss ALL-TIME (across every year).
  //         playerStats already aggregates this per player, so we just
  //         pick the leaders. Lower thresholds than the year-scoped
  //         entries (#1, #2) because the all-time pool is bigger and
  //         the "ever" framing is the headline value.
  let biggestEver = { name: '', profit: 0 };
  let worstEver = { name: '', loss: 0 };
  for (const ps of playerStats) {
    if (ps.biggestWin > biggestEver.profit) biggestEver = { name: ps.playerName, profit: ps.biggestWin };
    if (ps.biggestLoss < worstEver.loss) worstEver = { name: ps.playerName, loss: ps.biggestLoss };
  }
  if (biggestEver.profit > biggest.profit) {
    // Only surface "ever" when it's larger than the year-scoped record;
    // otherwise the two entries would be redundant.
    list.push({
      icon: '🏅',
      text: t('home.trivia.biggestWinAllTime', { profit: formatCurrency(biggestEver.profit), name: biggestEver.name }),
    });
  }
  if (worstEver.loss < worst.loss && worstEver.loss < -50) {
    list.push({
      icon: '🥶',
      text: t('home.trivia.biggestLossAllTime', { amount: formatCurrency(Math.abs(worstEver.loss)), name: worstEver.name }),
    });
  }

  // ── 14. Most popular day of week THIS YEAR. Surfaces the group's
  //         de-facto poker night (Sat for one group, Thu for another,
  //         etc.). Only relevant once we have enough games to make the
  //         distribution meaningful.
  if (yearGameIds.size >= 4) {
    const dayCounts = [0, 0, 0, 0, 0, 0, 0]; // Sun..Sat
    for (const gameId of yearGameIds) {
      const g = games.find(gg => gg.id === gameId);
      if (!g) continue;
      const d = new Date(g.date);
      if (!Number.isNaN(d.getTime())) dayCounts[d.getDay()]++;
    }
    let topDayIdx = 0;
    for (let i = 1; i < dayCounts.length; i++) {
      if (dayCounts[i] > dayCounts[topDayIdx]) topDayIdx = i;
    }
    if (dayCounts[topDayIdx] >= 3) {
      const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
      const dayLabel = t(`home.trivia.dayOfWeek.${dayKeys[topDayIdx]}`);
      list.push({
        icon: '🌙',
        text: t('home.trivia.popularDay', { day: dayLabel, count: dayCounts[topDayIdx] }),
      });
    }
  }

  // ── 15. Average players per game THIS YEAR. Useful for sizing
  //         conversations ("we usually run 7-8") and surfaces a
  //         non-obvious aggregate.
  if (yearGameIds.size >= 3) {
    const avg = yearGP.length / yearGameIds.size;
    if (avg > 0) {
      // One decimal — "7" feels like an exact target while "7.3"
      // signals "averaged across many games", which is the point.
      const rounded = Math.round(avg * 10) / 10;
      list.push({
        icon: '🎲',
        text: t('home.trivia.avgGameSize', { avg: rounded.toFixed(1) }),
      });
    }
  }

  // ── 16. Closest podium THIS YEAR (smallest 1st-vs-2nd gap). Inverse
  //         of #11. Surfaces the game where the title was most contested.
  //         Only interesting if the gap is genuinely tight (≤ 30).
  if (yearGameIds.size >= 3) {
    let closestPodium: { winner: string; runnerUp: string; margin: number } | null = null;
    for (const gameId of yearGameIds) {
      const players = playersByGame.get(gameId);
      if (!players || players.length < 2) continue;
      const sorted = [...players].sort((a, b) => b.profit - a.profit);
      // Skip games where 1st didn't actually win (everyone net negative,
      // or 2nd ≥ 1st via tie). The "podium" framing only makes sense
      // when the winner did win.
      if (sorted[0].profit <= 0) continue;
      const margin = sorted[0].profit - sorted[1].profit;
      if (closestPodium === null || margin < closestPodium.margin) {
        closestPodium = {
          winner: sorted[0].playerName,
          runnerUp: sorted[1].playerName,
          margin,
        };
      }
    }
    if (closestPodium && closestPodium.margin > 0 && closestPodium.margin <= 30) {
      list.push({
        icon: '⚔️',
        text: t('home.trivia.closestPodium', {
          margin: formatCurrency(closestPodium.margin),
          winner: closestPodium.winner,
          runnerUp: closestPodium.runnerUp,
        }),
      });
    }
  }

  // ── 17. Most 2nd-place finishes THIS YEAR. The "always-the-bridesmaid"
  //         award. Counted across games where the player came 2nd (and
  //         1st actually won — same guard as #16).
  if (yearGameIds.size >= 4) {
    const secondPlaceCounts = new Map<string, number>();
    for (const gameId of yearGameIds) {
      const players = playersByGame.get(gameId);
      if (!players || players.length < 2) continue;
      const sorted = [...players].sort((a, b) => b.profit - a.profit);
      if (sorted[0].profit <= 0) continue; // no real winner
      const runnerUp = sorted[1];
      secondPlaceCounts.set(runnerUp.playerName, (secondPlaceCounts.get(runnerUp.playerName) ?? 0) + 1);
    }
    const top2nd = [...secondPlaceCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top2nd && top2nd[1] >= 2) {
      list.push({
        icon: '🥈',
        text: t('home.trivia.mostSecondPlaces', { name: top2nd[0], count: top2nd[1] }),
      });
    }
  }

  // ── 18. Longest losing streak among RECENTLY-ACTIVE players. Mirror
  //         of #8 (streak leader). Only surface for someone who's
  //         actually around to redeem themselves — a frozen 5-game
  //         losing streak from a player who quit two years ago is
  //         demoralizing trivia.
  let lossStreakLeader = { name: '', streak: 0 };
  for (const ps of playerStats) {
    if (!recentPlayerNames.has(ps.playerName)) continue;
    if (ps.longestLossStreak > lossStreakLeader.streak) {
      lossStreakLeader = { name: ps.playerName, streak: ps.longestLossStreak };
    }
  }
  if (lossStreakLeader.streak >= 3) {
    list.push({
      icon: '🥶',
      text: t('home.trivia.longestLossStreak', { name: lossStreakLeader.name, n: lossStreakLeader.streak }),
    });
  }

  // ── 19. Biggest single-game profit swing THIS YEAR. The gap between
  //         the night's biggest winner and biggest loser (= max - min).
  //         Tells the "wildest night" story.
  let biggestSwing = 0;
  for (const gameId of yearGameIds) {
    const players = playersByGame.get(gameId);
    if (!players || players.length < 2) continue;
    let mx = -Infinity, mn = Infinity;
    for (const p of players) {
      if (p.profit > mx) mx = p.profit;
      if (p.profit < mn) mn = p.profit;
    }
    const swing = mx - mn;
    if (swing > biggestSwing) biggestSwing = swing;
  }
  if (biggestSwing >= 200) {
    list.push({ icon: '🎢', text: t('home.trivia.biggestSwing', { amount: formatCurrency(biggestSwing) }) });
  }

  // ── 20. Newest player to join the group. Find each player's earliest
  //         game appearance across all-time data; the most recent
  //         "earliest appearance" is the freshest joiner. Only
  //         surface within a 90-day welcome window — after that the
  //         "newest" framing stops being interesting.
  let newest: { name: string; firstGameMs: number } | null = null;
  const firstSeen = new Map<string, number>();
  for (const gp of gamePlayers) {
    const g = games.find(gg => gg.id === gp.gameId);
    if (!g || g.status !== 'completed') continue;
    const ts = new Date(g.date).getTime();
    if (Number.isNaN(ts)) continue;
    const prev = firstSeen.get(gp.playerName);
    if (prev === undefined || ts < prev) firstSeen.set(gp.playerName, ts);
  }
  for (const [name, ts] of firstSeen) {
    if (newest === null || ts > newest.firstGameMs) newest = { name, firstGameMs: ts };
  }
  if (newest) {
    const daysAgo = Math.floor((Date.now() - newest.firstGameMs) / 86_400_000);
    if (daysAgo >= 1 && daysAgo <= 90 && firstSeen.size >= 4) {
      list.push({ icon: '🌟', text: t('home.trivia.newestPlayer', { name: newest.name, days: daysAgo }) });
    }
  }

  // ── 21. Best win rate THIS YEAR (≥ 3 games to qualify, so randos
  //         with one lucky win don't crown themselves). Computed from
  //         this-year participation only — the all-time win-rate
  //         leaderboard already lives in /statistics.
  if (yearGameIds.size >= 4) {
    const stats = new Map<string, { wins: number; games: number }>();
    for (const gameId of yearGameIds) {
      const players = playersByGame.get(gameId);
      if (!players || players.length === 0) continue;
      let winner = players[0];
      for (const p of players) if (p.profit > winner.profit) winner = p;
      for (const p of players) {
        const e = stats.get(p.playerName) ?? { wins: 0, games: 0 };
        e.games++;
        if (p.playerName === winner.playerName && winner.profit > 0) e.wins++;
        stats.set(p.playerName, e);
      }
    }
    let topRate = { name: '', pct: 0, games: 0 };
    for (const [name, e] of stats) {
      if (e.games < 3) continue;
      const pct = (e.wins / e.games) * 100;
      if (pct > topRate.pct) topRate = { name, pct, games: e.games };
    }
    if (topRate.pct >= 30) {
      list.push({
        icon: '🎯',
        text: t('home.trivia.bestWinRate', {
          name: topRate.name,
          pct: Math.round(topRate.pct),
          games: topRate.games,
        }),
      });
    }
  }

  // ── 22. Total games ALL-TIME. Cute headline number for older groups.
  //         Threshold prevents it from showing for fresh groups where
  //         year-count and all-time count are identical and the line
  //         would feel redundant.
  const allTimeGameCount = games.filter(g => g.status === 'completed').length;
  if (allTimeGameCount > yearGameIds.size && allTimeGameCount >= 10) {
    list.push({
      icon: '📚',
      text: t('home.trivia.totalAllTimeGames', { count: allTimeGameCount }),
    });
  }

  return list;
}

// ─── 6. Training ────────────────────────────────────────────────────────

interface TrainingCardProps extends SectionProps {
  playerName: string | null;
  stats: PlayerStats | null;
  onClick: () => void;
}

function TrainingCard({ order, step, t, playerName, stats, onClick }: TrainingCardProps) {
  // Pick a personalized message variant from a daily-rotating pool.
  // The variant `icon` is intentionally discarded here: keeping a
  // dynamic icon would clash with the static-icon convention every
  // other dashboard card follows, AND would risk visual collisions
  // with other cards that already use 🏆 / 🔥. The personalization
  // lives in the subtitle copy where it belongs.
  const { title: message, sub } = useMemo(
    () => buildTrainingMessage(playerName, stats),
    [playerName, stats],
  );
  const subtitle = sub ? `${message} · ${sub}` : message;

  // No accessory button — the whole card is clickable, which is the
  // app-wide pattern (Schedule, LastGame, Personal, Leaderboard all
  // navigate on tap, no side-buttons). Removing the button makes
  // this card structurally identical to its peers.
  return (
    <HomeCard
      order={order}
      step={step}
      icon="🧠"
      title={t('newGame.training')}
      subtitle={subtitle}
      onClick={onClick}
    />
  );
}

// Personalized training-banner copy. Picks a variant from a pool whose
// composition depends on the player's stats and training history. Keeps
// the same message for the whole calendar day so the banner doesn't
// flicker between renders.
function buildTrainingMessage(
  playerName: string | null,
  stats: PlayerStats | null,
): { icon: string; title: string; sub: string } {
  const tp = playerName ? getSharedProgress(playerName) : null;
  const hasTraining = !!tp && tp.totalQuestions > 0;
  const lastProfit = stats?.lastGameResults?.[0]?.profit ?? 0;
  const lastDate = stats?.lastGameResults?.[0]?.date;
  const daysSinceGame = lastDate
    ? Math.floor((Date.now() - new Date(lastDate).getTime()) / (1000 * 60 * 60 * 24))
    : null;
  const last3 = stats?.lastGameResults?.slice(0, 3) || [];
  const last3Avg = last3.length >= 3 ? last3.reduce((s, g) => s + g.profit, 0) / last3.length : null;
  const acc = hasTraining && tp ? Math.round((tp.totalCorrect / tp.totalQuestions) * 100) : 0;
  // Total questions answered = scored (correct + wrong) + neutralized.
  // tp.totalQuestions is scored-only, so the casual "X שאלות באימונים"
  // would otherwise be lower than the leaderboard's "ענו" column.
  const totalAnsweredQs = tp ? tp.totalQuestions + (tp.totalNeutral || 0) : 0;

  // Daily seed: changes once per day, not per render.
  const daySeed = Math.floor(Date.now() / (1000 * 60 * 60 * 24));
  const pick = <T,>(arr: T[]): T => arr[(daySeed + (playerName?.length || 0)) % arr.length];

  type Msg = { icon: string; title: string; sub: string };
  const msgs: Msg[] = [];
  const n = playerName || '';
  const wp = stats ? Math.round(stats.winPercentage) : 0;
  const signed = (v: number) => `${v >= 0 ? '\u200E+' : '\u200E'}${cleanNumber(v)}`;

  if (hasTraining && tp && stats) {
    if (daysSinceGame !== null && daysSinceGame >= 21) {
      const weeks = Math.floor(daysSinceGame / 7);
      msgs.push({ icon: '⏰', title: `${n}, ${weeks} שבועות בלי משחק`, sub: `${acc}% דיוק · ${totalAnsweredQs} שאלות — תתחמם באימון` });
      msgs.push({ icon: '🔔', title: `${n}, מתגעגעים לשולחן?`, sub: `${acc}% דיוק באימונים · ${formatCurrency(stats.totalProfit)} סה"כ` });
    }
    if (tp.streak.current >= 3) {
      msgs.push({ icon: '🔥', title: `${n}, רצף ${tp.streak.current} ימים!`, sub: `${acc}% דיוק · סה"כ ${formatCurrency(stats.totalProfit)} במשחקים` });
    }
    if (acc < 45) {
      msgs.push({ icon: '💪', title: `${n}, ${acc}% דיוק — יש מה לשפר`, sub: `שיא הפסד ${formatCurrency(Math.abs(stats.biggestLoss))} · ${totalAnsweredQs} שאלות` });
    }
    if (acc >= 70) {
      msgs.push({ icon: '🏆', title: `${n}, ${acc}% דיוק — האימון עובד`, sub: `שיא רווח ${formatCurrency(stats.biggestWin)} · סה"כ ${formatCurrency(stats.totalProfit)}` });
    }
    if (stats.currentStreak < 0) {
      msgs.push({ icon: '🔥', title: `${n}, ${Math.abs(stats.currentStreak)} הפסדים ברצף`, sub: `${acc}% דיוק · ${totalAnsweredQs} שאלות — תמשיך להתאמן` });
    }
    msgs.push({ icon: '⚡', title: `${n}, ${acc}% דיוק · ${wp}% נצחונות`, sub: `${tp.sessionsCompleted} אימונים · ממוצע ${formatCurrency(stats.avgProfit)} למשחק` });
    msgs.push({ icon: '💪', title: `${n}, ${totalAnsweredQs} שאלות באימונים`, sub: `סה"כ ${formatCurrency(stats.totalProfit)} · ${stats.gamesPlayed} משחקים` });
  } else if (hasTraining && tp) {
    if (tp.streak.current >= 3) {
      msgs.push({ icon: '🔥', title: `${n}, רצף ${tp.streak.current} ימים!`, sub: `${acc}% דיוק · ${totalAnsweredQs} שאלות` });
    }
    if (acc >= 70) {
      msgs.push({ icon: '🏆', title: `${n}, ${acc}% דיוק — אתה חד`, sub: `${tp.sessionsCompleted} אימונים · ${totalAnsweredQs} שאלות` });
    }
    msgs.push({ icon: '💪', title: `${n}, ${acc}% דיוק`, sub: `${totalAnsweredQs} שאלות · ${tp.sessionsCompleted} אימונים` });
    msgs.push({ icon: '⚡', title: `${n}, ${tp.sessionsCompleted} אימונים עד עכשיו`, sub: `${acc}% דיוק · ${totalAnsweredQs} שאלות` });
  } else if (stats && stats.gamesPlayed > 0) {
    if (daysSinceGame !== null && daysSinceGame >= 21) {
      const weeks = Math.floor(daysSinceGame / 7);
      msgs.push({ icon: '⏰', title: `${n}, ${weeks} שבועות בלי משחק`, sub: `סה"כ ${signed(stats.totalProfit)} · ${wp}% נצחונות` });
      msgs.push({ icon: '🔔', title: `${n}, חזרת! בוא נתאמן`, sub: `${stats.gamesPlayed} משחקים · ממוצע ${signed(stats.avgProfit)} למשחק` });
    }
    if (stats.currentStreak <= -3) {
      msgs.push({ icon: '🔥', title: `${n}, ${Math.abs(stats.currentStreak)} הפסדים ברצף`, sub: `סה"כ ${signed(stats.totalProfit)} · ${wp}% נצחונות` });
    }
    if (lastProfit < -100) {
      msgs.push({ icon: '💪', title: `${n}, הפסדת ${cleanNumber(Math.abs(lastProfit))}`, sub: `ממוצע ${signed(stats.avgProfit)} למשחק · ${stats.gamesPlayed} משחקים` });
    }
    if (lastProfit < 0 && lastProfit >= -100) {
      msgs.push({ icon: '💪', title: `${n}, הפסדת ${cleanNumber(Math.abs(lastProfit))}`, sub: `סה"כ ${signed(stats.totalProfit)} · ${wp}% נצחונות` });
    }
    if (last3Avg !== null && last3Avg < -50) {
      msgs.push({ icon: '⚡', title: `${n}, ממוצע ${signed(Math.round(last3Avg))} ב-3 אחרונים`, sub: `${wp}% נצחונות · סה"כ ${signed(stats.totalProfit)}` });
    }
    if (stats.winPercentage < 40 && stats.gamesPlayed >= 5) {
      msgs.push({ icon: '🔥', title: `${n}, רק ${wp}% נצחונות`, sub: `סה"כ ${signed(stats.totalProfit)} · ממוצע ${signed(stats.avgProfit)} למשחק` });
    }
    if (lastProfit > 100) {
      msgs.push({ icon: '🏆', title: `${n}, ניצחת ${signed(lastProfit)}!`, sub: `שיא ${signed(stats.biggestWin)} · ${stats.winCount} נצחונות` });
    }
    if (Math.abs(lastProfit) <= 100) {
      msgs.push({ icon: '⚡', title: `${n}, סיימת בלי רווח`, sub: `ממוצע ${signed(stats.avgProfit)} למשחק · ${stats.gamesPlayed} משחקים` });
    }
    msgs.push({ icon: '💪', title: `${n}, ${stats.gamesPlayed} משחקים`, sub: `${wp}% נצחונות · ממוצע ${signed(stats.avgProfit)} למשחק` });
    if (stats.biggestWin > 0) {
      msgs.push({ icon: '🏆', title: `${n}, שיא רווח ${signed(stats.biggestWin)}`, sub: `${wp}% נצחונות · ${stats.gamesPlayed} משחקים` });
    }
    if (stats.totalProfit < 0) {
      msgs.push({ icon: '🔥', title: `${n}, סה"כ ${signed(stats.totalProfit)}`, sub: `${stats.lossCount} הפסדים · ממוצע ${signed(stats.avgProfit)} למשחק` });
    }
    if (stats.totalProfit > 0) {
      msgs.push({ icon: '🏆', title: `${n}, סה"כ ${signed(stats.totalProfit)} ברווח`, sub: `${stats.winCount} נצחונות · שיא ${signed(stats.biggestWin)}` });
    }
    if (stats.longestWinStreak >= 2) {
      msgs.push({ icon: '🔥', title: `${n}, רצף של ${stats.longestWinStreak} נצחונות`, sub: `${wp}% נצחונות · סה"כ ${signed(stats.totalProfit)}` });
    }
  } else if (playerName) {
    msgs.push({ icon: '✨', title: `${n}, מוכן לאימון ראשון?`, sub: '' });
    msgs.push({ icon: '🔥', title: `${n}, בוא נתחיל להתאמן`, sub: '' });
  }

  if (msgs.length === 0) {
    msgs.push({ icon: '🔥', title: 'אימון פוקר', sub: 'תרגל ושפר את המשחק שלך' });
  }

  return pick(msgs);
}

// ─── Pill ───────────────────────────────────────────────────────────────

function Pill({ text, tone }: { text: string; tone: 'success' | 'info' }) {
  const palette = tone === 'success'
    ? { bg: 'rgba(16, 185, 129, 0.18)', fg: WIN_COLOR, border: 'rgba(16, 185, 129, 0.4)' }
    : { bg: 'rgba(99, 102, 241, 0.16)', fg: '#a5b4fc', border: 'rgba(99, 102, 241, 0.4)' };
  return (
    <span style={{
      fontSize: '0.65rem', fontWeight: 700,
      padding: '2px 8px', borderRadius: 999,
      background: palette.bg,
      color: palette.fg,
      border: `1px solid ${palette.border}`,
      whiteSpace: 'nowrap',
    }}>
      {text}
    </span>
  );
}

// ─── useCountUp ─────────────────────────────────────────────────────────

// Animate from 0 to `target` on first mount only. Subsequent target
// changes (e.g. realtime cache update) snap immediately to the new
// value to avoid jumpy re-animations on every cache event.
function useCountUp(target: number, duration = 700): number {
  const [value, setValue] = useState(0);
  const animatedRef = useRef(false);

  useEffect(() => {
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
