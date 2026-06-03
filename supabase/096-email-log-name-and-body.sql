-- Migration 096: Email usage log — store recipient player name + email body
--
-- Why this exists:
--   The super-admin "Recent sends" audit card (Settings → Services) showed
--   only a MASKED recipient (se***@g***.com) and the subject. The operator
--   asked to see WHO each email went to (player name) and WHAT they received
--   (the email body), with the body revealed on click.
--
-- Privacy note (intentional widening of migration 052's stance):
--   052 deliberately stored "masked recipient + subject only". This adds two
--   nullable columns:
--     * recipient_player_name — the player the email was addressed to.
--     * email_body            — the body text we sent.
--   The log stays SUPER-ADMIN-ONLY (RLS from 052 unchanged). Full email
--   ADDRESSES are still never stored — only the player name + body.
--   Settlement emails store NO body: EmailJS renders that server-side from a
--   template, so the literal text never reaches our Edge Function. Only
--   message-based emails (schedule/poll notifications + broadcasts) carry a
--   body, and that is what gets stored.
--
-- Backfill:
--   None possible — this data was never captured. Existing rows keep NULL for
--   both columns; the UI falls back to the masked recipient and shows no body.

-- ── 1. Columns ────────────────────────────────────────────────────────────
alter table public.email_usage_log
  add column if not exists recipient_player_name text,
  add column if not exists email_body text;

-- ── 2. log_email_send: accept the two new fields ──────────────────────────
-- The signature gains two trailing DEFAULT NULL params. Because adding
-- params changes the function signature, CREATE OR REPLACE alone would leave
-- the old 8-arg function in place and create an ambiguous overload — so we
-- drop the previous signature first and recreate as a strict superset. All
-- existing callers (which pass the original 8 named args) still resolve via
-- the defaults. Grants are re-applied below since DROP discards them.
drop function if exists public.log_email_send(uuid, text, text, text, boolean, integer, text, text);

create or replace function public.log_email_send(
  p_group_id uuid,
  p_recipient_masked text,
  p_kind text,
  p_subject text,
  p_success boolean,
  p_http_status int,
  p_error_message text default null,
  p_template_id text default null,
  p_recipient_player_name text default null,
  p_email_body text default null
) returns void
language plpgsql security definer
set search_path = public
as $$
begin
  -- No auth.uid() guard: migration 079 dropped it so service-role worker
  -- dispatches (notification-worker → send-email) still log correctly.
  insert into public.email_usage_log (
    group_id, recipient_masked, kind, subject, success, http_status,
    error_message, template_id, recipient_player_name, email_body
  ) values (
    p_group_id, p_recipient_masked, p_kind, p_subject, p_success, p_http_status,
    p_error_message, p_template_id, p_recipient_player_name, p_email_body
  );
end;
$$;

revoke all on function public.log_email_send(uuid, text, text, text, boolean, int, text, text, text, text) from public;
grant execute on function public.log_email_send(uuid, text, text, text, boolean, int, text, text, text, text) to authenticated;

-- ── 3. get_email_usage_summary: return the two new fields in `recent` ─────
-- Signature unchanged (CREATE OR REPLACE keeps the existing grants). Only the
-- `recent` array gains `recipient_player_name` and `body`.
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
                            'recipient_player_name', recipient_player_name,
                            'kind', kind,
                            'subject', subject,
                            'body', email_body,
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
