-- Migration 078 — deprecate `chip_values.selfie_dominant_hex`.
--
-- Why this migration exists:
--
-- v5.59.0 added a `selfie_dominant_hex` column (migration 074) that stored
-- a precomputed dominant body color per chip, derived from each chip's
-- selfie JPEG. The pipeline used this hex via HSL distance to map each
-- detected stack region to a chip color (`stackDetection.ts`).
--
-- The extraction was fundamentally fragile:
--   * v5.59.0 sampled the dead-center 24×24 patch → landed on the printed
--     value inlay/sticker present on most poker chips → produced muddy
--     mid-grey hexes for every chip color (red→#b59e94, blue→#7b86a3,
--     green→#aaaa94, black→#989493). Stack→chip mapping became effectively
--     random; the feature appeared totally broken in real use.
--   * v5.60.13 tried ring-sampling at 30/45/60/75% canvas radius. Selfies
--     where the chip didn't fill the frame had outer rings sample the
--     background (e.g. green poker felt) → wrong hexes still (white→
--     #0c805c dark-green, black→#338665 green).
--
-- v5.60.14 abandoned the per-user color calibration approach. The user-
-- configured `display_color` is well-saturated, hue-correct, and 100%
-- reliable; the runtime now matches against that. The chip selfie JPEG
-- itself remains valuable as a few-shot reference image for the LLM call
-- (`runSingleStackShot` in geminiAI.ts) — only the dominant-hex extraction
-- was retired.
--
-- This migration:
--   1. NULLs out every existing `selfie_dominant_hex` (all known-bad data
--      from the v5.59.0 / v5.60.13 extraction code paths).
--   2. Updates the column comment so future agents reading the schema
--      know the column is deprecated and writes are intentionally null.
--
-- The column itself is left in place (NOT dropped) for two reasons:
--   * `DROP COLUMN` is irreversible and the parallel-agent v5.61.0 work
--     in flight could theoretically still be referencing the column;
--     leaving it as a NULL column is forward-compatible.
--   * If a future revisit of per-user color calibration with proper CV
--     (chip-boundary detection) becomes worth it, the column is ready.

UPDATE public.chip_values
   SET selfie_dominant_hex = NULL
 WHERE selfie_dominant_hex IS NOT NULL;

COMMENT ON COLUMN public.chip_values.selfie_dominant_hex IS
  'DEPRECATED in v5.60.14 — always NULL. Was a precomputed dominant hex extracted from `selfie_base64`, used for HSL-distance stack→chip color mapping. Extraction proved unreliable (samples either the printed value inlay or the photo background depending on chip framing). Pipeline now uses `display_color` for matching. Column kept for forward compatibility / future revisit. Do NOT write non-null values from new code.';
