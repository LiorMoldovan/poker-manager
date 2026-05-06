import { supabase } from '../database/supabaseClient';
import { getSettings } from '../database/storage';
import { getGroupId } from '../database/supabaseCache';
import { isEmailEnabledForCurrentGroup, notifyEmailDisabled } from './emailEligibility';

async function getAuthHeaders(): Promise<Record<string, string>> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token) {
      const parts = session.access_token.split('.');
      if (parts.length === 3) {
        try {
          const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
          if (payload.exp && payload.exp * 1000 < Date.now() + 60_000) {
            const { data: refreshed } = await supabase.auth.refreshSession();
            if (refreshed.session?.access_token) {
              return { 'Authorization': `Bearer ${refreshed.session.access_token}` };
            }
          }
        } catch { /* token decode failed, use as-is */ }
      }
      return { 'Authorization': `Bearer ${session.access_token}` };
    }
    const { data: refreshed } = await supabase.auth.refreshSession();
    if (refreshed.session?.access_token) {
      return { 'Authorization': `Bearer ${refreshed.session.access_token}` };
    }
  } catch { /* session unavailable */ }
  return {};
}

function getGroupGeminiKey(): string | undefined {
  return getSettings()?.geminiApiKey || undefined;
}

function getGroupElevenLabsKey(): string | undefined {
  return getSettings()?.elevenlabsApiKey || undefined;
}

export async function proxyGeminiGenerate(
  version: string,
  model: string,
  _apiKey: string,
  payload: unknown
): Promise<Response> {
  const auth = await getAuthHeaders();
  const groupKey = getGroupGeminiKey();
  return fetch('/api/gemini', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ version, model, payload, ...(groupKey && { apiKey: groupKey }) }),
  });
}

export async function proxyGeminiGenerateWithSignal(
  version: string,
  model: string,
  _apiKey: string,
  payload: unknown,
  signal?: AbortSignal
): Promise<Response> {
  const auth = await getAuthHeaders();
  const groupKey = getGroupGeminiKey();
  return fetch('/api/gemini', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ version, model, payload, ...(groupKey && { apiKey: groupKey }) }),
    signal,
  });
}

/**
 * Image-generation variant. The existing /api/gemini route is model-agnostic
 * — it just forwards `payload` to `models/{model}:generateContent`, so the
 * same JWT-protected proxy works for image models like
 * `gemini-2.5-flash-image`. The response shape places the PNG bytes in
 * `candidates[0].content.parts[].inline_data.data` (base64).
 *
 * This helper exists so callers can be explicit about intent (image vs text)
 * and so we have a single seam to swap if Google ever splits image gen onto
 * a different endpoint. Larger default timeout for the heavier image call.
 */
export async function proxyGeminiImage(
  model: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const auth = await getAuthHeaders();
  const groupKey = getGroupGeminiKey();
  return fetch('/api/gemini', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({
      version: 'v1beta',
      model,
      payload,
      ...(groupKey && { apiKey: groupKey }),
    }),
    signal,
  });
}

/**
 * Anonymous image generation via Pollinations.ai.
 *
 * Free, no signup, no API key. Uses the public GET endpoint:
 *   https://image.pollinations.ai/prompt/{encodedPrompt}?width=...&height=...&seed=...&model=...
 *
 * Why we call this directly from the browser (not via /api/...):
 *   - Pollinations is intentionally CORS-friendly (their docs show <img src="...">)
 *   - We have no secret to hide (anonymous tier needs no key)
 *   - Vercel Edge Functions cap at ~30s but Pollinations frequently takes
 *     60-90s for 1024x1024 on the anonymous tier. A direct browser fetch
 *     respects the user's chosen wait time.
 *
 * Pollinations caches by `prompt + seed`, so callers MUST pass a fresh
 * seed each generation (e.g. Date.now() + Math.random()) to avoid getting
 * the previously-cached image back on regenerate.
 */
export interface PollinationsImageOptions {
  width?: number;
  height?: number;
  seed?: number;
  /** Available anonymous models: 'flux' (recommended), 'zimage' (default). Premium models like 'nanobanana' require an account. */
  model?: 'flux' | 'zimage' | string;
  nologo?: boolean;
  signal?: AbortSignal;
}

