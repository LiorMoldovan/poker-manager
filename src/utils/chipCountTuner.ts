// chip-count tuner orchestration
//
// Glue layer between the dashboard "Tune Now" button and the LLM
// tuner + Supabase override table. Lives in its own module so:
//   1. The dashboard handler stays a one-liner.
//   2. The Phase 3 auto-rollback safety net (next version) can reuse
//      `revertToDefault` directly.
//   3. We have one place to add baseline-tracking metadata when we
//      grow the safety net.
//
// IMPORTANT: every write goes through `chip_count_tuning_overrides`
// as an INSERT. We never UPDATE or DELETE — that table's whole
// design is "latest row wins, full history kept" (see
// supabase/070-chip-count-tuning.sql comments). A "revert" is an
// insert with `prompt_strategy = NULL`. A "tune" is an insert with
// a non-null strategy. RLS on the table restricts INSERT to the
// group owner (or super admin) — we trust that gate, no need to
// re-check ownership client-side.

import { supabase } from '../database/supabaseClient';
import { getGroupId } from '../database/supabaseCache';
import {
  tuneChipCountStrategy,
  DEFAULT_CHIP_COUNT_STRATEGY,
  type ChipTuningInput,
} from './geminiAI';

export type TuneAndApplyResult =
  | {
      ok: true;
      description: string;
      modelUsed: string;
      /** The full new strategy block that just got persisted.
       *  Surface to the UI in case we want to show a "preview"
       *  side panel later. */
      strategy: string;
    }
  | { ok: false; error: string };

/** End-to-end "Tune Now" flow:
 *   1. Resolve group + user.
 *   2. Read the current active strategy (override row OR hardcoded
 *      default — same logic as `loadActiveChipCountStrategy` in
 *      geminiAI.ts but inlined here so the tuner gets the actual
 *      current text to iterate on, not the default).
 *   3. Run `tuneChipCountStrategy` to get a proposed new strategy.
 *   4. Persist the proposal as a new row in
 *      `chip_count_tuning_overrides` with baseline-accuracy
 *      metadata (consumed by the Phase 3 auto-rollback).
 *
 *  Stats input must already be pre-aggregated by the caller
 *  (`aggregateFeedback` in chipFeedbackStats.ts → re-shape into
 *  ChipTuningInput). We don't re-aggregate here because the
 *  dashboard already has the data in hand; making this function
 *  re-load + re-aggregate would mean a redundant 200-row fetch. */
export async function tuneAndApply(
  stats: ChipTuningInput,
): Promise<TuneAndApplyResult> {
  const gid = getGroupId();
  if (!gid) return { ok: false, error: 'No group context' };

  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) {
    return { ok: false, error: userErr?.message || 'Not authenticated' };
  }

  // Read the current active strategy. We need the actual text the
  // chip-counter is using right now (default OR latest override)
  // so the tuner LLM can iterate on it instead of starting from
  // scratch every time.
  const { data: latest, error: loadErr } = await supabase
    .from('chip_count_tuning_overrides')
    .select('prompt_strategy')
    .eq('group_id', gid)
    .order('created_at', { ascending: false })
    .limit(1);
  if (loadErr) return { ok: false, error: loadErr.message };
  const latestRow = (latest && latest.length > 0)
    ? (latest[0] as { prompt_strategy: string | null })
    : null;
  const currentStrategy =
    latestRow && latestRow.prompt_strategy && latestRow.prompt_strategy.trim().length > 0
      ? latestRow.prompt_strategy
      : DEFAULT_CHIP_COUNT_STRATEGY;

  const tuned = await tuneChipCountStrategy({ stats, currentStrategy });
  if (!tuned.ok) return { ok: false, error: tuned.error };

  // Persist. baseline_avg_abs_delta + baseline_sample_count let
  // the future auto-rollback ask "is the new strategy doing
  // better than this number?" once enough new samples accrue.
  const { error: insErr } = await supabase
    .from('chip_count_tuning_overrides')
    .insert({
      group_id: gid,
      created_by: userData.user.id,
      prompt_strategy: tuned.strategy,
      description: tuned.description,
      baseline_avg_abs_delta: stats.avgAbsError,
      baseline_sample_count: stats.totalSamples,
      model_used_for_tuning: tuned.modelUsed,
    });
  if (insErr) return { ok: false, error: insErr.message };

  return {
    ok: true,
    strategy: tuned.strategy,
    description: tuned.description,
    modelUsed: tuned.modelUsed,
  };
}

/** Number of post-tuning feedback samples that need to accumulate
 *  before the auto-rollback safety net evaluates whether the tuning
 *  helped or hurt. 5 is the smallest number where comparing the
 *  post-tuning avg to the baseline starts being meaningful — fewer
 *  than that is pure noise (one bad photo could swing it). */
export const AUTO_ROLLBACK_SAMPLES = 5;

