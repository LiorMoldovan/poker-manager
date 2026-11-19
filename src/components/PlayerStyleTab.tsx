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
  LineChart,
  Line,
  Tooltip,
} from 'recharts';
import { Game, GamePlayer, Player } from '../types';
import { cleanNumber } from '../utils/calculations';
import {
  computeGroupStyleProfiles,
  computeGroupStyleEvolution,
  PlayerStyleMetrics,
} from '../utils/playerStyleProfile';
import { captureAndSplit, shareFiles } from '../utils/sharing';
import { useTranslation } from '../i18n';

interface PlayerStyleTabProps {
  games: Game[];
  allGames?: Game[];
  players: Player[];
  selectedPlayers: Set<string>;
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
  xMinDomain: number,
  xMaxDomain: number,
  yMinDomain: number,
  yMaxDomain: number
): ScatterPointItem[] {
  if (profiles.length === 0) return [];
  const plotW = 280;
  const plotH = 210;
  const xSpan = Math.max(15, xMaxDomain - xMinDomain);
  const ySpan = Math.max(20, yMaxDomain - yMinDomain);

  const raw: Array<{ p: PlayerStyleMetrics; x: number; y: number; px: number; py: number }> = [];
  for (const p of profiles) {
    let x = Math.round(p.volatility);
    const y = Math.round(p.avgProfit);
    // Deterministic de-clustering if two dots have near-identical coordinates
    for (const prev of raw) {
      if (Math.abs(prev.x - x) <= 2 && Math.abs(prev.y - y) <= 4) {
        const canMoveRight = x < 46 || (x >= 50 && x <= xMaxDomain - 4);
        x = canMoveRight ? x + 2 : Math.max(xMinDomain + 2, x - 2);
      }
    }
    const px = ((x - xMinDomain) / xSpan) * plotW;
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
  gamePlayersByGameId,
  getPlayerColor,
  timeframeLabel,
}: PlayerStyleTabProps) {
  const { t } = useTranslation();

  const [showMapHelp, setShowMapHelp] = useState(false);
  const [showRadarHelp, setShowRadarHelp] = useState(false);
  const [showEvolutionGraph, setShowEvolutionGraph] = useState(false);

  const analysis = useMemo(
    () =>
      computeGroupStyleProfiles(games, players, gamePlayersByGameId, getPlayerColor, {
        selectedPlayerIds: selectedPlayers,
      }),
    [games, players, gamePlayersByGameId, getPlayerColor, selectedPlayers]
  );

  const evolutionMap = useMemo(
    () =>
      computeGroupStyleEvolution(
        allGames && allGames.length > 0 ? allGames : games,
        players,
        gamePlayersByGameId,
        getPlayerColor
      ),
    [allGames, games, players, gamePlayersByGameId, getPlayerColor]
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

  const { xMinDomain, xMaxDomain, yMinDomain, yMaxDomain, xTicks, yTicks } = useMemo(() => {
    if (analysis.profiles.length === 0) {
      return {
        xMinDomain: 25,
        xMaxDomain: 75,
        yMinDomain: -50,
        yMaxDomain: 50,
        xTicks: [25, 50, 75],
        yTicks: [-50, 0, 50],
      };
    }
    const xs = analysis.profiles.map(p => Math.round(p.volatility));
    const ys = analysis.profiles.map(p => Math.round(p.avgProfit));

    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const xPad = Math.max(3, Math.round((maxX - minX) * 0.1));
    const xMin = Math.max(0, Math.floor((minX - xPad) / 5) * 5);
    const xMax = Math.min(100, Math.ceil((maxX + xPad) / 5) * 5);

    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const yPad = Math.max(6, Math.round(Math.max(16, maxY - minY) * 0.12));
    const yMin = Math.floor((minY - yPad) / 5) * 5;
    const yMax = Math.ceil((maxY + yPad) / 5) * 5;

    const buildTicks = (lo: number, hi: number, includeVal?: number): number[] => {
      const span = Math.max(10, hi - lo);
      const rawStep = span / 4;
      const step = rawStep <= 5 ? 5 : rawStep <= 10 ? 10 : rawStep <= 20 ? 20 : rawStep <= 25 ? 25 : 50;
      const set = new Set<number>([lo, hi]);
      const first = Math.ceil(lo / step) * step;
      for (let v = first; v <= hi; v += step) {
        if (v - lo >= step * 0.35 && hi - v >= step * 0.35) set.add(v);
      }
      if (includeVal !== undefined && includeVal >= lo && includeVal <= hi) {
        set.add(includeVal);
      }
      return Array.from(set).sort((a, b) => a - b);
    };

    const midX = Math.round(analysis.medianVolatility);
    return {
      xMinDomain: xMin,
      xMaxDomain: Math.max(xMin + 10, xMax),
      yMinDomain: yMin,
      yMaxDomain: Math.max(yMin + 10, yMax),
      xTicks: buildTicks(xMin, Math.max(xMin + 10, xMax), midX),
      yTicks: buildTicks(yMin, Math.max(yMin + 10, yMax), 0),
    };
  }, [analysis.profiles, analysis.medianVolatility]);

  const scatterData = useMemo(
    () => computeSmartScatterPoints(analysis.profiles, xMinDomain, xMaxDomain, yMinDomain, yMaxDomain),
    [analysis.profiles, xMinDomain, xMaxDomain, yMinDomain, yMaxDomain]
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
    const n = selectedProfile.gamesPlayed;
    const bigWinsWord =
      selectedProfile.bigWins === 0
        ? `ללא זכיות מעל ${analysis.bigSwingThreshold}₪`
        : selectedProfile.bigWins === 1
          ? `זכייה אחת מעל ${analysis.bigSwingThreshold}₪`
          : `${selectedProfile.bigWins} זכיות מעל ${analysis.bigSwingThreshold}₪`;
    const bigLossesWord =
      selectedProfile.bigLosses === 0
        ? `ללא הפסדים מעל ${analysis.bigSwingThreshold}₪`
        : selectedProfile.bigLosses === 1
          ? `רשם הפסד אחד מעל ${analysis.bigSwingThreshold}₪`
          : `רשם ${selectedProfile.bigLosses} הפסדים מעל ${analysis.bigSwingThreshold}₪`;
    const upsideReal =
      selectedProfile.winsCount > 0
        ? `רווח ממוצע ${fmtSigned(selectedProfile.avgWinSize)}₪ בניצחון · ${bigWinsWord} מתוך ${selectedProfile.winsCount} ניצחונות בתקופה`
        : `ללא ניצחונות ב-${n} משחקי התקופה`;
    return [
      {
        label: '🎯 נצחונות',
        explain: 'אחוז הערבים שהסתיימו ברווח',
        realVal: `ניצח ב-${selectedProfile.winsCount} מתוך ${n} משחקי התקופה · ${Math.round(selectedProfile.winRate)}% לעומת ${Math.round(analysis.groupAvgWinRate)}% בשולחן`,
        score: selectedProfile.radar.winRate,
        groupScore: g.winRate,
      },
      {
        label: '🛡️ יציבות ושליטה בסיכון',
        explain: 'שליטה במנעד התנודתיות והימנעות מהפסדים כבדים',
        realVal: `תנודתיות שגרתית (סטיית תקן) של ±${cleanNumber(Math.round(selectedProfile.stdDev))}₪ לערב מול ±${cleanNumber(Math.round(analysis.groupAvgStdDev))}₪ בשולחן · ${bigLossesWord}`,
        score: selectedProfile.radar.consistency,
        groupScore: g.consistency,
      },
      {
        label: '💥 גודל זכיות',
        explain: 'גובה הרווח בערבי ניצחון וזכיות גדולות',
        realVal: upsideReal,
        score: selectedProfile.radar.upside,
        groupScore: g.upside,
      },
      {
        label: '🔄 קאמבק',
        explain: hasRebuyData ? 'סיום ברווח בערבים עם ריבאיים מרובים' : 'חזרה לניצחון מיד אחרי ערב הפסד',
        realVal: selectedProfile.comebackLabel,
        score: selectedProfile.radar.comeback,
        groupScore: g.comeback,
      },
      {
        label: '🔥 אקשן וקופות',
        explain: 'קצב כניסות חוזרות ומעורבות בקופות גדולות',
        realVal: hasRebuyData
          ? `ממוצע ${selectedProfile.avgRebuys.toFixed(1)} ריבאיים מול ${analysis.groupAvgRebuys.toFixed(1)} בשולחן · שיא עד ${selectedProfile.maxRebuys} ריבאיים בערב`
          : `תנודה ממוצעת של ±${cleanNumber(Math.round(selectedProfile.avgAbsSwing))}₪ לערב · טווח בין ${fmtSigned(selectedProfile.worstLoss)}₪ ל-${fmtSigned(selectedProfile.bestWin)}₪`,
        score: selectedProfile.radar.action,
        groupScore: g.action,
      },
    ];
  }, [selectedProfile, analysis]);

  const handleShareImage = async (
    ref: React.RefObject<HTMLDivElement | null>,
    setSharing: (v: boolean) => void,
    fileName: string,
    options?: { maxSliceHeight?: number; splitOnAnchors?: boolean }
  ) => {
    if (!ref.current) return;
    setSharing(true);
    try {
      const files = await captureAndSplit(ref.current, fileName, options);
      await shareFiles(files, 'Poker Style Profile');
    } catch { /* */ } finally {
      setSharing(false);
    }
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

  const shareBtnStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.35rem',
    fontSize: '0.75rem',
    fontWeight: 600,
    padding: '0.42rem 0.95rem',
    background: 'var(--surface)',
    color: 'var(--text-muted)',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    cursor: 'pointer',
  };

  return (
    <>
      {/* 1. Group 4-Quadrant Style Map */}
      <div ref={mapCardRef} className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.2rem' }}>
          <h2 className="card-title" style={{ margin: 0 }}>{t('graphs.styleMapTitle')}</h2>
          <button
            type="button"
            onClick={() => setShowMapHelp(v => !v)}
            style={{
              fontSize: '0.65rem',
              padding: '0.16rem 0.48rem',
              borderRadius: '999px',
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            {showMapHelp ? 'הסתר הסבר ▲' : 'איך קוראים? ▼'}
          </button>
        </div>

        <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginBottom: '0.45rem' }}>
          <strong style={{ color: 'var(--text)' }}>{timeframeLabel}</strong> · {games.length} משחקים · {analysis.profiles.length} שחקנים
        </div>

        {showMapHelp && (
          <div
            dir="rtl"
            style={{
              padding: '0.45rem 0.55rem',
              marginBottom: '0.5rem',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: '8px',
              fontSize: '0.64rem',
              lineHeight: 1.45,
              textAlign: 'right',
            }}
          >
            <div style={{ color: 'var(--text-muted)', marginBottom: '0.22rem' }}>
              <strong style={{ color: 'var(--text)' }}>ציר X (מדד סיכון, אקשן וקופות 0–100):</strong> משלב הון בסיכון וריבאיים יחסיים בשולחן, תנודתיות רווח וערמות סיום, גודל זכיות, סיום בקצוות השולחן ומסנן פסיביות (0–32 שמרן ושקט · 33–49 מחושב/סלקטיבי · 50–68 אגרסיבי · 69+ אקשן קיצוני)
            </div>
            <div style={{ color: 'var(--text-muted)', marginBottom: '0.22rem' }}>
              <strong style={{ color: 'var(--text)' }}>ציר Y (ממוצע ב-₪):</strong> רווח או הפסד ממוצע למשחק בתקופה
            </div>
            <div style={{ color: 'var(--text-muted)', marginBottom: '0.35rem' }}>
              <strong style={{ color: 'var(--text)' }}>הקווים המקווקווים:</strong> אופקי (0₪) = גבול רווח/הפסד · אנכי (50) = ממוצע האקשן והסיכון של השולחן
            </div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: '0.25rem',
              fontSize: '0.6rem',
              direction: 'ltr',
            }}>
              <div dir="rtl" style={{ padding: '0.22rem 0.35rem', borderRadius: '6px', background: 'rgba(16, 185, 129, 0.08)', border: '1px solid rgba(16, 185, 129, 0.25)', textAlign: 'right' }}>
                <strong style={{ color: '#34d399' }}>🎯 שמאל-למעלה:</strong> מרוויח ומחושב (סלקטיבי / TAG)
              </div>
              <div dir="rtl" style={{ padding: '0.22rem 0.35rem', borderRadius: '6px', background: 'rgba(16, 185, 129, 0.08)', border: '1px solid rgba(16, 185, 129, 0.25)', textAlign: 'right' }}>
                <strong style={{ color: '#10B981' }}>🦈 ימין-למעלה:</strong> מרוויח ואגרסיבי / אקשן
              </div>
              <div dir="rtl" style={{ padding: '0.22rem 0.35rem', borderRadius: '6px', background: 'rgba(148, 163, 184, 0.08)', border: '1px solid var(--border)', textAlign: 'right' }}>
                <strong style={{ color: 'var(--text)' }}>🛡️ שמאל-למטה:</strong> מופסד (שמרן / משוחרר-פסיבי)
              </div>
              <div dir="rtl" style={{ padding: '0.22rem 0.35rem', borderRadius: '6px', background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.25)', textAlign: 'right' }}>
                <strong style={{ color: '#F59E0B' }}>🎢 ימין-למטה:</strong> מופסד ומשוחרר-אגרסיבי
              </div>
            </div>
          </div>
        )}

        <div style={{ position: 'relative', width: '100%', height: '265px', direction: 'ltr' }}>
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart key={chartKey} margin={{ top: 20, right: 24, bottom: 16, left: 2 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.4} />
              <XAxis
                type="number"
                dataKey="x"
                domain={[xMinDomain, xMaxDomain]}
                ticks={xTicks}
                allowDataOverflow
                stroke="var(--text-muted)"
                fontSize={10}
                tickLine={false}
                tickFormatter={(v) => cleanNumber(v)}
              />
              <YAxis
                type="number"
                dataKey="y"
                domain={[yMinDomain, yMaxDomain]}
                ticks={yTicks}
                allowDataOverflow
                stroke="var(--text-muted)"
                fontSize={10}
                width={38}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => cleanNumber(v)}
              />
              {yMinDomain <= 0 && yMaxDomain >= 0 && (
                <ReferenceLine y={0} stroke="var(--text-muted)" strokeDasharray="4 4" opacity={0.75} />
              )}
              {xMinDomain <= Math.round(analysis.medianVolatility) && xMaxDomain >= Math.round(analysis.medianVolatility) && (
                <ReferenceLine x={Math.round(analysis.medianVolatility)} stroke="var(--text-muted)" strokeDasharray="4 4" opacity={0.75} />
              )}
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

        {/* Clean 1-line mobile-safe axis bar */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '0.25rem',
          fontSize: '0.58rem',
          color: 'var(--text-muted)',
          padding: '0.22rem 0.45rem',
          marginTop: '0.2rem',
          background: 'var(--surface)',
          borderRadius: '6px',
          border: '1px solid var(--border)',
          direction: 'ltr',
        }}>
          <span>← שמרן / מחושב</span>
          <span style={{ fontWeight: '600', color: 'var(--text)' }}>ציר X: סיכון ואקשן · ציר Y: ממוצע ₪</span>
          <span>אגרסיבי / אקשן →</span>
        </div>

        {/* Tappable Player Pills */}
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '0.35rem', marginTop: '0.55rem' }}>
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

      {/* Single Identical Image Share Button below Map Card */}
      <div style={{ display: 'flex', justifyContent: 'center', marginTop: '-0.35rem', marginBottom: '0.65rem' }}>
        <button
          type="button"
          onClick={() => handleShareImage(mapCardRef, setIsSharingMap, 'poker-style-map')}
          disabled={isSharingMap}
          style={shareBtnStyle}
        >
          {isSharingMap ? t('common.capturing') : t('common.share')}
        </button>
      </div>

      {/* 2. Personal Player Spider & Analysis Card */}
      {selectedProfile && (
        <>
          <div ref={playerCardRef} className="card">
            {/* Header: Archetype + Style Badge + Period Total Profit */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem', marginBottom: '0.45rem' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.45rem', minWidth: 0 }}>
                <span style={{ fontSize: '1.45rem', lineHeight: 1.1, flexShrink: 0 }}>{selectedProfile.archetype.emoji}</span>
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
                  <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', marginTop: '0.12rem' }}>
                    <strong style={{ color: 'var(--text)' }}>{timeframeLabel}</strong> · {selectedProfile.gamesPlayed} משחקים בתקופה
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
                  מקום {selectedProfile.profitRank}/{selectedProfile.totalPlayersInGroup}
                </div>
              </div>
            </div>

            {/* Natural Summary Sentence */}
            <div style={{
              fontSize: '0.73rem',
              color: 'var(--text)',
              lineHeight: 1.45,
              padding: '0.42rem 0.58rem',
              marginBottom: '0.5rem',
              background: 'var(--surface)',
              borderRadius: '8px',
              borderRight: `3px solid ${selectedProfile.color}`,
            }}>
              {selectedProfile.archetype.description}
            </div>

            {/* 4-Metric Statistical Strip */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
              gap: '0.32rem',
              marginBottom: '0.5rem',
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
                <div style={{ fontSize: '0.56rem', color: 'var(--text-muted)', lineHeight: 1.15 }}>ניצחון / הפסד</div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.18rem', direction: 'rtl', lineHeight: 1.2 }}>
                  <span style={{ fontSize: '0.7rem', fontWeight: '700', color: '#10B981', direction: 'ltr', unicodeBidi: 'isolate' }}>
                    {selectedProfile.winsCount > 0 ? `+${cleanNumber(Math.round(selectedProfile.avgWinSize))}` : '0'}
                  </span>
                  <span style={{ fontSize: '0.58rem', color: 'var(--text-muted)' }}>/</span>
                  <span style={{ fontSize: '0.7rem', fontWeight: '700', color: '#EF4444', direction: 'ltr', unicodeBidi: 'isolate' }}>
                    {selectedProfile.lossesCount > 0 ? `-${cleanNumber(Math.round(Math.abs(selectedProfile.avgLossSize)))}` : '0'}
                  </span>
                </div>
                <div style={{ fontSize: '0.5rem', color: 'var(--text-muted)', lineHeight: 1.1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.15rem' }}>
                  <span>תנודתיות:</span>
                  <span style={{ direction: 'ltr', unicodeBidi: 'isolate' }}>±{cleanNumber(Math.round(selectedProfile.stdDev))}₪</span>
                </div>
              </div>

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
                <div style={{ fontSize: '0.56rem', color: 'var(--text-muted)', lineHeight: 1.15 }}>ריבאי למשחק</div>
                <div style={{ fontSize: '0.76rem', fontWeight: '700', color: 'var(--text)', direction: 'ltr', unicodeBidi: 'isolate', lineHeight: 1.2 }}>
                  {selectedProfile.trackedRebuyGames > 0 ? selectedProfile.avgRebuys.toFixed(1) : '—'}
                </div>
                <div style={{ fontSize: '0.52rem', color: 'var(--text-muted)', lineHeight: 1.1 }}>
                  {selectedProfile.trackedRebuyGames > 0 ? `שולחן: ${analysis.groupAvgRebuys.toFixed(1)}` : 'ללא מעקב'}
                </div>
              </div>
            </div>

            {/* Historical Style Evolution across Half-Years (Compact Strip + Toggleable Trend Chart) */}
            {(() => {
              const evo = evolutionMap.get(selectedProfile.playerId);
              if (!evo || evo.points.length < 2) return null;
              const stripPts = evo.points.slice(-4);
              return (
                <div
                  dir="rtl"
                  style={{
                    padding: '0.45rem 0.55rem',
                    marginBottom: '0.5rem',
                    background: 'var(--surface)',
                    borderRadius: '8px',
                    border: '1px solid var(--border)',
                    textAlign: 'right',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.35rem', marginBottom: '0.32rem' }}>
                    <span style={{ fontSize: '0.67rem', fontWeight: '700', color: 'var(--text)' }}>
                      📈 התפתחות אופי לאורך חציונים — {selectedProfile.playerName}
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowEvolutionGraph(v => !v)}
                      style={{
                        fontSize: '0.6rem',
                        padding: '0.12rem 0.42rem',
                        borderRadius: '999px',
                        border: '1px solid var(--border)',
                        background: 'rgba(255,255,255,0.03)',
                        color: 'var(--text-muted)',
                        cursor: 'pointer',
                        flexShrink: 0,
                      }}
                    >
                      {showEvolutionGraph ? 'הסתר גרף ▲' : 'גרף מגמה ▼'}
                    </button>
                  </div>

                  {/* Compact Horizontal Half-Year Strip (up to 4 most recent half-years) */}
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: `repeat(${stripPts.length}, minmax(0, 1fr))`,
                      gap: '0.28rem',
                      marginBottom: '0.32rem',
                    }}
                  >
                    {stripPts.map((pt, idx) => {
                      const isLast = idx === stripPts.length - 1;
                      const styleColor =
                        pt.shortStyle === 'משוחרר-פסיבי'
                          ? '#F59E0B'
                          : pt.volatility >= 50
                            ? '#38BDF8'
                            : '#34D399';
                      return (
                        <div
                          key={pt.periodKey}
                          style={{
                            padding: '0.26rem 0.25rem',
                            borderRadius: '6px',
                            background: isLast ? `${selectedProfile.color}16` : 'rgba(255,255,255,0.02)',
                            border: isLast ? `1px solid ${selectedProfile.color}66` : '1px solid var(--border)',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            gap: '0.1rem',
                            textAlign: 'center',
                          }}
                        >
                          <span style={{ fontSize: '0.55rem', fontWeight: '700', color: isLast ? selectedProfile.color : 'var(--text-muted)' }}>
                            {pt.periodLabel} ({pt.gamesPlayed})
                          </span>
                          <span style={{ fontSize: '0.57rem', fontWeight: '700', color: styleColor, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>
                            {pt.shortStyle}
                          </span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.22rem', fontSize: '0.54rem', color: 'var(--text-muted)' }}>
                            <span>X:{pt.volatility}</span>
                            <span>·</span>
                            <span style={{ color: pt.avgProfit >= 0 ? '#10B981' : '#EF4444', fontWeight: '700', direction: 'ltr', unicodeBidi: 'isolate' }}>
                              {fmtSigned(pt.avgProfit)}₪
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* 1-Line Data-Driven Evolution Summary */}
                  <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', lineHeight: 1.38 }}>
                    {evo.summary}
                  </div>

                  {/* Optional Collapsible Dual-Metric Trend Chart across all half-years */}
                  {showEvolutionGraph && (
                    <div style={{ marginTop: '0.4rem', paddingTop: '0.35rem', borderTop: '1px solid var(--border)' }}>
                      <div style={{ width: '100%', height: '145px', direction: 'ltr' }}>
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={evo.points} margin={{ top: 8, right: 14, bottom: 4, left: -16 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.35} />
                            <XAxis dataKey="periodLabel" tick={{ fill: 'var(--text-muted)', fontSize: 10 }} stroke="var(--border)" />
                            <YAxis domain={[0, 100]} ticks={[25, 50, 75]} tick={{ fill: 'var(--text-muted)', fontSize: 9 }} stroke="var(--border)" />
                            <ReferenceLine y={50} stroke="var(--text-muted)" strokeDasharray="4 4" strokeOpacity={0.5} />
                            <Tooltip
                              contentStyle={{
                                background: '#0f172a',
                                border: '1px solid var(--border)',
                                borderRadius: '8px',
                                fontSize: '0.65rem',
                                direction: 'rtl',
                                textAlign: 'right',
                              }}
                              formatter={(val?: number | string) => [
                                `${val ?? 0} / 100`,
                                'מדד סיכון ואקשן (X)',
                              ]}
                            />
                            <Line
                              type="monotone"
                              dataKey="volatility"
                              stroke={selectedProfile.color}
                              strokeWidth={2.5}
                              dot={{ r: 4, fill: selectedProfile.color }}
                              isAnimationActive={false}
                            />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                      <div style={{ fontSize: '0.55rem', color: 'var(--text-muted)', textAlign: 'center', marginTop: '0.1rem' }}>
                        קו מקווקו (50) = גבול מחושב ↔ אגרסיבי · נקודות = ציון ציר X בכל חציון
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Spider / Radar Header + Collapsible Explanation Toggle (matching Style Map) */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.35rem', marginBottom: '0.25rem' }}>
              <span style={{ fontSize: '0.72rem', fontWeight: '700', color: 'var(--text)', minWidth: 0 }}>
                🕸️ 5 ממדי המשחק — {selectedProfile.playerName}
              </span>
              <button
                type="button"
                onClick={() => setShowRadarHelp(v => !v)}
                style={{
                  fontSize: '0.65rem',
                  padding: '0.16rem 0.48rem',
                  borderRadius: '999px',
                  border: '1px solid var(--border)',
                  background: 'var(--surface)',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  flexShrink: 0,
                }}
              >
                {showRadarHelp ? 'הסתר הסבר ▲' : 'איך קוראים? ▼'}
              </button>
            </div>

            {/* Closed-by-default Explanation Window for Spider Chart */}
            {showRadarHelp && (
              <div
                dir="rtl"
                style={{
                  padding: '0.45rem 0.55rem',
                  marginBottom: '0.5rem',
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: '8px',
                  fontSize: '0.63rem',
                  lineHeight: 1.45,
                  textAlign: 'right',
                }}
              >
                <div style={{ color: 'var(--text-muted)', marginBottom: '0.2rem' }}>
                  <strong style={{ color: 'var(--text)' }}>ציון 0–100 בכל קודקוד:</strong> מחושב מ-{selectedProfile.gamesPlayed} משחקי השחקן בתקופה (שטח רחב = חזק יותר)
                </div>
                <div style={{ color: 'var(--text-muted)', marginBottom: '0.2rem' }}>
                  <strong style={{ color: 'var(--text)' }}>הקו המקווקו:</strong> ממוצע השולחן בתקופה (בולט מעבר לקו = מעל הממוצע)
                </div>
                <div style={{ color: 'var(--text-muted)', marginBottom: '0.28rem' }}>
                  <strong style={{ color: 'var(--text)' }}>מדד תנודתיות (±₪):</strong> מנעד התנודה הטיפוסי בערב רגיל (נמוך = סלע יציב, גבוה = ערבים סוערים לשני הכיוונים)
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.18rem', borderTop: '1px solid var(--border)', paddingTop: '0.3rem' }}>
                  {radarBreakdownRows.map((row, idx) => (
                    <div key={idx} style={{ color: 'var(--text-muted)', fontSize: '0.6rem' }}>
                      <strong style={{ color: 'var(--text)' }}>{row.label}:</strong> {row.explain}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div style={{ width: '100%', height: '225px', direction: 'ltr' }}>
              <ResponsiveContainer width="100%" height="100%">
                <RadarChart
                  key={`${chartKey}-${selectedProfile.playerId}`}
                  cx="50%"
                  cy="50%"
                  outerRadius="58%"
                  margin={{ top: 10, right: 32, bottom: 10, left: 32 }}
                  data={radarData}
                >
                  <PolarGrid stroke="var(--border)" />
                  <PolarAngleAxis
                    dataKey="axis"
                    tick={{ fill: 'var(--text)', fontSize: 10, fontWeight: 600 }}
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
            <div style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: '1rem', fontSize: '0.65rem', marginTop: '-0.25rem', marginBottom: '0.5rem' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', color: selectedProfile.color, fontWeight: '600' }}>
                <span style={{ width: '10px', height: '3px', background: selectedProfile.color, borderRadius: '2px' }} />
                {selectedProfile.playerName}
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', color: 'var(--text-muted)' }}>
                <span style={{ width: '10px', height: '0px', borderTop: '2px dashed var(--text-muted)' }} />
                {t('graphs.groupAverage')}
              </span>
            </div>

            {/* 5-Axis Period Score & Data Breakdown (Clean RTL alignment, period game counts) */}
            <div
              data-share-split="true"
              dir="rtl"
              style={{
                padding: '0.45rem 0.55rem',
                marginBottom: '0.5rem',
                background: 'var(--surface)',
                borderRadius: '8px',
                border: '1px solid var(--border)',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.28rem',
                textAlign: 'right',
              }}
            >
              {/* Context header for Part 2 when split during screenshot share */}
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                paddingBottom: '0.3rem',
                marginBottom: '0.25rem',
                borderBottom: '1px solid var(--border)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                  <span style={{ fontSize: '0.95rem' }}>{selectedProfile.archetype.emoji}</span>
                  <span style={{ fontSize: '0.78rem', fontWeight: '700', color: selectedProfile.color }}>
                    {selectedProfile.playerName} · פירוט ממדי המשחק
                  </span>
                </div>
                <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                  {timeframeLabel}
                </span>
              </div>
              {radarBreakdownRows.map((row, i) => (
                <div
                  key={i}
                  dir="rtl"
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '0.5rem',
                    padding: '0.26rem 0.38rem',
                    borderRadius: '6px',
                    background: 'rgba(255,255,255,0.02)',
                    textAlign: 'right',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.06rem', minWidth: 0, flex: 1, textAlign: 'right' }}>
                    <span style={{ fontWeight: '700', color: 'var(--text)', fontSize: '0.65rem' }}>
                      {row.label}
                    </span>
                    <span style={{ fontSize: '0.61rem', color: 'var(--text-muted)', lineHeight: 1.35 }}>
                      {row.realVal}
                    </span>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      gap: '0.1rem',
                      flexShrink: 0,
                      minWidth: '52px',
                    }}
                  >
                    <span
                      style={{
                        fontWeight: '700',
                        fontSize: '0.62rem',
                        padding: '0.08rem 0.38rem',
                        borderRadius: '5px',
                        background: row.score >= row.groupScore ? 'rgba(16, 185, 129, 0.15)' : 'rgba(148, 163, 184, 0.12)',
                        color: row.score >= row.groupScore ? '#34d399' : 'var(--text-muted)',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      ציון {row.score}
                    </span>
                    <span
                      style={{
                        fontSize: '0.53rem',
                        color: 'var(--text-muted)',
                        whiteSpace: 'nowrap',
                        lineHeight: 1.1,
                      }}
                    >
                      קבוצה: {row.groupScore}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {/* 3 Natural, Pleasant-to-Read Period Insights */}
            <div
              data-share-split="true"
              dir="rtl"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.36rem',
                padding: '0.55rem 0.62rem',
                background: 'var(--surface)',
                borderRadius: '8px',
                border: '1px solid var(--border)',
                textAlign: 'right',
              }}
            >
              {/* Context header for Part 3 when split during screenshot share */}
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                paddingBottom: '0.3rem',
                marginBottom: '0.25rem',
                borderBottom: '1px solid var(--border)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                  <span style={{ fontSize: '0.95rem' }}>{selectedProfile.archetype.emoji}</span>
                  <span style={{ fontSize: '0.78rem', fontWeight: '700', color: selectedProfile.color }}>
                    {selectedProfile.playerName} · תובנות ודפוסי משחק
                  </span>
                </div>
                <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                  {timeframeLabel}
                </span>
              </div>
              {selectedProfile.traits.map((trait, idx) => {
                const colonIdx = trait.indexOf(':');
                const hasLead = colonIdx > 0 && colonIdx <= 38;
                return (
                  <div key={idx} style={{ fontSize: '0.71rem', color: 'var(--text)', display: 'flex', gap: '0.38rem', alignItems: 'baseline', lineHeight: 1.45 }}>
                    <span style={{ color: selectedProfile.color, fontWeight: '700', flexShrink: 0 }}>•</span>
                    <span>
                      {hasLead ? (
                        <>
                          <strong style={{ color: '#f8fafc', fontWeight: 700 }}>{trait.slice(0, colonIdx + 1)}</strong>
                          {trait.slice(colonIdx + 1)}
                        </>
                      ) : (
                        trait
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Single Identical Image Share Button below Spider Card */}
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: '-0.35rem', marginBottom: '0.6rem' }}>
            <button
              type="button"
              onClick={() => handleShareImage(
                playerCardRef,
                setIsSharingPlayer,
                `poker-style-${selectedProfile.playerName}`,
                { splitOnAnchors: true, maxSliceHeight: 520 }
              )}
              disabled={isSharingPlayer}
              style={shareBtnStyle}
            >
              {isSharingPlayer ? t('common.capturing') : t('common.share')}
            </button>
          </div>
        </>
      )}
    </>
  );
}
