/**
 * Google Gemini AI Integration for Poker Forecasts
 * Free tier: gemini-2.5-pro (100 RPD), gemini-2.5-flash (250 RPD)
 * Get your API key at: https://aistudio.google.com/app/apikey
 */

// Models ordered by quality - Pro for best text quality, Flash as reliable fallback
const API_CONFIGS = [
  { version: 'v1beta', model: 'gemini-2.5-pro' },
  { version: 'v1beta', model: 'gemini-2.5-flash' },
  { version: 'v1beta', model: 'gemini-2.0-flash' },
  { version: 'v1beta', model: 'gemini-2.5-flash-lite' },
  { version: 'v1beta', model: 'gemini-2.0-flash-lite' },
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
  groupIntro?: string;
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
  
  const allTimeRecordsText = allTimeRecords.length > 0 ? allTimeRecords.join('\n') : '';

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
  
  // ===== 1. עקיפה בטבלה הכללית =====
  for (let i = 1; i < sortedByTotalProfit.length; i++) {
    const chaser = sortedByTotalProfit[i];
    const leader = sortedByTotalProfit[i - 1];
    const gap = leader.totalProfit - chaser.totalProfit;
    if (gap > 0 && gap <= 250) {
      milestones.push(`📈 טבלה כללית: ${chaser.name} (מקום ${i + 1}, ${chaser.totalProfit >= 0 ? '+' : ''}${chaser.totalProfit}₪) יכול לעקוף את ${leader.name} (מקום ${i}, ${leader.totalProfit >= 0 ? '+' : ''}${leader.totalProfit}₪) עם נצחון של +${gap}₪ הלילה!`);
    }
  }
  
  // ===== 2. טבלת השנה =====
  const sortedByYearProfit = [...playerPeriodStats].sort((a, b) => b.yearProfit - a.yearProfit);
  for (let i = 1; i < sortedByYearProfit.length && i <= 3; i++) {
    const chaser = sortedByYearProfit[i];
    const leader = sortedByYearProfit[i - 1];
    const gap = leader.yearProfit - chaser.yearProfit;
    if (gap > 0 && gap <= 200 && chaser.yearGames >= 2) {
      milestones.push(`📅 טבלת ${currentYear}: ${chaser.name} במקום ${i + 1} עם ${chaser.yearProfit >= 0 ? '+' : ''}${chaser.yearProfit}₪. נצחון של +${gap}₪ = עקיפת ${leader.name} למקום ${i}!`);
    }
  }
  
  // ===== 3. טבלת חצי שנה =====
  const halfName = currentHalf === 1 ? 'H1' : 'H2';
  const sortedByHalfProfit = [...playerPeriodStats].sort((a, b) => b.halfProfit - a.halfProfit);
  for (let i = 1; i < sortedByHalfProfit.length && i <= 3; i++) {
    const chaser = sortedByHalfProfit[i];
    const leader = sortedByHalfProfit[i - 1];
    const gap = leader.halfProfit - chaser.halfProfit;
    if (gap > 0 && gap <= 150 && chaser.halfGames >= 2) {
      milestones.push(`📊 טבלת ${halfName} ${currentYear}: ${chaser.name} על ${chaser.halfProfit >= 0 ? '+' : ''}${chaser.halfProfit}₪. עוד +${gap}₪ = עקיפת ${leader.name} למקום ${i}!`);
    }
  }
  
  // ===== 4. חודש נוכחי =====
  const sortedByMonthProfit = [...playerPeriodStats].sort((a, b) => b.monthProfit - a.monthProfit);
  if (sortedByMonthProfit[0]?.monthGames >= 1) {
    const monthLeader = sortedByMonthProfit[0];
    for (let i = 1; i < sortedByMonthProfit.length && i <= 2; i++) {
      const chaser = sortedByMonthProfit[i];
      const gap = monthLeader.monthProfit - chaser.monthProfit;
      if (gap > 0 && gap <= 150 && chaser.monthGames >= 1) {
        milestones.push(`🗓️ ${monthNames[currentMonth]}: ${chaser.name} רק ${gap}₪ מאחורי ${monthLeader.name} על התואר! נצחון גדול הלילה = שחקן החודש.`);
      }
    }
  }
  
  // ===== 5. אבני דרך כלליות =====
  const roundNumbers = [500, 1000, 1500, 2000, 2500, 3000];
  players.forEach(p => {
    for (const milestone of roundNumbers) {
      const distance = milestone - p.totalProfit;
      if (distance > 0 && distance <= 200) {
        milestones.push(`🎯 אבן דרך: ${p.name} על ${p.totalProfit >= 0 ? '+' : ''}${p.totalProfit}₪ כולל. עוד ${distance}₪ = חציית רף +${milestone}₪!`);
        break;
      }
      const negDistance = p.totalProfit - (-milestone);
      if (p.totalProfit < 0 && negDistance > 0 && negDistance <= 200) {
        milestones.push(`⚠️ אזור סכנה: ${p.name} על ${p.totalProfit}₪ כולל. הפסד של ${negDistance}₪ = ירידה ל-${milestone}₪!`);
        break;
      }
    }
  });
  
  // ===== 6. אבני דרך שנתיות =====
  playerPeriodStats.forEach(p => {
    if (p.yearGames >= 3) {
      for (const milestone of [500, 1000]) {
        const distance = milestone - p.yearProfit;
        if (distance > 0 && distance <= 150) {
          milestones.push(`📅 יעד ${currentYear}: ${p.name} על ${p.yearProfit >= 0 ? '+' : ''}${p.yearProfit}₪ השנה. עוד ${distance}₪ = +${milestone}₪ שנתי!`);
          break;
        }
      }
    }
  });
  
  // ===== 7. שיאי רצף =====
  const groupWinStreakRecord = Math.max(...players.map(p => p.currentStreak), 0);
  const groupLoseStreakRecord = Math.min(...players.map(p => p.currentStreak), 0);
  
  players.forEach(p => {
    if (p.currentStreak >= 3 && p.currentStreak >= groupWinStreakRecord) {
      milestones.push(`🔥 שיא רצף: ${p.name} עם ${p.currentStreak} נצחונות ברצף (שיא קבוצתי!). נצחון הלילה = שיא חדש של ${p.currentStreak + 1}!`);
    }
    if (p.currentStreak <= -3 && p.currentStreak <= groupLoseStreakRecord) {
      milestones.push(`❄️ רצף שלילי: ${p.name} עם ${Math.abs(p.currentStreak)} הפסדים ברצף (הגרוע בקבוצה!). עוד הפסד = שיא שלילי של ${Math.abs(p.currentStreak) + 1}!`);
    }
  });
  
  // ===== 8. שיא נצחון בערב =====
  const biggestWinRecord = Math.max(...players.map(p => p.bestWin));
  const recordHolder = players.find(p => p.bestWin === biggestWinRecord);
  players.forEach(p => {
    if (p.currentStreak >= 2 && p.bestWin < biggestWinRecord && biggestWinRecord - p.bestWin <= 150) {
      milestones.push(`💰 שיא רווח: שיא הקבוצה +${biggestWinRecord}₪ של ${recordHolder?.name}. השיא של ${p.name}: +${p.bestWin}₪. ערב של +${biggestWinRecord + 1}₪ = שיא חדש!`);
    }
  });
  
  // ===== 9. קאמבק =====
  players.forEach(p => {
    if (p.currentStreak <= -2 && p.totalProfit > 0) {
      milestones.push(`💪 קאמבק: ${p.name} עם ${Math.abs(p.currentStreak)} הפסדים ברצף, אבל עדיין +${p.totalProfit}₪ כולל. זמן נקמה!`);
    }
  });
  
  // ===== 10. השוואת פורמה =====
  playerPeriodStats.forEach(p => {
    if (p.yearGames >= 5 && p.gamesPlayed >= 10) {
      const yearAvg = p.yearProfit / p.yearGames;
      const allTimeAvg = p.avgProfit;
      if (yearAvg > allTimeAvg + 30) {
        milestones.push(`📈 שנה חמה: ממוצע ${p.name} ב-${currentYear}: +${Math.round(yearAvg)}₪ למשחק לעומת +${Math.round(allTimeAvg)}₪ היסטורי. השנה הכי טובה?`);
      } else if (yearAvg < allTimeAvg - 30) {
        milestones.push(`📉 שנה קשה: ממוצע ${p.name} ב-${currentYear}: ${Math.round(yearAvg)}₪ למשחק לעומת +${Math.round(allTimeAvg)}₪ היסטורי. מהפך הלילה?`);
      }
    }
  });
  
  // ===== 11. אבן דרך משחקים =====
  const gamesMilestones = [10, 25, 50, 75, 100, 150, 200];
  players.forEach(p => {
    for (const gm of gamesMilestones) {
      if (p.gamesPlayed === gm - 1) {
        milestones.push(`🎮 אבן דרך: הלילה המשחק ה-${gm} של ${p.name} בקבוצה!`);
        break;
      }
    }
  });
  
  // ===== 12. השתתפות שנתית =====
  const yearGamesMilestones = [10, 20, 30, 40, 50];
  playerPeriodStats.forEach(p => {
    for (const gm of yearGamesMilestones) {
      if (p.yearGames === gm - 1) {
        milestones.push(`📅 השתתפות: הלילה המשחק ה-${gm} של ${p.name} ב-${currentYear}!`);
        break;
      }
    }
  });
  
  // ===== 13. אחוז נצחונות =====
  const winRateMilestones = [50, 60, 70];
  players.filter(p => p.gamesPlayed >= 10).forEach(p => {
    const currentWinRate = p.winPercentage;
    for (const targetRate of winRateMilestones) {
      const winsNeeded = Math.ceil((targetRate / 100) * (p.gamesPlayed + 1));
      if (p.winCount === winsNeeded - 1 && currentWinRate < targetRate) {
        milestones.push(`🎯 אחוז נצחונות: ${p.name} על ${Math.round(currentWinRate)}%. נצחון הלילה = חציית ${targetRate}%!`);
        break;
      }
    }
  });
  
  // ===== 14. קרבות צמודים =====
  for (let i = 0; i < sortedByTotalProfit.length; i++) {
    for (let j = i + 1; j < sortedByTotalProfit.length; j++) {
      const higher = sortedByTotalProfit[i];
      const lower = sortedByTotalProfit[j];
      const gap = Math.abs(higher.totalProfit - lower.totalProfit);
      if (gap <= 30 && gap > 0) {
        milestones.push(`⚔️ קרב צמוד: ${higher.name} (${higher.totalProfit >= 0 ? '+' : ''}${higher.totalProfit}₪) ו${lower.name} (${lower.totalProfit >= 0 ? '+' : ''}${lower.totalProfit}₪) רק ${gap}₪ הפרש! הלילה יכריע.`);
      }
    }
  }
  
  // ===== 15. קפיצה בטבלה =====
  sortedByTotalProfit.forEach((p, idx) => {
    for (let ahead = 2; ahead <= 3; ahead++) {
      if (idx >= ahead) {
        const target = sortedByTotalProfit[idx - ahead];
        const gap = target.totalProfit - p.totalProfit;
        if (gap > 0 && gap <= 180) {
          milestones.push(`🚀 קפיצה: ${p.name} (מקום ${idx + 1}) יכול לקפוץ ${ahead} מקומות ולעקוף את ${target.name} (מקום ${idx + 1 - ahead}) עם +${gap}₪!`);
          break;
        }
      }
    }
  });
  
  // ===== 16. חזרה לפלוס =====
  playerPeriodStats.forEach(p => {
    if (p.yearProfit < 0 && p.yearProfit > -150 && p.yearGames >= 3) {
      milestones.push(`🔄 חזרה לפלוס: ${p.name} על ${p.yearProfit}₪ ב-${currentYear}. נצחון של +${Math.abs(p.yearProfit)}₪ = חזרה לפלוס שנתי!`);
    }
    if (p.halfProfit < 0 && p.halfProfit > -120 && p.halfGames >= 2) {
      milestones.push(`🔄 חצי שנה: ${p.name} על ${p.halfProfit}₪ ב-${halfName}. נצחון של +${Math.abs(p.halfProfit)}₪ = חצי שנה חיובי!`);
    }
  });
  
  // ===== 17. שיא חודשי =====
  playerPeriodStats.forEach(p => {
    if (p.monthGames >= 2) {
      const monthlyProfits: { [key: string]: number } = {};
      p.gameHistory.forEach(g => {
        const d = parseGameDate(g.date);
        const key = `${d.getFullYear()}-${d.getMonth()}`;
        monthlyProfits[key] = (monthlyProfits[key] || 0) + g.profit;
      });
      const bestMonth = Math.max(...Object.values(monthlyProfits), 0);
      if (bestMonth > 0 && p.monthProfit > bestMonth - 150 && p.monthProfit < bestMonth) {
        const needed = bestMonth - p.monthProfit + 1;
        milestones.push(`🏆 שיא חודשי: ${p.name} על ${p.monthProfit >= 0 ? '+' : ''}${p.monthProfit}₪ ב${monthNames[currentMonth]}. עוד +${needed}₪ = החודש הכי טוב אי פעם!`);
      }
    }
  });
  
  // ===== 18. תיקו מדויק =====
  for (let i = 0; i < sortedByTotalProfit.length; i++) {
    for (let j = i + 1; j < sortedByTotalProfit.length; j++) {
      if (sortedByTotalProfit[i].totalProfit === sortedByTotalProfit[j].totalProfit && sortedByTotalProfit[i].totalProfit !== 0) {
        milestones.push(`🤝 תיקו: ${sortedByTotalProfit[i].name} ו${sortedByTotalProfit[j].name} בדיוק שווים על ${sortedByTotalProfit[i].totalProfit >= 0 ? '+' : ''}${sortedByTotalProfit[i].totalProfit}₪! הלילה שובר את השוויון.`);
      }
    }
  }
  
  // ===== 19. נוכחות רציפה =====
  players.forEach(p => {
    if (p.daysSinceLastGame <= 14 && p.gameHistory.length >= 5) {
      const recentGames = p.gameHistory.slice(0, 5);
      const gamesInLast2Months = recentGames.filter(g => {
        const d = parseGameDate(g.date);
        const daysDiff = (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
        return daysDiff <= 60;
      }).length;
      if (gamesInLast2Months >= 5) {
        milestones.push(`🎯 נוכחות: ${p.name} שיחק ${gamesInLast2Months} מתוך 5 משחקים אחרונים - השחקן הכי עקבי!`);
      }
    }
  });
  
  // ===== 20. משחקים החודש =====
  playerPeriodStats.forEach(p => {
    if (p.monthGames === 2) {
      milestones.push(`📅 ${monthNames[currentMonth]}: הלילה המשחק ה-3 של ${p.name} החודש!`);
    } else if (p.monthGames === 4) {
      milestones.push(`📅 ${monthNames[currentMonth]}: הלילה המשחק ה-5 של ${p.name} החודש - החודש הכי עמוס!`);
    }
  });
  
  const milestonesText = milestones.length > 0 ? milestones.join('\n') : '';

  // ========== TONIGHT'S STORYLINES - Deep pool of head-to-head matchups & narratives ==========
  const storylines: string[] = [];

  // Build a map: gameId → list of { name, profit } for tonight's players
  const gameParticipation: Record<string, { name: string; profit: number }[]> = {};
  for (const p of players) {
    for (const g of p.gameHistory) {
      if (!gameParticipation[g.gameId]) gameParticipation[g.gameId] = [];
      gameParticipation[g.gameId].push({ name: p.name, profit: g.profit });
    }
  }

  // Head-to-head: for each pair, compute shared game records + money flow + consecutive wins
  const h2hResults: {
    a: string; b: string; aWins: number; bWins: number; sharedGames: number;
    aTotalProfit: number; bTotalProfit: number;
    aAvgWhenTogether: number; bAvgWhenTogether: number;
    aConsecutiveWins: number; bConsecutiveWins: number;
    lastGameAProfit: number; lastGameBProfit: number;
  }[] = [];

  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const pA = players[i], pB = players[j];
      const aGameIds = new Set(pA.gameHistory.map(g => g.gameId));
      const sharedGameIds = pB.gameHistory.filter(g => aGameIds.has(g.gameId)).map(g => g.gameId);
      if (sharedGameIds.length < 2) continue;

      let aWins = 0, bWins = 0, aTotalProfit = 0, bTotalProfit = 0;
      const results: { aWon: boolean; bWon: boolean; aProfit: number; bProfit: number; date: string }[] = [];

      for (const gid of sharedGameIds) {
        const aGame = pA.gameHistory.find(g => g.gameId === gid);
        const bGame = pB.gameHistory.find(g => g.gameId === gid);
        if (!aGame || !bGame) continue;
        const aWon = aGame.profit > bGame.profit;
        const bWon = bGame.profit > aGame.profit;
        if (aWon) aWins++;
        if (bWon) bWins++;
        aTotalProfit += aGame.profit;
        bTotalProfit += bGame.profit;
        results.push({ aWon, bWon, aProfit: aGame.profit, bProfit: bGame.profit, date: aGame.date });
      }

      // Sort by date (most recent first) and compute consecutive wins
      results.sort((a, b) => parseGameDate(b.date).getTime() - parseGameDate(a.date).getTime());
      let aConsec = 0, bConsec = 0;
      for (const r of results) {
        if (r.aWon) { aConsec++; } else break;
      }
      if (aConsec === 0) {
        for (const r of results) {
          if (r.bWon) { bConsec++; } else break;
        }
      }

      h2hResults.push({
        a: pA.name, b: pB.name, aWins, bWins,
        sharedGames: sharedGameIds.length,
        aTotalProfit, bTotalProfit,
        aAvgWhenTogether: Math.round(aTotalProfit / sharedGameIds.length),
        bAvgWhenTogether: Math.round(bTotalProfit / sharedGameIds.length),
        aConsecutiveWins: aConsec, bConsecutiveWins: bConsec,
        lastGameAProfit: results[0]?.aProfit || 0,
        lastGameBProfit: results[0]?.bProfit || 0,
      });
    }
  }

  // === STORYLINE TYPE 1: Dominance ===
  const dominance = h2hResults
    .filter(h => h.sharedGames >= 4 && (h.aWins >= h.sharedGames * 0.7 || h.bWins >= h.sharedGames * 0.7))
    .sort((a, b) => Math.max(b.aWins, b.bWins) / b.sharedGames - Math.max(a.aWins, a.bWins) / a.sharedGames);
  for (const d of dominance.slice(0, 2)) {
    const winner = d.aWins > d.bWins ? d.a : d.b;
    const loser = d.aWins > d.bWins ? d.b : d.a;
    const wins = Math.max(d.aWins, d.bWins);
    storylines.push(`🥊 שליטה: ${winner} ניצח את ${loser} ב-${wins} מתוך ${d.sharedGames} משחקים משותפים`);
  }

  // === STORYLINE TYPE 2: Close rivalry ===
  const rivalries = h2hResults
    .filter(h => h.sharedGames >= 5 && Math.abs(h.aWins - h.bWins) <= 1)
    .sort((a, b) => b.sharedGames - a.sharedGames);
  for (const r of rivalries.slice(0, 2)) {
    storylines.push(`⚔️ יריבות: ${r.a} ו${r.b} כמעט שווים - ${r.aWins}:${r.bWins} ב-${r.sharedGames} משחקים משותפים. הלילה שובר שוויון!`);
  }

  // === STORYLINE TYPE 3: Revenge game ===
  for (const h of h2hResults) {
    if (h.sharedGames < 3) continue;
    const profitDiff = Math.abs(h.lastGameAProfit - h.lastGameBProfit);
    if (profitDiff >= 80) {
      const loser = h.lastGameAProfit < h.lastGameBProfit ? h.a : h.b;
      const winner = h.lastGameAProfit < h.lastGameBProfit ? h.b : h.a;
      const loss = Math.round(Math.min(h.lastGameAProfit, h.lastGameBProfit));
      storylines.push(`🔥 נקמה: ${loser} הפסיד ${loss}₪ במשחק האחרון מול ${winner} - הלילה משחק הנקמה?`);
    }
  }

  // === STORYLINE TYPE 4: Lucky charm / bad luck ===
  for (const p of players) {
    if (p.gamesPlayed < 5) continue;
    for (const other of players) {
      if (other.name === p.name) continue;
      const h = h2hResults.find(r =>
        (r.a === p.name && r.b === other.name) || (r.b === p.name && r.a === other.name)
      );
      if (!h || h.sharedGames < 4) continue;
      const avgTogether = h.a === p.name ? h.aAvgWhenTogether : h.bAvgWhenTogether;
      const diff = avgTogether - p.avgProfit;
      if (diff >= 25) {
        storylines.push(`🍀 קמע: ${p.name} מרוויח בממוצע ${avgTogether >= 0 ? '+' : ''}${avgTogether}₪ כש${other.name} משחק (לעומת ${Math.round(p.avgProfit) >= 0 ? '+' : ''}${Math.round(p.avgProfit)}₪ בד"כ)`);
      } else if (diff <= -25) {
        storylines.push(`😈 עין הרע: ${p.name} בממוצע ${avgTogether}₪ כש${other.name} בשולחן (לעומת ${Math.round(p.avgProfit) >= 0 ? '+' : ''}${Math.round(p.avgProfit)}₪ בד"כ)`);
      }
    }
  }

  // === STORYLINE TYPE 5: Group dynamics ===
  for (const p of players) {
    if (p.gamesPlayed < 8) continue;
    const fewOverlap: number[] = [], manyOverlap: number[] = [];
    for (const g of p.gameHistory) {
      const count = gameParticipation[g.gameId]?.length || 1;
      if (count <= 3) fewOverlap.push(g.profit);
      else if (count >= 5) manyOverlap.push(g.profit);
    }
    if (fewOverlap.length >= 3 && manyOverlap.length >= 3) {
      const fewAvg = Math.round(fewOverlap.reduce((a, b) => a + b, 0) / fewOverlap.length);
      const manyAvg = Math.round(manyOverlap.reduce((a, b) => a + b, 0) / manyOverlap.length);
      if (Math.abs(fewAvg - manyAvg) >= 30) {
        const better = manyAvg > fewAvg;
        storylines.push(`📊 ${better ? 'חברה טובה' : 'צר בשולחן'}: ${p.name} בממוצע ${better ? (manyAvg >= 0 ? '+' : '') + manyAvg : (fewAvg >= 0 ? '+' : '') + fewAvg}₪ ${better ? 'כשרוב החבר\'ה ביחד' : 'עם פחות שחקנים'} לעומת ${better ? (fewAvg >= 0 ? '+' : '') + fewAvg : (manyAvg >= 0 ? '+' : '') + manyAvg}₪`);
      }
    }
  }

  // === STORYLINE TYPE 6: Nemesis (total money flow between two players) ===
  for (const h of h2hResults) {
    if (h.sharedGames < 4) continue;
    const moneyFlow = h.aTotalProfit - h.bTotalProfit;
    if (Math.abs(moneyFlow) >= 200) {
      const winner = moneyFlow > 0 ? h.a : h.b;
      const loser = moneyFlow > 0 ? h.b : h.a;
      storylines.push(`💸 נמסיס: ${loser} הפסיד סה"כ ${Math.abs(Math.round(moneyFlow))}₪ ל${winner} לאורך ${h.sharedGames} משחקים משותפים`);
    }
  }

  // === STORYLINE TYPE 7: H2H win streak ===
  for (const h of h2hResults) {
    const consec = Math.max(h.aConsecutiveWins, h.bConsecutiveWins);
    if (consec >= 3) {
      const streaker = h.aConsecutiveWins > h.bConsecutiveWins ? h.a : h.b;
      const victim = h.aConsecutiveWins > h.bConsecutiveWins ? h.b : h.a;
      storylines.push(`🔥 רצף מול: ${streaker} ניצח את ${victim} ${consec} פעמים ברצף! ישבור את הרצף הלילה?`);
    }
  }

  // === STORYLINE TYPE 8: First encounter ===
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      if (players[i].gamesPlayed === 0 || players[j].gamesPlayed === 0) continue;
      const hasH2H = h2hResults.some(h =>
        (h.a === players[i].name && h.b === players[j].name) ||
        (h.b === players[i].name && h.a === players[j].name)
      );
      if (!hasH2H) {
        const aIds = new Set(players[i].gameHistory.map(g => g.gameId));
        const shared = players[j].gameHistory.filter(g => aIds.has(g.gameId));
        if (shared.length === 0) {
          storylines.push(`🤝 פגישה ראשונה: ${players[i].name} ו${players[j].name} מעולם לא שיחקו ביחד! ערב היסטורי`);
        }
      }
    }
  }

  // === STORYLINE TYPE 9: Ranking duel ===
  const sortedByYearProfitStory = [...playerPeriodStats].sort((a, b) => b.yearProfit - a.yearProfit);
  for (let i = 0; i < sortedByYearProfitStory.length - 1; i++) {
    const gap = sortedByYearProfitStory[i].yearProfit - sortedByYearProfitStory[i + 1].yearProfit;
    if (gap >= 0 && gap <= 50 && sortedByYearProfitStory[i].yearGames >= 2) {
      storylines.push(`🏆 קרב דירוג: ${sortedByYearProfitStory[i].name} ו${sortedByYearProfitStory[i + 1].name} רק ${gap}₪ הפרש בטבלת ${currentYear}! הלילה מכריע מי מקום ${i + 1}`);
    }
  }

  // === STORYLINE TYPE 10: Comeback trail ===
  for (const p of players) {
    if (p.gamesPlayed < 8 || p.totalProfit >= 0) continue;
    const last5 = p.gameHistory.slice(0, 5);
    const last5Profit = last5.reduce((s, g) => s + g.profit, 0);
    if (last5Profit > 50 && p.totalProfit < -100) {
      storylines.push(`💪 קאמבק: ${p.name} על ${Math.round(p.totalProfit)}₪ כולל, אבל ב-5 משחקים אחרונים +${Math.round(last5Profit)}₪. המגמה מתהפכת!`);
    }
  }

  // === STORYLINE TYPE 11: Host effect ===
  // Requires location data on games (not available in gameHistory); skipped for now

  // === STORYLINE TYPE 12: Milestone chase ===
  for (const p of players) {
    if (p.gamesPlayed < 5) continue;
    const currentWinRate = p.winPercentage;
    if (currentWinRate >= 45 && currentWinRate < 50) {
      const winsNeeded = Math.ceil(0.50 * (p.gamesPlayed + 1)) - p.winCount;
      if (winsNeeded === 1) {
        storylines.push(`🎯 אבן דרך: ${p.name} על ${Math.round(currentWinRate)}% נצחונות - עוד נצחון אחד = חציית 50%!`);
      }
    }
    if (p.currentStreak >= 3) {
      storylines.push(`📈 שיא אישי: ${p.name} ברצף של ${p.currentStreak} נצחונות. עוד נצחון = ${p.currentStreak + 1} ברצף!`);
    }
  }

  // === STORYLINE TYPE 13: Polar opposites ===
  const playersWithVolatility = players.filter(p => p.gamesPlayed >= 5).map(p => {
    const recent = p.gameHistory.slice(0, 10).map(g => g.profit);
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const variance = recent.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / recent.length;
    return { name: p.name, stdDev: Math.sqrt(variance), avgProfit: p.avgProfit };
  }).sort((a, b) => b.stdDev - a.stdDev);
  if (playersWithVolatility.length >= 2) {
    const wildest = playersWithVolatility[0];
    const calmest = playersWithVolatility[playersWithVolatility.length - 1];
    if (wildest.stdDev > calmest.stdDev * 2) {
      storylines.push(`🎭 ניגודים: ${wildest.name} תנודתי (סטייה ${Math.round(wildest.stdDev)}₪) מול ${calmest.name} יציב (סטייה ${Math.round(calmest.stdDev)}₪) - שני סגנונות שונים לגמרי`);
    }
  }

  // === STORYLINE TYPE 14: Money magnet (biggest contributor to tonight's group) ===
  const totalContributions = players.filter(p => p.gamesPlayed >= 3).map(p => {
    let contributed = 0;
    for (const h of h2hResults) {
      if (h.a === p.name) contributed += h.aTotalProfit;
      else if (h.b === p.name) contributed += h.bTotalProfit;
    }
    return { name: p.name, contributed: Math.round(contributed) };
  }).sort((a, b) => a.contributed - b.contributed);
  if (totalContributions.length >= 2 && totalContributions[0].contributed < -150) {
    storylines.push(`🧲 ספונסר: ${totalContributions[0].name} הפסיד ${Math.abs(totalContributions[0].contributed)}₪ סך הכל לשחקני הלילה. הכסף הולך בעיקר אל ${totalContributions[totalContributions.length - 1].name} (+${totalContributions[totalContributions.length - 1].contributed}₪)`);
  }

  // === STORYLINE TYPE 15: Hot/cold group trend ===
  const groupLast3 = players.filter(p => p.gameHistory.length >= 3);
  if (groupLast3.length >= 4) {
    const onHotStreak = groupLast3.filter(p => p.currentStreak >= 2).length;
    const onColdStreak = groupLast3.filter(p => p.currentStreak <= -2).length;
    if (onHotStreak >= 3) {
      const names = groupLast3.filter(p => p.currentStreak >= 2).map(p => p.name).join(', ');
      storylines.push(`🌡️ גל חום: ${onHotStreak} שחקנים ברצף נצחונות (${names}) - ערב של מנצחים!`);
    } else if (onColdStreak >= 3) {
      const names = groupLast3.filter(p => p.currentStreak <= -2).map(p => p.name).join(', ');
      storylines.push(`❄️ גל קור: ${onColdStreak} שחקנים ברצף הפסדים (${names}) - מי ישבור את הסדרה?`);
    }
  }

  // Shuffle and pick up to 8 storylines, trying to cover as many players as possible
  const allStorylines = [...storylines];
  const pickedStorylines: string[] = [];
  const coveredPlayers = new Set<string>();
  const shuffled = allStorylines.sort(() => Math.random() - 0.5);
  const maxStorylines = Math.min(8, Math.max(players.length, 5));

  // First pass: pick storylines that cover uncovered players
  for (const s of shuffled) {
    if (pickedStorylines.length >= maxStorylines) break;
    const mentionedPlayers = players.filter(p => s.includes(p.name));
    const coversNew = mentionedPlayers.some(p => !coveredPlayers.has(p.name));
    if (coversNew) {
      pickedStorylines.push(s);
      mentionedPlayers.forEach(p => coveredPlayers.add(p.name));
    }
  }
  // Second pass: fill remaining slots
  for (const s of shuffled) {
    if (pickedStorylines.length >= maxStorylines) break;
    if (!pickedStorylines.includes(s)) {
      pickedStorylines.push(s);
    }
  }

  const storylinesText = pickedStorylines.length > 0 ? pickedStorylines.join('\n') : '';
  console.log(`📖 Storylines: ${pickedStorylines.length} picked from ${allStorylines.length} available`);

  // ========== SIMPLIFIED PREDICTION ALGORITHM ==========
  // Simple, data-informed: direction from recent form, magnitude from real game outcomes

  // Helper: Get games for a specific half-year period
  const getHalfGames = (player: typeof players[0], year: number, half: 1 | 2) => {
    const startMonth = half === 1 ? 0 : 6;
    const endMonth = half === 1 ? 5 : 11;
    return player.gameHistory.filter(g => {
      const d = parseGameDate(g.date);
      return d.getFullYear() === year && d.getMonth() >= startMonth && d.getMonth() <= endMonth;
    });
  };
  const getPreviousPeriod = () => {
    if (currentHalf === 1) return { year: currentYear - 1, half: 2 as const, label: `H2 ${currentYear - 1}` };
    return { year: currentYear, half: 1 as const, label: `H1 ${currentYear}` };
  };
  const currentPeriodLabel = `H${currentHalf} ${currentYear}`;
  const prevPeriod = getPreviousPeriod();

  const playerSuggestions = players.map(p => {
    if (p.gamesPlayed === 0) {
      return { name: p.name, suggested: Math.round((Math.random() - 0.5) * 120) };
    }

    // Use ACTUAL game results, not averages -- real nights have 3-digit swings
    const recentResults = p.gameHistory.slice(0, Math.min(10, p.gameHistory.length)).map(g => g.profit);

    // Pick a random real game result as the magnitude reference
    const sampleResult = recentResults[Math.floor(Math.random() * recentResults.length)];
    const sampleMagnitude = Math.abs(sampleResult);

    // Direction from recent trend, with flip chance for variety
    const last3 = p.gameHistory.slice(0, Math.min(3, p.gameHistory.length));
    const last3Avg = last3.reduce((sum, g) => sum + g.profit, 0) / last3.length;
    const blended = last3Avg * 0.6 + p.avgProfit * 0.4;
    let direction = blended >= 0 ? 1 : -1;
    if (Math.random() < 0.20) direction *= -1;

    // Scale the sampled magnitude: 0.6-1.1x of the real result
    let suggested = direction * sampleMagnitude * (0.6 + Math.random() * 0.5);

    // Add noise proportional to the sample (not the average)
    suggested += (Math.random() - 0.5) * sampleMagnitude * 0.3;

    // New players: moderate dampening
    if (p.gamesPlayed <= 3) suggested *= 0.7;

    return { name: p.name, suggested: Math.round(suggested) };
  });

  // ========== SURPRISE SYSTEM ==========
  // Multiple surprise types to prevent forecasts from mirroring the ranking table
  type SurpriseType = 'underdog_rise' | 'top_dog_fall' | 'wild_card' | 'breakout' | 'streak_breaker' | 'dark_horse';
  const surpriseCandidates: { name: string; type: SurpriseType; description: string }[] = [];

  const halfGamesMap = new Map(players.map(p => {
    const hg = getHalfGames(p, currentYear, currentHalf);
    const avg = hg.length > 0 ? hg.reduce((s, g) => s + g.profit, 0) / hg.length : 0;
    return [p.name, { games: hg, avg }];
  }));

  for (const p of players) {
    if (p.gamesPlayed < 3) continue;
    const halfData = halfGamesMap.get(p.name);
    const halfAvg = halfData?.avg || 0;
    const suggestion = playerSuggestions.find(s => s.name === p.name);
    if (!suggestion) continue;

    // Underdog rise: bad overall but recent form is good
    if (p.avgProfit < -5 && halfAvg > 10) {
      surpriseCandidates.push({ name: p.name, type: 'underdog_rise',
        description: `היסטוריה שלילית (${Math.round(p.avgProfit)}₪) אבל פורמה חיובית (${Math.round(halfAvg)}₪) - הפתעה חיובית!` });
    }
    // Top dog fall: strong overall but recent slump
    if (p.avgProfit > 15 && halfAvg < -5) {
      surpriseCandidates.push({ name: p.name, type: 'top_dog_fall',
        description: `שחקן חזק (ממוצע ${Math.round(p.avgProfit)}₪) בפורמה שלילית (${Math.round(halfAvg)}₪) - הפתעה שלילית!` });
    }
    // Wild card: high volatility
    if (p.gamesPlayed >= 5) {
      const recent = p.gameHistory.slice(0, 10).map(g => g.profit);
      const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
      const stdDev = Math.sqrt(recent.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / recent.length);
      if (stdDev > 80) {
        surpriseCandidates.push({ name: p.name, type: 'wild_card',
          description: `שחקן תנודתי (סטייה ${Math.round(stdDev)}₪) - יכול להפתיע לכל כיוון!` });
      }
    }
    // Breakout: average player on a streak
    if (Math.abs(p.avgProfit) < 15 && p.currentStreak >= 2 && halfAvg > 15) {
      surpriseCandidates.push({ name: p.name, type: 'breakout',
        description: `${p.currentStreak} נצחונות ברצף עם ממוצע ${Math.round(halfAvg)}₪ - פריצה צפויה!` });
    }
    // Streak breaker: long streak predicted to end
    if (Math.abs(p.currentStreak) >= 3) {
      surpriseCandidates.push({ name: p.name, type: 'streak_breaker',
        description: `רצף של ${Math.abs(p.currentStreak)} ${p.currentStreak > 0 ? 'נצחונות' : 'הפסדים'} - סטטיסטית הרצף צפוי להישבר!` });
    }
    // Dark horse: infrequent player with decent results
    if (p.gamesPlayed >= 3 && p.gamesPlayed <= 8 && p.avgProfit > 10) {
      surpriseCandidates.push({ name: p.name, type: 'dark_horse',
        description: `שחקן לא קבוע (${p.gamesPlayed} משחקים) עם ממוצע +${Math.round(p.avgProfit)}₪ - סוס שחור!` });
    }
  }

  // Pick up to 3 surprises from different types
  const selectedSurprises: typeof surpriseCandidates = [];
  const usedSurpriseTypes = new Set<SurpriseType>();
  const usedSurpriseNames = new Set<string>();
  const shuffledSurprises = [...surpriseCandidates].sort(() => Math.random() - 0.5);
  const maxSurpriseCount = Math.min(3, Math.ceil(players.length / 3));

  for (const candidate of shuffledSurprises) {
    if (selectedSurprises.length >= maxSurpriseCount) break;
    if (usedSurpriseTypes.has(candidate.type) || usedSurpriseNames.has(candidate.name)) continue;
    selectedSurprises.push(candidate);
    usedSurpriseTypes.add(candidate.type);
    usedSurpriseNames.add(candidate.name);
  }

  // Apply surprise: use a real game result to set a realistic magnitude
  for (const surprise of selectedSurprises) {
    const sp = playerSuggestions.find(p => p.name === surprise.name);
    if (!sp) continue;
    const playerData = players.find(p => p.name === surprise.name)!;
    const recent = playerData.gameHistory.slice(0, 10);
    // Pick a random real result for realistic scale
    const sample = recent[Math.floor(Math.random() * recent.length)];
    const mag = Math.abs(sample?.profit || 50) * (0.7 + Math.random() * 0.4);

    if (surprise.type === 'top_dog_fall') {
      sp.suggested = -Math.abs(mag);
    } else if (surprise.type === 'streak_breaker') {
      sp.suggested = playerData.currentStreak > 0 ? -Math.abs(mag) : Math.abs(mag);
    } else {
      sp.suggested = Math.abs(mag);
    }
    sp.suggested = Math.round(sp.suggested);
  }

  // Zero-sum balance
  const totalSuggested = playerSuggestions.reduce((sum, p) => sum + p.suggested, 0);
  const adj = playerSuggestions.length > 0 ? totalSuggested / playerSuggestions.length : 0;
  playerSuggestions.forEach(p => { p.suggested = Math.round(p.suggested - adj); });
  const finalTotal = playerSuggestions.reduce((sum, p) => sum + p.suggested, 0);
  if (finalTotal !== 0) {
    const sortedByAbs = [...playerSuggestions].sort((a, b) => Math.abs(a.suggested) - Math.abs(b.suggested));
    sortedByAbs[0].suggested -= finalTotal;
  }

  console.log('🎲 Surprises:', selectedSurprises.map(s => `${s.name}(${s.type})`).join(', '));
  console.log('📊 Predictions:', playerSuggestions.map(s => `${s.name}: ${s.suggested >= 0 ? '+' : ''}${s.suggested}`).join(', '));

  const surpriseText = selectedSurprises.length > 0 
    ? `\n🎲 הפתעות:\n` + selectedSurprises.map(s => `- ${s.name}: ${s.description}`).join('\n')
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
  
  // ========== ANGLE ASSIGNMENT ==========
  // Assign each player a unique narrative angle to ensure variety
  type AngleType = 'streak' | 'ranking_battle' | 'comeback' | 'milestone' | 'form' | 'big_last_game' | 'veteran' | 'dark_horse' | 'default';
  const angleUsed = new Map<AngleType, number>();
  const maxPerAngle = players.length <= 6 ? 1 : 2;

  const playerAngles: { name: string; angle: AngleType; angleHint: string }[] = [];

  playersWithYearStats.forEach(p => {
    const currentHalfGames = getHalfGames(p, currentYear, currentHalf);
    const periodAvg = currentHalfGames.length > 0 
      ? Math.round(currentHalfGames.reduce((sum, g) => sum + g.profit, 0) / currentHalfGames.length) : 0;
    const allTimeAvg = Math.round(p.avgProfit);
    const winRate = p.gamesPlayed > 0 ? Math.round((p.winCount / p.gamesPlayed) * 100) : 0;
    const lastGame = p.gameHistory[0];
    const lastGameProfit = lastGame?.profit || 0;

    const halfRankData = globalRankings?.currentHalf.rankings.find(r => r.name === p.name);
    const halfRank = halfRankData?.rank || tonightRanking.findIndex(sp => sp.name === p.name) + 1;
    const aboveIdx = halfRank - 2;
    const gapToAbove = aboveIdx >= 0 && aboveIdx < tonightRanking.length 
      ? Math.round(tonightRanking[aboveIdx].yearProfit - p.yearProfit) : 999;

    const milestones = [500, 1000, 1500, 2000];
    const nearMilestone = milestones.find(m => p.totalProfit > 0 && m - Math.round(p.totalProfit) > 0 && m - Math.round(p.totalProfit) <= 150);

    const canUse = (a: AngleType) => (angleUsed.get(a) || 0) < maxPerAngle;
    const assign = (a: AngleType, hint: string) => { angleUsed.set(a, (angleUsed.get(a) || 0) + 1); playerAngles.push({ name: p.name, angle: a, angleHint: hint }); };

    const isNewPlayer = p.gamesPlayed === 0 || p.gameHistory.length === 0;
    if (isNewPlayer) {
      assign('default', `שחקן חדש לגמרי - אין נתונים! ← התמקד בזה שהוא חדש, אל תמציא סטטיסטיקות!`);
    } else if (Math.abs(p.currentStreak) >= 3 && canUse('streak')) {
      const dir = p.currentStreak > 0 ? `${p.currentStreak} נצחונות ברצף` : `${Math.abs(p.currentStreak)} הפסדים - מחפש קאמבק`;
      assign('streak', `${dir} ← התמקד בנתון הרצף, לא בממוצע!`);
    } else if (gapToAbove <= 120 && gapToAbove > 0 && halfRank > 1 && canUse('ranking_battle')) {
      const aboveName = tonightRanking[aboveIdx]?.name || '';
      assign('ranking_battle', `${gapToAbove}₪ ממקום ${halfRank - 1} (${aboveName}) ← התמקד בפער הדירוג, לא בממוצע!`);
    } else if (p.daysSinceLastGame >= 20 && p.daysSinceLastGame < 900 && canUse('comeback')) {
      assign('comeback', `חוזר אחרי ${p.daysSinceLastGame} ימים ← התמקד בימי ההיעדרות, לא בממוצע!`);
    } else if (nearMilestone && canUse('milestone')) {
      assign('milestone', `${nearMilestone - Math.round(p.totalProfit)}₪ מ-${nearMilestone}₪ כולל ← התמקד באבן הדרך, לא בממוצע!`);
    } else if (currentHalfGames.length >= 3 && Math.abs(periodAvg - allTimeAvg) > 20 && canUse('form')) {
      const dir = periodAvg > allTimeAvg ? 'פורמה עולה' : 'פורמה יורדת';
      assign('form', `${dir}: תקופה ${periodAvg >= 0 ? '+' : ''}${periodAvg}₪ vs היסטורי ${allTimeAvg >= 0 ? '+' : ''}${allTimeAvg}₪ ← התמקד בהשוואת המגמה!`);
    } else if (Math.abs(lastGameProfit) > 80 && canUse('big_last_game')) {
      assign('big_last_game', `משחק אחרון: ${lastGameProfit >= 0 ? '+' : ''}${Math.round(lastGameProfit)}₪ ← התמקד בתוצאת המשחק האחרון, לא בממוצע!`);
    } else if (p.gamesPlayed >= 30 && canUse('veteran')) {
      assign('veteran', `ותיק: ${p.gamesPlayed} משחקים, ${winRate}% נצחונות ← התמקד בניסיון ואחוז נצחונות, לא בממוצע!`);
    } else if (p.avgProfit < -5 && periodAvg > 10 && canUse('dark_horse')) {
      assign('dark_horse', `היסטוריה שלילית אבל פורמה חיובית ← התמקד בשינוי המגמה, לא בממוצע!`);
    } else {
      assign('default', `${p.gamesPlayed} משחקים, ${winRate}% נצחונות ← התמקד באחוז נצחונות או תוצאה אחרונה, לא בממוצע!`);
    }
  });

  console.log('🎭 Assigned angles:', playerAngles.map(a => `${a.name}: ${a.angle}`).join(', '));

  // ========== BUILD STAT CARDS ==========
  const playerDataText = playersWithYearStats.map(p => {
    const lastGame = p.gameHistory[0];
    const isNewPlayer = p.gamesPlayed === 0 || p.gameHistory.length === 0;
    const lastGameResult = lastGame 
      ? (lastGame.profit > 0 ? `ניצח +${Math.round(lastGame.profit)}₪` : 
         lastGame.profit < 0 ? `הפסיד ${Math.round(lastGame.profit)}₪` : 'יצא באפס')
      : 'שחקן חדש - אין היסטוריה';
    
    const actualStreak = p.currentStreak;
    let streakText = '';
    if (actualStreak >= 3) streakText = `🔥 ${actualStreak} נצחונות ברצף!`;
    else if (actualStreak <= -3) streakText = `${Math.abs(actualStreak)} הפסדים ברצף`;
    else if (actualStreak === 2) streakText = `2 נצחונות ברצף`;
    else if (actualStreak === -2) streakText = `2 הפסדים ברצף`;
    else if (actualStreak === 1) streakText = `ניצח אחרון`;
    else if (actualStreak === -1) streakText = `הפסיד אחרון`;
    else streakText = 'אין רצף';

    const currentHalfGames = getHalfGames(p, currentYear, currentHalf);
    const prevHalfGames = getHalfGames(p, prevPeriod.year, prevPeriod.half);
    let periodGames = currentHalfGames;
    let periodLabel = currentPeriodLabel;
    if (currentHalfGames.length === 0 && prevHalfGames.length > 0) {
      periodGames = prevHalfGames;
      periodLabel = prevPeriod.label;
    }
    const periodAvg = periodGames.length > 0 
      ? Math.round(periodGames.reduce((sum, g) => sum + g.profit, 0) / periodGames.length) : 0;

    const halfRankData = globalRankings?.currentHalf.rankings.find(r => r.name === p.name);
    const halfRank = halfRankData?.rank || tonightRanking.findIndex(sp => sp.name === p.name) + 1;
    const halfTotalActive = globalRankings?.currentHalf.totalActivePlayers || players.length;

    const allTimeRankData = globalRankings?.allTime.rankings.find(r => r.name === p.name);
    const allTimeRank = allTimeRankData?.rank || 0;
    const allTimeTotalActive = globalRankings?.allTime.totalActivePlayers || players.length;

    const winRate = p.gamesPlayed > 0 ? Math.round((p.winCount / p.gamesPlayed) * 100) : 0;
    const allTimeAvg = Math.round(p.avgProfit);
    const suggestion = playerSuggestions.find(s => s.name === p.name)?.suggested || 0;
    const angle = playerAngles.find(a => a.name === p.name);

    const aboveIdx = halfRank - 2;
    const belowIdx = halfRank;
    const aboveName = aboveIdx >= 0 && aboveIdx < tonightRanking.length ? tonightRanking[aboveIdx].name : '';
    const belowName = belowIdx >= 0 && belowIdx < tonightRanking.length ? tonightRanking[belowIdx].name : '';
    const gapAbove = aboveIdx >= 0 && aboveIdx < tonightRanking.length 
      ? Math.round(tonightRanking[aboveIdx].yearProfit - p.yearProfit) : 0;
    const gapBelow = belowIdx >= 0 && belowIdx < tonightRanking.length 
      ? Math.round(p.yearProfit - tonightRanking[belowIdx].yearProfit) : 0;

    const lines: string[] = [];
    lines.push(`══ ${p.name} ${p.isFemale ? '(נקבה)' : '(זכר)'} ══`);
    if (isNewPlayer) {
      lines.push(`🆕 שחקן חדש! אין היסטוריית משחקים. אין נתונים סטטיסטיים.`);
    } else {
      lines.push(`משחק אחרון: ${lastGameResult} (${lastGame?.date || 'N/A'})`);
      lines.push(`רצף: ${streakText}`);
      if (periodGames.length > 0) {
        lines.push(`⭐ טבלת ${periodLabel}: מקום #${halfRank} מתוך ${halfTotalActive}, ${periodGames.length} משחקים, ממוצע ${periodAvg >= 0 ? '+' : ''}${periodAvg}₪`);
      }
      lines.push(`היסטוריה כוללת: ${p.gamesPlayed} משחקים, ממוצע ${allTimeAvg >= 0 ? '+' : ''}${allTimeAvg}₪, ${winRate}% נצחונות, סה"כ ${p.totalProfit >= 0 ? '+' : ''}${Math.round(p.totalProfit)}₪`);
      if (allTimeRank > 0 && allTimeRank <= 3) {
        lines.push(`דירוג כללי (כל הזמנים): #${allTimeRank} מתוך ${allTimeTotalActive}`);
      }
      if (gapAbove > 0 && halfRank > 1) {
        lines.push(`פער בטבלת ${periodLabel}: ${gapAbove}₪ מאחורי מקום ${halfRank - 1} (${aboveName})`);
      }
      if (gapBelow > 0 && belowName) {
        lines.push(`יתרון בטבלת ${periodLabel}: ${gapBelow}₪ על מקום ${halfRank + 1} (${belowName})`);
      }
      if (p.daysSinceLastGame >= 20 && p.daysSinceLastGame < 900) {
        lines.push(`חזרה: אחרי ${p.daysSinceLastGame} ימים`);
      }
    }
    lines.push(`זווית מוצעת: ${angle?.angle || 'default'} - ${angle?.angleHint || ''}`);
    lines.push(`🔒 חיזוי סופי (נעול): ${suggestion >= 0 ? '+' : ''}${suggestion}₪ ← המשפט חייב להתאים לכיוון ולעוצמה הזו!`);

    console.log(`🔍 ${p.name}: angle=${angle?.angle}, suggestion=${suggestion >= 0 ? '+' : ''}${suggestion}₪`);

    return lines.join('\n');
  }).join('\n\n');

  const prompt = `אתה פרשן ספורט ישראלי שנון, קולע ומשעשע. התפקיד שלך: ליצור חוויה מהנה לפני ערב פוקר. לכל שחקן יש חיזוי רווח/הפסד שכבר נקבע (🔒) - אתה כותב את הטקסט המלווה.

📊 כרטיסי שחקנים:
${playerDataText}
${allTimeRecordsText ? `\n🏅 שיאי הקבוצה (שחקני הלילה בלבד):\n${allTimeRecordsText}` : ''}
${storylinesText ? `\n📖 סיפורי הערב - עובדות מעניינות בין השחקנים (חומר גלם מעולה למשפטים!):\n${storylinesText}` : ''}
${milestonesText ? `\n🎯 אבני דרך:\n${milestonesText}` : ''}
${surpriseText}

📤 פלט JSON בפורמט הבא:
{"groupIntro":"משפט פתיחה אחד לכל הערב","players":[{"name":"שם","highlight":"כותרת","sentence":"משפט","isSurprise":false}]}

🌟 groupIntro - משפט פתיחה לערב (חובה!):
• משפט אחד בעברית (15-30 מילים) שמתאר את הערב הספציפי הזה
• חובה: לפחות 2 שמות שחקנים ועובדה ספציפית אחת מהנתונים!
• אסור משפט גנרי! אסור "ערב של חשבונות פתוחים" או "יריבויות עתיקות" - חייב פרטים ספציפיים
• דוגמאות טובות: "חרדון עם 4 ברצף נגד אייל שהפסיד 240₪ אחרון - ותומר מגיע ברקע עם ממוצע +21₪ השנה"
• "ליאור עם 179 משחקים מארח, אורן צריך קאמבק אחרי -180₪, וחרדון על רצף חם - ערב מבטיח"
• הטון: כמו פרשן ספורט שמציג את הדמויות לפני המשחק

📝 לכל שחקן כתוב:
1. highlight - כותרת קצרה (3-6 מילים) - העובדה הכי מעניינת ומשעשעת
2. sentence - משפט אחד בעברית (20-40 מילים) - סיפור מרתק עם 2-3 מספרים אמיתיים מהכרטיס
3. isSurprise - true רק אם החיזוי מנוגד להיסטוריה (פער ≥40₪ מהממוצע ההיסטורי)

⭐ הכלל הכי חשוב - בידור מעל הכל:
• סיפורי ערב (📖) הם הזהב שלך! אם יש יריבות, נקמה, קמע, נמסיס - תשתמש בהם!
• אם שחקן מוזכר בסיפור ערב, העדף את הסיפור על פני סטטיסטיקה יבשה
• כתוב כמו פרשן ספורט: דרמטי, שנון, עם הומור כשמתאים
• כל משפט צריך לספר סיפור, לא רק לפלוט מספרים

🎯 כל שחקן = סיפור ייחודי (חובה!):
• לכל שחקן זווית מוצעת - השתמש בה כבסיס
• אסור שלשני שחקנים יהיה אותו סוג נתון מרכזי!
• העדיפויות: סיפורי ערב (יריבויות/נקמות/נמסיס) ← רצפים ← קרבות דירוג ← תוצאה אחרונה ← אחוז נצחונות ← ותק
• שחקן חדש (בלי היסטוריה) → כתוב שהוא חדש, אל תמציא מספרים!

⚡ התאמת טון לחיזוי:
• חיזוי חיובי → טון חיובי/בטוח (אבל לא מוגזם לחיזוי קטן)
• חיזוי שלילי → טון מאתגר/הומוריסטי (אסור לכתוב אופטימי!)
• מילים כמו "מטורף", "מדהים", "היסטורי" → רק לנתונים באמת חריגים (רצף 5+, פער 150₪+)

🚫 איסורים מוחלטים (הפרה = פסילה!):
• אסור להזכיר את מספר החיזוי ב-sentence! המספר כבר מוצג בכרטיס. אסור "רווח של X₪", "הפסד של X₪", "יעד של X₪", "מכוון ל-X₪" כשX הוא מספר החיזוי!
• אסור להזכיר הפסד מצטבר/כולל/היסטורי! אסור "2000₪ הפסד כולל" או "סה"כ מינוס". הפסד במשחק אחרון - מותר
• אסור לסיים כמה משפטים באותה תבנית! אם כתבת "והלילה הוא מכוון ל..." לשחקן אחד - אסור לאחרים!

✍️ כללי כתיבה:
• דירוגים: רק מטבלת התקופה (⭐)
• highlight ו-sentence חייבים להיות עקביים
• כל highlight שונה מהאחרים! כל משפט במבנה שונה!
• כל משפט מתחיל ומסתיים אחרת - גיוון מלא!

✅ דוגמאות טובות (סיפורים, לא סטטיסטיקה!):
• highlight "5:2 מול אייל", sentence "בחמישה משחקים אחרונים ביחד, ליאור שלט באייל עם 5 נצחונות מול 2. הלילה האם הסדרה תימשך או שאייל מכין נקמה?"
• highlight "הספונסר של הקבוצה", sentence "הפסיד 350₪ סך הכל לשחקני הערב, רובם הלכו לכיסו של סגל. הלילה או שהכל מתהפך או שהוא ממשיך לממן"
• highlight "3 ברצף!", sentence "רכבת שאף אחד לא עוצר - אחרי +120₪ במשחק האחרון, הממוצע השנתי קפץ ל-+45₪ למשחק. מי יעז לעמוד בדרך?"
• highlight "40 יום בלי קלפים", sentence "חלודה של 40 ימים לא נעלמת ביום אחד - אבל עם 55% נצחונות היסטורי, הניסיון לא נעלם"
• highlight "דף חלק", sentence "שחקן חדש לגמרי, בלי אף משחק בהיסטוריה. הקלפים יגידו את המילה הראשונה הלילה"`;

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
            temperature: 0.7,
            topK: 40,
            topP: 0.95,
            maxOutputTokens: 4096,
            responseMimeType: 'application/json',
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

      let aiOutput: { name: string; highlight: string; sentence: string; isSurprise: boolean }[];
      let groupIntro = '';
      try {
        const parsed = JSON.parse(jsonText.trim());
        // Handle both new format { groupIntro, players: [...] } and old format [...]
        if (Array.isArray(parsed)) {
          aiOutput = parsed;
        } else if (parsed.players && Array.isArray(parsed.players)) {
          aiOutput = parsed.players;
          groupIntro = parsed.groupIntro || '';
        } else {
          throw new Error('Unexpected JSON format');
        }
        console.log('✅ Parsed', aiOutput.length, 'forecasts from AI');
        if (groupIntro) console.log('🌟 Group intro:', groupIntro);
      } catch (parseError) {
        console.error('❌ JSON parse error, trying next model');
        continue; // Try next model
      }

      // Merge AI text with our locked expectedProfit values
      let forecasts: ForecastResult[] = players.map(p => {
        const aiEntry = aiOutput.find(a => a.name === p.name);
        const suggestion = playerSuggestions.find(s => s.name === p.name);
        return {
          name: p.name,
          expectedProfit: suggestion?.suggested || 0,
          highlight: aiEntry?.highlight || '',
          sentence: aiEntry?.sentence || '',
          isSurprise: aiEntry?.isSurprise || false,
          groupIntro: '',
        };
      });
      // Attach groupIntro to the first forecast entry
      if (groupIntro && forecasts.length > 0) {
        forecasts[0].groupIntro = groupIntro;
      }
      
      console.log('🔗 Merged AI text with locked predictions:', forecasts.map(f => `${f.name}: ${f.expectedProfit >= 0 ? '+' : ''}${f.expectedProfit}₪`).join(', '));
      
      // ========== FACT-CHECK AND CORRECT AI OUTPUT ==========
      console.log('🔍 Fact-checking AI output...');
      
      forecasts = forecasts.map(forecast => {
        const player = players.find(p => p.name === forecast.name);
        if (!player) return forecast;
        
        // Get actual year data
        const thisYearGames = player.gameHistory.filter(g => parseGameDate(g.date).getFullYear() === currentYear);
        const yearGames = thisYearGames.length;
        const yearProfit = thisYearGames.reduce((sum, g) => sum + g.profit, 0);
        
        // Calculate period ranking (must match what we tell the AI in the stat card!)
        const halfRankData = globalRankings?.currentHalf.rankings.find(r => r.name === player.name);
        const rankTonight = halfRankData?.rank || (
          [...players].sort((a, b) => {
            const aProfit = getHalfGames(a, currentYear, currentHalf).reduce((s, g) => s + g.profit, 0);
            const bProfit = getHalfGames(b, currentYear, currentHalf).reduce((s, g) => s + g.profit, 0);
            return bProfit - aProfit;
          }).findIndex(p => p.name === player.name) + 1
        );
        
        // USE THE ACTUAL CURRENT STREAK (spans across years!)
        const actualStreak = player.currentStreak;
        
        // Last game result
        const lastGame = player.gameHistory[0];
        const lastGameProfit = lastGame?.profit || 0;
        const wonLastGame = lastGameProfit > 0;
        const lostLastGame = lastGameProfit < 0;
        
        let correctedSentence = forecast.sentence || '';
        let correctedHighlight = forecast.highlight || '';
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

          // Remove false #1 claims
          correctedSentence = correctedSentence
            .replace(/מוביל את הטבלה/g, `נמצא במקום ${rankTonight}`)
            .replace(/בראש הטבלה/g, `במקום ${rankTonight}`)
            .replace(/מקום ראשון/g, `מקום ${rankTonight}`)
            .replace(/מקום 1\b/g, `מקום ${rankTonight}`)
            .replace(/#1\b/g, `#${rankTonight}`);
        }
        
        // ========== 2b. FIX RANKING ERRORS IN HIGHLIGHT ==========
        if ((correctedHighlight.includes('מוביל') || correctedHighlight.includes('בראש') || correctedHighlight.includes('מקום ראשון') || correctedHighlight.includes('מקום 1') || correctedHighlight.includes('#1')) && rankTonight !== 1) {
          errorDetails.push(`highlight rank: claimed #1 but actually #${rankTonight}`);

          correctedHighlight = correctedHighlight
            .replace(/מוביל את הטבלה/g, `מקום ${rankTonight} בטבלה`)
            .replace(/בראש הטבלה/g, `במקום ${rankTonight}`)
            .replace(/מקום ראשון/g, `מקום ${rankTonight}`)
            .replace(/מקום 1\b/g, `מקום ${rankTonight}`)
            .replace(/#1\b/g, `#${rankTonight}`);
        }
        
        // ========== 3. FIX LAST GAME ERRORS ==========
        // Check for contradictions about last game result
        if (wonLastGame && correctedSentence.includes('הפסד') && correctedSentence.includes('אחרון')) {
          errorDetails.push('last_game: claimed loss but actually won');

        }
        if (lostLastGame && correctedSentence.includes('נצחון') && correctedSentence.includes('אחרון')) {
          errorDetails.push('last_game: claimed win but actually lost');

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

            }
          }
        }
        
        // ========== 6. CLEAN UP BROKEN TEXT + STRIP NEGATIVES ==========
        correctedSentence = correctedSentence.replace(/\s+/g, ' ').trim();
        correctedSentence = correctedSentence.replace(/,\s*,/g, ',');
        correctedSentence = correctedSentence.replace(/\.\s*\./g, '.');
        correctedSentence = correctedSentence.replace(/\s+\./g, '.');
        
        // Strip cumulative/total losses from sentence (game-last losses are OK)
        correctedSentence = correctedSentence
          .replace(/סה"כ\s*(הפסד\s*(של\s*)?)?[-−]?\s*\d+₪/g, '')
          .replace(/(הפסד|מינוס)\s*(כולל|היסטורי|מצטבר)\s*(של\s*)?[-−]?\s*\d+₪/g, '')
          .replace(/מ[-−]\s*\d+₪\s*הפסד\s*(כולל|היסטורי)/g, '')
          .replace(/לא\s*לרדת\s*(מתחת\s*ל?)?[-−]?\s*\d+₪\s*(הפסד\s*)?(כולל|מצטבר)?/g, '')
          .replace(/[-−]?\d{3,}₪\s*(הפסד\s*)?(כולל|מצטבר|היסטורי)/g, '')
          .replace(/\s+/g, ' ').replace(/,\s*,/g, ',').replace(/,\s*\./g, '.').trim();
        
        // ========== 6b. STRIP FORECAST NUMBER FROM SENTENCE ==========
        // The AI often leaks the prediction number into the text despite instructions
        const predictedProfit = forecast.expectedProfit;
        const absProfit = Math.abs(predictedProfit);
        if (absProfit > 0) {
          const profitStr = String(absProfit);
          const leakPatterns = [
            new RegExp(`(רווח|הפסד|יעד|מכוון)\\s*(של|ל|ל-)?\\s*[-+]?${profitStr}₪`, 'g'),
            new RegExp(`[-+]?₪?${profitStr}₪?\\s*(רווח|הפסד)`, 'g'),
            new RegExp(`(לרווח|להפסד|מכוון ל|שואף ל)[-+\\s]*${profitStr}₪`, 'g'),
            new RegExp(`עם\\s*[-+]?${profitStr}₪`, 'g'),
          ];
          for (const pattern of leakPatterns) {
            if (pattern.test(correctedSentence)) {
              errorDetails.push(`number_leak: prediction ${predictedProfit}₪ found in sentence`);
              correctedSentence = correctedSentence.replace(pattern, '').trim();
            }
          }
          correctedSentence = correctedSentence.replace(/\s+/g, ' ').replace(/,\s*,/g, ',').replace(/,\s*\./g, '.').replace(/\.\s*\./g, '.').trim();
        }
        
        // ========== 7. TEXT-NUMBER CONSISTENCY CHECK ==========
        const allTimeAvg = Math.round(player.avgProfit);
        const winRate = player.gamesPlayed > 0 ? Math.round((player.winCount / player.gamesPlayed) * 100) : 0;
        
        // Detect optimistic text for negative predictions
        const optimisticWords = ['ינצח', 'יצליח', 'מסוכן', 'רכבת', 'מוביל', 'פורמה מטורפת', 'הולך לנצח', 'בדרך לפסגה', 'שולט', 'דומיננטי'];
        const pessimisticWords = ['ספונסר', 'תורם', 'קשה', 'מאתגר', 'חלודה', 'נופל', 'סובל', 'בעיה'];
        const superlativeWords = ['מטורף', 'מדהים', 'היסטורי', 'חסר תקדים', 'מושלם', 'אגדי', 'פנומנלי'];
        
        // Only flag superlatives for truly tiny predictions (±20₪ or less)
        if (Math.abs(predictedProfit) <= 20) {
          for (const word of superlativeWords) {
            if (correctedSentence.includes(word)) {
              errorDetails.push(`intensity_mismatch: "${word}" used for tiny prediction ${predictedProfit}₪`);

              correctedSentence = correctedSentence
                .replace('מטורף', predictedProfit > 0 ? 'ברור' : 'לא פשוט')
                .replace('מדהים', predictedProfit > 0 ? 'סביר' : 'בולט')
                .replace('היסטורי', 'ברור')
                .replace('חסר תקדים', 'יוצא דופן')
                .replace('מושלם', 'טוב')
                .replace('אגדי', 'מעניין')
                .replace('פנומנלי', 'סביר');
            }
          }
        }
        
        const hasOptimistic = optimisticWords.some(w => correctedSentence.includes(w));
        const hasPessimistic = pessimisticWords.some(w => correctedSentence.includes(w));
        
        // Only flag severe direction mismatches
        if (predictedProfit <= -40 && hasOptimistic && !hasPessimistic) {
          errorDetails.push(`tone_mismatch: optimistic text but predicted ${predictedProfit}₪`);

        }
        if (predictedProfit >= 40 && hasPessimistic && !hasOptimistic) {
          errorDetails.push(`tone_mismatch: pessimistic text but predicted +${predictedProfit}₪`);

        }
        
        // ========== 8. VALIDATE AI SENTENCE (fallback if empty/short) ==========
        if (!correctedSentence || correctedSentence.length < 10 || correctedSentence === 'X') {
          // Generate direction-appropriate fallback
          if (predictedProfit >= 40) {
            if (actualStreak >= 3) correctedSentence = `${actualStreak} נצחונות ברצף, ממוצע +${allTimeAvg}₪ ב-${player.gamesPlayed} משחקים. הרוח בגב!`;
            else correctedSentence = `ממוצע +${allTimeAvg}₪ ב-${player.gamesPlayed} משחקים, ${winRate}% נצחונות. ערב טוב צפוי`;
          } else if (predictedProfit <= -40) {
            correctedSentence = `${player.gamesPlayed} משחקים ו-${winRate}% נצחונות, אבל הנתונים לא מבשרים טובות. ערב מאתגר`;
          } else if (predictedProfit > 0) {
            correctedSentence = `${winRate}% נצחונות ב-${player.gamesPlayed} משחקים, מקום ${rankTonight}. יתרון קל הלילה`;
          } else {
            correctedSentence = `${player.gamesPlayed} משחקים, ${winRate}% נצחונות. צריך לעבוד קשה הלילה`;
          }
          console.log(`⚠️ ${player.name}: Used direction-appropriate fallback sentence`);
        } else {
          console.log(`✅ ${player.name}: AI sentence: "${correctedSentence}"`);
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

  const comparisons = forecasts.map(f => {
    const actual = actualResults.find(a => a.playerName === f.playerName);
    const actualProfit = actual?.profit || 0;
    const gap = Math.abs(actualProfit - f.expectedProfit);
    const directionCorrect = (f.expectedProfit >= 0 && actualProfit >= 0) || (f.expectedProfit < 0 && actualProfit < 0);
    
    let accuracyLevel: 'accurate' | 'close' | 'missed';
    if (gap <= 30) accuracyLevel = 'accurate';
    else if (gap <= 60) accuracyLevel = 'close';
    else accuracyLevel = 'missed';
    
    return { name: f.playerName, forecast: f.expectedProfit, actual: actualProfit, gap, accuracyLevel, directionCorrect };
  });

  const accurate = comparisons.filter(c => c.accuracyLevel === 'accurate').length;
  const close = comparisons.filter(c => c.accuracyLevel === 'close').length;
  const missed = comparisons.filter(c => c.accuracyLevel === 'missed').length;
  const total = comparisons.length;
  const directionHits = comparisons.filter(c => c.directionCorrect).length;
  
  const score = (accurate * 2 + close * 1);
  const maxScore = total * 2;
  const scorePercent = Math.round((score / maxScore) * 100);
  
  let rating: string;
  if (scorePercent >= 80) rating = 'מעולה';
  else if (scorePercent >= 60) rating = 'טוב';
  else if (scorePercent >= 40) rating = 'סביר';
  else rating = 'חלש';
  
  const sortedByGap = [...comparisons].sort((a, b) => a.gap - b.gap);
  const bestPrediction = sortedByGap[0];
  const worstPrediction = sortedByGap[sortedByGap.length - 1];

  const prompt = `אתה מסכם תחזית פוקר בעברית. כתוב משפט סיכום קצר ורלוונטי (עד 25 מילים) על הצלחת התחזית.

נתונים:
- ציון כולל: ${score}/${maxScore} (${scorePercent}%) - ${rating}
- כיוון נכון (רווח/הפסד): ${directionHits}/${total}
- מדויק (פער ≤30): ${accurate}/${total}
- קרוב (פער 31-60): ${close}/${total}  
- החטאה (פער >60): ${missed}/${total}
- תחזית מדויקת ביותר: ${bestPrediction.name} (פער ${bestPrediction.gap})
- תחזית רחוקה ביותר: ${worstPrediction.name} (פער ${worstPrediction.gap})

כתוב משפט סיכום שכולל את אחוז הכיוון (${directionHits}/${total}) ותובנה על התחזית. לא להיות מצחיק. כתוב רק את המשפט.`;

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

// ─── AI Game Night Summary ──────────────────────────────────────────────────

export interface GameNightPlayerResult {
  name: string;
  profit: number;
  rebuys: number;
  rank: number; // 1 = biggest winner
}

export interface GameNightPeriodStanding {
  name: string;
  periodRank: number;
  totalProfit: number;
  gamesPlayed: number;
  winPct: number;
  currentStreak: number; // positive = wins, negative = losses
}

export interface GameNightSummaryPayload {
  tonight: GameNightPlayerResult[];
  totalRebuys: number;
  totalPot: number;
  periodLabel: string; // e.g. "H1 2026"
  periodStandings: GameNightPeriodStanding[];
  recordsBroken: string[];   // pre-formatted Hebrew strings
  notableStreaks: string[];   // e.g. "דוד — 5 נצחונות ברצף"
  upsets: string[];           // e.g. "אורי (75%) הפסיד"
  milestones: string[];       // e.g. "דוד — משחק #20 בתקופה"
  welcomeBacks: string[];     // e.g. "משה חזר אחרי 45 יום"
  rankingShifts: string[];    // e.g. "ליאור עקף את דוד ועלה למקום 3"
  gameNumberInPeriod: number;
}

export const generateGameNightSummary = async (
  payload: GameNightSummaryPayload
): Promise<string> => {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error('NO_API_KEY');

  const { tonight, totalRebuys, totalPot, periodLabel, periodStandings, recordsBroken, notableStreaks, upsets, milestones, welcomeBacks, rankingShifts, gameNumberInPeriod } = payload;

  if (tonight.length === 0) throw new Error('No players in tonight results');

  const winner = tonight[0];
  const loser = tonight[tonight.length - 1];

  const tonightLines = tonight.map(p =>
    `${p.rank}. ${p.name}: ${p.profit >= 0 ? '+' : ''}${p.profit}₪ (${p.rebuys} קניות)`
  ).join('\n');

  const standingsLines = periodStandings.map(s =>
    `מקום ${s.periodRank}: ${s.name} — ${s.totalProfit >= 0 ? '+' : ''}${s.totalProfit}₪, ${s.gamesPlayed} משחקים, ${Math.round(s.winPct)}% נצחונות${s.currentStreak !== 0 ? `, רצף ${s.currentStreak > 0 ? s.currentStreak + ' נצחונות' : Math.abs(s.currentStreak) + ' הפסדים'}` : ''}`
  ).join('\n');

  const contextSections: string[] = [];

  if (recordsBroken.length > 0) {
    contextSections.push(`שיאים שנשברו הערב:\n${recordsBroken.join('\n')}`);
  }
  if (notableStreaks.length > 0) {
    contextSections.push(`רצפים בולטים:\n${notableStreaks.join('\n')}`);
  }
  if (upsets.length > 0) {
    contextSections.push(`הפתעות:\n${upsets.join('\n')}`);
  }
  if (milestones.length > 0) {
    contextSections.push(`אבני דרך:\n${milestones.join('\n')}`);
  }
  if (welcomeBacks.length > 0) {
    contextSections.push(`חזרו לשולחן:\n${welcomeBacks.join('\n')}`);
  }
  if (rankingShifts.length > 0) {
    contextSections.push(`שינויים בטבלה:\n${rankingShifts.join('\n')}`);
  }

  const contextBlock = contextSections.length > 0
    ? `\n\nאירועים מיוחדים הערב:\n${contextSections.join('\n\n')}`
    : '';

  const prompt = `אתה המספר הרשמי של קבוצת פוקר שבועית בין חברים. כתוב סיכום קצר וכיפי של ערב המשחק שישותף בקבוצת הוואטסאפ.

נתוני הערב (משחק #${gameNumberInPeriod} ב${periodLabel}):
קופה: ${totalPot}₪ (${totalRebuys} קניות סה״כ)
מנצח: ${winner.name} (+${winner.profit}₪)
מפסיד גדול: ${loser.name} (${loser.profit}₪)

תוצאות מלאות:
${tonightLines}

טבלת ${periodLabel} (מעודכנת):
${standingsLines}${contextBlock}

הנחיות כתיבה:
- עברית בלבד, שפה טבעית וזורמת. בלי מונחים באנגלית.
- חובה להזכיר את כל ${tonight.length} השחקנים בשמם לפחות פעם אחת.
- טון: מיקס של פרשנות ספורט, סיפור, ועקיצות חבריות. קצ׳ אבל חם.
- מותר להמציא כינויים או תארים מצחיקים לשחקנים אם זה מתאים לנתונים (למשל ״מלך הקאמבקים״ למי שקנה הרבה וסיים ברווח, ״תורם הערב הרשמי״ למפסיד הגדול).
- שלב עובדות היסטוריות בצורה טבעית בתוך הסיפור (רצפים, שיאים, שינויים בטבלה) — לא כרשימה.
- אורך: 60-120 מילים. אם הלילה היה דרמטי (שיאים, קאמבקים, הפתעות) — קרוב ל-120. אם שקט — קרוב ל-60.
- סיים עם משפט חזק — פאנץ׳ליין, עקיצה, או הצצה למשחק הבא.
- לא לכתוב רשימה עם נקודות או מספרים. הסיכום צריך לזרום כטקסט אחד.
- לא להתחיל ב״ערב של דרמות״ או ״לילה של...״ — תתחיל ישר עם תוכן.

כתוב רק את הסיכום, בלי כותרת ובלי הקדמה.`;

  for (const config of API_CONFIGS) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/${config.version}/models/${config.model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.9,
              maxOutputTokens: 2048,
              topP: 0.95,
            }
          })
        }
      );

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        console.warn(`AI summary: ${config.model} failed:`, errData?.error?.message || response.status);
        continue;
      }

      const data = await response.json();
      const candidate = data?.candidates?.[0];
      const text = candidate?.content?.parts?.[0]?.text?.trim();
      const finishReason = candidate?.finishReason;

      if (finishReason === 'MAX_TOKENS') {
        console.warn(`AI summary: ${config.model} hit token limit — response truncated, retrying with next model`);
        continue;
      }

      if (text && text.length > 50) {
        console.log(`AI summary generated via ${config.model} (${text.length} chars, finishReason: ${finishReason})`);
        return text;
      }
      console.warn(`AI summary: ${config.model} returned empty/short response (${text?.length || 0} chars)`);
    } catch (err) {
      console.warn(`AI summary: ${config.model} error:`, err);
    }
  }

  throw new Error('All AI models failed to generate game summary');
};