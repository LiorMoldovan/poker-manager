-- Migration 140: Scope email usage summary to specific group when provided
--
-- Why:
--   Super admins inspecting a group created by another player (e.g. observer
--   mode) saw the deployment owner group's private email log in Settings -> AI.
--   This adds an optional `p_group_id uuid default null` parameter so reads
--   can be strictly isolated to the active group, while preserving backwards
--   compatibility when p_group_id is omitted or null.

drop function if exists public.get_email_usage_summary(timestamptz, timestamptz);

create or replace function public.get_email_usage_summary(
  month_start timestamptz default date_trunc('month', now() at time zone 'utc'),
  month_end   timestamptz default (date_trunc('month', now() at time zone 'utc') + interval '1 month'),
  p_group_id  uuid default null
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
                       where sent_at >= month_start and sent_at < month_end and success
                         and (p_group_id is null or group_id = p_group_id)), 0),
    'failed', coalesce((select count(*) from public.email_usage_log
                         where sent_at >= month_start and sent_at < month_end and not success
                           and (p_group_id is null or group_id = p_group_id)), 0),
    -- Oldest row for this group so the UI can render "Logging started: <date>"
    'oldest_logged_at', (select min(sent_at) from public.email_usage_log
                          where (p_group_id is null or group_id = p_group_id)),
    'per_kind', coalesce((select jsonb_object_agg(kind, c) from (
                            select kind, count(*) c
                              from public.email_usage_log
                             where sent_at >= month_start and sent_at < month_end and success
                               and (p_group_id is null or group_id = p_group_id)
                             group by kind) k), '{}'::jsonb),
    'per_day', coalesce((select jsonb_agg(jsonb_build_object('date', d, 'count', c) order by d) from (
                            select date_trunc('day', sent_at)::date d, count(*) c
                              from public.email_usage_log
                             where sent_at >= month_start and sent_at < month_end and success
                               and (p_group_id is null or group_id = p_group_id)
                             group by 1 order by 1) k), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(jsonb_build_object(
                            'sent_at', sent_at,
                            'recipient', recipient_masked,
                            'recipient_player_name', recipient_player_name,
                            'kind', kind,
                            'subject', subject,
                            'body', email_body,
                            'success', success,
                            'http_status', http_status,
                            'group_id', group_id
                         ) order by sent_at desc) from (
                            select * from public.email_usage_log
                             where (p_group_id is null or group_id = p_group_id)
                             order by sent_at desc limit 20) r), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

revoke all on function public.get_email_usage_summary(timestamptz, timestamptz, uuid) from public;
grant execute on function public.get_email_usage_summary(timestamptz, timestamptz, uuid) to authenticated;
