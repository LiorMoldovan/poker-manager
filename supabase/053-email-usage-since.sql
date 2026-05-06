-- Migration 053: Email usage summary - add `oldest_logged_at` field.
--
-- Why this exists:
--   The Settings → AI "EmailJS Usage" card was showing "0 / 200" with no
--   indication that the log table has a finite history. Anyone who knows
--   they sent emails before logging started would (rightly) suspect the
--   number is fake. This migration extends `get_email_usage_summary` so
--   the UI can render an honest "Logging started: <date>" line — making
--   it obvious that historical sends aren't counted, and the canonical
--   source of truth is the EmailJS dashboard itself.
--
-- Backwards-compat:
--   Adds one new top-level field (`oldest_logged_at`) — older clients
--   ignore unknown fields, so this is safe to deploy before the UI ships.

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
    -- Overall oldest row (across all months) so the UI can render
    -- "Logging started: <date>" — null when the log is empty.
    'oldest_logged_at', (select min(sent_at) from public.email_usage_log),
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
