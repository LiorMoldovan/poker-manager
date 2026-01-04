/**
 * ULTIMATE Poker Chatbot
 * The most comprehensive poker group assistant
 * Features: Head-to-head, trends, location stats, predictions, nemesis detection, and more!
 */

import { getAllPlayers, getAllGames, getGamePlayers, getSettings, getPlayerStats } from '../database/storage';
import { cleanNumber } from './calculations';
import { getGeminiApiKey } from './geminiAI';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  source?: 'local' | 'ai';
}

interface GameData {
  id: string;
  date: string;
  dateObj: Date;
  location: string;
  playerCount: number;
  totalBuyins: number;
  potSize: number;
  results: { rank: number; name: string; profit: number; rebuys: number }[];
  winner: string;
  winnerProfit: number;
  loser: string;
  loserProfit: number;
  participants: string[]; // List of player names
}

interface PlayerData {
  id: string;
  rank: number;
  name: string;
  type: string;
  totalProfit: number;
  gamesPlayed: number;
  avgProfit: number;
  winCount: number;
  lossCount: number;
  winPercentage: number;
  currentStreak: number;
  biggestWin: number;
  biggestLoss: number;
}

// Store last mentioned player for follow-up questions
let lastMentionedPlayer: PlayerData | null = null;
let conversationContext: { topic?: string; player?: string; games?: GameData[] } = {};

// Month names in Hebrew and English
const MONTH_NAMES_HE = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const MONTH_NAMES_EN = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_NAMES_EN_SHORT = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Parse date references from question
 */
const parseDateReference = (question: string): { startDate?: Date; endDate?: Date; description: string } | null => {
  const q = question.toLowerCase();
  const now = new Date();
  
  // "לפני חודש" / "a month ago"
  if (q.includes('לפני חודש') || q.includes('month ago') || q.includes('חודש שעבר')) {
    const targetDate = new Date(now);
    targetDate.setMonth(targetDate.getMonth() - 1);
    const startOfMonth = new Date(targetDate.getFullYear(), targetDate.getMonth(), 1);
    const endOfMonth = new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 0);
    return { startDate: startOfMonth, endDate: endOfMonth, description: MONTH_NAMES_HE[targetDate.getMonth()] };
  }
  
  // "לפני שבוע" / "a week ago"
  if (q.includes('לפני שבוע') || q.includes('week ago') || q.includes('שבוע שעבר')) {
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);
    return { startDate: weekAgo, endDate: now, description: 'השבוע האחרון' };
  }
  
  // "לפני X חודשים" / "X months ago"
  const monthsAgoMatch = q.match(/לפני\s+(\d+)\s+חודש/) || q.match(/(\d+)\s+months?\s+ago/);
  if (monthsAgoMatch) {
    const monthsAgo = parseInt(monthsAgoMatch[1]);
    const targetDate = new Date(now);
    targetDate.setMonth(targetDate.getMonth() - monthsAgo);
    const startOfMonth = new Date(targetDate.getFullYear(), targetDate.getMonth(), 1);
    const endOfMonth = new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 0);
    return { startDate: startOfMonth, endDate: endOfMonth, description: MONTH_NAMES_HE[targetDate.getMonth()] };
  }
  
  // Check for month names (Hebrew)
  for (let i = 0; i < MONTH_NAMES_HE.length; i++) {
    if (q.includes(MONTH_NAMES_HE[i])) {
      // Check for year
      const yearMatch = q.match(/20\d{2}/);
      const year = yearMatch ? parseInt(yearMatch[0]) : now.getFullYear();
      const startOfMonth = new Date(year, i, 1);
      const endOfMonth = new Date(year, i + 1, 0);
      return { startDate: startOfMonth, endDate: endOfMonth, description: `${MONTH_NAMES_HE[i]} ${year}` };
    }
  }
  
  // Check for month names (English)
  for (let i = 0; i < MONTH_NAMES_EN.length; i++) {
    if (q.includes(MONTH_NAMES_EN[i]) || q.includes(MONTH_NAMES_EN_SHORT[i])) {
      const yearMatch = q.match(/20\d{2}/);
      const year = yearMatch ? parseInt(yearMatch[0]) : now.getFullYear();
      const startOfMonth = new Date(year, i, 1);
      const endOfMonth = new Date(year, i + 1, 0);
      return { startDate: startOfMonth, endDate: endOfMonth, description: `${MONTH_NAMES_HE[i]} ${year}` };
    }
  }
  
  // "בשנת 2025" / "in 2025"
  const yearOnlyMatch = q.match(/ב?שנת?\s*(20\d{2})/) || q.match(/in\s+(20\d{2})/);
  if (yearOnlyMatch) {
    const year = parseInt(yearOnlyMatch[1]);
    return { 
      startDate: new Date(year, 0, 1), 
      endDate: new Date(year, 11, 31), 
      description: `שנת ${year}` 
    };
  }
  
  // "היום" / "today"
  if (q.includes('היום') || q.includes('today')) {
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
    return { startDate: startOfDay, endDate: endOfDay, description: 'היום' };
  }
  
  // "החודש" / "this month"
  if (q.includes('החודש') || q.includes('this month')) {
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return { startDate: startOfMonth, endDate: endOfMonth, description: MONTH_NAMES_HE[now.getMonth()] };
  }
  
  // "השנה" / "this year"
  if (q.includes('השנה') || q.includes('this year')) {
    return { 
      startDate: new Date(now.getFullYear(), 0, 1), 
      endDate: now, 
      description: `${now.getFullYear()}` 
    };
  }
  
  return null;
};

/**
 * Get all processed data for answering questions
 */
const getProcessedData = () => {
  const players = getAllPlayers();
  const games = getAllGames();
  const completedGames = games.filter(g => g.status === 'completed')
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const settings = getSettings();

  // Get all player stats (getPlayerStats returns array of all players' stats)
  const allStats = getPlayerStats();
  
  // Map players to their stats
  const playerStats = players.map(p => {
    const stats = allStats.find(s => s.playerId === p.id);
    return { player: p, stats };
  }).filter(ps => ps.stats && ps.stats.gamesPlayed > 0);

  // Sort by total profit for rankings
  const rankedPlayers: PlayerData[] = [...playerStats]
    .sort((a, b) => b.stats!.totalProfit - a.stats!.totalProfit)
    .map((ps, idx) => ({
      id: ps.player.id,
      rank: idx + 1,
      name: ps.player.name,
      type: ps.player.type,
      totalProfit: ps.stats!.totalProfit,
      gamesPlayed: ps.stats!.gamesPlayed,
      avgProfit: ps.stats!.avgProfit,
      winCount: ps.stats!.winCount,
      lossCount: ps.stats!.lossCount,
      winPercentage: ps.stats!.winPercentage,
      currentStreak: ps.stats!.currentStreak,
      biggestWin: ps.stats!.biggestWin,
      biggestLoss: ps.stats!.biggestLoss,
    }));

  // Get ALL games with full details (for date-based queries)
  const allGames: GameData[] = completedGames.map(game => {
    const gamePlayers = getGamePlayers(game.id).sort((a, b) => b.profit - a.profit);
    const totalBuyins = gamePlayers.reduce((sum, p) => sum + p.rebuys, 0);
    
    return {
      id: game.id,
      date: new Date(game.date).toLocaleDateString('he-IL'),
      dateObj: new Date(game.date),
      location: game.location || 'לא צוין',
      playerCount: gamePlayers.length,
      totalBuyins,
      potSize: totalBuyins * settings.rebuyValue,
      results: gamePlayers.map((p, idx) => ({
        rank: idx + 1,
        name: p.playerName,
        profit: p.profit,
        rebuys: p.rebuys,
      })),
      winner: gamePlayers[0]?.playerName || '',
      winnerProfit: gamePlayers[0]?.profit || 0,
      loser: gamePlayers[gamePlayers.length - 1]?.playerName || '',
      loserProfit: gamePlayers[gamePlayers.length - 1]?.profit || 0,
      participants: gamePlayers.map(p => p.playerName),
    };
  });

  return {
    players: rankedPlayers,
    games: allGames,
    totalGames: completedGames.length,
    settings,
  };
};

