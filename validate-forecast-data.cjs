/**
 * Comprehensive validation of forecast data passed to AI
 * Tests all calculations: rankings, averages, periods, streaks, trends
 * Run: node validate-forecast-data.cjs
 */

const fs = require('fs');

// Load backup data - try multiple paths
const backupPaths = [
  './public/full-backup.json',
  './localStorage_backup.json',
  './backup.json'
];

let backup = null;
let backupPath = null;

for (const path of backupPaths) {
  if (fs.existsSync(path)) {
    backup = JSON.parse(fs.readFileSync(path, 'utf8'));
    backupPath = path;
    break;
  }
}

if (!backup) {
  console.error('❌ No backup file found. Tried:', backupPaths.join(', '));
  process.exit(1);
}

console.log(`Using backup: ${backupPath}`);
const games = backup.games || [];
const allPlayers = backup.players || [];
const gamePlayers = backup.gamePlayers || []; // Separate array for player participation

console.log('='.repeat(70));
console.log('FORECAST DATA VALIDATION TEST');
console.log('='.repeat(70));
console.log(`Total games: ${games.length}`);
console.log(`Total players: ${allPlayers.length}`);
console.log('');

// ============ HELPER FUNCTIONS (defined first) ============

// Helper: Parse date (handles DD/MM/YYYY, YYYY-MM-DD, and ISO formats)
function parseGameDate(dateStr) {
  if (!dateStr) return new Date(0);
  
  // Try DD/MM/YYYY format first
  if (dateStr.includes('/')) {
    const [day, month, year] = dateStr.split('/').map(Number);
    return new Date(year, month - 1, day);
  }
  
  // Try ISO format (contains T)
  if (dateStr.includes('T')) {
    return new Date(dateStr);
  }
  
  // Try YYYY-MM-DD format
  if (dateStr.includes('-')) {
    const parts = dateStr.split('-').map(Number);
    if (parts.length === 3) {
      const [year, month, day] = parts;
      return new Date(year, month - 1, day);
    }
  }
  
  return new Date(dateStr);
}

// Get half-year games for a player
function getHalfGames(player, year, half) {
  const startMonth = half === 1 ? 0 : 6;
  const endMonth = half === 1 ? 5 : 11;
  return player.gameHistory.filter(g => {
    const d = parseGameDate(g.date);
    return d.getFullYear() === year && d.getMonth() >= startMonth && d.getMonth() <= endMonth;
  });
}

// Get year games for a player
function getYearGames(player, year) {
  return player.gameHistory.filter(g => {
    const d = parseGameDate(g.date);
    return d.getFullYear() === year;
  });
}

// Build player stats from games (like the app does)
function buildPlayerStats() {
  const playerStats = new Map();
  
  // Initialize all players
  allPlayers.forEach(p => {
    playerStats.set(p.name, {
      name: p.name,
      isFemale: p.isFemale || false,
      gamesPlayed: 0,
      totalProfit: 0,
      gameHistory: [],
      currentStreak: 0,
    });
  });
  
  // Sort games by date (newest first)
  const sortedGames = [...games].sort((a, b) => {
    const dateA = parseGameDate(a.date);
    const dateB = parseGameDate(b.date);
    return dateB.getTime() - dateA.getTime();
  });
  
  // Create a map of gameId -> game for quick lookup
  const gameMap = new Map();
  sortedGames.forEach(game => gameMap.set(game.id, game));
  
  // Process gamePlayers (separate array structure)
  gamePlayers.forEach(gp => {
    const game = gameMap.get(gp.gameId);
    if (!game) return;
    
    const playerName = gp.playerName || gp.name;
    let stats = playerStats.get(playerName);
    
    // Create stats for player if not in allPlayers
    if (!stats) {
      stats = {
        name: playerName,
        isFemale: false,
        gamesPlayed: 0,
        totalProfit: 0,
        gameHistory: [],
        currentStreak: 0,
      };
      playerStats.set(playerName, stats);
    }
    
    stats.gamesPlayed++;
    stats.totalProfit += gp.profit || 0;
    stats.gameHistory.push({
      gameId: game.id,
      date: game.date,
      profit: gp.profit || 0,
    });
  });
  
  // Sort game histories by date (newest first)
  playerStats.forEach(stats => {
    stats.gameHistory.sort((a, b) => {
      return parseGameDate(b.date).getTime() - parseGameDate(a.date).getTime();
    });
  });
  
  // Calculate streaks and averages
  playerStats.forEach(stats => {
    stats.avgProfit = stats.gamesPlayed > 0 ? stats.totalProfit / stats.gamesPlayed : 0;
    
    // Calculate streak
    let streak = 0;
    for (const game of stats.gameHistory) {
      if (game.profit > 0) {
        if (streak >= 0) streak++;
        else break;
      } else if (game.profit < 0) {
        if (streak <= 0) streak--;
        else break;
      } else {
        break; // Break-even breaks streak
      }
    }
    stats.currentStreak = streak;
  });
  
  return playerStats;
}

