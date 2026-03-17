import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  TrainingHand,
  TrainingOption,
  HandResult,
  SessionResult,
  SCENARIO_CATEGORIES,
  generateTrainingHand,
  recordDecision,
  saveSession,
  CategoryInfo,
  HERO_NAME,
  getLastTrainingModel,
} from '../utils/pokerTraining';

// ════════════════════════════════════════════════════════════
// CARD COMPONENTS
// ════════════════════════════════════════════════════════════

const PlayingCard = ({ card, size = 'normal', faceDown }: {
  card: string;
  size?: 'normal' | 'small';
  faceDown?: boolean;
}) => {
  const isSmall = size === 'small';
  const w = isSmall ? '36px' : '52px';
  const h = isSmall ? '50px' : '72px';
  const fontSize = isSmall ? '0.7rem' : '1rem';
  const suitSize = isSmall ? '0.8rem' : '1.2rem';

  if (faceDown) {
    return (
      <div style={{
        width: w, height: h,
        borderRadius: '6px',
        background: 'linear-gradient(135deg, #1e3a5f, #2d5a87)',
        border: '2px solid #3b7dbd',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
      }}>
        <span style={{ fontSize: suitSize, opacity: 0.4 }}>🂠</span>
      </div>
    );
  }

  const rank = card.slice(0, -1);
  const suit = card.slice(-1);
  const isRed = suit === '♥' || suit === '♦';

  return (
    <div style={{
      width: w, height: h,
      borderRadius: '6px',
      background: 'linear-gradient(180deg, #ffffff, #f0f0f0)',
      border: '1px solid #ccc',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      gap: '1px',
      boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
      color: isRed ? '#dc2626' : '#1a1a2e',
      fontWeight: '800',
      userSelect: 'none',
    }}>
      <span style={{ fontSize, lineHeight: 1 }}>{rank}</span>
      <span style={{ fontSize: suitSize, lineHeight: 1 }}>{suit}</span>
    </div>
  );
};

const BoardDisplay = ({ board, revealCount }: { board: string[]; revealCount: number }) => (
  <div style={{
    display: 'flex', gap: '6px', justifyContent: 'center',
    padding: '0.75rem', borderRadius: '12px',
    background: 'rgba(16, 100, 50, 0.25)',
    border: '1px solid rgba(34, 197, 94, 0.2)',
  }}>
    {[0, 1, 2, 3, 4].map(i => {
      const card = board[i];
      const isRevealed = i < revealCount && card;
      return (
        <div
          key={i}
          style={{
            transition: 'transform 0.4s ease',
            transform: isRevealed ? 'rotateY(0deg)' : 'rotateY(90deg)',
          }}
        >
          {isRevealed ? (
            <PlayingCard card={card} size="small" />
          ) : (
            <PlayingCard card="" size="small" faceDown />
          )}
        </div>
      );
    })}
  </div>
);

// ════════════════════════════════════════════════════════════
// TABLE POSITION MAP
// ════════════════════════════════════════════════════════════

const POSITION_ORDER = ['SB', 'BB', 'UTG', 'UTG+1', 'MP', 'MP+1', 'HJ', 'CO', 'BTN'];

