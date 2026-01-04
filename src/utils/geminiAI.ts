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
  title: string;
  description: string;
  priority: number; // Higher = more interesting
}

/**
 * Generate top milestones for tonight's game
 * Returns the most interesting 7-10 milestones
 */
export const generateMilestones = (players: PlayerForecastData[]): MilestoneItem[] => {
  const milestones: MilestoneItem[] = [];
  
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
  
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const currentHalf = currentMonth < 6 ? 1 : 2;
  const halfStartMonth = currentHalf === 1 ? 0 : 6;
  const monthNames = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  const halfName = currentHalf === 1 ? 'H1' : 'H2';
  
  // Calculate period stats
  const playerPeriodStats = players.map(p => {
    const thisYearGames = p.gameHistory.filter(g => parseGameDate(g.date).getFullYear() === currentYear);
    const thisHalfGames = p.gameHistory.filter(g => {
      const d = parseGameDate(g.date);
      return d.getFullYear() === currentYear && d.getMonth() >= halfStartMonth && d.getMonth() < halfStartMonth + 6;
    });
    const thisMonthGames = p.gameHistory.filter(g => {
      const d = parseGameDate(g.date);
      return d.getFullYear() === currentYear && d.getMonth() === currentMonth;
    });
    
    return {
      ...p,
      yearProfit: thisYearGames.reduce((sum, g) => sum + g.profit, 0),
      yearGames: thisYearGames.length,
      halfProfit: thisHalfGames.reduce((sum, g) => sum + g.profit, 0),
      halfGames: thisHalfGames.length,
      monthProfit: thisMonthGames.reduce((sum, g) => sum + g.profit, 0),
      monthGames: thisMonthGames.length,
    };
  });
  
  const sortedByTotalProfit = [...players].sort((a, b) => b.totalProfit - a.totalProfit);
  const sortedByYearProfit = [...playerPeriodStats].sort((a, b) => b.yearProfit - a.yearProfit);
  
  // 1. WINNING STREAKS (show any streak of 3+)
  players.forEach(p => {
    if (p.currentStreak >= 3) {
      milestones.push({
        emoji: '🔥',
        title: `${p.name} ברצף נצחונות חם!`,
        description: `${p.name} נמצא כרגע ברצף של ${p.currentStreak} נצחונות רצופים. נצחון נוסף הלילה יאריך את הרצף ל-${p.currentStreak + 1} משחקים!`,
        priority: 85 + p.currentStreak * 2
      });
    }
  });
  
  // 2. LOSING STREAKS - Only show the WORST one (to avoid duplicates)
  const playersWithLoseStreak = players.filter(p => p.currentStreak <= -3);
  if (playersWithLoseStreak.length > 0) {
    // Sort by worst streak first
    const worstStreaker = [...playersWithLoseStreak].sort((a, b) => a.currentStreak - b.currentStreak)[0];
    milestones.push({
      emoji: '❄️',
      title: `${worstStreaker.name} ברצף הפסדים`,
      description: `${worstStreaker.name} נמצא ברצף של ${Math.abs(worstStreaker.currentStreak)} הפסדים רצופים - הכי ארוך בין המשתתפים הלילה! נצחון הלילה ישבור את הרצף השלילי.`,
      priority: 80 + Math.abs(worstStreaker.currentStreak) * 2
    });
  }
  
  // 2. LEADERBOARD PASSING (high priority)
  for (let i = 1; i < sortedByTotalProfit.length; i++) {
    const chaser = sortedByTotalProfit[i];
    const leader = sortedByTotalProfit[i - 1];
    const gap = Math.round(leader.totalProfit - chaser.totalProfit);
    const chaserRank = i + 1;
    const leaderRank = i;
    if (gap > 0 && gap <= 200) {
      milestones.push({
        emoji: '📈',
        title: `מרדף בטבלה הכללית (כל הזמנים)`,
        description: `${chaser.name} נמצא במקום ${chaserRank} בטבלה הכללית עם ${chaser.totalProfit >= 0 ? '+' : ''}${Math.round(chaser.totalProfit)}₪ כולל. ${leader.name} לפניו במקום ${leaderRank} עם ${leader.totalProfit >= 0 ? '+' : ''}${Math.round(leader.totalProfit)}₪. הפרש של ${gap}₪ בלבד - נצחון גדול הלילה יכול להעביר את ${chaser.name} מעל ${leader.name}!`,
        priority: 85 - i * 5
      });
    }
  }
  
  // 3. CLOSE BATTLES (high priority)
  for (let i = 0; i < sortedByTotalProfit.length; i++) {
    for (let j = i + 1; j < sortedByTotalProfit.length; j++) {
      const gap = Math.round(Math.abs(sortedByTotalProfit[i].totalProfit - sortedByTotalProfit[j].totalProfit));
      if (gap <= 30 && gap > 0) {
        milestones.push({
          emoji: '⚔️',
          title: 'קרב צמוד בטבלה הכללית!',
          description: `${sortedByTotalProfit[i].name} (${sortedByTotalProfit[i].totalProfit >= 0 ? '+' : ''}${Math.round(sortedByTotalProfit[i].totalProfit)}₪) ו-${sortedByTotalProfit[j].name} (${sortedByTotalProfit[j].totalProfit >= 0 ? '+' : ''}${Math.round(sortedByTotalProfit[j].totalProfit)}₪) נמצאים בהפרש של ${gap}₪ בלבד בטבלה הכללית של כל הזמנים. משחק הלילה יקבע מי מהם יהיה מעל השני!`,
          priority: 88
        });
      }
    }
  }
  
  // 4. EXACT TIES
  for (let i = 0; i < sortedByTotalProfit.length; i++) {
    for (let j = i + 1; j < sortedByTotalProfit.length; j++) {
      if (Math.round(sortedByTotalProfit[i].totalProfit) === Math.round(sortedByTotalProfit[j].totalProfit) && sortedByTotalProfit[i].totalProfit !== 0) {
        milestones.push({
          emoji: '🤝',
          title: 'תיקו מושלם בטבלה הכללית!',
          description: `${sortedByTotalProfit[i].name} ו-${sortedByTotalProfit[j].name} נמצאים בתיקו מושלם בטבלה הכללית של כל הזמנים - שניהם בדיוק ${sortedByTotalProfit[i].totalProfit >= 0 ? '+' : ''}${Math.round(sortedByTotalProfit[i].totalProfit)}₪! משחק הלילה ישבור את התיקו ויקבע מי מהם יעלה ומי ירד.`,
          priority: 92
        });
      }
    }
  }
  
  // 5. ROUND NUMBER MILESTONES - Only show ONE best candidate (closest to milestone)
  const roundNumbers = [500, 1000, 1500, 2000];
  const roundMilestoneCandidates: { player: typeof players[0], milestone: number, distance: number }[] = [];
  players.forEach(p => {
    for (const milestone of roundNumbers) {
      const distance = Math.round(milestone - p.totalProfit);
      if (distance > 0 && distance <= 150) {
        roundMilestoneCandidates.push({ player: p, milestone, distance });
        break; // Only one milestone per player
      }
    }
  });
  if (roundMilestoneCandidates.length > 0) {
    // Pick the closest to their milestone
    const bestRound = [...roundMilestoneCandidates].sort((a, b) => a.distance - b.distance)[0];
    milestones.push({
      emoji: '🎯',
      title: `יעד עגול בטבלה הכללית!`,
      description: `${bestRound.player.name} עומד כרגע על ${bestRound.player.totalProfit >= 0 ? '+' : ''}${Math.round(bestRound.player.totalProfit)}₪ בטבלה הכללית. חסרים לו רק ${bestRound.distance}₪ כדי לחצות את רף ה-+${bestRound.milestone}₪! נצחון טוב הלילה יכול להביא אותו לשם.`,
      priority: 75 + Math.round(bestRound.milestone / 100)
    });
  }
  
  // 6. THIS YEAR LEADERBOARD
  // DEBUG: Log year profit calculations
  console.log('🔍 DEBUG Year Profits:', sortedByYearProfit.map(p => ({
    name: p.name,
    yearProfit: Math.round(p.yearProfit),
    yearGames: p.yearGames,
    totalProfit: Math.round(p.totalProfit)
  })));
  
  for (let i = 1; i < Math.min(sortedByYearProfit.length, 4); i++) {
    const chaser = sortedByYearProfit[i];
    const leader = sortedByYearProfit[i - 1];
    const gap = Math.round(leader.yearProfit - chaser.yearProfit);
    const chaserRank = i + 1;
    const leaderRank = i;
    // Require at least 5 games for both players for year table comparison
    if (gap > 0 && gap <= 150 && chaser.yearGames >= 5 && leader.yearGames >= 5) {
      milestones.push({
        emoji: '📅',
        title: `מרדף בטבלת ${currentYear}!`,
        description: `${chaser.name} נמצא במקום ${chaserRank} בטבלת שנת ${currentYear} עם ${chaser.yearProfit >= 0 ? '+' : ''}${Math.round(chaser.yearProfit)}₪. ${leader.name} לפניו במקום ${leaderRank} עם ${leader.yearProfit >= 0 ? '+' : ''}${Math.round(leader.yearProfit)}₪. הפרש של ${gap}₪ - נצחון הלילה יכול לשנות את הדירוג השנתי!`,
        priority: 70
      });
    }
  }
  
  // 7. GAMES MILESTONES
  const gamesMilestones = [10, 25, 50, 75, 100, 150, 200];
  players.forEach(p => {
    for (const gm of gamesMilestones) {
      if (p.gamesPlayed === gm - 1) {
        const avgProfit = p.gamesPlayed > 0 ? Math.round(p.totalProfit / p.gamesPlayed) : 0;
        milestones.push({
          emoji: '🎮',
          title: `יובל משחקים ל-${p.name}!`,
          description: `הלילה זה המשחק ה-${gm} של ${p.name} עם הקבוצה! עד כה הוא שיחק ${p.gamesPlayed} משחקים עם ממוצע של ${avgProfit >= 0 ? '+' : ''}${avgProfit}₪ למשחק ורווח כולל של ${p.totalProfit >= 0 ? '+' : ''}${Math.round(p.totalProfit)}₪.`,
          priority: 65 + (gm / 10)
        });
        break;
      }
    }
  });
  
  // 8. WIN RATE MILESTONES - Only show ONE best candidate (closest to 60%)
  const winRateCandidates = players
    .filter(p => p.gamesPlayed >= 10)
    .filter(p => {
      const winsNeeded60 = Math.ceil(0.6 * (p.gamesPlayed + 1));
      return p.winCount === winsNeeded60 - 1 && p.winPercentage < 60;
    })
    .sort((a, b) => b.winPercentage - a.winPercentage); // Closest to 60% first
  if (winRateCandidates.length > 0) {
    const winRateCandidate = winRateCandidates[0];
    milestones.push({
      emoji: '🎯',
      title: `אחוז נצחונות - יעד 60%!`,
      description: `${winRateCandidate.name} נמצא כרגע על ${Math.round(winRateCandidate.winPercentage)}% נצחונות (${winRateCandidate.winCount} נצחונות מתוך ${winRateCandidate.gamesPlayed} משחקים). נצחון הלילה יעביר אותו מעל רף ה-60%!`,
      priority: 60
    });
  }
  
  // 9. RECOVERY TO POSITIVE - Only show ONE best candidate (closest to 0)
  const recoveryCandidate = playerPeriodStats
    .filter(p => p.yearProfit < 0 && p.yearProfit > -120 && p.yearGames >= 3)
    .sort((a, b) => b.yearProfit - a.yearProfit)[0]; // Closest to 0 first
  if (recoveryCandidate) {
    milestones.push({
      emoji: '🔄',
      title: `חזרה לפלוס בטבלת ${currentYear}!`,
      description: `${recoveryCandidate.name} נמצא כרגע ב-${Math.round(recoveryCandidate.yearProfit)}₪ בטבלת שנת ${currentYear} (אחרי ${recoveryCandidate.yearGames} משחקים השנה). נצחון של +${Math.round(Math.abs(recoveryCandidate.yearProfit))}₪ או יותר הלילה יחזיר אותו לרווח חיובי!`,
      priority: 72
    });
  }
  
  // 10. PLAYER OF THE MONTH
  const sortedByMonthProfit = [...playerPeriodStats].sort((a, b) => b.monthProfit - a.monthProfit);
  if (sortedByMonthProfit[0]?.monthGames >= 1 && sortedByMonthProfit[1]?.monthGames >= 1) {
    const leader = sortedByMonthProfit[0];
    const chaser = sortedByMonthProfit[1];
    const gap = Math.round(leader.monthProfit - chaser.monthProfit);
    if (gap <= 100) {
      milestones.push({
        emoji: '🏆',
        title: `מרדף על תואר "שחקן ${monthNames[currentMonth]}"!`,
        description: `בטבלת החודש הנוכחי (${monthNames[currentMonth]}): ${leader.name} מוביל עם ${leader.monthProfit >= 0 ? '+' : ''}${Math.round(leader.monthProfit)}₪, ו-${chaser.name} רודף אחריו עם הפרש של ${gap}₪ בלבד. נצחון גדול של ${chaser.name} הלילה יכול להפוך אותו לשחקן החודש!`,
        priority: 68
      });
    }
  }
  
  // 11. BIGGEST WIN RECORD - Only show the BEST candidate (one player)
  const biggestWin = Math.max(...players.map(p => p.bestWin));
  const recordHolder = players.find(p => p.bestWin === biggestWin);
  // Find the best candidate: on a streak, closest to record, has actual wins
  const bigWinCandidates = players
    .filter(p => p.currentStreak >= 2 && p.bestWin > 0 && p.bestWin < biggestWin && biggestWin - p.bestWin <= 100)
    .sort((a, b) => b.currentStreak - a.currentStreak); // Best streak first
  if (bigWinCandidates.length > 0) {
    const bestCandidate = bigWinCandidates[0];
    milestones.push({
      emoji: '💰',
      title: 'שיא הנצחון הגדול ביותר בלילה אחד!',
      description: `שיא הקבוצה לנצחון הגדול ביותר בלילה אחד הוא +${Math.round(biggestWin)}₪, שהושג על ידי ${recordHolder?.name}. ${bestCandidate.name} נמצא ברצף חם של ${bestCandidate.currentStreak} נצחונות - אם הוא ינצח גדול הלילה (מעל +${Math.round(biggestWin)}₪), הוא ישבור את השיא!`,
      priority: 78
    });
  }
  
  // 12. COMEBACK OPPORTUNITIES - Only for streak = -2 (streak -3+ already covered in Section 2)
  // Also only show ONE best candidate
  const comebackCandidates = players.filter(p => p.currentStreak === -2 && p.totalProfit > 100);
  if (comebackCandidates.length > 0) {
    const bestComeback = [...comebackCandidates].sort((a, b) => b.totalProfit - a.totalProfit)[0];
    milestones.push({
      emoji: '💪',
      title: `הזדמנות לקאמבק!`,
      description: `${bestComeback.name} נמצא ברצף של 2 הפסדים רצופים, אבל בטבלה הכללית הוא עדיין ברווח של +${Math.round(bestComeback.totalProfit)}₪. נצחון הלילה ישבור את הרצף!`,
      priority: 65
    });
  }
  
  // 13. HOT/COLD YEAR - Only show ONE player with biggest improvement
  const hotYearCandidates = playerPeriodStats
    .filter(p => p.yearGames >= 5 && p.gamesPlayed >= 10)
    .map(p => ({ ...p, yearAvg: p.yearProfit / p.yearGames, improvement: (p.yearProfit / p.yearGames) - p.avgProfit }))
    .filter(p => p.improvement > 40)
    .sort((a, b) => b.improvement - a.improvement);
  if (hotYearCandidates.length > 0) {
    const hotPlayer = hotYearCandidates[0];
    milestones.push({
      emoji: '📈',
      title: `השנה הכי טובה של ${hotPlayer.name}?`,
      description: `${hotPlayer.name} משחק השנה (${currentYear}) הרבה מעל הממוצע שלו! ממוצע רווח השנה: +${Math.round(hotPlayer.yearAvg)}₪ למשחק, לעומת ממוצע היסטורי של +${Math.round(hotPlayer.avgProfit)}₪ למשחק. אם הוא ימשיך ככה, זו תהיה השנה הכי טובה שלו אי פעם!`,
      priority: 62
    });
  }

  // ========== NEW: HALF-YEAR (H2) TRACKING ==========
  const halfLabel = currentHalf === 1 ? 'H1 (ינואר-יוני)' : 'H2 (יולי-דצמבר)';
  const halfLabelShort = currentHalf === 1 ? 'H1' : 'H2';
  const sortedByHalfProfit = [...playerPeriodStats].sort((a, b) => b.halfProfit - a.halfProfit);
  
  // 14. HALF-YEAR LEADERBOARD BATTLES
  for (let i = 1; i < Math.min(sortedByHalfProfit.length, 4); i++) {
    const chaser = sortedByHalfProfit[i];
    const leader = sortedByHalfProfit[i - 1];
    const gap = Math.round(leader.halfProfit - chaser.halfProfit);
    if (gap > 0 && gap <= 150 && chaser.halfGames >= 3 && leader.halfGames >= 3) {
      milestones.push({
        emoji: '📊',
        title: `מרדף בטבלת ${halfLabelShort} ${currentYear}!`,
        description: `בחצי השנה הנוכחי (${halfLabel}): ${chaser.name} במקום ${i + 1} עם ${chaser.halfProfit >= 0 ? '+' : ''}${Math.round(chaser.halfProfit)}₪, ו-${leader.name} לפניו במקום ${i} עם ${leader.halfProfit >= 0 ? '+' : ''}${Math.round(leader.halfProfit)}₪. הפרש של ${gap}₪ בלבד - נצחון הלילה יכול לשנות את הדירוג!`,
        priority: 75
      });
    }
  }

  // 15. HALF-YEAR LEADER HIGHLIGHT
  if (sortedByHalfProfit[0]?.halfGames >= 3) {
    const leader = sortedByHalfProfit[0];
    milestones.push({
      emoji: '👑',
      title: `מוביל ${halfLabelShort} ${currentYear}!`,
      description: `${leader.name} מוביל את טבלת ${halfLabel} עם ${leader.halfProfit >= 0 ? '+' : ''}${Math.round(leader.halfProfit)}₪ מתוך ${leader.halfGames} משחקים. עם סיום החצי שנה מתקרב, האם הוא ישמור על הכתר?`,
      priority: 70
    });
  }

  // ========== NEW: PREVIOUS YEAR/HALF SUMMARY (Early in new period) ==========
  const lastYear = currentYear - 1;
  
  // Calculate PREVIOUS year stats (for January summary)
  const previousYearStats = players.map(p => {
    const lastYearGames = p.gameHistory.filter(g => parseGameDate(g.date).getFullYear() === lastYear);
    return {
      ...p,
      lastYearProfit: lastYearGames.reduce((sum, g) => sum + g.profit, 0),
      lastYearGames: lastYearGames.length,
    };
  });
  
  // NEW YEAR "FRESH START" milestone (January with few games)
  if (currentMonth <= 1) { // January or February
    const totalYearGames = playerPeriodStats.reduce((sum, p) => sum + p.yearGames, 0);
    if (totalYearGames < 5) {
      milestones.push({
        emoji: '🎆',
        title: `שנת ${currentYear} מתחילה!`,
        description: `הטבלה השנתית מתאפסת! ${players.length} שחקנים מתחילים את ${currentYear} עם 0₪. מי יוביל את הטבלה החדשה? הכל פתוח!`,
        priority: 85
      });
    }
  }
  
  // NEW HALF "FRESH START" milestone (July with few games)
  if (currentMonth === 6 || currentMonth === 7) { // July or August (start of H2)
    const totalHalfGames = playerPeriodStats.reduce((sum, p) => sum + p.halfGames, 0);
    if (totalHalfGames < 5) {
      milestones.push({
        emoji: '🔄',
        title: `H2 ${currentYear} מתחיל!`,
        description: `חצי השנה השני מתחיל! טבלת H2 מתאפסת. מי יהיה אלוף החציון השני? ההיסטוריה נמחקת, הכל מתחיל מחדש.`,
        priority: 80
      });
    }
  }

  // In January: Show "2025 Final Results" summary
  if (currentMonth === 0) { // January
    const sortedByLastYearProfit = [...previousYearStats].sort((a, b) => b.lastYearProfit - a.lastYearProfit);
    const lastYearChampion = sortedByLastYearProfit[0];
    
    if (lastYearChampion && lastYearChampion.lastYearGames >= 5) {
      milestones.push({
        emoji: '🏆',
        title: `אלוף שנת ${lastYear}: ${lastYearChampion.name}!`,
        description: `${lastYearChampion.name} סיים את שנת ${lastYear} במקום הראשון עם ${lastYearChampion.lastYearProfit >= 0 ? '+' : ''}${Math.round(lastYearChampion.lastYearProfit)}₪ מתוך ${lastYearChampion.lastYearGames} משחקים! שנה חדשה, הכל מתאפס - מי יהיה אלוף ${currentYear}?`,
        priority: 90
      });
    }
    
    // Show how each player finished last year
    previousYearStats.forEach(p => {
      if (p.lastYearGames >= 5) {
        const rank = sortedByLastYearProfit.findIndex(x => x.name === p.name) + 1;
        if (rank <= 3 && rank > 1) {
          milestones.push({
            emoji: rank === 2 ? '🥈' : '🥉',
            title: `מקום ${rank} בשנת ${lastYear}`,
            description: `${p.name} סיים את ${lastYear} במקום ${rank} עם ${p.lastYearProfit >= 0 ? '+' : ''}${Math.round(p.lastYearProfit)}₪. השנה החדשה היא הזדמנות לשפר!`,
            priority: 85 - rank * 5
          });
        }
      }
    });
  }
  
  // In July: Show "H1 Final Results" summary
  if (currentMonth === 6) { // July (start of H2)
    const lastHalfLabel = 'H1 (ינואר-יוני)';
    // H1 is months 0-5, so we need to recalculate for H1
    const h1Stats = players.map(p => {
      const h1Games = p.gameHistory.filter(g => {
        const d = parseGameDate(g.date);
        return d.getFullYear() === currentYear && d.getMonth() < 6;
      });
      return {
        ...p,
        h1Profit: h1Games.reduce((sum, g) => sum + g.profit, 0),
        h1Games: h1Games.length,
      };
    });
    
    const sortedByH1 = [...h1Stats].sort((a, b) => b.h1Profit - a.h1Profit);
    const h1Champion = sortedByH1[0];
    
    if (h1Champion && h1Champion.h1Games >= 3) {
      milestones.push({
        emoji: '🏆',
        title: `אלוף ${lastHalfLabel} ${currentYear}!`,
        description: `${h1Champion.name} סיים את ${lastHalfLabel} במקום הראשון עם ${h1Champion.h1Profit >= 0 ? '+' : ''}${Math.round(h1Champion.h1Profit)}₪! עכשיו מתחיל H2 - הכל פתוח מחדש.`,
        priority: 85
      });
    }
  }

  // ========== NEW: YEAR-END SPECIAL (December) ==========
  if (currentMonth === 11) { // December
    // 16. YEAR-END SUMMARY - TOP PERFORMERS
    const sortedByYearProfit = [...playerPeriodStats].sort((a, b) => b.yearProfit - a.yearProfit);
    if (sortedByYearProfit[0]?.yearGames >= 5) {
      const yearLeader = sortedByYearProfit[0];
      milestones.push({
        emoji: '🏆',
        title: `אלוף שנת ${currentYear}?`,
        description: `${yearLeader.name} מוביל את טבלת ${currentYear} עם ${yearLeader.yearProfit >= 0 ? '+' : ''}${Math.round(yearLeader.yearProfit)}₪! עם סיום השנה מתקרב, זה המשחק האחרון להשפיע על הדירוג השנתי. האם מישהו יצליח לעקוף אותו?`,
        priority: 95 // Very high priority for year-end!
      });
    }

    // 17. YEAR-END BATTLES
    for (let i = 1; i < Math.min(sortedByYearProfit.length, 3); i++) {
      const chaser = sortedByYearProfit[i];
      const leader = sortedByYearProfit[i - 1];
      const gap = Math.round(leader.yearProfit - chaser.yearProfit);
      if (gap > 0 && gap <= 200 && chaser.yearGames >= 5 && leader.yearGames >= 5) {
        milestones.push({
          emoji: '⏰',
          title: `הזדמנות אחרונה לשנת ${currentYear}!`,
          description: `${chaser.name} (מקום ${i + 1}) עם ${chaser.yearProfit >= 0 ? '+' : ''}${Math.round(chaser.yearProfit)}₪ יכול לעקוף את ${leader.name} (מקום ${i}) עם ${leader.yearProfit >= 0 ? '+' : ''}${Math.round(leader.yearProfit)}₪. הפרש של ${gap}₪ - זו ההזדמנות האחרונה לטפס בטבלת ${currentYear}!`,
          priority: 90
        });
      }
    }

    // 18. YEAR-END REDEMPTION - Only show ONE best candidate (closest to 0, not already covered by Section 9)
    const yearEndCandidate = playerPeriodStats
      .filter(p => p.yearProfit < 0 && p.yearProfit > -200 && p.yearGames >= 5)
      .filter(p => p.yearProfit <= -120) // Only those NOT covered by Section 9 (which covers > -120)
      .sort((a, b) => b.yearProfit - a.yearProfit)[0]; // Closest to 0 first
    if (yearEndCandidate) {
      milestones.push({
        emoji: '🎯',
        title: `לסיים את ${currentYear} בפלוס?`,
        description: `${yearEndCandidate.name} נמצא ב-${Math.round(yearEndCandidate.yearProfit)}₪ לשנת ${currentYear}. נצחון גדול של +${Math.round(Math.abs(yearEndCandidate.yearProfit))}₪ הלילה יסגור את השנה ברווח! זו ההזדמנות האחרונה.`,
        priority: 85
      });
    }
  }

  // ========== NEW: ALL-TIME RECORDS ==========
  
  // 19. APPROACHING ALL-TIME BEST WIN RECORD - Only ONE candidate (with lower streak requirement than section 11)
  const allTimeBestWin = Math.max(...players.map(p => p.bestWin));
  const bestWinHolder = players.find(p => p.bestWin === allTimeBestWin);
  // Find candidates NOT covered by section 11 (streak = 1 only, since section 11 covers streak >= 2)
  const recordChasers = players
    .filter(p => p !== bestWinHolder && p.currentStreak === 1 && p.bestWin > 0 && allTimeBestWin - p.bestWin <= 150)
    .sort((a, b) => b.bestWin - a.bestWin); // Closest to record first
  if (recordChasers.length > 0) {
    const topChaser = recordChasers[0];
    milestones.push({
      emoji: '🎰',
      title: 'מרדף על שיא הנצחון הגדול!',
      description: `שיא הקבוצה לנצחון הגדול ביותר הוא +${Math.round(allTimeBestWin)}₪ (${bestWinHolder?.name}). השיא האישי של ${topChaser.name} הוא +${Math.round(topChaser.bestWin)}₪. נצחון גדול הלילה יכול לשבור את השיא!`,
      priority: 72
    });
  }

  // 20. LONGEST WIN STREAK RECORD
  const allTimeLongestWinStreak = Math.max(...players.map(p => p.currentStreak > 0 ? p.currentStreak : 0));
  if (allTimeLongestWinStreak >= 3) {
    const streakHolder = players.find(p => p.currentStreak === allTimeLongestWinStreak);
    if (streakHolder) {
      milestones.push({
        emoji: '🔥',
        title: 'רצף הנצחונות הארוך ביותר כרגע!',
        description: `${streakHolder.name} נמצא ברצף של ${allTimeLongestWinStreak} נצחונות רצופים - הרצף הארוך ביותר מבין כל השחקנים הלילה! נצחון נוסף יאריך את הרצף ל-${allTimeLongestWinStreak + 1}.`,
        priority: 80
      });
    }
  }

  // 21. LONGEST LOSE STREAK - REMOVED (now covered by Section 2 which picks the worst streaker)

  // ========== NEW: UNIQUE INSIGHTS ==========

  // 22. VOLATILITY ALERT - Only show the MOST volatile player
  const volatileCandidates = players
    .filter(p => p.gamesPlayed >= 10)
    .map(p => ({ ...p, volatility: p.bestWin + Math.abs(p.worstLoss) }))
    .filter(p => p.volatility >= 400)
    .sort((a, b) => b.volatility - a.volatility);
  if (volatileCandidates.length > 0) {
    const mostVolatile = volatileCandidates[0];
    milestones.push({
      emoji: '🎢',
      title: `${mostVolatile.name} - שחקן ההפתעות!`,
      description: `${mostVolatile.name} הוא השחקן הכי תנודתי: הנצחון הגדול שלו +${Math.round(mostVolatile.bestWin)}₪, ההפסד הגדול ${Math.round(mostVolatile.worstLoss)}₪. פער של ${Math.round(mostVolatile.volatility)}₪! הלילה יכול להיות כל דבר.`,
      priority: 58
    });
  }

  // 23. CONSISTENCY KING - Only show the MOST consistent player
  const consistentCandidates = players
    .filter(p => p.gamesPlayed >= 15 && p.winPercentage >= 55 && p.avgProfit > 0)
    .map(p => ({ ...p, consistency: Math.abs(p.bestWin - Math.abs(p.worstLoss)) }))
    .filter(p => p.consistency <= 100)
    .sort((a, b) => a.consistency - b.consistency); // Lowest consistency = most stable
  if (consistentCandidates.length > 0) {
    const mostConsistent = consistentCandidates[0];
    // Add variety to consistency descriptions
    const consistencyDescriptions = [
      `${mostConsistent.name} הוא השחקן הכי עקבי: ${Math.round(mostConsistent.winPercentage)}% נצחונות, ממוצע +${Math.round(mostConsistent.avgProfit)}₪ למשחק, עם סטיות קטנות. שחקן שקשה לנבא נגדו.`,
      `העקביות של ${mostConsistent.name} מדהימה: ${Math.round(mostConsistent.winPercentage)}% נצחונות ב-${mostConsistent.gamesPlayed} משחקים, ממוצע יציב של +${Math.round(mostConsistent.avgProfit)}₪. לא משאיר הרבה מקום להפתעות.`,
      `${mostConsistent.name} - המכונה היציבה של הקבוצה! ${Math.round(mostConsistent.winPercentage)}% נצחונות, ממוצע +${Math.round(mostConsistent.avgProfit)}₪ למשחק. תמיד יודע מה לצפות ממנו.`,
      `עם ${Math.round(mostConsistent.winPercentage)}% נצחונות ו-${mostConsistent.gamesPlayed} משחקים, ${mostConsistent.name} הוא הדוגמה המושלמת לעקביות. ממוצע של +${Math.round(mostConsistent.avgProfit)}₪ למשחק - יציב כמו סלע.`,
      `${mostConsistent.name} מחזיק בשיא העקביות: ${Math.round(mostConsistent.winPercentage)}% נצחונות, ממוצע +${Math.round(mostConsistent.avgProfit)}₪ למשחק. שחקן שאפשר לסמוך עליו.`
    ];
    // Use player name hash for consistent variety (same player gets same description each time)
    const nameHash = mostConsistent.name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const description = consistencyDescriptions[nameHash % consistencyDescriptions.length];
    
    milestones.push({
      emoji: '🎯',
      title: `${mostConsistent.name} - מלך העקביות!`,
      description,
      priority: 55
    });
  }

  // 24. HEAD-TO-HEAD RIVALRY (if exactly 2 players very close)
  if (players.length >= 2) {
    const sorted = [...players].sort((a, b) => b.totalProfit - a.totalProfit);
    for (let i = 0; i < sorted.length - 1; i++) {
      const gap = Math.abs(sorted[i].totalProfit - sorted[i + 1].totalProfit);
      if (gap <= 50 && sorted[i].gamesPlayed >= 10 && sorted[i + 1].gamesPlayed >= 10) {
        milestones.push({
          emoji: '⚔️',
          title: 'יריבות היסטורית!',
          description: `${sorted[i].name} ו-${sorted[i + 1].name} נמצאים בפער של ${Math.round(gap)}₪ בלבד בטבלה הכללית של כל הזמנים! שנים של משחקים והם עדיין צמודים. הלילה יקבע מי יוביל.`,
          priority: 82
        });
        break; // Only show one rivalry
      }
    }
  }

  // 25. TOTAL GAMES MILESTONE FOR GROUP
  const totalGroupGames = players.reduce((sum, p) => sum + p.gamesPlayed, 0);
  const groupMilestones = [100, 200, 300, 500, 750, 1000];
  for (const gm of groupMilestones) {
    if (totalGroupGames >= gm - 10 && totalGroupGames < gm) {
      milestones.push({
        emoji: '🎊',
        title: `הקבוצה מתקרבת ל-${gm} משחקים!`,
        description: `השחקנים הלילה שיחקו ביחד ${totalGroupGames} משחקים. עוד ${gm - totalGroupGames} משחקים וזה יהיה המשחק ה-${gm} של הקבוצה! אבן דרך משמעותית.`,
        priority: 60
      });
      break;
    }
  }
  
  // Sort by priority and return 7-10 most interesting milestones
  // Don't force to 10 - only show truly interesting ones
  milestones.sort((a, b) => b.priority - a.priority);
  
  // Take top 10 but filter out low-priority ones (below 50)
  const topMilestones = milestones.filter(m => m.priority >= 50).slice(0, 10);
  
  // If we have less than 7, take some lower priority ones
  if (topMilestones.length < 7) {
    const remaining = milestones.filter(m => m.priority < 50).slice(0, 7 - topMilestones.length);
    topMilestones.push(...remaining);
  }
  
  // Clean up any decimal numbers in descriptions
  const cleanMilestones = topMilestones.slice(0, 10).map(m => ({
    ...m,
    description: m.description.replace(/(\d+)\.(\d+)/g, (match) => Math.round(parseFloat(match)).toString())
  }));
  
  return cleanMilestones;
};

