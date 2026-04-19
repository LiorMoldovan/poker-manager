import { supabase } from '../database/supabaseClient';
import { getSettings } from '../database/storage';

async function getAuthHeaders(): Promise<Record<string, string>> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token) {
      return { 'Authorization': `Bearer ${session.access_token}` };
    }
  } catch { /* session unavailable — proceed without auth */ }
  return {};
}

function getGroupGeminiKey(): string | undefined {
  return getSettings()?.geminiApiKey || undefined;
}

function getGroupElevenLabsKey(): string | undefined {
  return getSettings()?.elevenlabsApiKey || undefined;
}

export async function proxyGeminiGenerate(
  version: string,
  model: string,
  _apiKey: string,
  payload: unknown
): Promise<Response> {
  const auth = await getAuthHeaders();
  const groupKey = getGroupGeminiKey();
  return fetch('/api/gemini', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ version, model, payload, ...(groupKey && { apiKey: groupKey }) }),
  });
}

export async function proxyGeminiGenerateWithSignal(
  version: string,
  model: string,
  _apiKey: string,
  payload: unknown,
  signal?: AbortSignal
): Promise<Response> {
  const auth = await getAuthHeaders();
  const groupKey = getGroupGeminiKey();
  return fetch('/api/gemini', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ version, model, payload, ...(groupKey && { apiKey: groupKey }) }),
    signal,
  });
}

export async function proxyGeminiModels(_apiKey: string, version = 'v1beta'): Promise<Response> {
  const auth = await getAuthHeaders();
  const groupKey = getGroupGeminiKey();
  return fetch('/api/gemini-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ version, ...(groupKey && { apiKey: groupKey }) }),
  });
}

export async function proxyElevenLabsTTS(
  _apiKey: string,
  voiceId: string,
  payload: { text: string; model_id: string; language_code: string },
  outputFormat = 'mp3_22050_32',
  signal?: AbortSignal
): Promise<Response> {
  const auth = await getAuthHeaders();
  const groupKey = getGroupElevenLabsKey();
  return fetch('/api/elevenlabs-tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ voiceId, outputFormat, payload, ...(groupKey && { apiKey: groupKey }) }),
    signal,
  });
}

export async function proxyElevenLabsUsage(_apiKey: string): Promise<Response> {
  const auth = await getAuthHeaders();
  const groupKey = getGroupElevenLabsKey();
  return fetch('/api/elevenlabs-usage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify({ ...(groupKey && { apiKey: groupKey }) }),
  });
}

export async function proxySendEmail(payload: {
  to: string;
  subject: string;
  playerName: string;
  reporterName: string;
  amount: number;
  gameDate?: string;
  payLink?: string;
}): Promise<boolean> {
  try {
    const auth = await getAuthHeaders();
    const res = await fetch('/api/send-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function proxySendPush(payload: {
  groupId: string;
  title: string;
  body: string;
  targetPlayerNames?: string[];
  url?: string;
}): Promise<{ sent: number; total: number } | null> {
  try {
    const auth = await getAuthHeaders();
    const res = await fetch('/api/send-push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

