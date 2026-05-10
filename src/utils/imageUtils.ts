/**
 * Browser-side image helpers for the photo chip-counting feature.
 *
 * Three pure async functions, no React, no DOM globals leaking out:
 *
 * 1. `downscaleImage(file, maxDim)` — reads a File (typically from a
 *    `<input type="file" capture="environment">`), downscales it so the
 *    longer edge is `maxDim` px, and returns base64 JPEG. Two reasons
 *    we always do this client-side:
 *      a. Vercel Edge Functions cap request bodies at ~4.5 MB; raw
 *         phone photos are 4-12 MB. Downscale + JPEG@0.92 lands ~250-
 *         500 KB at maxDim=1280.
 *      b. Gemini Vision counts edge rings well at ~1280 px on the long
 *         edge — beyond that the per-ring pixel budget tops out and
 *         the extra resolution just costs latency + tokens.
 *
 * 2. `enhanceForChipCounting(base64)` — vision-targeted preprocessing
 *    pass that runs AFTER downscale and BEFORE the Gemini call.
 *
 *    Per-channel histogram stretch (auto-levels). Phone cameras under
 *    indoor light often produce muddy mid-grey backgrounds and washed-
 *    out chip stripes. Stretching the 1st-99th percentile to 0-255
 *    pulls the white stripes back to white and the colored body back
 *    to saturated, which makes the ring-count edges crisp for the
 *    model.
 *
 *    NOTE: an earlier version also did Sobel-based auto-crop to the
 *    chip region. We dropped it after measuring on real photos: the
 *    bounding box covered 100% of every test image because cluttered
 *    indoor backgrounds (carpets, household items, wood grain) all
 *    provide enough scattered edges to drown out the chip stripes at
 *    a 75th-percentile threshold. A more aggressive threshold risked
 *    false-cropping out actual chip stacks, which would silently lose
 *    counts. The right v2 of this is saturation + connected-component
 *    labelling (chip colors are highly saturated; backgrounds usually
 *    aren't), but we'll wait for real user data before adding that.
 *    For now, histogram stretch alone delivers measurable contrast
 *    improvement with zero risk.
 *
 * 3. `varianceOfLaplacian(base64)` — tiny blur metric. Computes the
 *    variance of the Laplacian (3x3 kernel: 0 1 0 / 1 -4 1 / 0 1 0) on
 *    the grayscale-converted pixels. Higher = sharper. Below ~50 the
 *    photo is too blurry for reliable ring-counting and we should
 *    prompt for a retake before burning a Gemini call.
 *
 * All three functions are written to fail soft: any exception bubbles
 * up as an Error so the caller can decide whether to surface it as a
 * toast or silently skip the check (we never block the manual flow on
 * these).
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
 * `downscaleImage` and BEFORE the Gemini call. Auto-crops to the
 * region with the most edge density (the chip stacks) and applies
 * a per-channel histogram stretch to restore contrast.
 *
 * Returns a NEW `DownscaledImage` (always JPEG 0.92). On any failure
 * (canvas unavailable, image won't load, edge map empty) returns the
 * input unchanged so the caller never has to special-case errors.
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
