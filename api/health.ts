export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  const checks: Record<string, string> = {};

  // 1. Check env vars are set (not their values)
  checks['SUPABASE_JWT_SECRET'] = process.env.SUPABASE_JWT_SECRET ? `set (${process.env.SUPABASE_JWT_SECRET.length} chars)` : 'MISSING';
  checks['SUPABASE_URL'] = process.env.SUPABASE_URL || 'fallback used';
  checks['SUPABASE_ANON_KEY'] = process.env.SUPABASE_ANON_KEY ? 'set' : 'fallback used';
  checks['VAPID_PUBLIC_KEY'] = process.env.VAPID_PUBLIC_KEY ? 'set' : 'fallback used';
  checks['VAPID_PRIVATE_KEY'] = process.env.VAPID_PRIVATE_KEY ? 'set' : 'fallback used';
  checks['EMAILJS_SERVICE_ID'] = process.env.EMAILJS_SERVICE_ID || 'fallback: service_9r3sap5';
  checks['EMAILJS_TEMPLATE_ID'] = process.env.EMAILJS_TEMPLATE_ID || 'fallback: template_vbxffkb';
  checks['EMAILJS_PUBLIC_KEY'] = process.env.EMAILJS_PUBLIC_KEY || 'fallback: Yv-mOZmcYpLll4olj';
  checks['EMAILJS_PRIVATE_KEY'] = process.env.EMAILJS_PRIVATE_KEY ? `set (${process.env.EMAILJS_PRIVATE_KEY.length} chars)` : 'MISSING';

  // 2. Test JWT verification with the auth header if provided
  const authHeader = req.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const parts = token.split('.');
    if (parts.length === 3) {
      try {
        const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        checks['token_exp'] = payload.exp ? new Date(payload.exp * 1000).toISOString() : 'no exp';
        checks['token_expired'] = payload.exp && payload.exp * 1000 < Date.now() ? 'YES - EXPIRED' : 'no (valid)';
        checks['token_sub'] = payload.sub ? `${payload.sub.slice(0, 8)}...` : 'none';
        checks['token_role'] = payload.role || 'none';
      } catch { checks['token_decode'] = 'failed to decode'; }
    }

    // Try actual verification
    try {
      const { jwtVerify } = await import('jose');
      const jwtSecret = process.env.SUPABASE_JWT_SECRET?.trim();
      if (jwtSecret) {
        const candidates = [new TextEncoder().encode(jwtSecret)];
        try {
          const bin = atob(jwtSecret);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          candidates.push(bytes);
        } catch { /* not base64 */ }

        let verified = false;
        let lastErr = '';
        for (const secret of candidates) {
          try {
            await jwtVerify(token, secret);
            verified = true;
            break;
          } catch (e) { lastErr = e instanceof Error ? e.message : String(e); }
        }
        checks['jwt_verify'] = verified ? 'PASS' : `FAIL: ${lastErr}`;
      }
    } catch (e) { checks['jwt_verify'] = `error: ${e}`; }
  } else {
    checks['auth_header'] = authHeader ? 'present but not Bearer' : 'NOT SENT';
  }

  // 3. Quick EmailJS connectivity test
  try {
    const emailRes = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service_id: 'test', template_id: 'test', user_id: 'test' }),
    });
    checks['emailjs_reachable'] = `yes (status ${emailRes.status})`;
  } catch (e) { checks['emailjs_reachable'] = `no: ${e}`; }

  return new Response(JSON.stringify(checks, null, 2), {
    headers: { 'Content-Type': 'application/json' },
  });
}
