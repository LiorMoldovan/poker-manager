/**
 * Google Gemini AI Integration for Poker Forecasts
 * Free tier: 60 requests/minute
 * Get your API key at: https://aistudio.google.com/app/apikey
 */

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

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
  lastGameResults: { profit: number; date: string }[];
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
 * Generate AI-powered forecasts for all players
 */
export const generateAIForecasts = async (
  players: PlayerForecastData[]
): Promise<ForecastResult[]> => {
  const apiKey = getGeminiApiKey();
  
  if (!apiKey) {
    throw new Error('NO_API_KEY');
  }

  // Build the prompt with ALL player data
  const playerDataText = players.map((p, i) => {
    const streakText = p.currentStreak > 0 
      ? `רצף נצחונות: ${p.currentStreak}` 
      : p.currentStreak < 0 
        ? `רצף הפסדים: ${Math.abs(p.currentStreak)}` 
        : 'ללא רצף';
    
    const recentGamesText = p.lastGameResults.length > 0
      ? p.lastGameResults.map(g => `${g.profit >= 0 ? '+' : ''}${g.profit}₪`).join(', ')
      : 'אין משחקים אחרונים';
    
    const activityText = !p.isActive && p.daysSinceLastGame > 60
      ? `⚠️ לא שיחק ${Math.floor(p.daysSinceLastGame / 30)} חודשים!`
      : '';

    return `
שחקן ${i + 1}: ${p.name} ${p.isFemale ? '(נקבה)' : '(זכר)'}
- משחקים: ${p.gamesPlayed}
- רווח כולל: ${p.totalProfit >= 0 ? '+' : ''}${p.totalProfit}₪
- ממוצע למשחק: ${p.avgProfit >= 0 ? '+' : ''}${Math.round(p.avgProfit)}₪
- נצחונות: ${p.winCount} (${Math.round(p.winPercentage)}%)
- הפסדים: ${p.lossCount}
- ${streakText}
- נצחון גדול: +${p.bestWin}₪
- הפסד גדול: -${Math.abs(p.worstLoss)}₪
- 10 משחקים אחרונים: ${recentGamesText}
${activityText}`;
  }).join('\n---\n');

  const prompt = `אתה מנתח פוקר מקצועי וקצת ציני. אתה צריך לכתוב תחזית למשחק הפוקר הקרוב.

הנה הנתונים של השחקנים שישתתפו הערב:
${playerDataText}

בבקשה צור תחזית לכל שחקן בפורמט JSON הבא:
[
  {
    "name": "שם השחקן",
    "expectedProfit": מספר (הערכת רווח/הפסד צפוי בשקלים, חייב להיות מספר שלם),
    "highlight": "משפט קצר עם נתונים מעניינים על השחקן (עד 15 מילים)",
    "sentence": "משפט ארוך, יצירתי, מצחיק או ציני על התחזית לשחקן הזה (30-50 מילים). תהיה דרמטי, סרקסטי לפעמים, ותן ערך אמיתי. אם השחקן לא שיחק הרבה זמן - תהיה ציני על זה!",
    "isSurprise": true/false (האם זו תחזית מפתיעה שנגד הסטטיסטיקה)
  }
]

כללים חשובים:
1. השתמש בעברית תקינה עם נטיות מגדר נכונות (זכר/נקבה לפי הסימון)
2. סכום כל ה-expectedProfit חייב להיות 0 (משחק סכום אפס!)
3. תהיה יצירתי, מצחיק, וציני - אבל גם מבוסס על הנתונים
4. אם שחקן לא שיחק הרבה זמן (יותר מ-3 חודשים) - תהיה סרקסטי על זה
5. התייחס לרצפים, מגמות, ושינויים בביצועים
6. כל highlight ו-sentence חייב להיות ייחודי לשחקן
7. תן הערכות רווח/הפסד ריאליסטיות (בדרך כלל בין -100 ל +100)

החזר רק את ה-JSON, בלי טקסט נוסף.`;

  try {
    const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }]
        }],
        generationConfig: {
          temperature: 0.9, // More creative
          topK: 40,
          topP: 0.95,
          maxOutputTokens: 2048,
        }
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('Gemini API error:', errorData);
      throw new Error(`API_ERROR: ${response.status}`);
    }

    const data = await response.json();
    
    // Extract the text from Gemini response
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!text) {
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
      // Adjust the first player to make it zero-sum
      forecasts[0].expectedProfit -= total;
    }

    return forecasts;

  } catch (error) {
    console.error('Gemini AI error:', error);
    throw error;
  }
};

/**
 * Test if the API key is valid
 */
export const testGeminiApiKey = async (apiKey: string): Promise<boolean> => {
  try {
    const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: 'Say "OK" in one word.' }]
        }],
        generationConfig: {
          maxOutputTokens: 10,
        }
      })
    });

    return response.ok;
  } catch {
    return false;
  }
};

