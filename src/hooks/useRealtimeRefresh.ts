import { useEffect, useRef } from 'react';

// Subscribes the consumer to "the data behind this screen has probably changed,
// please re-fetch". Two trigger sources:
//
//   1. `supabase-cache-updated` — broadcast by `supabaseCache.ts` after every
//      realtime-driven cache refresh (the original behaviour).
//
//   2. Tab becoming visible/focused — covers the gap where Supabase Realtime
//      events arrive while the tab is backgrounded, the OS suspends the WS
//      connection, and the resulting events are simply lost (not redelivered
//      on reconnect). Without this, a screen that was visible during a missed
//      event keeps rendering stale data until the next legitimate change. With
//      this, every tab-resume forces one idempotent re-fetch and the UI
//      converges on the truth — exactly the failure mode that left the
//      GroupManagementTab member list showing `ספי טורס` after migration 046
//      had already deleted that record.
//
// Debounced (500ms) because `visibilitychange` and `focus` often fire
// back-to-back on tab restore — we want a single callback invocation.

export function useRealtimeRefresh(callback: () => void): void {
  // Hold the latest callback in a ref so the event listeners always call the
  // current closure without re-binding on every render.
  const cbRef = useRef(callback);
  cbRef.current = callback;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const fire = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        cbRef.current();
      }, 500);
    };

    const onCacheUpdated = () => fire();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') fire();
    };
    const onFocus = () => fire();

    window.addEventListener('supabase-cache-updated', onCacheUpdated);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);

    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('supabase-cache-updated', onCacheUpdated);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
  }, []);
}
