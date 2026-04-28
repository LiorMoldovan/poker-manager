-- ============================================================
-- Migration 023: Schedule feature group-level config
-- Run in Supabase SQL Editor after 022-game-scheduling.sql
-- (Idempotent — safe to re-run if you already ran an earlier version.)
--
-- Adds per-group flags + defaults for the Schedule feature so admins
-- can independently toggle channels and pre-fill new-poll inputs:
--
-- Notification toggles:
--   - schedule_push_enabled         (default TRUE)
--   - schedule_emails_enabled       (default FALSE — beta opt-in)
--
-- Default values pre-filled in CreatePollModal (still editable per poll):
--   - schedule_default_target       INT, default 8
--   - schedule_default_delay_hours  INT, default 48
--   - schedule_default_time         TEXT 'HH:MM' 24h, default '21:00'
--   - schedule_default_allow_maybe  BOOLEAN, default TRUE
--
-- WhatsApp share buttons + in-app UI always work regardless.
-- ============================================================

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS schedule_emails_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS schedule_push_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS schedule_default_target INT NOT NULL DEFAULT 8
    CHECK (schedule_default_target BETWEEN 2 AND 12);

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS schedule_default_delay_hours INT NOT NULL DEFAULT 48
    CHECK (schedule_default_delay_hours BETWEEN 0 AND 240);

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS schedule_default_time TEXT NOT NULL DEFAULT '21:00'
    CHECK (schedule_default_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS schedule_default_allow_maybe BOOLEAN NOT NULL DEFAULT TRUE;

-- Update get_group_settings RPC to surface the new columns to all members
-- (they're config flags, not secrets — no need to strip for non-owners).
CREATE OR REPLACE FUNCTION get_group_settings(p_group_id UUID)
RETURNS JSON AS $$
DECLARE
  result JSON;
  is_owner BOOLEAN;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM group_members WHERE group_id = p_group_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not a member of this group';
  END IF;

  SELECT (g.created_by = auth.uid()) INTO is_owner
  FROM groups g WHERE g.id = p_group_id;

  IF is_owner THEN
    SELECT row_to_json(s) INTO result FROM settings s WHERE s.group_id = p_group_id;
  ELSE
    SELECT row_to_json(t) INTO result FROM (
      SELECT group_id, rebuy_value, chips_per_rebuy, min_transfer,
             game_night_days, locations, blocked_transfers, language,
             schedule_emails_enabled, schedule_push_enabled,
             schedule_default_target, schedule_default_delay_hours,
             schedule_default_time, schedule_default_allow_maybe,
             NULL::text AS gemini_api_key,
             NULL::text AS elevenlabs_api_key
      FROM settings WHERE group_id = p_group_id
    ) t;
  END IF;

  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================
-- DONE — Verify with:
--   SELECT schedule_emails_enabled, schedule_push_enabled,
--          schedule_default_target, schedule_default_delay_hours,
--          schedule_default_time, schedule_default_allow_maybe
--   FROM settings LIMIT 1;
--   SELECT get_group_settings('<your-group-id>'::uuid);
-- ============================================================
