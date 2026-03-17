import { PlayerStats, MilestoneItem, MilestoneSentiment } from '../types';
import { formatHebrewHalf } from './calculations';

// ═══════════════════════════════════════════════════════════════════
// COMMON PLAYER SHAPE — adapts both PlayerStats and PlayerForecastData
// ═══════════════════════════════════════════════════════════════════

export interface MilestonePlayer {
  id: string;
  name: string;
  gamesPlayed: number;
  totalProfit: number;
  avgProfit: number;
  winCount: number;
  lossCount: number;
  winPercentage: number;
  currentStreak: number;
  longestWinStreak: number;
  longestLossStreak: number;
  biggestWin: number;
  biggestLoss: number;
  avgRebuysPerGame: number;
  totalRebuys: number;
  avgWin: number;
  avgLoss: number;
  gameHistory: { profit: number; date: string; gameId: string }[];
}

export interface MilestoneOptions {
  mode: 'tonight' | 'period';
  periodLabel?: string;
  isHistorical?: boolean;
  isLowData?: boolean;
  overallRankMap?: Map<string, number>;
  uniqueGamesInPeriod?: number;
}

// ═══════════════════════════════════════════════════════════════════
// ADAPTERS
// ═══════════════════════════════════════════════════════════════════

export function adaptPlayerStats(stats: PlayerStats): MilestonePlayer {
  return {
    id: stats.playerId,
    name: stats.playerName,
    gamesPlayed: stats.gamesPlayed,
    totalProfit: stats.totalProfit,
    avgProfit: stats.avgProfit,
    winCount: stats.winCount,
    lossCount: stats.lossCount,
    winPercentage: stats.winPercentage,
    currentStreak: stats.currentStreak,
    longestWinStreak: stats.longestWinStreak,
    longestLossStreak: stats.longestLossStreak,
    biggestWin: stats.biggestWin,
    biggestLoss: stats.biggestLoss,
    avgRebuysPerGame: stats.avgRebuysPerGame,
    totalRebuys: stats.totalRebuys,
    avgWin: stats.avgWin,
    avgLoss: stats.avgLoss,
    gameHistory: stats.lastGameResults,
  };
}

interface ForecastDataLike {
  name: string;
  gamesPlayed: number;
  totalProfit: number;
  avgProfit: number;
  winCount: number;
  lossCount: number;
  winPercentage: number;
  currentStreak: number;
  bestWin: number;
  worstLoss: number;
  gameHistory: { profit: number; date: string; gameId: string }[];
}

export function adaptForecastData(p: ForecastDataLike): MilestonePlayer {
  return {
    id: p.name,
    name: p.name,
    gamesPlayed: p.gamesPlayed,
    totalProfit: p.totalProfit,
    avgProfit: p.avgProfit,
    winCount: p.winCount,
    lossCount: p.lossCount,
    winPercentage: p.winPercentage,
    currentStreak: p.currentStreak,
    longestWinStreak: 0,
    longestLossStreak: 0,
    biggestWin: p.bestWin,
    biggestLoss: p.worstLoss,
    avgRebuysPerGame: 0,
    totalRebuys: 0,
    avgWin: 0,
    avgLoss: 0,
    gameHistory: p.gameHistory,
  };
}

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function parseGameDate(dateStr: string): Date {
  let parts = dateStr.split('/');
  if (parts.length >= 3) {
    const day = parseInt(parts[0]);
    const month = parseInt(parts[1]) - 1;
    let year = parseInt(parts[2]);
    if (year < 100) year += 2000;
    return new Date(year, month, day);
  }
  parts = dateStr.split('.');
  if (parts.length >= 3) {
    const day = parseInt(parts[0]);
    const month = parseInt(parts[1]) - 1;
    let year = parseInt(parts[2]);
    if (year < 100) year += 2000;
    return new Date(year, month, day);
  }
  return new Date(dateStr);
}

const fmt = (n: number): string => `${n >= 0 ? '+' : ''}${Math.round(n)}₪`;

const MONTH_NAMES = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

interface PeriodStats {
  player: MilestonePlayer;
  yearProfit: number;
  yearGames: number;
  halfProfit: number;
  halfGames: number;
  monthProfit: number;
  monthGames: number;
  last3Avg: number;
  last5Avg: number;
  lastGameProfit: number;
  stdDev: number;
}

function computePeriodStats(players: MilestonePlayer[]): { stats: PeriodStats[]; now: Date; currentYear: number; currentMonth: number; currentHalf: 1 | 2; halfStartMonth: number } {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const currentHalf: 1 | 2 = currentMonth < 6 ? 1 : 2;
  const halfStartMonth = currentHalf === 1 ? 0 : 6;

  const stats: PeriodStats[] = players.map(p => {
    const thisYearGames = p.gameHistory.filter(g => parseGameDate(g.date).getFullYear() === currentYear);
    const thisHalfGames = p.gameHistory.filter(g => {
      const d = parseGameDate(g.date);
      return d.getFullYear() === currentYear && d.getMonth() >= halfStartMonth && d.getMonth() < halfStartMonth + 6;
    });
    const thisMonthGames = p.gameHistory.filter(g => {
      const d = parseGameDate(g.date);
      return d.getFullYear() === currentYear && d.getMonth() === currentMonth;
    });
    const last5 = p.gameHistory.slice(0, 5);
    const last3 = p.gameHistory.slice(0, 3);

    const recent = p.gameHistory.slice(0, 10).map(g => g.profit);
    let stdDev = 0;
    if (recent.length >= 2) {
      const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
      stdDev = Math.sqrt(recent.reduce((s, v) => s + (v - mean) ** 2, 0) / recent.length);
    }

    return {
      player: p,
      yearProfit: thisYearGames.reduce((sum, g) => sum + g.profit, 0),
      yearGames: thisYearGames.length,
      halfProfit: thisHalfGames.reduce((sum, g) => sum + g.profit, 0),
      halfGames: thisHalfGames.length,
      monthProfit: thisMonthGames.reduce((sum, g) => sum + g.profit, 0),
      monthGames: thisMonthGames.length,
      last3Avg: last3.length > 0 ? last3.reduce((sum, g) => sum + g.profit, 0) / last3.length : 0,
      last5Avg: last5.length > 0 ? last5.reduce((sum, g) => sum + g.profit, 0) / last5.length : 0,
      lastGameProfit: p.gameHistory[0]?.profit || 0,
      stdDev,
    };
  });

  return { stats, now, currentYear, currentMonth, currentHalf, halfStartMonth };
}

