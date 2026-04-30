-- ============================================================
-- Migration 036: Allow admins to cancel confirmed polls
-- Run in Supabase SQL Editor after 035-fix-zero-sum-trigger.sql
-- (Idempotent — uses CREATE OR REPLACE.)
--
-- Why: Until now `cancel_game_poll` only fired while the poll was
--   `status IN ('open', 'expanded')`. Once a poll auto-confirmed,
--   the admin's only way to back out was the destructive `delete`
--   action — which removes the poll entirely (no cancellation
--   notification, no audit trail). The real-world need is: a few
--   players drop after the lock-in, the game is no longer viable,
--   the admin wants to PULL THE PLUG and let everyone know why.
--   That's exactly what the cancellation flow is for; it just
--   needs to be reachable from the confirmed state.
--
-- Behavior:
--   * cancel_game_poll now accepts `status IN ('open', 'expanded',
--     'confirmed')`. Already-cancelled / expired polls remain a
--     no-op (no row matches the WHERE), so calling cancel on them
--     is harmless.
--   * Admin auth check (is_schedule_admin) is unchanged — only
--     schedule admins / owners / super-admins can cancel.
--   * The cancellation reason and the existing client-side
--     `sendCancellationNotifications` flow keep working as-is —
--     they're status-agnostic and just react to the row update.
--   * No data migration. Existing rows are unaffected; this is a
--     pure RPC behavior change.
--
-- UI counterpart: src/components/ScheduleTab.tsx now also renders
--   the Cancel button when poll.status === 'confirmed'. Both sides
--   need to be deployed together — the SQL grants permission, the
--   UI surfaces the affordance.
-- ============================================================

CREATE OR REPLACE FUNCTION cancel_game_poll(
  p_poll_id  UUID,
  p_reason   TEXT DEFAULT NULL
)
RETURNS VOID AS $$
DECLARE
  v_group_id UUID;
BEGIN
  SELECT group_id INTO v_group_id FROM game_polls WHERE id = p_poll_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'invalid_poll';
  END IF;

  IF NOT is_schedule_admin(v_group_id) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  UPDATE game_polls
     SET status = 'cancelled',
         cancellation_reason = NULLIF(TRIM(p_reason), '')
   WHERE id = p_poll_id
     AND status IN ('open', 'expanded', 'confirmed');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================
-- DONE — Verify with:
--   -- A confirmed poll's id; should now succeed and flip to cancelled.
--   SELECT cancel_game_poll('<confirmed_poll_id>'::uuid, 'too many drops');
--
--   -- A non-admin caller; should still raise 'not_admin'.
--   SELECT cancel_game_poll('<any_poll_id>'::uuid);
-- ============================================================
