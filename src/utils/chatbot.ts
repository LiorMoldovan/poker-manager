/**
 * Chatbot Utilities
 * Provides local data querying and AI-enhanced answers
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

/**
 * Query local poker data based on natural language question
 */
export const queryLocalData = (question: string): string => {
  const lowerQuestion = question.toLowerCase();
  const players = getAllPlayers();
  const games = getAllGames();
  const completedGames = games.filter(g => g.status === 'completed')
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  const settings = getSettings();

  // Get last game data early - needed for many queries
  const lastGame = completedGames[0];
  const lastGamePlayers = lastGame ? getGamePlayers(lastGame.id).sort((a, b) => b.profit - a.profit) : [];
  const lastGameWinner = lastGamePlayers[0];
  const lastGameLoser = lastGamePlayers[lastGamePlayers.length - 1];

  // Extract player names from question
  const playerNames = players.map(p => p.name.toLowerCase());
  const mentionedPlayer = playerNames.find(name => lowerQuestion.includes(name));

  // ============ LAST GAME QUERIES ============
  
  // Where was the last game / location
  if ((lowerQuestion.includes('איפה') || lowerQuestion.includes('מיקום') || lowerQuestion.includes('location') || lowerQuestion.includes('where')) &&
      (lowerQuestion.includes('משחק') || lowerQuestion.includes('אחרון') || lowerQuestion.includes('game') || lowerQuestion.includes('last'))) {
    if (!lastGame) return 'אין משחקים שהושלמו עדיין.';
    if (lastGame.location) {
      return `המשחק האחרון (${new Date(lastGame.date).toLocaleDateString('he-IL')}) היה ב-${lastGame.location}.`;
    } else {
      return `למשחק האחרון (${new Date(lastGame.date).toLocaleDateString('he-IL')}) לא נרשם מיקום.`;
    }
  }

  // Who finished last / who lost the most in last game
  if ((lowerQuestion.includes('אחרון') || lowerQuestion.includes('last') || lowerQuestion.includes('הפסיד') || lowerQuestion.includes('lost')) &&
      (lowerQuestion.includes('מקום') || lowerQuestion.includes('place') || lowerQuestion.includes('סיים') || lowerQuestion.includes('finished') || 
       lowerQuestion.includes('הכי הרבה') || lowerQuestion.includes('most'))) {
    if (!lastGame) return 'אין משחקים שהושלמו עדיין.';
    if (lastGameLoser) {
      return `במשחק האחרון (${new Date(lastGame.date).toLocaleDateString('he-IL')}), ${lastGameLoser.playerName} סיים במקום האחרון עם ${lastGameLoser.profit >= 0 ? '+' : ''}₪${cleanNumber(lastGameLoser.profit)}.`;
    }
    return 'אין נתונים על המשחק האחרון.';
  }

  // Who won / finished first in last game
  if ((lowerQuestion.includes('ניצח') || lowerQuestion.includes('won') || lowerQuestion.includes('מנצח') || lowerQuestion.includes('winner') ||
       lowerQuestion.includes('ראשון') || lowerQuestion.includes('first')) &&
      (lowerQuestion.includes('משחק') || lowerQuestion.includes('game') || lowerQuestion.includes('אחרון') || lowerQuestion.includes('last'))) {
    if (!lastGame) return 'אין משחקים שהושלמו עדיין.';
    if (lastGameWinner) {
      return `המנצח במשחק האחרון (${new Date(lastGame.date).toLocaleDateString('he-IL')}): ${lastGameWinner.playerName} עם +₪${cleanNumber(lastGameWinner.profit)}.`;
    }
    return 'אין נתונים על המשחק האחרון.';
  }

  // General last game info
  if ((lowerQuestion.includes('משחק אחרון') || lowerQuestion.includes('last game') || 
       (lowerQuestion.includes('אחרון') && lowerQuestion.includes('משחק')))) {
    if (!lastGame) return 'אין משחקים שהושלמו עדיין.';
    
    const playersText = lastGamePlayers.map(p => `${p.playerName}: ${p.profit >= 0 ? '+' : ''}₪${cleanNumber(p.profit)}`).join(', ');
    return `המשחק האחרון היה ב-${new Date(lastGame.date).toLocaleDateString('he-IL')}${lastGame.location ? ` ב-${lastGame.location}` : ''}.\nתוצאות: ${playersText}`;
  }

  // When was the last game
  if ((lowerQuestion.includes('מתי') || lowerQuestion.includes('when')) &&
      (lowerQuestion.includes('משחק') || lowerQuestion.includes('game') || lowerQuestion.includes('אחרון') || lowerQuestion.includes('last'))) {
    if (!lastGame) return 'אין משחקים שהושלמו עדיין.';
    return `המשחק האחרון היה ב-${new Date(lastGame.date).toLocaleDateString('he-IL')}${lastGame.location ? ` ב-${lastGame.location}` : ''}.`;
  }

  // How many players in last game
  if ((lowerQuestion.includes('כמה') || lowerQuestion.includes('how many')) &&
      (lowerQuestion.includes('שחקנים') || lowerQuestion.includes('players')) &&
      (lowerQuestion.includes('משחק') || lowerQuestion.includes('game') || lowerQuestion.includes('אחרון') || lowerQuestion.includes('last'))) {
    if (!lastGame) return 'אין משחקים שהושלמו עדיין.';
    return `במשחק האחרון (${new Date(lastGame.date).toLocaleDateString('he-IL')}) שיחקו ${lastGamePlayers.length} שחקנים.`;
  }

  // ============ PLAYER-SPECIFIC QUERIES ============
  
  if (mentionedPlayer) {
    const player = players.find(p => p.name.toLowerCase() === mentionedPlayer);
    if (!player) return `לא מצאתי שחקן בשם "${mentionedPlayer}"`;

    const stats = getPlayerStats(player.id);
    if (!stats || stats.gamesPlayed === 0) return `אין נתונים עבור ${player.name}`;

    // Questions about wins
    if (lowerQuestion.includes('נצחון') || lowerQuestion.includes('ניצח') || lowerQuestion.includes('win') || lowerQuestion.includes('זכה')) {
      return `${player.name} ניצח ${stats.winCount} משחקים מתוך ${stats.gamesPlayed} (${stats.winPercentage.toFixed(1)}% נצחונות). הנצחון הגדול ביותר: +₪${cleanNumber(stats.biggestWin)}.`;
    }

    // Questions about losses
    if (lowerQuestion.includes('הפסד') || lowerQuestion.includes('הפסיד') || lowerQuestion.includes('loss') || lowerQuestion.includes('lost')) {
      return `${player.name} הפסיד ${stats.lossCount} משחקים מתוך ${stats.gamesPlayed}. ההפסד הגדול ביותר: ₪${cleanNumber(stats.biggestLoss)}.`;
    }

    // Questions about profit/money
    if (lowerQuestion.includes('רווח') || lowerQuestion.includes('profit') || lowerQuestion.includes('כסף') || lowerQuestion.includes('money') || 
        lowerQuestion.includes('כמה') || lowerQuestion.includes('how much') || lowerQuestion.includes('total')) {
      const sign = stats.totalProfit >= 0 ? '+' : '';
      return `${player.name} - רווח כולל: ${sign}₪${cleanNumber(stats.totalProfit)}, ממוצע: ${sign}₪${cleanNumber(stats.avgProfit)} למשחק, ${stats.gamesPlayed} משחקים בסך הכל.`;
    }

    // Questions about streak
    if (lowerQuestion.includes('רצף') || lowerQuestion.includes('streak')) {
      if (stats.currentStreak > 0) {
        return `${player.name} נמצא ברצף של ${stats.currentStreak} נצחונות רצופים! 🔥`;
      } else if (stats.currentStreak < 0) {
        return `${player.name} נמצא ברצף של ${Math.abs(stats.currentStreak)} הפסדים רצופים.`;
      } else {
        return `${player.name} לא נמצא כרגע ברצף.`;
      }
    }

    // Questions about average
    if (lowerQuestion.includes('ממוצע') || lowerQuestion.includes('average')) {
      const sign = stats.avgProfit >= 0 ? '+' : '';
      return `${player.name} - ממוצע רווח: ${sign}₪${cleanNumber(stats.avgProfit)} למשחק (${stats.gamesPlayed} משחקים).`;
    }

    // Questions about games played
    if (lowerQuestion.includes('משחקים') || lowerQuestion.includes('games')) {
      return `${player.name} שיחק ${stats.gamesPlayed} משחקים, ניצח ${stats.winCount} (${stats.winPercentage.toFixed(1)}%).`;
    }

    // General player info
    return `${player.name} - ${stats.gamesPlayed} משחקים, רווח כולל: ${stats.totalProfit >= 0 ? '+' : ''}₪${cleanNumber(stats.totalProfit)}, ממוצע: ${stats.avgProfit >= 0 ? '+' : ''}₪${cleanNumber(stats.avgProfit)} למשחק, ${stats.winPercentage.toFixed(1)}% נצחונות.`;
  }

  // ============ LEADERBOARD & RANKING QUERIES ============

  // Who is the leader / who is in first place
  if (lowerQuestion.includes('מוביל') || lowerQuestion.includes('leader') || lowerQuestion.includes('ראשון') || 
      lowerQuestion.includes('top') || lowerQuestion.includes('first') || lowerQuestion.includes('מקום ראשון')) {
    const allStats = players.map(p => ({ name: p.name, stats: getPlayerStats(p.id) }))
      .filter(p => p.stats && p.stats.gamesPlayed > 0)
      .sort((a, b) => (b.stats!.totalProfit - a.stats!.totalProfit));
    
    if (allStats.length === 0) return 'אין נתונים זמינים.';
    
    const leader = allStats[0];
    const sign = leader.stats!.totalProfit >= 0 ? '+' : '';
    return `המוביל בטבלה: ${leader.name} עם ${sign}₪${cleanNumber(leader.stats!.totalProfit)} כולל (${leader.stats!.gamesPlayed} משחקים).`;
  }

  // Who is last / who is in last place overall
  if ((lowerQuestion.includes('אחרון') || lowerQuestion.includes('last') || lowerQuestion.includes('תחתית') || lowerQuestion.includes('bottom')) &&
      (lowerQuestion.includes('טבלה') || lowerQuestion.includes('מקום') || lowerQuestion.includes('place') || lowerQuestion.includes('table') || lowerQuestion.includes('ranking'))) {
    const allStats = players.map(p => ({ name: p.name, stats: getPlayerStats(p.id) }))
      .filter(p => p.stats && p.stats.gamesPlayed > 0)
      .sort((a, b) => (a.stats!.totalProfit - b.stats!.totalProfit));
    
    if (allStats.length === 0) return 'אין נתונים זמינים.';
    
    const last = allStats[0];
    return `בתחתית הטבלה: ${last.name} עם ${last.stats!.totalProfit >= 0 ? '+' : ''}₪${cleanNumber(last.stats!.totalProfit)} כולל (${last.stats!.gamesPlayed} משחקים).`;
  }

  // Leaderboard / table / ranking
  if (lowerQuestion.includes('טבלה') || lowerQuestion.includes('leaderboard') || lowerQuestion.includes('ranking') || lowerQuestion.includes('דירוג')) {
    const allStats = players.map(p => ({ name: p.name, stats: getPlayerStats(p.id) }))
      .filter(p => p.stats && p.stats.gamesPlayed > 0)
      .sort((a, b) => (b.stats!.totalProfit - a.stats!.totalProfit))
      .slice(0, 5);
    
    if (allStats.length === 0) return 'אין נתונים זמינים.';
    
    const top5 = allStats.map((p, idx) => {
      const sign = p.stats!.totalProfit >= 0 ? '+' : '';
      return `${idx + 1}. ${p.name}: ${sign}₪${cleanNumber(p.stats!.totalProfit)}`;
    }).join('\n');
    
    return `טבלת המובילים (5 הראשונים):\n${top5}`;
  }

  // ============ GENERAL STATISTICS ============

  // How many games total
  if ((lowerQuestion.includes('כמה משחקים') || lowerQuestion.includes('how many games') || lowerQuestion.includes('total games')) &&
      !lowerQuestion.includes('שחקן') && !mentionedPlayer) {
    return `סה"כ ${completedGames.length} משחקים הושלמו.`;
  }

  // How many players total
  if (lowerQuestion.includes('כמה שחקנים') || lowerQuestion.includes('how many players')) {
    const activePlayers = players.filter(p => {
      const stats = getPlayerStats(p.id);
      return stats && stats.gamesPlayed > 0;
    });
    return `סה"כ ${players.length} שחקנים במערכת, ${activePlayers.length} פעילים (שיחקו לפחות משחק אחד).`;
  }

  // Rebuy settings
  if (lowerQuestion.includes('rebuy') || lowerQuestion.includes('ריביי') || lowerQuestion.includes('רכישה') || lowerQuestion.includes('כניסה')) {
    return `ערך כניסה: ₪${cleanNumber(settings.rebuyValue)}, ${cleanNumber(settings.chipsPerRebuy)} ז'יטונים לכניסה.`;
  }

  // ============ RECORDS ============

  // Biggest win ever
  if ((lowerQuestion.includes('הכי גדול') || lowerQuestion.includes('biggest') || lowerQuestion.includes('שיא') || lowerQuestion.includes('record')) &&
      (lowerQuestion.includes('נצחון') || lowerQuestion.includes('win') || lowerQuestion.includes('רווח') || lowerQuestion.includes('profit'))) {
    const allStats = players.map(p => ({ name: p.name, stats: getPlayerStats(p.id) }))
      .filter(p => p.stats && p.stats.biggestWin > 0);
    
    if (allStats.length === 0) return 'אין נתונים על נצחונות.';
    
    const best = allStats.sort((a, b) => b.stats!.biggestWin - a.stats!.biggestWin)[0];
    return `הנצחון הגדול ביותר: ${best.name} עם +₪${cleanNumber(best.stats!.biggestWin)} במשחק בודד!`;
  }

  // Biggest loss ever
  if ((lowerQuestion.includes('הכי גדול') || lowerQuestion.includes('biggest') || lowerQuestion.includes('שיא') || lowerQuestion.includes('record')) &&
      (lowerQuestion.includes('הפסד') || lowerQuestion.includes('loss'))) {
    const allStats = players.map(p => ({ name: p.name, stats: getPlayerStats(p.id) }))
      .filter(p => p.stats && p.stats.biggestLoss < 0);
    
    if (allStats.length === 0) return 'אין נתונים על הפסדים.';
    
    const worst = allStats.sort((a, b) => a.stats!.biggestLoss - b.stats!.biggestLoss)[0];
    return `ההפסד הגדול ביותר: ${worst.name} עם ₪${cleanNumber(worst.stats!.biggestLoss)} במשחק בודד.`;
  }

  // Best win rate
  if ((lowerQuestion.includes('אחוז') || lowerQuestion.includes('percent') || lowerQuestion.includes('%')) &&
      (lowerQuestion.includes('נצחון') || lowerQuestion.includes('win'))) {
    const allStats = players.map(p => ({ name: p.name, stats: getPlayerStats(p.id) }))
      .filter(p => p.stats && p.stats.gamesPlayed >= 5);
    
    if (allStats.length === 0) return 'אין מספיק נתונים (נדרשים לפחות 5 משחקים).';
    
    const best = allStats.sort((a, b) => b.stats!.winPercentage - a.stats!.winPercentage)[0];
    return `אחוז הנצחונות הגבוה ביותר: ${best.name} עם ${best.stats!.winPercentage.toFixed(1)}% (${best.stats!.gamesPlayed} משחקים).`;
  }

  // Who has the most games
  if ((lowerQuestion.includes('הכי הרבה') || lowerQuestion.includes('most')) &&
      (lowerQuestion.includes('משחקים') || lowerQuestion.includes('games'))) {
    const allStats = players.map(p => ({ name: p.name, stats: getPlayerStats(p.id) }))
      .filter(p => p.stats && p.stats.gamesPlayed > 0)
      .sort((a, b) => b.stats!.gamesPlayed - a.stats!.gamesPlayed);
    
    if (allStats.length === 0) return 'אין נתונים זמינים.';
    
    const most = allStats[0];
    return `הכי הרבה משחקים: ${most.name} עם ${most.stats!.gamesPlayed} משחקים.`;
  }

  // ============ COMPARISONS ============

  // Compare two players (basic)
  const vsMatch = lowerQuestion.match(/(.+?)\s+(נגד|vs|מול)\s+(.+)/);
  if (vsMatch) {
    const name1 = vsMatch[1].trim().toLowerCase();
    const name2 = vsMatch[3].trim().toLowerCase();
    
    const player1 = players.find(p => p.name.toLowerCase() === name1);
    const player2 = players.find(p => p.name.toLowerCase() === name2);
    
    if (player1 && player2) {
      const stats1 = getPlayerStats(player1.id);
      const stats2 = getPlayerStats(player2.id);
      
      if (stats1 && stats2) {
        return `השוואה:\n` +
          `${player1.name}: ${stats1.totalProfit >= 0 ? '+' : ''}₪${cleanNumber(stats1.totalProfit)} (${stats1.gamesPlayed} משחקים, ${stats1.winPercentage.toFixed(1)}%)\n` +
          `${player2.name}: ${stats2.totalProfit >= 0 ? '+' : ''}₪${cleanNumber(stats2.totalProfit)} (${stats2.gamesPlayed} משחקים, ${stats2.winPercentage.toFixed(1)}%)`;
      }
    }
  }

  // ============ DEFAULT RESPONSE ============
  return `לא הבנתי את השאלה. נסה לשאול על:\n• משחק אחרון (מיקום, מנצח, תוצאות)\n• שחקן ספציפי (רווח, נצחונות, ממוצע)\n• טבלת מובילים\n• שיאים (נצחון גדול, הפסד גדול)\n• סטטיסטיקות כלליות`;
};

