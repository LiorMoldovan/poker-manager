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
            `${winner} vs ${loser}: ב-${sharedGames.length} משחקים משותפים, ` +
            `${winner} ממוצע ${winnerAvg >= 0 ? '+' : ''}${winnerAvg}₪, ` +
            `${loser} ממוצע ${loserAvg >= 0 ? '+' : ''}${loserAvg}₪`
          );
        }
      }
    }
  }

  // Build the prompt with FULL player data
  const playerDataText = players.map((p, i) => {
    const streakText = p.currentStreak > 0 
      ? `רצף נצחונות נוכחי: ${p.currentStreak}` 
      : p.currentStreak < 0 
        ? `רצף הפסדים נוכחי: ${Math.abs(p.currentStreak)}` 
        : 'ללא רצף';
    
    // Format all game history (most recent first)
    const gameHistoryText = p.gameHistory.length > 0
      ? p.gameHistory.map(g => `${g.date}: ${g.profit >= 0 ? '+' : ''}${g.profit}₪`).join(' | ')
      : 'שחקן חדש - אין היסטוריה';
    
    // Calculate days since last game info
    const lastGameInfo = p.daysSinceLastGame < 999 
      ? `ימים מאז משחק אחרון: ${p.daysSinceLastGame}` 
      : '';

    return `
שחקן ${i + 1}: ${p.name} ${p.isFemale ? '(נקבה - חובה להשתמש בנטיות נקבה!)' : '(זכר)'}
📊 סטטיסטיקות כלליות:
- סה"כ משחקים: ${p.gamesPlayed}
- רווח כולל: ${p.totalProfit >= 0 ? '+' : ''}${p.totalProfit}₪
- ממוצע למשחק: ${p.avgProfit >= 0 ? '+' : ''}${Math.round(p.avgProfit)}₪
- נצחונות: ${p.winCount} (${Math.round(p.winPercentage)}%)
- הפסדים: ${p.lossCount}
- ${streakText}
- נצחון הכי גדול: +${p.bestWin}₪
- הפסד הכי גדול: -${Math.abs(p.worstLoss)}₪
${lastGameInfo ? `- ${lastGameInfo}` : ''}

📅 היסטוריית משחקים (מהאחרון לראשון):
${gameHistoryText}`;
  }).join('\n\n========================================\n');

  // Add timestamp to encourage different responses each time
  const timestamp = new Date().toLocaleString('he-IL');
  const randomSeed = Math.floor(Math.random() * 10000);
  
  const prompt = `אתה פרשן ספורט אגדי שעכשיו מנתח פוקר. הסגנון שלך: תובנות חדות, הומור עדין, וניתוח שגורם לשחקנים להרגיש שמישהו באמת מבין אותם.

🎲 מזהה: ${randomSeed} | ${timestamp}

═══════════════════════════════════════
📊 הנתונים המלאים:
${playerDataText}
${playerDynamics.length > 0 ? `
🔥 דינמיקות מעניינות:
${playerDynamics.join('\n')}` : ''}
═══════════════════════════════════════

📝 פורמט תשובה (JSON בלבד):
[{"name":"שם","expectedProfit":מספר,"highlight":"סיבה קצרה","sentence":"משפט יצירתי","isSurprise":true/false}]

═══════════════════════════════════════

🎯 דוגמאות - ההבדל בין משעמם למעולה:

❌ משעמם: "ליאור משחק טוב לאחרונה וצפוי להמשיך כך"
✅ מעולה: "מאז נובמבר ליאור ברצף שקט של 4 נצחונות, ממוצע +87₪. הוא מתקרב בזהירות לאלף הראשון - האם הציפיות לא ימוטטו אותו דווקא הלילה?"

❌ משעמם: "אייל הפסיד בזמן האחרון אז כנראה יפסיד שוב"
✅ מעולה: "אייל נמצא ב-3 הפסדים רצופים עם ממוצע -65₪, אבל מי שמכיר אותו יודע - הפניקס הזה תמיד מתעורר אחרי נפילה. השאלה: האם הלילה הוא הלילה?"

❌ משעמם: "סגל שחקן יציב עם ממוצע טוב"
✅ מעולה: "סגל הוא האיש שאף פעם לא מרוויח ולא מפסיד הרבה - ממוצע +12₪ ב-15 משחקים אחרונים. יציבות שכזו היא או שעמום מוחלט, או גאונות מוסווית."

═══════════════════════════════════════

🧠 זהה את הטיפוס של כל שחקן:
• הקונסיסטנטי - תמיד סביב הממוצע, אין הפתעות
• הרוסיה-רולטה - או +200 או -150, אין אמצע
• הפניקס - תמיד חוזר חזק אחרי הפסד גדול
• הצייד - מצוין נגד שחקנים ספציפיים
• הנעלם - לא הגיע הרבה זמן, חזר עכשיו
• העולה - השתפר לאחרונה לעומת העבר

═══════════════════════════════════════

⚡ 5 הכללים היחידים:

1. סכום אפס - כל ה-expectedProfit ביחד = 0 בדיוק!

2. highlight (עד 12 מילים) - הנתון שהוביל להחלטה:
   "4 נצחונות רצופים מאז נובמבר"
   "הפסיד ל-X ב-6 מתוך 7 פעמים"
   "ממוצע +95₪ ב-5 משחקים אחרונים"

3. sentence (25-35 מילים) - המשפט שישתפו בקבוצה:
   • לפני שתכתוב, שאל: "האם השחקן ירצה לשלוח את זה לחברים?"
   • חובה: לפחות מספר אחד מהנתונים
   • חובה: סגנון שונה לכל שחקן (ציני/דרמטי/פילוסופי/מעודד)
   • אסור: משפטים גנריים שמתאימים לכולם

4. isSurprise = true רק כשהתחזית הולכת נגד ההיסטוריה

5. מגדר: מור = נקבה. כל השאר = זכר.

═══════════════════════════════════════

🏆 מה הופך תחזית לבלתי נשכחת:
• תאריכים ספציפיים: "מאז 15/11..."
• השוואות: "בניגוד לספטמבר..."
• אבני דרך: "אם ינצח, יעבור את ה-1000₪ כולל"
• יריבויות: "נגד X הוא 2 מתוך 7"
• מגמות: "משהו השתנה ב-3 משחקים אחרונים"
• חזרות: "לא ראינו אותו 3 חודשים"

═══════════════════════════════════════

🚫 מה לא לעשות:
• לא לחזור על אותו סגנון לשני שחקנים
• לא משפטים ריקים בלי מספרים
• לא לפגוע או לזלזל

המטרה: תחזית שהשחקנים יקראו, יצחקו, יתווכחו, וישתפו!

החזר JSON בלבד.`;

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