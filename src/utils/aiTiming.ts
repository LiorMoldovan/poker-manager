const STORAGE_KEY = 'poker_ai_timing';
const MAX_HISTORY = 10;

// Fallback estimates (seconds) for first run before any history exists.
// Based on prompt size, maxOutputTokens, and model cascade behavior:
//   forecast:            large prompt (~20K chars), 8192 tokens out, model cascade
//   tts_pool:            largest response (16384 tokens out), ~200 messages generated
//   forecast_comparison: tiny prompt, 100 tokens out, single call, no cascade
//   game_summary:        medium prompt, 4096 tokens out, model cascade
//   chronicle:           medium prompt, 4096 tokens out, ~10 player paragraphs
//   graph_insights:      small prompt, 1024 tokens out, single paragraph
//   quick_training:      medium prompt, 4096 tokens out, 8 scenarios
//   training_hand:       large prompt, up to 12 API calls (validation retries)
const DEFAULTS: Record<string, number> = {
  forecast: 20,
  tts_pool: 30,
  forecast_comparison: 4,
  game_summary: 10,
  chronicle: 12,
  graph_insights: 5,
  quick_training: 12,
  training_hand: 15,
};

interface TimingData {
  [key: string]: number[];
}

function getTimingData(): TimingData {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch { return {}; }
}

function saveTimingData(data: TimingData): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

const activeTimers: Record<string, number> = {};

function startTiming(key: string): void {
  activeTimers[key] = Date.now();
}

function endTiming(key: string): void {
  const start = activeTimers[key];
  if (!start) return;
  delete activeTimers[key];

  const duration = (Date.now() - start) / 1000;
  const data = getTimingData();
  if (!data[key]) data[key] = [];
  data[key].push(Math.round(duration * 10) / 10);
  if (data[key].length > MAX_HISTORY) {
    data[key] = data[key].slice(-MAX_HISTORY);
  }
  saveTimingData(data);
}

/** Median of past runs + 15% buffer, or fallback default for first run */
export function getEstimatedDuration(key: string): number {
  const data = getTimingData();
  const history = data[key];
  if (!history || history.length === 0) {
    return DEFAULTS[key] || 15;
  }
  const sorted = [...history].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.ceil(median * 1.15);
}

/** Wrap any async AI call to automatically record its duration */
export async function withAITiming<T>(key: string, fn: () => Promise<T>): Promise<T> {
  startTiming(key);
  try {
    return await fn();
  } finally {
    endTiming(key);
  }
}
