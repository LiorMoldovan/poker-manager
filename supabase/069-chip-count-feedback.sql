-- ============================================================
-- Migration 069: chip_count_feedback — accuracy feedback loop
-- Run after 068-fix-http-post-schema.sql.
-- (Idempotent — safe to re-run.)
--
-- WHY this exists
-- ───────────────
-- The photo chip-counting feature (v5.47–v5.49) is a probabilistic
-- AI estimator. We can keep tuning prompts and aggregation math
-- forever, but without REAL GROUND-TRUTH DATA we're guessing about
-- the failure modes. This migration creates the storage layer for
-- a silent feedback loop: every time a user accepts (or edits) the
-- AI's chip counts in the real game flow, we record the diff
-- between (what the AI suggested) and (what the user actually
-- saved) so a developer can periodically mine the data and tune
-- the pipeline empirically instead of by intuition.
--
-- WHAT this adds
--   1. Public table `chip_count_feedback`:
--        - One row per AI-photo-driven save (per player per game).
--        - Per-stack data lives in a JSONB array (chipId, color,
--          position, value, aiCount, realCount, delta, wasCorrect,
--          plus diagnostic fields from the AI run).
--        - Aggregate stats denormalized (total_stacks,
--          correct_stacks, total_chip_delta, total_abs_delta) so
--          dashboards / mining queries don't have to unnest JSONB.
--   2. RLS policies:
--        - INSERT: any authenticated member of the group can
--          submit feedback for that group.
--        - SELECT / DELETE: group owner OR super admin only
--          (these rows are debugging data, not member-visible).
--   3. New column on `settings`: `share_chip_photos BOOLEAN
--      DEFAULT false`. Owner opt-in. When true, the in-app
--      feedback flow uploads the enhanced photo to the new
--      private storage bucket so the developer can replay the
--      exact image the model saw. When false (default), only
--      anonymous-ish numeric data is captured.
--   4. PRIVATE storage bucket `chip-count-feedback-photos` with
--      path layout `{group_id}/{feedback_id}.jpg`. Group members
--      can write into their own group's folder; only owner +
--      super admin can read or delete.
--
-- Privacy posture
-- ───────────────
-- Default behavior is "numeric data only". Photos require an
-- explicit opt-in toggle by the group OWNER (not just any admin).
-- Even when opted-in, photos are NEVER public — the bucket is
-- private and reads are restricted to owner + super admin.
-- ============================================================

-- ── 1. The feedback table ──

