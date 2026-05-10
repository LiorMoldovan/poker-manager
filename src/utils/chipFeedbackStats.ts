// chip-count feedback dashboard aggregation
//
// Pure helpers that turn raw `chip_count_feedback` rows (as returned
// from Supabase) into the shape the SettingsScreen dashboard renders.
// Lives in `utils/` (not inside SettingsScreen) so it's:
//   1. Trivially unit-testable from a Node script if we ever want to.
//   2. Reusable when Phase 2 adds a "tune now" button — the tuner
//      LLM is going to consume the same aggregated stats as input.
//
// IMPORTANT: nothing in this file talks to Supabase directly. Loading
// is the SettingsScreen's job; aggregation is this file's job. Keep
// the boundary clean — it's the only thing that lets us swap data
// sources later (e.g. local-cached vs live MCP) without rewriting
// the math.

/** Minimum samples (per group) needed before the "tune now" button
 *  unlocks. 10 is the smallest number where SQL pattern queries
 *  stop being pure noise — see Architecture 2 discussion in chat
 *  with Lior on 2026-05-10 (v5.55+). */
export const TUNE_THRESHOLD_SAMPLES = 10;

/** How many of the most-recent saves count as "recent" when computing
 *  the trend signal ("are we getting better lately?"). 10 matches the
 *  TUNE_THRESHOLD_SAMPLES so each tuning interval has its own
 *  before/after window. */
export const RECENT_WINDOW = 10;

/** Shape of a single per-stack record inside `chip_count_feedback.stacks`.
 *  Field names match the camelCase keys written by `submitChipCountFeedback`
 *  — Postgres stores them inside a JSONB column verbatim, so this is
 *  also the shape we read back. */
export interface RawFeedbackStack {
  chipId: string;
  color: string;
  position?: number;
  value?: number;
  aiCount: number;
  realCount: number;
  delta: number;
  wasCorrect: boolean;
  aiConfidence?: number;
  aiColorMatch?: boolean;
  aiNeedsRecount?: boolean;
  aiTopColorHex?: string;
  aiRawCounts?: number[];
}

/** A row from `chip_count_feedback` after PostgREST returns it. snake_case
 *  on the column names, camelCase inside the JSONB stacks (because we
 *  wrote it that way). */
export interface RawFeedbackRow {
  id: string;
  created_at: string;
  player_name: string | null;
  game_id: string | null;
  player_id: string | null;
  model_used: string;
  overall_confidence: number;
  shots_used: number;
  total_stacks: number;
  correct_stacks: number;
  total_chip_delta: number;
  total_abs_delta: number;
  expected_total_value: number | null;
  rebuys: number | null;
  chips_per_rebuy: number | null;
  stacks: RawFeedbackStack[];
}

/** Per-color slice of accuracy stats. Sorted descending by `samples`
 *  so colors that get used most appear first (irrelevant colors with
 *  1-2 samples are hidden behind a "low data" flag). */
export interface PerColorStats {
  color: string;
  samples: number;
  /** Average signed delta (real - ai). Negative = AI undercounting
   *  this color, positive = AI overcounting. Closer to 0 = better. */
  avgSignedDelta: number;
  /** Average absolute error. Always >= 0. Closer to 0 = better. */
  avgAbsDelta: number;
  /** Fraction of stacks of this color where `wasCorrect`. 0..1. */
  pctCorrect: number;
}

/** One point on the trend line. `idx` is the zero-based index in
 *  chronological order (oldest = 0). `absDelta` is that session's
 *  total absolute error. We don't smooth here — the chart layer
 *  applies a rolling window if needed. */
export interface TrendPoint {
  idx: number;
  date: string;
  absDelta: number;
}

/** Final aggregated stats consumed by the dashboard. Every field is
 *  pre-computed so the React render is dumb (just plug values into
 *  text / chart). Empty-state is encoded by `totalSamples === 0`. */
export interface FeedbackStats {
  totalSamples: number;
  totalStacksAll: number;
  pctPerfectStacks: number; // 0-100
  /** Average chips off per session, signed. Negative = systematic
   *  undercount, positive = systematic overcount, ~0 = unbiased. */
  avgSignedBias: number;
  /** Average absolute chips off per session. Sole "how good is it"
   *  number — closer to 0 = better. */
  avgAbsError: number;
  avgConfidence: number; // 0-100
  perColor: PerColorStats[];
  trend: TrendPoint[];
  /** Mean abs error over the last RECENT_WINDOW saves. Null if
   *  fewer than RECENT_WINDOW samples. */
  recentAvgAbsDelta: number | null;
  /** Mean abs error over the saves BEFORE the recent window
   *  (idx -2*RECENT_WINDOW .. -RECENT_WINDOW). Null if not enough
   *  history. Used together with `recentAvgAbsDelta` to compute the
   *  improvement-trend pill (green if recent < earlier, red if
   *  recent > earlier). */
  earlierAvgAbsDelta: number | null;
  /** Number of feedback rows saved AFTER `lastTuningCreatedAt`
   *  (or all rows if no tuning has happened yet). The "tune now"
   *  button unlocks when this hits TUNE_THRESHOLD_SAMPLES. */
  rowsSinceLastTuning: number;
}

