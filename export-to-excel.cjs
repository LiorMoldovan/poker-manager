const XLSX = require('xlsx');
const fs = require('fs');

// Read the sync data
const syncData = JSON.parse(fs.readFileSync('public/sync-data.json', 'utf8'));

// Create player lookup map
const playerMap = new Map(syncData.players.map(p => [p.id, p]));

// Sort games by date
const sortedGames = [...syncData.games].sort((a, b) => new Date(a.date) - new Date(b.date));

// Create game players lookup (gameId -> array of gamePlayers)
const gamePlayersMap = new Map();
syncData.gamePlayers.forEach(gp => {
  if (!gamePlayersMap.has(gp.gameId)) {
    gamePlayersMap.set(gp.gameId, []);
  }
  gamePlayersMap.get(gp.gameId).push(gp);
});

// ========== SHEET 1: All Games with Players ==========
const gamesData = [];
gamesData.push(['Game Date', 'Player', 'Player Type', 'Buyins', 'Final Chips', 'Profit/Loss']);

sortedGames.forEach(game => {
  const gamePlayers = gamePlayersMap.get(game.id) || [];
  // Sort by profit (highest first)
  gamePlayers.sort((a, b) => (b.profitLoss || 0) - (a.profitLoss || 0));
  
  gamePlayers.forEach(gp => {
    const player = playerMap.get(gp.playerId);
    gamesData.push([
      game.date,
      gp.playerName,
      player?.type || 'unknown',
      gp.rebuys || 0,
      gp.finalValue || 0,
      gp.profitLoss || 0
    ]);
  });
});

// ========== SHEET 2: Player Summary ==========
const playerSummary = [];
playerSummary.push(['Player', 'Type', 'Games', 'Wins', 'Losses', 'Total Profit', 'Avg Profit', 'Best Game', 'Worst Game']);

// Calculate stats per player
const playerStats = new Map();
syncData.gamePlayers.forEach(gp => {
  if (!playerStats.has(gp.playerName)) {
    playerStats.set(gp.playerName, {
      games: 0,
      wins: 0,
      losses: 0,
      totalProfit: 0,
      best: -Infinity,
      worst: Infinity,
      playerId: gp.playerId
    });
  }
  const stats = playerStats.get(gp.playerName);
  const profit = gp.profitLoss || 0;
  stats.games++;
  stats.totalProfit += profit;
  if (profit > 0) stats.wins++;
  if (profit < 0) stats.losses++;
  if (profit > stats.best) stats.best = profit;
  if (profit < stats.worst) stats.worst = profit;
});

// Sort by total profit
const sortedPlayers = [...playerStats.entries()].sort((a, b) => b[1].totalProfit - a[1].totalProfit);

sortedPlayers.forEach(([name, stats]) => {
  const player = playerMap.get(stats.playerId);
  playerSummary.push([
    name,
    player?.type || 'unknown',
    stats.games,
    stats.wins,
    stats.losses,
    stats.totalProfit,
    Math.round(stats.totalProfit / stats.games),
    stats.best === -Infinity ? 0 : stats.best,
    stats.worst === Infinity ? 0 : stats.worst
  ]);
});

// ========== SHEET 3: Games Matrix (Players x Games) ==========
// Get all unique player names
const allPlayerNames = [...new Set(syncData.gamePlayers.map(gp => gp.playerName))].sort();

const matrixData = [];
// Header row: Date columns
const headerRow = ['Player', 'Type', 'Total'];
sortedGames.forEach(g => headerRow.push(g.date));
matrixData.push(headerRow);

// Data rows: one per player
allPlayerNames.forEach(playerName => {
  const playerGps = syncData.gamePlayers.filter(gp => gp.playerName === playerName);
  const gpByGame = new Map(playerGps.map(gp => [gp.gameId, gp]));
  const player = playerMap.get(playerGps[0]?.playerId);
  
  const total = playerGps.reduce((sum, gp) => sum + (gp.profitLoss || 0), 0);
  const row = [playerName, player?.type || 'unknown', total];
  
  sortedGames.forEach(game => {
    const gp = gpByGame.get(game.id);
    row.push(gp ? gp.profitLoss || 0 : '');
  });
  
  matrixData.push(row);
});

// Create workbook
const wb = XLSX.utils.book_new();

const ws1 = XLSX.utils.aoa_to_sheet(gamesData);
XLSX.utils.book_append_sheet(wb, ws1, 'All Games');

const ws2 = XLSX.utils.aoa_to_sheet(playerSummary);
XLSX.utils.book_append_sheet(wb, ws2, 'Player Summary');

const ws3 = XLSX.utils.aoa_to_sheet(matrixData);
XLSX.utils.book_append_sheet(wb, ws3, 'Games Matrix');

// Write file
const filename = 'poker-export-' + new Date().toISOString().split('T')[0] + '.xlsx';
XLSX.writeFile(wb, filename);

console.log(`✅ Exported to: ${filename}`);
console.log(`   - ${sortedGames.length} games`);
console.log(`   - ${syncData.players.length} players`);
console.log(`   - ${syncData.gamePlayers.length} game records`);
console.log('\nSheets:');
console.log('   1. All Games - Every game with player results');
console.log('   2. Player Summary - Stats per player');
console.log('   3. Games Matrix - Players (rows) x Games (columns)');

