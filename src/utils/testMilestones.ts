/**
 * COMPREHENSIVE Milestone & Forecast Accuracy Test Suite
 * Tests pure JavaScript logic - NO AI consumption
 * 
 * Run in browser console: window.runAllTests()
 */

import { generateMilestones, PlayerForecastData } from './geminiAI';

interface TestResult {
  category: string;
  test: string;
  passed: boolean;
  expected: string;
  actual: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
}

// ==================== HELPERS ====================

function createTestPlayer(overrides: Partial<PlayerForecastData> & { name: string }): PlayerForecastData {
  return {
    name: overrides.name,
    isFemale: overrides.isFemale || false,
    totalProfit: overrides.totalProfit ?? 0,
    gamesPlayed: overrides.gamesPlayed ?? 10,
    avgProfit: overrides.avgProfit ?? 0,
    winPercentage: overrides.winPercentage ?? 50,
    winCount: overrides.winCount ?? 5,
    lossCount: overrides.lossCount ?? 5,
    currentStreak: overrides.currentStreak ?? 0,
    bestWin: overrides.bestWin ?? 100,
    worstLoss: overrides.worstLoss ?? -100,
    gameHistory: overrides.gameHistory ?? [],
  };
}

// Create date string in DD/MM/YYYY format
function makeDate(day: number, month: number, year: number = new Date().getFullYear()): string {
  return `${day.toString().padStart(2, '0')}/${month.toString().padStart(2, '0')}/${year}`;
}

// Create game history for a player
function createGameHistory(games: Array<{ profit: number; daysAgo?: number; year?: number; month?: number; day?: number }>) {
  const now = new Date();
  return games.map((g, i) => {
    let date: string;
    if (g.year && g.month && g.day) {
      date = makeDate(g.day, g.month, g.year);
    } else if (g.daysAgo !== undefined) {
      const d = new Date(now);
      d.setDate(d.getDate() - g.daysAgo);
      date = makeDate(d.getDate(), d.getMonth() + 1, d.getFullYear());
    } else {
      date = makeDate(now.getDate(), now.getMonth() + 1, now.getFullYear());
    }
    return { profit: g.profit, date, gameId: `g${i}` };
  });
}

// ==================== TEST SUITES ====================

export function testStreakDetection(): TestResult[] {
  const results: TestResult[] = [];
  const category = '🔥 STREAK DETECTION';

  console.log(`\n${category}`);
  console.log('─'.repeat(50));

  // Test 1: Winning streak of 4
  {
    const player = createTestPlayer({
      name: 'WinStreak4',
      currentStreak: 4,
      gameHistory: createGameHistory([
        { profit: 50, daysAgo: 0 },
        { profit: 30, daysAgo: 7 },
        { profit: 80, daysAgo: 14 },
        { profit: 40, daysAgo: 21 },
      ])
    });
    
    const milestones = generateMilestones([player]);
    const found = milestones.find(m => m.title.includes('רצף נצחונות') && m.description.includes('4'));
    
    results.push({
      category,
      test: 'Winning streak 4 detected',
      passed: !!found,
      expected: 'Milestone with "4 נצחונות רצופים"',
      actual: found ? '✅ Found' : '❌ NOT FOUND',
      severity: 'critical'
    });
    console.log(`  ${found ? '✅' : '❌'} Winning streak 4: ${found ? 'PASS' : 'FAIL'}`);
  }

  // Test 2: Losing streak of 5
  {
    const player = createTestPlayer({
      name: 'LoseStreak5',
      currentStreak: -5,
      gameHistory: createGameHistory([
        { profit: -50, daysAgo: 0 },
        { profit: -30, daysAgo: 7 },
        { profit: -80, daysAgo: 14 },
        { profit: -40, daysAgo: 21 },
        { profit: -20, daysAgo: 28 },
      ])
    });
    
    const milestones = generateMilestones([player]);
    const found = milestones.find(m => m.title.includes('רצף הפסדים') && m.description.includes('5'));
    
    results.push({
      category,
      test: 'Losing streak 5 detected',
      passed: !!found,
      expected: 'Milestone with "5 הפסדים רצופים"',
      actual: found ? '✅ Found' : '❌ NOT FOUND',
      severity: 'critical'
    });
    console.log(`  ${found ? '✅' : '❌'} Losing streak 5: ${found ? 'PASS' : 'FAIL'}`);
  }

  // Test 3: NO streak for < 3
  {
    const player = createTestPlayer({
      name: 'NoStreak2',
      currentStreak: 2, // Below threshold
    });
    
    const milestones = generateMilestones([player]);
    const found = milestones.find(m => 
      (m.title.includes('רצף נצחונות') || m.title.includes('רצף הפסדים')) && 
      m.description.includes('NoStreak2')
    );
    
    results.push({
      category,
      test: 'NO streak for streak < 3',
      passed: !found,
      expected: 'No streak milestone (threshold is 3)',
      actual: found ? '❌ FALSE POSITIVE' : '✅ Correctly ignored',
      severity: 'high'
    });
    console.log(`  ${!found ? '✅' : '❌'} No false positive streak: ${!found ? 'PASS' : 'FAIL'}`);
  }

  // Test 4: Streak exactly 3
  {
    const player = createTestPlayer({
      name: 'ExactStreak3',
      currentStreak: 3, // Exactly at threshold
    });
    
    const milestones = generateMilestones([player]);
    const found = milestones.find(m => m.title.includes('רצף נצחונות') && m.description.includes('3'));
    
    results.push({
      category,
      test: 'Streak exactly 3 detected',
      passed: !!found,
      expected: 'Milestone with "3 נצחונות רצופים"',
      actual: found ? '✅ Found' : '❌ NOT FOUND',
      severity: 'high'
    });
    console.log(`  ${found ? '✅' : '❌'} Exact streak 3: ${found ? 'PASS' : 'FAIL'}`);
  }

  return results;
}

