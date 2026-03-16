import { ActivityLogEntry, PermissionRole } from '../types';
import { getEmbeddedToken } from '../database/embeddedToken';
import { GITHUB_OWNER, GITHUB_REPO, GITHUB_ACTIVITY_PATH, GITHUB_BRANCH } from '../database/githubSync';

const DEVICE_ID_KEY = 'poker_device_id';
const MAX_LOG_ENTRIES = 200;

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
  if (pathname.startsWith('/training/')) return 'Training';
  return 'Other';
};

interface GitHubFileResult {
  entries: ActivityLogEntry[];
  sha: string | undefined;
}

const fetchActivityFile = async (token: string, keepalive = false): Promise<GitHubFileResult> => {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_ACTIVITY_PATH}`;
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
    },
    keepalive,
  });

  if (!response.ok) {
    return { entries: [], sha: undefined };
  }

  const fileInfo = await response.json();
  try {
    const content = decodeURIComponent(escape(atob(fileInfo.content)));
    const entries = JSON.parse(content) as ActivityLogEntry[];
    return { entries, sha: fileInfo.sha };
  } catch {
    return { entries: [], sha: fileInfo.sha };
  }
};

const writeActivityFile = async (
  token: string,
  entries: ActivityLogEntry[],
  sha: string | undefined,
  message: string,
  keepalive = false
): Promise<boolean> => {
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_ACTIVITY_PATH}`;
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(entries, null, 2))));

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message,
      content,
      sha,
      branch: GITHUB_BRANCH,
    }),
    keepalive,
  });

  return response.ok;
};

const writeWithRetry = async (
  token: string,
  mutate: (entries: ActivityLogEntry[]) => ActivityLogEntry[],
  message: string,
  keepalive = false
): Promise<boolean> => {
  try {
    const { entries, sha } = await fetchActivityFile(token, keepalive);
    const updated = mutate(entries);
    const success = await writeActivityFile(token, updated, sha, message, keepalive);

    if (!success) {
      const fresh = await fetchActivityFile(token, keepalive);
      const retryUpdated = mutate(fresh.entries);
      return await writeActivityFile(token, retryUpdated, fresh.sha, message, keepalive);
    }

    return true;
  } catch (err) {
    console.warn('Activity log write failed:', err);
    return false;
  }
};

export const logActivity = async (role: PermissionRole): Promise<void> => {
  if (role === 'admin') return;

  const token = getEmbeddedToken();
  if (!token) return;

  const entry: ActivityLogEntry = {
    deviceId: getDeviceId(),
    role,
    timestamp: new Date().toISOString(),
    device: getDeviceInfo(),
    screenSize: `${window.screen.width}x${window.screen.height}`,
    screensVisited: [],
    sessionDuration: 0,
    lastActive: new Date().toISOString(),
  };

  currentSessionTimestamp = entry.timestamp;
  lastPushedScreens = [];

  await writeWithRetry(
    token,
    (entries) => [...entries, entry].slice(-MAX_LOG_ENTRIES),
    `Activity: ${role} login`
  );
};

export const updateSessionActivity = async (
  screens: string[],
  durationMinutes: number,
  keepalive = false
): Promise<void> => {
  if (!currentSessionTimestamp) return;

  // Skip if nothing changed
  if (JSON.stringify(screens) === JSON.stringify(lastPushedScreens)) return;

  const token = getEmbeddedToken();
  if (!token) return;

  const sessionTs = currentSessionTimestamp;
  const deviceId = getDeviceId();

  const success = await writeWithRetry(
    token,
    (entries) => {
      const idx = entries.findIndex(
        e => e.deviceId === deviceId && e.timestamp === sessionTs
      );
      if (idx !== -1) {
        entries[idx].screensVisited = [...screens];
        entries[idx].sessionDuration = Math.round(durationMinutes);
        entries[idx].lastActive = new Date().toISOString();
      }
      return entries;
    },
    'Activity: session update',
    keepalive
  );

  if (success) {
    lastPushedScreens = [...screens];
  }
};

export const fetchActivityLog = async (): Promise<ActivityLogEntry[]> => {
  const token = getEmbeddedToken();
  if (!token) return [];

  const { entries } = await fetchActivityFile(token);
  return entries;
};

export const clearActivityLog = async (): Promise<boolean> => {
  const token = getEmbeddedToken();
  if (!token) return false;

  const { sha } = await fetchActivityFile(token);
  return await writeActivityFile(token, [], sha, 'Activity: log cleared');
};

export const resetSession = (): void => {
  currentSessionTimestamp = null;
  lastPushedScreens = [];
};
