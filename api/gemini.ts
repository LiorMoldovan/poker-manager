import { verifySupabaseAuth } from './_auth';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

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

    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

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
