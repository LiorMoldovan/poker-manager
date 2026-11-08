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

  const [aiText, setAiText] = useState<string>('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [isSharing, setIsSharing] = useState(false);
  const [showAllPlayersModal, setShowAllPlayersModal] = useState(false);

  const part1Ref = useRef<HTMLDivElement>(null);
  const part2Ref = useRef<HTMLDivElement>(null);
  const part3Ref = useRef<HTMLDivElement>(null);
  const part4Ref = useRef<HTMLDivElement>(null);
  const autoGenAttemptedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (isOpen) {
      setPeriodType(initialPeriodType);
      setYear(initialYear);
      setMonth(initialMonth);
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

  // Load saved AI narrative from graph_insights when period changes, or auto-generate if missing
  useEffect(() => {
    if (!recap) {
      setAiText('');
      setAiError(null);
      return;
    }
    let cancelled = false;
    const targetPeriodKey = recap.periodKey;
    const saved = getGraphInsights(targetPeriodKey);

    if (saved?.text) {
      setAiText(saved.text);
      setAiError(null);
    } else {
      setAiText('');
      setAiError(null);
      // Auto-generate if eligible, key is available, and not already attempted in this session
      if (canGenerateAI && getGeminiApiKey() && !autoGenAttemptedRef.current.has(targetPeriodKey)) {
        autoGenAttemptedRef.current.add(targetPeriodKey);
        (async () => {
          setAiLoading(true);
          try {
            const res = await generatePeriodRecapAI(recap);
            if (!cancelled) {
              setAiText(res.text);
            }
            saveGraphInsights(targetPeriodKey, res.text, res.model);
          } catch (err) {
            if (!cancelled) {
              console.error('Auto recap AI error:', err);
              setAiError(err instanceof Error ? err.message : 'שגיאה ביצירת סיכום AI');
            }
          } finally {
            if (!cancelled) {
              setAiLoading(false);
            }
          }
        })();
      }
    }

    return () => {
      cancelled = true;
    };
  }, [recap, canGenerateAI]);

  if (!isOpen || !recap) return null;

  const currentKey = buildPeriodKey(periodType, year, month);

  const handlePeriodSelect = (selectedKey: string) => {
    const found = availablePeriods.find(p => p.key === selectedKey);
    if (!found) return;
    setPeriodType(found.periodType);
    setYear(found.year);
    setMonth(found.month);
  };

  const handleGenerateAI = async () => {
    if (!recap || aiLoading) return;
    if (!getGeminiApiKey()) {
      setAiError('מפתח Gemini API לא מוגדר בהגדרות הקבוצה');
      return;
    }
    setAiLoading(true);
    setAiError(null);
    const targetPeriodKey = recap.periodKey;
    try {
      const res = await generatePeriodRecapAI(recap);
      if (recap.periodKey === targetPeriodKey) {
        setAiText(res.text);
      }
      saveGraphInsights(targetPeriodKey, res.text, res.model);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'שגיאה ביצירת סיכום AI');
    } finally {
      setAiLoading(false);
    }
  };

  const handleShareInfographic = async () => {
    if (isSharing) return;
    setIsSharing(true);
    try {
      const files: File[] = [];

      const captureCard = async (ref: React.RefObject<HTMLDivElement | null>, filename: string) => {
        if (!ref.current) return;
        const c = await html2canvas(ref.current, {
          backgroundColor: '#0f172a',
          scale: 2,
          useCORS: true,
          logging: false,
        });
        const blob = await new Promise<Blob | null>(resolve => c.toBlob(resolve, 'image/png'));
        if (blob) {
          files.push(new File([blob], filename, { type: 'image/png' }));
        }
      };

      // Part 1: Podium & Full Standings
      await captureCard(part1Ref, `poker-recap-${recap.periodKey}-1-podium.png`);

      // Part 2: Breakthrough Records & Milestones (if any)
      if (recap.records && recap.records.length > 0) {
        await captureCard(part2Ref, `poker-recap-${recap.periodKey}-2-records.png`);
      }

      // Part 3: Stories & Standings Shifts (if any)
      if (recap.stories && recap.stories.length > 0) {
        await captureCard(part3Ref, `poker-recap-${recap.periodKey}-3-stories.png`);
      }

      // Part 4: AI Commentary (if generated)
      if (aiText) {
        await captureCard(part4Ref, `poker-recap-${recap.periodKey}-4-commentary.png`);
      }

      if (files.length > 0) {
        await shareFiles(files, recap.title);
      }
    } catch (err) {
      console.error('Share recap failed:', err);
    } finally {
      setIsSharing(false);
    }
  };

  const champ = recap.podium[0];
  const second = recap.podium[1];
  const third = recap.podium[2];

  const restRanked = recap.allRanked.slice(3);

  const partsCount =
    1 +
    (recap.records && recap.records.length > 0 ? 1 : 0) +
    (recap.stories && recap.stories.length > 0 ? 1 : 0) +
    (aiText ? 1 : 0);

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
        style={{
          width: '100%',
          maxWidth: '430px',
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
        {/* Header Bar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0.5rem 0.85rem',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            gap: '0.6rem',
            background: 'rgba(30, 41, 59, 0.5)',
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

        {/* Scrollable Recap Content */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '0.85rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.85rem',
          }}
        >
          {/* Card Part 1: הפודיום והדירוג (Captured as Part 1 for WhatsApp) */}
          <div
            ref={part1Ref}
            style={{
              background: 'linear-gradient(165deg, #0f172a 0%, #1e293b 100%)',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              borderRadius: '16px',
              padding: '0.85rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.65rem',
            }}
          >
            {/* Infographic Header Part 1 */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                paddingBottom: '0.4rem',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <span style={{ fontSize: '1.15rem' }}>🏆</span>
                <div>
                  <div style={{ fontSize: '0.98rem', fontWeight: 900, color: '#ffffff' }}>
                    {recap.title}
                  </div>
                  <div style={{ fontSize: '0.66rem', color: '#94a3b8' }}>
                    הפודיום וטבלת הדירוג
                  </div>
                </div>
              </div>

              <span
                style={{
                  fontSize: '0.72rem',
                  fontWeight: 800,
                  padding: '0.15rem 0.55rem',
                  borderRadius: '999px',
                  background: 'rgba(56, 189, 248, 0.12)',
                  border: '1px solid rgba(56, 189, 248, 0.3)',
                  color: '#38bdf8',
                }}
              >
                {recap.shortLabel}
              </span>
            </div>

            {/* Overview Stats Strip: ערבי משחק | שחקנים שונים */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(2, 1fr)',
                gap: '0.45rem',
              }}
            >
              <div
                style={{
                  background: 'rgba(59, 130, 246, 0.08)',
                  border: '1px solid rgba(59, 130, 246, 0.22)',
                  borderRadius: '8px',
                  padding: '0.4rem 0.3rem',
                  textAlign: 'center',
                }}
              >
                <div style={{ fontSize: '1rem', fontWeight: 900, color: '#60a5fa' }}>
                  {recap.gamesCount}
                </div>
                <div style={{ fontSize: '0.64rem', color: '#94a3b8' }}>ערבי משחק</div>
              </div>

              <div
                onClick={() => setShowAllPlayersModal(true)}
                role="button"
                tabIndex={0}
                title="לחץ לצפייה ברשימת כל השחקנים ששיחקו בתקופה"
                style={{
                  background: 'rgba(16, 185, 129, 0.08)',
                  border: '1px solid rgba(16, 185, 129, 0.28)',
                  borderRadius: '8px',
                  padding: '0.4rem 0.3rem',
                  textAlign: 'center',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                }}
              >
                <div style={{ fontSize: '1rem', fontWeight: 900, color: '#34d399', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.2rem' }}>
                  <span>{recap.totalUniquePlayers}</span>
                  <span style={{ fontSize: '0.68rem', opacity: 0.85 }}>ℹ️</span>
                </div>
                <div style={{ fontSize: '0.62rem', color: '#94a3b8' }}>
                  שחקנים שונים <span style={{ color: '#34d399', fontSize: '0.56rem' }}>(לרשימה)</span>
                </div>
              </div>
            </div>

            {/* Compact Podium Card (Champion + Runners-up) */}
            <div
              style={{
                background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.12), rgba(30, 41, 59, 0.8))',
                border: '1px solid rgba(245, 158, 11, 0.35)',
                borderRadius: '12px',
                padding: '0.55rem 0.65rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.4rem',
              }}
            >
              {/* Champion spotlight row */}
              {champ && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '0.5rem',
                    borderBottom: '1px solid rgba(245, 158, 11, 0.2)',
                    paddingBottom: '0.35rem',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', minWidth: 0 }}>
                    <span style={{ fontSize: '1.25rem', lineHeight: 1 }}>🥇</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: '0.65rem', color: '#fbbf24', fontWeight: 800 }}>
                        {periodType === 'year'
                          ? `אלוף עונת ${year}`
                          : periodType === 'h1' || periodType === 'h2'
                          ? `אלוף ${recap.shortLabel}`
                          : `אלוף חודש ${recap.shortLabel}`}
                      </div>
                      <div
                        style={{
                          fontSize: '1.05rem',
                          fontWeight: 900,
                          color: '#ffffff',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {champ.playerName}
                      </div>
                    </div>
                  </div>

                  <div style={{ textAlign: 'left', flexShrink: 0 }}>
                    <div style={{ fontSize: '1.05rem', fontWeight: 900, color: '#4ade80', direction: 'ltr' }}>
                      +₪{champ.profit.toLocaleString('he-IL')}
                    </div>
                    <div style={{ fontSize: '0.62rem', color: '#cbd5e1' }}>
                      {champ.gamesPlayed} מש׳ · {champ.winRate}% הצלחה · ₪{champ.avgProfit}/ערב
                    </div>
                  </div>
                </div>
              )}

              {/* Runners-up 2nd & 3rd compact horizontal strip */}
              {(second || third) && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.4rem' }}>
                  {second && (
                    <div
                      style={{
                        background: 'rgba(255, 255, 255, 0.04)',
                        border: '1px solid rgba(203, 213, 225, 0.22)',
                        borderRadius: '8px',
                        padding: '0.3rem 0.45rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', minWidth: 0 }}>
                        <span style={{ fontSize: '0.95rem' }}>🥈</span>
                        <div style={{ minWidth: 0 }}>
                          <div
                            style={{
                              fontSize: '0.78rem',
                              fontWeight: 800,
                              color: '#ffffff',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {second.playerName}
                          </div>
                          <div style={{ fontSize: '0.58rem', color: '#94a3b8' }}>
                            {second.gamesPlayed} מש׳ · {second.winRate}%
                          </div>
                        </div>
                      </div>
                      <div
                        style={{
                          fontSize: '0.8rem',
                          fontWeight: 800,
                          color: second.profit >= 0 ? '#4ade80' : '#f87171',
                          direction: 'ltr',
                          flexShrink: 0,
                        }}
                      >
                        {second.profit >= 0 ? '+' : ''}₪{second.profit}
                      </div>
                    </div>
                  )}

                  {third && (
                    <div
                      style={{
                        background: 'rgba(255, 255, 255, 0.04)',
                        border: '1px solid rgba(217, 119, 6, 0.25)',
                        borderRadius: '8px',
                        padding: '0.3rem 0.45rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', minWidth: 0 }}>
                        <span style={{ fontSize: '0.95rem' }}>🥉</span>
                        <div style={{ minWidth: 0 }}>
                          <div
                            style={{
                              fontSize: '0.78rem',
                              fontWeight: 800,
                              color: '#ffffff',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {third.playerName}
                          </div>
                          <div style={{ fontSize: '0.58rem', color: '#94a3b8' }}>
                            {third.gamesPlayed} מש׳ · {third.winRate}%
                          </div>
                        </div>
                      </div>
                      <div
                        style={{
                          fontSize: '0.8rem',
                          fontWeight: 800,
                          color: third.profit >= 0 ? '#4ade80' : '#f87171',
                          direction: 'ltr',
                          flexShrink: 0,
                        }}
                      >
                        {third.profit >= 0 ? '+' : ''}₪{third.profit}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Vertical 2-Column Leaderboard for Remaining Players (4..N) */}
            {restRanked.length > 0 && (
              <div
                style={{
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid rgba(255, 255, 255, 0.07)',
                  borderRadius: '10px',
                  padding: '0.45rem 0.55rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.35rem',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.1rem' }}>
                  <div style={{ fontSize: '0.66rem', fontWeight: 800, color: '#94a3b8' }}>
                    📊 שאר השחקנים הפעילים ({recap.allRanked.length} בדירוג):
                  </div>
                  <div style={{ fontSize: '0.58rem', color: '#64748b' }}>
                    סף פעילות: {recap.activeThreshold} מש׳
                  </div>
                </div>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.24rem',
                  }}
                >
                  {restRanked.map(p => (
                    <div
                      key={p.playerId}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        background: 'rgba(255, 255, 255, 0.04)',
                        padding: '0.26rem 0.55rem',
                        borderRadius: '6px',
                        border: '1px solid rgba(255, 255, 255, 0.05)',
                        fontSize: '0.72rem',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', minWidth: 0, flex: '1 1 auto' }}>
                        <span style={{ color: '#94a3b8', fontWeight: 800, fontSize: '0.66rem', minWidth: '1.4rem' }}>
                          #{p.rank}
                        </span>
                        <span
                          style={{
                            color: '#f1f5f9',
                            fontWeight: 700,
                            fontSize: '0.74rem',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {p.playerName}
                        </span>
                        <span style={{ color: '#64748b', fontSize: '0.6rem' }}>
                          ({p.gamesPlayed} מש׳ · {p.winRate}%)
                        </span>
                      </div>
                      <span
                        style={{
                          color: p.profit >= 0 ? '#4ade80' : '#f87171',
                          direction: 'ltr',
                          fontWeight: 700,
                          fontSize: '0.72rem',
                          flexShrink: 0,
                          padding: '0.08rem 0.4rem',
                          background: p.profit >= 0 ? 'rgba(74, 222, 128, 0.08)' : 'rgba(248, 113, 113, 0.08)',
                          borderRadius: '4px',
                        }}
                      >
                        {p.profit >= 0 ? '+' : ''}₪{p.profit}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Non-active players button (omitted during screenshot) */}
            {!isSharing && recap.nonActivePlayers && recap.nonActivePlayers.length > 0 && (
              <button
                type="button"
                onClick={() => setShowAllPlayersModal(true)}
                style={{
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px dashed rgba(255, 255, 255, 0.14)',
                  borderRadius: '8px',
                  padding: '0.35rem 0.5rem',
                  color: '#94a3b8',
                  fontSize: '0.64rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.35rem',
                  fontFamily: 'inherit',
                  width: '100%',
                }}
              >
                <span>👥</span>
                <span>
                  עוד {recap.nonActivePlayers.length} שחקנים ואורחים מתחת לסף הפעילות ({recap.activeThreshold} מש׳) — לחץ לצפייה
                </span>
              </button>
            )}
          </div>

          {/* Card Part 2: שבירת שיאים ותגליות (Captured as Part 2 for WhatsApp) */}
          {recap.records && recap.records.length > 0 && (
            <div
              ref={part2Ref}
              style={{
                background: 'linear-gradient(165deg, #0f172a 0%, #1e293b 100%)',
                border: '1px solid rgba(234, 179, 8, 0.28)',
                borderRadius: '16px',
                padding: '0.85rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.65rem',
              }}
            >
              {/* Header Part 2 */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                  paddingBottom: '0.4rem',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <span style={{ fontSize: '1.15rem' }}>⚡</span>
                  <div>
                    <div style={{ fontSize: '0.98rem', fontWeight: 900, color: '#ffffff' }}>
                      {recap.title}
                    </div>
                    <div style={{ fontSize: '0.66rem', color: '#facc15' }}>
                      שבירת שיאים ותגליות
                    </div>
                  </div>
                </div>

                <span
                  style={{
                    fontSize: '0.72rem',
                    fontWeight: 800,
                    padding: '0.15rem 0.55rem',
                    borderRadius: '999px',
                    background: 'rgba(234, 179, 8, 0.15)',
                    border: '1px solid rgba(234, 179, 8, 0.35)',
                    color: '#facc15',
                  }}
                >
                  שיאי מועדון
                </span>
              </div>

              {/* Records List */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                {recap.records.map(rec => (
                  <div
                    key={rec.id}
                    style={{
                      background: 'rgba(15, 23, 42, 0.7)',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      borderRadius: '10px',
                      padding: '0.45rem 0.6rem',
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '0.5rem',
                    }}
                  >
                    <span style={{ fontSize: '1.15rem', lineHeight: 1, marginTop: '0.05rem' }}>
                      {rec.icon}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.3rem' }}>
                        <span style={{ fontSize: '0.74rem', fontWeight: 800, color: '#f8fafc' }}>
                          {rec.title}
                        </span>
                        {rec.badge && (
                          <span
                            style={{
                              fontSize: '0.6rem',
                              fontWeight: 700,
                              padding: '0.06rem 0.4rem',
                              borderRadius: '999px',
                              background: 'rgba(234, 179, 8, 0.18)',
                              color: '#fef08a',
                              border: '1px solid rgba(234, 179, 8, 0.35)',
                            }}
                          >
                            {rec.badge}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '0.66rem', color: '#cbd5e1', lineHeight: 1.4, marginTop: '0.12rem' }}>
                        {rec.description}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Card Part 3: סיפורי התקופה ותנודות בדירוג (Captured as Part 3 for WhatsApp) */}
          {recap.stories && recap.stories.length > 0 && (
            <div
              ref={part3Ref}
              style={{
                background: 'linear-gradient(165deg, #0f172a 0%, #1e293b 100%)',
                border: '1px solid rgba(56, 189, 248, 0.25)',
                borderRadius: '16px',
                padding: '0.85rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.65rem',
              }}
            >
              {/* Header Part 3 */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                  paddingBottom: '0.4rem',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <span style={{ fontSize: '1.15rem' }}>📖</span>
                  <div>
                    <div style={{ fontSize: '0.98rem', fontWeight: 900, color: '#ffffff' }}>
                      {recap.title}
                    </div>
                    <div style={{ fontSize: '0.66rem', color: '#38bdf8' }}>
                      סיפורי מפתח ותנודות בדירוג
                    </div>
                  </div>
                </div>

                <span
                  style={{
                    fontSize: '0.72rem',
                    fontWeight: 800,
                    padding: '0.15rem 0.55rem',
                    borderRadius: '999px',
                    background: 'rgba(56, 189, 248, 0.12)',
                    border: '1px solid rgba(56, 189, 248, 0.35)',
                    color: '#38bdf8',
                  }}
                >
                  מהלכי עונה
                </span>
              </div>

              {/* Stories List */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                {recap.stories.map(st => (
                  <div
                    key={st.id}
                    style={{
                      background: 'rgba(15, 23, 42, 0.7)',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      borderRadius: '10px',
                      padding: '0.45rem 0.6rem',
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '0.5rem',
                    }}
                  >
                    <span style={{ fontSize: '1.15rem', lineHeight: 1, marginTop: '0.05rem' }}>
                      {st.icon}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.3rem' }}>
                        <span style={{ fontSize: '0.74rem', fontWeight: 800, color: '#f8fafc' }}>
                          {st.title}
                        </span>
                        {st.badge && (
                          <span
                            style={{
                              fontSize: '0.6rem',
                              fontWeight: 700,
                              padding: '0.06rem 0.4rem',
                              borderRadius: '999px',
                              background:
                                st.badgeVariant === 'green'
                                  ? 'rgba(16, 185, 129, 0.18)'
                                  : st.badgeVariant === 'red'
                                  ? 'rgba(239, 68, 68, 0.18)'
                                  : st.badgeVariant === 'purple'
                                  ? 'rgba(168, 85, 247, 0.18)'
                                  : st.badgeVariant === 'amber'
                                  ? 'rgba(245, 158, 11, 0.18)'
                                  : 'rgba(56, 189, 248, 0.18)',
                              color:
                                st.badgeVariant === 'green'
                                  ? '#6ee7b7'
                                  : st.badgeVariant === 'red'
                                  ? '#fca5a5'
                                  : st.badgeVariant === 'purple'
                                  ? '#d8b4fe'
                                  : st.badgeVariant === 'amber'
                                  ? '#fde68a'
                                  : '#7dd3fc',
                              border: '1px solid rgba(255, 255, 255, 0.12)',
                            }}
                          >
                            {st.badge}
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '0.66rem', color: '#cbd5e1', lineHeight: 1.4, marginTop: '0.12rem' }}>
                        {st.description}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Card Part 4: דבר הפרשן (Captured as Part 4 for WhatsApp) */}
          {(aiText || aiLoading) && (
            <div
              ref={part4Ref}
              style={{
                background: 'linear-gradient(165deg, #0f172a 0%, #1e293b 100%)',
                border: '1px solid rgba(168, 85, 247, 0.3)',
                borderRadius: '16px',
                padding: '0.85rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.65rem',
              }}
            >
              {/* Header Part 4 */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                  paddingBottom: '0.4rem',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <span style={{ fontSize: '1.15rem' }}>🎙️</span>
                  <div>
                    <div style={{ fontSize: '0.98rem', fontWeight: 900, color: '#ffffff' }}>
                      {recap.title}
                    </div>
                    <div style={{ fontSize: '0.66rem', color: '#c084fc' }}>
                      דבר הפרשן — ניתוח בלעדי
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <span
                    style={{
                      fontSize: '0.72rem',
                      fontWeight: 800,
                      padding: '0.15rem 0.55rem',
                      borderRadius: '999px',
                      background: 'rgba(168, 85, 247, 0.15)',
                      border: '1px solid rgba(168, 85, 247, 0.4)',
                      color: '#d8b4fe',
                    }}
                  >
                    טור הפרשן
                  </span>
                  {aiText && canGenerateAI && !isSharing && (
                    <button
                      type="button"
                      onClick={handleGenerateAI}
                      disabled={aiLoading}
                      title="יצירה מחדש של פרשנות AI"
                      style={{
                        background: 'transparent',
                        border: '1px solid rgba(255,255,255,0.18)',
                        color: '#cbd5e1',
                        borderRadius: '6px',
                        padding: '0.12rem 0.4rem',
                        fontSize: '0.62rem',
                        cursor: aiLoading ? 'wait' : 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      {aiLoading ? 'מעדכן...' : '🔄 צור מחדש'}
                    </button>
                  )}
                </div>
              </div>

              {/* Content Part 4 */}
              {aiLoading && !aiText ? (
                <div
                  style={{
                    background: 'rgba(168, 85, 247, 0.06)',
                    border: '1px dashed rgba(168, 85, 247, 0.3)',
                    borderRadius: '10px',
                    padding: '0.75rem 0.85rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.6rem',
                  }}
                >
                  <span style={{ fontSize: '1.1rem' }}>✨</span>
                  <div style={{ fontSize: '0.72rem', color: '#cbd5e1' }}>
                    הפרשן מנתח את מהלכי החודש ומנסח תובנות...
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    background: 'rgba(15, 23, 42, 0.7)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    borderRadius: '12px',
                    padding: '0.7rem 0.85rem',
                    fontSize: '0.74rem',
                    color: '#f8fafc',
                    lineHeight: 1.6,
                    whiteSpace: 'pre-line',
                  }}
                >
                  {aiText}
                </div>
              )}
            </div>
          )}

          {aiError && (
            <div style={{ textAlign: 'center', marginTop: '0.2rem' }}>
              <div style={{ fontSize: '0.7rem', color: '#fca5a5' }}>
                {aiError}
              </div>
              {canGenerateAI && (
                <button
                  type="button"
                  onClick={handleGenerateAI}
                  disabled={aiLoading}
                  style={{
                    background: 'transparent',
                    border: '1px solid rgba(255, 255, 255, 0.2)',
                    color: '#93c5fd',
                    borderRadius: '6px',
                    padding: '0.2rem 0.55rem',
                    fontSize: '0.66rem',
                    marginTop: '0.35rem',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  🔄 נסה שוב
                </button>
              )}
            </div>
          )}

          {/* WhatsApp Share CTA Button - Clean & Elegant */}
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: '0.2rem', paddingBottom: '0.5rem' }}>
            <button
              type="button"
              onClick={handleShareInfographic}
              disabled={isSharing}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.45rem',
                background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.22), rgba(16, 185, 129, 0.1))',
                border: '1px solid rgba(16, 185, 129, 0.45)',
                color: '#34d399',
                borderRadius: '999px',
                padding: '0.55rem 1.4rem',
                fontSize: '0.84rem',
                fontWeight: 700,
                cursor: isSharing ? 'wait' : 'pointer',
                boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
                transition: 'all 0.2s ease',
                fontFamily: 'inherit',
              }}
            >
              <span style={{ fontSize: '0.95rem' }}>📤</span>
              <span>
                {isSharing
                  ? `מכין ${partsCount} תמונות לשיתוף...`
                  : `שתף סיכום בוואטסאפ (${partsCount} חלקים)`}
              </span>
            </button>
          </div>
        </div>
      </div>

      {/* Detailed Modal: All Players in Period */}
      {showAllPlayersModal && (
        <div
          onClick={() => setShowAllPlayersModal(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(2, 6, 23, 0.85)',
            backdropFilter: 'blur(6px)',
            zIndex: 10000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1rem',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: '420px',
              maxHeight: '82vh',
              background: '#0f172a',
              border: '1px solid rgba(255, 255, 255, 0.15)',
              borderRadius: '16px',
              boxShadow: '0 20px 40px rgba(0,0,0,0.8)',
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              direction: 'rtl',
            }}
          >
            {/* Header */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0.75rem 1rem',
                borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                background: 'rgba(30, 41, 59, 0.6)',
              }}
            >
              <div>
                <div style={{ fontSize: '0.92rem', fontWeight: 900, color: '#f8fafc' }}>
                  כל השחקנים ב{recap.shortLabel}
                </div>
                <div style={{ fontSize: '0.64rem', color: '#94a3b8' }}>
                  {recap.totalUniquePlayers} שחקנים שונים שיחקו ב-{recap.gamesCount} ערבים
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowAllPlayersModal(false)}
                style={{
                  background: 'rgba(255, 255, 255, 0.08)',
                  border: 'none',
                  color: '#e2e8f0',
                  width: '26px',
                  height: '26px',
                  borderRadius: '50%',
                  fontSize: '1rem',
                  lineHeight: 1,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                ×
              </button>
            </div>

            {/* Content List */}
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: '0.75rem 0.85rem',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.75rem',
              }}
            >
              {/* Section 1: Active Players */}
              <div>
                <div style={{ fontSize: '0.7rem', fontWeight: 800, color: '#38bdf8', marginBottom: '0.35rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span>🏆 שחקנים פעילים ({recap.allRanked.length})</span>
                  <span style={{ fontSize: '0.6rem', color: '#64748b' }}>מינימום {recap.activeThreshold} משחקים</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  {recap.allRanked.map(p => (
                    <div
                      key={p.playerId}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        background: 'rgba(255, 255, 255, 0.04)',
                        border: '1px solid rgba(255, 255, 255, 0.06)',
                        borderRadius: '6px',
                        padding: '0.25rem 0.5rem',
                        fontSize: '0.72rem',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <span style={{ color: p.rank <= 3 ? '#fbbf24' : '#94a3b8', fontWeight: 800, fontSize: '0.68rem' }}>
                          #{p.rank}
                        </span>
                        <span style={{ color: '#f8fafc', fontWeight: 700 }}>{p.playerName}</span>
                        <span style={{ color: '#64748b', fontSize: '0.6rem' }}>
                          ({p.gamesPlayed} מש׳ · {p.winRate}%)
                        </span>
                      </div>
                      <span
                        style={{
                          color: p.profit >= 0 ? '#4ade80' : '#f87171',
                          direction: 'ltr',
                          fontWeight: 800,
                        }}
                      >
                        {p.profit >= 0 ? '+' : ''}₪{p.profit}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Section 2: Non-active players & guests */}
              {recap.nonActivePlayers && recap.nonActivePlayers.length > 0 && (
                <div>
                  <div style={{ fontSize: '0.7rem', fontWeight: 800, color: '#94a3b8', marginBottom: '0.35rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span>👤 שחקנים נוספים ואורחים ({recap.nonActivePlayers.length})</span>
                    <span style={{ fontSize: '0.6rem', color: '#64748b' }}>פחות מ-{recap.activeThreshold} משחקים</span>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                    {recap.nonActivePlayers.map(p => (
                      <div
                        key={p.playerId}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          background: 'rgba(255, 255, 255, 0.02)',
                          border: '1px solid rgba(255, 255, 255, 0.04)',
                          borderRadius: '6px',
                          padding: '0.25rem 0.5rem',
                          fontSize: '0.7rem',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                          <span style={{ color: '#cbd5e1', fontWeight: 600 }}>{p.playerName}</span>
                          <span style={{ color: '#64748b', fontSize: '0.6rem' }}>
                            ({p.gamesPlayed} מש׳)
                          </span>
                        </div>
                        <span
                          style={{
                            color: p.profit >= 0 ? '#4ade80' : '#f87171',
                            direction: 'ltr',
                            fontWeight: 700,
                          }}
                        >
                          {p.profit >= 0 ? '+' : ''}₪{p.profit}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div style={{ padding: '0.5rem 0.85rem', borderTop: '1px solid rgba(255, 255, 255, 0.08)', textAlign: 'center' }}>
              <button
                type="button"
                onClick={() => setShowAllPlayersModal(false)}
                style={{
                  background: 'rgba(255, 255, 255, 0.08)',
                  border: '1px solid rgba(255, 255, 255, 0.15)',
                  color: '#cbd5e1',
                  borderRadius: '6px',
                  padding: '0.35rem 1.2rem',
                  fontSize: '0.74rem',
                  fontWeight: 700,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                סגור
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PeriodRecapModal;
