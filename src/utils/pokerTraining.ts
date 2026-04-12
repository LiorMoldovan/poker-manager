import { getGeminiApiKey, API_CONFIGS, getModelDisplayName, runGeminiTextPrompt } from './geminiAI';
import { getPlayerStats, getAllPlayers } from '../database/storage';
import { PlayerStats } from '../types';

let lastUsedTrainingModel = '';
export const getLastTrainingModel = () => lastUsedTrainingModel;
export const getLastTrainingModelDisplay = () => getModelDisplayName(lastUsedTrainingModel);

// ════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════

export interface TrainingOption {
  id: string;
  action: string;
  rating: 'best' | 'good' | 'ok' | 'bad';
  explanation: string;
}

export interface TrainingStreet {
  name: 'preflop' | 'flop' | 'turn' | 'river';
  board?: string[];
  potSize: number;
  context: string;
  options: TrainingOption[];
}

export interface TrainingHand {
  category: string;
  categoryId: string;
  difficulty: 'medium' | 'hard' | 'expert';
  setup: {
    yourCards: [string, string];
    yourPosition: string;
    yourStack: number;
    potBefore: number;
    opponents: {
      name: string;
      position: string;
      style: string;
      stack: number;
    }[];
  };
  streets: TrainingStreet[];
  keyLesson: string;
  concepts: string[];
}

export interface CategoryInfo {
  id: string;
  name: string;
  description: string;
  icon: string;
}

export interface CategoryProgress {
  total: number;
  best: number;
  good: number;
}

export interface SessionResult {
  date: string;
  handsPlayed: number;
  totalDecisions: number;
  bestDecisions: number;
  goodDecisions: number;
  categories: string[];
  difficulty: string;
  accuracy: number;
}

export interface TrainingProgress {
  totalDecisions: number;
  bestDecisions: number;
  goodDecisions: number;
  byCategory: Record<string, CategoryProgress>;
  byDifficulty: Record<string, CategoryProgress>;
  sessions: SessionResult[];
}

export interface SessionState {
  hands: HandResult[];
  difficulty: 'medium' | 'hard' | 'expert';
  maxHands: number | null; // null = unlimited
  categoryId: string | null; // null = random
}

export interface HandResult {
  categoryId: string;
  decisions: { streetName: string; chosenRating: string }[];
  bestCount: number;
  goodCount: number;
  totalDecisions: number;
}

export interface PlayerProfile {
  name: string;
  style: string;
  description: string;
  gamesPlayed: number;
  winRate: number;
  avgProfit: number;
  avgRebuys: number;
}

export interface QuickScenario {
  id: number;
  situation: string;
  yourCards: string;
  options: {
    id: string;
    text: string;
    isCorrect: boolean;
    explanation: string;
  }[];
  category: string;
  categoryId: string;
}

// ════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════

export const HERO_NAME = 'ליאור';
const STORAGE_KEY = 'poker_training_progress';

export const SCENARIO_CATEGORIES: CategoryInfo[] = [
  // לוח וקלפים משותפים
  { id: 'wet_board_top_pair', name: 'זוג עליון על לוח מסוכן', description: 'יש לך את הזוג הכי גבוה אבל על השולחן יש אפשרות לצבע או סדרה', icon: '🌊' },
  { id: 'flush_draw', name: 'חסר קלף לצבע', description: 'יש לך 4 קלפים מאותו צבע - להמר? לחכות?', icon: '♠️' },
  { id: 'straight_draw', name: 'חסר קלף לסדרה', description: 'חסר לך קלף אחד לסדרה - להיות אגרסיבי או זהיר?', icon: '🔗' },
  { id: 'missed_draw', name: 'פספסת את הקלף', description: 'חיכית לצבע או סדרה ולא הגיע - לבלוף או לוותר?', icon: '💨' },
  // חוזק היד
  { id: 'medium_pairs', name: 'זוגות בינוניים', description: 'יש לך זוג כמו 77-1010 וירדו קלפים גבוהים על השולחן', icon: '🎯' },
  { id: 'dominated_hands', name: 'ידיים שנראות טוב אבל מסוכנות', description: 'ידיים כמו A-9, K-J, Q-10 שיכולות להפסיד ליד דומה אבל חזקה יותר', icon: '⚠️' },
  { id: 'set_mining', name: 'חיפוש שלישייה', description: 'יש לך זוג נמוך (22-66) ומישהו העלה - לקרוא בשביל לתפוס שלישייה?', icon: '⛏️' },
  { id: 'second_pair', name: 'זוג שני', description: 'עשית זוג עם הקלף השני בגובהו על השולחן - מספיק טוב? מתי לוותר?', icon: '🥈' },
  { id: 'two_pair_plus', name: 'יד חזקה על לוח מסוכן', description: 'יש לך שני זוגות או שלישייה אבל על השולחן יש אפשרויות לידיים חזקות יותר', icon: '🛡️' },
  // גודל הימור ואגרסיביות
  { id: 'cbet', name: 'המשך הימור', description: 'העלית לפני הקלפים המשותפים - להמשיך להמר או לעצור?', icon: '🎪' },
  { id: 'thin_value', name: 'סחיטת ערך', description: 'יש לך יד לא רעה - להמר סכום קטן לרווח או לא להסתכן?', icon: '🪙' },
  { id: 'slow_play', name: 'משחק איטי', description: 'יש לך יד מפלצתית - להמר חזק מיד או להעמיד פנים ולצוד?', icon: '🐌' },
  { id: 'overbet', name: 'הימור ענק', description: 'להמר יותר מהקופה - מתי זה עובד ומתי זה טעות?', icon: '💥' },
  // קריאת יריבים
  { id: 'bluff_catching', name: 'לתפוס בלוף', description: 'היריב מהמר גדול על קלף מפחיד - הוא מבלף או שיש לו?', icon: '🕵️' },
  { id: 'pot_odds', name: 'האם כדאי לקרוא?', description: 'היריב מהמר ויש לך סיכוי להשתפר - המתמטיקה אומרת לקרוא?', icon: '🔢' },
  { id: 'check_raise', name: 'צ\'ק ואז העלאה', description: 'מתי לעשות צ\'ק כדי לצוד את היריב ואז להעלות?', icon: '🪤' },
  // מבנה היד
  { id: 'multiway_pots', name: 'הרבה שחקנים בקופה', description: 'אותה יד משתנה כשיש 4 שחקנים לעומת אחד מולך', icon: '👥' },
  { id: 'three_bet_pots', name: 'קופות עם העלאה חוזרת', description: 'מישהו העלה, אתה העלית שוב - קופה גדולה עם ידיים חזקות', icon: '💣' },
  { id: 'squeeze_isolation', name: 'לחיצה ובידוד', description: 'כמה שחקנים נכנסו בזול - מתי להעלות חזק כדי לבודד?', icon: '🗜️' },
  { id: 'blind_defense', name: 'הגנה מהבליינד', description: 'אתה בבליינד ומישהו העלה - לקרוא, להעלות חזרה, או לוותר?', icon: '🏰' },
  { id: 'stack_depth', name: 'גודל הערימה', description: 'כשיש לך הרבה צ\'יפים לעומת מעט - איך זה משנה את המשחק?', icon: '📏' },
  { id: 'position_play', name: 'ניצול מיקום', description: 'כשאתה אחרון לדבר לעומת ראשון - איך זה משנה את ההחלטה?', icon: '📍' },
  // לפני הקלפים המשותפים
  { id: 'preflop_open', name: 'פתיחה לפני הפלופ', description: 'עם מה לפתוח מכל מיקום, כמה להעלות, ומתי לוותר על ידיים בינוניות', icon: '🚪' },
  { id: 'preflop_vs_raise', name: 'מישהו העלה לפניך', description: 'מישהו העלה ואולי עוד קראו - מה לעשות עם זוג נמוך, יד חזקה, או יד בינונית?', icon: '🤔' },
  { id: 'odds_math', name: 'אחוזים וסיכויים', description: 'מה הסיכוי להשלים סדרה/צבע? חישוב אאוטים, סיכויי קופה', icon: '📊' },
  { id: 'true_false', name: 'סיכויים וחישובים', description: 'אאוטים, סיכויי קופה, אחוזי ניצחון — תחשב נכון ותנצח', icon: '🔢' },
];

// ════════════════════════════════════════════════════════════
// PLAYER STYLES & GAME CONTEXT (shared across all prompts)
// ════════════════════════════════════════════════════════════

export const PLAYER_STYLES: Record<string, string> = {
  'ליאור': 'סלקטיבי ופסיבי — נכנס רק עם טוב, משחק שקט',
  'אייל': 'משחק הרבה ידיים, אגרסיבי — מהמר הרבה, אוהב הרפתקאות',
  'חרדון': 'משחק הרבה ידיים, אגרסיבי — מהמר חזק',
  'אורן': 'משחק הרבה ידיים, פסיבי — קורא הרבה, לא ממהר להעלות',
  'ליכטר': 'משחק הרבה ידיים, אגרסיבי — מהמר ומעלה הרבה',
  'סגל': 'סלקטיבי ופסיבי — נכנס רק עם טוב, משחק שקט',
  'תומר': 'משחק הרבה ידיים, פסיבי — קורא הרבה, לא מעלה',
  'פיליפ': 'משחק הרבה ידיים, אגרסיבי',
  'פאבל': 'משחק הרבה ידיים, אגרסיבי — מהמר ומעלה הרבה',
  'דן מאן': 'סלקטיבי ופסיבי',
  'מלמד': 'סלקטיבי ואגרסיבי — כשנכנס, מהמר חזק',
};

const playerStylesPrompt = Object.entries(PLAYER_STYLES)
  .map(([name, style]) => `- ${name}: ${style}`)
  .join('\n');

export const GAME_CONTEXT = `הקשר המשחק — חובה להבין:
זהו משחק ביתי חברתי בין חבר'ה קבועים (~8 שחקנים), על סכומים קטנים.
כניסה: 30 שקלים = 10,000 צ'יפים. כל הסכומים בשאלות הם בצ'יפים (לא שקלים).
המרה: 500 צ'יפים = 1.5 ₪, 1,000 = 3 ₪, 2,000 = 6 ₪, 5,000 = 15 ₪.
שחקנים קונים בקלות עד 6-8 ריבאיים (30 ₪ כל פעם) — להפסיד ערימה זה לא נורא.
בליינדס: 50/100. ערימות: 8,000-25,000. העלאות לפני הפלופ: 400-2,000. אחרי הפלופ: 1,000-5,000. הימורים גדולים: 5,000+.
3-5 שחקנים רואים כמעט כל פלופ. הרבה קופות מולטי-ווי.
התנהגות קריאה: העלאה רגילה (400-1,000) מקבלת 3-5 קוראים. גם 2,000 מקבל 2-3. רק 3,000+ מדלל.
בלופים: אפקטיביות נמוכה. בלופים קטנים/בינוניים כמעט תמיד נקראים. גדולים (5,000+) מפחידים רק ידיים חלשות באמת.

כיול תשובות נכונות למשחק הזה:
- קריאה עם ידיים בינוניות מול הימורים בינוניים = בדרך כלל נכון
- ויתור מול הימור קטן (500-1,500) עם כל זוג או משיכה = כמעט תמיד שגוי
- הימור ערך גדול עם יד חזקה = נכון — הם ישלמו לך
- בלוף = כמעט אף פעם לא התשובה הנכונה — מישהו תמיד יקרא
- העלאה לפני הפלופ עם יד חזקה = נכון, אבל לא בשביל "לבודד" — בשביל לבנות קופה גדולה כי ממילא יקראו
- "לבודד", "לדלל את השדה" = לא עובד במשחק שלנו! העלאה ל-1,500 עדיין מקבלת 3 קוראים
- "היריב יפרוש" = כמעט אף פעם — אלא אם כן ההימור באמת ענק (5,000+) והיד שלו באמת חלשה

טעויות נפוצות בהסברים — חובה להימנע:
- אל תכתוב "העלאה תבודד" או "תדלל את השדה" — זה לא קורה במשחק שלנו
- אל תניח שיריבים יפרשו מהעלאה רגילה — הם ישלמו
- הסבר תמיד למה התשובה נכונה דווקא **במשחק הביתי שלנו** — לא בפוקר מקצועי
- אם העלאה נכונה, ההסבר צריך להיות "בונים קופה גדולה עם יד חזקה" ולא "מבודדים יריב"`;

