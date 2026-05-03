-- 046: Merge duplicate player records for Sefi (group d1998bed)
--
-- Why this exists:
--   The PlayerPicker self-create flow (src/App.tsx) only ever showed a name
--   input — it never listed existing unlinked players to pick from, despite
--   the group-management cursor rule stating it should. So when Sefi joined
--   the app on 2026-05-01, instead of linking his account to the existing
--   `ספי` player record (created by an admin in Dec 2025, with 5 completed
--   games of history), he typed his full name `ספי טורס` and `self_create_and_link`
--   minted a brand-new duplicate player. Result: his account is linked to an
--   empty record, while all 5 games of history sit under an unlinked record.
--   Net effect users see: Settings shows `ספי טורס` (the linked dup),
--   Statistics shows `ספי` (the historical record with games).
--
--   Per user decision, we keep the canonical name `ספי` (the historical one
--   with 5 games attached) and re-link Sefi's account to it.
--
-- Inventory before:
--   players ec7b803e... `ספי`        (Dec 2025) — 5 game_players, 1 forecast,
--                                                  1 unused player_invite
--   players a7132445... `ספי טורס`   (May 2026) — 0 games, 1 group_members
--                                                  link (user c33d8d56...
--                                                  sefitores), 1 game_poll_vote
--
-- What this migration does:
--   1. Move `group_members.player_id` from a71324... → ec7b80... (re-link
--      Sefi's user to the historical record).
--   2. Move any rows in `game_poll_votes`, `player_invites`, `player_traits`
--      from a71324... → ec7b80... (defensive — at time of writing only the
--      vote exists, but rerunning this migration after future activity should
--      still consolidate cleanly).
--   3. Delete the duplicate `ספי טורס` player record.
--
-- Idempotency:
--   All UPDATE statements are no-ops if no rows match. The DELETE has explicit
--   FK guards. Safe to re-run; second run is a no-op.
--
-- Constraints sanity check:
--   * idx_gm_unique_player UNIQUE(group_id, player_id) WHERE player_id IS NOT NULL:
--     ec7b80... has 0 group_member links pre-migration → no conflict on move.
--   * game_poll_votes_date_id_player_id_key UNIQUE(date_id, player_id):
--     ec7b80... has 0 votes pre-migration → no conflict on move.
--   * players_group_id_name_key UNIQUE(group_id, name):
--     no rename — `ספי` stays — no conflict.
--
-- Safety:
--   The single-row direct DELETE WHERE id = $const passes the
--   `block_bulk_deletes` trigger from migration 043 (single-row).

begin;

-- ── 1. Re-link Sefi's user ─────────────────────────────────────────────────
update group_members
set player_id = 'ec7b803e-8a75-4833-88c6-2595f5689487'  -- ספי (historical)
where group_id = 'd1998bed-7bae-4221-8877-20c537acfc43'
  and player_id = 'a7132445-5007-48ca-9c1b-5e81894ec3b6';  -- ספי טורס (dup)

-- ── 2. Move any other refs to the duplicate to the historical record ──────
update game_poll_votes
set player_id = 'ec7b803e-8a75-4833-88c6-2595f5689487'
where player_id = 'a7132445-5007-48ca-9c1b-5e81894ec3b6';

update player_invites
set player_id = 'ec7b803e-8a75-4833-88c6-2595f5689487'
where player_id = 'a7132445-5007-48ca-9c1b-5e81894ec3b6';

update player_traits
set player_id = 'ec7b803e-8a75-4833-88c6-2595f5689487'
where player_id = 'a7132445-5007-48ca-9c1b-5e81894ec3b6';

-- game_players is empty for the dup at time of writing; this UPDATE is a
-- no-op now, but if a stray row appeared (e.g. a half-completed game on the
-- new id) we'd want to consolidate it under the historical id rather than
-- orphan it. UPDATE is safe because UNIQUE(game_id, player_id) on the old id
-- only matches if the same human somehow ended up under both ids in the same
-- game, which is impossible by app flow.
update game_players
set player_id = 'ec7b803e-8a75-4833-88c6-2595f5689487'
where player_id = 'a7132445-5007-48ca-9c1b-5e81894ec3b6'
  and not exists (
    select 1 from game_players old
    where old.player_id = 'ec7b803e-8a75-4833-88c6-2595f5689487'
      and old.game_id = game_players.game_id
  );

-- ── 3. Delete the duplicate player record ─────────────────────────────────
-- Single-row delete (passes block_bulk_deletes trigger from migration 043).
-- Guarded with NOT EXISTS for every reference table — if any row still points
-- to the dup, the delete becomes a no-op so we never orphan FK refs.
delete from players
where id = 'a7132445-5007-48ca-9c1b-5e81894ec3b6'
  and not exists (select 1 from game_players   where player_id = 'a7132445-5007-48ca-9c1b-5e81894ec3b6')
  and not exists (select 1 from group_members  where player_id = 'a7132445-5007-48ca-9c1b-5e81894ec3b6')
  and not exists (select 1 from game_poll_votes where player_id = 'a7132445-5007-48ca-9c1b-5e81894ec3b6')
  and not exists (select 1 from player_invites where player_id = 'a7132445-5007-48ca-9c1b-5e81894ec3b6')
  and not exists (select 1 from player_traits  where player_id = 'a7132445-5007-48ca-9c1b-5e81894ec3b6');

-- ── 4. Verify final state ─────────────────────────────────────────────────
do $$
declare
  v_old_games int;
  v_old_link  int;
  v_dup_left  int;
begin
  select count(*) into v_old_games from game_players
    where player_id = 'ec7b803e-8a75-4833-88c6-2595f5689487';
  select count(*) into v_old_link  from group_members
    where player_id = 'ec7b803e-8a75-4833-88c6-2595f5689487';
  select count(*) into v_dup_left  from players
    where id = 'a7132445-5007-48ca-9c1b-5e81894ec3b6';

  raise notice 'Post-merge: ספי (ec7b80…) games=%, user-links=%, dup-rows-left=%',
    v_old_games, v_old_link, v_dup_left;

  if v_old_link <> 1 then
    raise warning 'Expected exactly 1 user link on the historical ספי record, got %', v_old_link;
  end if;
  if v_dup_left <> 0 then
    raise warning 'Duplicate ספי טורס record (a71324…) was not deleted — investigate FK refs';
  end if;
end $$;

commit;