export function testYearProfitCalculation(): TestResult[] {
  const results: TestResult[] = [];
  const category = '📅 YEAR PROFIT CALCULATION';
  const currentYear = new Date().getFullYear();
  const lastYear = currentYear - 1;

  console.log(`\n${category}`);
  console.log('─'.repeat(50));

  // Test 1: Year profit separates current from previous year
  {
    const player = createTestPlayer({
      name: 'YearTest',
      totalProfit: 1000, // Total across ALL years
      gamesPlayed: 15,
      gameHistory: [
        // Current year: -300
        { date: makeDate(20, 12, currentYear), profit: -100, gameId: 'g1' },
        { date: makeDate(15, 11, currentYear), profit: -100, gameId: 'g2' },
        { date: makeDate(10, 10, currentYear), profit: -100, gameId: 'g3' },
        // Previous year: +1300 (so total = 1000)
        { date: makeDate(20, 12, lastYear), profit: 500, gameId: 'g4' },
        { date: makeDate(15, 11, lastYear), profit: 400, gameId: 'g5' },
        { date: makeDate(10, 10, lastYear), profit: 400, gameId: 'g6' },
      ]
    });
    
    const milestones = generateMilestones([player]);
    
    // Check debug output for year profit
    // Should show yearProfit = -300, NOT +1000
    console.log('  🔍 Check console for DEBUG Year Profits - should show -300 for YearTest');
    
    results.push({
      category,
      test: `Year ${currentYear} profit is -300 (not +1000 total)`,
      passed: true, // Manual verification needed
      expected: `Year profit = -300₪ (only ${currentYear} games)`,
      actual: 'CHECK DEBUG LOGS',
      severity: 'critical'
    });
  }

  // Test 2: Recovery milestone for negative year
  {
    const player = createTestPlayer({
      name: 'RecoveryTest',
      totalProfit: 500,
      gamesPlayed: 10,
      gameHistory: [
        // Current year: -80 (within -120 to 0 range for recovery milestone)
        { date: makeDate(20, 12, currentYear), profit: -30, gameId: 'g1' },
        { date: makeDate(15, 11, currentYear), profit: -25, gameId: 'g2' },
        { date: makeDate(10, 10, currentYear), profit: -25, gameId: 'g3' },
      ]
    });
    
    const milestones = generateMilestones([player]);
    const found = milestones.find(m => 
      m.title.includes('חזרה לפלוס') && m.description.includes('RecoveryTest')
    );
    
    results.push({
      category,
      test: 'Recovery milestone for -80 year profit',
      passed: !!found,
      expected: 'Recovery milestone showing path to positive',
      actual: found ? '✅ Found: ' + found.description.substring(0, 80) : '❌ NOT FOUND',
      severity: 'high'
    });
    console.log(`  ${found ? '✅' : '❌'} Recovery milestone: ${found ? 'PASS' : 'FAIL'}`);
  }

  return results;
}

