/**
 * Training Pool Quality Validator
 * 
 * Usage:
 *   node scripts/validate-pool.mjs <path-to-training-pool.json>
 *   node scripts/validate-pool.mjs --fetch   (fetches from GitHub)
 */

import { readFileSync } from 'fs';

// ── Config ──

const VALID_SUITS = ['♠', '♦', '♣', '♥'];
const VALID_RANKS = ['A', 'K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2'];

const ENGLISH_TERMS = [
  'equity', 'EV', 'expected value', 'SPR', 'stack-to-pot',
  'range', 'c-bet', 'continuation bet', 'semi-bluff', 'value bet',
  'fold equity', 'implied odds', 'pot odds', 'reverse implied',
  'donk bet', 'float', 'barrel', 'polarized', 'merged',
  'GTO', 'ICM', 'showdown value', 'blocker', 'combo draw',
  'overcall', 'squeeze', 'cold call', 'limp', '3-bet', '4-bet',
  'open raise', 'flat call', 'check-raise', 'slow play',
  'under the gun', 'cutoff', 'button', 'big blind', 'small blind',
  'flop', 'turn', 'river', 'preflop', 'pre-flop',
  'nuts', 'drawing dead', 'outs', 'backdoor',
];

const ENGLISH_TERM_PATTERNS = ENGLISH_TERMS.map(t => ({
  term: t,
  regex: new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
}));

const CATEGORIES = [
  'preflop-open', 'preflop-3bet', 'preflop-squeeze', 'preflop-multiway',
  'cbet-flop', 'cbet-turn', 'check-raise', 'donk-bet',
  'draw-play', 'set-play', 'top-pair', 'overpair',
  'bluff-spot', 'semi-bluff', 'value-bet', 'thin-value',
  'pot-control', 'trap-play', 'multiway-post', 'short-stack',
  'bubble-play', 'heads-up', 'position-play', 'read-based',
];

// ── Load data ──

const args = process.argv.slice(2);
let poolData;

if (args[0] === '--fetch') {
  console.log('Fetching from GitHub...');
  const resp = await fetch(
    'https://api.github.com/repos/LiorMoldovan/poker-manager/contents/public/training-pool.json',
    { headers: { Accept: 'application/vnd.github.v3+json' } }
  );
  if (!resp.ok) {
    console.error(`GitHub fetch failed: ${resp.status}`);
    process.exit(1);
  }
  const ghData = await resp.json();
  poolData = JSON.parse(Buffer.from(ghData.content, 'base64').toString('utf-8'));
} else if (args[0]) {
  poolData = JSON.parse(readFileSync(args[0], 'utf-8'));
} else {
  console.error('Usage: node scripts/validate-pool.mjs <file.json> | --fetch');
  process.exit(1);
}

// ── Validation engine ──

const issues = [];
const warnings = [];
const stats = {
  total: 0,
  byCategory: {},
  avgSituationLen: 0,
  avgExplanationLen: 0,
  shortExplanations: 0,
  shortSituations: 0,
  englishTermHits: 0,
  cardFormatErrors: 0,
  bettingLogicErrors: 0,
  duplicateSituations: 0,
  missingFields: 0,
  wrongOptionCount: 0,
  wrongCorrectCount: 0,
  uniqueCards: new Set(),
};

const scenarios = poolData.scenarios || [];
stats.total = scenarios.length;

// ── Helpers ──

function validateCard(card) {
  const trimmed = card.trim();
  for (const rank of VALID_RANKS) {
    for (const suit of VALID_SUITS) {
      if (trimmed === rank + suit) return true;
    }
  }
  return false;
}

function validateCards(yourCards) {
  if (!yourCards || typeof yourCards !== 'string') return false;
  const cards = yourCards.split(/\s+/);
  if (cards.length !== 2) return false;
  return cards.every(validateCard);
}

function checkEnglishTerms(text) {
  const found = [];
  for (const { term, regex } of ENGLISH_TERM_PATTERNS) {
    if (regex.test(text)) found.push(term);
  }
  return found;
}

function checkBettingLogic(scenario) {
  const sit = scenario.situation.toLowerCase();
  const opts = scenario.options.map(o => o.text.toLowerCase());

  const someonebet = sit.includes('המר') || sit.includes('העלה') || sit.includes('הימור')
    || sit.includes('raise') || sit.includes('bet') || sit.includes('אול-אין');
  const nobet = sit.includes('צ\'ק') || sit.includes("צ'ק") || sit.includes('בדקו')
    || sit.includes('אף אחד לא המר');

  const hasCall = opts.some(o => o.includes('קריאה'));
  const hasCheck = opts.some(o => o.includes("צ'ק") || o.includes('צ\'ק'));

  const errors = [];
  if (nobet && hasCall && !someonebet) {
    errors.push('Has "call" option but no one bet');
  }
  if (someonebet && hasCheck && !nobet) {
    errors.push('Has "check" option after someone bet');
  }
  return errors;
}