/** Auto-rollback safety net (Phase 3 of the in-app tuning loop, v5.57+).
 *
 *  Runs at every dashboard load. Looks at the LATEST tuning row for
 *  the group; if it's a real tuning (not a manual revert) AND has a
 *  baseline recorded AND has at least AUTO_ROLLBACK_SAMPLES feedback
 *  rows that came in AFTER it, computes the avg total_abs_delta of
 *  those post-tuning rows. If that's WORSE than the baseline that
 *  was captured at apply-time, automatically inserts a revert row
 *  and returns the rollback reason for the UI to surface as a
 *  banner.
 *
 *  Idempotent: a second call after a rollback already happened
 *  returns { rolledBack: false } because the latest row is now a
 *  revert (prompt_strategy = null), which short-circuits the check.
 *
 *  Doesn't throw — best-effort, errors are logged + treated as
 *  "no rollback needed" so the dashboard load isn't blocked. */
export async function checkAndAutoRollbackIfNeeded(): Promise<{
  rolledBack: boolean;
  description?: string;
  postAvg?: number;
  baseline?: number;
  postSamples?: number;
}> {
  const gid = getGroupId();
  if (!gid) return { rolledBack: false };

  try {
    // Read the latest tuning row + its baseline metadata.
    const { data: latestRows, error: latestErr } = await supabase
      .from('chip_count_tuning_overrides')
      .select('id, created_at, prompt_strategy, baseline_avg_abs_delta, description')
      .eq('group_id', gid)
      .order('created_at', { ascending: false })
      .limit(1);
    if (latestErr) {
      console.warn('[auto-rollback] latest fetch failed:', latestErr.message);
      return { rolledBack: false };
    }
    if (!latestRows || latestRows.length === 0) return { rolledBack: false };

    const latest = latestRows[0] as {
      id: string;
      created_at: string;
      prompt_strategy: string | null;
      baseline_avg_abs_delta: number | null;
      description: string | null;
    };

    // Short-circuit: latest row is a revert (no strategy) OR has no
    // baseline (legacy row from a manually-inserted entry).
    if (!latest.prompt_strategy || latest.baseline_avg_abs_delta === null) {
      return { rolledBack: false };
    }

    // Count + sum the feedback rows that came in AFTER this tuning.
    const { data: postRows, error: postErr } = await supabase
      .from('chip_count_feedback')
      .select('total_abs_delta')
      .eq('group_id', gid)
      .gt('created_at', latest.created_at);
    if (postErr) {
      console.warn('[auto-rollback] post-rows fetch failed:', postErr.message);
      return { rolledBack: false };
    }
    if (!postRows || postRows.length < AUTO_ROLLBACK_SAMPLES) {
      return { rolledBack: false };
    }

    const postAvg = postRows.reduce(
      (s, r) => s + ((r as { total_abs_delta: number }).total_abs_delta || 0),
      0,
    ) / postRows.length;
    const baseline = latest.baseline_avg_abs_delta;

    // Stay applied if the new strategy is at least as good as the
    // baseline (or only marginally worse — the 0.3-chip slack
    // matches the trendVerdict noise floor in chipFeedbackStats).
    if (postAvg <= baseline + 0.3) {
      return { rolledBack: false };
    }

    // Worse. Insert a revert row.
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData?.user) {
      console.warn('[auto-rollback] user fetch failed:', userErr?.message);
      return { rolledBack: false };
    }

    const description = `Auto-rollback: post-tuning avg ${postAvg.toFixed(2)} > baseline ${baseline.toFixed(2)} after ${postRows.length} samples`;
    const { error: insErr } = await supabase
      .from('chip_count_tuning_overrides')
      .insert({
        group_id: gid,
        created_by: userData.user.id,
        prompt_strategy: null,
        description,
      });
    if (insErr) {
      console.warn('[auto-rollback] revert insert failed:', insErr.message);
      return { rolledBack: false };
    }

    return {
      rolledBack: true,
      description,
      postAvg,
      baseline,
      postSamples: postRows.length,
    };
  } catch (e) {
    console.warn('[auto-rollback] threw:', e);
    return { rolledBack: false };
  }
}

/** Revert to the hardcoded default strategy by inserting a
 *  null-strategy row. This preserves the full history (the previous
 *  tune is still there, just no longer the latest) so the user can
 *  see "we tried v3 on May 5, reverted on May 8" in the future
 *  history view. */
export async function revertChipTuningToDefault(): Promise<
  | { ok: true }
  | { ok: false; error: string }
> {
  const gid = getGroupId();
  if (!gid) return { ok: false, error: 'No group context' };
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData?.user) {
    return { ok: false, error: userErr?.message || 'Not authenticated' };
  }
  const { error } = await supabase
    .from('chip_count_tuning_overrides')
    .insert({
      group_id: gid,
      created_by: userData.user.id,
      prompt_strategy: null,
      description: 'Manual revert to default',
    });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
