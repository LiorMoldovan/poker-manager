import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import AIProgressBar from '../components/AIProgressBar';
import { withAITiming } from '../utils/aiTiming';
import {
  QuickScenario,
  SCENARIO_CATEGORIES,
  generateQuickBatch,
  recordDecision,
  saveSession,
  SessionResult,
  getLastTrainingModelDisplay,
} from '../utils/pokerTraining';

const fixCardBidi = (text: string): string =>
  text.replace(/([AKQJ]|10|[2-9])(♠|♥|♦|♣)/g, '\u200E$1$2\u200E');

const ColoredCards = ({ text }: { text: string }) => {
  const parts = text.split(/(\S+)/g);
  return (
    <span style={{ direction: 'ltr', unicodeBidi: 'isolate' }}>
      {parts.map((part, i) => {
        const hasRed = part.includes('♥') || part.includes('♦');
        const hasSuit = hasRed || part.includes('♠') || part.includes('♣');
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

const QuickTrainingScreen = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const categoriesParam = searchParams.get('categories') || '';
  const maxHands = parseInt(searchParams.get('maxHands') || '8', 10) || 8;

  const [scenarios, setScenarios] = useState<QuickScenario[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<{ correct: boolean; categoryId: string }[]>([]);
  const [showSummary, setShowSummary] = useState(false);
  const [quickModelName, setQuickModelName] = useState<string>('');

  const loadBatch = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const catIds = categoriesParam ? categoriesParam.split(',').filter(Boolean) : undefined;
      const batch = await withAITiming('quick_training', () => generateQuickBatch(maxHands, catIds));
      setScenarios(batch);
      setQuickModelName(getLastTrainingModelDisplay());
      setCurrentIdx(0);
      setResults([]);
      setSelectedOption(null);
      setShowSummary(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'NO_API_KEY') {
        setError('כדי להשתמש באימון, הגדר מפתח בהגדרות');
      } else if (msg === 'INVALID_API_KEY') {
        setError('המפתח שהוגדר לא תקין, בדוק בהגדרות');
      } else if (msg.startsWith('ALL_MODELS_FAILED')) {
        setError('לא הצלחנו לייצר שאלות, נסה שוב');
      } else {
        setError(`שגיאה: ${msg}`);
      }
    } finally {
      setLoading(false);
    }
  }, [categoriesParam]);

  useEffect(() => {
    loadBatch();
  }, [loadBatch]);

  const handleSelect = (optionId: string) => {
    if (selectedOption) return;
    setSelectedOption(optionId);

    const scenario = scenarios[currentIdx];
    const chosen = scenario.options.find(o => o.id === optionId);
    const isCorrect = chosen?.isCorrect || false;

    setResults(prev => [...prev, { correct: isCorrect, categoryId: scenario.categoryId }]);

    recordDecision(
      scenario.categoryId,
      'hard',
      isCorrect ? 'best' : 'bad'
    );
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
    const correctCount = results.length > 0
      ? results.filter(r => r.correct).length
      : 0;
    const total = results.length;

    const session: SessionResult = {
      date: new Date().toISOString(),
      handsPlayed: total,
      totalDecisions: total,
      bestDecisions: correctCount,
      goodDecisions: 0,
      categories: [...new Set(results.map(r => r.categoryId))],
      difficulty: 'hard',
      accuracy: total > 0 ? (correctCount / total) * 100 : 0,
    };

    saveSession(session);
    setShowSummary(true);
  };

  // Loading
  if (loading) {
    return (
      <div className="fade-in" style={{
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        minHeight: '70vh', gap: '1.5rem', padding: '2rem',
      }}>
        <div style={{ fontSize: '2.5rem', animation: 'pulse 1.5s infinite' }}>⚡</div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontWeight: '700', fontSize: '1.1rem', marginBottom: '0.3rem' }}>
            מכין שאלות...
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            יוצר סט אימון מהיר
          </div>
          <AIProgressBar operationKey="quick_training" />
        </div>
      </div>
    );
  }

  // Error
  if (error) {
    return (
      <div className="fade-in" style={{ textAlign: 'center', padding: '3rem' }}>
        <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>😕</div>
        <h2 style={{ marginBottom: '0.5rem' }}>שגיאה</h2>
        <p className="text-muted" style={{ marginBottom: '1.5rem' }}>{error}</p>
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center' }}>
          <button className="btn btn-primary" onClick={loadBatch}>נסה שוב</button>
          <button className="btn btn-secondary" onClick={() => navigate('/training')}>חזרה</button>
        </div>
      </div>
    );
  }

  // Summary
  if (showSummary) {
    const total = results.length;
    const correct = results.filter(r => r.correct).length;
    const accuracy = total > 0 ? (correct / total) * 100 : 0;

    const categoryBreakdown: Record<string, { total: number; correct: number }> = {};
    results.forEach(r => {
      if (!categoryBreakdown[r.categoryId]) categoryBreakdown[r.categoryId] = { total: 0, correct: 0 };
      categoryBreakdown[r.categoryId].total++;
      if (r.correct) categoryBreakdown[r.categoryId].correct++;
    });

    const weakInSession = Object.entries(categoryBreakdown)
      .filter(([, d]) => d.total > 0 && d.correct / d.total < 0.5)
      .map(([id]) => SCENARIO_CATEGORIES.find(c => c.id === id)?.name)
      .filter(Boolean);

    return (
      <div className="fade-in" style={{ padding: '1rem', paddingBottom: '6rem' }}>
        <div style={{ textAlign: 'center', padding: '1.5rem 0' }}>
          <div style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>
            {accuracy >= 70 ? '🏆' : accuracy >= 50 ? '👍' : '💪'}
          </div>
          <h2 style={{ marginBottom: '0.3rem' }}>סיכום אימון מהיר</h2>
          <p className="text-muted">{total} שאלות</p>
        </div>

        <div className="card" style={{
          padding: '1.5rem', textAlign: 'center',
          background: accuracy >= 70
            ? 'rgba(34, 197, 94, 0.1)'
            : accuracy >= 50
              ? 'rgba(59, 130, 246, 0.1)'
              : 'rgba(239, 68, 68, 0.1)',
          border: `1px solid ${accuracy >= 70 ? 'rgba(34,197,94,0.3)' : accuracy >= 50 ? 'rgba(59,130,246,0.3)' : 'rgba(239,68,68,0.3)'}`,
        }}>
          <div style={{
            fontSize: '3rem', fontWeight: '900',
            color: accuracy >= 70 ? '#22c55e' : accuracy >= 50 ? '#3b82f6' : '#ef4444',
          }}>
            {correct}/{total}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
            תשובות נכונות ({accuracy.toFixed(0)}%)
          </div>
        </div>

        {/* Per-question results */}
        <div className="card" style={{ padding: '1rem', marginTop: '0.5rem' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: '600', marginBottom: '0.5rem' }}>
            פירוט
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
            {results.map((r, i) => (
              <div key={i} style={{
                width: '28px', height: '28px', borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '0.75rem', fontWeight: '700',
                background: r.correct ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                color: r.correct ? '#22c55e' : '#ef4444',
              }}>
                {r.correct ? '✓' : '✗'}
              </div>
            ))}
          </div>
        </div>

        {/* Insights */}
        <div className="card" style={{
          padding: '1rem', marginTop: '0.5rem',
          background: 'rgba(99, 102, 241, 0.08)',
          border: '1px solid rgba(99, 102, 241, 0.2)',
        }}>
          <div style={{ fontWeight: '700', fontSize: '0.85rem', color: '#a78bfa', marginBottom: '0.4rem' }}>
            💡 תובנות
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.6, direction: 'rtl' }}>
            {accuracy >= 80 && <div>ביצועים מעולים! אתה מקבל החלטות מדויקות.</div>}
            {accuracy >= 50 && accuracy < 80 && <div>ביצועים טובים, יש מקום לשיפור.</div>}
            {accuracy < 50 && <div>היה מאתגר - זה הזמן ללמוד מהטעויות.</div>}
            {weakInSession.length > 0 && (
              <div style={{ marginTop: '0.3rem' }}>
                מומלץ לתרגל: {weakInSession.join(', ')}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
          <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => navigate('/training')}>
            חזרה
          </button>
          <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => {
            setShowSummary(false);
            loadBatch();
          }}>
            סבב חדש
          </button>
        </div>
      </div>
    );
  }

  // Scenario display
  const scenario = scenarios[currentIdx];
  if (!scenario) return null;

  const progress = ((currentIdx + 1) / scenarios.length) * 100;
  const correctOption = scenario.options.find(o => o.isCorrect);

  return (
    <div className="fade-in" style={{ padding: '0.75rem', paddingBottom: '2rem' }}>
      {/* Top bar */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: '0.5rem',
      }}>
        <button
          onClick={() => {
            if (results.length > 0) {
              concludeSession();
            } else {
              navigate('/training');
            }
          }}
          style={{
            background: 'none', border: 'none', color: 'var(--text-muted)',
            fontSize: '0.85rem', cursor: 'pointer', fontWeight: '600',
          }}
        >
          ← {results.length > 0 ? 'סיים' : 'חזרה'}
        </button>
        <div style={{ textAlign: 'right' }}>
          <div style={{
            fontSize: '0.8rem', fontWeight: '700',
            color: 'var(--primary)',
          }}>
            ⚡ {currentIdx + 1}/{scenarios.length}
          </div>
          {quickModelName && (
            <div style={{ fontSize: '0.5rem', color: 'var(--text-muted)', opacity: 0.6 }}>
              model: {quickModelName}
            </div>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div style={{
        height: '4px', background: 'var(--border)', borderRadius: '2px',
        overflow: 'hidden', marginBottom: '1rem',
      }}>
        <div style={{
          height: '100%', width: `${progress}%`,
          background: 'var(--primary)',
          transition: 'width 0.3s ease',
          borderRadius: '2px',
        }} />
      </div>

      {/* Score dots */}
      {results.length > 0 && (
        <div style={{
          display: 'flex', gap: '0.3rem', justifyContent: 'center',
          marginBottom: '0.75rem',
        }}>
          {results.map((r, i) => (
            <div key={i} style={{
              width: '10px', height: '10px', borderRadius: '50%',
              background: r.correct ? '#22c55e' : '#ef4444',
              opacity: 0.8,
            }} />
          ))}
          {Array.from({ length: Math.max(0, scenarios.length - results.length) }).map((_, i) => (
            <div key={`empty-${i}`} style={{
              width: '10px', height: '10px', borderRadius: '50%',
              background: 'var(--border)',
            }} />
          ))}
        </div>
      )}

      {/* Scenario */}
      <div className="card" style={{
        padding: '1rem 1.25rem',
        borderRight: '3px solid var(--primary)',
      }}>
        {/* Cards */}
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
          padding: '0.25rem 0.6rem', borderRadius: '8px',
          background: 'rgba(99, 102, 241, 0.12)',
          fontSize: '0.9rem', fontWeight: '700',
          marginBottom: '0.75rem', letterSpacing: '2px',
        }}>
          <span style={{ fontSize: '0.55rem', color: 'var(--text-muted)', fontWeight: 500 }}>יד</span>
          <ColoredCards text={scenario.yourCards} />
        </div>

        {/* Situation text — same typography as answer rows */}
        <p style={{
          fontSize: '1.08rem', fontWeight: 600, lineHeight: 1.35,
          color: 'var(--text)', direction: 'rtl',
          margin: 0,
        }}>
          {fixCardBidi(scenario.situation)}
        </p>
      </div>

      {/* Options — גופן גדול יותר לנוחות קריאה במובייל */}
      <div style={{
        display: 'flex', flexDirection: 'column', gap: '0.6rem',
        marginTop: '0.75rem',
      }}>
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
              bgColor = 'rgba(34, 197, 94, 0.1)';
              textColor = '#22c55e';
            } else if (isSelected && !isCorrectOption) {
              borderColor = '#ef4444';
              bgColor = 'rgba(239, 68, 68, 0.1)';
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
                padding: '0.9rem 1.1rem',
                borderRadius: '12px',
                border: `2px solid ${borderColor}`,
                background: bgColor,
                cursor: isRevealed ? 'default' : 'pointer',
                textAlign: 'right', direction: 'rtl',
                transition: 'all 0.2s ease',
                opacity: isRevealed && !isCorrectOption && !isSelected ? 0.5 : 1,
              }}
            >
              <div style={{
                display: 'flex', alignItems: 'center', gap: '0.5rem',
                justifyContent: 'space-between',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
                  <span style={{
                    width: '32px', height: '32px', borderRadius: '50%',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontWeight: '700', fontSize: '0.82rem',
                    background: isRevealed
                      ? (isCorrectOption ? 'rgba(34,197,94,0.2)' : isSelected ? 'rgba(239,68,68,0.2)' : 'var(--surface-light)')
                      : 'var(--surface-light)',
                    color: isRevealed
                      ? (isCorrectOption ? '#22c55e' : isSelected ? '#ef4444' : 'var(--text-muted)')
                      : 'var(--text)',
                  }}>
                    {isRevealed ? (isCorrectOption ? '✓' : isSelected ? '✗' : option.id) : option.id}
                  </span>
                  <span style={{
                    fontWeight: '600', fontSize: '1.08rem', lineHeight: 1.35,
                    color: textColor,
                  }}>
                    {option.text}
                  </span>
                </div>
              </div>

              {/* Explanation */}
              {isRevealed && (isSelected || isCorrectOption) && (
                <div style={{
                  marginTop: '0.5rem', fontSize: '0.92rem', lineHeight: 1.55,
                  color: 'var(--text-muted)', paddingRight: '2rem',
                }}>
                  {fixCardBidi(option.explanation || '')}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {/* Correct answer highlight if wrong */}
      {selectedOption && !scenario.options.find(o => o.id === selectedOption)?.isCorrect && correctOption && (
        <div style={{
          marginTop: '0.5rem', padding: '0.6rem 0.75rem',
          borderRadius: '10px',
          background: 'rgba(34, 197, 94, 0.08)',
          border: '1px solid rgba(34, 197, 94, 0.2)',
          fontSize: '0.92rem', color: 'var(--text-muted)',
          direction: 'rtl', lineHeight: 1.5,
        }}>
          <span style={{ color: '#22c55e', fontWeight: '700' }}>התשובה הנכונה: </span>
          {correctOption.text}{correctOption.explanation ? ` — ${correctOption.explanation}` : ''}
        </div>
      )}

      {/* Next button */}
      {selectedOption && (
        <button
          onClick={handleNext}
          style={{
            width: '100%', padding: '0.85rem', marginTop: '0.75rem',
            borderRadius: '12px', border: 'none',
            background: currentIdx >= scenarios.length - 1
              ? 'linear-gradient(135deg, #6366f1, #4f46e5)'
              : 'linear-gradient(135deg, var(--primary), var(--primary-dark))',
            color: 'white', fontWeight: '700', fontSize: '1rem',
            cursor: 'pointer',
            boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
          }}
        >
          {currentIdx >= scenarios.length - 1 ? 'סיכום ←' : 'הבאה ←'}
        </button>
      )}
    </div>
  );
};

export default QuickTrainingScreen;
