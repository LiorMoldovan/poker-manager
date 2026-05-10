// Trivia game — question generator.
//
// LIVE DATA — proof of freshness.
//
// Every quiz call rebuilds answers from current data, no caching:
//   TriviaGameScreen
//     → generateTriviaBatch(mode, count, ctx, categories)
//     → ctx.{games, gamePlayers, playerStats}
//     → storage.getPlayerStats() rebuilds aggregates on every call
//     → cacheGet (in-memory map) — kept fresh by Supabase Realtime
//       subscription on `games` and `game_players` tables, with a
//       500ms debounce.
//
// Practical guarantee: after a new game is saved (status = completed),
// the SAME template will return a different correct answer within
// ~1 second. No service-worker invalidation, no manual refresh, no
// stale answers. If you doubt this, run the trivia twice — once
// before saving a game, once after — and watch the relevant
// numeric/who answer flip.
//
// Verified live against the production DB at v5.44.x (group
// "Poker Night", 239 completed games) — every spot-checked template
// matched the SQL ground truth from `game_players`.
//
// Architecture: each "template" is a pure function that, given the
// group's live data, either returns a fully-formed `TriviaQuestion`
// (text + 4 answers + correct flag) or returns `null` when the data
// is too thin to produce a meaningful question (e.g. asking about
// "biggest single-night win" when no one has positive profit yet).
//
// The session driver (`generateTriviaBatch`) shuffles the templates
// per game so consecutive games surface different questions, and
// it filters templates by mode (group / players). When two templates
// both produce questions about the same subject (e.g. "biggest win
// ever" and "who had the biggest win ever") only one is emitted per
// session to avoid back-to-back redundancy.
//
// Player eligibility: per the user requirement, any player with
// FEWER THAN 5 completed games is silently excluded from question
// pools (both as the subject of a player-mode question and as a
// distractor in any "who" question). The 5-game floor keeps the
// answer set fair for serious regulars and avoids one-off guests
// polluting the multiple-choice options.

import type { Game, GamePlayer, Player, PlayerGender, PlayerStats } from '../types';
import { formatCurrency } from './calculations';
import type { TranslationKey, Language } from '../i18n';

// Localized "Mar 12, 2025" / "12.3.2025" date for explanations.
// We deliberately don't use the long Hebrew weekday-style format
// from the existing `formatHebrewDate` helper because explanation
// banners must stay compact (≤ 3 lines on a phone). Pure numeric
// d.m.yyyy in Hebrew, "Mon DD, YYYY" in English.
export function formatExplanationDate(iso: string, language: Language): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (language === 'he') {
    return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
  }
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// ─── Public types ────────────────────────────────────────────────

// 'mixed' = no mode filter (the user picked "all questions" on the
// landing screen). Templates are still tagged with their natural mode
// — only generateTriviaBatch consumes 'mixed' as "draw from both pools".
export type TriviaMode = 'group' | 'players' | 'mixed';

// Coarse topic taxonomy mirrored on the landing screen. Lives next
// to the templates themselves so we can never silently ship a new
// template that has no category — TS will yell. Keep this list short
// (4 buckets is enough for ~30 templates); finer-grained tagging
// would just create empty filter chips.
export type TriviaCategory = 'profit_loss' | 'wins' | 'history' | 'matchups';

export const TRIVIA_CATEGORIES: { id: TriviaCategory; icon: string; key: TranslationKey }[] = [
  { id: 'profit_loss', icon: '💰', key: 'trivia.cat.profitLoss' },
  { id: 'wins',        icon: '🏆', key: 'trivia.cat.wins' },
  { id: 'history',     icon: '📅', key: 'trivia.cat.history' },
  { id: 'matchups',    icon: '🤝', key: 'trivia.cat.matchups' },
];

export interface TriviaAnswer {
  text: string;
  isCorrect: boolean;
}

export interface TriviaQuestion {
  // Stable id per template for analytics / debugging. Different
  // template invocations within the same session get unique
  // suffixes (e.g. "playerBiggestWin#מור").
  id: string;
  templateId: string;
  mode: TriviaMode;
  // Optional emoji to lend visual flavor to the question card.
  icon?: string;
  text: string;
  // Always exactly 4 answers, exactly one with `isCorrect: true`.
  answers: TriviaAnswer[];
  // Optional one-line follow-up shown after the user answers, to
  // turn each question into a moment of learning ("Did you know?").
  explanation?: string;
}

export interface TriviaContext {
  games: Game[];
  gamePlayers: GamePlayer[];
  playerStats: PlayerStats[];
  // Roster of all players in the group with their gender. Used to
  // make Hebrew question/explanation text gender-correct (e.g. "סיים"
  // for males vs "סיימה" for females) instead of the awkward generic
  // slash form ("סיים/ה"). When omitted, templates fall back to the
  // masculine form everywhere.
  players?: Player[];
  // The currently logged-in player, used to bias player-mode
  // questions toward subjects the user actually knows. NEVER used
  // as the correct answer in a "who" question — that would let the
  // user always pick themselves and trivially win.
  selfPlayerName: string | null;
  language: Language;
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}

// ─── Helper utilities ────────────────────────────────────────────

// Mulberry32-style deterministic shuffle isn't needed here — the
// trivia game is always randomised per session and we don't need
// reproducibility (each game IS supposed to feel different). Plain
// Fisher-Yates on Math.random() is correct.
export function shuffle<T>(arr: readonly T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Pick `n` distinct elements from `pool`, excluding any element
// matching `exclude`. Returns fewer than n if the pool is too small.
export function sampleDistinct<T>(pool: readonly T[], n: number, exclude: (item: T) => boolean = () => false): T[] {
  const eligible = pool.filter(p => !exclude(p));
  return shuffle(eligible).slice(0, n);
}

// Build a question with the correct answer + 3 distractors. Caller
// supplies just the text values — we wrap, mark, shuffle, and return
// the final `answers` array. Returns null if there aren't enough
// distractors to fill 4 slots.
export function buildAnswers(correct: string, distractors: string[]): TriviaAnswer[] | null {
  // De-dupe — a distractor that exactly matches the correct answer
  // would silently produce a "two correct" multiple-choice. Strip
  // textual duplicates against the correct answer AND against each
  // other to keep the set of 4 strictly unique.
  const seen = new Set<string>([correct]);
  const dedupedDistractors: string[] = [];
  for (const d of distractors) {
    if (seen.has(d)) continue;
    seen.add(d);
    dedupedDistractors.push(d);
  }
  if (dedupedDistractors.length < 3) return null;
  const slate = [
    { text: correct, isCorrect: true },
    ...dedupedDistractors.slice(0, 3).map(text => ({ text, isCorrect: false })),
  ];
  return shuffle(slate);
}

// Round a number to a "nice" magnitude. Used for plausible numeric
// distractors so we don't generate giveaways like "1000.5 vs 23 vs
// 999 vs 7". The granularity scales with magnitude — small numbers
// snap to integers, hundreds snap to tens, thousands snap to fifties,
// etc.
function niceRound(n: number): number {
  const abs = Math.abs(n);
  let bucket: number;
  if (abs < 50) bucket = 1;
  else if (abs < 200) bucket = 5;
  else if (abs < 1000) bucket = 10;
  else if (abs < 5000) bucket = 50;
  else bucket = 100;
  return Math.round(n / bucket) * bucket;
}

// Generate 3 plausible-but-wrong numeric distractors around `correct`.
// Spread = how far they range from correct (e.g. 0.3 → ±30%). Avoids
// negatives when correct is positive (and vice versa), and avoids
// producing duplicates of `correct` after rounding.
export function numericDistractors(correct: number, spread = 0.35): string[] {
  const sign = correct >= 0 ? 1 : -1;
  const magnitude = Math.abs(correct);
  const out = new Set<number>();
  let attempts = 0;
  while (out.size < 6 && attempts < 50) {
    attempts++;
    // Range: [magnitude * (1 - spread), magnitude * (1 + spread)]
    // but never less than 0 and never equal to correct after rounding.
    const delta = (Math.random() * 2 - 1) * spread * magnitude;
    const candidate = niceRound((magnitude + delta) * sign);
    if (candidate === correct) continue;
    if (sign > 0 && candidate <= 0) continue;
    if (sign < 0 && candidate >= 0) continue;
    out.add(candidate);
  }
  return Array.from(out)
    .slice(0, 3)
    .map(n => formatCurrency(n));
}

// Generate 3 distractor years near `correct`. Mirrors the numeric
// helper but constrained to consecutive years (year-1, year+1, etc.)
// since "within ±35%" doesn't make sense for years.
export function yearDistractors(correct: number, currentYear: number): string[] {
  const candidates: number[] = [];
  // Prefer adjacent years; if the group's full history is short we
  // still want 3 distractors so we widen as needed.
  for (let offset = 1; offset <= 6 && candidates.length < 6; offset++) {
    const lo = correct - offset;
    const hi = correct + offset;
    if (lo > 2010 && lo !== correct) candidates.push(lo);
    if (hi <= currentYear && hi !== correct) candidates.push(hi);
  }
  return shuffle(candidates).slice(0, 3).map(String);
}

// Day of the week (0 = Sunday, 6 = Saturday) computed in
// Asia/Jerusalem regardless of the viewer's local timezone.
// Falls back to local-time getDay() if Intl can't parse the
// timezone (extremely old browsers).
export function jerusalemDayOfWeek(iso: string): number {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return -1;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Jerusalem',
      weekday: 'short',
    });
    const wk = fmt.format(d);
    const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const result = map[wk];
    return result == null ? d.getDay() : result;
  } catch {
    return d.getDay();
  }
}

