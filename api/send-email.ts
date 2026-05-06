import { verifySupabaseAuth } from './_auth';
import { computeCycleWindow, getCurrentCycleUsage, getMonthlyCap } from './_emailUsage';

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

// ─── Quota threshold alerts ─────────────────────────────────────────────
// Computes the current EmailJS billing cycle window from
// EMAILJS_QUOTA_RESET_DAY (same logic as api/email-usage.ts), counts
// rows in `email_usage_log` for that cycle, and fires a push to all
// super-admin push subscribers when usage crosses 80% / 95% / 100% of
// EMAILJS_MONTHLY_CAP for the FIRST time this cycle. Subsequent sends
// past the same threshold are no-ops — `try_record_quota_alert` uses
// (cycle_start, threshold) as a unique key.
//
// Why not push for every send past 80%?
//   That would be a notification storm. Each threshold gets exactly
//   one alert per cycle: enough to catch the operator's attention,
//   not enough to make them mute the channel.
const QUOTA_ALERT_THRESHOLDS = [80, 95, 100] as const;

async function checkAndAlertQuotaThresholds(
  req: Request,
  authHeader: string,
  groupId: string | null,
): Promise<void> {
  // Resolve cap + cycle from system_config (UI-editable) with env-var
  // fallback. Same precedence the Usage card uses, so the threshold
  // trigger fires at the same number the operator sees on screen.
  const cap = await getMonthlyCap(authHeader);
  const limit = cap.cap;
  const cycle = await computeCycleWindow(authHeader);

  const usage = await getCurrentCycleUsage(authHeader, cycle);
  if (!usage) return;
  const used = usage.used;
  const usedPct = (used / limit) * 100;

  // Find the highest threshold we've crossed. We only alert the
  // top one — once we hit 95% there's no point also pinging about
  // 80%; the push body says "you hit X%" with the most current data.
  let crossedThreshold: number | null = null;
  for (const threshold of QUOTA_ALERT_THRESHOLDS) {
    if (usedPct >= threshold) crossedThreshold = threshold;
  }
  if (crossedThreshold === null) return;

  // Try to record the alert. If another send already alerted this
  // threshold for this cycle, the RPC returns false and we skip.
  let isNewAlert = false;
  try {
    const cycleStartIso = cycle.start.toISOString().slice(0, 10);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/try_record_quota_alert`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': authHeader,
      },
      body: JSON.stringify({
        cycle_start_d: cycleStartIso,
        threshold_v: crossedThreshold,
      }),
    });
    if (!r.ok) return;
    isNewAlert = (await r.json()) === true;
  } catch {
    return;
  }
  if (!isNewAlert) return;

  // Fetch super-admin push subscriber names for the owner group
  // (the only group permitted to send via this Edge Function).
  const ownerGroupId = process.env.OWNER_GROUP_ID;
  if (!ownerGroupId) return;
  let targets: string[] = [];
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_super_admin_player_names_in_group`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': authHeader,
      },
      body: JSON.stringify({ p_group_id: ownerGroupId }),
    });
    if (!r.ok) return;
    targets = (await r.json()) as string[];
  } catch {
    return;
  }
  if (!Array.isArray(targets) || targets.length === 0) return;

  // Compose a human, accurate notification. We name the threshold
  // (80% / 95% / 100%) and include the live count so the recipient
  // doesn't have to open the app to know the severity.
  const remaining = Math.max(limit - used, 0);
  const isCritical = crossedThreshold >= 95;
  const isFull = crossedThreshold >= 100;
  const title = isFull
    ? '🚫 מכסת מיילים מלאה'
    : isCritical
      ? '⚠️ מכסת מיילים קריטית'
      : '⚠️ מכסת מיילים מתקרבת לסיום';
  const cycleEndDate = cycle.end.toISOString().slice(0, 10);
  const body = isFull
    ? `נוצלו ${used}/${limit} מיילים החודש. שליחת מיילים נוספים תיכשל עד ${cycleEndDate}.`
    : `נוצלו ${used}/${limit} מיילים (${Math.round(usedPct)}%). נותרו ${remaining} עד ${cycleEndDate}.`;

  // Forward to /api/send-push using the caller's JWT. URL is built
  // from the incoming request so it works in both dev and prod
  // without hardcoding the deployment hostname.
  void groupId; // eslint placeholder: groupId may be useful for future per-group quota logic
  try {
    const pushUrl = new URL('/api/send-push', req.url).toString();
    await fetch(pushUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader,
      },
      body: JSON.stringify({
        groupId: ownerGroupId,
        title,
        body,
        targetPlayerNames: targets,
        url: '/settings?tab=ai',
      }),
    });
  } catch (err) {
    console.error('[send-email] quota push failed:', err);
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

    // ─── Quota threshold push alert ───────────────────────────────────
    // After every successful send, check if we just crossed an alert
    // threshold (80%, 95%, 100%) for the current EmailJS billing
    // cycle. The dedup table guarantees one alert per threshold per
    // cycle, so this loop is safe to run on every send.
    //
    // MUST be awaited — Vercel Edge Functions tear down the worker the
    // moment we return, same lesson logEmailSend taught us. The added
    // latency is one count query (always) plus one push send (only on
    // the rare boundary-crossing send) — acceptable overhead for the
    // accuracy guarantee.
    try {
      await checkAndAlertQuotaThresholds(req, authHeader, groupId);
    } catch (err) {
      console.error('[send-email] quota alert check failed:', err);
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
