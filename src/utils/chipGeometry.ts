/**
 * Independent geometric chip-counting for the rebuilt photo pipeline (v5.59+).
 *
 * Three methods, voted at the end. The point of three is that they
 * fail independently — when 2/3 agree we have very high confidence
 * even before the LLM weighs in. This is the core "honest confidence"
 * mechanism: we're no longer relying on the LLM agreeing with itself
 * across temperature shots (which can all be wrong in the same
 * direction); we're cross-validating with deterministic image analysis.
 *
 * ────────── Method A: bottom-chip self-calibration ──────────
 *
 *   The bottom chip in any side-view stack is fully visible (no
 *   occlusion from below). Find its top and bottom edges, get its
 *   pixel height, divide the total stack height by it.
 *
 *   Implementation:
 *     1. Apply 1D Sobel-Y along the center column of the crop.
 *     2. Find the strongest gradient in the lower 30% of the crop
 *        = the bottom edge of the stack.
 *     3. Walk up from that edge until we hit the next strong
 *        gradient = the top of the bottom chip / boundary with the
 *        chip above.
 *     4. bottomChipPx = distance between those two edges.
 *     5. Find the stack's top edge (strongest gradient in upper 30%).
 *     6. totalPx = topEdge - bottomEdge.
 *     7. count = round(totalPx / bottomChipPx).
 *
 *   Failure modes (returns null):
 *     - Crop has no strong gradients (chip-on-white-tablecloth case
 *       where the bottom edge has no contrast with the surface).
 *     - The two edges are within 5px (unrealistic; means we found
 *       two boundaries within the same chip).
 *
 *   Confidence scoring: based on how sharp the gradients were AND
 *   how cleanly the count divides. A round-to-9.51 has lower
 *   confidence than round-to-10.05.
 *
 * ────────── Method B: gradient counting ──────────
 *
 *   N stacked chips have N+1 horizontal "edges": top of stack,
 *   N-1 chip-to-chip boundaries, bottom of stack. Detect every
 *   strong horizontal gradient along the center column, count
 *   them, subtract 1.
 *
 *   Implementation:
 *     1. Apply 1D Sobel-Y along the center column.
 *     2. Threshold to find peaks above 50% of max gradient.
 *     3. Merge peaks within 4px of each other (single edge can
 *        register as adjacent peaks at high resolution).
 *     4. count = peakCount - 1.
 *
 *   Failure modes (returns null):
 *     - Fewer than 2 peaks (no countable boundaries).
 *     - Peaks unevenly spaced (variance > 50% of mean spacing —
 *       indicates printed labels or shadows being mis-detected as
 *       chip boundaries).
 *
 *   Confidence scoring: based on how evenly-spaced the peaks are.
 *   Well-formed stacks have uniform inter-peak spacing.
 *
 * ────────── Method C: shared cross-stack calibration ──────────
 *
 *   Caller-orchestrated. The pipeline first runs Method A on the
 *   LARGEST detected stack (most signal = most reliable per-chip-
 *   pixel-height measurement) and gets `bottomChipPxHeight`. That
 *   value is then passed as `sharedChipPxHeight` to ALL other
 *   stacks' geometry calls. count = round(stackHeightPx / sharedPx).
 *
 *   This catches the failure mode where individual bottom-chip
 *   detection is noisy on small stacks (a 2-chip stack has very
 *   little vertical extent for Method A's gradient walk to work
 *   with) but the overall photo's chip dimensions are well-known.
 *
 *   Failure modes (returns null):
 *     - sharedChipPxHeight not provided.
 *     - stack height < sharedChipPxHeight (would round to 0 or 1
 *       which Method A/B already handle).
 *
 *   Confidence inherits from how reliable the shared cal was.
 *
 * ────────── Voting ──────────
 *
 *   Combine outputs in `voteGeometricMethods` (called by the
 *   pipeline after all three have run). The voter picks the most
 *   confident answer when multiple methods agree, the higher answer
 *   when they disagree (anti-undercount bias), and reports null when
 *   all three failed.
 */

import type { DownscaledImage } from './imageUtils';

export type GeometricMethod = 'bottom-chip' | 'gradient-count' | 'shared-cal' | 'failed';

export interface GeometricCountResult {
  count: number | null;
  /** 0-100. */
  confidence: number;
  method: GeometricMethod;
  /** Per-chip pixel height as detected by this method. Returned so the
   *  caller can use it as `sharedChipPxHeight` for other stacks. Null
   *  when the method couldn't measure it (e.g. shared-cal). */
  detectedChipPxHeight: number | null;
  /** Diagnostic: which signal each sub-method produced. Folded into
   *  the per-stack provenance log downstream. */
  diagnostic?: {
    bottomChip?: { count: number | null; confidence: number; chipPx: number | null };
    gradientCount?: { count: number | null; confidence: number };
    sharedCal?: { count: number | null; confidence: number };
  };
}