// Find the most recent period with data
function findLatestPeriodWithData(playerStats) {
  const allDates = [];
  playerStats.forEach(p => {
    p.gameHistory.forEach(g => {
      const d = parseGameDate(g.date);
      if (d.getFullYear() > 2000) { // Valid date
        allDates.push(d);
      }
    });
  });
  
  console.log(`Total game dates found: ${allDates.length}`);
  
  if (allDates.length === 0) return null;
  
  allDates.sort((a, b) => b.getTime() - a.getTime());
  const latestDate = allDates[0];
  console.log(`Latest game date: ${latestDate.toISOString()}`);
  
  return {
    year: latestDate.getFullYear(),
    half: latestDate.getMonth() < 6 ? 1 : 2
  };
}

// ============ MAIN EXECUTION ============

// Build player stats
const playerStats = buildPlayerStats();
const latestPeriod = findLatestPeriodWithData(playerStats);

// Current period info - use latest period with data if no current data
const now = new Date();
let currentYear = now.getFullYear();
let currentMonth = now.getMonth();
let currentHalf = currentMonth < 6 ? 1 : 2;

// Check if we have data in current period, if not use latest
const currentPeriodHasData = Array.from(playerStats.values()).some(p => 
  getHalfGames(p, currentYear, currentHalf).length > 0
);

console.log(`Data in H${currentHalf} ${currentYear}: ${currentPeriodHasData ? 'YES' : 'NO'}`);
if (latestPeriod) {
  console.log(`Latest period with data: H${latestPeriod.half} ${latestPeriod.year}`);
}

if (!currentPeriodHasData && latestPeriod) {
  console.log(`\n⚠️ No data in current period (H${currentHalf} ${currentYear}), switching to H${latestPeriod.half} ${latestPeriod.year}`);
  currentYear = latestPeriod.year;
  currentHalf = latestPeriod.half;
}

const currentPeriodLabel = `H${currentHalf} ${currentYear}`;

// Previous period
function getPreviousPeriod() {
  if (currentHalf === 1) {
    return { year: currentYear - 1, half: 2, label: `H2 ${currentYear - 1}` };
  } else {
    return { year: currentYear, half: 1, label: `H1 ${currentYear}` };
  }
}
const prevPeriod = getPreviousPeriod();

console.log(`Current date: ${now.toISOString().split('T')[0]}`);
console.log(`Testing period: ${currentPeriodLabel}`);
console.log(`Previous period: ${prevPeriod.label}`);
console.log('');

let errors = [];
let warnings = [];

// ============ TEST 1: PERIOD DATA ACCURACY ============
console.log('='.repeat(70));
console.log('TEST 1: PERIOD DATA ACCURACY');
console.log('='.repeat(70));
console.log('');

