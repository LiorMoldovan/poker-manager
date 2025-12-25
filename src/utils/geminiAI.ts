/**
 * Google Gemini AI Integration for Poker Forecasts
 * Free tier: 15 requests/minute (gemini-1.5-flash)
 * Get your API key at: https://aistudio.google.com/app/apikey
 */

// API versions and models to try (based on actual available models Dec 2024)
// Ordered by free tier quota (lite models have higher limits)
const API_CONFIGS = [
  // Lite models first (higher free tier limits)
  { version: 'v1beta', model: 'gemini-2.0-flash-lite' },
  { version: 'v1beta', model: 'gemini-2.5-flash-lite' },
  // Then regular flash models
  { version: 'v1beta', model: 'gemini-2.0-flash' },
  { version: 'v1beta', model: 'gemini-2.5-flash' },
  // Specific versions as fallback
  { version: 'v1beta', model: 'gemini-2.0-flash-001' },
  { version: 'v1', model: 'gemini-2.0-flash' },
];

// Store API key in localStorage
const API_KEY_STORAGE = 'gemini_api_key';

export const getGeminiApiKey = (): string | null => {
  return localStorage.getItem(API_KEY_STORAGE);
};

export const setGeminiApiKey = (key: string): void => {
  localStorage.setItem(API_KEY_STORAGE, key);
};

export const clearGeminiApiKey = (): void => {
  localStorage.removeItem(API_KEY_STORAGE);
};

export interface PlayerForecastData {
  name: string;
  isFemale: boolean;
  gamesPlayed: number;
  totalProfit: number;
  avgProfit: number;
  winCount: number;
  lossCount: number;
  winPercentage: number;
  currentStreak: number; // positive = wins, negative = losses
  bestWin: number;
  worstLoss: number;
  // All game results with dates and game IDs (most recent first)
  gameHistory: { profit: number; date: string; gameId: string }[];
  daysSinceLastGame: number;
  isActive: boolean; // played in last 2 months
}

export interface ForecastResult {
  name: string;
  expectedProfit: number;
  highlight: string;
  sentence: string;
  isSurprise: boolean;
}

/**
 * Generate AI-powered forecasts for selected players only
 */
