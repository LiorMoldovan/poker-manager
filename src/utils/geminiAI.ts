/**
 * Google Gemini AI Integration for Poker Forecasts
 * Free tier: 15 requests/minute (gemini-1.5-flash)
 * Get your API key at: https://aistudio.google.com/app/apikey
 */

// API versions and models to try (based on actual available models Dec 2024)
// Ordered by free tier quota (lite models have higher limits)
const API_CONFIGS = [
  // Lite models first (higher free tier limits)
  { version: 'v1beta', model: 'gemini-2.0-flash-lite' },
  { version: 'v1beta', model: 'gemini-2.5-flash-lite' },
  // Then regular flash models
  { version: 'v1beta', model: 'gemini-2.0-flash' },
  { version: 'v1beta', model: 'gemini-2.5-flash' },
  // Specific versions as fallback
  { version: 'v1beta', model: 'gemini-2.0-flash-001' },
  { version: 'v1', model: 'gemini-2.0-flash' },
];

// Store API key in localStorage
const API_KEY_STORAGE = 'gemini_api_key';

export const getGeminiApiKey = (): string | null => {
  return localStorage.getItem(API_KEY_STORAGE);
};

export const setGeminiApiKey = (key: string): void => {
  localStorage.setItem(API_KEY_STORAGE, key);
};

export const clearGeminiApiKey = (): void => {
  localStorage.removeItem(API_KEY_STORAGE);
};

export interface PlayerForecastData {
  name: string;
  isFemale: boolean;
  gamesPlayed: number;
  totalProfit: number;
  avgProfit: number;
  winCount: number;
  lossCount: number;
  winPercentage: number;
  currentStreak: number; // positive = wins, negative = losses
  bestWin: number;
  worstLoss: number;
  // All game results with dates and game IDs (most recent first)
  gameHistory: { profit: number; date: string; gameId: string }[];
  daysSinceLastGame: number;
  isActive: boolean; // played in last 2 months
}

export interface ForecastResult {
  name: string;
  expectedProfit: number;
  highlight: string;
  sentence: string;
  isSurprise: boolean;
}

export interface MilestoneItem {
  emoji: string;
  title: string;           // Short, punchy headline (2-5 words)
  description: string;     // The insight with exact numbers
  priority: number;        // Higher = more interesting
  category: 'battle' | 'streak' | 'milestone' | 'form' | 'drama' | 'record' | 'season';
}

/**
 * Global ranking context for accurate table rankings
 * Rankings should be calculated among ACTIVE players only (33% threshold)
 */
export interface GlobalRankingContext {
  // All-time rankings (among active players with 33% of all games)
  allTime: {
    totalActivePlayers: number;
    totalGames: number;
    threshold: number; // minimum games to be "active"
    rankings: { name: string; rank: number; profit: number; gamesPlayed: number }[];
  };
  // Current year rankings (among active players with 33% of this year's games)
  currentYear: {
    year: number;
    totalActivePlayers: number;
    totalGames: number;
    threshold: number;
    rankings: { name: string; rank: number; profit: number; gamesPlayed: number }[];
  };
  // Current half rankings
  currentHalf: {
    half: 1 | 2;
    year: number;
    totalActivePlayers: number;
    totalGames: number;
    threshold: number;
    rankings: { name: string; rank: number; profit: number; gamesPlayed: number }[];
  };
}

/**
 * Generate professional, state-of-the-art milestones for tonight's game
 * Quality over quantity - returns 5-8 high-impact insights
 */
export const generateMilestones = (players: PlayerForecastData[]): MilestoneItem[] => {
  const milestones: MilestoneItem[] = [];
  
  // ═══════════════════════════════════════════════════════════════
  // HELPER FUNCTIONS
  // ═══════════════════════════════════════════════════════════════
  
  const parseGameDate = (dateStr: string): Date => {
    let parts = dateStr.split('/');
    if (parts.length >= 3) {
      const day = parseInt(parts[0]);
      const month = parseInt(parts[1]) - 1;
      let year = parseInt(parts[2]);
      if (year < 100) year += 2000;
      return new Date(year, month, day);
    }
    parts = dateStr.split('.');
    if (parts.length >= 3) {
      const day = parseInt(parts[0]);
      const month = parseInt(parts[1]) - 1;
      let year = parseInt(parts[2]);
      if (year < 100) year += 2000;
      return new Date(year, month, day);
    }
    return new Date(dateStr);
  };
  
  const formatProfit = (n: number): string => `${n >= 0 ? '+' : ''}${Math.round(n)}₪`;
  
  // ═══════════════════════════════════════════════════════════════
  // CALCULATE PERIOD STATS
  // ═══════════════════════════════════════════════════════════════
  
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const currentHalf = currentMonth < 6 ? 1 : 2;
  const halfStartMonth = currentHalf === 1 ? 0 : 6;
  const monthNames = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  
  const playerStats = players.map(p => {
    const thisYearGames = p.gameHistory.filter(g => parseGameDate(g.date).getFullYear() === currentYear);
    const thisHalfGames = p.gameHistory.filter(g => {
      const d = parseGameDate(g.date);
      return d.getFullYear() === currentYear && d.getMonth() >= halfStartMonth && d.getMonth() < halfStartMonth + 6;
    });
    const thisMonthGames = p.gameHistory.filter(g => {
      const d = parseGameDate(g.date);
      return d.getFullYear() === currentYear && d.getMonth() === currentMonth;
    });
    const last5 = p.gameHistory.slice(0, 5);
    const last3 = p.gameHistory.slice(0, 3);
    
    return {
      ...p,
      yearProfit: thisYearGames.reduce((sum, g) => sum + g.profit, 0),
      yearGames: thisYearGames.length,
      halfProfit: thisHalfGames.reduce((sum, g) => sum + g.profit, 0),
      halfGames: thisHalfGames.length,
      monthProfit: thisMonthGames.reduce((sum, g) => sum + g.profit, 0),
      monthGames: thisMonthGames.length,
      last5Avg: last5.length > 0 ? last5.reduce((sum, g) => sum + g.profit, 0) / last5.length : 0,
      last3Avg: last3.length > 0 ? last3.reduce((sum, g) => sum + g.profit, 0) / last3.length : 0,
      lastGameProfit: p.gameHistory[0]?.profit || 0,
    };
  });
  
  const sortedAllTime = [...playerStats].sort((a, b) => b.totalProfit - a.totalProfit);
  const sortedYear = [...playerStats].sort((a, b) => b.yearProfit - a.yearProfit);
  const sortedMonth = [...playerStats].sort((a, b) => b.monthProfit - a.monthProfit);
  
  // ═══════════════════════════════════════════════════════════════
  // CATEGORY 1: BATTLES - Head-to-head clashes happening tonight
  // ═══════════════════════════════════════════════════════════════
  
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
      break; // Only show the most important battle
    }
  }
  
  // 1B. YEAR TABLE BATTLE (only if year has enough data)
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
  
  // 1C. REVENGE MATCH - Player who lost to someone last game and they're both here
  const revengeOpportunities = playerStats
    .filter(p => p.lastGameProfit < -50 && p.gamesPlayed >= 5)
    .filter(() => {
      // Find if any tonight's player won big when they lost
      const winnersLastGame = playerStats.filter(w => w.lastGameProfit > 50);
      return winnersLastGame.length > 0;
    });
  
  if (revengeOpportunities.length > 0 && playerStats.filter(p => p.lastGameProfit > 50).length > 0) {
    const bigLoser = revengeOpportunities.sort((a, b) => a.lastGameProfit - b.lastGameProfit)[0];
    const bigWinner = playerStats.filter(p => p.lastGameProfit > 50).sort((a, b) => b.lastGameProfit - a.lastGameProfit)[0];
    milestones.push({
      emoji: '🔥',
      category: 'battle',
      title: 'מפגש נקמה',
      description: `${bigLoser.name} (${formatProfit(bigLoser.lastGameProfit)} במשחק האחרון) נגד ${bigWinner.name} (${formatProfit(bigWinner.lastGameProfit)}). הלילה זה אישי.`,
      priority: 85
    });
  }
  
  // ═══════════════════════════════════════════════════════════════
  // CATEGORY 2: STREAKS - Hot and cold momentum
  // ═══════════════════════════════════════════════════════════════
  
  // 2A. HOT STREAK (3+ wins)
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
  
  // 2B. COLD STREAK - Only the worst one
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
  
  // 2C. STREAK BATTLE - Hot vs Cold meeting tonight
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
  
  // ═══════════════════════════════════════════════════════════════
  // CATEGORY 3: MILESTONES - Numeric achievements within reach
  // ═══════════════════════════════════════════════════════════════
  
  // 3A. ROUND NUMBER MILESTONES (500, 1000, 1500, 2000)
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
    .sort((a, b) => a!.distance - b!.distance);
  
  if (milestoneCandidates.length > 0) {
    const best = milestoneCandidates[0]!;
    milestones.push({
      emoji: '🎯',
      category: 'milestone',
      title: `יעד ${best.target.toLocaleString()}₪`,
      description: `${best.player.name} על ${formatProfit(best.player.totalProfit)} בטבלה הכללית. עוד ${Math.round(best.distance)}₪ = חציית רף ${best.target.toLocaleString()}₪!`,
      priority: 78 + Math.round(best.target / 200)
    });
  }
  
  // 3B. GAMES MILESTONE (10, 25, 50, 75, 100, 150, 200)
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
  
  // 3C. RECOVERY TO POSITIVE (Year)
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
  
  // ═══════════════════════════════════════════════════════════════
  // CATEGORY 4: FORM - Who's playing above/below their level
  // ═══════════════════════════════════════════════════════════════
  
  // 4A. OVERPERFORMING - Playing way above average
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
  
  // 4B. UNDERPERFORMING - Playing below average
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
  
  // ═══════════════════════════════════════════════════════════════
  // CATEGORY 5: DRAMA - Compelling narratives
  // ═══════════════════════════════════════════════════════════════
  
  // 5A. UNDERDOG RISING - Bottom player won last game
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
  
  // 5B. LEADER SLIPPING - #1 lost last game
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
  
  // 5C. UPSET POTENTIAL - Usually loses but won recently
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
  
  // 5D. VOLATILE SWINGS - Wild recent results
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
  
  // ═══════════════════════════════════════════════════════════════
  // CATEGORY 6: RECORDS - Group records and achievements
  // ═══════════════════════════════════════════════════════════════
  
  // 6A. APPROACHING BIGGEST WIN RECORD
  const biggestWin = Math.max(...players.map(p => p.bestWin));
  const recordHolder = players.find(p => p.bestWin === biggestWin);
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
  
  // ═══════════════════════════════════════════════════════════════
  // CATEGORY 7: SEASON - Time-based context
  // ═══════════════════════════════════════════════════════════════
  
  // 7A. MONTHLY LEADER
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
  
  // 7B. YEAR-END SPECIAL (December only)
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
  
  // 7C. FRESH START (January only, and only if very few games played)
  if (currentMonth === 0) { // January only
    const totalYearGames = playerStats.reduce((sum, p) => sum + p.yearGames, 0);
    // Only show if less than 2 total games played this year
    if (totalYearGames <= 1) {
      milestones.push({
        emoji: '🎆',
        category: 'season',
        title: `${currentYear} מתחילה`,
        description: `שנה חדשה, טבלה חדשה. ${players.length} שחקנים מתחילים מחדש. מי יוביל ב-${currentYear}?`,
        priority: 85
      });
    }
  }
  
  // 7D. EARLY YEAR LEADER (January/February with some games played)
  if (currentMonth <= 1 && sortedYear[0]?.yearGames >= 2) {
    const yearLeader = sortedYear[0];
    const yearSecond = sortedYear[1];
    if (yearSecond && yearSecond.yearGames >= 1) {
      const gap = Math.round(yearLeader.yearProfit - yearSecond.yearProfit);
      if (gap > 0 && gap <= 200) {
        milestones.push({
          emoji: '📅',
          category: 'season',
          title: `מוביל ${currentYear}`,
          description: `${yearLeader.name} מוביל את ${currentYear} עם ${formatProfit(yearLeader.yearProfit)} ב-${yearLeader.yearGames} משחקים. ${yearSecond.name} רודף ב-${gap}₪.`,
          priority: 80
        });
      }
    }
  }
  
  // ═══════════════════════════════════════════════════════════════
  // DEDUPLICATION & SELECTION
  // ═══════════════════════════════════════════════════════════════
  
  // Sort by priority
  milestones.sort((a, b) => b.priority - a.priority);
  
  // Deduplicate: max 1 per category (except battles and drama which are exciting)
  const selected: MilestoneItem[] = [];
  const playerMentions: Record<string, number> = {};
  
  for (const m of milestones) {
    // Skip if category already used (battles and drama get 2 slots)
    const categoryLimit = (m.category === 'battle' || m.category === 'drama') ? 2 : 1;
    const categoryCount = selected.filter(s => s.category === m.category).length;
    if (categoryCount >= categoryLimit) continue;
    
    // Skip if player mentioned too many times (max 1 as MAIN subject, max 2 total)
    const mentionedPlayers = players.filter(p => m.title.includes(p.name) || m.description.includes(p.name)).map(p => p.name);
    const isMainSubject = mentionedPlayers.length === 1 || m.title.includes(mentionedPlayers[0]);
    
    // If this player is the MAIN subject and already appeared as main subject, skip
    if (isMainSubject && mentionedPlayers.some(name => (playerMentions[name] || 0) >= 1)) continue;
    // If player mentioned too many times overall, skip
    if (mentionedPlayers.some(name => (playerMentions[name] || 0) >= 2)) continue;
    
    // Accept
    selected.push(m);
    mentionedPlayers.forEach(name => playerMentions[name] = (playerMentions[name] || 0) + 1);
    
    // Stop at 8 milestones
    if (selected.length >= 8) break;
  }
  
  // Ensure minimum of 5
  if (selected.length < 5) {
    for (const m of milestones) {
      if (!selected.includes(m)) {
        selected.push(m);
        if (selected.length >= 5) break;
      }
    }
  }
  
  return selected;
};

