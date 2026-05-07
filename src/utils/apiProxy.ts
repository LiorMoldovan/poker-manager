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

// Result shape for the email proxies. Keeping `ok` as the headline
// flag (so the existing "boolean truthiness" pattern at call sites
// keeps working when destructured), but surfacing the actual server
// error message + HTTP status when something fails — the user-facing
// toast and the F12 console can now name the real cause instead of
// just "❌ שגיאה בשליחה". `reason` distinguishes client-side
// short-circuits (group not allowed, server forbade us) from upstream
// failures (HTTP / network) so the UI can render different copy.
export type EmailSendResult = {
  ok: boolean;
  status?: number;
  error?: string;
  reason?: 'email_disabled' | 'forbidden' | 'http_error' | 'network_error';
};

// Pulls a human-readable error string from a non-OK fetch Response.
// Tries JSON first (Edge Function returns `{ error: { message } }` /
// `{ error: 'string' }`); falls back to plain text. Always returns
// something — never null — so the caller can hand it straight to a UI.
async function extractErrorMessage(res: Response): Promise<string> {
  try {
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const j = await res.json().catch(() => null) as unknown;
      if (j && typeof j === 'object') {
        const errField = (j as { error?: unknown }).error;
        if (typeof errField === 'string') return errField;
        if (errField && typeof errField === 'object') {
          const m = (errField as { message?: unknown }).message;
          if (typeof m === 'string' && m) return m;
        }
        const topMsg = (j as { message?: unknown }).message;
        if (typeof topMsg === 'string' && topMsg) return topMsg;
      }
    }
    const txt = await res.text().catch(() => '');
    if (txt) return txt.slice(0, 300);
  } catch {
    // fall through
  }
  return `HTTP ${res.status}`;
}

export async function proxySendEmail(payload: {
  to: string;
  subject: string;
  playerName: string;
  reporterName: string;
  amount: number;
  gameDate?: string;
  payLink?: string;
  kind?: EmailKind;
}): Promise<EmailSendResult> {
  if (!isEmailEnabledForCurrentGroup()) {
    notifyEmailDisabled(payload.kind);
    return { ok: false, reason: 'email_disabled', error: 'Email sending is disabled for this group' };
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
      const error = await extractErrorMessage(res);
      return { ok: false, status: 403, reason: 'forbidden', error };
    }
    if (!res.ok) {
      const error = await extractErrorMessage(res);
      console.error(`[proxySendEmail] ${res.status} ${error}`);
      return { ok: false, status: res.status, reason: 'http_error', error };
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('email-sent'));
    }
    return { ok: true, status: res.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[proxySendEmail] network/throw:', err);
    return { ok: false, reason: 'network_error', error: msg };
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
}): Promise<EmailSendResult> {
  if (!isEmailEnabledForCurrentGroup()) {
    notifyEmailDisabled(payload.kind);
    return { ok: false, reason: 'email_disabled', error: 'Email sending is disabled for this group' };
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
      const error = await extractErrorMessage(res);
      return { ok: false, status: 403, reason: 'forbidden', error };
    }
    if (!res.ok) {
      const error = await extractErrorMessage(res);
      console.error(`[proxySendBroadcastEmail] ${res.status} ${error}`);
      return { ok: false, status: res.status, reason: 'http_error', error };
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('email-sent'));
    }
    return { ok: true, status: res.status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[proxySendBroadcastEmail] network/throw:', err);
    return { ok: false, reason: 'network_error', error: msg };
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
  // 'config' = pulled from `system_config` Supabase table (operator
  // edits via the UI — preferred path).
  // 'env'    = pulled from EMAILJS_MONTHLY_CAP env var (legacy).
  // 'default' = fell back to the documented Free-tier value of 200.
  // The UI nudges the operator to set the value when this is 'default'.
  limitSource?: 'config' | 'env' | 'default';
  remaining: number;
  resetDate: string;          // YYYY-MM-DD UTC
  // 'config' = reset day from `system_config` (UI-editable).
  // 'env'    = reset day from EMAILJS_QUOTA_RESET_DAY env var.
  // 'default' = day 1 (calendar month). UI nudges to set this.
  resetDaySource?: 'config' | 'env' | 'default';
  // 'self_log' = pure count from `email_usage_log` (the normal case
  // from the second billing cycle onwards).
  // 'baseline_plus_self_log' = active during the partial first cycle
  // where the operator seeded an EmailJS-dashboard reading via env
  // vars and the audit log only captured rows from that point onward.
  // The UI shows "starting from N" in the source caption when this
  // is active so the operator can see how the headline was built.
  usedSource?: 'self_log' | 'baseline_plus_self_log';
  // The baseline contribution to `used`. 0 when no baseline is active.
  baselineApplied?: number;
  // ── Self-log audit fields (still used for per-kind breakdown
  // and recent-sends list, even when EmailJS is the headline number).
  // Null when the log is empty — UI shows "no sends logged yet".
  loggingSince?: string | null;
  selfLogUsed?: number;
  selfLogFailed?: number;
  perKind: Record<string, number>;
  perDay: Array<{ date: string; count: number }>;
  recent: EmailUsageEntry[];
  failed: number;
  // ── EmailJS upstream signals.
  // emailjsAvailable is false when the EMAILJS_PRIVATE_KEY env var isn't
  // configured or the EmailJS API call failed; everything below silently
  // collapses to null/0 in that case.
  emailjsAvailable?: boolean;
  // Oldest row in our LOCAL cache of EmailJS history. After running for
  // a few weeks this stretches back far past EmailJS's own 7-day
  // retention — the cache is how we keep a real monthly view on Free.
  emailjsCacheSince?: string | null;
  emailjsLastSyncedAt?: string | null;
  emailjsLast7d?: number | null;
  emailjsLast7dFailed?: number | null;
  emailjsError?: string | null;
  ourLast7d?: number;
  inSync?: 'unknown' | 'ok' | 'gap';
}

