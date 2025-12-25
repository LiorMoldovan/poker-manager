/**
 * Google Gemini AI Integration for Poker Forecasts
 * Free tier: 15 requests/minute (gemini-1.5-flash)
 * Get your API key at: https://aistudio.google.com/app/apikey
 */

// API versions and models to try (based on actual available models Dec 2024)
// Ordered by free tier quota (lite models have higher limits)
const API_CONFIGS = [
  // Lite models first (higher free tier limits)
  { version: 'v1beta', model: 'gemini-2.0-flash-lite' },
  { version: 'v1beta', model: 'gemini-2.5-flash-lite' },
  // Then regular flash models
  { version: 'v1beta', model: 'gemini-2.0-flash' },
  { version: 'v1beta', model: 'gemini-2.5-flash' },
  // Specific versions as fallback
  { version: 'v1beta', model: 'gemini-2.0-flash-001' },
  { version: 'v1', model: 'gemini-2.0-flash' },
];

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
  gameHistory: { profit: number; date: string; gameId: string }[];
  daysSinceLastGame: number;
  isActive: boolean; // played in last 2 months
}

export interface ForecastResult {
  name: string;
  expectedProfit: number;
  highlight: string;
  sentence: string;
  isSurprise: boolean;
}

export interface MilestoneItem {
  emoji: string;
  title: string;
  description: string;
  priority: number; // Higher = more interesting
}

/**
 * Generate top milestones for tonight's game
 * Returns the most interesting 7-10 milestones
 */
