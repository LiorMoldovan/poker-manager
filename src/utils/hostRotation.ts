// Host-rotation suggestion: "whose turn is it to host the next game?"
//
// In this group a game's `location` is the host's name ("ליאור", "סגל"),
// occasionally with a qualifier ("מקלט ליכטר"). So picking a location is
// really picking a host, and the fair answer is whoever has gone longest
// without hosting — restricted to people who are actually coming, since
// you can't play at the home of someone who isn't there.
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

// 1-2 character player names ("כ", "ק") would substring-match almost any
// location string, so they only ever match exactly.
const MIN_SUBSTRING_NAME_LEN = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

// Resolve a free-text location to the player whose home it is. Exact match
// wins; otherwise the longest player name contained in the string, so
// "מקלט ליכטר" is credited to ליכטר rather than treated as a separate
// venue that has "never hosted".
export function resolveHostPlayer(location: string, players: Player[]): Player | null {
  const raw = location.trim();
  if (!raw) return null;

  const exact = players.find(p => p.name.trim() === raw);
  if (exact) return exact;

  let best: Player | null = null;
  for (const p of players) {
    const name = p.name.trim();
    if (name.length < MIN_SUBSTRING_NAME_LEN) continue;
    if (!raw.includes(name)) continue;
    if (!best || name.length > best.name.trim().length) best = p;
  }
  return best;
}

export function suggestHosts(opts: {
  games: Game[];
  players: Player[];
  // Location presets from Settings — included even with no history, so a
  // newly-added venue can surface as "hasn't hosted yet".
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

  const candidates: HostCandidate[] = [];
  for (const [label, row] of byLabel) {
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
