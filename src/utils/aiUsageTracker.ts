const STORAGE_KEY = 'poker_ai_status';
const MAX_LOG_ENTRIES = 50;

// Hebrew labels for AI operations
export const ACTION_LABELS: Record<string, string> = {
  'forecast': 'תחזית',
  'Forecast': 'תחזית',
  'tts_pool': 'TTS',
  'TTS Pool': 'TTS',
  'game_summary': 'סיכום',
  'AI summary': 'סיכום',
  'forecast_comparison': 'השוואה',
  'Forecast comparison': 'השוואה',
  'chronicle': 'כרוניקה',
  'Chronicle': 'כרוניקה',
  'graph_insights': 'תובנות',
  'Graph insights': 'תובנות',
  'quick_training': 'אימון',
  'training_hand': 'יד אימון',
};

export const getActionLabel = (key: string): string =>
  ACTION_LABELS[key] || key;

export interface ModelStatus {
  lastSuccess?: string;
  lastRateLimited?: string;
  rateLimitResetsAt?: string;
  rateLimitType?: 'rpm' | 'rpd' | 'tpm';
  rateLimitRemaining?: number;
  rateLimitTotal?: number;
  isActive: boolean;
}

export interface ActionEntry {
  timestamp: string;
  action: string;
  model: string;
  tokens: number;
  fallbackFrom?: string;
  success: boolean;
}

interface DailyActions {
  [actionType: string]: number;
}

export interface AIStatusData {
  statuses: Record<string, ModelStatus>;
  log: ActionEntry[];
  dailyActions: Record<string, DailyActions>;
  dailyTokens: Record<string, number>;
  allTimeTokens: number;
  allTimeCalls: number;
}

function getToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadData(): AIStatusData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyData();
    return JSON.parse(raw);
  } catch {
    return emptyData();
  }
}

function saveData(data: AIStatusData): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function emptyData(): AIStatusData {
  return {
    statuses: {},
    log: [],
    dailyActions: {},
    dailyTokens: {},
    allTimeTokens: 0,
    allTimeCalls: 0,
  };
}

export interface RateLimitHeaders {
  remaining?: number;
  limit?: number;
  reset?: string;
}

export function readRateLimitHeaders(response: Response): RateLimitHeaders | null {
  const remaining = response.headers.get('x-ratelimit-remaining');
  const limit = response.headers.get('x-ratelimit-limit');
  const reset = response.headers.get('x-ratelimit-reset');

  if (!remaining && !limit && !reset) return null;

  let resetISO: string | undefined;
  if (reset) {
    const ts = Number(reset);
    if (!isNaN(ts)) {
      resetISO = new Date(ts > 1e12 ? ts : ts * 1000).toISOString();
    }
  }

  return {
    remaining: remaining ? Number(remaining) : undefined,
    limit: limit ? Number(limit) : undefined,
    reset: resetISO,
  };
}

function detectRateLimitType(errorMsg: string): 'rpm' | 'rpd' | 'tpm' {
  const lower = errorMsg.toLowerCase();
  if (lower.includes('per day') || lower.includes('daily') || lower.includes('rpd')) return 'rpd';
  if (lower.includes('token') || lower.includes('tpm')) return 'tpm';
  return 'rpm';
}

function estimateResetTime(type: 'rpm' | 'rpd' | 'tpm'): string {
  if (type === 'rpd') {
    const now = new Date();
    const pacific = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const midnight = new Date(pacific);
    midnight.setDate(midnight.getDate() + 1);
    midnight.setHours(0, 0, 0, 0);
    const diff = midnight.getTime() - pacific.getTime();
    return new Date(now.getTime() + diff).toISOString();
  }
  return new Date(Date.now() + 65_000).toISOString();
}

export function recordSuccess(
  model: string,
  label: string,
  tokens?: number,
  fallbackFrom?: string,
  headers?: RateLimitHeaders | null,
): void {
  const data = loadData();
  const today = getToday();

  for (const key of Object.keys(data.statuses)) {
    if (data.statuses[key]) data.statuses[key].isActive = false;
  }

  const prev = data.statuses[model] || { isActive: false };
  data.statuses[model] = {
    ...prev,
    lastSuccess: new Date().toISOString(),
    isActive: true,
    ...(headers?.remaining != null && { rateLimitRemaining: headers.remaining }),
    ...(headers?.limit != null && { rateLimitTotal: headers.limit }),
  };

  if (prev.rateLimitResetsAt && new Date(prev.rateLimitResetsAt).getTime() <= Date.now()) {
    delete data.statuses[model].lastRateLimited;
    delete data.statuses[model].rateLimitResetsAt;
    delete data.statuses[model].rateLimitType;
  }

  const normalizedLabel = getActionLabel(label);

  data.log.push({
    timestamp: new Date().toISOString(),
    action: normalizedLabel,
    model,
    tokens: tokens || 0,
    fallbackFrom,
    success: true,
  });
  if (data.log.length > MAX_LOG_ENTRIES) {
    data.log = data.log.slice(-MAX_LOG_ENTRIES);
  }

  if (!data.dailyActions[today]) data.dailyActions[today] = {};
  data.dailyActions[today][normalizedLabel] = (data.dailyActions[today][normalizedLabel] || 0) + 1;

  data.dailyTokens[today] = (data.dailyTokens[today] || 0) + (tokens || 0);
  data.allTimeTokens += (tokens || 0);
  data.allTimeCalls += 1;

  saveData(data);
}

