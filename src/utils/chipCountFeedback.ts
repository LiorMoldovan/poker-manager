import { supabase } from '../database/supabaseClient';
import { getGroupId } from '../database/supabaseCache';
// Note: `ChipCountFeedback` is exported from src/types for downstream
// consumers (future mining queries / dashboards). This file builds
// the row payload as a plain `Record<string, unknown>` matching the
// snake_case column names since the Supabase client expects those.
import type {
  ChipCountFeedbackStack,
  ChipValue,
  PhotoChipCountResult,
} from '../types';

/**
 * Photo chip-counting accuracy feedback loop (migration 069).
 *
 * WHY this exists
 * ───────────────
 * `countChipsFromPhoto` is a probabilistic estimator. Without real
 * ground-truth data we can keep tuning the prompt and aggregation
 * math forever and only be guessing about the failure modes. This
 * helper captures the diff between (what the AI proposed) and
 * (what the user actually saved) every time a player is finalized
 * after an AI-driven count, so the developer can periodically
 * mine `chip_count_feedback` and tune the pipeline empirically.
 *
 * Always silent — never blocks the UI on success or failure.
 * Logs to console on errors so future regressions are debuggable
 * via F12 alone.
 */

interface SubmitChipCountFeedbackInput {
  /** AI proposal: the result of `countChipsFromPhoto`. */
  photoResult: PhotoChipCountResult;
  /**
   * Final per-chip counts the user actually saved (`chipCounts[playerId]`).
   * Map of chipId → count.
   */
  finalCounts: Record<string, number>;
  /**
   * The chip values config used during this save (so we can
   * denormalize `value` into each per-stack feedback row, surviving
   * future chip config changes).
   */
  chipValues: ChipValue[];

  // ── Game / player context (all optional — feedback from the
  //    Settings test card has none of these). ──
  gameId?: string | null;
  playerId?: string | null;
  playerName?: string | null;
  expectedTotalValue?: number;
  rebuys?: number;
  chipsPerRebuy?: number;

  /**
   * The photo we sent to the AI (the enhanced base64, NOT the raw
   * camera output — the enhanced one is what the model actually
   * saw, and is therefore the truth for replaying failures).
   * When provided AND `shareChipPhotos` is true on group settings,
   * we upload to private storage and link `photo_path`. Otherwise
   * we skip upload and only record numeric data.
   */
  photoBase64?: string;
  photoMimeType?: string;
  /**
   * Snapshot of the owner opt-in flag at capture time. Pass
   * `getSettings()?.shareChipPhotos === true` from the caller
   * (so we don't have to reach into the cache from here).
   */
  shareChipPhotos: boolean;
}

interface SubmitChipCountFeedbackResult {
  ok: boolean;
  /** ID of the inserted row (when ok === true). */
  feedbackId?: string;
  /** Path of the uploaded photo when applicable. */
  photoPath?: string | null;
  /** Set on failure paths. */
  error?: string;
}

/**
 * Build the per-stack `ChipCountFeedbackStack[]` from the AI result
 * and the user's final counts. One entry per stack the AI returned
 * (we only have AI-vs-real diffs for stacks the AI actually saw —
 * a stack the user added manually with no AI proposal isn't useful
 * for tuning the AI).
 */
function buildStacks(
  result: PhotoChipCountResult,
  finalCounts: Record<string, number>,
  chipValues: ChipValue[],
): ChipCountFeedbackStack[] {
  const valueByChipId = new Map(chipValues.map(c => [c.id, c.value]));
  return result.stacks.map(stack => {
    const realCount = finalCounts[stack.chipId] ?? 0;
    const aiCount = stack.count;
    const stackOut: ChipCountFeedbackStack = {
      chipId: stack.chipId,
      color: stack.color,
      position: stack.position,
      value: valueByChipId.get(stack.chipId) ?? 0,
      aiCount,
      realCount,
      delta: realCount - aiCount,
      wasCorrect: realCount === aiCount,
    };
    // ── Legacy v5.48–v5.58 fields (only populated when the older
    //    pipeline ran; new pipeline leaves them undefined). ──
    if (typeof stack.confidence === 'number') stackOut.aiConfidence = stack.confidence;
    if (typeof stack.colorMatch === 'boolean') stackOut.aiColorMatch = stack.colorMatch;
    if (typeof stack.needsRecount === 'boolean') stackOut.aiNeedsRecount = stack.needsRecount;
    if (typeof stack.topColorHex === 'string') stackOut.aiTopColorHex = stack.topColorHex;
    if (Array.isArray(stack.rawCounts)) stackOut.aiRawCounts = stack.rawCounts;
    // ── v5.59+ per-stack provenance fields ──
    //    The new pipeline always populates `confidence`, but copy the
    //    rest only when present so we don't write `undefined`s into
    //    JSONB. The dashboard tolerates missing fields gracefully.
    if (typeof stack.agreementScore === 'number') stackOut.aiAgreementScore = stack.agreementScore;
    if (typeof stack.needsVerify === 'boolean') stackOut.aiNeedsVerify = stack.needsVerify;
    if (stack.geometricCount !== undefined) stackOut.aiGeometricCount = stack.geometricCount;
    if (stack.geometricMethod !== undefined) stackOut.aiGeometricMethod = stack.geometricMethod;
    if (typeof stack.detectedDominantHex === 'string') stackOut.aiDetectedDominantHex = stack.detectedDominantHex;
    if (stack.region) stackOut.aiRegion = stack.region;
    if (stack.provenance) stackOut.aiProvenance = stack.provenance;
    return stackOut;
  });
}

