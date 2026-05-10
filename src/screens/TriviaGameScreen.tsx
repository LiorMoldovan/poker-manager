// Trivia game screen — accessed from the trivia landing page
// (`/trivia`) via the Start button, which serializes the user's
// chosen mode + length + categories into the URL. Home dashboard
// cards land on the landing page first so the user can review the
// leaderboard and tweak settings; they never deep-link to this
// screen directly. Single screen owns the entire flow:
//   1. Generate a 10-question batch from live group data.
//   2. Render one question at a time with a 20-second timer.
//   3. After answer (or timeout) → reveal correct + brief pause →
//      auto-advance.
//   4. At session end → save row to `trivia_sessions` → show local
//      summary + group-wide leaderboard fetched via RPC.
//
// Design choices:
// - We DON'T persist per-question answers. Only the aggregate session
//   row goes into the DB. The leaderboard ranks by total_correct
//   across sessions, which is enough for "trivia king" bragging
//   rights and keeps the schema simple. If we ever want per-question
//   analytics later, we can add a `trivia_answers` table without
//   touching `trivia_sessions`.
// - The timer is a hard countdown — when it reaches 0 the question
//   auto-locks as "wrong" (no answer selected). The 20s per question
//   was tuned up from an initial 15s after early testing showed
//   player-mode questions (which require recalling a specific
//   person's stat) needed extra reading + thinking time.

import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { usePermissions } from '../App';
import { useTranslation } from '../i18n';
import { getAllGames, getAllGamePlayers, getAllPlayers, getPlayerStats } from '../database/storage';
import { supabase } from '../database/supabaseClient';
import { getGroupId } from '../database/supabaseCache';
import {
  generateTriviaBatch,
  TRIVIA_CATEGORIES,
  type TriviaCategory,
  type TriviaMode,
  type TriviaQuestion,
} from '../utils/triviaGenerator';
import { hapticTap } from '../utils/haptics';
import { captureAndSplit, shareFiles } from '../utils/sharing';
import { notifySuperAdminsOfTriviaReport } from '../utils/triviaReportNotifications';

// Default round length when the URL doesn't specify ?count=N. The
// landing screen lets users pick 10 / 20 / 0 (= "unlimited", which
// runs every eligible template once up to UNLIMITED_QUESTION_CAP).
// We coerce parsed values outside the allowed set to the default so
// a hand-typed /trivia/play?count=999 doesn't blow up the template
// pool or the leaderboard scoring. 10 is the floor for the
// numeric options because anything smaller felt like it ended
// before the player warmed up.
const DEFAULT_QUESTION_COUNT = 10;
const ALLOWED_QUESTION_COUNTS = new Set([0, 10, 20]);
// Hard cap when the user picks "unlimited". Total template count
// is currently ~205 (group ~152 + players ~53; mixed sees the union).
// This cap leaves headroom for future templates without risking an
// infinite loop in `generateTriviaBatch` (which already breaks when
// no new question can be added, but a finite sentinel is still
// defensive and makes the leaderboard math sane). Note: in `group`-
// only unlimited mode the cap (200) exceeds the group pool (152),
// so the engine's repeat-protection relaxes for the last ~48 slots
// — we accept this as a deliberate trade (round runs to length over
// strict no-repeat) since unlimited is a power-user mode.
const UNLIMITED_QUESTION_CAP = 200;
// 20s gives the user time to actually READ the question + 4 answer
// options + think — 15s was tight on player-mode questions where
// the player has to recall a specific person's stat. Bumped to 20s
// to reduce timeout-driven wrong answers without making the round
// drag (10 × 20 = ~3:30, 20 × 20 = ~7:00).
const SECONDS_PER_QUESTION = 20;
// After answer reveal, pause this long so the user can read the
// correct answer + explanation before auto-advancing. We split
// the budget by outcome — wrong answers and timeouts get nearly
// double the time so the user can actually study the right answer
// and understand WHY they missed it (the explanation usually
// includes the supporting stat: "X has 12 first-place finishes
// in 47 games — top of the group"). Correct answers get the
// shorter pause since the user already knew the answer; the
// reveal is a quick confirmation, not a learning moment.
//
// User can ALWAYS extend the pause indefinitely by tapping the 🚩
// report button, which freezes the auto-advance — handy for the
// rare case the explanation needs more than 7 seconds to digest.
//
// Round-time budget at 10 questions:
//   best  = 10 × (20 + 4)   = ~4:00
//   worst = 10 × (20 + 5.5) = ~4:15
// — both well under the "phone-friendly tempo" target.
// Wrong-pause stays strictly longer than correct-pause so a missed
// answer always gets more reading time than a confirmed one, but
// the gap is small enough that a string of misses doesn't drag.
const REVEAL_PAUSE_CORRECT_MS = 4000;
const REVEAL_PAUSE_WRONG_MS = 5500;

interface LeaderboardRow {
  player_name: string;
  games: number;
  total_questions: number;
  total_correct: number;
  accuracy: number | null;
  best_score: number;
  last_played: string;
}

