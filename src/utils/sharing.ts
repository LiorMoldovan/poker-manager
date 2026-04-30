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

// Floor on slice height (in canvas px). When the boundary-aware splitter
// snaps interior slice boundaries to data-share-split anchors, we refuse
// any snap that would shrink the previous OR next slice below this — so
// we never produce a degenerate sliver that's too short to be useful.
// 300 canvas px ≈ 150 CSS px at the default scale of 2.
const MIN_SLICE_HEIGHT_CANVAS = 300;

// Boundary-snap tolerance: an anchor is only considered if it sits within
// ±15% of the natural slice height of the slot it's snapping into. Beyond
// that we fall back to the natural boundary (current behavior) instead of
// distorting slice sizes. 15% balances "prefer clean cuts" against "don't
// pile content into one slice and starve another".
const SPLIT_SNAP_TOLERANCE = 0.15;

// Gather y-offsets (in canvas px, top-edge of each splittable child)
// declared by the caller via `data-share-split="true"`. Returned values
// are relative to `root`, sorted ascending, with anchors at 0 or
// >= rootHeight filtered out (they're not interior splits). Caller uses
// these as preferred snap points when slicing an overflowing canvas so
// cuts land between semantic blocks (e.g. between two date cards in a
// poll-share invitation) instead of through them.
function collectSplitAnchorsCanvas(root: HTMLElement, scale: number): number[] {
  const rootRect = root.getBoundingClientRect();
  const rootTop = rootRect.top;
  const rootHeightCss = rootRect.height;
  const anchors: number[] = [];
  const els = root.querySelectorAll<HTMLElement>('[data-share-split="true"]');
  for (const el of els) {
    const rect = el.getBoundingClientRect();
    const offsetCss = rect.top - rootTop;
    // Only interior anchors are useful — top (0) and below-bottom anchors
    // wouldn't change any slice boundary.
    if (offsetCss <= 0 || offsetCss >= rootHeightCss) continue;
    anchors.push(Math.round(offsetCss * scale));
  }
  anchors.sort((a, b) => a - b);
  return anchors;
}

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

  // Boundary-aware slicing: if the captured DOM has marked semantic
  // split points (data-share-split="true"), prefer cutting at those
  // boundaries over the naive evenly-spaced ones. We snap interior
  // boundaries only — the first slice always starts at y=0 and the
  // last always ends at canvas.height. Snaps left-to-right so each
  // candidate is checked against the previously-accepted boundary
  // (monotonic) and refuses any snap that would shrink the previous
  // OR next slice below MIN_SLICE_HEIGHT_CANVAS, avoiding slivers.
  const anchors = collectSplitAnchorsCanvas(element, scale);
  const sliceTolerance = sliceH * SPLIT_SNAP_TOLERANCE;
  const boundaries: number[] = [0];
  for (let i = 1; i < sliceCount; i++) {
    const natural = i * sliceH;
    const prev = boundaries[i - 1];
    let chosen = natural;
    if (anchors.length > 0) {
      // Pick the closest anchor to the natural boundary, then accept
      // it only if all three guards hold (tolerance + monotonic +
      // both adjacent slices stay above MIN_SLICE_HEIGHT_CANVAS).
      let best: number | null = null;
      let bestDist = Infinity;
      for (const a of anchors) {
        const d = Math.abs(a - natural);
        if (d < bestDist) { bestDist = d; best = a; }
      }
      if (best !== null
        && bestDist <= sliceTolerance
        && best - prev >= MIN_SLICE_HEIGHT_CANVAS
        && canvas.height - best >= MIN_SLICE_HEIGHT_CANVAS) {
        chosen = best;
      }
    }
    boundaries.push(chosen);
  }
  boundaries.push(canvas.height);

  const files: File[] = [];
  for (let i = 0; i < sliceCount; i++) {
    const y = boundaries[i];
    const h = boundaries[i + 1] - y;
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
 *
 * `text` becomes the share caption — WhatsApp / Telegram / Messages auto-linkify
 * URLs inside it, so passing a URL here makes it tappable on the recipient's
 * side (the URL inside the rasterised image itself is just pixels). The
 * Web Share API picks up `text` on iOS, Android, and most desktop sheets,
 * though specific apps may render it as a caption, a quoted message body,
 * or drop it entirely — that's why we *also* keep the URL inside the
 * image as a typeable fallback.
 */
export const shareFiles = async (
  files: File[],
  title?: string,
  text?: string,
): Promise<void> => {
  if (navigator.share && navigator.canShare({ files })) {
    try {
      await navigator.share({
        files,
        title: title || 'Poker Manager',
        ...(text ? { text } : {}),
      });
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