// ═══════════════════════════════════════════════════════════════════
// HEAD-TO-HEAD DATA
// ═══════════════════════════════════════════════════════════════════

interface H2HRecord {
  a: string;
  b: string;
  aWins: number;
  bWins: number;
  sharedGames: number;
  aTotalProfit: number;
  bTotalProfit: number;
}

function computeH2H(players: MilestonePlayer[]): H2HRecord[] {
  const results: H2HRecord[] = [];
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const pA = players[i], pB = players[j];
      const aGameIds = new Set(pA.gameHistory.map(g => g.gameId));
      const sharedGameIds = pB.gameHistory.filter(g => aGameIds.has(g.gameId)).map(g => g.gameId);
      if (sharedGameIds.length < 2) continue;

      let aWins = 0, bWins = 0, aTotalProfit = 0, bTotalProfit = 0;
      for (const gid of sharedGameIds) {
        const aGame = pA.gameHistory.find(g => g.gameId === gid);
        const bGame = pB.gameHistory.find(g => g.gameId === gid);
        if (!aGame || !bGame) continue;
        if (aGame.profit > bGame.profit) aWins++;
        if (bGame.profit > aGame.profit) bWins++;
        aTotalProfit += aGame.profit;
        bTotalProfit += bGame.profit;
      }

      results.push({ a: pA.name, b: pB.name, aWins, bWins, sharedGames: sharedGameIds.length, aTotalProfit, bTotalProfit });
    }
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════
// GENERATOR FUNCTIONS
// ═══════════════════════════════════════════════════════════════════

function generateBattles(
  players: MilestonePlayer[],
  pStats: PeriodStats[],
  opts: MilestoneOptions,
  ctx: { currentYear: number; currentMonth: number; currentHalf: 1 | 2 }
): MilestoneItem[] {
  const items: MilestoneItem[] = [];
  const { isHistorical, periodLabel = '', overallRankMap } = opts;
  const sortedAllTime = [...players].sort((a, b) => b.totalProfit - a.totalProfit);
  const sortedYear = [...pStats].sort((a, b) => b.yearProfit - a.yearProfit);

  if (isHistorical) {
    if (sortedAllTime.length >= 2) {
      const leader = sortedAllTime[0];
      const second = sortedAllTime[1];
      const gap = Math.round(leader.totalProfit - second.totalProfit);
      items.push({
        emoji: '🏆', category: 'battle', sentiment: 'battle',
        title: `אלוף ${periodLabel}!`,
        description: gap <= 150
          ? `${leader.name} סיים במקום הראשון עם ${fmt(leader.totalProfit)}, בפער של ${gap}₪ בלבד מ-${second.name}! קרב צמוד עד הסוף.`
          : `${leader.name} סיים במקום הראשון עם ${fmt(leader.totalProfit)}${leader.gamesPlayed > 1 ? ` אחרי ${leader.gamesPlayed} משחקים` : ''}.`,
        priority: 98,
      });
    }
    return items;
  }

  // All-time ranking battles
  for (let i = 1; i < sortedAllTime.length && i <= 5; i++) {
    const above = sortedAllTime[i - 1];
    const below = sortedAllTime[i];
    const gap = Math.round(above.totalProfit - below.totalProfit);

    if (gap > 0 && gap <= 150) {
      const aboveRank = overallRankMap ? (overallRankMap.get(above.id) || i) : i;
      const belowRank = overallRankMap ? (overallRankMap.get(below.id) || i + 1) : i + 1;
      const rankDiff = belowRank - aboveRank;
      if (rankDiff > 3) continue;

      items.push({
        emoji: aboveRank <= 2 ? '👑' : '⚔️', category: 'battle', sentiment: 'battle',
        title: aboveRank <= 2 ? 'קרב על הכתר!' : `קרב על מקום ${aboveRank}`,
        description: opts.mode === 'tonight'
          ? `${below.name} (מקום ${belowRank}) רק ${gap}₪ מאחורי ${above.name} (מקום ${aboveRank}). נצחון גדול הפעם = עקיפה!`
          : `${below.name} (מקום ${belowRank}) יכול לעקוף את ${above.name} (מקום ${aboveRank}) עם ${gap}₪ בלבד.`,
        priority: 95 - i * 3,
      });
      break;
    }
  }

  // Close battles (gap <= 80, widened from 30)
  for (let i = 0; i < Math.min(sortedAllTime.length - 1, 6); i++) {
    const p1 = sortedAllTime[i];
    const p2 = sortedAllTime[i + 1];
    const gap = Math.abs(p1.totalProfit - p2.totalProfit);
    if (gap <= 80 && gap > 0) {
      const r1 = overallRankMap ? (overallRankMap.get(p1.id) || i + 1) : i + 1;
      const r2 = overallRankMap ? (overallRankMap.get(p2.id) || i + 2) : i + 2;
      if (Math.abs(r1 - r2) > 2) continue;
      if (items.some(it => it.description.includes(p1.name) && it.description.includes(p2.name))) continue;

      items.push({
        emoji: '⚔️', category: 'battle', sentiment: 'battle',
        title: 'קרב צמוד!',
        description: `${p1.name} (מקום ${r1}) ו${p2.name} (מקום ${r2}) בהפרש של ${Math.round(gap)}₪ בלבד. המשחק הבא יקבע!`,
        priority: 82 - i * 2,
      });
      break;
    }
  }

  // Exact tie
  for (let i = 0; i < sortedAllTime.length; i++) {
    for (let j = i + 1; j < sortedAllTime.length; j++) {
      if (Math.round(sortedAllTime[i].totalProfit) === Math.round(sortedAllTime[j].totalProfit) && sortedAllTime[i].totalProfit !== 0) {
        items.push({
          emoji: '🤝', category: 'battle', sentiment: 'battle',
          title: 'תיקו מושלם!',
          description: `${sortedAllTime[i].name} ו${sortedAllTime[j].name} בדיוק ${fmt(sortedAllTime[i].totalProfit)}! המשחק הבא יקבע מי למעלה.`,
          priority: 92,
        });
      }
    }
  }

  // Year table battle
  const yearBattles = sortedYear.filter(p => p.yearGames >= 3);
  if (yearBattles.length >= 2) {
    const [first, second] = yearBattles;
    const gap = Math.round(first.yearProfit - second.yearProfit);
    if (gap > 0 && gap <= 120) {
      items.push({
        emoji: '📅', category: 'battle', sentiment: 'battle',
        title: `מי יוביל את ${ctx.currentYear}?`,
        description: `${first.player.name} מוביל עם ${fmt(first.yearProfit)} | ${second.player.name} רודף עם ${fmt(second.yearProfit)} | פער: ${gap}₪`,
        priority: 88,
      });
    }
  }

  // Revenge match
  const losers = pStats.filter(p => p.lastGameProfit < -50 && p.player.gamesPlayed >= 5);
  const winners = pStats.filter(p => p.lastGameProfit > 50);
  if (losers.length > 0 && winners.length > 0) {
    const bigLoser = losers.sort((a, b) => a.lastGameProfit - b.lastGameProfit)[0];
    const bigWinner = winners.sort((a, b) => b.lastGameProfit - a.lastGameProfit)[0];
    if (bigLoser.player.name !== bigWinner.player.name) {
      items.push({
        emoji: '🔥', category: 'battle', sentiment: 'surprise',
        title: 'מפגש נקמה',
        description: `${bigLoser.player.name} (${fmt(bigLoser.lastGameProfit)} במשחק האחרון) נגד ${bigWinner.player.name} (${fmt(bigWinner.lastGameProfit)}). הפעם זה אישי.`,
        priority: 85,
      });
    }
  }

  return items;
}

