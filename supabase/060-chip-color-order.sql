-- Migration 060: chip_color_order on settings
--
-- Adds a per-group preference for the conventional left-to-right order
-- of chip colors when photographing a player's stacks. The
-- photo-counting AI uses this list to skip color-identification entirely
-- (it already knows which color sits at which position), eliminating
-- color-confusion as an error class.
--
-- Format: JSONB array of chip_values.id strings, e.g.
--   ["abc-uuid-white", "def-uuid-red", "ghi-uuid-blue", ...]
--
-- NULL is the valid "not configured yet" state — the client falls back
-- to the natural order returned by getChipValues() in that case. This
-- is why we DON'T set a default and DON'T mark NOT NULL: existing
-- groups remain unaffected until an owner explicitly configures it via
-- Settings → Chips.
--
-- Idempotent: safe to re-run (ADD COLUMN IF NOT EXISTS).

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS chip_color_order JSONB;

COMMENT ON COLUMN settings.chip_color_order IS
  'Ordered list of chip_values.id representing the conventional left-to-right photo order for chip stacks. Used by the photo chip-counting feature to anchor color identity by position. NULL = not configured (client falls back to natural chipValues order).';