CREATE TABLE IF NOT EXISTS public.chip_count_feedback (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id             UUID        NOT NULL REFERENCES public.groups(id)  ON DELETE CASCADE,
  -- nullable so historic rows survive user/player/game deletion
  user_id              UUID        REFERENCES auth.users(id)              ON DELETE SET NULL,
  game_id              UUID        REFERENCES public.games(id)            ON DELETE SET NULL,
  player_id            UUID        REFERENCES public.players(id)          ON DELETE SET NULL,
  -- denormalized human label so a deleted player's feedback is
  -- still readable in mining queries ("which player's chips
  -- caused most undercount?")
  player_name          TEXT,
  -- when the feedback was captured client-side
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- ── AI run metadata ──
  -- e.g. 'gemini-2.5-pro×3' (model + shot count, as set by combineShots)
  model_used           TEXT        NOT NULL,
  -- 0..100, the externally-computed overall confidence we displayed
  overall_confidence   INTEGER     NOT NULL,
  -- how many parallel shots returned usable data (1, 2, or 3 at present)
  shots_used           INTEGER     NOT NULL DEFAULT 1,

  -- ── Game context (NULL for test-card feedback) ──
  -- (rebuys * chips_per_rebuy) — the canonical "expected total
  -- chip points" the player should have when they cash out.
  expected_total_value INTEGER,
  rebuys               INTEGER,
  chips_per_rebuy      INTEGER,

  -- ── Per-stack JSONB ──
  -- Array of objects, one per chip color reported in the photo:
  --   {
  --     chipId:           string,    -- ChipValue.id
  --     color:            string,    -- canonical color name
  --     position:         number,    -- 1-indexed left→right (canonical order)
  --     value:            number,    -- chip denomination
  --     aiCount:          number,    -- what the AI said
  --     realCount:        number,    -- what the user actually saved
  --     delta:            number,    -- realCount - aiCount  (positive = AI undercounted)
  --     wasCorrect:       boolean,
  --     -- AI-side diagnostics (optional, may be missing on legacy shots):
  --     aiConfidence?:    number,    -- per-stack computed confidence 0..100
  --     aiColorMatch?:    boolean,   -- did model's topColorHex match expected
  --     aiNeedsRecount?:  boolean,   -- model flagged this stack
  --     aiTopColorHex?:   string,    -- '#RRGGBB' the model said it saw
  --     aiRawCounts?:     number[]   -- per-shot counts from the multi-shot call
  --   }
  stacks               JSONB       NOT NULL,

  -- ── Aggregate stats (denormalized for mining queries) ──
  total_stacks         INTEGER     NOT NULL,
  correct_stacks       INTEGER     NOT NULL,
  -- signed sum of (realCount - aiCount) across all stacks
  --   positive overall ⇒ AI tends to UNDERCOUNT this group's chips
  --   negative overall ⇒ AI tends to OVERCOUNT
  total_chip_delta     INTEGER     NOT NULL,
  -- absolute sum of |realCount - aiCount| — total chip-units of error
  total_abs_delta      INTEGER     NOT NULL,

  -- ── Photo storage (opt-in only) ──
  -- Path within `chip-count-feedback-photos` bucket, e.g.
  -- '{group_id}/{feedback_id}.jpg'. NULL when share_chip_photos
  -- was false at capture time, or upload failed (we still record
  -- the numeric feedback in that case).
  photo_path           TEXT,
  -- Snapshot of the consent flag at capture time. Future-proofs
  -- against the owner toggling the setting later — we always know
  -- whether THIS particular photo was uploaded with consent.
  photo_consented      BOOLEAN     NOT NULL DEFAULT false,

  -- Sanity checks
  CONSTRAINT chip_count_feedback_overall_conf_range  CHECK (overall_confidence BETWEEN 0 AND 100),
  CONSTRAINT chip_count_feedback_shots_used_range    CHECK (shots_used BETWEEN 1 AND 5),
  CONSTRAINT chip_count_feedback_correct_le_total    CHECK (correct_stacks BETWEEN 0 AND total_stacks)
);

-- Most queries will be "give me this group's recent feedback rows"
-- or "give me ALL feedback rows globally for analysis".
CREATE INDEX IF NOT EXISTS chip_count_feedback_group_created_idx
  ON public.chip_count_feedback (group_id, created_at DESC);

CREATE INDEX IF NOT EXISTS chip_count_feedback_created_idx
  ON public.chip_count_feedback (created_at DESC);

-- ── 2. RLS ──

ALTER TABLE public.chip_count_feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "chip_count_feedback_insert"        ON public.chip_count_feedback;
DROP POLICY IF EXISTS "chip_count_feedback_select_owner"  ON public.chip_count_feedback;
DROP POLICY IF EXISTS "chip_count_feedback_select_super"  ON public.chip_count_feedback;
DROP POLICY IF EXISTS "chip_count_feedback_delete_owner"  ON public.chip_count_feedback;
DROP POLICY IF EXISTS "chip_count_feedback_delete_super"  ON public.chip_count_feedback;

-- INSERT: any authenticated member of the group may submit feedback
-- for THAT group. (We don't gate on role — every member who reaches
-- ChipEntryScreen as an admin already passed the admin gate in the
-- UI, but a member who somehow triggers the path is allowed too;
-- the data is anonymous-ish numeric diffs.)
CREATE POLICY "chip_count_feedback_insert"
  ON public.chip_count_feedback
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.group_members gm
       WHERE gm.group_id = chip_count_feedback.group_id
         AND gm.user_id  = auth.uid()
    )
  );

