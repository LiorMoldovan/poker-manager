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
import type { PlayerStats, TrainingPlayerData } from '../types';
import { getAllPolls, getAllGames, getAllGamePlayers, getAllPlayers, linkPollToGame } from '../database/storage';
import { getGroupId, initSupabaseCache } from '../database/supabaseCache';
import { fetchTrainingAnswers } from '../database/trainingData';
import { formatCurrency, cleanNumber } from '../utils/calculations';
import { useTranslation, type TranslationKey, type Language } from '../i18n';
import { hapticTap } from '../utils/haptics';
import { getSharedProgress } from '../utils/pokerTraining';
import { verbForName } from '../utils/hebrewGender';
import { usePermissions } from '../App';

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
const ME_NAME_COLOR = '#60a5fa';

// Profit tints, reused across cards to keep wins / losses uniform.
const WIN_COLOR = '#10b981';
const LOSS_COLOR = '#ef4444';

// ─── HomeDashboard ──────────────────────────────────────────────────────

// ── Pull-to-refresh hook ──────────────────────────────────────
//
// Implements the standard mobile gesture (drag down from the top of
// the page → release → refresh). Stays a no-op on desktop because
// `touchstart` doesn't fire from mouse events.
//
// Implementation notes:
// - We register listeners on `document` with `passive: true`. Native
//   scrolling continues to work; we never preventDefault. The
//   gesture only "engages" when the page is already scrolled to the
//   top — otherwise the listener returns immediately so it doesn't
//   interfere with normal scrolling at any depth of the page.
// - Damping (delta * 0.5) and a 120 px cap keep the indicator from
//   feeling rubbery while still giving haptic-feeling resistance.
// - Trigger threshold is 60 px — far enough to be intentional, near
//   enough to be reachable without an awkward thumb stretch.
// - Live values (touch start Y, current distance, refreshing state)
//   are kept in refs so the effect doesn't re-subscribe on every
//   pixel of pull, while React-state mirrors are used only to
//   drive re-renders of the indicator.
function usePullToRefresh(onRefresh: () => Promise<void>): { distance: number; refreshing: boolean } {
  const [distance, setDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const startY = useRef<number | null>(null);
  const distanceRef = useRef(0);
  const refreshingRef = useRef(false);

  // Mirror state into refs so async event handlers always read the
  // current value without needing the effect to re-attach when state
  // changes (which would otherwise rip out and re-bind the touch
  // listeners constantly during a pull).
  useEffect(() => { refreshingRef.current = refreshing; }, [refreshing]);

  useEffect(() => {
    const isAtTop = (): boolean => {
      const docTop = (document.scrollingElement?.scrollTop ?? document.documentElement.scrollTop) || 0;
      return window.scrollY <= 0 && docTop <= 0;
    };

    const setDist = (d: number): void => {
      distanceRef.current = d;
      setDistance(d);
    };

    const onTouchStart = (e: TouchEvent): void => {
      if (refreshingRef.current) return;
      if (!isAtTop()) return;
      startY.current = e.touches[0].clientY;
    };

    const onTouchMove = (e: TouchEvent): void => {
      if (startY.current === null) return;
      if (refreshingRef.current) return;
      const delta = e.touches[0].clientY - startY.current;
      // User started pulling but is now moving up (cancelling the
      // gesture) → reset the indicator without releasing the touch
      // tracker; if they pull down again we can resume.
      if (delta <= 0) {
        if (distanceRef.current !== 0) setDist(0);
        return;
      }
      // If they scrolled away from the top while still touching,
      // abort the gesture — pull-to-refresh should never compete
      // with a normal upward scroll.
      if (!isAtTop()) {
        startY.current = null;
        setDist(0);
        return;
      }
      setDist(Math.min(delta * 0.5, 120));
    };

    const onTouchEnd = async (): Promise<void> => {
      if (startY.current === null) return;
      const finalDist = distanceRef.current;
      startY.current = null;
      setDist(0);
      if (finalDist >= 60 && !refreshingRef.current) {
        setRefreshing(true);
        try {
          await onRefresh();
        } catch (err) {
          console.error('[pull-to-refresh] failed:', err);
        } finally {
          setRefreshing(false);
        }
      }
    };

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    document.addEventListener('touchcancel', onTouchEnd, { passive: true });

    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [onRefresh]);

  return { distance, refreshing };
}

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
  // Observer mode (super admin browsing a non-member group): suppress
  // personal framing on the schedule card. The synthetic playerName
  // ("👁 Super Admin") doesn't match any player record, so the
  // existing flow would render "👁 Super Admin, מחכים להצבעה שלך" —
  // a vote nudge for someone who can't actually vote in this group.
  // Falling back to playerName=null routes ScheduleCard to its
  // generic title path (`home.schedule.openTitle`).
  const { multiGroup } = usePermissions();
  const isObserver = multiGroup?.isObservingNonMember ?? false;
  const effectivePlayerName = isObserver ? null : playerName;

  // ── Pull-to-refresh ─────────────────────────────────────────
  // Mobile users sometimes hear about a new poll/vote/result from a
  // friend before our realtime subscription has fanned the change
  // out. Rather than asking them to leave + re-enter the dashboard
  // we expose the standard mobile "pull from the top" gesture to
  // force a cache refresh. Desktop users never trigger it (no touch
  // events) and the indicator is invisible until pulled, so this
  // adds zero clutter to the page.
  const { distance: pullDistance, refreshing: pullRefreshing } = usePullToRefresh(async () => {
    const gid = getGroupId();
    if (!gid) return;
    await initSupabaseCache(gid);
    // initSupabaseCache dispatches `supabase-cache-updated` on every
    // phase, so the parent's `useRealtimeRefresh` listener will
    // re-render the dashboard automatically.
  });

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
  // `!p.confirmedGameId` is the single source of truth — once a poll
  // is linked to its game, the card disappears from Home regardless
  // of how the admin started the game (poll button OR regular flow).
  // The auto-link effect below maintains this invariant.
  //
  // Past-dated polls are filtered out (matches ScheduleTab's archive
  // rule). Without this guard, an admin who opens a single-date poll
  // and never starts the game leaves an "open" poll lingering in the
  // DB after its only proposed date passes — ScheduleTab archives it
  // (no "active poll" message) but Home was still surfacing it as a
  // vote prompt, which contradicted the schedule view AND nagged
  // users about a vote on a date that has already passed.
  const activePoll = useMemo(() => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayStartTs = todayStart.getTime();
    const isPastDated = (p: typeof polls[number]): boolean => {
      if (!p.dates || p.dates.length === 0) return false;
      let latestEod = 0;
      for (const d of p.dates) {
        if (!d.proposedDate) continue;
        const ts = new Date(`${d.proposedDate}T23:59:59`).getTime();
        if (Number.isNaN(ts)) continue;
        if (ts > latestEod) latestEod = ts;
      }
      if (latestEod === 0) return false;
      return latestEod < todayStartTs;
    };
    return (
      polls.find(p => p.status === 'confirmed' && !p.confirmedGameId && !isPastDated(p))
      ?? polls.find(p => (p.status === 'open' || p.status === 'expanded') && !isPastDated(p))
      ?? null
    );
  }, [polls]);


  // Self-healing link: any confirmed poll without a confirmed_game_id
  // gets matched against completed games by start time (±6 hours). When
  // the admin started the game from the regular New Game flow instead
  // of the poll's "Start Scheduled Game" button, the linkage step in
  // `startGameWithForecast` was skipped (it depends on a UI ref that
  // wasn't set), leaving the poll orphaned and the home card stuck.
  // Running here means: the moment the admin returns to the dashboard
  // after completing such a game, we backfill the link, the realtime
  // cache refreshes, and the card disappears on its own. Admin-only
  // because `link_poll_to_game` requires admin role server-side; the
  // RPC is idempotent (`WHERE confirmed_game_id IS NULL`) so retries
  // and concurrent dashboard mounts are safe.
  // The `inFlightLinksRef` set dedupes the brief window between the
  // RPC firing and the realtime cache update — without it, a quick
  // re-render (e.g. the user clicks something else on the dashboard)
  // would re-trigger the same RPC for the same orphan poll multiple
  // times. Pure local-state hygiene; the server is already idempotent.
  const inFlightLinksRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!isAdmin) return;
    const orphans = polls.filter(p => p.status === 'confirmed' && !p.confirmedGameId);
    if (orphans.length === 0) return;
    const SIX_H_MS = 6 * 60 * 60 * 1000;
    const completedGames = allGames.filter(g => g.status === 'completed');
    for (const poll of orphans) {
      if (inFlightLinksRef.current.has(poll.id)) continue;
      const date = poll.dates.find(d => d.id === poll.confirmedDateId);
      if (!date?.proposedDate) continue;
      const pollStartMs = new Date(`${date.proposedDate}T${date.proposedTime || '20:00'}`).getTime();
      if (Number.isNaN(pollStartMs)) continue;
      const match = completedGames.find(g => Math.abs(new Date(g.date).getTime() - pollStartMs) <= SIX_H_MS);
      if (!match) continue;
      inFlightLinksRef.current.add(poll.id);
      linkPollToGame(poll.id, match.id)
        .catch(err => {
          inFlightLinksRef.current.delete(poll.id); // allow retry on next render
          console.warn('home: auto-link orphan poll → game failed (will retry next mount)', err);
        });
    }
  }, [polls, allGames, isAdmin]);

  const lastGame = useMemo(() => {
    const completed = allGames
      .filter(g => g.status === 'completed')
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return completed[0] ?? null;
  }, [allGames]);

  // Training engagement data, loaded async so it doesn't block the
  // initial dashboard render. Used by TriviaCard to surface
  // group-wide practice facts ("X answered N questions", "accuracy
  // champion is Y", "M questions answered in this group", etc.).
  // Empty array until the fetch resolves — TriviaCard treats it as
  // "no training facts to show yet" and just skips those entries,
  // so the rest of the trivia pool keeps rendering without delay.
  const [trainingPlayers, setTrainingPlayers] = useState<TrainingPlayerData[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchTrainingAnswers()
      .then(file => {
        if (!cancelled && file) setTrainingPlayers(file.players);
      })
      .catch(err => {
        // Non-fatal: trivia card just skips training facts on
        // failure. Logged so the F12 console still shows the cause.
        console.warn('home: fetchTrainingAnswers failed (trivia training facts will be skipped)', err);
      });
    return () => { cancelled = true; };
  }, []);

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

  // Always land on the Schedule tab itself — never auto-open the
  // create-poll modal. The previous shortcut (admin + no active poll
  // → `?action=create-poll`) was a UX mismatch with the empty card's
  // teaser copy ("מי בפנים? ההצבעה הבאה תיפתח בקרוב — לחצו לצפייה
  // בלוח הזמנים"): the user reasonably expects to *see* the schedule,
  // not to be dropped straight into a write-action modal that
  // members can't use anyway. Admins who do want to start a new poll
  // tap the `+` button on the Schedule tab itself — one extra tap,
  // worth it for predictable navigation.
  const goSchedule = () => {
    hapticTap();
    navigate('/settings?tab=schedule');
  };
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
      {/* Pull-to-refresh indicator. Sits at the top of the dashboard
          and renders only while the user is actively pulling or a
          refresh is in flight. Centred, low-contrast, intentionally
          unobtrusive — it should feel like a hint rather than a
          piece of UI. The icon rotates with the pull distance to
          give immediate feedback that the gesture is being read,
          and spins continuously while the cache reload is running. */}
      {(pullDistance > 0 || pullRefreshing) && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: pullRefreshing ? 44 : Math.min(pullDistance, 80),
          transition: pullRefreshing ? 'height 0.18s ease-out' : 'none',
          color: 'var(--text-muted)',
          pointerEvents: 'none',
          fontSize: '1.25rem',
        }}>
          <span style={{
            display: 'inline-block',
            opacity: pullRefreshing ? 1 : Math.min(pullDistance / 60, 1),
            transform: pullRefreshing ? undefined : `rotate(${Math.min(pullDistance * 3, 360)}deg)`,
            animation: pullRefreshing ? 'spin 0.8s linear infinite' : undefined,
          }}>
            ↻
          </span>
        </div>
      )}
      {showAdminCta && <StartNewGameCta order={next()} step={STEP} t={t} onClick={goNewGame} />}
      <ScheduleCard
        order={next()}
        step={STEP}
        t={t}
        poll={activePoll}
        myPlayerId={myStats?.playerId ?? null}
        playerName={effectivePlayerName}
        onClick={goSchedule}
      />
      {/* Brand-new group teaser — only renders when zero games have
          been completed. Sits right after the Schedule card so the
          poll teaser (if any) stays the primary CTA, and the
          "what's coming" preview reinforces it instead of competing
          with it. Disappears automatically after the first completed
          game, which is exactly when the LastGame / Personal /
          Leaderboard cards start carrying real content of their
          own. */}
      {!allGames.some(g => g.status === 'completed') && (
        <NewGroupTeaserCard order={next()} step={STEP} t={t} />
      )}
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
        trainingPlayers={trainingPlayers}
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
  // Accent colors map to game-situation states so the card reads at
  // a glance:
  //   'default'  → neutral surface, no tint
  //   'success'  → green, used for "good thing ahead" (StartNewGame
  //                CTA, confirmed game with seats filled)
  //   'warning'  → amber, used for "needs your attention" (confirmed
  //                game still missing players, recruitment ask)
  //   'info'     → blue, used for "decision pending" (open poll
  //                awaiting votes)
  // We intentionally do NOT tie accent to "today vs tomorrow"
  // urgency — that's already conveyed by the countdown pill, and a
  // red card every game-day would be visually exhausting.
  accent?: 'default' | 'success' | 'warning' | 'info';
  onClick?: () => void;
  as?: 'div' | 'button';
  // How many lines the subtitle is allowed to occupy before
  // ellipsis-clipping. Defaults to 2 — the safe cap for free-form
  // text like a long location or trivia line.
  //
  // Cards whose subtitle is composed of MULTIPLE structured nowrap
  // segments (e.g. the LastGame card: date · winner · place · profit)
  // MUST pass `0` to disable the clamp entirely. Critical reason:
  // JSX strips whitespace between sibling elements, so when the
  // segments are sibling `<span>`s with `whiteSpace: 'nowrap'` and
  // no whitespace text node between them, CSS has NO soft-wrap
  // opportunity between the spans — they all flow on a single line
  // and overflow horizontally past the card edge in RTL. The clamp
  // mode (`-webkit-box` + `overflow: hidden`) silently clips that
  // horizontal overflow, so the user just sees the trailing segment
  // disappear with no visible cue (no ellipsis, no scroll). When
  // clamp is `0`, the subtitle uses `flex; flex-wrap: wrap` instead
  // so each child segment becomes its own flex item with a
  // guaranteed wrap point between them.
  subtitleClamp?: number;
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
  subtitleClamp = 2,
}: HomeCardProps) {
  const accentStyle: React.CSSProperties = (() => {
    switch (accent) {
      case 'success':
        return {
          background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.18), rgba(16, 185, 129, 0.04))',
          border: '1px solid rgba(16, 185, 129, 0.42)',
        };
      case 'warning':
        return {
          background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.20), rgba(245, 158, 11, 0.04))',
          border: '1px solid rgba(245, 158, 11, 0.45)',
        };
      case 'info':
        return {
          background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.18), rgba(59, 130, 246, 0.04))',
          border: '1px solid rgba(59, 130, 246, 0.42)',
        };
      case 'default':
      default:
        return {
          background: 'var(--surface)',
          border: '1px solid transparent',
        };
    }
  })();

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
            // `flexWrap: 'wrap'` lets the accessory drop to a second
            // line on narrow screens (e.g. <360 px) when the title +
            // pills together would force the title to ellipsis-clip.
            // The title is the primary meaning of the card — clipping
            // it to fit pills is the worst trade-off. With wrap on,
            // both stay readable: title takes line 1, pills wrap to
            // line 2 right-aligned (in RTL flex order). When there's
            // enough room everything stays on a single line as
            // before, so desktop is unaffected.
            flexWrap: 'wrap',
            rowGap: '0.3rem',
          }}>
            <span style={{
              fontSize: TITLE_SIZE,
              fontWeight: TITLE_WEIGHT,
              color: 'var(--text)',
              minWidth: 0,
              // `flex: 1` claims any remaining space on the current
              // line — when the accessory fits beside it the title
              // grows to fill the gap, keeping the layout balanced;
              // when wrap kicks in the title gets a full-width line.
              flex: 1,
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
              ...(subtitleClamp > 0 ? {
                // Cap at N lines — used for free-form text where a
                // long line should be ellipsised rather than blow up
                // the card height.
                display: '-webkit-box',
                WebkitLineClamp: subtitleClamp,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              } : {
                // No clamp — used for structured multi-segment
                // subtitles. Flex-wrap guarantees a wrap point
                // between sibling segments so nowrap spans can't
                // overflow horizontally past the card edge on narrow
                // screens. See `subtitleClamp` prop docs for why
                // this matters.
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'baseline',
              }),
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

// ─── 1b. New-group teaser (zero completed games) ────────────────────────
//
// Renders ONLY in a brand-new group that has never completed a game.
// In that state the rest of the dashboard is sparse — LastGame /
// Personal / Leaderboard all gate on data and render nothing — leaving
// just a Schedule card + (optional) Trivia. This card fills the gap
// with a preview of what's coming, so users immediately understand
// what the home screen will look like once they start playing rather
// than seeing a near-empty page and wondering if the app works.
//
// Visible to ALL roles (member, admin, super admin) because the
// "what does this app do?" question applies to everyone in a fresh
// group, not just members. Disappears the moment the group's first
// game is marked completed.
function NewGroupTeaserCard({ order, step, t }: SectionProps) {
  const features: TranslationKey[] = [
    'home.newGroup.feature1',
    'home.newGroup.feature2',
    'home.newGroup.feature3',
    'home.newGroup.feature4',
  ];
  const body = (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: '0.35rem',
      paddingTop: '0.4rem',
      borderTop: '1px solid rgba(255,255,255,0.06)',
    }}>
      {features.map(key => (
        <div
          key={key}
          style={{
            fontSize: '0.78rem',
            color: 'var(--text)',
            opacity: 0.85,
            lineHeight: 1.45,
          }}
        >
          {t(key)}
        </div>
      ))}
    </div>
  );
  return (
    <HomeCard
      order={order}
      step={step}
      icon="🃏"
      title={t('home.newGroup.title')}
      subtitle={t('home.newGroup.subtitle')}
      accent="info"
      body={body}
    />
  );
}

