import { proxyGeminiGenerateWithSignal, proxyElevenLabsTTS, proxyElevenLabsUsage } from './apiProxy';
import { getSettings } from '../database/storage';
import { isElevenLabsEnabledForCurrentGroup } from './aiEligibility';

// Gender-aware Hebrew number words for TTS
// feminine=true for feminine nouns (קניות, פעמים, דקות)
// feminine=false for masculine nouns (נצחונות, הפסדים, משחקים, שחקנים, אחוז, שקלים)

// Standalone form — used when no noun follows ("סך הכל שתיים", "כבר שלוש")
export const hebrewNum = (n: number, feminine: boolean): string => {
  const abs = Math.round(Math.abs(n));
  if (abs === 0) return 'אפס';
  const femOnes = ['', 'אחת', 'שתיים', 'שלוש', 'ארבע', 'חמש', 'שש', 'שבע', 'שמונה', 'תשע', 'עשר'];
  const mascOnes = ['', 'אחד', 'שניים', 'שלושה', 'ארבעה', 'חמישה', 'שישה', 'שבעה', 'שמונה', 'תשעה', 'עשרה'];
  const ones = feminine ? femOnes : mascOnes;
  if (abs <= 10) return ones[abs];
  if (abs <= 19) {
    const unit = abs - 10;
    const tenWord = feminine ? 'עשרה' : 'עשר';
    return `${ones[unit]} ${tenWord}`;
  }
  if (abs <= 99) {
    const tensWords = ['', '', 'עשרים', 'שלושים', 'ארבעים', 'חמישים', 'שישים', 'שבעים', 'שמונים', 'תשעים'];
    const ten = Math.floor(abs / 10);
    const unit = abs % 10;
    if (unit === 0) return tensWords[ten];
    return `${tensWords[ten]} ו${ones[unit]}`;
  }
  if (abs === 100) return 'מאה';
  return String(abs);
};

// Construct form — used directly before a noun ("שתי קניות", "שני משחקים")
export const hebrewNumConstruct = (n: number, feminine: boolean): string => {
  const abs = Math.round(Math.abs(n));
  if (feminine && abs === 2) return 'שתי';
  if (!feminine && abs === 2) return 'שני';
  return hebrewNum(n, feminine);
};

// Ordinal form — for rankings/positions ("מקום ראשון", "מקום שני")
export const hebrewOrdinal = (n: number, feminine: boolean = false): string => {
  const abs = Math.round(Math.abs(n));
  if (feminine) {
    const fem = ['', 'ראשונה', 'שנייה', 'שלישית', 'רביעית', 'חמישית', 'שישית', 'שביעית', 'שמינית', 'תשיעית', 'עשירית'];
    if (abs >= 1 && abs <= 10) return fem[abs];
  } else {
    const masc = ['', 'ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שביעי', 'שמיני', 'תשיעי', 'עשירי'];
    if (abs >= 1 && abs <= 10) return masc[abs];
  }
  return hebrewNum(n, feminine);
};

