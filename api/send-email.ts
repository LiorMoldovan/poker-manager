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
    const { to, subject, playerName, reporterName, amount, gameDate, payLink } = await req.json();

    const serviceId = process.env.EMAILJS_SERVICE_ID;
    const templateId = process.env.EMAILJS_TEMPLATE_ID;
    const publicKey = process.env.EMAILJS_PUBLIC_KEY;

    if (!serviceId || !templateId || !publicKey) {
      return new Response(JSON.stringify({ error: { message: 'EmailJS not configured (missing env vars)' } }), {
        status: 500, headers: JSON_HEADERS,
      });
    }

    if (!to || !subject) {
      return new Response(JSON.stringify({ error: { message: 'Missing required fields: to, subject' } }), {
        status: 400, headers: JSON_HEADERS,
      });
    }

    const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: serviceId,
        template_id: templateId,
        user_id: publicKey,
        template_params: {
          to_email: to,
          subject,
          player_name: playerName || '',
          reporter_name: reporterName || 'שחקן',
          amount: amount || '?',
          game_date: gameDate || '',
          pay_link: payLink || '',
        },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('EmailJS error:', err);
      return new Response(JSON.stringify({ error: { message: 'Failed to send email' } }), {
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