export interface GeometricCountOptions {
  stackCrop: DownscaledImage;
  /** When supplied, enables Method C (shared cross-stack calibration). */
  sharedChipPxHeight?: number;
}

// ── Tunable thresholds ────────────────────────────────────────────────

/** Sobel-Y peak threshold as fraction of max. Below this, a column-
 *  gradient is too weak to be considered a chip boundary. */
const PEAK_THRESH_FRACTION = 0.50;

/** Two peaks within this many pixels are merged (one edge often
 *  registers as a small cluster of adjacent samples). */
const PEAK_MERGE_GAP = 4;

/** Width of the center vertical strip we sample for Sobel-Y. Wider =
 *  more averaging-out of column-local noise (text labels) at the cost
 *  of per-pixel sensitivity. 7px is a comfortable middle. */
const CENTER_STRIP_WIDTH = 7;

/** A bottom-chip detection is considered reliable only if the bottom
 *  edge and the next-up edge are at least this many pixels apart.
 *  Any closer = we found two boundaries within the same chip. */
const MIN_BOTTOM_CHIP_PX = 5;

/** Maximum chip count we'll ever return — sanity ceiling. Real games
 *  rarely have more than ~25 chips of a single color in one stack. */
const MAX_REASONABLE_COUNT = 30;

// ── Public entry point ───────────────────────────────────────────────

export async function geometricChipCount(
  opts: GeometricCountOptions,
): Promise<GeometricCountResult> {
  const { stackCrop, sharedChipPxHeight } = opts;
  const dataUrl = `data:${stackCrop.mimeType};base64,${stackCrop.base64}`;
  const img = await loadImg(dataUrl);
  const w = img.width;
  const h = img.height;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return { count: null, confidence: 0, method: 'failed', detectedChipPxHeight: null };
  }
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, w, h);
  const px = imageData.data;

  // Compute the per-row Sobel-Y signal once; both Method A and B use it.
  const rowGradient = computeCenterColumnGradient(px, w, h, CENTER_STRIP_WIDTH);

  const methodA = methodBottomChip(rowGradient, h);
  const methodB = methodGradientCount(rowGradient);
  const methodC = methodSharedCal(rowGradient, h, sharedChipPxHeight);

  return voteMethods(methodA, methodB, methodC);
}

// ── Method A: bottom-chip self-calibration ───────────────────────────

interface MethodResult {
  count: number | null;
  confidence: number; // 0-100
  chipPx: number | null;
}

function methodBottomChip(rowGrad: Float32Array, h: number): MethodResult {
  if (rowGrad.length < 20) return { count: null, confidence: 0, chipPx: null };

  const max = maxOf(rowGrad);
  if (max <= 0) return { count: null, confidence: 0, chipPx: null };
  const thresh = max * PEAK_THRESH_FRACTION;

  // Bottom edge: strongest peak in the bottom 30%.
  const bottomZoneStart = Math.floor(h * 0.70);
  let bottomEdge = -1;
  let bottomEdgeStrength = 0;
  for (let y = bottomZoneStart; y < rowGrad.length; y++) {
    if (rowGrad[y] > bottomEdgeStrength) {
      bottomEdgeStrength = rowGrad[y];
      bottomEdge = y;
    }
  }
  if (bottomEdge === -1 || bottomEdgeStrength < thresh) {
    return { count: null, confidence: 0, chipPx: null };
  }

  // Walk up from the bottom edge to find the next strong peak (the
  // top of the bottom chip / boundary with the chip above).
  let nextEdge = -1;
  let nextEdgeStrength = 0;
  for (let y = bottomEdge - MIN_BOTTOM_CHIP_PX; y > 0; y--) {
    if (rowGrad[y] >= thresh && rowGrad[y] >= rowGrad[y - 1] && rowGrad[y] >= rowGrad[y + 1]) {
      nextEdge = y;
      nextEdgeStrength = rowGrad[y];
      break;
    }
  }
  if (nextEdge === -1 || (bottomEdge - nextEdge) < MIN_BOTTOM_CHIP_PX) {
    return { count: null, confidence: 0, chipPx: null };
  }

  const bottomChipPx = bottomEdge - nextEdge;

  // Top edge: strongest peak in the top 30%.
  const topZoneEnd = Math.floor(h * 0.30);
  let topEdge = -1;
  let topEdgeStrength = 0;
  for (let y = 0; y < topZoneEnd; y++) {
    if (rowGrad[y] > topEdgeStrength) {
      topEdgeStrength = rowGrad[y];
      topEdge = y;
    }
  }
  if (topEdge === -1 || topEdgeStrength < thresh) {
    // No clear top edge — but we still have a chip-px measurement.
    // Fall back to using rowGrad.length-bottomEdge as an approximation.
    topEdge = 0;
  }

  const totalPx = bottomEdge - topEdge;
  if (totalPx < bottomChipPx) {
    return { count: null, confidence: 0, chipPx: bottomChipPx };
  }
  const rawCount = totalPx / bottomChipPx;
  const count = Math.round(rawCount);
  if (count < 1 || count > MAX_REASONABLE_COUNT) {
    return { count: null, confidence: 0, chipPx: bottomChipPx };
  }

  // Confidence: gradient sharpness × roundness of the division.
  const gradStrength = Math.min(1, (bottomEdgeStrength + nextEdgeStrength) / (2 * max));
  const roundness = 1 - Math.min(0.5, Math.abs(rawCount - count)); // 0.5 max deviation
  const confidence = Math.round(gradStrength * roundness * 100);

  return { count, confidence, chipPx: bottomChipPx };
}

