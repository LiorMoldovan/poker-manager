-- ============================================================================
-- supabase/089-silent-poll-meta-edits.sql
--
-- 2026-05-21 — Lior reports that lowering a confirmed poll's target from 8
-- to 7 (because one player verbally dropped out) blasted 4 waves of push +
-- email to the group, eating a chunk of his EmailJS monthly quota. The
-- intended action was a SILENT admin adjustment; the actual UI flow forced
-- him through release_pin → edit → release_pin and each transition re-fired
-- the lifecycle notifications for the same date members already RSVP'd to.
--
-- Forensics (poll 18b61e48-… on group "Poker Night"):
--   • 17/5 10:10:13 — 8th yes vote arrives. auto_close_poll_on_vote
--     auto-confirms target=8 + locks voting. 'confirmed' + 'target_filled'
--     emails fire correctly.
--   • 20/5 14:45:17 — Lior taps 🔓 שחרר נעילה (release_pin). status
--     confirmed → expanded. release_game_poll_pin ALSO nulls
--     confirmed_notifications_sent_at + target_filled_notifications_sent_at
--     (per mig 084's design rationale: "next pin re-announces fresh"). The
--     status-change trigger enqueues 'expanded' → email blast #1.
--   • 20/5 14:45:41 — Lior changes target 8→7 in EditPollModal.
--     update_game_poll_meta's threshold re-eval sees 8 yes ≥ 7 and flips
--     status expanded → confirmed. Trigger enqueues 'confirmed' →
--     blast #2.
--   • 20/5 14:45:42 — runSchedulerSweep's backfill sees
--     target_filled_notifications_sent_at IS NULL and yes_count ≥ target,
--     enqueues 'target_filled' → blast #3.
--   • 20/5 14:46:10 — Lior taps release_pin again to undo. Another
--     'expanded' blast → blast #4.
--
-- Root cause split across two design choices, neither wrong in isolation:
--   1. The notification trigger fn_enqueue_poll_notification_on_change
--      enqueues on EVERY status flip, with no way for the caller to say
--      "this is an admin meta-edit, not a member-facing transition".
--   2. release_game_poll_pin (mig 084) nulls the legacy sentinels so the
--      next pin re-announces. Necessary if the re-pin goes to a DIFFERENT
--      date and the sweep backfill needs to fire; harmful when the
--      re-pin lands on the SAME date a minute later via target-edit
--      re-eval.
--
-- THIS MIGRATION
--
-- Adds a transaction-local config flag `app.suppress_poll_notifications`
-- that fn_enqueue_poll_notification_on_change checks before enqueueing.
-- update_game_poll_meta and release_game_poll_pin set the flag at the top
-- of their bodies so the resulting status flips don't enqueue jobs. The
-- flag is `is_local = true` — scoped to the current transaction, no
-- cross-call leakage.
--
-- Also:
--   • release_game_poll_pin STOPS nulling the legacy sentinels. Combined
--     with the trigger suppression, this prevents both the trigger path
--     (silent flag) and the runSchedulerSweep backfill path (sentinel
--     still set) from re-firing the same lifecycle notification on a
--     re-confirm to the same date.
--     Edge case: if admin releases pin and the poll later re-confirms to
--     a DIFFERENT date via a fresh yes-vote (auto_close_poll_on_vote),
--     fn_enqueue_poll_notification_on_change's status-change branch
--     ('expanded' → 'confirmed') still fires because the silent flag is
--     NOT set by auto_close_poll_on_vote (it's a vote-driven transition,
--     not an admin meta-edit). Recipients on the new date still get
--     announced.
--   • release_game_poll_pin ALSO clears voting_locked_at. The whole
--     point of releasing the pin is "I want to wiggle the lineup" — but
--     today the lock from the original auto-confirm carries through, so
--     members can't change their RSVPs and admin has to manually unlock.
--     One click should put the poll back into "fully editable" state.
--
-- This migration does NOT change the LOUD paths:
--   • auto_close_poll_on_vote (fresh yes-vote crosses target) → still
--     fires 'confirmed' + 'target_filled' loudly. Members want this.
--   • fn_enqueue_target_filled_on_vote (vote arrives after manual pin
--     and crosses target) → still fires. Members want this.
--   • manual_close_game_poll (admin pins explicitly) → still fires
--     'confirmed' loudly. Members want this.
--   • fn_enqueue_vote_change_on_vote (per-RSVP notification to admins)
--     → unaffected, uses a different enqueue function. Unrelated.
--
-- IDEMPOTENT: CREATE OR REPLACE FUNCTION throughout. Re-runnable.
-- ============================================================================

-- ──────────────────────────────────────────────────────────────────────────
-- 1. Notification trigger — honor the silent-edit flag
-- ──────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_enqueue_poll_notification_on_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = 'public'
AS $$
DECLARE
  v_yes_cnt INT;
  v_silent  TEXT;
BEGIN
  -- Transaction-local "this is an admin meta-edit, not a state change"
  -- flag. Set by update_game_poll_meta and release_game_poll_pin via
  -- set_config(..., true). NULL/empty when called from any other path
  -- (vote triggers, direct UI actions, etc.).
  --
  -- current_setting(name, missing_ok=true) returns empty string when the
  -- GUC was never set this transaction — checking against 'true' covers
  -- both the not-set and the not-our-flag cases.
  v_silent := current_setting('app.suppress_poll_notifications', true);

  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'open' AND v_silent <> 'true' THEN
      PERFORM enqueue_poll_notification(NEW.id, 'creation');
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  -- When the silent flag is set, skip the entire enqueue logic. We still
  -- let the UPDATE complete (status/target/confirmed_date_id will reflect
  -- the admin's intent). No notification job is created → no push, no
  -- email. The change is still visible to anyone who opens the schedule
  -- tab via realtime, just not pushed.
  IF v_silent = 'true' THEN
    RETURN NEW;
  END IF;

  -- Status transitions (covers the main lifecycle path)
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF NEW.status = 'expanded' THEN
      PERFORM enqueue_poll_notification(NEW.id, 'expanded');
    ELSIF NEW.status = 'confirmed' THEN
      PERFORM enqueue_poll_notification(NEW.id, 'confirmed');
    ELSIF NEW.status = 'cancelled' THEN
      PERFORM enqueue_poll_notification(NEW.id, 'cancellation');
    END IF;
  -- Re-pin: status stays 'confirmed' but the pinned date changed.
  -- Treat as a fresh 'confirmed' broadcast so recipients on the new date
  -- learn the lineup moved.
  ELSIF NEW.status = 'confirmed'
        AND OLD.confirmed_date_id IS DISTINCT FROM NEW.confirmed_date_id
        AND NEW.confirmed_date_id IS NOT NULL THEN
    PERFORM enqueue_poll_notification(NEW.id, 'confirmed');
  END IF;

  -- Target lowered on an already-confirmed poll: if yes_count on the
  -- pinned date is now >= new target, the seat target was retroactively
  -- met. Enqueue 'target_filled' so yes-voters get the "המשחק מלא" ping.
  -- We only fire this when target STRICTLY decreased — bumping target
  -- back up never triggers this branch even if it momentarily un-fills
  -- a previously-filled poll.
  --
  -- NOTE: when update_game_poll_meta sets the silent flag, we exit
  -- above before reaching this branch. So target lowering via the Edit
  -- modal is silent. A target lowered by ANY OTHER path (none today,
  -- but defensive) would still fire here.
  IF NEW.status = 'confirmed'
     AND NEW.confirmed_date_id IS NOT NULL
     AND OLD.target_player_count IS DISTINCT FROM NEW.target_player_count
     AND NEW.target_player_count < OLD.target_player_count THEN

    SELECT count(*) INTO v_yes_cnt
      FROM game_poll_votes
      WHERE date_id = NEW.confirmed_date_id AND response = 'yes';

    IF v_yes_cnt >= NEW.target_player_count THEN
      PERFORM enqueue_poll_notification(NEW.id, 'target_filled');
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Trigger binding from mig 062 is unchanged — CREATE OR REPLACE FUNCTION
-- preserves it.

-- ──────────────────────────────────────────────────────────────────────────
-- 2. update_game_poll_meta — set the silent flag
-- ──────────────────────────────────────────────────────────────────────────
--
-- The Edit poll modal calls this RPC for ALL metadata changes: target,
-- expansion delay, note, default location, allow_maybe. None of these are
-- member-facing state transitions; they're admin tweaks. The threshold
-- re-eval at the bottom CAN flip status from expanded → confirmed if a
-- lower target retroactively meets yes-count, which today fires email
-- blast #2 + #3 in the cascade above. Setting app.suppress_poll_notifications
-- at the top of this function tells the trigger to skip the enqueue.
--
-- If admins ever want a loud edit, they can broadcast manually via the
-- existing Share affordance on PollCard — same screenshot path the
-- "share confirmation" button already uses.

CREATE OR REPLACE FUNCTION public.update_game_poll_meta(
  p_poll_id          UUID,
  p_target           INT,
  p_expansion_delay  INT,
  p_note             TEXT,
  p_default_location TEXT,
  p_allow_maybe      BOOLEAN
)
RETURNS VOID AS $$
DECLARE
  v_group_id     UUID;
  v_winning_date UUID;
  v_yes_cnt      INT;
BEGIN
  SELECT group_id INTO v_group_id FROM game_polls WHERE id = p_poll_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'invalid_poll';
  END IF;

  IF NOT is_schedule_admin(v_group_id) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  IF p_target IS NULL OR p_target < 2 THEN
    RAISE EXCEPTION 'invalid_target';
  END IF;

  IF p_expansion_delay IS NULL OR p_expansion_delay < 0 THEN
    RAISE EXCEPTION 'invalid_delay';
  END IF;

  -- Silent flag: trigger fn_enqueue_poll_notification_on_change checks
  -- this and skips the entire enqueue body when set. is_local=true
  -- scopes the flag to the current transaction; no leakage to other
  -- callers or future statements.
  PERFORM set_config('app.suppress_poll_notifications', 'true', true);

  -- Atomic update of all metadata fields. Includes 'confirmed' so admins
  -- can lower the target after lock-in (e.g. 7→6 once one player drops).
  -- 'cancelled' / 'expired' stay locked — terminal states are terminal.
  UPDATE game_polls
     SET target_player_count   = p_target,
         expansion_delay_hours = p_expansion_delay,
         note                  = NULLIF(p_note, ''),
         default_location      = NULLIF(p_default_location, ''),
         allow_maybe           = COALESCE(p_allow_maybe, allow_maybe)
   WHERE id = p_poll_id
     AND status IN ('open', 'expanded', 'confirmed');

  -- Threshold re-eval: a lowered target on an open/expanded poll can
  -- flip it to 'confirmed' immediately. Already-confirmed polls are
  -- excluded by this UPDATE's own status filter, which is correct —
  -- editing a confirmed poll should never silently re-confirm it onto
  -- a different date.
  --
  -- Even though this flip is now silent (no push/email), we still flip
  -- the status so the poll's data model reflects reality and the UI
  -- updates via realtime. Members will see the state change next time
  -- they open the schedule tab; no notification is sent.
  SELECT date_id, count(*) INTO v_winning_date, v_yes_cnt
    FROM game_poll_votes
    WHERE poll_id = p_poll_id AND response = 'yes'
    GROUP BY date_id
    ORDER BY count(*) DESC, date_id ASC
    LIMIT 1;

  IF v_winning_date IS NOT NULL AND v_yes_cnt >= p_target THEN
    UPDATE game_polls
       SET status = 'confirmed',
           confirmed_date_id = v_winning_date,
           confirmed_at = NOW()
     WHERE id = p_poll_id
       AND status IN ('open', 'expanded');

    -- Mirror the legacy sentinels so runSchedulerSweep's backfill path
    -- doesn't see "confirmed && sentinel NULL" and re-enqueue the job
    -- after the worker drains. The flip is silent — sentinel should
    -- reflect "no announcement needed, already-known state".
    UPDATE game_polls
       SET confirmed_notifications_sent_at =
             COALESCE(confirmed_notifications_sent_at, NOW()),
           target_filled_notifications_sent_at = CASE
             WHEN v_yes_cnt >= p_target
               THEN COALESCE(target_filled_notifications_sent_at, NOW())
             ELSE target_filled_notifications_sent_at
           END
     WHERE id = p_poll_id;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION update_game_poll_meta(UUID, INT, INT, TEXT, TEXT, BOOLEAN) TO authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 3. release_game_poll_pin — silent + clear voting lock
-- ──────────────────────────────────────────────────────────────────────────
--
-- Three changes from mig 084:
--
--   a. Set app.suppress_poll_notifications so the status flip
--      confirmed → expanded/open does NOT enqueue an 'expanded' email
--      blast. Releasing a pin is "admin internal undo", not a
--      member-facing event. Members can see the change via realtime
--      next time they open the app; no push/email needed.
--
--   b. STOP nulling confirmed_notifications_sent_at +
--      target_filled_notifications_sent_at. Mig 084's rationale was
--      "next pin re-announces fresh" — but combined with the
--      runSchedulerSweep backfill (which fires on sentinel NULL +
--      status 'confirmed'), this caused email blast #3 in Lior's
--      cascade. Now that release_pin is silent and the trigger
--      handles the only genuine re-announce case (re-pin to a
--      DIFFERENT date, via mig 062's branch), the reset is
--      counter-productive. Members already received the 'confirmed'
--      notification for the pinned date when it was first pinned;
--      releasing and re-pinning to the SAME date doesn't need a
--      second blast.
--
--   c. Clear voting_locked_at. The whole intent of releasing a pin is
--      "I want to wiggle the lineup" — but today the lock from the
--      original auto-confirm carries through, so the dropping player
--      can't change their own vote and admin has to manually unlock
--      via the kebab menu. One click should put the poll back into
--      "fully editable" state.

CREATE OR REPLACE FUNCTION public.release_game_poll_pin(
  p_poll_id  UUID
)
RETURNS VOID AS $$
DECLARE
  v_group_id   UUID;
  v_expanded   TIMESTAMPTZ;
  v_game_id    UUID;
  v_status     TEXT;
BEGIN
  SELECT group_id, expanded_at, confirmed_game_id, status
    INTO v_group_id, v_expanded, v_game_id, v_status
    FROM game_polls
   WHERE id = p_poll_id;

  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'invalid_poll';
  END IF;

  IF NOT is_schedule_admin(v_group_id) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  IF v_game_id IS NOT NULL THEN
    -- Mirrors mig 084's confirmed_game_id guard. A pinned poll with a
    -- game record is "settled in the real world" — releasing the pin
    -- would desync the game row's date column from the poll.
    RAISE EXCEPTION 'game_already_started';
  END IF;

  IF v_status <> 'confirmed' THEN
    RAISE EXCEPTION 'not_pinned';
  END IF;

  -- Silent flag: same mechanism as update_game_poll_meta. Trigger
  -- skips the enqueue body when this is set.
  PERFORM set_config('app.suppress_poll_notifications', 'true', true);

  UPDATE game_polls
     SET status = CASE
                    WHEN v_expanded IS NOT NULL THEN 'expanded'
                    ELSE 'open'
                  END,
         confirmed_date_id = NULL,
         confirmed_at = NULL,
         -- NOTE: confirmed_notifications_sent_at and
         -- target_filled_notifications_sent_at are NOT reset here.
         -- This is the deliberate change vs. mig 084 — see migration
         -- header. Preserving them prevents both the trigger and the
         -- sweep backfill from re-firing on a same-date re-confirm.
         voting_locked_at = NULL
   WHERE id = p_poll_id
     AND status = 'confirmed'
     AND confirmed_game_id IS NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

GRANT EXECUTE ON FUNCTION release_game_poll_pin(UUID) TO authenticated;

-- ============================================================================
-- DONE — Verify with:
--
-- 1. Function bodies updated:
--    SELECT pg_get_functiondef('public.fn_enqueue_poll_notification_on_change'::regproc);
--    -- expect body that contains "app.suppress_poll_notifications"
--    SELECT pg_get_functiondef('public.update_game_poll_meta'::regproc);
--    -- expect body that contains set_config('app.suppress_poll_notifications'…)
--    SELECT pg_get_functiondef('public.release_game_poll_pin'::regproc);
--    -- expect body that contains set_config + voting_locked_at = NULL
--    -- and does NOT contain "confirmed_notifications_sent_at = NULL"
--
-- 2. Smoke test (against a throwaway test poll, NOT a live one):
--    -- a. Create a poll with target=2, 1 yes vote → status=open.
--    -- b. Call update_game_poll_meta with target=1 → status flips to
--    --    confirmed silently. notification_jobs gets NO new row for this
--    --    poll between the before/after snapshots.
--    -- c. Call release_game_poll_pin → status flips to open/expanded
--    --    silently. notification_jobs gets NO new row. voting_locked_at
--    --    is now NULL.
--    -- d. Cast a 2nd yes vote → auto_close_poll_on_vote re-confirms LOUDLY
--    --    (the silent flag is not in scope for this xact, by design).
--    --    notification_jobs gets a 'confirmed' row.
-- ============================================================================
