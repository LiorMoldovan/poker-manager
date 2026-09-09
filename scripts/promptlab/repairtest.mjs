// Feeds a deliberately defective model response through the REAL forecast
// pipeline and asserts the fact-check repairs fire. Unlike a live run this is
// deterministic — it does not depend on the model reproducing the mistake.
//
//   node scripts/promptlab/build.mjs && node scripts/promptlab/repairtest.mjs
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const OUT = 'scripts/promptlab/out';
const env = { ...process.env, PROMPTLAB_INJECT: 'scripts/promptlab/inject-defects.json' };
delete env.GEMINI_API_KEY;

execSync('node scripts/promptlab/build.mjs', { stdio: 'ignore' });
execSync('node scripts/promptlab/out/lab.mjs', { env, stdio: 'ignore' });

const shipped = JSON.parse(readFileSync(`${OUT}/S1-regulars.result.json`, 'utf8'))
  .find(p => p.name === 'ליכטר').sentence;

const cases = [
  ['bare "שיא" on the half-year best is scoped', () => !/שיא של 379/.test(shipped) && /שיא חציוני של 379/.test(shipped)],
  ['superlative on a 3-win streak is dropped', () => !/נצחונות מרשימים/.test(shipped)],
  ['the rest of the sentence survives', () => /ליכטר רוכב על רצף/.test(shipped) && shipped.length > 90],
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
