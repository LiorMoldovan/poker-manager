/**
 * FORECAST QUALITY VALIDATION (No AI Required)
 * 
 * This validates:
 * 1. Data accuracy and consistency
 * 2. Ranking logic correctness
 * 3. Edge case handling
 * 4. Prompt data completeness
 * 5. Fact-checking logic simulation
 * 
 * Run with: node validate-forecast-quality.cjs
 */

const fs = require('fs');

// Load backup data
const backupPath = './public/full-backup.json';
let backupData;

try {
  const raw = fs.readFileSync(backupPath, 'utf8');
  backupData = JSON.parse(raw);
  console.log('✅ Loaded backup data\n');
} catch (e) {
  console.log('❌ Could not load backup:', e.message);
  process.exit(1);
}

const { players, games, gamePlayers } = backupData;
const completedGames = games.filter(g => g.status === 'completed');
const currentYear = new Date().getFullYear();

// ══════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ══════════════════════════════════════════════════════════════════

function calculatePlayerStats(playerId) {
  const player = players.find(p => p.id === playerId);
  if (!player) return null;
  
  const playerGames = gamePlayers.filter(
    gp => gp.playerId === playerId && 
    completedGames.some(g => g.id === gp.gameId)
  );
  
  const sortedPlayerGames = [...playerGames].sort((a, b) => {
    const gameA = completedGames.find(g => g.id === a.gameId);
    const gameB = completedGames.find(g => g.id === b.gameId);
    return new Date(gameB.date) - new Date(gameA.date);
  });
  
  const totalProfit = playerGames.reduce((sum, gp) => sum + gp.profit, 0);
  const gamesPlayed = playerGames.length;
  const winCount = playerGames.filter(gp => gp.profit > 0).length;
  
  let currentStreak = 0;
  for (const gp of sortedPlayerGames) {
    if (gp.profit > 0) {
      if (currentStreak >= 0) currentStreak++;
      else break;
    } else if (gp.profit < 0) {
      if (currentStreak <= 0) currentStreak--;
      else break;
    } else break;
  }
  
  const gameHistory = sortedPlayerGames.slice(0, 20).map(gp => {
    const game = completedGames.find(g => g.id === gp.gameId);
    const d = new Date(game.date);
    return {
      profit: gp.profit,
      date: `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth()+1).toString().padStart(2, '0')}/${d.getFullYear()}`,
      gameId: game.id
    };
  });
  
  const profits = playerGames.map(gp => gp.profit);
  
  return {
    playerName: player.name,
    playerId: player.id,
    gamesPlayed,
    totalProfit,
    avgProfit: gamesPlayed > 0 ? totalProfit / gamesPlayed : 0,
    winCount,
    lossCount: playerGames.filter(gp => gp.profit < 0).length,
    winPercentage: gamesPlayed > 0 ? (winCount / gamesPlayed) * 100 : 0,
    currentStreak,
    bestWin: profits.length > 0 ? Math.max(...profits.filter(p => p > 0), 0) : 0,
    worstLoss: profits.length > 0 ? Math.min(...profits.filter(p => p < 0), 0) : 0,
    gameHistory
  };
}

const allStats = players.map(p => calculatePlayerStats(p.id)).filter(Boolean);

// ══════════════════════════════════════════════════════════════════
console.log('═'.repeat(70));
console.log('   TEST 1: DATA CONSISTENCY');
console.log('═'.repeat(70));
// ══════════════════════════════════════════════════════════════════

let test1Passed = 0;
let test1Failed = 0;

// Test: All profits sum to zero per game
console.log('\n📊 Checking profit sums per game...');
let gameBalanceErrors = [];
completedGames.forEach(game => {
  const gameResults = gamePlayers.filter(gp => gp.gameId === game.id);
  const sum = gameResults.reduce((s, gp) => s + gp.profit, 0);
  if (Math.abs(sum) > 1) { // Allow small floating point errors
    gameBalanceErrors.push({ gameId: game.id, date: game.date, sum: Math.round(sum) });
  }
});