/**
 * Generate AI-powered forecasts for selected players only
 */
export const generateAIForecasts = async (
  players: PlayerForecastData[],
  globalRankings?: GlobalRankingContext
): Promise<ForecastResult[]> => {
  const apiKey = getGeminiApiKey();
  
  if (!apiKey) {
    throw new Error('NO_API_KEY');
  }

  // Calculate ALL-TIME RECORDS for the group
  const allTimeRecords: string[] = [];
  
  // Find record holders among tonight's players
  const sortedByTotalProfit = [...players].sort((a, b) => b.totalProfit - a.totalProfit);
  const sortedByBestWin = [...players].sort((a, b) => b.bestWin - a.bestWin);
  const sortedByWorstLoss = [...players].sort((a, b) => a.worstLoss - b.worstLoss);
  const sortedByWinRate = [...players].filter(p => p.gamesPlayed >= 5).sort((a, b) => b.winPercentage - a.winPercentage);
  const sortedByGames = [...players].sort((a, b) => b.gamesPlayed - a.gamesPlayed);
  const sortedByAvg = [...players].filter(p => p.gamesPlayed >= 3).sort((a, b) => b.avgProfit - a.avgProfit);
  
  // Highest all-time profit
  if (sortedByTotalProfit[0]?.totalProfit > 0) {
    allTimeRecords.push(`🥇 All-Time Profit Leader: ${sortedByTotalProfit[0].name} with +${sortedByTotalProfit[0].totalProfit}₪ total`);
  }
  
  // Biggest single-night win
  if (sortedByBestWin[0]?.bestWin > 0) {
    allTimeRecords.push(`💰 Biggest Single-Night Win: ${sortedByBestWin[0].name} once won +${sortedByBestWin[0].bestWin}₪`);
  }
  
  // Biggest single-night loss
  if (sortedByWorstLoss[0]?.worstLoss < 0) {
    allTimeRecords.push(`📉 Biggest Single-Night Loss: ${sortedByWorstLoss[0].name} once lost ${sortedByWorstLoss[0].worstLoss}₪`);
  }
  
  // Highest win rate (min 5 games)
  if (sortedByWinRate.length > 0) {
    allTimeRecords.push(`🎯 Best Win Rate: ${sortedByWinRate[0].name} wins ${Math.round(sortedByWinRate[0].winPercentage)}% of games (${sortedByWinRate[0].winCount}/${sortedByWinRate[0].gamesPlayed})`);
  }
  
  // Most games played
  if (sortedByGames[0]?.gamesPlayed > 0) {
    allTimeRecords.push(`🎮 Most Games Played: ${sortedByGames[0].name} with ${sortedByGames[0].gamesPlayed} games`);
  }
  
  // Best average (min 3 games)
  if (sortedByAvg.length > 0 && sortedByAvg[0].avgProfit > 0) {
    allTimeRecords.push(`📊 Best Average: ${sortedByAvg[0].name} averages +${Math.round(sortedByAvg[0].avgProfit)}₪ per game`);
  }
  
  // Longest current winning streak
  const longestWinStreak = players.reduce((max, p) => p.currentStreak > max.streak ? { name: p.name, streak: p.currentStreak } : max, { name: '', streak: 0 });
  if (longestWinStreak.streak >= 2) {
    allTimeRecords.push(`🔥 Current Hot Streak: ${longestWinStreak.name} is on a ${longestWinStreak.streak}-game winning streak`);
  }
  
  // Longest current losing streak
  const longestLoseStreak = players.reduce((max, p) => p.currentStreak < max.streak ? { name: p.name, streak: p.currentStreak } : max, { name: '', streak: 0 });
  if (longestLoseStreak.streak <= -2) {
    allTimeRecords.push(`❄️ Cold Streak: ${longestLoseStreak.name} is on a ${Math.abs(longestLoseStreak.streak)}-game losing streak`);
  }
  
  const allTimeRecordsText = allTimeRecords.join('\n');
  
  // ========== CALCULATE MILESTONES ==========
  const milestones: string[] = [];
  
  // Helper: Parse date from game history (handles multiple formats)
  const parseGameDate = (dateStr: string): Date => {
    // Try DD/MM/YYYY format first (with slashes)
    let parts = dateStr.split('/');
    if (parts.length >= 3) {
      const day = parseInt(parts[0]);
      const month = parseInt(parts[1]) - 1;
      let year = parseInt(parts[2]);
      if (year < 100) year += 2000;
      return new Date(year, month, day);
    }
    // Try DD.MM.YYYY format (with dots - Hebrew locale)
    parts = dateStr.split('.');
    if (parts.length >= 3) {
      const day = parseInt(parts[0]);
      const month = parseInt(parts[1]) - 1;
      let year = parseInt(parts[2]);
      if (year < 100) year += 2000;
      return new Date(year, month, day);
    }
    // Fallback to ISO format or other parseable formats
    return new Date(dateStr);
  };
  
  // Current date info
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const currentHalf = currentMonth < 6 ? 1 : 2; // H1 = Jan-Jun, H2 = Jul-Dec
  const halfStartMonth = currentHalf === 1 ? 0 : 6;
  const monthNames = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  
  // Calculate period-specific stats for each player
  const playerPeriodStats = players.map(p => {
    const thisYearGames = p.gameHistory.filter(g => {
      const d = parseGameDate(g.date);
      return d.getFullYear() === currentYear;
    });
    const thisHalfGames = p.gameHistory.filter(g => {
      const d = parseGameDate(g.date);
      return d.getFullYear() === currentYear && d.getMonth() >= halfStartMonth && d.getMonth() < halfStartMonth + 6;
    });
    const thisMonthGames = p.gameHistory.filter(g => {
      const d = parseGameDate(g.date);
      return d.getFullYear() === currentYear && d.getMonth() === currentMonth;
    });
    const last5Games = p.gameHistory.slice(0, 5);
    
    return {
      // Original data first
      ...p,
      // This year (calculated stats)
      yearProfit: thisYearGames.reduce((sum, g) => sum + g.profit, 0),
      yearGames: thisYearGames.length,
      yearWins: thisYearGames.filter(g => g.profit > 0).length,
      // This half
      halfProfit: thisHalfGames.reduce((sum, g) => sum + g.profit, 0),
      halfGames: thisHalfGames.length,
      halfWins: thisHalfGames.filter(g => g.profit > 0).length,
      // This month
      monthProfit: thisMonthGames.reduce((sum, g) => sum + g.profit, 0),
      monthGames: thisMonthGames.length,
      monthWins: thisMonthGames.filter(g => g.profit > 0).length,
      // Last 5 games
      last5Profit: last5Games.reduce((sum, g) => sum + g.profit, 0),
      last5Wins: last5Games.filter(g => g.profit > 0).length,
    };
  });
  
  // ===== 1. ALL-TIME LEADERBOARD PASSING =====
  for (let i = 1; i < sortedByTotalProfit.length; i++) {
    const chaser = sortedByTotalProfit[i];
    const leader = sortedByTotalProfit[i - 1];
    const gap = leader.totalProfit - chaser.totalProfit;
    if (gap > 0 && gap <= 250) {
      milestones.push(`📈 ALL-TIME LEADERBOARD: ${chaser.name} (#${i + 1}, ${chaser.totalProfit >= 0 ? '+' : ''}${chaser.totalProfit}₪ כולל) can PASS ${leader.name} (#${i}, ${leader.totalProfit >= 0 ? '+' : ''}${leader.totalProfit}₪) with a +${gap}₪ win tonight!`);
    }
  }
  
  // ===== 2. THIS YEAR LEADERBOARD =====
  const sortedByYearProfit = [...playerPeriodStats].sort((a, b) => b.yearProfit - a.yearProfit);
  for (let i = 1; i < sortedByYearProfit.length && i <= 3; i++) {
    const chaser = sortedByYearProfit[i];
    const leader = sortedByYearProfit[i - 1];
    const gap = leader.yearProfit - chaser.yearProfit;
    if (gap > 0 && gap <= 200 && chaser.yearGames >= 2) {
      milestones.push(`📅 THIS YEAR (${currentYear}): ${chaser.name} is #${i + 1} this year with ${chaser.yearProfit >= 0 ? '+' : ''}${chaser.yearProfit}₪. A +${gap}₪ win tonight would move them past ${leader.name} to #${i}!`);
    }
  }
  
  // ===== 3. THIS HALF LEADERBOARD =====
  const halfName = currentHalf === 1 ? 'H1' : 'H2';
  const sortedByHalfProfit = [...playerPeriodStats].sort((a, b) => b.halfProfit - a.halfProfit);
  for (let i = 1; i < sortedByHalfProfit.length && i <= 3; i++) {
    const chaser = sortedByHalfProfit[i];
    const leader = sortedByHalfProfit[i - 1];
    const gap = leader.halfProfit - chaser.halfProfit;
    if (gap > 0 && gap <= 150 && chaser.halfGames >= 2) {
      milestones.push(`📊 THIS HALF (${halfName} ${currentYear}): ${chaser.name} is at ${chaser.halfProfit >= 0 ? '+' : ''}${chaser.halfProfit}₪ this half. +${gap}₪ tonight = passing ${leader.name} for #${i}!`);
    }
  }
  
  // ===== 4. MONTHLY MILESTONES =====
  const sortedByMonthProfit = [...playerPeriodStats].sort((a, b) => b.monthProfit - a.monthProfit);
  if (sortedByMonthProfit[0]?.monthGames >= 1) {
    const monthLeader = sortedByMonthProfit[0];
    // Check if someone can become "Player of the Month"
    for (let i = 1; i < sortedByMonthProfit.length && i <= 2; i++) {
      const chaser = sortedByMonthProfit[i];
      const gap = monthLeader.monthProfit - chaser.monthProfit;
      if (gap > 0 && gap <= 150 && chaser.monthGames >= 1) {
        milestones.push(`🗓️ ${monthNames[currentMonth].toUpperCase()}: ${chaser.name} is ${gap}₪ behind ${monthLeader.name} for "Player of the Month"! A big win tonight could claim the title.`);
      }
    }
  }
  
  // ===== 5. ALL-TIME ROUND NUMBERS =====
  const roundNumbers = [500, 1000, 1500, 2000, 2500, 3000];
  players.forEach(p => {
    for (const milestone of roundNumbers) {
      const distance = milestone - p.totalProfit;
      if (distance > 0 && distance <= 200) {
        milestones.push(`🎯 ALL-TIME MILESTONE: ${p.name} is at ${p.totalProfit >= 0 ? '+' : ''}${p.totalProfit}₪ כולל. Only ${distance}₪ more to cross +${milestone}₪ all-time!`);
        break;
      }
      const negDistance = p.totalProfit - (-milestone);
      if (p.totalProfit < 0 && negDistance > 0 && negDistance <= 200) {
        milestones.push(`⚠️ DANGER ZONE: ${p.name} is at ${p.totalProfit}₪ כולל. A ${negDistance}₪ loss = dropping to -${milestone}₪ all-time!`);
        break;
      }
    }
  });
  
  // ===== 6. YEARLY ROUND NUMBERS =====
  playerPeriodStats.forEach(p => {
    if (p.yearGames >= 3) {
      for (const milestone of [500, 1000]) {
        const distance = milestone - p.yearProfit;
        if (distance > 0 && distance <= 150) {
          milestones.push(`📅 ${currentYear} MILESTONE: ${p.name} is at ${p.yearProfit >= 0 ? '+' : ''}${p.yearProfit}₪ this year. ${distance}₪ more = +${milestone}₪ for the year!`);
          break;
        }
      }
    }
  });
  
  // ===== 7. STREAK RECORDS =====
  const groupWinStreakRecord = Math.max(...players.map(p => p.currentStreak), 0);
  const groupLoseStreakRecord = Math.min(...players.map(p => p.currentStreak), 0);
  
  players.forEach(p => {
    if (p.currentStreak >= 3 && p.currentStreak >= groupWinStreakRecord) {
      milestones.push(`🔥 WINNING STREAK RECORD: ${p.name} is on ${p.currentStreak} wins in a row (tied for group record!). Win tonight = NEW ALL-TIME RECORD of ${p.currentStreak + 1}!`);
    }
    if (p.currentStreak <= -3 && p.currentStreak <= groupLoseStreakRecord) {
      milestones.push(`❄️ LOSING STREAK RECORD: ${p.name} is on ${Math.abs(p.currentStreak)} losses in a row (worst in group!). Another loss = new unfortunate record of ${Math.abs(p.currentStreak) + 1}!`);
    }
  });
  
  // ===== 8. SINGLE-NIGHT WIN RECORD =====
  const biggestWinRecord = Math.max(...players.map(p => p.bestWin));
  const recordHolder = players.find(p => p.bestWin === biggestWinRecord);
  players.forEach(p => {
    if (p.currentStreak >= 2 && p.bestWin < biggestWinRecord && biggestWinRecord - p.bestWin <= 150) {
      milestones.push(`💰 WIN RECORD: Group record is +${biggestWinRecord}₪ by ${recordHolder?.name}. ${p.name}'s best is +${p.bestWin}₪. A +${biggestWinRecord + 1}₪ night = NEW RECORD!`);
    }
  });
  
  // ===== 9. COMEBACK OPPORTUNITIES =====
  players.forEach(p => {
    if (p.currentStreak <= -2 && p.totalProfit > 0) {
      milestones.push(`💪 COMEBACK: ${p.name} has ${Math.abs(p.currentStreak)} losses in a row, but still +${p.totalProfit}₪ all-time. Time for revenge!`);
    }
  });
  
  // ===== 10. FORM COMPARISON (Recent vs Historical) =====
  playerPeriodStats.forEach(p => {
    if (p.yearGames >= 5 && p.gamesPlayed >= 10) {
      const yearAvg = p.yearProfit / p.yearGames;
      const allTimeAvg = p.avgProfit;
      if (yearAvg > allTimeAvg + 30) {
        milestones.push(`📈 HOT YEAR: ${p.name}'s ${currentYear} average is +${Math.round(yearAvg)}₪/game vs +${Math.round(allTimeAvg)}₪ all-time. Best year ever?`);
      } else if (yearAvg < allTimeAvg - 30) {
        milestones.push(`📉 TOUGH YEAR: ${p.name}'s ${currentYear} average is ${Math.round(yearAvg)}₪/game vs +${Math.round(allTimeAvg)}₪ all-time. Turnaround tonight?`);
      }
    }
  });
  
  // ===== 11. GAMES MILESTONE (ALL-TIME) =====
  const gamesMilestones = [10, 25, 50, 75, 100, 150, 200];
  players.forEach(p => {
    for (const gm of gamesMilestones) {
      if (p.gamesPlayed === gm - 1) {
        milestones.push(`🎮 GAMES MILESTONE: Tonight is ${p.name}'s ${gm}th game ever with the group!`);
        break;
      }
    }
  });
  
  // ===== 12. YEARLY PARTICIPATION MILESTONES =====
  const yearGamesMilestones = [10, 20, 30, 40, 50];
  playerPeriodStats.forEach(p => {
    for (const gm of yearGamesMilestones) {
      if (p.yearGames === gm - 1) {
        milestones.push(`📅 PARTICIPATION: Tonight is ${p.name}'s ${gm}th game of ${currentYear}!`);
        break;
      }
    }
  });
  
  // ===== 13. WIN RATE MILESTONES =====
  const winRateMilestones = [50, 60, 70];
  players.filter(p => p.gamesPlayed >= 10).forEach(p => {
    const currentWinRate = p.winPercentage;
    for (const targetRate of winRateMilestones) {
      // Calculate: if they win tonight, what would their new win rate be?
      const winsNeeded = Math.ceil((targetRate / 100) * (p.gamesPlayed + 1));
      if (p.winCount === winsNeeded - 1 && currentWinRate < targetRate) {
        milestones.push(`🎯 WIN RATE: ${p.name} is at ${Math.round(currentWinRate)}% win rate. A win tonight = crossing ${targetRate}%!`);
        break;
      }
    }
  });
  
  // ===== 14. CLOSE BATTLES (players very close to each other) =====
  for (let i = 0; i < sortedByTotalProfit.length; i++) {
    for (let j = i + 1; j < sortedByTotalProfit.length; j++) {
      const higher = sortedByTotalProfit[i];
      const lower = sortedByTotalProfit[j];
      const gap = Math.abs(higher.totalProfit - lower.totalProfit);
      if (gap <= 30 && gap > 0) {
        milestones.push(`⚔️ CLOSE BATTLE: ${higher.name} (${higher.totalProfit >= 0 ? '+' : ''}${higher.totalProfit}₪) and ${lower.name} (${lower.totalProfit >= 0 ? '+' : ''}${lower.totalProfit}₪) are only ${gap}₪ apart all-time! Tonight decides who's ahead.`);
      }
    }
  }
  
  // ===== 15. PASSING ANYONE IN THE TABLE (not just adjacent) =====
  sortedByTotalProfit.forEach((p, idx) => {
    // Look at players 2-3 positions ahead
    for (let ahead = 2; ahead <= 3; ahead++) {
      if (idx >= ahead) {
        const target = sortedByTotalProfit[idx - ahead];
        const gap = target.totalProfit - p.totalProfit;
        if (gap > 0 && gap <= 180) {
          milestones.push(`🚀 JUMP: ${p.name} (#${idx + 1}) can jump ${ahead} places and pass ${target.name} (#${idx + 1 - ahead}) with a +${gap}₪ win!`);
          break;
        }
      }
    }
  });
  
  // ===== 16. RECOVERY TO POSITIVE (year/half) =====
  playerPeriodStats.forEach(p => {
    // Recovery to positive this year
    if (p.yearProfit < 0 && p.yearProfit > -150 && p.yearGames >= 3) {
      milestones.push(`🔄 RECOVERY: ${p.name} is at ${p.yearProfit}₪ for ${currentYear}. A +${Math.abs(p.yearProfit)}₪ win = back to positive for the year!`);
    }
    // Recovery to positive this half
    if (p.halfProfit < 0 && p.halfProfit > -120 && p.halfGames >= 2) {
      milestones.push(`🔄 HALF RECOVERY: ${p.name} is at ${p.halfProfit}₪ for ${halfName}. A +${Math.abs(p.halfProfit)}₪ win = positive half!`);
    }
  });
  
  // ===== 17. PERSONAL BEST MONTH POTENTIAL =====
  playerPeriodStats.forEach(p => {
    if (p.monthGames >= 2) {
      // Find their best month ever from history
      const monthlyProfits: { [key: string]: number } = {};
      p.gameHistory.forEach(g => {
        const d = parseGameDate(g.date);
        const key = `${d.getFullYear()}-${d.getMonth()}`;
        monthlyProfits[key] = (monthlyProfits[key] || 0) + g.profit;
      });
      const bestMonth = Math.max(...Object.values(monthlyProfits), 0);
      if (bestMonth > 0 && p.monthProfit > bestMonth - 150 && p.monthProfit < bestMonth) {
        const needed = bestMonth - p.monthProfit + 1;
        milestones.push(`🏆 BEST MONTH: ${p.name} is at ${p.monthProfit >= 0 ? '+' : ''}${p.monthProfit}₪ for ${monthNames[currentMonth]}. +${needed}₪ more = personal best month ever!`);
      }
    }
  });
  
  // ===== 18. EXACT TIES =====
  for (let i = 0; i < sortedByTotalProfit.length; i++) {
    for (let j = i + 1; j < sortedByTotalProfit.length; j++) {
      if (sortedByTotalProfit[i].totalProfit === sortedByTotalProfit[j].totalProfit && sortedByTotalProfit[i].totalProfit !== 0) {
        milestones.push(`🤝 TIED: ${sortedByTotalProfit[i].name} and ${sortedByTotalProfit[j].name} are EXACTLY tied at ${sortedByTotalProfit[i].totalProfit >= 0 ? '+' : ''}${sortedByTotalProfit[i].totalProfit}₪ all-time! Tonight breaks the tie.`);
      }
    }
  }
  
  // ===== 19. CONSECUTIVE GAMES PLAYED (attendance streak) =====
  players.forEach(p => {
    if (p.daysSinceLastGame <= 14 && p.gameHistory.length >= 5) {
      // Check if they played in last 5 games (assuming games are weekly-ish)
      const recentGames = p.gameHistory.slice(0, 5);
      const gamesInLast2Months = recentGames.filter(g => {
        const d = parseGameDate(g.date);
        const daysDiff = (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
        return daysDiff <= 60;
      }).length;
      if (gamesInLast2Months >= 5) {
        milestones.push(`🎯 ATTENDANCE: ${p.name} has played ${gamesInLast2Months} of the last 5 games - most consistent player!`);
      }
    }
  });
  
  // ===== 20. THIS MONTH GAMES COUNT =====
  playerPeriodStats.forEach(p => {
    if (p.monthGames === 2) {
      milestones.push(`📅 ${monthNames[currentMonth].toUpperCase()}: Tonight is ${p.name}'s 3rd game this month!`);
    } else if (p.monthGames === 4) {
      milestones.push(`📅 ${monthNames[currentMonth].toUpperCase()}: Tonight is ${p.name}'s 5th game this month - busiest month!`);
    }
  });
  
  const milestonesText = milestones.length > 0 ? milestones.join('\n') : '';

  // Helper: Get games for a specific half-year period
  const getHalfGames = (player: typeof players[0], year: number, half: 1 | 2) => {
    const startMonth = half === 1 ? 0 : 6;
    const endMonth = half === 1 ? 5 : 11;
    return player.gameHistory.filter(g => {
      const d = parseGameDate(g.date);
      return d.getFullYear() === year && d.getMonth() >= startMonth && d.getMonth() <= endMonth;
    });
  };
  
  // Helper: Get previous period (H1->prev year H2, H2->same year H1)
  const getPreviousPeriod = () => {
    if (currentHalf === 1) {
      return { year: currentYear - 1, half: 2 as const, label: `H2 ${currentYear - 1}` };
    } else {
      return { year: currentYear, half: 1 as const, label: `H1 ${currentYear}` };
    }
  };
  
  const currentPeriodLabel = `H${currentHalf} ${currentYear}`;
  const prevPeriod = getPreviousPeriod();

  // Calculate SUGGESTED expected profit for each player
  // Use AMPLIFIED predictions for more interesting forecasts
  const playerSuggestions = players.map(p => {
    // Use CURRENT HALF games first (matches the visible table!)
    const currentHalfGames = getHalfGames(p, currentYear, currentHalf);
    const prevHalfGames = getHalfGames(p, prevPeriod.year, prevPeriod.half);
    
    // Determine which period to use
    let periodGames = currentHalfGames;
    let usingPrevPeriod = false;
    
    if (currentHalfGames.length < 2 && prevHalfGames.length >= 2) {
      // Fall back to previous period
      periodGames = prevHalfGames;
      usingPrevPeriod = true;
    }
    
    const periodAvg = periodGames.length > 0 
      ? periodGames.reduce((sum, g) => sum + g.profit, 0) / periodGames.length 
      : 0;
    
    // Weighted score: 70% current period, 30% all-time (if has period data)
    let suggested = p.gamesPlayed === 0 ? 0 : 
      periodGames.length >= 2 ? (periodAvg * 0.7) + (p.avgProfit * 0.3) : p.avgProfit;
    
    // Apply streak modifiers
    if (p.currentStreak >= 4) suggested *= 1.5;
    else if (p.currentStreak >= 3) suggested *= 1.35;
    else if (p.currentStreak >= 2) suggested *= 1.2;
    else if (p.currentStreak <= -4) suggested *= 0.5;
    else if (p.currentStreak <= -3) suggested *= 0.65;
    else if (p.currentStreak <= -2) suggested *= 0.8;
    
    // AMPLIFY: Multiply by 2-3x to get more interesting ranges (typical game swings are ±50-150)
    suggested *= 2.5;
    
    // Ensure minimum meaningful prediction (at least ±30₪ unless truly neutral)
    if (suggested > 0 && suggested < 30) suggested = 30;
    if (suggested < 0 && suggested > -30) suggested = -30;
    
    return { name: p.name, suggested: Math.round(suggested) };
  });
  
  // Balance suggestions to zero-sum
  const totalSuggested = playerSuggestions.reduce((sum, p) => sum + p.suggested, 0);
  const adjustment = totalSuggested / playerSuggestions.length;
  playerSuggestions.forEach(p => {
    p.suggested = Math.round(p.suggested - adjustment);
    // After balancing, re-apply minimum threshold
    if (p.suggested > 0 && p.suggested < 25) p.suggested = 25;
    if (p.suggested < 0 && p.suggested > -25) p.suggested = -25;
  });
  
  // Re-balance after minimum threshold (small adjustment)
  const finalTotal = playerSuggestions.reduce((sum, p) => sum + p.suggested, 0);
  if (finalTotal !== 0) {
    // Adjust the player closest to 0 to balance
    const sortedByAbs = [...playerSuggestions].sort((a, b) => Math.abs(a.suggested) - Math.abs(b.suggested));
    sortedByAbs[0].suggested -= finalTotal;
  }
  
  // Pre-select SURPRISE candidates (bad all-time history but good CURRENT PERIOD = surprise WIN expected)
  const surpriseCandidates = players.filter(p => {
    if (p.gamesPlayed < 5) return false;
    
    // Use CURRENT HALF games for "recent" performance
    const halfGames = getHalfGames(p, currentYear, currentHalf);
    if (halfGames.length < 2) return false;
    
    const halfAvg = halfGames.reduce((sum, g) => sum + g.profit, 0) / halfGames.length;
    
    // SURPRISE = bad all-time history but good CURRENT PERIOD (unexpected WIN)
    // This ensures surprise always means POSITIVE prediction
    return p.avgProfit < -5 && halfAvg > 10;
  });
  
  // Pick 0-1 surprise (only if good candidate exists)
  const selectedSurprises = surpriseCandidates.length > 0 
    ? [surpriseCandidates.sort((a, b) => {
        const aHalfGames = getHalfGames(a, currentYear, currentHalf);
        const bHalfGames = getHalfGames(b, currentYear, currentHalf);
        const aHalfAvg = aHalfGames.length > 0 ? aHalfGames.reduce((sum, g) => sum + g.profit, 0) / aHalfGames.length : 0;
        const bHalfAvg = bHalfGames.length > 0 ? bHalfGames.reduce((sum, g) => sum + g.profit, 0) / bHalfGames.length : 0;
        return bHalfAvg - aHalfAvg; // Pick the one with best current period form
      })[0].name]
    : [];
  
  // If we have a surprise, ensure their suggestion is POSITIVE
  if (selectedSurprises.length > 0) {
    const surprisePlayer = playerSuggestions.find(p => p.name === selectedSurprises[0]);
    if (surprisePlayer && surprisePlayer.suggested < 50) {
      // Boost surprise player to positive
      const oldValue = surprisePlayer.suggested;
      surprisePlayer.suggested = Math.max(50, Math.abs(oldValue) + 30);
      // Re-balance by reducing from highest positive player
      const highest = playerSuggestions.filter(p => p.name !== selectedSurprises[0]).sort((a, b) => b.suggested - a.suggested)[0];
      if (highest) highest.suggested -= (surprisePlayer.suggested - oldValue);
    }
  }
  
  const surpriseText = selectedSurprises.length > 0 
    ? `\n🎲 הפתעה: ${selectedSurprises.join(', ')} (היסטוריה שלילית אבל פורמה אחרונה חיובית - צפי לניצחון מפתיע!)`
    : '';
  
  // Pre-calculate year profit for all players to sort by 2026 ranking
  const playersWithYearStats = players.map(p => {
    const thisYearGames = p.gameHistory.filter(g => parseGameDate(g.date).getFullYear() === currentYear);
    return {
      ...p,
      yearProfit: thisYearGames.reduce((sum, g) => sum + g.profit, 0),
      yearGames: thisYearGames.length
    };
  });
  
  // Sort by YEAR PROFIT (2026) - this is "tonight's" ranking!
  const tonightRanking = [...playersWithYearStats].sort((a, b) => b.yearProfit - a.yearProfit);
  
  // Build the prompt with FULL player data (in English for better AI reasoning)
  const playerDataText = playersWithYearStats.map((p, i) => {
    // Get explicit last game result
    const lastGame = p.gameHistory[0];
    const lastGameResult = lastGame 
      ? (lastGame.profit > 0 ? `WON +${Math.round(lastGame.profit)}₪` : 
         lastGame.profit < 0 ? `LOST ${Math.round(lastGame.profit)}₪` : 'BREAK-EVEN')
      : 'No games';
    
    // Check for comeback after long absence (30+ days is notable)
    const comebackText = p.daysSinceLastGame >= 90 
      ? `🔙 COMEBACK AFTER 3+ MONTHS! (${p.daysSinceLastGame} days since last game)`
      : p.daysSinceLastGame >= 60
        ? `🔙 RETURNING AFTER 2 MONTHS! (${p.daysSinceLastGame} days since last game)`
        : p.daysSinceLastGame >= 30
          ? `🔙 Back after a month break (${p.daysSinceLastGame} days)`
          : null;
    
    // Use pre-calculated year stats
    const yearProfit = p.yearProfit;
    const yearGames = p.yearGames;
    
    // USE THE ACTUAL CURRENT STREAK (spans across years!)
    const actualStreak = p.currentStreak;
    
    // Build simple streak text
    let streakText = '';
    if (actualStreak >= 3) {
      streakText = `🔥 ${actualStreak} WINS IN A ROW!`;
    } else if (actualStreak <= -3) {
      streakText = `${Math.abs(actualStreak)} losses - looking for comeback`;
    } else if (actualStreak === 2) {
      streakText = `2 wins in a row`;
    } else if (actualStreak === -2) {
      streakText = `2 losses - due for a win`;
    } else if (actualStreak === 1) {
      streakText = `Won last game`;
    } else if (actualStreak === -1) {
      streakText = `Lost last game`;
    } else {
      streakText = `${yearGames} games in ${currentYear}`;
    }
    
    // Combine streak with explicit last game (to prevent AI confusion)
    const lastGameInfo = `LAST GAME: ${lastGameResult} (${lastGame?.date || 'N/A'})`;
    
    // Get CURRENT HALF games (matches what players see in the period table!)
    const currentHalfGames = getHalfGames(p, currentYear, currentHalf);
    const prevHalfGames = getHalfGames(p, prevPeriod.year, prevPeriod.half);
    
    // Determine which period to show
    let periodGames = currentHalfGames;
    let periodLabel = currentPeriodLabel;
    let usingPrevPeriod = false;
    
    if (currentHalfGames.length === 0 && prevHalfGames.length > 0) {
      // Fall back to previous period
      periodGames = prevHalfGames;
      periodLabel = prevPeriod.label;
      usingPrevPeriod = true;
    }
    
    // Recent average = current period average (to match the visible table)
    const recentAvg = periodGames.length > 0 
      ? Math.round(periodGames.reduce((sum, g) => sum + g.profit, 0) / periodGames.length) 
      : 0;
    
    // Get suggested expected profit
    const suggestion = playerSuggestions.find(s => s.name === p.name)?.suggested || 0;
    
    // DEBUG: Log year profit calculation
    console.log(`🔍 ${p.name}: ${yearGames} games in ${currentYear}, Year Profit: ${yearProfit >= 0 ? '+' : ''}${Math.round(yearProfit)}₪, Total Profit: ${p.totalProfit >= 0 ? '+' : ''}${Math.round(p.totalProfit)}₪`);
    
    // Format game history
    const gameHistoryText = p.gameHistory.length > 0
      ? p.gameHistory.slice(0, 10).map(g => `${g.date}: ${g.profit >= 0 ? '+' : ''}${Math.round(g.profit)}₪`).join(' | ')
      : 'New player - no history';
    
    // Calculate current half stats
    const halfStartMonth = currentHalf === 1 ? 0 : 6;
    const thisHalfGames = p.gameHistory.filter(g => {
      const d = parseGameDate(g.date);
      return d.getFullYear() === currentYear && d.getMonth() >= halfStartMonth && d.getMonth() < halfStartMonth + 6;
    });
    const halfProfit = thisHalfGames.reduce((sum, g) => sum + g.profit, 0);
    const halfGamesCount = thisHalfGames.length;
    
    // ========== GLOBAL RANKINGS (among ALL active players, not just tonight's) ==========
    // Use global rankings if provided, otherwise fall back to tonight's players only
    
    // ALL-TIME ranking (among active players with 33% of games)
    const allTimeRankData = globalRankings?.allTime.rankings.find(r => r.name === p.name);
    const allTimeRank = allTimeRankData?.rank || 0;
    const allTimeTotalActive = globalRankings?.allTime.totalActivePlayers || players.length;
    const allTimeThreshold = globalRankings?.allTime.threshold || 0;
    const isActiveAllTime = allTimeRank > 0;
    
    // Get players above/below in all-time ranking (from global context)
    const allTimeRankings = globalRankings?.allTime.rankings || [];
    const allTimeAbove = allTimeRank > 1 ? allTimeRankings.find(r => r.rank === allTimeRank - 1) : null;
    const allTimeBelow = allTimeRank < allTimeTotalActive ? allTimeRankings.find(r => r.rank === allTimeRank + 1) : null;
    const gapToAboveAllTime = allTimeAbove ? Math.round(allTimeAbove.profit - p.totalProfit) : null;
    const gapToBelowAllTime = allTimeBelow ? Math.round(p.totalProfit - allTimeBelow.profit) : null;
    
    // YEAR ranking (among active players with 33% of this year's games)
    const yearRankData = globalRankings?.currentYear.rankings.find(r => r.name === p.name);
    const yearRank = yearRankData?.rank || 0;
    const yearTotalActive = globalRankings?.currentYear.totalActivePlayers || players.length;
    const yearThreshold = globalRankings?.currentYear.threshold || 0;
    const isActiveYear = yearRank > 0;
    
    // HALF ranking
    const halfRankData = globalRankings?.currentHalf.rankings.find(r => r.name === p.name);
    const halfRank = halfRankData?.rank || 0;
    const halfTotalActive = globalRankings?.currentHalf.totalActivePlayers || players.length;
    const halfThreshold = globalRankings?.currentHalf.threshold || 0;
    const isActiveHalf = halfRank > 0;
    
    // Use GLOBAL HALF ranking if available (matches the visible period table!)
    // This is the rank among ALL active players, not just tonight's
    let rankTonight: number;
    let rankTotalPlayers: number;
    
    if (halfRank > 0) {
      // Use global half ranking (among all active players)
      rankTonight = halfRank;
      rankTotalPlayers = halfTotalActive;
    } else {
      // Fallback: rank among tonight's players by year profit
      rankTonight = tonightRanking.findIndex(sp => sp.name === p.name) + 1;
      rankTotalPlayers = players.length;
    }
    
    const tonightAbove = rankTonight > 1 ? tonightRanking[rankTonight - 2] : null;
    const tonightBelow = rankTonight < players.length ? tonightRanking[rankTonight] : null;
    const gapToAboveTonight = tonightAbove ? Math.round(tonightAbove.yearProfit - p.yearProfit) : null;
    const gapToBelowTonight = tonightBelow ? Math.round(p.yearProfit - tonightBelow.yearProfit) : null;

    // Calculate all-time rank among tonight's players (for comparison)
    const allTimeRankTonight = [...players].sort((a, b) => b.totalProfit - a.totalProfit).findIndex(sp => sp.name === p.name) + 1;
    
    // Calculate trend: compare recent avg to all-time avg
    const allTimeAvg = Math.round(p.avgProfit);
    const trendDiff = recentAvg - allTimeAvg;
    let trendText = '';
    if (p.totalProfit < -100 && recentAvg > 0) {
      // TURNAROUND has priority - most interesting story
      trendText = `📈 מגמת שיפור! היסטוריה: ${Math.round(p.totalProfit)}₪ | לאחרונה: ממוצע ${recentAvg >= 0 ? '+' : ''}${recentAvg}₪`;
    } else if (p.totalProfit > 100 && recentAvg < -10) {
      trendText = `📉 בירידה. היסטוריה: +${Math.round(p.totalProfit)}₪ | לאחרונה: ממוצע ${recentAvg}₪`;
    } else if (trendDiff >= 20) {
      trendText = `📈 משתפר: ממוצע אחרון ${recentAvg >= 0 ? '+' : ''}${recentAvg}₪ vs היסטורי ${allTimeAvg >= 0 ? '+' : ''}${allTimeAvg}₪`;
    } else if (trendDiff <= -20) {
      trendText = `📉 יורד: ממוצע אחרון ${recentAvg >= 0 ? '+' : ''}${recentAvg}₪ vs היסטורי ${allTimeAvg >= 0 ? '+' : ''}${allTimeAvg}₪`;
    }
    
    // Build concise player data block
    const lines = [];
    lines.push(`══ ${p.name} ${p.isFemale ? '(נקבה)' : ''} ══`);
    
    if (comebackText) lines.push(`🔙 ${comebackText}`);
    
    lines.push(`משחק אחרון: ${lastGameResult}`);
    if (streakText) lines.push(`רצף: ${streakText}`);
    
    // Show current period games (matches what players see in the table)
    if (periodGames.length > 0) {
      const periodNote = usingPrevPeriod ? ` (מתקופה קודמת - ${periodLabel})` : '';
      // For single game, say "במשחק היחיד" not "ממוצע"
      const avgOrSingle = periodGames.length === 1 
        ? `במשחק היחיד: ${recentAvg >= 0 ? '+' : ''}${recentAvg}₪`
        : `${periodGames.length} משחקים, ממוצע: ${recentAvg >= 0 ? '+' : ''}${recentAvg}₪`;
      lines.push(`${periodLabel}: ${periodGames.map(g => `${g.profit >= 0 ? '+' : ''}${Math.round(g.profit)}`).join(', ')}₪ (${avgOrSingle})${periodNote}`);
    } else if (currentHalfGames.length === 0 && prevHalfGames.length === 0) {
      lines.push(`${currentPeriodLabel}: אין משחקים בתקופה הנוכחית או הקודמת`);
    }
    lines.push(`היסטוריה כוללת: ${p.gamesPlayed} משחקים, ממוצע ${allTimeAvg >= 0 ? '+' : ''}${allTimeAvg}₪`);
    
    if (trendText) lines.push(trendText);
    
    // Show ranking - use global rank if available, otherwise rank among tonight's players
    const rankContext = halfRank > 0 ? `${rankTotalPlayers} שחקנים פעילים` : `${players.length} שחקני הערב`;
    lines.push(`דירוג ${currentPeriodLabel}: #${rankTonight} מבין ${rankContext} (${yearProfit >= 0 ? '+' : ''}${Math.round(yearProfit)}₪)`);
    
    // Only show all-time rank if notable
    if (isActiveAllTime && (allTimeRank <= 3 || (gapToAboveAllTime && gapToAboveAllTime <= 100))) {
      let allTimeNote = `דירוג כללי: #${allTimeRank}/${allTimeTotalActive}`;
      if (gapToAboveAllTime && gapToAboveAllTime <= 100) {
        allTimeNote += ` (${gapToAboveAllTime}₪ ממקום ${allTimeRank - 1})`;
      }
      lines.push(allTimeNote);
    }
    
    lines.push(`צפי: ${suggestion >= 0 ? '+' : ''}${suggestion}₪`);
    
    return lines.join('\n');
  }).join('\n');
  
  // Calculate realistic profit ranges from player data
  const allProfits = players.flatMap(p => p.gameHistory.map(g => g.profit));
  const maxProfit = allProfits.length > 0 ? Math.max(...allProfits) : 300;
  const minProfit = allProfits.length > 0 ? Math.min(...allProfits) : -300;
  
  // Calculate actual statistics
  const absProfits = allProfits.map(p => Math.abs(p)).sort((a, b) => b - a);
  const medianAbsProfit = absProfits.length > 0 ? absProfits[Math.floor(absProfits.length / 2)] : 100;
  const avgAbsProfit = absProfits.length > 0 ? Math.round(absProfits.reduce((a, b) => a + b, 0) / absProfits.length) : 100;
  
  // Get recent game examples (last 5 unique games)
  const recentGames = new Map<string, { date: string; results: { name: string; profit: number }[] }>();
  players.forEach(p => {
    p.gameHistory.slice(0, 10).forEach(g => {
      if (!recentGames.has(g.gameId)) {
        recentGames.set(g.gameId, { date: g.date, results: [] });
      }
      recentGames.get(g.gameId)!.results.push({ name: p.name, profit: g.profit });
    });
  });
  
  const recentGameExamples = Array.from(recentGames.values())
    .slice(0, 3)
    .map(g => {
      const sorted = g.results.sort((a, b) => b.profit - a.profit);
      const winner = sorted[0];
      const loser = sorted[sorted.length - 1];
      return `${g.date}: Winner ${winner.name} +${winner.profit}₪, Loser ${loser.name} ${loser.profit}₪`;
    })
    .join('\n');
  
  // Add random seed to force different outputs each time
  const randomSeed = Math.random().toString(36).substring(2, 8);
  const randomOrder = [...players].sort(() => Math.random() - 0.5).map(p => p.name).join(', ');
  
  const prompt = `תחזית פוקר להערב. פלט JSON בעברית בלבד.
🎲 סידור אקראי להשראה: ${randomOrder} (seed: ${randomSeed})

📊 נתוני שחקנים:
${playerDataText}
${milestonesText ? `\n🎯 אבני דרך:\n${milestonesText}` : ''}
${surpriseText}

═══════════════════════════════════════════════════════════════════
📋 הוראות
═══════════════════════════════════════════════════════════════════

1️⃣ סכום כל ה-expectedProfit חייב להיות בדיוק 0
2️⃣ השתמש בצפי מהנתונים (גמישות ±30₪)
3️⃣ מור = לשון נקבה. שאר השחקנים = לשון זכר
4️⃣ 🚨 קריטי: כל משפט (sentence) חייב להתחיל במילה שונה! אסור ששני משפטים יתחילו אותו דבר!

🎯 התאמת טון:
• expectedProfit חיובי → משפט אופטימי
• expectedProfit שלילי → "מאתגר אך אפשרי" (לא מייאש!)
• isSurprise=true רק כש-expectedProfit חיובי (הפתעה = ניצחון לא צפוי)

📈 מגמות (עדיפות גבוהה! אם יש 📈 או 📉):
• 📈 שיפור: חובה להזכיר את שני המספרים! "ממוצע היסטורי X₪ אבל לאחרונה Y₪"
• 📉 ירידה: "ממוצע היסטורי X₪ אבל לאחרונה Y₪ - מחפש לחזור"
• תמיד הזכר את ההשוואה - המספר ההיסטורי מול האחרון!

✍️ פתיחות שונות לכל שחקן (חובה לגוון!):
שחקן 1: "אחרי +X₪ במשחק האחרון..." 
שחקן 2: "עם X ניצחונות רצופים..."
שחקן 3: "במקום X בטבלה..."
שחקן 4: "[שם] מגיע הערב עם..."
שחקן 5: "רק X₪ מהמקום הבא..."
שחקן 6: "למרות היסטוריה של X₪..."
שחקן 7: "הפורמה האחרונה מראה..."

עובדות לשלב: משחק אחרון, רצף, ממוצע, דירוג ב-${currentPeriodLabel}

⚠️ חשוב: 
• השתמש רק במספרים שמופיעים בנתונים - אל תחשב בעצמך!
• מספרים שלמים בלבד (ללא נקודה עשרונית)
• משחק יחיד = "במשחק היחיד" (לא "ממוצע")

🔙 שחקנים חוזרים (מסומנים 🔙) - חובה להזכיר את החזרה!

❌ לא לעשות:
• לכתוב את מספר ה-expectedProfit במשפט
• משפטים גנריים בלי מספרים
• להדגיש הפסדים גדולים בסכום

📝 פלט:
[{"name":"שם", "expectedProfit":מספר, "highlight":"5-10 מילים עם נתון", "sentence":"25-40 מילים עם עובדות", "isSurprise":boolean}]

סכום=0. JSON בלבד.`;

  console.log('🤖 AI Forecast Request for:', players.map(p => p.name).join(', '));
  
  // Try each model until one works
  for (const config of API_CONFIGS) {
    const modelPath = config.model.startsWith('models/') ? config.model : `models/${config.model}`;
    const url = `https://generativelanguage.googleapis.com/${config.version}/${modelPath}:generateContent?key=${apiKey}`;
    
    console.log(`   Trying: ${config.version}/${config.model}...`);
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: prompt }]
          }],
          generationConfig: {
            temperature: 0.95,  // High for maximum variety
            topK: 40,
            topP: 0.85,
            maxOutputTokens: 2048,
          }
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData?.error?.message || `Status ${response.status}`;
        console.log(`   ❌ ${config.model}: ${errorMsg}`);
        
        // If rate limited or not found, try next model
        if (response.status === 429 || response.status === 404) {
          continue; // Try next model
        }
        throw new Error(`API_ERROR: ${response.status} - ${errorMsg}`);
      }
      
      // Success! Save this working model
      console.log(`   ✅ ${config.model} responded!`);
      localStorage.setItem('gemini_working_config', JSON.stringify(config));

      const data = await response.json();
      
      // Extract the text from Gemini response
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      
      if (!text) {
        console.error('❌ Empty response from', config.model);
        if (data.candidates?.[0]?.finishReason === 'SAFETY') {
          continue; // Try next model
        }
        continue; // Try next model
      }

      console.log('📝 AI response received, parsing...');

      // Parse JSON from response (handle markdown code blocks)
      let jsonText = text;
      if (text.includes('```json')) {
        jsonText = text.split('```json')[1].split('```')[0];
      } else if (text.includes('```')) {
        jsonText = text.split('```')[1].split('```')[0];
      }

      let forecasts: ForecastResult[];
      try {
        forecasts = JSON.parse(jsonText.trim());
        console.log('✅ Parsed', forecasts.length, 'forecasts');
      } catch (parseError) {
        console.error('❌ JSON parse error, trying next model');
        continue; // Try next model
      }
      
      // ========== FACT-CHECK AND CORRECT AI OUTPUT ==========
      console.log('🔍 Fact-checking AI output...');
      
      forecasts = forecasts.map(forecast => {
        const player = players.find(p => p.name === forecast.name);
        if (!player) return forecast;
        
        // Get actual year data
        const thisYearGames = player.gameHistory.filter(g => parseGameDate(g.date).getFullYear() === currentYear);
        const yearGames = thisYearGames.length;
        const yearProfit = thisYearGames.reduce((sum, g) => sum + g.profit, 0);
        
        // Calculate actual rankings (tonight's table only!)
        const sortedTonight = [...players].sort((a, b) => b.totalProfit - a.totalProfit);
        const rankTonight = sortedTonight.findIndex(p => p.name === player.name) + 1;
        
        // USE THE ACTUAL CURRENT STREAK (spans across years!)
        const actualStreak = player.currentStreak;
        
        // Last game result
        const lastGame = player.gameHistory[0];
        const lastGameProfit = lastGame?.profit || 0;
        const wonLastGame = lastGameProfit > 0;
        const lostLastGame = lastGameProfit < 0;
        
        let correctedSentence = forecast.sentence;
        let correctedHighlight = forecast.highlight;
        let hadErrors = false;
        let errorDetails: string[] = [];
        
        // ========== 1. FIX STREAK ERRORS ==========
        const streakPatterns = [
          /רצף\s*(?:של\s*)?(\d+)\s*נצחונות/g,
          /(\d+)\s*נצחונות\s*רצופים/g,
          /(\d+)\s*consecutive\s*wins/gi,
          /רצף\s*(?:של\s*)?(\d+)\s*הפסדים/g,
          /(\d+)\s*הפסדים\s*רצופים/g,
          /(\d+)\s*wins?\s*in\s*a\s*row/gi,
          /(\d+)\s*losses?\s*in\s*a\s*row/gi,
        ];
        
        for (const pattern of streakPatterns) {
          const matches = [...correctedSentence.matchAll(pattern)];
          for (const match of matches) {
            const claimedStreak = parseInt(match[1]);
            const isWinPattern = match[0].includes('נצחונות') || match[0].toLowerCase().includes('wins');
            const expectedStreak = isWinPattern ? Math.max(0, actualStreak) : Math.abs(Math.min(0, actualStreak));
            
            if (claimedStreak !== expectedStreak) {
              errorDetails.push(`streak: claimed ${claimedStreak}, actual ${expectedStreak}`);
              hadErrors = true;
              
              if (expectedStreak === 0) {
                correctedSentence = correctedSentence.replace(match[0], '');
              } else {
                correctedSentence = correctedSentence.replace(match[0], match[0].replace(match[1], String(expectedStreak)));
              }
            }
          }
        }
        
        // ========== 2. FIX RANKING ERRORS ==========
        // Check if sentence claims #1 but player isn't #1 tonight
        if ((correctedSentence.includes('מוביל') || correctedSentence.includes('בראש') || correctedSentence.includes('מקום ראשון') || correctedSentence.includes('מקום 1') || correctedSentence.includes('#1')) && rankTonight !== 1) {
          errorDetails.push(`rank: claimed #1 but actually #${rankTonight}`);
          hadErrors = true;
          // Remove false #1 claims
          correctedSentence = correctedSentence
            .replace(/מוביל את הטבלה/g, `נמצא במקום ${rankTonight}`)
            .replace(/בראש הטבלה/g, `במקום ${rankTonight}`)
            .replace(/מקום ראשון/g, `מקום ${rankTonight}`)
            .replace(/מקום 1\b/g, `מקום ${rankTonight}`)
            .replace(/#1\b/g, `#${rankTonight}`);
        }
        
        // ========== 3. FIX LAST GAME ERRORS ==========
        // Check for contradictions about last game result
        if (wonLastGame && correctedSentence.includes('הפסד') && correctedSentence.includes('אחרון')) {
          errorDetails.push('last_game: claimed loss but actually won');
          hadErrors = true;
        }
        if (lostLastGame && correctedSentence.includes('נצחון') && correctedSentence.includes('אחרון')) {
          errorDetails.push('last_game: claimed win but actually lost');
          hadErrors = true;
        }
        
        // ========== 4. FIX GAME COUNT ERRORS ==========
        const gameCountPatterns = [
          /(\d+)\s*משחקים?\s*(?:ב)?(?:ינואר|פברואר|מרץ|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר)/g,
          /(\d+)\s*משחקים?\s*(?:ב)?-?(?:2026|2025|השנה)/g,
          /(\d+)\s*games?\s*(?:in\s*)?(?:January|February|this year|2026)/gi,
        ];
        
        for (const pattern of gameCountPatterns) {
          const matches = [...correctedSentence.matchAll(pattern)];
          for (const match of matches) {
            const claimedGames = parseInt(match[1]);
            const isYearMention = match[0].includes('2026') || match[0].includes('2025') || match[0].includes('השנה');
            
            let actualGames = yearGames;
            if (!isYearMention) {
              const thisMonthGames = player.gameHistory.filter(g => {
                const d = parseGameDate(g.date);
                return d.getFullYear() === currentYear && d.getMonth() === currentMonth;
              });
              actualGames = thisMonthGames.length;
            }
            
            if (claimedGames !== actualGames) {
              errorDetails.push(`games: claimed ${claimedGames}, actual ${actualGames}`);
              hadErrors = true;
              correctedSentence = correctedSentence.replace(match[0], match[0].replace(match[1], String(actualGames)));
            }
          }
        }
        
        // ========== 5. FIX PROFIT DIRECTION ERRORS ==========
        // If year profit is negative but sentence claims positive year
        if (yearProfit < 0 && yearGames > 0) {
          const positiveYearClaims = [
            /שנה\s*(?:מצוינת|טובה|חיובית)/g,
            /רווח\s*(?:השנה|ב-?2026)/g,
            /\+.*₪\s*(?:השנה|ב-?2026)/g,
          ];
          for (const pattern of positiveYearClaims) {
            if (pattern.test(correctedSentence)) {
              errorDetails.push(`profit_direction: claimed positive year but year profit is ${yearProfit}`);
              hadErrors = true;
            }
          }
        }
        
        // ========== 6. CLEAN UP BROKEN TEXT ==========
        correctedSentence = correctedSentence.replace(/\s+/g, ' ').trim();
        correctedSentence = correctedSentence.replace(/,\s*,/g, ',');
        correctedSentence = correctedSentence.replace(/\.\s*\./g, '.');
        correctedSentence = correctedSentence.replace(/\s+\./g, '.');
        
        // ========== 7. GENERATE FALLBACK IF NEEDED ==========
        if (correctedSentence.length < 20 || hadErrors) {
          console.log(`⚠️ ${player.name}: Errors detected - ${errorDetails.join(', ')}`);
          
          // Generate engaging, factual fallback based on actual data
          const fallbackSentences = [];
          
          // Build sentence based on what's actually true
          if (actualStreak >= 3) {
            fallbackSentences.push(`רצף חם של ${actualStreak} נצחונות רצופים! ${yearGames > 0 ? `${yearProfit >= 0 ? '+' : ''}${Math.round(yearProfit)}₪ ב-${currentYear}.` : ''}`);
          } else if (actualStreak <= -3) {
            fallbackSentences.push(`רצף קשה של ${Math.abs(actualStreak)} הפסדים. מחפש לשבור את הרצף הלילה.`);
          } else if (wonLastGame && lastGameProfit > 50) {
            fallbackSentences.push(`נצחון גדול של +${Math.round(lastGameProfit)}₪ במשחק האחרון. מקום ${rankTonight} מתוך ${players.length} הלילה.`);
          } else if (lostLastGame && lastGameProfit < -50) {
            fallbackSentences.push(`הפסד של ${Math.round(lastGameProfit)}₪ במשחק האחרון. מחפש לחזור לנצחונות הלילה.`);
          } else if (yearGames >= 3) {
            const yearAvg = Math.round(yearProfit / yearGames);
            fallbackSentences.push(`${yearGames} משחקים ב-${currentYear} עם ממוצע ${yearAvg >= 0 ? '+' : ''}${yearAvg}₪. מקום ${rankTonight}/${players.length} הלילה.`);
          } else if (player.gamesPlayed >= 10) {
            fallbackSentences.push(`${player.gamesPlayed} משחקים, ממוצע ${player.avgProfit >= 0 ? '+' : ''}${Math.round(player.avgProfit)}₪. מקום ${rankTonight}/${players.length} בטבלה הלילה.`);
          } else {
            fallbackSentences.push(`מקום ${rankTonight}/${players.length} בטבלה הלילה. ${yearGames > 0 ? `${yearProfit >= 0 ? '+' : ''}${Math.round(yearProfit)}₪ ב-${currentYear}.` : `ממוצע ${player.avgProfit >= 0 ? '+' : ''}${Math.round(player.avgProfit)}₪.`}`);
          }
          
          correctedSentence = fallbackSentences[0];
          console.log(`🔧 ${player.name}: Replaced with factual fallback`);
        }
        
        // ========== 8. FIX HIGHLIGHT ERRORS ==========
        for (const pattern of [...streakPatterns, ...gameCountPatterns]) {
          const matches = [...correctedHighlight.matchAll(pattern)];
          for (const match of matches) {
            const claimedNum = parseInt(match[1]);
            const isStreak = match[0].includes('נצחונות') || match[0].includes('הפסדים');
            const actualNum = isStreak ? Math.abs(actualStreak) : yearGames;
            
            if (claimedNum !== actualNum) {
              correctedHighlight = correctedHighlight.replace(match[0], match[0].replace(match[1], String(actualNum)));
            }
          }
        }
        
        return {
          ...forecast,
          sentence: correctedSentence,
          highlight: correctedHighlight
        };
      });
      
      console.log('✅ Fact-checking complete');
      // ========== END FACT-CHECKING ==========
      
      // Validate and ensure zero-sum
      let total = forecasts.reduce((sum, f) => sum + f.expectedProfit, 0);
      if (total !== 0 && forecasts.length > 0) {
        const adjustment = Math.round(total / forecasts.length);
        forecasts.forEach((f, i) => {
          if (i === 0) {
            f.expectedProfit -= (total - adjustment * (forecasts.length - 1));
          } else {
            f.expectedProfit -= adjustment;
          }
        });
      }

      return forecasts;
      
    } catch (fetchError) {
      console.log(`   ❌ ${config.model} fetch error:`, fetchError);
      continue; // Try next model
    }
  }
  
  // All models failed
  console.error('❌ All AI models failed');
  throw new Error('All AI models are rate limited or unavailable. Try again in a few minutes.');
};

