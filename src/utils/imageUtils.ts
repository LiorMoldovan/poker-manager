/**
 * Browser-side image helpers for the photo chip-counting feature.
 *
 * The functions below split into two groups:
 *
 * ── Group 1: legacy single-photo pipeline (downscale + enhance + blur) ──
 *
 * 1. `downscaleImage(file, maxDim)` — reads a File (typically from a
 *    `<input type="file" capture="environment">`), downscales it so the
 *    longer edge is `maxDim` px, and returns base64 JPEG. Reasons we
 *    always do this client-side:
 *      a. Vercel Edge Functions cap request bodies at ~4.5 MB; raw
 *         phone photos are 4-12 MB. Downscale + JPEG@0.92 lands ~250-
 *         500 KB at maxDim=1280.
 *      b. Gemini Vision counts edge rings well at ~1280 px on the long
 *         edge — beyond that the per-ring pixel budget tops out and
 *         the extra resolution just costs latency + tokens.
 *
 * 2. `enhanceForChipCounting(base64)` — vision-targeted preprocessing
 *    pass that runs AFTER downscale and BEFORE any analysis.
 *
 *    Per-channel histogram stretch (auto-levels) only. Phone cameras
 *    under indoor light often produce muddy mid-grey backgrounds and
 *    washed-out chip stripes. Stretching the 1st-99th percentile to
 *    0-255 pulls the white stripes back to white and the colored body
 *    back to saturated, which makes the ring-count edges crisp for
 *    the model. There is NO auto-crop step here (an earlier version
 *    had a Sobel-based bounding-box crop; it was dropped because real
 *    photos with cluttered backgrounds — carpets, wood grain — all
 *    crossed the threshold and the box covered the whole image).
 *
 * 3. `varianceOfLaplacian(base64)` — tiny blur metric. Computes the
 *    variance of the Laplacian (3x3 kernel: 0 1 0 / 1 -4 1 / 0 1 0) on
 *    the grayscale-converted pixels. Higher = sharper. Below ~50 the
 *    photo is too blurry for reliable ring-counting.
 *
 * ── Group 2: rebuild helpers (per-stack pipeline, v5.59+) ──
 *
 * 4. `decodeImageStreaming(file)` — uses `createImageBitmap` directly
 *    on the File when available (Chrome, Safari 15+, Firefox 99+),
 *    skipping the FileReader→DataURL→HTMLImageElement chain that loads
 *    the whole encoded JPEG as a JS string before decoding. On a 48MP
 *    phone photo this drops peak memory from ~40MB to ~30MB and
 *    eliminates an OOM crash mode on older Android devices. Falls back
 *    to the legacy path when the API is missing.
 *
 * 5. `sampleMatColor(input)` — samples 8 small patches from corners +
 *    edge midpoints, computes median HSL with outlier rejection. Used
 *    by the rebuilt stack detector as the "background" reference for
 *    HSV masking. Outlier rejection drops patches that look saturated
 *    (likely a chip placed near the edge of the frame).
 *
 * 6. `cropToRegion(input, region)` — extracts a rectangular sub-image
 *    as a fresh `DownscaledImage`. Used by the per-stack pipeline to
 *    feed each stack's tight crop to its own LLM call.
 *
 * 7. `sampleDominantColor(input, region?)` — returns the dominant RGB
 *    + HSL of an image (or a sub-rectangle). Currently unused in the
 *    active pipeline (v5.60.14 retired the chip-selfie dominant-hex
 *    extraction it once fed — see `captureChipSelfie` JSDoc); kept
 *    for future debugging / one-off exploration.
 *
 * 8. `whiteBalanceFromStripes(stripePixelsRgb)` — computes a per-
 *    channel correction so that the average of supplied "known white"
 *    pixels (the chips' own white side stripes) maps back to neutral
 *    white. Eliminates the camera color cast (warm tungsten, cool
 *    shade, fluorescent green-tint) before downstream color matching.
 *    Returns a tiny `{ rScale, gScale, bScale }` object that
 *    `applyWhiteBalance(rgb, wb)` then applies to any RGB sample.
 *
 * 9. RGB/HSL/Hex utilities (`rgbToHsl`, `hslToRgb`, `hslDistance`,
 *    `hexToRgb`, `rgbToHex`) — deterministic color math shared across
 *    stack detection, color-mapping, and selfie capture so every
 *    module agrees on what "the same color" means.
 *
 * All async functions fail soft: any exception bubbles up as an Error
 * so the caller can decide whether to surface it as a toast or
 * silently skip (we never block the manual chip-entry flow on these).
 */

