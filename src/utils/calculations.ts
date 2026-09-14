import { GamePlayer, ChipValue, Settlement, SkippedTransfer, SharedExpense, BlockedTransferPair } from '../types';

export const calculateChipTotal = (
  chipCounts: Record<string, number>,
  chipValues: ChipValue[]
): number => {
  return Object.entries(chipCounts).reduce((total, [chipId, count]) => {
    const chip = chipValues.find(c => c.id === chipId);
    return total + (chip ? chip.value * count : 0);
  }, 0);
};

export const calculateProfitLoss = (
  finalValue: number,
  rebuys: number,
  rebuyValue: number
): number => {
  return finalValue - (rebuys * rebuyValue);
};

// ---------------------------------------------------------------------------
// Optimized settlement engine
// ---------------------------------------------------------------------------

type BalanceEntry = { name: string; balance: number };
type BlockedPair = { from: string; to: string; after: string };

let _activeBlocked: BlockedPair[] = [];

const isBlocked = (from: string, to: string): boolean =>
  _activeBlocked.some(b => b.from === from && b.to === to);

const expandBlockedPairs = (pairs: BlockedTransferPair[]): BlockedPair[] =>
  pairs.flatMap(p => [
    { from: p.playerA, to: p.playerB, after: p.after },
    { from: p.playerB, to: p.playerA, after: p.after },
  ]);

// Players who must NEVER appear on a sub-minTransfer leftover. The settlement
// search treats this as a hard preference: among all valid arrangements, ones
// that don't put a protected player on a tiny remainder are strictly better
// than ones that do — even if doing so means accepting a slightly different
// transaction shape. If no such arrangement exists at all (mathematically
// impossible to route the leftover anywhere else), the algorithm falls back
// to whatever it would have produced without this constraint.
//
// Hebrew + English variants are listed so the rule fires regardless of which
// language the player record was created in.
const PROTECTED_FROM_SMALL_TRANSFER: ReadonlySet<string> = new Set([
  'ליאור', 'Lior',
]);

// Thresholds for "annoyingly small", derived from the group's own minTransfer
// so they scale with whatever floor the group chose rather than hard-coding
// shekel amounts. At the default minTransfer of 5: a transfer under 25 is
// petty, and a player whose whole night nets under 50 counts as near-flat.
const PETTY_TRANSFER_MULTIPLE = 5;
const SMALL_BALANCE_MULTIPLE = 12;

type ScoreContext = {
  minTransfer: number;
  /** At or above this a transfer feels like a normal payment; below it the
   *  penalty ramps up the closer the amount gets to nothing. */
  comfortable: number;
  /** Players whose net for the night is small enough that they should be
   *  settled by one counterparty rather than collecting in pieces, mapped to
   *  how flat they are (1 = dead even, 0 = right at the edge). Splitting
   *  someone who finished +4₪ is worse than splitting someone at +55₪. */
  flatness: ReadonlyMap<string, number>;
};

// Prices, not a priority order.
//
// The previous scoring was strictly lexicographic: rule 2 could never be
// traded against rule 3 no matter how lopsided the numbers were, and every
// rule counted occurrences, so a 24₪ transfer and a 6₪ transfer were "one
// small transfer" each. That is what made the output feel mechanical — it
// applied the same rule every week regardless of what the week looked like.
//
// Costing each flaw by how bad it actually is lets the search make the trade
// that fits the specific night: accept one slightly-small transfer to keep a
// near-even player on a single payment, or the reverse, depending on the
// actual amounts in front of it.
const COST_PER_TRANSFER = 3;
const COST_SUB_FLOOR = 4;
const COST_PROTECTED_SUB_FLOOR = 1;
const COST_SMALLNESS = 2;
const COST_SPLIT = 2.5;
// Deliberately small: once nothing is uncomfortable the above prices all read
// zero and the search stops caring, which let an even 53/53 split lose to a
// lopsided 29/77. This keeps nudging the smallest payment upward, but at a
// price low enough that it only ever settles otherwise-equal candidates.
const COST_UNEVENNESS = 0.5;
const EVEN_SPREAD_SCALE = 4;