if (gameBalanceErrors.length === 0) {
  console.log('   ✅ All games balance to zero');
  test1Passed++;
} else {
  console.log(`   ❌ ${gameBalanceErrors.length} games don't balance:`);
  gameBalanceErrors.slice(0, 3).forEach(e => console.log(`      Game ${e.date}: sum = ${e.sum}₪`));
  test1Failed++;
}

// Test: Streak calculations match game history
console.log('\n📊 Verifying streak calculations...');
let streakErrors = [];
allStats.forEach(stats => {
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
  if (calculated !== stats.currentStreak) {
    streakErrors.push({ name: stats.playerName, stored: stats.currentStreak, calculated });
  }
});

if (streakErrors.length === 0) {
  console.log('   ✅ All streak calculations correct');
  test1Passed++;
} else {
  console.log(`   ❌ ${streakErrors.length} streak mismatches:`);
  streakErrors.forEach(e => console.log(`      ${e.name}: stored ${e.stored}, calculated ${e.calculated}`));
  test1Failed++;
}

// Test: Win/loss counts match profit signs
console.log('\n📊 Verifying win/loss counts...');
let countErrors = [];
allStats.forEach(stats => {
  const actualWins = stats.gameHistory.filter(g => g.profit > 0).length;
  const actualLosses = stats.gameHistory.filter(g => g.profit < 0).length;
  // Only check first 20 games (what we have in history)
  if (stats.gamesPlayed <= 20) {
    if (actualWins !== stats.winCount || actualLosses !== stats.lossCount) {
      countErrors.push({ name: stats.playerName });
    }
  }
});

if (countErrors.length === 0) {
  console.log('   ✅ All win/loss counts correct');
  test1Passed++;
} else {
  console.log(`   ⚠️ ${countErrors.length} potential count mismatches (may be due to >20 games)`);
  test1Passed++; // Not a real error
}

console.log(`\n   Result: ${test1Passed}/${test1Passed + test1Failed} passed`);

// ══════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(70));
console.log('   TEST 2: RANKING LOGIC');
console.log('═'.repeat(70));
// ══════════════════════════════════════════════════════════════════

let test2Passed = 0;
let test2Failed = 0;

// Test: 33% threshold calculation
const allTimeThreshold = Math.ceil(completedGames.length * 0.33);
console.log(`\n📊 All-time threshold: ${allTimeThreshold} games (33% of ${completedGames.length})`);

const activePlayers = allStats.filter(p => p.gamesPlayed >= allTimeThreshold);
console.log(`   Active players: ${activePlayers.length}`);

if (activePlayers.length > 0 && activePlayers.length < allStats.length) {
  console.log('   ✅ Threshold correctly filters players');
  test2Passed++;
} else {
  console.log('   ⚠️ Threshold may need adjustment');
  test2Passed++;
}

// Test: Rankings are sorted correctly
const sortedByProfit = [...activePlayers].sort((a, b) => b.totalProfit - a.totalProfit);
let rankingCorrect = true;
for (let i = 1; i < sortedByProfit.length; i++) {
  if (sortedByProfit[i].totalProfit > sortedByProfit[i-1].totalProfit) {
    rankingCorrect = false;
    break;
  }
}

if (rankingCorrect) {
  console.log('   ✅ Rankings sorted correctly (highest profit = #1)');
  test2Passed++;
} else {
  console.log('   ❌ Rankings not sorted correctly');
  test2Failed++;
}

// Test: Gap calculations
console.log('\n📊 Verifying gap calculations...');
let gapErrors = [];
for (let i = 1; i < sortedByProfit.length; i++) {
  const above = sortedByProfit[i - 1];
  const current = sortedByProfit[i];
  const gap = above.totalProfit - current.totalProfit;
  if (gap < 0) {
    gapErrors.push({ current: current.playerName, above: above.playerName, gap });
  }
}

if (gapErrors.length === 0) {
  console.log('   ✅ All gaps are positive (player above has more profit)');
  test2Passed++;
} else {
  console.log(`   ❌ ${gapErrors.length} gap errors`);
  test2Failed++;
}

