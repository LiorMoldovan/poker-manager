/**
 * AI Pool Review — Reviews all training pool questions using Gemini
 * Uses careful rate limiting to stay within free tier (15 RPM)
 */

import { readFileSync, writeFileSync } from 'fs';

const API_KEY = process.env.GEMINI_API_KEY || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const POOL_PATH = './public/training-pool.json';
const BATCH_SIZE = 15;
const DELAY_BETWEEN_BATCHES_MS = 8000;
const MODELS = ['gemini-3-flash-preview', 'gemini-3.1-flash-lite-preview', 'gemini-2.5-flash'];
const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';

async function fetchLivePool() {
  try {
    const url = 'https://api.github.com/repos/LiorMoldovan/poker-manager/contents/public/training-pool.json?ref=main';
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' },
    });
    if (resp.ok) {
      const fileInfo = await resp.json();
      return JSON.parse(Buffer.from(fileInfo.content, 'base64').toString('utf-8'));
    }
  } catch {}
  console.log('Using local file');
  return JSON.parse(readFileSync(POOL_PATH, 'utf-8'));
}

function buildReviewPrompt(batch) {
  return `אתה מומחה פוקר. בדוק ${batch.length} שאלות למשחק ביתי (~8 שחקנים, 30 שקלים כניסה, בליינדס 50/100).

חובה:
1. חשב ידנית: קלפי יד + לוח = מה היד? סטרייט? צבע? אם השאלה לא מזהה → fix/remove
2. התשובה "הנכונה" מתאימה למשחק ביתי? (בלוף גדול = לא נכון, שחקנים קוראים)
3. סמן nearMiss: תשובות שגויות שהיו נכונות בפוקר מקצועי
4. סכומים בשקלים, בלי אנגלית, בלי placeholder

${JSON.stringify(batch.map(s => ({p:s.poolId,c:s.yourCards,s:s.situation,o:s.options.map(o=>({i:o.id,t:o.text,ok:o.isCorrect,e:o.explanation?.substring(0,120)}))})))}

JSON בלבד:
[{"poolId":"x","status":"ok"|"fixed"|"remove","issues":[],"nearMissFlags":["B"],"fixedScenario":{...}}]`;
}

async function callGemini(prompt) {
  for (const model of MODELS) {
    try {
      const resp = await fetch(`${BASE_URL}${model}:generateContent?key=${API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.05, maxOutputTokens: 8192 },
        }),
      });
      if (resp.status === 429) { continue; }
      if (!resp.ok) { continue; }
      const data = await resp.json();
      let text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (!text) continue;
      text = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      return JSON.parse(text);
    } catch { continue; }
  }
  throw new Error('All models failed');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('Fetching pool...');
  const pool = await fetchLivePool();
  console.log(`${pool.scenarios.length} scenarios loaded\n`);

  const batches = [];
  for (let i = 0; i < pool.scenarios.length; i += BATCH_SIZE) {
    batches.push(pool.scenarios.slice(i, i + BATCH_SIZE));
  }

  const allResults = [];
  let fixed = 0, removed = 0, ok = 0, errors = 0, nearMissAdded = 0;
  const startTime = Date.now();

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const eta = b > 0 ? Math.round(((Date.now() - startTime) / b) * (batches.length - b) / 1000) : '?';
    process.stdout.write(`[${elapsed}s] Batch ${b + 1}/${batches.length} (ETA: ${eta}s)... `);

    try {
      const results = await callGemini(buildReviewPrompt(batch));
      if (!Array.isArray(results)) throw new Error('Not array');

      let bOk=0, bFixed=0, bRemoved=0;
      for (const r of results) {
        allResults.push(r);
        if (r.status === 'fixed') { bFixed++; fixed++; }
        else if (r.status === 'remove') { bRemoved++; removed++; }
        else { bOk++; ok++; }
        if (r.nearMissFlags?.length > 0) nearMissAdded += r.nearMissFlags.length;
      }
      console.log(`ok:${bOk} fix:${bFixed} rm:${bRemoved}`);
      for (const r of results) {
        if (r.status !== 'ok') console.log(`  ${r.status === 'fixed' ? '✏️' : '🗑'} ${r.poolId}: ${(r.issues||[]).join('; ')}`);
      }
    } catch (err) {
      console.log(`ERR: ${err.message.substring(0, 80)}`);
      errors++;
      batch.forEach(s => allResults.push({ poolId: s.poolId, status: 'ok', issues: [] }));
    }

    if (b < batches.length - 1) await sleep(DELAY_BETWEEN_BATCHES_MS);
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`OK:${ok} Fixed:${fixed} Removed:${removed} Errors:${errors} nearMiss:${nearMissAdded}`);

  // Apply
  const rMap = new Map(allResults.map(r => [r.poolId, r]));
  const out = [];
  for (const s of pool.scenarios) {
    const r = rMap.get(s.poolId);
    if (!r) { out.push(s); continue; }
    if (r.status === 'remove') continue;
    if (r.status === 'fixed' && r.fixedScenario) {
      const f = r.fixedScenario;
      f.poolId = s.poolId;
      f.categoryId = f.categoryId || s.categoryId;
      f.category = f.category || s.category;
      out.push(f);
    } else if (r.nearMissFlags?.length > 0) {
      out.push({ ...s, options: s.options.map(o => ({ ...o, nearMiss: r.nearMissFlags.includes(o.id) ? true : (o.nearMiss || undefined) })) });
    } else {
      out.push(s);
    }
  }

  const newPool = { generatedAt: new Date().toISOString(), totalScenarios: out.length, byCategory: {}, scenarios: out };
  out.forEach(s => { newPool.byCategory[s.categoryId] = (newPool.byCategory[s.categoryId] || 0) + 1; });

  writeFileSync(POOL_PATH, JSON.stringify(newPool, null, 2));
  console.log(`\nSaved: ${newPool.totalScenarios} scenarios`);

  // Upload to GitHub
  console.log('Uploading to GitHub...');
  try {
    const ghUrl = 'https://api.github.com/repos/LiorMoldovan/poker-manager/contents/public/training-pool.json';
    const getResp = await fetch(ghUrl, { headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' } });
    const sha = getResp.ok ? (await getResp.json()).sha : undefined;
    const content = Buffer.from(JSON.stringify(newPool, null, 2)).toString('base64');
    const putResp = await fetch(ghUrl, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `AI review: ${fixed} fixed, ${removed} removed, ${nearMissAdded} nearMiss`, content, sha, branch: 'main' }),
    });
    console.log(putResp.ok ? '✅ GitHub upload OK' : `❌ Upload failed: ${putResp.status}`);
  } catch (e) { console.log(`❌ Upload error: ${e.message}`); }

  writeFileSync('./pool-review-changes.json', JSON.stringify(allResults.filter(r => r.status !== 'ok' || r.nearMissFlags?.length > 0), null, 2));
  console.log('Done!');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