export interface DownscaledImage {
  base64: string;     // raw base64, no `data:image/...;base64,` prefix
  mimeType: string;   // always 'image/jpeg' for now
  width: number;
  height: number;
  byteSize: number;   // approximate, for size-budget logging
}

/**
 * Read a File, draw it to an off-screen canvas at most `maxDim` px on
 * the longer edge, return base64 JPEG.
 *
 * Quality 0.85 was chosen by the v5.X.0 photo-chip-counting work —
 * empirically Gemini's ring-counting accuracy is indistinguishable
 * between 0.85 and 0.95, but 0.85 is ~30 % smaller. If a future
 * regression points at JPEG artifacts (banding on the white stripes,
 * for instance) bump back to 0.92.
 */
export async function downscaleImage(
  file: File,
  maxDim = 1280,
): Promise<DownscaledImage> {
  if (!file || !file.type.startsWith('image/')) {
    throw new Error('Not an image file');
  }

  const dataUrl = await readFileAsDataUrl(file);
  const img = await loadImage(dataUrl);

  const longEdge = Math.max(img.width, img.height);
  const scale = longEdge > maxDim ? maxDim / longEdge : 1;
  const targetW = Math.round(img.width * scale);
  const targetH = Math.round(img.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');

  // imageSmoothingQuality='high' uses Lanczos-like resampling instead
  // of bilinear default — visibly sharper on edge rings, no extra cost.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, targetW, targetH);

  // Quality 0.92 (was 0.85): ring-counting is sensitive to JPEG
  // artifacts on the white stripe boundaries; the ~25% size bump is
  // worth it for the accuracy gain. 0.92 still puts a 1280px image
  // safely under 500 KB — well below the Vercel 4.5 MB cap.
  const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.92);
  const base64 = jpegDataUrl.split(',')[1] || '';
  const byteSize = Math.floor((base64.length * 3) / 4);

  return {
    base64,
    mimeType: 'image/jpeg',
    width: targetW,
    height: targetH,
    byteSize,
  };
}

/**
 * Vision-targeted preprocessing for chip-stack photos. Runs AFTER
 * `downscaleImage` and BEFORE any analysis. Applies a per-channel
 * histogram stretch (auto-levels) to restore contrast on the white
 * stripe boundaries.
 *
 * NOTE: there is NO auto-crop step. An earlier version had a Sobel-
 * based bounding-box crop; it was dropped because real photos with
 * cluttered indoor backgrounds (carpets, wood grain, household items)
 * all crossed the edge-density threshold and the bounding box ended
 * up covering the whole image. The crop was useless in practice and
 * made later debugging confusing. Only histogram stretch survives.
 *
 * Returns a NEW `DownscaledImage` (always JPEG 0.92). On any failure
 * (canvas unavailable, image won't load) returns the input unchanged
 * so the caller never has to special-case errors.
 */
