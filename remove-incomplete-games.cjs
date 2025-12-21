const fs = require('fs');

// Read the sync data
const syncData = JSON.parse(fs.readFileSync('public/sync-data.json', 'utf8'));

console.log('Before removal:');
console.log(`  - Games: ${syncData.games.length}`);
console.log(`  - GamePlayers: ${syncData.gamePlayers.length}`);

// Find non-completed games
const nonCompletedGames = syncData.games.filter(g => g.status !== 'completed');
const nonCompletedIds = new Set(nonCompletedGames.map(g => g.id));

console.log(`\nRemoving ${nonCompletedGames.length} incomplete games:`);
nonCompletedGames.forEach(g => {
  console.log(`  - ${g.date} (${g.status})`);
});

// Remove games
syncData.games = syncData.games.filter(g => g.status === 'completed');

// Remove associated gamePlayers
const gamePlayersBeforeCount = syncData.gamePlayers.length;
syncData.gamePlayers = syncData.gamePlayers.filter(gp => !nonCompletedIds.has(gp.gameId));
const gamePlayersRemoved = gamePlayersBeforeCount - syncData.gamePlayers.length;

console.log(`\nRemoved ${gamePlayersRemoved} associated game player records`);

// Update lastUpdated timestamp
syncData.lastUpdated = new Date().toISOString();

// Write back
fs.writeFileSync('public/sync-data.json', JSON.stringify(syncData, null, 2), 'utf8');

console.log('\nAfter removal:');
console.log(`  - Games: ${syncData.games.length}`);
console.log(`  - GamePlayers: ${syncData.gamePlayers.length}`);
console.log(`\n✅ Done! Incomplete games removed.`);

