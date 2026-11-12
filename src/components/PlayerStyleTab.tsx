import { useState, useMemo, useRef, useEffect } from 'react';
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  ReferenceLine,
  Cell,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
} from 'recharts';
import { Game, GamePlayer, Player } from '../types';
import { cleanNumber } from '../utils/calculations';
import { computeGroupStyleProfiles, PlayerStyleMetrics } from '../utils/playerStyleProfile';
import { captureAndSplit, shareFiles, shareToWhatsApp } from '../utils/sharing';
import { StyledSelect, StyledSelectOption } from './StyledSelect';
import { useTranslation } from '../i18n';

interface PlayerStyleTabProps {
  games: Game[];
  allGames?: Game[];
  players: Player[];
  selectedPlayers: Set<string>;
  onTogglePlayer: (playerId: string) => void;
  gamePlayersByGameId: Map<string, Map<string, GamePlayer>>;
  getPlayerColor: (id: string) => string;
  timeframeLabel: string;
}

interface ScatterPointItem {
  x: number;
  y: number;
  playerId: string;
  name: string;
  color: string;
  labelDx: number;
  labelDy: number;
}

const fmtSigned = (n: number): string => {
  const r = Math.round(n);
  if (r === 0) return '0';
  return `\u200E${r > 0 ? '+' : '-'}${cleanNumber(Math.abs(r))}`;
};

/**
 * Computes non-overlapping label offsets (dx, dy) in SVG pixels for each player dot
 * using `textAnchor="middle"` (which is 100% consistent across RTL/LTR on mobile & desktop)
 * so adjacent players on the scatter map never have their names collide or clip.
 */
function computeSmartScatterPoints(
  profiles: PlayerStyleMetrics[],
  yMinDomain: number,
  yMaxDomain: number
): ScatterPointItem[] {
  if (profiles.length === 0) return [];
  const plotW = 280;
  const plotH = 210;
  const ySpan = Math.max(50, yMaxDomain - yMinDomain);

  const raw: Array<{ p: PlayerStyleMetrics; x: number; y: number; px: number; py: number }> = [];
  for (const p of profiles) {
    let x = Math.round(p.volatility);
    const y = Math.round(p.avgProfit);
    // Deterministic de-clustering if two dots have near-identical coordinates
    for (const prev of raw) {
      if (Math.abs(prev.x - x) <= 2 && Math.abs(prev.y - y) <= 4) {
        const canMoveRight = x < 46 || (x >= 50 && x <= 90);
        x = canMoveRight ? x + 3 : Math.max(14, x - 3);
      }
    }
    const px = (x / 105) * plotW;
    const py = ((yMaxDomain - y) / ySpan) * plotH;
    raw.push({ p, x, y, px, py });
  }

  // Candidate offsets around the dot center (all using `textAnchor="middle"` for mobile RTL safety)
  const candidates: Array<{ dx: number; dy: number }> = [
    { dx: 0, dy: -11 },
    { dx: 0, dy: 15 },
    { dx: 22, dy: 4 },
    { dx: -22, dy: 4 },
    { dx: 18, dy: -10 },
    { dx: -18, dy: -10 },
    { dx: 18, dy: 14 },
    { dx: -18, dy: 14 },
    { dx: 0, dy: -22 },
    { dx: 0, dy: 25 },
    { dx: 26, dy: -15 },
    { dx: -26, dy: -15 },
    { dx: 26, dy: 19 },
    { dx: -26, dy: 19 },
  ];

  const placedLabels: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];

  return raw.map((item, idx) => {
    const labelW = Math.max(28, item.p.playerName.length * 6.2 + 8);
    const labelH = 13;

    let bestCandidate = candidates[0];
    let bestPenalty = Infinity;

    for (const cand of candidates) {
      const cx = item.px + cand.dx;
      const cy = item.py + cand.dy - 3;

      const box = {
        x1: cx - labelW / 2,
        y1: cy - labelH / 2,
        x2: cx + labelW / 2,
        y2: cy + labelH / 2,
      };

      let penalty = 0;

      // Penalize going outside chart bounds
      if (box.x1 < 6) penalty += (6 - box.x1) * 10;
      if (box.x2 > plotW - 6) penalty += (box.x2 - (plotW - 6)) * 10;
      if (box.y1 < 4) penalty += (4 - box.y1) * 10;
      if (box.y2 > plotH - 4) penalty += (box.y2 - (plotH - 4)) * 10;

      // Penalize overlapping any other player's dot
      for (let j = 0; j < raw.length; j++) {
        if (j === idx) continue;
        const other = raw[j];
        const distX = Math.abs(cx - other.px);
        const distY = Math.abs(cy - other.py);
        if (distX < labelW / 2 + 7 && distY < labelH / 2 + 7) {
          penalty += 500 + (labelW / 2 + 7 - distX) * 20;
        }
      }

      // Penalize overlapping already-placed label boxes
      for (const prev of placedLabels) {
        const overlapX = Math.max(0, Math.min(box.x2, prev.x2) - Math.max(box.x1, prev.x1) + 4);
        const overlapY = Math.max(0, Math.min(box.y2, prev.y2) - Math.max(box.y1, prev.y1) + 3);
        if (overlapX > 0 && overlapY > 0) {
          penalty += overlapX * overlapY * 15;
        }
      }

      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        bestCandidate = cand;
        if (penalty === 0) break;
      }
    }

    const finalCx = item.px + bestCandidate.dx;
    const finalCy = item.py + bestCandidate.dy - 3;

    placedLabels.push({
      x1: finalCx - labelW / 2,
      y1: finalCy - labelH / 2,
      x2: finalCx + labelW / 2,
      y2: finalCy + labelH / 2,
    });

    return {
      x: item.x,
      y: item.y,
      playerId: item.p.playerId,
      name: item.p.playerName,
      color: item.p.color,
      labelDx: bestCandidate.dx,
      labelDy: bestCandidate.dy,
    };
  });
}

