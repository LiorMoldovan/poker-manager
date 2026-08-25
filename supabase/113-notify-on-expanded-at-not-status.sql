-- 113 — announce expansion from expanded_at, not from the status change
--
-- PROBLEM
-- expand_game_poll stamps expanded_at but only promotes status when the poll is
-- still 'open':
--     status = CASE WHEN status = 'open' THEN 'expanded' ELSE status END
-- A poll that already has a picked date stays 'confirmed'. The notification
-- trigger fired 'expanded' only on OLD.status IS DISTINCT FROM NEW.status, so
-- picked polls opened to guests in complete silence — the seats were there, the
-- server would accept the votes, and nobody was told.
--
-- FIX
-- expanded_at is the authoritative "guests are in now" signal; status 'expanded'
-- is just a derived label that a picked poll never wears. Key the announcement
-- off the NULL -> NOT NULL transition of expanded_at instead.
--
-- No double-fire: expand_game_poll is the only writer of expanded_at and it is
-- guarded by `AND gp.expanded_at IS NULL`, so the transition happens at most
-- once per poll. The old status branch is removed rather than kept alongside,
-- because on the open->expanded path both conditions would be true at once.
--
-- No regression on pin release: release_game_poll_pin can move status
-- confirmed -> expanded, but it sets app.suppress_poll_notifications first, so
-- it never emitted this notification and still doesn't.

CREATE OR REPLACE FUNCTION public.fn_enqueue_poll_notification_on_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_yes_cnt INT;
  v_silent  TEXT;
BEGIN
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

  IF v_silent = 'true' THEN
    RETURN NEW;
  END IF;

  -- Guests just gained access. Fires for both shapes of expansion: an 'open'
  -- poll promoted to 'expanded', and a 'confirmed' poll that keeps its status
  -- while expanded_at is stamped underneath it.
  IF OLD.expanded_at IS NULL AND NEW.expanded_at IS NOT NULL THEN
    PERFORM enqueue_poll_notification(NEW.id, 'expanded');
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF NEW.status = 'confirmed' THEN
      PERFORM enqueue_poll_notification(NEW.id, 'confirmed');
    ELSIF NEW.status = 'cancelled' THEN
      PERFORM enqueue_poll_notification(NEW.id, 'cancellation');
    END IF;
  ELSIF NEW.status = 'confirmed'
        AND OLD.confirmed_date_id IS DISTINCT FROM NEW.confirmed_date_id
        AND NEW.confirmed_date_id IS NOT NULL THEN
    PERFORM enqueue_poll_notification(NEW.id, 'confirmed');
  END IF;

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
$function$;
