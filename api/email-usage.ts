import { verifySupabaseAuth } from './_auth';

export const config = { runtime: 'edge' };

const JSON_HEADERS = { 'Content-Type': 'application/json' };

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ursjltxklmxmapfvkttj.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_TzhEQmU6mX2n-utnOUAtwQ_zkGTR13j';

// Read-only summary endpoint backing the super-admin "EmailJS Usage" card
// in Settings → AI. Forwards the caller's JWT to Supabase REST so
// `auth.uid()` inside the SECURITY DEFINER RPC resolves correctly — no
// service role key needed. The RPC itself raises 'forbidden' for non-super
// admins, which we surface as 403.
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const authError = await verifySupabaseAuth(req);
  if (authError) return authError;

  const authHeader = req.headers.get('Authorization') || '';

  // Fetch EmailJS /history (last 7 days, the max retention on Free tier)
  // in parallel with our self-log. EmailJS's history is the only piece of
  // upstream truth we have access to — using it as a cross-check makes the
  // self-log defensible: if our number disagrees with theirs for the same
  // 7-day window, something is broken with our logger and we surface that
  // as a "⚠ logging gap" warning instead of pretending all is well.
  //
  // Free-tier note: 7-day window is a hard ceiling, so we still need our
  // self-log for the monthly quota bar. The `inSync` indicator only
  // covers the trailing 7 days; older data is "trust our log" by
  // necessity. Personal+ plans get 30 days, but the same code works.
  async function fetchEmailJsLast7Days(): Promise<{ available: boolean; count: number; failed: number; error?: string }> {
    const publicKey = process.env.EMAILJS_PUBLIC_KEY;
    const privateKey = process.env.EMAILJS_PRIVATE_KEY;
    if (!publicKey || !privateKey) {
      return { available: false, count: 0, failed: 0, error: 'EMAILJS_PRIVATE_KEY not configured' };
    }
    try {
      // count=200 is more than the Free-tier quota, so a single page covers
      // the whole 7-day window in every realistic case. Pagination is only
      // needed on Personal+ if the user is a heavy sender.
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
        return { available: false, count: 0, failed: 0, error: `EmailJS history ${r.status}: ${text.slice(0, 200)}` };
      }
      const json = await r.json() as {
        is_last_page?: boolean;
        rows?: Array<{ result?: number; created_at?: string }>;
      };
      const rows = Array.isArray(json.rows) ? json.rows : [];
      // Cutoff: 7 days ago, in case we ever upgrade to Personal+ and start
      // getting 30-day rows back — we still want the cross-check window
      // tied to the universal Free-tier minimum so the comparison stays
      // apples-to-apples. Result codes per docs: 1 = success, 2 = error.
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      let success = 0;
      let failed = 0;
      for (const row of rows) {
        const ts = row.created_at ? Date.parse(row.created_at) : NaN;
        if (!Number.isFinite(ts) || ts < sevenDaysAgo) continue;
        if (row.result === 1) success++;
        else if (row.result === 2) failed++;
      }
      return { available: true, count: success, failed };
    } catch (err) {
      return { available: false, count: 0, failed: 0, error: String(err).slice(0, 200) };
    }
  }

  try {
    // Parallel: our self-log + EmailJS upstream truth. One request budget,
    // one network round-trip. EmailJS rate-limit is 1 req/sec which is fine
    // for an admin viewing the card.
    const [rpc, emailjs] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/rpc/get_email_usage_summary`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': authHeader,
        },
        body: JSON.stringify({}),
      }),
      fetchEmailJsLast7Days(),
    ]);

    if (!rpc.ok) {
      const text = await rpc.text();
      // Map the RPC's 'forbidden' raise to a friendlier 403 for the client.
      if (rpc.status === 400 || rpc.status === 403) {
        return new Response(JSON.stringify({ error: { message: text || 'forbidden' } }), {
          status: 403, headers: JSON_HEADERS,
        });
      }
      return new Response(text, { status: rpc.status, headers: JSON_HEADERS });
    }

    const data = await rpc.json();

    // First of next month, UTC, to match how EmailJS counts billing periods.
    // Doing the math on the server keeps every client agreeing on the same
    // reset date regardless of local timezone.
    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const resetDate = next.toISOString().slice(0, 10);

    // EMAILJS_MONTHLY_CAP is a Vercel env var the deployment owner sets to
    // match their actual EmailJS plan. EmailJS doesn't expose the quota
    // itself via API (only history records), so the cap stays operator-set.
    // When the env is missing we fall back to the documented Free-tier
    // default of 200 — surfaced explicitly in the UI so nobody mistakes the
    // cap for a live read.
    const limitRaw = process.env.EMAILJS_MONTHLY_CAP;
    const limit = Math.max(1, Number(limitRaw || 200));
    const limitSource: 'env' | 'default' = limitRaw ? 'env' : 'default';
    const used = Number(data?.used || 0);
    const oldestLogged: string | null = data?.oldest_logged_at || null;

    // Compute our own last-7-days count from the per_day breakdown so the
    // EmailJS comparison is window-aligned. per_day is current-month-only,
    // which is fine: the 7-day window can only span the current and the
    // previous month, and on a fresh month the older days simply contribute
    // zero — we still get a defensible "is the logger working today" check.
    const perDay = (data?.per_day || []) as Array<{ date: string; count: number }>;
    const sevenDaysAgoIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const ourLast7d = perDay
      .filter(d => typeof d.date === 'string' && d.date >= sevenDaysAgoIso)
      .reduce((s, d) => s + (Number(d.count) || 0), 0);

    // inSync: |ourLast7d - emailjs| <= 1. The slack of 1 absorbs benign
    // races (an email sent in the last second that landed in one source
    // but not the other yet). Anything bigger is a real divergence and
    // gets surfaced as a warning in the UI.
    let inSync: 'unknown' | 'ok' | 'gap' = 'unknown';
    if (emailjs.available) {
      inSync = Math.abs(ourLast7d - emailjs.count) <= 1 ? 'ok' : 'gap';
    }

    return new Response(JSON.stringify({
      used,
      limit,
      limitSource,
      remaining: Math.max(limit - used, 0),
      resetDate,
      // ISO timestamp of the oldest row in `email_usage_log`, or null if
      // the table is empty. The UI uses this to render an honest
      // "Logging started: <date>" caption so users know historical sends
      // aren't counted.
      loggingSince: oldestLogged,
      perKind: data?.per_kind || {},
      perDay,
      recent: data?.recent || [],
      failed: Number(data?.failed || 0),
      // EmailJS upstream cross-check (last 7 days, the max Free-tier
      // retention). null fields mean we couldn't reach EmailJS or the
      // private key isn't configured — the UI degrades gracefully.
      emailjsAvailable: emailjs.available,
      emailjsLast7d: emailjs.available ? emailjs.count : null,
      emailjsLast7dFailed: emailjs.available ? emailjs.failed : null,
      emailjsError: emailjs.error || null,
      ourLast7d,
      inSync,
    }), { status: 200, headers: JSON_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: { message: String(err) } }), {
      status: 500, headers: JSON_HEADERS,
    });
  }
}