// Store working config
let workingConfig: { version: string; model: string } | null = null;

/**
 * First, try to list available models to diagnose the issue
 */
const listAvailableModels = async (apiKey: string): Promise<string[]> => {
  const models: string[] = [];
  
  for (const version of ['v1beta', 'v1']) {
    try {
      const url = `https://generativelanguage.googleapis.com/${version}/models?key=${apiKey}`;
      console.log(`📋 Listing models with ${version}...`);
      
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        const foundModels = data.models?.map((m: {name: string}) => `${version}: ${m.name}`) || [];
        console.log(`Found ${foundModels.length} models with ${version}:`, foundModels);
        models.push(...foundModels);
      } else {
        const err = await response.json().catch(() => ({}));
        console.log(`${version} list failed:`, err?.error?.message || response.status);
      }
    } catch (e) {
      console.log(`${version} list error:`, e);
    }
  }
  
  return models;
};

/**
 * Test if the API key is valid - tries multiple configs
 */
export const testGeminiApiKey = async (apiKey: string): Promise<boolean> => {
  console.log('═══════════════════════════════════════');
  console.log('🔑 GEMINI API KEY TEST');
  console.log('═══════════════════════════════════════');
  console.log('Key length:', apiKey.length);
  console.log('Key prefix:', apiKey.substring(0, 10) + '...');
  console.log('Format check:', apiKey.startsWith('AIza') ? '✅ Correct (AIza...)' : '⚠️ Unusual format!');
  console.log('');
  
  // First, list available models
  console.log('📋 STEP 1: Listing available models...');
  const availableModels = await listAvailableModels(apiKey);
  
  if (availableModels.length > 0) {
    console.log(`✅ Found ${availableModels.length} models! Key is valid.`);
    console.log('');
  } else {
    console.log('');
    console.log('❌ CANNOT LIST MODELS - Key may be invalid or restricted');
    console.log('');
    console.log('🔧 POSSIBLE CAUSES:');
    console.log('   1. API key is invalid or expired');
    console.log('   2. Key was created in Google Cloud Console (need AI Studio key)');
    console.log('   3. Generative Language API not enabled');
    console.log('   4. API key has IP/referrer restrictions');
    console.log('');
    console.log('💡 SOLUTION: Create a NEW key at Google AI Studio:');
    console.log('   https://aistudio.google.com/app/apikey');
    console.log('   → Click "Create API key"');
    console.log('   → Select "Create API key in new project"');
    console.log('');
  }
  
  console.log('🧪 STEP 2: Testing generateContent with each model...');
  
  // Try all configs
  for (const config of API_CONFIGS) {
    const modelPath = config.model.startsWith('models/') ? config.model : `models/${config.model}`;
    const url = `https://generativelanguage.googleapis.com/${config.version}/${modelPath}:generateContent?key=${apiKey}`;
    
    console.log(`\n🧪 Trying ${config.version} / ${config.model}...`);
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Say: OK' }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 5 }
        })
      });

      if (response.ok) {
        workingConfig = config;
        console.log(`✅ SUCCESS! ${config.version}/${config.model} works!`);
        localStorage.setItem('gemini_working_config', JSON.stringify(config));
        return true;
      }
      
      const errorData = await response.json().catch(() => ({}));
      const errorMsg = errorData?.error?.message || `Status ${response.status}`;
      
      // 429 = rate limited but key is valid! Save config and return success
      if (response.status === 429) {
        workingConfig = config;
        console.log(`⚠️ ${config.version}/${config.model}: Rate limited but KEY IS VALID!`);
        console.log('   Wait a minute and try the forecast again.');
        localStorage.setItem('gemini_working_config', JSON.stringify(config));
        return true; // Key works, just rate limited
      }
      
      console.log(`❌ ${config.version}/${config.model}: ${errorMsg}`);
      
    } catch (error) {
      console.log(`❌ ${config.version}/${config.model} error:`, error);
    }
  }
  
  console.error('\n❌ All configurations failed.');
  console.log('\n💡 TROUBLESHOOTING:');
  console.log('1. Go to: https://aistudio.google.com/app/apikey');
  console.log('2. Delete existing API key');
  console.log('3. Click "Create API key" → "Create API key in new project"');
  console.log('4. Copy the new key and try again');
  
  return false;
};

