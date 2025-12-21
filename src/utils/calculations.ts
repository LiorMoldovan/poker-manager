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
  // Optimized settlement algorithm that AVOIDS small transfers
  // Key insight: When splitting is needed, ensure BOTH parts are >= minTransfer
  // Strategy: For small creditors, use a larger debtor who can pay them fully
  // with a substantial remainder for the main creditor
  
  const balances = players
    .filter(p => Math.abs(p.profit) > 0.001) // Filter out zero balances
    .map(p => ({ name: p.playerName, balance: p.profit }));

  const allTransfers: Settlement[] = [];

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
        allTransfers.push({ from: debtor.name, to: creditor.name, amount });
        
        balances[i].balance = 0;
        balances[j].balance = 0;
      }
    }
  }

  // Step 2: Process creditors from SMALLEST to LARGEST
  // For small creditors, find a larger debtor who can pay them completely
  // This avoids creating small "leftover" payments
  const creditors = balances.filter(b => b.balance > 0.001).sort((a, b) => a.balance - b.balance);
  const debtors = balances.filter(b => b.balance < -0.001);

  for (const creditor of creditors) {
    while (creditor.balance > 0.001) {
      // FIRST PRIORITY: Find a debtor who can pay the FULL remaining creditor amount
      // AND whose remainder after paying would also be >= minTransfer (avoiding small splits)
      const goodSplitDebtor = debtors
        .filter(d => Math.abs(d.balance) > 0.001)
        .filter(d => Math.abs(d.balance) >= creditor.balance + minTransfer) // Can pay full + substantial remainder
        .sort((a, b) => Math.abs(a.balance) - Math.abs(b.balance))[0]; // Smallest that qualifies
      
      if (goodSplitDebtor) {
        const amount = creditor.balance;
        allTransfers.push({ from: goodSplitDebtor.name, to: creditor.name, amount });
        goodSplitDebtor.balance += amount; // Reduce debt (balance is negative)
        creditor.balance = 0;
        continue;
      }
      
      // SECOND PRIORITY: Find a debtor whose ENTIRE debt fits within creditor's remaining need
      // (No split needed for this debtor - they pay their full amount)
      const perfectFitDebtor = debtors
        .filter(d => Math.abs(d.balance) > 0.001)
        .filter(d => Math.abs(d.balance) <= creditor.balance + 0.001)
        .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance))[0]; // Largest that fits
      
      if (perfectFitDebtor) {
        const amount = Math.abs(perfectFitDebtor.balance);
        allTransfers.push({ from: perfectFitDebtor.name, to: creditor.name, amount });
        creditor.balance -= amount;
        perfectFitDebtor.balance = 0;
        continue;
      }
      
      // FALLBACK: No ideal option - use standard greedy matching
      // This may create small transfers, but we tried to avoid them
      const anyDebtor = debtors
        .filter(d => Math.abs(d.balance) > 0.001)
        .sort((a, b) => a.balance - b.balance)[0]; // Largest debt first
      
      if (anyDebtor) {
        const amount = Math.min(creditor.balance, Math.abs(anyDebtor.balance));
        if (amount > 0.001) {
          allTransfers.push({ from: anyDebtor.name, to: creditor.name, amount });
          creditor.balance -= amount;
          anyDebtor.balance += amount;
        }
      } else {
        break; // No more debtors
      }
    }
  }

  // Separate into regular settlements and small transfers
  const settlements = allTransfers.filter(t => t.amount >= minTransfer);
  const smallTransfers = allTransfers.filter(t => t.amount < minTransfer);

  // Sort settlements: first by payer name, then by amount (largest first)
  settlements.sort((a, b) => {
    const nameCompare = a.from.localeCompare(b.from);
    if (nameCompare !== 0) return nameCompare;
    return b.amount - a.amount;
  });

  // Sort small transfers the same way
  smallTransfers.sort((a, b) => {
    const nameCompare = a.from.localeCompare(b.from);
    if (nameCompare !== 0) return nameCompare;
    return b.amount - a.amount;
  });

  return { settlements, smallTransfers };
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

