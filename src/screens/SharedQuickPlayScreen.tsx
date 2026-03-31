import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { usePermissions } from '../App';
import {
  PoolScenario,
  TrainingSession,
  TrainingAnswerResult,
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
  generateSessionShareText,
  TRAINING_BADGES,
} from '../utils/pokerTraining';

const ColoredCards = ({ text }: { text: string }) => {
  const parts = text.split(/(\S+)/g);
  return (
    <>
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
  const [showFlagConfirm, setShowFlagConfirm] = useState(false);
  const [shareMsg, setShareMsg] = useState<string | null>(null);

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
      setSelectedOption(null);
      setShowSummary(false);
      setNewBadgeIds([]);
      setFlaggedThisSession(new Set());
    } catch {
      setError('שגיאה בטעינת שאלות');
    } finally {
      setLoading(false);
    }
  }, [categoriesParam, sessionLength, name]);

  useEffect(() => {
    loadScenarios();
  }, [loadScenarios]);

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

    const result: TrainingAnswerResult = {
      poolId: scenario.poolId,
      categoryId: scenario.categoryId,
      correct: isCorrect,
      chosenId: optionId,
    };
    setResults(prev => [...prev, result]);

    // Update local progress
    const progress = getSharedProgress(name);
    progress.totalQuestions++;
    if (isCorrect) {
      progress.totalCorrect++;
      progress.currentCorrectRun++;
      progress.longestCorrectRun = Math.max(progress.longestCorrectRun, progress.currentCorrectRun);
    } else {
      progress.currentCorrectRun = 0;
    }

    if (!progress.byCategory[scenario.categoryId]) {
      progress.byCategory[scenario.categoryId] = { total: 0, correct: 0 };
    }
    progress.byCategory[scenario.categoryId].total++;
    if (isCorrect) progress.byCategory[scenario.categoryId].correct++;

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

  const concludeSession = () => {
    const correctCount = results.filter(r => r.correct).length;
    const total = results.length;
    if (total === 0) {
      navigate('/shared-training');
      return;
    }

    const progress = getSharedProgress(name);
    progress.sessionsCompleted++;
    updateStreak(progress);

    const badges = checkNewBadges(progress);
    if (badges.length > 0) {
      progress.earnedBadgeIds = [...progress.earnedBadgeIds, ...badges];
      setNewBadgeIds(badges);
    }

    saveSharedProgress(name, progress);

    const session: TrainingSession = {
      date: new Date().toISOString(),
      questionsAnswered: total,
      correctAnswers: correctCount,
      results,
      flaggedPoolIds: Array.from(flaggedThisSession),
    };
    bufferSessionForUpload(name, session);
    flushPendingUploads();

    setShowSummary(true);
  };

  const handleFlag = () => {
    const scenario = scenarios[currentIdx];
    setFlaggedThisSession(prev => new Set(prev).add(scenario.poolId));

    const progress = getSharedProgress(name);
    if (!progress.flaggedPoolIds.includes(scenario.poolId)) {
      progress.flaggedPoolIds.push(scenario.poolId);
    }
    const badges = checkNewBadges(progress);
    if (badges.length > 0) progress.earnedBadgeIds = [...progress.earnedBadgeIds, ...badges];
    saveSharedProgress(name, progress);
    setShowFlagConfirm(false);
  };

  const handleShare = () => {
    const correctCount = results.filter(r => r.correct).length;
    const total = results.length;
    const accuracy = total > 0 ? (correctCount / total) * 100 : 0;
    const text = generateSessionShareText(name, correctCount, total, accuracy);

    if (navigator.share) {
      navigator.share({ text }).catch(() => {});
    } else {
      navigator.clipboard.writeText(text).then(() => {
        setShareMsg('הועתק!');
        setTimeout(() => setShareMsg(null), 2000);
      }).catch(() => {});
    }
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
    const total = results.length;
    const correct = results.filter(r => r.correct).length;
    const accuracy = total > 0 ? (correct / total) * 100 : 0;

    const catBreakdown: Record<string, { total: number; correct: number }> = {};
    results.forEach(r => {
      if (!catBreakdown[r.categoryId]) catBreakdown[r.categoryId] = { total: 0, correct: 0 };
      catBreakdown[r.categoryId].total++;
      if (r.correct) catBreakdown[r.categoryId].correct++;
    });

    const progress = getSharedProgress(name);

    return (
      <div className="fade-in" style={{ padding: '1rem', paddingBottom: '6rem', direction: 'rtl' }}>
        <div style={{ textAlign: 'center', padding: '1.5rem 0' }}>
          <div style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>
            {accuracy >= 70 ? '🏆' : accuracy >= 50 ? '👍' : '💪'}
          </div>
          <h2 style={{ marginBottom: '0.3rem' }}>סיכום אימון</h2>
          <p className="text-muted">{total} שאלות</p>
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
            {correct}/{total}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            תשובות נכונות ({accuracy.toFixed(0)}%)
          </div>
        </div>

        {/* Dots */}
        <div className="card" style={{ padding: '1rem', marginTop: '0.5rem' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
            {results.map((r, i) => (
              <div key={i} style={{
                width: '28px', height: '28px', borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '0.75rem', fontWeight: 700,
                background: r.correct ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                color: r.correct ? '#22c55e' : '#ef4444',
              }}>
                {r.correct ? '✓' : '✗'}
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

        {/* Actions */}
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
        <button
          onClick={handleShare}
          style={{
            width: '100%', marginTop: '0.5rem', padding: '0.7rem',
            borderRadius: '10px', border: '1px solid var(--border)',
            background: 'var(--surface)', color: 'var(--text)',
            fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer',
          }}
        >
          {shareMsg || '📤 שתף תוצאה'}
        </button>
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
              background: r.correct ? '#22c55e' : '#ef4444', opacity: 0.8,
            }} />
          ))}
          {Array.from({ length: Math.max(0, scenarios.length - results.length) }).map((_, i) => (
            <div key={`e-${i}`} style={{ width: '10px', height: '10px', borderRadius: '50%', background: 'var(--border)' }} />
          ))}
        </div>
      )}
      {results.length > 0 && scenarios.length > 20 && (
        <div style={{ textAlign: 'center', marginBottom: '0.5rem', fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 600 }}>
          ✅ {results.filter(r => r.correct).length} / {results.length}
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
          {scenario.situation}
        </p>
      </div>

      {/* Options */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.75rem' }}>
        {scenario.options.map(option => {
          const isSelected = selectedOption === option.id;
          const isRevealed = !!selectedOption;
          const isCorrectOption = option.isCorrect;

          let borderColor = 'var(--border)';
          let bgColor = 'var(--surface)';
          let textColor = 'var(--text)';

          if (isRevealed) {
            if (isCorrectOption) {
              borderColor = '#22c55e';
              bgColor = 'rgba(34,197,94,0.1)';
              textColor = '#22c55e';
            } else if (isSelected && !isCorrectOption) {
              borderColor = '#ef4444';
              bgColor = 'rgba(239,68,68,0.1)';
              textColor = '#ef4444';
            } else {
              bgColor = 'var(--surface)';
              textColor = 'var(--text-muted)';
            }
          }

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
                    background: isRevealed
                      ? (isCorrectOption ? 'rgba(34,197,94,0.2)' : isSelected ? 'rgba(239,68,68,0.2)' : 'var(--surface-light)')
                      : 'var(--surface-light)',
                    color: isRevealed
                      ? (isCorrectOption ? '#22c55e' : isSelected ? '#ef4444' : 'var(--text-muted)')
                      : 'var(--text)',
                  }}>
                    {isRevealed ? (isCorrectOption ? '✓' : isSelected ? '✗' : option.id) : option.id}
                  </span>
                  <span style={{ fontWeight: 600, fontSize: '0.9rem', color: textColor }}>
                    {option.text}
                  </span>
                </div>
              </div>

              {/* Show explanation for ALL options when revealed */}
              {isRevealed && option.explanation && (
                <div style={{
                  marginTop: '0.5rem', fontSize: '0.8rem', lineHeight: 1.6,
                  color: 'var(--text-muted)', paddingRight: '2rem',
                }}>
                  {option.explanation}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {/* Flag + Next row */}
      {selectedOption && (
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', alignItems: 'center' }}>
          <button
            onClick={handleNext}
            style={{
              flex: 1, padding: '0.85rem', borderRadius: '12px', border: 'none',
              background: currentIdx >= scenarios.length - 1
                ? 'linear-gradient(135deg, #6366f1, #4f46e5)'
                : 'linear-gradient(135deg, var(--primary), var(--primary-dark))',
              color: 'white', fontWeight: 700, fontSize: '1rem', cursor: 'pointer',
              boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
            }}
          >
            {currentIdx >= scenarios.length - 1 ? 'סיכום ←' : 'הבאה ←'}
          </button>

          {/* Flag button */}
          {!isFlagged && !showFlagConfirm && (
            <button
              onClick={() => setShowFlagConfirm(true)}
              style={{
                width: '44px', height: '44px', borderRadius: '12px',
                border: '1px solid var(--border)', background: 'var(--surface)',
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '1rem', flexShrink: 0,
              }}
              title="דווח על שאלה"
            >
              🚩
            </button>
          )}
          {isFlagged && (
            <div style={{
              width: '44px', height: '44px', borderRadius: '12px',
              background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '0.7rem', color: '#ef4444', flexShrink: 0,
            }}>
              דווח
            </div>
          )}
        </div>
      )}

      {/* Flag confirmation */}
      {showFlagConfirm && (
        <div style={{
          marginTop: '0.5rem', padding: '0.75rem', borderRadius: '10px',
          background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)',
          textAlign: 'center',
        }}>
          <div style={{ fontSize: '0.85rem', marginBottom: '0.5rem' }}>דווח על שאלה לא תקינה?</div>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center' }}>
            <button className="btn btn-sm" onClick={handleFlag}
              style={{ background: '#ef4444', color: 'white', border: 'none', padding: '0.4rem 1rem', borderRadius: '8px', cursor: 'pointer', fontSize: '0.8rem' }}>
              כן, דווח
            </button>
            <button className="btn btn-sm" onClick={() => setShowFlagConfirm(false)}
              style={{ background: 'var(--surface-light)', color: 'var(--text)', border: 'none', padding: '0.4rem 1rem', borderRadius: '8px', cursor: 'pointer', fontSize: '0.8rem' }}>
              ביטול
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default SharedQuickPlayScreen;
