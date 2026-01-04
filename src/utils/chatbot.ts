/**
 * Chatbot Utilities
 * Provides AI-powered natural language answers about poker game data
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
 * Build comprehensive data context for AI
 */
const buildDataContext = (): string => {
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
  const rankedPlayers = [...playerStats].sort((a, b) => b.stats!.totalProfit - a.stats!.totalProfit);

  // Build leaderboard
  const leaderboard = rankedPlayers.map((ps, idx) => ({
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

  // Get last 10 games with full details
  const recentGames = completedGames.slice(0, 10).map(game => {
    const gamePlayers = getGamePlayers(game.id).sort((a, b) => b.profit - a.profit);
    const totalBuyins = gamePlayers.reduce((sum, p) => sum + p.rebuys, 0);
    
    return {
      date: new Date(game.date).toLocaleDateString('he-IL'),
      dateFormatted: new Date(game.date).toLocaleDateString('en-US', { 
        weekday: 'long', 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
      }),
      location: game.location || 'לא צוין',
      playerCount: gamePlayers.length,
      totalBuyins,
      potSize: totalBuyins * settings.rebuyValue,
      results: gamePlayers.map((p, idx) => ({
        rank: idx + 1,
        name: p.playerName,
        profit: p.profit,
        rebuys: p.rebuys,
        isWinner: idx === 0,
        isLoser: idx === gamePlayers.length - 1,
      })),
      winner: gamePlayers[0]?.playerName,
      winnerProfit: gamePlayers[0]?.profit,
      loser: gamePlayers[gamePlayers.length - 1]?.playerName,
      loserProfit: gamePlayers[gamePlayers.length - 1]?.profit,
    };
  });

  // Calculate group statistics
  const totalGamesPlayed = completedGames.length;
  const totalMoneyInvested = completedGames.reduce((sum, game) => {
    const gamePlayers = getGamePlayers(game.id);
    return sum + gamePlayers.reduce((s, p) => s + p.rebuys, 0) * settings.rebuyValue;
  }, 0);

  // Find records
  const allTimeRecords = {
    biggestSingleWin: {
      player: leaderboard.reduce((max, p) => p.biggestWin > max.biggestWin ? p : max, leaderboard[0]),
    },
    biggestSingleLoss: {
      player: leaderboard.reduce((min, p) => p.biggestLoss < min.biggestLoss ? p : min, leaderboard[0]),
    },
    mostGamesPlayed: {
      player: leaderboard.reduce((max, p) => p.gamesPlayed > max.gamesPlayed ? p : max, leaderboard[0]),
    },
    bestWinRate: {
      player: leaderboard.filter(p => p.gamesPlayed >= 5).reduce((max, p) => p.winPercentage > max.winPercentage ? p : max, leaderboard[0]),
    },
    bestAverage: {
      player: leaderboard.filter(p => p.gamesPlayed >= 5).reduce((max, p) => p.avgProfit > max.avgProfit ? p : max, leaderboard[0]),
    },
    longestWinStreak: {
      player: leaderboard.reduce((max, p) => p.currentStreak > max.currentStreak ? p : max, leaderboard[0]),
    },
    longestLossStreak: {
      player: leaderboard.reduce((min, p) => p.currentStreak < min.currentStreak ? p : min, leaderboard[0]),
    },
  };

  // Current streaks
  const hotPlayers = leaderboard.filter(p => p.currentStreak >= 2);
  const coldPlayers = leaderboard.filter(p => p.currentStreak <= -2);

  // Build the context string
  return `
=== POKER GROUP DATA ===
Today's Date: ${new Date().toLocaleDateString('he-IL')} (${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })})

=== GAME SETTINGS ===
Buy-in value: ₪${settings.rebuyValue}
Chips per buy-in: ${settings.chipsPerRebuy}

=== GROUP STATISTICS ===
Total completed games: ${totalGamesPlayed}
Total active players: ${leaderboard.length}
Total money invested (all games): ₪${cleanNumber(totalMoneyInvested)}

=== CURRENT LEADERBOARD (ALL TIME, RANKED BY PROFIT) ===
${leaderboard.map(p => 
  `${p.rank}. ${p.name} (${p.type}): ${p.totalProfit >= 0 ? '+' : ''}₪${cleanNumber(p.totalProfit)} | ${p.gamesPlayed} games | ${p.winPercentage.toFixed(1)}% wins | Avg: ${p.avgProfit >= 0 ? '+' : ''}₪${cleanNumber(p.avgProfit)} | Best: +₪${cleanNumber(p.biggestWin)} | Worst: ₪${cleanNumber(p.biggestLoss)} | Streak: ${p.currentStreak > 0 ? '+' : ''}${p.currentStreak}`
).join('\n')}

=== RECORDS ===
Biggest single game win: ${allTimeRecords.biggestSingleWin.player?.name} with +₪${cleanNumber(allTimeRecords.biggestSingleWin.player?.biggestWin || 0)}
Biggest single game loss: ${allTimeRecords.biggestSingleLoss.player?.name} with ₪${cleanNumber(allTimeRecords.biggestSingleLoss.player?.biggestLoss || 0)}
Most games played: ${allTimeRecords.mostGamesPlayed.player?.name} with ${allTimeRecords.mostGamesPlayed.player?.gamesPlayed} games
Best win rate (min 5 games): ${allTimeRecords.bestWinRate.player?.name} with ${allTimeRecords.bestWinRate.player?.winPercentage.toFixed(1)}%
Best average profit (min 5 games): ${allTimeRecords.bestAverage.player?.name} with +₪${cleanNumber(allTimeRecords.bestAverage.player?.avgProfit || 0)}/game

=== CURRENT STREAKS ===
🔥 Hot players (win streak): ${hotPlayers.length > 0 ? hotPlayers.map(p => `${p.name} (${p.currentStreak} wins)`).join(', ') : 'None'}
❄️ Cold players (loss streak): ${coldPlayers.length > 0 ? coldPlayers.map(p => `${p.name} (${Math.abs(p.currentStreak)} losses)`).join(', ') : 'None'}

=== LAST ${recentGames.length} GAMES (MOST RECENT FIRST) ===
${recentGames.map((game, idx) => `
--- Game ${idx + 1}: ${game.date} (${game.dateFormatted}) ---
Location: ${game.location}
Players: ${game.playerCount}
Total Buy-ins: ${game.totalBuyins} (Pot: ₪${cleanNumber(game.potSize)})
Winner: ${game.winner} with +₪${cleanNumber(game.winnerProfit || 0)}
Last place: ${game.loser} with ₪${cleanNumber(game.loserProfit || 0)}
Full results:
${game.results.map(r => `  ${r.rank}. ${r.name}: ${r.profit >= 0 ? '+' : ''}₪${cleanNumber(r.profit)} (${r.rebuys} buy-ins)`).join('\n')}
`).join('\n')}

=== PLAYER DETAILS ===
${leaderboard.map(p => `
${p.name}:
- Total Profit: ${p.totalProfit >= 0 ? '+' : ''}₪${cleanNumber(p.totalProfit)}
- Games Played: ${p.gamesPlayed}
- Wins: ${p.winCount} | Losses: ${p.lossCount} | Win Rate: ${p.winPercentage.toFixed(1)}%
- Average per game: ${p.avgProfit >= 0 ? '+' : ''}₪${cleanNumber(p.avgProfit)}
- Best game: +₪${cleanNumber(p.biggestWin)}
- Worst game: ₪${cleanNumber(p.biggestLoss)}
- Current streak: ${p.currentStreak > 0 ? `${p.currentStreak} wins 🔥` : p.currentStreak < 0 ? `${Math.abs(p.currentStreak)} losses ❄️` : 'None'}
`).join('\n')}
`;
};

/**
 * Process question with AI
 */
export const processQuestion = async (question: string): Promise<{ answer: string; source: 'local' | 'ai' }> => {
  const apiKey = getGeminiApiKey();
  
  // If no API key, provide helpful message
  if (!apiKey) {
    return {
      answer: 'כדי להשתמש בצ\'אט, צריך להגדיר מפתח API של Gemini בהגדרות.\n\nלך להגדרות → API → הזן את המפתח.\n\nאפשר לקבל מפתח חינמי מ-Google AI Studio.',
      source: 'local'
    };
  }

  try {
    const dataContext = buildDataContext();
    
    const systemPrompt = `You are a helpful poker statistics assistant for a Hebrew-speaking poker group. 
You have access to complete data about all their games and players.

IMPORTANT RULES:
1. Answer in Hebrew (עברית) - this is critical!
2. Be conversational, friendly, and sometimes add a bit of humor
3. Use the data provided to give accurate, specific answers
4. Format numbers with ₪ for money and use + for profits, - for losses
5. If asked about something not in the data, say you don't have that information
6. Keep answers concise but complete - 2-4 sentences usually
7. Use emojis sparingly to add personality (🏆 for winner, 😢 for losses, 🔥 for streaks, etc.)
8. When comparing players, use the ranking data
9. For "who won the last game" - look at Game 1 in the recent games list
10. For "where was the last game" - use the location from Game 1
11. For "who finished last" - look at the last place in the game results
12. You can answer ANY question about the data - be creative in finding the answer
13. If someone asks in English, still answer in Hebrew

The user asked: "${question}"

Here is all the data you need to answer:

${dataContext}

Now answer the question in Hebrew:`;

    // Try to use Gemini API
    const models = [
      'gemini-2.0-flash',
      'gemini-1.5-flash',
      'gemini-1.5-pro',
      'gemini-pro',
    ];

    for (const model of models) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: systemPrompt }] }],
            generationConfig: {
              temperature: 0.7,
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

        if (response.ok) {
          const data = await response.json();
          const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) {
            return { answer: text.trim(), source: 'ai' };
          }
        }
        
        // If response not ok, try next model
        const errorData = await response.json().catch(() => ({}));
        console.log(`Model ${model} failed:`, errorData);
      } catch (e) {
        console.log(`Model ${model} error:`, e);
        continue;
      }
    }

    // All models failed
    return {
      answer: 'מצטער, לא הצלחתי להתחבר ל-AI. נסה שוב בעוד כמה שניות.',
      source: 'local'
    };

  } catch (error) {
    console.error('AI processing failed:', error);
    return {
      answer: 'מצטער, משהו השתבש. נסה שוב.',
      source: 'local'
    };
  }
};

/**
 * Check if AI is available
 */
export const isAIAvailable = (): boolean => {
  return !!getGeminiApiKey();
};

/**
 * Get suggested questions based on data
 */
export const getSuggestedQuestions = (): string[] => {
  const games = getAllGames().filter(g => g.status === 'completed');
  const players = getAllPlayers();
  
  const questions: string[] = [];
  
  // Always include these basic questions
  questions.push('מי המוביל בטבלה?');
  
  if (games.length > 0) {
    questions.push('איפה היה המשחק האחרון?');
    questions.push('מי סיים אחרון במשחק האחרון?');
  }
  
  // Add some variety based on data
  if (players.length > 3) {
    const randomPlayer = players[Math.floor(Math.random() * players.length)];
    questions.push(`כמה ${randomPlayer.name} הרוויח בסך הכל?`);
  }
  
  questions.push('מי בסדרת הפסדים?');
  questions.push('מה השיא של נצחון בודד?');
  
  // Return 4 random questions
  return questions.sort(() => Math.random() - 0.5).slice(0, 4);
};
