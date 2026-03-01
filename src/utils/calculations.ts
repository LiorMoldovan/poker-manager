import { GamePlayer, ChipValue, Settlement, SkippedTransfer, SharedExpense } from '../types';

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
 * Produces exactly k-1 transfers for k members (optimal within a group).
 * Big amounts are matched first so small remainders stay at the tail end.
 */
function settleGroup(group: BalanceEntry[]): Settlement[] {
  const transfers: Settlement[] = [];
  const balances = group.map(b => ({ ...b }));

  for (;;) {
    const creditors = balances
      .filter(b => b.balance > 0.001)
      .sort((a, b) => b.balance - a.balance);
    const debtors = balances
      .filter(b => b.balance < -0.001)
      .sort((a, b) => a.balance - b.balance);

    if (creditors.length === 0 || debtors.length === 0) break;

    const creditor = creditors[0];
    const debtor = debtors[0];

    const amount = Math.min(creditor.balance, Math.abs(debtor.balance));
    if (amount < 0.001) break;

    transfers.push({ from: debtor.name, to: creditor.name, amount });
    creditor.balance -= amount;
    debtor.balance += amount;
  }

  return transfers;
}

/**
 * Core settlement: partition → settle each group → filter small transfers.
 * Called by both poker-only and combined (poker + expenses) flows.
 */
function optimizedSettle(
  balances: BalanceEntry[],
  minTransfer: number
): { settlements: Settlement[]; smallTransfers: SkippedTransfer[] } {
  const active = balances.filter(b => Math.abs(b.balance) > 0.001);
  if (active.length === 0) return { settlements: [], smallTransfers: [] };

  const groups = findMaxZeroSumPartition(active);

  const allTransfers: Settlement[] = [];
  for (const group of groups) {
    allTransfers.push(...settleGroup(group));
  }

  const settlements = allTransfers.filter(t => t.amount >= minTransfer);
  const smallTransfers = allTransfers.filter(t => t.amount < minTransfer);

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
  minTransfer: number
): { settlements: Settlement[]; smallTransfers: SkippedTransfer[] } => {
  const balances = players
    .filter(p => Math.abs(p.profit) > 0.001)
    .map(p => ({ name: p.playerName, balance: p.profit }));

  return optimizedSettle(balances, minTransfer);
};

// Clean up floating-point artifacts, round to whole numbers, and add thousand separators (e.g., 30.7 -> 31, 1234 -> 1,234)
export const cleanNumber = (num: number): string => {
  const rounded = Math.round(num);
  return rounded.toLocaleString('en-US');
};

export const formatCurrency = (amount: number): string => {
  const sign = amount >= 0 ? '' : '-';
  return `${sign}₪${cleanNumber(Math.abs(amount))}`;
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
  minTransfer: number
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

  return optimizedSettle(balances, minTransfer);
};

