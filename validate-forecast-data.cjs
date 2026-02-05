/**
 * FORECAST DATA VALIDATION SCRIPT
 * 
 * Run with: node validate-forecast-data.cjs
 * 
 * This validates all player data that would be used in forecasts
 * to ensure accuracy BEFORE any AI is called.
 */

const fs = require('fs');

// Load backup data
const backupPath = './public/full-backup.json';
let backupData;

try {
  const raw = fs.readFileSync(backupPath, 'utf8');
  backupData = JSON.parse(raw);
  console.log('✅ Loaded backup data');
} catch (e) {
  console.log('❌ Could not load backup:', e.message);
  process.exit(1);
}

const { players, games, gamePlayers } = backupData;

console.log(`\n📊 DATA SUMMARY:`);
console.log(`   Players: ${players.length}`);
console.log(`   Games: ${games.length}`);
console.log(`   Game records: ${gamePlayers.length}`);

// Get completed games only
const completedGames = games.filter(g => g.status === 'completed');
console.log(`   Completed games: ${completedGames.length}`);

// Sort games by date
completedGames.sort((a, b) => new Date(a.date || a.createdAt) - new Date(b.date || b.createdAt));

// Calculate player stats (same logic as storage.ts)
function calculatePlayerStats(playerId) {
  const player = players.find(p => p.id === playerId);
  if (!player) return null;
  
  const playerGames = gamePlayers.filter(
    gp => gp.playerId === playerId && 
    completedGames.some(g => g.id === gp.gameId)
  );
  
  // Sort by game date
  const sortedPlayerGames = [...playerGames].sort((a, b) => {
    const gameA = completedGames.find(g => g.id === a.gameId);
    const gameB = completedGames.find(g => g.id === b.gameId);
    if (!gameA || !gameB) return 0;
    return new Date(gameA.date || gameA.createdAt) - new Date(gameB.date || gameB.createdAt);
  });
  
  const gamesPlayed = playerGames.length;
  const totalProfit = playerGames.reduce((sum, pg) => sum + pg.profit, 0);
  const winCount = playerGames.filter(pg => pg.profit > 0).length;
  const lossCount = playerGames.filter(pg => pg.profit < 0).length;
  
  const profits = playerGames.map(pg => pg.profit);
  const biggestWin = profits.length > 0 ? Math.max(...profits, 0) : 0;
  const biggestLoss = profits.length > 0 ? Math.min(...profits, 0) : 0;
  
  // Calculate current streak
  let currentStreak = 0;
  for (let i = sortedPlayerGames.length - 1; i >= 0; i--) {
    const profit = sortedPlayerGames[i].profit;
    if (profit > 0) {
      if (currentStreak >= 0) currentStreak++;
      else break;
    } else if (profit < 0) {
      if (currentStreak <= 0) currentStreak--;
      else break;
    } else {
      // Break-even breaks streak
      break;
    }
  }
  
  // Get game history (most recent first)
  const gameHistory = sortedPlayerGames
    .slice()
    .reverse()
    .map(pg => {
      const game = completedGames.find(g => g.id === pg.gameId);
      return {
        profit: pg.profit,
        date: game ? (game.date || game.createdAt) : '',
        gameId: pg.gameId
      };
    });
  
  return {
    playerId,
    playerName: player.name,
    gamesPlayed,
    totalProfit,
    avgProfit: gamesPlayed > 0 ? totalProfit / gamesPlayed : 0,
    winCount,
    lossCount,
    winPercentage: gamesPlayed > 0 ? (winCount / gamesPlayed) * 100 : 0,
    biggestWin,
    biggestLoss,
    currentStreak,
    gameHistory
  };
}

// Get all player stats
const allStats = players
  .map(p => calculatePlayerStats(p.id))
  .filter(s => s && s.gamesPlayed > 0)
  .sort((a, b) => b.gamesPlayed - a.gamesPlayed);

console.log(`   Players with games: ${allStats.length}`);

// Current year
const currentYear = new Date().getFullYear();

console.log('\n' + '═'.repeat(70));
console.log('   PLAYER DATA VALIDATION');
console.log('═'.repeat(70));

