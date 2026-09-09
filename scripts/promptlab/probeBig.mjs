// The tiny "Say: OK" probe is not the workload. Every 503 we saw came from a
// real forecast prompt (~1.6k tokens in, JSON out), so retest 3.8-flash with
// exactly that shape before concluding anything about it.
import { readFileSync, readdirSync } from 'node:fs';
const KEY = process.env.GEMINI_API_KEY;
const OUT = 'scripts/promptlab/out';
const f = readdirSync(OUT).find(x => x.startsWith('S1-regulars.call1') && x.endsWith('prompt.txt'));
const prompt = readFileSync(`${OUT}/${f}`, 'utf8');
console.log(`prompt: ${prompt.length} chars from ${f}\n`);

for (const model of ['gemini-3.8-flash', 'gemini-3.5-flash']) {
  for (let i = 0; i < 2; i++) {
    const t0 = Date.now();
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 12288, responseMimeType: 'application/json' },
      }),
    });
    const ms = Date.now() - t0;
    const b = await r.json().catch(() => ({}));
    const status = r.ok ? 'OK' : `${r.status} ${b?.error?.status || ''}`;
    console.log(`${model.padEnd(24)} try${i + 1}  ${String(status).padEnd(26)} ${ms}ms`);
    await new Promise(s => setTimeout(s, 2000));
  }
}
