import { getGroupId } from '../database/supabaseCache';
import { getSettings } from '../database/storage';

// Whether the AI call path is available for the current group.
//
// Two layers of "yes":
//   1. The current group has its OWN per-group key in Settings → Services.
//      That key gets sent in the proxy request body and the server uses it
//      directly (no env-var fallback needed). Works for every group.
//   2. The current group IS the deployment owner's group (`VITE_OWNER_GROUP_ID`).
//      In that case the proxy can omit the key and the server falls back to
//      the platform `GEMINI_API_KEY` / `ELEVENLABS_API_KEY` env var. This
//      is the "platform owner uses platform key" path — explicitly NOT
//      available to other groups, otherwise their AI usage drains the
//      platform owner's quota / billing (which is what we ship now to fix).
//
// If `VITE_OWNER_GROUP_ID` is not set in the build (e.g. dev/localhost
// without a build override), we fall back to "yes if a key is set" — the
// server-side enforcement in `api/gemini.ts` etc. is the actual security
// boundary. This client-side helper is the awareness layer that hides
// AI affordances when we KNOW they won't work, so non-owner groups
// without their own key see clean "set your API key" messaging instead
// of broken-call surprises.
//
// Mirrors the shape of `emailEligibility.ts`; same env-var pattern.

function getOwnerGroupId(): string | undefined {
  return (import.meta.env.VITE_OWNER_GROUP_ID as string | undefined)?.trim() || undefined;
}

function isCurrentGroupOwner(): boolean {
  const owner = getOwnerGroupId();
  if (!owner) return true; // env not configured — be permissive (server still enforces)
  const current = getGroupId();
  if (!current) return false; // group not yet loaded — don't pre-affirm
  return current === owner;
}

// True iff this group can call the Gemini proxy successfully:
// either the group has its own key OR the group is the platform-owner
// group and may use the env-var fallback.
export function isGeminiEnabledForCurrentGroup(): boolean {
  const groupKey = getSettings()?.geminiApiKey;
  if (groupKey && groupKey.trim()) return true;
  return isCurrentGroupOwner();
}

// True iff this group can call the ElevenLabs proxy successfully.
// Same shape as `isGeminiEnabledForCurrentGroup`.
export function isElevenLabsEnabledForCurrentGroup(): boolean {
  const groupKey = getSettings()?.elevenlabsApiKey;
  if (groupKey && groupKey.trim()) return true;
  return isCurrentGroupOwner();
}

// True iff the call path was working at some point — used by UI affordances
// that want to remain enabled "this group has used AI before, the photo
// button can still be tried" without re-proving viability every render.
// Distinct from `isGeminiEnabledForCurrentGroup` because a group with a
// key set today + zero past games should still see AI affordances.
//
// NOTE: deliberately does NOT count past `aiSummary` rows as proof — that
// heuristic was the reason the v5.60.2-and-prior code kept enabling AI
// for groups that had been silently using the platform owner's key. The
// only honest signal now is "do we have a working call path right now?".
export const isAIEnabledForCurrentGroup = isGeminiEnabledForCurrentGroup;

// ──────────────────────────────────────────────────────────────────────
// AI proxy environment availability
// ──────────────────────────────────────────────────────────────────────
//
// The Gemini / ElevenLabs proxies live as Vercel Edge Functions in
// `api/*.ts` and only exist on the deployed Vercel site. The standard
// localhost dev server (Vite) does NOT serve them — every fetch to
// `/api/gemini` from `npm run dev` returns 404 with an HTML body. That
// 404 then cascades through every retry loop in `geminiAI.ts` /
// `pokerTraining.ts` and surfaces as the unhelpful red-banner string
// "ALL_MODELS_FAILED: Status 404" — which says nothing about the real
// cause (proxy not deployed in this environment).
//
// We track availability with a tristate cache:
//   null        → never tried; assume available (don't pre-block)
//   true        → first call succeeded; AI works in this environment
//   false       → first call returned HTML 404; proxy unreachable here
//
// `vercel dev` ALSO runs on localhost but DOES serve `/api/*`, so we
// can't gate on hostname alone — we have to discover by trying. Once
// the first call resolves, every subsequent call short-circuits based
// on the cached result, costing one wasted fetch on cold-start in
// localhost dev (acceptable price for never blocking `vercel dev`).

let _aiProxyAvailable: boolean | null = null;

export function getAIProxyAvailable(): boolean | null {
  return _aiProxyAvailable;
}

export function markAIProxyAvailable(): void {
  _aiProxyAvailable = true;
}

export function markAIProxyUnavailable(): void {
  _aiProxyAvailable = false;
}

// True when we know for sure the proxy can't be reached from this
// environment (typically: localhost without `vercel dev`). UI surfaces
// can render a "deploy to test AI" notice instead of attempting the
// call and showing a confusing raw "Status 404" error.
export function isAIProxyKnownUnavailable(): boolean {
  return _aiProxyAvailable === false;
}
