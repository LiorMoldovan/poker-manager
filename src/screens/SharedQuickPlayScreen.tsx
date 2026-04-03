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
  SCENARIO_CATEGORIES,
  loadFromPool,
  getSharedProgress,
  saveSharedProgress,
  updateStreak,
  checkNewBadges,
  bufferSessionForUpload,
  flushPendingUploads,
  TRAINING_BADGES,
} from '../utils/pokerTraining';

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
    bufferSessionForUpload(name, session);
    flushPendingUploads();

    if (!resultsToUse) setShowSummary(true);
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
    <div className="fade-in" style={{ padding: '0.75rem', paddingBottom: '2rem', direction: 'rtl' }}>
      {/* Exhaustion message */}
      {exhaustedMsg && currentIdx === 0 && (
        <div style={{
          padding: '0.6rem 0.75rem', borderRadius: '10px', marginBottom: '0.5rem',
          background: 'rgba(249,115,22,0.1)', border: '1px solid rgba(249,115,22,0.2)',
          fontSize: '0.8rem', color: '#f97316', textAlign: 'center',
        }}>
          {exhaustedMsg}
        </div>
      )}

      {/* Top bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
        <button
          onClick={() => results.length > 0 ? concludeSession() : navigate('/shared-training')}
          style={{ background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '0.85rem', cursor: 'pointer', fontWeight: 600 }}
        >
          {results.length > 0 ? 'סיים ←' : 'חזרה ←'}
        </button>
        <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--primary)' }}>
          🎯 {currentIdx + 1}/{scenarios.length}
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ height: '4px', background: 'var(--border)', borderRadius: '2px', overflow: 'hidden', marginBottom: '0.75rem' }}>
        <div style={{ height: '100%', width: `${progressPct}%`, background: 'var(--primary)', transition: 'width 0.3s ease', borderRadius: '2px' }} />
      </div>

      {/* Score dots (capped at 20 to prevent overflow in unlimited mode) */}
      {results.length > 0 && scenarios.length <= 20 && (
        <div style={{ display: 'flex', gap: '0.3rem', justifyContent: 'center', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
          {results.map((r, i) => (
            <div key={i} style={{
              width: '10px', height: '10px', borderRadius: '50%',
              background: r.correct ? '#22c55e' : r.nearMiss ? '#f59e0b' : '#ef4444', opacity: 0.8,
            }} />
          ))}
          {Array.from({ length: Math.max(0, scenarios.length - results.length) }).map((_, i) => (
            <div key={`e-${i}`} style={{ width: '10px', height: '10px', borderRadius: '50%', background: 'var(--border)' }} />
          ))}
        </div>
      )}
      {results.length > 0 && scenarios.length > 20 && (
        <div style={{ textAlign: 'center', marginBottom: '0.5rem', fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 600 }}>
          ✅ {results.filter(r => r.correct).length} / {results.filter(r => !r.nearMiss).length}
        </div>
      )}

      {/* Home-game style reminder — first question only, dismissible */}
      {showStyleTip && currentIdx === 0 && !selectedOption && (
        <div style={{
          padding: '0.5rem 0.75rem', borderRadius: '8px', marginBottom: '0.5rem',
          background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.15)',
          display: 'flex', alignItems: 'flex-start', gap: '0.4rem', direction: 'rtl',
        }}>
          <div style={{ flex: 1, fontSize: '0.7rem', color: 'var(--text-muted)', lineHeight: 1.6, display: 'flex', gap: '0.35rem' }}>
            <span style={{ flexShrink: 0 }}>💡</span>
            <span>התשובות מותאמות למשחק ביתי — שחקנים קוראים יותר, בלופים עובדים פחות</span>
          </div>
          <button onClick={() => setShowStyleTip(false)} style={{
            background: 'none', border: 'none', color: 'var(--text-muted)',
            cursor: 'pointer', fontSize: '0.7rem', padding: '0', flexShrink: 0,
          }}>✕</button>
        </div>
      )}

      {/* Scenario */}
      <div className="card" style={{ padding: '1rem 1.25rem', borderRight: '3px solid var(--primary)' }}>
        <div style={{
          display: 'inline-block', padding: '0.25rem 0.6rem', borderRadius: '8px',
          background: 'rgba(99,102,241,0.12)', fontSize: '0.9rem', fontWeight: 700,
          marginBottom: '0.75rem', letterSpacing: '2px',
        }}>
          🃏 <ColoredCards text={scenario.yourCards} />
        </div>
        <p style={{ fontSize: '0.95rem', lineHeight: 1.7, color: 'var(--text)', margin: 0 }}>
          {fixCardBidi(scenario.situation)}
        </p>
      </div>

      {/* Options */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.75rem' }}>
        {scenario.options.map(option => {
          const isSelected = selectedOption === option.id;
          const isRevealed = !!selectedOption;
          const isCorrectOption = option.isCorrect;
          const isNearMissOption = !isCorrectOption && !!option.nearMiss;

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
                padding: '0.75rem 1rem', borderRadius: '12px',
                border: `2px solid ${borderColor}`, background: bgColor,
                cursor: isRevealed ? 'default' : 'pointer',
                textAlign: 'right', direction: 'rtl',
                transition: 'all 0.2s ease',
                opacity: isRevealed && !isCorrectOption && !isSelected ? 0.5 : 1,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{
                    width: '26px', height: '26px', borderRadius: '50%',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontWeight: 700, fontSize: '0.75rem',
                    background: iconBg,
                    color: iconColor,
                  }}>
                    {iconSymbol}
                  </span>
                  <span style={{ fontWeight: 600, fontSize: '0.9rem', color: textColor }}>
                    {option.text}
                  </span>
                </div>
              </div>

              {/* Near-miss tag */}
              {isRevealed && isSelected && isNearMissOption && (
                <div style={{
                  marginTop: '0.4rem', padding: '0.25rem 0.5rem', borderRadius: '6px',
                  background: 'rgba(245,158,11,0.1)', display: 'inline-block',
                  fontSize: '0.7rem', fontWeight: 600, color: '#f59e0b',
                }}>
                  🏠 תשובה טובה לפוקר מקצועי, לא אופטימלית למשחק שלנו
                </div>
              )}

              {/* Show explanation for ALL options when revealed */}
              {isRevealed && option.explanation && (
                <div style={{
                  marginTop: '0.5rem', fontSize: '0.8rem', lineHeight: 1.6,
                  color: 'var(--text-muted)', paddingRight: '2rem',
                }}>
                  {fixCardBidi(option.explanation)}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {/* Context note after wrong answer (skip for near-miss — already has its own tag) */}
      {selectedOption && (() => {
        const chosen = scenario.options.find(o => o.id === selectedOption);
        if (!chosen || chosen.isCorrect || chosen.nearMiss) return null;
        return (
          <div style={{
            marginTop: '0.5rem', padding: '0.4rem 0.6rem', borderRadius: '8px',
            background: 'rgba(99,102,241,0.05)', fontSize: '0.65rem',
            color: 'var(--text-muted)', direction: 'rtl', lineHeight: 1.5,
          }}>
            🏠 התשובות מותאמות למשחק הביתי שלנו — שחקנים קוראים יותר ובלופים עובדים פחות מאשר בפוקר מקצועי
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
              🚩 השאלה או התשובה לא נכונים? דווח כאן
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

      {/* Flag report panel */}
      {showFlagConfirm && (
        <div style={{
          marginTop: '0.5rem', padding: '0.75rem', borderRadius: '10px',
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
              resize: 'vertical', direction: 'rtl', fontFamily: 'inherit',
              boxSizing: 'border-box',
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