function similarity(a, b) {
  const setA = new Set(a.split(/\s+/));
  const setB = new Set(b.split(/\s+/));
  const intersection = [...setA].filter(x => setB.has(x)).length;
  return intersection / Math.max(setA.size, setB.size);
}

// ── Run checks per scenario ──

let totalSitLen = 0;
let totalExpLen = 0;
let expCount = 0;
const situationMap = new Map();

for (let i = 0; i < scenarios.length; i++) {
  const s = scenarios[i];
  const label = `#${i + 1} [${s.categoryId || '?'}]`;

  // ─ Structural ─
  if (!s.situation || !s.yourCards || !s.options || !s.poolId) {
    issues.push(`${label}: Missing required fields`);
    stats.missingFields++;
    continue;
  }

  if (!Array.isArray(s.options) || s.options.length !== 3) {
    issues.push(`${label}: Has ${s.options?.length ?? 0} options (expected 3)`);
    stats.wrongOptionCount++;
  }

  const correctCount = (s.options || []).filter(o => o.isCorrect).length;
  if (correctCount !== 1) {
    issues.push(`${label}: Has ${correctCount} correct answers (expected 1)`);
    stats.wrongCorrectCount++;
  }

  for (const opt of (s.options || [])) {
    if (!opt.id || !opt.text) {
      issues.push(`${label}: Option missing id or text`);
    }
    if (!opt.explanation || opt.explanation.length < 10) {
      issues.push(`${label}: Option "${opt.id}" has missing/short explanation (${opt.explanation?.length || 0} chars)`);
      stats.shortExplanations++;
    }
    if (opt.explanation) {
      totalExpLen += opt.explanation.length;
      expCount++;
    }
  }

  // ─ Cards ─
  if (!validateCards(s.yourCards)) {
    issues.push(`${label}: Invalid card format "${s.yourCards}"`);
    stats.cardFormatErrors++;
  }
  stats.uniqueCards.add(s.yourCards);

  // ─ Situation quality ─
  totalSitLen += s.situation.length;

  if (s.situation.length < 40) {
    warnings.push(`${label}: Very short situation (${s.situation.length} chars): "${s.situation.slice(0, 60)}..."`);
    stats.shortSituations++;
  }

  if (s.situation.length > 600) {
    warnings.push(`${label}: Very long situation (${s.situation.length} chars)`);
  }

  // ─ English terms ─
  const allText = s.situation + ' ' + (s.options || []).map(o => `${o.text} ${o.explanation || ''}`).join(' ');
  const engFound = checkEnglishTerms(allText);
  if (engFound.length > 0) {
    warnings.push(`${label}: English terms found: ${engFound.join(', ')}`);
    stats.englishTermHits++;
  }

  // ─ Betting logic ─
  const betErrors = checkBettingLogic(s);
  if (betErrors.length > 0) {
    warnings.push(`${label}: Betting logic: ${betErrors.join('; ')}`);
    stats.bettingLogicErrors++;
  }

  // ─ Category distribution ─
  const cat = s.categoryId || 'unknown';
  stats.byCategory[cat] = (stats.byCategory[cat] || 0) + 1;

  // ─ Duplicate tracking ─
  const sitKey = s.situation.slice(0, 100).toLowerCase();
  if (situationMap.has(sitKey)) {
    warnings.push(`${label}: Near-duplicate of scenario #${situationMap.get(sitKey) + 1}`);
    stats.duplicateSituations++;
  } else {
    situationMap.set(sitKey, i);
  }
}

// ─ Fuzzy duplicate check (more thorough but slower) ─
const fuzzyDups = [];
const checked = new Set();
for (let i = 0; i < scenarios.length; i++) {
  for (let j = i + 1; j < scenarios.length; j++) {
    if (scenarios[i].categoryId !== scenarios[j].categoryId) continue;
    if (checked.has(j)) continue;
    const sim = similarity(scenarios[i].situation, scenarios[j].situation);
    if (sim > 0.7) {
      fuzzyDups.push({ a: i + 1, b: j + 1, sim: (sim * 100).toFixed(0), cat: scenarios[i].categoryId });
      checked.add(j);
    }
  }
}

stats.avgSituationLen = scenarios.length > 0 ? Math.round(totalSitLen / scenarios.length) : 0;
stats.avgExplanationLen = expCount > 0 ? Math.round(totalExpLen / expCount) : 0;

// ── Report ──

