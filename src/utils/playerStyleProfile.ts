import { Game, GamePlayer, Player } from '../types';
import { cleanNumber } from './calculations';

export interface PlayerStyleMetrics {
  playerId: string;
  playerName: string;
  playerType: 'permanent' | 'permanent_guest' | 'guest';
  color: string;
  profitRank: number; // 1 = highest totalProfit in selected period
  rebuyRank: number; // 1 = lowest avgRebuys in selected period (most controlled)
  totalPlayersInGroup: number;
  gamesPlayed: number;
  totalProfit: number;
  avgProfit: number;
  winRate: number; // 0..100 in selected period
  stdDev: number; // population standard deviation of nightly profits (σ) in selected period
  upStd: number; // Upside semideviation across all nights in period: sqrt(sum(max(0, v)^2) / n)
  downsideDev: number; // Downside semideviation across all nights in period: sqrt(sum(min(0, v)^2) / n)
  volatility: number; // composite Risk / Action / Aggression index (0..100) for X-axis (<50 = Solid, >=50 = Aggressive)
  avgRebuys: number; // extra rebuys per tracked game in period (0 = initial buy-in only, ~2 = median, 4+ = heavy)
  stdRebuys: number;
  maxRebuys: number;
  trackedRebuyGames: number;
  avgAbsSwing: number;
  avgWinSize: number;
  avgLossSize: number;
  payoffRatio: number; // avgWinSize / |avgLossSize|
  bigWins: number; // nights >= bigWinThreshold (~150₪)
  bigLosses: number; // nights <= -bigLossThreshold (~-150₪)
  smallWins: number;
  smallLosses: number;
  worstLoss: number; // worst single night profit in period
  bestWin: number; // best single night profit in period
  rebuyComebackRate: number | null; // % of heavy-rebuy nights finished in profit
  comebackLabel: string; // Human-readable breakdown of comeback / rebuy discipline for the spider table
  highRebuyGames: number; // games with >= 4 extra rebuys
  lowRebuyGames: number; // games with <= 2 extra rebuys
  lowRebuyAvg: number | null;
  highRebuyAvg: number | null;
  firstHalfAvg: number;
  secondHalfAvg: number;
  radar: {
    winRate: number;
    consistency: number;
    upside: number;
    comeback: number;
    action: number;
  };
  archetype: {
    emoji: string;
    title: string;
    styleBadge: string; // e.g. 'סולידי ומחושב (מוכח בנתונים)' | 'אגרסיבי ותנודתי מאוד'
    description: string; // Unique personalized multi-metric summary sentence for the selected period
  };
  traits: string[]; // 4 distinct, deeply personalized statistical proof bullets for the selected period
}

export interface GroupStyleAnalysis {
  profiles: PlayerStyleMetrics[];
  medianVolatility: number;
  bigSwingThreshold: number;
  heavyRebuyThreshold: number;
  groupAvgRebuys: number;
  groupAvgStdDev: number;
  groupAvgWinRate: number;
  groupAvgWinSize: number;
  groupAvgLossSize: number;
  groupAvgRadar: {
    winRate: number;
    consistency: number;
    upside: number;
    comeback: number;
    action: number;
  };
}

export interface StyleProfileOptions {
  selectedPlayerIds?: Set<string>;
  includePermanentGuests?: boolean;
  includeOccasionalGuests?: boolean;
}

const fmtSigned = (n: number): string => {
  const r = Math.round(n);
  if (r === 0) return '0';
  return `\u200E${r > 0 ? '+' : '-'}${cleanNumber(Math.abs(r))}`;
};

const fmtCount = (n: number, singular: string, plural: string): string => {
  if (n === 1) return `${singular} אחד`;
  return `${n} ${plural}`;
};

const fmtFemCount = (n: number, singular: string, plural: string): string => {
  if (n === 1) return `${singular} אחת`;
  return `${n} ${plural}`;
};