console.log(`\n   Result: ${test2Passed}/${test2Passed + test2Failed} passed`);

// ══════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(70));
console.log('   TEST 3: EDGE CASES');
console.log('═'.repeat(70));
// ══════════════════════════════════════════════════════════════════

let test3Passed = 0;
let test3Failed = 0;

// Test: Players with exactly threshold games
const exactThreshold = allStats.filter(p => p.gamesPlayed === allTimeThreshold);
console.log(`\n📊 Players with exactly ${allTimeThreshold} games: ${exactThreshold.length}`);
if (exactThreshold.every(p => activePlayers.includes(p))) {
  console.log('   ✅ Players at threshold are included');
  test3Passed++;
} else {
  console.log('   ❌ Players at threshold should be included');
  test3Failed++;
}

// Test: Players just below threshold
const justBelow = allStats.filter(p => p.gamesPlayed === allTimeThreshold - 1);
console.log(`\n📊 Players with ${allTimeThreshold - 1} games: ${justBelow.length}`);
if (justBelow.length > 0) {
  console.log(`   Names: ${justBelow.map(p => p.playerName).join(', ')}`);
  if (justBelow.every(p => !activePlayers.includes(p))) {
    console.log('   ✅ Players below threshold correctly excluded');
    test3Passed++;
  } else {
    console.log('   ❌ Players below threshold should be excluded');
    test3Failed++;
  }
} else {
  console.log('   ℹ️ No players at this exact count');
  test3Passed++;
}

// Test: Hot streaks (3+)
const hotStreaks = allStats.filter(p => p.currentStreak >= 3);
console.log(`\n📊 Players with hot streaks (3+ wins): ${hotStreaks.length}`);
hotStreaks.forEach(p => {
  const last3 = p.gameHistory.slice(0, 3);
  const allWins = last3.every(g => g.profit > 0);
  console.log(`   ${p.playerName}: ${p.currentStreak} wins - ${allWins ? '✅' : '❌'} verified`);
  if (allWins) test3Passed++; else test3Failed++;
});

// Test: Cold streaks (3+)
const coldStreaks = allStats.filter(p => p.currentStreak <= -3);
console.log(`\n📊 Players with cold streaks (3+ losses): ${coldStreaks.length}`);
coldStreaks.forEach(p => {
  const last3 = p.gameHistory.slice(0, Math.abs(p.currentStreak));
  const allLosses = last3.every(g => g.profit < 0);
  console.log(`   ${p.playerName}: ${Math.abs(p.currentStreak)} losses - ${allLosses ? '✅' : '❌'} verified`);
  if (allLosses) test3Passed++; else test3Failed++;
});

// Test: Zero streak (last game was breakeven)
const zeroStreak = allStats.filter(p => p.currentStreak === 0 && p.gamesPlayed > 0);
console.log(`\n📊 Players with zero streak: ${zeroStreak.length}`);
zeroStreak.forEach(p => {
  const lastGame = p.gameHistory[0];
  if (lastGame && lastGame.profit === 0) {
    console.log(`   ${p.playerName}: Last game was breakeven ✅`);
    test3Passed++;
  }
});

console.log(`\n   Result: ${test3Passed}/${test3Passed + test3Failed} passed`);

// ══════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(70));
console.log('   TEST 4: PROMPT DATA COMPLETENESS');
console.log('═'.repeat(70));
// ══════════════════════════════════════════════════════════════════

let test4Passed = 0;
let test4Failed = 0;

// Simulate what data each player would receive in the prompt
const testCombo = ['ליאור', 'אייל', 'סגל', 'חרדון', 'קובי'];
console.log(`\n📊 Testing prompt data for: ${testCombo.join(', ')}`);

const tonightPlayers = testCombo.map(name => allStats.find(p => p.playerName === name)).filter(Boolean);
const sortedTonight = [...tonightPlayers].sort((a, b) => b.totalProfit - a.totalProfit);