export function recordRateLimit(
  model: string,
  headers?: RateLimitHeaders | null,
  errorMsg?: string,
): void {
  const data = loadData();

  const type = detectRateLimitType(errorMsg || '');
  const resetAt = headers?.reset || estimateResetTime(type);

  const prev = data.statuses[model] || { isActive: false };
  data.statuses[model] = {
    ...prev,
    lastRateLimited: new Date().toISOString(),
    rateLimitResetsAt: resetAt,
    rateLimitType: type,
    ...(headers?.remaining != null && { rateLimitRemaining: headers.remaining }),
    ...(headers?.limit != null && { rateLimitTotal: headers.limit }),
  };

  saveData(data);
}

export function getAIStatus(): AIStatusData {
  const data = loadData();

  for (const [model, status] of Object.entries(data.statuses)) {
    if (status.rateLimitResetsAt && new Date(status.rateLimitResetsAt).getTime() <= Date.now()) {
      delete data.statuses[model].lastRateLimited;
      delete data.statuses[model].rateLimitResetsAt;
      delete data.statuses[model].rateLimitType;
    }
  }

  return data;
}

export function getTodayActions(): Record<string, number> {
  const data = loadData();
  return data.dailyActions[getToday()] || {};
}

export function getTodayTokens(): number {
  const data = loadData();
  return data.dailyTokens[getToday()] || 0;
}

export function getTodayLog(): ActionEntry[] {
  const today = getToday();
  const data = loadData();
  return data.log.filter(e => e.timestamp.startsWith(today));
}

// Known free-tier daily request limits (RPD) per model — conservative estimates
const MODEL_RPD_LIMITS: Record<string, number> = {
  'gemini-3-flash-preview': 500,
  'gemini-3.1-flash-lite-preview': 1000,
  'gemini-2.5-flash': 500,
};
const DEFAULT_RPD = 500;

// API calls per user-facing action
export const ACTION_COSTS: { label: string; calls: number }[] = [
  { label: 'התחלת משחק', calls: 2 },
  { label: 'תחזית', calls: 1 },
  { label: 'סיכום', calls: 1 },
  { label: 'כרוניקה', calls: 1 },
  { label: 'תובנות', calls: 1 },
  { label: 'השוואה', calls: 1 },
];

export function getModelDailyUsage(): Record<string, { used: number; limit: number }> {
  const data = loadData();
  const today = getToday();
  const usage: Record<string, { used: number; limit: number }> = {};

  for (const entry of data.log) {
    if (!entry.timestamp.startsWith(today)) continue;
    if (!usage[entry.model]) {
      usage[entry.model] = { used: 0, limit: MODEL_RPD_LIMITS[entry.model] || DEFAULT_RPD };
    }
    usage[entry.model].used++;
  }

  // Ensure all known models appear even if unused today
  for (const [model, limit] of Object.entries(MODEL_RPD_LIMITS)) {
    if (!usage[model]) usage[model] = { used: 0, limit };
  }

  return usage;
}

export interface RemainingEstimates {
  estimates: { label: string; remaining: number }[];
  activeModel: string;
  used: number;
  limit: number;
  remaining: number;
}

export function getRemainingEstimates(
  statuses: Record<string, ModelStatus>,
  modelOrder: string[],
): RemainingEstimates | null {
  const dailyUsage = getModelDailyUsage();

  for (const model of modelOrder) {
    const ms = statuses[model];
    if (ms?.rateLimitResetsAt && new Date(ms.rateLimitResetsAt).getTime() > Date.now()) continue;

    // Prefer header-based data, fall back to local tracking
    let remaining: number;
    let total: number;
    const modelUsage = dailyUsage[model] || { used: 0, limit: MODEL_RPD_LIMITS[model] || DEFAULT_RPD };

    if (ms?.rateLimitRemaining != null && ms?.rateLimitTotal != null) {
      remaining = ms.rateLimitRemaining;
      total = ms.rateLimitTotal;
    } else {
      total = modelUsage.limit;
      remaining = Math.max(0, total - modelUsage.used);
    }

    const estimates = ACTION_COSTS.map(a => ({
      label: a.label,
      remaining: Math.floor(remaining / a.calls),
    }));

    return { estimates, activeModel: model, used: modelUsage.used, limit: total, remaining };
  }
  return null;
}

export function resetUsage(): void {
  localStorage.removeItem(STORAGE_KEY);
}
