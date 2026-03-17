/**
 * Google Gemini AI Integration for Poker Forecasts
 * Get your API key at: https://aistudio.google.com/app/apikey
 */

import { generateMilestones as generateMilestonesEngine } from './milestones';
import { formatHebrewHalf } from './calculations';
import { Game, PeriodMarkers, PlayerStats, LiveGameTTSPool, TTSPlayerMessages, TTSMessage, TTSRivalry } from '../types';
import { playerTraitsByName } from './playerTraits';
import { getRebuyRecords } from '../database/storage';
import { getComboHistory } from './comboHistory';

// Models ordered by capability — cascading fallback from best to lightest
const API_CONFIGS = [
  { version: 'v1beta', model: 'gemini-3-flash-preview' },
  { version: 'v1beta', model: 'gemini-2.5-pro' },
  { version: 'v1beta', model: 'gemini-3.1-flash-lite-preview' },
  { version: 'v1beta', model: 'gemini-2.5-flash' },
  { version: 'v1beta', model: 'gemini-2.5-flash-lite' },
];

// Track which model last succeeded (readable by UI for display)
let lastUsedModel = '';
export const getLastUsedModel = () => lastUsedModel;

// Store API key in localStorage
const API_KEY_STORAGE = 'gemini_api_key';

export const getGeminiApiKey = (): string | null => {
  return localStorage.getItem(API_KEY_STORAGE);
};

export const setGeminiApiKey = (key: string): void => {
  localStorage.setItem(API_KEY_STORAGE, key);
};

export const clearGeminiApiKey = (): void => {
  localStorage.removeItem(API_KEY_STORAGE);
};

export interface PlayerForecastData {
  name: string;
  isFemale: boolean;
  gamesPlayed: number;
  totalProfit: number;
  avgProfit: number;
  winCount: number;
  lossCount: number;
  winPercentage: number;
  currentStreak: number; // positive = wins, negative = losses
  bestWin: number;
  worstLoss: number;
  // All game results with dates and game IDs (most recent first)
  gameHistory: { profit: number; date: string; gameId: string; location?: string }[];
  daysSinceLastGame: number;
  isActive: boolean; // played in last 2 months
}

export interface ForecastResult {
  name: string;
  expectedProfit: number;
  highlight: string;
  sentence: string;
  isSurprise: boolean;
  preGameTeaser?: string;
}

export type { MilestoneItem } from '../types';
export { generateMilestones, adaptForecastData, getSentimentColors } from './milestones';

const HEBREW_MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

export const detectPeriodMarkers = (
  gameDate: Date,
  allGames: Game[],
  gameNightDays: number[] = [4, 6]
): PeriodMarkers => {
  const year = gameDate.getFullYear();
  const month = gameDate.getMonth();
  const half: 1 | 2 = month < 6 ? 1 : 2;
  const halfEndMonth = half === 1 ? 5 : 11;

  const completedGames = allGames.filter(g => g.status === 'completed');

  const isSameMonth = (d: Date) => d.getFullYear() === year && d.getMonth() === month;
  const isSameHalf = (d: Date) => d.getFullYear() === year && (d.getMonth() < 6 ? 1 : 2) === half;
  const isSameYear = (d: Date) => d.getFullYear() === year;

  const gamesBeforeInMonth = completedGames.filter(g => {
    const d = new Date(g.date || g.createdAt);
    return isSameMonth(d) && d < gameDate;
  });
  const gamesBeforeInHalf = completedGames.filter(g => {
    const d = new Date(g.date || g.createdAt);
    return isSameHalf(d) && d < gameDate;
  });
  const gamesBeforeInYear = completedGames.filter(g => {
    const d = new Date(g.date || g.createdAt);
    return isSameYear(d) && d < gameDate;
  });

  const hasRemainingGameNight = (afterDate: Date, endMonth: number, endYear: number): boolean => {
    const d = new Date(afterDate);
    d.setDate(d.getDate() + 1);
    const endDate = new Date(endYear, endMonth + 1, 0, 23, 59, 59);
    while (d <= endDate) {
      if (gameNightDays.includes(d.getDay())) return true;
      d.setDate(d.getDate() + 1);
    }
    return false;
  };

  return {
    isFirstGameOfMonth: gamesBeforeInMonth.length === 0,
    isLastGameOfMonth: !hasRemainingGameNight(gameDate, month, year),
    isFirstGameOfHalf: gamesBeforeInHalf.length === 0,
    isLastGameOfHalf: !hasRemainingGameNight(gameDate, halfEndMonth, year),
    isFirstGameOfYear: gamesBeforeInYear.length === 0,
    isLastGameOfYear: !hasRemainingGameNight(gameDate, 11, year),
    monthName: HEBREW_MONTHS[month],
    halfLabel: formatHebrewHalf(half, year),
    year,
  };
};

/**
 * Global ranking context for accurate table rankings
 * Rankings should be calculated among ACTIVE players only (33% threshold)
 */
export interface GlobalRankingContext {
  // All-time rankings (among active players with 33% of all games)
  allTime: {
    totalActivePlayers: number;
    totalGames: number;
    threshold: number; // minimum games to be "active"
    rankings: { name: string; rank: number; profit: number; gamesPlayed: number }[];
  };
  // Current year rankings (among active players with 33% of this year's games)
  currentYear: {
    year: number;
    totalActivePlayers: number;
    totalGames: number;
    threshold: number;
    rankings: { name: string; rank: number; profit: number; gamesPlayed: number }[];
  };
  // Current half rankings
  currentHalf: {
    half: 1 | 2;
    year: number;
    totalActivePlayers: number;
    totalGames: number;
    threshold: number;
    rankings: { name: string; rank: number; profit: number; gamesPlayed: number }[];
  };
}


/**
 * Analyze location data and return insights only when genuinely interesting.
 * Returns an empty string if location is absent, insufficient data, or nothing notable.
 */