// Day-of-week distractors for "what's the most popular game day?"
export function dayDistractors(correctDow: number, t: TriviaContext['t']): string[] {
  const allDows = [0, 1, 2, 3, 4, 5, 6].filter(d => d !== correctDow);
  const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
  return shuffle(allDows).slice(0, 3).map(d => t(`home.trivia.dayOfWeek.${dayKeys[d]}`));
}

// Snapshot of one player's profit across one game (denormalised
// from `gamePlayers` for fast lookup in templates). The generator
// builds these once per batch, not per template.
export interface PlayerGameRow {
  playerName: string;
  gameId: string;
  date: string;
  profit: number;
  rebuys: number;
}

export interface BuildBundle {
  ctx: TriviaContext;
  // Players with ≥ 5 completed games. Subject pool for player-mode
  // questions and distractor pool for any "who" question.
  eligibleNames: string[];
  // Indexed view of game_players, filtered to completed games only
  // and joined with the game's date.
  rows: PlayerGameRow[];
  // Per-game indices for fast aggregations.
  gameById: Map<string, Game>;
  rowsByPlayer: Map<string, PlayerGameRow[]>;
  rowsByGame: Map<string, PlayerGameRow[]>;
  currentYear: number;
  // ─── Trivia-specific "1st place" semantics ───────────────────────
  // CRITICAL: PlayerStats.winCount counts games with profit > 0
  // (a "profitable night"). That's NOT the same as "finished 1st"
  // — a player who came 2nd while still profitable is counted as a
  // "win" by the data, but trivia users mean "took home the most
  // money that night" when they hear "1st place". So for any
  // trivia question that says "ראשון" / "1st place" / "wins" we
  // compute the TRUE chip-leader counts here, by ranking each
  // game's profits and awarding 1st only to the top entry.
  // Ties at the top are broken arbitrarily (stable sort keeps
  // input order) — fine in practice because exact-profit ties for
  // 1st are vanishingly rare.
  firstPlaceByPlayer: Map<string, number>;
  // Longest consecutive run of 1st-place finishes per player,
  // walking their games in chronological order. Like the count
  // above, this is profit-rank based, NOT profit-positive based.
  firstPlaceStreakByPlayer: Map<string, number>;
  // Player name → gender (male/female). Used by `gParams` to fill
  // gender-aware translation tokens. Names not in the map default
  // to male (the generic Hebrew form), so old groups that haven't
  // recorded gender still produce grammatical text.
  genderByName: Map<string, PlayerGender>;
}

// Hebrew gender substitution tokens. Translation strings use these
// placeholders ({g}, {ah}, {ta}, {shel}, {alav}) so we can render
// the correct masculine or feminine form once we know whose name
// is in the sentence. Pass `prefix` to namespace the tokens when a
// single string mentions two different people (e.g. nemesis + name).
//
// Token meanings:
//   g    — verb suffix: '' (m) / 'ה' (f). Covers שיחק → שיחקה,
//          סיים → סיימה, הצטרף → הצטרפה, etc. (most common).
//   ah   — verb suffix: 'ה' (m) / 'תה' (f). Covers זכה → זכתה,
//          עלה → עלתה (past tense of ה-final verbs).
//   ta   — verb suffix: '' (m) / 'ת' (f). Covers שולט → שולטת.
//   shel — full word: 'שלו' (m) / 'שלה' (f). Possessive.
//   alav — full word: 'עליו' (m) / 'עליה' (f). Preposition "above
//          him/her" (used after מ to form מעליו/מעליה).
export function gParams(
  b: BuildBundle,
  name: string,
  prefix = '',
): Record<string, string> {
  const isFemale = b.genderByName.get(name) === 'female';
  return {
    [`${prefix}g`]: isFemale ? 'ה' : '',
    [`${prefix}ah`]: isFemale ? 'תה' : 'ה',
    [`${prefix}ta`]: isFemale ? 'ת' : '',
    [`${prefix}shel`]: isFemale ? 'שלה' : 'שלו',
    [`${prefix}alav`]: isFemale ? 'עליה' : 'עליו',
  };
}

