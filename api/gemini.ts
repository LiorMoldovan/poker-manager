import { jwtVerify, createRemoteJWKSet } from 'jose';

// Run on Vercel Node.js Function (Fluid Compute) rather than Edge runtime:
// Edge functions enforce a hard 25s initial-response timeout, which kills
// Gemini 3.x thinking models on large 8-player forecast/summary prompts.
// Node.js Functions on Fluid Compute support up to 300s even on Hobby.
// IMPORTANT: Because package.json has `"type": "module"`, Node.js functions
// must not use extensionless relative imports (like `./_auth`) and must use
// the Node `(req, res)` default export handler signature (like `api/github-backup.ts`).
export const config = {
  maxDuration: 120,
};

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ursjltxklmxmapfvkttj.supabase.co';
const JWKS = createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`));

function base64Decode(str: string): Uint8Array | null {
  try {
    const buf = Buffer.from(str, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch {
    return null;
  }
}

function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  const val = headers[lower] ?? headers[name];
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return val[0];
  return undefined;
}

async function verifyNodeAuth(
  headers: Record<string, string | string[] | undefined>,
): Promise<{ status: number; message: string } | null> {
  const workerHeader = getHeader(headers, 'x-worker-secret');
  const expected = process.env.WORKER_INTERNAL_SECRET;
  if (workerHeader && expected && workerHeader === expected) {
    return null;
  }
  if (workerHeader && expected && workerHeader !== expected) {
    return { status: 401, message: 'Invalid worker secret' };
  }

  const authHeader = getHeader(headers, 'authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { status: 401, message: 'Missing authentication' };
  }

  const token = authHeader.slice(7);

  try {
    await jwtVerify(token, JWKS);
    return null;
  } catch {
    /* JWKS failed — fall through to symmetric secret */
  }

  const jwtSecret = process.env.SUPABASE_JWT_SECRET?.trim();
  if (jwtSecret) {
    const candidates: Uint8Array[] = [new TextEncoder().encode(jwtSecret)];
    const decoded = base64Decode(jwtSecret);
    if (decoded) candidates.push(decoded);

    for (const secret of candidates) {
      try {
        await jwtVerify(token, secret);
        return null;
      } catch {
        /* try next */
      }
    }
  }

  return { status: 401, message: 'Invalid authentication token' };
}

export default async function handler(
  req: {
    method?: string;
    headers: Record<string, string | string[] | undefined>;
    body?: Record<string, unknown> | string;
  },
  res: {
    setHeader(name: string, value: string): void;
    status(code: number): { json(data: unknown): void; send(data: string): void };
  },
) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  const authError = await verifyNodeAuth(req.headers || {});
  if (authError) {
    return res.status(authError.status).json({ error: { message: authError.message } });
  }

  try {
    const parsedBody =
      typeof req.body === 'string'
        ? (JSON.parse(req.body || '{}') as Record<string, unknown>)
        : (req.body || {});

    const { version, model, payload, apiKey: clientKey, groupId } = parsedBody as {
      version?: string;
      model?: string;
      payload?: unknown;
      apiKey?: string;
      groupId?: string;
    };

    // ── Per-group key resolution ──────────────────────────────────────
    let apiKey: string | undefined;
    if (typeof clientKey === 'string' && clientKey.trim()) {
      apiKey = clientKey.trim();
    } else {
      const ownerGroupId = process.env.OWNER_GROUP_ID;
      if (ownerGroupId && groupId && groupId === ownerGroupId) {
        apiKey = process.env.GEMINI_API_KEY;
      } else {
        return res.status(403).json({
          error: {
            code: 'aiKeyRequired',
            message: 'This group has no Gemini API key configured. The group owner must add one in Settings → Services → API Keys.',
          },
        });
      }
    }
    if (!apiKey) {
      return res.status(500).json({ error: { message: 'GEMINI_API_KEY not configured. Set it in group settings.' } });
    }
    if (!version || !model || !payload) {
      return res.status(400).json({ error: { message: 'Missing version, model, or payload' } });
    }

    const modelPath = model.startsWith('models/') ? model : `models/${model}`;
    const url = `https://generativelanguage.googleapis.com/${version}/${modelPath}:generateContent?key=${apiKey}`;

    // Per-attempt upstream timeout (45s): Node.js Fluid Compute gives 120s maxDuration
    // for the whole request. 45s gives thinking models (especially Gemini 3 with
    // thinkingBudget) plenty of room to reason and output 8-player forecasts without
    // getting killed mid-flight.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    let upstream: Response;
    try {
      upstream = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } catch (fetchErr) {
      clearTimeout(timer);
      const isAbort = fetchErr instanceof Error && fetchErr.name === 'AbortError';
      return res.status(503).json({
        error: { message: isAbort ? `Model ${model} timed out after 24s` : (fetchErr instanceof Error ? fetchErr.message : 'Upstream fetch failed') },
      });
    }
    clearTimeout(timer);

    const data = await upstream.text();
    res.setHeader('Content-Type', upstream.headers.get('Content-Type') || 'application/json');
    const rlLimit = upstream.headers.get('x-ratelimit-limit');
    const rlRem = upstream.headers.get('x-ratelimit-remaining');
    const rlReset = upstream.headers.get('x-ratelimit-reset');
    const retryAfter = upstream.headers.get('retry-after');
    if (rlLimit) res.setHeader('x-ratelimit-limit', rlLimit);
    if (rlRem) res.setHeader('x-ratelimit-remaining', rlRem);
    if (rlReset) res.setHeader('x-ratelimit-reset', rlReset);
    if (retryAfter) res.setHeader('retry-after', retryAfter);

    return res.status(upstream.status).send(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Proxy error';
    return res.status(502).json({ error: { message } });
  }
}
