-- ============================================================================
-- Migration 121: rename location 'מקלט ליכטר' to 'מקלט'
-- ============================================================================
-- The venue was originally misnamed 'מקלט ליכטר' instead of 'מקלט'.
-- This migration normalizes the venue name across games, settings,
-- pending forecasts, and game polls so history and statistics align.
-- ============================================================================

-- 1. Update games (completed and active)
UPDATE games
SET location = 'מקלט'
WHERE location = 'מקלט ליכטר';

-- 2. Update pending forecasts
UPDATE pending_forecasts
SET location = 'מקלט'
WHERE location = 'מקלט ליכטר';

-- 3. Update game polls default location
UPDATE game_polls
SET default_location = 'מקלט'
WHERE default_location = 'מקלט ליכטר';

-- 4. Update settings.locations JSONB array if present
UPDATE settings
SET locations = (
  SELECT COALESCE(
    jsonb_agg(
      CASE
        WHEN elem #>> '{}' = 'מקלט ליכטר' THEN '"מקלט"'::jsonb
        ELSE elem
      END
    ),
    '[]'::jsonb
  )
  FROM jsonb_array_elements(locations) AS elem
)
WHERE locations @> '["מקלט ליכטר"]'::jsonb;

-- 5. Update settings.location_addresses key if present
UPDATE settings
SET location_addresses = (location_addresses - 'מקלט ליכטר') || jsonb_build_object('מקלט', location_addresses->'מקלט ליכטר')
WHERE location_addresses ? 'מקלט ליכטר';

-- 6. Update settings.location_notes key if present
UPDATE settings
SET location_notes = (location_notes - 'מקלט ליכטר') || jsonb_build_object('מקלט', location_notes->'מקלט ליכטר')
WHERE location_notes ? 'מקלט ליכטר';
