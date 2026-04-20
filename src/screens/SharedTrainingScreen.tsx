import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { captureAndSplit, shareFiles } from '../utils/sharing';
import { usePermissions, LEGACY_NAME_CORRECTIONS } from '../App';
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh';
import { TrainingPlayerData, SharedTrainingProgress } from '../types';
import {
  SCENARIO_CATEGORIES,
  getSharedProgress,
  saveSharedProgress,
  TRAINING_BADGES,
  getCategoryExpertBadges,
  flushPendingUploads,
  rebuildProgressFromRemote,
  CATEGORY_TIPS,
  normalizeTrainingPlayers,
  getPoolCounts,
  updatePoolCache,
  getTrainingSessionCounts,
  resetSharedTrainingProgress,
  clearPendingUploadsForPlayer,
} from '../utils/pokerTraining';
import { fetchTrainingAnswers, fetchTrainingInsights, fetchTrainingPool } from '../database/trainingData';

type LeaderboardRow = TrainingPlayerData & { neutral: number };

const isSharedTrainingMe = (p: TrainingPlayerData, myName: string): boolean => {
  const displayName = LEGACY_NAME_CORRECTIONS[p.playerName] || p.playerName;
  return p.playerName === myName || displayName === myName;
};

const SharedTrainingScreen = () => {
  const navigate = useNavigate();
  const { playerName } = usePermissions();
  const name = playerName || 'Unknown';

  const [sessionCount, setSessionCount] = useState<number>(10);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [showCategoryPicker, setShowCategoryPicker] = useState(false);
  const [trainingMode, setTrainingMode] = useState<'mixed' | 'true_false' | 'specific'>('mixed');
  const [leaderboard, setLeaderboard] = useState<TrainingPlayerData[]>([]);
  const [remoteProgress, setRemoteProgress] = useState<SharedTrainingProgress | null>(null);
  const [playerInsight, setPlayerInsight] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isSharing, setIsSharing] = useState(false);
  const [sharingCard, setSharingCard] = useState<string | null>(null);
  const leaderboardRef = useRef<HTMLDivElement>(null);
  const insightRef = useRef<HTMLDivElement>(null);

  const [poolCounts, setPoolCounts] = useState(() => getPoolCounts());
  const localProgress = getSharedProgress(name);
  const progress = useMemo(() => {
    if (!remoteProgress) return localProgress;
    return remoteProgress;
  }, [localProgress, remoteProgress]);

  const catExpert = getCategoryExpertBadges(progress);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [raw, insightsData, poolData] = await Promise.all([
        fetchTrainingAnswers(),
        fetchTrainingInsights(),
        fetchTrainingPool(),
      ]);
      if (poolData) {
        updatePoolCache(poolData);
        setPoolCounts(getPoolCounts());
      }
      const answersData = raw ? normalizeTrainingPlayers(raw) : null;
      if (answersData) {
        setLeaderboard(answersData.players);
        const myRemoteData = answersData.players.find(p => p.playerName === name);
        if (myRemoteData && (myRemoteData.totalQuestions > 0 || myRemoteData.sessions.length > 0)) {
          const rebuilt = rebuildProgressFromRemote(myRemoteData);
          setRemoteProgress(rebuilt);
          saveSharedProgress(name, rebuilt);
          await flushPendingUploads();
        } else {
          setRemoteProgress(null);
          resetSharedTrainingProgress(name);
          clearPendingUploadsForPlayer(name);
        }
      } else {
        await flushPendingUploads();
      }
      if (insightsData?.insights?.[name]) {
        setPlayerInsight(insightsData.insights[name].improvement);
      } else {
        setPlayerInsight(null);
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

  useRealtimeRefresh(loadData);

  const handleStart = () => {
    const params = new URLSearchParams();
    if (sessionCount) params.set('count', String(sessionCount));
    if (trainingMode === 'true_false') {
      params.set('categories', 'true_false');
    } else if (trainingMode === 'specific' && selectedCategories.length > 0) {
      params.set('categories', selectedCategories.join(','));
    }
    navigate(`/shared-training/play?${params.toString()}`);
  };

  const handleShareLeaderboard = async () => {
    if (!leaderboardRef.current) return;
    setIsSharing(true);
    try {
      const files = await captureAndSplit(leaderboardRef.current, 'poker-training-leaderboard');
      await shareFiles(files, 'Poker Training Leaderboard');
    } catch { /* */ }
    finally { setIsSharing(false); }
  };

  const handleShareCard = async (ref: React.RefObject<HTMLDivElement | null>, cardName: string) => {
    if (!ref.current) return;
    setSharingCard(cardName);
    try {
      const files = await captureAndSplit(ref.current, `poker-training-${cardName}`);
      await shareFiles(files, `Poker Training ${cardName}`);
    } catch { /* */ }
    finally { setSharingCard(null); }
  };

  const toggleCategory = (catId: string) => {
    setSelectedCategories(prev =>
      prev.includes(catId) ? prev.filter(c => c !== catId) : [...prev, catId]
    );
  };

  const leaderboardWithNeutral = useMemo((): LeaderboardRow[] => {
    return leaderboard.map(p => {
      const d = getTrainingSessionCounts(p);
      return {
        ...p,
        totalQuestions: d.scored,
        totalCorrect: d.correct,
        accuracy: d.accuracy,
        neutral: d.neutral,
      };
    });
  }, [leaderboard]);

  /**
   * Same source as progress bar: for the logged-in player, show merged local+remote totals
   * (progress picks max(local, remote)); the raw leaderboard was cloud-only → mismatch.
   */
  const leaderboardMerged = useMemo((): LeaderboardRow[] => {
    const merged = leaderboardWithNeutral.map(p => {
      if (!isSharedTrainingMe(p, name)) return p;
      const neutral = progress.totalNeutral || 0;
      const scored = progress.totalQuestions;
      const correct = progress.totalCorrect;
      return {
        ...p,
        totalQuestions: scored,
        totalCorrect: correct,
        neutral,
        accuracy: scored > 0 ? (correct / scored) * 100 : p.accuracy,
      };
    });
    // טבלה = רק שחקנים שמופיעים בקובץ הענן (לא שורה סינתטית מ-localStorage)
    return merged;
  }, [leaderboardWithNeutral, name, progress.totalQuestions, progress.totalCorrect, progress.totalNeutral]);

  const sortedLeaderboard = useMemo(() => {
    return [...leaderboardMerged]
      .filter(p => p.totalQuestions >= 5)
      .sort((a, b) => b.accuracy - a.accuracy || b.totalQuestions - a.totalQuestions);
  }, [leaderboardMerged]);

  const earnedBadges = TRAINING_BADGES.filter(b => progress.earnedBadgeIds.includes(b.id));
  const unearnedBadges = TRAINING_BADGES.filter(b => !progress.earnedBadgeIds.includes(b.id));
  const earnedCatBadges = catExpert.filter(b => b.earned);
  const unearnedCatBadges = catExpert.filter(b => !b.earned);

  // Build insights data — require 3+ scored answers for meaningful accuracy
  const hasProgress = progress.totalQuestions > 0;
  const catEntries = Object.entries(progress.byCategory)
    .filter(([catId, v]) => v.total >= 3 && SCENARIO_CATEGORIES.some(c => c.id === catId));

  // Sort by accuracy ascending, tiebreak by more questions first (larger sample = more trustworthy)
  const sortedByAcc = [...catEntries].sort((a, b) => {
    const accA = a[1].correct / a[1].total, accB = b[1].correct / b[1].total;
    return accA !== accB ? accA - accB : b[1].total - a[1].total;
  });

  // Best = highest accuracy, tiebreak by largest sample
  const bestCatEntry = catEntries.length > 0
    ? [...catEntries].sort((a, b) => {
        const accA = a[1].correct / a[1].total, accB = b[1].correct / b[1].total;
        return accA !== accB ? accB - accA : b[1].total - a[1].total;
      })[0]
    : null;
  const bestCat = bestCatEntry ? SCENARIO_CATEGORIES.find(c => c.id === bestCatEntry[0]) : null;
  const bestAcc = bestCatEntry ? Math.round((bestCatEntry[1].correct / bestCatEntry[1].total) * 100) : 0;
  const bestTotal = bestCatEntry ? bestCatEntry[1].total : 0;
  const bestCatTip = bestCatEntry ? (CATEGORY_TIPS[bestCatEntry[0]] || [])[1] || (CATEGORY_TIPS[bestCatEntry[0]] || [])[0] || null : null;

  // Worst = lowest accuracy, tiebreak by largest sample (most reliable weakness)
  const worstCatEntry = sortedByAcc.find(([catId]) => catId !== bestCatEntry?.[0]);
  const worstCat = worstCatEntry ? SCENARIO_CATEGORIES.find(c => c.id === worstCatEntry[0]) : null;
  const worstAcc = worstCatEntry ? Math.round((worstCatEntry[1].correct / worstCatEntry[1].total) * 100) : 0;
  const worstTotal = worstCatEntry ? worstCatEntry[1].total : 0;

  // Weak categories with actionable tips (below 70%)
  const weakCats = sortedByAcc
    .filter(([, v]) => (v.correct / v.total) < 0.7)
    .slice(0, 2)
    .map(([catId, data]) => {
      const cat = SCENARIO_CATEGORIES.find(c => c.id === catId)!;
      const acc = Math.round((data.correct / data.total) * 100);
      const wrong = data.total - data.correct;
      const catTips = CATEGORY_TIPS[catId] || [];
      return { catId, cat, acc, wrong, total: data.total, tip: catTips[0] || null };
    });

  const hasInsights = catEntries.length >= 2;

  return (
    <div className="fade-in" style={{ paddingBottom: '5rem', direction: 'rtl' }}>
      <div className="page-header">
        <h1 className="page-title">אימון פוקר</h1>
        <p className="page-subtitle">שלום {name}</p>
      </div>

      {/* Game style note */}
      <div style={{
        padding: '0.5rem 0.75rem', borderRadius: '8px', marginBottom: '0.5rem',
        background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.15)',
        fontSize: '0.7rem', color: 'var(--text-muted)', lineHeight: 1.6,
        display: 'flex', gap: '0.35rem',
      }}>
        <span style={{ flexShrink: 0 }}>💡</span>
        <span>השאלות מותאמות למשחק ביתי חברתי — בלופים עובדים פחות, שחקנים קוראים הרבה, והתשובות מתחשבות בסגנון שלנו ולא בפוקר מקצועי</span>
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
              className="btn btn-sm btn-secondary"
              style={{ flex: 1, padding: '0.45rem', fontSize: '0.8rem', ...(sessionCount === n ? { background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.4)', color: '#34d399' } : {}) }}
            >
              {n === 0 ? 'ללא הגבלה' : n}
            </button>
          ))}
        </div>

        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '0.4rem' }}>
          סגנון שאלות
        </div>
        <div style={{ display: 'flex', gap: '0.3rem', marginBottom: '0.6rem' }}>
          {([
            { mode: 'mixed' as typeof trainingMode, icon: '🎲', text: 'מעורב', count: poolCounts.total },
            { mode: 'true_false' as typeof trainingMode, icon: '🔢', text: 'סיכויים וחישובים', count: (poolCounts.byCategory['odds_math'] || 0) + (poolCounts.byCategory['true_false'] || 0) },
            { mode: 'specific' as typeof trainingMode, icon: '📂', text: 'נושא ספציפי', count: 0 },
          ]).map(({ mode, icon, text, count }) => (
            <button
              key={mode}
              onClick={() => { setTrainingMode(mode); if (mode === 'specific') { setShowCategoryPicker(true); } else { setSelectedCategories([]); setShowCategoryPicker(false); } }}
              className="btn btn-sm btn-secondary"
              style={{ flex: 1, padding: '0.4rem 0.3rem', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.15rem', lineHeight: 1.2, ...(trainingMode === mode ? { background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.4)', color: '#34d399' } : {}) }}
            >
              <span style={{ fontSize: '0.65rem', opacity: 0.8 }}>{icon}{count > 0 ? ` (${count})` : ''}</span>
              <span style={{ fontSize: '0.65rem', fontWeight: 600 }}>{text}</span>
            </button>
          ))}
        </div>

        {trainingMode === 'specific' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.3rem' }}>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                {selectedCategories.length > 0 ? `${selectedCategories.length} נבחרו` : 'בחר נושאים'}
              </div>
              <button
                onClick={() => setShowCategoryPicker(!showCategoryPicker)}
                style={{ background: 'none', border: 'none', color: 'var(--primary)', fontSize: '0.7rem', cursor: 'pointer', fontWeight: 600 }}
              >
                {showCategoryPicker ? '▲ סגור' : '▼ פתח'}
              </button>
            </div>
            {showCategoryPicker && (
              <div style={{
                maxHeight: '180px', overflowY: 'auto', marginBottom: '0.5rem',
                display: 'flex', flexWrap: 'wrap', gap: '0.25rem',
              }}>
                {SCENARIO_CATEGORIES.map(cat => {
                  const isSelected = selectedCategories.includes(cat.id);
                  const catCount = poolCounts.byCategory[cat.id] || 0;
                  return (
                    <button
                      key={cat.id}
                      onClick={() => toggleCategory(cat.id)}
                      className="btn btn-sm btn-secondary"
                      style={{ padding: '0.25rem 0.5rem', fontSize: '0.65rem', ...(isSelected ? { background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.4)', color: '#34d399' } : {}) }}
                    >
                      {cat.icon} {cat.name} ({catCount})
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
          </>
        )}

        <button className="btn btn-primary" onClick={handleStart} style={{ width: '100%', padding: '0.65rem', fontSize: '0.95rem' }}>
          🎯 התחל אימון
        </button>

        {/* 100q report teaser */}
        {progress.totalQuestions > 0 && (() => {
          const allAnswered = progress.totalQuestions + (progress.totalNeutral || 0);
          const nextMilestone = (Math.floor(allAnswered / 100) + 1) * 100;
          const progressToNext = allAnswered % 100;
          const remaining = 100 - progressToNext;
          const pct = Math.round((progressToNext / 100) * 100);
          return (
            <div style={{ marginTop: '0.5rem', padding: '0.5rem', background: 'rgba(59,130,246,0.06)', borderRadius: '8px', border: '1px solid rgba(59,130,246,0.12)' }}>
              <div style={{ fontSize: '0.7rem', color: 'var(--text)', fontWeight: 600, marginBottom: '0.3rem' }}>
                📊 עוד {remaining} שאלות ותקבל דוח AI אישי!
              </div>
              <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginBottom: '0.3rem' }}>
                {allAnswered > 0 && <span>{allAnswered} שאלות עד עכשיו · </span>}הדוח הבא ב-{nextMilestone} שאלות
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6rem', color: 'var(--text-muted)', marginBottom: '0.15rem' }}>
                <span>{allAnswered}/{nextMilestone}</span>
                <span>{pct}%</span>
              </div>
              <div style={{ height: '5px', background: 'var(--border)', borderRadius: '3px', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: 'linear-gradient(90deg, #3b82f6, #8b5cf6)', borderRadius: '3px', transition: 'width 0.3s ease' }} />
              </div>
            </div>
          );
        })()}
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
          <>
            <table style={{ width: '100%', fontSize: '0.75rem', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th style={{ padding: '0.3rem 0.15rem', width: '20px' }}>#</th>
                  <th style={{ padding: '0.3rem 0.15rem', textAlign: 'start' }}>שחקן</th>
                  <th style={{ padding: '0.3rem 0.15rem', textAlign: 'center' }}>ענו</th>
                  <th style={{ padding: '0.3rem 0.15rem', textAlign: 'center', color: '#22c55e' }}>✓</th>
                  <th style={{ padding: '0.3rem 0.15rem', textAlign: 'center', color: '#f59e0b' }}>~</th>
                  <th style={{ padding: '0.3rem 0.15rem', textAlign: 'center', color: '#ef4444' }}>✗</th>
                  <th style={{ padding: '0.3rem 0.15rem', textAlign: 'center' }}>דיוק</th>
                </tr>
              </thead>
              <tbody>
                {sortedLeaderboard.map((player, i) => {
                  const displayName = LEGACY_NAME_CORRECTIONS[player.playerName] || player.playerName;
                  const isMe = isSharedTrainingMe(player, name);
                  const totalAnswered = player.totalQuestions + player.neutral;
                  const wrong = player.totalQuestions - player.totalCorrect;
                  return (
                    <tr key={player.playerName} style={{
                      borderBottom: '1px solid rgba(255,255,255,0.03)',
                      ...(isMe ? { background: 'rgba(59,130,246,0.14)', borderInlineStart: '3px solid #3b82f6' } : {}),
                    }}>
                      <td style={{ padding: '0.3rem 0.15rem', whiteSpace: 'nowrap' }}>
                        {i + 1}
                      </td>
                      <td style={{ padding: '0.3rem 0.15rem', textAlign: 'start', fontWeight: isMe ? 700 : 500, ...(isMe ? { color: '#60a5fa' } : {}) }}>
                        {displayName}
                      </td>
                      <td style={{ padding: '0.3rem 0.15rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                        {totalAnswered}
                      </td>
                      <td style={{ padding: '0.3rem 0.15rem', textAlign: 'center', color: '#22c55e' }}>
                        {player.totalCorrect}
                      </td>
                      <td style={{ padding: '0.3rem 0.15rem', textAlign: 'center', color: '#f59e0b' }}>
                        {player.neutral || '-'}
                      </td>
                      <td style={{ padding: '0.3rem 0.15rem', textAlign: 'center', color: '#ef4444' }}>
                        {wrong || '-'}
                      </td>
                      <td style={{
                        padding: '0.3rem 0.15rem', textAlign: 'center', fontWeight: 700,
                        color: player.accuracy >= 60 ? 'var(--success)' : player.accuracy >= 40 ? '#eab308' : 'var(--danger)',
                      }}>
                        {player.accuracy.toFixed(0)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div style={{ fontSize: '0.55rem', color: 'var(--text-muted)', marginTop: '0.4rem', lineHeight: 1.5 }}>
              <span style={{ color: '#22c55e' }}>✓</span> נכון
              {' · '}
              <span style={{ color: '#f59e0b' }}>~</span> ניטרלי (תקף לפוקר מקצועי)
              {' · '}
              <span style={{ color: '#ef4444' }}>✗</span> שגוי
              {' · '}
              דיוק = ✓ מתוך (✓+✗)
            </div>
          </>
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

      {/* Personal AI coaching — below leaderboard */}
      {(() => {
        if (!playerInsight) return null;
        const myData = leaderboardMerged.find(p => isSharedTrainingMe(p, name));
        if (!myData) return null;
        const allAnswered = myData.totalQuestions + (myData.neutral || 0);
        const correctCount = myData.totalCorrect;
        const wrongCount = myData.totalQuestions - myData.totalCorrect;
        const nearMissCount = myData.neutral || 0;
        const accPct = myData.totalQuestions > 0
          ? Math.round((myData.totalCorrect / myData.totalQuestions) * 100)
          : 0;

        return (
          <>
            <div ref={insightRef} className="card" style={{ padding: '0.75rem', marginTop: '0.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                <span style={{ fontWeight: 700, fontSize: '0.8rem', color: '#a855f7' }}>
                  🎯 המאמן האישי שלך
                </span>
                <span style={{ display: 'flex', gap: '0.3rem', fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                  <span>{allAnswered} שאלות</span>
                  <span>·</span>
                  <span style={{ color: '#22c55e' }}>✓{correctCount}</span>
                  <span>·</span>
                  <span style={{ color: '#f59e0b' }}>~{nearMissCount}</span>
                  <span>·</span>
                  <span style={{ color: '#ef4444' }}>✗{wrongCount}</span>
                  <span>·</span>
                  <span style={{ fontWeight: 600 }}>{accPct}%</span>
                </span>
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                {playerInsight}
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: '0.5rem' }}>
              <button
                onClick={() => handleShareCard(insightRef, 'insight')}
                disabled={sharingCard === 'insight'}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem',
                  fontSize: '0.75rem', padding: '0.4rem 0.8rem',
                  background: 'var(--surface)', color: 'var(--text-muted)',
                  border: '1px solid var(--border)', borderRadius: '6px', cursor: 'pointer',
                }}
              >
                {sharingCard === 'insight' ? '📸...' : '📤 שתף'}
              </button>
            </div>
          </>
        );
      })()}

      {/* Player insights — below table */}
      {hasProgress && !hasInsights && (
        <div className="card" style={{ padding: '0.75rem', marginTop: '0.5rem' }}>
          <div style={{ fontWeight: 700, fontSize: '0.8rem', marginBottom: '0.3rem', color: 'var(--primary)' }}>
            📋 תובנות אימון
          </div>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
            צריך עוד כמה שאלות כדי לזהות חוזקות וחולשות — המשך להתאמן!
          </div>
        </div>
      )}
      {hasProgress && hasInsights && (
        <div className="card" style={{ padding: '0.75rem', marginTop: '0.5rem' }}>
          <div style={{ fontWeight: 700, fontSize: '0.8rem', marginBottom: '0.5rem', color: 'var(--primary)' }}>
            📋 תובנות אימון
          </div>

          {/* Strength / Weakness compact headers */}
          {bestCat && worstCat && (
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
                  {bestCat.icon} {bestCat.name}
                </div>
                <div style={{ fontSize: '0.55rem', color: 'var(--text-muted)', marginTop: '0.1rem' }}>
                  {bestTotal} שאלות
                </div>
              </div>
              <div style={{
                flex: 1, padding: '0.35rem 0.5rem', borderRadius: '8px',
                background: worstAcc <= 50 ? 'rgba(239,68,68,0.06)' : 'rgba(245,158,11,0.06)',
                border: `1px solid ${worstAcc <= 50 ? 'rgba(239,68,68,0.15)' : 'rgba(245,158,11,0.15)'}`,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.6rem', color: worstAcc <= 50 ? 'var(--danger)' : '#f59e0b', fontWeight: 600 }}>
                    {worstAcc <= 50 ? 'לשפר' : 'הכי חלש'}
                  </span>
                  <span style={{ fontSize: '0.7rem', color: worstAcc <= 50 ? 'var(--danger)' : '#f59e0b', fontWeight: 700 }}>{worstAcc}%</span>
                </div>
                <div style={{ fontSize: '0.7rem', color: 'var(--text)', fontWeight: 600, marginTop: '0.1rem' }}>
                  {worstCat.icon} {worstCat.name}
                </div>
                <div style={{ fontSize: '0.55rem', color: 'var(--text-muted)', marginTop: '0.1rem' }}>
                  {worstTotal} שאלות
                </div>
              </div>
            </div>
          )}

          {/* Strength tip */}
          {bestCatTip && (
            <div style={{
              padding: '0.4rem 0.5rem', borderRadius: '8px', marginBottom: '0.4rem',
              background: 'rgba(34,197,94,0.04)', borderInlineStart: '3px solid var(--success)',
            }}>
              <div style={{ fontSize: '0.65rem', color: 'var(--success)', fontWeight: 600, marginBottom: '0.15rem' }}>
                {bestCat?.icon} {bestCat?.name}
              </div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text)', lineHeight: 1.6, paddingInlineEnd: '0.1rem' }}>
                {bestCatTip}
              </div>
            </div>
          )}

          {/* Weak categories with actionable tips */}
          {weakCats.map(wc => (
            <div key={wc.catId} style={{
              padding: '0.4rem 0.5rem', borderRadius: '8px', marginBottom: '0.4rem',
              background: 'rgba(239,68,68,0.04)', borderInlineStart: '3px solid var(--danger)',
            }}>
              <div style={{ fontSize: '0.65rem', color: 'var(--danger)', fontWeight: 600, marginBottom: '0.15rem' }}>
                {wc.cat?.icon} {wc.cat?.name} — {wc.wrong} טעויות מ-{wc.total}
              </div>
              {wc.tip && (
                <div style={{ fontSize: '0.7rem', color: 'var(--text)', lineHeight: 1.6, paddingInlineEnd: '0.1rem' }}>
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
          <div className="card" style={{ padding: '0.75rem', marginTop: '0.5rem' }}>
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