/**
 * Filter games by date range
 */
const filterGamesByDate = (games: GameData[], startDate?: Date, endDate?: Date): GameData[] => {
  if (!startDate && !endDate) return games;
  
  return games.filter(game => {
    const gameDate = game.dateObj;
    if (startDate && gameDate < startDate) return false;
    if (endDate && gameDate > endDate) return false;
    return true;
  });
};

/**
 * Calculate head-to-head stats between two players
 */
const getHeadToHead = (player1: string, player2: string, games: GameData[]): {
  gamesPlayedTogether: number;
  player1Wins: number;
  player2Wins: number;
  player1BetterFinish: number;
  player2BetterFinish: number;
} => {
  const gamesTogether = games.filter(g => 
    g.participants.includes(player1) && g.participants.includes(player2)
  );
  
  let player1Wins = 0;
  let player2Wins = 0;
  let player1BetterFinish = 0;
  let player2BetterFinish = 0;
  
  gamesTogether.forEach(game => {
    if (game.winner === player1) player1Wins++;
    if (game.winner === player2) player2Wins++;
    
    const p1Result = game.results.find(r => r.name === player1);
    const p2Result = game.results.find(r => r.name === player2);
    if (p1Result && p2Result) {
      if (p1Result.rank < p2Result.rank) player1BetterFinish++;
      else if (p2Result.rank < p1Result.rank) player2BetterFinish++;
    }
  });
  
  return {
    gamesPlayedTogether: gamesTogether.length,
    player1Wins,
    player2Wins,
    player1BetterFinish,
    player2BetterFinish,
  };
};

/**
 * Find a player's nemesis (who beats them most often)
 */
const getNemesis = (playerName: string, players: PlayerData[], games: GameData[]): { nemesis: string; stats: string } | null => {
  const opponents: { [name: string]: { betterFinish: number; total: number } } = {};
  
  games.forEach(game => {
    if (!game.participants.includes(playerName)) return;
    
    const playerResult = game.results.find(r => r.name === playerName);
    if (!playerResult) return;
    
    game.results.forEach(result => {
      if (result.name === playerName) return;
      if (!opponents[result.name]) opponents[result.name] = { betterFinish: 0, total: 0 };
      opponents[result.name].total++;
      if (result.rank < playerResult.rank) {
        opponents[result.name].betterFinish++;
      }
    });
  });
  
  // Find who beats player most often (with minimum 3 games)
  let nemesis = '';
  let maxRatio = 0;
  let minGames = 3;
  
  Object.entries(opponents).forEach(([name, stats]) => {
    if (stats.total >= minGames) {
      const ratio = stats.betterFinish / stats.total;
      if (ratio > maxRatio) {
        maxRatio = ratio;
        nemesis = name;
      }
    }
  });
  
  if (nemesis && maxRatio > 0.5) {
    const stats = opponents[nemesis];
    return { 
      nemesis, 
      stats: `${stats.betterFinish}/${stats.total} משחקים (${(maxRatio * 100).toFixed(0)}%)` 
    };
  }
  
  return null;
};

/**
 * Get player's "victim" (who they beat most often)
 */
const getVictim = (playerName: string, games: GameData[]): { victim: string; stats: string } | null => {
  const opponents: { [name: string]: { betterFinish: number; total: number } } = {};
  
  games.forEach(game => {
    if (!game.participants.includes(playerName)) return;
    
    const playerResult = game.results.find(r => r.name === playerName);
    if (!playerResult) return;
    
    game.results.forEach(result => {
      if (result.name === playerName) return;
      if (!opponents[result.name]) opponents[result.name] = { betterFinish: 0, total: 0 };
      opponents[result.name].total++;
      if (playerResult.rank < result.rank) {
        opponents[result.name].betterFinish++;
      }
    });
  });
  
  // Find who player beats most often
  let victim = '';
  let maxRatio = 0;
  let minGames = 3;
  
  Object.entries(opponents).forEach(([name, stats]) => {
    if (stats.total >= minGames) {
      const ratio = stats.betterFinish / stats.total;
      if (ratio > maxRatio) {
        maxRatio = ratio;
        victim = name;
      }
    }
  });
  
  if (victim && maxRatio > 0.5) {
    const stats = opponents[victim];
    return { 
      victim, 
      stats: `${stats.betterFinish}/${stats.total} משחקים (${(maxRatio * 100).toFixed(0)}%)` 
    };
  }
  
  return null;
};

/**
 * Analyze player trend (improving, declining, stable)
 */
const getPlayerTrend = (playerName: string, games: GameData[]): { trend: 'improving' | 'declining' | 'stable'; description: string } => {
  const playerGames = games.filter(g => g.participants.includes(playerName)).slice(0, 10); // Last 10 games
  
  if (playerGames.length < 4) {
    return { trend: 'stable', description: 'אין מספיק משחקים לזהות מגמה' };
  }
  
  const firstHalf = playerGames.slice(Math.floor(playerGames.length / 2));
  const secondHalf = playerGames.slice(0, Math.floor(playerGames.length / 2));
  
  const avgFirstHalf = firstHalf.reduce((sum, g) => {
    const result = g.results.find(r => r.name === playerName);
    return sum + (result?.profit || 0);
  }, 0) / firstHalf.length;
  
  const avgSecondHalf = secondHalf.reduce((sum, g) => {
    const result = g.results.find(r => r.name === playerName);
    return sum + (result?.profit || 0);
  }, 0) / secondHalf.length;
  
  const diff = avgSecondHalf - avgFirstHalf;
  
  if (diff > 50) {
    return { trend: 'improving', description: `📈 ${playerName} בעלייה! ממוצע ${avgSecondHalf > 0 ? '+' : ''}₪${cleanNumber(avgSecondHalf)} ב-${secondHalf.length} משחקים אחרונים` };
  } else if (diff < -50) {
    return { trend: 'declining', description: `📉 ${playerName} בירידה. ממוצע ₪${cleanNumber(avgSecondHalf)} ב-${secondHalf.length} משחקים אחרונים` };
  }
  
  return { trend: 'stable', description: `➡️ ${playerName} יציב יחסית` };
};

/**
 * Get location-based stats
 */
