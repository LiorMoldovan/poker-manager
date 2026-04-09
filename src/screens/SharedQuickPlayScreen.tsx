import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { captureAndSplit, shareFiles } from '../utils/sharing';
import { usePermissions } from '../App';
import {
  PoolScenario,
  TrainingSession,
  TrainingAnswerResult,
  TrainingFlagReport,
  FlagReason,
} from '../types';
import {
  TrainingAnswersFile,
} from '../types';
import {
  SCENARIO_CATEGORIES,
  loadFromPool,
  getSharedProgress,
  saveSharedProgress,
  updateStreak,
  checkNewBadges,
  bufferSessionForUpload,
  flushPendingUploads,
  TRAINING_BADGES,
  WRONG_ANSWER_REACTIONS,
  CORRECT_ANSWER_REACTIONS,
  generatePlayerCoaching,
} from '../utils/pokerTraining';
import { getGeminiApiKey } from '../utils/geminiAI';
import { fetchTrainingAnswers, fetchTrainingInsights, uploadTrainingInsights } from '../database/githubSync';

const fixCardBidi = (text: string): string =>
  text.replace(/([AKQJ]|10|[2-9])(♠|♥|♦|♣)/g, '\u200E$1$2\u200E');

const ColoredCards = ({ text }: { text: string }) => {
  const parts = text.split(/(\S+)/g);
  return (
    <span style={{ direction: 'ltr', unicodeBidi: 'isolate' }}>
      {parts.map((part, i) => {
        const hasRed = part.includes('\u2665') || part.includes('\u2666');
        const hasSuit = hasRed || part.includes('\u2660') || part.includes('\u2663');
        if (!hasSuit) return <span key={i}>{part}</span>;
        return (
          <span key={i} style={{ color: hasRed ? '#ef4444' : '#e2e8f0', fontWeight: 700 }}>
            {part}
          </span>
        );
      })}
    </span>
  );
};

const ColoredText = ({ text }: { text: string }) => {
  const cardPattern = /(\u200E?(?:[AKQJ]|10|[2-9])[♠♥♦♣]\u200E?)/g;
  const fixed = fixCardBidi(text);
  const parts = fixed.split(cardPattern);
  return (
    <>
      {parts.map((part, i) => {
        const hasRed = part.includes('♥') || part.includes('♦');
        const hasSuit = hasRed || part.includes('♠') || part.includes('♣');
        if (!hasSuit) return <span key={i}>{part}</span>;
        return (
          <span key={i} style={{ color: hasRed ? '#ef4444' : '#e2e8f0', fontWeight: 700, direction: 'ltr', unicodeBidi: 'isolate' as const }}>
            {part}
          </span>
        );
      })}
    </>
  );
};

