import { PlayerTrophyCabinet, RecapPeriodType } from '../utils/periodRecap';

interface PlayerTrophyModalProps {
  cabinet: PlayerTrophyCabinet | null;
  onClose: () => void;
  onOpenPeriodRecap: (periodType: RecapPeriodType, year: number, month?: number) => void;
}

export const PlayerTrophyModal = ({
  cabinet,
  onClose,
  onOpenPeriodRecap,
}: PlayerTrophyModalProps) => {
  if (!cabinet) return null;

  const coreHonors = [
    {
      icon: '👑',
      label: 'אליפויות עונה',
      count: cabinet.yearlyChamps.length,
      detail: cabinet.yearlyChamps.length > 0 ? cabinet.yearlyChamps.join(', ') : '—',
      color: '#fbbf24',
      bg: 'rgba(245, 158, 11, 0.12)',
      border: 'rgba(245, 158, 11, 0.35)',
    },
    {
      icon: '🏆',
      label: 'אליפויות חציון',
      count: cabinet.halfChamps.length,
      detail: cabinet.halfChamps.length > 0 ? cabinet.halfChamps.join(', ') : '—',
      color: '#f59e0b',
      bg: 'rgba(245, 158, 11, 0.08)',
      border: 'rgba(245, 158, 11, 0.25)',
    },
    {
      icon: '🥇',
      label: 'אליפויות חודש',
      count: cabinet.monthlyChamps,
      detail: cabinet.monthlyChamps > 0 ? `${cabinet.monthlyChamps} חודשים` : '—',
      color: '#eab308',
      bg: 'rgba(234, 179, 8, 0.1)',
      border: 'rgba(234, 179, 8, 0.28)',
    },
    {
      icon: '🏅',
      label: 'סה״כ פודיומים',
      count: cabinet.monthlyPodiums,
      detail: `🥇${cabinet.monthlyChamps} · 🥈${cabinet.monthlySilvers} · 🥉${cabinet.monthlyBronzes}`,
      color: '#38bdf8',
      bg: 'rgba(56, 189, 248, 0.1)',
      border: 'rgba(56, 189, 248, 0.25)',
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
        padding: '0.6rem',
        direction: 'rtl',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: '430px',
          maxHeight: '90vh',
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
            padding: '0.75rem 0.95rem',
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
                הישגים מרכזיים ותארי אליפות
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
            gap: '0.75rem',
          }}
        >
          {/* Top 4 Core Honors Strip */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: '0.4rem',
            }}
          >
            {coreHonors.map(item => (
              <div
                key={item.label}
                style={{
                  background: item.count > 0 ? item.bg : 'rgba(255, 255, 255, 0.02)',
                  border: `1px solid ${item.count > 0 ? item.border : 'rgba(255, 255, 255, 0.06)'}`,
                  borderRadius: '12px',
                  padding: '0.5rem 0.25rem',
                  textAlign: 'center',
                  opacity: item.count > 0 ? 1 : 0.45,
                }}
              >
                <div style={{ fontSize: '1.15rem', lineHeight: 1.1 }}>{item.icon}</div>
                <div
                  style={{
                    fontSize: '1.1rem',
                    fontWeight: 900,
                    color: item.count > 0 ? item.color : '#64748b',
                    marginTop: '0.1rem',
                  }}
                >
                  {item.count}
                </div>
                <div style={{ fontSize: '0.66rem', fontWeight: 700, color: '#e2e8f0', marginTop: '0.05rem' }}>
                  {item.label}
                </div>
              </div>
            ))}
          </div>

          {/* Section title */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingTop: '0.2rem',
              borderTop: '1px solid rgba(255, 255, 255, 0.06)',
            }}
          >
            <span style={{ fontSize: '0.78rem', color: '#94a3b8', fontWeight: 800 }}>
              📜 זכיות מרכזיות לפי עונות
            </span>
            <span style={{ fontSize: '0.66rem', color: '#64748b' }}>
              לחץ לצפייה בסיכום התקופה
            </span>
          </div>

          {/* Season Cards */}
          {cabinet.yearsMatrix.map(ym => {
            const totalGamesInYear = ym.months.reduce((acc, m) => acc + m.playerGames, 0);

            // Collect major 1st place wins and championships
            interface MajorWin {
              id: string;
              icon: string;
              title: string;
              subtitle: string;
              periodType: RecapPeriodType;
              year: number;
              month?: number;
              color: string;
              bg: string;
              border: string;
            }

            const majorWins: MajorWin[] = [];

            // 1. Year Championship
            if (ym.isYearChamp) {
              majorWins.push({
                id: `year-${ym.year}`,
                icon: '👑',
                title: `אלוף עונת ${ym.year}`,
                subtitle: `מקום ראשון שנתי · ${ym.yearProfit >= 0 ? '+' : ''}₪${ym.yearProfit.toLocaleString('he-IL')}`,
                periodType: 'year',
                year: ym.year,
                color: '#fbbf24',
                bg: 'linear-gradient(135deg, rgba(245, 158, 11, 0.18), rgba(245, 158, 11, 0.08))',
                border: 'rgba(245, 158, 11, 0.45)',
              });
            }

            // 2. Half Championships
            if (ym.isH1Champ) {
              majorWins.push({
                id: `h1-${ym.year}`,
                icon: '🏆',
                title: 'אלוף חציון א׳',
                subtitle: `מקום ראשון בחציון הראשון ${ym.year}`,
                periodType: 'h1',
                year: ym.year,
                color: '#fbbf24',
                bg: 'rgba(245, 158, 11, 0.12)',
                border: 'rgba(245, 158, 11, 0.35)',
              });
            }
            if (ym.isH2Champ) {
              majorWins.push({
                id: `h2-${ym.year}`,
                icon: '🏆',
                title: 'אלוף חציון ב׳',
                subtitle: `מקום ראשון בחציון השני ${ym.year}`,
                periodType: 'h2',
                year: ym.year,
                color: '#fbbf24',
                bg: 'rgba(245, 158, 11, 0.12)',
                border: 'rgba(245, 158, 11, 0.35)',
              });
            }

            // 3. Month Championships
            ym.months.forEach(m => {
              if (m.isChamp) {
                majorWins.push({
                  id: `m-champ-${m.month}`,
                  icon: '🥇',
                  title: `אלוף חודש ${m.monthName}`,
                  subtitle: `רווח נקי: +₪${m.profit.toLocaleString('he-IL')} (${m.playerGames} מש׳)`,
                  periodType: 'month',
                  year: ym.year,
                  month: m.month,
                  color: '#fbbf24',
                  bg: 'rgba(245, 158, 11, 0.1)',
                  border: 'rgba(245, 158, 11, 0.3)',
                });
              }
            });

            // Collect secondary podiums & awards for clean summary
            const silverMonths = ym.months.filter(m => m.isSilver).map(m => m.monthName);
            const bronzeMonths = ym.months.filter(m => m.isBronze).map(m => m.monthName);
            const sniperMonths = ym.months.filter(m => m.isSniper && !m.isChamp).map(m => m.monthName);
            const bigHitMonths = ym.months.filter(m => m.isBigHit && !m.isChamp).map(m => m.monthName);

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
                {/* Year Header Bar */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
                    paddingBottom: '0.4rem',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                    <span style={{ fontSize: '0.98rem', fontWeight: 900, color: '#ffffff' }}>
                      עונת {ym.year}
                    </span>
                    {ym.isYearChamp && (
                      <span
                        style={{
                          fontSize: '0.68rem',
                          fontWeight: 800,
                          padding: '0.12rem 0.45rem',
                          borderRadius: '999px',
                          background: 'rgba(245, 158, 11, 0.2)',
                          border: '1px solid rgba(245, 158, 11, 0.45)',
                          color: '#fbbf24',
                        }}
                      >
                        👑 אלוף העונה
                      </span>
                    )}
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span
                      style={{
                        fontSize: '0.78rem',
                        fontWeight: 800,
                        color: ym.yearProfit >= 0 ? '#4ade80' : '#f87171',
                        direction: 'ltr',
                      }}
                    >
                      {ym.yearProfit >= 0 ? '+' : ''}₪{ym.yearProfit.toLocaleString('he-IL')}
                    </span>

                    <button
                      type="button"
                      onClick={() => onOpenPeriodRecap('year', ym.year)}
                      style={{
                        background: 'rgba(59, 130, 246, 0.1)',
                        border: '1px solid rgba(59, 130, 246, 0.25)',
                        color: '#60a5fa',
                        borderRadius: '6px',
                        padding: '0.18rem 0.45rem',
                        fontSize: '0.68rem',
                        fontWeight: 700,
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      🎬 סיכום
                    </button>
                  </div>
                </div>

                {/* Major Wins List */}
                {majorWins.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                    {majorWins.map(win => (
                      <button
                        key={win.id}
                        type="button"
                        onClick={() => onOpenPeriodRecap(win.periodType, win.year, win.month)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          background: win.bg,
                          border: `1px solid ${win.border}`,
                          borderRadius: '10px',
                          padding: '0.45rem 0.65rem',
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                          textAlign: 'right',
                          transition: 'all 0.2s ease',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <span style={{ fontSize: '1.2rem', lineHeight: 1 }}>{win.icon}</span>
                          <div>
                            <div style={{ fontSize: '0.82rem', fontWeight: 800, color: win.color }}>
                              {win.title}
                            </div>
                            <div style={{ fontSize: '0.66rem', color: '#cbd5e1' }}>
                              {win.subtitle}
                            </div>
                          </div>
                        </div>

                        <span style={{ fontSize: '0.72rem', color: '#94a3b8' }}>
                          ←
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: '0.7rem', color: '#64748b', padding: '0.2rem 0' }}>
                    אין זכיות באליפות בעונה זו ({totalGamesInYear} משחקים שוחקו)
                  </div>
                )}

                {/* Secondary Honors Clean Strip */}
                {(silverMonths.length > 0 || bronzeMonths.length > 0 || sniperMonths.length > 0 || bigHitMonths.length > 0) && (
                  <div
                    style={{
                      background: 'rgba(255, 255, 255, 0.02)',
                      border: '1px solid rgba(255, 255, 255, 0.05)',
                      borderRadius: '8px',
                      padding: '0.35rem 0.55rem',
                      fontSize: '0.68rem',
                      color: '#94a3b8',
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '0.3rem 0.6rem',
                    }}
                  >
                    {silverMonths.length > 0 && (
                      <span>🥈 {silverMonths.length} סגנויות ({silverMonths.join(', ')})</span>
                    )}
                    {bronzeMonths.length > 0 && (
                      <span>🥉 {bronzeMonths.length} מקום 3 ({bronzeMonths.join(', ')})</span>
                    )}
                    {sniperMonths.length > 0 && (
                      <span>🎯 צלף ({sniperMonths.join(', ')})</span>
                    )}
                    {bigHitMonths.length > 0 && (
                      <span>💥 שיא ערב ({bigHitMonths.join(', ')})</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default PlayerTrophyModal;