function meanOf(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function stdDevOf(values: number[]): number {
  if (values.length <= 1) return 0;
  const m = meanOf(values);
  const variance = values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function percentileOf(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

function zScore(val: number, mean: number, std: number): number {
  if (std <= 1e-9) return 0;
  return (val - mean) / std;
}

/**
 * Smoothly maps a z-score into a [minOut..maxOut] display score (centered at 50 for z=0).
 */
function zToScore(z: number, minOut = 14, maxOut = 94): number {
  const clamped = Math.max(-2.2, Math.min(2.2, z));
  const norm = (clamped + 2.2) / 4.4; // 0..1
  return Math.round(minOut + norm * (maxOut - minOut));
}

function buildTrackingMap(
  games: Game[],
  gamePlayersByGameId: Map<string, Map<string, GamePlayer>>
): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (const g of games) {
    const byPlayer = gamePlayersByGameId.get(g.id);
    if (!byPlayer) {
      map.set(g.id, false);
      continue;
    }
    let hasRebuys = false;
    byPlayer.forEach(gp => {
      if ((gp.rebuys || 1) > 1) hasRebuys = true;
    });
    map.set(g.id, hasRebuys);
  }
  return map;
}

interface NightRecord {
  profit: number;
  extraRebuys: number | null;
}

function collectPlayerNights(
  playerId: string,
  games: Game[],
  gamePlayersByGameId: Map<string, Map<string, GamePlayer>>,
  trackingMap: Map<string, boolean>
): NightRecord[] {
  const nights: NightRecord[] = [];
  for (const g of games) {
    const gp = gamePlayersByGameId.get(g.id)?.get(playerId);
    if (!gp) continue;
    const tracked = trackingMap.get(g.id) ?? false;
    const extraRebuys = tracked ? Math.max(0, (gp.rebuys || 1) - 1) : null;
    nights.push({ profit: gp.profit, extraRebuys });
  }
  return nights;
}

/**
 * Multi-factor statistical engine for player style & character profiling.
 *
 * Strictly scoped to the selected timeframe (`games`):
 * - Current timeframe metrics (totalProfit, avgProfit, winRate, stdDev, symmetric upStd vs downsideDev, payoffRatio)
 * - Big Wins (>=150₪) & Big Losses (<=-150₪) vs small wins/losses in the selected period
 * - Extra Rebuys (`gp.rebuys - 1` on tracked games in the selected period: 0–2 = controlled, 4+ = heavy)
 * - Within-period trajectory (first half vs second half of the selected period)
 * - Strict Credibility Alignment: Solid/Controlled players always sit left of X=50; Aggressive/Volatile/Rollercoaster players always sit right of X=50.
 */
export function computeGroupStyleProfiles(
  games: Game[],
  players: Player[],
  gamePlayersByGameId: Map<string, Map<string, GamePlayer>>,
  getPlayerColor: (id: string) => string,
  _allGames?: Game[],
  options?: StyleProfileOptions
): GroupStyleAnalysis {
  const selectedIds = options?.selectedPlayerIds;
  const includePermGuests = options?.includePermanentGuests ?? false;
  const includeOccGuests = options?.includeOccasionalGuests ?? false;

  const permMinGames = games.length >= 10 ? 4 : games.length >= 6 ? 3 : games.length >= 2 ? 2 : 1;
  const guestMinGames = games.length >= 10 ? 2 : 1;

  const periodTrackingMap = buildTrackingMap(games, gamePlayersByGameId);

  const allPositiveProfits: number[] = [];
  const allNegativeProfitsAbs: number[] = [];
  const allTrackedExtraRebuys: number[] = [];

  const eligiblePlayers: Array<{
    player: Player;
    nights: NightRecord[];
  }> = [];

  for (const p of players) {
    const pType = (p.type || 'permanent') as 'permanent' | 'permanent_guest' | 'guest';

    let minReq = permMinGames;
    if (selectedIds) {
      if (!selectedIds.has(p.id)) continue;
      // When a user explicitly selects a guest (or filters down to specific players), include them if they played >= 1 game in the period
      minReq = pType === 'permanent' && selectedIds.size >= 5 ? permMinGames : 1;
    } else {
      if (pType === 'permanent_guest' && !includePermGuests) continue;
      if (pType === 'guest' && !includeOccGuests) continue;
      minReq = pType === 'permanent' ? permMinGames : guestMinGames;
    }

    const nights = collectPlayerNights(p.id, games, gamePlayersByGameId, periodTrackingMap);
    if (nights.length < minReq) continue;

    eligiblePlayers.push({ player: p, nights });

    for (const r of nights) {
      if (r.profit > 0) allPositiveProfits.push(r.profit);
      if (r.profit < 0) allNegativeProfitsAbs.push(Math.abs(r.profit));
      if (r.extraRebuys !== null) allTrackedExtraRebuys.push(r.extraRebuys);
    }
  }

  // Fallback: if selectedIds filtered out everyone due to permMinGames in a sparse selection, relax to >= 1 game
  if (eligiblePlayers.length === 0 && selectedIds && selectedIds.size > 0) {
    for (const p of players) {
      if (!selectedIds.has(p.id)) continue;
      const nights = collectPlayerNights(p.id, games, gamePlayersByGameId, periodTrackingMap);
      if (nights.length < 1) continue;
      eligiblePlayers.push({ player: p, nights });
      for (const r of nights) {
        if (r.profit > 0) allPositiveProfits.push(r.profit);
        if (r.profit < 0) allNegativeProfitsAbs.push(Math.abs(r.profit));
        if (r.extraRebuys !== null) allTrackedExtraRebuys.push(r.extraRebuys);
      }
    }
  }

  if (eligiblePlayers.length === 0) {
    return {
      profiles: [],
      medianVolatility: 50,
      bigSwingThreshold: 150,
      heavyRebuyThreshold: 4,
      groupAvgRebuys: 0,
      groupAvgStdDev: 0,
      groupAvgWinRate: 0,
      groupAvgWinSize: 0,
      groupAvgLossSize: 0,
      groupAvgRadar: { winRate: 50, consistency: 50, upside: 50, comeback: 50, action: 50 },
    };
  }

  // Group-calibrated thresholds for the selected period (with domain-realistic floors)
  const rawBigSwing = Math.max(
    percentileOf(allPositiveProfits, 0.7),
    percentileOf(allNegativeProfitsAbs, 0.7)
  );
  const bigSwingThreshold = Math.max(130, Math.min(180, Math.round((rawBigSwing || 150) / 10) * 10));

  // Extra rebuys: 0–2 is normal/controlled; 4+ extra rebuys (5+ total entries = 150₪+) is heavy
  const controlledRebuyMax = 2;
  const heavyRebuyThreshold = 4;
  const rebuysTracked = allTrackedExtraRebuys.length > 0;

  const baseStats = eligiblePlayers.map(({ player, nights }) => {
    const n = nights.length;
    const profits = nights.map(x => x.profit);
    const totalProfit = profits.reduce((s, v) => s + v, 0);
    const avgProfit = totalProfit / n;
    const stdDev = stdDevOf(profits);

    const wins = profits.filter(v => v > 0);
    const losses = profits.filter(v => v < 0);
    const winRate = (wins.length / n) * 100;

    // Symmetric Upside vs Downside Semideviation across all `n` games in the selected period
    const upSqSum = profits.reduce((s, v) => s + (v > 0 ? v * v : 0), 0);
    const upStd = Math.sqrt(upSqSum / n);
    const downSqSum = profits.reduce((s, v) => s + (v < 0 ? v * v : 0), 0);
    const downsideDev = Math.sqrt(downSqSum / n);

    const avgAbsSwing = profits.reduce((s, v) => s + Math.abs(v), 0) / n;
    const avgWinSize = wins.length > 0 ? meanOf(wins) : 0;
    const avgLossSize = losses.length > 0 ? meanOf(losses) : 0;
    const payoffRatio =
      avgLossSize < 0
        ? avgWinSize / Math.abs(avgLossSize)
        : avgWinSize > 0
          ? 2.0
          : 0.0;

    const bigWins = profits.filter(v => v >= bigSwingThreshold).length;
    const bigLosses = profits.filter(v => v <= -bigSwingThreshold).length;
    const smallWins = wins.length - bigWins;
    const smallLosses = losses.length - bigLosses;
    const bigWinRate = bigWins / n;
    const bigLossRate = bigLosses / n;
    const bestWin = Math.max(...profits);
    const worstLoss = Math.min(...profits);

    const mid = Math.floor(n / 2);
    const firstHalfNights = mid > 0 ? nights.slice(0, mid) : nights;
    const secondHalfNights = mid > 0 ? nights.slice(mid) : nights;
    const firstHalfAvg = meanOf(firstHalfNights.map(x => x.profit));
    const secondHalfAvg = meanOf(secondHalfNights.map(x => x.profit));

    const firstHalfTracked = firstHalfNights.filter((x): x is { profit: number; extraRebuys: number } => x.extraRebuys !== null);
    const secondHalfTracked = secondHalfNights.filter((x): x is { profit: number; extraRebuys: number } => x.extraRebuys !== null);
    const firstHalfRebuys = firstHalfTracked.length > 0 ? meanOf(firstHalfTracked.map(x => x.extraRebuys)) : null;
    const secondHalfRebuys = secondHalfTracked.length > 0 ? meanOf(secondHalfTracked.map(x => x.extraRebuys)) : null;

    const trackedNights = nights.filter((x): x is { profit: number; extraRebuys: number } => x.extraRebuys !== null);
    const trackedRebuyGames = trackedNights.length;
    const extraRebuyVals = trackedNights.map(x => x.extraRebuys);
    const avgRebuys = trackedRebuyGames > 0 ? meanOf(extraRebuyVals) : 0;
    const stdRebuys = trackedRebuyGames > 1 ? stdDevOf(extraRebuyVals) : 0;
    const maxRebuys = trackedRebuyGames > 0 ? cleanNumber(Math.max(...extraRebuyVals)) : 0;

    const lowRebuyNights = trackedNights.filter(x => x.extraRebuys <= controlledRebuyMax);
    const highRebuyNights = trackedNights.filter(x => x.extraRebuys >= heavyRebuyThreshold);
    const mediumPlusRebuyNights = trackedNights.filter(x => x.extraRebuys >= 3);
    const twoPlusRebuyNights = trackedNights.filter(x => x.extraRebuys >= 2);

    const lowRebuyAvg = lowRebuyNights.length > 0 ? meanOf(lowRebuyNights.map(x => x.profit)) : null;
    const highRebuyAvg = highRebuyNights.length > 0 ? meanOf(highRebuyNights.map(x => x.profit)) : null;
    const highRebuyShare = trackedRebuyGames > 0 ? highRebuyNights.length / trackedRebuyGames : 0;
    const medPlusRebuyShare = trackedRebuyGames > 0 ? mediumPlusRebuyNights.length / trackedRebuyGames : 0;

    // Comeback rate in 4+ rebuy nights within the selected period
    const highRebuyWins = highRebuyNights.filter(x => x.profit > 0).length;
    const medPlusWins = mediumPlusRebuyNights.filter(x => x.profit > 0).length;
    const twoPlusWins = twoPlusRebuyNights.filter(x => x.profit > 0).length;

    const rebuyComebackRate =
      highRebuyNights.length >= 2
        ? (highRebuyWins / highRebuyNights.length) * 100
        : null;

    let comebackLabel = '';
    if (!rebuysTracked || trackedRebuyGames === 0) {
      comebackLabel = `${wins.length}/${n} ערבים חיוביים`;
    } else if (highRebuyNights.length >= 2 && (highRebuyShare >= 0.15 || avgRebuys >= 2.2)) {
      const pct = Math.round((highRebuyWins / highRebuyNights.length) * 100);
      comebackLabel = `${highRebuyWins}/${highRebuyNights.length} בפלוס ב-4+ ריבאיים (${pct}%)`;
    } else if (twoPlusRebuyNights.length >= 2) {
      const pct = Math.round((twoPlusWins / twoPlusRebuyNights.length) * 100);
      comebackLabel = `${twoPlusWins}/${twoPlusRebuyNights.length} בפלוס ב-2+ ריבאיים (${pct}%)`;
    } else if (mediumPlusRebuyNights.length >= 2) {
      const pct = Math.round((medPlusWins / mediumPlusRebuyNights.length) * 100);
      comebackLabel = `${medPlusWins}/${mediumPlusRebuyNights.length} בפלוס ב-3+ ריבאיים (${pct}%)`;
    } else {
      comebackLabel = `${lowRebuyNights.length}/${trackedRebuyGames} מש׳ ב-0–2 ריבאיים`;
    }

    const twoPlusComebackRate =
      twoPlusRebuyNights.length >= 2
        ? (twoPlusWins / twoPlusRebuyNights.length) * 100
        : null;

    return {
      player,
      gamesPlayed: n,
      winsCount: wins.length,
      lossesCount: losses.length,
      totalProfit,
      avgProfit,
      winRate,
      stdDev,
      upStd,
      downsideDev,
      avgRebuys,
      stdRebuys,
      maxRebuys,
      trackedRebuyGames,
      avgAbsSwing,
      avgWinSize,
      avgLossSize,
      payoffRatio,
      bigWins,
      bigLosses,
      smallWins,
      smallLosses,
      bigWinRate,
      bigLossRate,
      worstLoss,
      bestWin,
      rebuyComebackRate,
      twoPlusComebackRate,
      comebackLabel,
      highRebuyGames: highRebuyNights.length,
      lowRebuyGames: lowRebuyNights.length,
      lowRebuyAvg,
      highRebuyAvg,
      highRebuyShare,
      medPlusRebuyShare,
      firstHalfCount: firstHalfNights.length,
      secondHalfCount: secondHalfNights.length,
      firstHalfAvg,
      secondHalfAvg,
      firstHalfRebuys,
      secondHalfRebuys,
    };
  });

  // Ranks across active players in this selected period
  const byTotalProfitDesc = [...baseStats].sort((a, b) => b.totalProfit - a.totalProfit);
  const profitRankMap = new Map<string, number>();
  byTotalProfitDesc.forEach((s, idx) => profitRankMap.set(s.player.id, idx + 1));

  const byRebuyAsc = [...baseStats].sort((a, b) => a.avgRebuys - b.avgRebuys || a.downsideDev - b.downsideDev);
  const rebuyRankMap = new Map<string, number>();
  byRebuyAsc.forEach((s, idx) => rebuyRankMap.set(s.player.id, idx + 1));

  const grp = {
    avgProfitMean: meanOf(baseStats.map(s => s.avgProfit)),
    avgProfitStd: stdDevOf(baseStats.map(s => s.avgProfit)),
    winRateMean: meanOf(baseStats.map(s => s.winRate)),
    winRateStd: stdDevOf(baseStats.map(s => s.winRate)),
    stdDevMean: meanOf(baseStats.map(s => s.stdDev)),
    stdDevStd: stdDevOf(baseStats.map(s => s.stdDev)),
    upStdMean: meanOf(baseStats.map(s => s.upStd)),
    upStdStd: stdDevOf(baseStats.map(s => s.upStd)),
    downStdMean: meanOf(baseStats.map(s => s.downsideDev)),
    downStdStd: stdDevOf(baseStats.map(s => s.downsideDev)),
    avgWinMean: meanOf(baseStats.map(s => s.avgWinSize)),
    avgWinStd: stdDevOf(baseStats.map(s => s.avgWinSize)),
    avgLossAbsMean: meanOf(baseStats.map(s => Math.abs(s.avgLossSize))),
    avgLossAbsStd: stdDevOf(baseStats.map(s => Math.abs(s.avgLossSize))),
    payoffMean: meanOf(baseStats.map(s => s.payoffRatio)),
    payoffStd: stdDevOf(baseStats.map(s => s.payoffRatio)),
    rebuyMean: meanOf(baseStats.map(s => s.avgRebuys)),
    rebuyStd: stdDevOf(baseStats.map(s => s.avgRebuys)),
    highRebuyShareMean: meanOf(baseStats.map(s => s.highRebuyShare)),
    highRebuyShareStd: stdDevOf(baseStats.map(s => s.highRebuyShare)),
    medPlusRebuyShareMean: meanOf(baseStats.map(s => s.medPlusRebuyShare)),
    medPlusRebuyShareStd: stdDevOf(baseStats.map(s => s.medPlusRebuyShare)),
    bigWinRateMean: meanOf(baseStats.map(s => s.bigWinRate)),
    bigWinRateStd: stdDevOf(baseStats.map(s => s.bigWinRate)),
    bigLossRateMean: meanOf(baseStats.map(s => s.bigLossRate)),
    bigLossRateStd: stdDevOf(baseStats.map(s => s.bigLossRate)),
  };

  const totalPlayersInGroup = baseStats.length;

  const profiles: PlayerStyleMetrics[] = baseStats.map(s => {
    const profitRank = profitRankMap.get(s.player.id) || 1;
    const rebuyRank = rebuyRankMap.get(s.player.id) || 1;

    const zStd = zScore(s.stdDev, grp.stdDevMean, grp.stdDevStd);
    const zUpStd = zScore(s.upStd, grp.upStdMean, grp.upStdStd);
    const zDownStd = zScore(s.downsideDev, grp.downStdMean, grp.downStdStd);
    const zAvgWin = zScore(s.avgWinSize, grp.avgWinMean, grp.avgWinStd);
    const zPayoff = zScore(s.payoffRatio, grp.payoffMean, grp.payoffStd);
    const zRebuy = rebuysTracked ? zScore(s.avgRebuys, grp.rebuyMean, grp.rebuyStd) : 0;
    const zHighRebuyShare = rebuysTracked ? zScore(s.highRebuyShare, grp.highRebuyShareMean, grp.highRebuyShareStd) : 0;
    const zMedPlusShare = rebuysTracked ? zScore(s.medPlusRebuyShare, grp.medPlusRebuyShareMean, grp.medPlusRebuyShareStd) : 0;
    const zBigWin = zScore(s.bigWinRate, grp.bigWinRateMean, grp.bigWinRateStd);
    const zBigLoss = zScore(s.bigLossRate, grp.bigLossRateMean, grp.bigLossRateStd);

    // ─── Credible Period-Scoped Style & Archetype Classification ───
    const isProfitable = s.totalProfit > 0;
    const isTrulyLowRebuy = rebuysTracked && s.avgRebuys <= 2.2;
    const isBelowAvgRebuy = rebuysTracked && s.avgRebuys <= grp.rebuyMean && s.avgRebuys <= 2.85;
    const isHighRebuy =
      rebuysTracked &&
      (s.avgRebuys >= 3.05 ||
        (s.avgRebuys > grp.rebuyMean && (s.avgRebuys >= 2.9 || s.highRebuyShare >= 0.38 || s.medPlusRebuyShare >= 0.65)));

    const halfDelta = s.secondHalfAvg - s.firstHalfAvg;
    const hasSecondHalfSurge = s.gamesPlayed >= 6 && halfDelta >= 45 && s.secondHalfAvg > 0;

    // Bipolar / Rollercoaster check within selected period: negative profit player who frequently enters 4+ rebuys and crashes hard vs controlled games
    const isBipolarRollercoaster =
      !isProfitable &&
      !isTrulyLowRebuy &&
      s.trackedRebuyGames >= s.gamesPlayed * 0.5 &&
      s.lowRebuyAvg !== null &&
      s.highRebuyAvg !== null &&
      s.lowRebuyAvg >= 30 &&
      s.highRebuyAvg <= -75 &&
      s.highRebuyGames >= 3 &&
      (s.highRebuyShare >= 0.28 || s.avgRebuys >= 2.65);

    const isBigPotActionPlayer =
      isProfitable &&
      !isTrulyLowRebuy &&
      !isBelowAvgRebuy &&
      s.stdDev >= 135 &&
      s.bigWins + s.bigLosses >= Math.max(6, Math.ceil(s.gamesPlayed * 0.3));

    // Style badge (what the period's numbers prove about Solid vs Aggressive)
    let styleBadge = 'מאוזן';
    if (!rebuysTracked || s.trackedRebuyGames === 0) {
      styleBadge = s.stdDev <= grp.stdDevMean ? 'סולידי ויציב בתוצאות' : 'תנודתי לשני הכיוונים';
    } else if (isTrulyLowRebuy && s.downsideDev <= grp.downStdMean * 1.1) {
      styleBadge = 'סולידי ומחושב (מוכח בנתונים)';
    } else if (isHighRebuy && s.stdDev >= 145) {
      styleBadge = 'אגרסיבי ותנודתי מאוד';
    } else if (isHighRebuy && s.stdDev < 115 && s.bigWins <= 1) {
      styleBadge = 'ריבאיים גבוהים ללא תקרת זכייה';
    } else if (isHighRebuy) {
      styleBadge = 'אגרסיבי בריבאיים (תנודתי)';
    } else if (isBigPotActionPlayer) {
      styleBadge = s.gamesPlayed >= 100 ? 'אקשן דו-כיווני (קופות גדולות)' : 'קופות גדולות (תנודתיות חיובית)';
    } else if (!isProfitable && isBipolarRollercoaster) {
      styleBadge = 'דו-פני: סולידי בעד 2 ריבאיים, נשחק ב-4+ ריבאיים';
    } else if (isBelowAvgRebuy) {
      styleBadge = 'מבוקר בקניות (מתחת לממוצע השולחן)';
    } else if (s.stdDev >= 135) {
      styleBadge = 'תנודתי לשני הכיוונים';
    } else if (s.avgRebuys > grp.rebuyMean) {
      styleBadge = s.highRebuyGames >= 2 ? 'נוטה לערבי ריבאיים מרובים' : 'קניות מעל ממוצע השולחן';
    } else {
      styleBadge = 'מבוקר בקניות';
    }

    let emoji = '🎯';
    let title = '';

    if (isProfitable) {
      if (profitRank === 1 && s.winRate >= 68 && isTrulyLowRebuy) {
        emoji = '👑';
        title = 'השליט המחושב של השולחן';
      } else if (isTrulyLowRebuy && s.stdDev <= 115 && s.bigLosses === 0) {
        emoji = '🪨';
        title = 'הסלע היציב (אפס התרסקויות)';
      } else if (isTrulyLowRebuy && s.stdDev <= 115 && s.bigLosses <= 1) {
        emoji = '🪨';
        title = 'הסלע היציב של השולחן';
      } else if (isTrulyLowRebuy && hasSecondHalfSurge) {
        emoji = '🚀';
        title = 'הצלף שבמומנטום עלייה';
      } else if (isTrulyLowRebuy && s.payoffRatio >= 1.25 && s.bigWins >= s.bigLosses + 1) {
        emoji = '🎯';
        title = 'הצלף היעיל (מקסימום רווח למינימום קנייה)';
      } else if (isHighRebuy && (s.stdDev >= 150 || s.bigWins >= 3)) {
        emoji = '🦈';
        title = 'כריש הקופות והאקשן';
      } else if (isBigPotActionPlayer || styleBadge === 'תנודתי לשני הכיוונים') {
        emoji = s.gamesPlayed >= 100 ? '🔥' : '⚡';
        title = s.gamesPlayed >= 100 ? 'מרתוניסט האקשן הדו-כיווני' : 'שחקן האקשן הדו-כיווני';
      } else {
        emoji = '⚖️';
        title = 'הטקטיקן המאוזן';
      }
    } else {
      // Negative profit in selected period — distinguish every single player by their true statistical mechanism in this period
      if (s.avgRebuys >= 4.4 || (rebuyRank === totalPlayersInGroup && s.avgRebuys >= 3.8)) {
        emoji = '🎰';
        title = 'שיאן הריבאיים והאקשן';
      } else if (isBipolarRollercoaster) {
        emoji = '🎢';
        title = s.avgRebuys >= 3.3 ? 'רכבת הרים (נפילה בערבי 4+ ריבאיים)' : 'דו-קוטבי (מצוין בעד 2 ריבאיים, נשחק ב-4+ ריבאיים)';
      } else if (s.bigWins === 0 && (s.avgRebuys >= 3.0 || isHighRebuy)) {
        emoji = '📉';
        title = 'ריבאיים גבוהים מול תקרת זכייה נמוכה';
      } else if (isHighRebuy) {
        emoji = '🔥';
        title = 'קניות מרובות ושחיקה בערבי שיא';
      } else if (isBelowAvgRebuy && s.winsCount > 0 && s.avgWinSize >= grp.avgWinMean * 0.75 && s.winRate <= 38) {
        emoji = '🏹';
        title = 'קניות מבוקרות בתקופת יובש נצחונות';
      } else if (s.stdDev <= 105 && (isTrulyLowRebuy || isBelowAvgRebuy)) {
        emoji = '🔒';
        title = 'השמרן המבוקר (תנודות קטנות)';
      } else {
        emoji = '🛡️';
        title = 'בחיפוש מומנטום חיובי';
      }
    }

    // ─── X-Axis Volatility & Aggression Score (0..100, with 50 = dividing line) ───
    const isUpsideDrivenStd = s.upStd > s.downsideDev * 1.4 && zDownStd < 0 && s.avgRebuys <= 2.3;
    const isHighRebuyLowUpside = rebuysTracked && s.avgRebuys >= 3.0 && zStd < 0;
    const effectiveZStd = isUpsideDrivenStd
      ? Math.min(-0.2, zStd * 0.15)
      : isHighRebuyLowUpside
        ? Math.max(0.35, zRebuy * 0.7)
        : zStd;

    const zVolatilityComposite = rebuysTracked
      ? 0.35 * zRebuy +
        0.12 * zHighRebuyShare +
        0.08 * zMedPlusShare +
        0.20 * effectiveZStd +
        0.15 * zDownStd +
        0.10 * zBigLoss
      : 0.45 * effectiveZStd + 0.35 * zDownStd + 0.20 * zBigLoss;

    let volatility = zToScore(zVolatilityComposite, 14, 92);

    // Strict visual-to-verbal alignment around X = 50:
    // Solid/Controlled badges ALWAYS sit on the Left (<50); Aggressive/Volatile/Rollercoaster badges ALWAYS sit on the Right (>=50).
    const isClassifiedSolid =
      styleBadge.startsWith('סולידי') || styleBadge.startsWith('מבוקר');
    const isClassifiedAggressive = !isClassifiedSolid;

    if (isClassifiedSolid && volatility >= 47) {
      volatility = Math.min(46, Math.round(32 + Math.max(0, s.avgRebuys - 1.2) * 8));
    } else if (isClassifiedAggressive && volatility <= 53) {
      volatility = Math.max(55, Math.round(54 + Math.max(0, s.avgRebuys - 2.4) * 9));
    }

    // ─── 5 Period-Responsive Radar Axes (0..100) ───
    // Axis 1: Win Rate — exact win rate % in the selected period (clamped 5..98 so polygon stays visible)
    const radarWinRate = Math.round(Math.max(5, Math.min(98, s.winRate)));

    // Axis 2: Risk Control (Consistency) — blends real period metrics (rebuy rate, downside dev, big loss rate) with period z-score
    const zInstability = rebuysTracked
      ? 0.38 * zDownStd + 0.22 * zBigLoss + 0.40 * zRebuy
      : 0.60 * zDownStd + 0.40 * zBigLoss;
    const rebuyDisciplineDomain = Math.max(10, Math.min(98, 100 - s.avgRebuys * 15.5));
    const downsideControlDomain = Math.max(10, Math.min(98, 100 - (s.downsideDev / Math.max(110, bigSwingThreshold)) * 52));
    const bigLossAvoidDomain = Math.max(10, Math.min(98, 100 - s.bigLossRate * 135));
    const domainConsistency =
      rebuysTracked && s.trackedRebuyGames > 0
        ? 0.45 * rebuyDisciplineDomain + 0.35 * downsideControlDomain + 0.20 * bigLossAvoidDomain
        : 0.65 * downsideControlDomain + 0.35 * bigLossAvoidDomain;
    const radarConsistency = Math.round(
      Math.max(12, Math.min(96, 0.60 * domainConsistency + 0.40 * zToScore(-zInstability, 15, 95)))
    );

    // Axis 3: Upside (Peak Power) — blends period avgWinSize, bigWinRate & upStd with period z-score
    const zUpsideComposite = 0.35 * zAvgWin + 0.25 * zUpStd + 0.25 * zBigWin + 0.15 * zPayoff;
    const winSizeDomain = Math.min(96, (s.avgWinSize / Math.max(120, bigSwingThreshold)) * 62);
    const bigWinDomain = Math.min(96, s.bigWinRate * 165);
    const upStdDomain = Math.min(96, (s.upStd / Math.max(110, bigSwingThreshold)) * 65);
    const domainUpside = 0.40 * winSizeDomain + 0.30 * bigWinDomain + 0.30 * upStdDomain;
    const radarUpside =
      s.winsCount === 0
        ? 10
        : Math.round(Math.max(12, Math.min(96, 0.60 * domainUpside + 0.40 * zToScore(zUpsideComposite, 15, 95))));

    // Axis 4: Comeback from Rebuys in the selected period
    let radarComeback = 45;
    if (rebuysTracked && s.trackedRebuyGames > 0) {
      if (s.rebuyComebackRate !== null && (s.highRebuyShare >= 0.15 || s.avgRebuys >= 2.2)) {
        const volumeFactor = Math.min(1.15, Math.max(0.7, s.avgRebuys / Math.max(1.5, grp.rebuyMean)));
        radarComeback = Math.round(Math.max(15, Math.min(95, (18 + s.rebuyComebackRate * 0.95) * volumeFactor)));
      } else if (s.twoPlusComebackRate !== null) {
        radarComeback = Math.round(Math.max(22, Math.min(92, 24 + s.twoPlusComebackRate * 0.9)));
      } else {
        radarComeback = Math.round(40 + (s.winRate / 100) * 25);
      }
    }

    // Axis 5: Action & Big Pots in the selected period
    const zActionComposite = rebuysTracked
      ? 0.35 * zStd +
        0.45 * zRebuy +
        0.20 *
          zScore(
            s.bigWinRate + s.bigLossRate,
            grp.bigWinRateMean + grp.bigLossRateMean,
            Math.hypot(grp.bigWinRateStd, grp.bigLossRateStd)
          )
      : 0.65 * zStd + 0.35 * zBigWin;
    const rebuyActionDomain = Math.min(96, s.avgRebuys * 17.5);
    const stdActionDomain = Math.min(96, (s.stdDev / Math.max(120, bigSwingThreshold)) * 58);
    const swingRateDomain = Math.min(96, (s.bigWinRate + s.bigLossRate) * 115);
    const domainAction =
      rebuysTracked && s.trackedRebuyGames > 0
        ? 0.45 * rebuyActionDomain + 0.35 * stdActionDomain + 0.20 * swingRateDomain
        : 0.65 * stdActionDomain + 0.35 * swingRateDomain;
    const radarAction = Math.round(
      Math.max(12, Math.min(96, 0.60 * domainAction + 0.40 * zToScore(zActionComposite, 15, 95)))
    );

    const radar = {
      winRate: radarWinRate,
      consistency: radarConsistency,
      upside: radarUpside,
      comeback: radarComeback,
      action: radarAction,
    };

    // ─── Unique, Period-Pure Summary Sentence (`description`) ───
    const rankStr =
      s.totalProfit > 0
        ? profitRank === 1
          ? 'מוביל את השולחן (#1)'
          : `מדורג #${profitRank} מתוך ${totalPlayersInGroup} (בפלוס)`
        : s.totalProfit < 0
          ? `מדורג #${profitRank} מתוך ${totalPlayersInGroup} (במינוס)`
          : `מדורג #${profitRank} מתוך ${totalPlayersInGroup} (מאוזן על 0₪)`;

    const bigWinsTxt = fmtFemCount(s.bigWins, 'זכייה גדולה', 'זכיות גדולות');
    const bigLossesTxt = fmtCount(s.bigLosses, 'הפסד גדול', 'הפסדים גדולים');
    const highRebuyNightsTxt =
      s.highRebuyGames === 1 ? 'ערב אחד של 4+ ריבאיים' : `${s.highRebuyGames} ערבי 4+ ריבאיים`;

    let description = '';
    if (isProfitable && isTrulyLowRebuy && s.winRate >= 68) {
      description = `${rankStr} עם ${fmtSigned(s.totalProfit)}₪ ב-${s.gamesPlayed} הופעות (${Math.round(s.winRate)}% נצחונות) ו-${s.avgRebuys.toFixed(1)} ריבאיים בלבד למשחק — סטיית התקן (${cleanNumber(Math.round(s.stdDev))}₪) נובעת מזכיות גדולות ולא מסיכון`;
    } else if (isProfitable && isTrulyLowRebuy && hasSecondHalfSurge) {
      description = `${rankStr} עם ${fmtSigned(s.totalProfit)}₪ ב-${s.gamesPlayed} משחקים (${Math.round(s.winRate)}% נצחונות, ממוצע ${fmtSigned(s.avgProfit)}₪) — זינק מ-${fmtSigned(s.firstHalfAvg)}₪ בחצי הראשון של התקופה ל-${fmtSigned(s.secondHalfAvg)}₪ בחצי השני תוך שמירה על ${s.avgRebuys.toFixed(1)} ריבאיים`;
    } else if (isProfitable && isHighRebuy && s.highRebuyGames >= 2 && s.trackedRebuyGames >= s.gamesPlayed * 0.5) {
      description = `${rankStr} (${fmtSigned(s.totalProfit)}₪ ב-${s.gamesPlayed} מש׳) עם סטיית תקן גבוהה (${cleanNumber(Math.round(s.stdDev))}₪) ו-${s.avgRebuys.toFixed(1)} ריבאיים לערב — מוכיח שגם עם ${highRebuyNightsTxt} אפשר לסיים בפלוס`;
    } else if (isProfitable && s.stdDev <= 115) {
      const crashFreeNote = s.bigLosses === 0 ? 'בלי התרסקויות' : 'בתנודתיות נמוכה';
      description = `${rankStr} (${fmtSigned(s.totalProfit)}₪ ב-${s.gamesPlayed} מש׳, ${Math.round(s.winRate)}% נצחונות) עם סטיית תקן נמוכה (${cleanNumber(Math.round(s.stdDev))}₪) ו-${s.avgRebuys.toFixed(1)} ריבאיים — בונה פלוס עקבי ${crashFreeNote}`;
    } else if (isProfitable) {
      description = `${rankStr} עם ${fmtSigned(s.totalProfit)}₪ ב-${s.gamesPlayed} הופעות · סטיית תקן ${cleanNumber(Math.round(s.stdDev))}₪ (${bigWinsTxt} מול ${bigLossesTxt}) וקצב של ${s.avgRebuys.toFixed(1)} ריבאיים לערב`;
    } else if (s.avgRebuys >= 3.95 || (rebuyRank === totalPlayersInGroup && s.avgRebuys >= 3.7)) {
      description = `${rankStr} (${fmtSigned(s.totalProfit)}₪ ב-${s.gamesPlayed} הופעות, ממוצע ${fmtSigned(s.avgProfit)}₪) — מייצר קצב ריבאיים גבוה במיוחד (${s.avgRebuys.toFixed(1)} למשחק, שיא ${s.maxRebuys}, מול ממוצע שולחן ${grp.rebuyMean.toFixed(1)}) עם סטיית תקן ${cleanNumber(Math.round(s.stdDev))}₪ והפסד ממוצע ${fmtSigned(s.avgLossSize)}₪`;
    } else if (isBipolarRollercoaster && s.lowRebuyAvg !== null && s.highRebuyAvg !== null) {
      description = `${rankStr} (${fmtSigned(s.totalProfit)}₪ ב-${s.gamesPlayed} מש׳) — הפער אצלו קיצוני: ב-${s.lowRebuyGames} משחקים של עד 2 ריבאיים הממוצע שלו חיובי (${fmtSigned(s.lowRebuyAvg)}₪ למשחק), אך ב-${highRebuyNightsTxt} הוא מתרסק לממוצע ${fmtSigned(s.highRebuyAvg)}₪`;
    } else if (s.winsCount === 0) {
      description = `${rankStr} (${fmtSigned(s.totalProfit)}₪ ב-${s.gamesPlayed} הופעות, ממוצע ${fmtSigned(s.avgProfit)}₪) — טרם רשם ערב חיובי בתקופה זו (קצב של ${s.avgRebuys.toFixed(1)} ריבאיים למשחק וסטיית תקן ${cleanNumber(Math.round(s.stdDev))}₪)`;
    } else if (isHighRebuy) {
      description = `${rankStr} (${fmtSigned(s.totalProfit)}₪ ב-${s.gamesPlayed} מש׳, ממוצע ${fmtSigned(s.avgProfit)}₪) — נכנס לקצב גבוה של ${s.avgRebuys.toFixed(1)} ריבאיים למשחק (מול ממוצע שולחן ${grp.rebuyMean.toFixed(1)}) עם ${bigLossesTxt} מול ${bigWinsTxt} (${Math.round(s.winRate)}% נצחונות)`;
    } else if (isBelowAvgRebuy && s.avgWinSize >= grp.avgWinMean * 0.75 && s.winRate <= 38) {
      description = `${rankStr} (${fmtSigned(s.totalProfit)}₪ ב-${s.gamesPlayed} מש׳, ממוצע ${fmtSigned(s.avgProfit)}₪) — שומר על משמעת קניות (${s.avgRebuys.toFixed(1)} ריבאיים, מתחת לממוצע השולחן ${grp.rebuyMean.toFixed(1)}) וזכייה ממוצעת של ${fmtSigned(s.avgWinSize)}₪ בניצחונות, אך מנצח רק ב-${Math.round(s.winRate)}% מהערבים`;
    } else if (isBelowAvgRebuy) {
      description = `${rankStr} (${fmtSigned(s.totalProfit)}₪ ב-${s.gamesPlayed} מש׳, ממוצע ${fmtSigned(s.avgProfit)}₪) — שומר על קניות מבוקרות (${s.avgRebuys.toFixed(1)} ריבאיים, שיא ${s.maxRebuys}) ותנודות מתונות (σ=${cleanNumber(Math.round(s.stdDev))}₪), אך זכייה ממוצעת של ${fmtSigned(s.avgWinSize)}₪ ב-${Math.round(s.winRate)}% מהערבים לא מכסה את ההפסדים`;
    } else {
      description = `${rankStr} (${fmtSigned(s.totalProfit)}₪ ב-${s.gamesPlayed} הופעות, ${Math.round(s.winRate)}% נצחונות) — קצב של ${s.avgRebuys.toFixed(1)} ריבאיים למשחק מול זכייה ממוצעת של ${fmtSigned(s.avgWinSize)}₪ בניצחונות (${bigWinsTxt} מול ${bigLossesTxt})`;
    }

    // ─── 4 Deeply Personalized Period-Scoped Proof Bullets (`traits`) ───
    const traits: string[] = [];

    // Bullet 1: Period Balance, Appearances, Win/Loss Sizing & Payoff Ratio
    const winsPhrase = s.winsCount === 1 ? 'בניצחון אחד' : `ב-${s.winsCount} ניצחונות`;
    const lossesPhrase = s.lossesCount === 1 ? 'ובהפסד אחד' : `וב-${s.lossesCount} הפסדים`;
    const winLossSizingStr =
      s.winsCount === 0
        ? `טרם רשם ערב חיובי בתקופה זו (הפסד ממוצע ${fmtSigned(s.avgLossSize)}₪ ב-${s.lossesCount} הפסדים)`
        : s.lossesCount === 0
          ? `ניצח בכל ${s.winsCount} הופעותיו בתקופה זו (זכייה ממוצעת ${fmtSigned(s.avgWinSize)}₪ לערב)`
          : `${winsPhrase} זכה בממוצע ב-${fmtSigned(s.avgWinSize)}₪ ${lossesPhrase} הפסיד בממוצע ${fmtSigned(s.avgLossSize)}₪ (יחס זכייה/הפסד ×${s.payoffRatio.toFixed(2)})`;

    const balanceState = s.totalProfit > 0 ? 'חיובי' : s.totalProfit < 0 ? 'שלילי' : 'מאוזן';
    traits.push(
      `מאזן בתקופה הנבחרת (${balanceState}): סה״כ ${fmtSigned(s.totalProfit)}₪ ב-${s.gamesPlayed} הופעות (מקום ${profitRank}/${totalPlayersInGroup}, ממוצע ${fmtSigned(s.avgProfit)}₪, ${Math.round(s.winRate)}% נצחונות) · ${winLossSizingStr}`
    );

    // Bullet 2: Standard Deviation (σ), Symmetric Upside vs Downside Semideviation, Big vs Small Wins/Losses
    const stdProof =
      isProfitable && s.upStd >= s.downsideDev * 1.45
        ? `מוטה חזק למעלה (תנודה חיובית ${cleanNumber(Math.round(s.upStd))}₪ מול סיכון הפסד של ${cleanNumber(Math.round(s.downsideDev))}₪ בלבד)`
        : s.downsideDev >= s.upStd * 1.25
          ? `מוטה לצד ההפסדים (סיכון הפסד ${cleanNumber(Math.round(s.downsideDev))}₪ מול תנודה חיובית ${cleanNumber(Math.round(s.upStd))}₪)`
          : `דו-כיוונית (תנודה חיובית ${cleanNumber(Math.round(s.upStd))}₪ מול סיכון הפסד ${cleanNumber(Math.round(s.downsideDev))}₪)`;

    const bigWinCountStr =
      s.bigWins === 1 ? `זכייה גדולה אחת (${bigSwingThreshold}₪+)` : `${s.bigWins} זכיות גדולות (${bigSwingThreshold}₪+)`;
    const smallWinCountStr = s.smallWins === 1 ? 'וקטנה אחת' : `ו-${s.smallWins} קטנות`;
    const bigLossCountStr = fmtCount(s.bigLosses, 'הפסד גדול', 'הפסדים גדולים');
    const smallLossCountStr = s.smallLosses === 1 ? 'וקטן אחד' : `ו-${s.smallLosses} קטנים`;
    traits.push(
      `סטיית תקן ותנודתיות בתקופה: σ=${cleanNumber(Math.round(s.stdDev))}₪ (ממוצע שולחן ${cleanNumber(Math.round(grp.stdDevMean))}₪) — ${stdProof} · ${bigWinCountStr} ${smallWinCountStr}, מול ${bigLossCountStr} ${smallLossCountStr} (שיא ${fmtSigned(s.bestWin)}₪, שפל ${fmtSigned(s.worstLoss)}₪)`
    );

    // Bullet 3: Rebuy Proof within the selected period (Solid vs Aggressive verification with exact numbers)
    if (rebuysTracked && s.trackedRebuyGames > 0) {
      const rebuyRankDesc =
        rebuyRank === 1
          ? `#1 הכי חסכן בשולחן`
          : rebuyRank === totalPlayersInGroup
            ? `#${rebuyRank} הכי הרבה ריבאיים בשולחן`
            : `מקום ${rebuyRank}/${totalPlayersInGroup} מהנמוך לגבוה (ממוצע שולחן ${grp.rebuyMean.toFixed(1)})`;

      const trackedScopeNote =
        s.trackedRebuyGames < s.gamesPlayed
          ? `ב-${s.trackedRebuyGames} מש׳ מתועדי ריבאי · ${styleBadge}`
          : styleBadge;

      let splitProof = '';
      if (s.lowRebuyGames >= 1 && s.highRebuyGames >= 1 && s.lowRebuyAvg !== null && s.highRebuyAvg !== null) {
        const comebackPart =
          s.rebuyComebackRate !== null && s.highRebuyGames >= 2
            ? Math.round(s.rebuyComebackRate) === 0
              ? `, הפסיד בכל ${s.highRebuyGames} ערבי ה-${heavyRebuyThreshold}+ ריבאיים`
              : `, סיים בפלוס ב-${Math.round(s.rebuyComebackRate)}% מערבי ${heavyRebuyThreshold}+ ריבאיים`
            : '';
        splitProof = ` · בערבים מבוקרים (0–2 ריבאיים, ${s.lowRebuyGames} מש׳): ממוצע ${fmtSigned(s.lowRebuyAvg)}₪ לעומת ${fmtSigned(s.highRebuyAvg)}₪ בערבי ${heavyRebuyThreshold}+ ריבאיים (${s.highRebuyGames} מש׳${comebackPart})`;
      } else if (s.lowRebuyGames >= 2 && s.lowRebuyAvg !== null) {
        splitProof = ` · שיחק ${s.lowRebuyGames}/${s.trackedRebuyGames} משחקים עם 0–2 ריבאיים בלבד (ממוצע ${fmtSigned(s.lowRebuyAvg)}₪)`;
      } else if (s.highRebuyGames >= 2 && s.highRebuyAvg !== null) {
        splitProof = ` · נכנס ל-${heavyRebuyThreshold}+ ריבאיים ב-${s.highRebuyGames}/${s.trackedRebuyGames} מהמשחקים (ממוצע ${fmtSigned(s.highRebuyAvg)}₪)`;
      }

      traits.push(
        `מבחן הריבאיים בתקופה (${trackedScopeNote}): ממוצע ${s.avgRebuys.toFixed(1)} ריבאיים למשחק (${rebuyRankDesc}, שיא ${s.maxRebuys})${splitProof}`
      );
    } else if (s.gamesPlayed === 1) {
      traits.push(`עקביות תוצאות (${styleBadge}): תוצאה של ${fmtSigned(s.bestWin)}₪ בהופעה היחידה בתקופה`);
    } else {
      traits.push(
        `עקביות תוצאות בתקופה (${styleBadge}): תנודה ממוצעת של ${cleanNumber(Math.round(s.avgAbsSwing))}₪ לערב בין ${fmtSigned(s.worstLoss)}₪ ל-${fmtSigned(s.bestWin)}₪`
      );
    }

    // Bullet 4: Within-Period Trajectory & Momentum (First Half vs Second Half of Selected Period)
    if (s.gamesPlayed >= 4) {
      let halfChangeLabel = '';
      if (Math.abs(halfDelta) >= 18) {
        if (s.firstHalfAvg < 0 && s.secondHalfAvg < 0) {
          halfChangeLabel =
            halfDelta > 0
              ? `צמצום ההפסד הממוצע ב-${fmtSigned(halfDelta)}₪ למשחק`
              : `העמקת ההפסד ב-${fmtSigned(halfDelta)}₪ למשחק`;
        } else if (s.firstHalfAvg >= 0 && s.secondHalfAvg < 0) {
          halfChangeLabel = `מעבר מפלוס למינוס (${fmtSigned(halfDelta)}₪ למשחק)`;
        } else if (s.firstHalfAvg < 0 && s.secondHalfAvg >= 0) {
          halfChangeLabel = `מעבר ממינוס לפלוס (${fmtSigned(halfDelta)}₪ למשחק)`;
        } else {
          halfChangeLabel =
            halfDelta > 0 ? `עלייה של ${fmtSigned(halfDelta)}₪ למשחק` : `ירידה של ${fmtSigned(halfDelta)}₪ למשחק`;
        }
      }
      const momentumStr =
        Math.abs(halfDelta) >= 18
          ? `פתיחת התקופה (${s.firstHalfCount} מש׳ ראשונים): ממוצע ${fmtSigned(s.firstHalfAvg)}₪ ← המשך התקופה (${s.secondHalfCount} מש׳ אחרונים): ממוצע ${fmtSigned(s.secondHalfAvg)}₪ (${halfChangeLabel})`
          : `יציבות לאורך התקופה: ${s.firstHalfCount} מש׳ ראשונים בממוצע ${fmtSigned(s.firstHalfAvg)}₪ מול ${s.secondHalfCount} מש׳ אחרונים בממוצע ${fmtSigned(s.secondHalfAvg)}₪`;
      const rebuyTrendStr =
        s.firstHalfRebuys !== null && s.secondHalfRebuys !== null && Math.abs(s.secondHalfRebuys - s.firstHalfRebuys) >= 0.4
          ? ` · קצב הריבאיים בתקופה ${s.secondHalfRebuys > s.firstHalfRebuys ? 'עלה' : 'ירד'} מ-${s.firstHalfRebuys.toFixed(1)} ל-${s.secondHalfRebuys.toFixed(1)}`
          : '';
      traits.push(`דינמיקה ומגמה לאורך התקופה (${s.gamesPlayed} מש׳): ${momentumStr}${rebuyTrendStr}`);
    } else {
      traits.push(
        `פיזור תוצאות בתקופה (${s.gamesPlayed} מש׳): ${s.winsCount} ערבים חיוביים מול ${s.lossesCount} שליליים (טווח בין ${fmtSigned(s.worstLoss)}₪ ל-${fmtSigned(s.bestWin)}₪)`
      );
    }

    return {
      playerId: s.player.id,
      playerName: s.player.name,
      playerType: (s.player.type || 'permanent') as 'permanent' | 'permanent_guest' | 'guest',
      color: getPlayerColor(s.player.id),
      profitRank,
      rebuyRank,
      totalPlayersInGroup,
      gamesPlayed: s.gamesPlayed,
      totalProfit: s.totalProfit,
      avgProfit: s.avgProfit,
      winRate: s.winRate,
      stdDev: s.stdDev,
      upStd: s.upStd,
      downsideDev: s.downsideDev,
      volatility,
      avgRebuys: s.avgRebuys,
      stdRebuys: s.stdRebuys,
      maxRebuys: s.maxRebuys,
      trackedRebuyGames: s.trackedRebuyGames,
      avgAbsSwing: s.avgAbsSwing,
      avgWinSize: s.avgWinSize,
      avgLossSize: s.avgLossSize,
      payoffRatio: s.payoffRatio,
      bigWins: s.bigWins,
      bigLosses: s.bigLosses,
      smallWins: s.smallWins,
      smallLosses: s.smallLosses,
      worstLoss: s.worstLoss,
      bestWin: s.bestWin,
      rebuyComebackRate: s.rebuyComebackRate,
      comebackLabel: s.comebackLabel,
      highRebuyGames: s.highRebuyGames,
      lowRebuyGames: s.lowRebuyGames,
      lowRebuyAvg: s.lowRebuyAvg,
      highRebuyAvg: s.highRebuyAvg,
      firstHalfAvg: s.firstHalfAvg,
      secondHalfAvg: s.secondHalfAvg,
      radar,
      archetype: {
        emoji,
        title,
        styleBadge,
        description,
      },
      traits,
    };
  });

  profiles.sort((a, b) => b.totalProfit - a.totalProfit);

  const avgOf = (key: keyof PlayerStyleMetrics['radar']) =>
    Math.round(profiles.reduce((sum, p) => sum + p.radar[key], 0) / profiles.length);

  return {
    profiles,
    medianVolatility: 50,
    bigSwingThreshold,
    heavyRebuyThreshold,
    groupAvgRebuys: grp.rebuyMean,
    groupAvgStdDev: grp.stdDevMean,
    groupAvgWinRate: grp.winRateMean,
    groupAvgWinSize: grp.avgWinMean,
    groupAvgLossSize: -grp.avgLossAbsMean,
    groupAvgRadar: {
      winRate: Math.round(grp.winRateMean),
      consistency: avgOf('consistency'),
      upside: avgOf('upside'),
      comeback: avgOf('comeback'),
      action: avgOf('action'),
    },
  };
}
