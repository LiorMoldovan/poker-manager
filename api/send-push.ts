import { verifySupabaseAuth } from './_auth';
import { createClient } from '@supabase/supabase-js';

export const config = { runtime: 'edge' };

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function base64UrlDecode(str: string): Uint8Array {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4 !== 0) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64UrlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concatBuffers(...bufs: (ArrayBuffer | Uint8Array)[]): Uint8Array {
  const total = bufs.reduce((s, b) => s + b.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const buf of bufs) {
    result.set(buf instanceof Uint8Array ? buf : new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }
  return result;
}

// Web Crypto ECDSA may return DER-encoded signatures on some runtimes.
// JWT ES256 requires IEEE P1363 format (r || s, each 32 bytes).
function ensureP1363Signature(sig: ArrayBuffer): Uint8Array {
  const raw = new Uint8Array(sig);
  if (raw.length === 64) return raw;
  if (raw.length > 64 && raw[0] === 0x30) {
    let pos = 2;
    if (raw[1] & 0x80) pos += (raw[1] & 0x7f);
    const r = extractDerInt(raw, pos);
    pos += 2 + raw[pos + 1];
    const s = extractDerInt(raw, pos);
    return concatBuffers(padTo32(r), padTo32(s));
  }
  return raw;
}

function extractDerInt(buf: Uint8Array, offset: number): Uint8Array {
  const len = buf[offset + 1];
  const start = offset + 2;
  const value = buf.slice(start, start + len);
  return value[0] === 0 ? value.slice(1) : value;
}

function padTo32(buf: Uint8Array): Uint8Array {
  if (buf.length === 32) return buf;
  if (buf.length > 32) return buf.slice(buf.length - 32);
  const padded = new Uint8Array(32);
  padded.set(buf, 32 - buf.length);
  return padded;
}

async function createVapidJwt(
  audience: string,
  subject: string,
  privateKeyBase64: string,
  publicKeyBase64: string
): Promise<string> {
  const header = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const now = Math.floor(Date.now() / 1000);
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({
    aud: audience,
    exp: now + 43200,
    sub: subject,
  })));
  const unsignedToken = `${header}.${payload}`;

  const rawPrivate = base64UrlDecode(privateKeyBase64);
  const rawPublic = base64UrlDecode(publicKeyBase64);
  const x = base64UrlEncode(rawPublic.slice(1, 33));
  const y = base64UrlEncode(rawPublic.slice(33, 65));
  const d = base64UrlEncode(rawPrivate);

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x, y, d },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  const sigRaw = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(unsignedToken)
  );

  const sigP1363 = ensureP1363Signature(sigRaw);
  return `${unsignedToken}.${base64UrlEncode(sigP1363)}`;
}

async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number
): Promise<Uint8Array> {
  const saltKey = await crypto.subtle.importKey(
    'raw', salt.length > 0 ? salt : new Uint8Array(32),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const prk = new Uint8Array(await crypto.subtle.sign('HMAC', saltKey, ikm));
  const infoKey = await crypto.subtle.importKey(
    'raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const okm = new Uint8Array(await crypto.subtle.sign('HMAC', infoKey, concatBuffers(info, new Uint8Array([1]))));
  return okm.slice(0, length);
}

async function encryptPayload(
  payload: string,
  p256dhKey: string,
  authSecret: string
): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const localKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  );
  const localPublicKeyRaw = new Uint8Array(
    await crypto.subtle.exportKey('raw', localKeyPair.publicKey)
  );

  const subscriberKeyBytes = base64UrlDecode(p256dhKey);
  const subscriberKey = await crypto.subtle.importKey(
    'raw', subscriberKeyBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );

  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: subscriberKey }, localKeyPair.privateKey, 256
    )
  );

  const authBuf = base64UrlDecode(authSecret);
  const ikmInfo = concatBuffers(
    new TextEncoder().encode('WebPush: info\0'),
    subscriberKeyBytes,
    localPublicKeyRaw
  );
  const ikm = await hkdf(sharedSecret, authBuf, ikmInfo, 32);

  const cekInfo = new Uint8Array(new TextEncoder().encode('Content-Encoding: aes128gcm\0'));
  const nonceInfo = new Uint8Array(new TextEncoder().encode('Content-Encoding: nonce\0'));
  const cek = await hkdf(ikm, salt, cekInfo, 16);
  const nonce = await hkdf(ikm, salt, nonceInfo, 12);

  const contentKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const plaintext = concatBuffers(new TextEncoder().encode(payload), new Uint8Array([2]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, contentKey, plaintext)
  );

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, plaintext.byteLength + 16);

  return concatBuffers(
    salt,
    rs,
    new Uint8Array([65]),
    localPublicKeyRaw,
    ciphertext
  );
}

type SubDetail = {
  player: string;
  type: string;
  status: number | string;
  ok: boolean;
  log: string[];
};

function classifyEndpoint(ep: string): string {
  if (ep.includes('fcm.googleapis.com') || ep.includes('firebase')) return 'FCM';
  if (ep.includes('mozilla')) return 'Mozilla';
  if (ep.includes('notify.windows.com')) return 'WNS';
  if (ep.includes('push.apple.com')) return 'APNs';
  return 'Other';
}

