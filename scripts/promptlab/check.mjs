// Scans every captured prompt for the defect classes the lab has found so
// far. Run after any change to the forecast/summary prompt builders.
import { readFileSync, readdirSync } from 'node:fs';

const OUT = 'scripts/promptlab/out';

const CHECKS = [
  ['unrounded float leaking into the prompt', /[+-]?\d+\.\d{3,}/],
  ['"+-" sign collision', /\+-\d/],
  ['"earned" applied to a negative total', /הרוויח[^\n]{0,12}\s-\d/],
  ['career-record line on a thin history', null, t => cards(t).some(c => {
    const g = c.match(/היסטוריה כוללת: (\d+) משחקים/);
    return g && Number(g[1]) < 10 && /שיא אישי כל הזמנים/.test(c);
  })],
];

// Every card ends at its "זווית מוצעת" line. Without that cut the final card
// swallows the trailing rules block, which mentions the record labels itself.
const cards = t => t.split('══ ').slice(1).map(c => c.split('זווית מוצעת')[0]);

// Rank/gap self-consistency: every "<gap> ahead of place N (name)" must agree
// with that player's own "מקום #N" line in the same prompt.
function rankConsistency(t) {
  const problems = [];
  const rankOf = new Map();
  for (const c of cards(t)) {
    const name = c.split(' (')[0].trim();
    const m = c.match(/מקום #(\d+) מתוך/);
    if (m) rankOf.set(name, Number(m[1]));
  }
  const re = /(?:פער|יתרון) בטבלת [^:]+: \d+ (?:מאחורי|על) מקום (\d+) \(([^)]+)\)/g;
  let m;
  while ((m = re.exec(t))) {
    const [, claimed, who] = m;
    const actual = rankOf.get(who.trim());
    if (actual !== undefined && actual !== Number(claimed)) {
      problems.push(`claims ${who} is #${claimed}, their own card says #${actual}`);
    }
  }
  return problems;
}

// ── Generated-output checks (live runs only) ──────────────────────────────
// The prompt can be flawless and the model still slip, so grade the Hebrew it
// actually produced. Both classes below are real regressions we shipped.

// Spelled-out numerals. The gender-agreement rule used to be illustrated with
// word examples only, which taught the model to write "מאתיים ארבעים וחמישה
// משחקים" instead of "245 משחקים".
// No \b — it is defined over ASCII \w, so a Hebrew word never sits on a
// "word boundary" and the anchored form silently matched nothing.
const NUMBER_WORDS = /מאתיים|שלוש מאות|ארבע מאות|חמש מאות|שש מאות|שבע מאות|שמונה מאות|תשע מאות|אלפיים/;

// A bare "שיא" reads as an all-time record. Calling the half-year best a שיא
// without naming the period is exactly the claim that misled Lichter — but
// "שיא חציוני" is fine, so only flag the unqualified form.
const PERIOD_HINT = /חציון|חציוני|מחצית|מחצ/;
function recordScope(text, prompt) {
  if (!prompt) return [];
  const problems = [];
  for (const c of cards(prompt)) {
    const name = c.split(' (')[0].trim();
    const half = c.match(/הניצחון הגדול ביותר ב[^:]*: \u200E?\+(\d+)/);
    const all = c.match(/שיא אישי כל הזמנים[^:]*: \u200E?\+(\d+)/);
    if (!half || !all || half[1] === all[1]) continue;
    const n = half[1];
    const re = new RegExp(`שיא[^.]{0,40}?${n}|${n}[^.]{0,20}?שיא`, 'g');
    let m;
    while ((m = re.exec(text))) {
      const window = text.slice(Math.max(0, m.index - 25), m.index + m[0].length + 25);
      if (PERIOD_HINT.test(window)) continue;
      // "שיאים שליליים" is about worst results, not a record claim.
      if (/שלילי/.test(window)) continue;
      problems.push(`${name}: "${m[0].trim()}" names no period (${n} is the half-year best, all-time is ${all[1]})`);
    }
  }
  return problems;
}