const getLocationStats = (games: GameData[]): { [location: string]: { games: number; winners: { [name: string]: number } } } => {
  const stats: { [location: string]: { games: number; winners: { [name: string]: number } } } = {};
  
  games.forEach(game => {
    const loc = game.location;
    if (loc === 'לא צוין') return;
    
    if (!stats[loc]) stats[loc] = { games: 0, winners: {} };
    stats[loc].games++;
    
    if (!stats[loc].winners[game.winner]) stats[loc].winners[game.winner] = 0;
    stats[loc].winners[game.winner]++;
  });
  
  return stats;
};

/**
 * Get player's performance at a specific location
 */
const getPlayerLocationStats = (playerName: string, games: GameData[]): { best: string; worst: string } => {
  const locationProfit: { [loc: string]: { total: number; count: number } } = {};
  
  games.forEach(game => {
    if (game.location === 'לא צוין') return;
    if (!game.participants.includes(playerName)) return;
    
    const result = game.results.find(r => r.name === playerName);
    if (!result) return;
    
    if (!locationProfit[game.location]) locationProfit[game.location] = { total: 0, count: 0 };
    locationProfit[game.location].total += result.profit;
    locationProfit[game.location].count++;
  });
  
  const locations = Object.entries(locationProfit)
    .filter(([, stats]) => stats.count >= 2)
    .map(([loc, stats]) => ({ loc, avg: stats.total / stats.count }));
  
  if (locations.length === 0) {
    return { best: '', worst: '' };
  }
  
  locations.sort((a, b) => b.avg - a.avg);
  
  return {
    best: locations[0]?.loc || '',
    worst: locations[locations.length - 1]?.loc || '',
  };
};

/**
 * Calculate player volatility (standard deviation)
 */
