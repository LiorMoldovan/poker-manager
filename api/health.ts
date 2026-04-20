export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // If ?selftest=1, serve an HTML page that logs in and tests the API
  if (url.searchParams.get('selftest')) {
    const html = `<!DOCTYPE html>
<html><head><title>API Health Test</title>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
</head><body style="font-family:monospace;background:#1a1a2e;color:#e0e0e0;padding:2rem">
<h2>Push/Email API Diagnostic</h2>
<div id="log"></div>
<script>
const log = (msg, color) => {
  const d = document.getElementById('log');
  d.innerHTML += '<div style="color:'+(color||'#ccc')+'">'+msg+'</div>';
};
(async () => {
  const sb = supabase.createClient('https://ursjltxklmxmapfvkttj.supabase.co','sb_publishable_TzhEQmU6mX2n-utnOUAtwQ_zkGTR13j');
  
  // Check session
  log('1. Checking Supabase session...');
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    log('NO SESSION - not logged in. Trying refresh...', '#ff6b6b');
    const { data: refreshed } = await sb.auth.refreshSession();
    if (!refreshed.session) {
      log('NO SESSION after refresh. You need to log into the app first, then come back here.', '#ff6b6b');
      return;
    }
    log('Session refreshed!', '#4ecdc4');
  }
  
  const s = session || (await sb.auth.getSession()).data.session;
  const token = s?.access_token;
  log('Token: ' + (token ? token.slice(0,20) + '...' + ' (length: '+token.length+')' : 'NONE'), token ? '#4ecdc4' : '#ff6b6b');
  
  // Decode token
  if (token) {
    try {
      const parts = token.split('.');
      const payload = JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/')));
      const exp = new Date(payload.exp * 1000);
      const now = new Date();
      const diff = (payload.exp * 1000 - Date.now()) / 1000;
      log('Token exp: ' + exp.toISOString() + ' ('+Math.round(diff)+'s from now)');
      log('Token expired: ' + (diff < 0 ? 'YES' : 'NO'), diff < 0 ? '#ff6b6b' : '#4ecdc4');
      log('Token sub: ' + payload.sub);
      log('Token role: ' + payload.role);
    } catch(e) { log('Token decode error: '+e, '#ff6b6b'); }
  }
  
  // Test health endpoint with auth
  log('\\n2. Testing /api/health with auth token...');
  try {
    const r = await fetch('/api/health', { headers: token ? { Authorization: 'Bearer '+token } : {} });
    const j = await r.json();
    for (const [k,v] of Object.entries(j)) {
      const color = String(v).includes('FAIL') || String(v).includes('MISSING') || String(v).includes('EXPIRED') ? '#ff6b6b' : '#4ecdc4';
      log(k + ': ' + v, color);
    }
  } catch(e) { log('Health fetch error: '+e, '#ff6b6b'); }
  
  // Test send-push
  log('\\n3. Testing /api/send-push...');
  try {
    const r = await fetch('/api/send-push', { method:'POST', headers:{'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{})}, body:JSON.stringify({groupId:'test',title:'test',body:'test'}) });
    const t = await r.text();
    log('Status: '+r.status+' Body: '+t, r.ok ? '#4ecdc4' : (r.status===502 ? '#ffd93d' : '#ff6b6b'));
  } catch(e) { log('Push error: '+e, '#ff6b6b'); }
  
  // Test send-email
  log('\\n4. Testing /api/send-email (dry run)...');
  try {
    const r = await fetch('/api/send-email', { method:'POST', headers:{'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{})}, body:JSON.stringify({to:'test@test.com',subject:'test'}) });
    const t = await r.text();
    log('Status: '+r.status+' Body: '+t, r.ok ? '#4ecdc4' : (r.status===502 ? '#ffd93d' : '#ff6b6b'));
  } catch(e) { log('Email error: '+e, '#ff6b6b'); }
  
  log('\\nDone!', '#4ecdc4');
})();
</script></body></html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html' } });
  }

  const checks: Record<string, string> = {};
  checks['SUPABASE_JWT_SECRET'] = process.env.SUPABASE_JWT_SECRET ? `set (${process.env.SUPABASE_JWT_SECRET.length} chars)` : 'MISSING';
  checks['SUPABASE_URL'] = process.env.SUPABASE_URL || 'fallback used';
  checks['SUPABASE_ANON_KEY'] = process.env.SUPABASE_ANON_KEY ? 'set' : 'fallback used';
  checks['VAPID_PUBLIC_KEY'] = process.env.VAPID_PUBLIC_KEY ? 'set' : 'fallback used';
  checks['VAPID_PRIVATE_KEY'] = process.env.VAPID_PRIVATE_KEY ? 'set' : 'fallback used';
  checks['EMAILJS_SERVICE_ID'] = process.env.EMAILJS_SERVICE_ID || 'fallback: service_9r3sap5';
  checks['EMAILJS_TEMPLATE_ID'] = process.env.EMAILJS_TEMPLATE_ID || 'fallback: template_vbxffkb';
  checks['EMAILJS_PUBLIC_KEY'] = process.env.EMAILJS_PUBLIC_KEY || 'fallback: Yv-mOZmcYpLll4olj';
  checks['EMAILJS_PRIVATE_KEY'] = process.env.EMAILJS_PRIVATE_KEY ? `set (${process.env.EMAILJS_PRIVATE_KEY.length} chars)` : 'MISSING';

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
      } catch { checks['token_decode'] = 'failed'; }
    }
    try {
      const { jwtVerify } = await import('jose');
      const jwtSecret = process.env.SUPABASE_JWT_SECRET?.trim();
      if (jwtSecret) {
        const candidates = [new TextEncoder().encode(jwtSecret)];
        try { const b = atob(jwtSecret); const u = new Uint8Array(b.length); for (let i=0;i<b.length;i++) u[i]=b.charCodeAt(i); candidates.push(u); } catch {/* */}
        let verified = false; let lastErr = '';
        for (const secret of candidates) {
          try { await jwtVerify(token, secret); verified = true; break; } catch (e) { lastErr = e instanceof Error ? e.message : String(e); }
        }
        checks['jwt_verify'] = verified ? 'PASS' : `FAIL: ${lastErr}`;
      }
    } catch (e) { checks['jwt_verify'] = `error: ${e}`; }
  } else {
    checks['auth_header'] = authHeader ? 'present but not Bearer' : 'NOT SENT';
  }

  try {
    const emailRes = await fetch('https://api.emailjs.com/api/v1.0/email/send', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({service_id:'test',template_id:'test',user_id:'test'}) });
    checks['emailjs_reachable'] = `yes (status ${emailRes.status})`;
  } catch (e) { checks['emailjs_reachable'] = `no: ${e}`; }

  return new Response(JSON.stringify(checks, null, 2), { headers: { 'Content-Type': 'application/json' } });
}
