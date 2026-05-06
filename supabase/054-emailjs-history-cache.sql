-- Migration 054: Local cache of EmailJS /history rows.
--
-- Why this exists:
--   EmailJS Free tier retains only the last 7 days of history in their
--   /history API. That's not enough for a monthly view. But each row has a
--   unique EmailJS-generated ID, so if we sync the API often enough (more
--   than once every 7 days), we can dedupe-cache every row locally and
--   reconstruct the full month — using EmailJS's own data as the source
--   of truth, not our self-log.
--
--   This complements (does NOT replace) `email_usage_log`:
--     * `email_usage_log` (migration 052) — what WE sent through our
--       /api/send-email Edge Function. Has rich attribution: group_id,
--       semantic kind ('settlement', 'reminder', etc.). Used for the
--       per-kind breakdown.
--     * `emailjs_history_cache` (this migration) — what EMAILJS confirms.
--       Has the unique row id and authoritative timestamps. Used for the
--       monthly quota bar and the cross-check signal.
--
-- Privacy:
--   `recipient_masked` follows the same scheme as `email_usage_log` —
--   "li***@g***.com". We never store full addresses. RLS limits SELECT
--   to super-admins only; the upsert RPC is also super-admin-gated.

create table if not exists public.emailjs_history_cache (
  -- EmailJS-generated id, e.g. "email_0537496c6cf98417e10eb2d8". This
  -- is the primary key — every upsert dedupes against it, so no matter
  -- how many times we sync the same 7-day window, we never count a row
  -- twice.
  id text primary key,
  created_at timestamptz not null,
  -- 1 = success, 2 = error (per EmailJS docs). Anything else stays as
  -- the raw int so future EmailJS additions don't silently break us.
  result int not null,
  template_id text,
  recipient_masked text,
  -- Best-effort kind inference from template_id (broadcast vs settlement
  -- template). Null when template_id is unrecognized — falls back to
  -- "broadcast" in the UI.
  kind_inferred text,
  -- When we last touched this row via upsert. Useful for spotting
  -- records that haven't been refreshed (e.g. if EmailJS purged them
  -- from their side after the 7-day retention window).
  last_synced_at timestamptz not null default now()
);

create index if not exists emailjs_history_cache_created_at_idx
  on public.emailjs_history_cache (created_at desc);

alter table public.emailjs_history_cache enable row level security;

drop policy if exists emailjs_history_cache_super_admin_select on public.emailjs_history_cache;
create policy emailjs_history_cache_super_admin_select on public.emailjs_history_cache
  for select to authenticated
  using (exists (select 1 from public.super_admins sa where sa.user_id = auth.uid()));

-- ─── RPCs ───────────────────────────────────────────────────────────────

-- upsert_emailjs_history: bulk-upsert a JSONB array of EmailJS rows.
-- Single round-trip even with hundreds of rows. SECURITY DEFINER so the
-- caller doesn't need INSERT/UPDATE privileges on the table directly.
create or replace function public.upsert_emailjs_history(rows jsonb)
returns int
language plpgsql security definer
set search_path = public
as $$
declare
  upserted_count int := 0;
begin
  if not exists (select 1 from public.super_admins where user_id = auth.uid()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  with parsed as (
    select
      (r->>'id')::text                       as id,
      (r->>'created_at')::timestamptz        as created_at,
      coalesce((r->>'result')::int, 0)       as result,
      (r->>'template_id')::text              as template_id,
      (r->>'recipient_masked')::text         as recipient_masked,
      (r->>'kind_inferred')::text            as kind_inferred
    from jsonb_array_elements(rows) r
    where r->>'id' is not null
      and r->>'created_at' is not null
  ),
  inserted as (
    insert into public.emailjs_history_cache (
      id, created_at, result, template_id, recipient_masked, kind_inferred, last_synced_at
    )
    select id, created_at, result, template_id, recipient_masked, kind_inferred, now()
      from parsed
    on conflict (id) do update set
      -- Only update mutable fields; the id and created_at are
      -- immutable from EmailJS's side. last_synced_at always bumps
      -- so we know the row was re-confirmed.
      result = excluded.result,
      template_id = coalesce(excluded.template_id, public.emailjs_history_cache.template_id),
      recipient_masked = coalesce(excluded.recipient_masked, public.emailjs_history_cache.recipient_masked),
      kind_inferred = coalesce(excluded.kind_inferred, public.emailjs_history_cache.kind_inferred),
      last_synced_at = now()
    returning 1
  )
  select count(*) into upserted_count from inserted;

  return upserted_count;
end;
$$;

revoke all on function public.upsert_emailjs_history(jsonb) from public;
grant execute on function public.upsert_emailjs_history(jsonb) to authenticated;

-- get_emailjs_monthly_summary: read-side aggregator for the Usage card.
-- Returns calendar-month counts (UTC) plus daily breakdown plus
-- last-synced-at, all from the local cache. Super-admin only.
create or replace function public.get_emailjs_monthly_summary(
  month_start timestamptz default date_trunc('month', now() at time zone 'utc'),
  month_end   timestamptz default (date_trunc('month', now() at time zone 'utc') + interval '1 month')
) returns jsonb
language plpgsql security definer stable
set search_path = public
as $$
declare
  result jsonb;
begin
  if not exists (select 1 from public.super_admins where user_id = auth.uid()) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'used', coalesce((select count(*) from public.emailjs_history_cache
                       where created_at >= month_start and created_at < month_end and result = 1), 0),
    'failed', coalesce((select count(*) from public.emailjs_history_cache
                         where created_at >= month_start and created_at < month_end and result = 2), 0),
    'oldest_cached_at', (select min(created_at) from public.emailjs_history_cache),
    'last_synced_at', (select max(last_synced_at) from public.emailjs_history_cache),
    'per_day', coalesce((select jsonb_agg(jsonb_build_object('date', d, 'count', c) order by d) from (
                            select date_trunc('day', created_at)::date d, count(*) c
                              from public.emailjs_history_cache
                             where created_at >= month_start and created_at < month_end and result = 1
                             group by 1 order by 1) k), '[]'::jsonb),
    'per_kind', coalesce((select jsonb_object_agg(kind, c) from (
                            select coalesce(kind_inferred, 'broadcast') kind, count(*) c
                              from public.emailjs_history_cache
                             where created_at >= month_start and created_at < month_end and result = 1
                             group by 1) k), '{}'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_emailjs_monthly_summary(timestamptz, timestamptz) from public;
grant execute on function public.get_emailjs_monthly_summary(timestamptz, timestamptz) to authenticated;
