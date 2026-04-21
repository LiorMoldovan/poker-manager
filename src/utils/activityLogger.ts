import { ActivityLogEntry, DeviceFingerprint, PermissionRole } from '../types';
import { supabase } from '../database/supabaseClient';
import { getGroupId } from '../database/supabaseCache';

const DEVICE_ID_KEY = 'poker_device_id';
const MAX_LOG_ENTRIES = 1000;
const ACTIVITY_BUFFER_KEY = 'poker_activity_buffer';
const ACTIVITY_LAST_PUSH_KEY = 'poker_activity_last_push';
const ACTIVITY_PUSH_COOLDOWN_MS = 2 * 60 * 1000; // throttle session row updates (2 min)

let currentSessionTimestamp: string | null = null;
let lastPushedScreens: string[] = [];

const generateUUID = (): string => {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
};

export const getDeviceId = (): string => {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = generateUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
};

export const getDeviceInfo = (): string => {
  const ua = navigator.userAgent;
  let device = 'Unknown';
  let os = 'Unknown';
  let browser = 'Unknown';

  // Device detection
  if (/iPhone/.test(ua)) {
    device = 'iPhone';
  } else if (/iPad/.test(ua)) {
    device = 'iPad';
  } else if (/Samsung|SM-[A-Z]/.test(ua)) {
    const match = ua.match(/Samsung\s[\w-]+|SM-[A-Z]\d+/i);
    device = match ? match[0] : 'Samsung';
  } else if (/Pixel/.test(ua)) {
    const match = ua.match(/Pixel\s?\d*/);
    device = match ? match[0] : 'Pixel';
  } else if (/Huawei|HUAWEI/.test(ua)) {
    device = 'Huawei';
  } else if (/Xiaomi|Redmi|POCO/.test(ua)) {
    const match = ua.match(/Xiaomi|Redmi\s?\w*|POCO\s?\w*/i);
    device = match ? match[0] : 'Xiaomi';
  } else if (/Android/.test(ua) && /Mobile/.test(ua)) {
    device = 'Android Phone';
  } else if (/Android/.test(ua)) {
    device = 'Android Tablet';
  } else if (/Macintosh/.test(ua)) {
    device = 'Mac';
  } else if (/Windows/.test(ua)) {
    device = 'Windows PC';
  } else if (/Linux/.test(ua)) {
    device = 'Linux PC';
  }

  // OS detection
  if (/iPhone OS (\d+[_\d]*)/.test(ua)) {
    const ver = ua.match(/iPhone OS (\d+[_\d]*)/)?.[1]?.replace(/_/g, '.') || '';
    os = `iOS ${ver.split('.')[0]}`;
  } else if (/iPad.*OS (\d+[_\d]*)/.test(ua)) {
    const ver = ua.match(/OS (\d+[_\d]*)/)?.[1]?.replace(/_/g, '.') || '';
    os = `iPadOS ${ver.split('.')[0]}`;
  } else if (/Android (\d+[\d.]*)/.test(ua)) {
    const ver = ua.match(/Android (\d+[\d.]*)/)?.[1] || '';
    os = `Android ${ver.split('.')[0]}`;
  } else if (/Windows NT (\d+\.\d+)/.test(ua)) {
    const ver = ua.match(/Windows NT (\d+\.\d+)/)?.[1] || '';
    const winMap: Record<string, string> = { '10.0': '10/11', '6.3': '8.1', '6.2': '8', '6.1': '7' };
    os = `Windows ${winMap[ver] || ver}`;
  } else if (/Mac OS X (\d+[_\d]*)/.test(ua)) {
    const ver = ua.match(/Mac OS X (\d+[_\d]*)/)?.[1]?.replace(/_/g, '.') || '';
    os = `macOS ${ver.split('.').slice(0, 2).join('.')}`;
  }

  // Browser detection
  if (/CriOS/.test(ua)) {
    browser = 'Chrome';
  } else if (/FxiOS/.test(ua)) {
    browser = 'Firefox';
  } else if (/EdgiOS|Edg\//.test(ua)) {
    browser = 'Edge';
  } else if (/OPiOS|OPR\//.test(ua)) {
    browser = 'Opera';
  } else if (/Safari/.test(ua) && !/Chrome/.test(ua)) {
    browser = 'Safari';
  } else if (/Chrome/.test(ua)) {
    browser = 'Chrome';
  } else if (/Firefox/.test(ua)) {
    browser = 'Firefox';
  }

  return `${device} / ${os} / ${browser}`;
};

const ROUTE_NAMES: Record<string, string> = {
  '/': 'New Game',
  '/statistics': 'Statistics',
  '/history': 'History',
  '/settings': 'Settings',
  '/graphs': 'Graphs',
  '/training': 'Training',
};

export const getScreenName = (pathname: string): string => {
  if (ROUTE_NAMES[pathname]) return ROUTE_NAMES[pathname];
  if (pathname.startsWith('/live-game/')) return 'Live Game';
  if (pathname.startsWith('/chip-entry/')) return 'Chip Entry';
  if (pathname.startsWith('/game-summary/') || pathname.startsWith('/game/')) return 'Game Details';
  if (pathname.startsWith('/shared-training')) return 'Shared Training';
  if (pathname.startsWith('/training/')) return 'Training';
  return 'Other';
};

const getGPURenderer = (): string => {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return 'Unknown';
    const ext = (gl as WebGLRenderingContext).getExtension('WEBGL_debug_renderer_info');
    if (!ext) return 'Unknown';
    return (gl as WebGLRenderingContext).getParameter(ext.UNMASKED_RENDERER_WEBGL) || 'Unknown';
  } catch { return 'Unknown'; }
};

