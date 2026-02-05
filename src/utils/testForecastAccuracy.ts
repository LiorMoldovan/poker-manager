/**
 * FORECAST ACCURACY VALIDATION TEST SUITE
 * 
 * This validates that the AI forecast system generates accurate data.
 * Run in browser console: window.runForecastTests()
 */

import { getPlayerStats } from '../database/storage';
import { generateAIForecasts, PlayerForecastData, ForecastResult } from './geminiAI';

interface ValidationResult {
  playerName: string;
  test: string;
  passed: boolean;
  expected: string;
  actual: string;
  severity: 'critical' | 'high' | 'medium';
}

// Get real player stats from the app
function getTestPlayerData(playerNames: string[]): PlayerForecastData[] {
  const allStats = getPlayerStats();
  
  return playerNames.map(name => {
    const stats = allStats.find(s => s.playerName === name);
    if (!stats) {
      console.warn(`⚠️ Player "${name}" not found in stats!`);
      return null;
    }
    
    const daysSinceLastGame = stats.lastGameResults.length > 0
      ? Math.floor((Date.now() - new Date(stats.lastGameResults[0].date).getTime()) / (1000 * 60 * 60 * 24))
      : 999;
    
    // Convert dates to DD/MM/YYYY format
    const gameHistory = stats.lastGameResults.map(g => {
      const d = new Date(g.date);
      const day = d.getDate().toString().padStart(2, '0');
      const month = (d.getMonth() + 1).toString().padStart(2, '0');
      const year = d.getFullYear();
      return {
        profit: g.profit,
        date: `${day}/${month}/${year}`,
        gameId: g.gameId
      };
    });

    return {
      name: stats.playerName,
      isFemale: stats.playerName === 'מור',
      gamesPlayed: stats.gamesPlayed,
      totalProfit: stats.totalProfit,
      avgProfit: stats.avgProfit,
      winCount: stats.winCount,
      lossCount: stats.lossCount,
      winPercentage: stats.winPercentage,
      currentStreak: stats.currentStreak,
      bestWin: stats.biggestWin,
      worstLoss: stats.biggestLoss,
      gameHistory,
      daysSinceLastGame,
      isActive: daysSinceLastGame <= 60
    };
  }).filter(Boolean) as PlayerForecastData[];
}

