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

// Poll sharing now uses screenshot capture (see PollShareCard in ScheduleTab.tsx)
// instead of text — keeps WhatsApp output consistent with the rest of the app.

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
 * Capture the rendered comic + share it as a single PNG via WhatsApp / native share.
 *
 * The comic is always 1 page (square aspect), so we never need the slicing
 * logic that the long-summary share uses. Reuses html2canvas via dynamic
 * import (already a chunk in the bundle).
 */
export const shareComicImage = async (
  element: HTMLElement,
  gameDateLabel: string,
): Promise<void> => {
  const { default: html2canvas } = await import('html2canvas');
  const restore = freezeAnimations(element);

  let canvas: HTMLCanvasElement;
  try {
    canvas = await html2canvas(element, {
      backgroundColor: '#0a0a0a',
      scale: 2,
      useCORS: true,
      logging: false,
    });
  } finally {
    restore();
  }

  const blob = await new Promise<Blob>((resolve) => {
    canvas.toBlob((b) => resolve(b!), 'image/png', 1.0);
  });

  const safeDate = gameDateLabel.replace(/[^\w\u0590-\u05FF\-_.]/g, '_');
  const file = new File([blob], `poker-comic-${safeDate}.png`, { type: 'image/png' });

  await shareFiles([file], 'Poker Manager — Comic');
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