playerStats.forEach((p, name) => {
  if (p.gamesPlayed === 0) return;
  
  const currentHalfGames = getHalfGames(p, currentYear, currentHalf);
  const prevHalfGames = getHalfGames(p, prevPeriod.year, prevPeriod.half);
  const yearGames = getYearGames(p, currentYear);
  
  // Calculate averages
  const currentHalfAvg = currentHalfGames.length > 0 
    ? currentHalfGames.reduce((sum, g) => sum + g.profit, 0) / currentHalfGames.length 
    : null;
  const prevHalfAvg = prevHalfGames.length > 0 
    ? prevHalfGames.reduce((sum, g) => sum + g.profit, 0) / prevHalfGames.length 
    : null;
  const yearAvg = yearGames.length > 0 
    ? yearGames.reduce((sum, g) => sum + g.profit, 0) / yearGames.length 
    : null;
  const allTimeAvg = p.avgProfit;
  
  // Check for potential confusion scenarios
  if (currentHalfGames.length === 0 && prevHalfGames.length > 0) {
    console.log(`ℹ️  ${name}: No games in ${currentPeriodLabel}, will use ${prevPeriod.label} (${prevHalfGames.length} games, avg: ${Math.round(prevHalfAvg)}₪)`);
  }
  
  // Check if year avg differs significantly from current half avg
  if (currentHalfAvg !== null && yearAvg !== null && Math.abs(currentHalfAvg - yearAvg) > 20) {
    warnings.push(`${name}: Year avg (${Math.round(yearAvg)}₪) differs from ${currentPeriodLabel} avg (${Math.round(currentHalfAvg)}₪) by ${Math.round(Math.abs(currentHalfAvg - yearAvg))}₪`);
  }
  
  // Check for trend changes (sign flip between periods)
  if (currentHalfAvg !== null && allTimeAvg !== 0) {
    if ((currentHalfAvg > 10 && allTimeAvg < -10) || (currentHalfAvg < -10 && allTimeAvg > 10)) {
      console.log(`📈 ${name}: TREND CHANGE - All-time: ${Math.round(allTimeAvg)}₪, ${currentPeriodLabel}: ${Math.round(currentHalfAvg)}₪`);
    }
  }
});

console.log('');

// ============ TEST 2: RANKING CALCULATIONS ============
console.log('='.repeat(70));
console.log('TEST 2: RANKING CALCULATIONS');
console.log('='.repeat(70));

// Calculate rankings for current half
const playersWithHalfStats = Array.from(playerStats.values())
  .filter(p => p.gamesPlayed > 0)
  .map(p => {
    const halfGames = getHalfGames(p, currentYear, currentHalf);
    return {
      ...p,
      halfProfit: halfGames.reduce((sum, g) => sum + g.profit, 0),
      halfGames: halfGames.length,
    };
  })
  .filter(p => p.halfGames > 0); // Only players with games in current half

// Sort by half profit for ranking
const halfRanking = [...playersWithHalfStats].sort((a, b) => b.halfProfit - a.halfProfit);

console.log(`\nGlobal ranking for ${currentPeriodLabel} (${halfRanking.length} players with games):\n`);

halfRanking.forEach((p, i) => {
  const rank = i + 1;
  const avgPerGame = p.halfGames > 0 ? Math.round(p.halfProfit / p.halfGames) : 0;
  console.log(`  #${rank}: ${p.name.padEnd(12)} ${(p.halfProfit >= 0 ? '+' : '') + Math.round(p.halfProfit).toString().padStart(5)}₪ (${p.halfGames} games, avg: ${avgPerGame >= 0 ? '+' : ''}${avgPerGame}₪)`);
});

console.log('');

// Test: Pick some players for "tonight's game" and verify ranking
const tonightPlayers = halfRanking.slice(0, Math.min(7, halfRanking.length));
console.log(`Simulated "tonight's game" with ${tonightPlayers.length} players:`);
console.log(`Players: ${tonightPlayers.map(p => p.name).join(', ')}`);
console.log('');