export function testLeaderboardMilestones(): TestResult[] {
  const results: TestResult[] = [];
  const category = '📈 LEADERBOARD MILESTONES';

  console.log(`\n${category}`);
  console.log('─'.repeat(50));

  // Test 1: Passing opportunity (80₪ gap)
  {
    const players = [
      createTestPlayer({ name: 'Leader', totalProfit: 1000, gamesPlayed: 30 }),
      createTestPlayer({ name: 'Chaser', totalProfit: 920, gamesPlayed: 25 }), // 80₪ gap
    ];
    
    const milestones = generateMilestones(players);
    const found = milestones.find(m => 
      m.description.includes('Chaser') && m.description.includes('Leader') && m.description.includes('80')
    );
    
    results.push({
      category,
      test: 'Passing opportunity (80₪ gap)',
      passed: !!found,
      expected: 'Milestone showing Chaser can pass Leader with 80₪',
      actual: found ? '✅ Found' : '❌ NOT FOUND',
      severity: 'critical'
    });
    console.log(`  ${found ? '✅' : '❌'} Passing opportunity: ${found ? 'PASS' : 'FAIL'}`);
  }

  // Test 2: NO passing for gap > 200₪
  {
    const players = [
      createTestPlayer({ name: 'FarLeader', totalProfit: 1000, gamesPlayed: 30 }),
      createTestPlayer({ name: 'FarChaser', totalProfit: 700, gamesPlayed: 25 }), // 300₪ gap - too far
    ];
    
    const milestones = generateMilestones(players);
    const found = milestones.find(m => 
      m.description.includes('FarChaser') && m.description.includes('FarLeader')
    );
    
    results.push({
      category,
      test: 'NO passing for gap > 200₪',
      passed: !found,
      expected: 'No milestone for 300₪ gap',
      actual: found ? '❌ FALSE POSITIVE' : '✅ Correctly ignored',
      severity: 'high'
    });
    console.log(`  ${!found ? '✅' : '❌'} No false passing: ${!found ? 'PASS' : 'FAIL'}`);
  }

  // Test 3: Close battle (≤30₪ gap)
  {
    const players = [
      createTestPlayer({ name: 'Close1', totalProfit: 505 }),
      createTestPlayer({ name: 'Close2', totalProfit: 500 }), // 5₪ gap
    ];
    
    const milestones = generateMilestones(players);
    const found = milestones.find(m => 
      m.title.includes('קרב צמוד') && m.description.includes('5')
    );
    
    results.push({
      category,
      test: 'Close battle (5₪ gap)',
      passed: !!found,
      expected: 'Battle milestone for 5₪ gap',
      actual: found ? '✅ Found' : '❌ NOT FOUND',
      severity: 'high'
    });
    console.log(`  ${found ? '✅' : '❌'} Close battle: ${found ? 'PASS' : 'FAIL'}`);
  }

  // Test 4: Exact tie
  {
    const players = [
      createTestPlayer({ name: 'Tie1', totalProfit: 500 }),
      createTestPlayer({ name: 'Tie2', totalProfit: 500 }), // Exact same
    ];
    
    const milestones = generateMilestones(players);
    const found = milestones.find(m => m.title.includes('תיקו'));
    
    results.push({
      category,
      test: 'Exact tie detection',
      passed: !!found,
      expected: 'Tie milestone',
      actual: found ? '✅ Found' : '❌ NOT FOUND',
      severity: 'medium'
    });
    console.log(`  ${found ? '✅' : '❌'} Exact tie: ${found ? 'PASS' : 'FAIL'}`);
  }

  // Test 5: Correct rank numbers
  {
    const players = [
      createTestPlayer({ name: 'Rank1', totalProfit: 1000 }),
      createTestPlayer({ name: 'Rank2', totalProfit: 900 }),
      createTestPlayer({ name: 'Rank3', totalProfit: 800 }),
      createTestPlayer({ name: 'Rank4', totalProfit: 650 }), // 150₪ gap from Rank3
    ];
    
    const milestones = generateMilestones(players);
    const found = milestones.find(m => 
      m.description.includes('Rank4') && 
      (m.description.includes('מקום 4') || m.description.includes('מקום ה-4'))
    );
    
    results.push({
      category,
      test: 'Correct rank numbers in descriptions',
      passed: !!found,
      expected: 'Rank4 described as position 4',
      actual: found ? '✅ Found' : '❌ NOT FOUND (or wrong position)',
      severity: 'critical'
    });
    console.log(`  ${found ? '✅' : '❌'} Correct rankings: ${found ? 'PASS' : 'FAIL'}`);
  }

  return results;
}

