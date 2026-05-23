-- ============================================================================
-- supabase/092-schedule-email-kind-atomic-merge.sql
--
-- 2026-05-23 — Fix the lost-update race on settings.schedule_email_kinds.
--
-- Context (Lior, May 21 incident):
--   The per-event email allowlist shipped in migration 090 / v6.8.7. Two days
--   later Lior received a `creation` invitation email even though the current
--   group setting reads `schedule_email_kinds.creation = false`. Forensics
--   ruled out an unfired server gate (the deployed bundle has the gate;
--   offline simulator passes 132/132). The settings table has no audit
--   trail, so we cannot prove WHEN `creation` flipped to false. But there is
--   one real failure mode that fits the timeline: a classic last-write-wins
--   stale-state overwrite.
--
-- The bug, in words:
--   * `settings` is one row per group, not per user. Both admins share it.
--   * The client's `settingsToRow` always serialises the FULL 7-key
--     schedule_email_kinds object from local state on every settings upsert.
--   * Any unrelated settings change (push toggle, default target, auto-create
--     time, etc.) carries the local cache's snapshot of schedule_email_kinds
--     along for the ride.
--   * If admin B's local cache is stale (hasn't yet received admin A's
--     realtime echo for creation:false), and admin B touches ANY field in
--     Settings, B's upsert silently rewrites the JSONB column from B's
--     stale view — reverting A's choice. No error, no warning.
--   * Eyal sat on the Settings screen at 19:47:13 IL on May 21, 58 seconds
--     before opening the poll that fired the email. The lost-update fits.
--
-- The fix has two halves:
--   1. (this migration) Add a single-key atomic merge RPC that mutates ONE
--      key of schedule_email_kinds via jsonb_set on the live row. No
--      possibility of stomping unrelated keys, ever.
--   2. (client/cache code) Stop including schedule_email_kinds in the
--      generic settingsToRow upsert payload. The dedicated RPC becomes the
--      ONLY write path to this column. Other settings writes leave it
--      untouched in the DB even if local state is stale.
--
-- Layered defenses:
--   * Whitelist of allowed kinds inside the RPC blocks arbitrary JSONB key
--     injection. An attacker can't smuggle in `{"admin":true}` or similar.
--   * SECURITY DEFINER + manual admin check mirrors the existing
--     `settings_admin` RLS policy. Super admins also pass.
--   * jsonb_set with create_missing=true tolerates a settings row whose
--     column was somehow stripped to {} (defensive).
--
-- Idempotent: CREATE OR REPLACE. Safe to re-apply.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.update_schedule_email_kind(
  p_group_id UUID,
  p_kind     TEXT,
  p_value    BOOLEAN
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_allowed BOOLEAN;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated';
  END IF;

  -- Whitelist the seven known kinds so a compromised client can't write
  -- arbitrary keys into the JSONB blob (no `{"super":true}` injections).
  IF p_kind NOT IN (
    'creation', 'expanded', 'confirmed', 'target_filled',
    'cancellation', 'reminder', 'date_excluded'
  ) THEN
    RAISE EXCEPTION 'invalid email kind: %', p_kind;
  END IF;

  -- Admin of the target group OR platform super admin. Mirrors the
  -- existing settings_admin + super_admins_full_access RLS policies.
  SELECT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = p_group_id
      AND user_id  = v_uid
      AND role     = 'admin'
  ) OR EXISTS (
    SELECT 1 FROM public.super_admins WHERE user_id = v_uid
  ) INTO v_allowed;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'not authorised to modify settings of group %', p_group_id;
  END IF;

  -- Atomic single-key merge. create_missing=true handles the (defensive)
  -- case of a settings row whose column was somehow stripped to {}.
  UPDATE public.settings
     SET schedule_email_kinds = jsonb_set(
           COALESCE(schedule_email_kinds, '{}'::jsonb),
           ARRAY[p_kind],
           to_jsonb(p_value),
           true
         )
   WHERE group_id = p_group_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no settings row for group %', p_group_id;
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.update_schedule_email_kind(UUID, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_schedule_email_kind(UUID, TEXT, BOOLEAN) TO authenticated;

COMMENT ON FUNCTION public.update_schedule_email_kind(UUID, TEXT, BOOLEAN) IS
  'Atomically flips ONE key of settings.schedule_email_kinds via jsonb_set. '
  'The only sanctioned write path to this column from client code — the '
  'generic settings upsert no longer touches the column, preventing a stale '
  'admin session from overwriting another admin''s per-kind toggle. '
  'Migration 092 (2026-05-23).';
