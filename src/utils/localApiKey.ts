import { getGroupId } from '../database/supabaseCache';

// ──────────────────────────────────────────────────────────────────────
// Device-local personal Gemini API key.
//
// The app's normal key model is PER-GROUP: a single `gemini_api_key` lives
// in the group's `settings` row, is owner-managed, and is synced to every
// member via Realtime. Putting a personal key there would replace the
// group key for everyone and bill the wrong account — a real conflict.
//
// This module is the conflict-free escape hatch: a key that lives ONLY in
// this browser's localStorage and is NEVER written to Supabase. A non-owner
// admin (e.g. an admin who wants AI to run on their own quota without
// touching the group key) can paste their key here and it takes priority
// over the group key — but only on their device.
//
// Resolution priority everywhere keys are read:
//   personal-local key → group settings key → platform env fallback
//
// Each AI request carries exactly ONE key, so this is a priority chain,
// not two keys competing. Scoped per group id so a personal key set while
// in one group never leaks into another group the user also belongs to.
// ──────────────────────────────────────────────────────────────────────

const PREFIX = 'poker_local_gemini_key_';

function storageKeyFor(groupId: string | null): string | null {
  return groupId ? `${PREFIX}${groupId}` : null;
}

export function getLocalGeminiKey(): string | undefined {
  try {
    const sk = storageKeyFor(getGroupId());
    if (!sk) return undefined;
    const v = localStorage.getItem(sk);
    return v && v.trim() ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function hasLocalGeminiKey(): boolean {
  return !!getLocalGeminiKey();
}

// Persists (or, when given an empty string, clears) the personal key for
// the CURRENT group on this device. No-ops silently if storage is
// unavailable or no group is loaded yet.
export function saveLocalGeminiKey(value: string): void {
  try {
    const sk = storageKeyFor(getGroupId());
    if (!sk) return;
    const trimmed = value.trim();
    if (trimmed) localStorage.setItem(sk, trimmed);
    else localStorage.removeItem(sk);
  } catch {
    /* storage unavailable — nothing to persist */
  }
}

export function clearLocalGeminiKey(): void {
  try {
    const sk = storageKeyFor(getGroupId());
    if (sk) localStorage.removeItem(sk);
  } catch {
    /* storage unavailable */
  }
}
