import { jwtVerify, createRemoteJWKSet } from 'jose';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ursjltxklmxmapfvkttj.supabase.co';
const JWKS = createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`));

function base64Decode(str: string): Uint8Array | null {
  try {
    const bin = atob(str);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

// Result shape so callers can branch on the auth path. The worker auth
// path needs to know it's the worker so it can switch the DB client to
// service-role (the worker has no auth.uid() to satisfy RLS with).
export type AuthResult =
  | { ok: true; mode: 'user' }
  | { ok: true; mode: 'worker' }
  | { ok: false; response: Response };

// Existing entry point — kept for callers that don't care about the
// distinction between user-JWT and worker-secret. Returns null on
// success (both auth paths) and a Response on failure.
export async function verifySupabaseAuth(req: Request): Promise<Response | null> {
  const result = await verifyAuth(req);
  return result.ok ? null : result.response;
}

// Richer entry point that distinguishes the auth path. Used by send-push
// and send-email to pick the right Supabase client (user-JWT-bound vs
// service-role) for downstream queries.
export async function verifyAuth(req: Request): Promise<AuthResult> {
  // ── Worker path: shared secret in X-Worker-Secret header ───────────
  // Set by:
  //   * pg_net trigger (fn_http_dispatch_notification_job) on every
  //     notification_jobs INSERT
  //   * pg_cron sweep (fn_sweep_pending_notification_jobs) every minute
  //   * /api/notification-worker when it forwards to /api/send-push
  //     and /api/send-email
  // The expected value is WORKER_INTERNAL_SECRET in the Vercel env. The
  // matching value lives in the database GUC app.notification_worker_secret
  // and is checked by claim/complete_notification_job_internal RPCs.
  const workerHeader = req.headers.get('X-Worker-Secret');
  const expected = process.env.WORKER_INTERNAL_SECRET;
  if (workerHeader && expected && workerHeader === expected) {
    return { ok: true, mode: 'worker' };
  }
  // If the header was sent but didn't match, reject explicitly rather
  // than falling through to the JWT path — a wrong secret is more
  // diagnostically useful than a generic "Missing authentication".
  if (workerHeader && expected && workerHeader !== expected) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: { message: 'Invalid worker secret' } }), {
        status: 401, headers: JSON_HEADERS,
      }),
    };
  }

  // ── User path: Bearer JWT ──────────────────────────────────────────
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return {
      ok: false,
      response: new Response(JSON.stringify({ error: { message: 'Missing authentication' } }), {
        status: 401, headers: JSON_HEADERS,
      }),
    };
  }

  const token = authHeader.slice(7);

  try {
    await jwtVerify(token, JWKS);
    return { ok: true, mode: 'user' };
  } catch { /* JWKS failed — fall through to symmetric secret */ }

  const jwtSecret = process.env.SUPABASE_JWT_SECRET?.trim();
  if (jwtSecret) {
    const candidates: Uint8Array[] = [new TextEncoder().encode(jwtSecret)];
    const decoded = base64Decode(jwtSecret);
    if (decoded) candidates.push(decoded);

    for (const secret of candidates) {
      try {
        await jwtVerify(token, secret);
        return { ok: true, mode: 'user' };
      } catch { /* try next */ }
    }
  }

  return {
    ok: false,
    response: new Response(JSON.stringify({ error: { message: 'Invalid authentication token' } }), {
      status: 401, headers: JSON_HEADERS,
    }),
  };
}
