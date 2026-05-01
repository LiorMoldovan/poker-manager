import React, { useEffect, useRef, useState } from 'react';

// Number input that holds an internal *string draft* so the user can clear
// the field to empty mid-edit and re-type from scratch — the previous
// implementation bound the input directly to a numeric prop with the
// classic `parseInt(e.target.value) || 0` fallback, which silently snapped
// any partially-deleted value back to `0` and made it impossible to
// "delete everything and start over". Now:
//
//   * Typing keeps a string `draft`. We commit a parsed integer up to the
//     parent only when the draft is non-empty AND parses cleanly.
//   * Empty draft is allowed for as long as the user is editing — no
//     `onChange` fires upward, so settings/chip values stay at their
//     previous valid value rather than being clobbered with 0.
//   * On blur, an empty/invalid draft snaps back to the last committed
//     value so the input never persists in an unparseable state. Drafts
//     below `min` snap up to `min` and commit that.
//   * External prop changes (realtime sync, programmatic update) refresh
//     the draft only when they differ from what we last committed,
//     preserving in-progress edits against unrelated re-renders.

interface Props {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  // Forwarded blur — runs AFTER the internal clamp/snap-back logic so a
  // caller can chain side-effects (e.g. persist to Supabase) and is
  // guaranteed to read a normalized state.
  onBlur?: (e: React.FocusEvent<HTMLInputElement>) => void;
  className?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
  name?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
}

export function NumericInput({
  value,
  onChange,
  min,
  max,
  onBlur,
  className,
  style,
  disabled,
  placeholder,
  id,
  name,
  inputMode,
}: Props) {
  const [draft, setDraft] = useState<string>(() => String(value));
  const lastCommittedRef = useRef<number>(value);

  useEffect(() => {
    if (value !== lastCommittedRef.current) {
      setDraft(String(value));
      lastCommittedRef.current = value;
    }
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setDraft(v);
    if (v === '') return;
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return;
    lastCommittedRef.current = n;
    onChange(n);
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const n = parseInt(draft, 10);
    if (Number.isNaN(n)) {
      setDraft(String(lastCommittedRef.current));
    } else if (min !== undefined && n < min) {
      setDraft(String(min));
      lastCommittedRef.current = min;
      onChange(min);
    } else if (max !== undefined && n > max) {
      setDraft(String(max));
      lastCommittedRef.current = max;
      onChange(max);
    }
    onBlur?.(e);
  };

  return (
    <input
      type="number"
      value={draft}
      onChange={handleChange}
      onBlur={handleBlur}
      min={min}
      max={max}
      className={className}
      style={style}
      disabled={disabled}
      placeholder={placeholder}
      id={id}
      name={name}
      inputMode={inputMode}
    />
  );
}
