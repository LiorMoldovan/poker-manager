import { verifySupabaseAuth } from './_auth';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const authError = await verifySupabaseAuth(req);
  if (authError) return authError;

  try {
    const { version = 'v1beta', apiKey: clientKey, groupId } = await req.json();

    // See `api/gemini.ts` for the full key-resolution rationale; same gate.
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

    const url = `https://generativelanguage.googleapis.com/${version}/models?key=${apiKey}`;
    const upstream = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });

    const data = await upstream.text();
    return new Response(data, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Proxy error';
    return new Response(JSON.stringify({ error: { message } }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
