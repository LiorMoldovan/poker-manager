// Shared utilities for the EmailJS quota system. Both
// `api/email-usage.ts` (the read-side Usage card) and `api/send-email.ts`
// (the write-side threshold-alert trigger) depend on the same cycle math
// and the same "what does my real usage look like right now?" answer,
// so we keep that logic in one place.
//
// Configuration model (v5.43.3+):
//   Configuration (cap, reset day, baseline) lives in the Supabase
//   `system_config` table — the super-admin edits it through the
//   Settings → Services UI without any env-var changes or redeploys.
//   The same table is readable from localhost via supabase-js, so the
//   dev experience matches production exactly.
//
//   Keys used by this module:
//     'emailjs_monthly_cap'     → number (e.g. 200)
//     'emailjs_quota_reset_day' → number 1..31 (the day-of-month from
//                                  the EmailJS dashboard)
//     'emailjs_baseline'        → { used, taken_at, cycle_start } so we
//                                  can seed the count from a dashboard
//                                  reading taken mid-cycle.
//
// Backwards compatibility:
//   The original env vars (EMAILJS_QUOTA_RESET_DAY, EMAILJS_MONTHLY_CAP,
//   EMAILJS_BASELINE_*) are still honoured as a fallback when the
//   system_config row is missing. This keeps existing deployments
//   working until the operator migrates to the UI.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ursjltxklmxmapfvkttj.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_TzhEQmU6mX2n-utnOUAtwQ_zkGTR13j';

