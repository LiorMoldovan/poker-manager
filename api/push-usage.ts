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
  voteChangeSubscribers?: string[];
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

    // Resolve which players have active push subscriptions AND have vote_change notifications enabled
    let voteChangePushSubscribers: string[] = [];
    try {
      const { data: vMembers } = await db
        .from('group_members')
        .select('player_id, schedule_vote_change_notifs')
        .eq('group_id', groupId);

      const vMemberRows = (vMembers || []) as Array<{ player_id: string; schedule_vote_change_notifs: boolean | null }>;
      const vOptedInIds = vMemberRows.filter(m => m.schedule_vote_change_notifs !== false).map(m => m.player_id).filter(Boolean);

      if (vOptedInIds.length > 0) {
        const { data: vPlayers } = await db.from('players').select('name').in('id', vOptedInIds);
        const vNames = new Set((vPlayers || []).map(p => (p as { name: string }).name));
        voteChangePushSubscribers = activeSubscribers.filter(name => vNames.has(name));
      }
    } catch {
      voteChangePushSubscribers = [];
    }

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
        let targets = row.target_player_names || [];
        if (row.kind === 'vote_change') {
          const fromDetails = (Array.isArray(row.details) ? row.details : [])
            .map((d: any) => d.player || d.name)
            .filter(Boolean);
          if (fromDetails.length > 0) {
            targets = fromDetails;
          } else if (targets.length > 0) {
            targets = targets.filter((n: string) => activeSubscribers.includes(n));
          }
          if (targets.length === 0 && voteChangePushSubscribers.length > 0) {
            targets = voteChangePushSubscribers;
          }
        }

        entries.push({
          id: row.id,
          sent_at: row.sent_at,
          kind: row.kind || 'broadcast',
          title: row.title,
          body: row.body,
          url: row.url,
          target_player_names: targets,
          sent_count: row.sent_count ?? 0,
          total_count: row.total_count ?? 0,
          details: Array.isArray(row.details) ? row.details : [],
          success: row.success ?? true,
        });
      }
    }

    // 3. Complement from notification_jobs: always include recent completed reminder/poll jobs
    // (especially reminders where non-push recipients received email fallback)
    const { data: jobs } = await db
      .from('notification_jobs')
      .select('*')
      .eq('group_id', groupId)
      .eq('status', 'done')
      .order('completed_at', { ascending: false })
      .limit(20);

    if (jobs && jobs.length > 0) {
      const existingJobTimes = new Set(entries.map(e => e.sent_at.slice(0, 16)));

      for (const job of jobs) {
        const time = job.completed_at || job.created_at;
        if (time && existingJobTimes.has(time.slice(0, 16))) continue;

        const payload = (job.payload || {}) as Record<string, unknown>;
        const kind = job.kind as string;

        let title = String(payload.push_title || payload.title || '');
        let body = String(payload.push_body || payload.body || '');

        if (!title) {
          if (kind === 'creation' || kind === 'poll_creation') title = '🃏 ערב פוקר חדש — הצביעו!';
          else if (kind === 'confirmed') title = '✅ נקבע תאריך למשחק';
          else if (kind === 'target_filled') title = '🎯 השולחן מלא!';
          else if (kind === 'vote_change') title = '🗳 עדכון בהצבעה';
          else if (kind.includes('maybe')) title = '🤔 תזכורת למתלבטים';
          else if (kind.includes('reminder') || kind.includes('vote')) title = '🃏 טרם הצבעת בסקר';
          else if (kind === 'cancellation') title = '❌ ההצבעה בוטלה';
          else if (kind === 'expanded') title = '🔓 ההצבעה נפתחה לכולם';
          else if (kind === 'broadcast') title = '📢 הודעת מנהל';
          else title = 'התראת סקר';
        }

        if (!body) {
          if (kind === 'creation' || kind === 'poll_creation') body = 'נפתחה הצבעה חדשה לערב פוקר 📅';
          else if (kind === 'confirmed') body = 'נבחר תאריך לערב הפוקר';
          else if (kind === 'target_filled') body = 'השולחן התמלא שחקנים';
          else if (kind === 'vote_change') body = 'שחקן עדכן את סטטוס ההצבעה';
          else if (kind.includes('maybe')) body = 'נא לעדכן אם מגיעים';
          else if (kind.includes('reminder') || kind.includes('vote')) body = 'תזכורת להצביע ולשמור מקום';
          else if (kind === 'cancellation') body = 'ההצבעה למשחק בוטלה';
          else if (kind === 'expanded') body = 'ההרשמה למשחק פתוחה כעת לכולם';
          else if (kind === 'broadcast') body = 'הודעה חדשה ממנהל הקבוצה';
          else body = 'עדכון לגבי הצבעת משחק';
        }

        let targetPlayers = Array.isArray(payload.recipient_player_names)
          ? (payload.recipient_player_names as string[])
          : [];

        if (kind === 'vote_change') {
          targetPlayers = voteChangePushSubscribers;
        }

        const isReminderKind = kind.includes('reminder') || kind.includes('vote_reminder');
        const pushDelivered = isReminderKind
          ? targetPlayers.filter(p => activeSubscribers.includes(p))
          : targetPlayers;
        const targetCount = targetPlayers.length > 0 ? targetPlayers.length : (kind === 'vote_change' ? 0 : activeSubscribers.length);
        const sentCount = isReminderKind ? pushDelivered.length : targetCount;

        entries.push({
          id: job.id,
          sent_at: time,
          kind,
          title,
          body,
          url: String(payload.url || '/'),
          target_player_names: targetPlayers,
          sent_count: sentCount,
          total_count: targetCount,
          details: pushDelivered.map(p => ({ player: p, ok: true })),
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
      voteChangeSubscribers: voteChangePushSubscribers,
    };

    return new Response(JSON.stringify(response), { headers: JSON_HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Error fetching push usage';
    return new Response(JSON.stringify({ error: { message } }), {
      status: 500, headers: JSON_HEADERS,
    });
  }
}
