// Convert any number (0–9999) to spoken Hebrew words for TTS
export const numberToHebrewTTS = (n: number): string => {
  const abs = Math.round(Math.abs(n));
  if (abs === 0) return 'אפס';

  const ones = ['', 'אחד', 'שניים', 'שלושה', 'ארבעה', 'חמישה', 'שישה', 'שבעה', 'שמונה', 'תשעה'];
  const teens = ['עשרה', 'אחד עשר', 'שנים עשר', 'שלושה עשר', 'ארבעה עשר', 'חמישה עשר', 'שישה עשר', 'שבעה עשר', 'שמונה עשר', 'תשעה עשר'];
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
    return `${hundreds[h]} ${rem < 20 ? 'ו' : ''}${numberToHebrewTTS(rem)}`;
  }
  if (abs <= 9999) {
    const th = Math.floor(abs / 1000), rem = abs % 1000;
    if (rem === 0) return thousands[th];
    return `${thousands[th]} ${rem < 100 ? 'ו' : ''}${numberToHebrewTTS(rem)}`;
  }
  return String(abs);
};

// Preprocess text for better TTS pronunciation
export const prepareTTSText = (text: string): string => {
  let result = text;
  result = result.replace(/\d+/g, (match) => {
    const num = parseInt(match, 10);
    if (isNaN(num) || num > 9999) return match;
    return numberToHebrewTTS(num);
  });
  result = result.replace(/,/g, '.');
  return result;
};

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
  // Edge "Natural" voices are Azure Neural quality — best free option
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
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Speak Hebrew messages using the best available TTS engine:
 * 1. Google Cloud TTS (if API key has TTS enabled — best quality)
 * 2. Browser SpeechSynthesis (always works; quality depends on browser —
 *    Edge has excellent neural Hebrew voices, Chrome/Safari are basic)
 */
export async function speakHebrew(messages: string[], apiKey: string | null): Promise<void> {
  if (messages.length === 0) return;

  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }

  // Try Google Cloud TTS first (if API key available and TTS API enabled)
  if (apiKey && !_cloudFailed) {
    try {
      let allOk = true;
      for (const msg of messages) {
        const ok = await speakWithCloudTTS(msg, apiKey);
        if (!ok) { allOk = false; break; }
      }
      if (allOk) return;
    } catch { /* fall through */ }
  }

  // Browser SpeechSynthesis
  speakWithBrowser(messages);
}
