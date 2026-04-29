/**
 * ComicRenderer — composites the AI-generated art with DOM speech bubbles.
 *
 * The image itself contains no text and no bubble shapes. We render it as
 * a square <img> and overlay one absolute-positioned bubble per dialogue
 * line, anchored to the speaker's face bounding box (when available) or
 * to the panel corner (when bbox detection failed for that speaker).
 *
 * Each bubble's typography matches the comic style's `BubbleTheme`, so a
 * manga panel gets jagged shouts and a Tintin panel gets clean ovals.
 *
 * The container exposes a forwardRef so the share flow can capture it
 * with html2canvas the same way it captures other share cards.
 */

import { forwardRef, CSSProperties, useMemo } from 'react';
import { ComicScript, ComicPanel, ComicBubble } from '../types';
import { getComicStyle, BubbleTheme } from '../utils/comicStyles';

interface Props {
  imageUrl: string;
  script: ComicScript;
  /** Footer date label (e.g. "ערב פוקר • שבת 28/4"). Optional. */
  footer?: string;
  /** When true, render in a fixed share-card width (square) for html2canvas. */
  forShare?: boolean;
}

const ComicRenderer = forwardRef<HTMLDivElement, Props>(({ imageUrl, script, footer, forShare }, ref) => {
  const style = getComicStyle(script.style);
  const theme = style.bubble;

  const containerStyle: CSSProperties = useMemo(() => ({
    position: 'relative',
    width: '100%',
    maxWidth: forShare ? '720px' : undefined,
    margin: '0 auto',
    aspectRatio: '1 / 1',
    borderRadius: '12px',
    overflow: 'hidden',
    background: '#0a0a0a',
    boxShadow: forShare ? 'none' : '0 4px 18px rgba(0,0,0,0.45)',
    direction: 'rtl',
  }), [forShare]);

  return (
    <div ref={ref} style={{
      background: forShare ? '#0a0a0a' : 'transparent',
      padding: forShare ? '1rem' : 0,
      borderRadius: forShare ? '14px' : 0,
    }}>
      {script.title && (
        <div style={{
          textAlign: 'center',
          fontSize: forShare ? '1.25rem' : '1rem',
          fontWeight: 800,
          color: '#f8fafc',
          marginBottom: '0.6rem',
          fontFamily: '"Heebo","Assistant","Outfit",sans-serif',
          letterSpacing: '0.01em',
          direction: 'rtl',
        }}>
          {script.title}
        </div>
      )}

      <div style={containerStyle}>
        <img
          src={imageUrl}
          alt=""
          crossOrigin="anonymous"
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
          }}
        />

        {script.panels.map(panel => (
          <PanelOverlay key={panel.id} panel={panel} theme={theme} />
        ))}
      </div>

      {footer && (
        <div style={{
          textAlign: 'center',
          fontSize: '0.7rem',
          color: '#94a3b8',
          marginTop: '0.5rem',
          fontFamily: '"Heebo","Assistant","Outfit",sans-serif',
          direction: 'rtl',
        }}>
          {footer}
        </div>
      )}
    </div>
  );
});

ComicRenderer.displayName = 'ComicRenderer';

export default ComicRenderer;

// ─── Panel overlay ────────────────────────────────────────────────────────

interface PanelOverlayProps {
  panel: ComicPanel;
  theme: BubbleTheme;
}

const PANEL_QUADRANTS: Record<number, { top: string; left: string; width: string; height: string }> = {
  1: { top: '0%', left: '0%', width: '50%', height: '50%' },
  2: { top: '0%', left: '50%', width: '50%', height: '50%' },
  3: { top: '50%', left: '0%', width: '50%', height: '50%' },
  4: { top: '50%', left: '50%', width: '50%', height: '50%' },
};

