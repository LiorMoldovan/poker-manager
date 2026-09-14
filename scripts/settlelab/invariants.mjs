// Correctness gate for the settlement engine. Quality metrics live in
// analyze.mjs; this file only asks "is the result valid money movement".
//
//   node scripts/settlelab/invariants.mjs
import { readFileSync, mkdirSync } from 'node:fs';
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
const { calculateSettlement, calculateCombinedSettlement } = await import('./out/calculations.mjs');

let pass = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) pass++;
  else failures.push(`${name}${detail ? ' — ' + detail : ''}`);
};

// Every player must end up exactly square: what they pay out minus what they
// receive has to equal the night they had, once the sub-minimum leftovers the
// UI shows separately are counted back in.
function verify(label, players, minTransfer, date, blocked) {
  const { settlements, smallTransfers } = calculateSettlement(players, minTransfer, date, blocked);
  const net = new Map(players.map(p => [p.playerName, 0]));
  for (const t of [...settlements, ...smallTransfers]) {
    net.set(t.from, (net.get(t.from) ?? 0) - t.amount);
    net.set(t.to, (net.get(t.to) ?? 0) + t.amount);
  }
  for (const p of players) {
    const got = net.get(p.playerName) ?? 0;
    // Whole-shekel rounding drops sub-1₪ tails, so allow that much slack.
    check(`${label}: ${p.playerName} settled`, Math.abs(got - p.profit) < 1.01,
      `owed ${p.profit.toFixed(2)}, moved ${got.toFixed(2)}`);
  }
  check(`${label}: no negative or zero amounts`, [...settlements, ...smallTransfers].every(t => t.amount > 0));
  check(`${label}: every transfer has two distinct parties`, [...settlements, ...smallTransfers].every(t => t.from !== t.to));
  check(`${label}: split at the minTransfer line`,
    settlements.every(t => t.amount >= minTransfer) && smallTransfers.every(t => t.amount < minTransfer));
  return settlements;
}

const fx = JSON.parse(readFileSync('scripts/settlelab/games.json', 'utf8'));
for (const g of fx.games) {
  verify(g.date, g.players.map(([playerName, profit]) => ({ playerName, profit })), fx.minTransfer, g.date, fx.blockedPairs);
}

// The blocked pair must never appear in either direction on or after the date
// the block starts, and must be free to appear before it.
const blockedGames = fx.games.filter(g => g.date >= fx.blockedPairs[0].after);
let violations = 0;
for (const g of blockedGames) {
  const s = calculateSettlement(g.players.map(([playerName, profit]) => ({ playerName, profit })), fx.minTransfer, g.date, fx.blockedPairs);
  const { playerA, playerB } = fx.blockedPairs[0];
  for (const t of s.settlements)
    if ((t.from === playerA && t.to === playerB) || (t.from === playerB && t.to === playerA)) violations++;
}
check(`blocked pair never paired across ${blockedGames.length} games`, violations === 0, `${violations} violations`);

// Shapes the real data does not cover.
verify('two players', [{ playerName: 'A', profit: 100 }, { playerName: 'B', profit: -100 }], 5);
verify('everyone flat', [{ playerName: 'A', profit: 0 }, { playerName: 'B', profit: 0 }], 5);
verify('one winner many losers', [
  { playerName: 'W', profit: 700 },
  ...Array.from({ length: 7 }, (_, i) => ({ playerName: `L${i}`, profit: -100 })),
], 5);
verify('tiny tails', [
  { playerName: 'A', profit: 300.4 }, { playerName: 'B', profit: 2.2 }, { playerName: 'C', profit: 1.1 },
  { playerName: 'D', profit: -1.8 }, { playerName: 'E', profit: -301.9 },
], 5);
verify('perfect pairs', [
  { playerName: 'A', profit: 50 }, { playerName: 'B', profit: -50 },
  { playerName: 'C', profit: 120 }, { playerName: 'D', profit: -120 },
  { playerName: 'E', profit: 75 }, { playerName: 'F', profit: -75 },
], 5);

// Shared expenses run through the same engine with pizza folded into the
// balances, so a night with food has to come out square too.
{
  const players = [
    { playerId: 'p1', playerName: 'A', profit: 200 },
    { playerId: 'p2', playerName: 'B', profit: -40 },
    { playerId: 'p3', playerName: 'C', profit: -60 },
    { playerId: 'p4', playerName: 'D', profit: -100 },
  ];
  const expenses = [{
    id: 'e1', amount: 120, paidBy: 'p2', paidByName: 'B',
    participants: ['p1', 'p2', 'p3', 'p4'],
    participantNames: ['A', 'B', 'C', 'D'],
  }];
  const { settlements, smallTransfers } = calculateCombinedSettlement(players, expenses, 5);
  const net = new Map(players.map(p => [p.playerName, 0]));
  for (const t of [...settlements, ...smallTransfers]) {
    net.set(t.from, net.get(t.from) - t.amount);
    net.set(t.to, net.get(t.to) + t.amount);
  }
  // B fronted 120 for food shared four ways, so B is up 90 against the table.
  const expected = { A: 200 - 30, B: -40 + 120 - 30, C: -60 - 30, D: -100 - 30 };
  for (const [name, want] of Object.entries(expected)) {
    check(`combined: ${name} settled`, Math.abs(net.get(name) - want) < 1.01,
      `owed ${want}, moved ${net.get(name).toFixed(2)}`);
  }
}

// Group sizes past the exhaustive cap, which is where the narrowed search and
// the greedy floor take over. Also the place a perf regression would show up.
for (const n of [9, 10, 11, 12, 13, 16]) {
  const players = Array.from({ length: n }, (_, i) => ({
    playerName: `P${i}`,
    profit: Math.round((Math.sin(i * 12.9898) * 400)),
  }));
  const drift = players.reduce((s, p) => s + p.profit, 0);
  players[0].profit -= drift;
  const t0 = performance.now();
  const s = verify(`${n} players`, players, 5);
  const ms = performance.now() - t0;
  check(`${n} players under 1s`, ms < 1000, `took ${ms.toFixed(0)}ms`);
  console.log(`  ${n} players: ${s.length} transfers in ${ms.toFixed(0)}ms`);
}

console.log(`\n${pass} checks passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f}`);
process.exit(failures.length ? 1 : 0);
