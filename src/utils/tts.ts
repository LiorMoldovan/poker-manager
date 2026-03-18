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

// Fix common Hebrew grammar/pronunciation issues for TTS
function fixHebrewForTTS(text: string): string {
  let r = text;

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

  // ₪ symbol → "שקל" (TTS reads it as gibberish)
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
  let result = text;
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
// Gemini TTS (uses same API key as AI features — best Hebrew quality)
// ---------------------------------------------------------------------------

const GEMINI_TTS_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';
const GEMINI_TTS_MODELS = ['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts'];
const GEMINI_TTS_VOICES = ['Kore', 'Aoede', 'Charon', 'Puck'];

let _geminiTTSModel: string | null = null;
let _geminiTTSVoice: string | null = null;
let _geminiTTSFailed = false;

const GEMINI_TTS_STYLE = `Audio Profile: מגיש פוקר ישראלי. אנרגטי, חברי, עם חיוך בקול.
Director's Notes: קרא את הטקסט בעברית טבעית ישראלית. הגייה ברורה וטבעית. הנח הפסקה קצרה בכל נקודה.`;

function pcmToWavUrl(pcmBase64: string): string {
  const binaryStr = atob(pcmBase64);
  const pcmBytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    pcmBytes[i] = binaryStr.charCodeAt(i);
  }

  const sampleRate = 24000;
  const numChannels = 1;
  const bitsPerSample = 16;
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

async function speakWithGeminiTTS(messages: string[], apiKey: string): Promise<boolean> {
  if (_geminiTTSFailed || !apiKey || messages.length === 0) return false;

  // Combine messages into one text for a single API call
  const combinedText = messages.map(m => prepareGeminiTTSText(m)).join('. ');
  const fullPrompt = `${GEMINI_TTS_STYLE}\n\n${combinedText}`;

  const modelsToTry = _geminiTTSModel ? [_geminiTTSModel] : GEMINI_TTS_MODELS;
  const voicesToTry = _geminiTTSVoice ? [_geminiTTSVoice] : GEMINI_TTS_VOICES;

  for (const model of modelsToTry) {
    for (const voice of voicesToTry) {
      try {
        const res = await fetch(
          `${GEMINI_TTS_URL}${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
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
            }),
          }
        );

        if (!res.ok) continue;
        const data = await res.json();

        const audioBase64 = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (!audioBase64) continue;

        const wavUrl = pcmToWavUrl(audioBase64);
        try {
          await playAudioUrl(wavUrl);
        } finally {
          URL.revokeObjectURL(wavUrl);
        }

        _geminiTTSModel = model;
        _geminiTTSVoice = voice;
        return true;
      } catch {
        continue;
      }
    }
  }

  _geminiTTSFailed = true;
  return false;
}

// ---------------------------------------------------------------------------
// Google Cloud TTS (needs API key with TTS API enabled)
// ---------------------------------------------------------------------------

const CLOUD_TTS_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const CLOUD_VOICES = [
  'he-IL-Wavenet-C', 'he-IL-Wavenet-A',
  'he-IL-Neural2-A',
  'he-IL-Standard-C', 'he-IL-Standard-A',
];
let _cloudVoice: string | null = null;
let _cloudFailed = false;

function playAudioUrl(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const audio = new Audio(url);
    audio.onended = () => resolve();
    audio.onerror = () => reject(new Error('audio_error'));
    audio.play().catch(reject);
  });
}

async function speakWithCloudTTS(text: string, apiKey: string): Promise<boolean> {
  if (_cloudFailed || !apiKey) return false;

  const processedText = prepareTTSText(text);
  const voicesToTry = _cloudVoice ? [_cloudVoice] : CLOUD_VOICES;

  for (const voiceName of voicesToTry) {
    try {
      const res = await fetch(`${CLOUD_TTS_URL}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text: processedText },
          voice: { languageCode: 'he-IL', name: voiceName },
          audioConfig: { audioEncoding: 'MP3', speakingRate: 0.9, pitch: 0 },
        }),
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (!data.audioContent) continue;

      await playAudioUrl(`data:audio/mp3;base64,${data.audioContent}`);
      _cloudVoice = voiceName;
      return true;
    } catch {
      continue;
    }
  }

  _cloudFailed = true;
  return false;
}

// ---------------------------------------------------------------------------
// Browser SpeechSynthesis (always available)
// ---------------------------------------------------------------------------

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

function speakWithBrowser(messages: string[]): void {
  if (!('speechSynthesis' in window) || messages.length === 0) return;

  const voice = getBestHebrewVoice();
  const utterances = messages.map(msg => createHebrewUtterance(msg, voice));

  for (let i = 0; i < utterances.length - 1; i++) {
    const next = utterances[i + 1];
    utterances[i].onend = () => window.speechSynthesis.speak(next);
  }
  window.speechSynthesis.speak(utterances[0]);
}

// ---------------------------------------------------------------------------
// Main entry point — cascading TTS engine selection
// ---------------------------------------------------------------------------

/**
 * Speak Hebrew messages with the best available TTS engine:
 * 1. Gemini TTS — AI-powered, uses same API key as AI features (excellent Hebrew)
 * 2. Google Cloud TTS — if TTS API enabled on key (good Hebrew, Wavenet voices)
 * 3. Browser SpeechSynthesis — always available (basic quality, depends on browser)
 */
export async function speakHebrew(messages: string[], apiKey: string | null): Promise<void> {
  if (messages.length === 0) return;

  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }

  // 1. Gemini TTS — batches all messages in one API call
  if (apiKey && !_geminiTTSFailed) {
    try {
      const ok = await speakWithGeminiTTS(messages, apiKey);
      if (ok) return;
    } catch { /* fall through */ }
  }

  // 2. Cloud TTS — per message, tracks progress for partial-failure fallback
  if (apiKey && !_cloudFailed) {
    try {
      let spoken = 0;
      for (const msg of messages) {
        const ok = await speakWithCloudTTS(msg, apiKey);
        if (!ok) break;
        spoken++;
      }
      if (spoken === messages.length) return;
      if (spoken > 0) {
        speakWithBrowser(messages.slice(spoken));
        return;
      }
    } catch { /* fall through */ }
  }

  // 3. Browser SpeechSynthesis — final fallback
  speakWithBrowser(messages);
}