export async function enhanceForChipCounting(
  input: DownscaledImage,
): Promise<DownscaledImage> {
  try {
    const dataUrl = `data:${input.mimeType};base64,${input.base64}`;
    const img = await loadImage(dataUrl);
    const w = img.width;
    const h = img.height;

    // Render the source image to a working canvas. Per-channel
    // histogram stretch happens in place on this buffer.
    const dstCanvas = document.createElement('canvas');
    dstCanvas.width = w;
    dstCanvas.height = h;
    const dstCtx = dstCanvas.getContext('2d');
    if (!dstCtx) return input;
    dstCtx.drawImage(img, 0, 0);
    const dst = dstCtx.getImageData(0, 0, w, h);
    const px = dst.data;

    // Build per-channel histograms of the cropped pixels.
    const histR = new Uint32Array(256);
    const histG = new Uint32Array(256);
    const histB = new Uint32Array(256);
    for (let i = 0; i < px.length; i += 4) {
      histR[px[i]]++;
      histG[px[i + 1]]++;
      histB[px[i + 2]]++;
    }
    const totalPx = (px.length / 4);
    // 1st and 99th percentile per channel — robust auto-levels.
    const findPercentile = (hist: Uint32Array, frac: number): number => {
      const target = Math.floor(totalPx * frac);
      let acc = 0;
      for (let v = 0; v < 256; v++) {
        acc += hist[v];
        if (acc >= target) return v;
      }
      return 255;
    };
    const lo = [findPercentile(histR, 0.01), findPercentile(histG, 0.01), findPercentile(histB, 0.01)];
    const hi = [findPercentile(histR, 0.99), findPercentile(histG, 0.99), findPercentile(histB, 0.99)];

    for (let c = 0; c < 3; c++) {
      const span = hi[c] - lo[c];
      if (span < 16) {
        // Channel is already too flat to stretch usefully. Skip — touching
        // it would just amplify JPEG noise.
        continue;
      }
      for (let i = c; i < px.length; i += 4) {
        const v = px[i];
        const stretched = ((v - lo[c]) * 255) / span;
        px[i] = stretched < 0 ? 0 : stretched > 255 ? 255 : stretched | 0;
      }
    }
    dstCtx.putImageData(dst, 0, 0);

    const jpegDataUrl = dstCanvas.toDataURL('image/jpeg', 0.92);
    const base64 = jpegDataUrl.split(',')[1] || '';
    const byteSize = Math.floor((base64.length * 3) / 4);
    return {
      base64,
      mimeType: 'image/jpeg',
      width: w,
      height: h,
      byteSize,
    };
  } catch (err) {
    // No-op on any failure — the caller continues with the unenhanced
    // image, which is still good enough for the model 95% of the time.
    console.warn('[enhanceForChipCounting] skipped:', err);
    return input;
  }
}

/**
 * Variance-of-Laplacian blur metric.
 *
 * Lower = blurrier. The threshold at which a chip-stack photo becomes
 * unusable for ring-counting is empirical — call site should pass its
 * own threshold (recommended: 50). Returns 0 on any failure so the
 * caller can decide to skip the check rather than block the user.
 */
export async function varianceOfLaplacian(
  base64: string,
  mimeType = 'image/jpeg',
): Promise<number> {
  try {
    const dataUrl = `data:${mimeType};base64,${base64}`;
    const img = await loadImage(dataUrl);

    // Downsample further for a quick blur metric — full-res analysis
    // is wasteful here. 256px on the long edge is plenty for variance.
    const longEdge = Math.max(img.width, img.height);
    const scale = longEdge > 256 ? 256 / longEdge : 1;
    const w = Math.max(8, Math.round(img.width * scale));
    const h = Math.max(8, Math.round(img.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return 0;
    ctx.drawImage(img, 0, 0, w, h);

    const { data } = ctx.getImageData(0, 0, w, h);

    // Convert to grayscale (Y'601: 0.299R + 0.587G + 0.114B).
    const gray = new Float32Array(w * h);
    for (let i = 0; i < gray.length; i++) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    }

    // Apply 3x3 Laplacian: 0 1 0 / 1 -4 1 / 0 1 0
    // Skip border pixels — they don't change the variance meaningfully.
    const lap: number[] = [];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const v =
          gray[i - w] +     // top
          gray[i - 1] +     // left
          gray[i + 1] +     // right
          gray[i + w] -     // bottom
          4 * gray[i];
        lap.push(v);
      }
    }

    if (lap.length === 0) return 0;
    let sum = 0;
    for (const v of lap) sum += v;
    const mean = sum / lap.length;
    let varSum = 0;
    for (const v of lap) {
      const d = v - mean;
      varSum += d * d;
    }
    return varSum / lap.length;
  } catch {
    return 0;
  }
}

// ── Internal helpers ─────────────────────────────────────────────────

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') resolve(result);
      else reject(new Error('FileReader returned non-string'));
    };
    reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image failed to load'));
    img.src = src;
  });
}

// ── Group 2: rebuild helpers ──────────────────────────────────────────

export interface RGB { r: number; g: number; b: number; }
export interface HSL { h: number; s: number; l: number; } // h: 0-360, s/l: 0-1
export interface Region { x: number; y: number; width: number; height: number; }
export interface WhiteBalance { rScale: number; gScale: number; bScale: number; }

// Anything we can pass to ctx.drawImage(...). Both HTMLImageElement and
// ImageBitmap satisfy CanvasImageSource.
export type DrawableImage = HTMLImageElement | ImageBitmap;

