/**
 * PLAYER DATA VALIDATION - No API Required
 * 
 * This validates the data processing that feeds into the forecast.
 * Run in browser console: window.validateAllPlayers()
 */

import { getPlayerStats } from '../database/storage';

interface DataValidation {
  playerName: string;
  gamesPlayed: number;
  totalProfit: number;
  currentStreak: number;
  calculatedStreak: number;
  streakValid: boolean;
  yearGames: number;
  yearProfit: number;
  lastGameProfit: number;
  issues: string[];
}

function validatePlayerData(playerName: string): DataValidation | null {
  const allStats = getPlayerStats();
  const stats = allStats.find(s => s.playerName === playerName);
  
  if (!stats) {
    console.warn(`Player "${playerName}" not found`);
    return null;
  }
  
  const issues: string[] = [];
  const currentYear = new Date().getFullYear();
  
  // Calculate year stats from game history
  const yearGames = stats.lastGameResults.filter(g => {
    const d = new Date(g.date);
    return d.getFullYear() === currentYear;
  });
  const yearProfit = yearGames.reduce((sum, g) => sum + g.profit, 0);
  
  // Calculate expected streak from game history
  let calculatedStreak = 0;
  for (const g of stats.lastGameResults) {
    if (g.profit > 0) {
      if (calculatedStreak >= 0) calculatedStreak++;
      else break;
    } else if (g.profit < 0) {
      if (calculatedStreak <= 0) calculatedStreak--;
      else break;
    } else {
      // Break-even breaks streak
      break;
    }
  }
  
  // Validate streak
  const streakValid = stats.currentStreak === calculatedStreak;
  if (!streakValid) {
    issues.push(`Streak mismatch: stored=${stats.currentStreak}, calculated=${calculatedStreak}`);
  }
  
  // Validate profit consistency
  const sumFromHistory = stats.lastGameResults.reduce((sum, g) => sum + g.profit, 0);
  const profitDiff = Math.abs(stats.totalProfit - sumFromHistory);
  if (profitDiff > 1) { // Allow small rounding differences
    // This is expected if lastGameResults doesn't contain ALL games
    // Only flag if we have all games
    if (stats.lastGameResults.length === stats.gamesPlayed && profitDiff > 1) {
      issues.push(`Profit mismatch: stored=${Math.round(stats.totalProfit)}, calculated=${Math.round(sumFromHistory)}`);
    }
  }
  
  // Validate win/loss counts
  const winsFromHistory = stats.lastGameResults.filter(g => g.profit > 0).length;
  const lossesFromHistory = stats.lastGameResults.filter(g => g.profit < 0).length;
  
  // Get last game
  const lastGameProfit = stats.lastGameResults[0]?.profit || 0;
  
  return {
    playerName: stats.playerName,
    gamesPlayed: stats.gamesPlayed,
    totalProfit: stats.totalProfit,
    currentStreak: stats.currentStreak,
    calculatedStreak,
    streakValid,
    yearGames: yearGames.length,
    yearProfit,
    lastGameProfit,
    issues
  };
}

