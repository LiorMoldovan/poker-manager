import { useState } from 'react';
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
  const { isRTL } = useTranslation();

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

  return (
    <div
      style={{
        position: 'relative',
        display: fullWidth ? 'block' : 'inline-block',
        width: fullWidth ? '100%' : undefined,
      }}
    >
      <button
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
      {isOpen && (
        <>
          {/* Full-viewport backdrop — closes the popover on outside
              click (including any non-popover scroll / nav tap). Kept
              transparent so the rest of the UI stays visually
              uninterrupted while a select is open. */}
          <div
            onClick={() => setIsOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 998 }}
          />
          <div
            role="listbox"
            style={{
              position: 'absolute',
              top: 'calc(100% + 4px)',
              insetInlineStart: 0,
              insetInlineEnd: fullWidth ? 0 : undefined,
              minWidth: fullWidth ? undefined : '160px',
              maxHeight: '60vh',
              overflowY: 'auto',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: '8px',
              padding: '0.25rem',
              zIndex: 999,
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.35)',
            }}
          >
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
        </>
      )}
    </div>
  );
}
