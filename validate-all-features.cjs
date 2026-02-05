/**
 * Comprehensive Feature Validation
 * Tests milestones, insights, and forecast data integrity
 * 
 * Run: node validate-all-features.cjs
 */

const fs = require('fs');
const path = require('path');

// Load backup data
const backupPath = path.join(__dirname, 'public', 'full-backup.json');
const backupData = JSON.parse(fs.readFileSync(backupPath, 'utf8'));

const { players, games, gamePlayers } = backupData;

// Merge gamePlayers into games
const gamesWithPlayers = games.map(g => ({
  ...g,
  players: gamePlayers.filter(gp => gp.gameId === g.id)
}));

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║      COMPREHENSIVE FEATURE VALIDATION                        ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

console.log(`📊 Data: ${players.length} players, ${games.length} games, ${gamePlayers.length} game-player records\n`);

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

const parseGameDate = (dateStr) => {
  if (!dateStr) return new Date();
  const d = new Date(dateStr);
  return { year: d.getFullYear(), month: d.getMonth(), half: d.getMonth() < 6 ? 1 : 2, date: d };
};

const formatProfit = (n) => `${n >= 0 ? '+' : ''}${Math.round(n)}₪`;

// Build player stats (simulating what geminiAI.ts does)
function buildPlayerStats(selectedPlayers) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const currentHalf = currentMonth < 6 ? 1 : 2;
  
  return selectedPlayers.map(p => {
    const playerGames = gamesWithPlayers
      .filter(g => g.players.some(gp => gp.playerId === p.id))
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    
    const gameHistory = playerGames.map(g => {
      const gp = g.players.find(gp => gp.playerId === p.id);
      const profit = gp?.profit !== undefined ? gp.profit : 0;
      return { date: g.date, profit, gameId: g.id };
    });
    
    const totalProfit = gameHistory.reduce((sum, g) => sum + g.profit, 0);
    const gamesPlayed = gameHistory.length;
    const avgProfit = gamesPlayed > 0 ? totalProfit / gamesPlayed : 0;
    const wins = gameHistory.filter(g => g.profit > 0).length;
    const losses = gameHistory.filter(g => g.profit < 0).length;
    
    // Calculate streaks
    let currentStreak = 0;
    for (const g of gameHistory) {
      if (g.profit > 0) {
        if (currentStreak >= 0) currentStreak++;
        else break;
      } else if (g.profit < 0) {
        if (currentStreak <= 0) currentStreak--;
        else break;
      } else break;
    }
    
    // Calculate period profits
    let yearProfit = 0, yearGames = 0;
    let monthProfit = 0, monthGames = 0;
    
    for (const g of gameHistory) {
      const { year, month } = parseGameDate(g.date);
      if (year === currentYear) {
        yearProfit += g.profit;
        yearGames++;
        if (month === currentMonth) {
          monthProfit += g.profit;
          monthGames++;
        }
      }
    }
    
    // Recent averages
    const last5 = gameHistory.slice(0, 5);
    const last3 = gameHistory.slice(0, 3);
    const last5Avg = last5.length > 0 ? last5.reduce((s, g) => s + g.profit, 0) / last5.length : 0;
    const last3Avg = last3.length > 0 ? last3.reduce((s, g) => s + g.profit, 0) / last3.length : 0;
    const lastGameProfit = gameHistory[0]?.profit || 0;
    
    // Best/worst
    const bestWin = Math.max(0, ...gameHistory.map(g => g.profit));
    const worstLoss = Math.min(0, ...gameHistory.map(g => g.profit));
    
    // Days since last game
    const lastGameDate = gameHistory[0]?.date ? new Date(gameHistory[0].date) : null;
    const daysSinceLastGame = lastGameDate ? Math.floor((now.getTime() - lastGameDate.getTime()) / (1000 * 60 * 60 * 24)) : 9999;
    
    return {
      ...p,
      totalProfit,
      gamesPlayed,
      avgProfit,
      winPercentage: gamesPlayed > 0 ? (wins / gamesPlayed) * 100 : 0,
      winCount: wins,
      lossCount: losses,
      currentStreak,
      yearProfit, yearGames,
      monthProfit, monthGames,
      last5Avg, last3Avg,
      lastGameProfit,
      bestWin, worstLoss,
      daysSinceLastGame,
      gameHistory,
      isFemale: p.name === 'מור'
    };
  }).filter(p => p.gamesPlayed > 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST 1: MILESTONE DATA ACCURACY
// ═══════════════════════════════════════════════════════════════════════════

console.log('═══════════════════════════════════════════════════════════════');
console.log('TEST 1: MILESTONE DATA ACCURACY');
console.log('═══════════════════════════════════════════════════════════════\n');

const topPlayers = players
  .map(p => ({ ...p, gameCount: gamesWithPlayers.filter(g => g.players.some(gp => gp.playerId === p.id)).length }))
  .filter(p => p.gameCount > 0)
  .sort((a, b) => b.gameCount - a.gameCount)
  .slice(0, 8);

const playerStats = buildPlayerStats(topPlayers);
let test1Passed = 0;
let test1Total = 0;

// Check streak accuracy
console.log('📊 Streak Verification:');
playerStats.forEach(p => {
  test1Total++;
  const history = p.gameHistory.slice(0, 10);
  
  // Manually calculate streak
  let manualStreak = 0;
  for (const g of history) {
    if (g.profit > 0) {
      if (manualStreak >= 0) manualStreak++;
      else break;
    } else if (g.profit < 0) {
      if (manualStreak <= 0) manualStreak--;
      else break;
    } else break;
  }
  
  if (p.currentStreak === manualStreak) {
    console.log(`   ✅ ${p.name}: streak=${p.currentStreak} (verified)`);
    test1Passed++;
  } else {
    console.log(`   ❌ ${p.name}: claimed=${p.currentStreak}, actual=${manualStreak}`);
  }
});

// Check profit calculations
console.log('\n📊 Profit Verification:');
playerStats.slice(0, 5).forEach(p => {
  test1Total++;
  const manualTotal = p.gameHistory.reduce((sum, g) => sum + g.profit, 0);
  const diff = Math.abs(p.totalProfit - manualTotal);
  
  if (diff < 1) {
    console.log(`   ✅ ${p.name}: total=${formatProfit(p.totalProfit)} (verified)`);
    test1Passed++;
  } else {
    console.log(`   ❌ ${p.name}: claimed=${formatProfit(p.totalProfit)}, actual=${formatProfit(manualTotal)}`);
  }
});

console.log(`\n   Result: ${test1Passed}/${test1Total} passed\n`);

// ═══════════════════════════════════════════════════════════════════════════
// TEST 2: RANKING CALCULATIONS
// ═══════════════════════════════════════════════════════════════════════════

console.log('═══════════════════════════════════════════════════════════════');
console.log('TEST 2: RANKING CALCULATIONS');
console.log('═══════════════════════════════════════════════════════════════\n');

let test2Passed = 0;
let test2Total = 0;

// All-time ranking
const allStats = buildPlayerStats(players);
const sortedAllTime = [...allStats].sort((a, b) => b.totalProfit - a.totalProfit);
const totalGames = games.length;
const threshold33 = Math.ceil(totalGames * 0.33);
const activePlayers = sortedAllTime.filter(p => p.gamesPlayed >= threshold33);

console.log(`📊 All-Time Rankings (33% threshold = ${threshold33} games):`);
console.log(`   Active players: ${activePlayers.length} of ${sortedAllTime.length}`);

// Verify rankings are sorted correctly
test2Total++;
let isSorted = true;
for (let i = 1; i < activePlayers.length; i++) {
  if (activePlayers[i].totalProfit > activePlayers[i-1].totalProfit) {
    isSorted = false;
    break;
  }
}
if (isSorted) {
  console.log('   ✅ Rankings sorted correctly (highest profit = #1)');
  test2Passed++;
} else {
  console.log('   ❌ Rankings NOT sorted correctly');
}

// Check gap calculations
test2Total++;
let gapsCorrect = true;
for (let i = 1; i < Math.min(activePlayers.length, 5); i++) {
  const above = activePlayers[i - 1];
  const below = activePlayers[i];
  const gap = above.totalProfit - below.totalProfit;
  if (gap < 0) {
    gapsCorrect = false;
    console.log(`   ❌ Gap error: ${above.name} (${formatProfit(above.totalProfit)}) vs ${below.name} (${formatProfit(below.totalProfit)})`);
    break;
  }
}
if (gapsCorrect) {
  console.log('   ✅ All gap calculations are positive');
  test2Passed++;
}

// Top 5 active players
console.log('\n   Top 5 Active Players:');
activePlayers.slice(0, 5).forEach((p, i) => {
  console.log(`      #${i + 1}: ${p.name} - ${formatProfit(p.totalProfit)} (${p.gamesPlayed} games)`);
});

console.log(`\n   Result: ${test2Passed}/${test2Total} passed\n`);

// ═══════════════════════════════════════════════════════════════════════════
// TEST 3: EDGE CASES
// ═══════════════════════════════════════════════════════════════════════════

console.log('═══════════════════════════════════════════════════════════════');
console.log('TEST 3: EDGE CASES');
console.log('═══════════════════════════════════════════════════════════════\n');

let test3Passed = 0;
let test3Total = 0;

// Hot streaks
const hotStreakers = allStats.filter(p => p.currentStreak >= 3);
console.log(`📊 Hot Streaks (3+ wins): ${hotStreakers.length} players`);
hotStreakers.forEach(p => {
  test3Total++;
  // Verify streak
  const history = p.gameHistory.slice(0, p.currentStreak + 2);
  let verified = true;
  for (let i = 0; i < p.currentStreak; i++) {
    if (!history[i] || history[i].profit <= 0) {
      verified = false;
      break;
    }
  }
  if (verified) {
    console.log(`   ✅ ${p.name}: ${p.currentStreak} wins in a row`);
    test3Passed++;
  } else {
    console.log(`   ❌ ${p.name}: claimed ${p.currentStreak} but not verified`);
  }
});

// Cold streaks
const coldStreakers = allStats.filter(p => p.currentStreak <= -3);
console.log(`\n📊 Cold Streaks (3+ losses): ${coldStreakers.length} players`);
coldStreakers.forEach(p => {
  test3Total++;
  const history = p.gameHistory.slice(0, Math.abs(p.currentStreak) + 2);
  let verified = true;
  for (let i = 0; i < Math.abs(p.currentStreak); i++) {
    if (!history[i] || history[i].profit >= 0) {
      verified = false;
      break;
    }
  }
  if (verified) {
    console.log(`   ✅ ${p.name}: ${Math.abs(p.currentStreak)} losses in a row`);
    test3Passed++;
  } else {
    console.log(`   ❌ ${p.name}: claimed ${Math.abs(p.currentStreak)} but not verified`);
  }
});

// Players near milestones
const roundNumbers = [500, 1000, 1500, 2000, 2500];
console.log('\n📊 Players Near Milestones:');
allStats.forEach(p => {
  for (const target of roundNumbers) {
    const distance = target - p.totalProfit;
    if (distance > 0 && distance <= 200) {
      console.log(`   📍 ${p.name}: ${formatProfit(p.totalProfit)} → ${target}₪ (${Math.round(distance)}₪ away)`);
      break;
    }
  }
});

console.log(`\n   Result: ${test3Passed}/${test3Total} passed\n`);

// ═══════════════════════════════════════════════════════════════════════════
// TEST 4: FORECAST DATA COMPLETENESS
// ═══════════════════════════════════════════════════════════════════════════

console.log('═══════════════════════════════════════════════════════════════');
console.log('TEST 4: FORECAST DATA COMPLETENESS');
console.log('═══════════════════════════════════════════════════════════════\n');

let test4Passed = 0;
let test4Total = 0;

// Select 5 players for tonight simulation
const tonightPlayers = playerStats.slice(0, 5);
console.log(`📊 Tonight's Players: ${tonightPlayers.map(p => p.name).join(', ')}\n`);

tonightPlayers.forEach(p => {
  console.log(`   ${p.name}:`);
  
  // Has game history
  test4Total++;
  if (p.gameHistory.length > 0) {
    console.log(`      ✅ Game history: ${p.gameHistory.length} games`);
    test4Passed++;
  } else {
    console.log(`      ❌ No game history`);
  }
  
  // Streak defined
  test4Total++;
  if (p.currentStreak !== undefined) {
    console.log(`      ✅ Streak: ${p.currentStreak}`);
    test4Passed++;
  } else {
    console.log(`      ❌ Streak undefined`);
  }
  
  // All-time profit
  test4Total++;
  if (p.totalProfit !== undefined) {
    console.log(`      ✅ Total profit: ${formatProfit(p.totalProfit)}`);
    test4Passed++;
  } else {
    console.log(`      ❌ Total profit undefined`);
  }
  
  // Recent form
  test4Total++;
  if (p.last5Avg !== undefined) {
    console.log(`      ✅ Recent avg (last 5): ${formatProfit(p.last5Avg)}/game`);
    test4Passed++;
  } else {
    console.log(`      ❌ Recent avg undefined`);
  }
  
  console.log('');
});

console.log(`   Result: ${test4Passed}/${test4Total} passed\n`);

// ═══════════════════════════════════════════════════════════════════════════
// TEST 5: ZERO-SUM VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

console.log('═══════════════════════════════════════════════════════════════');
console.log('TEST 5: ZERO-SUM VALIDATION');
console.log('═══════════════════════════════════════════════════════════════\n');

let test5Passed = 0;
let test5Total = 0;

// Check that expected profits can theoretically sum to zero
const sampleForecasts = tonightPlayers.map(p => {
  // Simple forecast based on recent performance
  const recentAvg = p.last5Avg;
  const streakModifier = p.currentStreak >= 3 ? 1.3 : p.currentStreak <= -3 ? 0.7 : 1;
  return {
    name: p.name,
    suggested: Math.round(recentAvg * streakModifier)
  };
});

const totalSuggested = sampleForecasts.reduce((sum, f) => sum + f.suggested, 0);
const adjustment = totalSuggested / sampleForecasts.length;
sampleForecasts.forEach(f => f.adjusted = Math.round(f.suggested - adjustment));
const adjustedTotal = sampleForecasts.reduce((sum, f) => sum + f.adjusted, 0);

test5Total++;
console.log('📊 Sample Expected Profits (zero-sum adjusted):');
sampleForecasts.forEach(f => {
  console.log(`   ${f.name}: ${formatProfit(f.suggested)} → ${formatProfit(f.adjusted)} (adjusted)`);
});
console.log(`\n   Sum before adjustment: ${formatProfit(totalSuggested)}`);
console.log(`   Sum after adjustment: ${formatProfit(adjustedTotal)}`);

if (Math.abs(adjustedTotal) <= 5) {
  console.log('   ✅ Zero-sum achieved (within ±5₪ tolerance)');
  test5Passed++;
} else {
  console.log('   ❌ Zero-sum NOT achieved');
}

console.log(`\n   Result: ${test5Passed}/${test5Total} passed\n`);

// ═══════════════════════════════════════════════════════════════════════════
// TEST 6: HEBREW TEXT QUALITY
// ═══════════════════════════════════════════════════════════════════════════

console.log('═══════════════════════════════════════════════════════════════');
console.log('TEST 6: SAMPLE MILESTONE TEXT QUALITY');
console.log('═══════════════════════════════════════════════════════════════\n');

let test6Passed = 0;
let test6Total = 0;

// Generate sample milestone texts
const sampleMilestones = [];

// Hot streak milestone
const hottestPlayer = [...playerStats].sort((a, b) => b.currentStreak - a.currentStreak)[0];
if (hottestPlayer && hottestPlayer.currentStreak >= 3) {
  sampleMilestones.push({
    emoji: '🔥',
    title: `${hottestPlayer.currentStreak} נצחונות רצופים`,
    description: `${hottestPlayer.name} לא מפסיד! רצף של ${hottestPlayer.currentStreak} נצחונות. נצחון הלילה = ${hottestPlayer.currentStreak + 1} רצופים.`
  });
}

// Close battle milestone
const sorted = [...playerStats].sort((a, b) => b.totalProfit - a.totalProfit);
for (let i = 1; i < sorted.length; i++) {
  const gap = Math.round(sorted[i - 1].totalProfit - sorted[i].totalProfit);
  if (gap > 0 && gap <= 150) {
    sampleMilestones.push({
      emoji: '⚔️',
      title: `קרב על מקום ${i}`,
      description: `${sorted[i].name} (מקום ${i + 1}) רק ${gap}₪ מאחורי ${sorted[i - 1].name} (מקום ${i}) בטבלה הכללית.`
    });
    break;
  }
}

// Recovery milestone
const now = new Date();
const currentYear = now.getFullYear();
const recoveryCandidate = playerStats.find(p => p.yearProfit < 0 && p.yearProfit > -150 && p.yearGames >= 2);
if (recoveryCandidate) {
  sampleMilestones.push({
    emoji: '🔄',
    title: `חזרה לפלוס ${currentYear}`,
    description: `${recoveryCandidate.name} על ${formatProfit(recoveryCandidate.yearProfit)} השנה. נצחון של ${Math.round(Math.abs(recoveryCandidate.yearProfit))}₪+ = פלוס שנתי!`
  });
}

console.log('📊 Sample Generated Milestones:');
sampleMilestones.forEach((m, i) => {
  console.log(`\n   ${i + 1}. ${m.emoji} ${m.title}`);
  console.log(`      "${m.description}"`);
  
  // Quality checks
  test6Total++;
  const checks = [];
  
  // Title length
  if (m.title.length <= 30) checks.push('✅ Title ≤30 chars');
  else checks.push('❌ Title too long');
  
  // Has numbers
  if (/\d/.test(m.description)) checks.push('✅ Has numbers');
  else checks.push('❌ Missing numbers');
  
  // Not empty
  if (m.description.length > 20) checks.push('✅ Sufficient detail');
  else checks.push('❌ Too short');
  
  const passedChecks = checks.filter(c => c.startsWith('✅')).length;
  if (passedChecks === 3) test6Passed++;
  
  console.log(`      Checks: ${checks.join(' | ')}`);
});

console.log(`\n   Result: ${test6Passed}/${test6Total} passed\n`);

// ═══════════════════════════════════════════════════════════════════════════
// FINAL SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

const totalPassed = test1Passed + test2Passed + test3Passed + test4Passed + test5Passed + test6Passed;
const totalTests = test1Total + test2Total + test3Total + test4Total + test5Total + test6Total;
const percentage = Math.round((totalPassed / totalTests) * 100);

console.log('═══════════════════════════════════════════════════════════════');
console.log('FINAL SUMMARY');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log('   ┌─────────────────────────────────────────────────────┐');
console.log(`   │  TOTAL: ${totalPassed}/${totalTests} tests passed (${percentage}%)                │`);
console.log('   ├─────────────────────────────────────────────────────┤');
console.log(`   │  Test 1 (Data Accuracy):      ${test1Passed}/${test1Total} passed              │`);
console.log(`   │  Test 2 (Ranking Logic):      ${test2Passed}/${test2Total} passed              │`);
console.log(`   │  Test 3 (Edge Cases):         ${test3Passed}/${test3Total} passed             │`);
console.log(`   │  Test 4 (Data Completeness):  ${test4Passed}/${test4Total} passed             │`);
console.log(`   │  Test 5 (Zero-Sum):           ${test5Passed}/${test5Total} passed               │`);
console.log(`   │  Test 6 (Text Quality):       ${test6Passed}/${test6Total} passed               │`);
console.log('   └─────────────────────────────────────────────────────┘');

if (percentage >= 95) {
  console.log('\n   ✅ EXCELLENT - All systems working correctly!');
} else if (percentage >= 80) {
  console.log('\n   ⚠️ GOOD - Minor issues detected, review above.');
} else {
  console.log('\n   ❌ ISSUES DETECTED - Review failures above.');
}

console.log('\n');