export const generateAIForecasts = async (
  players: PlayerForecastData[]
): Promise<ForecastResult[]> => {
  const apiKey = getGeminiApiKey();
  
  if (!apiKey) {
    throw new Error('NO_API_KEY');
  }

  // Analyze player dynamics - how players perform when playing together
  const playerDynamics: string[] = [];
  
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const p1 = players[i];
      const p2 = players[j];
      
      // Find games where both players participated
      const p1GameIds = new Set(p1.gameHistory.map(g => g.gameId));
      const sharedGames = p2.gameHistory.filter(g => p1GameIds.has(g.gameId));
      
      if (sharedGames.length >= 3) {
        // Calculate each player's performance in shared games
        const p1SharedGames = p1.gameHistory.filter(g => 
          sharedGames.some(sg => sg.gameId === g.gameId)
        );
        
        const p1Avg = p1SharedGames.reduce((sum, g) => sum + g.profit, 0) / p1SharedGames.length;
        const p2Avg = sharedGames.reduce((sum, g) => sum + g.profit, 0) / sharedGames.length;
        
        const p1Wins = p1SharedGames.filter(g => g.profit > 0).length;
        const p2Wins = sharedGames.filter(g => g.profit > 0).length;
        
        // Only add interesting dynamics
        if (Math.abs(p1Avg - p2Avg) > 20 || Math.abs(p1Wins - p2Wins) >= 2) {
          const winner = p1Avg > p2Avg ? p1.name : p2.name;
          const loser = p1Avg > p2Avg ? p2.name : p1.name;
          const winnerAvg = Math.round(Math.max(p1Avg, p2Avg));
          const loserAvg = Math.round(Math.min(p1Avg, p2Avg));
          
          playerDynamics.push(
            `${winner} vs ${loser}: In ${sharedGames.length} shared games, ` +
            `${winner} averages ${winnerAvg >= 0 ? '+' : ''}${winnerAvg}₪, ` +
            `${loser} averages ${loserAvg >= 0 ? '+' : ''}${loserAvg}₪`
          );
        }
      }
    }
  }

  // Calculate ALL-TIME RECORDS for the group
  const allTimeRecords: string[] = [];
  
  // Find record holders among tonight's players
  const sortedByTotalProfit = [...players].sort((a, b) => b.totalProfit - a.totalProfit);
  const sortedByBestWin = [...players].sort((a, b) => b.bestWin - a.bestWin);
  const sortedByWorstLoss = [...players].sort((a, b) => a.worstLoss - b.worstLoss);
  const sortedByWinRate = [...players].filter(p => p.gamesPlayed >= 5).sort((a, b) => b.winPercentage - a.winPercentage);
  const sortedByGames = [...players].sort((a, b) => b.gamesPlayed - a.gamesPlayed);
  const sortedByAvg = [...players].filter(p => p.gamesPlayed >= 3).sort((a, b) => b.avgProfit - a.avgProfit);
  
  // Highest all-time profit
  if (sortedByTotalProfit[0]?.totalProfit > 0) {
    allTimeRecords.push(`🥇 All-Time Profit Leader: ${sortedByTotalProfit[0].name} with +${sortedByTotalProfit[0].totalProfit}₪ total`);
  }
  
  // Biggest single-night win
  if (sortedByBestWin[0]?.bestWin > 0) {
    allTimeRecords.push(`💰 Biggest Single-Night Win: ${sortedByBestWin[0].name} once won +${sortedByBestWin[0].bestWin}₪`);
  }
  
  // Biggest single-night loss
  if (sortedByWorstLoss[0]?.worstLoss < 0) {
    allTimeRecords.push(`📉 Biggest Single-Night Loss: ${sortedByWorstLoss[0].name} once lost ${sortedByWorstLoss[0].worstLoss}₪`);
  }
  
  // Highest win rate (min 5 games)
  if (sortedByWinRate.length > 0) {
    allTimeRecords.push(`🎯 Best Win Rate: ${sortedByWinRate[0].name} wins ${Math.round(sortedByWinRate[0].winPercentage)}% of games (${sortedByWinRate[0].winCount}/${sortedByWinRate[0].gamesPlayed})`);
  }
  
  // Most games played
  if (sortedByGames[0]?.gamesPlayed > 0) {
    allTimeRecords.push(`🎮 Most Games Played: ${sortedByGames[0].name} with ${sortedByGames[0].gamesPlayed} games`);
  }
  
  // Best average (min 3 games)
  if (sortedByAvg.length > 0 && sortedByAvg[0].avgProfit > 0) {
    allTimeRecords.push(`📊 Best Average: ${sortedByAvg[0].name} averages +${Math.round(sortedByAvg[0].avgProfit)}₪ per game`);
  }
  
  // Longest current winning streak
  const longestWinStreak = players.reduce((max, p) => p.currentStreak > max.streak ? { name: p.name, streak: p.currentStreak } : max, { name: '', streak: 0 });
  if (longestWinStreak.streak >= 2) {
    allTimeRecords.push(`🔥 Current Hot Streak: ${longestWinStreak.name} is on a ${longestWinStreak.streak}-game winning streak`);
  }
  
  // Longest current losing streak
  const longestLoseStreak = players.reduce((max, p) => p.currentStreak < max.streak ? { name: p.name, streak: p.currentStreak } : max, { name: '', streak: 0 });
  if (longestLoseStreak.streak <= -2) {
    allTimeRecords.push(`❄️ Cold Streak: ${longestLoseStreak.name} is on a ${Math.abs(longestLoseStreak.streak)}-game losing streak`);
  }
  
  const allTimeRecordsText = allTimeRecords.join('\n');

  // Build the prompt with FULL player data (in English for better AI reasoning)
  const playerDataText = players.map((p, i) => {
    const streakText = p.currentStreak > 0 
      ? `Current Winning Streak: ${p.currentStreak} games` 
      : p.currentStreak < 0 
        ? `Current Losing Streak: ${Math.abs(p.currentStreak)} games` 
        : 'No streak';
    
    // Format all game history (most recent first)
    const gameHistoryText = p.gameHistory.length > 0
      ? p.gameHistory.map(g => `${g.date}: ${g.profit >= 0 ? '+' : ''}${g.profit}₪`).join(' | ')
      : 'New player - no history';
    
    // Calculate days since last game info
    const lastGameInfo = p.daysSinceLastGame < 999 
      ? `Days since last game: ${p.daysSinceLastGame}` 
      : '';

    return `
Player ${i + 1}: ${p.name} ${p.isFemale ? '(FEMALE - must use feminine Hebrew forms!)' : '(Male)'}
📊 Overall Statistics:
- Total Games: ${p.gamesPlayed}
- Total Profit: ${p.totalProfit >= 0 ? '+' : ''}${p.totalProfit}₪
- Average per Game: ${p.avgProfit >= 0 ? '+' : ''}${Math.round(p.avgProfit)}₪
- Wins: ${p.winCount} (${Math.round(p.winPercentage)}%)
- Losses: ${p.lossCount}
- ${streakText}
- Biggest Win: +${p.bestWin}₪
- Biggest Loss: ${p.worstLoss}₪
${lastGameInfo ? `- ${lastGameInfo}` : ''}

📅 Game History (most recent first):
${gameHistoryText}`;
  }).join('\n\n========================================\n');
  
  // Calculate realistic profit ranges from player data
  const allProfits = players.flatMap(p => p.gameHistory.map(g => g.profit));
  const maxProfit = allProfits.length > 0 ? Math.max(...allProfits) : 200;
  const minProfit = allProfits.length > 0 ? Math.min(...allProfits) : -200;
  const typicalRange = Math.max(Math.abs(maxProfit), Math.abs(minProfit));
  
  const prompt = `You are the "Master of Poker Analytics," a legendary sports commentator turned data scientist. Your job is to analyze the game history and all-time records of a private poker group to generate a sharp, humorous, and data-driven prediction for tonight's game.

📊 RAW PLAYER DATA:
${playerDataText}

🏆 ALL-TIME RECORDS:
${allTimeRecordsText}
${playerDynamics.length > 0 ? `
🔥 TABLE DYNAMICS & RIVALRIES:
${playerDynamics.join('\n')}` : ''}

═══════════════════════════════════════

🎯 THE MISSION:
For each player, calculate an "Expected Profit" (the sum of all expectedProfits must equal exactly 0). Cross-reference their current form with their Legacy to create a unique narrative.

═══════════════════════════════════════

💰 REALISTIC PROFIT RANGES (CRITICAL!):

Based on this group's ACTUAL game history:
- Typical winning range: +50₪ to +${Math.round(typicalRange * 0.7)}₪
- Typical losing range: -50₪ to -${Math.round(typicalRange * 0.7)}₪
- Big nights (rare): up to ±${typicalRange}₪

DO NOT use tiny amounts like ±10₪ or ±20₪ - those are unrealistic for this group!
Look at each player's Biggest Win and Biggest Loss to calibrate their personal range.

═══════════════════════════════════════

🛠️ WRITING RULES (CRITICAL):

1. **The Legacy Factor**: Use all-time records to praise or sting.

2. **Data-Backed Insights**: Use specific dates, percentages, and amounts. 
   Instead of "He's doing well," say "Since his 120₪ loss on Nov 14th, he has maintained a 65% win rate."

3. **The "Nemesis" Angle**: If Player A loses when Player B is present, highlight the rivalry.

4. **Style & Tone**: Witty, slightly cynical, dramatic. Each sentence should be screenshot-worthy for WhatsApp.

5. **Language**: Output (highlight and sentence) MUST be in HEBREW.

═══════════════════════════════════════

🎭 SPECIAL PLAYER HANDLING:

• **תומר (Tomer)**: Be GENTLE and OPTIMISTIC with him! Even if his stats aren't great, find something encouraging. Focus on potential, recent improvements, or highlight when he beat strong players. Never mock him - keep him hopeful!

═══════════════════════════════════════

🚫 ABSOLUTELY NO REPETITION:

Each player MUST have a COMPLETELY DIFFERENT:
- Sentence structure (don't start multiple sentences the same way)
- Narrative angle (streaks, rivalries, milestones, comebacks, consistency, volatility - use DIFFERENT angles)
- Writing style (dramatic for one, analytical for another, philosophical for a third)

If you find yourself writing similar sentences, STOP and rewrite with a fresh angle!

═══════════════════════════════════════

📝 OUTPUT FORMAT (JSON ONLY):
[
  {
    "name": "Player Name",
    "expectedProfit": number (REALISTIC based on their historical range!),
    "highlight": "Short data-driven stat in Hebrew (up to 10 words)",
    "sentence": "Unique analysis in Hebrew (25-40 words) - must include a specific number",
    "isSurprise": boolean
  }
]

═══════════════════════════════════════

💡 EXAMPLES OF QUALITY (HEBREW OUTPUT):

✅ "מאז ה-12/03, יובל נמצא בצניחה חופשית, אבל אל תשכחו שהוא עדיין מלך הקאמבקים עם שיא של מעבר מהפסד לניצחון הכי גבוה בהיסטוריה. הלילה הוא נלחם על הכבוד."

✅ "אביב רחוק משחק אחד בלבד מהשוואת שיא ההפסדים הרצופים של הקבוצה (5). הלחץ בשולחן הלילה יכריע - האם הוא ירשום היסטוריה שלילית או יקטע את הרצף?"

✅ "סגל הוא הבנק של הקבוצה - ממוצע +8₪ ב-20 משחקים. לא מרוויח גדול, לא מפסיד גדול. גאונות משעממת או שעמום גאוני?"

═══════════════════════════════════════

⚠️ CONSTRAINTS:

• Gender: 'מור' is Female (נקבה). All others are Male (זכר).

• Math: Sum of all expectedProfit = 0 exactly.

• isSurprise = true ONLY when prediction goes AGAINST their historical pattern.

• Calibrate expectedProfit to each player's ACTUAL historical range - not arbitrary small numbers!

═══════════════════════════════════════

Return ONLY a clean JSON array. No markdown, no explanation.`;

  console.log('🤖 AI Forecast Request for:', players.map(p => p.name).join(', '));
  
  // Try each model until one works
  for (const config of API_CONFIGS) {
    const modelPath = config.model.startsWith('models/') ? config.model : `models/${config.model}`;
    const url = `https://generativelanguage.googleapis.com/${config.version}/${modelPath}:generateContent?key=${apiKey}`;
    
    console.log(`   Trying: ${config.version}/${config.model}...`);
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: prompt }]
          }],
          generationConfig: {
            temperature: 0.75,  // Balanced: creative but data-focused
            topK: 40,
            topP: 0.9,
            maxOutputTokens: 2048,
          }
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData?.error?.message || `Status ${response.status}`;
        console.log(`   ❌ ${config.model}: ${errorMsg}`);
        
        // If rate limited or not found, try next model
        if (response.status === 429 || response.status === 404) {
          continue; // Try next model
        }
        throw new Error(`API_ERROR: ${response.status} - ${errorMsg}`);
      }
      
      // Success! Save this working model
      console.log(`   ✅ ${config.model} responded!`);
      localStorage.setItem('gemini_working_config', JSON.stringify(config));

      const data = await response.json();
      
      // Extract the text from Gemini response
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      
      if (!text) {
        console.error('❌ Empty response from', config.model);
        if (data.candidates?.[0]?.finishReason === 'SAFETY') {
          continue; // Try next model
        }
        continue; // Try next model
      }

      console.log('📝 AI response received, parsing...');

      // Parse JSON from response (handle markdown code blocks)
      let jsonText = text;
      if (text.includes('```json')) {
        jsonText = text.split('```json')[1].split('```')[0];
      } else if (text.includes('```')) {
        jsonText = text.split('```')[1].split('```')[0];
      }

      let forecasts: ForecastResult[];
      try {
        forecasts = JSON.parse(jsonText.trim());
        console.log('✅ Parsed', forecasts.length, 'forecasts');
      } catch (parseError) {
        console.error('❌ JSON parse error, trying next model');
        continue; // Try next model
      }
      
      // Validate and ensure zero-sum
      let total = forecasts.reduce((sum, f) => sum + f.expectedProfit, 0);
      if (total !== 0 && forecasts.length > 0) {
        const adjustment = Math.round(total / forecasts.length);
        forecasts.forEach((f, i) => {
          if (i === 0) {
            f.expectedProfit -= (total - adjustment * (forecasts.length - 1));
          } else {
            f.expectedProfit -= adjustment;
          }
        });
      }

      return forecasts;
      
    } catch (fetchError) {
      console.log(`   ❌ ${config.model} fetch error:`, fetchError);
      continue; // Try next model
    }
  }
  
  // All models failed
  console.error('❌ All AI models failed');
  throw new Error('All AI models are rate limited or unavailable. Try again in a few minutes.');
};

