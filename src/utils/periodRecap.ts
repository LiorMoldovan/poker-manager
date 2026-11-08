import { Game, GamePlayer, Player } from '../types';
import { getAllGames, getAllGamePlayers, getAllPlayers, getSettings } from '../database/storage';

export type RecapPeriodType = 'month' | 'h1' | 'h2' | 'year';

export const HEBREW_MONTHS = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
];

export interface RecapPlayerEntry {
  playerId: string;
  playerName: string;
  profit: number;
  gamesPlayed: number;
  wins: number;
  winRate: number;
  avgProfit: number;
  totalRebuys: number;
  totalInvested: number;
  bestSingleWin: number;
  bestSingleWinDate: string;
  longestWinStreak: number;
  rank: number;
}

export interface PeriodRecordHighlight {
  id: string;
  icon: string;
  type: 'career_best_win' | 'career_best_month' | 'streak' | 'iron_man' | 'big_comeback' | 'turbulent_game' | 'group_record' | 'all_time_record';
  title: string;
  playerName?: string;
  badge?: string;
  description: string;
}

export interface PeriodStory {
  id: string;
  icon: string;
  type: 'rank_surge' | 'rank_fall' | 'top_takeover' | 'all_time_shift' | 'career_milestone';
  title: string;
  badge?: string;
  badgeVariant?: 'green' | 'amber' | 'red' | 'blue' | 'purple';
  playerName?: string;
  description: string;
}

export interface FourthAward {
  type: 'hotStreak' | 'topAverage' | 'ironAttendance';
  icon: string;
  title: string;
  playerName: string;
  subtitle: string;
  profit?: number;
}

export interface PeriodRecapData {
  periodKey: string;         // e.g. 'recap_2025-10', 'recap_2025-H1', 'recap_2025-YEAR'
  periodType: RecapPeriodType;
  year: number;
  month?: number;            // 1..12 when periodType === 'month'
  title: string;             // e.g. 'סיכום אוקטובר 2025'
  shortLabel: string;        // e.g. 'אוקטובר 2025'
  isCompletedPeriod: boolean;
  gamesCount: number;
  activeThreshold: number;
  totalPot: number;
  totalRebuys: number;
  avgPotPerGame: number;
  avgPlayersPerGame: number;
  maxPlayersInGame: number;
  profitablePlayersCount: number;
  topLocation?: { name: string; count: number };
  biggestGamePot?: { pot: number; date: string };
  podium: RecapPlayerEntry[];     // top 3 active players with profit > 0 (or top 3 active)
  allRanked: RecapPlayerEntry[];  // all active players ranked by profit
  records: PeriodRecordHighlight[]; // High-impact milestones and broken records
  stories: PeriodStory[];          // Key stories, standing shifts & macro movements
  awards: {
    sniper?: { playerName: string; winRate: number; wins: number; games: number; profit: number };
    bigHit?: { playerName: string; profit: number; date: string };
    hotStreak?: { playerName: string; streak: number; profit: number };
    fourthAward?: FourthAward;
    atm?: { playerName: string; totalRebuys: number; avgRebuys: number; totalInvested: number; games: number; profit: number };
  };
  deterministicHighlights: string[];
}

export interface PlayerMonthCell {
  year: number;
  month: number; // 1..12
  monthName: string;
  gamesInMonth: number;
  playerGames: number;
  profit: number;
  rank: number | null; // 1, 2, 3, or >3 among active players (null if didn't meet threshold or 0 games)
  isChamp: boolean;
  isSilver: boolean;
  isBronze: boolean;
  isSniper: boolean;
  isBigHit: boolean;
}

export interface PlayerYearTrophyMatrix {
  year: number;
  isYearChamp: boolean;
  yearRank: number | null;
  yearProfit: number;
  isH1Champ: boolean;
  h1Rank: number | null;
  isH2Champ: boolean;
  h2Rank: number | null;
  months: PlayerMonthCell[]; // 12 items (1..12)
}

export interface CompactTrophyPill {
  id: string;
  icon: string;
  label: string;
  count: number;
  color: string;
  bg: string;
  border: string;
}

export interface PlayerTrophyCabinet {
  playerId: string;
  playerName: string;
  reigningBadge?: {
    label: string; // e.g. '👑 אלוף אוקטובר'
    periodType: RecapPeriodType;
    year: number;
    month?: number;
  };
  yearlyChamps: string[];    // e.g. ['2025', '2024']
  yearlyPodiums: number;
  halfChamps: string[];      // e.g. ['H2 2025', 'H1 2025']
  halfPodiums: number;
  monthlyChamps: number;     // 🥇
  monthlySilvers: number;    // 🥈
  monthlyBronzes: number;    // 🥉
  monthlyPodiums: number;    // 🥇 + 🥈 + 🥉
  monthlySnipers: number;    // 🎯
  monthlyBigHits: number;    // 💥
  totalTrophiesCount: number;
  compactPills: CompactTrophyPill[]; // Max 4 pills for the mobile player card
  yearsMatrix: PlayerYearTrophyMatrix[];
}

export interface MonthlyHallOfFameRow {
  year: number;
  month: number; // 1..12
  monthName: string;
  gamesCount: number;
  totalPot: number;
  top3: Array<{ playerId: string; playerName: string; profit: number; games: number }>;
  bigHit?: { playerName: string; profit: number };
  sniper?: { playerName: string; winRate: number };
}

function getGameDate(g: Game): Date {
  return new Date(g.date || g.createdAt);
}

function formatShortDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

export function buildPeriodKey(periodType: RecapPeriodType, year: number, month?: number): string {
  if (periodType === 'month' && month) {
    return `recap_${year}-${String(month).padStart(2, '0')}`;
  }
  if (periodType === 'h1') return `recap_${year}-H1`;
  if (periodType === 'h2') return `recap_${year}-H2`;
  return `recap_${year}-YEAR`;
}

function isPeriodCompleted(periodType: RecapPeriodType, year: number, month?: number): boolean {
  const now = new Date();
  const curY = now.getFullYear();
  const curM = now.getMonth() + 1;
  if (periodType === 'year') return year < curY;
  if (periodType === 'h1') return year < curY || (year === curY && curM > 6);
  if (periodType === 'h2') return year < curY;
  if (periodType === 'month' && month) {
    return year < curY || (year === curY && month < curM);
  }
  return false;
}

/**
 * Detects milestone achievements, historic records broken, and notable highlights
 * that specifically took place during this period vs all prior games or within the period.
 */
