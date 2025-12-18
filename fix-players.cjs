const fs = require('fs');

// Read the sync data
const syncData = JSON.parse(fs.readFileSync('public/sync-data.json', 'utf8'));

// Players to remove by name (safer than ID)
const playerNamesToRemove = ['ארז', 'אסף', 'פבל'];

console.log('Before removal:', syncData.players.length, 'players');

// Remove the players
const removedPlayers = [];
syncData.players = syncData.players.filter(player => {
  if (playerNamesToRemove.includes(player.name)) {
    removedPlayers.push(player.name + ' (' + player.id + ')');
    return false;
  }
  return true;
});

console.log('Removed:', removedPlayers.join(', '));
console.log('After removal:', syncData.players.length, 'players');

// Update lastUpdated timestamp
syncData.lastUpdated = new Date().toISOString();

// Write back
fs.writeFileSync('public/sync-data.json', JSON.stringify(syncData, null, 2), 'utf8');

console.log('\nDone! Players removed successfully.');
console.log('New lastUpdated:', syncData.lastUpdated);

// Show summary of player types
const permanent = syncData.players.filter(p => p.type === 'permanent');
const permanentGuest = syncData.players.filter(p => p.type === 'permanent_guest');
const guest = syncData.players.filter(p => p.type === 'guest');

console.log('\nPlayer types summary:');
console.log(`- permanent: ${permanent.length}`);
console.log(`- permanent_guest: ${permanentGuest.length}`);
console.log(`- guest: ${guest.length}`);
console.log(`- TOTAL: ${syncData.players.length}`);