/**
 * Read a File using `createImageBitmap` when available so the encoded
 * JPEG is decoded directly from the blob (no DataURL string in JS heap).
 * Falls back to FileReader → DataURL → HTMLImageElement on browsers
 * without the API.
 */
export async function decodeImageStreaming(file: File): Promise<DrawableImage> {
  if (!file || !file.type.startsWith('image/')) {
    throw new Error('Not an image file');
  }
  // createImageBitmap with a Blob argument is widely supported — Chrome 50+,
  // Safari 15+, Firefox 99+ — and skips the DataURL detour entirely.
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      // Fall through to legacy path on bitmap-decode failures (rare; usually
      // means CMYK JPEG or similar exotic format).
    }
  }
  const dataUrl = await readFileAsDataUrl(file);
  return await loadImage(dataUrl);
}

/**
 * Sample 8 small patches from corners + edge midpoints of an image and
 * return the median RGB/HSL with simple outlier rejection.
 *
 * "Outlier" here = a patch whose saturation is unusually high relative
 * to the others; that indicates a chip placed near the edge of the
 * frame rather than the actual mat. Drop the top quartile by saturation
 * before taking the median.
 *
 * Each patch is 24×24 px, sampled at the listed positions:
 *   ┌───────────────┐
 *   │ A    E    B   │
 *   │ G         H   │
 *   │ C    F    D   │
 *   └───────────────┘
 *
 * Used by `detectStackRegions` as the "this is what the background
 * looks like" reference for HSV masking.
 */
export async function sampleMatColor(input: DownscaledImage): Promise<{ rgb: RGB; hsl: HSL }> {
  const dataUrl = `data:${input.mimeType};base64,${input.base64}`;
  const img = await loadImage(dataUrl);
  const w = img.width;
  const h = img.height;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(img, 0, 0);

  const patchSize = 24;
  const half = patchSize / 2;
  // 8 sample centers — 4 corners (offset by patchSize so the patch is
  // entirely inside the image) + 4 edge midpoints.
  const centers: Array<{ x: number; y: number }> = [
    { x: patchSize, y: patchSize },                 // A
    { x: w - patchSize, y: patchSize },              // B
    { x: patchSize, y: h - patchSize },              // C
    { x: w - patchSize, y: h - patchSize },          // D
    { x: w / 2, y: patchSize },                      // E
    { x: w / 2, y: h - patchSize },                  // F
    { x: patchSize, y: h / 2 },                      // G
    { x: w - patchSize, y: h / 2 },                  // H
  ];

  const samples: Array<{ rgb: RGB; hsl: HSL }> = [];
  for (const c of centers) {
    const x = Math.max(0, Math.min(w - patchSize, Math.round(c.x - half)));
    const y = Math.max(0, Math.min(h - patchSize, Math.round(c.y - half)));
    const { data } = ctx.getImageData(x, y, patchSize, patchSize);
    let rSum = 0, gSum = 0, bSum = 0;
    const n = patchSize * patchSize;
    for (let i = 0; i < data.length; i += 4) {
      rSum += data[i];
      gSum += data[i + 1];
      bSum += data[i + 2];
    }
    const rgb: RGB = { r: rSum / n, g: gSum / n, b: bSum / n };
    samples.push({ rgb, hsl: rgbToHsl(rgb) });
  }

  // Sort by saturation ascending and drop the top quartile (likely chips).
  const sorted = [...samples].sort((a, b) => a.hsl.s - b.hsl.s);
  const keep = sorted.slice(0, Math.max(4, Math.floor(sorted.length * 0.75)));

  // Median per channel of the kept samples.
  const median = (vals: number[]) => {
    const s = [...vals].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const rgb: RGB = {
    r: median(keep.map(k => k.rgb.r)),
    g: median(keep.map(k => k.rgb.g)),
    b: median(keep.map(k => k.rgb.b)),
  };
  return { rgb, hsl: rgbToHsl(rgb) };
}

/**
 * Extract a rectangular sub-image as a fresh `DownscaledImage`.
 *
 * Region coordinates are in source-image pixel space. Out-of-bounds
 * coordinates are clamped to the image. JPEG quality 0.92 (matching
 * `enhanceForChipCounting`) so the per-stack crop survives the round-
 * trip without visible artefacts on the white stripe boundaries.
 */
export async function cropToRegion(
  input: DownscaledImage,
  region: Region,
): Promise<DownscaledImage> {
  const dataUrl = `data:${input.mimeType};base64,${input.base64}`;
  const img = await loadImage(dataUrl);

  const sx = Math.max(0, Math.floor(region.x));
  const sy = Math.max(0, Math.floor(region.y));
  const sw = Math.max(1, Math.min(Math.floor(region.width), img.width - sx));
  const sh = Math.max(1, Math.min(Math.floor(region.height), img.height - sy));

  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

  const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.92);
  const base64 = jpegDataUrl.split(',')[1] || '';
  const byteSize = Math.floor((base64.length * 3) / 4);
  return {
    base64,
    mimeType: 'image/jpeg',
    width: sw,
    height: sh,
    byteSize,
  };
}

