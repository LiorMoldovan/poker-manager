-- 112 — Expansion seat check must respect the pinned date
--
-- Problem: once a date is picked, migration 106 funnels ALL voting to it —
-- `cast_poll_vote` raises `date_not_picked` for every other date. But the
-- expansion seat check in `expand_game_poll` never learned about the pin: it
-- scans every non-excluded date and opens the poll to guests if ANY of them
-- has a free seat.
--
-- So a poll pinned to a full date (say target 7 with 5 yes + 2 permanent
-- maybe-holds) still invites guests on the strength of the rival dates that
-- nobody is allowed to vote on. Those guests then hit `date_not_picked` on
-- every rival date and `seat_held` on the pinned one — invited to a poll
-- where there is nowhere to say yes.
--
-- That is precisely the failure migration 104 set out to prevent ("don't
-- stamp expanded_at until a date has a genuinely free seat"); 104 simply
-- didn't account for the pin as a second way a seat can be unreachable.
--
-- Fix: when the poll has a pinned date, the seat check considers that date
-- alone. The guard mirrors `cast_poll_vote`'s funnel exactly, including its
-- escape hatch — a pin stranded on an excluded date must not veto every date
-- at once, so in that case we fall back to scanning them all (migration 109
-- prevents new strandings, but legacy rows may exist).
--
-- Unchanged: both expansion triggers from migration 111 (the delay clock and
-- "every registered permanent answered"), the maybe-hold arithmetic, and the
-- status handling.

CREATE OR REPLACE FUNCTION public.expand_game_poll(p_poll_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_group_id UUID;
BEGIN
  SELECT group_id INTO v_group_id FROM game_polls WHERE id = p_poll_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'invalid_poll';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM group_members
    WHERE group_id = v_group_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not_member';
  END IF;

  UPDATE game_polls gp
     SET expanded_at = now(),
         status = CASE WHEN status = 'open' THEN 'expanded' ELSE status END
   WHERE gp.id = p_poll_id
     AND gp.expanded_at IS NULL
     AND gp.status IN ('open', 'confirmed')
     AND (
       -- (a) the original clock
       now() - gp.created_at >= make_interval(hours => gp.expansion_delay_hours)
       -- (b) every registered permanent has engaged with this poll.
       --     Guarded by "at least one exists" so a group with no permanent
       --     players doesn't satisfy the NOT EXISTS vacuously and expand
       --     the instant the poll opens.
       OR (
         EXISTS (
           SELECT 1
             FROM players pl
             JOIN group_members gm ON gm.player_id = pl.id
            WHERE pl.group_id = gp.group_id
              AND pl.type = 'permanent'
         )
         AND NOT EXISTS (
           SELECT 1
             FROM players pl
             JOIN group_members gm ON gm.player_id = pl.id
            WHERE pl.group_id = gp.group_id
              AND pl.type = 'permanent'
              AND NOT EXISTS (
                SELECT 1
                  FROM game_poll_votes v
                  JOIN game_poll_dates d2 ON d2.id = v.date_id
                 WHERE d2.poll_id = gp.id
                   AND v.player_id = pl.id
              )
         )
       )
     )
     AND EXISTS (
       SELECT 1
         FROM game_poll_dates d
        WHERE d.poll_id = gp.id
          AND d.disabled_at IS NULL
          -- Only seats a guest could actually claim count. A pinned date
          -- is the sole votable one (migration 106), so free seats on the
          -- rival dates are unreachable and must not justify expanding.
          AND (
            gp.confirmed_date_id IS NULL
            OR d.id = gp.confirmed_date_id
            OR NOT EXISTS (
              SELECT 1 FROM game_poll_dates pd
               WHERE pd.id = gp.confirmed_date_id
                 AND pd.disabled_at IS NULL
            )
          )
          AND gp.target_player_count
              - (SELECT count(*) FROM game_poll_votes v
                  WHERE v.date_id = d.id AND v.response = 'yes')
              - CASE WHEN now() < gp.created_at
                                  + make_interval(hours => gp.expansion_delay_hours + gp.maybe_hold_hours)
                     THEN (SELECT count(*) FROM game_poll_votes v
                            JOIN players pl ON pl.id = v.player_id
                            WHERE v.date_id = d.id
                              AND v.response = 'maybe'
                              AND pl.type = 'permanent')
                     ELSE 0
                END
              > 0
     );
END;
$function$;
