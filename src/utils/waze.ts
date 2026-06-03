// Waze deep-link helpers.
//
// `https://waze.com/ul?q=<address>&navigate=yes` is Waze's universal link:
// on mobile it opens the Waze app straight into navigation to the address;
// on desktop it opens Waze Live Map in the browser. No API key needed.

/**
 * Build a Waze navigation URL for a free-text address.
 * Returns null for empty/blank input so callers can gate the affordance.
 */
export function buildWazeUrl(address: string | null | undefined): string | null {
  const trimmed = (address ?? '').trim();
  if (!trimmed) return null;
  return `https://waze.com/ul?q=${encodeURIComponent(trimmed)}&navigate=yes`;
}

/**
 * Resolve the saved address for a location NAME from the group's
 * location_addresses map, then build the Waze URL. Returns null when the
 * name is empty, the map is missing, or the name has no saved address.
 */
export function wazeUrlForLocation(
  locationName: string | null | undefined,
  addresses: Record<string, string> | undefined,
): string | null {
  const name = (locationName ?? '').trim();
  if (!name || !addresses) return null;
  return buildWazeUrl(addresses[name]);
}

/**
 * Open Waze navigation to an address, preferring the installed Waze APP.
 *
 * Why this exists: the bare `https://waze.com/ul?...` universal link only
 * hands off to the app from a top-level browser tab. When our card link is
 * tapped inside an in-app browser (Android Chrome Custom Tab, iOS
 * SFSafariViewController — what you get from a home-screen PWA or a link
 * opened from WhatsApp/Instagram), the universal link does NOT hand off; it
 * just loads waze.com and shows the "haven't installed Waze?" promo even
 * when the app is installed. Custom URL schemes / Android intents DO get
 * intercepted by the OS from those contexts, so we drive off those instead.
 *
 * Behaviour per platform:
 *   Android → `intent://` whose DATA is the `https://waze.com/ul` link with
 *             `package=com.waze` + `S.browser_fallback_url`. Per Waze's docs
 *             the app honours the q/navigate options only via the https base
 *             URL (the bare `waze://` scheme on Android may open the app
 *             WITHOUT starting navigation), so we drive off https + package.
 *             The OS launches Waze if installed; otherwise Chrome auto-loads
 *             the fallback web URL. No timer race.
 *   iOS     → `waze://` scheme (which DOES honour options on iOS); if the app
 *             didn't take over within ~1.2s (i.e. not installed), fall back to
 *             the web URL.
 *   Desktop → open Waze Live Map in a new tab (unchanged behaviour).
 */
export function openWaze(address: string | null | undefined): void {
  const trimmed = (address ?? '').trim();
  if (!trimmed) return;
  const q = encodeURIComponent(trimmed);
  const webUrl = `https://waze.com/ul?q=${q}&navigate=yes`;
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';

  if (/android/i.test(ua)) {
    window.location.href =
      `intent://waze.com/ul?q=${q}&navigate=yes#Intent;scheme=https;package=com.waze;` +
      `S.browser_fallback_url=${encodeURIComponent(webUrl)};end`;
    return;
  }

  if (/iphone|ipad|ipod/i.test(ua)) {
    let appeared = false;
    const onAway = () => { appeared = true; };
    // The Waze app opening backgrounds our page. iOS is inconsistent about
    // which event fires (visibilitychange / pagehide / blur), so listen for
    // all three — any one means the app took over and we must NOT fall back.
    document.addEventListener('visibilitychange', onAway, { once: true });
    window.addEventListener('pagehide', onAway, { once: true });
    window.addEventListener('blur', onAway, { once: true });
    window.setTimeout(() => {
      document.removeEventListener('visibilitychange', onAway);
      window.removeEventListener('pagehide', onAway);
      window.removeEventListener('blur', onAway);
      if (!appeared && !document.hidden) window.location.href = webUrl;
    }, 1200);
    window.location.href = `waze://?q=${q}&navigate=yes`;
    return;
  }

  window.open(webUrl, '_blank', 'noopener,noreferrer');
}
