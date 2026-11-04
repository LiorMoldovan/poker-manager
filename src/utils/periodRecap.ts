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
  topLocation?: { name: string; count: number };
  biggestGamePot?: { pot: number; date: string };
  podium: RecapPlayerEntry[];     // top 3 active players with profit > 0 (or top 3 active)
  allRanked: RecapPlayerEntry[];  // all active players ranked by profit
  awards: {
    sniper?: { playerName: string; winRate: number; wins: number; games: number; profit: number };
    bigHit?: { playerName: string; profit: number; date: string };
    hotStreak?: { playerName: string; streak: number; profit: number };
    atm?: { playerName: string; totalRebuys: number; totalInvested: number; games: number; profit: number };
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

  // 3. ATM / Sponsor (most total rebuys in period)
  const atmCandidate = [...allPlayerEntries]
    .filter(e => e.totalRebuys > 0)
    .sort((a, b) => b.totalRebuys - a.totalRebuys || a.profit - b.profit)[0];

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
    highlights.push(`הקופה האישית הגדולה של התקופה: ${globalBigHit.playerName} התפוצץ עם +₪${globalBigHit.profit.toLocaleString('he-IL')} בערב אחד (${globalBigHit.date}).`);
  }
  if (atmCandidate) {
    if (atmCandidate.profit > 0) {
      highlights.push(`מלך הריבאי שלא מוותר: ${atmCandidate.playerName} רשם ${atmCandidate.totalRebuys} קניות חוזרות (₪${atmCandidate.totalInvested.toLocaleString('he-IL')}) והצליח לסיים ברווח נקי של +₪${atmCandidate.profit.toLocaleString('he-IL')}!`);
    } else {
      highlights.push(`מלך הריבאי והאקשן: ${atmCandidate.playerName} הזרים לקופה ${atmCandidate.totalRebuys} כניסות (₪${atmCandidate.totalInvested.toLocaleString('he-IL')}) שהקפיצו את האקשן בשולחן.`);
    }
  }

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
    topLocation,
    biggestGamePot,
    podium,
    allRanked: rankedList,
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
      atm: atmCandidate
        ? {
            playerName: atmCandidate.playerName,
            totalRebuys: atmCandidate.totalRebuys,
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