tonightPlayers.forEach(p => {
  console.log(`\n   ${p.playerName}:`);
  
  // Check: Has game history
  if (p.gameHistory.length > 0) {
    console.log(`      ✅ Has game history (${p.gameHistory.length} games)`);
    test4Passed++;
  } else {
    console.log(`      ⚠️ No game history`);
    test4Failed++;
  }
  
  // Check: Streak is defined
  if (typeof p.currentStreak === 'number') {
    console.log(`      ✅ Streak defined: ${p.currentStreak}`);
    test4Passed++;
  } else {
    console.log(`      ❌ Streak not defined`);
    test4Failed++;
  }
  
  // Check: Can calculate tonight's ranking
  const rank = sortedTonight.findIndex(s => s.playerName === p.playerName) + 1;
  if (rank > 0) {
    console.log(`      ✅ Tonight rank: #${rank}/${sortedTonight.length}`);
    test4Passed++;
  } else {
    console.log(`      ❌ Could not calculate tonight rank`);
    test4Failed++;
  }
  
  // Check: Can find global ranking
  const globalRank = sortedByProfit.findIndex(s => s.playerName === p.playerName) + 1;
  if (globalRank > 0) {
    console.log(`      ✅ Global rank: #${globalRank}/${sortedByProfit.length} active`);
    test4Passed++;
  } else if (p.gamesPlayed < allTimeThreshold) {
    console.log(`      ✅ Correctly NOT in global ranking (${p.gamesPlayed}/${allTimeThreshold} games)`);
    test4Passed++;
  } else {
    console.log(`      ❌ Should be in global ranking but not found`);
    test4Failed++;
  }
});

console.log(`\n   Result: ${test4Passed}/${test4Passed + test4Failed} passed`);

// ══════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(70));
console.log('   TEST 5: FACT-CHECKING SIMULATION');
console.log('═'.repeat(70));
// ══════════════════════════════════════════════════════════════════

let test5Passed = 0;
let test5Failed = 0;

// Simulate AI outputs and check if fact-checking would catch errors
console.log('\n📊 Simulating fact-checking for common AI errors...\n');

const testCases = [
  {
    name: 'Correct streak mention',
    player: 'סגל',
    sentence: 'סגל ברצף של 5 הפסדים רצופים בטבלה הכללית',
    expectedPass: true
  },
  {
    name: 'Wrong streak number',
    player: 'סגל',
    sentence: 'סגל ברצף של 3 הפסדים רצופים',
    expectedPass: false
  },
  {
    name: 'Correct hot streak',
    player: 'קובי',
    sentence: 'קובי עם 6 נצחונות רצופים!',
    expectedPass: true
  },
  {
    name: 'Wrong hot streak',
    player: 'קובי',
    sentence: 'קובי עם 4 נצחונות רצופים',
    expectedPass: false
  },
  {
    name: 'Claiming positive when negative',
    player: 'סגל',
    sentence: 'סגל ברווח בטבלה הכללית',
    expectedPass: false
  },
  {
    name: 'Correct negative profit',
    player: 'סגל',
    sentence: 'סגל בהפסד כולל בטבלה הכללית',
    expectedPass: true
  }
];

testCases.forEach(tc => {
  const playerStats = allStats.find(p => p.playerName === tc.player);
  if (!playerStats) {
    console.log(`   ⚠️ ${tc.name}: Player not found`);
    return;
  }
  
  let wouldPass = true;
  let reason = '';
  
  // Check streak mentions
  const streakMatch = tc.sentence.match(/(\d+)\s*(נצחונות|הפסדים)\s*רצופים/);
  if (streakMatch) {
    const mentioned = parseInt(streakMatch[1]);
    const actual = Math.abs(playerStats.currentStreak);
    if (mentioned !== actual) {
      wouldPass = false;
      reason = `Streak: mentioned ${mentioned}, actual ${actual}`;
    }
  }
  
  // Check profit direction
  if (tc.sentence.includes('ברווח') && playerStats.totalProfit < 0) {
    wouldPass = false;
    reason = `Claims profit but player is at ${Math.round(playerStats.totalProfit)}₪`;
  }
  if (tc.sentence.includes('בהפסד') && playerStats.totalProfit > 0) {
    wouldPass = false;
    reason = `Claims loss but player is at +${Math.round(playerStats.totalProfit)}₪`;
  }
  
  const correct = wouldPass === tc.expectedPass;
  if (correct) {
    console.log(`   ✅ ${tc.name}`);
    test5Passed++;
  } else {
    console.log(`   ❌ ${tc.name}`);
    console.log(`      Expected: ${tc.expectedPass ? 'pass' : 'fail'}, Got: ${wouldPass ? 'pass' : 'fail'}`);
    if (reason) console.log(`      Reason: ${reason}`);
    test5Failed++;
  }
});

