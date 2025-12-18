/**
 * Google Gemini AI Integration for Poker Forecasts
 * Free tier: 15 requests/minute (gemini-1.5-flash)
 * Get your API key at: https://aistudio.google.com/app/apikey
 */

// Use the free Gemini Flash model
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent';

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
      ? `רצף נצחונות: ${p.currentStreak}` 
      : p.currentStreak < 0 
        ? `רצף הפסדים: ${Math.abs(p.currentStreak)}` 
        : 'ללא רצף';
    
    // Format all game history
    const gameHistoryText = p.gameHistory.length > 0
      ? p.gameHistory.map(g => `${g.date}: ${g.profit >= 0 ? '+' : ''}${g.profit}₪`).join(' | ')
      : 'שחקן חדש - אין היסטוריה';
    
    const activityText = !p.isActive && p.daysSinceLastGame > 60
      ? `⚠️ לא שיחק ${Math.floor(p.daysSinceLastGame / 30)} חודשים! תהיה ציני על זה!`
      : '';

    return `
שחקן ${i + 1}: ${p.name} ${p.isFemale ? '(נקבה - השתמש בנטיות נקבה!)' : '(זכר)'}
- סה"כ משחקים: ${p.gamesPlayed}
- רווח כולל: ${p.totalProfit >= 0 ? '+' : ''}${p.totalProfit}₪
- ממוצע למשחק: ${p.avgProfit >= 0 ? '+' : ''}${Math.round(p.avgProfit)}₪
- נצחונות: ${p.winCount} (${Math.round(p.winPercentage)}%)
- הפסדים: ${p.lossCount}
- ${streakText}
- נצחון הכי גדול: +${p.bestWin}₪
- הפסד הכי גדול: -${Math.abs(p.worstLoss)}₪
- היסטוריית משחקים: ${gameHistoryText}
${activityText}`;
  }).join('\n---\n');

  const prompt = `אתה מנתח פוקר מקצועי, מצחיק, וקצת ציני. אתה צריך לכתוב תחזית למשחק הפוקר הקרוב.

הנה הנתונים המלאים של השחקנים שישתתפו הערב:
${playerDataText}

צור תחזית לכל שחקן בפורמט JSON הבא:
[
  {
    "name": "שם השחקן בדיוק כפי שניתן",
    "expectedProfit": מספר שלם (הערכת רווח/הפסד צפוי בשקלים),
    "highlight": "משפט קצר עם נתון מעניין ספציפי לשחקן הזה (עד 12 מילים)",
    "sentence": "משפט ארוך, יצירתי, מצחיק וציני על התחזית (25-40 מילים). תהיה דרמטי!",
    "isSurprise": true/false (האם זו תחזית מפתיעה נגד הסטטיסטיקה)
  }
]

כללים קריטיים:
1. סכום כל ה-expectedProfit חייב להיות בדיוק 0! (זה משחק סכום אפס)
2. נטיות מגדר נכונות! לנקבה: חוזרת, שלה, היא, יכולה. לזכר: חוזר, שלו, הוא, יכול
3. אם שחקן לא שיחק יותר מ-3 חודשים - תהיה מאוד ציני וסרקסטי על זה!
4. כל highlight ו-sentence חייב להיות שונה לחלוטין בין השחקנים
5. התבסס על הנתונים האמיתיים - ציין מספרים ספציפיים
6. תן הערכות רווח ריאליסטיות (בדרך כלל בין -80 ל +80)
7. תהיה מצחיק ומעניין!

החזר רק JSON תקין, בלי טקסט נוסף.`;

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
          parts: [{ text: 'Reply with just: OK' }]
        }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 5,
        }
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('API key test failed:', response.status, errorData);
      return false;
    }

    return true;
  } catch (error) {
    console.error('API key test error:', error);
    return false;
  }
};
