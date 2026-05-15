/**
 * Client-side chip-stack detection for the rebuilt photo chip-counting
 * pipeline (v5.59+).
 *
 * Goal: take a downscaled photo of N chip stacks on a known mat color
 * and return per-stack bounding boxes + dominant body colors + a
 * mapping from each detected region to a configured chip color, plus
 * the white-stripe pixel samples we collected along the way (used by
 * `whiteBalanceFromStripes` to neutralize the camera color cast before
 * the rest of the pipeline runs).
 *
 * Why a custom detector instead of asking Gemini for bounding boxes:
 *   1. Reliability — Gemini's bounding boxes drift across calls and
 *      sometimes the model emits 4 boxes when 5 stacks exist.
 *   2. Latency — adding a box-detection LLM call doubles total wait
 *      and burns free-tier quota.
 *   3. Determinism — vanilla canvas math returns the SAME boxes for
 *      the same input image, every call. The downstream LLM count is
 *      already non-deterministic; we want at least the framing to be
 *      reproducible so failure modes are debuggable.
 *
 * ────────── Algorithm (vanilla canvas, no external deps) ──────────
 *
 *   Step 1 — PRIMARY signal: white-stripe density per column.
 *
 *     Every poker chip in the user's set has white side stripes
 *     regardless of body color. Green felt has near-zero natural
 *     white. So the column-by-column count of "white stripe" pixels
 *     is a robust per-stack indicator that works equally well for
 *     white / red / blue / black / yellow AND green chips on green
 *     felt.
 *
 *     Pixel classification (HSV thresholds):
 *       background   = HSL distance to matColor < BG_TOLERANCE
 *       white-stripe = saturation < 0.20 AND lightness > 0.65
 *       chip-body    = everything else
 *
 *     Per-column white-stripe count is smoothed with a 5px Gaussian-
 *     ish 1D kernel before peak finding to suppress noise from JPEG
 *     compression and label-printing artefacts.
 *
 *   Step 2 — FALLBACK signal: edge density per column.
 *
 *     If primary peak count != expected (e.g. user's chips don't
 *     have white stripes, or the photo angle doesn't expose them),
 *     fall back to per-column Sobel-Y edge magnitude. Any chip-vs-
 *     felt boundary or chip-to-chip boundary contributes; works for
 *     solid-color chips too.
 *
 *   Step 3 — Peak detection.
 *
 *     Local maxima above 30% of the global max, separated by at
 *     least 30px. The gap requirement prevents adjacent columns
 *     within the same stack from registering as multiple stacks.
 *
 *   Step 4 — Per-peak bounding box.
 *
 *     Expand left/right from each peak until column density drops
 *     below 25% of the peak value. Vertical extent: scan rows
 *     within the stack column range, find rows with enough
 *     non-background pixels to be "chip rows", take the contiguous
 *     band. Pad the box by 8% horizontally (so the LLM sees a tiny
 *     bit of context, helping the few-shot reference comparison)
 *     and 4% vertically.
 *
 *   Step 5 — White-balance sample collection.
 *
 *     During pixel classification we record up to 1500 white-stripe
 *     pixels (sampled to keep memory bounded). The set is returned
 *     to the caller so it can compute a single per-photo white-balance
 *     correction matrix via `whiteBalanceFromStripes`.
 *
 *   Step 6 — Per-region body color sampling.
 *
 *     For each detected region, sample the 60% center vertical band
 *     (avoiding the top and bottom chips which often have rim
 *     occlusion or shadow), exclude pixels classified as white-stripe
 *     or background, average the remaining pixels' RGB → HSL. Apply
 *     the photo's white-balance correction so all body colors are
 *     compared in the same color space as the chip selfies (which
 *     were captured under their own lighting and have their own
 *     dominant hex).
 *
 *   Step 7 — Stack-to-chip-color mapping.
 *
 *     For each detected region, compute the HSL distance to every
 *     chip in the palette (using `chip.selfieDominantHex` if present,
 *     else `chip.displayColor`). The closest chip wins. If the
 *     winning distance exceeds DROP_DISTANCE the region is dropped
 *     as debris (a coffee cup, a coin, anything not-a-chip).
 *
 *   Step 8 — Empty-stack gap analysis.
 *
 *     If after dropping debris the surviving region count is less
 *     than the chip palette size, every chip color that wasn't
 *     matched gets a zero-count placeholder region (no LLM call
 *     needed; we already know the answer is 0). Position is filled
 *     in canonical small-to-large order.
 *
 *   Step 9 — Position-only fallback.
 *
 *     If both the primary AND fallback signals fail (no peaks
 *     anywhere — extremely rare; only on completely blank or
 *     corrupt photos), evenly partition the image width into N
 *     regions, assume canonical small-to-large order. The pipeline
 *     ALWAYS returns something so the user can edit manually
 *     instead of being shown an error wall.
 *
 *   Step 10 — Result assembly.
 *
 *     Sort regions left-to-right by x-coordinate (matches the user's
 *     instructed white-to-yellow arrangement). Return the regions
 *     plus the white-balance matrix.
 *
 * Cost: ~120ms on a fast phone for a 1280×960 photo. The expensive
 * step is Step 1's per-pixel HSV classification (1.2M iterations);
 * everything else is O(width).
 */

