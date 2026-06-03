-- 095-location-notes.sql
--
-- Feature: optional free-text ARRIVAL DETAILS per location name, on top
-- of the navigable address added in migration 094.
--
-- Members asked to store extra info that helps you actually get inside
-- once Waze has gotten you to the street — e.g.:
--
--   ליכטר:
--     דוד זהבי 16 כפר סבא      ← address (location_addresses, mig 094, feeds Waze)
--     קומה 0 דירה 1            ┐
--     קוד מפתח 5555            ┘ ← arrival details (location_notes, THIS migration)
--
-- Kept as a SEPARATE free-text map (not structured floor/apt/code
-- columns) because every group writes these differently and the
-- example is just lines of text. The address stays its own single-line
-- field so the Waze deep-link query is never polluted with "קוד מפתח".
--
-- Same shape/pattern as location_addresses: name → text. Absent name =
-- no details shown. Purely additive; old data untouched.
--
-- Two parts:
--   1. ADD COLUMN location_notes (JSONB, default '{}').
--   2. CREATE OR REPLACE get_group_settings — add location_notes to the
--      hand-listed non-owner branch (owner / super-admin branch uses
--      row_to_json(s) and picks it up automatically).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE.

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS location_notes JSONB DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION public.get_group_settings(p_group_id uuid)
  RETURNS json
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  result JSON;
  is_owner BOOLEAN;
  is_super_admin BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM super_admins WHERE user_id = auth.uid()
  ) INTO is_super_admin;

  IF NOT is_super_admin AND NOT EXISTS (
    SELECT 1 FROM group_members WHERE group_id = p_group_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not a member of this group';
  END IF;

  SELECT (g.created_by = auth.uid()) INTO is_owner
  FROM groups g WHERE g.id = p_group_id;

  IF is_owner OR is_super_admin THEN
    SELECT row_to_json(s) INTO result FROM settings s WHERE s.group_id = p_group_id;
  ELSE
    SELECT row_to_json(t) INTO result FROM (
      SELECT
        group_id,
        rebuy_value,
        chips_per_rebuy,
        min_transfer,
        game_night_days,
        locations,
        location_addresses,
        location_notes,
        blocked_transfers,
        language,
        schedule_emails_enabled,
        schedule_push_enabled,
        schedule_default_target,
        schedule_default_delay_hours,
        schedule_default_time,
        schedule_default_allow_maybe,
        schedule_auto_create_enabled,
        schedule_auto_create_day,
        schedule_auto_create_time,
        schedule_auto_created_at,
        chip_color_order,
        share_chip_photos,
        chip_entry_default_mode,
        NULL::text AS gemini_api_key,
        NULL::text AS elevenlabs_api_key
      FROM settings WHERE group_id = p_group_id
    ) t;
  END IF;

  RETURN result;
END;
$function$;