const PanelOverlay = ({ panel, theme }: PanelOverlayProps) => {
  const quadrant = PANEL_QUADRANTS[panel.id] || PANEL_QUADRANTS[1];

  // Place each bubble. Captions float at panel corner; speech/thought/shout
  // anchor to the speaker's face bbox when available.
  const placedBubbles = panel.bubbles.map((bubble, idx) => {
    const placement = bubble.type === 'caption' || bubble.speaker === 'narrator'
      ? captionPlacement(idx, panel.bubbles.length)
      : bubblePlacementFromBBox(bubble, panel, idx);
    return { bubble, placement };
  });

  return (
    <div style={{
      position: 'absolute',
      top: quadrant.top,
      left: quadrant.left,
      width: quadrant.width,
      height: quadrant.height,
      pointerEvents: 'none',
    }}>
      {placedBubbles.map(({ bubble, placement }, i) => (
        <Bubble
          key={i}
          bubble={bubble}
          placement={placement}
          theme={theme}
        />
      ))}
    </div>
  );
};

// ─── Bubble placement ─────────────────────────────────────────────────────

interface BubblePlacement {
  /** Position inside the panel quadrant, expressed as 0..1. */
  top: number;
  left: number;
  /** Optional max width (% of panel quadrant). */
  maxWidth: number;
  /** Tail anchor inside the panel (where the pointer should aim). */
  tailX: number;
  tailY: number;
  /** Whether to draw a tail at all (captions don't). */
  hasTail: boolean;
}

const bubblePlacementFromBBox = (
  bubble: ComicBubble,
  panel: ComicPanel,
  index: number,
): BubblePlacement => {
  const bbox = panel.bboxes?.[bubble.speaker];
  if (!bbox) {
    // No bbox detected — fall back to corner placement that doesn't overlap
    // the center of the panel where the action usually lives.
    const fallback: BubblePlacement[] = [
      { top: 0.04, left: 0.04, maxWidth: 0.55, tailX: 0.5, tailY: 0.5, hasTail: true },
      { top: 0.04, left: 0.41, maxWidth: 0.55, tailX: 0.5, tailY: 0.5, hasTail: true },
    ];
    return fallback[index % fallback.length];
  }

  // Bbox is normalized to the FULL image (0..1). Convert to panel-local
  // coords by mapping into the panel's quadrant (each quadrant is half-axis).
  const panelOffsetY = panel.id <= 2 ? 0 : 0.5;
  const panelOffsetX = panel.id % 2 === 1 ? 0 : 0.5;
  const [yMin, xMin, yMax, xMax] = bbox;

  // Face center in image coords:
  const faceCY = (yMin + yMax) / 2;
  const faceCX = (xMin + xMax) / 2;

  // Convert to panel-local 0..1:
  const localFaceCY = (faceCY - panelOffsetY) / 0.5;
  const localFaceCX = (faceCX - panelOffsetX) / 0.5;

  // Place bubble above the face if there's room, else below.
  const bubbleAbove = localFaceCY > 0.35;
  const top = bubbleAbove
    ? Math.max(0.02, localFaceCY - 0.32)
    : Math.min(0.74, localFaceCY + 0.18);

  // Horizontal: prefer the side with more room.
  const leftSpace = localFaceCX;
  const rightSpace = 1 - localFaceCX;
  const placeLeft = leftSpace >= rightSpace
    ? Math.max(0.03, localFaceCX - 0.35)
    : Math.min(0.62, localFaceCX + 0.04);

  return {
    top,
    left: placeLeft,
    maxWidth: 0.6,
    tailX: localFaceCX,
    tailY: bubbleAbove ? localFaceCY - 0.04 : localFaceCY + 0.04,
    hasTail: true,
  };
};

const captionPlacement = (index: number, total: number): BubblePlacement => {
  // Captions stack at the bottom of the panel (or top if multiple).
  const isMulti = total > 1;
  return {
    top: isMulti && index === 0 ? 0.04 : 0.84,
    left: 0.06,
    maxWidth: 0.88,
    tailX: 0,
    tailY: 0,
    hasTail: false,
  };
};

// ─── Bubble component ─────────────────────────────────────────────────────

interface BubbleProps {
  bubble: ComicBubble;
  placement: BubblePlacement;
  theme: BubbleTheme;
}

