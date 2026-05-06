-- Migration 056: System-level configuration store.
--
-- Why this exists:
--   The EmailJS quota system was originally designed around four Vercel
--   env vars (EMAILJS_QUOTA_RESET_DAY, EMAILJS_MONTHLY_CAP,
--   EMAILJS_BASELINE_USED, EMAILJS_BASELINE_AT,
--   EMAILJS_BASELINE_CYCLE_START). That works in production but has
--   four problems:
--     1. It doesn't work on localhost — browser-side fallback can't
--        read Vercel env vars, so the dev experience is permanently
--        wrong.
--     2. Updating the baseline mid-cycle requires a Vercel redeploy.
--     3. Operator must learn the var names and ISO date formats.
--     4. The same numbers (cap, reset day) duplicate between Vercel
--        config and the EmailJS dashboard, creating drift risk.
--
--   This `system_config` table replaces those env vars with a single
--   key/value store the super-admin can edit from the UI. The keys
--   used for the EmailJS quota system are:
--     'emailjs_baseline'        → { used, taken_at, cycle_start }
--     'emailjs_monthly_cap'     → number
--     'emailjs_quota_reset_day' → number (1..31)
--
--   Existing env vars stay supported as fallback for environments
--   where the table hasn't been seeded yet (the migration is
--   non-blocking).
--
-- Schema:
--   key:    text PK so reads are point lookups, never table scans.
--   value:  jsonb so we can store scalars, dates, or compound objects
--           uniformly. The reader code shapes them per-key.
--
-- Privacy / RLS:
--   Both read and write are super-admin only. The super-admin role is
--   already platform-wide (no group scoping), which fits a system-
--   level config store.

create table if not exists public.system_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

alter table public.system_config enable row level security;

drop policy if exists system_config_super_admin_select on public.system_config;
create policy system_config_super_admin_select on public.system_config
  for select to authenticated
  using (exists (select 1 from public.super_admins sa where sa.user_id = auth.uid()));

-- ─── RPC: get_system_config ───────────────────────────────────────────
-- Returns the value for a single key, or null if not set. SECURITY
-- DEFINER so the caller's JWT only needs to be authenticated; the
-- function gates super-admin internally so non-super callers don't
-- learn what keys exist.
create or replace function public.get_system_config(p_key text)
returns jsonb
language plpgsql security definer stable
set search_path = public
as $$
declare
  v jsonb;
begin
  if not exists (select 1 from public.super_admins where user_id = auth.uid()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select value into v from public.system_config where key = p_key;
  return v;
end;
$$;

revoke all on function public.get_system_config(text) from public;
grant execute on function public.get_system_config(text) to authenticated;

-- ─── RPC: set_system_config ───────────────────────────────────────────
-- Upsert helper. Returns the new value so the caller can refresh
-- their local view in one round-trip. Stamps updated_at + updated_by
-- on every write so we have a basic audit trail without needing a
-- separate history table — sufficient for the low-volume system
-- config use case.
create or replace function public.set_system_config(p_key text, p_value jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.super_admins where user_id = auth.uid()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into public.system_config (key, value, updated_by)
  values (p_key, p_value, auth.uid())
  on conflict (key) do update set
    value = excluded.value,
    updated_at = now(),
    updated_by = auth.uid();
  return p_value;
end;
$$;

revoke all on function public.set_system_config(text, jsonb) from public;
grant execute on function public.set_system_config(text, jsonb) to authenticated;