function detectPeriodRecords(
  periodGames: Game[],
  periodGP: GamePlayer[],
  allGames: Game[],
  allGP: GamePlayer[],
  playerMap: Map<string, Player>,
  periodType: RecapPeriodType,
  year: number,
  month?: number
): PeriodRecordHighlight[] {
  const records: PeriodRecordHighlight[] = [];
  if (periodGames.length === 0) return records;

  const periodStartDate = periodGames[0]
    ? getGameDate(periodGames[0])
    : new Date(year, (month || 1) - 1, 1);
  const priorCompletedGames = allGames.filter(g => getGameDate(g).getTime() < periodStartDate.getTime());
  const priorGameIds = new Set(priorCompletedGames.map(g => g.id));
  const priorGPs = allGP.filter(gp => priorGameIds.has(gp.gameId));

  // 1. All-time club records and single-win rankings in this period
  const allHistoricalProfits = allGP
    .map(gp => Number(gp.profit || 0))
    .sort((a, b) => b - a);

  const positiveGPs = [...periodGP]
    .filter(gp => Number(gp.profit || 0) > 0)
    .sort((a, b) => Number(b.profit || 0) - Number(a.profit || 0));

  const seenWinPlayers = new Set<string>();
  for (const gp of positiveGPs) {
    if (seenWinPlayers.has(gp.playerId)) continue;
    seenWinPlayers.add(gp.playerId);

    const profitVal = Number(gp.profit || 0);
    const pName = playerMap.get(gp.playerId)?.name || gp.playerName || 'שחקן';
    const gObj = periodGames.find(x => x.id === gp.gameId);
    const dStr = gObj ? formatShortDate(gObj.date || gObj.createdAt) : '';

    const allTimeRank = allHistoricalProfits.filter(val => val > profitVal).length + 1;

    const pPriorGPs = priorGPs.filter(x => x.playerId === gp.playerId);
    const priorBest = pPriorGPs.reduce((m, x) => Math.max(m, Number(x.profit || 0)), 0);
    const isCareerBest = pPriorGPs.length >= 3 && profitVal > priorBest + 15 && priorBest >= 80;

    if (allTimeRank === 1) {
      records.push({
        id: `all_time_rec_${gp.id}`,
        icon: '👑',
        type: 'group_record',
        title: 'שיא כל הזמנים בערב בודד!',
        playerName: pName,
        badge: 'שיא מועדון היסטורי',
        description: `${pName} ניפץ את שיא הרווח למשחק בודד בתולדות הקבוצה עם +₪${Math.round(profitVal)} (${dStr})!`,
      });
    } else if (allTimeRank <= 10) {
      records.push({
        id: `all_time_top10_${gp.id}`,
        icon: '🌟',
        type: 'all_time_record',
        title: `טופ 10 של כל הזמנים (+₪${Math.round(profitVal)})`,
        playerName: pName,
        badge: `מקום ${allTimeRank} בכל הזמנים`,
        description: `הזכייה של ${pName} ב-+₪${Math.round(profitVal)} (${dStr}) נכנסה למקום ה-${allTimeRank} בשיאי כל הזמנים של המועדון${isCareerBest ? ' ומהווה שיא קריירה אישי!' : '!'}`,
      });
    } else if (isCareerBest) {
      records.push({
        id: `career_win_${gp.id}`,
        icon: '🚀',
        type: 'career_best_win',
        title: 'שיא קריירה בערב יחיד',
        playerName: pName,
        badge: 'שיא אישי חדש',
        description: `${pName} ניפץ את שיא הרווח האישי לערב יחיד בקריירה: +₪${Math.round(profitVal)} (${dStr}), מעל שיאו הקודם (+₪${Math.round(priorBest)})!`,
      });
    }
  }

  // 2. Career best month
  if (periodType === 'month' && month) {
    for (const [pId, pObj] of playerMap.entries()) {
      const pName = pObj.name;
      const pPeriodGPs = periodGP.filter(gp => gp.playerId === pId);
      if (pPeriodGPs.length === 0) continue;
      const periodProfit = pPeriodGPs.reduce((s, gp) => s + Number(gp.profit || 0), 0);
      if (periodProfit < 250) continue;

      const pastMonthProfits = new Map<string, number>();
      for (const gp of priorGPs) {
        if (gp.playerId !== pId) continue;
        const gObj = allGames.find(x => x.id === gp.gameId);
        if (!gObj) continue;
        const d = getGameDate(gObj);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        pastMonthProfits.set(key, (pastMonthProfits.get(key) || 0) + Number(gp.profit || 0));
      }

      if (pastMonthProfits.size >= 3) {
        let priorBestMonth = -Infinity;
        for (const val of pastMonthProfits.values()) {
          if (val > priorBestMonth) priorBestMonth = val;
        }
        if (periodProfit > priorBestMonth + 30 && priorBestMonth > 0) {
          records.push({
            id: `career_month_${pId}`,
            icon: '🌟',
            type: 'career_best_month',
            title: 'חודש שיא בכל הזמנים',
            playerName: pName,
            badge: 'חודש שיא אישי',
            description: `${pName} רשם את החודש הרווחי ביותר שלו מאז ומעולם עם +₪${Math.round(periodProfit)} (הקודם: +₪${Math.round(priorBestMonth)})!`,
          });
        }
      }
    }
  }

  // 4. Iron Man (100% attendance, if >= 3 games)
  if (periodGames.length >= 3) {
    const pCounts = new Map<string, number>();
    periodGP.forEach(gp => {
      pCounts.set(gp.playerId, (pCounts.get(gp.playerId) || 0) + 1);
    });
    const ironNames: string[] = [];
    for (const [pId, cnt] of pCounts.entries()) {
      if (cnt === periodGames.length) {
        const name = playerMap.get(pId)?.name;
        if (name) ironNames.push(name);
      }
    }
    if (ironNames.length > 0 && ironNames.length <= 4) {
      records.push({
        id: 'iron_man',
        icon: '🛡️',
        type: 'iron_man',
        title: 'נוכחות ברזל (100%)',
        badge: 'התייצבות מלאה',
        description: `${ironNames.join(', ')} לא החמיצו אף ערב והתייצבו לכל ${periodGames.length} המשחקים החודש!`,
      });
    }
  }

  // 5. Streaks in period
  for (const [pId, pObj] of playerMap.entries()) {
    const pName = pObj.name;
    let streak = 0;
    let maxStreak = 0;
    for (const g of periodGames) {
      const gp = periodGP.find(x => x.gameId === g.id && x.playerId === pId);
      if (!gp) continue;
      if (Number(gp.profit || 0) > 0) {
        streak++;
        if (streak > maxStreak) maxStreak = streak;
      } else {
        streak = 0;
      }
    }
    if (maxStreak >= 4) {
      records.push({
        id: `streak_${pId}`,
        icon: '🔥',
        type: 'streak',
        title: 'רצף ניצחונות חם',
        playerName: pName,
        badge: `${maxStreak} ניצחונות ברצף`,
        description: `${pName} רשם רצף מרשים של ${maxStreak} ניצחונות רצופים במהלך החודש!`,
      });
    }
  }

  // 6. The Big Comeback
  for (const [pId, pObj] of playerMap.entries()) {
    const pName = pObj.name;
    const pGps = periodGames
      .map(g => periodGP.find(x => x.gameId === g.id && x.playerId === pId))
      .filter((x): x is GamePlayer => Boolean(x));
    if (pGps.length >= 3) {
      const halfCount = Math.floor(pGps.length / 2);
      const firstHalfProfit = pGps.slice(0, halfCount).reduce((s, x) => s + Number(x.profit || 0), 0);
      const totalProfit = pGps.reduce((s, x) => s + Number(x.profit || 0), 0);
      if (firstHalfProfit <= -120 && totalProfit >= 80) {
        records.push({
          id: `comeback_${pId}`,
          icon: '🔄',
          type: 'big_comeback',
          title: 'קאמבק החודש',
          playerName: pName,
          badge: 'מהפך מפיגור',
          description: `${pName} התאושש מבור של ₪${Math.abs(Math.round(firstHalfProfit))} בחצי הראשון, ועשה מהפך ענק לסיום ברווח נקי של +₪${Math.round(totalProfit)}!`,
        });
      }
    }
  }

  // 7. Perfect accuracy (100% win rate with >= 3 games)
  for (const [pId, pObj] of playerMap.entries()) {
    const pName = pObj.name;
    const pGps = periodGP.filter(gp => gp.playerId === pId);
    if (pGps.length >= 3) {
      const wins = pGps.filter(gp => Number(gp.profit || 0) > 0).length;
      if (wins === pGps.length) {
        records.push({
          id: `perfect_acc_${pId}`,
          icon: '🎯',
          type: 'streak',
          title: 'דיוק מושלם (100% הצלחה)',
          playerName: pName,
          badge: `${wins}/${wins} ניצחונות`,
          description: `${pName} סיים את התקופה במאזן מושלם של 100% הצלחה עם ${wins} ניצחונות מתוך ${wins} ערבים!`,
        });
      }
    }
  }

  // 8. Rollercoaster / Extreme Volatility in period
  for (const [pId, pObj] of playerMap.entries()) {
    const pName = pObj.name;
    const pGps = periodGP.filter(gp => gp.playerId === pId);
    if (pGps.length >= 3) {
      const maxWin = pGps.reduce((m, x) => Math.max(m, Number(x.profit || 0)), 0);
      const maxLoss = pGps.reduce((m, x) => Math.min(m, Number(x.profit || 0)), 0);
      if (maxWin >= 180 && maxLoss <= -120) {
        records.push({
          id: `rollercoaster_${pId}`,
          icon: '🎢',
          type: 'streak',
          title: 'רכבת הרים ותנודתיות',
          playerName: pName,
          badge: 'פער קיצוני',
          description: `${pName} חווה את החודש הכי סוער: מניצחון שיא של +₪${Math.round(maxWin)} ועד הפסד של -₪${Math.abs(Math.round(maxLoss))}!`,
        });
      }
    }
  }

  // 9. Turbulent / Peak Action Game
  let topAction: { g: Game; players: number; totalRebuys: number } | null = null;
  for (const g of periodGames) {
    const gGps = periodGP.filter(x => x.gameId === g.id);
    const totalRebuys = gGps.reduce((s, x) => s + Number(x.rebuys || 0), 0);
    if (!topAction || totalRebuys > topAction.totalRebuys) {
      topAction = { g, players: gGps.length, totalRebuys };
    }
  }
  if (topAction && topAction.totalRebuys >= 8) {
    const dStr = formatShortDate(topAction.g.date || topAction.g.createdAt);
    const loc = topAction.g.location ? ` (אצל ${topAction.g.location})` : '';
    records.push({
      id: 'turbulent_game',
      icon: '⚡',
      type: 'turbulent_game',
      title: 'ערב האקשן של החודש',
      badge: `${Math.round(topAction.totalRebuys * 10) / 10} קניות`,
      description: `ב-${dStr}${loc} נרשם האקשן הגבוה ביותר: ${Math.round(topAction.totalRebuys * 10) / 10} קניות ו-${topAction.players} שחקנים סביב השולחן!`,
    });
  }

  return records.slice(0, 5);
}