/**
 * חוקי פורמט לשאלת מאגר — זהים ל-buildPoolBatchPrompt.
 * משמשים בפרומפט תיקון AI כדי שהתיקון הראשון יעמוד בסטנדרט בלי סבב "תקן את הפורמט".
 */
export const TRAINING_SCENARIO_FIX_FORMAT_RULES = `═══ פורמט פלט — חובה מדויק (מאגר האימון) ═══
החזר אובייקט JSON יחיד. מפתחות בלבד: poolId, situation, yourCards, boardCards, options (מערך של 3), category, categoryId.
אסור שדות נוספים ברמה העליונה. אסור עטיפה במערך.

options — בדיוק 3 אובייקטים:
- לכל אובייקט: "id" (מחרוזת "A", "B" או "C" באנגלית גדולה בלבד), "text", "isCorrect" (בוליאני), "explanation" (מחרוזת לא ריקה).
- "nearMiss": אופציונלי — רק לתשובות עם isCorrect:false. אסור nearMiss:true או כל nearMiss על התשובה הנכונה.
- בדיוק אחת מהשלוש עם isCorrect:true; השאר false.

situation:
- 1–2 משפטים בעברית, רק פעולה: מי המר כמה, גודל קופה, כמה שחקנים.
- אסור לחזור על קלפי היד או קלפי הלוח (הם ב-yourCards וב-boardCards).
- אסור לתאר את היד ("יש לך פלאש דרו", "זוגות על הלוח") — השחקן רואה קלפים בנפרד.

yourCards: רק קלפי השחקן, פורמט כמו "A♥ K♠" (רווח בין קלפים).

boardCards: קלפי פלופ/טרן/ריבר באותו פורמט, או מחרוזת ריקה "" לפני פלופ.

סכומים: רק צ'יפים (לא שקלים). "קריאה" = סכום להשוואה, לא גודל כל הקופה.

הסברים: 1–2 משפטים, ספציפיים למצב; טון משחק ביתי — לא GTO.

עברית: פלופ, טרן, ריבר, בליינד, ביד; לא "נהר"/"עיוור".

אסור במינוח: "fold equity", "תדלל", "תבודד", "תדלול"`;

export const WRONG_ANSWER_REACTIONS: string[] = [
  'טעות נפוצה! רוב השחקנים שלנו בוחרים את זה',
  'קרוב! הכיוון טוב, אבל...',
  'אוי, הלכת על הבלוף? אצלנו תמיד יקראו לך 😄',
  'הממם... חרדון היה גאה בבחירה הזו',
  'לא נורא, גם המקצוענים טועים',
  'שים לב לגודל ההימור ביחס לקופה',
  'אצלנו המשחק שונה — תמיד מישהו קורא',
  'כמעט! בפוקר מקצועי זה היה מהלך טוב',
  'טעות קלאסית של משחק ביתי — עכשיו תדע',
];

export const CORRECT_ANSWER_REACTIONS: string[] = [
  'מדויק! 🎯',
  'בול!',
  'אלוף! 💪',
  'בדיוק ככה!',
  'תשובה מושלמת',
  'אתה מכיר את המשחק שלנו!',
  'מקצוען!',
  'נכון מאוד — ככה מרוויחים אצלנו',
];

const TABLE_DYNAMICS = `משחק ביתי: 7-8 שחקנים, בליינדס 50/100 קבועים, ערימות 8,000-25,000. העלאות לפני הפלופ 400-2000. 3-5 רואים פלופ. בלופים עובדים פחות. אול-אין כמה פעמים בשעה.`;

// ════════════════════════════════════════════════════════════
// PLAYER STYLE INFERENCE
// ════════════════════════════════════════════════════════════

export const inferPlayerStyle = (stats: PlayerStats): PlayerProfile => {
  const { playerName, gamesPlayed, winPercentage, avgProfit, avgRebuysPerGame, biggestWin, biggestLoss, currentStreak } = stats;

  let style = '';
  let description = '';

  const isHighRebuyer = avgRebuysPerGame > 2;
  const isWinner = avgProfit > 5;
  const isLoser = avgProfit < -5;
  const isHighWinRate = winPercentage > 55;
  const isVolatile = Math.abs(biggestWin) + Math.abs(biggestLoss) > 400;

  if (isHighRebuyer && isWinner) {
    style = 'אגרסיבי';
    description = `קונה הרבה אבל מרוויח. משחק הרבה ידיים ומהמר גדול. ממוצע ${avgRebuysPerGame.toFixed(1)} ריבאיים.`;
  } else if (isHighRebuyer && isLoser) {
    style = 'פזיז';
    description = `משחק הרבה ידיים ומהמר, אבל מפסיד לאורך זמן. ממוצע ${avgRebuysPerGame.toFixed(1)} ריבאיים.`;
  } else if (!isHighRebuyer && isWinner && isHighWinRate) {
    style = 'שמרני וחזק';
    description = `מחכה לידיים טובות ומנצל. ${winPercentage.toFixed(0)}% נצחונות.`;
  } else if (!isHighRebuyer && isWinner && !isHighWinRate) {
    style = 'סבלני';
    description = `מרוויח עם אחוז נצחונות בינוני - כשמנצח, מנצח גדול. ממוצע: \u200E+${avgProfit.toFixed(0)}.`;
  } else if (!isHighRebuyer && isLoser) {
    style = 'שמרני';
    description = `לא קונה הרבה אבל מתקשה להרוויח. ממוצע: ${avgProfit.toFixed(0)}.`;
  } else if (isVolatile) {
    style = 'תנודתי';
    description = `נצחון עד \u200E+${Math.round(biggestWin)} או הפסד עד ${Math.round(Math.abs(biggestLoss))}. קשה לקרוא.`;
  } else {
    style = 'מאוזן';
    description = `${gamesPlayed} משחקים. ממוצע: ${avgProfit >= 0 ? '\u200E+' : '\u200E'}${avgProfit.toFixed(0)}.`;
  }

  if (Math.abs(currentStreak) >= 3) {
    const streakText = currentStreak > 0
      ? `ברצף ${currentStreak} נצחונות - ביטחון גבוה`
      : `ברצף ${Math.abs(currentStreak)} הפסדים - משחק רגשי`;
    description += ` ${streakText}.`;
  }

  return {
    name: playerName,
    style,
    description,
    gamesPlayed,
    winRate: winPercentage,
    avgProfit,
    avgRebuys: avgRebuysPerGame,
  };
};

// ════════════════════════════════════════════════════════════
// PROGRESS TRACKING (localStorage)
// ════════════════════════════════════════════════════════════

const DEFAULT_PROGRESS: TrainingProgress = {
  totalDecisions: 0,
  bestDecisions: 0,
  goodDecisions: 0,
  byCategory: {},
  byDifficulty: {},
  sessions: [],
};

export const getTrainingProgress = (): TrainingProgress => {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return { ...DEFAULT_PROGRESS };
  try {
    const parsed = JSON.parse(stored);
    return {
      totalDecisions: typeof parsed?.totalDecisions === 'number' ? parsed.totalDecisions : 0,
      bestDecisions: typeof parsed?.bestDecisions === 'number' ? parsed.bestDecisions : 0,
      goodDecisions: typeof parsed?.goodDecisions === 'number' ? parsed.goodDecisions : 0,
      byCategory: parsed?.byCategory && typeof parsed.byCategory === 'object' ? parsed.byCategory : {},
      byDifficulty: parsed?.byDifficulty && typeof parsed.byDifficulty === 'object' ? parsed.byDifficulty : {},
      sessions: Array.isArray(parsed?.sessions) ? parsed.sessions : [],
    };
  } catch {
    return { ...DEFAULT_PROGRESS };
  }
};

export const saveTrainingProgress = (progress: TrainingProgress): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
};

export const recordDecision = (
  categoryId: string,
  difficulty: string,
  rating: 'best' | 'good' | 'ok' | 'bad'
): void => {
  const progress = getTrainingProgress();

  progress.totalDecisions++;
  if (rating === 'best') progress.bestDecisions++;
  if (rating === 'good') progress.goodDecisions++;

  if (!progress.byCategory[categoryId]) {
    progress.byCategory[categoryId] = { total: 0, best: 0, good: 0 };
  }
  progress.byCategory[categoryId].total++;
  if (rating === 'best') progress.byCategory[categoryId].best++;
  if (rating === 'good') progress.byCategory[categoryId].good++;

  if (!progress.byDifficulty[difficulty]) {
    progress.byDifficulty[difficulty] = { total: 0, best: 0, good: 0 };
  }
  progress.byDifficulty[difficulty].total++;
  if (rating === 'best') progress.byDifficulty[difficulty].best++;
  if (rating === 'good') progress.byDifficulty[difficulty].good++;

  saveTrainingProgress(progress);
};

export const saveSession = (session: SessionResult): void => {
  const progress = getTrainingProgress();
  progress.sessions.push(session);
  if (progress.sessions.length > 50) {
    progress.sessions = progress.sessions.slice(-50);
  }
  saveTrainingProgress(progress);
};

export const getWeakCategories = (): string[] => {
  const progress = getTrainingProgress();
  return Object.entries(progress.byCategory)
    .filter(([, data]) => {
      if (data.total < 3) return false;
      const accuracy = (data.best + data.good) / data.total;
      return accuracy < 0.5;
    })
    .sort((a, b) => {
      const accA = (a[1].best + a[1].good) / a[1].total;
      const accB = (b[1].best + b[1].good) / b[1].total;
      return accA - accB;
    })
    .map(([id]) => id);
};

export const getOverallAccuracy = (): number => {
  const progress = getTrainingProgress();
  if (progress.totalDecisions === 0) return 0;
  return ((progress.bestDecisions + progress.goodDecisions) / progress.totalDecisions) * 100;
};

export const getAccuracyTrend = (): number[] => {
  const progress = getTrainingProgress();
  return progress.sessions.slice(-10).map(s => s.accuracy);
};

// ════════════════════════════════════════════════════════════
// GEMINI API
// ════════════════════════════════════════════════════════════

const FULL_MODE_MODELS = API_CONFIGS;

const QUICK_MODE_MODELS = [
  ...API_CONFIGS.slice(1),
  API_CONFIGS[0],
];

const getStyleSummary = (playerProfiles: PlayerProfile[]): string => {
  const opponents = playerProfiles.filter(p => p.name !== HERO_NAME);
  if (opponents.length === 0) {
    return 'בשולחן יש מגוון סגנונות: שחקנים אגרסיביים, שמרניים, תנודתיים ומאוזנים.';
  }
  const styleCounts: Record<string, number> = {};
  opponents.forEach(p => {
    styleCounts[p.style] = (styleCounts[p.style] || 0) + 1;
  });
  const styleLines = Object.entries(styleCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([style, count]) => `- ${style}: ${count} שחקנים`)
    .join('\n');
  return `סגנונות בשולחן:\n${styleLines}`;
};