const TriviaGameScreen = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { playerName } = usePermissions();
  const { t, language } = useTranslation();

  // Mode + categories come from the landing screen via URL. Defaults
  // (someone hits /trivia/play directly without going through landing)
  // give the broadest experience: 'mixed' mode + no category filter.
  // Unknown values fall back to the default rather than throwing — the
  // only valid category source is the landing screen anyway.
  const mode: TriviaMode = (() => {
    const m = searchParams.get('mode');
    if (m === 'group' || m === 'players' || m === 'mixed') return m;
    return 'mixed';
  })();
  const validCatIds = new Set<TriviaCategory>(TRIVIA_CATEGORIES.map(c => c.id));
  const categories: TriviaCategory[] = (searchParams.get('cats') ?? '')
    .split(',')
    .map(s => s.trim())
    .filter((s): s is TriviaCategory => validCatIds.has(s as TriviaCategory));
  // Question count is read from the URL; values outside the picker's
  // allowed set are coerced to the default so a hand-typed
  // /trivia/play?count=999 doesn't blow up the template pool. The
  // landing screen passes `0` for "unlimited" — we translate that
  // to UNLIMITED_QUESTION_CAP here so `generateTriviaBatch` sees a
  // finite budget but the user gets every eligible template.
  const questionCount: number = (() => {
    const raw = parseInt(searchParams.get('count') ?? '', 10);
    if (!ALLOWED_QUESTION_COUNTS.has(raw)) return DEFAULT_QUESTION_COUNT;
    return raw === 0 ? UNLIMITED_QUESTION_CAP : raw;
  })();

  const [questions, setQuestions] = useState<TriviaQuestion[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  // Captured at the moment of click (not derived later from
  // `q.answers[selectedIdx]`). Eliminates an entire class of bugs
  // where a re-render between the click and the result-recording
  // effect could read a stale or reshuffled answers array — which
  // historically caused some users (specifically Lior on
  // 2026-05-10) to get persistent 0/10 even when they answered
  // correctly. The advance/reveal effect now reads this flag
  // directly instead of recomputing.
  const [selectedIsCorrect, setSelectedIsCorrect] = useState<boolean | null>(null);
  // `timedOut` distinguishes "user picked wrong" from "user ran out
  // of clock" so the reveal banner can phrase it differently.
  const [timedOut, setTimedOut] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(SECONDS_PER_QUESTION);
  const [results, setResults] = useState<{ correct: boolean; templateId: string }[]>([]);
  const [phase, setPhase] = useState<'loading' | 'playing' | 'summary' | 'empty'>('loading');
  const [leaderboard, setLeaderboard] = useState<LeaderboardRow[] | null>(null);
  const [savedToDb, setSavedToDb] = useState(false);
  // True when persistAndLoadLeaderboard refuses to save a session
  // because it looks like a scoring-bug artifact (0 correct out of
  // ≥5 questions — see the long-form comment in that function for
  // the rationale). Surfaced to the user as a friendly "this round
  // wasn't recorded" notice in the summary so they know why their
  // result didn't appear on the leaderboard, and aren't surprised
  // by a clean personal-stats card after finishing the round.
  const [sessionRejected, setSessionRejected] = useState(false);

  // ── Question-report flow (mirrors training's flagReports UX, but
  //    much simpler — questions are dynamic so we persist the FULL
  //    question text in `trivia_reports` instead of pointing at a
  //    pool row). The panel pauses auto-advance so the user has time
  //    to pick a reason and write a comment.
  type ReportReason = 'wrong_answer' | 'unclear_question' | 'other';
  const [showReportPanel, setShowReportPanel] = useState(false);
  const [reportReason, setReportReason] = useState<ReportReason | null>(null);
  const [reportComment, setReportComment] = useState('');
  const [reportSending, setReportSending] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  // Tracks which question indexes in THIS session were reported, so
  // the reveal banner can swap the report pill for a "thanks" note.
  const [reportedIdxs, setReportedIdxs] = useState<Set<number>>(new Set());

  // Share-summary state — image-share of the end-of-round score
  // (mode chip + score + per-question dots), captured off-screen
  // and handed to navigator.share via the same captureAndSplit /
  // shareFiles pipeline the home cards use. Reentrancy-guarded by
  // `isSharingScore` so a double-tap can't fire two captures.
  const [isSharingScore, setIsSharingScore] = useState(false);
  const summaryShareRef = useRef<HTMLDivElement | null>(null);

  // Refs so the timer effect doesn't restart on every state change.
  const intervalRef = useRef<number | null>(null);
  const advanceTimeoutRef = useRef<number | null>(null);

  // ── Batch loader ───────────────────────────────────────────────
  // Pulls live data + generates a fresh question batch, applying
  // it to state. Used by both the initial boot effect AND the
  // `restart()` handler, so the two paths can never drift apart
  // (previous version inlined the same body twice — every change
  // had to be made in two places, which is exactly how bugs hide).
  const loadBatch = useCallback(() => {
    const games = getAllGames();
    const gamePlayers = getAllGamePlayers();
    const playerStats = getPlayerStats();
    const players = getAllPlayers();
    const batch = generateTriviaBatch(mode, questionCount, {
      games,
      gamePlayers,
      playerStats,
      players,
      selfPlayerName: playerName,
      language,
      t,
    }, categories);
    if (batch.length === 0) {
      setPhase('empty');
    } else {
      setQuestions(batch);
      setPhase('playing');
    }
    // `t`/`language` deliberately omitted — they're stable across a
    // session, and re-running the generator on a `t` identity flip
    // (which can happen on settings re-render) would shuffle the
    // question pool mid-game. `categories` is also stable across a
    // session (parsed once from URL).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, questionCount, playerName]);

  // ── Boot: build a batch from live data ─────────────────────────
  useEffect(() => {
    loadBatch();
  }, [loadBatch]);

  // ── Per-question countdown ─────────────────────────────────────
  // Reset the countdown to its full budget when the question
  // changes. Kept as its own effect so opening / closing the
  // report panel mid-question doesn't reset the clock — the
  // ticking effect below pauses on showReportPanel and resumes
  // from the current value instead.
  useEffect(() => {
    if (phase !== 'playing') return;
    setSecondsLeft(SECONDS_PER_QUESTION);
  }, [phase, currentIdx]);

  // The actual ticking interval. Pauses when:
  //   • the user has answered (selectedIdx !== null) or run out of
  //     time (timedOut),
  //   • the report panel is open pre-answer, so the user has time
  //     to write the report without losing the question. The clock
  //     resumes from its current value on close (no free seconds).
  useEffect(() => {
    if (phase !== 'playing') return;
    if (selectedIdx !== null || timedOut) return;
    if (showReportPanel) return;
    intervalRef.current = window.setInterval(() => {
      setSecondsLeft(prev => {
        if (prev <= 1) {
          if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
          }
          setTimedOut(true);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [phase, currentIdx, selectedIdx, timedOut, showReportPanel]);

  // ── Reveal → auto-advance ──────────────────────────────────────
  // The advance timer is paused while the user is in the middle of
  // filing a report (`showReportPanel === true`). When they close
  // the panel — either by submitting or cancelling — this effect
  // re-fires (showReportPanel is in the dep list) and a fresh
  // 1.8s countdown starts so the question doesn't get stuck.
  useEffect(() => {
    if (phase !== 'playing') return;
    if (selectedIdx === null && !timedOut) return;
    if (showReportPanel) return;
    const q = questions[currentIdx];
    if (!q) return;
    // Use the click-captured `selectedIsCorrect` flag, falling back
    // to false on timeout (no answer = wrong by definition). Do NOT
    // re-derive from `q.answers[selectedIdx]` here — `questions` is
    // in this effect's deps, and any incidental re-set of state
    // (which has happened in production) can land us with a fresh
    // shuffle whose answer ordering no longer matches the index the
    // user clicked.
    const isCorrect = selectedIsCorrect === true;
    setResults(prev => {
      // Guard against a re-fire on the same question by length check.
      if (prev.length > currentIdx) return prev;
      return [...prev, { correct: isCorrect, templateId: q.templateId }];
    });
    // Wrong / timed-out → longer pause so the user has time to
    // study the correct answer and the explanation. Right →
    // shorter pause; nothing to learn from a confirmation.
    const pauseMs = isCorrect ? REVEAL_PAUSE_CORRECT_MS : REVEAL_PAUSE_WRONG_MS;
    advanceTimeoutRef.current = window.setTimeout(() => {
      if (currentIdx >= questions.length - 1) {
        setPhase('summary');
      } else {
        setCurrentIdx(i => i + 1);
        setSelectedIdx(null);
        setSelectedIsCorrect(null);
        setTimedOut(false);
      }
    }, pauseMs);
    return () => {
      if (advanceTimeoutRef.current) {
        clearTimeout(advanceTimeoutRef.current);
        advanceTimeoutRef.current = null;
      }
    };
  }, [selectedIdx, selectedIsCorrect, timedOut, currentIdx, phase, questions, showReportPanel]);

  // ── End-of-game: persist + load leaderboard ────────────────────
  const persistAndLoadLeaderboard = useCallback(async () => {
    const gid = getGroupId();
    if (!gid || !playerName) return;
    const correct = results.filter(r => r.correct).length;
    const total = results.length;
    if (total === 0) return;
    // ── HARD GUARD: refuse to persist a "suspicious 0-score" round.
    //
    // A round of 5+ questions where the user got every single one
    // wrong is statistically near-impossible: random clicking on
    // 4-option multiple-choice gives 25% expected accuracy, so the
    // odds of 0/5 by chance are 0.75^5 ≈ 23.7%, and 0/10 are
    // 0.75^10 ≈ 5.6%. (Going zero across multiple full rounds is
    // sub-percent.) In practice every 0/10 round we've ever seen
    // on prod has been a scoring-bug artifact (stale closure on
    // the answers array, mid-round reshuffle from a parent state
    // flicker, etc.) — never a genuine player who happened to
    // miss every question.
    //
    // We've patched the most plausible mechanisms (v5.50.2 locked
    // `selectedIsCorrect` at click time; 'players' / 'group' mode
    // sourcing was rewritten in v5.52.0). But the user has had to
    // ask for a manual cleanup four times, and "patch and hope"
    // isn't an answer — so this guard short-circuits the save
    // unconditionally for the bug shape regardless of what causes
    // it. The leaderboard and personal stats stay clean, the user
    // sees a friendly notice, and the per-question diagnostic
    // (below) still gets logged so we can keep narrowing the root
    // cause without any data pollution risk.
    //
    // Trade-off: a hypothetical real player who genuinely misses
    // 5+ in a row also gets their session dropped. We're OK with
    // that — it's a rounding error and doesn't degrade the
    // experience for anyone in the wild.
    const looksLikeBug = correct === 0 && total >= 5;
    if (looksLikeBug) {
      console.warn('[trivia] rejected 0-score session (likely scoring-bug artifact, NOT saved)', {
        playerName,
        mode,
        total,
        questions: questions.map((q, i) => ({
          idx: i,
          templateId: q.templateId,
          correctAnswerText: q.answers.find(a => a.isCorrect)?.text,
          userResultCorrect: results[i]?.correct,
        })),
      });
      setSessionRejected(true);
    }
    if (!savedToDb && !looksLikeBug) {
      const { error } = await supabase.from('trivia_sessions').insert({
        group_id: gid,
        user_id: (await supabase.auth.getUser()).data.user?.id,
        player_name: playerName,
        mode,
        score: correct,
        total_questions: total,
      });
      if (error) {
        console.warn('trivia_sessions insert failed:', error.message);
      }
      setSavedToDb(true);
    }
    const { data, error } = await supabase.rpc('fetch_trivia_leaderboard', { p_group_id: gid });
    if (error) {
      console.warn('fetch_trivia_leaderboard failed:', error.message);
      setLeaderboard([]);
      return;
    }
    setLeaderboard((data ?? []) as LeaderboardRow[]);
  }, [mode, playerName, results, savedToDb]);

  useEffect(() => {
    if (phase === 'summary') void persistAndLoadLeaderboard();
  }, [phase, persistAndLoadLeaderboard]);

  // ── Handlers ───────────────────────────────────────────────────
  const handleSelect = (idx: number) => {
    if (selectedIdx !== null || timedOut) return;
    // Compute correctness AT THE MOMENT OF CLICK — using the
    // `questions[currentIdx]` snapshot from this render's closure.
    // Whatever happens to `questions` in subsequent renders cannot
    // change this stored boolean. This is the single most important
    // line in the scoring path; do not move it to an effect.
    const q = questions[currentIdx];
    const isCorrect = !!q && q.answers[idx]?.isCorrect === true;
    hapticTap();
    setSelectedIdx(idx);
    setSelectedIsCorrect(isCorrect);
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  const handleAbort = () => {
    if (results.length === 0) {
      // Bouncing back to the landing rather than home lets the user
      // tweak filters (mode / categories) and try again without an
      // extra navigation hop.
      navigate('/trivia');
      return;
    }
    setPhase('summary');
  };

  // ── Report-flow handlers ───────────────────────────────────────
  const openReportPanel = () => {
    hapticTap();
    setShowReportPanel(true);
    setReportError(null);
  };

  const cancelReportPanel = () => {
    setShowReportPanel(false);
    setReportReason(null);
    setReportComment('');
    setReportError(null);
  };

  const submitReport = async () => {
    if (!reportReason || reportSending) return;
    const q = questions[currentIdx];
    const gid = getGroupId();
    if (!q || !gid || !playerName) {
      setReportError(t('trivia.report.error'));
      return;
    }
    setReportSending(true);
    setReportError(null);
    try {
      const correctAnswer = q.answers.find(a => a.isCorrect)?.text ?? '';
      const chosenAnswer = selectedIdx !== null ? (q.answers[selectedIdx]?.text ?? null) : null;
      const { data: userData } = await supabase.auth.getUser();
      const { error } = await supabase.from('trivia_reports').insert({
        group_id: gid,
        user_id: userData.user?.id,
        player_name: playerName,
        template_id: q.templateId,
        mode,
        question_text: q.text,
        correct_answer: correctAnswer,
        chosen_answer: chosenAnswer,
        reason: reportReason,
        comment: reportComment.trim() || null,
      });
      if (error) {
        setReportError(error.message || t('trivia.report.error'));
        setReportSending(false);
        return;
      }
      // Best-effort push to all super-admins. Mirrors the training
      // pattern (notifySuperAdminsOfReports) — if it fails it just
      // logs; the report itself is already saved.
      void notifySuperAdminsOfTriviaReport({
        reporterName: playerName,
        reason: reportReason,
        questionText: q.text,
      });
      setReportedIdxs(prev => {
        const next = new Set(prev);
        next.add(currentIdx);
        return next;
      });
      setShowReportPanel(false);
      setReportReason(null);
      setReportComment('');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : t('trivia.report.error');
      setReportError(msg);
    } finally {
      setReportSending(false);
    }
  };

  // Reset every per-session piece of state and re-load a fresh
  // batch. Calling `loadBatch()` directly (instead of duplicating
  // the boot block) is the whole reason that helper exists — see
  // the comment on `loadBatch` above for why we don't want two
  // sources of truth for "how to start a round".
  const restart = () => {
    setCurrentIdx(0);
    setSelectedIdx(null);
    setSelectedIsCorrect(null);
    setTimedOut(false);
    setSecondsLeft(SECONDS_PER_QUESTION);
    setResults([]);
    setLeaderboard(null);
    setSavedToDb(false);
    setSessionRejected(false);
    setReportedIdxs(new Set());
    setShowReportPanel(false);
    setReportReason(null);
    setReportComment('');
    setReportError(null);
    setPhase('loading');
    setQuestions([]);
    loadBatch();
  };

  // Share the end-of-round score as an image (parallel to the home
  // trivia/about-you share UX). Captures the off-screen card via
  // html2canvas → File → navigator.share. Silent on rejection (user
  // cancelled the system sheet, file API unsupported, etc.) so we
  // don't pop a banner over the summary.
  const handleShareScore = async () => {
    if (isSharingScore) return;
    hapticTap();
    setIsSharingScore(true);
    try {
      // One paint to make sure the off-screen card has the latest
      // score state committed (in case the user clicked share the
      // same render cycle the leaderboard finished loading).
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (!summaryShareRef.current) return;
      const safeName = (playerName ?? 'player').replace(/[^\w\u0590-\u05FF\-_.]/g, '_');
      const files = await captureAndSplit(
        summaryShareRef.current,
        `trivia-score-${safeName}`,
        { backgroundColor: '#0f172a' },
      );
      await shareFiles(files, t('trivia.summary.shareTitle'));
    } catch {
      // Silent — html2canvas / share rejection shouldn't surface a
      // banner; user simply taps again.
    } finally {
      setIsSharingScore(false);
    }
  };

  // ── Pre-derived values for render ──────────────────────────────
  const correctCount = results.filter(r => r.correct).length;
  const totalAnswered = results.length;
  const accuracy = totalAnswered > 0 ? (correctCount / totalAnswered) * 100 : 0;
  const isRtl = language === 'he';
  // Mode label reflects the user's pick on the landing screen. We
  // reuse the `trivia.landing.mode.*` strings so the chip matches the
  // pill the user just tapped, instead of inventing parallel copy.
  const modeLabel = mode === 'group'
    ? t('trivia.mode.group')
    : mode === 'players'
      ? t('trivia.mode.players')
      : t('trivia.landing.mode.mixed').replace(/^\S+\s+/, '');
  const modeIcon = mode === 'group' ? '🌍' : mode === 'players' ? '👥' : '🎲';

  // ── Render: empty state ────────────────────────────────────────
  if (phase === 'empty') {
    return (
      <div className="fade-in" style={{
        padding: '3rem 1.5rem', textAlign: 'center', direction: isRtl ? 'rtl' : 'ltr',
      }}>
        <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🎮</div>
        <h2 style={{ marginBottom: '0.5rem' }}>{t('trivia.empty.title')}</h2>
        <p className="text-muted" style={{ marginBottom: '1.5rem', maxWidth: 380, margin: '0 auto 1.5rem' }}>
          {t('trivia.empty.body')}
        </p>
        <button className="btn btn-primary" onClick={() => navigate('/trivia')}>
          {t('trivia.action.back')}
        </button>
      </div>
    );
  }

  // ── Render: loading ────────────────────────────────────────────
  if (phase === 'loading') {
    return (
      <div className="fade-in" style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', minHeight: '60vh', gap: '1rem',
        direction: isRtl ? 'rtl' : 'ltr',
      }}>
        <div style={{ fontSize: '2.5rem', animation: 'pulse 1.5s infinite' }}>🎮</div>
        <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          {t('trivia.loading')}
        </div>
      </div>
    );
  }

  // ── Render: end-of-game summary + leaderboard ──────────────────
  if (phase === 'summary') {
    const tone = accuracy >= 70 ? 'win' : accuracy >= 40 ? 'mid' : 'lose';
    const toneColor = tone === 'win' ? '#22c55e' : tone === 'mid' ? '#3b82f6' : '#ef4444';
    const toneBg = tone === 'win'
      ? 'rgba(34, 197, 94, 0.1)'
      : tone === 'mid'
        ? 'rgba(59, 130, 246, 0.1)'
        : 'rgba(239, 68, 68, 0.1)';
    const toneEmoji = tone === 'win' ? '🏆' : tone === 'mid' ? '👍' : '💪';

    // Canonical "me row" highlight — same constants the
    // StatisticsScreen and TriviaLandingScreen tables use, so every
    // player table in the app reads identically.
    const meRowStyle = {
      background: 'rgba(59, 130, 246, 0.14)',
      borderRight: '3px solid #3b82f6',
    } as const;
    const meNameStyle = { color: '#60a5fa' } as const;

    return (
      // Compact summary layout — the previous version (3rem hero
      // emoji + 1.4rem score card padding + standalone per-question
      // dots card + grid-based leaderboard) was running ~745 px tall
      // and pushing the action buttons below the fold even on
      // average phones. The redesigned stack:
      //   1. Hero band: emoji + mode chip + score badge in ONE
      //      centered row — was 3 stacked elements taking ~120 px.
      //   2. The dedicated "per-question" card is gone; the dots
      //      now sit inline below the hero, since the only content
      //      it had was the dots row anyway.
      //   3. The leaderboard is a real <table> (matches the landing
      //      screen leaderboard we just refactored — same colors,
      //      same `borderInlineStart` "me" highlight).
      //   4. Action buttons sit immediately under the leaderboard
      //      with 0.5rem padding-bottom so the bottom nav bar
      //      doesn't overlap them.
      <div className="fade-in" style={{
        padding: '0.5rem 1rem 5rem', direction: isRtl ? 'rtl' : 'ltr',
      }}>
        {/* Hero — emoji + mode chip + title in one tight stack */}
        <div style={{ textAlign: 'center', marginBottom: '0.5rem' }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
            justifyContent: 'center',
          }}>
            <span style={{ fontSize: '1.6rem' }}>{toneEmoji}</span>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
              padding: '0.2rem 0.6rem', borderRadius: 999,
              background: 'rgba(99, 102, 241, 0.12)', color: '#a78bfa',
              fontSize: '0.7rem', fontWeight: 700,
            }}>
              <span>{modeIcon}</span>
              <span>{modeLabel}</span>
            </span>
          </div>
          <h2 style={{
            margin: '0.25rem 0 0', fontSize: '1.05rem', fontWeight: 700,
          }}>
            {t('trivia.summary.title')}
          </h2>
        </div>

        {/* Score card — score on the left, per-question dots on the
            right. Combines two cards into one and removes ~70 px of
            stacked padding. */}
        <div className="card" style={{
          padding: '0.7rem 0.85rem',
          background: toneBg,
          border: `1px solid ${toneColor}33`,
          display: 'flex', alignItems: 'center',
          gap: '0.75rem', justifyContent: 'space-between',
        }}>
          <div style={{ textAlign: isRtl ? 'right' : 'left', flexShrink: 0 }}>
            <div style={{ fontSize: '1.6rem', fontWeight: 900, color: toneColor, lineHeight: 1 }}>
              {correctCount}/{totalAnswered}
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', marginTop: '0.15rem' }}>
              {t('trivia.summary.accuracy', { pct: accuracy.toFixed(0) })}
            </div>
          </div>
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: '0.25rem',
            justifyContent: isRtl ? 'flex-start' : 'flex-end', flex: 1,
          }}>
            {results.map((r, i) => (
              <div key={i} style={{
                width: 18, height: 18, borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '0.6rem', fontWeight: 800,
                background: r.correct ? 'rgba(34, 197, 94, 0.18)' : 'rgba(239, 68, 68, 0.18)',
                color: r.correct ? '#22c55e' : '#ef4444',
              }}>{r.correct ? '✓' : '✗'}</div>
            ))}
          </div>
        </div>

        {/* Friendly notice when persistAndLoadLeaderboard rejected
            this session (0 correct / ≥5 questions). The user sees
            their actual score above for transparency, but we make
            it explicit that the leaderboard wasn't updated so they
            don't keep wondering why their result didn't show up. */}
        {sessionRejected && (
          <div className="card" style={{
            marginTop: '0.5rem',
            padding: '0.6rem 0.75rem',
            background: 'rgba(234, 179, 8, 0.08)',
            border: '1px solid rgba(234, 179, 8, 0.3)',
            fontSize: '0.75rem',
            color: 'var(--text)',
            lineHeight: 1.45,
          }}>
            {t('trivia.summary.notSavedNotice')}
          </div>
        )}

        {/* Leaderboard — same canonical app-table pattern as
            StatisticsScreen / TriviaLandingScreen. Centered title,
            optional subtitle line beneath, table at 0.7rem with
            RTL-aware textAlign on rank+player columns, podium
            medal suffix on rows 1-3, "me row" via meRowStyle. */}
        <div className="card" style={{ padding: '0.5rem', marginTop: '0.5rem' }}>
          <div style={{
            textAlign: 'center', fontSize: '0.85rem', fontWeight: 600,
            color: 'var(--text)', marginBottom: '0.3rem',
          }}>
            {t('trivia.leaderboard.title')}
          </div>
          <div style={{
            textAlign: 'center', fontSize: '0.65rem',
            color: 'var(--text-muted)', marginBottom: '0.35rem',
          }}>
            {t('trivia.leaderboard.subtitle')}
          </div>
          {leaderboard === null ? (
            <div style={{ textAlign: 'center', padding: '0.5rem', color: 'var(--text-muted)', fontSize: '0.7rem' }}>
              {t('trivia.leaderboard.loading')}
            </div>
          ) : leaderboard.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '0.5rem', color: 'var(--text-muted)', fontSize: '0.7rem' }}>
              {t('trivia.leaderboard.empty')}
            </div>
          ) : (
            <table style={{ width: '100%', fontSize: '0.7rem', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th style={{ textAlign: isRtl ? 'right' : 'left', padding: '0.25rem 0.2rem' }}>#</th>
                  <th style={{ textAlign: isRtl ? 'right' : 'left', padding: '0.25rem 0.2rem' }}>
                    {t('trivia.leaderboard.col.player')}
                  </th>
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
                {leaderboard.slice(0, 12).map((row, i) => {
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
              </tbody>
            </table>
          )}
        </div>

        {/* Action row: home + restart + share-score. The share
            button is the same 📤 emoji used everywhere else in the
            app (poll cards, game summary, graphs, home trivia
            cards) so the affordance reads identically. It sits at
            the trailing edge so the two primary actions (home /
            restart) keep their visual weight. */}
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.6rem' }}>
          {/* "Back" goes to the trivia landing screen, not the
              app home — after a round the user almost always wants
              to either replay or pick a different mode/length, both
              of which live on /trivia. Sending them to / would make
              them tap an extra time to get back here. */}
          <button className="btn btn-primary" style={{ flex: 1, padding: '0.55rem', fontSize: '0.85rem' }} onClick={() => navigate('/trivia')}>
            {t('trivia.action.home')}
          </button>
          <button className="btn btn-secondary" style={{ flex: 1, padding: '0.55rem', fontSize: '0.85rem' }} onClick={restart}>
            {t('trivia.action.again')}
          </button>
          <button
            className="btn btn-secondary"
            onClick={handleShareScore}
            disabled={isSharingScore}
            title={t('trivia.summary.shareLabel')}
            aria-label={t('trivia.summary.shareLabel')}
            style={{
              flex: '0 0 auto',
              padding: '0.55rem 0.75rem',
              fontSize: '1rem',
              opacity: isSharingScore ? 0.55 : 1,
              cursor: isSharingScore ? 'not-allowed' : 'pointer',
            }}
          >
            📤
          </button>
        </div>

        {/* Off-screen share card — html2canvas-rasterised when the
            user taps 📤. Positioned absolutely off the viewport so
            it doesn't affect layout or appear in the user's screen,
            but it IS in the DOM (display:none would break
            html2canvas which needs computed sizes). 360px wide ≈
            phone share preview width; the card is intentionally
            sparse so the rendered PNG is a clean shareable artifact
            (mode chip, score, dots, tagline, app name) — no
            navigation chrome, no buttons. */}
        <div style={{
          position: 'fixed', left: -10000, top: 0, pointerEvents: 'none',
          width: 360, padding: '1.5rem 1.25rem',
          background: 'linear-gradient(180deg, #0f172a 0%, #1e293b 100%)',
          borderRadius: 16, color: '#f1f5f9',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          direction: isRtl ? 'rtl' : 'ltr', textAlign: 'center',
        }}>
          <div ref={summaryShareRef}>
            <div style={{ fontSize: '2.4rem', marginBottom: '0.4rem', lineHeight: 1 }}>
              {toneEmoji}
            </div>
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
              padding: '0.25rem 0.75rem', borderRadius: 999,
              background: 'rgba(99, 102, 241, 0.18)', color: '#c7d2fe',
              fontSize: '0.75rem', fontWeight: 700, marginBottom: '0.7rem',
            }}>
              <span>{modeIcon}</span><span>{modeLabel}</span>
            </div>
            <div style={{
              fontSize: '3.2rem', fontWeight: 900, color: toneColor,
              lineHeight: 1, marginBottom: '0.2rem',
            }}>
              {correctCount}/{totalAnswered}
            </div>
            <div style={{
              fontSize: '0.85rem', color: '#cbd5e1', marginBottom: '0.85rem',
              fontWeight: 600,
            }}>
              {t('trivia.summary.accuracy', { pct: accuracy.toFixed(0) })}
            </div>
            <div style={{
              display: 'flex', flexWrap: 'wrap', gap: '0.3rem',
              justifyContent: 'center', marginBottom: '0.85rem',
            }}>
              {results.map((r, i) => (
                <div key={i} style={{
                  width: 22, height: 22, borderRadius: '50%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '0.7rem', fontWeight: 800,
                  background: r.correct ? 'rgba(34, 197, 94, 0.25)' : 'rgba(239, 68, 68, 0.22)',
                  color: r.correct ? '#22c55e' : '#ef4444',
                }}>{r.correct ? '✓' : '✗'}</div>
              ))}
            </div>
            <div style={{
              fontSize: '0.85rem', color: '#f1f5f9', fontWeight: 700,
              marginBottom: '0.25rem',
            }}>
              {playerName ?? '—'}
            </div>
            <div style={{
              fontSize: '0.7rem', color: '#94a3b8', lineHeight: 1.5,
              marginTop: '0.6rem', borderTop: '1px solid rgba(148,163,184,0.15)',
              paddingTop: '0.6rem',
            }}>
              {t('trivia.summary.shareTagline')}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Render: a question ─────────────────────────────────────────
  const q = questions[currentIdx];
  if (!q) return null;
  const isRevealed = selectedIdx !== null || timedOut;
  const correctIdx = q.answers.findIndex(a => a.isCorrect);
  const progress = ((currentIdx + (isRevealed ? 1 : 0)) / questions.length) * 100;
  // Timer color shifts to red as it runs out — visual urgency cue.
  const timerColor = secondsLeft <= 3 ? '#ef4444' : secondsLeft <= 7 ? '#f59e0b' : '#22c55e';

  return (
    <div className="fade-in" style={{
      padding: '0.75rem', paddingBottom: '0.6rem',
      direction: isRtl ? 'rtl' : 'ltr',
    }}>
      {/* Tight bottom padding (was 2rem) so the reveal card —
          including the inline 🚩 report pill on its header row —
          stays visible without scrolling on short viewports
          (iPhone SE / small Android frames around 565 px main
          content height). The user explicitly asked for the whole
          question + answers + reveal + report to fit in one screen. */}
      {/* Top bar */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: '0.5rem',
      }}>
        <button
          onClick={handleAbort}
          style={{
            background: 'none', border: 'none', color: 'var(--text-muted)',
            fontSize: '0.85rem', cursor: 'pointer', fontWeight: 600,
          }}
        >
          {isRtl ? '← ' : '→ '}{results.length > 0 ? t('trivia.action.finish') : t('trivia.action.back')}
        </button>
        <div style={{
          display: 'flex', alignItems: 'center', gap: '0.5rem',
          fontSize: '0.8rem', fontWeight: 700, color: 'var(--primary)',
        }}>
          <span>{modeIcon} {modeLabel}</span>
          <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>·</span>
          <span>{currentIdx + 1}/{questions.length}</span>
        </div>
      </div>

      {/* Progress bar */}
      <div style={{
        height: 4, background: 'var(--border)', borderRadius: 2,
        overflow: 'hidden', marginBottom: '0.65rem',
      }}>
        <div style={{
          height: '100%', width: `${progress}%`,
          background: 'var(--primary)', borderRadius: 2,
          transition: 'width 0.3s ease',
        }} />
      </div>

      {/* Score dots — tightened from 10×10 with 0.3rem gap to
          8×8 with 0.25rem gap and a smaller bottom margin so the
          reveal banner clears the fold on short viewports. */}
      <div style={{
        display: 'flex', gap: '0.25rem', justifyContent: 'center',
        marginBottom: '0.45rem',
      }}>
        {results.map((r, i) => (
          <div key={i} style={{
            width: 8, height: 8, borderRadius: '50%',
            background: r.correct ? '#22c55e' : '#ef4444', opacity: 0.8,
          }} />
        ))}
        {Array.from({ length: Math.max(0, questions.length - results.length) }).map((_, i) => (
          <div key={`e-${i}`} style={{
            width: 8, height: 8, borderRadius: '50%',
            background: 'var(--border)',
          }} />
        ))}
      </div>

      {/* Timer ring — sized down a touch (56→48 px) so the
          question + 2×2 answer grid + reveal banner fit on a
          single mobile screen (iPhone SE, 667 px tall) without
          scrolling. The conic-gradient ring still reads clearly
          at 48 px and the saved vertical space adds up across
          the whole stack. */}
      <div style={{
        display: 'flex', justifyContent: 'center', alignItems: 'center',
        marginBottom: '0.55rem',
      }}>
        <div style={{
          width: 48, height: 48, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `conic-gradient(${timerColor} ${(secondsLeft / SECONDS_PER_QUESTION) * 360}deg, var(--border) 0deg)`,
          transition: 'background 0.5s linear',
          position: 'relative',
        }}>
          <div style={{
            width: 40, height: 40, borderRadius: '50%',
            background: 'var(--surface)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 800, fontSize: '1rem', color: timerColor,
          }}>
            {secondsLeft}
          </div>
        </div>
      </div>

      {/* Question card — icon inline with the text, plus a 🚩
          report pill in the trailing corner. The pill is visible
          DURING the question (before the user picks an answer)
          per the user's explicit ask: "I should have option to
          report a question before answering". Tapping it pauses
          the timer (the per-question countdown effect bails when
          `showReportPanel` is true) so the user has time to write
          a report without losing the clock. The same panel handles
          both pre-answer and post-answer reports — `submitReport`
          just records the question id, no need to know which phase
          we were in. */}
      <div className="card" style={{
        padding: '0.6rem 0.85rem',
        marginBottom: 0,
        borderRight: isRtl ? '3px solid var(--primary)' : 'none',
        borderLeft: isRtl ? 'none' : '3px solid var(--primary)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: '0.5rem',
        }}>
          <p style={{
            fontSize: '0.95rem', fontWeight: 600, lineHeight: 1.35,
            color: 'var(--text)', margin: 0, flex: 1, minWidth: 0,
            display: 'flex', alignItems: 'baseline', gap: '0.45rem',
          }}>
            {q.icon && (
              <span style={{ fontSize: '1.1rem', flexShrink: 0 }}>{q.icon}</span>
            )}
            <span>{q.text}</span>
          </p>
          {!reportedIdxs.has(currentIdx) && !showReportPanel && (
            <button
              onClick={openReportPanel}
              title={t('trivia.report.flag')}
              aria-label={t('trivia.report.flag')}
              style={{
                background: 'rgba(239,68,68,0.06)',
                border: '1px solid rgba(239,68,68,0.2)',
                borderRadius: 6, cursor: 'pointer',
                fontSize: '0.7rem', color: '#ef4444',
                padding: '0.15rem 0.4rem', fontWeight: 600,
                whiteSpace: 'nowrap', flexShrink: 0,
                lineHeight: 1.2,
              }}
            >
              {/* Render the full localized label (flag + "דווח
                  בעיה") inline. Players didn't recognise the bare
                  🚩 as a "report a problem" affordance — the
                  explicit text was added 2026-05-10 per user
                  feedback. The translation string carries the
                  emoji + text so both are RTL-safe (Hebrew puts
                  the emoji on the visual right where the eye
                  expects an action affordance to start). */}
              {t('trivia.report.flag')}
            </button>
          )}
          {reportedIdxs.has(currentIdx) && (
            <span style={{
              fontSize: '0.7rem', color: '#22c55e', fontWeight: 700,
              whiteSpace: 'nowrap', flexShrink: 0, lineHeight: 1.2,
            }}>
              ✓
            </span>
          )}
        </div>
      </div>

      {/* Answers — 2×2 grid (was a vertical stack of 4). Two
          benefits:
          • Saves ~110 px of vertical space, which is what makes
            the question + answers + reveal banner all fit on one
            mobile screen as the user requested.
          • Halves the user's eye travel between options on phones
            — answers now sit side by side, not in a long scroll.
          `min-height` keeps cards visually equal even when one
          answer wraps to two lines. RTL note: in an RTL parent
          the grid flow goes right-to-left, so answer[0] sits in
          the top-right (natural Hebrew reading order). */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(2, 1fr)',
        gap: '0.4rem',
        marginTop: '0.45rem',
      }}>
        {q.answers.map((a, idx) => {
          const isSelected = selectedIdx === idx;
          const isCorrect = idx === correctIdx;
          let borderColor = 'var(--border)';
          let bgColor = 'var(--surface)';
          let textColor = 'var(--text)';
          if (isRevealed) {
            if (isCorrect) {
              borderColor = '#22c55e';
              bgColor = 'rgba(34, 197, 94, 0.1)';
              textColor = '#22c55e';
            } else if (isSelected) {
              borderColor = '#ef4444';
              bgColor = 'rgba(239, 68, 68, 0.1)';
              textColor = '#ef4444';
            } else {
              textColor = 'var(--text-muted)';
            }
          }
          return (
            <button
              key={idx}
              onClick={() => handleSelect(idx)}
              disabled={isRevealed}
              style={{
                padding: '0.55rem 0.55rem', borderRadius: 10,
                border: `2px solid ${borderColor}`, background: bgColor,
                color: textColor, fontWeight: 600, fontSize: '0.9rem',
                cursor: isRevealed ? 'default' : 'pointer',
                textAlign: 'center',
                lineHeight: 1.25,
                minHeight: 44,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'all 0.2s ease',
                opacity: isRevealed && !isCorrect && !isSelected ? 0.55 : 1,
                wordBreak: 'break-word',
              }}
            >
              {a.text}
            </button>
          );
        })}
      </div>

      {/* Reveal banner — shown only after the user picks an
          answer (or the timer runs out). The 🚩 report flow lives
          OUTSIDE this banner now (in the question card header
          above) so users can also report a question BEFORE
          answering, per the user's request. */}
      {isRevealed && (() => {
        const isWin = !timedOut && selectedIdx !== null && q.answers[selectedIdx].isCorrect;
        const bannerBg = timedOut || !isWin ? 'rgba(239, 68, 68, 0.08)' : 'rgba(34, 197, 94, 0.1)';
        const bannerBorder = timedOut || !isWin ? 'rgba(239, 68, 68, 0.25)' : 'rgba(34, 197, 94, 0.3)';
        const bannerColor = timedOut || !isWin ? '#ef4444' : '#22c55e';
        return (
          <div className="card" style={{
            marginTop: '0.5rem', marginBottom: 0,
            padding: '0.55rem 0.75rem',
            background: bannerBg, border: `1px solid ${bannerBorder}`,
          }}>
            <div style={{
              fontSize: '0.85rem', fontWeight: 700,
              marginBottom: q.explanation ? '0.2rem' : 0, color: bannerColor,
            }}>
              {timedOut
                ? `⏰ ${t('trivia.reveal.timeout')}`
                : (isWin ? `✓ ${t('trivia.reveal.correct')}` : `✗ ${t('trivia.reveal.wrong')}`)}
            </div>
            {q.explanation && (
              <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', lineHeight: 1.35 }}>
                {q.explanation}
              </div>
            )}
          </div>
        );
      })()}

      {/* Report panel — rendered as its own sibling block so it
          works in BOTH phases:
          • Pre-answer: opened via the 🚩 in the question card.
            The countdown timer is paused while open (see the
            per-question timer effect — it skips when
            `showReportPanel` is true).
          • Post-answer: opened the same way; the auto-advance
            timeout is also gated on `showReportPanel`, so the
            user gets unlimited time to write the report.
          Cancelling resumes the timer where it left off; sending
          marks the question as reported (`reportedIdxs`) and the
          🚩 above swaps to a small ✓ thanks badge. */}
      {showReportPanel && (
        <div className="card" style={{
          marginTop: '0.5rem', marginBottom: 0,
          padding: '0.75rem',
          background: 'rgba(239,68,68,0.06)',
          border: '1px solid rgba(239,68,68,0.2)',
        }}>
          <div style={{
            fontSize: '0.8rem', fontWeight: 700,
            textAlign: 'center', marginBottom: '0.4rem',
          }}>
            {t('trivia.report.title')}
          </div>
          <div style={{
            fontSize: '0.7rem', color: 'var(--text-muted)',
            textAlign: 'center', marginBottom: '0.55rem',
          }}>
            {t('trivia.report.subtitle')}
          </div>
          <div style={{
            display: 'flex', flexDirection: 'column',
            gap: '0.35rem', marginBottom: '0.55rem',
          }}>
            {([
              ['wrong_answer', t('trivia.report.reason.wrongAnswer')],
              ['unclear_question', t('trivia.report.reason.unclear')],
              ['other', t('trivia.report.reason.other')],
            ] as [ReportReason, string][]).map(([val, label]) => {
              const active = reportReason === val;
              return (
                <button
                  key={val}
                  onClick={() => setReportReason(val)}
                  style={{
                    padding: '0.5rem 0.6rem', borderRadius: 8,
                    cursor: 'pointer', fontSize: '0.75rem',
                    textAlign: isRtl ? 'right' : 'left',
                    background: active ? 'rgba(239,68,68,0.2)' : 'var(--surface)',
                    border: active ? '1px solid #ef4444' : '1px solid var(--border)',
                    color: active ? '#ef4444' : 'var(--text)',
                    fontWeight: active ? 700 : 500,
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <textarea
            value={reportComment}
            onChange={e => setReportComment(e.target.value)}
            placeholder={t('trivia.report.placeholder')}
            rows={2}
            style={{
              width: '100%', padding: '0.5rem',
              borderRadius: 8, fontSize: '0.75rem',
              background: 'var(--surface)', color: 'var(--text)',
              border: '1px solid var(--border)',
              resize: 'vertical', direction: isRtl ? 'rtl' : 'ltr',
              fontFamily: 'inherit', boxSizing: 'border-box',
            }}
          />
          {reportError && (
            <div style={{
              marginTop: '0.4rem', fontSize: '0.7rem',
              color: '#ef4444', textAlign: 'center',
            }}>
              {reportError}
            </div>
          )}
          <div style={{
            display: 'flex', gap: '0.5rem',
            justifyContent: 'center', marginTop: '0.55rem',
          }}>
            <button
              onClick={submitReport}
              disabled={!reportReason || reportSending}
              style={{
                background: reportReason ? '#ef4444' : '#555',
                color: 'white', border: 'none',
                padding: '0.45rem 1.2rem', borderRadius: 8,
                cursor: reportReason && !reportSending ? 'pointer' : 'not-allowed',
                fontSize: '0.8rem', fontWeight: 700,
                opacity: reportReason && !reportSending ? 1 : 0.55,
              }}
            >
              {reportSending ? t('trivia.report.sending') : t('trivia.report.send')}
            </button>
            <button
              onClick={cancelReportPanel}
              disabled={reportSending}
              style={{
                background: 'var(--surface)', color: 'var(--text-muted)',
                border: '1px solid var(--border)',
                padding: '0.45rem 1.2rem', borderRadius: 8,
                cursor: reportSending ? 'not-allowed' : 'pointer',
                fontSize: '0.8rem',
              }}
            >
              {t('trivia.report.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default TriviaGameScreen;