/**
 * Detects key stories and macro standings movements (Yearly, Half-year, All-Time)
 * triggered by this period's results (replaces the awards grid with narrative stories).
 */
function detectPeriodStories(
  periodGames: Game[],
  _periodGP: GamePlayer[],
  allGames: Game[],
  allGP: GamePlayer[],
  playerMap: Map<string, Player>,
  allRanked: RecapPlayerEntry[],
  champ: RecapPlayerEntry | undefined,
  periodType: RecapPeriodType,
  year: number,
  month?: number
): PeriodStory[] {
  const stories: PeriodStory[] = [];
  if (periodGames.length === 0) return stories;

  const periodStartDate = periodGames[0]
    ? getGameDate(periodGames[0])
    : new Date(year, (month || 1) - 1, 1);
  const periodEndDate = periodGames[periodGames.length - 1]
    ? getGameDate(periodGames[periodGames.length - 1])
    : new Date(year, (month || 12), 0, 23, 59, 59);

  function getRankMap(gamesSubset: Game[]): Map<string, { rank: number; profit: number }> {
    const ids = new Set(gamesSubset.map(g => g.id));
    const subGps = allGP.filter(gp => ids.has(gp.gameId));
    const totals = new Map<string, number>();
    for (const gp of subGps) {
      totals.set(gp.playerId, (totals.get(gp.playerId) || 0) + Number(gp.profit || 0));
    }
    const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    const map = new Map<string, { rank: number; profit: number }>();
    sorted.forEach(([pId, profit], idx) => {
      map.set(pId, { rank: idx + 1, profit });
    });
    return map;
  }

  // 1. All-Time Shifts & Milestones
  const gamesAllBefore = allGames.filter(g => getGameDate(g).getTime() < periodStartDate.getTime());
  const gamesAllThrough = allGames.filter(g => getGameDate(g).getTime() <= periodEndDate.getTime());
  const allBefore = getRankMap(gamesAllBefore);
  const allThrough = getRankMap(gamesAllThrough);

  // Check big all-time rank jumps (>= 3 spots, e.g. Oren +38)
  const allTimeJumps: { p: RecapPlayerEntry; delta: number; bRank: number; tRank: number; tProfit: number }[] = [];
  for (const p of allRanked) {
    const b = allBefore.get(p.playerId);
    const t = allThrough.get(p.playerId);
    if (!b || !t) continue;
    const delta = b.rank - t.rank;
    if (delta >= 3) {
      allTimeJumps.push({ p, delta, bRank: b.rank, tRank: t.rank, tProfit: t.profit });
    }
  }
  allTimeJumps.sort((a, b) => b.delta - a.delta);
  if (allTimeJumps.length > 0) {
    const topJump = allTimeJumps[0];
    stories.push({
      id: `all_time_jump_${topJump.p.playerId}`,
      icon: '⚡',
      type: 'all_time_shift',
      title: `זינוק היסטורי בכל הזמנים: ${topJump.p.playerName}`,
      badge: `עלייה של ${topJump.delta} מקומות`,
      badgeVariant: 'purple',
      playerName: topJump.p.playerName,
      description: `${topJump.p.playerName} רושם את הזינוק הגדול של התקופה בכל הזמנים: מטפס ${topJump.delta} שלבים (ממקום ${topJump.bRank} למקום ${topJump.tRank}) ועובר לרווח מצטבר של +₪${Math.round(topJump.tProfit).toLocaleString('he-IL')}!`,
    });
  }

  // Check all-time milestone thresholds crossed (5k, 10k, 15k)
  const milestones = [15000, 10000, 5000, 2500, 1000];
  for (const p of allRanked) {
    const b = allBefore.get(p.playerId)?.profit || 0;
    const t = allThrough.get(p.playerId)?.profit || 0;
    for (const m of milestones) {
      if (b < m && t >= m) {
        stories.push({
          id: `milestone_${p.playerId}_${m}`,
          icon: '💎',
          type: 'career_milestone',
          title: `חציית רף ₪${m.toLocaleString('he-IL')} בכל הזמנים`,
          badge: 'ציון דרך היסטורי',
          badgeVariant: 'amber',
          playerName: p.playerName,
          description: `${p.playerName} חצה בתקופה זו רף היסטורי של ₪${m.toLocaleString('he-IL')} רווח מצטבר בתולדות המועדון (הגיע ל-₪${Math.round(t).toLocaleString('he-IL')})!`,
        });
        break;
      }
    }
  }

  // 2. Yearly Season Shifts (עונת year)
  const gamesYearBefore = allGames.filter(g => getGameDate(g).getFullYear() === year && getGameDate(g).getTime() < periodStartDate.getTime());
  const gamesYearThrough = allGames.filter(g => getGameDate(g).getFullYear() === year && getGameDate(g).getTime() <= periodEndDate.getTime());
  const yBefore = getRankMap(gamesYearBefore);
  const yThrough = getRankMap(gamesYearThrough);

  const priorYearGPs = allGP.filter(gp => {
    const g = allGames.find(x => x.id === gp.gameId);
    if (!g) return false;
    const d = getGameDate(g);
    return d.getFullYear() === year && d.getTime() < periodStartDate.getTime();
  });

  // 2a. Slump Breaker / Positive Momentum Reversal (was in deep deficit, now strongly green)
  for (const p of allRanked) {
    if (p.gamesPlayed < 2) continue;
    const pPriorGps = priorYearGPs.filter(gp => gp.playerId === p.playerId);
    const priorProfit = pPriorGps.reduce((s, x) => s + Number(x.profit || 0), 0);
    if (priorProfit <= -350 && p.profit >= 100 && p.winRate >= 50) {
      stories.push({
        id: `slump_breaker_${p.playerId}`,
        icon: '🔄',
        type: 'rank_surge',
        title: `שבירת בצורת ותפנית חדה: ${p.playerName}`,
        badge: 'תפנית חיובית',
        badgeVariant: 'green',
        playerName: p.playerName,
        description: `${p.playerName} שובר רצף עונתי קשה: אחרי שהיה בפיגור של -₪${Math.abs(Math.round(priorProfit))}, הוא רושם חודש פנטסטי עם רווח נקי של +₪${Math.round(p.profit)} ו-${p.winRate}% הצלחה!`,
      });
      break;
    }
  }

  // 2b. Chaser Gap Closing in the top ranks (closing hundreds of shekels on a rival)
  const priorTotalsSorted = [...yBefore.entries()].sort((a, b) => b[1].profit - a[1].profit);
  for (let rank = 1; rank <= 4; rank++) {
    const leaderBefore = priorTotalsSorted[rank - 1];
    const chaserBefore = priorTotalsSorted[rank];
    if (!leaderBefore || !chaserBefore) continue;
    const gapBefore = leaderBefore[1].profit - chaserBefore[1].profit;
    const leaderAfterProfit = yThrough.get(leaderBefore[0])?.profit || 0;
    const chaserAfterProfit = yThrough.get(chaserBefore[0])?.profit || 0;
    const gapAfter = leaderAfterProfit - chaserAfterProfit;
    const closed = gapBefore - gapAfter;
    if (closed >= 300) {
      const chaserName = playerMap.get(chaserBefore[0])?.name || 'רודף';
      const leaderName = playerMap.get(leaderBefore[0])?.name || 'מוביל';
      stories.push({
        id: `gap_closed_${chaserBefore[0]}`,
        icon: '⚔️',
        type: 'top_takeover',
        title: `סגירת פערים בצמרת: ${chaserName}`,
        badge: `סגירת ₪${Math.round(closed)}`,
        badgeVariant: 'amber',
        playerName: chaserName,
        description: `${chaserName} סגר פער אדיר של ₪${Math.round(closed)} מול ${leaderName} במירוץ על המקום ה-${rank}, וצימצם את הפער ביניהם ל-₪${Math.round(gapAfter)} בלבד!`,
      });
      break;
    }
  }

  // 2c. Rough Month / Momentum Crash (decent prior player crashing hard)
  for (const p of allRanked) {
    if (p.profit <= -250 && p.winRate <= 25) {
      stories.push({
        id: `rough_month_${p.playerId}`,
        icon: '⚠️',
        type: 'rank_fall',
        title: `איבוד מומנטום וחודש קשוח: ${p.playerName}`,
        badge: 'חודש קשוח',
        badgeVariant: 'red',
        playerName: p.playerName,
        description: `${p.playerName} חווה חודש לא פשוט ונעצר על ${p.winRate}% הצלחה בלבד עם הפסד כבד של -₪${Math.abs(Math.round(p.profit))}.`,
      });
      break;
    }
  }

  // Check climbers & fallers in current year
  const yearlyClimbers: { p: RecapPlayerEntry; delta: number; bRank: number; tRank: number }[] = [];
  const yearlyFallers: { p: RecapPlayerEntry; delta: number; bRank: number; tRank: number }[] = [];

  for (const p of allRanked) {
    const b = yBefore.get(p.playerId);
    const t = yThrough.get(p.playerId);
    if (!b || !t) continue;
    const delta = b.rank - t.rank;
    if (delta >= 2) {
      yearlyClimbers.push({ p, delta, bRank: b.rank, tRank: t.rank });
    } else if (delta <= -2) {
      yearlyFallers.push({ p, delta, bRank: b.rank, tRank: t.rank });
    }
  }

  yearlyClimbers.sort((a, b) => b.delta - a.delta);
  yearlyFallers.sort((a, b) => a.delta - b.delta);

  if (yearlyClimbers.length > 0) {
    const topC = yearlyClimbers[0];
    stories.push({
      id: `yearly_climber_${topC.p.playerId}`,
      icon: '🚀',
      type: 'rank_surge',
      title: `זינוק בדירוג עונת ${year}: ${topC.p.playerName}`,
      badge: `עלייה של ${topC.delta} מקומות`,
      badgeVariant: 'green',
      playerName: topC.p.playerName,
      description: `${topC.p.playerName} מטפס ${topC.delta} שלבים בטבלת עונת ${year} ומזנק ממקום ${topC.bRank} למקום ה-${topC.tRank}!`,
    });
  }

  if (yearlyFallers.length > 0) {
    const topF = yearlyFallers[0];
    stories.push({
      id: `yearly_faller_${topF.p.playerId}`,
      icon: '📉',
      type: 'rank_fall',
      title: `נסיגה בדירוג ${year}: ${topF.p.playerName}`,
      badge: `ירידה של ${Math.abs(topF.delta)} מקומות`,
      badgeVariant: 'red',
      playerName: topF.p.playerName,
      description: `בעקבות תקופה קשוחה (${topF.p.profit < 0 ? `-₪${Math.abs(topF.p.profit)}` : `₪${topF.p.profit}`}), ${topF.p.playerName} מאבד ${Math.abs(topF.delta)} מקומות בטבלת ${year} ויורד ממקום ${topF.bRank} למקום ה-${topF.tRank}.`,
    });
  }

  // 3. Half-Year Shifts (H1 / H2)
  if (periodType === 'month' && month) {
    const isH2 = month >= 7;
    const halfLabel = isH2 ? `חציון ב׳ ${year}` : `חציון א׳ ${year}`;
    const halfStart = new Date(year, isH2 ? 6 : 0, 1);

    const gamesHalfBefore = allGames.filter(g => {
      const d = getGameDate(g);
      return d.getTime() >= halfStart.getTime() && d.getTime() < periodStartDate.getTime();
    });
    const gamesHalfThrough = allGames.filter(g => {
      const d = getGameDate(g);
      return d.getTime() >= halfStart.getTime() && d.getTime() <= periodEndDate.getTime();
    });

    const hBefore = getRankMap(gamesHalfBefore);
    const hThrough = getRankMap(gamesHalfThrough);

    for (const p of allRanked) {
      const b = hBefore.get(p.playerId);
      const t = hThrough.get(p.playerId);
      if (!b || !t) continue;
      const delta = b.rank - t.rank;
      if (t.rank <= 3 && b.rank > t.rank && delta >= 1) {
        stories.push({
          id: `half_top_${p.playerId}`,
          icon: t.rank === 1 ? '👑' : t.rank === 2 ? '🥈' : '🥉',
          type: 'top_takeover',
          title: `זינוק לטופ ${t.rank} ב${halfLabel}: ${p.playerName}`,
          badge: `מקום ${t.rank} ב${halfLabel}`,
          badgeVariant: 'blue',
          playerName: p.playerName,
          description: `${p.playerName} מטפס למקום ה-${t.rank} בטבלת ${halfLabel} (עלה ${delta} שלבים) עם חודש מרשים של +₪${p.profit}!`,
        });
        break;
      }
    }
  }

  // 4. Cementing Leader Status
  if (champ && yThrough.get(champ.playerId)?.rank === 1 && champ.profit >= 400) {
    stories.push({
      id: `leader_cement_${champ.playerId}`,
      icon: '🏰',
      type: 'top_takeover',
      title: `ביצור הפסגה בעונת ${year}: ${champ.playerName}`,
      badge: 'מוביל העונה',
      badgeVariant: 'green',
      playerName: champ.playerName,
      description: `${champ.playerName} מגדיל את הפער בצמרת הדירוג השנתי של ${year} עם תוספת עוצמתית של +₪${champ.profit.toLocaleString('he-IL')} בתקופה זו!`,
    });
  }

  return stories.slice(0, 4);
}