function generateStreaks(
  players: MilestonePlayer[],
  _pStats: PeriodStats[],
  opts: MilestoneOptions,
): MilestoneItem[] {
  const items: MilestoneItem[] = [];
  const { isHistorical } = opts;

  const hotStreakers = players.filter(p => p.currentStreak >= 3).sort((a, b) => b.currentStreak - a.currentStreak);
  const coldStreakers = players.filter(p => p.currentStreak <= -3).sort((a, b) => a.currentStreak - b.currentStreak);

  if (hotStreakers.length > 0) {
    const h = hotStreakers[0];
    const unusualness = h.winPercentage > 0 ? h.currentStreak / (h.winPercentage / 100) : h.currentStreak;
    items.push({
      emoji: '🔥', category: 'streak', sentiment: 'positive',
      title: `${h.currentStreak} נצחונות רצופים`,
      description: isHistorical
        ? `${h.name} סיים ברצף מרשים של ${h.currentStreak} נצחונות רצופים!`
        : `${h.name} לא מפסיד! רצף של ${h.currentStreak} נצחונות. נצחון הפעם = ${h.currentStreak + 1} רצופים.`,
      priority: 90 + Math.round(unusualness),
    });
  }

  if (coldStreakers.length > 0) {
    const c = coldStreakers[0];
    items.push({
      emoji: '❄️', category: 'streak', sentiment: 'negative',
      title: `${Math.abs(c.currentStreak)} הפסדים רצופים`,
      description: isHistorical
        ? `${c.name} סיים ברצף של ${Math.abs(c.currentStreak)} הפסדים רצופים.`
        : `${c.name} ברצף שלילי. הפעם = הזדמנות לשבור את הקללה ולחזור לנצחונות!`,
      priority: 85 + Math.abs(c.currentStreak),
    });
  }

  // Fire vs ice
  if (hotStreakers.length > 0 && coldStreakers.length > 0 && hotStreakers[0].name !== coldStreakers[0].name) {
    const hot = hotStreakers[0];
    const cold = coldStreakers[0];
    items.push({
      emoji: '⚡', category: 'streak', sentiment: 'surprise',
      title: 'אש מול קרח',
      description: `${hot.name} (+${hot.currentStreak} רצופים) נגד ${cold.name} (${cold.currentStreak} רצופים). מי ישנה כיוון?`,
      priority: 82,
    });
  }

  // Streak record chase (only if not already showing the same player as hot streaker)
  if (!isHistorical) {
    const currentLong = players.find(p => p.currentStreak >= 4);
    if (currentLong && currentLong.longestWinStreak > 0) {
      const longestRecord = Math.max(...players.map(p => p.longestWinStreak).filter(v => v > 0), 0);
      if (longestRecord > 0 && currentLong.currentStreak < longestRecord) {
        const winsToBreak = longestRecord - currentLong.currentStreak + 1;
        if (winsToBreak <= 3 && (!hotStreakers.length || hotStreakers[0].name !== currentLong.name)) {
          items.push({
            emoji: '⚡', category: 'streak', sentiment: 'positive',
            title: 'רצף נצחונות חם!',
            description: `${currentLong.name} ברצף של ${currentLong.currentStreak} נצחונות! ${winsToBreak === 1 ? `נצחון נוסף ישבור את השיא של ${longestRecord}!` : `עוד ${winsToBreak} נצחונות ישברו את השיא!`}`,
            priority: 75,
          });
        }
      }
    }
  }

  return items;
}