export const generateMilestones = (players: PlayerForecastData[]): MilestoneItem[] => {
  const milestones: MilestoneItem[] = [];
  
  // Helper: Parse date from game history
  const parseGameDate = (dateStr: string): Date => {
    const parts = dateStr.split('/');
    if (parts.length >= 3) {
      const day = parseInt(parts[0]);
      const month = parseInt(parts[1]) - 1;
      let year = parseInt(parts[2]);
      if (year < 100) year += 2000;
      return new Date(year, month, day);
    }
    return new Date(dateStr);
  };
  
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const currentHalf = currentMonth < 6 ? 1 : 2;
  const halfStartMonth = currentHalf === 1 ? 0 : 6;
  const monthNames = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  const halfName = currentHalf === 1 ? 'H1' : 'H2';
  
  // Calculate period stats
  const playerPeriodStats = players.map(p => {
    const thisYearGames = p.gameHistory.filter(g => parseGameDate(g.date).getFullYear() === currentYear);
    const thisHalfGames = p.gameHistory.filter(g => {
      const d = parseGameDate(g.date);
      return d.getFullYear() === currentYear && d.getMonth() >= halfStartMonth && d.getMonth() < halfStartMonth + 6;
    });
    const thisMonthGames = p.gameHistory.filter(g => {
      const d = parseGameDate(g.date);
      return d.getFullYear() === currentYear && d.getMonth() === currentMonth;
    });
    
    return {
      ...p,
      yearProfit: thisYearGames.reduce((sum, g) => sum + g.profit, 0),
      yearGames: thisYearGames.length,
      halfProfit: thisHalfGames.reduce((sum, g) => sum + g.profit, 0),
      halfGames: thisHalfGames.length,
      monthProfit: thisMonthGames.reduce((sum, g) => sum + g.profit, 0),
      monthGames: thisMonthGames.length,
    };
  });
  
  const sortedByTotalProfit = [...players].sort((a, b) => b.totalProfit - a.totalProfit);
  const sortedByYearProfit = [...playerPeriodStats].sort((a, b) => b.yearProfit - a.yearProfit);
  
  // 1. STREAK RECORDS (highest priority)
  const maxWinStreak = Math.max(...players.map(p => p.currentStreak), 0);
  const maxLoseStreak = Math.min(...players.map(p => p.currentStreak), 0);
  
  players.forEach(p => {
    if (p.currentStreak >= 3 && p.currentStreak >= maxWinStreak) {
      milestones.push({
        emoji: '🔥',
        title: `${p.name} - רצף נצחונות!`,
        description: `${p.currentStreak} נצחונות רצופים. נצחון הלילה = שיא קבוצתי חדש!`,
        priority: 95
      });
    }
    if (p.currentStreak <= -3 && p.currentStreak <= maxLoseStreak) {
      milestones.push({
        emoji: '❄️',
        title: `${p.name} - רצף הפסדים`,
        description: `${Math.abs(p.currentStreak)} הפסדים רצופים. הפסד נוסף = שיא שלילי חדש!`,
        priority: 90
      });
    }
  });
  
  // 2. LEADERBOARD PASSING (high priority)
  for (let i = 1; i < sortedByTotalProfit.length; i++) {
    const chaser = sortedByTotalProfit[i];
    const leader = sortedByTotalProfit[i - 1];
    const gap = leader.totalProfit - chaser.totalProfit;
    if (gap > 0 && gap <= 200) {
      milestones.push({
        emoji: '📈',
        title: `מרדף בטבלה!`,
        description: `${chaser.name} (${chaser.totalProfit >= 0 ? '+' : ''}${chaser.totalProfit}₪) יכול לעקוף את ${leader.name} עם +${gap}₪ הלילה!`,
        priority: 85 - i * 5
      });
    }
  }
  
  // 3. CLOSE BATTLES (high priority)
  for (let i = 0; i < sortedByTotalProfit.length; i++) {
    for (let j = i + 1; j < sortedByTotalProfit.length; j++) {
      const gap = Math.abs(sortedByTotalProfit[i].totalProfit - sortedByTotalProfit[j].totalProfit);
      if (gap <= 30 && gap > 0) {
        milestones.push({
          emoji: '⚔️',
          title: 'קרב צמוד!',
          description: `${sortedByTotalProfit[i].name} ו-${sortedByTotalProfit[j].name} רק ${gap}₪ הפרש! הלילה מכריע.`,
          priority: 88
        });
      }
    }
  }
  
  // 4. EXACT TIES
  for (let i = 0; i < sortedByTotalProfit.length; i++) {
    for (let j = i + 1; j < sortedByTotalProfit.length; j++) {
      if (sortedByTotalProfit[i].totalProfit === sortedByTotalProfit[j].totalProfit && sortedByTotalProfit[i].totalProfit !== 0) {
        milestones.push({
          emoji: '🤝',
          title: 'תיקו מושלם!',
          description: `${sortedByTotalProfit[i].name} ו-${sortedByTotalProfit[j].name} בדיוק ${sortedByTotalProfit[i].totalProfit >= 0 ? '+' : ''}${sortedByTotalProfit[i].totalProfit}₪. הלילה שובר!`,
          priority: 92
        });
      }
    }
  }
  
  // 5. ROUND NUMBER MILESTONES
  const roundNumbers = [500, 1000, 1500, 2000];
  players.forEach(p => {
    for (const milestone of roundNumbers) {
      const distance = milestone - p.totalProfit;
      if (distance > 0 && distance <= 150) {
        milestones.push({
          emoji: '🎯',
          title: `${p.name} - יעד בהישג יד`,
          description: `עומד על ${p.totalProfit >= 0 ? '+' : ''}${p.totalProfit}₪. עוד ${distance}₪ = +${milestone}₪ כולל!`,
          priority: 75 + (milestone / 100)
        });
        break;
      }
    }
  });
  
  // 6. THIS YEAR LEADERBOARD
  for (let i = 1; i < Math.min(sortedByYearProfit.length, 4); i++) {
    const chaser = sortedByYearProfit[i];
    const leader = sortedByYearProfit[i - 1];
    const gap = leader.yearProfit - chaser.yearProfit;
    if (gap > 0 && gap <= 150 && chaser.yearGames >= 2) {
      milestones.push({
        emoji: '📅',
        title: `מרדף ${currentYear}`,
        description: `${chaser.name} יכול לעקוף את ${leader.name} בטבלת השנה עם +${gap}₪!`,
        priority: 70
      });
    }
  }
  
  // 7. GAMES MILESTONES
  const gamesMilestones = [10, 25, 50, 75, 100, 150, 200];
  players.forEach(p => {
    for (const gm of gamesMilestones) {
      if (p.gamesPlayed === gm - 1) {
        milestones.push({
          emoji: '🎮',
          title: `משחק ${gm} ל-${p.name}!`,
          description: `הלילה זה המשחק ה-${gm} שלו עם הקבוצה!`,
          priority: 65 + (gm / 10)
        });
        break;
      }
    }
  });
  
  // 8. WIN RATE MILESTONES
  players.filter(p => p.gamesPlayed >= 10).forEach(p => {
    const winsNeeded60 = Math.ceil(0.6 * (p.gamesPlayed + 1));
    if (p.winCount === winsNeeded60 - 1 && p.winPercentage < 60) {
      milestones.push({
        emoji: '🎯',
        title: `${p.name} - אחוזי נצחון`,
        description: `עומד על ${Math.round(p.winPercentage)}%. נצחון הלילה = חציית 60%!`,
        priority: 60
      });
    }
  });
  
  // 9. RECOVERY TO POSITIVE
  playerPeriodStats.forEach(p => {
    if (p.yearProfit < 0 && p.yearProfit > -120 && p.yearGames >= 3) {
      milestones.push({
        emoji: '🔄',
        title: `${p.name} - חזרה לפלוס`,
        description: `${p.yearProfit}₪ ב-${currentYear}. נצחון של +${Math.abs(p.yearProfit)}₪ = חזרה לפלוס השנה!`,
        priority: 72
      });
    }
  });
  
  // 10. PLAYER OF THE MONTH
  const sortedByMonthProfit = [...playerPeriodStats].sort((a, b) => b.monthProfit - a.monthProfit);
  if (sortedByMonthProfit[0]?.monthGames >= 1 && sortedByMonthProfit[1]?.monthGames >= 1) {
    const leader = sortedByMonthProfit[0];
    const chaser = sortedByMonthProfit[1];
    const gap = leader.monthProfit - chaser.monthProfit;
    if (gap <= 100) {
      milestones.push({
        emoji: '🏆',
        title: `מרדף על שחקן ${monthNames[currentMonth]}`,
        description: `${leader.name} מוביל עם ${leader.monthProfit >= 0 ? '+' : ''}${leader.monthProfit}₪. ${chaser.name} רק ${gap}₪ אחריו!`,
        priority: 68
      });
    }
  }
  
  // 11. BIGGEST WIN RECORD
  const biggestWin = Math.max(...players.map(p => p.bestWin));
  const recordHolder = players.find(p => p.bestWin === biggestWin);
  players.forEach(p => {
    if (p.currentStreak >= 2 && p.bestWin < biggestWin && biggestWin - p.bestWin <= 100) {
      milestones.push({
        emoji: '💰',
        title: 'שיא נצחון בלילה',
        description: `שיא הקבוצה: +${biggestWin}₪ (${recordHolder?.name}). ${p.name} יכול לשבור!`,
        priority: 78
      });
    }
  });
  
  // 12. COMEBACK OPPORTUNITIES
  players.forEach(p => {
    if (p.currentStreak <= -2 && p.totalProfit > 100) {
      milestones.push({
        emoji: '💪',
        title: `${p.name} - קאמבק`,
        description: `${Math.abs(p.currentStreak)} הפסדים רצופים, אבל עדיין +${p.totalProfit}₪ כולל. זמן לנקמה!`,
        priority: 55
      });
    }
  });
  
  // 13. HOT/COLD YEAR
  playerPeriodStats.forEach(p => {
    if (p.yearGames >= 5 && p.gamesPlayed >= 10) {
      const yearAvg = p.yearProfit / p.yearGames;
      if (yearAvg > p.avgProfit + 40) {
        milestones.push({
          emoji: '📈',
          title: `${p.name} - השנה הכי טובה?`,
          description: `ממוצע ${currentYear}: +${Math.round(yearAvg)}₪/משחק לעומת +${Math.round(p.avgProfit)}₪ היסטורי!`,
          priority: 62
        });
      }
    }
  });
  
  // Sort by priority and return top 7-10
  milestones.sort((a, b) => b.priority - a.priority);
  return milestones.slice(0, 10);
};

