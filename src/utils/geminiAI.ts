/**
 * Google Gemini AI Integration for Poker Forecasts
 * Get your API key at: https://aistudio.google.com/app/apikey
 */

import { generateMilestones as generateMilestonesEngine } from './milestones';
import { formatHebrewHalf } from './calculations';
import { Game, PeriodMarkers, PlayerStats, LiveGameTTSPool, TTSPlayerMessages, TTSMessage, TTSRivalry, PlayerTraits, TTSPlaceholder, TTSAnticipatedCategory, ChipValue, PhotoChipCountResult, PhotoChipCountStack, PhotoChipCountErrorCode } from '../types';
import { getTraitsForPlayer } from './playerTraits';
import { getAllPlayerTraits } from '../database/storage';
import { getRebuyRecords, isPlayerFemale, getAllPlayers, getAllGames, getAllGamePlayers, getSettings } from '../database/storage';
import { getComboHistory } from './comboHistory';
import { fetchTrainingAnswers } from '../database/trainingData';
import { recordSuccess, recordRateLimit, readRateLimitHeaders } from './aiUsageTracker';
import { proxyGeminiGenerate, proxyGeminiGenerateWithSignal, proxyGeminiModels, pollinationsImage } from './apiProxy';
import { isGeminiEnabledForCurrentGroup } from './aiEligibility';
import { getLocalGeminiKey } from './localApiKey';
import { getComicStyle } from './comicStyles';
import type { ComicScript, ComicStyleKey, ComicPanel } from '../types';
import { logChipCountAttempt, type ChipCountDebugContext, type ChipCountDebugOutcome } from './chipCountDebug';
// `ChipCountDebugOutcome` is used inside `runWholePhotoShot.logAttempt`'s
// signature. The import is type-only so it has no runtime cost.

// v5.62 — DownscaledImage, RGB, HSL, DetectStackRegionsResult imports
// removed alongside the per-stack pipeline they served. The whole-photo
// counter operates directly on the base64 the modal hands us.

/** Clamp a numeric value to a closed range. Locally re-introduced after
 *  the per-stack pipeline (where it lived) was deleted. */
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// Models ordered by quality — cascading fallback from best to lightest.
// On rate-limit (429) or not-found (404), the next model is tried automatically.
export const API_CONFIGS = [
  { version: 'v1beta', model: 'gemini-3-flash-preview' },
  { version: 'v1beta', model: 'gemini-3.1-flash-lite' },
  { version: 'v1beta', model: 'gemini-2.5-flash' },
];

// Friendly display names for UI badge
export const MODEL_DISPLAY_NAMES: Record<string, string> = {
  'gemini-3-flash-preview': '3 Flash',
  'gemini-3.1-flash-lite': '3.1 Flash-Lite',
  'gemini-2.5-flash': '2.5 Flash',
  'gemini-2.5-pro': '2.5 Pro',
  // Comic image provider — Pollinations (anonymous, free).
  'pollinations/flux': 'FLUX',
  'pollinations/zimage': 'Pollinations',
};

export const getModelDisplayName = (model: string): string =>
  MODEL_DISPLAY_NAMES[model] || model;

// Track which model last succeeded (readable by UI for display)
let lastUsedModel = '';
export const getLastUsedModel = () => lastUsedModel;

interface FallbackCallOptions {
  prompt: string;
  apiKey: string;
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  responseMimeType?: string;
  label?: string;
}

/**
 * Centralized Gemini API call with automatic model fallback.
 * Tries each model in API_CONFIGS order; on 429/404/503/SAFETY/empty, falls back to the next.
 * Returns { text, model } on success, throws on total failure.
 */
const callWithFallback = async (opts: FallbackCallOptions): Promise<{ text: string; model: string; usage?: Record<string, number> }> => {
  if (!navigator.onLine) {
    throw new Error('אין חיבור לאינטרנט — לא ניתן להפעיל AI');
  }
  const { prompt, apiKey, temperature = 0.7, maxOutputTokens = 4096, topP, topK, responseMimeType, label = 'AI' } = opts;
  let lastError = '';
  let fallbackFrom: string | undefined;

  for (const config of API_CONFIGS) {
    console.log(`   ${label}: trying ${config.model}...`);

    try {
      const genConfig: Record<string, unknown> = { temperature, maxOutputTokens };
      if (topP !== undefined) genConfig.topP = topP;
      if (topK !== undefined) genConfig.topK = topK;
      if (responseMimeType) genConfig.responseMimeType = responseMimeType;

      const response = await proxyGeminiGenerate(config.version, config.model, apiKey, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: genConfig,
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        const errMsg = errData?.error?.message || `Status ${response.status}`;
        const errCode = errData?.error?.code;
        console.warn(`   ${label}: ${config.model} failed: ${errMsg}`);
        lastError = errMsg;
        // Server-side gate: this group has no Gemini key configured AND
        // isn't the platform-owner group, so the proxy refused the call
        // (see `api/gemini.ts` v5.60.3+). Every fallback model would fail
        // the same way — fail fast with the canonical NO_API_KEY sentinel
        // so the calling screen renders the friendly "set your key" notice
        // instead of cycling through retries and surfacing a red error.
        if (response.status === 403 && (errCode === 'aiKeyRequired' || errMsg.includes('Gemini API key'))) {
          throw new Error('NO_API_KEY');
        }
        // Synthesized 503 from `apiProxy.ts` when the /api/* Edge Function
        // route doesn't exist in this environment (typically: localhost dev
        // server). Every fallback model would hit the same wall — fail fast
        // with a clean sentinel so the calling screen renders the
        // "AI proxy unavailable" notice instead of cycling through retries.
        if (response.status === 503 && errCode === 'aiProxyUnavailable') {
          throw new Error('AI_PROXY_UNAVAILABLE');
        }
        if (response.status === 429) {
          const rlHeaders = readRateLimitHeaders(response);
          recordRateLimit(config.model, rlHeaders, errMsg);
          if (!fallbackFrom) fallbackFrom = config.model;
          continue;
        }
        if (response.status === 404 || response.status === 503) {
          if (!fallbackFrom) fallbackFrom = config.model;
          continue;
        }
        if (response.status === 400 && errMsg.includes('API key')) throw new Error('INVALID_API_KEY');
        continue;
      }

      const data = await response.json();
      const candidate = data?.candidates?.[0];
      const finishReason = candidate?.finishReason;

      if (finishReason === 'SAFETY') {
        console.warn(`   ${label}: ${config.model} blocked by safety filter`);
        lastError = 'Safety filter';
        continue;
      }

      const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
      const text = parts
        .map((p: { text?: string }) => (typeof p?.text === 'string' ? p.text : ''))
        .join('')
        .trim();

      if (finishReason === 'MAX_TOKENS') {
        if (text.length >= 60) {
          console.warn(`   ${label}: ${config.model} MAX_TOKENS — נשמר טקסט חלקי (${text.length} תווים)`);
          lastUsedModel = config.model;
          const usage = data?.usageMetadata ? {
            promptTokens: data.usageMetadata.promptTokenCount || 0,
            outputTokens: data.usageMetadata.candidatesTokenCount || 0,
            thinkingTokens: data.usageMetadata.thoughtsTokenCount || 0,
            totalTokens: data.usageMetadata.totalTokenCount || 0,
          } : undefined;
          const rlHeaders = readRateLimitHeaders(response);
          recordSuccess(config.model, label, usage?.totalTokens, fallbackFrom, rlHeaders);
          return { text, model: config.model, usage };
        }
        console.warn(`   ${label}: ${config.model} hit token limit with empty/short output, trying next`);
        lastError = 'Token limit exceeded';
        continue;
      }

      if (!text) {
        console.warn(`   ${label}: ${config.model} returned empty response`);
        lastError = 'Empty response';
        continue;
      }

      console.log(`   ${label}: ✅ ${config.model} responded (${text.length} chars)`);
      lastUsedModel = config.model;

      const usage = data?.usageMetadata ? {
        promptTokens: data.usageMetadata.promptTokenCount || 0,
        outputTokens: data.usageMetadata.candidatesTokenCount || 0,
        thinkingTokens: data.usageMetadata.thoughtsTokenCount || 0,
        totalTokens: data.usageMetadata.totalTokenCount || 0,
      } : undefined;

      const rlHeaders = readRateLimitHeaders(response);
      recordSuccess(config.model, label, usage?.totalTokens, fallbackFrom, rlHeaders);

      return { text, model: config.model, usage };
    } catch (err) {
      if (err instanceof Error && (
        err.message === 'INVALID_API_KEY' ||
        err.message === 'NO_API_KEY' ||
        err.message === 'AI_PROXY_UNAVAILABLE'
      )) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`   ${label}: ${config.model} error: ${msg}`);
      lastError = msg;
      continue;
    }
  }

  throw new Error(`ALL_MODELS_FAILED: ${lastError}`);
};

export interface RunGeminiTextOptions {
  temperature?: number;
  maxOutputTokens?: number;
  label?: string;
  /** כשמוגדר (למשל application/json) — מכוון את המודל לפלט מובנה; עובר ל-callWithFallback */
  responseMimeType?: string;
  topP?: number;
  topK?: number;
}

/** Probability that ANY trait block is included on a given AI call.
 * Lower = AI text anchored less often on player personality, more on game data. */
const TRAIT_BLOCK_INCLUSION_PROBABILITY = 0.7;

/** Probability that the trait subset includes 2 players instead of 1, when traits ARE included.
 * Lower = each trait surfacing is lighter (1 player getting flavor, not 2). */
const TRAIT_BLOCK_TWO_PLAYER_PROBABILITY = 0.4;

/** Pick which players (if any) should have their traits surfaced for this AI call.
 * Returns null when traits should be skipped entirely so AI text varies week-to-week
 * instead of leaning on the same personality blurbs every time. */
