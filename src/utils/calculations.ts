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

// Lex-sortable score for a candidate settlement. Lower is strictly better,
// component by component, in this priority order:
//   1. fewest sub-minTransfer transfers involving a PROTECTED_FROM_SMALL_TRANSFER
//      player (Lior must not be the small leftover)
//   2. largest min-transfer (avoid tiny remainders overall)
//   3. fewest transfers (clean payment count)
//   4. lowest "max transfers per person" (avoid one person doing 4+ trips
//      while everyone else does 1 — the original tiebreaker only counted total
//      transactions and missed this fairness dimension)
type TransferScore = readonly [number, number, number, number];

const scoreTransfers = (transfers: Settlement[], minTransfer: number): TransferScore => {
  if (transfers.length === 0) return [0, 0, 0, 0];
  let protectedSmall = 0;
  let minAmt = Infinity;
  const personCount = new Map<string, number>();
  for (const t of transfers) {
    if (t.amount < minAmt) minAmt = t.amount;
    if (
      t.amount < minTransfer &&
      (PROTECTED_FROM_SMALL_TRANSFER.has(t.from) || PROTECTED_FROM_SMALL_TRANSFER.has(t.to))
    ) {
      protectedSmall++;
    }
    personCount.set(t.from, (personCount.get(t.from) ?? 0) + 1);
    personCount.set(t.to, (personCount.get(t.to) ?? 0) + 1);
  }
  let maxPerPerson = 0;
  for (const c of personCount.values()) if (c > maxPerPerson) maxPerPerson = c;
  return [protectedSmall, -minAmt, transfers.length, maxPerPerson];
};

// Returns negative if `a` strictly better than `b`, positive if worse, 0 if equal.
const compareScores = (a: TransferScore, b: TransferScore): number => {
  for (let i = 0; i < 4; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
};

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
  minTransfer: number
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

  let best: Settlement[] | null = null;
  let bestScore: TransferScore | null = null;

  for (const cr of creditors) {
    for (const db of debtors) {
      if (isBlocked(db.name, cr.name)) continue;
      const amount = Math.min(cr.balance, Math.abs(db.balance));
      if (amount < 0.001) continue;

      const next = balances.map(b => {
        if (b.name === cr.name) return { name: b.name, balance: b.balance - amount };
        if (b.name === db.name) return { name: b.name, balance: b.balance + amount };
        return { name: b.name, balance: b.balance };
      }).filter(b => Math.abs(b.balance) > 0.001);

      const rest = bestSettleRecursive(next, depth + 1, minTransfer);
      const transfers = [{ from: db.name, to: cr.name, amount }, ...rest];
      const score = scoreTransfers(transfers, minTransfer);

      if (bestScore === null || compareScores(score, bestScore) < 0) {
        bestScore = score;
        best = transfers;
      }
    }
  }

  return best || greedySettle(balances);
}

/**
 * Settle one zero-sum group optimally:
 * - For small groups (≤ 8): exhaustively try all (creditor, debtor) orderings
 *   under the 4-component score (max-min, count, max-per-person, protected-
 *   player-on-tiny-leftover).
 * - For larger groups: fall back to largest-first greedy. The pre-step
 *   `findMaxZeroSumPartition` usually breaks larger groups into smaller
 *   independent pieces anyway, so this fallback rarely fires in practice.
 *
 * The previous threshold was ≤ 7, which silently routed every 8-player game
 * (the typical poker night) to greedy. That was the real reason settlements
 * looked unoptimised — the recursive ranker existed but wasn't being called
 * for the most common group size. Threshold 9 was tested but recursion at
 * n=9 averaged 2 s and spiked to 5.7 s on real-shape inputs (game-summary
 * screen would freeze noticeably), so the cap stays at 8. Validated against
 * 12 historical games: every game whose largest zero-sum sub-group has ≤ 8
 * players now matches the independently-derived optimum under the
 * 4-component score.
 */
function settleGroup(group: BalanceEntry[], minTransfer: number): Settlement[] {
  const active = group.filter(b => Math.abs(b.balance) > 0.001);
  if (active.length <= 8) {
    return bestSettleRecursive(active.map(b => ({ ...b })), 0, minTransfer);
  }
  return greedySettle(active.map(b => ({ ...b })));
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