/**
 * Generate AI-powered forecasts for selected players only
 */
export const generateAIForecasts = async (
  players: PlayerForecastData[]
): Promise<ForecastResult[]> => {
  const apiKey = getGeminiApiKey();
  
  if (!apiKey) {
    throw new Error('NO_API_KEY');
  }

  // Analyze player dynamics - how players perform when playing together
  const playerDynamics: string[] = [];
  
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const p1 = players[i];
      const p2 = players[j];
      
      // Find games where both players participated
      const p1GameIds = new Set(p1.gameHistory.map(g => g.gameId));
      const sharedGames = p2.gameHistory.filter(g => p1GameIds.has(g.gameId));
      
      if (sharedGames.length >= 3) {
        // Calculate each player's performance in shared games
        const p1SharedGames = p1.gameHistory.filter(g => 
          sharedGames.some(sg => sg.gameId === g.gameId)
        );
        
        const p1Avg = p1SharedGames.reduce((sum, g) => sum + g.profit, 0) / p1SharedGames.length;
        const p2Avg = sharedGames.reduce((sum, g) => sum + g.profit, 0) / sharedGames.length;
        
        const p1Wins = p1SharedGames.filter(g => g.profit > 0).length;
        const p2Wins = sharedGames.filter(g => g.profit > 0).length;
        
        // Only add interesting dynamics
        if (Math.abs(p1Avg - p2Avg) > 20 || Math.abs(p1Wins - p2Wins) >= 2) {
          const winner = p1Avg > p2Avg ? p1.name : p2.name;
          const loser = p1Avg > p2Avg ? p2.name : p1.name;
          const winnerAvg = Math.round(Math.max(p1Avg, p2Avg));
          const loserAvg = Math.round(Math.min(p1Avg, p2Avg));
          
          playerDynamics.push(
            `${winner} vs ${loser}: In ${sharedGames.length} shared games, ` +
            `${winner} averages ${winnerAvg >= 0 ? '+' : ''}${winnerAvg}₪, ` +
            `${loser} averages ${loserAvg >= 0 ? '+' : ''}${loserAvg}₪`
          );
        }
      }
    }
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
  
  const allTimeRecordsText = allTimeRecords.join('\n');
  
  // ========== CALCULATE MILESTONES ==========
  const milestones: string[] = [];
  
  // Helper: Parse date from game history (format: DD/MM/YYYY or DD/MM/YY)
  const parseGameDate = (dateStr: string): Date => {
    const parts = dateStr.split('/');
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
  const monthNames = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  
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
      name: p.name,
      // This year
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
      // Original data
      ...p
    };
  });
  
  // ===== 1. ALL-TIME LEADERBOARD PASSING =====
  for (let i = 1; i < sortedByTotalProfit.length; i++) {
    const chaser = sortedByTotalProfit[i];
    const leader = sortedByTotalProfit[i - 1];
    const gap = leader.totalProfit - chaser.totalProfit;
    if (gap > 0 && gap <= 250) {
      milestones.push(`📈 ALL-TIME LEADERBOARD: ${chaser.name} (#${i + 1}, ${chaser.totalProfit >= 0 ? '+' : ''}${chaser.totalProfit}₪ כולל) can PASS ${leader.name} (#${i}, ${leader.totalProfit >= 0 ? '+' : ''}${leader.totalProfit}₪) with a +${gap}₪ win tonight!`);
    }
  }
  
  // ===== 2. THIS YEAR LEADERBOARD =====
  const sortedByYearProfit = [...playerPeriodStats].sort((a, b) => b.yearProfit - a.yearProfit);
  for (let i = 1; i < sortedByYearProfit.length && i <= 3; i++) {
    const chaser = sortedByYearProfit[i];
    const leader = sortedByYearProfit[i - 1];
    const gap = leader.yearProfit - chaser.yearProfit;
    if (gap > 0 && gap <= 200 && chaser.yearGames >= 2) {
      milestones.push(`📅 THIS YEAR (${currentYear}): ${chaser.name} is #${i + 1} this year with ${chaser.yearProfit >= 0 ? '+' : ''}${chaser.yearProfit}₪. A +${gap}₪ win tonight would move them past ${leader.name} to #${i}!`);
    }
  }
  
  // ===== 3. THIS HALF LEADERBOARD =====
  const halfName = currentHalf === 1 ? 'H1' : 'H2';
  const sortedByHalfProfit = [...playerPeriodStats].sort((a, b) => b.halfProfit - a.halfProfit);
  for (let i = 1; i < sortedByHalfProfit.length && i <= 3; i++) {
    const chaser = sortedByHalfProfit[i];
    const leader = sortedByHalfProfit[i - 1];
    const gap = leader.halfProfit - chaser.halfProfit;
    if (gap > 0 && gap <= 150 && chaser.halfGames >= 2) {
      milestones.push(`📊 THIS HALF (${halfName} ${currentYear}): ${chaser.name} is at ${chaser.halfProfit >= 0 ? '+' : ''}${chaser.halfProfit}₪ this half. +${gap}₪ tonight = passing ${leader.name} for #${i}!`);
    }
  }
  
  // ===== 4. MONTHLY MILESTONES =====
  const sortedByMonthProfit = [...playerPeriodStats].sort((a, b) => b.monthProfit - a.monthProfit);
  if (sortedByMonthProfit[0]?.monthGames >= 1) {
    const monthLeader = sortedByMonthProfit[0];
    // Check if someone can become "Player of the Month"
    for (let i = 1; i < sortedByMonthProfit.length && i <= 2; i++) {
      const chaser = sortedByMonthProfit[i];
      const gap = monthLeader.monthProfit - chaser.monthProfit;
      if (gap > 0 && gap <= 150 && chaser.monthGames >= 1) {
        milestones.push(`🗓️ ${monthNames[currentMonth].toUpperCase()}: ${chaser.name} is ${gap}₪ behind ${monthLeader.name} for "Player of the Month"! A big win tonight could claim the title.`);
      }
    }
  }
  
  // ===== 5. ALL-TIME ROUND NUMBERS =====
  const roundNumbers = [500, 1000, 1500, 2000, 2500, 3000];
  players.forEach(p => {
    for (const milestone of roundNumbers) {
      const distance = milestone - p.totalProfit;
      if (distance > 0 && distance <= 200) {
        milestones.push(`🎯 ALL-TIME MILESTONE: ${p.name} is at ${p.totalProfit >= 0 ? '+' : ''}${p.totalProfit}₪ כולל. Only ${distance}₪ more to cross +${milestone}₪ all-time!`);
        break;
      }
      const negDistance = p.totalProfit - (-milestone);
      if (p.totalProfit < 0 && negDistance > 0 && negDistance <= 200) {
        milestones.push(`⚠️ DANGER ZONE: ${p.name} is at ${p.totalProfit}₪ כולל. A ${negDistance}₪ loss = dropping to -${milestone}₪ all-time!`);
        break;
      }
    }
  });
  
  // ===== 6. YEARLY ROUND NUMBERS =====
  playerPeriodStats.forEach(p => {
    if (p.yearGames >= 3) {
      for (const milestone of [500, 1000]) {
        const distance = milestone - p.yearProfit;
        if (distance > 0 && distance <= 150) {
          milestones.push(`📅 ${currentYear} MILESTONE: ${p.name} is at ${p.yearProfit >= 0 ? '+' : ''}${p.yearProfit}₪ this year. ${distance}₪ more = +${milestone}₪ for the year!`);
          break;
        }
      }
    }
  });
  
  // ===== 7. STREAK RECORDS =====
  const groupWinStreakRecord = Math.max(...players.map(p => p.currentStreak), 0);
  const groupLoseStreakRecord = Math.min(...players.map(p => p.currentStreak), 0);
  
  players.forEach(p => {
    if (p.currentStreak >= 3 && p.currentStreak >= groupWinStreakRecord) {
      milestones.push(`🔥 WINNING STREAK RECORD: ${p.name} is on ${p.currentStreak} wins in a row (tied for group record!). Win tonight = NEW ALL-TIME RECORD of ${p.currentStreak + 1}!`);
    }
    if (p.currentStreak <= -3 && p.currentStreak <= groupLoseStreakRecord) {
      milestones.push(`❄️ LOSING STREAK RECORD: ${p.name} is on ${Math.abs(p.currentStreak)} losses in a row (worst in group!). Another loss = new unfortunate record of ${Math.abs(p.currentStreak) + 1}!`);
    }
  });
  
  // ===== 8. SINGLE-NIGHT WIN RECORD =====
  const biggestWinRecord = Math.max(...players.map(p => p.bestWin));
  const recordHolder = players.find(p => p.bestWin === biggestWinRecord);
  players.forEach(p => {
    if (p.currentStreak >= 2 && p.bestWin < biggestWinRecord && biggestWinRecord - p.bestWin <= 150) {
      milestones.push(`💰 WIN RECORD: Group record is +${biggestWinRecord}₪ by ${recordHolder?.name}. ${p.name}'s best is +${p.bestWin}₪. A +${biggestWinRecord + 1}₪ night = NEW RECORD!`);
    }
  });
  
  // ===== 9. COMEBACK OPPORTUNITIES =====
  players.forEach(p => {
    if (p.currentStreak <= -2 && p.totalProfit > 0) {
      milestones.push(`💪 COMEBACK: ${p.name} has ${Math.abs(p.currentStreak)} losses in a row, but still +${p.totalProfit}₪ all-time. Time for revenge!`);
    }
  });
  
  // ===== 10. FORM COMPARISON (Recent vs Historical) =====
  playerPeriodStats.forEach(p => {
    if (p.yearGames >= 5 && p.gamesPlayed >= 10) {
      const yearAvg = p.yearProfit / p.yearGames;
      const allTimeAvg = p.avgProfit;
      if (yearAvg > allTimeAvg + 30) {
        milestones.push(`📈 HOT YEAR: ${p.name}'s ${currentYear} average is +${Math.round(yearAvg)}₪/game vs +${Math.round(allTimeAvg)}₪ all-time. Best year ever?`);
      } else if (yearAvg < allTimeAvg - 30) {
        milestones.push(`📉 TOUGH YEAR: ${p.name}'s ${currentYear} average is ${Math.round(yearAvg)}₪/game vs +${Math.round(allTimeAvg)}₪ all-time. Turnaround tonight?`);
      }
    }
  });
  
  // ===== 11. GAMES MILESTONE (ALL-TIME) =====
  const gamesMilestones = [10, 25, 50, 75, 100, 150, 200];
  players.forEach(p => {
    for (const gm of gamesMilestones) {
      if (p.gamesPlayed === gm - 1) {
        milestones.push(`🎮 GAMES MILESTONE: Tonight is ${p.name}'s ${gm}th game ever with the group!`);
        break;
      }
    }
  });
  
  // ===== 12. YEARLY PARTICIPATION MILESTONES =====
  const yearGamesMilestones = [10, 20, 30, 40, 50];
  playerPeriodStats.forEach(p => {
    for (const gm of yearGamesMilestones) {
      if (p.yearGames === gm - 1) {
        milestones.push(`📅 PARTICIPATION: Tonight is ${p.name}'s ${gm}th game of ${currentYear}!`);
        break;
      }
    }
  });
  
  // ===== 13. WIN RATE MILESTONES =====
  const winRateMilestones = [50, 60, 70];
  players.filter(p => p.gamesPlayed >= 10).forEach(p => {
    const currentWinRate = p.winPercentage;
    for (const targetRate of winRateMilestones) {
      // Calculate: if they win tonight, what would their new win rate be?
      const winsNeeded = Math.ceil((targetRate / 100) * (p.gamesPlayed + 1));
      if (p.winCount === winsNeeded - 1 && currentWinRate < targetRate) {
        milestones.push(`🎯 WIN RATE: ${p.name} is at ${Math.round(currentWinRate)}% win rate. A win tonight = crossing ${targetRate}%!`);
        break;
      }
    }
  });
  
  // ===== 14. CLOSE BATTLES (players very close to each other) =====
  for (let i = 0; i < sortedByTotalProfit.length; i++) {
    for (let j = i + 1; j < sortedByTotalProfit.length; j++) {
      const higher = sortedByTotalProfit[i];
      const lower = sortedByTotalProfit[j];
      const gap = Math.abs(higher.totalProfit - lower.totalProfit);
      if (gap <= 30 && gap > 0) {
        milestones.push(`⚔️ CLOSE BATTLE: ${higher.name} (${higher.totalProfit >= 0 ? '+' : ''}${higher.totalProfit}₪) and ${lower.name} (${lower.totalProfit >= 0 ? '+' : ''}${lower.totalProfit}₪) are only ${gap}₪ apart all-time! Tonight decides who's ahead.`);
      }
    }
  }
  
  // ===== 15. PASSING ANYONE IN THE TABLE (not just adjacent) =====
  sortedByTotalProfit.forEach((p, idx) => {
    // Look at players 2-3 positions ahead
    for (let ahead = 2; ahead <= 3; ahead++) {
      if (idx >= ahead) {
        const target = sortedByTotalProfit[idx - ahead];
        const gap = target.totalProfit - p.totalProfit;
        if (gap > 0 && gap <= 180) {
          milestones.push(`🚀 JUMP: ${p.name} (#${idx + 1}) can jump ${ahead} places and pass ${target.name} (#${idx + 1 - ahead}) with a +${gap}₪ win!`);
          break;
        }
      }
    }
  });
  
  // ===== 16. RECOVERY TO POSITIVE (year/half) =====
  playerPeriodStats.forEach(p => {
    // Recovery to positive this year
    if (p.yearProfit < 0 && p.yearProfit > -150 && p.yearGames >= 3) {
      milestones.push(`🔄 RECOVERY: ${p.name} is at ${p.yearProfit}₪ for ${currentYear}. A +${Math.abs(p.yearProfit)}₪ win = back to positive for the year!`);
    }
    // Recovery to positive this half
    if (p.halfProfit < 0 && p.halfProfit > -120 && p.halfGames >= 2) {
      milestones.push(`🔄 HALF RECOVERY: ${p.name} is at ${p.halfProfit}₪ for ${halfName}. A +${Math.abs(p.halfProfit)}₪ win = positive half!`);
    }
  });
  
  // ===== 17. PERSONAL BEST MONTH POTENTIAL =====
  playerPeriodStats.forEach(p => {
    if (p.monthGames >= 2) {
      // Find their best month ever from history
      const monthlyProfits: { [key: string]: number } = {};
      p.gameHistory.forEach(g => {
        const d = parseGameDate(g.date);
        const key = `${d.getFullYear()}-${d.getMonth()}`;
        monthlyProfits[key] = (monthlyProfits[key] || 0) + g.profit;
      });
      const bestMonth = Math.max(...Object.values(monthlyProfits), 0);
      if (bestMonth > 0 && p.monthProfit > bestMonth - 150 && p.monthProfit < bestMonth) {
        const needed = bestMonth - p.monthProfit + 1;
        milestones.push(`🏆 BEST MONTH: ${p.name} is at ${p.monthProfit >= 0 ? '+' : ''}${p.monthProfit}₪ for ${monthNames[currentMonth]}. +${needed}₪ more = personal best month ever!`);
      }
    }
  });
  
  // ===== 18. EXACT TIES =====
  for (let i = 0; i < sortedByTotalProfit.length; i++) {
    for (let j = i + 1; j < sortedByTotalProfit.length; j++) {
      if (sortedByTotalProfit[i].totalProfit === sortedByTotalProfit[j].totalProfit && sortedByTotalProfit[i].totalProfit !== 0) {
        milestones.push(`🤝 TIED: ${sortedByTotalProfit[i].name} and ${sortedByTotalProfit[j].name} are EXACTLY tied at ${sortedByTotalProfit[i].totalProfit >= 0 ? '+' : ''}${sortedByTotalProfit[i].totalProfit}₪ all-time! Tonight breaks the tie.`);
      }
    }
  }
  
  // ===== 19. CONSECUTIVE GAMES PLAYED (attendance streak) =====
  players.forEach(p => {
    if (p.daysSinceLastGame <= 14 && p.gameHistory.length >= 5) {
      // Check if they played in last 5 games (assuming games are weekly-ish)
      const recentGames = p.gameHistory.slice(0, 5);
      const gamesInLast2Months = recentGames.filter(g => {
        const d = parseGameDate(g.date);
        const daysDiff = (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
        return daysDiff <= 60;
      }).length;
      if (gamesInLast2Months >= 5) {
        milestones.push(`🎯 ATTENDANCE: ${p.name} has played ${gamesInLast2Months} of the last 5 games - most consistent player!`);
      }
    }
  });
  
  // ===== 20. THIS MONTH GAMES COUNT =====
  playerPeriodStats.forEach(p => {
    if (p.monthGames === 2) {
      milestones.push(`📅 ${monthNames[currentMonth].toUpperCase()}: Tonight is ${p.name}'s 3rd game this month!`);
    } else if (p.monthGames === 4) {
      milestones.push(`📅 ${monthNames[currentMonth].toUpperCase()}: Tonight is ${p.name}'s 5th game this month - busiest month!`);
    }
  });
  
  const milestonesText = milestones.length > 0 ? milestones.join('\n') : '';

  // Build the prompt with FULL player data (in English for better AI reasoning)
  const playerDataText = players.map((p, i) => {
    const streakText = p.currentStreak > 0 
      ? `Current Winning Streak: ${p.currentStreak} games` 
      : p.currentStreak < 0 
        ? `Current Losing Streak: ${Math.abs(p.currentStreak)} games` 
        : 'No streak';
    
    // Format all game history (most recent first)
    const gameHistoryText = p.gameHistory.length > 0
      ? p.gameHistory.map(g => `${g.date}: ${g.profit >= 0 ? '+' : ''}${g.profit}₪`).join(' | ')
      : 'New player - no history';
    
    // Calculate days since last game info
    const lastGameInfo = p.daysSinceLastGame < 999 
      ? `Days since last game: ${p.daysSinceLastGame}` 
      : '';

    return `
Player ${i + 1}: ${p.name} ${p.isFemale ? '(FEMALE - must use feminine Hebrew forms!)' : '(Male)'}
📊 Overall Statistics:
- Total Games: ${p.gamesPlayed}
- Total Profit: ${p.totalProfit >= 0 ? '+' : ''}${p.totalProfit}₪
- Average per Game: ${p.avgProfit >= 0 ? '+' : ''}${Math.round(p.avgProfit)}₪
- Wins: ${p.winCount} (${Math.round(p.winPercentage)}%)
- Losses: ${p.lossCount}
- ${streakText}
- Biggest Win: +${p.bestWin}₪
- Biggest Loss: ${p.worstLoss}₪
${lastGameInfo ? `- ${lastGameInfo}` : ''}

📅 Game History (most recent first):
${gameHistoryText}`;
  }).join('\n\n========================================\n');
  
  // Calculate realistic profit ranges from player data
  const allProfits = players.flatMap(p => p.gameHistory.map(g => g.profit));
  const maxProfit = allProfits.length > 0 ? Math.max(...allProfits) : 300;
  const minProfit = allProfits.length > 0 ? Math.min(...allProfits) : -300;
  
  // Calculate actual statistics
  const absProfits = allProfits.map(p => Math.abs(p)).sort((a, b) => b - a);
  const medianAbsProfit = absProfits.length > 0 ? absProfits[Math.floor(absProfits.length / 2)] : 100;
  const avgAbsProfit = absProfits.length > 0 ? Math.round(absProfits.reduce((a, b) => a + b, 0) / absProfits.length) : 100;
  
  // Get recent game examples (last 5 unique games)
  const recentGames = new Map<string, { date: string; results: { name: string; profit: number }[] }>();
  players.forEach(p => {
    p.gameHistory.slice(0, 10).forEach(g => {
      if (!recentGames.has(g.gameId)) {
        recentGames.set(g.gameId, { date: g.date, results: [] });
      }
      recentGames.get(g.gameId)!.results.push({ name: p.name, profit: g.profit });
    });
  });
  
  const recentGameExamples = Array.from(recentGames.values())
    .slice(0, 3)
    .map(g => {
      const sorted = g.results.sort((a, b) => b.profit - a.profit);
      const winner = sorted[0];
      const loser = sorted[sorted.length - 1];
      return `${g.date}: Winner ${winner.name} +${winner.profit}₪, Loser ${loser.name} ${loser.profit}₪`;
    })
    .join('\n');
  
  const prompt = `You are the "Master of Poker Analytics," a legendary sports commentator turned data scientist. Your job is to analyze the game history and all-time records of a private poker group to generate a sharp, humorous, and data-driven prediction for tonight's game.

📊 RAW PLAYER DATA:
${playerDataText}

🏆 ALL-TIME RECORDS:
${allTimeRecordsText}
${playerDynamics.length > 0 ? `
🔥 TABLE DYNAMICS & RIVALRIES:
${playerDynamics.join('\n')}` : ''}
${milestonesText ? `
🎯 TONIGHT'S MILESTONES & RECORDS AT STAKE:
${milestonesText}

⭐ USE THESE MILESTONES IN YOUR SENTENCES! They're GOLD for engagement!

📅 TIME PERIOD LABELS (use these in Hebrew):
   - "כולל" / "בסך הכל" = all-time total
   - "השנה" / "ב-${currentYear}" = this year
   - "בחצי ${currentHalf === 1 ? 'הראשון' : 'השני'}" = this half (H${currentHalf})
   - "ב${monthNames[currentMonth]}" = this month
   - "ב-X משחקים אחרונים" = last X games
   
   ❌ WRONG: "אייל צריך להגיע ל-1500" (unclear!)
   ✅ RIGHT: "אייל עומד על +1420₪ השנה. עוד 80₪ הלילה = +1500₪ לשנת ${currentYear}!"
   ✅ RIGHT: "מור מובילה את החצי השני עם +350₪. הלילה היא נלחמת על התואר!"` : ''}

═══════════════════════════════════════

🎯 THE MISSION:
For each player, calculate an "Expected Profit" (the sum of all expectedProfits must equal exactly 0). Cross-reference their current form with their Legacy to create a unique narrative.

═══════════════════════════════════════

💰 EXPECTED PROFIT CALIBRATION (VERY IMPORTANT!):

📈 ACTUAL STATISTICS FROM THIS GROUP:
- Average absolute profit per player per game: ${avgAbsProfit}₪
- Median absolute profit: ${medianAbsProfit}₪
- Biggest win ever: +${maxProfit}₪
- Biggest loss ever: ${minProfit}₪

📋 RECENT GAME EXAMPLES (this is how games ACTUALLY end):
${recentGameExamples}

⚠️ YOUR expectedProfit VALUES MUST BE REALISTIC:
- Minimum absolute value should be around ${Math.max(50, Math.round(avgAbsProfit * 0.5))}₪
- Typical range: ±${Math.round(avgAbsProfit)}₪ to ±${Math.round(avgAbsProfit * 1.5)}₪
- For volatile players (check their bestWin/worstLoss): can go up to ±${Math.round(avgAbsProfit * 2)}₪

❌ WRONG: expectedProfit values like +30, -40, +25 (too small!)
✅ CORRECT: expectedProfit values like +120, -95, +150, -180 (realistic!)

═══════════════════════════════════════

🛠️ WRITING RULES (CRITICAL):

1. **The Legacy Factor**: Use all-time records to praise or sting.

2. **Data-Backed Insights**: Use specific dates, percentages, and amounts. 
   Instead of "He's doing well," say "Since his 120₪ loss on Nov 14th, he has maintained a 65% win rate."

3. **The "Nemesis" Angle**: If Player A loses when Player B is present, highlight the rivalry.

4. **MILESTONES ARE GOLD**: If a player has a milestone opportunity (passing someone, breaking a record, crossing 1000₪), MENTION IT in their sentence! 
   Example: "אם ליאור יקח הלילה +95₪, הוא יעקוף את סגל ויעלה למקום השני בטבלה!"
   Example: "עוד נצחון אחד ואייל ישבור את שיא הנצחונות הרצופים של הקבוצה!"

5. **Style & Tone**: Witty, slightly cynical, dramatic. Each sentence should be screenshot-worthy for WhatsApp.

6. **Language**: Output (highlight and sentence) MUST be in HEBREW.

═══════════════════════════════════════

🎭 SPECIAL PLAYER HANDLING:

• **תומר (Tomer)**: Be GENTLE and OPTIMISTIC with him! Even if his stats aren't great, find something encouraging. Focus on potential, recent improvements, or highlight when he beat strong players. Never mock him - keep him hopeful!

═══════════════════════════════════════

🚫 ABSOLUTELY NO REPETITION:

Each player MUST have a COMPLETELY DIFFERENT:
- Sentence structure (don't start multiple sentences the same way)
- Narrative angle (streaks, rivalries, milestones, comebacks, consistency, volatility - use DIFFERENT angles)
- Writing style (dramatic for one, analytical for another, philosophical for a third)

If you find yourself writing similar sentences, STOP and rewrite with a fresh angle!

═══════════════════════════════════════

📝 OUTPUT FORMAT (JSON ONLY):
[
  {
    "name": "Player Name",
    "expectedProfit": number (REALISTIC based on their historical range!),
    "highlight": "Short data-driven stat in Hebrew (up to 10 words)",
    "sentence": "Unique analysis in Hebrew (25-40 words) - MUST MATCH expectedProfit tone!",
    "isSurprise": boolean
  }
]

🚨 CRITICAL RULES FOR SENTENCE! 🚨

1. The TONE must match the prediction (positive profit = optimistic, negative = cautious)

2. If you mention a NUMBER in the sentence, it MUST be the EXACT SAME as expectedProfit!
   ❌ WRONG: expectedProfit: 120, sentence: "צפי של +80₪"
   ✅ RIGHT: expectedProfit: 120, sentence: "צפי של +120₪"
   
3. You don't HAVE to mention the profit number in the sentence - you can talk about stats, streaks, or milestones instead. But if you DO mention a profit number, it MUST match expectedProfit exactly!

═══════════════════════════════════════

💡 EXAMPLES OF QUALITY (WITH CORRECT CORRELATION):

⚠️ IMPORTANT: When mentioning milestones, ALWAYS specify the context clearly!
- "כולל" or "בסך הכל" = all-time total
- "בטבלת כל הזמנים" = all-time leaderboard
- "שיא הקבוצה" = group record

📊 CORRECT EXAMPLES (number in sentence = expectedProfit):

✅ expectedProfit: +130 → sentence mentions +130:
   "ליאור על גל! 3 נצחונות רצופים. הלילה הוא הולך לשלוט עם +130₪ צפויים."

✅ expectedProfit: +80 → sentence mentions +80:
   "מור ב-70% נצחונות החודש. צפי אופטימי של +80₪ הלילה."

✅ expectedProfit: -60 → sentence mentions -60:
   "אביב ב-3 הפסדים רצופים. לילה מאתגר עם צפי של -60₪."

✅ expectedProfit: -120 → sentence mentions -120:
   "סגל נגד כולם הלילה. הפורום הקשה צפוי לעלות לו -120₪."

✅ WITHOUT mentioning number (also valid):
   expectedProfit: +100 → "ליאור ברצף חם עם 4 נצחונות. המומנטום לצידו והוא מוכן לעוד לילה מנצח!"

❌ WRONG - NUMBER MISMATCH:
   expectedProfit: +100 but sentence says "+70₪" ← FORBIDDEN!
   expectedProfit: -80 but sentence says "-50₪" ← FORBIDDEN!
   
❌ WRONG - TONE MISMATCH:
   expectedProfit: +100 with "לילה קשה צפוי לו" ← FORBIDDEN!
   expectedProfit: -80 with "הולך לשלוט" ← FORBIDDEN!

📍 MILESTONE EXAMPLES (with clear context):

✅ LEADERBOARD: "ליאור עומד על +920₪ בסך הכל. עוד 85₪ הלילה והוא יעקוף את סגל ויעלה למקום השני!"

✅ ROUND NUMBER: "מור כרגע ב-+935₪ כולל. עוד 65₪ הלילה והיא תשבור את רף האלף שקל!"

✅ STREAK: "אייל ב-4 נצחונות רצופים - שוויון לשיא. נצחון הלילה יכתוב אותו בהיסטוריה!"

═══════════════════════════════════════

⚠️ HARD CONSTRAINTS (MUST FOLLOW):

1. Gender: 'מור' is Female (נקבה). All others are Male (זכר).

2. Math: Sum of all expectedProfit = 0 exactly.

3. isSurprise = true ONLY when prediction goes AGAINST their historical pattern.

4. PROFIT RANGE CHECK: Before submitting, verify that:
   - At least ONE player has |expectedProfit| ≥ ${Math.round(avgAbsProfit * 1.2)}₪
   - NO player has |expectedProfit| < ${Math.max(30, Math.round(avgAbsProfit * 0.4))}₪ (too small!)
   - The spread between highest winner and biggest loser should be ≥ ${Math.round(avgAbsProfit * 2)}₪

5. 🚨 CRITICAL - SENTENCE MUST MATCH expectedProfit! 🚨

   A) TONE MUST MATCH:
   - expectedProfit > 0 → sentence MUST be positive/optimistic
   - expectedProfit < 0 → sentence MUST be negative/cautious
   
   B) NUMBER MUST MATCH (if mentioned):
   - If you write a profit number in the sentence, it MUST equal expectedProfit EXACTLY!
   - expectedProfit: +100 → sentence can only say "+100₪" (not +80, not +120)
   - You CAN write a sentence without mentioning the profit number (talk about stats/streaks instead)
   
   ❌ FORBIDDEN:
   - expectedProfit: +100 but sentence says "+70₪" ← NUMBER MISMATCH!
   - expectedProfit: +100 but sentence says "לילה קשה" ← TONE MISMATCH!
   - expectedProfit: -80 but sentence says "+50₪" ← BOTH WRONG!

═══════════════════════════════════════

Return ONLY a clean JSON array. No markdown, no explanation.`;

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
            temperature: 0.75,  // Balanced: creative but data-focused
            topK: 40,
            topP: 0.9,
            maxOutputTokens: 2048,
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

      let forecasts: ForecastResult[];
      try {
        forecasts = JSON.parse(jsonText.trim());
        console.log('✅ Parsed', forecasts.length, 'forecasts');
      } catch (parseError) {
        console.error('❌ JSON parse error, trying next model');
        continue; // Try next model
      }
      
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
  if (workingConfig) return workingConfig;
  
  const saved = localStorage.getItem('gemini_working_config');
  if (saved) {
    try {
      workingConfig = JSON.parse(saved);
      return workingConfig!;
    } catch {}
  }
  
  return API_CONFIGS[0]; // Default to first
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

  // Build comparison data with gap-based accuracy
  const comparisons = forecasts.map(f => {
    const actual = actualResults.find(a => a.playerName === f.playerName);
    const actualProfit = actual?.profit || 0;
    const gap = Math.abs(actualProfit - f.expectedProfit);
    
    // Accuracy based on gap: ≤30 = accurate, 31-60 = close, >60 = missed
    let accuracyLevel: 'accurate' | 'close' | 'missed';
    if (gap <= 30) accuracyLevel = 'accurate';
    else if (gap <= 60) accuracyLevel = 'close';
    else accuracyLevel = 'missed';
    
    return {
      name: f.playerName,
      forecast: f.expectedProfit,
      actual: actualProfit,
      gap,
      accuracyLevel
    };
  });

  // Count accuracy levels
  const accurate = comparisons.filter(c => c.accuracyLevel === 'accurate').length;
  const close = comparisons.filter(c => c.accuracyLevel === 'close').length;
  const missed = comparisons.filter(c => c.accuracyLevel === 'missed').length;
  const total = comparisons.length;
  
  // Calculate overall score (accurate=2pts, close=1pt, missed=0pts)
  const score = (accurate * 2 + close * 1);
  const maxScore = total * 2;
  const scorePercent = Math.round((score / maxScore) * 100);
  
  // Determine rating
  let rating: string;
  if (scorePercent >= 80) rating = 'מעולה';
  else if (scorePercent >= 60) rating = 'טוב';
  else if (scorePercent >= 40) rating = 'סביר';
  else rating = 'חלש';
  
  // Find best and worst predictions
  const sortedByGap = [...comparisons].sort((a, b) => a.gap - b.gap);
  const bestPrediction = sortedByGap[0];
  const worstPrediction = sortedByGap[sortedByGap.length - 1];

  const prompt = `אתה מסכם תחזית פוקר בעברית. כתוב משפט סיכום קצר ורלוונטי (עד 25 מילים) על הצלחת התחזית.

נתונים:
- ציון כולל: ${score}/${maxScore} (${scorePercent}%) - ${rating}
- מדויק (פער ≤30): ${accurate}/${total}
- קרוב (פער 31-60): ${close}/${total}  
- החטאה (פער >60): ${missed}/${total}
- תחזית מדויקת ביותר: ${bestPrediction.name} (פער ${bestPrediction.gap})
- תחזית רחוקה ביותר: ${worstPrediction.name} (פער ${worstPrediction.gap})

כתוב משפט סיכום שכולל את הדירוג הכולל ("${rating}") ותובנה על התחזית. לא להיות מצחיק. כתוב רק את המשפט.`;

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

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  
  return text.trim() || `${accurate} מדויקים, ${close} קרובים, ${missed} החטאות מתוך ${total} תחזיות`;
};