export function selectTraitPlayers(playerNames: string[]): string[] | null {
  if (Math.random() >= TRAIT_BLOCK_INCLUSION_PROBABILITY) return null;
  const allTraits = getAllPlayerTraits();
  if (allTraits.size === 0) return null;
  const withTraits = playerNames.filter(n => allTraits.has(n));
  if (withTraits.length === 0) return null;
  const wantTwo = Math.random() < TRAIT_BLOCK_TWO_PLAYER_PROBABILITY;
  const count = Math.min(withTraits.length, wantTwo ? 2 : 1);
  const shuffled = [...withTraits].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

/** Build a compact trait block for AI prompts. Returns empty string most of the time —
 * when present, only includes 1-2 random players' traits as light flavor, never the full roster.
 * This deliberately under-supplies the AI so personality blurbs don't dominate every generation. */
function buildTraitBlock(playerNames: string[]): string {
  const selected = selectTraitPlayers(playerNames);
  if (!selected) return '';
  const allTraits = getAllPlayerTraits();
  const lines: string[] = [];
  for (const name of selected) {
    const t = allTraits.get(name);
    if (!t) continue;
    const parts: string[] = [];
    if (t.nickname) parts.push(`כינוי "${t.nickname}"`);
    if (t.job) parts.push(t.job);
    if (t.team) parts.push(`אוהד ${t.team}`);
    if (t.style.length > 0) parts.push(`סגנון: ${t.style.join('/')}`);
    if (t.quirks.length > 0) parts.push(`תכונות: ${t.quirks.join(', ')}`);
    if (parts.length > 0) lines.push(`${name}: ${parts.join(', ')}`);
  }
  if (lines.length === 0) return '';
  return `\n--- רמז אופציונלי על שחקן/ים (השתמש רק אם זה באמת מוסיף ערך, אחרת התעלם) ---\n${lines.join('\n')}\n---\n`;
}

/** Plain-text Gemini call with model fallback (used by training admin, coaching, etc.). */
export async function runGeminiTextPrompt(
  apiKey: string,
  prompt: string,
  options?: RunGeminiTextOptions,
): Promise<string> {
  const result = await callWithFallback({
    prompt,
    apiKey,
    temperature: options?.temperature ?? 0.7,
    maxOutputTokens: options?.maxOutputTokens ?? 8192,
    topP: options?.topP,
    topK: options?.topK,
    responseMimeType: options?.responseMimeType,
    label: options?.label ?? 'gemini_text',
  });
  return result.text;
}

export const isOnline = (): boolean => navigator.onLine;

// Returns a usable signal that AI calls will work for the CURRENT group:
//   - The group's own per-group key when set (trimmed, non-empty).
//   - The sentinel `'server-managed'` when the current group is the
//     platform-owner group (`VITE_OWNER_GROUP_ID`) — in that case the
//     proxy can omit the key and the server falls back to the platform
//     `GEMINI_API_KEY` env var.
//   - `null` for every other group without its own key — AI affordances
//     across the UI must hide/disable, because the server will refuse
//     the call. (Pre-v5.60.3 this returned `'server-managed'` for ALL
//     groups, which silently drained the platform owner's quota for any
//     group that hadn't set its own key — the bug this comment was
//     written to remember not to reintroduce.)
export const getGeminiApiKey = (): string | null => {
  // Device-local personal key takes priority over the shared group key.
  const local = getLocalGeminiKey();
  if (local) return local;
  const key = getSettings()?.geminiApiKey;
  if (key && key.trim()) return key;
  return isGeminiEnabledForCurrentGroup() ? 'server-managed' : null;
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
  gameHistory: { profit: number; date: string; gameId: string; location?: string }[];
  daysSinceLastGame: number;
  isActive: boolean; // played in last 2 months
}

export interface ForecastResult {
  name: string;
  expectedProfit: number;
  highlight: string;
  sentence: string;
  isSurprise: boolean;
  preGameTeaser?: string;
}

export type { MilestoneItem } from '../types';
export { generateMilestones, adaptForecastData, getSentimentColors } from './milestones';

const HEBREW_MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

export const detectPeriodMarkers = (
  gameDate: Date,
  allGames: Game[],
  gameNightDays: number[] = [4, 6]
): PeriodMarkers => {
  const year = gameDate.getFullYear();
  const month = gameDate.getMonth();
  const half: 1 | 2 = month < 6 ? 1 : 2;
  const halfEndMonth = half === 1 ? 5 : 11;

  const completedGames = allGames.filter(g => g.status === 'completed');

  const isSameMonth = (d: Date) => d.getFullYear() === year && d.getMonth() === month;
  const isSameHalf = (d: Date) => d.getFullYear() === year && (d.getMonth() < 6 ? 1 : 2) === half;
  const isSameYear = (d: Date) => d.getFullYear() === year;

  const gamesBeforeInMonth = completedGames.filter(g => {
    const d = new Date(g.date || g.createdAt);
    return isSameMonth(d) && d < gameDate;
  });
  const gamesBeforeInHalf = completedGames.filter(g => {
    const d = new Date(g.date || g.createdAt);
    return isSameHalf(d) && d < gameDate;
  });
  const gamesBeforeInYear = completedGames.filter(g => {
    const d = new Date(g.date || g.createdAt);
    return isSameYear(d) && d < gameDate;
  });

  const hasRemainingGameNight = (afterDate: Date, endMonth: number, endYear: number): boolean => {
    const d = new Date(afterDate);
    d.setDate(d.getDate() + 1);
    const endDate = new Date(endYear, endMonth + 1, 0, 23, 59, 59);
    while (d <= endDate) {
      if (gameNightDays.includes(d.getDay())) return true;
      d.setDate(d.getDate() + 1);
    }
    return false;
  };

  return {
    isFirstGameOfMonth: gamesBeforeInMonth.length === 0,
    isLastGameOfMonth: !hasRemainingGameNight(gameDate, month, year),
    isFirstGameOfHalf: gamesBeforeInHalf.length === 0,
    isLastGameOfHalf: !hasRemainingGameNight(gameDate, halfEndMonth, year),
    isFirstGameOfYear: gamesBeforeInYear.length === 0,
    isLastGameOfYear: !hasRemainingGameNight(gameDate, 11, year),
    monthName: HEBREW_MONTHS[month],
    halfLabel: formatHebrewHalf(half, year),
    year,
  };
};

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
 * Analyze location data and return insights only when genuinely interesting.
 * Returns an empty string if location is absent, insufficient data, or nothing notable.
 */
export const buildLocationInsights = (
  players: { name: string; gameHistory: { profit: number; date: string; location?: string }[]; avgProfit: number }[],
  location?: string,
  allGamesWithLocations?: { location?: string; date: string }[]
): string => {
  if (!location) return '';

  const insights: string[] = [];

  // Per-player: compare performance at this location vs overall (need >= 3 games)
  for (const p of players) {
    const gamesHere = p.gameHistory.filter(g => g.location === location);
    if (gamesHere.length < 3) continue;
    const avgHere = Math.round(gamesHere.reduce((s, g) => s + g.profit, 0) / gamesHere.length);
    const overallAvg = Math.round(p.avgProfit);
    const diff = avgHere - overallAvg;
    if (Math.abs(diff) >= 20) {
      const tag = diff > 0 ? 'קמע' : 'מקולל';
      insights.push(`${p.name} ${tag} אצל ${location}: ממוצע ${avgHere >= 0 ? '+' : ''}${avgHere} ב-${gamesHere.length} משחקים (לעומת ${overallAvg >= 0 ? '+' : ''}${overallAvg} כלל)`);
    }
  }

  // Group-level: haven't played here in a while?
  if (allGamesWithLocations) {
    const gamesAtLoc = allGamesWithLocations
      .filter(g => g.location === location)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    if (gamesAtLoc.length > 0) {
      const lastDate = new Date(gamesAtLoc[0].date);
      const daysSince = Math.round((Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
      if (daysSince > 30) {
        insights.push(`חזרה אצל ${location} אחרי ${daysSince} יום! פעם אחרונה: ${lastDate.toLocaleDateString('he-IL', { day: 'numeric', month: 'short' })}`);
      }
    } else {
      insights.push(`פעם ראשונה שהקבוצה משחקת אצל ${location}!`);
    }

  }

  if (insights.length === 0) return '';
  return `🏠 תובנות מיקום (אצל ${location}):\n${insights.join('\n')}`;
};

/**
 * Same logic as Graphs → Impact: avg profit when another tonight's player was in the game vs not.
 * Used only as prompt context (does not change locked numeric forecasts — keeps zero-sum stable).
 */
const buildTonightRosterImpactLines = (tonightNames: string[]): string => {
  const allPlayers = getAllPlayers();
  const idByName = new Map(allPlayers.map(p => [p.name, p.id]));
  const tonightIds = [...new Set(tonightNames.map(n => idByName.get(n)).filter(Boolean) as string[])];
  if (tonightIds.length < 2) return '';

  const games = getAllGames().filter(g => g.status === 'completed');
  const allGp = getAllGamePlayers();

  const lines: string[] = [];
  const minSide = 2;
  const minAbsImpact = 12;

  for (const pid of tonightIds) {
    const pname = allPlayers.find(p => p.id === pid)?.name;
    if (!pname) continue;

    const rows: { other: string; impact: number; avgWith: number; avgWithout: number; wg: number; wog: number }[] = [];

    for (const oid of tonightIds) {
      if (oid === pid) continue;
      const oname = allPlayers.find(p => p.id === oid)?.name;
      if (!oname) continue;

      let withSum = 0, withG = 0, withoutSum = 0, withoutG = 0;
      for (const g of games) {
        const gps = allGp.filter(gp => gp.gameId === g.id);
        const self = gps.find(gp => gp.playerId === pid);
        if (!self) continue;
        const otherPlayed = gps.some(gp => gp.playerId === oid);
        if (otherPlayed) {
          withSum += self.profit;
          withG++;
        } else {
          withoutSum += self.profit;
          withoutG++;
        }
      }
      if (withG < minSide || withoutG < minSide) continue;
      const avgWith = withSum / withG;
      const avgWithout = withoutSum / withoutG;
      const impact = Math.round(avgWith - avgWithout);
      if (Math.abs(impact) < minAbsImpact) continue;
      rows.push({ other: oname, impact, avgWith: Math.round(avgWith), avgWithout: Math.round(avgWithout), wg: withG, wog: withoutG });
    }

    rows.sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
    const top = rows.slice(0, 2);
    if (top.length === 0) continue;

    const parts = top.map(t => {
      const sign = t.impact >= 0 ? '+' : '';
      return `${sign}${t.impact}₪ מול ${t.other} (ממוצע ${t.avgWith >= 0 ? '+' : ''}${t.avgWith} ב-${t.wg} משחקים יחד לעומת ${t.avgWithout >= 0 ? '+' : ''}${t.avgWithout} ב-${t.wog} בלי)`;
    });
    lines.push(`• ${pname}: ${parts.join(' | ')}`);
  }

  if (lines.length === 0) return '';
  return `\n📎 השפעת נוכחות מול משתתפי הערב (נתון היסטורי בלבד — לא מחליף את חיזוי הסכום הנעול):\n${lines.join('\n')}\nאפשר לשלב משפט קצר אם זה חזק; אסור לסתור את כיוון ועוצמת החיזוי הנעול.`;
};

/**
 * Targeted retry for players the main forecast call skipped (or returned a
 * too-short/empty sentence for). Those players would otherwise fall back to a
 * canned template line, which reads as "the old static forecast" next to the
 * rich AI sentences the rest of the table got. The locked prediction numbers
 * are NOT touched here — we only ask the model for fresh highlight+sentence
 * text for the named players, using the exact same per-player data card the
 * main prompt used. Returns the parsed entries (best-effort); on any failure
 * it returns [] so the caller keeps the existing fallback behaviour.
 */
const retryMissingForecastText = async (
  missingNames: string[],
  playerCardByName: Map<string, string>,
  apiKey: string,
): Promise<{ name: string; highlight: string; sentence: string }[]> => {
  const cards = missingNames
    .map(n => playerCardByName.get(n))
    .filter((c): c is string => !!c)
    .join('\n\n');
  if (!cards) return [];

  const prompt = `אתה כתב פוקר. כתוב טקסט טרי לשחקנים הבאים בלבד, על סמך הכרטיסים. החזר JSON תקין בלבד בפורמט: {"players":[{"name":"שם","highlight":"כותרת","sentence":"משפט"}]}

📊 כרטיסי שחקנים:
${cards}

לכל שחקן:
• highlight — כותרת קצרה (3-6 מילים), העובדה הכי מעניינת
• sentence — משפט אחד בעברית (20-40 מילים) עם 2-3 מספרים אמיתיים מהכרטיס
• הטון חייב להתאים לכיוון ולעוצמה של החיזוי הנעול (🔒): חיובי → בטוח/חוגג, שלילי → אתגר/עקיצה חברית או עידוד-קאמבק שמכיר שהוא מתחת, בלי השפלה. בחיזוי שלילי אסור למסגר סביב הצלחה/מומנטום/ניצחון מהעבר — זה סותר את המספר
• אסור להזכיר את מספר החיזוי במשפט; אסור "הערב/היום/הלילה" או תאריך — השתמש ב"הפעם", "במשחק הקרוב"
• שחקן חדש → כתוב שהוא חדש, אל תמציא מספרים
עברית תקנית: מספר מתאים במין לשם העצם (שלושה משחקים, חמש קניות). פעלים ותארים לפי מין השם בכרטיס (זכר/נקבה). שמור על שם השחקן מדויק.`;

  try {
    const { text } = await callWithFallback({
      prompt,
      apiKey,
      temperature: 0.8,
      maxOutputTokens: 4096,
      topK: 40,
      topP: 0.95,
      responseMimeType: 'application/json',
      label: 'Forecast-retry',
    });
    let jsonText = text;
    if (text.includes('```json')) jsonText = text.split('```json')[1].split('```')[0];
    else if (text.includes('```')) jsonText = text.split('```')[1].split('```')[0];
    const parsed = JSON.parse(jsonText.trim());
    const arr = Array.isArray(parsed) ? parsed : parsed.players;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((e: any) => e && typeof e.name === 'string')
      .map((e: any) => ({ name: e.name, highlight: e.highlight || '', sentence: e.sentence || '' }));
  } catch (e) {
    console.warn('⚠️ Forecast retry for skipped players failed:', e);
    return [];
  }
};

/**
 * Generate AI-powered forecasts for selected players only
 */
export const generateAIForecasts = async (
  players: PlayerForecastData[],
  globalRankings?: GlobalRankingContext,
  periodMarkers?: PeriodMarkers,
  location?: string,
  comboHistoryText?: string
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
    allTimeRecords.push(`🥇 All-Time Profit Leader: ${sortedByTotalProfit[0].name} with \u200E+${sortedByTotalProfit[0].totalProfit} total`);
  }
  
  // Biggest single-night win
  if (sortedByBestWin[0]?.bestWin > 0) {
    allTimeRecords.push(`💰 Biggest Single-Night Win: ${sortedByBestWin[0].name} once won \u200E+${sortedByBestWin[0].bestWin}`);
  }
  
  // Biggest single-night loss
  if (sortedByWorstLoss[0]?.worstLoss < 0) {
    allTimeRecords.push(`📉 Biggest Single-Night Loss: ${sortedByWorstLoss[0].name} once lost ${sortedByWorstLoss[0].worstLoss}`);
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
    allTimeRecords.push(`📊 Best Average: ${sortedByAvg[0].name} averages \u200E+${Math.round(sortedByAvg[0].avgProfit)} per game`);
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

  // ========== CALCULATE MILESTONES (via shared engine) ==========
  const milestonePlayersForPrompt = players.map(p => ({
    id: p.name, name: p.name, gamesPlayed: p.gamesPlayed, totalProfit: p.totalProfit,
    avgProfit: p.avgProfit, winCount: p.winCount, lossCount: p.lossCount,
    winPercentage: p.winPercentage, currentStreak: p.currentStreak,
    longestWinStreak: 0, longestLossStreak: 0, biggestWin: p.bestWin, biggestLoss: p.worstLoss,
    avgRebuysPerGame: 0, totalRebuys: 0, avgWin: 0, avgLoss: 0, gameHistory: p.gameHistory,
  }));
  const milestoneItems = generateMilestonesEngine(milestonePlayersForPrompt, { mode: 'tonight' });
  const milestonesText = milestoneItems.map(m => `${m.emoji} ${m.title}: ${m.description}`).join('\n');

  // Helper: Parse date from game history (handles multiple formats)
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
  
  // Current date info
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const currentHalf = currentMonth < 6 ? 1 : 2; // H1 = Jan-Jun, H2 = Jul-Dec
  const halfStartMonth = currentHalf === 1 ? 0 : 6;
  
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
  
  // Old milestone generators removed — using shared engine above
  

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
    storylines.push(`⚔️ יריבות: ${r.a} ו${r.b} כמעט שווים - ${r.aWins}:${r.bWins} ב-${r.sharedGames} משחקים משותפים. מי ישבור שוויון?`);
  }

  // === STORYLINE TYPE 3: Revenge game ===
  for (const h of h2hResults) {
    if (h.sharedGames < 3) continue;
    const profitDiff = Math.abs(h.lastGameAProfit - h.lastGameBProfit);
    if (profitDiff >= 80) {
      const loser = h.lastGameAProfit < h.lastGameBProfit ? h.a : h.b;
      const winner = h.lastGameAProfit < h.lastGameBProfit ? h.b : h.a;
      const loserProfit = Math.round(Math.min(h.lastGameAProfit, h.lastGameBProfit));
      const winnerProfit = Math.round(Math.max(h.lastGameAProfit, h.lastGameBProfit));
      storylines.push(`🔥 נקמה: ${loser} סיים עם ${loserProfit} בזמן ש${winner} סגר על \u200E+${winnerProfit} במשחק האחרון - הפעם משחק הנקמה?`);
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
        storylines.push(`🍀 קמע: ${p.name} מרוויח בממוצע ${avgTogether >= 0 ? '+' : ''}${avgTogether} כש${other.name} משחק (לעומת ${Math.round(p.avgProfit) >= 0 ? '+' : ''}${Math.round(p.avgProfit)} בד"כ)`);
      } else if (diff <= -25) {
        storylines.push(`😈 עין הרע: ${p.name} בממוצע ${avgTogether} כש${other.name} בשולחן (לעומת ${Math.round(p.avgProfit) >= 0 ? '+' : ''}${Math.round(p.avgProfit)} בד"כ)`);
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
        storylines.push(`📊 ${better ? 'חברה טובה' : 'צר בשולחן'}: ${p.name} בממוצע ${better ? (manyAvg >= 0 ? '+' : '') + manyAvg : (fewAvg >= 0 ? '+' : '') + fewAvg} ${better ? 'כשרוב החבר\'ה ביחד' : 'עם פחות שחקנים'} לעומת ${better ? (fewAvg >= 0 ? '+' : '') + fewAvg : (manyAvg >= 0 ? '+' : '') + manyAvg}`);
      }
    }
  }

  // === STORYLINE TYPE 6: Nemesis (profit gap in shared games) ===
  for (const h of h2hResults) {
    if (h.sharedGames < 4) continue;
    const profitGap = h.aTotalProfit - h.bTotalProfit;
    if (Math.abs(profitGap) >= 200) {
      const stronger = profitGap > 0 ? h.a : h.b;
      const weaker = profitGap > 0 ? h.b : h.a;
      const strongerTotal = profitGap > 0 ? h.aTotalProfit : h.bTotalProfit;
      const weakerTotal = profitGap > 0 ? h.bTotalProfit : h.aTotalProfit;
      storylines.push(`💸 נמסיס: ב-${h.sharedGames} משחקים משותפים, ${stronger} הרוויח סה"כ ${strongerTotal >= 0 ? '+' : ''}${Math.round(strongerTotal)} ואילו ${weaker} סיים עם ${weakerTotal >= 0 ? '+' : ''}${Math.round(weakerTotal)} — פער של ${Math.abs(Math.round(profitGap))}`);
    }
  }

  // === STORYLINE TYPE 7: H2H win streak ===
  for (const h of h2hResults) {
    const consec = Math.max(h.aConsecutiveWins, h.bConsecutiveWins);
    if (consec >= 3) {
      const streaker = h.aConsecutiveWins > h.bConsecutiveWins ? h.a : h.b;
      const victim = h.aConsecutiveWins > h.bConsecutiveWins ? h.b : h.a;
      storylines.push(`🔥 רצף מול: ${streaker} ניצח את ${victim} ${consec} פעמים ברצף! ישבור את הרצף הפעם?`);
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
      storylines.push(`🏆 קרב דירוג: ${sortedByYearProfitStory[i].name} ו${sortedByYearProfitStory[i + 1].name} רק ${gap} הפרש בטבלת ${currentYear}! המשחק הבא מכריע מי מקום ${i + 1}`);
    }
  }

  // === STORYLINE TYPE 10: Comeback trail ===
  for (const p of players) {
    if (p.gamesPlayed < 8 || p.totalProfit >= 0) continue;
    const last5 = p.gameHistory.slice(0, 5);
    const last5Profit = last5.reduce((s, g) => s + g.profit, 0);
    if (last5Profit > 50 && p.totalProfit < -100) {
      storylines.push(`💪 קאמבק: ${p.name} על ${Math.round(p.totalProfit)} כולל, אבל ב-5 משחקים אחרונים \u200E+${Math.round(last5Profit)}. המגמה מתהפכת!`);
    }
  }

  // === STORYLINE TYPE 11: Location insights (only when genuinely interesting) ===
  // Aggregate all game history for group-level location analysis
  const allGameHistories = new Map<string, { location?: string; date: string }>();
  for (const p of players) {
    for (const g of p.gameHistory) {
      if (!allGameHistories.has(g.gameId)) {
        allGameHistories.set(g.gameId, { location: g.location, date: g.date });
      }
    }
  }
  const locationInsightsText = buildLocationInsights(players, location, Array.from(allGameHistories.values()));

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
      storylines.push(`🎭 ניגודים: ${wildest.name} תנודתי (סטייה ${Math.round(wildest.stdDev)}) מול ${calmest.name} יציב (סטייה ${Math.round(calmest.stdDev)}) - שני סגנונות שונים לגמרי`);
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
    storylines.push(`🧲 ספונסר: ${totalContributions[0].name} בסה"כ ${totalContributions[0].contributed} במשחקים משותפים עם השחקנים המשתתפים, בעוד ${totalContributions[totalContributions.length - 1].name} הרוויח \u200E+${totalContributions[totalContributions.length - 1].contributed}`);
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
  // Robust, data-informed: uses median magnitude + group-level clamping to avoid outliers

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
    if (currentHalf === 1) return { year: currentYear - 1, half: 2 as const, label: formatHebrewHalf(2, currentYear - 1) };
    return { year: currentYear, half: 1 as const, label: formatHebrewHalf(1, currentYear) };
  };
  const currentPeriodLabel = formatHebrewHalf(currentHalf, currentYear);
  const prevPeriod = getPreviousPeriod();

  // ========== GAME SHAPE SAMPLING PREDICTION ALGORITHM ==========
  // Instead of predicting each player independently (which produces lopsided 1-winner distributions),
  // we sample a real game's profit distribution as a template and assign players to slots
  // based on their strength ranking. This guarantees realistic spread by construction.

  const halfGamesMap = new Map(players.map(p => {
    const hg = getHalfGames(p, currentYear, currentHalf);
    const avg = hg.length > 0 ? hg.reduce((s, g) => s + g.profit, 0) / hg.length : 0;
    return [p.name, { games: hg, avg }];
  }));

  const n = players.length;

  // STEP 1: Collect game templates from all completed games
  let templates: number[][] = [];
  try {
    const storedGames = getAllGames();
    const storedGPs = getAllGamePlayers();
    const completedIds = new Set(storedGames.filter(g => g.status === 'completed').map(g => g.id));
    const gameProfits = new Map<string, number[]>();
    for (const gp of storedGPs) {
      if (!completedIds.has(gp.gameId)) continue;
      if (!gameProfits.has(gp.gameId)) gameProfits.set(gp.gameId, []);
      gameProfits.get(gp.gameId)!.push(gp.profit);
    }
    for (const [, profits] of gameProfits) {
      if (profits.length >= n - 1 && profits.length <= n + 1 && profits.length >= 5) {
        const sum = profits.reduce((s, v) => s + v, 0);
        const normalized = profits.map(v => v - sum / profits.length);
        normalized.sort((a, b) => b - a);
        templates.push(normalized);
      }
    }
  } catch {
    console.warn('⚠️ Could not load game templates from storage');
  }

  // Fallback: reconstruct templates from tonight's players' game histories
  if (templates.length < 3) {
    const gameMap = new Map<string, number[]>();
    for (const p of players) {
      for (const g of p.gameHistory) {
        if (!gameMap.has(g.gameId)) gameMap.set(g.gameId, []);
        gameMap.get(g.gameId)!.push(g.profit);
      }
    }
    for (const [, profits] of gameMap) {
      if (profits.length >= Math.max(5, n - 2)) {
        const sum = profits.reduce((s, v) => s + v, 0);
        const normalized = profits.map(v => v - sum / profits.length);
        normalized.sort((a, b) => b - a);
        templates.push(normalized);
      }
    }
  }

  console.log(`🎰 Template pool: ${templates.length} game shapes available for ${n} players`);

  // STEP 2: Pick a template or generate synthetic fallback
  let template: number[];
  if (templates.length >= 3) {
    template = [...templates[Math.floor(Math.random() * templates.length)]];
  } else {
    // Synthetic fallback based on observed real data patterns:
    // 3 winners for 7p, 3-4 for 8p; top winner ≈ 2x second; magnitudes in 40-200 range
    const winnersCount = n <= 7 ? 3 : (Math.random() < 0.5 ? 3 : 4);
    const losersCount = n - winnersCount;
    const synth: number[] = [];
    const topWin = 80 + Math.random() * 120;
    for (let i = 0; i < winnersCount; i++) {
      const factor = i === 0 ? 1 : 1 / (1.5 + i * 0.4);
      synth.push(Math.round(topWin * factor));
    }
    const totalPos = synth.reduce((s, v) => s + v, 0);
    let remaining = totalPos;
    for (let i = 0; i < losersCount; i++) {
      if (i === losersCount - 1) {
        synth.push(-remaining);
      } else {
        const share = Math.round(remaining * (0.15 + Math.random() * 0.25));
        synth.push(-share);
        remaining -= share;
      }
    }
    synth.sort((a, b) => b - a);
    template = synth;
    console.log('🎲 Using synthetic template (not enough historical games)');
  }

  // Interpolate template to match tonight's player count
  if (template.length < n) {
    while (template.length < n) {
      const mid = Math.floor(template.length / 2);
      template.splice(mid, 0, 0);
    }
  } else if (template.length > n) {
    while (template.length > n) {
      let minIdx = 0;
      let minAbs = Infinity;
      for (let i = 0; i < template.length; i++) {
        if (Math.abs(template[i]) < minAbs) { minAbs = Math.abs(template[i]); minIdx = i; }
      }
      const removed = template.splice(minIdx, 1)[0];
      const totalAbs = template.reduce((s, v) => s + Math.abs(v), 0);
      if (totalAbs > 0 && removed !== 0) {
        template = template.map(v => Math.round(v - removed * (Math.abs(v) / totalAbs)));
      }
    }
  }
  // Ensure zero-sum after interpolation
  const templateSum = template.reduce((s, v) => s + v, 0);
  if (templateSum !== 0) {
    const adj = templateSum / template.length;
    template = template.map(v => Math.round(v - adj));
    const residual = template.reduce((s, v) => s + v, 0);
    if (residual !== 0) {
      const smIdx = template.reduce((mi, v, i) => Math.abs(v) < Math.abs(template[mi]) ? i : mi, 0);
      template[smIdx] -= residual;
    }
  }
  template.sort((a, b) => b - a);

  // STEP 3: Rank players by holistic strength score using ALL available data
  const strengthScores = players.map(p => {
    if (p.gamesPlayed === 0) return { name: p.name, score: 0, volatility: 100 };

    const halfData = halfGamesMap.get(p.name);
    const periodAvg = halfData && halfData.games.length > 0 ? halfData.avg : p.avgProfit;

    // Recent momentum: weighted average of last 5 games (most recent game = 5x weight of 5th)
    const last5 = p.gameHistory.slice(0, Math.min(5, p.gameHistory.length));
    const weights = last5.map((_, i) => last5.length - i);
    const totalWeight = weights.reduce((s, w) => s + w, 0);
    const recentMomentum = last5.reduce((s, g, i) => s + g.profit * weights[i], 0) / totalWeight;

    // All-time average — the historical baseline that grounds the prediction
    const allTimeAvg = p.avgProfit;

    // Win rate advantage centered at 50%, scaled so ±25% difference is meaningful
    const winRateScore = (p.winPercentage - 50) * 1.5;

    // Streak value weighted by actual profit magnitude (not just count)
    let streakValue = 0;
    if (p.currentStreak !== 0) {
      const streakLen = Math.min(Math.abs(p.currentStreak), 5);
      const streakGames = p.gameHistory.slice(0, streakLen);
      const streakAvgProfit = streakGames.reduce((s, g) => s + g.profit, 0) / streakGames.length;
      streakValue = streakLen * streakAvgProfit * 0.05;
    }

    // Freshness: penalty for long absences (rust factor)
    const freshness = p.daysSinceLastGame > 30 ? -15 : p.daysSinceLastGame > 14 ? -5 : 0;

    // Volatility (stddev of recent results) — used for per-player noise, not scoring
    const recent10 = p.gameHistory.slice(0, Math.min(10, p.gameHistory.length)).map(g => g.profit);
    const recentMean = recent10.reduce((s, v) => s + v, 0) / recent10.length;
    const volatility = recent10.length >= 3
      ? Math.sqrt(recent10.reduce((s, v) => s + (v - recentMean) ** 2, 0) / recent10.length)
      : 80;

    const score = periodAvg * 0.30 + recentMomentum * 0.25 + allTimeAvg * 0.15
                + winRateScore * 0.15 + streakValue * 0.10 + freshness * 0.05;

    return { name: p.name, score, volatility };
  });

  // Compute score spread for surprise modifiers and temperature calibration
  const rawScores = strengthScores.map(s => s.score);
  const scoreMean = rawScores.reduce((a, b) => a + b, 0) / rawScores.length;
  const scoreStdDev = rawScores.length >= 2
    ? Math.sqrt(rawScores.reduce((s, v) => s + (v - scoreMean) ** 2, 0) / rawScores.length)
    : 50;

  // STEP 3b: Surprise detection (same conditions as before)
  type SurpriseType = 'underdog_rise' | 'top_dog_fall' | 'wild_card' | 'breakout' | 'streak_breaker' | 'dark_horse';
  const surpriseCandidates: { name: string; type: SurpriseType; description: string }[] = [];

  for (const p of players) {
    if (p.gamesPlayed < 3) continue;
    const halfData = halfGamesMap.get(p.name);
    const halfAvg = halfData?.avg || 0;

    if (p.avgProfit < -15 && halfAvg > 20) {
      surpriseCandidates.push({ name: p.name, type: 'underdog_rise',
        description: `היסטוריה שלילית (${Math.round(p.avgProfit)}) אבל פורמה חיובית (${Math.round(halfAvg)}) - הפתעה חיובית!` });
    }
    if (p.avgProfit > 25 && halfAvg < -15) {
      surpriseCandidates.push({ name: p.name, type: 'top_dog_fall',
        description: `שחקן חזק (ממוצע ${Math.round(p.avgProfit)}) בפורמה שלילית (${Math.round(halfAvg)}) - הפתעה שלילית!` });
    }
    if (p.gamesPlayed >= 8) {
      const recent = p.gameHistory.slice(0, 10).map(g => g.profit);
      const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
      const stdDev = Math.sqrt(recent.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / recent.length);
      if (stdDev > 120) {
        surpriseCandidates.push({ name: p.name, type: 'wild_card',
          description: `שחקן תנודתי (סטייה ${Math.round(stdDev)}) - יכול להפתיע לכל כיוון!` });
      }
    }
    if (Math.abs(p.avgProfit) < 10 && p.currentStreak >= 3 && halfAvg > 25) {
      surpriseCandidates.push({ name: p.name, type: 'breakout',
        description: `${p.currentStreak} נצחונות ברצף עם ממוצע ${Math.round(halfAvg)} - פריצה צפויה!` });
    }
    if (Math.abs(p.currentStreak) >= 4) {
      surpriseCandidates.push({ name: p.name, type: 'streak_breaker',
        description: `רצף של ${Math.abs(p.currentStreak)} ${p.currentStreak > 0 ? 'נצחונות' : 'הפסדים'} - סטטיסטית הרצף צפוי להישבר!` });
    }
    if (p.gamesPlayed >= 4 && p.gamesPlayed <= 8 && p.avgProfit > 25) {
      surpriseCandidates.push({ name: p.name, type: 'dark_horse',
        description: `שחקן לא קבוע (${p.gamesPlayed} משחקים) עם ממוצע \u200E+${Math.round(p.avgProfit)} - סוס שחור!` });
    }
  }

  // Pick up to 2 surprises from different types
  const selectedSurprises: typeof surpriseCandidates = [];
  const usedSurpriseTypes = new Set<SurpriseType>();
  const usedSurpriseNames = new Set<string>();
  const shuffledSurprises = [...surpriseCandidates].sort(() => Math.random() - 0.5);
  const maxSurpriseCount = Math.min(2, Math.ceil(players.length / 4));

  for (const candidate of shuffledSurprises) {
    if (selectedSurprises.length >= maxSurpriseCount) break;
    if (usedSurpriseTypes.has(candidate.type) || usedSurpriseNames.has(candidate.name)) continue;
    selectedSurprises.push(candidate);
    usedSurpriseTypes.add(candidate.type);
    usedSurpriseNames.add(candidate.name);
  }

  // STEP 3c: Apply surprises as score modifiers
  const surpriseBoost = Math.max(scoreStdDev * 0.5, 15);
  for (const surprise of selectedSurprises) {
    const ss = strengthScores.find(s => s.name === surprise.name);
    if (!ss) continue;
    if (surprise.type === 'underdog_rise' || surprise.type === 'breakout' || surprise.type === 'dark_horse') {
      ss.score += surpriseBoost;
    } else if (surprise.type === 'top_dog_fall') {
      ss.score -= surpriseBoost;
    } else if (surprise.type === 'streak_breaker') {
      const player = players.find(p => p.name === surprise.name)!;
      ss.score += (player.currentStreak > 0 ? -1 : 1) * surpriseBoost * 0.8;
    } else if (surprise.type === 'wild_card') {
      ss.score += (Math.random() - 0.5) * 2 * surpriseBoost;
    }
  }

  // STEP 4: Probability-weighted random position assignment
  // Instead of deterministic sort (which always puts the best player first),
  // each player's score determines their PROBABILITY of getting each slot.
  // Stronger players are more likely to get better slots, but anyone can end up anywhere.
  // Temperature controls how much scores matter vs pure randomness.
  const temperature = Math.max(scoreStdDev * 2, 40);
  const maxScore = Math.max(...strengthScores.map(s => s.score));
  const remaining = [...strengthScores];
  const orderedPlayers: { name: string; score: number }[] = [];

  for (let pos = 0; pos < n; pos++) {
    const weights = remaining.map(s => Math.exp((s.score - maxScore) / temperature));
    const totalWeight = weights.reduce((s, w) => s + w, 0);
    let rand = Math.random() * totalWeight;
    let selectedIdx = 0;
    for (let i = 0; i < weights.length; i++) {
      rand -= weights[i];
      if (rand <= 0) { selectedIdx = i; break; }
    }
    orderedPlayers.push(remaining[selectedIdx]);
    remaining.splice(selectedIdx, 1);
  }

  const playerSuggestions = orderedPlayers.map((s, i) => ({
    name: s.name,
    suggested: Math.round(template[i])
  }));

  // STEP 5: Fine-tune for variety (slight scaling to avoid exact template replay)
  playerSuggestions.forEach(p => {
    p.suggested = Math.round(p.suggested * (0.85 + Math.random() * 0.3));
  });

  // Fix zero-sum residual from scaling
  const finalSum = playerSuggestions.reduce((s, p) => s + p.suggested, 0);
  if (finalSum !== 0) {
    const smIdx = playerSuggestions.reduce((mi, p, i) =>
      Math.abs(p.suggested) < Math.abs(playerSuggestions[mi].suggested) ? i : mi, 0);
    playerSuggestions[smIdx].suggested -= finalSum;
  }

  const winners = playerSuggestions.filter(p => p.suggested > 0).length;
  const losers = playerSuggestions.filter(p => p.suggested < 0).length;
  console.log('🎲 Surprises:', selectedSurprises.map(s => `${s.name}(${s.type})`).join(', '));
  console.log(`📊 Predictions (${winners}W/${losers}L):`, playerSuggestions.map(s => `${s.name}: ${s.suggested >= 0 ? '+' : ''}${s.suggested}`).join(', '));
  console.log(`🎰 Template shape: [${template.map(t => t >= 0 ? '+' + t : '' + t).join(', ')}]`);
  console.log(`📏 Strength scores: ${[...strengthScores].sort((a, b) => b.score - a.score).map(s => `${s.name}(${Math.round(s.score)})`).join(' > ')}`);
  console.log(`🎯 Assigned order: ${orderedPlayers.map(s => s.name).join(' > ')}`);

  const surpriseNames = new Set(selectedSurprises.map(s => s.name));
  const surpriseText = selectedSurprises.length > 0 
    ? `\n🎲 הפתעות (שחקנים אלו מסומנים כהפתעה — הטון שלהם צריך לשקף את זה):\n` + selectedSurprises.map(s => `- ${s.name}: ${s.description}`).join('\n')
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
  const maxGamesInGroup = Math.max(...playersWithYearStats.map(p => p.gamesPlayed));
  const veteranThreshold = Math.round(maxGamesInGroup * 0.75);

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
      assign('ranking_battle', `${gapToAbove} ממקום ${halfRank - 1} (${aboveName}) ← התמקד בפער הדירוג, לא בממוצע!`);
    } else if (p.daysSinceLastGame >= 20 && p.daysSinceLastGame < 900 && canUse('comeback')) {
      assign('comeback', `חוזר אחרי ${p.daysSinceLastGame} ימים ← התמקד בימי ההיעדרות, לא בממוצע!`);
    } else if (nearMilestone && canUse('milestone')) {
      assign('milestone', `${nearMilestone - Math.round(p.totalProfit)} מ-${nearMilestone} כולל ← התמקד באבן הדרך, לא בממוצע!`);
    } else if (currentHalfGames.length >= 3 && Math.abs(periodAvg - allTimeAvg) > 20 && canUse('form')) {
      const dir = periodAvg > allTimeAvg ? 'פורמה עולה' : 'פורמה יורדת';
      assign('form', `${dir}: תקופה ${periodAvg >= 0 ? '+' : ''}${periodAvg} vs היסטורי ${allTimeAvg >= 0 ? '+' : ''}${allTimeAvg} ← התמקד בהשוואת המגמה!`);
    } else if (Math.abs(lastGameProfit) > 80 && canUse('big_last_game')) {
      assign('big_last_game', `משחק אחרון: ${lastGameProfit >= 0 ? '+' : ''}${Math.round(lastGameProfit)} ← התמקד בתוצאת המשחק האחרון, לא בממוצע!`);
    } else if (p.gamesPlayed >= veteranThreshold && canUse('veteran')) {
      assign('veteran', `ותיק: ${p.gamesPlayed} משחקים, ${winRate}% נצחונות ← התמקד בניסיון ואחוז נצחונות, לא בממוצע!`);
    } else if (p.avgProfit < -5 && periodAvg > 10 && canUse('dark_horse')) {
      assign('dark_horse', `היסטוריה שלילית אבל פורמה חיובית ← התמקד בשינוי המגמה, לא בממוצע!`);
    } else {
      assign('default', `${p.gamesPlayed} משחקים, ${winRate}% נצחונות ← התמקד באחוז נצחונות או תוצאה אחרונה, לא בממוצע!`);
    }
  });

  // ========== RECONCILE ANGLES WITH PREDICTIONS ==========
  // Optimistic angles must not pair with large negative predictions
  const optimisticAngles: AngleType[] = ['ranking_battle', 'milestone', 'streak', 'form'];
  const pessimisticAngles: AngleType[] = ['dark_horse'];

  for (const pa of playerAngles) {
    const prediction = playerSuggestions.find(s => s.name === pa.name)?.suggested || 0;
    const player = playersWithYearStats.find(p => p.name === pa.name);
    if (!player) continue;

    const winRate = player.gamesPlayed > 0 ? Math.round((player.winCount / player.gamesPlayed) * 100) : 0;

    if (prediction <= -30 && optimisticAngles.includes(pa.angle)) {
      pa.angle = 'default';
      pa.angleHint = `חיזוי שלילי (${prediction}) — ${player.gamesPlayed} משחקים, ${winRate}% נצחונות ← כתוב בטון מאתגר/הומוריסטי, לא אופטימי!`;
    }
    if (prediction >= 30 && pessimisticAngles.includes(pa.angle)) {
      pa.angle = 'form';
      pa.angleHint = `חיזוי חיובי (\u200E+${prediction}) עם מגמה עולה ← כתוב בטון בטוח/חיובי!`;
    }
  }

  console.log('🎭 Assigned angles:', playerAngles.map(a => `${a.name}: ${a.angle}`).join(', '));

  // ========== BUILD STAT CARDS ==========
  // Shuffle player order in the prompt to avoid AI bias toward first-listed players
  const shuffledPlayers = [...playersWithYearStats].sort(() => Math.random() - 0.5);
  // Per-player data card, also stashed by name so a targeted retry can
  // rebuild a focused prompt for just the players the AI skipped.
  const playerCardByName = new Map<string, string>();
  const playerDataText = shuffledPlayers.map(p => {
    const lastGame = p.gameHistory[0];
    const isNewPlayer = p.gamesPlayed === 0 || p.gameHistory.length === 0;
    const lastGameResult = lastGame 
      ? (lastGame.profit > 0 ? `ניצח \u200E+${Math.round(lastGame.profit)}` : 
         lastGame.profit < 0 ? `הפסיד ${Math.round(lastGame.profit)}` : 'יצא באפס')
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
        lines.push(`⭐ טבלת ${periodLabel}: מקום #${halfRank} מתוך ${halfTotalActive}, ${periodGames.length} משחקים, ממוצע ${periodAvg >= 0 ? '+' : ''}${periodAvg}`);
      }
      lines.push(`היסטוריה כוללת: ${p.gamesPlayed} משחקים, ממוצע ${allTimeAvg >= 0 ? '+' : ''}${allTimeAvg}, ${winRate}% נצחונות, סה"כ ${p.totalProfit >= 0 ? '+' : ''}${Math.round(p.totalProfit)}`);
      if (allTimeRank > 0 && allTimeRank <= 3) {
        lines.push(`דירוג כללי (כל הזמנים): #${allTimeRank} מתוך ${allTimeTotalActive}`);
      }
      if (gapAbove > 0 && halfRank > 1) {
        lines.push(`פער בטבלת ${periodLabel}: ${gapAbove} מאחורי מקום ${halfRank - 1} (${aboveName})`);
      }
      if (gapBelow > 0 && belowName) {
        lines.push(`יתרון בטבלת ${periodLabel}: ${gapBelow} על מקום ${halfRank + 1} (${belowName})`);
      }
      if (p.daysSinceLastGame >= 20 && p.daysSinceLastGame < 900) {
        lines.push(`חזרה: אחרי ${p.daysSinceLastGame} ימים`);
      }
    }
    lines.push(`זווית מוצעת: ${angle?.angle || 'default'} - ${angle?.angleHint || ''}`);
    lines.push(`🔒 חיזוי סופי (נעול): ${suggestion >= 0 ? '+' : ''}${suggestion} ← המשפט חייב להתאים לכיוון ולעוצמה הזו!`);

    console.log(`🔍 ${p.name}: angle=${angle?.angle}, suggestion=${suggestion >= 0 ? '+' : ''}${suggestion}`);

    const card = lines.join('\n');
    playerCardByName.set(p.name, card);
    return card;
  }).join('\n\n');

  // Build period context for the prompt
  const periodContextLines: string[] = [];
  if (periodMarkers) {
    if (periodMarkers.isFirstGameOfMonth) periodContextLines.push(`🗓️ משחק ראשון של חודש ${periodMarkers.monthName}`);
    if (periodMarkers.isLastGameOfMonth) periodContextLines.push(`🗓️ משחק אחרון של חודש ${periodMarkers.monthName}`);
    if (periodMarkers.isFirstGameOfHalf) periodContextLines.push(`🗓️ משחק ראשון של ${periodMarkers.halfLabel} — מחצית חדשה מתחילה!`);
    if (periodMarkers.isLastGameOfHalf) periodContextLines.push(`🗓️ משחק אחרון של ${periodMarkers.halfLabel} — סיום מחצית!`);
    if (periodMarkers.isFirstGameOfYear) periodContextLines.push(`🗓️ משחק ראשון של ${periodMarkers.year} — שנה חדשה!`);
    if (periodMarkers.isLastGameOfYear) periodContextLines.push(`🗓️ משחק אחרון של ${periodMarkers.year} — סיום שנה!`);
  }
  const periodContextText = periodContextLines.length > 0 ? periodContextLines.join('\n') : '';
  const hasMajorPeriod = periodMarkers && (periodMarkers.isFirstGameOfHalf || periodMarkers.isLastGameOfHalf || periodMarkers.isFirstGameOfYear || periodMarkers.isLastGameOfYear);

  // Randomly pick a style for the teaser
  const teaserStyles = [
    'פרשן ספורט מלהיב שבונה את ההייפ לפני המשחק הגדול',
    'כתב עיתון ספורט שכותב פרומו מרתק למדור הפוקר',
    'מספר סיפורים שנון שמושך את הקורא עם סיפורי מתח וריגוש',
    'הודעת ווטסאפ מהסוג שכולם ממהרים לקרוא, קצרה ולעניין עם הומור',
    'פרשן פוליטי שמנתח את מאזן הכוחות בשולחן כאילו זה ערב בחירות',
    'מגיש טלוויזיה דרמטי שמציג את הדמויות כמו בתוכנית ריאליטי',
  ];
  const chosenStyle = teaserStyles[Math.floor(Math.random() * teaserStyles.length)];

  const rosterImpactText = buildTonightRosterImpactLines(players.map(p => p.name));
  const traitBlock = buildTraitBlock(players.map(p => p.name));

  const prompt = `אתה ${chosenStyle}. התפקיד שלך: ליצור חוויה מהנה ומרגשת לפני ערב פוקר בין חברים.
💰 כל הסכומים בשקלים (₪). כשאתה מזכיר סכומים בטקסט, כתוב "שקל/שקלים" — זה כסף אמיתי, לא נקודות.

🎯 הערב הזה: ${new Date().toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}${periodContextText ? `\n${periodContextText}` : ''}

📊 כרטיסי שחקנים (${players.length} שחקנים):
${playerDataText}
${allTimeRecordsText ? `\n🏅 שיאי הקבוצה (השחקנים המשתתפים בלבד):\n${allTimeRecordsText}` : ''}
${storylinesText ? `\n📖 סיפורי הערב - יריבויות, נקמות, קשרים מעניינים:\n${storylinesText}` : ''}
${milestonesText ? `\n🎯 אבני דרך ועובדות מעניינות:\n${milestonesText}` : ''}
${locationInsightsText ? `\n${locationInsightsText}` : ''}
${comboHistoryText ? `\n${comboHistoryText}` : ''}
${rosterImpactText}
${traitBlock}${surpriseText}

📤 פלט JSON בפורמט הבא:
{"preGameTeaser":"טיזר טרום-משחק","players":[{"name":"שם","highlight":"כותרת","sentence":"משפט"}]}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📣 preGameTeaser — טיזר טרום-משחק (חובה!):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
הטיזר הוא הלב של חוויית הפתיחה. זהו טקסט אחד רציף בעברית שמספר את הסיפור של הערב הזה.

תוכן:
• לקט את העובדות הכי מעניינות, מצחיקות ומפתיעות מכל הנתונים: רצפים, יריבויות, שיאים, חזרות, אבני דרך, קרבות דירוג
• חובה לנסות להזכיר את כל ${players.length} השחקנים בשמם! כולם רוצים לראות את עצמם${locationInsightsText ? `\n• יש תובנות מיקום (🏠) למעלה — שלב אותן רק אם הן מעניינות, מצחיקות או ציניות. אל תזכיר מיקום סתם כי הוא קיים` : ''}
• העדף סיפורים ויריבויות על פני סטטיסטיקות יבשות
• אם יש מידע על הרכב חוזר (🔄) — זה חומר מצוין לטיזר! ציין שזה הרכב שכבר שיחק יחד, מי שלט בפעמים הקודמות, מי תמיד ברווח/הפסד בהרכב הזה. אם זה הרכב חדש (🆕) — ציין שזו פעם ראשונה
• לא לחזור על עובדות שיופיעו ב-sentence של שחקנים ספציפיים — פזר חומר שונה
• חשוב מאוד: הטיזר נשלח מספר ימים לפני המשחק! אסור לכתוב "הלילה", "הערב", "היום" או לציין תאריך/יום ספציפי. השתמש ב"הפעם", "במשחק הבא", "במשחק הקרוב" וכדומה. זה חל על הטיזר וגם על ה-sentence של כל שחקן

אורך:
• יחסי לכמות החומר המעניין — יותר שחקנים ויותר סיפורים = טקסט ארוך יותר
• טווח: 40-120 מילים. עם 4 שחקנים וחומר דליל = קצר. עם 8 שחקנים וסיפורים עסיסיים = ארוך
• לעולם לא ארוך יותר מסך כל ה-sentences של השחקנים ביחד
${hasMajorPeriod ? `
📅 אירוע תקופתי — פסקה ייעודית נוספת:
${periodMarkers?.isFirstGameOfHalf || periodMarkers?.isFirstGameOfYear ? `• מחצית/שנה חדשה מתחילה! הוסף פסקה קצרה שפותחת את העידן החדש — מה מצופה, מי מועמד להוביל, מה השאיפות` : ''}${periodMarkers?.isLastGameOfHalf || periodMarkers?.isLastGameOfYear ? `• מחצית/שנה נגמרת! הוסף פסקה קצרה שמסכמת — מי הוביל, מה היו הרגעים הגדולים, מה נשאר פתוח` : ''}
• הפסקה הזו מעבר לטיזר הרגיל, לא במקומו` : ''}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📝 לכל שחקן:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. highlight - כותרת קצרה (3-6 מילים) - העובדה הכי מעניינת ומשעשעת
2. sentence - משפט אחד בעברית (20-40 מילים) - סיפור מרתק עם 2-3 מספרים אמיתיים מהכרטיס

כללי איכות:
• סיפורי ערב (📖) הם הזהב! יריבויות, נקמה, קמע, נמסיס — השתמש בהם
• כל שחקן = סיפור ייחודי עם זווית שונה. אסור שלשניים אותו סוג נתון מרכזי
• לכל שחקן זווית מוצעת — השתמש בה כבסיס
• העדיפויות: סיפורי ערב ← רצפים ← קרבות דירוג ← תוצאה אחרונה ← אחוז נצחונות ← ותק
• שחקן חדש → כתוב שהוא חדש, אל תמציא מספרים!

התאמת טון — גוון בין עידוד להומור, אבל תמיד בכיוון החיזוי:
• המטרה: כל שחקן נהנה לקרוא. גוון בין השחקנים — לפעמים עידוד וביטחון, לפעמים עקיצה חברית והומור — כדי שלא ירגיש מונוטוני
• חיזוי חיובי → חוגג, בטוח, בונה ציפייה (לא מוגזם לחיזוי קטן)
• חיזוי שלילי → השחקן הוא האאוטסיידר הפעם. בחר בין עקיצה חברית משועשעת ("הקלפים חייבים לו טובה") לבין עידוד-קאמבק שמכיר בכך שהוא מתחת ("הזדמנות לתיקון", "הזמן להתאושש") — תמיד בכיף, בלי אכזריות, השפלה או טון מתנשא
• אזהרה קריטית: בחיזוי שלילי אסור למסגר את הכותרת או המשפט סביב הצלחה, מומנטום או ניצחון מהעבר כאילו הם נמשכים הערב — זה סותר ישירות את המספר ונראה שבור. ניצחון אחרון הוא עובדה היסטורית בלבד, לא מגמה
• חובה: highlight ו-sentence חייבים להרגיש באותו כיוון כמו החיזוי הנעול — אסור להבטיח ניצחון או לחגוג מומנטום/ניצחון כשהחיזוי שלילי; אסור כותרת על "הצלחה" או "גלים" כשהחיזוי שלילי; אסור כותרת קודרת כשהחיזוי חיובי חזק
• אם מזכירים ניצחון/הפסד במשחק האחרון — זה עובדה מהעבר; חייב מילת גישור (אבל/עדיין/הערב/החיזוי) כשהכיוון לערב שונה מהעבר

🚫 איסורים (הפרה = פסילה!):
• אסור להזכיר מספר החיזוי ב-sentence! המספר מוצג בכרטיס בנפרד
• אסור להזכיר הפסד מצטבר/כולל/היסטורי!
• אסור תבנית חוזרת בין משפטים!
• "מטורף", "מדהים", "היסטורי" → רק לנתונים באמת חריגים (רצף 5+, פער 150+)
• sentence קצר מ-20 מילים = פסילה! כל שחקן חייב לקבל אותה רמת תשומת לב ואיכות, כולל האחרון ברשימה

עברית תקנית (קריטי — שגיאות מין/מספר נשמעות חובבניות):
• מספר חייב להתאים במין לשם העצם שאחריו. שמות עצם זכריים (משחק, נצחון, הפסד, רצף, ערב, שקל, אחוז) → מספר זכר: "שלושה משחקים", "חמישה נצחונות", "שני הפסדים". שמות עצם נקביים (פעם, קנייה, דקה, יד) → מספר נקבה: "שלוש פעמים", "חמש קניות". אסור בתכלית "שלוש משחקים" או "חמישה פעמים"
• פעלים, תארים וכינויים יתאימו למין השם של השחקן — רוב השמות בקבוצה זכר, אבל אם שם השחקן נקבה כתוב עליו/עליה בלשון נקבה לאורך כל המשפט
• שמור על שם השחקן מדויק בדיוק כפי שמופיע בכרטיס — בלי לשנות אות, לקצר או להוסיף

כללי כתיבה:
• דירוגים: רק מטבלת התקופה (⭐). מקום 1 = הכי טוב
• "מוביל" = מקום 1 | "רודף" = מנסה לעלות | "שומר" = מגן על הדירוג
• highlight ו-sentence עקביים, כל highlight שונה, כל משפט במבנה שונה, גיוון מלא!`;

  console.log('🤖 AI Forecast Request for:', players.map(p => p.name).join(', '));
  
  // Try each model until one works
  let forecastFallbackFrom: string | undefined;
  // Track the most informative failure so the "all models failed" throw
  // can tell a real key/auth problem (400/401/403 — every model hits it,
  // retrying won't help) apart from a transient rate limit (429 — a 60s
  // countdown retry is the right UX). Without this split a bad/restricted
  // key surfaces as a misleading "rate limit, try again later" countdown.
  let lastForecastError = '';
  let lastForecastStatus = 0;
  for (const config of API_CONFIGS) {
    console.log(`   Trying: ${config.version}/${config.model}...`);
    
    try {
      const response = await proxyGeminiGenerate(config.version, config.model, apiKey, {
        contents: [{
          parts: [{ text: prompt }]
        }],
        generationConfig: {
          temperature: 0.7,
          topK: 40,
          topP: 0.95,
          maxOutputTokens: 12288,
          responseMimeType: 'application/json',
        }
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData?.error?.message || `Status ${response.status}`;
        const errorCode = errorData?.error?.code;
        console.log(`   ❌ ${config.model}: ${errorMsg}`);

        // 403 aiKeyRequired = server-side enforcement: this group has
        // no Gemini key + isn't the platform-owner group. Every fallback
        // model would hit the same gate, AND the existing "all models
        // failed" fallthrow at the bottom of this loop says "rate
        // limited or unavailable" — which the NewGameScreen catch
        // matches against `.includes('rate limit')` and then triggers
        // a 60s retry countdown. That's badly wrong for a no-key
        // group: there's nothing to retry. Fail fast with the
        // canonical NO_API_KEY sentinel so the catch hits the silent
        // fallback path and the user sees the friendly notice instead.
        if (response.status === 403 && (errorCode === 'aiKeyRequired' || errorMsg.includes('Gemini API key'))) {
          throw new Error('NO_API_KEY');
        }
        // Synthesized 503 from `apiProxy.ts` when /api/* isn't served
        // (typically: localhost dev). Fail fast so NewGameScreen's catch
        // routes to the silent local-forecast fallback + shows the
        // friendly "AI proxy unavailable" notice in the modal — instead
        // of cycling through models and triggering the 60s rate-limit
        // countdown via the `ALL_MODELS_FAILED` fallthrow at the bottom.
        if (response.status === 503 && errorCode === 'aiProxyUnavailable') {
          throw new Error('AI_PROXY_UNAVAILABLE');
        }
        if (response.status === 429) {
          const rlHeaders = readRateLimitHeaders(response);
          recordRateLimit(config.model, rlHeaders, errorMsg);
          if (!forecastFallbackFrom) forecastFallbackFrom = config.model;
          lastForecastError = errorMsg;
          lastForecastStatus = 429;
          continue;
        }
        if (response.status === 404) {
          if (!forecastFallbackFrom) forecastFallbackFrom = config.model;
          if (!lastForecastError) { lastForecastError = errorMsg; lastForecastStatus = 404; }
          continue;
        }
        lastForecastError = errorMsg;
        lastForecastStatus = response.status;
        throw new Error(`API_ERROR: ${response.status} - ${errorMsg}`);
      }
      
      console.log(`   ✅ ${config.model} responded!`);
      lastUsedModel = config.model;
      const forecastRlHeaders = readRateLimitHeaders(response);

      const data = await response.json();
      const forecastTokens = data?.usageMetadata?.totalTokenCount || 0;
      
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

      let aiOutput: { name: string; highlight: string; sentence: string }[];
      let preGameTeaser = '';
      try {
        const parsed = JSON.parse(jsonText.trim());
        if (Array.isArray(parsed)) {
          aiOutput = parsed;
        } else if (parsed.players && Array.isArray(parsed.players)) {
          aiOutput = parsed.players;
          preGameTeaser = parsed.preGameTeaser || parsed.groupIntro || '';
        } else {
          throw new Error('Unexpected JSON format');
        }
        console.log('✅ Parsed', aiOutput.length, 'forecasts from AI');
        if (preGameTeaser) console.log('🌟 Pre-game teaser:', preGameTeaser.substring(0, 80) + '...');
      } catch (parseError) {
        console.error('❌ JSON parse error, trying next model');
        continue; // Try next model
      }

      // ===== AUTO-RETRY FOR SKIPPED PLAYERS =====
      // If the model omitted players or gave them an empty/too-short sentence,
      // those players would fall back to a canned template line (reads as the
      // "old static forecast" next to everyone else's AI text). Fetch fresh
      // text for just those players before the merge/fact-check runs. Numbers
      // are locked separately, so this never affects predictions or zero-sum.
      const needsText = (e?: { sentence?: string }) =>
        !e || !e.sentence || e.sentence.trim().length < 12;
      const missingNames = players
        .filter(p => needsText(aiOutput.find(a => a.name === p.name)))
        .map(p => p.name);
      if (missingNames.length > 0) {
        console.log(`🔁 ${missingNames.length} player(s) missing AI text, retrying:`, missingNames.join(', '));
        const supplements = await retryMissingForecastText(missingNames, playerCardByName, apiKey);
        for (const s of supplements) {
          if (needsText(s)) continue;
          const idx = aiOutput.findIndex(a => a.name === s.name);
          if (idx >= 0) aiOutput[idx] = s;
          else aiOutput.push(s);
        }
        if (supplements.length > 0) console.log(`✅ Retry filled ${supplements.filter(s => !needsText(s)).length} player(s)`);
      }

      let forecasts: ForecastResult[] = players.map(p => {
        const aiEntry = aiOutput.find(a => a.name === p.name);
        const suggestion = playerSuggestions.find(s => s.name === p.name);
        return {
          name: p.name,
          expectedProfit: suggestion?.suggested || 0,
          highlight: aiEntry?.highlight || '',
          sentence: aiEntry?.sentence || '',
          isSurprise: surpriseNames.has(p.name),
          preGameTeaser: '',
        };
      });
      if (preGameTeaser && forecasts.length > 0) {
        forecasts[0].preGameTeaser = preGameTeaser;
      }
      
      console.log('🔗 Merged AI text with locked predictions:', forecasts.map(f => `${f.name}: ${f.expectedProfit >= 0 ? '+' : ''}${f.expectedProfit}`).join(', '));
      
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

          correctedSentence = correctedSentence
            .replace(/מוביל את הטבלה/g, `נמצא במקום ${rankTonight}`)
            .replace(/בראש הטבלה/g, `במקום ${rankTonight}`)
            .replace(/מקום ראשון/g, `מקום ${rankTonight}`)
            .replace(/מקום 1\b/g, `מקום ${rankTonight}`)
            .replace(/#1\b/g, `#${rankTonight}`);
        }
        
        // Fix "king/ruler of rankings" for non-#1 players
        if (rankTonight !== 1) {
          if (/מלך\s*ה(דירוג|טבלה)/.test(correctedSentence) || /שולט\s*ב(דירוג|טבלה)/.test(correctedSentence)) {
            errorDetails.push(`rank_title: "מלך/שולט" used for #${rankTonight}`);
            correctedSentence = correctedSentence
              .replace(/מלך\s*ה(דירוג|טבלה)/g, `מקום ${rankTonight} ב$1`)
              .replace(/שולט\s*ב(דירוג|טבלה)/g, `במקום ${rankTonight} ב$1`);
          }
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
        
        // Fix "king/ruler" in highlight for non-#1
        if (rankTonight !== 1) {
          if (/מלך\s*ה(דירוג|טבלה)/.test(correctedHighlight) || /שולט\s*ב(דירוג|טבלה)/.test(correctedHighlight)) {
            errorDetails.push(`highlight rank_title: "מלך/שולט" used for #${rankTonight}`);
            correctedHighlight = correctedHighlight
              .replace(/מלך\s*ה(דירוג|טבלה)/g, `מקום ${rankTonight} ב$1`)
              .replace(/שולט\s*ב(דירוג|טבלה)/g, `במקום ${rankTonight} ב$1`);
          }
        }
        
        // ========== 3. FIX LAST GAME ERRORS ==========
        // Contradictions about last game → drop AI sentence (fallback is direction-aware)
        if (wonLastGame && correctedSentence.includes('הפסד') && /אחרון|אחרונה|קודם|שעבר/.test(correctedSentence)) {
          errorDetails.push('last_game: claimed loss but actually won');
          correctedSentence = '';
        }
        if (
          lostLastGame &&
          /אחרון|אחרונה|קודם|שעבר/.test(correctedSentence) &&
          /(נצחון|ניצחון|ניצח\b|נצח\b)/.test(correctedSentence)
        ) {
          errorDetails.push('last_game: claimed win but actually lost');
          correctedSentence = '';
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
          .replace(/(?:כדי\s*)?(?:לא\s*לרדת|להימנע\s*מ[-−]?ירידה)\s*(?:מתחת\s*)?(?:[למב][-−]?\s*)?(?:(?:הפסד|מינוס)\s*(?:כולל|מצטבר|היסטורי)?\s*(?:של\s*)?)?[-−]?\s*\d+₪\s*(?:הפסד\s*)?(?:כולל|מצטבר)?/g, '')
          .replace(/סה"כ\s*(הפסד\s*(של\s*)?)?[-−]?\s*\d+₪/g, '')
          .replace(/(?:[למב][-−]?\s*)?(הפסד|מינוס)\s*(כולל|היסטורי|מצטבר)\s*(של\s*)?[-−]?\s*\d+₪/g, '')
          .replace(/מ[-−]\s*\d+₪\s*הפסד\s*(כולל|היסטורי)/g, '')
          .replace(/(?:[למב][-−]?\s*)?[-−]?\d{3,}₪\s*(הפסד\s*)?(כולל|מצטבר|היסטורי)/g, '');
        
        // Clean up orphaned fragments left by stripping:
        // Single-letter prepositions (ל/מ/ב/ה/ו/כ/ש), connective words (של/את/על/עם/כי/אם/או/כש)
        // and trailing conjunctions/incomplete phrases before sentence end
        correctedSentence = correctedSentence
          .replace(/\s+[למבהוכש][-−]?\s*\./g, '.')
          .replace(/\s+[למבהוכש][-−]?\s*$/g, '')
          .replace(/\s+(?:של|את|על|עם|כי|גם|אם|או|כש|אחרי|לפני|בשביל|כדי(?:\s*לא)?(?:\s*לרדת)?)\s*\./g, '.')
          .replace(/\s+(?:של|את|על|עם|כי|גם|אם|או|כש|אחרי|לפני|בשביל|כדי(?:\s*לא)?(?:\s*לרדת)?)\s*$/g, '')
          .replace(/,\s*\./g, '.').replace(/,\s*,/g, ',').replace(/\s+/g, ' ').replace(/\.\s*\./g, '.').trim();
        
        // ========== 6b. STRIP FORECAST NUMBER FROM SENTENCE ==========
        // The AI often leaks the prediction number into the text despite instructions
        const predictedProfit = forecast.expectedProfit;
        const absProfit = Math.abs(predictedProfit);
        if (absProfit > 0) {
          const profitStr = String(absProfit);
          const leakPatterns = [
            new RegExp(`(רווח|הפסד|יעד|מכוון)\\s*(של|ל|ל-)?\\s*[-+]?${profitStr}`, 'g'),
            new RegExp(`[-+]?₪?${profitStr}₪?\\s*(רווח|הפסד)`, 'g'),
            new RegExp(`(לרווח|להפסד|מכוון ל|שואף ל)[-+\\s]*${profitStr}`, 'g'),
            new RegExp(`עם\\s*[-+]?${profitStr}`, 'g'),
          ];
          for (const pattern of leakPatterns) {
            if (pattern.test(correctedSentence)) {
              errorDetails.push(`number_leak: prediction ${predictedProfit} found in sentence`);
              correctedSentence = correctedSentence.replace(pattern, '').trim();
            }
          }
          correctedSentence = correctedSentence.replace(/\s+/g, ' ').replace(/,\s*,/g, ',').replace(/,\s*\./g, '.').replace(/\.\s*\./g, '.').trim();
        }
        
        // ========== 6c. REMOVE DUPLICATE PHRASES ==========
        {
          const sentenceWords = correctedSentence.split(/\s+/);
          if (sentenceWords.length >= 8) {
            for (let phraseLen = Math.min(8, Math.floor(sentenceWords.length / 2)); phraseLen >= 4; phraseLen--) {
              let found = false;
              for (let i = 0; i <= sentenceWords.length - phraseLen * 2; i++) {
                const phrase = sentenceWords.slice(i, i + phraseLen).join(' ');
                for (let j = i + phraseLen; j <= sentenceWords.length - phraseLen; j++) {
                  const candidate = sentenceWords.slice(j, j + phraseLen).join(' ');
                  if (phrase === candidate) {
                    sentenceWords.splice(j, phraseLen);
                    errorDetails.push(`duplicate_phrase: removed repeated "${phrase}"`);
                    found = true;
                    break;
                  }
                }
                if (found) break;
              }
              if (found) {
                correctedSentence = sentenceWords.join(' ');
                correctedSentence = correctedSentence.replace(/\s+/g, ' ').replace(/,\s*,/g, ',').replace(/,\s*\./g, '.').trim();
                break;
              }
            }
          }
        }
        
        // ========== 7. TEXT-NUMBER CONSISTENCY CHECK ==========
        const allTimeAvg = Math.round(player.avgProfit);
        const winRate = player.gamesPlayed > 0 ? Math.round((player.winCount / player.gamesPlayed) * 100) : 0;
        
        // Detect optimistic / pessimistic tone vs locked prediction (Hebrew — expand beyond verbs)
        const optimisticWords = [
          'ינצח', 'יצליח', 'מסוכן', 'רכבת', 'מוביל', 'פורמה מטורפת', 'הולך לנצח', 'בדרך לפסגה', 'שולט', 'דומיננטי',
          'הצלחה', 'גלים', 'רוכב', 'בפסגה', 'שורף', 'בוער', 'כובש', 'דומיננט', 'מלכות', 'מבריק', 'זינוק', 'עלייה חדה',
        ];
        const pessimisticWords = ['ספונסר', 'תורם', 'קשה', 'מאתגר', 'חלודה', 'נופל', 'סובל', 'בעיה', 'ייאוש', 'טובע'];
        const superlativeWords = ['מטורף', 'מדהים', 'היסטורי', 'חסר תקדים', 'מושלם', 'אגדי', 'פנומנלי'];
        const hedgeWords = /אבל|עדיין|החיזוי|הערב|זהיר|לא פשוט|מאתגר|צריך|חייב להוכיח|אתגר/;
        
        // Only flag superlatives for truly tiny predictions (±20 or less)
        if (Math.abs(predictedProfit) <= 20) {
          for (const word of superlativeWords) {
            if (correctedSentence.includes(word)) {
              errorDetails.push(`intensity_mismatch: "${word}" used for tiny prediction ${predictedProfit}`);

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
        const hasHedge = hedgeWords.test(correctedSentence);
        
        // Negative prediction: block celebratory tone (lower bar than before; hedge can salvage borderline cases)
        if (predictedProfit <= -25 && hasOptimistic && !hasPessimistic && !(hasHedge && predictedProfit > -55)) {
          errorDetails.push(`tone_mismatch: optimistic text but predicted ${predictedProfit} — replacing`);
          correctedSentence = '';
        }
        if (predictedProfit >= 35 && hasPessimistic && !hasOptimistic) {
          errorDetails.push(`tone_mismatch: pessimistic text but predicted \u200E+${predictedProfit} — replacing`);
          correctedSentence = '';
        }

        // ========== 7b. HIGHLIGHT VS LOCKED PREDICTION ==========
        const hl = correctedHighlight;
        const successImageryInHighlight = [
          'גלים', 'הצלחה', 'רוכב', 'בפסגה', 'שורף', 'בוער', 'דומיננט', 'מלכות', 'כובש', 'מוביל את הערב',
          'מלך הערב', 'שולט בערב', 'נושא גביע', 'בשיא הכושר',
          'מומנטום', 'ניצחון', 'נצחון', 'רוח גבית',
        ];
        const doomImageryInHighlight = ['ייאוש', 'אסון', 'טובע', 'טביעה', 'נכשל', 'חור שחור'];
        if (predictedProfit < 0 && successImageryInHighlight.some(m => hl.includes(m))) {
          errorDetails.push('highlight_sign: success imagery with negative prediction');
          correctedHighlight = rankTonight <= 3
            ? `מקום ${rankTonight} — ערב מאתגר לפי החיזוי`
            : `מקום ${rankTonight} — צריך להתאושש`;
        } else if (predictedProfit >= 40 && doomImageryInHighlight.some(m => hl.includes(m))) {
          errorDetails.push('highlight_sign: doom imagery with strong positive prediction');
          correctedHighlight = actualStreak >= 2
            ? `מומנטום חיובי בחיזוי`
            : `מקום ${rankTonight} — אופטימיות מדודה`;
        }
        
        // ========== FINAL CLEANUP ==========
        // Remove any orphaned fragments at sentence end (prepositions, connectives)
        correctedSentence = correctedSentence
          .replace(/\s+[למבהוכש][-−]?\s*\./g, '.')
          .replace(/\s+[למבהוכש][-−]?\s*$/g, '')
          .replace(/\s+(?:של|את|על|עם|כי|גם|אם|או|כש|אחרי|לפני|בשביל|כדי)\s*\./g, '.')
          .replace(/\s+(?:של|את|על|עם|כי|גם|אם|או|כש|אחרי|לפני|בשביל|כדי)\s*$/g, '')
          .replace(/,\s*\./g, '.').replace(/,\s*,/g, ',').replace(/\s+/g, ' ').replace(/\.\s*\./g, '.').trim();
        
        // ========== 8. VALIDATE AI SENTENCE (fallback if empty/short) ==========
        if (!correctedSentence || correctedSentence.length < 10 || correctedSentence === 'X') {
          // Generate direction-appropriate fallback
          if (predictedProfit >= 40) {
            if (actualStreak >= 3) correctedSentence = `${actualStreak} נצחונות ברצף, ממוצע \u200E+${allTimeAvg} ב-${player.gamesPlayed} משחקים. הרוח בגב!`;
            else correctedSentence = `ממוצע \u200E+${allTimeAvg} ב-${player.gamesPlayed} משחקים, ${winRate}% נצחונות. ערב טוב צפוי`;
          } else if (predictedProfit <= -40) {
            correctedSentence = `${player.gamesPlayed} משחקים ו-${winRate}% נצחונות, אבל הנתונים לא מבשרים טובות. ערב מאתגר`;
          } else if (predictedProfit > 0) {
            correctedSentence = `${winRate}% נצחונות ב-${player.gamesPlayed} משחקים, מקום ${rankTonight}. יתרון קל הפעם`;
          } else {
            correctedSentence = `${player.gamesPlayed} משחקים, ${winRate}% נצחונות. צריך לעבוד קשה הפעם`;
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

      recordSuccess(config.model, 'Forecast', forecastTokens, forecastFallbackFrom, forecastRlHeaders);
      return forecasts;

    } catch (fetchError) {
      // NO_API_KEY / AI_PROXY_UNAVAILABLE are infrastructure sentinels —
      // re-throw so the caller's catch can route to the friendly notice
      // instead of getting swallowed and turned into the misleading
      // "rate limited" final throw below.
      if (fetchError instanceof Error && (
        fetchError.message === 'NO_API_KEY' ||
        fetchError.message === 'AI_PROXY_UNAVAILABLE'
      )) throw fetchError;
      console.log(`   ❌ ${config.model} fetch error:`, fetchError);
      continue; // Try next model
    }
  }
  
  // All models failed
  console.error('❌ All AI models failed');
  // A clear key/auth error hits every model identically — surface the real
  // Google reason (invalid key, API disabled, referrer/IP restriction) so
  // the caller shows it instead of a pointless rate-limit countdown.
  if (lastForecastError && (lastForecastStatus === 400 || lastForecastStatus === 401 || lastForecastStatus === 403)) {
    throw new Error(`FORECAST_FAILED: ${lastForecastError}`);
  }
  throw new Error('All AI models are rate limited or unavailable. Try again in a few minutes.');
};


/**
 * First, try to list available models to diagnose the issue
 */
const listAvailableModels = async (apiKey: string): Promise<string[]> => {
  const models: string[] = [];
  
  for (const version of ['v1beta', 'v1']) {
    try {
      console.log(`📋 Listing models with ${version}...`);
      
      const response = await proxyGeminiModels(apiKey, version);
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
    console.log(`\n🧪 Trying ${config.version} / ${config.model}...`);
    
    try {
      const response = await proxyGeminiGenerate(config.version, config.model, apiKey, {
        contents: [{ parts: [{ text: 'Say: OK' }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 5 }
      });

      if (response.ok) {
        console.log(`✅ SUCCESS! ${config.version}/${config.model} works!`);
        return true;
      }
      
      const errorData = await response.json().catch(() => ({}));
      const errorMsg = errorData?.error?.message || `Status ${response.status}`;
      
      if (response.status === 429) {
        console.log(`⚠️ ${config.version}/${config.model}: Rate limited but KEY IS VALID!`);
        return true;
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

// ─── Live Model Availability Test ────────────────────────────────────────────

export interface ModelTestResult {
  model: string;
  displayName: string;
  status: 'available' | 'rate_limited' | 'error';
  rateLimitResetsAt?: string;
  responseTimeMs?: number;
  remaining?: number;
  limit?: number;
}

export const testModelAvailability = async (): Promise<ModelTestResult[]> => {
  const apiKey = getGeminiApiKey();
  if (!apiKey) return API_CONFIGS.map(c => ({ model: c.model, displayName: getModelDisplayName(c.model), status: 'error' as const }));

  const results: ModelTestResult[] = [];

  for (const config of API_CONFIGS) {
    const start = Date.now();

    try {
      const response = await proxyGeminiGenerate(config.version, config.model, apiKey, {
        contents: [{ parts: [{ text: 'Say: OK' }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 5 },
      });

      const elapsed = Date.now() - start;
      const rlHeaders = readRateLimitHeaders(response);

      const remaining = rlHeaders?.remaining;
      const limit = rlHeaders?.limit;

      if (response.ok) {
        recordSuccess(config.model, 'test', 0, undefined, rlHeaders);
        results.push({ model: config.model, displayName: getModelDisplayName(config.model), status: 'available', responseTimeMs: elapsed, remaining, limit });
      } else if (response.status === 429) {
        const errData = await response.json().catch(() => ({}));
        const errMsg = errData?.error?.message || '';
        recordRateLimit(config.model, rlHeaders, errMsg);
        results.push({ model: config.model, displayName: getModelDisplayName(config.model), status: 'rate_limited', responseTimeMs: elapsed, remaining, limit });
      } else {
        const errBody = await response.text().catch(() => '');
        console.warn(`AI test ${config.model}: HTTP ${response.status}`, errBody.substring(0, 300));
        results.push({ model: config.model, displayName: getModelDisplayName(config.model), status: 'error', responseTimeMs: elapsed });
      }
    } catch (err) {
      console.warn(`AI test ${config.model}: exception`, err);
      results.push({ model: config.model, displayName: getModelDisplayName(config.model), status: 'error' });
    }
  }

  return results;
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

  const prompt = `אתה מסכם תחזית פוקר בעברית. כל הסכומים בשקלים (₪). כתוב משפט סיכום קצר ורלוונטי (עד 25 מילים) על הצלחת התחזית.

נתונים:
- ציון כולל: ${score}/${maxScore} (${scorePercent}%) - ${rating}
- כיוון נכון (רווח/הפסד): ${directionHits}/${total}
- מדויק (פער ≤30): ${accurate}/${total}
- קרוב (פער 31-60): ${close}/${total}  
- החטאה (פער >60): ${missed}/${total}
- תחזית מדויקת ביותר: ${bestPrediction.name} (פער ${bestPrediction.gap})
- תחזית רחוקה ביותר: ${worstPrediction.name} (פער ${worstPrediction.gap})
${buildTraitBlock(comparisons.map(c => c.name))}
כתוב משפט סיכום שכולל את אחוז הכיוון (${directionHits}/${total}) ותובנה על התחזית. לא להיות מצחיק. כתוב רק את המשפט.`;

  try {
    const result = await callWithFallback({
      prompt,
      apiKey,
      temperature: 0.7,
      maxOutputTokens: 1024,
      label: 'Forecast comparison',
    });
    return result.text;
  } catch {
    return `${accurate} מדויקים, ${close} קרובים, ${missed} החטאות מתוך ${total} תחזיות`;
  }
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
  periodLabel: string;
  periodStandings: GameNightPeriodStanding[];
  recordsBroken: string[];
  notableStreaks: string[];
  upsets: string[];
  milestones: string[];
  welcomeBacks: string[];
  rankingShifts: string[];
  gameNumberInPeriod: number;
  location?: string;
  locationInsights?: string;
  periodMarkers?: PeriodMarkers;
  comboHistoryText?: string;
}

export interface AiGenerationMeta {
  model: string;
  promptTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  totalTokens: number;
}

export interface AiSummaryResult {
  text: string;
  meta: AiGenerationMeta;
}

export const generateGameNightSummary = async (
  payload: GameNightSummaryPayload
): Promise<AiSummaryResult> => {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error('NO_API_KEY');

  const { tonight, totalRebuys, totalPot, periodLabel, periodStandings, recordsBroken, notableStreaks, upsets, milestones, welcomeBacks, rankingShifts, gameNumberInPeriod, locationInsights: summaryLocationInsights, periodMarkers: summaryPeriodMarkers, comboHistoryText } = payload;

  if (tonight.length === 0) throw new Error('No players in tonight results');

  const tonightLines = tonight.map(p =>
    `${p.rank}. ${p.name}: ${p.profit >= 0 ? '+' : ''}${p.profit} (${p.rebuys} קניות)`
  ).join('\n');

  const standingsLines = periodStandings.map(s =>
    `מקום ${s.periodRank}: ${s.name} — ${s.totalProfit >= 0 ? '+' : ''}${s.totalProfit}, ${s.gamesPlayed} משחקים, ${Math.round(s.winPct)}% נצחונות${s.currentStreak !== 0 ? `, רצף ${s.currentStreak > 0 ? s.currentStreak + ' נצחונות' : Math.abs(s.currentStreak) + ' הפסדים'}` : ''}`
  ).join('\n');

  const contextSections: string[] = [];

  if (recordsBroken.length > 0) {
    contextSections.push(`🏆 שיאים שנשברו הערב:\n${recordsBroken.join('\n')}`);
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
  if (comboHistoryText) {
    contextSections.push(comboHistoryText);
  }
  if (summaryLocationInsights) {
    contextSections.push(summaryLocationInsights);
  }

  const contextBlock = contextSections.length > 0
    ? `\n\nאירועים מיוחדים הערב:\n${contextSections.join('\n\n')}`
    : '';

  // Pick a random writing style so consecutive summaries feel fresh
  const styles = [
    { name: 'פרשן ספורט', desc: 'כתוב כמו פרשן ספורט ישראלי — דרמטי, עם שידור חי, ומתח. "הכדור ברשת!"' },
    { name: 'כתב עיתון', desc: 'כתוב כמו כתבה בעיתון הבוקר — עובדתי אבל עם עקיצות בין השורות. כותרת בפנים.' },
    { name: 'מספר סיפורים', desc: 'כתוב כמו סיפור קצר — מתח, עלילה, דמויות. כל שחקן הוא דמות בסיפור הערב.' },
    { name: 'סטנדאפיסט', desc: 'כתוב כמו מונולוג סטנדאפ — ביטים, עקיצות, תצפיות מצחיקות על מה שקרה. הומור קודם.' },
    { name: 'מכתב לחבר', desc: 'כתוב כמו הודעת וואטסאפ מחבר שהיה שם — אישי, ישיר, עם "אחי לא תאמין מה קרה".' },
    { name: 'פרשן פוליטי', desc: 'כתוב כמו פרשנות פוליטית — "קואליציות", "הפיכות", "צעד אסטרטגי", "מהפך" — אבל על פוקר.' },
  ];
  const style = styles[Math.floor(Math.random() * styles.length)];

  // Build period-ending summary section if applicable
  const periodEndingLines: string[] = [];
  if (summaryPeriodMarkers) {
    if (summaryPeriodMarkers.isLastGameOfMonth) {
      periodEndingLines.push(`📅 זהו המשחק האחרון של חודש ${summaryPeriodMarkers.monthName}. הוסף פסקה קצרה שמסכמת את החודש — מי הוביל, תוצאות בולטות, מגמות.`);
    }
    if (summaryPeriodMarkers.isLastGameOfHalf) {
      periodEndingLines.push(`📅 זהו המשחק האחרון של ${summaryPeriodMarkers.halfLabel}! הוסף פסקה ייעודית שמסכמת את המחצית — מי שלט, אילו קרבות היו, מה השתנה, ותחזית למחצית הבאה.`);
    }
    if (summaryPeriodMarkers.isLastGameOfYear) {
      periodEndingLines.push(`📅 זהו המשחק האחרון של שנת ${summaryPeriodMarkers.year}! הוסף פסקה ייעודית שמסכמת את השנה כולה — אלוף השנה, רגעים היסטוריים, שיאים, ותחזית לשנה הבאה.`);
    }
  }
  const periodEndingBlock = periodEndingLines.length > 0
    ? `\n\n🗓️ אירוע תקופתי (חובה — הוסף פסקאות ייעודיות!):\n${periodEndingLines.join('\n')}`
    : '';

  const prompt = `כתוב סיכום ערב פוקר שבועי בין חברים. הסיכום ישותף בקבוצת הוואטסאפ שלהם.
כל הסכומים בשקלים — זה כסף אמיתי. כשאתה מזכיר סכומים, כתוב "שקל" או "שקלים".

🎨 סגנון הכתיבה הערב: ${style.name}
${style.desc}

📊 נתוני הערב (משחק #${gameNumberInPeriod} ב${periodLabel}):
קופה: ${totalPot} (${totalRebuys} קניות סה״כ)

תוצאות:
${tonightLines}

טבלת ${periodLabel} (מעודכנת כולל הערב):
${standingsLines}${contextBlock}${periodEndingBlock}${buildTraitBlock(tonight.map(p => p.name))}
✍️ הנחיות:
- עברית טבעית וזורמת. הזכר את כל ${tonight.length} השחקנים בשמם
- 2-3 פסקאות קצרות (שורה ריקה ביניהן), כל פסקה 2-4 משפטים. סה״כ 60-120 מילים${periodEndingLines.length > 0 ? ` (+ פסקאות תקופתיות נוספות)` : ''}
- שלב עובדות (רצפים, שיאים, דירוגים) בצורה טבעית בתוך הסיפור — לא כרשימה
- שיאים ורגעים היסטוריים הם הדבר הכי חשוב: כניסה ל-Top 20, שיא אישי, שיא קבוצתי — אלה רגעים נדירים שהשחקנים מתרגשים מהם. אם מופיעים באירועים מיוחדים — חגוג אותם, תן להם מקום מרכזי בסיפור
- אם יש מידע על הרכב חוזר (🔄) — שלב אותו: ציין שזה הרכב שכבר שיחק יחד, האם הדפוסים המשיכו או נשברו
- "${periodLabel}" = שם התקופה (מחצית של שנה). אם מזכירים → "בתקופת ${periodLabel}" או "במחצית"
- סיים עם פאנץ׳ליין, עקיצה, או הצצה לשבוע הבא

⚠️ דיוק עובדתי:
- כל מספר, רווח, הפסד, רצף, שיא ודירוג חייבים להגיע ישירות מהנתונים למעלה
- שינויי דירוג מופיעים ב"שינויים בטבלה" — אם לא מופיע שם, אל תטען שמישהו עלה/ירד/עקף
- אל תמציא עובדות ביוגרפיות. אם סופקו תכונות שחקנים — שלב לכל היותר אזכור אחד קצר, ורק אם זה באמת מוסיף לסיפור. ברוב הסיכומים עדיף בלי בכלל ולהסתמך על נתוני המשחקים
- אל תמציא שיאים או הישגים שלא מופיעים בנתונים
- אם לא בטוח — השמט. עדיף קצר ומדויק מאשר ארוך עם המצאות

🚫 הימנע מ:
- פתיחות שחוקות ("ערב של דרמות", "לילה של...")
- רשימות עם נקודות/מספרים
- כינויים חוזרים — תואר לשחקן חייב להיות ייחודי ויצירתי

כתוב את הסיכום.`;

  const result = await callWithFallback({
    prompt,
    apiKey,
    temperature: 0.9,
    maxOutputTokens: 4096,
    topP: 0.95,
    label: 'AI summary',
  });

  const cleaned = result.text
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/^#{1,3}\s+/gm, '')
    .trim();

  if (cleaned.length > 50) {
    return {
      text: cleaned,
      meta: {
        model: result.model,
        promptTokens: result.usage?.promptTokens || 0,
        outputTokens: result.usage?.outputTokens || 0,
        thinkingTokens: result.usage?.thinkingTokens || 0,
        totalTokens: result.usage?.totalTokens || 0,
      },
    };
  }

  throw new Error('All AI models failed to generate game summary');
};

// ─── AI Game-Night Comic ──────────────────────────────────────────────────
// Three-stage pipeline:
//   Stage 1 (text):   generateComicScript()        — JSON script
//   Stage 2 (image):  generateComicArt()           — PNG, art only
//   Stage 3 (text):   detectComicBoundingBoxes()   — face bboxes per panel
//
// Hebrew dialogue is rendered as DOM text on top of the art client-side.
// The model never draws letters, which guarantees crisp Hebrew typography.

// Image generation provider. Google's Gemini image models (Nano Banana
// family) are paid-tier only — the free API tier returns `limit: 0` for
// every image-generation request. We fall back to Pollinations.ai which
// offers anonymous access to FLUX (Black Forest Labs, 12B params) for
// free, with no API key. Trade-off: 60-90s latency vs Nano Banana's
// 5-15s, and slightly less character consistency. Quality is good
// enough for our manually-triggered comic feature.
//
// Kept as a constant so we have a single place to swap providers if
// Pollinations ever becomes unreliable (e.g. switch to Cloudflare
// Workers AI Flux with a user-supplied token).
const IMAGE_PROVIDER = 'pollinations' as const;
const IMAGE_MODEL = 'flux' as const;

// Structured logger for the comic pipeline — every line is prefixed [comic]
// so you can grep the browser console / Vercel logs for exactly the comic
// generation timeline. Includes elapsed-ms since stage start.
const comicLog = (event: string, fields?: Record<string, unknown>) => {
  const payload = fields ? { event, ...fields } : { event };
  // eslint-disable-next-line no-console
  console.log(`[comic] ${event}`, payload);
};
const comicWarn = (event: string, fields?: Record<string, unknown>) => {
  const payload = fields ? { event, ...fields } : { event };
  // eslint-disable-next-line no-console
  console.warn(`[comic] ${event}`, payload);
};
const comicError = (event: string, fields?: Record<string, unknown>) => {
  const payload = fields ? { event, ...fields } : { event };
  // eslint-disable-next-line no-console
  console.error(`[comic] ${event}`, payload);
};

interface ComicScriptInputPayload {
  date: string;
  weekday: string;
  tonight: { name: string; profit: number; rebuys: number; rank: number }[];
  totalPot: number;
  totalRebuys: number;
  recordsBroken: string[];
  notableStreaks: string[];
  upsets: string[];
  rankingShifts: string[];
  comboHistoryText?: string;
  styleVibe: string; // from ComicStyle.scriptVibe
}

/**
 * Stage 1 — generate a JSON script for a 4-panel comic.
 * Reuses the same factual data as generateGameNightSummary but distills
 * it into a 4-beat narrative with Hebrew dialogue.
 */
export const generateComicScript = async (
  payload: ComicScriptInputPayload,
  styleKey: ComicStyleKey,
): Promise<{ script: ComicScript; model: string }> => {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error('NO_API_KEY');
  if (payload.tonight.length === 0) throw new Error('No players for comic script');

  const tonightLines = payload.tonight.map(p =>
    `${p.rank}. ${p.name}: ${p.profit >= 0 ? '+' : ''}${p.profit} שקלים, ${p.rebuys} קניות`,
  ).join('\n');

  const dramaSections: string[] = [];
  if (payload.recordsBroken.length) dramaSections.push(`שיאים: ${payload.recordsBroken.join(' | ')}`);
  if (payload.notableStreaks.length) dramaSections.push(`רצפים: ${payload.notableStreaks.join(' | ')}`);
  if (payload.upsets.length) dramaSections.push(`הפתעות: ${payload.upsets.join(' | ')}`);
  if (payload.rankingShifts.length) dramaSections.push(`שינויי דירוג: ${payload.rankingShifts.join(' | ')}`);
  if (payload.comboHistoryText) dramaSections.push(payload.comboHistoryText);

  const drama = dramaSections.length ? `\n\nאירועים מיוחדים:\n${dramaSections.join('\n')}` : '';

  const winner = payload.tonight[0];
  const loser = payload.tonight[payload.tonight.length - 1];

  const prompt = `אתה תסריטאי קומיקס. צור תסריט לעמוד קומיקס בן 4 פאנלים על ערב פוקר אמיתי בין חברים.

🎭 רוח הסיפור (חובה לתפוס את המצב הזה): ${payload.styleVibe}

📊 נתונים אמיתיים מהערב:
תאריך: ${payload.weekday} ${payload.date}
קופה: ${payload.totalPot} שקלים (${payload.totalRebuys} קניות סה״כ)
תוצאות:
${tonightLines}${drama}

הפאנלים מספרים את הקשת הדרמטית של הערב:
פאנל 1 — פתיחה / מתח: בית, שולחן, הסטים, הצגת הדמויות הבולטות
פאנל 2 — הקרב המרכזי / רגע מפנה
פאנל 3 — שיא דרמטי (ניצחון, קאמבק, הפסד גדול, הפתעה)
פאנל 4 — סגירה / פאנץ׳ עם ${winner.name} כמנצח (+${winner.profit}) ו-${loser.name} כמפסיד הגדול (${loser.profit})

📐 פלט JSON תקני בלבד (ללא markdown, ללא הסברים), במבנה הזה בדיוק:

{
  "title": "כותרת קצרה בעברית, עד 5 מילים",
  "panels": [
    {
      "id": 1,
      "scene": "ENGLISH, ONE sentence, CHARACTER-FIRST. Start with the character name and a vivid ACTION (e.g. 'Yossi slams his cards down with a triumphant grin' or 'Dani clutches his head as his last chip slides across the table'). Describe pose, facial expression, and ONE prop or gesture. Do NOT describe lighting, atmosphere, depth of field, camera angle, or cinematic mood. Do NOT describe wide rooms or establishing shots — characters fill the frame.",
      "characters": ["name:expression", "name:expression"],
      "bubbles": [
        { "speaker": "exact player name OR 'narrator'", "text": "דיאלוג קצר בעברית — מקסימום 5 מילים", "type": "speech | thought | shout | caption" }
      ]
    }
  ]
}

⚠️ חובה:
- כל פאנל: 1-2 בועות בלבד (לא 3, לא 4). דיאלוג קצר וקולע — מקסימום 5 מילים, רצוי 3-4
- כל ${payload.tonight.length} השחקנים חייבים להופיע באחד הפאנלים לפחות
- "speaker" חייב להיות בדיוק אחד מהשמות: ${payload.tonight.map(p => `"${p.name}"`).join(', ')} או "narrator"
- "type": "caption" רק כש-speaker = "narrator"
- "scene" באנגלית, משפט אחד בלבד, מתחיל בשם דמות ופועל פעולה (לא בתיאור חדר)
- אסור להזכיר ב-scene מילים כמו: lighting, atmosphere, mood, cinematic, depth of field, ambient, soft focus, camera angle, wide shot, establishing
- דיאלוג בעברית טבעית, לא תרגומית. עברית של שולחן פוקר בין חברים. מותר סלנג קל
- אל תמציא סכומים או דירוגים שלא מופיעים למעלה
- characters: רשימה של "name:expression" בלבד (למשל "yossi:focused", "dani:sweating") — ייעזר באמני הציור לעקביות בין פאנלים

החזר JSON תקני בלבד, בלי טקסט נוסף.`;

  const stageStart = Date.now();
  comicLog('script:start', { style: styleKey, players: payload.tonight.length, promptChars: prompt.length });

  const result = await callWithFallback({
    prompt,
    apiKey,
    temperature: 0.85,
    maxOutputTokens: 4096,
    topP: 0.95,
    responseMimeType: 'application/json',
    label: 'Comic script',
  });

  let parsed: { title: string; panels: ComicPanel[] };
  try {
    parsed = JSON.parse(result.text);
  } catch (err) {
    comicError('script:parse_failed', { model: result.model, error: (err as Error).message, sample: result.text.slice(0, 200) });
    throw new Error(`Comic script JSON parse failed: ${(err as Error).message}`);
  }

  if (!Array.isArray(parsed.panels) || parsed.panels.length !== 4) {
    comicError('script:invalid_shape', { model: result.model, panelCount: parsed.panels?.length });
    throw new Error(`Comic script must have exactly 4 panels (got ${parsed.panels?.length})`);
  }

  // Light sanity-pass: enforce id 1-4, drop empty bubbles, clamp dialogue length.
  const panels: ComicPanel[] = parsed.panels.map((p, i) => ({
    id: ((p.id || i + 1) as 1 | 2 | 3 | 4),
    scene: String(p.scene || '').slice(0, 600),
    characters: Array.isArray(p.characters) ? p.characters.map(String).slice(0, 6) : [],
    bubbles: Array.isArray(p.bubbles)
      ? p.bubbles
          .filter(b => b && typeof b.text === 'string' && b.text.trim().length > 0)
          .slice(0, 2)
          .map(b => ({
            speaker: String(b.speaker || 'narrator').trim(),
            text: String(b.text).trim().slice(0, 60),
            type: (['speech', 'thought', 'shout', 'caption'].includes(b.type as string)
              ? b.type
              : 'speech') as ComicPanel['bubbles'][number]['type'],
          }))
      : [],
  }));

  const script: ComicScript = {
    style: styleKey,
    title: String(parsed.title || '').slice(0, 60),
    panels,
    layout: '2x2',
    modelText: getModelDisplayName(result.model),
  };

  comicLog('script:success', {
    model: result.model,
    title: script.title,
    panelCount: panels.length,
    bubbleCount: panels.reduce((acc, p) => acc + p.bubbles.length, 0),
    totalStageMs: Date.now() - stageStart,
  });

  return { script, model: result.model };
};

/**
 * Stage 2 — generate the comic art image at maximum quality.
 *
 * Strategy: hybrid parallel-then-sequential.
 *   Phase 1 (optimistic): fire all 4 panels in parallel with small
 *     250ms staggers. If Pollinations' anonymous tier happens to allow
 *     concurrent requests at this moment, all 4 succeed in ~90s and
 *     we're done.
 *   Phase 2 (fallback): for any panel that returned 429 (Pollinations'
 *     anonymous tier currently caps at 1 concurrent generation), retry
 *     each one SEQUENTIALLY with exponential backoff (3s, 6s, 12s).
 *
 * Worst case is 4 sequential ~90s generations = ~5-6 minutes. Best case
 * is ~90s. Real-world average sits in between depending on Pollinations'
 * server load. Each panel is 1024x1024 — FLUX's native training
 * resolution where it produces its best work — composited into a
 * 2068x2068 final 2x2 grid via canvas with thin dark gutters.
 *
 * Why this beats the previous single-shot 4-in-1 approach:
 *   - Each panel gets FLUX's full attention (no quadrant-splitting)
 *   - "No text" instruction reinforced 4 separate times → near-zero
 *     letter leakage instead of frequent
 *   - Layout/borders are drawn by canvas, not begged from the model
 *   - Final resolution is 2x sharper (2068 vs 1024)
 *
 * Trade-off: character consistency is best-effort. Same character
 * roster fed to each panel prompt, same base seed, but FLUX without
 * reference images can't perfectly preserve faces. Acceptable for our
 * manually-triggered stylistic feature.
 *
 * Per-panel progress: optional callback invoked each time a panel
 * completes so the UI can show "panel 3 of 4" instead of a stuck
 * spinner during long sequential retries.
 */
export const generateComicArt = async (
  script: ComicScript,
  onPanelProgress?: (completed: number, total: number) => void,
): Promise<{ base64: string; mimeType: string; width: number; height: number; model: string }> => {
  if (!navigator.onLine) {
    throw new Error('אין חיבור לאינטרנט — לא ניתן להפעיל AI');
  }

  const style = getComicStyle(script.style);
  const cleanedStyleFragment = stripComicLayoutKeywords(style.promptFragment);
  const cleanedNegative = stripComicLayoutKeywords(style.negativePrompt);
  const characterRoster = collectCharacterRoster(script);

  const buildPanelPrompt = (panel: ComicPanel): string => {
    const charLine = panel.characters.length > 0
      ? ` Characters in this panel: ${panel.characters.join(', ')}.`
      : '';
    // Order matters: diffusion models give later tokens slightly more
    // weight, so we end with the strongest constraints (style + no-text).
    // We LEAD with the "illustration not photo" directive because Sana/
    // FLUX default to photorealistic output unless told otherwise; we
    // also center the prompt on the CHARACTERS doing an ACTION (not on
    // the environment) so the model fills the frame with people instead
    // of empty rooms.
    return [
      `A single hand-drawn cartoon comic-book illustration panel — NOT a photograph, NOT photorealistic, NOT cinematic photography.`,
      `${cleanedStyleFragment}.`,
      `Subject (fills the frame): ${panel.scene}${charLine}`,
      characterRoster,
      `Composition: characters drawn LARGE and CENTERED in the panel, expressive faces clearly visible, full bodies or torso-up framing. The panel is FULL of character action — no empty rooms, no wide establishing shots.`,
      // Hammer the no-text constraint — without it both Sana and FLUX
      // freely render gibberish letters that become real text leakage.
      `Absolutely NO text anywhere in the image: no letters, no words, no numbers, no Hebrew, no English, no signs, no captions, no speech bubbles, no panel numbers, no watermarks, no logos, no writing of any kind. Pure illustration only — speech bubbles are added separately as an overlay.`,
      `Negative: ${cleanedNegative}, photograph, photo, photorealistic, realistic, cinematic, depth of field, bokeh, ambient occlusion, empty room, wide establishing shot.`,
    ].filter(Boolean).join(' ');
  };

  // Same base seed for all 4 panels, plus per-panel offset. Same base helps
  // FLUX produce visually similar character designs across panels (loose
  // continuity); per-panel offset ensures each panel is a distinct image
  // rather than 4 copies. Random component keeps every regeneration fresh.
  const baseSeed = (Date.now() % 1_000_000) + Math.floor(Math.random() * 1000);
  const TOTAL = script.panels.length;

  const stageStart = Date.now();
  comicLog('art:start', {
    provider: IMAGE_PROVIDER,
    model: IMAGE_MODEL,
    style: script.style,
    strategy: 'hybrid-parallel-then-sequential',
    panelCount: TOTAL,
    panelPx: PANEL_PX,
    baseSeed,
  });

  type PanelResult = { panelId: 1 | 2 | 3 | 4; blob: Blob; mimeType: string; model: string };

  // Generate one panel once. Throws on any error (the caller decides what
  // to do with rate-limit vs hard errors).
  const generatePanelOnce = async (panel: ComicPanel, seedOffset: number): Promise<PanelResult> => {
    const prompt = buildPanelPrompt(panel);
    const seed = baseSeed + panel.id * 7919 + seedOffset; // 7919 = prime
    const taskStart = Date.now();
    comicLog('art:panel_attempt', { panelId: panel.id, seed, promptChars: prompt.length });
    const { blob, mimeType, model } = await pollinationsImage(prompt, {
      width: PANEL_PX,
      height: PANEL_PX,
      seed,
      model: IMAGE_MODEL,
      nologo: true,
    });
    comicLog('art:panel_success', {
      panelId: panel.id,
      seed,
      sizeKB: Math.round(blob.size / 1024),
      ms: Date.now() - taskStart,
    });
    return { panelId: panel.id as 1 | 2 | 3 | 4, blob, mimeType, model };
  };

  const results: Array<PanelResult | null> = new Array(TOTAL).fill(null);
  let completed = 0;
  const reportProgress = () => {
    onPanelProgress?.(completed, TOTAL);
    comicLog('art:progress', { completed, total: TOTAL, elapsedMs: Date.now() - stageStart });
  };

  // ── Phase 1: optimistic parallel ──
  const STAGGER_MS = 250;
  const phase1 = await Promise.allSettled(
    script.panels.map(async (panel, idx) => {
      if (idx > 0) await sleep(idx * STAGGER_MS);
      try {
        const r = await generatePanelOnce(panel, 0);
        results[idx] = r;
        completed += 1;
        reportProgress();
        return r;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        comicWarn('art:panel_phase1_failed', { panelId: panel.id, message: errMsg });
        throw err;
      }
    }),
  );

  const failedIndices = phase1
    .map((r, i) => (r.status === 'rejected' ? i : -1))
    .filter(i => i >= 0);

  comicLog('art:phase1_complete', {
    succeeded: TOTAL - failedIndices.length,
    failed: failedIndices.length,
    elapsedMs: Date.now() - stageStart,
  });

  // ── Phase 2: sequential retry for any failures ──
  // Pollinations anonymous tier rate-limits to ~1 concurrent generation,
  // so concurrent calls beyond the first commonly return 429 instantly.
  // We retry those one at a time with exponential backoff. Non-rate-limit
  // errors (network, 5xx, etc.) are treated as final immediately.
  const RETRY_DELAYS_MS = [3000, 6000, 12000];
  const isRateLimitError = (err: unknown): boolean => {
    const msg = err instanceof Error ? err.message : String(err);
    return /\b429\b|too many requests|rate limit/i.test(msg);
  };

  for (const idx of failedIndices) {
    const panel = script.panels[idx];
    let lastErr: unknown;
    let succeeded = false;

    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
        comicLog('art:panel_retry_wait', { panelId: panel.id, attempt, delayMs: delay });
        await sleep(delay);
      }
      try {
        // Use a different seed offset on retry so we don't hit any
        // accidental cache collision with a previous failed attempt.
        const r = await generatePanelOnce(panel, attempt * 1000);
        results[idx] = r;
        completed += 1;
        reportProgress();
        succeeded = true;
        break;
      } catch (err) {
        lastErr = err;
        const rateLimited = isRateLimitError(err);
        comicWarn('art:panel_retry_failed', {
          panelId: panel.id,
          attempt: attempt + 1,
          rateLimited,
          message: err instanceof Error ? err.message : String(err),
        });
        // Hard errors (not 429) — don't waste retries.
        if (!rateLimited) break;
      }
    }

    if (!succeeded) {
      comicError('art:panel_exhausted', {
        panelId: panel.id,
        message: lastErr instanceof Error ? lastErr.message : String(lastErr),
        totalStageMs: Date.now() - stageStart,
      });
      throw new Error(`Panel ${panel.id} failed after retries: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
    }
  }

  const finalResults = results as PanelResult[];
  if (finalResults.some(r => !r)) {
    throw new Error('Comic image generation: missing panel(s) after retry phase');
  }

  // ── Composite via canvas ──
  let composite: { blob: Blob; mimeType: string; width: number; height: number };
  try {
    composite = await composePanelsToGrid(finalResults);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    comicError('art:compose_failed', {
      message: errMsg,
      totalStageMs: Date.now() - stageStart,
    });
    throw new Error(`Comic compositing failed: ${errMsg}`);
  }

  const base64 = await blobToBase64(composite.blob);

  const totalMs = Date.now() - stageStart;
  comicLog('art:success', {
    provider: IMAGE_PROVIDER,
    model: IMAGE_MODEL,
    strategy: 'hybrid-parallel-then-sequential',
    panelCount: finalResults.length,
    parallelSucceededCount: TOTAL - failedIndices.length,
    sequentialRetryCount: failedIndices.length,
    finalSizeKB: Math.round(composite.blob.size / 1024),
    width: composite.width,
    height: composite.height,
    totalStageMs: totalMs,
  });

  return {
    base64,
    mimeType: composite.mimeType,
    width: composite.width,
    height: composite.height,
    model: finalResults[0]?.model || `pollinations/${IMAGE_MODEL}`,
  };
};

// ─── Per-panel constants and helpers ──────────────────────────────────────

/** Edge length of each individual panel image in pixels. 1024 is FLUX's
 * native training resolution — going higher often degrades quality,
 * going lower throws away detail the model already produces. */
const PANEL_PX = 1024;
/** Thin gutter between panels in the composite. */
const GUTTER_PX = 10;
/** Outer border thickness around the whole composite. */
const BORDER_PX = 8;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Strip layout/grid keywords from a style prompt. The original style
 * fragments were written for the single-shot 4-in-1 approach and contain
 * phrases like "thick black panel borders 2x2 grid layout with 12px
 * gutter". When we generate one panel at a time, those phrases confuse
 * FLUX into drawing nested grids inside each panel. Removing the
 * comma-separated descriptors that mention panel/grid/gutter cleans this
 * up without rewriting the style definitions.
 */
const stripComicLayoutKeywords = (prompt: string): string => {
  return prompt
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .filter(s => !/(\b|^)(panel|grid|gutter|layout|2x2)(\b|s\b)/i.test(s))
    .join(', ');
};

/**
 * Composite 4 individual panel images into a single 2x2 grid on a canvas
 * with thin dark gutters and an outer border. Returns a JPEG blob and the
 * final pixel dimensions.
 *
 * Panel positions are deterministic by panelId:
 *   1 → top-left, 2 → top-right, 3 → bottom-left, 4 → bottom-right
 *
 * If a panel is missing (shouldn't happen since Promise.all throws on
 * failure, but defensive), that quadrant is filled with the gutter color
 * so the layout still reads as a 2x2 grid.
 */
const composePanelsToGrid = async (
  panels: Array<{ panelId: 1 | 2 | 3 | 4; blob: Blob }>,
): Promise<{ blob: Blob; mimeType: string; width: number; height: number }> => {
  const dim = 2 * PANEL_PX + GUTTER_PX + 2 * BORDER_PX;
  const canvas = document.createElement('canvas');
  canvas.width = dim;
  canvas.height = dim;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  // Fill background (acts as the gutter + outer-border color).
  ctx.fillStyle = '#0e0e0e';
  ctx.fillRect(0, 0, dim, dim);

  const positions: Record<1 | 2 | 3 | 4, { x: number; y: number }> = {
    1: { x: BORDER_PX, y: BORDER_PX },
    2: { x: BORDER_PX + PANEL_PX + GUTTER_PX, y: BORDER_PX },
    3: { x: BORDER_PX, y: BORDER_PX + PANEL_PX + GUTTER_PX },
    4: { x: BORDER_PX + PANEL_PX + GUTTER_PX, y: BORDER_PX + PANEL_PX + GUTTER_PX },
  };

  const loadBlobImage = (blob: Blob): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      const objectUrl = URL.createObjectURL(blob);
      img.onload = () => { URL.revokeObjectURL(objectUrl); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('panel image load failed')); };
      img.src = objectUrl;
    });

  // Draw panels in their 2x2 positions, scaling each to PANEL_PX x PANEL_PX
  // so even slightly off-size returns from Pollinations land in the grid.
  for (const panel of panels) {
    const pos = positions[panel.panelId];
    if (!pos) continue;
    const img = await loadBlobImage(panel.blob);
    ctx.drawImage(img, pos.x, pos.y, PANEL_PX, PANEL_PX);
  }

  const blob: Blob = await new Promise((resolve, reject) => {
    canvas.toBlob(b => {
      if (b) resolve(b);
      else reject(new Error('canvas.toBlob returned null'));
    }, 'image/jpeg', 0.92);
  });

  return { blob, mimeType: 'image/jpeg', width: dim, height: dim };
};

/**
 * Stage 3 — ask Gemini to locate each speaker's face/anchor point in
 * the rendered image, returned as normalized [yMin, xMin, yMax, xMax]
 * (Gemini's native 0-1000 bbox format, which we re-normalize to 0..1).
 *
 * Per-bubble, this lets the client overlay the speech bubble pointing
 * to the correct character with a tail anchored to their face.
 */
export const detectComicBoundingBoxes = async (
  imageBase64: string,
  mimeType: string,
  script: ComicScript,
): Promise<ComicScript> => {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error('NO_API_KEY');

  // Build per-panel speaker request. We only ask for speakers that aren't
  // narrator (captions float free at the panel corner).
  const requests = script.panels.map(p => {
    const speakers = p.bubbles
      .filter(b => b.type !== 'caption' && b.speaker !== 'narrator')
      .map(b => b.speaker);
    return {
      panel: p.id,
      panelPosition: panelPosition(p.id),
      speakers: Array.from(new Set(speakers)),
    };
  }).filter(r => r.speakers.length > 0);

  if (requests.length === 0) {
    comicLog('bbox:skipped', { reason: 'no_speakers' });
    return { ...script, panels: script.panels };
  }

  const stageStart = Date.now();
  comicLog('bbox:start', {
    requestPanels: requests.length,
    totalSpeakers: requests.reduce((acc, r) => acc + r.speakers.length, 0),
  });

  const prompt = `You are looking at a 4-panel poker comic image (2x2 grid: panel 1 top-left, panel 2 top-right, panel 3 bottom-left, panel 4 bottom-right).

For each panel and each requested character, return the bounding box of that character's FACE (or upper torso if face is obscured) in the FULL image. Use Gemini's standard normalized format: [ymin, xmin, ymax, xmax] with values 0-1000 relative to the full image dimensions (NOT to the panel).

Characters are described informally — match by visual prominence within the requested panel quadrant.

Requested panels and characters:
${requests.map(r => `Panel ${r.panel} (${r.panelPosition}): ${r.speakers.join(', ')}`).join('\n')}

Return ONLY valid JSON in this exact shape, no markdown, no commentary:
{
  "panels": [
    { "panel": 1, "boxes": [ { "name": "<requested name>", "box": [ymin, xmin, ymax, xmax] } ] }
  ]
}

If you cannot confidently locate a character, omit them from the output.`;

  // Use gemini-2.5-flash for bbox detection: it's a deterministic structured
  // extraction task (not creative writing), so we benefit from a non-thinking
  // model that's faster + cheaper + doesn't waste output tokens on reasoning.
  const response = await proxyGeminiGenerate('v1beta', 'gemini-2.5-flash', apiKey, {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mimeType, data: imageBase64 } },
      ],
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 1024,
      responseMimeType: 'application/json',
    },
  });

  if (!response.ok) {
    // Bbox detection is best-effort — fall back to no bboxes; client will
    // place bubbles in default panel-corner positions.
    const errData = await response.json().catch(() => ({}));
    comicWarn('bbox:http_error_nonfatal', {
      status: response.status,
      message: (errData as { error?: { message?: string } })?.error?.message || 'unknown',
      ms: Date.now() - stageStart,
    });
    return script;
  }

  let parsed: { panels?: { panel: number; boxes?: { name: string; box: number[] }[] }[] };
  try {
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    parsed = JSON.parse(text);
  } catch (err) {
    comicWarn('bbox:parse_failed_nonfatal', {
      message: err instanceof Error ? err.message : String(err),
      ms: Date.now() - stageStart,
    });
    return script;
  }

  if (!Array.isArray(parsed.panels)) {
    comicWarn('bbox:invalid_shape_nonfatal', { ms: Date.now() - stageStart });
    return script;
  }

  const updated: ComicPanel[] = script.panels.map(p => {
    const entry = parsed.panels!.find(e => e.panel === p.id);
    if (!entry || !Array.isArray(entry.boxes)) return p;
    const bboxes: NonNullable<ComicPanel['bboxes']> = {};
    for (const b of entry.boxes) {
      if (!b || typeof b.name !== 'string' || !Array.isArray(b.box) || b.box.length !== 4) continue;
      const [yMin, xMin, yMax, xMax] = b.box.map(Number);
      if ([yMin, xMin, yMax, xMax].some(v => !Number.isFinite(v))) continue;
      // Gemini returns 0..1000; normalize to 0..1.
      bboxes[b.name] = [yMin / 1000, xMin / 1000, yMax / 1000, xMax / 1000];
    }
    return Object.keys(bboxes).length > 0 ? { ...p, bboxes } : p;
  });

  const totalBoxes = updated.reduce((acc, p) => acc + Object.keys(p.bboxes || {}).length, 0);
  comicLog('bbox:success', {
    boxesFound: totalBoxes,
    panelsWithBoxes: updated.filter(p => p.bboxes && Object.keys(p.bboxes).length > 0).length,
    totalStageMs: Date.now() - stageStart,
  });

  return { ...script, panels: updated };
};

// ─── Comic helpers ────────────────────────────────────────────────────────

const panelPosition = (id: number): string => {
  switch (id) {
    case 1: return 'top-left';
    case 2: return 'top-right';
    case 3: return 'bottom-left';
    case 4: return 'bottom-right';
    default: return 'top-left';
  }
};

const collectCharacterRoster = (script: ComicScript): string => {
  const map = new Map<string, string>();
  for (const p of script.panels) {
    for (const c of p.characters) {
      const [name, expr] = c.split(':');
      if (!name) continue;
      if (!map.has(name)) map.set(name, expr || '');
    }
  }
  if (map.size === 0) return '';
  return 'Roster: ' + Array.from(map.entries())
    .map(([name, expr]) => expr ? `"${name}" (${expr.replace(/[",]/g, ' ')})` : `"${name}"`)
    .join(', ') + '.';
};

/**
 * Convert a Blob to its raw base64 payload (without the
 * "data:<mime>;base64," prefix). Used to feed the Pollinations JPEG into
 * the rest of the pipeline (bbox detection + Storage upload), which both
 * expect base64.
 */
const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('FileReader returned non-string result'));
        return;
      }
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('FileReader error'));
    reader.readAsDataURL(blob);
  });
};

// ─── AI Player Chronicle ──────────────────────────────────────────────────

export interface ChroniclePlayerData {
  playerId: string;
  name: string;
  periodRank: number;
  totalProfit: number;
  gamesPlayed: number;
  winPercentage: number;
  avgProfit: number;
  currentStreak: number;
  biggestWin: number;
  biggestLoss: number;
  avgRebuysPerGame: number | null;
  lastGameDate: string | null;
  daysSinceLastGame: number;
  recentForm: string;
  archetype: string;
  allTimeRank: number | null;
  allTimeGames: number | null;
  allTimeProfit: number | null;
}

export interface ChroniclePayload {
  players: ChroniclePlayerData[];
  periodLabel: string;
  totalPeriodGames: number;
  isEarlyPeriod: boolean;
  milestones: string[];
}

export const generatePlayerChronicle = async (
  payload: ChroniclePayload
): Promise<{ profiles: Record<string, string>; model: string }> => {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error('NO_API_KEY');

  const { players, periodLabel, totalPeriodGames, isEarlyPeriod, milestones } = payload;
  if (players.length === 0) throw new Error('No players for chronicle');

  const playerLines = players.map(p => {
    const parts = [
      `[${p.playerId}] ${p.name}`,
      `מקום ${p.periodRank}, ${p.totalProfit >= 0 ? '+' : ''}${p.totalProfit}`,
      `${p.gamesPlayed} משחקים, ${Math.round(p.winPercentage)}% נצחונות`,
      `ממוצע ${p.avgProfit >= 0 ? '+' : ''}${Math.round(p.avgProfit)}`,
      `ארכיטיפ: ${p.archetype}`,
    ];
    if (p.currentStreak !== 0)
      parts.push(`רצף: ${p.currentStreak > 0 ? p.currentStreak + ' נצחונות' : Math.abs(p.currentStreak) + ' הפסדים'}`);
    parts.push(`שיא: \u200E+${Math.round(p.biggestWin)}, שפל: ${Math.round(p.biggestLoss)}`);
    if (p.avgRebuysPerGame != null)
      parts.push(`קניות בממוצע: ${p.avgRebuysPerGame.toFixed(1)}`);
    if (p.daysSinceLastGame > 10)
      parts.push(`נעדר ${p.daysSinceLastGame} יום`);
    parts.push(`פורמה אחרונה: ${p.recentForm}`);
    if (p.allTimeRank != null && p.allTimeGames != null)
      parts.push(`כל הזמנים: מקום ${p.allTimeRank}, ${p.allTimeGames} משחקים, ${p.allTimeProfit! >= 0 ? '+' : ''}${p.allTimeProfit}`);
    return parts.join(' | ');
  }).join('\n');

  const styles = [
    { name: 'פרשן ספורט', desc: 'כתוב כמו פרשן ספורט ישראלי — דרמטי, ציורי, עם "ניצחון מוחץ", "מנצח נגד הסיכויים".' },
    { name: 'כתב עיתון', desc: 'כתוב כמו כתבה בעיתון — עובדתי, חד, עם כותרת משנה לכל שחקן.' },
    { name: 'מספר סיפורים', desc: 'כתוב כמו סיפור קצר — כל שחקן הוא דמות. בונה עלילה ומתח.' },
    { name: 'מכתב לחבר', desc: 'כתוב כמו הודעת וואטסאפ — "אחי, מה שקורה לX זה לא נורמלי". אישי וקולע.' },
    { name: 'פרשן פוליטי', desc: 'כתוב כמו פרשנות פוליטית — "קואליציות", "הפיכות", "צעד טקטי" — אבל על פוקר.' },
    { name: 'כרוניקה היסטורית', desc: 'כתוב כמו כרוניקה של ימי הביניים — "בני האצולה", "הפרשים", "המלך ירד מכסאו".' },
  ];
  const style = styles[Math.floor(Math.random() * styles.length)];

  const prompt = `אתה כותב פרופיל אישי קצר לכל שחקן בליגת פוקר בין חברים. הפרופילים יוצגו בדף הסטטיסטיקה.
💰 כל הסכומים בשקלים (₪). כשאתה מזכיר סכומים בטקסט, כתוב "שקל/שקלים" — זה כסף אמיתי, לא נקודות.

🎨 סגנון: ${style.name}
${style.desc}

📋 תקופה: "${periodLabel}" (${totalPeriodGames} משחקים)${isEarlyPeriod ? ' — התקופה רק התחילה, היזהר ממסקנות גורפות' : ''}

📊 נתוני השחקנים (מדורגים לפי רווח):
${playerLines}${milestones.length > 0 ? `

🏆 אבני דרך ואירועים בולטים בתקופה:
${milestones.join('\n')}` : ''}${buildTraitBlock(players.map(p => p.name))}
✍️ כללי כתיבה:
- כתוב פסקה אחת (2-4 משפטים) לכל שחקן
- עברית טבעית, זורמת, מעניינת — לא רובוטית, לא טמפלייט
- השווה בין שחקנים! ("בזמן ש-X שולט, Y מנסה להחזיר")
- שלב נתונים אמיתיים (מספרים, רצפים, דירוגים) בצורה טבעית
- אם שחקן נעדר — ציין את זה בהקשר הסיפור
- אם יש פער בין דירוג התקופה לכל הזמנים — זה מעניין, ציין
- כל שחקן צריך להרגיש ייחודי — אל תחזור על אותו מבנה
- אל תתחיל 2 פרופילים באותו אופן
- אם יש אבני דרך רלוונטיות לשחקן — שלב אותן בסיפור בצורה טבעית

⚠️ דיוק עובדתי (חובה מוחלטת):
- כל מספר, דירוג, רצף ותוצאה חייבים להגיע מהנתונים שלמעלה בלבד
- אל תמציא עובדות. אם סופקו תכונות שחקנים — שלב לכל היותר אזכור אחד קצר, ורק אם זה באמת מוסיף לפרופיל. לרוב עדיף לבנות סביב הנתונים הסטטיסטיים בלבד
- אם לא בטוח — השמט. עדיף קצר ומדויק מאשר ארוך עם המצאות

📤 פורמט הפלט:
כתוב כל פרופיל בשורה נפרדת בפורמט:
PLAYER_ID:::הטקסט של הפרופיל

דוגמה (לא להעתיק — רק פורמט):
abc123:::בזמן שכולם מחפשים את הנוסחה, הוא כבר מצא אותה. 3 נצחונות מתוך 5, ממוצע +85, ומקום ראשון שלא מפתיע אף אחד.

כתוב את הפרופילים.`;

  const result = await callWithFallback({
    prompt,
    apiKey,
    temperature: 0.9,
    maxOutputTokens: 4096,
    topP: 0.95,
    label: 'Chronicle',
  });

  const cleaned = result.text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`/g, '')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/^#{1,3}\s+/gm, '')
    .trim();

  const profiles: Record<string, string> = {};
  const lines = cleaned.split('\n').filter((l: string) => l.includes(':::'));
  for (const line of lines) {
    const sepIdx = line.indexOf(':::');
    if (sepIdx === -1) continue;
    const rawId = line.substring(0, sepIdx).trim();
    const id = rawId.replace(/^[-–—•\s]+/, '').trim();
    const story = line.substring(sepIdx + 3).trim();
    if (id && story) profiles[id] = story;
  }

  if (Object.keys(profiles).length === 0) {
    console.warn('Chronicle raw response (no parseable profiles):', result.text.substring(0, 500));
    const playerIds = players.map(p => p.playerId);
    const allLines = cleaned.split('\n').filter(l => l.trim().length > 20);
    for (const line of allLines) {
      for (const pid of playerIds) {
        if (line.includes(pid) && !profiles[pid]) {
          const afterId = line.substring(line.indexOf(pid) + pid.length).replace(/^[\s:—\-|]+/, '').trim();
          if (afterId.length > 20) profiles[pid] = afterId;
          break;
        }
      }
    }
  }

  if (Object.keys(profiles).length === 0) {
    throw new Error('Chronicle returned text but no parseable profiles');
  }

  console.log(`Chronicle generated via ${result.model}: ${Object.keys(profiles).length} profiles`);
  return { profiles, model: result.model };
};

// ─── AI Graph Insights (group-level narrative for Graphs page) ──────────────

export const generateGraphInsights = async (
  playerStats: PlayerStats[],
  periodLabel: string,
  totalGames: number,
  isEarlyPeriod: boolean
): Promise<string> => {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error('NO_API_KEY');

  if (playerStats.length === 0) throw new Error('No player stats for graph insights');

  const sorted = [...playerStats].sort((a, b) => b.totalProfit - a.totalProfit);

  const playerLines = sorted.map((p, i) => {
    const parts = [
      `${i + 1}. ${p.playerName}`,
      `רווח כולל: ${p.totalProfit >= 0 ? '+' : ''}${Math.round(p.totalProfit)}`,
      `${p.gamesPlayed} משחקים`,
      `${Math.round(p.winPercentage)}% נצחונות`,
      `ממוצע ${p.avgProfit >= 0 ? '+' : ''}${Math.round(p.avgProfit)}`,
    ];
    if (i < sorted.length - 1) {
      const gap = Math.round(p.totalProfit - sorted[i + 1].totalProfit);
      parts.push(`פער מהבא: ${gap}`);
    }
    if (i > 0) {
      const gapAbove = Math.round(sorted[i - 1].totalProfit - p.totalProfit);
      parts.push(`פער מלמעלה: ${gapAbove}`);
    }
    if (p.currentStreak !== 0) {
      parts.push(`רצף: ${p.currentStreak > 0 ? p.currentStreak + ' נצחונות' : Math.abs(p.currentStreak) + ' הפסדים'}`);
    }
    parts.push(`שיא: \u200E+${Math.round(p.biggestWin)}, שפל: ${Math.round(p.biggestLoss)}`);
    if (p.longestWinStreak >= 3) parts.push(`שיא רצף נצחונות: ${p.longestWinStreak}`);
    if (p.longestLossStreak >= 3) parts.push(`שיא רצף הפסדים: ${p.longestLossStreak}`);
    return parts.join(' | ');
  }).join('\n');

  const styles = [
    'פרשן ספורט ישראלי שמנתח את הליגה ברגע הכי חם של העונה',
    'כתב עיתון שכותב טור שבועי על מאזן הכוחות בשולחן',
    'מספר סיפורים שנון שמציג את הדרמות והקשרים בקבוצה',
    'פרשן פוליטי שמנתח את הקואליציות וההפיכות בטבלת הפוקר',
    'כרוניקאי היסטורי שמתעד את עליות ומפלות הגיבורים',
  ];
  const style = styles[Math.floor(Math.random() * styles.length)];

  const prompt = `אתה ${style}. כתוב פסקה אחת רציפה בעברית (60-120 מילים) שמספרת את סיפור הקבוצה בתקופת "${periodLabel}".
💰 כל הסכומים בשקלים (₪). כשאתה מזכיר סכומים בטקסט, כתוב "שקל/שקלים" — זה כסף אמיתי, לא נקודות.

📊 טבלת השחקנים (${totalGames} משחקים${isEarlyPeriod ? ', התקופה רק התחילה' : ''}):
${playerLines}
${buildTraitBlock(sorted.map(p => p.playerName))}
✍️ מה לכלול:
- מגמות: מי שולט? מי עולה? מי בנפילה?
- יריבויות ומרדפים: מי רודף את מי בטבלה? מהם הפערים?
- מומנטום: מי ברצף חם ומי בקרח? מי שובר שיאים?
- תחזית/ניחוש: מה צפוי בהמשך? מי יפתיע?
- הזכר כמה שיותר שחקנים בשמם

⚠️ כללים:
- פסקה אחת זורמת, לא רשימה עם נקודות
- כל מספר, רצף ודירוג חייבים להגיע מהנתונים שלמעלה בלבד
- אל תמציא עובדות. אם סופקו תכונות שחקנים — שלב לכל היותר אזכור אחד קצר ורק אם זה באמת תורם. לרוב עדיף לבנות סביב הנתונים בלבד
- "רווח כולל" = סך כל הרווח של השחקן. "פער" = ההפרש בין שני שחקנים סמוכים בטבלה. אלו מספרים שונים! אל תבלבל ביניהם
- כשמציין פער בטבלה, השתמש במספר מ"פער מהבא" או "פער מלמעלה", לא מהרווח הכולל
- אם לא בטוח — השמט${isEarlyPeriod ? '\n- התקופה רק התחילה, היזהר ממסקנות גורפות' : ''}

כתוב את הפסקה.`;

  const result = await callWithFallback({
    prompt,
    apiKey,
    temperature: 0.9,
    maxOutputTokens: 4096,
    topP: 0.95,
    label: 'Graph insights',
  });

  return result.text
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/^#{1,3}\s+/gm, '')
    .trim();
};

// --- Live Game TTS Pool Generator ---

interface TTSPlayerTraining {
  sessions: number;
  totalQuestions: number;
  accuracy: number;
}

interface TTSPlayerInput {
  id: string;
  name: string;
  stats: PlayerStats | null;
  traits: PlayerTraits | undefined;
  training: TTSPlayerTraining | null;
}

export const generateLiveGameTTSPool = async (
  gameId: string,
  playerIds: string[],
  playerNames: string[],
  allStats: PlayerStats[],
  location?: string,
): Promise<LiveGameTTSPool | null> => {
  const apiKey = getGeminiApiKey();
  if (!apiKey) return null;

  const rebuyRecords = getRebuyRecords();
  const comboHistory = getComboHistory(playerIds, gameId);

  let trainingByName: Record<string, TTSPlayerTraining> = {};
  try {
    const answersFile = await fetchTrainingAnswers();
    if (answersFile) {
      for (const pd of answersFile.players) {
        trainingByName[pd.playerName] = {
          sessions: pd.sessions.length,
          totalQuestions: pd.totalQuestions,
          accuracy: pd.accuracy,
        };
      }
    }
  } catch { /* training data is optional — don't block TTS generation */ }

  const players: TTSPlayerInput[] = playerIds.map((id, i) => ({
    id,
    name: playerNames[i],
    stats: allStats.find(s => s.playerId === id) || null,
    traits: getTraitsForPlayer(playerNames[i]),
    training: trainingByName[playerNames[i]] || null,
  }));

  // Subset of players whose traits are surfaced in the per-player rendering this run.
  // Cross-player rivalry detection (sameTeam/sameJob below) still uses the full traits
  // map — that's fun cross-player flavor, not the repetitive personality dumps.
  const surfacedTraitNames = new Set(selectTraitPlayers(playerNames) ?? []);

  const playerDataLines = players.map(p => {
    const gender = isPlayerFemale(p.name) ? 'נקבה' : 'זכר';
    const lines: string[] = [`═ ${p.name} (${gender}) ═`];

    if (p.traits && surfacedTraitNames.has(p.name)) {
      const traitParts: string[] = [];
      if (p.traits.job) traitParts.push(`עבודה: ${p.traits.job}`);
      if (p.traits.team) traitParts.push(`קבוצה: ${p.traits.team}`);
      if (p.traits.nickname) traitParts.push(`כינוי: ${p.traits.nickname}`);
      if (p.traits.style.length) traitParts.push(`סגנון: ${p.traits.style.join(', ')}`);
      if (p.traits.quirks.length) traitParts.push(`תכונות: ${p.traits.quirks.join(', ')}`);
      lines.push(traitParts.join(' | '));
    }

    if (p.stats && p.stats.gamesPlayed >= 2) {
      const s = p.stats;
      lines.push(`משחקים: ${s.gamesPlayed}, נצחונות: ${s.winCount} (${Math.round(s.winPercentage)}%), רווח כולל: ${Math.round(s.totalProfit)}`);
      lines.push(`ממוצע: ${Math.round(s.avgProfit)}, ממוצע קניות: ${s.avgRebuysPerGame.toFixed(1)}, סה"כ קניות: ${s.totalRebuys}`);
      lines.push(`שיא נצחון: \u200E+${Math.round(s.biggestWin)}, שיא הפסד: ${Math.round(s.biggestLoss)}`);
      const streak = s.currentStreak;
      if (streak >= 2) lines.push(`רצף: ${streak} נצחונות ברצף`);
      else if (streak <= -2) lines.push(`רצף: ${Math.abs(streak)} הפסדים ברצף`);
      const maxRebuys = rebuyRecords.playerMax.get(p.id) || 0;
      if (maxRebuys > 0) lines.push(`שיא קניות אישי: ${maxRebuys}`);
    } else {
      lines.push(`שחקן חדש / מעט היסטוריה`);
    }

    if (p.training) {
      lines.push(`אימון פוקר: ${p.training.sessions} סשנים, ${p.training.totalQuestions} שאלות, דיוק ${Math.round(p.training.accuracy)}%`);
    } else {
      lines.push(`אימון פוקר: לא התאמן כלל`);
    }

    return lines.join('\n');
  }).join('\n\n');

  const groupMaxRebuys = rebuyRecords.groupMax;
  const groupRecordHolder = rebuyRecords.groupMaxHolder;

  let comboText = '';
  if (!comboHistory.isFirstTime && comboHistory.totalGamesWithCombo >= 2) {
    const topWinners = comboHistory.repeatWinners.slice(0, 3).map(w => `${w.name} (${w.count} נצחונות)`).join(', ');
    const topLosers = comboHistory.repeatLosers.slice(0, 3).map(l => `${l.name} (${l.count} הפסדים)`).join(', ');
    comboText = `הרכב חוזר: ${comboHistory.totalGamesWithCombo} משחקים קודמים עם אותו הרכב.`;
    if (topWinners) comboText += ` מנצחים חוזרים: ${topWinners}.`;
    if (topLosers) comboText += ` מפסידים חוזרים: ${topLosers}.`;
  }

  const rivalryPairs: { p1: string; p2: string; desc: string }[] = [];
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i], b = players[j];
      if (!a.stats || !b.stats || a.stats.gamesPlayed < 3 || b.stats.gamesPlayed < 3) continue;
      const sameTeam = a.traits?.team && b.traits?.team && a.traits.team === b.traits.team;
      const sameJob = a.traits?.job && b.traits?.job && (a.traits.job === b.traits.job || (a.traits.job.includes('הייטק') && b.traits.job.includes('הייטק')));
      if (sameTeam) {
        rivalryPairs.push({ p1: a.name, p2: b.name, desc: `אוהדי ${a.traits!.team!} ביחד` });
      }
      if (sameJob) {
        rivalryPairs.push({ p1: a.name, p2: b.name, desc: `שניהם עובדים ב${a.traits!.job!}` });
      }
    }
  }

  const playerNamesList = players.map(p => p.name).join(', ');
  const numPlayers = players.length;

  const prompt = `אתה כותב יצירתי לאפליקציית פוקר. המשימה: ליצור בנק משפטים קצרים בעברית מושלמת להקראה קולית (TTS) בערב פוקר חי.
💰 כל הסכומים בשקלים. כשאתה מזכיר סכומים, כתוב "שקל/שקלים" — זה כסף אמיתי, לא נקודות.

הדרישה המרכזית: כל משפט חייב להיות ספציפי לשחקן ולמצב. אסורים משפטים גנריים שאפשר להגיד על כל אחד. עדיפות ראשונה (לפחות 90% מהמשפטים): נתונים סטטיסטיים אמיתיים מהמשחקים — אחוז נצחונות, רווח/הפסד כולל, רצפים, שיאים, ממוצע קניות, מספר משחקים, תוצאת משחק אחרון, דירוג בטבלה, פער מהשחקן שמעליו/מתחתיו. העדף תמיד נתונים שמשתנים בין משחקים (רצף נוכחי, תוצאה אחרונה, דירוג נוכחי) על פני נתונים קבועים (סה"כ משחקים, אחוז נצחונות כללי). עדיפות שנייה (אופציונלית, מקסימום 10%): עובדה אישית אחת בלבד — ורק עבור שחקנים שהוצגה עבורם תכונה במפורש למעלה. לשחקנים בלי תכונות שהוצגו, אסור לחלוטין לשלב עובדות אישיות (אל תמציא, אל תנחש). אם בכלל לא הוצגו תכונות הערב — בנה הכל על נתוני המשחקים. עובדה אישית היא תבלין נדיר ולא חובה.

═══ נתוני השחקנים ═══
${playerDataLines}

${comboText ? `═══ היסטוריית הרכב ═══\n${comboText}\n` : ''}${location ? `═══ מיקום ═══\n${location}\n` : ''}שיא קניות קבוצתי: ${groupMaxRebuys}${groupRecordHolder ? ` (שייך ל${groupRecordHolder})` : ''}
${rivalryPairs.length > 0 ? `\n═══ קשרים ═══\n${rivalryPairs.map(r => `${r.p1} ↔ ${r.p2}: ${r.desc}`).join('\n')}\n` : ''}
═══ הנחיות ═══

‼️ קריטי — מספר הקניות הנוכחי ב-{COUNT} בלבד:
כשהמשפט מתייחס למספר הקניות של השחקן בערב הזה — חובה מוחלטת להשתמש ב-{COUNT}. אסור לכתוב ספרה או מילה בעברית במקום ה-{COUNT}. זה הכי חשוב — משפטים שיכתבו ספרה/מילה כמספר קניות נוכחי, יידחו אוטומטית מהמערכת ולא יישמעו.
דוגמאות אסורות (יידחו): "כבר חמש קניות", "עוד שלוש קניות", "עם ארבע קניות", "קונה שש קניות הערב", "ארבע קניות וזה לא נגמר".
דוגמאות נכונות: "כבר {COUNT} קניות", "עוד {COUNT} קניות", "עם {COUNT} קניות הערב".
היחיד שמותר לכתוב מספר בעברית ליד "קניות" הוא כשמתייחסים לעבר/ממוצע/שיא: "ממוצע של שלוש קניות למשחק", "השיא שלו חמש קניות", "פעם קנה שמונה קניות", "במשחק הקודם ארבע קניות". זה מותר רק כשהמשפט כולל אחת מהמילים: ממוצע, שיא, בעבר, פעם, היסטור, בדרך כלל, תמיד, למשחק, הקודם, אף פעם.

כל "text" הוא 5-20 מילים, עברית דיבורית טבעית, מצחיק, חד וקולע.
המשפטים מיועדים להקראה ב-TTS (טקסט לדיבור) ולכן חשוב:
- משפטים קצרים ופשוטים — לא משפטים מורכבים עם פסוקיות מרובות
- נקודות (.) בין חלקי משפט ליצירת הפסקות טבעיות בהגייה
- כתיבה דיבורית — ככה שמישהו באמת מדבר, לא שפה גבוהה/ספרותית
- אל תכתוב ראשי תיבות, קיצורים, או סימנים מיוחדים (%, emoji)

דקדוק עברי חשוב — חובה:
- "שתי קניות" ולא "שתיים קניות" (צורת סמיכות לפני שם עצם נקבה)
- "שני משחקים" ולא "שניים משחקים" (צורת סמיכות לפני שם עצם זכר)
- "שתי" ו"שני" משמשים רק לפני שם עצם. בסוף משפט בלי שם עצם → "שתיים" / "שניים"
- קניות = נקבה (שלוש קניות, ארבע קניות)
- משחקים = זכר (שלושה משחקים, ארבעה משחקים)
- מין השחקן מצוין ליד שמו (זכר/נקבה) — חובה להתאים פעלים ותארים למין: "הוא קנה" / "היא קנתה", "מנצח" / "מנצחת", "שלו" / "שלה"

פלייסהולדרים (יוחלפו בזמן אמת):
- {PLAYER} = שם השחקן
- {COUNT} = מספר קניות (יומר לצורת סמיכות נקבה: "שתי", "שלוש" וכו')
- {RECORD} = שיא הקניות (יומר לעברית זכר: "שבעה")
- {RIVAL} = שם היריב
- {RANK} = מקום בטבלת הקניות (יומר למספר סודר: "ראשון", "שני", "שלישי")

חוקים:
1. כל משפט ייחודי לחלוטין — גם בין שחקנים שונים! אסור ששני שחקנים יקבלו משפט דומה או עם אותה תבנית. כל משפט חייב להשתמש בנתון ספציפי ששייך רק לאותו שחקן (מספר המשחקים שלו, אחוז הנצחונות שלו, הממוצע שלו). אם כתבת "מנצח ב-X אחוז" לשחקן אחד, אל תכתוב "מנצח ב-Y אחוז" לשחקן אחר — תמצא זווית אחרת (רצף, רווח, הפסד, ממוצע קניות).
2. עדיפות מוחלטת לנתוני משחקים: כמעט כל משפטי generic חייבים להתבסס על נתונים מהמשחקים — רצף נוכחי, תוצאת משחק אחרון, דירוג בטבלה, פער מהשחקן שמעל, ממוצע קניות, שיא רווח/הפסד. העדף נתונים דינמיים שמשתנים (רצף, תוצאה אחרונה, דירוג) על פני נתונים יציבים (סה"כ משחקים, אחוז כללי). שילוב עובדה אישית מותר לכל היותר במשפט אחד מתוך 6, ורק לשחקן שהוצגה עבורו תכונה למעלה. אם לשחקן לא הוצגה תכונה — אל תכניס לו עובדה אישית בכלל, גם אם נראה לך שאתה זוכר משהו.
3. הומור חברי — ציני אבל חם, בלי לפגוע
4. שחקן ללא היסטוריה → משפטי "ברוך הבא" ללא המצאת נתונים
5. בלי פתיחות חוזרות, בלי "נו" חוזר, בלי "עוד קנייה" חוזר
6. כשיש {COUNT} לפני "קניות" → לכתוב "{COUNT} קניות" (המערכת תתקן לצורת סמיכות אוטומטית)
7. נתוני אימון פוקר — לכל שחקן מצוין אם התאמן באפליקציה ומה רמת הדיוק שלו. זה מקור מצוין להערות ציניות וחבריות, במיוחד כשמישהו קונה הרבה: שחקן שלא התאמן כלל ועושה קניות → "אולי כדאי להתאמן קצת?". שחקן שהתאמן הרבה עם דיוק נמוך ועדיין קונה → "תאוריה בלי פרקטיקה". שחקן שהתאמן עם דיוק גבוה ועדיין קונה → "הידע לא עוזר הערב". שחקן שהתאמן עם דיוק גבוה ומנצח → "האימונים משתלמים". אל תשתמש בנתוני אימון בכל משפט — זה תבלין, לא מרכיב עיקרי. מקסימום 1-2 משפטים לשחקן שמשלבים אימון.

═══ קטגוריות ═══

"players" — לכל שחקן (${playerNamesList}):
  "generic": 6 משפטים — כל אחד חייב להיות ספציפי לשחקן הזה ורק לו. לפחות 4 מתוכם עם {COUNT}. חובה: לפחות 5 מתוך 6 מבוססים על נתוני משחקים דינמיים (רצף נוכחי, תוצאה אחרונה, דירוג בטבלה, ממוצע קניות, שיא רווח/הפסד, פער מהשחקן שמעל). מקסימום 1 על עובדה אישית (ורק עובדה אחת בודדת).
    דוגמאות טובות (כל אחד מתאים רק לשחקן אחד):
    - "מנצח בשישים אחוז מהמשחקים אבל הערב כנראה לא. כבר {COUNT} קניות" ← סטטיסטיקה ספציפית
    - "שיא רווח של שלוש מאות שקל, הערב בכיוון ההפוך. {COUNT} קניות" ← נתון היסטורי
    - "ממוצע של שלוש קניות למשחק, הערב שובר שיאים" ← ממוצע קניות ספציפי
    - "באיירן מנצחים, פיליפ מפסיד. {COUNT} קניות" ← עובדה אישית אחת בודדת
    - "עשרים שאלות אימון ואפס אחוז דיוק, ו{COUNT} קניות. תורת הפוקר בוכה" ← נתון אימון ספציפי
    - "לא התאמן פעם אחת אבל קונה כמו מקצוען. {COUNT} קניות" ← חוסר אימון
    דוגמאות רעות (גנריים, אסורים):
    - "עוד קנייה, הערב ארוך" ← אפשר להגיד על כל אחד
    - "{PLAYER} ממשיך להאמין, כבר {COUNT}" ← אפשר להגיד על כל אחד
    - "הקלפים לא מרחמים, {COUNT} קניות" ← אין שום עובדה אישית
  "anticipated":
    "above_avg": 2 משפטים — מספר קניות עלה על הממוצע האישי. חובה {COUNT}. לציין את הממוצע האמיתי מהנתונים.
    "record_tied": 2 משפטים — השווה לשיא האישי. חובה {COUNT} ו{RECORD}. אם השיא האישי רחוק מהקבוצתי — לציין את המרחק.
    "record_broken": 2 משפטים — שבר שיא אישי. חובה {COUNT}. לציין שזה שיא חדש. לציין את המרחק לשיא הקבוצתי אם רלוונטי.
    "is_leader": 2 משפטים — מוביל בקניות הערב. חובה {RANK} או {COUNT}.
    "rival_matched": 2 משפטים — השווה ליריב. חובה {RIVAL}. רק אם יש יריבות מוגדרת.
    "tied_for_lead": 2 משפטים — שניים/יותר שווים בראש טבלת הקניות. חובה {COUNT}.

"shared":
  "first_blood": לכל שחקן 2 משפטים — קנייה ראשונה של הערב. חובה {PLAYER}. לפחות אחד מבוסס על נתון סטטיסטי (אחוז נצחונות, רצף, רווח), השני יכול להיות עובדה אישית אחת בודדת.
  "bad_beat": לכל שחקן 3 משפטים — נאמרים כשקורה רגע כואב. חובה {PLAYER}. כל משפט חייב להתבסס על נתון סטטיסטי אמיתי (אחוז נצחונות, רצף, רווח/הפסד כולל, ממוצע קניות, שיא הפסד) ולתת תובנה מעניינת. למשל: "{PLAYER} עם 40 אחוז נצחונות, הידיים האלה לא אמורות לקרות", "כבר 3 הפסדים ברצף, הערב לא משתפר ל{PLAYER}". לא חייב להתחיל עם "יד כואבת" — המשפט צריך להיות טבעי. אסור מילים באנגלית.
  "bad_beat_generic": 5 משפטים ללא שם שחקן — תובנה קצרה שמתאימה לרגע כואב בפוקר. אסור מילים באנגלית.
  "big_hand": לכל שחקן 3 משפטים — נאמרים כשקורה רגע גדול. חובה {PLAYER}. כל משפט חייב להתבסס על נתון סטטיסטי אמיתי (אחוז נצחונות, רצף, רווח כולל, שיא רווח, ממוצע קניות) ולתת תובנה מעניינת. למשל: "{PLAYER} עם שיא רווח של 300, הערב בדרך לשיא חדש", "רצף רביעי, {PLAYER} בטופ פורם". לא חייב להתחיל עם "יד ענקית" — המשפט צריך להיות טבעי. אסור מילים באנגלית.
  "big_hand_generic": 5 משפטים ללא שם שחקן — תובנה קצרה שמתאימה לרגע גדול בפוקר. אסור מילים באנגלית.
  "break_time": 6 משפטים — נאמרים בהפסקה, אחרי סיכום מצב שנבנה אוטומטית. ללא פלייסהולדרים. כל משפט חייב לתת תובנה מעניינת מבוססת נתונים: מי מנצח הכי הרבה היסטורית, מי על רצף, השוואה מעניינת בין שחקנים, תחזית מי יסיים ברווח. לשלב שמות שחקנים ספציפיים מהערב הנוכחי. אסור משפטים גנריים כמו "הפסקה" או "נחים" — המערכת כבר אומרת את זה.
  "auto_announce": 10 משפטים — שקט ארוך. ללא פלייסהולדרים. חובה לשלב שמות ועובדות סטטיסטיות ספציפיות מהנתונים (מי מנצח הכי הרבה, מי מפסיד, רצפים, אחוזי נצחון). מקסימום 2 עם עובדה אישית.
  "awards_generosity": לכל שחקן 2 משפטים — מי שקנה הכי הרבה. חובה {PLAYER} ו{COUNT}. לפחות אחד מבוסס על נתון סטטיסטי.
  "awards_survival": לכל שחקן 2 משפטים — מי שקנה הכי פחות. חובה {PLAYER}. לפחות אחד מבוסס על נתון סטטיסטי.

"rivalries": מערך יריבויות. לכל אחת: player1, player2, description.

═══ פורמט JSON ═══
{
  "players": {
    "שם": {
      "generic": [{"text": "...", "placeholders": ["{COUNT}"]}, {"text": "משפט בלי COUNT, רק עובדה"}],
      "anticipated": {
        "above_avg": [{"text": "...", "placeholders": ["{COUNT}"]}],
        "tied_for_lead": [{"text": "...", "placeholders": ["{COUNT}"]}]
      }
    }
  },
  "shared": {
    "first_blood": {"שם": [{"text": "...", "placeholders": ["{PLAYER}"]}]},
    "bad_beat": {"שם": [{"text": "...", "placeholders": ["{PLAYER}"]}]},
    "bad_beat_generic": [{"text": "..."}],
    "big_hand": {"שם": [{"text": "...", "placeholders": ["{PLAYER}"]}]},
    "big_hand_generic": [{"text": "..."}],
    "break_time": [{"text": "..."}],
    "auto_announce": [{"text": "..."}],
    "awards_generosity": {"שם": [{"text": "...", "placeholders": ["{PLAYER}", "{COUNT}"]}]},
    "awards_survival": {"שם": [{"text": "...", "placeholders": ["{PLAYER}"]}]}
  },
  "rivalries": [{"player1": "...", "player2": "...", "description": "..."}]
}`;

  console.log(`🎙️ TTS Pool: generating for ${numPlayers} players (${playerNamesList})...`);

  try {
    const result = await callWithFallback({
      prompt,
      apiKey,
      temperature: 0.85,
      topP: 0.95,
      maxOutputTokens: 16384,
      responseMimeType: 'application/json',
      label: 'TTS Pool',
    });

    let jsonText = result.text;
    if (jsonText.includes('```json')) {
      jsonText = jsonText.split('```json')[1].split('```')[0];
    } else if (jsonText.includes('```')) {
      jsonText = jsonText.split('```')[1].split('```')[0];
    }

    const parsed = JSON.parse(jsonText.trim());
    const pool = buildPoolFromParsed(parsed, gameId, players, rivalryPairs);
    const totalMessages = countPoolMessages(pool);
    console.log(`   ✅ TTS Pool generated via ${result.model}: ${totalMessages} messages`);
    return pool;
  } catch (err) {
    console.error('❌ TTS Pool: all models failed', err);
    return null;
  }
};

// Hebrew number words 1..10, both feminine and masculine forms.
// Used to detect literal counts written next to "קני..." (קניות / קנייה).
const HEBREW_LIVE_COUNT_WORDS = [
  '\u05D0\u05D7\u05EA',                     // אחת
  '\u05E9\u05EA\u05D9',                     // שתי
  '\u05E9\u05EA\u05D9\u05D9\u05DD',         // שתיים
  '\u05E9\u05DC\u05D5\u05E9',               // שלוש
  '\u05E9\u05DC\u05D5\u05E9\u05D4',         // שלושה
  '\u05D0\u05E8\u05D1\u05E2',               // ארבע
  '\u05D0\u05E8\u05D1\u05E2\u05D4',         // ארבעה
  '\u05D7\u05DE\u05E9',                     // חמש
  '\u05D7\u05DE\u05D9\u05E9\u05D4',         // חמישה
  '\u05E9\u05E9',                           // שש
  '\u05E9\u05D9\u05E9\u05D4',               // שישה
  '\u05E9\u05D1\u05E2',                     // שבע
  '\u05E9\u05D1\u05E2\u05D4',               // שבעה
  '\u05E9\u05DE\u05D5\u05E0\u05D4',         // שמונה
  '\u05EA\u05E9\u05E2',                     // תשע
  '\u05EA\u05E9\u05E2\u05D4',               // תשעה
  '\u05E2\u05E9\u05E8',                     // עשר
  '\u05E2\u05E9\u05E8\u05D4',               // עשרה
];

// Matches "<hebrew number> קני..." anywhere in the text.
// The leading boundary is start-of-string OR a non-Hebrew char (whitespace, comma, period, etc.)
// to avoid partial-word matches like "מאוחר" matching "אחת".
const NUMBER_NEAR_KNI_RE = new RegExp(
  `(?:^|[^\\u0590-\\u05FF])(?:${HEBREW_LIVE_COUNT_WORDS.join('|')})\\s+\\u05E7\\u05E0\\u05D9`,
  'u',
);

// If any of these qualifiers appear in the text, the number near "קני..." is
// understood as a historical/average/record reference rather than the live count
// (e.g. "ממוצע של שלוש קניות למשחק", "השיא שלו חמש קניות"). These sentences are valid
// and must NOT be rejected.
const HEBREW_HISTORY_QUALIFIERS = [
  '\u05DE\u05DE\u05D5\u05E6\u05E2',                                 // ממוצע
  '\u05E9\u05D9\u05D0',                                             // שיא
  '\u05D1\u05E2\u05D1\u05E8',                                       // בעבר
  '\u05E4\u05E2\u05DD',                                             // פעם
  '\u05D4\u05D9\u05E1\u05D8\u05D5\u05E8',                           // היסטור (prefix)
  '\u05D1\u05D3\u05E8\u05DA \u05DB\u05DC\u05DC',                     // בדרך כלל
  '\u05EA\u05DE\u05D9\u05D3',                                       // תמיד
  '\u05DC\u05DE\u05E9\u05D7\u05E7',                                 // למשחק (avg-per-game)
  '\u05D4\u05E7\u05D5\u05D3\u05DD',                                 // הקודם (last game)
  '\u05D0\u05E3 \u05E4\u05E2\u05DD',                                // אף פעם
];

// True if the sentence has a hardcoded live count: a Hebrew number word
// adjacent to "קני..." with NO {COUNT} placeholder and NO history qualifier
// to justify the literal number.
function hasLiteralLiveCount(text: string): boolean {
  if (text.includes('{COUNT}')) return false;
  if (!NUMBER_NEAR_KNI_RE.test(text)) return false;
  if (HEBREW_HISTORY_QUALIFIERS.some(q => text.includes(q))) return false;
  return true;
}

function detectPlaceholdersFromText(text: string): TTSPlaceholder[] {
  const out: TTSPlaceholder[] = [];
  if (text.includes('{PLAYER}')) out.push('{PLAYER}');
  if (text.includes('{COUNT}')) out.push('{COUNT}');
  if (text.includes('{POT}')) out.push('{POT}');
  if (text.includes('{RECORD}')) out.push('{RECORD}');
  if (text.includes('{RIVAL}')) out.push('{RIVAL}');
  if (text.includes('{RANK}')) out.push('{RANK}');
  return out;
}

interface TtsValidateOpts {
  requireCount?: boolean;
  categoryLabel?: string;
}

function ensureMessageArray(raw: unknown, opts: TtsValidateOpts = {}): TTSMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: TTSMessage[] = [];
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const text = (m as TTSMessage).text;
    if (typeof text !== 'string' || text.length === 0) continue;
    if (hasLiteralLiveCount(text)) {
      console.warn(`TTS reject [${opts.categoryLabel || 'msg'}] hardcoded live count, missing {COUNT}: "${text}"`);
      continue;
    }
    if (opts.requireCount && !text.includes('{COUNT}')) {
      console.warn(`TTS reject [${opts.categoryLabel || 'msg'}] missing required {COUNT}: "${text}"`);
      continue;
    }
    out.push({ text, placeholders: detectPlaceholdersFromText(text) });
  }
  return out;
}

function ensureMessageRecord(raw: unknown, opts: TtsValidateOpts = {}): Record<string, TTSMessage[]> {
  if (!raw || typeof raw !== 'object') return {};
  const result: Record<string, TTSMessage[]> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    const childLabel = opts.categoryLabel ? `${opts.categoryLabel}.${key}` : key;
    const msgs = ensureMessageArray(val, { ...opts, categoryLabel: childLabel });
    if (msgs.length > 0) result[key] = msgs;
  }
  return result;
}

function buildPoolFromParsed(
  parsed: Record<string, unknown>,
  gameId: string,
  players: TTSPlayerInput[],
  rivalryPairs: { p1: string; p2: string; desc: string }[],
): LiveGameTTSPool {
  const rawPlayers = (parsed.players || {}) as Record<string, Record<string, unknown>>;
  const rawShared = (parsed.shared || {}) as Record<string, unknown>;

  const COUNT_REQUIRED_ANTICIPATED = new Set<TTSAnticipatedCategory>([
    'above_avg',
    'record_tied',
    'record_broken',
    'tied_for_lead',
  ]);

  const poolPlayers: Record<string, TTSPlayerMessages> = {};
  for (const p of players) {
    const raw = rawPlayers[p.name] || {};
    const generic = ensureMessageArray(raw.generic, { categoryLabel: `players.${p.name}.generic` });
    const anticipated = raw.anticipated as Record<string, unknown> | undefined;

    const playerEntry: TTSPlayerMessages = {
      generic: generic.length > 0 ? generic : [{ text: `${p.name} קנה עוד אחד, הערב ממשיך`, placeholders: [] }],
    };

    if (anticipated && typeof anticipated === 'object') {
      const antMap: TTSPlayerMessages['anticipated'] = {};
      const categories: TTSAnticipatedCategory[] = ['above_avg', 'record_tied', 'record_broken', 'is_leader', 'rival_matched', 'tied_for_lead'];
      for (const cat of categories) {
        const msgs = ensureMessageArray(anticipated[cat], {
          requireCount: COUNT_REQUIRED_ANTICIPATED.has(cat),
          categoryLabel: `players.${p.name}.anticipated.${cat}`,
        });
        if (msgs.length > 0) antMap[cat] = msgs;
      }
      if (Object.keys(antMap).length > 0) playerEntry.anticipated = antMap;
    }

    poolPlayers[p.name] = playerEntry;
  }

  const rivalries: TTSRivalry[] = [];
  const rawRivalries = parsed.rivalries;
  if (Array.isArray(rawRivalries)) {
    for (const r of rawRivalries) {
      if (r && typeof r === 'object' && typeof r.player1 === 'string' && typeof r.player2 === 'string') {
        rivalries.push({ player1: r.player1, player2: r.player2, description: r.description || '' });
      }
    }
  }
  for (const rp of rivalryPairs) {
    if (!rivalries.some(r => (r.player1 === rp.p1 && r.player2 === rp.p2) || (r.player1 === rp.p2 && r.player2 === rp.p1))) {
      rivalries.push({ player1: rp.p1, player2: rp.p2, description: rp.desc });
    }
  }

  return {
    gameId,
    generatedAt: new Date().toISOString(),
    players: poolPlayers,
    shared: {
      first_blood: ensureMessageRecord(rawShared.first_blood, { categoryLabel: 'shared.first_blood' }),
      bad_beat: ensureMessageRecord(rawShared.bad_beat, { categoryLabel: 'shared.bad_beat' }),
      bad_beat_generic: ensureMessageArray(rawShared.bad_beat_generic, { categoryLabel: 'shared.bad_beat_generic' }),
      big_hand: ensureMessageRecord(rawShared.big_hand, { categoryLabel: 'shared.big_hand' }),
      big_hand_generic: ensureMessageArray(rawShared.big_hand_generic, { categoryLabel: 'shared.big_hand_generic' }),
      break_time: ensureMessageArray(rawShared.break_time, { categoryLabel: 'shared.break_time' }),
      auto_announce: ensureMessageArray(rawShared.auto_announce, { categoryLabel: 'shared.auto_announce' }),
      awards_generosity: ensureMessageRecord(rawShared.awards_generosity, { requireCount: true, categoryLabel: 'shared.awards_generosity' }),
      awards_survival: ensureMessageRecord(rawShared.awards_survival, { categoryLabel: 'shared.awards_survival' }),
    },
    rivalries,
    usedIndices: {},
    spokenTexts: [],
  };
}

function countPoolMessages(pool: LiveGameTTSPool): number {
  let count = 0;
  for (const pm of Object.values(pool.players)) {
    count += pm.generic.length;
    if (pm.anticipated) {
      for (const msgs of Object.values(pm.anticipated)) {
        if (msgs) count += msgs.length;
      }
    }
  }
  const s = pool.shared;
  count += s.bad_beat_generic.length + s.big_hand_generic.length;
  count += s.break_time.length + s.auto_announce.length;
  for (const msgs of Object.values(s.first_blood)) count += msgs.length;
  for (const msgs of Object.values(s.bad_beat)) count += msgs.length;
  for (const msgs of Object.values(s.big_hand)) count += msgs.length;
  for (const msgs of Object.values(s.awards_generosity)) count += msgs.length;
  for (const msgs of Object.values(s.awards_survival)) count += msgs.length;
  return count;
}

// ─── Photo chip counting ──────────────────────────────────────────────
//
// Multimodal Gemini Vision call that takes a photo of a player's
// color-sorted chip stacks and returns a per-color count + per-stack
// confidence score. The caller (PhotoCaptureModal) populates the
// existing chip-count inputs in ChipEntryScreen with these numbers,
// surfaces the confidence as colored borders, and ALWAYS lets the user
// override manually — the AI never finalizes anything on its own.
//
// Why a holistic prompt (no patches): per the project rule, every
// constraint lives in ONE prompt block. If accuracy needs tuning we
// rewrite the entire prompt, never tack on "and also do X" clauses.
//
// Why fixed color order: the user's poker group always lays stacks
// out in the same left-to-right order. We tell the AI that order up
// front, so it doesn't need to identify colors at all — only count
// edge rings at known positions. This eliminates color-confusion
// (yellow vs white in dim light is the classic failure) as an error
// class entirely.
//
// Failure mode: the function NEVER throws; it always returns a
// PhotoChipCountResult, with `error` populated when something went
// wrong. The caller surfaces a toast and leaves the manual flow
// untouched. This matches the "manual flow MUST keep working" hard
// guarantee in the plan.

export interface CountChipsFromPhotoInput {
  imageBase64: string;       // raw base64, no data: prefix (from imageUtils.downscaleImage)
  mimeType: string;          // 'image/jpeg' typically
  chipValues: ChipValue[];   // the group's chip set
  /** Optional: total chip-VALUE the player is expected to hold (e.g.
   *  (1+rebuys)*rebuyValue). When provided, the post-LLM total-value
   *  sanity check kicks in — if the AI total is off by exactly one
   *  chip denomination, the lowest-confidence stack gets a ±1 nudge. */
  expectedTotalValue?: number;
  /** Telemetry hint (`chip_count_debug.context`) so we can later filter
   *  rows by whether they came from the live-game flow (no
   *  expectedTotalValue but inside ChipEntryScreen) versus the
   *  settings test card (no game context). Defaults to 'unknown' if
   *  the caller omits it. */
  debugContext?: ChipCountDebugContext;
  abortSignal?: AbortSignal;
  /** Optional progress callback. The rebuilt per-stack pipeline
   *  (v5.59+) fires the new pipeline phases — `detecting-stacks` →
   *  `calibrating` → `counting-stacks` (one per detected stack) →
   *  `reconciling-totals` (only when expectedTotalValue is set) — so
   *  the modal can show meaningful progress instead of a generic
   *  spinner. The legacy `attempting` / `success` / `failed` phases
   *  are kept so the existing PhotoCaptureModal handler still works
   *  during the transition; new code should prefer the new phases. */
  onProgress?: (info: {
    phase:
      | 'detecting-stacks'
      | 'calibrating'
      | 'counting-stacks'
      | 'reconciling-totals'
      | 'attempting'
      | 'success'
      | 'failed';
    model: string;
    modelDisplay: string;
    attempt: number;
    totalModels: number;
    /** When phase = 'counting-stacks', 1-indexed position of the
     *  stack being counted ("counting stack 3 of 5"). */
    stackIndex?: number;
    /** When phase = 'counting-stacks', total number of stacks the
     *  pipeline will count. */
    stackTotal?: number;
  }) => void;
}

// Cascading fallback for the photo chip-counting flow. All entries
// must (a) be on the FREE Gemini tier (per project policy) and (b)
// support multimodal input + responseSchema-constrained JSON output.
//
// REWRITTEN v5.59 — Pro removed entirely after empirical failure.
//
// History:
//   v5.48 added gemini-2.5-pro as the leader on the theory that "Pro is
//   much better at counting visible objects than Flash" and that the
//   advertised free-tier limits (5 RPM / 25 RPD) would suffice for the
//   typical ≤5 photos per game night. That theory did not survive
//   contact with reality: across 100% of `chip_count_feedback` rows
//   (every group, every photo, every group's API key), gemini-2.5-pro
//   has NEVER once been the winning model — every successful count came
//   from the gemini-3-flash-preview fallback. The likely cause is that
//   Google has progressively restricted free-tier access to the Pro
//   models over the past months, so a free-tier API key now mostly gets
//   429/INVALID errors on Pro. Net effect of keeping Pro in the chain:
//   ~3 wasted API calls per photo (3 shots × Pro = always all-fail),
//   plus the burned quota cascades into the lighter models below it
//   and can push them into rate-limit / parseFailed territory. So Pro
//   is now removed entirely.
//
// Order rationale (post-v6.4.1):
//   1. gemini-3-flash-preview    — empirically the ONLY model the
//      cascade has ever succeeded on for this app. Multimodal-capable,
//      respects responseSchema, low free-tier friction, gives honest
//      per-stack counts. We hit it TWICE before failing — 503/504
//      from this model are transient (Google-side overload), not
//      permanent, and the second attempt typically succeeds in 3-5s
//      (see CHIP_COUNT_PRIMARY_RETRY logic below).
//
// What got REMOVED in v6.4.1: `gemini-2.5-flash` as a fallback.
// Telemetry from `chip_count_corrections` showed that when 2.5-flash
// took over (because 3-preview 504'd), it returned `10` for every
// non-zero color — every single time, regardless of the actual photo.
// It wasn't counting; it was pattern-matching the canonical "stack
// of 10" we mention in the prompt. 4 of Lior's 6 test photos on
// 2026-05-16 fell back to 2.5-flash and got fake "10-everywhere"
// answers. Better to show a clean "model busy, try again" error than
// to lie with garbage. If the primary is genuinely down for an
// extended period, the user can retake; if it's a momentary spike,
// the in-function retry handles it transparently.
const CHIP_COUNT_MODELS: ReadonlyArray<{ version: string; model: string }> = [
  { version: 'v1beta', model: 'gemini-3-flash-preview' },
];

// v6.4.1 — retry the primary once on transient failures (503 high
// demand / 504 timeout / network / parseFailed). These all indicate
// the request didn't actually get answered cleanly by Gemini, not
// that the model "decided" something wrong about the photo. A second
// shot after a brief backoff is dramatically cheaper than asking the
// user to retake. Cap at 1 retry so worst-case latency is bounded at
// ~50s (two 25s timeouts) rather than 75s+.
const CHIP_COUNT_PRIMARY_RETRY = 1;
const CHIP_COUNT_PRIMARY_RETRY_DELAY_MS = 800;

// v5.62 — `DEFAULT_CHIP_COUNT_STRATEGY` removed alongside the per-stack
// pipeline it served. The whole-photo prompt is hand-crafted inline in
// `runWholePhotoShot` and doesn't use a swappable strategy block. If
// future feedback shows a systematic bias we can re-introduce a tuning
// surface for the new prompt structure.

function applyTotalValueSanityCheck(
  stacks: PhotoChipCountStack[],
  chipById: Map<string, ChipValue>,
  expectedTotalValue: number,
): {
  expected: number;
  computed: number;
  adjustedStackId: string | null;
  adjustmentChips: number;
} {
  const computed = stacks.reduce((sum, s) => {
    const chip = chipById.get(s.chipId);
    return sum + (chip ? s.count * chip.value : 0);
  }, 0);
  const diff = expectedTotalValue - computed; // positive = AI undercounted

  // Allow exactly one chip denomination mismatch in either direction.
  if (diff === 0) {
    return { expected: expectedTotalValue, computed, adjustedStackId: null, adjustmentChips: 0 };
  }

  // Find a chip whose denomination matches |diff| (handles the case
  // where the AI missed/hallucinated a single chip). If multiple chip
  // denominations equal |diff| (rare), prefer the one whose stack is
  // the lowest-confidence — easiest to justify nudging.
  const adjChips = diff > 0 ? 1 : -1;
  const targetDenom = Math.abs(diff);

  // Candidate stacks: those whose chip denomination == targetDenom.
  // If adjChips == -1 we need a stack with count >= 1 to decrement.
  const candidates = stacks
    .map(s => ({ stack: s, chip: chipById.get(s.chipId) }))
    .filter(({ stack, chip }) => {
      if (!chip || chip.value !== targetDenom) return false;
      if (adjChips === -1 && stack.count < 1) return false;
      return true;
    })
    .sort((a, b) => a.stack.confidence - b.stack.confidence); // lowest confidence first

  if (candidates.length === 0) {
    return { expected: expectedTotalValue, computed, adjustedStackId: null, adjustmentChips: 0 };
  }

  const target = candidates[0].stack;
  const oldCount = target.count;
  target.count = Math.max(0, oldCount + adjChips);
  if (target.provenance) {
    target.provenance.totalValueAdjustedFrom = oldCount;
    target.provenance.finalCount = target.count;
    target.provenance.reasoning =
      (target.provenance.reasoning ? `${target.provenance.reasoning}; ` : '') +
      `total-value sanity check: adjusted ${oldCount} → ${target.count} to satisfy expected total ${expectedTotalValue}`;
  }
  return {
    expected: expectedTotalValue,
    computed,
    adjustedStackId: target.chipId,
    adjustmentChips: adjChips,
  };
}

// v5.62 — `loadActiveChipCountStrategy` removed alongside the per-stack
// pipeline it served. The whole-photo prompt is a single inline template
// in `runWholePhotoShot`. If we re-introduce a tuner for the new prompt
// later, we'll fetch the override here. Tuner table and feedback schema
// stay in place (still useful for accuracy tracking even without runtime
// override).

/** Run ONE whole-photo LLM call. Sends every chip selfie as a few-shot
 *  reference image alongside the target photo, asks Gemini to count
 *  chips per color in the target photo, parses a structured per-color
 *  response.
 *
 *  v5.62 — replaces the v5.59 per-stack pipeline (client-side stack
 *  detection + cropping + N per-stack LLM calls + 3 geometric methods
 *  + voting). That pipeline had a fatal failure mode in real-world
 *  photos: when the client-side white-stripe stack detector missed
 *  stacks, the downstream LLM was never called for them, so entire
 *  colors silently returned "0 chips" with no warning to the user.
 *  Lior caught this on May 15 ("after all your checks and improvements
 *  the results are ridiculous") — the test card found 1 of 6 stacks,
 *  the real-game flow found 0 of 5.
 *
 *  Whole-photo is structurally robust to "missed stack": the LLM SEES
 *  every stack in the photo at once, can't miss them via heuristic
 *  failure. Trade-off: slightly higher per-stack count variance
 *  (±1-2 chips on a 10-chip stack) versus the much worse "missing
 *  entire stacks" failure mode of the per-stack pipeline. Per Lior:
 *  "before there was some count error per stack, now its meaningless
 *  it doesn't find anything" — off-by-1 is acceptable, missing stacks
 *  is not.
 *
 *  Key improvement over v5.41's whole-photo predecessor: the user's
 *  chip selfies (added in v5.59) are sent as labelled few-shot reference
 *  images. The LLM sees "this is what the user calls a Red chip" right
 *  before being asked to count, which empirically gives 10-25pp accuracy
 *  on counting tasks per published research. */
async function runWholePhotoShot(args: {
  version: string;
  model: string;
  apiKey: string;
  imageBase64: string;
  imageMimeType: string;
  chips: ChipValue[];
  abortSignal?: AbortSignal;
  /** Telemetry context — passed straight to `chip_count_debug.context`. */
  debugContext: ChipCountDebugContext;
  /** Which attempt this is in the fallback chain (1-based). */
  attemptIndex: number;
  /** Total models in the chain — needed for the telemetry row. */
  totalModels: number;
}): Promise<{
  countsByColor: Map<string, SalvageEntry> | null;
  errorMsg: string;
  errorCode: PhotoChipCountErrorCode;
}> {
  const {
    version,
    model,
    apiKey,
    imageBase64,
    imageMimeType,
    chips,
    abortSignal,
    debugContext,
    attemptIndex,
    totalModels,
  } = args;

  const shotStart = Date.now();
  const chipColorsConfigured = chips.map(c => c.color);
  const chipsWithSelfiesCount = chips.filter(c => c.selfieBase64).length;
  const imageByteCount = imageBase64.length;

  const parts: Array<Record<string, unknown>> = [];

  const chipsWithSelfies = chips.filter(c => c.selfieBase64);
  const colorsList = chips.map(c => `"${c.color}"`).join(', ');

  if (chipsWithSelfies.length > 0) {
    parts.push({
      text: `You will see ${chipsWithSelfies.length} REFERENCE images (one per chip color the user has) followed by ONE TARGET photo. The reference images show what each chip color looks like for this user.\n\nReference images:`,
    });
    for (const chip of chipsWithSelfies) {
      parts.push({ text: `\n${chip.color} chip:` });
      parts.push({ inline_data: { mime_type: 'image/jpeg', data: chip.selfieBase64! } });
    }
    parts.push({ text: `\n\nTARGET photo (count chips of each color in this image):` });
  } else {
    parts.push({
      text: `You will see ONE photo of poker chips arranged in stacks by color. The user has these chip colors: ${colorsList}.`,
    });
  }

  parts.push({ inline_data: { mime_type: imageMimeType, data: imageBase64 } });

  // v5.62.3 — prompt simplified. The prior version used `<integer>` as a
  // literal placeholder inside the schema example, which some free-tier
  // Gemini variants treated as a string and echoed back unchanged. The
  // new version describes the schema with a worked example (real digits),
  // matches the responseSchema field types, and leaves no syntactic
  // ambiguity.
  // v6.4.1 — schema example uses VARIED counts (incl. a tall stack
  // and a missing color) instead of the prior 5/3/0/0/0/0 sequence.
  // The old example implicitly biased the model toward small numbers
  // by showing only small-or-zero values; tall stacks (15+) routinely
  // got capped at 10 in the wild. Now the example explicitly carries
  // a 14 and a 17 so the model sees "this schema CAN hold large
  // counts" before producing its own answer.
  const samplePattern: Array<{ n: number; conf: number }> = [
    { n: 7, conf: 92 },
    { n: 14, conf: 75 },
    { n: 0, conf: 100 },
    { n: 17, conf: 65 },
    { n: 3, conf: 95 },
    { n: 0, conf: 100 },
  ];
  const exampleCounts = chips.map((c, i) => {
    const { n, conf } = samplePattern[i % samplePattern.length];
    return `    { "color": ${JSON.stringify(c.color)}, "count": ${n}, "confidence": ${conf} }`;
  }).join(',\n');

  parts.push({
    text: `

Count how many chips of EACH color appear in the TARGET photo.

Counting strategy:
- The photo shows chips arranged in stacks, typically one stack per color, taken at an angled side view.
- For each color the user has (${colorsList}), find the stack of that color and count the chips in it.
- Count from BOTTOM to TOP, one chip at a time. Each visible edge ring = one chip.
- The TOPMOST chip's edge ring is partially hidden by its own top face — its face IS a chip, COUNT IT.
- The BOTTOMMOST chip's ring may merge into the surface shadow — if you can see its top rim, COUNT IT.
- When between two possible counts ("9 or 10 rings"), prefer the HIGHER count. Vision models systematically undercount; erring high cancels the bias.
- If a color does not appear in the target photo, return 0 for that color — DO NOT omit it from the output.
- Do NOT invent chips that aren't there.
- You MUST include an entry for EVERY color listed above, even if the count is 0.

Hard rules to prevent common failure modes:
- Stacks are NOT always 5 or 10 high. Real-world counts range from 1 to 25+. A stack visibly taller than your hand-width worth of chips is probably 12, 15, 17, or more — count the edges, don't round to 10.
- Do NOT use 10 as a "safe default" when you are unsure. If you cannot count a stack precisely, give your best honest estimate of the actual count (which might be 6, or 14, or 22). Returning 10 for a stack you didn't really count is treated as a hallucination and is worse than a slightly-off real count.
- Each stack must be counted INDEPENDENTLY. Do not let one stack's count influence another's. Two stacks that visibly differ in height MUST get different counts.
- Tall stacks (visibly 12+ chips) are the most common source of undercount errors. When you see one, slow down and count edges in groups of 5 from the bottom — do not cap your answer at 10.

Confidence per color (integer 0–100, REQUIRED for every entry):
- This is YOUR self-assessed certainty for THAT specific count. Be honest — do NOT default everything to 80.
- Use HIGH confidence (90–100) when you can see every chip edge cleanly AND you are sure of the count. Also use HIGH (95–100) when a color is clearly ABSENT from the photo (a verified zero).
- Use MEDIUM (60–80) when the count is plausible but you had to estimate one or two edges (occlusion, glare, motion blur).
- Use LOW (20–55) when the stack is partially hidden, very blurry, or you guessed because you could not count individual edges.
- Different colors MUST get different confidences in the same photo unless every stack is genuinely equally clear — a constant value across all colors is treated as a hallucination signal.

Output format — return ONLY a raw JSON object, no markdown fences, no prose before or after:
{
  "counts": [
${exampleCounts}
  ]
}

Replace the example numbers above with your real counts AND your real confidences. The "color" values MUST match the user's exact color names: ${colorsList}. Case differences are tolerated. Output ONLY the JSON object — nothing else.`,
  });

  const payload = {
    contents: [{ parts }],
    generationConfig: {
      temperature: 0.0,
      // v5.62.5 — bumped from 512 to 2048. Two reasons:
      //   1. Defense in depth: even if thinking somehow stays partially
      //      enabled (different model, future regression, schema
      //      mismatch), the actual JSON output still has room.
      //   2. With selfies + 6 colors the JSON body is ~250 chars
      //      (~80 tokens). 2048 is overkill for output but cheap.
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          counts: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                color: { type: 'STRING' },
                count: { type: 'INTEGER' },
                // v6.3.1 — per-color self-assessed confidence 0–100.
                // Optional in the schema (only "color" + "count" are
                // required) so a model that ignores it still parses,
                // but the prompt strongly encourages providing it
                // and we fall back to a neutral default if missing.
                confidence: { type: 'INTEGER' },
              },
              required: ['color', 'count'],
            },
          },
        },
        required: ['counts'],
      },
      // v5.62.5 — disable thinking. Without this, Gemini 2.5 Flash
      // consumes hundreds of tokens on internal reasoning BEFORE
      // emitting JSON; those tokens count against `maxOutputTokens`,
      // so the JSON gets cut off mid-string. Lior's v5.62.3 raw
      // response was literally `{"counts": [{"color": "White", "` —
      // a textbook truncation. Per Google's docs (Firebase AI Logic
      // > Thinking), `thinkingBudget: 0` disables thinking on both
      // Gemini 2.5 and Gemini 3 (the latter prefers `thinkingLevel`
      // but supports `thinkingBudget` for backwards-compat — the
      // important bit is "do not set BOTH or the request errors").
      // Counting chips in a single photo doesn't benefit from chain-
      // of-thought; the model needs to look + answer, not deliberate.
      thinkingConfig: {
        thinkingBudget: 0,
      },
    },
  };

  // Shared telemetry shim — every return path through this function
  // calls this exactly once. Fire-and-forget; never blocks.
  const logAttempt = (
    outcome: ChipCountDebugOutcome,
    fields: {
      errorMessage?: string;
      rawResponse?: string;
      finalCounts?: Record<string, number>;
      salvageStrategy?: number;
      httpStatus?: number;
    } = {},
  ): void => {
    void logChipCountAttempt({
      model,
      attemptIndex,
      totalModels,
      context: debugContext,
      outcome,
      errorMessage: fields.errorMessage,
      rawResponse: fields.rawResponse,
      finalCounts: fields.finalCounts,
      salvageStrategy: fields.salvageStrategy,
      httpStatus: fields.httpStatus,
      imageByteCount,
      chipColorsConfigured,
      selfiesAttached: chipsWithSelfiesCount,
      durationMs: Date.now() - shotStart,
    });
  };

  let response: Response;
  try {
    response = await proxyGeminiGenerateWithSignal(version, model, apiKey, payload, abortSignal);
  } catch (err) {
    if (abortSignal?.aborted) {
      logAttempt('cancelled');
      return { countsByColor: null, errorMsg: 'Cancelled', errorCode: 'cancelled' };
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[runWholePhotoShot] ${model} network error:`, msg);
    logAttempt('network', { errorMessage: msg });
    return { countsByColor: null, errorMsg: msg, errorCode: 'network' };
  }

  if (abortSignal?.aborted) {
    logAttempt('cancelled', { httpStatus: response.status });
    return { countsByColor: null, errorMsg: 'Cancelled', errorCode: 'cancelled' };
  }

  if (!response.ok) {
    let errorMsg = `HTTP ${response.status}`;
    let bodyText = '';
    try {
      bodyText = await response.text();
      const body = JSON.parse(bodyText) as { error?: { message?: string } };
      if (body?.error?.message) errorMsg = body.error.message;
    } catch { /* keep status; bodyText may still be populated */ }
    console.warn(`[runWholePhotoShot] ${model} HTTP error:`, errorMsg);
    // v6.4.1 — flag 429s specifically so the retry loop doesn't burn
    // a second attempt against a quota wall it can't move. 429 from
    // Gemini = `RESOURCE_EXHAUSTED` / "exceeded your current quota"
    // — the second attempt will fail identically. Save the user
    // ~1.5s of pointless wait and surface the quota message instead
    // of a generic "model busy".
    const isQuota = response.status === 429
      || /quota|RESOURCE_EXHAUSTED|rate.?limit/i.test(errorMsg);
    const errorCode: PhotoChipCountErrorCode = isQuota ? 'quotaExceeded' : 'httpError';
    logAttempt(isQuota ? 'quotaExceeded' : 'httpError', {
      errorMessage: errorMsg,
      rawResponse: bodyText,
      httpStatus: response.status,
    });
    return { countsByColor: null, errorMsg, errorCode };
  }

  let raw = '';
  try {
    const data = await response.json();
    raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[runWholePhotoShot] ${model} response.json() failed:`, msg);
    logAttempt('parseFailed', {
      errorMessage: `response.json() failed: ${msg}`,
      httpStatus: response.status,
    });
    return {
      countsByColor: null,
      errorMsg: `Bad response from AI proxy: ${msg}`,
      errorCode: 'parseFailed',
    };
  }

  // Expose raw response for live debugging — `window.__lastChipRaw` is
  // readable from any DevTools console / mobile remote inspector. Cheap
  // and removes the "what did the AI actually return?" question when
  // diagnosing parse failures in production.
  try {
    (window as unknown as { __lastChipRaw?: { model: string; raw: string; at: string } }).__lastChipRaw = {
      model, raw, at: new Date().toISOString(),
    };
  } catch { /* SSR / restricted contexts */ }

  const validColors = chips.map(c => c.color.trim().toLowerCase());
  const salvage = extractChipCounts(raw, validColors);

  if (salvage && salvage.counts.size > 0) {
    // Telemetry `final_counts` stays `Record<string, number>` (the
    // existing chip_count_debug schema). Flatten SalvageEntry → count
    // for that log row; full confidence info stays in-memory for the
    // result builder downstream.
    const finalCountsFlat: Record<string, number> = {};
    for (const [color, entry] of salvage.counts) {
      finalCountsFlat[color] = entry.count;
    }
    logAttempt('success', {
      rawResponse: raw,
      finalCounts: finalCountsFlat,
      salvageStrategy: salvage.strategy,
      httpStatus: response.status,
    });
    return { countsByColor: salvage.counts, errorMsg: '', errorCode: 'httpError' };
  }

  // All recovery strategies failed. Surface the first 250 chars of the
  // raw response in the error message so the user can screenshot and
  // share what Gemini actually returned. This is the single most
  // important piece of debugging info we can hand them — without it
  // every "parse failed" is unactionable.
  const excerpt = raw.length === 0
    ? '(empty response)'
    : raw.length > 250
      ? raw.slice(0, 250) + '…'
      : raw;
  console.warn(`[runWholePhotoShot] ${model} no salvageable counts. raw:`, raw.slice(0, 1000));
  logAttempt('parseFailed', {
    errorMessage: 'No salvageable counts in response',
    rawResponse: raw,
    httpStatus: response.status,
  });
  return {
    countsByColor: null,
    errorMsg: `[${model}] ${excerpt}`,
    errorCode: 'parseFailed',
  };
}

/** Multi-strategy salvager for Gemini's chip-count response.
 *
 *  Returns the largest map of color→count we can recover plus the index
 *  of the strategy that won (1..5), or null if literally nothing usable
 *  is in the text. Designed so the photo flow succeeds even when Gemini
 *  ignores `responseSchema` and emits prose, markdown-fenced JSON,
 *  broken JSON, or plain-text lists.
 *
 *  Strategies run in order of strictness:
 *    1. JSON.parse on the raw text
 *    2. JSON.parse on text stripped of ```...``` fences
 *    3. JSON.parse on the first balanced {...} block
 *    4. Regex scan for `"color": "X", "count": N` pairs (handles
 *       truncated/malformed JSON where step 1-3 throw)
 *    5. Plain-text scan for `colorName: N` / `colorName = N` /
 *       `colorName - N` / `- colorName N` lines, restricted to the
 *       valid color list (so we don't pick up unrelated digits).
 *
 *  The first strategy that yields at least ONE recognized color wins.
 *  The strategy index is returned so we can log it to the telemetry
 *  table — across hundreds of attempts we'll see which strategies are
 *  actually doing the work and trim/tighten the rest. */
/** One per-color entry from the salvager. `confidence` is the model's
 *  self-assessed 0–100 certainty for THIS count (v6.3.1+). `null` when
 *  the salvager can't recover it (e.g. plain-text strategy 5, or models
 *  that ignored the field). Consumers must fall back to a neutral
 *  default rather than treating null as 0. */
export interface SalvageEntry {
  count: number;
  confidence: number | null;
}

export interface SalvageResult {
  counts: Map<string, SalvageEntry>;
  strategy: number;
}

/** Clamp + round + sanity-check a candidate confidence value. Returns
 *  `null` for anything non-numeric or out of range so callers know to
 *  fall back. */
function normalizeConfidence(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < 0 || rounded > 100) return null;
  return rounded;
}

export function extractChipCounts(raw: string, validColors: string[]): SalvageResult | null {
  if (!raw || raw.trim().length === 0) return null;

  const validSet = new Set(validColors);

  const tryParseObject = (text: string): Map<string, SalvageEntry> | null => {
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      return null;
    }
    if (!obj || typeof obj !== 'object') return null;
    const counts = (obj as { counts?: unknown }).counts;
    if (!Array.isArray(counts)) return null;
    const m = new Map<string, SalvageEntry>();
    for (const item of counts) {
      if (!item || typeof item !== 'object') continue;
      const colorRaw = (item as { color?: unknown }).color;
      const countRaw = (item as { count?: unknown }).count;
      const confRaw = (item as { confidence?: unknown }).confidence;
      if (typeof colorRaw !== 'string') continue;
      const color = colorRaw.trim().toLowerCase();
      const n = Number(countRaw);
      if (!Number.isFinite(n) || n < 0) continue;
      m.set(color, {
        count: Math.floor(n),
        confidence: normalizeConfidence(confRaw),
      });
    }
    return m.size > 0 ? m : null;
  };

  // Strategy 1: raw
  let result = tryParseObject(raw);
  if (result) return { counts: result, strategy: 1 };

  // Strategy 2: strip markdown fences (```json … ``` or ``` … ```)
  if (raw.includes('```')) {
    const fenceMatch = raw.match(/```(?:json|JSON)?\s*([\s\S]*?)\s*```/);
    if (fenceMatch && fenceMatch[1]) {
      result = tryParseObject(fenceMatch[1].trim());
      if (result) return { counts: result, strategy: 2 };
    }
  }

  // Strategy 3: first balanced {...} block
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    result = tryParseObject(raw.slice(firstBrace, lastBrace + 1));
    if (result) return { counts: result, strategy: 3 };
  }

  // Strategy 4: regex-extract "color": "X", "count": N pairs even from
  // broken/truncated JSON. Order of color/count keys doesn't matter —
  // we run a single forward sweep so each pair is matched once. We
  // intentionally do NOT try to also salvage `confidence` here: the
  // truncated/garbled responses this strategy targets are exactly the
  // ones where a confidence value would be meaningless. Entries from
  // this path get `confidence: null` and fall back to the consumer's
  // default.
  const pairRe = /"color"\s*:\s*"([^"]+)"\s*,?\s*"count"\s*:\s*(-?\d+)/gi;
  const salvaged = new Map<string, SalvageEntry>();
  let pm: RegExpExecArray | null;
  while ((pm = pairRe.exec(raw)) !== null) {
    const color = pm[1].trim().toLowerCase();
    const n = parseInt(pm[2], 10);
    if (color && Number.isFinite(n) && n >= 0) {
      salvaged.set(color, { count: n, confidence: null });
    }
  }
  // Also handle the reverse key order (count before color)
  const pairReReverse = /"count"\s*:\s*(-?\d+)\s*,?\s*"color"\s*:\s*"([^"]+)"/gi;
  while ((pm = pairReReverse.exec(raw)) !== null) {
    const color = pm[2].trim().toLowerCase();
    const n = parseInt(pm[1], 10);
    if (color && Number.isFinite(n) && n >= 0 && !salvaged.has(color)) {
      salvaged.set(color, { count: n, confidence: null });
    }
  }
  if (salvaged.size > 0) return { counts: salvaged, strategy: 4 };

  // Strategy 5: plain-text scan. Lines like "white: 5", "red = 3",
  // "* black - 0", "Blue 7 chips". We only accept matches where the
  // color is in `validColors` so unrelated digits in prose don't
  // pollute the result. Number must immediately follow the color
  // separator (skipping at most a colon/equals/dash and whitespace).
  // No confidence available from this format — consumer defaults.
  const textPairs = new Map<string, SalvageEntry>();
  // First normalize: split on lines, also on commas/semicolons so
  // single-line lists still hit.
  const tokens = raw.split(/[\n,;]+/);
  for (const token of tokens) {
    // Try patterns: "color: N", "color = N", "color - N", "color is N",
    // "color N" (last is greedy — only accept if exactly one number)
    const m = token.match(/(?:^|[^a-zA-Z])([a-zA-Z]+(?:[\s-][a-zA-Z]+)?)\s*(?::|=|-|is|equals)?\s*(\d+)/i);
    if (!m) continue;
    const color = m[1].trim().toLowerCase();
    if (!validSet.has(color)) continue;
    const n = parseInt(m[2], 10);
    if (!Number.isFinite(n) || n < 0) continue;
    if (!textPairs.has(color)) {
      textPairs.set(color, { count: n, confidence: null });
    }
  }
  if (textPairs.size > 0) return { counts: textPairs, strategy: 5 };

  return null;
}