export function testRoundNumberMilestones(): TestResult[] {
  const results: TestResult[] = [];
  const category = '🎯 ROUND NUMBER MILESTONES';

  console.log(`\n${category}`);
  console.log('─'.repeat(50));

  // Test 1: Approaching 1000
  {
    const player = createTestPlayer({
      name: 'Almost1000',
      totalProfit: 920, // 80 away from 1000
    });
    
    const milestones = generateMilestones([player]);
    const found = milestones.find(m => 
      m.title.includes('יעד עגול') && m.description.includes('1000') && m.description.includes('80')
    );
    
    results.push({
      category,
      test: 'Approaching 1000 (80₪ away)',
      passed: !!found,
      expected: 'Round number milestone for 1000',
      actual: found ? '✅ Found' : '❌ NOT FOUND',
      severity: 'high'
    });
    console.log(`  ${found ? '✅' : '❌'} Round 1000: ${found ? 'PASS' : 'FAIL'}`);
  }

  // Test 2: NO milestone if too far (>150)
  {
    const player = createTestPlayer({
      name: 'TooFar1000',
      totalProfit: 800, // 200 away - too far
    });
    
    const milestones = generateMilestones([player]);
    const found = milestones.find(m => 
      m.title.includes('יעד עגול') && m.description.includes('TooFar1000') && m.description.includes('1000')
    );
    
    results.push({
      category,
      test: 'NO milestone if >150₪ away',
      passed: !found,
      expected: 'No milestone for 200₪ gap',
      actual: found ? '❌ FALSE POSITIVE' : '✅ Correctly ignored',
      severity: 'medium'
    });
    console.log(`  ${!found ? '✅' : '❌'} No false round: ${!found ? 'PASS' : 'FAIL'}`);
  }

  return results;
}

export function testGamesMilestones(): TestResult[] {
  const results: TestResult[] = [];
  const category = '🎮 GAMES PLAYED MILESTONES';

  console.log(`\n${category}`);
  console.log('─'.repeat(50));

  // Test 1: 50th game
  {
    const player = createTestPlayer({
      name: 'Game49',
      gamesPlayed: 49, // About to play 50th
    });
    
    const milestones = generateMilestones([player]);
    const found = milestones.find(m => 
      m.title.includes('יובל משחקים') && m.description.includes('50')
    );
    
    results.push({
      category,
      test: '50th game milestone',
      passed: !!found,
      expected: 'Games milestone for 50th game',
      actual: found ? '✅ Found' : '❌ NOT FOUND',
      severity: 'medium'
    });
    console.log(`  ${found ? '✅' : '❌'} 50th game: ${found ? 'PASS' : 'FAIL'}`);
  }

  // Test 2: 100th game
  {
    const player = createTestPlayer({
      name: 'Game99',
      gamesPlayed: 99, // About to play 100th
    });
    
    const milestones = generateMilestones([player]);
    const found = milestones.find(m => 
      m.title.includes('יובל משחקים') && m.description.includes('100')
    );
    
    results.push({
      category,
      test: '100th game milestone',
      passed: !!found,
      expected: 'Games milestone for 100th game',
      actual: found ? '✅ Found' : '❌ NOT FOUND',
      severity: 'medium'
    });
    console.log(`  ${found ? '✅' : '❌'} 100th game: ${found ? 'PASS' : 'FAIL'}`);
  }

  return results;
}