export default function PlayerStyleTab({
  games,
  allGames,
  players,
  selectedPlayers,
  onTogglePlayer,
  gamePlayersByGameId,
  getPlayerColor,
  timeframeLabel,
}: PlayerStyleTabProps) {
  const { t } = useTranslation();

  const [showPermGuestsPicker, setShowPermGuestsPicker] = useState(false);
  const [showOccGuestsPicker, setShowOccGuestsPicker] = useState(false);
  const [showMapHelp, setShowMapHelp] = useState(true);
  const [showRadarHelp, setShowRadarHelp] = useState(true);

  // Per-player game count in the currently selected period (for sorting & displaying guest pills)
  const periodGamesByPlayerId = useMemo(() => {
    const counts = new Map<string, number>();
    for (const g of games) {
      const byP = gamePlayersByGameId.get(g.id);
      byP?.forEach((_, pid) => {
        counts.set(pid, (counts.get(pid) || 0) + 1);
      });
    }
    return counts;
  }, [games, gamePlayersByGameId]);

  const { permGuestList, occGuestList } = useMemo(() => {
    const pg = players
      .filter(p => p.type === 'permanent_guest' && ((periodGamesByPlayerId.get(p.id) || 0) > 0 || selectedPlayers.has(p.id)))
      .sort((a, b) => (periodGamesByPlayerId.get(b.id) || 0) - (periodGamesByPlayerId.get(a.id) || 0));
    const og = players
      .filter(p => p.type === 'guest' && ((periodGamesByPlayerId.get(p.id) || 0) > 0 || selectedPlayers.has(p.id)))
      .sort((a, b) => (periodGamesByPlayerId.get(b.id) || 0) - (periodGamesByPlayerId.get(a.id) || 0));
    return { permGuestList: pg, occGuestList: og };
  }, [players, periodGamesByPlayerId, selectedPlayers]);

  const selectedPermGuestsCount = useMemo(
    () => permGuestList.filter(p => selectedPlayers.has(p.id)).length,
    [permGuestList, selectedPlayers]
  );
  const selectedOccGuestsCount = useMemo(
    () => occGuestList.filter(p => selectedPlayers.has(p.id)).length,
    [occGuestList, selectedPlayers]
  );

  const analysis = useMemo(
    () =>
      computeGroupStyleProfiles(games, players, gamePlayersByGameId, getPlayerColor, allGames, {
        selectedPlayerIds: selectedPlayers,
      }),
    [games, allGames, players, gamePlayersByGameId, getPlayerColor, selectedPlayers]
  );

  const [selectedId, setSelectedId] = useState<string>('');
  const [isSharingMap, setIsSharingMap] = useState(false);
  const [isSharingPlayer, setIsSharingPlayer] = useState(false);
  const mapCardRef = useRef<HTMLDivElement>(null);
  const playerCardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (analysis.profiles.length > 0 && !analysis.profiles.some(p => p.playerId === selectedId)) {
      setSelectedId(analysis.profiles[0].playerId);
    }
  }, [analysis.profiles, selectedId]);

  const selectedProfile = useMemo(
    () => analysis.profiles.find(p => p.playerId === selectedId) || analysis.profiles[0] || null,
    [analysis.profiles, selectedId]
  );

  const playerSelectOptions = useMemo<StyledSelectOption<string>[]>(() => {
    return analysis.profiles.map(p => ({
      value: p.playerId,
      label: `${p.archetype.emoji} ${p.playerName} (${fmtSigned(p.totalProfit)}₪ · ${p.gamesPlayed} מש׳)`,
      group:
        p.playerType === 'permanent_guest'
          ? t('settings.players.groupPermanentGuest')
          : p.playerType === 'guest'
            ? t('history.occasional')
            : undefined,
    }));
  }, [analysis.profiles, t]);

  const { yMinDomain, yMaxDomain } = useMemo(() => {
    if (analysis.profiles.length === 0) return { yMinDomain: -100, yMaxDomain: 100 };
    const ys = analysis.profiles.map(p => Math.round(p.avgProfit));
    return {
      yMinDomain: Math.floor(Math.min(-30, Math.min(...ys) - 25) / 10) * 10,
      yMaxDomain: Math.ceil(Math.max(30, Math.max(...ys) + 30) / 10) * 10,
    };
  }, [analysis.profiles]);

  const scatterData = useMemo(
    () => computeSmartScatterPoints(analysis.profiles, yMinDomain, yMaxDomain),
    [analysis.profiles, yMinDomain, yMaxDomain]
  );

  const radarData = useMemo(() => {
    if (!selectedProfile) return [];
    const g = analysis.groupAvgRadar;
    return [
      { axis: t('graphs.radarWins'), player: selectedProfile.radar.winRate, group: g.winRate },
      { axis: t('graphs.radarConsistency'), player: selectedProfile.radar.consistency, group: g.consistency },
      { axis: t('graphs.radarUpside'), player: selectedProfile.radar.upside, group: g.upside },
      { axis: t('graphs.radarComeback'), player: selectedProfile.radar.comeback, group: g.comeback },
      { axis: t('graphs.radarAction'), player: selectedProfile.radar.action, group: g.action },
    ];
  }, [selectedProfile, analysis.groupAvgRadar, t]);

  const radarBreakdownRows = useMemo(() => {
    if (!selectedProfile) return [];
    const g = analysis.groupAvgRadar;
    const hasRebuyData = selectedProfile.trackedRebuyGames > 0;
    const upsideReal =
      selectedProfile.avgWinSize > 0
        ? `ממוצע ניצחון ${fmtSigned(selectedProfile.avgWinSize)}₪ · ${selectedProfile.bigWins} גדולים`
        : `שיא ערב ${fmtSigned(selectedProfile.bestWin)}₪ · 0 גדולים`;
    return [
      {
        label: '🎯 אחוז נצחונות',
        explain: 'תדירות סיום ערב ברווח בתקופה הנבחרת',
        realVal: `${Math.round(selectedProfile.winRate)}% (שולחן ${Math.round(analysis.groupAvgWinRate)}%)`,
        score: selectedProfile.radar.winRate,
        groupScore: g.winRate,
      },
      {
        label: '🛡️ שליטה בסיכון',
        explain: 'הימנעות מהפסדי ענק ומריבאיים מיותרים בתקופה',
        realVal: hasRebuyData
          ? `${selectedProfile.bigLosses} הפסדים גדולים · ${selectedProfile.avgRebuys.toFixed(1)} ריבאי`
          : `${selectedProfile.bigLosses} הפסדים גדולים · σ=${cleanNumber(Math.round(selectedProfile.downsideDev))}₪`,
        score: selectedProfile.radar.consistency,
        groupScore: g.consistency,
      },
      {
        label: '💥 עוצמת פיק',
        explain: 'גודל זכייה ממוצעת וערבי קצה חיוביים בתקופה',
        realVal: upsideReal,
        score: selectedProfile.radar.upside,
        groupScore: g.upside,
      },
      {
        label: '🔄 קאמבק מריבאי',
        explain: 'יכולת לחזור לרווח בערבי קניות מרובות בתקופה',
        realVal: selectedProfile.comebackLabel,
        score: selectedProfile.radar.comeback,
        groupScore: g.comeback,
      },
      {
        label: '🔥 אקשן וקופות',
        explain: 'כמות ריבאיים וגודל התנודות בשולחן בתקופה',
        realVal: hasRebuyData
          ? `σ=${cleanNumber(Math.round(selectedProfile.stdDev))}₪ · ${selectedProfile.avgRebuys.toFixed(1)} ריבאי/מש׳`
          : `σ=${cleanNumber(Math.round(selectedProfile.stdDev))}₪ · תנודה ${cleanNumber(Math.round(selectedProfile.avgAbsSwing))}₪`,
        score: selectedProfile.radar.action,
        groupScore: g.action,
      },
    ];
  }, [selectedProfile, analysis]);

  const handleShareImage = async (
    ref: React.RefObject<HTMLDivElement | null>,
    setSharing: (v: boolean) => void,
    fileName: string
  ) => {
    if (!ref.current) return;
    setSharing(true);
    try {
      const files = await captureAndSplit(ref.current, fileName);
      await shareFiles(files, 'Poker Style Profile');
    } catch { /* */ } finally {
      setSharing(false);
    }
  };

  const handleWhatsAppSharePlayer = () => {
    if (!selectedProfile) return;
    const LTR = '\u200E';
    const lines = [
      `🎭 *פרופיל אופי וסגנון משחק — ${selectedProfile.playerName}* (${timeframeLabel})`,
      `${selectedProfile.archetype.emoji} *${selectedProfile.archetype.title}* | תג סגנון: *${selectedProfile.archetype.styleBadge}*`,
      `${selectedProfile.archetype.description}`,
      ``,
      `📊 *מדדים מרכזיים (${timeframeLabel}):*`,
      `${LTR}• סה״כ בתקופה: *${fmtSigned(selectedProfile.totalProfit)}₪* (${selectedProfile.gamesPlayed} משחקים, ממוצע ${fmtSigned(selectedProfile.avgProfit)}₪)`,
      `${LTR}• סטיית תקן (σ): *${cleanNumber(Math.round(selectedProfile.stdDev))}₪* | זכיות/הפסדים ${analysis.bigSwingThreshold}₪+: *${selectedProfile.bigWins}* זכיות מול *${selectedProfile.bigLosses}* הפסדים`,
      `${LTR}• ריבאיים למשחק: *${selectedProfile.avgRebuys.toFixed(1)}* (ממוצע שולחן ${analysis.groupAvgRebuys.toFixed(1)})`,
      ``,
      `🔍 *הוכחות מהנתונים:*`,
      ...selectedProfile.traits.map(tr => `• ${tr}`),
    ];
    shareToWhatsApp(lines.join('\n'));
  };

  const handleWhatsAppShareGroup = () => {
    const LTR = '\u200E';
    const lines = [
      `🎭 *מפת סגנון ואופי השחקנים* (${timeframeLabel})`,
      `━━━━━━━━━━━━━━━━━━━━`,
      ...analysis.profiles.map(
        (p, idx) =>
          `${LTR}${idx + 1}. ${p.archetype.emoji} *${p.playerName}* — *${p.archetype.title}*\n   סה״כ ${fmtSigned(p.totalProfit)}₪ (${p.gamesPlayed} מש׳, ממוצע ${fmtSigned(p.avgProfit)}₪) | σ=${cleanNumber(Math.round(p.stdDev))}₪ | ${p.avgRebuys.toFixed(1)} ריבאי/מש׳`
      ),
    ];
    shareToWhatsApp(lines.join('\n'));
  };

  const handleToggleGuestPill = (guestId: string) => {
    const wasSelected = selectedPlayers.has(guestId);
    onTogglePlayer(guestId);
    if (!wasSelected) {
      setSelectedId(guestId);
    }
  };

  const renderSpecificGuestPill = (guest: Player) => {
    const isSel = selectedPlayers.has(guest.id);
    const color = getPlayerColor(guest.id);
    const gamesInPeriod = periodGamesByPlayerId.get(guest.id) || 0;
    return (
      <button
        key={guest.id}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          handleToggleGuestPill(guest.id);
        }}
        style={{
          padding: '0.32rem 0.6rem',
          borderRadius: '16px',
          border: isSel ? `2px solid ${color}` : '1.5px solid var(--border)',
          background: isSel ? `${color}22` : 'var(--surface)',
          cursor: 'pointer',
          fontSize: '0.75rem',
          fontWeight: '600',
          color: isSel ? color : 'var(--text-muted)',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.25rem',
          transition: 'all 0.15s ease',
        }}
      >
        <span>{isSel && '✓ '}{guest.name}</span>
        {gamesInPeriod > 0 && (
          <span style={{ fontSize: '0.62rem', opacity: 0.75, fontWeight: '500' }}>
            ({gamesInPeriod})
          </span>
        )}
      </button>
    );
  };

  if (analysis.profiles.length === 0) {
    return (
      <div className="card">
        <div className="empty-state">
          <div className="empty-icon">🎭</div>
          <p>{t('graphs.styleNotEnoughData')}</p>
          <p className="text-muted">{timeframeLabel}</p>
        </div>
      </div>
    );
  }

  const chartKey = `${timeframeLabel}-${games.length}-${analysis.profiles.map(p => p.playerId).join(',')}`;

  return (
    <>
      {/* Specific Guest Selection Card (matches Trends/Graphs screen pattern — pick individual guests!) */}
      {(permGuestList.length > 0 || occGuestList.length > 0) && (
        <div className="card" style={{ padding: '0.6rem 0.75rem', marginBottom: '0.6rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.4rem', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: '600' }}>
              👥 הוספת אורחים ספציפיים לניתוח ({timeframeLabel}):
            </span>
            <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
              {permGuestList.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowPermGuestsPicker(v => !v)}
                  style={{
                    padding: '0.25rem 0.58rem',
                    fontSize: '0.7rem',
                    fontWeight: '600',
                    borderRadius: '999px',
                    border: selectedPermGuestsCount > 0 || showPermGuestsPicker ? '1.5px solid var(--primary)' : '1px solid var(--border)',
                    background: selectedPermGuestsCount > 0 ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
                    color: selectedPermGuestsCount > 0 ? 'var(--primary)' : 'var(--text-muted)',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.3rem',
                  }}
                >
                  <span>🏠 אורחים קבועים ({permGuestList.length})</span>
                  {selectedPermGuestsCount > 0 && (
                    <span style={{
                      background: 'var(--primary)',
                      color: '#fff',
                      borderRadius: '999px',
                      padding: '0.02rem 0.38rem',
                      fontSize: '0.62rem',
                      fontWeight: '700',
                    }}>
                      {selectedPermGuestsCount}
                    </span>
                  )}
                  <span style={{ fontSize: '0.65rem' }}>{showPermGuestsPicker ? '▲' : '▼'}</span>
                </button>
              )}
              {occGuestList.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowOccGuestsPicker(v => !v)}
                  style={{
                    padding: '0.25rem 0.58rem',
                    fontSize: '0.7rem',
                    fontWeight: '600',
                    borderRadius: '999px',
                    border: selectedOccGuestsCount > 0 || showOccGuestsPicker ? '1.5px solid #3B82F6' : '1px solid var(--border)',
                    background: selectedOccGuestsCount > 0 ? 'rgba(59, 130, 246, 0.15)' : 'var(--surface)',
                    color: selectedOccGuestsCount > 0 ? '#60A5FA' : 'var(--text-muted)',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.3rem',
                  }}
                >
                  <span>👤 שחקנים מזדמנים ({occGuestList.length})</span>
                  {selectedOccGuestsCount > 0 && (
                    <span style={{
                      background: '#3B82F6',
                      color: '#fff',
                      borderRadius: '999px',
                      padding: '0.02rem 0.38rem',
                      fontSize: '0.62rem',
                      fontWeight: '700',
                    }}>
                      {selectedOccGuestsCount}
                    </span>
                  )}
                  <span style={{ fontSize: '0.65rem' }}>{showOccGuestsPicker ? '▲' : '▼'}</span>
                </button>
              )}
            </div>
          </div>

          {showPermGuestsPicker && permGuestList.length > 0 && (
            <div style={{ marginTop: '0.5rem', paddingTop: '0.45rem', borderTop: '1px dashed var(--border)' }}>
              <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '0.35rem' }}>
                בחר אורחים קבועים להצגה במפה ובעכביש (מספר המשחקים בתקופה בסוגריים):
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.38rem' }}>
                {permGuestList.map(guest => renderSpecificGuestPill(guest))}
              </div>
            </div>
          )}

          {showOccGuestsPicker && occGuestList.length > 0 && (
            <div style={{ marginTop: '0.5rem', paddingTop: '0.45rem', borderTop: '1px dashed var(--border)' }}>
              <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '0.35rem' }}>
                בחר שחקנים מזדמנים להצגה במפה ובעכביש (מספר המשחקים בתקופה בסוגריים):
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.38rem' }}>
                {occGuestList.map(guest => renderSpecificGuestPill(guest))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 1. Group 4-Quadrant Map */}
      <div ref={mapCardRef} className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.25rem' }}>
          <h2 className="card-title" style={{ margin: 0 }}>{t('graphs.styleMapTitle')}</h2>
          <button
            type="button"
            onClick={() => setShowMapHelp(v => !v)}
            style={{
              fontSize: '0.66rem',
              padding: '0.18rem 0.5rem',
              borderRadius: '999px',
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            {showMapHelp ? 'הסתר הסבר ▲' : 'איך קוראים את הגרף? ▼'}
          </button>
        </div>

        <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
          תקופה נבחרת: <strong style={{ color: 'var(--text)' }}>{timeframeLabel}</strong> ({games.length} משחקים) • {analysis.profiles.length} שחקנים • לחץ על שחקן לניתוח
        </div>

        {/* Clear How-to-Read Guide Box + 4 Quadrants Legend (OUTSIDE chart so text never overlaps dots!) */}
        {showMapHelp && (
          <div style={{
            padding: '0.55rem 0.65rem',
            marginBottom: '0.6rem',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            fontSize: '0.67rem',
            lineHeight: 1.45,
          }}>
            <div style={{ fontWeight: '700', color: 'var(--text)', marginBottom: '0.25rem' }}>
              📖 איך קוראים את מפת הסגנון?
            </div>
            <div style={{ color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
              • <strong>ציר אנכי (Y — למעלה/למטה):</strong> ממוצע רווח או הפסד למשחק ב-₪ בתקופה הנבחרת (מעל קו ה-0 = מורווח, מתחת = מופסד).<br />
              • <strong>ציר אופקי (X — שמאל/ימין):</strong> מדד תנודתיות ואגרסיביות בתקופה הנבחרת (0–100) המשלב קצב ריבאיים, סטיית תקן (σ) ועומק הפסדים. הקו האנכי המקווקו הוא קו האמצע ({analysis.medianVolatility}).
            </div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: '0.3rem',
              fontSize: '0.62rem',
              direction: 'ltr',
            }}>
              <div dir="rtl" style={{ padding: '0.28rem 0.4rem', borderRadius: '6px', background: 'rgba(16, 185, 129, 0.08)', border: '1px solid rgba(16, 185, 129, 0.25)', textAlign: 'right', wordBreak: 'break-word' }}>
                <strong style={{ color: '#34d399' }}>🎯 שמאל-למעלה (רווחי וסולידי):</strong> מרוויח עם מעט ריבאיים והפסדים קטנים
              </div>
              <div dir="rtl" style={{ padding: '0.28rem 0.4rem', borderRadius: '6px', background: 'rgba(16, 185, 129, 0.08)', border: '1px solid rgba(16, 185, 129, 0.25)', textAlign: 'right', wordBreak: 'break-word' }}>
                <strong style={{ color: '#10B981' }}>🦈 ימין-למעלה (רווחי ואגרסיבי):</strong> מרוויח דרך קופות ענק וריבאיים רבים
              </div>
              <div dir="rtl" style={{ padding: '0.28rem 0.4rem', borderRadius: '6px', background: 'rgba(148, 163, 184, 0.08)', border: '1px solid var(--border)', textAlign: 'right', wordBreak: 'break-word' }}>
                <strong style={{ color: 'var(--text)' }}>🛡️ שמאל-למטה (מופסד וסולידי):</strong> קניות מבוקרות אך חסר זכיות גדולות
              </div>
              <div dir="rtl" style={{ padding: '0.28rem 0.4rem', borderRadius: '6px', background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.25)', textAlign: 'right', wordBreak: 'break-word' }}>
                <strong style={{ color: '#F59E0B' }}>🎢 ימין-למטה (מופסד ותנודתי):</strong> ריבאיים מרובים או הפסדים כבדים
              </div>
            </div>
          </div>
        )}

        {/* Y-axis clear title bar */}
        <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', marginBottom: '0.15rem', paddingRight: '0.2rem' }}>
          ↕ <strong>ציר אנכי (Y):</strong> ממוצע רווח / הפסד למשחק ב{timeframeLabel} (₪)
        </div>

        <div style={{ position: 'relative', width: '100%', height: '275px', direction: 'ltr' }}>
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart key={chartKey} margin={{ top: 22, right: 24, bottom: 18, left: 2 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.4} />
              <XAxis
                type="number"
                dataKey="x"
                domain={[0, 105]}
                stroke="var(--text-muted)"
                fontSize={10}
                tickLine={false}
                tickFormatter={(v) => cleanNumber(v)}
              />
              <YAxis
                type="number"
                dataKey="y"
                domain={[yMinDomain, yMaxDomain]}
                stroke="var(--text-muted)"
                fontSize={10}
                width={38}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => cleanNumber(v)}
              />
              <ReferenceLine y={0} stroke="var(--text-muted)" strokeDasharray="4 4" opacity={0.75} />
              <ReferenceLine x={Math.round(analysis.medianVolatility)} stroke="var(--text-muted)" strokeDasharray="4 4" opacity={0.75} />
              <Scatter
                data={scatterData}
                isAnimationActive={false}
                onClick={(entry) => {
                  const pid = (entry as unknown as { playerId?: string })?.playerId;
                  if (pid) setSelectedId(pid);
                }}
                shape={(props: unknown) => {
                  const p = props as {
                    cx?: number;
                    cy?: number;
                    payload?: ScatterPointItem;
                  };
                  const cx = p.cx ?? 0;
                  const cy = p.cy ?? 0;
                  const item = p.payload;
                  if (!item) return <g />;
                  const isSel = item.playerId === selectedProfile?.playerId;
                  const r = isSel ? 7.5 : 5.5;
                  const lx = cx + item.labelDx;
                  const ly = cy + item.labelDy;

                  return (
                    <g
                      style={{ cursor: 'pointer' }}
                      onClick={() => setSelectedId(item.playerId)}
                    >
                      {/* Invisible touch target for effortless mobile tapping */}
                      <circle cx={cx} cy={cy} r={16} fill="transparent" />
                      <circle
                        cx={cx}
                        cy={cy}
                        r={r}
                        fill={item.color}
                        fillOpacity={isSel ? 1 : 0.85}
                        stroke={isSel ? '#ffffff' : item.color}
                        strokeWidth={isSel ? 2.5 : 1}
                      />
                      <text
                        x={lx}
                        y={ly}
                        textAnchor="middle"
                        fill={isSel ? '#ffffff' : 'var(--text)'}
                        stroke="rgba(15, 23, 42, 0.92)"
                        strokeWidth={3}
                        paintOrder="stroke"
                        style={{
                          fontSize: isSel ? '11px' : '9.5px',
                          fontWeight: isSel ? 700 : 600,
                          pointerEvents: 'none',
                        }}
                      >
                        {item.name}
                      </text>
                    </g>
                  );
                }}
              >
                {scatterData.map((entry) => (
                  <Cell key={entry.playerId} fill={entry.color} />
                ))}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </div>

        {/* Mobile-clean X-axis explanation bar */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '0.25rem',
          fontSize: '0.6rem',
          color: 'var(--text-muted)',
          padding: '0.28rem 0.5rem',
          marginTop: '0.25rem',
          background: 'var(--surface)',
          borderRadius: '6px',
          border: '1px solid var(--border)',
          direction: 'ltr',
          whiteSpace: 'nowrap',
        }}>
          <span>← סולידי ומבוקר (0)</span>
          <span style={{ fontWeight: '600', color: 'var(--text)' }}>ציר X: תנודתיות</span>
          <span>אגרסיבי ותנודתי (100) →</span>
        </div>

        {/* Player Dropdown + Tappable Pills */}
        <div style={{ marginTop: '0.65rem' }}>
          <div style={{ marginBottom: '0.45rem' }}>
            <StyledSelect<string>
              value={selectedProfile?.playerId || ''}
              onChange={setSelectedId}
              options={playerSelectOptions}
              variant="green"
              size="md"
              fullWidth
              title="בחר שחקן לניתוח אופי"
            />
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '0.35rem' }}>
            {analysis.profiles.map(p => {
              const isSel = p.playerId === selectedProfile?.playerId;
              return (
                <button
                  key={p.playerId}
                  type="button"
                  onClick={() => setSelectedId(p.playerId)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.28rem',
                    padding: '0.28rem 0.58rem',
                    fontSize: '0.72rem',
                    fontWeight: isSel ? '700' : '600',
                    borderRadius: '999px',
                    border: isSel ? `1.5px solid ${p.color}` : '1px solid var(--border)',
                    background: isSel ? `${p.color}24` : 'var(--surface)',
                    color: isSel ? p.color : 'var(--text-muted)',
                    cursor: 'pointer',
                  }}
                >
                  <span>{p.archetype.emoji}</span>
                  <span>{p.playerName}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Share buttons for Group Map */}
      <div style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: '0.5rem', marginTop: '-0.4rem', marginBottom: '0.65rem' }}>
        <button
          type="button"
          onClick={() => handleShareImage(mapCardRef, setIsSharingMap, 'poker-style-map')}
          disabled={isSharingMap}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem', fontSize: '0.72rem', padding: '0.38rem 0.75rem', background: 'var(--surface)', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: '6px', cursor: 'pointer' }}
        >
          {isSharingMap ? t('common.capturing') : '📸 שתף מפה (תמונה)'}
        </button>
        <button
          type="button"
          onClick={handleWhatsAppShareGroup}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem', fontSize: '0.72rem', padding: '0.38rem 0.75rem', background: 'rgba(16, 185, 129, 0.12)', color: '#34d399', border: '1px solid rgba(16, 185, 129, 0.35)', borderRadius: '6px', cursor: 'pointer', fontWeight: '600' }}
        >
          📲 שתף דירוג בוואטסאפ
        </button>
      </div>

      {/* 2. Personal Player Radar & Deep Profile Card */}
      {selectedProfile && (
        <>
          <div ref={playerCardRef} className="card">
            {/* Header: Archetype + Style Credibility Badge + Period Total Profit */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.45rem', minWidth: 0 }}>
                <span style={{ fontSize: '1.5rem', lineHeight: 1.1, flexShrink: 0 }}>{selectedProfile.archetype.emoji}</span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '0.92rem', fontWeight: '700', color: selectedProfile.color }}>
                      {selectedProfile.playerName} · {selectedProfile.archetype.title}
                    </span>
                    <span style={{
                      fontSize: '0.6rem',
                      fontWeight: '700',
                      padding: '0.1rem 0.42rem',
                      borderRadius: '999px',
                      background: `${selectedProfile.color}20`,
                      color: selectedProfile.color,
                      border: `1px solid ${selectedProfile.color}50`,
                      maxWidth: '100%',
                    }}>
                      {selectedProfile.archetype.styleBadge}
                    </span>
                  </div>
                  <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: '0.12rem' }}>
                    נתוני תקופה נבחרת: <strong style={{ color: 'var(--text)' }}>{timeframeLabel}</strong>
                  </div>
                </div>
              </div>
              <div style={{ textAlign: 'left', flexShrink: 0 }}>
                <div style={{
                  fontSize: '0.88rem',
                  fontWeight: '700',
                  color: selectedProfile.totalProfit >= 0 ? '#10B981' : '#EF4444',
                  direction: 'ltr',
                  unicodeBidi: 'isolate',
                }}>
                  {fmtSigned(selectedProfile.totalProfit)}₪
                </div>
                <div style={{ fontSize: '0.58rem', color: 'var(--text-muted)', textAlign: 'left', whiteSpace: 'nowrap' }}>
                  {selectedProfile.gamesPlayed} מש׳ (#{selectedProfile.profitRank}/{selectedProfile.totalPlayersInGroup})
                </div>
              </div>
            </div>

            {/* Unique Personalized Summary Paragraph */}
            <div style={{
              fontSize: '0.73rem',
              color: 'var(--text)',
              lineHeight: 1.45,
              padding: '0.45rem 0.6rem',
              marginBottom: '0.55rem',
              background: 'var(--surface)',
              borderRadius: '8px',
              borderRight: `3px solid ${selectedProfile.color}`,
            }}>
              {selectedProfile.archetype.description}
            </div>

            {/* 4-Metric Statistical Strip (Mobile-responsive, with aligned Wins over Wins and Losses over Losses) */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
              gap: '0.32rem',
              marginBottom: '0.55rem',
            }}>
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.35rem 0.2rem', textAlign: 'center', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: '0.15rem' }}>
                <div style={{ fontSize: '0.56rem', color: 'var(--text-muted)', lineHeight: 1.15 }}>ממוצע למשחק</div>
                <div style={{ fontSize: '0.76rem', fontWeight: '700', color: selectedProfile.avgProfit >= 0 ? '#10B981' : '#EF4444', direction: 'ltr', unicodeBidi: 'isolate', lineHeight: 1.2 }}>
                  {fmtSigned(selectedProfile.avgProfit)}₪
                </div>
                <div style={{ fontSize: '0.52rem', color: 'var(--text-muted)', lineHeight: 1.1 }}>
                  {Math.round(selectedProfile.winRate)}% ניצחון
                </div>
              </div>

              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.35rem 0.2rem', textAlign: 'center', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: '0.15rem' }}>
                <div style={{ fontSize: '0.56rem', color: 'var(--text-muted)', lineHeight: 1.15 }}>סטיית תקן (σ)</div>
                <div style={{ fontSize: '0.76rem', fontWeight: '700', color: 'var(--text)', direction: 'ltr', unicodeBidi: 'isolate', lineHeight: 1.2 }}>
                  {cleanNumber(Math.round(selectedProfile.stdDev))}₪
                </div>
                <div style={{ fontSize: '0.52rem', color: 'var(--text-muted)', lineHeight: 1.1 }}>
                  שולחן: {cleanNumber(Math.round(analysis.groupAvgStdDev))}₪
                </div>
              </div>

              {/* Vertically paired columns so green win count sits directly above זכיות and red loss count sits directly above הפסדים */}
              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.35rem 0.2rem', textAlign: 'center', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: '0.12rem' }}>
                <div style={{ fontSize: '0.56rem', color: 'var(--text-muted)', lineHeight: 1.15 }}>ערבי ±{analysis.bigSwingThreshold}₪+</div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.22rem', direction: 'rtl' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1.15 }}>
                    <span style={{ fontSize: '0.76rem', fontWeight: '700', color: '#10B981' }}>{selectedProfile.bigWins}</span>
                    <span style={{ fontSize: '0.5rem', color: 'var(--text-muted)' }}>זכיות</span>
                  </div>
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.68rem', alignSelf: 'flex-start' }}>/</span>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1.15 }}>
                    <span style={{ fontSize: '0.76rem', fontWeight: '700', color: '#EF4444' }}>{selectedProfile.bigLosses}</span>
                    <span style={{ fontSize: '0.5rem', color: 'var(--text-muted)' }}>הפסדים</span>
                  </div>
                </div>
              </div>

              <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.35rem 0.2rem', textAlign: 'center', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: '0.15rem' }}>
                <div style={{ fontSize: '0.56rem', color: 'var(--text-muted)', lineHeight: 1.15 }}>ריבאיים למשחק</div>
                <div style={{ fontSize: '0.76rem', fontWeight: '700', color: 'var(--text)', direction: 'ltr', unicodeBidi: 'isolate', lineHeight: 1.2 }}>
                  {selectedProfile.trackedRebuyGames > 0 ? selectedProfile.avgRebuys.toFixed(1) : '—'}
                </div>
                <div style={{ fontSize: '0.52rem', color: 'var(--text-muted)', lineHeight: 1.1 }}>
                  שולחן: {analysis.groupAvgRebuys.toFixed(1)}
                </div>
              </div>
            </div>

            {/* Spider / Radar Header + Toggleable Explanation */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap', marginBottom: '0.2rem' }}>
              <span style={{ fontSize: '0.73rem', fontWeight: '700', color: 'var(--text)' }}>
                🕸️ גרף עכביש — 5 ממדי המשחק של {selectedProfile.playerName} ({timeframeLabel})
              </span>
              <button
                type="button"
                onClick={() => setShowRadarHelp(v => !v)}
                style={{
                  fontSize: '0.64rem',
                  padding: '0.15rem 0.45rem',
                  borderRadius: '999px',
                  border: '1px solid var(--border)',
                  background: 'var(--surface)',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                {showRadarHelp ? 'הסתר פירוט ▲' : 'מה אומר העכביש? ▼'}
              </button>
            </div>

            <div style={{ width: '100%', height: '235px', direction: 'ltr' }}>
              <ResponsiveContainer width="100%" height="100%">
                <RadarChart
                  key={`${chartKey}-${selectedProfile.playerId}`}
                  cx="50%"
                  cy="50%"
                  outerRadius="60%"
                  margin={{ top: 10, right: 26, bottom: 10, left: 26 }}
                  data={radarData}
                >
                  <PolarGrid stroke="var(--border)" />
                  <PolarAngleAxis
                    dataKey="axis"
                    tick={{ fill: 'var(--text)', fontSize: 10.5, fontWeight: 600 }}
                  />
                  <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
                  <Radar
                    name={t('graphs.groupAverage')}
                    dataKey="group"
                    stroke="var(--text-muted)"
                    strokeDasharray="3 3"
                    fill="var(--text-muted)"
                    fillOpacity={0.12}
                    isAnimationActive={false}
                  />
                  <Radar
                    name={selectedProfile.playerName}
                    dataKey="player"
                    stroke={selectedProfile.color}
                    strokeWidth={2.5}
                    fill={selectedProfile.color}
                    fillOpacity={0.28}
                    isAnimationActive={false}
                  />
                </RadarChart>
              </ResponsiveContainer>
            </div>

            {/* Radar Legend */}
            <div style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: '1rem', fontSize: '0.66rem', marginTop: '-0.2rem', marginBottom: '0.55rem' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', color: selectedProfile.color, fontWeight: '600' }}>
                <span style={{ width: '10px', height: '3px', background: selectedProfile.color, borderRadius: '2px' }} />
                {selectedProfile.playerName} (0–100 ב{timeframeLabel})
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', color: 'var(--text-muted)' }}>
                <span style={{ width: '10px', height: '0px', borderTop: '2px dashed var(--text-muted)' }} />
                {t('graphs.groupAverage')} ({timeframeLabel})
              </span>
            </div>

            {/* Spider / Radar Explanation & Mobile-Friendly 5-Axis Real Numbers Breakdown */}
            {showRadarHelp && (
              <div style={{
                padding: '0.5rem 0.6rem',
                marginBottom: '0.6rem',
                background: 'var(--surface)',
                borderRadius: '8px',
                border: '1px solid var(--border)',
              }}>
                <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '0.4rem', lineHeight: 1.4 }}>
                  💡 <strong>איך קוראים את העכביש?</strong> כל קודקוד מדרג את השחקן מ-<strong>0 עד 100</strong> על בסיס ביצועיו ב<strong>{timeframeLabel}</strong>. ככל שהצורה הצבעונית יוצאת החוצה מעבר לקו המקווקו (ממוצע השולחן בתקופה), השחקן בולט יותר באותו ממד:
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                  {radarBreakdownRows.map((row, i) => (
                    <div
                      key={i}
                      style={{
                        padding: '0.28rem 0.4rem',
                        borderRadius: '6px',
                        background: 'rgba(255,255,255,0.02)',
                      }}
                    >
                      <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: '0.35rem',
                        flexWrap: 'wrap',
                      }}>
                        <span style={{ fontWeight: '700', color: 'var(--text)', fontSize: '0.66rem' }}>
                          {row.label}
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                          <span style={{ fontSize: '0.62rem', color: 'var(--text-muted)', direction: 'ltr', unicodeBidi: 'isolate' }}>
                            {row.realVal}
                          </span>
                          <span style={{
                            fontWeight: '700',
                            fontSize: '0.64rem',
                            padding: '0.06rem 0.35rem',
                            borderRadius: '4px',
                            background: row.score >= row.groupScore ? 'rgba(16, 185, 129, 0.15)' : 'rgba(148, 163, 184, 0.12)',
                            color: row.score >= row.groupScore ? '#34d399' : 'var(--text-muted)',
                            direction: 'ltr',
                          }}>
                            {row.score}
                          </span>
                        </div>
                      </div>
                      <div style={{ fontSize: '0.58rem', color: 'var(--text-muted)', marginTop: '0.08rem', lineHeight: 1.3 }}>
                        {row.explain}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 4 Deep Personalized Proof Bullets */}
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '0.38rem',
              padding: '0.6rem 0.65rem',
              background: 'var(--surface)',
              borderRadius: '8px',
              border: '1px solid var(--border)',
            }}>
              <div style={{ fontSize: '0.7rem', fontWeight: '700', color: 'var(--text)', marginBottom: '0.1rem' }}>
                📊 הוכחות ומספרים מאחורי האבחנה של {selectedProfile.playerName} ({timeframeLabel}):
              </div>
              {selectedProfile.traits.map((trait, idx) => (
                <div key={idx} style={{ fontSize: '0.71rem', color: 'var(--text)', display: 'flex', gap: '0.38rem', alignItems: 'baseline', lineHeight: 1.42 }}>
                  <span style={{ color: selectedProfile.color, fontWeight: '700', flexShrink: 0 }}>{idx + 1}.</span>
                  <span>{trait}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Share buttons for Selected Player Card */}
          <div style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: '0.5rem', marginTop: '-0.4rem', marginBottom: '0.6rem' }}>
            <button
              type="button"
              onClick={() => handleShareImage(playerCardRef, setIsSharingPlayer, `poker-style-${selectedProfile.playerName}`)}
              disabled={isSharingPlayer}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem', fontSize: '0.72rem', padding: '0.4rem 0.8rem', background: 'var(--surface)', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: '6px', cursor: 'pointer' }}
            >
              {isSharingPlayer ? t('common.capturing') : `📸 שתף כרטיס (${selectedProfile.playerName})`}
            </button>
            <button
              type="button"
              onClick={handleWhatsAppSharePlayer}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem', fontSize: '0.72rem', padding: '0.4rem 0.8rem', background: 'rgba(16, 185, 129, 0.12)', color: '#34d399', border: '1px solid rgba(16, 185, 129, 0.35)', borderRadius: '6px', cursor: 'pointer', fontWeight: '600' }}
            >
              📲 שתף פרופיל בוואטסאפ
            </button>
          </div>
        </>
      )}
    </>
  );
}