/**
 * Average RGB / HSL of an image (or a sub-region of an image).
 *
 * For chip-selfie capture: pass no region, get the dominant color of a
 * 24×24 center patch (the chip face is centered in selfie photos).
 *
 * For general use: pass an explicit region.
 *
 * "Dominant" here is the simple arithmetic mean of pixel RGB values.
 * Mode-based / k-means quantization would be more accurate for multi-
 * color images, but for chip selfies (single object on a plain
 * background, centered) the mean of the center patch is empirically
 * within ~5 HSL units of mode-based and runs in 1ms instead of 20ms.
 */
export async function sampleDominantColor(
  input: DownscaledImage,
  region?: Region,
): Promise<{ rgb: RGB; hsl: HSL }> {
  const dataUrl = `data:${input.mimeType};base64,${input.base64}`;
  const img = await loadImage(dataUrl);

  // Default region: 24×24 center patch (good for selfie capture).
  const r: Region = region || {
    x: img.width / 2 - 12,
    y: img.height / 2 - 12,
    width: 24,
    height: 24,
  };
  const sx = Math.max(0, Math.floor(r.x));
  const sy = Math.max(0, Math.floor(r.y));
  const sw = Math.max(1, Math.min(Math.floor(r.width), img.width - sx));
  const sh = Math.max(1, Math.min(Math.floor(r.height), img.height - sy));

  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  const { data } = ctx.getImageData(0, 0, sw, sh);

  let rSum = 0, gSum = 0, bSum = 0;
  const n = sw * sh;
  for (let i = 0; i < data.length; i += 4) {
    rSum += data[i];
    gSum += data[i + 1];
    bSum += data[i + 2];
  }
  const rgb: RGB = { r: rSum / n, g: gSum / n, b: bSum / n };
  return { rgb, hsl: rgbToHsl(rgb) };
}

/**
 * Compute a per-channel white-balance correction from "known white"
 * pixels (the chips' own white side stripes).
 *
 * The chips' white stripes SHOULD render as pure white (255,255,255).
 * Any deviation in the average is the camera's color cast — warm
 * tungsten light skews everything toward red, cool shade toward blue,
 * fluorescent toward green. Correcting the cast here makes downstream
 * color matching reliable in any lighting.
 *
 * Returns scale factors per channel. Each `*Scale` is clamped to
 * [0.5, 2.0] so a few mis-classified non-white pixels can't blow up
 * the correction.
 *
 * Apply the correction with `applyWhiteBalance(rgb, wb)`.
 *
 * Falls back to identity (1,1,1) when no usable samples are supplied.
 */
export function whiteBalanceFromStripes(stripeRgbSamples: RGB[]): WhiteBalance {
  const identity: WhiteBalance = { rScale: 1, gScale: 1, bScale: 1 };
  if (!stripeRgbSamples.length) return identity;

  let rSum = 0, gSum = 0, bSum = 0;
  let n = 0;
  for (const rgb of stripeRgbSamples) {
    // Defensive filter: only use samples that are ACTUALLY bright. A
    // pixel that's ~50% lightness can't be a meaningful "white reference"
    // — it was likely mis-classified as a stripe. Threshold 140 = comfortably
    // above mid-grey but below true white so we still capture warm-cast
    // stripes that come in at e.g. (220, 200, 170).
    const luma = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
    if (luma < 140) continue;
    rSum += rgb.r;
    gSum += rgb.g;
    bSum += rgb.b;
    n++;
  }
  if (n === 0) return identity;

  const rAvg = rSum / n;
  const gAvg = gSum / n;
  const bAvg = bSum / n;

  // Target: brightest channel becomes 255 after scaling. Using max instead
  // of a fixed 255 prevents over-saturation (lift instead of clip).
  const target = Math.max(rAvg, gAvg, bAvg, 1);
  const clamp = (v: number) => Math.max(0.5, Math.min(2.0, v));
  return {
    rScale: clamp(target / rAvg),
    gScale: clamp(target / gAvg),
    bScale: clamp(target / bAvg),
  };
}

