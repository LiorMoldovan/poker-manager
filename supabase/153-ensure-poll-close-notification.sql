-- =============================================================================
-- Migration 153: Ensure Poll Close Notification Sends At Least Once
-- =============================================================================
-- Problem:
--   When an admin edits a poll's target_player_count downward via
--   `update_game_poll_meta`, the function sets `app.suppress_poll_notifications = 'true'`
--   so metadata edits are silent. However, if the lowered target caused the poll
--   to auto-confirm, `update_game_poll_meta` ALSO stamped:
--     confirmed_notifications_sent_at = NOW()
--     target_filled_notifications_sent_at = NOW()
--   even though NO notification was actually sent to the group!
--   If the admin later released the pin (`release_game_poll_pin`) or raised the
--   target back up, those fake sentinel timestamps remained set and permanently
--   blocked the real 'confirmed' / 'target_filled' notification when the game
--   genuinely filled up via player votes.
--
-- Solution:
--   1. `update_game_poll_meta` NEVER stamps fake `*_notifications_sent_at`
--      sentinels. If a lowered target causes a poll to reach its target and
--      confirm (or fills an already-confirmed poll), and no close/fill
--      notification has been sent yet for this date, it enqueues the
--      announcement so the group receives at least one summary that the game
--      is closed.
--   2. `auto_close_poll_on_vote` resets `confirmed_notifications_sent_at` and
--      `target_filled_notifications_sent_at` if `confirmed_notified_date_id` is
--      NULL or differs from the winning date (matching `manual_close_game_poll`),
--      ensuring a genuine vote-driven auto-close is never blocked by a stale
--      sentinel from an unannounced state.
-- =============================================================================

-- ── 1. auto_close_poll_on_vote ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.auto_close_poll_on_vote()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_target         INT;
  v_yes_cnt        INT;
  v_date_disabled  BOOLEAN;
BEGIN
  IF NEW.response <> 'yes' THEN
    RETURN NEW;
  END IF;

  SELECT (disabled_at IS NOT NULL) INTO v_date_disabled
    FROM game_poll_dates WHERE id = NEW.date_id;

  IF v_date_disabled THEN
    RETURN NEW;
  END IF;

  SELECT target_player_count INTO v_target
    FROM game_polls WHERE id = NEW.poll_id;

  SELECT count(*) INTO v_yes_cnt
    FROM game_poll_votes
    WHERE date_id = NEW.date_id AND response = 'yes';

  IF v_yes_cnt >= v_target THEN
    UPDATE game_polls
       SET status = 'confirmed',
           confirmed_date_id = NEW.date_id,
           confirmed_at = now(),
           confirmed_notifications_sent_at = CASE
             WHEN confirmed_notified_date_id IS DISTINCT FROM NEW.date_id
             THEN NULL ELSE confirmed_notifications_sent_at END,
           target_filled_notifications_sent_at = CASE
             WHEN confirmed_notified_date_id IS DISTINCT FROM NEW.date_id
             THEN NULL ELSE target_filled_notifications_sent_at END,
           confirmed_notified_date_id = NEW.date_id
     WHERE id = NEW.poll_id
       AND status IN ('open', 'expanded');
  END IF;

  RETURN NEW;
END;
$function$;


