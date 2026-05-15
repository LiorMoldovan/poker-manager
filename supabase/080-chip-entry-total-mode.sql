-- Migration 080 — Quick-total chip entry mode
--
-- Adds an alternative chip-counting flow for groups that don't count
-- color-by-color. Each player can be entered in one of two modes,
-- decided per-player on the chip entry screen:
--
--   'color' (default) — admin counts chips per color into the existing
--                       chip_counts JSONB. final_value derives from
--                       Σ count × chip.value × valuePerChip. Today's flow.
--   'total'           — admin enters one total chip count (the player
--                       counted their own stack and reported a number).
--                       Stored as `total_chip_count`; chip_counts stays
--                       empty. final_value derives from
--                       total_chip_count × valuePerChip on finalize.
--
-- The two zero-sum DB triggers (check_game_zero_sum on games status,
-- check_game_players_zero_sum on game_players profit) operate on
-- `profit` only and are independent of entry_mode — both modes
-- remain zero-sum as long as the client computes profit correctly,
-- which the chip-gap distribution already guarantees.
--
-- Group-level default in `settings.chip_entry_default_mode` controls
-- which mode opens with the BIG (player name) tap on each player tile.
-- The OTHER mode is always one labeled tap away on the same tile, so
-- both modes can be mixed inside the same game.
--
-- All idempotent. Existing rows back-fill cleanly to 'color' so no
-- behavior changes for the 24+ existing groups or their hundreds of
-- historical game_players rows.

ALTER TABLE game_players
  ADD COLUMN IF NOT EXISTS entry_mode TEXT NOT NULL DEFAULT 'color'
    CHECK (entry_mode IN ('color', 'total'));

ALTER TABLE game_players
  ADD COLUMN IF NOT EXISTS total_chip_count INTEGER
    CHECK (total_chip_count IS NULL OR total_chip_count >= 0);

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS chip_entry_default_mode TEXT
    NOT NULL DEFAULT 'color'
    CHECK (chip_entry_default_mode IN ('color', 'total'));
