// Proves the truncation protection in callWithFallback, by making the stubbed
// Gemini return finishReason MAX_TOKENS with a fragment.
//
//   node scripts/promptlab/truncationtest.mjs
//
// Two scenarios:
//   1. The first attempt truncates -> the retry at a larger budget must win,
//      and the member must see the complete text.
//   2. Every attempt truncates -> we still ship something, but it must end on
//      a finished sentence rather than mid-word.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const OUT = 'scripts/promptlab/out';
const LABEL = 'S6-summary-0309';
const FRAGMENT_TAIL = 'בעוד אורן ביצע קאמבק של';

const run = truncate => {
  const env = { ...process.env, PROMPTLAB_INJECT: 'scripts/promptlab/inject-summary.txt', PROMPTLAB_TRUNCATE: String(truncate) };
  delete env.GEMINI_API_KEY;
  execSync('node scripts/promptlab/out/lab.mjs', { env, stdio: 'ignore' });
  return JSON.parse(readFileSync(`${OUT}/${LABEL}.result.json`, 'utf8')).text || '';
};

execSync('node scripts/promptlab/build.mjs', { stdio: 'ignore' });

const recovered = run(1);
const alwaysCut = run(999);

const endsCleanly = t => /[.!?]$/.test(t.trim());

const cases = [
  ['retry after one truncation returns the full text', () => recovered.includes('בשבוע הבא כולם יחפשו נקמה')],
  ['recovered text does not end mid-word', () => endsCleanly(recovered)],
  ['when every attempt truncates we still ship text', () => alwaysCut.trim().length > 60],
  ['last-resort text is trimmed to a full sentence', () => endsCleanly(alwaysCut)],
  ['the dangling fragment never reaches the member', () => !recovered.trim().endsWith(FRAGMENT_TAIL) && !alwaysCut.trim().endsWith(FRAGMENT_TAIL)],
];

let bad = 0;
console.log(`recovered  : ...${recovered.trim().slice(-60)}`);
console.log(`always-cut : ...${alwaysCut.trim().slice(-60)}\n`);
for (const [name, fn] of cases) {
  const ok = fn();
  if (!ok) bad++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}`);
}
console.log(bad ? `\n${bad} truncation guard(s) not working` : '\ntruncation protection working');
process.exit(bad ? 1 : 0);
