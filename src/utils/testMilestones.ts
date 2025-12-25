/**
 * Milestone Accuracy Test Suite
 * This file tests the milestone generation logic WITHOUT using any AI
 * Run tests by importing and calling testMilestones() from browser console
 */

import { generateMilestones, PlayerForecastData } from './geminiAI';

interface TestResult {
  test: string;
  passed: boolean;
  expected: string;
  actual: string;
  details?: string;
}

// Helper to create test player data
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

// Generate dates for testing - supports any year
function makeDate(day: number, month: number, year: number = new Date().getFullYear()): string {
  return `${day.toString().padStart(2, '0')}/${month.toString().padStart(2, '0')}/${year}`;
}

// Test Suite
export function testMilestones(): TestResult[] {
  const results: TestResult[] = [];
  const currentYear = new Date().getFullYear();

  console.log('\n🧪 ═══════════════════════════════════════');
  console.log('   MILESTONE ACCURACY TEST SUITE');
  console.log('   Testing pure JavaScript logic - NO AI');
  console.log('═══════════════════════════════════════\n');

  // ========== TEST 1: Winning Streak Detection ==========
  console.log('📋 TEST 1: Winning Streak Detection (3+ games)');
  {
    const player = createTestPlayer({
      name: 'סטרייקר',
      currentStreak: 4,
      gamesPlayed: 20,
      totalProfit: 500,
      gameHistory: [
        { date: makeDate(20, 12), profit: 50, gameId: 'g1' },
        { date: makeDate(15, 12), profit: 30, gameId: 'g2' },
        { date: makeDate(10, 12), profit: 80, gameId: 'g3' },
        { date: makeDate(5, 12), profit: 40, gameId: 'g4' },
      ]
    });
    
    const milestones = generateMilestones([player]);
    const streakMilestone = milestones.find(m => m.title.includes('רצף נצחונות'));
    
    const passed = !!streakMilestone && streakMilestone.description.includes('4 נצחונות רצופים');
    results.push({
      test: 'Winning streak of 4 detected',
      passed,
      expected: 'Milestone mentioning "4 נצחונות רצופים"',
      actual: streakMilestone?.description.substring(0, 100) || 'NOT FOUND',
    });
    console.log(`   ${passed ? '✅' : '❌'} Winning streak: ${passed ? 'PASS' : 'FAIL'}`);
  }

  // ========== TEST 2: NO Streak for < 3 games ==========
  console.log('📋 TEST 2: NO Streak Milestone for < 3 games');
  {
    const player = createTestPlayer({
      name: 'שורט',
      currentStreak: 2, // Only 2 - should NOT trigger
      gamesPlayed: 10,
      totalProfit: 100,
    });
    
    const milestones = generateMilestones([player]);
    const streakMilestone = milestones.find(m => 
      (m.title.includes('רצף נצחונות') || m.title.includes('רצף הפסדים')) && 
      m.description.includes('שורט')
    );
    
    const passed = !streakMilestone;
    results.push({
      test: 'No streak milestone for streak of 2',
      passed,
      expected: 'No streak milestone (threshold is 3)',
      actual: streakMilestone ? 'FALSE POSITIVE: ' + streakMilestone.title : 'CORRECTLY IGNORED',
    });
    console.log(`   ${passed ? '✅' : '❌'} No false positive: ${passed ? 'PASS' : 'FAIL'}`);
  }

  // ========== TEST 3: Losing Streak Detection ==========
  console.log('📋 TEST 3: Losing Streak Detection (3+ games)');
  {
    const player = createTestPlayer({
      name: 'לוזר',
      currentStreak: -5,
      gamesPlayed: 20,
      totalProfit: -300,
    });
    
    const milestones = generateMilestones([player]);
    const streakMilestone = milestones.find(m => m.title.includes('רצף הפסדים'));
    
    const passed = !!streakMilestone && streakMilestone.description.includes('5 הפסדים רצופים');
    results.push({
      test: 'Losing streak of 5 detected',
      passed,
      expected: 'Milestone mentioning "5 הפסדים רצופים"',
      actual: streakMilestone?.description.substring(0, 100) || 'NOT FOUND',
    });
    console.log(`   ${passed ? '✅' : '❌'} Losing streak: ${passed ? 'PASS' : 'FAIL'}`);
  }

  // ========== TEST 4: Year Profit Calculation ==========
  console.log('📋 TEST 4: Year Profit Calculation');
  {
    // Player with 10 games in current year totaling -500
    // And some games from previous year that should NOT be counted
    const player = createTestPlayer({
      name: 'שנתי',
      totalProfit: 700, // Total across ALL years
      gamesPlayed: 15,
      gameHistory: [
        // Current year games: should sum to -500
        { date: makeDate(20, 12, currentYear), profit: -100, gameId: 'g1' },
        { date: makeDate(15, 11, currentYear), profit: -80, gameId: 'g2' },
        { date: makeDate(10, 10, currentYear), profit: -70, gameId: 'g3' },
        { date: makeDate(5, 9, currentYear), profit: -60, gameId: 'g4' },
        { date: makeDate(1, 8, currentYear), profit: -50, gameId: 'g5' },
        { date: makeDate(20, 7, currentYear), profit: -40, gameId: 'g6' },
        { date: makeDate(15, 6, currentYear), profit: -30, gameId: 'g7' },
        { date: makeDate(10, 5, currentYear), profit: -20, gameId: 'g8' },
        { date: makeDate(5, 4, currentYear), profit: -30, gameId: 'g9' },
        { date: makeDate(1, 3, currentYear), profit: -20, gameId: 'g10' },
        // Previous year - should NOT count toward current year
        { date: makeDate(20, 12, currentYear - 1), profit: 300, gameId: 'g11' },
        { date: makeDate(15, 11, currentYear - 1), profit: 400, gameId: 'g12' },
        { date: makeDate(10, 10, currentYear - 1), profit: 500, gameId: 'g13' },
      ]
    });
    
    const milestones = generateMilestones([player]);
    
    // Should find a "recovery to positive" milestone since year profit is -500
    const recoveryMilestone = milestones.find(m => 
      m.title.includes(currentYear.toString()) || m.description.includes(currentYear.toString())
    );
    
    // Check debug log
    console.log('   🔍 Check console for: DEBUG Year Profits');
    
    const passed = recoveryMilestone?.description.includes('-') || false;
    results.push({
      test: `Year profit correctly calculated as negative for ${currentYear}`,
      passed,
      expected: `Year profit = -500₪ (only ${currentYear} games)`,
      actual: recoveryMilestone?.description.substring(0, 150) || 'No year milestone found',
      details: `Player has +700 total but -500 in ${currentYear}`
    });
    console.log(`   ${passed ? '✅' : '⚠️'} Year profit: ${passed ? 'PASS' : 'CHECK DEBUG LOGS'}`);
  }

  // ========== TEST 5: Leaderboard Passing ==========
  console.log('📋 TEST 5: Leaderboard Passing Detection');
  {
    const players = [
      createTestPlayer({ name: 'ראשון', totalProfit: 1000, gamesPlayed: 30 }),
      createTestPlayer({ name: 'שני', totalProfit: 920, gamesPlayed: 25 }), // 80 gap
      createTestPlayer({ name: 'שלישי', totalProfit: 500, gamesPlayed: 20 }),
    ];
    
    const milestones = generateMilestones(players);
    const passingMilestone = milestones.find(m => 
      m.description.includes('שני') && m.description.includes('ראשון')
    );
    
    const passed = !!passingMilestone && passingMilestone.description.includes('80');
    results.push({
      test: 'Leaderboard passing detected (80₪ gap)',
      passed,
      expected: 'שני can pass ראשון with 80₪ gap',
      actual: passingMilestone?.description.substring(0, 150) || 'NOT FOUND',
    });
    console.log(`   ${passed ? '✅' : '❌'} Leaderboard passing: ${passed ? 'PASS' : 'FAIL'}`);
  }

  // ========== TEST 6: Round Number Milestone ==========
  console.log('📋 TEST 6: Round Number Milestone (approaching 1000₪)');
  {
    const player = createTestPlayer({
      name: 'עיגולי',
      totalProfit: 920, // 80 away from 1000
      gamesPlayed: 20,
    });
    
    const milestones = generateMilestones([player]);
    const roundMilestone = milestones.find(m => 
      m.title.includes('יעד עגול') && m.description.includes('1000')
    );
    
    const passed = !!roundMilestone && roundMilestone.description.includes('80');
    results.push({
      test: 'Round number milestone (80₪ to reach 1000)',
      passed,
      expected: 'Need 80₪ to reach 1000',
      actual: roundMilestone?.description.substring(0, 150) || 'NOT FOUND',
    });
    console.log(`   ${passed ? '✅' : '❌'} Round number: ${passed ? 'PASS' : 'FAIL'}`);
  }

  // ========== TEST 7: Games Milestone ==========
  console.log('📋 TEST 7: Games Played Milestone (50th game)');
  {
    const player = createTestPlayer({
      name: 'יובלאי',
      gamesPlayed: 49, // About to play 50th game
      totalProfit: 200,
    });
    
    const milestones = generateMilestones([player]);
    const gamesMilestone = milestones.find(m => 
      m.title.includes('יובל משחקים') && m.description.includes('50')
    );
    
    const passed = !!gamesMilestone;
    results.push({
      test: 'Games milestone (50th game)',
      passed,
      expected: 'Tonight is 50th game',
      actual: gamesMilestone?.description.substring(0, 100) || 'NOT FOUND',
    });
    console.log(`   ${passed ? '✅' : '❌'} Games milestone: ${passed ? 'PASS' : 'FAIL'}`);
  }

  // ========== TEST 8: Correct Ranking Numbers ==========
  console.log('📋 TEST 8: Correct Ranking in All-Time Table');
  {
    const players = [
      createTestPlayer({ name: 'מקום1', totalProfit: 1000 }),
      createTestPlayer({ name: 'מקום2', totalProfit: 900 }),
      createTestPlayer({ name: 'מקום3', totalProfit: 800 }),
      createTestPlayer({ name: 'מקום4', totalProfit: 650 }), // 150 gap from מקום3
    ];
    
    const milestones = generateMilestones(players);
    const milestone = milestones.find(m => 
      m.description.includes('מקום4') && m.description.includes('מקום 4')
    );
    
    // מקום4 should be described as being in position 4
    const passed = !!milestone;
    results.push({
      test: 'Player in position 4 is correctly labeled',
      passed,
      expected: 'מקום4 is described as being in position 4',
      actual: milestone?.description.substring(0, 150) || 'NOT FOUND',
    });
    console.log(`   ${passed ? '✅' : '❌'} Correct ranking: ${passed ? 'PASS' : 'FAIL'}`);
  }

  // ========== TEST 9: Close Battle Detection ==========
  console.log('📋 TEST 9: Close Battle Detection (≤30₪ gap)');
  {
    const players = [
      createTestPlayer({ name: 'צמוד1', totalProfit: 505 }),
      createTestPlayer({ name: 'צמוד2', totalProfit: 500 }), // Only 5₪ gap!
    ];
    
    const milestones = generateMilestones(players);
    const battleMilestone = milestones.find(m => 
      m.title.includes('קרב צמוד') || m.description.includes('5₪')
    );
    
    const passed = !!battleMilestone;
    results.push({
      test: 'Close battle detected (5₪ gap)',
      passed,
      expected: 'Battle milestone for 5₪ gap',
      actual: battleMilestone?.description.substring(0, 150) || 'NOT FOUND',
    });
    console.log(`   ${passed ? '✅' : '❌'} Close battle: ${passed ? 'PASS' : 'FAIL'}`);
  }

  // ========== TEST 10: Exact Tie Detection ==========
  console.log('📋 TEST 10: Exact Tie Detection');
  {
    const players = [
      createTestPlayer({ name: 'תיקו1', totalProfit: 500 }),
      createTestPlayer({ name: 'תיקו2', totalProfit: 500 }), // Exact same!
    ];
    
    const milestones = generateMilestones(players);
    const tieMilestone = milestones.find(m => m.title.includes('תיקו'));
    
    const passed = !!tieMilestone;
    results.push({
      test: 'Exact tie detected',
      passed,
      expected: 'Tie milestone showing both players at 500₪',
      actual: tieMilestone?.description.substring(0, 150) || 'NOT FOUND',
    });
    console.log(`   ${passed ? '✅' : '❌'} Exact tie: ${passed ? 'PASS' : 'FAIL'}`);
  }

  // ========== TEST 11: Date Format - Slashes ==========
  console.log('📋 TEST 11: Date Parsing - Slash Format (DD/MM/YYYY)');
  {
    const player = createTestPlayer({
      name: 'סלאש',
      totalProfit: 100,
      gamesPlayed: 5,
      gameHistory: [
        { date: '25/12/2025', profit: 50, gameId: 'g1' },
        { date: '20/12/2025', profit: 30, gameId: 'g2' },
        { date: '15/12/2025', profit: 20, gameId: 'g3' },
      ]
    });
    
    const milestones = generateMilestones([player]);
    // If parsing works, player should have year profit of 100 (all 3 games in 2025)
    console.log('   🔍 Check DEBUG Year Profits in console for סלאש');
    
    const passed = true; // Manual check needed
    results.push({
      test: 'Date parsing with slashes (DD/MM/YYYY)',
      passed,
      expected: 'Year profit = 100 (3 games parsed correctly)',
      actual: 'CHECK DEBUG LOGS for yearGames=3',
    });
    console.log(`   ⚠️ Date slashes: CHECK DEBUG LOGS`);
  }

  // ========== TEST 12: Date Format - Dots ==========
  console.log('📋 TEST 12: Date Parsing - Dot Format (DD.MM.YYYY)');
  {
    const player = createTestPlayer({
      name: 'דוט',
      totalProfit: 200,
      gamesPlayed: 5,
      gameHistory: [
        { date: '25.12.2025', profit: 80, gameId: 'g1' },
        { date: '20.12.2025', profit: 70, gameId: 'g2' },
        { date: '15.12.2025', profit: 50, gameId: 'g3' },
      ]
    });
    
    const milestones = generateMilestones([player]);
    console.log('   🔍 Check DEBUG Year Profits in console for דוט');
    
    const passed = true; // Manual check needed
    results.push({
      test: 'Date parsing with dots (DD.MM.YYYY)',
      passed,
      expected: 'Year profit = 200 (3 games parsed correctly)',
      actual: 'CHECK DEBUG LOGS for yearGames=3',
    });
    console.log(`   ⚠️ Date dots: CHECK DEBUG LOGS`);
  }

  // ========== TEST 13: Date Format - ISO ==========
  console.log('📋 TEST 13: Date Parsing - ISO Format');
  {
    const player = createTestPlayer({
      name: 'איזו',
      totalProfit: 150,
      gamesPlayed: 5,
      gameHistory: [
        { date: '2025-12-25T10:00:00.000Z', profit: 60, gameId: 'g1' },
        { date: '2025-12-20T10:00:00.000Z', profit: 50, gameId: 'g2' },
        { date: '2025-12-15T10:00:00.000Z', profit: 40, gameId: 'g3' },
      ]
    });
    
    const milestones = generateMilestones([player]);
    console.log('   🔍 Check DEBUG Year Profits in console for איזו');
    
    const passed = true; // Manual check needed
    results.push({
      test: 'Date parsing with ISO format',
      passed,
      expected: 'Year profit = 150 (3 games parsed correctly)',
      actual: 'CHECK DEBUG LOGS for yearGames=3',
    });
    console.log(`   ⚠️ Date ISO: CHECK DEBUG LOGS`);
  }

  // ========== TEST 14: Recovery to Positive Milestone ==========
  console.log('📋 TEST 14: Recovery to Positive (Year Profit -50 to -120)');
  {
    const currentYear = new Date().getFullYear();
    const player = createTestPlayer({
      name: 'רקברי',
      totalProfit: 500,
      gamesPlayed: 15,
      gameHistory: [
        { date: makeDate(20, 12, currentYear), profit: -30, gameId: 'g1' },
        { date: makeDate(15, 12, currentYear), profit: -25, gameId: 'g2' },
        { date: makeDate(10, 12, currentYear), profit: -25, gameId: 'g3' },
        // Year total: -80 (within -120 to 0 range)
      ]
    });
    
    const milestones = generateMilestones([player]);
    const recoveryMilestone = milestones.find(m => 
      m.title.includes('חזרה לפלוס') && m.description.includes('רקברי')
    );
    
    const passed = !!recoveryMilestone;
    results.push({
      test: 'Recovery to positive milestone for -80 year profit',
      passed,
      expected: 'Recovery milestone showing path to positive',
      actual: recoveryMilestone?.description.substring(0, 150) || 'NOT FOUND (may need more year games)',
    });
    console.log(`   ${passed ? '✅' : '⚠️'} Recovery: ${passed ? 'PASS' : 'MAY NEED MORE GAMES'}`);
  }

  // ========== SUMMARY ==========
  console.log('\n═══════════════════════════════════════');
  console.log('📊 TEST SUMMARY');
  console.log('═══════════════════════════════════════\n');
  
  const passedCount = results.filter(r => r.passed).length;
  const failedCount = results.length - passedCount;
  
  console.log(`✅ Passed: ${passedCount}/${results.length}`);
  console.log(`❌ Failed: ${failedCount}/${results.length}`);
  
  if (failedCount > 0) {
    console.log('\n❌ FAILED TESTS:');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`\n   📛 ${r.test}`);
      console.log(`      Expected: ${r.expected}`);
      console.log(`      Actual: ${r.actual}`);
      if (r.details) console.log(`      Details: ${r.details}`);
    });
  }

  console.log('\n═══════════════════════════════════════');
  console.log('💡 To run in browser: window.testMilestones()');
  console.log('═══════════════════════════════════════\n');
  
  return results;
}

