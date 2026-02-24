/**
 * Forecast Sentence Generator
 * Generates unique, varied sentences for each player based on their data
 * This is 100% code-generated - no AI involvement in text creation
 */

interface PlayerContext {
  name: string;
  isFemale: boolean;
  gamesPlayed: number;
  totalProfit: number;
  avgProfit: number;
  currentStreak: number;
  lastGameProfit: number;
  daysSinceLastGame: number;
  rankTonight: number;
  totalPlayers: number;
  periodAvg: number;
  periodGames: number;
  expectedProfit: number;
}

interface GeneratedContent {
  highlight: string;
  sentence: string;
}

// Hebrew gender forms
const getGenderForms = (isFemale: boolean) => ({
  he: isFemale ? 'היא' : 'הוא',
  his: isFemale ? 'שלה' : 'שלו',
  looking: isFemale ? 'מחפשת' : 'מחפש',
  wants: isFemale ? 'רוצה' : 'רוצה',
  came: isFemale ? 'באה' : 'בא',
  hot: isFemale ? 'חמה' : 'חם',
  ready: isFemale ? 'מוכנה' : 'מוכן',
  knows: isFemale ? 'יודעת' : 'יודע',
  will: isFemale ? 'תצליח' : 'יצליח',
  can: isFemale ? 'יכולה' : 'יכול',
  wants2: isFemale ? 'רוצה' : 'רוצה',
  player: isFemale ? 'שחקנית' : 'שחקן',
});

// Story types - each player gets assigned ONE type based on their index
type StoryType = 
  | 'streak_focus'      // Focus on winning/losing streak
  | 'last_game_focus'   // Focus on last game result
  | 'comeback_focus'    // Focus on returning after break
  | 'ranking_focus'     // Focus on table position
  | 'history_focus'     // Focus on all-time record
  | 'momentum_focus'    // Focus on recent form vs history
  | 'prediction_focus'  // Focus on the prediction itself
  | 'personality_focus' // Focus on playing style
  | 'challenge_focus'   // Focus on what they need to prove
  | 'rivalry_focus';    // Focus on competition with others

const STORY_TYPES: StoryType[] = [
  'streak_focus',
  'last_game_focus', 
  'comeback_focus',
  'ranking_focus',
  'history_focus',
  'momentum_focus',
  'prediction_focus',
  'personality_focus',
  'challenge_focus',
  'rivalry_focus',
];

/**
 * Generate highlight and sentence for a player
 * Uses playerIndex to ensure different story types for different players
 */
export const generateForecastContent = (
  ctx: PlayerContext,
  playerIndex: number,
  allPlayers: PlayerContext[]
): GeneratedContent => {
  const g = getGenderForms(ctx.isFemale);
  
  // Assign story type based on player index (guarantees variety)
  const storyType = STORY_TYPES[playerIndex % STORY_TYPES.length];
  
  // Generate based on story type AND player data
  switch (storyType) {
    case 'streak_focus':
      return generateStreakFocus(ctx, g, playerIndex);
    case 'last_game_focus':
      return generateLastGameFocus(ctx, g, playerIndex);
    case 'comeback_focus':
      return generateComebackFocus(ctx, g, playerIndex);
    case 'ranking_focus':
      return generateRankingFocus(ctx, g, playerIndex, allPlayers);
    case 'history_focus':
      return generateHistoryFocus(ctx, g, playerIndex);
    case 'momentum_focus':
      return generateMomentumFocus(ctx, g, playerIndex);
    case 'prediction_focus':
      return generatePredictionFocus(ctx, g, playerIndex);
    case 'personality_focus':
      return generatePersonalityFocus(ctx, g, playerIndex);
    case 'challenge_focus':
      return generateChallengeFocus(ctx, g, playerIndex);
    case 'rivalry_focus':
      return generateRivalryFocus(ctx, g, playerIndex, allPlayers);
    default:
      return generateDefaultFocus(ctx, g, playerIndex);
  }
};

// ============ STORY TYPE GENERATORS ============