export const buildLocationInsights = (
  players: { name: string; gameHistory: { profit: number; date: string; location?: string }[]; avgProfit: number }[],
  location?: string,
  allGamesWithLocations?: { location?: string; date: string }[]
): string => {
  if (!location) return '';

  const insights: string[] = [];

  // Per-player: compare performance at this location vs overall (need >= 3 games)
  for (const p of players) {
    const gamesHere = p.gameHistory.filter(g => g.location === location);
    if (gamesHere.length < 3) continue;
    const avgHere = Math.round(gamesHere.reduce((s, g) => s + g.profit, 0) / gamesHere.length);
    const overallAvg = Math.round(p.avgProfit);
    const diff = avgHere - overallAvg;
    if (Math.abs(diff) >= 20) {
      const tag = diff > 0 ? 'קמע' : 'מקולל';
      insights.push(`${p.name} ${tag} אצל ${location}: ממוצע ${avgHere >= 0 ? '+' : ''}${avgHere}₪ ב-${gamesHere.length} משחקים (לעומת ${overallAvg >= 0 ? '+' : ''}${overallAvg}₪ כלל)`);
    }
  }

  // Group-level: haven't played here in a while?
  if (allGamesWithLocations) {
    const gamesAtLoc = allGamesWithLocations
      .filter(g => g.location === location)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    if (gamesAtLoc.length > 0) {
      const lastDate = new Date(gamesAtLoc[0].date);
      const daysSince = Math.round((Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
      if (daysSince > 30) {
        insights.push(`חזרה אצל ${location} אחרי ${daysSince} יום! פעם אחרונה: ${lastDate.toLocaleDateString('he-IL', { day: 'numeric', month: 'short' })}`);
      }
    } else {
      insights.push(`פעם ראשונה שהקבוצה משחקת אצל ${location}!`);
    }

  }

  if (insights.length === 0) return '';
  return `🏠 תובנות מיקום (אצל ${location}):\n${insights.join('\n')}`;
};

/**
 * Generate AI-powered forecasts for selected players only
 */
export const generateAIForecasts = async (
  players: PlayerForecastData[],
  globalRankings?: GlobalRankingContext,
  periodMarkers?: PeriodMarkers,
  location?: string,
  comboHistoryText?: string
): Promise<ForecastResult[]> => {
  const apiKey = getGeminiApiKey();
  
  if (!apiKey) {
    throw new Error('NO_API_KEY');
  }

  // Calculate ALL-TIME RECORDS for the group
  const allTimeRecords: string[] = [];
  
  // Find record holders among tonight's players
  const sortedByTotalProfit = [...players].sort((a, b) => b.totalProfit - a.totalProfit);
  const sortedByBestWin = [...players].sort((a, b) => b.bestWin - a.bestWin);
  const sortedByWorstLoss = [...players].sort((a, b) => a.worstLoss - b.worstLoss);
  const sortedByWinRate = [...players].filter(p => p.gamesPlayed >= 5).sort((a, b) => b.winPercentage - a.winPercentage);
  const sortedByGames = [...players].sort((a, b) => b.gamesPlayed - a.gamesPlayed);
  const sortedByAvg = [...players].filter(p => p.gamesPlayed >= 3).sort((a, b) => b.avgProfit - a.avgProfit);
  
  // Highest all-time profit
  if (sortedByTotalProfit[0]?.totalProfit > 0) {
    allTimeRecords.push(`🥇 All-Time Profit Leader: ${sortedByTotalProfit[0].name} with +${sortedByTotalProfit[0].totalProfit}₪ total`);
  }
  
  // Biggest single-night win
  if (sortedByBestWin[0]?.bestWin > 0) {
    allTimeRecords.push(`💰 Biggest Single-Night Win: ${sortedByBestWin[0].name} once won +${sortedByBestWin[0].bestWin}₪`);
  }
  
  // Biggest single-night loss
  if (sortedByWorstLoss[0]?.worstLoss < 0) {
    allTimeRecords.push(`📉 Biggest Single-Night Loss: ${sortedByWorstLoss[0].name} once lost ${sortedByWorstLoss[0].worstLoss}₪`);
  }
  
  // Highest win rate (min 5 games)
  if (sortedByWinRate.length > 0) {
    allTimeRecords.push(`🎯 Best Win Rate: ${sortedByWinRate[0].name} wins ${Math.round(sortedByWinRate[0].winPercentage)}% of games (${sortedByWinRate[0].winCount}/${sortedByWinRate[0].gamesPlayed})`);
  }
  
  // Most games played
  if (sortedByGames[0]?.gamesPlayed > 0) {
    allTimeRecords.push(`🎮 Most Games Played: ${sortedByGames[0].name} with ${sortedByGames[0].gamesPlayed} games`);
  }
  
  // Best average (min 3 games)
  if (sortedByAvg.length > 0 && sortedByAvg[0].avgProfit > 0) {
    allTimeRecords.push(`📊 Best Average: ${sortedByAvg[0].name} averages +${Math.round(sortedByAvg[0].avgProfit)}₪ per game`);
  }
  
  // Longest current winning streak
  const longestWinStreak = players.reduce((max, p) => p.currentStreak > max.streak ? { name: p.name, streak: p.currentStreak } : max, { name: '', streak: 0 });
  if (longestWinStreak.streak >= 2) {
    allTimeRecords.push(`🔥 Current Hot Streak: ${longestWinStreak.name} is on a ${longestWinStreak.streak}-game winning streak`);
  }
  
  // Longest current losing streak
  const longestLoseStreak = players.reduce((max, p) => p.currentStreak < max.streak ? { name: p.name, streak: p.currentStreak } : max, { name: '', streak: 0 });
  if (longestLoseStreak.streak <= -2) {
    allTimeRecords.push(`❄️ Cold Streak: ${longestLoseStreak.name} is on a ${Math.abs(longestLoseStreak.streak)}-game losing streak`);
  }
  
  const allTimeRecordsText = allTimeRecords.length > 0 ? allTimeRecords.join('\n') : '';

  // ========== CALCULATE MILESTONES (via shared engine) ==========
  const milestonePlayersForPrompt = players.map(p => ({
    id: p.name, name: p.name, gamesPlayed: p.gamesPlayed, totalProfit: p.totalProfit,
    avgProfit: p.avgProfit, winCount: p.winCount, lossCount: p.lossCount,
    winPercentage: p.winPercentage, currentStreak: p.currentStreak,
    longestWinStreak: 0, longestLossStreak: 0, biggestWin: p.bestWin, biggestLoss: p.worstLoss,
    avgRebuysPerGame: 0, totalRebuys: 0, avgWin: 0, avgLoss: 0, gameHistory: p.gameHistory,
  }));
  const milestoneItems = generateMilestonesEngine(milestonePlayersForPrompt, { mode: 'tonight' });
  const milestonesText = milestoneItems.map(m => `${m.emoji} ${m.title}: ${m.description}`).join('\n');

  // Helper: Parse date from game history (handles multiple formats)
  const parseGameDate = (dateStr: string): Date => {
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
  };
  
  // Current date info
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const currentHalf = currentMonth < 6 ? 1 : 2; // H1 = Jan-Jun, H2 = Jul-Dec
  const halfStartMonth = currentHalf === 1 ? 0 : 6;
  
  // Calculate period-specific stats for each player
  const playerPeriodStats = players.map(p => {
    const thisYearGames = p.gameHistory.filter(g => {
      const d = parseGameDate(g.date);
      return d.getFullYear() === currentYear;
    });
    const thisHalfGames = p.gameHistory.filter(g => {
      const d = parseGameDate(g.date);
      return d.getFullYear() === currentYear && d.getMonth() >= halfStartMonth && d.getMonth() < halfStartMonth + 6;
    });
    const thisMonthGames = p.gameHistory.filter(g => {
      const d = parseGameDate(g.date);
      return d.getFullYear() === currentYear && d.getMonth() === currentMonth;
    });
    const last5Games = p.gameHistory.slice(0, 5);
    
    return {
      // Original data first
      ...p,
      // This year (calculated stats)
      yearProfit: thisYearGames.reduce((sum, g) => sum + g.profit, 0),
      yearGames: thisYearGames.length,
      yearWins: thisYearGames.filter(g => g.profit > 0).length,
      // This half
      halfProfit: thisHalfGames.reduce((sum, g) => sum + g.profit, 0),
      halfGames: thisHalfGames.length,
      halfWins: thisHalfGames.filter(g => g.profit > 0).length,
      // This month
      monthProfit: thisMonthGames.reduce((sum, g) => sum + g.profit, 0),
      monthGames: thisMonthGames.length,
      monthWins: thisMonthGames.filter(g => g.profit > 0).length,
      // Last 5 games
      last5Profit: last5Games.reduce((sum, g) => sum + g.profit, 0),
      last5Wins: last5Games.filter(g => g.profit > 0).length,
    };
  });
  
  // Old milestone generators removed — using shared engine above
  

  // ========== TONIGHT'S STORYLINES - Deep pool of head-to-head matchups & narratives ==========
  const storylines: string[] = [];

  // Build a map: gameId → list of { name, profit } for tonight's players
  const gameParticipation: Record<string, { name: string; profit: number }[]> = {};
  for (const p of players) {
    for (const g of p.gameHistory) {
      if (!gameParticipation[g.gameId]) gameParticipation[g.gameId] = [];
      gameParticipation[g.gameId].push({ name: p.name, profit: g.profit });
    }
  }

  // Head-to-head: for each pair, compute shared game records + money flow + consecutive wins
  const h2hResults: {
    a: string; b: string; aWins: number; bWins: number; sharedGames: number;
    aTotalProfit: number; bTotalProfit: number;
    aAvgWhenTogether: number; bAvgWhenTogether: number;
    aConsecutiveWins: number; bConsecutiveWins: number;
    lastGameAProfit: number; lastGameBProfit: number;
  }[] = [];

  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const pA = players[i], pB = players[j];
      const aGameIds = new Set(pA.gameHistory.map(g => g.gameId));
      const sharedGameIds = pB.gameHistory.filter(g => aGameIds.has(g.gameId)).map(g => g.gameId);
      if (sharedGameIds.length < 2) continue;

      let aWins = 0, bWins = 0, aTotalProfit = 0, bTotalProfit = 0;
      const results: { aWon: boolean; bWon: boolean; aProfit: number; bProfit: number; date: string }[] = [];

      for (const gid of sharedGameIds) {
        const aGame = pA.gameHistory.find(g => g.gameId === gid);
        const bGame = pB.gameHistory.find(g => g.gameId === gid);
        if (!aGame || !bGame) continue;
        const aWon = aGame.profit > bGame.profit;
        const bWon = bGame.profit > aGame.profit;
        if (aWon) aWins++;
        if (bWon) bWins++;
        aTotalProfit += aGame.profit;
        bTotalProfit += bGame.profit;
        results.push({ aWon, bWon, aProfit: aGame.profit, bProfit: bGame.profit, date: aGame.date });
      }

      // Sort by date (most recent first) and compute consecutive wins
      results.sort((a, b) => parseGameDate(b.date).getTime() - parseGameDate(a.date).getTime());
      let aConsec = 0, bConsec = 0;
      for (const r of results) {
        if (r.aWon) { aConsec++; } else break;
      }
      if (aConsec === 0) {
        for (const r of results) {
          if (r.bWon) { bConsec++; } else break;
        }
      }

      h2hResults.push({
        a: pA.name, b: pB.name, aWins, bWins,
        sharedGames: sharedGameIds.length,
        aTotalProfit, bTotalProfit,
        aAvgWhenTogether: Math.round(aTotalProfit / sharedGameIds.length),
        bAvgWhenTogether: Math.round(bTotalProfit / sharedGameIds.length),
        aConsecutiveWins: aConsec, bConsecutiveWins: bConsec,
        lastGameAProfit: results[0]?.aProfit || 0,
        lastGameBProfit: results[0]?.bProfit || 0,
      });
    }
  }

  // === STORYLINE TYPE 1: Dominance ===
  const dominance = h2hResults
    .filter(h => h.sharedGames >= 4 && (h.aWins >= h.sharedGames * 0.7 || h.bWins >= h.sharedGames * 0.7))
    .sort((a, b) => Math.max(b.aWins, b.bWins) / b.sharedGames - Math.max(a.aWins, a.bWins) / a.sharedGames);
  for (const d of dominance.slice(0, 2)) {
    const winner = d.aWins > d.bWins ? d.a : d.b;
    const loser = d.aWins > d.bWins ? d.b : d.a;
    const wins = Math.max(d.aWins, d.bWins);
    storylines.push(`🥊 שליטה: ${winner} ניצח את ${loser} ב-${wins} מתוך ${d.sharedGames} משחקים משותפים`);
  }

  // === STORYLINE TYPE 2: Close rivalry ===
  const rivalries = h2hResults
    .filter(h => h.sharedGames >= 5 && Math.abs(h.aWins - h.bWins) <= 1)
    .sort((a, b) => b.sharedGames - a.sharedGames);
  for (const r of rivalries.slice(0, 2)) {
    storylines.push(`⚔️ יריבות: ${r.a} ו${r.b} כמעט שווים - ${r.aWins}:${r.bWins} ב-${r.sharedGames} משחקים משותפים. מי ישבור שוויון?`);
  }

  // === STORYLINE TYPE 3: Revenge game ===
  for (const h of h2hResults) {
    if (h.sharedGames < 3) continue;
    const profitDiff = Math.abs(h.lastGameAProfit - h.lastGameBProfit);
    if (profitDiff >= 80) {
      const loser = h.lastGameAProfit < h.lastGameBProfit ? h.a : h.b;
      const winner = h.lastGameAProfit < h.lastGameBProfit ? h.b : h.a;
      const loserProfit = Math.round(Math.min(h.lastGameAProfit, h.lastGameBProfit));
      const winnerProfit = Math.round(Math.max(h.lastGameAProfit, h.lastGameBProfit));
      storylines.push(`🔥 נקמה: ${loser} סיים עם ${loserProfit}₪ בזמן ש${winner} סגר על +${winnerProfit}₪ במשחק האחרון - הפעם משחק הנקמה?`);
    }
  }

  // === STORYLINE TYPE 4: Lucky charm / bad luck ===
  for (const p of players) {
    if (p.gamesPlayed < 5) continue;
    for (const other of players) {
      if (other.name === p.name) continue;
      const h = h2hResults.find(r =>
        (r.a === p.name && r.b === other.name) || (r.b === p.name && r.a === other.name)
      );
      if (!h || h.sharedGames < 4) continue;
      const avgTogether = h.a === p.name ? h.aAvgWhenTogether : h.bAvgWhenTogether;
      const diff = avgTogether - p.avgProfit;
      if (diff >= 25) {
        storylines.push(`🍀 קמע: ${p.name} מרוויח בממוצע ${avgTogether >= 0 ? '+' : ''}${avgTogether}₪ כש${other.name} משחק (לעומת ${Math.round(p.avgProfit) >= 0 ? '+' : ''}${Math.round(p.avgProfit)}₪ בד"כ)`);
      } else if (diff <= -25) {
        storylines.push(`😈 עין הרע: ${p.name} בממוצע ${avgTogether}₪ כש${other.name} בשולחן (לעומת ${Math.round(p.avgProfit) >= 0 ? '+' : ''}${Math.round(p.avgProfit)}₪ בד"כ)`);
      }
    }
  }

  // === STORYLINE TYPE 5: Group dynamics ===
  for (const p of players) {
    if (p.gamesPlayed < 8) continue;
    const fewOverlap: number[] = [], manyOverlap: number[] = [];
    for (const g of p.gameHistory) {
      const count = gameParticipation[g.gameId]?.length || 1;
      if (count <= 3) fewOverlap.push(g.profit);
      else if (count >= 5) manyOverlap.push(g.profit);
    }
    if (fewOverlap.length >= 3 && manyOverlap.length >= 3) {
      const fewAvg = Math.round(fewOverlap.reduce((a, b) => a + b, 0) / fewOverlap.length);
      const manyAvg = Math.round(manyOverlap.reduce((a, b) => a + b, 0) / manyOverlap.length);
      if (Math.abs(fewAvg - manyAvg) >= 30) {
        const better = manyAvg > fewAvg;
        storylines.push(`📊 ${better ? 'חברה טובה' : 'צר בשולחן'}: ${p.name} בממוצע ${better ? (manyAvg >= 0 ? '+' : '') + manyAvg : (fewAvg >= 0 ? '+' : '') + fewAvg}₪ ${better ? 'כשרוב החבר\'ה ביחד' : 'עם פחות שחקנים'} לעומת ${better ? (fewAvg >= 0 ? '+' : '') + fewAvg : (manyAvg >= 0 ? '+' : '') + manyAvg}₪`);
      }
    }
  }

  // === STORYLINE TYPE 6: Nemesis (profit gap in shared games) ===
  for (const h of h2hResults) {
    if (h.sharedGames < 4) continue;
    const profitGap = h.aTotalProfit - h.bTotalProfit;
    if (Math.abs(profitGap) >= 200) {
      const stronger = profitGap > 0 ? h.a : h.b;
      const weaker = profitGap > 0 ? h.b : h.a;
      const strongerTotal = profitGap > 0 ? h.aTotalProfit : h.bTotalProfit;
      const weakerTotal = profitGap > 0 ? h.bTotalProfit : h.aTotalProfit;
      storylines.push(`💸 נמסיס: ב-${h.sharedGames} משחקים משותפים, ${stronger} הרוויח סה"כ ${strongerTotal >= 0 ? '+' : ''}${Math.round(strongerTotal)}₪ ואילו ${weaker} סיים עם ${weakerTotal >= 0 ? '+' : ''}${Math.round(weakerTotal)}₪ — פער של ${Math.abs(Math.round(profitGap))}₪`);
    }
  }

  // === STORYLINE TYPE 7: H2H win streak ===
  for (const h of h2hResults) {
    const consec = Math.max(h.aConsecutiveWins, h.bConsecutiveWins);
    if (consec >= 3) {
      const streaker = h.aConsecutiveWins > h.bConsecutiveWins ? h.a : h.b;
      const victim = h.aConsecutiveWins > h.bConsecutiveWins ? h.b : h.a;
      storylines.push(`🔥 רצף מול: ${streaker} ניצח את ${victim} ${consec} פעמים ברצף! ישבור את הרצף הפעם?`);
    }
  }

  // === STORYLINE TYPE 8: First encounter ===
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      if (players[i].gamesPlayed === 0 || players[j].gamesPlayed === 0) continue;
      const hasH2H = h2hResults.some(h =>
        (h.a === players[i].name && h.b === players[j].name) ||
        (h.b === players[i].name && h.a === players[j].name)
      );
      if (!hasH2H) {
        const aIds = new Set(players[i].gameHistory.map(g => g.gameId));
        const shared = players[j].gameHistory.filter(g => aIds.has(g.gameId));
        if (shared.length === 0) {
          storylines.push(`🤝 פגישה ראשונה: ${players[i].name} ו${players[j].name} מעולם לא שיחקו ביחד! ערב היסטורי`);
        }
      }
    }
  }

  // === STORYLINE TYPE 9: Ranking duel ===
  const sortedByYearProfitStory = [...playerPeriodStats].sort((a, b) => b.yearProfit - a.yearProfit);
  for (let i = 0; i < sortedByYearProfitStory.length - 1; i++) {
    const gap = sortedByYearProfitStory[i].yearProfit - sortedByYearProfitStory[i + 1].yearProfit;
    if (gap >= 0 && gap <= 50 && sortedByYearProfitStory[i].yearGames >= 2) {
      storylines.push(`🏆 קרב דירוג: ${sortedByYearProfitStory[i].name} ו${sortedByYearProfitStory[i + 1].name} רק ${gap}₪ הפרש בטבלת ${currentYear}! המשחק הבא מכריע מי מקום ${i + 1}`);
    }
  }

  // === STORYLINE TYPE 10: Comeback trail ===
  for (const p of players) {
    if (p.gamesPlayed < 8 || p.totalProfit >= 0) continue;
    const last5 = p.gameHistory.slice(0, 5);
    const last5Profit = last5.reduce((s, g) => s + g.profit, 0);
    if (last5Profit > 50 && p.totalProfit < -100) {
      storylines.push(`💪 קאמבק: ${p.name} על ${Math.round(p.totalProfit)}₪ כולל, אבל ב-5 משחקים אחרונים +${Math.round(last5Profit)}₪. המגמה מתהפכת!`);
    }
  }

  // === STORYLINE TYPE 11: Location insights (only when genuinely interesting) ===
  // Aggregate all game history for group-level location analysis
  const allGameHistories = new Map<string, { location?: string; date: string }>();
  for (const p of players) {
    for (const g of p.gameHistory) {
      if (!allGameHistories.has(g.gameId)) {
        allGameHistories.set(g.gameId, { location: g.location, date: g.date });
      }
    }
  }
  const locationInsightsText = buildLocationInsights(players, location, Array.from(allGameHistories.values()));

  // === STORYLINE TYPE 12: Milestone chase ===
  for (const p of players) {
    if (p.gamesPlayed < 5) continue;
    const currentWinRate = p.winPercentage;
    if (currentWinRate >= 45 && currentWinRate < 50) {
      const winsNeeded = Math.ceil(0.50 * (p.gamesPlayed + 1)) - p.winCount;
      if (winsNeeded === 1) {
        storylines.push(`🎯 אבן דרך: ${p.name} על ${Math.round(currentWinRate)}% נצחונות - עוד נצחון אחד = חציית 50%!`);
      }
    }
    if (p.currentStreak >= 3) {
      storylines.push(`📈 שיא אישי: ${p.name} ברצף של ${p.currentStreak} נצחונות. עוד נצחון = ${p.currentStreak + 1} ברצף!`);
    }
  }

  // === STORYLINE TYPE 13: Polar opposites ===
  const playersWithVolatility = players.filter(p => p.gamesPlayed >= 5).map(p => {
    const recent = p.gameHistory.slice(0, 10).map(g => g.profit);
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const variance = recent.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / recent.length;
    return { name: p.name, stdDev: Math.sqrt(variance), avgProfit: p.avgProfit };
  }).sort((a, b) => b.stdDev - a.stdDev);
  if (playersWithVolatility.length >= 2) {
    const wildest = playersWithVolatility[0];
    const calmest = playersWithVolatility[playersWithVolatility.length - 1];
    if (wildest.stdDev > calmest.stdDev * 2) {
      storylines.push(`🎭 ניגודים: ${wildest.name} תנודתי (סטייה ${Math.round(wildest.stdDev)}₪) מול ${calmest.name} יציב (סטייה ${Math.round(calmest.stdDev)}₪) - שני סגנונות שונים לגמרי`);
    }
  }

  // === STORYLINE TYPE 14: Money magnet (biggest contributor to tonight's group) ===
  const totalContributions = players.filter(p => p.gamesPlayed >= 3).map(p => {
    let contributed = 0;
    for (const h of h2hResults) {
      if (h.a === p.name) contributed += h.aTotalProfit;
      else if (h.b === p.name) contributed += h.bTotalProfit;
    }
    return { name: p.name, contributed: Math.round(contributed) };
  }).sort((a, b) => a.contributed - b.contributed);
  if (totalContributions.length >= 2 && totalContributions[0].contributed < -150) {
    storylines.push(`🧲 ספונסר: ${totalContributions[0].name} בסה"כ ${totalContributions[0].contributed}₪ במשחקים משותפים עם השחקנים המשתתפים, בעוד ${totalContributions[totalContributions.length - 1].name} הרוויח +${totalContributions[totalContributions.length - 1].contributed}₪`);
  }

  // === STORYLINE TYPE 15: Hot/cold group trend ===
  const groupLast3 = players.filter(p => p.gameHistory.length >= 3);
  if (groupLast3.length >= 4) {
    const onHotStreak = groupLast3.filter(p => p.currentStreak >= 2).length;
    const onColdStreak = groupLast3.filter(p => p.currentStreak <= -2).length;
    if (onHotStreak >= 3) {
      const names = groupLast3.filter(p => p.currentStreak >= 2).map(p => p.name).join(', ');
      storylines.push(`🌡️ גל חום: ${onHotStreak} שחקנים ברצף נצחונות (${names}) - ערב של מנצחים!`);
    } else if (onColdStreak >= 3) {
      const names = groupLast3.filter(p => p.currentStreak <= -2).map(p => p.name).join(', ');
      storylines.push(`❄️ גל קור: ${onColdStreak} שחקנים ברצף הפסדים (${names}) - מי ישבור את הסדרה?`);
    }
  }

  // Shuffle and pick up to 8 storylines, trying to cover as many players as possible
  const allStorylines = [...storylines];
  const pickedStorylines: string[] = [];
  const coveredPlayers = new Set<string>();
  const shuffled = allStorylines.sort(() => Math.random() - 0.5);
  const maxStorylines = Math.min(8, Math.max(players.length, 5));

  // First pass: pick storylines that cover uncovered players
  for (const s of shuffled) {
    if (pickedStorylines.length >= maxStorylines) break;
    const mentionedPlayers = players.filter(p => s.includes(p.name));
    const coversNew = mentionedPlayers.some(p => !coveredPlayers.has(p.name));
    if (coversNew) {
      pickedStorylines.push(s);
      mentionedPlayers.forEach(p => coveredPlayers.add(p.name));
    }
  }
  // Second pass: fill remaining slots
  for (const s of shuffled) {
    if (pickedStorylines.length >= maxStorylines) break;
    if (!pickedStorylines.includes(s)) {
      pickedStorylines.push(s);
    }
  }

  const storylinesText = pickedStorylines.length > 0 ? pickedStorylines.join('\n') : '';
  console.log(`📖 Storylines: ${pickedStorylines.length} picked from ${allStorylines.length} available`);

  // ========== SIMPLIFIED PREDICTION ALGORITHM ==========
  // Robust, data-informed: uses median magnitude + group-level clamping to avoid outliers

  // Helper: Get games for a specific half-year period
  const getHalfGames = (player: typeof players[0], year: number, half: 1 | 2) => {
    const startMonth = half === 1 ? 0 : 6;
    const endMonth = half === 1 ? 5 : 11;
    return player.gameHistory.filter(g => {
      const d = parseGameDate(g.date);
      return d.getFullYear() === year && d.getMonth() >= startMonth && d.getMonth() <= endMonth;
    });
  };
  const getPreviousPeriod = () => {
    if (currentHalf === 1) return { year: currentYear - 1, half: 2 as const, label: formatHebrewHalf(2, currentYear - 1) };
    return { year: currentYear, half: 1 as const, label: formatHebrewHalf(1, currentYear) };
  };
  const currentPeriodLabel = formatHebrewHalf(currentHalf, currentYear);
  const prevPeriod = getPreviousPeriod();

  // ========== GAME SHAPE SAMPLING PREDICTION ALGORITHM ==========
  // Instead of predicting each player independently (which produces lopsided 1-winner distributions),
  // we sample a real game's profit distribution as a template and assign players to slots
  // based on their strength ranking. This guarantees realistic spread by construction.

  const halfGamesMap = new Map(players.map(p => {
    const hg = getHalfGames(p, currentYear, currentHalf);
    const avg = hg.length > 0 ? hg.reduce((s, g) => s + g.profit, 0) / hg.length : 0;
    return [p.name, { games: hg, avg }];
  }));

  const n = players.length;

  // STEP 1: Collect game templates from localStorage (full game shapes, not just tonight's players)
  let templates: number[][] = [];
  try {
    const storedGames: Game[] = JSON.parse(localStorage.getItem('poker_games') || '[]');
    const storedGPs: { gameId: string; profit: number }[] = JSON.parse(localStorage.getItem('poker_game_players') || '[]');
    const completedIds = new Set(storedGames.filter(g => g.status === 'completed').map(g => g.id));
    const gameProfits = new Map<string, number[]>();
    for (const gp of storedGPs) {
      if (!completedIds.has(gp.gameId)) continue;
      if (!gameProfits.has(gp.gameId)) gameProfits.set(gp.gameId, []);
      gameProfits.get(gp.gameId)!.push(gp.profit);
    }
    for (const [, profits] of gameProfits) {
      if (profits.length >= n - 1 && profits.length <= n + 1 && profits.length >= 5) {
        const sum = profits.reduce((s, v) => s + v, 0);
        const normalized = profits.map(v => v - sum / profits.length);
        normalized.sort((a, b) => b - a);
        templates.push(normalized);
      }
    }
  } catch {
    console.warn('⚠️ Could not load game templates from storage');
  }

  // Fallback: reconstruct templates from tonight's players' game histories
  if (templates.length < 3) {
    const gameMap = new Map<string, number[]>();
    for (const p of players) {
      for (const g of p.gameHistory) {
        if (!gameMap.has(g.gameId)) gameMap.set(g.gameId, []);
        gameMap.get(g.gameId)!.push(g.profit);
      }
    }
    for (const [, profits] of gameMap) {
      if (profits.length >= Math.max(5, n - 2)) {
        const sum = profits.reduce((s, v) => s + v, 0);
        const normalized = profits.map(v => v - sum / profits.length);
        normalized.sort((a, b) => b - a);
        templates.push(normalized);
      }
    }
  }

  console.log(`🎰 Template pool: ${templates.length} game shapes available for ${n} players`);

  // STEP 2: Pick a template or generate synthetic fallback
  let template: number[];
  if (templates.length >= 3) {
    template = [...templates[Math.floor(Math.random() * templates.length)]];
  } else {
    // Synthetic fallback based on observed real data patterns:
    // 3 winners for 7p, 3-4 for 8p; top winner ≈ 2x second; magnitudes in 40-200 range
    const winnersCount = n <= 7 ? 3 : (Math.random() < 0.5 ? 3 : 4);
    const losersCount = n - winnersCount;
    const synth: number[] = [];
    const topWin = 80 + Math.random() * 120;
    for (let i = 0; i < winnersCount; i++) {
      const factor = i === 0 ? 1 : 1 / (1.5 + i * 0.4);
      synth.push(Math.round(topWin * factor));
    }
    const totalPos = synth.reduce((s, v) => s + v, 0);
    let remaining = totalPos;
    for (let i = 0; i < losersCount; i++) {
      if (i === losersCount - 1) {
        synth.push(-remaining);
      } else {
        const share = Math.round(remaining * (0.15 + Math.random() * 0.25));
        synth.push(-share);
        remaining -= share;
      }
    }
    synth.sort((a, b) => b - a);
    template = synth;
    console.log('🎲 Using synthetic template (not enough historical games)');
  }

  // Interpolate template to match tonight's player count
  if (template.length < n) {
    while (template.length < n) {
      const mid = Math.floor(template.length / 2);
      template.splice(mid, 0, 0);
    }
  } else if (template.length > n) {
    while (template.length > n) {
      let minIdx = 0;
      let minAbs = Infinity;
      for (let i = 0; i < template.length; i++) {
        if (Math.abs(template[i]) < minAbs) { minAbs = Math.abs(template[i]); minIdx = i; }
      }
      const removed = template.splice(minIdx, 1)[0];
      const totalAbs = template.reduce((s, v) => s + Math.abs(v), 0);
      if (totalAbs > 0 && removed !== 0) {
        template = template.map(v => Math.round(v - removed * (Math.abs(v) / totalAbs)));
      }
    }
  }
  // Ensure zero-sum after interpolation
  const templateSum = template.reduce((s, v) => s + v, 0);
  if (templateSum !== 0) {
    const adj = templateSum / template.length;
    template = template.map(v => Math.round(v - adj));
    const residual = template.reduce((s, v) => s + v, 0);
    if (residual !== 0) {
      const smIdx = template.reduce((mi, v, i) => Math.abs(v) < Math.abs(template[mi]) ? i : mi, 0);
      template[smIdx] -= residual;
    }
  }
  template.sort((a, b) => b - a);

  // STEP 3: Rank players by holistic strength score using ALL available data
  const strengthScores = players.map(p => {
    if (p.gamesPlayed === 0) return { name: p.name, score: 0, volatility: 100 };

    const halfData = halfGamesMap.get(p.name);
    const periodAvg = halfData && halfData.games.length > 0 ? halfData.avg : p.avgProfit;

    // Recent momentum: weighted average of last 5 games (most recent game = 5x weight of 5th)
    const last5 = p.gameHistory.slice(0, Math.min(5, p.gameHistory.length));
    const weights = last5.map((_, i) => last5.length - i);
    const totalWeight = weights.reduce((s, w) => s + w, 0);
    const recentMomentum = last5.reduce((s, g, i) => s + g.profit * weights[i], 0) / totalWeight;

    // All-time average — the historical baseline that grounds the prediction
    const allTimeAvg = p.avgProfit;

    // Win rate advantage centered at 50%, scaled so ±25% difference is meaningful
    const winRateScore = (p.winPercentage - 50) * 1.5;

    // Streak value weighted by actual profit magnitude (not just count)
    let streakValue = 0;
    if (p.currentStreak !== 0) {
      const streakLen = Math.min(Math.abs(p.currentStreak), 5);
      const streakGames = p.gameHistory.slice(0, streakLen);
      const streakAvgProfit = streakGames.reduce((s, g) => s + g.profit, 0) / streakGames.length;
      streakValue = streakLen * streakAvgProfit * 0.05;
    }

    // Freshness: penalty for long absences (rust factor)
    const freshness = p.daysSinceLastGame > 30 ? -15 : p.daysSinceLastGame > 14 ? -5 : 0;

    // Volatility (stddev of recent results) — used for per-player noise, not scoring
    const recent10 = p.gameHistory.slice(0, Math.min(10, p.gameHistory.length)).map(g => g.profit);
    const recentMean = recent10.reduce((s, v) => s + v, 0) / recent10.length;
    const volatility = recent10.length >= 3
      ? Math.sqrt(recent10.reduce((s, v) => s + (v - recentMean) ** 2, 0) / recent10.length)
      : 80;

    const score = periodAvg * 0.30 + recentMomentum * 0.25 + allTimeAvg * 0.15
                + winRateScore * 0.15 + streakValue * 0.10 + freshness * 0.05;

    return { name: p.name, score, volatility };
  });

  // Compute score spread for surprise modifiers and temperature calibration
  const rawScores = strengthScores.map(s => s.score);
  const scoreMean = rawScores.reduce((a, b) => a + b, 0) / rawScores.length;
  const scoreStdDev = rawScores.length >= 2
    ? Math.sqrt(rawScores.reduce((s, v) => s + (v - scoreMean) ** 2, 0) / rawScores.length)
    : 50;

  // STEP 3b: Surprise detection (same conditions as before)
  type SurpriseType = 'underdog_rise' | 'top_dog_fall' | 'wild_card' | 'breakout' | 'streak_breaker' | 'dark_horse';
  const surpriseCandidates: { name: string; type: SurpriseType; description: string }[] = [];

  for (const p of players) {
    if (p.gamesPlayed < 3) continue;
    const halfData = halfGamesMap.get(p.name);
    const halfAvg = halfData?.avg || 0;

    if (p.avgProfit < -15 && halfAvg > 20) {
      surpriseCandidates.push({ name: p.name, type: 'underdog_rise',
        description: `היסטוריה שלילית (${Math.round(p.avgProfit)}₪) אבל פורמה חיובית (${Math.round(halfAvg)}₪) - הפתעה חיובית!` });
    }
    if (p.avgProfit > 25 && halfAvg < -15) {
      surpriseCandidates.push({ name: p.name, type: 'top_dog_fall',
        description: `שחקן חזק (ממוצע ${Math.round(p.avgProfit)}₪) בפורמה שלילית (${Math.round(halfAvg)}₪) - הפתעה שלילית!` });
    }
    if (p.gamesPlayed >= 8) {
      const recent = p.gameHistory.slice(0, 10).map(g => g.profit);
      const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
      const stdDev = Math.sqrt(recent.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / recent.length);
      if (stdDev > 120) {
        surpriseCandidates.push({ name: p.name, type: 'wild_card',
          description: `שחקן תנודתי (סטייה ${Math.round(stdDev)}₪) - יכול להפתיע לכל כיוון!` });
      }
    }
    if (Math.abs(p.avgProfit) < 10 && p.currentStreak >= 3 && halfAvg > 25) {
      surpriseCandidates.push({ name: p.name, type: 'breakout',
        description: `${p.currentStreak} נצחונות ברצף עם ממוצע ${Math.round(halfAvg)}₪ - פריצה צפויה!` });
    }
    if (Math.abs(p.currentStreak) >= 4) {
      surpriseCandidates.push({ name: p.name, type: 'streak_breaker',
        description: `רצף של ${Math.abs(p.currentStreak)} ${p.currentStreak > 0 ? 'נצחונות' : 'הפסדים'} - סטטיסטית הרצף צפוי להישבר!` });
    }
    if (p.gamesPlayed >= 4 && p.gamesPlayed <= 8 && p.avgProfit > 25) {
      surpriseCandidates.push({ name: p.name, type: 'dark_horse',
        description: `שחקן לא קבוע (${p.gamesPlayed} משחקים) עם ממוצע +${Math.round(p.avgProfit)}₪ - סוס שחור!` });
    }
  }

  // Pick up to 2 surprises from different types
  const selectedSurprises: typeof surpriseCandidates = [];
  const usedSurpriseTypes = new Set<SurpriseType>();
  const usedSurpriseNames = new Set<string>();
  const shuffledSurprises = [...surpriseCandidates].sort(() => Math.random() - 0.5);
  const maxSurpriseCount = Math.min(2, Math.ceil(players.length / 4));

  for (const candidate of shuffledSurprises) {
    if (selectedSurprises.length >= maxSurpriseCount) break;
    if (usedSurpriseTypes.has(candidate.type) || usedSurpriseNames.has(candidate.name)) continue;
    selectedSurprises.push(candidate);
    usedSurpriseTypes.add(candidate.type);
    usedSurpriseNames.add(candidate.name);
  }

  // STEP 3c: Apply surprises as score modifiers
  const surpriseBoost = Math.max(scoreStdDev * 0.5, 15);
  for (const surprise of selectedSurprises) {
    const ss = strengthScores.find(s => s.name === surprise.name);
    if (!ss) continue;
    if (surprise.type === 'underdog_rise' || surprise.type === 'breakout' || surprise.type === 'dark_horse') {
      ss.score += surpriseBoost;
    } else if (surprise.type === 'top_dog_fall') {
      ss.score -= surpriseBoost;
    } else if (surprise.type === 'streak_breaker') {
      const player = players.find(p => p.name === surprise.name)!;
      ss.score += (player.currentStreak > 0 ? -1 : 1) * surpriseBoost * 0.8;
    } else if (surprise.type === 'wild_card') {
      ss.score += (Math.random() - 0.5) * 2 * surpriseBoost;
    }
  }

  // STEP 4: Probability-weighted random position assignment
  // Instead of deterministic sort (which always puts the best player first),
  // each player's score determines their PROBABILITY of getting each slot.
  // Stronger players are more likely to get better slots, but anyone can end up anywhere.
  // Temperature controls how much scores matter vs pure randomness.
  const temperature = Math.max(scoreStdDev * 2, 40);
  const maxScore = Math.max(...strengthScores.map(s => s.score));
  const remaining = [...strengthScores];
  const orderedPlayers: { name: string; score: number }[] = [];

  for (let pos = 0; pos < n; pos++) {
    const weights = remaining.map(s => Math.exp((s.score - maxScore) / temperature));
    const totalWeight = weights.reduce((s, w) => s + w, 0);
    let rand = Math.random() * totalWeight;
    let selectedIdx = 0;
    for (let i = 0; i < weights.length; i++) {
      rand -= weights[i];
      if (rand <= 0) { selectedIdx = i; break; }
    }
    orderedPlayers.push(remaining[selectedIdx]);
    remaining.splice(selectedIdx, 1);
  }

  const playerSuggestions = orderedPlayers.map((s, i) => ({
    name: s.name,
    suggested: Math.round(template[i])
  }));

  // STEP 5: Fine-tune for variety (slight scaling to avoid exact template replay)
  playerSuggestions.forEach(p => {
    p.suggested = Math.round(p.suggested * (0.85 + Math.random() * 0.3));
  });

  // Fix zero-sum residual from scaling
  const finalSum = playerSuggestions.reduce((s, p) => s + p.suggested, 0);
  if (finalSum !== 0) {
    const smIdx = playerSuggestions.reduce((mi, p, i) =>
      Math.abs(p.suggested) < Math.abs(playerSuggestions[mi].suggested) ? i : mi, 0);
    playerSuggestions[smIdx].suggested -= finalSum;
  }

  const winners = playerSuggestions.filter(p => p.suggested > 0).length;
  const losers = playerSuggestions.filter(p => p.suggested < 0).length;
  console.log('🎲 Surprises:', selectedSurprises.map(s => `${s.name}(${s.type})`).join(', '));
  console.log(`📊 Predictions (${winners}W/${losers}L):`, playerSuggestions.map(s => `${s.name}: ${s.suggested >= 0 ? '+' : ''}${s.suggested}`).join(', '));
  console.log(`🎰 Template shape: [${template.map(t => t >= 0 ? '+' + t : '' + t).join(', ')}]`);
  console.log(`📏 Strength scores: ${[...strengthScores].sort((a, b) => b.score - a.score).map(s => `${s.name}(${Math.round(s.score)})`).join(' > ')}`);
  console.log(`🎯 Assigned order: ${orderedPlayers.map(s => s.name).join(' > ')}`);

  const surpriseNames = new Set(selectedSurprises.map(s => s.name));
  const surpriseText = selectedSurprises.length > 0 
    ? `\n🎲 הפתעות (שחקנים אלו מסומנים כהפתעה — הטון שלהם צריך לשקף את זה):\n` + selectedSurprises.map(s => `- ${s.name}: ${s.description}`).join('\n')
    : '';
  
  // Pre-calculate year profit for all players to sort by 2026 ranking
  const playersWithYearStats = players.map(p => {
    const thisYearGames = p.gameHistory.filter(g => parseGameDate(g.date).getFullYear() === currentYear);
    return {
      ...p,
      yearProfit: thisYearGames.reduce((sum, g) => sum + g.profit, 0),
      yearGames: thisYearGames.length
    };
  });
  
  // Sort by YEAR PROFIT (2026) - this is "tonight's" ranking!
  const tonightRanking = [...playersWithYearStats].sort((a, b) => b.yearProfit - a.yearProfit);
  
  // ========== ANGLE ASSIGNMENT ==========
  // Assign each player a unique narrative angle to ensure variety
  type AngleType = 'streak' | 'ranking_battle' | 'comeback' | 'milestone' | 'form' | 'big_last_game' | 'veteran' | 'dark_horse' | 'default';
  const angleUsed = new Map<AngleType, number>();
  const maxPerAngle = players.length <= 6 ? 1 : 2;

  const playerAngles: { name: string; angle: AngleType; angleHint: string }[] = [];

  playersWithYearStats.forEach(p => {
    const currentHalfGames = getHalfGames(p, currentYear, currentHalf);
    const periodAvg = currentHalfGames.length > 0 
      ? Math.round(currentHalfGames.reduce((sum, g) => sum + g.profit, 0) / currentHalfGames.length) : 0;
    const allTimeAvg = Math.round(p.avgProfit);
    const winRate = p.gamesPlayed > 0 ? Math.round((p.winCount / p.gamesPlayed) * 100) : 0;
    const lastGame = p.gameHistory[0];
    const lastGameProfit = lastGame?.profit || 0;

    const halfRankData = globalRankings?.currentHalf.rankings.find(r => r.name === p.name);
    const halfRank = halfRankData?.rank || tonightRanking.findIndex(sp => sp.name === p.name) + 1;
    const aboveIdx = halfRank - 2;
    const gapToAbove = aboveIdx >= 0 && aboveIdx < tonightRanking.length 
      ? Math.round(tonightRanking[aboveIdx].yearProfit - p.yearProfit) : 999;

    const milestones = [500, 1000, 1500, 2000];
    const nearMilestone = milestones.find(m => p.totalProfit > 0 && m - Math.round(p.totalProfit) > 0 && m - Math.round(p.totalProfit) <= 150);

    const canUse = (a: AngleType) => (angleUsed.get(a) || 0) < maxPerAngle;
    const assign = (a: AngleType, hint: string) => { angleUsed.set(a, (angleUsed.get(a) || 0) + 1); playerAngles.push({ name: p.name, angle: a, angleHint: hint }); };

    const isNewPlayer = p.gamesPlayed === 0 || p.gameHistory.length === 0;
    if (isNewPlayer) {
      assign('default', `שחקן חדש לגמרי - אין נתונים! ← התמקד בזה שהוא חדש, אל תמציא סטטיסטיקות!`);
    } else if (Math.abs(p.currentStreak) >= 3 && canUse('streak')) {
      const dir = p.currentStreak > 0 ? `${p.currentStreak} נצחונות ברצף` : `${Math.abs(p.currentStreak)} הפסדים - מחפש קאמבק`;
      assign('streak', `${dir} ← התמקד בנתון הרצף, לא בממוצע!`);
    } else if (gapToAbove <= 120 && gapToAbove > 0 && halfRank > 1 && canUse('ranking_battle')) {
      const aboveName = tonightRanking[aboveIdx]?.name || '';
      assign('ranking_battle', `${gapToAbove}₪ ממקום ${halfRank - 1} (${aboveName}) ← התמקד בפער הדירוג, לא בממוצע!`);
    } else if (p.daysSinceLastGame >= 20 && p.daysSinceLastGame < 900 && canUse('comeback')) {
      assign('comeback', `חוזר אחרי ${p.daysSinceLastGame} ימים ← התמקד בימי ההיעדרות, לא בממוצע!`);
    } else if (nearMilestone && canUse('milestone')) {
      assign('milestone', `${nearMilestone - Math.round(p.totalProfit)}₪ מ-${nearMilestone}₪ כולל ← התמקד באבן הדרך, לא בממוצע!`);
    } else if (currentHalfGames.length >= 3 && Math.abs(periodAvg - allTimeAvg) > 20 && canUse('form')) {
      const dir = periodAvg > allTimeAvg ? 'פורמה עולה' : 'פורמה יורדת';
      assign('form', `${dir}: תקופה ${periodAvg >= 0 ? '+' : ''}${periodAvg}₪ vs היסטורי ${allTimeAvg >= 0 ? '+' : ''}${allTimeAvg}₪ ← התמקד בהשוואת המגמה!`);
    } else if (Math.abs(lastGameProfit) > 80 && canUse('big_last_game')) {
      assign('big_last_game', `משחק אחרון: ${lastGameProfit >= 0 ? '+' : ''}${Math.round(lastGameProfit)}₪ ← התמקד בתוצאת המשחק האחרון, לא בממוצע!`);
    } else if (p.gamesPlayed >= 30 && canUse('veteran')) {
      assign('veteran', `ותיק: ${p.gamesPlayed} משחקים, ${winRate}% נצחונות ← התמקד בניסיון ואחוז נצחונות, לא בממוצע!`);
    } else if (p.avgProfit < -5 && periodAvg > 10 && canUse('dark_horse')) {
      assign('dark_horse', `היסטוריה שלילית אבל פורמה חיובית ← התמקד בשינוי המגמה, לא בממוצע!`);
    } else {
      assign('default', `${p.gamesPlayed} משחקים, ${winRate}% נצחונות ← התמקד באחוז נצחונות או תוצאה אחרונה, לא בממוצע!`);
    }
  });

  // ========== RECONCILE ANGLES WITH PREDICTIONS ==========
  // Optimistic angles must not pair with large negative predictions
  const optimisticAngles: AngleType[] = ['ranking_battle', 'milestone', 'streak', 'form'];
  const pessimisticAngles: AngleType[] = ['dark_horse'];

  for (const pa of playerAngles) {
    const prediction = playerSuggestions.find(s => s.name === pa.name)?.suggested || 0;
    const player = playersWithYearStats.find(p => p.name === pa.name);
    if (!player) continue;

    const winRate = player.gamesPlayed > 0 ? Math.round((player.winCount / player.gamesPlayed) * 100) : 0;

    if (prediction <= -30 && optimisticAngles.includes(pa.angle)) {
      pa.angle = 'default';
      pa.angleHint = `חיזוי שלילי (${prediction}₪) — ${player.gamesPlayed} משחקים, ${winRate}% נצחונות ← כתוב בטון מאתגר/הומוריסטי, לא אופטימי!`;
    }
    if (prediction >= 30 && pessimisticAngles.includes(pa.angle)) {
      pa.angle = 'form';
      pa.angleHint = `חיזוי חיובי (+${prediction}₪) עם מגמה עולה ← כתוב בטון בטוח/חיובי!`;
    }
  }

  console.log('🎭 Assigned angles:', playerAngles.map(a => `${a.name}: ${a.angle}`).join(', '));

  // ========== BUILD STAT CARDS ==========
  const playerDataText = playersWithYearStats.map(p => {
    const lastGame = p.gameHistory[0];
    const isNewPlayer = p.gamesPlayed === 0 || p.gameHistory.length === 0;
    const lastGameResult = lastGame 
      ? (lastGame.profit > 0 ? `ניצח +${Math.round(lastGame.profit)}₪` : 
         lastGame.profit < 0 ? `הפסיד ${Math.round(lastGame.profit)}₪` : 'יצא באפס')
      : 'שחקן חדש - אין היסטוריה';
    
    const actualStreak = p.currentStreak;
    let streakText = '';
    if (actualStreak >= 3) streakText = `🔥 ${actualStreak} נצחונות ברצף!`;
    else if (actualStreak <= -3) streakText = `${Math.abs(actualStreak)} הפסדים ברצף`;
    else if (actualStreak === 2) streakText = `2 נצחונות ברצף`;
    else if (actualStreak === -2) streakText = `2 הפסדים ברצף`;
    else if (actualStreak === 1) streakText = `ניצח אחרון`;
    else if (actualStreak === -1) streakText = `הפסיד אחרון`;
    else streakText = 'אין רצף';

    const currentHalfGames = getHalfGames(p, currentYear, currentHalf);
    const prevHalfGames = getHalfGames(p, prevPeriod.year, prevPeriod.half);
    let periodGames = currentHalfGames;
    let periodLabel = currentPeriodLabel;
    if (currentHalfGames.length === 0 && prevHalfGames.length > 0) {
      periodGames = prevHalfGames;
      periodLabel = prevPeriod.label;
    }
    const periodAvg = periodGames.length > 0 
      ? Math.round(periodGames.reduce((sum, g) => sum + g.profit, 0) / periodGames.length) : 0;

    const halfRankData = globalRankings?.currentHalf.rankings.find(r => r.name === p.name);
    const halfRank = halfRankData?.rank || tonightRanking.findIndex(sp => sp.name === p.name) + 1;
    const halfTotalActive = globalRankings?.currentHalf.totalActivePlayers || players.length;

    const allTimeRankData = globalRankings?.allTime.rankings.find(r => r.name === p.name);
    const allTimeRank = allTimeRankData?.rank || 0;
    const allTimeTotalActive = globalRankings?.allTime.totalActivePlayers || players.length;

    const winRate = p.gamesPlayed > 0 ? Math.round((p.winCount / p.gamesPlayed) * 100) : 0;
    const allTimeAvg = Math.round(p.avgProfit);
    const suggestion = playerSuggestions.find(s => s.name === p.name)?.suggested || 0;
    const angle = playerAngles.find(a => a.name === p.name);

    const aboveIdx = halfRank - 2;
    const belowIdx = halfRank;
    const aboveName = aboveIdx >= 0 && aboveIdx < tonightRanking.length ? tonightRanking[aboveIdx].name : '';
    const belowName = belowIdx >= 0 && belowIdx < tonightRanking.length ? tonightRanking[belowIdx].name : '';
    const gapAbove = aboveIdx >= 0 && aboveIdx < tonightRanking.length 
      ? Math.round(tonightRanking[aboveIdx].yearProfit - p.yearProfit) : 0;
    const gapBelow = belowIdx >= 0 && belowIdx < tonightRanking.length 
      ? Math.round(p.yearProfit - tonightRanking[belowIdx].yearProfit) : 0;

    const lines: string[] = [];
    lines.push(`══ ${p.name} ${p.isFemale ? '(נקבה)' : '(זכר)'} ══`);
    if (isNewPlayer) {
      lines.push(`🆕 שחקן חדש! אין היסטוריית משחקים. אין נתונים סטטיסטיים.`);
    } else {
      lines.push(`משחק אחרון: ${lastGameResult} (${lastGame?.date || 'N/A'})`);
      lines.push(`רצף: ${streakText}`);
      if (periodGames.length > 0) {
        lines.push(`⭐ טבלת ${periodLabel}: מקום #${halfRank} מתוך ${halfTotalActive}, ${periodGames.length} משחקים, ממוצע ${periodAvg >= 0 ? '+' : ''}${periodAvg}₪`);
      }
      lines.push(`היסטוריה כוללת: ${p.gamesPlayed} משחקים, ממוצע ${allTimeAvg >= 0 ? '+' : ''}${allTimeAvg}₪, ${winRate}% נצחונות, סה"כ ${p.totalProfit >= 0 ? '+' : ''}${Math.round(p.totalProfit)}₪`);
      if (allTimeRank > 0 && allTimeRank <= 3) {
        lines.push(`דירוג כללי (כל הזמנים): #${allTimeRank} מתוך ${allTimeTotalActive}`);
      }
      if (gapAbove > 0 && halfRank > 1) {
        lines.push(`פער בטבלת ${periodLabel}: ${gapAbove}₪ מאחורי מקום ${halfRank - 1} (${aboveName})`);
      }
      if (gapBelow > 0 && belowName) {
        lines.push(`יתרון בטבלת ${periodLabel}: ${gapBelow}₪ על מקום ${halfRank + 1} (${belowName})`);
      }
      if (p.daysSinceLastGame >= 20 && p.daysSinceLastGame < 900) {
        lines.push(`חזרה: אחרי ${p.daysSinceLastGame} ימים`);
      }
    }
    lines.push(`זווית מוצעת: ${angle?.angle || 'default'} - ${angle?.angleHint || ''}`);
    lines.push(`🔒 חיזוי סופי (נעול): ${suggestion >= 0 ? '+' : ''}${suggestion}₪ ← המשפט חייב להתאים לכיוון ולעוצמה הזו!`);

    console.log(`🔍 ${p.name}: angle=${angle?.angle}, suggestion=${suggestion >= 0 ? '+' : ''}${suggestion}₪`);

    return lines.join('\n');
  }).join('\n\n');

  // Build period context for the prompt
  const periodContextLines: string[] = [];
  if (periodMarkers) {
    if (periodMarkers.isFirstGameOfMonth) periodContextLines.push(`🗓️ משחק ראשון של חודש ${periodMarkers.monthName}`);
    if (periodMarkers.isLastGameOfMonth) periodContextLines.push(`🗓️ משחק אחרון של חודש ${periodMarkers.monthName}`);
    if (periodMarkers.isFirstGameOfHalf) periodContextLines.push(`🗓️ משחק ראשון של ${periodMarkers.halfLabel} — מחצית חדשה מתחילה!`);
    if (periodMarkers.isLastGameOfHalf) periodContextLines.push(`🗓️ משחק אחרון של ${periodMarkers.halfLabel} — סיום מחצית!`);
    if (periodMarkers.isFirstGameOfYear) periodContextLines.push(`🗓️ משחק ראשון של ${periodMarkers.year} — שנה חדשה!`);
    if (periodMarkers.isLastGameOfYear) periodContextLines.push(`🗓️ משחק אחרון של ${periodMarkers.year} — סיום שנה!`);
  }
  const periodContextText = periodContextLines.length > 0 ? periodContextLines.join('\n') : '';
  const hasMajorPeriod = periodMarkers && (periodMarkers.isFirstGameOfHalf || periodMarkers.isLastGameOfHalf || periodMarkers.isFirstGameOfYear || periodMarkers.isLastGameOfYear);

  // Randomly pick a style for the teaser
  const teaserStyles = [
    'פרשן ספורט מלהיב שבונה את ההייפ לפני המשחק הגדול',
    'כתב עיתון ספורט שכותב פרומו מרתק למדור הפוקר',
    'מספר סיפורים שנון שמושך את הקורא עם סיפורי מתח וריגוש',
    'הודעת ווטסאפ מהסוג שכולם ממהרים לקרוא, קצרה ולעניין עם הומור',
    'פרשן פוליטי שמנתח את מאזן הכוחות בשולחן כאילו זה ערב בחירות',
    'מגיש טלוויזיה דרמטי שמציג את הדמויות כמו בתוכנית ריאליטי',
  ];
  const chosenStyle = teaserStyles[Math.floor(Math.random() * teaserStyles.length)];

  const prompt = `אתה ${chosenStyle}. התפקיד שלך: ליצור חוויה מהנה ומרגשת לפני ערב פוקר בין חברים.

🎯 הערב הזה: ${new Date().toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}${periodContextText ? `\n${periodContextText}` : ''}

📊 כרטיסי שחקנים (${players.length} שחקנים):
${playerDataText}
${allTimeRecordsText ? `\n🏅 שיאי הקבוצה (השחקנים המשתתפים בלבד):\n${allTimeRecordsText}` : ''}
${storylinesText ? `\n📖 סיפורי הערב - יריבויות, נקמות, קשרים מעניינים:\n${storylinesText}` : ''}
${milestonesText ? `\n🎯 אבני דרך ועובדות מעניינות:\n${milestonesText}` : ''}
${locationInsightsText ? `\n${locationInsightsText}` : ''}
${comboHistoryText ? `\n${comboHistoryText}` : ''}
${surpriseText}

📤 פלט JSON בפורמט הבא:
{"preGameTeaser":"טיזר טרום-משחק","players":[{"name":"שם","highlight":"כותרת","sentence":"משפט"}]}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📣 preGameTeaser — טיזר טרום-משחק (חובה!):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
הטיזר הוא הלב של חוויית הפתיחה. זהו טקסט אחד רציף בעברית שמספר את הסיפור של הערב הזה.

תוכן:
• לקט את העובדות הכי מעניינות, מצחיקות ומפתיעות מכל הנתונים: רצפים, יריבויות, שיאים, חזרות, אבני דרך, קרבות דירוג
• חובה לנסות להזכיר את כל ${players.length} השחקנים בשמם! כולם רוצים לראות את עצמם${locationInsightsText ? `\n• יש תובנות מיקום (🏠) למעלה — שלב אותן רק אם הן מעניינות, מצחיקות או ציניות. אל תזכיר מיקום סתם כי הוא קיים` : ''}
• העדף סיפורים ויריבויות על פני סטטיסטיקות יבשות
• אם יש מידע על הרכב חוזר (🔄) — זה חומר מצוין לטיזר! ציין שזה הרכב שכבר שיחק יחד, מי שלט בפעמים הקודמות, מי תמיד ברווח/הפסד בהרכב הזה. אם זה הרכב חדש (🆕) — ציין שזו פעם ראשונה
• לא לחזור על עובדות שיופיעו ב-sentence של שחקנים ספציפיים — פזר חומר שונה
• חשוב מאוד: הטיזר נשלח מספר ימים לפני המשחק! אסור לכתוב "הלילה", "הערב", "היום" או לציין תאריך/יום ספציפי. השתמש ב"הפעם", "במשחק הבא", "במשחק הקרוב" וכדומה. זה חל על הטיזר וגם על ה-sentence של כל שחקן

אורך:
• יחסי לכמות החומר המעניין — יותר שחקנים ויותר סיפורים = טקסט ארוך יותר
• טווח: 40-120 מילים. עם 4 שחקנים וחומר דליל = קצר. עם 8 שחקנים וסיפורים עסיסיים = ארוך
• לעולם לא ארוך יותר מסך כל ה-sentences של השחקנים ביחד
${hasMajorPeriod ? `
📅 אירוע תקופתי — פסקה ייעודית נוספת:
${periodMarkers?.isFirstGameOfHalf || periodMarkers?.isFirstGameOfYear ? `• מחצית/שנה חדשה מתחילה! הוסף פסקה קצרה שפותחת את העידן החדש — מה מצופה, מי מועמד להוביל, מה השאיפות` : ''}${periodMarkers?.isLastGameOfHalf || periodMarkers?.isLastGameOfYear ? `• מחצית/שנה נגמרת! הוסף פסקה קצרה שמסכמת — מי הוביל, מה היו הרגעים הגדולים, מה נשאר פתוח` : ''}
• הפסקה הזו מעבר לטיזר הרגיל, לא במקומו` : ''}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📝 לכל שחקן:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. highlight - כותרת קצרה (3-6 מילים) - העובדה הכי מעניינת ומשעשעת
2. sentence - משפט אחד בעברית (20-40 מילים) - סיפור מרתק עם 2-3 מספרים אמיתיים מהכרטיס

כללי איכות:
• סיפורי ערב (📖) הם הזהב! יריבויות, נקמה, קמע, נמסיס — השתמש בהם
• כל שחקן = סיפור ייחודי עם זווית שונה. אסור שלשניים אותו סוג נתון מרכזי
• לכל שחקן זווית מוצעת — השתמש בה כבסיס
• העדיפויות: סיפורי ערב ← רצפים ← קרבות דירוג ← תוצאה אחרונה ← אחוז נצחונות ← ותק
• שחקן חדש → כתוב שהוא חדש, אל תמציא מספרים!

התאמת טון:
• חיזוי חיובי → טון חיובי/בטוח (לא מוגזם לחיזוי קטן)
• חיזוי שלילי → טון מאתגר/הומוריסטי (אסור אופטימי!)

🚫 איסורים (הפרה = פסילה!):
• אסור להזכיר מספר החיזוי ב-sentence! המספר מוצג בכרטיס בנפרד
• אסור להזכיר הפסד מצטבר/כולל/היסטורי!
• אסור תבנית חוזרת בין משפטים!
• "מטורף", "מדהים", "היסטורי" → רק לנתונים באמת חריגים (רצף 5+, פער 150₪+)

כללי כתיבה:
• דירוגים: רק מטבלת התקופה (⭐). מקום 1 = הכי טוב
• "מוביל" = מקום 1 | "רודף" = מנסה לעלות | "שומר" = מגן על הדירוג
• highlight ו-sentence עקביים, כל highlight שונה, כל משפט במבנה שונה, גיוון מלא!`;

  console.log('🤖 AI Forecast Request for:', players.map(p => p.name).join(', '));
  
  // Try each model until one works
  for (const config of API_CONFIGS) {
    const modelPath = config.model.startsWith('models/') ? config.model : `models/${config.model}`;
    const url = `https://generativelanguage.googleapis.com/${config.version}/${modelPath}:generateContent?key=${apiKey}`;
    
    console.log(`   Trying: ${config.version}/${config.model}...`);
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: prompt }]
          }],
          generationConfig: {
            temperature: 0.7,
            topK: 40,
            topP: 0.95,
            maxOutputTokens: 8192,
            responseMimeType: 'application/json',
          }
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData?.error?.message || `Status ${response.status}`;
        console.log(`   ❌ ${config.model}: ${errorMsg}`);
        
        // If rate limited or not found, try next model
        if (response.status === 429 || response.status === 404) {
          continue; // Try next model
        }
        throw new Error(`API_ERROR: ${response.status} - ${errorMsg}`);
      }
      
      // Success! Save this working model
      console.log(`   ✅ ${config.model} responded!`);
      lastUsedModel = config.model;
      localStorage.setItem('gemini_working_config', JSON.stringify(config));

      const data = await response.json();
      
      // Extract the text from Gemini response
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      
      if (!text) {
        console.error('❌ Empty response from', config.model);
        if (data.candidates?.[0]?.finishReason === 'SAFETY') {
          continue; // Try next model
        }
        continue; // Try next model
      }

      console.log('📝 AI response received, parsing...');

      // Parse JSON from response (handle markdown code blocks)
      let jsonText = text;
      if (text.includes('```json')) {
        jsonText = text.split('```json')[1].split('```')[0];
      } else if (text.includes('```')) {
        jsonText = text.split('```')[1].split('```')[0];
      }

      let aiOutput: { name: string; highlight: string; sentence: string }[];
      let preGameTeaser = '';
      try {
        const parsed = JSON.parse(jsonText.trim());
        if (Array.isArray(parsed)) {
          aiOutput = parsed;
        } else if (parsed.players && Array.isArray(parsed.players)) {
          aiOutput = parsed.players;
          preGameTeaser = parsed.preGameTeaser || parsed.groupIntro || '';
        } else {
          throw new Error('Unexpected JSON format');
        }
        console.log('✅ Parsed', aiOutput.length, 'forecasts from AI');
        if (preGameTeaser) console.log('🌟 Pre-game teaser:', preGameTeaser.substring(0, 80) + '...');
      } catch (parseError) {
        console.error('❌ JSON parse error, trying next model');
        continue; // Try next model
      }

      let forecasts: ForecastResult[] = players.map(p => {
        const aiEntry = aiOutput.find(a => a.name === p.name);
        const suggestion = playerSuggestions.find(s => s.name === p.name);
        return {
          name: p.name,
          expectedProfit: suggestion?.suggested || 0,
          highlight: aiEntry?.highlight || '',
          sentence: aiEntry?.sentence || '',
          isSurprise: surpriseNames.has(p.name),
          preGameTeaser: '',
        };
      });
      if (preGameTeaser && forecasts.length > 0) {
        forecasts[0].preGameTeaser = preGameTeaser;
      }
      
      console.log('🔗 Merged AI text with locked predictions:', forecasts.map(f => `${f.name}: ${f.expectedProfit >= 0 ? '+' : ''}${f.expectedProfit}₪`).join(', '));
      
      // ========== FACT-CHECK AND CORRECT AI OUTPUT ==========
      console.log('🔍 Fact-checking AI output...');
      
      forecasts = forecasts.map(forecast => {
        const player = players.find(p => p.name === forecast.name);
        if (!player) return forecast;
        
        // Get actual year data
        const thisYearGames = player.gameHistory.filter(g => parseGameDate(g.date).getFullYear() === currentYear);
        const yearGames = thisYearGames.length;
        const yearProfit = thisYearGames.reduce((sum, g) => sum + g.profit, 0);
        
        // Calculate period ranking (must match what we tell the AI in the stat card!)
        const halfRankData = globalRankings?.currentHalf.rankings.find(r => r.name === player.name);
        const rankTonight = halfRankData?.rank || (
          [...players].sort((a, b) => {
            const aProfit = getHalfGames(a, currentYear, currentHalf).reduce((s, g) => s + g.profit, 0);
            const bProfit = getHalfGames(b, currentYear, currentHalf).reduce((s, g) => s + g.profit, 0);
            return bProfit - aProfit;
          }).findIndex(p => p.name === player.name) + 1
        );
        
        // USE THE ACTUAL CURRENT STREAK (spans across years!)
        const actualStreak = player.currentStreak;
        
        // Last game result
        const lastGame = player.gameHistory[0];
        const lastGameProfit = lastGame?.profit || 0;
        const wonLastGame = lastGameProfit > 0;
        const lostLastGame = lastGameProfit < 0;
        
        let correctedSentence = forecast.sentence || '';
        let correctedHighlight = forecast.highlight || '';
        let errorDetails: string[] = [];
        
        // ========== 1. FIX STREAK ERRORS ==========
        const streakPatterns = [
          /רצף\s*(?:של\s*)?(\d+)\s*נצחונות/g,
          /(\d+)\s*נצחונות\s*רצופים/g,
          /(\d+)\s*consecutive\s*wins/gi,
          /רצף\s*(?:של\s*)?(\d+)\s*הפסדים/g,
          /(\d+)\s*הפסדים\s*רצופים/g,
          /(\d+)\s*wins?\s*in\s*a\s*row/gi,
          /(\d+)\s*losses?\s*in\s*a\s*row/gi,
        ];
        
        for (const pattern of streakPatterns) {
          const matches = [...correctedSentence.matchAll(pattern)];
          for (const match of matches) {
            const claimedStreak = parseInt(match[1]);
            const isWinPattern = match[0].includes('נצחונות') || match[0].toLowerCase().includes('wins');
            const expectedStreak = isWinPattern ? Math.max(0, actualStreak) : Math.abs(Math.min(0, actualStreak));
            
            if (claimedStreak !== expectedStreak) {
              errorDetails.push(`streak: claimed ${claimedStreak}, actual ${expectedStreak}`);
              if (expectedStreak === 0) {
                correctedSentence = correctedSentence.replace(match[0], '');
              } else {
                correctedSentence = correctedSentence.replace(match[0], match[0].replace(match[1], String(expectedStreak)));
              }
            }
          }
        }
        
        // ========== 2. FIX RANKING ERRORS ==========
        // Check if sentence claims #1 but player isn't #1 tonight
        if ((correctedSentence.includes('מוביל') || correctedSentence.includes('בראש') || correctedSentence.includes('מקום ראשון') || correctedSentence.includes('מקום 1') || correctedSentence.includes('#1')) && rankTonight !== 1) {
          errorDetails.push(`rank: claimed #1 but actually #${rankTonight}`);

          correctedSentence = correctedSentence
            .replace(/מוביל את הטבלה/g, `נמצא במקום ${rankTonight}`)
            .replace(/בראש הטבלה/g, `במקום ${rankTonight}`)
            .replace(/מקום ראשון/g, `מקום ${rankTonight}`)
            .replace(/מקום 1\b/g, `מקום ${rankTonight}`)
            .replace(/#1\b/g, `#${rankTonight}`);
        }
        
        // Fix "king/ruler of rankings" for non-#1 players
        if (rankTonight !== 1) {
          if (/מלך\s*ה(דירוג|טבלה)/.test(correctedSentence) || /שולט\s*ב(דירוג|טבלה)/.test(correctedSentence)) {
            errorDetails.push(`rank_title: "מלך/שולט" used for #${rankTonight}`);
            correctedSentence = correctedSentence
              .replace(/מלך\s*ה(דירוג|טבלה)/g, `מקום ${rankTonight} ב$1`)
              .replace(/שולט\s*ב(דירוג|טבלה)/g, `במקום ${rankTonight} ב$1`);
          }
        }
        
        // ========== 2b. FIX RANKING ERRORS IN HIGHLIGHT ==========
        if ((correctedHighlight.includes('מוביל') || correctedHighlight.includes('בראש') || correctedHighlight.includes('מקום ראשון') || correctedHighlight.includes('מקום 1') || correctedHighlight.includes('#1')) && rankTonight !== 1) {
          errorDetails.push(`highlight rank: claimed #1 but actually #${rankTonight}`);

          correctedHighlight = correctedHighlight
            .replace(/מוביל את הטבלה/g, `מקום ${rankTonight} בטבלה`)
            .replace(/בראש הטבלה/g, `במקום ${rankTonight}`)
            .replace(/מקום ראשון/g, `מקום ${rankTonight}`)
            .replace(/מקום 1\b/g, `מקום ${rankTonight}`)
            .replace(/#1\b/g, `#${rankTonight}`);
        }
        
        // Fix "king/ruler" in highlight for non-#1
        if (rankTonight !== 1) {
          if (/מלך\s*ה(דירוג|טבלה)/.test(correctedHighlight) || /שולט\s*ב(דירוג|טבלה)/.test(correctedHighlight)) {
            errorDetails.push(`highlight rank_title: "מלך/שולט" used for #${rankTonight}`);
            correctedHighlight = correctedHighlight
              .replace(/מלך\s*ה(דירוג|טבלה)/g, `מקום ${rankTonight} ב$1`)
              .replace(/שולט\s*ב(דירוג|טבלה)/g, `במקום ${rankTonight} ב$1`);
          }
        }
        
        // ========== 3. FIX LAST GAME ERRORS ==========
        // Check for contradictions about last game result
        if (wonLastGame && correctedSentence.includes('הפסד') && correctedSentence.includes('אחרון')) {
          errorDetails.push('last_game: claimed loss but actually won');

        }
        if (lostLastGame && correctedSentence.includes('נצחון') && correctedSentence.includes('אחרון')) {
          errorDetails.push('last_game: claimed win but actually lost');

        }
        
        // ========== 4. FIX GAME COUNT ERRORS ==========
        const gameCountPatterns = [
          /(\d+)\s*משחקים?\s*(?:ב)?(?:ינואר|פברואר|מרץ|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר)/g,
          /(\d+)\s*משחקים?\s*(?:ב)?-?(?:2026|2025|השנה)/g,
          /(\d+)\s*games?\s*(?:in\s*)?(?:January|February|this year|2026)/gi,
        ];
        
        for (const pattern of gameCountPatterns) {
          const matches = [...correctedSentence.matchAll(pattern)];
          for (const match of matches) {
            const claimedGames = parseInt(match[1]);
            const isYearMention = match[0].includes('2026') || match[0].includes('2025') || match[0].includes('השנה');
            
            let actualGames = yearGames;
            if (!isYearMention) {
              const thisMonthGames = player.gameHistory.filter(g => {
                const d = parseGameDate(g.date);
                return d.getFullYear() === currentYear && d.getMonth() === currentMonth;
              });
              actualGames = thisMonthGames.length;
            }
            
            if (claimedGames !== actualGames) {
              errorDetails.push(`games: claimed ${claimedGames}, actual ${actualGames}`);

              correctedSentence = correctedSentence.replace(match[0], match[0].replace(match[1], String(actualGames)));
            }
          }
        }
        
        // ========== 5. FIX PROFIT DIRECTION ERRORS ==========
        // If year profit is negative but sentence claims positive year
        if (yearProfit < 0 && yearGames > 0) {
          const positiveYearClaims = [
            /שנה\s*(?:מצוינת|טובה|חיובית)/g,
            /רווח\s*(?:השנה|ב-?2026)/g,
            /\+.*₪\s*(?:השנה|ב-?2026)/g,
          ];
          for (const pattern of positiveYearClaims) {
            if (pattern.test(correctedSentence)) {
              errorDetails.push(`profit_direction: claimed positive year but year profit is ${yearProfit}`);

            }
          }
        }
        
        // ========== 6. CLEAN UP BROKEN TEXT + STRIP NEGATIVES ==========
        correctedSentence = correctedSentence.replace(/\s+/g, ' ').trim();
        correctedSentence = correctedSentence.replace(/,\s*,/g, ',');
        correctedSentence = correctedSentence.replace(/\.\s*\./g, '.');
        correctedSentence = correctedSentence.replace(/\s+\./g, '.');
        
        // Strip cumulative/total losses from sentence (game-last losses are OK)
        correctedSentence = correctedSentence
          .replace(/(?:כדי\s*)?(?:לא\s*לרדת|להימנע\s*מ[-−]?ירידה)\s*(?:מתחת\s*)?(?:[למב][-−]?\s*)?(?:(?:הפסד|מינוס)\s*(?:כולל|מצטבר|היסטורי)?\s*(?:של\s*)?)?[-−]?\s*\d+₪\s*(?:הפסד\s*)?(?:כולל|מצטבר)?/g, '')
          .replace(/סה"כ\s*(הפסד\s*(של\s*)?)?[-−]?\s*\d+₪/g, '')
          .replace(/(?:[למב][-−]?\s*)?(הפסד|מינוס)\s*(כולל|היסטורי|מצטבר)\s*(של\s*)?[-−]?\s*\d+₪/g, '')
          .replace(/מ[-−]\s*\d+₪\s*הפסד\s*(כולל|היסטורי)/g, '')
          .replace(/(?:[למב][-−]?\s*)?[-−]?\d{3,}₪\s*(הפסד\s*)?(כולל|מצטבר|היסטורי)/g, '');
        
        // Clean up orphaned fragments left by stripping:
        // Single-letter prepositions (ל/מ/ב/ה/ו/כ/ש), connective words (של/את/על/עם/כי/אם/או/כש)
        // and trailing conjunctions/incomplete phrases before sentence end
        correctedSentence = correctedSentence
          .replace(/\s+[למבהוכש][-−]?\s*\./g, '.')
          .replace(/\s+[למבהוכש][-−]?\s*$/g, '')
          .replace(/\s+(?:של|את|על|עם|כי|גם|אם|או|כש|אחרי|לפני|בשביל|כדי(?:\s*לא)?(?:\s*לרדת)?)\s*\./g, '.')
          .replace(/\s+(?:של|את|על|עם|כי|גם|אם|או|כש|אחרי|לפני|בשביל|כדי(?:\s*לא)?(?:\s*לרדת)?)\s*$/g, '')
          .replace(/,\s*\./g, '.').replace(/,\s*,/g, ',').replace(/\s+/g, ' ').replace(/\.\s*\./g, '.').trim();
        
        // ========== 6b. STRIP FORECAST NUMBER FROM SENTENCE ==========
        // The AI often leaks the prediction number into the text despite instructions
        const predictedProfit = forecast.expectedProfit;
        const absProfit = Math.abs(predictedProfit);
        if (absProfit > 0) {
          const profitStr = String(absProfit);
          const leakPatterns = [
            new RegExp(`(רווח|הפסד|יעד|מכוון)\\s*(של|ל|ל-)?\\s*[-+]?${profitStr}₪`, 'g'),
            new RegExp(`[-+]?₪?${profitStr}₪?\\s*(רווח|הפסד)`, 'g'),
            new RegExp(`(לרווח|להפסד|מכוון ל|שואף ל)[-+\\s]*${profitStr}₪`, 'g'),
            new RegExp(`עם\\s*[-+]?${profitStr}₪`, 'g'),
          ];
          for (const pattern of leakPatterns) {
            if (pattern.test(correctedSentence)) {
              errorDetails.push(`number_leak: prediction ${predictedProfit}₪ found in sentence`);
              correctedSentence = correctedSentence.replace(pattern, '').trim();
            }
          }
          correctedSentence = correctedSentence.replace(/\s+/g, ' ').replace(/,\s*,/g, ',').replace(/,\s*\./g, '.').replace(/\.\s*\./g, '.').trim();
        }
        
        // ========== 6c. REMOVE DUPLICATE PHRASES ==========
        {
          const sentenceWords = correctedSentence.split(/\s+/);
          if (sentenceWords.length >= 8) {
            for (let phraseLen = Math.min(8, Math.floor(sentenceWords.length / 2)); phraseLen >= 4; phraseLen--) {
              let found = false;
              for (let i = 0; i <= sentenceWords.length - phraseLen * 2; i++) {
                const phrase = sentenceWords.slice(i, i + phraseLen).join(' ');
                for (let j = i + phraseLen; j <= sentenceWords.length - phraseLen; j++) {
                  const candidate = sentenceWords.slice(j, j + phraseLen).join(' ');
                  if (phrase === candidate) {
                    sentenceWords.splice(j, phraseLen);
                    errorDetails.push(`duplicate_phrase: removed repeated "${phrase}"`);
                    found = true;
                    break;
                  }
                }
                if (found) break;
              }
              if (found) {
                correctedSentence = sentenceWords.join(' ');
                correctedSentence = correctedSentence.replace(/\s+/g, ' ').replace(/,\s*,/g, ',').replace(/,\s*\./g, '.').trim();
                break;
              }
            }
          }
        }
        
        // ========== 7. TEXT-NUMBER CONSISTENCY CHECK ==========
        const allTimeAvg = Math.round(player.avgProfit);
        const winRate = player.gamesPlayed > 0 ? Math.round((player.winCount / player.gamesPlayed) * 100) : 0;
        
        // Detect optimistic text for negative predictions
        const optimisticWords = ['ינצח', 'יצליח', 'מסוכן', 'רכבת', 'מוביל', 'פורמה מטורפת', 'הולך לנצח', 'בדרך לפסגה', 'שולט', 'דומיננטי'];
        const pessimisticWords = ['ספונסר', 'תורם', 'קשה', 'מאתגר', 'חלודה', 'נופל', 'סובל', 'בעיה'];
        const superlativeWords = ['מטורף', 'מדהים', 'היסטורי', 'חסר תקדים', 'מושלם', 'אגדי', 'פנומנלי'];
        
        // Only flag superlatives for truly tiny predictions (±20₪ or less)
        if (Math.abs(predictedProfit) <= 20) {
          for (const word of superlativeWords) {
            if (correctedSentence.includes(word)) {
              errorDetails.push(`intensity_mismatch: "${word}" used for tiny prediction ${predictedProfit}₪`);

              correctedSentence = correctedSentence
                .replace('מטורף', predictedProfit > 0 ? 'ברור' : 'לא פשוט')
                .replace('מדהים', predictedProfit > 0 ? 'סביר' : 'בולט')
                .replace('היסטורי', 'ברור')
                .replace('חסר תקדים', 'יוצא דופן')
                .replace('מושלם', 'טוב')
                .replace('אגדי', 'מעניין')
                .replace('פנומנלי', 'סביר');
            }
          }
        }
        
        const hasOptimistic = optimisticWords.some(w => correctedSentence.includes(w));
        const hasPessimistic = pessimisticWords.some(w => correctedSentence.includes(w));
        
        // Flag and fix severe direction mismatches by replacing with fallback
        if (predictedProfit <= -40 && hasOptimistic && !hasPessimistic) {
          errorDetails.push(`tone_mismatch: optimistic text but predicted ${predictedProfit}₪ — replacing`);
          correctedSentence = '';
        }
        if (predictedProfit >= 40 && hasPessimistic && !hasOptimistic) {
          errorDetails.push(`tone_mismatch: pessimistic text but predicted +${predictedProfit}₪ — replacing`);
          correctedSentence = '';
        }
        
        // ========== FINAL CLEANUP ==========
        // Remove any orphaned fragments at sentence end (prepositions, connectives)
        correctedSentence = correctedSentence
          .replace(/\s+[למבהוכש][-−]?\s*\./g, '.')
          .replace(/\s+[למבהוכש][-−]?\s*$/g, '')
          .replace(/\s+(?:של|את|על|עם|כי|גם|אם|או|כש|אחרי|לפני|בשביל|כדי)\s*\./g, '.')
          .replace(/\s+(?:של|את|על|עם|כי|גם|אם|או|כש|אחרי|לפני|בשביל|כדי)\s*$/g, '')
          .replace(/,\s*\./g, '.').replace(/,\s*,/g, ',').replace(/\s+/g, ' ').replace(/\.\s*\./g, '.').trim();
        
        // ========== 8. VALIDATE AI SENTENCE (fallback if empty/short) ==========
        if (!correctedSentence || correctedSentence.length < 10 || correctedSentence === 'X') {
          // Generate direction-appropriate fallback
          if (predictedProfit >= 40) {
            if (actualStreak >= 3) correctedSentence = `${actualStreak} נצחונות ברצף, ממוצע +${allTimeAvg}₪ ב-${player.gamesPlayed} משחקים. הרוח בגב!`;
            else correctedSentence = `ממוצע +${allTimeAvg}₪ ב-${player.gamesPlayed} משחקים, ${winRate}% נצחונות. ערב טוב צפוי`;
          } else if (predictedProfit <= -40) {
            correctedSentence = `${player.gamesPlayed} משחקים ו-${winRate}% נצחונות, אבל הנתונים לא מבשרים טובות. ערב מאתגר`;
          } else if (predictedProfit > 0) {
            correctedSentence = `${winRate}% נצחונות ב-${player.gamesPlayed} משחקים, מקום ${rankTonight}. יתרון קל הפעם`;
          } else {
            correctedSentence = `${player.gamesPlayed} משחקים, ${winRate}% נצחונות. צריך לעבוד קשה הפעם`;
          }
          console.log(`⚠️ ${player.name}: Used direction-appropriate fallback sentence`);
        } else {
          console.log(`✅ ${player.name}: AI sentence: "${correctedSentence}"`);
        }
        
        return {
          ...forecast,
          sentence: correctedSentence,
          highlight: correctedHighlight
        };
      });
      
      console.log('✅ Fact-checking complete');
      // ========== END FACT-CHECKING ==========
      
      // Validate and ensure zero-sum
      let total = forecasts.reduce((sum, f) => sum + f.expectedProfit, 0);
      if (total !== 0 && forecasts.length > 0) {
        const adjustment = Math.round(total / forecasts.length);
        forecasts.forEach((f, i) => {
          if (i === 0) {
            f.expectedProfit -= (total - adjustment * (forecasts.length - 1));
          } else {
            f.expectedProfit -= adjustment;
          }
        });
      }

      return forecasts;
      
    } catch (fetchError) {
      console.log(`   ❌ ${config.model} fetch error:`, fetchError);
      continue; // Try next model
    }
  }
  
  // All models failed
  console.error('❌ All AI models failed');
  throw new Error('All AI models are rate limited or unavailable. Try again in a few minutes.');
};