// Compute the EmailJS billing cycle window (UTC) given a reset day.
// Mirrors the same logic in `api/email-usage.ts` so the Supabase-direct
// fallback queries the same window as the Edge Function path. Default
// reset day = 1 (calendar month). When the env-var-set production path
// runs, the Edge Function overrides this with its own resetDay.
function computeCycleWindow(resetDay: number): { start: string; end: string; resetDate: string } {
  const day = Math.max(1, Math.min(31, Math.floor(resetDay) || 1));
  const now = new Date();
  const currentUtcDay = now.getUTCDate();
  let endY = now.getUTCFullYear();
  let endM = now.getUTCMonth();
  if (currentUtcDay >= day) {
    endM += 1;
    if (endM > 11) { endM = 0; endY += 1; }
  }
  const end = new Date(Date.UTC(endY, endM, day));
  const start = new Date(Date.UTC(endY, endM - 1, day));
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    resetDate: end.toISOString().slice(0, 10),
  };
}

// Supabase-direct fallback for the EmailJS Usage card. Used when the
// Edge Function path (`/api/email-usage`) isn't reachable — the most
// common case being **localhost development**, where Vite doesn't
// serve Vercel Edge Functions.
//
// Architecture parity with the Edge Function path:
//   We call `system_config` to get the cycle reset day, monthly cap,
//   and baseline directly from Supabase — the same source the Edge
//   Function reads from. So localhost ends up showing the SAME
//   number as production for the same configuration. Previously this
//   path showed a calendar-month default, which made local dev look
//   broken.
//
// Cross-check still missing on this path:
//   The EmailJS `/history` API requires the server-side private key,
//   so `emailjsAvailable` stays false and the in-sync line hides
//   itself client-side. Everything else matches.
async function fetchSystemConfig<T>(key: string): Promise<T | null> {
  try {
    const { data, error } = await supabase.rpc('get_system_config', { p_key: key });
    if (error) return null;
    return (data ?? null) as T | null;
  } catch {
    return null;
  }
}

