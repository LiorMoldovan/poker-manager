-- Migration 052: Email usage log + RPCs
--
-- Why this exists:
--   EmailJS Free has no public usage API, so the only way to know how many
--   emails we've sent this month is to count what we sent ourselves. Every
--   successful (or failed) call from `api/send-email.ts` writes a row here,
--   and `get_email_usage_summary` aggregates them for the super-admin
--   "EmailJS Usage" card in Settings → AI.
--
-- Privacy:
--   `recipient_masked` is "li***@g***.com" style — we never store full
--   addresses. The audit log is super-admin-only so it can't leak
--   participation data across groups either.
--
-- Auth model:
--   * Inserts go through `log_email_send` (SECURITY DEFINER, granted to
--     authenticated). This avoids any need for the SUPABASE_SERVICE_ROLE_KEY
--     env in the Edge Function — we forward the calling user's JWT.
--   * Reads happen via `get_email_usage_summary` (SECURITY DEFINER, internal
--     super-admin gate). Direct SELECT on the table is also super-admin only
--     via the RLS policy below, but the RPC is the canonical entry point.

create table if not exists public.email_usage_log (
  id uuid primary key default gen_random_uuid(),
  sent_at timestamptz not null default now(),
  group_id uuid references public.groups(id) on delete set null,
  recipient_masked text not null,
  kind text not null,
  subject text,
  success boolean not null,
  http_status int,
  error_message text,
  template_id text
);

create index if not exists email_usage_log_sent_at_idx on public.email_usage_log (sent_at desc);
create index if not exists email_usage_log_group_idx   on public.email_usage_log (group_id, sent_at desc);

alter table public.email_usage_log enable row level security;

drop policy if exists email_usage_log_super_admin_select on public.email_usage_log;
create policy email_usage_log_super_admin_select on public.email_usage_log
  for select to authenticated
  using (exists (select 1 from public.super_admins sa where sa.user_id = auth.uid()));

-- ─── RPCs ───────────────────────────────────────────────────────────────

-- log_email_send: sole insert path. SECURITY DEFINER so authenticated callers
-- can write through it without needing INSERT permission on the table itself.
create or replace function public.log_email_send(
  p_group_id uuid,
  p_recipient_masked text,
  p_kind text,
  p_subject text,
  p_success boolean,
  p_http_status int,
  p_error_message text default null,
  p_template_id text default null
) returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'unauthenticated' using errcode = '42501';
  end if;
  insert into public.email_usage_log (
    group_id, recipient_masked, kind, subject, success, http_status, error_message, template_id
  ) values (
    p_group_id, p_recipient_masked, p_kind, p_subject, p_success, p_http_status, p_error_message, p_template_id
  );
end;
$$;

revoke all on function public.log_email_send(uuid, text, text, text, boolean, int, text, text) from public;
grant execute on function public.log_email_send(uuid, text, text, text, boolean, int, text, text) to authenticated;

-- get_email_usage_summary: aggregate readback for the Usage card. Super
-- admin only — non-super-admins get a 'forbidden' error.
--
-- Returns a single jsonb with:
--   used     int        # successful sends in window
--   failed   int        # failed sends in window
--   per_kind jsonb      # { "settlement": 12, "schedule_invitation": 4, ... }
--   per_day  jsonb[]    # [{ "date": "2026-05-01", "count": 7 }, ...]
--   recent   jsonb[]    # last 20 sends, newest first
create or replace function public.get_email_usage_summary(
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
    'used', coalesce((select count(*) from public.email_usage_log
                       where sent_at >= month_start and sent_at < month_end and success), 0),
    'failed', coalesce((select count(*) from public.email_usage_log
                         where sent_at >= month_start and sent_at < month_end and not success), 0),
    'per_kind', coalesce((select jsonb_object_agg(kind, c) from (
                            select kind, count(*) c
                              from public.email_usage_log
                             where sent_at >= month_start and sent_at < month_end and success
                             group by kind) k), '{}'::jsonb),
    'per_day', coalesce((select jsonb_agg(jsonb_build_object('date', d, 'count', c) order by d) from (
                            select date_trunc('day', sent_at)::date d, count(*) c
                              from public.email_usage_log
                             where sent_at >= month_start and sent_at < month_end and success
                             group by 1 order by 1) k), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(jsonb_build_object(
                            'sent_at', sent_at,
                            'recipient', recipient_masked,
                            'kind', kind,
                            'subject', subject,
                            'success', success,
                            'http_status', http_status,
                            'group_id', group_id
                         ) order by sent_at desc) from (
                            select * from public.email_usage_log
                             order by sent_at desc limit 20) r), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_email_usage_summary(timestamptz, timestamptz) from public;
grant execute on function public.get_email_usage_summary(timestamptz, timestamptz) to authenticated;
