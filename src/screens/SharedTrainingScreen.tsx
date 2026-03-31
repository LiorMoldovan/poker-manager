import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePermissions } from '../App';
import { TrainingPlayerData, TrainingInsightsFile } from '../types';
import {
  SCENARIO_CATEGORIES,
  getSharedProgress,
  getTipsForPlayer,
  TRAINING_BADGES,
  getCategoryExpertBadges,
  generateLeaderboardText,
  flushPendingUploads,
} from '../utils/pokerTraining';
import { fetchTrainingAnswers, fetchTrainingInsights } from '../database/githubSync';

const SharedTrainingScreen = () => {
  const navigate = useNavigate();
  const { playerName } = usePermissions();
  const name = playerName || 'Unknown';

  const [sessionCount, setSessionCount] = useState<number>(10);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [showCategoryPicker, setShowCategoryPicker] = useState(false);
  const [leaderboard, setLeaderboard] = useState<TrainingPlayerData[]>([]);
  const [insights, setInsights] = useState<TrainingInsightsFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [shareMsg, setShareMsg] = useState<string | null>(null);

  const progress = getSharedProgress(name);
  const accuracy = progress.totalQuestions > 0 ? (progress.totalCorrect / progress.totalQuestions) * 100 : 0;
  const tips = getTipsForPlayer(progress);
  const catExpert = getCategoryExpertBadges(progress);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      // Flush any pending uploads first
      await flushPendingUploads();
      const [answersData, insightsData] = await Promise.all([
        fetchTrainingAnswers(),
        fetchTrainingInsights(),
      ]);
      if (answersData) setLeaderboard(answersData.players);
      if (insightsData) setInsights(insightsData);
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleStart = () => {
    const params = new URLSearchParams();
    if (sessionCount) params.set('count', String(sessionCount));
    if (selectedCategories.length > 0) params.set('categories', selectedCategories.join(','));
    navigate(`/shared-training/play?${params.toString()}`);
  };

  const handleShareLeaderboard = () => {
    const text = generateLeaderboardText(leaderboard);
    if (navigator.share) {
      navigator.share({ text }).catch(() => {});
    } else {
      navigator.clipboard.writeText(text).then(() => {
        setShareMsg('הועתק!');
        setTimeout(() => setShareMsg(null), 2000);
      }).catch(() => {});
    }
  };

  const toggleCategory = (catId: string) => {
    setSelectedCategories(prev =>
      prev.includes(catId) ? prev.filter(c => c !== catId) : [...prev, catId]
    );
  };

  const sortedLeaderboard = [...leaderboard]
    .filter(p => p.totalQuestions >= 5)
    .sort((a, b) => b.accuracy - a.accuracy || b.totalQuestions - a.totalQuestions);

  const playerInsight = insights?.insights?.[name];

  const earnedBadges = TRAINING_BADGES.filter(b => progress.earnedBadgeIds.includes(b.id));
  const unearnedBadges = TRAINING_BADGES.filter(b => !progress.earnedBadgeIds.includes(b.id));
  const earnedCatBadges = catExpert.filter(b => b.earned);
  const unearnedCatBadges = catExpert.filter(b => !b.earned);

  return (
    <div className="fade-in" style={{ padding: '1rem', paddingBottom: '6rem', direction: 'rtl' }}>
      {/* Header */}
      <div style={{ textAlign: 'center', padding: '0.5rem 0 1rem' }}>
        <h1 style={{ fontSize: '1.4rem', fontWeight: 800, marginBottom: '0.25rem' }}>
          🎯 אימון פוקר
        </h1>
        <p className="text-muted" style={{ fontSize: '0.85rem' }}>
          שלום {name}! בוא נתאמן
        </p>
      </div>

      {/* Start Training Card */}
      <div className="card" style={{
        padding: '1.25rem',
        background: 'linear-gradient(135deg, rgba(99,102,241,0.12), rgba(168,85,247,0.08))',
        border: '1px solid rgba(99,102,241,0.25)',
      }}>
        {/* Session length pills */}
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '0.4rem' }}>
          מספר שאלות
        </div>
        <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.75rem' }}>
          {[5, 10, 0].map(n => (
            <button
              key={n}
              onClick={() => setSessionCount(n)}
              style={{
                flex: 1, padding: '0.5rem', borderRadius: '10px',
                border: (sessionCount === n) ? '2px solid var(--primary)' : '1px solid var(--border)',
                background: (sessionCount === n) ? 'rgba(99,102,241,0.15)' : 'var(--surface)',
                color: (sessionCount === n) ? 'var(--primary)' : 'var(--text)',
                fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer',
              }}
            >
              {n === 0 ? 'ללא הגבלה' : n}
            </button>
          ))}
        </div>

        {/* Category selection */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 600 }}>נושא</div>
          <button
            onClick={() => setShowCategoryPicker(!showCategoryPicker)}
            style={{
              background: 'none', border: 'none', color: 'var(--primary)',
              fontSize: '0.8rem', cursor: 'pointer', fontWeight: 600,
            }}
          >
            {selectedCategories.length > 0 ? `${selectedCategories.length} נבחרו` : 'אקראי'} {showCategoryPicker ? '▲' : '▼'}
          </button>
        </div>

        {showCategoryPicker && (
          <div style={{
            maxHeight: '200px', overflowY: 'auto', marginBottom: '0.75rem',
            display: 'flex', flexWrap: 'wrap', gap: '0.3rem',
          }}>
            {SCENARIO_CATEGORIES.map(cat => {
              const isSelected = selectedCategories.includes(cat.id);
              return (
                <button
                  key={cat.id}
                  onClick={() => toggleCategory(cat.id)}
                  style={{
                    padding: '0.3rem 0.6rem', borderRadius: '8px', fontSize: '0.7rem',
                    border: isSelected ? '1px solid var(--primary)' : '1px solid var(--border)',
                    background: isSelected ? 'rgba(99,102,241,0.15)' : 'var(--surface)',
                    color: isSelected ? 'var(--primary)' : 'var(--text-muted)',
                    cursor: 'pointer', fontWeight: 500,
                  }}
                >
                  {cat.icon} {cat.name}
                </button>
              );
            })}
            {selectedCategories.length > 0 && (
              <button
                onClick={() => setSelectedCategories([])}
                style={{
                  padding: '0.3rem 0.6rem', borderRadius: '8px', fontSize: '0.7rem',
                  border: '1px solid rgba(239,68,68,0.3)', background: 'rgba(239,68,68,0.08)',
                  color: '#ef4444', cursor: 'pointer', fontWeight: 500,
                }}
              >
                נקה בחירה
              </button>
            )}
          </div>
        )}

        {/* Start button */}
        <button
          onClick={handleStart}
          style={{
            width: '100%', padding: '0.9rem', borderRadius: '14px', border: 'none',
            background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
            color: 'white', fontWeight: 700, fontSize: '1.1rem', cursor: 'pointer',
            boxShadow: '0 4px 16px rgba(99,102,241,0.3)',
          }}
        >
          🎯 התחל אימון
        </button>
      </div>

      {/* Quick stats */}
      {progress.totalQuestions > 0 && (
        <div style={{
          display: 'flex', gap: '0.5rem', marginTop: '0.75rem',
        }}>
          <div className="card" style={{ flex: 1, padding: '0.75rem', textAlign: 'center' }}>
            <div style={{ fontSize: '1.3rem', fontWeight: 800 }}>{progress.totalQuestions}</div>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>שאלות</div>
          </div>
          <div className="card" style={{ flex: 1, padding: '0.75rem', textAlign: 'center' }}>
            <div style={{ fontSize: '1.3rem', fontWeight: 800, color: accuracy >= 60 ? '#22c55e' : accuracy >= 40 ? '#eab308' : '#ef4444' }}>
              {accuracy.toFixed(0)}%
            </div>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>דיוק</div>
          </div>
          <div className="card" style={{ flex: 1, padding: '0.75rem', textAlign: 'center' }}>
            <div style={{ fontSize: '1.3rem', fontWeight: 800 }}>
              {progress.streak.current > 0 ? `🔥${progress.streak.current}` : '—'}
            </div>
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>רצף ימים</div>
          </div>
        </div>
      )}

      {/* Leaderboard */}
      <div className="card" style={{ padding: '1rem', marginTop: '0.75rem' }}>
        <div style={{ fontWeight: 700, fontSize: '0.9rem', marginBottom: '0.6rem' }}>🏆 טבלת מובילים</div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '1rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>טוען...</div>
        ) : sortedLeaderboard.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '0.75rem', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
            עוד אין מספיק נתונים (מינימום 5 שאלות)
          </div>
        ) : (
          <div>
            {sortedLeaderboard.map((player, i) => {
              const medals = ['🥇', '🥈', '🥉'];
              const isMe = player.playerName === name;
              return (
                <div key={player.playerName} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '0.5rem 0.4rem', borderRadius: '8px',
                  background: isMe ? 'rgba(99,102,241,0.1)' : 'transparent',
                  border: isMe ? '1px solid rgba(99,102,241,0.2)' : '1px solid transparent',
                  marginBottom: '0.25rem',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <span style={{ width: '24px', textAlign: 'center', fontSize: '0.9rem' }}>
                      {medals[i] || `${i + 1}`}
                    </span>
                    <span style={{ fontWeight: isMe ? 700 : 500, fontSize: '0.85rem' }}>
                      {player.playerName}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      {player.totalQuestions} Qs
                    </span>
                    <span style={{
                      fontWeight: 700, fontSize: '0.85rem',
                      color: player.accuracy >= 60 ? '#22c55e' : player.accuracy >= 40 ? '#eab308' : '#ef4444',
                    }}>
                      {player.accuracy.toFixed(0)}%
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {sortedLeaderboard.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: '0.75rem', paddingTop: '0.5rem', borderTop: '1px solid var(--border)' }}>
            <button
              onClick={handleShareLeaderboard}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem',
                fontSize: '0.75rem', padding: '0.4rem 0.8rem',
                background: 'var(--surface)', color: 'var(--text-muted)',
                border: '1px solid var(--border)', borderRadius: '6px', cursor: 'pointer',
              }}
            >
              {shareMsg || '📤 שתף'}
            </button>
          </div>
        )}
      </div>

      {/* Weak spots + tips */}
      {tips.length > 0 && (
        <div className="card" style={{
          padding: '1rem', marginTop: '0.75rem',
          background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.15)',
        }}>
          <div style={{ fontWeight: 700, fontSize: '0.85rem', marginBottom: '0.5rem' }}>
            📍 נקודות לשיפור
          </div>
          {tips.map(t => (
            <div key={t.categoryId} style={{ marginBottom: '0.6rem' }}>
              <div style={{ fontWeight: 600, fontSize: '0.8rem', marginBottom: '0.2rem', color: '#f87171' }}>
                {SCENARIO_CATEGORIES.find(c => c.id === t.categoryId)?.icon} {t.categoryName}
              </div>
              {t.tips.map((tip, i) => (
                <div key={i} style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: '0.15rem' }}>
                  • {tip}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Badges */}
      {(earnedBadges.length > 0 || progress.totalQuestions > 0) && (
        <div className="card" style={{ padding: '1rem', marginTop: '0.75rem' }}>
          <div style={{ fontWeight: 700, fontSize: '0.85rem', marginBottom: '0.5rem' }}>
            🏅 הישגים
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
            {earnedBadges.map(b => (
              <div key={b.id} title={b.description} style={{
                padding: '0.3rem 0.6rem', borderRadius: '10px',
                background: 'rgba(168,85,247,0.12)', border: '1px solid rgba(168,85,247,0.25)',
                fontSize: '0.75rem', fontWeight: 600,
              }}>
                {b.icon} {b.name}
              </div>
            ))}
            {earnedCatBadges.map(b => (
              <div key={b.id} style={{
                padding: '0.3rem 0.6rem', borderRadius: '10px',
                background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)',
                fontSize: '0.75rem', fontWeight: 600,
              }}>
                {b.icon} {b.name}
              </div>
            ))}
            {unearnedBadges.map(b => (
              <div key={b.id} title={b.description} style={{
                padding: '0.3rem 0.6rem', borderRadius: '10px',
                background: 'var(--surface-light)', border: '1px solid var(--border)',
                fontSize: '0.75rem', fontWeight: 500, opacity: 0.4,
              }}>
                {b.icon} {b.name}
              </div>
            ))}
            {unearnedCatBadges.slice(0, 5).map(b => (
              <div key={b.id} style={{
                padding: '0.3rem 0.6rem', borderRadius: '10px',
                background: 'var(--surface-light)', border: '1px solid var(--border)',
                fontSize: '0.75rem', fontWeight: 500, opacity: 0.4,
              }}>
                {b.icon} {b.name}
              </div>
            ))}
            {unearnedCatBadges.length > 5 && (
              <div style={{ padding: '0.3rem 0.6rem', fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                +{unearnedCatBadges.length - 5} נוספים
              </div>
            )}
          </div>
        </div>
      )}

      {/* AI Insight card */}
      {playerInsight && (
        <div className="card" style={{
          padding: '1rem', marginTop: '0.75rem',
          background: 'rgba(168,85,247,0.06)', border: '1px solid rgba(168,85,247,0.2)',
        }}>
          <div style={{ fontWeight: 700, fontSize: '0.85rem', marginBottom: '0.4rem', color: '#a855f7' }}>
            ✨ תובנות אישיות
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
            {playerInsight.improvement}
          </div>
          <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: '0.3rem', opacity: 0.5 }}>
            עודכן: {new Date(playerInsight.generatedAt).toLocaleDateString('he-IL')}
          </div>
        </div>
      )}

      {/* Back button */}
      <button
        onClick={() => navigate('/')}
        style={{
          width: '100%', marginTop: '1rem', padding: '0.7rem',
          borderRadius: '10px', border: '1px solid var(--border)',
          background: 'var(--surface)', color: 'var(--text)',
          fontWeight: 600, fontSize: '0.85rem', cursor: 'pointer',
        }}
      >
        ← חזרה לדף הראשי
      </button>
    </div>
  );
};

export default SharedTrainingScreen;
