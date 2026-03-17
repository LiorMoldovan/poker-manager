import { getGeminiApiKey } from './geminiAI';
import { getPlayerStats, getAllPlayers } from '../database/storage';
import { PlayerStats } from '../types';

let lastUsedTrainingModel = '';
export const getLastTrainingModel = () => lastUsedTrainingModel;

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
];

// ════════════════════════════════════════════════════════════
// TABLE DYNAMICS (from conversation analysis)
// ════════════════════════════════════════════════════════════

const TABLE_DYNAMICS = `משחק ביתי: 7-8 שחקנים, בליינדס 50/100 קבועים, ערימות 8,000-25,000. העלאות לפני הפלופ 400-1000. לפעמים 2-3 רואים פלופ, לפעמים 5+. יש בלאפים אבל רוב השחקנים ישרים. אול-אין כמה פעמים בשעה.`;

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
    description = `מרוויח עם אחוז נצחונות בינוני - כשמנצח, מנצח גדול. ממוצע: +₪${avgProfit.toFixed(0)}.`;
  } else if (!isHighRebuyer && isLoser) {
    style = 'שמרני';
    description = `לא קונה הרבה אבל מתקשה להרוויח. ממוצע: ₪${avgProfit.toFixed(0)}.`;
  } else if (isVolatile) {
    style = 'תנודתי';
    description = `נצחון עד +₪${Math.round(biggestWin)} או הפסד עד ₪${Math.round(Math.abs(biggestLoss))}. קשה לקרוא.`;
  } else {
    style = 'מאוזן';
    description = `${gamesPlayed} משחקים. ממוצע: ${avgProfit >= 0 ? '+' : ''}₪${avgProfit.toFixed(0)}.`;
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

const FULL_MODE_MODELS = [
  { version: 'v1beta', model: 'gemini-3-flash-preview' },
  { version: 'v1beta', model: 'gemini-3.1-flash-lite-preview' },
  { version: 'v1beta', model: 'gemini-2.5-flash' },
  { version: 'v1beta', model: 'gemini-2.5-flash-lite' },
];

const QUICK_MODE_MODELS = [
  { version: 'v1beta', model: 'gemini-3.1-flash-lite-preview' },
  { version: 'v1beta', model: 'gemini-2.5-flash-lite' },
  { version: 'v1beta', model: 'gemini-2.5-flash' },
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
