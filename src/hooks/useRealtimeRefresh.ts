import { useEffect, useRef } from 'react';

// Subscribes the consumer to "the data behind this screen has probably changed,
// please re-fetch". Three trigger sources:
//
//   1. `supabase-cache-updated` — broadcast by `supabaseCache.ts` after every
//      realtime-driven cache refresh (the original behaviour).
//
//   2. Tab becoming visible/focused — covers the gap where Supabase Realtime
//      events arrive while the tab is backgrounded, the OS suspends the WS
//      connection, and the resulting events are simply lost (not redelivered
//      on reconnect). Without this, a screen that was visible during a missed
//      event keeps rendering stale data until the next legitimate change.
//
//   3. (Opt-in) `forceRefreshOnReturn` — a callback that re-fetches the
//      relevant data straight from Supabase when the user returns to the
//      app. Critical for screens whose underlying tables are write-heavy
//      from OTHER clients (e.g. the schedule/vote tab — peers vote while
//      your phone is asleep). Without this, the trigger #2 callback only
//      re-renders from the in-memory cache, which is itself stale because
//      the WS missed those events. With it, returning to the app forces a
//      DB-side refresh; the resulting `supabase-cache-updated` event then
//      fires the consumer's callback with fresh data.
//
// Debounced (500ms) because `visibilitychange` and `focus` often fire
// back-to-back on tab restore — we want a single callback invocation.

export function useRealtimeRefresh(
  callback: () => void,
  forceRefreshOnReturn?: () => void | Promise<void>,
): void {
  // Hold the latest callbacks in refs so the event listeners always call the
  // current closures without re-binding on every render.
  const cbRef = useRef(callback);
  const forceRef = useRef(forceRefreshOnReturn);
  cbRef.current = callback;
  forceRef.current = forceRefreshOnReturn;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const fire = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        cbRef.current();
      }, 500);
    };

    // On return, if the consumer provided a forceRefresh callback, prefer
    // refreshing from the DB and let `supabase-cache-updated` retrigger
    // `fire()` once the cache is fresh — this avoids a brief stale-data
    // flash on tab return. If no callback is provided, fall back to the
    // original cache-only re-render (safe for screens whose realtime path
    // is reliable enough that this gap doesn't matter).
    const onReturn = () => {
      const force = forceRef.current;
      if (!force) {
        fire();
        return;
      }
      try {
        const result = force();
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          (result as Promise<unknown>).catch(err =>
            console.warn('forceRefreshOnReturn failed:', err));
        }
      } catch (err) {
        console.warn('forceRefreshOnReturn failed:', err);
      }
      // Belt-and-suspenders: also schedule a regular fire so a screen still
      // re-renders even if the forced refresh produces no actual change
      // (e.g. nothing on the server changed while we were gone).
      fire();
    };

    const onCacheUpdated = () => fire();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') onReturn();
    };
    const onFocus = () => onReturn();

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
