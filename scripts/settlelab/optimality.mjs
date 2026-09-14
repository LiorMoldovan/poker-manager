// Answers one question: are we hitting the minimum possible number of
// transfers, and where we are not, what did the extra payment buy?
//
// The floor is exact. Partition the players into the largest possible number
// of independent zero-sum subsets (bitmask DP, same as the engine's pre-step);
// a subset of size m always settles in m-1 transfers, so with k subsets over n
// players the minimum is n - k, and it is always achievable.
//
//   node scripts/settlelab/optimality.mjs
import { readFileSync } from 'node:fs';

const { games } = JSON.parse(readFileSync('scripts/settlelab/games.json', 'utf8'));
const before = JSON.parse(readFileSync('scripts/settlelab/out/before.json', 'utf8'));
const after = JSON.parse(readFileSync('scripts/settlelab/out/baseline.json', 'utf8'));

function minTransfers(balances) {
  const n = balances.length;
  if (n === 0) return 0;
  const total = (1 << n) - 1;
  const sum = new Array(1 << n).fill(0);
  for (let mask = 1; mask <= total; mask++) {
    const low = mask & -mask;
    sum[mask] = sum[mask ^ low] + balances[Math.round(Math.log2(low))];
  }
  // dp[mask] = max number of zero-sum subsets this mask can be cut into
  const dp = new Array(1 << n).fill(-1);
  dp[0] = 0;
  for (let mask = 1; mask <= total; mask++) {
    for (let sub = mask; sub > 0; sub = (sub - 1) & mask) {
      if (Math.abs(sum[sub]) < 0.01 && dp[mask ^ sub] >= 0) {
        dp[mask] = Math.max(dp[mask], dp[mask ^ sub] + 1);
      }
    }
  }
  return n - dp[total];
}

let atFloorBefore = 0, atFloorAfter = 0;
const above = [];
console.log('date          n   floor   before   after');
for (const g of games) {
  const active = g.players.filter(([, p]) => Math.abs(p) > 0.001);
  const floor = minTransfers(active.map(([, p]) => p));
  // Count every movement the engine produced, including the sub-minTransfer
  // ones it parks in the "skipped" list — those are still transfers it had to
  // create, they just get shown separately in the UI.
  const bRow = before.find(r => r.date === g.date);
  const aRow = after.find(r => r.date === g.date);
  const b = bRow.transfers + bRow.skipped;
  const a = aRow.transfers + aRow.skipped;
  if (b === floor) atFloorBefore++;
  if (a === floor) atFloorAfter++;
  else above.push({ date: g.date, floor, a });
  const mark = a === floor ? '' : `   <- ${a - floor} above floor`;
  console.log(`${g.date}  ${String(active.length).padStart(2)}  ${String(floor).padStart(6)}  ${String(b).padStart(6)}  ${String(a).padStart(6)}${mark}`);
}

console.log(`\nold engine hit the minimum in ${atFloorBefore}/${games.length} games`);
console.log(`new engine hits the minimum in ${atFloorAfter}/${games.length} games`);
for (const x of above) console.log(`  ${x.date}: ${x.a} transfers vs floor of ${x.floor}`);
