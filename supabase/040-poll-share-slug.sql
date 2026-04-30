-- ============================================================
-- Migration 040: Schedule polls — short share slug
-- Run in Supabase SQL Editor after 039-schedule-voting-lock.sql
-- (Idempotent — uses CREATE OR REPLACE / IF NOT EXISTS / DROP+ADD pattern.)
--
-- Why: the WhatsApp share caption embeds a deep link to the poll. We
--   used to use the full poll UUID (`/p/<36-char-uuid>`), which on
--   most phones wraps mid-uuid into a noisy multi-line blob in the
--   chat preview — readable but visually loud, and obviously
--   "computer-generated" rather than "invitation-y".
--
--   This migration adds a per-poll 6-character base32 slug
--   (Crockford-style alphabet, no 0/1/i/l/o so it can't be
--   misread when copied by hand). The deep link becomes
--   `/p/<6-char-slug>` (e.g. `/p/7g4xq2`) — short enough to fit on a
--   single tappable line in WhatsApp on every phone, and reads more
--   like an invite code than a UUID.
--
-- Behavior:
--   * New column `game_polls.share_slug TEXT UNIQUE` (auto-populated).
--   * Helper fn `_generate_poll_share_slug()` — picks a random 6-char
--     code from the alphabet and retries up to 50 times on collision.
--     31^6 ≈ 887M possibilities, so a collision is vanishingly rare
--     even at thousands of polls per group across many groups.
--   * BEFORE INSERT trigger `tg_game_polls_share_slug` populates
--     `share_slug` when the inserted row has it NULL. INSERTs that
--     specify a slug explicitly are honored as-is (useful for
--     migrations / data imports).
--   * Backfill: every existing row gets a slug.
--   * RPC `resolve_poll_share_slug(p_slug TEXT) RETURNS UUID` —
--     case-insensitive lookup. Returns NULL for unknown slugs (the
--     caller handles "poll not found" UX). Granted to authenticated
--     AND anon — the slug → UUID mapping leaks no sensitive data
--     (the UUID is already public, it's exposed in every share link
--     and was the previous URL form), and we want the resolution to
--     work during the post-auth round-trip without race conditions
--     against the supabase session refresh.
--
-- UI counterpart: src/App.tsx (`PollDeepLinkRedirect`) detects the
--   slug-vs-uuid shape and resolves slugs via the RPC. Old long-form
--   `/p/<uuid>` links keep working — the route handler treats any
--   UUID-shaped param as the canonical poll id and skips the lookup.
--   src/components/ScheduleTab.tsx (`buildShareCaption`) now emits
--   the slug form for new shares.
-- ============================================================

-- 1. Schema change ----------------------------------------------------
ALTER TABLE game_polls
  ADD COLUMN IF NOT EXISTS share_slug TEXT;

-- Unique index. We use a partial index (`WHERE share_slug IS NOT NULL`)
-- because the column is allowed to be NULL during the brief window
-- between row insert and trigger firing, and we don't want the
-- backfill below to race with itself if the migration is re-run.
CREATE UNIQUE INDEX IF NOT EXISTS game_polls_share_slug_unique
  ON game_polls (share_slug)
  WHERE share_slug IS NOT NULL;

-- 2. Slug generator ----------------------------------------------------
-- Crockford-style base32 alphabet minus visually-ambiguous chars
-- (0, 1, i, l, o). Lowercase only — short enough that case sensitivity
-- would just be a footgun. 31 chars × 6 positions = 887,503,681
-- combos; collisions are negligible at any plausible poll volume.
CREATE OR REPLACE FUNCTION _generate_poll_share_slug()
RETURNS TEXT AS $$
DECLARE
  v_alphabet CONSTANT TEXT := 'abcdefghjkmnpqrstuvwxyz23456789';
  v_alpha_len CONSTANT INT := length(v_alphabet);
  v_len      CONSTANT INT  := 6;
  v_slug     TEXT;
  v_i        INT;
  v_attempt  INT := 0;
BEGIN
  LOOP
    v_slug := '';
    FOR v_i IN 1..v_len LOOP
      v_slug := v_slug || substring(
        v_alphabet,
        floor(random() * v_alpha_len)::INT + 1,
        1
      );
    END LOOP;

    -- Bail out if we hit a free slot. The unique index would also
    -- catch collisions on insert, but probing here keeps the trigger
    -- path single-row instead of relying on transactional retries.
    IF NOT EXISTS (
      SELECT 1 FROM game_polls WHERE share_slug = v_slug
    ) THEN
      RETURN v_slug;
    END IF;

    v_attempt := v_attempt + 1;
    IF v_attempt > 50 THEN
      -- 50 collisions in a row is statistically impossible at
      -- ~1B-key keyspace — if we hit this, something's wrong with
      -- random() or the alphabet, not natural collision pressure.
      RAISE EXCEPTION 'share_slug_collision_exhausted';
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql VOLATILE SET search_path = public;

-- 3. Auto-populate trigger --------------------------------------------
CREATE OR REPLACE FUNCTION tg_game_polls_share_slug()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.share_slug IS NULL OR NEW.share_slug = '' THEN
    NEW.share_slug := _generate_poll_share_slug();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS tg_game_polls_share_slug ON game_polls;
CREATE TRIGGER tg_game_polls_share_slug
  BEFORE INSERT ON game_polls
  FOR EACH ROW EXECUTE FUNCTION tg_game_polls_share_slug();

-- 4. Backfill existing rows -------------------------------------------
-- Loop one row at a time so each call to _generate_poll_share_slug()
-- sees the slugs allocated by previous iterations (a single bulk
-- UPDATE would all read random() at once and could collide). With
-- ~thousands of existing polls at most, this is fast.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT id FROM game_polls WHERE share_slug IS NULL ORDER BY created_at
  LOOP
    UPDATE game_polls
       SET share_slug = _generate_poll_share_slug()
     WHERE id = r.id;
  END LOOP;
END $$;

-- 5. Slug resolver RPC -------------------------------------------------
-- Returns the poll UUID for a given slug, or NULL if not found.
-- Case-insensitive so manually-typed slugs work even if the user
-- shifted case. Marked STABLE so the planner can cache it within a
-- statement — we touch the table once per call.
CREATE OR REPLACE FUNCTION resolve_poll_share_slug(p_slug TEXT)
RETURNS UUID AS $$
DECLARE
  v_poll_id UUID;
BEGIN
  IF p_slug IS NULL OR length(trim(p_slug)) = 0 THEN
    RETURN NULL;
  END IF;

  SELECT id INTO v_poll_id
    FROM game_polls
    WHERE lower(share_slug) = lower(trim(p_slug));

  RETURN v_poll_id;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

-- Granted to both authenticated AND anon: slug→UUID mapping leaks no
-- sensitive data (the UUID is already public — it was the previous
-- URL form and is exposed in every share link). Granting to anon
-- matters during the post-OAuth round-trip when the supabase session
-- may not be fully restored at the moment the redirect runs.
GRANT EXECUTE ON FUNCTION resolve_poll_share_slug(TEXT) TO authenticated, anon;
