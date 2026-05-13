import { verifySupabaseAuth } from './_auth';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const authError = await verifySupabaseAuth(req);
  if (authError) return authError;

  try {
    const { voiceId, outputFormat, payload, apiKey: clientKey, groupId } = await req.json();

    // See `api/gemini.ts` for the full key-resolution rationale; same gate.
    // ElevenLabs Free tier is even tighter than Gemini (10k chars/mo) so
    // gating fallback to the platform-owner group is doubly important.
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
    if (!voiceId || !payload) {
      return new Response(JSON.stringify({ error: { message: 'Missing voiceId or payload' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const format = outputFormat || 'mp3_22050_32';
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${format}`;

    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': apiKey,
      },
      body: JSON.stringify(payload),
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      return new Response(errText, {
        status: upstream.status,
        headers: { 'Content-Type': upstream.headers.get('Content-Type') || 'application/json' },
      });
    }

    const audioData = await upstream.arrayBuffer();
    return new Response(audioData, {
      status: 200,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') || 'audio/mpeg',
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
