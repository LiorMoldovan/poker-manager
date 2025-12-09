import { GamePlayer, ChipValue, Settlement, SkippedTransfer } from '../types';

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

export const calculateSettlement = (
  players: GamePlayer[],
  minTransfer: number
): { settlements: Settlement[]; smallTransfers: SkippedTransfer[] } => {
  // Use optimized minimum transactions algorithm
  const balances = players
    .filter(p => Math.abs(p.profit) > 0.001) // Filter out zero balances
    .map(p => ({ name: p.playerName, balance: p.profit }));

  const settlements: Settlement[] = [];
  const smallTransfers: SkippedTransfer[] = [];

  // Step 1: Find exact matches first (minimizes transactions)
  for (let i = 0; i < balances.length; i++) {
    if (Math.abs(balances[i].balance) < 0.001) continue;
    
    for (let j = i + 1; j < balances.length; j++) {
      if (Math.abs(balances[j].balance) < 0.001) continue;
      
      // Check if they cancel each other out (one positive, one negative, same absolute value)
      const sum = balances[i].balance + balances[j].balance;
      if (Math.abs(sum) < 0.01) {
        const [debtor, creditor] = balances[i].balance < 0 
          ? [balances[i], balances[j]] 
          : [balances[j], balances[i]];
        
        const amount = Math.abs(debtor.balance);
        const transfer = { from: debtor.name, to: creditor.name, amount };
        settlements.push(transfer);
        if (amount < minTransfer) smallTransfers.push(transfer);
        
        balances[i].balance = 0;
        balances[j].balance = 0;
      }
    }
  }

  // Step 2: Greedy matching for remaining balances
  const creditors = balances.filter(b => b.balance > 0.001).sort((a, b) => b.balance - a.balance);
  const debtors = balances.filter(b => b.balance < -0.001).sort((a, b) => a.balance - b.balance);

  let creditorIdx = 0;
  let debtorIdx = 0;

  while (creditorIdx < creditors.length && debtorIdx < debtors.length) {
    const creditor = creditors[creditorIdx];
    const debtor = debtors[debtorIdx];

    const amount = Math.min(creditor.balance, Math.abs(debtor.balance));

    if (amount > 0.001) {
      const transfer = { from: debtor.name, to: creditor.name, amount };
      settlements.push(transfer);
      if (amount < minTransfer) smallTransfers.push(transfer);
    }

    creditor.balance -= amount;
    debtor.balance += amount;

    if (creditor.balance <= 0.001) creditorIdx++;
    if (debtor.balance >= -0.001) debtorIdx++;
  }

  // Sort settlements by amount (largest first) for better readability
  settlements.sort((a, b) => b.amount - a.amount);

  return { settlements, smallTransfers };
};

// Clean up floating-point artifacts (e.g., 30.000000001 -> 30)
export const cleanNumber = (num: number): string => {
  const rounded = Math.round(num * 100) / 100;
  // Convert to string and remove unnecessary trailing zeros
  if (rounded % 1 === 0) {
    return rounded.toString();
  }
  return rounded.toFixed(2).replace(/\.?0+$/, '');
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

