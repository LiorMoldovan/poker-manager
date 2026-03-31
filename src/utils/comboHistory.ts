import { getAllGames, getAllGamePlayers, getAllPlayers } from '../database/storage';
import { Game, GamePlayer } from '../types';

export interface ComboPlayerStat {
  playerId: string;
  playerName: string;
  totalProfit: number;
  avgProfit: number;
  wins: number;
  losses: number;
  winRate: number;
  bestResult: number;
  worstResult: number;
  totalRebuys: number;
  avgRebuys: number;
  alwaysWon: boolean;
  alwaysLost: boolean;
}

export interface ComboGameResult {
  gameId: string;
  date: string;
  winnerName: string;
  winnerProfit: number;
  loserName: string;
  loserProfit: number;
  totalRebuys: number;
  results: { playerName: string; profit: number; rebuys: number }[];
}

export interface ComboHistory {
  isFirstTime: boolean;
  previousGames: ComboGameResult[];
  playerStats: ComboPlayerStat[];
  totalGamesWithCombo: number;
  playerCount: number;
  playerNames: string[];
  uniqueWinners: string[];
  repeatWinners: { name: string; count: number }[];
  repeatLosers: { name: string; count: number }[];
  totalMoneyMoved: number;
  avgMoneyPerGame: number;
  spanDays: number;
}

/**
 * Get combo history for a set of player IDs.
 * Looks at all completed games and finds those with the exact same player set.
 * @param currentPlayerIds - The player IDs in the current game
 * @param excludeGameId - Optional game ID to exclude (the current game)
 */
export function getComboHistory(
  currentPlayerIds: string[],
  excludeGameId?: string
): ComboHistory {
  const sortedIds = [...currentPlayerIds].sort();
  const comboKey = sortedIds.join('|');

  const allGames = getAllGames().filter(g => g.status === 'completed' && g.id !== excludeGameId);
  const allGP = getAllGamePlayers();
  const allPlayers = getAllPlayers();

  const playerMap: Record<string, string> = {};
  allPlayers.forEach(p => { playerMap[p.id] = p.name; });

  const gpByGame: Record<string, GamePlayer[]> = {};
  allGP.forEach(gp => {
    if (!gpByGame[gp.gameId]) gpByGame[gp.gameId] = [];
    gpByGame[gp.gameId].push(gp);
  });

  const matchingGames: { game: Game; gamePlayers: GamePlayer[] }[] = [];
  for (const game of allGames) {
    const gps = gpByGame[game.id];
    if (!gps) continue;
    const gamePlayerIds = gps.map(gp => gp.playerId).sort();
    if (gamePlayerIds.join('|') === comboKey) {
      matchingGames.push({ game, gamePlayers: gps });
    }
  }

  const playerNames = sortedIds.map(id => playerMap[id] || id);

  if (matchingGames.length === 0) {
    return {
      isFirstTime: true,
      previousGames: [],
      playerStats: [],
      totalGamesWithCombo: 0,
      playerCount: sortedIds.length,
      playerNames,
      uniqueWinners: [],
      repeatWinners: [],
      repeatLosers: [],
      totalMoneyMoved: 0,
      avgMoneyPerGame: 0,
      spanDays: 0,
    };
  }

  matchingGames.sort((a, b) => new Date(a.game.date).getTime() - new Date(b.game.date).getTime());

  const previousGames: ComboGameResult[] = [];
  const profitByPlayer: Record<string, number[]> = {};
  const rebuysByPlayer: Record<string, number[]> = {};
  const winnerNames: string[] = [];
  const loserNames: string[] = [];
  let totalMoneyMoved = 0;

  for (const { game, gamePlayers: gps } of matchingGames) {
    const sorted = [...gps].sort((a, b) => b.profit - a.profit);
    const winner = sorted[0];
    const loser = sorted[sorted.length - 1];
    const totalRebuys = gps.reduce((s, gp) => s + gp.rebuys, 0);
    const moneyWon = gps.filter(gp => gp.profit > 0).reduce((s, gp) => s + gp.profit, 0);
    totalMoneyMoved += moneyWon;

    winnerNames.push(winner.playerName);
    loserNames.push(loser.playerName);

    previousGames.push({
      gameId: game.id,
      date: game.date,
      winnerName: winner.playerName,
      winnerProfit: winner.profit,
      loserName: loser.playerName,
      loserProfit: loser.profit,
      totalRebuys,
      results: sorted.map(gp => ({
        playerName: gp.playerName,
        profit: gp.profit,
        rebuys: gp.rebuys,
      })),
    });

    for (const gp of gps) {
      if (!profitByPlayer[gp.playerName]) profitByPlayer[gp.playerName] = [];
      if (!rebuysByPlayer[gp.playerName]) rebuysByPlayer[gp.playerName] = [];
      profitByPlayer[gp.playerName].push(gp.profit);
      rebuysByPlayer[gp.playerName].push(gp.rebuys);
    }
  }

  const numGames = matchingGames.length;
  const playerStats: ComboPlayerStat[] = Object.entries(profitByPlayer)
    .map(([name, profits]) => {
      const rebuys = rebuysByPlayer[name] || [];
      const totalProfit = profits.reduce((s, p) => s + p, 0);
      const totalRebuys = rebuys.reduce((s, r) => s + r, 0);
      const wins = profits.filter(p => p > 0).length;
      const losses = profits.filter(p => p < 0).length;
      return {
        playerId: sortedIds.find(id => playerMap[id] === name) || '',
        playerName: name,
        totalProfit,
        avgProfit: totalProfit / numGames,
        wins,
        losses,
        winRate: (wins / numGames) * 100,
        bestResult: Math.max(...profits),
        worstResult: Math.min(...profits),
        totalRebuys,
        avgRebuys: totalRebuys / numGames,
        alwaysWon: profits.every(p => p > 0),
        alwaysLost: profits.every(p => p < 0),
      };
    })
    .sort((a, b) => b.totalProfit - a.totalProfit);

  const uniqueWinners = [...new Set(winnerNames)];

  const winnerCounts: Record<string, number> = {};
  winnerNames.forEach(w => { winnerCounts[w] = (winnerCounts[w] || 0) + 1; });
  const repeatWinners = Object.entries(winnerCounts)
    .filter(([, c]) => c > 1)
    .map(([name, count]) => ({ name, count }));

  const loserCounts: Record<string, number> = {};
  loserNames.forEach(l => { loserCounts[l] = (loserCounts[l] || 0) + 1; });
  const repeatLosers = Object.entries(loserCounts)
    .filter(([, c]) => c > 1)
    .map(([name, count]) => ({ name, count }));

  const dates = matchingGames.map(m => new Date(m.game.date).getTime());
  const spanDays = Math.round((Math.max(...dates) - Math.min(...dates)) / (1000 * 60 * 60 * 24));

  return {
    isFirstTime: false,
    previousGames,
    playerStats,
    totalGamesWithCombo: numGames,
    playerCount: sortedIds.length,
    playerNames,
    uniqueWinners,
    repeatWinners,
    repeatLosers,
    totalMoneyMoved,
    avgMoneyPerGame: totalMoneyMoved / numGames,
    spanDays,
  };
}

