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
  if (!cabinet) return null;

  const summaryItems = [
    {
      icon: '👑',
      label: 'אלוף שנה',
      count: cabinet.yearlyChamps.length,
      sub: cabinet.yearlyChamps.length > 0 ? cabinet.yearlyChamps.join(', ') : 'טרם זכה',
      color: '#fbbf24',
      bg: 'rgba(245, 158, 11, 0.14)',
      border: 'rgba(245, 158, 11, 0.35)',
    },
    {
      icon: '🏆',
      label: 'אלוף חציון',
      count: cabinet.halfChamps.length,
      sub: cabinet.halfChamps.length > 0 ? `${cabinet.halfPodiums} פודיומים` : 'טרם זכה',
      color: '#f59e0b',
      bg: 'rgba(245, 158, 11, 0.1)',
      border: 'rgba(245, 158, 11, 0.28)',
    },
    {
      icon: '🥇',
      label: 'אלוף חודש',
      count: cabinet.monthlyChamps,
      sub: 'מקום 1 בחודש',
      color: '#eab308',
      bg: 'rgba(234, 179, 8, 0.12)',
      border: 'rgba(234, 179, 8, 0.3)',
    },
    {
      icon: '🏅',
      label: 'פודיום חודש',
      count: cabinet.monthlyPodiums,
      sub: `🥇${cabinet.monthlyChamps} · 🥈${cabinet.monthlySilvers} · 🥉${cabinet.monthlyBronzes}`,
      color: '#38bdf8',
      bg: 'rgba(56, 189, 248, 0.12)',
      border: 'rgba(56, 189, 248, 0.28)',
    },
    {
      icon: '🎯',
      label: 'צלף החודש',
      count: cabinet.monthlySnipers,
      sub: 'שיאן % ניצחון',
      color: '#34d399',
      bg: 'rgba(52, 211, 153, 0.12)',
      border: 'rgba(52, 211, 153, 0.28)',
    },
    {
      icon: '💥',
      label: 'המכה הגדולה',
      count: cabinet.monthlyBigHits,
      sub: 'שיא קופה בערב',
      color: '#c084fc',
      bg: 'rgba(192, 132, 252, 0.12)',
      border: 'rgba(192, 132, 252, 0.28)',
    },
  ];

  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(2, 6, 23, 0.85)',
        backdropFilter: 'blur(6px)',
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
          maxWidth: '410px',
          maxHeight: '90vh',
          background: 'linear-gradient(165deg, #0f172a 0%, #1e293b 100%)',
          borderRadius: '18px',
          border: '1px solid rgba(251, 191, 36, 0.3)',
          boxShadow: '0 20px 50px rgba(0, 0, 0, 0.7)',
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
            background: 'rgba(15, 23, 42, 0.6)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '1.3rem' }}>🏆</span>
            <div>
              <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 800, color: '#ffffff' }}>
                ארון הגביעים — {cabinet.playerName}
              </h3>
              <div style={{ fontSize: '0.7rem', color: '#94a3b8' }}>
                לחץ על כל חודש או עונה לפתיחת סיכום התקופה (Wrapped)
              </div>
            </div>
          </div>

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
            gap: '0.9rem',
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
                  background: item.count > 0 ? item.bg : 'rgba(255, 255, 255, 0.03)',
                  border: `1px solid ${item.count > 0 ? item.border : 'rgba(255, 255, 255, 0.07)'}`,
                  borderRadius: '12px',
                  padding: '0.5rem 0.35rem',
                  textAlign: 'center',
                  opacity: item.count > 0 ? 1 : 0.5,
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
                  ×{item.count}
                </div>
                <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#e2e8f0' }}>
                  {item.label}
                </div>
                <div
                  style={{
                    fontSize: '0.6rem',
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

          {/* Per-Year 6x2 H1/H2 Month Matrix */}
          {cabinet.yearsMatrix.map(ym => {
            const h1Months = ym.months.slice(0, 6);
            const h2Months = ym.months.slice(6, 12);

            const renderMonthRow = (
              cells: typeof h1Months,
              halfLabel: string,
              halfType: 'h1' | 'h2',
              isHalfChamp: boolean,
              halfRank: number | null
            ) => (
              <div style={{ marginTop: '0.45rem' }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    marginBottom: '0.25rem',
                    padding: '0 0.15rem',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => onOpenPeriodRecap(halfType, ym.year)}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      color: isHalfChamp ? '#fbbf24' : '#94a3b8',
                      fontSize: '0.68rem',
                      fontWeight: 700,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.25rem',
                    }}
                  >
                    <span>{halfLabel}</span>
                    {isHalfChamp && <span>🏆 אלוף חציון</span>}
                    {!isHalfChamp && halfRank && halfRank <= 3 && (
                      <span>{halfRank === 2 ? '🥈 מקום 2' : '🥉 מקום 3'}</span>
                    )}
                    <span style={{ fontSize: '0.6rem', opacity: 0.7 }}>🎬</span>
                  </button>
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(6, 1fr)',
                    gap: '0.3rem',
                  }}
                >
                  {cells.map(cell => {
                    const played = cell.playerGames > 0;
                    let badge = '';
                    if (cell.isChamp) badge = '🥇';
                    else if (cell.isSilver) badge = '🥈';
                    else if (cell.isBronze) badge = '🥉';
                    if (cell.isSniper) badge += '🎯';
                    else if (cell.isBigHit) badge += '💥';

                    const borderColor = cell.isChamp
                      ? 'rgba(251, 191, 36, 0.6)'
                      : cell.isSilver
                      ? 'rgba(203, 213, 225, 0.45)'
                      : cell.isBronze
                      ? 'rgba(217, 119, 6, 0.45)'
                      : played
                      ? 'rgba(255, 255, 255, 0.1)'
                      : 'rgba(255, 255, 255, 0.04)';

                    const bgColor = cell.isChamp
                      ? 'rgba(251, 191, 36, 0.16)'
                      : cell.isSilver
                      ? 'rgba(148, 163, 184, 0.14)'
                      : cell.isBronze
                      ? 'rgba(180, 83, 9, 0.14)'
                      : played
                      ? 'rgba(255, 255, 255, 0.04)'
                      : 'rgba(255, 255, 255, 0.015)';

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
                          background: bgColor,
                          border: `1px solid ${borderColor}`,
                          borderRadius: '8px',
                          padding: '0.3rem 0.15rem',
                          textAlign: 'center',
                          cursor: cell.gamesInMonth > 0 ? 'pointer' : 'default',
                          opacity: played ? 1 : 0.38,
                          fontFamily: 'inherit',
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          minHeight: '52px',
                        }}
                      >
                        <span style={{ fontSize: '0.62rem', color: '#cbd5e1', fontWeight: 600 }}>
                          {SHORT_MONTH_NAMES[cell.month - 1]}
                        </span>
                        <span style={{ fontSize: '0.82rem', lineHeight: 1.1, minHeight: '14px' }}>
                          {badge || (played ? '•' : '—')}
                        </span>
                        {played ? (
                          <span
                            style={{
                              fontSize: '0.6rem',
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
                          <span style={{ fontSize: '0.55rem', color: '#64748b' }}>—</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );

            return (
              <div
                key={ym.year}
                style={{
                  background: 'rgba(255, 255, 255, 0.03)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: '14px',
                  padding: '0.65rem',
                }}
              >
                {/* Year Header */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    borderBottom: '1px solid rgba(255, 255, 255, 0.07)',
                    paddingBottom: '0.4rem',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                    <span style={{ fontSize: '0.95rem', fontWeight: 800, color: '#ffffff' }}>
                      עונת {ym.year}
                    </span>
                    {ym.isYearChamp && (
                      <span
                        style={{
                          fontSize: '0.68rem',
                          fontWeight: 800,
                          padding: '0.1rem 0.45rem',
                          borderRadius: '999px',
                          background: 'rgba(251, 191, 36, 0.18)',
                          border: '1px solid rgba(251, 191, 36, 0.4)',
                          color: '#fbbf24',
                        }}
                      >
                        👑 אלוף השנה
                      </span>
                    )}
                    {!ym.isYearChamp && ym.yearRank && ym.yearRank <= 3 && (
                      <span style={{ fontSize: '0.7rem', color: '#cbd5e1', fontWeight: 700 }}>
                        {ym.yearRank === 2 ? '🥈 מקום 2 בעונה' : '🥉 מקום 3 בעונה'}
                      </span>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => onOpenPeriodRecap('year', ym.year)}
                    style={{
                      background: 'rgba(251, 191, 36, 0.12)',
                      border: '1px solid rgba(251, 191, 36, 0.3)',
                      color: '#fbbf24',
                      borderRadius: '8px',
                      padding: '0.2rem 0.5rem',
                      fontSize: '0.68rem',
                      fontWeight: 700,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    🎬 סיכום {ym.year}
                  </button>
                </div>

                {/* H1 Row (Jan-Jun) */}
                {renderMonthRow(h1Months, 'חציון א׳ (ינו׳–יוני)', 'h1', ym.isH1Champ, ym.h1Rank)}

                {/* H2 Row (Jul-Dec) */}
                {renderMonthRow(h2Months, 'חציון ב׳ (יולי–דצמ׳)', 'h2', ym.isH2Champ, ym.h2Rank)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default PlayerTrophyModal;

