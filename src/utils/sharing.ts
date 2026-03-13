import { GamePlayer, Settlement, SkippedTransfer, ChipValue } from '../types';
import { cleanNumber } from './calculations';

// Calculate total chips for a player
const getTotalChipsForPlayer = (player: GamePlayer, chipValues: ChipValue[]): number => {
  let total = 0;
  for (const [chipId, count] of Object.entries(player.chipCounts)) {
    const chip = chipValues.find(c => c.id === chipId);
    if (chip) {
      total += count * chip.value;
    }
  }
  return total;
};

export const generateGameSummary = (
  date: string,
  players: GamePlayer[],
  settlements: Settlement[],
  skippedTransfers: SkippedTransfer[],
  chipGap?: number | null,
  chipGapPerPlayer?: number | null,
  _rebuyValue?: number,
  chipValues?: ChipValue[]
): string => {
  const gameDate = new Date(date).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

  // LTR mark to force left-to-right display in WhatsApp
  const LTR = '\u200E';

  let summary = `🃏 *Poker Night* | ${gameDate}\n`;
  summary += `━━━━━━━━━━━━━━━━━━━━\n\n`;

  // Sort players by profit (winners first)
  const sortedPlayers = [...players].sort((a, b) => b.profit - a.profit);

  // Results section
  summary += `📊 *RESULTS*\n`;
  summary += `┌──────────────────────┐\n`;
  
  sortedPlayers.forEach((player, index) => {
    // Medal for top 3 (after player name)
    let medal = '';
    if (index === 0 && player.profit > 0) medal = ' 🥇';
    else if (index === 1 && player.profit > 0) medal = ' 🥈';
    else if (index === 2 && player.profit > 0) medal = ' 🥉';
    
    const profitText = player.profit >= 0 
      ? `+₪${cleanNumber(player.profit)}` 
      : `-₪${cleanNumber(Math.abs(player.profit))}`;
    
    const chips = chipValues ? Math.round(getTotalChipsForPlayer(player, chipValues) / 1000) : 0;
    const chipsText = chipValues ? `${chips}k` : '';
    
    summary += `${LTR}│ ${player.playerName}${medal}\n`;
    summary += `${LTR}│    ${profitText} • ${chipsText} chips • ${player.rebuys} buyins\n`;
  });
  
  summary += `└──────────────────────┘\n`;

  // Show chip gap adjustment if present
  if (chipGap && chipGap !== 0) {
    summary += `\n⚠️ Chip adjustment: `;
    if (chipGap > 0) {
      summary += `₪${cleanNumber(Math.abs(chipGapPerPlayer || 0))}/player (extra chips)\n`;
    } else {
      summary += `+₪${cleanNumber(Math.abs(chipGapPerPlayer || 0))}/player (missing chips)\n`;
    }
  }

  // Settlements section
  if (settlements.length > 0) {
    summary += `\n💸 *PAYMENTS*\n`;
    settlements.forEach(s => {
      summary += `${LTR}• ${s.from} ➜ ${s.to}: *₪${cleanNumber(s.amount)}*\n`;
    });
  }

  // Small amounts section
  if (skippedTransfers.length > 0) {
    summary += `\n💡 _Small amounts (optional):_\n`;
    skippedTransfers.forEach(s => {
      summary += `${LTR}• ${s.from} ➜ ${s.to}: ₪${cleanNumber(s.amount)}\n`;
    });
  }

  summary += `\n━━━━━━━━━━━━━━━━━━━━\n`;
  summary += `_Poker Manager_ 🎲`;

  return summary;
};

export const shareToWhatsApp = (text: string): void => {
  const encoded = encodeURIComponent(text);
  window.open(`https://wa.me/?text=${encoded}`, '_blank');
};