// Store working config
let workingConfig: { version: string; model: string } | null = null;

/**
 * First, try to list available models to diagnose the issue
 */
const listAvailableModels = async (apiKey: string): Promise<string[]> => {
  const models: string[] = [];
  
  for (const version of ['v1beta', 'v1']) {
    try {
      const url = `https://generativelanguage.googleapis.com/${version}/models?key=${apiKey}`;
      console.log(`📋 Listing models with ${version}...`);
      
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        const foundModels = data.models?.map((m: {name: string}) => `${version}: ${m.name}`) || [];
        console.log(`Found ${foundModels.length} models with ${version}:`, foundModels);
        models.push(...foundModels);
      } else {
        const err = await response.json().catch(() => ({}));
        console.log(`${version} list failed:`, err?.error?.message || response.status);
      }
    } catch (e) {
      console.log(`${version} list error:`, e);
    }
  }
  
  return models;
};

/**
 * Test if the API key is valid - tries multiple configs
 */
export const testGeminiApiKey = async (apiKey: string): Promise<boolean> => {
  console.log('═══════════════════════════════════════');
  console.log('🔑 GEMINI API KEY TEST');
  console.log('═══════════════════════════════════════');
  console.log('Key length:', apiKey.length);
  console.log('Key prefix:', apiKey.substring(0, 10) + '...');
  console.log('Format check:', apiKey.startsWith('AIza') ? '✅ Correct (AIza...)' : '⚠️ Unusual format!');
  console.log('');
  
  // First, list available models
  console.log('📋 STEP 1: Listing available models...');
  const availableModels = await listAvailableModels(apiKey);
  
  if (availableModels.length > 0) {
    console.log(`✅ Found ${availableModels.length} models! Key is valid.`);
    console.log('');
  } else {
    console.log('');
    console.log('❌ CANNOT LIST MODELS - Key may be invalid or restricted');
    console.log('');
    console.log('🔧 POSSIBLE CAUSES:');
    console.log('   1. API key is invalid or expired');
    console.log('   2. Key was created in Google Cloud Console (need AI Studio key)');
    console.log('   3. Generative Language API not enabled');
    console.log('   4. API key has IP/referrer restrictions');
    console.log('');
    console.log('💡 SOLUTION: Create a NEW key at Google AI Studio:');
    console.log('   https://aistudio.google.com/app/apikey');
    console.log('   → Click "Create API key"');
    console.log('   → Select "Create API key in new project"');
    console.log('');
  }
  
  console.log('🧪 STEP 2: Testing generateContent with each model...');
  
  // Try all configs
  for (const config of API_CONFIGS) {
    const modelPath = config.model.startsWith('models/') ? config.model : `models/${config.model}`;
    const url = `https://generativelanguage.googleapis.com/${config.version}/${modelPath}:generateContent?key=${apiKey}`;
    
    console.log(`\n🧪 Trying ${config.version} / ${config.model}...`);
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Say: OK' }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 5 }
        })
      });

      if (response.ok) {
        workingConfig = config;
        console.log(`✅ SUCCESS! ${config.version}/${config.model} works!`);
        localStorage.setItem('gemini_working_config', JSON.stringify(config));
        return true;
      }
      
      const errorData = await response.json().catch(() => ({}));
      const errorMsg = errorData?.error?.message || `Status ${response.status}`;
      
      // 429 = rate limited but key is valid! Save config and return success
      if (response.status === 429) {
        workingConfig = config;
        console.log(`⚠️ ${config.version}/${config.model}: Rate limited but KEY IS VALID!`);
        console.log('   Wait a minute and try the forecast again.');
        localStorage.setItem('gemini_working_config', JSON.stringify(config));
        return true; // Key works, just rate limited
      }
      
      console.log(`❌ ${config.version}/${config.model}: ${errorMsg}`);
      
    } catch (error) {
      console.log(`❌ ${config.version}/${config.model} error:`, error);
    }
  }
  
  console.error('\n❌ All configurations failed.');
  console.log('\n💡 TROUBLESHOOTING:');
  console.log('1. Go to: https://aistudio.google.com/app/apikey');
  console.log('2. Delete existing API key');
  console.log('3. Click "Create API key" → "Create API key in new project"');
  console.log('4. Copy the new key and try again');
  
  return false;
};