// ── Method B: gradient counting ──────────────────────────────────────

function methodGradientCount(rowGrad: Float32Array): MethodResult {
  const max = maxOf(rowGrad);
  if (max <= 0) return { count: null, confidence: 0, chipPx: null };
  const thresh = max * PEAK_THRESH_FRACTION;

  // Find local maxima above threshold.
  const peaks: number[] = [];
  for (let y = 1; y < rowGrad.length - 1; y++) {
    if (rowGrad[y] >= thresh &&
        rowGrad[y] >= rowGrad[y - 1] &&
        rowGrad[y] >= rowGrad[y + 1]) {
      peaks.push(y);
    }
  }
  // Merge peaks within PEAK_MERGE_GAP.
  const merged: number[] = [];
  for (const p of peaks) {
    if (merged.length === 0 || (p - merged[merged.length - 1]) > PEAK_MERGE_GAP) {
      merged.push(p);
    } else {
      // Replace with the higher-y of the two (keep the further-down peak).
      // Doesn't matter much — we just don't want to double-count.
    }
  }

  if (merged.length < 2) return { count: null, confidence: 0, chipPx: null };

  // count = boundary_count - 1 (for N chips: top + N-1 internal + bottom = N+1 edges)
  const count = merged.length - 1;
  if (count < 1 || count > MAX_REASONABLE_COUNT) {
    return { count: null, confidence: 0, chipPx: null };
  }

  // Confidence: how evenly-spaced the peaks are.
  // mean spacing, then variance-of-spacing as % of mean.
  const spacings: number[] = [];
  for (let i = 1; i < merged.length; i++) {
    spacings.push(merged[i] - merged[i - 1]);
  }
  const meanSp = spacings.reduce((a, b) => a + b, 0) / spacings.length;
  if (meanSp <= 0) return { count: null, confidence: 0, chipPx: null };
  const variance = spacings.reduce((acc, s) => acc + (s - meanSp) ** 2, 0) / spacings.length;
  const stdDev = Math.sqrt(variance);
  const cv = stdDev / meanSp; // coefficient of variation
  if (cv > 0.50) return { count: null, confidence: 0, chipPx: meanSp }; // too uneven

  const evenness = 1 - Math.min(1, cv * 2); // 0 = perfectly even, 1 = chaotic
  const confidence = Math.round(evenness * 100);
  return { count, confidence, chipPx: meanSp };
}

// ── Method C: shared cross-stack calibration ─────────────────────────

function methodSharedCal(
  rowGrad: Float32Array,
  h: number,
  sharedChipPxHeight: number | undefined,
): MethodResult {
  if (!sharedChipPxHeight || sharedChipPxHeight < MIN_BOTTOM_CHIP_PX) {
    return { count: null, confidence: 0, chipPx: null };
  }

  // Find top + bottom edges using same approach as Method A but
  // independent of bottom-chip detection.
  const max = maxOf(rowGrad);
  if (max <= 0) return { count: null, confidence: 0, chipPx: null };

  // Bottom edge: strongest peak in the bottom 30%.
  const bottomZoneStart = Math.floor(h * 0.70);
  let bottomEdge = -1;
  let bottomEdgeStrength = 0;
  for (let y = bottomZoneStart; y < rowGrad.length; y++) {
    if (rowGrad[y] > bottomEdgeStrength) {
      bottomEdgeStrength = rowGrad[y];
      bottomEdge = y;
    }
  }
  // Top edge: strongest peak in the top 30%.
  const topZoneEnd = Math.floor(h * 0.30);
  let topEdge = -1;
  let topEdgeStrength = 0;
  for (let y = 0; y < topZoneEnd; y++) {
    if (rowGrad[y] > topEdgeStrength) {
      topEdgeStrength = rowGrad[y];
      topEdge = y;
    }
  }
  if (bottomEdge === -1 || topEdge === -1) {
    // Fall back to crop boundaries (less accurate but still a signal).
    if (bottomEdge === -1) bottomEdge = h - 1;
    if (topEdge === -1) topEdge = 0;
  }
  const totalPx = bottomEdge - topEdge;
  if (totalPx < sharedChipPxHeight) return { count: null, confidence: 0, chipPx: null };

  const rawCount = totalPx / sharedChipPxHeight;
  const count = Math.round(rawCount);
  if (count < 1 || count > MAX_REASONABLE_COUNT) {
    return { count: null, confidence: 0, chipPx: null };
  }

  // Confidence: how round the division was, plus edge-strength factor.
  const roundness = 1 - Math.min(0.5, Math.abs(rawCount - count));
  const edgeFactor = Math.min(1, (bottomEdgeStrength + topEdgeStrength) / (2 * max));
  const confidence = Math.round(roundness * edgeFactor * 100);
  return { count, confidence, chipPx: null };
}

