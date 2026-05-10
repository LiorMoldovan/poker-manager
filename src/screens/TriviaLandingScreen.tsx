// Trivia landing screen — shown BEFORE the questions start.
//
// Why it exists: previously the two home-dashboard CTAs (👥 שחק חידון
// על השחקנים / 🌍 שחק חידון על הקבוצה) navigated straight to the first
// question. Users couldn't tell what they were about to play, couldn't
// see the leaderboard, and had no warm-up moment to read the rules.
// This screen is the "warm-up": pick a mode + length, see the
// leaderboard + your own stats, then tap start.
//
// URL contract (read here, written by handleStart into /trivia/play):
//   /trivia                     → defaults to 'mixed' mode (the
//                                  broadest pool, picked so users
//                                  always land on the most varied
//                                  starting point regardless of
//                                  which home CTA they tapped).
//   /trivia?preset=group        → preselect group mode
//   /trivia?preset=players      → preselect players mode (used by AboutYouCard CTA)
//   /trivia?preset=mixed        → preselect mixed mode
//   /trivia?cats=wins,history   → pre-apply category filter (deep-link
//                                 only — the in-app picker was removed
//                                 because a 10-question round benefits
//                                 from variety, not narrowing). Mode
//                                 chips still show the post-filter
//                                 template count when ?cats= is set.
//
// Start button navigates to /trivia/play?mode=...&cats=...&count=N
// — the game screen reads the same shape and runs the questions.
//
// Data contract:
//   - Leaderboard via fetch_trivia_leaderboard RPC (already in 063).
//   - Personal stats are derived from the same leaderboard row (we
//     pluck the row whose player_name matches the signed-in player).
//     Avoids a second query.

import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { usePermissions } from '../App';
import { useTranslation } from '../i18n';
import { supabase } from '../database/supabaseClient';
import { getGroupId } from '../database/supabaseCache';
import {
  countTemplates,
  type TriviaCategory,
  type TriviaMode,
} from '../utils/triviaGenerator';
import { hapticTap } from '../utils/haptics';

interface LeaderboardRow {
  player_name: string;
  games: number;
  total_questions: number;
  total_correct: number;
  accuracy: number | null;
  best_score: number;
  last_played: string;
}

const VALID_MODES: TriviaMode[] = ['group', 'players', 'mixed'];

