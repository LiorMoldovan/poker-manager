-- Migration 070: Chip-count tuning overrides
--
-- Stores LLM-generated runtime overrides for the chip-counting prompt.
-- Owner clicks "Tune Now" in Settings → another LLM call reads the
-- accumulated chip_count_feedback rows and writes an improved prompt
-- strategy → it gets persisted here as a new versioned row.
--
-- The chip-count call (`countChipsFromPhoto` in `geminiAI.ts`) reads
-- the LATEST row for the group at request time and uses its
-- `prompt_strategy` text in place of the hardcoded default. If
-- `prompt_strategy` is NULL on the latest row, the hardcoded default
-- is used (this is how "revert to default" is implemented — by
-- inserting a NULL-strategy row, not by deleting history).
--
-- Architecture choice: we keep full history (no DELETE). Every tune
-- and every revert is a row, so the owner can audit "we were on
-- v3 from May 5-7, then auto-tune produced v4 which made things
-- worse, owner reverted to default on May 8, then tried again on
-- May 10 and got v5 which is the current active strategy."

CREATE TABLE IF NOT EXISTS public.chip_count_tuning_overrides (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id                 UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by               UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  -- The actual override content. NULL = "use hardcoded default in
  -- geminiAI.ts" (this is how revert is encoded). Non-null = use
  -- this text verbatim as the CRITICAL-counting-strategy block.
  prompt_strategy          TEXT,

  -- Tuning metadata: which feedback rows were the input?
  -- baseline_* lets us measure "did the new prompt actually do better
  -- than the old one?" once enough new feedback rows accumulate after
  -- the apply (future auto-rollback feature).
  baseline_avg_abs_delta   NUMERIC,
  baseline_sample_count    INTEGER NOT NULL DEFAULT 0,

  -- Human-readable summary the tuner LLM produces alongside the
  -- prompt. Surfaced in the version history UI so the owner can
  -- understand what each tune was attempting to fix.
  description              TEXT,

  -- Which model wrote this override (for future analysis of
  -- "did Pro-written tunes outperform Flash-written tunes?").
  model_used_for_tuning    TEXT
);

-- Latest-active lookup is the hot read path (every photo count call
-- in the real-game flow runs this query). Index on (group_id,
-- created_at DESC) makes it a single index seek + heap fetch.
CREATE INDEX IF NOT EXISTS idx_cctun_group_created
  ON public.chip_count_tuning_overrides(group_id, created_at DESC);

ALTER TABLE public.chip_count_tuning_overrides ENABLE ROW LEVEL SECURITY;

-- SELECT: any authenticated group member. The chip-count call needs
-- to read the active override at request time, and members run that
-- call during real games, so they need SELECT. Super admin can also
-- read for cross-group analysis.
DROP POLICY IF EXISTS chip_count_tuning_select ON public.chip_count_tuning_overrides;
CREATE POLICY chip_count_tuning_select
  ON public.chip_count_tuning_overrides
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.group_members gm
      WHERE gm.group_id = chip_count_tuning_overrides.group_id
        AND gm.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.super_admins sa
      WHERE sa.user_id = auth.uid()
    )
  );

-- INSERT: owner only (group creator). Tuning is a privileged action
-- because it changes how the AI behaves for everyone in the group.
-- We allow super admin too so cross-group debugging is possible.
DROP POLICY IF EXISTS chip_count_tuning_insert ON public.chip_count_tuning_overrides;
CREATE POLICY chip_count_tuning_insert
  ON public.chip_count_tuning_overrides
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.groups g
      WHERE g.id = chip_count_tuning_overrides.group_id
        AND g.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.super_admins sa
      WHERE sa.user_id = auth.uid()
    )
  );

-- No UPDATE policy on purpose. Overrides are immutable. Mutation =
-- insert a new row. Keeps the audit trail clean.

-- No DELETE policy on purpose either. Even reverts are inserts (a
-- row with prompt_strategy = NULL means "use default"). This lets
-- us reconstruct the full timeline of "what was the active strategy
-- between time X and time Y" for any debugging.

COMMENT ON TABLE public.chip_count_tuning_overrides IS
  'Versioned runtime overrides for the chip-counting prompt. Latest row per group_id wins; NULL prompt_strategy means use the hardcoded default in geminiAI.ts. Migration 070.';
COMMENT ON COLUMN public.chip_count_tuning_overrides.prompt_strategy IS
  'Replaces the CRITICAL-counting-strategy block of the chip-count prompt. NULL = use hardcoded default (this is how revert is encoded).';
COMMENT ON COLUMN public.chip_count_tuning_overrides.baseline_avg_abs_delta IS
  'Average chip_count_feedback.total_abs_delta computed over the feedback rows that were the input to this tune. Used by the future auto-rollback to detect "this tune made things worse".';
