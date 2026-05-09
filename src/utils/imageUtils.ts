/**
 * Browser-side image helpers for the photo chip-counting feature.
 *
 * Two pure async functions, no React, no DOM globals leaking out:
 *
 * 1. `downscaleImage(file, maxDim)` — reads a File (typically from a
 *    `<input type="file" capture="environment">`), downscales it so the
 *    longer edge is `maxDim` px, and returns base64 JPEG. Two reasons
 *    we always do this client-side:
 *      a. Vercel Edge Functions cap request bodies at ~4.5 MB; raw
 *         phone photos are 4-12 MB. Downscale + JPEG@0.85 lands ~150-
 *         300 KB.
 *      b. Gemini Vision counts edge rings just as well at 1024 px as
 *         at 4032 px — the resolution above ~600 px on the long edge
 *         doesn't help; it just costs latency and tokens.
 *
 * 2. `varianceOfLaplacian(base64)` — tiny blur metric. Computes the
 *    variance of the Laplacian (3x3 kernel: 0 1 0 / 1 -4 1 / 0 1 0) on
 *    the grayscale-converted pixels. Higher = sharper. Below ~50 the
 *    photo is too blurry for reliable ring-counting and we should
 *    prompt for a retake before burning a Gemini call.
 *
 * Both functions are written to fail soft: any exception bubbles up as
 * an Error so the caller can decide whether to surface it as a toast
 * or silently skip the check (we never block the manual flow on these).
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
  maxDim = 1024,
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

  ctx.drawImage(img, 0, 0, targetW, targetH);

  const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.85);
  const base64 = jpegDataUrl.split(',')[1] || '';
  // Approximate byte size: base64 is ~4/3 of binary.
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
