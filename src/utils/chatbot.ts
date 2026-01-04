/**
 * Chatbot Utilities
 * Provides intelligent answers about poker game data
 * Works with or without AI - always provides useful answers
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
}

interface PlayerData {
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

  // Get all player stats
  const playerStats = players.map(p => {
    const stats = getPlayerStats(p.id);
    return { player: p, stats };
  }).filter(ps => ps.stats && ps.stats.gamesPlayed > 0);

  // Sort by total profit for rankings
  const rankedPlayers: PlayerData[] = [...playerStats]
    .sort((a, b) => b.stats!.totalProfit - a.stats!.totalProfit)
    .map((ps, idx) => ({
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
 * Smart local answer - understands common questions without AI
 */
const getLocalAnswer = (question: string): string => {
  const q = question.toLowerCase();
  const data = getProcessedData();
  const { players, games, totalGames } = data;

  if (players.length === 0) {
    return 'אין עדיין נתונים במערכת. שחקו כמה משחקים ואז אוכל לענות על שאלות! 🎰';
  }

  const lastGame = games[0];
  const leader = players[0];
  const lastPlace = players[players.length - 1];

  // Helper to find player by name
  const findPlayer = (name: string) => players.find(p => q.includes(p.name.toLowerCase()));
  const mentionedPlayer = findPlayer(q);

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
      return `${p.name} (מקום ${p.rank}):\n` +
             `💰 רווח כולל: ${p.totalProfit >= 0 ? '+' : ''}₪${cleanNumber(p.totalProfit)}\n` +
             `🎮 ${p.gamesPlayed} משחקים | ${p.winPercentage.toFixed(0)}% נצחונות\n` +
             `📊 ממוצע: ${p.avgProfit >= 0 ? '+' : ''}₪${cleanNumber(p.avgProfit)} למשחק\n` +
             `🎯 שיא: +₪${cleanNumber(p.biggestWin)} | שפל: ₪${cleanNumber(p.biggestLoss)}\n` +
             (streakText ? streakText : '');
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

  // ===== COMPARISONS =====
  
  // Compare two players
  if (q.includes(' vs ') || q.includes(' נגד ') || q.includes(' מול ')) {
    const names = players.map(p => p.name.toLowerCase());
    const found = names.filter(n => q.includes(n));
    if (found.length >= 2) {
      const p1 = players.find(p => p.name.toLowerCase() === found[0])!;
      const p2 = players.find(p => p.name.toLowerCase() === found[1])!;
      return `⚔️ ${p1.name} vs ${p2.name}:\n` +
             `${p1.name}: ${p1.totalProfit >= 0 ? '+' : ''}₪${cleanNumber(p1.totalProfit)} (מקום ${p1.rank})\n` +
             `${p2.name}: ${p2.totalProfit >= 0 ? '+' : ''}₪${cleanNumber(p2.totalProfit)} (מקום ${p2.rank})`;
    }
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
    return `📊 סיכום הקבוצה:\n\n${top3}\n\nסה"כ ${totalGames} משחקים | ${players.length} שחקנים פעילים`;
  }

  // Who should I bet on / prediction
  if (q.includes('להמר') || q.includes('bet') || q.includes('ינצח') || q.includes('יזכה') || q.includes('סיכוי')) {
    const hot = players.find(p => p.currentStreak >= 2);
    const bestRecent = players.filter(p => p.currentStreak > 0).sort((a, b) => b.avgProfit - a.avgProfit)[0];
    const pick = hot || bestRecent || leader;
    return `🎲 המומלץ שלי: ${pick.name}!\n${pick.currentStreak > 0 ? `ברצף ${pick.currentStreak} נצחונות 🔥` : ''}\nממוצע: ${pick.avgProfit >= 0 ? '+' : ''}₪${cleanNumber(pick.avgProfit)} למשחק`;
  }

  // Fun facts / interesting
  if (q.includes('מעניין') || q.includes('interesting') || q.includes('fun') || q.includes('כיף') || q.includes('עובדות')) {
    const mostGames = players.reduce((max, p) => p.gamesPlayed > max.gamesPlayed ? p : max, players[0]);
    const biggestSwing = players.reduce((max, p) => (p.biggestWin - p.biggestLoss) > (max.biggestWin - max.biggestLoss) ? p : max, players[0]);
    return `🎰 עובדות מעניינות:\n\n` +
           `• ${mostGames.name} שיחק הכי הרבה: ${mostGames.gamesPlayed} משחקים\n` +
           `• ${biggestSwing.name} הכי תנודתי: בין +₪${cleanNumber(biggestSwing.biggestWin)} ל-₪${cleanNumber(biggestSwing.biggestLoss)}\n` +
           `• סה"כ ${totalGames} משחקים שוחקו`;
  }

  // Help
  if (q.includes('עזרה') || q.includes('help') || q.includes('מה אתה יכול') || q.includes('what can you')) {
    return `אני יכול לענות על שאלות כמו:\n\n` +
           `🎮 "מי ניצח במשחק האחרון?"\n` +
           `📍 "איפה שיחקנו לאחרונה?"\n` +
           `🏆 "מי מוביל בטבלה?"\n` +
           `👤 "ספר לי על ${players[0]?.name || 'שחקן'}"\n` +
           `🔥 "מי ברצף נצחונות?"\n` +
           `📊 "סיכום הקבוצה"`;
  }

  // ===== DEFAULT - Give something useful =====
  // Instead of "I don't understand", give a quick summary of interesting facts
  
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
  
  // Total games
  facts.push(`📊 סה"כ ${totalGames} משחקים | ${players.length} שחקנים`);
  
  return `הנה כמה עובדות מעניינות:\n\n${facts.join('\n')}\n\n💡 נסה לשאול על שחקן ספציפי או על המשחק האחרון!`;
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

=== ${games.length} משחקים אחרונים ===
${games.map((game, idx) => `
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
  const systemPrompt = `אתה עוזר חכם לקבוצת פוקר. עונה בעברית, קצר וקולע (2-3 משפטים).
השתמש באימוג'ים במידה. תהיה ידידותי ומצחיק לפעמים.

שאלת המשתמש: "${question}"

הנה כל הנתונים:
${dataContext}

ענה על השאלה בעברית:`;

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
            temperature: 0.7,
            maxOutputTokens: 400,
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
    questions.push('איפה שיחקנו לאחרונה?');
  }
  
  questions.push('מי מוביל בטבלה?');
  
  if (players.length > 0) {
    const randomPlayer = players[Math.floor(Math.random() * Math.min(5, players.length))];
    questions.push(`ספר לי על ${randomPlayer.name}`);
  }
  
  questions.push('מי ברצף נצחונות?');
  
  return questions.slice(0, 4);
};
