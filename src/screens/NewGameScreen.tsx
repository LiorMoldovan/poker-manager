import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import html2canvas from 'html2canvas';
import { Player, PlayerType, PlayerStats } from '../types';
import { getAllPlayers, addPlayer, createGame, getPlayerByName, getPlayerStats } from '../database/storage';
import { cleanNumber } from '../utils/calculations';
import { usePermissions } from '../App';
import { generateAIForecasts, getGeminiApiKey, PlayerForecastData, ForecastResult } from '../utils/geminiAI';

// Default location options
const LOCATION_OPTIONS = ['ליאור', 'סגל', 'ליכטר', 'אייל'];

const NewGameScreen = () => {
  const navigate = useNavigate();
  const { role } = usePermissions();
  const isAdmin = role === 'admin';
  const [players, setPlayers] = useState<Player[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showAddPlayer, setShowAddPlayer] = useState(false);
  const [newPlayerName, setNewPlayerName] = useState('');
  const [newPlayerType, setNewPlayerType] = useState<PlayerType>('guest');
  const [error, setError] = useState('');
  const [showPermanentGuests, setShowPermanentGuests] = useState(false);
  const [showGuests, setShowGuests] = useState(false);
  const [showForecast, setShowForecast] = useState(false);
  const [showSharePrompt, setShowSharePrompt] = useState(false);
  const [pendingGameId, setPendingGameId] = useState<string | null>(null);
  const [playerStats, setPlayerStats] = useState<PlayerStats[]>([]);
  const [gameLocation, setGameLocation] = useState<string>('');
  const [customLocation, setCustomLocation] = useState<string>('');
  const [isSharing, setIsSharing] = useState(false);
  const [cachedForecasts, setCachedForecasts] = useState<ReturnType<typeof generateForecasts> | null>(null);
  const [aiForecasts, setAiForecasts] = useState<ForecastResult[] | null>(null);
  const [isLoadingAI, setIsLoadingAI] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [retryCountdown, setRetryCountdown] = useState<number | null>(null);
  const forecastRef = useRef<HTMLDivElement>(null);
  const retryTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    loadPlayers();
    // Cleanup timer on unmount
    return () => {
      if (retryTimerRef.current) clearInterval(retryTimerRef.current);
    };
  }, []);

  const loadPlayers = () => {
    setPlayers(getAllPlayers());
    setPlayerStats(getPlayerStats());
  };

  // Separate players by type
  const permanentPlayers = players.filter(p => p.type === 'permanent');
  const permanentGuestPlayers = players.filter(p => p.type === 'permanent_guest');
  const guestPlayers = players.filter(p => p.type === 'guest');

  const togglePlayer = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };

  // Select/Deselect only permanent players (dynamically based on player.type === 'permanent')
  const selectAll = () => {
    // Get IDs of players with type 'permanent' only
    const permanentIds = new Set(permanentPlayers.map(p => p.id));
    const allPermanentSelected = permanentPlayers.length > 0 && 
      permanentPlayers.every(p => selectedIds.has(p.id));
    
    if (allPermanentSelected) {
      // All permanent are selected - deselect ONLY permanent players
      setSelectedIds(prev => {
        const newSet = new Set<string>();
        // Keep only non-permanent selections
        prev.forEach(id => {
          if (!permanentIds.has(id)) {
            newSet.add(id);
          }
        });
        return newSet;
      });
    } else {
      // Select ONLY permanent players (replace current selection)
      setSelectedIds(new Set(permanentPlayers.map(p => p.id)));
    }
  };

  const handleAddPlayer = () => {
    const trimmedName = newPlayerName.trim();
    if (!trimmedName) {
      setError('Please enter a name');
      return;
    }
    
    if (getPlayerByName(trimmedName)) {
      setError('Player already exists');
      return;
    }

    const newPlayer = addPlayer(trimmedName, newPlayerType);
    setPlayers([...players, newPlayer]);
    setSelectedIds(new Set([...selectedIds, newPlayer.id]));
    setNewPlayerName('');
    setNewPlayerType('guest');
    setShowAddPlayer(false);
    setError('');
    // Expand the relevant section when adding
    if (newPlayerType === 'guest') {
      setShowGuests(true);
    } else if (newPlayerType === 'permanent_guest') {
      setShowPermanentGuests(true);
    }
  };

  const handleStartGame = () => {
    if (selectedIds.size < 2) {
      setError('Select at least 2 players');
      return;
    }
    
    // Use custom location if "other" is selected, otherwise use selected location
    const location = gameLocation === 'other' ? customLocation.trim() : gameLocation;
    
    // Prepare forecasts to save with the game
    let forecastsToSave: { playerName: string; expectedProfit: number; sentence?: string }[] | undefined;
    
    if (aiForecasts && aiForecasts.length > 0) {
      forecastsToSave = aiForecasts.map(f => ({
        playerName: f.name,
        expectedProfit: f.expectedProfit,
        sentence: f.sentence
      }));
    } else if (cachedForecasts && cachedForecasts.length > 0) {
      forecastsToSave = cachedForecasts.map(f => ({
        playerName: f.player.name,
        expectedProfit: f.expected,
        sentence: f.sentence
      }));
    }
    
    const game = createGame(Array.from(selectedIds), location || undefined, forecastsToSave);
    
    // If we have forecasts, show prompt to share before starting
    if (forecastsToSave && forecastsToSave.length > 0) {
      setPendingGameId(game.id);
      setShowSharePrompt(true);
    } else {
      navigate(`/live-game/${game.id}`);
    }
  };
  
  const handleShareAndStart = async () => {
    await shareForecast();
    if (pendingGameId) {
      navigate(`/live-game/${pendingGameId}`);
    }
  };
  
  const handleSkipShare = () => {
    if (pendingGameId) {
      navigate(`/live-game/${pendingGameId}`);
    }
  };

  // Get stats for a player
  const getStatsForPlayer = (playerId: string): PlayerStats | undefined => {
    return playerStats.find(s => s.playerId === playerId);
  };

  // ============ SMART FORECAST SYSTEM WITH DYNAMIC HIGHLIGHTS ============
  
  // Female names list for correct Hebrew gender (only מור in this group)
  const FEMALE_NAMES = ['מור'];
  
  const isFemale = (name: string): boolean => {
    return FEMALE_NAMES.some(n => name === n || name.includes(n));
  };
  
  interface RecentAnalysis {
    recentWins: number;
    recentLosses: number;
    recentProfit: number;
    recentAvg: number;
    gamesCount: number;
    trend: 'hot' | 'cold' | 'improving' | 'declining' | 'stable';
    highlights: string;
    daysSinceLastGame: number;
    isActive: boolean; // played in last 2 months
  }
  
  // Calculate days since last game
  const getDaysSinceLastGame = (stats: PlayerStats): number => {
    const lastGames = stats.lastGameResults || [];
    if (lastGames.length === 0) return 999;
    
    const lastGameDate = lastGames[0]?.date;
    if (!lastGameDate) return 999;
    
    const lastDate = new Date(lastGameDate);
    const now = new Date();
    return Math.floor((now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24));
  };
  
  // Generate DYNAMIC personalized highlight based on ACTUAL recency
  const generateDynamicHighlight = (stats: PlayerStats, daysSince: number): string => {
    const lastGames = stats.lastGameResults || [];
    const gamesCount = lastGames.length;
    if (gamesCount === 0) return '';
    
    const recentWins = lastGames.filter(g => g.profit > 0).length;
    const recentLosses = lastGames.filter(g => g.profit < 0).length;
    const recentProfit = lastGames.reduce((sum, g) => sum + g.profit, 0);
    const recentAvg = Math.round(recentProfit / gamesCount);
    const overallAvg = Math.round(stats.avgProfit);
    const streak = stats.currentStreak;
    const winPct = Math.round(stats.winPercentage);
    const recentWinPct = Math.round((recentWins / gamesCount) * 100);
    const totalProfit = Math.round(stats.totalProfit);
    const totalGames = stats.gamesPlayed;
    
    // Find best and worst games
    const bestRecent = Math.max(...lastGames.map(g => g.profit));
    const worstRecent = Math.min(...lastGames.map(g => g.profit));
    
    // Determine time context
    const isActive = daysSince <= 60; // played in last 2 months
    const isRecent = daysSince <= 30; // played in last month
    const monthsAgo = Math.floor(daysSince / 30);
    
    // Collect all possible insights with CORRECT time context
    const insights: { priority: number; text: string }[] = [];
    
    // === ACTIVE PLAYERS (played recently) ===
    if (isActive) {
      // HOT STREAK
      if (streak >= 4) {
        insights.push({ priority: 100, text: `🔥 רצף מטורף של ${streak} נצחונות! השחקן הכי חם כרגע על השולחן` });
        insights.push({ priority: 98, text: `🔥 ${streak} נצחונות ברצף - מישהו צריך לעצור אותו לפני שהוא לוקח את כל הכסף` });
      } else if (streak >= 3) {
        insights.push({ priority: 95, text: `🔥 על גל חם עם ${streak} נצחונות רצופים - המומנטום לצידו` });
        insights.push({ priority: 93, text: `🔥 ${streak} נצחונות ברצף, והביטחון שלו בשמיים` });
      } else if (streak === 2) {
        insights.push({ priority: 60, text: `שני נצחונות רצופים - אולי תחילת רצף חם?` });
      }
      
      // COLD STREAK  
      if (streak <= -4) {
        insights.push({ priority: 100, text: `❄️ ${Math.abs(streak)} הפסדים ברצף - תקופה קשה, אבל כל רצף נשבר מתישהו` });
        insights.push({ priority: 98, text: `❄️ רצף של ${Math.abs(streak)} הפסדים. המזל חייב להשתנות, לא?` });
      } else if (streak <= -3) {
        insights.push({ priority: 95, text: `❄️ ${Math.abs(streak)} הפסדים רצופים - צריך שינוי מזל דחוף` });
      } else if (streak === -2) {
        insights.push({ priority: 60, text: `שני הפסדים אחרונים - הלילה ההזדמנות לשבור את הרצף` });
      }
      
      // IMPROVEMENT vs HISTORY (only if active)
      if (recentAvg > overallAvg + 30) {
        insights.push({ priority: 90, text: `📈 שיפור דרמטי! ממוצע של +${recentAvg}₪ במשחקים האחרונים, הרבה מעל הממוצע ההיסטורי שלו (${overallAvg}₪)` });
      } else if (recentAvg > overallAvg + 15 && gamesCount >= 4) {
        insights.push({ priority: 75, text: `📈 בעלייה ברורה: ממוצע ${recentAvg > 0 ? '+' : ''}${recentAvg}₪ במשחקים האחרונים לעומת ${overallAvg}₪ בסה"כ` });
      }
      
      // DECLINE vs HISTORY (only if active)
      if (recentAvg < overallAvg - 30) {
        insights.push({ priority: 90, text: `📉 ירידה חדה! ממוצע ${recentAvg}₪ במשחקים האחרונים - הרבה מתחת לממוצע ההיסטורי שלו (${overallAvg > 0 ? '+' : ''}${overallAvg}₪)` });
      } else if (recentAvg < overallAvg - 15 && gamesCount >= 4) {
        insights.push({ priority: 75, text: `📉 ירידה בביצועים: ${recentAvg}₪ ממוצע במשחקים האחרונים, לעומת ${overallAvg > 0 ? '+' : ''}${overallAvg}₪ היסטורית` });
      }
      
      // DOMINANT PERFORMANCE
      if (recentWins >= gamesCount - 1 && gamesCount >= 4) {
        insights.push({ priority: 85, text: `שליטה מוחלטת: ${recentWins} מתוך ${gamesCount} משחקים אחרונים סיים ברווח!` });
      } else if (recentLosses >= gamesCount - 1 && gamesCount >= 4) {
        insights.push({ priority: 85, text: `מתקשה מאוד: רק ${recentWins} מתוך ${gamesCount} משחקים אחרונים ברווח` });
      }
    }
    
    // === INACTIVE PLAYERS (haven't played in a while) - SARCASTIC! ===
    else {
      // Time since last game - with cynicism!
      if (monthsAgo >= 12) {
        insights.push({ priority: 95, text: `👻 נעלם לשנה שלמה! חשבנו שעבר דירה או משהו. מתברר שסתם שכח אותנו` });
        insights.push({ priority: 93, text: `⏰ שנה בלי משחק?! מה קרה, מצאת קבוצה יותר טובה? (ספוילר: אין)` });
        insights.push({ priority: 91, text: `👻 ${monthsAgo} חודשים! כבר הספקנו למחוק אותו מהוואטסאפ ולהוסיף מחדש` });
      } else if (monthsAgo >= 6) {
        insights.push({ priority: 90, text: `👻 נעלם ל-${monthsAgo} חודשים - בטח היה עסוק בלהפסיד במקומות אחרים` });
        insights.push({ priority: 88, text: `⏰ ${monthsAgo} חודשים בלי ביקור! מה, הארנק היה צריך זמן להתאושש?` });
        insights.push({ priority: 86, text: `👻 חצי שנה מאז שראינו את הפרצוף שלו - נקווה שלפחות הביא כסף` });
      } else if (monthsAgo >= 3) {
        insights.push({ priority: 85, text: `⏰ ${monthsAgo} חודשים בהיעדרות - בטח חיכה שנשכח כמה הוא מפסיד` });
        insights.push({ priority: 83, text: `⏰ היעדרות של ${monthsAgo} חודשים. נקווה שהתאמן ולא רק בנטפליקס` });
        insights.push({ priority: 81, text: `👻 ${monthsAgo} חודשים! כבר התחלנו לחלק את הכיסא שלו לאחרים` });
      } else {
        insights.push({ priority: 75, text: `⏰ חודשיים בלי משחק - מספיק זמן לשכוח הכל` });
        insights.push({ priority: 73, text: `⏰ לא היה פה חודשיים. מה קרה, פחדת מאיתנו?` });
      }
    }
    
    // === HISTORICAL PATTERNS (always relevant) ===
    
    // BIG WINS
    if (bestRecent >= 100) {
      insights.push({ priority: 70, text: `💰 הנצחון הגדול שלו: +${bestRecent}₪ - מוכיח שכשהוא בפורמה, הוא יכול לקחת הרבה` });
    } else if (bestRecent >= 60 && recentAvg < 0) {
      insights.push({ priority: 65, text: `יודע לנצח גדול (+${bestRecent}₪) אבל לא עקבי - תלוי באיזה יום תפסת אותו` });
    }
    
    // BIG LOSSES
    if (worstRecent <= -100) {
      insights.push({ priority: 70, text: `💸 הפסד כואב של ${worstRecent}₪ - יודע גם ליפול חזק` });
    } else if (worstRecent <= -60 && recentAvg > 0) {
      insights.push({ priority: 65, text: `גם כשהוא מפסיד, הוא מפסיד גדול (${worstRecent}₪) - אבל בסופו של דבר ברווח` });
    }
    
    // WIN RATE
    if (winPct >= 65) {
      insights.push({ priority: 70, text: `🎯 אחוז נצחון של ${winPct}% מתוך ${totalGames} משחקים - שחקן מנצח מובהק` });
    } else if (winPct <= 35 && totalGames >= 5) {
      insights.push({ priority: 70, text: `😅 רק ${winPct}% נצחונות מתוך ${totalGames} משחקים - אבל ממשיך לנסות` });
    }
    
    // COMEBACK POTENTIAL
    if (totalProfit < -200 && recentAvg > 10 && isActive) {
      insights.push({ priority: 80, text: `🔄 בדרך לקאמבק? הפסיד ${Math.abs(totalProfit)}₪ בסה"כ, אבל בביצועים האחרונים יש שיפור` });
    } else if (totalProfit < -200) {
      insights.push({ priority: 65, text: `📊 הפסיד ${Math.abs(totalProfit)}₪ לאורך ההיסטוריה - השאלה אם הוא למד משהו` });
    }
    
    // LOSING THE EDGE
    if (totalProfit > 200 && recentAvg < -10 && isActive) {
      insights.push({ priority: 80, text: `⚠️ היה מרוויח גדול (+${totalProfit}₪ כולל) אבל הביצועים האחרונים מדאיגים` });
    }
    
    // VOLATILE
    if (bestRecent - worstRecent > 150) {
      insights.push({ priority: 55, text: `🎢 שחקן של קיצוניות: בין +${bestRecent}₪ ל-${Math.abs(worstRecent)}₪ - אתו אף פעם לא יודעים` });
    }
    
    // TOTAL PROFIT MILESTONES
    if (totalProfit > 500) {
      insights.push({ priority: 50, text: `💎 רווח כולל של +${totalProfit}₪ מ-${totalGames} משחקים - אחד המנצחים הגדולים` });
      insights.push({ priority: 48, text: `💎 +${totalProfit}₪ בקופה - ההיסטוריה מדברת בעד עצמה` });
    } else if (totalProfit < -500) {
      insights.push({ priority: 50, text: `📊 הפסיד ${Math.abs(totalProfit)}₪ לאורך ${totalGames} משחקים - הספונסר שלנו` });
    }
    
    // BALANCED
    if (Math.abs(recentAvg) <= 5 && recentWins === recentLosses && gamesCount >= 4) {
      insights.push({ priority: 50, text: `⚖️ מאוזן להפליא: ${recentWins} נצחונות ו-${recentLosses} הפסדים - לא נוטה לשום כיוון` });
    }
    
    // DEFAULT summaries based on data quality
    if (totalGames >= 10) {
      insights.push({ priority: 35, text: `${totalGames} משחקים בהיסטוריה, ${winPct}% נצחונות, ממוצע ${overallAvg >= 0 ? '+' : ''}${overallAvg}₪ למשחק` });
      insights.push({ priority: 33, text: `שחקן ותיק עם ${totalGames} משחקים: סה"כ ${totalProfit >= 0 ? '+' : ''}${totalProfit}₪` });
    } else if (totalGames >= 5) {
      insights.push({ priority: 30, text: `${totalGames} משחקים עד היום: ${recentWins} נצחונות, ממוצע ${overallAvg >= 0 ? '+' : ''}${overallAvg}₪` });
    } else {
      insights.push({ priority: 25, text: `עדיין מתחיל: רק ${totalGames} משחקים בהיסטוריה` });
    }
    
    // RANDOM SELECTION from top candidates
    insights.sort((a, b) => b.priority - a.priority);
    
    if (insights.length === 0) return '';
    if (insights.length === 1) return insights[0].text;
    
    // Get top tier (within 15 points of highest priority)
    const topPriority = insights[0].priority;
    const topTier = insights.filter(i => i.priority >= topPriority - 15);
    
    // Weighted random selection
    const totalWeight = topTier.reduce((sum, i) => sum + i.priority, 0);
    let random = Math.random() * totalWeight;
    
    for (const insight of topTier) {
      random -= insight.priority;
      if (random <= 0) return insight.text;
    }
    
    return topTier[Math.floor(Math.random() * topTier.length)].text;
  };
  
  const analyzeRecent = (stats: PlayerStats): RecentAnalysis => {
    const lastGames = stats.lastGameResults || [];
    const gamesCount = lastGames.length;
    const daysSinceLastGame = getDaysSinceLastGame(stats);
    const isActive = daysSinceLastGame <= 60;
    
    if (gamesCount === 0) {
      return { 
        recentWins: 0, recentLosses: 0, recentProfit: 0, recentAvg: 0, 
        gamesCount: 0, trend: 'stable', highlights: '', daysSinceLastGame: 999, isActive: false
      };
    }
    
    const recentWins = lastGames.filter(g => g.profit > 0).length;
    const recentLosses = lastGames.filter(g => g.profit < 0).length;
    const recentProfit = lastGames.reduce((sum, g) => sum + g.profit, 0);
    const recentAvg = Math.round(recentProfit / gamesCount);
    const streak = stats.currentStreak;
    
    // Determine trend (only relevant for active players)
    let trend: RecentAnalysis['trend'] = 'stable';
    if (isActive) {
      if (streak >= 3) trend = 'hot';
      else if (streak <= -3) trend = 'cold';
      else if (recentAvg > stats.avgProfit + 15) trend = 'improving';
      else if (recentAvg < stats.avgProfit - 15) trend = 'declining';
    }
    
    // Generate dynamic personalized highlight with recency context
    const highlights = generateDynamicHighlight(stats, daysSinceLastGame);
    
    return { recentWins, recentLosses, recentProfit, recentAvg, gamesCount, trend, highlights, daysSinceLastGame, isActive };
  };

  // Generate CREATIVE forecast sentence - LONGER and more engaging with GENDER SUPPORT
  const generateCreativeSentence = (
    name: string, 
    stats: PlayerStats,
    recent: RecentAnalysis,
    expectedOutcome: 'big_win' | 'win' | 'slight_win' | 'neutral' | 'slight_loss' | 'loss' | 'big_loss',
    isSurprise: boolean
  ): string => {
    const { trend, isActive, daysSinceLastGame } = recent;
    const monthsAway = Math.floor(daysSinceLastGame / 30);
    const female = isFemale(name);
    
    // Gender helper - returns [male, female] forms
    const g = (m: string, f: string) => female ? f : m;
    
    // INACTIVE PLAYERS - returning after long break (SARCASTIC!)
    if (!isActive && monthsAway >= 12) {
      // Year+ absence - maximum sarcasm
      const yearAbsenceSentences = [
        `${name} ${g('חוזר', 'חוזרת')} אחרי שנה שלמה?! ${g('חשבנו שהיגרת', 'חשבנו שהיגרת')} או משהו. איפה ${g('היית', 'היית')}, במחנה אימונים לפוקר? (ספוילר: זה לא עזר)`,
        `תראו מי ${g('מכבד', 'מכבדת')} אותנו! ${name} ${g('נעלם', 'נעלמה')} לשנה ${g('וחוזר', 'וחוזרת')} כאילו כלום לא קרה. נקווה ${g('שהבאת', 'שהבאת')} פיצויים`,
        `${name} ${g('בחזרה', 'בחזרה')} אחרי שנה! כבר הספקנו ${g('למחוק אותו', 'למחוק אותה')} מאנשי הקשר ולהוסיף מחדש. פעמיים`,
        `שנה שלמה בלי ${name}! מה קרה, ${g('הלכת', 'הלכת')} לחפש קבוצה ${g('שמפסידה יותר ממך', 'שמפסידה יותר ממך')}? לא ${g('מצאת', 'מצאת')}, נכון?`,
        `${name} ${g('נזכר', 'נזכרת')} שאנחנו קיימים אחרי שנה! הארנקים שלנו שמחים ${g('לראות אותך', 'לראות אותך')} ${g('חזרה', 'חזרה')} - הם התגעגעו לכסף ${g('שלך', 'שלך')}`,
      ];
      return yearAbsenceSentences[Math.floor(Math.random() * yearAbsenceSentences.length)];
    }
    
    if (!isActive && monthsAway >= 6) {
      // Very long absence - extra sarcastic
      const veryLongAbsenceSentences = [
        `אוי, ${name} ${g('נזכר', 'נזכרת')} שאנחנו קיימים! ${monthsAway} חודשים בלי ביקור, מה קרה - נגמר לך הכסף לבזבז במקומות אחרים?`,
        `${name} ${g('חוזר', 'חוזרת')} אחרי ${monthsAway} חודשים! חשבנו ${g('שעברת', 'שעברת')} לקזינו יותר יוקרתי. מתברר שלא`,
        `וואו, ${name} ${g('מכבד', 'מכבדת')} אותנו ${g('בנוכחותו', 'בנוכחותה')} אחרי ${monthsAway} חודשים! קיווינו ${g('שלמדת', 'שלמדת')} לשחק בינתיים, אבל כנראה שלא`,
        `${name} ${g('נעלם', 'נעלמה')} ל-${monthsAway} חודשים ${g('וחוזר', 'וחוזרת')} כאילו כלום לא קרה. נקווה שלפחות ${g('זכרת', 'זכרת')} איך מחזיקים קלפים`,
        `${g('אורח נדיר', 'אורחת נדירה')}: ${name} לא ראינו אותך ${monthsAway} חודשים! מה, ${g('היית עסוק', 'היית עסוקה')} בלהפסיד כסף במקומות אחרים?`,
        `${name} ${g('חוזר', 'חוזרת')} מההיעלמות הגדולה! ${monthsAway} חודשים בלי פוקר - בטח החלודה עבה כמו ספר טלפונים`,
        `תראו מי פה! ${name} ${g('נזכר', 'נזכרת')} אחרי ${monthsAway} חודשים ${g('שיש לו', 'שיש לה')} חברים. טוב ${g('שבאת', 'שבאת')}, הארנקים שלנו התגעגעו`,
      ];
      return veryLongAbsenceSentences[Math.floor(Math.random() * veryLongAbsenceSentences.length)];
    }
    
    if (!isActive && monthsAway >= 3) {
      // Medium absence - moderately sarcastic
      const returningSentences = [
        `${name} ${g('מתעורר', 'מתעוררת')} אחרי ${monthsAway} חודשים של שינה. נקווה ${g('שהחלומות שלו', 'שהחלומות שלה')} על נצחונות לא יישארו חלומות`,
        `${name} ${g('חוזר', 'חוזרת')} אחרי ${monthsAway} חודשים - מספיק זמן לשכוח איך משחקים, לא מספיק זמן ללמוד`,
        `${name} לא ${g('נגע', 'נגעה')} בקלפים ${monthsAway} חודשים. מה קרה, הבנק סגר לך את הקו?`,
        `${g('הנה', 'הנה')} ${name} ${g('חוזר', 'חוזרת')} אחרי היעדרות של ${monthsAway} חודשים! בטח התגעגענו לכסף ${g('שלו', 'שלה')}`,
        `${name} ${g('נעלם', 'נעלמה')} ל-${monthsAway} חודשים ${g('וחוזר', 'וחוזרת')}. יש כאלה ${g('שחוזרים חזקים', 'שחוזרות חזקות')}, ויש כאלה שפשוט ${g('חוזרים', 'חוזרות')}`,
        `אחרי ${monthsAway} חודשים, ${name} ${g('מחליט', 'מחליטה')} להראות פנים. נקווה ${g('שהוא מביא', 'שהיא מביאה')} ארנק מלא ולא רק תירוצים`,
        `${name} ${g('בחזרה', 'בחזרה')} אחרי ${monthsAway} חודשים! השאלה היחידה - האם ${g('הוא למד', 'היא למדה')} משהו או ${g('שהוא עדיין אותו שחקן', 'שהיא עדיין אותה שחקנית')}?`,
      ];
      return returningSentences[Math.floor(Math.random() * returningSentences.length)];
    }
    
    // Hot streak sentences - many options for variety
    if (trend === 'hot') {
      const sentences = [
        `${name} על רצף נצחונות מטורף - ${g('הוא', 'היא')} פשוט לא ${g('יכול', 'יכולה')} להפסיד עכשיו, ואף אחד לא יודע מתי זה ייגמר`,
        `${g('כשאתה חם, אתה חם', 'כשאת חמה, את חמה')}. ${name} עכשיו במצב שבו כל מה ${g('שהוא נוגע בו', 'שהיא נוגעת בו')} הופך לזהב`,
        `${name} ${g('שובר', 'שוברת')} את כל הסטטיסטיקות עם הרצף ${g('שלו', 'שלה')} - קשה מאוד להמר ${g('נגדו', 'נגדה')} במצב כזה`,
        `מי ${g('עוצר', 'עוצרת')} את ${name}? רצף הנצחונות ${g('שלו מרשים', 'שלה מרשים')}, והביטחון ${g('שלו', 'שלה')} בשמיים`,
        `${name} על גל חם רציני - כשהמומנטום לצידך, הכל נראה קל`,
        `הקלפים אוהבים את ${name} עכשיו. רצף כזה לא קורה במקרה`,
        `${name} במצב טירוף - אם הייתי צריך לבחור ${g('מנצח', 'מנצחת')}, הייתי ${g('בוחר בו', 'בוחרת בה')} בלי לחשוב פעמיים`,
      ];
      return sentences[Math.floor(Math.random() * sentences.length)];
    }
    
    // Cold streak sentences
    if (trend === 'cold') {
      const sentences = [
        `${name} ${g('עובר', 'עוברת')} תקופה קשה עם הרצף השלילי, אבל כל רצף נשבר מתישהו - השאלה אם הלילה`,
        `הקלפים לא מחייכים ל${name} לאחרונה, אבל כולם יודעים שהמזל מתהפך. אולי הלילה?`,
        `${name} בתקופת יובש - מספיק הפסדים כדי שכולם יתחילו לשאול מה ${g('קורה לו', 'קורה לה')}`,
        `כולם אוהבים סיפור קאמבק, ו${name} בדיוק במצב ${g('שבו הוא צריך', 'שבו היא צריכה')} אחד. הלילה ההזדמנות ${g('שלו', 'שלה')}`,
        `${name} ${g('יודע', 'יודעת')} שהרצף השלילי חייב להישבר - השאלה היא האם יש ${g('לו', 'לה')} את הכוח הנפשי לזה`,
        `תקופה קשה ל${name}, אבל ${g('שחקנים אמיתיים יודעים', 'שחקניות אמיתיות יודעות')} איך לצאת מבורות. נראה מה יקרה`,
        `${name} ${g('מחפש', 'מחפשת')} את הנצחון שישבור את הרצף - כשזה יקרה, זה יהיה מתוק במיוחד`,
      ];
      return sentences[Math.floor(Math.random() * sentences.length)];
    }
    
    // Improving trend
    if (trend === 'improving') {
      const sentences = [
        `משהו השתנה אצל ${name} לטובה - הביצועים האחרונים ${g('שלו', 'שלה')} הרבה יותר טובים מהממוצע ההיסטורי`,
        `${name} בעלייה ברורה - נראה ${g('שהוא פיצח', 'שהיא פיצחה')} משהו והמשחק ${g('שלו', 'שלה')} השתפר משמעותית`,
        `המומנטום לצד ${name} - מי שעוקב אחרי הנתונים רואה ${g('שהוא', 'שהיא')} בכיוון הנכון`,
        `${name} ${g('מראה', 'מראה')} סימני שיפור מרשימים - יכול להיות ${g('שהוא עומד', 'שהיא עומדת')} לפרוץ`,
        `הרוח משתנה לטובת ${name} - הביצועים האחרונים מבטיחים משהו טוב`,
        `${name} בתהליך של שיפור עקבי - השאלה היא האם הלילה ${g('הוא ימשיך', 'היא תמשיך')} את המגמה`,
      ];
      return sentences[Math.floor(Math.random() * sentences.length)];
    }
    
    // Declining trend
    if (trend === 'declining') {
      const sentences = [
        `${name} לא באותה פורמה של פעם - הביצועים האחרונים חלשים יותר מהממוצע ${g('שלו', 'שלה')}`,
        `משהו לא עובד ל${name} בתקופה האחרונה - הנתונים מראים ירידה ברורה`,
        `${name} ${g('מאבד', 'מאבדת')} קצת את הקצב - ימים יותר טובים ${g('היו לו', 'היו לה')} בעבר`,
        `${name} ${g('צריך', 'צריכה')} לעצור את מגמת הירידה - הביצועים האחרונים לא משקפים את הפוטנציאל ${g('שלו', 'שלה')}`,
        `${name} בירידה קלה אבל מורגשת - נראה אם ${g('הוא יצליח', 'היא תצליח')} להתאושש הלילה`,
        `לא הזמן הכי טוב של ${name} - הנתונים האחרונים מדאיגים קצת`,
      ];
      return sentences[Math.floor(Math.random() * sentences.length)];
    }
    
    // Surprise prediction
    if (isSurprise) {
      if (expectedOutcome.includes('win')) {
        const sentences = [
          `⚡ תחושת בטן חזקה: ${name} ${g('הולך', 'הולכת')} להפתיע הלילה. הנתונים אומרים דבר אחד, אבל משהו באוויר אומר אחרת`,
          `⚡ ${name} ${g('מגיע', 'מגיעה')} עם משהו להוכיח - לפעמים הדחף להוכיח שווה יותר מכל סטטיסטיקה`,
          `⚡ נגד כל הסיכויים: ${name} ${g('עשוי', 'עשויה')} לעשות קאמבק מפתיע. יש ${g('לו', 'לה')} את האנרגיה לזה`,
          `⚡ ${name} לא ${g('הולך', 'הולכת')} לפי התסריט הלילה - יש משהו ${g('שונה בו', 'שונה בה')}, תחושה של פריצה`,
          `⚡ הפתעה באוויר: ${name} ${g('יכול', 'יכולה')} לשנות את הכל הלילה ולהפוך את הקערה על פיה`,
        ];
        return sentences[Math.floor(Math.random() * sentences.length)];
      } else {
        const sentences = [
          `⚡ אזהרה: גם ${g('מלכים נופלים', 'מלכות נופלות')}. ${name} ${g('בא', 'באה')} עם ביטחון, אבל משהו יכול להשתבש`,
          `⚡ ${name} ${g('צריך', 'צריכה')} להיזהר הלילה - ביטחון יתר יכול להיות מסוכן, וההיסטוריה לא תמיד מגינה`,
          `⚡ משהו לא מרגיש נכון לגבי ${name} הערב - למרות הנתונים הטובים, יש תחושה של נפילה`,
          `⚡ ${name} ${g('עלול', 'עלולה')} להיתקל בהפתעה לא נעימה - לפעמים דברים לא הולכים לפי התוכנית`,
          `⚡ נבואה מפתיעה: ${name} ${g('יכול', 'יכולה')} לאכול אותה הלילה למרות ההיסטוריה ${g('המרשימה שלו', 'המרשימה שלה')}`,
        ];
        return sentences[Math.floor(Math.random() * sentences.length)];
      }
    }
    
    // Regular predictions - fun and dramatic with LONGER sentences
    switch (expectedOutcome) {
      case 'big_win':
        const bigWinSentences = [
          `${name} ${g('הוא המועמד המוביל', 'היא המועמדת המובילה')} לקחת הכי הרבה כסף הלילה - הנתונים והפורמה ${g('שלו', 'שלה')} פשוט מדברים בעד עצמם`,
          `כולם צריכים להיזהר מ${name} הערב - ${g('הוא בא', 'היא באה')} לגבות מיסים ולא נראה שמישהו ${g('יכול לעצור אותו', 'יכול לעצור אותה')}`,
          `${name} במצב שבו הכל עובד ${g('לטובתו', 'לטובתה')} - אם הייתי צריך להמר על ${g('מישהו, הוא היה', 'מישהי, היא הייתה')} הבחירה הראשונה שלי`,
          `${name} ${g('הוא', 'היא')} הסיבה שכמה אנשים סביב השולחן קצת מודאגים - וזה מוצדק לגמרי`,
          `מי ינסה להתמודד עם ${name}? עם הנתונים ${g('שלו', 'שלה')}, זה כמו להילחם נגד הסיכויים`,
          `${name} לא ${g('בא', 'באה')} לשחק - ${g('הוא בא', 'היא באה')} לשלוט. וזה בדיוק מה ${g('שהוא כנראה יעשה', 'שהיא כנראה תעשה')}`,
        ];
        return bigWinSentences[Math.floor(Math.random() * bigWinSentences.length)];
        
      case 'win':
        const winSentences = [
          `${name} בפורמה טובה ויש ${g('לו', 'לה')} סיכוי ממשי לצאת עם רווח יפה הלילה`,
          `הנתונים תומכים ב${name} - ${g('הוא יודע', 'היא יודעת')} לשחק והתוצאות מוכיחות את זה`,
          `${name} ${g('מגיע', 'מגיעה')} עם יתרון סטטיסטי ברור - לא ${g('מועמד', 'מועמדת')} לכתר, אבל בהחלט ${g('שחקן רציני', 'שחקנית רצינית')}`,
          `${name} לא ${g('בא', 'באה')} להשתתף, ${g('הוא בא', 'היא באה')} לנצח - והסיכויים בהחלט ${g('לצידו', 'לצידה')}`,
          `יש משהו ב${name} הערב שאומר ${g('שהוא ייקח', 'שהיא תיקח')} כסף הביתה - הנתונים מחזקים את התחושה`,
          `${name} ${g('בא מוכן ויודע', 'באה מוכנה ויודעת')} מה ${g('הוא עושה', 'היא עושה')} - צפו לערב טוב ${g('עבורו', 'עבורה')}`,
        ];
        return winSentences[Math.floor(Math.random() * winSentences.length)];
        
      case 'slight_win':
        const slightWinSentences = [
          `${name} עם יתרון קטן אבל משמעותי - לא ${g('יגרום', 'תגרום')} לאף אחד לפחד, אבל בהחלט ${g('יכול', 'יכולה')} להפתיע`,
          `הסיכויים קצת לטובת ${name} הערב - לא מרשים במיוחד, אבל מספיק כדי להיות ${g('אופטימי', 'אופטימית')}`,
          `${name} בכיוון הנכון - לא ${g('המועמד הראשי', 'המועמדת הראשית')}, אבל בהחלט ${g('יכול', 'יכולה')} לסיים ברווח`,
          `${name} ${g('מגיע', 'מגיעה')} עם אופטימיות זהירה - הנתונים לא מבטיחים הרבה, אבל גם לא מאיימים`,
          `צפו לערב סביר עבור ${name} - לא פסטיבל, אבל כנראה ${g('יצא', 'תצא')} עם משהו בכיס`,
          `${name} לא ${g('יגנוב', 'תגנוב')} את ההצגה, אבל בהחלט ${g('יכול', 'יכולה')} להפתיע ולסיים ברווח קטן`,
        ];
        return slightWinSentences[Math.floor(Math.random() * slightWinSentences.length)];
        
      case 'neutral':
        const neutralSentences = [
          `${name} ${g('הוא', 'היא')} חידה מוחלטת הערב - הנתונים לא נותנים שום רמז לאיזה כיוון ${g('הוא', 'היא')} ילך`,
          `50-50 עבור ${name} - יכול להיות ערב מדהים או ערב לשכוח. תלוי באיזה ${name} ${g('יגיע', 'תגיע')}`,
          `${name} על קו האפס - השאלה הגדולה היא לאיזה צד ${g('הוא ייפול', 'היא תיפול')}, ואף אחד לא יודע`,
          `${name} בלתי ${g('צפוי', 'צפויה')} לחלוטין - זה מה ${g('שמעניין בו', 'שמעניין בה')}, אף פעם לא יודעים מה יקרה`,
          `מי יודע מה ${g('יעשה', 'תעשה')} ${name} הלילה? הנתונים לא עוזרים, והכל תלוי במזל ובמצב רוח`,
          `${name} ${g('יכול', 'יכולה')} להפתיע לכל כיוון - גם ניצחון גדול וגם הפסד כואב אפשריים לגמרי`,
        ];
        return neutralSentences[Math.floor(Math.random() * neutralSentences.length)];
        
      case 'slight_loss':
        const slightLossSentences = [
          `${name} ${g('צריך', 'צריכה')} קצת מזל הלילה - הנתונים לא לגמרי ${g('לצידו', 'לצידה')}, אבל זה לא אומר ${g('שהוא', 'שהיא')} לא ${g('יכול', 'יכולה')} להפוך את הקערה`,
          `הרוח לא לגמרי לטובת ${name} הערב - ${g('הוא יצטרך', 'היא תצטרך')} להילחם על כל שקל אם ${g('הוא רוצה', 'היא רוצה')} לצאת ברווח`,
          `${name} ${g('מתחיל', 'מתחילה')} עם חיסרון קל - לא דרמטי, אבל מספיק כדי להקשות על הערב`,
          `הסיכויים קצת נגד ${name} - ${g('הוא יצטרך', 'היא תצטרך')} משחק טוב במיוחד כדי להפוך את המגמה`,
          `${name} ${g('בא', 'באה')} לערב מאתגר - הנתונים מציעים שזה לא יהיה קל, אבל הכל אפשרי`,
          `${name} ${g('יצטרך', 'תצטרך')} לעבוד קשה הלילה - היתרון לא ${g('לצידו', 'לצידה')}, אבל ${g('שחקנים טובים יודעים', 'שחקניות טובות יודעות')} איך להתגבר`,
        ];
        return slightLossSentences[Math.floor(Math.random() * slightLossSentences.length)];
        
      case 'loss':
        const lossSentences = [
          `${name} לא בעמדה הכי טובה הערב - הנתונים מראים ${g('שהוא יצטרך', 'שהיא תצטרך')} הרבה מזל כדי לשנות את המגמה`,
          `קשה להיות ${g('אופטימי', 'אופטימית')} לגבי ${name} הלילה - הסטטיסטיקות לא ${g('לצידו', 'לצידה')} ונראה ${g('שיהיה לו', 'שיהיה לה')} קשה`,
          `${name} ${g('בא', 'באה')} עם רוח נגדית חזקה - אולי ${g('כדאי לו', 'כדאי לה')} לשחק ${g('שמרני', 'שמרנית')} ולא לקחת סיכונים`,
          `הנתונים לא מבשרים טובות ל${name} - נראה שזה הולך להיות ערב מאתגר במיוחד`,
          `${name} ${g('יצטרך', 'תצטרך')} נס קטן כדי לסיים ברווח - הסיכויים ממש לא ${g('לצידו', 'לצידה')} הערב`,
          `${name} לא ${g('במיטבו', 'במיטבה')} על פי הנתונים - השאלה היא האם ${g('הוא יצליח', 'היא תצליח')} להפתיע למרות הכל`,
        ];
        return lossSentences[Math.floor(Math.random() * lossSentences.length)];
        
      case 'big_loss':
        const bigLossSentences = [
          `${name} ${g('הוא הספונסר הלא רשמי', 'היא הספונסרית הלא רשמית')} של הקבוצה - ${g('בזכותו', 'בזכותה')} כולנו מרוויחים יותר, ועל זה אנחנו מודים`,
          `תודה מראש ל${name} על התרומה - הנתונים מראים ${g('שהוא כנראה יחלק', 'שהיא כנראה תחלק')} כסף לכולם הלילה`,
          `${name} ${g('בא', 'באה')} לבלות עם חברים, לא לנצח - וזה בסדר גמור, כי מישהו צריך לממן את המשחק`,
          `${name} ${g('מוכיח', 'מוכיחה')} שפוקר זה לא רק על כסף - ${g('הוא בא', 'היא באה')} ליהנות, גם אם הארנק ${g('שלו', 'שלה')} סובל`,
          `כולם אוהבים כש${name} ${g('מגיע', 'מגיעה')} - בעיקר הארנקים שלהם. הנתונים מדברים בעד עצמם`,
          `${name} - הלב במקום הנכון, גם אם הקלפים לא. לפחות החברה טובה, נכון?`,
        ];
        return bigLossSentences[Math.floor(Math.random() * bigLossSentences.length)];
    }
    
    return `${name} - ערב מסקרן ${g('מחכה לו', 'מחכה לה')}, נראה מה יקרה`;
  };

  // NEW PLAYERS - No history - LONGER engaging sentences (with gender placeholders)
  const getNewPlayerSentence = (name: string): string => {
    const female = isFemale(name);
    const g = (m: string, f: string) => female ? f : m;
    
    const sentences = [
      `${name} ${g('נכנס', 'נכנסת')} למשחק בלי היסטוריה - דף חלק לגמרי. הלילה נתחיל לכתוב את הסיפור ${g('שלו', 'שלה')}`,
      `אין לנו שום מידע על ${name} - ${g('הוא יכול להיות גאון פוקר או הפסד מובטח', 'היא יכולה להיות גאונת פוקר או הפסד מובטח')}. הלילה נגלה`,
      `${name} ${g('הוא', 'היא')} סוס אפל מוחלט - בלי נתונים, בלי היסטוריה, בלי שום רמז למה שיקרה`,
      `מי ${g('זה', 'זאת')} בכלל ${name}? אין לנו מושג, ובדיוק זה מה שמעניין. הכל פתוח`,
      `${name} ${g('מתחיל', 'מתחילה')} מאפס - בלי יתרון ובלי חיסרון. הערב הזה יקבע את הרושם הראשוני`,
      `${g('שחקן חדש', 'שחקנית חדשה')} בשם ${name} ${g('מצטרף', 'מצטרפת')} למשחק - בואו נראה ${g('מה הוא עשוי ממנו', 'מה היא עשויה ממנה')}`,
      `${name} בלי תיק עבר - ${g('יכול', 'יכולה')} להפתיע את כולם לטובה או לרעה. מי יודע?`,
    ];
    return sentences[Math.floor(Math.random() * sentences.length)];
  };


  // Generate forecasts for all selected players - WEIGHTED RECENT PERFORMANCE
  const generateForecasts = () => {
    // Step 1: Analyze all players with recent performance
    const playerAnalysis = Array.from(selectedIds).map(playerId => {
      const player = players.find(p => p.id === playerId);
      if (!player) return null;
      
      const stats = getStatsForPlayer(playerId);
      const gamesPlayed = stats?.gamesPlayed || 0;
      const avgProfit = stats?.avgProfit || 0;
      
      // Get recent analysis (last 10 games or whatever available)
      const recent = stats ? analyzeRecent(stats) : { 
        recentWins: 0, recentLosses: 0, recentProfit: 0, recentAvg: 0, 
        gamesCount: 0, trend: 'stable' as const, highlights: '' 
      };
      
      // WEIGHTED SCORE: 60% recent performance, 40% overall (if enough recent data)
      let weightedAvg: number;
      const hasRecentData = stats?.lastGameResults && stats.lastGameResults.length >= 3;
      
      if (gamesPlayed === 0) {
        weightedAvg = 0;
      } else if (hasRecentData) {
        // Weight recent performance more heavily
        weightedAvg = (recent.recentAvg * 0.6) + (avgProfit * 0.4);
      } else {
        // Not enough recent data, use overall
        weightedAvg = avgProfit;
      }
      
      // Apply streak bonuses/penalties
      if (stats && stats.currentStreak >= 3) weightedAvg *= 1.25; // Hot streak bonus
      else if (stats && stats.currentStreak >= 2) weightedAvg *= 1.1;
      else if (stats && stats.currentStreak <= -3) weightedAvg *= 0.75; // Cold streak penalty
      else if (stats && stats.currentStreak <= -2) weightedAvg *= 0.9;
      
      // Determine tendency based on weighted average
      let tendency: 'strong_winner' | 'winner' | 'neutral' | 'loser' | 'strong_loser' | 'new' = 'new';
      if (gamesPlayed === 0) {
        tendency = 'new';
      } else if (weightedAvg > 25) {
        tendency = 'strong_winner';
      } else if (weightedAvg > 8) {
        tendency = 'winner';
      } else if (weightedAvg >= -8) {
        tendency = 'neutral';
      } else if (weightedAvg >= -25) {
        tendency = 'loser';
      } else {
        tendency = 'strong_loser';
      }
      
      return {
        player,
        stats,
        gamesPlayed,
        avgProfit,
        recent,
        tendency,
        rawExpected: weightedAvg
      };
    }).filter(Boolean) as {
      player: Player;
      stats: PlayerStats | undefined;
      gamesPlayed: number;
      avgProfit: number;
      recent: RecentAnalysis;
      tendency: 'strong_winner' | 'winner' | 'neutral' | 'loser' | 'strong_loser' | 'new';
      rawExpected: number;
    }[];

    // Step 2: Smart surprise selection - UP TO 25% (not forced!)
    // Only when recent trend CONTRADICTS overall history
    const eligibleForSurprise = playerAnalysis.filter(p => {
      if (p.gamesPlayed < 5) return false;
      // Surprise when overall is positive but recent is negative, or vice versa
      const overallPositive = p.avgProfit > 10;
      const overallNegative = p.avgProfit < -10;
      const recentPositive = p.recent.recentAvg > 10;
      const recentNegative = p.recent.recentAvg < -10;
      
      return (overallPositive && recentNegative) || (overallNegative && recentPositive);
    });
    
    const maxSurprises = Math.min(
      Math.ceil(playerAnalysis.length * 0.25), // Max 25%
      eligibleForSurprise.length
    );
    
    // Random number of surprises (0 to max)
    const numSurprises = Math.floor(Math.random() * (maxSurprises + 1));
    
    // Randomly pick which players get surprised
    const surprisePlayerIds = new Set<string>();
    const shuffled = [...eligibleForSurprise].sort(() => Math.random() - 0.5);
    shuffled.slice(0, numSurprises).forEach(p => surprisePlayerIds.add(p.player.id));

    // Step 3: Calculate expected values with variance
    const withExpected = playerAnalysis.map(p => {
      const isSurprise = surprisePlayerIds.has(p.player.id);
      let expectedValue = p.rawExpected;
      
      if (isSurprise) {
        // Flip the expected value based on recent contradicting trend
        expectedValue = -expectedValue * (0.4 + Math.random() * 0.5);
      } else {
        // Add SIGNIFICANT variance to make each forecast unique
        // Base variance ±20, plus random multiplier 0.7-1.3
        const variance = (Math.random() - 0.5) * 40;
        const multiplier = 0.7 + Math.random() * 0.6;
        expectedValue = (expectedValue * multiplier) + variance;
      }
      
      return { ...p, expectedValue: Math.round(expectedValue), isSurprise };
    });

    // Step 4: Balance to zero-sum
    const totalExpected = withExpected.reduce((sum, p) => sum + p.expectedValue, 0);
    const totalWeight = withExpected.reduce((sum, p) => sum + Math.abs(p.expectedValue) + 10, 0);
    
    const balanced = withExpected.map(f => {
      const weight = (Math.abs(f.expectedValue) + 10) / totalWeight;
      const adjustment = -totalExpected * weight;
      const balancedExpected = Math.round(f.expectedValue + adjustment);
      
      // Determine outcome category
      let outcome: 'big_win' | 'win' | 'slight_win' | 'neutral' | 'slight_loss' | 'loss' | 'big_loss';
      if (balancedExpected > 35) outcome = 'big_win';
      else if (balancedExpected > 15) outcome = 'win';
      else if (balancedExpected > 3) outcome = 'slight_win';
      else if (balancedExpected >= -3) outcome = 'neutral';
      else if (balancedExpected >= -15) outcome = 'slight_loss';
      else if (balancedExpected >= -35) outcome = 'loss';
      else outcome = 'big_loss';
      
      // Generate creative sentence (fun, no stats - stats go in highlights)
      let sentence: string;
      
      if (f.gamesPlayed === 0) {
        sentence = getNewPlayerSentence(f.player.name);
      } else {
        sentence = generateCreativeSentence(f.player.name, f.stats!, f.recent, outcome, f.isSurprise);
      }
      
      return {
        player: f.player,
        expected: balancedExpected,
        sentence,
        highlights: f.recent.highlights, // Stats summary from last games
        gamesPlayed: f.gamesPlayed,
        isSurprise: f.isSurprise,
        recent: f.recent
      };
    });

    return balanced.sort((a, b) => b.expected - a.expected);
  };

  // Share forecast as screenshot to WhatsApp (splits into multiple images if many players)
  const shareForecast = async () => {
    if (isSharing) return;
    
    const forecasts = aiForecasts || cachedForecasts;
    if (!forecasts || forecasts.length === 0) return;
    
    setIsSharing(true);
    
    try {
      const PLAYERS_PER_PAGE = 5;
      const files: File[] = [];
      const isAI = !!aiForecasts;
      const today = new Date().toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });
      
      // Sort forecasts by expected profit (highest first) to match on-screen display
      const sortedForecasts = [...forecasts].sort((a: any, b: any) => {
        const aProfit = a.expectedProfit ?? a.expected ?? 0;
        const bProfit = b.expectedProfit ?? b.expected ?? 0;
        return bProfit - aProfit;
      });
      
      // Split sorted forecasts into chunks
      const chunks: typeof forecasts[] = [];
      for (let i = 0; i < sortedForecasts.length; i += PLAYERS_PER_PAGE) {
        chunks.push(sortedForecasts.slice(i, i + PLAYERS_PER_PAGE));
      }
      
      // Create a screenshot for each chunk
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const chunk = chunks[chunkIndex];
        const pageNum = chunks.length > 1 ? ` (${chunkIndex + 1}/${chunks.length})` : '';
        
        // Create temporary container for this chunk
        const container = document.createElement('div');
        container.style.cssText = 'position: absolute; left: -9999px; top: 0; width: 375px; padding: 1.25rem; background: #1a1a2e; border-radius: 12px; font-family: system-ui, -apple-system, sans-serif;';
        
        // Header
        container.innerHTML = `
          <div style="text-align: center; margin-bottom: 1.25rem;">
            <div style="font-size: 2rem; margin-bottom: 0.25rem;">${isAI ? '🤖' : '🔮'}</div>
            <h3 style="margin: 0; font-size: 1.2rem; font-weight: 700; color: #f1f5f9;">
              ${isAI ? 'תחזית AI' : 'תחזית הלילה'}${pageNum}
            </h3>
            ${isAI ? '<div style="font-size: 0.75rem; color: #A855F7; margin-top: 0.25rem;">Powered by Gemini ✨</div>' : ''}
            <div style="font-size: 0.8rem; color: #94a3b8; margin-top: 0.25rem;">${today}</div>
          </div>
          <div style="margin-bottom: 1rem;">
            ${chunk.map((forecast: any, index: number) => {
              const isFirst = chunkIndex === 0 && index === 0;
              const isSurprise = forecast.isSurprise || forecast.surprise;
              const expected = forecast.expectedProfit ?? forecast.expected ?? 0;
              const sentence = forecast.sentence || '';
              const highlight = forecast.highlight || '';
              const name = forecast.name || forecast.playerName || '';
              
              let bgColor = 'rgba(100, 116, 139, 0.12)';
              let borderColor = '#64748b';
              let textColor = '#f1f5f9';
              
              if (isSurprise) {
                bgColor = 'rgba(168, 85, 247, 0.15)';
                borderColor = '#a855f7';
                textColor = '#a855f7';
              } else if (expected > 10) {
                bgColor = 'rgba(34, 197, 94, 0.12)';
                borderColor = '#22c55e';
                textColor = '#22c55e';
              } else if (expected < -10) {
                bgColor = 'rgba(239, 68, 68, 0.12)';
                borderColor = '#ef4444';
                textColor = '#ef4444';
              }
              
              return `
                <div style="padding: 0.75rem 0.85rem; margin-bottom: 0.5rem; border-radius: 10px; background: ${bgColor}; border-right: 4px solid ${borderColor};">
                  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.4rem;">
                    <span style="font-weight: 700; font-size: 1rem; color: #f1f5f9;">
                      ${isFirst && expected > 0 ? '👑 ' : ''}${name}${isSurprise ? ' ⚡' : ''}
                    </span>
                    <span style="font-weight: 700; font-size: 1.05rem; color: ${textColor};">
                      ${expected >= 0 ? '+' : '-'}₪${Math.abs(Math.round(expected)).toLocaleString()}
                    </span>
                  </div>
                  ${highlight ? `<div style="font-size: 0.78rem; color: #f1f5f9; opacity: 0.8; margin-bottom: 0.4rem; direction: rtl; line-height: 1.4;">${highlight}</div>` : ''}
                  <div style="font-size: 0.85rem; color: ${isSurprise ? '#a855f7' : '#94a3b8'}; line-height: 1.45; direction: rtl; font-style: italic;">
                    ${sentence}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
          <div style="text-align: center; font-size: 0.65rem; color: #94a3b8; opacity: 0.5;">
            Poker Manager 🎲${isAI ? ' + AI' : ''}
          </div>
        `;
        
        document.body.appendChild(container);
        
        // Capture screenshot
        const canvas = await html2canvas(container, {
          backgroundColor: '#1a1a2e',
          scale: 2,
          useCORS: true,
          logging: false,
        });
        
        document.body.removeChild(container);
        
        const blob = await new Promise<Blob>((resolve) => {
          canvas.toBlob((b) => resolve(b!), 'image/png', 1.0);
        });
        
        const fileName = chunks.length > 1 
          ? `poker-forecast-${chunkIndex + 1}.png` 
          : 'poker-forecast.png';
        files.push(new File([blob], fileName, { type: 'image/png' }));
      }
      
      // Share all files
      if (navigator.share && navigator.canShare({ files })) {
        await navigator.share({ files, title: 'תחזית פוקר' });
      } else {
        // Fallback: download all + WhatsApp
        for (const file of files) {
          const url = URL.createObjectURL(file);
          const a = document.createElement('a');
          a.href = url;
          a.download = file.name;
          a.click();
          URL.revokeObjectURL(url);
        }
        
        const todayShort = new Date().toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'short' });
        window.open(`https://wa.me/?text=${encodeURIComponent(`🔮 תחזית פוקר - ${todayShort}\n\n(${files.length} תמונות הורדו - צרף אותן)`)}`, '_blank');
      }
    } catch (error) {
      console.error('Error sharing forecast:', error);
    } finally {
      setIsSharing(false);
    }
  };

  const handleShowForecast = async () => {
    if (selectedIds.size < 2) {
      setError('Select at least 2 players');
      return;
    }
    
    // Check if AI is available
    const hasAIKey = !!getGeminiApiKey();
    
    if (hasAIKey) {
      // Use AI forecasts
      setShowForecast(true);
      setIsLoadingAI(true);
      setAiError(null);
      setAiForecasts(null);
      
      try {
        // Prepare player data for AI
        const selectedPlayers = players.filter(p => selectedIds.has(p.id));
        const playerData: PlayerForecastData[] = selectedPlayers.map(player => {
          const stats = getStatsForPlayer(player.id);
          const daysSince = stats ? getDaysSinceLastGame(stats) : 999;
          
          return {
            name: player.name,
            isFemale: isFemale(player.name),
            gamesPlayed: stats?.gamesPlayed || 0,
            totalProfit: stats?.totalProfit || 0,
            avgProfit: stats?.avgProfit || 0,
            winCount: stats?.winCount || 0,
            lossCount: stats?.lossCount || 0,
            winPercentage: stats?.winPercentage || 0,
            currentStreak: stats?.currentStreak || 0,
            bestWin: stats?.bestWin || 0,
            worstLoss: stats?.worstLoss || 0,
            gameHistory: stats?.lastGameResults || [], // Full game history
            daysSinceLastGame: daysSince,
            isActive: daysSince <= 60
          };
        });
        
        const forecasts = await generateAIForecasts(playerData);
        setAiForecasts(forecasts);
        setIsLoadingAI(false);
      } catch (err: any) {
        console.error('AI forecast error:', err);
        setIsLoadingAI(false);
        
        if (err.message === 'NO_API_KEY') {
          setAiError('No API key configured. Using static forecasts.');
          setCachedForecasts(generateForecasts());
        } else if (err.message?.includes('rate limit') || err.message?.includes('Rate limit') || err.message?.includes('unavailable')) {
          // Start countdown timer for rate limit
          setAiError('⏳ Rate limit reached. Retry countdown starting...');
          setRetryCountdown(60); // Start 60 second countdown
          
          // Clear any existing timer
          if (retryTimerRef.current) clearInterval(retryTimerRef.current);
          
          // Start countdown
          retryTimerRef.current = setInterval(() => {
            setRetryCountdown(prev => {
              if (prev === null || prev <= 1) {
                if (retryTimerRef.current) clearInterval(retryTimerRef.current);
                setAiError('✅ Ready to retry! Click the forecast button again.');
                return null;
              }
              return prev - 1;
            });
          }, 1000);
          
          // Don't fallback to static - let user retry
        } else {
          setAiError(`AI error: ${err.message}. Using static forecasts.`);
          setCachedForecasts(generateForecasts());
        }
      }
    } else {
      // Use static forecasts
      setCachedForecasts(generateForecasts());
      setShowForecast(true);
    }
  };

  // Render player tile - balanced size
  const renderPlayerTile = (player: Player) => (
    <div
      key={player.id}
      onClick={() => togglePlayer(player.id)}
      style={{
        padding: '0.5rem 0.4rem',
        borderRadius: '10px',
        fontSize: '0.9rem',
        fontWeight: '600',
        cursor: 'pointer',
        border: selectedIds.has(player.id) ? '2px solid var(--primary)' : '2px solid var(--border)',
        background: selectedIds.has(player.id) ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
        color: selectedIds.has(player.id) ? 'var(--primary)' : 'var(--text)',
        transition: 'all 0.15s ease',
        textAlign: 'center'
      }}
    >
      {selectedIds.has(player.id) && '✓ '}{player.name}
    </div>
  );

  return (
    <div className="fade-in">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
        <h1 className="page-title" style={{ fontSize: '1.25rem', margin: 0 }}>New Game</h1>
        {permanentPlayers.length > 0 && (
          <button className="btn btn-sm btn-secondary" onClick={selectAll} style={{ fontSize: '0.7rem', padding: '0.25rem 0.5rem' }}>
            {permanentPlayers.every(p => selectedIds.has(p.id)) ? 'Deselect All' : 'Select All'}
          </button>
        )}
      </div>

      {error && (
        <div style={{ background: 'rgba(239, 68, 68, 0.1)', padding: '0.5rem', borderRadius: '6px', marginBottom: '0.5rem', borderLeft: '3px solid var(--danger)' }}>
          <p style={{ color: 'var(--danger)', fontSize: '0.85rem', margin: 0 }}>{error}</p>
        </div>
      )}

      {/* Permanent Players */}
      <div className="card" style={{ padding: '0.6rem', marginBottom: '0.6rem' }}>
        {permanentPlayers.length === 0 && permanentGuestPlayers.length === 0 && guestPlayers.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '0.75rem' }}>
            <div style={{ fontSize: '1.5rem' }}>👥</div>
            <p style={{ margin: '0.25rem 0', fontWeight: '500', fontSize: '0.9rem' }}>No players yet</p>
          </div>
        ) : (
          <>
            {permanentPlayers.length > 0 && (
              <div style={{ 
                display: 'grid', 
                gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))',
                gap: '0.5rem'
              }}>
                {permanentPlayers.map(renderPlayerTile)}
              </div>
            )}
          </>
        )}

        <button 
          onClick={() => setShowAddPlayer(true)}
          style={{
            width: '100%',
            marginTop: permanentPlayers.length > 0 ? '0.6rem' : '0',
            padding: '0.4rem',
            border: '2px dashed var(--border)',
            borderRadius: '6px',
            background: 'transparent',
            color: 'var(--text-muted)',
            fontSize: '0.8rem',
            cursor: 'pointer'
          }}
        >
          + Add Player
        </button>
      </div>

      {/* Guests Section */}
      {permanentGuestPlayers.length > 0 && (
        <div className="card" style={{ padding: '0.6rem', marginBottom: '0.6rem' }}>
          <button
            onClick={() => setShowPermanentGuests(!showPermanentGuests)}
            style={{
              width: '100%',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
              color: 'var(--text)'
            }}
          >
            <span style={{ fontSize: '0.85rem', fontWeight: '600', color: 'var(--text-muted)' }}>
              🏠 אורח ({permanentGuestPlayers.length})
            </span>
            <span style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>
              {showPermanentGuests ? '▲' : '▼'}
            </span>
          </button>
          
          {showPermanentGuests && (
            <div style={{ 
              display: 'grid', 
              gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))',
              gap: '0.5rem',
              marginTop: '0.5rem'
            }}>
              {permanentGuestPlayers.map(renderPlayerTile)}
            </div>
          )}
        </div>
      )}

      {/* Occasional Players Section */}
      {guestPlayers.length > 0 && (
        <div className="card" style={{ padding: '0.6rem', marginBottom: '0.6rem' }}>
          <button
            onClick={() => setShowGuests(!showGuests)}
            style={{
              width: '100%',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
              color: 'var(--text)'
            }}
          >
            <span style={{ fontSize: '0.85rem', fontWeight: '600', color: 'var(--text-muted)' }}>
              👤 מזדמן ({guestPlayers.length})
            </span>
            <span style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>
              {showGuests ? '▲' : '▼'}
            </span>
          </button>
          
          {showGuests && (
            <div style={{ 
              display: 'grid', 
              gridTemplateColumns: 'repeat(auto-fill, minmax(90px, 1fr))',
              gap: '0.5rem',
              marginTop: '0.5rem'
            }}>
              {guestPlayers.map(renderPlayerTile)}
            </div>
          )}
        </div>
      )}

      {/* Location Selector */}
      <div className="card" style={{ padding: '0.6rem', marginBottom: '0.6rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', marginRight: '0.2rem' }}>📍 מיקום:</span>
          {LOCATION_OPTIONS.map(loc => (
            <button
              key={loc}
              onClick={() => { setGameLocation(gameLocation === loc ? '' : loc); setCustomLocation(''); }}
              style={{
                padding: '0.25rem 0.4rem',
                borderRadius: '6px',
                fontSize: '0.7rem',
                border: gameLocation === loc ? '2px solid var(--primary)' : '1px solid var(--border)',
                background: gameLocation === loc ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
                color: gameLocation === loc ? 'var(--primary)' : 'var(--text-muted)',
                cursor: 'pointer'
              }}
            >
              {loc}
            </button>
          ))}
          <button
            onClick={() => setGameLocation(gameLocation === 'other' ? '' : 'other')}
            style={{
              padding: '0.25rem 0.4rem',
              borderRadius: '6px',
              fontSize: '0.7rem',
              border: gameLocation === 'other' ? '2px solid var(--primary)' : '1px solid var(--border)',
              background: gameLocation === 'other' ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
              color: gameLocation === 'other' ? 'var(--primary)' : 'var(--text-muted)',
              cursor: 'pointer'
            }}
          >
            אחר
          </button>
        </div>
        {gameLocation === 'other' && (
          <input
            type="text"
            value={customLocation}
            onChange={(e) => setCustomLocation(e.target.value)}
            placeholder="הזן מיקום..."
            style={{
              marginTop: '0.4rem',
              width: '100%',
              padding: '0.4rem',
              borderRadius: '6px',
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              color: 'var(--text)',
              fontSize: '0.8rem'
            }}
          />
        )}
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
        {isAdmin && (
          <button 
            className="btn btn-secondary"
            onClick={handleShowForecast}
            disabled={selectedIds.size < 2}
            style={{ padding: '0.6rem', flex: '1', fontSize: '0.85rem' }}
          >
            🔮 Forecast
          </button>
        )}
        <button 
          className="btn btn-primary"
          onClick={handleStartGame}
          disabled={selectedIds.size < 2}
          style={{ padding: '0.6rem', flex: isAdmin ? '2' : '1', fontSize: '0.9rem' }}
        >
          🎰 Start Game ({selectedIds.size})
        </button>
      </div>

      {/* Add Player Modal */}
      {showAddPlayer && (
        <div className="modal-overlay" onClick={() => setShowAddPlayer(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Add New Player</h3>
              <button className="modal-close" onClick={() => setShowAddPlayer(false)}>×</button>
            </div>
            <div className="input-group">
              <label className="label">Player Name</label>
              <input
                type="text"
                className="input"
                placeholder="Enter name"
                value={newPlayerName}
                onChange={e => setNewPlayerName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddPlayer()}
                autoFocus
              />
            </div>
            
            {/* Player Type Toggle */}
            <div className="input-group">
              <label className="label">Player Type</label>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={() => setNewPlayerType('permanent')}
                  style={{
                    flex: 1,
                    minWidth: '80px',
                    padding: '0.5rem',
                    borderRadius: '8px',
                    border: newPlayerType === 'permanent' ? '2px solid var(--primary)' : '2px solid var(--border)',
                    background: newPlayerType === 'permanent' ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
                    color: newPlayerType === 'permanent' ? 'var(--primary)' : 'var(--text-muted)',
                    cursor: 'pointer',
                    fontWeight: '600',
                    fontSize: '0.75rem'
                  }}
                >
                  ⭐ Permanent
                </button>
                <button
                  type="button"
                  onClick={() => setNewPlayerType('permanent_guest')}
                  style={{
                    flex: 1,
                    minWidth: '80px',
                    padding: '0.5rem',
                    borderRadius: '8px',
                    border: newPlayerType === 'permanent_guest' ? '2px solid var(--text-muted)' : '2px solid var(--border)',
                    background: newPlayerType === 'permanent_guest' ? 'rgba(100, 100, 100, 0.15)' : 'var(--surface)',
                    color: newPlayerType === 'permanent_guest' ? 'var(--text)' : 'var(--text-muted)',
                    cursor: 'pointer',
                    fontWeight: '600',
                    fontSize: '0.75rem'
                  }}
                >
                  🏠 אורח
                </button>
                <button
                  type="button"
                  onClick={() => setNewPlayerType('guest')}
                  style={{
                    flex: 1,
                    minWidth: '80px',
                    padding: '0.5rem',
                    borderRadius: '8px',
                    border: newPlayerType === 'guest' ? '2px solid var(--primary)' : '2px solid var(--border)',
                    background: newPlayerType === 'guest' ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
                    color: newPlayerType === 'guest' ? 'var(--primary)' : 'var(--text-muted)',
                    cursor: 'pointer',
                    fontWeight: '600',
                    fontSize: '0.75rem'
                  }}
                >
                  👤 מזדמן
                </button>
              </div>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.35rem' }}>
                {newPlayerType === 'permanent' && 'רשימה ראשית - חברי הקבוצה הקבועים'}
                {newPlayerType === 'permanent_guest' && 'אורח קבוע שמגיע לעתים קרובות'}
                {newPlayerType === 'guest' && 'שחקן מזדמן שמגיע לפעמים'}
              </p>
            </div>

            <div className="actions">
              <button className="btn btn-secondary" onClick={() => setShowAddPlayer(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={handleAddPlayer}>
                Add Player
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Forecast Modal - AI or Static */}
      {showForecast && (
        <div className="modal-overlay" onClick={() => { setShowForecast(false); setCachedForecasts(null); setAiForecasts(null); setAiError(null); }}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxHeight: '85vh', overflow: 'auto', maxWidth: '420px' }}>
            {/* Loading state for AI */}
            {isLoadingAI && (
              <div style={{ padding: '3rem 2rem', textAlign: 'center' }}>
                <div style={{ fontSize: '3rem', marginBottom: '1rem', animation: 'pulse 1.5s ease-in-out infinite' }}>🤖</div>
                <h3 style={{ margin: '0 0 0.5rem', color: 'var(--text)' }}>AI מנתח נתונים...</h3>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>יוצר תחזית מותאמת אישית</p>
              </div>
            )}
            
            {/* AI Error message with countdown */}
            {aiError && (
              <div style={{ 
                padding: '0.75rem', 
                margin: '0.75rem',
                borderRadius: '8px', 
                background: retryCountdown ? 'rgba(59, 130, 246, 0.1)' : 'rgba(234, 179, 8, 0.1)', 
                borderLeft: `4px solid ${retryCountdown ? '#3B82F6' : '#EAB308'}`,
                fontSize: '0.85rem',
                color: retryCountdown ? '#3B82F6' : '#EAB308'
              }}>
                {retryCountdown ? (
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '1.5rem', fontWeight: 'bold', marginBottom: '0.25rem' }}>
                      ⏳ {retryCountdown}s
                    </div>
                    <div>Rate limit - waiting to retry...</div>
                    <div style={{ marginTop: '0.5rem' }}>
                      <button
                        onClick={() => { 
                          setShowForecast(false); 
                          setAiError(null);
                          setRetryCountdown(null);
                          if (retryTimerRef.current) clearInterval(retryTimerRef.current);
                        }}
                        style={{
                          padding: '0.4rem 0.8rem',
                          fontSize: '0.8rem',
                          background: 'transparent',
                          border: '1px solid #3B82F6',
                          borderRadius: '6px',
                          color: '#3B82F6',
                          cursor: 'pointer'
                        }}
                      >
                        Use Static Forecast Instead
                      </button>
                    </div>
                  </div>
                ) : (
                  <>⚠️ {aiError}</>
                )}
              </div>
            )}
            
            {/* AI Forecasts */}
            {aiForecasts && !isLoadingAI && (
              <div ref={forecastRef} style={{ padding: '1.25rem', background: '#1a1a2e', borderRadius: '12px' }}>
                {/* Header with AI badge */}
                <div style={{ textAlign: 'center', marginBottom: '1.25rem' }}>
                  <div style={{ fontSize: '2rem', marginBottom: '0.25rem' }}>🤖</div>
                  <h3 style={{ margin: 0, fontSize: '1.2rem', fontWeight: '700', color: 'var(--text)' }}>
                    תחזית AI
                  </h3>
                  <div style={{ fontSize: '0.75rem', color: '#A855F7', marginTop: '0.25rem' }}>
                    Powered by Gemini ✨
                  </div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                    {new Date().toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' })}
                  </div>
                </div>

                {/* AI Player forecasts - sorted by expected profit (highest first) */}
                <div style={{ marginBottom: '1rem' }}>
                  {[...aiForecasts].sort((a, b) => b.expectedProfit - a.expectedProfit).map((forecast, index) => {
                    const { name, expectedProfit, sentence, highlight, isSurprise } = forecast;
                    
                    const getStyle = () => {
                      if (isSurprise) return { bg: 'rgba(168, 85, 247, 0.15)', border: '#a855f7', text: '#a855f7' };
                      if (expectedProfit > 10) return { bg: 'rgba(34, 197, 94, 0.12)', border: '#22c55e', text: '#22c55e' };
                      if (expectedProfit < -10) return { bg: 'rgba(239, 68, 68, 0.12)', border: '#ef4444', text: '#ef4444' };
                      return { bg: 'rgba(100, 116, 139, 0.12)', border: '#64748b', text: 'var(--text)' };
                    };
                    
                    const style = getStyle();
                    
                    return (
                      <div 
                        key={name}
                        style={{
                          padding: '0.75rem 0.85rem',
                          marginBottom: '0.5rem',
                          borderRadius: '10px',
                          background: style.bg,
                          borderRight: `4px solid ${style.border}`,
                        }}
                      >
                        {/* Name and amount */}
                        <div style={{ 
                          display: 'flex', 
                          justifyContent: 'space-between', 
                          alignItems: 'center',
                          marginBottom: '0.4rem'
                        }}>
                          <span style={{ 
                            fontWeight: '700', 
                            fontSize: '1rem',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.3rem'
                          }}>
                            {index === 0 && expectedProfit > 0 && <span>👑</span>}
                            {name}
                            {isSurprise && <span>⚡</span>}
                          </span>
                          <span style={{ 
                            fontWeight: '700', 
                            fontSize: '1.05rem',
                            color: style.text,
                            fontFamily: 'system-ui'
                          }}>
                            {expectedProfit >= 0 ? '+' : ''}₪{cleanNumber(Math.abs(expectedProfit))}
                          </span>
                        </div>
                        
                        {/* AI Highlight */}
                        {highlight && (
                          <div style={{ 
                            fontSize: '0.78rem', 
                            color: 'var(--text)',
                            opacity: 0.8,
                            marginBottom: '0.4rem',
                            direction: 'rtl',
                            fontFamily: 'system-ui',
                            lineHeight: '1.4'
                          }}>
                            {highlight}
                          </div>
                        )}
                        
                        {/* AI Creative sentence */}
                        <div style={{ 
                          fontSize: '0.85rem', 
                          color: isSurprise ? '#a855f7' : 'var(--text-muted)',
                          lineHeight: '1.45',
                          direction: 'rtl',
                          fontStyle: 'italic'
                        }}>
                          {sentence}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Footer */}
                <div style={{ 
                  textAlign: 'center', 
                  marginTop: '0.75rem', 
                  fontSize: '0.65rem', 
                  color: 'var(--text-muted)',
                  opacity: 0.5
                }}>
                  Poker Manager 🎲 + AI
                </div>
              </div>
            )}

            {/* Static Forecasts (fallback) */}
            {cachedForecasts && !aiForecasts && !isLoadingAI && (
              <div ref={forecastRef} style={{ padding: '1.25rem', background: '#1a1a2e', borderRadius: '12px' }}>
                {/* Header */}
                <div style={{ textAlign: 'center', marginBottom: '1.25rem' }}>
                  <div style={{ fontSize: '2rem', marginBottom: '0.25rem' }}>🔮</div>
                  <h3 style={{ margin: 0, fontSize: '1.2rem', fontWeight: '700', color: 'var(--text)' }}>
                    תחזית הלילה
                  </h3>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                    {new Date().toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' })}
                  </div>
                </div>

                {/* Player forecasts - sorted by expected profit (highest first) */}
                <div style={{ marginBottom: '1rem' }}>
                  {[...cachedForecasts].sort((a, b) => b.expected - a.expected).map((forecast, index) => {
                    const { player, expected, sentence, highlights, gamesPlayed, isSurprise } = forecast;
                    
                    const getStyle = () => {
                      if (isSurprise) return { bg: 'rgba(168, 85, 247, 0.15)', border: '#a855f7', text: '#a855f7' };
                      if (expected > 10) return { bg: 'rgba(34, 197, 94, 0.12)', border: '#22c55e', text: '#22c55e' };
                      if (expected < -10) return { bg: 'rgba(239, 68, 68, 0.12)', border: '#ef4444', text: '#ef4444' };
                      return { bg: 'rgba(100, 116, 139, 0.12)', border: '#64748b', text: 'var(--text)' };
                    };
                    
                    const style = getStyle();
                    
                    return (
                      <div 
                        key={player.id}
                        style={{
                          padding: '0.75rem 0.85rem',
                          marginBottom: '0.5rem',
                          borderRadius: '10px',
                          background: style.bg,
                          borderRight: `4px solid ${style.border}`,
                        }}
                      >
                        {/* Name and amount */}
                        <div style={{ 
                          display: 'flex', 
                          justifyContent: 'space-between', 
                          alignItems: 'center',
                          marginBottom: '0.4rem'
                        }}>
                          <span style={{ 
                            fontWeight: '700', 
                            fontSize: '1rem',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.3rem'
                          }}>
                            {index === 0 && expected > 0 && <span>👑</span>}
                            {player.name}
                          </span>
                          <span style={{ 
                            fontWeight: '700', 
                            fontSize: '1.05rem',
                            color: style.text,
                            fontFamily: 'system-ui'
                          }}>
                            {expected >= 0 ? '+' : ''}₪{cleanNumber(Math.abs(expected))}
                          </span>
                        </div>
                        
                        {/* Dynamic personalized highlight */}
                        {gamesPlayed > 0 && highlights && (
                          <div style={{ 
                            fontSize: '0.78rem', 
                            color: 'var(--text)',
                            opacity: 0.8,
                            marginBottom: '0.4rem',
                            direction: 'rtl',
                            fontFamily: 'system-ui',
                            lineHeight: '1.4'
                          }}>
                            {highlights}
                          </div>
                        )}
                        
                        {/* Creative forecast sentence */}
                        <div style={{ 
                          fontSize: '0.85rem', 
                          color: isSurprise ? '#a855f7' : 'var(--text-muted)',
                          lineHeight: '1.45',
                          direction: 'rtl',
                          fontStyle: 'italic'
                        }}>
                          {sentence}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Legend */}
                <div style={{ 
                  display: 'flex', 
                  justifyContent: 'center',
                  gap: '1.25rem',
                  fontSize: '0.7rem',
                  color: 'var(--text-muted)',
                  paddingTop: '0.75rem',
                  borderTop: '1px solid rgba(255,255,255,0.1)'
                }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                    <span style={{ width: '10px', height: '10px', borderRadius: '3px', background: '#22c55e' }}></span>
                    רווח צפוי
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                    <span style={{ width: '10px', height: '10px', borderRadius: '3px', background: '#ef4444' }}></span>
                    הפסד צפוי
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                    <span style={{ width: '10px', height: '10px', borderRadius: '3px', background: '#a855f7' }}></span>
                    ⚡ הפתעה
                  </span>
                </div>

                {/* Footer */}
                <div style={{ 
                  textAlign: 'center', 
                  marginTop: '0.75rem', 
                  fontSize: '0.65rem', 
                  color: 'var(--text-muted)',
                  opacity: 0.5
                }}>
                  Poker Manager 🎲
                </div>
              </div>
            )}

            {/* Action buttons - outside screenshot */}
            {(aiForecasts || cachedForecasts) && !isLoadingAI && (
              <div className="actions" style={{ marginTop: '1rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border)' }}>
                <button 
                  className="btn btn-secondary" 
                  onClick={() => { setShowForecast(false); setCachedForecasts(null); setAiForecasts(null); setAiError(null); }}
                >
                  סגור
                </button>
                <button 
                  className="btn btn-primary" 
                  onClick={shareForecast}
                  disabled={isSharing}
                >
                  {isSharing ? '📸...' : '📤 שתף'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      
      {/* Share Forecast Prompt Modal */}
      {showSharePrompt && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.8)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000,
          padding: '1rem'
        }}>
          <div style={{
            background: 'var(--card-bg)',
            borderRadius: '16px',
            padding: '1.5rem',
            maxWidth: '320px',
            width: '100%',
            textAlign: 'center'
          }}>
            <div style={{ fontSize: '3rem', marginBottom: '0.75rem' }}>🎲</div>
            <h3 style={{ marginBottom: '0.5rem', color: 'var(--text)' }}>המשחק התחיל!</h3>
            <p style={{ marginBottom: '1.25rem', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
              לשתף את התחזית בקבוצה לפני שמתחילים?
            </p>
            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
              <button 
                className="btn btn-secondary"
                onClick={handleSkipShare}
                style={{ flex: 1 }}
              >
                דלג
              </button>
              <button 
                className="btn btn-primary"
                onClick={handleShareAndStart}
                disabled={isSharing}
                style={{ flex: 1 }}
              >
                {isSharing ? '📸...' : '📤 שתף'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default NewGameScreen;