const getCanvasHash = (): string => {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 50;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillStyle = '#f60';
    ctx.fillRect(50, 0, 100, 50);
    ctx.fillStyle = '#069';
    ctx.fillText('fingerprint', 2, 15);
    ctx.fillStyle = 'rgba(102,204,0,0.7)';
    ctx.fillText('fingerprint', 4, 17);
    const data = canvas.toDataURL();
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      hash = ((hash << 5) - hash) + data.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  } catch { return ''; }
};

export const getDeviceFingerprint = (): DeviceFingerprint => ({
  gpu: getGPURenderer(),
  cores: navigator.hardwareConcurrency || 0,
  memory: (navigator as unknown as { deviceMemory?: number }).deviceMemory || 0,
  touchPoints: navigator.maxTouchPoints || 0,
  language: navigator.language || '',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
  canvasHash: getCanvasHash(),
});

const saveSessionBuffer = (entry: ActivityLogEntry): void => {
  try { localStorage.setItem(ACTIVITY_BUFFER_KEY, JSON.stringify(entry)); } catch { /* full */ }
};

const loadSessionBuffer = (): ActivityLogEntry | null => {
  try {
    const raw = localStorage.getItem(ACTIVITY_BUFFER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
};

const shouldPushNow = (): boolean => {
  const last = parseInt(localStorage.getItem(ACTIVITY_LAST_PUSH_KEY) || '0', 10);
  return Date.now() - last >= ACTIVITY_PUSH_COOLDOWN_MS;
};

const markPushed = (): void => {
  localStorage.setItem(ACTIVITY_LAST_PUSH_KEY, Date.now().toString());
};

export const logActivity = async (role: PermissionRole, playerName?: string, userId?: string, initialScreens: string[] = []): Promise<void> => {
  const entry: ActivityLogEntry = {
    deviceId: getDeviceId(),
    role,
    timestamp: new Date().toISOString(),
    device: getDeviceInfo(),
    screenSize: `${window.screen.width}x${window.screen.height}`,
    screensVisited: initialScreens,
    sessionDuration: 0,
    lastActive: new Date().toISOString(),
    fingerprint: undefined,
    playerName: playerName || undefined,
    userId: userId || undefined,
  };

  currentSessionTimestamp = entry.timestamp;
  lastPushedScreens = [...initialScreens];
  saveSessionBuffer(entry);

  const gid = getGroupId();
  await supabase.from('activity_log').insert({
    group_id: gid,
    device_id: entry.deviceId,
    user_id: entry.userId || null,
    role: entry.role,
    timestamp: entry.timestamp,
    device: entry.device,
    screen_size: entry.screenSize,
    screens_visited: entry.screensVisited,
    session_duration: entry.sessionDuration,
    last_active: entry.lastActive,
    fingerprint: null,
    player_name: entry.playerName || null,
  });
};

export const updateSessionActivity = async (
  screens: string[],
  durationMinutes: number,
  keepalive = false
): Promise<void> => {
  if (!currentSessionTimestamp) return;

  if (JSON.stringify(screens) === JSON.stringify(lastPushedScreens)) return;

  const buffered = loadSessionBuffer();
  if (buffered && buffered.timestamp === currentSessionTimestamp) {
    buffered.screensVisited = [...screens];
    buffered.sessionDuration = Math.round(durationMinutes);
    buffered.lastActive = new Date().toISOString();
    saveSessionBuffer(buffered);
  }

  if (keepalive || shouldPushNow()) {
    const entry = loadSessionBuffer();
    if (!entry) return;
    await supabase.from('activity_log').update({
      screens_visited: entry.screensVisited,
      session_duration: entry.sessionDuration,
      last_active: entry.lastActive,
    }).eq('device_id', entry.deviceId).eq('timestamp', entry.timestamp);
    markPushed();
    lastPushedScreens = [...(entry.screensVisited || [])];
  }
};

export const fetchActivityLog = async (excludeUserId?: string): Promise<ActivityLogEntry[]> => {
  const gid = getGroupId();
  if (!gid) return [];
  let query = supabase.from('activity_log')
    .select('*')
    .eq('group_id', gid)
    .order('timestamp', { ascending: false })
    .limit(MAX_LOG_ENTRIES);
  if (excludeUserId) {
    query = query.neq('user_id', excludeUserId);
  }
  const { data } = await query;
  return (data || []).map(row => ({
    deviceId: row.device_id as string,
    role: row.role as PermissionRole,
    timestamp: row.timestamp as string,
    device: (row.device || '') as string,
    screenSize: (row.screen_size || '') as string,
    screensVisited: (row.screens_visited || []) as string[],
    sessionDuration: (row.session_duration || 0) as number,
    lastActive: (row.last_active || '') as string,
    fingerprint: row.fingerprint ? (row.fingerprint as DeviceFingerprint) : undefined,
    playerName: row.player_name as string | undefined,
    userId: (row.user_id || undefined) as string | undefined,
  }));
};

export const deleteActivityEntry = async (deviceId: string, timestamp: string): Promise<boolean> => {
  const { error } = await supabase.from('activity_log')
    .delete()
    .eq('device_id', deviceId)
    .eq('timestamp', timestamp);
  return !error;
};

export const deleteDeviceEntries = async (deviceId: string): Promise<boolean> => {
  const { error } = await supabase.from('activity_log')
    .delete()
    .eq('device_id', deviceId);
  return !error;
};

export const clearActivityLog = async (): Promise<boolean> => {
  const gid = getGroupId();
  if (!gid) return false;
  const { error } = await supabase.from('activity_log')
    .delete()
    .eq('group_id', gid);
  return !error;
};

export const resetSession = (): void => {
  currentSessionTimestamp = null;
  lastPushedScreens = [];
};