// Verify each player's rank - check for ranking mismatches
let rankingErrors = [];
tonightPlayers.forEach(p => {
  const globalRank = halfRanking.findIndex(hp => hp.name === p.name) + 1;
  const tonightRank = [...tonightPlayers].sort((a, b) => b.halfProfit - a.halfProfit).findIndex(tp => tp.name === p.name) + 1;
  
  const match = globalRank === tonightRank ? '✅' : '⚠️';
  console.log(`  ${match} ${p.name}: Global #${globalRank}/${halfRanking.length}, Tonight #${tonightRank}/${tonightPlayers.length}`);
  
  if (globalRank !== tonightRank) {
    rankingErrors.push(`${p.name}: Global rank is #${globalRank} but among tonight's players would be #${tonightRank}`);
  }
});

if (rankingErrors.length > 0) {
  console.log('\n⚠️ RANKING MISMATCH WARNING:');
  console.log('   If using "tonight\'s players" ranking instead of global, positions will differ!');
  console.log('   The app should use GLOBAL ranking to match visible table.');
}

console.log('');

// ============ TEST 3: STREAK ACCURACY ============
console.log('='.repeat(70));
console.log('TEST 3: STREAK ACCURACY');
console.log('='.repeat(70));
console.log('');

let streakCount = 0;
playerStats.forEach((p, name) => {
  if (p.gameHistory.length < 2) return;
  
  // Manually calculate streak
  let calculatedStreak = 0;
  for (const game of p.gameHistory) {
    if (game.profit > 0) {
      if (calculatedStreak >= 0) calculatedStreak++;
      else break;
    } else if (game.profit < 0) {
      if (calculatedStreak <= 0) calculatedStreak--;
      else break;
    } else {
      break;
    }
  }
  
  // Check stored vs calculated
  if (p.currentStreak !== calculatedStreak) {
    errors.push(`${name}: Stored streak (${p.currentStreak}) != calculated (${calculatedStreak})`);
  }
  
  if (Math.abs(calculatedStreak) >= 2) {
    streakCount++;
    const lastGames = p.gameHistory.slice(0, Math.min(5, Math.abs(calculatedStreak) + 1)).map(g => 
      `${g.profit >= 0 ? '+' : ''}${Math.round(g.profit)}₪`
    ).join(', ');
    const streakType = calculatedStreak > 0 ? `${calculatedStreak} WINS` : `${Math.abs(calculatedStreak)} LOSSES`;
    console.log(`  ${name.padEnd(12)}: ${streakType.padEnd(10)} | Recent: ${lastGames}`);
  }
});

if (streakCount === 0) {
  console.log('  No significant streaks (2+) found');
}

console.log('');

// ============ TEST 4: SUGGESTION CALCULATION ============
console.log('='.repeat(70));
console.log('TEST 4: SUGGESTION CALCULATION');
console.log('='.repeat(70));
console.log('');