const buildPrompt = (
  playerProfiles: PlayerProfile[],
  category: CategoryInfo,
  difficulty: 'medium' | 'hard' | 'expert',
  weakCategories: string[]
): string => {
  const styleSummary = getStyleSummary(playerProfiles);

  const difficultyHeb: Record<string, string> = {
    medium: 'בינוני - התשובה הנכונה ברורה למי שחושב, אבל יש מלכודת',
    hard: 'קשה - שתי אופציות קרובות מאוד, ההבדל בא מהכרת היריב או חישוב',
    expert: 'מומחה - המהלך הנכון לא אינטואיטיבי, גם מנוסים יתקשו',
  };

  return `אתה בונה תרגיל פוקר למשחק ביתי. עברית פשוטה בלבד.

מילים מותרות: קופה, בליינד, העלאה, קריאה, ויתור, צ'ק, בלוף, שלישייה, זוג, סדרה, צבע, אול-אין, פלופ, טרן, ריבר.
**אסור** מונחים באנגלית: equity, EV, SPR, implied odds, range, c-bet, semi-bluff, value bet, OESD, gutshot, TPTK, LAG, TAG, loose, tight, wild, balanced, tilt.

${TABLE_DYNAMICS}
${styleSummary}

## נושא
**${category.name}** - ${category.description}
רמת קושי: **${difficultyHeb[difficulty]}**
${weakCategories.length > 0 ? `שים דגש על נקודות חלשות: ${weakCategories.join(', ')}\n` : ''}

---

## חוק מס' 1: נקודת ההחלטה (הכי חשוב!!)

ה-context של כל רחוב מתאר מה כל היריבים עשו **עד** הרגע שבו ${HERO_NAME} צריך להחליט.
**לעולם אל תכתוב מה ${HERO_NAME} עושה או מחליט!** הוא זה שבוחר מהאופציות.

### דוגמה נכונה (פריפלופ):
context: "שחקן אגרסיבי בעמדה מוקדמת העלה ל-800. שחקן שמרני קרא. אתה ב-BTN עם A♠ 9♦."
→ האופציות: קריאה 800 / העלאה ל-2,400 / ויתור ✅

### דוגמה **שגויה**:
context: "אתה מחליט לקרוא 800." → ואז אופציה "קריאה 800"
❌ לא! כבר כתבת שהוא קרא, אז למה שוב לשאול אותו?

### דוגמה נכונה (פלופ, אחרי שהשחקן בחר "best" בפריפלופ):
context: "ירדו K♥ 9♠ 4♦. שחקן אגרסיבי מהמר 2,500."
→ האופציות: קריאה 2,500 / העלאה ל-6,000 / ויתור ✅

### דוגמה **שגויה** (פלופ):
context: "ירדו K♥ 9♠ 4♦. כולם עושים צ'ק."
→ אופציה: קריאה 1,750
❌ קריאה למה? אף אחד לא המר! אם כולם עשו צ'ק האופציות צריכות להיות: צ'ק / הימור X / (אול-אין)

## חוק מס' 2: האופציות חייבות להתאים לפעולות שתוארו

- אם יש **הימור פתוח** של יריב → האופציות: קריאה [סכום ההימור], העלאה ל-[סכום], ויתור
- אם אף אחד לא המר (צ'ק אליך) → האופציות: צ'ק, הימור [סכום], (אול-אין)
- אם אתה ראשון לדבר → האופציות: צ'ק, הימור [סכום], (אול-אין)
- סכום "קריאה" = בדיוק הסכום שצריך לשלם כדי להישאר (לא הסכום הכולל בקופה!)
- סכום "העלאה" = הסכום הכולל שאתה שם (כולל הקריאה)

## חוק מס' 3: potSize = הקופה **ברגע ההחלטה** (לפני שהשחקן פועל)

- potSize כולל את כל מה שכבר נכנס לקופה: בליינדים + כל ההעלאות/קריאות של כל השחקנים
- potSize **לא כולל** את מה שהשחקן שלנו צריך לשלם עכשיו
- דוגמה: בליינדים 150, שחקן א' העלה ל-800, שחקן ב' קרא 800.
  → potSize = 150 + 800 + 800 = 1,750. ✅
- דוגמה: בפלופ, הקופה הייתה 2,400. שחקן א' המר 1,200.
  → potSize = 2,400 + 1,200 = 3,600. ✅

## חוק מס' 4: קלפים

- פורמט: דרגה + סמל. דרגות: A, K, Q, J, 10, 9, 8, 7, 6, 5, 4, 3, 2. סמלים: ♠, ♥, ♦, ♣.
- כל קלף מופיע **פעם אחת בלבד** בכל ה-JSON! אם A♠ ביד השחקן, הוא לא על השולחן.
- פלופ = בדיוק 3 קלפים. טרן = 1 קלף חדש. ריבר = 1 קלף חדש.
- **board חייב להתאים בדיוק ל-context**: אם board=["K♥","9♠","4♦"] אז ב-context כתוב "ירדו K♥ 9♠ 4♦" - אותם קלפים, אותו סדר.
- ב-context של טרן/ריבר, תאר **רק** את הקלף החדש.

## חוק מס' 5: opponents = רק שחקנים שרלוונטיים ליד

- ב-opponents רשום **רק** שחקנים שמשתתפים ביד (שלא ויתרו).
- אם 5 שחקנים ויתרו ורק 2 נשארו מול ${HERO_NAME}, opponents כולל רק את ה-2.
- תאר כל יריב לפי סגנון פשוט: "שחקן אגרסיבי", "שחקן שמרני", "שחקן סבלני", "שחקן פזיז", "שחקן תנודתי", "שחקן מאוזן". **בלי שמות אמיתיים, בלי מונחים באנגלית**.
- פעולות יריבים ב-context חייבות להתאים לסגנונם: שחקן אגרסיבי מעלה, שחקן שמרני קורא או מוותר.

## חוק מס' 6: המשכיות בין רחובות

- כל רחוב אחרי הראשון מניח שהשחקן בחר את האופציה "best" ברחוב הקודם.
- אם ב-best של פריפלופ כתוב "העלאה ל-2,400", אז ב-context של הפלופ הקופה כוללת את ה-2,400.
- הקופה של הרחוב הבא = potSize של הרחוב הקודם + סכום ה-best + תגובות יריבים.

---

## מבנה
- השחקן שלנו: **${HERO_NAME}**
- בדיוק **2 או 3 רחובות** עם נקודות החלטה
- בכל רחוב: **3 או 4 אופציות**
- בכל רחוב: בדיוק אופציה אחת "best" ולפחות אחת "bad"
- הסבר (explanation) בכל אופציה: התייחס לקלפים, לקופה, ולסגנון היריב. עברית פשוטה.

---

## JSON בלבד:
{
  "category": "${category.name}",
  "categoryId": "${category.id}",
  "difficulty": "${difficulty}",
  "setup": {
    "yourCards": ["A♠", "9♦"],
    "yourPosition": "BTN",
    "yourStack": 12000,
    "potBefore": 150,
    "opponents": [
      { "name": "שחקן אגרסיבי", "position": "CO", "style": "אגרסיבי", "stack": 15000 },
      { "name": "שחקן שמרני", "position": "BB", "style": "שמרני", "stack": 10000 }
    ]
  },
  "streets": [
    {
      "name": "preflop",
      "potSize": 1750,
      "context": "שחקן אגרסיבי ב-CO העלה ל-800. שחקן שמרני ב-BB קרא. אתה ב-BTN עם A♠ 9♦.",
      "options": [
        { "id": "A", "action": "קריאה 800", "rating": "good", "explanation": "הסבר" },
        { "id": "B", "action": "העלאה ל-2,400", "rating": "best", "explanation": "הסבר" },
        { "id": "C", "action": "ויתור", "rating": "bad", "explanation": "הסבר" }
      ]
    },
    {
      "name": "flop",
      "board": ["K♥", "9♠", "4♦"],
      "potSize": 7200,
      "context": "ירדו K♥ 9♠ 4♦. יש לך זוג 9 עם A. שניהם עשו צ'ק אליך.",
      "options": [
        { "id": "A", "action": "צ'ק", "rating": "bad", "explanation": "הסבר" },
        { "id": "B", "action": "הימור 3,500", "rating": "best", "explanation": "הסבר" },
        { "id": "C", "action": "אול-אין", "rating": "ok", "explanation": "הסבר" }
      ]
    }
  ],
  "keyLesson": "לקח מרכזי בעברית פשוטה",
  "concepts": ["מושג בעברית", "מושג בעברית"]
}

**לפני שאתה מחזיר, בדוק:**
1. ב-context אתה אף פעם לא כותב מה ${HERO_NAME} עושה/מחליט/בוחר?
2. האופציות מתאימות למצב? (קריאה רק אם מישהו המר, צ'ק רק אם אף אחד לא המר)
3. potSize = סכום כל מה שבקופה ברגע ההחלטה?
4. הקלפים ב-board זהים לאלה שב-context?
5. opponents כולל רק שחקנים שבתוך היד?`;
};

export const generateTrainingHand = async (
  category?: CategoryInfo,
  difficulty: 'medium' | 'hard' | 'expert' = 'hard'
): Promise<TrainingHand> => {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error('NO_API_KEY');

  const allStats = getPlayerStats();
  const allPlayers = getAllPlayers();
  const permanentIds = new Set(
    allPlayers.filter(p => p.type === 'permanent').map(p => p.name)
  );

  const profiles = allStats
    .filter(s => {
      if (permanentIds.has(s.playerName)) return s.gamesPlayed >= 3;
      return s.gamesPlayed >= 15;
    })
    .sort((a, b) => {
      const aIsPerm = permanentIds.has(a.playerName) ? 0 : 1;
      const bIsPerm = permanentIds.has(b.playerName) ? 0 : 1;
      if (aIsPerm !== bIsPerm) return aIsPerm - bIsPerm;
      return b.gamesPlayed - a.gamesPlayed;
    })
    .map(inferPlayerStyle);

  const weakCats = getWeakCategories();
  let selectedCategory = category;

  if (!selectedCategory) {
    if (weakCats.length > 0 && Math.random() < 0.4) {
      const weakId = weakCats[Math.floor(Math.random() * weakCats.length)];
      selectedCategory = SCENARIO_CATEGORIES.find(c => c.id === weakId);
    }
    if (!selectedCategory) {
      selectedCategory = SCENARIO_CATEGORIES[Math.floor(Math.random() * SCENARIO_CATEGORIES.length)];
    }
  }

  const prompt = buildPrompt(profiles, selectedCategory, difficulty, weakCats);
  let lastError = '';

  for (const config of FULL_MODE_MODELS) {
    const modelPath = config.model.startsWith('models/') ? config.model : `models/${config.model}`;
    const url = `https://generativelanguage.googleapis.com/${config.version}/${modelPath}:generateContent?key=${apiKey}`;

    const MAX_VALIDATION_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_VALIDATION_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.75 + attempt * 0.05,
            topP: 0.9,
            maxOutputTokens: 3000,
            responseMimeType: 'application/json',
          },
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        const msg = err?.error?.message || `HTTP ${response.status}`;
        console.warn(`Training [${config.model}]: ${msg}`);
        if (response.status === 429 || response.status === 404 || response.status === 503) {
          lastError = msg;
          break;
        }
        if (response.status === 400 && msg.includes('API key')) {
          throw new Error('INVALID_API_KEY');
        }
        lastError = msg;
        break;
      }

      const data = await response.json();

      const candidate = data.candidates?.[0];
      if (candidate?.finishReason === 'SAFETY') {
        console.warn(`Training [${config.model}]: blocked by safety filter`);
        lastError = 'Safety filter';
        continue;
      }

      const text = candidate?.content?.parts?.[0]?.text;
      if (!text) {
        console.warn(`Training [${config.model}]: empty response`);
        lastError = 'Empty response';
        continue;
      }

      let jsonText = text;
      if (text.includes('```json')) {
        jsonText = text.split('```json')[1].split('```')[0];
      } else if (text.includes('```')) {
        jsonText = text.split('```')[1].split('```')[0];
      }

      const hand: TrainingHand = JSON.parse(jsonText.trim());

      if (!hand.streets || hand.streets.length < 2 || !hand.setup?.yourCards) {
        console.warn(`Training [${config.model}]: invalid structure`, hand);
        lastError = 'Invalid response structure';
        continue;
      }

      // ── Validation ──
      const validRanks = new Set(['A','K','Q','J','10','9','8','7','6','5','4','3','2']);
      const validSuits = new Set(['♠','♥','♦','♣']);
      const isValidCard = (c: string) => {
        const suit = c.slice(-1);
        const rank = c.slice(0, -1);
        return validRanks.has(rank) && validSuits.has(suit);
      };

      const allUsedCards = new Set<string>();
      let valid = true;
      let rejectReason = '';

      for (const c of hand.setup.yourCards) {
        if (!isValidCard(c)) { valid = false; rejectReason = `bad hero card: ${c}`; break; }
        allUsedCards.add(c);
      }

      if (valid) {
        for (const street of hand.streets) {
          if (street.board) {
            for (const c of street.board) {
              if (!isValidCard(c) || allUsedCards.has(c)) {
                valid = false; rejectReason = `bad/dup board card: ${c}`; break;
              }
              allUsedCards.add(c);
            }
          }
          if (!valid) break;

          const bestCount = street.options?.filter(o => o.rating === 'best').length || 0;
          if (bestCount !== 1) {
            valid = false; rejectReason = `street "${street.name}" has ${bestCount} best options`; break;
          }

          if (!street.options || street.options.length < 3) {
            valid = false; rejectReason = `street "${street.name}" has <3 options`; break;
          }

          // Context must not describe hero's action
          const ctx = street.context || '';
          const heroActionPatterns = [
            /אתה מחליט/,
            /אתה קורא/,
            /אתה מעלה/,
            /אתה עושה/,
            /אתה בוחר/,
            /אתה משלם/,
            /החלטת/,
            /בחרת/,
            /קראת/,
            /העלית/,
          ];
          for (const pat of heroActionPatterns) {
            if (pat.test(ctx)) {
              valid = false;
              rejectReason = `context narrates hero action: "${ctx.slice(0, 60)}..."`;
              break;
            }
          }
          if (!valid) break;

          // Options must match situation
          const hasCallOption = street.options.some(o => /קריאה/.test(o.action));
          const hasCheckOption = street.options.some(o => /צ'ק|צק/.test(o.action));
          const hasBetOption = street.options.some(o => /הימור/.test(o.action));
          const contextHasBet = /המר|העלה|הימור|העלאה/.test(ctx) && !/צ'ק/.test(ctx.split('.').pop() || '');

          if (hasCallOption && !contextHasBet && street.name !== 'preflop') {
            console.warn(`Training [${config.model}]: "call" option but no bet in context for ${street.name}`);
          }
          if (hasCheckOption && hasBetOption && hasCallOption) {
            valid = false;
            rejectReason = `street "${street.name}" has check+call+bet - incoherent`;
            break;
          }
        }
      }

      if (!valid) {
        console.warn(`Training [${config.model}] attempt ${attempt + 1}: validation failed - ${rejectReason}`);
        lastError = rejectReason;
        if (attempt < MAX_VALIDATION_RETRIES) continue;
        break;
      }

      hand.categoryId = selectedCategory.id;
      hand.difficulty = difficulty;
      lastUsedTrainingModel = config.model;

      return hand;
    } catch (error) {
      if (error instanceof Error && error.message === 'INVALID_API_KEY') {
        throw error;
      }
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`Training [${config.model}]:`, msg);
      lastError = msg;
      break;
    }
    } // end retry loop
  }

  throw new Error(`ALL_MODELS_FAILED:${lastError}`);
};

