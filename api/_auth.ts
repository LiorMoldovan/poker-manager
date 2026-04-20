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

export async function verifySupabaseAuth(req: Request): Promise<Response | null> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: { message: 'Missing authentication' } }), {
      status: 401,
      headers: JSON_HEADERS,
    });
  }

  const token = authHeader.slice(7);

  // 1. Try JWKS verification (handles ES256, RS256, etc. automatically)
  try {
    await jwtVerify(token, JWKS);
    return null;
  } catch { /* JWKS failed — fall through to symmetric secret */ }

  // 2. Fallback: try symmetric HS256 verification with SUPABASE_JWT_SECRET
  const jwtSecret = process.env.SUPABASE_JWT_SECRET?.trim();
  if (jwtSecret) {
    const candidates: Uint8Array[] = [new TextEncoder().encode(jwtSecret)];
    const decoded = base64Decode(jwtSecret);
    if (decoded) candidates.push(decoded);

    for (const secret of candidates) {
      try {
        await jwtVerify(token, secret);
        return null;
      } catch { /* try next */ }
    }
  }

  return new Response(JSON.stringify({ error: { message: 'Invalid authentication token' } }), {
    status: 401,
    headers: JSON_HEADERS,
  });
}
