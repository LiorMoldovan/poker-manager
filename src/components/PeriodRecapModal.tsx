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

  const part1Ref = useRef<HTMLDivElement>(null);
  const part2Ref = useRef<HTMLDivElement>(null);
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

      // Capture Part 1 (Podium & Standings)
      if (part1Ref.current) {
        const c1 = await html2canvas(part1Ref.current, {
          backgroundColor: '#0f172a',
          scale: 2,
          useCORS: true,
          logging: false,
        });
        const blob1 = await new Promise<Blob | null>(resolve => c1.toBlob(resolve, 'image/png'));
        if (blob1) {
          files.push(new File([blob1], `poker-recap-${recap.periodKey}-part1.png`, { type: 'image/png' }));
        }
      }

      // Capture Part 2 (Records, Awards & AI Commentary)
      if (part2Ref.current) {
        const c2 = await html2canvas(part2Ref.current, {
          backgroundColor: '#0f172a',
          scale: 2,
          useCORS: true,
          logging: false,
        });
        const blob2 = await new Promise<Blob | null>(resolve => c2.toBlob(resolve, 'image/png'));
        if (blob2) {
          files.push(new File([blob2], `poker-recap-${recap.periodKey}-part2.png`, { type: 'image/png' }));
        }
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
  const halfRest = Math.ceil(restRanked.length / 2);
  const restCol1 = restRanked.slice(0, halfRest);
  const restCol2 = restRanked.slice(halfRest);

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
                    חלק א׳: הפודיום והדירוג
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
                style={{
                  background: 'rgba(16, 185, 129, 0.08)',
                  border: '1px solid rgba(16, 185, 129, 0.22)',
                  borderRadius: '8px',
                  padding: '0.4rem 0.3rem',
                  textAlign: 'center',
                }}
              >
                <div style={{ fontSize: '1rem', fontWeight: 900, color: '#34d399' }}>
                  {recap.allRanked.length}
                </div>
                <div style={{ fontSize: '0.64rem', color: '#94a3b8' }}>שחקנים שונים</div>
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
                <div style={{ fontSize: '0.66rem', fontWeight: 800, color: '#94a3b8' }}>
                  📊 שאר הדירוג בתקופה:
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: restRanked.length >= 2 ? 'repeat(2, 1fr)' : '1fr',
                    gap: '0.25rem 0.5rem',
                  }}
                >
                  {/* Column 1 (reads vertically 4, 5, 6...) */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.22rem' }}>
                    {restCol1.map(p => (
                      <div
                        key={p.playerId}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          background: 'rgba(255, 255, 255, 0.04)',
                          padding: '0.22rem 0.45rem',
                          borderRadius: '6px',
                          border: '1px solid rgba(255, 255, 255, 0.05)',
                          fontSize: '0.68rem',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', minWidth: 0 }}>
                          <span style={{ color: '#94a3b8', fontWeight: 800, fontSize: '0.64rem' }}>
                            #{p.rank}
                          </span>
                          <span
                            style={{
                              color: '#f1f5f9',
                              fontWeight: 700,
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              maxWidth: '75px',
                            }}
                          >
                            {p.playerName}
                          </span>
                          <span style={{ color: '#64748b', fontSize: '0.56rem' }}>({p.gamesPlayed} מש׳)</span>
                        </div>
                        <span
                          style={{
                            color: p.profit >= 0 ? '#4ade80' : '#f87171',
                            direction: 'ltr',
                            fontWeight: 700,
                            fontSize: '0.68rem',
                            flexShrink: 0,
                          }}
                        >
                          {p.profit >= 0 ? '+' : ''}₪{p.profit}
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* Column 2 (reads vertically 7, 8, 9...) */}
                  {restCol2.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.22rem' }}>
                      {restCol2.map(p => (
                        <div
                          key={p.playerId}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            background: 'rgba(255, 255, 255, 0.04)',
                            padding: '0.22rem 0.45rem',
                            borderRadius: '6px',
                            border: '1px solid rgba(255, 255, 255, 0.05)',
                            fontSize: '0.68rem',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', minWidth: 0 }}>
                            <span style={{ color: '#94a3b8', fontWeight: 800, fontSize: '0.64rem' }}>
                              #{p.rank}
                            </span>
                            <span
                              style={{
                                color: '#f1f5f9',
                                fontWeight: 700,
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                maxWidth: '75px',
                              }}
                            >
                              {p.playerName}
                            </span>
                            <span style={{ color: '#64748b', fontSize: '0.56rem' }}>({p.gamesPlayed} מש׳)</span>
                          </div>
                          <span
                            style={{
                              color: p.profit >= 0 ? '#4ade80' : '#f87171',
                              direction: 'ltr',
                              fontWeight: 700,
                              fontSize: '0.68rem',
                              flexShrink: 0,
                            }}
                          >
                            {p.profit >= 0 ? '+' : ''}₪{p.profit}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Card Part 2: שיאים, תארים ופרשנות (Captured as Part 2 for WhatsApp) */}
          <div
            ref={part2Ref}
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
            {/* Infographic Header Part 2 */}
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
                  <div style={{ fontSize: '0.66rem', color: '#94a3b8' }}>
                    חלק ב׳: שיאים, סיפורים ופרשנות
                  </div>
                </div>
              </div>

              <span
                style={{
                  fontSize: '0.72rem',
                  fontWeight: 800,
                  padding: '0.15rem 0.55rem',
                  borderRadius: '999px',
                  background: 'rgba(234, 179, 8, 0.12)',
                  border: '1px solid rgba(234, 179, 8, 0.3)',
                  color: '#facc15',
                }}
              >
                שיאים & סיפורים
              </span>
            </div>

            {/* Breakthrough Records & Discoveries Section */}
            {recap.records && recap.records.length > 0 && (
              <div
                style={{
                  background: 'linear-gradient(135deg, rgba(234, 179, 8, 0.09), rgba(30, 41, 59, 0.6))',
                  border: '1px solid rgba(234, 179, 8, 0.3)',
                  borderRadius: '12px',
                  padding: '0.55rem 0.65rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.35rem',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                  <span style={{ fontSize: '0.95rem' }}>⚡</span>
                  <span style={{ fontSize: '0.74rem', fontWeight: 800, color: '#facc15' }}>
                    שבירת שיאים ותגליות בתקופה
                  </span>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                  {recap.records.map(rec => (
                    <div
                      key={rec.id}
                      style={{
                        background: 'rgba(15, 23, 42, 0.65)',
                        border: '1px solid rgba(255, 255, 255, 0.07)',
                        borderRadius: '8px',
                        padding: '0.35rem 0.5rem',
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: '0.45rem',
                      }}
                    >
                      <span style={{ fontSize: '1.05rem', lineHeight: 1, marginTop: '0.05rem' }}>
                        {rec.icon}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.3rem' }}>
                          <span style={{ fontSize: '0.7rem', fontWeight: 800, color: '#f8fafc' }}>
                            {rec.title}
                          </span>
                          {rec.badge && (
                            <span
                              style={{
                                fontSize: '0.58rem',
                                fontWeight: 700,
                                padding: '0.05rem 0.35rem',
                                borderRadius: '999px',
                                background: 'rgba(234, 179, 8, 0.15)',
                                color: '#fef08a',
                                border: '1px solid rgba(234, 179, 8, 0.3)',
                              }}
                            >
                              {rec.badge}
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: '0.64rem', color: '#cbd5e1', lineHeight: 1.35, marginTop: '0.1rem' }}>
                          {rec.description}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Standing Shifts & Key Stories Section (Replaces awards with real narrative) */}
            {recap.stories && recap.stories.length > 0 && (
              <div
                style={{
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: '12px',
                  padding: '0.55rem 0.65rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.35rem',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                  <span style={{ fontSize: '0.95rem' }}>📖</span>
                  <span style={{ fontSize: '0.74rem', fontWeight: 800, color: '#38bdf8' }}>
                    סיפורי התקופה ותנודות בדירוג
                  </span>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                  {recap.stories.map(st => (
                    <div
                      key={st.id}
                      style={{
                        background: 'rgba(15, 23, 42, 0.65)',
                        border: '1px solid rgba(255, 255, 255, 0.07)',
                        borderRadius: '8px',
                        padding: '0.35rem 0.5rem',
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: '0.45rem',
                      }}
                    >
                      <span style={{ fontSize: '1.05rem', lineHeight: 1, marginTop: '0.05rem' }}>
                        {st.icon}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.3rem' }}>
                          <span style={{ fontSize: '0.7rem', fontWeight: 800, color: '#f8fafc' }}>
                            {st.title}
                          </span>
                          {st.badge && (
                            <span
                              style={{
                                fontSize: '0.58rem',
                                fontWeight: 700,
                                padding: '0.05rem 0.35rem',
                                borderRadius: '999px',
                                background:
                                  st.badgeVariant === 'green'
                                    ? 'rgba(16, 185, 129, 0.15)'
                                    : st.badgeVariant === 'red'
                                    ? 'rgba(239, 68, 68, 0.15)'
                                    : st.badgeVariant === 'purple'
                                    ? 'rgba(168, 85, 247, 0.15)'
                                    : st.badgeVariant === 'amber'
                                    ? 'rgba(245, 158, 11, 0.15)'
                                    : 'rgba(56, 189, 248, 0.15)',
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
                        <div style={{ fontSize: '0.64rem', color: '#cbd5e1', lineHeight: 1.35, marginTop: '0.1rem' }}>
                          {st.description}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* AI Commentary loading placeholder (inside Card Part 2) */}
            {aiLoading && !aiText && (
              <div
                style={{
                  background: 'rgba(56, 189, 248, 0.05)',
                  border: '1px dashed rgba(56, 189, 248, 0.25)',
                  borderRadius: '10px',
                  padding: '0.65rem 0.8rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.6rem',
                }}
              >
                <div style={{ fontSize: '1.05rem' }}>✨</div>
                <div>
                  <div style={{ fontSize: '0.72rem', color: '#38bdf8', fontWeight: 700 }}>
                    🎙️ דבר הפרשן
                  </div>
                  <div style={{ fontSize: '0.66rem', color: '#94a3b8', marginTop: '0.1rem' }}>
                    הפרשן מנתח את מהלכי החודש ומנסח תובנות...
                  </div>
                </div>
              </div>
            )}

            {/* AI Commentary quote (inside Card Part 2) */}
            {aiText && (
              <div
                style={{
                  background: 'rgba(255, 255, 255, 0.04)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: '10px',
                  padding: '0.6rem 0.75rem',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '0.25rem',
                  }}
                >
                  <div style={{ fontSize: '0.72rem', color: '#38bdf8', fontWeight: 700 }}>
                    🎙️ דבר הפרשן
                  </div>
                  {canGenerateAI && (
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
                <div style={{ fontSize: '0.72rem', color: '#f1f5f9', lineHeight: 1.5, whiteSpace: 'pre-line' }}>
                  {aiText}
                </div>
              </div>
            )}
          </div>

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
              <span>{isSharing ? 'מכין 2 תמונות לשיתוף...' : 'שתף תמונות סיכום לוואטסאפ (2 חלקים)'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default PeriodRecapModal;
