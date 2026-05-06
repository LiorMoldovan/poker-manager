-- Migration 055: Email-quota alert deduplication.
--
-- Why this exists:
--   When usage of the EmailJS monthly quota crosses a threshold (80%,
--   95%, 100%) we want a single push notification per threshold per
--   billing cycle — not one per send-after-the-line-was-crossed. This
--   table records "we already alerted threshold N for the cycle that
--   started on date D" so subsequent sends know to stay quiet.
--
-- Schema:
--   (cycle_start, threshold) is the natural unique key. We use it as
--   the PK so an INSERT ... ON CONFLICT DO NOTHING doubles as the
--   "first-time?" check inside the alert RPC.
--
-- Privacy:
--   No PII. Only the cycle date and the threshold integer.

create table if not exists public.email_quota_alerts (
  cycle_start date not null,
  threshold int not null check (threshold > 0 and threshold <= 100),
  alerted_at timestamptz not null default now(),
  primary key (cycle_start, threshold)
);

alter table public.email_quota_alerts enable row level security;

drop policy if exists email_quota_alerts_super_admin_select on public.email_quota_alerts;
create policy email_quota_alerts_super_admin_select on public.email_quota_alerts
  for select to authenticated
  using (exists (select 1 from public.super_admins sa where sa.user_id = auth.uid()));

-- ─── RPC: try_record_quota_alert ───────────────────────────────────────
-- Atomic "alert if new" primitive. INSERT ON CONFLICT DO NOTHING is
-- already idempotent at the storage layer; we wrap it so the caller
-- (api/send-email.ts) gets a clean boolean back without parsing
-- INSERT/RETURNING semantics over the REST API.
--
-- SECURITY DEFINER because the caller will be the JWT of whoever
-- triggered the email send (could be any group admin, not necessarily
-- super-admin). The function does NOT return any data — it only writes
-- a row scoped to a deduplication key, so leaking write capability is
-- harmless (other admins can't observe the rows due to the RLS policy
-- above).
create or replace function public.try_record_quota_alert(
  cycle_start_d date,
  threshold_v int
) returns boolean
language plpgsql security definer
set search_path = public
as $$
declare
  inserted boolean := false;
begin
  insert into public.email_quota_alerts (cycle_start, threshold)
  values (cycle_start_d, threshold_v)
  on conflict (cycle_start, threshold) do nothing;

  -- FOUND is set by the most recent INSERT — true when a row was
  -- newly inserted, false when ON CONFLICT swallowed it.
  inserted := FOUND;
  return inserted;
end;
$$;

revoke all on function public.try_record_quota_alert(date, int) from public;
grant execute on function public.try_record_quota_alert(date, int) to authenticated;

-- ─── RPC: get_super_admin_player_names_in_group ──────────────────────
-- Returns the player_name values of every super-admin who has at least
-- one active push subscription in the given group. Used by
-- api/send-email.ts to target the quota-warning push.
--
-- Why this query shape (vs. joining players/auth tables):
--   `push_subscriptions` already carries both `user_id` and
--   `player_name` per row, populated when the user installed the PWA
--   and registered for push. So we get the exact intersection of
--   "super-admin AND has push enabled in this group" in a single
--   join — no need to detour through `players`.
--
-- Auth model:
--   SECURITY DEFINER so the calling JWT only needs to be
--   authenticated — not super-admin itself. This is intentional:
--   we want the quota check to fire for any email send, regardless
--   of which admin triggered it. The function returns only player
--   display names (already shared freely across the group's UI),
--   never user_ids or emails.
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
