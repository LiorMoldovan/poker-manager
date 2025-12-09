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
  // Create copies with profit values
  const winners = players
    .filter(p => p.profit > 0)
    .map(p => ({ name: p.playerName, profit: p.profit }))
    .sort((a, b) => b.profit - a.profit);

  const losers = players
    .filter(p => p.profit < 0)
    .map(p => ({ name: p.playerName, profit: p.profit }))
    .sort((a, b) => a.profit - b.profit);

  const settlements: Settlement[] = [];
  const smallTransfers: SkippedTransfer[] = [];

  let winnerIdx = 0;
  let loserIdx = 0;

  while (winnerIdx < winners.length && loserIdx < losers.length) {
    const winner = winners[winnerIdx];
    const loser = losers[loserIdx];

    const amount = Math.min(winner.profit, Math.abs(loser.profit));

    if (amount > 0) {
      // Round to 2 decimal places to preserve half-rebuy precision
      const roundedAmount = Math.round(amount * 100) / 100;
      const transfer = {
        from: loser.name,
        to: winner.name,
        amount: roundedAmount,
      };
      
      // All transfers are included in settlements
      settlements.push(transfer);
      
      // Track which ones are small (below threshold) for display purposes
      if (roundedAmount < minTransfer) {
        smallTransfers.push(transfer);
      }
    }

    winner.profit -= amount;
    loser.profit += amount;

    if (winner.profit <= 0) winnerIdx++;
    if (loser.profit >= 0) loserIdx++;
  }

  return { settlements, smallTransfers };
};

export const formatCurrency = (amount: number): string => {
  const absAmount = Math.abs(amount);
  const sign = amount >= 0 ? '' : '-';
  // Show exact number - no rounding
  return `${sign}₪${absAmount}`;
};

export const getProfitColor = (profit: number): string => {
  if (profit > 0) return 'profit';
  if (profit < 0) return 'loss';
  return 'neutral';
};

