-- ============================================================
-- Migration 075 — `chip_count_feedback.pipeline_meta` JSONB column.
--
-- Why this exists
-- ───────────────
-- The v5.59 chip-counting rebuild (per-stack pipeline + multi-method
-- voting + total-value sanity check) produces several new
-- per-photo (NOT per-stack) signals worth logging for empirical
-- tuning:
--
--   * `whiteBalanceApplied`  — did we have enough white-stripe
--     pixels to compute and apply a per-channel WB correction?
--     False here while abs error stays high suggests the chip
--     stripes weren't visible to the camera in this group's
--     setup, which is fixable with photo-protocol guidance.
--
--   * `detectionSignal`      — which path the stack detector took
--     ('white-stripe' / 'edge-density' / 'position-only'). Rows
--     where 'position-only' is the fallback are systematically
--     less reliable; surfacing that helps us spot whether a group
--     is shooting against unusable backgrounds.
--
--   * `totalValueCheckResult` — when the live-game flow had an
--     `expectedTotalValue`, did we adjust the lowest-confidence
--     stack to reconcile to the expected total, and by how many
--     chips. A row where this fired AND the final delta was
--     still wrong is a strong "voting math is off" signal.
--
-- Putting these in a single JSONB column instead of three
-- top-level columns keeps the schema flexible — future pipeline
-- iterations can add new fields without another migration. The
-- dashboard mining queries already operate over the existing
-- `stacks` JSONB so adding another JSONB column doesn't change
-- the access pattern.
--
-- What this adds
--   * `chip_count_feedback.pipeline_meta JSONB NULL` — populated
--     by the new `submitChipCountFeedback`. Nullable so legacy
--     rows (and any future caller that doesn't set it) still
--     work; the dashboard treats null as "unknown" and skips
--     those rows from the new pipeline KPIs.
--
-- What this does NOT change
--   No data migration. No RLS update (existing INSERT/SELECT/
--   DELETE policies on `chip_count_feedback` cover the new
--   column transparently). No constraint additions; the column
--   is intentionally permissive — we'll iterate on the JSONB
--   shape in client code, not in DDL.
-- ============================================================

ALTER TABLE public.chip_count_feedback
  ADD COLUMN IF NOT EXISTS pipeline_meta JSONB;

COMMENT ON COLUMN public.chip_count_feedback.pipeline_meta IS
  'v5.59+ per-photo pipeline diagnostics: { whiteBalanceApplied: bool, detectionSignal: string, totalValueCheckResult: { expected, computed, adjustedStackId, adjustmentChips } | null }. Nullable; legacy rows do not have it.';