import type { ChipValue } from '../types';
import {
  type DownscaledImage,
  type RGB,
  type HSL,
  type Region,
  type WhiteBalance,
  rgbToHsl,
  hslDistance,
  hexToRgb,
  whiteBalanceFromStripes,
  applyWhiteBalance,
} from './imageUtils';

// ── Public API ────────────────────────────────────────────────────────

export type DetectedRegionMethod =
  | 'white-stripe'      // primary signal succeeded
  | 'edge-density'      // primary failed, edge fallback used
  | 'position-only'     // both signals failed, even-partition fallback
  | 'empty-stack-gap'   // a chip color the user has 0 of (placeholder)
  | 'unmatched';        // detected but didn't match any chip color (debris)

export interface DetectedStack {
  region: Region;
  dominantRgb: RGB;
  dominantHex: string;
  matchedChipId: string | null;
  matchDistance: number;       // HSL distance to the matched chip's reference
  detectionMethod: DetectedRegionMethod;
}

export interface DetectStackRegionsResult {
  /**
   * Stacks the pipeline should actually count. Always non-empty unless
   * the image was completely unusable. Sorted left-to-right by region.x.
   * Includes empty-stack placeholders (with detectionMethod ='empty-stack-gap'
   * and region.width = 1) for chip colors the user has zero of.
   */
  stacks: DetectedStack[];
  /**
   * Per-photo white-balance correction derived from the white-stripe
   * pixels collected during detection. Apply to any color sample taken
   * downstream (per-stack body color, geometric color sanity check).
   * Identity ({1,1,1}) when not enough stripe pixels were found.
   */
  whiteBalance: WhiteBalance;
  /**
   * Diagnostic: which signal won. Useful for the provenance log so
   * we can tune thresholds based on real-world failure modes.
   */
  signalUsed: 'white-stripe' | 'edge-density' | 'position-only';
  /**
   * Diagnostic: how many stripe pixels we sampled. Below ~50 the
   * white-balance correction is unreliable and we use identity.
   */
  stripeSampleCount: number;
}

// ── Tunable thresholds ────────────────────────────────────────────────
// All collected here so the tuning loop can point at one place when
// adjusting. Each value has a comment explaining the empirical
// reasoning behind it.

/** Background pixel = HSL distance to matColor below this. Lower
 *  threshold = stricter classification. 22 is generous enough to
 *  tolerate JPEG compression noise + lighting gradients on the mat
 *  while not absorbing dark chip pixels. */
const BG_TOLERANCE = 22;

/** White-stripe pixel = saturation BELOW this AND lightness ABOVE the
 *  next threshold. Casino-style chip stripes on a green-felt photo
 *  measured at S~0.05-0.15 / L~0.7-0.95 in our test set; 0.20 / 0.65
 *  catches all of them with margin. */
const STRIPE_S_MAX = 0.20;
const STRIPE_L_MIN = 0.65;

/** Smoothing kernel for the per-column histogram before peak finding.
 *  5 columns wide ≈ 4mm at 1280px / 1m view distance — wide enough to
 *  suppress single-column JPEG noise, narrow enough not to merge
 *  adjacent stacks at min 30px gap. */
const SMOOTH_KERNEL = [1, 4, 6, 4, 1]; // sums to 16
const SMOOTH_KERNEL_SUM = 16;

/** A column counts as a peak if its smoothed value is above this
 *  fraction of the global max. 0.30 catches the small-stack peaks
 *  (e.g. 2-chip stacks visible alongside 10-chip stacks) without
 *  generating noise peaks in the gaps between stacks. */