async function fetchEmailUsageDirect(): Promise<EmailUsageResponse | null> {
  try {
    // 1. Resolve cycle window from system_config (fall back to day 1).
    const resetDayConfig = await fetchSystemConfig<number>('emailjs_quota_reset_day');
    const resetDay = (typeof resetDayConfig === 'number' && resetDayConfig >= 1 && resetDayConfig <= 31)
      ? resetDayConfig
      : 1;
    const resetDaySource: 'config' | 'default' = (typeof resetDayConfig === 'number') ? 'config' : 'default';
    const cycle = computeCycleWindow(resetDay);

    // 2. Resolve monthly cap from system_config (fall back to 200).
    const capConfig = await fetchSystemConfig<number>('emailjs_monthly_cap');
    const limit = (typeof capConfig === 'number' && capConfig > 0) ? Math.floor(capConfig) : 200;
    const limitSource: 'config' | 'default' = (typeof capConfig === 'number' && capConfig > 0) ? 'config' : 'default';

    // 3. Resolve baseline from system_config (null when not set).
    const baselineConfig = await fetchSystemConfig<{ used?: number; taken_at?: string; cycle_start?: string }>('emailjs_baseline');
    let baselineUsed = 0;
    let baselineTakenAt: string | null = null;
    let baselineCycleStart: string | null = null;
    if (baselineConfig && typeof baselineConfig === 'object') {
      const u = Number(baselineConfig.used);
      if (Number.isFinite(u) && u >= 0 && baselineConfig.taken_at && baselineConfig.cycle_start) {
        baselineUsed = u;
        baselineTakenAt = baselineConfig.taken_at;
        baselineCycleStart = baselineConfig.cycle_start;
      }
    }

    // 4. Self-log count for the cycle.
    const { data, error } = await supabase.rpc('get_email_usage_summary', {
      month_start: cycle.start,
      month_end: cycle.end,
    });
    if (error || !data) return null;
    const row = data as {
      used?: number;
      failed?: number;
      oldest_logged_at?: string | null;
      per_kind?: Record<string, number>;
      per_day?: Array<{ date: string; count: number }>;
      recent?: EmailUsageEntry[];
    };
    const selfLogUsed = Number(row.used || 0);
    const failed = Number(row.failed || 0);

    // 5. Apply baseline if it lives inside the current cycle.
    let used = selfLogUsed;
    let baselineApplied = 0;
    let usedSource: 'self_log' | 'baseline_plus_self_log' = 'self_log';
    const cycleStartIso = cycle.start.slice(0, 10); // cycle.start is already an ISO string from helper
    if (baselineCycleStart && baselineTakenAt && baselineCycleStart.slice(0, 10) === cycleStartIso) {
      // Count rows since baseline was taken.
      const { data: postData, error: postErr } = await supabase.rpc('get_email_usage_summary', {
        month_start: baselineTakenAt,
        month_end: cycle.end,
      });
      const postCount = !postErr && postData ? Number((postData as { used?: number }).used || 0) : 0;
      used = baselineUsed + postCount;
      baselineApplied = baselineUsed;
      usedSource = 'baseline_plus_self_log';
    }

    return {
      used,
      limit,
      limitSource,
      remaining: Math.max(limit - used, 0),
      resetDate: cycle.resetDate,
      resetDaySource,
      usedSource,
      baselineApplied,
      loggingSince: row.oldest_logged_at || null,
      selfLogUsed,
      selfLogFailed: failed,
      perKind: row.per_kind || {},
      perDay: row.per_day || [],
      recent: row.recent || [],
      failed,
      emailjsAvailable: false,
      emailjsCacheSince: null,
      emailjsLastSyncedAt: null,
      emailjsLast7d: null,
      emailjsLast7dFailed: null,
      emailjsError: 'direct mode (no Edge Function) — EmailJS cross-check disabled',
      ourLast7d: 0,
      inSync: 'unknown',
    };
  } catch {
    return null;
  }
}

