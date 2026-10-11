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

export interface ComboNearMatch {
  corePlayerNames: string[];
  differingPlayerNames: string[];
  gamesPlayedTogether: number;
  coreCount: number;
  gamesThisYear: number;
  gamesThisHalf: number;
  lastPlayedDateStr?: string;
  monthsSinceLastPlayed?: number;
}

export interface ComboHistory {
  isFirstTime: boolean;
  nearCombo?: ComboNearMatch;
  previousGames: ComboGameResult[];
  playerStats: ComboPlayerStat[];
  totalGamesWithCombo: number;
  gamesThisYear: number;
  gamesThisHalf: number;
  lastPlayedDateStr?: string;
  monthsSinceLastPlayed?: number;
  playerCount: number;
  playerNames: string[];
  uniqueWinners: string[];
  repeatWinners: { name: string; count: number }[];
  repeatLosers: { name: string; count: number }[];
  totalMoneyMoved: number;
  avgMoneyPerGame: number;
  spanDays: number;
}

export function formatComboDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('he-IL', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

export function formatMonthsAgo(months: number): string {
  if (months === 0) return 'החודש';
  if (months === 1) return 'לפני כחודש';
  if (months === 2) return 'לפני כחודשיים';
  if (months >= 24) return 'לפני כשנתיים';
  return `לפני כ-${months} חודשים`;
}

function computeTimeBreakdown(games: { date: string }[], refDate: Date = new Date()) {
  if (!games || games.length === 0) {
    return {
      gamesThisYear: 0,
      gamesThisHalf: 0,
      lastPlayedDateStr: undefined,
      monthsSinceLastPlayed: undefined,
    };
  }

  const sorted = [...games].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const refYear = refDate.getFullYear();
  const refHalf = refDate.getMonth() < 6 ? 1 : 2;

  let gamesThisYear = 0;
  let gamesThisHalf = 0;

  for (const g of sorted) {
    const d = new Date(g.date);
    if (d.getFullYear() === refYear) {
      gamesThisYear++;
      const gHalf = d.getMonth() < 6 ? 1 : 2;
      if (gHalf === refHalf) {
        gamesThisHalf++;
      }
    }
  }

  const lastGame = sorted[sorted.length - 1];
  const lastDate = new Date(lastGame.date);
  const lastPlayedDateStr = formatComboDate(lastGame.date);
  const monthsSinceLastPlayed = Math.max(
    0,
    (refDate.getFullYear() - lastDate.getFullYear()) * 12 + (refDate.getMonth() - lastDate.getMonth())
  );

  return {
    gamesThisYear,
    gamesThisHalf,
    lastPlayedDateStr,
    monthsSinceLastPlayed,
  };
}

export function formatTimeAttribution(
  allTimeCount: number,
  gamesThisYear: number,
  gamesThisHalf: number,
  lastPlayedDateStr?: string,
  monthsSinceLastPlayed?: number,
  refYear: number = new Date().getFullYear()
): string {
  if (allTimeCount <= 0) return '';
  if (allTimeCount === 1 && lastPlayedDateStr) {
    const ago = monthsSinceLastPlayed !== undefined ? ` (${formatMonthsAgo(monthsSinceLastPlayed)})` : '';
    return `פעם אחת בלבד בעבר (בתאריך ${lastPlayedDateStr}${ago})`;
  }

  let detail = '';
  if (gamesThisYear === 0) {
    const lastInfo = lastPlayedDateStr
      ? `לא נפגשו יחד ב-${refYear}! פעם אחרונה שישבו יחד: ${lastPlayedDateStr}${monthsSinceLastPlayed !== undefined ? ` (${formatMonthsAgo(monthsSinceLastPlayed)})` : ''}`
      : `אף לא פעם אחת ב-${refYear}!`;
    detail = `בכל הזמנים (${lastInfo})`;
  } else {
    const halfInfo = gamesThisHalf > 0 ? `, מתוכם ${gamesThisHalf} בחציון הנוכחי` : '';
    const lastInfo = lastPlayedDateStr ? `; פעם אחרונה: ${lastPlayedDateStr}` : '';
    detail = `בכל הזמנים (מתוכם ${gamesThisYear} ב-${refYear}${halfInfo}${lastInfo})`;
  }

  return `${allTimeCount} פעמים ${detail}`;
}

/**
 * Get combo history for a set of player IDs.
 * Looks at all completed games and finds those with the exact same player set.
 * @param currentPlayerIds - The player IDs in the current game
 * @param excludeGameId - Optional game ID to exclude (the current game)
 * @param referenceDate - Optional reference date for time attribution (defaults to current date or excluded game date)
 */
export function getComboHistory(
  currentPlayerIds: string[],
  excludeGameId?: string,
  referenceDate?: string | Date
): ComboHistory {
  const sortedIds = [...currentPlayerIds].sort();
  const comboKey = sortedIds.join('|');

  const allGames = getAllGames().filter(g => g.status === 'completed' && g.id !== excludeGameId);
  const allGP = getAllGamePlayers();
  const allPlayers = getAllPlayers();

  const excludedGame = excludeGameId ? allGames.find(g => g.id === excludeGameId) : undefined;
  const refDate = referenceDate ? new Date(referenceDate) : (excludedGame?.date ? new Date(excludedGame.date) : new Date());

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
    let nearCombo: ComboNearMatch | undefined = undefined;
    const N = sortedIds.length;
    const gamePlayerSets: { game: Game; pids: Set<string> }[] = [];
    for (const game of allGames) {
      const gps = gpByGame[game.id];
      if (gps) {
        gamePlayerSets.push({ game, pids: new Set(gps.map(gp => gp.playerId)) });
      }
    }

    if (N >= 5) {
      let bestNMinus1: { coreIds: string[]; diffId: string; count: number; games: Game[] } | null = null;
      let maxNMinus1Count = 0;
      for (let i = 0; i < N; i++) {
        const subset = sortedIds.filter((_, idx) => idx !== i);
        const matchedGames: Game[] = [];
        for (const item of gamePlayerSets) {
          if (subset.every(id => item.pids.has(id))) matchedGames.push(item.game);
        }
        if (matchedGames.length > maxNMinus1Count) {
          maxNMinus1Count = matchedGames.length;
          bestNMinus1 = { coreIds: subset, diffId: sortedIds[i], count: matchedGames.length, games: matchedGames };
        }
      }

      if (bestNMinus1 && bestNMinus1.count >= 2) {
        const timeBd = computeTimeBreakdown(bestNMinus1.games, refDate);
        nearCombo = {
          corePlayerNames: bestNMinus1.coreIds.map(id => playerMap[id] || id),
          differingPlayerNames: [playerMap[bestNMinus1.diffId] || bestNMinus1.diffId],
          gamesPlayedTogether: bestNMinus1.count,
          coreCount: N - 1,
          gamesThisYear: timeBd.gamesThisYear,
          gamesThisHalf: timeBd.gamesThisHalf,
          lastPlayedDateStr: timeBd.lastPlayedDateStr,
          monthsSinceLastPlayed: timeBd.monthsSinceLastPlayed,
        };
      } else if (N >= 7) {
        let bestNMinus2: { coreIds: string[]; diffIds: string[]; count: number; games: Game[] } | null = null;
        let maxNMinus2Count = 0;
        for (let i = 0; i < N; i++) {
          for (let j = i + 1; j < N; j++) {
            const subset = sortedIds.filter((_, idx) => idx !== i && idx !== j);
            const matchedGames: Game[] = [];
            for (const item of gamePlayerSets) {
              if (subset.every(id => item.pids.has(id))) matchedGames.push(item.game);
            }
            if (matchedGames.length > maxNMinus2Count) {
              maxNMinus2Count = matchedGames.length;
              bestNMinus2 = { coreIds: subset, diffIds: [sortedIds[i], sortedIds[j]], count: matchedGames.length, games: matchedGames };
            }
          }
        }
        if (bestNMinus2 && bestNMinus2.count >= 4) {
          const timeBd = computeTimeBreakdown(bestNMinus2.games, refDate);
          nearCombo = {
            corePlayerNames: bestNMinus2.coreIds.map(id => playerMap[id] || id),
            differingPlayerNames: bestNMinus2.diffIds.map(id => playerMap[id] || id),
            gamesPlayedTogether: bestNMinus2.count,
            coreCount: N - 2,
            gamesThisYear: timeBd.gamesThisYear,
            gamesThisHalf: timeBd.gamesThisHalf,
            lastPlayedDateStr: timeBd.lastPlayedDateStr,
            monthsSinceLastPlayed: timeBd.monthsSinceLastPlayed,
          };
        }
      }
    }

    return {
      isFirstTime: true,
      nearCombo,
      previousGames: [],
      playerStats: [],
      totalGamesWithCombo: 0,
      gamesThisYear: 0,
      gamesThisHalf: 0,
      lastPlayedDateStr: undefined,
      monthsSinceLastPlayed: undefined,
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
  const exactTimeBd = computeTimeBreakdown(matchingGames.map(m => m.game), refDate);

  return {
    isFirstTime: false,
    previousGames,
    playerStats,
    totalGamesWithCombo: numGames,
    gamesThisYear: exactTimeBd.gamesThisYear,
    gamesThisHalf: exactTimeBd.gamesThisHalf,
    lastPlayedDateStr: exactTimeBd.lastPlayedDateStr,
    monthsSinceLastPlayed: exactTimeBd.monthsSinceLastPlayed,
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
    if (combo.nearCombo) {
      const nc = combo.nearCombo;
      const coreNames = nc.corePlayerNames.join(', ');
      const diffNames = nc.differingPlayerNames.join(', ');
      const timeStr = formatTimeAttribution(
        nc.gamesPlayedTogether,
        nc.gamesThisYear,
        nc.gamesThisHalf,
        nc.lastPlayedDateStr,
        nc.monthsSinceLastPlayed
      );
      if (nc.coreCount === combo.playerCount - 1) {
        return `🔄 גרעין שולחן ותיק (${nc.coreCount} מתוך ${combo.playerCount} שחקנים): ${coreNames} שיחקו יחד ${timeStr}, כשאליהם מצטרף הערב ${diffNames}. שימו לב: בדיוק ${combo.playerCount} השחקנים האלה מעולם לא ישבו יחד בהרכב מלא, אך השלד המרכזי מנוסה מאוד.`;
      } else {
        return `🔄 שלד משותף מנוסה (${nc.coreCount} מתוך ${combo.playerCount} שחקנים): ${coreNames} חלקו ${timeStr}, כשאליהם מצטרפים הערב ${diffNames}. בדיוק ${combo.playerCount} השחקנים האלה מעולם לא ישבו יחד בהרכב מלא.`;
      }
    }
    return `🆕 הרכב חדש באמת: זו הפעם הראשונה שבדיוק ${combo.playerCount} השחקנים האלה משחקים יחד! (${combo.playerNames.join(', ')}) — אין שום גרעין של ${combo.playerCount - 1} שחקנים שנפגש בעבר.`;
  }

  const lines: string[] = [];
  const timeStr = formatTimeAttribution(
    combo.totalGamesWithCombo,
    combo.gamesThisYear,
    combo.gamesThisHalf,
    combo.lastPlayedDateStr,
    combo.monthsSinceLastPlayed
  );
  lines.push(`🔄 הרכב חוזר! בדיוק אותם ${combo.playerCount} שחקנים שיחקו יחד ${timeStr}.`);

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