export function validateAllPlayers(): void {
  console.clear();
  console.log('═'.repeat(60));
  console.log('   📊 PLAYER DATA VALIDATION');
  console.log('   Verifying data integrity before forecast generation');
  console.log('═'.repeat(60));
  
  const allStats = getPlayerStats();
  console.log(`\nFound ${allStats.length} players with game history\n`);
  
  const validations: DataValidation[] = [];
  let issueCount = 0;
  
  allStats.forEach(stats => {
    const validation = validatePlayerData(stats.playerName);
    if (validation) {
      validations.push(validation);
      issueCount += validation.issues.length;
    }
  });
  
  // Sort by games played
  validations.sort((a, b) => b.gamesPlayed - a.gamesPlayed);
  
  // Display results
  console.log('─'.repeat(60));
  console.log(' Name             | Games | Profit | Streak | Year | Issues');
  console.log('─'.repeat(60));
  
  validations.forEach(v => {
    const name = v.playerName.padEnd(16).slice(0, 16);
    const games = v.gamesPlayed.toString().padStart(5);
    const profit = (v.totalProfit >= 0 ? '+' : '') + Math.round(v.totalProfit).toString().padStart(5);
    const streak = v.currentStreak.toString().padStart(3);
    const streakCheck = v.streakValid ? '✓' : '✗';
    const year = (v.yearProfit >= 0 ? '+' : '') + Math.round(v.yearProfit).toString().padStart(4);
    const issues = v.issues.length > 0 ? '⚠️ ' + v.issues.length : '✅';
    
    console.log(` ${name} | ${games} | ${profit}₪ | ${streak}${streakCheck} | ${year} | ${issues}`);
  });
  
  console.log('─'.repeat(60));
  
  // Show issues
  if (issueCount > 0) {
    console.log(`\n⚠️ ISSUES FOUND (${issueCount}):\n`);
    validations.filter(v => v.issues.length > 0).forEach(v => {
      console.log(`  ${v.playerName}:`);
      v.issues.forEach(issue => console.log(`    - ${issue}`));
    });
  } else {
    console.log('\n✅ All player data is valid!\n');
  }
  
  // Show streak breakdown for top players
  console.log('\n📊 STREAK VERIFICATION (Top 10 by games):');
  console.log('─'.repeat(60));
  
  validations.slice(0, 10).forEach(v => {
    const stats = allStats.find(s => s.playerName === v.playerName);
    if (stats) {
      const recent = stats.lastGameResults.slice(0, 8).map(g => 
        g.profit > 0 ? 'W' : g.profit < 0 ? 'L' : 'T'
      ).join(' ');
      const streakIcon = v.currentStreak > 0 ? '🔥' : v.currentStreak < 0 ? '❄️' : '➡️';
      console.log(`  ${v.playerName}: ${recent}`);
      console.log(`    ${streakIcon} Streak: ${v.currentStreak} | Calculated: ${v.calculatedStreak} ${v.streakValid ? '✅' : '❌'}`);
    }
  });
  
  // Show year breakdown
  const currentYear = new Date().getFullYear();
  console.log(`\n📅 ${currentYear} PERFORMANCE (Top 10):`);
  console.log('─'.repeat(60));
  
  const byYear = validations
    .filter(v => v.yearGames > 0)
    .sort((a, b) => b.yearProfit - a.yearProfit)
    .slice(0, 10);
  
  byYear.forEach((v, i) => {
    const avg = v.yearGames > 0 ? Math.round(v.yearProfit / v.yearGames) : 0;
    console.log(`  ${i + 1}. ${v.playerName}: ${v.yearGames} games, ${v.yearProfit >= 0 ? '+' : ''}${Math.round(v.yearProfit)}₪ (avg: ${avg >= 0 ? '+' : ''}${avg}₪)`);
  });
  
  console.log('\n' + '═'.repeat(60));
  console.log('   Use testSinglePlayer("name") for detailed player info');
  console.log('   Use runForecastTests() to test AI forecast accuracy');
  console.log('═'.repeat(60));
}

