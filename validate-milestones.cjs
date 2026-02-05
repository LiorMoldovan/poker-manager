/**
 * Milestone Generation Quality Validator
 * Tests the new professional milestone system without requiring browser/Vite
 * 
 * Run: node validate-milestones.cjs
 */

const fs = require('fs');
const path = require('path');

// Load backup data
const backupPath = path.join(__dirname, 'public', 'full-backup.json');
const backupData = JSON.parse(fs.readFileSync(backupPath, 'utf8'));

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║      MILESTONE GENERATION QUALITY VALIDATOR                 ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

// Helper functions (copied from geminiAI.ts for Node.js compatibility)
const parseGameDate = (dateStr) => {
  const d = new Date(dateStr);
  return { year: d.getFullYear(), month: d.getMonth(), half: d.getMonth() < 6 ? 1 : 2 };
};

const formatProfit = (n) => {
  if (n >= 0) return `+${Math.round(n)}₪`;
  return `${Math.round(n)}₪`;
};

const monthNames = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

// Simulate generateMilestones logic
function generateMilestones(players, games) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const currentHalf = currentMonth < 6 ? 1 : 2;
  
  // Build player stats
  const playerStats = players.map(p => {
    const playerGames = games
      .filter(g => g.players.some(gp => gp.playerId === p.id))
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    
    const gameHistory = playerGames.map(g => {
      const gp = g.players.find(gp => gp.playerId === p.id);
      // Use the profit field directly if it exists, otherwise calculate
      const profit = gp?.profit !== undefined ? gp.profit : 
        (gp ? (gp.cashOut || 0) - (gp.buyIn || 0) - (gp.rebuys || 0) * (gp.rebuyValue || 50) : 0);
      return { date: g.date, profit };
    });
    
    const totalProfit = gameHistory.reduce((sum, g) => sum + g.profit, 0);
    const gamesPlayed = gameHistory.length;
    const avgProfit = gamesPlayed > 0 ? totalProfit / gamesPlayed : 0;
    const wins = gameHistory.filter(g => g.profit > 0).length;
    
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
    let halfProfit = 0, halfGames = 0;
    let monthProfit = 0, monthGames = 0;
    
    for (const g of gameHistory) {
      const { year, month, half } = parseGameDate(g.date);
      if (year === currentYear) {
        yearProfit += g.profit;
        yearGames++;
        if (half === currentHalf) {
          halfProfit += g.profit;
          halfGames++;
        }
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
    
    return {
      ...p,
      totalProfit,
      gamesPlayed,
      avgProfit,
      winPercentage: gamesPlayed > 0 ? (wins / gamesPlayed) * 100 : 0,
      currentStreak,
      yearProfit, yearGames,
      halfProfit, halfGames,
      monthProfit, monthGames,
      last5Avg, last3Avg,
      lastGameProfit,
      bestWin, worstLoss,
      gameHistory
    };
  }).filter(p => p.gamesPlayed > 0);
  
  // Sort by different criteria
  const sortedAllTime = [...playerStats].sort((a, b) => b.totalProfit - a.totalProfit);
  const sortedYear = [...playerStats].filter(p => p.yearGames > 0).sort((a, b) => b.yearProfit - a.yearProfit);
  const sortedMonth = [...playerStats].filter(p => p.monthGames > 0).sort((a, b) => b.monthProfit - a.monthProfit);
  
  const milestones = [];
  
  // CATEGORY 1: BATTLES
  // 1A. TIGHT RACE IN ALL-TIME TABLE
  for (let i = 1; i < sortedAllTime.length && i <= 5; i++) {
    const above = sortedAllTime[i - 1];
    const below = sortedAllTime[i];
    const gap = Math.round(above.totalProfit - below.totalProfit);
    
    if (gap > 0 && gap <= 150) {
      milestones.push({
        emoji: '⚔️',
        category: 'battle',
        title: `קרב על מקום ${i}`,
        description: `${below.name} (מקום ${i + 1}) רק ${gap}₪ מאחורי ${above.name} (מקום ${i}) בטבלה הכללית. נצחון גדול הלילה = עקיפה!`,
        priority: 95 - i * 3
      });
      break;
    }
  }
  
  // 1B. YEAR TABLE BATTLE
  const yearBattles = sortedYear.filter(p => p.yearGames >= 3);
  if (yearBattles.length >= 2) {
    const [first, second] = yearBattles;
    const gap = Math.round(first.yearProfit - second.yearProfit);
    if (gap > 0 && gap <= 120 && second.yearGames >= 3) {
      milestones.push({
        emoji: '📅',
        category: 'battle',
        title: `מי יוביל את ${currentYear}?`,
        description: `${first.name} מוביל עם ${formatProfit(first.yearProfit)} | ${second.name} רודף עם ${formatProfit(second.yearProfit)} | פער: ${gap}₪`,
        priority: 88
      });
    }
  }
  
  // 1C. REVENGE MATCH
  const bigLosers = playerStats.filter(p => p.lastGameProfit < -50 && p.gamesPlayed >= 5);
  const bigWinners = playerStats.filter(p => p.lastGameProfit > 50);
  
  if (bigLosers.length > 0 && bigWinners.length > 0) {
    const bigLoser = bigLosers.sort((a, b) => a.lastGameProfit - b.lastGameProfit)[0];
    const bigWinner = bigWinners.sort((a, b) => b.lastGameProfit - a.lastGameProfit)[0];
    milestones.push({
      emoji: '🔥',
      category: 'battle',
      title: 'מפגש נקמה',
      description: `${bigLoser.name} (${formatProfit(bigLoser.lastGameProfit)} במשחק האחרון) נגד ${bigWinner.name} (${formatProfit(bigWinner.lastGameProfit)}). הלילה זה אישי.`,
      priority: 85
    });
  }
  
  // CATEGORY 2: STREAKS
  const hotStreakers = playerStats.filter(p => p.currentStreak >= 3).sort((a, b) => b.currentStreak - a.currentStreak);
  if (hotStreakers.length > 0) {
    const hottest = hotStreakers[0];
    milestones.push({
      emoji: '🔥',
      category: 'streak',
      title: `${hottest.currentStreak} נצחונות רצופים`,
      description: `${hottest.name} לא מפסיד! רצף של ${hottest.currentStreak} נצחונות. נצחון הלילה = ${hottest.currentStreak + 1} רצופים.`,
      priority: 90 + hottest.currentStreak
    });
  }
  
  const coldStreakers = playerStats.filter(p => p.currentStreak <= -3).sort((a, b) => a.currentStreak - b.currentStreak);
  if (coldStreakers.length > 0) {
    const coldest = coldStreakers[0];
    milestones.push({
      emoji: '❄️',
      category: 'streak',
      title: `${Math.abs(coldest.currentStreak)} הפסדים רצופים`,
      description: `${coldest.name} ברצף שלילי. הלילה = הזדמנות לשבור את הקללה ולחזור לנצחונות!`,
      priority: 85 + Math.abs(coldest.currentStreak)
    });
  }
  
  if (hotStreakers.length > 0 && coldStreakers.length > 0) {
    const hot = hotStreakers[0];
    const cold = coldStreakers[0];
    milestones.push({
      emoji: '⚡',
      category: 'streak',
      title: 'אש מול קרח',
      description: `${hot.name} (+${hot.currentStreak} רצופים) נגד ${cold.name} (${cold.currentStreak} רצופים). מי ישנה כיוון?`,
      priority: 82
    });
  }
  
  // CATEGORY 3: MILESTONES
  const roundNumbers = [500, 1000, 1500, 2000, 2500, 3000];
  const milestoneCandidates = playerStats
    .map(p => {
      for (const target of roundNumbers) {
        const distance = target - p.totalProfit;
        if (distance > 0 && distance <= 200) {
          return { player: p, target, distance };
        }
      }
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => a.distance - b.distance);
  
  if (milestoneCandidates.length > 0) {
    const best = milestoneCandidates[0];
    milestones.push({
      emoji: '🎯',
      category: 'milestone',
      title: `יעד ${best.target.toLocaleString()}₪`,
      description: `${best.player.name} על ${formatProfit(best.player.totalProfit)} בטבלה הכללית. עוד ${Math.round(best.distance)}₪ = חציית רף ${best.target.toLocaleString()}₪!`,
      priority: 78 + Math.round(best.target / 200)
    });
  }
  
  // Games milestones
  const gameMilestones = [10, 25, 50, 75, 100, 150, 200];
  for (const p of playerStats) {
    for (const gm of gameMilestones) {
      if (p.gamesPlayed === gm - 1) {
        milestones.push({
          emoji: '🎮',
          category: 'milestone',
          title: `משחק מספר ${gm}`,
          description: `הלילה ${p.name} ישחק את המשחק ה-${gm} שלו! ממוצע עד כה: ${formatProfit(p.avgProfit)} למשחק.`,
          priority: 65 + gm / 5
        });
        break;
      }
    }
  }
  
  // Recovery to positive
  const recoveryCandidate = playerStats
    .filter(p => p.yearProfit < 0 && p.yearProfit > -150 && p.yearGames >= 2)
    .sort((a, b) => b.yearProfit - a.yearProfit)[0];
  
  if (recoveryCandidate) {
    milestones.push({
      emoji: '🔄',
      category: 'milestone',
      title: `חזרה לפלוס ${currentYear}`,
      description: `${recoveryCandidate.name} על ${formatProfit(recoveryCandidate.yearProfit)} השנה. נצחון של ${Math.round(Math.abs(recoveryCandidate.yearProfit))}₪+ = פלוס שנתי!`,
      priority: 75
    });
  }
  
  // CATEGORY 4: FORM
  const hotForm = playerStats
    .filter(p => p.gamesPlayed >= 5 && p.gameHistory.length >= 3)
    .map(p => ({ ...p, formDiff: p.last3Avg - p.avgProfit }))
    .filter(p => p.formDiff > 40)
    .sort((a, b) => b.formDiff - a.formDiff)[0];
  
  if (hotForm) {
    milestones.push({
      emoji: '📈',
      category: 'form',
      title: `${hotForm.name} בפורם חם`,
      description: `ממוצע אחרון: ${formatProfit(hotForm.last3Avg)} למשחק (לעומת ${formatProfit(hotForm.avgProfit)} היסטורי). שיפור של ${Math.round(hotForm.formDiff)}₪!`,
      priority: 76
    });
  }
  
  const coldForm = playerStats
    .filter(p => p.gamesPlayed >= 5 && p.gameHistory.length >= 3 && p.avgProfit > 0)
    .map(p => ({ ...p, formDiff: p.last3Avg - p.avgProfit }))
    .filter(p => p.formDiff < -40)
    .sort((a, b) => a.formDiff - b.formDiff)[0];
  
  if (coldForm) {
    milestones.push({
      emoji: '📉',
      category: 'form',
      title: `${coldForm.name} מתחת לרמה`,
      description: `בדרך כלל ${formatProfit(coldForm.avgProfit)} למשחק, אבל לאחרונה ${formatProfit(coldForm.last3Avg)}. הסטטיסטיקה לטובתו - צפוי קאמבק.`,
      priority: 72
    });
  }
  
  // CATEGORY 5: DRAMA
  const bottomPlayers = sortedAllTime.slice(-2);
  const risingUnderdog = bottomPlayers.find(p => p.lastGameProfit > 50);
  if (risingUnderdog) {
    const rank = sortedAllTime.findIndex(p => p.name === risingUnderdog.name) + 1;
    milestones.push({
      emoji: '💪',
      category: 'drama',
      title: 'עלייה מהתחתית',
      description: `${risingUnderdog.name} (מקום ${rank}) ניצח ${formatProfit(risingUnderdog.lastGameProfit)} במשחק האחרון. התחלת מהפך?`,
      priority: 79
    });
  }
  
  const leader = sortedAllTime[0];
  const second = sortedAllTime[1];
  if (leader && second && leader.lastGameProfit < -30) {
    const gap = Math.round(leader.totalProfit - second.totalProfit);
    milestones.push({
      emoji: '👀',
      category: 'drama',
      title: 'המוביל בלחץ',
      description: `${leader.name} (מקום 1) הפסיד ${formatProfit(leader.lastGameProfit)} במשחק האחרון. הפער מ${second.name}: ${gap}₪ בלבד.`,
      priority: 81
    });
  }
  
  const upsetCandidate = playerStats
    .filter(p => p.gamesPlayed >= 5 && p.avgProfit < 0 && p.lastGameProfit > 30)
    .sort((a, b) => b.lastGameProfit - a.lastGameProfit)[0];
  
  if (upsetCandidate) {
    milestones.push({
      emoji: '🌟',
      category: 'drama',
      title: `${upsetCandidate.name} בהפתעה`,
      description: `ממוצע היסטורי: ${formatProfit(upsetCandidate.avgProfit)} למשחק, אבל ניצח ${formatProfit(upsetCandidate.lastGameProfit)} לאחרונה. תחילת שינוי מגמה?`,
      priority: 77
    });
  }
  
  const volatilePlayer = playerStats
    .filter(p => p.gameHistory.length >= 4)
    .map(p => {
      const last4 = p.gameHistory.slice(0, 4).map(g => g.profit);
      const swing = Math.max(...last4) - Math.min(...last4);
      return { ...p, swing, max: Math.max(...last4), min: Math.min(...last4) };
    })
    .filter(p => p.swing > 200)
    .sort((a, b) => b.swing - a.swing)[0];
  
  if (volatilePlayer) {
    milestones.push({
      emoji: '🎢',
      category: 'drama',
      title: 'הרים רוסיים',
      description: `${volatilePlayer.name} בתנודות: מ-${formatProfit(volatilePlayer.min)} עד ${formatProfit(volatilePlayer.max)} ב-4 משחקים אחרונים. לאן הלילה?`,
      priority: 70
    });
  }
  
  // CATEGORY 6: RECORDS
  const biggestWin = Math.max(...playerStats.map(p => p.bestWin));
  const recordHolder = playerStats.find(p => p.bestWin === biggestWin);
  const recordChaser = playerStats
    .filter(p => p !== recordHolder && p.currentStreak >= 2 && biggestWin - p.bestWin <= 100)
    .sort((a, b) => b.currentStreak - a.currentStreak)[0];
  
  if (recordChaser && recordHolder) {
    milestones.push({
      emoji: '🏆',
      category: 'record',
      title: 'מרדף על השיא',
      description: `שיא הקבוצה: ${formatProfit(biggestWin)} (${recordHolder.name}). ${recordChaser.name} ברצף ${recordChaser.currentStreak}+ ויכול לשבור!`,
      priority: 74
    });
  }
  
  // CATEGORY 7: SEASON
  if (sortedMonth[0]?.monthGames >= 2 && sortedMonth[1]?.monthGames >= 1) {
    const monthLeader = sortedMonth[0];
    const monthSecond = sortedMonth[1];
    const gap = Math.round(monthLeader.monthProfit - monthSecond.monthProfit);
    
    if (gap <= 100) {
      milestones.push({
        emoji: '📆',
        category: 'season',
        title: `שחקן ${monthNames[currentMonth]}`,
        description: `${monthLeader.name} מוביל את ${monthNames[currentMonth]} עם ${formatProfit(monthLeader.monthProfit)}. ${monthSecond.name} רודף ב-${gap}₪.`,
        priority: 68
      });
    }
  }
  
  if (currentMonth === 11) {
    const yearLeader = sortedYear[0];
    if (yearLeader && yearLeader.yearGames >= 5) {
      milestones.push({
        emoji: '🎄',
        category: 'season',
        title: `אלוף ${currentYear}?`,
        description: `${yearLeader.name} מוביל את ${currentYear} עם ${formatProfit(yearLeader.yearProfit)}. משחקי דצמבר קובעים!`,
        priority: 92
      });
    }
  }
  
  if (currentMonth <= 1) {
    const totalYearGames = playerStats.reduce((sum, p) => sum + p.yearGames, 0);
    // Only show if January AND very few games played
    if (currentMonth === 0 && totalYearGames <= 1) {
      milestones.push({
        emoji: '🎆',
        category: 'season',
        title: `${currentYear} מתחילה`,
        description: `שנה חדשה, טבלה חדשה. ${players.length} שחקנים מתחילים מחדש. מי יוביל ב-${currentYear}?`,
        priority: 85
      });
    }
  }
  
  // DEDUPLICATION & SELECTION
  milestones.sort((a, b) => b.priority - a.priority);
  
  const selected = [];
  const playerMentions = {};
  
  for (const m of milestones) {
    const categoryLimit = (m.category === 'battle' || m.category === 'drama') ? 2 : 1;
    const categoryCount = selected.filter(s => s.category === m.category).length;
    if (categoryCount >= categoryLimit) continue;
    
    const mentionedPlayers = playerStats.filter(p => m.title.includes(p.name) || m.description.includes(p.name)).map(p => p.name);
    if (mentionedPlayers.some(name => (playerMentions[name] || 0) >= 2)) continue;
    
    selected.push(m);
    mentionedPlayers.forEach(name => playerMentions[name] = (playerMentions[name] || 0) + 1);
    
    if (selected.length >= 8) break;
  }
  
  if (selected.length < 5) {
    for (const m of milestones) {
      if (!selected.includes(m)) {
        selected.push(m);
        if (selected.length >= 5) break;
      }
    }
  }
  
  return selected;
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

const { players, games, gamePlayers } = backupData;

// Merge gamePlayers into games for easier access
const gamesWithPlayers = games.map(g => ({
  ...g,
  players: gamePlayers.filter(gp => gp.gameId === g.id)
}));

console.log(`📊 Data loaded: ${players.length} players, ${games.length} games, ${gamePlayers.length} game-player records\n`);

// Test 1: Generate milestones for all players
console.log('═══════════════════════════════════════════════════════════════');
console.log('TEST 1: Generate milestones for ALL active players');
console.log('═══════════════════════════════════════════════════════════════\n');

const allMilestones = generateMilestones(players, gamesWithPlayers);

console.log(`Generated ${allMilestones.length} milestones:\n`);
allMilestones.forEach((m, i) => {
  console.log(`${i + 1}. ${m.emoji} [${m.category.toUpperCase()}] ${m.title}`);
  console.log(`   ${m.description}`);
  console.log(`   Priority: ${m.priority}\n`);
});

// Test 2: Category distribution check
console.log('═══════════════════════════════════════════════════════════════');
console.log('TEST 2: Category Distribution');
console.log('═══════════════════════════════════════════════════════════════\n');

const categoryCount = {};
allMilestones.forEach(m => {
  categoryCount[m.category] = (categoryCount[m.category] || 0) + 1;
});

Object.entries(categoryCount).forEach(([cat, count]) => {
  const limit = (cat === 'battle' || cat === 'drama') ? 2 : 1;
  const status = count <= limit ? '✅' : '❌';
  console.log(`  ${status} ${cat}: ${count} (limit: ${limit})`);
});

// Test 3: Player mention check
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('TEST 3: Player Mention Distribution');
console.log('═══════════════════════════════════════════════════════════════\n');

const playerMentionCount = {};
allMilestones.forEach(m => {
  players.forEach(p => {
    if (m.title.includes(p.name) || m.description.includes(p.name)) {
      playerMentionCount[p.name] = (playerMentionCount[p.name] || 0) + 1;
    }
  });
});

const sortedMentions = Object.entries(playerMentionCount).sort((a, b) => b[1] - a[1]);
sortedMentions.slice(0, 10).forEach(([name, count]) => {
  const status = count <= 2 ? '✅' : '⚠️';
  console.log(`  ${status} ${name}: ${count} mentions`);
});

// Test 4: Quality checks
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('TEST 4: Quality Checks');
console.log('═══════════════════════════════════════════════════════════════\n');

const checks = [
  { name: 'Minimum 5 milestones', pass: allMilestones.length >= 5 },
  { name: 'Maximum 8 milestones', pass: allMilestones.length <= 8 },
  { name: 'All have emoji', pass: allMilestones.every(m => m.emoji) },
  { name: 'All have category', pass: allMilestones.every(m => m.category) },
  { name: 'All have title', pass: allMilestones.every(m => m.title && m.title.length > 0) },
  { name: 'All have description', pass: allMilestones.every(m => m.description && m.description.length > 0) },
  { name: 'Title max 30 chars', pass: allMilestones.every(m => m.title.length <= 30) },
  { name: 'Description has numbers', pass: allMilestones.every(m => /\d/.test(m.description)) },
  { name: 'Sorted by priority', pass: allMilestones.every((m, i, arr) => i === 0 || arr[i-1].priority >= m.priority) },
  { name: 'Diverse categories', pass: Object.keys(categoryCount).length >= 3 },
];

checks.forEach(c => {
  console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}`);
});

// Test 5: Simulate with subset of players (tonight's players)
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('TEST 5: Milestones for a subset of players (e.g., 6 players)');
console.log('═══════════════════════════════════════════════════════════════\n');

// Pick 6 players with most games
const playerGameCounts = players.map(p => ({
  ...p,
  gameCount: gamesWithPlayers.filter(g => g.players.some(gp => gp.playerId === p.id)).length
})).filter(p => p.gameCount > 0).sort((a, b) => b.gameCount - a.gameCount);

const tonightPlayers = playerGameCounts.slice(0, 6);
console.log(`Tonight's players: ${tonightPlayers.map(p => `${p.name} (${p.gameCount} games)`).join(', ')}\n`);

const subsetMilestones = generateMilestones(tonightPlayers, gamesWithPlayers);

console.log(`Generated ${subsetMilestones.length} milestones for tonight:\n`);
subsetMilestones.forEach((m, i) => {
  console.log(`${i + 1}. ${m.emoji} [${m.category.toUpperCase()}] ${m.title}`);
  console.log(`   ${m.description}\n`);
});

// Summary
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('SUMMARY');
console.log('═══════════════════════════════════════════════════════════════\n');

const passedChecks = checks.filter(c => c.pass).length;
console.log(`Quality checks: ${passedChecks}/${checks.length} passed`);
console.log(`Milestones generated: ${allMilestones.length} (all), ${subsetMilestones.length} (subset)`);
console.log(`Categories used: ${Object.keys(categoryCount).join(', ')}`);

if (passedChecks === checks.length) {
  console.log('\n✅ ALL TESTS PASSED - Milestone system is working correctly!');
} else {
  console.log('\n⚠️ Some tests failed - review the output above');
}

console.log('\n');
