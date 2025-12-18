/**
 * Google Gemini AI Integration for Poker Forecasts
 * Free tier: 15 requests/minute (gemini-1.5-flash)
 * Get your API key at: https://aistudio.google.com/app/apikey
 */

// API versions and models to try
const API_CONFIGS = [
  // v1beta with various models
  { version: 'v1beta', model: 'gemini-1.5-flash' },
  { version: 'v1beta', model: 'gemini-1.5-pro' },
  { version: 'v1beta', model: 'gemini-pro' },
  // v1 with various models
  { version: 'v1', model: 'gemini-1.5-flash' },
  { version: 'v1', model: 'gemini-1.5-pro' },
  { version: 'v1', model: 'gemini-pro' },
  // Older models
  { version: 'v1beta', model: 'models/gemini-pro' },
  { version: 'v1', model: 'models/gemini-pro' },
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
  // All game results with dates (most recent first)
  gameHistory: { profit: number; date: string }[];
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

  const prompt = `אתה מנתח פוקר מקצועי, חכם, מצחיק, וציני. עליך לכתוב תחזית מושקעת למשחק הפוקר הקרוב.

🎯 הנתונים המלאים של השחקנים שישתתפו הערב:
${playerDataText}

========================================

📝 צור תחזית לכל שחקן בפורמט JSON הבא:
[
  {
    "name": "שם השחקן בדיוק כפי שניתן",
    "expectedProfit": מספר שלם (הערכה של רווח או הפסד צפוי בשקלים),
    "highlight": "הסבר קצר (עד 15 מילים) שמסביר למה נתת את התחזית הזו - ציין נתונים ספציפיים מההיסטוריה",
    "sentence": "משפט יצירתי, מצחיק, דרמטי או ציני (30-50 מילים) שמתייחס לתחזית ולשחקן הספציפי",
    "isSurprise": true/false (האם התחזית הולכת נגד הסטטיסטיקה ההיסטורית)
  }
]

⚠️ כללים קריטיים - חובה לעקוב!

1. סכום אפס: סכום כל ה-expectedProfit חייב להיות בדיוק 0! (מה שאחד מרוויח, השני מפסיד)

2. משקל למשחקים אחרונים: תן משקל גבוה יותר לביצועים האחרונים! אם שחקן היסטורית מפסיד אבל במשחקים האחרונים מנצח - זה חשוב. ולהיפך.

3. ה-highlight חייב להסביר את הסיבה לתחזית:
   - ציין נתונים ספציפיים (אחוזי ניצחון, ממוצע, רצפים)
   - אם התחזית מבוססת על המשחקים האחרונים - ציין את זה
   - אם היא נגד ההיסטוריה - הסבר למה

4. ה-sentence צריך להיות:
   - יצירתי, מצחיק, דרמטי או ציני
   - קשור ספציפית לתחזית ולשחקן
   - אם התחזית נגד ההיסטוריה - ציין את זה! ("למרות ש...", "בניגוד ל...")

5. נטיות מגדר נכונות!
   - לנקבה: חוזרת, שלה, היא, יכולה, הפסידה, ניצחה
   - לזכר: חוזר, שלו, הוא, יכול, הפסיד, ניצח

6. חפש דפוסים מעניינים בהיסטוריה:
   - שחקן שלא הגיע הרבה זמן? תהיה ציני על זה!
   - פערים בין משחקים? ציין את זה
   - שינוי מגמה (מנצח שהתחיל להפסיד או להיפך)? חשוב!
   - רצפים ארוכים? ציין

7. הערכות רווח ריאליסטיות לפי ההיסטוריה של כל שחקן:
   - התבסס על הטווח ההיסטורי של השחקן (בין ההפסד הגדול לנצחון הגדול שלו)
   - שחקן עם ממוצע גבוה יכול לקבל תחזית גבוהה יותר
   - שחקן עם תנודתיות גבוהה (הפסדים ונצחונות גדולים) - הערכה יכולה להיות קיצונית יותר
   - שחקן עם תנודתיות נמוכה - הערכה צריכה להיות מתונה יותר

8. כל שחקן צריך highlight ו-sentence ייחודיים לחלוטין!

החזר רק JSON תקין, בלי שום טקסט נוסף לפני או אחרי.`;

  try {
    const config = getWorkingConfig();
    const modelPath = config.model.startsWith('models/') ? config.model : `models/${config.model}`;
    const url = `https://generativelanguage.googleapis.com/${config.version}/${modelPath}:generateContent?key=${apiKey}`;
    console.log(`Using: ${config.version}/${config.model}`);
    
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
          temperature: 0.9,
          topK: 40,
          topP: 0.95,
          maxOutputTokens: 2048,
        }
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('Gemini API error:', response.status, errorData);
      throw new Error(`API_ERROR: ${response.status}`);
    }

    const data = await response.json();
    
    // Extract the text from Gemini response
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!text) {
      console.error('Empty Gemini response:', data);
      throw new Error('EMPTY_RESPONSE');
    }

    // Parse JSON from response (handle markdown code blocks)
    let jsonText = text;
    if (text.includes('```json')) {
      jsonText = text.split('```json')[1].split('```')[0];
    } else if (text.includes('```')) {
      jsonText = text.split('```')[1].split('```')[0];
    }

    const forecasts: ForecastResult[] = JSON.parse(jsonText.trim());
    
    // Validate and ensure zero-sum
    let total = forecasts.reduce((sum, f) => sum + f.expectedProfit, 0);
    if (total !== 0 && forecasts.length > 0) {
      // Distribute the difference across all players
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

  } catch (error) {
    console.error('Gemini AI error:', error);
    throw error;
  }
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
  console.log('🔑 Testing Gemini API key...');
  console.log('Key format check:', apiKey.startsWith('AIza') ? '✅ Starts with AIza' : '⚠️ Unusual format');
  
  // First, list available models
  const availableModels = await listAvailableModels(apiKey);
  
  if (availableModels.length > 0) {
    console.log('✅ API key has access to models. Now testing generateContent...');
  } else {
    console.log('⚠️ Could not list models. This might mean:');
    console.log('   1. API key is invalid');
    console.log('   2. Generative Language API not enabled in Google Cloud Console');
    console.log('   3. API key has IP or referrer restrictions');
    console.log('');
    console.log('💡 Try creating a NEW key at: https://aistudio.google.com/app/apikey');
    console.log('   Make sure to use "Create API key in new project" option');
  }
  
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
