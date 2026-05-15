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

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { GamePlayer, PlayerStats, TrainingPlayerData } from '../types';
import { getAllPolls, getAllGames, getAllGamePlayers, getAllPlayers, getSettings, linkPollToGame } from '../database/storage';
import { computeNextScheduledTrigger } from './ScheduleTab';
import { getGroupId, initSupabaseCache } from '../database/supabaseCache';
import { fetchTrainingAnswers } from '../database/trainingData';
import { formatCurrency, cleanNumber } from '../utils/calculations';
import { useTranslation, type TranslationKey, type Language } from '../i18n';
import { hapticTap } from '../utils/haptics';
import { captureAndSplit, shareFiles } from '../utils/sharing';
import { getSharedProgress, getTrainingSessionCounts } from '../utils/pokerTraining';
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
  const { t, language: i18nLanguage } = useTranslation();
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
  const settings = getSettings();

  // Auto-create anchor for the empty Schedule card. When the group has
  // `scheduleAutoCreateEnabled` set, surface the exact day/date/time
  // the next poll will auto-open so the card stops promising vague
  // "soon" and starts showing reality. The Schedule page renders the
  // same info via `computeNextScheduledTrigger` (now exported from
  // ScheduleTab) — keeping a single source of truth means the home
  // card and /schedule never disagree on the next anchor.
  //
  // Returns `null` when:
  //   * auto-create is disabled (or never configured), OR
  //   * the computation fails (shouldn't happen for valid 0-6 / HH:MM).
  // Callers must handle the null branch with the generic "soon"
  // fallback. Localised to the active language via the day-of-week
  // translation keys we already use for the trivia card.
  const nextAutoPoll = useMemo<{ dayName: string; date: string; time: string } | null>(() => {
    if (settings.scheduleAutoCreateEnabled !== true) return null;
    const day = settings.scheduleAutoCreateDay ?? 0;
    const time = settings.scheduleAutoCreateTime ?? '18:00';
    try {
      const next = new Date(computeNextScheduledTrigger(day, time, new Date()));
      const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
      const dayName = t(`home.trivia.dayOfWeek.${dayKeys[next.getDay()]}` as TranslationKey);
      const date = i18nLanguage === 'he'
        ? next.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' })
        : next.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
      return { dayName, date, time };
    } catch {
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.scheduleAutoCreateEnabled, settings.scheduleAutoCreateDay, settings.scheduleAutoCreateTime, i18nLanguage]);

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

  // ── Sparse-group flag (single safety gate) ──────────────────────
  // Every "smart empty state" branch added for new/sparse groups
  // (Leaderboard warming-up copy, Trivia countdown card, AboutYou
  // hide-on-too-few-facts, PersonalCard hide-on-zero-games) is
  // gated on this flag and ONLY this flag. The threshold of 5
  // matches the trivia countdown's natural unlock point — below 5
  // games the dashboard treats the group as still emerging; at 5
  // games and beyond every card takes its existing code path
  // verbatim. This makes mature-group safety auditable in one
  // place: if isSparseGroup is false, behavior is byte-identical
  // to before this change.
  const groupCompletedGames = useMemo(
    () => allGames.filter(g => g.status === 'completed').length,
    [allGames],
  );
  const isSparseGroup = groupCompletedGames < 5;

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

  // Always land on the Schedule page itself — never auto-open the
  // create-poll modal. The previous shortcut (admin + no active poll
  // → `?action=create-poll`) was a UX mismatch with the empty card's
  // teaser copy ("מי בפנים? ההצבעה הבאה תיפתח בקרוב — לחצו לצפייה
  // בלוח הזמנים"): the user reasonably expects to *see* the schedule,
  // not to be dropped straight into a write-action modal that
  // members can't use anyway. Admins who do want to start a new poll
  // tap the `+` button on the Schedule page itself — one extra tap,
  // worth it for predictable navigation.
  //
  // Destination is the top-level `/schedule` route (promoted out of
  // `/settings?tab=schedule` in v5.60). Old deep links continue to
  // work via the redirect in SettingsScreen.
  const goSchedule = () => {
    hapticTap();
    navigate('/schedule');
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
      {/* Tasks-first ordering: action (New Game) → time-sensitive
          info (Schedule) → personal hook (About You) → recent
          activity (Last Game) → personal numbers (Personal) →
          group context (Leaderboard) → engagement (Training,
          Trivia). Schedule sits above About You because a real
          poll/upcoming game is more urgent than a fun fact about
          yourself, even if you've already voted. */}
      {showAdminCta && <StartNewGameCta order={next()} step={STEP} t={t} onClick={goNewGame} />}
      <ScheduleCard
        order={next()}
        step={STEP}
        t={t}
        poll={activePoll}
        myPlayerId={myStats?.playerId ?? null}
        playerName={effectivePlayerName}
        isAdmin={isAdmin}
        nextAutoPoll={nextAutoPoll}
        onClick={goSchedule}
      />
      {/* "About you" — personal rotating-fact card. Hidden when
          there is no linked player (super-admin observer mode, or
          member who hasn't picked a player yet). The card itself
          returns null when no fact clears its data threshold. */}
      {myStats && playerName && (
        <AboutYouCard
          order={next()}
          step={STEP}
          t={t}
          myStats={myStats}
          allPlayerStats={playerStats}
          games={allGames}
          gamePlayers={allGamePlayers}
          playerName={playerName}
          isSparseGroup={isSparseGroup}
        />
      )}
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
      {/* PersonalCard: in sparse groups (<5 all-time games), hide when
          the viewer has played zero games — three zero-tiles
          ("Games: 0 · Win%: 0% · Total: ₪0") on a brand-new dashboard
          add noise without information. In mature groups (>=5 all-time
          games), keep today's behavior so a new joiner with 0 games
          still sees their (zero) stats card — matches the rest of the
          dashboard which shows real data points there. */}
      {myStats && (myStats.gamesPlayed > 0 || !isSparseGroup) && (
        <PersonalCard order={next()} step={STEP} t={t} stats={myStats} onClick={goPersonal} />
      )}
      <LeaderboardCard
        order={next()}
        step={STEP}
        t={t}
        games={allGames}
        gamePlayers={allGamePlayers}
        playerName={playerName}
        isSparseGroup={isSparseGroup}
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
        isSparseGroup={isSparseGroup}
        groupCompletedGames={groupCompletedGames}
      />
    </div>
  );
}

// ─── Card primitive ─────────────────────────────────────────────────────

interface HomeCardProps {
  order: number;
  step: number;
  // Accepts a string (emoji) or any React node — `TriviaCard` passes
  // a keyed animated span so the per-fact icon slides in alongside
  // the subtitle when the user cycles between facts.
  icon: React.ReactNode;
  title: string;
  // Single line by default; long values are clamped to 2 lines so a
  // long location / fact text never blows the card height out.
  subtitle?: React.ReactNode;
  // Right-aligned slot — pills, cycling indicator, etc.
  accessory?: React.ReactNode;
  // Tiny "tap to …" hint rendered inline RIGHT AFTER the title text
  // (smaller font, muted colour). Used by interactive cards — Trivia,
  // About-You, Training — to surface "tap to play / train" without
  // adding a competing button on a row that's already crowded on
  // mobile (icon + title + chevrons + share). The actual click target
  // is the whole card via `onClick`, not this text — it's a label.
  titleHint?: string;
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
  titleHint,
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
            {titleHint && (
              // Subtle inline hint right after the title — sibling
              // of the title span (NOT nested) so the title can
              // ellipsis-clip independently and the hint survives on
              // narrow screens. `flexShrink: 0` keeps it from being
              // squeezed away when the row is tight; if the whole
              // row overflows, the parent's `flexWrap: 'wrap'` drops
              // the accessory to a second line first.
              <span aria-hidden style={{
                fontSize: '0.66rem',
                fontWeight: 700,
                color: '#ffffff',
                letterSpacing: '0.01em',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}>
                {titleHint}
              </span>
            )}
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
  // Whether the viewer can create polls (admin / owner / super-admin —
  // see App.tsx line ~592 for the union). Only consulted on the
  // empty-state branch, where the CTA flips from member-passive
  // ("next vote opens soon, come back") to admin-active ("open the
  // next poll"). The destination is identical either way — taps land
  // on the top-level `/schedule` route, which is where the `+` button
  // lives.
  isAdmin: boolean;
  // Pre-formatted next-auto-poll anchor when the group has scheduled
  // auto-create enabled — `{ dayName, date, time }` with date already
  // localised. `null` when auto-create is off (or never configured)
  // OR when no poll is currently absent (consumed only on the empty
  // state). Lets the empty subtitle show the concrete day/time
  // instead of a vague "soon" — same computation the Schedule page
  // uses internally so the two surfaces never disagree.
  nextAutoPoll: { dayName: string; date: string; time: string } | null;
  onClick: () => void;
}

function ScheduleCard({ order, step, t, poll, myPlayerId, playerName, isAdmin, nextAutoPoll, onClick }: ScheduleCardProps) {
  if (!poll) {
    // Empty state is purely forward-looking — a teaser inviting the
    // viewer to come back when the next vote opens. We deliberately
    // do NOT mention the most recent past poker night here: the
    // LastGameCard directly below already surfaces that ("המשחק
    // האחרון: יום חמישי 7.5 · מנצח: …"), so duplicating it on this
    // card was redundant and made the dashboard read as backwards-
    // looking. Card click already routes to the schedule polls page,
    // so the CTA in the subtitle is honored.
    //
    // The subtitle has two axes of variation:
    //
    //   1. **Role** — a member sees the passive "next vote opens
    //      soon" / notification-promise teaser, while an admin sees
    //      an active "open the next poll" nudge. The amber accent
    //      on the admin variant mirrors how state 3 (your-vote-is-
    //      waiting) nudges members — same visual language for
    //      "action required from you".
    //
    //   2. **Auto-create configured?** — when the group has
    //      `scheduleAutoCreateEnabled` set, swap in the concrete
    //      day/date/time (`nextAutoPoll`) instead of vague "soon".
    //      This honours the reality that the next poll opens on a
    //      *specific* date the admin already decided; surfacing
    //      that date on Home means members stop wondering when and
    //      admins see a "tap to open one early" framing instead of
    //      a generic "start from scratch" prompt.
    //
    // Tap destination is identical across all four sub-states: the
    // `/schedule` page, where the `+` button lives for admins and
    // the empty-board explainer + history shows for members.
    const subtitleKey: TranslationKey = nextAutoPoll
      ? (isAdmin ? 'home.schedule.emptyHelperAdminAuto' : 'home.schedule.emptyHelperAuto')
      : (isAdmin ? 'home.schedule.emptyHelperAdmin' : 'home.schedule.emptyHelper');
    const subtitle = nextAutoPoll
      ? t(subtitleKey, { dayName: nextAutoPoll.dayName, date: nextAutoPoll.date, time: nextAutoPoll.time })
      : t(subtitleKey);
    return (
      <HomeCard
        order={order}
        step={step}
        icon={isAdmin ? '🗳' : '🗓'}
        title={t(isAdmin ? 'home.schedule.emptyTitleAdmin' : 'home.schedule.emptyTitle')}
        subtitle={subtitle}
        accent={isAdmin ? 'warning' : undefined}
        onClick={onClick}
      />
    );
  }

  const isConfirmed = poll.status === 'confirmed';
  // When the admin hasn't formally pinned a winner but the poll only
  // has one proposed date in the first place, there's nothing to
  // disambiguate — the single date IS the game night. Promote the
  // home card to the same rich layout (date + countdown + location
  // + attendee list) the confirmed branch uses, instead of showing
  // the lean per-date glance-rows view that's only useful when
  // there are multiple options to compare.
  //
  // Both `open` (permanents-only) and `expanded` (guests welcome)
  // count as "still accepting votes" for this branch. Without the
  // expanded check, a single-date poll that auto-promotes to
  // guest-mode would visually regress from the rich view to the
  // lean glance rows, even though the underlying poll is just
  // wider-audience now — same date, same need for the rich view.
  const isOpenSingleDate = (poll.status === 'open' || poll.status === 'expanded') && poll.dates.length === 1;

  // Shared renderer for the "rich" date-pinned card visual. Reused
  // by State 2 (poll explicitly confirmed by admin) and the
  // single-date open shortcut. Closes over `poll`, `t`, `order`,
  // `step`, `onClick` from the enclosing `ScheduleCard` scope.
  //
  //   - `dateId === null/undefined` → renders just the title +
  //     `confirmedHelper` subtitle. Edge case where State 2 was
  //     reached without a pinned date set; pre-refactor code
  //     handled it, so we keep parity.
  //   - `awaitingViewer === true` → prepends a subtle amber
  //     "מחכים להצבעה שלך" segment to the subtitle so the calm
  //     green card still nudges a non-voter. Only true on the
  //     single-date open path, and only when we know the viewer's
  //     playerId (observers stay calm — no nudge for users not
  //     linked to a player).
  //   - `emptyFallback === true` → renders the "עדיין אין הצבעות
  //     - לחצו כדי להצביע" body when no one has said yes yet, so
  //     the card isn't visually empty on a freshly-opened single-
  //     date poll and the CTA stays visible.
  //
  // Subtitle structure mirrors the original inline implementation:
  // a fragment of `whiteSpace: 'nowrap'` segments separated by
  // styled `·` dividers, so on narrow screens the line either fits
  // intact or breaks cleanly between segments — never mid-phrase,
  // never leaving a "·" stranded at the start of the next line.
  const renderRichDateCard = (opts: {
    dateId: string | null | undefined;
    awaitingViewer: boolean;
    emptyFallback: boolean;
    // Title/icon vary by branch so we don't lie about pin status:
    //   - Confirmed branch → `🎯 ערב פוקר נקבע`  (date is locked)
    //   - Single-date open → `🗳 הצבעה פתוחה`    (still accepting
    //     votes; the rich body just makes participation visible
    //     earlier than waiting for a formal pin)
    // The body, accent, pills, click target, and layout primitive
    // are identical across branches — only the header copy/icon
    // shifts to honor the actual poll state.
    titleKey: TranslationKey;
    icon: string;
    // Auto-promote to the confirmed-style header (`🎯 ערב פוקר
    // נקבע`) the moment the poll has gathered enough yes-votes to
    // hit `targetPlayerCount`, even when the admin hasn't formally
    // pinned. For a single-date open poll, "everyone said yes"
    // captures the de-facto "we have a game" state — pinning at
    // that point is pure ceremony, and showing "הצבעה פתוחה" on a
    // visibly-full card under-sells the moment. We also suppress
    // the awaiting-viewer subtitle nudge when elevated, because
    // the game is happening regardless of whether THIS viewer
    // weighed in.
    //
    // The confirmed branch passes false here — by definition it's
    // already showing the celebratory header.
    elevateWhenFilled: boolean;
  }): React.ReactElement => {
    let dateLabel = '';
    let countdown: string | null = null;
    let location: string | null = null;
    let missingSeats = 0;
    let comingNames: string[] = [];

    if (opts.dateId) {
      const d = poll.dates.find(x => x.id === opts.dateId);
      if (d?.proposedDate) {
        const dt = new Date(`${d.proposedDate}T${d.proposedTime || '20:00'}`);
        dateLabel = dt.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric' });
        if (d.proposedTime) {
          dateLabel += ` · ${d.proposedTime.slice(0, 5)}`;
        }
        countdown = computeCountdown(d.proposedDate, d.proposedTime, t);
        location = (d.location && d.location.trim()) || (poll.defaultLocation && poll.defaultLocation.trim()) || null;
      }
      const yesVotes = poll.votes.filter(v => v.dateId === opts.dateId && v.response === 'yes');
      missingSeats = Math.max(0, poll.targetPlayerCount - yesVotes.length);
      const playersById = new Map(getAllPlayers().map(p => [p.id, p.name]));
      comingNames = yesVotes
        .map(v => playersById.get(v.playerId))
        .filter((name): name is string => Boolean(name));
    }

    // A single-date open poll that hits its target seat count is
    // de-facto a confirmed game night — promote the header to the
    // celebratory variant and drop the "still waiting on you" nudge,
    // because nobody is actually waiting at that point.
    //
    // We trust `missingSeats === 0` as the authoritative "filled"
    // signal (it's computed from the raw yesVotes.length vs target).
    // Deliberately NOT gating on `comingNames.length >= target` —
    // `comingNames` is filtered to known players via the players
    // cache, and during a stale-cache window a yes-voter's player
    // record may briefly be missing, dropping the visible name
    // count below target while the poll IS actually filled. In
    // that scenario we'd rather celebrate honestly (and show fewer
    // names) than show a contradictory "still open" header on a
    // green-accented card.
    //
    // The `comingNames.length > 0` guard prevents elevation of a
    // theoretical 0-target poll (UI prevents target < 4; this is
    // pure defense to keep the helper composable).
    const filled = opts.elevateWhenFilled
      && missingSeats === 0
      && comingNames.length > 0;
    const effectiveTitleKey: TranslationKey = filled
      ? 'home.schedule.confirmedTitle'
      : opts.titleKey;
    const effectiveIcon = filled ? '🎯' : opts.icon;
    const effectiveAwaiting = filled ? false : opts.awaitingViewer;

    const subtitle = dateLabel ? (
      <>
        {effectiveAwaiting && (
          <span style={{ whiteSpace: 'nowrap', color: 'rgba(245, 158, 11, 0.95)', fontWeight: 600 }}>
            {t('home.schedule.singleDateAwaitingYou')}
          </span>
        )}
        <span style={{ whiteSpace: 'nowrap' }}>
          {effectiveAwaiting && <span style={{ marginInline: '0.4rem', opacity: 0.6 }}>·</span>}
          {dateLabel}
        </span>
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
    //
    // When `emptyFallback` is true and nobody has voted yes yet,
    // we substitute a "no votes yet - tap to vote" line so the
    // card stays visually full and the CTA is explicit. Without
    // the fallback (confirmed branch), the body simply collapses
    // to null — preserving pre-refactor behavior for the edge
    // case where State 2 has zero yes-voters.
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
    } else if (opts.emptyFallback) {
      comingBody = (
        <div style={{
          fontSize: '0.7rem',
          color: 'var(--text-muted)',
          paddingTop: '0.4rem',
          borderTop: '1px solid rgba(255,255,255,0.06)',
          lineHeight: 1.5,
          wordBreak: 'break-word',
          fontStyle: 'italic',
          opacity: 0.85,
        }}>
          {t('home.schedule.singleDateNoCommitments')}
        </div>
      );
    }

    return (
      <HomeCard
        order={order}
        step={step}
        icon={effectiveIcon}
        title={t(effectiveTitleKey)}
        subtitle={subtitle}
        accessory={accessory}
        accent={accent}
        body={comingBody}
        onClick={onClick}
      />
    );
  };

  if (isConfirmed) {
    return renderRichDateCard({
      dateId: poll.confirmedDateId,
      awaitingViewer: false,
      emptyFallback: false,
      titleKey: 'home.schedule.confirmedTitle',
      icon: '🎯',
      elevateWhenFilled: false,
    });
  }

  if (isOpenSingleDate) {
    // We nudge the viewer only when (1) they're linked to a player
    // — observers without `myPlayerId` aren't expected to vote and
    // a nudge would be misleading — and (2) they haven't yet
    // recorded any response on the only proposed date. Once they
    // vote (yes/no/maybe), the calm green State-2 visual is the
    // right read and we drop the prefix.
    const hasMyVoteOnSingle = myPlayerId !== null && poll.votes.some(v => v.playerId === myPlayerId);
    return renderRichDateCard({
      dateId: poll.dates[0].id,
      awaitingViewer: myPlayerId !== null && !hasMyVoteOnSingle,
      emptyFallback: true,
      titleKey: 'home.schedule.openTitle',
      icon: '🗳',
      elevateWhenFilled: true,
    });
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
  // True iff the group has fewer than 5 completed all-time games. The
  // ONLY gate that controls the new "warming up" branch — mature
  // groups (>=5 all-time games) always pass this as false and take
  // the same code paths they did before this change.
  isSparseGroup: boolean;
  onClick: () => void;
}

function LeaderboardCard({ order, step, t, games, gamePlayers, playerName, isSparseGroup, onClick }: LeaderboardProps) {
  const { top3, monthLabel, hasAnyCompletedGames, monthGameCount, monthDistinctPlayers } = useMemo(() => {
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
        monthGameCount: 0,
        monthDistinctPlayers: 0,
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
      monthGameCount: monthGameIds.size,
      monthDistinctPlayers: byPlayer.size,
    };
  }, [games, gamePlayers]);

  // Title carries the month inline ("מובילי החודש · מאי 2026")
  // instead of a separate subtitle line — the user wants the period
  // labelled in the heading, not as supplementary copy. We keep the
  // full localized "monthLabel" rather than a short form so the year
  // is visible too (matters in January when "מאי" alone could be
  // last year's results coming back into the rolling window).
  const titleWithMonth = `${t('home.leaderboard.title')} · ${monthLabel}`;

  // Brand-new group (zero completed games all-time) — render a
  // visible preview of the leaderboard card instead of hiding it.
  // The blue NewGroupTeaserCard already lists "leaderboard" as a
  // promised feature, but a real card placeholder gives the new
  // admin a more concrete glance of what the dashboard will look
  // like. Mature groups (>=5 all-time games) NEVER reach this
  // branch — `hasAnyCompletedGames` is always true for them.
  if (!hasAnyCompletedGames) {
    return (
      <HomeCard
        order={order}
        step={step}
        icon="🏅"
        title={titleWithMonth}
        subtitle={t('home.leaderboard.previewBrandNew')}
        onClick={onClick}
      />
    );
  }

  // Sparse-group warming-up state: at least one game has happened
  // this month but the data is too thin to crown anyone (only one
  // distinct player has played, OR only one game total). Crowning
  // a single player with a 100% win rate after their first night
  // is misleading — the warming-up copy keeps the card visible
  // and forward-looking until a 2nd player or 2nd game arrives.
  // Gated on `isSparseGroup` so MATURE groups (>=5 all-time games)
  // continue to render their existing top-3 table for the very
  // first game of a new month, exactly as before this change.
  if (isSparseGroup && monthGameCount > 0 && (monthDistinctPlayers < 2 || monthGameCount < 2)) {
    return (
      <HomeCard
        order={order}
        step={step}
        icon="🏅"
        title={titleWithMonth}
        subtitle={t('home.leaderboard.warmingUp')}
        onClick={onClick}
      />
    );
  }

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
  // True iff the group has fewer than 5 completed all-time games.
  // ONLY gate on the new countdown branch — mature groups always
  // pass false here and take the existing RotatingFactCard path,
  // even in legitimately sparse early-year cases (e.g. Jan 5 with
  // 0 year-to-date games but 50 all-time).
  isSparseGroup: boolean;
  // Completed all-time game count, used to compute the user-visible
  // countdown ("עוד N משחקים והטריוויה נדלקת"). Only consulted
  // inside the sparse-group branch.
  groupCompletedGames: number;
}

function TriviaCard({
  order,
  step,
  t,
  games,
  gamePlayers,
  playerStats,
  trainingPlayers,
  isSparseGroup,
  groupCompletedGames,
}: TriviaProps) {
  const { language } = useTranslation();
  const navigate = useNavigate();
  const trivia = useMemo(
    () => buildTriviaList(games, gamePlayers, playerStats, trainingPlayers, t, language),
    [games, gamePlayers, playerStats, trainingPlayers, t, language],
  );

  // Daily-rotating start point — every device sees the same fact on
  // any given UTC day, then the user can cycle from there. Computed
  // unconditionally (BEFORE the sparse-group branch below) so the
  // hook order is stable across renders even if the group crosses
  // the 5-game boundary mid-session.
  const initialIndex = useMemo(() => {
    if (trivia.length === 0) return 0;
    const dayOfYear = Math.floor(
      (Date.now() - new Date(new Date().getUTCFullYear(), 0, 0).getTime()) / 86_400_000,
    );
    return dayOfYear % trivia.length;
  }, [trivia.length]);

  // ── Sparse-group countdown branch ──────────────────────────────
  // For brand-new (0 games) and sparse-data (1-4 games) groups
  // where the trivia generator hasn't produced enough material to
  // make a real rotation, replace the RotatingFactCard with a tiny
  // teaser card that explicitly tells the user how many more games
  // until the trivia pool unlocks. Gated on isSparseGroup so MATURE
  // groups (>=5 all-time games) NEVER hit this branch — they
  // continue to render the existing RotatingFactCard with whatever
  // facts exist, including the legitimate early-January sparse
  // case where year-to-date is empty.
  //
  // The `groupCompletedGames === 0` case is intentionally INCLUDED
  // here so brand-new groups see the countdown ("עוד 5 משחקים
  // והטריוויה נדלקת") instead of the card disappearing entirely.
  // This gives the 0-game dashboard one more concrete preview of
  // a feature that's coming, alongside the LeaderboardCard preview
  // and the NewGroupTeaserCard list.
  if (isSparseGroup && trivia.length < 5) {
    const remaining = Math.max(0, 5 - groupCompletedGames);
    const subtitle = remaining === 1
      ? t('home.trivia.warmingUpOne')
      : t('home.trivia.warmingUpCountdown', { n: remaining });
    return (
      <HomeCard
        order={order}
        step={step}
        icon="💡"
        title={t('home.trivia.title')}
        subtitle={subtitle}
      />
    );
  }

  return (
    <RotatingFactCard
      order={order}
      step={step}
      title={t('home.trivia.title')}
      shareLabel={t('home.trivia.shareLabel')}
      prevLabel={t('home.trivia.prevLabel')}
      nextLabel={t('home.trivia.nextLabel')}
      facts={trivia}
      initialIndex={initialIndex}
      storageKey="home.trivia.lastIndex"
      playCta={{
        label: t('home.trivia.playGroup'),
        icon: '🎮',
        // Land on the trivia landing screen with NO preset — the
        // landing defaults to 'mixed' mode (🎲 הכל, the broadest
        // pool covering both group + players questions). The user
        // reviews the leaderboard + length picker, then taps Start.
        // Earlier behaviour (preset=group) skipped that review step
        // and locked them into a narrower pool, which the user
        // explicitly didn't want.
        onClick: () => navigate('/trivia'),
      }}
    />
  );
}

// ─── Shared rotating-fact card ──────────────────────────────────────────
//
// Generic rotating-fact UI used by `TriviaCard` and `AboutYouCard`.
// Owns: directional slide animation, prev/next/share controls, daily
// rotation start point, card-tap-to-advance shortcut. Knows nothing
// about the source of the facts — pass them in already-built.
//
// Returns `null` for an empty fact list so callers don't need to
// wrap in conditionals.
interface RotatingFactCardProps {
  order: number;
  step: number;
  title: string;
  shareLabel: string;
  prevLabel: string;
  nextLabel: string;
  facts: { icon: string; text: string }[];
  initialIndex?: number;
  // Optional accent for the surrounding HomeCard so personal cards
  // can stand out from generic group trivia (e.g. `'info'` blue tint).
  accent?: 'default' | 'success' | 'warning' | 'info';
  // When set, the current fact index is persisted to `sessionStorage`
  // under this key so navigating away from the dashboard and back
  // RESUMES the user's last position instead of jumping back to the
  // daily-rotation seed. Cleared when the tab closes, so the next
  // session opens fresh on today's daily-seed fact again.
  storageKey?: string;
  // Optional inline CTA rendered as a small pill below the fact text.
  // Used by both trivia cards to launch the trivia-quiz screen from
  // the same surface where the user is already engaging with facts.
  playCta?: {
    label: string;
    onClick: () => void;
    icon?: string;
  };
}

function RotatingFactCard({
  order,
  step,
  title,
  shareLabel,
  prevLabel,
  nextLabel,
  facts,
  initialIndex = 0,
  accent,
  storageKey,
  playCta,
}: RotatingFactCardProps) {
  const { language } = useTranslation();
  // Off-screen styled card that gets rasterised by html2canvas on
  // share. Rendered into a fixed-position div so it never affects
  // layout and never appears to the user. We always keep it mounted
  // so the share path can capture it on the very first tap without
  // a render-then-capture roundtrip (avoids the "first share misses"
  // race the PollCard share has to work around).
  const shareCardRef = useRef<HTMLDivElement>(null);
  const [isSharing, setIsSharing] = useState(false);
  // Tracks the last cycle direction so the slide animation knows
  // which side new content should arrive from. 'next' = forward,
  // 'back' = previous. We treat the chevrons as universal icons
  // (Western pagination convention: `‹` = previous, `›` = next)
  // regardless of page language, so the slide direction is also
  // universal: tapping `›` → new content enters from the right
  // and pushes leftward; tapping `‹` → enters from the left and
  // pushes rightward. This matches every browser/video-player
  // pagination in the world and avoids the "wait, the LEFT arrow
  // advances?" cognitive friction that an RTL-aware swap creates.
  const [direction, setDirection] = useState<'next' | 'back'>('next');
  // Lazy initializer reads the resumed index from sessionStorage on
  // first render so the user lands BACK on the fact they were
  // looking at before navigating away. Falls back to the daily-
  // rotation seed (`initialIndex`) when no saved value exists or
  // the saved value is out of bounds (facts list changed length).
  const [index, setIndex] = useState(() => {
    if (!storageKey || typeof window === 'undefined') return initialIndex;
    const raw = window.sessionStorage.getItem(storageKey);
    if (raw === null) return initialIndex;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed >= facts.length) return initialIndex;
    return parsed;
  });
  // When the underlying facts list changes length (data arrived async,
  // a fact's threshold flipped, etc.) keep the displayed index in
  // bounds — without this, an out-of-range index would briefly
  // render undefined → crash on `.icon` access.
  useEffect(() => {
    if (facts.length === 0) return;
    if (index >= facts.length) setIndex(initialIndex % facts.length);
  }, [facts.length, index, initialIndex]);

