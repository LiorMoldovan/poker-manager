-- 118 — Vote-change notifications become one durable per-user switch
--
-- Before: recipients were (admin OR super_admin OR per-poll subscriber)
-- AND group_members.schedule_vote_change_notifs. Two problems with that.
-- Admins were opted in automatically with no control on the poll card, and
-- a member's opt-in lived in game_poll_change_subscribers, keyed per poll,
-- so it evaporated with every new poll. Neither group had a switch that
-- meant what it said, which is how someone ended up subscribed to a push
-- for every RSVP without realising it.
--
-- After: recipients are exactly the members whose own flag is true. Role
-- stops mattering. game_poll_change_subscribers is left in place (it holds
-- history and dropping it would be irreversible) but is no longer read.
--
-- set_my_vote_change_notifs already gates on group membership only and
-- updates WHERE user_id = auth.uid(), so every member can already write
-- their own flag and nobody can write anyone else's. No new RPC needed.

-- ── 1. Recipient rule ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_poll_change_recipients(p_poll_id uuid)
RETURNS TABLE(player_name text, role text)
LANGUAGE plpgsql
STABLE
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

  IF NOT (
    EXISTS (SELECT 1 FROM group_members WHERE group_id = v_group_id AND user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM super_admins WHERE user_id = auth.uid())
  ) THEN
    RAISE EXCEPTION 'not_member';
  END IF;

  -- Role is returned for display only. It no longer participates in the
  -- decision: the sole gate is the member's own preference flag.
  RETURN QUERY
  SELECT DISTINCT
         p.name AS player_name,
         CASE
           WHEN gm.role = 'admin'      THEN 'admin'
           WHEN sa.user_id IS NOT NULL THEN 'super_admin'
           ELSE                             'subscriber'
         END AS role
    FROM group_members gm
    JOIN players p ON p.id = gm.player_id
    LEFT JOIN super_admins sa
           ON sa.user_id = gm.user_id
   WHERE gm.group_id = v_group_id
     AND gm.schedule_vote_change_notifs = TRUE;
END;
$function$;

-- ── 2. Backfill so the switchover changes nothing for anyone ───────────────
--
-- The column defaults to TRUE, so a flag-only rule would instantly start
-- pushing every RSVP to every member of every group. This sets the flag
-- false for exactly those who do NOT receive vote-change notifications
-- today: non-admins, non-super-admins, with no subscription on a live poll
-- in that same group.
--
-- Deliberately group-agnostic. Poker Night is not the only real group —
-- "פוקר חמישי או שבת" has four members who would otherwise be surprised.

UPDATE group_members gm
   SET schedule_vote_change_notifs = FALSE
 WHERE gm.schedule_vote_change_notifs IS DISTINCT FROM FALSE
   AND gm.role <> 'admin'
   AND NOT EXISTS (
     SELECT 1 FROM super_admins sa WHERE sa.user_id = gm.user_id
   )
   AND NOT EXISTS (
     SELECT 1
       FROM game_poll_change_subscribers s
       JOIN game_polls gp ON gp.id = s.poll_id
      WHERE s.user_id  = gm.user_id
        AND gp.group_id = gm.group_id
        AND gp.status IN ('open','expanded','confirmed')
   );

-- ── 3. Honour ליכטר's request to stop ──────────────────────────────────────
--
-- He is subscribed to the live poll, so the rule above preserves his opt-in
-- — but the subscription is precisely what he complained about. Turning it
-- off is what he actually asked for. The switch is his from here on.

UPDATE group_members gm
   SET schedule_vote_change_notifs = FALSE
  FROM players p
 WHERE p.id = gm.player_id
   AND p.name = 'ליכטר';
