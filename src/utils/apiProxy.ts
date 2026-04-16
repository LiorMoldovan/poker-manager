import { USE_SUPABASE } from '../database/config';
import { supabase } from '../database/supabaseClient';
import { getSettings } from '../database/storage';

async function getAuthHeaders(): Promise<Record<string, string>> {
  if (!USE_SUPABASE) return {};
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token) {
      return { 'Authorization': `Bearer ${session.access_token}` };
    }
  } catch { /* session unavailable — proceed without auth */ }
  return {};
}

function getGroupGeminiKey(): string | undefined {
  if (!USE_SUPABASE) return undefined;
  return getSettings()?.geminiApiKey || undefined;
}

function getGroupElevenLabsKey(): string | undefined {
  if (!USE_SUPABASE) return undefined;
  return getSettings()?.elevenlabsApiKey || undefined;
}

export async function proxyGeminiGenerate(
  version: string,
  model: string,
  apiKey: string,
  payload: unknown
): Promise<Response> {
  if (USE_SUPABASE) {
    const auth = await getAuthHeaders();
    const groupKey = getGroupGeminiKey();
    return fetch('/api/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ version, model, payload, ...(groupKey && { apiKey: groupKey }) }),
    });
  }
  const modelPath = model.startsWith('models/') ? model : `models/${model}`;
  const url = `https://generativelanguage.googleapis.com/${version}/${modelPath}:generateContent?key=${apiKey}`;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function proxyGeminiGenerateWithSignal(
  version: string,
  model: string,
  apiKey: string,
  payload: unknown,
  signal?: AbortSignal
): Promise<Response> {
  if (USE_SUPABASE) {
    const auth = await getAuthHeaders();
    const groupKey = getGroupGeminiKey();
    return fetch('/api/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ version, model, payload, ...(groupKey && { apiKey: groupKey }) }),
      signal,
    });
  }
  const modelPath = model.startsWith('models/') ? model : `models/${model}`;
  const url = `https://generativelanguage.googleapis.com/${version}/${modelPath}:generateContent?key=${apiKey}`;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
}

export async function proxyGeminiModels(apiKey: string, version = 'v1beta'): Promise<Response> {
  if (USE_SUPABASE) {
    const auth = await getAuthHeaders();
    const groupKey = getGroupGeminiKey();
    const params = new URLSearchParams({ version });
    if (groupKey) params.set('apiKey', groupKey);
    return fetch(`/api/gemini-models?${params}`, {
      headers: auth,
    });
  }
  return fetch(`https://generativelanguage.googleapis.com/${version}/models?key=${apiKey}`);
}

export async function proxyElevenLabsTTS(
  apiKey: string,
  voiceId: string,
  payload: { text: string; model_id: string; language_code: string },
  outputFormat = 'mp3_22050_32',
  signal?: AbortSignal
): Promise<Response> {
  if (USE_SUPABASE) {
    const auth = await getAuthHeaders();
    const groupKey = getGroupElevenLabsKey();
    return fetch('/api/elevenlabs-tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ voiceId, outputFormat, payload, ...(groupKey && { apiKey: groupKey }) }),
      signal,
    });
  }
  return fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${outputFormat}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': apiKey,
    },
    body: JSON.stringify(payload),
    signal,
  });
}

export async function proxyElevenLabsUsage(apiKey: string): Promise<Response> {
  if (USE_SUPABASE) {
    const auth = await getAuthHeaders();
    const groupKey = getGroupElevenLabsKey();
    const params = new URLSearchParams();
    if (groupKey) params.set('apiKey', groupKey);
    const qs = params.toString();
    return fetch(`/api/elevenlabs-usage${qs ? `?${qs}` : ''}`, { headers: auth });
  }
  return fetch('https://api.elevenlabs.io/v1/user/subscription', {
    headers: { 'xi-api-key': apiKey },
  });
}

export function isServerManagedKey(): boolean {
  return USE_SUPABASE;
}