/**
 * Computes full Recap data for a given Month, Half-Year, or Year.
 */
export function computePeriodRecap(
  periodType: RecapPeriodType,
  year: number,
  month?: number,
  preloaded?: { games: Game[]; gamePlayers: GamePlayer[]; players: Player[]; rebuyValue: number }
): PeriodRecapData | null {
  try {
    const allGames = (preloaded?.games || getAllGames()).filter(g => g && g.status === 'completed');
    const allGP = preloaded?.gamePlayers || getAllGamePlayers() || [];
    const allPlayers = preloaded?.players || getAllPlayers() || [];
    const rebuyValue = preloaded?.rebuyValue || getSettings().rebuyValue || 30;

  const playerMap = new Map<string, Player>();
  allPlayers.forEach(p => playerMap.set(p.id, p));

  const periodGames = allGames
    .filter(g => {
      const d = getGameDate(g);
      const y = d.getFullYear();
      const m = d.getMonth() + 1;
      if (y !== year) return false;
      if (periodType === 'month') return m === month;
      if (periodType === 'h1') return m >= 1 && m <= 6;
      if (periodType === 'h2') return m >= 7 && m <= 12;
      return true;
    })
    .sort((a, b) => getGameDate(a).getTime() - getGameDate(b).getTime());

  if (periodGames.length === 0) return null;

  const gameIds = new Set(periodGames.map(g => g.id));
  const gameDateById = new Map<string, string>();
  periodGames.forEach(g => gameDateById.set(g.id, g.date || g.createdAt));

  const periodGP = allGP.filter(gp => gameIds.has(gp.gameId));
  const activeThreshold = Math.max(1, Math.ceil(periodGames.length * 0.33));

  let totalRebuys = 0;
  const potByGame = new Map<string, number>();

  // Group GP by player
  const byPlayer = new Map<string, GamePlayer[]>();
  for (const gp of periodGP) {
    totalRebuys += gp.rebuys || 0;
    potByGame.set(gp.gameId, (potByGame.get(gp.gameId) || 0) + (gp.rebuys || 0) * rebuyValue);
    const list = byPlayer.get(gp.playerId) || [];
    list.push(gp);
    byPlayer.set(gp.playerId, list);
  }

  const totalPot = Math.round(totalRebuys * rebuyValue);
  const avgPotPerGame = Math.round(totalPot / periodGames.length);

  // Biggest game pot
  let biggestGamePot: { pot: number; date: string } | undefined;
  for (const g of periodGames) {
    const pot = Math.round(potByGame.get(g.id) || 0);
    if (!biggestGamePot || pot > biggestGamePot.pot) {
      biggestGamePot = { pot, date: formatShortDate(g.date || g.createdAt) };
    }
  }

  // Top location
  const locCounts = new Map<string, number>();
  for (const g of periodGames) {
    const loc = (g.location || '').trim();
    if (loc) locCounts.set(loc, (locCounts.get(loc) || 0) + 1);
  }
  let topLocation: { name: string; count: number } | undefined;
  for (const [name, count] of locCounts.entries()) {
    if (!topLocation || count > topLocation.count) {
      topLocation = { name, count };
    }
  }

  // Compute player stats (chronological order for streaks)
  const gameOrderIndex = new Map<string, number>();
  periodGames.forEach((g, idx) => gameOrderIndex.set(g.id, idx));

  const allPlayerEntries: RecapPlayerEntry[] = [];
  let globalBigHit: { playerName: string; profit: number; date: string } | undefined;

  for (const [playerId, gps] of byPlayer.entries()) {
    const pObj = playerMap.get(playerId);
    const playerName = pObj?.name || gps[0]?.playerName || 'שחקן';
    const sortedGps = [...gps].sort(
      (a, b) => (gameOrderIndex.get(a.gameId) || 0) - (gameOrderIndex.get(b.gameId) || 0)
    );

    let profit = 0;
    let wins = 0;
    let pRebuys = 0;
    let bestSingleWin = 0;
    let bestSingleWinDate = '';
    let curStreak = 0;
    let longestWinStreak = 0;

    for (const gp of sortedGps) {
      profit += gp.profit;
      pRebuys += gp.rebuys || 0;
      const gDate = formatShortDate(gameDateById.get(gp.gameId) || '');
      if (gp.profit > 0) {
        wins++;
        curStreak++;
        if (curStreak > longestWinStreak) longestWinStreak = curStreak;
        if (gp.profit > bestSingleWin) {
          bestSingleWin = gp.profit;
          bestSingleWinDate = gDate;
        }
        if (!globalBigHit || gp.profit > globalBigHit.profit) {
          globalBigHit = { playerName, profit: Math.round(gp.profit), date: gDate };
        }
      } else {
        curStreak = 0;
      }
    }

    const gamesPlayed = sortedGps.length;
    const winRate = gamesPlayed > 0 ? Math.round((wins / gamesPlayed) * 100) : 0;
    const avgProfit = gamesPlayed > 0 ? Math.round(profit / gamesPlayed) : 0;

    allPlayerEntries.push({
      playerId,
      playerName,
      profit: Math.round(profit),
      gamesPlayed,
      wins,
      winRate,
      avgProfit,
      totalRebuys: Math.round(pRebuys * 10) / 10,
      totalInvested: Math.round(pRebuys * rebuyValue),
      bestSingleWin: Math.round(bestSingleWin),
      bestSingleWinDate,
      longestWinStreak,
      rank: 0,
    });
  }

  // Filter active players (meeting 33% attendance threshold)
  const activeEntries = allPlayerEntries
    .filter(e => e.gamesPlayed >= activeThreshold)
    .sort((a, b) => b.profit - a.profit || b.wins - a.wins);

  // Fallback if somehow no one met threshold
  const rankedList = activeEntries.length > 0
    ? activeEntries
    : [...allPlayerEntries].sort((a, b) => b.profit - a.profit);

  rankedList.forEach((e, idx) => {
    e.rank = idx + 1;
  });

  const podium = rankedList.slice(0, 3);

  // Awards
  // 1. Sniper (highest win rate among active players, tie-break by gamesPlayed then profit)
  const sniperCandidate = [...rankedList]
    .filter(e => e.wins > 0)
    .sort((a, b) => b.winRate - a.winRate || b.gamesPlayed - a.gamesPlayed || b.profit - a.profit)[0];

  // 2. Hot streak (longest win streak in period across all players)
  const streakCandidate = [...allPlayerEntries]
    .filter(e => e.longestWinStreak >= 2)
    .sort((a, b) => b.longestWinStreak - a.longestWinStreak || b.profit - a.profit)[0];

  // 3. Rebuy King (highest average rebuys per game among active players, tie-break by totalRebuys then profit)
  const eligibleForRebuy = rankedList.filter(e => e.totalRebuys > 0 && e.gamesPlayed > 0);
  const atmCandidate = [...eligibleForRebuy].sort((a, b) => {
    const aAvg = a.totalRebuys / a.gamesPlayed;
    const bAvg = b.totalRebuys / b.gamesPlayed;
    return bAvg - aAvg || b.totalRebuys - a.totalRebuys || a.profit - b.profit;
  })[0];
  const atmAvgRebuys = atmCandidate && atmCandidate.gamesPlayed > 0
    ? Math.round((atmCandidate.totalRebuys / atmCandidate.gamesPlayed) * 10) / 10
    : 0;

  // 4. Fourth Award - guarantees a DISTINCT player from the Sniper!
  let fourthAward: FourthAward | undefined;
  const distinctStreakCandidate = [...allPlayerEntries]
    .filter(e => e.playerName !== sniperCandidate?.playerName && e.longestWinStreak >= 2)
    .sort((a, b) => b.longestWinStreak - a.longestWinStreak || b.profit - a.profit)[0];

  if (distinctStreakCandidate) {
    fourthAward = {
      type: 'hotStreak',
      icon: '🔥',
      title: 'הרצף החם',
      playerName: distinctStreakCandidate.playerName,
      subtitle: `${distinctStreakCandidate.longestWinStreak} ניצחונות ברצף`,
      profit: distinctStreakCandidate.profit,
    };
  } else {
    const topAvgCandidate = [...rankedList]
      .filter(e => e.playerName !== sniperCandidate?.playerName && e.avgProfit > 0)
      .sort((a, b) => b.avgProfit - a.avgProfit)[0];

    if (topAvgCandidate) {
      fourthAward = {
        type: 'topAverage',
        icon: '⚡',
        title: 'מלך היציבות',
        playerName: topAvgCandidate.playerName,
        subtitle: `+₪${topAvgCandidate.avgProfit} ממוצע לערב (${topAvgCandidate.gamesPlayed} מש׳)`,
        profit: topAvgCandidate.profit,
      };
    } else {
      const ironCandidate = [...allPlayerEntries]
        .filter(e => e.playerName !== sniperCandidate?.playerName)
        .sort((a, b) => b.gamesPlayed - a.gamesPlayed || b.profit - a.profit)[0];

      if (ironCandidate) {
        fourthAward = {
          type: 'ironAttendance',
          icon: '🛡️',
          title: 'עוגן ההתייצבות',
          playerName: ironCandidate.playerName,
          subtitle: `${ironCandidate.gamesPlayed} משחקים מלאים בתקופה`,
          profit: ironCandidate.profit,
        };
      }
    }
  }

  // Peak attendance in single game
  let maxPlayersInGame = 0;
  for (const g of periodGames) {
    const cnt = periodGP.filter(gp => gp.gameId === g.id).length;
    if (cnt > maxPlayersInGame) maxPlayersInGame = cnt;
  }

  // Labels
  let shortLabel = `${year}`;
  let title = `סיכום עונת ${year}`;
  if (periodType === 'month' && month) {
    const mName = HEBREW_MONTHS[month - 1] || '';
    shortLabel = `${mName} ${year}`;
    title = `סיכום חודש ${mName} ${year}`;
  } else if (periodType === 'h1') {
    shortLabel = `חציון א׳ ${year}`;
    title = `סיכום חציון א׳ ${year}`;
  } else if (periodType === 'h2') {
    shortLabel = `חציון ב׳ ${year}`;
    title = `סיכום חציון ב׳ ${year}`;
  }

  // Deterministic highlights (always accurate, instant fallback or companion to AI)
  const highlights: string[] = [];
  if (podium[0]) {
    const champ = podium[0];
    const diff = podium[1] ? champ.profit - podium[1].profit : 0;
    if (podium[1] && diff <= 100) {
      highlights.push(`קרב צמוד בפסגה: ${champ.playerName} קטף את המקום הראשון בפער של ₪${diff} בלבד מ-${podium[1].playerName}!`);
    } else {
      highlights.push(`דומיננטיות בפסגה: ${champ.playerName} סיים במקום הראשון עם רווח נקי של ₪${champ.profit.toLocaleString('he-IL')} ב-${champ.gamesPlayed} משחקים.`);
    }
  }
  if (sniperCandidate && sniperCandidate.winRate >= 60) {
    highlights.push(`אחוזי פגיעה קטלניים: ${sniperCandidate.playerName} רשם ${sniperCandidate.winRate}% הצלחה (${sniperCandidate.wins} ניצחונות מתוך ${sniperCandidate.gamesPlayed} ערבים).`);
  }
  if (globalBigHit && globalBigHit.profit > 0) {
    highlights.push(`הניצחון הגדול של התקופה: ${globalBigHit.playerName} התפוצץ עם +₪${globalBigHit.profit.toLocaleString('he-IL')} בערב אחד (${globalBigHit.date}).`);
  }
  if (atmCandidate) {
    if (atmCandidate.profit > 0) {
      highlights.push(`מלך הריבאי שלא מוותר: ${atmCandidate.playerName} רשם ממוצע של ${atmAvgRebuys} קניות למשחק (סה״כ ${atmCandidate.totalRebuys} ב-${atmCandidate.gamesPlayed} מש׳) והצליח לסיים ברווח נקי של +₪${atmCandidate.profit.toLocaleString('he-IL')}!`);
    } else {
      highlights.push(`מלך הריבאי והאקשן: ${atmCandidate.playerName} הזרים לקופה ממוצע של ${atmAvgRebuys} קניות למשחק (סה״כ ${atmCandidate.totalRebuys} ב-${atmCandidate.gamesPlayed} מש׳, ₪${atmCandidate.totalInvested.toLocaleString('he-IL')}) שהקפיצו את האקשן בשולחן.`);
    }
  }

  const avgPlayersPerGame = periodGames.length > 0
    ? Math.round((periodGP.length / periodGames.length) * 10) / 10
    : 0;
  const profitablePlayersCount = allPlayerEntries.filter(e => e.profit > 0).length;

  const records = detectPeriodRecords(
    periodGames,
    periodGP,
    allGames,
    allGP,
    playerMap,
    periodType,
    year,
    month
  );

  const stories = detectPeriodStories(
    periodGames,
    periodGP,
    allGames,
    allGP,
    playerMap,
    rankedList,
    podium[0],
    periodType,
    year,
    month
  );

  return {
    periodKey: buildPeriodKey(periodType, year, month),
    periodType,
    year,
    month,
    title,
    shortLabel,
    isCompletedPeriod: isPeriodCompleted(periodType, year, month),
    gamesCount: periodGames.length,
    activeThreshold,
    totalPot,
    totalRebuys: Math.round(totalRebuys * 10) / 10,
    avgPotPerGame,
    avgPlayersPerGame,
    maxPlayersInGame,
    profitablePlayersCount,
    topLocation,
    biggestGamePot,
    podium,
    allRanked: rankedList,
    records,
    stories,
    awards: {
      sniper: sniperCandidate
        ? {
            playerName: sniperCandidate.playerName,
            winRate: sniperCandidate.winRate,
            wins: sniperCandidate.wins,
            games: sniperCandidate.gamesPlayed,
            profit: sniperCandidate.profit,
          }
        : undefined,
      bigHit: globalBigHit,
      hotStreak: streakCandidate
        ? {
            playerName: streakCandidate.playerName,
            streak: streakCandidate.longestWinStreak,
            profit: streakCandidate.profit,
          }
        : undefined,
      fourthAward,
      atm: atmCandidate
        ? {
            playerName: atmCandidate.playerName,
            totalRebuys: atmCandidate.totalRebuys,
            avgRebuys: atmAvgRebuys,
            totalInvested: atmCandidate.totalInvested,
            games: atmCandidate.gamesPlayed,
            profit: atmCandidate.profit,
          }
        : undefined,
    },
    deterministicHighlights: highlights,
  };
  } catch (err) {
    console.warn('computePeriodRecap failed:', err);
    return null;
  }
}