const SharedQuickPlayScreen = () => {
  const navigate = useNavigate();
  const { playerName } = usePermissions();
  const [searchParams] = useSearchParams();
  const categoriesParam = searchParams.get('categories') || '';
  const rawCount = searchParams.get('count');
  const sessionLength = rawCount ? (parseInt(rawCount, 10) || null) : null;

  const [scenarios, setScenarios] = useState<PoolScenario[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<TrainingAnswerResult[]>([]);
  const [showSummary, setShowSummary] = useState(false);
  const [newBadgeIds, setNewBadgeIds] = useState<string[]>([]);
  const [exhaustedMsg, setExhaustedMsg] = useState<string | null>(null);
  const [flaggedThisSession, setFlaggedThisSession] = useState<Set<string>>(new Set());
  const [flagReportsThisSession, setFlagReportsThisSession] = useState<TrainingFlagReport[]>([]);
  const [showFlagConfirm, setShowFlagConfirm] = useState(false);
  const [flagReason, setFlagReason] = useState<FlagReason | null>(null);
  const [flagComment, setFlagComment] = useState('');
  const [isSharing, setIsSharing] = useState(false);
  const [showStyleTip, setShowStyleTip] = useState(true);
  const [skippedAfterReport, setSkippedAfterReport] = useState(false);
  const [allPlayerAnswers, setAllPlayerAnswers] = useState<TrainingAnswersFile | null>(null);
  const [reportMilestoneMsg, setReportMilestoneMsg] = useState<string | null>(null);
  const [generatingReport, setGeneratingReport] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<TrainingAnswerResult[]>([]);
  const flaggedRef = useRef<Set<string>>(new Set());
  const flagReportsRef = useRef<TrainingFlagReport[]>([]);
  const sessionConcludedRef = useRef(false);

  const name = playerName || 'Unknown';

  const loadScenarios = useCallback(async () => {
    setLoading(true);
    setError(null);
    setExhaustedMsg(null);
    try {
      const catIds = categoriesParam ? categoriesParam.split(',').filter(Boolean) : undefined;
      const { scenarios: loaded, exhaustedCategory, exhaustedAll } = await loadFromPool(name, sessionLength, catIds);

      if (loaded.length === 0) {
        setError('אין שאלות זמינות כרגע');
        return;
      }

      if (exhaustedAll) setExhaustedMsg('סיבוב חדש! השאלות יחזרו בסדר אקראי');
      else if (exhaustedCategory) setExhaustedMsg('סיימת את כל השאלות בקטגוריה הזו! פנה לליאור להרחבת המאגר');

      setScenarios(loaded);
      setCurrentIdx(0);
      setResults([]);
      resultsRef.current = [];
      flaggedRef.current = new Set();
      sessionConcludedRef.current = false;
      setSelectedOption(null);
      setShowSummary(false);
      setNewBadgeIds([]);
      setFlaggedThisSession(new Set());
      setFlagReportsThisSession([]);
      flagReportsRef.current = [];
    } catch {
      setError('שגיאה בטעינת שאלות');
    } finally {
      setLoading(false);
    }
  }, [categoriesParam, sessionLength, name]);

  useEffect(() => {
    loadScenarios();
    fetchTrainingAnswers().then(data => { if (data) setAllPlayerAnswers(data); }).catch(() => {});
  }, [loadScenarios]);

  // Save partial session on unmount (user navigated away mid-session)
  useEffect(() => {
    return () => {
      if (!sessionConcludedRef.current && resultsRef.current.length > 0) {
        const r = resultsRef.current;
        const f = flaggedRef.current;
        const fr = flagReportsRef.current;
        const correctCount = r.filter(x => x.correct).length;
        const nearMissCount = r.filter(x => x.nearMiss).length;
        const total = r.length - nearMissCount;

        const progress = getSharedProgress(name);
        progress.sessionsCompleted++;
        updateStreak(progress);
        const badges = checkNewBadges(progress);
        if (badges.length > 0) progress.earnedBadgeIds = [...progress.earnedBadgeIds, ...badges];
        saveSharedProgress(name, progress);

        const session: TrainingSession = {
          date: new Date().toISOString(),
          questionsAnswered: total,
          correctAnswers: correctCount,
          results: r,
          flaggedPoolIds: Array.from(f),
          flagReports: fr.length > 0 ? fr : undefined,
        };
        bufferSessionForUpload(name, session);
        flushPendingUploads(true);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Flush pending uploads on visibility change
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'hidden') {
        flushPendingUploads(true);
      }
    };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  const handleSelect = (optionId: string) => {
    if (selectedOption) return;
    setSelectedOption(optionId);

    const scenario = scenarios[currentIdx];
    const chosen = scenario.options.find(o => o.id === optionId);
    const isCorrect = chosen?.isCorrect || false;
    const isNearMiss = !isCorrect && !!chosen?.nearMiss;

    const result: TrainingAnswerResult = {
      poolId: scenario.poolId,
      categoryId: scenario.categoryId,
      correct: isCorrect,
      nearMiss: isNearMiss || undefined,
      chosenId: optionId,
    };
    setResults(prev => {
      const updated = [...prev, result];
      resultsRef.current = updated;
      return updated;
    });

    const progress = getSharedProgress(name);
    if (isNearMiss) {
      progress.totalNeutral = (progress.totalNeutral || 0) + 1;
    } else {
      progress.totalQuestions++;
      if (!progress.byCategory[scenario.categoryId]) {
        progress.byCategory[scenario.categoryId] = { total: 0, correct: 0 };
      }
      progress.byCategory[scenario.categoryId].total++;
      if (isCorrect) {
        progress.totalCorrect++;
        progress.currentCorrectRun++;
        progress.longestCorrectRun = Math.max(progress.longestCorrectRun, progress.currentCorrectRun);
        progress.byCategory[scenario.categoryId].correct++;
      } else {
        progress.currentCorrectRun = 0;
      }
    }

    if (!progress.seenPoolIds.includes(scenario.poolId)) {
      progress.seenPoolIds.push(scenario.poolId);
    }

    saveSharedProgress(name, progress);
  };

  const handleNext = () => {
    if (currentIdx >= scenarios.length - 1) {
      concludeSession();
      return;
    }
    setCurrentIdx(prev => prev + 1);
    setSelectedOption(null);
  };

  const concludeSession = (resultsToUse?: TrainingAnswerResult[], flaggedToUse?: Set<string>) => {
    const finalResults = resultsToUse || results;
    const finalFlagged = flaggedToUse || flaggedThisSession;
    const finalReports = flagReportsThisSession;
    const correctCount = finalResults.filter(r => r.correct).length;
    const nearMissCount = finalResults.filter(r => r.nearMiss).length;
    const scoredTotal = finalResults.length - nearMissCount;
    const total = scoredTotal;
    if (total === 0 && nearMissCount === 0) {
      if (!resultsToUse) navigate('/shared-training');
      return;
    }

    sessionConcludedRef.current = true;

    const progress = getSharedProgress(name);
    progress.sessionsCompleted++;
    updateStreak(progress);

    const badges = checkNewBadges(progress);
    if (badges.length > 0) {
      progress.earnedBadgeIds = [...progress.earnedBadgeIds, ...badges];
      if (!resultsToUse) setNewBadgeIds(badges);
    }

    saveSharedProgress(name, progress);

    const session: TrainingSession = {
      date: new Date().toISOString(),
      questionsAnswered: total,
      correctAnswers: correctCount,
      results: finalResults,
      flaggedPoolIds: Array.from(finalFlagged),
      flagReports: finalReports.length > 0 ? finalReports : undefined,
    };
    // Determine milestone BEFORE uploading, so we can bundle the pending flag with the session upload
    const currentTotal = progress.totalQuestions + (progress.totalNeutral || 0);
    const sessionTotal = finalResults.length;
    const prevTotal = currentTotal - sessionTotal;
    const currentMilestone = Math.floor(currentTotal / 100);
    const prevMilestone = Math.floor(prevTotal / 100);
    const crossedMilestone = currentMilestone > prevMilestone && currentMilestone > 0
      ? currentMilestone * 100
      : null;

    bufferSessionForUpload(name, session, crossedMilestone || undefined);
    flushPendingUploads();

    if (!resultsToUse) {
      setShowSummary(true);

      if (crossedMilestone) {
        const milestoneNum = crossedMilestone;
        const hasApiKey = !!getGeminiApiKey();

        if (hasApiKey) {
          setGeneratingReport(true);
          setReportMilestoneMsg(`🎯 ${milestoneNum} שאלות! מייצר תובנות אישיות...`);
          fetchTrainingAnswers().then(async (answersData) => {
            if (!answersData) return;
            const playerData = answersData.players.find(p => p.playerName === name);
            if (!playerData) return;
            const coachingText = await generatePlayerCoaching(name, playerData, answersData.players);
            if (coachingText) {
              const currentInsights = await fetchTrainingInsights() || { lastUpdated: '', insights: {} };
              currentInsights.insights[name] = {
                generatedAt: new Date().toISOString(),
                sessionsAtGeneration: playerData.sessions.length,
                improvement: coachingText,
              };
              currentInsights.lastUpdated = new Date().toISOString();
              await uploadTrainingInsights(currentInsights);
              setReportMilestoneMsg(coachingText);
            }
          }).catch((err) => console.warn('Milestone coaching generation failed:', err)).finally(() => setGeneratingReport(false));
        } else {
          setReportMilestoneMsg(`🎯 ${milestoneNum} שאלות! התובנות שלך ייוצרו בקרוב`);
        }
      }
    }
  };

  const handleFlag = () => {
    if (!flagReason) return;
    const scenario = scenarios[currentIdx];

    setFlaggedThisSession(prev => {
      const updated = new Set(prev).add(scenario.poolId);
      flaggedRef.current = updated;
      return updated;
    });

    const report: TrainingFlagReport = {
      poolId: scenario.poolId,
      playerName: name,
      reason: flagReason,
      comment: flagComment.trim() || undefined,
      date: new Date().toISOString(),
    };
    setFlagReportsThisSession(prev => {
      const updated = [...prev, report];
      flagReportsRef.current = updated;
      return updated;
    });

    const progress = getSharedProgress(name);
    if (!progress.flaggedPoolIds.includes(scenario.poolId)) {
      progress.flaggedPoolIds.push(scenario.poolId);
    }
    const badges = checkNewBadges(progress);
    if (badges.length > 0) progress.earnedBadgeIds = [...progress.earnedBadgeIds, ...badges];
    saveSharedProgress(name, progress);

    setShowFlagConfirm(false);
    setFlagReason(null);
    setFlagComment('');
    setSkippedAfterReport(false);
  };

  const handleSkipAfterReport = () => {
    setShowFlagConfirm(false);
    setFlagReason(null);
    setFlagComment('');
    setSkippedAfterReport(false);
    if (currentIdx >= scenarios.length - 1) {
      concludeSession();
    } else {
      setCurrentIdx(prev => prev + 1);
      setSelectedOption(null);
    }
  };

  const handleShare = async () => {
    if (!summaryRef.current) return;
    setIsSharing(true);
    try {
      const files = await captureAndSplit(summaryRef.current, 'poker-training-result');
      await shareFiles(files, 'Poker Training Result');
    } catch { /* */ }
    finally { setIsSharing(false); }
  };

  if (loading) {
    return (
      <div className="fade-in" style={{
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        minHeight: '70vh', gap: '1.5rem', padding: '2rem',
      }}>
        <div style={{ fontSize: '2.5rem', animation: 'pulse 1.5s infinite' }}>🎯</div>
        <div style={{ textAlign: 'center', direction: 'rtl' }}>
          <div style={{ fontWeight: 700, fontSize: '1.1rem', marginBottom: '0.3rem' }}>טוען שאלות...</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="fade-in" style={{ textAlign: 'center', padding: '3rem', direction: 'rtl' }}>
        <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>😕</div>
        <h2 style={{ marginBottom: '0.5rem' }}>אין שאלות</h2>
        <p className="text-muted" style={{ marginBottom: '1.5rem' }}>{error}</p>
        <button className="btn btn-primary" onClick={() => navigate('/shared-training')}>חזרה</button>
      </div>
    );
  }

  if (showSummary) {
    const totalAnswered = results.length;
    const correct = results.filter(r => r.correct).length;
    const nearMissTotal = results.filter(r => r.nearMiss).length;
    const scoredTotal = totalAnswered - nearMissTotal;
    const accuracy = scoredTotal > 0 ? (correct / scoredTotal) * 100 : 0;

    const catBreakdown: Record<string, { total: number; correct: number }> = {};
    results.forEach(r => {
      if (r.nearMiss) return;
      if (!catBreakdown[r.categoryId]) catBreakdown[r.categoryId] = { total: 0, correct: 0 };
      catBreakdown[r.categoryId].total++;
      if (r.correct) catBreakdown[r.categoryId].correct++;
    });

    const progress = getSharedProgress(name);

    return (
      <div className="fade-in" style={{ padding: '1rem', paddingBottom: '6rem', direction: 'rtl' }}>
        {/* Shareable summary area */}
        <div ref={summaryRef} style={{ background: '#1a1a2e', padding: '0.5rem' }}>
          <div style={{ textAlign: 'center', padding: '1.5rem 0' }}>
            <div style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>
              {accuracy >= 70 ? '🏆' : accuracy >= 50 ? '👍' : '💪'}
            </div>
            <h2 style={{ marginBottom: '0.3rem' }}>סיכום אימון — {name}</h2>
            <p className="text-muted">{totalAnswered} שאלות{nearMissTotal > 0 ? ` (${nearMissTotal} ניטרליות)` : ''}</p>
          </div>

          {/* Score */}
          <div className="card" style={{
            padding: '1.5rem', textAlign: 'center',
            background: accuracy >= 70 ? 'rgba(34,197,94,0.1)' : accuracy >= 50 ? 'rgba(59,130,246,0.1)' : 'rgba(239,68,68,0.1)',
            border: `1px solid ${accuracy >= 70 ? 'rgba(34,197,94,0.3)' : accuracy >= 50 ? 'rgba(59,130,246,0.3)' : 'rgba(239,68,68,0.3)'}`,
          }}>
            <div style={{
              fontSize: '3rem', fontWeight: 900,
              color: accuracy >= 70 ? '#22c55e' : accuracy >= 50 ? '#3b82f6' : '#ef4444',
            }}>
              {correct}/{scoredTotal}
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
              תשובות נכונות ({accuracy.toFixed(0)}%)
            </div>
            {nearMissTotal > 0 && (
              <div style={{ color: '#f59e0b', fontSize: '0.75rem', marginTop: '0.3rem' }}>
                ~ {nearMissTotal} תשובות ניטרליות (תקפות לפוקר מקצועי)
              </div>
            )}
          </div>

          {/* Dots */}
          <div className="card" style={{ padding: '1rem', marginTop: '0.5rem' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
              {results.map((r, i) => (
                <div key={i} style={{
                  width: '28px', height: '28px', borderRadius: '50%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '0.75rem', fontWeight: 700,
                  background: r.correct ? 'rgba(34,197,94,0.15)' : r.nearMiss ? 'rgba(245,158,11,0.15)' : 'rgba(239,68,68,0.15)',
                  color: r.correct ? '#22c55e' : r.nearMiss ? '#f59e0b' : '#ef4444',
                }}>
                  {r.correct ? '✓' : r.nearMiss ? '~' : '✗'}
                </div>
              ))}
            </div>
          </div>

          {/* Category breakdown */}
          {Object.keys(catBreakdown).length > 0 && (
            <div className="card" style={{ padding: '1rem', marginTop: '0.5rem' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '0.5rem' }}>
                לפי נושא
              </div>
              {Object.entries(catBreakdown).map(([catId, d]) => {
                const cat = SCENARIO_CATEGORIES.find(c => c.id === catId);
                const pct = d.total > 0 ? (d.correct / d.total) * 100 : 0;
                return (
                  <div key={catId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.3rem 0', fontSize: '0.85rem' }}>
                    <span>{cat?.icon} {cat?.name || catId}</span>
                    <span style={{ color: pct >= 60 ? '#22c55e' : pct >= 40 ? '#eab308' : '#ef4444', fontWeight: 600 }}>
                      {d.correct}/{d.total} ({pct.toFixed(0)}%)
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Home-game context note */}
          {(nearMissTotal > 0 || accuracy < 60) && (
            <div style={{
              padding: '0.5rem 0.75rem', marginTop: '0.5rem', borderRadius: '8px',
              background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.12)',
              fontSize: '0.7rem', color: 'var(--text-muted)', lineHeight: 1.6,
            }}>
              {nearMissTotal > 0
                ? `💡 ${nearMissTotal} תשובות ניטרליות — נכונות לפוקר מקצועי אבל לא אופטימליות למשחק שלנו. הן לא נספרות כשגיאה ולא כהצלחה`
                : '💡 השאלות מותאמות למשחק הביתי שלנו — בלופים עובדים פחות ושחקנים קוראים יותר, אז חלק מהתשובות שונות מפוקר מקצועי'
              }
            </div>
          )}

          {/* Streak */}
          {progress.streak.current > 0 && (
            <div className="card" style={{
              padding: '0.75rem 1rem', marginTop: '0.5rem', textAlign: 'center',
              background: 'rgba(249,115,22,0.1)', border: '1px solid rgba(249,115,22,0.2)',
            }}>
              <span style={{ fontSize: '1.2rem' }}>🔥</span>
              <span style={{ fontWeight: 700, marginRight: '0.3rem', marginLeft: '0.3rem' }}>
                רצף {progress.streak.current} ימים
              </span>
              {progress.streak.current >= progress.maxStreak && progress.maxStreak > 1 && (
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>שיא חדש!</span>
              )}
            </div>
          )}

          {/* New badges */}
          {newBadgeIds.length > 0 && (
            <div className="card" style={{
              padding: '1rem', marginTop: '0.5rem', textAlign: 'center',
              background: 'rgba(168,85,247,0.1)', border: '1px solid rgba(168,85,247,0.3)',
            }}>
              <div style={{ fontWeight: 700, fontSize: '0.9rem', color: '#a855f7', marginBottom: '0.5rem' }}>
                🏅 הישגים חדשים!
              </div>
              {newBadgeIds.map(id => {
                const badge = TRAINING_BADGES.find(b => b.id === id);
                const catBadge = id.startsWith('expert_');
                const catId = catBadge ? id.replace('expert_', '') : '';
                const cat = catBadge ? SCENARIO_CATEGORIES.find(c => c.id === catId) : null;
                return (
                  <div key={id} style={{ fontSize: '1.2rem', marginBottom: '0.25rem' }}>
                    {badge ? `${badge.icon} ${badge.name}` : cat ? `${cat.icon} מומחה: ${cat.name}` : id}
                  </div>
                );
              })}
            </div>
          )}

          {/* Personal insight (rule-based) + AI report teaser */}
          {(() => {
            const byCat = catBreakdown;
            const entries = Object.entries(byCat).filter(([, d]) => d.total >= 2);
            const best = entries.sort((a, b) => (b[1].correct / b[1].total) - (a[1].correct / a[1].total))[0];
            const worst = entries.sort((a, b) => (a[1].correct / a[1].total) - (b[1].correct / b[1].total))[0];
            const bestCat = best ? SCENARIO_CATEGORIES.find(c => c.id === best[0]) : null;
            const worstCat = worst ? SCENARIO_CATEGORIES.find(c => c.id === worst[0]) : null;
            const bestPct = best ? Math.round((best[1].correct / best[1].total) * 100) : 0;
            const worstPct = worst ? Math.round((worst[1].correct / worst[1].total) * 100) : 0;
            const totalSoFar = progress.totalQuestions + (progress.totalNeutral || 0);
            const nextMilestone = (Math.floor(totalSoFar / 100) + 1) * 100;
            const remaining = nextMilestone - totalSoFar;
            return (
              <div className="card" style={{ padding: '0.75rem', marginTop: '0.5rem', fontSize: '0.8rem', lineHeight: 1.6 }}>
                <div style={{ fontWeight: 600, marginBottom: '0.3rem' }}>💡 תובנות אישיות</div>
                {bestCat && bestPct >= 60 && (
                  <div style={{ color: '#22c55e' }}>
                    {bestCat.icon} אתה חזק ב{bestCat.name} ({bestPct}%) — המשך ככה!
                  </div>
                )}
                {worstCat && worstPct < 50 && worstCat.id !== bestCat?.id && (
                  <div style={{ color: '#f59e0b' }}>
                    {worstCat.icon} שים לב ל{worstCat.name} ({worstPct}%) — שווה לתרגל
                  </div>
                )}
                <div style={{ marginTop: '0.4rem', paddingTop: '0.4rem', borderTop: '1px solid var(--border)', textAlign: 'center', color: 'var(--text-muted)' }}>
                  📋 עוד <strong style={{ color: '#3b82f6' }}>{remaining}</strong> שאלות לדוח AI אישי (ב-{nextMilestone} שאלות)
                </div>
              </div>
            );
          })()}

          {/* Group comparison */}
          {allPlayerAnswers && allPlayerAnswers.players.length > 1 && (() => {
            const others = allPlayerAnswers.players.filter(p => p.playerName !== name && p.totalQuestions >= 5);
            if (others.length < 2) return null;
            const groupAvg = Math.round(others.reduce((s, p) => s + p.accuracy, 0) / others.length);
            const all = [...others, { playerName: name, accuracy, totalQuestions: scoredTotal, sessions: [], totalCorrect: correct }];
            const sorted = all.sort((a, b) => b.accuracy - a.accuracy);
            const rank = sorted.findIndex(p => p.playerName === name) + 1;
            return (
              <div className="card" style={{ padding: '0.75rem', marginTop: '0.5rem', fontSize: '0.8rem', textAlign: 'center' }}>
                <div style={{ marginBottom: '0.3rem' }}>
                  הדיוק שלך: <strong>{accuracy.toFixed(0)}%</strong> | ממוצע הקבוצה: <strong>{groupAvg}%</strong>
                </div>
                <div style={{ color: 'var(--text-muted)' }}>
                  מקום {rank} מתוך {sorted.length} שחקנים
                </div>
              </div>
            );
          })()}

          {/* AI Report milestone */}
          {reportMilestoneMsg && (
            <div className="card" style={{
              padding: '0.75rem', marginTop: '0.5rem',
              background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)',
            }}>
              <div style={{ fontWeight: 600, fontSize: '0.85rem', color: '#3b82f6', marginBottom: '0.3rem' }}>
                {generatingReport ? '⏳ מייצר דוח אישי...' : '📋 הדוח האישי שלך'}
              </div>
              {!generatingReport && (
                <div style={{ fontSize: '0.8rem', lineHeight: 1.6, color: 'var(--text-muted)', whiteSpace: 'pre-wrap' }}>
                  {reportMilestoneMsg}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Actions — outside the screenshot area */}
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => navigate('/shared-training')}>
            חזרה
          </button>
          <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => {
            setShowSummary(false);
            loadScenarios();
          }}>
            סבב חדש
          </button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: '0.5rem' }}>
          <button
            onClick={handleShare}
            disabled={isSharing}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem',
              fontSize: '0.75rem', padding: '0.4rem 0.8rem',
              background: 'var(--surface)', color: 'var(--text-muted)',
              border: '1px solid var(--border)', borderRadius: '6px', cursor: 'pointer',
            }}
          >
            {isSharing ? '📸...' : '📤 שתף תוצאה'}
          </button>
        </div>
      </div>
    );
  }

  // ── Question display ──
  const scenario = scenarios[currentIdx];
  if (!scenario) return null;

  const progressPct = ((currentIdx + 1) / scenarios.length) * 100;
  const isFlagged = flaggedThisSession.has(scenario.poolId);

  return (
    <div className="fade-in" style={{ padding: '0.5rem 0.75rem', paddingBottom: '1rem', direction: 'rtl' }}>
      {/* Exhaustion message */}
      {exhaustedMsg && currentIdx === 0 && (
        <div style={{
          padding: '0.4rem 0.6rem', borderRadius: '8px', marginBottom: '0.4rem',
          background: 'rgba(249,115,22,0.1)', border: '1px solid rgba(249,115,22,0.2)',
          fontSize: '0.7rem', color: '#f97316', textAlign: 'center',
        }}>
          {exhaustedMsg}
        </div>
      )}

      {/* Top bar + progress */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
        <button
          onClick={() => results.length > 0 ? concludeSession() : navigate('/shared-training')}
          style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '0.75rem', cursor: 'pointer', fontWeight: 600 }}
        >
          {results.length > 0 ? 'סיים ←' : 'חזרה ←'}
        </button>
        <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--primary)' }}>
          🎯 {currentIdx + 1}/{scenarios.length}
          {results.length > 0 && <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}> · ✅{results.filter(r => r.correct).length}</span>}
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ height: '3px', background: 'var(--border)', borderRadius: '2px', overflow: 'hidden', marginBottom: '0.4rem' }}>
        <div style={{ height: '100%', width: `${progressPct}%`, background: 'var(--primary)', transition: 'width 0.3s ease', borderRadius: '2px' }} />
      </div>

      {/* Home-game style reminder — first question only, dismissible */}
      {showStyleTip && currentIdx === 0 && !selectedOption && (
        <div style={{
          padding: '0.3rem 0.6rem', borderRadius: '6px', marginBottom: '0.3rem',
          background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.15)',
          display: 'flex', alignItems: 'center', gap: '0.3rem', direction: 'rtl',
        }}>
          <div style={{ flex: 1, fontSize: '0.6rem', color: 'var(--text-muted)', display: 'flex', gap: '0.25rem' }}>
            <span>💡</span>
            <span>התשובות מותאמות למשחק ביתי — שחקנים קוראים יותר, בלופים עובדים פחות</span>
          </div>
          <button onClick={() => setShowStyleTip(false)} style={{
            background: 'none', border: 'none', color: 'var(--text-muted)',
            cursor: 'pointer', fontSize: '0.65rem', padding: '0', flexShrink: 0,
          }}>✕</button>
        </div>
      )}

      {/* Scenario */}
      <div className="card" style={{ padding: '0.6rem 0.8rem', borderRight: '3px solid var(--primary)' }}>
        {/* Cards row: your hand + board */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
          <div style={{
            padding: '0.25rem 0.6rem', borderRadius: '8px',
            background: 'rgba(99,102,241,0.12)', fontSize: '0.9rem', fontWeight: 700,
            letterSpacing: '2px', display: 'flex', alignItems: 'center', gap: '0.3rem',
          }}>
            <span style={{ fontSize: '0.55rem', color: 'var(--text-muted)', fontWeight: 500 }}>יד</span>
            <ColoredCards text={scenario.yourCards} />
          </div>
          {scenario.boardCards && (
            <>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>|</span>
              <div style={{
                padding: '0.25rem 0.6rem', borderRadius: '8px',
                background: 'rgba(34,197,94,0.08)', fontSize: '0.9rem', fontWeight: 700,
                letterSpacing: '2px', display: 'flex', alignItems: 'center', gap: '0.3rem',
              }}>
                <span style={{ fontSize: '0.55rem', color: 'var(--text-muted)', fontWeight: 500 }}>בורד</span>
                <ColoredCards text={scenario.boardCards} />
              </div>
            </>
          )}
          {(() => {
            const cat = SCENARIO_CATEGORIES.find(c => c.id === scenario.categoryId);
            return cat ? <span style={{ fontSize: '0.55rem', color: 'var(--text-muted)', marginRight: 'auto' }}>{cat.icon} {cat.name}</span> : null;
          })()}
        </div>
        {/* Situation text */}
        <p style={{ fontSize: '0.85rem', lineHeight: 1.6, color: 'var(--text)', margin: 0 }}>
          <ColoredText text={scenario.situation} />
        </p>
      </div>

      {/* Report button — visible before answering */}
      {!selectedOption && !showFlagConfirm && !isFlagged && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.4rem' }}>
          <button
            onClick={() => setShowFlagConfirm(true)}
            style={{
              background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)',
              borderRadius: '6px', cursor: 'pointer',
              fontSize: '0.7rem', color: '#ef4444', padding: '0.25rem 0.6rem',
            }}
          >
            🚩 דווח על שאלה
          </button>
        </div>
      )}

      {/* Flag report panel (before answering) */}
      {!selectedOption && showFlagConfirm && (
        <div style={{
          marginTop: '0.5rem', marginBottom: '0.5rem', padding: '0.75rem', borderRadius: '10px',
          background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
          direction: 'rtl',
        }}>
          <div style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.5rem', textAlign: 'center' }}>🚩 דיווח על שאלה</div>
          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.6rem', textAlign: 'center' }}>
            מה הבעיה?
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', marginBottom: '0.6rem' }}>
            {([
              ['wrong_answer', '❌ התשובה הנכונה שגויה'],
              ['unclear_question', '❓ השאלה לא ברורה או חסרה מידע'],
              ['wrong_for_home_game', '🏠 מתאים למקצועי אבל לא למשחק שלנו'],
              ['other', '💬 אחר'],
            ] as [FlagReason, string][]).map(([val, label]) => (
              <button
                key={val}
                onClick={() => setFlagReason(val)}
                style={{
                  padding: '0.5rem 0.6rem', borderRadius: '8px', cursor: 'pointer',
                  fontSize: '0.75rem', textAlign: 'right',
                  background: flagReason === val ? 'rgba(239,68,68,0.2)' : 'var(--surface)',
                  border: flagReason === val ? '1px solid #ef4444' : '1px solid var(--border)',
                  color: flagReason === val ? '#ef4444' : 'var(--text)',
                  fontWeight: flagReason === val ? 600 : 400,
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <textarea
            value={flagComment}
            onChange={e => setFlagComment(e.target.value)}
            placeholder="פרט את הבעיה (אופציונלי)..."
            rows={2}
            style={{
              width: '100%', padding: '0.5rem', borderRadius: '8px', fontSize: '0.75rem',
              background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)',
              resize: 'vertical', direction: 'rtl', fontFamily: 'inherit', boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', marginTop: '0.6rem' }}>
            <button onClick={() => { handleFlag(); setSkippedAfterReport(true); }} disabled={!flagReason}
              style={{
                background: flagReason ? '#ef4444' : '#555', color: 'white', border: 'none',
                padding: '0.45rem 1.2rem', borderRadius: '8px', cursor: flagReason ? 'pointer' : 'not-allowed',
                fontSize: '0.8rem', fontWeight: 600, opacity: flagReason ? 1 : 0.5,
              }}>
              שלח דיווח
            </button>
            <button onClick={() => { setShowFlagConfirm(false); setFlagReason(null); setFlagComment(''); }}
              style={{
                background: 'var(--surface)', color: 'var(--text-muted)',
                border: '1px solid var(--border)', padding: '0.45rem 1.2rem', borderRadius: '8px',
                cursor: 'pointer', fontSize: '0.8rem',
              }}>
              ביטול
            </button>
          </div>
        </div>
      )}

      {/* Skip / Answer after report */}
      {!selectedOption && skippedAfterReport && isFlagged && (
        <div style={{
          marginTop: '0.5rem', display: 'flex', gap: '0.5rem', justifyContent: 'center',
        }}>
          <button
            onClick={handleSkipAfterReport}
            style={{
              padding: '0.5rem 1rem', borderRadius: '8px', border: '1px solid var(--border)',
              background: 'var(--surface)', color: 'var(--text-muted)', fontSize: '0.8rem',
              cursor: 'pointer', fontWeight: 600,
            }}
          >
            דלג על השאלה
          </button>
          <button
            onClick={() => setSkippedAfterReport(false)}
            style={{
              padding: '0.5rem 1rem', borderRadius: '8px', border: 'none',
              background: 'var(--primary)', color: 'white', fontSize: '0.8rem',
              cursor: 'pointer', fontWeight: 600,
            }}
          >
            ענה בכל זאת
          </button>
        </div>
      )}

      {/* Options */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', marginTop: '0.5rem' }}>
        {scenario.options.map(option => {
          const isSelected = selectedOption === option.id;
          const isRevealed = !!selectedOption;
          const isCorrectOption = option.isCorrect;
          const isNearMissOption = !isCorrectOption && !!option.nearMiss;
          const showExplanation = isRevealed && option.explanation;

          let borderColor = 'var(--border)';
          let bgColor = 'var(--surface)';
          let textColor = 'var(--text)';

          if (isRevealed) {
            if (isCorrectOption) {
              borderColor = '#22c55e';
              bgColor = 'rgba(34,197,94,0.1)';
              textColor = '#22c55e';
            } else if (isSelected && isNearMissOption) {
              borderColor = '#f59e0b';
              bgColor = 'rgba(245,158,11,0.1)';
              textColor = '#f59e0b';
            } else if (isSelected && !isCorrectOption) {
              borderColor = '#ef4444';
              bgColor = 'rgba(239,68,68,0.1)';
              textColor = '#ef4444';
            } else {
              bgColor = 'var(--surface)';
              textColor = 'var(--text-muted)';
            }
          }

          const iconSymbol = isRevealed
            ? (isCorrectOption ? '✓' : isSelected && isNearMissOption ? '~' : isSelected ? '✗' : option.id)
            : option.id;
          const iconBg = isRevealed
            ? (isCorrectOption ? 'rgba(34,197,94,0.2)' : isSelected && isNearMissOption ? 'rgba(245,158,11,0.2)' : isSelected ? 'rgba(239,68,68,0.2)' : 'var(--surface-light)')
            : 'var(--surface-light)';
          const iconColor = isRevealed
            ? (isCorrectOption ? '#22c55e' : isSelected && isNearMissOption ? '#f59e0b' : isSelected ? '#ef4444' : 'var(--text-muted)')
            : 'var(--text)';

          return (
            <button
              key={option.id}
              onClick={() => handleSelect(option.id)}
              disabled={isRevealed}
              style={{
                padding: '0.4rem 0.65rem', borderRadius: '10px',
                border: `1.5px solid ${borderColor}`, background: bgColor,
                cursor: isRevealed ? 'default' : 'pointer',
                textAlign: 'right', direction: 'rtl',
                transition: 'all 0.2s ease',
                opacity: isRevealed && !isCorrectOption && !isSelected ? 0.4 : 1,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <span style={{
                  width: '22px', height: '22px', borderRadius: '50%', flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontWeight: 700, fontSize: '0.65rem',
                  background: iconBg, color: iconColor,
                }}>
                  {iconSymbol}
                </span>
                <span style={{ fontWeight: 600, fontSize: '0.8rem', color: textColor }}>
                  {option.text}
                </span>
              </div>

              {isRevealed && isSelected && isNearMissOption && (
                <div style={{
                  marginTop: '0.25rem', padding: '0.15rem 0.4rem', borderRadius: '4px',
                  background: 'rgba(245,158,11,0.1)', display: 'inline-block',
                  fontSize: '0.6rem', fontWeight: 600, color: '#f59e0b',
                }}>
                  🏠 תשובה טובה לפוקר מקצועי, לא אופטימלית למשחק שלנו
                </div>
              )}

              {showExplanation && (
                <div style={{
                  marginTop: '0.2rem', fontSize: '0.65rem', lineHeight: 1.4,
                  color: 'var(--text-muted)', paddingRight: '1.6rem',
                }}>
                  <ColoredText text={option.explanation!} />
                </div>
              )}
            </button>
          );
        })}
      </div>

      {/* Reaction after answering */}
      {selectedOption && (() => {
        const chosen = scenario.options.find(o => o.id === selectedOption);
        if (!chosen) return null;
        const isCorrectAnswer = chosen.isCorrect;
        const isNearMissAnswer = !isCorrectAnswer && !!chosen.nearMiss;
        const isWrongAnswer = !isCorrectAnswer && !isNearMissAnswer;

        const reactionSeed = scenario.poolId.charCodeAt(0) + scenario.poolId.charCodeAt(scenario.poolId.length - 1);
        const reaction = isCorrectAnswer
          ? CORRECT_ANSWER_REACTIONS[reactionSeed % CORRECT_ANSWER_REACTIONS.length]
          : isWrongAnswer
            ? WRONG_ANSWER_REACTIONS[reactionSeed % WRONG_ANSWER_REACTIONS.length]
            : null;

        return reaction ? (
          <div style={{
            marginTop: '0.3rem', padding: '0.25rem 0.5rem', borderRadius: '6px',
            background: isCorrectAnswer ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.06)',
            fontSize: '0.7rem', fontWeight: 600, textAlign: 'center',
            color: isCorrectAnswer ? '#22c55e' : '#ef4444',
          }}>
            {reaction}
          </div>
        ) : null;
      })()}

      {/* Player comparison */}
      {selectedOption && allPlayerAnswers && (() => {
        const poolId = scenario.poolId;
        const chosen = scenario.options.find(o => o.id === selectedOption);
        if (!chosen) return null;
        let totalAnswered = 0;
        let correctCount = 0;
        for (const p of allPlayerAnswers.players) {
          if (p.playerName === name) continue;
          for (const s of p.sessions) {
            const r = s.results.find(res => res.poolId === poolId);
            if (r) { totalAnswered++; if (r.correct) correctCount++; break; }
          }
        }
        if (totalAnswered < 3) return null;
        const userCorrect = chosen.isCorrect;
        const wrongCount = totalAnswered - correctCount;
        return (
          <div style={{
            marginTop: '0.2rem', padding: '0.2rem 0.5rem', borderRadius: '6px',
            background: 'rgba(99,102,241,0.06)', fontSize: '0.6rem',
            color: 'var(--text-muted)', textAlign: 'center',
          }}>
            {userCorrect
              ? (correctCount < totalAnswered / 2
                ? `👏 רק ${correctCount} מתוך ${totalAnswered} שחקנים ענו נכון — כל הכבוד!`
                : `👥 ${correctCount} מתוך ${totalAnswered} שחקנים ענו נכון`)
              : (wrongCount > totalAnswered / 2
                ? `👥 גם ${wrongCount} שחקנים אחרים טעו פה`
                : `👥 ${correctCount} מתוך ${totalAnswered} שחקנים ענו נכון`)
            }
          </div>
        );
      })()}

      {/* Next + Flag */}
      {selectedOption && (
        <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <button
            onClick={handleNext}
            style={{
              width: '100%', padding: '0.85rem', borderRadius: '12px', border: 'none',
              background: currentIdx >= scenarios.length - 1
                ? 'linear-gradient(135deg, #6366f1, #4f46e5)'
                : 'linear-gradient(135deg, var(--primary), var(--primary-dark))',
              color: 'white', fontWeight: 700, fontSize: '1rem', cursor: 'pointer',
              boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
            }}
          >
            {currentIdx >= scenarios.length - 1 ? 'סיכום ←' : 'הבאה ←'}
          </button>

          {!isFlagged && !showFlagConfirm && (
            <button
              onClick={() => setShowFlagConfirm(true)}
              style={{
                width: '100%', padding: '0.55rem', borderRadius: '10px',
                border: '1px solid rgba(239,68,68,0.25)', background: 'rgba(239,68,68,0.06)',
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem',
                fontSize: '0.75rem', color: '#ef4444',
              }}
            >
              🚩 דווח על שאלה
            </button>
          )}
          {isFlagged && (
            <div style={{
              width: '100%', padding: '0.55rem', borderRadius: '10px',
              background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '0.75rem', color: '#ef4444',
            }}>
              ✓ דווח בהצלחה
            </div>
          )}
        </div>
      )}

      {/* Post-answer flag report panel */}
      {selectedOption && showFlagConfirm && (
        <div style={{
          marginTop: '0.5rem', padding: '0.75rem', borderRadius: '10px',
          background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
          direction: 'rtl',
        }}>
          <div style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.5rem', textAlign: 'center' }}>🚩 דיווח על שאלה</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', marginBottom: '0.6rem' }}>
            {([
              ['wrong_answer', '❌ התשובה הנכונה שגויה'],
              ['unclear_question', '❓ השאלה לא ברורה או חסרה מידע'],
              ['wrong_for_home_game', '🏠 מתאים למקצועי אבל לא למשחק שלנו'],
              ['other', '💬 אחר'],
            ] as [FlagReason, string][]).map(([val, label]) => (
              <button key={val} onClick={() => setFlagReason(val)}
                style={{
                  padding: '0.5rem 0.6rem', borderRadius: '8px', cursor: 'pointer',
                  fontSize: '0.75rem', textAlign: 'right',
                  background: flagReason === val ? 'rgba(239,68,68,0.2)' : 'var(--surface)',
                  border: flagReason === val ? '1px solid #ef4444' : '1px solid var(--border)',
                  color: flagReason === val ? '#ef4444' : 'var(--text)',
                  fontWeight: flagReason === val ? 600 : 400,
                }}>
                {label}
              </button>
            ))}
          </div>
          <textarea value={flagComment} onChange={e => setFlagComment(e.target.value)}
            placeholder="פרט את הבעיה (אופציונלי)..." rows={2}
            style={{
              width: '100%', padding: '0.5rem', borderRadius: '8px', fontSize: '0.75rem',
              background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)',
              resize: 'vertical', direction: 'rtl', fontFamily: 'inherit', boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', marginTop: '0.6rem' }}>
            <button onClick={handleFlag} disabled={!flagReason}
              style={{
                background: flagReason ? '#ef4444' : '#555', color: 'white', border: 'none',
                padding: '0.45rem 1.2rem', borderRadius: '8px', cursor: flagReason ? 'pointer' : 'not-allowed',
                fontSize: '0.8rem', fontWeight: 600, opacity: flagReason ? 1 : 0.5,
              }}>
              שלח דיווח
            </button>
            <button onClick={() => { setShowFlagConfirm(false); setFlagReason(null); setFlagComment(''); }}
              style={{
                background: 'var(--surface)', color: 'var(--text-muted)',
                border: '1px solid var(--border)', padding: '0.45rem 1.2rem', borderRadius: '8px',
                cursor: 'pointer', fontSize: '0.8rem',
              }}>
              ביטול
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default SharedQuickPlayScreen;
