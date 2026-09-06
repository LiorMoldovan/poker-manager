// Host-rotation suggestion: "whose turn is it to host the next game?"
//
// In this group a game's `location` is usually the host's name ("ליאור",
// "סגל"), so picking a location is really picking a host and the fair answer
// is whoever has gone longest without hosting — restricted to people who are
// actually coming, since you can't play at the home of someone who isn't
// there. Locations that aren't a player's name ("מקלט ליכטר") are standalone
// venues: they carry their own history and are always selectable, since
// there's no absent host to rule them out.
//
// Pure functions with no cache/DB access so the caller decides what slice
// of history to feed in and the ranking stays trivially inspectable.

import type { Game, Player } from '../types';

export interface HostCandidate {
  // The exact string to write into the poll's location field.
  location: string;
  // The player whose home this is, when the label resolves to one.
  playerId: string | null;
  gamesHosted: number;
  lastHostedIso: string | null;
  // Days since this host last hosted; null when they never have.
  daysSince: number | null;
  // False only when we know the host isn't coming on the relevant date.
  attending: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Resolve a location to the player whose home it is — exact name match only.
//
// This used to also match on substring, which folded "מקלט ליכטר" into
// ליכטר's hosting count on the assumption that the qualifier described his
// home. It doesn't: the shelter is a genuinely separate venue, and crediting
// its games to him both overstated his turns and hid a place the group can
// actually choose. A location that isn't somebody's name is its own venue.
export function resolveHostPlayer(location: string, players: Player[]): Player | null {
  const raw = location.trim();
  if (!raw) return null;
  return players.find(p => p.name.trim() === raw) ?? null;
}

export function suggestHosts(opts: {
  games: Game[];
  players: Player[];
  // Location presets from Settings. This is the definitive list of what can
  // be offered: a preset with no history still surfaces as "hasn't hosted
  // yet", and a venue with history that isn't a preset is not offered.
  knownLocations: string[];
  // Players with a 'yes' on the relevant date. `null` means attendance is
  // unknown (nobody has voted yet) — then we rank everyone equally rather
  // than suppressing the whole panel.
  attendingPlayerIds: Set<string> | null;
  now: number;
}): HostCandidate[] {
  const { games, players, knownLocations, attendingPlayerIds, now } = opts;

  // Canonical label → tally. Keyed by the resolved host's name when the
  // location maps to a player, so "ליכטר" and "מקלט ליכטר" share one row.
  const byLabel = new Map<string, {
    playerId: string | null;
    gamesHosted: number;
    lastMs: number | null;
  }>();

  const upsert = (rawLocation: string, atMs: number | null) => {
    const raw = rawLocation.trim();
    if (!raw) return;
    const host = resolveHostPlayer(raw, players);
    const label = host ? host.name.trim() : raw;
    const row = byLabel.get(label) ?? {
      playerId: host?.id ?? null,
      gamesHosted: 0,
      lastMs: null,
    };
    if (atMs !== null) {
      row.gamesHosted += 1;
      if (row.lastMs === null || atMs > row.lastMs) row.lastMs = atMs;
    }
    // A later exact-name match can resolve a player the first pass missed.
    if (row.playerId === null && host) row.playerId = host.id;
    byLabel.set(label, row);
  };

  // Every game that recorded a location counts as a hosting turn —
  // including one already scheduled but not yet played, so we don't
  // suggest the person hosting next week.
  for (const g of games) {
    if (!g.location) continue;
    const ms = new Date(g.date).getTime();
    upsert(g.location, Number.isFinite(ms) ? ms : null);
  }
  for (const loc of knownLocations) upsert(loc, null);

  // Only venues on the Settings list can be offered for a future game.
  // History from a venue that has since been dropped ("מקלט ליכטר", used
  // twice during a stretch in April) still lives in the games table and in
  // the statistics screen, but it shouldn't be proposed as somewhere to play
  // next — and it would otherwise top the ranking forever, since "longest
  // time since hosting" reads an abandoned venue as the most overdue one.
  // Re-adding it in Settings is all it takes to bring it back.
  //
  // A group that has never configured the list falls back to whatever
  // history shows, otherwise the panel would have nothing to offer at all.
  const offerable = new Set(
    knownLocations
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => resolveHostPlayer(l, players)?.name.trim() ?? l),
  );
  const restrictToOfferable = offerable.size > 0;

  const candidates: HostCandidate[] = [];
  for (const [label, row] of byLabel) {
    if (restrictToOfferable && !offerable.has(label)) continue;
    // Unknown attendance, or a venue that isn't tied to a player, is not
    // evidence of absence — only an explicit "not on the yes list" is.
    const attending = !attendingPlayerIds
      || row.playerId === null
      || attendingPlayerIds.has(row.playerId);
    candidates.push({
      location: label,
      playerId: row.playerId,
      gamesHosted: row.gamesHosted,
      lastHostedIso: row.lastMs === null ? null : new Date(row.lastMs).toISOString(),
      daysSince: row.lastMs === null ? null : Math.max(0, Math.floor((now - row.lastMs) / DAY_MS)),
      attending,
    });
  }

  // Whoever is coming and has gone longest without hosting, first. Never
  // hosted sorts ahead of any date; ties break toward the lighter load.
  candidates.sort((a, b) => {
    if (a.attending !== b.attending) return a.attending ? -1 : 1;
    const aGap = a.daysSince === null ? Infinity : a.daysSince;
    const bGap = b.daysSince === null ? Infinity : b.daysSince;
    if (aGap !== bGap) return bGap - aGap;
    if (a.gamesHosted !== b.gamesHosted) return a.gamesHosted - b.gamesHosted;
    return a.location.localeCompare(b.location, 'he');
  });

  return candidates;
}
