-- 074 — Per-color chip selfies for photo chip-counting accuracy.
--
-- Why this exists:
--   The photo chip-counting pipeline (rebuilt around per-stack focus
--   + 3-method geometric voting + chip-selfie reference image) needs
--   ground truth for what one chip of each color looks like. Two
--   downstream uses:
--     1. Color-based stack-to-chip-color mapping: detect the dominant
--        body color of each detected stack region, match to nearest
--        chip via HSL distance to selfie_dominant_hex. Robust to
--        lighting + arrangement-order changes (vs. the previous
--        position-only mapping which broke when stacks were not
--        sorted small-to-large).
--     2. Few-shot vision prompting: the per-stack LLM call bundles
--        the selfie image alongside the stack crop ("here's what ONE
--        chip looks like, count how many in this stack"). Published
--        research consistently shows 10-25 percentage point gains
--        from vision few-shot reference images on counting tasks.
--
-- What this adds:
--   Two nullable columns on chip_values:
--     selfie_base64       TEXT  — base64 of a 256x256 downscaled JPEG
--                                  of one chip on a plain background.
--                                  Captured via the chips settings UI
--                                  selfie button, stored inline in the
--                                  row (no separate Storage bucket so
--                                  the cache load gets it for free).
--                                  Realistic per-row size: ~30-40KB.
--     selfie_dominant_hex TEXT  — '#rrggbb' of the dominant color of
--                                  the selfie's center 24x24 patch,
--                                  precomputed at capture time so the
--                                  stack-to-color matcher doesn't need
--                                  to re-decode the base64 on every
--                                  photo. Source of truth for color
--                                  mapping; selfie_base64 is the
--                                  source of truth for LLM reference.
--
--   Both nullable: groups that haven't taken selfies yet still work,
--   the pipeline falls back to chip_values.display_color for color
--   matching and drops the reference-image clause from the LLM prompt.
--
-- What this does NOT change:
--   No data migration. No RLS policy change (existing chip_values
--   policies cover SELECT/INSERT/UPDATE on the new columns by
--   inheritance). No constraints (selfie capture is voluntary). No
--   triggers. No backfill of existing rows — they stay null until the
--   user takes a selfie via the new UI.
--
-- Forward compatibility:
--   If we ever want to surface "selfie taken at" timestamps for the
--   "retake selfie reminder" feature we discussed, that's a future
--   migration with another nullable column. This one stays minimal.

ALTER TABLE public.chip_values
  ADD COLUMN IF NOT EXISTS selfie_base64       TEXT,
  ADD COLUMN IF NOT EXISTS selfie_dominant_hex TEXT;

COMMENT ON COLUMN public.chip_values.selfie_base64 IS
  'Base64 of a 256x256 JPEG of one chip on a plain background. Used as a few-shot reference image bundled with per-stack LLM counting calls. Nullable; pipeline falls back to no-reference prompt when missing.';

COMMENT ON COLUMN public.chip_values.selfie_dominant_hex IS
  'Precomputed dominant color of the selfie center patch as #rrggbb. Used for color-based stack-to-chip-color mapping. Nullable; pipeline falls back to display_color when missing.';