const PEAK_THRESHOLD_FRACTION = 0.30;

/** Two peaks within this many columns are merged (both belong to the
 *  same stack). 30px is roughly the width of a single chip stack at
 *  our typical capture distance. */
const PEAK_MIN_GAP = 30;

/** Box expansion: walk left/right from peak until smoothed density
 *  drops below this fraction of the peak value. 0.25 keeps the box
 *  tight to the chip body without clipping the white stripes at the
 *  outer edge. */
const BOX_EXPAND_THRESHOLD_FRACTION = 0.25;

/** Padding added to each box (so the LLM sees a tiny bit of context).
 *  8% horizontal because chip body + 1 stripe of context on each side
 *  helps the model lock onto the rim count. 4% vertical because we
 *  don't want to include cuts of an adjacent player's chips. */
const BOX_PAD_X_FRACTION = 0.08;
const BOX_PAD_Y_FRACTION = 0.04;

/** A row counts as containing a chip if it has at least this fraction
 *  of non-background pixels in the stack's column range. 0.20 is low
 *  enough to catch the top chip even when it's only partially visible. */
const ROW_NONBG_THRESHOLD_FRACTION = 0.20;

/** Cap on white-stripe pixels we hand back for white-balance estimation.
 *  More than this and we're spending CPU for diminishing returns. */
const WB_SAMPLE_CAP = 1500;

/** Color matching: a region whose nearest chip is further than this
 *  HSL distance is dropped as debris. 35 was tuned empirically — the
 *  closest "wrong" match in our test set was at distance 28; the
 *  closest correct match was rarely above 20. */
const DROP_DISTANCE = 35;

// ── Implementation ────────────────────────────────────────────────────

