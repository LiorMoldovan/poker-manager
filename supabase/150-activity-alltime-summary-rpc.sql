-- Read-only per-user all-time activity summary for the Settings -> Activity tab.
-- Fixes the limitation where client-side fetchActivityLog (MAX_LOG_ENTRIES = 1000)
-- truncated "All Time" totals and hid members whose last visit fell outside the
-- latest 1,000 rows. Caps each session at 180 min so legacy backgrounded-tab
-- outliers do not inflate lifetime totals.

CREATE OR REPLACE FUNCTION public.get_group_activity_summary(p_group_id UUID)
RETURNS TABLE (
  user_id UUID,
  total_sessions BIGINT,
  total_unique_days BIGINT,
  total_minutes BIGINT,
  last_active_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (
    EXISTS (SELECT 1 FROM groups g WHERE g.id = p_group_id AND g.created_by = auth.uid())
    OR EXISTS (SELECT 1 FROM super_admins sa WHERE sa.user_id = auth.uid())
  ) THEN
    RAISE EXCEPTION 'Only the group owner or super admin can view group activity summary';
  END IF;

  RETURN QUERY
  SELECT
    al.user_id,
    COUNT(*)::BIGINT AS total_sessions,
    COUNT(DISTINCT (COALESCE(al.last_active, al.timestamp) AT TIME ZONE 'Asia/Jerusalem')::DATE)::BIGINT AS total_unique_days,
    COALESCE(SUM(LEAST(GREATEST(COALESCE(al.session_duration, 0), 0), 180)), 0)::BIGINT AS total_minutes,
    MAX(COALESCE(al.last_active, al.timestamp)) AS last_active_at
  FROM activity_log al
  WHERE al.group_id = p_group_id
    AND al.user_id IS NOT NULL
  GROUP BY al.user_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_group_activity_summary(UUID) TO authenticated;