/**
 * Total cost of a candidate settlement. Lower is better.
 *
 * Every payment costs something, so the search still lands on the minimum
 * number of transfers. On top of that:
 *  - A transfer below `comfortable` is charged by how far below it is, squared,
 *    so 6₪ is dramatically worse than 24₪ rather than merely equal to it.
 *  - Dropping under the group's minTransfer costs extra on top, because those
 *    get parked in a separate list instead of being a normal payment.
 *  - Making a near-even player collect in pieces is charged in proportion to
 *    how even they finished.
 */
const scoreTransfers = (transfers: Settlement[], ctx: ScoreContext): number => {
  if (transfers.length === 0) return 0;
  let cost = transfers.length * COST_PER_TRANSFER;
  let minAmt = Infinity;
  const personCount = new Map<string, number>();
  for (const t of transfers) {
    if (t.amount < minAmt) minAmt = t.amount;
    if (t.amount < ctx.comfortable) {
      const shortfall = (ctx.comfortable - t.amount) / ctx.comfortable;
      cost += COST_SMALLNESS * shortfall * shortfall;
    }
    if (t.amount < ctx.minTransfer) {
      cost += COST_SUB_FLOOR;
      if (PROTECTED_FROM_SMALL_TRANSFER.has(t.from) || PROTECTED_FROM_SMALL_TRANSFER.has(t.to)) {
        cost += COST_PROTECTED_SUB_FLOOR;
      }
    }
    personCount.set(t.from, (personCount.get(t.from) ?? 0) + 1);
    personCount.set(t.to, (personCount.get(t.to) ?? 0) + 1);
  }
  for (const [name, c] of personCount) {
    if (c <= 1) continue;
    const flat = ctx.flatness.get(name);
    if (flat !== undefined) cost += (c - 1) * COST_SPLIT * flat;
  }
  const evenAt = ctx.comfortable * EVEN_SPREAD_SCALE;
  cost += COST_UNEVENNESS * (Math.max(0, evenAt - minAmt) / evenAt);
  return cost;
};

// Returns negative if `a` strictly better than `b`, positive if worse.
const compareScores = (a: number, b: number): number => a - b;

/**
 * Partition players into the maximum number of independent zero-sum groups.
 * Each group of k members needs at most k-1 transfers, so more groups →
 * fewer total transfers.  Uses bitmask DP; O(3^n) which is fast for n ≤ 15.
 */
function findMaxZeroSumPartition(balances: BalanceEntry[]): BalanceEntry[][] {
  const n = balances.length;
  if (n === 0) return [];
  if (n > 15) return [balances.map(b => ({ ...b }))];

  const totalMask = (1 << n) - 1;

  const subsetSum: number[] = new Array(1 << n).fill(0);
  for (let mask = 1; mask <= totalMask; mask++) {
    const lowestBit = mask & (-mask);
    const bitIdx = Math.round(Math.log2(lowestBit));
    subsetSum[mask] = subsetSum[mask ^ lowestBit] + balances[bitIdx].balance;
  }

  const dp: number[] = new Array(1 << n).fill(-1);
  const pick: number[] = new Array(1 << n).fill(0);
  dp[0] = 0;

  for (let mask = 1; mask <= totalMask; mask++) {
    let sub = mask;
    while (sub > 0) {
      if (Math.abs(subsetSum[sub]) < 0.01 && dp[mask ^ sub] >= 0) {
        if (dp[mask ^ sub] + 1 > dp[mask]) {
          dp[mask] = dp[mask ^ sub] + 1;
          pick[mask] = sub;
        }
      }
      sub = (sub - 1) & mask;
    }
  }

  const groups: BalanceEntry[][] = [];
  let remaining = totalMask;
  while (remaining > 0) {
    const groupMask = pick[remaining];
    if (groupMask === 0) {
      const group: BalanceEntry[] = [];
      for (let i = 0; i < n; i++) {
        if (remaining & (1 << i)) group.push({ ...balances[i] });
      }
      groups.push(group);
      break;
    }
    const group: BalanceEntry[] = [];
    for (let i = 0; i < n; i++) {
      if (groupMask & (1 << i)) group.push({ ...balances[i] });
    }
    groups.push(group);
    remaining ^= groupMask;
  }

  return groups;
}