// ════════════════════════════════════════════════════════════
// QUICK TRAINING (batch generation)
// ════════════════════════════════════════════════════════════

const buildQuickPrompt = (
  playerProfiles: PlayerProfile[],
  count: number,
  categories: CategoryInfo[],
  weakCategories: string[]
): string => {
  const styleSummary = getStyleSummary(playerProfiles);
  const categoryList = categories.map(c => `- ${c.name}: ${c.description}`).join('\n');

  return `בנה ${count} שאלות אימון פוקר מהירות למשחק ביתי. עברית פשוטה בלבד.

כללים:
- כל שאלה = נקודת החלטה אחת. תאר מה קרה **עד** הרגע שבו השחקן צריך להחליט. **אל תכתוב מה השחקן עושה/מחליט!**
- בדיוק 3 אופציות, בדיוק אחת נכונה
- אסור מונחים באנגלית (equity, EV, SPR, range, c-bet וכו')
- יריבים לפי סגנון בלבד ("שחקן אגרסיבי"), בלי שמות
- בליינדס 50/100, ערימות 8,000-25,000, העלאות 400-1000

חוקים קריטיים:
- אם מישהו המר → האופציות: קריאה [סכום ההימור], העלאה ל-[סכום], ויתור
- אם אף אחד לא המר → האופציות: צ'ק, הימור [סכום], (אול-אין/ויתור)
- "קריאה" = סכום שצריך לשלם, לא סכום הקופה!
- הסבר קצר שמתייחס לקלפים ולסגנון היריב

${styleSummary}

נושאים (גוון!):
${categoryList}
${weakCategories.length > 0 ? `דגש על: ${weakCategories.join(', ')}` : ''}

JSON בלבד, מערך של ${count}:
[{"id":1,"situation":"תיאור קצר 2-3 משפטים. מתאר את המצב עד רגע ההחלטה.","yourCards":"8♠ 8♦","options":[{"id":"A","text":"קריאה 800","isCorrect":false,"explanation":"הסבר קצר"},{"id":"B","text":"העלאה ל-3,000","isCorrect":true,"explanation":"הסבר קצר"},{"id":"C","text":"ויתור","isCorrect":false,"explanation":"הסבר קצר"}],"category":"שם נושא","categoryId":"category_id"}]`;
};

export const generateQuickBatch = async (
  count: number = 8,
  categoryIds?: string[],
): Promise<QuickScenario[]> => {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error('NO_API_KEY');

  const allStats = getPlayerStats();
  const allPlayersData = getAllPlayers();
  const permanentIds = new Set(
    allPlayersData.filter(p => p.type === 'permanent').map(p => p.name)
  );

  const profiles = allStats
    .filter(s => {
      if (permanentIds.has(s.playerName)) return s.gamesPlayed >= 3;
      return s.gamesPlayed >= 15;
    })
    .sort((a, b) => {
      const aIsPerm = permanentIds.has(a.playerName) ? 0 : 1;
      const bIsPerm = permanentIds.has(b.playerName) ? 0 : 1;
      if (aIsPerm !== bIsPerm) return aIsPerm - bIsPerm;
      return b.gamesPlayed - a.gamesPlayed;
    })
    .map(inferPlayerStyle);

  const weakCats = getWeakCategories();

  let categories: CategoryInfo[];
  if (categoryIds && categoryIds.length > 0) {
    categories = SCENARIO_CATEGORIES.filter(c => categoryIds.includes(c.id));
    if (categories.length === 0) categories = SCENARIO_CATEGORIES;
  } else {
    categories = SCENARIO_CATEGORIES;
  }

  const prompt = buildQuickPrompt(profiles, count, categories, weakCats);
  let lastError = '';

  for (const config of QUICK_MODE_MODELS) {
    const modelPath = config.model.startsWith('models/') ? config.model : `models/${config.model}`;
    const url = `https://generativelanguage.googleapis.com/${config.version}/${modelPath}:generateContent?key=${apiKey}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.75,
            topP: 0.9,
            maxOutputTokens: 4096,
            responseMimeType: 'application/json',
          },
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        const msg = err?.error?.message || `HTTP ${response.status}`;
        console.warn(`QuickTraining [${config.model}]: ${msg}`);
        if (response.status === 400 && msg.includes('API key')) {
          throw new Error('INVALID_API_KEY');
        }
        lastError = msg;
        continue;
      }

      const data = await response.json();
      const candidate = data.candidates?.[0];

      if (candidate?.finishReason === 'SAFETY') {
        lastError = 'Safety filter';
        continue;
      }

      const text = candidate?.content?.parts?.[0]?.text;
      if (!text) {
        lastError = 'Empty response';
        continue;
      }

      let jsonText = text;
      if (text.includes('```json')) {
        jsonText = text.split('```json')[1].split('```')[0];
      } else if (text.includes('```')) {
        jsonText = text.split('```')[1].split('```')[0];
      }

      const scenarios: QuickScenario[] = JSON.parse(jsonText.trim());

      if (!Array.isArray(scenarios) || scenarios.length === 0) {
        lastError = 'Invalid response structure';
        continue;
      }

      // Validate each scenario
      const valid = scenarios.filter(s =>
        s.situation && typeof s.situation === 'string' &&
        s.yourCards && typeof s.yourCards === 'string' &&
        Array.isArray(s.options) && s.options.length >= 2 &&
        s.options.every(o => o.id && typeof o.text === 'string' && o.text) &&
        s.options.some(o => o.isCorrect) &&
        s.options.filter(o => o.isCorrect).length === 1
      );

      if (valid.length === 0) {
        lastError = 'No valid scenarios';
        continue;
      }

      // Assign categoryId from category name if missing
      valid.forEach((s, i) => {
        s.id = i + 1;
        if (!s.categoryId && s.category) {
          const match = SCENARIO_CATEGORIES.find(c => c.name === s.category);
          if (match) s.categoryId = match.id;
        }
        if (!s.categoryId) {
          s.categoryId = SCENARIO_CATEGORIES[0].id;
        }
      });

      console.log(`QuickTraining [${config.model}]: generated ${valid.length} scenarios`);
      lastUsedTrainingModel = config.model;
      return valid;
    } catch (error) {
      if (error instanceof Error && error.message === 'INVALID_API_KEY') {
        throw error;
      }
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`QuickTraining [${config.model}]:`, msg);
      lastError = msg;
      continue;
    }
  }

  throw new Error(`ALL_MODELS_FAILED:${lastError}`);
};

// ════════════════════════════════════════════════════════════
// SHARED TRAINING (pool-based, for all players)
// ════════════════════════════════════════════════════════════

import {
  TrainingPool,
  PoolScenario,
  SharedTrainingProgress,
  TrainingBadge,
  TrainingSession,
  TrainingAnswersFile,
  TrainingPlayerData,
} from '../types';
import {
  fetchTrainingPool,
  writeTrainingAnswersWithRetry,
} from '../database/githubSync';
import { LEGACY_NAME_CORRECTIONS } from '../App';

/** Merge player entries whose names are in LEGACY_NAME_CORRECTIONS into the canonical entry. */
export const normalizeTrainingPlayers = (data: TrainingAnswersFile): TrainingAnswersFile => {
  const corrections = Object.entries(LEGACY_NAME_CORRECTIONS);
  if (corrections.length === 0) return data;

  const nameMap = new Map<string, TrainingPlayerData>();
  for (const p of data.players) nameMap.set(p.playerName, p);

  let changed = false;
  for (const [oldName, newName] of corrections) {
    const oldEntry = nameMap.get(oldName);
    if (!oldEntry) continue;
    changed = true;

    const newEntry = nameMap.get(newName);
    if (newEntry) {
      const existingIds = new Set(newEntry.sessions.map(s => s.results.map(r => r.poolId)).flat());
      for (const s of oldEntry.sessions) {
        const unique = s.results.some(r => !existingIds.has(r.poolId));
        if (unique) newEntry.sessions.push(s);
      }
      let scored = 0, corr = 0;
      for (const s of newEntry.sessions) {
        for (const r of s.results) {
          if (r.neutralized) continue;
          if (!r.nearMiss) { scored++; if (r.correct) corr++; }
        }
      }
      newEntry.totalQuestions = scored;
      newEntry.totalCorrect = corr;
      newEntry.accuracy = scored > 0 ? (corr / scored) * 100 : 0;
    } else {
      oldEntry.playerName = newName;
      nameMap.set(newName, oldEntry);
    }
    nameMap.delete(oldName);
  }

  if (!changed) return data;
  return { ...data, players: [...nameMap.values()] };
};

export function resetSharedTrainingProgress(playerName: string): void {
  try {
    localStorage.removeItem(`shared_training_progress_${playerName}`);
  } catch { /* ignore */ }
}

const POOL_CACHE_KEY = 'training_pool_cached';
const POOL_GENERATED_AT_KEY = 'training_pool_generatedAt';

const getProgressKey = (playerName: string) => `shared_training_progress_${playerName}`;

const DEFAULT_SHARED_PROGRESS: SharedTrainingProgress = {
  totalQuestions: 0,
  totalCorrect: 0,
  totalNeutral: 0,
  sessionsCompleted: 0,
  byCategory: {},
  streak: { current: 0, lastTrainingDate: null },
  maxStreak: 0,
  longestCorrectRun: 0,
  currentCorrectRun: 0,
  earnedBadgeIds: [],
  seenPoolIds: [],
  flaggedPoolIds: [],
};

export const getSharedProgress = (playerName: string): SharedTrainingProgress => {
  try {
    const raw = localStorage.getItem(getProgressKey(playerName));
    if (!raw) return { ...DEFAULT_SHARED_PROGRESS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SHARED_PROGRESS, ...parsed };
  } catch {
    return { ...DEFAULT_SHARED_PROGRESS };
  }
};

export const saveSharedProgress = (playerName: string, progress: SharedTrainingProgress): void => {
  localStorage.setItem(getProgressKey(playerName), JSON.stringify(progress));
};