// Validate a forecast against actual player data
function validateForecast(forecast: ForecastResult, playerData: PlayerForecastData): ValidationResult[] {
  const results: ValidationResult[] = [];
  const currentYear = new Date().getFullYear();
  
  // Parse year games
  const yearGames = playerData.gameHistory.filter(g => {
    const parts = g.date.split('/');
    const year = parseInt(parts[2]);
    return year === currentYear;
  });
  const yearProfit = yearGames.reduce((sum, g) => sum + g.profit, 0);
  
  // 1. Validate streak claims
  const streakPatterns = [
    { regex: /(\d+)\s*נצחונות\s*רצופים/g, type: 'win' },
    { regex: /רצף\s*(?:של\s*)?(\d+)\s*נצחונות/g, type: 'win' },
    { regex: /(\d+)\s*הפסדים\s*רצופים/g, type: 'loss' },
    { regex: /רצף\s*(?:של\s*)?(\d+)\s*הפסדים/g, type: 'loss' },
  ];
  
  const sentence = forecast.sentence;
  for (const pattern of streakPatterns) {
    const matches = [...sentence.matchAll(pattern.regex)];
    for (const match of matches) {
      const claimed = parseInt(match[1]);
      const actual = pattern.type === 'win' 
        ? Math.max(0, playerData.currentStreak) 
        : Math.abs(Math.min(0, playerData.currentStreak));
      
      results.push({
        playerName: playerData.name,
        test: `Streak claim: "${match[0]}"`,
        passed: claimed === actual,
        expected: `${actual} (actual streak)`,
        actual: `${claimed} (claimed)`,
        severity: 'critical'
      });
    }
  }
  
  // 2. Validate no false #1 claims
  const claimsFirst = sentence.includes('מוביל') || 
                      sentence.includes('בראש') || 
                      sentence.includes('מקום ראשון') ||
                      sentence.includes('מקום 1') ||
                      sentence.includes('#1');
  
  // We can't validate rank without knowing all players, but we check for obvious issues
  
  // 3. Validate last game result claims
  const lastGame = playerData.gameHistory[0];
  if (lastGame) {
    const wonLast = lastGame.profit > 0;
    const lostLast = lastGame.profit < 0;
    
    // Check for contradictions
    if (wonLast && sentence.includes('הפסד') && sentence.includes('אחרון')) {
      results.push({
        playerName: playerData.name,
        test: 'Last game claim',
        passed: false,
        expected: `Won last game (+${lastGame.profit}₪)`,
        actual: 'Sentence claims loss',
        severity: 'critical'
      });
    }
    if (lostLast && sentence.includes('נצחון') && sentence.includes('אחרון')) {
      results.push({
        playerName: playerData.name,
        test: 'Last game claim',
        passed: false,
        expected: `Lost last game (${lastGame.profit}₪)`,
        actual: 'Sentence claims win',
        severity: 'critical'
      });
    }
  }
  
  // 4. Validate year profit direction
  if (yearGames.length > 0) {
    const hasPositiveYearClaim = sentence.includes('שנה מצוינת') || 
                                  sentence.includes('שנה טובה') ||
                                  (sentence.includes(currentYear.toString()) && sentence.match(/\+\d+/));
    
    if (yearProfit < -50 && hasPositiveYearClaim) {
      results.push({
        playerName: playerData.name,
        test: 'Year profit direction',
        passed: false,
        expected: `Negative year (${yearProfit}₪)`,
        actual: 'Sentence implies positive year',
        severity: 'high'
      });
    }
  }
  
  // 5. Validate game count claims
  const gameCountPattern = /(\d+)\s*משחקים?\s*(?:ב)?-?(?:2026|2025|השנה)/g;
  const matches = [...sentence.matchAll(gameCountPattern)];
  for (const match of matches) {
    const claimed = parseInt(match[1]);
    const actual = yearGames.length;
    
    // Allow +1 for "tonight's game"
    results.push({
      playerName: playerData.name,
      test: `Game count: "${match[0]}"`,
      passed: claimed === actual || claimed === actual + 1,
      expected: `${actual} games this year`,
      actual: `${claimed} (claimed)`,
      severity: 'high'
    });
  }
  
  // 6. Validate tone matches expectedProfit
  const isOptimistic = sentence.includes('חזק') || 
                       sentence.includes('מצוין') || 
                       sentence.includes('נהדר') ||
                       sentence.includes('מומנטום חיובי') ||
                       sentence.includes('ברצף נצחונות');
  const isCautious = sentence.includes('קשה') || 
                     sentence.includes('מחפש') || 
                     sentence.includes('צריך') ||
                     sentence.includes('רצף הפסדים');
  
  if (forecast.expectedProfit > 50 && isCautious && !isOptimistic) {
    results.push({
      playerName: playerData.name,
      test: 'Tone matches profit',
      passed: false,
      expected: `Positive profit (+${forecast.expectedProfit}₪) should be optimistic`,
      actual: 'Sentence sounds cautious',
      severity: 'medium'
    });
  }
  if (forecast.expectedProfit < -50 && isOptimistic && !isCautious) {
    results.push({
      playerName: playerData.name,
      test: 'Tone matches profit',
      passed: false,
      expected: `Negative profit (${forecast.expectedProfit}₪) should be cautious`,
      actual: 'Sentence sounds optimistic',
      severity: 'medium'
    });
  }
  
  return results;
}

