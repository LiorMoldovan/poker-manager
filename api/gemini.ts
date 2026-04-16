import { verifySupabaseAuth } from './_auth';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const authError = await verifySupabaseAuth(req);
  if (authError) return authError;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: { message: 'GEMINI_API_KEY not configured' } }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const { version, model, payload } = await req.json();
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
