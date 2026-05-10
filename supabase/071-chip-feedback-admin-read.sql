-- ============================================================================
-- 071-chip-feedback-admin-read.sql
-- ============================================================================
-- Loosen SELECT on chip_count_feedback so all admins of a group (not just the
-- owner) can read the feedback rows. This is what powers the "Chip Counting
-- Accuracy" dashboard in Settings.
--
-- WHY: Lior is the owner of his group; Eyal is an admin. Lior asked for Eyal
-- to also be able to test the photo chip-counting feature (the test card +
-- dashboard live in Settings → Chip Counting). Without this loosening, Eyal
-- would see the test card but the dashboard would be empty for him because
-- RLS filtered out every row.
--
-- KEEP UNCHANGED:
--   * INSERT — already open to any group member, so admins (and members)
--     can already submit feedback rows from their own test photos.
--   * DELETE — owner-only stays owner-only (admins should not be able to
--     wipe accuracy history).
--   * super_admin SELECT policy — orthogonal, kept intact.
--
-- Tune button (chip_count_tuning_overrides INSERT) is intentionally NOT
-- loosened here — it stays owner-only in DB. The UI matches by disabling
-- the Tune / Revert buttons for non-owner admins.
-- ============================================================================

-- Replace the owner-only SELECT with an admin+owner SELECT.
-- (Owner is always group_members admin via the existing role flow, but we
-- also fall back to groups.created_by to be defensive in case an owner is
-- ever marked as 'member' for some reason.)
DROP POLICY IF EXISTS chip_count_feedback_select_owner ON public.chip_count_feedback;

CREATE POLICY chip_count_feedback_select_admin
  ON public.chip_count_feedback
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM public.group_members gm
      WHERE gm.group_id = chip_count_feedback.group_id
        AND gm.user_id  = auth.uid()
        AND gm.role     = 'admin'
    )
    OR EXISTS (
      SELECT 1
      FROM public.groups g
      WHERE g.id         = chip_count_feedback.group_id
        AND g.created_by = auth.uid()
    )
  );