function generateNumericGoals(
  players: MilestonePlayer[],
  pStats: PeriodStats[],
  opts: MilestoneOptions,
  ctx: { currentYear: number }
): MilestoneItem[] {
  const items: MilestoneItem[] = [];
  if (opts.isHistorical) return items;

  // Positive round numbers
  const roundNumbers = [500, 1000, 1500, 2000, 2500, 3000];
  const candidates = players
    .map(p => {
      for (const target of roundNumbers) {
        const dist = target - p.totalProfit;
        if (dist > 0 && dist <= 200) return { player: p, target, dist };
      }
      return null;
    })
    .filter(Boolean) as { player: MilestonePlayer; target: number; dist: number }[];

  if (candidates.length > 0) {
    const best = candidates.sort((a, b) => a.dist - b.dist)[0];
    items.push({
      emoji: '🎯', category: 'milestone', sentiment: 'positive',
      title: `יעד ${best.target.toLocaleString()}₪`,
      description: `${best.player.name} על ${fmt(best.player.totalProfit)}. עוד ${Math.round(best.dist)}₪ = חציית רף ${best.target.toLocaleString()}₪!`,
      priority: 78 + Math.round(best.target / 200),
    });
  }

  // Negative danger zones
  const negRounds = [500, 1000, 1500, 2000];
  const negCandidates = players
    .filter(p => p.totalProfit < 0)
    .map(p => {
      for (const target of negRounds) {
        const dist = p.totalProfit - (-target);
        if (dist > 0 && dist <= 200) return { player: p, target, dist };
      }
      return null;
    })
    .filter(Boolean) as { player: MilestonePlayer; target: number; dist: number }[];

  if (negCandidates.length > 0) {
    const worst = negCandidates.sort((a, b) => a.dist - b.dist)[0];
    items.push({
      emoji: '⚠️', category: 'milestone', sentiment: 'negative',
      title: `אזור סכנה: -${worst.target.toLocaleString()}₪`,
      description: `${worst.player.name} על ${fmt(worst.player.totalProfit)}. הפסד של ${Math.round(worst.dist)}₪ = ירידה ל-${worst.target.toLocaleString()}₪.`,
      priority: 73,
    });
  }

  // Games milestones (check distance 1-3)
  const gameMilestones = [10, 25, 50, 75, 100, 150, 200];
  for (const p of players) {
    for (const gm of gameMilestones) {
      const dist = gm - p.gamesPlayed;
      if (dist >= 1 && dist <= 3) {
        items.push({
          emoji: '🎮', category: 'milestone', sentiment: 'positive',
          title: dist === 1 ? `משחק מספר ${gm}` : `${dist} משחקים ל-${gm}!`,
          description: dist === 1
            ? `הפעם ${p.name} ישחק את המשחק ה-${gm} שלו! ממוצע עד כה: ${fmt(p.avgProfit)} למשחק.`
            : `${p.name} עוד ${dist} משחקים למשחק ה-${gm}! ממוצע עד כה: ${fmt(p.avgProfit)} למשחק.`,
          priority: 65 + gm / 5 + (3 - dist) * 5,
        });
        break;
      }
    }
  }

  // Win rate thresholds
  const winRateTargets = [50, 60, 70];
  for (const p of players.filter(pl => pl.gamesPlayed >= 8)) {
    for (const targetRate of winRateTargets) {
      const winsNeeded = Math.ceil((targetRate / 100) * (p.gamesPlayed + 1));
      if (p.winCount === winsNeeded - 1 && p.winPercentage < targetRate) {
        items.push({
          emoji: '🎯', category: 'milestone', sentiment: 'positive',
          title: `יעד ${targetRate}% נצחונות`,
          description: `${p.name} על ${Math.round(p.winPercentage)}%. נצחון הפעם = חציית ${targetRate}%!`,
          priority: 65,
        });
        break;
      }
    }
  }

  // Recovery to positive (year)
  const recoveryCandidate = pStats
    .filter(p => p.yearProfit < 0 && p.yearProfit > -150 && p.yearGames >= 2)
    .sort((a, b) => b.yearProfit - a.yearProfit)[0];
  if (recoveryCandidate) {
    items.push({
      emoji: '🔄', category: 'milestone', sentiment: 'positive',
      title: `חזרה לפלוס ${ctx.currentYear}`,
      description: `${recoveryCandidate.player.name} על ${fmt(recoveryCandidate.yearProfit)} השנה. פער של ${Math.round(Math.abs(recoveryCandidate.yearProfit))}₪ לסגירה לפלוס שנתי.`,
      priority: 75,
    });
  }

  return items;
}

function generateForm(
  _players: MilestonePlayer[],
  pStats: PeriodStats[],
  opts: MilestoneOptions,
  ctx: { currentYear: number }
): MilestoneItem[] {
  const items: MilestoneItem[] = [];
  if (opts.isHistorical) return items;

  // Overperforming
  const hotForm = pStats
    .filter(p => p.player.gamesPlayed >= 5 && p.player.gameHistory.length >= 3)
    .map(p => ({ ...p, formDiff: p.last3Avg - p.player.avgProfit }))
    .filter(p => p.formDiff > 40)
    .sort((a, b) => b.formDiff - a.formDiff)[0];

  if (hotForm) {
    items.push({
      emoji: '📈', category: 'form', sentiment: 'positive',
      title: `${hotForm.player.name} בפורם חם`,
      description: `ממוצע אחרון: ${fmt(hotForm.last3Avg)} למשחק (לעומת ${fmt(hotForm.player.avgProfit)} היסטורי). שיפור של ${Math.round(hotForm.formDiff)}₪!`,
      priority: 76,
    });
  }

  // Underperforming
  const coldForm = pStats
    .filter(p => p.player.gamesPlayed >= 5 && p.player.gameHistory.length >= 3 && p.player.avgProfit > 0)
    .map(p => ({ ...p, formDiff: p.last3Avg - p.player.avgProfit }))
    .filter(p => p.formDiff < -40)
    .sort((a, b) => a.formDiff - b.formDiff)[0];

  if (coldForm) {
    items.push({
      emoji: '📉', category: 'form', sentiment: 'negative',
      title: `${coldForm.player.name} מתחת לרמה`,
      description: `בדרך כלל ${fmt(coldForm.player.avgProfit)} למשחק, אבל לאחרונה ${fmt(coldForm.last3Avg)}. הסטטיסטיקה לטובתו - צפוי קאמבק.`,
      priority: 72,
    });
  }

  // Pattern break
  for (const ps of pStats) {
    const p = ps.player;
    if (p.gameHistory.length < 4) continue;
    const last4 = p.gameHistory.slice(0, 4);
    const last4Wins = last4.filter(g => g.profit > 0).length;
    const last4Losses = last4.filter(g => g.profit < 0).length;

    if (p.winPercentage >= 60 && last4Losses >= 3) {
      items.push({
        emoji: '🔄', category: 'form', sentiment: 'surprise',
        title: `${p.name} יוצא מהדפוס`,
        description: `${p.name} בדרך כלל מנצח (${Math.round(p.winPercentage)}% נצחונות), אבל ${last4Losses} הפסדים ב-4 המשחקים האחרונים. שינוי מגמה?`,
        priority: 70,
      });
    } else if (p.winPercentage <= 40 && last4Wins >= 3) {
      items.push({
        emoji: '🌟', category: 'form', sentiment: 'surprise',
        title: `${p.name} משנה את המגמה!`,
        description: `${p.name} בדרך כלל מתקשה (${Math.round(p.winPercentage)}% נצחונות), אבל ${last4Wins} נצחונות ב-4 אחרונים! הקאמבק שלו?`,
        priority: 73,
      });
    }
  }

  // Year vs all-time comparison
  for (const ps of pStats) {
    if (ps.yearGames >= 5 && ps.player.gamesPlayed >= 10) {
      const yearAvg = ps.yearProfit / ps.yearGames;
      const diff = yearAvg - ps.player.avgProfit;
      if (diff > 30) {
        items.push({
          emoji: '📈', category: 'form', sentiment: 'positive',
          title: `שנה חמה ל${ps.player.name}`,
          description: `ממוצע ב-${ctx.currentYear}: ${fmt(Math.round(yearAvg))} למשחק לעומת ${fmt(Math.round(ps.player.avgProfit))} היסטורי. השנה הכי טובה?`,
          priority: 68,
        });
      } else if (diff < -30) {
        items.push({
          emoji: '📉', category: 'form', sentiment: 'negative',
          title: `שנה קשה ל${ps.player.name}`,
          description: `ממוצע ב-${ctx.currentYear}: ${fmt(Math.round(yearAvg))} למשחק לעומת ${fmt(Math.round(ps.player.avgProfit))} היסטורי. מהפך הפעם?`,
          priority: 64,
        });
      }
    }
  }

  return items;
}

