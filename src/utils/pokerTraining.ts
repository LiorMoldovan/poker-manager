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

// ════════════════════════════════════════════════════════════
// CONSTANTS
// ════════════════════════════════════════════════════════════

export const HERO_NAME = 'ליאור';
const STORAGE_KEY = 'poker_training_progress';

export const SCENARIO_CATEGORIES: CategoryInfo[] = [
  // Draw & Board Texture
  { id: 'wet_board_top_pair', name: 'Top Pair על בורד רטוב', description: 'TPTK כשיש flush/straight draws על הבורד', icon: '🌊' },
  { id: 'flush_draw', name: 'Flush Draw', description: '4 לצבע אחרי הפלופ - semi-bluff? check-call?', icon: '♠️' },
  { id: 'straight_draw', name: 'Straight Draw', description: 'OESD או gutshot - אגרסיביות או זהירות?', icon: '🔗' },
  { id: 'missed_draw', name: 'Missed Draw בריבר', description: 'רדפת draw ופספסת - bluff או ויתור?', icon: '💨' },
  // Hand Strength Decisions
  { id: 'medium_pairs', name: 'זוגות בינוניים', description: '77-TT כשקלפים גבוהים יורדים', icon: '🎯' },
  { id: 'dominated_hands', name: 'ידיים דומיננטיות', description: 'A9o, KJo, QTo - יכולות להיות שניות', icon: '⚠️' },
  { id: 'set_mining', name: 'Set Mining', description: '22-66 מול raise - call לset value או fold?', icon: '⛏️' },
  { id: 'second_pair', name: 'זוג שני / אמצעי', description: 'פגעת זוג אמצעי - מספיק טוב? מתי לוותר?', icon: '🥈' },
  { id: 'two_pair_plus', name: 'יד חזקה על בורד מסוכן', description: 'Two pair או set כשיש draws - להגן או לצמוח?', icon: '🛡️' },
  // Bet Sizing & Aggression
  { id: 'cbet', name: 'C-Bet', description: 'עשית raise לפני הflop - מתי להמשיך להמר ומתי לוותר?', icon: '🎪' },
  { id: 'thin_value', name: 'Thin Value בריבר', description: 'יד שולית - לחלוב value או check-behind?', icon: '🪙' },
  { id: 'slow_play', name: 'Slow Play', description: 'יד מפלצתית - לשחק מהר או ללכוד עם check?', icon: '🐌' },
  { id: 'overbet', name: 'Overbet', description: 'הימור מעל גודל הקופה - פולרייז מקסימלי', icon: '💥' },
  // Reading & Reacting
  { id: 'bluff_catching', name: 'Bluff Catching', description: 'הימור גדול על קלף מפחיד - hero call?', icon: '🕵️' },
  { id: 'pot_odds', name: 'Pot Odds', description: 'facing bet עם draw - המתמטיקה אומרת call?', icon: '🔢' },
  { id: 'check_raise', name: 'Check-Raise', description: 'מתי ללכוד עם check-raise ומתי להוביל', icon: '🪤' },
  // Structural Spots
  { id: 'multiway_pots', name: 'Multi-Way Pots', description: 'אותה יד משתנה ב-4-way vs heads-up', icon: '👥' },
  { id: 'three_bet_pots', name: '3-Bet Pots', description: 'קופות מנופחות עם ranges צרים', icon: '💣' },
  { id: 'squeeze_isolation', name: 'Squeeze & Isolation', description: '3+ limpers/callers - מתי לעשות squeeze?', icon: '🗜️' },
  { id: 'blind_defense', name: 'הגנה מהבליינד', description: 'raise מול ה-BB/SB שלך - call, 3-bet או fold?', icon: '🏰' },
  { id: 'stack_depth', name: 'Stack Depth', description: 'short stack vs deep stack - שינוי אסטרטגיה', icon: '📏' },
  { id: 'position_play', name: 'ניצול פוזיציה', description: 'IP vs OOP - איך הפוזיציה משנה את ההחלטה?', icon: '📍' },
  // Preflop
  { id: 'preflop_open', name: 'פתיחה Preflop', description: 'מה לפתוח מכל פוזיציה, כמה להעלות, ומתי לוותר על ידיים שוליות כמו KTo, A8o, QJs', icon: '🚪' },
  { id: 'preflop_vs_raise', name: 'Facing Raise Preflop', description: 'מישהו raise ואולי עוד callers - מה לעשות עם זוג נמוך, יד פרימיום, suited connectors, ידיים בינוניות כמו AJo/KQo? call, 3-bet, fold?', icon: '🤔' },
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

  const diffGuide: Record<string, string> = {
    medium: 'האופציה הטובה ביותר ברורה לשחקן חושב, אבל יש מלכודת מפתה. 60-70% יצליחו.',
    hard: 'שתי אופציות קרובות מאוד ב-EV. ההבדל בא מ-reads ספציפיים או חישוב מדויק. 40-50% יצליחו.',
    expert: 'המהלך הטוב ביותר counter-intuitive או דורש חשיבה מרובת רמות. גם מנוסים חלוקים. 20-30% יבחרו נכון.',
  };

  return `אתה מאמן פוקר מקצועי ברמה גבוהה מאוד. תכין יד תרגול שלמה עבור משחק ביתי ספציפי.

${TABLE_DYNAMICS}

${sortedOpponents.length > 0 ? `## יריבים אפשריים (בחר 1-3 מהרשימה)
**חשוב: העדף תמיד שחקנים קבועים כיריבים!** הנתונים שלהם עשירים ומעודכנים - השתמש בסגנון המשחק שלהם (aggressive/passive, tight/loose, bluff frequency) כדי לבנות תרחיש ריאליסטי. שחקנים נוספים (אורחים) רק לגיוון מדי פעם.
${opponents}` : `## יריבים
אין נתוני שחקנים זמינים עדיין. צור יריבים גנריים עם סגנונות משחק מגוונים (tight, loose, aggressive, passive) שמתאימים למשחק ביתי.`}

${heroLine ? `## ה-Hero\n${heroLine}\n` : ''}

## המשימה
צור יד פוקר שלמה ומאתגרת.
קטגוריה: **${category.name}** - ${category.description}
רמת קושי: **${difficulty}** - ${diffGuide[difficulty]}

## כללי מבנה
1. ה-hero הוא תמיד **${HERO_NAME}**
2. חייבים להיות **2-3 streets** עם נקודות החלטה (לא 1, לא 4)
3. בחר 1-3 יריבים מהרשימה - פעולותיהם חייבות להתאים לסגנונם:
   • שחקן aggressive → מעלה, מהמר, 3-bet
   • שחקן tight-passive → call או fold, לא מעלה בלי יד חזקה
   • שחקן LAG → פותח range רחב, מעלה הרבה
4. **בדיוק 3 או 4 אופציות** לכל street
5. בדיוק **אחד 'best'** לכל street, לפחות אחד **'bad'**
6. אחרי ה-flop, ה-context של כל street מספר מה קרה (כאילו ה-hero שיחק את ה-best מהstreet הקודם)

## ריאליזם חובה (מבוסס נתוני אמת מעודכנים!)
- Raises: 400-1000 pre-flop (3x-10x BB)
- Stacks: 8,000-25,000 צ'יפים (1-2.5 buy-ins)
- Board texture חייב ליצור את המתח של הקטגוריה (${category.id})
- ידיים ריאליסטיות, לא נדירות
- סכומים שמתאימים ל-pot ול-stacks

## הסברים מקצועיים (הכי חשוב!)
כל explanation חייב לכלול:
- מושג ספציפי: pot odds עם %, equity מדויק, SPR, implied odds
- התייחסות ליריב: "נגד [שם] שהוא [סגנון], ה-range שלו כאן כולל..."
- התאמה לשולחן: "בשולחן שלנו..." / "נגד שחקנים כאלה..."
- **לא עצות גנריות!** הכל מותאם ליריבים ולדינמיקה
- הסבר למה האופציות האחרות פחות טובות

## שפה
- עברית עם מונחי פוקר באנגלית: c-bet, pot odds, equity, check-raise, fold, call, raise, all-in, semi-bluff, value bet, range, SPR, implied odds, EV
- ה-context של כל street כתוב כסיפור קצר וקולח

## Key Lesson
- משפט מסכם מעשי ואפליקטיבי: "בשולחן שלנו כש..." / "נגד שחקן [סגנון]..."
- לא גנרי! ספציפי לסיטואציה

${weakCategories.length > 0 ? `## הערה: הקטגוריות החלשות של ${HERO_NAME}: ${weakCategories.join(', ')} - שים דגש על הטעויות הנפוצות בתחום\n` : ''}

## פורמט Output - JSON בלבד, בדיוק במבנה הזה:
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
      { "name": "שם מהרשימה", "position": "UTG", "style": "סגנון", "stack": 15000 }
    ]
  },
  "streets": [
    {
      "name": "preflop",
      "potSize": 1750,
      "context": "תיאור מה קרה עד עכשיו",
      "options": [
        { "id": "A", "action": "Call 800", "rating": "good", "explanation": "הסבר מקצועי מפורט" },
        { "id": "B", "action": "Raise ל-2,400", "rating": "best", "explanation": "הסבר מקצועי מפורט" },
        { "id": "C", "action": "Fold", "rating": "ok", "explanation": "הסבר" },
        { "id": "D", "action": "All-in", "rating": "bad", "explanation": "הסבר למה זה רע" }
      ]
    },
    {
      "name": "flop",
      "board": ["K♥", "9♠", "4♦"],
      "potSize": 5000,
      "context": "הפלופ יורד K♥ 9♠ 4♦. יש לך top pair...",
      "options": [...]
    }
  ],
  "keyLesson": "לקח מרכזי מעשי",
  "concepts": ["pot odds", "semi-bluff", "position"]
}

קלפים: A/K/Q/J/10/9/8/7/6/5/4/3/2 + ♠/♥/♦/♣
Board: flop = 3 קלפים, turn = 1 חדש, river = 1 חדש`;
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