/**
 * Check if AI is available
 */
export const isAIAvailable = (): boolean => {
  return !!getGeminiApiKey();
};

/**
 * Enhance answer with AI if available
 */
export const enhanceAnswerWithAI = async (
  question: string,
  localAnswer: string
): Promise<string> => {
  const apiKey = getGeminiApiKey();
  if (!apiKey) return localAnswer;

  try {
    // Get context data
    const players = getAllPlayers();
    const games = getAllGames().filter(g => g.status === 'completed');
    const allStats = players.map(p => ({
      name: p.name,
      stats: getPlayerStats(p.id)
    })).filter(p => p.stats);

    const lastGame = games.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];
    const lastGamePlayers = lastGame ? getGamePlayers(lastGame.id).sort((a, b) => b.profit - a.profit) : [];

    const context = {
      players: allStats.map(p => ({
        name: p.name,
        gamesPlayed: p.stats!.gamesPlayed,
        totalProfit: p.stats!.totalProfit,
        avgProfit: p.stats!.avgProfit,
        winPercentage: p.stats!.winPercentage,
        currentStreak: p.stats!.currentStreak,
      })),
      totalGames: games.length,
      lastGame: lastGame ? {
        date: new Date(lastGame.date).toLocaleDateString('he-IL'),
        location: lastGame.location || 'לא ידוע',
        players: lastGamePlayers.map(p => ({ name: p.playerName, profit: p.profit })),
        winner: lastGamePlayers[0]?.playerName,
        loser: lastGamePlayers[lastGamePlayers.length - 1]?.playerName,
      } : null,
    };

    const prompt = `אתה עוזר AI עבור אפליקציית ניהול משחקי פוקר. המשתמש שאל שאלה בעברית ואתה קיבלת תשובה בסיסית מהנתונים המקומיים.

שאלת המשתמש: "${question}"

תשובה מקומית: "${localAnswer}"

נתונים נוספים מהמערכת:
- סה"כ משחקים: ${context.totalGames}
- שחקנים פעילים: ${context.players.length}
${context.lastGame ? `- משחק אחרון: ${context.lastGame.date}${context.lastGame.location !== 'לא ידוע' ? ` ב-${context.lastGame.location}` : ''}
- מנצח אחרון: ${context.lastGame.winner}
- מפסיד אחרון: ${context.lastGame.loser}
- תוצאות מלאות: ${context.lastGame.players.map(p => `${p.name}: ${p.profit >= 0 ? '+' : ''}₪${p.profit}`).join(', ')}` : ''}

השתמש בנתונים האלה כדי לשפר את התשובה - הוסף תובנות, הקשר, או פרטים נוספים שיעזרו למשתמש. תשובה בעברית, קצרה ומדויקת (עד 3-4 משפטים). אם התשובה המקומית כבר טובה, אתה יכול רק לשפר אותה מעט או להוסיף פרט נוסף.`;

    // Try to use Gemini API
    const configs = [
      { version: 'v1beta', model: 'gemini-2.0-flash-lite' },
      { version: 'v1beta', model: 'gemini-2.5-flash-lite' },
      { version: 'v1beta', model: 'gemini-2.0-flash' },
    ];

    for (const config of configs) {
      try {
        const url = `https://generativelanguage.googleapis.com/${config.version}/models/${config.model}:generateContent?key=${apiKey}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 300,
            }
          })
        });

        if (response.ok) {
          const data = await response.json();
          const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            return text.trim();
          }
        }
      } catch (e) {
        // Try next config
        continue;
      }
    }

    // If AI fails, return local answer
    return localAnswer;
  } catch (error) {
    console.error('AI enhancement failed:', error);
    return localAnswer;
  }
};

/**
 * Process a user question and return an answer
 */
export const processQuestion = async (question: string): Promise<{ answer: string; source: 'local' | 'ai' }> => {
  const localAnswer = queryLocalData(question);
  
  if (isAIAvailable()) {
    try {
      const enhancedAnswer = await enhanceAnswerWithAI(question, localAnswer);
      return { answer: enhancedAnswer, source: 'ai' };
    } catch (error) {
      console.error('AI processing failed, using local:', error);
      return { answer: localAnswer, source: 'local' };
    }
  }

  return { answer: localAnswer, source: 'local' };
};