/** Counts from session results — same rules as rebuildProgressFromRemote (neutralized excluded). */
export function getTrainingSessionCounts(player: TrainingPlayerData): {
  scored: number;
  correct: number;
  neutral: number;
  wrong: number;
  totalAnswered: number;
  accuracy: number;
} {
  let correct = 0;
  let neutral = 0;
  let wrong = 0;
  for (const s of player.sessions) {
    for (const r of s.results) {
      if (r.neutralized) continue;
      if (r.nearMiss) {
        neutral++;
        continue;
      }
      if (r.correct) correct++;
      else wrong++;
    }
  }
  const scored = correct + wrong;
  return {
    scored,
    correct,
    neutral,
    wrong,
    totalAnswered: scored + neutral,
    accuracy: scored > 0 ? (correct / scored) * 100 : 0,
  };
}

export const rebuildProgressFromRemote = (playerData: TrainingPlayerData): SharedTrainingProgress => {
  const progress: SharedTrainingProgress = { ...DEFAULT_SHARED_PROGRESS };
  progress.sessionsCompleted = playerData.sessions.length;

  const byCategory: Record<string, { total: number; correct: number }> = {};
  const seenPoolIds = new Set<string>();
  const flaggedPoolIds = new Set<string>();
  let currentCorrectRun = 0;
  let longestCorrectRun = 0;
  let totalQ = 0, totalC = 0, totalN = 0;

  const sortedSessions = [...playerData.sessions].sort((a, b) => a.date.localeCompare(b.date));

  for (const session of sortedSessions) {
    for (const r of session.results) {
      seenPoolIds.add(r.poolId);
      if (r.neutralized) continue;
      if (r.nearMiss) {
        totalN++;
        continue;
      }
      totalQ++;
      if (!byCategory[r.categoryId]) byCategory[r.categoryId] = { total: 0, correct: 0 };
      byCategory[r.categoryId].total++;
      if (r.correct) {
        totalC++;
        byCategory[r.categoryId].correct++;
        currentCorrectRun++;
        longestCorrectRun = Math.max(longestCorrectRun, currentCorrectRun);
      } else {
        currentCorrectRun = 0;
      }
    }
    if (session.flaggedPoolIds) {
      session.flaggedPoolIds.forEach(id => flaggedPoolIds.add(id));
    }
  }

  progress.totalQuestions = totalQ;
  progress.totalCorrect = totalC;
  progress.totalNeutral = totalN;
  progress.byCategory = byCategory;
  progress.longestCorrectRun = longestCorrectRun;
  progress.currentCorrectRun = currentCorrectRun;
  progress.seenPoolIds = Array.from(seenPoolIds);
  progress.flaggedPoolIds = Array.from(flaggedPoolIds);

  // Rebuild streak from session dates
  const sessionDates = [...new Set(sortedSessions.map(s => s.date.slice(0, 10)))].sort().reverse();
  if (sessionDates.length > 0) {
    progress.streak.lastTrainingDate = sessionDates[0];
    let streak = 1;
    for (let i = 1; i < sessionDates.length; i++) {
      const prev = new Date(sessionDates[i - 1]);
      const curr = new Date(sessionDates[i]);
      const diffDays = Math.round((prev.getTime() - curr.getTime()) / (1000 * 60 * 60 * 24));
      if (diffDays === 1) streak++;
      else break;
    }
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    if (sessionDates[0] === today || sessionDates[0] === yesterday) {
      progress.streak.current = streak;
    } else {
      progress.streak.current = 0;
    }
    // Approximate max streak (walk all dates)
    let maxStreak = 1;
    let runStreak = 1;
    for (let i = 1; i < sessionDates.length; i++) {
      const prev = new Date(sessionDates[i - 1]);
      const curr = new Date(sessionDates[i]);
      const diffDays = Math.round((prev.getTime() - curr.getTime()) / (1000 * 60 * 60 * 24));
      if (diffDays === 1) { runStreak++; maxStreak = Math.max(maxStreak, runStreak); }
      else { runStreak = 1; }
    }
    progress.maxStreak = maxStreak;
  }

  // Rebuild badges
  progress.earnedBadgeIds = checkNewBadges(progress);

  return progress;
};

// ── Pool loading ──

export const loadFromPool = async (
  playerName: string,
  count: number | null,
  categoryIds?: string[]
): Promise<{ scenarios: PoolScenario[]; exhaustedCategory: boolean; exhaustedAll: boolean }> => {
  let pool: TrainingPool | null = null;

  const cachedRaw = localStorage.getItem(POOL_CACHE_KEY);
  const cachedGenAt = localStorage.getItem(POOL_GENERATED_AT_KEY);

  if (cachedRaw) {
    try {
      pool = JSON.parse(cachedRaw) as TrainingPool;
    } catch { /* ignore */ }
  }

  const fetchWithTimeout = (): Promise<TrainingPool | null> =>
    Promise.race([
      fetchTrainingPool(),
      new Promise<null>(r => setTimeout(() => r(null), 3500)),
    ]);

  if (!pool || !cachedGenAt) {
    const remote = await fetchWithTimeout();
    if (!remote) {
      return { scenarios: [], exhaustedCategory: false, exhaustedAll: false };
    }
    pool = remote;
    localStorage.setItem(POOL_CACHE_KEY, JSON.stringify(pool));
    localStorage.setItem(POOL_GENERATED_AT_KEY, pool.generatedAt);
  } else {
    try {
      const remote = await fetchWithTimeout();
      if (remote && remote.generatedAt !== cachedGenAt) {
        pool = remote;
        localStorage.setItem(POOL_CACHE_KEY, JSON.stringify(remote));
        localStorage.setItem(POOL_GENERATED_AT_KEY, remote.generatedAt);
      }
    } catch { /* use cache */ }
  }

  const progress = getSharedProgress(playerName);
  const seenSet = new Set(progress.seenPoolIds);

  let available = pool.scenarios.filter(s => !seenSet.has(s.poolId));
  let exhaustedCategory = false;
  let exhaustedAll = false;

  // Filter out questions that mention the current player's name
  const namesToExclude = [playerName];
  Object.entries(LEGACY_NAME_CORRECTIONS).forEach(([old, corrected]) => {
    if (corrected === playerName) namesToExclude.push(old);
    if (old === playerName) namesToExclude.push(corrected);
  });
  available = available.filter(s => !namesToExclude.some(n => s.situation.includes(n)));

  if (categoryIds && categoryIds.length > 0) {
    const catSet = new Set(categoryIds);
    const catFiltered = available.filter(s => catSet.has(s.categoryId));
    if (catFiltered.length === 0 && available.length > 0) {
      exhaustedCategory = true;
    } else {
      available = catFiltered;
    }
  }

  if (available.length === 0) {
    progress.seenPoolIds = [];
    saveSharedProgress(playerName, progress);
    available = pool.scenarios.filter(s => !namesToExclude.some(n => s.situation.includes(n)));
    if (categoryIds && categoryIds.length > 0) {
      available = available.filter(s => new Set(categoryIds).has(s.categoryId));
    }
    exhaustedAll = true;
  }

  // Weak-category weighting: boost questions from categories where the player struggles
  const weakCatIds = Object.entries(progress.byCategory)
    .filter(([, d]) => d.total >= 3 && (d.correct / d.total) < 0.5)
    .map(([id]) => id);

  let shuffled: PoolScenario[];
  if (weakCatIds.length > 0 && available.length > 6) {
    const weakPool = available.filter(s => weakCatIds.includes(s.categoryId));
    const restPool = available.filter(s => !weakCatIds.includes(s.categoryId));
    const targetWeak = Math.max(1, Math.floor(available.length * 0.3));
    const weakPicked = [...weakPool].sort(() => Math.random() - 0.5).slice(0, targetWeak);
    const weakIds = new Set(weakPicked.map(s => s.poolId));
    const restPicked = [...restPool, ...weakPool.filter(s => !weakIds.has(s.poolId))].sort(() => Math.random() - 0.5);
    shuffled = [...weakPicked, ...restPicked].sort(() => Math.random() - 0.5);
  } else {
    shuffled = [...available].sort(() => Math.random() - 0.5);
  }

  const picked = count ? shuffled.slice(0, count) : shuffled;

  return { scenarios: picked, exhaustedCategory, exhaustedAll };
};

export const refreshPoolCache = async (): Promise<TrainingPool | null> => {
  const remote = await fetchTrainingPool();
  if (remote) {
    localStorage.setItem(POOL_CACHE_KEY, JSON.stringify(remote));
    localStorage.setItem(POOL_GENERATED_AT_KEY, remote.generatedAt);
  }
  return remote;
};

// ── Streaks ──

const STREAK_BREAK_HOURS = 48;

export const updateStreak = (progress: SharedTrainingProgress): void => {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const last = progress.streak.lastTrainingDate;

  if (!last) {
    progress.streak = { current: 1, lastTrainingDate: today };
    progress.maxStreak = Math.max(progress.maxStreak, 1);
    return;
  }

  if (last === today) return;

  const lastDate = new Date(last + 'T23:59:59');
  const hoursDiff = (now.getTime() - lastDate.getTime()) / (1000 * 60 * 60);

  if (hoursDiff <= STREAK_BREAK_HOURS) {
    progress.streak.current += 1;
    progress.streak.lastTrainingDate = today;
    progress.maxStreak = Math.max(progress.maxStreak, progress.streak.current);
  } else {
    progress.streak = { current: 1, lastTrainingDate: today };
  }
};

// ── Badges ──

export const TRAINING_BADGES: TrainingBadge[] = [
  {
    id: 'beginner', name: 'מתחיל', icon: '🌱',
    description: 'השלמת אימון ראשון',
    check: (p) => p.sessionsCompleted >= 1,
  },
  {
    id: 'dedicated', name: 'חרוץ', icon: '💪',
    description: '10 אימונים',
    check: (p) => p.sessionsCompleted >= 10,
  },
  {
    id: 'addicted', name: 'מכור', icon: '🔥',
    description: '25 אימונים',
    check: (p) => p.sessionsCompleted >= 25,
  },
  {
    id: 'answer_machine', name: 'מכונת תשובות', icon: '⚡',
    description: '10 תשובות נכונות ברצף',
    check: (p) => p.longestCorrectRun >= 10,
  },
  {
    id: 'hot_streak', name: 'רצף חם', icon: '🔥',
    description: 'רצף אימונים 7 ימים',
    check: (p) => p.maxStreak >= 7,
  },
  {
    id: 'poker_guru', name: 'גורו הפוקר', icon: '🧠',
    description: '70%+ דיוק עם 50+ שאלות',
    check: (p) => p.totalQuestions >= 50 && (p.totalCorrect / p.totalQuestions) >= 0.7,
  },
  {
    id: 'reporter', name: 'מדווח', icon: '🚩',
    description: 'דיווחת על שאלה לא תקינה',
    check: (p) => p.flaggedPoolIds.length >= 1,
  },
];

export const getPoolCounts = (): { total: number; byCategory: Record<string, number> } => {
  try {
    const raw = localStorage.getItem('training_pool_cached');
    if (!raw) return { total: 0, byCategory: {} };
    const pool = JSON.parse(raw);
    const byCategory: Record<string, number> = {};
    (pool.scenarios || []).forEach((s: { categoryId: string }) => {
      byCategory[s.categoryId] = (byCategory[s.categoryId] || 0) + 1;
    });
    return { total: pool.scenarios?.length || 0, byCategory };
  } catch { return { total: 0, byCategory: {} }; }
};

export const getCategoryExpertBadges = (progress: SharedTrainingProgress): { id: string; name: string; icon: string; earned: boolean }[] => {
  return SCENARIO_CATEGORIES.map(cat => {
    const data = progress.byCategory[cat.id];
    const earned = !!data && data.total >= 5 && (data.correct / data.total) >= 0.8;
    return {
      id: `expert_${cat.id}`,
      name: `מומחה: ${cat.name}`,
      icon: cat.icon,
      earned,
    };
  });
};

export const checkNewBadges = (progress: SharedTrainingProgress): string[] => {
  const newBadges: string[] = [];
  for (const badge of TRAINING_BADGES) {
    if (!progress.earnedBadgeIds.includes(badge.id) && badge.check(progress)) {
      newBadges.push(badge.id);
    }
  }
  for (const cat of SCENARIO_CATEGORIES) {
    const badgeId = `expert_${cat.id}`;
    if (progress.earnedBadgeIds.includes(badgeId)) continue;
    const data = progress.byCategory[cat.id];
    if (data && data.total >= 5 && (data.correct / data.total) >= 0.8) {
      newBadges.push(badgeId);
    }
  }
  return newBadges;
};

