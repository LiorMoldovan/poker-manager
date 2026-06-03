-- 094-location-addresses.sql
--
-- Feature: optional exact street address per saved location name.
--
-- The group's `settings.locations` JSONB has always been a flat array of
-- display names ("אצל ליאור", "אצל אייל"). Members asked to be able to
-- tap an upcoming game's location and have Waze open with directions.
-- To do that we need a real street address behind each name.
--
-- Rather than change the `locations` array shape (string[] is referenced
-- by ~15 client files and every `games.location` value is one of these
-- strings), we add a SEPARATE map keyed by the location name:
--
--   location_addresses := { "אצל ליאור": "הרצל 5, תל אביב", ... }
--
-- A name with no entry simply has no address → no Waze affordance shown.
-- Old data keeps working untouched; this is purely additive.
--
-- Two parts:
--   1. ADD COLUMN location_addresses (JSONB, default '{}').
--   2. CREATE OR REPLACE get_group_settings — the non-owner branch
--      hand-lists readable columns (see migration 082), so it MUST gain
--      `location_addresses` or non-owner admins/members would never see
--      the map. The owner / super-admin branch uses row_to_json(s) and
--      picks the new column up automatically.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE. Safe to
-- re-apply.

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS location_addresses JSONB DEFAULT '{}'::jsonb;

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
    -- Full row including API keys (row_to_json picks up every column,
    -- so location_addresses is included automatically).
    SELECT row_to_json(s) INTO result FROM settings s WHERE s.group_id = p_group_id;
  ELSE
    -- Non-owner admin / member: every readable column except API keys.
    SELECT row_to_json(t) INTO result FROM (
      SELECT
        group_id,
        rebuy_value,
        chips_per_rebuy,
        min_transfer,
        game_night_days,
        locations,
        location_addresses,
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
