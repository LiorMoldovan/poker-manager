import { verifySupabaseAuth } from './_auth';

// Run on Vercel Node.js Function (Fluid Compute) rather than Edge runtime:
// Edge functions enforce a hard 25s initial-response timeout, which kills
// Gemini 3.x thinking models on large 8-player forecast/summary prompts.
// Node.js Functions on Fluid Compute support up to 300s even on Hobby.
export const maxDuration = 120;

export async function POST(req: Request): Promise<Response> {
  const authError = await verifySupabaseAuth(req);
  if (authError) return authError;

  try {
    const { version, model, payload, apiKey: clientKey, groupId } = await req.json();

    // ── Per-group key resolution ──────────────────────────────────────
    // Priority:
    //   1. `apiKey` in body → the group has its own per-group key set
    //      in Settings → Services. Use it directly. Their billing.
    //   2. No body key, request is from the platform-owner group
    //      (`OWNER_GROUP_ID` env var) → fall back to the platform
    //      `GEMINI_API_KEY`. The platform owner pays for the platform.
    //   3. No body key, request is from any OTHER group → REJECT.
    //      Otherwise the platform owner's key silently funds every
    //      other group's AI usage (which was the v5.60.2-and-prior
    //      bug this gate exists to prevent).
    let apiKey: string | undefined;
    if (typeof clientKey === 'string' && clientKey.trim()) {
      apiKey = clientKey.trim();
    } else {
      const ownerGroupId = process.env.OWNER_GROUP_ID;
      if (ownerGroupId && groupId && groupId === ownerGroupId) {
        apiKey = process.env.GEMINI_API_KEY;
      } else {
        return new Response(JSON.stringify({
          error: {
            code: 'aiKeyRequired',
            message: 'This group has no Gemini API key configured. The group owner must add one in Settings → Services → API Keys.',
          },
        }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    if (!apiKey) {
      return new Response(JSON.stringify({ error: { message: 'GEMINI_API_KEY not configured. Set it in group settings.' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (!version || !model || !payload) {
      return new Response(JSON.stringify({ error: { message: 'Missing version, model, or payload' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const modelPath = model.startsWith('models/') ? model : `models/${model}`;
    const url = `https://generativelanguage.googleapis.com/${version}/${modelPath}:generateContent?key=${apiKey}`;

    // Per-attempt upstream timeout (24s): Node.js Fluid Compute gives 120s maxDuration
    // for the whole request, while a single healthy Flash call with thinkingBudget=1536
    // finishes in ~12-18s. Aborting a hung upstream model at 24s lets the client's
    // 5-model fallback chain cascade quickly instead of waiting 65s+ on a stuck model.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 24000);
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
      return new Response(JSON.stringify({
        error: { message: isAbort ? `Model ${model} timed out after 24s` : (fetchErr instanceof Error ? fetchErr.message : 'Upstream fetch failed') },
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    clearTimeout(timer);

    const data = await upstream.text();
    return new Response(data, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
        'x-ratelimit-limit': upstream.headers.get('x-ratelimit-limit') || '',
        'x-ratelimit-remaining': upstream.headers.get('x-ratelimit-remaining') || '',
        'x-ratelimit-reset': upstream.headers.get('x-ratelimit-reset') || '',
        'retry-after': upstream.headers.get('retry-after') || '',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Proxy error';
    return new Response(JSON.stringify({ error: { message } }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