// ── Rule-based tips ──

export const CATEGORY_TIPS: Record<string, string[]> = {
  wet_board_top_pair: [
    'כשיש לך זוג עליון על לוח מסוכן, תמיד שאל את עצמך: "האם היריב יכול להחזיק סדרה או צבע?"',
    'הימור גדול על לוח רטוב מגן על היד שלך מפני משיכות - אל תתן מחיר זול לראות קלף נוסף',
  ],
  flush_draw: [
    'עם 4 קלפים לצבע בפלופ, יש לך ~35% לסגור עד הריבר - מספיק טוב להמר אגרסיבית ברוב המקרים',
    'אם פספסת את הצבע בטרן, יש לך רק ~19% בריבר - חשב אם הסיכויים שווים את המחיר',
  ],
  straight_draw: [
    'סדרה פתוחה משני הצדדים נותנת ~31% עד הריבר - יותר חזק ממה שנראה',
    'סדרה עם כניסה אחת נותנת רק ~16% - לרוב לא שווה לקרוא הימור גדול',
  ],
  missed_draw: [
    'כשפספסת משיכה, שאל: "האם היריב יאמין שסגרתי?" - אם כן, בלוף יכול לעבוד',
    'לא כל פספוס שווה בלוף - בלוף עובד רק כשהסיפור שלך הגיוני מנקודת המבט של היריב',
  ],
  medium_pairs: [
    'זוגות בינוניים (77-TT) חזקים בפריפלופ אבל מסוכנים כשיורדים קלפים גבוהים',
    'עם זוג בינוני מול העלאה, שאל: "האם אני מוכן להיכנס לקופה גדולה עם הזוג הזה?"',
  ],
  dominated_hands: [
    'ידיים כמו A-9 או K-J נראות טוב אבל מפסידות ליד דומה חזקה - היזהר מקופות גדולות',
    'אם עשית זוג עם הקיקר החלש, הסיכוי שמישהו מחזיק את אותו זוג עם קיקר חזק הוא אמיתי',
  ],
  set_mining: [
    'הסיכוי לשלישייה בפלופ הוא ~11.7% - צריך לזכות פי 8-10 מההשקעה כדי שזה ישתלם',
    'שלישייה היא יד מוסתרת ומסוכנת ליריבים - אם סגרת, נצל את זה למקסימום',
  ],
  second_pair: [
    'זוג שני הוא יד בינונית - טוב מספיק לקריאה קטנה אבל לא לקופה ענקית',
    'כשהיריב ממשיך להמר על לוח עם זוג עליון אפשרי, זוג שני לרוב לא מספיק',
  ],
  two_pair_plus: [
    'שני זוגות או שלישייה על לוח מסוכן - הגן על היד עם הימור, אל תתן קלפים חינם',
    'גם יד חזקה יכולה להפסיד - לפעמים צריך לדעת לוותר',
  ],
  cbet: [
    'המשך הימור עובד טוב על לוחות יבשים - שם ליריב קשה יותר להמשיך',
    'לא חייבים תמיד להמשיך להמר - לפעמים צ\'ק עם יד טובה צובר יותר',
  ],
  thin_value: [
    'הימור ערך דק - שואלים "האם יריב יקרא עם יד חלשה יותר?"',
    'אם היריב שמרני ויקרא רק עם ידיים חזקות, הימור ערך דק הופך מסוכן',
  ],
  slow_play: [
    'משחק איטי עם יד מפלצתית עובד נגד אגרסיביים - תן להם להמר בשבילך',
    'הסכנה: אתה נותן ליריב קלפים חינם שיכולים להפוך את המשחק',
  ],
  overbet: [
    'הימור ענק עובד כשיש לך יד מאוד חזקה או בלוף - לא באמצע',
    'הימור ענק לוחץ על היריב - כלי חזק אבל משתמשים בו במשורה',
  ],
  bluff_catching: [
    'כשהיריב מהמר גדול בריבר, חשב על הסיכויים - אם הקופה נותנת 3:1, מספיק שתצדק 25%',
    'שחקן שמרני שמהמר גדול בריבר לרוב לא מבלף',
  ],
  pot_odds: [
    '"כמה אני משלם לעומת כמה יש בקופה?" - אם הסיכוי גבוה מהיחס, קרא',
    'סיכויי קופה של 30%+ בדרך כלל מצדיקים קריאה עם משיכה טובה',
  ],
  check_raise: [
    'צ\'ק-רייז עובד מצוין כשאתה בטוח שהיריב ימשיך להמר',
    'אל תעשה צ\'ק-רייז נגד שמרני שיעשה צ\'ק מאחוריך',
  ],
  multiway_pots: [
    'בקופה עם הרבה שחקנים צריך יד חזקה יותר - הסיכוי שלמישהו יש משהו גדול עולה',
    'בלוף עובד גרוע בקופה מולטי-ווי - קשה לגרום ל-3 שחקנים לוותר',
  ],
  three_bet_pots: [
    'בקופה עם 3-bet הקופה כבר גדולה - כל החלטה שווה הרבה כסף',
    'אם עשית 3-bet, בדרך כלל תרצה להמשיך להוביל עם הימור בפלופ',
  ],
  squeeze_isolation: [
    'העלאה גדולה "סוחטת" ומבודדת - כלי חזק מהמיקומים המאוחרים',
    'גודל הלחיצה צריך להיות גדול מספיק שיריבים לא יקבלו מחיר טוב להישאר',
  ],
  blind_defense: [
    'מהבליינד אתה כבר השקעת - לפעמים שווה להגן עם ידיים בינוניות',
    'הגנת בליינד לא אומרת לקרוא עם הכל - עם ידיים חלשות עדיף לוותר',
  ],
  stack_depth: [
    'ערימה קצרה (מתחת ל-50 בליינדים) - שחק ישר, פחות מקום לתמרן',
    'ערימה עמוקה (מעל 100 בליינדים) - יותר מקום לבלוף ולמשחק מורכב',
  ],
  position_play: [
    'מיקום מאוחר הוא היתרון הגדול ביותר - תראה מה כולם עושים לפניך',
    'ממיקום מוקדם צריך ידיים חזקות יותר כי עוד הרבה שחקנים יפעלו אחריך',
  ],
  preflop_open: [
    'מהכפתור או הקאטאוף אפשר לפתוח עם יותר ידיים - יש יתרון מיקום',
    'גודל הפתיחה צריך להיות עקבי: 2.5-3 בליינדים, כדי לא לחשוף מידע',
  ],
  preflop_vs_raise: [
    'מול העלאה: "האם היד שלי מספיק חזקה להתמודד עם הטווח שלו?"',
    'עם זוג נמוך מול העלאה - קרא רק אם הערימות עמוקות מספיק',
  ],
  odds_math: [
    'סדרה פתוחה משני הצדדים = 8 אאוטים = ~32% עד הריבר, ~17% בקלף אחד',
    'צבע דרו = 9 אאוטים = ~35% עד הריבר, ~19% בקלף אחד',
    'כלל 4 ו-2: אאוטים x4 בפלופ (שני קלפים) או x2 בטרן (קלף אחד) = אחוז בקירוב',
  ],
  true_false: [
    'כלל ה-4: בפלופ (2 קלפים נשארו) — אאוטים × 4 = אחוז הסיכוי',
    'כלל ה-2: בטרן (קלף אחד נשאר) — אאוטים × 2 = אחוז הסיכוי',
    'Pot Odds: הימור ÷ (קופה + הימור) = אחוז מינימלי שצריך',
    'flush draw = 9 אאוטים, open-ended straight = 8, gutshot = 4',
  ],
};

export const getTipsForPlayer = (progress: SharedTrainingProgress): { categoryId: string; categoryName: string; tips: string[] }[] => {
  const weak = Object.entries(progress.byCategory)
    .filter(([, d]) => d.total >= 3 && (d.correct / d.total) < 0.5)
    .sort((a, b) => (a[1].correct / a[1].total) - (b[1].correct / b[1].total))
    .slice(0, 3);

  return weak.map(([catId]) => {
    const cat = SCENARIO_CATEGORIES.find(c => c.id === catId);
    return {
      categoryId: catId,
      categoryName: cat?.name || catId,
      tips: CATEGORY_TIPS[catId] || [],
    };
  });
};

// ── Pool generation (admin) ──

const buildPoolBatchPrompt = (
  category: CategoryInfo,
  count: number,
  existingSummaries: string[]
): string => {
  const avoidContext = existingSummaries.length > 0
    ? `\n\nשאלות שכבר קיימות (תמנע מלחזור עליהן):\n${existingSummaries.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n`
    : '';

  const isTrueFalse = category.id === 'true_false';
  const isOddsMath = category.id === 'odds_math';

  const trueFalseInstructions = isTrueFalse ? `
פורמט נכון/לא נכון:
- כל שאלה מציגה טענה על פוקר שמאתגרת שחקנים מנוסים — מתמטיקה מתקדמת, מלכודות אסטרטגיות, ותפיסות שגויות נפוצות גם בין שחקנים טובים
- 3 אופציות בדיוק: A=נכון, B=לא נכון, C=תלוי ב... (עם הקשר ספציפי)
- הרמה חייבת להיות גבוהה: אל תשאל שאלות בסיסיות על סדר ידיים, כללי משחק פשוטים, או דברים שכל שחקן רגיל יודע. השחקנים כאן מנוסים ומשחקים הרבה זמן יחד
- דוגמאות לרמה הנכונה: חישובי אאוטים מדויקים, אסטרטגיית פוזיציה מתקדמת, pot odds מול implied odds, טעויות שכיחות של שחקנים טובים, מושגים כמו reverse implied odds או fold equity
- דוגמה: situation: "טענה: עם 9 אאוטים בטרן, הסיכוי שלך להשתפר בריבר הוא בערך 35%", yourCards: "" (ריק), options: A=נכון, B=לא נכון (התשובה הנכונה — 19% בלבד), C=תלוי בגודל הקופה
` : '';

  const oddsMathInstructions = isOddsMath ? `
שאלות אחוזים וסיכויים:
- שאלות מתמטיות על פאוטים, סיכויי קופה, אחוזי שיפור
- התשובות הן מספריות/עובדתיות — אין הבדל בין משחק ביתי למקצועי
- דוגמה: "יש לך 4 קלפים לצבע אחרי הפלופ. כמה אאוטים יש לך ומה הסיכוי להשלים צבע עד הריבר?"
- nearMiss לא רלוונטי בקטגוריה הזו
- **חשוב מאוד**: בשאלות אחוזי קופה (pot odds) חייב לציין בבירור אם הכוונה לקופה כולל הקריאה שלך או לפני הקריאה. לדוגמה: "כמה אחוזים מהקופה הכוללת (כולל הקריאה שלך) תשקיע?" או "מה אחוז ההשוואה שלך מהקופה אחרי ההימור?"
- אם שתי אפשרויות תשובה מתאימות לשני חישובים שונים (עם/בלי הקריאה), השאלה לא ברורה מספיק — תקן את הניסוח
` : '';

  return `בנה ${count} שאלות אימון פוקר למשחק ביתי חברתי. עברית פשוטה בלבד.

נושא: **${category.name}** — ${category.description}

${GAME_CONTEXT}

שחקנים קבועים במשחק (השתמש בשמות שלהם ב-~70% מהשאלות כיריבים):
${playerStylesPrompt}

חוקי שימוש בשמות:
- שלב את הסגנון שלהם בטבעיות: "חרדון מהמר 2,000" או "אורן קורא"
- לפעמים שחקן פסיבי יכול להיות אגרסיבי — הסבר למה: "סגל, שבדרך כלל שקט, פתאום מהמר 4,000"
- ~30% מהשאלות בלי שמות (יריב גנרי) כדי לגוון
${trueFalseInstructions}${oddsMathInstructions}

═══ פורמט שאלה — קריטי ═══
כל שאלה מורכבת מ-4 שדות נפרדים:
1. **yourCards** — הקלפים שלך בלבד: "K♠ J♣"
2. **boardCards** — קלפי הלוח (פלופ/טרן/ריבר): "10♦ 8♣ 2♣" או "10♦ 8♣ 2♣ 5♥" (ריק לפני הפלופ)
3. **situation** — טקסט קצר שמתאר רק את הפעולה: מי המר, כמה, גודל קופה, כמה שחקנים, מיקום
   ❌ אסור: לחזור על הקלפים שלך או על הלוח ב-situation — הם מוצגים ויזואלית בנפרד
   ❌ אסור: "יש לך פלאש דרו" — השחקן צריך לזהות את זה בעצמו מהקלפים!
   ✓ נכון: "3 שחקנים בקופה של 2,400. חרדון מהמר 800. מה הפעולה?"
4. **options** — 3 אופציות, אחת נכונה

חוקים:
- situation חייב להיות 1-2 משפטים קצרים בלבד. כל מה שצריך: מי ביד, כמה בקופה, מי המר כמה
- אם מישהו המר → אופציות: קריאה [סכום], העלאה ל-[סכום], ויתור
- אם אף אחד לא המר → אופציות: צ'ק, הימור [סכום], (אול-אין/ויתור)
- "קריאה" = סכום שצריך לשלם, לא סכום הקופה
- כל הסכומים בצ'יפים (לא שקלים)
- כל שאלה חייבת להיות עצמאית — כל המידע הנדרש חייב להופיע

מונחי פוקר:
- פלופ, טרן, ריבר (לא "נהר"), בליינד (לא "עיוור"), ביד (לא "בכיס"), כפתור (לא "מפיץ")
- מונחים באנגלית עם תרגום בסוגריים בפעם הראשונה: Pot Odds (יחס קופה), EV (ערך צפוי), c-bet (הימור המשך) וכו'

nearMiss:
- "nearMiss": true לתשובות שהיו נכונות בפוקר מקצועי אבל לא למשחק ביתי
- ~30-40% מהתשובות השגויות צריכות להיות nearMiss

הסברים:
- קצרים (1-2 משפטים), ספציפיים לקלפים ולמצב
- בשפה של משחק ביתי, לא GTO: "בלוף לא יעבוד — תמיד מישהו קורא", "העלאה בונה קופה — הם ישלמו"
- ❌ אסור: "תדלל/תבודד", "fold equity", לוגיקה מקצועית
${avoidContext}
JSON בלבד, מערך של ${count}:
[{"id":1,"situation":"3 שחקנים בקופה של 2,400. חרדון מהמר 800. מה הפעולה?","yourCards":"K♣ J♣","boardCards":"10♦ 8♣ 2♣","options":[{"id":"A","text":"קריאה 800","isCorrect":true,"explanation":"הסבר קצר"},{"id":"B","text":"העלאה ל-2,500","isCorrect":false,"nearMiss":true,"explanation":"הסבר קצר"},{"id":"C","text":"ויתור","isCorrect":false,"explanation":"הסבר קצר"}],"category":"${category.name}","categoryId":"${category.id}"}]`;
};

