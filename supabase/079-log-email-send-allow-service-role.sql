-- ============================================================================
-- supabase/079-log-email-send-allow-service-role.sql
--
-- Allow service_role callers to invoke log_email_send. The original
-- migration 052 added an `if auth.uid() is null then raise exception` guard
-- as redundant defence-in-depth on top of `grant execute … to authenticated`.
-- That guard was fine for the original world (every send originated from a
-- logged-in browser via apiProxy with a user JWT to forward) but broke
-- silently when v5.49.0 introduced the server-side notification dispatcher
-- (api/notification-worker.ts).
--
-- The worker has no user JWT — it authenticates to /api/send-email via
-- the X-Worker-Secret header, and the Edge Function forwards
-- `Bearer SUPABASE_SERVICE_ROLE_KEY` to the Supabase RPC. Service-role
-- calls have NO auth.uid() (it returns NULL), so the guard rejected every
-- worker-dispatched email with 42501. The try/catch in send-email.ts
-- swallowed the rejection silently — the email still went out via EmailJS,
-- the row never made it into `email_usage_log`.
--
-- Symptom: EmailJS dashboard quota usage diverges from the in-app Usage
-- card. As of 2026-05-15 the dashboard reads 195/200 while the card reads
-- 122/200 — a 73-email gap covering today's vote_change burst plus older
-- worker-dispatched reminders / cancellations / target_filled emails.
--
-- Fix shape: drop the `auth.uid() is null` short-circuit. The function
-- remains SECURITY DEFINER with `grant execute to authenticated`, so:
--   * `anon` callers are still rejected at the grant layer (no execute).
--   * Authenticated user callers behave identically (auth.uid() was
--     never read in the body, only checked for non-null).
--   * Service-role callers, which bypass grants by definition, now
--     complete successfully and produce the audit row we always meant
--     to write.
--
-- Attack-surface analysis: removing the guard does NOT broaden who can
-- write log rows. Anon already couldn't (no grant). Authenticated already
-- could (was just gated by "user JWT present"). Service-role already
-- could write anywhere in the DB — this just lets the audit-log path
-- specifically work for them. No new spam vector.
--
-- IDEMPOTENT: `create or replace` on the function.
-- ============================================================================

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
  -- NOTE: previously had `if auth.uid() is null then raise 42501`. Dropped
  -- 2026-05-15 (migration 079) because that guard silently rejected every
  -- service-role-authenticated worker dispatch from /api/notification-worker
  -- → /api/send-email, undercounting EmailJS usage by ~30%. See migration
  -- header for full context.
  insert into public.email_usage_log (
    group_id, recipient_masked, kind, subject, success, http_status, error_message, template_id
  ) values (
    p_group_id, p_recipient_masked, p_kind, p_subject, p_success, p_http_status, p_error_message, p_template_id
  );
end;
$$;

-- Re-assert the grants explicitly so the migration is self-contained.
-- service_role bypasses grants but `to service_role` is harmless and
-- makes the intent reviewable in a future audit.
revoke all on function public.log_email_send(uuid, text, text, text, boolean, int, text, text) from public;
grant execute on function public.log_email_send(uuid, text, text, text, boolean, int, text, text) to authenticated;
grant execute on function public.log_email_send(uuid, text, text, text, boolean, int, text, text) to service_role;

-- ============================================================================
-- DONE. Verify with a service-role insert:
--   select public.log_email_send(
--     '<owner_group_id>'::uuid, 'te***@e***.com', 'vote_change_test',
--     'verification', true, 200, null, 'template_test'
--   );
-- (run as service_role; clean up the test row afterwards.)
-- ============================================================================
