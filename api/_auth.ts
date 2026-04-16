import { jwtVerify } from 'jose';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export async function verifySupabaseAuth(req: Request): Promise<Response | null> {
  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  if (!jwtSecret) return null;

  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: { message: 'Missing authentication' } }), {
      status: 401,
      headers: JSON_HEADERS,
    });
  }

  try {
    const token = authHeader.slice(7);
    const secret = new TextEncoder().encode(jwtSecret);
    await jwtVerify(token, secret);
    return null;
  } catch {
    return new Response(JSON.stringify({ error: { message: 'Invalid or expired token' } }), {
      status: 401,
      headers: JSON_HEADERS,
    });
  }
}