const hashScenario = (s: { situation: string; yourCards: string; options: { text: string }[] }): string => {
  const raw = `${s.situation}|${s.yourCards}|${s.options[0]?.text || ''}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash) + raw.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
};

const validatePoolScenario = (s: unknown): s is PoolScenario => {
  const sc = s as Record<string, unknown>;
  if (!sc || typeof sc !== 'object') return false;
  if (typeof sc.situation !== 'string' || !sc.situation) return false;
  if (typeof sc.yourCards !== 'string' || !sc.yourCards) return false;
  if (!Array.isArray(sc.options) || sc.options.length !== 3) return false;
  const opts = sc.options as { id?: string; text?: string; isCorrect?: boolean; explanation?: string }[];
  if (!opts.every(o => o.id && typeof o.text === 'string' && o.text)) return false;
  const correctCount = opts.filter(o => o.isCorrect).length;
  if (correctCount !== 1) return false;
  return true;
};

export const generatePoolBatch = async (
  category: CategoryInfo,
  count: number,
  existingScenarios: PoolScenario[],
  apiKey: string,
): Promise<PoolScenario[]> => {
  const existing = existingScenarios
    .filter(s => s.categoryId === category.id)
    .slice(-15)
    .map(s => `${s.yourCards}: ${s.situation.slice(0, 80)}`);

  const requestCount = count + 5;
  const prompt = buildPoolBatchPrompt(category, requestCount, existing);

  // Pool generation uses only the best model (no fallback to lite) for consistent quality.
  // On rate-limit (429/503), retry same model after a delay instead of downgrading.
  const POOL_MODEL = API_CONFIGS[0];
  const MAX_RETRIES = 2;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const config = POOL_MODEL;
    const modelPath = config.model.startsWith('models/') ? config.model : `models/${config.model}`;
    const url = `https://generativelanguage.googleapis.com/${config.version}/${modelPath}:generateContent?key=${apiKey}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.85,
            topP: 0.95,
            maxOutputTokens: 16384,
            responseMimeType: 'application/json',
          },
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        const msg = (err as { error?: { message?: string } })?.error?.message || `HTTP ${response.status}`;
        if ((response.status === 429 || response.status === 503) && attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, 10000 * (attempt + 1)));
          continue;
        }
        if (response.status === 400 && msg.includes('API key')) throw new Error('INVALID_API_KEY');
        console.warn(`Pool gen [${config.model}] attempt ${attempt}: ${msg}`);
        continue;
      }

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) continue;

      let jsonText = text;
      if (text.includes('```json')) jsonText = text.split('```json')[1].split('```')[0];
      else if (text.includes('```')) jsonText = text.split('```')[1].split('```')[0];

      let rawScenarios: unknown[];
      try {
        const parsed = JSON.parse(jsonText.trim());
        if (!Array.isArray(parsed)) continue;
        rawScenarios = parsed;
      } catch {
        // Truncated JSON — salvage complete objects before the cut-off
        const lastComplete = jsonText.lastIndexOf('}');
        if (lastComplete === -1) continue;
        const salvaged = jsonText.slice(0, lastComplete + 1).trim().replace(/,\s*$/, '') + ']';
        try {
          const parsed = JSON.parse(salvaged.startsWith('[') ? salvaged : '[' + salvaged);
          if (!Array.isArray(parsed)) continue;
          rawScenarios = parsed;
          console.warn(`Pool gen: salvaged ${parsed.length} scenarios from truncated response`);
        } catch {
          continue;
        }
      }

      const existingIds = new Set(existingScenarios.map(s => s.poolId));
      const valid: PoolScenario[] = [];

      for (const raw of rawScenarios) {
        if (!validatePoolScenario(raw)) continue;
        const scenario = raw as PoolScenario;
        scenario.poolId = hashScenario(scenario);
        scenario.categoryId = category.id;
        scenario.category = category.name;
        if (existingIds.has(scenario.poolId)) continue;
        existingIds.add(scenario.poolId);
        valid.push(scenario);
        if (valid.length >= count) break;
      }

      return valid;
    } catch (error) {
      if (error instanceof Error && error.message === 'INVALID_API_KEY') throw error;
      console.error(`Pool gen [${config.model}]:`, error);
      continue;
    }
  }

  return [];
};

// ── Silent tracking upload (batched with cooldown) ──

const PENDING_UPLOAD_KEY = 'shared_training_pending_upload';
const LAST_FLUSH_KEY = 'shared_training_last_flush';
const FLUSH_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes between GitHub pushes

export const bufferSessionForUpload = (playerName: string, session: TrainingSession, pendingMilestone?: number): void => {
  try {
    const raw = localStorage.getItem(PENDING_UPLOAD_KEY);
    const pending: { playerName: string; session: TrainingSession; pendingMilestone?: number }[] = raw ? JSON.parse(raw) : [];
    pending.push({ playerName, session, pendingMilestone });
    localStorage.setItem(PENDING_UPLOAD_KEY, JSON.stringify(pending));
  } catch { /* ignore */ }
};

export const flushPendingUploads = async (keepalive = false): Promise<void> => {
  const raw = localStorage.getItem(PENDING_UPLOAD_KEY);
  if (!raw) return;

  let pending: { playerName: string; session: TrainingSession; pendingMilestone?: number }[];
  try {
    pending = JSON.parse(raw);
  } catch { return; }

  if (pending.length === 0) return;

  // Cooldown: skip if last flush was recent (unless this is a keepalive/unload flush)
  if (!keepalive) {
    const lastFlush = parseInt(localStorage.getItem(LAST_FLUSH_KEY) || '0', 10);
    if (Date.now() - lastFlush < FLUSH_COOLDOWN_MS) return;
  }

  localStorage.removeItem(PENDING_UPLOAD_KEY);

  const ok = await writeTrainingAnswersWithRetry((data: TrainingAnswersFile) => {
    data = normalizeTrainingPlayers(data);

    for (const { playerName, session, pendingMilestone } of pending) {
      const correctedName = LEGACY_NAME_CORRECTIONS[playerName] || playerName;
      let player = data.players.find(p => p.playerName === correctedName);
      if (!player) {
        player = { playerName: correctedName, sessions: [], totalQuestions: 0, totalCorrect: 0, accuracy: 0 };
        data.players.push(player);
      }

      // Deduplicate: skip session if its poolIds already exist in this player's data
      const existingPoolIds = new Set(player.sessions.flatMap(s => s.results.map(r => r.poolId)));
      const newResults = session.results.filter(r => !existingPoolIds.has(r.poolId));
      if (newResults.length > 0) {
        player.sessions.push({ ...session, results: newResults });
      }

      // Bundle pending milestone with the session upload (single atomic write)
      if (pendingMilestone) {
        if (!player.pendingReportMilestones) player.pendingReportMilestones = [];
        if (!player.pendingReportMilestones.includes(pendingMilestone)) {
          player.pendingReportMilestones.push(pendingMilestone);
        }
      }
    }

    // Recalculate all player stats from actual session data
    for (const player of data.players) {
      let scored = 0, corr = 0;
      for (const s of player.sessions) {
        for (const r of s.results) {
          if (r.neutralized) continue;
          if (!r.nearMiss) { scored++; if (r.correct) corr++; }
        }
      }
      player.totalQuestions = scored;
      player.totalCorrect = corr;
      player.accuracy = scored > 0 ? (corr / scored) * 100 : 0;
    }

    data.lastUpdated = new Date().toISOString();
    return data;
  }, keepalive);

  if (ok) {
    localStorage.setItem(LAST_FLUSH_KEY, Date.now().toString());
  } else {
    try {
      const existing = localStorage.getItem(PENDING_UPLOAD_KEY);
      const existingPending = existing ? JSON.parse(existing) : [];
      localStorage.setItem(PENDING_UPLOAD_KEY, JSON.stringify([...pending, ...existingPending]));
    } catch { /* ignore */ }
  }
};

// ── Training data analysis (shared by personal report + admin insights) ──

interface CategoryAnalysis {
  name: string;
  id: string;
  total: number;
  correct: number;
  accuracy: number;
  recentTotal: number;
  recentCorrect: number;
  recentAccuracy: number;
  trend: 'improving' | 'declining' | 'stable' | 'new';
}

interface PlayerAnalysis {
  totalQ: number;
  totalC: number;
  overallAcc: number;
  recentAcc: number;
  improving: boolean;
  categories: CategoryAnalysis[];
  weakest: CategoryAnalysis[];
  strongest: CategoryAnalysis[];
  groupAvg: number;
  ranking: number;
  totalPlayers: number;
  sessionAccuracies: { date: string; acc: number; count: number }[];
  prevReportMilestone: number | null;
  sinceLastReport: { total: number; correct: number; acc: number } | null;
  consistentMistakeCats: string[];
}

