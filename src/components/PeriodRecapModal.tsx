import { useState, useEffect, useRef, useMemo } from 'react';
import html2canvas from 'html2canvas';
import {
  computePeriodRecap,
  getAvailableRecapPeriods,
  RecapPeriodType,
  PeriodRecapData,
  buildPeriodKey,
} from '../utils/periodRecap';
import { getGraphInsights, saveGraphInsights } from '../database/storage';
import { generatePeriodRecapAI, getGeminiApiKey } from '../utils/geminiAI';
import { canUserGenerateAI } from '../utils/aiEligibility';
import { shareFiles } from '../utils/sharing';
import { usePermissions } from '../App';

interface PeriodRecapModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialPeriodType: RecapPeriodType;
  initialYear: number;
  initialMonth?: number;
}

const SLIDE_COUNT = 5;
const SLIDE_TITLES = [
  'התמונה הגדולה',
  'פודיום האלופים',
  'נבחרת התארים',
  'סיפור התקופה',
  'כרטיס שיתוף',
];

export const PeriodRecapModal = ({
  isOpen,
  onClose,
  initialPeriodType,
  initialYear,
  initialMonth,
}: PeriodRecapModalProps) => {
  const { role, isSuperAdmin, isOwner } = usePermissions();
  const isAdmin = role === 'admin' || isSuperAdmin || isOwner;
  const canGenerateAI = canUserGenerateAI(isOwner, isAdmin);

  const [periodType, setPeriodType] = useState<RecapPeriodType>(initialPeriodType);
  const [year, setYear] = useState<number>(initialYear);
  const [month, setMonth] = useState<number | undefined>(initialMonth);
  const [slideIdx, setSlideIdx] = useState(0);

  const [aiText, setAiText] = useState<string>('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [isSharing, setIsSharing] = useState(false);

  const shareCardRef = useRef<HTMLDivElement>(null);
  const touchStartXRef = useRef<number | null>(null);

  useEffect(() => {
    if (isOpen) {
      setPeriodType(initialPeriodType);
      setYear(initialYear);
      setMonth(initialMonth);
      setSlideIdx(0);
    }
  }, [isOpen, initialPeriodType, initialYear, initialMonth]);

  const availablePeriods = useMemo(() => {
    if (!isOpen) return [];
    return getAvailableRecapPeriods();
  }, [isOpen]);

  const recap: PeriodRecapData | null = useMemo(() => {
    if (!isOpen) return null;
    return computePeriodRecap(periodType, year, month);
  }, [isOpen, periodType, year, month]);

  // Load saved AI narrative from graph_insights when period changes
  useEffect(() => {
    if (!recap) {
      setAiText('');
      setAiError(null);
      return;
    }
    const saved = getGraphInsights(recap.periodKey);
    setAiText(saved?.text || '');
    setAiError(null);
  }, [recap]);

  if (!isOpen || !recap) return null;

  const currentKey = buildPeriodKey(periodType, year, month);

  const handlePeriodSelect = (selectedKey: string) => {
    const found = availablePeriods.find(p => p.key === selectedKey);
    if (!found) return;
    setPeriodType(found.periodType);
    setYear(found.year);
    setMonth(found.month);
    setSlideIdx(0);
  };

  const handleGenerateAI = async () => {
    if (!recap || aiLoading) return;
    if (!getGeminiApiKey()) {
      setAiError('מפתח Gemini API לא מוגדר בהגדרות הקבוצה');
      return;
    }
    setAiLoading(true);
    setAiError(null);
    try {
      const res = await generatePeriodRecapAI(recap);
      setAiText(res.text);
      saveGraphInsights(recap.periodKey, res.text, res.model);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'שגיאה ביצירת סיכום AI');
    } finally {
      setAiLoading(false);
    }
  };

  const handleShareInfographic = async () => {
    if (!shareCardRef.current || isSharing) return;
    setIsSharing(true);
    try {
      const canvas = await html2canvas(shareCardRef.current, {
        backgroundColor: '#0f172a',
        scale: 2,
        useCORS: true,
        logging: false,
      });
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
      if (blob) {
        const file = new File([blob], `poker-recap-${recap.periodKey}.png`, { type: 'image/png' });
        await shareFiles([file], recap.title);
      }
    } catch (err) {
      console.error('Share recap failed:', err);
    } finally {
      setIsSharing(false);
    }
  };

  const nextSlide = () => setSlideIdx(prev => Math.min(SLIDE_COUNT - 1, prev + 1));
  const prevSlide = () => setSlideIdx(prev => Math.max(0, prev - 1));

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartXRef.current = e.touches[0].clientX;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartXRef.current === null) return;
    const dx = e.changedTouches[0].clientX - touchStartXRef.current;
    touchStartXRef.current = null;
    // In RTL, swiping right-to-left (dx < -45) or left-to-right (dx > 45)
    if (dx > 45) {
      nextSlide();
    } else if (dx < -45) {
      prevSlide();
    }
  };

  const champ = recap.podium[0];
  const second = recap.podium[1];
  const third = recap.podium[2];

  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(2, 6, 23, 0.88)',
        backdropFilter: 'blur(8px)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0.5rem',
        direction: 'rtl',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        style={{
          width: '100%',
          maxWidth: '410px',
          maxHeight: '92vh',
          background: 'linear-gradient(165deg, #0f172a 0%, #1e1b4b 55%, #0f172a 100%)',
          borderRadius: '20px',
          border: '1px solid rgba(251, 191, 36, 0.28)',
          boxShadow: '0 20px 50px rgba(0, 0, 0, 0.75)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          color: '#f8fafc',
        }}
      >
        {/* Stories Progress Bars */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${SLIDE_COUNT}, 1fr)`,
            gap: '4px',
            padding: '0.65rem 0.75rem 0.35rem',
            direction: 'rtl',
          }}
        >
          {Array.from({ length: SLIDE_COUNT }).map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setSlideIdx(i)}
              style={{
                height: '4px',
                borderRadius: '999px',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                background:
                  i === slideIdx
                    ? 'linear-gradient(90deg, #fbbf24, #f59e0b)'
                    : i < slideIdx
                    ? 'rgba(251, 191, 36, 0.45)'
                    : 'rgba(255, 255, 255, 0.16)',
                transition: 'all 0.25s ease',
              }}
              aria-label={SLIDE_TITLES[i]}
            />
          ))}
        </div>

        {/* Header Bar with Period Switcher & Close */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0.35rem 0.85rem 0.6rem',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            gap: '0.5rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: '1.15rem' }}>🎬</span>
            {availablePeriods.length > 1 ? (
              <select
                value={currentKey}
                onChange={e => handlePeriodSelect(e.target.value)}
                style={{
                  background: 'rgba(255, 255, 255, 0.08)',
                  color: '#fbbf24',
                  border: '1px solid rgba(251, 191, 36, 0.35)',
                  borderRadius: '8px',
                  padding: '0.25rem 0.5rem',
                  fontSize: '0.85rem',
                  fontWeight: 700,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                  maxWidth: '210px',
                }}
              >
                {availablePeriods.map(p => (
                  <option key={p.key} value={p.key} style={{ background: '#0f172a', color: '#f8fafc' }}>
                    {p.label} ({p.gamesCount} מש׳)
                  </option>
                ))}
              </select>
            ) : (
              <span style={{ fontWeight: 700, fontSize: '0.95rem', color: '#fbbf24' }}>
                {recap.title}
              </span>
            )}
          </div>

          <span style={{ fontSize: '0.72rem', color: '#94a3b8', fontWeight: 600 }}>
            {slideIdx + 1}/{SLIDE_COUNT} · {SLIDE_TITLES[slideIdx]}
          </span>

          <button
            type="button"
            onClick={onClose}
            style={{
              background: 'rgba(255, 255, 255, 0.1)',
              border: 'none',
              color: '#e2e8f0',
              width: '28px',
              height: '28px',
              borderRadius: '50%',
              fontSize: '1.1rem',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>

        {/* Slide Body */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '1rem 0.9rem',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            minHeight: '390px',
          }}
        >
          {/* SLIDE 0: Big Picture & Pot */}
          {slideIdx === 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
              <div style={{ textAlign: 'center' }}>
                <div
                  style={{
                    display: 'inline-block',
                    padding: '0.2rem 0.7rem',
                    borderRadius: '999px',
                    background: 'rgba(251, 191, 36, 0.15)',
                    border: '1px solid rgba(251, 191, 36, 0.35)',
                    color: '#fbbf24',
                    fontSize: '0.75rem',
                    fontWeight: 700,
                    marginBottom: '0.35rem',
                  }}
                >
                  ✨ POKER WRAPPED · {recap.shortLabel}
                </div>
                <h2 style={{ margin: 0, fontSize: '1.45rem', fontWeight: 800, color: '#ffffff' }}>
                  {recap.title}
                </h2>
                <p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: '#94a3b8' }}>
                  כל המספרים, האלופים והרגעים הגדולים של התקופה
                </p>
              </div>

              {/* Hero Pot Box */}
              <div
                style={{
                  background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.18), rgba(16, 185, 129, 0.12))',
                  border: '1px solid rgba(251, 191, 36, 0.35)',
                  borderRadius: '16px',
                  padding: '1rem',
                  textAlign: 'center',
                }}
              >
                <div style={{ fontSize: '0.78rem', color: '#cbd5e1', fontWeight: 600 }}>
                  💰 סך הכסף שהתגלגל על השולחן
                </div>
                <div
                  style={{
                    fontSize: '2.2rem',
                    fontWeight: 900,
                    color: '#fbbf24',
                    letterSpacing: '0.5px',
                    marginTop: '0.15rem',
                  }}
                >
                  ₪{recap.totalPot.toLocaleString('he-IL')}
                </div>
                <div style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: '0.2rem' }}>
                  מתוך {recap.totalRebuys} כניסות וקניות חוזרות
                </div>
              </div>

              {/* 2x2 Stats Grid */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(2, 1fr)',
                  gap: '0.6rem',
                }}
              >
                <div
                  style={{
                    background: 'rgba(255, 255, 255, 0.05)',
                    borderRadius: '12px',
                    padding: '0.7rem',
                    textAlign: 'center',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                  }}
                >
                  <div style={{ fontSize: '1.35rem', fontWeight: 800, color: '#38bdf8' }}>
                    {recap.gamesCount}
                  </div>
                  <div style={{ fontSize: '0.74rem', color: '#94a3b8' }}>ערבי פוקר</div>
                </div>

                <div
                  style={{
                    background: 'rgba(255, 255, 255, 0.05)',
                    borderRadius: '12px',
                    padding: '0.7rem',
                    textAlign: 'center',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                  }}
                >
                  <div style={{ fontSize: '1.35rem', fontWeight: 800, color: '#34d399' }}>
                    ₪{recap.avgPotPerGame.toLocaleString('he-IL')}
                  </div>
                  <div style={{ fontSize: '0.74rem', color: '#94a3b8' }}>קופה ממוצעת לערב</div>
                </div>

                {recap.biggestGamePot && (
                  <div
                    style={{
                      background: 'rgba(255, 255, 255, 0.05)',
                      borderRadius: '12px',
                      padding: '0.7rem',
                      textAlign: 'center',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                    }}
                  >
                    <div style={{ fontSize: '1.15rem', fontWeight: 800, color: '#f472b6' }}>
                      ₪{recap.biggestGamePot.pot.toLocaleString('he-IL')}
                    </div>
                    <div style={{ fontSize: '0.72rem', color: '#94a3b8' }}>
                      שיא קופה ({recap.biggestGamePot.date})
                    </div>
                  </div>
                )}

                {recap.topLocation ? (
                  <div
                    style={{
                      background: 'rgba(255, 255, 255, 0.05)',
                      borderRadius: '12px',
                      padding: '0.7rem',
                      textAlign: 'center',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                    }}
                  >
                    <div
                      style={{
                        fontSize: '1.05rem',
                        fontWeight: 800,
                        color: '#c084fc',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      🏠 {recap.topLocation.name}
                    </div>
                    <div style={{ fontSize: '0.72rem', color: '#94a3b8' }}>
                      מארח מוביל ({recap.topLocation.count} מש׳)
                    </div>
                  </div>
                ) : (
                  <div
                    style={{
                      background: 'rgba(255, 255, 255, 0.05)',
                      borderRadius: '12px',
                      padding: '0.7rem',
                      textAlign: 'center',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                    }}
                  >
                    <div style={{ fontSize: '1.15rem', fontWeight: 800, color: '#c084fc' }}>
                      {recap.allRanked.length}
                    </div>
                    <div style={{ fontSize: '0.72rem', color: '#94a3b8' }}>
                      שחקנים פעילים (מינ׳ {recap.activeThreshold} מש׳)
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* SLIDE 1: Podium (1st, 2nd, 3rd) */}
          {slideIdx === 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '0.76rem', color: '#fbbf24', fontWeight: 700 }}>
                  🏆 פודיום האלופים · {recap.shortLabel}
                </div>
                <h3 style={{ margin: '0.15rem 0 0', fontSize: '1.25rem', fontWeight: 800 }}>
                  שלישיית הצמרת של התקופה
                </h3>
                <div style={{ fontSize: '0.72rem', color: '#94a3b8', marginTop: '0.1rem' }}>
                  דירוג שחקנים פעילים (מינימום {recap.activeThreshold} משחקים מתוך {recap.gamesCount})
                </div>
              </div>

              {/* Champion Spotlight */}
              {champ && (
                <div
                  style={{
                    background: 'linear-gradient(135deg, rgba(251, 191, 36, 0.22), rgba(217, 119, 6, 0.1))',
                    border: '1.5px solid rgba(251, 191, 36, 0.55)',
                    borderRadius: '16px',
                    padding: '0.9rem',
                    textAlign: 'center',
                    position: 'relative',
                  }}
                >
                  <div style={{ fontSize: '2rem', lineHeight: 1 }}>🥇👑</div>
                  <div style={{ fontSize: '0.74rem', color: '#fde68a', fontWeight: 700, marginTop: '0.2rem' }}>
                    {periodType === 'year'
                      ? `אלוף עונת ${year}`
                      : periodType === 'h1' || periodType === 'h2'
                      ? `אלוף ${recap.shortLabel}`
                      : `אלוף חודש ${recap.shortLabel}`}
                  </div>
                  <div style={{ fontSize: '1.45rem', fontWeight: 900, color: '#ffffff', marginTop: '0.1rem' }}>
                    {champ.playerName}
                  </div>
                  <div
                    style={{
                      fontSize: '1.35rem',
                      fontWeight: 800,
                      color: '#4ade80',
                      marginTop: '0.15rem',
                      direction: 'ltr',
                    }}
                  >
                    +₪{champ.profit.toLocaleString('he-IL')}
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'center',
                      gap: '0.75rem',
                      marginTop: '0.45rem',
                      fontSize: '0.75rem',
                      color: '#e2e8f0',
                    }}
                  >
                    <span>🎮 {champ.gamesPlayed} משחקים</span>
                    <span>🎯 {champ.winRate}% ניצחון</span>
                    <span>📈 ₪{champ.avgProfit} לערב</span>
                  </div>
                </div>
              )}

              {/* 2nd & 3rd Place Side-by-Side */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.6rem' }}>
                {second && (
                  <div
                    style={{
                      background: 'rgba(148, 163, 184, 0.12)',
                      border: '1px solid rgba(203, 213, 225, 0.35)',
                      borderRadius: '14px',
                      padding: '0.75rem 0.6rem',
                      textAlign: 'center',
                    }}
                  >
                    <div style={{ fontSize: '1.4rem' }}>🥈</div>
                    <div style={{ fontSize: '0.7rem', color: '#cbd5e1', fontWeight: 700 }}>סגן האלוף</div>
                    <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#ffffff', marginTop: '0.1rem' }}>
                      {second.playerName}
                    </div>
                    <div
                      style={{
                        fontSize: '1rem',
                        fontWeight: 800,
                        color: second.profit >= 0 ? '#4ade80' : '#f87171',
                        direction: 'ltr',
                        marginTop: '0.1rem',
                      }}
                    >
                      {second.profit >= 0 ? '+' : ''}₪{second.profit.toLocaleString('he-IL')}
                    </div>
                    <div style={{ fontSize: '0.68rem', color: '#94a3b8', marginTop: '0.2rem' }}>
                      {second.gamesPlayed} מש׳ · {second.winRate}% ניצחון
                    </div>
                  </div>
                )}

                {third && (
                  <div
                    style={{
                      background: 'rgba(180, 83, 9, 0.15)',
                      border: '1px solid rgba(217, 119, 6, 0.38)',
                      borderRadius: '14px',
                      padding: '0.75rem 0.6rem',
                      textAlign: 'center',
                    }}
                  >
                    <div style={{ fontSize: '1.4rem' }}>🥉</div>
                    <div style={{ fontSize: '0.7rem', color: '#fdba74', fontWeight: 700 }}>מקום שלישי</div>
                    <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#ffffff', marginTop: '0.1rem' }}>
                      {third.playerName}
                    </div>
                    <div
                      style={{
                        fontSize: '1rem',
                        fontWeight: 800,
                        color: third.profit >= 0 ? '#4ade80' : '#f87171',
                        direction: 'ltr',
                        marginTop: '0.1rem',
                      }}
                    >
                      {third.profit >= 0 ? '+' : ''}₪{third.profit.toLocaleString('he-IL')}
                    </div>
                    <div style={{ fontSize: '0.68rem', color: '#94a3b8', marginTop: '0.2rem' }}>
                      {third.gamesPlayed} מש׳ · {third.winRate}% ניצחון
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* SLIDE 2: 4 Special Awards Grid */}
          {slideIdx === 2 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '0.76rem', color: '#fbbf24', fontWeight: 700 }}>
                  🎖️ נבחרת התארים · {recap.shortLabel}
                </div>
                <h3 style={{ margin: '0.15rem 0 0', fontSize: '1.2rem', fontWeight: 800 }}>
                  מצטייני התקופה בקטגוריות המיוחדות
                </h3>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.65rem' }}>
                {/* Sniper */}
                {recap.awards.sniper && (
                  <div
                    style={{
                      background: 'rgba(16, 185, 129, 0.12)',
                      border: '1px solid rgba(52, 211, 153, 0.35)',
                      borderRadius: '14px',
                      padding: '0.8rem 0.65rem',
                      textAlign: 'center',
                    }}
                  >
                    <div style={{ fontSize: '1.5rem' }}>🎯</div>
                    <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#34d399', marginTop: '0.15rem' }}>
                      צלף התקופה
                    </div>
                    <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#ffffff', marginTop: '0.15rem' }}>
                      {recap.awards.sniper.playerName}
                    </div>
                    <div style={{ fontSize: '0.95rem', fontWeight: 800, color: '#6ee7b7', marginTop: '0.1rem' }}>
                      {recap.awards.sniper.winRate}% הצלחה
                    </div>
                    <div style={{ fontSize: '0.68rem', color: '#94a3b8', marginTop: '0.15rem' }}>
                      {recap.awards.sniper.wins} ניצחונות מ-{recap.awards.sniper.games} משחקים
                    </div>
                  </div>
                )}

                {/* Big Hit */}
                {recap.awards.bigHit && (
                  <div
                    style={{
                      background: 'rgba(168, 85, 247, 0.14)',
                      border: '1px solid rgba(192, 132, 252, 0.38)',
                      borderRadius: '14px',
                      padding: '0.8rem 0.65rem',
                      textAlign: 'center',
                    }}
                  >
                    <div style={{ fontSize: '1.5rem' }}>💥</div>
                    <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#c084fc', marginTop: '0.15rem' }}>
                      המכה הגדולה
                    </div>
                    <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#ffffff', marginTop: '0.15rem' }}>
                      {recap.awards.bigHit.playerName}
                    </div>
                    <div
                      style={{
                        fontSize: '0.95rem',
                        fontWeight: 800,
                        color: '#e9d5ff',
                        marginTop: '0.1rem',
                        direction: 'ltr',
                      }}
                    >
                      +₪{recap.awards.bigHit.profit.toLocaleString('he-IL')}
                    </div>
                    <div style={{ fontSize: '0.68rem', color: '#94a3b8', marginTop: '0.15rem' }}>
                      שיא בערב אחד ({recap.awards.bigHit.date})
                    </div>
                  </div>
                )}

                {/* Hot Streak */}
                {recap.awards.hotStreak ? (
                  <div
                    style={{
                      background: 'rgba(249, 115, 22, 0.14)',
                      border: '1px solid rgba(251, 146, 60, 0.38)',
                      borderRadius: '14px',
                      padding: '0.8rem 0.65rem',
                      textAlign: 'center',
                    }}
                  >
                    <div style={{ fontSize: '1.5rem' }}>🔥</div>
                    <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#fb923c', marginTop: '0.15rem' }}>
                      הרצף החם
                    </div>
                    <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#ffffff', marginTop: '0.15rem' }}>
                      {recap.awards.hotStreak.playerName}
                    </div>
                    <div style={{ fontSize: '0.95rem', fontWeight: 800, color: '#fed7aa', marginTop: '0.1rem' }}>
                      {recap.awards.hotStreak.streak} ניצחונות ברצף
                    </div>
                    <div style={{ fontSize: '0.68rem', color: '#94a3b8', marginTop: '0.15rem' }}>
                      המומנטום הארוך בתקופה
                    </div>
                  </div>
                ) : (
                  <div
                    style={{
                      background: 'rgba(56, 189, 248, 0.12)',
                      border: '1px solid rgba(56, 189, 248, 0.3)',
                      borderRadius: '14px',
                      padding: '0.8rem 0.65rem',
                      textAlign: 'center',
                    }}
                  >
                    <div style={{ fontSize: '1.5rem' }}>⚡</div>
                    <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#38bdf8', marginTop: '0.15rem' }}>
                      ממוצע לערב
                    </div>
                    <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#ffffff', marginTop: '0.15rem' }}>
                      {champ?.playerName || '-'}
                    </div>
                    <div
                      style={{
                        fontSize: '0.95rem',
                        fontWeight: 800,
                        color: '#bae6fd',
                        marginTop: '0.1rem',
                        direction: 'ltr',
                      }}
                    >
                      +₪{champ?.avgProfit || 0}
                    </div>
                    <div style={{ fontSize: '0.68rem', color: '#94a3b8', marginTop: '0.15rem' }}>
                      רווח ממוצע למשחק
                    </div>
                  </div>
                )}

                {/* ATM / Table Sponsor */}
                {recap.awards.atm && (
                  <div
                    style={{
                      background: 'rgba(244, 63, 94, 0.13)',
                      border: '1px solid rgba(251, 113, 133, 0.35)',
                      borderRadius: '14px',
                      padding: '0.8rem 0.65rem',
                      textAlign: 'center',
                    }}
                  >
                    <div style={{ fontSize: '1.5rem' }}>🏧</div>
                    <div style={{ fontSize: '0.72rem', fontWeight: 700, color: '#fb7185', marginTop: '0.15rem' }}>
                      המממן של השולחן
                    </div>
                    <div style={{ fontSize: '1.05rem', fontWeight: 800, color: '#ffffff', marginTop: '0.15rem' }}>
                      {recap.awards.atm.playerName}
                    </div>
                    <div style={{ fontSize: '0.95rem', fontWeight: 800, color: '#fecdd3', marginTop: '0.1rem' }}>
                      {recap.awards.atm.totalRebuys} כניסות
                    </div>
                    <div style={{ fontSize: '0.68rem', color: '#94a3b8', marginTop: '0.15rem' }}>
                      השקעה של ₪{recap.awards.atm.totalInvested.toLocaleString('he-IL')} בקופה
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* SLIDE 3: AI Story & Highlights */}
          {slideIdx === 3 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '0.76rem', color: '#fbbf24', fontWeight: 700 }}>
                  🎙️ דבר הפרשן · {recap.shortLabel}
                </div>
                <h3 style={{ margin: '0.15rem 0 0', fontSize: '1.2rem', fontWeight: 800 }}>
                  הסיפור של התקופה
                </h3>
              </div>

              {/* Deterministic Highlights */}
              <div
                style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  borderRadius: '12px',
                  padding: '0.7rem 0.8rem',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.45rem',
                }}
              >
                {recap.deterministicHighlights.map((line, i) => (
                  <div
                    key={i}
                    style={{
                      fontSize: '0.8rem',
                      lineHeight: 1.45,
                      color: '#e2e8f0',
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '0.4rem',
                    }}
                  >
                    <span style={{ color: '#fbbf24', flexShrink: 0 }}>✦</span>
                    <span>{line}</span>
                  </div>
                ))}
              </div>

              {/* AI Narrative Box */}
              <div
                style={{
                  background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.14), rgba(168, 85, 247, 0.12))',
                  border: '1px solid rgba(129, 140, 248, 0.35)',
                  borderRadius: '14px',
                  padding: '0.85rem',
                }}
              >
                {aiText ? (
                  <>
                    <div
                      style={{
                        fontSize: '0.82rem',
                        lineHeight: 1.6,
                        color: '#f1f5f9',
                        whiteSpace: 'pre-line',
                      }}
                    >
                      {aiText}
                    </div>
                    {canGenerateAI && (
                      <div style={{ marginTop: '0.6rem', textAlign: 'left' }}>
                        <button
                          type="button"
                          onClick={handleGenerateAI}
                          disabled={aiLoading}
                          style={{
                            background: 'rgba(255,255,255,0.08)',
                            border: '1px solid rgba(255,255,255,0.18)',
                            color: '#cbd5e1',
                            borderRadius: '6px',
                            padding: '0.25rem 0.6rem',
                            fontSize: '0.7rem',
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                          }}
                        >
                          {aiLoading ? 'מייצר...' : '🔄 צור סיכום AI מחדש'}
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <div style={{ textAlign: 'center', padding: '0.4rem 0' }}>
                    <div style={{ fontSize: '0.8rem', color: '#cbd5e1', marginBottom: '0.55rem' }}>
                      רוצה ניתוח פרשנות שנון ומלא על כל דרמות התקופה?
                    </div>
                    {canGenerateAI ? (
                      <button
                        type="button"
                        onClick={handleGenerateAI}
                        disabled={aiLoading}
                        style={{
                          background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                          border: 'none',
                          color: '#ffffff',
                          fontWeight: 700,
                          fontSize: '0.82rem',
                          padding: '0.5rem 1rem',
                          borderRadius: '10px',
                          cursor: aiLoading ? 'wait' : 'pointer',
                          fontFamily: 'inherit',
                        }}
                      >
                        {aiLoading ? '✨ כותב את סיפור התקופה...' : '✨ צור כתבת סיכום AI לתקופה'}
                      </button>
                    ) : (
                      <div style={{ fontSize: '0.72rem', color: '#94a3b8' }}>
                        מנהל הקבוצה יכול לייצר כתבת AI לתקופה זו
                      </div>
                    )}
                    {aiError && (
                      <div style={{ fontSize: '0.72rem', color: '#fca5a5', marginTop: '0.4rem' }}>
                        {aiError}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* SLIDE 4: Unified Shareable Infographic Card */}
          {slideIdx === 4 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div
                ref={shareCardRef}
                style={{
                  background: 'linear-gradient(160deg, #0f172a 0%, #1e1b4b 60%, #090d16 100%)',
                  border: '1.5px solid rgba(251, 191, 36, 0.45)',
                  borderRadius: '16px',
                  padding: '0.9rem',
                  direction: 'rtl',
                }}
              >
                {/* Header */}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
                    paddingBottom: '0.5rem',
                    marginBottom: '0.65rem',
                  }}
                >
                  <div>
                    <div style={{ fontSize: '0.68rem', color: '#fbbf24', fontWeight: 700 }}>
                      ♠️ POKER MANAGER WRAPPED
                    </div>
                    <div style={{ fontSize: '1.15rem', fontWeight: 900, color: '#ffffff' }}>
                      {recap.title}
                    </div>
                  </div>
                  <div style={{ textAlign: 'left', fontSize: '0.72rem', color: '#cbd5e1' }}>
                    <div>🎮 {recap.gamesCount} משחקים</div>
                    <div>💰 קופה: ₪{recap.totalPot.toLocaleString('he-IL')}</div>
                  </div>
                </div>

                {/* Podium Row */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(3, 1fr)',
                    gap: '0.4rem',
                    marginBottom: '0.65rem',
                  }}
                >
                  {recap.podium.slice(0, 3).map((p, idx) => {
                    const medals = ['🥇', '🥈', '🥉'];
                    const borders = [
                      'rgba(251, 191, 36, 0.5)',
                      'rgba(203, 213, 225, 0.35)',
                      'rgba(217, 119, 6, 0.35)',
                    ];
                    return (
                      <div
                        key={p.playerId}
                        style={{
                          background: idx === 0 ? 'rgba(251, 191, 36, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                          border: `1px solid ${borders[idx]}`,
                          borderRadius: '10px',
                          padding: '0.45rem 0.3rem',
                          textAlign: 'center',
                        }}
                      >
                        <div style={{ fontSize: '1.1rem' }}>{medals[idx]}</div>
                        <div
                          style={{
                            fontSize: '0.82rem',
                            fontWeight: 800,
                            color: '#ffffff',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {p.playerName}
                        </div>
                        <div
                          style={{
                            fontSize: '0.8rem',
                            fontWeight: 800,
                            color: p.profit >= 0 ? '#4ade80' : '#f87171',
                            direction: 'ltr',
                          }}
                        >
                          {p.profit >= 0 ? '+' : ''}₪{p.profit}
                        </div>
                        <div style={{ fontSize: '0.62rem', color: '#94a3b8' }}>
                          {p.gamesPlayed} מש׳ · {p.winRate}%
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Mini Awards 2x2 */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(2, 1fr)',
                    gap: '0.4rem',
                  }}
                >
                  {recap.awards.sniper && (
                    <div
                      style={{
                        background: 'rgba(255,255,255,0.04)',
                        borderRadius: '8px',
                        padding: '0.35rem 0.5rem',
                        fontSize: '0.72rem',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <span style={{ color: '#34d399', fontWeight: 700 }}>🎯 צלף:</span>
                      <span style={{ fontWeight: 700 }}>
                        {recap.awards.sniper.playerName} ({recap.awards.sniper.winRate}%)
                      </span>
                    </div>
                  )}
                  {recap.awards.bigHit && (
                    <div
                      style={{
                        background: 'rgba(255,255,255,0.04)',
                        borderRadius: '8px',
                        padding: '0.35rem 0.5rem',
                        fontSize: '0.72rem',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <span style={{ color: '#c084fc', fontWeight: 700 }}>💥 שיא ערב:</span>
                      <span style={{ fontWeight: 700 }}>
                        {recap.awards.bigHit.playerName} (+₪{recap.awards.bigHit.profit})
                      </span>
                    </div>
                  )}
                  {recap.awards.hotStreak && (
                    <div
                      style={{
                        background: 'rgba(255,255,255,0.04)',
                        borderRadius: '8px',
                        padding: '0.35rem 0.5rem',
                        fontSize: '0.72rem',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <span style={{ color: '#fb923c', fontWeight: 700 }}>🔥 רצף:</span>
                      <span style={{ fontWeight: 700 }}>
                        {recap.awards.hotStreak.playerName} ({recap.awards.hotStreak.streak} ברצף)
                      </span>
                    </div>
                  )}
                  {recap.awards.atm && (
                    <div
                      style={{
                        background: 'rgba(255,255,255,0.04)',
                        borderRadius: '8px',
                        padding: '0.35rem 0.5rem',
                        fontSize: '0.72rem',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <span style={{ color: '#fb7185', fontWeight: 700 }}>🏧 מממן:</span>
                      <span style={{ fontWeight: 700 }}>
                        {recap.awards.atm.playerName} ({recap.awards.atm.totalRebuys} כנ׳)
                      </span>
                    </div>
                  )}
                </div>

                {/* Full Ranked Table Preview (4th place onwards) */}
                {recap.allRanked.length > 3 && (
                  <div
                    style={{
                      marginTop: '0.55rem',
                      paddingTop: '0.45rem',
                      borderTop: '1px solid rgba(255, 255, 255, 0.08)',
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '0.35rem 0.65rem',
                      fontSize: '0.68rem',
                      color: '#cbd5e1',
                    }}
                  >
                    {recap.allRanked.slice(3, 9).map(p => (
                      <span key={p.playerId}>
                        {p.rank}. {p.playerName}{' '}
                        <span style={{ color: p.profit >= 0 ? '#4ade80' : '#f87171', direction: 'ltr', display: 'inline-block' }}>
                          ({p.profit >= 0 ? '+' : ''}₪{p.profit})
                        </span>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={handleShareInfographic}
                disabled={isSharing}
                style={{
                  width: '100%',
                  padding: '0.75rem',
                  borderRadius: '12px',
                  border: 'none',
                  background: 'linear-gradient(135deg, #10b981, #059669)',
                  color: '#ffffff',
                  fontWeight: 800,
                  fontSize: '0.95rem',
                  cursor: isSharing ? 'wait' : 'pointer',
                  fontFamily: 'inherit',
                  boxShadow: '0 4px 14px rgba(16, 185, 129, 0.35)',
                }}
              >
                {isSharing ? '📸 מכין תמונה לשיתוף...' : '📤 שתף כרטיס סיכום לוואטסאפ'}
              </button>
            </div>
          )}

          {/* Bottom Navigation Bar */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: '0.9rem',
              paddingTop: '0.65rem',
              borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            }}
          >
            <button
              type="button"
              onClick={prevSlide}
              disabled={slideIdx === 0}
              style={{
                background: slideIdx === 0 ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.1)',
                border: 'none',
                color: slideIdx === 0 ? '#475569' : '#f8fafc',
                padding: '0.45rem 0.85rem',
                borderRadius: '10px',
                fontSize: '0.8rem',
                fontWeight: 700,
                cursor: slideIdx === 0 ? 'default' : 'pointer',
                fontFamily: 'inherit',
              }}
            >
              → הקודם
            </button>

            <div style={{ display: 'flex', gap: '6px' }}>
              {Array.from({ length: SLIDE_COUNT }).map((_, i) => (
                <span
                  key={i}
                  onClick={() => setSlideIdx(i)}
                  style={{
                    width: i === slideIdx ? '18px' : '7px',
                    height: '7px',
                    borderRadius: '999px',
                    background: i === slideIdx ? '#fbbf24' : 'rgba(255,255,255,0.2)',
                    cursor: 'pointer',
                    transition: 'all 0.2s ease',
                  }}
                />
              ))}
            </div>

            {slideIdx < SLIDE_COUNT - 1 ? (
              <button
                type="button"
                onClick={nextSlide}
                style={{
                  background: 'linear-gradient(135deg, #f59e0b, #d97706)',
                  border: 'none',
                  color: '#0f172a',
                  padding: '0.45rem 0.95rem',
                  borderRadius: '10px',
                  fontSize: '0.8rem',
                  fontWeight: 800,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                הבא ←
              </button>
            ) : (
              <button
                type="button"
                onClick={onClose}
                style={{
                  background: 'rgba(255,255,255,0.12)',
                  border: 'none',
                  color: '#f8fafc',
                  padding: '0.45rem 0.95rem',
                  borderRadius: '10px',
                  fontSize: '0.8rem',
                  fontWeight: 700,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                סגור ✓
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default PeriodRecapModal;