function generateStreakFocus(ctx: PlayerContext, g: ReturnType<typeof getGenderForms>, idx: number): GeneratedContent {
  const { currentStreak, lastGameProfit } = ctx;
  
  if (currentStreak >= 3) {
    const highlights = [
      `🔥 ${currentStreak} נצחונות ברצף`,
      `רצף חם: ${currentStreak} נצחונות`,
      `${currentStreak} ברצף! 🔥`,
    ];
    const sentences = [
      `המומנטום לוהט, קשה לעצור אותו.`,
      `הרצף הזה לא נגמר בקלות.`,
      `כשהביטחון גבוה, הנצחונות באים.`,
      `${currentStreak} ברצף זה לא מקרה.`,
    ];
    return {
      highlight: highlights[idx % highlights.length],
      sentence: sentences[idx % sentences.length],
    };
  }
  
  if (currentStreak <= -3) {
    const highlights = [
      `${Math.abs(currentStreak)} הפסדים ברצף`,
      `רצף קשה: ${Math.abs(currentStreak)} הפסדים`,
      `📉 ${Math.abs(currentStreak)} ברצף`,
    ];
    const sentences = [
      `הרצף חייב להישבר מתישהו.`,
      `${g.looking} נקמה הערב.`,
      `המזל ישתנה, זה עניין של זמן.`,
      `תקופה קשה, אבל ${g.he} לוחם.`,
    ];
    return {
      highlight: highlights[idx % highlights.length],
      sentence: sentences[idx % sentences.length],
    };
  }
  
  // Mild streak or no streak - focus on last game
  if (lastGameProfit > 0) {
    return {
      highlight: `נצחון אחרון +${Math.round(lastGameProfit)}₪`,
      sentence: `${g.came} עם רוח גבית מהפעם הקודמת.`,
    };
  } else {
    return {
      highlight: `הפסד אחרון ${Math.round(lastGameProfit)}₪`,
      sentence: `${g.looking} לתקן את הפעם הקודמת.`,
    };
  }
}

function generateLastGameFocus(ctx: PlayerContext, g: ReturnType<typeof getGenderForms>, idx: number): GeneratedContent {
  const { lastGameProfit } = ctx;
  
  if (lastGameProfit > 100) {
    const highlights = [
      `נצחון גדול +${Math.round(lastGameProfit)}₪`,
      `+${Math.round(lastGameProfit)}₪ אחרון 💰`,
      `ערב מוצלח: +${Math.round(lastGameProfit)}₪`,
    ];
    const sentences = [
      `הביטחון בשמיים אחרי ערב כזה.`,
      `${g.hot} מהפעם הקודמת.`,
      `נצחון כזה נותן כנפיים.`,
      `${g.wants} להמשיך את הסיפור הטוב.`,
    ];
    return {
      highlight: highlights[idx % highlights.length],
      sentence: sentences[idx % sentences.length],
    };
  }
  
  if (lastGameProfit < -100) {
    const highlights = [
      `הפסד כואב ${Math.round(lastGameProfit)}₪`,
      `${Math.round(lastGameProfit)}₪ אחרון 😤`,
      `ערב קשה: ${Math.round(lastGameProfit)}₪`,
    ];
    const sentences = [
      `${g.came} עם חשבון פתוח.`,
      `ההפסד צורב, הערב שונה.`,
      `${g.ready} לנקמה.`,
      `לא שוכח את הפעם הקודמת.`,
    ];
    return {
      highlight: highlights[idx % highlights.length],
      sentence: sentences[idx % sentences.length],
    };
  }
  
  // Moderate result
  const sign = lastGameProfit >= 0 ? '+' : '';
  return {
    highlight: `${sign}${Math.round(lastGameProfit)}₪ אחרון`,
    sentence: lastGameProfit >= 0 
      ? `ערב סביר, ${g.wants} יותר.`
      : `הפסד קטן, ${g.ready} להחזיר.`,
  };
}