export async function detectStackRegions(
  input: DownscaledImage,
  chipPalette: ChipValue[],
  matColorHsl: HSL,
  expectedStackCount: number,
): Promise<DetectStackRegionsResult> {
  const dataUrl = `data:${input.mimeType};base64,${input.base64}`;
  const img = await loadImg(dataUrl);
  const w = img.width;
  const h = img.height;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, w, h);
  const px = imageData.data;

  // ── Step 1: Per-pixel HSV classification ───────────────────────────
  // Three parallel arrays of length w (one entry per column):
  //   stripeCount[x] = number of white-stripe pixels in column x
  //   bgCount[x]     = number of background pixels in column x
  //   chipCount[x]   = w*h - stripe - bg (implicit)
  // Plus a flat array of stripe pixel RGB samples for white-balance.

  const stripeCount = new Float32Array(w);
  const bgCount = new Float32Array(w);
  // Track per-pixel classification so Step 6 can revisit it without
  // re-running HSV math (memory: w*h bytes = 1.2MB at 1280x960; fine).
  const klass = new Uint8Array(w * h); // 0 = chip-body, 1 = white-stripe, 2 = background
  const stripeSamples: RGB[] = [];
  // Sample every Nth qualifying stripe pixel to stay under WB_SAMPLE_CAP.
  // We don't know in advance how many stripes there will be; skip-counter
  // throttles based on running collection rate.
  let stripePxSeen = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = px[i];
      const g = px[i + 1];
      const b = px[i + 2];
      const hsl = rgbToHsl({ r, g, b });

      // Background?
      if (hslDistance(hsl, matColorHsl) < BG_TOLERANCE) {
        bgCount[x]++;
        klass[y * w + x] = 2;
        continue;
      }
      // White stripe?
      if (hsl.s < STRIPE_S_MAX && hsl.l > STRIPE_L_MIN) {
        stripeCount[x]++;
        klass[y * w + x] = 1;
        stripePxSeen++;
        // Reservoir-style throttle: keep at most WB_SAMPLE_CAP samples,
        // distributed evenly across all stripes seen.
        if (stripeSamples.length < WB_SAMPLE_CAP) {
          stripeSamples.push({ r, g, b });
        } else {
          // After reaching cap, replace random old samples with prob
          // (cap / seen) so distribution stays even.
          const replaceIdx = Math.floor(Math.random() * stripePxSeen);
          if (replaceIdx < WB_SAMPLE_CAP) {
            stripeSamples[replaceIdx] = { r, g, b };
          }
        }
        continue;
      }
      // Default: chip body.
      klass[y * w + x] = 0;
    }
  }

  // ── Step 2: Smoothed per-column signal ─────────────────────────────
  const smoothedStripe = smoothColumnSignal(stripeCount);
  const stripePeakMax = maxOf(smoothedStripe);
  const peaksFromStripe = stripePeakMax > 0
    ? findPeaks(smoothedStripe, stripePeakMax * PEAK_THRESHOLD_FRACTION, PEAK_MIN_GAP)
    : [];

  // ── Step 3: Decide which signal to use ─────────────────────────────
  // Primary signal must give us "close enough" to the expected count.
  // "Close enough" = within ±2 of expected. Anything outside that, fall
  // back to edge density which catches solid-color chips too.
  let signalUsed: 'white-stripe' | 'edge-density' | 'position-only' = 'white-stripe';
  let chosenSignal: Float32Array = smoothedStripe;
  let chosenPeaks: number[] = peaksFromStripe;
  if (Math.abs(peaksFromStripe.length - expectedStackCount) > 2) {
    // Fallback: per-column Sobel-Y edge density.
    const edgeSignal = computeEdgeDensityPerColumn(px, w, h);
    const edgeMax = maxOf(edgeSignal);
    const edgePeaks = edgeMax > 0
      ? findPeaks(edgeSignal, edgeMax * PEAK_THRESHOLD_FRACTION, PEAK_MIN_GAP)
      : [];
    if (Math.abs(edgePeaks.length - expectedStackCount) <
        Math.abs(peaksFromStripe.length - expectedStackCount)) {
      signalUsed = 'edge-density';
      chosenSignal = edgeSignal;
      chosenPeaks = edgePeaks;
    }
  }

  // If we STILL have nothing, fall back to even partition.
  let regions: Region[] = [];
  let detectionMethod: DetectedRegionMethod;
  if (chosenPeaks.length === 0) {
    signalUsed = 'position-only';
    detectionMethod = 'position-only';
    regions = evenPartition(w, h, expectedStackCount);
  } else {
    detectionMethod = signalUsed === 'white-stripe' ? 'white-stripe' : 'edge-density';
    // ── Step 4: Per-peak bounding boxes ──────────────────────────────
    const peakMax = maxOf(chosenSignal);
    const expandThresh = peakMax * BOX_EXPAND_THRESHOLD_FRACTION;
    for (const peakX of chosenPeaks) {
      const box = expandPeakToBox(chosenSignal, klass, w, h, peakX, expandThresh);
      if (box) regions.push(box);
    }
  }

  // ── Step 5: White-balance from collected stripe samples ────────────
  const whiteBalance = stripeSamples.length >= 50
    ? whiteBalanceFromStripes(stripeSamples)
    : { rScale: 1, gScale: 1, bScale: 1 };

  // ── Step 6 & 7: Per-region body color + chip mapping ───────────────
  const detected: DetectedStack[] = [];
  for (const region of regions) {
    const bodyRgbRaw = sampleStackBodyColor(px, klass, w, region);
    if (!bodyRgbRaw) continue; // skip regions where every pixel was bg/stripe
    const bodyRgb = applyWhiteBalance(bodyRgbRaw, whiteBalance);
    const bodyHsl = rgbToHsl(bodyRgb);
    const dominantHex = rgbToHexLocal(bodyRgb);

    // Find nearest chip in palette via HSL distance against displayColor.
    //
    // v5.60.14 — abandoned `selfieDominantHex` as a calibration source.
    // History:
    //   * v5.59.0 added per-chip selfies and computed `selfieDominantHex`
    //     from the dead-center 24×24 patch of each selfie. Most poker
    //     chips have a printed value inlay/sticker dead-center, so the
    //     hex always came out as muddy mid-grey (red→#b59e94, blue→
    //     #7b86a3, etc.) — making downstream HSL matching effectively
    //     random and the feature appear totally broken to the user.
    //   * v5.60.13 tried to recover by auto-recomputing the hex via
    //     ring sampling at 30/45/60/75% of canvas radius. But selfies
    //     where the chip doesn't fill the frame (chip on green felt
    //     with mat showing in the corners) had the outer rings (60-75%)
    //     sample the green BACKGROUND instead of the chip — so even
    //     the recompute produced wrong hexes (white chip → #0c805c
    //     dark-green, black chip → #338665 green).
    //   * Conclusion: extracting reliable chip body color from arbitrary
    //     phone selfies is fundamentally fragile (depends on chip size
    //     in frame, presence of inlay, background color — none of which
    //     we can reliably detect client-side without real CV).
    //
    // The user-configured `displayColor` is well-saturated, hue-correct,
    // and 100% reliable. It's the right thing to match against. The
    // selfie JPEG is still valuable as a few-shot reference image for
    // the LLM call (`runSingleStackShot` in geminiAI.ts) — we just
    // stopped pretending the per-chip dominant hex extraction worked.
    let bestId: string | null = null;
    let bestDist = Infinity;
    for (const chip of chipPalette) {
      const refRgb = hexToRgb(chip.displayColor);
      if (!refRgb) continue;
      const refHsl = rgbToHsl(refRgb);
      const d = hslDistance(bodyHsl, refHsl);
      if (d < bestDist) {
        bestDist = d;
        bestId = chip.id;
      }
    }

    detected.push({
      region,
      dominantRgb: bodyRgb,
      dominantHex,
      matchedChipId: bestDist <= DROP_DISTANCE ? bestId : null,
      matchDistance: bestDist,
      detectionMethod: bestDist <= DROP_DISTANCE ? detectionMethod : 'unmatched',
    });
  }

  // Drop unmatched regions (debris).
  const matched = detected.filter(d => d.matchedChipId !== null);

  // ── Step 8: Empty-stack gap analysis ───────────────────────────────
  // Any chip color that didn't get a matched region gets a 0-count
  // placeholder. This handles "player has 0 of green" gracefully.
  const matchedChipIds = new Set(matched.map(d => d.matchedChipId));
  const orderedPalette = [...chipPalette].sort((a, b) => a.value - b.value);
  for (const chip of orderedPalette) {
    if (matchedChipIds.has(chip.id)) continue;
    matched.push({
      region: { x: 0, y: 0, width: 1, height: 1 }, // placeholder; never used for cropping
      dominantRgb: { r: 0, g: 0, b: 0 },
      dominantHex: chip.displayColor,
      matchedChipId: chip.id,
      matchDistance: Infinity,
      detectionMethod: 'empty-stack-gap',
    });
  }

  // ── Step 10: Sort by region.x left-to-right (placeholders pushed last) ──
  matched.sort((a, b) => {
    const aPh = a.detectionMethod === 'empty-stack-gap';
    const bPh = b.detectionMethod === 'empty-stack-gap';
    if (aPh && !bPh) return 1;
    if (!aPh && bPh) return -1;
    return a.region.x - b.region.x;
  });

  return {
    stacks: matched,
    whiteBalance,
    signalUsed,
    stripeSampleCount: stripeSamples.length,
  };
}