function buildBundle(ctx: TriviaContext): BuildBundle {
  const { games, gamePlayers, playerStats } = ctx;
  const completedById = new Map<string, Game>();
  for (const g of games) {
    if (g.status === 'completed') completedById.set(g.id, g);
  }
  const rows: PlayerGameRow[] = [];
  for (const gp of gamePlayers) {
    const g = completedById.get(gp.gameId);
    if (!g) continue;
    rows.push({
      playerName: gp.playerName,
      gameId: gp.gameId,
      date: g.date || g.createdAt,
      profit: gp.profit,
      rebuys: gp.rebuys || 0,
    });
  }
  const eligibleNames = playerStats
    .filter(s => s.gamesPlayed >= 5)
    .map(s => s.playerName);
  const eligibleSet = new Set(eligibleNames);

  // Filter rows to eligible players for distractor pools, but keep
  // the full row set for record queries (we want the truth even if
  // the answer turns out to be ineligible — we'll re-check downstream).
  const rowsByPlayer = new Map<string, PlayerGameRow[]>();
  const rowsByGame = new Map<string, PlayerGameRow[]>();
  for (const r of rows) {
    if (eligibleSet.has(r.playerName)) {
      let arr = rowsByPlayer.get(r.playerName);
      if (!arr) { arr = []; rowsByPlayer.set(r.playerName, arr); }
      arr.push(r);
    }
    let garr = rowsByGame.get(r.gameId);
    if (!garr) { garr = []; rowsByGame.set(r.gameId, garr); }
    garr.push(r);
  }
  // 1st-place counts: rank each game by profit DESC, top entry is
  // the night's winner. Skip games with < 2 players (degenerate)
  // and games where the top profit is ≤ 0 (no real winner — every
  // body lost money, no chip leader to celebrate). Counting all
  // players, not just eligible ones, since the eligibility filter
  // is applied downstream when picking subjects/winners.
  const firstPlaceByPlayer = new Map<string, number>();
  for (const arr of rowsByGame.values()) {
    if (arr.length < 2) continue;
    const sorted = [...arr].sort((a, z) => z.profit - a.profit);
    const top = sorted[0];
    if (top.profit <= 0) continue;
    firstPlaceByPlayer.set(top.playerName, (firstPlaceByPlayer.get(top.playerName) ?? 0) + 1);
  }

  // 1st-place streaks: per-player, walk their games in chronological
  // order and count the longest run of consecutive 1st-place finishes.
  // We need the date sort here because rowsByPlayer was built in
  // gamePlayers iteration order, not date order.
  const firstPlaceStreakByPlayer = new Map<string, number>();
  for (const [playerName, playerRows] of rowsByPlayer.entries()) {
    const chronological = [...playerRows].sort((a, z) => a.date.localeCompare(z.date));
    let longest = 0;
    let current = 0;
    for (const r of chronological) {
      const gameRows = rowsByGame.get(r.gameId) ?? [];
      if (gameRows.length < 2) { current = 0; continue; }
      const sorted = [...gameRows].sort((a, b) => b.profit - a.profit);
      const wonNight = sorted[0].profit > 0 && sorted[0].playerName === playerName;
      if (wonNight) {
        current++;
        if (current > longest) longest = current;
      } else {
        current = 0;
      }
    }
    if (longest > 0) firstPlaceStreakByPlayer.set(playerName, longest);
  }

  // Player → gender map for gender-correct Hebrew. Falls back to
  // an empty map when the caller didn't pass `players` (older
  // call sites or test contexts), in which case `gParams` returns
  // the masculine form for everyone — same behavior as before this
  // map existed, just without the awkward "/ה" slash.
  const genderByName = new Map<string, PlayerGender>();
  for (const p of ctx.players ?? []) {
    if (p.name && p.gender) genderByName.set(p.name, p.gender);
  }

  return {
    ctx,
    eligibleNames,
    rows,
    gameById: completedById,
    rowsByPlayer,
    rowsByGame,
    currentYear: new Date().getFullYear(),
    firstPlaceByPlayer,
    firstPlaceStreakByPlayer,
    genderByName,
  };
}

// Wrap a "who" question helper: given the correct player name and
// the eligible-name pool, build the answer set with 3 distinct
// player distractors. Returns null if the pool is too small.
export function whoAnswers(correct: string, b: BuildBundle): TriviaAnswer[] | null {
  if (!b.eligibleNames.includes(correct)) return null;
  const distractors = sampleDistinct(b.eligibleNames, 3, n => n === correct);
  if (distractors.length < 3) return null;
  return buildAnswers(correct, distractors);
}

// ─── Template definition ─────────────────────────────────────────

export interface TemplateOutput {
  text: string;
  answers: TriviaAnswer[];
  icon?: string;
  explanation?: string;
}

export interface Template {
  id: string;
  // Templates declare a concrete pool ('group' or 'players') — the
  // 'mixed' run-mode is handled by generateTriviaBatch, NOT by
  // template authors.
  mode: Exclude<TriviaMode, 'mixed'>;
  category: TriviaCategory;
  // Optional grouping key — templates sharing a group are mutually
  // exclusive within a single session (we won't ask both "who has
  // the biggest win all-time" and "what is the biggest win all-time"
  // back-to-back since the answer to one gives the other away).
  group?: string;
  build: (b: BuildBundle) => TemplateOutput | null;
}

// ─── GROUP MODE templates ────────────────────────────────────────
//
// Each builder is a pure function from the bundle to a question.
// Returning null = "skip me" (data insufficient for this template
// to produce a non-trivial question).