// ─── 2. Schedule ────────────────────────────────────────────────────────

interface ScheduleCardProps extends SectionProps {
  poll: ReturnType<typeof getAllPolls>[number] | null;
  // The current viewer's linked playerId (NULL when the user hasn't
  // self-claimed a player yet). Used to detect whether *this* viewer
  // has cast a vote on the open poll, so the card can switch into a
  // personalized "your vote is waiting" nudge instead of showing
  // generic copy that any member sees regardless of state.
  myPlayerId: string | null;
  // Display name for the personalized title. Falls back to a generic
  // title when null.
  playerName: string | null;
  onClick: () => void;
}

function ScheduleCard({ order, step, t, poll, myPlayerId, playerName, onClick }: ScheduleCardProps) {
  if (!poll) {
    // Empty state is purely forward-looking — a teaser inviting the
    // viewer to come back when the next vote opens. We deliberately
    // do NOT mention the most recent past poker night here: the
    // LastGameCard directly below already surfaces that ("המשחק
    // האחרון: יום חמישי 7.5 · מנצח: …"), so duplicating it on this
    // card was redundant and made the dashboard read as backwards-
    // looking. Card click already routes to the schedule polls page,
    // so the CTA in the subtitle is honored.
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
    // Names of confirmed (yes-voting) players for the "מגיעים: …"
    // line below the date/location. Resolved from playerId via the
    // players cache so the order matches RSVP order, not name
    // alphabetisation — first to commit shows up first.
    let comingNames: string[] = [];

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
      const yesVotes = poll.votes.filter(v => v.dateId === poll.confirmedDateId && v.response === 'yes');
      missingSeats = Math.max(0, poll.targetPlayerCount - yesVotes.length);
      const playersById = new Map(getAllPlayers().map(p => [p.id, p.name]));
      comingNames = yesVotes
        .map(v => playersById.get(v.playerId))
        .filter((name): name is string => Boolean(name));
    }

    // Subtitle is a single inline line. The location gets a 📍
    // prefix to match how location is rendered everywhere else in
    // the app (HistoryScreen cards, schedule notification emails,
    // newGame/settings labels). Without it, a host like "אייל"
    // looks identical to a player name in the same row — the icon
    // makes the meaning unambiguous at a glance.
    //
    // Each segment is `whiteSpace: 'nowrap'` so on narrow screens
    // the line either fits intact or breaks cleanly between
    // segments — never mid-phrase, never leaving a "·" stranded at
    // the start of the next line.
    const subtitle = dateLabel ? (
      <>
        <span style={{ whiteSpace: 'nowrap' }}>{dateLabel}</span>
        {location && (
          <span style={{ whiteSpace: 'nowrap' }}>
            <span style={{ marginInline: '0.4rem', opacity: 0.6 }}>·</span>
            📍 {location}
          </span>
        )}
      </>
    ) : t('home.schedule.confirmedHelper');

    // Accent encodes the game situation:
    //   missing seats → amber (recruitment is the most urgent action)
    //   filled        → green (anticipation, all set)
    // The countdown pill stays green either way — it's about
    // *timing*, not status — and reads cleanly against both card
    // accents. The missing-seats pill switches to amber so it
    // visually reinforces the card-level warning instead of
    // competing with it on indigo.
    const accent: 'warning' | 'success' = missingSeats > 0 ? 'warning' : 'success';

    const accessory = (countdown || missingSeats > 0) ? (
      <>
        {countdown && <Pill text={countdown} tone="success" />}
        {missingSeats > 0 && (
          <Pill
            text={missingSeats === 1
              ? t('home.schedule.missingOne')
              : t('home.schedule.missingMany', { n: missingSeats })}
            tone="warning"
          />
        )}
      </>
    ) : undefined;

    // Body slot: "מגיעים: name · name · …" — answers the most-asked
    // question on game day ("who's coming?") at a glance instead of
    // forcing members to drill into the schedule tab. We render the
    // FULL list with no truncation: a half-shown list ("ליאור · אייל
    // · אורן · חרדון +2 נוספים") feels worse than either presenting
    // everyone or no one. For typical 6-10 player groups this wraps
    // to 1-2 lines naturally on mobile, which is acceptable.
    let comingBody: React.ReactNode = null;
    if (comingNames.length > 0) {
      comingBody = (
        <div style={{
          fontSize: '0.7rem',
          color: 'var(--text-muted)',
          paddingTop: '0.4rem',
          borderTop: '1px solid rgba(255,255,255,0.06)',
          lineHeight: 1.5,
          wordBreak: 'break-word',
        }}>
          <span style={{ fontWeight: 600, opacity: 0.85 }}>
            {t('home.schedule.confirmedComing')}:
          </span>{' '}
          {comingNames.join(' · ')}
        </div>
      );
    }

    return (
      <HomeCard
        order={order}
        step={step}
        icon="🎯"
        title={t('home.schedule.confirmedTitle')}
        subtitle={subtitle}
        accessory={accessory}
        accent={accent}
        body={comingBody}
        onClick={onClick}
      />
    );
  }

  // ── Open / expanded poll ──
  // Two flavours, picked from the viewer's vote state so the card
  // talks to *this* member instead of showing the same generic copy
  // for everyone:
  //   1. User hasn't voted → amber-tinted nudge with their name in
  //      the title ("ליאור, ההצבעה מחכה לך"). Strong but not noisy.
  //   2. User has voted → blue thank-you card. Stays tappable so they
  //      can update or peek at interim results.
  //
  // Both flavours render an at-a-glance compact poll preview as the
  // card body: one row per proposed date with `<yes-count> / <target>`
  // so the viewer can see WHICH date is closest to filling without
  // having to drill into the schedule tab. On the "voted" card we
  // additionally flag the dates THIS viewer said yes to with a small
  // ✓ marker so they remember which option they backed.
  //
  // We treat any vote on any date by `myPlayerId` as "voted" for the
  // branch selection — the dashboard doesn't care which dates they
  // picked, just whether they participated. The "yes-only" highlight
  // in the body row is a separate per-date check.
  const hasMyVote = myPlayerId !== null && poll.votes.some(v => v.playerId === myPlayerId);

  // Distinct voter count for the subtitle stat. Reflects participation,
  // not raw vote rows (a member voting yes on 3 dates = 1 voter).
  const distinctVoterCount = new Set(poll.votes.map(v => v.playerId)).size;

  // Sort dates chronologically so the visible order matches a calendar
  // walk forward in time — closest date first. Time is appended for
  // tie-breaking when two options share the same calendar date.
  const sortedDates = [...poll.dates].sort((a, b) => {
    const ka = `${a.proposedDate}T${a.proposedTime || '00:00'}`;
    const kb = `${b.proposedDate}T${b.proposedTime || '00:00'}`;
    return ka.localeCompare(kb);
  });

  const glanceBody = sortedDates.length > 0 ? (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: '0.35rem',
      paddingTop: '0.5rem',
      borderTop: '1px solid rgba(255,255,255,0.08)',
    }}>
      {sortedDates.map(d => {
        const yesCount = poll.votes.filter(
          v => v.dateId === d.id && v.response === 'yes'
        ).length;
        // The viewer's own response on THIS date — independent of
        // whether they voted on other dates. We surface all three
        // RSVP states (yes/no/maybe) so a member who said "no" to
        // Friday but "yes" to Thursday/Saturday sees a clear marker
        // on Friday too — not silence, which would read as "I didn't
        // vote" when in fact they did.
        const myResponse: 'yes' | 'no' | 'maybe' | null = (() => {
          if (myPlayerId === null) return null;
          const mine = poll.votes.find(
            v => v.dateId === d.id && v.playerId === myPlayerId
          );
          return mine?.response ?? null;
        })();
        const dt = new Date(`${d.proposedDate}T${d.proposedTime || '20:00'}`);
        const dayName = Number.isNaN(dt.getTime())
          ? ''
          : dt.toLocaleDateString('he-IL', { weekday: 'short' });
        const dateStr = Number.isNaN(dt.getTime())
          ? d.proposedDate
          : dt.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' });
        const timeStr = d.proposedTime ? d.proposedTime.slice(0, 5) : null;
        const labelParts = [dayName, dateStr].filter(Boolean);
        const label = labelParts.join(' · ') + (timeStr ? ` · ${timeStr}` : '');
        // The most-popular date gets a faint highlight so the viewer's
        // eye is drawn to the option closest to filling. We compute it
        // once per render — ties don't matter (any of them will glow).
        const isLeading = yesCount > 0 && yesCount === Math.max(
          ...sortedDates.map(x => poll.votes.filter(v => v.dateId === x.id && v.response === 'yes').length)
        );
        return (
          <div
            key={d.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              fontSize: '0.78rem',
              lineHeight: 1.3,
              opacity: isLeading ? 1 : 0.85,
            }}
          >
            <span style={{
              flex: '1 1 auto',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: 'var(--text)',
              fontWeight: isLeading ? 600 : 400,
            }}>
              {label}
            </span>
            {(() => {
              // Color the pill by stance:
              //   yes     → green  (positive commitment)
              //   no      → red    (negative — clear, not "you didn't vote")
              //   maybe   → amber  (uncertain — same hue we use for warnings)
              //   skipped → grey   (you participated in the poll but did
              //                     not respond to THIS date — distinct
              //                     from "haven't voted at all", which
              //                     uses no pill)
              //
              // The "skipped" pill is only meaningful on the "voted"
              // card variant. On the "haven't voted yet" card, every
              // row is in skipped state, so a pill on every row would
              // be visual noise — the card title already carries the
              // meaning. We gate it on `hasMyVote` from the outer
              // scope.
              if (!myResponse && !hasMyVote) return null;
              const tone = myResponse === 'yes'
                ? { fg: '#10b981', bg: 'rgba(16, 185, 129, 0.14)', key: 'home.schedule.openGlanceMineYes' as const }
                : myResponse === 'no'
                ? { fg: '#ef4444', bg: 'rgba(239, 68, 68, 0.14)', key: 'home.schedule.openGlanceMineNo' as const }
                : myResponse === 'maybe'
                ? { fg: '#f59e0b', bg: 'rgba(245, 158, 11, 0.16)', key: 'home.schedule.openGlanceMineMaybe' as const }
                : { fg: 'var(--text-muted)', bg: 'rgba(148, 163, 184, 0.16)', key: 'home.schedule.openGlanceMineSkipped' as const };
              return (
                <span style={{
                  flexShrink: 0,
                  fontSize: '0.7rem',
                  fontWeight: 700,
                  color: tone.fg,
                  background: tone.bg,
                  padding: '1px 6px',
                  borderRadius: 6,
                }}>
                  {t(tone.key)}
                </span>
              );
            })()}
            <span style={{
              flexShrink: 0,
              fontWeight: 700,
              color: 'var(--text)',
              fontVariantNumeric: 'tabular-nums',
            }}>
              {/* Order: target first then yes-count, so in RTL the
                  numerator (current participants) lands on the right —
                  matching how the rest of the dashboard reads. */}
              <span style={{ opacity: 0.5, fontWeight: 400, fontSize: '0.72rem' }}>
                {poll.targetPlayerCount}{' / '}
              </span>
              {yesCount}
            </span>
          </div>
        );
      })}
    </div>
  ) : null;

  if (!hasMyVote) {
    // Subtitle promotes the participation count to keep the page
    // dynamic across visits — but only when at least one member has
    // voted. With zero votes we fall back to the action prompt to
    // avoid the awkward "0 חברים הצביעו".
    const subtitle = distinctVoterCount > 0
      ? t('home.schedule.openYouHaventVotedStat', { n: distinctVoterCount })
      : t('home.schedule.openYouHaventVotedHelper');
    return (
      <HomeCard
        order={order}
        step={step}
        icon="🗳"
        title={playerName
          ? t('home.schedule.openYouHaventVoted', { name: playerName })
          : t('home.schedule.openTitle')}
        subtitle={subtitle}
        accent="warning"
        body={glanceBody}
        onClick={onClick}
      />
    );
  }

  // Already voted — warm thank-you, same compact glance below.
  const votedSubtitle = distinctVoterCount > 0
    ? t('home.schedule.openYouVotedStat', { n: distinctVoterCount })
    : t('home.schedule.openYouVotedHelper');
  return (
    <HomeCard
      order={order}
      step={step}
      icon="🗳"
      title={playerName
        ? t('home.schedule.openYouVotedThanks', { name: playerName })
        : t('home.schedule.openYouVoted')}
      subtitle={votedSubtitle}
      accent="info"
      body={glanceBody}
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
  // ── Animate every potential tile value from 0 → final ──────────
  // Rules of hooks demand a stable hook count, so we run useCountUp
  // for EVERY tile the rotation pool may surface today — even if a
  // given day's pick uses only 4 of them. The cost is trivial
  // (single rAF per value, finishes in ~600 ms) and avoids the
  // complexity of a custom array-aware hook.
  const cuGames = useCountUp(stats.gamesPlayed);
  const cuWinPct = useCountUp(Math.round(stats.winPercentage));
  const cuTotal = useCountUp(Math.round(stats.totalProfit));
  const cuWins = useCountUp(stats.winCount);
  const cuStreakMag = useCountUp(Math.abs(stats.currentStreak));
  const cuBestNight = useCountUp(Math.round(stats.biggestWin));
  const cuAvgGame = useCountUp(Math.round(stats.avgProfit));
  const cuLongestStreak = useCountUp(stats.longestWinStreak);
  const lastProfit = stats.lastGameResults?.[0]?.profit ?? 0;
  const cuLastGame = useCountUp(Math.round(lastProfit));
  const last3 = stats.lastGameResults?.slice(0, 3) ?? [];
  const last3AvgRaw = last3.length >= 3
    ? Math.round(last3.reduce((s, g) => s + g.profit, 0) / last3.length)
    : 0;
  const cuLast3 = useCountUp(last3AvgRaw);

  const streakSign = stats.currentStreak >= 0 ? 1 : -1;
  const hasStreak = Math.abs(stats.currentStreak) >= 1;

  // ── "Big total loss" guard ─────────────────────────────────────
  // The home dashboard is a landing page — seeing a giant red
  // negative number every single visit is demoralizing for players
  // on a long losing arc. So when the cumulative loss is *sustained*
  // and *meaningful*, we hide the total tile and surface the player's
  // win count instead (always non-negative, always something to be
  // proud of).
  //
  // We deliberately keep the rule conservative so casual minus values
  // stay visible — the user explicitly said small/honest losses are
  // fine, only "big" totals should be hidden:
  //
  //   1. totalProfit < -500    → loss is meaningful in absolute terms
  //   2. abs(loss) > 2 × best  → loss is meaningful relative to this
  //                              player's stakes (a ₪200-buy-in
  //                              player and a ₪2000-buy-in player
  //                              have different "big")
  //   3. winCount > 0          → there is something to substitute
  //                              with (showing "Wins: 0" would be
  //                              even more demoralizing than the
  //                              loss itself)
  const isBigLoss =
    stats.totalProfit < -500 &&
    stats.winCount > 0 &&
    Math.abs(stats.totalProfit) > stats.biggestWin * 2;

  // Subtitle: prefer the records line if any wins exist, else a
  // generic encouragement. Records line is always positive (uses
  // biggestWin / longestWinStreak), so it stays encouraging even
  // for players in rough patches.
  const hasRecords = stats.biggestWin > 0 || stats.longestWinStreak > 0;
  const subtitle = hasRecords
    ? t('home.personal.records', {
      biggest: formatCurrency(stats.biggestWin),
      streak: stats.longestWinStreak,
    })
    : t('home.personal.encouragement');

  // ── Tile pool with daily rotation ─────────────────────────────
  // Goal: the home card should feel alive — different "lens" on the
  // player's stats every day instead of a static four-tile readout
  // they've memorized after one visit. We build a pool of every
  // reasonable tile, filter to those whose data exists for THIS
  // player, then deterministically pick 4 based on (day-of-year +
  // player-name hash). Same player + same UTC day = identical
  // picks, so the layout is stable through a session and only
  // refreshes when the day rolls over. Different players see
  // staggered rotations from the name hash, so two people on the
  // same day don't see the same combo.
  //
  // The pool is intentionally heterogeneous (anchors + records +
  // recent form + cumulative) so any 4-tile slice tells a coherent
  // story. With ~10 applicable tiles for a typical player, there
  // are enough combinations to make the rotation feel fresh for
  // weeks before repeating.
  type Tile = {
    key: string;
    label: string;
    value: string;
    accent?: 'win' | 'loss';
  };

  const signedAccent = (n: number): 'win' | 'loss' | undefined =>
    n > 0 ? 'win' : n < 0 ? 'loss' : undefined;

  const pool: { tile: Tile; applicable: boolean }[] = [
    {
      tile: { key: 'games', label: t('home.personal.games'), value: String(cuGames) },
      applicable: true,
    },
    {
      tile: { key: 'winPct', label: t('home.personal.winRate'), value: `${cuWinPct}%` },
      applicable: true,
    },
    {
      tile: {
        key: 'total', label: t('home.personal.total'),
        value: formatCurrency(cuTotal),
        accent: signedAccent(cuTotal),
      },
      // Big-loss guard: hide the total tile entirely from the pool
      // when sustained loss is meaningful. The wins tile below
      // takes its place automatically because it's still applicable.
      applicable: !isBigLoss,
    },
    {
      tile: {
        key: 'wins', label: t('home.personal.wins'),
        value: String(cuWins),
        accent: cuWins > 0 ? 'win' : undefined,
      },
      applicable: stats.winCount > 0,
    },
    {
      tile: {
        key: 'streak', label: t('home.personal.streakLabel'),
        value: hasStreak
          ? `${streakSign > 0 ? '+' : '−'}${cuStreakMag}`
          : '—',
        accent: hasStreak ? (streakSign > 0 ? 'win' : 'loss') : undefined,
      },
      applicable: hasStreak,
    },
    {
      tile: {
        key: 'bestNight', label: t('home.personal.bestNight'),
        value: formatCurrency(cuBestNight),
        accent: 'win',
      },
      applicable: stats.biggestWin > 0,
    },
    {
      tile: {
        key: 'avgGame', label: t('home.personal.avgGame'),
        value: formatCurrency(cuAvgGame),
        accent: signedAccent(cuAvgGame),
      },
      applicable: stats.gamesPlayed >= 1,
    },
    {
      tile: {
        key: 'longestStreak', label: t('home.personal.longestWinStreak'),
        value: String(cuLongestStreak),
        accent: cuLongestStreak > 0 ? 'win' : undefined,
      },
      applicable: stats.longestWinStreak > 0,
    },
    {
      tile: {
        key: 'lastGame', label: t('home.personal.lastGame'),
        value: formatCurrency(cuLastGame),
        accent: signedAccent(cuLastGame),
      },
      applicable: (stats.lastGameResults?.length ?? 0) > 0,
    },
    {
      tile: {
        key: 'last3Avg', label: t('home.personal.last3Avg'),
        value: formatCurrency(cuLast3),
        accent: signedAccent(cuLast3),
      },
      applicable: last3.length >= 3,
    },
  ];

  // ── Next-milestone hint ───────────────────────────────────────
  // An open-loop "X away from Y" line that pinned-displays above
  // the rotating tile grid whenever the player is within reach of
  // a meaningful round number. Pinned (not rotated) because
  // milestones are too motivating to leave to a daily lottery — if
  // there's one within reach you want to see it every day until
  // you cross it.
  //
  // Selection: we collect every candidate the player is "near",
  // then pick the one with the smallest *normalised* distance
  // (remaining / target) so we surface what's about to be crossed
  // rather than something a year away. Hides itself entirely when
  // nothing's in reach (brand-new players, players who just hit a
  // big number and have nothing close).
  const milestone = computeNextMilestone(stats, t);

  const applicable = pool.filter(p => p.applicable).map(p => p.tile);
  // Deterministic daily rotation. Day-of-year provides the day-to-day
  // shift, name hash ensures different players don't see the exact
  // same picks on the same day. UTC-based so a group spread across
  // timezones rolls over together.
  const TILES_TO_SHOW = 4;
  const daySeed = Math.floor(Date.now() / 86_400_000);
  const nameSeed = (stats.playerName || '')
    .split('')
    .reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const start = applicable.length > 0
    ? (daySeed + nameSeed) % applicable.length
    : 0;
  const picked = applicable.length <= TILES_TO_SHOW
    ? applicable
    : Array.from({ length: TILES_TO_SHOW }, (_, i) =>
        applicable[(start + i) % applicable.length]);

  const body = (
    // Two-part body, ordered by past → present → future narrative:
    //   1. (subtitle above body, in HomeCard) — lifetime records (past)
    //   2. stat tiles                          — current snapshot (present)
    //   3. milestone badge                     — next goal (future)
    //
    // Milestone pill renders LAST so it acts as a "next up" footer /
    // CTA rather than mid-card interruption. Visually loud elements
    // (the indigo gradient) land at the bottom as a crescendo, which
    // gives the card a calm-loud-calm rhythm instead of pulling the
    // eye away from the stat tiles before they're absorbed.
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
      {/* `minmax(0, 1fr)` (instead of plain `1fr`) prevents a track
          from growing past its share when a long currency value like
          `₪123,456` is wider than the equal-width slice. Column count
          tracks `picked.length` for the rare case (brand-new player)
          where fewer than 4 tiles are applicable. */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${Math.max(picked.length, 1)}, minmax(0, 1fr))`,
        gap: '0.4rem',
      }}>
        {picked.map(tile => (
          <StatTile
            key={tile.key}
            label={tile.label}
            value={tile.value}
            accent={tile.accent}
          />
        ))}
      </div>
      {milestone && <MilestoneBadge text={milestone} />}
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

// Footer bar for the "next milestone" hint. Earlier iterations
// rendered this as a saturated indigo pill (border-radius: 999,
// strong gradient, bold text), which clashed with the rest of
// the card — the StatTile grid uses 8 px radius and a quiet
// translucent wash, and the card itself uses 12 px radius. A
// full-pill chip with a loud gradient was the loudest element
// on the card, even though "next goal" is the *least* important
// signal here (an achievement, not a current stat).
//
// Current design intentionally echoes the StatTile vocabulary
// so the card reads as a single coherent surface:
//   - 8 px radius          → matches StatTile
//   - translucent wash     → same density family as StatTile bg
//   - soft indigo accent   → preserves the "this is a goal"
//                            semantic (indigo = forward-looking)
//                            without screaming for attention
//   - full-width bar       → anchors the bottom of the card and
//                            mirrors the width of the tile grid
//                            above, instead of orphaning a chip
//                            at one end of an empty row
//   - text size + weight   → calibrated to sit between the muted
//                            subtitle and the bold tile values
//
// Tabular numerals so the count never jiggles between glyph
// widths as the player approaches the milestone day-to-day.
function MilestoneBadge({ text }: { text: string }) {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '0.45rem',
      width: '100%',
      padding: '0.4rem 0.6rem',
      borderRadius: 8,
      background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.06) 0%, rgba(99, 102, 241, 0.03) 100%)',
      border: '1px solid rgba(129, 140, 248, 0.18)',
      fontFeatureSettings: '"tnum"',
    }}>
      <span style={{ fontSize: '0.85rem', lineHeight: 1, flexShrink: 0 }}>🎯</span>
      <span style={{
        fontSize: '0.72rem',
        fontWeight: 600,
        color: '#a5b4fc',
        letterSpacing: '0.01em',
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}>
        {text}
      </span>
    </div>
  );
}

// Pick the next round-number milestone the player is closest to.
// Returns the localized one-line string, or null if nothing is
// within reach. Distance is normalised (`remaining / target`) so
// a 99 % filled small target wins over a 50 % filled big one —
// the line should always feel "almost there", not "halfway there".
//
// Per-category `maxRemaining` filters out far-away targets so we
// don't surface "990 משחקים ל-1000" to a player with 10 games.
// Numbers tuned for a ~weekly poker night where 30 games ≈ a year
// of play, ₪5k ≈ a few months of swings, 15 wins ≈ ~30 games at
// a typical 50% win-or-better rate.
function computeNextMilestone(stats: PlayerStats, t: SectionProps['t']): string | null {
  type Candidate = { text: string; ratio: number };
  const candidates: Candidate[] = [];

  // Games milestones — the most actionable category.
  const gameTargets = [25, 50, 100, 150, 200, 250, 300, 400, 500, 750, 1000];
  for (const target of gameTargets) {
    const remaining = target - stats.gamesPlayed;
    if (remaining > 0 && remaining <= 30) {
      candidates.push({
        text: t('home.personal.milestoneGames', { remaining, target }),
        ratio: remaining / target,
      });
      break; // only the next one in this category matters
    }
  }

  // Wins milestones.
  const winTargets = [10, 25, 50, 100, 150, 200, 300, 500];
  for (const target of winTargets) {
    const remaining = target - stats.winCount;
    if (remaining > 0 && remaining <= 15) {
      candidates.push({
        text: t('home.personal.milestoneWins', { remaining, target }),
        ratio: remaining / target,
      });
      break;
    }
  }

  // Profit milestones — only when the player is currently on the
  // positive side. Showing "still 5,000 to break even" to someone
  // deep in the red would undercut the encouraging framing of the
  // PersonalCard.
  if (stats.totalProfit > 0) {
    const profitTargets = [1000, 2500, 5000, 10000, 20000, 50000, 100000];
    for (const target of profitTargets) {
      const remaining = target - stats.totalProfit;
      if (remaining > 0 && remaining <= 5000) {
        candidates.push({
          text: t('home.personal.milestoneProfit', {
            remaining: formatCurrency(Math.round(remaining)),
            target: formatCurrency(target),
          }),
          ratio: remaining / target,
        });
        break;
      }
    }
  }

  if (candidates.length === 0) return null;
  // Closest to crossing wins. Smallest ratio = highest "% there".
  candidates.sort((a, b) => a.ratio - b.ratio);
  return candidates[0].text;
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

  // Each segment after the first is wrapped in a single
  // `whiteSpace: 'nowrap'` span that bundles the separator dot with
  // its content. Without this, the browser can break a line right
  // before/after the dot — leaving a lonely "·" at the start of
  // line 2 on narrow screens, which reads like a typo. Bundling
  // also prevents a segment like "מנצח: ליאור" from splitting
  // across lines mid-phrase.
  const sep = (
    <span style={{ marginInline: '0.25rem', opacity: 0.6 }}>·</span>
  );
  const subtitle = (
    <>
      <span style={{ whiteSpace: 'nowrap' }}>{dateLabel}</span>
      {winnerName && (
        <span style={{ whiteSpace: 'nowrap' }}>
          {sep}
          {t('home.lastGame.winner', { name: winnerName })}
        </span>
      )}
      {myPlaceText && (
        <span style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>
          {sep}
          {myPlaceText}
        </span>
      )}
      {profitText && (
        <span style={{ whiteSpace: 'nowrap', color: profitColor, fontWeight: 600 }}>
          {sep}
          {profitText}
        </span>
      )}
      {absentText && (
        <span style={{ whiteSpace: 'nowrap', color: absentColor, fontWeight: 600 }}>
          {sep}
          {absentText}
        </span>
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
      // 4 structured nowrap segments — disable the clamp so HomeCard
      // uses flex-wrap layout instead of `-webkit-box` clipping.
      // With clamp on, JSX-stripped whitespace between segments
      // means there's no soft-wrap opportunity between the spans
      // and the trailing "הרווח שלך" segment overflows past the
      // card's left edge in RTL and gets silently clipped.
      subtitleClamp={0}
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
  const { top3, monthLabel, hasAnyCompletedGames } = useMemo(() => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
    // "Has the group ever played?" — used below to hide the card entirely
    // for brand-new groups, where the very concept of a monthly leaderboard
    // is meaningless. We compute this once here (instead of an extra
    // .some() further down) so the early-return path stays cheap.
    const hasAnyCompletedGames = games.some(g => g.status === 'completed');

    // Localized "May 2026" / "מאי 2026" for the card subtitle. Uses
    // the document language so RTL Hebrew vs LTR English both look
    // native.
    const monthLabel = now.toLocaleDateString(
      typeof document !== 'undefined' && document.documentElement.lang === 'en' ? 'en-US' : 'he-IL',
      { month: 'long', year: 'numeric' },
    );

    const monthGameIds = new Set(
      games
        .filter(g => g.status === 'completed')
        .filter(g => {
          const ts = new Date(g.date).getTime();
          return ts >= monthStart && ts < monthEnd;
        })
        .map(g => g.id),
    );
    if (monthGameIds.size === 0) {
      return {
        top3: [] as { name: string; profit: number; games: number; wins: number }[],
        monthLabel,
        hasAnyCompletedGames,
      };
    }

    // Aggregate this month's stats per player. "wins" follows the
    // same definition used everywhere else in the app
    // (`PlayerStats.winCount` in `storage.ts`): a game ending in
    // POSITIVE PROFIT, not just a 1st-place finish. The previous
    // 1st-place-only counter produced misleading 0% rates for 2nd/
    // 3rd-place podium players who still ended profitable — the
    // monthly leaderboard sorts by total profit, so a player with
    // a single 2nd-place +₪84 night legitimately had a "winning
    // night" that should count.
    const byPlayer = new Map<string, { name: string; profit: number; games: number; wins: number }>();
    for (const gp of gamePlayers) {
      if (!monthGameIds.has(gp.gameId)) continue;
      const cur = byPlayer.get(gp.playerName) ?? { name: gp.playerName, profit: 0, games: 0, wins: 0 };
      cur.profit += gp.profit;
      cur.games += 1;
      if (gp.profit > 0) cur.wins += 1;
      byPlayer.set(gp.playerName, cur);
    }

    return {
      top3: [...byPlayer.values()].sort((a, b) => b.profit - a.profit).slice(0, 3),
      monthLabel,
      hasAnyCompletedGames,
    };
  }, [games, gamePlayers]);

  // Brand-new group with zero completed games ever → don't render the
  // leaderboard at all. Showing "מובילי החודש · אין עדיין משחקים החודש"
  // for a group that has never played is misleading copy AND wasted
  // dashboard real estate. The card reappears the moment the first
  // game is completed (which is exactly when "leaderboard" becomes a
  // real concept for that group).
  if (!hasAnyCompletedGames) return null;

  // Title carries the month inline ("מובילי החודש · מאי 2026")
  // instead of a separate subtitle line — the user wants the period
  // labelled in the heading, not as supplementary copy. We keep the
  // full localized "monthLabel" rather than a short form so the year
  // is visible too (matters in January when "מאי" alone could be
  // last year's results coming back into the rolling window).
  const titleWithMonth = `${t('home.leaderboard.title')} · ${monthLabel}`;

  if (top3.length === 0) {
    return (
      <HomeCard
        order={order}
        step={step}
        icon="🏅"
        title={titleWithMonth}
        subtitle={t('home.leaderboard.empty')}
        onClick={onClick}
      />
    );
  }

  const medals = ['🥇', '🥈', '🥉'];
  // ── Table layout ─────────────────────────────────────────────
  // We render the top-3 as a real <table> with five columns mirroring
  // the most distinct signals from `StatisticsScreen` (# / שחקן /
  // רווח / מש׳ / נצ%). Average-per-game (ממוצע) is intentionally
  // omitted here because it's derivable from the two adjacent columns
  // (avg = profit ÷ games) AND it duplicates the profit column for
  // early-month rows where each player has only 1 game so far.
  // Dropping it gives the player-name column ~50 px more breathing
  // room on narrow phones, so common names like "שגיא אחיין" fit
  // without ellipsis. The full Statistics screen still shows ממוצע —
  // tapping the card drills into that view.
  //
  // Notes:
  // - `tableLayout: 'fixed'` would give us tighter column control
  //   but breaks for variable-length Hebrew names; we let the
  //   browser do auto layout and use `whiteSpace: 'nowrap'` on
  //   numeric cells to prevent wrapping.
  // - Column header alignment uses `isRTL` so English mirrors
  //   correctly, matching the StatisticsScreen convention.
  // - Numeric columns get `fontFeatureSettings: 'tnum'` (tabular
  //   numerals) so the digits line up vertically across rows even
  //   though we're not using a fixed grid.
  // - The "self" row keeps the same blue accent we use everywhere
  //   else for the current player — the cell-level background
  //   spans the full row because every cell carries the same color
  //   (table rows can't take a `background` cleanly across
  //   borders).
  const isRTL = typeof document !== 'undefined' && document.documentElement.dir === 'rtl';
  const numAlign: 'right' | 'left' = 'right';

  const headerCellStyle: React.CSSProperties = {
    fontSize: '0.65rem',
    fontWeight: 600,
    color: 'var(--text-muted)',
    padding: '0.25rem 0.3rem',
    whiteSpace: 'nowrap',
  };
  const dataCellStyle: React.CSSProperties = {
    fontSize: '0.78rem',
    padding: '0.35rem 0.3rem',
    whiteSpace: 'nowrap',
    fontFeatureSettings: '"tnum"',
  };

  const body = (
    <table style={{
      width: '100%',
      borderCollapse: 'collapse',
      tableLayout: 'auto',
    }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border)' }}>
          <th style={{ ...headerCellStyle, textAlign: isRTL ? 'right' : 'left', width: 24 }}>
            {t('stats.rankCol')}
          </th>
          <th style={{ ...headerCellStyle, textAlign: isRTL ? 'right' : 'left' }}>
            {t('stats.playerCol')}
          </th>
          <th style={{ ...headerCellStyle, textAlign: numAlign }}>
            {t('stats.profitCol')}
          </th>
          <th style={{ ...headerCellStyle, textAlign: numAlign }}>
            {t('stats.gamesCol')}
          </th>
          <th style={{ ...headerCellStyle, textAlign: numAlign }}>
            {t('stats.winRateCol')}
          </th>
        </tr>
      </thead>
      <tbody>
        {top3.map((p, i) => {
          const isMe = playerName !== null && p.name === playerName;
          const pct = p.games > 0 ? Math.round((p.wins / p.games) * 100) : 0;
          // Per-cell background paints the row uniformly even
          // though `<tr>` can't reliably take a background under
          // every browser when borders are involved.
          const rowBg = isMe ? ME_BG : 'transparent';
          const profitColor = p.profit > 0 ? WIN_COLOR : p.profit < 0 ? LOSS_COLOR : 'var(--text-muted)';
          return (
            <tr
              key={p.name}
              style={{
                borderBottom: i < top3.length - 1 ? '1px solid var(--border)' : 'none',
              }}
            >
              <td style={{
                ...dataCellStyle,
                background: rowBg,
                textAlign: isRTL ? 'right' : 'left',
                color: 'var(--text-muted)',
                fontWeight: 600,
              }}>
                {i + 1}
              </td>
              <td style={{
                ...dataCellStyle,
                background: rowBg,
                textAlign: isRTL ? 'right' : 'left',
                fontWeight: isMe ? 700 : 600,
                color: isMe ? ME_NAME_COLOR : 'var(--text)',
                // Name is the only cell allowed to wrap. Numeric
                // cells stay `nowrap` (inherited from dataCellStyle)
                // so digits never split, but the player-name cell
                // overrides nowrap → if the row can't fit a long
                // name on a single line, it breaks onto a second
                // line inside this cell instead of getting ellipsis-
                // clipped (which used to swallow names like
                // "שגיא אחיין"). `wordBreak: break-word` allows the
                // break to happen mid-name on extreme cases without
                // pushing the row wider.
                whiteSpace: 'normal',
                wordBreak: 'break-word',
                lineHeight: 1.2,
              }}>
                <span style={{ marginInlineEnd: '0.35rem' }}>{medals[i]}</span>
                {p.name}
              </td>
              <td style={{
                ...dataCellStyle,
                background: rowBg,
                textAlign: numAlign,
                color: profitColor,
                fontWeight: 700,
              }}>
                {formatCurrency(p.profit)}
              </td>
              <td style={{
                ...dataCellStyle,
                background: rowBg,
                textAlign: numAlign,
                color: 'var(--text-muted)',
              }}>
                {p.games}
              </td>
              <td style={{
                ...dataCellStyle,
                background: rowBg,
                textAlign: numAlign,
                color: 'var(--text-muted)',
              }}>
                {pct}%
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  return (
    <HomeCard
      order={order}
      step={step}
      icon="🏅"
      title={titleWithMonth}
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
  trainingPlayers: TrainingPlayerData[];
}

function TriviaCard({ order, step, t, games, gamePlayers, playerStats, trainingPlayers }: TriviaProps) {
  const { language } = useTranslation();
  const trivia = useMemo(
    () => buildTriviaList(games, gamePlayers, playerStats, trainingPlayers, t, language),
    [games, gamePlayers, playerStats, trainingPlayers, t, language],
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

// Format a single timestamp as a short, contextual Hebrew/English
// suffix used inside trivia facts — e.g. "(לפני 5 ימים)", "(לפני 3
// חודשים)", "(מאי 2024)" / "(May 2024)". Recent events read better
// as relative ("a year ago doesn't help me picture WHICH game"),
// older events read better as absolute ("3 years ago" is too vague).
// Returns an empty string for invalid input so callers can safely
// concatenate without a guard.
const HEBREW_MONTH_NAMES = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
] as const;
const ENGLISH_MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;
function formatTriviaDate(iso: string | undefined, language: Language): string {
  if (!iso) return '';
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return '';
  const daysAgo = Math.floor((Date.now() - ts) / 86_400_000);
  if (daysAgo <= 0) return language === 'he' ? 'היום' : 'today';
  if (daysAgo === 1) return language === 'he' ? 'אתמול' : 'yesterday';
  if (daysAgo < 14) {
    return language === 'he' ? `לפני ${daysAgo} ימים` : `${daysAgo} days ago`;
  }
  if (daysAgo < 60) {
    const weeks = Math.round(daysAgo / 7);
    return language === 'he' ? `לפני ${weeks} שבועות` : `${weeks} weeks ago`;
  }
  if (daysAgo < 180) {
    const months = Math.max(2, Math.round(daysAgo / 30));
    return language === 'he' ? `לפני ${months} חודשים` : `${months} months ago`;
  }
  const d = new Date(ts);
  const monthName = (language === 'he' ? HEBREW_MONTH_NAMES : ENGLISH_MONTH_NAMES)[d.getMonth()];
  return `${monthName} ${d.getFullYear()}`;
}

function buildTriviaList(
  games: ReturnType<typeof getAllGames>,
  gamePlayers: ReturnType<typeof getAllGamePlayers>,
  playerStats: PlayerStats[],
  trainingPlayers: TrainingPlayerData[],
  t: SectionProps['t'],
  language: Language,
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

  // O(1) lookup from gameId → ISO date, used to attach date suffixes
  // to single-event trivia facts ("biggest win on X date"). Cheaper
  // than scanning `games` for every fact that wants a date.
  const gameDateById = new Map<string, string>();
  for (const g of games) {
    if (g.status === 'completed') gameDateById.set(g.id, g.date || g.createdAt);
  }

  // Counts per player of completed game appearances (year + all-time).
  // Used by `mostActive` (year + all-time mirror) and to compute
  // win/podium percentages.
  const allCompletedGameIds = new Set(games.filter(g => g.status === 'completed').map(g => g.id));
  const allTimeGP = gamePlayers.filter(gp => allCompletedGameIds.has(gp.gameId));
  const allTimePlayersByGame = new Map<string, typeof allTimeGP>();
  for (const gp of allTimeGP) {
    const arr = allTimePlayersByGame.get(gp.gameId);
    if (arr) arr.push(gp);
    else allTimePlayersByGame.set(gp.gameId, [gp]);
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

  // 1. Biggest single win this year. Track gameId so the fact can
  //    carry a date suffix ("biggest win this year: +X by Y on Z").
  let biggest = { name: '', profit: 0, gameId: '' };
  for (const gp of yearGP) {
    if (gp.profit > biggest.profit) biggest = { name: gp.playerName, profit: gp.profit, gameId: gp.gameId };
  }
  if (biggest.profit > 0) {
    list.push({
      icon: '🏆',
      text: t('home.trivia.biggestWin', {
        profit: formatCurrency(biggest.profit),
        name: biggest.name,
        date: formatTriviaDate(gameDateById.get(biggest.gameId), language),
      }),
    });
  }

  // 2. Biggest single loss this year.
  let worst = { name: '', loss: 0, gameId: '' };
  for (const gp of yearGP) {
    if (gp.profit < worst.loss) worst = { name: gp.playerName, loss: gp.profit, gameId: gp.gameId };
  }
  if (worst.loss < -50) {
    list.push({
      icon: '❄️',
      text: t('home.trivia.biggestLoss', {
        amount: formatCurrency(Math.abs(worst.loss)),
        name: worst.name,
        date: formatTriviaDate(gameDateById.get(worst.gameId), language),
      }),
    });
  }

  // 3. Most active player this year.
  let mostActiveYearCount = 0;
  if (yearGP.length > 0) {
    const counts = new Map<string, number>();
    for (const gp of yearGP) counts.set(gp.playerName, (counts.get(gp.playerName) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= 3) {
      mostActiveYearCount = top[1];
      list.push({ icon: '💪', text: t('home.trivia.mostActive', { name: top[0], games: top[1] }) });
    }
  }

  // 3b. Most active player ALL-TIME. Mirror of #3 — only surface when
  //     strictly larger than the year leader so the two facts don't
  //     echo each other on a fresh group whose entire history fits
  //     inside the current year.
  if (allTimeGP.length > 0) {
    const counts = new Map<string, number>();
    for (const gp of allTimeGP) counts.set(gp.playerName, (counts.get(gp.playerName) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= 6 && top[1] > mostActiveYearCount + 2) {
      list.push({ icon: '💪', text: t('home.trivia.mostActiveAllTime', { name: top[0], games: top[1] }) });
    }
  }

  // 4. Most #1 finishes this year. The "{verb}" placeholder was
  //    dropped from the translation when we reworded the line —
  //    sentence reads as a noun-phrase headline now ("Win champion
  //    this year: …"), so no gendered verb is needed.
  let topWinnerThisYearCount = 0;
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
      topWinnerThisYearCount = topWinner[1];
      list.push({
        icon: '👑',
        text: t('home.trivia.mostWins', {
          name: topWinner[0],
          count: topWinner[1],
        }),
      });
    }
  }

  // 4b. Most #1 finishes ALL-TIME. Mirror of #4 — only surface when
  //     strictly larger than the year-scoped count so the two facts
  //     don't echo each other on a fresh group.
  if (allCompletedGameIds.size >= 5) {
    const winsAll = new Map<string, number>();
    for (const gameId of allCompletedGameIds) {
      const players = allTimePlayersByGame.get(gameId);
      if (!players || players.length === 0) continue;
      let winner = players[0];
      for (const p of players) if (p.profit > winner.profit) winner = p;
      if (winner.profit > 0) winsAll.set(winner.playerName, (winsAll.get(winner.playerName) ?? 0) + 1);
    }
    const topWinnerAll = [...winsAll.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topWinnerAll && topWinnerAll[1] >= 5 && topWinnerAll[1] > topWinnerThisYearCount) {
      list.push({
        icon: '👑',
        text: t('home.trivia.mostWinsAllTime', {
          name: topWinnerAll[0],
          count: topWinnerAll[1],
        }),
      });
    }
  }

  // 4c. Most podiums (top-3 finishes) THIS YEAR. Counts top-3 by
  //     profit per game where the player finished above zero (no
  //     real podium if everyone tanked). Threshold prevents
  //     surfacing on too few games.
  if (yearGameIds.size >= 4) {
    const podiumYear = new Map<string, number>();
    const playerYearGames = new Map<string, number>();
    for (const gameId of yearGameIds) {
      const players = playersByGame.get(gameId);
      if (!players || players.length === 0) continue;
      const sorted = [...players].sort((a, b) => b.profit - a.profit);
      const podium = sorted.slice(0, 3).filter(p => p.profit > 0);
      for (const p of podium) podiumYear.set(p.playerName, (podiumYear.get(p.playerName) ?? 0) + 1);
      for (const p of players) playerYearGames.set(p.playerName, (playerYearGames.get(p.playerName) ?? 0) + 1);
    }
    const topPodiumYear = [...podiumYear.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topPodiumYear && topPodiumYear[1] >= 3) {
      list.push({
        icon: '🥇',
        text: t('home.trivia.mostPodiumsYear', {
          name: topPodiumYear[0],
          count: topPodiumYear[1],
          games: playerYearGames.get(topPodiumYear[0]) ?? topPodiumYear[1],
        }),
      });
    }
  }

  // 4d. Most podiums ALL-TIME. Same shape as 4c but across every
  //     completed game ever. Only surface when the all-time count
  //     is strictly larger than the year-scoped count, otherwise
  //     it echoes 4c verbatim for groups whose history fits inside
  //     the current year.
  let topPodiumAllTimeCount = 0;
  if (allCompletedGameIds.size >= 6) {
    const podiumAll = new Map<string, number>();
    for (const gameId of allCompletedGameIds) {
      const players = allTimePlayersByGame.get(gameId);
      if (!players || players.length === 0) continue;
      const sorted = [...players].sort((a, b) => b.profit - a.profit);
      const podium = sorted.slice(0, 3).filter(p => p.profit > 0);
      for (const p of podium) podiumAll.set(p.playerName, (podiumAll.get(p.playerName) ?? 0) + 1);
    }
    const topPodiumAll = [...podiumAll.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topPodiumAll && topPodiumAll[1] >= 5) {
      topPodiumAllTimeCount = topPodiumAll[1];
      // Compare against year leader to avoid echo: only show if at
      // least 50% larger so the all-time framing carries weight.
      const yearLeaderCount = (() => {
        // Re-derive top-year count locally — small enough not to
        // bother caching from 4c (which scopes to its own block).
        const c = new Map<string, number>();
        for (const gameId of yearGameIds) {
          const players = playersByGame.get(gameId);
          if (!players) continue;
          const sorted = [...players].sort((a, b) => b.profit - a.profit);
          for (const p of sorted.slice(0, 3).filter(p => p.profit > 0)) {
            c.set(p.playerName, (c.get(p.playerName) ?? 0) + 1);
          }
        }
        return [...c.values()].reduce((m, v) => v > m ? v : m, 0);
      })();
      if (topPodiumAllTimeCount >= Math.ceil(yearLeaderCount * 1.5) || topPodiumAllTimeCount >= yearLeaderCount + 5) {
        list.push({
          icon: '🥇',
          text: t('home.trivia.mostPodiumsAllTime', {
            name: topPodiumAll[0],
            count: topPodiumAll[1],
          }),
        });
      }
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
  let mostRebuys = { name: '', count: 0, gameId: '' };
  for (const gp of yearGP) {
    if (gp.rebuys > mostRebuys.count) mostRebuys = { name: gp.playerName, count: gp.rebuys, gameId: gp.gameId };
  }
  if (mostRebuys.count >= 4) {
    list.push({
      icon: '🔁',
      text: t('home.trivia.mostRebuysSingle', {
        count: mostRebuys.count,
        name: mostRebuys.name,
        date: formatTriviaDate(gameDateById.get(mostRebuys.gameId), language),
      }),
    });
  }

  // 10. Total rebuys this year.
  let totalRebuys = 0;
  for (const gp of yearGP) totalRebuys += gp.rebuys;
  if (totalRebuys >= 30) {
    list.push({ icon: '🎰', text: t('home.trivia.totalRebuys', { count: totalRebuys }) });
  }

  // 11. Biggest 1st-vs-2nd gap in a single game this year.
  let biggestMargin = { winner: '', runnerUp: '', margin: 0, gameId: '' };
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
        gameId,
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
        date: formatTriviaDate(gameDateById.get(biggestMargin.gameId), language),
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
  //         We scan `gamePlayers` directly (rather than reading
  //         `playerStats.biggestWin`) so we can recover the actual
  //         gameId behind the record, which gives us a date suffix
  //         ("biggest win ever: +X by Y on Z"). Lower thresholds
  //         than the year-scoped entries (#1, #2) because the
  //         all-time pool is bigger and the "ever" framing is the
  //         headline value.
  let biggestEver = { name: '', profit: 0, gameId: '' };
  let worstEver = { name: '', loss: 0, gameId: '' };
  for (const gp of allTimeGP) {
    if (gp.profit > biggestEver.profit) biggestEver = { name: gp.playerName, profit: gp.profit, gameId: gp.gameId };
    if (gp.profit < worstEver.loss) worstEver = { name: gp.playerName, loss: gp.profit, gameId: gp.gameId };
  }
  if (biggestEver.profit > biggest.profit) {
    // Only surface "ever" when it's larger than the year-scoped record;
    // otherwise the two entries would be redundant.
    list.push({
      icon: '🏅',
      text: t('home.trivia.biggestWinAllTime', {
        profit: formatCurrency(biggestEver.profit),
        name: biggestEver.name,
        date: formatTriviaDate(gameDateById.get(biggestEver.gameId), language),
      }),
    });
  }
  if (worstEver.loss < worst.loss && worstEver.loss < -50) {
    list.push({
      icon: '🥶',
      text: t('home.trivia.biggestLossAllTime', {
        amount: formatCurrency(Math.abs(worstEver.loss)),
        name: worstEver.name,
        date: formatTriviaDate(gameDateById.get(worstEver.gameId), language),
      }),
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

  // ── 15. Player-count insights THIS YEAR. We deliberately do NOT
  //         surface a fractional average ("7.3 players around the
  //         table") because it's an artificial number nobody can
  //         act on. Instead we publish two facts that ARE
  //         informative:
  //           a) Mode — the table size you actually run most often
  //              ("we're a 7-handed group"), with the count so the
  //              dominance is visible. Skipped if no size repeats
  //              (no clear "usual" yet) or if the leader is barely
  //              ahead.
  //           b) Max — the biggest table assembled this year, but
  //              only if it crosses 8 (a 7-handed group hosting 11
  //              is a story; a 7-handed group hosting 7 is not).
  if (yearGameIds.size >= 3) {
    const sizeFreq = new Map<number, number>();
    let maxSize = 0;
    for (const gameId of yearGameIds) {
      const players = playersByGame.get(gameId);
      if (!players) continue;
      const size = players.length;
      if (size === 0) continue;
      sizeFreq.set(size, (sizeFreq.get(size) ?? 0) + 1);
      if (size > maxSize) maxSize = size;
    }
    const sortedSizes = [...sizeFreq.entries()].sort((a, b) => b[1] - a[1]);
    if (sortedSizes.length > 0) {
      const [topSize, topCount] = sortedSizes[0];
      // Require the mode to repeat AT LEAST twice — "happened once"
      // isn't a "most common" claim. We don't gate on dominance
      // over the runner-up because trivia is allowed to overlap
      // (multiple sizes can each be common in a small dataset).
      if (topCount >= 2) {
        list.push({
          icon: '🪑',
          text: t('home.trivia.mostCommonSize', { players: topSize, count: topCount }),
        });
      }
    }
    if (maxSize >= 8) {
      list.push({
        icon: '👥',
        text: t('home.trivia.biggestTable', { players: maxSize }),
      });
    }
  }

  // ── 16. Closest podium THIS YEAR (smallest 1st-vs-2nd gap). Inverse
  //         of #11. Surfaces the game where the title was most contested.
  //         Only interesting if the gap is genuinely tight (≤ 30).
  if (yearGameIds.size >= 3) {
    let closestPodium: { winner: string; runnerUp: string; margin: number; gameId: string } | null = null;
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
          gameId,
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
          date: formatTriviaDate(gameDateById.get(closestPodium.gameId), language),
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
      text: t('home.trivia.longestLossStreak', {
        name: lossStreakLeader.name,
        verb: verbForName('lost', lossStreakLeader.name, language),
        n: lossStreakLeader.streak,
      }),
    });
  }

  // ── 19. Biggest single-game profit swing THIS YEAR. The gap between
  //         the night's biggest winner and biggest loser (= max - min).
  //         Tells the "wildest night" story.
  let biggestSwing = { amount: 0, gameId: '' };
  for (const gameId of yearGameIds) {
    const players = playersByGame.get(gameId);
    if (!players || players.length < 2) continue;
    let mx = -Infinity, mn = Infinity;
    for (const p of players) {
      if (p.profit > mx) mx = p.profit;
      if (p.profit < mn) mn = p.profit;
    }
    const swing = mx - mn;
    if (swing > biggestSwing.amount) biggestSwing = { amount: swing, gameId };
  }
  if (biggestSwing.amount >= 200) {
    list.push({
      icon: '🎢',
      text: t('home.trivia.biggestSwing', {
        amount: formatCurrency(biggestSwing.amount),
        date: formatTriviaDate(gameDateById.get(biggestSwing.gameId), language),
      }),
    });
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
      list.push({
        icon: '🌟',
        text: t('home.trivia.newestPlayer', {
          name: newest.name,
          verb: verbForName('joined', newest.name, language),
          days: daysAgo,
        }),
      });
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
    let topRate = { name: '', pct: 0, games: 0, wins: 0 };
    for (const [name, e] of stats) {
      if (e.games < 3) continue;
      const pct = (e.wins / e.games) * 100;
      if (pct > topRate.pct) topRate = { name, pct, games: e.games, wins: e.wins };
    }
    if (topRate.pct >= 30) {
      list.push({
        icon: '🎯',
        text: t('home.trivia.bestWinRate', {
          name: topRate.name,
          verb: verbForName('won', topRate.name, language),
          pct: Math.round(topRate.pct),
          wins: topRate.wins,
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

  // ── 23. Latest game's MVP. Recency hook — anchors the dashboard
  //         to "last night" so the card feels current even if no
  //         other stat moved. We pick the most recent completed
  //         game and the player with the highest positive profit
  //         in it. Falls back to scanning `gamePlayers` if the
  //         latest game predates the year-scoped index built above.
  const latestGame = games
    .filter(g => g.status === 'completed')
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];
  if (latestGame) {
    const ps = playersByGame.get(latestGame.id)
      ?? gamePlayers.filter(gp => gp.gameId === latestGame.id);
    if (ps.length > 0) {
      let mvp = ps[0];
      for (const p of ps) if (p.profit > mvp.profit) mvp = p;
      if (mvp.profit > 0) {
        list.push({
          icon: '⭐',
          text: t('home.trivia.lastGameMvp', {
            name: mvp.playerName,
            verb: verbForName('won', mvp.playerName, language),
            profit: formatCurrency(mvp.profit),
          }),
        });
      }
    }
  }

  // ── 24. Best average profit per game THIS YEAR. Different angle
  //         from #1 (biggest single win) — rewards consistency over
  //         a single lucky night. Requires ≥ 4 games to qualify so
  //         a one-shot +500 outlier can't crown themselves.
  if (yearGameIds.size >= 4) {
    const totals = new Map<string, { profit: number; games: number }>();
    for (const gp of yearGP) {
      const e = totals.get(gp.playerName) ?? { profit: 0, games: 0 };
      e.profit += gp.profit;
      e.games++;
      totals.set(gp.playerName, e);
    }
    let topAvg = { name: '', avg: 0, games: 0 };
    for (const [name, e] of totals) {
      if (e.games < 4) continue;
      const avg = e.profit / e.games;
      if (avg > topAvg.avg) topAvg = { name, avg, games: e.games };
    }
    if (topAvg.avg >= 30) {
      list.push({
        icon: '📈',
        text: t('home.trivia.bestAvgPerGame', {
          name: topAvg.name,
          avg: formatCurrency(Math.round(topAvg.avg)),
          games: topAvg.games,
        }),
      });
    }
  }

  // ── 24b. Best average profit per game ALL-TIME. Mirror of #24.
  //          Uses the playerStats `avgProfit` directly, which is
  //          already computed across all completed games. Shown
  //          only when strictly larger than the year leader to
  //          avoid echoing.
  if (allCompletedGameIds.size >= 6) {
    let topAvgAll = { name: '', avg: 0, games: 0 };
    for (const ps of playerStats) {
      if (ps.gamesPlayed < 6) continue;
      if (ps.avgProfit > topAvgAll.avg) {
        topAvgAll = { name: ps.playerName, avg: ps.avgProfit, games: ps.gamesPlayed };
      }
    }
    // Re-derive the year leader's avg to gate against echo.
    const yearAvgLeader = (() => {
      const totals = new Map<string, { profit: number; games: number }>();
      for (const gp of yearGP) {
        const e = totals.get(gp.playerName) ?? { profit: 0, games: 0 };
        e.profit += gp.profit;
        e.games++;
        totals.set(gp.playerName, e);
      }
      let m = 0;
      for (const e of totals.values()) {
        if (e.games >= 4) {
          const avg = e.profit / e.games;
          if (avg > m) m = avg;
        }
      }
      return m;
    })();
    if (topAvgAll.avg >= 25 && topAvgAll.avg > yearAvgLeader + 5) {
      list.push({
        icon: '📈',
        text: t('home.trivia.bestAvgPerGameAllTime', {
          name: topAvgAll.name,
          avg: formatCurrency(Math.round(topAvgAll.avg)),
          games: topAvgAll.games,
        }),
      });
    }
  }

  // ── 25. Longest win streak in the group's HISTORY. Distinct from
  //         #8 (current streak): this is the all-time record across
  //         every completed game, regardless of recency, anchoring
  //         the "legendary moments" framing. We only surface it when
  //         it's strictly larger than the current streak leader so
  //         the two facts don't echo each other on the same dataset.
  let bestStreakEver: { name: string; streak: number; endDate: string } = { name: '', streak: 0, endDate: '' };
  for (const ps of playerStats) {
    if (ps.longestWinStreak > bestStreakEver.streak) {
      // Find the END date of the player's longest win streak. Their
      // `lastGameResults` is sorted most-recent-first; we walk it
      // back to oldest, accumulating consecutive wins, and remember
      // the date of the last game (chronologically latest) of the
      // first run that matched the player's `longestWinStreak`. If
      // no run matches (data inconsistency, e.g. partial history),
      // fall back to an empty date — `formatTriviaDate('')` returns
      // an empty string and the translation gracefully renders
      // "(.)" which is acceptable degradation.
      const chronological = [...(ps.lastGameResults || [])].reverse();
      let run = 0;
      let foundEnd: string | null = null;
      for (const g of chronological) {
        if (g.profit > 0) {
          run++;
          if (run === ps.longestWinStreak && foundEnd === null) {
            // First time we hit the player's recorded longest run —
            // capture this game's date as the canonical "streak end".
            // Keep scanning in case a later equal-length run exists,
            // but we always take the FIRST occurrence (earliest in
            // history that matches the record, since that's when the
            // record was originally set).
            foundEnd = g.date;
          }
        } else {
          run = 0;
        }
      }
      bestStreakEver = {
        name: ps.playerName,
        streak: ps.longestWinStreak,
        endDate: foundEnd ?? '',
      };
    }
  }
  if (bestStreakEver.streak >= 3 && bestStreakEver.streak > streakLeader.streak) {
    list.push({
      icon: '🏔️',
      text: t('home.trivia.longestWinStreakEver', {
        name: bestStreakEver.name,
        n: bestStreakEver.streak,
        date: formatTriviaDate(bestStreakEver.endDate, language),
      }),
    });
  }

  // ── 26. Top duo THIS YEAR. The pair of players who shared the
  //         most tables together. Emergent rivalry / partnership
  //         framing — gives a different lens than individual stats.
  //         O(p²) per game where p is players-per-game, but p is
  //         small (≤ 12 in practice) so this is cheap.
  if (yearGameIds.size >= 4) {
    const pairCounts = new Map<string, { a: string; b: string; n: number }>();
    for (const gameId of yearGameIds) {
      const ps = playersByGame.get(gameId);
      if (!ps || ps.length < 2) continue;
      // Sort names for a stable map key so (A,B) and (B,A) collapse
      // into the same bucket.
      const names = ps.map(p => p.playerName).sort();
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          const key = `${names[i]}|${names[j]}`;
          const cur = pairCounts.get(key) ?? { a: names[i], b: names[j], n: 0 };
          cur.n++;
          pairCounts.set(key, cur);
        }
      }
    }
    let topPair: { a: string; b: string; n: number } | null = null;
    for (const v of pairCounts.values()) {
      if (topPair === null || v.n > topPair.n) topPair = v;
    }
    if (topPair && topPair.n >= 4) {
      list.push({
        icon: '🤝',
        text: t('home.trivia.topDuo', {
          a: topPair.a,
          b: topPair.b,
          count: topPair.n,
        }),
      });
    }
  }

  // ── 26b. Top duo ALL-TIME. Same shape as 26 but unbounded by
  //          year. Surfaces the pair that most defined the group's
  //          history. Only shows when strictly larger than the
  //          year-scoped duo so they don't echo on a young group.
  if (allCompletedGameIds.size >= 6) {
    const pairCountsAll = new Map<string, { a: string; b: string; n: number }>();
    for (const gameId of allCompletedGameIds) {
      const ps = allTimePlayersByGame.get(gameId);
      if (!ps || ps.length < 2) continue;
      const names = ps.map(p => p.playerName).sort();
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          const key = `${names[i]}|${names[j]}`;
          const cur = pairCountsAll.get(key) ?? { a: names[i], b: names[j], n: 0 };
          cur.n++;
          pairCountsAll.set(key, cur);
        }
      }
    }
    let topPairAll: { a: string; b: string; n: number } | null = null;
    for (const v of pairCountsAll.values()) {
      if (topPairAll === null || v.n > topPairAll.n) topPairAll = v;
    }
    // Re-derive year duo top count to gate against echo. Cheap because
    // pair counts above #26 are scoped to year and we have local
    // access here.
    const yearTopDuoCount = (() => {
      const counts = new Map<string, number>();
      for (const gameId of yearGameIds) {
        const ps = playersByGame.get(gameId);
        if (!ps || ps.length < 2) continue;
        const names = ps.map(p => p.playerName).sort();
        for (let i = 0; i < names.length; i++) {
          for (let j = i + 1; j < names.length; j++) {
            const key = `${names[i]}|${names[j]}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
        }
      }
      return [...counts.values()].reduce((m, v) => v > m ? v : m, 0);
    })();
    if (topPairAll && topPairAll.n >= 8 && topPairAll.n > yearTopDuoCount + 3) {
      list.push({
        icon: '🤝',
        text: t('home.trivia.topDuoAllTime', {
          a: topPairAll.a,
          b: topPairAll.b,
          count: topPairAll.n,
        }),
      });
    }
  }

  // ── 27. Top chaser THIS YEAR — highest avg rebuys per game.
  //         Different from #9 (single-game record) and #10 (group
  //         total): this is the player who CONSISTENTLY chases.
  //         Gating: ≥ 4 games and ≥ 1.0 avg keeps the bar
  //         meaningful (one wild night doesn't crown a chaser).
  if (yearGameIds.size >= 4) {
    const tally = new Map<string, { rebuys: number; games: number }>();
    for (const gp of yearGP) {
      const e = tally.get(gp.playerName) ?? { rebuys: 0, games: 0 };
      e.rebuys += gp.rebuys;
      e.games++;
      tally.set(gp.playerName, e);
    }
    let topChaser = { name: '', avg: 0, games: 0 };
    for (const [name, e] of tally) {
      if (e.games < 4) continue;
      const avg = e.rebuys / e.games;
      if (avg > topChaser.avg) topChaser = { name, avg, games: e.games };
    }
    if (topChaser.avg >= 1.0) {
      list.push({
        icon: '🪙',
        text: t('home.trivia.topChaser', {
          name: topChaser.name,
          avg: topChaser.avg.toFixed(1),
          games: topChaser.games,
        }),
      });
    }
  }

  // ── 28. Best debut THIS YEAR. The player whose first-ever game
  //         in the group resulted in the biggest profit, scoped to
  //         debuts from this year so the framing stays "fresh".
  //         `firstSeen` is built earlier (#20) — we reuse it here
  //         to find which players debuted this year, then look up
  //         their first-game profit via `playersByGame`.
  let bestDebut = { name: '', profit: 0, gameId: '' };
  for (const [name, firstTs] of firstSeen) {
    if (firstTs < yearStart) continue;
    // Locate the actual game record matching the player's first-
    // appearance timestamp. Multiple games can share a date (rare
    // double-headers), so we verify the player participated.
    for (const g of games) {
      if (g.status !== 'completed') continue;
      if (new Date(g.date).getTime() !== firstTs) continue;
      const ps = playersByGame.get(g.id);
      if (!ps) continue;
      const me = ps.find(p => p.playerName === name);
      if (!me) continue;
      if (me.profit > bestDebut.profit) bestDebut = { name, profit: me.profit, gameId: g.id };
      break;
    }
  }
  if (bestDebut.profit >= 100) {
    list.push({
      icon: '🎉',
      text: t('home.trivia.bestDebut', {
        name: bestDebut.name,
        verb: verbForName('won', bestDebut.name, language),
        profit: formatCurrency(bestDebut.profit),
        date: formatTriviaDate(gameDateById.get(bestDebut.gameId), language),
      }),
    });
  }

  // ── 29. Game cadence THIS YEAR. Group-level fact: how often the
  //         group hits the table. Computed as the average gap
  //         between consecutive completed-game dates within the
  //         year. Cap at 60 days so unusual one-off entries don't
  //         claim "every 200 days" as a rhythm.
  if (yearGameIds.size >= 4) {
    const sortedDates = [...yearGameIds]
      .map(id => games.find(gg => gg.id === id)?.date)
      .filter((d): d is string => Boolean(d))
      .map(d => new Date(d).getTime())
      .filter(ts => !Number.isNaN(ts))
      .sort((a, b) => a - b);
    if (sortedDates.length >= 4) {
      const span = sortedDates[sortedDates.length - 1] - sortedDates[0];
      const avgDays = Math.round(span / 86_400_000 / (sortedDates.length - 1));
      if (avgDays >= 1 && avgDays <= 60) {
        list.push({
          icon: '⏱',
          text: t('home.trivia.cadence', { days: avgDays }),
        });
      }
    }
  }

  // ── 30. "On this day" — a memory hook from one year ago today.
  //         Surfaces a notable game whose calendar date matches
  //         today (any past year, prioritizing exactly 1 year ago)
  //         with a ±1-day window so groups that only play on
  //         weekends still get a hit when last year's match was
  //         "the closest weekend" rather than the exact date.
  //         Picks the night's MVP if positive, otherwise the
  //         biggest loss — both make for memorable callbacks.
  //         Skipped silently when no past-year game is close to
  //         today's date (fresh groups, off-season periods).
  const today = new Date();
  const todayMonth = today.getMonth();
  const todayDay = today.getDate();
  const todayYear = today.getFullYear();
  // Score each past completed game by how well its date matches
  // today (year delta + day delta). Lower score = better match.
  let bestMemory: { game: typeof games[number]; score: number } | null = null;
  for (const g of games) {
    if (g.status !== 'completed') continue;
    const d = new Date(g.date);
    if (Number.isNaN(d.getTime())) continue;
    const yearDelta = todayYear - d.getFullYear();
    if (yearDelta < 1) continue; // must be at least 1 year old
    if (d.getMonth() !== todayMonth) continue;
    const dayDelta = Math.abs(d.getDate() - todayDay);
    if (dayDelta > 1) continue; // ±1-day window
    // Prefer exact 1-year-ago + exact day-of-month. Tie-break by
    // proximity (smaller dayDelta) then recency.
    const score = (yearDelta - 1) * 100 + dayDelta * 10;
    if (bestMemory === null || score < bestMemory.score) {
      bestMemory = { game: g, score };
    }
  }
  if (bestMemory) {
    const memoryGameId = bestMemory.game.id;
    const memoryPlayers = gamePlayers.filter(gp => gp.gameId === memoryGameId);
    if (memoryPlayers.length > 0) {
      // Pick MVP (highest profit) if positive — celebratory framing
      // is friendlier than rubbing salt in an old loss. Fall back
      // to the biggest loss only if every result was non-positive
      // (a freak night where the rake / chip math left everyone at
      // or below zero — shouldn't happen with zero-sum games but
      // we still degrade gracefully).
      let mvp = memoryPlayers[0];
      for (const p of memoryPlayers) if (p.profit > mvp.profit) mvp = p;
      if (mvp.profit > 0) {
        list.push({
          icon: '🕰',
          text: t('home.trivia.onThisDay', {
            name: mvp.playerName,
            verb: verbForName('won', mvp.playerName, language),
            profit: formatCurrency(mvp.profit),
          }),
        });
      } else {
        // Find biggest loss instead.
        let worstNight = memoryPlayers[0];
        for (const p of memoryPlayers) if (p.profit < worstNight.profit) worstNight = p;
        if (worstNight.profit < 0) {
          list.push({
            icon: '🕰',
            text: t('home.trivia.onThisDayLoss', {
              name: worstNight.playerName,
              verb: verbForName('lost', worstNight.playerName, language),
              amount: formatCurrency(Math.abs(worstNight.profit)),
            }),
          });
        }
      }
    }
  }

  // ── 31. Training engagement facts. Only surface when the group has
  //         actual training activity. The data arrives async via
  //         `fetchTrainingAnswers` and is empty on the very first
  //         render — that's fine, the trivia list just rebuilds when
  //         the fetch resolves and these entries appear on the next
  //         tap-to-cycle (or on initial render if the fetch beat the
  //         user). All thresholds are conservative: a single test
  //         session shouldn't be enough to crown a trainer.
  const trainersWithActivity = trainingPlayers.filter(p => p.totalQuestions > 0);
  if (trainersWithActivity.length > 0) {
    // 31a. Top trainer by sheer volume — the player who's done the
    //      most reps. Only show with ≥ 20 questions so a quick
    //      sample doesn't crown anyone.
    const topByVolume = [...trainersWithActivity].sort((a, b) => b.totalQuestions - a.totalQuestions)[0];
    if (topByVolume && topByVolume.totalQuestions >= 20) {
      list.push({
        icon: '🎓',
        text: t('home.trivia.topTrainerSessions', {
          name: topByVolume.playerName,
          count: topByVolume.totalQuestions,
        }),
      });
    }

    // 31b. Accuracy champion — best correct% with ≥ 30 questions to
    //      qualify, mirroring the bestWinRate gate (a small sample
    //      can't crown an "accuracy king"). Hide if the leader from
    //      31a is also the accuracy leader to avoid double-attribution.
    const eligibleAccuracy = trainersWithActivity.filter(p => p.totalQuestions >= 30);
    if (eligibleAccuracy.length > 0) {
      const topByAccuracy = [...eligibleAccuracy].sort((a, b) => b.accuracy - a.accuracy)[0];
      if (topByAccuracy && topByAccuracy.accuracy >= 60 && topByAccuracy.playerName !== topByVolume?.playerName) {
        list.push({
          icon: '🎯',
          text: t('home.trivia.topTrainerAccuracy', {
            name: topByAccuracy.playerName,
            pct: Math.round(topByAccuracy.accuracy),
            count: topByAccuracy.totalQuestions,
          }),
        });
      }
    }

    // 31c. Group-wide training volume — the headline number. Only
    //      surface when meaningful (≥ 50 group-wide reps).
    const totalGroupQuestions = trainersWithActivity.reduce((sum, p) => sum + p.totalQuestions, 0);
    if (totalGroupQuestions >= 50) {
      list.push({
        icon: '📚',
        text: t('home.trivia.totalTrainingQuestions', { count: totalGroupQuestions }),
      });
    }

    // 31d. How many players actually train. Surfaces engagement
    //      breadth ("X people are practicing", not just "Y reps")
    //      when the group has multiple trainers.
    if (trainersWithActivity.length >= 3) {
      list.push({
        icon: '👥',
        text: t('home.trivia.activeTrainers', { count: trainersWithActivity.length }),
      });
    }
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
  //
  // We also intentionally drop the variant's `sub` field. The earlier
  // design joined title + sub with " · " into a long line ("ליאור,
  // 92% דיוק · 75% נצחונות · 11 אימונים · ממוצע 67 למשחק"), which
  // wraps to two lines on mobile widths and breaks the dashboard's
  // single-line-subtitle rhythm. The title alone already carries the
  // personalized hook (name + key insight) — sub was supplementary
  // stats that belong on the deeper Statistics screen, not the home
  // landing card. `sub` stays on the function's return type for the
  // moment so the variant pool stays compatible with any future
  // revival, but it's not surfaced anywhere in the UI.
  const { title: message } = useMemo(
    () => buildTrainingMessage(playerName, stats),
    [playerName, stats],
  );
  const subtitle = message;

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

function Pill({ text, tone }: { text: string; tone: 'success' | 'info' | 'warning' }) {
  const palette = (() => {
    switch (tone) {
      case 'success':
        return { bg: 'rgba(16, 185, 129, 0.18)', fg: WIN_COLOR, border: 'rgba(16, 185, 129, 0.4)' };
      case 'warning':
        return { bg: 'rgba(245, 158, 11, 0.20)', fg: '#fbbf24', border: 'rgba(245, 158, 11, 0.45)' };
      case 'info':
      default:
        return { bg: 'rgba(99, 102, 241, 0.16)', fg: '#a5b4fc', border: 'rgba(99, 102, 241, 0.4)' };
    }
  })();
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