function generateDrama(
  players: MilestonePlayer[],
  pStats: PeriodStats[],
  opts: MilestoneOptions,
): MilestoneItem[] {
  const items: MilestoneItem[] = [];
  const sortedAllTime = [...players].sort((a, b) => b.totalProfit - a.totalProfit);

  // Underdog rising
  const bottomPlayers = sortedAllTime.slice(-2);
  const risingUnderdog = bottomPlayers.find(p => {
    const ps = pStats.find(s => s.player.name === p.name);
    return ps && ps.lastGameProfit > 50;
  });
  if (risingUnderdog) {
    const rank = sortedAllTime.findIndex(p => p.name === risingUnderdog.name) + 1;
    const ps = pStats.find(s => s.player.name === risingUnderdog.name)!;
    items.push({
      emoji: '💪', category: 'drama', sentiment: 'surprise',
      title: 'עלייה מהתחתית',
      description: opts.isHistorical
        ? `${risingUnderdog.name} (מקום ${rank}) ניצח ${fmt(ps.lastGameProfit)} במשחק האחרון.`
        : `${risingUnderdog.name} (מקום ${rank}) ניצח ${fmt(ps.lastGameProfit)} במשחק האחרון. התחלת מהפך?`,
      priority: 79,
    });
  }

  // Leader slipping
  if (sortedAllTime.length >= 2) {
    const leader = sortedAllTime[0];
    const second = sortedAllTime[1];
    const leaderPS = pStats.find(s => s.player.name === leader.name);
    if (leaderPS && leaderPS.lastGameProfit < -30) {
      const gap = Math.round(leader.totalProfit - second.totalProfit);
      items.push({
        emoji: '👀', category: 'drama', sentiment: 'surprise',
        title: 'המוביל בלחץ',
        description: `${leader.name} (מקום 1) הפסיד ${fmt(leaderPS.lastGameProfit)} במשחק האחרון. הפער מ${second.name}: ${gap}₪ בלבד.`,
        priority: 81,
      });
    }
  }

  // Upset potential
  const upsetCandidate = pStats
    .filter(p => p.player.gamesPlayed >= 5 && p.player.avgProfit < 0 && p.lastGameProfit > 30)
    .sort((a, b) => b.lastGameProfit - a.lastGameProfit)[0];
  if (upsetCandidate) {
    items.push({
      emoji: '🌟', category: 'drama', sentiment: 'surprise',
      title: `${upsetCandidate.player.name} בהפתעה`,
      description: `ממוצע היסטורי: ${fmt(upsetCandidate.player.avgProfit)} למשחק, אבל ניצח ${fmt(upsetCandidate.lastGameProfit)} לאחרונה. תחילת שינוי מגמה?`,
      priority: 77,
    });
  }

  // Volatility (std-dev based)
  const volatilePlayers = pStats
    .filter(p => p.player.gameHistory.length >= 4 && p.stdDev > 80)
    .sort((a, b) => b.stdDev - a.stdDev);
  if (volatilePlayers.length > 0) {
    const v = volatilePlayers[0];
    const last4 = v.player.gameHistory.slice(0, 4).map(g => g.profit);
    items.push({
      emoji: '🎢', category: 'drama', sentiment: 'surprise',
      title: 'הרים רוסיים',
      description: `${v.player.name} בתנודות (סטייה ${Math.round(v.stdDev)}₪): מ${fmt(Math.min(...last4))} עד ${fmt(Math.max(...last4))} ב-4 אחרונים. לאן הפעם?`,
      priority: 70,
    });
  }

  // Comeback king
  const comebackKing = players
    .filter(p => p.currentStreak <= -2 && p.totalProfit > 0)
    .sort((a, b) => a.currentStreak - b.currentStreak)[0];
  if (comebackKing) {
    items.push({
      emoji: '💪', category: 'drama', sentiment: 'positive',
      title: 'קאמבק קינג!',
      description: `${comebackKing.name} עם ${Math.abs(comebackKing.currentStreak)} הפסדים ברצף, אבל עדיין ${fmt(comebackKing.totalProfit)} כולל. זמן נקמה!`,
      priority: 69,
    });
  }

  // Bounce-back: lost big last game but positive average
  const bounceBack = pStats
    .filter(p => p.lastGameProfit < -100 && p.player.avgProfit > 0 && p.player.gamesPlayed >= 5)
    .sort((a, b) => a.lastGameProfit - b.lastGameProfit)[0];
  if (bounceBack && (!comebackKing || comebackKing.name !== bounceBack.player.name)) {
    items.push({
      emoji: '🔄', category: 'drama', sentiment: 'surprise',
      title: `${bounceBack.player.name} חוזר`,
      description: `הפסיד ${fmt(bounceBack.lastGameProfit)} במשחק האחרון אבל ממוצע היסטורי ${fmt(bounceBack.player.avgProfit)}. הסטטיסטיקה אומרת: קאמבק.`,
      priority: 71,
    });
  }

  return items;
}