// Store working config
let workingConfig: { version: string; model: string } | null = null;

/**
 * First, try to list available models to diagnose the issue
 */
const listAvailableModels = async (apiKey: string): Promise<string[]> => {
  const models: string[] = [];
  
  for (const version of ['v1beta', 'v1']) {
    try {
      const url = `https://generativelanguage.googleapis.com/${version}/models?key=${apiKey}`;
      console.log(`📋 Listing models with ${version}...`);
      
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        const foundModels = data.models?.map((m: {name: string}) => `${version}: ${m.name}`) || [];
        console.log(`Found ${foundModels.length} models with ${version}:`, foundModels);
        models.push(...foundModels);
      } else {
        const err = await response.json().catch(() => ({}));
        console.log(`${version} list failed:`, err?.error?.message || response.status);
      }
    } catch (e) {
      console.log(`${version} list error:`, e);
    }
  }
  
  return models;
};

/**
 * Test if the API key is valid - tries multiple configs
 */
export const testGeminiApiKey = async (apiKey: string): Promise<boolean> => {
  console.log('═══════════════════════════════════════');
  console.log('🔑 GEMINI API KEY TEST');
  console.log('═══════════════════════════════════════');
  console.log('Key length:', apiKey.length);
  console.log('Key prefix:', apiKey.substring(0, 10) + '...');
  console.log('Format check:', apiKey.startsWith('AIza') ? '✅ Correct (AIza...)' : '⚠️ Unusual format!');
  console.log('');
  
  // First, list available models
  console.log('📋 STEP 1: Listing available models...');
  const availableModels = await listAvailableModels(apiKey);
  
  if (availableModels.length > 0) {
    console.log(`✅ Found ${availableModels.length} models! Key is valid.`);
    console.log('');
  } else {
    console.log('');
    console.log('❌ CANNOT LIST MODELS - Key may be invalid or restricted');
    console.log('');
    console.log('🔧 POSSIBLE CAUSES:');
    console.log('   1. API key is invalid or expired');
    console.log('   2. Key was created in Google Cloud Console (need AI Studio key)');
    console.log('   3. Generative Language API not enabled');
    console.log('   4. API key has IP/referrer restrictions');
    console.log('');
    console.log('💡 SOLUTION: Create a NEW key at Google AI Studio:');
    console.log('   https://aistudio.google.com/app/apikey');
    console.log('   → Click "Create API key"');
    console.log('   → Select "Create API key in new project"');
    console.log('');
  }
  
  console.log('🧪 STEP 2: Testing generateContent with each model...');
  
  // Try all configs
  for (const config of API_CONFIGS) {
    const modelPath = config.model.startsWith('models/') ? config.model : `models/${config.model}`;
    const url = `https://generativelanguage.googleapis.com/${config.version}/${modelPath}:generateContent?key=${apiKey}`;
    
    console.log(`\n🧪 Trying ${config.version} / ${config.model}...`);
    
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Say: OK' }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 5 }
        })
      });

      if (response.ok) {
        workingConfig = config;
        console.log(`✅ SUCCESS! ${config.version}/${config.model} works!`);
        localStorage.setItem('gemini_working_config', JSON.stringify(config));
        return true;
      }
      
      const errorData = await response.json().catch(() => ({}));
      const errorMsg = errorData?.error?.message || `Status ${response.status}`;
      
      // 429 = rate limited but key is valid! Save config and return success
      if (response.status === 429) {
        workingConfig = config;
        console.log(`⚠️ ${config.version}/${config.model}: Rate limited but KEY IS VALID!`);
        console.log('   Wait a minute and try the forecast again.');
        localStorage.setItem('gemini_working_config', JSON.stringify(config));
        return true; // Key works, just rate limited
      }
      
      console.log(`❌ ${config.version}/${config.model}: ${errorMsg}`);
      
    } catch (error) {
      console.log(`❌ ${config.version}/${config.model} error:`, error);
    }
  }
  
  console.error('\n❌ All configurations failed.');
  console.log('\n💡 TROUBLESHOOTING:');
  console.log('1. Go to: https://aistudio.google.com/app/apikey');
  console.log('2. Delete existing API key');
  console.log('3. Click "Create API key" → "Create API key in new project"');
  console.log('4. Copy the new key and try again');
  
  return false;
};