const TablePositionMap = ({ heroPosition, heroName, heroStack, opponents }: {
  heroPosition: string;
  heroName: string;
  heroStack: number;
  opponents: { name: string; position: string; style: string; stack: number }[];
}) => {
  const allSeats = [
    { name: heroName, position: heroPosition, stack: heroStack, isHero: true, style: '' },
    ...opponents.map(o => ({ ...o, isHero: false })),
  ].sort((a, b) => {
    const ai = POSITION_ORDER.indexOf(a.position);
    const bi = POSITION_ORDER.indexOf(b.position);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  const positionLabels: Record<string, string> = {
    'SB': 'בליינד קטן',
    'BB': 'בליינד גדול',
    'UTG': 'ראשון',
    'UTG+1': 'שני',
    'MP': 'אמצע',
    'MP+1': 'אמצע',
    'HJ': 'לפני אחרון',
    'CO': 'לפני הכפתור',
    'BTN': 'כפתור (אחרון)',
  };

  return (
    <div style={{
      marginTop: '0.5rem',
      padding: '0.6rem',
      borderRadius: '12px',
      background: 'rgba(16, 100, 50, 0.12)',
      border: '1px solid rgba(34, 197, 94, 0.15)',
    }}>
      <div style={{
        fontSize: '0.6rem', color: 'var(--text-muted)', fontWeight: '600',
        marginBottom: '0.4rem', textAlign: 'center',
      }}>
        סדר משחק ←
      </div>
      <div style={{
        display: 'flex', gap: '0.25rem',
        flexWrap: 'wrap',
        justifyContent: 'center',
      }}>
        {allSeats.map((seat, i) => (
          <div key={i} style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            flex: '1 1 0',
            minWidth: 0,
          }}>
            <div style={{
              width: '36px', height: '36px',
              borderRadius: '50%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '0.85rem',
              background: seat.isHero
                ? 'linear-gradient(135deg, rgba(99, 102, 241, 0.3), rgba(168, 85, 247, 0.3))'
                : 'rgba(255,255,255,0.06)',
              border: seat.isHero
                ? '2px solid rgba(139, 92, 246, 0.6)'
                : '1px solid rgba(255,255,255,0.1)',
              boxShadow: seat.isHero ? '0 0 8px rgba(139, 92, 246, 0.3)' : 'none',
            }}>
              {seat.isHero ? '👤' : '🎭'}
            </div>
            <div style={{
              fontSize: '0.6rem', fontWeight: '700', marginTop: '0.2rem',
              color: seat.isHero ? '#a78bfa' : 'var(--text)',
              textAlign: 'center',
              wordBreak: 'break-word',
              lineHeight: 1.2,
            }}>
              {seat.isHero ? 'אתה' : seat.name}
            </div>
            <div style={{
              fontSize: '0.5rem', color: 'var(--text-muted)',
              textAlign: 'center', lineHeight: 1.2,
            }}>
              {positionLabels[seat.position] || seat.position}
            </div>
            <div style={{
              fontSize: '0.5rem', color: 'rgba(245, 158, 11, 0.8)',
              fontWeight: '600',
            }}>
              {seat.stack.toLocaleString()}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ════════════════════════════════════════════════════════════
// RATING HELPERS
// ════════════════════════════════════════════════════════════

const RATING_CONFIG: Record<string, { color: string; bg: string; label: string; emoji: string }> = {
  best: { color: '#22c55e', bg: 'rgba(34, 197, 94, 0.15)', label: 'מהלך מושלם', emoji: '✓' },
  good: { color: '#3b82f6', bg: 'rgba(59, 130, 246, 0.15)', label: 'סביר', emoji: '~' },
  ok: { color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.15)', label: 'לא אידיאלי', emoji: '–' },
  bad: { color: '#ef4444', bg: 'rgba(239, 68, 68, 0.15)', label: 'טעות', emoji: '✗' },
};

// ════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ════════════════════════════════════════════════════════════

const TrainingHandScreen = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const difficulty = (searchParams.get('difficulty') || 'hard') as 'medium' | 'hard' | 'expert';
  const maxHands = parseInt(searchParams.get('maxHands') || '0') || null;
  const categoriesParam = searchParams.get('categories') || searchParams.get('category') || null;
  const categoryPool: CategoryInfo[] = categoriesParam
    ? categoriesParam.split(',')
        .map(id => SCENARIO_CATEGORIES.find(c => c.id === id.trim()))
        .filter((c): c is CategoryInfo => !!c)
    : [];

  const [hand, setHand] = useState<TrainingHand | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [trainingModelName, setTrainingModelName] = useState<string>('');
  const [currentStreetIdx, setCurrentStreetIdx] = useState(0);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [showFeedback, setShowFeedback] = useState(false);
  const [handNumber, setHandNumber] = useState(1);
  const [sessionHands, setSessionHands] = useState<HandResult[]>([]);
  const [currentHandDecisions, setCurrentHandDecisions] = useState<{ streetName: string; chosenRating: string }[]>([]);
  const [showSummary, setShowSummary] = useState(false);
  const [showHandComplete, setShowHandComplete] = useState(false);
  const [prefetchedHand, setPrefetchedHand] = useState<TrainingHand | null>(null);
  const [isPrefetching, setIsPrefetching] = useState(false);

  const pickCategory = (): CategoryInfo | undefined => {
    if (categoryPool.length === 0) return undefined;
    return categoryPool[Math.floor(Math.random() * categoryPool.length)];
  };

  const prefetchNext = useCallback(() => {
    if (isPrefetching || prefetchedHand) return;
    setIsPrefetching(true);
    const cat = categoryPool.length > 0
      ? categoryPool[Math.floor(Math.random() * categoryPool.length)]
      : undefined;
    generateTrainingHand(cat, difficulty)
      .then(h => { setPrefetchedHand(h); setTrainingModelName(getLastTrainingModel()); })
      .catch(() => {})
      .finally(() => setIsPrefetching(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryPool, difficulty, isPrefetching, prefetchedHand]);

  const loadHand = useCallback(async (usePrefetched?: boolean) => {
    setCurrentStreetIdx(0);
    setSelectedOption(null);
    setShowFeedback(false);
    setCurrentHandDecisions([]);
    setShowHandComplete(false);

    if (usePrefetched && prefetchedHand) {
      setHand(prefetchedHand);
      setPrefetchedHand(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    setHand(null);

    try {
      const handCategory = pickCategory();
      const newHand = await generateTrainingHand(handCategory, difficulty);
      setHand(newHand);
      setTrainingModelName(getLastTrainingModel());
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      if (msg === 'NO_API_KEY') {
        setError('כדי להשתמש באימון, הגדר מפתח בהגדרות');
      } else if (msg === 'INVALID_API_KEY') {
        setError('המפתח שהוגדר לא תקין, בדוק בהגדרות');
      } else if (msg.startsWith('ALL_MODELS_FAILED')) {
        const detail = msg.split(':').slice(1).join(':').trim();
        setError(`לא הצלחנו לייצר תרחיש${detail ? ` (${detail})` : ''}, נסה שוב`);
      } else {
        setError(`שגיאה: ${msg}`);
      }
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoriesParam, difficulty, prefetchedHand]);

  useEffect(() => {
    loadHand();
  }, [loadHand]);

  // Start pre-fetching the next hand once the current one is loaded
  useEffect(() => {
    if (hand && !loading && !showSummary && !prefetchedHand && !isPrefetching) {
      const timer = setTimeout(prefetchNext, 500);
      return () => clearTimeout(timer);
    }
  }, [hand, loading, showSummary, prefetchedHand, isPrefetching, prefetchNext]);

  // Collect all board cards revealed up to current street
  const getAllBoardCards = (): string[] => {
    if (!hand) return [];
    const cards: string[] = [];
    for (let i = 0; i <= currentStreetIdx; i++) {
      const street = hand.streets[i];
      if (street.board) cards.push(...street.board);
    }
    return cards;
  };

  const boardCards = getAllBoardCards();
  const currentStreet = hand?.streets[currentStreetIdx];
  const isLastStreet = hand ? currentStreetIdx >= hand.streets.length - 1 : false;

  const handleOptionSelect = (option: TrainingOption) => {
    if (showFeedback || !hand) return;
    setSelectedOption(option.id);
    setShowFeedback(true);

    recordDecision(hand.categoryId, hand.difficulty, option.rating);

    setCurrentHandDecisions(prev => [
      ...prev,
      { streetName: currentStreet?.name || '', chosenRating: option.rating },
    ]);
  };

  const handleContinue = () => {
    if (!hand) return;

    if (isLastStreet) {
      const bestCount = currentHandDecisions.filter(d => d.chosenRating === 'best').length;
      const goodCount = currentHandDecisions.filter(d => d.chosenRating === 'good').length;

      const handResult: HandResult = {
        categoryId: hand.categoryId,
        decisions: currentHandDecisions,
        bestCount,
        goodCount,
        totalDecisions: currentHandDecisions.length,
      };

      setSessionHands(prev => [...prev, handResult]);
      setShowHandComplete(true);
    } else {
      setCurrentStreetIdx(prev => prev + 1);
      setSelectedOption(null);
      setShowFeedback(false);
    }
  };

  const handleNextHand = () => {
    if (maxHands && handNumber >= maxHands) {
      concludeSession();
      return;
    }
    setHandNumber(prev => prev + 1);
    loadHand(true);
  };

  const concludeSession = () => {
    const allDecisions = sessionHands;
    const totalDecisions = allDecisions.reduce((sum, h) => sum + h.totalDecisions, 0);
    const bestDecisions = allDecisions.reduce((sum, h) => sum + h.bestCount, 0);
    const goodDecisions = allDecisions.reduce((sum, h) => sum + h.goodCount, 0);
    const accuracy = totalDecisions > 0
      ? ((bestDecisions + goodDecisions) / totalDecisions) * 100
      : 0;

    const session: SessionResult = {
      date: new Date().toISOString(),
      handsPlayed: allDecisions.length,
      totalDecisions,
      bestDecisions,
      goodDecisions,
      categories: [...new Set(allDecisions.map(h => h.categoryId))],
      difficulty,
      accuracy,
    };

    saveSession(session);
    setShowSummary(true);
  };

  // ════════════════════════════════════════════════════════════
  // LOADING STATE
  // ════════════════════════════════════════════════════════════

  if (loading) {
    return (
      <div className="fade-in" style={{
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        minHeight: '70vh', gap: '1.5rem', padding: '2rem',
      }}>
        <div style={{
          display: 'flex', gap: '8px',
          animation: 'pulse 1.5s infinite',
        }}>
          <PlayingCard card="" faceDown />
          <PlayingCard card="" faceDown />
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontWeight: '700', fontSize: '1.1rem', marginBottom: '0.3rem' }}>
            מכין סיטואציה...
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            {difficulty === 'expert' ? 'מחפש אתגר ברמה הגבוהה ביותר' :
              difficulty === 'hard' ? 'מייצר החלטה צמודה' : 'בונה תרחיש מאתגר'}
          </div>
        </div>
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════
  // ERROR STATE
  // ════════════════════════════════════════════════════════════

  if (error) {
    return (
      <div className="fade-in" style={{ textAlign: 'center', padding: '3rem' }}>
        <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>😕</div>
        <h2 style={{ marginBottom: '0.5rem' }}>שגיאה</h2>
        <p className="text-muted" style={{ marginBottom: '1.5rem' }}>{error}</p>
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center' }}>
          <button className="btn btn-primary" onClick={() => loadHand()}>נסה שוב</button>
          <button className="btn btn-secondary" onClick={() => navigate('/training')}>חזרה</button>
        </div>
      </div>
    );
  }

  // ════════════════════════════════════════════════════════════
  // SESSION SUMMARY
  // ════════════════════════════════════════════════════════════

  if (showSummary) {
    const totalDec = sessionHands.reduce((s, h) => s + h.totalDecisions, 0);
    const bestDec = sessionHands.reduce((s, h) => s + h.bestCount, 0);
    const goodDec = sessionHands.reduce((s, h) => s + h.goodCount, 0);
    const badDec = totalDec - bestDec - goodDec;
    const accuracy = totalDec > 0 ? ((bestDec + goodDec) / totalDec) * 100 : 0;

    const categoryBreakdown = sessionHands.reduce((acc, h) => {
      if (!acc[h.categoryId]) acc[h.categoryId] = { total: 0, best: 0, good: 0 };
      acc[h.categoryId].total += h.totalDecisions;
      acc[h.categoryId].best += h.bestCount;
      acc[h.categoryId].good += h.goodCount;
      return acc;
    }, {} as Record<string, { total: number; best: number; good: number }>);

    const weakInSession = Object.entries(categoryBreakdown)
      .filter(([, d]) => d.total > 0 && (d.best + d.good) / d.total < 0.5)
      .map(([id]) => SCENARIO_CATEGORIES.find(c => c.id === id)?.name)
      .filter(Boolean);

    return (
      <div className="fade-in" style={{ paddingBottom: '6rem' }}>
        <div style={{ textAlign: 'center', padding: '1.5rem 0' }}>
          <div style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>
            {accuracy >= 70 ? '🏆' : accuracy >= 50 ? '👍' : '💪'}
          </div>
          <h2 style={{ marginBottom: '0.3rem' }}>סיכום סשן</h2>
          <p className="text-muted">{sessionHands.length} ידיים | {{ medium: 'בינוני', hard: 'קשה', expert: 'מומחה' }[difficulty] || difficulty}</p>
        </div>

        {/* Score Card */}
        <div className="card" style={{
          padding: '1.5rem',
          textAlign: 'center',
          background: accuracy >= 70
            ? 'rgba(34, 197, 94, 0.1)'
            : accuracy >= 50
              ? 'rgba(59, 130, 246, 0.1)'
              : 'rgba(239, 68, 68, 0.1)',
          border: `1px solid ${accuracy >= 70 ? 'rgba(34,197,94,0.3)' : accuracy >= 50 ? 'rgba(59,130,246,0.3)' : 'rgba(239,68,68,0.3)'}`,
        }}>
          <div style={{
            fontSize: '3rem',
            fontWeight: '900',
            color: accuracy >= 70 ? '#22c55e' : accuracy >= 50 ? '#3b82f6' : '#ef4444',
          }}>
            {accuracy.toFixed(0)}%
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>דיוק כללי</div>
          <div style={{
            display: 'flex', justifyContent: 'center', gap: '1.5rem', marginTop: '1rem',
          }}>
            <div>
              <div style={{ fontWeight: '700', color: '#22c55e' }}>{bestDec}</div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>מושלם</div>
            </div>
            <div>
              <div style={{ fontWeight: '700', color: '#3b82f6' }}>{goodDec}</div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>סביר</div>
            </div>
            <div>
              <div style={{ fontWeight: '700', color: '#ef4444' }}>{badDec}</div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>טעויות</div>
            </div>
          </div>
        </div>

        {/* Per-hand breakdown */}
        <div className="card" style={{ padding: '1rem' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem', fontWeight: '600' }}>
            פירוט לפי יד
          </div>
          {sessionHands.map((h, i) => {
            const catName = SCENARIO_CATEGORIES.find(c => c.id === h.categoryId)?.name || h.categoryId;
            const handAcc = h.totalDecisions > 0
              ? ((h.bestCount + h.goodCount) / h.totalDecisions) * 100
              : 0;
            return (
              <div key={i} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '0.5rem 0',
                borderBottom: i < sessionHands.length - 1 ? '1px solid var(--border)' : 'none',
              }}>
                <div>
                  <span style={{ fontWeight: '600', fontSize: '0.85rem' }}>יד {i + 1}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginRight: '0.5rem' }}>
                    {catName}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
                  {h.decisions.map((d, j) => (
                    <span
                      key={j}
                      style={{
                        width: '20px', height: '20px',
                        borderRadius: '50%',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: '0.7rem', fontWeight: '700',
                        background: RATING_CONFIG[d.chosenRating]?.bg || 'var(--surface)',
                        color: RATING_CONFIG[d.chosenRating]?.color || 'var(--text)',
                      }}
                    >
                      {RATING_CONFIG[d.chosenRating]?.emoji || '?'}
                    </span>
                  ))}
                  <span style={{
                    fontWeight: '700', fontSize: '0.8rem', marginRight: '0.3rem',
                    color: handAcc >= 70 ? '#22c55e' : handAcc >= 50 ? '#3b82f6' : '#ef4444',
                  }}>
                    {h.bestCount + h.goodCount}/{h.totalDecisions}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Session Insights */}
        <div className="card" style={{
          padding: '1rem',
          background: 'rgba(99, 102, 241, 0.08)',
          border: '1px solid rgba(99, 102, 241, 0.2)',
        }}>
          <div style={{ fontWeight: '700', fontSize: '0.85rem', color: '#a78bfa', marginBottom: '0.5rem' }}>
            💡 תובנות מהסשן
          </div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.6, direction: 'rtl' }}>
            {(() => {
              const insights: string[] = [];
              const strongCats = Object.entries(categoryBreakdown)
                .filter(([, d]) => d.total > 0 && (d.best + d.good) / d.total >= 0.7)
                .map(([id]) => SCENARIO_CATEGORIES.find(c => c.id === id)?.name)
                .filter(Boolean);

              if (accuracy >= 80) {
                insights.push('ביצועים מעולים! אתה מקבל החלטות מדויקות ברוב המקרים.');
              } else if (accuracy >= 60) {
                insights.push('ביצועים טובים, אבל יש מקום לשיפור בכמה נקודות.');
              } else if (accuracy >= 40) {
                insights.push('יש בסיס, אבל כדאי לחדד את קבלת ההחלטות בנקודות מפתח.');
              } else {
                insights.push('הסשן היה מאתגר - זה בדיוק הזמן ללמוד מהטעויות ולהשתפר.');
              }

              if (strongCats.length > 0) {
                insights.push(`חזק ב: ${strongCats.join(', ')}.`);
              }

              if (weakInSession.length > 0) {
                insights.push(`מומלץ לתרגל: ${weakInSession.join(', ')} - שים דגש על הנושאים האלה בסשן הבא.`);
              }

              const badStreets = sessionHands.flatMap(h =>
                h.decisions.filter(d => d.chosenRating === 'bad').map(d => ({
                  hand: h.categoryId,
                  street: d.streetName,
                }))
              );
              if (badStreets.length > 0) {
                const streetCounts: Record<string, number> = {};
                badStreets.forEach(b => {
                  streetCounts[b.street] = (streetCounts[b.street] || 0) + 1;
                });
                const worstStreet = Object.entries(streetCounts).sort((a, b) => b[1] - a[1])[0];
                if (worstStreet) {
                  const streetHeb: Record<string, string> = {
                    preflop: 'לפני הפלופ', flop: 'פלופ', turn: 'טרן', river: 'ריבר',
                  };
                  insights.push(`רוב הטעויות ב-${streetHeb[worstStreet[0]] || worstStreet[0]} - שווה לשים לב לדפוס.`);
                }
              }

              if (bestDec === totalDec) {
                insights.push('סשן מושלם! 100% דיוק - נסה לעלות רמה או לתרגל קטגוריות חדשות.');
              }

              return insights.map((insight, i) => (
                <div key={i} style={{ marginBottom: i < insights.length - 1 ? '0.4rem' : 0 }}>
                  {insight}
                </div>
              ));
            })()}
          </div>
        </div>

        {/* Category breakdown */}
        {Object.keys(categoryBreakdown).length > 1 && (
          <div className="card" style={{ padding: '1rem' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem', fontWeight: '600' }}>
              ביצועים לפי קטגוריה
            </div>
            {Object.entries(categoryBreakdown).map(([catId, data]) => {
              const catName = SCENARIO_CATEGORIES.find(c => c.id === catId)?.name || catId;
              const acc = data.total > 0 ? ((data.best + data.good) / data.total) * 100 : 0;
              return (
                <div key={catId} style={{ marginBottom: '0.5rem' }}>
                  <div style={{
                    display: 'flex', justifyContent: 'space-between',
                    fontSize: '0.8rem', marginBottom: '0.2rem',
                  }}>
                    <span>{catName}</span>
                    <span style={{
                      fontWeight: '700',
                      color: acc >= 70 ? '#22c55e' : acc >= 50 ? '#f59e0b' : '#ef4444',
                    }}>
                      {acc.toFixed(0)}%
                    </span>
                  </div>
                  <div style={{
                    height: '6px', background: 'var(--border)', borderRadius: '3px', overflow: 'hidden',
                  }}>
                    <div style={{
                      height: '100%', width: `${acc}%`, borderRadius: '3px',
                      background: acc >= 70 ? '#22c55e' : acc >= 50 ? '#f59e0b' : '#ef4444',
                      transition: 'width 0.5s ease',
                    }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
          <button
            className="btn btn-primary"
            style={{ flex: 1 }}
            onClick={() => navigate('/training')}
          >
            חזרה להאב
          </button>
          <button
            className="btn btn-secondary"
            style={{ flex: 1 }}
            onClick={() => {
              setShowSummary(false);
              setSessionHands([]);
              setHandNumber(1);
              loadHand();
            }}
          >
            סשן חדש
          </button>
        </div>
      </div>
    );
  }

  if (!hand || !currentStreet) return null;

  // ════════════════════════════════════════════════════════════
  // HAND PLAY
  // ════════════════════════════════════════════════════════════

  const catInfo = SCENARIO_CATEGORIES.find(c => c.id === hand.categoryId);

  return (
    <div className="fade-in" style={{ paddingBottom: '2rem' }}>
      {/* Top Bar */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '0.5rem 0', marginBottom: '0.5rem',
      }}>
        <button
          onClick={() => {
            if (sessionHands.length > 0) {
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
          ← {sessionHands.length > 0 ? 'סיים סשן' : 'חזרה'}
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <span style={{
            background: `${RATING_CONFIG.best.color}25`,
            color: RATING_CONFIG.best.color,
            padding: '0.2rem 0.5rem', borderRadius: '8px',
            fontSize: '0.7rem', fontWeight: '700',
          }}>
            {{ medium: 'בינוני', hard: 'קשה', expert: 'מומחה' }[difficulty] || difficulty}
          </span>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: '600' }}>
            יד {handNumber}{maxHands ? `/${maxHands}` : ''}
          </span>
        </div>
      </div>

      {/* Category Badge */}
      {catInfo && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: '0.4rem',
          marginBottom: '0.75rem',
        }}>
          <span style={{ fontSize: '1.2rem' }}>{catInfo.icon}</span>
          <span style={{ fontWeight: '700', fontSize: '0.9rem' }}>{catInfo.name}</span>
          {trainingModelName && (
            <span style={{ fontSize: '0.55rem', color: 'var(--text-muted)', opacity: 0.6, marginLeft: 'auto' }}>
              model: {trainingModelName}
            </span>
          )}
        </div>
      )}

      {/* Your Cards + Position */}
      <div className="card" style={{
        padding: '0.75rem 1rem',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: '600', marginBottom: '0.3rem' }}>
            הקלפים שלך ({hand.setup.yourPosition})
          </div>
          <div style={{ display: 'flex', gap: '6px' }}>
            <PlayingCard card={hand.setup.yourCards[0]} />
            <PlayingCard card={hand.setup.yourCards[1]} />
          </div>
        </div>
        <div style={{ textAlign: 'left' }}>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: '600' }}>ערימה</div>
          <div style={{ fontWeight: '700', fontSize: '1rem' }}>
            {hand.setup.yourStack.toLocaleString()}
          </div>
        </div>
      </div>

      {/* Board */}
      {boardCards.length > 0 && (
        <div style={{ marginTop: '0.5rem' }}>
          <BoardDisplay board={boardCards} revealCount={boardCards.length} />
        </div>
      )}

      {/* Table Position Map */}
      <TablePositionMap
        heroPosition={hand.setup.yourPosition}
        heroName={HERO_NAME}
        heroStack={hand.setup.yourStack}
        opponents={hand.setup.opponents}
      />

      {/* Street Progress */}
      <div style={{
        display: 'flex', gap: '0.3rem', justifyContent: 'center',
        margin: '0.75rem 0',
      }}>
        {hand.streets.map((street, i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: '0.3rem',
          }}>
            <div style={{
              width: '28px', height: '28px', borderRadius: '50%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: '0.65rem', fontWeight: '700',
              background: i < currentStreetIdx
                ? 'var(--success)' : i === currentStreetIdx
                  ? 'var(--primary)' : 'var(--surface-light)',
              color: i <= currentStreetIdx ? 'white' : 'var(--text-muted)',
              transition: 'all 0.3s ease',
            }}>
              {i < currentStreetIdx
                ? (currentHandDecisions[i]
                  ? RATING_CONFIG[currentHandDecisions[i].chosenRating]?.emoji || '?'
                  : '✓')
                : street.name === 'preflop' ? 'פר'
                  : street.name === 'flop' ? 'פ'
                    : street.name === 'turn' ? 'ט' : 'ר'}
            </div>
            {i < hand.streets.length - 1 && (
              <div style={{
                width: '20px', height: '2px',
                background: i < currentStreetIdx ? 'var(--success)' : 'var(--border)',
              }} />
            )}
          </div>
        ))}
      </div>

      {/* Context + Pot */}
      <div className="card" style={{ padding: '0.75rem 1rem' }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          marginBottom: '0.5rem',
        }}>
          <span style={{
            fontWeight: '700', fontSize: '0.8rem',
            color: 'var(--primary)',
          }}>
            {{ preflop: 'לפני הפלופ', flop: 'פלופ', turn: 'טרן', river: 'ריבר' }[currentStreet.name] || currentStreet.name}
          </span>
          <span style={{
            fontWeight: '700', fontSize: '0.85rem',
            background: 'rgba(245, 158, 11, 0.15)',
            color: '#f59e0b', padding: '0.2rem 0.6rem', borderRadius: '8px',
          }}>
            קופה: {currentStreet.potSize.toLocaleString()}
          </span>
        </div>
        <p style={{
          fontSize: '0.9rem', lineHeight: 1.6, color: 'var(--text)',
          direction: 'rtl',
        }}>
          {currentStreet.context}
        </p>
      </div>

      {/* Options */}
      {!showHandComplete && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
          {currentStreet.options.map(option => {
            const isSelected = selectedOption === option.id;
            const ratingCfg = RATING_CONFIG[option.rating] || RATING_CONFIG.ok;
            const showThisRating = showFeedback;

            return (
              <button
                key={option.id}
                onClick={() => handleOptionSelect(option)}
                disabled={showFeedback}
                style={{
                  padding: '0.75rem 1rem',
                  borderRadius: '12px',
                  border: isSelected && showFeedback
                    ? `2px solid ${ratingCfg.color}`
                    : showFeedback
                      ? `1px solid var(--border)`
                      : '2px solid var(--border)',
                  background: isSelected && showFeedback
                    ? ratingCfg.bg
                    : showFeedback
                      ? 'var(--surface)'
                      : 'var(--surface)',
                  cursor: showFeedback ? 'default' : 'pointer',
                  textAlign: 'right',
                  direction: 'rtl',
                  transition: 'all 0.2s ease',
                  opacity: showFeedback && !isSelected ? 0.7 : 1,
                }}
              >
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '0.5rem',
                  justifyContent: 'space-between',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{
                      width: '24px', height: '24px', borderRadius: '50%',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontWeight: '700', fontSize: '0.75rem',
                      background: showThisRating ? ratingCfg.bg : 'var(--surface-light)',
                      color: showThisRating ? ratingCfg.color : 'var(--text)',
                    }}>
                      {showThisRating ? ratingCfg.emoji : option.id}
                    </span>
                    <span style={{
                      fontWeight: '700', fontSize: '0.9rem',
                      color: isSelected && showFeedback ? ratingCfg.color : 'var(--text)',
                    }}>
                      {option.action}
                    </span>
                  </div>
                  {showThisRating && (
                    <span style={{
                      fontSize: '0.65rem', fontWeight: '700',
                      color: ratingCfg.color,
                      padding: '0.15rem 0.4rem', borderRadius: '6px',
                      background: ratingCfg.bg,
                    }}>
                      {ratingCfg.label}
                    </span>
                  )}
                </div>

                {/* Explanation - show for all options after answering */}
                {showFeedback && option.explanation && (
                  <div style={{
                    marginTop: '0.5rem', fontSize: '0.8rem', lineHeight: 1.5,
                    color: isSelected ? 'var(--text)' : 'var(--text-muted)',
                    paddingRight: '2rem',
                    direction: 'rtl',
                  }}>
                    {option.explanation}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Continue / Next Street Button */}
      {showFeedback && !showHandComplete && (
        <button
          onClick={handleContinue}
          style={{
            width: '100%', padding: '0.85rem', marginTop: '0.75rem',
            borderRadius: '12px', border: 'none',
            background: isLastStreet
              ? 'linear-gradient(135deg, #6366f1, #4f46e5)'
              : 'linear-gradient(135deg, var(--primary), var(--primary-dark))',
            color: 'white', fontWeight: '700', fontSize: '1rem',
            cursor: 'pointer',
            boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
          }}
        >
          {isLastStreet ? 'סיכום היד →' : 'המשך לרחוב הבא →'}
        </button>
      )}

      {/* Hand Complete Summary */}
      {showHandComplete && (
        <div className="card" style={{
          padding: '1.25rem', marginTop: '0.75rem',
          background: 'rgba(99, 102, 241, 0.1)',
          border: '1px solid rgba(99, 102, 241, 0.3)',
        }}>
          <div style={{ fontWeight: '800', fontSize: '1rem', marginBottom: '0.5rem', color: '#818cf8' }}>
            לקח מרכזי
          </div>
          <p style={{
            fontSize: '0.9rem', lineHeight: 1.6, color: 'var(--text)',
            direction: 'rtl', marginBottom: '0.75rem',
          }}>
            {hand.keyLesson || 'לא התקבל לקח מרכזי עבור היד הזו.'}
          </p>

          {/* Concepts */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginBottom: '0.75rem' }}>
            {(hand.concepts ?? []).map((concept, i) => (
              <span key={i} style={{
                padding: '0.2rem 0.5rem', borderRadius: '8px',
                background: 'rgba(99, 102, 241, 0.15)',
                color: '#a5b4fc', fontSize: '0.7rem', fontWeight: '600',
              }}>
                {concept}
              </span>
            ))}
          </div>

          {/* Hand Score */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: '0.5rem',
            padding: '0.5rem 0.75rem', borderRadius: '8px',
            background: 'var(--surface)',
          }}>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>תוצאה:</span>
            {currentHandDecisions.map((d, i) => (
              <span
                key={i}
                style={{
                  width: '22px', height: '22px', borderRadius: '50%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '0.7rem', fontWeight: '700',
                  background: RATING_CONFIG[d.chosenRating]?.bg,
                  color: RATING_CONFIG[d.chosenRating]?.color,
                }}
              >
                {RATING_CONFIG[d.chosenRating]?.emoji}
              </span>
            ))}
            <span style={{
              marginRight: 'auto', fontWeight: '700',
              color: currentHandDecisions.filter(d => d.chosenRating === 'best').length ===
                currentHandDecisions.length ? '#22c55e' : 'var(--text)',
            }}>
              {currentHandDecisions.filter(d => d.chosenRating === 'best').length}/{currentHandDecisions.length}
            </span>
          </div>

          {/* Next / Conclude Buttons */}
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
            <button
              onClick={handleNextHand}
              style={{
                flex: 2, padding: '0.75rem', borderRadius: '12px', border: 'none',
                background: 'linear-gradient(135deg, var(--primary), var(--primary-dark))',
                color: 'white', fontWeight: '700', fontSize: '0.95rem', cursor: 'pointer',
              }}
            >
              {maxHands && handNumber >= maxHands ? 'סיכום סשן →' : 'יד הבאה →'}
            </button>
            {(!maxHands || handNumber < maxHands) && (
              <button
                onClick={concludeSession}
                style={{
                  flex: 1, padding: '0.75rem', borderRadius: '12px',
                  border: '1px solid var(--border)',
                  background: 'var(--surface)', color: 'var(--text-muted)',
                  fontWeight: '600', fontSize: '0.85rem', cursor: 'pointer',
                }}
              >
                סיים
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default TrainingHandScreen;
