import { getGeminiApiKey } from './geminiAI';
import { getPlayerStats, getAllPlayers } from '../database/storage';
import { uploadTrainingToGitHub } from '../database/githubSync';
import { PlayerStats } from '../types';

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

const TABLE_DYNAMICS = `## פרופיל השולחן
- משחק ביתי שבועי, 7-8 שחקנים
- בליינדס קבועים: SB 50 / BB 100 (לא עולים כל הערב)
- Buy-in: 10,000 צ'יפים = ₪30, ריבאי מותר (בהתחלה פעם אחת, בהמשך הערב גם פעמיים)
- טווח תוצאות ממוצע: מינוס ₪200 עד פלוס ₪300
- Pre-flop: כמעט תמיד יש raise (400-800 טיפוסי, עד 1000). Limp נדיר.
- 3-bet: לפעמים, עם range רחב יותר מרק AA/KK
- Looseness: משתנה - לפעמים 2-3 רואים flop, לפעמים 5+
- בלאפים: יש כמה שחקנים שמבלאפים באופן קבוע, הרוב משחקים ישר
- River bets: רציונלי - פולדים בלי יד, קוראים עם משהו
- Big pots (all-in): כמה פעמים בשעה
- כש-5 שחקנים נכנסו על 700, שחקן עם יד חזקה יכול להקפיץ ל-3000/4000
- המשחק נהיה loose יותר לקראת סוף הערב עם stacks גדולים מריבאיים
- Showdowns: מאוזן - חלק מהידיים נגמרות ב-fold, חלק מגיעות ל-showdown`;

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
    style = 'loose-aggressive (LAG)';
    description = `אגרסיבי שקונה הרבה אבל מרוויח. משחק הרבה ידיים ומהמר גדול. ממוצע ${avgRebuysPerGame.toFixed(1)} ריבאיים.`;
  } else if (isHighRebuyer && isLoser) {
    style = 'loose-aggressive (מפסיד)';
    description = `משחק הרבה ידיים ומהמר, אבל מפסיד לאורך זמן. נוטה ל-tilt אחרי ריבאי. ממוצע ${avgRebuysPerGame.toFixed(1)} ריבאיים.`;
  } else if (!isHighRebuyer && isWinner && isHighWinRate) {
    style = 'tight-aggressive (TAG)';
    description = `סולידי - מחכה לידיים טובות ומנצל. ${winPercentage.toFixed(0)}% נצחונות.`;
  } else if (!isHighRebuyer && isWinner && !isHighWinRate) {
    style = 'selective aggressive';
    description = `מרוויח עם אחוז נצחונות בינוני - כשמנצח, מנצח גדול. ממוצע: +₪${avgProfit.toFixed(0)}.`;
  } else if (!isHighRebuyer && isLoser) {
    style = 'tight-passive';
    description = `שמרני, לא קונה הרבה אבל מתקשה להרוויח. ממוצע: ₪${avgProfit.toFixed(0)}.`;
  } else if (isVolatile) {
    style = 'wild/unpredictable';
    description = `תנודתי - נצחון עד +₪${Math.round(biggestWin)} או הפסד עד ₪${Math.round(Math.abs(biggestLoss))}. קשה לקרוא.`;
  } else {
    style = 'balanced';
    description = `מאוזן עם ${gamesPlayed} משחקים. ממוצע: ${avgProfit >= 0 ? '+' : ''}₪${avgProfit.toFixed(0)}.`;
  }

  if (Math.abs(currentStreak) >= 3) {
    const streakText = currentStreak > 0
      ? `ברצף ${currentStreak} נצחונות - ביטחון גבוה`
      : `ברצף ${Math.abs(currentStreak)} הפסדים - עלול להיות ב-tilt`;
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

let _syncTimer: ReturnType<typeof setTimeout> | null = null;

const debouncedSyncToGitHub = () => {
  if (_syncTimer) clearTimeout(_syncTimer);
  _syncTimer = setTimeout(() => {
    uploadTrainingToGitHub().catch(err =>
      console.warn('Training cloud sync failed:', err)
    );
  }, 5000);
};

export const saveTrainingProgress = (progress: TrainingProgress): void => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  debouncedSyncToGitHub();
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

const API_CONFIGS = [
  { version: 'v1beta', model: 'gemini-2.5-flash' },
  { version: 'v1beta', model: 'gemini-2.0-flash' },
  { version: 'v1beta', model: 'gemini-2.5-pro' },
  { version: 'v1beta', model: 'gemini-2.5-flash-lite' },
  { version: 'v1beta', model: 'gemini-2.0-flash-lite' },
];

const buildPrompt = (
  playerProfiles: PlayerProfile[],
  category: CategoryInfo,
  difficulty: 'medium' | 'hard' | 'expert',
  weakCategories: string[]
): string => {
  const allPlayers = getAllPlayers();
  const permNames = new Set(
    allPlayers.filter(p => p.type === 'permanent').map(p => p.name)
  );

  const sortedOpponents = playerProfiles
    .filter(p => p.name !== HERO_NAME)
    .sort((a, b) => {
      const aP = permNames.has(a.name) ? 0 : 1;
      const bP = permNames.has(b.name) ? 0 : 1;
      if (aP !== bP) return aP - bP;
      return b.gamesPlayed - a.gamesPlayed;
    });

  const permanentOpponents = sortedOpponents.filter(p => permNames.has(p.name));
  const otherOpponents = sortedOpponents.filter(p => !permNames.has(p.name));

  const opponents = [
    permanentOpponents.length > 0 ? '### שחקנים קבועים (עדיפות גבוהה - בחר מכאן קודם!)' : '',
    ...permanentOpponents.map(p =>
      `- ${p.name}: ${p.style} | ${p.description} | ${p.gamesPlayed} משחקים, ${p.winRate.toFixed(0)}% נצחונות, ממוצע ${p.avgProfit >= 0 ? '+' : ''}₪${p.avgProfit.toFixed(0)}, ${p.avgRebuys.toFixed(1)} ריבאיים/משחק`
    ),
    otherOpponents.length > 0 ? '\n### שחקנים נוספים (אפשר לשלב לגיוון)' : '',
    ...otherOpponents.map(p =>
      `- ${p.name}: ${p.style} | ${p.description} | ${p.gamesPlayed} משחקים`
    ),
  ].filter(Boolean).join('\n');

  const hero = playerProfiles.find(p => p.name === HERO_NAME);
  const heroLine = hero
    ? `Hero (${HERO_NAME}): ${hero.style} | ${hero.gamesPlayed} משחקים, ${hero.winRate.toFixed(0)}% נצחונות, ממוצע ${hero.avgProfit >= 0 ? '+' : ''}₪${hero.avgProfit.toFixed(0)}`
    : '';

  const difficultyHeb: Record<string, string> = {
    medium: 'בינוני - התשובה הנכונה ברורה למי שחושב, אבל יש מלכודת',
    hard: 'קשה - שתי אופציות קרובות מאוד, ההבדל בא מהכרת היריב או חישוב',
    expert: 'מומחה - המהלך הנכון לא אינטואיטיבי, גם מנוסים יתקשו',
  };

  return `אתה בונה תרגיל פוקר. המטרה: ליצור סיטואציה ריאליסטית מהמשחק הביתי שלנו.

הכל חייב להיות **בעברית פשוטה**. הקורא הוא שחקן חובב.
מילים מותרות: קופה, בליינד, העלאה, קריאה, ויתור, צ'ק, בלוף, שלישייה, זוג, סדרה, צבע, אול-אין, פלופ, טרן, ריבר.
**אסור** להשתמש במונחים באנגלית כמו: equity, EV, SPR, implied odds, range, c-bet, semi-bluff, value bet, OESD, gutshot, TPTK, LAG.
אם צריך להסביר מושג - הסבר במילים פשוטות (למשל: "הסיכוי שלך לנצח" ולא "equity").

---

${TABLE_DYNAMICS}

---

${sortedOpponents.length > 0 ? `## שחקנים (בחר 1-3 יריבים, העדף שחקנים קבועים)
${opponents}` : `## שחקנים
אין נתונים - צור יריבים עם סגנונות שונים (אגרסיבי, שמרני, חופשי) שמתאימים למשחק ביתי.`}

${heroLine ? `## השחקן שלנו\n${heroLine}\n` : ''}

---

## מה לבנות
נושא: **${category.name}** - ${category.description}
רמת קושי: **${difficultyHeb[difficulty]}**
${weakCategories.length > 0 ? `שים דגש על הנקודות החלשות של ${HERO_NAME}: ${weakCategories.join(', ')}\n` : ''}

---

## חוקים קריטיים לעקביות (חשוב מאוד!)

### קלפים
- פורמט: דרגה + סמל. דרגות: A, K, Q, J, 10, 9, 8, 7, 6, 5, 4, 3, 2. סמלים: ♠, ♥, ♦, ♣.
- דוגמאות תקינות: "A♠", "K♥", "10♦", "7♣"
- כל קלף מופיע פעם אחת בלבד! אם A♠ זה קלף של השחקן, הוא לא יכול להופיע על השולחן.
- הפלופ = בדיוק 3 קלפים חדשים. הטרן = בדיוק קלף 1 חדש. הריבר = בדיוק קלף 1 חדש.

### עקביות בין הקלפים לטקסט (הכי חשוב!)
- הקלפים שמופיעים ב-"board" חייבים להיות **בדיוק** אותם קלפים שמתוארים ב-"context".
- אם ב-board כתוב ["K♥", "9♠", "4♦"] אז ב-context חייב לכתוב "ירדו K♥ 9♠ 4♦" - בדיוק אותם קלפים, באותו סדר.
- ב-context של הטרן, תאר רק את הקלף החדש. ב-context של הריבר, תאר רק את הקלף החדש.
- אל תמציא קלפים ב-context שלא מופיעים ב-board ולהיפך!
- **בדוק את עצמך**: אחרי שבנית את ה-JSON, עבור קלף-קלף וודא שהכל תואם.

### אופציות
- כל אופציה חייבת להתאים למצב: אם הקופה היא 5,000 אז אופציה "העלאה ל-2,000" לא הגיונית.
- הסכומים באופציות חייבים להיות הגיוניים ביחס לקופה ולערימה.
- כל אופציה כתובה בעברית פשוטה: "קריאה 800", "העלאה ל-2,400", "ויתור", "צ'ק", "אול-אין".

---

## מבנה
- השחקן שלנו: **${HERO_NAME}**
- בדיוק **2 או 3 רחובות** (שלבים) עם נקודות החלטה
- בכל רחוב: **3 או 4 אופציות**
- בכל רחוב: בדיוק אופציה אחת "best" ולפחות אחת "bad"
- כל רחוב אחרי הראשון מניח שהשחקן בחר את האופציה הטובה ביותר ברחוב הקודם
- פעולות היריבים חייבות להתאים לסגנונם (שחקן אגרסיבי מעלה, שחקן שמרני קורא או מוותר)

## הסברים
כל הסבר (explanation) חייב:
- להתייחס לקלפים הספציפיים שעל השולחן ולקלפים של השחקן
- לתת סיבה מספרית פשוטה כשרלוונטי (כמה בקופה, כמה עולה, מה הסיכוי)
- להזכיר את היריב בשם ולהתייחס לסגנון שלו
- להסביר למה האופציות האחרות פחות טובות
- הכל בעברית פשוטה!

## לקח מרכזי (keyLesson)
- משפט מסכם פשוט ומעשי, ספציפי לסיטואציה
- בעברית פשוטה

## מושגים (concepts)
- רשימה של 2-3 מושגים **בעברית** שהיד לימדה (למשל: "גודל הימור", "קריאת יריב", "מיקום", "בלוף")

---

## פורמט - JSON בלבד, בדיוק ככה:
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
      { "name": "שם", "position": "UTG", "style": "תיאור קצר בעברית", "stack": 15000 }
    ]
  },
  "streets": [
    {
      "name": "preflop",
      "potSize": 1750,
      "context": "תיאור בעברית של מה שקרה. כל הסכומים חייבים להסתכם נכון.",
      "options": [
        { "id": "A", "action": "קריאה 800", "rating": "good", "explanation": "הסבר בעברית פשוטה עם מספרים" },
        { "id": "B", "action": "העלאה ל-2,400", "rating": "best", "explanation": "הסבר בעברית פשוטה" },
        { "id": "C", "action": "ויתור", "rating": "bad", "explanation": "הסבר למה זה לא טוב פה" }
      ]
    },
    {
      "name": "flop",
      "board": ["K♥", "9♠", "4♦"],
      "potSize": 5000,
      "context": "ירדו K♥ 9♠ 4♦. יש לך זוג תשיעיות עם A. [שם היריב] מהמר 2,500.",
      "options": [...]
    },
    {
      "name": "turn",
      "board": ["7♣"],
      "potSize": 10000,
      "context": "הקלף הרביעי הוא 7♣. [תיאור מה קרה]",
      "options": [...]
    }
  ],
  "keyLesson": "לקח מרכזי בעברית פשוטה",
  "concepts": ["מושג 1 בעברית", "מושג 2 בעברית"]
}`;
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

  for (const config of API_CONFIGS) {
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
            topK: 40,
            topP: 0.95,
            maxOutputTokens: 4096,
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
          continue;
        }
        if (response.status === 400 && msg.includes('API key')) {
          throw new Error('INVALID_API_KEY');
        }
        lastError = msg;
        continue;
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

      // Validate and fix card consistency
      const validRanks = new Set(['A','K','Q','J','10','9','8','7','6','5','4','3','2']);
      const validSuits = new Set(['♠','♥','♦','♣']);
      const isValidCard = (c: string) => {
        const suit = c.slice(-1);
        const rank = c.slice(0, -1);
        return validRanks.has(rank) && validSuits.has(suit);
      };

      const allUsedCards = new Set<string>();
      let cardsValid = true;

      // Validate hero cards
      for (const c of hand.setup.yourCards) {
        if (!isValidCard(c)) { cardsValid = false; break; }
        allUsedCards.add(c);
      }

      // Validate board cards - no duplicates with hero cards or between streets
      if (cardsValid) {
        for (const street of hand.streets) {
          if (street.board) {
            for (const c of street.board) {
              if (!isValidCard(c) || allUsedCards.has(c)) { cardsValid = false; break; }
              allUsedCards.add(c);
            }
          }
          if (!cardsValid) break;

          // Validate each street has options with exactly one best
          const bestCount = street.options?.filter(o => o.rating === 'best').length || 0;
          if (bestCount !== 1) {
            console.warn(`Training [${config.model}]: street "${street.name}" has ${bestCount} best options`);
          }
        }
      }

      if (!cardsValid) {
        console.warn(`Training [${config.model}]: card validation failed`, hand);
        lastError = 'Card consistency error';
        continue;
      }

      hand.categoryId = selectedCategory.id;
      hand.difficulty = difficulty;

      return hand;
    } catch (error) {
      if (error instanceof Error && error.message === 'INVALID_API_KEY') {
        throw error;
      }
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`Training [${config.model}]:`, msg);
      lastError = msg;
      continue;
    }
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
  const allPlayers = getAllPlayers();
  const permNames = new Set(
    allPlayers.filter(p => p.type === 'permanent').map(p => p.name)
  );

  const opponentLines = playerProfiles
    .filter(p => p.name !== HERO_NAME)
    .sort((a, b) => {
      const aP = permNames.has(a.name) ? 0 : 1;
      const bP = permNames.has(b.name) ? 0 : 1;
      if (aP !== bP) return aP - bP;
      return b.gamesPlayed - a.gamesPlayed;
    })
    .map(p => `- ${p.name}: ${p.style} | ${p.description}`)
    .join('\n');

  const categoryList = categories.map(c => `- ${c.name}: ${c.description}`).join('\n');

  return `אתה בונה ${count} שאלות אימון פוקר מהירות למשחק הביתי שלנו.

