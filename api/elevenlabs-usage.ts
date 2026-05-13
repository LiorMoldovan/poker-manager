import { verifySupabaseAuth } from './_auth';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const authError = await verifySupabaseAuth(req);
  if (authError) return authError;

  try {
    const { apiKey: clientKey, groupId } = await req.json();

    // See `api/gemini.ts` for the full key-resolution rationale; same gate.
    let apiKey: string | undefined;
    if (typeof clientKey === 'string' && clientKey.trim()) {
      apiKey = clientKey.trim();
    } else {
      const ownerGroupId = process.env.OWNER_GROUP_ID;
      if (ownerGroupId && groupId && groupId === ownerGroupId) {
        apiKey = process.env.ELEVENLABS_API_KEY;
      } else {
        return new Response(JSON.stringify({
          error: {
            code: 'ttsKeyRequired',
            message: 'This group has no ElevenLabs API key configured. The group owner must add one in Settings → Services → API Keys.',
          },
        }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    if (!apiKey) {
      return new Response(JSON.stringify({ error: { message: 'ELEVENLABS_API_KEY not configured. Set it in group settings.' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const upstream = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
      headers: { 'xi-api-key': apiKey },
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
