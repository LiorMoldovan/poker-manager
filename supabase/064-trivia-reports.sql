-- 064 — Trivia question reports.
--
-- Why this exists:
--   The home-page trivia game (migration 063) generates questions
--   dynamically from live group data. When a player thinks a question
--   or its "correct" answer is wrong, they need a way to flag it for
--   review. This table is the queue. Mirrors the existing training
--   `flagReports` flow conceptually but is much simpler:
--     - questions are NOT persisted (each session generates fresh
--       questions from data), so the report row carries the FULL
--       question text + correct + chosen answer for the admin to
--       investigate without needing to reproduce the session.
--     - no auto-fix / regrade: trivia answers come straight from
--       data, so resolution is just a triage decision (dismiss vs
--       resolved-with-note); fixes are made by editing the
--       generator templates and shipped in the next deploy.
--
-- Status lifecycle:
--   pending  → newly submitted, awaiting super-admin review
--   resolved → super-admin reviewed and applied a fix (or
--              acknowledged a real issue with a note)
--   dismissed → super-admin reviewed, the original answer was
--               actually correct; no change needed
--
-- We DO NOT add this table to the Realtime publication. Reports are
-- triaged asynchronously by the super-admin; live updates aren't
-- worth the bandwidth (and reports can include full question text
-- that would just spam the cache push to every member).

CREATE TABLE IF NOT EXISTS trivia_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  player_name TEXT NOT NULL,
  template_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('group', 'players')),
  question_text TEXT NOT NULL,
  correct_answer TEXT NOT NULL,
  chosen_answer TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('wrong_answer', 'unclear_question', 'other')),
  comment TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'dismissed')),
  resolved_by UUID REFERENCES auth.users(id),
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Two indexes for the two query paths the admin viewer hits:
--   1. "show me all pending reports across all my groups" (super
--      admin) → group_id + status + created_at
--   2. "count pending reports in MY group for the badge" → same
--      compound index serves it
CREATE INDEX IF NOT EXISTS trivia_reports_group_status_idx
  ON trivia_reports (group_id, status, created_at DESC);

ALTER TABLE trivia_reports ENABLE ROW LEVEL SECURITY;

-- RLS:
--   - SELECT  : any group member can read reports in their group
--               (transparency — encourages users that their flag
--                got triaged, similar to training)
--   - INSERT  : any group member, but only as themselves
--   - UPDATE  : super admins only (resolve/dismiss)
--   - DELETE  : super admins only (cleanup); group admins can also
--               delete reports in their own group as a fallback
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename='trivia_reports' AND policyname='tr_select') THEN
    DROP POLICY tr_select ON trivia_reports;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename='trivia_reports' AND policyname='tr_insert') THEN
    DROP POLICY tr_insert ON trivia_reports;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename='trivia_reports' AND policyname='tr_super_admin_update') THEN
    DROP POLICY tr_super_admin_update ON trivia_reports;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename='trivia_reports' AND policyname='tr_admin_delete') THEN
    DROP POLICY tr_admin_delete ON trivia_reports;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename='trivia_reports' AND policyname='tr_super_admin_all') THEN
    DROP POLICY tr_super_admin_all ON trivia_reports;
  END IF;
END $$;

CREATE POLICY tr_select ON trivia_reports FOR SELECT
  USING (group_id IN (
    SELECT group_id FROM group_members WHERE user_id = (SELECT auth.uid())
  ));

CREATE POLICY tr_insert ON trivia_reports FOR INSERT
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND group_id IN (
      SELECT group_id FROM group_members WHERE user_id = (SELECT auth.uid())
    )
  );

CREATE POLICY tr_super_admin_update ON trivia_reports FOR UPDATE
  USING (EXISTS (SELECT 1 FROM super_admins sa WHERE sa.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM super_admins sa WHERE sa.user_id = auth.uid()));

CREATE POLICY tr_admin_delete ON trivia_reports FOR DELETE
  USING (
    EXISTS (SELECT 1 FROM super_admins sa WHERE sa.user_id = auth.uid())
    OR group_id IN (
      SELECT group_id FROM group_members
       WHERE user_id = (SELECT auth.uid()) AND role = 'admin'
    )
  );

-- Cross-group catch-all for super admins so they see EVERYTHING
-- even if they're not a member of the originating group.
CREATE POLICY tr_super_admin_all ON trivia_reports FOR ALL
  USING (EXISTS (SELECT 1 FROM super_admins sa WHERE sa.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM super_admins sa WHERE sa.user_id = auth.uid()));

-- ── RPC: resolve_trivia_report(id, status, note?) ──────────────
-- Single-call resolution endpoint. SECURITY DEFINER + a manual
-- super-admin guard so we can RAISE a clean error message instead
-- of silently failing the UPDATE policy.
DROP FUNCTION IF EXISTS resolve_trivia_report(UUID, TEXT, TEXT);

CREATE OR REPLACE FUNCTION resolve_trivia_report(
  p_report_id UUID,
  p_status TEXT,
  p_note TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM super_admins WHERE super_admins.user_id = v_user_id) THEN
    RAISE EXCEPTION 'Only super admins can resolve trivia reports';
  END IF;
  IF p_status NOT IN ('resolved', 'dismissed', 'pending') THEN
    RAISE EXCEPTION 'Invalid status: %', p_status;
  END IF;

  UPDATE trivia_reports
     SET status          = p_status,
         resolved_by     = CASE WHEN p_status = 'pending' THEN NULL ELSE v_user_id END,
         resolved_at     = CASE WHEN p_status = 'pending' THEN NULL ELSE now() END,
         resolution_note = COALESCE(p_note, resolution_note)
   WHERE id = p_report_id;
END;
$$;

GRANT EXECUTE ON FUNCTION resolve_trivia_report(UUID, TEXT, TEXT) TO authenticated;

-- ── RPC: count_pending_trivia_reports() ─────────────────────────
-- Lightweight badge counter. For the super-admin badge in
-- Settings → Trivia tab; non-super-admins always get 0.
DROP FUNCTION IF EXISTS count_pending_trivia_reports();

CREATE OR REPLACE FUNCTION count_pending_trivia_reports()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_count INT;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN RETURN 0; END IF;
  IF NOT EXISTS (SELECT 1 FROM super_admins WHERE super_admins.user_id = v_user_id) THEN
    RETURN 0;
  END IF;
  SELECT count(*)::INT INTO v_count
    FROM trivia_reports
   WHERE status = 'pending';
  RETURN COALESCE(v_count, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION count_pending_trivia_reports() TO authenticated;