-- ── 2. update_game_poll_meta (8-arg current version) ──────────────────────────
CREATE OR REPLACE FUNCTION public.update_game_poll_meta(
  p_poll_id uuid,
  p_target integer,
  p_expansion_delay integer,
  p_note text,
  p_default_location text,
  p_allow_maybe boolean,
  p_maybe_hold_hours integer DEFAULT NULL::integer,
  p_reminder_evening_time text DEFAULT NULL::text
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_poll         game_polls%ROWTYPE;
  v_winning_date UUID;
  v_yes_cnt      INT;
  v_d            RECORD;
BEGIN
  SELECT * INTO v_poll FROM game_polls WHERE id = p_poll_id;
  IF v_poll.id IS NULL THEN
    RAISE EXCEPTION 'invalid_poll';
  END IF;

  IF NOT is_schedule_admin(v_poll.group_id) THEN
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

  -- Suppress generic trigger noise for routine metadata edits
  PERFORM set_config('app.suppress_poll_notifications', 'true', true);

  UPDATE game_polls
     SET target_player_count   = p_target,
         expansion_delay_hours = p_expansion_delay,
         maybe_hold_hours      = COALESCE(p_maybe_hold_hours, maybe_hold_hours),
         note                  = NULLIF(p_note, ''),
         default_location      = NULLIF(p_default_location, ''),
         allow_maybe           = COALESCE(p_allow_maybe, allow_maybe),
         reminder_evening_time = COALESCE(NULLIF(p_reminder_evening_time, ''), reminder_evening_time)
   WHERE id = p_poll_id
     AND status IN ('open', 'expanded', 'confirmed');

  -- Promote waitlisted players if target increased or hold window shortened
  IF v_poll.confirmed_date_id IS NOT NULL THEN
    PERFORM fn_promote_waitlist_for_date(v_poll.confirmed_date_id);
  ELSE
    FOR v_d IN
      SELECT d.id
        FROM game_poll_dates d
        LEFT JOIN game_poll_votes v ON v.date_id = d.id AND v.response = 'yes'
       WHERE d.poll_id = p_poll_id
         AND d.disabled_at IS NULL
       GROUP BY d.id, d.proposed_date
       ORDER BY count(v.id) DESC,
                count(v.id) FILTER (WHERE v.is_preferred) DESC,
                d.proposed_date ASC
    LOOP
      PERFORM fn_promote_waitlist_for_date(v_d.id);
    END LOOP;
  END IF;

  -- Case A: Poll was open/expanded — check if any enabled date now meets the new target
  IF v_poll.status IN ('open', 'expanded') THEN
    SELECT v.date_id, count(*) INTO v_winning_date, v_yes_cnt
      FROM game_poll_votes v
      JOIN game_poll_dates d ON d.id = v.date_id
     WHERE v.poll_id = p_poll_id
       AND v.response = 'yes'
       AND d.disabled_at IS NULL
     GROUP BY v.date_id
     ORDER BY count(*) DESC,
              count(*) FILTER (WHERE v.is_preferred) DESC,
              v.date_id ASC
     LIMIT 1;

    IF v_winning_date IS NOT NULL AND v_yes_cnt >= p_target THEN
      UPDATE game_polls
         SET status = 'confirmed',
             confirmed_date_id = v_winning_date,
             confirmed_at = NOW(),
             confirmed_notifications_sent_at = CASE
               WHEN confirmed_notified_date_id IS DISTINCT FROM v_winning_date
               THEN NULL ELSE confirmed_notifications_sent_at END,
             target_filled_notifications_sent_at = CASE
               WHEN confirmed_notified_date_id IS DISTINCT FROM v_winning_date
               THEN NULL ELSE target_filled_notifications_sent_at END,
             confirmed_notified_date_id = v_winning_date
       WHERE id = p_poll_id
         AND status IN ('open', 'expanded');

      -- Ensure at least one game-closed summary is sent when confirming via target change
      PERFORM enqueue_poll_notification(p_poll_id, 'confirmed');
    END IF;

  -- Case B: Poll was already confirmed — if target was lowered and the pinned date is now full,
  -- ensure the group gets the game-full summary if they haven't already.
  ELSIF v_poll.status = 'confirmed' AND v_poll.confirmed_date_id IS NOT NULL THEN
    SELECT count(*) INTO v_yes_cnt
      FROM game_poll_votes
     WHERE date_id = v_poll.confirmed_date_id
       AND response = 'yes';

    IF v_yes_cnt >= p_target THEN
      IF v_poll.confirmed_notifications_sent_at IS NULL THEN
        PERFORM enqueue_poll_notification(p_poll_id, 'confirmed');
      ELSIF v_poll.target_filled_notifications_sent_at IS NULL THEN
        PERFORM enqueue_poll_notification(p_poll_id, 'target_filled');
      END IF;
    END IF;
  END IF;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.update_game_poll_meta(uuid, integer, integer, text, text, boolean, integer, text)
  TO authenticated;
