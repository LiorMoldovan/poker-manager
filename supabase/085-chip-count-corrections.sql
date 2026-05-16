-- 085-chip-count-corrections.sql
--
-- Ground-truth feedback table for the photo chip-count pipeline.
--
-- Why this exists:
--   The whole-photo Gemini call gives wrong counts often enough that we
--   need a fast, in-session correction loop. Lior takes a test photo,
--   AI returns counts, Lior corrects the wrong numbers and saves the
--   ground truth. The agent later reads the rows directly via the
--   Supabase MCP, looks at the photos + the deltas, and iterates the
--   prompt (or attaches the cleanest photos as few-shot examples).
--
--   This is NOT the old "auto-tuning" loop from `chip_count_feedback`
--   that v5.62.2 retired. The new loop is human-in-the-loop: the agent
--   reads, the agent thinks, the agent ships a prompt change. The app
--   just collects the evidence.
--
-- Privacy posture:
--   * `photo_base64` stores the enhanced JPEG that was actually sent to
--     Gemini (NOT the raw camera file). Members opted in implicitly by
--     tapping "save correct count" — this is the corrections card on
--     the Settings test screen, not a silent collector.
--   * No auth tokens or API keys.
--   * Counts are user-entered integers; no PII.
--
-- Storage shape:
--   * One row = one correction = one photo + AI's guess + Lior's truth.
--   * Expected volume: 10-50 rows total before the next prompt iteration.
--     Tiny. Don't worry about table size yet.
--   * Photos are base64 in a TEXT column (~400KB each post-enhance).
--     If we ever want to scale this beyond a hundred rows we move to
--     the existing `chip-count-feedback-photos` Storage bucket and
--     keep a path here. Not worth the complexity now.

CREATE TABLE IF NOT EXISTS public.chip_count_corrections (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id                UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id                 UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Pipeline metadata (what produced ai_counts)
  app_version             TEXT,
  model                   TEXT,                    -- whichever Gemini model returned the counts
  context                 TEXT NOT NULL DEFAULT 'settings-test', -- where the correction came from
  selfies_attached        INT,                     -- how many reference selfies were sent at AI-call time

  -- The evidence
  photo_base64            TEXT NOT NULL,           -- enhanced JPEG (data, no data-URL prefix)
  photo_mime_type         TEXT NOT NULL DEFAULT 'image/jpeg',
  photo_byte_count        INT,                     -- length of photo_base64 (for sanity / pagination)

  -- The labels
  chip_colors_configured  TEXT[],                  -- what the group had configured at correction time
  ai_counts               JSONB NOT NULL,          -- { color: count } as the model returned
  truth_counts            JSONB NOT NULL,          -- { color: count } as Lior corrected
  total_diff              INT,                     -- sum |truth-ai| across colors; ai = truth = 0 means AI was perfect

  -- Optional free-text notes (unused at v1, kept for future)
  notes                   TEXT
);

CREATE INDEX IF NOT EXISTS chip_count_corrections_group_created_idx
  ON public.chip_count_corrections(group_id, created_at DESC);

-- Enable RLS. Same pattern as chip_count_debug (081):
--   * INSERT: any authenticated group member
--   * SELECT: group admins + owner (so they can review their own)
--           + super admins (so the agent's MCP query works)
--   * DELETE: super admin only
ALTER TABLE public.chip_count_corrections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chip_count_corrections_insert ON public.chip_count_corrections;
CREATE POLICY chip_count_corrections_insert
  ON public.chip_count_corrections
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.group_members gm
      WHERE gm.group_id = chip_count_corrections.group_id
        AND gm.user_id  = auth.uid()
    )
  );

DROP POLICY IF EXISTS chip_count_corrections_select_admin ON public.chip_count_corrections;
CREATE POLICY chip_count_corrections_select_admin
  ON public.chip_count_corrections
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.group_members gm
      WHERE gm.group_id = chip_count_corrections.group_id
        AND gm.user_id  = auth.uid()
        AND gm.role     = 'admin'
    )
    OR EXISTS (
      SELECT 1 FROM public.groups g
      WHERE g.id         = chip_count_corrections.group_id
        AND g.created_by = auth.uid()
    )
  );

DROP POLICY IF EXISTS chip_count_corrections_select_super ON public.chip_count_corrections;
CREATE POLICY chip_count_corrections_select_super
  ON public.chip_count_corrections
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.super_admins sa
      WHERE sa.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS chip_count_corrections_delete_super ON public.chip_count_corrections;
CREATE POLICY chip_count_corrections_delete_super
  ON public.chip_count_corrections
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.super_admins sa
      WHERE sa.user_id = auth.uid()
    )
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'chip_count_corrections'
  ) THEN
    RAISE EXCEPTION 'chip_count_corrections table was not created';
  END IF;
END $$;
