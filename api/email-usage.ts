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

  try {
    const rpc = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_email_usage_summary`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': authHeader,
      },
      body: JSON.stringify({}),
    });

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
    // match their actual EmailJS plan; it's NOT fetched from EmailJS (the
    // free tier has no usage API). When the env is missing we fall back to
    // the documented Free-tier default of 200 — and the UI surfaces this
    // explicitly so nobody mistakes the cap for a live read from EmailJS.
    const limitRaw = process.env.EMAILJS_MONTHLY_CAP;
    const limit = Math.max(1, Number(limitRaw || 200));
    const limitSource: 'env' | 'default' = limitRaw ? 'env' : 'default';
    const used = Number(data?.used || 0);
    const oldestLogged: string | null = data?.oldest_logged_at || null;

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
      perDay: data?.per_day || [],
      recent: data?.recent || [],
      failed: Number(data?.failed || 0),
    }), { status: 200, headers: JSON_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: { message: String(err) } }), {
      status: 500, headers: JSON_HEADERS,
    });
  }
}