function generateH2H(
  players: MilestonePlayer[],
  _pStats: PeriodStats[],
  opts: MilestoneOptions,
): MilestoneItem[] {
  const items: MilestoneItem[] = [];
  if (players.length < 2) return items;

  const h2hRecords = computeH2H(players);

  // Dominance (70%+ win rate)
  const dominance = h2hRecords
    .filter(h => h.sharedGames >= 4 && (h.aWins >= h.sharedGames * 0.7 || h.bWins >= h.sharedGames * 0.7))
    .sort((a, b) => Math.max(b.aWins, b.bWins) / b.sharedGames - Math.max(a.aWins, a.bWins) / a.sharedGames);

  if (dominance.length > 0) {
    const d = dominance[0];
    const winner = d.aWins > d.bWins ? d.a : d.b;
    const loser = d.aWins > d.bWins ? d.b : d.a;
    const wins = Math.max(d.aWins, d.bWins);
    items.push({
      emoji: '🥊', category: 'h2h', sentiment: 'surprise',
      title: `${winner} שולט`,
      description: opts.isHistorical
        ? `${winner} ניצח את ${loser} ב-${wins} מתוך ${d.sharedGames} משחקים משותפים.`
        : `${winner} ניצח את ${loser} ב-${wins} מתוך ${d.sharedGames} משחקים משותפים. ישנה את המגמה הפעם?`,
      priority: 78,
    });
  }

  // Close rivalry
  const rivalries = h2hRecords
    .filter(h => h.sharedGames >= 5 && Math.abs(h.aWins - h.bWins) <= 1)
    .sort((a, b) => b.sharedGames - a.sharedGames);

  if (rivalries.length > 0) {
    const r = rivalries[0];
    if (!items.some(it => it.description.includes(r.a) && it.description.includes(r.b))) {
      items.push({
        emoji: '⚔️', category: 'h2h', sentiment: 'battle',
        title: 'יריבות צמודה',
        description: `${r.a} ו${r.b} כמעט שווים - ${r.aWins}:${r.bWins} ב-${r.sharedGames} משחקים משותפים. הפעם שובר שוויון!`,
        priority: 76,
      });
    }
  }

  // Nemesis (money flow > 200)
  const nemesis = h2hRecords
    .filter(h => h.sharedGames >= 4 && Math.abs(h.aTotalProfit - h.bTotalProfit) >= 200)
    .sort((a, b) => Math.abs(b.aTotalProfit - b.bTotalProfit) - Math.abs(a.aTotalProfit - a.bTotalProfit));

  if (nemesis.length > 0) {
    const n = nemesis[0];
    const flow = n.aTotalProfit - n.bTotalProfit;
    const winner = flow > 0 ? n.a : n.b;
    const loser = flow > 0 ? n.b : n.a;
    if (!items.some(it => it.description.includes(winner) && it.description.includes(loser))) {
      items.push({
        emoji: '💸', category: 'h2h', sentiment: 'surprise',
        title: 'נמסיס',
        description: `${loser} הפסיד סה"כ ${Math.abs(Math.round(flow))}₪ ל${winner} לאורך ${n.sharedGames} משחקים משותפים.`,
        priority: 72,
      });
    }
  }

  return items;
}

function generateRecords(
  players: MilestonePlayer[],
  pStats: PeriodStats[],
  opts: MilestoneOptions,
): MilestoneItem[] {
  const items: MilestoneItem[] = [];
  if (players.length === 0) return items;

  // Biggest win record chase
  const biggestWin = Math.max(...players.map(p => p.biggestWin));
  const recordHolder = players.find(p => p.biggestWin === biggestWin);
  const recordChaser = players
    .filter(p => p !== recordHolder && p.currentStreak >= 2 && biggestWin - p.biggestWin <= 100)
    .sort((a, b) => b.currentStreak - a.currentStreak)[0];

  if (recordChaser && recordHolder) {
    items.push({
      emoji: '🏆', category: 'record', sentiment: 'positive',
      title: 'מרדף על השיא',
      description: `שיא הקבוצה: ${fmt(biggestWin)} (${recordHolder.name}). ${recordChaser.name} ברצף ${recordChaser.currentStreak}+ ויכול לשבור!`,
      priority: 74,
    });
  }

  // Biggest win record holder
  const winThreshold = opts.isLowData ? 100 : 200;
  if (recordHolder && recordHolder.biggestWin >= winThreshold) {
    items.push({
      emoji: '💰', category: 'record', sentiment: 'positive',
      title: 'שיא הנצחון הגדול!',
      description: opts.isHistorical
        ? `${recordHolder.name} עם שיא הנצחון הגדול - ${fmt(recordHolder.biggestWin)} בלילה אחד!`
        : `${recordHolder.name} מחזיק בשיא הנצחון הגדול עם ${fmt(recordHolder.biggestWin)} בלילה אחד. האם מישהו ישבור?`,
      priority: 60,
    });
  }

  // Biggest single swing in recent games
  if (pStats.length > 0) {
    let maxSwing = 0;
    let swingPlayer = '';
    let swingAmount = 0;
    for (const ps of pStats) {
      for (const g of ps.player.gameHistory.slice(0, 5)) {
        if (Math.abs(g.profit) > maxSwing) {
          maxSwing = Math.abs(g.profit);
          swingPlayer = ps.player.name;
          swingAmount = g.profit;
        }
      }
    }
    if (maxSwing >= 200) {
      items.push({
        emoji: '💥', category: 'record', sentiment: 'surprise',
        title: 'ערב דרמטי',
        description: `${swingPlayer} עם תוצאה של ${fmt(swingAmount)} בלילה אחד. אחד הלילות הכי דרמטיים!`,
        priority: 55,
      });
    }
  }

  return items;
}

