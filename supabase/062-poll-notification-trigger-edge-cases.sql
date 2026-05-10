-- ============================================================================
-- supabase/062-poll-notification-trigger-edge-cases.sql
--
-- Extends migration 061's trigger to cover two edge cases that the
-- status-change-only check would miss:
--
--   1. RE-PIN: admin uses manual_close_game_poll to switch the
--      confirmed_date_id on an already-confirmed poll. Status stays
--      'confirmed', so the IS DISTINCT FROM status check returns false
--      and no 'confirmed' job gets enqueued. Recipients on the new
--      date never learn the lineup moved.
--
--   2. TARGET LOWERED: admin uses update_poll_target / update_poll_meta
--      to drop target_player_count on an already-confirmed poll. If
--      yes_count was already >= the new target, the seat target is
--      retroactively met but no vote was cast — so
--      fn_enqueue_target_filled_on_vote (which only fires on vote
--      inserts/updates) doesn't run.
--
-- Fix: include confirmed_date_id and target_player_count in the trigger's
-- UPDATE OF column list, and add explicit detection branches inside
-- fn_enqueue_poll_notification_on_change.
--
-- IDEMPOTENT: re-runnable. CREATE OR REPLACE on the function, DROP/CREATE
-- on the trigger.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_enqueue_poll_notification_on_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = 'public'
AS $$
DECLARE
  v_yes_cnt INT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'open' THEN
      PERFORM enqueue_poll_notification(NEW.id, 'creation');
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP <> 'UPDATE' THEN
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

-- Replace trigger so the column list includes confirmed_date_id and
-- target_player_count. Without these, the function's new branches
-- never get a chance to run.
DROP TRIGGER IF EXISTS trg_enqueue_poll_notification ON public.game_polls;
CREATE TRIGGER trg_enqueue_poll_notification
  AFTER INSERT OR UPDATE OF status, confirmed_date_id, target_player_count
  ON public.game_polls
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_enqueue_poll_notification_on_change();