/**
 * Generate AI-powered forecasts for selected players only
 */
export const generateAIForecasts = async (
  players: PlayerForecastData[]
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
      name: p.name,
      // This year
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
      // Original data
      ...p
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

  // Calculate SUGGESTED expected profit for each player (70% recent, 30% overall + streaks)
  const playerSuggestions = players.map(p => {
    // Recent average (last 5 games)
    const last5 = p.gameHistory.slice(0, 5);
    const recentAvg = last5.length > 0 ? last5.reduce((sum, g) => sum + g.profit, 0) / last5.length : 0;
    
    // Weighted score: 70% recent, 30% overall (if has recent data)
    let suggested = p.gamesPlayed === 0 ? 0 : 
      last5.length >= 3 ? (recentAvg * 0.7) + (p.avgProfit * 0.3) : p.avgProfit;
    
    // Apply streak modifiers
    if (p.currentStreak >= 4) suggested *= 1.5;
    else if (p.currentStreak >= 3) suggested *= 1.35;
    else if (p.currentStreak >= 2) suggested *= 1.2;
    else if (p.currentStreak <= -4) suggested *= 0.5;
    else if (p.currentStreak <= -3) suggested *= 0.65;
    else if (p.currentStreak <= -2) suggested *= 0.8;
    
    return { name: p.name, suggested: Math.round(suggested) };
  });
  
  // Balance suggestions to zero-sum
  const totalSuggested = playerSuggestions.reduce((sum, p) => sum + p.suggested, 0);
  const adjustment = totalSuggested / playerSuggestions.length;
  playerSuggestions.forEach(p => p.suggested = Math.round(p.suggested - adjustment));
  
  // Pre-select SURPRISE candidates (recent contradicts overall)
  const surpriseCandidates = players.filter(p => {
    if (p.gamesPlayed < 5) return false;
    const last5 = p.gameHistory.slice(0, 5);
    if (last5.length < 3) return false;
    
    const recentAvg = last5.reduce((sum, g) => sum + g.profit, 0) / last5.length;
    const overallPositive = p.avgProfit > 10;
    const overallNegative = p.avgProfit < -10;
    const recentPositive = recentAvg > 10;
    const recentNegative = recentAvg < -10;
    
    // Contradiction: good player doing badly recently, or bad player doing well recently
    return (overallPositive && recentNegative) || (overallNegative && recentPositive);
  });
  
  // Pick 1-2 surprises (at least 1 if candidates exist)
  const maxSurprises = Math.min(Math.ceil(players.length * 0.35), surpriseCandidates.length);
  const numSurprises = surpriseCandidates.length > 0 ? Math.max(1, Math.floor(Math.random() * (maxSurprises + 1))) : 0;
  const selectedSurprises = surpriseCandidates
    .sort(() => Math.random() - 0.5)
    .slice(0, numSurprises)
    .map(p => p.name);
  
  const surpriseText = selectedSurprises.length > 0 
    ? `\n🎲 PRE-SELECTED SURPRISES: ${selectedSurprises.join(', ')}\n   Mark these players with isSurprise: true and FLIP their expected profit!`
    : '\n🎲 NO GOOD SURPRISE CANDIDATES (recent matches overall for all players)';
  
  // Build the prompt with FULL player data (in English for better AI reasoning)
  const playerDataText = players.map((p, i) => {
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
    
    // Only call it a "streak" if 2+ consecutive wins/losses
    const streakText = p.currentStreak >= 2 
      ? `🔥 HOT STREAK: ${p.currentStreak} consecutive wins!` 
      : p.currentStreak <= -2 
        ? `❄️ COLD STREAK: ${Math.abs(p.currentStreak)} consecutive losses` 
        : p.currentStreak === 1
          ? `📈 Won last game`
          : p.currentStreak === -1
            ? `📉 Lost last game`
            : '⚪ Last game was break-even';
    
    // Combine streak with explicit last game (to prevent AI confusion)
    const lastGameInfo = `LAST GAME: ${lastGameResult} (${lastGame?.date || 'N/A'})`;
    
    // Calculate year stats
    const thisYearGames = p.gameHistory.filter(g => parseGameDate(g.date).getFullYear() === currentYear);
    const yearProfit = thisYearGames.reduce((sum, g) => sum + g.profit, 0);
    const yearGames = thisYearGames.length;
    
    // Get recent average
    const last5 = p.gameHistory.slice(0, 5);
    const recentAvg = last5.length > 0 ? Math.round(last5.reduce((sum, g) => sum + g.profit, 0) / last5.length) : 0;
    
    // Get suggested expected profit
    const suggestion = playerSuggestions.find(s => s.name === p.name)?.suggested || 0;
    
    // DEBUG: Log year profit calculation
    console.log(`🔍 ${p.name}: ${yearGames} games in ${currentYear}, Year Profit: ${yearProfit >= 0 ? '+' : ''}${Math.round(yearProfit)}₪, Total Profit: ${p.totalProfit >= 0 ? '+' : ''}${Math.round(p.totalProfit)}₪`);
    
    // Format game history
    const gameHistoryText = p.gameHistory.length > 0
      ? p.gameHistory.slice(0, 10).map(g => `${g.date}: ${g.profit >= 0 ? '+' : ''}${Math.round(g.profit)}₪`).join(' | ')
      : 'New player - no history';
    
    // Determine rank in tonight's players
    const rankAllTime = sortedByTotalProfit.findIndex(sp => sp.name === p.name) + 1;

    // Calculate current half stats
    const halfStartMonth = currentHalf === 1 ? 0 : 6;
    const thisHalfGames = p.gameHistory.filter(g => {
      const d = parseGameDate(g.date);
      return d.getFullYear() === currentYear && d.getMonth() >= halfStartMonth && d.getMonth() < halfStartMonth + 6;
    });
    const halfProfit = thisHalfGames.reduce((sum, g) => sum + g.profit, 0);
    const halfGamesCount = thisHalfGames.length;

    return `
═══════════════════════════════════════
PLAYER ${i + 1}: ${p.name.toUpperCase()} ${p.isFemale ? '👩 (FEMALE - use feminine Hebrew!)' : '👨 (Male)'}
═══════════════════════════════════════

🎯 SUGGESTED EXPECTED PROFIT: ${suggestion >= 0 ? '+' : ''}${suggestion}₪
   You can adjust ±30₪ based on your analysis, but stay close to this!

⭐ CURRENT YEAR ${currentYear} (MOST IMPORTANT - FOCUS ON THIS!):
   • GAMES THIS YEAR: ${yearGames}
   • PROFIT THIS YEAR: ${yearProfit >= 0 ? '+' : ''}${Math.round(yearProfit)}₪
   ${yearGames > 0 ? `• AVG THIS YEAR: ${(yearProfit >= 0 ? '+' : '') + Math.round(yearProfit / yearGames)}₪/game` : ''}
   • ${streakText}
   • ${lastGameInfo} ← USE THIS EXACT DATA!${comebackText ? `
   • ${comebackText}` : ''}

📅 CURRENT HALF (H${currentHalf} ${currentYear}):
   • GAMES THIS HALF: ${halfGamesCount}
   • PROFIT THIS HALF: ${halfProfit >= 0 ? '+' : ''}${Math.round(halfProfit)}₪

📈 RECENT FORM (Last 5 games):
   • AVG: ${recentAvg >= 0 ? '+' : ''}${recentAvg}₪/game
   ${recentAvg > p.avgProfit + 10 ? '⬆️ IMPROVING' : 
     recentAvg < p.avgProfit - 10 ? '⬇️ DECLINING' : 
     '➡️ STABLE'}

📊 ALL-TIME (use only for dramatic milestones like "about to reach 10,000₪ total"):
   • RANK: #${rankAllTime}/${players.length} tonight
   • TOTAL: ${p.totalProfit >= 0 ? '+' : ''}${Math.round(p.totalProfit)}₪
   • GAMES: ${p.gamesPlayed}

📜 LAST 10 GAMES:
   ${gameHistoryText}`;
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
  
  const prompt = `You are the "Master of Poker Analytics," a legendary sports commentator turned data scientist. Your job is to analyze the game history and all-time records of a private poker group to generate a sharp, humorous, and data-driven prediction for tonight's game.

📋 TL;DR - THE 7 RULES YOU MUST FOLLOW:
1. Use SUGGESTED expected profits for each player (±30₪ max deviation)
2. Mark PRE-SELECTED surprise players with isSurprise: true (see below)
3. Sum of all expectedProfits MUST = 0 exactly
4. Tone must match profit (positive=optimistic, negative=cautious)
5. Each sentence must start differently (use variety patterns below)
6. FOCUS ON CURRENT YEAR/HALF in sentences - only mention all-time for dramatic milestones!
7. 🚫 NEVER MAKE UP DATA! Use ONLY the "LAST GAME" and streak info provided for each player!
${surpriseText}

🚨🚨🚨 CRITICAL ACCURACY WARNING 🚨🚨🚨
YOU MUST BE 100% ACCURATE! Every single fact in your response MUST match the data below EXACTLY.

BEFORE writing ANYTHING about a player, you MUST:
1. Check their EXACT streak number (if no streak, don't claim one!)
2. Check their EXACT rank (#1 is first place - don't say they "want to reach" a position they already have!)
3. Check their EXACT year profit (if it's negative, don't say positive things about their year!)
4. Use ONLY the numbers provided below - DO NOT invent or estimate numbers!

COMMON ERRORS TO AVOID:
❌ Saying someone has "5 consecutive wins" when their streak is different
❌ Saying #1 ranked player "wants to reach first place" (they're already there!)
❌ Mixing up ALL-TIME profit with YEAR profit (check both sections!)
❌ Saying someone needs X₪ to reach a milestone when they've already passed it
❌ Claiming positive year when their YEAR ${currentYear} PROFIT is negative!

IF YOU'RE NOT 100% SURE ABOUT A FACT, DON'T WRITE IT!
🚨🚨🚨 END OF ACCURACY WARNING 🚨🚨🚨

📊 RAW PLAYER DATA (READ CAREFULLY - ONLY USE THESE EXACT NUMBERS!):
${playerDataText}

🏆 ALL-TIME RECORDS:
${allTimeRecordsText}
${milestonesText ? `
🎯 TONIGHT'S MILESTONES & RECORDS AT STAKE:
${milestonesText}

⭐ USE THESE MILESTONES IN YOUR SENTENCES! They're GOLD for engagement!

📅 TIME PERIOD LABELS (use these in Hebrew):
   - "כולל" / "בסך הכל" = all-time total
   - "השנה" / "ב-${currentYear}" = this year
   - "בחצי ${currentHalf === 1 ? 'הראשון' : 'השני'}" = this half (H${currentHalf})
   - "ב${monthNames[currentMonth]}" = this month
   - "ב-X משחקים אחרונים" = last X games
   
   ❌ WRONG: "אייל צריך להגיע ל-1500" (unclear!)
   ✅ RIGHT: "אייל עומד על +1420₪ השנה. עוד 80₪ הלילה = +1500₪ לשנת ${currentYear}!"
   ✅ RIGHT: "מור מובילה את החצי השני עם +350₪. הלילה היא נלחמת על התואר!"` : ''}

═══════════════════════════════════════

🎯 THE MISSION:
USE THE SUGGESTED EXPECTED PROFIT for each player (marked with 🎯 in their data).
These suggestions are pre-calculated using: 70% recent performance + 30% overall + streak bonuses.
You can adjust ±30₪ if you have strong reasoning, but STAY CLOSE to the suggestions!
The sum of all expectedProfits must equal exactly 0. Cross-reference their current form with their Legacy to create a unique narrative.

═══════════════════════════════════════

💰 EXPECTED PROFIT CALIBRATION (VERY IMPORTANT!):

📈 ACTUAL STATISTICS FROM THIS GROUP:
- Average absolute profit per player per game: ${avgAbsProfit}₪
- Median absolute profit: ${medianAbsProfit}₪
- Biggest win ever: +${maxProfit}₪
- Biggest loss ever: ${minProfit}₪

📋 RECENT GAME EXAMPLES (this is how games ACTUALLY end):
${recentGameExamples}

⚠️ YOUR expectedProfit VALUES MUST BE REALISTIC:
- Minimum absolute value should be around ${Math.max(50, Math.round(avgAbsProfit * 0.5))}₪
- Typical range: ±${Math.round(avgAbsProfit)}₪ to ±${Math.round(avgAbsProfit * 1.5)}₪
- For volatile players (check their bestWin/worstLoss): can go up to ±${Math.round(avgAbsProfit * 2)}₪

❌ WRONG: expectedProfit values like +30, -40, +25 (too small!)
✅ CORRECT: expectedProfit values like +120, -95, +150, -180 (realistic!)

═══════════════════════════════════════

🛠️ WRITING RULES (CRITICAL):

1. **🚨 FACTUAL ACCURACY (MOST IMPORTANT!)**: NEVER make up or guess data!
   - The "LAST GAME" line shows the EXACT result - USE IT!
   - If it says "WON +50₪", DO NOT say they lost!
   - If it says "LOST -80₪", DO NOT say they won!
   - When in doubt, just state the data as given.

2. **The Legacy Factor**: Use all-time records to praise or sting.

3. **Data-Backed Insights**: Use specific dates, percentages, and amounts from the data provided.

4. **MILESTONES ARE GOLD**: If a player has a milestone opportunity, MENTION IT in their sentence! 

5. **Style & Tone**: Witty, slightly cynical, dramatic. Each sentence should be screenshot-worthy for WhatsApp.

6. **Language**: Output (highlight and sentence) MUST be in HEBREW.

═══════════════════════════════════════

🎭 SPECIAL PLAYER HANDLING:

• **תומר (Tomer)**: Be KIND with your wording, but NEVER invent positive facts! 
  - If his stats are negative, you MUST still report them accurately
  - Don't say "רווח של +X" if his actual profit is negative!
  - You can be encouraging about REAL things like: "מחפש לשבור את הרצף" or "הלילה הזדמנות לשיפור"
  - NEVER make up positive numbers or fake achievements!

═══════════════════════════════════════

🚫🚫🚫 CRITICAL: VARIETY IS MANDATORY! 🚫🚫🚫

❌ FORBIDDEN PATTERNS - NEVER USE THESE MORE THAN ONCE:
- "במקום ה-X הכללי..." (BANNED as a sentence opener!)
- "מוביל/מובילה את הטבלה..." 
- "עם ממוצע של..."
- "רצף נצחונות/הפסדים של..."
- Starting sentences the same way!

🎨 EACH PLAYER MUST START WITH A DIFFERENT STYLE:

Player 1: START WITH THEIR NAME + action verb
   → "ליאור שורף את הטבלה..." / "חרדון טס על כנפי רצף..."
   
Player 2: START WITH A DRAMATIC QUESTION  
   → "האם הלילה הוא ישבור את הרצף?" / "מי יעצור אותו?"
   
Player 3: START WITH A STAT/NUMBER + context
   → "45 משחקים, 67₪ ממוצע, מקום ראשון." / "3 נצחונות רצופים."
   
Player 4: START WITH "הלילה" or time reference
   → "הלילה הוא מחפש..." / "אחרי הפסד כואב..."
   
Player 5: START WITH A METAPHOR or imagery
   → "הרכבת יוצאת מהתחנה..." / "הפניקס קם מהאפר..."
   
Player 6: START WITH "אם" (if) - conditional/milestone
   → "אם ייקח הלילה 100₪..." / "עוד נצחון אחד ו..."
   
Player 7: START WITH rivalry/comparison
   → "הקרב נגד X נמשך..." / "בעוד X עולה, הוא..."

🎭 EACH SENTENCE NEEDS A UNIQUE ANGLE:
- One about STREAK (winning/losing)
- One about RIVALRY (vs specific player)
- One about MILESTONE (passing someone/reaching number)
- One about COMEBACK story
- One about CONSISTENCY/reliability
- One about VOLATILITY (big swings)
- One about FORM vs LEGACY conflict

📝 BEFORE SUBMITTING: Read all sentences aloud. If ANY two sound similar → REWRITE!

═══════════════════════════════════════

📝 OUTPUT FORMAT (JSON ONLY):
[
  {
    "name": "Player Name",
    "expectedProfit": number (REALISTIC based on their historical range!),
    "highlight": "Short data-driven stat in Hebrew (up to 10 words)",
    "sentence": "Unique analysis in Hebrew (25-40 words) - MUST MATCH expectedProfit tone!",
    "isSurprise": boolean
  }
]

🚨 SENTENCE RULES! 🚨

1. TONE must match prediction (positive profit = optimistic tone, negative = cautious tone)

2. 🚫 NEVER mention the expectedProfit number in the sentence!
   - The profit number is ALREADY shown in the header (+₪112, -₪9, etc.)
   - Repeating it is redundant and wastes valuable sentence space
   - Focus INSTEAD on: stats, streaks, milestones, rivalries, comebacks, or interesting stories
   - Use your sentence to provide CONTEXT and INSIGHT, not repeat what's already visible
   
3. ❌ FORBIDDEN: Do NOT write sentences like:
   - "מצופה שיביא 1120 רווח הלילה" ← The number is already in the header!
   - "צפוי להמשיך את המומנטום החיובי עם רווח של 4" ← Redundant!
   - "מצופה שיגדיל את הונו ב-27 הלילה" ← Number already shown!
   
4. ✅ CORRECT: Write sentences like:
   - "חזרה חזקה אחרי חודש היעדרות, ממוצע מרשים של 1250 ב-5 המשחקים האחרונים בטבלה הכללית"
   - "מקום שני בטבלה הכללית, שואף לשבור את הרצף השלילי ולהתחיל את שנת 2026 בסטייל"
   - "רצף 2 ניצחונות והובלה של 97 בטבלת ינואר, צפוי להמשיך את המומנטום החיובי"
   - "רצף 4 הפסדים ב-2026, מתקרב מסוכנת לסף המינוס של 2000₪ בטבלה הכללית"

5. 🚨 CRITICAL: EVERY NUMBER NEEDS CONTEXT! 🚨
   When you mention ANY number (profit, average, milestone, position), you MUST specify:
   - WHICH TABLE: "בטבלה הכללית" (all-time) / "בטבלת ${new Date().getFullYear()}" (year) / "החודש" (month)
   - WHAT TIMEFRAME: "כולל מאז שהתחלנו" / "השנה" / "ב-5 משחקים אחרונים"
   
   ❌ WRONG - NO CONTEXT:
   - "ממוצע של -7₪" ← -7 where? all-time? this year? last 5 games?
   - "שואף לחצות את רף ה-2000₪" ← 2000 in which table?
   - "500₪ רווח" ← 500 total? this year? this month?
   
   ✅ CORRECT - WITH CONTEXT:
   - "ממוצע של -7₪ למשחק בטבלה הכללית (כל הזמנים)"
   - "שואף לחצות את רף ה-2000₪ בטבלה הכללית של כל הזמנים"
   - "500₪ רווח בטבלת שנת 2025"
   - "ממוצע של +67₪ למשחק ב-10 המשחקים האחרונים"

═══════════════════════════════════════

💡 EXAMPLES OF QUALITY (WITH FULL CONTEXT):

⚠️ EVERY NUMBER MUST HAVE CONTEXT! Use these phrases:
- "בטבלה הכללית (כל הזמנים)" = all-time leaderboard
- "בטבלת שנת 2025" = this year's table
- "החודש" = this month
- "ב-X משחקים אחרונים" = last X games
- "ממוצע היסטורי" = historical average
- "מאז שהתחלנו לשחק" = since we started playing

📊 VARIETY EXAMPLES - EACH SENTENCE STARTS DIFFERENTLY:

✅ PLAYER 1 - Start with NAME + action verb:
   "ליאור שורף את הטבלה! 4 נצחונות רצופים בטבלה הכללית, ממוצע של +67₪ למשחק, והוא לא מראה סימני האטה."

✅ PLAYER 2 - Start with QUESTION:
   "האם חרדון יצליח לשבור את קללת דצמבר? 3 הפסדים רצופים בטבלת 2025, אבל ההיסטוריה שלו מדברת אחרת."

✅ PLAYER 3 - Start with STAT/NUMBER (NOT profit, but milestone/position):
   "1806₪ בטבלת 2025. דן מאן על גל, וצריך רק 200₪ הלילה כדי לחצות את רף ה-2000₪ השנתי!"

✅ PLAYER 4 - Start with "הלילה" or time:
   "הלילה תומר מחפש לשבור רצף של 3 הפסדים. אחרי הפסד כואב במשחק האחרון, זה הזמן לתפנית."

✅ PLAYER 5 - Start with METAPHOR:
   "הפניקס קם מהאפר! אחרי חודש קשה, ליכטר חוזר עם 2 נצחונות רצופים בטבלה הכללית."

✅ PLAYER 6 - Start with "אם" (conditional - milestone, NOT expectedProfit):
   "אם סגל יעקוף את אייל הלילה, הוא יעלה למקום 3 בטבלה הכללית של כל הזמנים!"

✅ PLAYER 7 - Start with RIVALRY:
   "הקרב נגד ליאור נמשך! אייל צריך נצחון גדול הלילה כדי לסגור את הפער של 150₪ בטבלת 2025."

❌ WRONG - MENTIONING EXPECTED PROFIT (REDUNDANT):
   "מצופה שיביא 1120 רווח הלילה" ← The number is already in the header!
   "צפוי להמשיך עם רווח של 4" ← Redundant!
   "מצופה שיגדיל את הונו ב-27 הלילה" ← Number already shown!
   "שואף להתחיל את 2026 עם רווח של 31₪" ← Don't repeat the header number!

❌ WRONG - NUMBER MISMATCH:
   expectedProfit: +34 but sentence says "31₪" ← FORBIDDEN! If you mention a number, it MUST match exactly!

❌ WRONG - NO CONTEXT:
   "שואף לחצות את רף ה-2000₪" ← חסר: "בטבלה הכללית"
   "ממוצע של -7₪" ← חסר: "בטבלה הכללית (כל הזמנים)" או "ב-10 משחקים אחרונים"
   "500₪ רווח לשנה" ← לא ברור, צריך: "בטבלת שנת 2025"
   "85₪ הפרש" ← חסר: "בטבלה הכללית" או באיזו טבלה

❌ WRONG - TONE MISMATCH:
   expectedProfit: +100 with "לילה קשה צפוי" ← FORBIDDEN!

═══════════════════════════════════════

⚠️ HARD CONSTRAINTS (MUST FOLLOW):

1. Gender: 'מור' is Female (נקבה). All others are Male (זכר).

2. Math: Sum of all expectedProfit = 0 exactly.

3. 🎲 SURPRISES: Use the PRE-SELECTED surprises from the TL;DR section above.
   For surprise players: set isSurprise: true and FLIP their expectedProfit to opposite sign.

4. PROFIT RANGE CHECK: Before submitting, verify that:
   - At least ONE player has |expectedProfit| ≥ ${Math.round(avgAbsProfit * 1.2)}₪
   - NO player has |expectedProfit| < ${Math.max(30, Math.round(avgAbsProfit * 0.4))}₪ (too small!)
   - The spread between highest winner and biggest loser should be ≥ ${Math.round(avgAbsProfit * 2)}₪

5. SENTENCE MUST MATCH expectedProfit:
   - Positive profit → optimistic tone (e.g., "חזרה חזקה", "מומנטום חיובי", "שואף לטפס")
   - Negative profit → cautious tone (e.g., "מתקרב מסוכנת", "רצף הפסדים", "מחפש לשבור")
   - 🚫 NEVER mention the expectedProfit number itself - focus on the story behind it!

Return ONLY a clean JSON array. No markdown, no explanation.`;

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
            temperature: 0.6,  // Lower = more accurate, less random
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