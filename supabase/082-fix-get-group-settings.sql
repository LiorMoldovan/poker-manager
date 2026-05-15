-- 082-fix-get-group-settings.sql
--
-- Two related bugs in get_group_settings(p_group_id) that together
-- could silently destroy a group's settings.
--
-- Bug #1 (CRITICAL — observed in production v6.1.0):
--   The membership-check `RAISE EXCEPTION 'Not a member of this group'`
--   had no super-admin bypass. When a super admin switched into an
--   observed group via GroupSwitcher, this RPC threw, the cache
--   stored {} for the SETTINGS slice, and getSettings() fell back to
--   the client's DEFAULT_SETTINGS (rebuyValue=30, chipsPerRebuy=10000,
--   minTransfer=5, by-color). The Settings tab then rendered those
--   defaults instead of the group's real values.
--
--   Worse: every change in a Settings input auto-saves through
--   handleSettingsChange → saveSettings → cacheSet → debouncedSync →
--   `supabase.from('settings').upsert(...)`. The `super_admins_full_access`
--   RLS policy on `settings` lets any super admin INSERT/UPDATE any
--   group's row. So a super admin opening a group's Settings tab and
--   touching ANY field would silently overwrite that group's real
--   settings with the local defaults — without ever seeing the real
--   values to confirm. A pure read-side bug bled into a destructive
--   write surface because the load failure was invisible to the user.
--
--   Fix: skip the membership check for super admins, and treat them
--   like the owner branch (full row including API keys). Super
--   admins are already trusted at the platform level for cross-group
--   visibility — read access matches their `super_admins_full_access`
--   RLS grant.
--
--   The matching client-side write guard (bail super-admin observers
--   out of pushToSupabase for SETTINGS) ships in the same commit so
--   we have defence-in-depth: the RPC fix prevents the silent load
--   failure that triggered the wipe, and the write guard catches any
--   future regression where an observer somehow ends up with a stale
--   settings cache.
--
-- Bug #2 (LATENT — would bite as soon as a group has 2+ admins):
--   The non-owner branch hand-listed columns as a poor-person's
--   "drop API keys for non-owners" filter. Since migration 004 the
--   schema gained these columns that the non-owner branch never
--   added back:
--     - chip_color_order            (migration 060)
--     - share_chip_photos           (migration 074)
--     - chip_entry_default_mode     (migration 080)
--     - schedule_auto_create_*      (migration 050)
--   Result: non-owner admins (any group with multiple admins) saw
--   the client's hardcoded UI defaults for these fields regardless
--   of what the owner had set. On save the wrong values would
--   persist back to the DB. Idan's group has only one admin so the
--   bug wasn't biting yet, but the latent footprint touches every
--   group that ever promotes a second admin.
--
--   Fix: list every readable column explicitly. API keys stay
--   owner-only by NULL'ing them out for the non-owner branch (this
--   is the original product decision — keys are sensitive enough
--   that even regular admins shouldn't see them, only the owner).
--
-- Idempotency: CREATE OR REPLACE — safe to apply repeatedly.

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
  -- Super-admin bypass: cross-group platform role with read access
  -- via super_admins_full_access RLS. Treated as owner-equivalent
  -- below so they see API keys (needed for cross-group debugging
  -- and quota investigation).
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
    -- Full row including API keys.
    SELECT row_to_json(s) INTO result FROM settings s WHERE s.group_id = p_group_id;
  ELSE
    -- Non-owner admin / member: every readable column except API
    -- keys (those stay owner-only by product decision).
    SELECT row_to_json(t) INTO result FROM (
      SELECT
        group_id,
        rebuy_value,
        chips_per_rebuy,
        min_transfer,
        game_night_days,
        locations,
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
