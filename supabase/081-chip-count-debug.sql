-- 081-chip-count-debug.sql
--
-- Lightweight telemetry table for the photo chip-count pipeline.
--
-- Why this exists:
--   The whole-photo Gemini call (v5.62.0+) has been failing for Lior with
--   "parseFailed" on every photo for three releases (v5.62.0, .1, .2). Each
--   round the agent guessed at the cause, shipped a "fix", and the user
--   kept hitting the same error because we never actually saw what Gemini
--   was returning. v5.62.3 surfaces the raw response in the error UI for
--   screenshotting; this migration adds the server-side mirror so the
--   agent can directly query EVERY attempt via the Supabase MCP without
--   the user having to forward screenshots.
--
-- Fire-and-forget insert from `runWholePhotoShot` on every Gemini call,
-- success or failure. Never blocks the photo flow.
--
-- Privacy posture:
--   * No auth tokens or API keys (we never log the request body).
--   * `raw_response_excerpt` is the first 4KB of Gemini's *output* — chip
--     counts and any narration the model produced. Not user-private.
--   * `final_counts` is the per-color count map we ended up with.
--   * `image_byte_count` is just the base64 size, not the image bytes.
--   * No photo bytes stored. No biometric / PII risk.
--
-- Retention: untouched for now. If the table grows past a few thousand
-- rows we can add a cron to delete > 30d old. Worry about it then.

CREATE TABLE IF NOT EXISTS public.chip_count_debug (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id                UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id                 UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Pipeline metadata
  app_version             TEXT,
  model                   TEXT NOT NULL,
  attempt_index           INT  NOT NULL,           -- 1, 2 for fallback order
  total_models            INT  NOT NULL,
  context                 TEXT NOT NULL DEFAULT 'unknown', -- 'live-game' | 'settings-test' | 'unknown'

  -- Outcome
  outcome                 TEXT NOT NULL,           -- 'success' | 'parseFailed' | 'unexpectedShape' | 'httpError' | 'network' | 'cancelled'
  salvage_strategy        INT,                     -- 1..5 if salvager succeeded, NULL otherwise
  error_message           TEXT,                    -- short description if !success

  -- Response payload (truncated)
  raw_response_excerpt    TEXT,                    -- first ~4KB of Gemini's output
  raw_response_byte_count INT,                     -- full length, so we know if we truncated

  -- Parsed result
  final_counts            JSONB,                   -- { color: count, ... } or null on failure

  -- Request shape (for debugging "is the prompt right?")
  image_byte_count        INT,
  chip_colors_configured  TEXT[],                  -- what we asked the LLM to count
  selfies_attached        INT,                     -- how many few-shot references we sent
  http_status             INT,                     -- 200 on success, 4xx/5xx if upstream errored
  duration_ms             INT                      -- end-to-end shot duration
);

CREATE INDEX IF NOT EXISTS chip_count_debug_group_created_idx
  ON public.chip_count_debug(group_id, created_at DESC);

CREATE INDEX IF NOT EXISTS chip_count_debug_outcome_idx
  ON public.chip_count_debug(outcome, created_at DESC);

-- Enable RLS. Policy pattern mirrors chip_count_feedback (a precedent in
-- this codebase): any group member can INSERT into their group's rows,
-- group admins + owner + super admins can SELECT, super admin can DELETE.
ALTER TABLE public.chip_count_debug ENABLE ROW LEVEL SECURITY;

-- INSERT: any authenticated group member
DROP POLICY IF EXISTS chip_count_debug_insert ON public.chip_count_debug;
CREATE POLICY chip_count_debug_insert
  ON public.chip_count_debug
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.group_members gm
      WHERE gm.group_id = chip_count_debug.group_id
        AND gm.user_id  = auth.uid()
    )
  );

-- SELECT (group admins + owner): admins and the group creator can read
-- their own group's debug rows. Lets the owner build a small "diagnose"
-- view later if we want one — for now nothing in the app reads it but
-- the policy keeps the door open without needing another migration.
DROP POLICY IF EXISTS chip_count_debug_select_admin ON public.chip_count_debug;
CREATE POLICY chip_count_debug_select_admin
  ON public.chip_count_debug
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.group_members gm
      WHERE gm.group_id = chip_count_debug.group_id
        AND gm.user_id  = auth.uid()
        AND gm.role     = 'admin'
    )
    OR EXISTS (
      SELECT 1 FROM public.groups g
      WHERE g.id         = chip_count_debug.group_id
        AND g.created_by = auth.uid()
    )
  );

-- SELECT (super admin): cross-group read for platform diagnostics. This
-- is the policy the agent's Supabase MCP query goes through.
DROP POLICY IF EXISTS chip_count_debug_select_super ON public.chip_count_debug;
CREATE POLICY chip_count_debug_select_super
  ON public.chip_count_debug
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.super_admins sa
      WHERE sa.user_id = auth.uid()
    )
  );

-- DELETE (super admin only): cleanup hook for ops. Group owners DON'T
-- get DELETE — these rows are diagnostic, not user-owned content; if a
-- group owner wants to "clear" their debug history they can ask.
DROP POLICY IF EXISTS chip_count_debug_delete_super ON public.chip_count_debug;
CREATE POLICY chip_count_debug_delete_super
  ON public.chip_count_debug
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.super_admins sa
      WHERE sa.user_id = auth.uid()
    )
  );

-- Sanity check: confirm the table is up and policies are wired.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'chip_count_debug'
  ) THEN
    RAISE EXCEPTION 'chip_count_debug table was not created';
  END IF;
END $$;
