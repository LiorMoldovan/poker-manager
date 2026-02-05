const fs = require('fs');
const data = JSON.parse(fs.readFileSync('public/full-backup.json', 'utf8'));
const { players, games, gamePlayers } = data;

// Players to check
const checkNames = ['ליאור', 'חרדון', 'תומר', 'מלמד', 'פיליפ', 'ליכטר', 'אייל'];

const gamesWithPlayers = games.map(g => ({
  ...g,
  players: gamePlayers.filter(gp => gp.gameId === g.id)
})).sort((a, b) => new Date(b.date) - new Date(a.date));

checkNames.forEach(name => {
  const player = players.find(p => p.name === name);
  if (!player) return console.log(name + ': NOT FOUND');
  
  const playerGames = gamesWithPlayers
    .filter(g => g.players.some(gp => gp.playerId === player.id))
    .map(g => {
      const gp = g.players.find(gp => gp.playerId === player.id);
      return { date: g.date, profit: gp?.profit || 0 };
    });
  
  // Last game
  const lastGame = playerGames[0];
  
  // Streak
  let streak = 0;
  for (const g of playerGames) {
    if (g.profit > 0) { if (streak >= 0) streak++; else break; }
    else if (g.profit < 0) { if (streak <= 0) streak--; else break; }
    else break;
  }
  
  // Total & avg
  const total = playerGames.reduce((s, g) => s + g.profit, 0);
  const avg = playerGames.length > 0 ? total / playerGames.length : 0;
  
  // Last 3 avg
  const last3 = playerGames.slice(0, 3);
  const last3Avg = last3.length > 0 ? last3.reduce((s, g) => s + g.profit, 0) / last3.length : 0;
  
  // 2026 stats
  const games2026 = playerGames.filter(g => new Date(g.date).getFullYear() === 2026);
  const profit2026 = games2026.reduce((s, g) => s + g.profit, 0);
  
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(name);
  console.log('  Games: ' + playerGames.length);
  console.log('  Total Profit: ' + Math.round(total) + '₪');
  console.log('  Avg Profit: ' + Math.round(avg) + '₪/game');
  console.log('  Last 3 Avg: ' + Math.round(last3Avg) + '₪/game');
  console.log('  Streak: ' + streak);
  console.log('  Last Game: ' + (lastGame ? lastGame.date.split('T')[0] + ' = ' + lastGame.profit + '₪' : 'none'));
  console.log('  Last 5: ' + playerGames.slice(0, 5).map(g => g.profit + '₪').join(', '));
  console.log('  2026: ' + games2026.length + ' games, ' + Math.round(profit2026) + '₪');
});
