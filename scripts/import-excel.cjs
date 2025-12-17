/**
 * Import Excel data into localStorage-compatible format
 * Run with: node scripts/import-excel.js
 */

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

// Permanent players (core group)
const PERMANENT_PLAYERS = [
  'ליאור', 'אייל', 'חרדון', 'אורן', 'ליכטר', 'סגל', 'תומר', 'פיליפ', 'אסף מוזס', 'פאבל'
];

// Read and parse Excel
const wb = XLSX.readFile('Poker results.xlsx');
const ws = wb.Sheets[wb.SheetNames[0]];
const data = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });

// Get all dates (columns) - skip first column which is player name
const dates = data[0].slice(1);

// Parse dates from various formats
function parseHebrewDate(dateStr) {
  if (!dateStr) return null;
  
  const str = dateStr.toString().trim();
  
  // Skip non-date strings like "ינואר22"
  if (/[א-ת]/.test(str)) return null;
  
  // Handle DD.MM.YY or DD/MM/YY formats
  let parts;
  if (str.includes('.')) {
    parts = str.split('.');
  } else if (str.includes('/')) {
    parts = str.split('/');
  } else {
    return null;
  }
  
  if (parts.length !== 3) return null;
  
  let [day, month, year] = parts.map(p => parseInt(p, 10));
  
  // Validate numbers
  if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
  
  // Handle 2-digit years
  if (year < 100) {
    year += 2000;
  }
  
  // Validate ranges
  if (day < 1 || day > 31 || month < 1 || month > 12 || year < 2000 || year > 2030) return null;
  
  // Create date as ISO string
  const date = new Date(year, month - 1, day, 12, 0, 0); // Noon to avoid timezone issues
  return date.toISOString();
}

// Get all unique players and their data
const playerGameData = {}; // { playerName: { date: profit } }

for (let i = 1; i < data.length; i++) {
  const playerName = data[i][0];
  if (!playerName) continue;
  
  playerGameData[playerName] = {};
  
  for (let j = 1; j < data[i].length; j++) {
    const val = data[i][j];
    if (val !== null && val !== undefined && val !== '') {
      const numVal = parseFloat(String(val).replace(',', '').trim());
      if (!isNaN(numVal)) {
        playerGameData[playerName][dates[j-1]] = numVal;
      }
    }
  }
}

// Generate UUIDs
function generateId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Create players
const players = [];
const playerIdMap = {}; // name -> id

Object.keys(playerGameData).forEach(name => {
  const id = generateId();
  const gamesCount = Object.keys(playerGameData[name]).length;
  
  // Determine player type
  let type = 'guest';
  if (PERMANENT_PLAYERS.includes(name)) {
    type = 'permanent';
  } else if (gamesCount >= 50) {
    // Players with 50+ games are permanent guests
    type = 'permanent_guest';
  }
  
  players.push({
    id,
    name,
    type,
    createdAt: new Date().toISOString()
  });
  
  playerIdMap[name] = id;
});

console.log('\n=== PLAYERS ===');
console.log(`Total: ${players.length}`);
console.log(`Permanent: ${players.filter(p => p.type === 'permanent').length}`);
console.log(`Permanent Guest: ${players.filter(p => p.type === 'permanent_guest').length}`);
console.log(`Guest: ${players.filter(p => p.type === 'guest').length}`);

// Create games (skip last 2 as per user request)
const gameDates = dates.slice(0, -2); // Skip last 2 games
const games = [];
const gamePlayers = [];

console.log(`\n=== GAMES ===`);
console.log(`Total dates: ${dates.length}`);
console.log(`Importing: ${gameDates.length} (skipping last 2)`);

gameDates.forEach((dateStr, index) => {
  const isoDate = parseHebrewDate(dateStr);
  if (!isoDate) {
    console.log(`Skipping invalid date: ${dateStr}`);
    return;
  }
  
  const gameId = generateId();
  
  // Find all players who played on this date
  const playersInGame = [];
  Object.entries(playerGameData).forEach(([playerName, gameResults]) => {
    if (gameResults[dateStr] !== undefined) {
      playersInGame.push({
        name: playerName,
        profit: gameResults[dateStr]
      });
    }
  });
  
  if (playersInGame.length === 0) {
    console.log(`No players for date: ${dateStr}`);
    return;
  }
  
  // Create game
  games.push({
    id: gameId,
    date: isoDate,
    status: 'completed',
    createdAt: isoDate
  });
  
  // Create game players
  playersInGame.forEach(({ name, profit }) => {
    gamePlayers.push({
      id: generateId(),
      gameId,
      playerId: playerIdMap[name],
      playerName: name,
      rebuys: 0, // Not available in Excel
      chipCounts: {},
      finalValue: 0,
      profit
    });
  });
});

console.log(`Created: ${games.length} games with ${gamePlayers.length} player entries`);

// Prepare localStorage data
const storageData = {
  poker_players: JSON.stringify(players),
  poker_games: JSON.stringify(games),
  poker_game_players: JSON.stringify(gamePlayers)
};

// Save to a JSON file that can be imported
const outputPath = path.join(__dirname, 'import-data.json');
fs.writeFileSync(outputPath, JSON.stringify(storageData, null, 2));

console.log(`\n✅ Data saved to: ${outputPath}`);
console.log('\nNext steps:');
console.log('1. Open the app in browser');
console.log('2. Open browser console (F12)');
console.log('3. Run: localStorage.setItem("poker_players", <paste poker_players value>)');
console.log('4. Run: localStorage.setItem("poker_games", <paste poker_games value>)');
console.log('5. Run: localStorage.setItem("poker_game_players", <paste poker_game_players value>)');
console.log('6. Refresh the page');

// Also create a single-line version for easy copy-paste
const importScript = `
// Copy and paste this into browser console:
localStorage.setItem("poker_players", '${JSON.stringify(players).replace(/'/g, "\\'")}');
localStorage.setItem("poker_games", '${JSON.stringify(games).replace(/'/g, "\\'")}');
localStorage.setItem("poker_game_players", '${JSON.stringify(gamePlayers).replace(/'/g, "\\'")}');
location.reload();
`;

const scriptPath = path.join(__dirname, 'import-script.js');
fs.writeFileSync(scriptPath, importScript);
console.log(`\n📋 Easy import script saved to: ${scriptPath}`);

// Display player breakdown
console.log('\n=== PLAYER BREAKDOWN ===');
console.log('\nPermanent Players:');
players.filter(p => p.type === 'permanent').forEach(p => {
  const games = Object.keys(playerGameData[p.name]).length;
  console.log(`  ${p.name}: ${games} games`);
});

console.log('\nGuests - אורחים (50+ games):');
players.filter(p => p.type === 'permanent_guest').forEach(p => {
  const games = Object.keys(playerGameData[p.name]).length;
  console.log(`  ${p.name}: ${games} games`);
});

console.log('\nOccasional - מזדמנים (<50 games):');
players.filter(p => p.type === 'guest').forEach(p => {
  const games = Object.keys(playerGameData[p.name]).length;
  console.log(`  ${p.name}: ${games} games`);
});