export interface EmailQuotaConfig {
  resetDay: number | null;          // 1..31, null when unset
  monthlyCap: number | null;        // > 0, null when unset
  baseline: {
    used: number;
    takenAt: string;                // ISO
    cycleStart: string;             // ISO
  } | null;
}

// Reads all three EmailJS quota system_config entries in one call.
// Used by the Settings → Services UI to populate the "Set baseline"
// editor with whatever's currently configured. Returns nulls for any
// key that isn't set yet — the UI shows placeholder hints in that case.
export async function proxyGetEmailQuotaConfig(): Promise<EmailQuotaConfig | null> {
  try {
    const [resetDayRes, capRes, baselineRes] = await Promise.all([
      supabase.rpc('get_system_config', { p_key: 'emailjs_quota_reset_day' }),
      supabase.rpc('get_system_config', { p_key: 'emailjs_monthly_cap' }),
      supabase.rpc('get_system_config', { p_key: 'emailjs_baseline' }),
    ]);
    const resetDay = typeof resetDayRes.data === 'number' && resetDayRes.data >= 1 && resetDayRes.data <= 31
      ? resetDayRes.data : null;
    const monthlyCap = typeof capRes.data === 'number' && capRes.data > 0
      ? capRes.data : null;
    let baseline: EmailQuotaConfig['baseline'] = null;
    if (baselineRes.data && typeof baselineRes.data === 'object') {
      const b = baselineRes.data as { used?: number; taken_at?: string; cycle_start?: string };
      if (typeof b.used === 'number' && b.used >= 0 && b.taken_at && b.cycle_start) {
        baseline = { used: b.used, takenAt: b.taken_at, cycleStart: b.cycle_start };
      }
    }
    return { resetDay, monthlyCap, baseline };
  } catch {
    return null;
  }
}

// Writes one or more system_config entries. Pass only the fields you
// want to update — undefined fields are left as-is. Useful when the
// UI just wants to seed a baseline without touching cap/reset day.
export async function proxySetEmailQuotaConfig(updates: {
  resetDay?: number;
  monthlyCap?: number;
  baseline?: { used: number; takenAt: string; cycleStart: string } | null;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    // supabase.rpc(...) returns a thenable PostgrestBuilder that we
    // resolve via `await`. Sequential awaits are simpler than
    // Promise.all and keep the typing clean — the volume is at most
    // 3 round-trips, not worth parallelising.
    if (typeof updates.resetDay === 'number') {
      const { error } = await supabase.rpc('set_system_config', {
        p_key: 'emailjs_quota_reset_day',
        p_value: updates.resetDay,
      });
      if (error) return { ok: false, error: error.message };
    }
    if (typeof updates.monthlyCap === 'number') {
      const { error } = await supabase.rpc('set_system_config', {
        p_key: 'emailjs_monthly_cap',
        p_value: updates.monthlyCap,
      });
      if (error) return { ok: false, error: error.message };
    }
    if (updates.baseline !== undefined) {
      const { error } = await supabase.rpc('set_system_config', {
        p_key: 'emailjs_baseline',
        p_value: updates.baseline === null
          ? null
          : { used: updates.baseline.used, taken_at: updates.baseline.takenAt, cycle_start: updates.baseline.cycleStart },
      });
      if (error) return { ok: false, error: error.message };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 200) };
  }
}

export async function proxyEmailUsage(): Promise<EmailUsageResponse | null> {
  // Production path: hit the Edge Function. It does cycle math from
  // EMAILJS_QUOTA_RESET_DAY, fetches /history for the cross-check,
  // and merges everything into one response.
  try {
    const auth = await getAuthHeaders();
    const res = await fetch('/api/email-usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: '{}',
    });
    if (res.ok) return (await res.json()) as EmailUsageResponse;
    // 404/405 on dev means Vite isn't serving Edge Functions — fall
    // through to the Supabase-direct path. Other non-OK statuses (real
    // errors like 500) also fall through so we still show *something*
    // rather than the perpetual "loading…" state.
  } catch {
    // network error — same fallback story
  }
  return fetchEmailUsageDirect();
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

