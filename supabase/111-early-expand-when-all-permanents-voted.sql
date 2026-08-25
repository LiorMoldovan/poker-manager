-- 111 — Early guest expansion once every permanent has answered
--
-- Problem: the poll auto-creates Sunday morning and `expansion_delay_hours`
-- (24 for this group) is a hard floor, so guests cannot be invited before
-- Monday even when all the regulars have already replied and seats are
-- clearly going spare. A whole Sunday of recruiting time is lost for no
-- reason.
--
-- Change: `expand_game_poll` now accepts EITHER trigger —
--   (a) the existing delay elapsing, or
--   (b) every registered permanent player having engaged with the poll.
--
-- "Engaged" is deliberately loose, per the owner: a permanent counts as
-- having answered once they have ANY vote row on ANY of this poll's dates.
-- A yes on date 1, a 'maybe' on date 2 and silence on date 3 counts — the
-- signal we want is "the regulars have had their say", not "every cell of
-- the grid is filled".
--
-- "Registered" = linked to a group_members row. Permanent players without
-- an app account can never vote, so counting them would make condition (b)
-- permanently unreachable the moment such a player is added.
--
-- What deliberately does NOT change:
--   * The free-seat gate still applies to BOTH paths, unchanged. A poll
--     whose table is already full never opens to guests, however fast the
--     regulars replied.
--   * The delay path is untouched, so polls where someone stays silent
--     behave exactly as before.
--   * Status handling is untouched: 'open' → 'expanded' (which fires the
--     notification trigger), 'confirmed' keeps its status and only gets the
--     timestamp (migration 086).
--
-- Note the interaction with `maybe_hold_hours`: a permanent 'maybe' still
-- holds its seat, and that hold is still subtracted from the free-seat
-- count. So "everyone answered, but they all answered 'maybe'" does NOT
-- open the poll — there are no genuinely free seats to offer yet.

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
       --     the instant the poll opens — those groups keep the old clock.
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