  if (facts.length === 0) return null;

  const safeIndex = index % facts.length;
  const pick = facts[safeIndex];
  const canCycle = facts.length > 1;

  const cycle = (delta: 1 | -1) => {
    if (!canCycle) return;
    hapticTap();
    setDirection(delta === 1 ? 'next' : 'back');
    setIndex(i => {
      const next = (i + delta + facts.length) % facts.length;
      // Persist position so the next mount (after route change /
      // tab switch / dashboard remount) resumes here instead of
      // jumping back to the daily seed.
      if (storageKey && typeof window !== 'undefined') {
        try { window.sessionStorage.setItem(storageKey, String(next)); }
        catch { /* storage full / disabled — non-fatal, just lose resume */ }
      }
      return next;
    });
  };

  // Universal chevron semantics → universal slide direction.
  //   next (›) → new content enters from the right, slides left
  //   back (‹) → new content enters from the left,  slides right
  const animationName = direction === 'next'
    ? 'triviaSlideFromRight'
    : 'triviaSlideFromLeft';
  const animation = `${animationName} 0.32s cubic-bezier(0.2, 0.8, 0.2, 1)`;
  // Keying both the icon span and the subtitle span with the same
  // (index, direction) tuple guarantees React remounts them in
  // lockstep so the animation runs in perfect sync. The HomeCard
  // wrapper itself is NOT remounted, so the staggered entrance
  // animation only fires on initial mount — not on every cycle.
  const animKey = `${safeIndex}-${direction}`;

  const animatedIcon = (
    <span
      key={animKey}
      style={{ display: 'inline-block', animation, willChange: 'transform, opacity' }}
    >
      {pick.icon}
    </span>
  );

  // Animated text span — rebuilt and remounted on every fact cycle
  // (via `key={animKey}`) so the slide animation runs each time. The
  // share button is intentionally a separate sibling (composed below)
  // and DOES NOT carry the animation key, so it stays visually put
  // while the text slides in/out around it.
  const animatedTextSpan = (
    <span
      key={animKey}
      style={{
        flex: 1,
        minWidth: 0,
        display: 'block',
        animation,
        willChange: 'transform, opacity',
      }}
    >
      {pick.text}
    </span>
  );

  // Share / prev / counter / next controls. Each button stops
  // propagation so the surrounding card-tap (which still cycles
  // forward as a shortcut) does not also fire. 26 px buttons sit
  // comfortably above the 24 px accessibility minimum without
  // dominating the card header on narrow phones.
  const ctrlBtnStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 26,
    height: 26,
    borderRadius: 6,
    border: 'none',
    background: 'rgba(255,255,255,0.05)',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    fontSize: '1rem',
    fontWeight: 700,
    lineHeight: 1,
    padding: 0,
    transition: 'background 0.15s ease, color 0.15s ease',
  };
  // The chevron buttons get a tighter weight + slightly bigger
  // glyph so the `‹ › ` arrows read crisply. They're also bumped
  // to 32 px (vs the 26 px base) so the touch target is forgiving
  // on mobile — at 26 px users routinely missed the button and
  // the surrounding card-tap fired instead, sending them to the
  // trivia game by mistake. 32 px is still well below the dominant
  // visual elements but lifts the hit area above the iOS ~32 px
  // accidental-tap threshold.
  const chevronBtnStyle: React.CSSProperties = {
    ...ctrlBtnStyle,
    width: 32,
    height: 32,
    fontSize: '1.15rem',
    fontWeight: 400,
    fontFamily: 'system-ui, -apple-system, sans-serif',
  };
  // Share button uses the app-wide 📤 emoji so it visually matches
  // every other share affordance (settings, schedule, summary,
  // graphs, stats). The emoji is intentionally rendered slightly
  // smaller than the icon size so it doesn't dominate the row.
  const shareBtnStyle: React.CSSProperties = {
    ...ctrlBtnStyle,
    fontSize: '0.85rem',
  };

  // Image-based share — matches the rest of the app (poll cards,
  // game-summary cards, comic, etc.). The off-screen styled card
  // is captured with html2canvas and handed to navigator.share as
  // a PNG file; falls back to direct download if the platform
  // can't accept files. Reentrancy guarded by `isSharing` so a
  // double-tap on the share button can't fire two captures in
  // parallel.
  const handleShare = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isSharing) return;
    hapticTap();
    setIsSharing(true);
    try {
      // Wait one paint so React commits the *current* fact's text
      // into the off-screen share card (the user could have
      // chevroned to a new fact in the same render cycle the
      // share button consumed).
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (!shareCardRef.current) return;
      const safeTitle = title.replace(/[^\w\u0590-\u05FF\-_.]/g, '_');
      const files = await captureAndSplit(shareCardRef.current, `poker-${safeTitle}-${safeIndex + 1}`, {
        backgroundColor: '#0f172a',
      });
      await shareFiles(files, title);
    } catch {
      /* silent — html2canvas / share rejection shouldn't surface
         a banner; user simply tries again. */
    } finally {
      setIsSharing(false);
    }
  };

  // Lock the controls strip to LTR direction so the chevron
  // glyphs always render in the order [‹ 2/N ›] regardless of
  // the page language. Without this lock, a Hebrew (RTL) page
  // visually mirrors the row → the LEFT chevron ends up being
  // "next" which contradicts the Western pagination convention
  // every web user expects (`‹` = back, `›` = next).
  //
  // The wrapper carries an `onClick` that calls `stopPropagation`,
  // which turns the entire accessory area (chevrons + counter +
  // the gaps between them + the negative-margin/padding safe-zone)
  // into a "no-navigate" region. Without this, a mobile user who
  // taps a few pixels off the chevron ends up triggering the
  // surrounding card-tap and getting whisked to the trivia game.
  // The padding/negative-margin pair grows the safe zone WITHOUT
  // shifting the visible layout — the row still aligns the same
  // way, but the touch-safe envelope around the controls is ~14 px
  // larger on every side.
  const accessory = (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.3rem',
        direction: 'ltr',
        padding: '6px 8px',
        margin: '-6px -8px',
      }}
    >
      {canCycle && (
        <>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); cycle(-1); }}
            title={prevLabel}
            aria-label={prevLabel}
            style={chevronBtnStyle}
          >
            ‹
          </button>
          <span style={{
            fontSize: '0.65rem',
            color: 'var(--text-muted)',
            fontWeight: 600,
            opacity: 0.85,
            fontFeatureSettings: '"tnum"',
            minWidth: 28,
            textAlign: 'center',
            userSelect: 'none',
          }}>
            {safeIndex + 1}/{facts.length}
          </span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); cycle(1); }}
            title={nextLabel}
            aria-label={nextLabel}
            style={chevronBtnStyle}
          >
            ›
          </button>
        </>
      )}
    </div>
  );

  // Share button lives INLINE with the subtitle row, anchored to the
  // visual-LEFT side (in RTL Hebrew, that's the inline-END edge —
  // where the subtitle text naturally trails off). The subtitle text
  // takes the remaining width and wraps inside its own column when
  // needed. This keeps the share affordance discoverable without:
  //   • crowding the title row (previous design — too many controls)
  //   • stealing a full row at the bottom (previous design — wasted
  //     vertical space for a single 26 px icon)
  //   • absolute-positioning over the subtitle (previous design —
  //     forced a bottom-padding bump and risked text overlap)
  // Wrapped in a `stopPropagation` span with the same safe-zone
  // padding as the chevron accessory — a tap immediately around
  // the share button (the gap between subtitle text and the icon,
  // a slightly off-button miss) stays inert instead of bubbling
  // to the card-tap-to-play handler. The button itself still calls
  // `stopPropagation` in `handleShare` so the wrapper is defensive,
  // not load-bearing.
  const shareNode = (
    <span
      onClick={(e) => e.stopPropagation()}
      style={{
        display: 'inline-flex',
        padding: '6px 8px',
        margin: '-6px -8px',
        flexShrink: 0,
      }}
    >
      <button
        type="button"
        onClick={handleShare}
        title={shareLabel}
        aria-label={shareLabel}
        style={shareBtnStyle}
      >
        📤
      </button>
    </span>
  );

  // Final composed subtitle: animated text + share button on the same
  // row. `flexWrap: 'nowrap'` keeps both children on the SAME flex
  // line — the text wraps INTERNALLY (because the text span has
  // `flex: 1` + `minWidth: 0`) instead of dropping the share button
  // to a new row. `alignItems: 'flex-start'` anchors the share button
  // to the top of the subtitle so it stays aligned with the FIRST
  // line of fact text even when the text wraps to a 2nd or 3rd line.
  const composedSubtitle = (
    <div style={{
      display: 'flex',
      flexWrap: 'nowrap',
      alignItems: 'flex-start',
      gap: '0.5rem',
      width: '100%',
    }}>
      {animatedTextSpan}
      {shareNode}
    </div>
  );

  // Whole-card tap behaviour:
  //   - When the card has a play CTA (Trivia, About-You), tap launches
  //     the trivia game. Fact navigation moves to the chevrons + the
  //     "tap to play" hint makes the new affordance discoverable.
  //   - Otherwise (no playCta passed), tap still advances to the next
  //     fact — the original behaviour for any rotating-fact use that
  //     doesn't have a paired action.
  const handleClick = playCta
    ? () => { hapticTap(); playCta.onClick(); }
    : (canCycle ? () => cycle(1) : undefined);

  return (
    <>
      <HomeCard
        order={order}
        step={step}
        icon={animatedIcon}
        title={title}
        subtitle={composedSubtitle}
        accessory={accessory}
        // Disable HomeCard's default 2-line ellipsis clamp on the
        // subtitle. The clamp uses `display: -webkit-box` which is
        // incompatible with our composed flex layout (text + share
        // share the row). The user explicitly asked for the text to
        // WRAP rather than truncate when it gets too long, so this
        // is the correct trade-off — cards may grow taller for very
        // long facts, which is acceptable.
        subtitleClamp={0}
        titleHint={playCta?.label}
        accent={accent}
        onClick={handleClick}
      />
      {/* Off-screen share-card target. Always rendered (not gated
          on `isSharing`) so the very first share has a stable DOM
          node to capture without a render-then-capture race. The
          card is positioned far off-screen with `aria-hidden` and
          `pointer-events: none` so it's invisible and inert. */}
      <FactShareCard
        ref={shareCardRef}
        title={title}
        icon={pick.icon}
        text={pick.text}
        language={language}
      />
    </>
  );
}