/**
 * Get the working config
 */
const getWorkingConfig = (): { version: string; model: string } => {
  if (workingConfig) return workingConfig;
  
  const saved = localStorage.getItem('gemini_working_config');
  if (saved) {
    try {
      workingConfig = JSON.parse(saved);
      return workingConfig!;
    } catch {}
  }
  
  return API_CONFIGS[0]; // Default to first
};

/**
 * Generate a short comment comparing forecast to actual results
 */
export const generateForecastComparison = async (
  forecasts: { playerName: string; expectedProfit: number }[],
  actualResults: { playerName: string; profit: number }[]
): Promise<string> => {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error('NO_API_KEY');

  // Build comparison data with gap-based accuracy
  const comparisons = forecasts.map(f => {
    const actual = actualResults.find(a => a.playerName === f.playerName);
    const actualProfit = actual?.profit || 0;
    const gap = Math.abs(actualProfit - f.expectedProfit);
    
    // Accuracy based on gap: ≤30 = accurate, 31-60 = close, >60 = missed
    let accuracyLevel: 'accurate' | 'close' | 'missed';
    if (gap <= 30) accuracyLevel = 'accurate';
    else if (gap <= 60) accuracyLevel = 'close';
    else accuracyLevel = 'missed';
    
    return {
      name: f.playerName,
      forecast: f.expectedProfit,
      actual: actualProfit,
      gap,
      accuracyLevel
    };
  });

  // Count accuracy levels
  const accurate = comparisons.filter(c => c.accuracyLevel === 'accurate').length;
  const close = comparisons.filter(c => c.accuracyLevel === 'close').length;
  const missed = comparisons.filter(c => c.accuracyLevel === 'missed').length;
  const total = comparisons.length;
  
  // Calculate overall score (accurate=2pts, close=1pt, missed=0pts)
  const score = (accurate * 2 + close * 1);
  const maxScore = total * 2;
  const scorePercent = Math.round((score / maxScore) * 100);
  
  // Determine rating
  let rating: string;
  if (scorePercent >= 80) rating = 'מעולה';
  else if (scorePercent >= 60) rating = 'טוב';
  else if (scorePercent >= 40) rating = 'סביר';
  else rating = 'חלש';
  
  // Find best and worst predictions
  const sortedByGap = [...comparisons].sort((a, b) => a.gap - b.gap);
  const bestPrediction = sortedByGap[0];
  const worstPrediction = sortedByGap[sortedByGap.length - 1];

  const prompt = `אתה מסכם תחזית פוקר בעברית. כתוב משפט סיכום קצר ורלוונטי (עד 25 מילים) על הצלחת התחזית.

נתונים:
- ציון כולל: ${score}/${maxScore} (${scorePercent}%) - ${rating}
- מדויק (פער ≤30): ${accurate}/${total}
- קרוב (פער 31-60): ${close}/${total}  
- החטאה (פער >60): ${missed}/${total}
- תחזית מדויקת ביותר: ${bestPrediction.name} (פער ${bestPrediction.gap})
- תחזית רחוקה ביותר: ${worstPrediction.name} (פער ${worstPrediction.gap})

כתוב משפט סיכום שכולל את הדירוג הכולל ("${rating}") ותובנה על התחזית. לא להיות מצחיק. כתוב רק את המשפט.`;

  const config = getWorkingConfig();
  
  const response = await fetch(
    `https://generativelanguage.googleapis.com/${config.version}/models/${config.model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 100,
        }
      })
    }
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.error?.message || `API error: ${response.status}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  
  return text.trim() || `${accurate} מדויקים, ${close} קרובים, ${missed} החטאות מתוך ${total} תחזיות`;
};