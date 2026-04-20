-- Add training_pool and training_insights to Realtime publication
-- (training_answers was already added in schema.sql)

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'training_pool'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE training_pool;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'training_insights'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE training_insights;
  END IF;
END $$;
