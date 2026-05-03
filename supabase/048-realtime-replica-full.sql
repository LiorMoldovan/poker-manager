-- 048: Make Realtime DELETE events actually reach clients
--
-- Why this exists:
--   When migration 046 deleted the duplicate `ספי טורס` players row, the
--   user's Settings tab kept rendering it from their in-memory cache. The
--   merge SQL was correct, the cache was just never told. Root cause is a
--   project-wide latent issue:
--
--   Supabase Realtime forwards postgres_changes events to a client only
--   after evaluating the table's RLS policy against the row payload. For
--   INSERT and UPDATE the NEW row is fully populated, so RLS works as
--   expected. For DELETE the only payload is the OLD row, and with
--   `REPLICA IDENTITY DEFAULT` the OLD row contains ONLY the primary key
--   columns — every other column is NULL.
--
--   All our group-scoped RLS predicates look like:
--     group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid())
--   Against a row whose `group_id` is NULL this evaluates to NULL → treated
--   as false → the DELETE event is silently dropped. The client's cache is
--   never invalidated, so the deleted row stays visible until something
--   else (an UPDATE on the same table, a logout, a manual refresh) forces
--   a re-fetch.
--
--   This bug has been latent since `003-realtime.sql` first enabled
--   Realtime. Most user-visible writes are upserts (which propagate fine),
--   so this only surfaced now that we did a legitimate single-row DELETE
--   via migration 046. It would also bite any future `deletePlayer` /
--   `deleteGame` / `removeSharedExpense` / `unlink_member_player` etc. on
--   any other connected client in the same group.
--
-- Fix:
--   Set `REPLICA IDENTITY FULL` on every realtime-subscribed table. With
--   FULL, the entire OLD row is shipped in the WAL DELETE record, RLS
--   evaluates against the real `group_id` (and any other column the policy
--   touches), and the DELETE event reaches every authorised client.
--
-- Trade-offs:
--   * WAL volume per UPDATE/DELETE grows by roughly the size of one row
--     (sends old + new instead of new + PK). For a poker app the volume
--     is tiny — tens of MB / year of extra WAL across all these tables
--     combined.
--   * No security implications: the OLD row payload is gated by the same
--     SELECT policy that already governs reads on the table.
--   * No performance implications: row matching for replication still
--     uses the PK index — FULL only changes what's *shipped*, not how the
--     row is *located*.
--
-- The tables in scope are exactly those subscribed by `subscribeToRealtime`
-- in `src/database/supabaseCache.ts` (the `TABLE_TO_GROUP` map) plus the
-- training tables added by `015-training-realtime.sql` and the schedule
-- tables added by `022-game-scheduling.sql`.

do $$
declare
  tbl text;
  realtime_tables text[] := array[
    'players',
    'games',
    'game_players',
    'shared_expenses',
    'game_forecasts',
    'paid_settlements',
    'period_markers',
    'settings',
    'chip_values',
    'pending_forecasts',
    'chronicle_profiles',
    'graph_insights',
    'tts_pools',
    'group_members',
    'groups',
    'notifications',
    'player_traits',
    'training_answers',
    'training_pool',
    'training_insights',
    'game_polls',
    'game_poll_dates',
    'game_poll_votes'
  ];
begin
  foreach tbl in array realtime_tables loop
    -- Skip tables that don't exist (defensive — covers hypothetical
    -- migrations that drop a table; keeps this idempotent)
    if not exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = tbl
    ) then
      raise notice 'skipping % (table does not exist)', tbl;
      continue;
    end if;

    execute format('alter table public.%I replica identity full', tbl);
    raise notice 'set replica identity full on %', tbl;
  end loop;
end $$;

-- ── Recovery kick: force a refresh on the user's currently-open Settings tab ──
-- The stale `ספי טורס` row is sitting in their in-memory cache because the
-- DELETE from migration 046 never made it to their client. With REPLICA
-- IDENTITY FULL now in place, the next change event will propagate cleanly,
-- and any UPDATE on `players` triggers `scheduleRealtimeRefresh('players')`
-- which fully reloads the players cache from Supabase (dropping the stale
-- row in the process). A no-op self-update is the cheapest way to fire that
-- event without touching real data.
update public.players
set name = name
where id = 'ec7b803e-8a75-4833-88c6-2595f5689487';

-- Verify
do $$
declare
  v_default_left int;
begin
  select count(*) into v_default_left
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relreplident = 'd'
    and c.relname = any(array[
      'players','games','game_players','shared_expenses','game_forecasts',
      'paid_settlements','period_markers','settings','chip_values',
      'pending_forecasts','chronicle_profiles','graph_insights','tts_pools',
      'group_members','groups','notifications','player_traits',
      'training_answers','training_pool','training_insights',
      'game_polls','game_poll_dates','game_poll_votes'
    ]);

  if v_default_left <> 0 then
    raise warning '% realtime tables still have REPLICA IDENTITY DEFAULT', v_default_left;
  else
    raise notice 'all realtime tables are now REPLICA IDENTITY FULL';
  end if;
end $$;