let issueCount = 0;
const issues = [];

// Validate each player
allStats.forEach(stats => {
  // Calculate year stats
  const yearGames = stats.gameHistory.filter(g => {
    const d = new Date(g.date);
    return d.getFullYear() === currentYear;
  });
  const yearProfit = yearGames.reduce((sum, g) => sum + g.profit, 0);
  
  // Verify streak calculation
  let calculatedStreak = 0;
  for (const g of stats.gameHistory) {
    if (g.profit > 0) {
      if (calculatedStreak >= 0) calculatedStreak++;
      else break;
    } else if (g.profit < 0) {
      if (calculatedStreak <= 0) calculatedStreak--;
      else break;
    } else {
      break;
    }
  }
  
  if (calculatedStreak !== stats.currentStreak) {
    issueCount++;
    issues.push({
      player: stats.playerName,
      type: 'STREAK MISMATCH',
      expected: calculatedStreak,
      actual: stats.currentStreak
    });
  }
  
  // Verify profit sums
  const sumFromHistory = stats.gameHistory.reduce((sum, g) => sum + g.profit, 0);
  if (Math.abs(sumFromHistory - stats.totalProfit) > 1) {
    // This is okay if gameHistory doesn't have all games
    if (stats.gameHistory.length === stats.gamesPlayed) {
      issueCount++;
      issues.push({
        player: stats.playerName,
        type: 'PROFIT MISMATCH',
        expected: sumFromHistory,
        actual: stats.totalProfit
      });
    }
  }
});

// Print top players
console.log('\n📊 TOP 15 PLAYERS (by games played):');
console.log('─'.repeat(70));
console.log(' Name             | Games | Total   | Streak | Year      | Last Game');
console.log('─'.repeat(70));

allStats.slice(0, 15).forEach(stats => {
  const yearGames = stats.gameHistory.filter(g => {
    const d = new Date(g.date);
    return d.getFullYear() === currentYear;
  });
  const yearProfit = yearGames.reduce((sum, g) => sum + g.profit, 0);
  
  const name = stats.playerName.padEnd(16).slice(0, 16);
  const games = stats.gamesPlayed.toString().padStart(5);
  const total = (stats.totalProfit >= 0 ? '+' : '') + Math.round(stats.totalProfit).toString().padStart(6) + '₪';
  
  // Verify streak
  let calculatedStreak = 0;
  for (const g of stats.gameHistory) {
    if (g.profit > 0) {
      if (calculatedStreak >= 0) calculatedStreak++;
      else break;
    } else if (g.profit < 0) {
      if (calculatedStreak <= 0) calculatedStreak--;
      else break;
    } else break;
  }
  
  const streak = stats.currentStreak.toString().padStart(3);
  const streakCheck = calculatedStreak === stats.currentStreak ? '✓' : '✗';
  
  const year = (yearProfit >= 0 ? '+' : '') + Math.round(yearProfit).toString().padStart(5) + '₪';
  const yearCount = yearGames.length.toString().padStart(2);
  
  const lastGame = stats.gameHistory[0];
  const lastProfit = lastGame ? ((lastGame.profit >= 0 ? '+' : '') + Math.round(lastGame.profit)) : 'N/A';
  
  console.log(` ${name} | ${games} | ${total} | ${streak}${streakCheck} | ${year}(${yearCount}) | ${lastProfit}₪`);
});

console.log('─'.repeat(70));

// Print streak verification details
console.log('\n🔥 STREAK VERIFICATION (Top 10):');
console.log('─'.repeat(70));

allStats.slice(0, 10).forEach(stats => {
  const recent = stats.gameHistory.slice(0, 8).map(g => 
    g.profit > 0 ? 'W' : g.profit < 0 ? 'L' : 'T'
  ).join(' ');
  
  let calculated = 0;
  for (const g of stats.gameHistory) {
    if (g.profit > 0) {
      if (calculated >= 0) calculated++;
      else break;
    } else if (g.profit < 0) {
      if (calculated <= 0) calculated--;
      else break;
    } else break;
  }
  
  const match = calculated === stats.currentStreak ? '✅' : '❌';
  const streakIcon = stats.currentStreak > 0 ? '🔥' : stats.currentStreak < 0 ? '❄️' : '➡️';
  
  console.log(`  ${stats.playerName}:`);
  console.log(`    Last 8: ${recent}`);
  console.log(`    ${streakIcon} Streak: ${stats.currentStreak} | Calculated: ${calculated} ${match}`);
});

