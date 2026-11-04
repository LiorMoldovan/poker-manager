-- =============================================================================
-- Migration 145: Notifications Polish for Waitlist Promotion & Date Preference
-- =============================================================================
-- Enriches `fn_enqueue_vote_change_on_vote` so that when a waitlisted voter is
-- promoted from 'waitlist' -> 'yes', the enqueued `vote_change` payload carries
-- `from_waitlist = true` and attributes the actor to the voter's own `user_id`
-- (so an admin who originally placed them on the waitlist by proxy still hears
-- that they were promoted into the game).
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_enqueue_vote_change_on_vote()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_poll          game_polls%ROWTYPE;
  v_actor_uid     UUID;
  v_from_waitlist BOOLEAN;
  v_payload       JSONB;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.response IS NOT DISTINCT FROM NEW.response
     AND COALESCE(OLD.comment,'') = COALESCE(NEW.comment,'') THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_poll FROM game_polls WHERE id = NEW.poll_id;
  IF v_poll.id IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_poll.status = 'cancelled' THEN
    RETURN NEW;
  END IF;

  v_from_waitlist := (TG_OP = 'UPDATE' AND OLD.response = 'waitlist' AND NEW.response = 'yes');

  v_actor_uid := CASE
    WHEN v_from_waitlist THEN NEW.user_id
    ELSE COALESCE(NEW.cast_by_user_id, NEW.user_id)
  END;

  v_payload := jsonb_build_object(
    'date_id',       NEW.date_id,
    'player_id',     NEW.player_id,
    'response',      NEW.response,
    'comment',       NEW.comment,
    'is_new_vote',   (TG_OP = 'INSERT'),
    'from_waitlist', v_from_waitlist,
    'actor_user_id', v_actor_uid
  );

  PERFORM enqueue_notification('vote_change', v_poll.group_id, NEW.poll_id, v_payload);

  RETURN NEW;
END;
$function$;