function generateSeason(
  players: MilestonePlayer[],
  pStats: PeriodStats[],
  opts: MilestoneOptions,
  ctx: { currentYear: number; currentMonth: number; currentHalf: 1 | 2 }
): MilestoneItem[] {
  const items: MilestoneItem[] = [];
  if (opts.isHistorical) return items;

  const sortedMonth = [...pStats].sort((a, b) => b.monthProfit - a.monthProfit);
  const sortedYear = [...pStats].sort((a, b) => b.yearProfit - a.yearProfit);

  // Monthly leader battle
  if (sortedMonth[0]?.monthGames >= 2 && sortedMonth[1]?.monthGames >= 1) {
    const monthLeader = sortedMonth[0];
    const monthSecond = sortedMonth[1];
    const gap = Math.round(monthLeader.monthProfit - monthSecond.monthProfit);
    if (gap <= 100) {
      items.push({
        emoji: '📆', category: 'season', sentiment: 'battle',
        title: `שחקן ${MONTH_NAMES[ctx.currentMonth]}`,
        description: `${monthLeader.player.name} מוביל את ${MONTH_NAMES[ctx.currentMonth]} עם ${fmt(monthLeader.monthProfit)}. ${monthSecond.player.name} רודף ב-${gap}₪.`,
        priority: 68,
      });
    }
  }

  // Year-end special (December)
  if (ctx.currentMonth === 11) {
    const yearLeader = sortedYear[0];
    if (yearLeader && yearLeader.yearGames >= 5) {
      items.push({
        emoji: '🎄', category: 'season', sentiment: 'battle',
        title: `אלוף ${ctx.currentYear}?`,
        description: `${yearLeader.player.name} מוביל את ${ctx.currentYear} עם ${fmt(yearLeader.yearProfit)}. משחקי דצמבר קובעים!`,
        priority: 92,
      });
    }
  }

  // Fresh start (January)
  if (ctx.currentMonth === 0) {
    const totalYearGames = pStats.reduce((sum, p) => sum + p.yearGames, 0);
    if (totalYearGames <= 1) {
      items.push({
        emoji: '🎆', category: 'season', sentiment: 'positive',
        title: `${ctx.currentYear} מתחילה`,
        description: `שנה חדשה, טבלה חדשה. ${players.length} שחקנים מתחילים מחדש. מי יוביל ב-${ctx.currentYear}?`,
        priority: 85,
      });
    }
  }

  // Early year leader (Jan/Feb)
  if (ctx.currentMonth <= 1 && sortedYear[0]?.yearGames >= 2 && sortedYear[1]?.yearGames >= 1) {
    const yearLeader = sortedYear[0];
    const yearSecond = sortedYear[1];
    const gap = Math.round(yearLeader.yearProfit - yearSecond.yearProfit);
    if (gap > 0 && gap <= 200) {
      items.push({
        emoji: '📅', category: 'season', sentiment: 'battle',
        title: `מוביל ${ctx.currentYear}`,
        description: `${yearLeader.player.name} מוביל את ${ctx.currentYear} עם ${fmt(yearLeader.yearProfit)} ב-${yearLeader.yearGames} משחקים. ${yearSecond.player.name} רודף ב-${gap}₪.`,
        priority: 80,
      });
    }
  }

  // Half year recovery
  const halfName = formatHebrewHalf(ctx.currentHalf, ctx.currentYear);
  const halfRecovery = pStats
    .filter(p => p.halfProfit < 0 && p.halfProfit > -120 && p.halfGames >= 2)
    .sort((a, b) => b.halfProfit - a.halfProfit)[0];
  if (halfRecovery) {
    items.push({
      emoji: '🔄', category: 'season', sentiment: 'positive',
      title: `חזרה לפלוס ב${halfName}`,
      description: `${halfRecovery.player.name} על ${fmt(halfRecovery.halfProfit)} ב${halfName}. פער של ${Math.abs(Math.round(halfRecovery.halfProfit))}₪ לחצי שנה חיובי!`,
      priority: 66,
    });
  }

  // Monthly record chase
  for (const ps of pStats) {
    if (ps.monthGames >= 2) {
      const monthlyProfits: Record<string, number> = {};
      ps.player.gameHistory.forEach(g => {
        const d = parseGameDate(g.date);
        const key = `${d.getFullYear()}-${d.getMonth()}`;
        monthlyProfits[key] = (monthlyProfits[key] || 0) + g.profit;
      });
      const bestMonth = Math.max(...Object.values(monthlyProfits), 0);
      if (bestMonth > 0 && ps.monthProfit > bestMonth - 150 && ps.monthProfit < bestMonth) {
        const needed = bestMonth - ps.monthProfit + 1;
        items.push({
          emoji: '🏆', category: 'season', sentiment: 'positive',
          title: `שיא חודשי ל${ps.player.name}`,
          description: `${ps.player.name} על ${fmt(ps.monthProfit)} ב${MONTH_NAMES[ctx.currentMonth]}. עוד ${fmt(needed)} = החודש הכי טוב אי פעם!`,
          priority: 67,
        });
        break;
      }
    }
  }

  return items;
}

function generateRebuy(
  players: MilestonePlayer[],
  _pStats: PeriodStats[],
  opts: MilestoneOptions,
): MilestoneItem[] {
  const items: MilestoneItem[] = [];
  if (opts.mode !== 'period') return items;

  const rebuyPlayers = players.filter(p => p.avgRebuysPerGame > 0 && p.gamesPlayed >= 5);
  if (rebuyPlayers.length === 0) return items;

  const rebuyKing = rebuyPlayers.sort((a, b) => b.avgRebuysPerGame - a.avgRebuysPerGame)[0];
  if (rebuyKing.avgRebuysPerGame >= 1.5) {
    items.push({
      emoji: '💎', category: 'rebuy', sentiment: 'surprise',
      title: 'מלך הריבאי',
      description: `${rebuyKing.name} עם ממוצע ${rebuyKing.avgRebuysPerGame.toFixed(1)} ריבאיים למשחק - הכי הרבה בקבוצה!`,
      priority: 55,
    });
  }

  // Total rebuys milestone
  const rebuyMilestones = [50, 100, 150, 200];
  for (const p of players) {
    if (p.totalRebuys <= 0) continue;
    for (const rm of rebuyMilestones) {
      const dist = rm - p.totalRebuys;
      if (dist > 0 && dist <= 5) {
        items.push({
          emoji: '💎', category: 'rebuy', sentiment: 'surprise',
          title: `${rm} ריבאיים!`,
          description: `${p.name} עם ${p.totalRebuys} ריבאיים סה"כ. עוד ${dist} ליעד ${rm}!`,
          priority: 50,
        });
        break;
      }
    }
  }

  return items;
}