-- SELECT: group OWNER (groups.created_by) OR super admin.
-- Two separate policies so the planner can short-circuit cleanly.
CREATE POLICY "chip_count_feedback_select_owner"
  ON public.chip_count_feedback
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.groups g
       WHERE g.id = chip_count_feedback.group_id
         AND g.created_by = auth.uid()
    )
  );

CREATE POLICY "chip_count_feedback_select_super"
  ON public.chip_count_feedback
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.super_admins sa
       WHERE sa.user_id = auth.uid()
    )
  );

-- DELETE: same gate as SELECT (owner OR super admin).
CREATE POLICY "chip_count_feedback_delete_owner"
  ON public.chip_count_feedback
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.groups g
       WHERE g.id = chip_count_feedback.group_id
         AND g.created_by = auth.uid()
    )
  );

CREATE POLICY "chip_count_feedback_delete_super"
  ON public.chip_count_feedback
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.super_admins sa
       WHERE sa.user_id = auth.uid()
    )
  );

-- ── 3. settings.share_chip_photos opt-in ──

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS share_chip_photos BOOLEAN NOT NULL DEFAULT false;

-- ── 4. PRIVATE storage bucket for opt-in photos ──

INSERT INTO storage.buckets (id, name, public)
VALUES ('chip-count-feedback-photos', 'chip-count-feedback-photos', false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- Storage RLS — path layout '{group_id}/{feedback_id}.jpg', so
-- storage.foldername(name)[1] = '{group_id}'.

DROP POLICY IF EXISTS "ccfp_member_insert"     ON storage.objects;
DROP POLICY IF EXISTS "ccfp_owner_select"      ON storage.objects;
DROP POLICY IF EXISTS "ccfp_super_select"      ON storage.objects;
DROP POLICY IF EXISTS "ccfp_owner_delete"      ON storage.objects;
DROP POLICY IF EXISTS "ccfp_super_delete"      ON storage.objects;

-- Insert: any authenticated member of the group whose folder this
-- file belongs to. Mirror of the table INSERT policy.
CREATE POLICY "ccfp_member_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'chip-count-feedback-photos'
    AND EXISTS (
      SELECT 1 FROM public.group_members gm
       WHERE gm.user_id = auth.uid()
         AND gm.group_id::text = (storage.foldername(name))[1]
    )
  );

-- Read: group owner of the folder.
CREATE POLICY "ccfp_owner_select"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'chip-count-feedback-photos'
    AND EXISTS (
      SELECT 1 FROM public.groups g
       WHERE g.id::text = (storage.foldername(name))[1]
         AND g.created_by = auth.uid()
    )
  );

-- Read: super admin (any group).
CREATE POLICY "ccfp_super_select"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'chip-count-feedback-photos'
    AND EXISTS (
      SELECT 1 FROM public.super_admins sa
       WHERE sa.user_id = auth.uid()
    )
  );

-- Delete: same as read.
CREATE POLICY "ccfp_owner_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'chip-count-feedback-photos'
    AND EXISTS (
      SELECT 1 FROM public.groups g
       WHERE g.id::text = (storage.foldername(name))[1]
         AND g.created_by = auth.uid()
    )
  );

CREATE POLICY "ccfp_super_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'chip-count-feedback-photos'
    AND EXISTS (
      SELECT 1 FROM public.super_admins sa
       WHERE sa.user_id = auth.uid()
    )
  );

-- ============================================================
-- DONE — Verify with:
--
--   SELECT table_name, column_name FROM information_schema.columns
--    WHERE table_name = 'chip_count_feedback' ORDER BY ordinal_position;
--
--   SELECT polname FROM pg_policy
--     JOIN pg_class ON pg_class.oid = pg_policy.polrelid
--    WHERE relname = 'chip_count_feedback' ORDER BY polname;
--
--   SELECT id, public FROM storage.buckets
--    WHERE id = 'chip-count-feedback-photos';
--
--   SELECT polname FROM pg_policy
--     JOIN pg_class ON pg_class.oid = pg_policy.polrelid
--    WHERE relname = 'objects' AND polname LIKE 'ccfp_%' ORDER BY polname;
--
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'settings' AND column_name = 'share_chip_photos';
-- ============================================================