/**
 * Apply a `WhiteBalance` correction to a single RGB sample.
 * Result is clamped to the valid 0-255 range per channel.
 */
export function applyWhiteBalance(rgb: RGB, wb: WhiteBalance): RGB {
  const clamp = (v: number) => Math.max(0, Math.min(255, v));
  return {
    r: clamp(rgb.r * wb.rScale),
    g: clamp(rgb.g * wb.gScale),
    b: clamp(rgb.b * wb.bScale),
  };
}

// ── Color math (RGB ↔ HSL ↔ Hex) ─────────────────────────────────────

export function rgbToHsl({ r, g, b }: RGB): HSL {
  const rN = r / 255, gN = g / 255, bN = b / 255;
  const max = Math.max(rN, gN, bN);
  const min = Math.min(rN, gN, bN);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rN: h = (gN - bN) / d + (gN < bN ? 6 : 0); break;
      case gN: h = (bN - rN) / d + 2; break;
      case bN: h = (rN - gN) / d + 4; break;
    }
    h *= 60;
  }
  return { h, s, l };
}

export function hslToRgb({ h, s, l }: HSL): RGB {
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const hueToRgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hN = h / 360;
  return {
    r: Math.round(hueToRgb(p, q, hN + 1 / 3) * 255),
    g: Math.round(hueToRgb(p, q, hN) * 255),
    b: Math.round(hueToRgb(p, q, hN - 1 / 3) * 255),
  };
}

/**
 * Perceptual-ish HSL distance, scaled 0-100. Hue distance is circular
 * (0° and 360° are the same color) and weighted lower when saturation
 * is low (greys can have any hue without looking "different").
 */
export function hslDistance(a: HSL, b: HSL): number {
  // Circular hue distance in degrees, 0-180.
  const dH = Math.min(Math.abs(a.h - b.h), 360 - Math.abs(a.h - b.h));
  // Down-weight hue when either color is unsaturated — a near-grey
  // pixel can have wildly different hue values that don't matter.
  const hueWeight = Math.min(a.s, b.s);
  // Map hue 0-180° → 0-100, then weight; map S, L 0-1 → 0-100.
  const hueComponent = (dH / 180) * 100 * hueWeight;
  const satComponent = Math.abs(a.s - b.s) * 100;
  const lightComponent = Math.abs(a.l - b.l) * 100;
  // Weighted Euclidean — hue dominates when both colors are saturated;
  // saturation/lightness pick up the slack for greys/whites.
  return Math.sqrt(
    hueComponent * hueComponent * 0.6 +
    satComponent * satComponent * 0.2 +
    lightComponent * lightComponent * 0.2,
  );
}

export function hexToRgb(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return {
    r: (v >> 16) & 0xff,
    g: (v >> 8) & 0xff,
    b: v & 0xff,
  };
}

export function rgbToHex({ r, g, b }: RGB): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/**
 * Capture a normalized 256×256 JPEG of one chip from a user-supplied
 * camera image. Used as a few-shot reference image for the LLM call in
 * `runSingleStackShot` (geminiAI.ts) — when present, Gemini sees an
 * example "this is what the user calls a 'red' chip" alongside the
 * stack-to-count image, which empirically improves count consistency.
 *
 * v5.60.14 — STOPPED computing/returning a dominant body hex. History:
 *   * v5.59.0 sampled the dead-center 24×24 patch → landed on the
 *     printed value inlay → produced muddy grey hex for every chip
 *     color → broke the stack→chip color mapping (which was using the
 *     hex via HSL distance).
 *   * v5.60.13 tried ring sampling at 30/45/60/75% radius → outer
 *     rings hit the green-mat background for chips that didn't fill
 *     the frame → produced wrong-color hex (white→green, black→green).
 *   * Conclusion: extracting reliable chip body color from arbitrary
 *     phone selfies is fundamentally fragile — depends on chip size in
 *     frame, presence of inlay, background color. None of which we can
 *     reliably detect client-side without real CV.
 * Solution: stop pretending we can. The user-configured `displayColor`
 * is well-saturated, hue-correct, and 100% reliable; stackDetection.ts
 * uses that for HSL matching now. The selfie JPEG is still valuable
 * for the LLM call — that's its only role going forward.
 *
 * Throws on bad input (non-image file, decode failure) so the caller
 * can surface a toast.
 */
