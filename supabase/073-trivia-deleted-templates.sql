-- 073 — Trivia template kill-switch (per-group "delete this question").
--
-- Filename note: this migration was originally authored as 070-* but
-- renumbered to 073 to avoid an on-disk filename collision with
-- 070-chip-count-tuning.sql (committed earlier in v5.55). The DB
-- migration record is `070_trivia_deleted_templates` (immutable
-- timestamp-keyed history) — only the on-disk filename was changed.
--
-- Why this exists:
--   The trivia inbox (migration 064) lets a super-admin triage
--   reports — but resolving/dismissing only changes the report's
--   status; the underlying question template keeps generating in
--   future sessions. The user feedback was direct: "if it's a bad
--   question I want to DELETE it, not file paperwork about it."
--
--   This table is the kill switch. When a super-admin deletes a
--   template for a group, generateTriviaBatch filters that template
--   out of both pools forever (until restored). Per-group scope so
--   one group's data quirks don't punish other groups.
--
--   The deletion is REVERSIBLE — we keep the row + a "restore"
--   action — so a fat-finger doesn't permanently lose a template.
--   That's the only reason this is a separate table instead of an
--   "is_disabled" column on a non-existent templates table (templates
--   live in code, not DB).
--
-- Status: applied via apply_migration on 2026-05-10.

CREATE TABLE IF NOT EXISTS trivia_deleted_templates (
  group_id    UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL,
  deleted_by  UUID REFERENCES auth.users(id),
  deleted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason      TEXT,
  PRIMARY KEY (group_id, template_id)
);

CREATE INDEX IF NOT EXISTS trivia_deleted_templates_group_idx
  ON trivia_deleted_templates (group_id);

ALTER TABLE trivia_deleted_templates ENABLE ROW LEVEL SECURITY;

-- RLS:
--   - SELECT : any group member, so the trivia generator on every
--              client filters consistently. Super-admins see all.
--   - INSERT/DELETE : super-admins only (the inbox is super-admin
--              gated; we don't expand the surface here). Direct
--              writes are not used — clients call the RPCs below
--              which RAISE clean errors instead of silent RLS
--              denials.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename='trivia_deleted_templates' AND policyname='tdt_select') THEN
    DROP POLICY tdt_select ON trivia_deleted_templates;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename='trivia_deleted_templates' AND policyname='tdt_super_admin_all') THEN
    DROP POLICY tdt_super_admin_all ON trivia_deleted_templates;
  END IF;
END $$;

CREATE POLICY tdt_select ON trivia_deleted_templates FOR SELECT
  USING (
    group_id IN (
      SELECT group_id FROM group_members WHERE user_id = (SELECT auth.uid())
    )
    OR EXISTS (SELECT 1 FROM super_admins sa WHERE sa.user_id = (SELECT auth.uid()))
  );

-- Super-admin catch-all for INSERT/UPDATE/DELETE/SELECT cross-group.
CREATE POLICY tdt_super_admin_all ON trivia_deleted_templates FOR ALL
  USING (EXISTS (SELECT 1 FROM super_admins sa WHERE sa.user_id = (SELECT auth.uid())))
  WITH CHECK (EXISTS (SELECT 1 FROM super_admins sa WHERE sa.user_id = (SELECT auth.uid())));

-- Realtime: every client needs to react when a template is deleted
-- or restored, so the next generated batch reflects the change
-- without a page reload.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'trivia_deleted_templates'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.trivia_deleted_templates';
  END IF;
END $$;

-- ── RPC: delete_trivia_template(group_id, template_id, reason?) ──
-- Single-call delete endpoint. Super-admin only. Idempotent: if the
-- template is already deleted for that group, the call is a no-op
-- (we just refresh the reason + deleted_at). Used by the trivia
-- inbox red "delete permanently" button.
DROP FUNCTION IF EXISTS delete_trivia_template(UUID, TEXT, TEXT);

CREATE OR REPLACE FUNCTION delete_trivia_template(
  p_group_id    UUID,
  p_template_id TEXT,
  p_reason      TEXT DEFAULT NULL
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
    RAISE EXCEPTION 'Only super admins can delete trivia templates';
  END IF;
  IF p_template_id IS NULL OR length(p_template_id) = 0 THEN
    RAISE EXCEPTION 'template_id is required';
  END IF;

  INSERT INTO trivia_deleted_templates (group_id, template_id, deleted_by, deleted_at, reason)
  VALUES (p_group_id, p_template_id, v_user_id, now(), p_reason)
  ON CONFLICT (group_id, template_id) DO UPDATE
    SET deleted_by = EXCLUDED.deleted_by,
        deleted_at = EXCLUDED.deleted_at,
        reason     = COALESCE(EXCLUDED.reason, trivia_deleted_templates.reason);
END;
$$;

GRANT EXECUTE ON FUNCTION delete_trivia_template(UUID, TEXT, TEXT) TO authenticated;

-- ── RPC: restore_trivia_template(group_id, template_id) ──
-- Reverses a delete. Super-admin only. Idempotent: silent no-op if
-- the row doesn't exist. Used by the "restore" button in the inbox.
DROP FUNCTION IF EXISTS restore_trivia_template(UUID, TEXT);

CREATE OR REPLACE FUNCTION restore_trivia_template(
  p_group_id    UUID,
  p_template_id TEXT
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
    RAISE EXCEPTION 'Only super admins can restore trivia templates';
  END IF;

  DELETE FROM trivia_deleted_templates
   WHERE group_id = p_group_id
     AND template_id = p_template_id;
END;
$$;

GRANT EXECUTE ON FUNCTION restore_trivia_template(UUID, TEXT) TO authenticated;
