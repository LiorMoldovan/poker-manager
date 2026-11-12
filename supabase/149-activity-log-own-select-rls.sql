-- Allow authenticated users to SELECT their own activity_log rows.
-- Previously al_admin_read was the only SELECT policy for non-super-admins,
-- so PostgreSQL RLS silently matched 0 rows when regular members ran
-- UPDATE ... WHERE device_id = ... AND timestamp = ... to record
-- screens_visited, session_duration, and last_active.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'activity_log'
      AND policyname = 'al_own_read'
  ) THEN
    CREATE POLICY al_own_read ON public.activity_log
      FOR SELECT
      USING (user_id = (SELECT auth.uid()));
  END IF;
END $$;