// Show detailed view of a single player
export function showPlayerDetail(playerName: string): void {
  const allStats = getPlayerStats();
  const stats = allStats.find(s => s.playerName === playerName);
  
  if (!stats) {
    console.log(`❌ Player "${playerName}" not found`);
    console.log('Available:', allStats.map(s => s.playerName).join(', '));
    return;
  }
  
  const currentYear = new Date().getFullYear();
  
  console.log('\n' + '═'.repeat(50));
  console.log(`   📊 ${playerName} - DETAILED VIEW`);
  console.log('═'.repeat(50));
  
  console.log('\n📈 ALL-TIME STATS:');
  console.log(`   Games: ${stats.gamesPlayed}`);
  console.log(`   Total: ${stats.totalProfit >= 0 ? '+' : ''}${Math.round(stats.totalProfit)}₪`);
  console.log(`   Avg: ${stats.avgProfit >= 0 ? '+' : ''}${Math.round(stats.avgProfit)}₪/game`);
  console.log(`   Win Rate: ${Math.round(stats.winPercentage)}% (${stats.winCount}W / ${stats.lossCount}L)`);
  console.log(`   Best Win: +${Math.round(stats.biggestWin)}₪`);
  console.log(`   Worst Loss: ${Math.round(stats.biggestLoss)}₪`);
  
  console.log('\n🔥 STREAKS:');
  console.log(`   Current: ${stats.currentStreak}`);
  console.log(`   Longest Win: ${stats.longestWinStreak}`);
  console.log(`   Longest Loss: ${stats.longestLossStreak}`);
  
  // Year breakdown
  const gamesByYear: Record<number, { games: number; profit: number; wins: number }> = {};
  stats.lastGameResults.forEach(g => {
    const year = new Date(g.date).getFullYear();
    if (!gamesByYear[year]) gamesByYear[year] = { games: 0, profit: 0, wins: 0 };
    gamesByYear[year].games++;
    gamesByYear[year].profit += g.profit;
    if (g.profit > 0) gamesByYear[year].wins++;
  });
  
  console.log('\n📅 BY YEAR:');
  Object.keys(gamesByYear).sort().reverse().forEach(yearStr => {
    const year = parseInt(yearStr);
    const data = gamesByYear[year];
    const marker = year === currentYear ? ' ← CURRENT' : '';
    console.log(`   ${year}: ${data.games} games, ${data.profit >= 0 ? '+' : ''}${Math.round(data.profit)}₪ (${data.wins}W)${marker}`);
  });
  
  console.log('\n📜 LAST 10 GAMES:');
  stats.lastGameResults.slice(0, 10).forEach((g, i) => {
    const d = new Date(g.date);
    const dateStr = d.toLocaleDateString('he-IL');
    const result = g.profit > 0 ? '✅' : g.profit < 0 ? '❌' : '➡️';
    console.log(`   ${i + 1}. ${dateStr}: ${g.profit >= 0 ? '+' : ''}${g.profit}₪ ${result}`);
  });
  
  // Verify streak calculation
  console.log('\n🔍 STREAK VERIFICATION:');
  const recent = stats.lastGameResults.slice(0, 8).map(g => 
    g.profit > 0 ? 'W' : g.profit < 0 ? 'L' : 'T'
  );
  console.log(`   Recent results: ${recent.join(' ')}`);
  
  let calculatedStreak = 0;
  for (const g of stats.lastGameResults) {
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
  
  console.log(`   Stored streak: ${stats.currentStreak}`);
  console.log(`   Calculated: ${calculatedStreak}`);
  console.log(`   Match: ${stats.currentStreak === calculatedStreak ? '✅' : '❌'}`);
  
  console.log('\n' + '═'.repeat(50));
}

// Calculate what the forecast prompt would show for tonight's table
export function showTonightRankings(playerNames: string[]): void {
  const allStats = getPlayerStats();
  const tonightStats = playerNames
    .map(name => allStats.find(s => s.playerName === name))
    .filter(Boolean) as typeof allStats;
  
  if (tonightStats.length < 2) {
    console.log('❌ Need at least 2 valid players');
    return;
  }
  
  console.log('\n' + '═'.repeat(50));
  console.log(`   🏆 TONIGHT'S TABLE (${tonightStats.length} players)`);
  console.log('═'.repeat(50));
  
  // Sort by total profit for tonight's ranking
  const sorted = [...tonightStats].sort((a, b) => b.totalProfit - a.totalProfit);
  
  console.log('\n📊 RANKINGS (All-Time Profit, among tonight\'s players only):');
  console.log('─'.repeat(50));
  
  sorted.forEach((p, i) => {
    const rank = i + 1;
    const playerAbove = i > 0 ? sorted[i - 1] : null;
    const playerBelow = i < sorted.length - 1 ? sorted[i + 1] : null;
    const gapAbove = playerAbove ? Math.round(playerAbove.totalProfit - p.totalProfit) : null;
    const gapBelow = playerBelow ? Math.round(p.totalProfit - playerBelow.totalProfit) : null;
    
    console.log(`\n  #${rank} ${p.playerName}`);
    console.log(`      Total: ${p.totalProfit >= 0 ? '+' : ''}${Math.round(p.totalProfit)}₪`);
    console.log(`      Streak: ${p.currentStreak}`);
    if (playerAbove) {
      console.log(`      ↑ ${gapAbove}₪ behind ${playerAbove.playerName}`);
    } else {
      console.log(`      ★ LEADING TONIGHT'S TABLE`);
    }
    if (playerBelow) {
      console.log(`      ↓ ${gapBelow}₪ ahead of ${playerBelow.playerName}`);
    } else {
      console.log(`      ⚠️ LAST IN TONIGHT'S TABLE`);
    }
  });
  
  // Show year rankings too
  const currentYear = new Date().getFullYear();
  console.log(`\n📅 ${currentYear} RANKINGS (Tonight's players):`);
  console.log('─'.repeat(50));
  
  const yearData = sorted.map(p => {
    const yearGames = p.lastGameResults.filter(g => 
      new Date(g.date).getFullYear() === currentYear
    );
    return {
      name: p.playerName,
      yearProfit: yearGames.reduce((sum, g) => sum + g.profit, 0),
      yearGames: yearGames.length
    };
  }).sort((a, b) => b.yearProfit - a.yearProfit);
  
  yearData.forEach((p, i) => {
    console.log(`  #${i + 1} ${p.name}: ${p.yearProfit >= 0 ? '+' : ''}${Math.round(p.yearProfit)}₪ (${p.yearGames} games)`);
  });
  
  console.log('\n' + '═'.repeat(50));
}

// Export for browser
if (typeof window !== 'undefined') {
  (window as any).validateAllPlayers = validateAllPlayers;
  (window as any).showPlayerDetail = showPlayerDetail;
  (window as any).showTonightRankings = showTonightRankings;
}
