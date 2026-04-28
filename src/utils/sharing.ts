import { GamePlayer, Settlement, SkippedTransfer, ChipValue, GamePoll, GamePollDate } from '../types';
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
  const d = new Date(date);
  const gameDate = `${d.getDate()}/${d.getMonth() + 1}`;
  const weekday = d.toLocaleDateString('he-IL', { weekday: 'long' });

  // LTR mark to force left-to-right display in WhatsApp
  const LTR = '\u200E';

  let summary = `🃏 *ערב פוקר* | ${weekday} ${gameDate}\n`;
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
      ? `\u200E+${cleanNumber(player.profit)}` 
      : `-${cleanNumber(Math.abs(player.profit))}`;
    
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
      summary += `${cleanNumber(Math.abs(chipGapPerPlayer || 0))}/player (extra chips)\n`;
    } else {
      summary += `\u200E+${cleanNumber(Math.abs(chipGapPerPlayer || 0))}/player (missing chips)\n`;
    }
  }

  // Settlements section
  if (settlements.length > 0) {
    summary += `\n💸 *PAYMENTS*\n`;
    settlements.forEach(s => {
      summary += `${LTR}• ${s.from} ➜ ${s.to}: *${cleanNumber(s.amount)}*\n`;
    });
  }

  // Small amounts section
  if (skippedTransfers.length > 0) {
    summary += `\n💡 _Small amounts (optional):_\n`;
    skippedTransfers.forEach(s => {
      summary += `${LTR}• ${s.from} ➜ ${s.to}: ${cleanNumber(s.amount)}\n`;
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

// ─── Game Scheduling Polls ───────────────────────────────────

const formatHebrewDateForShare = (date: GamePollDate): string => {
  try {
    const d = new Date(`${date.proposedDate}T${date.proposedTime || '21:00'}`);
    const weekday = d.toLocaleDateString('he-IL', { weekday: 'long' });
    const dd = d.getDate();
    const mm = d.getMonth() + 1;
    const time = date.proposedTime ? ` ${date.proposedTime.slice(0, 5)}` : '';
    return `${weekday} ${dd}/${mm}${time}`;
  } catch {
    return date.proposedDate;
  }
};

export const generatePollInvitationText = (poll: GamePoll, dates: GamePollDate[]): string => {
  let text = `🃏 *ערב פוקר חדש* — נא להצביע!\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  text += `📅 *תאריכים מוצעים:*\n`;
  for (const d of dates) {
    const loc = d.location || poll.defaultLocation;
    text += `• ${formatHebrewDateForShare(d)}${loc ? ` — ${loc}` : ''}\n`;
  }
  text += `\n🎯 יעד: ${poll.targetPlayerCount} שחקנים\n`;
  if (poll.note) {
    text += `\n📝 ${poll.note}\n`;
  }
  text += `\n_היכנסו לאפליקציה והצביעו_ 🎲`;
  return text;
};

export const generatePollConfirmationText = (
  poll: GamePoll,
  confirmedDate: GamePollDate,
  playerNames: string[],
): string => {
  const loc = confirmedDate.location || poll.defaultLocation;
  let text = `✅ *המשחק נסגר!*\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  text += `🗓 ${formatHebrewDateForShare(confirmedDate)}\n`;
  if (loc) text += `📍 ${loc}\n`;
  text += `\n👥 *שחקנים מאושרים (${playerNames.length}):*\n`;
  for (const name of playerNames) {
    text += `• ${name}\n`;
  }
  text += `\n_נתראה ליד השולחן_ 🃏`;
  return text;
};

export const generatePollCancellationText = (poll: GamePoll): string => {
  let text = `❌ *ההצבעה בוטלה*\n`;
  text += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  if (poll.note) text += `📋 ${poll.note}\n`;
  if (poll.cancellationReason) {
    text += `\n💬 *סיבה:* ${poll.cancellationReason}\n`;
  }
  text += `\n_Poker Manager_ 🎲`;
  return text;
};

const MAX_SLICE_HEIGHT = 1200;

/**
 * Temporarily disables all CSS animations/transitions on an element tree
 * so html2canvas captures the final rendered state (not mid-animation opacity:0).
 * Returns a cleanup function that restores original styles.
 */
function freezeAnimations(root: HTMLElement): () => void {
  const saved: { el: HTMLElement; animation: string; transition: string; opacity: string }[] = [];
  const elements = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
  for (const el of elements) {
    const cs = getComputedStyle(el);
    if (cs.animation !== 'none' || cs.opacity !== '1' || cs.transition !== 'all 0s ease 0s') {
      saved.push({
        el,
        animation: el.style.animation,
        transition: el.style.transition,
        opacity: el.style.opacity,
      });
      el.style.animation = 'none';
      el.style.transition = 'none';
      el.style.opacity = '1';
    }
  }
  return () => {
    for (const { el, animation, transition, opacity } of saved) {
      el.style.animation = animation;
      el.style.transition = transition;
      el.style.opacity = opacity;
    }
  };
}

/**
 * Captures a DOM element as screenshot(s), splitting vertically if too tall.
 * Returns an array of File objects ready for navigator.share or download.
 */
export const captureAndSplit = async (
  element: HTMLElement,
  baseName: string,
  options?: { scale?: number; backgroundColor?: string }
): Promise<File[]> => {
  const { default: html2canvas } = await import('html2canvas');
  const scale = options?.scale ?? 2;
  const bg = options?.backgroundColor ?? '#0f172a';

  const restore = freezeAnimations(element);

  let canvas: HTMLCanvasElement;
  try {
    canvas = await html2canvas(element, {
      backgroundColor: bg,
      scale,
      useCORS: true,
      logging: false,
    });
  } finally {
    restore();
  }

  const realHeight = canvas.height / scale;
  if (realHeight <= MAX_SLICE_HEIGHT) {
    const blob = await new Promise<Blob>((resolve) => {
      canvas.toBlob((b) => resolve(b!), 'image/png', 1.0);
    });
    return [new File([blob], `${baseName}.png`, { type: 'image/png' })];
  }

  const sliceCount = Math.ceil(canvas.height / (MAX_SLICE_HEIGHT * scale));
  const sliceH = Math.ceil(canvas.height / sliceCount);
  const files: File[] = [];

  for (let i = 0; i < sliceCount; i++) {
    const y = i * sliceH;
    const h = Math.min(sliceH, canvas.height - y);
    const slice = document.createElement('canvas');
    slice.width = canvas.width;
    slice.height = h;
    const ctx = slice.getContext('2d')!;
    ctx.drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h);
    const blob = await new Promise<Blob>((resolve) => {
      slice.toBlob((b) => resolve(b!), 'image/png', 1.0);
    });
    const suffix = sliceCount > 1 ? `-${i + 1}` : '';
    files.push(new File([blob], `${baseName}${suffix}.png`, { type: 'image/png' }));
  }

  return files;
};

/**
 * Share files via navigator.share if available, otherwise download the first file.
 */
export const shareFiles = async (files: File[], title?: string): Promise<void> => {
  if (navigator.share && navigator.canShare({ files })) {
    try {
      await navigator.share({ files, title: title || 'Poker Manager' });
      return;
    } catch { /* user cancelled or error — fall through to download */ }
  }
  const url = URL.createObjectURL(files[0]);
  const a = document.createElement('a');
  a.href = url;
  a.download = files[0].name;
  a.click();
  URL.revokeObjectURL(url);
};

