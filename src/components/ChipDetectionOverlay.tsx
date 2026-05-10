import { useEffect, useMemo, useRef, useState } from 'react';
import { ChipValue, PhotoChipCountStack } from '../types';

/**
 * Renders a captured chip photo with the detection overlay on top —
 * one colored bounding box per detected stack, labelled with the
 * AI's count and a small confidence chip. Used by:
 *
 *  1. ChipEntryScreen — collapsible "show detection" toggle inside
 *     the live-game flow's photo banner. Lets the user see exactly
 *     what the model thought it was looking at when it made the
 *     proposal, which is the fastest way to spot "the AI cropped
 *     the wrong region" failures.
 *
 *  2. SettingsScreen test card — same overlay, but always-on, paired
 *     with the per-stack ground-truth input so the validation flow
 *     is one focused surface instead of three disconnected widgets.
 *
 * Props:
 *  - `photoBase64`/`photoMimeType`: the EXACT image the AI saw
 *    (post-enhancement). Region coordinates are in this image's
 *    pixel space.
 *  - `stacks`: full PhotoChipCountStack[] from the result. We only
 *    render boxes for stacks that have a `region`.
 *  - `chipById`: optional. When provided, lets us color each box by
 *    `chip.displayColor` instead of a generic accent. Falls back to
 *    indigo if missing.
 *  - `adjustedStackId`: optional. When the total-value sanity check
 *    adjusted a stack, we draw a thin purple ring + a 🛟 marker on
 *    that box so the user sees exactly which one was reconciled.
 *  - `maxHeight`: cap the visual height (default 220px). Image is
 *    contain-fitted inside this height; bounding boxes scale with it.
 *
 * Renders nothing when there are no regions to draw — caller can
 * just always mount it and trust the empty-state.
 */
export interface ChipDetectionOverlayProps {
  photoBase64: string;
  photoMimeType?: string;
  stacks: PhotoChipCountStack[];
  chipById?: Map<string, ChipValue>;
  adjustedStackId?: string | null;
  maxHeight?: number;
  showLabels?: boolean;
}

const ChipDetectionOverlay = ({
  photoBase64,
  photoMimeType = 'image/jpeg',
  stacks,
  chipById,
  adjustedStackId,
  maxHeight = 220,
  showLabels = true,
}: ChipDetectionOverlayProps) => {
  // We need the natural dimensions of the source image to translate
  // pixel-space regions into percentage-positioned overlays. Resolved
  // once on mount via an offscreen Image.
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  // Track the rendered (CSS) size of the wrapper so we can compute
  // whether to render labels in or above each box (avoids clipping
  // when a box is tiny). Recomputed via ResizeObserver.
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [renderedHeight, setRenderedHeight] = useState(0);

  const dataUrl = useMemo(
    () => `data:${photoMimeType};base64,${photoBase64}`,
    [photoBase64, photoMimeType],
  );

  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      setNatural({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.src = dataUrl;
    return () => { cancelled = true; };
  }, [dataUrl]);

  useEffect(() => {
    if (!wrapperRef.current) return;
    const el = wrapperRef.current;
    const update = () => setRenderedHeight(el.getBoundingClientRect().height);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const regionStacks = stacks.filter(s => s.region && s.region.width > 1 && s.region.height > 1);
  if (regionStacks.length === 0 && !natural) {
    return null;
  }

  return (
    <div
      ref={wrapperRef}
      style={{
        position: 'relative',
        width: '100%',
        maxHeight,
        background: '#000',
        borderRadius: '10px',
        overflow: 'hidden',
        display: 'flex',
        justifyContent: 'center',
        direction: 'ltr',
      }}
    >
      <img
        src={dataUrl}
        alt="chip detection"
        style={{
          maxHeight,
          width: 'auto',
          height: 'auto',
          maxWidth: '100%',
          display: 'block',
        }}
      />
      {natural && (
        <div style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
        }}>
          {regionStacks.map(stack => {
            const r = stack.region!;
            // Translate pixel-space region into percentage of the
            // natural image dimensions. The <img> uses object-fit
            // implicitly via auto sizing inside the flex container,
            // so the overlay element (also positioned by percent
            // inside the wrapper that contains the image) lines up
            // exactly when the image is rendered at its aspect ratio.
            const leftPct = (r.x / natural.w) * 100;
            const topPct = (r.y / natural.h) * 100;
            const wPct = (r.width / natural.w) * 100;
            const hPct = (r.height / natural.h) * 100;

            const chip = chipById?.get(stack.chipId);
            const accent = chip?.displayColor || '#6366f1';
            const isAdjusted = adjustedStackId === stack.chipId;
            const needsVerify = stack.needsVerify === true || (typeof stack.confidence === 'number' && stack.confidence < 60);

            // Label placement: below the box if the rendered box is
            // shorter than ~40px (label would overlap the chip);
            // otherwise inside the bottom of the box.
            const renderedBoxH = (hPct / 100) * renderedHeight;
            const labelOutside = renderedBoxH < 40;

            return (
              <div
                key={stack.chipId}
                style={{
                  position: 'absolute',
                  left: `${leftPct}%`,
                  top: `${topPct}%`,
                  width: `${wPct}%`,
                  height: `${hPct}%`,
                  border: `2px solid ${accent}`,
                  borderRadius: '4px',
                  boxShadow: isAdjusted
                    ? `0 0 0 2px rgba(168,85,247,0.85) inset, 0 0 0 4px rgba(168,85,247,0.25)`
                    : needsVerify
                      ? '0 0 0 2px rgba(245,158,11,0.5) inset'
                      : 'none',
                  background: needsVerify
                    ? 'rgba(245,158,11,0.08)'
                    : 'transparent',
                  transition: 'box-shadow 0.2s ease',
                }}
              >
                {showLabels && (
                  <div style={{
                    position: 'absolute',
                    [labelOutside ? 'top' : 'bottom']: labelOutside ? '100%' : '2px',
                    left: '2px',
                    background: 'rgba(0,0,0,0.78)',
                    color: '#fff',
                    fontSize: '0.65rem',
                    fontWeight: 700,
                    padding: '1px 5px',
                    borderRadius: '3px',
                    lineHeight: 1.2,
                    whiteSpace: 'nowrap',
                    border: `1px solid ${accent}`,
                    marginTop: labelOutside ? '2px' : 0,
                  }}>
                    #{stack.position} · {stack.count}
                    {isAdjusted && ' 🛟'}
                    {needsVerify && !isAdjusted && ' ⚠'}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ChipDetectionOverlay;