// ─── Off-screen styled share card ───────────────────────────────────────
//
// Premium-styled, brand-aligned card rendered far off-screen and
// rasterised by html2canvas when the user taps the trivia / about-you
// share button. Single PNG output (no slicing needed — the card is
// designed to be one square-ish image well under the share-splitter's
// MAX_SLICE_HEIGHT). Layout choices:
//   - Fixed 600 px CSS width so html2canvas captures consistently
//     across devices regardless of their viewport width.
//   - Vertical gradient with the same #0f172a base as every other
//     share card in the app, so a thread of "Poker Manager" shares
//     reads as one coherent visual brand.
//   - Direction follows the page language so the fact text wraps
//     naturally in Hebrew RTL or English LTR.
//   - Footer carries "Poker Manager 🎲" in muted color so the share
//     attributes the source without dominating the artwork.
interface FactShareCardProps {
  title: string;
  icon: string;
  text: string;
  language: Language;
}

const FactShareCard = (() => {
  const Inner = (
    { title, icon, text, language }: FactShareCardProps,
    ref: React.Ref<HTMLDivElement>,
  ) => {
    const isHebrew = language === 'he';
    return (
      <div
        ref={ref}
        aria-hidden
        style={{
          position: 'fixed',
          top: -10000,
          left: -10000,
          width: 600,
          padding: '2.25rem 2rem 1.6rem',
          borderRadius: 24,
          background: 'linear-gradient(160deg, #1e293b 0%, #0f172a 60%, #020617 100%)',
          color: '#f1f5f9',
          fontFamily: '"Outfit", system-ui, -apple-system, sans-serif',
          direction: isHebrew ? 'rtl' : 'ltr',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
          pointerEvents: 'none',
          display: 'flex',
          flexDirection: 'column',
          gap: '1.4rem',
        }}
      >
        {/* Title chip + brand row */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.75rem',
        }}>
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '0.35rem 0.85rem',
            background: 'rgba(96, 165, 250, 0.15)',
            color: '#93c5fd',
            borderRadius: 999,
            fontSize: '0.85rem',
            fontWeight: 700,
            letterSpacing: '0.02em',
          }}>
            {title}
          </span>
          <span style={{
            fontSize: '0.78rem',
            fontWeight: 600,
            color: 'rgba(241, 245, 249, 0.55)',
            letterSpacing: '0.04em',
          }}>
            🎲 Poker Manager
          </span>
        </div>

        {/* Big icon */}
        <div style={{
          fontSize: '4rem',
          lineHeight: 1,
          textAlign: isHebrew ? 'right' : 'left',
        }}>
          {icon}
        </div>

        {/* Fact text */}
        <div style={{
          fontSize: '1.55rem',
          lineHeight: 1.45,
          fontWeight: 600,
          color: '#f8fafc',
          textAlign: isHebrew ? 'right' : 'left',
          // Slight letter-spacing eases readability of the long
          // Hebrew strings these facts often produce.
          letterSpacing: '0.005em',
        }}>
          {text}
        </div>

        {/* Footer divider */}
        <div style={{
          marginTop: '0.4rem',
          paddingTop: '1rem',
          borderTop: '1px solid rgba(241, 245, 249, 0.1)',
          fontSize: '0.75rem',
          color: 'rgba(241, 245, 249, 0.45)',
          textAlign: 'center',
          letterSpacing: '0.03em',
        }}>
          {isHebrew ? 'מתוך עמוד הבית · Poker Manager' : 'From the home dashboard · Poker Manager'}
        </div>
      </div>
    );
  };
  Inner.displayName = 'FactShareCard';
  return React.forwardRef(Inner);
})();

// ─── About-you (personal trivia) ────────────────────────────────────────
//
// Renders a rotating fact card focused entirely on the logged-in
// player. Uses the same UX as the group `TriviaCard` (animated
// slide, prev/next/share, tap-to-cycle) but the fact pool comes
// from `buildPersonalFactsList`, which mines the player's own game
// history for personal records, recent form, head-to-head data, etc.
//
// Visibility rules:
//   - Hidden entirely when `playerName` is null (super-admin in
//     observer mode, or a member who hasn't linked a player yet).
//   - Hidden when the fact pool is empty (brand-new players with
//     zero completed games, or players whose data doesn't clear
//     any fact threshold). The component returns null via the
//     `RotatingFactCard` empty-list guard.
//   - The daily rotation is salted by player name so two players
//     looking at the home screen on the same day see DIFFERENT
//     opening facts (vs. the group trivia, which is identical
//     across all members).
interface AboutYouCardProps extends SectionProps {
  myStats: PlayerStats;
  allPlayerStats: PlayerStats[];
  games: ReturnType<typeof getAllGames>;
  gamePlayers: ReturnType<typeof getAllGamePlayers>;
  playerName: string;
  // True iff the group has fewer than 5 completed all-time games.
  // ONLY gate on the "hide when facts < 2" tightening — mature
  // groups (>=5 all-time games) keep today's behavior, including
  // the edge case of a new joiner with a single fact rendering
  // a non-rotating one-fact card.
  isSparseGroup: boolean;
}

function AboutYouCard({
  order,
  step,
  t,
  myStats,
  allPlayerStats,
  games,
  gamePlayers,
  playerName,
  isSparseGroup,
}: AboutYouCardProps) {
  const { language } = useTranslation();
  const navigate = useNavigate();
  const facts = useMemo(
    () => buildPersonalFactsList(myStats, allPlayerStats, games, gamePlayers, playerName, t, language),
    [myStats, allPlayerStats, games, gamePlayers, playerName, t, language],
  );

  // Daily rotation salted by player name, so two players on the
  // same day land on different opening facts.
  const initialIndex = useMemo(() => {
    if (facts.length === 0) return 0;
    const dayOfYear = Math.floor(
      (Date.now() - new Date(new Date().getUTCFullYear(), 0, 0).getTime()) / 86_400_000,
    );
    let nameHash = 0;
    for (let i = 0; i < playerName.length; i++) {
      nameHash = ((nameHash << 5) - nameHash + playerName.charCodeAt(i)) | 0;
    }
    return Math.abs(dayOfYear + nameHash) % facts.length;
  }, [facts.length, playerName]);

  // Sparse-group only: hide the card when there's less than two
  // facts to rotate through. With one fact the chevrons hint at a
  // rotation that doesn't deliver — the user taps "next" and
  // nothing changes. Cleaner to hide entirely in this state.
  // Gated on isSparseGroup so MATURE groups (>=5 all-time games)
  // keep today's behavior — even the edge case of a brand-new
  // joiner of an established group whose single fact would render
  // a non-rotating card. (RotatingFactCard already returns null
  // for an empty list, so the 0-fact case is handled regardless.)
  if (isSparseGroup && facts.length < 2) return null;

  return (
    <RotatingFactCard
      order={order}
      step={step}
      title={t('home.aboutYou.title')}
      shareLabel={t('home.trivia.shareLabel')}
      prevLabel={t('home.trivia.prevLabel')}
      nextLabel={t('home.trivia.nextLabel')}
      facts={facts}
      initialIndex={initialIndex}
      storageKey={`home.aboutYou.lastIndex.${playerName}`}
      playCta={{
        label: t('home.trivia.playPlayers'),
        icon: '🎮',
        // Land on the trivia landing screen with NO preset — the
        // landing defaults to 'mixed' mode (🎲 הכל). Mirrors the
        // same UX as the group-trivia card so both home CTAs feel
        // consistent. Earlier behaviour (preset=players) locked the
        // user into a narrower pool without their input.
        onClick: () => navigate('/trivia'),
      }}
    />
  );
}

