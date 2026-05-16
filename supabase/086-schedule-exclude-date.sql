-- ============================================================
-- Migration 086: Per-date exclude/include (narrow the candidate set)
-- Run in Supabase SQL Editor after 085-chip-count-corrections.sql.
-- (Idempotent — uses CREATE OR REPLACE / IF NOT EXISTS.)
--
-- Numbering note: this migration was authored as 085 the same day as
-- another agent's 085-chip-count-corrections.sql; both got applied to
-- the DB. The DB record for this one is stored as `085_schedule_exclude_date`
-- (preserved as audit trail) while the on-disk file lives at 086 so the
-- supabase/ folder has a unique number per file. The migration content
-- below matches what was actually applied; only the file name moved.
--
-- Why: When an admin posts a poll with 4 proposed nights and two
--   clearly lead while the other two have one stray vote each, today
--   the admin's only ways to narrow the field are:
--     * Edit the poll to remove the losing dates — destroys their votes
--       and re-issues the whole poll's notifications (loud + lossy).
--     * Manually pin one of the leaders — commits prematurely; might
--       want to let the top 2 keep competing.
--   Neither matches the natural admin intent: "park the bottom 2 so
--   votes refocus on the top 2, then let the normal flow pick a winner."
--
--   This migration adds per-date exclude/include. Excluded dates:
--     * Are visually struck-through in the UI (PollCard renders a
--       distinct disabled tile state).
--     * Reject new votes server-side (cast_poll_vote /
--       admin_cast_poll_vote raise 'date_disabled').
--     * Are ignored by the auto-close trigger so a stale yes-count
--       can't promote an excluded date to confirmed.
--     * Preserve their existing votes — re-including the date brings
--       the voter list back as-is. This makes the action genuinely
--       reversible (unlike edit-and-remove-date).
--
-- Behavior:
--   * New `disabled_at TIMESTAMPTZ` column on `game_poll_dates`,
--     nullable, defaults NULL. Idempotent ADD COLUMN IF NOT EXISTS.
--   * New RPC `set_game_poll_date_disabled(p_date_id, p_disabled)`:
--       - Admin gate via `is_schedule_admin(poll.group_id)`.
--       - Refuses on cancelled / expired polls (terminal — nothing to
--         narrow). Refuses once a game has been linked
--         (`confirmed_game_id IS NOT NULL` — the result is settled).
--       - When disabling: refuses if the date is currently pinned
--         (admin must release the pin first; the manual_close /
--         release_game_poll_pin RPCs own that state transition).
--       - When disabling: refuses if doing so would leave the poll
--         with zero enabled dates. A poll with nothing to vote on is
--         a broken state — admins who want that outcome should cancel
--         or delete the poll instead.
--   * `cast_poll_vote` + `admin_cast_poll_vote` reject votes on
--     disabled dates with new exception `'date_disabled'`.
--   * `auto_close_poll_on_vote` skips disabled dates entirely. This
--     is defense-in-depth — cast_poll_vote already rejects votes on
--     disabled dates so the trigger shouldn't fire on one, but if
--     a vote was cast before the date was disabled the trigger could
--     still see a yes-count >= target on a stale row at any later
--     update; the explicit filter prevents an excluded date from
--     ever being promoted to confirmed.
--
-- UI counterpart: src/components/PollCard.tsx surfaces a "❌ הוצא" /
--   "♻️ החזר" toggle button in the tile header for admins on
--   multi-date polls. The disabled-tile rendering, disabled RSVP
--   buttons, and leader-detection filter all live in the same file.
--   Both sides ship together — SQL grants the permission, UI surfaces
--   the affordance.
-- ============================================================

-- 1. Schema change — idempotent so reruns are safe.
ALTER TABLE game_poll_dates
  ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;

-- 2. Admin toggle RPC.
CREATE OR REPLACE FUNCTION set_game_poll_date_disabled(
  p_date_id   UUID,
  p_disabled  BOOLEAN
)
RETURNS VOID AS $$
DECLARE
  v_poll_id        UUID;
  v_group_id       UUID;
  v_status         TEXT;
  v_confirmed_did  UUID;
  v_game_id        UUID;
  v_current_state  BOOLEAN;
  v_enabled_left   INT;
BEGIN
  SELECT d.poll_id, p.group_id, p.status, p.confirmed_date_id, p.confirmed_game_id,
         (d.disabled_at IS NOT NULL)
    INTO v_poll_id, v_group_id, v_status, v_confirmed_did, v_game_id,
         v_current_state
    FROM game_poll_dates d
    JOIN game_polls p ON p.id = d.poll_id
   WHERE d.id = p_date_id;

  IF v_poll_id IS NULL THEN
    RAISE EXCEPTION 'invalid_date_id';
  END IF;

  IF NOT is_schedule_admin(v_group_id) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  IF v_status NOT IN ('open', 'expanded', 'confirmed') THEN
    RAISE EXCEPTION 'poll_locked';
  END IF;

  IF v_game_id IS NOT NULL THEN
    -- A linked game means the poll's outcome is "settled in the real
    -- world" — exclude/include no longer makes sense as an action.
    RAISE EXCEPTION 'game_already_started';
  END IF;

  -- Disabling the currently-pinned date would orphan the lock — block.
  -- Admin must release the pin first (release_game_poll_pin from 084).
  IF p_disabled AND v_confirmed_did = p_date_id THEN
    RAISE EXCEPTION 'date_is_pinned';
  END IF;

  -- Prevent disabling the last remaining enabled date — a poll with
  -- nothing to vote on is a broken state.
  IF p_disabled AND NOT v_current_state THEN
    SELECT count(*) INTO v_enabled_left
      FROM game_poll_dates
     WHERE poll_id = v_poll_id
       AND id <> p_date_id
       AND disabled_at IS NULL;
    IF v_enabled_left = 0 THEN
      RAISE EXCEPTION 'last_enabled_date';
    END IF;
  END IF;

  -- Idempotent — toggling to the same state is a harmless no-op.
  UPDATE game_poll_dates
     SET disabled_at = CASE WHEN p_disabled THEN now() ELSE NULL END
   WHERE id = p_date_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION set_game_poll_date_disabled(UUID, BOOLEAN) TO authenticated;