// Test with a specific player combination
async function testPlayerCombination(playerNames: string[]): Promise<{
  success: boolean;
  results: ValidationResult[];
  forecasts: ForecastResult[];
}> {
  console.log(`\n🧪 Testing combination: ${playerNames.join(', ')}`);
  console.log('─'.repeat(60));
  
  const playerData = getTestPlayerData(playerNames);
  
  if (playerData.length < playerNames.length) {
    console.log('⚠️ Some players not found in stats');
  }
  
  if (playerData.length < 2) {
    console.log('❌ Need at least 2 valid players');
    return { success: false, results: [], forecasts: [] };
  }
  
  // Log actual player data for verification
  console.log('\n📊 ACTUAL PLAYER DATA:');
  playerData.forEach(p => {
    const yearGames = p.gameHistory.filter(g => {
      const parts = g.date.split('/');
      return parseInt(parts[2]) === new Date().getFullYear();
    });
    const yearProfit = yearGames.reduce((sum, g) => sum + g.profit, 0);
    
    console.log(`\n  ${p.name}:`);
    console.log(`    • Total Profit: ${p.totalProfit >= 0 ? '+' : ''}${Math.round(p.totalProfit)}₪`);
    console.log(`    • Year Profit: ${yearProfit >= 0 ? '+' : ''}${Math.round(yearProfit)}₪ (${yearGames.length} games)`);
    console.log(`    • Current Streak: ${p.currentStreak}`);
    console.log(`    • Last Game: ${p.gameHistory[0]?.profit >= 0 ? '+' : ''}${p.gameHistory[0]?.profit || 0}₪`);
    console.log(`    • Win Rate: ${Math.round(p.winPercentage)}%`);
  });
  
  try {
    console.log('\n🤖 Generating AI forecasts...');
    const forecasts = await generateAIForecasts(playerData);
    
    console.log('\n📝 FORECAST OUTPUT:');
    forecasts.forEach(f => {
      console.log(`\n  ${f.name}: ${f.expectedProfit >= 0 ? '+' : ''}${f.expectedProfit}₪`);
      console.log(`    Highlight: ${f.highlight}`);
      console.log(`    Sentence: ${f.sentence}`);
      if (f.isSurprise) console.log(`    🎲 SURPRISE`);
    });
    
    // Validate each forecast
    const allResults: ValidationResult[] = [];
    forecasts.forEach(forecast => {
      const player = playerData.find(p => p.name === forecast.name);
      if (player) {
        const validationResults = validateForecast(forecast, player);
        allResults.push(...validationResults);
      }
    });
    
    // Report validation results
    console.log('\n✅ VALIDATION RESULTS:');
    const passed = allResults.filter(r => r.passed);
    const failed = allResults.filter(r => !r.passed);
    
    if (failed.length === 0 && allResults.length > 0) {
      console.log(`  All ${allResults.length} checks passed! ✅`);
    } else if (allResults.length === 0) {
      console.log('  No specific claims to validate (may be good - no hallucinations)');
    } else {
      console.log(`  Passed: ${passed.length}/${allResults.length}`);
      console.log(`  Failed: ${failed.length}/${allResults.length}`);
      
      failed.forEach(r => {
        const icon = r.severity === 'critical' ? '🚨' : r.severity === 'high' ? '⚠️' : '📌';
        console.log(`\n  ${icon} [${r.severity.toUpperCase()}] ${r.playerName}: ${r.test}`);
        console.log(`     Expected: ${r.expected}`);
        console.log(`     Actual: ${r.actual}`);
      });
    }
    
    return {
      success: failed.filter(r => r.severity === 'critical').length === 0,
      results: allResults,
      forecasts
    };
    
  } catch (error: any) {
    console.log(`\n❌ Error: ${error.message}`);
    return { success: false, results: [], forecasts: [] };
  }
}

