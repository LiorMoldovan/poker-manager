import { useState } from 'react';
import { PlayerTrophyCabinet, RecapPeriodType } from '../utils/periodRecap';

interface PlayerTrophyModalProps {
  cabinet: PlayerTrophyCabinet | null;
  onClose: () => void;
  onOpenPeriodRecap: (periodType: RecapPeriodType, year: number, month?: number) => void;
}

const SHORT_MONTH_NAMES = [
  'ינו׳', 'פבר׳', 'מרץ', 'אפר׳', 'מאי', 'יוני',
  'יולי', 'אוג׳', 'ספט׳', 'אוק׳', 'נוב׳', 'דצמ׳',
];

export const PlayerTrophyModal = ({
  cabinet,
  onClose,
  onOpenPeriodRecap,
}: PlayerTrophyModalProps) => {
  const [expandedYearBreakdowns, setExpandedYearBreakdowns] = useState<Record<number, boolean>>({});

  if (!cabinet) return null;

  const toggleYearBreakdown = (year: number) => {
    setExpandedYearBreakdowns(prev => ({
      ...prev,
      [year]: !prev[year],
    }));
  };

  const summaryItems = [
    {
      icon: '👑',
      label: 'אלוף שנה',
      count: cabinet.yearlyChamps.length,
      sub: cabinet.yearlyChamps.length > 0 ? cabinet.yearlyChamps.join(', ') : 'טרם זכה',
      color: '#fbbf24',
      bg: 'rgba(245, 158, 11, 0.12)',
      border: 'rgba(245, 158, 11, 0.35)',
    },
    {
      icon: '🏆',
      label: 'אלוף חציון',
      count: cabinet.halfChamps.length,
      sub: cabinet.halfChamps.length > 0 ? `${cabinet.halfPodiums} פודיומים` : 'טרם זכה',
      color: '#f59e0b',
      bg: 'rgba(245, 158, 11, 0.08)',
      border: 'rgba(245, 158, 11, 0.25)',
    },
    {
      icon: '🥇',
      label: 'אלוף חודש',
      count: cabinet.monthlyChamps,
      sub: 'מקום 1 בחודש',
      color: '#eab308',
      bg: 'rgba(234, 179, 8, 0.1)',
      border: 'rgba(234, 179, 8, 0.28)',
    },
    {
      icon: '🏅',
      label: 'פודיום חודש',
      count: cabinet.monthlyPodiums,
      sub: `🥇${cabinet.monthlyChamps} · 🥈${cabinet.monthlySilvers} · 🥉${cabinet.monthlyBronzes}`,
      color: '#38bdf8',
      bg: 'rgba(56, 189, 248, 0.1)',
      border: 'rgba(56, 189, 248, 0.25)',
    },
    {
      icon: '🎯',
      label: 'צלף החודש',
      count: cabinet.monthlySnipers,
      sub: 'שיאן % ניצחון',
      color: '#34d399',
      bg: 'rgba(52, 211, 153, 0.1)',
      border: 'rgba(52, 211, 153, 0.25)',
    },
    {
      icon: '💥',
      label: 'המכה הגדולה',
      count: cabinet.monthlyBigHits,
      sub: 'שיא קופה בערב',
      color: '#c084fc',
      bg: 'rgba(192, 132, 252, 0.1)',
      border: 'rgba(192, 132, 252, 0.25)',
    },
  ];

  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(2, 6, 23, 0.88)',
        backdropFilter: 'blur(8px)',
        zIndex: 9998,
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
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0.75rem 0.9rem',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            background: 'rgba(30, 41, 59, 0.5)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '1.3rem' }}>🏆</span>
            <div>
              <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 800, color: '#ffffff' }}>
                ארון הגביעים — {cabinet.playerName}
              </h3>
              <div style={{ fontSize: '0.7rem', color: '#94a3b8' }}>
                הישגים אישיים, תארים עונתיים וחודשיים
              </div>
            </div>
          </div>

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

        {/* Scrollable Content */}
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
          {/* 3x2 Lifetime Trophy Counters */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, 1fr)',
              gap: '0.45rem',
            }}
          >
            {summaryItems.map(item => (
              <div
                key={item.label}
                style={{
                  background: item.count > 0 ? item.bg : 'rgba(255, 255, 255, 0.02)',
                  border: `1px solid ${item.count > 0 ? item.border : 'rgba(255, 255, 255, 0.06)'}`,
                  borderRadius: '12px',
                  padding: '0.5rem 0.3rem',
                  textAlign: 'center',
                  opacity: item.count > 0 ? 1 : 0.45,
                }}
              >
                <div style={{ fontSize: '1.2rem', lineHeight: 1.1 }}>{item.icon}</div>
                <div
                  style={{
                    fontSize: '1.1rem',
                    fontWeight: 900,
                    color: item.count > 0 ? item.color : '#64748b',
                    marginTop: '0.1rem',
                  }}
                >
                  ×{item.count}
                </div>
                <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#e2e8f0' }}>
                  {item.label}
                </div>
                <div
                  style={{
                    fontSize: '0.58rem',
                    color: '#94a3b8',
                    marginTop: '0.1rem',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {item.sub}
                </div>
              </div>
            ))}
          </div>

          {/* Section title */}
          <div style={{ fontSize: '0.76rem', color: '#94a3b8', fontWeight: 700, marginTop: '0.15rem' }}>
            📜 הישגים לפי עונות (לחץ על תואר לפתיחת סיכום תקופה)
          </div>

          {/* Clean Chronological Year Cards */}
          {cabinet.yearsMatrix.map(ym => {
            const playedMonths = ym.months.filter(m => m.playerGames > 0);
            const totalGamesInYear = ym.months.reduce((acc, m) => acc + m.playerGames, 0);

            // Collect all notable achievements in this year
            interface AchievementPill {
              id: string;
              icon: string;
              title: string;
              periodType: RecapPeriodType;
              year: number;
              month?: number;
              color: string;
              bg: string;
              border: string;
            }

            const pills: AchievementPill[] = [];

            // Half titles
            if (ym.isH1Champ) {
              pills.push({
                id: `h1-${ym.year}`,
                icon: '🏆',
                title: 'אלוף חציון א׳',
                periodType: 'h1',
                year: ym.year,
                color: '#fbbf24',
                bg: 'rgba(245, 158, 11, 0.15)',
                border: 'rgba(245, 158, 11, 0.4)',
              });
            } else if (ym.h1Rank && ym.h1Rank <= 3) {
              pills.push({
                id: `h1-podium-${ym.year}`,
                icon: ym.h1Rank === 2 ? '🥈' : '🥉',
                title: ym.h1Rank === 2 ? 'סגן חציון א׳' : 'מקום 3 חציון א׳',
                periodType: 'h1',
                year: ym.year,
                color: ym.h1Rank === 2 ? '#cbd5e1' : '#fdba74',
                bg: 'rgba(255, 255, 255, 0.05)',
                border: 'rgba(255, 255, 255, 0.15)',
              });
            }

            if (ym.isH2Champ) {
              pills.push({
                id: `h2-${ym.year}`,
                icon: '🏆',
                title: 'אלוף חציון ב׳',
                periodType: 'h2',
                year: ym.year,
                color: '#fbbf24',
                bg: 'rgba(245, 158, 11, 0.15)',
                border: 'rgba(245, 158, 11, 0.4)',
              });
            } else if (ym.h2Rank && ym.h2Rank <= 3) {
              pills.push({
                id: `h2-podium-${ym.year}`,
                icon: ym.h2Rank === 2 ? '🥈' : '🥉',
                title: ym.h2Rank === 2 ? 'סגן חציון ב׳' : 'מקום 3 חציון ב׳',
                periodType: 'h2',
                year: ym.year,
                color: ym.h2Rank === 2 ? '#cbd5e1' : '#fdba74',
                bg: 'rgba(255, 255, 255, 0.05)',
                border: 'rgba(255, 255, 255, 0.15)',
              });
            }

            // Month podiums & special awards
            ym.months.forEach(m => {
              if (m.isChamp) {
                pills.push({
                  id: `m-champ-${m.month}`,
                  icon: '🥇',
                  title: `${m.monthName} (+₪${m.profit})`,
                  periodType: 'month',
                  year: ym.year,
                  month: m.month,
                  color: '#fbbf24',
                  bg: 'rgba(245, 158, 11, 0.15)',
                  border: 'rgba(245, 158, 11, 0.35)',
                });
              } else if (m.isSilver) {
                pills.push({
                  id: `m-silver-${m.month}`,
                  icon: '🥈',
                  title: `${m.monthName} (+₪${m.profit})`,
                  periodType: 'month',
                  year: ym.year,
                  month: m.month,
                  color: '#cbd5e1',
                  bg: 'rgba(203, 213, 225, 0.12)',
                  border: 'rgba(203, 213, 225, 0.3)',
                });
              } else if (m.isBronze) {
                pills.push({
                  id: `m-bronze-${m.month}`,
                  icon: '🥉',
                  title: `${m.monthName} (+₪${m.profit})`,
                  periodType: 'month',
                  year: ym.year,
                  month: m.month,
                  color: '#fdba74',
                  bg: 'rgba(217, 119, 6, 0.12)',
                  border: 'rgba(217, 119, 6, 0.3)',
                });
              }

              if (m.isSniper && !m.isChamp) {
                pills.push({
                  id: `m-sniper-${m.month}`,
                  icon: '🎯',
                  title: `צלף ${m.monthName}`,
                  periodType: 'month',
                  year: ym.year,
                  month: m.month,
                  color: '#34d399',
                  bg: 'rgba(52, 211, 153, 0.12)',
                  border: 'rgba(52, 211, 153, 0.3)',
                });
              }

              if (m.isBigHit && !m.isChamp) {
                pills.push({
                  id: `m-bighit-${m.month}`,
                  icon: '💥',
                  title: `שיא ${m.monthName} (+₪${m.profit})`,
                  periodType: 'month',
                  year: ym.year,
                  month: m.month,
                  color: '#c084fc',
                  bg: 'rgba(192, 132, 252, 0.12)',
                  border: 'rgba(192, 132, 252, 0.3)',
                });
              }
            });

            const isExpanded = !!expandedYearBreakdowns[ym.year];

            return (
              <div
                key={ym.year}
                style={{
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: ym.isYearChamp
                    ? '1.5px solid rgba(245, 158, 11, 0.45)'
                    : '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: '14px',
                  padding: '0.75rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.55rem',
                }}
              >
                {/* Year Header */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
                    paddingBottom: '0.45rem',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                    <span style={{ fontSize: '1rem', fontWeight: 900, color: '#ffffff' }}>
                      עונת {ym.year}
                    </span>
                    {ym.isYearChamp && (
                      <span
                        style={{
                          fontSize: '0.7rem',
                          fontWeight: 800,
                          padding: '0.12rem 0.5rem',
                          borderRadius: '999px',
                          background: 'rgba(245, 158, 11, 0.2)',
                          border: '1px solid rgba(245, 158, 11, 0.45)',
                          color: '#fbbf24',
                        }}
                      >
                        👑 אלוף השנה
                      </span>
                    )}
                    {!ym.isYearChamp && ym.yearRank && ym.yearRank <= 3 && (
                      <span style={{ fontSize: '0.72rem', color: '#cbd5e1', fontWeight: 700 }}>
                        {ym.yearRank === 2 ? '🥈 סגן אלוף' : '🥉 מקום 3 בעונה'}
                      </span>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => onOpenPeriodRecap('year', ym.year)}
                    style={{
                      background: 'rgba(59, 130, 246, 0.12)',
                      border: '1px solid rgba(59, 130, 246, 0.3)',
                      color: '#60a5fa',
                      borderRadius: '8px',
                      padding: '0.2rem 0.55rem',
                      fontSize: '0.7rem',
                      fontWeight: 700,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.25rem',
                    }}
                  >
                    <span>🎬 סיכום שנתי</span>
                  </button>
                </div>

                {/* Year stats bar */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: '0.72rem',
                    color: '#94a3b8',
                  }}
                >
                  <div>
                    <span>🎮 {totalGamesInYear} משחקים</span>
                    <span style={{ margin: '0 0.4rem' }}>•</span>
                    <span>📅 {playedMonths.length} חודשים פעילים</span>
                  </div>
                  <div
                    style={{
                      fontWeight: 800,
                      color: ym.yearProfit >= 0 ? '#4ade80' : '#f87171',
                      direction: 'ltr',
                    }}
                  >
                    {ym.yearProfit >= 0 ? '+' : ''}₪{ym.yearProfit.toLocaleString('he-IL')}
                  </div>
                </div>

                {/* Achievements flow pills */}
                {pills.length > 0 ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                    {pills.map(p => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => onOpenPeriodRecap(p.periodType, p.year, p.month)}
                        style={{
                          background: p.bg,
                          border: `1px solid ${p.border}`,
                          color: p.color,
                          borderRadius: '8px',
                          padding: '0.25rem 0.5rem',
                          fontSize: '0.72rem',
                          fontWeight: 700,
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.3rem',
                        }}
                      >
                        <span>{p.icon}</span>
                        <span>{p.title}</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: '0.7rem', color: '#64748b' }}>
                    אין תארי פודיום בעונה זו
                  </div>
                )}

                {/* Collapsible 12-month table toggle */}
                <div style={{ marginTop: '0.15rem' }}>
                  <button
                    type="button"
                    onClick={() => toggleYearBreakdown(ym.year)}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: '#94a3b8',
                      fontSize: '0.68rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                      padding: 0,
                      fontFamily: 'inherit',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.3rem',
                    }}
                  >
                    <span>{isExpanded ? '▲ הסתר לוח חודשים' : '▼ הצג לוח חודשים מלא'}</span>
                  </button>

                  {isExpanded && (
                    <div
                      style={{
                        marginTop: '0.5rem',
                        display: 'grid',
                        gridTemplateColumns: 'repeat(6, 1fr)',
                        gap: '0.25rem',
                      }}
                    >
                      {ym.months.map(cell => {
                        const played = cell.playerGames > 0;
                        let badge = '';
                        if (cell.isChamp) badge = '🥇';
                        else if (cell.isSilver) badge = '🥈';
                        else if (cell.isBronze) badge = '🥉';

                        return (
                          <button
                            key={cell.month}
                            type="button"
                            disabled={cell.gamesInMonth === 0}
                            onClick={() => {
                              if (cell.gamesInMonth > 0) {
                                onOpenPeriodRecap('month', cell.year, cell.month);
                              }
                            }}
                            style={{
                              background: cell.isChamp
                                ? 'rgba(245, 158, 11, 0.15)'
                                : cell.isSilver
                                ? 'rgba(203, 213, 225, 0.12)'
                                : cell.isBronze
                                ? 'rgba(217, 119, 6, 0.12)'
                                : played
                                ? 'rgba(255, 255, 255, 0.04)'
                                : 'rgba(255, 255, 255, 0.015)',
                              border: cell.isChamp
                                ? '1px solid rgba(245, 158, 11, 0.45)'
                                : played
                                ? '1px solid rgba(255, 255, 255, 0.08)'
                                : '1px solid rgba(255, 255, 255, 0.03)',
                              borderRadius: '6px',
                              padding: '0.25rem 0.15rem',
                              textAlign: 'center',
                              cursor: cell.gamesInMonth > 0 ? 'pointer' : 'default',
                              opacity: played ? 1 : 0.35,
                              fontFamily: 'inherit',
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              minHeight: '44px',
                            }}
                          >
                            <span style={{ fontSize: '0.6rem', color: '#cbd5e1' }}>
                              {SHORT_MONTH_NAMES[cell.month - 1]}
                            </span>
                            <span style={{ fontSize: '0.72rem', lineHeight: 1 }}>
                              {badge || (played ? '•' : '—')}
                            </span>
                            {played ? (
                              <span
                                style={{
                                  fontSize: '0.58rem',
                                  fontWeight: 700,
                                  color:
                                    cell.profit > 0
                                      ? '#4ade80'
                                      : cell.profit < 0
                                      ? '#f87171'
                                      : '#94a3b8',
                                  direction: 'ltr',
                                }}
                              >
                                {cell.profit > 0 ? `+${cell.profit}` : cell.profit}
                              </span>
                            ) : (
                              <span style={{ fontSize: '0.52rem', color: '#64748b' }}>—</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default PlayerTrophyModal;