function generateComebackFocus(ctx: PlayerContext, g: ReturnType<typeof getGenderForms>, idx: number): GeneratedContent {
  const { daysSinceLastGame, periodAvg, avgProfit } = ctx;
  
  if (daysSinceLastGame >= 60) {
    const highlights = [
      `חוזר אחרי ${daysSinceLastGame} ימים`,
      `🔙 הפסקה של ${Math.round(daysSinceLastGame / 30)} חודשים`,
      `${daysSinceLastGame} ימים בחוץ`,
    ];
    const sentences = [
      `הפסקה ארוכה, צריך לחמם מנועים.`,
      `${g.came} רענן אחרי ההפסקה.`,
      `נראה אם החלודה נשארה.`,
      `הזמן בחוץ ${g.will} לעזור או להפריע?`,
    ];
    return {
      highlight: highlights[idx % highlights.length],
      sentence: sentences[idx % sentences.length],
    };
  }
  
  if (daysSinceLastGame >= 30) {
    return {
      highlight: `חוזר אחרי חודש`,
      sentence: `הפסקה קצרה, ${g.ready} לשחק.`,
    };
  }
  
  // Not really a comeback - focus on something else
  if (periodAvg > avgProfit + 20) {
    return {
      highlight: `פורמה עולה 📈`,
      sentence: `התקופה האחרונה טובה מההיסטוריה.`,
    };
  }
  
  return {
    highlight: `${ctx.gamesPlayed} משחקים`,
    sentence: `ממשיך את הקצב הרגיל.`,
  };
}

function generateRankingFocus(ctx: PlayerContext, g: ReturnType<typeof getGenderForms>, idx: number, allPlayers: PlayerContext[]): GeneratedContent {
  const { rankTonight, totalPlayers, totalProfit } = ctx;
  
  if (rankTonight === 1) {
    const highlights = [
      `מוביל הטבלה 👑`,
      `#1 בטבלה`,
      `בראש! 🏆`,
    ];
    const sentences = [
      `על הכס, אבל כולם רודפים.`,
      `${g.he} היעד של כולם הערב.`,
      `המלך צריך להגן על הכתר.`,
      `להיות ראשון זה לחץ.`,
    ];
    return {
      highlight: highlights[idx % highlights.length],
      sentence: sentences[idx % sentences.length],
    };
  }
  
  if (rankTonight === 2) {
    const leader = allPlayers.find(p => p.rankTonight === 1);
    const gap = leader ? leader.totalProfit - totalProfit : 0;
    return {
      highlight: `מקום שני`,
      sentence: gap > 0 && gap < 200 
        ? `${gap}₪ מהמקום הראשון.`
        : `קרוב לפסגה, ${g.wants} לטפס.`,
    };
  }
  
  if (rankTonight === totalPlayers) {
    return {
      highlight: `מקום אחרון`,
      sentence: `יש רק כיוון אחד - למעלה.`,
    };
  }
  
  return {
    highlight: `מקום #${rankTonight}`,
    sentence: `${g.looking} לשפר את הדירוג.`,
  };
}

function generateHistoryFocus(ctx: PlayerContext, g: ReturnType<typeof getGenderForms>, idx: number): GeneratedContent {
  const { gamesPlayed, totalProfit, avgProfit } = ctx;
  
  if (gamesPlayed >= 50 && totalProfit > 500) {
    const highlights = [
      `ותיק עם +${Math.round(totalProfit)}₪`,
      `${gamesPlayed} משחקים, +${Math.round(totalProfit)}₪`,
      `היסטוריה מנצחת 🏅`,
    ];
    const sentences = [
      `הניסיון מדבר.`,
      `${gamesPlayed} משחקים לא משקרים.`,
      `ההיסטוריה בצד ${g.his}.`,
      `${g.player} רווחי לאורך זמן.`,
    ];
    return {
      highlight: highlights[idx % highlights.length],
      sentence: sentences[idx % sentences.length],
    };
  }
  
  if (gamesPlayed >= 30 && totalProfit < -300) {
    return {
      highlight: `${Math.round(totalProfit)}₪ כולל`,
      sentence: `ההיסטוריה קשה, אבל כל ערב הוא הזדמנות.`,
    };
  }
  
  if (gamesPlayed < 10) {
    return {
      highlight: `${gamesPlayed} משחקים בלבד`,
      sentence: `עדיין לומד את השולחן.`,
    };
  }
  
  return {
    highlight: `ממוצע ${avgProfit >= 0 ? '+' : ''}${Math.round(avgProfit)}₪`,
    sentence: avgProfit > 0 
      ? `${g.player} רווחי.` 
      : `${g.looking} להפוך את המגמה.`,
  };
}

