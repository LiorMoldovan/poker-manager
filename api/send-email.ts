import { verifySupabaseAuth } from './_auth';

export const config = { runtime: 'edge' };

const JSON_HEADERS = { 'Content-Type': 'application/json' };

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ursjltxklmxmapfvkttj.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_TzhEQmU6mX2n-utnOUAtwQ_zkGTR13j';

// Mask "lior.m@gmail.com" → "li***@g***.com" so the audit log isn't a PII
// goldmine if the DB is ever leaked. Keeping the first two local-part chars
// + first domain char is enough to disambiguate which group member an email
// was for, without exposing the address itself.
function maskRecipient(email: string): string {
  if (!email || !email.includes('@')) return '***';
  const [local, domain] = email.split('@');
  const localMasked = local.length <= 2 ? `${local[0] ?? '*'}*` : `${local.slice(0, 2)}***`;
  if (!domain) return `${localMasked}@***`;
  const dotIdx = domain.indexOf('.');
  if (dotIdx <= 0) return `${localMasked}@${domain[0] ?? '*'}***`;
  return `${localMasked}@${domain[0]}***${domain.slice(dotIdx)}`;
}

// Best-effort write to email_usage_log via the SECURITY DEFINER RPC.
// We forward the caller's JWT so auth.uid() inside the RPC resolves
// correctly and we don't need the service role key. Failure here is
// non-fatal: we never want a missing log row to block an email that
// already went out. Console.error makes localhost dev investigations
// possible without crashing prod.
async function logEmailSend(
  authHeader: string,
  groupId: string | null,
  recipientFull: string,
  kind: string,
  subject: string,
  success: boolean,
  httpStatus: number,
  errorMessage: string | null,
  templateId: string | null,
): Promise<void> {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/log_email_send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': authHeader,
      },
      body: JSON.stringify({
        p_group_id: groupId,
        p_recipient_masked: maskRecipient(recipientFull),
        p_kind: kind,
        p_subject: subject?.slice(0, 200) ?? '',
        p_success: success,
        p_http_status: httpStatus,
        p_error_message: errorMessage?.slice(0, 500) ?? null,
        p_template_id: templateId,
      }),
    });
  } catch (err) {
    console.error('[send-email] log_email_send failed:', err);
  }
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const authError = await verifySupabaseAuth(req);
  if (authError) return authError;

  const authHeader = req.headers.get('Authorization') || '';

  try {
    const body = await req.json();
    const { to, subject, groupId, kind } = body;

    // ── Owner-group enforcement ──────────────────────────────────────
    // EmailJS is one shared account for the whole deployment. We block
    // every group that isn't the deployment owner's so they can't drain
    // our 200/mo Free quota. The matching client-side check in
    // `apiProxy.ts` short-circuits before reaching the network; this
    // 403 is the defense-in-depth backstop.
    const ownerGroupId = process.env.OWNER_GROUP_ID;
    if (!ownerGroupId) {
      // Fail closed: never default to "everyone allowed" if the env was
      // forgotten. Clear error so Vercel logs surface it immediately.
      return new Response(JSON.stringify({ error: { message: 'OWNER_GROUP_ID env not configured' } }), {
        status: 500, headers: JSON_HEADERS,
      });
    }
    if (!groupId || groupId !== ownerGroupId) {
      return new Response(JSON.stringify({ error: { code: 'emailDisabled', message: 'Email sending is disabled for this group' } }), {
        status: 403, headers: JSON_HEADERS,
      });
    }

    const serviceId = process.env.EMAILJS_SERVICE_ID || 'service_9r3sap5';
    const publicKey = process.env.EMAILJS_PUBLIC_KEY || 'Yv-mOZmcYpLll4olj';
    const privateKey = process.env.EMAILJS_PRIVATE_KEY || '';

    if (!serviceId || !publicKey) {
      return new Response(JSON.stringify({ error: { message: 'EmailJS not configured (missing env vars)' } }), {
        status: 500, headers: JSON_HEADERS,
      });
    }

    if (!to || !subject) {
      return new Response(JSON.stringify({ error: { message: 'Missing required fields: to, subject' } }), {
        status: 400, headers: JSON_HEADERS,
      });
    }

    const isBroadcast = !!body.message;
    const templateId = isBroadcast
      ? (process.env.EMAILJS_BROADCAST_TEMPLATE_ID || 'template_broadcast')
      : (process.env.EMAILJS_TEMPLATE_ID || 'template_vbxffkb');

    const templateParams: Record<string, string> = isBroadcast
      ? {
          to_email: to,
          subject,
          message: body.message || '',
          sender_name: body.senderName || 'Poker Manager',
        }
      : {
          to_email: to,
          subject,
          player_name: body.playerName || '',
          reporter_name: body.reporterName || 'שחקן',
          amount: body.amount != null ? String(Math.round(Number(body.amount))) : '?',
          game_date: body.gameDate || '',
          pay_link: body.payLink || '',
        };

    const buildPayload = (tplId: string, params: Record<string, string>) => {
      const p: Record<string, unknown> = {
        service_id: serviceId,
        template_id: tplId,
        user_id: publicKey,
        template_params: params,
      };
      if (privateKey) p.accessToken = privateKey;
      return p;
    };

    const sendEmail = async (payload: Record<string, unknown>) => {
      return fetch('https://api.emailjs.com/api/v1.0/email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'origin': 'https://poker-manager-blond.vercel.app' },
        body: JSON.stringify(payload),
      });
    };

    let res = await sendEmail(buildPayload(templateId, templateParams));
    let usedTemplateId = templateId;

    // If broadcast template fails, retry with settlement template using message as content
    if (!res.ok && isBroadcast) {
      const fallbackId = process.env.EMAILJS_TEMPLATE_ID || 'template_vbxffkb';
      const fallbackParams: Record<string, string> = {
        to_email: to,
        subject,
        player_name: body.senderName || 'Poker Manager',
        reporter_name: body.message || '',
        amount: '',
        game_date: '',
        pay_link: '',
      };
      res = await sendEmail(buildPayload(fallbackId, fallbackParams));
      usedTemplateId = fallbackId;
    }

    const safeKind = typeof kind === 'string' && kind ? kind : (isBroadcast ? 'broadcast' : 'settlement');

    if (!res.ok) {
      const errText = await res.text();
      // MUST await: Vercel Edge runtime tears the worker down as soon as the
      // Response is returned, so a fire-and-forget fetch to Supabase has no
      // chance to complete. The dashboard would silently stay at 0.
      // The added latency is one Supabase REST hop (~50-100ms) — acceptable.
      await logEmailSend(authHeader, groupId, to, safeKind, subject, false, res.status, errText?.slice(0, 500) || null, usedTemplateId);
      return new Response(JSON.stringify({ error: { message: `EmailJS: ${errText || res.status}` } }), {
        status: 502, headers: JSON_HEADERS,
      });
    }

    await logEmailSend(authHeader, groupId, to, safeKind, subject, true, res.status, null, usedTemplateId);

    return new Response(JSON.stringify({ success: true }), {
      status: 200, headers: JSON_HEADERS,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: { message: String(err) } }), {
      status: 500, headers: JSON_HEADERS,
    });
  }
}