## כללים
- כל שאלה עומדת בפני עצמה - נקודת החלטה אחת בלבד
- הכל בעברית פשוטה וברורה. אסור מונחים באנגלית כמו equity, EV, SPR, range, c-bet וכו'
- מילים מותרות: קופה, בליינד, העלאה, קריאה, ויתור, צ'ק, בלוף, שלישייה, זוג, סדרה, צבע, אול-אין, פלופ, טרן, ריבר
- השחקן שלנו הוא תמיד **${HERO_NAME}**
- השתמש בשחקנים אמיתיים מהרשימה (העדף שחקנים קבועים)
- בדיוק 3 אופציות לכל שאלה, בדיוק אחת נכונה

${TABLE_DYNAMICS}

## שחקנים
${opponentLines || 'אין נתונים - השתמש בשמות גנריים'}

## נושאים (גוון בין הנושאים!)
${categoryList}
${weakCategories.length > 0 ? `\nנקודות חלשות של ${HERO_NAME}: ${weakCategories.join(', ')} - תן להן דגש` : ''}

## מבנה כל שאלה
- situation: תיאור קצר (2-3 משפטים) של הסיטואציה - מה קרה, מה על השולחן, מה עשו היריבים. כולל סכומים.
- yourCards: הקלפים שלך כטקסט (למשל "K♥ 9♠")
- 3 אופציות עם הסבר קצר (2-3 משפטים) למה נכון או לא
- category: שם הנושא מהרשימה

