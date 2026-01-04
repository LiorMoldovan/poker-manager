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
  const completedGames = games.filter(g => g.status === 'completed');
  const settings = getSettings();

  // Extract player names from question
  const playerNames = players.map(p => p.name.toLowerCase());
  const mentionedPlayer = playerNames.find(name => lowerQuestion.includes(name));

  // Player-specific queries
  if (mentionedPlayer) {
    const player = players.find(p => p.name.toLowerCase() === mentionedPlayer);
    if (!player) return `לא מצאתי שחקן בשם "${mentionedPlayer}"`;

    const stats = getPlayerStats(player.id);
    if (!stats) return `אין נתונים עבור ${player.name}`;

    // Questions about wins/losses
    if (lowerQuestion.includes('נצחון') || lowerQuestion.includes('ניצח') || lowerQuestion.includes('win')) {
      return `${player.name} ניצח ${stats.winCount} משחקים מתוך ${stats.gamesPlayed} (${stats.winPercentage.toFixed(1)}% נצחונות). הנצחון הגדול ביותר שלו: +₪${cleanNumber(stats.biggestWin)}.`;
    }

    if (lowerQuestion.includes('הפסד') || lowerQuestion.includes('הפסיד') || lowerQuestion.includes('loss')) {
      return `${player.name} הפסיד ${stats.lossCount} משחקים מתוך ${stats.gamesPlayed}. ההפסד הגדול ביותר שלו: -₪${cleanNumber(stats.biggestLoss)}.`;
    }

    if (lowerQuestion.includes('רווח') || lowerQuestion.includes('profit') || lowerQuestion.includes('כמה') || lowerQuestion.includes('total')) {
      const sign = stats.totalProfit >= 0 ? '+' : '';
      return `${player.name} - רווח כולל: ${sign}₪${cleanNumber(stats.totalProfit)}, ממוצע: ${sign}₪${cleanNumber(stats.avgProfit)} למשחק, ${stats.gamesPlayed} משחקים בסך הכל.`;
    }

    if (lowerQuestion.includes('רצף') || lowerQuestion.includes('streak')) {
      if (stats.currentStreak > 0) {
        return `${player.name} נמצא ברצף של ${stats.currentStreak} נצחונות רצופים!`;
      } else if (stats.currentStreak < 0) {
        return `${player.name} נמצא ברצף של ${Math.abs(stats.currentStreak)} הפסדים רצופים.`;
      } else {
        return `${player.name} לא נמצא כרגע ברצף.`;
      }
    }

    if (lowerQuestion.includes('ממוצע') || lowerQuestion.includes('average')) {
      const sign = stats.avgProfit >= 0 ? '+' : '';
      return `${player.name} - ממוצע רווח: ${sign}₪${cleanNumber(stats.avgProfit)} למשחק (${stats.gamesPlayed} משחקים).`;
    }

    // General player info
    return `${player.name} - ${stats.gamesPlayed} משחקים, רווח כולל: ${stats.totalProfit >= 0 ? '+' : ''}₪${cleanNumber(stats.totalProfit)}, ממוצע: ${stats.totalProfit >= 0 ? '+' : ''}₪${cleanNumber(stats.avgProfit)} למשחק, ${stats.winPercentage.toFixed(1)}% נצחונות.`;
  }

  // General statistics queries
  if (lowerQuestion.includes('כמה משחקים') || lowerQuestion.includes('how many games') || lowerQuestion.includes('total games')) {
    return `סה"כ ${completedGames.length} משחקים הושלמו.`;
  }

  if (lowerQuestion.includes('כמה שחקנים') || lowerQuestion.includes('how many players')) {
    return `סה"כ ${players.length} שחקנים במערכת.`;
  }

  if (lowerQuestion.includes('מוביל') || lowerQuestion.includes('leader') || lowerQuestion.includes('ראשון') || lowerQuestion.includes('top')) {
    const allStats = players.map(p => ({ name: p.name, stats: getPlayerStats(p.id) }))
      .filter(p => p.stats)
      .sort((a, b) => (b.stats!.totalProfit - a.stats!.totalProfit));
    
    if (allStats.length === 0) return 'אין נתונים זמינים.';
    
    const leader = allStats[0];
    const sign = leader.stats!.totalProfit >= 0 ? '+' : '';
    return `המוביל בטבלה: ${leader.name} עם ${sign}₪${cleanNumber(leader.stats!.totalProfit)} כולל (${leader.stats!.gamesPlayed} משחקים).`;
  }

  if (lowerQuestion.includes('טבלה') || lowerQuestion.includes('leaderboard') || lowerQuestion.includes('ranking')) {
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

  if (lowerQuestion.includes('משחק אחרון') || lowerQuestion.includes('last game') || lowerQuestion.includes('אחרון')) {
    if (completedGames.length === 0) return 'אין משחקים הושלמו עדיין.';
    
    const lastGame = completedGames.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];
    const gamePlayers = getGamePlayers(lastGame.id);
    const winner = gamePlayers.sort((a, b) => b.profit - a.profit)[0];
    
    return `המשחק האחרון היה ב-${new Date(lastGame.date).toLocaleDateString('he-IL')}${lastGame.location ? ` ב-${lastGame.location}` : ''}. המנצח: ${winner.playerName} עם +₪${cleanNumber(winner.profit)}.`;
  }

  if (lowerQuestion.includes('rebuy') || lowerQuestion.includes('ריבוי') || lowerQuestion.includes('רכישה')) {
    return `ערך ריבוי: ₪${cleanNumber(settings.rebuyValue)}, ${cleanNumber(settings.chipsPerRebuy)} שבבים לריבוי.`;
  }

  // Default response
  return `אני יכול לעזור עם שאלות על שחקנים, משחקים, סטטיסטיקות וטבלאות. נסה לשאול על שחקן ספציפי, המוביל בטבלה, או המשחק האחרון.`;
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
      lastGame: games.length > 0 ? games.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0] : null,
    };

    const prompt = `אתה עוזר AI עבור אפליקציית ניהול משחקי פוקר. המשתמש שאל שאלה בעברית ואתה קיבלת תשובה בסיסית מהנתונים המקומיים.

שאלת המשתמש: "${question}"

תשובה מקומית: "${localAnswer}"

נתונים נוספים מהמערכת:
- סה"כ משחקים: ${context.totalGames}
- שחקנים: ${context.players.length}
${context.lastGame ? `- משחק אחרון: ${new Date(context.lastGame.date).toLocaleDateString('he-IL')}` : ''}

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

