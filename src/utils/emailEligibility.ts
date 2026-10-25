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
export const DEFAULT_OWNER_GROUP_ID = 'd1998bed-7bae-4221-8877-20c537acfc43';

export function getOwnerGroupId(): string {
  const envOwner = (import.meta.env.VITE_OWNER_GROUP_ID as string | undefined)?.trim();
  return envOwner || DEFAULT_OWNER_GROUP_ID;
}

export function isEmailEnabledForCurrentGroup(): boolean {
  const current = getGroupId();
  if (!current) return false;
  return current === getOwnerGroupId();
}

// Single-source dispatcher. Both the proxy (when it short-circuits client-side)
// and the proxy's 403 handler (defense-in-depth, when the env was misconfigured
// and the server pushed back) call into this. The toast listener in App.tsx
// dedups via sessionStorage, so calling this multiple times is safe.
export function notifyEmailDisabled(kind?: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('email-disabled-for-group', { detail: { kind } }));
}
