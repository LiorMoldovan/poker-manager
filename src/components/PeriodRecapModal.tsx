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
import { StyledSelect, type StyledSelectOption } from './StyledSelect';

interface PeriodRecapModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialPeriodType: RecapPeriodType;
  initialYear: number;
  initialMonth?: number;
}

const SLIDE_COUNT = 2;
const SLIDE_TITLES = [
  'פודיום ואלופים',
  'נבחרת התארים ושיתוף',
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

  const slide0CardRef = useRef<HTMLDivElement>(null);
  const slide1CardRef = useRef<HTMLDivElement>(null);
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

  const periodOptions = useMemo<StyledSelectOption<string>[]>(() => {
    return availablePeriods.map(p => ({
      value: p.key,
      label: `${p.label} (${p.gamesCount} מש׳)`,
    }));
  }, [availablePeriods]);

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

  const handleShareInfographic = async (targetIdx: number = slideIdx) => {
    if (isSharing) return;
    setIsSharing(true);
    try {
      const targetEl = targetIdx === 0 ? slide0CardRef.current : slide1CardRef.current;
      if (targetEl) {
        const canvas = await html2canvas(targetEl, {
          backgroundColor: '#0f172a',
          scale: 2,
          useCORS: true,
          logging: false,
        });
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
        if (blob) {
          const suffix = targetIdx === 0 ? 'podium' : 'awards';
          const file = new File([blob], `poker-recap-${recap.periodKey}-${suffix}.png`, { type: 'image/png' });
          await shareFiles([file], `${recap.title} - ${targetIdx === 0 ? 'פודיום ואלופים' : 'נבחרת התארים'}`);
        }
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
    // In RTL, swipe forward or backward
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
          maxWidth: '420px',
          maxHeight: '92vh',
          background: '#0f172a',
          borderRadius: '18px',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          boxShadow: '0 20px 50px rgba(0, 0, 0, 0.75)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          color: '#f8fafc',
        }}
      >
        {/* Stories Progress Bars (2 segments) */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${SLIDE_COUNT}, 1fr)`,
            gap: '6px',
            padding: '0.65rem 0.85rem 0.35rem',
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
                    ? '#10b981'
                    : i < slideIdx
                    ? 'rgba(16, 185, 129, 0.45)'
                    : 'rgba(255, 255, 255, 0.16)',
                transition: 'all 0.25s ease',
              }}
              aria-label={SLIDE_TITLES[i]}
            />
          ))}
        </div>

        {/* Clean Header Bar: Right side has dropdown, Left side has Close button */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0.4rem 0.85rem',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            gap: '0.6rem',
          }}
        >
          {/* Period selector */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: '1.1rem', flexShrink: 0 }}>🎬</span>
            {availablePeriods.length > 1 ? (
              <StyledSelect<string>
                value={currentKey}
                onChange={handlePeriodSelect}
                options={periodOptions}
                size="sm"
                variant="default"
              />
            ) : (
              <span
                style={{
                  fontWeight: 700,
                  fontSize: '0.88rem',
                  color: '#f8fafc',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {recap.title}
              </span>
            )}
          </div>

          {/* Close button */}
          <button
            type="button"
            onClick={onClose}
            aria-label="סגור"
            style={{
              background: 'rgba(255, 255, 255, 0.08)',
              border: 'none',
              color: '#e2e8f0',
              width: '28px',
              height: '28px',
              borderRadius: '50%',
              fontSize: '1.15rem',
              lineHeight: 1,
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

        {/* Slide Counter / Title Banner */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0.3rem 0.85rem',
            background: 'rgba(255, 255, 255, 0.02)',
            borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
            fontSize: '0.72rem',
            color: '#94a3b8',
          }}
        >
          <span style={{ fontWeight: 700, color: '#38bdf8' }}>
            {slideIdx + 1} מתוך {SLIDE_COUNT} · {SLIDE_TITLES[slideIdx]}
          </span>
          <span style={{ color: '#64748b' }}>החלק לדפדוף</span>
        </div>

        {/* Slide Body */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '0.85rem',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            minHeight: '390px',
          }}
        >
          {/* SLIDE 0: Podium & Overview */}
          {slideIdx === 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              {/* Shareable Podium Card */}
              <div
                ref={slide0CardRef}
                style={{
                  background: 'linear-gradient(165deg, #0f172a 0%, #1e293b 100%)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  borderRadius: '14px',
                  padding: '0.75rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.65rem',
                }}
              >
                {/* Header for shared image */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                    paddingBottom: '0.4rem',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                    <span style={{ fontSize: '1rem' }}>🏆</span>
                    <span style={{ fontSize: '0.92rem', fontWeight: 800, color: '#ffffff' }}>
                      אלופי התקופה — {recap.shortLabel}
                    </span>
                  </div>
                  <span style={{ fontSize: '0.68rem', color: '#94a3b8' }}>
                    {recap.gamesCount} משחקים
                  </span>
                </div>

                {/* Quick stats chips */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(3, 1fr)',
                    gap: '0.45rem',
                  }}
                >
                  <div
                    style={{
                      background: 'rgba(59, 130, 246, 0.08)',
                      border: '1px solid rgba(59, 130, 246, 0.22)',
                      borderRadius: '10px',
                      padding: '0.45rem 0.3rem',
                      textAlign: 'center',
                    }}
                  >
                    <div style={{ fontSize: '1.1rem', fontWeight: 900, color: '#60a5fa' }}>
                      {recap.gamesCount}
                    </div>
                    <div style={{ fontSize: '0.68rem', color: '#94a3b8' }}>ערבי משחק</div>
                  </div>

                  <div
                    style={{
                      background: 'rgba(16, 185, 129, 0.08)',
                      border: '1px solid rgba(16, 185, 129, 0.22)',
                      borderRadius: '10px',
                      padding: '0.45rem 0.3rem',
                      textAlign: 'center',
                    }}
                  >
                    <div style={{ fontSize: '1.1rem', fontWeight: 900, color: '#34d399' }}>
                      {recap.allRanked.length}
                    </div>
                    <div style={{ fontSize: '0.68rem', color: '#94a3b8' }}>שחקנים פעילים</div>
                  </div>

                  <div
                    style={{
                      background: 'rgba(168, 85, 247, 0.08)',
                      border: '1px solid rgba(168, 85, 247, 0.22)',
                      borderRadius: '10px',
                      padding: '0.45rem 0.3rem',
                      textAlign: 'center',
                    }}
                  >
                    <div style={{ fontSize: '1.05rem', fontWeight: 900, color: '#c084fc', direction: 'ltr' }}>
                      {recap.awards.bigHit ? `+₪${recap.awards.bigHit.profit}` : '—'}
                    </div>
                    <div style={{ fontSize: '0.68rem', color: '#94a3b8' }}>שיא ערב</div>
                  </div>
                </div>

                {/* Champion Hero Card */}
                {champ && (
                  <div
                    style={{
                      background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.16), rgba(30, 41, 59, 0.8))',
                      border: '1.5px solid rgba(245, 158, 11, 0.45)',
                      borderRadius: '14px',
                      padding: '0.85rem',
                      textAlign: 'center',
                      position: 'relative',
                    }}
                  >
                    <div style={{ fontSize: '1.8rem', lineHeight: 1 }}>🥇 👑</div>
                    <div style={{ fontSize: '0.74rem', color: '#fbbf24', fontWeight: 800, marginTop: '0.2rem' }}>
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
                        fontWeight: 900,
                        color: '#4ade80',
                        marginTop: '0.1rem',
                        direction: 'ltr',
                      }}
                    >
                      +₪{champ.profit.toLocaleString('he-IL')}
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'center',
                        gap: '0.65rem',
                        marginTop: '0.45rem',
                        fontSize: '0.74rem',
                        color: '#cbd5e1',
                      }}
                    >
                      <span>🎮 {champ.gamesPlayed} משחקים</span>
                      <span>🎯 {champ.winRate}% ניצחונות</span>
                      <span>📈 ₪{champ.avgProfit} לערב</span>
                    </div>
                  </div>
                )}

                {/* Runners up 2nd & 3rd */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.55rem' }}>
                  {second && (
                    <div
                      style={{
                        background: 'rgba(255, 255, 255, 0.04)',
                        border: '1px solid rgba(203, 213, 225, 0.28)',
                        borderRadius: '12px',
                        padding: '0.65rem 0.5rem',
                        textAlign: 'center',
                      }}
                    >
                      <div style={{ fontSize: '1.3rem' }}>🥈</div>
                      <div style={{ fontSize: '0.7rem', color: '#cbd5e1', fontWeight: 700 }}>סגן האלוף</div>
                      <div style={{ fontSize: '1rem', fontWeight: 800, color: '#ffffff', marginTop: '0.1rem' }}>
                        {second.playerName}
                      </div>
                      <div
                        style={{
                          fontSize: '0.95rem',
                          fontWeight: 800,
                          color: second.profit >= 0 ? '#4ade80' : '#f87171',
                          direction: 'ltr',
                          marginTop: '0.1rem',
                        }}
                      >
                        {second.profit >= 0 ? '+' : ''}₪{second.profit.toLocaleString('he-IL')}
                      </div>
                      <div style={{ fontSize: '0.66rem', color: '#94a3b8', marginTop: '0.15rem' }}>
                        {second.gamesPlayed} מש׳ · {second.winRate}% ניצחון
                      </div>
                    </div>
                  )}

                  {third && (
                    <div
                      style={{
                        background: 'rgba(255, 255, 255, 0.04)',
                        border: '1px solid rgba(217, 119, 6, 0.3)',
                        borderRadius: '12px',
                        padding: '0.65rem 0.5rem',
                        textAlign: 'center',
                      }}
                    >
                      <div style={{ fontSize: '1.3rem' }}>🥉</div>
                      <div style={{ fontSize: '0.7rem', color: '#fdba74', fontWeight: 700 }}>מקום שלישי</div>
                      <div style={{ fontSize: '1rem', fontWeight: 800, color: '#ffffff', marginTop: '0.1rem' }}>
                        {third.playerName}
                      </div>
                      <div
                        style={{
                          fontSize: '0.95rem',
                          fontWeight: 800,
                          color: third.profit >= 0 ? '#4ade80' : '#f87171',
                          direction: 'ltr',
                          marginTop: '0.1rem',
                        }}
                      >
                        {third.profit >= 0 ? '+' : ''}₪{third.profit.toLocaleString('he-IL')}
                      </div>
                      <div style={{ fontSize: '0.66rem', color: '#94a3b8', marginTop: '0.15rem' }}>
                        {third.gamesPlayed} מש׳ · {third.winRate}% ניצחון
                      </div>
                    </div>
                  )}
                </div>

                {/* Honorable mentions (ranks 4-6) */}
                {recap.allRanked.length > 3 && (
                  <div
                    style={{
                      paddingTop: '0.4rem',
                      borderTop: '1px solid rgba(255, 255, 255, 0.07)',
                      display: 'flex',
                      flexWrap: 'wrap',
                      justifyContent: 'center',
                      gap: '0.35rem 0.65rem',
                      fontSize: '0.68rem',
                      color: '#94a3b8',
                    }}
                  >
                    {recap.allRanked.slice(3, 6).map(p => (
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

              {/* Small and elegant WhatsApp Share CTA for Slide 1 */}
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: '0.35rem' }}>
                <button
                  type="button"
                  onClick={() => handleShareInfographic(0)}
                  disabled={isSharing}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.45rem',
                    background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.22), rgba(16, 185, 129, 0.1))',
                    border: '1px solid rgba(16, 185, 129, 0.45)',
                    color: '#34d399',
                    borderRadius: '999px',
                    padding: '0.45rem 1.15rem',
                    fontSize: '0.82rem',
                    fontWeight: 700,
                    cursor: isSharing ? 'wait' : 'pointer',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
                    transition: 'all 0.2s ease',
                    fontFamily: 'inherit',
                  }}
                >
                  <span style={{ fontSize: '0.95rem' }}>📤</span>
                  <span>{isSharing ? 'מכין תמונה לשיתוף...' : 'שתף פודיום לוואטסאפ'}</span>
                </button>
              </div>
            </div>
          )}

          {/* SLIDE 1: Special Awards & WhatsApp Shareable Card (Combined, Clean, Zero Duplication) */}
          {slideIdx === 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              {/* Shareable Card Area */}
              <div
                ref={slide1CardRef}
                style={{
                  background: 'linear-gradient(165deg, #0f172a 0%, #1e293b 100%)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  borderRadius: '14px',
                  padding: '0.75rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.55rem',
                }}
              >
                {/* Header */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                    paddingBottom: '0.4rem',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                    <span style={{ fontSize: '1rem' }}>🎖️</span>
                    <span style={{ fontSize: '0.92rem', fontWeight: 800, color: '#ffffff' }}>
                      נבחרת התארים — {recap.shortLabel}
                    </span>
                  </div>
                  <span style={{ fontSize: '0.68rem', color: '#94a3b8' }}>
                    {recap.gamesCount} משחקים
                  </span>
                </div>

                {/* 2x2 Awards Grid - Crisp, single clear stat per award */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.45rem' }}>
                  {/* Sniper */}
                  {recap.awards.sniper && (
                    <div
                      style={{
                        background: 'rgba(16, 185, 129, 0.08)',
                        border: '1px solid rgba(52, 211, 153, 0.28)',
                        borderRadius: '10px',
                        padding: '0.55rem 0.45rem',
                        textAlign: 'center',
                      }}
                    >
                      <div style={{ fontSize: '1.25rem' }}>🎯</div>
                      <div style={{ fontSize: '0.68rem', fontWeight: 800, color: '#34d399' }}>צלף התקופה</div>
                      <div style={{ fontSize: '0.92rem', fontWeight: 800, color: '#ffffff', marginTop: '0.1rem' }}>
                        {recap.awards.sniper.playerName}
                      </div>
                      <div style={{ fontSize: '0.74rem', color: '#6ee7b7', marginTop: '0.1rem' }}>
                        {recap.awards.sniper.winRate}% הצלחה ({recap.awards.sniper.wins}/{recap.awards.sniper.games} מש׳)
                      </div>
                    </div>
                  )}

                  {/* Big Hit */}
                  {recap.awards.bigHit && (
                    <div
                      style={{
                        background: 'rgba(168, 85, 247, 0.08)',
                        border: '1px solid rgba(192, 132, 252, 0.28)',
                        borderRadius: '10px',
                        padding: '0.55rem 0.45rem',
                        textAlign: 'center',
                      }}
                    >
                      <div style={{ fontSize: '1.25rem' }}>💥</div>
                      <div style={{ fontSize: '0.68rem', fontWeight: 800, color: '#c084fc' }}>המכה הגדולה</div>
                      <div style={{ fontSize: '0.92rem', fontWeight: 800, color: '#ffffff', marginTop: '0.1rem' }}>
                        {recap.awards.bigHit.playerName}
                      </div>
                      <div style={{ fontSize: '0.74rem', color: '#e9d5ff', marginTop: '0.1rem', direction: 'ltr' }}>
                        +₪{recap.awards.bigHit.profit.toLocaleString('he-IL')} בערב ({recap.awards.bigHit.date})
                      </div>
                    </div>
                  )}

                  {/* Hot Streak / Top Average */}
                  {recap.awards.hotStreak ? (
                    <div
                      style={{
                        background: 'rgba(249, 115, 22, 0.08)',
                        border: '1px solid rgba(251, 146, 60, 0.28)',
                        borderRadius: '10px',
                        padding: '0.55rem 0.45rem',
                        textAlign: 'center',
                      }}
                    >
                      <div style={{ fontSize: '1.25rem' }}>🔥</div>
                      <div style={{ fontSize: '0.68rem', fontWeight: 800, color: '#fb923c' }}>הרצף החם</div>
                      <div style={{ fontSize: '0.92rem', fontWeight: 800, color: '#ffffff', marginTop: '0.1rem' }}>
                        {recap.awards.hotStreak.playerName}
                      </div>
                      <div style={{ fontSize: '0.74rem', color: '#fed7aa', marginTop: '0.1rem' }}>
                        {recap.awards.hotStreak.streak} ניצחונות ברצף
                      </div>
                    </div>
                  ) : (
                    <div
                      style={{
                        background: 'rgba(56, 189, 248, 0.08)',
                        border: '1px solid rgba(56, 189, 248, 0.25)',
                        borderRadius: '10px',
                        padding: '0.55rem 0.45rem',
                        textAlign: 'center',
                      }}
                    >
                      <div style={{ fontSize: '1.25rem' }}>⚡</div>
                      <div style={{ fontSize: '0.68rem', fontWeight: 800, color: '#38bdf8' }}>ממוצע לערב</div>
                      <div style={{ fontSize: '0.92rem', fontWeight: 800, color: '#ffffff', marginTop: '0.1rem' }}>
                        {champ?.playerName || '—'}
                      </div>
                      <div style={{ fontSize: '0.74rem', color: '#bae6fd', marginTop: '0.1rem', direction: 'ltr' }}>
                        +₪{champ?.avgProfit || 0} לערב
                      </div>
                    </div>
                  )}

                  {/* Rebuy King / Most Entries */}
                  {recap.awards.atm && (
                    <div
                      style={{
                        background: 'rgba(245, 158, 11, 0.08)',
                        border: '1px solid rgba(251, 191, 36, 0.3)',
                        borderRadius: '10px',
                        padding: '0.55rem 0.45rem',
                        textAlign: 'center',
                      }}
                    >
                      <div style={{ fontSize: '1.25rem' }}>🔄</div>
                      <div style={{ fontSize: '0.68rem', fontWeight: 800, color: '#fbbf24' }}>מלך הריבאי</div>
                      <div style={{ fontSize: '0.92rem', fontWeight: 800, color: '#ffffff', marginTop: '0.1rem' }}>
                        {recap.awards.atm.playerName}
                      </div>
                      <div style={{ fontSize: '0.74rem', color: '#fde68a', marginTop: '0.1rem' }}>
                        {recap.awards.atm.totalRebuys} קניות{' '}
                        <span style={{ color: recap.awards.atm.profit >= 0 ? '#4ade80' : '#94a3b8', direction: 'ltr', display: 'inline-block' }}>
                          ({recap.awards.atm.profit >= 0 ? '+' : ''}₪{recap.awards.atm.profit.toLocaleString('he-IL')})
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                {/* AI Commentary quote (if generated) */}
                {aiText && (
                  <div
                    style={{
                      background: 'rgba(255, 255, 255, 0.04)',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      borderRadius: '10px',
                      padding: '0.6rem 0.75rem',
                    }}
                  >
                    <div style={{ fontSize: '0.74rem', color: '#38bdf8', fontWeight: 700, marginBottom: '0.2rem' }}>
                      🎙️ דבר הפרשן
                    </div>
                    <div style={{ fontSize: '0.74rem', color: '#f1f5f9', lineHeight: 1.5, whiteSpace: 'pre-line' }}>
                      {aiText}
                    </div>
                    {canGenerateAI && (
                      <div style={{ textAlign: 'left', marginTop: '0.25rem' }}>
                        <button
                          type="button"
                          onClick={handleGenerateAI}
                          disabled={aiLoading}
                          style={{
                            background: 'transparent',
                            border: '1px solid rgba(255,255,255,0.18)',
                            color: '#cbd5e1',
                            borderRadius: '6px',
                            padding: '0.15rem 0.45rem',
                            fontSize: '0.64rem',
                            cursor: 'pointer',
                            fontFamily: 'inherit',
                          }}
                        >
                          {aiLoading ? 'מעדכן...' : '🔄 צור מחדש'}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Generate AI button if not generated yet */}
              {!aiText && canGenerateAI && (
                <button
                  type="button"
                  onClick={handleGenerateAI}
                  disabled={aiLoading}
                  style={{
                    background: 'rgba(59, 130, 246, 0.12)',
                    border: '1px solid rgba(59, 130, 246, 0.35)',
                    color: '#60a5fa',
                    borderRadius: '8px',
                    padding: '0.45rem',
                    fontSize: '0.74rem',
                    fontWeight: 700,
                    cursor: aiLoading ? 'wait' : 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  {aiLoading ? '✨ מייצר פרשנות AI...' : '✨ הוסף פרשנות AI לכרטיס'}
                </button>
              )}
              {aiError && (
                <div style={{ fontSize: '0.7rem', color: '#fca5a5', textAlign: 'center' }}>
                  {aiError}
                </div>
              )}

              {/* Small and elegant WhatsApp Share CTA */}
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: '0.35rem' }}>
                <button
                  type="button"
                  onClick={() => handleShareInfographic(1)}
                  disabled={isSharing}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.45rem',
                    background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.22), rgba(16, 185, 129, 0.1))',
                    border: '1px solid rgba(16, 185, 129, 0.45)',
                    color: '#34d399',
                    borderRadius: '999px',
                    padding: '0.45rem 1.15rem',
                    fontSize: '0.82rem',
                    fontWeight: 700,
                    cursor: isSharing ? 'wait' : 'pointer',
                    boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
                    transition: 'all 0.2s ease',
                    fontFamily: 'inherit',
                  }}
                >
                  <span style={{ fontSize: '0.95rem' }}>📤</span>
                  <span>{isSharing ? 'מכין תמונה לשיתוף...' : 'שתף תארים לוואטסאפ'}</span>
                </button>
              </div>
            </div>
          )}

          {/* Bottom Navigation */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: '0.85rem',
              paddingTop: '0.65rem',
              borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            }}
          >
            <button
              type="button"
              onClick={prevSlide}
              disabled={slideIdx === 0}
              style={{
                background: slideIdx === 0 ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.08)',
                border: 'none',
                color: slideIdx === 0 ? '#475569' : '#f8fafc',
                padding: '0.4rem 0.8rem',
                borderRadius: '8px',
                fontSize: '0.78rem',
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
                    width: i === slideIdx ? '16px' : '6px',
                    height: '6px',
                    borderRadius: '999px',
                    background: i === slideIdx ? '#10b981' : 'rgba(255,255,255,0.2)',
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
                  background: 'rgba(59, 130, 246, 0.2)',
                  border: '1px solid rgba(59, 130, 246, 0.4)',
                  color: '#60a5fa',
                  padding: '0.4rem 0.85rem',
                  borderRadius: '8px',
                  fontSize: '0.78rem',
                  fontWeight: 700,
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
                  background: 'rgba(255,255,255,0.1)',
                  border: 'none',
                  color: '#f8fafc',
                  padding: '0.4rem 0.85rem',
                  borderRadius: '8px',
                  fontSize: '0.78rem',
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