/**
 * Get the working config
 */
const getWorkingConfig = (): { version: string; model: string } => {
  const isValidConfig = (cfg: { model: string }) =>
    API_CONFIGS.some(c => c.model === cfg.model);

  if (workingConfig && isValidConfig(workingConfig)) return workingConfig;

  const saved = localStorage.getItem('gemini_working_config');
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (isValidConfig(parsed)) {
        workingConfig = parsed;
        return workingConfig!;
      }
      localStorage.removeItem('gemini_working_config');
    } catch {
      localStorage.removeItem('gemini_working_config');
    }
  }

  return API_CONFIGS[0];
};

/**
 * Generate a short comment comparing forecast to actual results
 */
export const generateForecastComparison = async (
  forecasts: { playerName: string; expectedProfit: number }[],
  actualResults: { playerName: string; profit: number }[]
): Promise<string> => {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error('NO_API_KEY');

  const comparisons = forecasts.map(f => {
    const actual = actualResults.find(a => a.playerName === f.playerName);
    const actualProfit = actual?.profit || 0;
    const gap = Math.abs(actualProfit - f.expectedProfit);
    const directionCorrect = (f.expectedProfit >= 0 && actualProfit >= 0) || (f.expectedProfit < 0 && actualProfit < 0);
    
    let accuracyLevel: 'accurate' | 'close' | 'missed';
    if (gap <= 30) accuracyLevel = 'accurate';
    else if (gap <= 60) accuracyLevel = 'close';
    else accuracyLevel = 'missed';
    
    return { name: f.playerName, forecast: f.expectedProfit, actual: actualProfit, gap, accuracyLevel, directionCorrect };
  });

  const accurate = comparisons.filter(c => c.accuracyLevel === 'accurate').length;
  const close = comparisons.filter(c => c.accuracyLevel === 'close').length;
  const missed = comparisons.filter(c => c.accuracyLevel === 'missed').length;
  const total = comparisons.length;
  const directionHits = comparisons.filter(c => c.directionCorrect).length;
  
  const score = (accurate * 2 + close * 1);
  const maxScore = total * 2;
  const scorePercent = Math.round((score / maxScore) * 100);
  
  let rating: string;
  if (scorePercent >= 80) rating = 'מעולה';
  else if (scorePercent >= 60) rating = 'טוב';
  else if (scorePercent >= 40) rating = 'סביר';
  else rating = 'חלש';
  
  const sortedByGap = [...comparisons].sort((a, b) => a.gap - b.gap);
  const bestPrediction = sortedByGap[0];
  const worstPrediction = sortedByGap[sortedByGap.length - 1];

  const prompt = `אתה מסכם תחזית פוקר בעברית. כתוב משפט סיכום קצר ורלוונטי (עד 25 מילים) על הצלחת התחזית.

נתונים:
- ציון כולל: ${score}/${maxScore} (${scorePercent}%) - ${rating}
- כיוון נכון (רווח/הפסד): ${directionHits}/${total}
- מדויק (פער ≤30): ${accurate}/${total}
- קרוב (פער 31-60): ${close}/${total}  
- החטאה (פער >60): ${missed}/${total}
- תחזית מדויקת ביותר: ${bestPrediction.name} (פער ${bestPrediction.gap})
- תחזית רחוקה ביותר: ${worstPrediction.name} (פער ${worstPrediction.gap})

כתוב משפט סיכום שכולל את אחוז הכיוון (${directionHits}/${total}) ותובנה על התחזית. לא להיות מצחיק. כתוב רק את המשפט.`;

  const config = getWorkingConfig();
  
  const response = await fetch(
    `https://generativelanguage.googleapis.com/${config.version}/models/${config.model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 100,
        }
      })
    }
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.error?.message || `API error: ${response.status}`);
  }

  lastUsedModel = config.model;
  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  
  return text.trim() || `${accurate} מדויקים, ${close} קרובים, ${missed} החטאות מתוך ${total} תחזיות`;
};

// ─── AI Game Night Summary ──────────────────────────────────────────────────

export interface GameNightPlayerResult {
  name: string;
  profit: number;
  rebuys: number;
  rank: number; // 1 = biggest winner
}

export interface GameNightPeriodStanding {
  name: string;
  periodRank: number;
  totalProfit: number;
  gamesPlayed: number;
  winPct: number;
  currentStreak: number; // positive = wins, negative = losses
}

export interface GameNightSummaryPayload {
  tonight: GameNightPlayerResult[];
  totalRebuys: number;
  totalPot: number;
  periodLabel: string;
  periodStandings: GameNightPeriodStanding[];
  recordsBroken: string[];
  notableStreaks: string[];
  upsets: string[];
  milestones: string[];
  welcomeBacks: string[];
  rankingShifts: string[];
  gameNumberInPeriod: number;
  location?: string;
  locationInsights?: string;
  periodMarkers?: PeriodMarkers;
  comboHistoryText?: string;
}

export interface AiGenerationMeta {
  model: string;
  promptTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  totalTokens: number;
}

export interface AiSummaryResult {
  text: string;
  meta: AiGenerationMeta;
}

export const generateGameNightSummary = async (
  payload: GameNightSummaryPayload
): Promise<AiSummaryResult> => {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error('NO_API_KEY');

  const { tonight, totalRebuys, totalPot, periodLabel, periodStandings, recordsBroken, notableStreaks, upsets, milestones, welcomeBacks, rankingShifts, gameNumberInPeriod, locationInsights: summaryLocationInsights, periodMarkers: summaryPeriodMarkers, comboHistoryText } = payload;

  if (tonight.length === 0) throw new Error('No players in tonight results');

  const tonightLines = tonight.map(p =>
    `${p.rank}. ${p.name}: ${p.profit >= 0 ? '+' : ''}${p.profit}₪ (${p.rebuys} קניות)`
  ).join('\n');

  const standingsLines = periodStandings.map(s =>
    `מקום ${s.periodRank}: ${s.name} — ${s.totalProfit >= 0 ? '+' : ''}${s.totalProfit}₪, ${s.gamesPlayed} משחקים, ${Math.round(s.winPct)}% נצחונות${s.currentStreak !== 0 ? `, רצף ${s.currentStreak > 0 ? s.currentStreak + ' נצחונות' : Math.abs(s.currentStreak) + ' הפסדים'}` : ''}`
  ).join('\n');

  const contextSections: string[] = [];

  if (recordsBroken.length > 0) {
    contextSections.push(`שיאים שנשברו הערב:\n${recordsBroken.join('\n')}`);
  }
  if (notableStreaks.length > 0) {
    contextSections.push(`רצפים בולטים:\n${notableStreaks.join('\n')}`);
  }
  if (upsets.length > 0) {
    contextSections.push(`הפתעות:\n${upsets.join('\n')}`);
  }
  if (milestones.length > 0) {
    contextSections.push(`אבני דרך:\n${milestones.join('\n')}`);
  }
  if (welcomeBacks.length > 0) {
    contextSections.push(`חזרו לשולחן:\n${welcomeBacks.join('\n')}`);
  }
  if (rankingShifts.length > 0) {
    contextSections.push(`שינויים בטבלה:\n${rankingShifts.join('\n')}`);
  }
  if (comboHistoryText) {
    contextSections.push(comboHistoryText);
  }
  if (summaryLocationInsights) {
    contextSections.push(summaryLocationInsights);
  }

  const contextBlock = contextSections.length > 0
    ? `\n\nאירועים מיוחדים הערב:\n${contextSections.join('\n\n')}`
    : '';

  // Pick a random writing style so consecutive summaries feel fresh
  const styles = [
    { name: 'פרשן ספורט', desc: 'כתוב כמו פרשן ספורט ישראלי — דרמטי, עם שידור חי, ומתח. "הכדור ברשת!"' },
    { name: 'כתב עיתון', desc: 'כתוב כמו כתבה בעיתון הבוקר — עובדתי אבל עם עקיצות בין השורות. כותרת בפנים.' },
    { name: 'מספר סיפורים', desc: 'כתוב כמו סיפור קצר — מתח, עלילה, דמויות. כל שחקן הוא דמות בסיפור הערב.' },
    { name: 'סטנדאפיסט', desc: 'כתוב כמו מונולוג סטנדאפ — ביטים, עקיצות, תצפיות מצחיקות על מה שקרה. הומור קודם.' },
    { name: 'מכתב לחבר', desc: 'כתוב כמו הודעת וואטסאפ מחבר שהיה שם — אישי, ישיר, עם "אחי לא תאמין מה קרה".' },
    { name: 'פרשן פוליטי', desc: 'כתוב כמו פרשנות פוליטית — "קואליציות", "הפיכות", "צעד אסטרטגי", "מהפך" — אבל על פוקר.' },
  ];
  const style = styles[Math.floor(Math.random() * styles.length)];

  // Build period-ending summary section if applicable
  const periodEndingLines: string[] = [];
  if (summaryPeriodMarkers) {
    if (summaryPeriodMarkers.isLastGameOfMonth) {
      periodEndingLines.push(`📅 זהו המשחק האחרון של חודש ${summaryPeriodMarkers.monthName}. הוסף פסקה קצרה שמסכמת את החודש — מי הוביל, תוצאות בולטות, מגמות.`);
    }
    if (summaryPeriodMarkers.isLastGameOfHalf) {
      periodEndingLines.push(`📅 זהו המשחק האחרון של ${summaryPeriodMarkers.halfLabel}! הוסף פסקה ייעודית שמסכמת את המחצית — מי שלט, אילו קרבות היו, מה השתנה, ותחזית למחצית הבאה.`);
    }
    if (summaryPeriodMarkers.isLastGameOfYear) {
      periodEndingLines.push(`📅 זהו המשחק האחרון של שנת ${summaryPeriodMarkers.year}! הוסף פסקה ייעודית שמסכמת את השנה כולה — אלוף השנה, רגעים היסטוריים, שיאים, ותחזית לשנה הבאה.`);
    }
  }
  const periodEndingBlock = periodEndingLines.length > 0
    ? `\n\n🗓️ אירוע תקופתי (חובה — הוסף פסקאות ייעודיות!):\n${periodEndingLines.join('\n')}`
    : '';

  const prompt = `כתוב סיכום ערב פוקר שבועי בין חברים. הסיכום ישותף בקבוצת הוואטסאפ.

🎨 סגנון הערב: ${style.name}
${style.desc}

📋 "${periodLabel}" = שם התקופה (מחצית של שנה). אם מזכירים → "בתקופת ${periodLabel}" או "במחצית".

📊 נתוני הערב (משחק #${gameNumberInPeriod} ב${periodLabel}):
קופה: ${totalPot}₪ (${totalRebuys} קניות סה״כ)

תוצאות:
${tonightLines}

טבלת ${periodLabel} (מעודכנת):
${standingsLines}${contextBlock}${periodEndingBlock}

✍️ כללי כתיבה:
- עברית בלבד, טבעית וזורמת
- הזכר את כל ${tonight.length} השחקנים בשמם
- 2-3 פסקאות קצרות (שורה ריקה ביניהן), כל פסקה 2-4 משפטים
- סה״כ 60-120 מילים — דרמטי? קרוב ל-120. שקט? קרוב ל-60${periodEndingLines.length > 0 ? ` (+ פסקאות תקופתיות נוספות)` : ''}
- שלב עובדות (רצפים, שיאים, דירוגים) בצורה טבעית בתוך הסיפור, לא כרשימה
- אם יש מידע על הרכב חוזר (🔄) — שלב אותו! ציין שזה הרכב שכבר שיחק יחד, האם הדפוסים המשיכו או נשברו, מי שלט בפעמים הקודמות ומה קרה הפעם
- סיים עם פאנץ׳ליין, עקיצה, או הצצה לשבוע הבא

⚠️ דיוק עובדתי (חובה מוחלטת):
- כל מספר, רווח, הפסד, רצף, שיא ודירוג חייבים להגיע ישירות מהנתונים שלמעלה
- אם שחקן עלה או ירד בטבלה, זה יופיע ב"שינויים בטבלה". אם לא מופיע שם — אל תטען שמישהו עלה/ירד/עקף
- אל תמציא עובדות ביוגרפיות על השחקנים (מוצא, מקצוע, גיל, מיקום). אתה לא יודע דבר עליהם מלבד הנתונים
- אל תמציא שיאים, תארים או הישגים שלא מופיעים בנתונים
- אם לא בטוח — השמט. עדיף סיכום קצר ומדויק מאשר סיכום ארוך עם המצאות

🚫 הימנע מ:
- פתיחות שחוקות ("ערב של דרמות", "לילה של...")
- רשימות עם נקודות או מספרים
- כינויים חוזרים — אם אתה ממציא תואר לשחקן, שיהיה ייחודי ויצירתי

כתוב את הסיכום.`;

  for (const config of API_CONFIGS) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/${config.version}/models/${config.model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.9,
              maxOutputTokens: 4096,
              topP: 0.95,
            }
          })
        }
      );

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        console.warn(`AI summary: ${config.model} failed:`, errData?.error?.message || response.status);
        continue;
      }

      const data = await response.json();
      const candidate = data?.candidates?.[0];
      const text = candidate?.content?.parts?.[0]?.text?.trim();
      const finishReason = candidate?.finishReason;
      const usage = data?.usageMetadata;

      if (finishReason === 'MAX_TOKENS') {
        console.warn(`AI summary: ${config.model} hit token limit — response truncated, retrying with next model`);
        continue;
      }

      if (text && text.length > 50) {
        const cleaned = text
          .replace(/\*\*/g, '')
          .replace(/\*/g, '')
          .replace(/^#{1,3}\s+/gm, '')
          .trim();
        console.log(`AI summary generated via ${config.model} (${cleaned.length} chars, finishReason: ${finishReason})`);
        lastUsedModel = config.model;
        return {
          text: cleaned,
          meta: {
            model: config.model,
            promptTokens: usage?.promptTokenCount || 0,
            outputTokens: usage?.candidatesTokenCount || 0,
            thinkingTokens: usage?.thoughtsTokenCount || 0,
            totalTokens: usage?.totalTokenCount || 0,
          },
        };
      }
      console.warn(`AI summary: ${config.model} returned empty/short response (${text?.length || 0} chars)`);
    } catch (err) {
      console.warn(`AI summary: ${config.model} error:`, err);
    }
  }

  throw new Error('All AI models failed to generate game summary');
};

// ─── AI Player Chronicle ──────────────────────────────────────────────────

export interface ChroniclePlayerData {
  playerId: string;
  name: string;
  periodRank: number;
  totalProfit: number;
  gamesPlayed: number;
  winPercentage: number;
  avgProfit: number;
  currentStreak: number;
  biggestWin: number;
  biggestLoss: number;
  avgRebuysPerGame: number | null;
  lastGameDate: string | null;
  daysSinceLastGame: number;
  recentForm: string;
  archetype: string;
  allTimeRank: number | null;
  allTimeGames: number | null;
  allTimeProfit: number | null;
}

export interface ChroniclePayload {
  players: ChroniclePlayerData[];
  periodLabel: string;
  totalPeriodGames: number;
  isEarlyPeriod: boolean;
  milestones: string[];
}

export const generatePlayerChronicle = async (
  payload: ChroniclePayload
): Promise<Record<string, string>> => {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error('NO_API_KEY');

  const { players, periodLabel, totalPeriodGames, isEarlyPeriod, milestones } = payload;
  if (players.length === 0) throw new Error('No players for chronicle');

  const playerLines = players.map(p => {
    const parts = [
      `[${p.playerId}] ${p.name}`,
      `מקום ${p.periodRank}, ${p.totalProfit >= 0 ? '+' : ''}${p.totalProfit}₪`,
      `${p.gamesPlayed} משחקים, ${Math.round(p.winPercentage)}% נצחונות`,
      `ממוצע ${p.avgProfit >= 0 ? '+' : ''}${Math.round(p.avgProfit)}₪`,
      `ארכיטיפ: ${p.archetype}`,
    ];
    if (p.currentStreak !== 0)
      parts.push(`רצף: ${p.currentStreak > 0 ? p.currentStreak + ' נצחונות' : Math.abs(p.currentStreak) + ' הפסדים'}`);
    parts.push(`שיא: +${Math.round(p.biggestWin)}₪, שפל: ${Math.round(p.biggestLoss)}₪`);
    if (p.avgRebuysPerGame != null)
      parts.push(`קניות בממוצע: ${p.avgRebuysPerGame.toFixed(1)}`);
    if (p.daysSinceLastGame > 10)
      parts.push(`נעדר ${p.daysSinceLastGame} יום`);
    parts.push(`פורמה אחרונה: ${p.recentForm}`);
    if (p.allTimeRank != null && p.allTimeGames != null)
      parts.push(`כל הזמנים: מקום ${p.allTimeRank}, ${p.allTimeGames} משחקים, ${p.allTimeProfit! >= 0 ? '+' : ''}${p.allTimeProfit}₪`);
    return parts.join(' | ');
  }).join('\n');

  const styles = [
    { name: 'פרשן ספורט', desc: 'כתוב כמו פרשן ספורט ישראלי — דרמטי, ציורי, עם "ניצחון מוחץ", "מנצח נגד הסיכויים".' },
    { name: 'כתב עיתון', desc: 'כתוב כמו כתבה בעיתון — עובדתי, חד, עם כותרת משנה לכל שחקן.' },
    { name: 'מספר סיפורים', desc: 'כתוב כמו סיפור קצר — כל שחקן הוא דמות. בונה עלילה ומתח.' },
    { name: 'מכתב לחבר', desc: 'כתוב כמו הודעת וואטסאפ — "אחי, מה שקורה לX זה לא נורמלי". אישי וקולע.' },
    { name: 'פרשן פוליטי', desc: 'כתוב כמו פרשנות פוליטית — "קואליציות", "הפיכות", "צעד טקטי" — אבל על פוקר.' },
    { name: 'כרוניקה היסטורית', desc: 'כתוב כמו כרוניקה של ימי הביניים — "בני האצולה", "הפרשים", "המלך ירד מכסאו".' },
  ];
  const style = styles[Math.floor(Math.random() * styles.length)];

  const prompt = `אתה כותב פרופיל אישי קצר לכל שחקן בליגת פוקר בין חברים. הפרופילים יוצגו בדף הסטטיסטיקה.

🎨 סגנון: ${style.name}
${style.desc}

📋 תקופה: "${periodLabel}" (${totalPeriodGames} משחקים)${isEarlyPeriod ? ' — התקופה רק התחילה, היזהר ממסקנות גורפות' : ''}

📊 נתוני השחקנים (מדורגים לפי רווח):
${playerLines}${milestones.length > 0 ? `

🏆 אבני דרך ואירועים בולטים בתקופה:
${milestones.join('\n')}` : ''}

✍️ כללי כתיבה:
- כתוב פסקה אחת (2-4 משפטים) לכל שחקן
- עברית טבעית, זורמת, מעניינת — לא רובוטית, לא טמפלייט
- השווה בין שחקנים! ("בזמן ש-X שולט, Y מנסה להחזיר")
- שלב נתונים אמיתיים (מספרים, רצפים, דירוגים) בצורה טבעית
- אם שחקן נעדר — ציין את זה בהקשר הסיפור
- אם יש פער בין דירוג התקופה לכל הזמנים — זה מעניין, ציין
- כל שחקן צריך להרגיש ייחודי — אל תחזור על אותו מבנה
- אל תתחיל 2 פרופילים באותו אופן
- אם יש אבני דרך רלוונטיות לשחקן — שלב אותן בסיפור בצורה טבעית

⚠️ דיוק עובדתי (חובה מוחלטת):
- כל מספר, דירוג, רצף ותוצאה חייבים להגיע מהנתונים שלמעלה בלבד
- אל תמציא עובדות, כינויים קבועים, תארים או הישגים
- אם לא בטוח — השמט. עדיף קצר ומדויק מאשר ארוך עם המצאות

📤 פורמט הפלט:
כתוב כל פרופיל בשורה נפרדת בפורמט:
PLAYER_ID:::הטקסט של הפרופיל

דוגמה (לא להעתיק — רק פורמט):
abc123:::בזמן שכולם מחפשים את הנוסחה, הוא כבר מצא אותה. 3 נצחונות מתוך 5, ממוצע +85₪, ומקום ראשון שלא מפתיע אף אחד.

כתוב את הפרופילים.`;

  for (const config of API_CONFIGS) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/${config.version}/models/${config.model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.9,
              maxOutputTokens: 4096,
              topP: 0.95,
            }
          })
        }
      );

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        console.warn(`Chronicle: ${config.model} failed:`, errData?.error?.message || response.status);
        continue;
      }

      const data = await response.json();
      const candidate = data?.candidates?.[0];
      const text = candidate?.content?.parts?.[0]?.text?.trim();
      const finishReason = candidate?.finishReason;

      if (finishReason === 'MAX_TOKENS') {
        console.warn(`Chronicle: ${config.model} hit token limit, retrying`);
        continue;
      }

      if (!text || text.length < 30) {
        console.warn(`Chronicle: ${config.model} returned empty/short (${text?.length || 0} chars)`);
        continue;
      }

      const cleaned = text
        .replace(/\*\*/g, '')
        .replace(/\*/g, '')
        .replace(/^#{1,3}\s+/gm, '')
        .trim();

      const profiles: Record<string, string> = {};
      const lines = cleaned.split('\n').filter((l: string) => l.includes(':::'));
      for (const line of lines) {
        const sepIdx = line.indexOf(':::');
        if (sepIdx === -1) continue;
        const id = line.substring(0, sepIdx).trim();
        const story = line.substring(sepIdx + 3).trim();
        if (id && story) profiles[id] = story;
      }

      if (Object.keys(profiles).length === 0) {
        console.warn(`Chronicle: ${config.model} returned text but no parseable profiles`);
        continue;
      }

      console.log(`Chronicle generated via ${config.model}: ${Object.keys(profiles).length} profiles`);
      lastUsedModel = config.model;
      return profiles;
    } catch (err) {
      console.warn(`Chronicle: ${config.model} error:`, err);
    }
  }

  throw new Error('All AI models failed to generate player chronicle');
};

// ─── AI Graph Insights (group-level narrative for Graphs page) ──────────────

export const generateGraphInsights = async (
  playerStats: PlayerStats[],
  periodLabel: string,
  totalGames: number,
  isEarlyPeriod: boolean
): Promise<string> => {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error('NO_API_KEY');

  if (playerStats.length === 0) throw new Error('No player stats for graph insights');

  const sorted = [...playerStats].sort((a, b) => b.totalProfit - a.totalProfit);

  const playerLines = sorted.map((p, i) => {
    const parts = [
      `${i + 1}. ${p.playerName}`,
      `רווח כולל: ${p.totalProfit >= 0 ? '+' : ''}${Math.round(p.totalProfit)}₪`,
      `${p.gamesPlayed} משחקים`,
      `${Math.round(p.winPercentage)}% נצחונות`,
      `ממוצע ${p.avgProfit >= 0 ? '+' : ''}${Math.round(p.avgProfit)}₪`,
    ];
    if (i < sorted.length - 1) {
      const gap = Math.round(p.totalProfit - sorted[i + 1].totalProfit);
      parts.push(`פער מהבא: ${gap}₪`);
    }
    if (i > 0) {
      const gapAbove = Math.round(sorted[i - 1].totalProfit - p.totalProfit);
      parts.push(`פער מלמעלה: ${gapAbove}₪`);
    }
    if (p.currentStreak !== 0) {
      parts.push(`רצף: ${p.currentStreak > 0 ? p.currentStreak + ' נצחונות' : Math.abs(p.currentStreak) + ' הפסדים'}`);
    }
    parts.push(`שיא: +${Math.round(p.biggestWin)}₪, שפל: ${Math.round(p.biggestLoss)}₪`);
    if (p.longestWinStreak >= 3) parts.push(`שיא רצף נצחונות: ${p.longestWinStreak}`);
    if (p.longestLossStreak >= 3) parts.push(`שיא רצף הפסדים: ${p.longestLossStreak}`);
    return parts.join(' | ');
  }).join('\n');

  const styles = [
    'פרשן ספורט ישראלי שמנתח את הליגה ברגע הכי חם של העונה',
    'כתב עיתון שכותב טור שבועי על מאזן הכוחות בשולחן',
    'מספר סיפורים שנון שמציג את הדרמות והקשרים בקבוצה',
    'פרשן פוליטי שמנתח את הקואליציות וההפיכות בטבלת הפוקר',
    'כרוניקאי היסטורי שמתעד את עליות ומפלות הגיבורים',
  ];
  const style = styles[Math.floor(Math.random() * styles.length)];

  const prompt = `אתה ${style}. כתוב פסקה אחת רציפה בעברית (60-120 מילים) שמספרת את סיפור הקבוצה בתקופת "${periodLabel}".

📊 טבלת השחקנים (${totalGames} משחקים${isEarlyPeriod ? ', התקופה רק התחילה' : ''}):
${playerLines}

✍️ מה לכלול:
- מגמות: מי שולט? מי עולה? מי בנפילה?
- יריבויות ומרדפים: מי רודף את מי בטבלה? מהם הפערים?
- מומנטום: מי ברצף חם ומי בקרח? מי שובר שיאים?
- תחזית/ניחוש: מה צפוי בהמשך? מי יפתיע?
- הזכר כמה שיותר שחקנים בשמם

⚠️ כללים:
- פסקה אחת זורמת, לא רשימה עם נקודות
- כל מספר, רצף ודירוג חייבים להגיע מהנתונים שלמעלה בלבד
- אל תמציא עובדות, כינויים קבועים, או הישגים
- "רווח כולל" = סך כל הרווח של השחקן. "פער" = ההפרש בין שני שחקנים סמוכים בטבלה. אלו מספרים שונים! אל תבלבל ביניהם
- כשמציין פער בטבלה, השתמש במספר מ"פער מהבא" או "פער מלמעלה", לא מהרווח הכולל
- אם לא בטוח — השמט${isEarlyPeriod ? '\n- התקופה רק התחילה, היזהר ממסקנות גורפות' : ''}

כתוב את הפסקה.`;

  for (const config of API_CONFIGS) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/${config.version}/models/${config.model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.9,
              maxOutputTokens: 1024,
              topP: 0.95,
            }
          })
        }
      );

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        console.warn(`Graph insights: ${config.model} failed:`, errData?.error?.message || response.status);
        continue;
      }

      const data = await response.json();
      const candidate = data?.candidates?.[0];
      const text = candidate?.content?.parts?.[0]?.text?.trim();
      const finishReason = candidate?.finishReason;

      if (finishReason === 'MAX_TOKENS') {
        console.warn(`Graph insights: ${config.model} hit token limit, retrying`);
        continue;
      }

      if (!text || text.length < 50) {
        console.warn(`Graph insights: ${config.model} returned empty/short (${text?.length || 0} chars)`);
        continue;
      }

      const cleaned = text
        .replace(/\*\*/g, '')
        .replace(/\*/g, '')
        .replace(/^#{1,3}\s+/gm, '')
        .trim();

      console.log(`Graph insights generated via ${config.model} (${cleaned.length} chars)`);
      lastUsedModel = config.model;
      return cleaned;
    } catch (err) {
      console.warn(`Graph insights: ${config.model} error:`, err);
    }
  }

  throw new Error('All AI models failed to generate graph insights');
};

// --- Live Game TTS Pool Generator ---

interface TTSPlayerInput {
  id: string;
  name: string;
  stats: PlayerStats | null;
  traits: typeof playerTraitsByName[string] | undefined;
}

export const generateLiveGameTTSPool = async (
  gameId: string,
  playerIds: string[],
  playerNames: string[],
  allStats: PlayerStats[],
  location?: string,
): Promise<LiveGameTTSPool | null> => {
  const apiKey = getGeminiApiKey();
  if (!apiKey) return null;

  const rebuyRecords = getRebuyRecords();
  const comboHistory = getComboHistory(playerIds, gameId);

  const players: TTSPlayerInput[] = playerIds.map((id, i) => ({
    id,
    name: playerNames[i],
    stats: allStats.find(s => s.playerId === id) || null,
    traits: playerTraitsByName[playerNames[i]],
  }));

  const playerDataLines = players.map(p => {
    const lines: string[] = [`═ ${p.name} ═`];

    if (p.traits) {
      const traitParts: string[] = [];
      if (p.traits.job) traitParts.push(`עבודה: ${p.traits.job}`);
      if (p.traits.team) traitParts.push(`קבוצה: ${p.traits.team}`);
      if (p.traits.nickname) traitParts.push(`כינוי: ${p.traits.nickname}`);
      if (p.traits.style.length) traitParts.push(`סגנון: ${p.traits.style.join(', ')}`);
      if (p.traits.quirks.length) traitParts.push(`תכונות: ${p.traits.quirks.join(', ')}`);
      lines.push(traitParts.join(' | '));
    }

    if (p.stats && p.stats.gamesPlayed >= 2) {
      const s = p.stats;
      lines.push(`משחקים: ${s.gamesPlayed}, נצחונות: ${s.winCount} (${Math.round(s.winPercentage)}%), רווח כולל: ${Math.round(s.totalProfit)}₪`);
      lines.push(`ממוצע: ${Math.round(s.avgProfit)}₪, ממוצע קניות: ${s.avgRebuysPerGame.toFixed(1)}, סה"כ קניות: ${s.totalRebuys}`);
      lines.push(`שיא נצחון: +${Math.round(s.biggestWin)}₪, שיא הפסד: ${Math.round(s.biggestLoss)}₪`);
      const streak = s.currentStreak;
      if (streak >= 2) lines.push(`רצף: ${streak} נצחונות ברצף`);
      else if (streak <= -2) lines.push(`רצף: ${Math.abs(streak)} הפסדים ברצף`);
      const maxRebuys = rebuyRecords.playerMax.get(p.id) || 0;
      if (maxRebuys > 0) lines.push(`שיא קניות אישי: ${maxRebuys}`);
    } else {
      lines.push(`שחקן חדש / מעט היסטוריה`);
    }

    return lines.join('\n');
  }).join('\n\n');

  const groupMaxRebuys = rebuyRecords.groupMax;

  let comboText = '';
  if (!comboHistory.isFirstTime && comboHistory.totalGamesWithCombo >= 2) {
    const topWinners = comboHistory.repeatWinners.slice(0, 3).map(w => `${w.name} (${w.count} נצחונות)`).join(', ');
    const topLosers = comboHistory.repeatLosers.slice(0, 3).map(l => `${l.name} (${l.count} הפסדים)`).join(', ');
    comboText = `הרכב חוזר: ${comboHistory.totalGamesWithCombo} משחקים קודמים עם אותו הרכב.`;
    if (topWinners) comboText += ` מנצחים חוזרים: ${topWinners}.`;
    if (topLosers) comboText += ` מפסידים חוזרים: ${topLosers}.`;
  }

  const rivalryPairs: { p1: string; p2: string; desc: string }[] = [];
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i], b = players[j];
      if (!a.stats || !b.stats || a.stats.gamesPlayed < 3 || b.stats.gamesPlayed < 3) continue;
      const sameTeam = a.traits?.team && b.traits?.team && a.traits.team === b.traits.team;
      const sameJob = a.traits?.job && b.traits?.job && (a.traits.job === b.traits.job || (a.traits.job.includes('הייטק') && b.traits.job.includes('הייטק')));
      if (sameTeam) {
        rivalryPairs.push({ p1: a.name, p2: b.name, desc: `אוהדי ${a.traits!.team!} ביחד` });
      }
      if (sameJob) {
        rivalryPairs.push({ p1: a.name, p2: b.name, desc: `שניהם עובדים ב${a.traits!.job!}` });
      }
    }
  }

  const playerNamesList = players.map(p => p.name).join(', ');
  const numPlayers = players.length;

  const prompt = `אתה כותב יצירתי לאפליקציית פוקר. המשימה: ליצור בנק משפטים קצרים בעברית מושלמת להקראה קולית (TTS) בערב פוקר חי.

הדרישה המרכזית: כל משפט חייב להיות ספציפי לשחקן ולמצב. אסורים משפטים גנריים שאפשר להגיד על כל אחד. כל משפט חייב להכיל לפחות עובדה אחת אמיתית מהנתונים — שם העבודה, הקבוצה, אחוז הנצחונות, שיא רווח, סגנון משחק, תכונה אישית, או קשר בין שחקנים.

═══ נתוני השחקנים ═══
${playerDataLines}

${comboText ? `═══ היסטוריית הרכב ═══\n${comboText}\n` : ''}${location ? `═══ מיקום ═══\n${location}\n` : ''}שיא קניות קבוצתי: ${groupMaxRebuys}
${rivalryPairs.length > 0 ? `\n═══ קשרים ═══\n${rivalryPairs.map(r => `${r.p1} ↔ ${r.p2}: ${r.desc}`).join('\n')}\n` : ''}
═══ הנחיות ═══

כל "text" הוא 5-20 מילים, עברית דיבורית, מצחיק, חד וקולע.

פלייסהולדרים (יוחלפו בזמן אמת):
- {PLAYER} = שם השחקן
- {COUNT} = מספר קניות (יומר לעברית נקבה: "שלוש קניות")
- {RECORD} = שיא הקניות (יומר לעברית זכר: "שבעה")
- {RIVAL} = שם היריב
- {RANK} = מקום בטבלת הקניות

חוקים:
1. כל משפט ייחודי — אסורים חזרות, תבניות דומות, או וריאציות קלות
2. חובה: לשלב עובדות אמיתיות מהנתונים בכל משפט. אם לשחקן יש עבודה — לציין. אם יש קבוצה — לציין. אם יש אחוז נצחונות — להשתמש. אם יש שיא רווח/הפסד — להזכיר. משפט בלי עובדה אמיתית = פסול.
3. הומור חברי — ציני אבל חם, בלי לפגוע
4. שחקן ללא היסטוריה → משפטי "ברוך הבא" ללא המצאת נתונים
5. לגוון: לפחות 2 מתוך 6 הגנריים בלי {COUNT} כלל — רק שם + עובדה אישית קבועה
6. בלי פתיחות חוזרות, בלי "נו" חוזר, בלי "עוד קנייה" חוזר

═══ קטגוריות ═══

"players" — לכל שחקן (${playerNamesList}):
  "generic": 6 משפטים — כל אחד חייב להיות ספציפי לשחקן הזה ורק לו. לפחות 4 מתוכם עם {COUNT}. לפחות 2 בלי {COUNT} (רק עובדה אישית).
    דוגמאות טובות (כל אחד מתאים רק לשחקן אחד):
    - "איש הפיננסים קיבל תשואה שלילית, כבר {COUNT} קניות" ← ספציפי לאייל
    - "מהנדס בטיחות שלא בדק את הארנק, {COUNT} קניות" ← ספציפי לארז
    - "רואה חשבון שהמאזן שלו הערב במינוס עמוק" ← ספציפי לליכטר, בלי COUNT
    - "באיירן מנצחים, פיליפ מפסיד, {COUNT} קניות" ← ספציפי לפיליפ
    דוגמאות רעות (גנריים, אסורים):
    - "עוד קנייה, הערב ארוך" ← אפשר להגיד על כל אחד
    - "{PLAYER} ממשיך להאמין, כבר {COUNT}" ← אפשר להגיד על כל אחד
    - "הקלפים לא מרחמים, {COUNT} קניות" ← אין שום עובדה אישית
  "anticipated":
    "above_avg": 2 משפטים — מספר קניות עלה על הממוצע האישי. חובה {COUNT}. לציין את הממוצע האמיתי מהנתונים.
    "record_tied": 2 משפטים — השווה לשיא האישי. חובה {COUNT} ו{RECORD}.
    "record_broken": 2 משפטים — שבר שיא אישי. חובה {COUNT}. לציין שזה שיא חדש.
    "is_leader": 2 משפטים — מוביל בקניות הערב. חובה {RANK} או {COUNT}.
    "rival_matched": 2 משפטים — השווה ליריב. חובה {RIVAL}. רק אם יש יריבות מוגדרת.
    "tied_for_lead": 2 משפטים — שניים/יותר שווים בראש טבלת הקניות. חובה {COUNT}. לציין עובדה אישית.

"shared":
  "first_blood": ${numPlayers} משפטים — קנייה ראשונה של הערב. חובה {PLAYER}. לשלב עובדה אישית על השחקן (כל משפט לשחקן אחר).
  "opening_ceremony": ${numPlayers} משפטים — פתיחת ערב. ללא פלייסהולדרים! שמות מלאים של כל ${numPlayers} השחקנים. כל משפט אפי ושונה.
  "bad_beat": לכל שחקן 3 משפטים. חובה {PLAYER}. לשלב תכונה אישית (עבודה/קבוצה/סגנון).
  "bad_beat_generic": 5 משפטים ללא שם שחקן.
  "big_hand": לכל שחקן 3 משפטים. חובה {PLAYER}. לשלב תכונה אישית.
  "big_hand_generic": 5 משפטים ללא שם שחקן.
  "break_time": 6 משפטים — הפסקה. ללא פלייסהולדרים. לשלב שמות שחקנים מהערב הנוכחי.
  "auto_announce": 10 משפטים — שקט ארוך. ללא פלייסהולדרים. חובה לשלב שמות ועובדות ספציפיות מהנתונים (מי מנצח הכי הרבה, מי מפסיד, יריבויות, עבודות).
  "awards_generosity": 4 משפטים — מי שקנה הכי הרבה. חובה {PLAYER} ו{COUNT}. לשלב עובדה אישית.
  "awards_survival": 4 משפטים — מי שקנה הכי פחות. חובה {PLAYER}. לשלב עובדה אישית.

"rivalries": מערך יריבויות. לכל אחת: player1, player2, description.

═══ פורמט JSON ═══
{
  "players": {
    "שם": {
      "generic": [{"text": "...", "placeholders": ["{COUNT}"]}, {"text": "משפט בלי COUNT, רק עובדה"}],
      "anticipated": {
        "above_avg": [{"text": "...", "placeholders": ["{COUNT}"]}],
        "tied_for_lead": [{"text": "...", "placeholders": ["{COUNT}"]}]
      }
    }
  },
  "shared": {
    "first_blood": [{"text": "...", "placeholders": ["{PLAYER}"]}],
    "opening_ceremony": [{"text": "..."}],
    "bad_beat": {"שם": [{"text": "...", "placeholders": ["{PLAYER}"]}]},
    "bad_beat_generic": [{"text": "..."}],
    "big_hand": {"שם": [{"text": "...", "placeholders": ["{PLAYER}"]}]},
    "big_hand_generic": [{"text": "..."}],
    "break_time": [{"text": "..."}],
    "auto_announce": [{"text": "..."}],
    "awards_generosity": [{"text": "...", "placeholders": ["{PLAYER}", "{COUNT}"]}],
    "awards_survival": [{"text": "...", "placeholders": ["{PLAYER}"]}]
  },
  "rivalries": [{"player1": "...", "player2": "...", "description": "..."}]
}`;

  console.log(`🎙️ TTS Pool: generating for ${numPlayers} players (${playerNamesList})...`);

  for (const config of API_CONFIGS) {
    const modelPath = config.model.startsWith('models/') ? config.model : `models/${config.model}`;
    const url = `https://generativelanguage.googleapis.com/${config.version}/${modelPath}:generateContent?key=${apiKey}`;

    console.log(`   TTS Pool: trying ${config.model}...`);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.85,
            topP: 0.95,
            maxOutputTokens: 16384,
            responseMimeType: 'application/json',
          },
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        console.warn(`   TTS Pool: ${config.model} failed:`, errData?.error?.message || response.status);
        if (response.status === 429 || response.status === 404) continue;
        continue;
      }

      const data = await response.json();
      const candidate = data?.candidates?.[0];
      const text = candidate?.content?.parts?.[0]?.text;
      const finishReason = candidate?.finishReason;

      if (finishReason === 'MAX_TOKENS') {
        console.warn(`   TTS Pool: ${config.model} hit token limit, trying next...`);
        continue;
      }

      if (!text) {
        console.warn(`   TTS Pool: ${config.model} returned empty`);
        continue;
      }

      let jsonText = text;
      if (text.includes('```json')) {
        jsonText = text.split('```json')[1].split('```')[0];
      } else if (text.includes('```')) {
        jsonText = text.split('```')[1].split('```')[0];
      }

      const parsed = JSON.parse(jsonText.trim());

      const pool = buildPoolFromParsed(parsed, gameId, players, rivalryPairs);

      const totalMessages = countPoolMessages(pool);
      console.log(`   ✅ TTS Pool generated via ${config.model}: ${totalMessages} messages`);
      lastUsedModel = config.model;
      return pool;
    } catch (err) {
      console.warn(`   TTS Pool: ${config.model} error:`, err);
    }
  }

  console.error('❌ TTS Pool: all models failed');
  return null;
};