-- 3. cast_poll_vote — reject votes on disabled dates. The disabled
--    flag is fetched in its own SELECT (Postgres forbids combining a
--    %ROWTYPE record with a scalar in one INTO list). The check fires
--    after the poll existence test but before tier/lock/seat checks —
--    admins' debugging is easier when the most-specific reason wins.
CREATE OR REPLACE FUNCTION cast_poll_vote(
  p_date_id   UUID,
  p_response  TEXT,
  p_comment   TEXT DEFAULT NULL
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

  IF v_poll.status = 'open' AND v_player_type <> 'permanent' THEN
    RAISE EXCEPTION 'tier_not_allowed';
  END IF;
  IF v_poll.status = 'confirmed'
     AND v_poll.expanded_at IS NULL
     AND v_player_type <> 'permanent' THEN
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

-- 4. admin_cast_poll_vote — same disabled-date guard.
CREATE OR REPLACE FUNCTION admin_cast_poll_vote(
  p_date_id          UUID,
  p_voter_player_id  UUID,
  p_response         TEXT,
  p_comment          TEXT DEFAULT NULL
)
RETURNS SETOF game_polls AS $$
DECLARE
  v_poll          game_polls%ROWTYPE;
  v_player_group  UUID;
  v_player_user   UUID;
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

  IF NOT is_schedule_admin(v_poll.group_id) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  IF p_response NOT IN ('yes', 'no', 'maybe') THEN
    RAISE EXCEPTION 'invalid_response';
  END IF;

  SELECT group_id INTO v_player_group FROM players WHERE id = p_voter_player_id;
  IF v_player_group IS NULL THEN
    RAISE EXCEPTION 'invalid_player';
  END IF;
  IF v_player_group <> v_poll.group_id THEN
    RAISE EXCEPTION 'player_not_in_group';
  END IF;

  SELECT gm.user_id INTO v_player_user
    FROM group_members gm
   WHERE gm.player_id = p_voter_player_id
     AND gm.group_id  = v_poll.group_id
   LIMIT 1;

  INSERT INTO game_poll_votes (
    poll_id, date_id, player_id, user_id, response, comment, voted_at,
    cast_by_user_id
  )
  VALUES (
    v_poll.id, p_date_id, p_voter_player_id, v_player_user,
    p_response, p_comment, now(),
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

-- 5. auto_close_poll_on_vote — never promote a disabled date.
--    Defense-in-depth: cast_poll_vote rejects votes on disabled dates
--    so the trigger shouldn't fire on one in normal operation. But
--    an admin could disable a date AFTER it already collected enough
--    yes-votes; the trigger fires on every subsequent yes-vote
--    elsewhere too, so this explicit filter prevents a stale state
--    from auto-pinning the excluded date.
CREATE OR REPLACE FUNCTION auto_close_poll_on_vote()
RETURNS TRIGGER AS $$
DECLARE
  v_target          INT;
  v_yes_cnt         INT;
  v_confirmed_date  UUID;
  v_date_disabled   BOOLEAN;
BEGIN
  IF NEW.response <> 'yes' THEN
    RETURN NEW;
  END IF;

  SELECT (disabled_at IS NOT NULL) INTO v_date_disabled
    FROM game_poll_dates WHERE id = NEW.date_id;

  IF v_date_disabled THEN
    RETURN NEW;
  END IF;

  SELECT target_player_count, confirmed_date_id
    INTO v_target, v_confirmed_date
    FROM game_polls WHERE id = NEW.poll_id;

  SELECT count(*) INTO v_yes_cnt
    FROM game_poll_votes
    WHERE date_id = NEW.date_id AND response = 'yes';

  IF v_yes_cnt >= v_target THEN
    UPDATE game_polls
       SET status = 'confirmed',
           confirmed_date_id = NEW.date_id,
           confirmed_at = now()
     WHERE id = NEW.poll_id
       AND status IN ('open', 'expanded');

    UPDATE game_polls
       SET voting_locked_at = now()
     WHERE id = NEW.poll_id
       AND voting_locked_at IS NULL
       AND confirmed_date_id = NEW.date_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = 'public', 'pg_temp';

-- ============================================================
-- DONE — Verify with:
--   -- New column exists
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='game_poll_dates'
--      AND column_name='disabled_at';
--
--   -- Toggle a date off
--   SELECT set_game_poll_date_disabled('<date_id>'::uuid, true);
--   SELECT id, disabled_at FROM game_poll_dates WHERE id='<date_id>'::uuid;
--
--   -- Vote attempt should now raise 'date_disabled'
--   SELECT cast_poll_vote('<date_id>'::uuid, 'yes', NULL);
--
--   -- Re-enable
--   SELECT set_game_poll_date_disabled('<date_id>'::uuid, false);
--   SELECT disabled_at FROM game_poll_dates WHERE id='<date_id>'::uuid;  -- NULL
-- ============================================================