if (tonightPlayers.length > 0) {
  // Calculate suggestions like the app does
  const suggestions = tonightPlayers.map(p => {
    const halfGames = getHalfGames(p, currentYear, currentHalf);
    const periodAvg = halfGames.length > 0 
      ? halfGames.reduce((sum, g) => sum + g.profit, 0) / halfGames.length 
      : 0;
    
    // 70% period, 30% all-time
    let suggested = p.gamesPlayed === 0 ? 0 : 
      halfGames.length >= 2 ? (periodAvg * 0.7) + (p.avgProfit * 0.3) : p.avgProfit;
    
    // Streak modifiers
    if (p.currentStreak >= 4) suggested *= 1.5;
    else if (p.currentStreak >= 3) suggested *= 1.35;
    else if (p.currentStreak >= 2) suggested *= 1.2;
    else if (p.currentStreak <= -4) suggested *= 0.5;
    else if (p.currentStreak <= -3) suggested *= 0.65;
    else if (p.currentStreak <= -2) suggested *= 0.8;
    
    // Amplify
    suggested *= 2.5;
    
    // Minimum threshold
    if (suggested > 0 && suggested < 30) suggested = 30;
    if (suggested < 0 && suggested > -30) suggested = -30;
    
    return { name: p.name, suggested: Math.round(suggested), periodAvg: Math.round(periodAvg), allTimeAvg: Math.round(p.avgProfit), streak: p.currentStreak };
  });

  // Balance to zero
  const totalSuggested = suggestions.reduce((sum, s) => sum + s.suggested, 0);
  const adjustment = totalSuggested / suggestions.length;
  suggestions.forEach(s => {
    s.suggested = Math.round(s.suggested - adjustment);
    if (s.suggested > 0 && s.suggested < 25) s.suggested = 25;
    if (s.suggested < 0 && s.suggested > -25) s.suggested = -25;
  });

  // Re-balance
  const finalTotal = suggestions.reduce((sum, s) => sum + s.suggested, 0);
  if (finalTotal !== 0) {
    const sortedByAbs = [...suggestions].sort((a, b) => Math.abs(a.suggested) - Math.abs(b.suggested));
    sortedByAbs[0].suggested -= finalTotal;
  }

  console.log('Calculated suggestions for tonight\'s players:');
  suggestions.forEach(s => {
    const streakNote = s.streak !== 0 ? ` [streak: ${s.streak > 0 ? '+' : ''}${s.streak}]` : '';
    console.log(`  ${s.name.padEnd(12)}: ${(s.suggested >= 0 ? '+' : '') + s.suggested.toString().padStart(4)}₪  (period: ${s.periodAvg >= 0 ? '+' : ''}${s.periodAvg}₪, all-time: ${s.allTimeAvg >= 0 ? '+' : ''}${s.allTimeAvg}₪)${streakNote}`);
  });

  const sumCheck = suggestions.reduce((sum, s) => sum + s.suggested, 0);
  console.log(`\n  Sum check: ${sumCheck} ${sumCheck === 0 ? '✅ Zero-sum verified' : '❌ NOT ZERO!'}`);
  
  if (sumCheck !== 0) {
    errors.push(`Suggestions don't sum to zero: ${sumCheck}`);
  }
  
  // Check for tiny suggestions
  const tinySuggestions = suggestions.filter(s => Math.abs(s.suggested) < 20);
  if (tinySuggestions.length > 0) {
    warnings.push(`Tiny suggestions (<20₪): ${tinySuggestions.map(s => `${s.name}: ${s.suggested}`).join(', ')}`);
  }
} else {
  console.log('  No players with data in current period to calculate suggestions');
}

console.log('');

// ============ TEST 5: DATA CONSISTENCY ============
console.log('='.repeat(70));
console.log('TEST 5: DATA CONSISTENCY');
console.log('='.repeat(70));
console.log('');

// Check for any data inconsistencies
playerStats.forEach((p, name) => {
  if (p.gamesPlayed === 0) return;
  
  // Check if total profit matches sum of game history
  const calculatedTotal = p.gameHistory.reduce((sum, g) => sum + g.profit, 0);
  if (Math.abs(calculatedTotal - p.totalProfit) > 1) {
    errors.push(`${name}: Total profit mismatch - stored: ${Math.round(p.totalProfit)}, calculated: ${Math.round(calculatedTotal)}`);
  }
  
  // Check if games played matches history length
  if (p.gamesPlayed !== p.gameHistory.length) {
    errors.push(`${name}: Games count mismatch - stored: ${p.gamesPlayed}, history: ${p.gameHistory.length}`);
  }
  
  // Check for duplicate games
  const gameIds = p.gameHistory.map(g => g.gameId);
  const uniqueIds = new Set(gameIds);
  if (gameIds.length !== uniqueIds.size) {
    errors.push(`${name}: Duplicate game entries found`);
  }
});

if (errors.length === 0) {
  console.log('✅ All data consistent');
} else {
  console.log('❌ Data inconsistencies found (see summary)');
}

console.log('');

// ============ SUMMARY ============
console.log('='.repeat(70));
console.log('SUMMARY');
console.log('='.repeat(70));
console.log('');

if (warnings.length > 0) {
  console.log('⚠️  WARNINGS:');
  warnings.forEach(w => console.log(`   - ${w}`));
  console.log('');
}

if (errors.length > 0) {
  console.log('❌ ERRORS:');
  errors.forEach(e => console.log(`   - ${e}`));
} else {
  console.log('✅ No critical errors found in data calculations');
}

console.log('');
console.log('Test completed.');