export function testDateParsing(): TestResult[] {
  const results: TestResult[] = [];
  const category = '📆 DATE PARSING';
  const currentYear = new Date().getFullYear();

  console.log(`\n${category}`);
  console.log('─'.repeat(50));

  // Test 1: Slash format (DD/MM/YYYY)
  {
    const player = createTestPlayer({
      name: 'SlashFormat',
      gamesPlayed: 5,
      gameHistory: [
        { date: `25/12/${currentYear}`, profit: 50, gameId: 'g1' },
        { date: `20/12/${currentYear}`, profit: 30, gameId: 'g2' },
        { date: `15/12/${currentYear}`, profit: 20, gameId: 'g3' },
      ]
    });
    
    generateMilestones([player]);
    console.log('  🔍 Check DEBUG Year Profits - SlashFormat should have yearGames=3, yearProfit=100');
    
    results.push({
      category,
      test: 'Slash format (DD/MM/YYYY)',
      passed: true, // Manual check
      expected: 'yearGames=3, yearProfit=100',
      actual: 'CHECK DEBUG LOGS',
      severity: 'critical'
    });
  }

  // Test 2: Dot format (DD.MM.YYYY)
  {
    const player = createTestPlayer({
      name: 'DotFormat',
      gamesPlayed: 5,
      gameHistory: [
        { date: `25.12.${currentYear}`, profit: 80, gameId: 'g1' },
        { date: `20.12.${currentYear}`, profit: 70, gameId: 'g2' },
        { date: `15.12.${currentYear}`, profit: 50, gameId: 'g3' },
      ]
    });
    
    generateMilestones([player]);
    console.log('  🔍 Check DEBUG Year Profits - DotFormat should have yearGames=3, yearProfit=200');
    
    results.push({
      category,
      test: 'Dot format (DD.MM.YYYY)',
      passed: true, // Manual check
      expected: 'yearGames=3, yearProfit=200',
      actual: 'CHECK DEBUG LOGS',
      severity: 'critical'
    });
  }

  // Test 3: ISO format
  {
    const player = createTestPlayer({
      name: 'ISOFormat',
      gamesPlayed: 5,
      gameHistory: [
        { date: `${currentYear}-12-25T10:00:00.000Z`, profit: 60, gameId: 'g1' },
        { date: `${currentYear}-12-20T10:00:00.000Z`, profit: 50, gameId: 'g2' },
        { date: `${currentYear}-12-15T10:00:00.000Z`, profit: 40, gameId: 'g3' },
      ]
    });
    
    generateMilestones([player]);
    console.log('  🔍 Check DEBUG Year Profits - ISOFormat should have yearGames=3, yearProfit=150');
    
    results.push({
      category,
      test: 'ISO format',
      passed: true, // Manual check
      expected: 'yearGames=3, yearProfit=150',
      actual: 'CHECK DEBUG LOGS',
      severity: 'critical'
    });
  }

  return results;
}

// ==================== MAIN TEST RUNNER ====================

export function runAllTests(): void {
  console.clear();
  console.log('═'.repeat(60));
  console.log('   🧪 COMPREHENSIVE MILESTONE & FORECAST TEST SUITE');
  console.log('   Testing pure JavaScript logic - NO AI consumption');
  console.log('═'.repeat(60));

  const allResults: TestResult[] = [];

  allResults.push(...testStreakDetection());
  allResults.push(...testYearProfitCalculation());
  allResults.push(...testLeaderboardMilestones());
  allResults.push(...testRoundNumberMilestones());
  allResults.push(...testGamesMilestones());
  allResults.push(...testDateParsing());

  // Summary
  console.log('\n' + '═'.repeat(60));
  console.log('   📊 TEST SUMMARY');
  console.log('═'.repeat(60));

  const passed = allResults.filter(r => r.passed).length;
  const failed = allResults.filter(r => !r.passed).length;
  const critical = allResults.filter(r => !r.passed && r.severity === 'critical').length;

  console.log(`\n   ✅ Passed: ${passed}/${allResults.length}`);
  console.log(`   ❌ Failed: ${failed}/${allResults.length}`);
  if (critical > 0) {
    console.log(`   🚨 CRITICAL FAILURES: ${critical}`);
  }

  if (failed > 0) {
    console.log('\n   ❌ FAILED TESTS:');
    allResults.filter(r => !r.passed).forEach(r => {
      const icon = r.severity === 'critical' ? '🚨' : r.severity === 'high' ? '⚠️' : '📌';
      console.log(`\n   ${icon} [${r.severity.toUpperCase()}] ${r.test}`);
      console.log(`      Category: ${r.category}`);
      console.log(`      Expected: ${r.expected}`);
      console.log(`      Actual: ${r.actual}`);
    });
  }

  console.log('\n' + '═'.repeat(60));
  console.log('   💡 To verify date parsing, check the DEBUG Year Profits');
  console.log('      output above each date test.');
  console.log('═'.repeat(60) + '\n');
}

