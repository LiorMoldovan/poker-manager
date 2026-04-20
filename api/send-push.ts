import { verifySupabaseAuth } from './_auth';
import { createClient } from '@supabase/supabase-js';

export const config = { runtime: 'edge' };

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64UrlEncode(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concatBuffers(...bufs: ArrayBuffer[]): Uint8Array {
  const total = bufs.reduce((s, b) => s + b.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const buf of bufs) {
    result.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }
  return result;
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

  // Import via JWK — more reliable across runtimes than raw PKCS#8 DER construction
  const rawPrivate = base64UrlDecode(privateKeyBase64);
  const rawPublic = base64UrlDecode(publicKeyBase64);
  const x = base64UrlEncode(rawPublic.slice(1, 33));
  const y = base64UrlEncode(rawPublic.slice(33, 65));
  const d = base64UrlEncode(rawPrivate);

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x, y, d, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(unsignedToken)
  );

  const signature = base64UrlEncode(sig);
  return `${unsignedToken}.${signature}`;
}

async function encryptPayload(
  payload: string,
  p256dhKey: string,
  authSecret: string
): Promise<{ encrypted: Uint8Array; salt: Uint8Array; localPublicKey: Uint8Array }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const localKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const localPublicKeyRaw = await crypto.subtle.exportKey('raw', localKeyPair.publicKey);
  const localPublicKey = new Uint8Array(localPublicKeyRaw);

  const subscriberKey = await crypto.subtle.importKey(
    'raw', base64UrlDecode(p256dhKey), { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: subscriberKey }, localKeyPair.privateKey, 256
  );

  const authBuf = base64UrlDecode(authSecret);
  const ikm = await hkdf(new Uint8Array(sharedSecret), authBuf,
    concatBuffers(
      new TextEncoder().encode('WebPush: info\0').buffer,
      base64UrlDecode(p256dhKey).buffer,
      localPublicKeyRaw
    ).buffer, 32
  );

  const prk = await hkdf(ikm, salt.buffer,
    new TextEncoder().encode('Content-Encoding: aes128gcm\0').buffer, 16
  );

  const nonce = await hkdf(ikm, salt.buffer,
    new TextEncoder().encode('Content-Encoding: nonce\0').buffer, 12
  );

  const contentKey = await crypto.subtle.importKey('raw', prk, 'AES-GCM', false, ['encrypt']);
  const padded = concatBuffers(
    new TextEncoder().encode(payload).buffer,
    new Uint8Array([2]).buffer
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 },
    contentKey,
    padded
  );

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, padded.byteLength + 16);

  const header = concatBuffers(
    salt.buffer,
    recordSize.buffer,
    new Uint8Array([65]).buffer,
    localPublicKeyRaw
  );

  return {
    encrypted: concatBuffers(header.buffer, ciphertext),
    salt,
    localPublicKey,
  };
}

async function hkdf(
  ikm: Uint8Array | ArrayBuffer,
  salt: Uint8Array | ArrayBuffer,
  info: ArrayBuffer,
  length: number
): Promise<Uint8Array> {
  const ikmBuf = ikm instanceof Uint8Array ? ikm : new Uint8Array(ikm);
  const saltBuf = salt instanceof Uint8Array ? salt : new Uint8Array(salt);

  const prkKey = await crypto.subtle.importKey('raw', saltBuf.length > 0 ? saltBuf : new Uint8Array(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const prk = await crypto.subtle.sign('HMAC', prkKey, ikmBuf);

  const infoKey = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const infoBuf = concatBuffers(info, new Uint8Array([1]).buffer);
  const okm = await crypto.subtle.sign('HMAC', infoKey, infoBuf);

  return new Uint8Array(okm).slice(0, length);
}

async function sendPushToSubscription(
  sub: { endpoint: string; keys_p256dh: string; keys_auth: string },
  payload: string,
  vapidPublicKey: string,
  vapidPrivateKey: string,
  vapidSubject: string
): Promise<{ success: boolean; status?: number; gone?: boolean; error?: string }> {
  try {
    const url = new URL(sub.endpoint);
    const audience = `${url.protocol}//${url.host}`;

    const jwt = await createVapidJwt(audience, vapidSubject, vapidPrivateKey, vapidPublicKey);
    const { encrypted } = await encryptPayload(payload, sub.keys_p256dh, sub.keys_auth);

    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `vapid t=${jwt}, k=${vapidPublicKey}`,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'TTL': '86400',
      },
      body: encrypted,
    });

    if (res.status === 201) return { success: true, status: 201 };

    const errBody = await res.text().catch(() => '');
    return { success: false, status: res.status, gone: res.status === 410, error: errBody || `status ${res.status}` };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const authError = await verifySupabaseAuth(req);
  if (authError) return authError;

  // VAPID keys MUST match the applicationServerKey used by the client during pushManager.subscribe()
  // (hardcoded in App.tsx). Using different keys causes the push service to reject with 403.
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
      return new Response(JSON.stringify({ sent: 0, total: 0 }), { headers: JSON_HEADERS });
    }

    const payload = JSON.stringify({ title, body, url: notifUrl || '/', tag: `poker-${Date.now()}` });
    let sent = 0;
    const gone: string[] = [];
    const errors: string[] = [];

    for (const sub of subs) {
      const result = await sendPushToSubscription(
        sub, payload, vapidPublicKey, vapidPrivateKey, vapidSubject
      );
      if (result.success) sent++;
      if (!result.success) {
        // Clean up any subscription the push service rejects (410 Gone, 404 Not Found, 403 Forbidden)
        if (result.status && [404, 410, 403].includes(result.status)) {
          gone.push(sub.endpoint);
        }
        if (result.error) {
          errors.push(`${sub.player_name || 'unknown'}: ${result.status || 'ERR'} ${result.error.slice(0, 200)}`);
        }
      }
    }

    if (gone.length > 0) {
      await db.from('push_subscriptions').delete().in('endpoint', gone);
    }

    return new Response(JSON.stringify({ sent, total: subs.length, errors: errors.length > 0 ? errors : undefined }), { headers: JSON_HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Push notification error';
    return new Response(JSON.stringify({ error: { message } }), {
      status: 502, headers: JSON_HEADERS,
    });
  }
}
