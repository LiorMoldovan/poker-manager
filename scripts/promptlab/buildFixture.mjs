// Merges the April full-backup with the live delta pulled from Supabase into
// one normalized fixture the storage stub can serve.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

const backup = JSON.parse(readFileSync(join(root, 'public', 'full-backup.json'), 'utf8'));
const delta = JSON.parse(readFileSync(join(here, 'delta.json'), 'utf8'));

// The backup predates the Supabase migration and carries its own player-ID
// space, so identity is resolved by name. Live roster wins (it has the real
// type + gender); backup-only names are appended with a synthetic id.
const players = delta.roster.map(([id, name, type, gender]) => ({ id, name, type, gender }));
const idByName = new Map(players.map(p => [p.name, p.id]));
for (const p of backup.players) {
  if (idByName.has(p.name)) continue;
  players.push({ id: p.id, name: p.name, type: p.type || 'guest', gender: p.gender || 'male' });
  idByName.set(p.name, p.id);
}

const games = backup.games
  .filter(g => g.status === 'completed')
  .map(g => ({ id: g.id, date: g.date, status: 'completed', location: g.location || undefined }));
const seenGames = new Set(games.map(g => g.id));
for (const [id, date, location] of delta.games) {
  if (seenGames.has(id)) continue;
  games.push({ id, date, status: 'completed', location: location || undefined });
}

let unresolved = 0;
const gamePlayers = backup.gamePlayers
  .filter(gp => seenGames.has(gp.gameId) && gp.playerName)
  .map(gp => {
    const id = idByName.get(gp.playerName);
    if (!id) unresolved++;
    return {
      gameId: gp.gameId,
      playerId: id || gp.playerId,
      playerName: gp.playerName,
      profit: Number(gp.profit) || 0,
      rebuys: Number(gp.rebuys) || 0,
    };
  });
for (const [gameId, playerId, playerName, profit, rebuys] of delta.gamePlayers) {
  gamePlayers.push({ gameId, playerId, playerName, profit, rebuys });
}

const fixture = {
  players,
  games: games.sort((a, b) => new Date(a.date) - new Date(b.date)),
  gamePlayers,
  settings: { rebuyValue: delta.rebuyValue, locations: delta.locations },
};

writeFileSync(join(here, 'fixture.json'), JSON.stringify(fixture), 'utf8');

const latest = fixture.games[fixture.games.length - 1];
console.log(`fixture: ${players.length} players, ${fixture.games.length} games, ${gamePlayers.length} game-players`);
console.log(`latest game: ${latest.date} @ ${latest.location || '(no location)'}`);
if (unresolved) console.log(`WARNING: ${unresolved} backup rows had no name match`);

// Sanity: Lichter must show 137 completed games and a +703 career best.
const lich = idByName.get('ליכטר');
const his = gamePlayers.filter(g => g.playerId === lich).map(g => g.profit);
console.log(`sanity ליכטר: ${his.length} games, best ${Math.max(...his).toFixed(1)}`);