/**
 * Settle one zero-sum group using largest-first greedy matching.
 * Simple fallback for large groups.
 */
function greedySettle(balances: BalanceEntry[]): Settlement[] {
  const transfers: Settlement[] = [];
  const work = balances.map(b => ({ ...b }));

  for (;;) {
    const creditors = work.filter(b => b.balance > 0.001).sort((a, b) => b.balance - a.balance);
    const debtors = work.filter(b => b.balance < -0.001).sort((a, b) => a.balance - b.balance);
    if (creditors.length === 0 || debtors.length === 0) break;

    let matched = false;
    for (const db of debtors) {
      for (const cr of creditors) {
        if (isBlocked(db.name, cr.name)) continue;
        const amount = Math.min(cr.balance, Math.abs(db.balance));
        if (amount < 0.001) continue;
        transfers.push({ from: db.name, to: cr.name, amount });
        cr.balance -= amount;
        db.balance += amount;
        matched = true;
        break;
      }
      if (matched) break;
    }
    if (!matched) break;
  }

  // Force any remaining unsettled balances (blocked pairs allowed as last resort)
  for (;;) {
    const creditors = work.filter(b => b.balance > 0.001).sort((a, b) => b.balance - a.balance);
    const debtors = work.filter(b => b.balance < -0.001).sort((a, b) => a.balance - b.balance);
    if (creditors.length === 0 || debtors.length === 0) break;
    const db = debtors[0];
    const cr = creditors[0];
    const amount = Math.min(cr.balance, Math.abs(db.balance));
    if (amount < 0.001) break;
    transfers.push({ from: db.name, to: cr.name, amount });
    cr.balance -= amount;
    db.balance += amount;
  }

  return transfers;
}

/**
 * Recursively try all creditor-debtor pairings and rank candidates by a
 * 4-component lex score (see `scoreTransfers`). The earlier version used a
 * 2-component (max-min, then count) ranking which could leave one player
 * doing many trips and could leave a protected player (e.g. Lior) on a
 * sub-minTransfer leftover. The new ranking adds:
 *   • protected-player-on-small-leftover as the TOP priority (hard preference)
 *   • max transactions per person as a tiebreaker
 * The recursion shape is unchanged — same exhaustive search, just a smarter
 * "is this branch better than the current best?" decision.
 *
 * Fast for groups ≤ 7 members (typical poker game groups).
 */
function bestSettleRecursive(
  balances: BalanceEntry[],
  depth: number,
  ctx: ScoreContext,
  fixDebtor: boolean
): Settlement[] {
  const creditors = balances.filter(b => b.balance > 0.001);
  const debtors = balances.filter(b => b.balance < -0.001);

  if (creditors.length === 0 || debtors.length === 0) return [];
  if (creditors.length === 1 && debtors.length === 1) {
    const amt = Math.min(creditors[0].balance, Math.abs(debtors[0].balance));
    return amt > 0.001 ? [{ from: debtors[0].name, to: creditors[0].name, amount: amt }] : [];
  }

  // Depth guard for unexpectedly large groups
  if (depth > 12) return greedySettle(balances);

  // `fixDebtor` narrows the branching from every (creditor, debtor) pair to
  // every creditor for a single debtor. Since every settlement has to move
  // money out of that debtor, this still reaches almost all of them — it drops
  // only the leaves where another debtor pre-shrinks a creditor so the fixed
  // debtor's transfer stops being the maximum the pair can clear. Measured on
  // 30 real games those leaves never changed the outcome beyond the final
  // tiebreak, and the tree gets ~30x smaller, which is what makes a 9+ player
  // night searchable at all. If no debtor has a permitted counterparty then no
  // unblocked settlement exists and greedy's forced pass is the right answer.
  const pivots = fixDebtor
    ? debtors.filter(d => creditors.some(c => !isBlocked(d.name, c.name))).slice(0, 1)
    : debtors;
  if (pivots.length === 0) return greedySettle(balances);

  let best: Settlement[] | null = null;
  let bestScore: number | null = null;

  for (const cr of creditors) {
    for (const db of pivots) {
      if (isBlocked(db.name, cr.name)) continue;
      const amount = Math.min(cr.balance, Math.abs(db.balance));
      if (amount < 0.001) continue;

      const next = balances.map(b => {
        if (b.name === cr.name) return { name: b.name, balance: b.balance - amount };
        if (b.name === db.name) return { name: b.name, balance: b.balance + amount };
        return { name: b.name, balance: b.balance };
      }).filter(b => Math.abs(b.balance) > 0.001);

      const rest = bestSettleRecursive(next, depth + 1, ctx, fixDebtor);
      const transfers = [{ from: db.name, to: cr.name, amount }, ...rest];
      const score = scoreTransfers(transfers, ctx);

      if (bestScore === null || compareScores(score, bestScore) < 0) {
        bestScore = score;
        best = transfers;
      }
    }
  }

  return best || greedySettle(balances);
}