console.log('\n' + '═'.repeat(60));
console.log('  TRAINING POOL QUALITY REPORT');
console.log('═'.repeat(60));

console.log(`\n📊 Overview`);
console.log(`  Total scenarios:        ${stats.total}`);
console.log(`  Unique card hands:      ${stats.uniqueCards.size}`);
console.log(`  Avg situation length:   ${stats.avgSituationLen} chars`);
console.log(`  Avg explanation length:  ${stats.avgExplanationLen} chars`);
console.log(`  Generated at:           ${poolData.generatedAt || 'unknown'}`);

console.log(`\n📂 Category Distribution (target: 30 each)`);
const sortedCats = Object.entries(stats.byCategory).sort((a, b) => a[0].localeCompare(b[0]));
let underTarget = 0;
for (const [cat, count] of sortedCats) {
  const bar = '█'.repeat(Math.round(count / 2));
  const flag = count < 20 ? ' ⚠️ LOW' : count < 30 ? ' ⚡' : '';
  console.log(`  ${cat.padEnd(22)} ${String(count).padStart(3)} ${bar}${flag}`);
  if (count < 20) underTarget++;
}
console.log(`  ${'─'.repeat(40)}`);
console.log(`  Categories covered:     ${sortedCats.length}/${CATEGORIES.length}`);
if (underTarget > 0) console.log(`  ⚠️  ${underTarget} categories under 20 scenarios`);

const missingCats = CATEGORIES.filter(c => !stats.byCategory[c]);
if (missingCats.length > 0) {
  console.log(`  ❌ Missing categories:  ${missingCats.join(', ')}`);
}

console.log(`\n❌ Critical Issues (${issues.length})`);
if (issues.length === 0) {
  console.log('  ✅ None!');
} else {
  issues.slice(0, 30).forEach(i => console.log(`  • ${i}`));
  if (issues.length > 30) console.log(`  ... and ${issues.length - 30} more`);
}

console.log(`\n⚠️  Warnings (${warnings.length})`);
if (warnings.length === 0) {
  console.log('  ✅ None!');
} else {
  warnings.slice(0, 30).forEach(w => console.log(`  • ${w}`));
  if (warnings.length > 30) console.log(`  ... and ${warnings.length - 30} more`);
}

if (fuzzyDups.length > 0) {
  console.log(`\n🔁 Fuzzy Duplicates (${fuzzyDups.length} pairs with >70% similarity)`);
  fuzzyDups.slice(0, 15).forEach(d => {
    console.log(`  • #${d.a} ↔ #${d.b}  (${d.sim}% similar, category: ${d.cat})`);
  });
  if (fuzzyDups.length > 15) console.log(`  ... and ${fuzzyDups.length - 15} more`);
}

// ── Sample 5 random scenarios for manual review ──
console.log(`\n📝 Random Sample (5 scenarios for manual review)`);
console.log('─'.repeat(60));
const indices = [];
while (indices.length < Math.min(5, scenarios.length)) {
  const idx = Math.floor(Math.random() * scenarios.length);
  if (!indices.includes(idx)) indices.push(idx);
}

for (const idx of indices) {
  const s = scenarios[idx];
  console.log(`\n  #${idx + 1} | ${s.categoryId} | Cards: ${s.yourCards}`);
  console.log(`  ${s.situation}`);
  for (const o of s.options) {
    const mark = o.isCorrect ? '✅' : '  ';
    console.log(`    ${mark} ${o.id}) ${o.text}`);
    console.log(`       → ${(o.explanation || '').slice(0, 120)}`);
  }
}

// ── Summary verdict ──
console.log('\n' + '═'.repeat(60));
const criticalScore = issues.length === 0 ? 'PASS' : `FAIL (${issues.length} issues)`;
const warningScore = warnings.length <= 10 ? 'GOOD' : warnings.length <= 30 ? 'OK' : `NEEDS REVIEW (${warnings.length})`;
const coverageScore = missingCats.length === 0 ? 'FULL' : `INCOMPLETE (${missingCats.length} missing)`;

console.log(`  VERDICT`);
console.log(`  ├─ Structure:   ${criticalScore}`);
console.log(`  ├─ Quality:     ${warningScore}`);
console.log(`  ├─ Coverage:    ${coverageScore}`);
console.log(`  ├─ Duplicates:  ${fuzzyDups.length === 0 ? 'CLEAN' : `${fuzzyDups.length} pairs`}`);
console.log(`  └─ Eng terms:   ${stats.englishTermHits === 0 ? 'CLEAN' : `${stats.englishTermHits} scenarios`}`);
console.log('═'.repeat(60) + '\n');

// Exit code: 0 if no critical issues, 1 if there are
process.exit(issues.length > 0 ? 1 : 0);