/**
 * Decode a base64 string into a Blob so it can be uploaded to
 * Supabase Storage. `base64` here is the raw payload (no data:URL
 * prefix), as produced by the image pipeline.
 */
function base64ToBlob(base64: string, mimeType: string): Blob {
  const byteString = atob(base64);
  const byteArray = new Uint8Array(byteString.length);
  for (let i = 0; i < byteString.length; i++) {
    byteArray[i] = byteString.charCodeAt(i);
  }
  return new Blob([byteArray], { type: mimeType });
}

/**
 * Fire-and-forget feedback submission. Never throws — errors are
 * logged but the caller flow continues uninterrupted (this is
 * silent telemetry; failure must never block the user finalizing
 * their player count).
 */
export async function submitChipCountFeedback(
  input: SubmitChipCountFeedbackInput,
): Promise<SubmitChipCountFeedbackResult> {
  const groupId = getGroupId();
  if (!groupId) {
    return { ok: false, error: 'no group id' };
  }
  if (input.photoResult.error) {
    // Don't record feedback for failed AI runs — there's nothing
    // useful to learn from "the API call timed out".
    return { ok: false, error: 'ai result has error' };
  }

  const { data: { session } } = await supabase.auth.getSession();
  const userId = session?.user?.id ?? null;

  const stacks = buildStacks(input.photoResult, input.finalCounts, input.chipValues);
  const totalStacks = stacks.length;
  const correctStacks = stacks.filter(s => s.wasCorrect).length;
  const totalChipDelta = stacks.reduce((acc, s) => acc + s.delta, 0);
  const totalAbsDelta = stacks.reduce((acc, s) => acc + Math.abs(s.delta), 0);

  // Generate the feedback id client-side so we can name the photo
  // file `{group_id}/{feedback_id}.jpg` and have a 1:1 link between
  // the storage object and the row that references it.
  const feedbackId = crypto.randomUUID();

  // ── Optional photo upload (opt-in only) ──
  let photoPath: string | null = null;
  let photoConsented = false;
  if (input.shareChipPhotos && input.photoBase64 && input.photoMimeType) {
    photoConsented = true;
    const ext = input.photoMimeType.includes('png') ? 'png' : 'jpg';
    const path = `${groupId}/${feedbackId}.${ext}`;
    try {
      const blob = base64ToBlob(input.photoBase64, input.photoMimeType);
      const { error: upErr } = await supabase.storage
        .from('chip-count-feedback-photos')
        .upload(path, blob, {
          contentType: input.photoMimeType,
          upsert: false,
        });
      if (upErr) {
        // Photo failed but the numeric row is still useful — log
        // and continue. `photo_path` stays null in the DB row, and
        // `photo_consented` stays true so we know an upload was
        // attempted (not silently skipped due to missing opt-in).
        console.warn('[chip-count-feedback] photo upload failed:', upErr.message);
      } else {
        photoPath = path;
      }
    } catch (err) {
      console.warn('[chip-count-feedback] photo upload threw:', err);
    }
  }

  // ── v5.59+ per-photo pipeline diagnostics ──
  // Captured into a single JSONB column (`pipeline_meta`, migration 075)
  // so future pipeline iterations can add signals without DDL. We
  // only emit fields the photo result actually carries; null when
  // the result is from the legacy pipeline (pre-rebuild).
  const pipelineMeta: Record<string, unknown> | null =
    (input.photoResult.whiteBalanceApplied !== undefined ||
     input.photoResult.detectionSignal !== undefined ||
     input.photoResult.totalValueCheckResult !== undefined)
      ? {
          ...(input.photoResult.whiteBalanceApplied !== undefined
            ? { whiteBalanceApplied: input.photoResult.whiteBalanceApplied }
            : {}),
          ...(input.photoResult.detectionSignal !== undefined
            ? { detectionSignal: input.photoResult.detectionSignal }
            : {}),
          ...(input.photoResult.totalValueCheckResult !== undefined
            ? { totalValueCheckResult: input.photoResult.totalValueCheckResult }
            : {}),
        }
      : null;

  const row: Record<string, unknown> = {
    id: feedbackId,
    group_id: groupId,
    user_id: userId,
    game_id: input.gameId ?? null,
    player_id: input.playerId ?? null,
    player_name: input.playerName ?? null,
    model_used: input.photoResult.modelUsed,
    overall_confidence: Math.max(0, Math.min(100, Math.round(input.photoResult.overallConfidence))),
    shots_used: Math.max(1, Math.min(5, input.photoResult.shotsUsed ?? 1)),
    expected_total_value: input.expectedTotalValue ?? null,
    rebuys: input.rebuys ?? null,
    chips_per_rebuy: input.chipsPerRebuy ?? null,
    stacks,
    total_stacks: totalStacks,
    correct_stacks: correctStacks,
    total_chip_delta: totalChipDelta,
    total_abs_delta: totalAbsDelta,
    photo_path: photoPath,
    photo_consented: photoConsented,
    pipeline_meta: pipelineMeta,
  };

  const { error: insertErr } = await supabase
    .from('chip_count_feedback')
    .insert(row);

  if (insertErr) {
    console.warn('[chip-count-feedback] insert failed:', insertErr.message);
    // If the photo uploaded but the row insert failed, the photo
    // is now an orphan in storage. Best-effort cleanup so we don't
    // leak storage usage on transient failures.
    if (photoPath) {
      void supabase.storage
        .from('chip-count-feedback-photos')
        .remove([photoPath])
        .catch(() => { /* swallow — orphan cleanup is best-effort */ });
    }
    return { ok: false, error: insertErr.message };
  }

  return { ok: true, feedbackId, photoPath };
}