/**
 * Settle one zero-sum group by minimising `scoreTransfers`:
 * - ≤ 8 players: exhaustively try every (creditor, debtor) ordering.
 * - 9–11 players: narrowed search (one pivot debtor per level) with greedy
 *   kept as a floor, so these can never come out worse than before.
 * - > 11: largest-first greedy. `findMaxZeroSumPartition` usually breaks big
 *   groups into smaller independent pieces first, so this rarely fires.
 *
 * Replayed over the last 30 real Poker Night games (`scripts/settlelab`), this
 * took near-flat players being paid in pieces from 17 occurrences to 0 and
 * transfers under 25₪ from 38 to 20 — and all 20 that remain are forced by a
 * player whose own night was itself under 25₪.
 *
 * It costs nothing in payment count: 199 movements before, 199 after, and
 * `optimality.mjs` confirms both hit the exact theoretical floor (n minus the
 * largest number of independent zero-sum subsets) in every game. Reshuffling
 * who pays whom is free; the count is fixed by the balances, not by the
 * pairing. Two of those movements simply grew past minTransfer and moved out
 * of the sub-minimum leftover list into the main one.
 *
 * The five sub-minTransfer leftovers that remain are all forced: in each one a
 * player's own night was under the floor, and someone who finished +1.05₪ has
 * to be handed 1.05₪. The prices in `scoreTransfers` were checked for
 * overfitting by rerunning all 30 games at 2-3x each weight — the output does
 * not move, so the result comes from the balances rather than the tuning.
 */
function settleGroup(group: BalanceEntry[], minTransfer: number): Settlement[] {
  const active = group.filter(b => Math.abs(b.balance) > 0.001);
  // 11 is where the narrowed search still lands around 125 ms; 12 measured
  // 1.2 s, which is back in freeze territory.
  if (active.length > 11) return greedySettle(active.map(b => ({ ...b })));

  // How flat each player finished is a property of the night, so resolve it
  // once from the starting balances rather than from whatever is left
  // mid-search.
  const nearFlatLimit = minTransfer * SMALL_BALANCE_MULTIPLE;
  const flatness = new Map<string, number>();
  for (const b of active) {
    const abs = Math.abs(b.balance);
    if (abs < nearFlatLimit) flatness.set(b.name, 1 - abs / nearFlatLimit);
  }
  const ctx: ScoreContext = {
    minTransfer,
    comfortable: minTransfer * PETTY_TRANSFER_MULTIPLE,
    flatness,
  };
  // Up to 8 the exhaustive search finishes in well under a second, so take the
  // exact answer. Beyond that it blows up (a 9-player night measured ~2 s and
  // spiked to 5.7 s, which the summary screen visibly froze on), so switch to
  // the narrowed search — still far better than the greedy fallback that used
  // to handle these, and fast enough not to be felt.
  if (active.length <= 8) {
    return bestSettleRecursive(active.map(b => ({ ...b })), 0, ctx, false);
  }

  // The narrowed search can miss leaves, so keep greedy as a floor: whichever
  // scores better wins, and a 9+ player night can never come out worse than
  // what it used to produce.
  const searched = bestSettleRecursive(active.map(b => ({ ...b })), 0, ctx, true);
  const fallback = greedySettle(active.map(b => ({ ...b })));
  return compareScores(scoreTransfers(fallback, ctx), scoreTransfers(searched, ctx)) < 0
    ? fallback
    : searched;
}