function generateMomentumFocus(ctx: PlayerContext, g: ReturnType<typeof getGenderForms>, idx: number): GeneratedContent {
  const { periodAvg, avgProfit, periodGames } = ctx;
  const diff = periodAvg - avgProfit;
  
  if (diff > 30 && periodGames >= 3) {
    const highlights = [
      `פורמה עולה 📈`,
      `בתנופה!`,
      `שיפור משמעותי`,
    ];
    const sentences = [
      `התקופה האחרונה הרבה יותר טובה.`,
      `המומנטום חיובי.`,
      `משהו השתנה לטובה.`,
      `הפורמה בשיא.`,
    ];
    return {
      highlight: highlights[idx % highlights.length],
      sentence: sentences[idx % sentences.length],
    };
  }
  
  if (diff < -30 && periodGames >= 3) {
    const highlights = [
      `פורמה יורדת 📉`,
      `תקופה קשה`,
      `ירידה אחרונה`,
    ];
    const sentences = [
      `התקופה האחרונה קשה יותר מהרגיל.`,
      `${g.looking} לחזור לעצמו.`,
      `הפורמה לא במיטבה.`,
      `צריך לשבור את המגמה.`,
    ];
    return {
      highlight: highlights[idx % highlights.length],
      sentence: sentences[idx % sentences.length],
    };
  }
  
  return {
    highlight: `פורמה יציבה`,
    sentence: `ממשיך בקצב הרגיל.`,
  };
}

function generatePredictionFocus(ctx: PlayerContext, g: ReturnType<typeof getGenderForms>, idx: number): GeneratedContent {
  const { expectedProfit } = ctx;
  
  if (expectedProfit > 80) {
    const highlights = [
      `צפי: +${expectedProfit}₪ 🎯`,
      `פייבוריט הערב`,
      `סיכוי גבוה לנצח`,
    ];
    const sentences = [
      `הנתונים בצד ${g.his}.`,
      `${g.he} המועדף הערב.`,
      `הכל מצביע על ערב טוב.`,
      `קשה להמר נגדו.`,
    ];
    return {
      highlight: highlights[idx % highlights.length],
      sentence: sentences[idx % sentences.length],
    };
  }
  
  if (expectedProfit < -80) {
    const highlights = [
      `צפי: ${expectedProfit}₪`,
      `ערב מאתגר צפוי`,
      `התחזית קשה`,
    ];
    const sentences = [
      `הנתונים לא לטובתו.`,
      `ערב קשה על הנייר.`,
      `אבל הפתעות קורות.`,
      `${g.can} להפריך את התחזית.`,
    ];
    return {
      highlight: highlights[idx % highlights.length],
      sentence: sentences[idx % sentences.length],
    };
  }
  
  return {
    highlight: `צפי: ${expectedProfit >= 0 ? '+' : ''}${expectedProfit}₪`,
    sentence: `ערב פתוח, הכל יכול לקרות.`,
  };
}

function generatePersonalityFocus(ctx: PlayerContext, g: ReturnType<typeof getGenderForms>, idx: number): GeneratedContent {
  const { avgProfit, gamesPlayed, currentStreak } = ctx;
  
  // Consistent winner
  if (avgProfit > 30 && gamesPlayed >= 15) {
    const highlights = [
      `שקט אבל קטלני`,
      `מקצוען 🎯`,
      `יציב ומנצח`,
    ];
    const sentences = [
      `תמיד מסוכן בשולחן.`,
      `לא מרבה בדיבורים, מרבה בנצחונות.`,
      `${g.knows} מה ${g.he} עושה.`,
      `לא לזלזל אף פעם.`,
    ];
    return {
      highlight: highlights[idx % highlights.length],
      sentence: sentences[idx % sentences.length],
    };
  }
  
  // Volatile player
  if (gamesPlayed >= 10 && Math.abs(currentStreak) >= 2) {
    return {
      highlight: `תנודתי`,
      sentence: `אף פעם לא יודעים מה יהיה.`,
    };
  }
  
  // Consistent loser trying to improve
  if (avgProfit < -20 && gamesPlayed >= 15) {
    return {
      highlight: `${g.looking} לשינוי`,
      sentence: `כל ערב הוא הזדמנות להוכיח.`,
    };
  }
  
  return {
    highlight: `${g.player} ותיק`,
    sentence: `מכיר את המשחק.`,
  };
}