// ── Voting ───────────────────────────────────────────────────────────

function voteMethods(
  a: MethodResult,
  b: MethodResult,
  c: MethodResult,
): GeometricCountResult {
  const candidates: Array<{ count: number; confidence: number; method: GeometricMethod }> = [];
  if (a.count !== null) candidates.push({ count: a.count, confidence: a.confidence, method: 'bottom-chip' });
  if (b.count !== null) candidates.push({ count: b.count, confidence: b.confidence, method: 'gradient-count' });
  if (c.count !== null) candidates.push({ count: c.count, confidence: c.confidence, method: 'shared-cal' });

  const diagnostic = {
    bottomChip:    { count: a.count, confidence: a.confidence, chipPx: a.chipPx },
    gradientCount: { count: b.count, confidence: b.confidence },
    sharedCal:     { count: c.count, confidence: c.confidence },
  };

  if (candidates.length === 0) {
    return {
      count: null,
      confidence: 0,
      method: 'failed',
      detectedChipPxHeight: null,
      diagnostic,
    };
  }

  // Count agreements (within ±1).
  const agreementCount = (target: number) =>
    candidates.filter(c2 => Math.abs(c2.count - target) <= 1).length;

  // Sort candidates by descending agreement count, then by confidence.
  const ranked = [...candidates]
    .map(cand => ({ ...cand, agree: agreementCount(cand.count) }))
    .sort((x, y) => y.agree - x.agree || y.confidence - x.confidence);

  const winner = ranked[0];
  // Confidence boost: if 2/3 or 3/3 methods agree, bump to high.
  let finalConfidence = winner.confidence;
  if (winner.agree === candidates.length && candidates.length >= 2) {
    finalConfidence = Math.min(98, Math.round((winner.confidence + 90) / 2));
  } else if (winner.agree >= 2) {
    finalConfidence = Math.min(90, Math.round((winner.confidence + 80) / 2));
  }
  // Anti-undercount bias when methods disagree: prefer the higher count.
  if (winner.agree < candidates.length) {
    const higher = candidates.find(cand => cand.count > winner.count);
    if (higher && higher.count - winner.count <= 2) {
      // Switch to the higher count but keep the lower confidence.
      return {
        count: higher.count,
        confidence: Math.min(75, finalConfidence),
        method: higher.method,
        detectedChipPxHeight: higher.method === 'bottom-chip' ? a.chipPx : null,
        diagnostic,
      };
    }
  }
  return {
    count: winner.count,
    confidence: finalConfidence,
    method: winner.method,
    detectedChipPxHeight: winner.method === 'bottom-chip' ? a.chipPx : null,
    diagnostic,
  };
}

// ── Internal helpers ─────────────────────────────────────────────────

function computeCenterColumnGradient(
  px: Uint8ClampedArray,
  w: number,
  h: number,
  stripWidth: number,
): Float32Array {
  // For each row y, compute Sobel-Y over the center vertical strip,
  // average across the strip's x columns. This gives one gradient
  // value per row, robust to single-column noise (label printing).
  const xCenter = Math.floor(w / 2);
  const xStart = Math.max(0, xCenter - Math.floor(stripWidth / 2));
  const xEnd = Math.min(w - 1, xStart + stripWidth - 1);
  const out = new Float32Array(h);
  const gray = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  };
  for (let y = 1; y < h - 1; y++) {
    let acc = 0;
    let n = 0;
    for (let x = xStart; x <= xEnd; x++) {
      const top = gray(x, y - 1);
      const bot = gray(x, y + 1);
      acc += Math.abs(bot - top);
      n++;
    }
    out[y] = n > 0 ? acc / n : 0;
  }
  return out;
}

function maxOf(arr: Float32Array): number {
  let m = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
  return m;
}

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image failed to load'));
    img.src = src;
  });
}