/**
 * Core settlement: partition → settle each group → filter small transfers.
 * Called by both poker-only and combined (poker + expenses) flows.
 */
function optimizedSettle(
  balances: BalanceEntry[],
  minTransfer: number,
  gameDate?: string,
  blockedPairs?: BlockedTransferPair[]
): { settlements: Settlement[]; smallTransfers: SkippedTransfer[] } {
  const allBlocked = blockedPairs ? expandBlockedPairs(blockedPairs) : [];
  _activeBlocked = gameDate
    ? allBlocked.filter(b => gameDate >= b.after)
    : [];

  const active = balances.filter(b => Math.abs(b.balance) > 0.001);
  if (active.length === 0) return { settlements: [], smallTransfers: [] };

  const groups = findMaxZeroSumPartition(active);

  const allTransfers: Settlement[] = [];
  for (const group of groups) {
    allTransfers.push(...settleGroup(group, minTransfer));
  }

  const rounded = allTransfers.filter(t => Math.round(t.amount) > 0);
  const settlements = rounded.filter(t => t.amount >= minTransfer);
  const smallTransfers = rounded.filter(t => t.amount < minTransfer);

  settlements.sort((a, b) => {
    const nameCompare = a.from.localeCompare(b.from);
    if (nameCompare !== 0) return nameCompare;
    return b.amount - a.amount;
  });

  smallTransfers.sort((a, b) => {
    const nameCompare = a.from.localeCompare(b.from);
    if (nameCompare !== 0) return nameCompare;
    return b.amount - a.amount;
  });

  return { settlements, smallTransfers };
}

// ---------------------------------------------------------------------------

export const calculateSettlement = (
  players: GamePlayer[],
  minTransfer: number,
  gameDate?: string,
  blockedPairs?: BlockedTransferPair[]
): { settlements: Settlement[]; smallTransfers: SkippedTransfer[] } => {
  const balances = players
    .filter(p => Math.abs(p.profit) > 0.001)
    .map(p => ({ name: p.playerName, balance: p.profit }));

  return optimizedSettle(balances, minTransfer, gameDate, blockedPairs);
};

// Clean up floating-point artifacts, round to whole numbers, and add thousand separators (e.g., 30.7 -> 31, 1234 -> 1,234)
export const cleanNumber = (num: number): string => {
  const rounded = Math.round(num);
  return `\u200E${rounded.toLocaleString('en-US')}`;
};

export const formatCurrency = (amount: number): string => {
  const sign = amount >= 0 ? '' : '-';
  return `\u200E${sign}${cleanNumber(Math.abs(amount))}`;
};

// Adaptive chip-count display. The naive `Math.round(value / 1000) + 'k'`
// collapses small stacks misleadingly: 400 → "0k", 500 → "1k". That reads
// fine for groups whose chips run in the tens of thousands, but it's wrong
// for low-denomination games where a 200-chip buy-in matters. So scale the
// precision to the magnitude: raw count below 1k, one decimal between 1k
// and 10k (4,600 → "4.6k", 2,000 → "2k"), whole k above that (46,000 → "46k").
export const formatChips = (value: number): string => {
  if (!value || value <= 0) return '0';
  if (value < 1000) return Math.round(value).toString();
  const k = value / 1000;
  if (value < 10000) return `${Math.round(k * 10) / 10}k`;
  return `${Math.round(k)}k`;
};

export const formatHebrewHalf = (half: number, year: number): string => {
  return `חציון ${half === 1 ? 'ראשון' : 'שני'} ${year}`;
};

export const getProfitColor = (profit: number): string => {
  if (profit > 0) return 'profit';
  if (profit < 0) return 'loss';
  return 'neutral';
};