/**
 * Returns the most recently completed month that has at least 1 completed game.
 */
export function getLatestCompletedMonthPeriod(providedGames?: Game[]): { year: number; month: number; label: string } | null {
  try {
    const rawGames = providedGames || getAllGames();
    if (!Array.isArray(rawGames) || rawGames.length === 0) return null;
    const completedGames = rawGames.filter(g => g && g.status === 'completed');
    if (completedGames.length === 0) return null;

    const now = new Date();
    const curY = now.getFullYear();
    const curM = now.getMonth() + 1;

    const ymSet = new Set<string>();
    for (const g of completedGames) {
      const d = getGameDate(g);
      if (isNaN(d.getTime())) continue;
      const y = d.getFullYear();
      const m = d.getMonth() + 1;
      if (isNaN(y) || isNaN(m)) continue;
      // Completed months only (strictly before current calendar month)
      if (y < curY || (y === curY && m < curM)) {
        ymSet.add(`${y}-${String(m).padStart(2, '0')}`);
      }
    }

    if (ymSet.size === 0) return null;
    const sorted = Array.from(ymSet).sort().reverse();
    if (!sorted[0]) return null;
    const parts = sorted[0].split('-');
    if (parts.length !== 2) return null;
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    if (isNaN(year) || isNaN(month) || month < 1 || month > 12) return null;
    return {
      year,
      month,
      label: `${HEBREW_MONTHS[month - 1]} ${year}`,
    };
  } catch (err) {
    console.warn('getLatestCompletedMonthPeriod error:', err);
    return null;
  }
}

