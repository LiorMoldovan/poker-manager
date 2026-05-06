import { getGroupId } from '../database/supabaseCache';

// Whether email sending is enabled for the current group.
//
// The deployment owner sets `VITE_OWNER_GROUP_ID` in Vercel — that group's UUID
// gets baked into the client bundle at build time, so the UI knows instantly
// (no extra round-trip) which group is allowed to send email.
//
// The group UUID isn't a secret — it already appears in invite URLs — so
// shipping it to the public bundle is fine.
//
// If the env wasn't set (e.g. dev/localhost without a build override), we
// return `true` to preserve the legacy "everyone can try" behavior. The
// server-side check in `api/send-email.ts` is the actual enforcement
// boundary; this helper is only the awareness layer.
export function isEmailEnabledForCurrentGroup(): boolean {
  const owner = (import.meta.env.VITE_OWNER_GROUP_ID as string | undefined)?.trim();
  if (!owner) return true;
  const current = getGroupId();
  if (!current) return true; // not yet loaded — don't pre-block
  return current === owner;
}

// Single-source dispatcher. Both the proxy (when it short-circuits client-side)
// and the proxy's 403 handler (defense-in-depth, when the env was misconfigured
// and the server pushed back) call into this. The toast listener in App.tsx
// dedups via sessionStorage, so calling this multiple times is safe.
export function notifyEmailDisabled(kind?: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('email-disabled-for-group', { detail: { kind } }));
}
