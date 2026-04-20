import { jwtVerify } from 'jose';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

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

export async function verifySupabaseAuth(req: Request): Promise<Response | null> {
  const jwtSecret = process.env.SUPABASE_JWT_SECRET?.trim();
  if (!jwtSecret) {
    return new Response(JSON.stringify({ error: { message: 'Server authentication not configured' } }), {
      status: 500,
      headers: JSON_HEADERS,
    });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: { message: 'Missing authentication' } }), {
      status: 401,
      headers: JSON_HEADERS,
    });
  }

  const token = authHeader.slice(7);

  // Try the secret as raw UTF-8 bytes first, then as base64-decoded bytes
  const candidates: Uint8Array[] = [new TextEncoder().encode(jwtSecret)];
  const decoded = base64Decode(jwtSecret);
  if (decoded) candidates.push(decoded);

  let lastError = '';
  for (const secret of candidates) {
    try {
      await jwtVerify(token, secret);
      return null;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return new Response(JSON.stringify({ error: { message: `Invalid authentication token: ${lastError}` } }), {
    status: 401,
    headers: JSON_HEADERS,
  });
}