// Superlatives on ordinary facts — "רצף של שלושה נצחונות מרשימים", "ניצחון
// אדיר" on +70. The bar is the 📏 scale line the prompt now carries, so the
// check reads it from the prompt rather than hard-coding a number.
// Hebrew final forms: מרשים ends in ם, but its plural מרשימים uses regular מ,
// so the singular is not a substring of the plural and a naive list misses
// every inflection. Fold finals to their regular letters (a 1:1 swap, so match
// indices still line up with the original) and match on stems.
const foldFinals = t => t.replace(/ך/g, 'כ').replace(/ם/g, 'מ').replace(/ן/g, 'נ').replace(/ף/g, 'פ').replace(/ץ/g, 'צ');
// "היסטורי" is deliberately not here: in this app it reads as "all-time"
// ("הממוצע ההיסטורי שלו"), so flagging it produced nothing but false alarms.
// The adjective has to actually modify a result — a win, a profit, a streak.
// Sitting near a number is not enough: "יציבות מרשימה אחרי ניצחון של 33" and
// "ממוצע ביתי מרשים של 109" are both fair, and window-proximity flagged them.
const SUPERLATIVES = /מדהימ|אדיר|מטורפ|פנומנלי|דמיוני|בלתי ייאמנ|מרשימ|אגדי|חסר תקדימ/;
const OVERCLAIM = new RegExp(`(?:ניצחונ|נצחונ|רווח|זכייה|רצפ)\\S*\\s+((?:${SUPERLATIVES.source})\\S*)`, 'g');
const SMALL_STREAK = /(שניימ|שני|שלושה|שלוש|[23])\s+(?:נצחונות|ניצחונות|הפסדימ)/;
const AMOUNT = /(\d[\d,]*)\s*(?:שקלימ|שקל|ש"ח)/g;

function superlativeScale(rawText, prompt) {
  const text = foldFinals(rawText);
  const bar = prompt.match(/ניצחון גדול מתחיל ב-(\d+)/);
  if (!bar) return [];
  const big = Number(bar[1]);
  const problems = [];
  let m;
  OVERCLAIM.lastIndex = 0;
  while ((m = OVERCLAIM.exec(text))) {
    const window = text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 40);
    // The bar measures one night's win. A per-game average sits on a different
    // scale entirely — 115 a game is excellent, 115 in a night is below median
    // — so it says nothing about averages and must not judge them.
    if (/ממוצע/.test(window)) continue;
    const amounts = [...window.matchAll(AMOUNT)].map(a => Number(a[1].replace(/,/g, '')));
    // When something above the bar is in range, that is the likelier referent
    // of the adjective than a small number that happens to share the window.
    if (amounts.some(v => v >= big)) continue;
    if (SMALL_STREAK.test(window)) {
      problems.push(`"${m[0]}" attached to a streak of 3 or fewer — "${window.trim()}"`);
      continue;
    }
    const small = amounts.find(v => v < big);
    if (small !== undefined) problems.push(`"${m[0]}" attached to ${small} ₪, below the ${big} ₪ bar — "${window.trim()}"`);
  }
  return problems;
}

const promptFor = label => {
  const f = readdirSync(OUT).find(x => x.startsWith(`${label}.call1.`) && x.endsWith('prompt.txt'));
  return f ? readFileSync(`${OUT}/${f}`, 'utf8') : '';
};

// Canned filler the pipeline substitutes when it rejects the model's sentence.
// Not a hard failure — sometimes the rejection is right — but the rate matters,
// because the filler is far blander than anything the model writes.
const CANNED = /לא מבשרים טובות|ערב מאתגר$|צריך לעבוד קשה הפעם|יתרון קל הפעם|הרוח בגב|ערב טוב צפוי/;

let failures = 0;
let fallbacks = 0;
let players = 0;

for (const f of readdirSync(OUT).filter(x => x.endsWith('.result.json'))) {
  const label = f.replace('.result.json', '');
  // A dry run writes results too, but they are all fallback text because no
  // model ever answered. Grading those would report defects that belong to the
  // harness, not the prompt, so require a captured response to judge output.
  const isLive = readdirSync(OUT).some(x => x.startsWith(`${label}.`) && x.endsWith('.raw.txt'));
  if (!isLive) continue;
  const parsed = JSON.parse(readFileSync(`${OUT}/${f}`, 'utf8'));
  const text = Array.isArray(parsed)
    ? parsed.map(p => `${p.highlight} ${p.sentence} ${p.preGameTeaser || ''}`).join('\n')
    : parsed.text || '';
  if (!text.trim()) continue;

  const w = text.match(NUMBER_WORDS);
  if (w) {
    failures++;
    console.log(`FAIL  ${f}\n      numeral spelled out in words — "${w[0]}"`);
  }
  const sign = text.match(/\+-\d/);
  if (sign) {
    failures++;
    console.log(`FAIL  ${f}\n      "+-" sign collision in shipped text — "${sign[0]}"`);
  }
  if (Array.isArray(parsed)) {
    const canned = parsed.filter(p => CANNED.test(p.sentence)).map(p => p.name);
    if (canned.length) {
      fallbacks += canned.length;
      console.log(`note  ${f}\n      ${canned.length}/${parsed.length} players got the canned fallback: ${canned.join(', ')}`);
    }
    players += parsed.length;
  }
  const prompt = promptFor(label);
  for (const p of recordScope(text, prompt)) {
    failures++;
    console.log(`FAIL  ${f}\n      record scope: ${p}`);
  }
  for (const p of superlativeScale(text, prompt)) {
    failures++;
    console.log(`FAIL  ${f}\n      overclaim: ${p}`);
  }
}

for (const f of readdirSync(OUT).filter(x => x.endsWith('prompt.txt'))) {
  const t = readFileSync(`${OUT}/${f}`, 'utf8');
  for (const [name, re, fn] of CHECKS) {
    const hit = fn ? fn(t) : re.test(t);
    if (hit) {
      failures++;
      console.log(`FAIL  ${f}\n      ${name}${fn ? '' : ` — "${t.match(re)[0]}"`}`);
    }
  }
  for (const p of rankConsistency(t)) {
    failures++;
    console.log(`FAIL  ${f}\n      rank contradiction: ${p}`);
  }
}

if (players) console.log(`\nfallback rate: ${fallbacks}/${players} player sentences were canned filler`);

console.log(failures
  ? `\n${failures} defect(s) found`
  : '\nclean — prompts free of unrounded floats, sign collisions, negative "earned", thin-history records and rank contradictions; output free of spelled-out numerals and mis-scoped records');
process.exit(failures ? 1 : 0);
