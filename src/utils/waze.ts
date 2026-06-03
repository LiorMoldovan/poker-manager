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
