import { getGeminiApiKey, API_CONFIGS, getModelDisplayName } from './geminiAI';
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

const POOL_CACHE_KEY = 'training_pool_cached';
const POOL_GENERATED_AT_KEY = 'training_pool_generatedAt';

const getProgressKey = (playerName: string) => `shared_training_progress_${playerName}`;

const DEFAULT_SHARED_PROGRESS: SharedTrainingProgress = {
  totalQuestions: 0,
  totalCorrect: 0,
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

export const rebuildProgressFromRemote = (playerData: TrainingPlayerData): SharedTrainingProgress => {
  const progress: SharedTrainingProgress = { ...DEFAULT_SHARED_PROGRESS };
  progress.totalQuestions = playerData.totalQuestions;
  progress.totalCorrect = playerData.totalCorrect;
  progress.sessionsCompleted = playerData.sessions.length;

  const byCategory: Record<string, { total: number; correct: number }> = {};
  const seenPoolIds = new Set<string>();
  const flaggedPoolIds = new Set<string>();
  let currentCorrectRun = 0;
  let longestCorrectRun = 0;

  const sortedSessions = [...playerData.sessions].sort((a, b) => a.date.localeCompare(b.date));

  for (const session of sortedSessions) {
    for (const r of session.results) {
      if (!byCategory[r.categoryId]) byCategory[r.categoryId] = { total: 0, correct: 0 };
      byCategory[r.categoryId].total++;
      if (r.correct) {
        byCategory[r.categoryId].correct++;
        currentCorrectRun++;
        longestCorrectRun = Math.max(longestCorrectRun, currentCorrectRun);
      } else {
        currentCorrectRun = 0;
      }
      seenPoolIds.add(r.poolId);
    }
    if (session.flaggedPoolIds) {
      session.flaggedPoolIds.forEach(id => flaggedPoolIds.add(id));
    }
  }

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

  if (!pool || !cachedGenAt) {
    const remote = await fetchTrainingPool();
    if (!remote) {
      return { scenarios: [], exhaustedCategory: false, exhaustedAll: false };
    }
    pool = remote;
    localStorage.setItem(POOL_CACHE_KEY, JSON.stringify(pool));
    localStorage.setItem(POOL_GENERATED_AT_KEY, pool.generatedAt);
  } else {
    fetchTrainingPool().then(remote => {
      if (remote && remote.generatedAt !== cachedGenAt) {
        localStorage.setItem(POOL_CACHE_KEY, JSON.stringify(remote));
        localStorage.setItem(POOL_GENERATED_AT_KEY, remote.generatedAt);
      }
    }).catch(() => {});
  }

  const progress = getSharedProgress(playerName);
  const seenSet = new Set(progress.seenPoolIds);

  let available = pool.scenarios.filter(s => !seenSet.has(s.poolId));
  let exhaustedCategory = false;
  let exhaustedAll = false;

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
    available = pool.scenarios;
    if (categoryIds && categoryIds.length > 0) {
      available = available.filter(s => new Set(categoryIds).has(s.categoryId));
    }
    exhaustedAll = true;
  }

  const shuffled = [...available].sort(() => Math.random() - 0.5);
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

  return `בנה ${count} שאלות אימון פוקר למשחק ביתי חברתי. עברית פשוטה בלבד.

נושא: **${category.name}** - ${category.description}

⚠️ הקשר המשחק — חובה להבין לפני שכותבים שאלות:
זהו משחק ביתי חברתי בין חבר'ה קבועים (~8 שחקנים), על סכומים קטנים (כניסה 30 שקלים, בליינדס 50/100, ערימות 8,000-25,000). המאפיינים:
- שחקנים קוראים הרבה יותר ממה שצריך — "פולד" לא פופולרי במשחק ביתי
- בלופים עובדים פחות כי תמיד מישהו יקרא "לראות מה יש לך"
- הרבה יותר פוטים מולטי-ווי (3-5 שחקנים בכל יד)
- שחקנים פחות אגרסיביים לפני הפלופ — הרבה לימפים וקריאות
- פסיכולוגיה של "לא רוצה להפסיד 30 שקלים" — שחקנים משחקים tight כשהם קרובים לאול-אין
- ערך ההימורים נמוך יחסית לקופה — אי אפשר "ללחוץ" על שחקנים כמו בטורניר

התשובות הנכונות חייבות להיות מותאמות למציאות הזו:
- העדף ידיים חזקות על בלופים
- אם "כולם קוראים" → בלוף הוא לא התשובה הנכונה
- הימור ערך שמן עם יד חזקה עדיף על הימור קטן "לשלוף מידע"
- ויתור עם יד בינונית מול העלאה גדולה — תקף גם כשהסכום קטן
- אל תמליץ על מהלכים שדורשים שהיריב ישחק רציונלי/מקצועי

כללים:
- כל שאלה = נקודת החלטה אחת. תאר מה קרה **עד** הרגע שבו השחקן צריך להחליט. **אל תכתוב מה השחקן עושה/מחליט!**
- בדיוק 3 אופציות, בדיוק אחת נכונה
- אסור מונחים באנגלית (equity, EV, SPR, range, c-bet, semi-bluff, value bet וכו')
- יריבים לפי סגנון בלבד ("שחקן שאוהב לקרוא", "שחקן שמרני", "שחקן לוהט שמהמר על הכל"), בלי שמות אמיתיים
- בליינדס 50/100, ערימות 8,000-25,000, העלאות 400-1,000
- כל הסכומים בשקלים (לא דולרים, לא נקודות)

חוקים קריטיים:
- אם מישהו המר → האופציות: קריאה [סכום ההימור], העלאה ל-[סכום], ויתור
- אם אף אחד לא המר → האופציות: צ'ק, הימור [סכום], (אול-אין/ויתור)
- "קריאה" = סכום שצריך לשלם, לא סכום הקופה!

nearMiss — סימון חשוב:
- לחלק מהתשובות השגויות, הוסף "nearMiss": true — אלה תשובות שהיו **נכונות בפוקר מקצועי/טורניר** אבל לא מתאימות למשחק ביתי
- דוגמה: בלוף גדול שהיה עובד מול שחקנים רציונליים, אבל במשחק שלנו שחקנים קוראים → nearMiss
- דוגמה: צ'ק-רייז מתוחכם שדורש שהיריב יבין מה אתה מייצג → nearMiss
- תשובות שהן פשוט שגויות (קריאה עם יד מתה, ויתור עם אגוזים) → בלי nearMiss
- בממוצע ~30-40% מהתשובות השגויות צריכות להיות nearMiss

איכות:
- כל מצב צריך להיות מפורט: 2-4 משפטים שמצוירים תמונה ברורה
- הסברים חייבים להתייחס לקלפים הספציפיים, לגודל הקופה ולסגנון היריב — לא עצות גנריות מספרי פוקר
- ההסבר צריך לדבר בשפה של משחק ביתי: "הוא תמיד קורא אז בלוף לא ישרת אותך", "בסכום הזה עדיף לנסות לראות קלף"
- כשתשובה היא nearMiss, ההסבר צריך לציין: "במשחק מקצועי זה היה מהלך טוב, אבל..." ולהסביר למה במשחק ביתי זה לא עובד
- גם תשובות שגויות צריכות הסבר משכנע למה מישהו היה בוחר בהן
- גוון: מיקומים שונים (UTG/MP/CO/BTN/BB), קלפים שונים, עומקי ערימה שונים, סגנונות יריבים שונים
${avoidContext}
JSON בלבד, מערך של ${count}:
[{"id":1,"situation":"תיאור מפורט 2-4 משפטים","yourCards":"8♠ 8♦","options":[{"id":"A","text":"קריאה 800","isCorrect":false,"nearMiss":true,"explanation":"במשחק מקצועי קריאה הגיונית כי... אבל במשחק שלנו..."},{"id":"B","text":"העלאה ל-3,000","isCorrect":true,"explanation":"הסבר מפורט למה זו התשובה הנכונה"},{"id":"C","text":"ויתור","isCorrect":false,"explanation":"הסבר מפורט למה לוותר פה זו טעות"}],"category":"${category.name}","categoryId":"${category.id}"}]`;
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
  if (!Array.isArray(sc.options) || sc.options.length < 2) return false;
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

// ── Silent tracking upload ──

const PENDING_UPLOAD_KEY = 'shared_training_pending_upload';

export const bufferSessionForUpload = (playerName: string, session: TrainingSession): void => {
  try {
    const raw = localStorage.getItem(PENDING_UPLOAD_KEY);
    const pending: { playerName: string; session: TrainingSession }[] = raw ? JSON.parse(raw) : [];
    pending.push({ playerName, session });
    localStorage.setItem(PENDING_UPLOAD_KEY, JSON.stringify(pending));
  } catch { /* ignore */ }
};

export const flushPendingUploads = async (keepalive = false): Promise<void> => {
  const raw = localStorage.getItem(PENDING_UPLOAD_KEY);
  if (!raw) return;

  let pending: { playerName: string; session: TrainingSession }[];
  try {
    pending = JSON.parse(raw);
  } catch { return; }

  if (pending.length === 0) return;
  localStorage.removeItem(PENDING_UPLOAD_KEY);

  const ok = await writeTrainingAnswersWithRetry((data: TrainingAnswersFile) => {
    for (const { playerName, session } of pending) {
      let player = data.players.find(p => p.playerName === playerName);
      if (!player) {
        player = { playerName, sessions: [], totalQuestions: 0, totalCorrect: 0, accuracy: 0 };
        data.players.push(player);
      }
      player.sessions.push(session);
      player.totalQuestions += session.questionsAnswered;
      player.totalCorrect += session.correctAnswers;
      player.accuracy = player.totalQuestions > 0 ? (player.totalCorrect / player.totalQuestions) * 100 : 0;
    }
    data.lastUpdated = new Date().toISOString();
    return data;
  }, keepalive);

  if (!ok) {
    try {
      const existing = localStorage.getItem(PENDING_UPLOAD_KEY);
      const existingPending = existing ? JSON.parse(existing) : [];
      localStorage.setItem(PENDING_UPLOAD_KEY, JSON.stringify([...pending, ...existingPending]));
    } catch { /* ignore */ }
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