/**
 * Get the working config
 */
const getWorkingConfig = (): { version: string; model: string } => {
  if (workingConfig) return workingConfig;
  
  const saved = localStorage.getItem('gemini_working_config');
  if (saved) {
    try {
      workingConfig = JSON.parse(saved);
      return workingConfig!;
    } catch {}
  }
  
  return API_CONFIGS[0]; // Default to first
};

/**
 * Generate a short comment comparing forecast to actual results
 */
export const generateForecastComparison = async (
  forecasts: { playerName: string; expectedProfit: number }[],
  actualResults: { playerName: string; profit: number }[]
): Promise<string> => {
  const apiKey = getGeminiApiKey();
  if (!apiKey) throw new Error('NO_API_KEY');

  // Build comparison data with gap-based accuracy
  const comparisons = forecasts.map(f => {
    const actual = actualResults.find(a => a.playerName === f.playerName);
    const actualProfit = actual?.profit || 0;
    const gap = Math.abs(actualProfit - f.expectedProfit);
    
    // Accuracy based on gap: ≤30 = accurate, 31-60 = close, >60 = missed
    let accuracyLevel: 'accurate' | 'close' | 'missed';
    if (gap <= 30) accuracyLevel = 'accurate';
    else if (gap <= 60) accuracyLevel = 'close';
    else accuracyLevel = 'missed';
    
    return {
      name: f.playerName,
      forecast: f.expectedProfit,
      actual: actualProfit,
      gap,
      accuracyLevel
    };
  });

  // Count accuracy levels
  const accurate = comparisons.filter(c => c.accuracyLevel === 'accurate').length;
  const close = comparisons.filter(c => c.accuracyLevel === 'close').length;
  const missed = comparisons.filter(c => c.accuracyLevel === 'missed').length;
  const total = comparisons.length;
  
  // Calculate overall score (accurate=2pts, close=1pt, missed=0pts)
  const score = (accurate * 2 + close * 1);
  const maxScore = total * 2;
  const scorePercent = Math.round((score / maxScore) * 100);
  
  // Determine rating
  let rating: string;
  if (scorePercent >= 80) rating = 'מעולה';
  else if (scorePercent >= 60) rating = 'טוב';
  else if (scorePercent >= 40) rating = 'סביר';
  else rating = 'חלש';
  
  // Find best and worst predictions
  const sortedByGap = [...comparisons].sort((a, b) => a.gap - b.gap);
  const bestPrediction = sortedByGap[0];
  const worstPrediction = sortedByGap[sortedByGap.length - 1];

  const prompt = `אתה מסכם תחזית פוקר בעברית. כתוב משפט סיכום קצר ורלוונטי (עד 25 מילים) על הצלחת התחזית.

נתונים:
- ציון כולל: ${score}/${maxScore} (${scorePercent}%) - ${rating}
- מדויק (פער ≤30): ${accurate}/${total}
- קרוב (פער 31-60): ${close}/${total}  
- החטאה (פער >60): ${missed}/${total}
- תחזית מדויקת ביותר: ${bestPrediction.name} (פער ${bestPrediction.gap})
- תחזית רחוקה ביותר: ${worstPrediction.name} (פער ${worstPrediction.gap})

כתוב משפט סיכום שכולל את הדירוג הכולל ("${rating}") ותובנה על התחזית. לא להיות מצחיק. כתוב רק את המשפט.`;

  const config = getWorkingConfig();
  
  const response = await fetch(
    `https://generativelanguage.googleapis.com/${config.version}/models/${config.model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 100,
        }
      })
    }
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.error?.message || `API error: ${response.status}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  
  return text.trim() || `${accurate} מדויקים, ${close} קרובים, ${missed} החטאות מתוך ${total} תחזיות`;
};