// Convert any number (0–9999) to spoken Hebrew words for TTS
// feminine=true for feminine nouns (קניות), false for masculine (default)
export const numberToHebrewTTS = (n: number, feminine = false): string => {
  const abs = Math.round(Math.abs(n));
  if (abs === 0) return 'אפס';

  const mascOnes = ['', 'אחד', 'שניים', 'שלושה', 'ארבעה', 'חמישה', 'שישה', 'שבעה', 'שמונה', 'תשעה'];
  const femOnes = ['', 'אחת', 'שתיים', 'שלוש', 'ארבע', 'חמש', 'שש', 'שבע', 'שמונה', 'תשע'];
  const mascTeens = ['עשרה', 'אחד עשר', 'שנים עשר', 'שלושה עשר', 'ארבעה עשר', 'חמישה עשר', 'שישה עשר', 'שבעה עשר', 'שמונה עשר', 'תשעה עשר'];
  const femTeens = ['עשר', 'אחת עשרה', 'שתים עשרה', 'שלוש עשרה', 'ארבע עשרה', 'חמש עשרה', 'שש עשרה', 'שבע עשרה', 'שמונה עשרה', 'תשע עשרה'];
  const ones = feminine ? femOnes : mascOnes;
  const teens = feminine ? femTeens : mascTeens;
  const tens = ['', '', 'עשרים', 'שלושים', 'ארבעים', 'חמישים', 'שישים', 'שבעים', 'שמונים', 'תשעים'];
  const hundreds = ['', 'מאה', 'מאתיים', 'שלוש מאות', 'ארבע מאות', 'חמש מאות', 'שש מאות', 'שבע מאות', 'שמונה מאות', 'תשע מאות'];
  const thousands = ['', 'אלף', 'אלפיים', 'שלושת אלפים', 'ארבעת אלפים', 'חמשת אלפים', 'ששת אלפים', 'שבעת אלפים', 'שמונת אלפים', 'תשעת אלפים'];

  if (abs <= 9) return ones[abs];
  if (abs <= 19) return teens[abs - 10];
  if (abs <= 99) {
    const t = Math.floor(abs / 10), u = abs % 10;
    return u === 0 ? tens[t] : `${tens[t]} ו${ones[u]}`;
  }
  if (abs <= 999) {
    const h = Math.floor(abs / 100), rem = abs % 100;
    if (rem === 0) return hundreds[h];
    return `${hundreds[h]} ${rem < 20 ? 'ו' : ''}${numberToHebrewTTS(rem, feminine)}`;
  }
  if (abs <= 9999) {
    const th = Math.floor(abs / 1000), rem = abs % 1000;
    if (rem === 0) return thousands[th];
    return `${thousands[th]} ${rem < 100 ? 'ו' : ''}${numberToHebrewTTS(rem, feminine)}`;
  }
  return String(abs);
};

// Player-name pronunciation overrides for TTS.
// Hebrew without nikud is ambiguous, so engines fall back to the most common
// reading of a token — which for some surnames is the wrong word. Each entry
// respells the name phonetically (mater lectionis, not nikud, so it works on
// every engine incl. the browser voice). Add a new line per name as they're
// reported. Matching is whole-word only: the name must NOT be glued to another
// Hebrew letter (so prefixes like "לסגל" / common words aren't touched).
const NAME_PRONUNCIATION: Array<{ name: string; say: string }> = [
  // "סגל" defaults to "segel" (staff). The player is Segal → "se-GAL".
  { name: 'סגל', say: 'סגאל' },
];

function fixNamePronunciation(text: string): string {
  let r = text;
  for (const { name, say } of NAME_PRONUNCIATION) {
    const re = new RegExp(`(^|[^\\u0590-\\u05FF])${name}(?=$|[^\\u0590-\\u05FF])`, 'g');
    r = r.replace(re, `$1${say}`);
  }
  return r;
}

// Feminine nouns that take the feminine number form. TTS engines (and the
// legacy digit→word pass) default to the masculine form, so "5 קניות" comes
// out "חמישה קניות" instead of "חמש קניות". We spell these counts out in the
// correct gender BEFORE the engine reads them, so Gemini doesn't have to guess
// and the legacy masculine pass never touches them.
const FEMININE_COUNTED_NOUNS = 'קניות|קנייה|פעמים|פעם|דקות|דקה|שעות|שעה|ידיים|נקודות|נקודה|שניות|שנייה|מחציות';

function fixFeminineCounts(text: string): string {
  // JS \b is ASCII-only and never fires next to Hebrew letters, so the noun
  // boundary is a negative lookahead for another Hebrew letter instead.
  const re = new RegExp(`(\\d+)(\\s+ה?)(${FEMININE_COUNTED_NOUNS})(?![\\u0590-\\u05FF])`, 'g');
  return text.replace(re, (m, numStr, sep, noun) => {
    const n = parseInt(numStr, 10);
    if (isNaN(n) || n > 9999) return m;
    return `${numberToHebrewTTS(n, true)}${sep}${noun}`;
  });
}

