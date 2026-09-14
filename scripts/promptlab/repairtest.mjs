// Feeds a deliberately defective model response through the REAL forecast
// pipeline and asserts the fact-check repairs fire. Unlike a live run this is
// deterministic — it does not depend on the model reproducing the mistake.
//
//   node scripts/promptlab/build.mjs && node scripts/promptlab/repairtest.mjs
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Own scratch dir per suite. Sharing one with truncationtest meant a stale
// result from whichever ran first could be read as this suite's output.
const OUT = 'scripts/promptlab/out/_inject-repair';
const env = { ...process.env, PROMPTLAB_INJECT: 'scripts/promptlab/inject-defects.json', PROMPTLAB_OUT: OUT };
delete env.GEMINI_API_KEY;

execSync('node scripts/promptlab/build.mjs', { stdio: 'ignore' });
execSync('node scripts/promptlab/out/lab.mjs', { env, stdio: 'ignore' });

const result = JSON.parse(readFileSync(`${OUT}/S1-regulars.result.json`, 'utf8'));
const shipped = result.find(p => p.name === 'ליכטר').sentence;
const oren = result.find(p => p.name === 'אורן').sentence;

const cases = [
  // Wedged form on purpose: the repair used to require the number to sit
  // directly after "שיא", so "שיא מרשים של 379" slipped through unscoped.
  ['bare "שיא" on the half-year best is scoped, even with words wedged in', () => !/שיא מרשים של 379/.test(shipped) && /שיא חציוני מרשים של 379/.test(shipped)],
  ['superlative on a 3-win streak is dropped', () => !/נצחונות מרשימים/.test(shipped)],
  ['the rest of the sentence survives', () => /ליכטר רוכב על רצף/.test(shipped) && shipped.length > 90],
  // We never send a volatility figure, so "the most volatile player" is a
  // guess — and it shipped pointing at the second-steadiest player.
  ['invented "most volatile player" title is swapped for the name', () => !/תנודתי ביותר/.test(oren) && /אורן מנסה לשמור/.test(oren)],
];

let bad = 0;
console.log(`shipped: ${shipped}\n`);
for (const [name, fn] of cases) {
  const ok = fn();
  if (!ok) bad++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}`);
}
console.log(bad ? `\n${bad} repair(s) not working` : '\nall fact-check repairs working');
process.exit(bad ? 1 : 0);
