// Stand-in for src/database/storage.ts. Serves the merged fixture so the real
// prompt builders run unmodified under Node, with no Supabase or browser deps.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, '..', 'fixture.json'), 'utf8'));

export const getAllPlayers = () => fixture.players;
export const getAllGames = () => fixture.games;
export const getAllGamePlayers = () => fixture.gamePlayers;
export const getSettings = () => fixture.settings;

export const isPlayerFemale = (name: string) =>
  fixture.players.find((p: any) => p.name === name)?.gender === 'female';

// Traits are AI-authored flavour text stored per group. Left empty on purpose:
// the lab measures what the prompt does with hard game data, and traits are the
// one input the prompt already tells the model to use sparingly.
export const getAllPlayerTraits = () => new Map();
export const getPlayerTraitsByName = () => undefined;
export const getPlayerTraits = () => undefined;

export const getRebuyRecords = () => {
  const byPlayer = new Map<string, number>();
  let groupMax = 0;
  let groupMaxHolder = '';
  for (const gp of fixture.gamePlayers) {
    const prev = byPlayer.get(gp.playerId) || 0;
    if (gp.rebuys > prev) byPlayer.set(gp.playerId, gp.rebuys);
    if (gp.rebuys > groupMax) {
      groupMax = gp.rebuys;
      groupMaxHolder = gp.playerName;
    }
  }
  return { playerMax: byPlayer, groupMax, groupMaxHolder };
};

export const getPlayerStats = () => [];