// Fix common Hebrew grammar/pronunciation issues for TTS
function fixHebrewForTTS(text: string): string {
  let r = text;

  // Player names whose default Hebrew reading is the wrong word
  r = fixNamePronunciation(r);

  // Feminine-counted numbers → feminine form (before any masculine digit pass)
  r = fixFeminineCounts(r);

  // Construct form: "שתיים" directly before a Hebrew word → "שתי"
  r = r.replace(/שתיים(?=\s+[\u0590-\u05FF])/g, 'שתי');
  r = r.replace(/שניים(?=\s+[\u0590-\u05FF])/g, 'שני');

  // Prefixed forms: "בשתיים" / "ושתיים" before noun
  r = r.replace(/בשתיים(?=\s+[\u0590-\u05FF])/g, 'בשתי');
  r = r.replace(/בשניים(?=\s+[\u0590-\u05FF])/g, 'בשני');
  r = r.replace(/ושתיים(?=\s+[\u0590-\u05FF])/g, 'ושתי');
  r = r.replace(/ושניים(?=\s+[\u0590-\u05FF])/g, 'ושני');

  // Cardinal → ordinal in ranking context ("במקום אחד" → "במקום ראשון")
  r = r.replace(/במקום אחד/g, 'במקום ראשון');
  r = r.replace(/מקום אחד/g, 'מקום ראשון');
  r = r.replace(/במקום שניים/g, 'במקום שני');
  r = r.replace(/במקום שלושה/g, 'במקום שלישי');
  r = r.replace(/במקום ארבעה/g, 'במקום רביעי');
  r = r.replace(/במקום חמישה/g, 'במקום חמישי');

  // English poker terms → Hebrew (TTS butchers English words in Hebrew context)
  r = r.replace(/bad beat/gi, 'יד כואבת');
  r = r.replace(/big hand/gi, 'יד ענקית');
  r = r.replace(/באד ביט/g, 'יד כואבת');
  r = r.replace(/ביג הנד/g, 'יד ענקית');

  // Legacy: ₪ symbol cleanup (no longer used in UI, kept for safety)
  r = r.replace(/₪(\d)/g, '$1 שקל');
  r = r.replace(/₪/g, '');

  // % → "אחוז"
  r = r.replace(/(\d+)%/g, '$1 אחוז');

  // Remove emoji
  r = r.replace(/[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FEFF}]|[\u{1F900}-\u{1F9FF}]|[⚡⭐❄🎙🏆🎰👑📉📅🎲💰🍕🔮🏁]/gu, '');

  // Clean up double spaces
  r = r.replace(/\s{2,}/g, ' ').trim();

  return r;
}

// Preprocess text for legacy TTS engines (Cloud TTS / Browser SpeechSynthesis)
export const prepareTTSText = (text: string): string => {
  // 1) Feminine-counted nouns first (needs digits intact) → feminine words.
  // 2) Convert remaining digits with the masculine default (shekel/percent/
  //    games/wins/losses are masculine).
  // 3) Grammar/name/construct fixes last, so the "שניים→שני before a noun"
  //    fix lands on numbers produced by step 2.
  let result = fixFeminineCounts(text);
  result = result.replace(/\d+/g, (match) => {
    const num = parseInt(match, 10);
    if (isNaN(num) || num > 9999) return match;
    return numberToHebrewTTS(num);
  });
  result = fixHebrewForTTS(result);
  return result;
};

// Lighter preprocessing for Gemini TTS — it handles numbers/Hebrew natively,
// but still need to clean symbols and fix grammar
function prepareGeminiTTSText(text: string): string {
  return fixHebrewForTTS(text);
}

// ---------------------------------------------------------------------------
// TTS Status Reporting (debug overlay in LiveGameScreen subscribes)
// ---------------------------------------------------------------------------

type TTSStatusCallback = (entry: { text: string; type: 'info' | 'warn' | 'success' | 'error' }) => void;
let _ttsStatusCb: TTSStatusCallback | null = null;

export function setTTSStatusCallback(cb: TTSStatusCallback | null) {
  _ttsStatusCb = cb;
}

function ttsStatus(text: string, type: 'info' | 'warn' | 'success' | 'error' = 'info') {
  _ttsStatusCb?.({ text, type });
}


// ---------------------------------------------------------------------------
// Gemini TTS (uses same API key as AI features — best Hebrew quality)
// ---------------------------------------------------------------------------

// Gemini TTS URL now routed through apiProxy.ts (proxyGeminiGenerateWithSignal)
const GEMINI_TTS_MODELS = [
  'gemini-2.5-flash-preview-tts',
];
const GEMINI_TTS_VOICES = ['Kore', 'Aoede', 'Charon', 'Puck', 'Orus', 'Zephyr'];

