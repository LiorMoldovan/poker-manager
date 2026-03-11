import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  SCENARIO_CATEGORIES,
  getTrainingProgress,
  getOverallAccuracy,
  getAccuracyTrend,
  getWeakCategories,
} from '../utils/pokerTraining';
import { getGeminiApiKey } from '../utils/geminiAI';

const SESSION_OPTIONS = [
  { id: 3, label: '3 ידיים' },
  { id: 5, label: '5 ידיים' },
  { id: 0, label: 'ללא הגבלה' },
];

const TrainingScreen = () => {
  const navigate = useNavigate();
  const [sessionLength, setSessionLength] = useState<number>(5);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [showCategories, setShowCategories] = useState(false);

  const progress = getTrainingProgress();
  const overallAccuracy = getOverallAccuracy();
  const trend = getAccuracyTrend();
  const weakCats = getWeakCategories();
  const hasApiKey = !!getGeminiApiKey();

  const totalSessions = progress.sessions.length;
  const recentTrend = trend.length >= 2
    ? trend[trend.length - 1] - trend[trend.length - 2]
    : 0;

  const toggleCategory = (catId: string) => {
    setSelectedCategories(prev =>
      prev.includes(catId) ? prev.filter(id => id !== catId) : [...prev, catId]
    );
  };

  const startSession = (quickCategoryId?: string) => {
    const cats = quickCategoryId ? [quickCategoryId] : selectedCategories;
    const params = new URLSearchParams({
      difficulty: 'hard',
      maxHands: sessionLength.toString(),
      ...(cats.length > 0 ? { categories: cats.join(',') } : {}),
    });
    navigate(`/training/play?${params.toString()}`);
  };

  const getCategoryAccuracy = (catId: string): number | null => {
    const data = progress.byCategory[catId];
    if (!data || data.total < 1) return null;
    return ((data.best + data.good) / data.total) * 100;
  };

  const getAccuracyColor = (acc: number): string => {
    if (acc >= 70) return '#22c55e';
    if (acc >= 50) return '#f59e0b';
    return '#ef4444';
  };

  if (!hasApiKey) {
    return (
      <div className="fade-in" style={{ textAlign: 'center', padding: '3rem' }}>
        <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🔑</div>
        <h2 style={{ marginBottom: '0.5rem' }}>נדרש מפתח</h2>
        <p className="text-muted" style={{ marginBottom: '1.5rem' }}>
          כדי להשתמש באימון, הגדר מפתח בהגדרות
        </p>
        <button className="btn btn-primary" onClick={() => navigate('/settings')}>
          הגדרות
        </button>
      </div>
    );
  }

  const hasData = progress.totalDecisions > 0;

  return (
    <div className="fade-in" style={{ paddingBottom: '6rem' }}>
      <div className="page-header">
        <h1 className="page-title">אימון פוקר</h1>
        <p className="page-subtitle">תרגול סיטואציות מותאם לשולחן שלך</p>
      </div>

      {/* Stats row - only when data exists */}
      {hasData && (
        <div style={{
          display: 'flex',
          gap: '0.5rem',
          marginBottom: '0.75rem',
        }}>
          <div style={{
            flex: 1,
            padding: '0.6rem',
            borderRadius: '10px',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            textAlign: 'center',
          }}>
            <div style={{
              fontSize: '1.3rem',
              fontWeight: '800',
              color: overallAccuracy >= 50 ? 'var(--success)' : 'var(--danger)',
            }}>
              {overallAccuracy.toFixed(0)}%
            </div>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: '600' }}>דיוק</div>
          </div>
          <div style={{
            flex: 1,
            padding: '0.6rem',
            borderRadius: '10px',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            textAlign: 'center',
          }}>
            <div style={{ fontSize: '1.3rem', fontWeight: '800', color: 'var(--text)' }}>
              {progress.totalDecisions}
            </div>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: '600' }}>החלטות</div>
          </div>
          <div style={{
            flex: 1,
            padding: '0.6rem',
            borderRadius: '10px',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            textAlign: 'center',
          }}>
            <div style={{ fontSize: '1.3rem', fontWeight: '800', color: 'var(--text)' }}>
              {totalSessions}
            </div>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: '600' }}>סשנים</div>
          </div>
          {trend.length >= 2 && (
            <div style={{
              flex: 1,
              padding: '0.6rem',
              borderRadius: '10px',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              textAlign: 'center',
            }}>
              <div style={{
                fontSize: '1.3rem',
                fontWeight: '800',
                color: recentTrend >= 0 ? 'var(--success)' : 'var(--danger)',
              }}>
                {recentTrend >= 0 ? '↑' : '↓'}
              </div>
              <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: '600' }}>מגמה</div>
            </div>
          )}
        </div>
      )}

      {/* Mini trend chart */}
      {trend.length >= 3 && (
        <div style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: '3px',
          height: '35px',
          marginBottom: '0.75rem',
          padding: '0 0.25rem',
        }}>
          {trend.map((acc, i) => (
            <div
              key={i}
              style={{
                flex: 1,
                height: `${Math.max(10, acc)}%`,
                background: `${getAccuracyColor(acc)}80`,
                borderRadius: '3px 3px 0 0',
                transition: 'height 0.3s ease',
                minHeight: '4px',
              }}
            />
          ))}
        </div>
      )}

      {/* Session length */}
      <div style={{
        display: 'flex',
        gap: '0.4rem',
        marginBottom: '0.5rem',
      }}>
        {SESSION_OPTIONS.map(opt => (
          <button
            key={opt.id}
            onClick={() => setSessionLength(opt.id)}
            style={{
              flex: 1,
              padding: '0.5rem',
              borderRadius: '10px',
              border: sessionLength === opt.id ? '2px solid var(--primary)' : '1px solid var(--border)',
              background: sessionLength === opt.id ? 'rgba(16, 185, 129, 0.12)' : 'var(--surface)',
              color: sessionLength === opt.id ? 'var(--primary)' : 'var(--text-muted)',
              cursor: 'pointer',
              fontWeight: '600',
              fontSize: '0.8rem',
              transition: 'all 0.15s ease',
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Start button */}
      <button
        onClick={() => startSession()}
        style={{
          width: '100%',
          padding: '0.85rem',
          borderRadius: '14px',
          border: 'none',
          background: 'linear-gradient(135deg, var(--primary), var(--primary-dark))',
          color: 'white',
          fontWeight: '700',
          fontSize: '1rem',
          cursor: 'pointer',
          boxShadow: '0 3px 12px rgba(16, 185, 129, 0.3)',
          marginBottom: '0.75rem',
        }}
      >
        התחל אימון
      </button>

      {/* Weak Spots */}
      {weakCats.length > 0 && (
        <div className="card" style={{
          padding: '0.75rem 1rem',
          background: 'rgba(239, 68, 68, 0.1)',
          border: '1px solid rgba(239, 68, 68, 0.3)',
        }}>
          <div style={{ fontSize: '0.8rem', fontWeight: '700', color: '#ef4444', marginBottom: '0.4rem' }}>
            נקודות חולשה שזוהו
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
            {weakCats.map(catId => {
              const cat = SCENARIO_CATEGORIES.find(c => c.id === catId);
              if (!cat) return null;
              return (
                <button
                  key={catId}
                  onClick={() => startSession(catId)}
                  style={{
                    background: 'rgba(239, 68, 68, 0.15)',
                    border: '1px solid rgba(239, 68, 68, 0.4)',
                    color: '#fca5a5',
                    padding: '0.3rem 0.6rem',
                    borderRadius: '12px',
                    fontSize: '0.75rem',
                    fontWeight: '600',
                    cursor: 'pointer',
                  }}
                >
                  {cat.icon} {cat.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Topics overview - always visible as compact pills */}
      <div className="card" style={{ padding: '0.75rem 1rem' }}>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '0.5rem',
        }}>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: '600' }}>
            נושאים באימון
          </span>
          {selectedCategories.length > 0 && (
            <span
              onClick={() => setSelectedCategories([])}
              style={{
                fontSize: '0.7rem',
                color: 'var(--primary)',
                fontWeight: '600',
                cursor: 'pointer',
              }}
            >
              נקה סינון ({selectedCategories.length})
            </span>
          )}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
          {SCENARIO_CATEGORIES.map(cat => {
            const accuracy = getCategoryAccuracy(cat.id);
            const isSelected = selectedCategories.includes(cat.id);
            const isWeak = weakCats.includes(cat.id);

            return (
              <button
                key={cat.id}
                onClick={() => toggleCategory(cat.id)}
                style={{
                  padding: '0.3rem 0.55rem',
                  borderRadius: '14px',
                  border: isSelected
                    ? '1.5px solid var(--primary)'
                    : isWeak
                      ? '1.5px solid rgba(239, 68, 68, 0.4)'
                      : '1px solid var(--border)',
                  background: isSelected
                    ? 'rgba(16, 185, 129, 0.15)'
                    : 'transparent',
                  cursor: 'pointer',
                  fontSize: '0.7rem',
                  fontWeight: '600',
                  color: isSelected ? 'var(--primary)' : isWeak ? '#fca5a5' : 'var(--text-muted)',
                  transition: 'all 0.15s ease',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.25rem',
                  whiteSpace: 'nowrap',
                }}
              >
                <span>{cat.icon}</span>
                <span>{cat.name}</span>
                {accuracy !== null && (
                  <span style={{
                    fontSize: '0.6rem',
                    fontWeight: '700',
                    color: getAccuracyColor(accuracy),
                    marginRight: '0.1rem',
                  }}>
                    {accuracy.toFixed(0)}%
                  </span>
                )}
              </button>
            );
          })}
        </div>
        {!hasData && (
          <div style={{
            fontSize: '0.7rem',
            color: 'var(--text-muted)',
            marginTop: '0.5rem',
            lineHeight: 1.5,
            direction: 'rtl',
          }}>
            לחץ על נושא כדי לסנן, או התחל אימון ותקבל מיקס של הכל
          </div>
        )}
      </div>

      {/* Expanded categories detail - toggle */}
      {showCategories && (
        <div className="card" style={{ padding: '0.75rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.5rem' }}>
            {SCENARIO_CATEGORIES.map(cat => {
              const accuracy = getCategoryAccuracy(cat.id);
              const isWeak = weakCats.includes(cat.id);
              const isSelected = selectedCategories.includes(cat.id);
              const catData = progress.byCategory[cat.id];

              return (
                <button
                  key={cat.id}
                  onClick={() => toggleCategory(cat.id)}
                  style={{
                    padding: '0.6rem',
                    borderRadius: '10px',
                    border: isSelected
                      ? '2px solid var(--primary)'
                      : isWeak
                        ? '2px solid rgba(239, 68, 68, 0.4)'
                        : '1px solid var(--border)',
                    background: isSelected
                      ? 'rgba(16, 185, 129, 0.12)'
                      : isWeak
                        ? 'rgba(239, 68, 68, 0.08)'
                        : 'var(--surface)',
                    cursor: 'pointer',
                    textAlign: 'right',
                    transition: 'all 0.15s ease',
                    position: 'relative',
                    overflow: 'hidden',
                  }}
                >
                  {isSelected && (
                    <div style={{
                      position: 'absolute',
                      top: '4px',
                      left: '4px',
                      width: '16px',
                      height: '16px',
                      borderRadius: '50%',
                      background: 'var(--primary)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '0.55rem',
                      color: 'white',
                      fontWeight: '800',
                    }}>
                      ✓
                    </div>
                  )}
                  {accuracy !== null && (
                    <div style={{
                      position: 'absolute',
                      bottom: 0,
                      left: 0,
                      height: '3px',
                      width: `${accuracy}%`,
                      background: getAccuracyColor(accuracy),
                      borderRadius: '0 0 0 10px',
                    }} />
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.2rem' }}>
                    <span style={{ fontSize: '1rem' }}>{cat.icon}</span>
                    <span style={{
                      fontWeight: '700',
                      fontSize: '0.75rem',
                      color: isSelected ? 'var(--primary)' : 'var(--text)',
                      flex: 1,
                      textAlign: 'right',
                    }}>
                      {cat.name}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                      {cat.description.slice(0, 30)}...
                    </span>
                    {catData && catData.total > 0 && (
                      <span style={{
                        fontSize: '0.65rem',
                        fontWeight: '700',
                        color: accuracy !== null ? getAccuracyColor(accuracy) : 'var(--text-muted)',
                      }}>
                        {accuracy?.toFixed(0)}%
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Detail toggle */}
      <button
        onClick={() => setShowCategories(!showCategories)}
        style={{
          width: '100%',
          padding: '0.5rem',
          background: 'none',
          border: 'none',
          color: 'var(--text-muted)',
          fontSize: '0.7rem',
          fontWeight: '600',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.3rem',
        }}
      >
        {showCategories ? 'הסתר פירוט ▲' : 'הצג פירוט קטגוריות ▼'}
      </button>

      {/* Last Sessions */}
      {progress.sessions.length > 0 && (
        <div className="card" style={{ padding: '1rem' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem', fontWeight: '600' }}>
            סשנים אחרונים
          </div>
          {progress.sessions.slice(-5).reverse().map((session, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: '0.4rem 0',
                borderBottom: i < Math.min(progress.sessions.length, 5) - 1 ? '1px solid var(--border)' : 'none',
              }}
            >
              <span style={{ fontSize: '0.8rem', color: 'var(--text)' }}>
                {session.handsPlayed} ידיים
              </span>
              <span style={{
                fontWeight: '700',
                fontSize: '0.85rem',
                color: session.accuracy >= 50 ? 'var(--success)' : 'var(--danger)',
              }}>
                {session.accuracy.toFixed(0)}%
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default TrainingScreen;
