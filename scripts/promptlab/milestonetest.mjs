// Asserts the career game-milestone ladder. An off-by-one here tells a player
// the wrong game number on the one night it matters.
import { build } from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [resolve(here, '..', '..', 'src', 'utils', 'milestones.ts')],
  outfile: resolve(here, 'out', 'milestones.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  logLevel: 'warning',
  plugins: [{
    name: 'swap',
    setup(b) {
      b.onResolve({ filter: /.*/ }, args => {
        if (args.kind === 'entry-point') return null;
        if (/database[\\/]storage$/.test(args.path)) return { path: join(here, 'stubs/storage.ts') };
        return null;
      });
    },
  }],
  define: { 'import.meta.env': '{}' },
});

const { isCareerGameMilestone, nextCareerGameMilestone } = await import(
  pathToFileURL(resolve(here, 'out', 'milestones.mjs')).href
);

const cases = [
  // next milestone strictly above the current count
  ['next after 8 is 10', () => nextCareerGameMilestone(8) === 10],
  ['next after 10 is 25', () => nextCareerGameMilestone(10) === 25],
  ['next after 76 is 100', () => nextCareerGameMilestone(76) === 100],
  ['next after 99 is 100', () => nextCareerGameMilestone(99) === 100],
  ['next after 100 is 150', () => nextCareerGameMilestone(100) === 150],
  ['next after 149 is 150', () => nextCareerGameMilestone(149) === 150],
  // the two real players the old fixed list had retired
  ['next after 205 is 250', () => nextCareerGameMilestone(205) === 250],
  ['next after 245 is 250', () => nextCareerGameMilestone(245) === 250],
  ['ladder never dead-ends', () => nextCareerGameMilestone(612) === 650],
  // "tonight is the Nth" fires exactly one game before
  ['249 games means tonight is the 250th', () => nextCareerGameMilestone(249) - 249 === 1],

  // exact-hit detection, used after the game
  ['150 is a milestone', () => isCareerGameMilestone(150)],
  ['250 is a milestone', () => isCareerGameMilestone(250)],
  ['10 is a milestone', () => isCareerGameMilestone(10)],
  ['75 is a milestone', () => isCareerGameMilestone(75)],
  ['149 is not', () => !isCareerGameMilestone(149)],
  ['151 is not', () => !isCareerGameMilestone(151)],
  ['50 below 100 still counts', () => isCareerGameMilestone(50)],
  ['25 is not a multiple-of-50 false positive', () => isCareerGameMilestone(25)],
  ['30 is not', () => !isCareerGameMilestone(30)],
  ['0 is not', () => !isCareerGameMilestone(0)],
];

let bad = 0;
for (const [name, fn] of cases) {
  let ok = false;
  try { ok = fn(); } catch { ok = false; }
  if (!ok) bad++;
  console.log(`${ok ? 'pass' : 'FAIL'}  ${name}`);
}
console.log(bad ? `\n${bad} failing` : '\ncareer milestone ladder correct');
process.exit(bad ? 1 : 0);
