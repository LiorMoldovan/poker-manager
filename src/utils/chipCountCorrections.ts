/**
 * Chip-count ground-truth corrections logger (v6.2.x — chip count loop).
 *
 * Companion to `chipCountDebug.ts` (telemetry). Where telemetry records
 * WHAT happened on every Gemini call, this file records WHAT WAS
 * ACTUALLY CORRECT — Lior's manual correction on top of an AI result,
 * with the photo attached.
 *
 * The flow:
 *   1. User takes a test photo in Settings → Services
 *   2. AI returns per-color counts
 *   3. User edits any wrong numbers in-place and taps "save correct count"
 *   4. We INSERT one row here with: photo (base64), AI's counts, user's
 *      counts, model, selfies attached, color set
 *   5. Agent later reads rows via Supabase MCP, looks at the photos +
 *      deltas, iterates the prompt (or attaches the cleanest photos as
 *      few-shot examples)
 *
 * NOT auto-tuning. The app does nothing with these rows; the agent does.
 *
 * Privacy:
 *   - Photo IS stored (the user explicitly opted in by tapping save).
 *   - No API keys, no auth tokens, no PII beyond user_id (which is
 *     auth.uid() and the user's own row).
 *
 * Failure behaviour:
 *   - Returns `{ ok: boolean, error?: string }`. Unlike the fire-and-
 *     forget telemetry logger, this one's success matters to the user
 *     (they tapped "save" and expect to know if it worked), so we
 *     surface failures so the UI can show "saved" vs "save failed".
 */

import { supabase } from '../database/supabaseClient';
import { getGroupId } from '../database/supabaseCache';
import { isObserverMode } from '../auth/observerMode';
import { APP_VERSION } from '../version';

export interface ChipCountCorrectionRow {
  /** Whichever Gemini model returned `aiCounts`. Pull this from
   *  PhotoChipCountResult.modelUsed if available; falls back to ''
   *  when unknown (which shouldn't happen on success, but be safe). */
  model: string;
  /** Where the correction came from. Currently only 'settings-test'
   *  emits corrections; live-game has its own edit path. Future-proof. */
  context?: 'settings-test' | 'live-game';
  /** How many chip selfies were attached to the AI prompt that
   *  produced `aiCounts`. Tells the agent later whether selfies were
   *  in the loop for this sample. */
  selfiesAttached?: number;
  /** Enhanced JPEG that was actually sent to Gemini (base64, no
   *  data-URL prefix). Comes back from PhotoCaptureModal via the
   *  previewBase64 callback. */
  photoBase64: string;
  photoMimeType: string;
  /** Chip color names configured in the group at correction time.
   *  Snapshotted so the prompt iteration can group corrections by
   *  what palette was active. */
  chipColorsConfigured?: string[];
  /** AI's per-color counts. Keys are color names (lowercase preferred
   *  for join consistency with chip_count_debug.final_counts but the
   *  table accepts any string). */
  aiCounts: Record<string, number>;
  /** User's per-color truth counts. Same key shape as aiCounts. */
  truthCounts: Record<string, number>;
}

export interface ChipCountCorrectionResult {
  ok: boolean;
  /** Diff sum (Σ |truth-ai|) — also stored on the row. Returned so
   *  the UI can show "saved · 3 corrections" in the toast. */
  totalDiff: number;
  error?: string;
}

/**
 * Compute Σ |truth-ai| across all colors, treating missing keys as 0
 * on either side. Used both for the column and for the return value.
 */
function computeTotalDiff(
  ai: Record<string, number>,
  truth: Record<string, number>,
): number {
  const allColors = new Set<string>([...Object.keys(ai), ...Object.keys(truth)]);
  let diff = 0;
  for (const color of allColors) {
    const a = Number.isFinite(ai[color]) ? ai[color] : 0;
    const t = Number.isFinite(truth[color]) ? truth[color] : 0;
    diff += Math.abs(t - a);
  }
  return diff;
}

export async function logChipCountCorrection(
  row: ChipCountCorrectionRow,
): Promise<ChipCountCorrectionResult> {
  const totalDiff = computeTotalDiff(row.aiCounts, row.truthCounts);

  try {
    // Observer mode shouldn't write to anyone else's group. The
    // tester here is the user themselves on their own group anyway,
    // but be consistent with the rest of the codebase.
    if (isObserverMode()) {
      return { ok: false, totalDiff, error: 'observer-mode' };
    }

    const groupId = getGroupId();
    if (!groupId) {
      return { ok: false, totalDiff, error: 'no-group' };
    }

    const { data: userData } = await supabase.auth.getUser();
    const userId = userData?.user?.id ?? null;
    if (!userId) {
      return { ok: false, totalDiff, error: 'no-user' };
    }

    if (!row.photoBase64 || row.photoBase64.length < 100) {
      return { ok: false, totalDiff, error: 'no-photo' };
    }

    const payload = {
      group_id: groupId,
      user_id: userId,
      app_version: APP_VERSION,
      model: row.model || null,
      context: row.context ?? 'settings-test',
      selfies_attached: row.selfiesAttached ?? null,
      photo_base64: row.photoBase64,
      photo_mime_type: row.photoMimeType || 'image/jpeg',
      photo_byte_count: row.photoBase64.length,
      chip_colors_configured: row.chipColorsConfigured ?? null,
      ai_counts: row.aiCounts,
      truth_counts: row.truthCounts,
      total_diff: totalDiff,
    };

    const { error } = await supabase
      .from('chip_count_corrections')
      .insert(payload);

    if (error) {
      if (typeof console !== 'undefined') {
        console.warn('[chipCountCorrections] insert failed:', error.message);
      }
      return { ok: false, totalDiff, error: error.message };
    }

    return { ok: true, totalDiff };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (typeof console !== 'undefined') {
      console.warn('[chipCountCorrections] unexpected error:', msg);
    }
    return { ok: false, totalDiff, error: msg };
  }
}
