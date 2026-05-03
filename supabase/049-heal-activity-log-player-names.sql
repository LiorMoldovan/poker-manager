-- 049: Heal stale player_name stamps in activity_log
--
-- Why this exists:
--   activity_log stamps `player_name` at session start with whatever the
--   client passed for "who is this human" at that moment. That's the right
--   default — it captures attribution at the time of the session and gives
--   us a stable string even after a user leaves the group. But it has a
--   blind spot: if the human's *linked* player record gets renamed or
--   merged later (e.g. migration 046 collapsing `ספי טורס` into the
--   historical `ספי`), the historical activity_log rows still carry the
--   old name forever. The Activity tab reads the LATEST stamp per user
--   and renders that, so the tab keeps showing the pre-merge name until
--   the user opens the app again under the new linked name.
--
--   For Sefi specifically: 12 rows stamped `ספי טורס`, latest one ~05-03
--   09:26 (post-merge but before he opened the app again). Tab renders
--   `ספי טורס` despite the live link being to `ספי`.
--
-- What this migration does:
--   For every activity_log row where the user's *current* linked player
--   has a different name than the stamped player_name, overwrite the stamp
--   with the current linked name. Rows for users who later left the group
--   (no group_members row, or no linked player_id) are left alone — they're
--   genuine historical attribution we shouldn't rewrite. Same for rows
--   whose user_id is NULL (anonymous device-only sessions).
--
--   Idempotent. Re-running is a no-op once names are aligned. Safe to ship
--   alongside the code change in `v5.35.3` that derives names from a live
--   join going forward — the code change handles future drift, this
--   migration handles existing drift.
--
-- Verify count is reasonable before committing:
--   `with target as (...same FROM/WHERE as below...) select count(*) from target;`

do $$
declare
  v_updated int;
begin
  with target as (
    select al.id, p.name as live_name
    from activity_log al
    join group_members gm
      on gm.user_id = al.user_id
     and gm.group_id = al.group_id
    join players p
      on p.id = gm.player_id
    where al.user_id is not null
      and gm.player_id is not null
      and (al.player_name is distinct from p.name)
  ),
  upd as (
    update activity_log al
    set player_name = t.live_name
    from target t
    where al.id = t.id
    returning 1
  )
  select count(*) into v_updated from upd;

  raise notice 'activity_log rows updated to current linked player_name: %', v_updated;
end $$;

-- Verify Sefi specifically:
--   select player_name, count(*)
--   from activity_log
--   where user_id = 'c33d8d56-2159-47d3-b568-ff545bd743b1'
--   group by player_name;
-- Expected after this migration: ספי / 12.
