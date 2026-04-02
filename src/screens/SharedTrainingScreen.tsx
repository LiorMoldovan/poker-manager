import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import html2canvas from 'html2canvas';
import { usePermissions } from '../App';
import { TrainingPlayerData, SharedTrainingProgress } from '../types';
import {
  SCENARIO_CATEGORIES,
  getSharedProgress,
  TRAINING_BADGES,
  getCategoryExpertBadges,
  flushPendingUploads,
  rebuildProgressFromRemote,
  CATEGORY_TIPS,
} from '../utils/pokerTraining';
import { fetchTrainingAnswers } from '../database/githubSync';

const ME_BG = 'rgba(59, 130, 246, 0.14)';
const ME_NAME_COLOR = '#60a5fa';
const meRowStyle = { background: ME_BG, borderRight: '3px solid #3b82f6' } as const;
const meNameStyle = { color: ME_NAME_COLOR } as const;

const SharedTrainingScreen = () => {
  const navigate = useNavigate();
  const { playerName } = usePermissions();
  const name = playerName || 'Unknown';

  const [sessionCount, setSessionCount] = useState<number>(10);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [showCategoryPicker, setShowCategoryPicker] = useState(false);
  const [leaderboard, setLeaderboard] = useState<TrainingPlayerData[]>([]);
  const [remoteProgress, setRemoteProgress] = useState<SharedTrainingProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [isSharing, setIsSharing] = useState(false);
  const leaderboardRef = useRef<HTMLDivElement>(null);

  const localProgress = getSharedProgress(name);
  const progress = useMemo(() => {
    if (localProgress.totalQuestions > 0) return localProgress;
    if (remoteProgress && remoteProgress.totalQuestions > 0) return remoteProgress;
    return localProgress;
  }, [localProgress, remoteProgress]);

  const catExpert = getCategoryExpertBadges(progress);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      await flushPendingUploads();
      const answersData = await fetchTrainingAnswers();
      if (answersData) {
        setLeaderboard(answersData.players);
        const myRemoteData = answersData.players.find(p => p.playerName === name);
        if (myRemoteData && myRemoteData.totalQuestions > 0) {
          setRemoteProgress(rebuildProgressFromRemote(myRemoteData));
        }
      }
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }, [name]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleStart = () => {
    const params = new URLSearchParams();
    if (sessionCount) params.set('count', String(sessionCount));
    if (selectedCategories.length > 0) params.set('categories', selectedCategories.join(','));
    navigate(`/shared-training/play?${params.toString()}`);
  };

  const handleShareLeaderboard = async () => {
    if (!leaderboardRef.current) return;
    setIsSharing(true);
    try {
      const canvas = await html2canvas(leaderboardRef.current, {
        backgroundColor: '#1a1a2e',
        scale: 2,
      });
      canvas.toBlob(async (blob) => {
        if (!blob) { setIsSharing(false); return; }
        const file = new File([blob], 'poker-training-leaderboard.png', { type: 'image/png' });
        if (navigator.share && navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({ files: [file], title: 'Poker Training Leaderboard' });
          } catch {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = 'poker-training-leaderboard.png'; a.click();
            URL.revokeObjectURL(url);
          }
        } else {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = 'poker-training-leaderboard.png'; a.click();
          URL.revokeObjectURL(url);
        }
        setIsSharing(false);
      }, 'image/png');
    } catch {
      setIsSharing(false);
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

  const earnedBadges = TRAINING_BADGES.filter(b => progress.earnedBadgeIds.includes(b.id));
  const unearnedBadges = TRAINING_BADGES.filter(b => !progress.earnedBadgeIds.includes(b.id));
  const earnedCatBadges = catExpert.filter(b => b.earned);
  const unearnedCatBadges = catExpert.filter(b => !b.earned);

  // Build insights data
  const hasProgress = progress.totalQuestions > 0;
  const catEntries = Object.entries(progress.byCategory).filter(([, v]) => v.total >= 3);
  const sortedByAcc = [...catEntries].sort((a, b) => (a[1].correct / a[1].total) - (b[1].correct / b[1].total));
  const bestCatEntry = catEntries.length > 0
    ? [...catEntries].sort((a, b) => (b[1].correct / b[1].total) - (a[1].correct / a[1].total))[0]
    : null;
  const bestCat = bestCatEntry ? SCENARIO_CATEGORIES.find(c => c.id === bestCatEntry[0]) : null;
  const bestAcc = bestCatEntry ? Math.round((bestCatEntry[1].correct / bestCatEntry[1].total) * 100) : 0;
  const bestCatTip = bestCatEntry ? (CATEGORY_TIPS[bestCatEntry[0]] || [])[1] || (CATEGORY_TIPS[bestCatEntry[0]] || [])[0] || null : null;

  // Up to 2 weak categories (below 50% accuracy) with their tips
  const weakCats = sortedByAcc
    .filter(([, v]) => (v.correct / v.total) < 0.5)
    .slice(0, 2)
    .map(([catId, data]) => {
      const cat = SCENARIO_CATEGORIES.find(c => c.id === catId);
      const acc = Math.round((data.correct / data.total) * 100);
      const wrong = data.total - data.correct;
      const catTips = CATEGORY_TIPS[catId] || [];
      return { catId, cat, acc, wrong, total: data.total, tip: catTips[0] || null };
    });

  const hasCatSpread = bestCat && weakCats.length > 0;

  return (
    <div className="fade-in" style={{ paddingBottom: '5rem' }}>
      <div className="page-header">
        <h1 className="page-title">אימון פוקר</h1>
        <p className="page-subtitle">שלום {name}</p>
      </div>

      {/* Game style note */}
      <div style={{
        padding: '0.5rem 0.75rem', borderRadius: '8px', marginBottom: '0.5rem',
        background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.15)',
        fontSize: '0.7rem', color: 'var(--text-muted)', lineHeight: 1.6, direction: 'rtl',
      }}>
        💡 השאלות מותאמות למשחק ביתי חברתי — בלופים עובדים פחות, שחקנים קוראים הרבה, והתשובות מתחשבות בסגנון שלנו ולא בפוקר מקצועי
      </div>

      {/* Start Training */}
      <div className="card" style={{ padding: '0.75rem' }}>
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '0.4rem' }}>
          מספר שאלות
        </div>
        <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.6rem' }}>
          {[5, 10, 0].map(n => (
            <button
              key={n}
              onClick={() => setSessionCount(n)}
              className={`btn btn-sm ${sessionCount === n ? 'btn-primary' : 'btn-secondary'}`}
              style={{ flex: 1, padding: '0.45rem', fontSize: '0.8rem' }}
            >
              {n === 0 ? 'ללא הגבלה' : n}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 600 }}>נושא</div>
          <button
            onClick={() => setShowCategoryPicker(!showCategoryPicker)}
            style={{
              background: 'none', border: 'none', color: 'var(--primary)',
              fontSize: '0.75rem', cursor: 'pointer', fontWeight: 600,
            }}
          >
            {selectedCategories.length > 0 ? `${selectedCategories.length} נבחרו` : 'אקראי'} {showCategoryPicker ? '▲' : '▼'}
          </button>
        </div>

        {showCategoryPicker && (
          <div style={{
            maxHeight: '180px', overflowY: 'auto', marginBottom: '0.5rem',
            display: 'flex', flexWrap: 'wrap', gap: '0.25rem',
          }}>
            {SCENARIO_CATEGORIES.map(cat => {
              const isSelected = selectedCategories.includes(cat.id);
              return (
                <button
                  key={cat.id}
                  onClick={() => toggleCategory(cat.id)}
                  className={`btn btn-sm ${isSelected ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ padding: '0.25rem 0.5rem', fontSize: '0.65rem' }}
                >
                  {cat.icon} {cat.name}
                </button>
              );
            })}
            {selectedCategories.length > 0 && (
              <button
                onClick={() => setSelectedCategories([])}
                className="btn btn-sm"
                style={{ padding: '0.25rem 0.5rem', fontSize: '0.65rem', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)' }}
              >
                ✕ נקה
              </button>
            )}
          </div>
        )}

        <button className="btn btn-primary" onClick={handleStart} style={{ width: '100%', padding: '0.65rem', fontSize: '0.95rem' }}>
          🎯 התחל אימון
        </button>
      </div>

      {/* Leaderboard — table style like Statistics */}
      <div ref={leaderboardRef} className="card" style={{ padding: '0.75rem', marginTop: '0.5rem' }}>
        <div style={{ fontWeight: 700, fontSize: '0.8rem', marginBottom: '0.5rem' }}>🏆 טבלת מובילים</div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '0.75rem', color: 'var(--text-muted)', fontSize: '0.8rem' }}>טוען...</div>
        ) : sortedLeaderboard.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '0.5rem', color: 'var(--text-muted)', fontSize: '0.75rem' }}>
            עוד אין מספיק נתונים (מינימום 5 שאלות)
          </div>
        ) : (
          <table style={{ width: '100%', fontSize: '0.8rem', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                <th style={{ padding: '0.3rem 0.2rem', whiteSpace: 'nowrap', width: '24px' }}>#</th>
                <th style={{ padding: '0.3rem 0.2rem', whiteSpace: 'nowrap', textAlign: 'left' }}>שחקן</th>
                <th style={{ padding: '0.3rem 0.2rem', textAlign: 'center', whiteSpace: 'nowrap' }}>שאלות</th>
                <th style={{ padding: '0.3rem 0.2rem', textAlign: 'center', whiteSpace: 'nowrap' }}>דיוק</th>
              </tr>
            </thead>
            <tbody>
              {sortedLeaderboard.map((player, i) => {
                const isMe = player.playerName === name;
                return (
                  <tr key={player.playerName} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)', ...(isMe ? meRowStyle : {}) }}>
                    <td style={{ padding: '0.3rem 0.2rem', whiteSpace: 'nowrap' }}>
                      {i + 1}{i < 3 ? ` ${['🥇', '🥈', '🥉'][i]}` : ''}
                    </td>
                    <td style={{ padding: '0.3rem 0.2rem', textAlign: 'left', fontWeight: isMe ? 700 : 500, ...(isMe ? meNameStyle : {}) }}>
                      {player.playerName}
                    </td>
                    <td style={{ padding: '0.3rem 0.2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                      {player.totalQuestions}
                    </td>
                    <td style={{
                      padding: '0.3rem 0.2rem', textAlign: 'center', fontWeight: 700,
                      color: player.accuracy >= 60 ? 'var(--success)' : player.accuracy >= 40 ? '#eab308' : 'var(--danger)',
                    }}>
                      {player.accuracy.toFixed(0)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {sortedLeaderboard.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: '0.5rem' }}>
          <button
            onClick={handleShareLeaderboard}
            disabled={isSharing}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem',
              fontSize: '0.75rem', padding: '0.4rem 0.8rem',
              background: 'var(--surface)', color: 'var(--text-muted)',
              border: '1px solid var(--border)', borderRadius: '6px', cursor: 'pointer',
            }}
          >
            {isSharing ? '📸...' : '📤 שתף טבלה'}
          </button>
        </div>
      )}

      {/* Player insights — below table */}
      {hasProgress && (hasCatSpread || weakCats.length > 0) && (
        <div className="card" style={{ padding: '0.75rem', marginTop: '0.5rem', direction: 'rtl' }}>
          <div style={{ fontWeight: 700, fontSize: '0.8rem', marginBottom: '0.5rem', color: 'var(--primary)' }}>
            📋 תובנות אימון
          </div>

          {/* Strength / Weakness compact headers */}
          {hasCatSpread && (
            <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.5rem' }}>
              <div style={{
                flex: 1, padding: '0.35rem 0.5rem', borderRadius: '8px',
                background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.15)',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.6rem', color: 'var(--success)', fontWeight: 600 }}>חוזק</span>
                  <span style={{ fontSize: '0.7rem', color: 'var(--success)', fontWeight: 700 }}>{bestAcc}%</span>
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text)', fontWeight: 600, marginTop: '0.1rem' }}>
                  {bestCat!.icon} {bestCat!.name}
                </div>
              </div>
              <div style={{
                flex: 1, padding: '0.35rem 0.5rem', borderRadius: '8px',
                background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.6rem', color: 'var(--danger)', fontWeight: 600 }}>לשפר</span>
                  <span style={{ fontSize: '0.7rem', color: 'var(--danger)', fontWeight: 700 }}>{weakCats[0]?.acc ?? 0}%</span>
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text)', fontWeight: 600, marginTop: '0.1rem' }}>
                  {weakCats[0]?.cat?.icon} {weakCats[0]?.cat?.name}
                </div>
              </div>
            </div>
          )}

          {/* Strength tip */}
          {bestCatTip && (
            <div style={{
              padding: '0.4rem 0.5rem', borderRadius: '8px', marginBottom: '0.4rem',
              background: 'rgba(34,197,94,0.04)', borderRight: '3px solid var(--success)',
            }}>
              <div style={{ fontSize: '0.65rem', color: 'var(--success)', fontWeight: 600, marginBottom: '0.15rem' }}>
                {bestCat?.icon} {bestCat?.name}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text)', lineHeight: 1.6, paddingRight: '0.1rem' }}>
                {bestCatTip}
              </div>
            </div>
          )}

          {/* Weak categories with actionable tips */}
          {weakCats.map(wc => (
            <div key={wc.catId} style={{
              padding: '0.4rem 0.5rem', borderRadius: '8px', marginBottom: '0.4rem',
              background: 'rgba(239,68,68,0.04)', borderRight: '3px solid var(--danger)',
            }}>
              <div style={{ fontSize: '0.65rem', color: 'var(--danger)', fontWeight: 600, marginBottom: '0.15rem' }}>
                {wc.cat?.icon} {wc.cat?.name} — {wc.wrong} טעויות מ-{wc.total}
              </div>
              {wc.tip && (
                <div style={{ fontSize: '0.7rem', color: 'var(--text)', lineHeight: 1.6, paddingRight: '0.1rem' }}>
                  {wc.tip}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Badges */}
      {progress.totalQuestions > 0 && (() => {
        const allEarned = [...earnedBadges, ...earnedCatBadges];
        const totalPossible = TRAINING_BADGES.length + catExpert.length;
        const lockedCount = unearnedBadges.length + unearnedCatBadges.length;
        return (
          <div className="card" style={{ padding: '0.75rem', marginTop: '0.5rem', direction: 'rtl' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
              <span style={{ fontWeight: 700, fontSize: '0.8rem' }}>🏅 הישגים</span>
              <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
                {allEarned.length}/{totalPossible}
              </span>
            </div>

            {allEarned.length > 0 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginBottom: lockedCount > 0 ? '0.4rem' : 0 }}>
                {earnedBadges.map(b => (
                  <span key={b.id} title={b.description} style={{
                    padding: '0.2rem 0.5rem', borderRadius: '6px',
                    background: 'rgba(168,85,247,0.1)', border: '1px solid rgba(168,85,247,0.2)',
                    fontSize: '0.7rem', fontWeight: 600,
                  }}>
                    {b.icon} {b.name}
                  </span>
                ))}
                {earnedCatBadges.map(b => (
                  <span key={b.id} style={{
                    padding: '0.2rem 0.5rem', borderRadius: '6px',
                    background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.15)',
                    fontSize: '0.7rem', fontWeight: 600,
                  }}>
                    {b.icon} {b.name}
                  </span>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
                עוד אין הישגים — תמשיך להתאמן!
              </div>
            )}

            {lockedCount > 0 && (
              <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                🔒 {lockedCount} הישגים נוספים לפתיחה
              </div>
            )}
          </div>
        );
      })()}

      {/* Back button */}
      <button
        onClick={() => navigate('/')}
        className="btn btn-secondary"
        style={{ width: '100%', marginTop: '0.75rem', padding: '0.6rem', fontSize: '0.8rem' }}
      >
        ← חזרה לדף הראשי
      </button>
    </div>
  );
};

export default SharedTrainingScreen;