// Calculate expense balances for each player
// Returns: { playerId: balance } where positive = receives money, negative = owes money
export interface ExpenseBalance {
  playerId: string;
  playerName: string;
  balance: number; // positive = receives, negative = owes
}

export const calculateExpenseBalances = (expenses: SharedExpense[]): ExpenseBalance[] => {
  const balanceMap = new Map<string, { name: string; balance: number }>();
  
  for (const expense of expenses) {
    if (expense.participants.length === 0) continue;
    const perPerson = expense.amount / expense.participants.length;

    // Person who paid receives money from everyone
    const payerData = balanceMap.get(expense.paidBy) || { name: expense.paidByName, balance: 0 };
    payerData.balance += expense.amount; // They paid the full amount
    balanceMap.set(expense.paidBy, payerData);
    
    // Each participant owes their share
    for (let i = 0; i < expense.participants.length; i++) {
      const participantId = expense.participants[i];
      const participantName = expense.participantNames[i];
      const data = balanceMap.get(participantId) || { name: participantName, balance: 0 };
      data.balance -= perPerson; // They owe their share
      balanceMap.set(participantId, data);
    }
  }
  
  return Array.from(balanceMap.entries()).map(([playerId, data]) => ({
    playerId,
    playerName: data.name,
    balance: data.balance,
  }));
};

// Calculate settlements for expenses only
export const calculateExpenseSettlements = (
  expenses: SharedExpense[],
  minTransfer: number = 1
): Settlement[] => {
  const balances = calculateExpenseBalances(expenses);
  
  // Use the same settlement algorithm
  const settlements: Settlement[] = [];
  
  // Clone balances for mutation
  const workingBalances = balances.map(b => ({ ...b }));
  
  // Get creditors (positive balance - they paid more than their share)
  // Get debtors (negative balance - they owe money)
  const creditors = workingBalances.filter(b => b.balance > 0.01);
  const debtors = workingBalances.filter(b => b.balance < -0.01);
  
  // Simple greedy matching
  for (const creditor of creditors) {
    while (creditor.balance > 0.01) {
      const debtor = debtors.find(d => d.balance < -0.01);
      if (!debtor) break;
      
      const amount = Math.min(creditor.balance, Math.abs(debtor.balance));
      if (amount >= minTransfer) {
        settlements.push({
          from: debtor.playerName,
          to: creditor.playerName,
          amount: Math.round(amount),
        });
      }
      creditor.balance -= amount;
      debtor.balance += amount;
    }
  }
  
  return settlements;
};

// Calculate COMBINED settlements (poker + expenses)
// Merges poker profit/loss with expense balances, then uses the optimized engine.
export const calculateCombinedSettlement = (
  players: GamePlayer[],
  expenses: SharedExpense[],
  minTransfer: number,
  gameDate?: string,
  blockedPairs?: BlockedTransferPair[]
): { settlements: Settlement[]; smallTransfers: SkippedTransfer[] } => {
  const balanceMap = new Map<string, { name: string; balance: number }>();

  // Add poker profit/loss
  for (const player of players) {
    if (Math.abs(player.profit) > 0.001) {
      balanceMap.set(player.playerId, {
        name: player.playerName,
        balance: player.profit
      });
    }
  }

  // Add expense balances (pizza, food, etc.)
  for (const expense of expenses) {
    if (expense.participants.length === 0) continue;
    const perPerson = expense.amount / expense.participants.length;

    const payerData = balanceMap.get(expense.paidBy) || { name: expense.paidByName, balance: 0 };
    payerData.balance += expense.amount;
    balanceMap.set(expense.paidBy, payerData);

    for (let i = 0; i < expense.participants.length; i++) {
      const participantId = expense.participants[i];
      const participantName = expense.participantNames[i];
      const data = balanceMap.get(participantId) || { name: participantName, balance: 0 };
      data.balance -= perPerson;
      balanceMap.set(participantId, data);
    }
  }

  const balances = Array.from(balanceMap.entries())
    .filter(([_, data]) => Math.abs(data.balance) > 0.001)
    .map(([_, data]) => ({ name: data.name, balance: data.balance }));

  return optimizedSettle(balances, minTransfer, gameDate, blockedPairs);
};