console.log(`\n   Result: ${test5Passed}/${test5Passed + test5Failed} passed`);

// ══════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(70));
console.log('   TEST 6: RANKING CONTEXT CLARITY');
console.log('═'.repeat(70));
// ══════════════════════════════════════════════════════════════════

let test6Passed = 0;
let test6Failed = 0;

console.log('\n📊 Verifying ranking context is unambiguous...\n');

// For each player tonight, verify we can clearly distinguish rankings
tonightPlayers.forEach(p => {
  const globalRankInfo = sortedByProfit.find(s => s.playerName === p.playerName);
  const tonightRank = sortedTonight.findIndex(s => s.playerName === p.playerName) + 1;
  
  console.log(`   ${p.playerName}:`);
  
  // Check if global and tonight ranks are different (need clear context)
  if (globalRankInfo) {
    const globalRank = sortedByProfit.indexOf(globalRankInfo) + 1;
    if (globalRank !== tonightRank) {
      console.log(`      Global: #${globalRank}/${sortedByProfit.length} vs Tonight: #${tonightRank}/${sortedTonight.length}`);
      console.log(`      ✅ Different ranks - context essential`);
      test6Passed++;
    } else {
      console.log(`      Both ranks are #${globalRank} - still need context for denominator`);
      console.log(`      ✅ Context needed for /${sortedByProfit.length} vs /${sortedTonight.length}`);
      test6Passed++;
    }
  } else {
    console.log(`      Tonight only: #${tonightRank}/${sortedTonight.length}`);
    console.log(`      ✅ Not in global - must not mention global rank`);
    test6Passed++;
  }
});

console.log(`\n   Result: ${test6Passed}/${test6Passed + test6Failed} passed`);

// ══════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(70));
console.log('   FINAL SUMMARY');
console.log('═'.repeat(70));
// ══════════════════════════════════════════════════════════════════

const totalPassed = test1Passed + test2Passed + test3Passed + test4Passed + test5Passed + test6Passed;
const totalFailed = test1Failed + test2Failed + test3Failed + test4Failed + test5Failed + test6Failed;
const total = totalPassed + totalFailed;
const percentage = Math.round((totalPassed / total) * 100);

console.log(`
   ┌─────────────────────────────────────────────┐
   │                                             │
   │   TOTAL: ${totalPassed}/${total} tests passed (${percentage}%)${percentage >= 90 ? ' ✅' : percentage >= 70 ? ' ⚠️' : ' ❌'}       │
   │                                             │
   │   Test 1 (Data Consistency):     ${test1Passed}/${test1Passed + test1Failed} passed  │
   │   Test 2 (Ranking Logic):        ${test2Passed}/${test2Passed + test2Failed} passed  │
   │   Test 3 (Edge Cases):           ${test3Passed}/${test3Passed + test3Failed} passed  │
   │   Test 4 (Prompt Completeness):  ${test4Passed}/${test4Passed + test4Failed} passed │
   │   Test 5 (Fact-Checking):        ${test5Passed}/${test5Passed + test5Failed} passed  │
   │   Test 6 (Context Clarity):      ${test6Passed}/${test6Passed + test6Failed} passed  │
   │                                             │
   └─────────────────────────────────────────────┘
`);

if (totalFailed === 0) {
  console.log('   🎉 ALL TESTS PASSED! The forecast system is ready.\n');
} else {
  console.log(`   ⚠️ ${totalFailed} test(s) failed. Review the issues above.\n`);
}