/**
 * Lists all available periods (months, halves, years) that have games, sorted newest first.
 */
export function getAvailableRecapPeriods(): Array<{
  key: string;
  periodType: RecapPeriodType;
  year: number;
  month?: number;
  label: string;
  gamesCount: number;
}> {
  const allGames = getAllGames().filter(g => g.status === 'completed');
  const monthCounts = new Map<string, number>();
  const h1Counts = new Map<number, number>();
  const h2Counts = new Map<number, number>();
  const yearCounts = new Map<number, number>();

  for (const g of allGames) {
    const d = getGameDate(g);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    monthCounts.set(ym, (monthCounts.get(ym) || 0) + 1);
    if (m <= 6) h1Counts.set(y, (h1Counts.get(y) || 0) + 1);
    else h2Counts.set(y, (h2Counts.get(y) || 0) + 1);
    yearCounts.set(y, (yearCounts.get(y) || 0) + 1);
  }

  const result: Array<{
    key: string;
    periodType: RecapPeriodType;
    year: number;
    month?: number;
    label: string;
    gamesCount: number;
  }> = [];

  // Add months (newest first)
  const sortedMonths = Array.from(monthCounts.keys()).sort().reverse();
  for (const ym of sortedMonths) {
    const [yStr, mStr] = ym.split('-');
    const year = parseInt(yStr, 10);
    const month = parseInt(mStr, 10);
    result.push({
      key: buildPeriodKey('month', year, month),
      periodType: 'month',
      year,
      month,
      label: `חודש ${HEBREW_MONTHS[month - 1]} ${year}`,
      gamesCount: monthCounts.get(ym) || 0,
    });
  }

  // Add halves & years
  const years = Array.from(yearCounts.keys()).sort((a, b) => b - a);
  for (const y of years) {
    if ((h2Counts.get(y) || 0) >= 3) {
      result.push({
        key: buildPeriodKey('h2', y),
        periodType: 'h2',
        year: y,
        label: `חציון ב׳ ${y}`,
        gamesCount: h2Counts.get(y) || 0,
      });
    }
    if ((h1Counts.get(y) || 0) >= 3) {
      result.push({
        key: buildPeriodKey('h1', y),
        periodType: 'h1',
        year: y,
        label: `חציון א׳ ${y}`,
        gamesCount: h1Counts.get(y) || 0,
      });
    }
    if ((yearCounts.get(y) || 0) >= 4) {
      result.push({
        key: buildPeriodKey('year', y),
        periodType: 'year',
        year: y,
        label: `עונת ${y} (שנתי)`,
        gamesCount: yearCounts.get(y) || 0,
      });
    }
  }

  return result;
}

