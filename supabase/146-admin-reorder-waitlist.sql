-- ============================================================
-- Migration 146: Admin Reorder Poll Waitlist RPC
-- ============================================================
-- Allows a schedule admin to reorder waitlisted players on a
-- poll date. Waitlist FIFO queue order across the DB (auto-promotion
-- in fn_promote_waitlist_for_date) and client/worker UI is driven by
-- game_poll_votes.voted_at ASC, id ASC.
-- Updating voted_at on existing 'waitlist' rows does not fire
-- trg_enqueue_vote_change_on_vote (which only fires on UPDATE OF
-- response, comment).
-- ============================================================

CREATE OR REPLACE FUNCTION public.admin_reorder_poll_waitlist(
  p_date_id UUID,
  p_player_ids UUID[]
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_poll RECORD;
  v_min_voted_at TIMESTAMPTZ;
  v_waitlist_count INT;
  v_base_ts TIMESTAMPTZ;
  v_pos INT := 0;
  v_pid UUID;
  v_rem RECORD;
BEGIN
  PERFORM 1 FROM public.game_poll_dates WHERE id = p_date_id FOR UPDATE;

  SELECT p.* INTO v_poll
    FROM public.game_polls p
    JOIN public.game_poll_dates d ON d.poll_id = p.id
   WHERE d.id = p_date_id;

  IF v_poll.id IS NULL THEN
    RAISE EXCEPTION 'invalid_date_id';
  END IF;

  IF NOT public.is_schedule_admin(v_poll.group_id) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  IF v_poll.status NOT IN ('open', 'expanded', 'confirmed') OR v_poll.confirmed_game_id IS NOT NULL THEN
    RAISE EXCEPTION 'poll_locked';
  END IF;

  IF p_player_ids IS NULL OR COALESCE(array_length(p_player_ids, 1), 0) = 0 THEN
    RETURN;
  END IF;

  SELECT MIN(voted_at), COUNT(*)
    INTO v_min_voted_at, v_waitlist_count
    FROM public.game_poll_votes
   WHERE date_id = p_date_id
     AND response = 'waitlist';

  IF COALESCE(v_waitlist_count, 0) < 2 THEN
    RETURN;
  END IF;

  -- Anchor base timestamp in the past so any future waitlist joiner (voted_at = now())
  -- naturally lands after the reordered waitlist queue.
  v_base_ts := LEAST(
    COALESCE(v_min_voted_at, now()),
    now() - ((v_waitlist_count + 10) * interval '1 second')
  );

  -- 1. Assign sequential timestamps to the players specified in p_player_ids
  FOREACH v_pid IN ARRAY p_player_ids LOOP
    IF EXISTS (
      SELECT 1 FROM public.game_poll_votes
       WHERE date_id = p_date_id
         AND player_id = v_pid
         AND response = 'waitlist'
    ) THEN
      v_pos := v_pos + 1;
      UPDATE public.game_poll_votes
         SET voted_at = v_base_ts + (v_pos * interval '1 second')
       WHERE date_id = p_date_id
         AND player_id = v_pid
         AND response = 'waitlist';
    END IF;
  END LOOP;

  -- 2. Keep any other waitlisted players (not passed in p_player_ids) after them in relative order
  FOR v_rem IN
    SELECT id
      FROM public.game_poll_votes
     WHERE date_id = p_date_id
       AND response = 'waitlist'
       AND NOT (player_id = ANY(p_player_ids))
     ORDER BY voted_at ASC, id ASC
  LOOP
    v_pos := v_pos + 1;
    UPDATE public.game_poll_votes
       SET voted_at = v_base_ts + (v_pos * interval '1 second')
     WHERE id = v_rem.id;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_reorder_poll_waitlist(UUID, UUID[]) TO authenticated;