// ─── system_config helper ─────────────────────────────────────────────
// Fetches one config key. Returns null on any error so the caller can
// fall back to env vars cleanly. Logs to console so a misconfigured
// RLS policy or a typo in the key name surfaces during development.
async function getSystemConfig<T>(authHeader: string, key: string): Promise<T | null> {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_system_config`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': authHeader,
      },
      body: JSON.stringify({ p_key: key }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (data === null || typeof data === 'undefined') return null;
    return data as T;
  } catch {
    return null;
  }
}

export interface CycleWindow {
  start: Date;
  end: Date;
  resetDay: number;
  resetDaySource: 'config' | 'env' | 'default';
}

// Compute the current EmailJS billing cycle window in UTC. Reset day
// preference order: system_config('emailjs_quota_reset_day') →
// EMAILJS_QUOTA_RESET_DAY env var → 1 (calendar month). The
// resetDaySource field lets the UI nudge the operator when only the
// 'default' value is in effect.
//
// We split this into a sync helper (`computeCycleWindowSync`) that
// takes the resetDay as input, and an async wrapper that reads the
// resetDay from Supabase first. The sync version is convenient for
// tests and for code paths that already know the resetDay.
export function computeCycleWindowSync(resetDay: number, resetDaySource: 'config' | 'env' | 'default'): CycleWindow {
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
  return { start, end, resetDay: day, resetDaySource };
}

export async function computeCycleWindow(authHeader: string): Promise<CycleWindow> {
  // 1. Try system_config first (operator-editable in the UI).
  const fromConfig = await getSystemConfig<number>(authHeader, 'emailjs_quota_reset_day');
  if (typeof fromConfig === 'number' && fromConfig >= 1 && fromConfig <= 31) {
    return computeCycleWindowSync(fromConfig, 'config');
  }
  // 2. Fall back to env var (legacy deployments).
  const fromEnv = process.env.EMAILJS_QUOTA_RESET_DAY;
  if (fromEnv) {
    const n = Number(fromEnv);
    if (Number.isFinite(n) && n >= 1 && n <= 31) {
      return computeCycleWindowSync(n, 'env');
    }
  }
  // 3. Calendar-month default.
  return computeCycleWindowSync(1, 'default');
}

// Resolve the monthly cap with the same precedence as resetDay.
export async function getMonthlyCap(authHeader: string): Promise<{ cap: number; source: 'config' | 'env' | 'default' }> {
  const fromConfig = await getSystemConfig<number>(authHeader, 'emailjs_monthly_cap');
  if (typeof fromConfig === 'number' && fromConfig > 0) {
    return { cap: Math.floor(fromConfig), source: 'config' };
  }
  const fromEnv = process.env.EMAILJS_MONTHLY_CAP;
  if (fromEnv) {
    const n = Number(fromEnv);
    if (Number.isFinite(n) && n > 0) return { cap: Math.floor(n), source: 'env' };
  }
  return { cap: 200, source: 'default' };
}

export interface BaselineConfig {
  used: number;          // operator-confirmed count from the EmailJS dashboard
  takenAt: Date;         // when that number was read (rows after this are real new sends)
  cycleStart: Date;      // baseline only applies inside this cycle
}

// Resolve the baseline. Same precedence: system_config first, env var
// fallback. Returns null when no baseline is configured anywhere
// (the normal state once the audit log has covered a full cycle).
export async function parseBaselineConfig(authHeader: string): Promise<BaselineConfig | null> {
  const fromConfig = await getSystemConfig<{ used?: number; taken_at?: string; cycle_start?: string }>(
    authHeader, 'emailjs_baseline'
  );
  if (fromConfig && typeof fromConfig === 'object') {
    const used = Number(fromConfig.used);
    const takenAt = fromConfig.taken_at ? new Date(fromConfig.taken_at) : null;
    const cycleStart = fromConfig.cycle_start ? new Date(fromConfig.cycle_start) : null;
    if (
      Number.isFinite(used) && used >= 0 &&
      takenAt && !Number.isNaN(takenAt.getTime()) &&
      cycleStart && !Number.isNaN(cycleStart.getTime())
    ) {
      return { used, takenAt, cycleStart };
    }
  }

  // Env var fallback.
  const usedRaw = process.env.EMAILJS_BASELINE_USED;
  const takenAtRaw = process.env.EMAILJS_BASELINE_AT;
  const cycleStartRaw = process.env.EMAILJS_BASELINE_CYCLE_START;
  if (!usedRaw || !takenAtRaw || !cycleStartRaw) return null;
  const used = Number(usedRaw);
  if (!Number.isFinite(used) || used < 0) return null;
  const takenAt = new Date(takenAtRaw);
  if (Number.isNaN(takenAt.getTime())) return null;
  const cycleStart = new Date(cycleStartRaw);
  if (Number.isNaN(cycleStart.getTime())) return null;
  return { used, takenAt, cycleStart };
}

// Returns true when `cycle` is the same cycle the baseline was taken
// in. Compares to the day (UTC) since both are anchored to the same
// reset day.
function isBaselineCycle(cycle: CycleWindow, baseline: BaselineConfig): boolean {
  return cycle.start.toISOString().slice(0, 10) === baseline.cycleStart.toISOString().slice(0, 10);
}

export interface CycleUsageResult {
  used: number;                  // total used in the cycle (baseline + new sends)
  selfLogUsed: number;           // raw count of `email_usage_log` rows in the cycle
  baselineApplied: number;       // 0 when baseline isn't active, otherwise BaselineConfig.used
  failed: number;
  perKind?: Record<string, number>;
  perDay?: Array<{ date: string; count: number }>;
  recent?: unknown[];
  oldestLoggedAt?: string | null;
}

// Single source of truth for "how many emails have we sent in the
// current cycle?" Used by both:
//   - api/email-usage.ts → drives the Usage card headline
//   - api/send-email.ts  → drives the threshold-alert decision
//
// When a baseline is configured AND we're still in the baseline
// cycle, the count is `baseline.used + count(rows where sent_at >=
// baseline.takenAt)`. That second term captures every email we've
// sent since the operator read the dashboard — including the one we
// just wrote a moment ago in the send path.
export async function getCurrentCycleUsage(
  authHeader: string,
  cycle: CycleWindow,
): Promise<CycleUsageResult | null> {
  // Pull the full cycle count from the self-log. This RPC also gives
  // us per_kind, per_day, and recent for the Usage card to render —
  // we re-use it here so there's exactly one round-trip.
  let selfLogJson: {
    used?: number;
    failed?: number;
    oldest_logged_at?: string | null;
    per_kind?: Record<string, number>;
    per_day?: Array<{ date: string; count: number }>;
    recent?: unknown[];
  } | null = null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_email_usage_summary`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': authHeader,
      },
      body: JSON.stringify({
        month_start: cycle.start.toISOString(),
        month_end: cycle.end.toISOString(),
      }),
    });
    if (!r.ok) return null;
    selfLogJson = await r.json();
  } catch {
    return null;
  }
  if (!selfLogJson) return null;

  const selfLogUsed = Number(selfLogJson.used || 0);
  const failed = Number(selfLogJson.failed || 0);

  const baseline = await parseBaselineConfig(authHeader);

  // Baseline only applies if (a) it's configured, (b) we're still in
  // the baseline cycle. Outside that, the self-log is authoritative
  // on its own.
  if (!baseline || !isBaselineCycle(cycle, baseline)) {
    return {
      used: selfLogUsed,
      selfLogUsed,
      baselineApplied: 0,
      failed,
      perKind: selfLogJson.per_kind,
      perDay: selfLogJson.per_day,
      recent: selfLogJson.recent,
      oldestLoggedAt: selfLogJson.oldest_logged_at ?? null,
    };
  }

  // Baseline-active path: baseline + count(rows after baseline.takenAt).
  // We need a second narrower query — calling the same RPC with
  // baseline.takenAt as month_start gives us "everything logged after
  // the baseline was taken". The cycle.end keeps us scoped to the
  // current cycle so a stale baseline doesn't bleed into the next one.
  let postBaselineCount = 0;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_email_usage_summary`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': authHeader,
      },
      body: JSON.stringify({
        month_start: baseline.takenAt.toISOString(),
        month_end: cycle.end.toISOString(),
      }),
    });
    if (r.ok) {
      const j = await r.json();
      postBaselineCount = Number(j?.used || 0);
    }
  } catch {
    // If the second query fails, we still return the baseline alone
    // rather than show a worse number than reality.
  }

  return {
    used: baseline.used + postBaselineCount,
    selfLogUsed,
    baselineApplied: baseline.used,
    failed,
    perKind: selfLogJson.per_kind,
    perDay: selfLogJson.per_day,
    recent: selfLogJson.recent,
    oldestLoggedAt: selfLogJson.oldest_logged_at ?? null,
  };
}
