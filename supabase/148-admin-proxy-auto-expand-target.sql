-- ============================================================
-- Migration 148: Admin Proxy Auto-Expand Target Headcount
-- ============================================================
-- When an admin explicitly assigns 'yes' (via admin_cast_poll_vote)
-- and the current yes count on that date reaches or exceeds target_player_count,
-- automatically increase target_player_count to accommodate the new player.
-- This saves admins having to manually close the modal, edit the poll target,
-- and re-open the player selection modal.
-- ============================================================

CREATE OR REPLACE FUNCTION public.admin_cast_poll_vote(
  p_date_id uuid,
  p_voter_player_id uuid,
  p_response text,
  p_comment text DEFAULT NULL::text
)
RETURNS SETOF game_polls
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_poll                game_polls%ROWTYPE;
  v_player_group        UUID;
  v_player_user         UUID;
  v_player_type         TEXT;
  v_date_disabled       BOOLEAN;
  v_already_yes         BOOLEAN;
  v_yes_count           INT;
  v_effective_response  TEXT;
BEGIN
  PERFORM 1 FROM game_poll_dates WHERE id = p_date_id FOR UPDATE;

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

  IF v_poll.confirmed_date_id IS NOT NULL
     AND p_date_id <> v_poll.confirmed_date_id
     AND EXISTS (
       SELECT 1 FROM game_poll_dates
        WHERE id = v_poll.confirmed_date_id AND disabled_at IS NULL
     ) THEN
    RAISE EXCEPTION 'date_not_picked';
  END IF;

  IF NOT is_schedule_admin(v_poll.group_id) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  IF p_response NOT IN ('yes', 'no', 'maybe', 'waitlist') THEN
    RAISE EXCEPTION 'invalid_response';
  END IF;

  SELECT group_id, type INTO v_player_group, v_player_type
    FROM players WHERE id = p_voter_player_id;
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

  v_effective_response := p_response;

  SELECT (response = 'yes') INTO v_already_yes
    FROM game_poll_votes
   WHERE date_id = p_date_id AND player_id = p_voter_player_id
   LIMIT 1;

  IF p_response = 'yes' THEN
    IF NOT COALESCE(v_already_yes, FALSE) THEN
      SELECT count(*) INTO v_yes_count
        FROM game_poll_votes
       WHERE date_id = p_date_id AND response = 'yes';

      IF v_yes_count >= v_poll.target_player_count THEN
        -- Admin chose to add a player beyond the current target!
        -- Automatically raise target_player_count to accommodate the new player.
        UPDATE game_polls
           SET target_player_count = v_yes_count + 1
         WHERE id = v_poll.id;
        v_poll.target_player_count := v_yes_count + 1;
      END IF;
    END IF;
  ELSIF p_response = 'waitlist' THEN
    -- Admin explicitly requested waitlist: ALWAYS respect admin's choice, NEVER auto-upgrade!
    v_effective_response := 'waitlist';
  END IF;

  INSERT INTO game_poll_votes (
    poll_id, date_id, player_id, user_id, response, comment, voted_at,
    cast_by_user_id
  )
  VALUES (
    v_poll.id, p_date_id, p_voter_player_id, v_player_user,
    v_effective_response, p_comment, now(),
    auth.uid()
  )
  ON CONFLICT (date_id, player_id) DO UPDATE
    SET response        = EXCLUDED.response,
        comment         = EXCLUDED.comment,
        voted_at        = CASE
          WHEN game_poll_votes.response = 'waitlist' AND EXCLUDED.response = 'waitlist'
            THEN game_poll_votes.voted_at
          ELSE now()
        END,
        cast_by_user_id = auth.uid();

  RETURN QUERY
    SELECT * FROM game_polls WHERE id = v_poll.id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_cast_poll_vote(uuid, uuid, text, text) TO authenticated;

