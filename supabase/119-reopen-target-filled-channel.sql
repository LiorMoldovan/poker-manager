-- 119 — Let a worker reopen the 'game is full' channel
--
-- Quiet hours (117) can hold a target_filled job until 07:00. If someone
-- drops out overnight the job's premise is dead and both workers now skip
-- it rather than announce a full game that isn't full.
--
-- Skipping means completing the job, and completion stamps
-- target_filled_notifications_sent_at, which makes enqueue_poll_notification
-- a permanent no-op for that kind. So a poll that dipped below target and
-- later refilled would never announce again — the same "silently muted for
-- good" failure migration 108 had to undo.
--
-- The server worker holds service-role and clears the column directly. The
-- browser worker runs under RLS and cannot, hence this RPC. It is
-- self-validating: it refuses to clear the sentinel while the game actually
-- is full, so a member cannot use it to force a repeat announcement.

CREATE OR REPLACE FUNCTION public.reopen_target_filled_channel(p_poll_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_poll game_polls%ROWTYPE;
  v_yes  INT;
BEGIN
  SELECT * INTO v_poll FROM game_polls WHERE id = p_poll_id;
  IF v_poll.id IS NULL THEN
    RETURN FALSE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM group_members
     WHERE group_id = v_poll.group_id
       AND user_id  = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not_member';
  END IF;

  -- Still at target? Then the notice was legitimate and the sentinel stays.
  IF v_poll.status = 'confirmed' AND v_poll.confirmed_date_id IS NOT NULL THEN
    SELECT count(*) INTO v_yes
      FROM game_poll_votes
     WHERE date_id  = v_poll.confirmed_date_id
       AND response = 'yes';

    IF v_yes >= v_poll.target_player_count THEN
      RETURN FALSE;
    END IF;
  END IF;

  UPDATE game_polls
     SET target_filled_notifications_sent_at = NULL
   WHERE id = p_poll_id
     AND target_filled_notifications_sent_at IS NOT NULL;

  RETURN TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.reopen_target_filled_channel(uuid) TO authenticated;
