// Empirical check of the fallback chain: is each pinned text model actually
// answering, and what does a failed attempt cost in latency before we fall
// through to the next slot?
const KEY = process.env.GEMINI_API_KEY;
const MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite'];
const ROUNDS = Number(process.argv[2] || 3);

const call = async model => {
  const t0 = Date.now();
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Say: OK' }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 5 },
      }),
    });
    const ms = Date.now() - t0;
    if (r.ok) return { ms, status: 'OK' };
    const b = await r.json().catch(() => ({}));
    return { ms, status: `${r.status} ${b?.error?.status || ''}`.trim() };
  } catch (e) {
    return { ms: Date.now() - t0, status: `threw ${e.message.slice(0, 40)}` };
  }
};

for (const m of MODELS) {
  const runs = [];
  for (let i = 0; i < ROUNDS; i++) runs.push(await call(m));
  const ok = runs.filter(r => r.status === 'OK').length;
  const avg = Math.round(runs.reduce((s, r) => s + r.ms, 0) / runs.length);
  console.log(`${m.padEnd(26)} ${ok}/${ROUNDS} ok   avg ${String(avg).padStart(5)}ms   ${runs.map(r => `${r.status}@${r.ms}ms`).join('  ')}`);
}