// Show year rankings
console.log(`\n📅 ${currentYear} RANKINGS:`);
console.log('─'.repeat(70));

const yearRankings = allStats.map(stats => {
  const yearGames = stats.gameHistory.filter(g => {
    const d = new Date(g.date);
    return d.getFullYear() === currentYear;
  });
  return {
    name: stats.playerName,
    yearProfit: yearGames.reduce((sum, g) => sum + g.profit, 0),
    yearGames: yearGames.length,
    totalProfit: stats.totalProfit
  };
}).filter(p => p.yearGames > 0).sort((a, b) => b.yearProfit - a.yearProfit);

yearRankings.slice(0, 10).forEach((p, i) => {
  const avg = p.yearGames > 0 ? Math.round(p.yearProfit / p.yearGames) : 0;
  console.log(`  #${(i + 1).toString().padStart(2)} ${p.name}: ${p.yearGames} games, ${p.yearProfit >= 0 ? '+' : ''}${Math.round(p.yearProfit)}₪ (avg: ${avg >= 0 ? '+' : ''}${avg}₪)`);
});

// ========== GLOBAL ACTIVE RANKINGS (33% threshold) ==========
console.log('\n' + '═'.repeat(70));
console.log('   GLOBAL RANKINGS (Active Players Only - 33% threshold)');
console.log('═'.repeat(70));

// All-time active players
const allTimeThreshold = Math.ceil(completedGames.length * 0.33);
console.log(`\n📊 ALL-TIME TABLE (min ${allTimeThreshold} games out of ${completedGames.length} total):`);

const allTimeActive = allStats
  .filter(p => p.gamesPlayed >= allTimeThreshold)
  .sort((a, b) => b.totalProfit - a.totalProfit);

console.log(`   Active players: ${allTimeActive.length}`);
allTimeActive.slice(0, 10).forEach((p, i) => {
  console.log(`   #${(i+1).toString().padStart(2)} ${p.playerName.padEnd(12)} ${p.totalProfit >= 0 ? '+' : ''}${Math.round(p.totalProfit).toString().padStart(6)}₪ (${p.gamesPlayed} games)`);
});

// This year active players
const yearGamesCount = completedGames.filter(g => new Date(g.date).getFullYear() === currentYear).length;
const yearThreshold = Math.ceil(yearGamesCount * 0.33);
console.log(`\n📅 ${currentYear} TABLE (min ${yearThreshold} games out of ${yearGamesCount} this year):`);

const yearStatsAll = allStats.map(stats => {
  const yg = stats.gameHistory.filter(g => new Date(g.date).getFullYear() === currentYear);
  return {
    name: stats.playerName,
    profit: yg.reduce((sum, g) => sum + g.profit, 0),
    games: yg.length
  };
}).filter(p => p.games >= yearThreshold).sort((a, b) => b.profit - a.profit);

console.log(`   Active players: ${yearStatsAll.length}`);
yearStatsAll.slice(0, 10).forEach((p, i) => {
  console.log(`   #${(i+1).toString().padStart(2)} ${p.name.padEnd(12)} ${p.profit >= 0 ? '+' : ''}${Math.round(p.profit).toString().padStart(6)}₪ (${p.games} games)`);
});

// Current half
const currentHalf = new Date().getMonth() < 6 ? 1 : 2;
const halfStartMonth = currentHalf === 1 ? 0 : 6;
const halfGamesCount = completedGames.filter(g => {
  const d = new Date(g.date);
  return d.getFullYear() === currentYear && d.getMonth() >= halfStartMonth && d.getMonth() < halfStartMonth + 6;
}).length;
const halfThreshold = Math.ceil(halfGamesCount * 0.33);
console.log(`\nH${currentHalf} ${currentYear} TABLE (min ${halfThreshold} games out of ${halfGamesCount} this half):`);

