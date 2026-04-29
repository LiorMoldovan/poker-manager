-- ============================================================
-- Migration 033: Game Night Comics — schema + Storage bucket
-- Run in Supabase SQL Editor after 032-schedule-admin-vote-change-optout.sql.
-- (Idempotent — safe to re-run.)
--
-- What this adds:
--   * 4 nullable columns on `games` to cache an admin-generated
--     one-page comic of the game night:
--       comic_url           — public URL of the PNG in Storage
--       comic_script        — JSONB: panels, dialogue, style,
--                             per-character face bounding boxes
--                             (everything the renderer needs to
--                              draw Hebrew speech bubbles client-side)
--       comic_style         — style key (newspaper / manga / noir / ...)
--       comic_generated_at  — last generation timestamp (regen guard)
--   * A public Storage bucket `game-comics` storing PNGs at
--     `{group_id}/{game_id}.png`.
--   * RLS on `storage.objects` so:
--       - SELECT (read): anyone can read (bucket is public so the
--         <img src> works in <img> and on WhatsApp previews).
--       - INSERT / UPDATE / DELETE: only authenticated admins of the
--         owning group, scoped by the {group_id}/ folder prefix.
--
-- Realtime: `games` is already in the supabase_realtime publication
-- (added in 003-realtime.sql / schema.sql), so the new columns sync
-- automatically — no publication change needed.
-- ============================================================

-- ── 1. Columns on games ──

ALTER TABLE games
  ADD COLUMN IF NOT EXISTS comic_url          TEXT,
  ADD COLUMN IF NOT EXISTS comic_script       JSONB,
  ADD COLUMN IF NOT EXISTS comic_style        TEXT,
  ADD COLUMN IF NOT EXISTS comic_generated_at TIMESTAMPTZ;

-- ── 2. Storage bucket (public read so <img src> works) ──

INSERT INTO storage.buckets (id, name, public)
VALUES ('game-comics', 'game-comics', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- ── 3. RLS policies on storage.objects for the comic bucket ──
--
-- Path layout: '{group_id}/{game_id}.png'
-- storage.foldername(name) returns the path parts as text[];
-- index 1 is '{group_id}'.

DROP POLICY IF EXISTS "comic_public_read"  ON storage.objects;
DROP POLICY IF EXISTS "comic_admin_insert" ON storage.objects;
DROP POLICY IF EXISTS "comic_admin_update" ON storage.objects;
DROP POLICY IF EXISTS "comic_admin_delete" ON storage.objects;

CREATE POLICY "comic_public_read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'game-comics');

CREATE POLICY "comic_admin_insert"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'game-comics'
    AND EXISTS (
      SELECT 1
        FROM group_members gm
       WHERE gm.user_id = auth.uid()
         AND gm.role    = 'admin'
         AND gm.group_id::text = (storage.foldername(name))[1]
    )
  );

CREATE POLICY "comic_admin_update"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'game-comics'
    AND EXISTS (
      SELECT 1
        FROM group_members gm
       WHERE gm.user_id = auth.uid()
         AND gm.role    = 'admin'
         AND gm.group_id::text = (storage.foldername(name))[1]
    )
  );

CREATE POLICY "comic_admin_delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'game-comics'
    AND EXISTS (
      SELECT 1
        FROM group_members gm
       WHERE gm.user_id = auth.uid()
         AND gm.role    = 'admin'
         AND gm.group_id::text = (storage.foldername(name))[1]
    )
  );

-- ============================================================
-- DONE — Verify with:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'games' AND column_name LIKE 'comic%';
--   SELECT id, public FROM storage.buckets WHERE id = 'game-comics';
--   SELECT polname FROM pg_policy
--     JOIN pg_class ON pg_class.oid = pg_policy.polrelid
--    WHERE relname = 'objects' AND polname LIKE 'comic_%';
-- ============================================================
