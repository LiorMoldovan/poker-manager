-- ============================================================
-- 086 — Pin during open phase keeps the expansion clock alive
-- ============================================================
--
-- Problem this fixes
-- ------------------
-- Before this migration, when an admin used `manual_close_game_poll`
-- (the 📌 manual-pick chip) on a poll while it was still in the
-- permanents-only `'open'` phase, the poll's `status` flipped straight
-- to `'confirmed'` while `expanded_at` stayed NULL. Two RPCs then made
-- this state irreversible without admin intervention:
--
--   1. `cast_poll_vote` rejected non-permanent voters with
--      `tier_not_allowed` whenever
--      `status='confirmed' AND expanded_at IS NULL` — regardless of
--      how much time had passed since `created_at`. The
--      "permanents-only window" never closed.
--
--   2. `expand_game_poll` only fired on `WHERE status='open'`, so the
--      atomic time-gated transition that normally sets `expanded_at`
--      after `expansion_delay_hours` could never run on a pinned-
--      during-open poll. `expanded_at` stayed NULL forever.
--
-- The combined effect: pinning a date during open phase silently
-- locked guests / permanent_guests out of voting permanently. The
-- only escape was for an admin to manually click 🔓 (release pin)
-- and wait for the auto-expansion to fire — a multi-step rescue
-- for a state the system put itself into.
--
-- The semantic mistake was conflating "pin a date" (which only sets
-- *which* date the game is on) with "lock voting" (which is a
-- separate, explicit admin action via `voting_locked_at`). Pin
-- should never block tiers from voting; only the explicit voting
-- lock should do that.
--
-- Fix
-- ---
--   * `cast_poll_vote` — the tier gate becomes purely time-based:
--     we block non-permanents only while
--     `expanded_at IS NULL AND now() < created_at + expansion_delay_hours`.
--     The `status='confirmed'` branch is no longer special — once
--     the delay elapses, anyone can vote, pinned or not. (Already
--     `'expanded'` polls trivially pass the gate because
--     `expanded_at IS NOT NULL`.)
--
--   * `expand_game_poll` — widened to fire on `status IN ('open','confirmed')`
--     when `expanded_at IS NULL`. It still only acts after
--     `expansion_delay_hours` has elapsed. On `'open'` it flips
--     status to `'expanded'` (existing behavior); on `'confirmed'`
--     it leaves status alone and just stamps `expanded_at = now()`.
--     This keeps notification triggers intact for the open→expanded
--     path while letting pinned polls finally get an `expanded_at`
--     timestamp so client UIs can derive "open-to-all" state
--     consistently.
--
-- What this migration does NOT change
-- -----------------------------------
--   * `manual_close_game_poll` — unchanged. Pinning still flips to
--     `'confirmed'` and still preserves `expanded_at` (which may be
--     NULL or set, depending on whether expansion already fired).
--   * `admin_cast_poll_vote` — already had no tier gate; admin proxy
--     votes bypass tier rules by design.
--   * `update_game_poll_meta` — already accepts `'confirmed'` polls,
--     so the existing edit modal can already update
--     `expansion_delay_hours` on a pinned-during-open poll once the
--     client gate is loosened. No SQL change needed.
--   * `voting_locked_at` semantics — unchanged. An explicit admin
--     voting lock still freezes everyone, regardless of phase.
--
-- Idempotency: both functions use `CREATE OR REPLACE`. Safe to
-- re-apply.
-- ============================================================

-- ─── 1. cast_poll_vote — time-based tier gate ───
-- Body identical to the live function (085) except the two
-- `tier_not_allowed` blocks are replaced by one time-based check.
CREATE OR REPLACE FUNCTION cast_poll_vote(
  p_date_id UUID,
  p_response TEXT,
  p_comment TEXT DEFAULT NULL
)
RETURNS SETOF game_polls AS $$
DECLARE
  v_poll          game_polls%ROWTYPE;
  v_player_id     UUID;
  v_player_type   TEXT;
  v_date_disabled BOOLEAN;