/** Whole-photo call with the chip-count model chain. v6.4.1: chain
 *  is now a single model (gemini-3-flash-preview) tried up to
 *  1+CHIP_COUNT_PRIMARY_RETRY times. Per-model retry is gated on
 *  TRANSIENT failure codes (503/504/network/parseFailed) — we don't
 *  burn quota retrying a permanent 401/403 or a successful response
 *  with bad data. Returns the first attempt that produced a valid
 *  counts map. */
async function runWholePhotoWithFallback(args: {
  imageBase64: string;
  imageMimeType: string;
  chips: ChipValue[];
  apiKey: string;
  abortSignal?: AbortSignal;
  onProgress?: (model: string, attempt: number) => void;
  debugContext: ChipCountDebugContext;
}): Promise<{
  countsByColor: Map<string, SalvageEntry> | null;
  modelUsed: string | null;
  attempts: number;
  errorMsg: string;
  errorCode: PhotoChipCountErrorCode;
}> {
  let lastMsg = '';
  let lastCode: PhotoChipCountErrorCode = 'httpError';
  let attempt = 0;

  // Build the actual attempt sequence: each entry in CHIP_COUNT_MODELS
  // expanded by its retry budget. With the v6.4.1 single-model chain
  // and retry=1 this is [primary, primary-retry] — total 2 attempts.
  const attemptPlan: Array<{ version: string; model: string; isRetry: boolean }> = [];
  for (const m of CHIP_COUNT_MODELS) {
    attemptPlan.push({ ...m, isRetry: false });
    for (let r = 0; r < CHIP_COUNT_PRIMARY_RETRY; r++) {
      attemptPlan.push({ ...m, isRetry: true });
    }
  }
  const totalAttempts = attemptPlan.length;

  for (const { version, model, isRetry } of attemptPlan) {
    attempt++;
    if (args.abortSignal?.aborted) {
      return { countsByColor: null, modelUsed: null, attempts: attempt, errorMsg: 'Cancelled', errorCode: 'cancelled' };
    }

    // Backoff between retries of the same model so we don't pound a
    // momentarily-overloaded endpoint.
    if (isRetry && CHIP_COUNT_PRIMARY_RETRY_DELAY_MS > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, CHIP_COUNT_PRIMARY_RETRY_DELAY_MS);
        args.abortSignal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      if (args.abortSignal?.aborted) {
        return { countsByColor: null, modelUsed: null, attempts: attempt, errorMsg: 'Cancelled', errorCode: 'cancelled' };
      }
    }

    args.onProgress?.(model, attempt);
    const out = await runWholePhotoShot({
      version,
      model,
      apiKey: args.apiKey,
      imageBase64: args.imageBase64,
      imageMimeType: args.imageMimeType,
      chips: args.chips,
      abortSignal: args.abortSignal,
      debugContext: args.debugContext,
      attemptIndex: attempt,
      totalModels: totalAttempts,
    });
    if (out.countsByColor) {
      return { countsByColor: out.countsByColor, modelUsed: model, attempts: attempt, errorMsg: '', errorCode: 'httpError' };
    }
    lastMsg = out.errorMsg;
    lastCode = out.errorCode;

    // Stop retrying on cancellation or quota — neither is fixable
    // by a second attempt. (missingImage / noChipsConfig are caught
    // before this loop runs, so they can't appear here.)
    if (out.errorCode === 'cancelled' || out.errorCode === 'quotaExceeded') {
      break;
    }
  }
  return { countsByColor: null, modelUsed: null, attempts: attempt, errorMsg: lastMsg, errorCode: lastCode };
}