const getPlayerVolatility = (playerName: string, games: GameData[]): number => {
  const playerGames = games.filter(g => g.participants.includes(playerName));
  const profits = playerGames.map(g => {
    const result = g.results.find(r => r.name === playerName);
    return result?.profit || 0;
  });
  
  if (profits.length < 2) return 0;
  
  const avg = profits.reduce((a, b) => a + b, 0) / profits.length;
  const squaredDiffs = profits.map(p => Math.pow(p - avg, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / profits.length;
  
  return Math.sqrt(variance);
};

/**
 * Get most common player combinations
 */
const getCommonLineups = (games: GameData[]): { players: string[]; count: number }[] => {
  const pairCounts: { [key: string]: number } = {};
  
  games.forEach(game => {
    // Count pairs
    for (let i = 0; i < game.participants.length; i++) {
      for (let j = i + 1; j < game.participants.length; j++) {
        const pair = [game.participants[i], game.participants[j]].sort().join('|');
        pairCounts[pair] = (pairCounts[pair] || 0) + 1;
      }
    }
  });
  
  return Object.entries(pairCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([pair, count]) => ({ players: pair.split('|'), count }));
};

/**
 * Get player attendance stats
 */
const getAttendanceStats = (players: PlayerData[], totalGames: number): { most: PlayerData; least: PlayerData } => {
  const sorted = [...players].sort((a, b) => b.gamesPlayed - a.gamesPlayed);
  return {
    most: sorted[0],
    least: sorted[sorted.length - 1],
  };
};

/**
 * Generate fun prediction based on stats
 */
const generatePrediction = (players: PlayerData[], games: GameData[]): string => {
  const predictions: string[] = [];
  
  // Hot players
  const hotPlayers = players.filter(p => p.currentStreak >= 2);
  if (hotPlayers.length > 0) {
    const hot = hotPlayers[0];
    predictions.push(`🔥 ${hot.name} ברצף ${hot.currentStreak} נצחונות - סיכוי גבוה להמשך!`);
  }
  
  // Player with best recent average
  const recentGames = games.slice(0, 5);
  const recentPerformance: { [name: string]: number } = {};
  recentGames.forEach(game => {
    game.results.forEach(r => {
      if (!recentPerformance[r.name]) recentPerformance[r.name] = 0;
      recentPerformance[r.name] += r.profit;
    });
  });
  
  const bestRecent = Object.entries(recentPerformance).sort((a, b) => b[1] - a[1])[0];
  if (bestRecent && bestRecent[1] > 0) {
    predictions.push(`📊 ${bestRecent[0]} הכי רווחי ב-5 משחקים אחרונים (+₪${cleanNumber(bestRecent[1])})`);
  }
  
  // Cold player might be due for comeback
  const coldPlayers = players.filter(p => p.currentStreak <= -3 && p.winPercentage > 20);
  if (coldPlayers.length > 0) {
    const cold = coldPlayers[0];
    predictions.push(`🎲 ${cold.name} ברצף הפסדים - אולי הגיע הזמן לקאמבק?`);
  }
  
  // Consistent player
  const consistent = players.find(p => p.gamesPlayed >= 10 && p.winPercentage >= 35);
  if (consistent) {
    predictions.push(`🎯 ${consistent.name} יציב עם ${consistent.winPercentage.toFixed(0)}% נצחונות`);
  }
  
  return predictions.length > 0 ? predictions.join('\n') : '🎰 הכל פתוח הערב - יהיה מעניין!';
};

/**
 * Smart local answer - understands many question types
 */
const getLocalAnswer = (question: string): string => {
  const q = question.toLowerCase();
  const data = getProcessedData();
  const { players, games, totalGames, settings } = data;

  if (players.length === 0) {
    return 'אין עדיין נתונים במערכת. שחקו כמה משחקים ואז אוכל לענות על שאלות! 🎰';
  }

  const lastGame = games[0];
  const leader = players[0];
  const lastPlace = players[players.length - 1];

  // Helper to find player by name
  const findPlayer = (text: string) => players.find(p => text.includes(p.name.toLowerCase()));
  const mentionedPlayer = findPlayer(q);
  
  // Update last mentioned player for follow-ups
  if (mentionedPlayer) {
    lastMentionedPlayer = mentionedPlayer;
    conversationContext.player = mentionedPlayer.name;
  }

  // ===== FOLLOW-UP QUESTIONS =====
  if ((q.includes('ומה איתו') || q.includes('ועליו') || q.includes('ומה לגביו') || q.includes('מה עוד') ||
       q.includes('and him') || q.includes('about him') || q.includes('what else')) && lastMentionedPlayer) {
    const p = lastMentionedPlayer;
    const trend = getPlayerTrend(p.name, games);
    const nemesis = getNemesis(p.name, players, games);
    const victim = getVictim(p.name, games);
    const locationStats = getPlayerLocationStats(p.name, games);
    
    let response = `עוד על ${p.name}:\n\n`;
    response += `${trend.description}\n`;
    if (nemesis) response += `😈 הנמסיס שלו: ${nemesis.nemesis} (${nemesis.stats})\n`;
    if (victim) response += `🎯 הקורבן שלו: ${victim.victim} (${victim.stats})\n`;
    if (locationStats.best) response += `🏠 הכי טוב אצל: ${locationStats.best}\n`;
    
    return response;
  }

  // ===== HEAD-TO-HEAD QUESTIONS =====
  if (q.includes(' vs ') || q.includes(' נגד ') || q.includes(' מול ') || q.includes('בין ') || 
      q.includes('הסיפור') || q.includes('ביניהם')) {
    const names = players.map(p => p.name.toLowerCase());
    const found = names.filter(n => q.includes(n));
    if (found.length >= 2) {
      const p1Name = players.find(p => p.name.toLowerCase() === found[0])!.name;
      const p2Name = players.find(p => p.name.toLowerCase() === found[1])!.name;
      const h2h = getHeadToHead(p1Name, p2Name, games);
      
      if (h2h.gamesPlayedTogether === 0) {
        return `${p1Name} ו${p2Name} עוד לא שיחקו יחד!`;
      }
      
      return `⚔️ ${p1Name} vs ${p2Name}\n\n` +
             `🎮 ${h2h.gamesPlayedTogether} משחקים משותפים\n` +
             `🏆 נצחונות: ${p1Name} ${h2h.player1Wins} | ${p2Name} ${h2h.player2Wins}\n` +
             `📊 סיים גבוה יותר: ${p1Name} ${h2h.player1BetterFinish} | ${p2Name} ${h2h.player2BetterFinish}\n` +
             `\n${h2h.player1BetterFinish > h2h.player2BetterFinish ? `${p1Name} מוביל!` : 
                  h2h.player2BetterFinish > h2h.player1BetterFinish ? `${p2Name} מוביל!` : 'שווים!'}`;
    }
  }

  // ===== NEMESIS QUESTIONS =====
  if (q.includes('נמסיס') || q.includes('nemesis') || q.includes('מי מנצח אותי') || 
      q.includes('מי מכה') || q.includes('הכי קשה')) {
    if (mentionedPlayer) {
      const nemesis = getNemesis(mentionedPlayer.name, players, games);
      if (nemesis) {
        return `😈 הנמסיס של ${mentionedPlayer.name}: ${nemesis.nemesis}\nמנצח אותו ב-${nemesis.stats}`;
      }
      return `ל${mentionedPlayer.name} אין נמסיס ברור - הוא מחזיק מעמד מול כולם! 💪`;
    }
    
    // Find most dominant rivalries
    let biggestNemesis = { player: '', nemesis: '', ratio: 0 };
    players.forEach(p => {
      const nem = getNemesis(p.name, players, games);
      if (nem && parseFloat(nem.stats) > biggestNemesis.ratio) {
        biggestNemesis = { player: p.name, nemesis: nem.nemesis, ratio: parseFloat(nem.stats) };
      }
    });
    
    if (biggestNemesis.nemesis) {
      return `😈 היריבות הגדולה: ${biggestNemesis.nemesis} שולט על ${biggestNemesis.player}!`;
    }
  }

  // ===== VICTIM / WHO DO I BEAT =====
  if (q.includes('קורבן') || q.includes('victim') || q.includes('מי אני מנצח') || q.includes('שולט על')) {
    if (mentionedPlayer) {
      const victim = getVictim(mentionedPlayer.name, games);
      if (victim) {
        return `🎯 הקורבן של ${mentionedPlayer.name}: ${victim.victim}\nמנצח אותו ב-${victim.stats}`;
      }
      return `ל${mentionedPlayer.name} אין קורבן ברור 🤷`;
    }
  }

  // ===== TREND QUESTIONS =====
  if (q.includes('מגמה') || q.includes('trend') || q.includes('משתפר') || q.includes('יורד') || 
      q.includes('improving') || q.includes('declining') || q.includes('עולה') || q.includes('מתדרדר')) {
    if (mentionedPlayer) {
      const trend = getPlayerTrend(mentionedPlayer.name, games);
      return trend.description;
    }
    
    // Find players with clearest trends
    const trends = players.map(p => ({
      player: p,
      trend: getPlayerTrend(p.name, games),
    }));
    
    const improving = trends.filter(t => t.trend.trend === 'improving');
    const declining = trends.filter(t => t.trend.trend === 'declining');
    
    let response = '📈 מגמות:\n\n';
    if (improving.length > 0) {
      response += `עולים: ${improving.map(t => t.player.name).join(', ')}\n`;
    }
    if (declining.length > 0) {
      response += `יורדים: ${declining.map(t => t.player.name).join(', ')}\n`;
    }
    if (improving.length === 0 && declining.length === 0) {
      response += 'כולם יציבים יחסית!';
    }
    
    return response;
  }

  // ===== LOCATION QUESTIONS =====
  if ((q.includes('מיקום') || q.includes('location') || q.includes('איפה') || q.includes('אצל')) &&
      (q.includes('הכי טוב') || q.includes('best') || q.includes('מנצח') || q.includes('הצלחה'))) {
    if (mentionedPlayer) {
      const locStats = getPlayerLocationStats(mentionedPlayer.name, games);
      if (locStats.best) {
        return `${mentionedPlayer.name} הכי מצליח אצל ${locStats.best} 🏠${locStats.worst && locStats.worst !== locStats.best ? `\nהכי פחות מצליח אצל ${locStats.worst}` : ''}`;
      }
      return `אין מספיק נתונים על ביצועי ${mentionedPlayer.name} לפי מיקום`;
    }
    
    const locStats = getLocationStats(games);
    const locations = Object.entries(locStats)
      .sort((a, b) => b[1].games - a[1].games)
      .slice(0, 3);
    
    if (locations.length === 0) {
      return 'אין מספיק נתונים על מיקומים.';
    }
    
    let response = '📍 סטטיסטיקות לפי מיקום:\n\n';
    locations.forEach(([loc, stats]) => {
      const topWinner = Object.entries(stats.winners).sort((a, b) => b[1] - a[1])[0];
      response += `${loc}: ${stats.games} משחקים${topWinner ? ` | מלך: ${topWinner[0]} (${topWinner[1]} נצחונות)` : ''}\n`;
    });
    
    return response;
  }

  // ===== VOLATILITY / CONSISTENT QUESTIONS =====
  if (q.includes('תנודתי') || q.includes('volatile') || q.includes('יציב') || q.includes('consistent') ||
      q.includes('stable') || q.includes('אמין') || q.includes('reliable')) {
    const volatilities = players
      .filter(p => p.gamesPlayed >= 5)
      .map(p => ({ name: p.name, volatility: getPlayerVolatility(p.name, games) }))
      .sort((a, b) => b.volatility - a.volatility);
    
    if (volatilities.length === 0) {
      return 'אין מספיק משחקים לחישוב יציבות.';
    }
    
    const mostVolatile = volatilities[0];
    const mostStable = volatilities[volatilities.length - 1];
    
    return `📊 יציבות שחקנים:\n\n` +
           `🎢 הכי תנודתי: ${mostVolatile.name}\n` +
           `🎯 הכי יציב: ${mostStable.name}`;
  }

  // ===== COMMON LINEUPS =====
  if (q.includes('הרכב') || q.includes('lineup') || q.includes('שחקנים ביחד') || q.includes('צמד') ||
      q.includes('משחקים ביחד') || q.includes('pair')) {
    const lineups = getCommonLineups(games);
    
    if (lineups.length === 0) {
      return 'אין מספיק נתונים על הרכבים.';
    }
    
    return `👥 צמדים שמשחקים הכי הרבה ביחד:\n\n` +
           lineups.map((l, i) => `${i + 1}. ${l.players.join(' & ')} - ${l.count} משחקים`).join('\n');
  }

  // ===== ATTENDANCE =====
  if (q.includes('נוכחות') || q.includes('attendance') || q.includes('מי משחק הכי הרבה') ||
      q.includes('מי חסר') || q.includes('missing')) {
    const attendance = getAttendanceStats(players, totalGames);
    
    return `👥 נוכחות:\n\n` +
           `🎰 הכי נוכח: ${attendance.most.name} (${attendance.most.gamesPlayed} משחקים)\n` +
           `👻 הכי פחות נוכח: ${attendance.least.name} (${attendance.least.gamesPlayed} משחקים)`;
  }

  // ===== PREDICTIONS =====
  if (q.includes('תחזית') || q.includes('prediction') || q.includes('הערב') || q.includes('tonight') ||
      q.includes('ינצח') || q.includes('will win') || q.includes('סיכוי') || q.includes('chances') ||
      q.includes('להמר') || q.includes('bet') || q.includes('טיפ') || q.includes('tip')) {
    return `🔮 תחזית:\n\n${generatePrediction(players, games)}`;
  }

  // ===== DATE-BASED QUESTIONS =====
  const dateRef = parseDateReference(question);
  if (dateRef) {
    const filteredGames = filterGamesByDate(games, dateRef.startDate, dateRef.endDate);
    
    if (filteredGames.length === 0) {
      return `לא היו משחקים ב${dateRef.description} 📅`;
    }
    
    // How many games in period
    if (q.includes('כמה משחקים') || q.includes('how many games')) {
      return `ב${dateRef.description} היו ${filteredGames.length} משחקים 🎮`;
    }
    
    // Who won in period (last game of that period)
    if (q.includes('ניצח') || q.includes('מנצח') || q.includes('won') || q.includes('winner')) {
      const lastInPeriod = filteredGames[0]; // Most recent in filtered
      return `🏆 ב${dateRef.description}, ${lastInPeriod.winner} ניצח במשחק האחרון (${lastInPeriod.date}) עם +₪${cleanNumber(lastInPeriod.winnerProfit)}`;
    }
    
    // Who lost in period
    if (q.includes('הפסיד') || q.includes('מפסיד') || q.includes('lost') || q.includes('loser') || q.includes('אחרון')) {
      const lastInPeriod = filteredGames[0];
      return `ב${dateRef.description}, ${lastInPeriod.loser} סיים אחרון במשחק האחרון (${lastInPeriod.date}) עם ₪${cleanNumber(lastInPeriod.loserProfit)}`;
    }
    
    // Results / what happened in period
    if (q.includes('תוצאות') || q.includes('results') || q.includes('מה היה') || q.includes('what happened')) {
      const lastInPeriod = filteredGames[0];
      const top3 = lastInPeriod.results.slice(0, 3).map(r => 
        `${r.rank}. ${r.name}: ${r.profit >= 0 ? '+' : ''}₪${cleanNumber(r.profit)}`
      ).join('\n');
      return `תוצאות ב${dateRef.description} (${lastInPeriod.date}):\n${top3}`;
    }
    
    // Where was game in period
    if (q.includes('איפה') || q.includes('מיקום') || q.includes('where') || q.includes('location')) {
      const lastInPeriod = filteredGames[0];
      if (lastInPeriod.location !== 'לא צוין') {
        return `המשחק ב${dateRef.description} (${lastInPeriod.date}) היה אצל ${lastInPeriod.location} 📍`;
      }
      return `למשחק ב${dateRef.description} (${lastInPeriod.date}) לא נרשם מיקום.`;
    }
    
    // General period summary
    const periodWinners = filteredGames.map(g => g.winner);
    const winnerCounts: { [key: string]: number } = {};
    periodWinners.forEach(w => winnerCounts[w] = (winnerCounts[w] || 0) + 1);
    const topWinner = Object.entries(winnerCounts).sort((a, b) => b[1] - a[1])[0];
    
    return `📅 ב${dateRef.description}:\n` +
           `• ${filteredGames.length} משחקים\n` +
           `• מנצח אחרון: ${filteredGames[0].winner} (+₪${cleanNumber(filteredGames[0].winnerProfit)})\n` +
           (topWinner && topWinner[1] > 1 ? `• הכי הרבה נצחונות: ${topWinner[0]} (${topWinner[1]} פעמים)` : '');
  }

  // ===== LAST GAME QUESTIONS =====
  
  // Where was the last game
  if ((q.includes('איפה') || q.includes('מיקום') || q.includes('היכן') || q.includes('where') || q.includes('location')) &&
      (q.includes('משחק') || q.includes('אחרון') || q.includes('game') || q.includes('last'))) {
    if (!lastGame) return 'אין עדיין משחקים במערכת.';
    if (lastGame.location && lastGame.location !== 'לא צוין') {
      return `המשחק האחרון (${lastGame.date}) היה אצל ${lastGame.location} 📍`;
    }
    return `המשחק האחרון היה ב-${lastGame.date}, אבל לא נרשם מיקום.`;
  }

  // Who finished last in last game
  if ((q.includes('אחרון') || q.includes('last') || q.includes('הפסיד') || q.includes('מפסיד')) &&
      (q.includes('סיים') || q.includes('מקום') || q.includes('finished') || q.includes('place') || q.includes('משחק'))) {
    if (!lastGame) return 'אין עדיין משחקים במערכת.';
    return `במשחק האחרון (${lastGame.date}), ${lastGame.loser} סיים אחרון עם ₪${cleanNumber(lastGame.loserProfit)} 😢`;
  }

  // Who won the last game
  if ((q.includes('ניצח') || q.includes('מנצח') || q.includes('זכה') || q.includes('won') || q.includes('winner') || q.includes('ראשון')) &&
      (q.includes('משחק') || q.includes('אחרון') || q.includes('game') || q.includes('last'))) {
    if (!lastGame) return 'אין עדיין משחקים במערכת.';
    return `🏆 ${lastGame.winner} ניצח במשחק האחרון (${lastGame.date}) עם +₪${cleanNumber(lastGame.winnerProfit)}!`;
  }

  // When was the last game
  if ((q.includes('מתי') || q.includes('when') || q.includes('תאריך') || q.includes('date')) &&
      (q.includes('משחק') || q.includes('אחרון') || q.includes('game') || q.includes('last'))) {
    if (!lastGame) return 'אין עדיין משחקים במערכת.';
    return `המשחק האחרון היה ב-${lastGame.date}${lastGame.location !== 'לא צוין' ? ` אצל ${lastGame.location}` : ''}.`;
  }

  // Last game results / what happened
  if ((q.includes('משחק אחרון') || q.includes('last game')) ||
      ((q.includes('מה היה') || q.includes('what happened') || q.includes('תוצאות') || q.includes('results')) && 
       (q.includes('אחרון') || q.includes('last')))) {
    if (!lastGame) return 'אין עדיין משחקים במערכת.';
    const top3 = lastGame.results.slice(0, 3).map(r => 
      `${r.rank}. ${r.name}: ${r.profit >= 0 ? '+' : ''}₪${cleanNumber(r.profit)}`
    ).join('\n');
    return `משחק אחרון (${lastGame.date})${lastGame.location !== 'לא צוין' ? ` ב-${lastGame.location}` : ''}:\n${top3}\n..ועוד ${lastGame.results.length - 3} שחקנים`;
  }

  // ===== LEADERBOARD QUESTIONS =====

  // Who is the leader / first place
  if (q.includes('מוביל') || q.includes('leader') || q.includes('מקום ראשון') || q.includes('first place') ||
      (q.includes('מי') && (q.includes('ראשון') || q.includes('top') || q.includes('best')))) {
    return `🥇 ${leader.name} מוביל עם ${leader.totalProfit >= 0 ? '+' : ''}₪${cleanNumber(leader.totalProfit)} (${leader.gamesPlayed} משחקים, ${leader.winPercentage.toFixed(0)}% נצחונות)`;
  }

  // Who is last place overall
  if ((q.includes('תחתית') || q.includes('bottom') || q.includes('אחרון בטבלה') || q.includes('last place')) &&
      !q.includes('משחק')) {
    return `${lastPlace.name} בתחתית הטבלה עם ₪${cleanNumber(lastPlace.totalProfit)} (${lastPlace.gamesPlayed} משחקים)`;
  }

  // Leaderboard / table
  if (q.includes('טבלה') || q.includes('leaderboard') || q.includes('דירוג') || q.includes('ranking') || q.includes('table')) {
    const top5 = players.slice(0, 5).map(p => 
      `${p.rank}. ${p.name}: ${p.totalProfit >= 0 ? '+' : ''}₪${cleanNumber(p.totalProfit)}`
    ).join('\n');
    return `🏆 טבלת המובילים:\n${top5}`;
  }

  // ===== PLAYER-SPECIFIC QUESTIONS =====

  if (mentionedPlayer) {
    const p = mentionedPlayer;
    
    // General "tell me about" / player info
    if (q.includes('ספר') || q.includes('tell') || q.includes('מידע') || q.includes('info') || q.includes('סטטיסטיקה')) {
      const streakText = p.currentStreak > 0 ? `🔥 ברצף ${p.currentStreak} נצחונות!` :
                         p.currentStreak < 0 ? `❄️ ברצף ${Math.abs(p.currentStreak)} הפסדים` : '';
      const trend = getPlayerTrend(p.name, games);
      const nemesis = getNemesis(p.name, players, games);
      
      return `${p.name} (מקום ${p.rank}):\n` +
             `💰 רווח כולל: ${p.totalProfit >= 0 ? '+' : ''}₪${cleanNumber(p.totalProfit)}\n` +
             `🎮 ${p.gamesPlayed} משחקים | ${p.winPercentage.toFixed(0)}% נצחונות\n` +
             `📊 ממוצע: ${p.avgProfit >= 0 ? '+' : ''}₪${cleanNumber(p.avgProfit)} למשחק\n` +
             `🎯 שיא: +₪${cleanNumber(p.biggestWin)} | שפל: ₪${cleanNumber(p.biggestLoss)}\n` +
             (streakText ? streakText + '\n' : '') +
             `${trend.trend !== 'stable' ? trend.description : ''}` +
             (nemesis ? `\n😈 נמסיס: ${nemesis.nemesis}` : '');
    }

    // How much did player profit
    if (q.includes('כמה') || q.includes('how much') || q.includes('רווח') || q.includes('profit') || q.includes('הרוויח')) {
      return `${p.name} ${p.totalProfit >= 0 ? 'הרוויח' : 'הפסיד'} ${p.totalProfit >= 0 ? '+' : ''}₪${cleanNumber(p.totalProfit)} בסך הכל (ממוצע ${p.avgProfit >= 0 ? '+' : ''}₪${cleanNumber(p.avgProfit)} למשחק).`;
    }

    // Player wins
    if (q.includes('נצחון') || q.includes('ניצח') || q.includes('win') || q.includes('זכה')) {
      return `${p.name} ניצח ${p.winCount} מתוך ${p.gamesPlayed} משחקים (${p.winPercentage.toFixed(0)}%). השיא שלו: +₪${cleanNumber(p.biggestWin)} 🏆`;
    }

    // Player losses
    if (q.includes('הפסד') || q.includes('הפסיד') || q.includes('loss') || q.includes('lost')) {
      return `${p.name} הפסיד ${p.lossCount} משחקים. ההפסד הגדול ביותר: ₪${cleanNumber(p.biggestLoss)}`;
    }

    // Player streak
    if (q.includes('רצף') || q.includes('streak')) {
      if (p.currentStreak > 0) return `🔥 ${p.name} ברצף של ${p.currentStreak} נצחונות!`;
      if (p.currentStreak < 0) return `❄️ ${p.name} ברצף של ${Math.abs(p.currentStreak)} הפסדים.`;
      return `${p.name} לא נמצא ברצף כרגע.`;
    }

    // Default player response
    return `${p.name}: מקום ${p.rank}, ${p.totalProfit >= 0 ? '+' : ''}₪${cleanNumber(p.totalProfit)} כולל, ${p.gamesPlayed} משחקים, ${p.winPercentage.toFixed(0)}% נצחונות.`;
  }

  // ===== RECORDS & STATS =====

  // Biggest win
  if ((q.includes('שיא') || q.includes('record') || q.includes('הכי גדול') || q.includes('biggest')) &&
      (q.includes('נצחון') || q.includes('win') || q.includes('רווח') || q.includes('profit'))) {
    const best = players.reduce((max, p) => p.biggestWin > max.biggestWin ? p : max, players[0]);
    return `🏆 הנצחון הגדול ביותר: ${best.name} עם +₪${cleanNumber(best.biggestWin)} במשחק בודד!`;
  }

  // Biggest loss
  if ((q.includes('שיא') || q.includes('record') || q.includes('הכי גדול') || q.includes('biggest')) &&
      (q.includes('הפסד') || q.includes('loss'))) {
    const worst = players.reduce((min, p) => p.biggestLoss < min.biggestLoss ? p : min, players[0]);
    return `ההפסד הגדול ביותר: ${worst.name} עם ₪${cleanNumber(worst.biggestLoss)} במשחק בודד 😢`;
  }

  // Streaks - who is hot/cold
  if (q.includes('רצף') || q.includes('streak') || q.includes('חם') || q.includes('hot') || q.includes('קר') || q.includes('cold')) {
    const hot = players.filter(p => p.currentStreak >= 2);
    const cold = players.filter(p => p.currentStreak <= -2);
    let response = '';
    if (hot.length > 0) response += `🔥 חמים: ${hot.map(p => `${p.name} (${p.currentStreak} נצחונות)`).join(', ')}\n`;
    if (cold.length > 0) response += `❄️ קרים: ${cold.map(p => `${p.name} (${Math.abs(p.currentStreak)} הפסדים)`).join(', ')}`;
    return response || 'אין שחקנים ברצפים משמעותיים כרגע.';
  }

  // Most games
  if ((q.includes('הכי הרבה') || q.includes('most')) && (q.includes('משחקים') || q.includes('games'))) {
    const most = players.reduce((max, p) => p.gamesPlayed > max.gamesPlayed ? p : max, players[0]);
    return `${most.name} שיחק הכי הרבה משחקים: ${most.gamesPlayed} משחקים! 🎰`;
  }

  // Total games
  if (q.includes('כמה משחקים') || q.includes('how many games') || q.includes('סך הכל משחקים')) {
    return `סה"כ ${totalGames} משחקים הושלמו עד היום 🎴`;
  }

  // How many players
  if (q.includes('כמה שחקנים') || q.includes('how many players')) {
    return `יש ${players.length} שחקנים פעילים במערכת 👥`;
  }

  // ===== ADDITIONAL PATTERNS =====

  // Best / worst average
  if ((q.includes('ממוצע') || q.includes('average')) && (q.includes('הכי') || q.includes('best') || q.includes('worst'))) {
    const withEnoughGames = players.filter(p => p.gamesPlayed >= 3);
    if (withEnoughGames.length > 0) {
      const bestAvg = withEnoughGames.reduce((max, p) => p.avgProfit > max.avgProfit ? p : max, withEnoughGames[0]);
      const worstAvg = withEnoughGames.reduce((min, p) => p.avgProfit < min.avgProfit ? p : min, withEnoughGames[0]);
      if (q.includes('גרוע') || q.includes('worst') || q.includes('נמוך')) {
        return `הממוצע הנמוך ביותר: ${worstAvg.name} עם ${worstAvg.avgProfit >= 0 ? '+' : ''}₪${cleanNumber(worstAvg.avgProfit)} למשחק`;
      }
      return `הממוצע הגבוה ביותר: ${bestAvg.name} עם +₪${cleanNumber(bestAvg.avgProfit)} למשחק! 📈`;
    }
  }

  // Best win rate
  if ((q.includes('אחוז') || q.includes('%') || q.includes('נצחונות')) && 
      (q.includes('הכי') || q.includes('best') || q.includes('גבוה'))) {
    const withEnoughGames = players.filter(p => p.gamesPlayed >= 5);
    if (withEnoughGames.length > 0) {
      const best = withEnoughGames.reduce((max, p) => p.winPercentage > max.winPercentage ? p : max, withEnoughGames[0]);
      return `אחוז הנצחונות הגבוה ביותר: ${best.name} עם ${best.winPercentage.toFixed(0)}% (${best.winCount}/${best.gamesPlayed} משחקים) 🎯`;
    }
  }

  // Summary / overview
  if (q.includes('סיכום') || q.includes('summary') || q.includes('overview') || q.includes('סקירה')) {
    const top3 = players.slice(0, 3).map((p, i) => `${['🥇', '🥈', '🥉'][i]} ${p.name}: ${p.totalProfit >= 0 ? '+' : ''}₪${cleanNumber(p.totalProfit)}`).join('\n');
    const hot = players.find(p => p.currentStreak >= 2);
    const cold = players.find(p => p.currentStreak <= -2);
    
    return `📊 סיכום הקבוצה:\n\n${top3}\n\n` +
           `🎮 סה"כ ${totalGames} משחקים | ${players.length} שחקנים\n` +
           (hot ? `🔥 ${hot.name} חם (${hot.currentStreak} נצחונות)\n` : '') +
           (cold ? `❄️ ${cold.name} קר (${Math.abs(cold.currentStreak)} הפסדים)` : '');
  }

  // Fun facts / interesting
  if (q.includes('מעניין') || q.includes('interesting') || q.includes('fun') || q.includes('כיף') || q.includes('עובדות')) {
    const mostGames = players.reduce((max, p) => p.gamesPlayed > max.gamesPlayed ? p : max, players[0]);
    const volatilities = players.filter(p => p.gamesPlayed >= 5).map(p => ({ name: p.name, v: getPlayerVolatility(p.name, games) }));
    const mostVolatile = volatilities.sort((a, b) => b.v - a.v)[0];
    const lineups = getCommonLineups(games);
    
    return `🎰 עובדות מעניינות:\n\n` +
           `• ${mostGames.name} שיחק הכי הרבה: ${mostGames.gamesPlayed} משחקים\n` +
           (mostVolatile ? `• ${mostVolatile.name} הכי תנודתי\n` : '') +
           (lineups[0] ? `• ${lineups[0].players.join(' & ')} משחקים הכי הרבה ביחד (${lineups[0].count})\n` : '') +
           `• סה"כ ${totalGames} משחקים שוחקו`;
  }

  // Rebuy value
  if (q.includes('ערך') || q.includes('כניסה') || q.includes('rebuy') || q.includes('value') || q.includes('buy-in')) {
    return `💰 ערך כניסה: ₪${settings.rebuyValue}`;
  }

  // Help
  if (q.includes('עזרה') || q.includes('help') || q.includes('מה אתה יכול') || q.includes('what can you')) {
    return `אני יכול לענות על המון שאלות! כמה רעיונות:\n\n` +
           `🎮 "מי ניצח במשחק האחרון?"\n` +
           `📍 "איפה שיחקנו לאחרונה?"\n` +
           `🏆 "מי מוביל בטבלה?"\n` +
           `👤 "ספר לי על ${players[0]?.name || 'שחקן'}"\n` +
           `⚔️ "${players[0]?.name} נגד ${players[1]?.name || 'שחקן'}"\n` +
           `😈 "מי הנמסיס של ${players[0]?.name}?"\n` +
           `📈 "מי משתפר לאחרונה?"\n` +
           `🏠 "מי מנצח הכי הרבה אצל X?"\n` +
           `🎢 "מי הכי תנודתי?"\n` +
           `👥 "מי משחק הכי הרבה ביחד?"\n` +
           `🔮 "תחזית להערב"\n` +
           `📅 "מי ניצח בנובמבר?"`;
  }

  // ===== DEFAULT - Give something useful =====
  
  const facts: string[] = [];
  
  // Leader info
  if (leader) {
    facts.push(`🥇 ${leader.name} מוביל עם ${leader.totalProfit >= 0 ? '+' : ''}₪${cleanNumber(leader.totalProfit)}`);
  }
  
  // Last game info
  if (lastGame) {
    facts.push(`🎮 משחק אחרון: ${lastGame.date}${lastGame.location !== 'לא צוין' ? ` ב-${lastGame.location}` : ''} - ${lastGame.winner} ניצח`);
  }
  
  // Hot/cold streaks
  const hotPlayer = players.find(p => p.currentStreak >= 2);
  const coldPlayer = players.find(p => p.currentStreak <= -2);
  if (hotPlayer) {
    facts.push(`🔥 ${hotPlayer.name} ברצף ${hotPlayer.currentStreak} נצחונות`);
  }
  if (coldPlayer) {
    facts.push(`❄️ ${coldPlayer.name} ברצף ${Math.abs(coldPlayer.currentStreak)} הפסדים`);
  }
  
  // Rivalry hint
  let biggestRivalry = { p1: '', p2: '', games: 0 };
  const lineups = getCommonLineups(games);
  if (lineups[0] && lineups[0].count >= 5) {
    const h2h = getHeadToHead(lineups[0].players[0], lineups[0].players[1], games);
    if (Math.abs(h2h.player1BetterFinish - h2h.player2BetterFinish) <= 2) {
      facts.push(`⚔️ יריבות צמודה: ${lineups[0].players[0]} vs ${lineups[0].players[1]}`);
    }
  }
  
  // Total games
  facts.push(`📊 סה"כ ${totalGames} משחקים | ${players.length} שחקנים`);
  
  return `הנה כמה עובדות מעניינות:\n\n${facts.join('\n')}\n\n💡 אפשר לשאול:\n"מי הנמסיס של X?"\n"X נגד Y"\n"תחזית להערב"`;
};

/**
 * Build comprehensive data context for AI
 */
const buildDataContext = (): string => {
  const data = getProcessedData();
  const { players, games, totalGames, settings } = data;

  if (players.length === 0) {
    return 'אין נתונים במערכת עדיין.';
  }

  // Current streaks
  const hotPlayers = players.filter(p => p.currentStreak >= 2);
  const coldPlayers = players.filter(p => p.currentStreak <= -2);

  // Head-to-head summary for common pairs
  const commonPairs = getCommonLineups(games).slice(0, 3);
  const h2hSummary = commonPairs.map(pair => {
    const h2h = getHeadToHead(pair.players[0], pair.players[1], games);
    return `${pair.players[0]} vs ${pair.players[1]}: ${h2h.gamesPlayedTogether} משחקים, נצחונות ${pair.players[0]}:${h2h.player1Wins} ${pair.players[1]}:${h2h.player2Wins}`;
  }).join('\n');

  // Trends
  const trends = players.slice(0, 5).map(p => {
    const trend = getPlayerTrend(p.name, games);
    return `${p.name}: ${trend.trend}`;
  }).join(', ');

  // Location stats
  const locStats = getLocationStats(games);
  const locSummary = Object.entries(locStats).slice(0, 3).map(([loc, stats]) => {
    const topWinner = Object.entries(stats.winners).sort((a, b) => b[1] - a[1])[0];
    return `${loc}: ${stats.games} משחקים, מנצח עיקרי: ${topWinner?.[0] || 'N/A'}`;
  }).join('\n');

  return `
=== נתוני קבוצת הפוקר ===
תאריך היום: ${new Date().toLocaleDateString('he-IL')}

=== הגדרות ===
ערך כניסה: ₪${settings.rebuyValue}

=== סטטיסטיקות כלליות ===
סה"כ משחקים: ${totalGames}
שחקנים פעילים: ${players.length}

=== טבלת מובילים (לפי רווח) ===
${players.map(p => 
  `${p.rank}. ${p.name}: ${p.totalProfit >= 0 ? '+' : ''}₪${cleanNumber(p.totalProfit)} | ${p.gamesPlayed} משחקים | ${p.winPercentage.toFixed(0)}% נצחונות | ממוצע: ${p.avgProfit >= 0 ? '+' : ''}₪${cleanNumber(p.avgProfit)} | שיא: +₪${cleanNumber(p.biggestWin)} | שפל: ₪${cleanNumber(p.biggestLoss)} | רצף: ${p.currentStreak}`
).join('\n')}

=== רצפים נוכחיים ===
חמים: ${hotPlayers.length > 0 ? hotPlayers.map(p => `${p.name} (${p.currentStreak} נצחונות)`).join(', ') : 'אין'}
קרים: ${coldPlayers.length > 0 ? coldPlayers.map(p => `${p.name} (${Math.abs(p.currentStreak)} הפסדים)`).join(', ') : 'אין'}

=== מגמות שחקנים ===
${trends}

=== יריבויות Head-to-Head ===
${h2hSummary}

=== סטטיסטיקות לפי מיקום ===
${locSummary}

=== ${Math.min(games.length, 10)} משחקים אחרונים ===
${games.slice(0, 10).map((game, idx) => `
משחק ${idx + 1}: ${game.date}
מיקום: ${game.location}
שחקנים: ${game.playerCount}
מנצח: ${game.winner} (+₪${cleanNumber(game.winnerProfit)})
אחרון: ${game.loser} (₪${cleanNumber(game.loserProfit)})
תוצאות: ${game.results.map(r => `${r.name}: ${r.profit >= 0 ? '+' : ''}₪${cleanNumber(r.profit)}`).join(', ')}
`).join('\n')}
`;
};

/**
 * Try to get AI answer with retries
 */
const tryAIAnswer = async (question: string, dataContext: string, apiKey: string): Promise<string | null> => {
  const systemPrompt = `אתה עוזר חכם ומומחה לקבוצת פוקר ביתית. עונה בעברית, קצר וקולע (2-4 משפטים).
השתמש באימוג'ים במידה. תהיה ידידותי, מצחיק לפעמים, ותן תשובות מעניינות.
אתה יודע לנתח יריבויות, מגמות, ביצועים לפי מיקום, ולתת תחזיות.

שאלת המשתמש: "${question}"

הנה כל הנתונים:
${dataContext}

ענה על השאלה בעברית בצורה מעניינת ואינפורמטיבית:`;

  const models = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-pro'];
  
  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
      
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: systemPrompt }] }],
          generationConfig: {
            temperature: 0.8,
            maxOutputTokens: 500,
          },
          safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
          ]
        })
      });
      
      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text && text.trim().length > 0) {
          return text.trim();
        }
      }
    } catch (e) {
      // Continue to next model
      console.log(`Model ${model} failed, trying next...`);
    }
  }
  
  return null;
};