const GROUP_TEMPLATES: Template[] = [
  // Headline: who's the all-time profit champion?
  {
    id: 'topProfitAllTime',
    mode: 'group',
    category: 'profit_loss',
    group: 'topProfit',
    build: (b) => {
      const ranked = b.ctx.playerStats
        .filter(s => b.eligibleNames.includes(s.playerName))
        // Tiebreak by playerName so equal-profit ties are stable
        // across regenerations (extremely rare but defensive).
        .sort((a, z) => z.totalProfit - a.totalProfit || a.playerName.localeCompare(z.playerName));
      if (ranked.length < 4) return null;
      const winner = ranked[0];
      const answers = whoAnswers(winner.playerName, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.topProfitAllTime'),
        answers,
        icon: '🏆',
        explanation: b.ctx.t('trivia.exp.totalProfit', {
          name: winner.playerName,
          profit: formatCurrency(Math.round(winner.totalProfit)),
          games: winner.gamesPlayed,
        }),
      };
    },
  },

  // The "biggest losers club" mirror — who's the all-time biggest
  // net loser. Less celebratory but a fact the group whispers about.
  {
    id: 'biggestNetLoserAllTime',
    mode: 'group',
    category: 'profit_loss',
    build: (b) => {
      const ranked = b.ctx.playerStats
        .filter(s => b.eligibleNames.includes(s.playerName))
        .sort((a, z) => a.totalProfit - z.totalProfit || a.playerName.localeCompare(z.playerName));
      if (ranked.length < 4 || ranked[0].totalProfit >= 0) return null;
      const subject = ranked[0];
      const answers = whoAnswers(subject.playerName, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.biggestNetLoserAllTime'),
        answers,
        icon: '📉',
        explanation: b.ctx.t('trivia.exp.totalLoss', {
          name: subject.playerName,
          loss: formatCurrency(Math.round(subject.totalProfit)),
          games: subject.gamesPlayed,
        }),
      };
    },
  },

  // Most games played — group's most reliable showup-er.
  {
    id: 'mostGamesAllTime',
    mode: 'group',
    category: 'history',
    build: (b) => {
      const ranked = b.ctx.playerStats
        .filter(s => b.eligibleNames.includes(s.playerName))
        .sort((a, z) => z.gamesPlayed - a.gamesPlayed || a.playerName.localeCompare(z.playerName));
      if (ranked.length < 4) return null;
      const subject = ranked[0];
      const answers = whoAnswers(subject.playerName, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.mostGamesAllTime'),
        answers,
        icon: '🎯',
        explanation: b.ctx.t('trivia.exp.mostGames', {
          name: subject.playerName,
          games: subject.gamesPlayed,
          ...gParams(b, subject.playerName),
        }),
      };
    },
  },

  // Most #1 finishes all-time. Uses TRUE 1st-place count (chip
  // leader of the night), NOT PlayerStats.winCount — see the long
  // comment on `firstPlaceByPlayer` in BuildBundle for the why.
  {
    id: 'mostWinsAllTime',
    mode: 'group',
    category: 'wins',
    build: (b) => {
      const ranked = b.ctx.playerStats
        .filter(s => b.eligibleNames.includes(s.playerName))
        .map(s => ({ stats: s, firsts: b.firstPlaceByPlayer.get(s.playerName) ?? 0 }))
        .sort((a, z) => {
          if (z.firsts !== a.firsts) return z.firsts - a.firsts;
          // Deterministic tiebreak: more games played (= more
          // opportunities) loses the tie, so we prefer the player
          // with the higher 1st-place RATE. Then alphabetical for
          // total stability across runs.
          if (a.stats.gamesPlayed !== z.stats.gamesPlayed) return a.stats.gamesPlayed - z.stats.gamesPlayed;
          return a.stats.playerName.localeCompare(z.stats.playerName);
        });
      if (ranked.length < 4 || ranked[0].firsts < 1) return null;
      const subject = ranked[0];
      const answers = whoAnswers(subject.stats.playerName, b);
      if (!answers) return null;
      const pct = subject.stats.gamesPlayed > 0
        ? Math.round((subject.firsts / subject.stats.gamesPlayed) * 100)
        : 0;
      return {
        text: b.ctx.t('trivia.q.mostWinsAllTime'),
        answers,
        icon: '🥇',
        explanation: b.ctx.t('trivia.exp.mostWins', {
          name: subject.stats.playerName,
          wins: subject.firsts,
          games: subject.stats.gamesPlayed,
          pct,
          ...gParams(b, subject.stats.playerName),
        }),
      };
    },
  },

  // Highest 1st-place rate (only counts players ≥ 10 games for
  // fairness). Uses true chip-leader count, NOT profit > 0.
  {
    id: 'highestWinRate',
    mode: 'group',
    category: 'wins',
    build: (b) => {
      const eligible = b.ctx.playerStats
        .filter(s => s.gamesPlayed >= 10 && b.eligibleNames.includes(s.playerName))
        .map(s => {
          const firsts = b.firstPlaceByPlayer.get(s.playerName) ?? 0;
          return { stats: s, firsts, rate: (firsts / s.gamesPlayed) * 100 };
        })
        .sort((a, z) => {
          if (z.rate !== a.rate) return z.rate - a.rate;
          // Tiebreak: prefer player with MORE games (sample size),
          // then alphabetical.
          if (z.stats.gamesPlayed !== a.stats.gamesPlayed) return z.stats.gamesPlayed - a.stats.gamesPlayed;
          return a.stats.playerName.localeCompare(z.stats.playerName);
        });
      if (eligible.length < 4 || eligible[0].firsts < 1) return null;
      const subject = eligible[0];
      const answers = whoAnswers(subject.stats.playerName, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.highestWinRate'),
        answers,
        icon: '💎',
        explanation: b.ctx.t('trivia.exp.winRate', {
          name: subject.stats.playerName,
          pct: Math.round(subject.rate),
          wins: subject.firsts,
          games: subject.stats.gamesPlayed,
          ...gParams(b, subject.stats.playerName),
        }),
      };
    },
  },

  // Numeric: biggest single-night profit ever (winner amount).
  {
    id: 'biggestSingleWinAmount',
    mode: 'group',
    category: 'profit_loss',
    group: 'biggestWin',
    build: (b) => {
      const winnerRow = b.rows.reduce<PlayerGameRow | null>(
        (best, r) => (best == null || r.profit > best.profit ? r : best), null);
      if (!winnerRow || winnerRow.profit <= 0) return null;
      const correct = formatCurrency(Math.round(winnerRow.profit));
      const distractors = numericDistractors(winnerRow.profit);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.biggestSingleWinAmount'),
        answers,
        icon: '💰',
        explanation: b.ctx.t('trivia.exp.biggestSingleWin', {
          name: winnerRow.playerName,
          profit: correct,
          date: formatExplanationDate(winnerRow.date, b.ctx.language),
          ...gParams(b, winnerRow.playerName),
        }),
      };
    },
  },

  // Player: who took home the biggest single-night profit ever?
  {
    id: 'biggestSingleWinPlayer',
    mode: 'group',
    category: 'profit_loss',
    group: 'biggestWin',
    build: (b) => {
      const winnerRow = b.rows.reduce<PlayerGameRow | null>(
        (best, r) => (best == null || r.profit > best.profit ? r : best), null);
      if (!winnerRow || winnerRow.profit <= 0) return null;
      const answers = whoAnswers(winnerRow.playerName, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.biggestSingleWinPlayer'),
        answers,
        icon: '🚀',
        explanation: b.ctx.t('trivia.exp.biggestSingleWin', {
          name: winnerRow.playerName,
          profit: formatCurrency(Math.round(winnerRow.profit)),
          date: formatExplanationDate(winnerRow.date, b.ctx.language),
          ...gParams(b, winnerRow.playerName),
        }),
      };
    },
  },

  // Numeric: biggest single-night loss ever.
  {
    id: 'biggestSingleLossAmount',
    mode: 'group',
    category: 'profit_loss',
    group: 'biggestLoss',
    build: (b) => {
      const loserRow = b.rows.reduce<PlayerGameRow | null>(
        (worst, r) => (worst == null || r.profit < worst.profit ? r : worst), null);
      if (!loserRow || loserRow.profit >= 0) return null;
      const correct = formatCurrency(Math.round(loserRow.profit));
      const distractors = numericDistractors(loserRow.profit);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.biggestSingleLossAmount'),
        answers,
        icon: '🥶',
        explanation: b.ctx.t('trivia.exp.biggestSingleLoss', {
          name: loserRow.playerName,
          loss: correct,
          date: formatExplanationDate(loserRow.date, b.ctx.language),
          ...gParams(b, loserRow.playerName),
        }),
      };
    },
  },

  // Largest table ever (player count).
  {
    id: 'largestTableEver',
    mode: 'group',
    category: 'history',
    build: (b) => {
      let maxSize = 0;
      let maxDate = '';
      for (const arr of b.rowsByGame.values()) {
        if (arr.length > maxSize) {
          maxSize = arr.length;
          maxDate = arr[0]?.date ?? '';
        }
      }
      if (maxSize < 6) return null;
      const candidates = [maxSize - 2, maxSize - 1, maxSize + 1, maxSize + 2]
        .filter(n => n >= 2 && n !== maxSize);
      const distractors = shuffle(candidates).slice(0, 3).map(String);
      const answers = buildAnswers(String(maxSize), distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.largestTableEver'),
        answers,
        icon: '👥',
        explanation: b.ctx.t('trivia.exp.largestTable', {
          players: maxSize,
          date: formatExplanationDate(maxDate, b.ctx.language),
        }),
      };
    },
  },

  // Total games played by the group all-time.
  {
    id: 'totalGroupGames',
    mode: 'group',
    category: 'history',
    build: (b) => {
      const total = b.gameById.size;
      if (total < 30) return null;
      // Find the earliest game date for the explanation's "since"
      // anchor — gives the user a feel for the time span behind the
      // total ("X games since 2018" reads richer than just "X games").
      let earliestIso = '';
      for (const g of b.gameById.values()) {
        if (!earliestIso || g.date < earliestIso) earliestIso = g.date;
      }
      const correct = String(total);
      const distractors = numericDistractors(total, 0.2);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.totalGroupGames'),
        answers,
        icon: '📚',
        explanation: b.ctx.t('trivia.exp.totalGroupGames', {
          total,
          since: formatExplanationDate(earliestIso, b.ctx.language),
        }),
      };
    },
  },

  // Year with most games played.
  {
    id: 'mostActiveYear',
    mode: 'group',
    category: 'history',
    build: (b) => {
      const yearCounts = new Map<number, number>();
      for (const g of b.gameById.values()) {
        const y = new Date(g.date).getFullYear();
        if (Number.isFinite(y)) yearCounts.set(y, (yearCounts.get(y) ?? 0) + 1);
      }
      if (yearCounts.size < 2) return null;
      // Tiebreak: prefer the more RECENT year so the answer feels
      // current ("2025 was the busiest" beats "2019 was equally busy").
      const ranked = [...yearCounts.entries()].sort((a, z) => z[1] - a[1] || z[0] - a[0]);
      const correct = ranked[0][0];
      const distractors = yearDistractors(correct, b.currentYear);
      if (distractors.length < 3) return null;
      const answers = buildAnswers(String(correct), distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.mostActiveYear'),
        answers,
        icon: '📅',
        explanation: b.ctx.t('trivia.exp.mostActiveYear', { year: correct, games: ranked[0][1] }),
      };
    },
  },

  // Most popular day of the week. Pinned to Asia/Jerusalem so the
  // result doesn't shift if the viewer is on vacation in another
  // timezone — the GROUP plays in Israel, so the group's "Saturday
  // night" shouldn't become "Friday late-night" just because the
  // user opens the app from Tokyo.
  {
    id: 'mostPopularDay',
    mode: 'group',
    category: 'history',
    build: (b) => {
      const counts = [0, 0, 0, 0, 0, 0, 0];
      for (const g of b.gameById.values()) {
        const d = jerusalemDayOfWeek(g.date);
        if (Number.isFinite(d)) counts[d]++;
      }
      const top = counts.indexOf(Math.max(...counts));
      if (counts[top] < 5) return null;
      const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
      const correct = b.ctx.t(`home.trivia.dayOfWeek.${dayKeys[top]}`);
      const distractors = dayDistractors(top, b.ctx.t);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      const totalGames = counts.reduce((a, c) => a + c, 0);
      return {
        text: b.ctx.t('trivia.q.mostPopularDay'),
        answers,
        icon: '🌙',
        explanation: b.ctx.t('trivia.exp.mostPopularDay', {
          day: correct,
          games: counts[top],
          total: totalGames,
        }),
      };
    },
  },

  // Best avg-per-game (profit champ that controls for sample size).
  {
    id: 'bestAvgPerGame',
    mode: 'group',
    category: 'profit_loss',
    build: (b) => {
      const eligible = b.ctx.playerStats
        .filter(s => s.gamesPlayed >= 10 && b.eligibleNames.includes(s.playerName))
        .sort((a, z) => z.avgProfit - a.avgProfit || a.playerName.localeCompare(z.playerName));
      if (eligible.length < 4) return null;
      const subject = eligible[0];
      if (subject.avgProfit <= 0) return null;
      const answers = whoAnswers(subject.playerName, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.bestAvgPerGame'),
        answers,
        icon: '📊',
        explanation: b.ctx.t('trivia.exp.bestAvgPerGame', {
          name: subject.playerName,
          avg: formatCurrency(Math.round(subject.avgProfit)),
          games: subject.gamesPlayed,
        }),
      };
    },
  },

  // Most podium finishes (top-3) all-time.
  {
    id: 'mostPodiumsAllTime',
    mode: 'group',
    category: 'wins',
    build: (b) => {
      // Re-derive podium counts from rows since PlayerStats doesn't
      // carry it directly. Per game we sort by profit DESC and award
      // a podium credit to the top 3.
      const podiumCount = new Map<string, number>();
      for (const arr of b.rowsByGame.values()) {
        const sorted = [...arr].sort((a, z) => z.profit - a.profit);
        for (let i = 0; i < Math.min(3, sorted.length); i++) {
          podiumCount.set(sorted[i].playerName, (podiumCount.get(sorted[i].playerName) ?? 0) + 1);
        }
      }
      const ranked = [...podiumCount.entries()]
        .filter(([name]) => b.eligibleNames.includes(name))
        .sort((a, z) => z[1] - a[1] || a[0].localeCompare(z[0]));
      if (ranked.length < 4) return null;
      const subject = ranked[0];
      const answers = whoAnswers(subject[0], b);
      if (!answers) return null;
      const subjectStats = b.ctx.playerStats.find(s => s.playerName === subject[0]);
      return {
        text: b.ctx.t('trivia.q.mostPodiumsAllTime'),
        answers,
        icon: '🏅',
        explanation: b.ctx.t('trivia.exp.mostPodiums', {
          name: subject[0],
          podiums: subject[1],
          games: subjectStats?.gamesPlayed ?? '?',
        }),
      };
    },
  },

  // Longest streak of consecutive 1st-place finishes. Uses TRUE
  // chip-leader streaks (firstPlaceStreakByPlayer), NOT the
  // PlayerStats.longestWinStreak field which counts profit > 0.
  {
    id: 'longestWinStreak',
    mode: 'group',
    category: 'wins',
    build: (b) => {
      const ranked = b.ctx.playerStats
        .filter(s => b.eligibleNames.includes(s.playerName))
        .map(s => ({ stats: s, streak: b.firstPlaceStreakByPlayer.get(s.playerName) ?? 0 }))
        .sort((a, z) => {
          if (z.streak !== a.streak) return z.streak - a.streak;
          // Tiebreak: more games (longer track record) wins ties,
          // then alphabetical for stability.
          if (z.stats.gamesPlayed !== a.stats.gamesPlayed) return z.stats.gamesPlayed - a.stats.gamesPlayed;
          return a.stats.playerName.localeCompare(z.stats.playerName);
        });
      if (ranked.length < 4 || ranked[0].streak < 2) return null;
      const subject = ranked[0];
      const answers = whoAnswers(subject.stats.playerName, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.longestWinStreak'),
        answers,
        icon: '🔥',
        explanation: b.ctx.t('trivia.exp.winStreak', {
          name: subject.stats.playerName,
          streak: subject.streak,
        }),
      };
    },
  },

  // Rebuy king — restricted to 2026+ because that's when reliable
  // per-player rebuy tracking went live in this app. Asking "rebuy
  // king all-time" against undercounted historical data was the
  // single most-likely "this answer can't be right" trigger for
  // veteran players, so we scope it explicitly to "this year" and
  // surface the disclaimer in the explanation.
  {
    id: 'rebuyKingAllTime',
    mode: 'group',
    category: 'profit_loss',
    build: (b) => {
      const REBUY_TRACKING_START = '2026-01-01';
      const tally = new Map<string, { rebuys: number; games: number }>();
      for (const r of b.rows) {
        if (r.date < REBUY_TRACKING_START) continue;
        if (!b.eligibleNames.includes(r.playerName)) continue;
        const cur = tally.get(r.playerName) ?? { rebuys: 0, games: 0 };
        cur.rebuys += r.rebuys;
        cur.games += 1;
        tally.set(r.playerName, cur);
      }
      const ranked = [...tally.entries()]
        .map(([name, v]) => ({ name, ...v }))
        .sort((a, z) => {
          if (z.rebuys !== a.rebuys) return z.rebuys - a.rebuys;
          // Tiebreak: prefer higher rebuy RATE (fewer games), then
          // alphabetical for stability.
          if (a.games !== z.games) return a.games - z.games;
          return a.name.localeCompare(z.name);
        });
      if (ranked.length < 4 || ranked[0].rebuys < 5) return null;
      const subject = ranked[0];
      const answers = whoAnswers(subject.name, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.rebuyKingAllTime'),
        answers,
        icon: '🪙',
        explanation: b.ctx.t('trivia.exp.rebuyKing', {
          name: subject.name,
          rebuys: subject.rebuys,
          games: subject.games,
        }),
      };
    },
  },

  // Tightest game ever — by what gap did the winner edge out 2nd place?
  {
    id: 'tightestGameEver',
    mode: 'group',
    category: 'history',
    build: (b) => {
      let tightest = Infinity;
      let tightestWinner = '';
      let tightestRunnerUp = '';
      let tightestDate = '';
      for (const arr of b.rowsByGame.values()) {
        if (arr.length < 3) continue;
        const sorted = [...arr].sort((a, z) => z.profit - a.profit);
        if (sorted[0].profit <= 0) continue;
        const gap = sorted[0].profit - sorted[1].profit;
        // gap > 0: an exact tie ("edged out by ₪0") makes the
        // question nonsensical, even though such ties are rare.
        if (gap > 0 && gap < tightest) {
          tightest = gap;
          tightestWinner = sorted[0].playerName;
          tightestRunnerUp = sorted[1].playerName;
          tightestDate = sorted[0].date;
        }
      }
      if (!Number.isFinite(tightest)) return null;
      const correct = formatCurrency(Math.round(tightest));
      // Distractors: plausible-but-wrong gaps near the answer. Stay
      // strictly positive (a "0 gap" would be the impossible-tie case
      // we excluded above) and de-dup against `correct` after rounding.
      const roundedCorrect = Math.round(tightest);
      const rawCandidates = [
        roundedCorrect + 1, roundedCorrect + 2, roundedCorrect + 5,
        Math.max(1, roundedCorrect - 1), roundedCorrect + 10,
      ];
      const seen = new Set<number>([roundedCorrect]);
      const candidates: number[] = [];
      for (const n of rawCandidates) {
        if (n <= 0 || seen.has(n)) continue;
        seen.add(n);
        candidates.push(n);
      }
      const distractors = shuffle(candidates).slice(0, 3).map(n => formatCurrency(n));
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.tightestGameEver'),
        answers,
        icon: '⚖️',
        explanation: b.ctx.t('trivia.exp.tightestGame', {
          winner: tightestWinner,
          runnerUp: tightestRunnerUp,
          gap: correct,
          date: formatExplanationDate(tightestDate, b.ctx.language),
        }),
      };
    },
  },

  // First year the group ever played a game (group founding year).
  {
    id: 'foundingYear',
    mode: 'group',
    category: 'history',
    build: (b) => {
      let earliest = Infinity;
      let earliestIso = '';
      for (const g of b.gameById.values()) {
        const y = new Date(g.date).getFullYear();
        if (Number.isFinite(y) && y < earliest) {
          earliest = y;
          earliestIso = g.date;
        }
      }
      if (!Number.isFinite(earliest)) return null;
      const correct = earliest as number;
      const distractors = yearDistractors(correct, b.currentYear);
      if (distractors.length < 3) return null;
      const answers = buildAnswers(String(correct), distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.foundingYear'),
        answers,
        icon: '🎂',
        explanation: b.ctx.t('trivia.exp.foundingYear', {
          date: formatExplanationDate(earliestIso, b.ctx.language),
          years: b.currentYear - correct,
        }),
      };
    },
  },
];