export async function countChipsFromPhoto(
  input: CountChipsFromPhotoInput,
): Promise<PhotoChipCountResult> {
  const { imageBase64, mimeType, chipValues, expectedTotalValue, abortSignal, onProgress } = input;
  // Context auto-detection so we don't need every call site to thread
  // the tag explicitly: the live-game flow (ChipEntryScreen) always
  // passes `expectedTotalValue` (rebuys × chipsPerRebuy); the Settings
  // test card never does. If the caller passes `debugContext`
  // explicitly, respect that — but the default is auto-derived.
  const debugContext: ChipCountDebugContext =
    input.debugContext
    ?? (typeof expectedTotalValue === 'number' && expectedTotalValue > 0 ? 'live-game' : 'settings-test');

  if (!imageBase64) {
    return emptyChipCountResult('Missing image data', 'missingImage');
  }
  if (chipValues.length === 0) {
    return emptyChipCountResult('No chip values configured for this group', 'noChipsConfig');
  }

  const orderedChips: ChipValue[] = [...chipValues].sort((a, b) => a.value - b.value);
  const chipById = new Map(orderedChips.map(c => [c.id, c]));
  const apiKey = getSettings()?.geminiApiKey || '';

  // v5.62 — whole-photo single LLM call. Previously this function dispatched
  // through a per-stack pipeline (detectStackRegions → cropToRegion ×N →
  // runSingleStackShot ×N + geometricChipCount ×N + combineLLMAndGeometry).
  // The stack-detection step was too fragile in real-world photos: when it
  // missed stacks (which it did often — kitchen counters, varied lighting,
  // short stacks), entire chip colors silently returned 0 with no warning.
  // Whole-photo trades "off-by-1 per stack" for "never miss a stack" —
  // empirically the right trade.
  //
  // Progress reporting uses the legacy `attempting` phase (which the modal
  // already handles cleanly as "asking model X…"). The per-stack `counting-
  // stacks` phase with stackIndex/stackTotal is no longer used since there
  // are no per-stack subcalls.
  onProgress?.({
    phase: 'attempting',
    model: CHIP_COUNT_MODELS[0].model,
    modelDisplay: MODEL_DISPLAY_NAMES[CHIP_COUNT_MODELS[0].model] || CHIP_COUNT_MODELS[0].model,
    attempt: 0,
    totalModels: CHIP_COUNT_MODELS.length,
  });
  if (abortSignal?.aborted) return emptyChipCountResult('Cancelled', 'cancelled');

  const result = await runWholePhotoWithFallback({
    imageBase64,
    imageMimeType: mimeType,
    chips: orderedChips,
    apiKey,
    abortSignal,
    debugContext,
    onProgress: (model, attempt) => onProgress?.({
      phase: 'attempting',
      model,
      modelDisplay: MODEL_DISPLAY_NAMES[model] || model,
      attempt: attempt - 1,
      totalModels: CHIP_COUNT_MODELS.length,
    }),
  });

  if (abortSignal?.aborted) return emptyChipCountResult('Cancelled', 'cancelled');
  if (!result.countsByColor) {
    return emptyChipCountResult(result.errorMsg || 'AI count failed', result.errorCode);
  }

  // Build PhotoChipCountStack[] from the per-color count map, preserving
  // the canonical small→high chip order so the UI rows line up.
  //
  // v6.3.1 — per-color confidence comes from the AI itself (new
  // `confidence` field in the response schema). If the model omitted
  // the field (older models, plain-text salvage, regex salvage on
  // truncated JSON) we fall back to 60% — a neutral "we don't know"
  // value that's high enough not to gate the auto-apply flow but low
  // enough to signal uncertainty to the user. The old fixed 80/45
  // heuristic was a placeholder pretending to be a signal; this
  // replaces it with actual model self-assessment when available.
  const FALLBACK_CONFIDENCE = 60;
  const stacks: PhotoChipCountStack[] = orderedChips.map((chip, idx) => {
    const entry = result.countsByColor!.get(chip.color.trim().toLowerCase());
    const count = entry?.count ?? 0;
    const confidence = entry?.confidence ?? FALLBACK_CONFIDENCE;
    return {
      position: idx + 1,
      chipId: chip.id,
      color: chip.color,
      count,
      confidence,
      provenance: {
        llmCount: count,
        geometryBottomChip: null,
        geometryGradientCount: null,
        geometrySharedCal: null,
        finalCount: count,
        finalConfidence: confidence,
        reasoning: entry?.confidence !== null && entry?.confidence !== undefined
          ? `whole-photo LLM count + self-assessed confidence via ${result.modelUsed}`
          : `whole-photo LLM count via ${result.modelUsed} (no AI confidence, fallback ${FALLBACK_CONFIDENCE})`,
      },
    };
  });

  // Total-value sanity check: when expected total is provided (live game
  // flow), adjust the lowest-confidence stack by ±1 chip if the sum is
  // off by exactly one chip denomination.
  let totalValueCheckResult: PhotoChipCountResult['totalValueCheckResult'] = null;
  if (typeof expectedTotalValue === 'number' && expectedTotalValue > 0) {
    onProgress?.({
      phase: 'reconciling-totals',
      model: result.modelUsed || '',
      modelDisplay: result.modelUsed ? (MODEL_DISPLAY_NAMES[result.modelUsed] || result.modelUsed) : '',
      attempt: result.attempts,
      totalModels: CHIP_COUNT_MODELS.length,
    });
    totalValueCheckResult = applyTotalValueSanityCheck(stacks, chipById, expectedTotalValue);
  }

  const totalValue = stacks.reduce((sum, s) => {
    const chip = chipById.get(s.chipId);
    return sum + (chip ? s.count * chip.value : 0);
  }, 0);

  // Overall confidence (v6.3.1): plain unweighted average across all
  // colors. Each color is one independent assessment by the AI, so
  // count-weighting (the old policy) blends two concerns and ends up
  // hiding low-confidence rare colors behind high-confidence common
  // ones. Floor 0 / cap 95 — never silently claim 100% even if the
  // AI does, but allow honest high confidence to shine through (the
  // old 85 cap was a placeholder that suppressed real signal).
  let overallConfidence: number;
  if (stacks.length === 0) {
    overallConfidence = 0;
  } else {
    const sum = stacks.reduce((acc, s) => acc + s.confidence, 0);
    overallConfidence = clamp(Math.round(sum / stacks.length), 0, 95);
  }

  return {
    stacks,
    overallConfidence,
    totalValue,
    modelUsed: result.modelUsed || CHIP_COUNT_MODELS[0].model,
    shotsUsed: 1,
    recountStackIds: stacks.filter(s => s.confidence < 70).map(s => s.chipId),
    totalValueCheckResult,
  };
}

function emptyChipCountResult(
  error: string,
  errorCode: PhotoChipCountErrorCode,
): PhotoChipCountResult {
  return {
    stacks: [],
    overallConfidence: 0,
    totalValue: 0,
    modelUsed: CHIP_COUNT_MODELS[0].model,
    error,
    errorCode,
  };
}
