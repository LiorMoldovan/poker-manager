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
  const params = new URLSearchParams({ version });
  if (groupKey) params.set('apiKey', groupKey);
  return fetch(`/api/gemini-models?${params}`, {
    headers: auth,
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
  const params = new URLSearchParams();
  if (groupKey) params.set('apiKey', groupKey);
  const qs = params.toString();
  return fetch(`/api/elevenlabs-usage${qs ? `?${qs}` : ''}`, { headers: auth });
}