/**
 * Computes Monthly Hall of Fame rows grouped by year (newest first).
 */
export function computeMonthlyHallOfFame(): Array<{
  year: number;
  months: MonthlyHallOfFameRow[];
}> {
  const games = getAllGames().filter(g => g.status === 'completed');
  const gamePlayers = getAllGamePlayers();
  const players = getAllPlayers();
  const rebuyValue = getSettings().rebuyValue || 30;
  const preloaded = { games, gamePlayers, players, rebuyValue };

  const now = new Date();
  const curY = now.getFullYear();
  const curM = now.getMonth() + 1;

  const ymSet = new Set<string>();
  for (const g of games) {
    const d = getGameDate(g);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    // Include completed months, or current month if it has >= 2 games
    if (y < curY || (y === curY && m <= curM)) {
      ymSet.add(`${y}-${String(m).padStart(2, '0')}`);
    }
  }

  const byYear = new Map<number, MonthlyHallOfFameRow[]>();
  const sortedYMs = Array.from(ymSet).sort().reverse();

  for (const ym of sortedYMs) {
    const [yStr, mStr] = ym.split('-');
    const year = parseInt(yStr, 10);
    const month = parseInt(mStr, 10);
    const recap = computePeriodRecap('month', year, month, preloaded);
    if (!recap || recap.gamesCount === 0) continue;

    const row: MonthlyHallOfFameRow = {
      year,
      month,
      monthName: HEBREW_MONTHS[month - 1],
      gamesCount: recap.gamesCount,
      totalPot: recap.totalPot,
      top3: recap.podium.map(p => ({
        playerId: p.playerId,
        playerName: p.playerName,
        profit: p.profit,
        games: p.gamesPlayed,
      })),
      bigHit: recap.awards.bigHit
        ? { playerName: recap.awards.bigHit.playerName, profit: recap.awards.bigHit.profit }
        : undefined,
      sniper: recap.awards.sniper
        ? { playerName: recap.awards.sniper.playerName, winRate: recap.awards.sniper.winRate }
        : undefined,
    };

    const list = byYear.get(year) || [];
    list.push(row);
    byYear.set(year, list);
  }

  return Array.from(byYear.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([year, months]) => ({ year, months }));
}

/**
 * Computes every player's Trophy Cabinet (Reigning badge + 4 compact mobile pills + 6x2 H1/H2 year grids).
 */