BEGIN
  SELECT p.* INTO v_poll
    FROM game_polls p
    JOIN game_poll_dates d ON d.poll_id = p.id
    WHERE d.id = p_date_id;

  IF v_poll.id IS NULL THEN
    RAISE EXCEPTION 'invalid_date_id';
  END IF;

  SELECT (disabled_at IS NOT NULL) INTO v_date_disabled
    FROM game_poll_dates WHERE id = p_date_id;

  IF v_date_disabled THEN
    RAISE EXCEPTION 'date_disabled';
  END IF;

  IF v_poll.status NOT IN ('open', 'expanded', 'confirmed') THEN
    RAISE EXCEPTION 'poll_locked';
  END IF;

  IF v_poll.voting_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'voting_locked';
  END IF;

  SELECT gm.player_id INTO v_player_id
    FROM group_members gm
    WHERE gm.user_id = auth.uid() AND gm.group_id = v_poll.group_id;

  IF v_player_id IS NULL THEN
    RAISE EXCEPTION 'no_player_link';
  END IF;

  SELECT type INTO v_player_type FROM players WHERE id = v_player_id;
  IF v_player_type IS NULL THEN
    RAISE EXCEPTION 'no_player_link';
  END IF;

  -- Time-based tier gate. Permanents always pass. Non-permanents
  -- pass once expansion has happened (expanded_at IS NOT NULL) OR
  -- the expansion delay has elapsed since poll creation. Pinning
  -- the poll during the permanents-only window does NOT alter this
  -- clock — that's the whole point of this migration. The
  -- `voting_locked_at` check above is the explicit "freeze
  -- everyone" lever; tier gating is independent.
  IF v_player_type <> 'permanent'
     AND v_poll.expanded_at IS NULL
     AND now() < v_poll.created_at + make_interval(hours => v_poll.expansion_delay_hours) THEN
    RAISE EXCEPTION 'tier_not_allowed';
  END IF;

  IF p_response NOT IN ('yes', 'no', 'maybe') THEN
    RAISE EXCEPTION 'invalid_response';
  END IF;

  IF p_response = 'maybe' AND NOT v_poll.allow_maybe THEN
    RAISE EXCEPTION 'maybe_not_allowed';
  END IF;

  INSERT INTO game_poll_votes (
    poll_id, date_id, player_id, user_id, response, comment, voted_at,
    cast_by_user_id
  )
  VALUES (
    v_poll.id, p_date_id, v_player_id, auth.uid(), p_response, p_comment, now(),
    auth.uid()
  )
  ON CONFLICT (date_id, player_id) DO UPDATE
    SET response        = EXCLUDED.response,
        comment         = EXCLUDED.comment,
        voted_at        = EXCLUDED.voted_at,
        user_id         = EXCLUDED.user_id,
        cast_by_user_id = EXCLUDED.cast_by_user_id;

  RETURN QUERY SELECT * FROM game_polls WHERE id = v_poll.id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION cast_poll_vote(UUID, TEXT, TEXT) TO authenticated;

-- ─── 2. expand_game_poll — widen to confirmed-no-expandedAt ───
-- The expansion timestamp is now decoupled from the status flip.
-- An open poll still flips `'open' → 'expanded'`; a confirmed poll
-- (typically pinned via manual_close during the permanents-only
-- window) keeps its `'confirmed'` status but gets `expanded_at`
-- stamped so subsequent reads can derive "open to all". The
-- time-gate (`expansion_delay_hours` elapsed) is unchanged.
CREATE OR REPLACE FUNCTION expand_game_poll(p_poll_id UUID)
RETURNS VOID AS $$
DECLARE
  v_group_id UUID;
BEGIN
  SELECT group_id INTO v_group_id FROM game_polls WHERE id = p_poll_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'invalid_poll';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM group_members
    WHERE group_id = v_group_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not_member';
  END IF;

  -- Atomic time-gated transition; no-op if already expanded,
  -- terminal-state, or too early. CASE on status keeps the
  -- existing 'open' → 'expanded' flip intact (so the
  -- trg_enqueue_poll_notification trigger that watches that
  -- transition still fires) while leaving 'confirmed' status
  -- untouched (the 'confirmed' notification was already enqueued
  -- when manual_close pinned the date).
  UPDATE game_polls
     SET expanded_at = now(),
         status = CASE WHEN status = 'open' THEN 'expanded' ELSE status END
   WHERE id = p_poll_id
     AND expanded_at IS NULL
     AND status IN ('open', 'confirmed')
     AND now() - created_at >= make_interval(hours => expansion_delay_hours);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION expand_game_poll(UUID) TO authenticated;

-- ─── DONE ───
-- Verify with:
--   -- Should return 0 rows: confirmed polls with NULL expanded_at
--   -- whose expansion delay has already elapsed (these will get
--   -- their expanded_at stamped on the next runSchedulerSweep call
--   -- or the next expand_game_poll RPC, whichever fires first).
--   SELECT id, status, expanded_at, created_at, expansion_delay_hours,
--          (created_at + (expansion_delay_hours || ' hours')::interval) AS expansion_due_at,
--          ((created_at + (expansion_delay_hours || ' hours')::interval) - now()) AS overdue_by
--     FROM game_polls
--    WHERE status = 'confirmed' AND expanded_at IS NULL
--      AND now() >= created_at + make_interval(hours => expansion_delay_hours);