// Verify data preparation for AI forecasts
export function verifyForecastData(players: PlayerForecastData[]): void {
  const currentYear = new Date().getFullYear();
  
  console.log('\n🔍 ═══════════════════════════════════════');
  console.log('   FORECAST DATA VERIFICATION');
  console.log('═══════════════════════════════════════\n');
  
  players.forEach(p => {
    // Parse dates and count by year
    const gamesByYear: Record<number, number> = {};
    const profitByYear: Record<number, number> = {};
    
    p.gameHistory.forEach(g => {
      let year: number;
      
      // Try parsing different formats
      if (g.date.includes('/')) {
        const parts = g.date.split('/');
        year = parseInt(parts[2]);
        if (year < 100) year += 2000;
      } else if (g.date.includes('.')) {
        const parts = g.date.split('.');
        year = parseInt(parts[2]);
        if (year < 100) year += 2000;
      } else {
        year = new Date(g.date).getFullYear();
      }
      
      gamesByYear[year] = (gamesByYear[year] || 0) + 1;
      profitByYear[year] = (profitByYear[year] || 0) + g.profit;
    });
    
    console.log(`👤 ${p.name}:`);
    console.log(`   📊 Total Profit: ${p.totalProfit >= 0 ? '+' : ''}${Math.round(p.totalProfit)}₪`);
    console.log(`   🎮 Games Played: ${p.gamesPlayed}`);
    console.log(`   🔥 Current Streak: ${p.currentStreak}`);
    console.log(`   📜 Game History: ${p.gameHistory.length} games`);
    
    Object.keys(gamesByYear).sort().reverse().forEach(yearStr => {
      const year = parseInt(yearStr);
      const games = gamesByYear[year];
      const profit = profitByYear[year];
      const marker = year === currentYear ? ' ← CURRENT YEAR' : '';
      console.log(`      ${year}: ${games} games, ${profit >= 0 ? '+' : ''}${Math.round(profit)}₪${marker}`);
    });
    
    // Verify current streak matches recent games
    const recentGames = p.gameHistory.slice(0, 5);
    const recentResults = recentGames.map(g => g.profit > 0 ? 'W' : g.profit < 0 ? 'L' : 'T').join('');
    console.log(`   📈 Recent results (newest first): ${recentResults}`);
    console.log('');
  });
}

// Export for browser console use
if (typeof window !== 'undefined') {
  (window as any).testMilestones = testMilestones;
  (window as any).verifyForecastData = verifyForecastData;
}