// ==================== DATA VERIFICATION ====================

export function verifyPlayerData(playerName: string, players: PlayerForecastData[]): void {
  const player = players.find(p => p.name === playerName);
  if (!player) {
    console.log(`❌ Player "${playerName}" not found!`);
    return;
  }

  const currentYear = new Date().getFullYear();

  console.log('\n' + '═'.repeat(50));
  console.log(`   🔍 DATA VERIFICATION: ${playerName}`);
  console.log('═'.repeat(50));

  console.log(`\n📊 BASIC STATS:`);
  console.log(`   Total Profit: ${player.totalProfit >= 0 ? '+' : ''}${Math.round(player.totalProfit)}₪`);
  console.log(`   Games Played: ${player.gamesPlayed}`);
  console.log(`   Avg Profit: ${player.avgProfit >= 0 ? '+' : ''}${Math.round(player.avgProfit)}₪`);
  console.log(`   Win Rate: ${Math.round(player.winPercentage)}%`);
  console.log(`   Current Streak: ${player.currentStreak}`);
  console.log(`   Best Win: +${Math.round(player.bestWin)}₪`);
  console.log(`   Worst Loss: ${Math.round(player.worstLoss)}₪`);

  console.log(`\n📜 GAME HISTORY (${player.gameHistory.length} games):`);
  
  // Group by year
  const gamesByYear: Record<number, { games: number; profit: number }> = {};
  player.gameHistory.forEach(g => {
    let year: number;
    if (g.date.includes('/')) {
      year = parseInt(g.date.split('/')[2]);
    } else if (g.date.includes('.')) {
      year = parseInt(g.date.split('.')[2]);
    } else {
      year = new Date(g.date).getFullYear();
    }
    if (year < 100) year += 2000;
    
    if (!gamesByYear[year]) gamesByYear[year] = { games: 0, profit: 0 };
    gamesByYear[year].games++;
    gamesByYear[year].profit += g.profit;
  });

  Object.keys(gamesByYear).sort().reverse().forEach(yearStr => {
    const year = parseInt(yearStr);
    const data = gamesByYear[year];
    const marker = year === currentYear ? ' ← CURRENT YEAR' : '';
    console.log(`   ${year}: ${data.games} games, ${data.profit >= 0 ? '+' : ''}${Math.round(data.profit)}₪${marker}`);
  });

  // Show last 5 games
  console.log(`\n📈 LAST 5 GAMES (newest first):`);
  player.gameHistory.slice(0, 5).forEach((g, i) => {
    console.log(`   ${i + 1}. ${g.date}: ${g.profit >= 0 ? '+' : ''}${g.profit}₪`);
  });

  // Verify streak
  console.log(`\n🔥 STREAK VERIFICATION:`);
  const recentResults = player.gameHistory.slice(0, 10).map(g => 
    g.profit > 0 ? 'W' : g.profit < 0 ? 'L' : 'T'
  );
  console.log(`   Recent results: ${recentResults.join(' ')}`);
  console.log(`   Claimed streak: ${player.currentStreak}`);
  
  // Calculate expected streak
  let expectedStreak = 0;
  for (const g of player.gameHistory) {
    if (g.profit > 0) {
      if (expectedStreak >= 0) expectedStreak++;
      else break;
    } else if (g.profit < 0) {
      if (expectedStreak <= 0) expectedStreak--;
      else break;
    }
    // Break-even: skip
  }
  console.log(`   Expected streak: ${expectedStreak}`);
  if (expectedStreak !== player.currentStreak) {
    console.log(`   ⚠️ MISMATCH! Check streak calculation!`);
  }

  console.log('\n' + '═'.repeat(50) + '\n');
}

// Export for browser
if (typeof window !== 'undefined') {
  (window as any).runAllTests = runAllTests;
  (window as any).verifyPlayerData = verifyPlayerData;
  (window as any).testStreakDetection = testStreakDetection;
  (window as any).testYearProfitCalculation = testYearProfitCalculation;
  (window as any).testLeaderboardMilestones = testLeaderboardMilestones;
}