/**
 * Process question - always returns an answer
 */
export const processQuestion = async (question: string): Promise<{ answer: string; source: 'local' | 'ai' }> => {
  const apiKey = getGeminiApiKey();
  
  // First, get local answer as backup
  const localAnswer = getLocalAnswer(question);
  
  // If no API key, use local answer
  if (!apiKey) {
    return { answer: localAnswer, source: 'local' };
  }

  // Try AI answer
  try {
    const dataContext = buildDataContext();
    const aiAnswer = await tryAIAnswer(question, dataContext, apiKey);
    
    if (aiAnswer) {
      return { answer: aiAnswer, source: 'ai' };
    }
  } catch (error) {
    console.error('AI failed:', error);
  }

  // Fallback to local answer
  return { answer: localAnswer, source: 'local' };
};

/**
 * Check if AI is available (has API key)
 */
export const isAIAvailable = (): boolean => {
  return !!getGeminiApiKey();
};

/**
 * Get suggested questions based on data
 */
export const getSuggestedQuestions = (): string[] => {
  const data = getProcessedData();
  const { players, games } = data;
  
  const questions: string[] = [];
  
  if (games.length > 0) {
    questions.push('מי ניצח במשחק האחרון?');
  }
  
  questions.push('מי מוביל בטבלה?');
  
  if (players.length >= 2) {
    const p1 = players[0].name;
    const p2 = players[1].name;
    questions.push(`${p1} נגד ${p2}`);
  }
  
  if (players.length > 0) {
    questions.push(`מי הנמסיס של ${players[0].name}?`);
  }
  
  questions.push('תחזית להערב');
  questions.push('מי משתפר לאחרונה?');
  
  return questions.slice(0, 5);
};

/**
 * Clear conversation context
 */
export const clearConversationContext = (): void => {
  lastMentionedPlayer = null;
  conversationContext = {};
};
