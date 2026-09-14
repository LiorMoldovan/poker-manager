// Replays the real settlement engine over real completed games and reports the
// shape of what players actually receive, so "it could be better" can be
// argued from numbers instead of impressions.
//
//   node scripts/settlelab/analyze.mjs [--detail]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { build } from 'esbuild';

mkdirSync('scripts/settlelab/out', { recursive: true });
await build({
  entryPoints: ['src/utils/calculations.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: 'scripts/settlelab/out/calculations.mjs',
  logLevel: 'silent',
});
const { calculateSettlement } = await import('./out/calculations.mjs');

const { minTransfer, blockedPairs, games } = JSON.parse(readFileSync('scripts/settlelab/games.json', 'utf8'));
const detail = process.argv.includes('--detail');

// A transfer nobody enjoys: technically above the 5₪ floor, but small enough
// that being asked to move it (or to make a second payment for it) is friction.
const PETTY = 25;
// A player whose whole night nets out to less than this is "nearly flat" —
// they should be settled by one person, not collect from three.
const SMALL_BALANCE = 60;

const rows = [];
for (const g of games) {
  const players = g.players.map(([playerName, profit]) => ({ playerName, profit }));
  const t0 = performance.now();
  const { settlements, smallTransfers } = calculateSettlement(players, minTransfer, g.date, blockedPairs);
  const ms = performance.now() - t0;

  const touches = new Map();
  for (const t of settlements) {
    touches.set(t.from, (touches.get(t.from) ?? 0) + 1);
    touches.set(t.to, (touches.get(t.to) ?? 0) + 1);
  }

  const balance = new Map(players.map(p => [p.playerName, p.profit]));
  // Someone with a small stake who still has to deal with several payments.
  const splitSmall = [...touches.entries()]
    .filter(([name, n]) => n > 1 && Math.abs(balance.get(name) ?? 0) < SMALL_BALANCE)
    .map(([name, n]) => `${name}(${Math.round(balance.get(name))}₪ over ${n})`);

  const amounts = settlements.map(t => Math.round(t.amount)).sort((a, b) => a - b);
  rows.push({
    date: g.date,
    n: players.filter(p => Math.abs(p.profit) > 0.001).length,
    transfers: settlements.length,
    min: amounts[0] ?? 0,
    petty: amounts.filter(a => a < PETTY).length,
    maxTouch: Math.max(0, ...touches.values()),
    splitSmall,
    skipped: smallTransfers.length,
    ms,
    settlements,
  });
}

const sum = k => rows.reduce((s, r) => s + (Array.isArray(r[k]) ? r[k].length : r[k]), 0);
console.log(`${rows.length} games, minTransfer ${minTransfer}₪\n`);
console.log('date        n  transfers  min₪  <25₪  maxTouch  split-small');
for (const r of rows) {
  const flag = r.splitSmall.length ? '  ⚠ ' + r.splitSmall.join(', ') : '';
  console.log(
    `${r.date}  ${r.n}  ${String(r.transfers).padStart(6)}  ${String(r.min).padStart(6)}  ${String(r.petty).padStart(4)}  ${String(r.maxTouch).padStart(7)}${flag}`
  );
  if (detail) for (const t of r.settlements) console.log(`             ${t.from} → ${t.to}  ${Math.round(t.amount)}`);
}

console.log(`\ntotals: ${sum('transfers')} transfers, ${sum('petty')} under ${PETTY}₪, ${sum('splitSmall')} small-balance players split, ${sum('skipped')} skipped as sub-minimum`);
console.log(`games with at least one under-${PETTY}₪ transfer: ${rows.filter(r => r.petty > 0).length}/${rows.length}`);
console.log(`games with a split small-balance player: ${rows.filter(r => r.splitSmall.length).length}/${rows.length}`);
// Sub-minTransfer leftovers: the ones the UI has to park in a separate list
// because they are below the floor. Forced when a player's own night is itself
// under the floor — someone who finished +0.45₪ has to be handed 0.45₪.
console.log(`\nsub-${minTransfer}₪ leftovers:`);
let forcedFloor = 0;
for (const r of rows) {
  const bal = new Map(games.find(g => g.date === r.date).players);
  const { smallTransfers } = calculateSettlement(
    games.find(g => g.date === r.date).players.map(([playerName, profit]) => ({ playerName, profit })),
    minTransfer, r.date, blockedPairs
  );
  for (const t of smallTransfers) {
    const tight = Math.min(Math.abs(bal.get(t.from) ?? 0), Math.abs(bal.get(t.to) ?? 0));
    const why = tight < minTransfer ? 'forced' : 'AVOIDABLE';
    if (tight < minTransfer) forcedFloor++;
    console.log(`  ${r.date} ${t.from}(${(bal.get(t.from) ?? 0).toFixed(2)}) → ${t.to}(${(bal.get(t.to) ?? 0).toFixed(2)}) = ${t.amount.toFixed(2)}₪  [${why}]`);
  }
}
console.log(`  ${forcedFloor} forced, ${sum('skipped') - forcedFloor} avoidable`);

// A petty transfer is unavoidable when one side's whole night is itself petty:
// a player who finished +6₪ has to be handed roughly 6₪ by someone.
let forced = 0;
const avoidable = [];
for (const r of rows) {
  const bal = new Map(games.find(g => g.date === r.date).players);
  for (const t of r.settlements) {
    if (Math.round(t.amount) >= PETTY) continue;
    const tight = Math.min(Math.abs(bal.get(t.from) ?? 0), Math.abs(bal.get(t.to) ?? 0));
    if (tight < PETTY) forced++;
    else avoidable.push(`${r.date} ${t.from}(${Math.round(bal.get(t.from))}) → ${t.to}(${Math.round(bal.get(t.to))}) = ${Math.round(t.amount)}₪`);
  }
}
console.log(`of those, ${forced} are forced by a player whose own night was under ${PETTY}₪; ${avoidable.length} are not:`);
for (const a of avoidable) console.log(`  ${a}`);

const times = rows.map(r => r.ms).sort((a, b) => a - b);
console.log(`settlement compute: median ${times[Math.floor(times.length / 2)].toFixed(0)}ms, slowest ${times[times.length - 1].toFixed(0)}ms`);

writeFileSync('scripts/settlelab/out/baseline.json', JSON.stringify(rows, null, 2), 'utf8');