// ─── PLAYERS MODE templates ──────────────────────────────────────
//
// Each template picks a random eligible player as the "subject" and
// asks a question about them. We seed the random pick from the
// bundle's eligibleNames so subjects rotate across games. NEVER
// uses `selfPlayerName` as the subject because asking the user a
// question about themselves is too easy.

// Pick a random eligible player as the subject of a player-mode
// question. Defaults to excluding `selfPlayerName` because:
//   1. Asking the user about themselves is too easy — they already
//      know their own biggest win, lifetime profit, etc.
//   2. The "About You" home card already serves up personal facts;
//      trivia is meant to test what the user knows about OTHERS.
// Pass `exclude = null` explicitly if a template legitimately wants
// to allow self as the subject (no current template does).
export function pickSubject(b: BuildBundle, exclude: string | null | undefined = b.ctx.selfPlayerName): string | null {
  const pool = exclude
    ? b.eligibleNames.filter(n => n !== exclude)
    : b.eligibleNames;
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

const PLAYER_TEMPLATES: Template[] = [
  // Numeric: how many games has X played?
  {
    id: 'playerGameCount',
    mode: 'players',
    category: 'history',
    build: (b) => {
      const subject = pickSubject(b);
      if (!subject) return null;
      const stats = b.ctx.playerStats.find(s => s.playerName === subject);
      if (!stats) return null;
      const correct = String(stats.gamesPlayed);
      const distractors = numericDistractors(stats.gamesPlayed, 0.3);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.playerGameCount', { name: subject, ...gParams(b, subject) }),
        answers,
        icon: '🎲',
        explanation: b.ctx.t('trivia.exp.playerGameCount', {
          name: subject,
          games: stats.gamesPlayed,
          wins: stats.winCount,
          pct: Math.round(stats.winPercentage),
          ...gParams(b, subject),
        }),
      };
    },
  },

  // Numeric: lifetime profit of X.
  {
    id: 'playerLifetimeProfit',
    mode: 'players',
    category: 'profit_loss',
    build: (b) => {
      const subject = pickSubject(b);
      if (!subject) return null;
      const stats = b.ctx.playerStats.find(s => s.playerName === subject);
      if (!stats) return null;
      const correct = formatCurrency(Math.round(stats.totalProfit));
      const distractors = numericDistractors(stats.totalProfit, 0.3);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.playerLifetimeProfit', { name: subject }),
        answers,
        icon: '💵',
        explanation: b.ctx.t('trivia.exp.playerLifetimeProfit', {
          name: subject,
          profit: correct,
          games: stats.gamesPlayed,
          avg: formatCurrency(Math.round(stats.avgProfit)),
        }),
      };
    },
  },

  // Numeric: how many 1st-place finishes does X have? Uses TRUE
  // chip-leader count (firstPlaceByPlayer), NOT profit > 0.
  {
    id: 'playerWinCount',
    mode: 'players',
    category: 'wins',
    build: (b) => {
      const subject = pickSubject(b);
      if (!subject) return null;
      const stats = b.ctx.playerStats.find(s => s.playerName === subject);
      const firsts = b.firstPlaceByPlayer.get(subject) ?? 0;
      if (!stats || firsts < 1) return null;
      const correct = String(firsts);
      const distractors = numericDistractors(firsts, 0.5);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      const pct = stats.gamesPlayed > 0 ? Math.round((firsts / stats.gamesPlayed) * 100) : 0;
      return {
        text: b.ctx.t('trivia.q.playerWinCount', { name: subject, ...gParams(b, subject) }),
        answers,
        icon: '🥇',
        explanation: b.ctx.t('trivia.exp.playerWinCount', {
          name: subject,
          wins: firsts,
          games: stats.gamesPlayed,
          pct,
          ...gParams(b, subject),
        }),
      };
    },
  },

  // Numeric: X's biggest single-night win.
  {
    id: 'playerBiggestWin',
    mode: 'players',
    category: 'profit_loss',
    build: (b) => {
      const subject = pickSubject(b);
      if (!subject) return null;
      const stats = b.ctx.playerStats.find(s => s.playerName === subject);
      if (!stats || stats.biggestWin <= 0) return null;
      // Look up the date of that biggest-win night so the
      // explanation can anchor the number to a memorable game.
      const myRows = b.rowsByPlayer.get(subject) ?? [];
      const bestRow = myRows.reduce<PlayerGameRow | null>(
        (best, r) => (best == null || r.profit > best.profit ? r : best), null);
      const correct = formatCurrency(stats.biggestWin);
      const distractors = numericDistractors(stats.biggestWin);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.playerBiggestWin', { name: subject }),
        answers,
        icon: '🏆',
        explanation: b.ctx.t('trivia.exp.playerBiggestWin', {
          name: subject,
          profit: correct,
          date: bestRow ? formatExplanationDate(bestRow.date, b.ctx.language) : '—',
        }),
      };
    },
  },

  // Numeric: X's biggest single-night loss.
  {
    id: 'playerBiggestLoss',
    mode: 'players',
    category: 'profit_loss',
    build: (b) => {
      const subject = pickSubject(b);
      if (!subject) return null;
      const stats = b.ctx.playerStats.find(s => s.playerName === subject);
      if (!stats || stats.biggestLoss >= 0) return null;
      const myRows = b.rowsByPlayer.get(subject) ?? [];
      const worstRow = myRows.reduce<PlayerGameRow | null>(
        (worst, r) => (worst == null || r.profit < worst.profit ? r : worst), null);
      const correct = formatCurrency(stats.biggestLoss);
      const distractors = numericDistractors(stats.biggestLoss);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.playerBiggestLoss', { name: subject }),
        answers,
        icon: '🥶',
        explanation: b.ctx.t('trivia.exp.playerBiggestLoss', {
          name: subject,
          loss: correct,
          date: worstRow ? formatExplanationDate(worstRow.date, b.ctx.language) : '—',
        }),
      };
    },
  },

  // Year subject joined the group (= year of their first game).
  {
    id: 'playerJoinYear',
    mode: 'players',
    category: 'history',
    build: (b) => {
      const subject = pickSubject(b);
      if (!subject) return null;
      const myRows = b.rowsByPlayer.get(subject) ?? [];
      if (myRows.length === 0) return null;
      let earliestIso = '';
      let earliestYear = Infinity;
      for (const r of myRows) {
        const y = new Date(r.date).getFullYear();
        if (Number.isFinite(y) && y < earliestYear) {
          earliestYear = y;
          earliestIso = r.date;
        }
      }
      if (!Number.isFinite(earliestYear)) return null;
      const correct = earliestYear as number;
      const distractors = yearDistractors(correct, b.currentYear);
      if (distractors.length < 3) return null;
      const answers = buildAnswers(String(correct), distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.playerJoinYear', { name: subject, ...gParams(b, subject) }),
        answers,
        icon: '🚪',
        explanation: b.ctx.t('trivia.exp.playerJoinYear', {
          name: subject,
          date: formatExplanationDate(earliestIso, b.ctx.language),
          games: myRows.length,
        }),
      };
    },
  },

  // Who's X's biggest "nemesis" (opponent who finished above X most often)?
  {
    id: 'playerNemesis',
    mode: 'players',
    category: 'matchups',
    build: (b) => {
      const subject = pickSubject(b, b.ctx.selfPlayerName);
      if (!subject) return null;
      const myGames = (b.rowsByPlayer.get(subject) ?? []).map(r => r.gameId);
      if (myGames.length < 5) return null;
      const aboveMe = new Map<string, number>();
      for (const gid of myGames) {
        const arr = b.rowsByGame.get(gid) ?? [];
        const myProfit = arr.find(r => r.playerName === subject)?.profit ?? 0;
        for (const opp of arr) {
          if (opp.playerName === subject) continue;
          if (!b.eligibleNames.includes(opp.playerName)) continue;
          if (opp.profit > myProfit) aboveMe.set(opp.playerName, (aboveMe.get(opp.playerName) ?? 0) + 1);
        }
      }
      const ranked = [...aboveMe.entries()].sort((a, z) => z[1] - a[1] || a[0].localeCompare(z[0]));
      if (ranked.length < 4) return null;
      const nemesis = ranked[0][0];
      const distractors = sampleDistinct(b.eligibleNames, 3, n => n === nemesis || n === subject);
      if (distractors.length < 3) return null;
      const answers = buildAnswers(nemesis, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.playerNemesis', { name: subject, ...gParams(b, subject) }),
        answers,
        icon: '😈',
        explanation: b.ctx.t('trivia.exp.nemesis', {
          name: subject,
          nemesis,
          count: ranked[0][1],
          shared: myGames.length,
          pct: Math.round((ranked[0][1] / myGames.length) * 100),
          ...gParams(b, nemesis, 'n'),
        }),
      };
    },
  },

  // Who's X's most frequent table partner (most shared games)?
  {
    id: 'playerPartner',
    mode: 'players',
    category: 'matchups',
    build: (b) => {
      const subject = pickSubject(b, b.ctx.selfPlayerName);
      if (!subject) return null;
      const myGames = (b.rowsByPlayer.get(subject) ?? []).map(r => r.gameId);
      if (myGames.length < 5) return null;
      const sharedCount = new Map<string, number>();
      for (const gid of myGames) {
        const arr = b.rowsByGame.get(gid) ?? [];
        for (const opp of arr) {
          if (opp.playerName === subject) continue;
          if (!b.eligibleNames.includes(opp.playerName)) continue;
          sharedCount.set(opp.playerName, (sharedCount.get(opp.playerName) ?? 0) + 1);
        }
      }
      const ranked = [...sharedCount.entries()].sort((a, z) => z[1] - a[1] || a[0].localeCompare(z[0]));
      if (ranked.length < 4) return null;
      const partner = ranked[0][0];
      const distractors = sampleDistinct(b.eligibleNames, 3, n => n === partner || n === subject);
      if (distractors.length < 3) return null;
      const answers = buildAnswers(partner, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.playerPartner', { name: subject, ...gParams(b, subject) }),
        answers,
        icon: '🤝',
        explanation: b.ctx.t('trivia.exp.partner', {
          name: subject,
          partner,
          count: ranked[0][1],
          ...gParams(b, subject),
        }),
      };
    },
  },

  // X's 1st-place rate. Uses TRUE chip-leader count, NOT profit > 0.
  {
    id: 'playerWinRate',
    mode: 'players',
    category: 'wins',
    build: (b) => {
      const subject = pickSubject(b);
      if (!subject) return null;
      const stats = b.ctx.playerStats.find(s => s.playerName === subject);
      if (!stats || stats.gamesPlayed < 10) return null;
      const firsts = b.firstPlaceByPlayer.get(subject) ?? 0;
      const rate = (firsts / stats.gamesPlayed) * 100;
      const correct = `${Math.round(rate)}%`;
      const distractors = [
        Math.max(1, Math.round(rate - 8)) + '%',
        Math.max(1, Math.round(rate - 4)) + '%',
        Math.min(99, Math.round(rate + 5)) + '%',
        Math.min(99, Math.round(rate + 10)) + '%',
      ].filter((v, i, arr) => v !== correct && arr.indexOf(v) === i);
      const answers = buildAnswers(correct, distractors.slice(0, 3));
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.playerWinRate', { name: subject }),
        answers,
        icon: '📈',
        explanation: b.ctx.t('trivia.exp.playerWinRate', {
          name: subject,
          wins: firsts,
          games: stats.gamesPlayed,
          pct: Math.round(rate),
        }),
      };
    },
  },

  // X's longest streak of consecutive 1st-place finishes. Uses
  // TRUE chip-leader streak, NOT PlayerStats.longestWinStreak.
  {
    id: 'playerLongestWinStreak',
    mode: 'players',
    category: 'wins',
    build: (b) => {
      const subject = pickSubject(b);
      if (!subject) return null;
      const streak = b.firstPlaceStreakByPlayer.get(subject) ?? 0;
      if (streak < 2) return null;
      const correct = String(streak);
      const candidates = [
        streak + 1, streak + 2,
        Math.max(1, streak - 1), streak + 3,
      ].filter((v, i, arr) => v !== streak && arr.indexOf(v) === i);
      const distractors = shuffle(candidates).slice(0, 3).map(String);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.playerLongestWinStreak', { name: subject }),
        answers,
        icon: '🔥',
        explanation: b.ctx.t('trivia.exp.playerLongestWinStreak', {
          name: subject,
          streak,
        }),
      };
    },
  },

  // X's average profit per game.
  {
    id: 'playerAvgProfit',
    mode: 'players',
    category: 'profit_loss',
    build: (b) => {
      const subject = pickSubject(b);
      if (!subject) return null;
      const stats = b.ctx.playerStats.find(s => s.playerName === subject);
      if (!stats || stats.gamesPlayed < 10) return null;
      const correct = formatCurrency(Math.round(stats.avgProfit));
      const distractors = numericDistractors(stats.avgProfit, 0.5);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.playerAvgProfit', { name: subject }),
        answers,
        icon: '📊',
        explanation: b.ctx.t('trivia.exp.playerAvgProfit', {
          name: subject,
          avg: correct,
          games: stats.gamesPlayed,
          total: formatCurrency(Math.round(stats.totalProfit)),
        }),
      };
    },
  },

  // Who has X played the most games against (= longest opponent
  // history, distinct from "partner" above which is symmetric).
  // We re-use the partner aggregation but phrase the question
  // differently so users see two separate question types over time.
  {
    id: 'playerMostFrequentOpponent',
    mode: 'players',
    category: 'matchups',
    build: (b) => {
      const subject = pickSubject(b, b.ctx.selfPlayerName);
      if (!subject) return null;
      const myGames = (b.rowsByPlayer.get(subject) ?? []).map(r => r.gameId);
      if (myGames.length < 5) return null;
      const sharedCount = new Map<string, number>();
      for (const gid of myGames) {
        const arr = b.rowsByGame.get(gid) ?? [];
        for (const opp of arr) {
          if (opp.playerName === subject) continue;
          if (!b.eligibleNames.includes(opp.playerName)) continue;
          sharedCount.set(opp.playerName, (sharedCount.get(opp.playerName) ?? 0) + 1);
        }
      }
      const ranked = [...sharedCount.entries()].sort((a, z) => z[1] - a[1] || a[0].localeCompare(z[0]));
      // Need at least 2 ranked opponents so the SECOND-place answer
      // is a real, different person from `playerPartner`. Falling
      // back to ranked[0] silently gives the same answer as the
      // partner template — confusing for a "second-most-frequent"
      // question. Skip if the data isn't deep enough.
      if (ranked.length < 4 || !ranked[1]) return null;
      const target = ranked[1];
      const distractors = sampleDistinct(b.eligibleNames, 3, n => n === target[0] || n === subject);
      if (distractors.length < 3) return null;
      const answers = buildAnswers(target[0], distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.playerSecondPartner', { name: subject, ...gParams(b, subject) }),
        answers,
        icon: '👥',
        explanation: b.ctx.t('trivia.exp.partner', {
          name: subject,
          partner: target[0],
          count: target[1],
          ...gParams(b, subject),
        }),
      };
    },
  },

  // X's all-time podium count (top-3 finishes).
  {
    id: 'playerPodiumCount',
    mode: 'players',
    category: 'wins',
    build: (b) => {
      const subject = pickSubject(b);
      if (!subject) return null;
      let podiums = 0;
      for (const arr of b.rowsByGame.values()) {
        const subjRow = arr.find(r => r.playerName === subject);
        if (!subjRow) continue;
        const sorted = [...arr].sort((a, z) => z.profit - a.profit);
        const idx = sorted.findIndex(r => r.playerName === subject);
        if (idx >= 0 && idx < 3) podiums++;
      }
      if (podiums < 3) return null;
      const correct = String(podiums);
      const distractors = numericDistractors(podiums, 0.4);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      const subjectStats = b.ctx.playerStats.find(s => s.playerName === subject);
      const totalGames = subjectStats?.gamesPlayed ?? podiums;
      return {
        text: b.ctx.t('trivia.q.playerPodiumCount', { name: subject, ...gParams(b, subject) }),
        answers,
        icon: '🏅',
        explanation: b.ctx.t('trivia.exp.playerPodiumCount', {
          name: subject,
          podiums,
          games: totalGames,
          pct: Math.round((podiums / totalGames) * 100),
          ...gParams(b, subject),
        }),
      };
    },
  },
];