/**
 * Build a Hebrew text block describing combo history for AI prompts.
 */
export function buildComboHistoryText(combo: ComboHistory): string {
  if (combo.isFirstTime) {
    return `🆕 הרכב חדש: זו הפעם הראשונה שבדיוק ${combo.playerCount} השחקנים האלה משחקים יחד! (${combo.playerNames.join(', ')})`;
  }

  const lines: string[] = [];
  lines.push(`🔄 הרכב חוזר! בדיוק אותם ${combo.playerCount} שחקנים שיחקו יחד ${combo.totalGamesWithCombo} פעמים בעבר.`);

  for (const game of combo.previousGames) {
    const dateStr = formatComboDate(game.date);
    lines.push(`  • ${dateStr}: מנצח ${game.winnerName} (\u200E+${Math.round(game.winnerProfit)}), מפסיד ${game.loserName} (${Math.round(game.loserProfit)})`);
  }

  if (combo.totalGamesWithCombo >= 2) {
    const alwaysWon = combo.playerStats.filter(p => p.alwaysWon);
    const alwaysLost = combo.playerStats.filter(p => p.alwaysLost);

    if (alwaysWon.length > 0) {
      lines.push(`  ⭐ תמיד ברווח בהרכב הזה: ${alwaysWon.map(p => `${p.playerName} (${p.wins}/${combo.totalGamesWithCombo})`).join(', ')}`);
    }
    if (alwaysLost.length > 0) {
      lines.push(`  ⚠️ תמיד בהפסד בהרכב הזה: ${alwaysLost.map(p => p.playerName).join(', ')}`);
    }
  }

  const topPlayer = combo.playerStats[0];
  const bottomPlayer = combo.playerStats[combo.playerStats.length - 1];
  lines.push(`  📊 מוביל בהרכב: ${topPlayer.playerName} (סה"כ ${topPlayer.totalProfit >= 0 ? '+' : ''}${Math.round(topPlayer.totalProfit)}, ממוצע ${topPlayer.avgProfit >= 0 ? '+' : ''}${Math.round(topPlayer.avgProfit)})`);
  lines.push(`  📊 בתחתית ההרכב: ${bottomPlayer.playerName} (סה"כ ${bottomPlayer.totalProfit >= 0 ? '+' : ''}${Math.round(bottomPlayer.totalProfit)}, ממוצע ${bottomPlayer.avgProfit >= 0 ? '+' : ''}${Math.round(bottomPlayer.avgProfit)})`);

  if (combo.repeatWinners.length > 0) {
    lines.push(`  👑 ניצחו יותר מפעם: ${combo.repeatWinners.map(w => `${w.name} (${w.count}x)`).join(', ')}`);
  }

  if (combo.uniqueWinners.length === combo.totalGamesWithCombo) {
    lines.push(`  🎲 מנצח אחר בכל משחק!`);
  }

  return lines.join('\n');
}

function formatComboDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('he-IL', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return dateStr;
  }
}
