-- Migration 056: Push-notify super-admins on training events.
--
-- Why this exists:
--   Two flows now need to ping super-admins by push:
--     1. A player taps the "report a question" flag during a quick-training
--        session. The reports are persisted with the session, but until
--        now super-admins only saw them by manually opening
--        Settings → Training. We want a quiet push so they can review
--        promptly.
--     2. A player crosses a 100-question milestone. Coaching insights
--        are auto-generated only when the group has a Gemini API key;
--        otherwise the player sees "תובנות יווצרו בקרוב" and a
--        super-admin needs to trigger the regen by hand. Even when
--        auto-gen runs, the super-admin may want to review the new
--        insights, so we always notify on the milestone.
--
-- This RPC returns the push-subscriber player names of all super-admins
-- that have a registered subscription in the given group. It is a
-- replica of the same function authored in migration 055 (email quota
-- alerts) — kept idempotent (CREATE OR REPLACE) so applying 055 and 056
-- in either order leaves an identical, working function.
--
-- Auth model:
--   SECURITY DEFINER — any authenticated client may call it. The result
--   set contains only player display names (already shared freely
--   across the group's UI), never user_ids or emails.

create or replace function public.get_super_admin_player_names_in_group(
  p_group_id uuid
) returns text[]
language plpgsql security definer stable
set search_path = public
as $$
declare
  names text[];
begin
  select coalesce(array_agg(distinct ps.player_name), array[]::text[])
    into names
    from public.super_admins sa
    join public.push_subscriptions ps
      on ps.user_id = sa.user_id and ps.group_id = p_group_id
   where ps.player_name is not null;
  return names;
end;
$$;

revoke all on function public.get_super_admin_player_names_in_group(uuid) from public;
grant execute on function public.get_super_admin_player_names_in_group(uuid) to authenticated;

-- ============================================================
-- DONE — Verify with:
--   SELECT get_super_admin_player_names_in_group('<group-id>'::uuid);
-- ============================================================