/** Pure aggregator. Always returns a fully-populated FeedbackStats —
 *  no nulls at the top level, just sentinel `0` / `[]` for the
 *  empty-data case so the render doesn't need null-guards everywhere.
 *  Rows can be in any order; we sort here. */
export function aggregateFeedback(
  rows: RawFeedbackRow[],
  lastTuningCreatedAt: string | null,
): FeedbackStats {
  if (rows.length === 0) {
    return {
      totalSamples: 0,
      totalStacksAll: 0,
      pctPerfectStacks: 0,
      avgSignedBias: 0,
      avgAbsError: 0,
      avgConfidence: 0,
      perColor: [],
      trend: [],
      recentAvgAbsDelta: null,
      earlierAvgAbsDelta: null,
      rowsSinceLastTuning: 0,
    };
  }

  const sorted = [...rows].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );

  let totalStacksAll = 0;
  let totalCorrectStacks = 0;
  let sumSignedBias = 0;
  let sumAbsError = 0;
  let sumConfidence = 0;

  // Per-color accumulator: color -> { count, sumSigned, sumAbs, correctCount }
  const colorBuckets = new Map<
    string,
    { count: number; sumSigned: number; sumAbs: number; correct: number }
  >();

  const trend: TrendPoint[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i];
    totalStacksAll += row.total_stacks;
    totalCorrectStacks += row.correct_stacks;
    sumSignedBias += row.total_chip_delta;
    sumAbsError += row.total_abs_delta;
    sumConfidence += row.overall_confidence;

    trend.push({
      idx: i,
      date: row.created_at,
      absDelta: row.total_abs_delta,
    });

    for (const stack of row.stacks ?? []) {
      const key = (stack.color || 'unknown').toLowerCase();
      const bucket = colorBuckets.get(key) ?? {
        count: 0,
        sumSigned: 0,
        sumAbs: 0,
        correct: 0,
      };
      bucket.count += 1;
      bucket.sumSigned += stack.delta;
      bucket.sumAbs += Math.abs(stack.delta);
      if (stack.wasCorrect) bucket.correct += 1;
      colorBuckets.set(key, bucket);
    }
  }

  // Build perColor sorted by sample count desc (so the colors the
  // user actually plays with show first). Colors are free-form
  // strings (`white` / `red` / `purple` / whatever the group
  // configured), so we just iterate over what's in the data
  // — no canonical list to filter against.
  const perColor: PerColorStats[] = [];
  for (const [color, bucket] of colorBuckets.entries()) {
    if (bucket.count === 0) continue;
    perColor.push({
      color,
      samples: bucket.count,
      avgSignedDelta: bucket.sumSigned / bucket.count,
      avgAbsDelta: bucket.sumAbs / bucket.count,
      pctCorrect: bucket.correct / bucket.count,
    });
  }
  perColor.sort((a, b) => b.samples - a.samples);

  // Recent-vs-earlier window split. Only meaningful once we have
  // enough history for both windows to be non-empty.
  const n = sorted.length;
  const recentSlice = sorted.slice(Math.max(0, n - RECENT_WINDOW));
  const earlierSlice = sorted.slice(
    Math.max(0, n - 2 * RECENT_WINDOW),
    Math.max(0, n - RECENT_WINDOW),
  );
  const recentAvgAbsDelta =
    recentSlice.length >= RECENT_WINDOW
      ? recentSlice.reduce((s, r) => s + r.total_abs_delta, 0) /
        recentSlice.length
      : null;
  const earlierAvgAbsDelta =
    earlierSlice.length >= RECENT_WINDOW
      ? earlierSlice.reduce((s, r) => s + r.total_abs_delta, 0) /
        earlierSlice.length
      : null;

  // Rows since last tuning. Used to gate the "tune now" button.
  // No tuning ever => count all rows.
  const rowsSinceLastTuning = lastTuningCreatedAt
    ? sorted.filter((r) => r.created_at > lastTuningCreatedAt).length
    : sorted.length;

  return {
    totalSamples: sorted.length,
    totalStacksAll,
    pctPerfectStacks:
      totalStacksAll === 0
        ? 0
        : (totalCorrectStacks / totalStacksAll) * 100,
    avgSignedBias: sumSignedBias / sorted.length,
    avgAbsError: sumAbsError / sorted.length,
    avgConfidence: sumConfidence / sorted.length,
    perColor,
    trend,
    recentAvgAbsDelta,
    earlierAvgAbsDelta,
    rowsSinceLastTuning,
  };
}

/** Convenience: a Hebrew-readable trend label suitable for a small
 *  pill UI. `null` when we don't have enough data to call a trend
 *  (renders nothing in that case). */
export function trendVerdict(stats: FeedbackStats): {
  direction: 'better' | 'worse' | 'flat';
  deltaAbs: number;
} | null {
  if (
    stats.recentAvgAbsDelta === null ||
    stats.earlierAvgAbsDelta === null
  ) {
    return null;
  }
  const diff = stats.recentAvgAbsDelta - stats.earlierAvgAbsDelta;
  // Treat <0.3 chips as flat — anything tighter is noise at this
  // sample size. Threshold can be revisited once we have hundreds
  // of rows and see the actual session-to-session variance.
  if (Math.abs(diff) < 0.3) return { direction: 'flat', deltaAbs: diff };
  return {
    direction: diff < 0 ? 'better' : 'worse',
    deltaAbs: diff,
  };
}
