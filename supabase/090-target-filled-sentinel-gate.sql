-- ============================================================
-- Migration 090: target_filled trigger honors the sentinel
-- Run in Supabase SQL Editor after 089-silent-poll-meta-edits.sql
-- (Idempotent — CREATE OR REPLACE only.)
--
-- Why: Mig 089 closed the "loud admin meta-edit" loop (target lowered
--   silently, release-pin silent, sentinels preserved across the round-
--   trip). The natural admin follow-up — proxy-removing a dropped player
--   and proxy-adding a replacement — still had one sharp edge: the
--   replacement's yes vote pushes yes_cnt back up to target on the
--   already-confirmed date, and fn_enqueue_target_filled_on_vote happily
--   enqueued ANOTHER 'target_filled' email blast to all yes voters. The
--   group had already received the "המשחק נסגר!" email when the date was
--   originally pinned; firing it a second time on a roster swap is
--   exactly the email-quota wastage we burned mig 089 to stop.
--
--   The notification_jobs partial unique index on (poll_id, kind) only
--   covers pending/running rows, so once the original target_filled
--   job is 'completed', a duplicate insert succeeds without complaint.
--   The function-level debounce (`now() - confirmed_at < 500ms`) only
--   catches the simultaneous auto_close + vote case; for a same-week
--   roster swap, confirmed_at is days old and the debounce is useless.
--
-- Fix: gate the enqueue on target_filled_notifications_sent_at IS NULL.
--   The sentinel is the canonical "this pin already announced".
--
-- Coverage check (each path traced):
--   * Initial auto-close (canonical): sentinel is NULL → fires once,
--     worker sets sentinel after delivery. Unchanged.
--   * Release pin → re-pin to same date (admin wants a 9th seat): mig
--     089 preserved the sentinel across release_pin. Sentinel still set
--     → trigger skips. The "המשחק נסגר" was already announced and the
--     pin/date pair didn't change. Correct.
--   * Release pin → re-pin to a different date: status trigger
--     (fn_enqueue_poll_notification_on_change, mig 062) enqueues
--     'confirmed' for the new date. That message conveys "the game is
--     locked in on <new date>" — semantically a superset of
--     target_filled. Adding a target_filled on top would be duplicate
--     copy to the same recipients. Skipping is correct.
--   * Admin proxy-adds a yes vote to a fully-confirmed poll (the case
--     this migration exists for): sentinel is set → trigger skips.
--     vote_change push still fires per its own trigger so other admins
--     see roster movement (vote_change is push-only by design — see
--     api/notification-worker.ts comment "vote_change is push-only").
--
-- No related path silently regresses:
--   * If for some reason the sentinel was wiped (e.g. an old manual_
--     close_game_poll path from mig 051 that resets it), the next yes
--     vote that meets target will legitimately re-announce. Sentinel-
--     based gating delegates "when to announce" to whoever owns the
--     sentinel writes — which is exactly the design intent.
-- ============================================================

CREATE OR REPLACE FUNCTION fn_enqueue_target_filled_on_vote()
RETURNS TRIGGER AS $$
DECLARE
  v_poll    game_polls%ROWTYPE;
  v_yes_cnt INT;
BEGIN
  IF NEW.response <> 'yes' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_poll FROM game_polls WHERE id = NEW.poll_id;
  IF v_poll.id IS NULL OR v_poll.status <> 'confirmed' THEN
    RETURN NEW;
  END IF;
  IF v_poll.confirmed_date_id IS NULL OR NEW.date_id <> v_poll.confirmed_date_id THEN
    RETURN NEW;
  END IF;

  -- Debounce against the auto_close trigger firing on the same vote
  -- that just flipped status → confirmed. Without this we'd double-
  -- enqueue at the exact moment of initial pin.
  IF v_poll.confirmed_at IS NOT NULL
     AND now() - v_poll.confirmed_at < interval '500 milliseconds' THEN
    RETURN NEW;
  END IF;

  -- NEW (mig 090): if we already announced target_filled for this pin,
  -- don't re-announce on subsequent yes votes. The sentinel is the
  -- canonical "this announcement has fired". It's reset only when a
  -- different date is confirmed (via the status trigger's own logic),
  -- so an over-confirmed poll won't keep emailing on every roster
  -- swap.
  IF v_poll.target_filled_notifications_sent_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_yes_cnt
    FROM game_poll_votes
    WHERE date_id = v_poll.confirmed_date_id AND response = 'yes';

  IF v_yes_cnt >= v_poll.target_player_count THEN
    PERFORM enqueue_poll_notification(v_poll.id, 'target_filled');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================
-- DONE — Verify with:
--   -- The function body has the new sentinel guard:
--   SELECT pg_get_functiondef('public.fn_enqueue_target_filled_on_vote'::regproc);
--
--   -- And the trigger is still wired up unchanged (no DROP/CREATE was needed):
--   SELECT tgname FROM pg_trigger
--    WHERE tgrelid = 'public.game_poll_votes'::regclass
--      AND tgname = 'trg_enqueue_target_filled_on_vote';
-- ============================================================
