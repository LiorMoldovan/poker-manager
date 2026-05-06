import { verifySupabaseAuth } from './_auth';
import { computeCycleWindow, getCurrentCycleUsage, getMonthlyCap } from './_emailUsage';

export const config = { runtime: 'edge' };

const JSON_HEADERS = { 'Content-Type': 'application/json' };

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ursjltxklmxmapfvkttj.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_TzhEQmU6mX2n-utnOUAtwQ_zkGTR13j';

// ─── Recipient masking ─────────────────────────────────────────────────
// "lior.m@gmail.com" → "li***@g***.com". Same scheme as api/send-email.ts
// so EmailJS-derived rows and self-log rows show up with consistent
// masking in the UI's "Recent sends" list.
function maskRecipient(email: string | null | undefined): string | null {
  if (!email || !email.includes('@')) return null;
  const [local, domain] = email.split('@');
  const localMasked = local.length <= 2 ? `${local[0] ?? '*'}*` : `${local.slice(0, 2)}***`;
  if (!domain) return `${localMasked}@***`;
  const dotIdx = domain.indexOf('.');
  if (dotIdx <= 0) return `${localMasked}@${domain[0] ?? '*'}***`;
  return `${localMasked}@${domain[0]}***${domain.slice(dotIdx)}`;
}

// Best-effort kind inference from EmailJS template_id. We use two
// templates today: a settlement template (`template_vbxffkb` by default)
// and a broadcast template (`template_broadcast`). When env vars override
// these we honour the env. Falls back to 'broadcast' for unknown ids.
function inferKindFromTemplate(templateId: string | null | undefined): string {
  if (!templateId) return 'broadcast';
  const settlementId = process.env.EMAILJS_TEMPLATE_ID || 'template_vbxffkb';
  const broadcastId = process.env.EMAILJS_BROADCAST_TEMPLATE_ID || 'template_broadcast';
  if (templateId === settlementId) return 'settlement';
  if (templateId === broadcastId) return 'broadcast';
  return 'broadcast';
}

// EmailJS row shape from /history. We only consume what we cache; the
// API also returns retry_count, files, original_service_id, etc. that
// we ignore.
interface EmailJsRow {
  id?: string;
  result?: number;
  created_at?: string;
  template_id?: string;
  template_params?: string; // stringified JSON
}

interface CacheUpsertRow {
  id: string;
  created_at: string;
  result: number;
  template_id: string | null;
  recipient_masked: string | null;
  kind_inferred: string;
}

// ─── EmailJS /history fetch ────────────────────────────────────────────
// Returns the parsed rows and a flag for whether the API was reachable.
// Free tier retains 7 days; Personal+ retains 30. Either way, we fetch
// page 1 with count=200 — covers the entire retention window in any
// realistic scenario for this app's volume.
async function fetchEmailJsHistory(): Promise<{
  available: boolean;
  rows: EmailJsRow[];
  error?: string;
}> {
  const publicKey = process.env.EMAILJS_PUBLIC_KEY;
  const privateKey = process.env.EMAILJS_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    return { available: false, rows: [], error: 'EMAILJS_PRIVATE_KEY not configured' };
  }
  try {
    const params = new URLSearchParams({
      user_id: publicKey,
      accessToken: privateKey,
      page: '1',
      count: '200',
    });
    const r = await fetch(`https://api.emailjs.com/api/v1.1/history?${params.toString()}`, {
      method: 'GET',
    });
    if (!r.ok) {
      const text = await r.text();
      return { available: false, rows: [], error: `EmailJS history ${r.status}: ${text.slice(0, 200)}` };
    }
    const json = await r.json() as { rows?: EmailJsRow[] };
    return { available: true, rows: Array.isArray(json.rows) ? json.rows : [] };
  } catch (err) {
    return { available: false, rows: [], error: String(err).slice(0, 200) };
  }
}

