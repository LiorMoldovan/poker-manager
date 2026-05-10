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

/** Revert to the hardcoded default strategy by inserting a
 *  null-strategy row. This preserves the full history (the previous
 *  tune is still there, just no longer the latest) so the user can
 *  see "we tried v3 on May 5, reverted on May 8" in the future
 *  history view (Phase 3). */
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
