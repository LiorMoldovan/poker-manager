const fs = require('fs');

// Read the sync data
const syncData = JSON.parse(fs.readFileSync('public/sync-data.json', 'utf8'));

// Define the correct player types based on user confirmation
const playerTypes = {
  // permanent (11 players)
  'ליאור': 'permanent',
  'חרדון': 'permanent',
  'מלמד': 'permanent',
  'אייל': 'permanent',
  'סגל': 'permanent',
  'אסף מוזס': 'permanent',
  'אורן': 'permanent',
  'פאבל': 'permanent',
  'פיליפ': 'permanent',
  'ליכטר': 'permanent',
  'תומר': 'permanent',
  
  // permanent_guest (5 players)
  'דן מאן': 'permanent_guest',
  'נועם': 'permanent_guest',
  'זיו': 'permanent_guest',
  'מור': 'permanent_guest',
  'גלעד': 'permanent_guest',
  
  // All others are guest (24 players)
  'שגיא אחיין': 'guest',
  'שגיא אחיון': 'guest',
  'מאור 2': 'guest',
  'ספי': 'guest',
  'שיפר': 'guest',
  'גיא לוי': 'guest',
  'פאשה': 'guest',
  'אבי קיגל': 'guest',
  'אבי קוגל': 'guest',
  'יגל': 'guest',
  'דויד': 'guest',
  'דידי': 'guest',
  'ליאור ס': 'guest',
  'רועי דויד': 'guest',
  'רועי דוד': 'guest',
  'קובי': 'guest',
  'קרני': 'guest',
  'מאור': 'guest',
  'אלרד': 'guest',
  'אלדד': 'guest',
  'יהודה': 'guest',
  'דן2 (שכן של ליאור)': 'guest',
  'דן 2 (שכן של)': 'guest',
  'גיא אשכנזי': 'guest',
  'צחי': 'guest',
  'סער': 'guest',
  'אריק': 'guest',
  'אבי אבני': 'guest',
  'אסף טישלר': 'guest',
  'אסף פישלר': 'guest',
  'אורי חבר של אבי': 'guest',
  'אורי חבר של': 'guest',
};

// Update player types
let updatedCount = 0;
syncData.players.forEach(player => {
  const correctType = playerTypes[player.name];
  if (correctType) {
    if (player.type !== correctType) {
      console.log(`Updating "${player.name}": ${player.type} -> ${correctType}`);
      player.type = correctType;
      updatedCount++;
    }
  } else {
    // Default to guest for any unknown players
    if (player.type !== 'guest') {
      console.log(`Unknown player "${player.name}" - setting to guest (was ${player.type})`);
      player.type = 'guest';
      updatedCount++;
    }
  }
});

// Update lastUpdated timestamp
syncData.lastUpdated = new Date().toISOString();

// Write back
fs.writeFileSync('public/sync-data.json', JSON.stringify(syncData, null, 2), 'utf8');

console.log(`\nDone! Updated ${updatedCount} player types.`);
console.log(`Total players: ${syncData.players.length}`);
console.log(`Total games: ${syncData.games.length}`);

// Summary
const permanent = syncData.players.filter(p => p.type === 'permanent');
const permanentGuest = syncData.players.filter(p => p.type === 'permanent_guest');
const guest = syncData.players.filter(p => p.type === 'guest');

console.log(`\nSummary:`);
console.log(`- permanent: ${permanent.length} (${permanent.map(p => p.name).join(', ')})`);
console.log(`- permanent_guest: ${permanentGuest.length} (${permanentGuest.map(p => p.name).join(', ')})`);
console.log(`- guest: ${guest.length}`);