## הסברים
- קצרים אבל ברורים - מספרים, סיבה, התייחסות ליריב
- הסבר למה הנכונה עדיפה ולמה האחרות פחות טובות

## פורמט - JSON בלבד, מערך של ${count} אובייקטים:
[
  {
    "id": 1,
    "situation": "אתה בכפתור (אחרון לדבר) עם ערימה של 12,000. אייל (ראשון) מעלה ל-800 ועוד שניים קוראים. בקופה יש 2,550.",
    "yourCards": "8♠ 8♦",
    "options": [
      { "id": "A", "text": "קריאה 800", "isCorrect": false, "explanation": "קריאה לא מנצלת את המיקום הטוב שלך ואת הזוג. עם 3 שחקנים בקופה, העלאה תבודד ותבנה קופה גדולה יותר." },
      { "id": "B", "text": "העלאה ל-3,000", "isCorrect": true, "explanation": "במיקום האחרון עם זוג שמונות ו-3 שחקנים שנכנסו, העלאה חזקה מבודדת את היריב החלש ובונה קופה. אם תתפוס שלישייה בפלופ, הקופה כבר גדולה." },
      { "id": "C", "text": "ויתור", "isCorrect": false, "explanation": "זוג שמונות מהכפתור זו יד טובה מדי לוותר עליה, במיוחד כשאתה אחרון לדבר ויש כסף בקופה." }
    ],
    "category": "מישהו העלה לפניך",
    "categoryId": "preflop_vs_raise"
  }
]`;
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

  for (const config of API_CONFIGS) {
    const modelPath = config.model.startsWith('models/') ? config.model : `models/${config.model}`;
    const url = `https://generativelanguage.googleapis.com/${config.version}/${modelPath}:generateContent?key=${apiKey}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.9,
            topK: 40,
            topP: 0.95,
            maxOutputTokens: 8192,
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