let _geminiTTSModel: string | null = null;
let _geminiTTSVoice: string | null = null;
const _modelBlockedUntil = new Map<string, number>();
const GEMINI_BLOCK_DURATION_MS = 60 * 1000;
const GEMINI_FETCH_TIMEOUT_MS = 9000;

function isModelBlocked(model: string): boolean {
  const until = _modelBlockedUntil.get(model);
  if (!until) return false;
  if (Date.now() >= until) {
    _modelBlockedUntil.delete(model);
    return false;
  }
  return true;
}

function blockModel(model: string) {
  _modelBlockedUntil.set(model, Date.now() + GEMINI_BLOCK_DURATION_MS);
}

const GEMINI_TTS_STYLE = `Audio Profile: מגיש פוקר ישראלי. אנרגטי, חברי, עם חיוך בקול.
Director's Notes: קרא את הטקסט בעברית טבעית ישראלית. הגייה ברורה וטבעית. הנח הפסקה קצרה בכל נקודה.`;

function trimLeadingSilence(pcmBytes: Uint8Array, sampleRate: number): Uint8Array {
  try {
    const bytesPerSample = 2;
    const totalSamples = Math.floor(pcmBytes.length / bytesPerSample);
    if (totalSamples < sampleRate * 0.05) return pcmBytes;

    const threshold = 150;
    const maxScanSamples = Math.min(totalSamples, sampleRate * 4);
    const stride = 16;
    let firstLoudSample = 0;

    for (let i = 0; i < maxScanSamples; i += stride) {
      const offset = i * bytesPerSample;
      const sample = pcmBytes[offset] | (pcmBytes[offset + 1] << 8);
      const signed = sample > 32767 ? sample - 65536 : sample;
      if (Math.abs(signed) > threshold) {
        firstLoudSample = Math.max(0, i - Math.floor(sampleRate * 0.01));
        break;
      }
    }

    const maxTrimBySamples = Math.floor(totalSamples * 0.6);
    const maxTrimByTime = sampleRate * 3;
    const maxTrim = Math.min(maxTrimBySamples, maxTrimByTime);
    if (firstLoudSample > maxTrim) firstLoudSample = maxTrim;

    const trimBytes = firstLoudSample * bytesPerSample;
    return trimBytes > 0 ? pcmBytes.slice(trimBytes) : pcmBytes;
  } catch {
    return pcmBytes;
  }
}

function pcmToWavUrl(pcmBase64: string): string {
  const binaryStr = atob(pcmBase64);
  const rawPcmBytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    rawPcmBytes[i] = binaryStr.charCodeAt(i);
  }

  const sampleRate = 24000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const pcmBytes = trimLeadingSilence(rawPcmBytes, sampleRate);
  const dataSize = pcmBytes.length;
  const headerSize = 44;

  const buffer = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bitsPerSample / 8, true);
  view.setUint16(32, numChannels * bitsPerSample / 8, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  new Uint8Array(buffer).set(pcmBytes, headerSize);

  const blob = new Blob([buffer], { type: 'audio/wav' });
  return URL.createObjectURL(blob);
}