const Bubble = ({ bubble, placement, theme }: BubbleProps) => {
  const isCaption = bubble.type === 'caption' || bubble.speaker === 'narrator';
  const isShout = bubble.type === 'shout';
  const isThought = bubble.type === 'thought';

  const caption = theme.caption;

  // Clamp font size by text length to avoid overflow.
  const len = bubble.text.length;
  const fontSize = isCaption
    ? len > 30 ? '0.62rem' : '0.7rem'
    : len > 24 ? '0.62rem' : len > 14 ? '0.68rem' : '0.74rem';

  const baseStyle: CSSProperties = {
    position: 'absolute',
    top: `${placement.top * 100}%`,
    left: `${placement.left * 100}%`,
    maxWidth: `${placement.maxWidth * 100}%`,
    minWidth: '20%',
    padding: theme.padding,
    background: isCaption ? caption.background : theme.background,
    color: isCaption ? caption.color : theme.color,
    border: isCaption ? caption.border : theme.border,
    borderRadius: isCaption ? '6px' : isShout ? `${parseInt(String(theme.borderRadius), 10) || 18}px ${(parseInt(String(theme.borderRadius), 10) || 18) + 8}px` : isThought ? '24px 28px 22px 26px' : theme.borderRadius,
    boxShadow: theme.boxShadow,
    fontFamily: isCaption ? caption.fontFamily : theme.fontFamily,
    fontWeight: isCaption ? caption.fontWeight : theme.fontWeight,
    fontSize,
    lineHeight: 1.25,
    letterSpacing: theme.letterSpacing,
    textAlign: 'center',
    direction: 'rtl',
    pointerEvents: 'none',
    zIndex: 5,
    transform: isShout
      ? `${theme.transform || ''} rotate(-2deg)`.trim()
      : theme.transform,
    wordBreak: 'break-word',
  };

  return (
    <div style={baseStyle}>
      <span>{bubble.text}</span>
      {placement.hasTail && !isCaption && (
        <BubbleTail
          theme={theme}
          fromX={50}
          fromY={100}
          toX={(placement.tailX - placement.left) / Math.max(0.001, placement.maxWidth) * 100}
          toY={(placement.tailY - placement.top) * 100}
          isThought={isThought}
        />
      )}
    </div>
  );
};

// ─── Bubble tail (SVG pointer) ────────────────────────────────────────────

const BubbleTail = ({ theme, fromX, fromY, toX, toY, isThought }: {
  theme: BubbleTheme; fromX: number; fromY: number; toX: number; toY: number; isThought: boolean;
}) => {
  // SVG rendered as overlay anchored at the bubble's bottom edge. Coords
  // are in % of the bubble's own bounding box.
  const fillColor = theme.tailColor || theme.background;

  if (isThought) {
    // Thought bubble — three shrinking circles trailing toward the speaker.
    const dx = toX - fromX;
    const dy = toY - fromY;
    return (
      <svg
        style={{ position: 'absolute', top: 0, left: 0, width: '120%', height: '160%', overflow: 'visible', pointerEvents: 'none' }}
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        <circle cx={fromX + dx * 0.35} cy={fromY + dy * 0.35} r={4} fill={fillColor} stroke="#0a0a0a" strokeWidth={1} />
        <circle cx={fromX + dx * 0.6} cy={fromY + dy * 0.6} r={2.5} fill={fillColor} stroke="#0a0a0a" strokeWidth={1} />
      </svg>
    );
  }

  // Speech tail — triangle from bubble to face.
  const baseLeft = fromX - 7;
  const baseRight = fromX + 7;
  const points = `${baseLeft},${fromY} ${baseRight},${fromY} ${toX},${toY}`;

  return (
    <svg
      style={{ position: 'absolute', top: 0, left: 0, width: '160%', height: '180%', overflow: 'visible', pointerEvents: 'none' }}
      viewBox="0 0 100 200"
      preserveAspectRatio="none"
    >
      <polygon
        points={points}
        fill={fillColor}
        stroke="#0a0a0a"
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
    </svg>
  );
};