async function sendPushToSubscription(
  sub: { endpoint: string; keys_p256dh: string; keys_auth: string; player_name: string | null },
  payload: string,
  vapidPublicKey: string,
  vapidPrivateKey: string,
  vapidSubject: string
): Promise<SubDetail> {
  const type = classifyEndpoint(sub.endpoint);
  const log: string[] = [];
  const t0 = Date.now();

  try {
    const url = new URL(sub.endpoint);
    const audience = `${url.protocol}//${url.host}`;
    log.push(`aud=${audience}`);
    log.push(`p256dh=${sub.keys_p256dh.length}ch auth=${sub.keys_auth.length}ch`);

    log.push('jwt...');
    const jwt = await createVapidJwt(audience, vapidSubject, vapidPrivateKey, vapidPublicKey);
    log.push(`jwt=${jwt.length}ch sig_part=${jwt.split('.')[2].length}ch`);

    log.push('encrypt...');
    const encrypted = await encryptPayload(payload, sub.keys_p256dh, sub.keys_auth);
    log.push(`body=${encrypted.byteLength}B`);

    log.push('fetch...');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `vapid t=${jwt}, k=${vapidPublicKey}`,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(encrypted.byteLength),
        'TTL': '86400',
        'Urgency': 'high',
      },
      body: encrypted,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const resBody = await res.text().catch(() => '');
    const elapsed = Date.now() - t0;
    log.push(`${res.status} ${elapsed}ms`);
    if (resBody) log.push(`resp=${resBody.slice(0, 150)}`);

    const resLocation = res.headers.get('location');
    if (resLocation) log.push(`location=${resLocation}`);

    const ok = res.status >= 200 && res.status < 300;
    return {
      player: sub.player_name || '?',
      type,
      status: res.status,
      ok,
      log,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const elapsed = Date.now() - t0;
    log.push(`ERR ${elapsed}ms: ${msg}`);
    return { player: sub.player_name || '?', type, status: msg.slice(0, 50), ok: false, log };
  }
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const authError = await verifySupabaseAuth(req);
  if (authError) return authError;

  const vapidPublicKey = 'BIyHc2Q3XXbAYl1DgPRpqHZGJVM4i38ElcKYpeBib5RXVAUKSiG7IxZ-ZJPyt1UWokY_saRldY-CY54UXnvZbH8';
  const vapidPrivateKey = '39mPz53FHNkirEA3utU_d99xnPsKYBZM2B3lSRukUxg';
  const vapidSubject = 'mailto:pokermanager.app@gmail.com';

  try {
    const { groupId, title, body, targetPlayerNames, url: notifUrl } = await req.json();

    if (!groupId || !title || !body) {
      return new Response(JSON.stringify({ error: { message: 'Missing groupId, title, or body' } }), {
        status: 400, headers: JSON_HEADERS,
      });
    }

    const supabaseUrl = process.env.SUPABASE_URL || 'https://ursjltxklmxmapfvkttj.supabase.co';
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || 'sb_publishable_TzhEQmU6mX2n-utnOUAtwQ_zkGTR13j';
    const authHeader = req.headers.get('Authorization') || '';
    const db = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    let query = db.from('push_subscriptions').select('endpoint, keys_p256dh, keys_auth, player_name').eq('group_id', groupId);
    if (targetPlayerNames && targetPlayerNames.length > 0) {
      query = query.in('player_name', targetPlayerNames);
    }

    const { data: subs, error } = await query;
    if (error) throw new Error(`DB error: ${error.message}`);
    if (!subs || subs.length === 0) {
      return new Response(JSON.stringify({ sent: 0, total: 0, details: [] }), { headers: JSON_HEADERS });
    }

    const INVALID_ENDPOINT_PATTERNS = ['permanently-removed', 'invalid', 'localhost', 'example.com'];

    const validSubs = subs.filter(sub => {
      const dominated = INVALID_ENDPOINT_PATTERNS.some(p => sub.endpoint.includes(p));
      return !dominated;
    });
    const invalidEndpoints = subs.filter(sub => !validSubs.includes(sub)).map(s => s.endpoint);

    const payload = JSON.stringify({ title, body, url: notifUrl || '/', tag: `poker-${Date.now()}` });
    let sent = 0;
    const gone: string[] = [...invalidEndpoints];
    const details: SubDetail[] = [];

    for (const ep of invalidEndpoints) {
      const sub = subs.find(s => s.endpoint === ep);
      details.push({ player: sub?.player_name || '?', type: 'Invalid', status: 'stale endpoint', ok: false, log: [`Removed: ${ep.slice(0, 60)}`] });
    }

    for (const sub of validSubs) {
      const result = await sendPushToSubscription(
        sub, payload, vapidPublicKey, vapidPrivateKey, vapidSubject
      );
      details.push(result);
      if (result.ok) sent++;
      if (!result.ok && typeof result.status === 'number' && [404, 410].includes(result.status)) {
        gone.push(sub.endpoint);
      }
      if (!result.ok && typeof result.status === 'string') {
        gone.push(sub.endpoint);
      }
    }

    if (gone.length > 0) {
      await db.from('push_subscriptions').delete().in('endpoint', gone);
    }

    return new Response(JSON.stringify({ sent, total: subs.length, details }), { headers: JSON_HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Push notification error';
    return new Response(JSON.stringify({ error: { message } }), {
      status: 502, headers: JSON_HEADERS,
    });
  }
}
