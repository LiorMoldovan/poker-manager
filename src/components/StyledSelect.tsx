import { useState, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from '../i18n';

// Dark-theme styled select — drop-in replacement for native `<select>`.
//
// Why: native `<select>` on mobile opens an OS-themed (typically white)
// list overlay that visually clashes with this app's dark theme and has
// no styling escape hatch. Desktop is fine, mobile looks broken. This
// component renders a trigger button + custom popover that inherits the
// app's CSS variables and stays consistent across platforms.
//
// State is self-contained — each instance manages its own open/close.
// A full-viewport invisible backdrop dismisses on outside click. Only
// one instance can be open at a time in practice because the backdrop
// blocks clicks on other triggers; the user clicks the backdrop to
// close, then opens the next one. Acceptable for the few selects we
// have on any given screen.
//
// IMPORTANT — the popover is rendered via a React portal into
// `document.body` and positioned with `position: fixed` + the trigger's
// bounding rect. The earlier `position: absolute` version got trapped
// inside ancestor stacking contexts (e.g. the `position:fixed` add-
// member banner at z-index 9999, or any modal overlay) and rendered
// either invisibly behind the page or clipped by `overflow:hidden`
// ancestors. Portal + fixed coords bypasses both problems entirely;
// the popover lives at the document root and its z-index competes only
// with Toast (10001) and modal overlays (200) — we sit at 10000 so we
// stack above modal overlays and the bottom nav (100) but below toasts.
//
// Variants:
//   default — neutral surface (`var(--surface)` / muted text); used by
//             stats sort/mode/period dropdowns.
//   green   — emerald chip (`rgba(16,185,129,*)` / `#10B981`); used by
//             graphs player pickers and time-period sub-selectors.
//   purple  — owner-action chip (`rgba(168,85,247,*)` / `#A855F7`); used
//             by ownership transfer in group management.
//
// Sizes:
//   sm — compact 0.7rem chip (e.g. year/month in a controls strip).
//   md — standard 0.85rem (player pickers, mode selects).
type Variant = 'default' | 'green' | 'purple';
type Size = 'sm' | 'md';

interface StyledSelectProps<T extends string> {
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
  title?: string;
  // Override the auto-derived trigger label (defaults to the selected
  // option's `label`). Useful when the trigger should show a short
  // form or include extra chrome (icons, prefixes) the option list
  // doesn't carry.
  triggerLabel?: string;
  variant?: Variant;
  size?: Size;
  // When true the component fills its parent (matches native
  // `<select style={{ width: '100%' }}>` semantics). When false (the
  // default) the trigger is inline-block sized to its content.
  fullWidth?: boolean;
  // Min-width for the trigger; only applies when not fullWidth.
  minWidth?: string | number;
  ariaLabel?: string;
}

// Z-index hierarchy in this app (from src/styles/index.css):
//   100   → bottom-nav
//   200   → modal-overlay
//   9999  → add-member banner (App.tsx)
//   10001 → toast-container
// We sit at 10000 so we cover everything except toasts (so a
// confirmation toast after picking still reads).
const POPOVER_Z_INDEX = 10000;
const BACKDROP_Z_INDEX = 9999;

export function StyledSelect<T extends string>({
  value,
  options,
  onChange,
  title,
  triggerLabel,
  variant = 'default',
  size = 'md',
  fullWidth = false,
  minWidth,
  ariaLabel,
}: StyledSelectProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // Trigger's bounding rect captured on open + on scroll/resize so
  // the popover follows the trigger. We snapshot in state (not just
  // a ref) so the popover re-renders to the new coords. `null` means
  // not-yet-measured — popover renders invisibly off-screen on first
  // paint until useLayoutEffect lands the real rect synchronously.
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);
  const { isRTL } = useTranslation();

  // Position update — synchronous (`useLayoutEffect`) so the first
  // paint with `isOpen=true` already has the right coords; no visible
  // jump. We re-measure on scroll/resize so the popover sticks to its
  // trigger when the user scrolls the page underneath. On scroll we
  // also could close instead — but following is friendlier for a
  // dropdown buried inside a long form.
  useLayoutEffect(() => {
    if (!isOpen) {
      setTriggerRect(null);
      return;
    }
    const measure = () => {
      if (triggerRef.current) {
        setTriggerRect(triggerRef.current.getBoundingClientRect());
      }
    };
    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [isOpen]);

  const selected = options.find(o => o.value === value);
  const label = triggerLabel ?? selected?.label ?? '';

  // Variant chrome — kept inline (no CSS module / styled-components in
  // this codebase) so the component stays self-contained and matches
  // the rest of the screen's inline-style convention.
  const triggerChrome =
    variant === 'green'
      ? {
          border: '1px solid rgba(16,185,129,0.4)',
          background: 'rgba(16,185,129,0.1)',
          color: '#10B981',
        }
      : variant === 'purple'
      ? {
          border: '1px solid rgba(168,85,247,0.25)',
          background: 'rgba(168,85,247,0.08)',
          color: '#A855F7',
        }
      : {
          border: '1px solid var(--border)',
          background: 'var(--surface)',
          color: 'var(--text-muted)',
        };

  const triggerSize =
    size === 'sm'
      ? { padding: '0.25rem 0.5rem', fontSize: '0.7rem', borderRadius: '6px', fontWeight: 500 }
      : { padding: '0.5rem 0.6rem', fontSize: '0.9rem', borderRadius: '8px', fontWeight: 600 };

  const selectedRowColors =
    variant === 'green'
      ? { background: 'rgba(16,185,129,0.18)', color: '#10B981' }
      : variant === 'purple'
      ? { background: 'rgba(168,85,247,0.18)', color: '#A855F7' }
      : { background: 'rgba(99, 102, 241, 0.18)', color: 'var(--primary)' };

  // Popover position — fixed coords derived from the trigger's
  // viewport rect. Width = trigger width (tracks `fullWidth` naturally).
  // Flips to render ABOVE the trigger if there's not enough room below.
  // Caps height to 60% of viewport so very long player lists scroll
  // instead of overflowing the screen.
  let popoverStyle: React.CSSProperties | null = null;
  if (isOpen && triggerRect) {
    const gap = 4;
    const viewportH = window.innerHeight;
    const viewportW = window.innerWidth;
    const desiredMaxH = Math.min(viewportH * 0.6, 360);
    const roomBelow = viewportH - triggerRect.bottom - gap;
    const roomAbove = triggerRect.top - gap;
    const openUp = roomBelow < 180 && roomAbove > roomBelow;
    const top = openUp
      ? Math.max(8, triggerRect.top - gap - Math.min(desiredMaxH, roomAbove))
      : triggerRect.bottom + gap;
    const maxHeight = openUp
      ? Math.min(desiredMaxH, roomAbove)
      : Math.min(desiredMaxH, roomBelow);
    // Effective rendered width = the menu's actual box width. `width` is
    // the trigger width but `minWidth` (160 for non-fullWidth) can win, so
    // the rendered box is max(triggerWidth, 160). We need this real width
    // to anchor the correct edge below.
    const effectiveWidth = fullWidth ? triggerRect.width : Math.max(triggerRect.width, 160);
    // RTL: anchor the menu's RIGHT edge to the trigger's right edge so it
    // drops straight down from the control. Left-anchoring (the old
    // behaviour) made the menu overhang to the right whenever minWidth
    // exceeded the trigger width (e.g. after picking a short label like
    // "כל הזמנים"), which read as "not aligned right". LTR keeps the
    // left-edge anchor. Then clamp into the viewport (8px margins) so a
    // wide menu next to a screen edge never renders half off-screen.
    let left = isRTL ? triggerRect.right - effectiveWidth : triggerRect.left;
    left = Math.max(8, Math.min(left, viewportW - effectiveWidth - 8));
    popoverStyle = {
      position: 'fixed',
      top,
      left,
      width: triggerRect.width,
      minWidth: fullWidth ? undefined : Math.max(triggerRect.width, 160),
      maxHeight,
      overflowY: 'auto',
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: '8px',
      padding: '0.25rem',
      zIndex: POPOVER_Z_INDEX,
      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
    };
  }

  return (
    <div
      style={{
        display: fullWidth ? 'block' : 'inline-block',
        width: fullWidth ? '100%' : undefined,
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setIsOpen(v => !v);
        }}
        title={title}
        aria-label={ariaLabel ?? title}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        style={{
          ...triggerSize,
          ...triggerChrome,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.4rem',
          width: fullWidth ? '100%' : undefined,
          minWidth,
          maxWidth: fullWidth ? undefined : '100%',
          overflow: 'hidden',
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{label}</span>
        <span style={{ flexShrink: 0, fontSize: '0.65em' }}>{isOpen ? '▲' : '▼'}</span>
      </button>
      {isOpen && popoverStyle && createPortal(
        <>
          {/* Full-viewport backdrop — closes the popover on outside
              click (including any non-popover scroll / nav tap). Kept
              transparent so the rest of the UI stays visually
              uninterrupted while a select is open. Rendered into the
              portal alongside the popover so it sits at the document
              root and isn't trapped in any ancestor's stacking ctx. */}
          <div
            onClick={() => setIsOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: BACKDROP_Z_INDEX }}
          />
          <div role="listbox" style={popoverStyle}>
            {options.map(opt => {
              const isSelected = opt.value === value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    onChange(opt.value);
                    setIsOpen(false);
                  }}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: isRTL ? 'right' : 'left',
                    padding: '0.4rem 0.6rem',
                    fontSize: size === 'sm' ? '0.7rem' : '0.85rem',
                    background: isSelected ? selectedRowColors.background : 'transparent',
                    color: isSelected ? selectedRowColors.color : 'var(--text)',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontWeight: isSelected ? 600 : 400,
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={e => {
                    if (!isSelected) (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)';
                  }}
                  onMouseLeave={e => {
                    if (!isSelected) (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