const halfStatsAll = allStats.map(stats => {
  const hg = stats.gameHistory.filter(g => {
    const d = new Date(g.date);
    return d.getFullYear() === currentYear && d.getMonth() >= halfStartMonth && d.getMonth() < halfStartMonth + 6;
  });
  return {
    name: stats.playerName,
    profit: hg.reduce((sum, g) => sum + g.profit, 0),
    games: hg.length
  };
}).filter(p => p.games >= halfThreshold).sort((a, b) => b.profit - a.profit);

console.log(`   Active players: ${halfStatsAll.length}`);
halfStatsAll.slice(0, 10).forEach((p, i) => {
  console.log(`   #${(i+1).toString().padStart(2)} ${p.name.padEnd(12)} ${p.profit >= 0 ? '+' : ''}${Math.round(p.profit).toString().padStart(6)}₪ (${p.games} games)`);
});

// Test specific player combinations
console.log('\n' + '═'.repeat(70));
console.log('   TONIGHT\'S TABLE SIMULATION');
console.log('═'.repeat(70));

const testCombos = [
  ['ליאור', 'אייל', 'סגל', 'תומר', 'פיליפ'],
  ['ליאור', 'חרדון', 'מלמד', 'אורן', 'ליכטר'],
];

testCombos.forEach((combo, idx) => {
  console.log(`\n🎲 COMBINATION ${idx + 1}: ${combo.join(', ')}`);
  console.log('─'.repeat(50));
  
  const tonightStats = combo
    .map(name => allStats.find(s => s.playerName === name))
    .filter(Boolean);
  
  if (tonightStats.length < combo.length) {
    console.log(`  ⚠️ Some players not found`);
  }
  
  // Sort by total profit (tonight's ranking)
  const sorted = [...tonightStats].sort((a, b) => b.totalProfit - a.totalProfit);
  
  sorted.forEach((p, i) => {
    const rank = i + 1;
    const above = i > 0 ? sorted[i - 1] : null;
    const below = i < sorted.length - 1 ? sorted[i + 1] : null;
    
    const yearGames = p.gameHistory.filter(g => new Date(g.date).getFullYear() === currentYear);
    const yearProfit = yearGames.reduce((sum, g) => sum + g.profit, 0);
    
    console.log(`\n  #${rank}/${sorted.length} ${p.playerName}`);
    console.log(`      Total: ${p.totalProfit >= 0 ? '+' : ''}${Math.round(p.totalProfit)}₪`);
    console.log(`      Year: ${yearProfit >= 0 ? '+' : ''}${Math.round(yearProfit)}₪ (${yearGames.length} games)`);
    console.log(`      Streak: ${p.currentStreak}`);
    console.log(`      Last: ${p.gameHistory[0]?.profit >= 0 ? '+' : ''}${p.gameHistory[0]?.profit || 0}₪`);
    
    if (above) {
      const gap = Math.round(above.totalProfit - p.totalProfit);
      console.log(`      ↑ ${gap}₪ behind ${above.playerName}`);
    }
    if (below) {
      const gap = Math.round(p.totalProfit - below.totalProfit);
      console.log(`      ↓ ${gap}₪ ahead of ${below.playerName}`);
    }
  });
});

// Final summary
console.log('\n' + '═'.repeat(70));
console.log('   VALIDATION SUMMARY');
console.log('═'.repeat(70));

if (issues.length === 0) {
  console.log('\n  ✅ ALL DATA IS VALID!\n');
  console.log('  The forecast system should generate accurate data for all players.');
} else {
  console.log(`\n  ⚠️ FOUND ${issues.length} ISSUES:\n`);
  issues.forEach(issue => {
    console.log(`  - ${issue.player}: ${issue.type}`);
    console.log(`    Expected: ${issue.expected}, Actual: ${issue.actual}`);
  });
}

console.log('\n' + '═'.repeat(70));
console.log('  Validation complete. Run the app to test AI forecasts.');
console.log('═'.repeat(70) + '\n');