export async function captureChipSelfie(
  file: File,
): Promise<{ base64: string; mimeType: string }> {
  if (!file || !file.type.startsWith('image/')) {
    throw new Error('Not an image file');
  }

  const dataUrl = await readFileAsDataUrl(file);
  const img = await loadImage(dataUrl);

  // v5.62 capture pipeline:
  //
  // 1. Square center crop with a TIGHTER inset (70% of min edge instead
  //    of the full short side). This drops most of the background
  //    (kitchen counter / poker mat) and keeps the chip filling the
  //    frame, which is what the LLM needs as a reference. Previously
  //    we used 100% of the short side, so a selfie taken with the chip
  //    in the center of a larger frame would have ~30-50% green-felt
  //    background — confusing the LLM's "this is what a Red chip looks
  //    like" anchor.
  //
  // 2. Per-channel histogram stretch on the cropped result. Many user
  //    selfies are washed out (indoor lighting, white-balance issues —
  //    Lior's White chip read as grey-cream, Black chip read as grey).
  //    A mild stretch pulls the darkest pixel to ~0 and the brightest
  //    to ~255, restoring contrast without inventing detail. Skipped
  //    on photos already in good condition (span > 200) so we don't
  //    over-process well-lit captures.
  const SIZE = 256;
  const minEdge = Math.min(img.width, img.height);
  const cropEdge = Math.floor(minEdge * 0.70);
  const sx = Math.floor((img.width - cropEdge) / 2);
  const sy = Math.floor((img.height - cropEdge) / 2);

  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, sx, sy, cropEdge, cropEdge, 0, 0, SIZE, SIZE);

  // Histogram stretch — only if the image is meaningfully washed out.
  try {
    const imgData = ctx.getImageData(0, 0, SIZE, SIZE);
    const data = imgData.data;
    const minByCh = [255, 255, 255];
    const maxByCh = [0, 0, 0];
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const v = data[i + c];
        if (v < minByCh[c]) minByCh[c] = v;
        if (v > maxByCh[c]) maxByCh[c] = v;
      }
    }
    // Only stretch when every channel is meaningfully compressed.
    // span < 220 means there's room to gain contrast on this channel.
    const shouldStretch =
      maxByCh[0] - minByCh[0] < 220 ||
      maxByCh[1] - minByCh[1] < 220 ||
      maxByCh[2] - minByCh[2] < 220;
    if (shouldStretch) {
      const lutR = buildStretchLUT(minByCh[0], maxByCh[0]);
      const lutG = buildStretchLUT(minByCh[1], maxByCh[1]);
      const lutB = buildStretchLUT(minByCh[2], maxByCh[2]);
      for (let i = 0; i < data.length; i += 4) {
        data[i]     = lutR[data[i]];
        data[i + 1] = lutG[data[i + 1]];
        data[i + 2] = lutB[data[i + 2]];
      }
      ctx.putImageData(imgData, 0, 0);
    }
  } catch (err) {
    // getImageData can throw on tainted canvas — extremely unlikely
    // since we drew from a same-origin object URL, but if it does we
    // just keep the un-stretched crop. The selfie is still usable.
    console.warn('[captureChipSelfie] histogram stretch skipped:', err);
  }

  const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.85);
  const base64 = jpegDataUrl.split(',')[1] || '';

  return { base64, mimeType: 'image/jpeg' };
}

/** Build a 256-entry lookup table that maps the [lo..hi] range linearly
 *  to [0..255]. Used by `captureChipSelfie` for per-channel histogram
 *  stretch. We clamp `lo` away from `hi` by at least 1 to avoid a
 *  divide-by-zero on degenerate single-color crops. */
function buildStretchLUT(lo: number, hi: number): Uint8Array {
  const out = new Uint8Array(256);
  const safeHi = Math.max(hi, lo + 1);
  const range = safeHi - lo;
  for (let i = 0; i < 256; i++) {
    const v = Math.max(0, Math.min(255, Math.round(((i - lo) / range) * 255)));
    out[i] = v;
  }
  return out;
}
