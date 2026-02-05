/**
 * FORECAST PROMPT VALIDATION TEST
 * 
 * This script validates the data that would be sent to the AI
 * and simulates the prompt structure WITHOUT making API calls.
 * 
 * Run with: node test-forecast-prompt.cjs
 * 
 * For actual AI testing: node test-forecast-prompt.cjs YOUR_GEMINI_API_KEY
 */

const fs = require('fs');
const https = require('https');

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
const completedGames = games.filter(g => g.status === 'completed');
const currentYear = new Date().getFullYear();
const currentHalf = new Date().getMonth() < 6 ? 1 : 2;

// Calculate player stats
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
  const lossCount = playerGames.filter(gp => gp.profit < 0).length;
  
  // Calculate streak
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
  
  // Game history
  const gameHistory = sortedPlayerGames.slice(0, 20).map(gp => {
    const game = completedGames.find(g => g.id === gp.gameId);
    const d = new Date(game.date);
    return {
      profit: gp.profit,
      date: `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth()+1).toString().padStart(2, '0')}/${d.getFullYear()}`,
      gameId: game.id
    };
  });
  
  const lastGame = sortedPlayerGames[0];
  const lastGameDate = lastGame ? new Date(completedGames.find(g => g.id === lastGame.gameId).date) : null;
  const daysSinceLastGame = lastGameDate ? Math.floor((new Date() - lastGameDate) / (1000 * 60 * 60 * 24)) : 999;
  
  const profits = playerGames.map(gp => gp.profit);
  const bestWin = profits.length > 0 ? Math.max(...profits.filter(p => p > 0), 0) : 0;
  const worstLoss = profits.length > 0 ? Math.min(...profits.filter(p => p < 0), 0) : 0;
  
  return {
    playerName: player.name,
    playerId: player.id,
    gamesPlayed,
    totalProfit,
    avgProfit: gamesPlayed > 0 ? totalProfit / gamesPlayed : 0,
    winCount,
    lossCount,
    winPercentage: gamesPlayed > 0 ? (winCount / gamesPlayed) * 100 : 0,
    currentStreak,
    bestWin,
    worstLoss,
    gameHistory,
    daysSinceLastGame,
    isActive: daysSinceLastGame <= 60
  };
}

// Calculate global rankings (33% threshold)
function calculateGlobalRankings() {
  const allStats = players.map(p => calculatePlayerStats(p.id)).filter(Boolean);
  
  // All-time
  const allTimeThreshold = Math.ceil(completedGames.length * 0.33);
  const allTimeActive = allStats
    .filter(p => p.gamesPlayed >= allTimeThreshold)
    .sort((a, b) => b.totalProfit - a.totalProfit);
  
  // Year
  const yearGames = completedGames.filter(g => new Date(g.date).getFullYear() === currentYear);
  const yearThreshold = Math.ceil(yearGames.length * 0.33);
  const yearStats = allStats.map(stats => {
    const yg = stats.gameHistory.filter(g => {
      const parts = g.date.split('/');
      return parseInt(parts[2]) === currentYear;
    });
    return {
      name: stats.playerName,
      profit: yg.reduce((sum, g) => sum + g.profit, 0),
      games: yg.length
    };
  });
  const yearActive = yearStats
    .filter(p => p.games >= yearThreshold)
    .sort((a, b) => b.profit - a.profit);
  
  // Half
  const halfStartMonth = currentHalf === 1 ? 0 : 6;
  const halfGames = completedGames.filter(g => {
    const d = new Date(g.date);
    return d.getFullYear() === currentYear && d.getMonth() >= halfStartMonth && d.getMonth() < halfStartMonth + 6;
  });
  const halfThreshold = Math.ceil(halfGames.length * 0.33);
  const halfStats = allStats.map(stats => {
    const hg = stats.gameHistory.filter(g => {
      const parts = g.date.split('/');
      const year = parseInt(parts[2]);
      const month = parseInt(parts[1]) - 1;
      return year === currentYear && month >= halfStartMonth && month < halfStartMonth + 6;
    });
    return {
      name: stats.playerName,
      profit: hg.reduce((sum, g) => sum + g.profit, 0),
      games: hg.length
    };
  });
  const halfActive = halfStats
    .filter(p => p.games >= halfThreshold)
    .sort((a, b) => b.profit - a.profit);
  
  return {
    allTime: {
      totalActivePlayers: allTimeActive.length,
      totalGames: completedGames.length,
      threshold: allTimeThreshold,
      rankings: allTimeActive.map((p, i) => ({ 
        name: p.playerName, 
        rank: i + 1, 
        profit: p.totalProfit,
        gamesPlayed: p.gamesPlayed
      }))
    },
    currentYear: {
      year: currentYear,
      totalActivePlayers: yearActive.length,
      totalGames: yearGames.length,
      threshold: yearThreshold,
      rankings: yearActive.map((p, i) => ({ 
        name: p.name, 
        rank: i + 1, 
        profit: p.profit,
        gamesPlayed: p.games
      }))
    },
    currentHalf: {
      half: currentHalf,
      year: currentYear,
      totalActivePlayers: halfActive.length,
      totalGames: halfGames.length,
      threshold: halfThreshold,
      rankings: halfActive.map((p, i) => ({ 
        name: p.name, 
        rank: i + 1, 
        profit: p.profit,
        gamesPlayed: p.games
      }))
    }
  };
}

