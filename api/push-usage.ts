import { verifyAuth } from './_auth';
import { createClient } from '@supabase/supabase-js';

export const config = { runtime: 'edge' };

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ursjltxklmxmapfvkttj.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_TzhEQmU6mX2n-utnOUAtwQ_zkGTR13j';

export interface PushUsageEntry {
  id: string;
  sent_at: string;
  kind: string;
  title: string;
  body: string;
  url?: string;
  target_player_names?: string[];
  sent_count: number;
  total_count: number;
  details?: Array<{ player: string; type?: string; status?: string | number; ok: boolean }>;
  success: boolean;
}

export interface PushUsageResponse {
  recent: PushUsageEntry[];
  totalSent: number;
  activeSubscribers: string[];
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const auth = await verifyAuth(req);
  if (!auth.ok) return auth.response;

  try {
    const { groupId } = await req.json();
    if (!groupId) {
      return new Response(JSON.stringify({ error: { message: 'Missing groupId' } }), {
        status: 400, headers: JSON_HEADERS,
      });
    }

    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceKey) {
      return new Response(JSON.stringify({ error: { message: 'SUPABASE_SERVICE_ROLE_KEY missing' } }), {
        status: 500, headers: JSON_HEADERS,
      });
    }

    // Security check: verify caller is admin of the group or super admin
    if (auth.mode !== 'worker') {
      const authHeader = req.headers.get('Authorization') || '';
      const asCaller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: member } = await asCaller
        .from('group_members')
        .select('role')
        .eq('group_id', groupId)
        .maybeSingle();

      const { data: superAdmin } = await asCaller
        .from('super_admins')
        .select('id')
        .maybeSingle();

      if ((!member || member.role !== 'admin') && !superAdmin) {
        return new Response(JSON.stringify({ error: { message: 'Forbidden: admin access required' } }), {
          status: 403, headers: JSON_HEADERS,
        });
      }
    }

    const db = createClient(SUPABASE_URL, serviceKey, {
      auth: { persistSession: false },
    });

    // 1. Fetch active subscribers in the group
    const { data: subsData } = await db
      .from('push_subscriptions')
      .select('player_name')
      .eq('group_id', groupId);

    const activeSubscribers = Array.from(new Set(
      (subsData || [])
        .map(s => (s as { player_name?: string }).player_name)
        .filter((n): n is string => Boolean(n && n.trim()))
    ));

    // 2. Fetch logged pushes from push_notifications_log
    const { data: logRows, error: logError } = await db
      .from('push_notifications_log')
      .select('*')
      .eq('group_id', groupId)
      .order('sent_at', { ascending: false })
      .limit(30);

    const entries: PushUsageEntry[] = [];
    if (!logError && logRows && logRows.length > 0) {
      for (const row of logRows) {
        entries.push({
          id: row.id,
          sent_at: row.sent_at,
          kind: row.kind || 'broadcast',
          title: row.title,
          body: row.body,
          url: row.url,
          target_player_names: row.target_player_names || [],
          sent_count: row.sent_count ?? 0,
          total_count: row.total_count ?? 0,
          details: Array.isArray(row.details) ? row.details : [],
          success: row.success ?? true,
        });
      }
    }

    // 3. Fallback: if push_notifications_log is empty (e.g. freshly created or historical),
    // complement with completed notification_jobs so the user sees past sends right away.
    if (entries.length < 5) {
      const { data: jobs } = await db
        .from('notification_jobs')
        .select('*')
        .eq('group_id', groupId)
        .eq('status', 'done')
        .order('completed_at', { ascending: false })
        .limit(20);

      const existingJobTimes = new Set(entries.map(e => e.sent_at.slice(0, 16)));

      for (const job of (jobs || [])) {
        const time = job.completed_at || job.created_at;
        if (time && existingJobTimes.has(time.slice(0, 16))) continue;

        const payload = (job.payload || {}) as Record<string, unknown>;
        const kind = job.kind as string;

        let title = String(payload.push_title || payload.title || '');
        let body = String(payload.push_body || payload.body || '');

        if (!title) {
          if (kind === 'creation') title = '🃏 ערב פוקר חדש — הצביעו!';
          else if (kind === 'confirmed') title = '✅ נקבע תאריך למשחק';
          else if (kind === 'target_filled') title = '🎯 השולחן מלא!';
          else if (kind === 'vote_change') title = '🗳 עדכון בהצבעה';
          else if (kind === 'reminder_no_vote') title = '🃏 טרם הצבעת בסקר';
          else title = `התראה (${kind})`;
        }

        if (!body) {
          if (kind === 'creation') body = 'נפתחה הצבעה חדשה לערב פוקר 📅';
          else if (kind === 'confirmed') body = 'נבחר תאריך לערב הפוקר';
          else if (kind === 'target_filled') body = 'השולחן התמלא שחקנים';
          else if (kind === 'reminder_no_vote') body = 'תזכורת להצביע ולשמור מקום';
        }

        const targetPlayers = Array.isArray(payload.recipient_player_names)
          ? (payload.recipient_player_names as string[])
          : [];

        const targetCount = targetPlayers.length > 0 ? targetPlayers.length : activeSubscribers.length;

        entries.push({
          id: job.id,
          sent_at: time,
          kind,
          title,
          body,
          url: String(payload.url || '/'),
          target_player_names: targetPlayers,
          sent_count: targetCount,
          total_count: targetCount,
          details: targetPlayers.map(p => ({ player: p, ok: true })),
          success: true,
        });
      }

      // Re-sort combined list desc by timestamp
      entries.sort((a, b) => new Date(b.sent_at).getTime() - new Date(a.sent_at).getTime());
    }

    const totalSent = entries.reduce((sum, e) => sum + (e.sent_count || 1), 0);

    const response: PushUsageResponse = {
      recent: entries.slice(0, 30),
      totalSent,
      activeSubscribers,
    };

    return new Response(JSON.stringify(response), { headers: JSON_HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error fetching push usage';
    return new Response(JSON.stringify({ error: { message } }), {
      status: 500, headers: JSON_HEADERS,
    });
  }
}