export const analyzePlayerTraining = (
  playerData: TrainingPlayerData,
  allPlayers: TrainingPlayerData[],
): PlayerAnalysis => {
  const allResults = playerData.sessions.flatMap(s => s.results).filter(r => !r.nearMiss);
  const totalQ = allResults.length;
  const totalC = allResults.filter(r => r.correct).length;
  const overallAcc = totalQ > 0 ? Math.round((totalC / totalQ) * 100) : 0;

  const midpoint = Math.floor(allResults.length / 2);

  const categories: CategoryAnalysis[] = SCENARIO_CATEGORIES.map(cat => {
    const catResults = allResults.filter(r => r.categoryId === cat.id);
    const total = catResults.length;
    const correct = catResults.filter(r => r.correct).length;
    const accuracy = total > 0 ? Math.round((correct / total) * 100) : -1;

    const catIndices = allResults.map((r, i) => r.categoryId === cat.id ? i : -1).filter(i => i >= 0);
    const recentCatResults = catIndices.filter(i => i >= midpoint).map(i => allResults[i]);
    const oldCatResults = catIndices.filter(i => i < midpoint).map(i => allResults[i]);
    const recentTotal = recentCatResults.length;
    const recentCorrect = recentCatResults.filter(r => r.correct).length;
    const recentAccuracy = recentTotal > 0 ? Math.round((recentCorrect / recentTotal) * 100) : -1;

    const oldAcc = oldCatResults.length > 0 ? Math.round((oldCatResults.filter(r => r.correct).length / oldCatResults.length) * 100) : -1;
    let trend: CategoryAnalysis['trend'] = 'new';
    if (oldAcc >= 0 && recentAccuracy >= 0) {
      const diff = recentAccuracy - oldAcc;
      trend = diff >= 15 ? 'improving' : diff <= -15 ? 'declining' : 'stable';
    }

    return { name: cat.name, id: cat.id, total, correct, accuracy, recentTotal, recentCorrect, recentAccuracy, trend };
  }).filter(c => c.total > 0);

  const weakest = categories.filter(c => c.total >= 3).sort((a, b) => a.accuracy - b.accuracy).slice(0, 4);
  const strongest = categories.filter(c => c.total >= 3 && c.accuracy >= 60).sort((a, b) => b.accuracy - a.accuracy).slice(0, 4);

  const recentResults = allResults.slice(-50);
  const recentAcc = recentResults.length > 0 ? Math.round((recentResults.filter(r => r.correct).length / recentResults.length) * 100) : 0;
  const improving = recentAcc > overallAcc + 3;

  const groupAvg = allPlayers.length > 0
    ? Math.round(allPlayers.filter(p => p.totalQuestions >= 10).reduce((sum, p) => sum + p.accuracy, 0) / Math.max(allPlayers.filter(p => p.totalQuestions >= 10).length, 1))
    : 0;

  const sorted = [...allPlayers].filter(p => p.totalQuestions >= 10).sort((a, b) => b.accuracy - a.accuracy);
  const ranking = sorted.findIndex(p => p.playerName === playerData.playerName) + 1;

  const sessionAccuracies = playerData.sessions.map(s => {
    const scored = s.results.filter(r => !r.nearMiss);
    return {
      date: s.date,
      acc: scored.length > 0 ? Math.round((scored.filter(r => r.correct).length / scored.length) * 100) : 0,
      count: scored.length,
    };
  });

  const prevReport = playerData.reports && playerData.reports.length > 0
    ? playerData.reports[playerData.reports.length - 1].milestone : null;
  let sinceLastReport: PlayerAnalysis['sinceLastReport'] = null;
  if (prevReport && totalQ > prevReport) {
    const sinceResults = allResults.slice(prevReport);
    const sinceCorrect = sinceResults.filter(r => r.correct).length;
    sinceLastReport = { total: sinceResults.length, correct: sinceCorrect, acc: sinceResults.length > 0 ? Math.round((sinceCorrect / sinceResults.length) * 100) : 0 };
  }

  const consistentMistakeCats = categories
    .filter(c => c.total >= 5 && c.accuracy < 50 && (c.trend === 'stable' || c.trend === 'declining'))
    .map(c => c.name);

  return { totalQ, totalC, overallAcc, recentAcc, improving, categories, weakest, strongest, groupAvg, ranking, totalPlayers: sorted.length, sessionAccuracies, prevReportMilestone: prevReport, sinceLastReport, consistentMistakeCats };
};

export const formatAnalysisForPrompt = (a: PlayerAnalysis, playerName: string): string => {
  const catLines = a.categories
    .sort((x, y) => x.accuracy - y.accuracy)
    .map(c => {
      const trendEmoji = c.trend === 'improving' ? '📈' : c.trend === 'declining' ? '📉' : c.trend === 'stable' ? '➡️' : '🆕';
      const trendNote = c.trend === 'improving' ? `(עולה! מחצית ראשונה ${100 - c.recentAccuracy + c.accuracy > 100 ? '' : ''}→ ${c.recentAccuracy}%)` :
                        c.trend === 'declining' ? `(יורד! אחרונות: ${c.recentAccuracy}%)` : '';
      return `${trendEmoji} ${c.name}: ${c.correct}/${c.total} (${c.accuracy}%) ${trendNote}`.trim();
    });

  const sessionTrend = a.sessionAccuracies.length >= 3
    ? a.sessionAccuracies.slice(-5).map(s => `${s.acc}% (${s.count}ש)`).join(' → ')
    : '';

  const lines = [
    `שחקן: ${playerName}`,
    `סה"כ: ${a.totalQ} שאלות, ${a.overallAcc}% דיוק`,
    `50 שאלות אחרונות: ${a.recentAcc}% ${a.improving ? '(מגמת שיפור!)' : a.recentAcc < a.overallAcc - 5 ? '(ירידה)' : ''}`,
    `דירוג: מקום ${a.ranking} מתוך ${a.totalPlayers} שחקנים פעילים`,
    `ממוצע קבוצתי: ${a.groupAvg}%`,
    a.sinceLastReport ? `מאז הדוח הקודם (${a.prevReportMilestone} שאלות): ${a.sinceLastReport.total} שאלות חדשות, ${a.sinceLastReport.acc}% דיוק` : '',
    sessionTrend ? `מגמת אימונים אחרונים: ${sessionTrend}` : '',
    `\nפירוט לפי נושא (מהחלש לחזק):`,
    ...catLines,
    a.consistentMistakeCats.length > 0 ? `\nחולשות עקביות (לא משתפרות): ${a.consistentMistakeCats.join(', ')}` : '',
    a.weakest.length > 0 ? `חלש ביותר: ${a.weakest.map(c => `${c.name} (${c.accuracy}%)`).join(', ')}` : '',
    a.strongest.length > 0 ? `חזק ביותר: ${a.strongest.map(c => `${c.name} (${c.accuracy}%)`).join(', ')}` : '',
  ];
  return lines.filter(Boolean).join('\n');
};

// ── Real game data for AI prompts ──

export const getPlayerGameSummary = (playerName: string): string | null => {
  try {
    const allStats = getPlayerStats();
    const players = getAllPlayers();
    const player = players.find(p => p.name === playerName);
    if (!player) return null;
    const stats = allStats.find(s => s.playerId === player.id);
    if (!stats || stats.gamesPlayed < 3) return null;

    const recentGames = stats.lastGameResults.slice(0, 8);
    const recentProfits = recentGames.map(g => {
      const sign = g.profit >= 0 ? '+' : '';
      return `${sign}${g.profit}`;
    }).join(', ');

    const streakText = stats.currentStreak > 0
      ? `${stats.currentStreak} ניצחונות ברצף`
      : stats.currentStreak < 0
        ? `${Math.abs(stats.currentStreak)} הפסדים ברצף`
        : 'ללא רצף';

    const allStatsRanked = [...allStats].sort((a, b) => b.totalProfit - a.totalProfit);
    const profitRank = allStatsRanked.findIndex(s => s.playerId === player.id) + 1;

    const lines = [
      `\n══ נתוני משחקים אמיתיים ══`,
      `${stats.gamesPlayed} משחקים, רווח כולל: ${stats.totalProfit >= 0 ? '+' : ''}${stats.totalProfit}₪`,
      `דירוג רווח: מקום ${profitRank} מ-${allStatsRanked.length}`,
      `ניצחונות: ${stats.winCount}/${stats.gamesPlayed} (${Math.round(stats.winPercentage)}%)`,
      `ריבאיים למשחק: ${stats.avgRebuysPerGame.toFixed(1)} (סה"כ ${stats.totalRebuys})`,
      `ניצחון ממוצע: +${Math.round(stats.avgWin)}₪ | הפסד ממוצע: -${Math.round(stats.avgLoss)}₪`,
      `שיא רווח: +${stats.biggestWin}₪ | שיא הפסד: ${stats.biggestLoss}₪`,
      `רצף נוכחי: ${streakText}`,
      recentGames.length > 0 ? `${recentGames.length} משחקים אחרונים (₪): ${recentProfits}` : '',
    ];
    return lines.filter(Boolean).join('\n');
  } catch {
    return null;
  }
};

// ── Holistic player coaching (used by admin button + auto milestone) ──

export const generatePlayerCoaching = async (
  playerName: string,
  playerData: TrainingPlayerData,
  allPlayers: TrainingPlayerData[],
): Promise<string | null> => {
  const apiKey = getGeminiApiKey();
  if (!apiKey) return null;

  const a = analyzePlayerTraining(playerData, allPlayers);
  const dataBlock = formatAnalysisForPrompt(a, playerName);
  const gameSummary = getPlayerGameSummary(playerName);
  const playerStyle = PLAYER_STYLES[playerName] || '';

  const prompt = `אתה מאמן פוקר אישי של ${playerName} במשחק ביתי חברתי. כתוב סקירה אישית ומעשית — הוא קורא את זה בעצמו.
עברית בלבד.

═══ נתוני אימון ═══
${dataBlock}
${gameSummary ? `\n${gameSummary}` : ''}
${playerStyle ? `\nסגנון משחק ידוע: ${playerStyle}` : ''}

═══ הנחיות ═══
המטרה: טקסט אישי שמרגיש כמו מאמן שמכיר אותו, לא טיפים גנריים.

מבנה:
1. פתיחה אישית (2-3 משפטים): פנה ל${playerName} בשמו. ציין דירוג בקבוצה, מגמה, וה"סיפור" שלו.${gameSummary ? ` שלב תוצאות אמיתיות: אם מרוויח — ציין שזה בא לידי ביטוי. אם מפסיד — חבר לחולשות.` : ''}

2. חוזקות (2-3 משפטים): הנושאים הטובים ביותר, למה זה עוזר בשולחן.${gameSummary ? ` אם החוזק מסביר הצלחה במשחקים — ציין.` : ''}

3. נקודות לשיפור (3-5 טיפים ממוספרים): כל טיפ חייב לכלול:
   - שם הנושא הספציפי
   - עצה מעשית (מה לעשות בשולחן)${gameSummary ? `\n   - קשר לתוצאות אמיתיות אם רלוונטי` : ''}
   ${a.consistentMistakeCats.length > 0 ? `חולשות עקביות: ${a.consistentMistakeCats.join(', ')} — הדגש שדורשות תשומת לב` : ''}

4. סיכום (1-2 משפטים): יעד קדימה, נימה מעודדת.

חשוב: סיים את כל הסעיפים במלואם — אל תקטע באמצע משפט. אם יש מגבלת אורך, העדף להשלים את רשימת נקודות השיפור לפני הסיכום.

חוקים:
- אל תחזור על מספרים שהוא רואה בטבלה
- כתוב כאילו אתה מכיר אותו אישית
- שלב הומור קל אם מתאים
- אל תציג נתונים כרשימה — שלב טבעית
- בערך 12-18 שורות`;

  try {
    const text = await runGeminiTextPrompt(apiKey, prompt, {
      temperature: 0.8,
      maxOutputTokens: 8192,
      label: 'training_coaching',
    });
    return text || null;
  } catch {
    return null;
  }
};

// ── WhatsApp sharing ──

export const generateLeaderboardText = (players: { playerName: string; accuracy: number; totalQuestions: number }[]): string => {
  const sorted = [...players]
    .filter(p => p.totalQuestions >= 5)
    .sort((a, b) => b.accuracy - a.accuracy || b.totalQuestions - a.totalQuestions);

  const medals = ['🥇', '🥈', '🥉'];
  let text = '🎯 *טבלת אימון פוקר*\n━━━━━━━━━━━━━━━━\n';

  sorted.forEach((p, i) => {
    const medal = medals[i] || `${i + 1}.`;
    text += `${medal} ${p.playerName} — ${p.accuracy.toFixed(0)}% דיוק (${p.totalQuestions} שאלות)\n`;
  });

  text += '━━━━━━━━━━━━━━━━\n💪 מי מצטרף לאימון?';
  return text;
};

export const generateSessionShareText = (
  playerName: string,
  correct: number,
  total: number,
  accuracy: number
): string => {
  const emoji = accuracy >= 70 ? '🏆' : accuracy >= 50 ? '👍' : '💪';
  return `${emoji} *${playerName}* סיים אימון פוקר!\n${correct}/${total} תשובות נכונות (${accuracy.toFixed(0)}%)\n\n💪 מי הבא?`;
};
