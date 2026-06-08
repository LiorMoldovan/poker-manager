-- ============================================================
-- Migration 102: let admins edit maybe_hold_hours on an open poll
-- Run after 101-permanent-maybe-seat-hold.sql. Idempotent.
--
-- WHY
-- 101 added game_polls.maybe_hold_hours + a group default, editable when
-- creating a poll. But once a poll is open/expanded there was no way to
-- adjust the hold window. This extends update_game_poll_meta (the Edit-poll
-- RPC) with p_maybe_hold_hours so admins can shorten/lengthen the window
-- live — shortening it can release held seats immediately (the release
-- moment is expanded_at + maybe_hold_hours), lengthening extends them.
--
-- A defaulted param would create a second overload that makes the old
-- 6-arg calls ambiguous, so drop the 6-arg signature first.
-- NULL p_maybe_hold_hours = leave the current value untouched.
-- ============================================================

DROP FUNCTION IF EXISTS public.update_game_poll_meta(uuid, integer, integer, text, text, boolean);

CREATE OR REPLACE FUNCTION public.update_game_poll_meta(
  p_poll_id          uuid,
  p_target           integer,
  p_expansion_delay  integer,
  p_note             text,
  p_default_location text,
  p_allow_maybe      boolean,
  p_maybe_hold_hours integer DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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

  IF p_maybe_hold_hours IS NOT NULL AND p_maybe_hold_hours < 0 THEN
    RAISE EXCEPTION 'invalid_delay';
  END IF;

  PERFORM set_config('app.suppress_poll_notifications', 'true', true);

  UPDATE game_polls
     SET target_player_count   = p_target,
         expansion_delay_hours = p_expansion_delay,
         maybe_hold_hours      = COALESCE(p_maybe_hold_hours, maybe_hold_hours),
         note                  = NULLIF(p_note, ''),
         default_location      = NULLIF(p_default_location, ''),
         allow_maybe           = COALESCE(p_allow_maybe, allow_maybe)
   WHERE id = p_poll_id
     AND status IN ('open', 'expanded', 'confirmed');

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
$function$;
