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
  winsCount: number;
  lossesCount: number;
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

const fmtInGamesWhere = (n: number): string => {
  if (n === 1) return 'במשחק היחיד שבו';
  return `ב-${n} משחקים שבהם`;
};

const fmtInNights = (n: number): string => {
  if (n === 1) return 'בערב היחיד';
  return `ב-${n} ערבים`;
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
  isTableTopWinner: boolean;
  isTableWorstLoser: boolean;
}

function collectPlayerNights(
  playerId: string,
  games: Game[],
  gamePlayersByGameId: Map<string, Map<string, GamePlayer>>,
  trackingMap: Map<string, boolean>
): NightRecord[] {
  const nights: NightRecord[] = [];
  for (const g of games) {
    const byPlayer = gamePlayersByGameId.get(g.id);
    const gp = byPlayer?.get(playerId);
    if (!gp || !byPlayer) continue;
    const tracked = trackingMap.get(g.id) ?? false;
    const extraRebuys = tracked ? Math.max(0, (gp.rebuys || 1) - 1) : null;

    let maxProfit = -Infinity;
    let minProfit = Infinity;
    byPlayer.forEach(p => {
      if (p.profit > maxProfit) maxProfit = p.profit;
      if (p.profit < minProfit) minProfit = p.profit;
    });
    const isTableTopWinner = gp.profit > 0 && Math.abs(gp.profit - maxProfit) < 0.05;
    const isTableWorstLoser = gp.profit < 0 && Math.abs(gp.profit - minProfit) < 0.05;

    nights.push({ profit: gp.profit, extraRebuys, isTableTopWinner, isTableWorstLoser });
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

  // Extra rebuys: 0–2 is normal/controlled; 4+ extra rebuys (5+ total entries = 150₪+) is heavy.
  // Only treat the period as rebuy-tracked when at least 40% of games in the selected period tracked rebuys,
  // so historical/All-Time periods aren't skewed by a tiny subset of recent tracked games.
  const controlledRebuyMax = 2;
  const heavyRebuyThreshold = 4;
  const trackedGamesInPeriod = Array.from(periodTrackingMap.values()).filter(Boolean).length;
  const rebuysTracked = trackedGamesInPeriod >= Math.max(2, Math.ceil(games.length * 0.4));

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

    const sortedProfitsDesc = [...profits].sort((a, b) => b - a);
    const secondBestWin = sortedProfitsDesc.length > 1 ? sortedProfitsDesc[1] : bestWin;
    const secondWorstLoss = sortedProfitsDesc.length > 1 ? sortedProfitsDesc[sortedProfitsDesc.length - 2] : worstLoss;
    const profitWithoutBest1 = totalProfit - bestWin;
    const profitWithoutBest2 = n >= 4 ? sortedProfitsDesc.slice(2).reduce((s, v) => s + v, 0) : profitWithoutBest1;
    const profitWithoutWorst1 = totalProfit - worstLoss;
    const profitWithoutWorst2 = n >= 4 ? sortedProfitsDesc.slice(0, -2).reduce((s, v) => s + v, 0) : profitWithoutWorst1;

    // Bounce-back recovery rate & post-loss psychology across all `n` games in the selected period
    let afterLossCount = 0;
    let bounceBackWins = 0;
    const afterLossProfits: number[] = [];
    let curWinStreak = 0;
    let maxWinStreak = 0;
    let curLossStreak = 0;
    let maxLossStreak = 0;
    for (let i = 0; i < nights.length; i++) {
      if (nights[i].profit > 0) {
        curWinStreak++;
        curLossStreak = 0;
        if (curWinStreak > maxWinStreak) maxWinStreak = curWinStreak;
      } else if (nights[i].profit < 0) {
        curLossStreak++;
        curWinStreak = 0;
        if (curLossStreak > maxLossStreak) maxLossStreak = curLossStreak;
      } else {
        curWinStreak = 0;
        curLossStreak = 0;
      }
      if (i > 0 && nights[i - 1].profit < 0) {
        afterLossCount++;
        afterLossProfits.push(nights[i].profit);
        if (nights[i].profit > 0) bounceBackWins++;
      }
    }
    const bounceBackRate = afterLossCount > 0 ? (bounceBackWins / afterLossCount) * 100 : winRate;
    const avgProfitAfterLoss = afterLossProfits.length > 0 ? meanOf(afterLossProfits) : avgProfit;

    const mid = Math.floor(n / 2);
    const firstHalfNights = mid > 0 ? nights.slice(0, mid) : nights;
    const secondHalfNights = mid > 0 ? nights.slice(mid) : nights;
    const firstHalfAvg = meanOf(firstHalfNights.map(x => x.profit));
    const secondHalfAvg = meanOf(secondHalfNights.map(x => x.profit));

    const firstHalfTracked = firstHalfNights.filter(
      (x): x is NightRecord & { extraRebuys: number } => x.extraRebuys !== null
    );
    const secondHalfTracked = secondHalfNights.filter(
      (x): x is NightRecord & { extraRebuys: number } => x.extraRebuys !== null
    );
    const firstHalfRebuys = firstHalfTracked.length > 0 ? meanOf(firstHalfTracked.map(x => x.extraRebuys)) : null;
    const secondHalfRebuys = secondHalfTracked.length > 0 ? meanOf(secondHalfTracked.map(x => x.extraRebuys)) : null;

    const trackedNights = rebuysTracked
      ? nights.filter((x): x is NightRecord & { extraRebuys: number } => x.extraRebuys !== null)
      : [];
    const trackedRebuyGames = trackedNights.length;
    const extraRebuyVals = trackedNights.map(x => x.extraRebuys);
    const avgRebuys = trackedRebuyGames > 0 ? meanOf(extraRebuyVals) : 0;
    const stdRebuys = trackedRebuyGames > 1 ? stdDevOf(extraRebuyVals) : 0;
    const maxRebuys = trackedRebuyGames > 0 ? Number(cleanNumber(Math.max(...extraRebuyVals))) : 0;

    const zeroRebuyNights = trackedNights.filter(x => x.extraRebuys === 0);
    const zeroOneRebuyNights = trackedNights.filter(x => x.extraRebuys <= 1);
    const twoPlusRebuyNights = trackedNights.filter(x => x.extraRebuys >= 2);
    const lowRebuyNights = trackedNights.filter(x => x.extraRebuys <= controlledRebuyMax);
    const mediumPlusRebuyNights = trackedNights.filter(x => x.extraRebuys >= 3);
    const underFourRebuyNights = trackedNights.filter(x => x.extraRebuys <= 3);
    const highRebuyNights = trackedNights.filter(x => x.extraRebuys >= heavyRebuyThreshold);

    const zeroRebuyTotal = zeroRebuyNights.reduce((s, x) => s + x.profit, 0);
    const zeroRebuyWins = zeroRebuyNights.filter(x => x.profit > 0).length;
    const zeroOneTotal = zeroOneRebuyNights.reduce((s, x) => s + x.profit, 0);
    const zeroOneAvg = zeroOneRebuyNights.length > 0 ? meanOf(zeroOneRebuyNights.map(x => x.profit)) : null;
    const zeroOneWins = zeroOneRebuyNights.filter(x => x.profit > 0).length;
    const twoPlusTotal = twoPlusRebuyNights.reduce((s, x) => s + x.profit, 0);
    const twoPlusWins = twoPlusRebuyNights.filter(x => x.profit > 0).length;
    const twoPlusAvg = twoPlusRebuyNights.length > 0 ? meanOf(twoPlusRebuyNights.map(x => x.profit)) : null;

    const lowRebuyTotal = lowRebuyNights.reduce((s, x) => s + x.profit, 0);
    const lowRebuyAvg = lowRebuyNights.length > 0 ? meanOf(lowRebuyNights.map(x => x.profit)) : null;
    const medPlusTotal = mediumPlusRebuyNights.reduce((s, x) => s + x.profit, 0);
    const medPlusAvg = mediumPlusRebuyNights.length > 0 ? meanOf(mediumPlusRebuyNights.map(x => x.profit)) : null;
    const underFourTotal = underFourRebuyNights.reduce((s, x) => s + x.profit, 0);
    const underFourAvg = underFourRebuyNights.length > 0 ? meanOf(underFourRebuyNights.map(x => x.profit)) : null;
    const highRebuyTotal = highRebuyNights.reduce((s, x) => s + x.profit, 0);
    const highRebuyAvg = highRebuyNights.length > 0 ? meanOf(highRebuyNights.map(x => x.profit)) : null;

    const tableTopWins = nights.filter(x => x.isTableTopWinner).length;
    const tableBottomLosses = nights.filter(x => x.isTableWorstLoser).length;

    const highRebuyShare = trackedRebuyGames > 0 ? highRebuyNights.length / trackedRebuyGames : 0;
    const medPlusRebuyShare = trackedRebuyGames > 0 ? mediumPlusRebuyNights.length / trackedRebuyGames : 0;

    // Comeback rate in 3+ / 4+ / 2+ rebuy nights within the selected period
    const highRebuyWins = highRebuyNights.filter(x => x.profit > 0).length;
    const medPlusWins = mediumPlusRebuyNights.filter(x => x.profit > 0).length;

    const rebuyComebackRate =
      highRebuyNights.length >= 2
        ? (highRebuyWins / highRebuyNights.length) * 100
        : null;

    const medPlusComebackRate =
      mediumPlusRebuyNights.length >= 1
        ? (medPlusWins / mediumPlusRebuyNights.length) * 100
        : null;

    const twoPlusComebackRate =
      twoPlusRebuyNights.length >= 1
        ? (twoPlusWins / twoPlusRebuyNights.length) * 100
        : null;

    const rebuyPoolTxt =
      trackedRebuyGames === n
        ? `${n} משחקי התקופה`
        : `${trackedRebuyGames} משחקים עם תיעוד ריבאיים`;

    let comebackLabel = '';
    if (!rebuysTracked || trackedRebuyGames === 0) {
      comebackLabel =
        afterLossCount > 0
          ? `חזר לנצח ב-${bounceBackWins} מתוך ${afterLossCount} משחקים אחרי הפסד · סה״כ ${n} משחקים בתקופה`
          : `ניצח בכל ${wins.length} מתוך ${n} משחקי התקופה`;
    } else if (highRebuyNights.length >= 3 && (highRebuyShare >= 0.18 || avgRebuys >= 2.5)) {
      const pct = Math.round((highRebuyWins / highRebuyNights.length) * 100);
      comebackLabel = `סיים ברווח ב-${highRebuyWins} מתוך ${highRebuyNights.length} ערבי 4+ ריבאיים — ${pct}% הצלחה מתוך ${rebuyPoolTxt}`;
    } else if (mediumPlusRebuyNights.length >= 4) {
      comebackLabel = `שמר על 0–2 ריבאיים ב-${lowRebuyNights.length} מתוך ${rebuyPoolTxt} · ברווח ב-${medPlusWins} מתוך ${mediumPlusRebuyNights.length} ערבי 3+ ריבאיים`;
    } else if (twoPlusRebuyNights.length >= 2) {
      const pct = Math.round((twoPlusWins / twoPlusRebuyNights.length) * 100);
      comebackLabel = `שמר על 0–1 ריבאיים ב-${zeroOneRebuyNights.length} מתוך ${rebuyPoolTxt} · ברווח ב-${twoPlusWins} מתוך ${twoPlusRebuyNights.length} ערבי 2+ ריבאיים — ${pct}% הצלחה`;
    } else if (mediumPlusRebuyNights.length >= 1) {
      comebackLabel = `שמר על 0–2 ריבאיים ב-${lowRebuyNights.length} מתוך ${rebuyPoolTxt} · ברווח ב-${medPlusWins} מתוך ${mediumPlusRebuyNights.length} ערבי 3+ ריבאיים`;
    } else {
      comebackLabel = `שמר על 0–2 ריבאיים בכל ${rebuyPoolTxt} ללא ערבי 3+ ריבאיים`;
    }

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
      secondBestWin,
      secondWorstLoss,
      profitWithoutBest1,
      profitWithoutBest2,
      profitWithoutWorst1,
      profitWithoutWorst2,
      afterLossCount,
      bounceBackWins,
      bounceBackRate,
      avgProfitAfterLoss,
      maxWinStreak,
      maxLossStreak,
      rebuyComebackRate,
      medPlusComebackRate,
      twoPlusComebackRate,
      comebackLabel,
      zeroRebuyGames: zeroRebuyNights.length,
      zeroRebuyWins,
      zeroRebuyTotal,
      zeroOneRebuyGames: zeroOneRebuyNights.length,
      zeroOneWins,
      zeroOneTotal,
      zeroOneAvg,
      twoPlusGames: twoPlusRebuyNights.length,
      twoPlusWins,
      twoPlusTotal,
      twoPlusAvg,
      highRebuyGames: highRebuyNights.length,
      highRebuyWins,
      highRebuyTotal,
      lowRebuyGames: lowRebuyNights.length,
      lowRebuyTotal,
      lowRebuyAvg,
      medPlusGames: mediumPlusRebuyNights.length,
      medPlusWins,
      medPlusTotal,
      medPlusAvg,
      underFourGames: underFourRebuyNights.length,
      underFourTotal,
      underFourAvg,
      highRebuyAvg,
      highRebuyShare,
      medPlusRebuyShare,
      tableTopWins,
      tableBottomLosses,
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
    bounceBackMean: meanOf(baseStats.map(s => s.bounceBackRate)),
    bounceBackStd: stdDevOf(baseStats.map(s => s.bounceBackRate)),
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
    const zBigWin = zScore(s.bigWinRate, grp.bigWinRateMean, grp.bigWinRateStd);
    const zBigLoss = zScore(s.bigLossRate, grp.bigLossRateMean, grp.bigLossRateStd);
    const zBounceBack = zScore(s.bounceBackRate, grp.bounceBackMean, grp.bounceBackStd);

    // ─── Credible Rebuy-Centric Style & Archetype Classification (Anchored to Group Average Rebuys) ───
    const isProfitable = s.totalProfit > 0;
    const grpRebuyStr = grp.rebuyMean.toFixed(1);
    const playerRebuyStr = s.avgRebuys.toFixed(1);

    // Passive-bleed rebuyer detection: buys more rebuys than table average (`avgRebuys > grp.rebuyMean`),
    // yet doesn't build big winning pots (`bigWins === 0` or small `avgWinSize` relative to group).
    const isPassiveRebuyBleeder =
      rebuysTracked &&
      !isProfitable &&
      s.avgRebuys > grp.rebuyMean &&
      (s.bigWins === 0 || (s.bigWins === 1 && s.gamesPlayed >= 15)) &&
      s.avgWinSize < Math.max(95, grp.avgWinMean * 0.78);

    // Bipolar / Rollercoaster check within selected period: negative profit player who is profitable in 0–2 rebuys and crashes in 3+/4+ rebuys
    const isBipolarRollercoaster =
      rebuysTracked &&
      !isProfitable &&
      !isPassiveRebuyBleeder &&
      s.avgRebuys > grp.rebuyMean &&
      s.lowRebuyGames >= 2 &&
      s.lowRebuyTotal > 30 &&
      s.medPlusGames >= 2 &&
      s.medPlusTotal < -60;

    const halfDelta = s.secondHalfAvg - s.firstHalfAvg;
    const hasSecondHalfSurge = s.gamesPlayed >= 6 && halfDelta >= 45 && s.secondHalfAvg > 0;

    // ─── X-Axis Volatility & Aggression Score (0..100, with 50 = Group Rebuy & Action Average) ───
    // Crucial principle: Losing money (`downsideDev`, `bigLosses`) NEVER makes a player "aggressive".
    // When rebuys are tracked, X-axis is 80% driven by rebuys relative to the group average (`grp.rebuyMean`)
    // and 20% by offensive big-pot action (`upStd` / `avgAbsSwing`), with 50 anchored to `grp.rebuyMean`.
    let volatility = 50;
    if (rebuysTracked && s.trackedRebuyGames > 0) {
      const rebuyDiff = s.avgRebuys - grp.rebuyMean;
      const highShareDiff = s.highRebuyShare - grp.highRebuyShareMean;
      const rebuyComponent = 50 + rebuyDiff * 15.5 + highShareDiff * 24;

      // Secondary offensive action component (only boosts players who actually buy above-average rebuys AND play big pots)
      const swingVsGroup = grp.stdDevMean > 0 ? (s.avgAbsSwing - grp.stdDevMean * 0.8) / Math.max(40, grp.stdDevMean) : 0;
      const actionBonus =
        rebuyDiff >= 0
          ? Math.max(-4, Math.min(10, swingVsGroup * 9 + (s.bigWins >= 3 ? 3 : isPassiveRebuyBleeder ? -3 : 0)))
          : Math.min(0, swingVsGroup * 4);

      volatility = Math.round(Math.max(12, Math.min(95, rebuyComponent + actionBonus)));

      // Strict alignment with the group average rebuy dividing line (`grp.rebuyMean`)
      if (s.avgRebuys < grp.rebuyMean - 0.05 && volatility >= 49) {
        volatility = Math.min(47, Math.round(46 - (grp.rebuyMean - s.avgRebuys) * 8));
      } else if (s.avgRebuys > grp.rebuyMean + 0.05 && volatility <= 51) {
        volatility = Math.max(53, Math.round(52 + (s.avgRebuys - grp.rebuyMean) * 8));
      }
    } else {
      // Historical periods without rebuy tracking: use overall swing size & upside pot size (never penalizing losses alone)
      const zSwing = zScore(s.avgAbsSwing, meanOf(baseStats.map(b => b.avgAbsSwing)), stdDevOf(baseStats.map(b => b.avgAbsSwing)));
      const isLowRiskWinner = isProfitable && s.bigLosses <= 1 && s.downsideDev < grp.downStdMean * 0.85;
      const rawZ = isLowRiskWinner ? Math.min(-0.35, zSwing * 0.3) : 0.65 * zSwing + 0.35 * zUpStd;
      volatility = zToScore(rawZ, 18, 88);
    }

    const isClassifiedSolid = volatility < 50;
    const isClassifiedAggressive = !isClassifiedSolid;

    let emoji = '🎯';
    let title = '';

    if (isProfitable) {
      if (profitRank === 1 && s.winRate >= 68 && isClassifiedSolid) {
        emoji = '👑';
        title = 'השליט המחושב של השולחן';
      } else if (isClassifiedSolid && s.avgRebuys <= 1.5 && rebuysTracked) {
        emoji = '🎯';
        title = 'אלוף המשחק בכניסה בודדת';
      } else if (isClassifiedSolid && s.winRate >= 70 && s.bigWins >= 3) {
        emoji = '🎯';
        title = 'הצלף הקטלני של השולחן';
      } else if (isClassifiedSolid && s.bigLosses === 0 && s.gamesPlayed >= 6) {
        emoji = '🪨';
        title = 'הסלע היציב ללא נפילות';
      } else if (isClassifiedSolid && hasSecondHalfSurge) {
        emoji = '🚀';
        title = 'הצלף שבמומנטום עלייה';
      } else if (isClassifiedSolid && s.payoffRatio >= 1.25 && s.bigWins >= s.bigLosses + 1) {
        emoji = '🎯';
        title = 'הצלף היעיל של השולחן';
      } else if (isClassifiedSolid) {
        emoji = '⚖️';
        title = 'הטקטיקן המאוזן של השולחן';
      } else if (s.avgRebuys >= grp.rebuyMean + 0.5 || s.bigWins >= 3) {
        emoji = '🦈';
        title = 'כריש הקופות והאקשן';
      } else {
        emoji = s.gamesPlayed >= 100 ? '🔥' : '⚡';
        title = s.gamesPlayed >= 100 ? 'מרתוניסט האקשן הדו-כיווני' : 'שחקן הקופות הדו-כיווני';
      }
    } else {
      if (isClassifiedAggressive) {
        if (isPassiveRebuyBleeder) {
          emoji = '📉';
          title = 'ריבאיים משחיקה ללא קופות ענק';
        } else if (s.avgRebuys >= grp.rebuyMean + 1.5 || (rebuyRank === totalPlayersInGroup && s.avgRebuys >= 4.2)) {
          emoji = '🎰';
          title = 'שיאן הריבאיים והאקשן';
        } else if (isBipolarRollercoaster) {
          emoji = '🎢';
          title = s.highRebuyGames >= 5 ? 'רכבת הרים בערבי 4+ ריבאיים' : 'מצוין ברגוע ונשחק בריבאיים';
        } else if (s.winsCount <= 2 && s.gamesPlayed >= 5) {
          emoji = '📉';
          title = 'קניות מעל הממוצע מול מיעוט ניצחונות';
        } else {
          emoji = '🔥';
          title = 'אקשן גבוה ושחיקה בערבי ריבאיים';
        }
      } else {
        if (s.winsCount > 0 && s.avgWinSize >= Math.abs(s.avgLossSize) * 0.90 && s.winRate <= 42) {
          emoji = '🏹';
          title = 'משמעת קניות בתקופת יובש';
        } else if (s.bigWins === 0 && s.avgWinSize < 95) {
          emoji = '🔒';
          title = 'שמרן מבוקר עם תקרת זכייה נמוכה';
        } else {
          emoji = '🛡️';
          title = 'מבוקר בקניות שמחפש התפוצצות';
        }
      }
    }

    // Crisp quadrant badge that matches the 4-Quadrant Map and distinguishes passive chip-bleed rebuyers from true aggressive players
    const styleBadge =
      isProfitable && volatility < 50
        ? 'מרוויח וסולידי'
        : isProfitable
          ? 'מרוויח ואגרסיבי'
          : volatility < 50
            ? 'מופסד וסולידי'
            : isPassiveRebuyBleeder
              ? 'מופסד · עתיר ריבאיים'
              : 'מופסד ואגרסיבי';

    // ─── 5 Period-Responsive Radar Axes (0..100) ───
    const radarWinRate = Math.round(Math.max(5, Math.min(98, s.winRate)));

    const zInstability = rebuysTracked
      ? 0.35 * zDownStd + 0.20 * zBigLoss + 0.45 * zRebuy
      : 0.60 * zDownStd + 0.40 * zBigLoss;
    const rebuyDisciplineDomain = Math.max(10, Math.min(98, 100 - s.avgRebuys * 15.5));
    const downsideControlDomain = Math.max(10, Math.min(98, 100 - (s.downsideDev / Math.max(110, bigSwingThreshold)) * 52));
    const bigLossAvoidDomain = Math.max(10, Math.min(98, 100 - s.bigLossRate * 135));
    const domainConsistency =
      rebuysTracked && s.trackedRebuyGames > 0
        ? 0.50 * rebuyDisciplineDomain + 0.30 * downsideControlDomain + 0.20 * bigLossAvoidDomain
        : 0.65 * downsideControlDomain + 0.35 * bigLossAvoidDomain;
    const radarConsistency = Math.round(
      Math.max(12, Math.min(96, 0.60 * domainConsistency + 0.40 * zToScore(-zInstability, 15, 95)))
    );

    const zUpsideComposite = 0.35 * zAvgWin + 0.25 * zUpStd + 0.25 * zBigWin + 0.15 * zPayoff;
    const winSizeDomain = Math.min(96, (s.avgWinSize / Math.max(120, bigSwingThreshold)) * 62);
    const bigWinDomain = Math.min(96, s.bigWinRate * 165);
    const upStdDomain = Math.min(96, (s.upStd / Math.max(110, bigSwingThreshold)) * 65);
    const domainUpside = 0.40 * winSizeDomain + 0.30 * bigWinDomain + 0.30 * upStdDomain;
    const radarUpside =
      s.winsCount === 0
        ? 10
        : Math.round(Math.max(12, Math.min(96, 0.60 * domainUpside + 0.40 * zToScore(zUpsideComposite, 15, 95))));

    // Axis 4: Comeback in the selected period
    let radarComeback = 45;
    if (rebuysTracked && s.trackedRebuyGames > 0) {
      if (s.rebuyComebackRate !== null && s.highRebuyGames >= 3 && (s.highRebuyShare >= 0.18 || s.avgRebuys >= 2.5)) {
        const volumeFactor = Math.min(1.15, Math.max(0.75, s.avgRebuys / Math.max(1.5, grp.rebuyMean)));
        radarComeback = Math.round(Math.max(16, Math.min(95, (18 + s.rebuyComebackRate * 0.95) * volumeFactor)));
      } else if (s.medPlusComebackRate !== null && s.medPlusGames >= 4) {
        radarComeback = Math.round(Math.max(18, Math.min(92, 22 + s.medPlusComebackRate * 0.92)));
      } else if (s.twoPlusComebackRate !== null && s.twoPlusGames >= 2) {
        const bounceBonus = s.afterLossCount >= 2 ? (s.bounceBackRate - 50) * 0.18 : 0;
        radarComeback = Math.round(Math.max(24, Math.min(92, 24 + s.twoPlusComebackRate * 0.85 + bounceBonus)));
      } else if (s.medPlusComebackRate !== null) {
        radarComeback = Math.round(Math.max(20, Math.min(90, 22 + s.medPlusComebackRate * 0.85)));
      } else {
        radarComeback = Math.round(45 + (s.winRate / 100) * 30);
      }
    } else {
      const domainBounce = Math.max(12, Math.min(96, s.bounceBackRate));
      radarComeback = Math.round(
        Math.max(12, Math.min(96, 0.60 * domainBounce + 0.40 * zToScore(zBounceBack, 15, 95)))
      );
    }

    // Axis 5: Action & Big Pots in the selected period
    const zActionComposite = rebuysTracked
      ? 0.30 * zStd +
        0.50 * zRebuy +
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
        ? 0.50 * rebuyActionDomain + 0.30 * stdActionDomain + 0.20 * swingRateDomain
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

    // ─── Poker-Native Character Summary (`description` — sharp scouting report connecting Map position, Rebuys vs Group Mean, and Pot Behavior) ───
    const bigWinsTxt = fmtFemCount(s.bigWins, 'זכייה גדולה', 'זכיות גדולות');
    const bigLossesTxt = fmtCount(s.bigLosses, 'הפסד כבד', 'הפסדים כבדים');
    const andBigLossesOnlyTxt =
      s.bigLosses === 0
        ? 'וללא אף הפסד כבד'
        : s.bigLosses === 1
          ? 'ועם הפסד כבד אחד בלבד'
          : `ועם ${s.bigLosses} הפסדים כבדים בלבד`;
    const winsTxt = fmtCount(s.winsCount, 'ניצחון', 'ניצחונות');
    const inWinsTxt = s.winsCount === 1 ? 'בניצחון בודד' : `ב-${s.winsCount} ניצחונות`;

    let description = '';
    if (!rebuysTracked || s.trackedRebuyGames === 0) {
      if (isProfitable && isClassifiedSolid) {
        description = `שולט בשולחן מהצד הסולידי של המפה — מנצח ב-${Math.round(s.winRate)}% מ-${s.gamesPlayed} המשחקים בתקופה עם רווח ממוצע של ${fmtSigned(s.avgWinSize)}₪ בערבי ניצחון מול הפסד מתון של ${fmtSigned(s.avgLossSize)}₪ בערבי הפסד ${andBigLossesOnlyTxt}.`;
      } else if (isProfitable) {
        description = `שחקן קופות גדולות מהצד האגרסיבי של המפה — רושם תנודות רחבות בין ${fmtSigned(s.worstLoss)}₪ ל-${fmtSigned(s.bestWin)}₪, אך ${bigWinsTxt} בממוצע של ${fmtSigned(s.avgWinSize)}₪ לניצחון מכסים בקלות על ערבי ההפסד שלו.`;
      } else if (isClassifiedSolid) {
        description = `משחק בסגנון מבוקר בצד השמאלי של המפה ונמנע מנפילות חריגות עם הפסד ממוצע מתון של ${fmtSigned(s.avgLossSize)}₪, אך ${winsTxt} בלבד מתוך ${s.gamesPlayed} משחקים משאירים את המאזן התקופתי שלו מתחת לקו ה-0₪.`;
      } else {
        description = `מעורב בערבים סוערים בצד הימני של המפה — למרות שבערבי ניצחון הוא גורף ${fmtSigned(s.avgWinSize)}₪ בממוצע, ${bigLossesTxt} עד שפל של ${fmtSigned(s.worstLoss)}₪ ב-${s.gamesPlayed} משחקים משכו את המאזן שלו למטה.`;
      }
    } else if (isProfitable && isClassifiedSolid) {
      if (s.avgRebuys <= 1.5 && profitRank === 1) {
        description = `משחק בסגנון הקרוב ביותר לפריזאאוט בשולחן — בזמן שהממוצע הקבוצתי עומד על ${grpRebuyStr} ריבאיים לערב, הוא מסתפק ב-${playerRebuyStr} בלבד, מנצח ב-${Math.round(s.winRate)}% מהמשחקים ופותח פער בפסגה בזכות ${bigWinsTxt} עד שיא של ${fmtSigned(s.bestWin)}₪ ${andBigLossesOnlyTxt}.`;
      } else if (s.winRate >= 70 && s.bigWins >= 3) {
        description = `משלב משמעת קניות של ${playerRebuyStr} ריבאיים למשחק מול ${grpRebuyStr} בשולחן עם יכולת סגירת ערבים קטלנית — ניצח ב-${s.winsCount} מתוך ${s.gamesPlayed} משחקים בתקופה, רשם ${bigWinsTxt} עד ${fmtSigned(s.bestWin)}₪ ${andBigLossesOnlyTxt}.`;
      } else if (s.bigLosses === 0 && s.gamesPlayed >= 6) {
        description = `השחקן הבטוח ביותר בשולחן נגד התרסקויות — שומר על קצב של ${playerRebuyStr} ריבאיים למשחק לעומת ${grpRebuyStr} בממוצע הקבוצתי, עבר ${s.gamesPlayed} משחקים שלמים בלי אף הפסד כבד ועצר את הערב הגרוע ביותר שלו ב-${fmtSigned(s.worstLoss)}₪ בלבד.`;
      } else if (s.avgWinSize >= Math.abs(s.avgLossSize)) {
        description = `מייצר רווחיות שקטה בצד הסולידי של המפה עם ${playerRebuyStr} ריבאיים למשחק לעומת ${grpRebuyStr} בשולחן — כשהוא מנצח הוא גורף ${fmtSigned(s.avgWinSize)}₪ בממוצע מול ${fmtSigned(s.avgLossSize)}₪ בלבד בערבי הפסד.`;
      } else {
        description = `מייצר רווחיות עקבית בצד הסולידי של המפה עם ${playerRebuyStr} ריבאיים למשחק לעומת ${grpRebuyStr} בשולחן — שומר על ${Math.round(s.winRate)}% ניצחונות ב-${s.gamesPlayed} משחקים שמחזיקים אותו בפלוס מצטבר של ${fmtSigned(s.totalProfit)}₪.`;
      }
    } else if (isProfitable) {
      // Top-Right Quadrant: Profitable & Aggressive (above-average rebuys)
      if (s.avgRebuys >= grp.rebuyMean + 0.5) {
        description = `חי על קופות ענק בצד האגרסיבי של המפה — קונה ${playerRebuyStr} ריבאיים בממוצע לערב לעומת ${grpRebuyStr} בשולחן ומוכן לספוג ערבים קשים כדי לתפוס את ערבי ההתפוצצות שלו, שבהם הוא גורף ${fmtSigned(s.avgWinSize)}₪ בממוצע לניצחון ועד שיא של ${fmtSigned(s.bestWin)}₪.`;
      } else {
        description = `מנהל משחק דו-כיווני פעיל מימין לקו האמצע עם ${playerRebuyStr} ריבאיים למשחק מול ${grpRebuyStr} בשולחן — למרות ${bigLossesTxt} בתקופה, ${bigWinsTxt} ושיא של ${fmtSigned(s.bestWin)}₪ משאירים אותו בטריטוריה הירוקה.`;
      }
    } else if (isClassifiedSolid) {
      // Bottom-Left Quadrant: Negative & Solid (below-average rebuys)
      if (s.winsCount > 0 && s.avgWinSize >= Math.abs(s.avgLossSize) * 0.90) {
        description = `נמצא בצד הסולידי של המפה בזכות משמעת קניות של ${playerRebuyStr} ריבאיים למשחק לעומת ${grpRebuyStr} בשולחן — בערבי ניצחון הוא מרוויח יפה עם ${fmtSigned(s.avgWinSize)}₪ בממוצע, כך שהמינוס התקופתי נובע מבצורת של ${winsTxt} בלבד ב-${s.gamesPlayed} משחקים ולא מהתפרעויות.`;
      } else {
        description = `שומר על שליטה בקניות עם ${playerRebuyStr} ריבאיים למשחק מול ${grpRebuyStr} בממוצע השולחן ונמנע מערבי קצה פרועים, אך רווח ממוצע צנוע של ${fmtSigned(s.avgWinSize)}₪ ${inWinsTxt} מתקשה לכסות על הפסד ממוצע של ${fmtSigned(s.avgLossSize)}₪ בערבים שלילים.`;
      }
    } else {
      // Bottom-Right Quadrant: Negative & Above-Average Rebuys
      if (isPassiveRebuyBleeder) {
        description = `המיקום שלו בצד הימני של המפה נובע מ-${playerRebuyStr} ריבאיים למשחק לעומת ${grpRebuyStr} בשולחן, אך לא מאגרסיביות — הוא כמעט לא בונה קופות ענק, וגם ${inWinsTxt} מתוך ${s.gamesPlayed} משחקים הסתפק ב-${fmtSigned(s.avgWinSize)}₪ בממוצע, כך שהקניות החוזרות משקפות שחיקה הדרגתית וניסיון להישאר במשחק.`;
      } else if (isBipolarRollercoaster) {
        description = `שחקן של שני קצוות — יודע לדרוס את השולחן עם זכיות של עד ${fmtSigned(s.bestWin)}₪ כשמשחק מבוקר, אך חוצה את ממוצע הקניות הקבוצתי עם ${playerRebuyStr} ריבאיים מול ${grpRebuyStr} בשולחן בגלל ${s.highRebuyGames} ערבים שבהם נגרר ל-4+ ריבאיים עד שיא של ${s.maxRebuys} כניסות.`;
      } else if (s.avgRebuys >= grp.rebuyMean + 1.5) {
        description = `מוביל את קצב הקניות בשולחן עם ${playerRebuyStr} ריבאיים למשחק לעומת ${grpRebuyStr} בממוצע הקבוצתי ועד שיא של ${s.maxRebuys} כניסות בערב — סגנון עתיר אש שמייצר בורות עמוקים מדי לסגירה בערב אחד.`;
      } else {
        description = `משחק בקצב קניות גבוה מהשולחן עם ${playerRebuyStr} ריבאיים למשחק לעומת ${grpRebuyStr} בממוצע הקבוצתי — למרות שרשם ${inWinsTxt} רווח ממוצע של ${fmtSigned(s.avgWinSize)}₪, הערבים שבהם נגרר לריבאיים מרובים ו-${bigLossesTxt} משכו את המאזן שלו מתחת לקו ה-0₪.`;
      }
    }

    const traits: string[] = [];

    return {
      playerId: s.player.id,
      playerName: s.player.name,
      playerType: (s.player.type || 'permanent') as 'permanent' | 'permanent_guest' | 'guest',
      color: getPlayerColor(s.player.id),
      profitRank,
      rebuyRank,
      totalPlayersInGroup,
      gamesPlayed: s.gamesPlayed,
      winsCount: s.winsCount,
      lossesCount: s.lossesCount,
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

  const groupAvgRadar = {
    winRate: Math.round(grp.winRateMean),
    consistency: avgOf('consistency'),
    upside: avgOf('upside'),
    comeback: avgOf('comeback'),
    action: avgOf('action'),
  };

  const baseStatsById = new Map(baseStats.map(b => [b.player.id, b]));

  // ─── Dynamic 16-Lens Ranked Insight Engine: Selects the Top 3 Most Distinctive, Non-Overlapping Insights Per Player ───
  interface CandidateInsight {
    topic:
      | 'rebuy_split'
      | 'outlier_test'
      | 'table_dominance'
      | 'fortress'
      | 'sizing_vs_frequency'
      | 'mental_resilience'
      | 'trajectory'
      | 'extreme_swings';
    lensId: string;
    score: number;
    text: string;
  }

  const lensUsageCount = new Map<string, number>();

  for (const p of profiles) {
    const s = baseStatsById.get(p.playerId);
    if (!s) continue;

    const isProfitable = p.totalProfit > 0;
    const winCoversLosses =
      s.avgLossSize < 0 ? (s.avgWinSize / Math.abs(s.avgLossSize)).toFixed(1) : '2.0';
    const lossRequiresWins =
      s.avgWinSize > 0 ? (Math.abs(s.avgLossSize) / s.avgWinSize).toFixed(1) : '2.0';

    const topTwoStr =
      Math.round(s.bestWin) === Math.round(s.secondBestWin)
        ? `פעמיים ${fmtSigned(s.bestWin)}₪`
        : `${fmtSigned(s.bestWin)}₪ ו-${fmtSigned(s.secondBestWin)}₪`;

    const bottomTwoStr =
      Math.round(s.worstLoss) === Math.round(s.secondWorstLoss)
        ? `פעמיים ${fmtSigned(s.worstLoss)}₪`
        : `${fmtSigned(s.worstLoss)}₪ ו-${fmtSigned(s.secondWorstLoss)}₪`;

    const candidates: CandidateInsight[] = [];

    // ─── TOPIC 1: REBUY_SPLIT (At most ONE rebuy-regime insight per player) ───

    // Lens 1A: Freezeout / Single-Bullet Master (Ultra-low rebuy sniper)
    if (
      rebuysTracked &&
      s.trackedRebuyGames >= 4 &&
      s.avgRebuys <= 1.65 &&
      s.zeroOneRebuyGames >= Math.ceil(s.trackedRebuyGames * 0.55) &&
      s.zeroOneAvg !== null
    ) {
      const zOneSharePct = Math.round((s.zeroOneRebuyGames / s.trackedRebuyGames) * 100);
      const zOneWinPct = Math.round((s.zeroOneWins / s.zeroOneRebuyGames) * 100);
      const zeroBulletNote =
        s.zeroRebuyGames >= 3
          ? ` — כולל ${s.zeroRebuyGames} ערבים שלמים שבהם שיחק על הכניסה הראשונה בלבד ללא אף ריבאי`
          : '';
      const twoPlusTail =
        s.twoPlusGames >= 2 && s.twoPlusAvg !== null
          ? `, בעוד שב-${s.twoPlusGames} המשחקים שבהם נדרש ל-2+ ריבאיים המאזן שלו הוא ${fmtSigned(s.twoPlusTotal)}₪`
          : '';
      const trackedGamesNote =
        s.trackedRebuyGames === s.gamesPlayed
          ? `${s.trackedRebuyGames} משחקים בתקופה`
          : `${s.trackedRebuyGames} משחקים מתועדי ריבאיים`;
      candidates.push({
        topic: 'rebuy_split',
        lensId: 'freezeout_master',
        score: 97 + (1.6 - s.avgRebuys) * 15,
        text: `אלוף המשחק בכדור ראשון: ב-${s.zeroOneRebuyGames} מתוך ${trackedGamesNote} שהם ${zOneSharePct}% מהערבים הוא הסתפק ב-0–1 ריבאיים בלבד${zeroBulletNote}, ניצח ב-${zOneWinPct}% מהם וגרף בהם ${fmtSigned(s.zeroOneTotal)}₪ במצטבר${twoPlusTail}.`,
      });
    }

    // Lens 1B: Deep-Hole Escape Artist (High Comeback vertex on the Spider)
    if (
      rebuysTracked &&
      p.radar.comeback >= groupAvgRadar.comeback + 10 &&
      s.medPlusGames >= 4 &&
      s.medPlusWins >= 2
    ) {
      const pct = Math.round((s.medPlusWins / s.medPlusGames) * 100);
      const contrastTail =
        s.lowRebuyGames >= 2 && s.lowRebuyTotal > 100 && s.medPlusTotal < 0
          ? ` — אם כי את הכסף הגדול באמת שלו עשה ב-${s.lowRebuyGames} המשחקים הרגועים של עד 2 ריבאיים שבהם גרף ${fmtSigned(s.lowRebuyTotal)}₪`
          : s.medPlusTotal > 0
            ? ` ואף סיים את ערבי ה-3+ ריבאיים ברווח מצטבר מרשים של ${fmtSigned(s.medPlusTotal)}₪`
            : '';
      candidates.push({
        topic: 'rebuy_split',
        lensId: 'comeback_king',
        score: 91 + (p.radar.comeback - groupAvgRadar.comeback) * 0.25,
        text: `מומחה חילוץ מבורות: הבליטה החזקה בקודקוד הקאמבק בעכביש נובעת מהיכולת הנדירה שלו לחזור מפיגור — ב-${s.medPlusWins} מתוך ${s.medPlusGames} ערבים שבהם כבר נכנס ל-3+ ריבאיים הוא הצליח להפוך את הערב ולסיים בפלוס עם ${pct}% הצלחה${contrastTail}.`,
      });
    }

    // Lens 1C: The 4+ Rebuy Black Hole (When 4+ rebuy nights account for the damage)
    if (
      rebuysTracked &&
      s.highRebuyGames >= 3 &&
      s.highRebuyWins <= 1 &&
      s.highRebuyTotal <= -350 &&
      s.underFourGames >= 2 &&
      s.highRebuyAvg !== null &&
      s.underFourAvg !== null
    ) {
      const winZeroTxt =
        s.highRebuyWins === 0
          ? `לא הצליח לסיים ברווח אפילו פעם אחת מתוך ${s.highRebuyGames} ניסיונות`
          : `סיים ברווח רק פעם אחת מתוך ${s.highRebuyGames} ערבים`;
      const underFourTxt =
        s.underFourTotal >= 0
          ? `היה ברווח מצטבר של ${fmtSigned(s.underFourTotal)}₪ ובממוצע ${fmtSigned(s.underFourAvg)}₪ לערב`
          : `עמד על ממוצע מתון בהרבה של ${fmtSigned(s.underFourAvg)}₪ לערב`;
      candidates.push({
        topic: 'rebuy_split',
        lensId: 'black_hole_4plus',
        score: 88 + (s.highRebuyWins === 0 ? 5 : 0) + Math.min(5, s.highRebuyGames * 0.5),
        text: `מלכודת ערבי ה-4+ ריבאיים: כל הנזק התקופתי שלו מתנקז לערבים שבהם איבד שליטה על הקניות — בערבים של 4+ ריבאיים הוא ${winZeroTxt} ואיבד בהם ${fmtSigned(s.highRebuyTotal)}₪ במצטבר, בעוד שב-${s.underFourGames} המשחקים שבהם עצר מתחת ל-4 ריבאיים ${underFourTxt}.`,
      });
    }

    // Lens 1D: True Bipolar Rebuy Cliff (Only for players who genuinely split their games between profitable 0–2 rebuys and heavy 3+ rebuy losses)
    if (
      rebuysTracked &&
      s.lowRebuyGames >= 3 &&
      s.medPlusGames >= 4 &&
      s.medPlusRebuyShare >= 0.25 &&
      s.lowRebuyTotal >= 250 &&
      s.medPlusTotal <= -250 &&
      s.lowRebuyAvg !== null &&
      s.medPlusAvg !== null
    ) {
      const cliffTitle = isProfitable ? 'גבול הרווחיות בריבאי ה-3' : 'נקודת השבירה בריבאי ה-3';
      candidates.push({
        topic: 'rebuy_split',
        lensId: 'rebuy_cliff',
        score: 86 + Math.min(8, (Math.abs(s.lowRebuyAvg) + Math.abs(s.medPlusAvg)) / 30),
        text: `${cliffTitle}: כשעוצר בעד 2 ריבאיים הוא שחקן מנצח לכל דבר עם ${fmtSigned(s.lowRebuyTotal)}₪ במצטבר ב-${s.lowRebuyGames} משחקים ובממוצע ${fmtSigned(s.lowRebuyAvg)}₪ לערב, אך ב-${s.medPlusGames} הערבים שבהם חצה לריבאי השלישי המאזן שלו מתהפך להפסד מצטבר של ${fmtSigned(s.medPlusTotal)}₪ ובממוצע ${fmtSigned(s.medPlusAvg)}₪ לערב.`,
      });
    }

    // ─── TOPIC 2: OUTLIER_TEST (At most ONE peak/crash outlier test per player) ───

    // Lens 2A: Boom-or-Bust Outlier Dependency (Profitable ONLY thanks to 1 or 2 monster nights)
    if (isProfitable && s.gamesPlayed >= 5 && Math.round(s.profitWithoutBest2) < 0) {
      if (Math.round(s.profitWithoutBest1) < 0) {
        candidates.push({
          topic: 'outlier_test',
          lensId: 'single_boom_dependency',
          score: 95,
          text: `הכל על ערב התפוצצות אחד: המשיכה של העכביש לקודקודי גודל הזכיות והאקשן חושפת נתון דרמטי — כל הרווח התקופתי שלו נשען על ערב שיא בודד של ${fmtSigned(s.bestWin)}₪, שכן בשאר ${s.gamesPlayed - 1} המשחקים בתקופה יחד הוא למעשה במינוס מצטבר של ${fmtSigned(s.profitWithoutBest1)}₪.`,
        });
      } else {
        candidates.push({
          topic: 'outlier_test',
          lensId: 'two_boom_dependency',
          score: 93,
          text: `תלות מוחלטת בשני ערבי קצה: קודקודי האקשן וגודל הזכיות בעכביש מספרים את כל הסיפור — שני ערבי השיא שלו בתקופה של ${topTwoStr} הניבו יחד ${fmtSigned(s.bestWin + s.secondBestWin)}₪ ומחזיקים לבדם את המאזן החיובי, שכן בשאר ${s.gamesPlayed - 2} המשחקים יחד הוא במינוס מצטבר של ${fmtSigned(s.profitWithoutBest2)}₪.`,
        });
      }
    }

    // Lens 2B: Two Bad Nights Illusion (Negative overall ONLY because of 1 or 2 isolated crash nights)
    if (!isProfitable && s.gamesPlayed >= 5 && Math.round(s.profitWithoutWorst2) > 25) {
      if (Math.round(s.profitWithoutWorst1) > 15) {
        candidates.push({
          topic: 'outlier_test',
          lensId: 'single_crash_illusion',
          score: 95,
          text: `אשליית המינוס של ערב בודד: למרות שהוא מתחת לקו ה-0₪ בתקופה, ב-${s.gamesPlayed - 1} מתוך ${s.gamesPlayed} משחקיו הוא בכלל שחקן מרוויח עם ${fmtSigned(s.profitWithoutWorst1)}₪ במצטבר — וכל המינוס התקופתי שלו נובע מערב קריסה חריג אחד של ${fmtSigned(s.worstLoss)}₪.`,
        });
      } else {
        candidates.push({
          topic: 'outlier_test',
          lensId: 'two_crash_illusion',
          score: 93,
          text: `שחקן מרוויח שנפל בשני ערבים: המאזן השלילי שלו מטעה — ב-${s.gamesPlayed - 2} מתוך ${s.gamesPlayed} המשחקים בתקופה הוא שיחק פוקר מרוויח וצבר ${fmtSigned(s.profitWithoutWorst2)}₪, וכל הגירעון שלו נובע משתי מעידות בודדות של ${bottomTwoStr}.`,
        });
      }
    }

    // Lens 2C: Outlier-Proof Dominance (Still strongly profitable even after erasing his 2 best nights)
    if (isProfitable && s.gamesPlayed >= 6 && Math.round(s.profitWithoutBest2) >= 220 && s.secondBestWin >= 120) {
      candidates.push({
        topic: 'outlier_test',
        lensId: 'outlier_proof',
        score: 86 + Math.min(9, s.profitWithoutBest2 / 350),
        text: `רווחיות חסינת מזל: העוצמה המשולבת בקודקודי הנצחונות והיציבות בעכביש אינה תלויה בערב התפוצצות מקרי — גם אם מוחקים מהמאזן את שני ערבי השיא שלו בתקופה של ${topTwoStr}, הוא עדיין נשאר ברווח מצטבר של ${fmtSigned(s.profitWithoutBest2)}₪ ב-${s.gamesPlayed - 2} המשחקים הנותרים.`,
      });
    }

    // ─── TOPIC 3: TABLE_DOMINANCE (#1 Table Winner vs Table Ceiling Cap) ───

    // Lens 3A: Table Alpha Closer (#1 Top Winner of the entire table in a high share of nights)
    if (s.tableTopWins >= 2 && (s.tableTopWins / s.gamesPlayed >= 0.20 || (s.winsCount >= 3 && s.tableTopWins / s.winsCount >= 0.42))) {
      const shareOfWinsPct = Math.round((s.tableTopWins / Math.max(1, s.winsCount)) * 100);
      candidates.push({
        topic: 'table_dominance',
        lensId: 'table_alpha_closer',
        score: 87 + (s.tableTopWins / s.gamesPlayed) * 26,
        text: `קבלן הפסגות של השולחן: כשהוא תופס ערב חיובי הוא לא מסתפק ברווח קטן אלא לוקח את כל הקופה — ב-${s.tableTopWins} מתוך ${s.winsCount} הניצחונות שלו בתקופה שהם ${shareOfWinsPct}% מהניצחונות הוא סיים כמרוויח מספר 1 של כל השולחן באותו ערב, עם שיא של ${fmtSigned(s.bestWin)}₪.`,
      });
    } else if (!isProfitable && s.gamesPlayed >= 8 && s.tableTopWins === 0) {
      // Lens 3B: Never finished as #1 Top Winner of the night across 8+ games (explains low Upside vertex & passive ceiling)
      const bottomContrast =
        s.tableBottomLosses >= 2
          ? `, לעומת ${s.tableBottomLosses} ערבים שבהם סיים כמפסיד הגדול של השולחן`
          : '';
      candidates.push({
        topic: 'table_dominance',
        lensId: 'zero_table_top',
        score: 88 + Math.min(6, s.gamesPlayed / 4),
        text: `תקרת זכייה שלא פורצת את השולחן: בכל ${s.gamesPlayed} משחקיו בתקופה הוא לא סיים אפילו ערב אחד כמרוויח מספר 1 של השולחן כששיאו נעצר ב-${fmtSigned(s.bestWin)}₪${bottomContrast} — נתון שמסביר מדוע קודקוד גודל הזכיות שלו בעכביש נשאר מכווץ.`,
      });
    }

    // ─── TOPIC 4: FORTRESS / EXTREME_SWINGS (Floor Protection vs All-or-Nothing Action) ───

    // Lens 4A: Zero-Crash Shield (Only when NOT already used as the primary Map Summary, or phrased around never being the table's biggest loser)
    if (s.gamesPlayed >= 6 && s.tableBottomLosses === 0 && s.bigLosses <= 1) {
      const detailTxt =
        s.bigLosses === 0
          ? `לא סיים אפילו ערב אחד כמפסיד הגדול של השולחן ולא חצה אף פעם את רף ה-‎-${bigSwingThreshold}₪, עם הפסד ממוצע מתון של ${fmtSigned(s.avgLossSize)}₪ בלבד בערבים שליליים`
          : `לא סיים אפילו פעם אחת כמפסיד הגדול של השולחן לאורך כל ${s.gamesPlayed} המשחקים בתקופה`;
      candidates.push({
        topic: 'fortress',
        lensId: 'zero_table_bottom',
        score: 85 + (s.bigLosses === 0 ? 4 : 0),
        text: `חסינות מתחתית השולחן: קודקוד היציבות הגבוה שלו בעכביש מגובה בכך שב-${s.gamesPlayed} משחקים הוא ${detailTxt}.`,
      });
    }

    // Lens 4B: All-or-Nothing Table Extremist (High share of games are either ±bigSwingThreshold or #1/#last at the table)
    const extremeNights = s.bigWins + s.bigLosses;
    if (s.gamesPlayed >= 6 && extremeNights >= Math.ceil(s.gamesPlayed * 0.48) && p.radar.action >= 60) {
      const extremePct = Math.round((extremeNights / s.gamesPlayed) * 100);
      candidates.push({
        topic: 'extreme_swings',
        lensId: 'all_or_nothing_swings',
        score: 84 + (extremeNights / s.gamesPlayed) * 12,
        text: `שחקן ללא הילוך אמצעי: ב-${extremeNights} מתוך ${s.gamesPlayed} משחקיו בתקופה שהם ${extremePct}% מהערבים הוא סיים בתנודה חריגה של ±${bigSwingThreshold}₪ ומעלה עם ${s.bigWins} זכיות ענק מול ${s.bigLosses} הפסדים כבדים — כמעט ללא ערבים שקטים באמצע.`,
      });
    }

    // ─── TOPIC 5: SIZING_VS_FREQUENCY (Payoff Ratio Asymmetry vs Win-Rate Drought) ───

    if (s.winsCount >= 2 && s.lossesCount >= 2) {
      if (s.payoffRatio >= 1.42) {
        candidates.push({
          topic: 'sizing_vs_frequency',
          lensId: 'high_payoff_ratio',
          score: 84 + Math.min(10, (s.payoffRatio - 1.4) * 10),
          text: `מקסום רווחים וחיתוך הפסדים: בערבי ניצחון הוא גורף בממוצע ${fmtSigned(s.avgWinSize)}₪ לעומת הפסד ממוצע של ${fmtSigned(s.avgLossSize)}₪ בלבד בערבים שליליים — יחס כיסוי של ${winCoversLosses} שמאפשר לכל ניצחון בודד שלו למחוק כמעט שני ערבי הפסד.`,
        });
      } else if (s.payoffRatio <= 0.72 && !isProfitable) {
        candidates.push({
          topic: 'sizing_vs_frequency',
          lensId: 'low_payoff_trap',
          score: 87 + Math.min(10, (0.75 - s.payoffRatio) * 20),
          text: `מלכודת רווחים קטנים מול הפסדים כבדים: בערבי ניצחון הוא לוקח הביתה ${fmtSigned(s.avgWinSize)}₪ בלבד בממוצע לעומת ${fmtSigned(s.avgLossSize)}₪ בערבי הפסד — יחס שמחייב אותו לנצח ${lossRequiresWins} ערבים רק כדי למחוק הפסד ממוצע אחד.`,
        });
      } else if (!isProfitable && s.avgWinSize >= Math.abs(s.avgLossSize) * 0.94) {
        const sizingNote =
          s.avgWinSize > Math.abs(s.avgLossSize) * 1.05
            ? `מרוויח בערב ניצחון ממוצע של ${fmtSigned(s.avgWinSize)}₪ — יותר משהוא מפסיד בערב שלילי ממוצע של ${fmtSigned(s.avgLossSize)}₪`
            : `מרוויח בערב ניצחון ממוצע של ${fmtSigned(s.avgWinSize)}₪ שכמעט זהה להפסד ממוצע של ${fmtSigned(s.avgLossSize)}₪`;
        candidates.push({
          topic: 'sizing_vs_frequency',
          lensId: 'win_frequency_drought',
          score: 85,
          text: `בעיית תדירות ולא גודל קופות: בניגוד לרוב השחקנים שבמינוס, הוא ${sizingNote}, כך שהגירעון שלו בתקופה נובע כולו ממיעוט ערבים ירוקים עם ${s.winsCount} ניצחונות בלבד מול ${s.lossesCount} הפסדים.`,
        });
      }
    }

    // ─── TOPIC 6: MENTAL_RESILIENCE (Post-Loss Bounce-Back & Momentum Streaks) ───

    if (s.afterLossCount >= 3 && s.bounceBackWins === s.afterLossCount) {
      candidates.push({
        topic: 'mental_resilience',
        lensId: 'bounce_back_100',
        score: 92 + Math.min(6, s.afterLossCount),
        text: `חסינות מוחלטת מרצפי הפסדים: הוא מעולם לא חיבר שני הפסדים רצופים בתקופה — בכל ${s.afterLossCount} הפעמים שבהן סיים ערב במינוס הוא חזר לנצח מיד במשחק העוקב עם 100% התאוששות ובממוצע של ${fmtSigned(s.avgProfitAfterLoss)}₪ לערב.`,
      });
    } else if (s.afterLossCount >= 4 && s.bounceBackRate >= 65) {
      candidates.push({
        topic: 'mental_resilience',
        lensId: 'bounce_back_high',
        score: 84,
        text: `קפיץ מנטלי אחרי הפסד: במקום להיגרר לרצפים שליליים, ב-${s.bounceBackWins} מתוך ${s.afterLossCount} משחקים שהגיעו מיד אחרי ערב הפסד הוא חזר מיד לטור הניצחונות עם רווח ממוצע של ${fmtSigned(s.avgProfitAfterLoss)}₪ במשחק העוקב.`,
      });
    } else if (s.maxLossStreak >= 4 && s.afterLossCount >= 4 && s.bounceBackRate <= 35) {
      candidates.push({
        topic: 'mental_resilience',
        lensId: 'loss_streak_snowball',
        score: 85 + Math.min(6, s.maxLossStreak - 4),
        text: `אפקט כדור השלג בהפסדים: הקושי המרכזי שלו בתקופה הוא עצירת מומנטום שלילי — אחרי ערב הפסד הוא הצליח לחזור לנצח ב-${s.bounceBackWins} מתוך ${s.afterLossCount} ניסיונות בלבד ונקלע לרצף של ${s.maxLossStreak} הפסדים רצופים.`,
      });
    } else if (s.maxWinStreak >= 5) {
      candidates.push({
        topic: 'mental_resilience',
        lensId: 'win_streak_momentum',
        score: 83 + Math.min(6, s.maxWinStreak - 4),
        text: `שחקן מומנטום של רצפים: כשהביטחון שלו בשיא הוא כמעט בלתי ניתן לעצירה — בתקופה זו חיבר רצף של ${s.maxWinStreak} ניצחונות רצופים שבנו את עיקר המאזן שלו.`,
      });
    }

    // ─── TOPIC 7: TRAJECTORY (Mid-Season Gear Shift between 1st half and 2nd half) ───

    const halfDelta = s.secondHalfAvg - s.firstHalfAvg;
    const rebuyShift =
      rebuysTracked && s.firstHalfRebuys !== null && s.secondHalfRebuys !== null
        ? s.secondHalfRebuys - s.firstHalfRebuys
        : null;

    if (s.gamesPlayed >= 6 && rebuyShift !== null && Math.abs(rebuyShift) >= 0.65 && Math.abs(halfDelta) >= 35) {
      if (rebuyShift < 0 && halfDelta > 0) {
        candidates.push({
          topic: 'trajectory',
          lensId: 'tightened_gear_shift',
          score: 89 + Math.min(7, Math.abs(halfDelta) / 20),
          text: `הידוק חגורה שהפך את העונה: בחצי השני של התקופה הוא הוריד הילוך בקניות מ-${s.firstHalfRebuys!.toFixed(1)} ל-${s.secondHalfRebuys!.toFixed(1)} ריבאיים למשחק — והתוצאה המיידית הייתה קפיצה ממאזן ממוצע של ${fmtSigned(s.firstHalfAvg)}₪ בחצי הראשון ל-${fmtSigned(s.secondHalfAvg)}₪ למשחק בחצי השני.`,
        });
      } else if (rebuyShift > 0 && halfDelta < 0) {
        candidates.push({
          topic: 'trajectory',
          lensId: 'loosened_gear_shift',
          score: 88 + Math.min(7, Math.abs(halfDelta) / 20),
          text: `המחיר של שחרור הרסן בחצי השני: ב-${s.firstHalfCount} המשחקים הראשונים הוא שמר על ${s.firstHalfRebuys!.toFixed(1)} ריבאיים ועמד על ממוצע של ${fmtSigned(s.firstHalfAvg)}₪ למשחק, אך בחצי השני של התקופה עלה ל-${s.secondHalfRebuys!.toFixed(1)} ריבאיים לערב והממוצע שלו צנח בהתאם ל-${fmtSigned(s.secondHalfAvg)}₪.`,
        });
      } else {
        const dirTxt =
          halfDelta > 0
            ? `הממוצע שלו זינק מ-${fmtSigned(s.firstHalfAvg)}₪ בחצי הראשון ל-${fmtSigned(s.secondHalfAvg)}₪ בחצי השני`
            : `הממוצע שלו ירד מ-${fmtSigned(s.firstHalfAvg)}₪ בחצי הראשון ל-${fmtSigned(s.secondHalfAvg)}₪ בחצי השני`;
        candidates.push({
          topic: 'trajectory',
          lensId: 'rebuy_shift_other',
          score: 80,
          text: `שינוי קצב בין חצאי התקופה: קצב הקניות שלו השתנה מ-${s.firstHalfRebuys!.toFixed(1)} ריבאיים בחצי הראשון ל-${s.secondHalfRebuys!.toFixed(1)} בחצי השני, כשבמקביל ${dirTxt}.`,
        });
      }
    } else if (s.gamesPlayed >= 6 && Math.abs(halfDelta) >= 42) {
      const trendHeadline =
        s.firstHalfAvg < 0 && s.secondHalfAvg > 0
          ? `מהפך חיובי במחצית השנייה: אחרי פתיחה שלילית בממוצע של ${fmtSigned(s.firstHalfAvg)}₪ למשחק ב-${s.firstHalfCount} המשחקים הראשונים, הוא שינה מומנטום ורשם ממוצע של ${fmtSigned(s.secondHalfAvg)}₪ ב-${s.secondHalfCount} המשחקים האחרונים.`
          : s.firstHalfAvg > 0 && s.secondHalfAvg < 0
            ? `נסיגה במחצית השנייה: פתח את התקופה חזק עם ממוצע של ${fmtSigned(s.firstHalfAvg)}₪ ב-${s.firstHalfCount} המשחקים הראשונים, אך ב-${s.secondHalfCount} המשחקים האחרונים נחלש לממוצע של ${fmtSigned(s.secondHalfAvg)}₪ למשחק.`
            : halfDelta > 0
              ? `מגמת התחזקות מתמשכת: הקצב שלו השתפר משמעותית מ-${fmtSigned(s.firstHalfAvg)}₪ למשחק בחצי הראשון של התקופה ל-${fmtSigned(s.secondHalfAvg)}₪ בחצי השני.`
              : `התקררות בחצי השני של התקופה: אחרי ממוצע של ${fmtSigned(s.firstHalfAvg)}₪ בחצי הראשון, הקצב שלו התמתן ל-${fmtSigned(s.secondHalfAvg)}₪ ב-${s.secondHalfCount} המשחקים האחרונים.`;
      candidates.push({
        topic: 'trajectory',
        lensId: 'half_profit_trend',
        score: 82 + Math.min(6, Math.abs(halfDelta) / 25),
        text: trendHeadline,
      });
    }

    // Fallback candidates (respecting topic uniqueness) for sparse/short samples
    if (rebuysTracked && s.lowRebuyGames >= 1 && s.medPlusGames >= 1 && s.lowRebuyAvg !== null && s.medPlusAvg !== null) {
      candidates.push({
        topic: 'rebuy_split',
        lensId: 'fallback_rebuy_split',
        score: 65,
        text: `מאזן לפי כמות קניות: ${fmtInGamesWhere(s.lowRebuyGames)} שיחק עם 0–2 ריבאיים רשם מאזן מצטבר של ${fmtSigned(s.lowRebuyTotal)}₪ ובממוצע ${fmtSigned(s.lowRebuyAvg)}₪ לערב, לעומת ${fmtSigned(s.medPlusTotal)}₪ במצטבר ${fmtInNights(s.medPlusGames)} של 3+ ריבאיים.`,
      });
    }
    if (s.gamesPlayed >= 3) {
      candidates.push({
        topic: 'outlier_test',
        lensId: 'fallback_outlier',
        score: 60,
        text: `משקל ערב השיא בתקופה: ערב השיא שלו עמד על ${fmtSigned(s.bestWin)}₪ מול ערב שפל של ${fmtSigned(s.worstLoss)}₪, כשללא ערב השיא המאזן המצטבר שלו בשאר ${s.gamesPlayed - 1} המשחקים עומד על ${fmtSigned(s.profitWithoutBest1)}₪.`,
      });
    }
    candidates.push({
      topic: 'sizing_vs_frequency',
      lensId: 'fallback_sizing',
      score: 55,
      text: `יחס ניצחונות מול הפסדים: סיים ברווח ב-${s.winsCount} מתוך ${s.gamesPlayed} משחקים בתקופה עם רווח ממוצע של ${fmtSigned(s.avgWinSize)}₪ בערבי ניצחון לעומת ${fmtSigned(s.avgLossSize)}₪ בערבי הפסד.`,
    });
    candidates.push({
      topic: 'trajectory',
      lensId: 'fallback_trajectory',
      score: 50,
      text: `חלוקה בין חצאי התקופה: בחצי הראשון של התקופה רשם ממוצע של ${fmtSigned(s.firstHalfAvg)}₪ למשחק לעומת ${fmtSigned(s.secondHalfAvg)}₪ למשחק בחצי השני.`,
    });

    // Apply Period-Level Diversity Penalty so the same lensId isn't overused across every player in the group
    const scoredCandidates = candidates.map(c => {
      const priorUses = lensUsageCount.get(c.lensId) ?? 0;
      const diversityPenalty = priorUses === 0 ? 0 : priorUses === 1 ? 6 : priorUses === 2 ? 16 : 28;
      return {
        ...c,
        effectiveScore: c.score - diversityPenalty,
      };
    });

    scoredCandidates.sort((a, b) => b.effectiveScore - a.effectiveScore);
    const usedTopics = new Set<CandidateInsight['topic']>();
    for (const c of scoredCandidates) {
      if (p.traits.length >= 3) break;
      if (usedTopics.has(c.topic)) continue;
      usedTopics.add(c.topic);
      lensUsageCount.set(c.lensId, (lensUsageCount.get(c.lensId) ?? 0) + 1);
      p.traits.push(c.text);
    }
  }

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
    groupAvgRadar,
  };
}