// ── Internal helpers ─────────────────────────────────────────────────

function smoothColumnSignal(input: Float32Array): Float32Array {
  const w = input.length;
  const out = new Float32Array(w);
  const half = Math.floor(SMOOTH_KERNEL.length / 2);
  for (let x = 0; x < w; x++) {
    let acc = 0;
    let weightSum = 0;
    for (let k = 0; k < SMOOTH_KERNEL.length; k++) {
      const xx = x + k - half;
      if (xx < 0 || xx >= w) continue;
      acc += input[xx] * SMOOTH_KERNEL[k];
      weightSum += SMOOTH_KERNEL[k];
    }
    out[x] = weightSum > 0 ? acc / SMOOTH_KERNEL_SUM : 0;
  }
  return out;
}

function maxOf(arr: Float32Array): number {
  let m = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
  return m;
}

/** Find local maxima above `threshold`, separated by at least `minGap`. */
function findPeaks(signal: Float32Array, threshold: number, minGap: number): number[] {
  const n = signal.length;
  const candidates: Array<{ x: number; value: number }> = [];
  for (let x = 1; x < n - 1; x++) {
    if (signal[x] < threshold) continue;
    if (signal[x] >= signal[x - 1] && signal[x] >= signal[x + 1]) {
      candidates.push({ x, value: signal[x] });
    }
  }
  // Greedily pick highest peaks first, drop any within minGap of an
  // already-picked peak. This avoids "ridge" peaks (a flat-top stack
  // can register as multiple adjacent local maxima).
  candidates.sort((a, b) => b.value - a.value);
  const picked: Array<{ x: number; value: number }> = [];
  for (const c of candidates) {
    if (picked.some(p => Math.abs(p.x - c.x) < minGap)) continue;
    picked.push(c);
  }
  return picked.map(p => p.x).sort((a, b) => a - b);
}

