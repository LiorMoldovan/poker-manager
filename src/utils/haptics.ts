export function hapticTap() {
  try { navigator?.vibrate?.(10); } catch { /* unsupported */ }
}

export function hapticSuccess() {
  try { navigator?.vibrate?.([10, 50, 10]); } catch { /* unsupported */ }
}

export function hapticError() {
  try { navigator?.vibrate?.([30, 50, 30]); } catch { /* unsupported */ }
}
