/**
 * Milestone Accuracy Test Suite
 * Run with: npx ts-node src/utils/testMilestones.ts
 * Or import and call testMilestones() from browser console
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

// Generate dates for 2025
function makeDate(day: number, month: number, year: number = 2025): string {
  return `${day.toString().padStart(2, '0')}/${month.toString().padStart(2, '0')}/${year}`;
}

// Test Suite
export function testMilestones(): TestResult[] {
  const results: TestResult[] = [];
  const currentYear = new Date().getFullYear();

  console.log('\n🧪 MILESTONE ACCURACY TEST SUITE');
  console.log('================================\n');

  // ========== TEST 1: Winning Streak Detection ==========
  console.log('📋 TEST 1: Winning Streak Detection');
  {
    const player = createTestPlayer({
      name: 'סטרייקר',
      currentStreak: 4, // 4 consecutive wins
      gameHistory: [
        { date: makeDate(20, 12), profit: 50 },
        { date: makeDate(15, 12), profit: 30 },
        { date: makeDate(10, 12), profit: 80 },
        { date: makeDate(5, 12), profit: 40 },
      ]
    });
    
    const milestones = generateMilestones([player]);
    const streakMilestone = milestones.find(m => m.title.includes('רצף נצחונות'));
    
    const passed = !!streakMilestone && streakMilestone.description.includes('4 נצחונות רצופים');
    results.push({
      test: 'Winning streak of 4 detected',
      passed,
      expected: 'Milestone mentioning 4 consecutive wins',
      actual: streakMilestone?.description || 'NOT FOUND',
    });
    console.log(`   ${passed ? '✅' : '❌'} Winning streak of 4: ${passed ? 'DETECTED' : 'FAILED'}`);
  }

  // ========== TEST 2: Losing Streak Detection ==========
  console.log('📋 TEST 2: Losing Streak Detection');
  {
    const player = createTestPlayer({
      name: 'לוזר',
      currentStreak: -5, // 5 consecutive losses
      gameHistory: [
        { date: makeDate(20, 12), profit: -50 },
        { date: makeDate(15, 12), profit: -30 },
        { date: makeDate(10, 12), profit: -80 },
        { date: makeDate(5, 12), profit: -40 },
        { date: makeDate(1, 12), profit: -20 },
      ]
    });
    
    const milestones = generateMilestones([player]);
    const streakMilestone = milestones.find(m => m.title.includes('רצף הפסדים'));
    
    const passed = !!streakMilestone && streakMilestone.description.includes('5 הפסדים רצופים');
    results.push({
      test: 'Losing streak of 5 detected',
      passed,
      expected: 'Milestone mentioning 5 consecutive losses',
      actual: streakMilestone?.description || 'NOT FOUND',
    });
    console.log(`   ${passed ? '✅' : '❌'} Losing streak of 5: ${passed ? 'DETECTED' : 'FAILED'}`);
  }

  // ========== TEST 3: Year Profit Calculation ==========
  console.log('📋 TEST 3: Year Profit Calculation');
  {
    // Player with games in 2025 and 2024
    const player = createTestPlayer({
      name: 'תומר',
      totalProfit: 500, // Total across all years
      gamesPlayed: 20,
      gameHistory: [
        // 2025 games - should sum to -200
        { date: makeDate(20, 12, 2025), profit: -50 },
        { date: makeDate(15, 11, 2025), profit: -80 },
        { date: makeDate(10, 10, 2025), profit: -30 },
        { date: makeDate(5, 9, 2025), profit: -20 },
        { date: makeDate(1, 8, 2025), profit: -20 },
        // 2024 games - should NOT be counted for 2025
        { date: makeDate(20, 12, 2024), profit: 200 },
        { date: makeDate(15, 11, 2024), profit: 250 },
        { date: makeDate(10, 10, 2024), profit: 150 },
      ]
    });
    
    const milestones = generateMilestones([player]);
    
    // Check if we see the CORRECT year profit in any milestone
    // If there's a "recovery to positive" milestone, it should show -200
    const recoveryMilestone = milestones.find(m => 
      m.title.includes(currentYear.toString()) && m.description.includes('תומר')
    );
    
    // Also check the debug log
    // The year profit should be -200, not +500 or any other number
    const yearProfitCorrect = recoveryMilestone?.description.includes('-200');
    
    results.push({
      test: 'Year profit calculated correctly (should be -200 for 2025)',
      passed: !!yearProfitCorrect,
      expected: 'Year profit = -200₪ (sum of 2025 games only)',
      actual: recoveryMilestone?.description || 'No year-related milestone',
      details: 'Player has +500 total but -200 in 2025'
    });
    console.log(`   ${yearProfitCorrect ? '✅' : '❌'} Year profit = -200₪: ${yearProfitCorrect ? 'CORRECT' : 'CHECK DEBUG LOGS'}`);
  }

  // ========== TEST 4: Leaderboard Passing ==========
  console.log('📋 TEST 4: Leaderboard Passing');
  {
    const players = [
      createTestPlayer({ name: 'ראשון', totalProfit: 1000 }),
      createTestPlayer({ name: 'שני', totalProfit: 920 }), // 80 gap - should trigger
      createTestPlayer({ name: 'שלישי', totalProfit: 500 }),
    ];
    
    const milestones = generateMilestones(players);
    const passingMilestone = milestones.find(m => 
      m.title.includes('מרדף') && m.description.includes('שני') && m.description.includes('ראשון')
    );
    
    const passed = !!passingMilestone && passingMilestone.description.includes('80');
    results.push({
      test: 'Leaderboard passing detected (80₪ gap)',
      passed,
      expected: 'שני can pass ראשון with 80₪ gap',
      actual: passingMilestone?.description || 'NOT FOUND',
    });
    console.log(`   ${passed ? '✅' : '❌'} Leaderboard passing: ${passed ? 'CORRECT' : 'FAILED'}`);
  }

  // ========== TEST 5: Round Number Milestone ==========
  console.log('📋 TEST 5: Round Number Milestone');
  {
    const player = createTestPlayer({
      name: 'עיגולי',
      totalProfit: 920, // 80 away from 1000
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
      actual: roundMilestone?.description || 'NOT FOUND',
    });
    console.log(`   ${passed ? '✅' : '❌'} Round number milestone: ${passed ? 'CORRECT' : 'FAILED'}`);
  }

  // ========== TEST 6: Games Milestone ==========
  console.log('📋 TEST 6: Games Milestone');
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
      actual: gamesMilestone?.description || 'NOT FOUND',
    });
    console.log(`   ${passed ? '✅' : '❌'} Games milestone: ${passed ? 'CORRECT' : 'FAILED'}`);
  }

  // ========== TEST 7: NO FALSE POSITIVES - Streak ==========
  console.log('📋 TEST 7: No False Positive Streaks');
  {
    const player = createTestPlayer({
      name: 'נורמלי',
      currentStreak: 1, // Only 1 game streak - should NOT trigger milestone
      gameHistory: [{ date: makeDate(20, 12), profit: 50 }]
    });
    
    const milestones = generateMilestones([player]);
    const streakMilestone = milestones.find(m => 
      m.title.includes('רצף') && m.description.includes('נורמלי')
    );
    
    const passed = !streakMilestone; // Should NOT find any streak milestone
    results.push({
      test: 'No false positive for streak of 1',
      passed,
      expected: 'No streak milestone (streak too short)',
      actual: streakMilestone ? 'FALSE POSITIVE: ' + streakMilestone.description : 'CORRECTLY IGNORED',
    });
    console.log(`   ${passed ? '✅' : '❌'} No false streak: ${passed ? 'CORRECT' : 'FALSE POSITIVE!'}`);
  }

  // ========== TEST 8: Correct Rankings ==========
  console.log('📋 TEST 8: Correct Rankings in Descriptions');
  {
    const players = [
      createTestPlayer({ name: 'מקום1', totalProfit: 1000 }),
      createTestPlayer({ name: 'מקום2', totalProfit: 900 }),
      createTestPlayer({ name: 'מקום3', totalProfit: 800 }),
      createTestPlayer({ name: 'מקום4', totalProfit: 700 }),
    ];
    
    const milestones = generateMilestones(players);
    const leaderboardMilestone = milestones.find(m => 
      m.description.includes('מקום2') && m.description.includes('מקום 2')
    );
    
    // Check that מקום2 is correctly identified as position 2
    const passed = !!leaderboardMilestone;
    results.push({
      test: 'Rankings are correct in descriptions',
      passed,
      expected: 'מקום2 is in position 2',
      actual: leaderboardMilestone?.description || 'NOT FOUND',
    });
    console.log(`   ${passed ? '✅' : '❌'} Correct rankings: ${passed ? 'CORRECT' : 'CHECK'}`);
  }

  // ========== SUMMARY ==========
  console.log('\n================================');
  console.log('📊 TEST SUMMARY');
  console.log('================================');
  
  const passedCount = results.filter(r => r.passed).length;
  const failedCount = results.length - passedCount;
  
  console.log(`✅ Passed: ${passedCount}/${results.length}`);
  console.log(`❌ Failed: ${failedCount}/${results.length}`);
  
  if (failedCount > 0) {
    console.log('\n❌ FAILED TESTS:');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`   - ${r.test}`);
      console.log(`     Expected: ${r.expected}`);
      console.log(`     Actual: ${r.actual}`);
      if (r.details) console.log(`     Details: ${r.details}`);
    });
  }
  
  return results;
}

// Export for browser console use
if (typeof window !== 'undefined') {
  (window as any).testMilestones = testMilestones;
}

