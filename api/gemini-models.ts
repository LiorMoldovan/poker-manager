import { verifySupabaseAuth } from './_auth';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const authError = await verifySupabaseAuth(req);
  if (authError) return authError;

  try {
    const { searchParams } = new URL(req.url);
    const version = searchParams.get('version') || 'v1beta';
    const clientKey = searchParams.get('apiKey');
    const apiKey = clientKey || process.env.GEMINI_API_KEY;
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