// ─── Cache upsert ──────────────────────────────────────────────────────
// Convert raw EmailJS rows into the cache schema (mask recipient, infer
// kind) and bulk-upsert via the SECURITY DEFINER RPC. Idempotent — the
// row id is the PK, so syncing the same 7-day window 100 times produces
// 0 duplicates.
async function upsertEmailJsRows(authHeader: string, rows: EmailJsRow[]): Promise<{ ok: boolean; error?: string }> {
  if (rows.length === 0) return { ok: true };
  const payload: CacheUpsertRow[] = [];
  for (const row of rows) {
    if (!row.id || !row.created_at) continue;
    let toEmail: string | null = null;
    // EmailJS returns template_params as a JSON string. We pull the
    // `to_email` field (the same key our Edge Function sends in
    // api/send-email.ts) and mask it before storing. Anything we can't
    // parse, we drop the recipient — null is fine, the UI just shows
    // a placeholder.
    if (row.template_params) {
      try {
        const parsed = JSON.parse(row.template_params) as Record<string, unknown>;
        const candidate = parsed['to_email'] ?? parsed['email'] ?? parsed['recipient'];
        if (typeof candidate === 'string') toEmail = candidate;
      } catch {
        toEmail = null;
      }
    }
    payload.push({
      id: row.id,
      created_at: row.created_at,
      result: typeof row.result === 'number' ? row.result : 0,
      template_id: row.template_id || null,
      recipient_masked: maskRecipient(toEmail),
      kind_inferred: inferKindFromTemplate(row.template_id),
    });
  }
  if (payload.length === 0) return { ok: true };
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/upsert_emailjs_history`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': authHeader,
      },
      body: JSON.stringify({ rows: payload }),
    });
    if (!r.ok) {
      const text = await r.text();
      return { ok: false, error: `upsert_emailjs_history ${r.status}: ${text.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err).slice(0, 200) };
  }
}