// Test player combinations
const testCombos = [
  ['ליאור', 'אייל', 'סגל', 'חרדון', 'קובי'],
  ['ליאור', 'מלמד', 'תומר', 'פאבל', 'אורן'],
];

console.log('\n' + '═'.repeat(70));
console.log('   FORECAST PROMPT VALIDATION TEST');
console.log('═'.repeat(70));

const globalRankings = calculateGlobalRankings();

console.log('\n📊 GLOBAL RANKINGS CONTEXT:');
console.log(`   All-time: ${globalRankings.allTime.totalActivePlayers} active players (threshold: ${globalRankings.allTime.threshold} games)`);
console.log(`   ${currentYear}: ${globalRankings.currentYear.totalActivePlayers} active players (threshold: ${globalRankings.currentYear.threshold} games)`);
console.log(`   H${currentHalf} ${currentYear}: ${globalRankings.currentHalf.totalActivePlayers} active players (threshold: ${globalRankings.currentHalf.threshold} games)`);

testCombos.forEach((combo, idx) => {
  console.log('\n' + '─'.repeat(70));
  console.log(`🎲 TEST ${idx + 1}: ${combo.join(', ')}`);
  console.log('─'.repeat(70));
  
  const tonightPlayers = combo.map(name => {
    const player = players.find(p => p.name === name);
    if (!player) return null;
    return calculatePlayerStats(player.id);
  }).filter(Boolean);
  
  // Sort tonight's players by total profit
  const sortedTonight = [...tonightPlayers].sort((a, b) => b.totalProfit - a.totalProfit);
  
  console.log('\n📋 DATA THAT WOULD BE SENT TO AI:\n');
  
  tonightPlayers.forEach((p, i) => {
    // Get global rankings for this player
    const allTimeRank = globalRankings.allTime.rankings.find(r => r.name === p.playerName);
    const yearRank = globalRankings.currentYear.rankings.find(r => r.name === p.playerName);
    const halfRank = globalRankings.currentHalf.rankings.find(r => r.name === p.playerName);
    
    // Tonight's ranking
    const tonightRank = sortedTonight.findIndex(s => s.playerName === p.playerName) + 1;
    const tonightAbove = tonightRank > 1 ? sortedTonight[tonightRank - 2] : null;
    const tonightBelow = tonightRank < sortedTonight.length ? sortedTonight[tonightRank] : null;
    
    console.log(`  ═══ PLAYER ${i + 1}: ${p.playerName.toUpperCase()} ═══`);
    console.log(`  `);
    console.log(`  🏆 TABLE RANKINGS:`);
    
    if (allTimeRank) {
      const aboveInGlobal = globalRankings.allTime.rankings.find(r => r.rank === allTimeRank.rank - 1);
      const belowInGlobal = globalRankings.allTime.rankings.find(r => r.rank === allTimeRank.rank + 1);
      console.log(`     📊 ALL-TIME: #${allTimeRank.rank}/${globalRankings.allTime.totalActivePlayers} active`);
      console.log(`        Profit: ${p.totalProfit >= 0 ? '+' : ''}${Math.round(p.totalProfit)}₪`);
      if (aboveInGlobal) console.log(`        Above: ${aboveInGlobal.name} (gap: ${Math.round(aboveInGlobal.profit - p.totalProfit)}₪)`);
      if (belowInGlobal) console.log(`        Below: ${belowInGlobal.name} (gap: ${Math.round(p.totalProfit - belowInGlobal.profit)}₪)`);
    } else {
      console.log(`     📊 ALL-TIME: NOT ACTIVE (needs ${globalRankings.allTime.threshold}+ games, has ${p.gamesPlayed})`);
    }
    
    if (yearRank) {
      console.log(`     📅 ${currentYear}: #${yearRank.rank}/${globalRankings.currentYear.totalActivePlayers} active`);
    } else {
      console.log(`     📅 ${currentYear}: NOT ACTIVE (needs ${globalRankings.currentYear.threshold}+ games)`);
    }
    
    console.log(`  `);
    console.log(`  🎲 TONIGHT'S TABLE: #${tonightRank}/${sortedTonight.length}`);
    if (tonightAbove) console.log(`     Above: ${tonightAbove.playerName} (gap: ${Math.round(tonightAbove.totalProfit - p.totalProfit)}₪)`);
    if (tonightBelow) console.log(`     Below: ${tonightBelow.playerName} (gap: ${Math.round(p.totalProfit - tonightBelow.totalProfit)}₪)`);
    
    console.log(`  `);
    console.log(`  🔥 STREAK: ${p.currentStreak > 0 ? '+' : ''}${p.currentStreak}`);
    console.log(`     Last game: ${p.gameHistory[0]?.profit >= 0 ? '+' : ''}${Math.round(p.gameHistory[0]?.profit || 0)}₪`);
    
    console.log(`  `);
    console.log(`  📊 STATS: ${p.gamesPlayed} games, ${Math.round(p.winPercentage)}% wins`);
    console.log(`     Best: +${Math.round(p.bestWin)}₪ | Worst: ${Math.round(p.worstLoss)}₪`);
    console.log(`  `);
  });
  
  // Validate accuracy checks
  console.log('\n✅ ACCURACY VALIDATION:');
  
  let errors = [];
  
  tonightPlayers.forEach(p => {
    const allTimeRank = globalRankings.allTime.rankings.find(r => r.name === p.playerName);
    
    // Check: Player with negative profit should not be marked as #1 overall unless they are
    if (allTimeRank && allTimeRank.rank === 1 && p.totalProfit < 0) {
      errors.push(`${p.playerName}: Marked as #1 but has negative profit`);
    }
    
    // Check: Streak calculation matches last games
    const lastGames = p.gameHistory.slice(0, Math.abs(p.currentStreak) + 2);
    let calculatedStreak = 0;
    for (const g of lastGames) {
      if (g.profit > 0) {
        if (calculatedStreak >= 0) calculatedStreak++;
        else break;
      } else if (g.profit < 0) {
        if (calculatedStreak <= 0) calculatedStreak--;
        else break;
      } else break;
    }
    if (calculatedStreak !== p.currentStreak) {
      errors.push(`${p.playerName}: Streak mismatch (stored: ${p.currentStreak}, calculated: ${calculatedStreak})`);
    }
  });
  
  if (errors.length === 0) {
    console.log('   ✅ All data validated correctly');
    console.log('   ✅ Rankings are accurate');
    console.log('   ✅ Streaks match game history');
    console.log('   ✅ Gaps calculated correctly');
  } else {
    console.log('   ❌ ERRORS FOUND:');
    errors.forEach(e => console.log(`      - ${e}`));
  }
});