// ═══════════════════════════════════════════════════════════════════
// LOW DATA FALLBACK
// ═══════════════════════════════════════════════════════════════════

function generateLowData(
  players: MilestonePlayer[],
  _pStats: PeriodStats[],
  opts: MilestoneOptions,
): MilestoneItem[] {
  const items: MilestoneItem[] = [];
  if (!opts.isLowData || opts.mode !== 'period') return items;

  const { periodLabel = '', uniqueGamesInPeriod = 0 } = opts;
  const sorted = [...players].sort((a, b) => b.totalProfit - a.totalProfit);
  const participants = sorted.filter(p => p.gamesPlayed >= 1);

  if (uniqueGamesInPeriod === 1 && participants.length > 0) {
    const winner = participants.find(p => p.totalProfit > 0);
    if (winner) {
      items.push({
        emoji: '🎉', category: 'season', sentiment: 'positive',
        title: `המשחק הראשון ב${periodLabel}!`,
        description: `${winner.name} ניצח במשחק הראשון עם ${fmt(winner.totalProfit)}. התחלה מעולה!`,
        priority: 70,
      });
    }
    const loser = participants.find(p => p.totalProfit < 0);
    if (loser && participants.length > 1) {
      items.push({
        emoji: '💪', category: 'drama', sentiment: 'negative',
        title: 'הזדמנות להתהפך!',
        description: `${loser.name} הפסיד ${Math.abs(Math.round(loser.totalProfit))}₪ במשחק הראשון. הפעם הזדמנות לחזור לפלוס!`,
        priority: 65,
      });
    }
  }

  if (uniqueGamesInPeriod <= 2 && participants.length <= 4) {
    participants.slice(0, 3).forEach((p, idx) => {
      items.push({
        emoji: p.totalProfit >= 0 ? '✅' : '📊', category: 'form', sentiment: p.totalProfit >= 0 ? 'positive' : 'negative',
        title: `${p.name} ב${periodLabel}`,
        description: `${p.name} עם ${fmt(p.totalProfit)}${p.gamesPlayed === 1 ? ' במשחק הראשון' : ` אחרי ${p.gamesPlayed} משחקים`}. ${p.totalProfit >= 0 ? 'התחלה טובה!' : 'הפעם הזדמנות להתהפך!'}`,
        priority: 35 - idx * 5,
      });
    });
  }

  return items;
}

// ═══════════════════════════════════════════════════════════════════
// SELECTION & DEDUP
// ═══════════════════════════════════════════════════════════════════

function selectMilestones(milestones: MilestoneItem[], players: MilestonePlayer[], maxCount: number): MilestoneItem[] {
  milestones.sort((a, b) => b.priority - a.priority);

  const selected: MilestoneItem[] = [];
  const playerMentions: Record<string, number> = {};
  const categoryLimits: Record<string, number> = {
    battle: 2, drama: 2, streak: 2, h2h: 2,
    milestone: 1, form: 1, record: 1, season: 1, rebuy: 1,
  };

  const playerNames = players.map(p => p.name);

  for (const m of milestones) {
    if (selected.length >= maxCount) break;

    const catCount = selected.filter(s => s.category === m.category).length;
    const limit = categoryLimits[m.category] || 1;
    if (catCount >= limit) continue;

    const mentioned = playerNames.filter(name => m.title.includes(name) || m.description.includes(name));
    const isMainSubject = mentioned.length === 1 || (mentioned.length > 0 && m.title.includes(mentioned[0]));

    if (isMainSubject && mentioned.some(name => (playerMentions[name] || 0) >= 1)) continue;
    if (mentioned.some(name => (playerMentions[name] || 0) >= 2)) continue;

    selected.push(m);
    mentioned.forEach(name => playerMentions[name] = (playerMentions[name] || 0) + 1);
  }

  // Ensure minimum of 5 (fill from remaining)
  if (selected.length < 5) {
    for (const m of milestones) {
      if (selected.length >= 5) break;
      if (!selected.includes(m)) selected.push(m);
    }
  }

  return selected;
}

// ═══════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════════

export function generateMilestones(players: MilestonePlayer[], options: MilestoneOptions): MilestoneItem[] {
  if (players.length === 0) return [];

  const { stats: pStats, currentYear, currentMonth, currentHalf, halfStartMonth } = computePeriodStats(players);
  const ctx = { currentYear, currentMonth, currentHalf, halfStartMonth };

  const allMilestones: MilestoneItem[] = [
    ...generateBattles(players, pStats, options, ctx),
    ...generateStreaks(players, pStats, options),
    ...generateNumericGoals(players, pStats, options, ctx),
    ...generateForm(players, pStats, options, ctx),
    ...generateDrama(players, pStats, options),
    ...generateH2H(players, pStats, options),
    ...generateRecords(players, pStats, options),
    ...generateSeason(players, pStats, options, ctx),
    ...generateRebuy(players, pStats, options),
    ...generateLowData(players, pStats, options),
  ];

  return selectMilestones(allMilestones, players, 8);
}

// ═══════════════════════════════════════════════════════════════════
// SENTIMENT COLORS (shared by all UI consumers)
// ═══════════════════════════════════════════════════════════════════

export function getSentimentColors(sentiment: MilestoneSentiment): { border: string; bg: string } {
  switch (sentiment) {
    case 'positive': return { border: '#22c55e', bg: 'rgba(34, 197, 94, 0.12)' };
    case 'negative': return { border: '#ef4444', bg: 'rgba(239, 68, 68, 0.12)' };
    case 'battle':   return { border: '#f59e0b', bg: 'rgba(245, 158, 11, 0.12)' };
    case 'surprise':  return { border: '#a855f7', bg: 'rgba(168, 85, 247, 0.12)' };
  }
}
