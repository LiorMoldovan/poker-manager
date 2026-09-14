// Stand-in for src/utils/apiProxy.ts. In the app this POSTs to the Vercel
// edge function; here it records the exact prompt the real builder produced
// and (when a key is present) forwards straight to Google.
import { appendFileSync, readFileSync } from 'node:fs';

export interface Capture {
  label: string;
  model: string;
  prompt: string;
  response?: string;
  error?: string;
}

export const captures: Capture[] = [];
let currentLabel = 'unlabelled';
export const setCaptureLabel = (l: string) => { currentLabel = l; };

const KEY = process.env.GEMINI_API_KEY || '';
export const isLive = () => !!KEY;

// Replay a canned model response instead of calling Google. Lets us assert
// that the fact-check repairs fire on a known-defective answer, rather than
// waiting for the model to reproduce the defect on its own.
const INJECT = process.env.PROMPTLAB_INJECT
  ? readFileSync(process.env.PROMPTLAB_INJECT, 'utf8')
  : '';

// Simulate Gemini running out of output budget mid-sentence: the first N calls
// come back finishReason MAX_TOKENS with a fragment, exactly as a thinking
// model does when reasoning has eaten the budget. Set high to make every
// attempt truncate and exercise the last-resort path.
const TRUNCATE_FIRST = Number(process.env.PROMPTLAB_TRUNCATE || 0);
let truncatedSoFar = 0;
const FRAGMENT = 'משחק 13 בחציון שני 2026 ננעל בניצחון שיא אישי של אייל עם 320 שקלים בפלוס, שהקפיץ אותו למקום השביעי. ליאור חצה את רף ה-1000 שקלים בחציון עם פלוס 122 שקלים, בעוד אורן ביצע קאמבק של';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export async function proxyGeminiGenerate(
  version: string,
  model: string,
  _apiKey: string,
  payload: any,
): Promise<Response> {
  const prompt: string = payload?.contents?.[0]?.parts?.[0]?.text ?? '';
  const cap: Capture = { label: currentLabel, model, prompt };
  captures.push(cap);

  if (TRUNCATE_FIRST && truncatedSoFar < TRUNCATE_FIRST) {
    truncatedSoFar++;
    cap.response = FRAGMENT;
    cap.error = 'simulated MAX_TOKENS';
    return jsonResponse({
      candidates: [{ content: { parts: [{ text: FRAGMENT }] }, finishReason: 'MAX_TOKENS' }],
      usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 180, thoughtsTokenCount: 3900, totalTokenCount: 5580 },
    });
  }

  if (INJECT) {
    cap.response = INJECT;
    return jsonResponse({ candidates: [{ content: { parts: [{ text: INJECT }] } }] });
  }

  if (!KEY) {
    // Dry run: hand back a shaped-but-empty result so the caller finishes
    // cleanly and we still get the prompt out.
    cap.error = 'dry-run (no GEMINI_API_KEY)';
    return jsonResponse({ candidates: [{ content: { parts: [{ text: '{"players":[]}' }] } }] });
  }

  const url = `https://generativelanguage.googleapis.com/${version}/models/${model}:generateContent?key=${KEY}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    if (!res.ok) {
      cap.error = `HTTP ${res.status}: ${text.slice(0, 300)}`;
      appendFileSync('scripts/promptlab/out/errors.log', `${currentLabel} ${model} ${cap.error}\n`);
      return new Response(text, { status: res.status, headers: { 'Content-Type': 'application/json' } });
    }
    const parsed = JSON.parse(text);
    cap.response = parsed?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') ?? '';
    return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    cap.error = String(e);
    return jsonResponse({ error: { message: String(e) } }, 500);
  }
}

export const proxyGeminiGenerateWithSignal = (
  version: string, model: string, apiKey: string, payload: any,
) => proxyGeminiGenerate(version, model, apiKey, payload);

export const proxyGeminiModels = async () => jsonResponse({ models: [] });
export const pollinationsImage = async () => jsonResponse({});