async function speakWithGeminiTTS(messages: string[], apiKey: string, onBeforePlay?: () => void | Promise<void>): Promise<boolean> {
  if (!apiKey || messages.length === 0) return false;

  const availableModels = GEMINI_TTS_MODELS.filter(m => !isModelBlocked(m));
  if (availableModels.length === 0) {
    ttsStatus('Gemini TTS blocked, skipping', 'info');
    return false;
  }

  const combinedText = messages.map(m => prepareGeminiTTSText(m)).join('. ');
  const fullPrompt = `${GEMINI_TTS_STYLE}\n\n${combinedText}`;

  const modelsToTry = _geminiTTSModel && availableModels.includes(_geminiTTSModel)
    ? [_geminiTTSModel, ...availableModels.filter(m => m !== _geminiTTSModel)]
    : availableModels;
  const voiceToUse = _geminiTTSVoice || GEMINI_TTS_VOICES[Math.floor(Math.random() * GEMINI_TTS_VOICES.length)];

  const shortModel = (m: string) => m.includes('-preview-tts') ? 'flash-tts' : m.replace('gemini-', '').replace('-preview', '');

  for (const model of modelsToTry) {
    const voice = voiceToUse;
    try {
      ttsStatus(`Trying ${shortModel(model)} / ${voice}...`, 'info');
      const t0 = Date.now();

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), GEMINI_FETCH_TIMEOUT_MS);

      const res = await proxyGeminiGenerateWithSignal('v1beta', model, apiKey, {
        contents: [{ parts: [{ text: fullPrompt }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: voice,
              },
            },
          },
        },
      }, controller.signal);
      clearTimeout(timeoutId);
      const elapsed = Date.now() - t0;

      if (!res.ok) {
        const status = res.status;
        console.warn(`🔇 Gemini TTS: ${model}/${voice} → HTTP ${status}`);
        if (status === 429) {
          blockModel(model);
          ttsStatus(`${shortModel(model)} rate-limited — retry in 1 min`, 'warn');
        } else {
          ttsStatus(`${shortModel(model)} → ${status}`, 'warn');
        }
        continue;
      }
      const data = await res.json();

      const audioBase64 = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!audioBase64) {
        console.warn(`🔇 Gemini TTS: ${model}/${voice} → no audio data`);
        ttsStatus(`${shortModel(model)} → no audio`, 'warn');
        continue;
      }

      ttsStatus(`Playing audio (${shortModel(model)}/${voice}, ${elapsed}ms)`, 'success');

      await onBeforePlay?.();
      const wavUrl = pcmToWavUrl(audioBase64);
      try {
        await playAudioUrl(wavUrl);
      } finally {
        URL.revokeObjectURL(wavUrl);
      }

      _geminiTTSModel = model;
      _geminiTTSVoice = voice;
      _modelBlockedUntil.delete(model);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isTimeout = msg.includes('abort');
      console.warn(`🔇 Gemini TTS: ${model}/${voice} → exception:`, msg);
      if (isTimeout) blockModel(model);
      ttsStatus(`${shortModel(model)} → ${isTimeout ? 'timeout, retry in 1 min' : 'error'}`, 'warn');
      continue;
    }
  }

  return false;
}

let _audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!_audioCtx || _audioCtx.state === 'closed') {
    _audioCtx = new AudioContext();
  }
  if (_audioCtx.state === 'suspended') {
    _audioCtx.resume();
  }
  return _audioCtx;
}

export function warmupAudioContext(): void {
  try { getAudioContext(); } catch { /* ignore */ }
}

async function playAudioUrl(url: string): Promise<void> {
  try {
    const ctx = getAudioContext();
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    return new Promise<void>((resolve) => {
      source.onended = () => resolve();
      source.start(0);
    });
  } catch {
    return new Promise((resolve, reject) => {
      const audio = new Audio(url);
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error('audio_error'));
      audio.play().catch(reject);
    });
  }
}

// ---------------------------------------------------------------------------
// ElevenLabs TTS — high-quality neural voices (free tier: 10,000 chars/month)
// Requires API key with Text to Speech + Voices Read permissions
// ---------------------------------------------------------------------------

// ElevenLabs TTS URL now routed through apiProxy.ts (proxyElevenLabsTTS)
const ELEVENLABS_VOICES = [
  'CwhRBWXzGAHq8TQ4Fs17',  // Roger
  'JBFqnCBsd6RMkjVDRZzb',  // George
  'pNInz6obpgDQGcFmaJgB',  // Adam
];
const ELEVENLABS_TIMEOUT_MS = 10000;
// See `getGeminiApiKey` in geminiAI.ts for the full rationale — same shape:
// returns the per-group key when set, the `'server-managed'` sentinel only
// when the current group is the platform-owner group (so the server may
// fall back to the env-var key), or `null` for every other group without
// its own key (so UI surfaces hide TTS affordances cleanly instead of
// quietly draining the platform owner's ElevenLabs quota).
export const getElevenLabsApiKey = (): string | null => {
  const key = getSettings()?.elevenlabsApiKey;
  if (key && key.trim()) return key;
  return isElevenLabsEnabledForCurrentGroup() ? 'server-managed' : null;
};

