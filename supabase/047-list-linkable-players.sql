-- 047: list_linkable_players RPC for PlayerPicker
--
-- Why this exists:
--   The PlayerPicker self-create flow in src/App.tsx is supposed to show the
--   joining user a list of EXISTING UNLINKED players in the group ("are you
--   one of these?") with a fallback "create new" path — see the
--   group-management cursor rule. In practice it only ever rendered the
--   name input, which is exactly why duplicate player records have been
--   accumulating: a new joiner with no awareness of existing-roster names
--   types in their preferred name and `self_create_and_link` mints a
--   duplicate, while their game history sits unreachable under the original
--   admin-created record.
--
--   The picker can't compute "unlinked players" client-side because the
--   `gm_select` RLS policy on `group_members` only returns the caller's own
--   row — they can't see other users' player_id values, so they can't tell
--   which players are already taken. This RPC closes that gap by running
--   under SECURITY DEFINER with a manual membership check.
--
-- Returns:
--   id, name for every player in p_group_id that has no group_member link.
--   Caller must be a member of p_group_id (verified inside the function).
--
-- Safety:
--   * SECURITY DEFINER + pinned search_path (matches the convention from 045)
--   * Membership check is mandatory — without it, any authenticated user
--     could enumerate any group's players.
--   * Only returns id + name — no created_at / type / gender (the picker
--     doesn't need them, and we don't want to leak more than necessary).

create or replace function public.list_linkable_players(p_group_id uuid default null)
returns table(id uuid, name text)
language sql
security definer
set search_path = public, pg_temp
as $$
  with caller_group as (
    select coalesce(
      p_group_id,
      (
        -- Default to the caller's first joined group when not specified.
        -- Multi-group users typically pass an explicit p_group_id, so this
        -- fallback is mostly for the single-group common case.
        select group_id
        from group_members
        where user_id = auth.uid()
        order by joined_at
        limit 1
      )
    ) as gid
  )
  select p.id, p.name
  from players p
  cross join caller_group cg
  where p.group_id = cg.gid
    -- Caller must actually be a member of that group.
    and exists (
      select 1 from group_members gm
      where gm.group_id = cg.gid and gm.user_id = auth.uid()
    )
    -- Only players that no group_member is currently linked to.
    and not exists (
      select 1 from group_members gm2
      where gm2.group_id = cg.gid and gm2.player_id = p.id
    )
  order by p.name;
$$;

revoke all on function public.list_linkable_players(uuid) from public;
grant execute on function public.list_linkable_players(uuid) to authenticated;

comment on function public.list_linkable_players(uuid) is
  'Returns (id, name) for every player in the given group that no group_member is linked to. Used by the PlayerPicker so a joining user can claim an existing player record instead of creating a duplicate. Caller must be a member of the group.';