function ensureMessageArray(raw: unknown): TTSMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((m): m is TTSMessage =>
    m && typeof m === 'object' && typeof (m as TTSMessage).text === 'string' && (m as TTSMessage).text.length > 0
  );
}

function ensureMessageRecord(raw: unknown): Record<string, TTSMessage[]> {
  if (!raw || typeof raw !== 'object') return {};
  const result: Record<string, TTSMessage[]> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const msgs = ensureMessageArray(val);
    if (msgs.length > 0) result[key] = msgs;
  }
  return result;
}

function buildPoolFromParsed(
  parsed: Record<string, unknown>,
  gameId: string,
  players: TTSPlayerInput[],
  rivalryPairs: { p1: string; p2: string; desc: string }[],
): LiveGameTTSPool {
  const rawPlayers = (parsed.players || {}) as Record<string, Record<string, unknown>>;
  const rawShared = (parsed.shared || {}) as Record<string, unknown>;

  const poolPlayers: Record<string, TTSPlayerMessages> = {};
  for (const p of players) {
    const raw = rawPlayers[p.name] || {};
    const generic = ensureMessageArray(raw.generic);
    const anticipated = raw.anticipated as Record<string, unknown> | undefined;

    const playerEntry: TTSPlayerMessages = {
      generic: generic.length > 0 ? generic : [{ text: `${p.name} קנה עוד אחד, הערב ממשיך`, placeholders: [] }],
    };

    if (anticipated && typeof anticipated === 'object') {
      const antMap: TTSPlayerMessages['anticipated'] = {};
      const categories = ['above_avg', 'record_tied', 'record_broken', 'is_leader', 'rival_matched', 'tied_for_lead'] as const;
      for (const cat of categories) {
        const msgs = ensureMessageArray(anticipated[cat]);
        if (msgs.length > 0) antMap[cat] = msgs;
      }
      if (Object.keys(antMap).length > 0) playerEntry.anticipated = antMap;
    }

    poolPlayers[p.name] = playerEntry;
  }

  const rivalries: TTSRivalry[] = [];
  const rawRivalries = parsed.rivalries;
  if (Array.isArray(rawRivalries)) {
    for (const r of rawRivalries) {
      if (r && typeof r === 'object' && typeof r.player1 === 'string' && typeof r.player2 === 'string') {
        rivalries.push({ player1: r.player1, player2: r.player2, description: r.description || '' });
      }
    }
  }
  for (const rp of rivalryPairs) {
    if (!rivalries.some(r => (r.player1 === rp.p1 && r.player2 === rp.p2) || (r.player1 === rp.p2 && r.player2 === rp.p1))) {
      rivalries.push({ player1: rp.p1, player2: rp.p2, description: rp.desc });
    }
  }

  return {
    gameId,
    generatedAt: new Date().toISOString(),
    players: poolPlayers,
    shared: {
      first_blood: ensureMessageArray(rawShared.first_blood),
      opening_ceremony: ensureMessageArray(rawShared.opening_ceremony),
      bad_beat: ensureMessageRecord(rawShared.bad_beat),
      bad_beat_generic: ensureMessageArray(rawShared.bad_beat_generic),
      big_hand: ensureMessageRecord(rawShared.big_hand),
      big_hand_generic: ensureMessageArray(rawShared.big_hand_generic),
      break_time: ensureMessageArray(rawShared.break_time),
      auto_announce: ensureMessageArray(rawShared.auto_announce),
      awards_generosity: ensureMessageArray(rawShared.awards_generosity),
      awards_survival: ensureMessageArray(rawShared.awards_survival),
    },
    rivalries,
    usedIndices: {},
  };
}

function countPoolMessages(pool: LiveGameTTSPool): number {
  let count = 0;
  for (const pm of Object.values(pool.players)) {
    count += pm.generic.length;
    if (pm.anticipated) {
      for (const msgs of Object.values(pm.anticipated)) {
        if (msgs) count += msgs.length;
      }
    }
  }
  const s = pool.shared;
  count += s.first_blood.length + s.opening_ceremony.length;
  count += s.bad_beat_generic.length + s.big_hand_generic.length;
  count += s.break_time.length + s.auto_announce.length;
  count += s.awards_generosity.length + s.awards_survival.length;
  for (const msgs of Object.values(s.bad_beat)) count += msgs.length;
  for (const msgs of Object.values(s.big_hand)) count += msgs.length;
  return count;
}

