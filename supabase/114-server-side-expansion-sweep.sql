-- 114 — server-side fallback for poll expansion
--
-- PROBLEM
-- expand_game_poll only ever ran from runSchedulerSweep in the browser. If no
-- member opened the app after a poll qualified, guests stayed locked out
-- indefinitely — the 24h promise in the UI was really "24h, plus however long
-- until somebody happens to open the app". Every other scheduled behaviour
-- (auto-create, notification dispatch) already runs under pg_cron; expansion
-- was the odd one out.
--
-- SHAPE
-- The expansion predicate is subtle and has already drifted once (migration 112
-- fixed a seat check that ignored the picked date). Copying it into a sweep
-- would guarantee a repeat, so it moves into fn_expand_poll_internal and both
-- callers delegate:
--
--   expand_game_poll      -> membership check, then internal   (client sweep)
--   fn_sweep_expand_polls -> quiet-hours check, then internal  (pg_cron)
--
-- fn_expand_poll_internal deliberately has NO auth check: it is not granted to
-- api roles and is only reachable through the two wrappers above.
--
-- QUIET HOURS
-- Expansion enqueues an 'expanded' push (migration 113). Until now it could only
-- fire while somebody had the app open, which kept it in waking hours by
-- accident. A 24/7 sweep would remove that accident and start waking the group
-- at 3am, so the sweep only runs 08:00-23:00 Asia/Jerusalem — same timezone the
-- auto-create sweep uses. A poll that qualifies overnight opens at 08:00.

CREATE OR REPLACE FUNCTION public.fn_expand_poll_internal(p_poll_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE game_polls gp
     SET expanded_at = now(),
         status = CASE WHEN status = 'open' THEN 'expanded' ELSE status END
   WHERE gp.id = p_poll_id
     AND gp.expanded_at IS NULL
     AND gp.status IN ('open', 'confirmed')
     AND (
       -- (a) the original clock
       now() - gp.created_at >= make_interval(hours => gp.expansion_delay_hours)
       -- (b) every registered permanent has engaged with this poll. Guarded by
       --     "at least one exists" so a group with no permanent players doesn't
       --     satisfy the NOT EXISTS vacuously and expand the instant it opens.
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

REVOKE ALL ON FUNCTION public.fn_expand_poll_internal(uuid) FROM PUBLIC, anon, authenticated;

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

  PERFORM fn_expand_poll_internal(p_poll_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_sweep_expand_polls()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tz   CONSTANT text := 'Asia/Jerusalem';
  v_hour int;
  v_p    RECORD;
BEGIN
  v_hour := extract(hour from (now() AT TIME ZONE v_tz))::int;
  IF v_hour < 8 OR v_hour >= 23 THEN
    RETURN;
  END IF;

  -- Candidate set is deliberately loose: fn_expand_poll_internal re-checks
  -- every condition in its own WHERE clause, so this only needs to avoid
  -- scanning polls that can obviously never qualify.
  FOR v_p IN
    SELECT id FROM game_polls
     WHERE expanded_at IS NULL
       AND status IN ('open', 'confirmed')
       AND confirmed_game_id IS NULL
  LOOP
    PERFORM fn_expand_poll_internal(v_p.id);
  END LOOP;
END;
$function$;

SELECT cron.schedule(
  'expand-polls-sweep',
  '* * * * *',
  $$SELECT public.fn_sweep_expand_polls();$$
);