export async function getElevenLabsUsageLive(apiKey: string): Promise<{ used: number; limit: number; remaining: number; resetDate: string } | null> {
  try {
    const res = await proxyElevenLabsUsage(apiKey);
    if (!res.ok) return null;
    const data = await res.json();
    const used = data.character_count ?? 0;
    const limit = data.character_limit ?? 10000;
    const resetUnix = data.next_character_count_reset_unix;
    const resetDate = resetUnix ? new Date(resetUnix * 1000).toLocaleDateString('he-IL') : '';
    return { used, limit, remaining: Math.max(0, limit - used), resetDate };
  } catch {
    return null;
  }
}

let _elevenLabsVoice: string | null = null;
let _elevenLabsCharsUsedSession = 0;
let _currentGameId: string | null = null;
let _currentGameChars = 0;

const EL_GAME_HISTORY_KEY = 'elevenlabs_game_history';
const EL_MAX_HISTORY = 20;

export interface ElevenLabsGameEntry {
  gameId: string;
  date: string;
  charsUsed: number;
  calls: number;
}

function saveGameUsage() {
  if (!_currentGameId || _currentGameChars === 0) return;
  try {
    const raw = localStorage.getItem(EL_GAME_HISTORY_KEY);
    const history: ElevenLabsGameEntry[] = raw ? JSON.parse(raw) : [];
    const existing = history.find(h => h.gameId === _currentGameId);
    if (existing) {
      existing.charsUsed = _currentGameChars;
      existing.calls++;
    } else {
      history.unshift({
        gameId: _currentGameId,
        date: new Date().toISOString(),
        charsUsed: _currentGameChars,
        calls: 1,
      });
    }
    localStorage.setItem(EL_GAME_HISTORY_KEY, JSON.stringify(history.slice(0, EL_MAX_HISTORY)));
  } catch { /* localStorage full or unavailable */ }
}