export async function pollinationsImage(
  prompt: string,
  options: PollinationsImageOptions = {},
): Promise<{ blob: Blob; mimeType: string; sourceUrl: string; model: string }> {
  const {
    width = 1024,
    height = 1024,
    seed = Date.now(),
    model = 'flux',
    nologo = true,
    signal,
  } = options;

  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
    seed: String(seed),
    model,
    ...(nologo ? { nologo: 'true' } : {}),
  });

  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params.toString()}`;

  const response = await fetch(url, { method: 'GET', signal });

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const txt = await response.text();
      try {
        const json = JSON.parse(txt);
        detail = json?.message || json?.error || detail;
      } catch {
        if (txt) detail = txt.slice(0, 300);
      }
    } catch { /* ignore body read errors */ }
    throw new Error(`Pollinations image generation failed: ${detail}`);
  }

  const mimeType = response.headers.get('content-type') || 'image/jpeg';
  if (!mimeType.startsWith('image/')) {
    throw new Error(`Pollinations returned non-image response: ${mimeType}`);
  }

  const blob = await response.blob();
  if (!blob || blob.size === 0) {
    throw new Error('Pollinations returned empty image body');
  }

  return { blob, mimeType, sourceUrl: url, model: `pollinations/${model}` };
}

export async function proxyGeminiModels(_apiKey: string, version = 'v1beta'): Promise<Response> {
  const auth = await getAuthHeaders();
  const groupKey = getGroupGeminiKey();
  return fetch('/api/gemini-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ version, ...(groupKey && { apiKey: groupKey }) }),
  });
}

export async function proxyElevenLabsTTS(
  _apiKey: string,
  voiceId: string,
  payload: { text: string; model_id: string; language_code: string },
  outputFormat = 'mp3_22050_32',
  signal?: AbortSignal
): Promise<Response> {
  const auth = await getAuthHeaders();
  const groupKey = getGroupElevenLabsKey();
  return fetch('/api/elevenlabs-tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ voiceId, outputFormat, payload, ...(groupKey && { apiKey: groupKey }) }),
    signal,
  });
}

export async function proxyElevenLabsUsage(_apiKey: string): Promise<Response> {
  const auth = await getAuthHeaders();
  const groupKey = getGroupElevenLabsKey();
  return fetch('/api/elevenlabs-usage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ ...(groupKey && { apiKey: groupKey }) }),
  });
}

// Tags the originating event so the usage card can break sends down by kind.
// Stays narrow (string union) so callers don't drift into ad-hoc strings.
export type EmailKind =
  // Schedule lifecycle (mirrors NotificationKind in scheduleNotifications.ts)
  | 'invitation'
  | 'new_vote'
  | 'expanded'
  | 'confirmed'
  | 'target_filled'
  | 'cancelled'
  | 'reminder'
  // Game flow
  | 'settlement'
  // Training
  | 'training'
  | 'training_share'
  // Dev tools
  | 'preview'
  // Catch-all for anything that doesn't fit the above
  | 'broadcast';

export async function proxySendEmail(payload: {
  to: string;
  subject: string;
  playerName: string;
  reporterName: string;
  amount: number;
  gameDate?: string;
  payLink?: string;
  kind?: EmailKind;
}): Promise<boolean> {
  if (!isEmailEnabledForCurrentGroup()) {
    notifyEmailDisabled(payload.kind);
    return false;
  }
  try {
    const auth = await getAuthHeaders();
    const groupId = getGroupId();
    const res = await fetch('/api/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ ...payload, groupId, kind: payload.kind ?? 'settlement' }),
    });
    if (res.status === 403) {
      // Defense in depth: VITE_OWNER_GROUP_ID was misconfigured but the server
      // still rejected. Fire the same event so the UI surfaces the situation.
      notifyEmailDisabled(payload.kind);
      return false;
    }
    if (res.ok && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('email-sent'));
    }
    return res.ok;
  } catch {
    return false;
  }
}

// Wraps a Hebrew (or any RTL) plain-text message in an HTML block
// that forces right-to-left paragraph alignment in EVERY email
// client. This supersedes the older "prepend a U+200F RLM" trick —
// that mark only steered paragraph-level bidi resolution; it did
// NOT override the EmailJS template's `text-align: left` CSS, which
// is exactly why some users still saw Hebrew bodies hugging the
// left edge of the message pane.
//
// How it works:
//   * `dir="rtl"` flips the block's bidi base direction to RTL.
//   * Inline `text-align: right` wins over any template-level CSS
//     (inline styles beat external stylesheets in email clients
//     that strip <style> blocks — most do).
//   * `unicode-bidi: plaintext` lets the bidi algorithm honour each
//     paragraph's own first strong character, so embedded LTR runs
//     (URLs, English names, numbers) render correctly inside the
//     RTL block instead of being force-flipped.
//   * `\n` → `<br>` so paragraph breaks survive HTML rendering
//     while plain-text fallback views (rare, but Outlook on
//     Windows still renders some clients as plaintext) still see
//     the original newlines if the wrapper is stripped.
//   * Strip a leading U+200F if the caller still adds one — the
//     mark is harmless but pointless once we're emitting explicit
//     `dir="rtl"`, and removing it keeps the body byte-clean.
//
// EmailJS template requirement: the broadcast template
// (`template_broadcast`) MUST render `{{message}}` as raw HTML
// (the EmailJS default). If it ever gets reconfigured to
// HTML-escape the placeholder, recipients will see literal `<div…>`
// tags instead of the wrapped layout — that's a template-side
// regression, not a code regression.
function wrapHebrewEmailForRTL(message: string): string {
  const sanitized = message.replace(/^\u200F/, '');
  // We escape `<` / `>` only on the chance the body itself contains
  // angle brackets (e.g. a player name "<Bob>"); the wrapper's own
  // tags are concatenated *after* escaping the body, so they stay
  // intact. `&` is intentionally NOT escaped because email bodies
  // commonly contain ampersands in URL query strings, and double-
  // escaping `&amp;` from a working URL would break the link.
  const escaped = sanitized
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const html = escaped.replace(/\n/g, '<br>');
  return (
    '<div dir="rtl" style="text-align: right; direction: rtl; '
    + 'unicode-bidi: plaintext; font-family: Arial, Helvetica, sans-serif; '
    + 'line-height: 1.5; white-space: normal;">'
    + html
    + '</div>'
  );
}

export async function proxySendBroadcastEmail(payload: {
  to: string;
  subject: string;
  message: string;
  senderName?: string;
  kind?: EmailKind;
}): Promise<boolean> {
  if (!isEmailEnabledForCurrentGroup()) {
    notifyEmailDisabled(payload.kind);
    return false;
  }
  try {
    const auth = await getAuthHeaders();
    const groupId = getGroupId();
    const res = await fetch('/api/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({
        ...payload,
        message: wrapHebrewEmailForRTL(payload.message),
        groupId,
        kind: payload.kind ?? 'broadcast',
      }),
    });
    if (res.status === 403) {
      notifyEmailDisabled(payload.kind);
      return false;
    }
    if (res.ok && typeof window !== 'undefined') {
      window.dispatchEvent(new Event('email-sent'));
    }
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Email Usage (super admin only) ──────────────────────────────────────
// Mirrors `proxyElevenLabsUsage` shape so the Settings AI card can use the
// same fetch/cache pattern. Backed by Supabase (not the upstream provider)
// because EmailJS Free has no public usage endpoint.

export interface EmailUsageEntry {
  sent_at: string;
  recipient: string;
  kind: string;
  subject: string | null;
  success: boolean;
  http_status: number | null;
  group_id: string | null;
}

export interface EmailUsageResponse {
  used: number;
  limit: number;
  // 'env' = limit pulled from EMAILJS_MONTHLY_CAP env var (operator-set);
  // 'default' = fell back to the documented Free-tier value of 200. The
  // UI uses this to render a "default — verify in EmailJS dashboard"
  // caveat so the limit isn't mistaken for a live read from EmailJS.
  limitSource?: 'env' | 'default';
  remaining: number;
  resetDate: string;          // YYYY-MM-DD UTC
  // ISO timestamp of the oldest row in `email_usage_log`. Null when the
  // log is empty (which means we genuinely have nothing to report yet —
  // the UI shows "no sends logged yet" in that case). Used to render
  // "Logging started: <date>" so users understand historical sends from
  // before this audit log existed are NOT counted in `used`.
  loggingSince?: string | null;
  perKind: Record<string, number>;
  perDay: Array<{ date: string; count: number }>;
  recent: EmailUsageEntry[];
  failed: number;
}

export async function proxyEmailUsage(): Promise<EmailUsageResponse | null> {
  try {
    const auth = await getAuthHeaders();
    const res = await fetch('/api/email-usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: '{}',
    });
    if (!res.ok) return null;
    return (await res.json()) as EmailUsageResponse;
  } catch {
    return null;
  }
}

export async function proxySendPush(payload: {
  groupId: string;
  title: string;
  body: string;
  targetPlayerNames?: string[];
  url?: string;
}): Promise<{ sent: number; total: number; details?: { player: string; type: string; status: number | string; ok: boolean }[] } | null> {
  try {
    const auth = await getAuthHeaders();
    const res = await fetch('/api/send-push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      let msg = `HTTP ${res.status}`;
      try { const j = JSON.parse(text); msg = j.error?.message || msg; } catch { msg = text || msg; }
      console.error('[push]', msg);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error('[push]', err);
    return null;
  }
}

