-- Migration 141: Add last_active_at to group_members and track user active group
--
-- Why:
--   Users with multiple group memberships (e.g. testing new groups) should
--   automatically return to the last group they were active in, rather than
--   being arbitrarily pinned to whichever group they joined first chronologically.
--   Specifically sets Yuval and existing Poker Night members to have Poker Night
--   as their latest active group so their next app visit opens the main group.

-- 1. Add column to group_members
alter table public.group_members
  add column if not exists last_active_at timestamptz not null default now();

-- 2. Initialize last_active_at to joined_at for existing rows
update public.group_members
set last_active_at = joined_at;

-- 3. Prioritize main group (Poker Night) for existing members so they land on Poker Night
update public.group_members
set last_active_at = now()
where group_id = 'd1998bed-7bae-4221-8877-20c537acfc43';

-- 4. Create touch_group_active RPC for authenticated users
create or replace function public.touch_group_active(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.group_members
  set last_active_at = now()
  where user_id = auth.uid()
    and group_id = p_group_id;
end;
$$;

revoke all on function public.touch_group_active(uuid) from public;
grant execute on function public.touch_group_active(uuid) to authenticated;
