// iOS-style green/grey toggle switch. The app's standard for boolean
// settings — replaces native <input type="checkbox"> so we don't render
// the OS-default blue check (which clashes with the app's green primary
// palette) and so the visual matches across mobile/desktop. Originally
// lived inside ScheduleTab.tsx; extracted to its own file the moment a
// second screen needed it (ChipEntryScreen mixed-mode toggle), so we
// don't duplicate ~40 lines of switch chrome.

interface ToggleSwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel?: string;
  disabled?: boolean;
}

export function ToggleSwitch({ checked, onChange, ariaLabel, disabled }: ToggleSwitchProps) {
  const TRACK_W = 40;
  const TRACK_H = 22;
  const THUMB = 16;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      style={{
        position: 'relative',
        width: TRACK_W,
        height: TRACK_H,
        borderRadius: TRACK_H / 2,
        border: 'none',
        padding: 0,
        flexShrink: 0,
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: checked ? 'var(--primary)' : 'rgba(148, 163, 184, 0.35)',
        opacity: disabled ? 0.5 : 1,
        transition: 'background 0.18s ease',
        direction: 'ltr',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: (TRACK_H - THUMB) / 2,
          left: checked ? TRACK_W - THUMB - (TRACK_H - THUMB) / 2 : (TRACK_H - THUMB) / 2,
          width: THUMB,
          height: THUMB,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 2px rgba(0, 0, 0, 0.25)',
          transition: 'left 0.18s ease',
        }}
      />
    </button>
  );
}