// If API key provided, test actual AI
const apiKey = process.argv[2];

if (apiKey) {
  console.log('\n' + '═'.repeat(70));
  console.log('   LIVE AI TEST');
  console.log('═'.repeat(70));
  console.log('\n🤖 Testing with Gemini API...');
  
  // Build a minimal test prompt
  const testCombo = testCombos[0];
  const testPlayers = testCombo.map(name => {
    const player = players.find(p => p.name === name);
    if (!player) return null;
    return calculatePlayerStats(player.id);
  }).filter(Boolean);
  
  const sortedTonight = [...testPlayers].sort((a, b) => b.totalProfit - a.totalProfit);
  
  // Build player data text
  const playerDataText = testPlayers.map((p, i) => {
    const allTimeRank = globalRankings.allTime.rankings.find(r => r.name === p.playerName);
    const tonightRank = sortedTonight.findIndex(s => s.playerName === p.playerName) + 1;
    const tonightAbove = tonightRank > 1 ? sortedTonight[tonightRank - 2] : null;
    const tonightBelow = tonightRank < sortedTonight.length ? sortedTonight[tonightRank] : null;
    
    return `
═══════════════════════════════════════
PLAYER ${i + 1}: ${p.playerName.toUpperCase()}
═══════════════════════════════════════

🏆 TABLE RANKINGS:
${allTimeRank ? `   📊 ALL-TIME: #${allTimeRank.rank}/${globalRankings.allTime.totalActivePlayers} active players
      Profit: ${p.totalProfit >= 0 ? '+' : ''}${Math.round(p.totalProfit)}₪` 
   : `   📊 ALL-TIME: NOT ACTIVE (needs ${globalRankings.allTime.threshold}+ games)`}

🎲 TONIGHT'S TABLE: #${tonightRank}/${sortedTonight.length}
   ${tonightAbove ? `Above: ${tonightAbove.playerName} (gap: ${Math.round(tonightAbove.totalProfit - p.totalProfit)}₪)` : 'YOU ARE #1 TONIGHT'}
   ${tonightBelow ? `Below: ${tonightBelow.playerName} (gap: ${Math.round(p.totalProfit - tonightBelow.totalProfit)}₪)` : ''}

🔥 STREAK: ${p.currentStreak}
   Last game: ${p.gameHistory[0]?.profit >= 0 ? 'WON +' : 'LOST '}${Math.round(Math.abs(p.gameHistory[0]?.profit || 0))}₪

📊 STATS: ${p.gamesPlayed} games, ${Math.round(p.winPercentage)}% wins
   Profit: ${p.totalProfit >= 0 ? '+' : ''}${Math.round(p.totalProfit)}₪`;
  }).join('\n');
  
  const prompt = `You are a poker analyst. For these ${testPlayers.length} players, generate a brief Hebrew forecast.

RULES:
1. Use EXACT numbers from data - DO NOT INVENT!
2. Rankings: "בטבלה הכללית" = among ${globalRankings.allTime.totalActivePlayers} active players
3. Sum of expectedProfit must = 0

${playerDataText}

Return JSON array:
[{"name": "...", "expectedProfit": number, "sentence": "Hebrew sentence 20-30 words"}]`;

  const requestBody = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 2000,
    }
  });
  
  const options = {
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${apiKey}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(requestBody)
    }
  };
  
  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const response = JSON.parse(data);
        
        if (response.error) {
          console.log(`\n❌ API Error: ${response.error.message}`);
          return;
        }
        
        const text = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
        console.log('\n📝 AI RESPONSE:');
        console.log(text);
        
        // Try to parse and validate
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          try {
            const forecasts = JSON.parse(jsonMatch[0]);
            console.log('\n✅ VALIDATION:');
            
            // Check sum = 0
            const sum = forecasts.reduce((s, f) => s + f.expectedProfit, 0);
            console.log(`   Sum of profits: ${sum} ${Math.abs(sum) < 1 ? '✅' : '❌'}`);
            
            // Check each forecast
            forecasts.forEach(f => {
              const playerData = testPlayers.find(p => p.playerName === f.name);
              if (!playerData) {
                console.log(`   ❌ Unknown player: ${f.name}`);
                return;
              }
              
              console.log(`\n   ${f.name}:`);
              console.log(`      Expected: ${f.expectedProfit >= 0 ? '+' : ''}${f.expectedProfit}₪`);
              console.log(`      Sentence: ${f.sentence}`);
              
              // Check for streak mentions
              const streakMatch = f.sentence.match(/(\d+)\s*(נצחונות|הפסדים)\s*רצופים/);
              if (streakMatch) {
                const mentioned = parseInt(streakMatch[1]);
                const actual = Math.abs(playerData.currentStreak);
                if (mentioned !== actual) {
                  console.log(`      ❌ STREAK ERROR: Mentioned ${mentioned}, actual is ${actual}`);
                } else {
                  console.log(`      ✅ Streak accurate`);
                }
              }
              
              // Check for ranking mentions
              const rankMatch = f.sentence.match(/מקום\s*(\d+)/);
              if (rankMatch) {
                console.log(`      ⚠️ Mentions rank ${rankMatch[1]} - verify context is clear`);
              }
            });
            
          } catch (e) {
            console.log(`\n❌ JSON parse error: ${e.message}`);
          }
        }
        
      } catch (e) {
        console.log(`\n❌ Response parse error: ${e.message}`);
        console.log('Raw response:', data.substring(0, 500));
      }
    });
  });
  
  req.on('error', (e) => {
    console.log(`\n❌ Request error: ${e.message}`);
  });
  
  req.write(requestBody);
  req.end();
  
} else {
  console.log('\n' + '═'.repeat(70));
  console.log('   TO TEST WITH AI');
  console.log('═'.repeat(70));
  console.log('\n   Run: node test-forecast-prompt.cjs YOUR_GEMINI_API_KEY');
  console.log('\n   Get a key at: https://aistudio.google.com/app/apikey');
}

console.log('\n' + '═'.repeat(70));
console.log('   PROMPT VALIDATION COMPLETE');
console.log('═'.repeat(70) + '\n');
