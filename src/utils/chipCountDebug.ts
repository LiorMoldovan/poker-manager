/**
 * Chip-count telemetry (v5.62.4).
 *
 * Fire-and-forget INSERT into `public.chip_count_debug` after every
 * whole-photo Gemini call (success or failure). Lets the agent diagnose
 * failures directly via the Supabase MCP without the user having to
 * forward screenshots or use DevTools.
 *
 * This module MUST NOT block or throw into the photo flow — every error
 * path swallows silently and (in dev only) console.warns.
 *
 * Privacy posture (also documented in the migration):
 *   - No API keys, no auth tokens.
 *   - `raw_response_excerpt` is Gemini's *output* text, truncated to 4KB.
 *   - No photo bytes stored, only `image_byte_count` (base64 size).
 */

import { supabase } from '../database/supabaseClient';
import { getGroupId } from '../database/supabaseCache';
import { APP_VERSION } from '../version';

const RAW_EXCERPT_MAX = 4096;

export type ChipCountDebugContext = 'live-game' | 'settings-test' | 'unknown';

export type ChipCountDebugOutcome =
  | 'success'
  | 'parseFailed'
  | 'unexpectedShape'
  | 'httpError'
  | 'network'
  | 'cancelled';

export interface ChipCountDebugRow {
  model: string;
  attemptIndex: number;
  totalModels: number;
  context: ChipCountDebugContext;
  outcome: ChipCountDebugOutcome;
  /** 1..5 if salvager won, undefined on failure or pre-salvager outcomes. */
  salvageStrategy?: number;
  errorMessage?: string;
  rawResponse?: string;
  finalCounts?: Record<string, number>;
  imageByteCount?: number;
  chipColorsConfigured?: string[];
  selfiesAttached?: number;
  httpStatus?: number;
  durationMs?: number;
}

/**
 * Insert a debug row. Returns a promise that resolves once the insert
 * is attempted — callers should `void` it (don't await) so the photo
 * flow isn't blocked by DB latency.
 *
 * All failures are swallowed: a missing groupId, no logged-in user,
 * RLS denial, network issue — none of those should propagate. The
 * worst-case outcome of a logger bug is "we lose visibility into one
 * call", never "the user's chip count failed because logging broke".
 */
export async function logChipCountAttempt(row: ChipCountDebugRow): Promise<void> {
  try {
    const groupId = getGroupId();
    if (!groupId) return;

    const { data: userData } = await supabase.auth.getUser();
    const userId = userData?.user?.id ?? null;
    if (!userId) return;

    const raw = row.rawResponse ?? '';
    const rawByteCount = raw.length;
    const rawExcerpt = rawByteCount > RAW_EXCERPT_MAX ? raw.slice(0, RAW_EXCERPT_MAX) : raw;

    const payload = {
      group_id: groupId,
      user_id: userId,
      app_version: APP_VERSION,
      model: row.model,
      attempt_index: row.attemptIndex,
      total_models: row.totalModels,
      context: row.context,
      outcome: row.outcome,
      salvage_strategy: row.salvageStrategy ?? null,
      error_message: row.errorMessage ? row.errorMessage.slice(0, 500) : null,
      raw_response_excerpt: rawExcerpt || null,
      raw_response_byte_count: rawByteCount || null,
      final_counts: row.finalCounts ?? null,
      image_byte_count: row.imageByteCount ?? null,
      chip_colors_configured: row.chipColorsConfigured ?? null,
      selfies_attached: row.selfiesAttached ?? null,
      http_status: row.httpStatus ?? null,
      duration_ms: row.durationMs ?? null,
    };

    const { error } = await supabase.from('chip_count_debug').insert(payload);
    if (error && typeof console !== 'undefined') {
      console.warn('[chipCountDebug] insert failed:', error.message);
    }
  } catch (err) {
    if (typeof console !== 'undefined') {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[chipCountDebug] unexpected error:', msg);
    }
  }
}