function generateChallengeFocus(ctx: PlayerContext, g: ReturnType<typeof getGenderForms>, idx: number): GeneratedContent {
  const { totalProfit, avgProfit, currentStreak, rankTonight, totalPlayers } = ctx;
  
  // Close to positive
  if (totalProfit < 0 && totalProfit > -150) {
    return {
      highlight: `${Math.abs(Math.round(totalProfit))}₪ מאפס`,
      sentence: `נצחון אחד טוב והמאזן חיובי.`,
    };
  }
  
  // Close to milestone
  const milestones = [500, 1000, 1500, 2000];
  for (const m of milestones) {
    if (totalProfit > 0 && m - totalProfit > 0 && m - totalProfit < 150) {
      return {
        highlight: `${m - Math.round(totalProfit)}₪ מ-${m}₪`,
        sentence: `קרוב למחסום חשוב!`,
      };
    }
  }
  
  // Break losing streak
  if (currentStreak <= -2) {
    return {
      highlight: `לשבור את הרצף`,
      sentence: `${Math.abs(currentStreak)} הפסדים, הלילה זה משתנה.`,
    };
  }
  
  // Climb ranking
  if (rankTonight > 3 && rankTonight < totalPlayers) {
    return {
      highlight: `לטפס בטבלה`,
      sentence: `מקום ${rankTonight}, אפשר יותר.`,
    };
  }
  
  return {
    highlight: `יש מה להוכיח`,
    sentence: `כל ערב הוא אתגר חדש.`,
  };
}

function generateRivalryFocus(ctx: PlayerContext, g: ReturnType<typeof getGenderForms>, idx: number, allPlayers: PlayerContext[]): GeneratedContent {
  const { name, totalProfit, rankTonight } = ctx;
  
  // Find closest rival above
  const above = allPlayers.find(p => p.rankTonight === rankTonight - 1);
  if (above) {
    const gap = above.totalProfit - totalProfit;
    if (gap > 0 && gap < 100) {
      return {
        highlight: `${gap}₪ מ${above.name}`,
        sentence: `ערב טוב ועובר אותו.`,
      };
    }
  }
  
  // Find closest rival below
  const below = allPlayers.find(p => p.rankTonight === rankTonight + 1);
  if (below) {
    const gap = totalProfit - below.totalProfit;
    if (gap > 0 && gap < 100) {
      return {
        highlight: `${below.name} רודף`,
        sentence: `${gap}₪ הפרש, צריך להגן.`,
      };
    }
  }
  
  // General rivalry
  const leader = allPlayers.find(p => p.rankTonight === 1);
  if (leader && leader.name !== name) {
    return {
      highlight: `נגד ${leader.name}`,
      sentence: `כולם רוצים להפיל את המוביל.`,
    };
  }
  
  return {
    highlight: `מול כולם`,
    sentence: `הערב יקבע מי באמת הכי טוב.`,
  };
}

function generateDefaultFocus(ctx: PlayerContext, g: ReturnType<typeof getGenderForms>, idx: number): GeneratedContent {
  const options = [
    { highlight: `ערב חדש`, sentence: `הכל פתוח, הקלפים יחליטו.` },
    { highlight: `${g.ready} לשחק`, sentence: `נראה מה הערב יביא.` },
    { highlight: `הזדמנות`, sentence: `כל ערב הוא סיפור חדש.` },
    { highlight: `בואו נראה`, sentence: `הערב יקבע.` },
  ];
  return options[idx % options.length];
}