// Read-only summary endpoint backing the super-admin "EmailJS Usage" card
// in Settings → AI. Forwards the caller's JWT to Supabase REST so
// `auth.uid()` inside the SECURITY DEFINER RPCs resolves correctly — no
// service role key needed.
//
// Data flow (post-v5.43.3):
//   1. Sync EmailJS /history (last 7 days) → upsert into emailjs_history_cache
//   2. Query monthly aggregate from the cache → that's the authoritative
//      `used` count for the quota bar (EmailJS data is the source of truth)
//   3. Query our self-log (email_usage_log) → for richer per-kind/per-group
//      attribution that EmailJS doesn't expose
//   4. Cross-check the two: if EmailJS says X this week and self-log says
//      Y, surface a sync indicator
//
// As long as the card is viewed at least once every 7 days (the Free-tier
// retention window), no rows are missed — the cache accumulates the full
// month from rolling 7-day snapshots, deduped by EmailJS row id.
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const authError = await verifySupabaseAuth(req);
  if (authError) return authError;

  const authHeader = req.headers.get('Authorization') || '';

  try {
    // ─── Step 0: Compute the EmailJS billing cycle window ─────────────
    // Helper resolves reset day from system_config first (UI-editable),
    // env var second, calendar-month default last. Same precedence is
    // used for the monthly cap below.
    const cycle = await computeCycleWindow(authHeader);
    const cycleStart = cycle.start;
    const cycleEnd = cycle.end;
    const resetDaySource = cycle.resetDaySource;
    const resetDate = cycleEnd.toISOString().slice(0, 10);

    // ─── Step 1: Fetch EmailJS /history ───────────────────────────────
    // Done first so the cache is fresh before we read the cycle aggregate.
    const emailjs = await fetchEmailJsHistory();

    // ─── Step 2: Upsert into the local cache ──────────────────────────
    // Best-effort — if the upsert fails (e.g. migration 054 not applied
    // yet), we still serve the stale cache and the self-log; the UI
    // surfaces the error in `emailjsError` so the operator knows to
    // investigate.
    let upsertError: string | null = null;
    if (emailjs.available && emailjs.rows.length > 0) {
      const upsert = await upsertEmailJsRows(authHeader, emailjs.rows);
      if (!upsert.ok) upsertError = upsert.error || null;
    }

    // ─── Step 3: Query both summaries in parallel ─────────────────────
    //   - getCurrentCycleUsage → self-log + baseline math, the
    //     authoritative number that matches the operator's EmailJS
    //     dashboard (baseline + every send since the baseline was set)
    //   - EmailJS cache RPC → cross-check signal (catches logger
    //     regressions; bounded by 7-day API retention)
    const [usageResult, emailjsCacheRes] = await Promise.all([
      getCurrentCycleUsage(authHeader, cycle),
      fetch(`${SUPABASE_URL}/rest/v1/rpc/get_emailjs_monthly_summary`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': authHeader,
        },
        body: JSON.stringify({
          month_start: cycleStart.toISOString(),
          month_end: cycleEnd.toISOString(),
        }),
      }),
    ]);

    if (!usageResult) {
      // RPC failed (most often 403 — non-super-admin caller). Surface
      // the same shape the front-end expects so it shows a friendly
      // error instead of staying on "loading…" forever.
      return new Response(JSON.stringify({ error: { message: 'forbidden or RPC failed' } }), {
        status: 403, headers: JSON_HEADERS,
      });
    }

    // EmailJS cache RPC is allowed to fail (migration 054 may not be
    // applied yet) — fall back to "no EmailJS-derived data" gracefully.
    let cacheData: {
      used?: number;
      failed?: number;
      oldest_cached_at?: string | null;
      last_synced_at?: string | null;
      per_day?: Array<{ date: string; count: number }>;
      per_kind?: Record<string, number>;
    } | null = null;
    if (emailjsCacheRes.ok) {
      cacheData = await emailjsCacheRes.json();
    } else {
      const text = await emailjsCacheRes.text();
      if (!upsertError) upsertError = `cache summary ${emailjsCacheRes.status}: ${text.slice(0, 200)}`;
    }

    // ─── Compute response shape ───────────────────────────────────────

    // Monthly cap. EmailJS doesn't expose the plan's cap via API, so
    // the operator sets it via Settings → Services UI (or env var
    // fallback). Default of 200 matches Free tier.
    const cap = await getMonthlyCap(authHeader);
    const limit = cap.cap;
    const limitSource: 'config' | 'env' | 'default' = cap.source;

    // Authoritative cycle count (baseline + new self-log rows). The
    // helper handles the baseline-cycle vs post-cycle distinction so
    // the UI just sees a single accurate number.
    const used = usageResult.used;
    const baselineApplied = usageResult.baselineApplied;
    const selfLogUsed = usageResult.selfLogUsed;
    const failed = usageResult.failed;
    const usedSource: 'self_log' | 'baseline_plus_self_log' =
      baselineApplied > 0 ? 'baseline_plus_self_log' : 'self_log';
    // Reconstruct a self-log shape compatible with the rest of the
    // function (perDay, perKind, recent) without re-fetching.
    const selfLog = {
      oldest_logged_at: usageResult.oldestLoggedAt,
      per_day: usageResult.perDay || [],
      per_kind: usageResult.perKind || {},
      recent: usageResult.recent || [],
      failed: usageResult.failed,
    };

    // perDay always comes from self-log — even with a baseline, the
    // baseline is a single integer, not a per-day breakdown. The
    // chart shows what we've recorded since logging was wired up;
    // anything older is rolled into the baseline number on the bar.
    const perDay = selfLog.per_day as Array<{ date: string; count: number }>;

    // perKind always comes from the self-log when available — EmailJS-
    // derived kinds are best-guess from template_id while self-log has
    // explicit semantic kinds ('settlement', 'reminder', etc.) which is
    // what the UI breakdown wants.
    const selfLogPerKind = (selfLog.per_kind || {}) as Record<string, number>;
    const inferredPerKind = (cacheData?.per_kind || {}) as Record<string, number>;
    const perKind = Object.keys(selfLogPerKind).length > 0
      ? selfLogPerKind
      : inferredPerKind;

    // Cross-check: 7-day window comparison between EmailJS upstream and
    // our self-log. Helps detect when the self-logger silently regresses.
    // Computed against the EmailJS rows directly (not the cache) so it
    // reflects the live API response.
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let emailjsLast7d: number | null = null;
    let emailjsLast7dFailed: number | null = null;
    if (emailjs.available) {
      let s = 0;
      let f = 0;
      for (const row of emailjs.rows) {
        const ts = row.created_at ? Date.parse(row.created_at) : NaN;
        if (!Number.isFinite(ts) || ts < sevenDaysAgo) continue;
        if (row.result === 1) s++;
        else if (row.result === 2) f++;
      }
      emailjsLast7d = s;
      emailjsLast7dFailed = f;
    }
    const selfLogPerDay = (selfLog?.per_day || []) as Array<{ date: string; count: number }>;
    const sevenDaysAgoIso = new Date(sevenDaysAgo).toISOString().slice(0, 10);
    const ourLast7d = selfLogPerDay
      .filter(d => typeof d.date === 'string' && d.date >= sevenDaysAgoIso)
      .reduce((s, d) => s + (Number(d.count) || 0), 0);
    let inSync: 'unknown' | 'ok' | 'gap' = 'unknown';
    if (emailjs.available && emailjsLast7d !== null) {
      inSync = Math.abs(ourLast7d - emailjsLast7d) <= 1 ? 'ok' : 'gap';
    }

    return new Response(JSON.stringify({
      // Quota headline. Self-log is the primary source from v5.43.3
      // onward; EmailJS-cache is the fallback only.
      used,
      limit,
      limitSource,
      remaining: Math.max(limit - used, 0),
      resetDate,
      // 'env' = reset day taken from EMAILJS_QUOTA_RESET_DAY (matches
      // dashboard); 'default' = fell back to day 1 (calendar month).
      // The UI shows a "default — set EMAILJS_QUOTA_RESET_DAY" hint
      // when this is 'default'.
      resetDaySource,
      // 'self_log' = pure count from `email_usage_log`.
      // 'baseline_plus_self_log' = baseline (operator-confirmed dashboard
      // reading) PLUS new sends since the baseline was set. Used during
      // the partial first cycle where the audit log started mid-stream.
      usedSource,
      // baseline.used when we're inside the baseline cycle, 0 otherwise.
      // The UI shows "starting from N" in the source caption to be
      // transparent about how the headline number was constructed.
      baselineApplied,
      // Self-log audit info (preserved for the recent-sends list and
      // per-kind breakdown).
      loggingSince: selfLog?.oldest_logged_at || null,
      selfLogUsed,
      selfLogFailed: Number(selfLog?.failed || 0),
      perKind,
      perDay: perDay || [],
      recent: selfLog?.recent || [],
      failed,
      // EmailJS upstream signals
      emailjsAvailable: emailjs.available,
      // Oldest row in the LOCAL cache (i.e. the earliest row we've ever
      // synced from EmailJS). Once we've run a sync at least once a
      // week for a few months, this stretches back far past EmailJS's
      // own 7-day retention.
      emailjsCacheSince: cacheData?.oldest_cached_at || null,
      emailjsLastSyncedAt: cacheData?.last_synced_at || null,
      emailjsLast7d,
      emailjsLast7dFailed,
      emailjsError: emailjs.error || upsertError || null,
      ourLast7d,
      inSync,
    }), { status: 200, headers: JSON_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: { message: String(err) } }), {
      status: 500, headers: JSON_HEADERS,
    });
  }
}