export function getElevenLabsGameHistory(): ElevenLabsGameEntry[] {
  try {
    const raw = localStorage.getItem(EL_GAME_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function deleteElevenLabsGameEntry(gameId: string): void {
  try {
    const raw = localStorage.getItem(EL_GAME_HISTORY_KEY);
    const history: ElevenLabsGameEntry[] = raw ? JSON.parse(raw) : [];
    localStorage.setItem(EL_GAME_HISTORY_KEY, JSON.stringify(history.filter(h => h.gameId !== gameId)));
  } catch { /* ignore */ }
}

async function speakWithElevenLabs(messages: string[], apiKey: string, onBeforePlay?: () => void | Promise<void>): Promise<boolean> {
  if (!apiKey || messages.length === 0) return false;

  // eleven_v3 handles Hebrew natively — only clean symbols/emoji, don't expand numbers
  const combinedText = messages.map(m => fixHebrewForTTS(m)).join('. ');

  // Quota guard: skip if this text would exceed the monthly limit
  const estimatedCost = combinedText.length;
  if (_elevenLabsCharsUsedSession + estimatedCost > 10000) {
    const remaining = Math.max(0, 10000 - _elevenLabsCharsUsedSession);
    ttsStatus(`ElevenLabs → quota exhausted (~${remaining} left), falling back`, 'info');
    return false;
  }

  const voice = _elevenLabsVoice || ELEVENLABS_VOICES[Math.floor(Math.random() * ELEVENLABS_VOICES.length)];

  ttsStatus('Trying ElevenLabs TTS...', 'info');
  const t0 = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ELEVENLABS_TIMEOUT_MS);

    const res = await proxyElevenLabsTTS(
      apiKey,
      voice,
      { text: combinedText, model_id: 'eleven_v3', language_code: 'he' },
      'mp3_22050_32',
      controller.signal
    );
    clearTimeout(timeoutId);
    const elapsed = Date.now() - t0;

    if (!res.ok) {
      const status = res.status;
      console.warn(`🔇 ElevenLabs TTS: HTTP ${status}`);
      if (status === 401 || status === 402) {
        ttsStatus('ElevenLabs → key/permissions error', 'error');
      } else if (status === 429) {
        ttsStatus('ElevenLabs → quota exceeded', 'warn');
      } else {
        ttsStatus(`ElevenLabs → ${status}`, 'warn');
      }
      return false;
    }

    const charCost = parseInt(res.headers.get('character-cost') || '0', 10);
    if (charCost > 0) {
      _elevenLabsCharsUsedSession += charCost;
      _currentGameChars += charCost;
      saveGameUsage();
    }

    const blob = await res.blob();
    if (!blob || blob.size < 100) {
      ttsStatus('ElevenLabs → empty audio', 'warn');
      return false;
    }

    const remaining = Math.max(0, 10000 - _elevenLabsCharsUsedSession);
    ttsStatus(`Playing ElevenLabs (${elapsed}ms) | ${charCost} used, ~${remaining} left`, 'success');

    await onBeforePlay?.();
    const url = URL.createObjectURL(blob);
    try {
      await playAudioUrl(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    _elevenLabsVoice = voice;
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('🔇 ElevenLabs TTS failed:', msg);
    ttsStatus(`ElevenLabs → ${msg.includes('abort') ? 'timeout' : 'failed'}`, 'warn');
    return false;
  }
}

export function initElevenLabsSession(usedChars: number, gameId?: string) {
  _elevenLabsCharsUsedSession = usedChars;
  if (gameId) {
    _currentGameId = gameId;
    _currentGameChars = 0;
    const history = getElevenLabsGameHistory();
    const existing = history.find(h => h.gameId === gameId);
    if (existing) _currentGameChars = existing.charsUsed;
  }
}

// ---------------------------------------------------------------------------
// Edge TTS — Microsoft Neural voices via WebSocket (free, no API key)
// ---------------------------------------------------------------------------

const EDGE_TTS_VOICES_HEBREW = ['he-IL-HilaNeural', 'he-IL-AvriNeural'];
const EDGE_TTS_VOICES_MULTILINGUAL = [
  'en-US-AvaMultilingualNeural',
  'en-US-AndrewMultilingualNeural',
  'en-US-EmmaMultilingualNeural',
  'en-US-BrianMultilingualNeural',
];
export const EDGE_TTS_ALL_VOICES = [...EDGE_TTS_VOICES_HEBREW, ...EDGE_TTS_VOICES_MULTILINGUAL];
const EDGE_TTS_TIMEOUT_MS = 8000;

export function isEdgeBrowser(): boolean {
  return /Edg[eA]?\//i.test(navigator.userAgent);
}

async function speakWithEdgeTTS(messages: string[], onBeforePlay?: () => void | Promise<void>): Promise<boolean> {
  if (messages.length === 0) return false;

  if (!isEdgeBrowser()) {
    ttsStatus('Edge TTS → skipped (not Edge browser)', 'info');
    return false;
  }

  try {
    const { default: EdgeTTSBrowser } = await import('@kingdanx/edge-tts-browser');

    const combinedText = messages.map(m => prepareTTSText(m)).join('. ');
    const voice = EDGE_TTS_VOICES_HEBREW[Math.floor(Math.random() * EDGE_TTS_VOICES_HEBREW.length)];

    ttsStatus(`Trying Edge TTS / ${voice.replace('he-IL-', '')}...`, 'info');
    const t0 = Date.now();

    const tts = new EdgeTTSBrowser({ text: combinedText, voice });

    const blob: Blob = await Promise.race([
      tts.ttsToFile(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('timeout')), EDGE_TTS_TIMEOUT_MS)
      ),
    ]);

    if (!blob || blob.size < 100) {
      ttsStatus('Edge TTS → empty audio', 'warn');
      return false;
    }

    const elapsed = Date.now() - t0;
    ttsStatus(`Playing Edge TTS (${voice.replace('he-IL-', '')}, ${elapsed}ms)`, 'success');

    await onBeforePlay?.();
    const url = URL.createObjectURL(blob);
    try {
      await playAudioUrl(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('🔇 Edge TTS failed:', msg);
    ttsStatus(`Edge TTS → ${msg.includes('timeout') ? 'timeout' : 'failed'}`, 'warn');
    return false;
  }
}

// ---------------------------------------------------------------------------
// Browser SpeechSynthesis (always available)
// ---------------------------------------------------------------------------

// Pre-warm voice loading — Chrome loads voices async, first getVoices() returns []
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  window.speechSynthesis.getVoices();
  window.speechSynthesis.addEventListener?.('voiceschanged', () => {
    window.speechSynthesis.getVoices();
  });
}

export const getBestHebrewVoice = (): SpeechSynthesisVoice | null => {
  const voices = window.speechSynthesis.getVoices();
  const heb = voices.filter(v => v.lang.startsWith('he'));
  if (heb.length === 0) return null;
  return heb.find(v => v.name.toLowerCase().includes('natural'))
    || heb.find(v => v.name.toLowerCase().includes('google'))
    || heb.find(v => v.name.toLowerCase().includes('online'))
    || heb.find(v => !v.localService)
    || heb[0];
};

export const createHebrewUtterance = (text: string, voice: SpeechSynthesisVoice | null): SpeechSynthesisUtterance => {
  const utt = new SpeechSynthesisUtterance(prepareTTSText(text));
  utt.lang = 'he-IL';
  if (voice) utt.voice = voice;
  utt.rate = 0.85;
  utt.pitch = 1.0;
  utt.volume = 1;
  return utt;
};

function speakWithBrowser(messages: string[], onBeforePlay?: () => void | Promise<void>): boolean {
  if (!('speechSynthesis' in window) || messages.length === 0) {
    return false;
  }

  // Chrome bug: cancel() right before speak() can freeze the queue.
  // A small delay after cancel lets the engine reset.
  window.speechSynthesis.cancel();

  let voice = getBestHebrewVoice();
  if (!voice) {
    const allVoices = window.speechSynthesis.getVoices();
    if (allVoices.length > 0) {
      voice = allVoices[0];
    }
  }

  console.log(`🔊 Browser TTS: speaking ${messages.length} msg(s), voice="${voice?.name || 'default'}"`);

  const combined = messages.join('. ');
  const utt = createHebrewUtterance(combined, voice);
  utt.onerror = (e) => console.warn('🔇 Browser TTS error:', e);

  onBeforePlay?.();
  window.speechSynthesis.speak(utt);
  return true;
}

// ---------------------------------------------------------------------------
// Main entry point — cascading TTS engine selection
// ---------------------------------------------------------------------------

export interface SpeakOptions {
  freeOnly?: boolean;
  onBeforePlay?: () => void | Promise<void>;
}

/**
 * Speak Hebrew messages with the best available TTS engine:
 * 1. Gemini TTS — AI-powered, uses same API key as AI features (excellent Hebrew)
 * 2. ElevenLabs TTS — high-quality neural voices (free tier: 10,000 chars/month)
 * 3. Edge TTS — Microsoft Neural voices via WebSocket (free, good Hebrew)
 * 4. Browser SpeechSynthesis — fallback, depends on device Hebrew voice support
 *
 * Pass { freeOnly: true } to skip paid engines (Gemini/ElevenLabs) and save quota.
 */
export async function speakHebrew(messages: string[], apiKey: string | null, options?: SpeakOptions): Promise<void> {
  if (messages.length === 0) return;

  const freeOnly = options?.freeOnly ?? false;

  const onBeforePlay = options?.onBeforePlay;

  ttsStatus(`TTS start (${messages.length} msg${freeOnly ? ', free-only' : ''}, ${messages[0].slice(0, 40)}...)`, 'info');

  if (!freeOnly) {
    if (apiKey) {
      try {
        const ok = await speakWithGeminiTTS(messages, apiKey, onBeforePlay);
        if (ok) {
          ttsStatus('Done ✓', 'success');
          return;
        }
      } catch (_e) {
        // fall through to ElevenLabs
      }
    }

    const elKey = getElevenLabsApiKey();
    if (elKey) {
      try {
        const ok = await speakWithElevenLabs(messages, elKey, onBeforePlay);
        if (ok) {
          ttsStatus('Done ✓', 'success');
          return;
        }
      } catch (_e) {
        // fall through to Edge TTS
      }
    }
  }

  try {
    const ok = await speakWithEdgeTTS(messages, onBeforePlay);
    if (ok) {
      ttsStatus('Done ✓', 'success');
      return;
    }
  } catch (_e) {
    // fall through to browser
  }

  ttsStatus('Falling back to Browser TTS', 'warn');
  const ok = speakWithBrowser(messages, onBeforePlay);
  ttsStatus(ok ? 'Browser TTS playing' : 'ALL engines failed', ok ? 'success' : 'error');
}
