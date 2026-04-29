-- ============================================================
-- Migration 027: Schedule feature — admin-initiated poll deletion
-- Run in Supabase SQL Editor after 024-schedule-roles.sql
-- (Idempotent — uses CREATE OR REPLACE.)
--
-- Why: Up to this point admins could only "cancel" a poll (status →
--   cancelled, row stays for audit). There was no way to permanently
--   remove a poll — useful for cleaning up old completed polls or
--   removing a mis-created poll entirely.
--
-- Notes:
--   * Cascades on the FKs already drop game_poll_dates and
--     game_poll_votes when the parent poll row is deleted, so a single
--     DELETE FROM game_polls handles the whole tree.
--   * confirmed_game_id has ON DELETE SET NULL — deleting the poll has
--     no effect on the linked games table row, by design.
--   * Admin / owner / super-admin only, via is_schedule_admin().
-- ============================================================

CREATE OR REPLACE FUNCTION delete_game_poll(p_poll_id UUID)
RETURNS VOID AS $$
DECLARE
  v_group_id UUID;
BEGIN
  SELECT group_id INTO v_group_id FROM game_polls WHERE id = p_poll_id;
  IF v_group_id IS NULL THEN
    -- Idempotent: deleting an already-removed poll is a no-op.
    RETURN;
  END IF;

  IF NOT is_schedule_admin(v_group_id) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  DELETE FROM game_polls WHERE id = p_poll_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION delete_game_poll(UUID) TO authenticated;

-- ============================================================
-- DONE — Verify with:
--   SELECT delete_game_poll('<poll-id>'::uuid);
--   SELECT count(*) FROM game_polls WHERE id = '<poll-id>'::uuid;  -- 0
-- ============================================================