export function computeAllPlayerTrophies(): Map<string, PlayerTrophyCabinet> {
  const games = getAllGames().filter(g => g.status === 'completed');
  const gamePlayers = getAllGamePlayers();
  const players = getAllPlayers();
  const rebuyValue = getSettings().rebuyValue || 30;
  const preloaded = { games, gamePlayers, players, rebuyValue };

  const cabinets = new Map<string, PlayerTrophyCabinet>();
  for (const p of players) {
    cabinets.set(p.id, {
      playerId: p.id,
      playerName: p.name,
      yearlyChamps: [],
      yearlyPodiums: 0,
      halfChamps: [],
      halfPodiums: 0,
      monthlyChamps: 0,
      monthlySilvers: 0,
      monthlyBronzes: 0,
      monthlyPodiums: 0,
      monthlySnipers: 0,
      monthlyBigHits: 0,
      totalTrophiesCount: 0,
      compactPills: [],
      yearsMatrix: [],
    });
  }

  if (games.length === 0) return cabinets;

  // Pre-index games-per-player-per-month (O(n) once instead of O(n²) per cell)
  const gameYM = new Map<string, string>();
  for (const g of games) {
    const d = getGameDate(g);
    gameYM.set(g.id, `${d.getFullYear()}|${d.getMonth() + 1}`);
  }
  const playerMonthGames = new Map<string, number>();
  for (const gp of gamePlayers) {
    const ym = gameYM.get(gp.gameId);
    if (!ym) continue;
    const k = `${gp.playerId}|${ym}`;
    playerMonthGames.set(k, (playerMonthGames.get(k) || 0) + 1);
  }

  const now = new Date();
  const curY = now.getFullYear();
  const curM = now.getMonth() + 1;

  // Discover all years with games
  const yearsSet = new Set<number>();
  for (const g of games) {
    yearsSet.add(getGameDate(g).getFullYear());
  }
  const years = Array.from(yearsSet).sort((a, b) => b - a);

  // Track latest completed month for the reigning badge
  let latestCompletedRecap: PeriodRecapData | null = null;

  for (const y of years) {
    const yearRecap = computePeriodRecap('year', y, undefined, preloaded);
    const h1Recap = computePeriodRecap('h1', y, undefined, preloaded);
    const h2Recap = computePeriodRecap('h2', y, undefined, preloaded);

    const yearCompleted = y < curY;
    const h1Completed = y < curY || (y === curY && curM > 6);
    const h2Completed = y < curY;

    // Award yearly & half-year titles (require >= 4 games for year/half to be official)
    if (yearCompleted && yearRecap && yearRecap.gamesCount >= 4) {
      yearRecap.podium.forEach((entry, idx) => {
        if (entry.profit <= 0) return;
        const cab = cabinets.get(entry.playerId);
        if (!cab) return;
        cab.yearlyPodiums++;
        if (idx === 0) cab.yearlyChamps.push(`${y}`);
      });
    }

    if (h1Completed && h1Recap && h1Recap.gamesCount >= 4) {
      h1Recap.podium.forEach((entry, idx) => {
        if (entry.profit <= 0) return;
        const cab = cabinets.get(entry.playerId);
        if (!cab) return;
        cab.halfPodiums++;
        if (idx === 0) cab.halfChamps.push(`H1 ${y}`);
      });
    }

    if (h2Completed && h2Recap && h2Recap.gamesCount >= 4) {
      h2Recap.podium.forEach((entry, idx) => {
        if (entry.profit <= 0) return;
        const cab = cabinets.get(entry.playerId);
        if (!cab) return;
        cab.halfPodiums++;
        if (idx === 0) cab.halfChamps.push(`H2 ${y}`);
      });
    }

    // Compute all 12 months for this year
    const monthRecaps: Array<PeriodRecapData | null> = [];
    for (let m = 1; m <= 12; m++) {
      const mRecap = computePeriodRecap('month', y, m, preloaded);
      monthRecaps.push(mRecap);

      const mCompleted = y < curY || (y === curY && m < curM);
      if (mCompleted && mRecap && mRecap.gamesCount >= 1) {
        if (
          !latestCompletedRecap ||
          y > latestCompletedRecap.year ||
          (y === latestCompletedRecap.year && m > (latestCompletedRecap.month || 0))
        ) {
          latestCompletedRecap = mRecap;
        }

        // Podium medals
        mRecap.podium.forEach((entry, idx) => {
          if (entry.profit <= 0) return;
          const cab = cabinets.get(entry.playerId);
          if (!cab) return;
          cab.monthlyPodiums++;
          if (idx === 0) cab.monthlyChamps++;
          else if (idx === 1) cab.monthlySilvers++;
          else if (idx === 2) cab.monthlyBronzes++;
        });

        // Sniper
        if (mRecap.awards.sniper) {
          const sniperEntry = mRecap.allRanked.find(
            e => e.playerName === mRecap.awards.sniper?.playerName
          );
          if (sniperEntry) {
            const cab = cabinets.get(sniperEntry.playerId);
            if (cab) cab.monthlySnipers++;
          }
        }

        // Big Hit
        if (mRecap.awards.bigHit) {
          const hitPlayer = players.find(p => p.name === mRecap.awards.bigHit?.playerName);
          if (hitPlayer) {
            const cab = cabinets.get(hitPlayer.id);
            if (cab) cab.monthlyBigHits++;
          }
        }
      }
    }

    // Build per-player 12-month matrix for year `y`
    for (const p of players) {
      const cab = cabinets.get(p.id);
      if (!cab) continue;

      const yearEntry = yearRecap?.allRanked.find(e => e.playerId === p.id);
      const h1Entry = h1Recap?.allRanked.find(e => e.playerId === p.id);
      const h2Entry = h2Recap?.allRanked.find(e => e.playerId === p.id);

      let playedInYear = false;
      const monthsCells: PlayerMonthCell[] = [];

      for (let m = 1; m <= 12; m++) {
        const mRecap = monthRecaps[m - 1];
        if (!mRecap) {
          monthsCells.push({
            year: y,
            month: m,
            monthName: HEBREW_MONTHS[m - 1],
            gamesInMonth: 0,
            playerGames: 0,
            profit: 0,
            rank: null,
            isChamp: false,
            isSilver: false,
            isBronze: false,
            isSniper: false,
            isBigHit: false,
          });
          continue;
        }

        const pRanked = mRecap.allRanked.find(e => e.playerId === p.id);
        // Check if player played at all even if below active threshold
        const playedAny = pRanked
          ? pRanked.gamesPlayed
          : playerMonthGames.get(`${p.id}|${y}|${m}`) || 0;

        if (playedAny > 0) playedInYear = true;

        const profit = pRanked ? pRanked.profit : 0;
        const rank = pRanked && pRanked.profit > 0 ? pRanked.rank : pRanked ? pRanked.rank : null;

        monthsCells.push({
          year: y,
          month: m,
          monthName: HEBREW_MONTHS[m - 1],
          gamesInMonth: mRecap.gamesCount,
          playerGames: playedAny,
          profit,
          rank,
          isChamp: rank === 1 && profit > 0,
          isSilver: rank === 2 && profit > 0,
          isBronze: rank === 3 && profit > 0,
          isSniper: mRecap.awards.sniper?.playerName === p.name,
          isBigHit: mRecap.awards.bigHit?.playerName === p.name,
        });
      }

      if (playedInYear) {
        cab.yearsMatrix.push({
          year: y,
          isYearChamp: yearCompleted && yearEntry?.rank === 1 && (yearEntry?.profit || 0) > 0 && (yearRecap?.gamesCount || 0) >= 4,
          yearRank: yearEntry?.rank || null,
          yearProfit: yearEntry?.profit || 0,
          isH1Champ: h1Completed && h1Entry?.rank === 1 && (h1Entry?.profit || 0) > 0 && (h1Recap?.gamesCount || 0) >= 4,
          h1Rank: h1Entry?.rank || null,
          isH2Champ: h2Completed && h2Entry?.rank === 1 && (h2Entry?.profit || 0) > 0 && (h2Recap?.gamesCount || 0) >= 4,
          h2Rank: h2Entry?.rank || null,
          months: monthsCells,
        });
      }
    }
  }

  // Assign reigning badge from latest completed month
  if (latestCompletedRecap && latestCompletedRecap.podium[0] && latestCompletedRecap.podium[0].profit > 0) {
    const champId = latestCompletedRecap.podium[0].playerId;
    const cab = cabinets.get(champId);
    if (cab && latestCompletedRecap.month) {
      cab.reigningBadge = {
        label: `👑 אלוף ${HEBREW_MONTHS[latestCompletedRecap.month - 1]}`,
        periodType: 'month',
        year: latestCompletedRecap.year,
        month: latestCompletedRecap.month,
      };
    }
  }

  // Build the max-4 compact pills for each player's mobile card
  for (const cab of cabinets.values()) {
    cab.totalTrophiesCount =
      cab.yearlyChamps.length +
      cab.halfChamps.length +
      cab.monthlyPodiums +
      cab.monthlySnipers +
      cab.monthlyBigHits;

    const pills: CompactTrophyPill[] = [];

    if (cab.yearlyChamps.length > 0) {
      pills.push({
        id: 'year',
        icon: '👑',
        label: 'אלוף שנה',
        count: cab.yearlyChamps.length,
        color: '#fbbf24',
        bg: 'rgba(245, 158, 11, 0.14)',
        border: 'rgba(245, 158, 11, 0.35)',
      });
    }
    if (cab.halfChamps.length > 0) {
      pills.push({
        id: 'half',
        icon: '🏆',
        label: 'אלוף חציון',
        count: cab.halfChamps.length,
        color: '#f59e0b',
        bg: 'rgba(245, 158, 11, 0.1)',
        border: 'rgba(245, 158, 11, 0.28)',
      });
    }
    if (cab.monthlyChamps > 0) {
      pills.push({
        id: 'month_champ',
        icon: '🥇',
        label: 'אלוף חודש',
        count: cab.monthlyChamps,
        color: '#eab308',
        bg: 'rgba(234, 179, 8, 0.12)',
        border: 'rgba(234, 179, 8, 0.3)',
      });
    }
    if (cab.monthlyPodiums > 0) {
      pills.push({
        id: 'month_podium',
        icon: '🏅',
        label: 'פודיום חודש',
        count: cab.monthlyPodiums,
        color: '#38bdf8',
        bg: 'rgba(56, 189, 248, 0.12)',
        border: 'rgba(56, 189, 248, 0.28)',
      });
    }
    if (pills.length < 4 && cab.monthlySnipers > 0) {
      pills.push({
        id: 'sniper',
        icon: '🎯',
        label: 'צלף החודש',
        count: cab.monthlySnipers,
        color: '#34d399',
        bg: 'rgba(52, 211, 153, 0.12)',
        border: 'rgba(52, 211, 153, 0.28)',
      });
    }
    if (pills.length < 4 && cab.monthlyBigHits > 0) {
      pills.push({
        id: 'bighit',
        icon: '💥',
        label: 'שיא החודש',
        count: cab.monthlyBigHits,
        color: '#c084fc',
        bg: 'rgba(192, 132, 252, 0.12)',
        border: 'rgba(192, 132, 252, 0.28)',
      });
    }

    cab.compactPills = pills.slice(0, 4);
  }

  return cabinets;
}

