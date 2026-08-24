-- ============================================================
-- Migration 110: the per-kind email filter must reach EVERY client,
--                and the server worker must dedupe confirmed/target_filled
-- Run in Supabase SQL Editor. Idempotent (CREATE OR REPLACE only).
--
-- ── Bug 1: emails ignore the toggle on non-owner admins' devices ──
--
--   Symptom (reported by Lior): `schedule_email_kinds.creation = false`
--   on group "Poker Night", yet every Sunday auto-created poll still
--   emailed 11 people. email_usage_log confirms it: kind='invitation'
--   at 07:41 / 08:05 / 07:56 / 08:13 / 08:11 — each ~10 min after the
--   07:30 auto-create sweep.
--
--   Root cause: `get_group_settings` has two branches. The owner /
--   super-admin branch returns `row_to_json(s)` — the whole settings
--   row. Everyone else gets an explicit column list, and that list was
--   never updated when migration 090 added `schedule_email_kinds`
--   (nor when 101 added `schedule_default_maybe_hold_hours`).
--
--   So on a NON-OWNER admin's device `toSettings` never populates
--   `scheduleEmailKinds`, and the client gate degrades open:
--
--     const kinds = settings.scheduleEmailKinds;
--     if (!kinds) return true;   // ← "pre-090 snapshot", allow all
--
--   Group "Poker Night" has three non-owner admins (אייל, מלמד, חרדון).
--   Whichever of their tabs wins the race to claim the 'creation' job
--   sends the invitation email, because their browser genuinely has no
--   idea the filter exists. notification_jobs confirms the pattern:
--   the 08-23 07:41 'creation' job has claimed_by set (browser), while
--   server-claimed jobs leave it NULL.
--
--   Fix: return both columns to non-owners too. Neither is sensitive —
--   the branch exists to withhold API KEYS (gemini/elevenlabs, already
--   NULLed explicitly), not notification preferences. Members need
--   the same values admins do so every device gates identically.
--
-- ── Bug 2: "✅ נקבע תאריך" + "🎉 המשחק מלא" arrive as a pair ──
--
--   Both workers can claim poll jobs, but only the browser one dedupes:
--   after dispatching an AT-TARGET 'confirmed' it calls
--   `preempt_target_filled_job` so the redundant "table is full" ping
--   never fires. The server worker (api/notification-worker.ts) has no
--   such call, and its two message builders produce byte-identical
--   bodies — only the title differs.
--
--   Observed on poll edb1d40b (group "Poker Night"), twice in one day:
--     10:02:06 'confirmed'      (claimed_by NULL → server)
--     10:03:09 'target_filled'  (claimed_by set  → browser)
--     10:47:31 'confirmed'      (server)
--     10:47:32 'target_filled'  (browser)   ← one second apart
--
--   The existing 500ms `now() - confirmed_at` debounce inside
--   fn_enqueue_target_filled_on_vote cannot cover this: at 10:47 the
--   two enqueues were a full second apart, so the guard missed by half
--   a second.
--
--   `preempt_target_filled_job` gates on `auth.uid() ∈ group_members`,
--   which is always NULL for the service-role worker, so the worker
--   cannot reuse it. This adds the worker-secret twin, exactly like
--   `complete_notification_job_internal` (migration 066).
-- ============================================================

-- 1. get_group_settings: non-owners see the notification prefs too ----
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
        -- Migration 110: without this key every non-owner device treats
        -- the per-kind filter as absent and emails EVERY kind.
        schedule_email_kinds,
        schedule_default_target,
        schedule_default_delay_hours,
        -- Migration 110: added by 101, never added to this projection —
        -- non-owner admins fell back to the hardcoded 48h in
        -- CreatePollModal instead of the group's configured hold.
        schedule_default_maybe_hold_hours,
        schedule_default_time,
        schedule_default_allow_maybe,
        schedule_auto_create_enabled,
        schedule_auto_create_day,
        schedule_auto_create_time,
        schedule_auto_created_at,
        chip_color_order,
        share_chip_photos,
        chip_entry_default_mode,
        -- API keys stay owner-only. This is the reason the branch exists.
        NULL::text AS gemini_api_key,
        NULL::text AS elevenlabs_api_key
      FROM settings WHERE group_id = p_group_id
    ) t;
  END IF;

  RETURN result;
END;
$function$;

-- 2. Worker-secret twin of preempt_target_filled_job ------------------
-- Same effect as the user-facing RPC (mark any pending/running
-- target_filled job done + stamp the sentinel so no sweep re-enqueues
-- it), but authenticated by the shared worker secret instead of
-- auth.uid(), which is NULL under the service role.
CREATE OR REPLACE FUNCTION public.preempt_target_filled_job_internal(
  p_secret  TEXT,
  p_poll_id UUID
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_expected TEXT;
BEGIN
  SELECT value INTO v_expected FROM worker_config WHERE key = 'notification_worker_secret';
  IF v_expected IS NULL OR v_expected = '' OR p_secret IS NULL OR p_secret <> v_expected THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  UPDATE notification_jobs
     SET status       = 'done',
         completed_at = now(),
         last_error   = 'preempted_by_at_target_confirmed'
   WHERE poll_id = p_poll_id
     AND kind    = 'target_filled'
     AND status IN ('pending','running');

  UPDATE game_polls
     SET target_filled_notifications_sent_at = now()
   WHERE id = p_poll_id
     AND target_filled_notifications_sent_at IS NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.preempt_target_filled_job_internal(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.preempt_target_filled_job_internal(TEXT, UUID) TO service_role;

-- ============================================================
-- DONE — Verify with:
--   -- Non-owner projection now carries both keys:
--   SELECT prosrc LIKE '%schedule_email_kinds%'            AS has_kinds,
--          prosrc LIKE '%schedule_default_maybe_hold_hours%' AS has_hold
--     FROM pg_proc WHERE oid = 'public.get_group_settings'::regproc;
--
--   -- Internal preempt exists and rejects a bad secret:
--   SELECT public.preempt_target_filled_job_internal('wrong', gen_random_uuid());
--     → ERROR: unauthorized
-- ============================================================