// Main test runner
export async function runForecastTests(): Promise<void> {
  console.clear();
  console.log('═'.repeat(60));
  console.log('   🧪 FORECAST ACCURACY VALIDATION SUITE');
  console.log('   Testing AI output against real player data');
  console.log('═'.repeat(60));
  
  const allStats = getPlayerStats();
  console.log(`\n📊 Found ${allStats.length} players with stats`);
  
  // Show top players by games played
  const topPlayers = [...allStats]
    .sort((a, b) => b.gamesPlayed - a.gamesPlayed)
    .slice(0, 10);
  
  console.log('\n👥 Top players by games played:');
  topPlayers.forEach((p, i) => {
    console.log(`  ${i + 1}. ${p.playerName}: ${p.gamesPlayed} games, ${p.totalProfit >= 0 ? '+' : ''}${Math.round(p.totalProfit)}₪, streak: ${p.currentStreak}`);
  });
  
  // Test combinations
  const testCombinations = [
    // Combo 1: Core players
    ['ליאור', 'אייל', 'סגל', 'תומר', 'פיליפ'],
    // Combo 2: Mix of good and struggling players
    ['ליאור', 'חרדון', 'מלמד', 'אורן', 'ליכטר'],
    // Combo 3: Smaller group
    ['אייל', 'סגל', 'פאבל'],
  ];
  
  let totalTests = 0;
  let passedTests = 0;
  let criticalFailures = 0;
  
  for (const combo of testCombinations) {
    const result = await testPlayerCombination(combo);
    
    totalTests += result.results.length;
    passedTests += result.results.filter(r => r.passed).length;
    criticalFailures += result.results.filter(r => !r.passed && r.severity === 'critical').length;
    
    // Small delay between API calls
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  // Final summary
  console.log('\n' + '═'.repeat(60));
  console.log('   📊 FINAL SUMMARY');
  console.log('═'.repeat(60));
  console.log(`\n  Total Validations: ${totalTests}`);
  console.log(`  Passed: ${passedTests}`);
  console.log(`  Failed: ${totalTests - passedTests}`);
  console.log(`  Critical Failures: ${criticalFailures}`);
  
  if (criticalFailures === 0) {
    console.log('\n  ✅ SUCCESS: No critical accuracy issues detected!');
  } else {
    console.log(`\n  ❌ ISSUES FOUND: ${criticalFailures} critical failures need fixing`);
  }
  
  console.log('\n' + '═'.repeat(60));
}

// Quick single-player test
export async function testSinglePlayer(playerName: string): Promise<void> {
  const allStats = getPlayerStats();
  const playerStat = allStats.find(s => s.playerName === playerName);
  
  if (!playerStat) {
    console.log(`❌ Player "${playerName}" not found!`);
    console.log('Available players:', allStats.map(s => s.playerName).join(', '));
    return;
  }
  
  console.log('\n' + '═'.repeat(50));
  console.log(`   📊 PLAYER DATA: ${playerName}`);
  console.log('═'.repeat(50));
  
  console.log(`\n  Basic Stats:`);
  console.log(`    • Games Played: ${playerStat.gamesPlayed}`);
  console.log(`    • Total Profit: ${playerStat.totalProfit >= 0 ? '+' : ''}${Math.round(playerStat.totalProfit)}₪`);
  console.log(`    • Avg Profit: ${playerStat.avgProfit >= 0 ? '+' : ''}${Math.round(playerStat.avgProfit)}₪`);
  console.log(`    • Win Rate: ${Math.round(playerStat.winPercentage)}%`);
  console.log(`    • Current Streak: ${playerStat.currentStreak}`);
  console.log(`    • Best Win: +${Math.round(playerStat.biggestWin)}₪`);
  console.log(`    • Worst Loss: ${Math.round(playerStat.biggestLoss)}₪`);
  
  // Show year breakdown
  const currentYear = new Date().getFullYear();
  const gamesByYear: Record<number, { games: number; profit: number }> = {};
  
  playerStat.lastGameResults.forEach(g => {
    const year = new Date(g.date).getFullYear();
    if (!gamesByYear[year]) gamesByYear[year] = { games: 0, profit: 0 };
    gamesByYear[year].games++;
    gamesByYear[year].profit += g.profit;
  });
  
  console.log(`\n  Games by Year:`);
  Object.keys(gamesByYear).sort().reverse().forEach(yearStr => {
    const year = parseInt(yearStr);
    const data = gamesByYear[year];
    const marker = year === currentYear ? ' ← CURRENT' : '';
    console.log(`    • ${year}: ${data.games} games, ${data.profit >= 0 ? '+' : ''}${Math.round(data.profit)}₪${marker}`);
  });
  
  console.log(`\n  Last 5 Games:`);
  playerStat.lastGameResults.slice(0, 5).forEach((g, i) => {
    const d = new Date(g.date);
    console.log(`    ${i + 1}. ${d.toLocaleDateString('he-IL')}: ${g.profit >= 0 ? '+' : ''}${g.profit}₪`);
  });
  
  // Verify streak
  console.log(`\n  Streak Verification:`);
  const recentResults = playerStat.lastGameResults.slice(0, 10).map(g => 
    g.profit > 0 ? 'W' : g.profit < 0 ? 'L' : 'T'
  );
  console.log(`    Recent: ${recentResults.join(' ')}`);
  console.log(`    Claimed: ${playerStat.currentStreak}`);
  
  console.log('\n' + '═'.repeat(50));
}

// Export for browser
if (typeof window !== 'undefined') {
  (window as any).runForecastTests = runForecastTests;
  (window as any).testPlayerCombination = testPlayerCombination;
  (window as any).testSinglePlayer = testSinglePlayer;
}