// Builds the personal-facts pool for one player. Each entry is
// gated by a data threshold so we never show "Your win rate: 0%
// (0 of 0)" or "Your nemesis: nobody beat you yet" on a brand-new
// player. Order is intentional: more emotionally engaging facts
// (best/worst night, current streak) lead the rotation.
function buildPersonalFactsList(
  myStats: PlayerStats,
  allPlayerStats: PlayerStats[],
  games: ReturnType<typeof getAllGames>,
  gamePlayers: ReturnType<typeof getAllGamePlayers>,
  playerName: string,
  t: SectionProps['t'],
  language: Language,
): { icon: string; text: string }[] {
  const facts: { icon: string; text: string }[] = [];

  // ── Pre-aggregations shared by multiple facts ──────────────────
  // The PersonalCard already shows raw numbers (total profit,
  // win count, win %, current streak, biggest win magnitude,
  // avg/game, longest streak). Everything in THIS list must add
  // information beyond those tiles — context the player can't
  // see anywhere else on the dashboard.
  const gameDateById = new Map<string, string>();
  const completedGameIds = new Set<string>();
  for (const g of games) {
    if (g.status === 'completed') {
      completedGameIds.add(g.id);
      gameDateById.set(g.id, g.date || g.createdAt);
    }
  }

  // All `game_players` rows for THIS player across completed games.
  const myGP = gamePlayers.filter(gp => gp.playerName === playerName && completedGameIds.has(gp.gameId));
  const myGameIds = new Set(myGP.map(gp => gp.gameId));

  // gameId → (playerName → profit) for every game I've sat in.
  // The single most expensive thing in this function; built once
  // and reused by lucky-charm, jinx, nemesis, podium, finish-mode,
  // and outscored-opponent computations.
  const profitsByGameByPlayer = new Map<string, Map<string, number>>();
  for (const gp of gamePlayers) {
    if (!myGameIds.has(gp.gameId)) continue;
    let inner = profitsByGameByPlayer.get(gp.gameId);
    if (!inner) {
      inner = new Map();
      profitsByGameByPlayer.set(gp.gameId, inner);
    }
    inner.set(gp.playerName, gp.profit);
  }

  // 1. Best single night ever (with date) — magnitude is on
  //    PersonalCard but the DATE is the wow ("oh yeah, that
  //    night was amazing").
  if (myStats.biggestWin > 0) {
    let bestGameId = '';
    let bestProfit = 0;
    for (const gp of myGP) {
      if (gp.profit > bestProfit) {
        bestProfit = gp.profit;
        bestGameId = gp.gameId;
      }
    }
    if (bestProfit > 0) {
      facts.push({
        icon: '🏆',
        text: t('home.aboutYou.bestNight', {
          profit: formatCurrency(bestProfit),
          date: formatTriviaDate(gameDateById.get(bestGameId), language),
        }),
      });
    }
  }

  // 2. Worst single night ever (with date) — same logic; date
  //    is the surprise. Skip trivial losses so a casual −20
  //    night doesn't get crowned a "worst night."
  if (myStats.biggestLoss > 50) {
    let worstGameId = '';
    let worstProfit = 0;
    for (const gp of myGP) {
      if (gp.profit < worstProfit) {
        worstProfit = gp.profit;
        worstGameId = gp.gameId;
      }
    }
    if (worstProfit < 0) {
      facts.push({
        icon: '❄️',
        text: t('home.aboutYou.worstNight', {
          amount: formatCurrency(Math.abs(worstProfit)),
          date: formatTriviaDate(gameDateById.get(worstGameId), language),
        }),
      });
    }
  }

  // 3. Most-played partner — the player you've shared the most
  //    completed games with. Skip when the leader has < 3 games
  //    together; that's noise.
  const partnerCounts = new Map<string, number>();
  for (const gp of gamePlayers) {
    if (!myGameIds.has(gp.gameId)) continue;
    if (gp.playerName === playerName) continue;
    partnerCounts.set(gp.playerName, (partnerCounts.get(gp.playerName) ?? 0) + 1);
  }
  const topPartner = [...partnerCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topPartner && topPartner[1] >= 3) {
    facts.push({
      icon: '🤝',
      text: t('home.aboutYou.partner', {
        name: topPartner[0],
        count: topPartner[1],
      }),
    });
  }

  // 4. Nemesis — opponent who finished above you most often.
  //    Sample size gates: ≥ 5 shared games AND ≥ 4 beats so a
  //    single rough night doesn't crown a nemesis.
  const beatsBy = new Map<string, { beats: number; sharedGames: number }>();
  for (const [, inner] of profitsByGameByPlayer) {
    const myProfit = inner.get(playerName);
    if (myProfit === undefined) continue;
    for (const [name, profit] of inner) {
      if (name === playerName) continue;
      const entry = beatsBy.get(name) ?? { beats: 0, sharedGames: 0 };
      entry.sharedGames += 1;
      if (profit > myProfit) entry.beats += 1;
      beatsBy.set(name, entry);
    }
  }
  const topNemesis = [...beatsBy.entries()]
    .filter(([, v]) => v.sharedGames >= 5 && v.beats >= 4)
    .sort((a, b) => b[1].beats - a[1].beats)[0];
  if (topNemesis) {
    facts.push({
      icon: '👻',
      text: t('home.aboutYou.nemesis', {
        name: topNemesis[0],
        count: topNemesis[1].beats,
        total: topNemesis[1].sharedGames,
      }),
    });
  }

  // 5. Podium rate — % of games this player finished top-3
  //    by profit. Reuses `profitsByGameByPlayer` from above.
  if (myStats.gamesPlayed >= 5) {
    let podiums = 0;
    for (const [, inner] of profitsByGameByPlayer) {
      const myProfit = inner.get(playerName);
      if (myProfit === undefined) continue;
      const sortedProfits = [...inner.values()].sort((a, b) => b - a);
      const myRank = sortedProfits.findIndex(p => p === myProfit) + 1;
      if (myRank >= 1 && myRank <= 3) podiums += 1;
    }
    if (podiums > 0) {
      const pct = Math.round((podiums / myStats.gamesPlayed) * 100);
      facts.push({
        icon: '🥇',
        text: t('home.aboutYou.podiumRate', {
          pct,
          count: podiums,
          games: myStats.gamesPlayed,
        }),
      });
    }
  }

  // 6 / 7. Lucky charm + Jinx — when this opponent is at the
  //   table, your win rate (finishing #1) shifts measurably
  //   compared to games WITHOUT them. We only suggest one of
  //   each (the strongest signal) and require:
  //     · ≥ 6 shared games AND ≥ 6 games-without (sample size)
  //     · ≥ 15-percentage-point gap (signal beats noise)
  //   Lucky-charm = biggest positive gap. Jinx = biggest
  //   negative gap. We only emit if both my own gamesPlayed
  //   ≥ 12 (need a real history before pattern-finding is
  //   meaningful) and partnerCounts has ≥ 2 entries (single-
  //   opponent groups never produce a comparison).
  if (myStats.gamesPlayed >= 12 && partnerCounts.size >= 2) {
    // Per-opponent: my wins WITH them vs my wins WITHOUT them.
    type Split = { withGames: number; withWins: number; withoutGames: number; withoutWins: number };
    const split = new Map<string, Split>();
    for (const opponent of partnerCounts.keys()) {
      split.set(opponent, { withGames: 0, withWins: 0, withoutGames: 0, withoutWins: 0 });
    }
    for (const [gameId, inner] of profitsByGameByPlayer) {
      const myProfit = inner.get(playerName);
      if (myProfit === undefined) continue;
      const sortedProfits = [...inner.values()].sort((a, b) => b - a);
      const iWon = sortedProfits[0] === myProfit;
      const playersInThisGame = new Set([...inner.keys()]);
      for (const [opponent, s] of split) {
        if (playersInThisGame.has(opponent)) {
          s.withGames += 1;
          if (iWon) s.withWins += 1;
        } else if (myGameIds.has(gameId)) {
          s.withoutGames += 1;
          if (iWon) s.withoutWins += 1;
        }
      }
    }
    let bestCharm: { name: string; withPct: number; withoutPct: number; gap: number } | null = null;
    let worstJinx: { name: string; withPct: number; withoutPct: number; gap: number } | null = null;
    for (const [name, s] of split) {
      if (s.withGames < 6 || s.withoutGames < 6) continue;
      const withPct = (s.withWins / s.withGames) * 100;
      const withoutPct = (s.withoutWins / s.withoutGames) * 100;
      const gap = withPct - withoutPct;
      if (gap >= 15 && (!bestCharm || gap > bestCharm.gap)) {
        bestCharm = { name, withPct, withoutPct, gap };
      }
      if (gap <= -15 && (!worstJinx || gap < worstJinx.gap)) {
        worstJinx = { name, withPct, withoutPct, gap };
      }
    }
    if (bestCharm) {
      facts.push({
        icon: '🍀',
        text: t('home.aboutYou.luckyCharm', {
          name: bestCharm.name,
          withPct: Math.round(bestCharm.withPct),
          withoutPct: Math.round(bestCharm.withoutPct),
        }),
      });
    }
    if (worstJinx) {
      facts.push({
        icon: '🌧️',
        text: t('home.aboutYou.jinx', {
          name: worstJinx.name,
          withPct: Math.round(worstJinx.withPct),
          withoutPct: Math.round(worstJinx.withoutPct),
        }),
      });
    }
  }

  // 8. Most-outscored opponent — across all shared games, the
  //    opponent you're FURTHEST ahead of in cumulative profit.
  //    Computed as Σ(myProfit − theirProfit) over shared games.
  //    Gates: ≥ 5 shared games AND a meaningful gap (≥ 200) so
  //    a player you've barely outpaced doesn't get singled out.
  const outscoredBy = new Map<string, { gap: number; games: number }>();
  for (const [, inner] of profitsByGameByPlayer) {
    const myProfit = inner.get(playerName);
    if (myProfit === undefined) continue;
    for (const [name, profit] of inner) {
      if (name === playerName) continue;
      const entry = outscoredBy.get(name) ?? { gap: 0, games: 0 };
      entry.gap += myProfit - profit;
      entry.games += 1;
      outscoredBy.set(name, entry);
    }
  }
  const topOutscored = [...outscoredBy.entries()]
    .filter(([, v]) => v.games >= 5 && v.gap >= 200)
    .sort((a, b) => b[1].gap - a[1].gap)[0];
  if (topOutscored) {
    facts.push({
      icon: '💸',
      text: t('home.aboutYou.outscored', {
        name: topOutscored[0],
        amount: formatCurrency(Math.round(topOutscored[1].gap)),
        games: topOutscored[1].games,
      }),
    });
  }

  // 9. Group rank — your current position on the all-time
  //    profit board (only counting players with ≥ 10 games so
  //    a one-game lucky stranger doesn't outrank regulars).
  //    Self must also clear the ≥ 10 gate.
  if (myStats.gamesPlayed >= 10) {
    const ranked = allPlayerStats
      .filter(p => p.gamesPlayed >= 10)
      .sort((a, b) => b.totalProfit - a.totalProfit);
    const rank = ranked.findIndex(p => p.playerName === playerName) + 1;
    if (rank > 0 && ranked.length >= 3) {
      facts.push({
        icon: '🪜',
        text: t('home.aboutYou.groupRank', {
          rank,
          total: ranked.length,
        }),
      });
    }
  }

  // 10. Most common finish position — your rank-by-profit mode.
  //     Surprising because most players think of themselves as
  //     "a winner" or "in the middle" but rarely know the
  //     specific position they hit most often. Gates: ≥ 10 games
  //     AND the modal position must hit ≥ 25% of games (else
  //     it's not really a "most common" pattern, just a tied
  //     plurality with three positions). The mode label is
  //     localised — Hebrew uses ordinal words (ראשון/שני/...),
  //     English uses 1st/2nd/3rd suffixes.
  if (myStats.gamesPlayed >= 10) {
    const positionCounts = new Map<number, number>();
    for (const [, inner] of profitsByGameByPlayer) {
      const myProfit = inner.get(playerName);
      if (myProfit === undefined) continue;
      const sortedProfits = [...inner.values()].sort((a, b) => b - a);
      const myRank = sortedProfits.findIndex(p => p === myProfit) + 1;
      if (myRank > 0) positionCounts.set(myRank, (positionCounts.get(myRank) ?? 0) + 1);
    }
    const top = [...positionCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] / myStats.gamesPlayed >= 0.25) {
      facts.push({
        icon: '🎯',
        text: t('home.aboutYou.mostCommonFinish', {
          place: ordinalLabel(top[0], language),
          count: top[1],
          games: myStats.gamesPlayed,
        }),
      });
    }
  }

  // 10b/c/d. Place-rank facts (1st, 2nd, 3rd, all-time). Mirrors
  //          the home-trivia "מלך הזכיות / מלך המקומות השניים /
  //          מלך המקומות השלישיים" cards but framed personally —
  //          tells the player exactly where THEY stand on each
  //          place board, with their own count and rate. Gates:
  //              · ≥ 30 group games (matches home-trivia gate so
  //                we don't surface ranks on tiny groups)
  //              · player has ≥ 10 games (already true on the
  //                outer mostCommonFinish gate, but kept explicit)
  //              · the player has ≥ 3 finishes in this place
  //                (else "you're #X with 1 finish" reads as noise)
  //              · player is in top 5 by absolute count (else
  //                ranks like "#15 in 3rd-place finishes" are
  //                uninteresting)
  //          When the player is rank 1, uses a celebratory "king"
  //          translation; otherwise the rank-style copy.
  const completedGameCount = completedGameIds.size;
  if (myStats.gamesPlayed >= 10 && completedGameCount >= 30) {
    // Build per-player place counts across all completed games. We
    // re-derive from `gamePlayers` (rather than reusing
    // `profitsByGameByPlayer`, which only covers games I played in)
    // because the rank computation needs counts for every player in
    // the group, not just my opponents.
    type PlaceCounts = { wins: number; seconds: number; thirds: number; games: number };
    const placeCountsByPlayer = new Map<string, PlaceCounts>();
    const playersByGameAll = new Map<string, typeof gamePlayers>();
    for (const gp of gamePlayers) {
      if (!completedGameIds.has(gp.gameId)) continue;
      const arr = playersByGameAll.get(gp.gameId);
      if (arr) arr.push(gp);
      else playersByGameAll.set(gp.gameId, [gp]);
    }
    for (const players of playersByGameAll.values()) {
      if (players.length === 0) continue;
      // Game appearance count for everyone present.
      for (const p of players) {
        const e = placeCountsByPlayer.get(p.playerName) ?? { wins: 0, seconds: 0, thirds: 0, games: 0 };
        e.games++;
        placeCountsByPlayer.set(p.playerName, e);
      }
      // Place finishes only when there's a real winner (top profit > 0)
      // — same guard the home-trivia 1st/2nd/3rd cards use.
      const sorted = [...players].sort((a, b) => b.profit - a.profit);
      if (sorted[0].profit <= 0) continue;
      const e1 = placeCountsByPlayer.get(sorted[0].playerName);
      if (e1) e1.wins++;
      if (sorted.length >= 2) {
        const e2 = placeCountsByPlayer.get(sorted[1].playerName);
        if (e2) e2.seconds++;
      }
      if (sorted.length >= 3) {
        const e3 = placeCountsByPlayer.get(sorted[2].playerName);
        if (e3) e3.thirds++;
      }
    }

    const myCounts = placeCountsByPlayer.get(playerName);
    if (myCounts) {
      const placeFacts: Array<{
        key: keyof PlaceCounts;
        icon: string;
        kingT: TranslationKey;
        rankT: TranslationKey;
      }> = [
        { key: 'wins',    icon: '👑', kingT: 'home.aboutYou.firstPlaceKing',  rankT: 'home.aboutYou.firstPlaceRank' },
        { key: 'seconds', icon: '🥈', kingT: 'home.aboutYou.secondPlaceKing', rankT: 'home.aboutYou.secondPlaceRank' },
        { key: 'thirds',  icon: '🥉', kingT: 'home.aboutYou.thirdPlaceKing',  rankT: 'home.aboutYou.thirdPlaceRank' },
      ];
      for (const { key, icon, kingT, rankT } of placeFacts) {
        const myCount = myCounts[key];
        if (myCount < 3) continue;
        // Rank only among players who have AT LEAST ONE finish in
        // this place AND meet the same ≥10 games gate as `groupRank`
        // — otherwise a 1-game rookie who happened to finish 2nd
        // crowds the leaderboard.
        const ranked = [...placeCountsByPlayer.entries()]
          .filter(([, v]) => v[key] > 0 && v.games >= 10)
          .sort((a, b) => b[1][key] - a[1][key]);
        const rank = ranked.findIndex(([n]) => n === playerName) + 1;
        if (rank <= 0 || rank > 5) continue;
        const pct = myCounts.games > 0 ? Math.round((myCount / myCounts.games) * 100) : 0;
        facts.push({
          icon,
          text: rank === 1
            ? t(kingT, { count: myCount, games: myCounts.games, pct })
            : t(rankT, { rank, count: myCount, games: myCounts.games, pct }),
        });
      }
    }
  }

  // 11. Member since — first game date + total games. Anchors
  //     a player's emotional sense of how long they've been at
  //     the felt. Gates: ≥ 5 games AND first game ≥ 60 days
  //     ago, otherwise "you've been playing for 2 weeks" reads
  //     as silly trivia, not nostalgia.
  if (myStats.gamesPlayed >= 5) {
    let firstGameTs = Infinity;
    for (const gp of myGP) {
      const dateIso = gameDateById.get(gp.gameId);
      if (!dateIso) continue;
      const ts = new Date(dateIso).getTime();
      if (Number.isFinite(ts) && ts < firstGameTs) firstGameTs = ts;
    }
    const sixtyDaysAgo = Date.now() - 60 * 86_400_000;
    if (firstGameTs < sixtyDaysAgo && Number.isFinite(firstGameTs)) {
      facts.push({
        icon: '📅',
        text: t('home.aboutYou.memberSince', {
          date: formatTriviaDate(new Date(firstGameTs).toISOString(), language),
          games: myStats.gamesPlayed,
        }),
      });
    }
  }

  // ── Per-year + per-month profit aggregations ───────────────────
  // Walked once and reused for both `bestYear` (#12) and
  // `bestMonth` (#13). Skip games we can't date (defensive — all
  // completed games should have a date but better than crashing).
  const profitByYear = new Map<number, { profit: number; games: number }>();
  const profitByMonth = new Map<string, { profit: number; games: number; ts: number }>();
  for (const gp of myGP) {
    const dateIso = gameDateById.get(gp.gameId);
    if (!dateIso) continue;
    const d = new Date(dateIso);
    const year = d.getFullYear();
    const monthKey = `${year}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const yEntry = profitByYear.get(year) ?? { profit: 0, games: 0 };
    yEntry.profit += gp.profit;
    yEntry.games += 1;
    profitByYear.set(year, yEntry);
    const mEntry = profitByMonth.get(monthKey) ?? { profit: 0, games: 0, ts: d.getTime() };
    mEntry.profit += gp.profit;
    mEntry.games += 1;
    profitByMonth.set(monthKey, mEntry);
  }

  // 12. Best year ever — calendar year with the largest total
  //     profit. Gates: ≥ 2 distinct years (otherwise "your best
  //     year is the only year you've played" is meaningless),
  //     ≥ 5 games in that year (one-game years aren't a year),
  //     and the year's profit must be > 0 (no "your best year
  //     was −5,000" sad trivia).
  if (profitByYear.size >= 2) {
    const bestYear = [...profitByYear.entries()]
      .filter(([, v]) => v.games >= 5 && v.profit > 0)
      .sort((a, b) => b[1].profit - a[1].profit)[0];
    if (bestYear) {
      facts.push({
        icon: '🌟',
        text: t('home.aboutYou.bestYear', {
          year: bestYear[0],
          profit: formatCurrency(Math.round(bestYear[1].profit)),
          games: bestYear[1].games,
        }),
      });
    }
  }

  // 13. Best month ever — single calendar month with the largest
  //     positive profit. Gates: ≥ 3 games in the month (a single
  //     lucky session isn't a "hot month"), profit > 0. Month
  //     label is rendered via `formatTriviaDate` which auto-picks
  //     the right localised "Month YYYY" form.
  if (profitByMonth.size >= 3) {
    const bestMonth = [...profitByMonth.entries()]
      .filter(([, v]) => v.games >= 3 && v.profit > 0)
      .sort((a, b) => b[1].profit - a[1].profit)[0];
    if (bestMonth) {
      facts.push({
        icon: '🔥',
        text: t('home.aboutYou.bestMonth', {
          month: formatTriviaDate(new Date(bestMonth[1].ts).toISOString(), language),
          profit: formatCurrency(Math.round(bestMonth[1].profit)),
          games: bestMonth[1].games,
        }),
      });
    }
  }

  // 14. Best location (with disclaimer) — the host whose table
  //     has been kindest to this player. Location tracking is
  //     newer than the rest of the data (most groups have <30%
  //     of games tagged), so the disclaimer with `tracked`/
  //     `total` counts is mandatory — without it the player
  //     reads "best at X" and assumes it's based on every game.
  //     Gates: ≥ 3 location-tagged games for THIS player at the
  //     leader location AND avg profit ≥ 50/game (so a "best
  //     location" with +5 avg doesn't get crowned). The 3-game
  //     gate is intentionally low — location tracking only began
  //     recently so most players have very few tagged games. The
  //     disclaimer in the message itself ("based on N of M") puts
  //     the small sample in context, so the player understands
  //     this is suggestive, not statistically definitive.
  const profitByLocation = new Map<string, { profit: number; games: number }>();
  let trackedCount = 0;
  for (const gp of myGP) {
    const game = games.find(g => g.id === gp.gameId);
    const loc = game?.location?.trim();
    if (!loc) continue;
    trackedCount += 1;
    const entry = profitByLocation.get(loc) ?? { profit: 0, games: 0 };
    entry.profit += gp.profit;
    entry.games += 1;
    profitByLocation.set(loc, entry);
  }
  const bestLoc = [...profitByLocation.entries()]
    .filter(([, v]) => v.games >= 3 && v.profit / v.games >= 50)
    .sort((a, b) => (b[1].profit / b[1].games) - (a[1].profit / a[1].games))[0];
  if (bestLoc) {
    facts.push({
      icon: '🏠',
      text: t('home.aboutYou.bestLocation', {
        host: bestLoc[0],
        avg: formatCurrency(Math.round(bestLoc[1].profit / bestLoc[1].games)),
        games: bestLoc[1].games,
        tracked: trackedCount,
        total: myStats.gamesPlayed,
      }),
    });
  }

  // 15. Recent vs career form — am I hot or cold lately? Compare
  //     last 20 games' avg profit to career avg. Gates: ≥ 30
  //     career games AND |gap| ≥ 30 (currency units) so subtle
  //     drift doesn't trigger a "you're on a heater" claim.
  //     Trend label is localised via two sub-keys.
  if (myStats.gamesPlayed >= 30) {
    // Sort myGP by date desc to find the last 20 games. Built
    // fresh here (rather than reusing myGP order, which is cache-
    // insertion order, not date order).
    const dated = myGP
      .map(gp => ({ profit: gp.profit, ts: new Date(gameDateById.get(gp.gameId) ?? 0).getTime() }))
      .filter(g => Number.isFinite(g.ts) && g.ts > 0)
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 20);
    if (dated.length >= 20) {
      const recentAvg = dated.reduce((s, g) => s + g.profit, 0) / dated.length;
      const careerAvg = myStats.avgProfit;
      const gap = recentAvg - careerAvg;
      if (Math.abs(gap) >= 30) {
        const trend = gap > 0
          ? t('home.aboutYou.recentForm.trend.up')
          : t('home.aboutYou.recentForm.trend.down');
        facts.push({
          icon: gap > 0 ? '📈' : '📉',
          text: t('home.aboutYou.recentForm', {
            trend,
            recent: 20,
            recentAvg: formatCurrency(Math.round(recentAvg)),
            careerAvg: formatCurrency(Math.round(careerAvg)),
          }),
        });
      }
    }
  }

  // 16. Average finish position — your mean rank-by-profit
  //     across all games AND the average table size you've
  //     played in. The "X out of Y" framing is way more
  //     visceral than just "average rank: 3.2" because it
  //     anchors the rank against the typical opponent count.
  //     Gate: ≥ 10 games (small samples skew badly).
  if (myStats.gamesPlayed >= 10) {
    let rankSum = 0;
    let rankN = 0;
    let playerCountSum = 0;
    for (const [, inner] of profitsByGameByPlayer) {
      const myProfit = inner.get(playerName);
      if (myProfit === undefined) continue;
      const sortedProfits = [...inner.values()].sort((a, b) => b - a);
      const myRank = sortedProfits.findIndex(p => p === myProfit) + 1;
      if (myRank > 0) {
        rankSum += myRank;
        rankN += 1;
        playerCountSum += inner.size;
      }
    }
    if (rankN >= 10) {
      const avgRank = rankSum / rankN;
      // Round table size to the nearest whole player — "7.2 players"
      // is nonsense (you can't have 0.2 of a player). The "~" prefix
      // in the localised string acknowledges this is a typical
      // table size, not a precise count.
      const avgPlayers = Math.round(playerCountSum / rankN);
      facts.push({
        icon: '📍',
        text: t('home.aboutYou.avgFinish', {
          avgRank: avgRank.toFixed(1),
          avgPlayers,
        }),
      });
    }
  }

  // 20. Your busiest calendar year — most games attended. Personal
  //     mirror of the global `bestYearGames`. Gates: ≥ 2 distinct
  //     years played (so the fact distinguishes itself from the
  //     "you played a year" trivial case) AND ≥ 10 games in that
  //     top year (otherwise it's not really a "busy" year). Reuses
  //     the `profitByYear` aggregation built earlier (#12) so we
  //     don't re-walk myGP.
  if (profitByYear.size >= 2) {
    const sortedYears = [...profitByYear.entries()].sort((a, b) => b[1].games - a[1].games);
    const top = sortedYears[0];
    if (top && top[1].games >= 10) {
      facts.push({
        icon: '📆',
        text: t('home.aboutYou.bestYearGames', {
          year: top[0],
          count: top[1].games,
        }),
      });
    }
  }

  // 21. All-time attendance rate — % of EVERY group game (not
  //     just games in your tenure) that you've shown up to. Strong
  //     wow factor for veterans ("you were at 79% of all the
  //     group's games ever"). Gates: ≥ 30 group games total AND
  //     ≥ 50% rate so the fact only crowns genuine regulars.
  if (completedGameIds.size >= 30) {
    const pct = (myGP.length / completedGameIds.size) * 100;
    if (pct >= 50) {
      facts.push({
        icon: '🚪',
        text: t('home.aboutYou.attendanceAllTime', {
          pct: Math.round(pct),
          games: myGP.length,
          total: completedGameIds.size,
        }),
      });
    }
  }

  // 22. Best calendar HALF-YEAR ever — finer-grained than #12
  //     (best year) and coarser than #13 (best month). H1 = Jan-Jun,
  //     H2 = Jul-Dec. Surfaces 6-month hot streaks ("first half of
  //     2024 was your peak") that get hidden inside an annual avg.
  //     Gates mirror #12: ≥ 2 distinct halves played AND ≥ 5 games
  //     in the leader half AND profit > 0 (positive-only — losing
  //     halves don't get celebrated).
  const profitByHalf = new Map<string, { year: number; half: 1 | 2; profit: number; games: number }>();
  for (const gp of myGP) {
    const dateIso = gameDateById.get(gp.gameId);
    if (!dateIso) continue;
    const d = new Date(dateIso);
    if (Number.isNaN(d.getTime())) continue;
    const year = d.getFullYear();
    const half: 1 | 2 = d.getMonth() < 6 ? 1 : 2;
    const key = `${year}-H${half}`;
    const entry = profitByHalf.get(key) ?? { year, half, profit: 0, games: 0 };
    entry.profit += gp.profit;
    entry.games += 1;
    profitByHalf.set(key, entry);
  }
  if (profitByHalf.size >= 2) {
    const best = [...profitByHalf.values()]
      .filter(v => v.games >= 5 && v.profit > 0)
      .sort((a, b) => b.profit - a.profit)[0];
    if (best) {
      const labelKey = best.half === 1 ? 'home.aboutYou.halfYearH1' : 'home.aboutYou.halfYearH2';
      facts.push({
        icon: '☀️',
        text: t('home.aboutYou.bestHalfYear', {
          label: t(labelKey, { year: best.year }),
          profit: formatCurrency(Math.round(best.profit)),
          games: best.games,
        }),
      });
    }
  }

  // 23. Longest consecutive attendance streak — your personal best
  //     run of group games attended in a row. Walks completed games
  //     chronologically; resets the run on every miss. The "you
  //     never missed Saturday for 4 months straight" stat. Gate ≥ 5
  //     so trivial streaks don't show.
  // 24. Recent loyalty — % of the LAST 25 group games attended.
  //     Surfaces current commitment (different from #23 which is
  //     all-time best). Gates: group has ≥ 25 games AND attendance
  //     ≥ 70% so it reads as a compliment, not a complaint.
  {
    const orderedGameIds = [...completedGameIds].sort((a, b) => {
      const da = gameDateById.get(a) ?? '';
      const db = gameDateById.get(b) ?? '';
      return new Date(da).getTime() - new Date(db).getTime();
    });
    let curRun = 0;
    let bestRun = 0;
    for (const gid of orderedGameIds) {
      if (myGameIds.has(gid)) {
        curRun += 1;
        if (curRun > bestRun) bestRun = curRun;
      } else {
        curRun = 0;
      }
    }
    if (bestRun >= 5) {
      facts.push({
        icon: '🚪',
        text: t('home.aboutYou.longestAttendanceStreak', { count: bestRun }),
      });
    }
    if (orderedGameIds.length >= 25) {
      const recent = orderedGameIds.slice(-25);
      const attendedRecent = recent.reduce((acc, gid) => acc + (myGameIds.has(gid) ? 1 : 0), 0);
      const pctRecent = Math.round((attendedRecent / recent.length) * 100);
      if (pctRecent >= 70) {
        facts.push({
          icon: '🎟️',
          text: t('home.aboutYou.recentLoyalty', {
            games: attendedRecent,
            total: recent.length,
            pct: pctRecent,
          }),
        });
      }
    }
  }

  // 25. Best table size — among table sizes you've played at least
  //     8 times each, which one delivers the highest avg profit.
  //     Surfaces "you eat 8-handed tables for breakfast but struggle
  //     5-handed" patterns nobody computes manually. Eligibility ≥ 8
  //     games at the same size AND avg ≥ 30 (positive enough to
  //     phrase it as a strength). Tie-break: more games wins.
  {
    type SizeStat = { size: number; total: number; games: number };
    const bySize = new Map<number, SizeStat>();
    for (const gp of myGP) {
      const tableSize = profitsByGameByPlayer.get(gp.gameId)?.size ?? 0;
      if (tableSize < 2) continue;
      const e = bySize.get(tableSize) ?? { size: tableSize, total: 0, games: 0 };
      e.total += gp.profit;
      e.games += 1;
      bySize.set(tableSize, e);
    }
    const eligible = [...bySize.values()].filter(s => s.games >= 8);
    if (eligible.length >= 2) {
      eligible.sort((a, b) => {
        const avgA = a.total / a.games;
        const avgB = b.total / b.games;
        if (avgB !== avgA) return avgB - avgA;
        return b.games - a.games;
      });
      const top = eligible[0];
      const avg = top.total / top.games;
      if (avg >= 30) {
        facts.push({
          icon: '🪑',
          text: t('home.aboutYou.bestTableSize', {
            players: top.size,
            avg: formatCurrency(Math.round(avg)),
            games: top.games,
          }),
        });
      }
    }
  }

  return facts;
}

// Localised ordinal label for finish positions. Hebrew uses
// the masculine ordinal words (ראשון/שני/שלישי/...); English
// uses 1st/2nd/3rd/Nth suffixes. Both fall back gracefully
// for very high ranks (10+) by appending the English suffix
// rules / "מקום N" Hebrew form.
function ordinalLabel(n: number, language: Language): string {
  if (language === 'he') {
    const heOrdinals = ['', 'ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שביעי', 'שמיני', 'תשיעי', 'עשירי'];
    return heOrdinals[n] ?? `ה-${n}`;
  }
  // English: 1st, 2nd, 3rd, then 4th–20th, then repeat the
  // 1/2/3 rule based on the ones digit (21st, 22nd, 23rd, 24th…).
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
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

// When a record (e.g. biggest single-night loss) is tied across
// multiple games, format the holders as "Name ×N, Name, Name" sorted
// by occurrence count (descending) then first appearance. Used by the
// biggestWin / biggestLoss / biggestWinAllTime / biggestLossAllTime
// trivia facts so a tied record shows everyone who shares it instead
// of arbitrarily picking one.
function formatTiedPlayers(records: { playerName: string }[], _language: Language): string {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const r of records) {
    if (!counts.has(r.playerName)) order.push(r.playerName);
    counts.set(r.playerName, (counts.get(r.playerName) ?? 0) + 1);
  }
  order.sort((a, b) => {
    const diff = (counts.get(b) ?? 0) - (counts.get(a) ?? 0);
    if (diff !== 0) return diff;
    return order.indexOf(a) - order.indexOf(b);
  });
  return order
    .map(name => {
      const c = counts.get(name) ?? 1;
      return c > 1 ? `${name} ×${c}` : name;
    })
    .join(', ');
}

// Internal trivia entry shape — `category` is an optional bucket tag
// used by `spreadTriviaByCategory` to keep similar facts apart in the
// final ordering. Most entries inherit their category from `icon`
// (so e.g. the two "most active" facts that both use 💪 group
// automatically). The training section explicitly overrides this with
// `'training'` so all 4 training facts share one bucket regardless of
// their differing icons (🎓 / 🎯 / 📚 / 👥) — without that override
// the four would still cluster at the end of the source list and read
// as a wall of training trivia.
type TriviaEntry = { icon: string; text: string; category?: string };

function buildTriviaList(
  games: ReturnType<typeof getAllGames>,
  gamePlayers: ReturnType<typeof getAllGamePlayers>,
  playerStats: PlayerStats[],
  trainingPlayers: TrainingPlayerData[],
  t: SectionProps['t'],
  language: Language,
): { icon: string; text: string }[] {
  const list: TriviaEntry[] = [];
  // Player → gender map for gender-aware Hebrew copy in trivia
  // strings (e.g. "שולט"/"שולטת"). Built once per call from the
  // group's roster; if a player is missing from the map we default
  // to the masculine form (same fallback used in the trivia
  // generator's `gParams`).
  const genderByName = new Map<string, 'male' | 'female'>();
  for (const p of getAllPlayers()) {
    if (p.name && p.gender) genderByName.set(p.name, p.gender);
  }
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

  // Per-player game counts (year + all-time). Built once so any
  // "rate champion" fact (#4/#4b/#17a-d below) can divide a per-place
  // count by games played without re-walking gamePlayers. Used to
  // surface the relative-rate angle next to the absolute-count angle —
  // a player with a lot of wins might just be the most active player,
  // so the higher win % among regulars is the more interesting story.
  const playerYearGames = new Map<string, number>();
  for (const gp of yearGP) {
    playerYearGames.set(gp.playerName, (playerYearGames.get(gp.playerName) ?? 0) + 1);
  }
  const playerAllTimeGames = new Map<string, number>();
  for (const gp of allTimeGP) {
    playerAllTimeGames.set(gp.playerName, (playerAllTimeGames.get(gp.playerName) ?? 0) + 1);
  }

  // Find the player with the highest place-rate (place finishes /
  // games played) among players whose participation is at least 30%
  // of the games in scope. The 30% gate (per Lior) excludes one-night
  // wonders without being so strict that only the absolute-count
  // champion could ever qualify. Returns null when no eligible player
  // exists. Callers compare against the absolute-count champion and
  // only show the rate suffix when it's a different player — otherwise
  // the message is redundant.
  const findRateChamp = (
    placeCounts: Map<string, number>,
    gameCounts: Map<string, number>,
    totalGames: number,
  ): { name: string; pct: number; wins: number; games: number } | null => {
    if (totalGames <= 0) return null;
    const minGames = Math.max(1, Math.ceil(totalGames * 0.3));
    let best: { name: string; pct: number; wins: number; games: number } | null = null;
    for (const [name, count] of placeCounts) {
      const games = gameCounts.get(name) ?? 0;
      if (games < minGames) continue;
      const pct = (count / games) * 100;
      if (!best || pct > best.pct) best = { name, pct, wins: count, games };
    }
    return best;
  };

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

  // 1. Biggest single win this year. Track every game tied at the max
  //    so a shared record surfaces all holders ("400 — 3 nights:
  //    A ×2, B") instead of arbitrarily picking one. Single-holder
  //    case keeps the original date-suffix copy.
  let biggest = { profit: 0 };
  for (const gp of yearGP) {
    if (gp.profit > biggest.profit) biggest = { profit: gp.profit };
  }
  if (biggest.profit > 0) {
    const winners = yearGP.filter(gp => gp.profit === biggest.profit);
    if (winners.length === 1) {
      list.push({
        icon: '🏆',
        text: t('home.trivia.biggestWin', {
          profit: formatCurrency(biggest.profit),
          name: winners[0].playerName,
          date: formatTriviaDate(gameDateById.get(winners[0].gameId), language),
        }),
      });
    } else {
      list.push({
        icon: '🏆',
        text: t('home.trivia.biggestWinMulti', {
          profit: formatCurrency(biggest.profit),
          count: String(winners.length),
          players: formatTiedPlayers(winners, language),
        }),
      });
    }
  }

  // 2. Biggest single loss this year.
  let worst = { loss: 0 };
  for (const gp of yearGP) {
    if (gp.profit < worst.loss) worst = { loss: gp.profit };
  }
  if (worst.loss < -50) {
    const losers = yearGP.filter(gp => gp.profit === worst.loss);
    if (losers.length === 1) {
      list.push({
        icon: '❄️',
        text: t('home.trivia.biggestLoss', {
          amount: formatCurrency(Math.abs(worst.loss)),
          name: losers[0].playerName,
          date: formatTriviaDate(gameDateById.get(losers[0].gameId), language),
        }),
      });
    } else {
      list.push({
        icon: '❄️',
        text: t('home.trivia.biggestLossMulti', {
          amount: formatCurrency(Math.abs(worst.loss)),
          count: String(losers.length),
          players: formatTiedPlayers(losers, language),
        }),
      });
    }
  }

  // 3. Most active player this year. When the top game-count is shared
  //    by multiple players (genuinely common in tight groups where
  //    several regulars all attended the same N games), surface every
  //    tied name instead of arbitrarily picking one.
  let mostActiveYearCount = 0;
  let mostActiveYearCounts = new Map<string, number>();
  if (yearGP.length > 0) {
    const counts = new Map<string, number>();
    for (const gp of yearGP) counts.set(gp.playerName, (counts.get(gp.playerName) ?? 0) + 1);
    mostActiveYearCounts = counts;
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const topVal = sorted[0]?.[1] ?? 0;
    if (topVal >= 3) {
      mostActiveYearCount = topVal;
      const tied = sorted.filter(([, v]) => v === topVal).map(([n]) => n);
      list.push({
        icon: '💪',
        text: tied.length === 1
          ? t('home.trivia.mostActive', { name: tied[0], games: topVal })
          : t('home.trivia.mostActiveMulti', { players: tied.join(', '), games: topVal }),
      });
    }
  }

  // 3c. Iron-attendance — player with the highest attendance RATE
  //     (% of year's games attended), distinct from #3 which uses
  //     raw count. A 100%-attender of 8 games beats a 60%-attender of
  //     12 games on commitment, even though #3 crowns the latter.
  //     Gates: ≥ 5 year games (otherwise a single-game year gives
  //     trivial 100% to anyone who showed up once) AND ≥ 80% rate
  //     (anything lower isn't really "never misses"). When the year
  //     leader matches mostActive's leader at the SAME absolute
  //     count (i.e. attended all games), we still show this fact —
  //     the percentage framing is a different headline ("never
  //     missed a game" reads more impressively than "played 12
  //     games") and a stable group is exactly when this fact lands
  //     most meaningfully.
  if (yearGameIds.size >= 5 && mostActiveYearCounts.size > 0) {
    let bestAttn = { name: '', games: 0, pct: 0 };
    for (const [name, games] of mostActiveYearCounts) {
      const pct = (games / yearGameIds.size) * 100;
      if (pct > bestAttn.pct) bestAttn = { name, games, pct };
    }
    if (bestAttn.pct >= 80) {
      list.push({
        icon: '🚪',
        text: t('home.trivia.bestAttendance', {
          name: bestAttn.name,
          pct: Math.round(bestAttn.pct),
          games: bestAttn.games,
          total: yearGameIds.size,
        }),
      });
    }
  }

  // 3b. Most active player ALL-TIME. Mirror of #3 — only surface when
  //     strictly larger than the year leader so the two facts don't
  //     echo each other on a fresh group whose entire history fits
  //     inside the current year.
  if (allTimeGP.length > 0) {
    const counts = new Map<string, number>();
    for (const gp of allTimeGP) counts.set(gp.playerName, (counts.get(gp.playerName) ?? 0) + 1);
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const topVal = sorted[0]?.[1] ?? 0;
    if (topVal >= 6 && topVal > mostActiveYearCount + 2) {
      const tied = sorted.filter(([, v]) => v === topVal).map(([n]) => n);
      list.push({
        icon: '💪',
        text: tied.length === 1
          ? t('home.trivia.mostActiveAllTime', { name: tied[0], games: topVal })
          : t('home.trivia.mostActiveAllTimeMulti', { players: tied.join(', '), games: topVal }),
      });
    }
  }

  // 4. Most #1 finishes this year. The "{verb}" placeholder was
  //    dropped from the translation when we reworded the line —
  //    sentence reads as a noun-phrase headline now ("Win champion
  //    this year: …"), so no gendered verb is needed.
  //    Single-winner case also surfaces a rate-champion suffix when
  //    a different regular has a higher win-rate (so the absolute
  //    leader isn't just the most-played player). Multi-tied case
  //    keeps the original copy — adding a rate twist there reads
  //    confusingly.
  //    `mostWinsRateChamp` is captured here and consumed by the
  //    `bestWinRate` block (#21) further down so we don't surface
  //    a standalone "highest win rate" card that names the same
  //    player at the same percentage we already inlined here —
  //    that's pure echo. When a different player wins #21 (because
  //    findRateChamp's 30%-participation gate is stricter than
  //    bestWinRate's 3-game gate), both cards ride and tell
  //    distinct stories.
  let topWinnerThisYearCount = 0;
  let mostWinsRateChamp: { name: string; pct: number } | null = null;
  if (yearGameIds.size >= 3) {
    const wins = new Map<string, number>();
    for (const gameId of yearGameIds) {
      const players = playersByGame.get(gameId);
      if (!players || players.length === 0) continue;
      let winner = players[0];
      for (const p of players) if (p.profit > winner.profit) winner = p;
      if (winner.profit > 0) wins.set(winner.playerName, (wins.get(winner.playerName) ?? 0) + 1);
    }
    const sorted = [...wins.entries()].sort((a, b) => b[1] - a[1]);
    const topVal = sorted[0]?.[1] ?? 0;
    if (topVal >= 2) {
      topWinnerThisYearCount = topVal;
      const tied = sorted.filter(([, v]) => v === topVal).map(([n]) => n);
      let text: string;
      if (tied.length > 1) {
        text = t('home.trivia.mostWinsMulti', { players: tied.join(', '), count: topVal });
      } else {
        const champGames = playerYearGames.get(tied[0]) ?? 0;
        const champPct = champGames > 0 ? Math.round((topVal / champGames) * 100) : 0;
        const rate = findRateChamp(wins, playerYearGames, yearGameIds.size);
        if (rate && rate.name !== tied[0]) {
          text = t('home.trivia.mostWinsWithRate', {
            name: tied[0],
            count: topVal,
            champGames,
            champPct,
            rateName: rate.name,
            pct: Math.round(rate.pct),
            wins: rate.wins,
            games: rate.games,
          });
          mostWinsRateChamp = { name: rate.name, pct: Math.round(rate.pct) };
        } else {
          text = t('home.trivia.mostWins', { name: tied[0], count: topVal, champGames, champPct });
          // Append the affirmation when the absolute champion is
          // ALSO the rate champion — without it, readers wonder
          // whether a different rate king is silently hidden.
          if (rate && rate.name === tied[0]) text += t('home.trivia.alsoRateKing');
        }
      }
      list.push({ icon: '👑', text });
    }
  }

  // 4b. Most #1 finishes ALL-TIME. Mirror of #4 — only surface when
  //     strictly larger than the year-scoped count so the two facts
  //     don't echo each other on a fresh group. Same rate-champion
  //     suffix logic as #4 — single-winner gets the WithRate variant
  //     when a different regular has a higher lifetime win-rate, and
  //     the alsoRateKing affirmation when the same player wins both.
  if (allCompletedGameIds.size >= 5) {
    const winsAll = new Map<string, number>();
    for (const gameId of allCompletedGameIds) {
      const players = allTimePlayersByGame.get(gameId);
      if (!players || players.length === 0) continue;
      let winner = players[0];
      for (const p of players) if (p.profit > winner.profit) winner = p;
      if (winner.profit > 0) winsAll.set(winner.playerName, (winsAll.get(winner.playerName) ?? 0) + 1);
    }
    const sorted = [...winsAll.entries()].sort((a, b) => b[1] - a[1]);
    const topVal = sorted[0]?.[1] ?? 0;
    if (topVal >= 5 && topVal > topWinnerThisYearCount) {
      const tied = sorted.filter(([, v]) => v === topVal).map(([n]) => n);
      let text: string;
      if (tied.length > 1) {
        text = t('home.trivia.mostWinsAllTimeMulti', { players: tied.join(', '), count: topVal });
      } else {
        const champGames = playerAllTimeGames.get(tied[0]) ?? 0;
        const champPct = champGames > 0 ? Math.round((topVal / champGames) * 100) : 0;
        const rate = findRateChamp(winsAll, playerAllTimeGames, allCompletedGameIds.size);
        if (rate && rate.name !== tied[0]) {
          text = t('home.trivia.mostWinsAllTimeWithRate', {
            name: tied[0],
            count: topVal,
            champGames,
            champPct,
            rateName: rate.name,
            pct: Math.round(rate.pct),
            wins: rate.wins,
            games: rate.games,
          });
        } else {
          text = t('home.trivia.mostWinsAllTime', { name: tied[0], count: topVal, champGames, champPct });
          if (rate && rate.name === tied[0]) text += t('home.trivia.alsoRateKing');
        }
      }
      list.push({ icon: '👑', text });
    }
  }

  // 4e. All-time profit champion — actual money, not win count.
  //     #4b crowns the player with the most #1 finishes, but a
  //     player who consistently finishes 2nd/3rd with strong stacks
  //     can quietly outearn the win champion over years. This fact
  //     surfaces THAT story. Gates: top earner has ≥ 30 lifetime
  //     games (otherwise a hot-month newbie crowns themselves) AND
  //     ≥ +500 cumulative (anything smaller isn't really a "champ").
  //     Reads from `playerStats.totalProfit` directly — already
  //     aggregated by the stats pipeline, no rescan of gamePlayers
  //     needed.
  {
    let topEarner = { name: '', profit: 0, games: 0 };
    for (const ps of playerStats) {
      if (ps.gamesPlayed < 30) continue;
      if (ps.totalProfit > topEarner.profit) {
        topEarner = { name: ps.playerName, profit: ps.totalProfit, games: ps.gamesPlayed };
      }
    }
    if (topEarner.profit >= 500) {
      list.push({
        icon: '💵',
        text: t('home.trivia.profitChamp', {
          name: topEarner.name,
          profit: formatCurrency(Math.round(topEarner.profit)),
          games: topEarner.games,
        }),
      });
    }
  }

  // 4c. Most podiums (top-3 finishes) THIS YEAR. Counts top-3 by
  //     profit per game where the player finished above zero (no
  //     real podium if everyone tanked). Threshold prevents
  //     surfacing on too few games. Single-leader case ALWAYS
  //     inlines the absolute champion's podium-rate (`{champPct}`)
  //     so the user can sanity-check the framing — "13 of 19" tells
  //     a different story from "13 of 50". When a *different*
  //     regular has a higher podium rate (per `findRateChamp`'s
  //     30%-participation gate), append the rate suffix; otherwise
  //     the simple base copy stands. Outer `playerYearGames`
  //     (line ~4031) already counts every player's appearances —
  //     we used to rebuild it here, but that shadowed the shared
  //     map and risked drift if one definition ever changed.
  if (yearGameIds.size >= 4) {
    const podiumYear = new Map<string, number>();
    for (const gameId of yearGameIds) {
      const players = playersByGame.get(gameId);
      if (!players || players.length === 0) continue;
      const sortedByProfit = [...players].sort((a, b) => b.profit - a.profit);
      const podium = sortedByProfit.slice(0, 3).filter(p => p.profit > 0);
      for (const p of podium) podiumYear.set(p.playerName, (podiumYear.get(p.playerName) ?? 0) + 1);
    }
    const sorted = [...podiumYear.entries()].sort((a, b) => b[1] - a[1]);
    const topVal = sorted[0]?.[1] ?? 0;
    if (topVal >= 3) {
      const tied = sorted.filter(([, v]) => v === topVal).map(([n]) => n);
      let text: string;
      if (tied.length > 1) {
        text = t('home.trivia.mostPodiumsYearMulti', { players: tied.join(', '), count: topVal });
      } else {
        const champGames = playerYearGames.get(tied[0]) ?? topVal;
        const champPct = champGames > 0 ? Math.round((topVal / champGames) * 100) : 0;
        const rate = findRateChamp(podiumYear, playerYearGames, yearGameIds.size);
        if (rate && rate.name !== tied[0]) {
          text = t('home.trivia.mostPodiumsYearWithRate', {
            name: tied[0],
            count: topVal,
            games: champGames,
            champPct,
            rateName: rate.name,
            pct: Math.round(rate.pct),
            wins: rate.wins,
            rateGames: rate.games,
          });
        } else {
          text = t('home.trivia.mostPodiumsYear', {
            name: tied[0],
            count: topVal,
            games: champGames,
            champPct,
          });
          if (rate && rate.name === tied[0]) text += t('home.trivia.alsoRateKing');
        }
      }
      list.push({ icon: '🥇', text });
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
    const sortedAll = [...podiumAll.entries()].sort((a, b) => b[1] - a[1]);
    const topVal = sortedAll[0]?.[1] ?? 0;
    if (topVal >= 5) {
      topPodiumAllTimeCount = topVal;
      // Compare against year leader to avoid echo: only show if at
      // least 50% larger so the all-time framing carries weight.
      const yearLeaderCount = (() => {
        const c = new Map<string, number>();
        for (const gameId of yearGameIds) {
          const players = playersByGame.get(gameId);
          if (!players) continue;
          const psSorted = [...players].sort((a, b) => b.profit - a.profit);
          for (const p of psSorted.slice(0, 3).filter(p => p.profit > 0)) {
            c.set(p.playerName, (c.get(p.playerName) ?? 0) + 1);
          }
        }
        return [...c.values()].reduce((m, v) => v > m ? v : m, 0);
      })();
      if (topPodiumAllTimeCount >= Math.ceil(yearLeaderCount * 1.5) || topPodiumAllTimeCount >= yearLeaderCount + 5) {
        const tied = sortedAll.filter(([, v]) => v === topVal).map(([n]) => n);
        let text: string;
        if (tied.length > 1) {
          text = t('home.trivia.mostPodiumsAllTimeMulti', { players: tied.join(', '), count: topVal });
        } else {
          // Same rate-suffix pattern as #4c — inline absolute champ's
          // pct always, append a rate-champion comparison when a
          // *different* regular has a higher all-time podium rate, or
          // the alsoRateKing affirmation when the same player wins
          // both the count and the rate.
          const champGames = playerAllTimeGames.get(tied[0]) ?? topVal;
          const champPct = champGames > 0 ? Math.round((topVal / champGames) * 100) : 0;
          const rate = findRateChamp(podiumAll, playerAllTimeGames, allCompletedGameIds.size);
          if (rate && rate.name !== tied[0]) {
            text = t('home.trivia.mostPodiumsAllTimeWithRate', {
              name: tied[0],
              count: topVal,
              games: champGames,
              champPct,
              rateName: rate.name,
              pct: Math.round(rate.pct),
              wins: rate.wins,
              rateGames: rate.games,
            });
          } else {
            text = t('home.trivia.mostPodiumsAllTime', {
              name: tied[0],
              count: topVal,
              games: champGames,
              champPct,
            });
            if (rate && rate.name === tied[0]) text += t('home.trivia.alsoRateKing');
          }
        }
        list.push({ icon: '🥇', text });
      }
    }
  }

  // 7. Most popular location this year. Denominator is `yearGameIds.size`
  //    (every completed game in the year), not just located games — the
  //    user-facing "X% of games" is most useful as "share of all year
  //    games", which is what people actually compare against. Games
  //    without a `location` simply don't accrue to any spot.
  const locationCounts = new Map<string, number>();
  for (const g of games) {
    if (g.status !== 'completed') continue;
    if (new Date(g.date).getTime() < yearStart) continue;
    if (!g.location) continue;
    locationCounts.set(g.location, (locationCounts.get(g.location) ?? 0) + 1);
  }
  const topLocation = [...locationCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (topLocation && topLocation[1] >= 3 && yearGameIds.size > 0) {
    list.push({
      icon: '📍',
      text: t('home.trivia.popularLocation', {
        location: topLocation[0],
        count: topLocation[1],
        total: yearGameIds.size,
        pct: Math.round((topLocation[1] / yearGameIds.size) * 100),
      }),
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
  let biggestEver = { profit: 0 };
  let worstEver = { loss: 0 };
  for (const gp of allTimeGP) {
    if (gp.profit > biggestEver.profit) biggestEver = { profit: gp.profit };
    if (gp.profit < worstEver.loss) worstEver = { loss: gp.profit };
  }
  if (biggestEver.profit > biggest.profit) {
    // Only surface "ever" when it's larger than the year-scoped record;
    // otherwise the two entries would be redundant.
    const winners = allTimeGP.filter(gp => gp.profit === biggestEver.profit);
    if (winners.length === 1) {
      list.push({
        icon: '🏅',
        text: t('home.trivia.biggestWinAllTime', {
          profit: formatCurrency(biggestEver.profit),
          name: winners[0].playerName,
          date: formatTriviaDate(gameDateById.get(winners[0].gameId), language),
        }),
      });
    } else {
      list.push({
        icon: '🏅',
        text: t('home.trivia.biggestWinAllTimeMulti', {
          profit: formatCurrency(biggestEver.profit),
          count: String(winners.length),
          players: formatTiedPlayers(winners, language),
        }),
      });
    }
  }
  if (worstEver.loss < worst.loss && worstEver.loss < -50) {
    const losers = allTimeGP.filter(gp => gp.profit === worstEver.loss);
    if (losers.length === 1) {
      list.push({
        icon: '🥶',
        text: t('home.trivia.biggestLossAllTime', {
          amount: formatCurrency(Math.abs(worstEver.loss)),
          name: losers[0].playerName,
          date: formatTriviaDate(gameDateById.get(losers[0].gameId), language),
        }),
      });
    } else {
      list.push({
        icon: '🥶',
        text: t('home.trivia.biggestLossAllTimeMulti', {
          amount: formatCurrency(Math.abs(worstEver.loss)),
          count: String(losers.length),
          players: formatTiedPlayers(losers, language),
        }),
      });
    }
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
        text: t('home.trivia.popularDay', {
          day: dayLabel,
          count: dayCounts[topDayIdx],
          total: yearGameIds.size,
          pct: yearGameIds.size > 0 ? Math.round((dayCounts[topDayIdx] / yearGameIds.size) * 100) : 0,
        }),
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
          text: t('home.trivia.mostCommonSize', {
            players: topSize,
            count: topCount,
            total: yearGameIds.size,
            pct: yearGameIds.size > 0 ? Math.round((topCount / yearGameIds.size) * 100) : 0,
          }),
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

  // ── 17a/b/c/d. "Bridesmaid" + "bronze" awards — players who keep
  //         landing in 2nd or 3rd place. Surfaces a pattern players
  //         rarely realise themselves ("wait, am I always 2nd?").
  //         We track THIS YEAR and ALL-TIME variants for both 2nd
  //         and 3rd, sharing the per-game podium scan so we only
  //         walk each game once. Same per-game guard as #16: skip
  //         games with no real winner (top profit ≤ 0).
  //
  //         Year scan (uses `playersByGame` index built earlier).
  //         All-time scan (builds its own per-game player index
  //         once, reused for both 2nd and 3rd).
  if (yearGameIds.size >= 4) {
    const secondPlaceYear = new Map<string, number>();
    const thirdPlaceYear = new Map<string, number>();
    for (const gameId of yearGameIds) {
      const players = playersByGame.get(gameId);
      if (!players || players.length < 2) continue;
      const sorted = [...players].sort((a, b) => b.profit - a.profit);
      if (sorted[0].profit <= 0) continue;
      secondPlaceYear.set(sorted[1].playerName, (secondPlaceYear.get(sorted[1].playerName) ?? 0) + 1);
      if (sorted.length >= 3) {
        thirdPlaceYear.set(sorted[2].playerName, (thirdPlaceYear.get(sorted[2].playerName) ?? 0) + 1);
      }
    }
    const top2ndYear = [...secondPlaceYear.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top2ndYear && top2ndYear[1] >= 2) {
      const champGames = playerYearGames.get(top2ndYear[0]) ?? 0;
      const champPct = champGames > 0 ? Math.round((top2ndYear[1] / champGames) * 100) : 0;
      const rate = findRateChamp(secondPlaceYear, playerYearGames, yearGameIds.size);
      let text: string;
      if (rate && rate.name !== top2ndYear[0]) {
        text = t('home.trivia.mostSecondPlacesWithRate', {
          name: top2ndYear[0],
          count: top2ndYear[1],
          champGames,
          champPct,
          rateName: rate.name,
          pct: Math.round(rate.pct),
          wins: rate.wins,
          games: rate.games,
        });
      } else {
        text = t('home.trivia.mostSecondPlaces', { name: top2ndYear[0], count: top2ndYear[1], champGames, champPct });
        if (rate && rate.name === top2ndYear[0]) text += t('home.trivia.alsoRateKing');
      }
      list.push({ icon: '🥈', text });
    }
    const top3rdYear = [...thirdPlaceYear.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top3rdYear && top3rdYear[1] >= 2) {
      const champGames = playerYearGames.get(top3rdYear[0]) ?? 0;
      const champPct = champGames > 0 ? Math.round((top3rdYear[1] / champGames) * 100) : 0;
      const rate = findRateChamp(thirdPlaceYear, playerYearGames, yearGameIds.size);
      let text: string;
      if (rate && rate.name !== top3rdYear[0]) {
        text = t('home.trivia.mostThirdPlacesWithRate', {
          name: top3rdYear[0],
          count: top3rdYear[1],
          champGames,
          champPct,
          rateName: rate.name,
          pct: Math.round(rate.pct),
          wins: rate.wins,
          games: rate.games,
        });
      } else {
        text = t('home.trivia.mostThirdPlaces', { name: top3rdYear[0], count: top3rdYear[1], champGames, champPct });
        if (rate && rate.name === top3rdYear[0]) text += t('home.trivia.alsoRateKing');
      }
      list.push({ icon: '🥉', text });
    }
  }
  // All-time variant — only when the group has enough history
  // for the rolling year scan above to actually be a subset
  // (≥ 30 completed games, same gate as the other all-time
  // facts). Skipped silently otherwise to avoid duplicating the
  // year facts on fresh groups.
  const completedGameCount = games.filter(g => g.status === 'completed').length;
  if (completedGameCount >= 30) {
    const allTimePlayersByGame = new Map<string, GamePlayer[]>();
    for (const g of games) {
      if (g.status === 'completed') allTimePlayersByGame.set(g.id, []);
    }
    for (const gp of gamePlayers) {
      const arr = allTimePlayersByGame.get(gp.gameId);
      if (arr) arr.push(gp);
    }
    const secondPlaceAll = new Map<string, number>();
    const thirdPlaceAll = new Map<string, number>();
    for (const players of allTimePlayersByGame.values()) {
      if (players.length < 2) continue;
      const sorted = [...players].sort((a, b) => b.profit - a.profit);
      if (sorted[0].profit <= 0) continue;
      secondPlaceAll.set(sorted[1].playerName, (secondPlaceAll.get(sorted[1].playerName) ?? 0) + 1);
      if (sorted.length >= 3) {
        thirdPlaceAll.set(sorted[2].playerName, (thirdPlaceAll.get(sorted[2].playerName) ?? 0) + 1);
      }
    }
    const top2ndAll = [...secondPlaceAll.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top2ndAll && top2ndAll[1] >= 5) {
      const champGames = playerAllTimeGames.get(top2ndAll[0]) ?? 0;
      const champPct = champGames > 0 ? Math.round((top2ndAll[1] / champGames) * 100) : 0;
      const rate = findRateChamp(secondPlaceAll, playerAllTimeGames, allCompletedGameIds.size);
      let text: string;
      if (rate && rate.name !== top2ndAll[0]) {
        text = t('home.trivia.mostSecondPlacesAllTimeWithRate', {
          name: top2ndAll[0],
          count: top2ndAll[1],
          champGames,
          champPct,
          rateName: rate.name,
          pct: Math.round(rate.pct),
          wins: rate.wins,
          games: rate.games,
        });
      } else {
        text = t('home.trivia.mostSecondPlacesAllTime', { name: top2ndAll[0], count: top2ndAll[1], champGames, champPct });
        if (rate && rate.name === top2ndAll[0]) text += t('home.trivia.alsoRateKing');
      }
      list.push({ icon: '🥈', text });
    }
    const top3rdAll = [...thirdPlaceAll.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top3rdAll && top3rdAll[1] >= 5) {
      const champGames = playerAllTimeGames.get(top3rdAll[0]) ?? 0;
      const champPct = champGames > 0 ? Math.round((top3rdAll[1] / champGames) * 100) : 0;
      const rate = findRateChamp(thirdPlaceAll, playerAllTimeGames, allCompletedGameIds.size);
      let text: string;
      if (rate && rate.name !== top3rdAll[0]) {
        text = t('home.trivia.mostThirdPlacesAllTimeWithRate', {
          name: top3rdAll[0],
          count: top3rdAll[1],
          champGames,
          champPct,
          rateName: rate.name,
          pct: Math.round(rate.pct),
          wins: rate.wins,
          games: rate.games,
        });
      } else {
        text = t('home.trivia.mostThirdPlacesAllTime', { name: top3rdAll[0], count: top3rdAll[1], champGames, champPct });
        if (rate && rate.name === top3rdAll[0]) text += t('home.trivia.alsoRateKing');
      }
      list.push({ icon: '🥉', text });
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

  // ── 21. Best win rate THIS YEAR (≥ 3 games to qualify, so randos
  //         with one lucky win don't crown themselves). Computed from
  //         this-year participation only — the all-time win-rate
  //         leaderboard already lives in /statistics.
  //         Suppressed when it would just echo the rate-champion
  //         already inlined into #4 (`mostWinsWithRate`). The wins
  //         card carries strictly more info (it pairs the rate champ
  //         WITH the absolute count champion), so the standalone
  //         #21 card is pure duplicate when both pick the same
  //         player at the same displayed percentage. We still ride
  //         when the two diverge — #4's `findRateChamp` uses a
  //         stricter 30%-participation gate than #21's 3-game gate,
  //         so a hot newcomer with few games can crown #21 while
  //         a different established regular crowns #4's rate suffix.
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
    const roundedPct = Math.round(topRate.pct);
    const echoesMostWins =
      mostWinsRateChamp !== null &&
      mostWinsRateChamp.name === topRate.name &&
      mostWinsRateChamp.pct === roundedPct;
    if (topRate.pct >= 30 && !echoesMostWins) {
      list.push({
        icon: '🎯',
        text: t('home.trivia.bestWinRate', {
          name: topRate.name,
          verb: verbForName('won', topRate.name, language),
          pct: roundedPct,
          wins: topRate.wins,
          games: topRate.games,
        }),
      });
    }
  }

  // ── 21b. In-the-green rate THIS YEAR — % of games where the
  //          player finished with a positive profit (any positive,
  //          not just #1). This is a different lens from #21
  //          (bestWinRate, which only counts outright tournament
  //          wins). A solid 2nd-place player who consistently
  //          finishes profitable can crown this fact while never
  //          winning a single game outright — a story worth
  //          surfacing. Eligibility ≥ 5 year games (matches the
  //          win-rate gate); threshold ≥ 60% in the green so it's
  //          a meaningful statement, not "X is profitable in
  //          slightly more than half their nights".
  if (yearGameIds.size >= 4) {
    const greenStats = new Map<string, { green: number; games: number }>();
    for (const gp of yearGP) {
      const e = greenStats.get(gp.playerName) ?? { green: 0, games: 0 };
      e.games++;
      if (gp.profit > 0) e.green++;
      greenStats.set(gp.playerName, e);
    }
    // Compute everyone's pct (rounded — that's what we'd display) so a
    // tie at the displayed percentage surfaces as "tied", not as an
    // arbitrary winner. Eligibility ≥ 5 year games.
    type GreenRow = { name: string; pct: number; green: number; games: number };
    const greenRows: GreenRow[] = [];
    for (const [name, e] of greenStats) {
      if (e.games < 5) continue;
      greenRows.push({ name, pct: Math.round((e.green / e.games) * 100), green: e.green, games: e.games });
    }
    greenRows.sort((a, b) => b.pct - a.pct);
    const topPct = greenRows[0]?.pct ?? 0;
    if (topPct >= 60) {
      const tied = greenRows.filter(r => r.pct === topPct);
      list.push({
        icon: '🥷',
        text: tied.length === 1
          ? t('home.trivia.mostInTheGreen', {
              name: tied[0].name,
              pct: tied[0].pct,
              wins: tied[0].green,
              games: tied[0].games,
            })
          : t('home.trivia.mostInTheGreenMulti', {
              players: tied.map(r => r.name).join(', '),
              pct: topPct,
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

  // ── All-time scans (22a/b/c) share a single per-game index so
  //          the three facts each run in O(N) over completed games
  //          instead of O(N × M) re-filtering `gamePlayers` per
  //          game. Built once, reused three times. Skipped entirely
  //          when the ≥ 30-game gate isn't met (none of the three
  //          facts will fire anyway).
  if (allTimeGameCount >= 30) {
    const allTimeGameIndex = new Map<string, GamePlayer[]>();
    for (const g of games) {
      if (g.status === 'completed') allTimeGameIndex.set(g.id, []);
    }
    for (const gp of gamePlayers) {
      const arr = allTimeGameIndex.get(gp.gameId);
      if (arr) arr.push(gp);
    }

    // 22a. Tightest game ever — smallest gap between 1st and 2nd
    //      across the group's entire history. Genuine "wow" trivia
    //      since this is data nobody computes themselves. A 0-gap
    //      game (1st-place tie) is rendered with a different
    //      string variant because "0 chip gap" reads as a typo.
    //      Per-game gate: ≥ 3 players (heads-up isn't a podium race).
    let tightestGameId = '';
    let tightestGap = Infinity;
    let tightestDate = '';
    for (const g of games) {
      if (g.status !== 'completed') continue;
      const gp = allTimeGameIndex.get(g.id);
      if (!gp || gp.length < 3) continue;
      const sorted = gp.map(p => p.profit).sort((a, b) => b - a);
      const gap = sorted[0] - sorted[1];
      if (gap < tightestGap) {
        tightestGap = gap;
        tightestGameId = g.id;
        tightestDate = g.date || g.createdAt;
      }
    }
    if (tightestGameId) {
      list.push({
        icon: '⚖️',
        text: tightestGap === 0
          ? t('home.trivia.tightestEverTie', {
              date: formatTriviaDate(tightestDate, language),
            })
          : t('home.trivia.tightestEver', {
              gap: formatCurrency(Math.round(tightestGap)),
              date: formatTriviaDate(tightestDate, language),
            }),
      });
    }

    // 22b. Biggest pot ever — most chips that changed hands in a
    //      single game across the group's entire history.
    //      Computed as Σ positive profits (= |Σ negative| in a
    //      zero-sum game). The "this night was crazy" number.
    let biggestPot = 0;
    let biggestPotDate = '';
    let biggestPotPlayers = 0;
    for (const g of games) {
      if (g.status !== 'completed') continue;
      const gp = allTimeGameIndex.get(g.id);
      if (!gp || gp.length === 0) continue;
      let pot = 0;
      for (const p of gp) if (p.profit > 0) pot += p.profit;
      if (pot > biggestPot) {
        biggestPot = pot;
        biggestPotDate = g.date || g.createdAt;
        biggestPotPlayers = gp.length;
      }
    }
    if (biggestPot > 0) {
      list.push({
        icon: '💰',
        text: t('home.trivia.biggestPotEver', {
          amount: formatCurrency(Math.round(biggestPot)),
          players: biggestPotPlayers,
          date: formatTriviaDate(biggestPotDate, language),
        }),
      });
    }

    // 22e. Biggest table EVER — most players who ever sat down to a
    //      single night in this group. Different from the year-scoped
    //      "biggest table this year" (which we removed) because the
    //      all-time framing is the headline value. When multiple
    //      games tied at the same max size, surface the count rather
    //      than picking one arbitrary date.
    let maxTableSize = 0;
    let maxTableDates: string[] = [];
    for (const g of games) {
      if (g.status !== 'completed') continue;
      const ps = allTimeGameIndex.get(g.id);
      if (!ps) continue;
      const size = ps.length;
      if (size > maxTableSize) {
        maxTableSize = size;
        maxTableDates = [g.date || g.createdAt];
      } else if (size === maxTableSize) {
        maxTableDates.push(g.date || g.createdAt);
      }
    }
    if (maxTableSize >= 8) {
      // Pick the most recent date for the single-game phrasing so the
      // anchor feels current; the multi phrasing just reports the
      // count of tied nights.
      const recentDate = [...maxTableDates].sort((a, b) =>
        new Date(b).getTime() - new Date(a).getTime())[0];
      list.push({
        icon: '👥',
        text: maxTableDates.length === 1
          ? t('home.trivia.biggestTableAllTime', {
              players: maxTableSize,
              date: formatTriviaDate(recentDate, language),
            })
          : t('home.trivia.biggestTableAllTimeMulti', {
              players: maxTableSize,
              count: maxTableDates.length,
            }),
      });
    }

    // 22j. Wildest single-night SWING ever — biggest gap between
    //      the night's biggest winner and biggest loser across all
    //      history. The "everybody has a story about that night"
    //      number. Per-game gate ≥ 2 players so the fact only
    //      surfaces real multi-player nights.
    let wildestSwing = 0;
    let wildestSwingDate = '';
    for (const g of games) {
      if (g.status !== 'completed') continue;
      const ps = allTimeGameIndex.get(g.id);
      if (!ps || ps.length < 2) continue;
      let mx = -Infinity, mn = Infinity;
      for (const p of ps) {
        if (p.profit > mx) mx = p.profit;
        if (p.profit < mn) mn = p.profit;
      }
      const swing = mx - mn;
      if (swing > wildestSwing) {
        wildestSwing = swing;
        wildestSwingDate = g.date || g.createdAt;
      }
    }
    if (wildestSwing >= 200) {
      list.push({
        icon: '🎢',
        text: t('home.trivia.biggestSwingEver', {
          amount: formatCurrency(Math.round(wildestSwing)),
          date: formatTriviaDate(wildestSwingDate, language),
        }),
      });
    }

    // 22k. Biggest 1st-vs-2nd MARGIN ever — the night the winner
    //      lapped the field. Inverse of `tightestEver` (which
    //      surfaces the closest finish). Per-game gate ≥ 2 players
    //      AND winner profit > 0 (no false-positive "biggest
    //      margin" when nobody actually won).
    let biggestMarginEverGap = 0;
    let biggestMarginEverWinner = '';
    let biggestMarginEverRunnerUp = '';
    let biggestMarginEverDate = '';
    for (const g of games) {
      if (g.status !== 'completed') continue;
      const ps = allTimeGameIndex.get(g.id);
      if (!ps || ps.length < 2) continue;
      const sorted = [...ps].sort((a, b) => b.profit - a.profit);
      if (sorted[0].profit <= 0) continue;
      const margin = sorted[0].profit - sorted[1].profit;
      if (margin > biggestMarginEverGap) {
        biggestMarginEverGap = margin;
        biggestMarginEverWinner = sorted[0].playerName;
        biggestMarginEverRunnerUp = sorted[1].playerName;
        biggestMarginEverDate = g.date || g.createdAt;
      }
    }
    if (biggestMarginEverGap >= 150) {
      list.push({
        icon: '🚀',
        text: t('home.trivia.biggestMarginEver', {
          margin: formatCurrency(Math.round(biggestMarginEverGap)),
          winner: biggestMarginEverWinner,
          runnerUp: biggestMarginEverRunnerUp,
          date: formatTriviaDate(biggestMarginEverDate, language),
        }),
      });
    }

    // 22l. Iron-attendance, all-time — longest run of consecutive
    //      group games attended by any single player. The "they
    //      were at every game from spring 2023 to fall 2024" type
    //      of stat. Walk games chronologically; per player track
    //      the current run + their personal best run. Threshold
    //      ≥ 6 to surface only genuinely impressive streaks.
    {
      const orderedGames = [...games]
        .filter(g => g.status === 'completed')
        .sort((a, b) => new Date(a.date || a.createdAt).getTime() - new Date(b.date || b.createdAt).getTime());
      const currentRun = new Map<string, number>();
      let bestStreakName = '';
      let bestStreakLen = 0;
      // Build a per-game attendance set up-front so the inner loop
      // does O(player count) work instead of scanning gamePlayers.
      for (const g of orderedGames) {
        const ps = allTimeGameIndex.get(g.id);
        const attendees = new Set<string>(ps ? ps.map(p => p.playerName) : []);
        // Increment runs for everyone present, reset for everyone
        // who's been seen in the group but missed this night.
        for (const name of attendees) {
          const next = (currentRun.get(name) ?? 0) + 1;
          currentRun.set(name, next);
          if (next > bestStreakLen) {
            bestStreakLen = next;
            bestStreakName = name;
          }
        }
        // Reset attendance for non-attendees: anyone we've ever
        // tracked who isn't in this game's attendees set.
        for (const name of currentRun.keys()) {
          if (!attendees.has(name)) currentRun.set(name, 0);
        }
      }
      if (bestStreakLen >= 6) {
        list.push({
          icon: '🚪',
          text: t('home.trivia.longestAttendanceStreakEver', {
            name: bestStreakName,
            count: bestStreakLen,
          }),
        });
      }
    }

    // 22m. Day-of-week dominator — the player with the highest win
    //      rate on a specific day of the week, surfaced only when
    //      the dataset is rich enough to be meaningful: that day
    //      has ≥ 30 group games, the player attended ≥ 15 of them,
    //      AND their win rate is ≥ 30% (≥ ~3x random for a
    //      7-handed table). Different from the existing per-player
    //      bestWinRate fact because it's day-specific — surfaces
    //      patterns like "X owns Saturday games" that get hidden
    //      in the overall career rate.
    {
      type DayBucket = { wins: number; plays: number };
      const byPlayerByDay = new Map<string, Map<number, DayBucket>>();
      const totalDayGames = [0, 0, 0, 0, 0, 0, 0];
      for (const g of games) {
        if (g.status !== 'completed') continue;
        const ps = allTimeGameIndex.get(g.id);
        if (!ps || ps.length === 0) continue;
        const d = new Date(g.date);
        if (Number.isNaN(d.getTime())) continue;
        const dow = d.getDay();
        totalDayGames[dow] += 1;
        let winner = ps[0];
        for (const p of ps) if (p.profit > winner.profit) winner = p;
        for (const p of ps) {
          let inner = byPlayerByDay.get(p.playerName);
          if (!inner) {
            inner = new Map();
            byPlayerByDay.set(p.playerName, inner);
          }
          const entry = inner.get(dow) ?? { wins: 0, plays: 0 };
          entry.plays += 1;
          if (p.playerName === winner.playerName && winner.profit > 0) entry.wins += 1;
          inner.set(dow, entry);
        }
      }
      let topDay = { name: '', dow: -1, wins: 0, plays: 0, pct: 0 };
      for (const [name, byDay] of byPlayerByDay) {
        for (const [dow, bucket] of byDay) {
          if (totalDayGames[dow] < 30) continue;
          if (bucket.plays < 15) continue;
          const pct = (bucket.wins / bucket.plays) * 100;
          if (pct >= 30 && pct > topDay.pct) {
            topDay = { name, dow, wins: bucket.wins, plays: bucket.plays, pct };
          }
        }
      }
      if (topDay.dow >= 0) {
        const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
        const dayLabel = t(`home.trivia.dayOfWeek.${dayKeys[topDay.dow]}`);
        const isFemale = genderByName.get(topDay.name) === 'female';
        list.push({
          icon: '📆',
          text: t('home.trivia.dayDominator', {
            name: topDay.name,
            day: dayLabel,
            wins: topDay.wins,
            games: topDay.plays,
            pct: Math.round(topDay.pct),
            ta: isFemale ? 'ת' : '',
            ah: isFemale ? 'תה' : 'ה',
          }),
        });
      }
    }
  }

  // ── 22h. Best calendar YEAR ever — the year with the most games
  //          played, and (separately) the year with the largest
  //          chip volume. These are headline "wow" facts because
  //          nobody computes them manually. Gated on ≥ 2 calendar
  //          years of history so the fact distinguishes itself from
  //          the live current year.
  // ── 22i. Best calendar MONTH ever — same shape, finer-grained.
  //          Multi-tie variant when several months share the top
  //          game count (common when a busy March and June both
  //          ran 7 nights).
  {
    const yearTotals = new Map<number, { games: Set<string>; absSum: number }>();
    const monthTotals = new Map<string, { year: number; month: number; games: Set<string>; absSum: number }>();
    for (const gp of gamePlayers) {
      const g = games.find(gg => gg.id === gp.gameId);
      if (!g || g.status !== 'completed') continue;
      const d = new Date(g.date);
      if (Number.isNaN(d.getTime())) continue;
      const y = d.getFullYear();
      const m = d.getMonth();
      const monthKey = `${y}-${m}`;
      let yEntry = yearTotals.get(y);
      if (!yEntry) {
        yEntry = { games: new Set(), absSum: 0 };
        yearTotals.set(y, yEntry);
      }
      yEntry.games.add(g.id);
      yEntry.absSum += Math.abs(gp.profit);
      let mEntry = monthTotals.get(monthKey);
      if (!mEntry) {
        mEntry = { year: y, month: m, games: new Set(), absSum: 0 };
        monthTotals.set(monthKey, mEntry);
      }
      mEntry.games.add(g.id);
      mEntry.absSum += Math.abs(gp.profit);
    }

    if (yearTotals.size >= 2) {
      // Best year by game count.
      const yearsByGames = [...yearTotals.entries()].sort((a, b) => b[1].games.size - a[1].games.size);
      const topYearGames = yearsByGames[0];
      if (topYearGames && topYearGames[1].games.size >= 10) {
        list.push({
          icon: '📆',
          text: t('home.trivia.bestYearGames', {
            year: topYearGames[0],
            count: topYearGames[1].games.size,
          }),
        });
      }
      // Best year by chip volume (absSum / 2 = actual chips moved
      // since the abs-sum double-counts winners + losers in a
      // zero-sum game). Suppress when it picks the same year as the
      // games-leader AND that year is the current calendar year, to
      // avoid two facts both spotlighting the in-progress year.
      const yearsByChips = [...yearTotals.entries()].sort((a, b) => b[1].absSum - a[1].absSum);
      const topYearChips = yearsByChips[0];
      if (topYearChips && topYearChips[1].absSum >= 2000) {
        const currentYear = new Date().getFullYear();
        const echoesGamesLeader = topYearChips[0] === topYearGames?.[0] && topYearChips[0] === currentYear;
        if (!echoesGamesLeader) {
          list.push({
            icon: '💰',
            text: t('home.trivia.bestYearChips', {
              year: topYearChips[0],
              amount: formatCurrency(Math.round(topYearChips[1].absSum / 2)),
            }),
          });
        }
      }
    }

    if (monthTotals.size >= 4) {
      // Best month by game count — with multi-tie support.
      const monthsByGames = [...monthTotals.values()].sort((a, b) => b.games.size - a.games.size);
      const topMonthGamesCount = monthsByGames[0]?.games.size ?? 0;
      if (topMonthGamesCount >= 4) {
        const tiedMonths = monthsByGames.filter(m => m.games.size === topMonthGamesCount);
        const monthNames = (language === 'he' ? HEBREW_MONTH_NAMES : ENGLISH_MONTH_NAMES);
        const formatMonth = (m: { year: number; month: number }) => `${monthNames[m.month]} ${m.year}`;
        list.push({
          icon: '📆',
          text: tiedMonths.length === 1
            ? t('home.trivia.bestMonthGames', {
                month: formatMonth(tiedMonths[0]),
                count: topMonthGamesCount,
              })
            : t('home.trivia.bestMonthGamesMulti', {
                months: tiedMonths.map(formatMonth).join(', '),
                count: topMonthGamesCount,
              }),
        });
      }
      // Best month by chip volume.
      const monthsByChips = [...monthTotals.values()].sort((a, b) => b.absSum - a.absSum);
      const topMonthChips = monthsByChips[0];
      if (topMonthChips && topMonthChips.absSum >= 1000) {
        const monthNames = (language === 'he' ? HEBREW_MONTH_NAMES : ENGLISH_MONTH_NAMES);
        list.push({
          icon: '💰',
          text: t('home.trivia.bestMonthChips', {
            month: `${monthNames[topMonthChips.month]} ${topMonthChips.year}`,
            amount: formatCurrency(Math.round(topMonthChips.absSum / 2)),
          }),
        });
      }
    }
  }

  // ── 22d. Most consistent earner — the regular with the LOWEST
  //          profit standard deviation. "Wow, that player is a
  //          metronome" type of insight; opposite of all the
  //          "biggest swing" facts.
  //          Gates:
  //            · regular = > 50 lifetime games (Lior's bar — we used
  //              to allow ≥ 20 but a ~20-game sample is too noisy to
  //              meaningfully crown someone "the steadiest");
  //            · ≥ 3 such regulars exist (otherwise it's just "the
  //              only person with games" wearing a crown).
  //          The card now surfaces the actual stdev as a ±band so
  //          the parenthetical reinforces the headline claim instead
  //          of showing only the player's average (which doesn't
  //          explain why they earned the title).
  const regulars = playerStats.filter(p => p.gamesPlayed > 50);
  if (regulars.length >= 3) {
    const regularGameSets = new Map<string, number[]>();
    for (const ps of regulars) regularGameSets.set(ps.playerName, []);
    for (const gp of gamePlayers) {
      const arr = regularGameSets.get(gp.playerName);
      if (arr) arr.push(gp.profit);
    }
    let lowestStdev = Infinity;
    let lowestStdevPlayer: PlayerStats | null = null;
    for (const ps of regulars) {
      const profits = regularGameSets.get(ps.playerName) ?? [];
      if (profits.length <= 50) continue;
      const mean = profits.reduce((s, p) => s + p, 0) / profits.length;
      const variance = profits.reduce((s, p) => s + (p - mean) ** 2, 0) / profits.length;
      const stdev = Math.sqrt(variance);
      if (stdev < lowestStdev) {
        lowestStdev = stdev;
        lowestStdevPlayer = ps;
      }
    }
    if (lowestStdevPlayer) {
      list.push({
        icon: '📐',
        text: t('home.trivia.mostConsistent', {
          name: lowestStdevPlayer.playerName,
          stdev: formatCurrency(Math.round(lowestStdev)),
          avg: formatCurrency(Math.round(lowestStdevPlayer.avgProfit)),
          games: lowestStdevPlayer.gamesPlayed,
        }),
      });
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

  // ── 28b. Head-to-head king (ALL-TIME). For every pair of players
  //          (A, B) who have ever shared games, count how many of
  //          those shared games A finished above B by profit. Then
  //          for each player A, count the OPPONENTS B for whom A
  //          has a strict winning H2H record (A above B more often
  //          than B above A, requiring at least 4 shared games for
  //          the H2H to be statistically meaningful). The player
  //          with the most "won" opponents is the head-to-head
  //          king — they're the player most group-mates can't out-
  //          finish. Different from #4 (most wins, which only
  //          counts outright #1s) because finishing 2nd of 7
  //          beats 5 opponents in this metric without winning the
  //          night. Gates: ≥ 6 lifetime completed games AND the
  //          king has a winning H2H against ≥ 4 opponents AND
  //          against the majority of opponents they've shared
  //          enough games with — otherwise the framing "dominates
  //          head-to-head" is too generous.
  if (allCompletedGameIds.size >= 6) {
    // pair[A][B] = number of times A finished above B in a shared game
    const pair = new Map<string, Map<string, number>>();
    for (const gameId of allCompletedGameIds) {
      const ps = allTimePlayersByGame.get(gameId);
      if (!ps || ps.length < 2) continue;
      for (let i = 0; i < ps.length; i++) {
        for (let j = 0; j < ps.length; j++) {
          if (i === j) continue;
          if (ps[i].profit > ps[j].profit) {
            let inner = pair.get(ps[i].playerName);
            if (!inner) {
              inner = new Map();
              pair.set(ps[i].playerName, inner);
            }
            inner.set(ps[j].playerName, (inner.get(ps[j].playerName) ?? 0) + 1);
          }
        }
      }
    }
    // For each player A, walk every opponent B they've ever played
    // with and decide who wins the H2H. Count A's wins.
    const allNames = new Set<string>();
    for (const ps of allTimeGP) allNames.add(ps.playerName);
    let bestKing: {
      name: string;
      beat: number;
      total: number;
      // Opponents who actually lead the king in their H2H. Tracked
      // so the trivia copy can name them ("only X leads the H2H")
      // instead of leaving the user wondering who the missing
      // opponents are.
      lostTo: { name: string; lead: number }[];
      // Opponents who tied the king's H2H (aOverB === bOverA with at
      // least one decided shared game). Without this list, sentences
      // like "X dominates — beats 21 of 24, only Y leads" leave the
      // user wondering where the other 2 opponents went. Tracked
      // separately from `lostTo` because ties don't count against
      // dominance — they just deserve a remark so the math reads
      // honestly.
      tied: { name: string; shared: number }[];
    } = { name: '', beat: 0, total: 0, lostTo: [], tied: [] };
    for (const a of allNames) {
      let beat = 0;
      let total = 0;
      const lostTo: { name: string; lead: number }[] = [];
      const tied: { name: string; shared: number }[] = [];
      for (const b of allNames) {
        if (a === b) continue;
        const aOverB = pair.get(a)?.get(b) ?? 0;
        const bOverA = pair.get(b)?.get(a) ?? 0;
        const sharedAB = aOverB + bOverA;
        if (sharedAB < 4) continue; // not enough shared games for a real H2H
        total++;
        if (aOverB > bOverA) beat++;
        else if (bOverA > aOverB) lostTo.push({ name: b, lead: bOverA - aOverB });
        else tied.push({ name: b, shared: sharedAB });
      }
      // A is "king" only if they have a strict winning H2H against
      // a clear majority of qualified opponents. The 60% bar mirrors
      // the in-the-green threshold and prevents a "X beats 4 of 7"
      // (57%) borderline case from claiming dominance.
      if (total >= 4 && beat >= 4 && beat / total >= 0.6 && beat > bestKing.beat) {
        bestKing = { name: a, beat, total, lostTo, tied };
      }
    }
    if (bestKing.beat > 0) {
      // Sort the opponents who lead the king by H2H gap descending so
      // the most-dominant-over-king appears first when we list them.
      bestKing.lostTo.sort((a, b) => b.lead - a.lead);
      // Sort tied opponents by shared games desc so the
      // most-frequently-faced rival reads first ("tie with regular
      // opponent X" beats "tie with rare opponent Y" for narrative).
      bestKing.tied.sort((a, b) => b.shared - a.shared);
      const leaderCount = bestKing.lostTo.length;
      const leadersStr = bestKing.lostTo.map(l => l.name).join(', ');
      const key =
        leaderCount === 0
          ? 'home.trivia.h2hKing'
          : leaderCount === 1
            ? 'home.trivia.h2hKingWithLead'
            : 'home.trivia.h2hKingWithLeadPlural';
      let text = t(key, {
        name: bestKing.name,
        beat: bestKing.beat,
        total: bestKing.total,
        leaders: leadersStr,
      });
      if (bestKing.tied.length > 0) {
        const tiedStr = bestKing.tied.map(p => p.name).join(', ');
        text += t('home.trivia.h2hKingTieSuffix', { tied: tiedStr });
      }
      list.push({ icon: '🤜', text });
    }
  }

  // ── 30b. Group history age — a nostalgia anchor that lands well
  //          for established groups. Surfaces the date of the very
  //          first completed game and frames it as "we've been
  //          playing for X". Intentionally absolute (date, not "X
  //          years ago") so the line keeps reading correctly even
  //          if the user opens the app months from now without a
  //          re-render. Skipped for groups under 6 months — at that
  //          age the framing reads as "we just started" which is a
  //          different (less interesting) story.
  {
    let earliestMs = Infinity;
    let earliestIso = '';
    for (const g of games) {
      if (g.status !== 'completed') continue;
      const ts = new Date(g.date || g.createdAt).getTime();
      if (Number.isNaN(ts)) continue;
      if (ts < earliestMs) {
        earliestMs = ts;
        earliestIso = g.date || g.createdAt;
      }
    }
    if (earliestMs !== Infinity) {
      const ageYears = Math.floor((Date.now() - earliestMs) / (365 * 86_400_000));
      // Only surface for groups with ≥ 1 year of history. Younger
      // groups don't get the nostalgia framing — that story belongs
      // to established groups.
      if (ageYears >= 1) {
        list.push({
          icon: '🏰',
          text: t('home.trivia.groupAgeYears', {
            years: ageYears,
            date: formatTriviaDate(earliestIso, language),
          }),
        });
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
  // Recompute per-player counts from raw sessions so we can surface
  // BOTH the "answered" total (matches the SharedTrainingScreen "ענו"
  // column = scored + neutral) and the "scored" total (the accuracy
  // denominator). The cached `p.totalQuestions` field on
  // `TrainingPlayerData` is scored-only (set by `upsertPlayerSession`
  // in `trainingData.ts`), which previously caused a definitional
  // mismatch on home: the trivia "ליאור עשה X אימונים" headline
  // showed scored only (e.g. 407) while the leaderboard showed
  // answered (e.g. 500) for the same player. Volume-flavoured facts
  // now use the leaderboard-aligned "answered" total; the accuracy
  // fact keeps "scored" since the % is computed against scored.
  const trainerCounts = trainingPlayers.map(p => {
    const counts = getTrainingSessionCounts(p);
    return {
      player: p,
      answered: counts.totalAnswered,
      scored: counts.scored,
      accuracy: counts.accuracy,
    };
  });
  const trainersWithActivity = trainerCounts.filter(t => t.answered > 0);
  if (trainersWithActivity.length > 0) {
    // 31a. Top trainer by sheer volume — the player who's done the
    //      most reps. Counts neutral/near-miss attempts because they
    //      ARE training reps; this matches the "ענו" column on the
    //      shared-training leaderboard. Threshold ≥ 20 so a quick
    //      sample doesn't crown anyone.
    const topByVolume = [...trainersWithActivity].sort((a, b) => b.answered - a.answered)[0];
    if (topByVolume && topByVolume.answered >= 20) {
      list.push({
        icon: '🎓',
        category: 'training',
        text: t('home.trivia.topTrainerSessions', {
          name: topByVolume.player.playerName,
          count: topByVolume.answered,
        }),
      });
    }

    // 31b. Accuracy champion — uses SCORED answers (correct + wrong)
    //      because that's the denominator of the % shown. Eligibility
    //      gate is ≥ 30 SCORED so a small scored-sample can't crown
    //      an "accuracy king" even if their answered count is large
    //      (e.g. lots of near-misses). Hide if the leader from 31a is
    //      also the accuracy leader to avoid double-attribution.
    const eligibleAccuracy = trainersWithActivity.filter(t => t.scored >= 30);
    if (eligibleAccuracy.length > 0) {
      const topByAccuracy = [...eligibleAccuracy].sort((a, b) => b.accuracy - a.accuracy)[0];
      if (
        topByAccuracy
        && topByAccuracy.accuracy >= 60
        && topByAccuracy.player.playerName !== topByVolume?.player.playerName
      ) {
        list.push({
          icon: '🎯',
          category: 'training',
          text: t('home.trivia.topTrainerAccuracy', {
            name: topByAccuracy.player.playerName,
            pct: Math.round(topByAccuracy.accuracy),
            count: topByAccuracy.scored,
          }),
        });
      }
    }

    // 31c. Group-wide training volume — the headline number. Uses
    //      "answered" so the group total matches what the leaderboard
    //      "ענו" column rolls up to. Only surface when meaningful
    //      (≥ 50 group-wide reps).
    const totalGroupAnswered = trainersWithActivity.reduce((sum, t) => sum + t.answered, 0);
    if (totalGroupAnswered >= 50) {
      list.push({
        icon: '📚',
        category: 'training',
        text: t('home.trivia.totalTrainingQuestions', { count: totalGroupAnswered }),
      });
    }

    // 31d. How many players actually train. Surfaces engagement
    //      breadth ("X people are practicing", not just "Y reps")
    //      when the group has multiple trainers.
    if (trainersWithActivity.length >= 3) {
      list.push({
        icon: '👥',
        category: 'training',
        text: t('home.trivia.activeTrainers', { count: trainersWithActivity.length }),
      });
    }
  }

  return spreadTriviaByCategory(list);
}

// Re-orders the trivia list so facts that share a topic don't sit
// next to each other AND don't cluster in the early rotation. Two
// facts are considered "the same topic" when they share an explicit
// `category` tag (currently the 4 training facts, which cover the
// same domain despite using different icons 🎓 / 🎯 / 📚 / 👥) OR
// when they share an `icon` (which catches the year-vs-all-time
// mirror pairs: most-active 💪×2, win champion 👑×2, podium king
// 🥇×2, top duo 🤝×2, best avg 📈×2, plus accidental icon collisions
// like 🎯 = bestWinRate vs trainer-accuracy or 📚 = total all-time
// games vs total training questions).
//
// Algorithm: task-scheduler-with-cooldown. Each multi-item bucket B
// gets a target gap of `floor(n / count(B))` positions between its
// emissions. At each step we filter candidates by:
//   1. Drop the bucket we just emitted from (strict no-adjacency).
//   2. Among the rest, prefer buckets whose cooldown has elapsed.
//   3. Among those, take the bucket with the most items remaining
//      (ties broken by earliest source position, so the curated
//      "headline-first" feel survives — e.g. 🏆 biggest-win-of-the-
//      year still tends to lead the rotation).
//
// The cooldown is what stops a 4-item bucket like training from
// firing at positions 1, 3, 5, 35 (the no-adjacency-only outcome) —
// instead it fires at roughly 1, 9, 17, 25 in a 35-item list.
// Intra-bucket order is preserved (year fact before all-time fact).
function spreadTriviaByCategory(items: TriviaEntry[]): { icon: string; text: string }[] {
  if (items.length <= 2) return items.map(({ icon, text }) => ({ icon, text }));

  const keyOf = (e: TriviaEntry): string => e.category ?? e.icon;
  const n = items.length;

  type Bucket = {
    key: string;
    firstSrcIdx: number;
    queue: TriviaEntry[];
    lastEmit: number;
    targetGap: number;
  };
  const buckets = new Map<string, Bucket>();
  items.forEach((entry, srcIdx) => {
    const key = keyOf(entry);
    const existing = buckets.get(key);
    if (existing) existing.queue.push(entry);
    else buckets.set(key, {
      key,
      firstSrcIdx: srcIdx,
      queue: [entry],
      lastEmit: -Infinity,
      targetGap: 0,
    });
  });

  // Fast-path: if every bucket holds a single item, the source order
  // is already conflict-free. Skip the reordering work.
  if ([...buckets.values()].every(b => b.queue.length === 1)) {
    return items.map(({ icon, text }) => ({ icon, text }));
  }

  // Set per-bucket target gaps now that final counts are known.
  // `floor(n / count) - 1` gives roughly even spacing; clamped to
  // ≥ 1 so even a half-list-sized bucket still has SOME breathing
  // room (trivia lists are large enough that the clamp rarely fires).
  for (const b of buckets.values()) {
    b.targetGap = Math.max(1, Math.floor(n / b.queue.length) - 1);
  }

  const out: TriviaEntry[] = [];
  let lastKey: string | null = null;
  for (let pos = 0; pos < n; pos++) {
    const candidates = [...buckets.values()].filter(b => b.queue.length > 0);
    if (candidates.length === 0) break;

    // (1) Strict no-adjacency: don't emit twice from the same bucket
    // back-to-back, unless it's literally the only bucket left
    // (impossible while ≥ 2 buckets have items, which is the only
    // case where adjacency would be a regression).
    const noAdj = candidates.filter(b => b.key !== lastKey);
    const adjPool = noAdj.length > 0 ? noAdj : candidates;

    // (2) Cooldown filter: prefer buckets whose target gap has
    // elapsed since their last emission. If every eligible bucket
    // is still on cooldown, fall through to the full pool — better
    // to emit a slightly-too-soon repeat than to leave the slot empty
    // or violate adjacency by picking the just-emitted bucket.
    const cooldownOk = adjPool.filter(b => pos - b.lastEmit >= b.targetGap);
    const pool = cooldownOk.length > 0 ? cooldownOk : adjPool;

    pool.sort((a, b) => {
      if (b.queue.length !== a.queue.length) return b.queue.length - a.queue.length;
      return a.firstSrcIdx - b.firstSrcIdx;
    });

    const pick = pool[0];
    out.push(pick.queue.shift()!);
    pick.lastEmit = pos;
    lastKey = pick.key;
  }

  return out.map(({ icon, text }) => ({ icon, text }));
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

  // "Tap to train" is rendered as a subtle inline hint right after
  // the title (not a pill). The whole card is the click target —
  // matches the Trivia / About-You cards' new pattern so all three
  // interactive cards behave the same way on mobile.
  return (
    <HomeCard
      order={order}
      step={step}
      icon="🧠"
      title={t('newGame.training')}
      subtitle={subtitle}
      titleHint={t('home.training.tapToTrain')}
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