const TriviaLandingScreen: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t, language } = useTranslation();
  const { playerName } = usePermissions();
  const isRtl = language === 'he';

  // Initial mode is 'mixed' by default — the broadest pool, so the
  // user lands on the most varied starting point regardless of
  // which home CTA they tapped. ?preset= is still honored as a
  // deep-link override (useful if someone bookmarks a specific
  // mode or shares a link), but no in-app entry point relies on
  // it any more.
  const initialMode = useMemo<TriviaMode>(() => {
    const p = searchParams.get('preset');
    return p && (VALID_MODES as string[]).includes(p) ? (p as TriviaMode) : 'mixed';
  }, [searchParams]);

  const [mode, setMode] = useState<TriviaMode>(initialMode);
  // The in-app categories picker was removed (it added clutter for a
  // 10-question session that benefits more from variety than topic
  // narrowing). The URL contract still honors `?cats=...` though, so
  // we hydrate `selectedCats` from the query string on mount and
  // serialize it back through `handleStart`. External deep links
  // (training admin, debug URLs, future "themed round" CTAs) keep
  // working with no UI scaffold.
  const selectedCats = useMemo<Set<TriviaCategory>>(() => {
    const raw = searchParams.get('cats');
    if (!raw) return new Set();
    const valid: TriviaCategory[] = ['profit_loss', 'wins', 'history', 'matchups'];
    const validSet = new Set(valid);
    const parsed = raw.split(',')
      .map(s => s.trim())
      .filter((s): s is TriviaCategory => validSet.has(s as TriviaCategory));
    return new Set(parsed);
  }, [searchParams]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[] | null>(null);
  // Session length — 10 is the floor (smaller rounds end before the
  // player warms up and produce noisy leaderboard scores), 20 is the
  // mid option, and 0 means "unlimited" (run every eligible template
  // once, capped at the pool size). The picker mirrors the training
  // screen's length selector ([3, 5, 0 = ללא הגבלה]) so the two
  // "practice" surfaces feel aligned. Sentinel: 0 = unlimited.
  const SESSION_LENGTHS = [10, 20, 0] as const;
  const [sessionLength, setSessionLength] = useState<number>(10);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const gid = getGroupId();
      if (!gid) {
        setLeaderboard([]);
        return;
      }
      const { data, error } = await supabase.rpc('fetch_trivia_leaderboard', { p_group_id: gid });
      if (cancelled) return;
      if (error) {
        setLeaderboard([]);
        return;
      }
      setLeaderboard((data as LeaderboardRow[]) ?? []);
    })();
    return () => { cancelled = true; };
  }, []);

  const myRow = useMemo(
    () => (leaderboard && playerName)
      ? leaderboard.find(r => r.player_name === playerName) ?? null
      : null,
    [leaderboard, playerName],
  );

  const myRank = useMemo(() => {
    if (!leaderboard || !playerName) return null;
    const idx = leaderboard.findIndex(r => r.player_name === playerName);
    return idx >= 0 ? idx + 1 : null;
  }, [leaderboard, playerName]);

  const handleStart = () => {
    hapticTap();
    const params = new URLSearchParams();
    params.set('mode', mode);
    if (selectedCats.size > 0) params.set('cats', Array.from(selectedCats).join(','));
    // Always serialise non-default lengths (including the 0
    // sentinel for "unlimited"). Game screen interprets 0 as
    // "use every eligible template once".
    if (sessionLength !== 10) params.set('count', String(sessionLength));
    navigate(`/trivia/play?${params.toString()}`);
  };

  // Pool sizes per mode — recomputed when the user toggles a
  // category filter so the chip count reflects the actual eligible
  // template pool. Uses useMemo because countTemplates iterates
  // ALL_TEMPLATES and we render this on every keystroke / repaint.
  const cats = useMemo(() => Array.from(selectedCats), [selectedCats]);
  const groupCount   = useMemo(() => countTemplates('group',   cats), [cats]);
  const playersCount = useMemo(() => countTemplates('players', cats), [cats]);
  const mixedCount   = useMemo(() => countTemplates('mixed',   cats), [cats]);

  // Mixed first — it's the default and the broadest pool, so users
  // see the recommended option upfront. Group + players follow as
  // narrowing alternatives.
  const modeOptions: { id: TriviaMode; label: string; help: string; count: number }[] = [
    { id: 'mixed',   label: t('trivia.landing.mode.mixed'),   help: t('trivia.landing.mode.mixedHelp'),   count: mixedCount },
    { id: 'group',   label: t('trivia.landing.mode.group'),   help: t('trivia.landing.mode.groupHelp'),   count: groupCount },
    { id: 'players', label: t('trivia.landing.mode.players'), help: t('trivia.landing.mode.playersHelp'), count: playersCount },
  ];

  // Canonical "me row" highlight — copied from StatisticsScreen so
  // the leaderboard reads identically to every other player table
  // in the app. Blue background tint + a 3px-right stripe (which in
  // RTL Hebrew sits at the start edge — i.e. on the player-name
  // side, where the eye lands first).
  const ME_BG = 'rgba(59, 130, 246, 0.14)';
  const meRowStyle = { background: ME_BG, borderRight: '3px solid #3b82f6' } as const;
  const meNameStyle = { color: '#60a5fa' } as const;

  return (
    <div
      className="fade-in"
      style={{
        // No inline x-axis padding — `.main-content` already gives
        // every screen 1rem (1.5rem on tablets+). The page mirrors
        // the layout structure of `SharedTrainingScreen` so the two
        // "practice" surfaces feel like siblings in the app.
        paddingBottom: '5rem',
        direction: isRtl ? 'rtl' : 'ltr',
      }}
    >
      {/* Header — title + greeting with the player's name, matching
          the training screen pattern ("שלום ליאור"). The greeting
          is more inviting than a generic tagline and parallels the
          training landing exactly. Falls back to the descriptive
          subtitle when we don't yet know the player's name. */}
      <div className="page-header">
        <h1 className="page-title">{t('trivia.landing.title')}</h1>
        <p className="page-subtitle">
          {playerName
            ? t('trivia.landing.greeting', { name: playerName })
            : t('trivia.landing.subtitle')}
        </p>
      </div>

      {/* Game-style note — same structure / tint / icon as the note
          on the SharedTrainingScreen so the two surfaces share an
          identical "what to expect" affordance. Sets the user's
          mental model BEFORE they touch any of the controls below. */}
      <div style={{
        padding: '0.5rem 0.75rem',
        borderRadius: '8px',
        marginBottom: '0.5rem',
        background: 'rgba(99,102,241,0.06)',
        border: '1px solid rgba(99,102,241,0.15)',
        fontSize: '0.7rem',
        color: 'var(--text-muted)',
        lineHeight: 1.6,
        display: 'flex',
        gap: '0.35rem',
      }}>
        <span style={{ flexShrink: 0 }}>💡</span>
        <span>{t('trivia.landing.styleNote')}</span>
      </div>

      {/* Start Trivia card — combines mode + length + categories +
          the start CTA in a single card, exactly like the training
          screen's "Start Training" card. The biggest UX win of the
          alignment: the START button is no longer buried under the
          leaderboard — it sits next to the controls that decide
          what gets started, so users can configure-and-launch in
          one glance without scrolling. */}
      <div className="card" style={{ padding: '0.75rem' }}>
        {/* Mode picker */}
        <div style={{
          fontSize: '0.75rem', color: 'var(--text-muted)',
          fontWeight: 600, marginBottom: '0.4rem',
        }}>
          {t('trivia.landing.modeTitle')}
        </div>
        <div style={{ display: 'flex', gap: '0.3rem', marginBottom: '0.5rem' }}>
          {modeOptions.map(opt => {
            const active = mode === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => { hapticTap(); setMode(opt.id); }}
                className="btn btn-sm btn-secondary"
                style={{
                  flex: 1,
                  padding: '0.4rem 0.3rem',
                  fontSize: '0.72rem',
                  fontWeight: 600,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '0.1rem',
                  lineHeight: 1.2,
                  ...(active ? {
                    background: 'rgba(16,185,129,0.15)',
                    border: '1px solid rgba(16,185,129,0.4)',
                    color: '#34d399',
                  } : {}),
                }}
              >
                <span>{opt.label}</span>
                {/* Pool size — same affordance as the SharedTraining
                    mode chips. Counts TEMPLATES (not generated
                    questions) so the number is stable regardless of
                    group composition. Hidden when the category
                    filter wipes a mode's pool to zero so we don't
                    visually invite the user into a dead-end. */}
                {opt.count > 0 && (
                  <span style={{ fontSize: '0.6rem', opacity: 0.75, fontWeight: 500 }}>
                    {opt.count} {t('trivia.landing.mode.count')}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div style={{
          fontSize: '0.7rem',
          color: 'var(--text-muted)',
          lineHeight: 1.5,
          marginBottom: '0.6rem',
        }}>
          {modeOptions.find(o => o.id === mode)?.help}
        </div>

        {/* Session length */}
        <div style={{
          fontSize: '0.75rem', color: 'var(--text-muted)',
          fontWeight: 600, marginBottom: '0.4rem',
        }}>
          {t('trivia.landing.sessionLengthTitle')}
        </div>
        <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.6rem' }}>
          {SESSION_LENGTHS.map(n => {
            const active = sessionLength === n;
            // 0 is the "unlimited" sentinel — render the localized
            // "ללא הגבלה" / "Unlimited" label instead of "0", at a
            // slightly smaller font so it fits the same button width
            // as the numeric options.
            const isUnlimited = n === 0;
            return (
              <button
                key={n}
                type="button"
                onClick={() => { hapticTap(); setSessionLength(n); }}
                className="btn btn-sm btn-secondary"
                style={{
                  flex: 1,
                  padding: '0.45rem',
                  fontSize: isUnlimited ? '0.7rem' : '0.8rem',
                  fontWeight: 600,
                  ...(active ? {
                    background: 'rgba(16,185,129,0.15)',
                    border: '1px solid rgba(16,185,129,0.4)',
                    color: '#34d399',
                  } : {}),
                }}
              >
                {isUnlimited ? t('trivia.landing.unlimited') : n}
              </button>
            );
          })}
        </div>

        {/* Categories filter is intentionally NOT rendered here.
            The in-app picker added too much vertical clutter for too
            little payoff (a 10-question session benefits from
            variety, not from narrowing the pool to one topic). The
            URL contract still honors `?cats=...` so a deep link can
            pre-filter — `selectedCats` is hydrated from the URL on
            mount and serialized back into `handleStart`'s push, so
            external launchers (training admin links, debug links)
            keep working unchanged. If you ever want the picker back,
            git-blame this comment. */}

        {/* Start CTA — uses the standard `.btn .btn-primary` class
            (same gradient as Training's "🎯 התחל אימון" button) so
            the two practice surfaces have an identical primary
            action visual. */}
        <button
          type="button"
          onClick={handleStart}
          className="btn btn-primary"
          style={{ width: '100%', padding: '0.65rem', fontSize: '0.95rem' }}
        >
          🎮 {t('trivia.landing.start')}
        </button>
      </div>

      {/* My stats — moved BELOW the start card so the start CTA is
          the first thing in the user's eye after the explanatory
          note. Only renders when the player has data. */}
      {myRow && (
        <div className="card" style={{ padding: '0.75rem', marginTop: '0.5rem' }}>
          <div style={{
            fontSize: '0.75rem', color: 'var(--text-muted)',
            fontWeight: 600, marginBottom: '0.5rem',
          }}>
            {t('trivia.landing.myStatsTitle')}
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '0.5rem',
            textAlign: 'center',
          }}>
            <div style={{
              padding: '0.6rem',
              borderRadius: '10px',
              background: 'var(--background)',
              border: '1px solid var(--border)',
            }}>
              <div style={{ fontSize: '1.3rem', fontWeight: 800, color: 'var(--text)' }}>{myRow.games}</div>
              <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                {t('trivia.landing.myStats.played')}
              </div>
            </div>
            <div style={{
              padding: '0.6rem',
              borderRadius: '10px',
              background: 'var(--background)',
              border: '1px solid var(--border)',
            }}>
              <div style={{ fontSize: '1.3rem', fontWeight: 800, color: 'var(--success)' }}>{myRow.best_score}</div>
              <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                {t('trivia.landing.myStats.best')}
              </div>
            </div>
            <div style={{
              padding: '0.6rem',
              borderRadius: '10px',
              background: 'var(--background)',
              border: '1px solid var(--border)',
            }}>
              <div style={{
                fontSize: '1.3rem', fontWeight: 800,
                color: (myRow.accuracy ?? 0) >= 70 ? 'var(--success)' : (myRow.accuracy ?? 0) >= 40 ? '#3b82f6' : '#f59e0b',
              }}>
                {myRow.accuracy != null ? `${myRow.accuracy}%` : '—'}
              </div>
              <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                {t('trivia.landing.myStats.accuracy')}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Leaderboard — restyled to match the canonical app table
          pattern from `StatisticsScreen.tsx` (the most-used table
          surface in the app). Concretely: card padding 0.5rem,
          centered title at 0.85rem, table at 0.7rem, th/td padding
          0.25/0.3rem, RTL-aware textAlign on the player column,
          rank cells get a "1 🥇 / 2 🥈 / 3 🥉" inline medal suffix
          for the podium, and the "me" row uses `borderRight` (not
          borderInlineStart) so the highlight stripe lands on the
          Hebrew-reader start edge — exactly the way Stats does it. */}
      <div className="card" style={{ padding: '0.5rem', marginTop: '0.5rem' }}>
        <div style={{
          textAlign: 'center', fontSize: '0.85rem', fontWeight: 600,
          color: 'var(--text)', marginBottom: '0.5rem',
        }}>
          {t('trivia.landing.leaderboardTitle')}
        </div>
        {leaderboard === null ? (
          <div style={{ textAlign: 'center', padding: '0.75rem', color: 'var(--text-muted)', fontSize: '0.7rem' }}>
            {t('trivia.landing.leaderboardLoading')}
          </div>
        ) : leaderboard.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '0.5rem', color: 'var(--text-muted)', fontSize: '0.7rem' }}>
            {t('trivia.landing.leaderboardEmpty')}
          </div>
        ) : (
          <table style={{ width: '100%', fontSize: '0.7rem', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ textAlign: isRtl ? 'right' : 'left', padding: '0.25rem 0.2rem' }}>#</th>
                <th style={{ textAlign: isRtl ? 'right' : 'left', padding: '0.25rem 0.2rem' }}>
                  {t('trivia.leaderboard.col.player')}
                </th>
                {/* Questions answered comes BEFORE correct count so the
                    reader sees the denominator before the numerator. */}
                <th style={{ textAlign: 'center', padding: '0.25rem 0.2rem' }}>
                  {t('trivia.leaderboard.col.games')}
                </th>
                <th style={{ textAlign: 'center', padding: '0.25rem 0.2rem' }}>
                  {t('trivia.leaderboard.col.correct')}
                </th>
                <th style={{ textAlign: 'center', padding: '0.25rem 0.2rem' }}>
                  {t('trivia.leaderboard.col.accuracy')}
                </th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.slice(0, 10).map((row, i) => {
                const isMe = row.player_name === playerName;
                const acc = row.accuracy ?? 0;
                return (
                  <tr key={row.player_name} style={{
                    borderBottom: '1px solid rgba(255,255,255,0.03)',
                    ...(isMe ? meRowStyle : {}),
                  }}>
                    <td style={{
                      padding: '0.3rem 0.2rem', whiteSpace: 'nowrap',
                      textAlign: isRtl ? 'right' : 'left',
                    }}>
                      {i + 1}{i < 3 ? ` ${['🥇', '🥈', '🥉'][i]}` : ''}
                    </td>
                    <td style={{
                      padding: '0.3rem 0.2rem', fontWeight: isMe ? 700 : 500,
                      textAlign: isRtl ? 'right' : 'left',
                      ...(isMe ? meNameStyle : {}),
                    }}>
                      {row.player_name}
                    </td>
                    <td style={{ padding: '0.3rem 0.2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                      {row.total_questions}
                    </td>
                    <td style={{ padding: '0.3rem 0.2rem', textAlign: 'center', color: 'var(--success)', fontWeight: 600 }}>
                      {row.total_correct}
                    </td>
                    <td style={{
                      padding: '0.3rem 0.2rem', textAlign: 'center', fontWeight: 600,
                      color: row.accuracy == null
                        ? 'var(--text-muted)'
                        : acc >= 60 ? 'var(--success)' : acc >= 40 ? '#eab308' : 'var(--danger)',
                    }}>
                      {row.accuracy != null ? `${row.accuracy}%` : '—'}
                    </td>
                  </tr>
                );
              })}
              {/* "Me" row pinned at the bottom when off the top-10 */}
              {myRank !== null && myRank > 10 && myRow && (
                <>
                  <tr>
                    <td colSpan={5} style={{ padding: 0 }}>
                      <div style={{ height: 1, background: 'var(--border)', margin: '0.2rem 0' }} />
                    </td>
                  </tr>
                  <tr style={meRowStyle}>
                    <td style={{
                      padding: '0.3rem 0.2rem', whiteSpace: 'nowrap',
                      textAlign: isRtl ? 'right' : 'left',
                    }}>
                      {myRank}
                    </td>
                    <td style={{
                      padding: '0.3rem 0.2rem', fontWeight: 700,
                      textAlign: isRtl ? 'right' : 'left',
                      ...meNameStyle,
                    }}>
                      {myRow.player_name}
                    </td>
                    <td style={{ padding: '0.3rem 0.2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                      {myRow.total_questions}
                    </td>
                    <td style={{ padding: '0.3rem 0.2rem', textAlign: 'center', color: 'var(--success)', fontWeight: 600 }}>
                      {myRow.total_correct}
                    </td>
                    <td style={{
                      padding: '0.3rem 0.2rem', textAlign: 'center', fontWeight: 600,
                      color: myRow.accuracy == null
                        ? 'var(--text-muted)'
                        : (myRow.accuracy ?? 0) >= 60 ? 'var(--success)' : (myRow.accuracy ?? 0) >= 40 ? '#eab308' : 'var(--danger)',
                    }}>
                      {myRow.accuracy != null ? `${myRow.accuracy}%` : '—'}
                    </td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Back to home — matches the training screen footer
          exactly (same class, same Hebrew copy pattern). The
          start CTA lives in the start card above; this button is
          the secondary "I'm not playing right now" exit. */}
      <button
        type="button"
        onClick={() => { hapticTap(); navigate('/'); }}
        className="btn btn-secondary"
        style={{ width: '100%', marginTop: '0.75rem', padding: '0.6rem', fontSize: '0.8rem' }}
      >
        {t('trivia.landing.back')}
      </button>
    </div>
  );
};

export default TriviaLandingScreen;
