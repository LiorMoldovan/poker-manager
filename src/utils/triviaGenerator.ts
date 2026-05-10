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
// Player eligibility: trivia targets the group's "core" — the
// regulars whose stats group members can plausibly recall. The
// floor is TIERED so the bar adapts to group maturity:
//   1. PRIMARY:  ≥20 games (the user's stated preference; this is
//                the right bar for an established group like
//                Poker Night where most regulars have 30+ games
//                and asking about a 7-game guest is unfair).
//   2. FALLBACK: ≥10 games (if the primary tier yields fewer
//                than 4 eligible players — needed for the "who"
//                multiple-choice to have 4 options).
//   3. FINAL:    ≥5 games (if even ≥10 yields fewer than 4 — keeps
//                trivia available for younger groups during the
//                ramp-up phase).
// `buildBundle` walks these tiers and picks the highest one that
// produces ≥ 4 eligible players. Reflected in `eligibilityFloor`
// on the bundle so templates that want to surface the threshold
// in their explanations can read it.

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

// Trivia mode — drives both the template pool AND the subject scope:
//
//   'group'   — broad: about everyone in the group. Pulls from BOTH
//               group-level templates (top profit all-time, biggest
//               win all-time) AND player-level templates with a
//               RANDOM subject (excluding self — asking the user
//               about themselves is too easy in this mode).
//
//   'players' — personal: always about the logged-in player. Pulls
//               from player-level templates only, with the subject
//               forced to selfPlayerName. Renamed from "random
//               player" semantics on 2026-05-10 per user request.
//
//   'mixed'   — coin-flip per question: 50% broad (group templates
//               or random-subject player templates), 50% personal
//               (player templates with self subject). Best of both
//               worlds; default mode on the landing screen.
//
// Templates themselves are tagged 'group' or 'players' for their
// NATURAL pool. The driver (`generateTriviaBatch`) decides which
// templates participate based on the mode + per-question coin flip
// in mixed.
export type TriviaMode = 'group' | 'players' | 'mixed';

// Subject scope for player-mode templates. Set per-template-call by
// the driver so 'mixed' mode can flip-flop within one batch.
//   'random' — pick a non-self eligible player as subject
//   'self'   — force selfPlayerName as subject (template returns
//              null if user isn't eligible / not logged in)
export type SubjectScope = 'random' | 'self';

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
// Distractors are placed at deliberately different magnitudes around
// `correct` (one well below, two well above), each with small jitter.
// Goal: a player who has the right *ballpark estimate* should land
// on `correct` — not on the nearest neighbour. So the closest
// distractor on either side is far enough that anyone estimating
// within ~±40% of correct picks it correctly.
//
// `spread` is the dominant outer multiplier. With `spread = 0.85`
// (default), distractors land at roughly:
//   - low : ~0.15× correct (one third or less — clearly "much less")
//   - mid : ~1.85× correct (almost double — clearly "more")
//   - high: ~2.53× correct (about 2.5× — clearly "way more")
// Closest above (1.85×) means anyone estimating ≤ ~1.4× correct
// picks the right answer. Closest below (0.15×) means anyone
// estimating ≥ ~0.6× correct picks the right answer. So a
// ±40% rough estimate wins the question, which is the gameplay
// loop we want for hard "guess the number" templates.
//
// Default bumped 0.55 → 0.85 in v5.52.x after player feedback that
// the previous 0.55 spread (low ~0.45×, mid ~1.27×, high ~1.55×)
// still penalised correct-but-imprecise estimators. Per-call sites
// can pass a smaller spread when the correct value is well-known
// (e.g. "who won that night, by how many chips" — players remember
// the round number, so distractors should sit closer).
//
// Avoids negatives when correct is positive (and vice versa), and
// avoids producing duplicates of `correct` after rounding.
export function numericDistractors(correct: number, spread = 0.85): string[] {
  const sign = correct >= 0 ? 1 : -1;
  const m = Math.abs(correct);
  if (m === 0) {
    // Fallback for the rare zero case — return distractors offset
    // by ±spread with a fixed magnitude of 1.
    return [-1, 1, 2].map(n => formatCurrency(n));
  }
  // Three deliberately-spread target ratios around 1.0. We want
  // the *gap* between correct (1.0) and the nearest distractor on
  // each side to be ≥ ~0.7× — that is the "rough estimate wins"
  // sweet spot. Hence:
  //   - low : 1 - spread          (e.g. 0.15× when spread=0.85)
  //   - mid : 1 + spread          (e.g. 1.85×)
  //   - high: 1 + spread * 1.85   (e.g. 2.57×)
  // Small jitter (±10%) so two questions with the same correct
  // value don't produce identical distractor sets.
  const jitter = () => 0.9 + Math.random() * 0.2; // 0.9 - 1.1
  const targets = [
    Math.max(0.1, 1 - spread),
    1 + spread,
    1 + spread * 1.85,
  ];
  const seen = new Set<number>([correct]);
  const out: number[] = [];
  for (const t of targets) {
    // Try jittered target first; if it collapses onto an existing
    // value after niceRound, retry up to 5 times before falling
    // back to the un-jittered ratio.
    let placed = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = niceRound(t * jitter() * m * sign);
      if (seen.has(candidate)) continue;
      if (sign > 0 && candidate <= 0) continue;
      if (sign < 0 && candidate >= 0) continue;
      seen.add(candidate);
      out.push(candidate);
      placed = true;
      break;
    }
    if (!placed) {
      const fallback = niceRound(t * m * sign);
      if (!seen.has(fallback) && (sign > 0 ? fallback > 0 : fallback < 0)) {
        seen.add(fallback);
        out.push(fallback);
      }
    }
  }
  // If we somehow ended up with fewer than 3 (e.g. niceRound
  // collapsed everything for tiny correct values), fill the gap
  // with broadly-offset values so buildAnswers still has 3 distinct
  // distractors to work with.
  let pad = 1;
  while (out.length < 3 && pad < 8) {
    const candidate = niceRound(m * sign * (1 + pad * 0.4));
    if (!seen.has(candidate) && (sign > 0 ? candidate > 0 : candidate < 0)) {
      seen.add(candidate);
      out.push(candidate);
    }
    pad++;
  }
  return out.slice(0, 3).map(n => formatCurrency(n));
}