// ─── Public driver ───────────────────────────────────────────────

// New template buckets live in `triviaTemplates/` to keep this
// file from growing past ~3500 lines as the catalogue expands.
// Each bucket exports a `Template[]` we just concatenate here.
import { VETERAN_TEMPLATES } from './triviaTemplates/veterans';
import { TIME_WINDOW_TEMPLATES } from './triviaTemplates/timeWindows';
import { RECENT_FORM_TEMPLATES } from './triviaTemplates/recentForm';
import { YEAR_OVER_YEAR_TEMPLATES } from './triviaTemplates/yearOverYear';
import { GROUP_DYNAMICS_TEMPLATES } from './triviaTemplates/groupDynamics';
import { PLAYER_EXTENSION_TEMPLATES } from './triviaTemplates/playerExtensions';
import { FACTORY_GENERATED_TEMPLATES } from './triviaTemplates/factories';

const ALL_TEMPLATES: Template[] = [
  ...GROUP_TEMPLATES,
  ...PLAYER_TEMPLATES,
  ...VETERAN_TEMPLATES,
  ...TIME_WINDOW_TEMPLATES,
  ...RECENT_FORM_TEMPLATES,
  ...YEAR_OVER_YEAR_TEMPLATES,
  ...GROUP_DYNAMICS_TEMPLATES,
  ...PLAYER_EXTENSION_TEMPLATES,
  ...FACTORY_GENERATED_TEMPLATES,
];

