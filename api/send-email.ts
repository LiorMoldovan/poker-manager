import { verifySupabaseAuth } from './_auth';

export const config = { runtime: 'edge' };

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const authError = await verifySupabaseAuth(req);
  if (authError) return authError;

  try {
    const body = await req.json();
    const { to, subject } = body;

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
          amount: String(body.amount || '?'),
          game_date: body.gameDate || '',
          pay_link: body.payLink || '',
        };

    const emailPayload: Record<string, unknown> = {
      service_id: serviceId,
      template_id: templateId,
      user_id: publicKey,
      template_params: templateParams,
    };
    if (privateKey) emailPayload.accessToken = privateKey;

    const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'origin': 'https://poker-manager-blond.vercel.app' },
      body: JSON.stringify(emailPayload),
    });

    if (!res.ok) {
      const errText = await res.text();
      return new Response(JSON.stringify({ error: { message: `EmailJS: ${errText || res.status}` } }), {
        status: 502, headers: JSON_HEADERS,
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200, headers: JSON_HEADERS,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: { message: String(err) } }), {
      status: 500, headers: JSON_HEADERS,
    });
  }
}