// Build a 4-option answer set where each option is a numeric RANGE
// (e.g. "פחות מ-50", "50–99", "100–149", "150 ומעלה") and exactly
// one range contains `correct`. Use this for templates where the
// exact number is borderline-impossible to know but a ballpark
// estimate is reasonable — lifetime profits, total game counts,
// total podium counts, etc. Players prefer ranges to exact-number
// guessing when they don't have the data memorized; the gameplay
// loop "do I think it's a lot or a little?" stays engaging where
// "guess within ±35% of 12,400" was just frustrating.
//
// Returns null when:
//   - correct is non-finite or < 6 (ranges of width ≤2 are silly)
//   - construction can't produce 4 disjoint buckets covering correct
//     (extremely rare; caller should fall back to numericDistractors)
//
// `format` shapes each boundary (use formatCurrency for money,
// String for raw counts). `t` is the i18n function — uses
// trivia.bucket.{lessThan, range, atLeast} keys for Hebrew/English.
//
// IMPLEMENTATION NOTES:
// - Bucket size ≈ 28% of magnitude, nice-rounded to a multiple of
//   5/10/25/100/500 depending on scale, so boundaries read clean.
// - Correct is placed in bucket index 1 or 2 (the middle pair),
//   never the edges. Putting correct at "less than X" or "X+" lets
//   players eliminate the question with one guess.
// - For positive correct, the lowest boundary (n0) is clamped to 0
//   — a "less than -50 games played" bucket would be absurd.
// - Boundaries are inclusive on the lower end and exclusive on the
//   upper end of "between" buckets, but the displayed text uses
//   inclusive range "{lo}–{hi-1}" for visual cleanliness ("50–99"
//   not "50–100").
export function bucketedNumericAnswers(
  correct: number,
  format: (n: number) => string,
  t: TriviaContext['t'],
): TriviaAnswer[] | null {
  if (!Number.isFinite(correct) || correct < 6) return null;
  const m = correct; // bucketing semantics here are only sensible for non-negative correct

  // Pick a bucket size from a "visually nice" ladder so boundaries
  // read as 50/100/500/1000/etc. instead of 175/225/3700. Target
  // bucket size ≈ 55% of correct, so each bucket spans roughly
  // half-to-the-full magnitude of the correct value — wide enough
  // that anyone with a ±40% estimate of correct lands inside the
  // right bucket. (Was 28% before v5.52.x; players consistently
  // missed by one bucket because the previous narrow buckets
  // demanded near-exact recall, which defeats the point of a
  // range answer.)
  const NICE_SIZES = [3, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
  const target = m * 0.55;
  // Pick the largest nice size that's ≤ 2× the target — this gives
  // nice round boundaries while keeping bucket count near 4 spanning
  // the answer. Falls back to the smallest size if even that's too
  // big (only for correct in [6, 9] which uses bucket=3 or 5).
  let bucket = NICE_SIZES[0];
  for (const s of NICE_SIZES) {
    if (s <= target * 2) bucket = s;
  }
  if (bucket <= 0) return null;

  // Place correct in bucket 1 or 2 (middle of the four).
  const correctIdx = 1 + Math.floor(Math.random() * 2);
  // n0 = lower boundary of bucket 0. We want correct ∈ bucket
  // `correctIdx`, so:
  //   n0 + correctIdx * bucket  ≤  correct  <  n0 + (correctIdx+1) * bucket
  // Pick n0 = floor(correct / bucket) * bucket - correctIdx * bucket.
  const lowerOfCorrectBucket = Math.floor(correct / bucket) * bucket;
  let n0 = lowerOfCorrectBucket - correctIdx * bucket;
  if (n0 < 0) n0 = 0;

  // Determine where correct actually lands now (might have shifted
  // up if we clamped n0 to 0 above).
  let finalIdx = Math.floor((correct - n0) / bucket);
  if (finalIdx > 3) finalIdx = 3;
  if (finalIdx < 0) finalIdx = 0;

  const answers: TriviaAnswer[] = [];
  for (let i = 0; i < 4; i++) {
    const lo = n0 + i * bucket;
    const hi = lo + bucket; // exclusive upper bound of THIS bucket
    let text: string;
    if (i === 0) {
      // "less than (lo+bucket)" — anything < hi belongs here.
      text = t('trivia.bucket.lessThan', { value: format(hi) });
    } else if (i === 3) {
      // "{lo}+" / "{lo} ומעלה" — correct ≥ lo belongs here.
      text = t('trivia.bucket.atLeast', { value: format(lo) });
    } else {
      // "{lo}–{hi-1}" inclusive both ends.
      text = t('trivia.bucket.range', {
        lo: format(lo),
        hi: format(hi - 1),
      });
    }
    answers.push({ text, isCorrect: i === finalIdx });
  }
  // Sanity: exactly one correct.
  if (answers.filter(a => a.isCorrect).length !== 1) return null;
  return shuffle(answers);
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
  // Players who pass the eligibility floor (see `eligibilityFloor`
  // below). Subject pool for player-mode questions AND distractor
  // pool for any "who" question. Capped to the highest tier that
  // produces ≥4 names — see the doc comment at the top of this
  // file for the tier ladder.
  eligibleNames: string[];
  // The actual game-count floor that was applied to produce
  // `eligibleNames`. Lets templates compose explanation text like
  // "asked among players with X+ games". One of: 20, 10, 5.
  eligibilityFloor: number;
  // Subject scope for the CURRENT template invocation. Mutated by
  // `generateTriviaBatch` per question — `pickSubject` reads this
  // to decide whether to return self or a random non-self name.
  // Default 'random' so any template that runs outside the driver
  // (e.g. unit tests) keeps its pre-2026-05-10 behavior.
  subjectScope: SubjectScope;
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
  // Tiered eligibility — pick the highest floor that still leaves
  // us at least 4 eligible players (the minimum for a "who"
  // multiple-choice). Matures with the group automatically:
  // young groups get the loose ≥5 floor, established groups
  // (Poker Night) get the tight ≥20 floor that filters out
  // one-off guests so questions feel fair.
  const TIER_FLOORS = [20, 10, 5] as const;
  const MIN_FOR_FOUR_OPTION_QUESTION = 4;
  let eligibilityFloor: number = 5;
  let eligibleNames: string[] = [];
  for (const floor of TIER_FLOORS) {
    const candidates = playerStats
      .filter(s => s.gamesPlayed >= floor)
      .map(s => s.playerName);
    if (candidates.length >= MIN_FOR_FOUR_OPTION_QUESTION) {
      eligibilityFloor = floor;
      eligibleNames = candidates;
      break;
    }
    // Remember the loosest tier we actually saw (used if NONE
    // of the tiers produced 4+ — caller will return empty batch
    // anyway via `eligibleNames.length < 4` in generateTriviaBatch,
    // but at least we report a sensible floor for diagnostics).
    eligibilityFloor = floor;
    eligibleNames = candidates;
  }
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
    eligibilityFloor,
    subjectScope: 'random',
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

  // Total games played by the group all-time. Uses bucketed ranges
  // because exact game counts are not memorable — but fall back to
  // tight numeric distractors if the bucketing helper rejects.
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
      const bucketed = bucketedNumericAnswers(total, String, b.ctx.t);
      const answers = bucketed ?? (() => {
        const distractors = numericDistractors(total);
        return buildAnswers(correct, distractors);
      })();
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

// Pick the subject of a player-mode question. Behavior depends on
// the bundle's current `subjectScope`:
//
//   'self'   — return selfPlayerName if the logged-in user is in
//              the eligible pool. Otherwise return null (the caller
//              skips the template). Used by the 'players' (personal)
//              mode and by the personal half of 'mixed' mode.
//
//   'random' — pick a non-self eligible player. Same behavior as
//              before subjectScope existed: asking the user about
//              themselves is too easy in this scope. Used by 'group'
//              mode and by the broad half of 'mixed' mode.
//
// `exclude` is honored only in 'random' scope (in 'self' the answer
// is fixed). Most templates pass selfPlayerName as the default, but
// some (matchup templates) pass it explicitly to be obvious.
export function pickSubject(
  b: BuildBundle,
  exclude: string | null | undefined = b.ctx.selfPlayerName,
): string | null {
  if (b.subjectScope === 'self') {
    const self = b.ctx.selfPlayerName;
    if (self && b.eligibleNames.includes(self)) return self;
    return null;
  }
  const pool = exclude
    ? b.eligibleNames.filter(n => n !== exclude)
    : b.eligibleNames;
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

const PLAYER_TEMPLATES: Template[] = [
  // Numeric: how many games has X played? Uses bucketed ranges
  // ("between 30 and 49 / 50 and up") because exact game counts
  // are borderline-impossible to remember even for regulars.
  {
    id: 'playerGameCount',
    mode: 'players',
    category: 'history',
    build: (b) => {
      const subject = pickSubject(b);
      if (!subject) return null;
      const stats = b.ctx.playerStats.find(s => s.playerName === subject);
      if (!stats) return null;
      // Prefer bucketed answers; fall back to spread numeric distractors
      // for tiny counts (< 6) where buckets would be silly.
      const bucketed = bucketedNumericAnswers(stats.gamesPlayed, String, b.ctx.t);
      const answers = bucketed ?? (() => {
        const distractors = numericDistractors(stats.gamesPlayed);
        return buildAnswers(String(stats.gamesPlayed), distractors);
      })();
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

  // Numeric: lifetime profit of X. Uses bucketed ranges
  // for positive lifetime totals (where the magnitude is in the
  // hundreds-to-thousands, which nobody tracks exactly), falls back
  // to spread numeric distractors for negative totals (losses) since
  // bucketing is positive-only.
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
      const bucketed = stats.totalProfit > 0
        ? bucketedNumericAnswers(Math.round(stats.totalProfit), formatCurrency, b.ctx.t)
        : null;
      const answers = bucketed ?? (() => {
        const distractors = numericDistractors(stats.totalProfit);
        return buildAnswers(correct, distractors);
      })();
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
      // Bucketed for ≥6 wins (where exact recall is implausible),
      // exact-with-spread for small counts where the user might
      // genuinely remember.
      const bucketed = firsts >= 6 ? bucketedNumericAnswers(firsts, String, b.ctx.t) : null;
      const answers = bucketed ?? (() => {
        const distractors = numericDistractors(firsts);
        return buildAnswers(correct, distractors);
      })();
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
      const distractors = numericDistractors(stats.avgProfit);
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
      // Bucketed for ≥6, exact-with-spread for the small handful
      // (where users genuinely might know "X has 4 podiums").
      const bucketed = podiums >= 6 ? bucketedNumericAnswers(podiums, String, b.ctx.t) : null;
      const answers = bucketed ?? (() => {
        const distractors = numericDistractors(podiums);
        return buildAnswers(correct, distractors);
      })();
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

// Generate a session of questions. Mode-aware template + scope
// selection:
//   'group'   → eligible = group + players templates, scope='random'
//                (every question is about the group as a whole or a
//                non-self regular). Mirrors the user's "broad,
//                anything goes" mental model.
//   'players' → eligible = players templates only, scope='self'
//                (every question is personalised to the logged-in
//                user). Skips silently when the user isn't linked to
//                an eligible player — UI surfaces "play more games
//                to unlock self-trivia" via the empty-batch path.
//   'mixed'   → eligible = group + players, scope flips per-question
//                via a fair coin. The COIN result also constrains
//                the template pick: when scope='self' for the
//                question, only player templates are considered
//                (group templates don't honor scope and would just
//                produce a broad question regardless). The bundle's
//                `subjectScope` is mutated each iteration so
//                `pickSubject` reads the right value.
//
// We try distinct templates first (so the user sees variety) and
// only repeat templates with fresh subjects when the eligible pool
// is exhausted.
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

  // For 'players' mode we additionally require the user to be in
  // the eligible pool — otherwise every template would return null
  // and we'd produce an empty batch with no useful explanation.
  // Caller (TriviaGameScreen) shows a generic empty-state today;
  // refining the message to "play more yourself" is a follow-up.
  if (mode === 'players') {
    const self = ctx.selfPlayerName;
    if (!self || !bundle.eligibleNames.includes(self)) return [];
  }

  const catFilter = categories && categories.length > 0 ? new Set(categories) : null;

  // Pre-compute the candidate template pools per scope so we don't
  // re-filter ALL_TEMPLATES inside the per-question loop.
  const broadPool = ALL_TEMPLATES.filter(tpl => {
    // Broad scope = either a group template (group-wide facts,
    // doesn't care about scope) OR a player template that will
    // ask about a random non-self subject.
    if (tpl.mode !== 'group' && tpl.mode !== 'players') return false;
    if (catFilter && !catFilter.has(tpl.category)) return false;
    return true;
  });
  const selfPool = ALL_TEMPLATES.filter(tpl => {
    if (tpl.mode !== 'players') return false;
    if (catFilter && !catFilter.has(tpl.category)) return false;
    return true;
  });

  // Decide eligible-template + scope choice per question. For
  // 'group' and 'players' modes this is constant; for 'mixed' we
  // flip a coin each iteration.
  const pickScopeAndPool = (): { scope: SubjectScope; pool: Template[] } => {
    if (mode === 'group') return { scope: 'random', pool: broadPool };
    if (mode === 'players') return { scope: 'self', pool: selfPool };
    // mixed
    return Math.random() < 0.5
      ? { scope: 'self', pool: selfPool }
      : { scope: 'random', pool: broadPool };
  };

  const out: TriviaQuestion[] = [];
  const usedTemplateIds = new Set<string>();
  const usedGroups = new Set<string>();

  // Per-question loop. We don't do a "full pass over all templates
  // per round" any more because the scope-per-question model means
  // each iteration picks from a (possibly different) pool. The
  // attempts cap (count * 8) prevents infinite loops when every
  // pool entry returns null (e.g. self has no podiums yet).
  let attempts = 0;
  const maxAttempts = count * 8;
  while (out.length < count && attempts < maxAttempts) {
    attempts++;
    const { scope, pool } = pickScopeAndPool();
    if (pool.length === 0) {
      // Pool empty (e.g. self mode but the category filter excluded
      // everything) — break out, caller will see fewer questions
      // than requested rather than an infinite loop.
      if (mode !== 'mixed') break;
      continue;
    }
    bundle.subjectScope = scope;
    // Shuffle once per iteration; stop on the first template that
    // produces a non-null question and isn't already used (unless
    // we've exhausted the pool).
    const shuffled = shuffle(pool);
    let placed = false;
    for (const tpl of shuffled) {
      if (usedTemplateIds.has(tpl.id) && pool.length > count) continue;
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
      placed = true;
      break;
    }
    // If we couldn't place anything in this iteration AND we're not
    // in mixed mode, allow used templates to repeat by clearing the
    // used set — gives us more questions when the pool is small.
    if (!placed && mode !== 'mixed' && usedTemplateIds.size === pool.length) {
      usedTemplateIds.clear();
    }
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

// Count how many distinct templates a mode draws from. Used by
// the landing screen to show the pool size next to each mode chip.
// Reflects the post-2026-05-10 mode semantics:
//   'group'   → group templates + player templates (broad pool)
//   'players' → player templates only (self-mode)
//   'mixed'   → same as 'group' (the broadest superset; mixed flips
//                scope per question but the TEMPLATE pool is the
//                broad one). Showing the broad count is honest:
//                "this many distinct questions can be asked".
export function countTemplates(
  mode: TriviaMode,
  categories?: TriviaCategory[],
): number {
  const catFilter = categories && categories.length > 0 ? new Set(categories) : null;
  return ALL_TEMPLATES.filter(tpl => {
    if (catFilter && !catFilter.has(tpl.category)) return false;
    if (mode === 'players') return tpl.mode === 'players';
    return tpl.mode === 'group' || tpl.mode === 'players';
  }).length;
}