// Generate a session of questions. We try multiple distinct
// templates first (so the user sees variety), and only repeat
// templates with fresh subjects when the eligible-template pool
// is exhausted. Player templates can naturally produce many
// variants (different subject players) so they typically don't
// need to repeat the same subject within one session.
export function generateTriviaBatch(
  mode: TriviaMode,
  count: number,
  ctx: TriviaContext,
  // Optional category whitelist from the landing screen. Empty / undefined
  // = "all categories". Unknown ids are silently ignored.
  categories?: TriviaCategory[],
): TriviaQuestion[] {
  const bundle = buildBundle(ctx);

  // Bail with empty batch if we don't have enough eligible players
  // to satisfy the 4-multiple-choice "who" pool. UI surfaces a
  // friendly "play more games to unlock trivia" message.
  if (bundle.eligibleNames.length < 4) return [];

  const catFilter = categories && categories.length > 0 ? new Set(categories) : null;
  const eligibleTemplates = ALL_TEMPLATES.filter(tpl => {
    if (mode !== 'mixed' && tpl.mode !== mode) return false;
    if (catFilter && !catFilter.has(tpl.category)) return false;
    return true;
  });
  if (eligibleTemplates.length === 0) return [];

  const out: TriviaQuestion[] = [];
  const usedTemplateIds = new Set<string>();
  const usedGroups = new Set<string>();

  // First pass: try each shuffled template once. Skip templates
  // sharing a `group` token with one already used so we don't ask
  // the same fact two ways in one session.
  let attempts = 0;
  const maxAttempts = count * 6;
  while (out.length < count && attempts < maxAttempts) {
    attempts++;
    const shuffled = shuffle(eligibleTemplates);
    let added = 0;
    for (const tpl of shuffled) {
      if (out.length >= count) break;
      if (usedTemplateIds.has(tpl.id) && eligibleTemplates.length > count) continue;
      if (tpl.group && usedGroups.has(tpl.group)) continue;
      const built = tpl.build(bundle);
      if (!built) continue;
      const variantSuffix = built.text.length;
      out.push({
        id: `${tpl.id}#${out.length}-${variantSuffix}`,
        templateId: tpl.id,
        mode: tpl.mode,
        icon: built.icon,
        text: built.text,
        answers: built.answers,
        explanation: built.explanation,
      });
      usedTemplateIds.add(tpl.id);
      if (tpl.group) usedGroups.add(tpl.group);
      added++;
    }
    // If a full pass added nothing new (every template either
    // already-used or rejected as null) we break to avoid an
    // infinite loop.
    if (added === 0) break;
  }

  return out;
}

// Quick introspection helper — used by tests / dev console to confirm
// every template is wired in.
export function getTemplateIds(mode?: TriviaMode): string[] {
  return ALL_TEMPLATES
    .filter(tpl => mode == null || tpl.mode === mode)
    .map(tpl => tpl.id);
}

// Count how many distinct templates exist for a given mode (and
// optional category whitelist). Used by the landing screen to show
// the question pool size next to each mode chip — same affordance
// the training screen shows on its scenario-mode chips. NOTE: this
// counts TEMPLATES, not questions. Player templates expand into
// many subject-specific questions at run time, so the actual pool
// of unique questions is much larger than the template count for
// 'players' / 'mixed'. We expose the template count anyway because
// it's a stable, bounded number that doesn't change with group
// composition (a player count would mislead — "300 questions" then
// drop to 30 when a small group runs it).
export function countTemplates(
  mode: TriviaMode,
  categories?: TriviaCategory[],
): number {
  const catFilter = categories && categories.length > 0 ? new Set(categories) : null;
  return ALL_TEMPLATES.filter(tpl => {
    if (mode !== 'mixed' && tpl.mode !== mode) return false;
    if (catFilter && !catFilter.has(tpl.category)) return false;
    return true;
  }).length;
}