function expandPeakToBox(
  signal: Float32Array,
  klass: Uint8Array,
  w: number,
  h: number,
  peakX: number,
  expandThresh: number,
): Region | null {
  // Expand left/right from peak until signal drops below threshold.
  let left = peakX;
  while (left > 0 && signal[left - 1] >= expandThresh) left--;
  let right = peakX;
  while (right < w - 1 && signal[right + 1] >= expandThresh) right++;

  // Vertical extent: rows that have enough non-bg pixels in the column range.
  const colRange = right - left + 1;
  const rowMinNonBg = Math.max(3, Math.floor(colRange * ROW_NONBG_THRESHOLD_FRACTION));
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < h; y++) {
    let nonBg = 0;
    for (let x = left; x <= right; x++) {
      if (klass[y * w + x] !== 2) nonBg++;
    }
    if (nonBg >= rowMinNonBg) {
      if (top === -1) top = y;
      bottom = y;
    }
  }
  if (top === -1 || bottom === -1) return null;

  // Apply padding.
  const padX = Math.round((right - left + 1) * BOX_PAD_X_FRACTION);
  const padY = Math.round((bottom - top + 1) * BOX_PAD_Y_FRACTION);
  const x = Math.max(0, left - padX);
  const y = Math.max(0, top - padY);
  const width = Math.min(w - x, right - left + 1 + 2 * padX);
  const height = Math.min(h - y, bottom - top + 1 + 2 * padY);
  if (width < 8 || height < 8) return null; // too small to be a real stack
  return { x, y, width, height };
}

/** Per-column edge density via 1D Sobel-Y on the whole image — fallback
 *  signal when white-stripe density doesn't pan out. */
function computeEdgeDensityPerColumn(px: Uint8ClampedArray, w: number, h: number): Float32Array {
  // Convert to grayscale on the fly while running Sobel-Y.
  // Sobel-Y kernel: [[-1,-2,-1], [0,0,0], [1,2,1]] — picks up horizontal
  // edges (the chip-to-chip boundaries we care about).
  const out = new Float32Array(w);
  const gray = (i: number) => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 0; x < w; x++) {
      // Use only the center column for the per-column histogram (the
      // standard Sobel uses neighboring columns too but we want an x-
      // resolved signal, not a 2D map).
      const top = (y - 1) * w + x;
      const bot = (y + 1) * w + x;
      const dy = gray(bot * 4) - gray(top * 4);
      out[x] += Math.abs(dy);
    }
  }
  return smoothColumnSignal(out);
}

/** Final-fallback even partition into N regions. */
function evenPartition(w: number, h: number, n: number): Region[] {
  const regions: Region[] = [];
  const stride = Math.floor(w / Math.max(1, n));
  for (let i = 0; i < n; i++) {
    regions.push({
      x: i * stride,
      y: Math.floor(h * 0.05),  // skip a thin top strip (often EXIF/UI)
      width: stride,
      height: Math.floor(h * 0.90),
    });
  }
  return regions;
}

/** Average RGB of chip-body pixels in a region's center 60% vertical band. */
function sampleStackBodyColor(
  px: Uint8ClampedArray,
  klass: Uint8Array,
  w: number,
  region: Region,
): RGB | null {
  const yTop = region.y + Math.floor(region.height * 0.20);
  const yBot = region.y + Math.floor(region.height * 0.80);
  let rSum = 0, gSum = 0, bSum = 0, n = 0;
  for (let y = yTop; y < yBot; y++) {
    for (let x = region.x; x < region.x + region.width; x++) {
      const k = klass[y * w + x];
      if (k !== 0) continue; // skip stripe + background
      const i = (y * w + x) * 4;
      rSum += px[i];
      gSum += px[i + 1];
      bSum += px[i + 2];
      n++;
    }
  }
  if (n < 20) return null;
  return { r: rSum / n, g: gSum / n, b: bSum / n };
}

/** Local hex helper to avoid a circular import on `imageUtils.rgbToHex`. */
function rgbToHexLocal(rgb: RGB): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(rgb.r)}${c(rgb.g)}${c(rgb.b)}`;
}

function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image failed to load'));
    img.src = src;
  });
}
