import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import html2canvas from 'html2canvas';
import { Player, PlayerType, PlayerStats, GameForecast, Game } from '../types';
import { getAllPlayers, addPlayer, createGame, getPlayerByName, getPlayerStats, savePendingForecast, getPendingForecast, clearPendingForecast, checkForecastMatch, linkForecastToGame, publishPendingForecast, getActiveGame, getGamePlayers, deleteGame, getAllGames, getAllGamePlayers, getSettings, updateGame, saveTTSPool } from '../database/storage';
import { cleanNumber } from '../utils/calculations';
import { usePermissions } from '../App';
import { generateAIForecasts, getGeminiApiKey, getLastUsedModel, getModelDisplayName, PlayerForecastData, ForecastResult, GlobalRankingContext, detectPeriodMarkers, generateLiveGameTTSPool } from '../utils/geminiAI';
import { getComboHistory, buildComboHistoryText, ComboHistory } from '../utils/comboHistory';
import AIProgressBar from '../components/AIProgressBar';
import { withAITiming } from '../utils/aiTiming';

import { PeriodMarkers } from '../types';

const DEFAULT_LOCATIONS = ['ליאור', 'סגל', 'ליכטר', 'מקלט ליכטר', 'אייל'];

const getNextGameNightDate = (gameNightDays: number[]): Date => {
  const now = new Date();
  const today = now.getDay();
  if (gameNightDays.includes(today)) return now;
  for (let offset = 1; offset <= 7; offset++) {
    const candidate = new Date(now);
    candidate.setDate(now.getDate() + offset);
    if (gameNightDays.includes(candidate.getDay())) return candidate;
  }
  return now;
};

const PERIOD_OPTIONS: { value: string; label: string; getMarkerOverrides: () => Partial<PeriodMarkers> }[] = [
  { value: 'regular', label: '🎮 משחק רגיל', getMarkerOverrides: () => ({ isFirstGameOfMonth: false, isLastGameOfMonth: false, isFirstGameOfHalf: false, isLastGameOfHalf: false, isFirstGameOfYear: false, isLastGameOfYear: false }) },
  { value: 'firstMonth', label: '🗓️ ראשון בחודש', getMarkerOverrides: () => ({ isFirstGameOfMonth: true, isLastGameOfMonth: false }) },
  { value: 'lastMonth', label: '🗓️ אחרון בחודש', getMarkerOverrides: () => ({ isLastGameOfMonth: true, isFirstGameOfMonth: false }) },
  { value: 'firstHalf', label: '🚀 פתיחת מחצית', getMarkerOverrides: () => ({ isFirstGameOfHalf: true, isFirstGameOfMonth: true, isLastGameOfHalf: false }) },
  { value: 'lastHalf', label: '🏁 סגירת מחצית', getMarkerOverrides: () => ({ isLastGameOfHalf: true, isLastGameOfMonth: true, isFirstGameOfHalf: false }) },
  { value: 'firstYear', label: '🎆 פתיחת שנה', getMarkerOverrides: () => ({ isFirstGameOfYear: true, isFirstGameOfHalf: true, isFirstGameOfMonth: true, isLastGameOfYear: false }) },
  { value: 'lastYear', label: '🎇 סגירת שנה', getMarkerOverrides: () => ({ isLastGameOfYear: true, isLastGameOfHalf: true, isLastGameOfMonth: true, isFirstGameOfYear: false }) },
];

const getAutoDetectedPeriodValue = (markers: PeriodMarkers): string => {
  if (markers.isFirstGameOfYear) return 'firstYear';
  if (markers.isLastGameOfYear) return 'lastYear';
  if (markers.isFirstGameOfHalf) return 'firstHalf';
  if (markers.isLastGameOfHalf) return 'lastHalf';
  if (markers.isFirstGameOfMonth) return 'firstMonth';
  if (markers.isLastGameOfMonth) return 'lastMonth';
  return 'regular';
};

const applyPeriodOverride = (base: PeriodMarkers, override: string | null): PeriodMarkers => {
  if (!override) return base;
  const option = PERIOD_OPTIONS.find(o => o.value === override);
  if (!option) return base;
  return { ...base, ...option.getMarkerOverrides() };
};

const NewGameScreen = () => {
  const navigate = useNavigate();
  const { role, signOut } = usePermissions();
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
  const [showSharePrompt, _setShowSharePrompt] = useState(false);
  const [pendingGameId, _setPendingGameId] = useState<string | null>(null);
  const [playerStats, setPlayerStats] = useState<PlayerStats[]>([]);
  const [gameLocation, setGameLocation] = useState<string>('');
  const [customLocation, setCustomLocation] = useState<string>('');
  const [isSharing, setIsSharing] = useState(false);
  const [cachedForecasts, setCachedForecasts] = useState<ReturnType<typeof generateForecasts> | null>(null);
  const [aiForecasts, setAiForecasts] = useState<ForecastResult[] | null>(null);
  const [comboHistory, setComboHistory] = useState<ComboHistory | null>(null);
  const [isLoadingAI, setIsLoadingAI] = useState(false);
  const [aiModelName, setAiModelName] = useState<string>('');
  const [aiError, setAiError] = useState<string | null>(null);
  const [retryCountdown, setRetryCountdown] = useState<number | null>(null);
  const [showMismatchDialog, setShowMismatchDialog] = useState(false);
  const [mismatchInfo, setMismatchInfo] = useState<{
    addedPlayers: string[];
    removedPlayers: string[];
    pendingDate: string;
  } | null>(null);
  const [activeGame, setActiveGame] = useState<Game | null>(null);
  const [activeGamePlayers, setActiveGamePlayers] = useState<string[]>([]);
  const [showAbandonConfirm, setShowAbandonConfirm] = useState(false);
  const [periodMarkers, setPeriodMarkers] = useState<PeriodMarkers | null>(null);
  const [periodOverride, setPeriodOverride] = useState<string | null>(null); // null = auto-detect
  const [showPeriodDropdown, setShowPeriodDropdown] = useState(false);
  const [publishedForecast, setPublishedForecast] = useState<ReturnType<typeof getPendingForecast>>(null);
  const forecastRef = useRef<HTMLDivElement>(null);
  const retryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    loadPlayers();
    checkForActiveGame();
    // Load published forecast if exists
    const pending = getPendingForecast();
    if (pending?.published && !pending.linkedGameId) {
      setPublishedForecast(pending);
    }
    // Auto-detect period markers
    try {
      const settings = getSettings();
      const allGames = getAllGames();
      const days = settings.gameNightDays || [4, 6];
      const markers = detectPeriodMarkers(getNextGameNightDate(days), allGames, days);
      setPeriodMarkers(markers);
    } catch (e) { console.warn('Period detection failed:', e); }
    return () => {
      if (retryTimerRef.current) clearInterval(retryTimerRef.current);
    };
  }, []);

  const checkForActiveGame = () => {
    const active = getActiveGame();
    if (active) {
      setActiveGame(active);
      const gamePlayers = getGamePlayers(active.id);
      setActiveGamePlayers(gamePlayers.map(gp => gp.playerName));
    } else {
      setActiveGame(null);
      setActiveGamePlayers([]);
    }
  };

  const handleResumeGame = () => {
    if (!activeGame) return;
    if (activeGame.status === 'live') {
      navigate(`/live-game/${activeGame.id}`);
    } else if (activeGame.status === 'chip_entry') {
      navigate(`/chip-entry/${activeGame.id}`);
    }
  };

  const handleAbandonGame = () => {
    if (!activeGame) return;
    deleteGame(activeGame.id);
    setActiveGame(null);
    setActiveGamePlayers([]);
    setShowAbandonConfirm(false);
  };

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

    if (getActiveGame()) {
      setError('There is already an active game. Resume or abandon it first.');
      return;
    }
    
    // Validate location is selected
    const location = gameLocation === 'other' ? customLocation.trim() : gameLocation;
    if (!location) {
      setError('Please select a game location');
      return;
    }
    
    // Check if there's a pending forecast
    const { matches, pending, addedPlayers, removedPlayers } = checkForecastMatch(Array.from(selectedIds));
    
    if (pending) {
      if (matches) {
        // 100% match - auto-link and proceed
        startGameWithForecast(pending.forecasts);
      } else {
        // Mismatch - show dialog
        const addedNames = addedPlayers.map(id => players.find(p => p.id === id)?.name || id);
        const removedNames = removedPlayers.map(id => {
          // Find name from pending forecast
          const forecast = pending.forecasts.find(f => {
            const player = players.find(p => p.name === f.playerName);
            return player?.id === id;
          });
          return forecast?.playerName || id;
        });
        
        setMismatchInfo({
          addedPlayers: addedNames,
          removedPlayers: removedNames,
          pendingDate: new Date(pending.createdAt).toLocaleDateString('he-IL', { 
            weekday: 'short', 
            day: 'numeric', 
            month: 'short',
            hour: '2-digit',
            minute: '2-digit'
          })
        });
        setShowMismatchDialog(true);
      }
    } else {
      // No pending forecast - just start game
      startGameWithForecast(undefined);
    }
  };
  
  const [generatingTTS, setGeneratingTTS] = useState(false);

  const startGameWithForecast = async (forecasts?: GameForecast[]) => {
    const location = gameLocation === 'other' ? customLocation.trim() : gameLocation;
    const game = createGame(Array.from(selectedIds), location || undefined, forecasts);
    
    if (forecasts) {
      linkForecastToGame(game.id);
    }
    clearPendingForecast();
    setPublishedForecast(null);

    if (periodMarkers) {
      updateGame(game.id, { periodMarkers });
    }

    const apiKey = getGeminiApiKey();
    if (apiKey) {
      setGeneratingTTS(true);
      try {
        const stats2026 = getPlayerStats({ start: new Date('2026-01-01') });
        const playerIdArr = Array.from(selectedIds);
        const playerNameArr = playerIdArr.map(id => players.find(p => p.id === id)?.name || '');
        const pool = await withAITiming('tts_pool', () => generateLiveGameTTSPool(game.id, playerIdArr, playerNameArr, stats2026, location || undefined));
        if (pool) {
          const ttsModel = getModelDisplayName(getLastUsedModel());
          saveTTSPool(game.id, pool, ttsModel);
          console.log('🎙️ TTS pool saved for game', game.id, `(model: ${ttsModel})`);
        }
      } catch (err) {
        console.warn('TTS pool generation failed (non-blocking):', err);
      } finally {
        setGeneratingTTS(false);
      }
    }
    
    navigate(`/live-game/${game.id}`);
  };
  
  // Handle mismatch: Generate new forecast
  const handleUpdateForecast = () => {
    setShowMismatchDialog(false);
    clearPendingForecast();
    setPublishedForecast(null);
    handleShowForecast(); // Generate new forecast for current players
  };
  
  // Handle mismatch: Keep old forecast (only compare matching players)
  const handleKeepOldForecast = () => {
    setShowMismatchDialog(false);
    const pending = getPendingForecast();
    if (pending) {
      startGameWithForecast(pending.forecasts);
    }
  };
  
  // Handle mismatch: Start without forecast
  const handleStartWithoutForecast = () => {
    setShowMismatchDialog(false);
    clearPendingForecast();
    setPublishedForecast(null);
    startGameWithForecast(undefined);
  };
  
  const handlePublishForecast = () => {
    publishPendingForecast(true);
    setPublishedForecast(getPendingForecast());
  };

  const handleUnpublishForecast = () => {
    publishPendingForecast(false);
    setPublishedForecast(null);
  };

  const handleDeleteForecast = () => {
    clearPendingForecast();
    setPublishedForecast(null);
  };

  const handleSharePublished = () => {
    if (!publishedForecast) return;
    const restored: ForecastResult[] = publishedForecast.forecasts.map((f, i) => ({
      name: f.playerName,
      expectedProfit: f.expectedProfit,
      highlight: f.highlight || '',
      sentence: f.sentence || '',
      isSurprise: f.isSurprise || false,
      preGameTeaser: i === 0 ? (publishedForecast.preGameTeaser || '') : '',
    }));
    setAiForecasts(restored);
    if (publishedForecast.aiModel) setAiModelName(publishedForecast.aiModel);
    setShowForecast(true);
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
  
  const isFemale = (name: string): boolean => {
    const player = players.find(p => p.name === name);
    return player?.gender === 'female';
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
  const generateDynamicHighlight = (stats: PlayerStats, daysSince: number, playerName: string): string => {
    const lastGames = stats.lastGameResults || [];
    const gamesCount = lastGames.length;
    if (gamesCount === 0) return '';
    
    const fem = isFemale(playerName);
    const g = (m: string, f: string) => fem ? f : m;
    
    const recentWins = lastGames.filter(g2 => g2.profit > 0).length;
    const recentLosses = lastGames.filter(g2 => g2.profit < 0).length;
    const recentProfit = lastGames.reduce((sum, g2) => sum + g2.profit, 0);
    const recentAvg = Math.round(recentProfit / gamesCount);
    const overallAvg = Math.round(stats.avgProfit);
    const streak = stats.currentStreak;
    const winPct = Math.round(stats.winPercentage);
    const totalProfit = Math.round(stats.totalProfit);
    const totalGames = stats.gamesPlayed;
    
    // Find best and worst games
    const bestRecent = Math.max(...lastGames.map(g2 => g2.profit));
    const worstRecent = Math.min(...lastGames.map(g2 => g2.profit));
    
    // Determine time context
    const isActive = daysSince <= 60; // played in last 2 months
    const monthsAgo = Math.floor(daysSince / 30);
    
    // Collect all possible insights with CORRECT time context
    const insights: { priority: number; text: string }[] = [];
    
    // === ACTIVE PLAYERS (played recently) ===
    if (isActive) {
      // HOT STREAK
      if (streak >= 4) {
        insights.push({ priority: 100, text: `🔥 רצף מטורף של ${streak} נצחונות! ${g('השחקן הכי חם', 'השחקנית הכי חמה')} כרגע על השולחן` });
        insights.push({ priority: 98, text: `🔥 ${streak} נצחונות ברצף - מישהו צריך ${g('לעצור אותו לפני שהוא לוקח', 'לעצור אותה לפני שהיא לוקחת')} את כל הכסף` });
      } else if (streak >= 3) {
        insights.push({ priority: 95, text: `🔥 על גל חם עם ${streak} נצחונות רצופים - המומנטום ${g('לצידו', 'לצידה')}` });
        insights.push({ priority: 93, text: `🔥 ${streak} נצחונות ברצף, והביטחון ${g('שלו', 'שלה')} בשמיים` });
      } else if (streak === 2) {
        insights.push({ priority: 60, text: `שני נצחונות רצופים - אולי תחילת רצף חם?` });
      }
      
      // COLD STREAK  
      if (streak <= -4) {
        insights.push({ priority: 100, text: `❄️ ${Math.abs(streak)} הפסדים ברצף - תקופה קשה, אבל כל רצף נשבר מתישהו` });
        insights.push({ priority: 98, text: `❄️ רצף של ${Math.abs(streak)} הפסדים. המזל חייב להשתנות, לא?` });
      } else if (streak <= -3) {
        insights.push({ priority: 95, text: `❄️ ${Math.abs(streak)} הפסדים רצופים - ${g('צריך', 'צריכה')} שינוי מזל דחוף` });
      } else if (streak === -2) {
        insights.push({ priority: 60, text: `שני הפסדים אחרונים - הפעם ההזדמנות לשבור את הרצף` });
      }
      
      // IMPROVEMENT vs HISTORY (only if active)
      if (recentAvg > overallAvg + 30) {
        insights.push({ priority: 90, text: `📈 שיפור דרמטי! ממוצע של +${recentAvg}₪ במשחקים האחרונים, הרבה מעל הממוצע ההיסטורי (${overallAvg}₪)` });
      } else if (recentAvg > overallAvg + 15 && gamesCount >= 4) {
        insights.push({ priority: 75, text: `📈 בעלייה ברורה: ממוצע ${recentAvg > 0 ? '+' : ''}${recentAvg}₪ במשחקים האחרונים לעומת ${overallAvg}₪ בסה"כ` });
      }
      
      // DECLINE vs HISTORY (only if active)
      if (recentAvg < overallAvg - 30) {
        insights.push({ priority: 90, text: `📉 ירידה חדה! ממוצע ${recentAvg}₪ במשחקים האחרונים - הרבה מתחת לממוצע ההיסטורי (${overallAvg > 0 ? '+' : ''}${overallAvg}₪)` });
      } else if (recentAvg < overallAvg - 15 && gamesCount >= 4) {
        insights.push({ priority: 75, text: `📉 ירידה בביצועים: ${recentAvg}₪ ממוצע במשחקים האחרונים, לעומת ${overallAvg > 0 ? '+' : ''}${overallAvg}₪ היסטורית` });
      }
      
      // DOMINANT PERFORMANCE
      if (recentWins >= gamesCount - 1 && gamesCount >= 4) {
        insights.push({ priority: 85, text: `שליטה מוחלטת: ${recentWins} מתוך ${gamesCount} משחקים אחרונים ${g('סיים', 'סיימה')} ברווח!` });
      } else if (recentLosses >= gamesCount - 1 && gamesCount >= 4) {
        insights.push({ priority: 85, text: `${g('מתקשה', 'מתקשה')} מאוד: רק ${recentWins} מתוך ${gamesCount} משחקים אחרונים ברווח` });
      }
    }
    
    // === INACTIVE PLAYERS (haven't played in a while) - SARCASTIC! ===
    else {
      // Time since last game - with cynicism!
      if (monthsAgo >= 12) {
        insights.push({ priority: 95, text: `👻 ${g('נעלם', 'נעלמה')} לשנה שלמה! ${g('חשבנו שעבר', 'חשבנו שעברה')} דירה או משהו. מתברר שסתם ${g('שכח', 'שכחה')} אותנו` });
        insights.push({ priority: 93, text: `⏰ שנה בלי משחק?! מה קרה, ${g('מצאת', 'מצאת')} קבוצה יותר טובה? (ספוילר: אין)` });
        insights.push({ priority: 91, text: `👻 ${monthsAgo} חודשים! כבר הספקנו ${g('למחוק אותו', 'למחוק אותה')} מהוואטסאפ ולהוסיף מחדש` });
      } else if (monthsAgo >= 6) {
        insights.push({ priority: 90, text: `👻 ${g('נעלם', 'נעלמה')} ל-${monthsAgo} חודשים - בטח ${g('היה עסוק', 'הייתה עסוקה')} בלהפסיד במקומות אחרים` });
        insights.push({ priority: 88, text: `⏰ ${monthsAgo} חודשים בלי ביקור! מה, הארנק היה צריך זמן להתאושש?` });
        insights.push({ priority: 86, text: `👻 חצי שנה מאז שראינו את הפנים - נקווה ${g('שלפחות הביא', 'שלפחות הביאה')} כסף` });
      } else if (monthsAgo >= 3) {
        insights.push({ priority: 85, text: `⏰ ${monthsAgo} חודשים בהיעדרות - בטח ${g('חיכה שנשכח כמה הוא מפסיד', 'חיכתה שנשכח כמה היא מפסידה')}` });
        insights.push({ priority: 83, text: `⏰ היעדרות של ${monthsAgo} חודשים. נקווה ${g('שהתאמן', 'שהתאמנה')} ולא רק בנטפליקס` });
        insights.push({ priority: 81, text: `👻 ${monthsAgo} חודשים! כבר התחלנו לחלק את הכיסא לאחרים` });
      } else {
        insights.push({ priority: 75, text: `⏰ חודשיים בלי משחק - מספיק זמן לשכוח הכל` });
        insights.push({ priority: 73, text: `⏰ לא ${g('היה', 'הייתה')} פה חודשיים. מה קרה, ${g('פחדת', 'פחדת')} מאיתנו?` });
      }
    }
    
    // === HISTORICAL PATTERNS (always relevant) ===
    
    // BIG WINS
    if (bestRecent >= 100) {
      insights.push({ priority: 70, text: `💰 הנצחון הגדול: +${bestRecent}₪ - ${g('מוכיח שכשהוא בפורמה, הוא יכול', 'מוכיחה שכשהיא בפורמה, היא יכולה')} לקחת הרבה` });
    } else if (bestRecent >= 60 && recentAvg < 0) {
      insights.push({ priority: 65, text: `${g('יודע', 'יודעת')} לנצח גדול (+${bestRecent}₪) אבל לא ${g('עקבי', 'עקבית')}` });
    }
    
    // BIG LOSSES
    if (worstRecent <= -100) {
      insights.push({ priority: 70, text: `💸 הפסד כואב של ${worstRecent}₪ - ${g('יודע', 'יודעת')} גם ליפול חזק` });
    } else if (worstRecent <= -60 && recentAvg > 0) {
      insights.push({ priority: 65, text: `${g('גם כשהוא מפסיד, הוא מפסיד', 'גם כשהיא מפסידה, היא מפסידה')} גדול (${worstRecent}₪) - אבל בסופו של דבר ברווח` });
    }
    
    // WIN RATE
    if (winPct >= 65) {
      insights.push({ priority: 70, text: `🎯 אחוז נצחון של ${winPct}% מתוך ${totalGames} משחקים - ${g('שחקן מנצח מובהק', 'שחקנית מנצחת מובהקת')}` });
    } else if (winPct <= 35 && totalGames >= 5) {
      insights.push({ priority: 70, text: `😅 רק ${winPct}% נצחונות מתוך ${totalGames} משחקים - אבל ${g('ממשיך', 'ממשיכה')} לנסות` });
    }
    
    // COMEBACK POTENTIAL
    if (totalProfit < -200 && recentAvg > 10 && isActive) {
      insights.push({ priority: 80, text: `🔄 בדרך לקאמבק? ${g('הפסיד', 'הפסידה')} ${Math.abs(totalProfit)}₪ בסה"כ, אבל בביצועים האחרונים יש שיפור` });
    } else if (totalProfit < -200) {
      insights.push({ priority: 65, text: `📊 ${g('הפסיד', 'הפסידה')} ${Math.abs(totalProfit)}₪ לאורך ההיסטוריה - השאלה אם ${g('הוא למד', 'היא למדה')} משהו` });
    }
    
    // LOSING THE EDGE
    if (totalProfit > 200 && recentAvg < -10 && isActive) {
      insights.push({ priority: 80, text: `⚠️ ${g('היה מרוויח', 'הייתה מרוויחה')} גדול (+${totalProfit}₪ כולל) אבל הביצועים האחרונים מדאיגים` });
    }
    
    // VOLATILE
    if (bestRecent - worstRecent > 150) {
      insights.push({ priority: 55, text: `🎢 ${g('שחקן', 'שחקנית')} של קיצוניות: בין +${bestRecent}₪ ל-${Math.abs(worstRecent)}₪ - ${g('איתו', 'איתה')} אף פעם לא יודעים` });
    }
    
    // TOTAL PROFIT MILESTONES
    if (totalProfit > 500) {
      insights.push({ priority: 50, text: `💎 רווח כולל של +${totalProfit}₪ מ-${totalGames} משחקים - ${g('אחד המנצחים הגדולים', 'אחת המנצחות הגדולות')}` });
      insights.push({ priority: 48, text: `💎 +${totalProfit}₪ בקופה - ההיסטוריה מדברת בעד עצמה` });
    } else if (totalProfit < -500) {
      insights.push({ priority: 50, text: `📊 ${g('הפסיד', 'הפסידה')} ${Math.abs(totalProfit)}₪ לאורך ${totalGames} משחקים - הספונסר שלנו` });
    }
    
    // BALANCED
    if (Math.abs(recentAvg) <= 5 && recentWins === recentLosses && gamesCount >= 4) {
      insights.push({ priority: 50, text: `⚖️ ${g('מאוזן', 'מאוזנת')} להפליא: ${recentWins} נצחונות ו-${recentLosses} הפסדים - לא נוטה לשום כיוון` });
    }
    
    // DEFAULT summaries based on data quality
    if (totalGames >= 10) {
      insights.push({ priority: 35, text: `${totalGames} משחקים בהיסטוריה, ${winPct}% נצחונות, ממוצע ${overallAvg >= 0 ? '+' : ''}${overallAvg}₪ למשחק` });
      insights.push({ priority: 33, text: `${g('שחקן ותיק', 'שחקנית ותיקה')} עם ${totalGames} משחקים: סה"כ ${totalProfit >= 0 ? '+' : ''}${totalProfit}₪` });
    } else if (totalGames >= 5) {
      insights.push({ priority: 30, text: `${totalGames} משחקים עד היום: ${recentWins} נצחונות, ממוצע ${overallAvg >= 0 ? '+' : ''}${overallAvg}₪` });
    } else {
      insights.push({ priority: 25, text: `עדיין ${g('מתחיל', 'מתחילה')}: רק ${totalGames} משחקים בהיסטוריה` });
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
        gamesCount: 0, trend: 'stable', highlights: 'שחקן חדש', daysSinceLastGame: 0, isActive: false
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
    const highlights = generateDynamicHighlight(stats, daysSinceLastGame, stats.playerName);
    
    return { recentWins, recentLosses, recentProfit, recentAvg, gamesCount, trend, highlights, daysSinceLastGame, isActive };
  };

  // Generate CREATIVE forecast sentence - LONGER and more engaging with GENDER SUPPORT
  const generateCreativeSentence = (
    name: string, 
    _stats: PlayerStats,
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
        `${name} ${g('עובר', 'עוברת')} תקופה קשה עם הרצף השלילי, אבל כל רצף נשבר מתישהו - השאלה אם הפעם`,
        `הקלפים לא מחייכים ל${name} לאחרונה, אבל כולם יודעים שהמזל מתהפך. אולי הפעם?`,
        `${name} בתקופת יובש - מספיק הפסדים כדי שכולם יתחילו לשאול מה ${g('קורה לו', 'קורה לה')}`,
        `כולם אוהבים סיפור קאמבק, ו${name} בדיוק במצב ${g('שבו הוא צריך', 'שבו היא צריכה')} אחד. הפעם ההזדמנות ${g('שלו', 'שלה')}`,
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
        `${name} בתהליך של שיפור עקבי - השאלה היא האם הפעם ${g('הוא ימשיך', 'היא תמשיך')} את המגמה`,
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
        `${name} בירידה קלה אבל מורגשת - נראה אם ${g('הוא יצליח', 'היא תצליח')} להתאושש הפעם`,
        `לא הזמן הכי טוב של ${name} - הנתונים האחרונים מדאיגים קצת`,
      ];
      return sentences[Math.floor(Math.random() * sentences.length)];
    }
    
    // Surprise prediction
    if (isSurprise) {
      if (expectedOutcome.includes('win')) {
        const sentences = [
          `⚡ תחושת בטן חזקה: ${name} ${g('הולך', 'הולכת')} להפתיע הפעם. הנתונים אומרים דבר אחד, אבל משהו באוויר אומר אחרת`,
          `⚡ ${name} ${g('מגיע', 'מגיעה')} עם משהו להוכיח - לפעמים הדחף להוכיח שווה יותר מכל סטטיסטיקה`,
          `⚡ נגד כל הסיכויים: ${name} ${g('עשוי', 'עשויה')} לעשות קאמבק מפתיע. יש ${g('לו', 'לה')} את האנרגיה לזה`,
          `⚡ ${name} לא ${g('הולך', 'הולכת')} לפי התסריט הפעם - יש משהו ${g('שונה בו', 'שונה בה')}, תחושה של פריצה`,
          `⚡ הפתעה באוויר: ${name} ${g('יכול', 'יכולה')} לשנות את הכל הפעם ולהפוך את הקערה על פיה`,
        ];
        return sentences[Math.floor(Math.random() * sentences.length)];
      } else {
        const sentences = [
          `⚡ אזהרה: גם ${g('מלכים נופלים', 'מלכות נופלות')}. ${name} ${g('בא', 'באה')} עם ביטחון, אבל משהו יכול להשתבש`,
          `⚡ ${name} ${g('צריך', 'צריכה')} להיזהר הפעם - ביטחון יתר יכול להיות מסוכן, וההיסטוריה לא תמיד מגינה`,
          `⚡ משהו לא מרגיש נכון לגבי ${name} הערב - למרות הנתונים הטובים, יש תחושה של נפילה`,
          `⚡ ${name} ${g('עלול', 'עלולה')} להיתקל בהפתעה לא נעימה - לפעמים דברים לא הולכים לפי התוכנית`,
          `⚡ נבואה מפתיעה: ${name} ${g('יכול', 'יכולה')} לאכול אותה הפעם למרות ההיסטוריה ${g('המרשימה שלו', 'המרשימה שלה')}`,
        ];
        return sentences[Math.floor(Math.random() * sentences.length)];
      }
    }
    
    // Regular predictions - fun and dramatic with LONGER sentences
    switch (expectedOutcome) {
      case 'big_win':
        const bigWinSentences = [
          `${name} ${g('הוא המועמד המוביל', 'היא המועמדת המובילה')} לקחת הכי הרבה כסף הפעם - הנתונים והפורמה ${g('שלו', 'שלה')} פשוט מדברים בעד עצמם`,
          `כולם צריכים להיזהר מ${name} הערב - ${g('הוא בא', 'היא באה')} לגבות מיסים ולא נראה שמישהו ${g('יכול לעצור אותו', 'יכול לעצור אותה')}`,
          `${name} במצב שבו הכל עובד ${g('לטובתו', 'לטובתה')} - אם הייתי צריך להמר על ${g('מישהו, הוא היה', 'מישהי, היא הייתה')} הבחירה הראשונה שלי`,
          `${name} ${g('הוא', 'היא')} הסיבה שכמה אנשים סביב השולחן קצת מודאגים - וזה מוצדק לגמרי`,
          `מי ינסה להתמודד עם ${name}? עם הנתונים ${g('שלו', 'שלה')}, זה כמו להילחם נגד הסיכויים`,
          `${name} לא ${g('בא', 'באה')} לשחק - ${g('הוא בא', 'היא באה')} לשלוט. וזה בדיוק מה ${g('שהוא כנראה יעשה', 'שהיא כנראה תעשה')}`,
        ];
        return bigWinSentences[Math.floor(Math.random() * bigWinSentences.length)];
        
      case 'win':
        const winSentences = [
          `${name} בפורמה טובה ויש ${g('לו', 'לה')} סיכוי ממשי לצאת עם רווח יפה הפעם`,
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
          `מי יודע מה ${g('יעשה', 'תעשה')} ${name} הפעם? הנתונים לא עוזרים, והכל תלוי במזל ובמצב רוח`,
          `${name} ${g('יכול', 'יכולה')} להפתיע לכל כיוון - גם ניצחון גדול וגם הפסד כואב אפשריים לגמרי`,
        ];
        return neutralSentences[Math.floor(Math.random() * neutralSentences.length)];
        
      case 'slight_loss':
        const slightLossSentences = [
          `${name} ${g('צריך', 'צריכה')} קצת מזל הפעם - הנתונים לא לגמרי ${g('לצידו', 'לצידה')}, אבל זה לא אומר ${g('שהוא', 'שהיא')} לא ${g('יכול', 'יכולה')} להפוך את הקערה`,
          `הרוח לא לגמרי לטובת ${name} הערב - ${g('הוא יצטרך', 'היא תצטרך')} להילחם על כל שקל אם ${g('הוא רוצה', 'היא רוצה')} לצאת ברווח`,
          `${name} ${g('מתחיל', 'מתחילה')} עם חיסרון קל - לא דרמטי, אבל מספיק כדי להקשות על הערב`,
          `הסיכויים קצת נגד ${name} - ${g('הוא יצטרך', 'היא תצטרך')} משחק טוב במיוחד כדי להפוך את המגמה`,
          `${name} ${g('בא', 'באה')} לערב מאתגר - הנתונים מציעים שזה לא יהיה קל, אבל הכל אפשרי`,
          `${name} ${g('יצטרך', 'תצטרך')} לעבוד קשה הפעם - היתרון לא ${g('לצידו', 'לצידה')}, אבל ${g('שחקנים טובים יודעים', 'שחקניות טובות יודעות')} איך להתגבר`,
        ];
        return slightLossSentences[Math.floor(Math.random() * slightLossSentences.length)];
        
      case 'loss':
        const lossSentences = [
          `${name} לא בעמדה הכי טובה הערב - הנתונים מראים ${g('שהוא יצטרך', 'שהיא תצטרך')} הרבה מזל כדי לשנות את המגמה`,
          `קשה להיות ${g('אופטימי', 'אופטימית')} לגבי ${name} הפעם - הסטטיסטיקות לא ${g('לצידו', 'לצידה')} ונראה ${g('שיהיה לו', 'שיהיה לה')} קשה`,
          `${name} ${g('בא', 'באה')} עם רוח נגדית חזקה - אולי ${g('כדאי לו', 'כדאי לה')} לשחק ${g('שמרני', 'שמרנית')} ולא לקחת סיכונים`,
          `הנתונים לא מבשרים טובות ל${name} - נראה שזה הולך להיות ערב מאתגר במיוחד`,
          `${name} ${g('יצטרך', 'תצטרך')} נס קטן כדי לסיים ברווח - הסיכויים ממש לא ${g('לצידו', 'לצידה')} הערב`,
          `${name} לא ${g('במיטבו', 'במיטבה')} על פי הנתונים - השאלה היא האם ${g('הוא יצליח', 'היא תצליח')} להפתיע למרות הכל`,
        ];
        return lossSentences[Math.floor(Math.random() * lossSentences.length)];
        
      case 'big_loss':
        const bigLossSentences = [
          `${name} ${g('הוא הספונסר הלא רשמי', 'היא הספונסרית הלא רשמית')} של הקבוצה - ${g('בזכותו', 'בזכותה')} כולנו מרוויחים יותר, ועל זה אנחנו מודים`,
          `תודה מראש ל${name} על התרומה - הנתונים מראים ${g('שהוא כנראה יחלק', 'שהיא כנראה תחלק')} כסף לכולם הפעם`,
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
      `${name} ${g('נכנס', 'נכנסת')} למשחק בלי היסטוריה - דף חלק לגמרי. הפעם נתחיל לכתוב את הסיפור ${g('שלו', 'שלה')}`,
      `אין לנו שום מידע על ${name} - ${g('הוא יכול להיות גאון פוקר או הפסד מובטח', 'היא יכולה להיות גאונת פוקר או הפסד מובטח')}. הפעם נגלה`,
      `${name} ${g('הוא', 'היא')} סוס אפל מוחלט - בלי נתונים, בלי היסטוריה, בלי שום רמז למה שיקרה`,
      `מי ${g('זה', 'זאת')} בכלל ${name}? אין לנו מושג, ובדיוק זה מה שמעניין. הכל פתוח`,
      `${name} ${g('מתחיל', 'מתחילה')} מאפס - בלי יתרון ובלי חיסרון. הערב הזה יקבע את הרושם הראשוני`,
      `${g('שחקן חדש', 'שחקנית חדשה')} בשם ${name} ${g('מצטרף', 'מצטרפת')} למשחק - בואו נראה ${g('מה הוא עשוי ממנו', 'מה היא עשויה ממנה')}`,
      `${name} בלי תיק עבר - ${g('יכול', 'יכולה')} להפתיע את כולם לטובה או לרעה. מי יודע?`,
    ];
    return sentences[Math.floor(Math.random() * sentences.length)];
  };


  // Simple fallback forecast when AI is unavailable
  const generateForecasts = () => {
    const playerAnalysis = Array.from(selectedIds).map(playerId => {
      const player = players.find(p => p.id === playerId);
      if (!player) return null;
      const stats = getStatsForPlayer(playerId);
      const gamesPlayed = stats?.gamesPlayed || 0;
      const avgProfit = stats?.avgProfit || 0;
      const recent = stats ? analyzeRecent(stats) : {
        recentWins: 0, recentLosses: 0, recentProfit: 0, recentAvg: 0,
        gamesCount: 0, trend: 'stable' as const, highlights: ''
      };

      // Simple: direction from recent form blended with overall, magnitude from real swings
      const last3 = stats?.lastGameResults?.slice(0, 3) || [];
      const last3Avg = last3.length > 0 ? last3.reduce((s, r) => s + r.profit, 0) / last3.length : 0;

      const lastResults = stats?.lastGameResults || [];

      let expectedValue: number;
      if (gamesPlayed === 0) {
        expectedValue = Math.round((Math.random() - 0.5) * 120);
      } else {
        // Sample a real game result for realistic magnitude
        const recent10 = lastResults.slice(0, 10);
        const sample = recent10[Math.floor(Math.random() * recent10.length)];
        const sampleMag = Math.abs(sample?.profit || 50);

        const blended = last3Avg * 0.6 + avgProfit * 0.4;
        let direction = blended >= 0 ? 1 : -1;
        if (Math.random() < 0.20) direction *= -1;

        expectedValue = direction * sampleMag * (0.6 + Math.random() * 0.5);
        expectedValue += (Math.random() - 0.5) * sampleMag * 0.3;
        if (gamesPlayed <= 3) expectedValue *= 0.7;
      }
      expectedValue = Math.round(expectedValue);

      return { player, stats, gamesPlayed, avgProfit, recent, expectedValue };
    }).filter(Boolean) as {
      player: Player; stats: PlayerStats | undefined; gamesPlayed: number;
      avgProfit: number; recent: RecentAnalysis; expectedValue: number;
    }[];

    // Zero-sum balance
    const total = playerAnalysis.reduce((s, p) => s + p.expectedValue, 0);
    const adj = total / playerAnalysis.length;
    playerAnalysis.forEach(p => { p.expectedValue = Math.round(p.expectedValue - adj); });

    return playerAnalysis.map(f => {
      let outcome: 'big_win' | 'win' | 'slight_win' | 'neutral' | 'slight_loss' | 'loss' | 'big_loss';
      if (f.expectedValue > 100) outcome = 'big_win';
      else if (f.expectedValue > 40) outcome = 'win';
      else if (f.expectedValue > 10) outcome = 'slight_win';
      else if (f.expectedValue >= -10) outcome = 'neutral';
      else if (f.expectedValue >= -40) outcome = 'slight_loss';
      else if (f.expectedValue >= -100) outcome = 'loss';
      else outcome = 'big_loss';

      const sentence = f.gamesPlayed === 0
        ? getNewPlayerSentence(f.player.name)
        : generateCreativeSentence(f.player.name, f.stats!, f.recent, outcome, false);

      return {
        player: f.player,
        expected: f.expectedValue,
        sentence,
        highlights: f.recent.highlights,
        gamesPlayed: f.gamesPlayed,
        isSurprise: false,
        recent: f.recent
      };
    }).sort((a, b) => b.expected - a.expected);
  };

  // Share forecast as screenshot to WhatsApp (splits into multiple images if many players)
  const shareForecast = async () => {
    if (isSharing) return;
    
    const forecasts = aiForecasts || cachedForecasts;
    if (!forecasts || forecasts.length === 0) return;
    
    setIsSharing(true);
    
    try {
      const PLAYERS_PER_PAGE = 4;
      const files: File[] = [];
      const isAI = !!aiForecasts;
      const today = new Date().toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });
      
      // Sort forecasts by expected profit (highest first) to match on-screen display
      const sortedForecasts = [...forecasts].sort((a: any, b: any) => {
        const aProfit = a.expectedProfit ?? a.expected ?? 0;
        const bProfit = b.expectedProfit ?? b.expected ?? 0;
        return bProfit - aProfit;
      });

      const hasTeaser = isAI && aiForecasts?.[0]?.preGameTeaser;

      // Build combo history HTML for screenshot
      const buildComboScreenshotHtml = (): string => {
        if (!comboHistory) return '';
        if (comboHistory.isFirstTime) {
          return `<div style="padding: 0.75rem 1rem; margin-top: 1rem; border-radius: 12px; background: linear-gradient(135deg, rgba(34, 197, 94, 0.10), rgba(16, 185, 129, 0.08)); border: 1px solid rgba(34, 197, 94, 0.3); text-align: right; direction: rtl; font-size: 0.85rem; color: #e2e8f0;">
            <span style="font-size: 1rem;">🆕</span> <strong style="color: #4ade80;">הרכב חדש!</strong> זו הפעם הראשונה שבדיוק ${comboHistory.playerCount} השחקנים האלה משחקים יחד. מה יקרה?
          </div>`;
        }
        const headerHtml = `<div style="margin-bottom: 0.75rem;">
            <div style="font-size: 0.88rem; color: #e2e8f0;"><span style="font-size: 1rem;">🔄</span> <strong style="color: #fbbf24;">הרכב חוזר!</strong></div>
            <div style="font-size: 0.76rem; color: #94a3b8; margin-top: 0.2rem;">פעם ${comboHistory.totalGamesWithCombo + 1} שאותם ${comboHistory.playerCount} שחקנים נפגשים</div>
          </div>`;

        if (comboHistory.totalGamesWithCombo === 1) {
          const game = comboHistory.previousGames[0];
          const dateStr = (() => { try { return new Date(game.date).toLocaleDateString('he-IL', { day: 'numeric', month: 'short', year: '2-digit' }); } catch { return game.date; } })();
          const daysAgo = Math.round((Date.now() - new Date(game.date).getTime()) / (1000 * 60 * 60 * 24));
          const timeAgoStr = daysAgo <= 1 ? 'אתמול' : daysAgo <= 7 ? `לפני ${daysAgo} ימים` : daysAgo <= 30 ? `לפני ${Math.round(daysAgo / 7)} שבועות` : daysAgo <= 60 ? 'לפני חודש' : `לפני ${Math.round(daysAgo / 30)} חודשים`;
          const topRebuyer = [...game.results].sort((a, b) => b.rebuys - a.rebuys)[0];
          const winnersCount = game.results.filter(r => r.profit > 0).length;

          const insightsHtml: string[] = [];
          if (topRebuyer && topRebuyer.rebuys >= 3 && topRebuyer.playerName !== game.winnerName) {
            insightsHtml.push(`<div style="font-size: 0.76rem; color: #f59e0b;">💸 ${topRebuyer.playerName} קנה הכי הרבה (${topRebuyer.rebuys}) אבל לא ניצח</div>`);
          } else if (topRebuyer && topRebuyer.playerName === game.winnerName && topRebuyer.rebuys >= 3) {
            insightsHtml.push(`<div style="font-size: 0.76rem; color: #4ade80;">🔥 ${topRebuyer.playerName} קנה הכי הרבה (${topRebuyer.rebuys}) ובכל זאת ניצח</div>`);
          }
          if (winnersCount === 1) {
            insightsHtml.push(`<div style="font-size: 0.76rem; color: #a78bfa;">🎯 רק מנצח אחד מתוך ${game.results.length} — ערב קשה</div>`);
          } else if (winnersCount >= Math.ceil(game.results.length / 2)) {
            insightsHtml.push(`<div style="font-size: 0.76rem; color: #94a3b8;">⚖️ ${winnersCount} מתוך ${game.results.length} סיימו ברווח — ערב מאוזן</div>`);
          }
          const loserRebuys = game.results[game.results.length - 1]?.rebuys || 0;
          if (loserRebuys <= 1) {
            insightsHtml.push(`<div style="font-size: 0.76rem; color: #f87171;">😱 ${game.loserName} הפסיד הכי הרבה עם רק קנייה אחת</div>`);
          }

          return `<div style="padding: 0.85rem 1rem; margin-top: 1rem; border-radius: 12px; background: linear-gradient(135deg, rgba(251, 191, 36, 0.10), rgba(245, 158, 11, 0.08)); border: 1px solid rgba(251, 191, 36, 0.3); text-align: right; direction: rtl;">
            ${headerHtml}
            <div style="padding: 0.4rem 0.55rem; border-radius: 8px; background: rgba(255,255,255,0.04); margin-bottom: 0.5rem;">
              <div style="color: #64748b; font-size: 0.7rem; margin-bottom: 0.2rem;">${dateStr} (${timeAgoStr})</div>
              <div style="font-size: 0.8rem;"><span style="color: #4ade80;">👑 ${game.winnerName} (+${Math.round(game.winnerProfit)}₪)</span>  <span style="color: #f87171;">💀 ${game.loserName} (${Math.round(game.loserProfit)}₪)</span></div>
              <div style="font-size: 0.72rem; color: #64748b; margin-top: 0.2rem;">${game.totalRebuys} קניות סה"כ • ${game.results.length} שחקנים</div>
            </div>
            ${insightsHtml.length > 0 ? `<div style="display: flex; flex-direction: column; gap: 0.2rem;">${insightsHtml.join('')}</div>` : ''}
          </div>`;
        }

        const top = comboHistory.playerStats[0];
        const bottom = comboHistory.playerStats[comboHistory.playerStats.length - 1];
        const alwaysWon = comboHistory.playerStats.filter(p => p.alwaysWon);
        const alwaysLost = comboHistory.playerStats.filter(p => p.alwaysLost);

        let patternsHtml = '';
        if (alwaysWon.length > 0) patternsHtml += `<div style="font-size: 0.78rem; color: #4ade80;">⭐ תמיד ברווח: ${alwaysWon.map(p => `${p.playerName} (${p.wins}/${comboHistory.totalGamesWithCombo})`).join(', ')}</div>`;
        if (alwaysLost.length > 0) patternsHtml += `<div style="font-size: 0.78rem; color: #f87171;">⚠️ תמיד בהפסד: ${alwaysLost.map(p => p.playerName).join(', ')}</div>`;
        if (comboHistory.uniqueWinners.length === comboHistory.totalGamesWithCombo) patternsHtml += `<div style="font-size: 0.78rem; color: #a78bfa;">🎲 מנצח שונה בכל משחק — מי הפעם?</div>`;
        if (comboHistory.repeatWinners.length > 0) patternsHtml += `<div style="font-size: 0.78rem; color: #fbbf24;">🏆 ניצחו יותר מפעם: ${comboHistory.repeatWinners.map(w => `${w.name} (${w.count}/${comboHistory.totalGamesWithCombo})`).join(', ')}</div>`;

        const avgRebuys = Math.round(comboHistory.playerStats.reduce((s, p) => s + p.totalRebuys, 0) / comboHistory.totalGamesWithCombo);
        const biggestWin = comboHistory.playerStats.reduce((best, p) => p.bestResult > best.profit ? { name: p.playerName, profit: p.bestResult } : best, { name: '', profit: 0 });
        let insightsHtml = '';
        if (avgRebuys > 0) insightsHtml += `<div style="font-size: 0.76rem; color: #94a3b8;">📊 ממוצע ${avgRebuys} קניות למשחק בהרכב הזה</div>`;
        if (biggestWin.profit > 0) insightsHtml += `<div style="font-size: 0.76rem; color: #94a3b8;">🏆 רווח שיא: ${biggestWin.name} +${Math.round(biggestWin.profit)}₪</div>`;
        if (comboHistory.spanDays > 30) insightsHtml += `<div style="font-size: 0.76rem; color: #94a3b8;">📅 ההרכב הזה משחק יחד כבר ${Math.round(comboHistory.spanDays / 30)} חודשים</div>`;

        const gamesHtml = comboHistory.previousGames.slice(-3).map(game => {
          const dateStr = (() => { try { return new Date(game.date).toLocaleDateString('he-IL', { day: 'numeric', month: 'short', year: '2-digit' }); } catch { return game.date; } })();
          return `<div style="padding: 0.35rem 0.5rem; border-radius: 6px; background: rgba(255,255,255,0.03); font-size: 0.76rem; color: #94a3b8;">
            <div style="color: #64748b; font-size: 0.7rem; margin-bottom: 0.15rem;">${dateStr}</div>
            <div><span style="color: #4ade80;">👑 ${game.winnerName} (+${Math.round(game.winnerProfit)}₪)</span>  <span style="color: #f87171;">💀 ${game.loserName} (${Math.round(game.loserProfit)}₪)</span></div>
          </div>`;
        }).join('');

        return `<div style="padding: 0.85rem 1rem; margin-top: 1rem; border-radius: 12px; background: linear-gradient(135deg, rgba(251, 191, 36, 0.10), rgba(245, 158, 11, 0.08)); border: 1px solid rgba(251, 191, 36, 0.3); text-align: right; direction: rtl;">
          ${headerHtml}
          <div style="display: flex; flex-direction: column; gap: 0.4rem; margin-bottom: 0.75rem; padding: 0.5rem 0.65rem; border-radius: 8px; background: rgba(255,255,255,0.04); font-size: 0.8rem; color: #e2e8f0;">
            <div>👑 <span style="color: #fbbf24; font-weight: 600;">מוביל ההרכב:</span> ${top.playerName} <span style="color: ${top.totalProfit >= 0 ? '#4ade80' : '#f87171'};">(${top.totalProfit >= 0 ? '+' : ''}${Math.round(top.totalProfit)}₪)</span> <span style="color: #64748b; font-size: 0.72rem;">ממוצע ${top.avgProfit >= 0 ? '+' : ''}${Math.round(top.avgProfit)}₪ • ${top.wins}/${comboHistory.totalGamesWithCombo} נצחונות</span></div>
            <div>📉 <span style="font-weight: 600;">תחתית ההרכב:</span> ${bottom.playerName} <span style="color: #f87171;">(${bottom.totalProfit >= 0 ? '+' : ''}${Math.round(bottom.totalProfit)}₪)</span> <span style="color: #64748b; font-size: 0.72rem;">ממוצע ${bottom.avgProfit >= 0 ? '+' : ''}${Math.round(bottom.avgProfit)}₪</span></div>
          </div>
          ${patternsHtml ? `<div style="display: flex; flex-direction: column; gap: 0.3rem; margin-bottom: 0.75rem;">${patternsHtml}</div>` : ''}
          ${insightsHtml ? `<div style="display: flex; flex-direction: column; gap: 0.2rem; margin-bottom: 0.6rem;">${insightsHtml}</div>` : ''}
          <div style="font-size: 0.75rem; color: #64748b; font-weight: 600; margin-bottom: 0.3rem;">📅 משחקים קודמים:</div>
          <div style="display: flex; flex-direction: column; gap: 0.3rem; margin-bottom: 0.6rem;">${gamesHtml}</div>
        </div>`;
      };

      // Page 1: Teaser as its own dedicated card (if exists)
      if (hasTeaser) {
        const comboHtml = buildComboScreenshotHtml();
        const teaserContainer = document.createElement('div');
        teaserContainer.style.cssText = 'position: absolute; left: -9999px; top: 0; width: 375px; padding: 1.25rem; background: #1a1a2e; border-radius: 12px; font-family: system-ui, -apple-system, sans-serif;';
        teaserContainer.innerHTML = `
          <div style="text-align: center; margin-bottom: 1.25rem;">
            <div style="font-size: 2rem; margin-bottom: 0.25rem;">🤖</div>
            <h3 style="margin: 0; font-size: 1.2rem; font-weight: 700; color: #f1f5f9;">טיזר המשחק</h3>
            <div style="font-size: 0.75rem; color: #A855F7; margin-top: 0.25rem;">Powered by Gemini ✨</div>
            ${aiModelName ? `<div style="font-size: 0.55rem; color: #64748b; margin-top: 0.1rem; opacity: 0.7;">model: ${aiModelName}</div>` : ''}
            <div style="font-size: 0.8rem; color: #94a3b8; margin-top: 0.25rem;">${today}</div>
          </div>
          <div style="padding: 1rem 1.1rem; border-radius: 12px; background: linear-gradient(135deg, rgba(139, 92, 246, 0.12), rgba(59, 130, 246, 0.10)); border: 1px solid rgba(139, 92, 246, 0.35); text-align: right; direction: rtl;">
            <div style="display: flex; align-items: center; gap: 0.4rem; margin-bottom: 0.6rem; flex-direction: row-reverse; justify-content: center;">
              <span style="font-size: 1.2rem;">🎙️</span>
              <span style="font-size: 0.85rem; font-weight: 700; color: #a78bfa; letter-spacing: 0.5px;">טיזר המשחק</span>
            </div>
            <div style="font-size: 0.9rem; color: #e2e8f0; line-height: 1.8; font-weight: 400;">${aiForecasts![0].preGameTeaser}</div>
          </div>
          ${comboHtml}
          <div style="text-align: center; margin-top: 1.25rem; font-size: 0.75rem; color: #64748b; opacity: 0.7;">Poker Manager 🎲</div>
        `;
        document.body.appendChild(teaserContainer);
        const teaserCanvas = await html2canvas(teaserContainer, { backgroundColor: '#1a1a2e', scale: 2, logging: false, useCORS: true });
        document.body.removeChild(teaserContainer);
        const teaserBlob = await new Promise<Blob>((resolve) => { teaserCanvas.toBlob((b) => resolve(b!), 'image/png', 1.0); });
        files.push(new File([teaserBlob], `poker-teaser-${new Date().toISOString().split('T')[0]}.png`, { type: 'image/png' }));
      }
      
      // Split sorted forecasts into chunks (players only, no teaser)
      const chunks: any[][] = [];
      for (let i = 0; i < sortedForecasts.length; i += PLAYERS_PER_PAGE) {
        chunks.push(sortedForecasts.slice(i, i + PLAYERS_PER_PAGE));
      }
      
      // Create a screenshot for each player chunk
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const chunk = chunks[chunkIndex];
        const totalPages = chunks.length + (hasTeaser ? 1 : 0);
        const pageNumber = chunkIndex + (hasTeaser ? 2 : 1);
        const pageNum = totalPages > 1 ? ` (${pageNumber}/${totalPages})` : '';
        
        const container = document.createElement('div');
        container.style.cssText = 'position: absolute; left: -9999px; top: 0; width: 375px; padding: 1.25rem; background: #1a1a2e; border-radius: 12px; font-family: system-ui, -apple-system, sans-serif;';
        
        container.innerHTML = `
          <div style="text-align: center; margin-bottom: 1.25rem;">
            <div style="font-size: 2rem; margin-bottom: 0.25rem;">${isAI ? '🤖' : '🔮'}</div>
            <h3 style="margin: 0; font-size: 1.2rem; font-weight: 700; color: #f1f5f9;">
              ${isAI ? 'תחזית AI' : 'תחזית המשחק'}${pageNum}
            </h3>
            ${isAI ? '<div style="font-size: 0.75rem; color: #A855F7; margin-top: 0.25rem;">Powered by Gemini ✨</div>' : ''}
            ${isAI && aiModelName ? `<div style="font-size: 0.55rem; color: #64748b; margin-top: 0.1rem; opacity: 0.7;">model: ${aiModelName}</div>` : ''}
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
              
              let bgColor = expected >= 0 ? 'rgba(34, 197, 94, 0.12)' : 'rgba(239, 68, 68, 0.12)';
              let borderColor = expected >= 0 ? '#22c55e' : '#ef4444';
              
              if (isSurprise) {
                bgColor = 'rgba(168, 85, 247, 0.15)';
                borderColor = '#a855f7';
              }
              
              return `
                <div style="padding: 0.75rem 0.85rem; margin-bottom: 0.5rem; border-radius: 10px; background: ${bgColor}; border-right: 4px solid ${borderColor};">
                  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.4rem;">
                    <span style="font-weight: 700; font-size: 1rem; color: #f1f5f9;">
                      ${isFirst && expected > 0 ? '👑 ' : ''}${name}${isSurprise ? ' ⚡' : ''}
                    </span>
                    <span style="font-weight: 700; font-size: 1.05rem; color: #f1f5f9;">
                      ${expected >= 0 ? '+' : '-'}₪${Math.abs(Math.round(expected)).toLocaleString()}
                    </span>
                  </div>
                  ${highlight ? `<div style="font-size: 0.78rem; color: #f1f5f9; opacity: 0.8; margin-bottom: 0.4rem; direction: rtl; line-height: 1.4;">${highlight}</div>` : ''}
                  <div style="font-size: 0.85rem; color: #94a3b8; line-height: 1.45; direction: rtl; font-style: italic;">
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
        
        const fileName = totalPages > 1 
          ? `poker-forecast-${pageNumber}.png` 
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

  /**
   * Calculate global rankings among ACTIVE players (33% threshold)
   * This matches the Statistics screen's active filter logic
   */
  const calculateGlobalRankings = (): GlobalRankingContext => {
    const allGames = getAllGames().filter(g => g.status === 'completed');
    const allGamePlayers = getAllGamePlayers();
    const allPlayersList = getAllPlayers();
    const currentYear = new Date().getFullYear();
    const currentHalf = new Date().getMonth() < 6 ? 1 : 2;
    const halfStartMonth = currentHalf === 1 ? 0 : 6;
    
    // Helper to calculate player stats for a date range
    const calculateStatsForPeriod = (
      startDate?: Date,
      endDate?: Date
    ): { playerStats: Map<string, { name: string; profit: number; gamesPlayed: number }>; totalGames: number } => {
      const filteredGames = allGames.filter(g => {
        const gameDate = new Date(g.date);
        if (startDate && gameDate < startDate) return false;
        if (endDate && gameDate > endDate) return false;
        return true;
      });
      
      const playerStats = new Map<string, { name: string; profit: number; gamesPlayed: number }>();
      
      for (const gp of allGamePlayers) {
        const game = filteredGames.find(g => g.id === gp.gameId);
        if (!game) continue;
        
        const player = allPlayersList.find(p => p.id === gp.playerId);
        if (!player) continue;
        
        const current = playerStats.get(player.name) || { name: player.name, profit: 0, gamesPlayed: 0 };
        playerStats.set(player.name, {
          name: player.name,
          profit: current.profit + gp.profit,
          gamesPlayed: current.gamesPlayed + 1
        });
      }
      
      return { playerStats, totalGames: filteredGames.length };
    };
    
    // ALL-TIME rankings
    const { playerStats: allTimeStats, totalGames: allTimeTotalGames } = calculateStatsForPeriod();
    const allTimeThreshold = Math.ceil(allTimeTotalGames * 0.33);
    const allTimeActive = [...allTimeStats.values()]
      .filter(p => p.gamesPlayed >= allTimeThreshold)
      .sort((a, b) => b.profit - a.profit);
    
    // CURRENT YEAR rankings
    const yearStart = new Date(currentYear, 0, 1);
    const { playerStats: yearStats, totalGames: yearTotalGames } = calculateStatsForPeriod(yearStart);
    const yearThreshold = Math.ceil(yearTotalGames * 0.33);
    const yearActive = [...yearStats.values()]
      .filter(p => p.gamesPlayed >= yearThreshold)
      .sort((a, b) => b.profit - a.profit);
    
    // CURRENT HALF rankings
    const halfStart = new Date(currentYear, halfStartMonth, 1);
    const halfEnd = new Date(currentYear, halfStartMonth + 6, 0);
    const { playerStats: halfStats, totalGames: halfTotalGames } = calculateStatsForPeriod(halfStart, halfEnd);
    const halfThreshold = Math.ceil(halfTotalGames * 0.33);
    const halfActive = [...halfStats.values()]
      .filter(p => p.gamesPlayed >= halfThreshold)
      .sort((a, b) => b.profit - a.profit);
    
    return {
      allTime: {
        totalActivePlayers: allTimeActive.length,
        totalGames: allTimeTotalGames,
        threshold: allTimeThreshold,
        rankings: allTimeActive.map((p, i) => ({ 
          name: p.name, 
          rank: i + 1, 
          profit: p.profit,
          gamesPlayed: p.gamesPlayed
        }))
      },
      currentYear: {
        year: currentYear,
        totalActivePlayers: yearActive.length,
        totalGames: yearTotalGames,
        threshold: yearThreshold,
        rankings: yearActive.map((p, i) => ({ 
          name: p.name, 
          rank: i + 1, 
          profit: p.profit,
          gamesPlayed: p.gamesPlayed
        }))
      },
      currentHalf: {
        half: currentHalf as 1 | 2,
        year: currentYear,
        totalActivePlayers: halfActive.length,
        totalGames: halfTotalGames,
        threshold: halfThreshold,
        rankings: halfActive.map((p, i) => ({ 
          name: p.name, 
          rank: i + 1, 
          profit: p.profit,
          gamesPlayed: p.gamesPlayed
        }))
      }
    };
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
        const selectedPlayers = players.filter(p => selectedIds.has(p.id));
        const allGames = getAllGames();
        const gameLocationMap = new Map(allGames.map(g => [g.id, g.location]));
        
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
            bestWin: stats?.biggestWin || 0,
            worstLoss: stats?.biggestLoss ? -Math.abs(stats.biggestLoss) : 0,
            gameHistory: (stats?.lastGameResults || []).map(g => {
              const d = new Date(g.date);
              const day = d.getDate().toString().padStart(2, '0');
              const month = (d.getMonth() + 1).toString().padStart(2, '0');
              const year = d.getFullYear();
              return {
                profit: g.profit,
                date: `${day}/${month}/${year}`,
                gameId: g.gameId,
                location: gameLocationMap.get(g.gameId),
              };
            }),
            daysSinceLastGame: daysSince,
            isActive: daysSince <= 60
          };
        });
        
        const globalRankings = calculateGlobalRankings();

        const settings = getSettings();
        const days = settings.gameNightDays || [4, 6];
        const resolvedMarkers = detectPeriodMarkers(getNextGameNightDate(days), allGames, days);
        const finalMarkers = applyPeriodOverride(resolvedMarkers, periodOverride);
        setPeriodMarkers(finalMarkers);

        const loc = gameLocation === 'other' ? customLocation.trim() : gameLocation;

        const combo = getComboHistory(Array.from(selectedIds));
        const comboText = buildComboHistoryText(combo);
        setComboHistory(combo);

        const forecasts = await withAITiming('forecast', () => generateAIForecasts(playerData, globalRankings, finalMarkers, loc || undefined, comboText));
        const modelDisplay = getModelDisplayName(getLastUsedModel());
        setAiForecasts(forecasts);
        setAiModelName(modelDisplay);
        setIsLoadingAI(false);

        const forecastsToSave: GameForecast[] = forecasts.map(f => ({
          playerName: f.name,
          expectedProfit: f.expectedProfit,
          highlight: f.highlight,
          sentence: f.sentence,
          isSurprise: f.isSurprise
        }));
        savePendingForecast(Array.from(selectedIds), forecastsToSave, forecasts[0]?.preGameTeaser, modelDisplay);
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
      const staticForecasts = generateForecasts();
      setCachedForecasts(staticForecasts);
      setShowForecast(true);
      
      // Save to pending forecast storage
      const forecastsToSave: GameForecast[] = staticForecasts.map(f => ({
        playerName: f.player.name,
        expectedProfit: f.expected,
        sentence: f.sentence
      }));
      savePendingForecast(Array.from(selectedIds), forecastsToSave);
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
      {/* Resume Active Game Banner */}
      {activeGame && (
        <div style={{
          background: 'linear-gradient(135deg, #F59E0B 0%, #D97706 100%)',
          borderRadius: '12px',
          padding: '1rem',
          marginBottom: '1rem',
          boxShadow: '0 4px 12px rgba(245, 158, 11, 0.3)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
            <span style={{ fontSize: '1.5rem' }}>⚠️</span>
            <div>
              <div style={{ fontWeight: '700', color: 'white', fontSize: '1rem' }}>
                משחק פעיל נמצא!
              </div>
              <div style={{ color: 'rgba(255,255,255,0.9)', fontSize: '0.8rem' }}>
                {activeGame.status === 'live' ? 'שלב: משחק חי (buyins)' : 'שלב: ספירת צ\'יפים'}
              </div>
            </div>
          </div>
          
          <div style={{ color: 'rgba(255,255,255,0.9)', fontSize: '0.75rem', marginBottom: '0.75rem' }}>
            <div style={{ marginBottom: '0.25rem' }}>
              📅 {new Date(activeGame.createdAt).toLocaleDateString('he-IL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
            </div>
            <div>
              👥 {activeGamePlayers.slice(0, 4).join(', ')}{activeGamePlayers.length > 4 ? ` +${activeGamePlayers.length - 4}` : ''}
            </div>
          </div>
          
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              onClick={handleResumeGame}
              style={{
                flex: 2,
                background: 'white',
                color: '#D97706',
                border: 'none',
                borderRadius: '8px',
                padding: '0.6rem 1rem',
                fontWeight: '700',
                fontSize: '0.9rem',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem'
              }}
            >
              ▶️ המשך משחק
            </button>
            <button
              onClick={() => setShowAbandonConfirm(true)}
              style={{
                flex: 1,
                background: 'rgba(255,255,255,0.2)',
                color: 'white',
                border: '1px solid rgba(255,255,255,0.3)',
                borderRadius: '8px',
                padding: '0.6rem',
                fontWeight: '600',
                fontSize: '0.8rem',
                cursor: 'pointer'
              }}
            >
              🗑️ בטל
            </button>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
        <h1 className="page-title" style={{ fontSize: '1.25rem', margin: 0 }}>New Game</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {permanentPlayers.length > 0 && (
            <button className="btn btn-sm btn-secondary" onClick={selectAll} style={{ fontSize: '0.7rem', padding: '0.25rem 0.5rem' }}>
              {permanentPlayers.every(p => selectedIds.has(p.id)) ? 'Deselect All' : 'Select All'}
            </button>
          )}
          <button
            onClick={signOut}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              fontSize: '0.75rem',
              cursor: 'pointer',
              padding: '0.2rem 0.4rem',
              opacity: 0.7,
            }}
            title="Sign Out"
          >
            🔓
          </button>
        </div>
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
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', marginRight: '0.2rem' }}>📍 מיקום:</span>
          {(getSettings().locations || DEFAULT_LOCATIONS).map(loc => (
            <button
              key={loc}
              onClick={() => { setGameLocation(gameLocation === loc ? '' : loc); setCustomLocation(''); }}
              style={{
                padding: '0.3rem 0.55rem',
                borderRadius: '6px',
                fontSize: '0.72rem',
                border: gameLocation === loc ? '2px solid var(--primary)' : '1px solid var(--border)',
                background: gameLocation === loc ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
                color: gameLocation === loc ? 'var(--primary)' : 'var(--text-muted)',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {loc}
            </button>
          ))}
          <button
            onClick={() => setGameLocation(gameLocation === 'other' ? '' : 'other')}
            style={{
              padding: '0.3rem 0.55rem',
              borderRadius: '6px',
              fontSize: '0.72rem',
              border: gameLocation === 'other' ? '2px solid var(--primary)' : '1px solid var(--border)',
              background: gameLocation === 'other' ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
              color: gameLocation === 'other' ? 'var(--primary)' : 'var(--text-muted)',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
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

      <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.75rem', alignItems: 'stretch' }}>
        {isAdmin && (
          <>
            <button 
              className="btn btn-secondary"
              onClick={handleShowForecast}
              disabled={selectedIds.size < 2}
              style={{ padding: '0.5rem 0.4rem', fontSize: '0.7rem', minWidth: '0', flex: '0 0 auto' }}
            >
              🔮 Forecast
            </button>
            {periodMarkers && isAdmin && (() => {
              const autoValue = getAutoDetectedPeriodValue(periodMarkers);
              const activeValue = periodOverride || autoValue;
              const activeOption = PERIOD_OPTIONS.find(o => o.value === activeValue) || PERIOD_OPTIONS[0];
              const isOverridden = periodOverride !== null && periodOverride !== autoValue;
              return (
                <div style={{ position: 'relative', flex: '1 1 0', minWidth: '0' }}>
                  <button
                    onClick={() => setShowPeriodDropdown(!showPeriodDropdown)}
                    style={{
                      width: '100%',
                      height: '100%',
                      padding: '0.5rem 0.35rem',
                      borderRadius: '8px',
                      fontSize: '0.7rem',
                      fontWeight: 600,
                      background: activeValue === 'regular'
                        ? 'rgba(100, 116, 139, 0.15)'
                        : 'rgba(139, 92, 246, 0.2)',
                      color: activeValue === 'regular' ? '#94a3b8' : '#a78bfa',
                      border: `1px solid ${activeValue === 'regular' ? 'rgba(100, 116, 139, 0.25)' : 'rgba(139, 92, 246, 0.35)'}`,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '0.2rem',
                      whiteSpace: 'nowrap',
                      direction: 'rtl',
                    }}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{activeOption.label}</span>
                    {isOverridden && <span style={{ fontSize: '0.5rem', opacity: 0.6, flexShrink: 0 }}>(ידני)</span>}
                    <span style={{ fontSize: '0.55rem', opacity: 0.5, flexShrink: 0 }}>▼</span>
                  </button>
                  {showPeriodDropdown && (
                    <>
                      <div
                        onClick={() => setShowPeriodDropdown(false)}
                        style={{ position: 'fixed', inset: 0, zIndex: 99 }}
                      />
                      <div style={{
                        position: 'absolute',
                        bottom: '100%',
                        left: 0,
                        right: 0,
                        minWidth: '200px',
                        marginBottom: '4px',
                        background: 'var(--surface)',
                        border: '1px solid var(--border)',
                        borderRadius: '8px',
                        boxShadow: '0 -4px 16px rgba(0,0,0,0.3)',
                        zIndex: 100,
                        overflow: 'hidden',
                      }}>
                        <div style={{ padding: '0.4rem 0.6rem', fontSize: '0.65rem', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', direction: 'rtl', textAlign: 'right' }}>
                          זוהה אוטומטית: {PERIOD_OPTIONS.find(o => o.value === autoValue)?.label}
                        </div>
                        {PERIOD_OPTIONS.map(opt => (
                          <button
                            key={opt.value}
                            onClick={() => {
                              const newOverride = opt.value === autoValue ? null : opt.value;
                              setPeriodOverride(newOverride);
                              setPeriodMarkers(applyPeriodOverride(periodMarkers, newOverride));
                              setShowPeriodDropdown(false);
                            }}
                            style={{
                              width: '100%',
                              padding: '0.5rem 0.6rem',
                              background: activeValue === opt.value ? 'rgba(139, 92, 246, 0.15)' : 'transparent',
                              border: 'none',
                              borderBottom: '1px solid rgba(255,255,255,0.05)',
                              color: activeValue === opt.value ? '#a78bfa' : 'var(--text)',
                              fontSize: '0.78rem',
                              cursor: 'pointer',
                              textAlign: 'right',
                              direction: 'rtl',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'flex-start',
                              gap: '0.4rem',
                            }}
                          >
                            <span style={{ flex: 1, textAlign: 'right' }}>{opt.label}</span>
                            {opt.value === autoValue && <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', flexShrink: 0 }}>(אוטומטי)</span>}
                            {activeValue === opt.value && <span style={{ fontSize: '0.7rem', flexShrink: 0 }}>✓</span>}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              );
            })()}
          </>
        )}
        <button 
          className="btn btn-primary"
          onClick={handleStartGame}
          disabled={selectedIds.size < 2 || generatingTTS}
          style={{ padding: '0.5rem 0.6rem', flex: isAdmin ? '1.2 1 0' : '1', fontSize: '0.8rem', minWidth: '0' }}
        >
          {generatingTTS ? '🎙️ מכין את הערב...' : `🎰 Start Game (${selectedIds.size})`}
        </button>
      </div>
      {generatingTTS && (
        <div style={{ padding: '0 0.75rem' }}>
          <AIProgressBar operationKey="tts_pool" />
        </div>
      )}

      {/* Published Forecast - visible to all roles */}
      {publishedForecast && !publishedForecast.linkedGameId && (
        <div className="card" style={{ padding: '1rem', marginTop: '0.5rem' }}>
          <div style={{ textAlign: 'center', marginBottom: '0.75rem' }}>
            <div style={{ fontSize: '1.5rem', marginBottom: '0.2rem' }}>🔮</div>
            <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: '700', color: 'var(--text)' }}>
              {publishedForecast.aiModel ? 'תחזית AI' : 'תחזית'}
            </h3>
            {publishedForecast.aiModel && (
              <div style={{ fontSize: '0.65rem', color: '#A855F7', marginTop: '0.15rem' }}>
                Powered by Gemini ✨ · {publishedForecast.aiModel}
              </div>
            )}
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
              {new Date(publishedForecast.createdAt).toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}
            </div>
          </div>

          {publishedForecast.preGameTeaser && (
            <div style={{
              padding: '0.75rem',
              marginBottom: '0.75rem',
              borderRadius: '10px',
              background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.1), rgba(59, 130, 246, 0.08))',
              border: '1px solid rgba(139, 92, 246, 0.25)',
              textAlign: 'right',
              direction: 'rtl',
            }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#a78bfa', marginBottom: '0.3rem' }}>🎙️ טיזר המשחק</div>
              <div style={{ fontSize: '0.85rem', color: '#e2e8f0', lineHeight: 1.6 }}>
                {publishedForecast.preGameTeaser}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            {publishedForecast.forecasts.map((f, idx) => (
              <div key={idx} style={{
                padding: '0.5rem 0.6rem',
                borderRadius: '8px',
                background: 'var(--surface)',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ fontSize: '0.85rem', fontWeight: '700', width: '1.5rem', textAlign: 'center', color: 'var(--text-muted)', flexShrink: 0 }}>
                    {idx + 1}
                  </span>
                  <span style={{ flex: 1, fontWeight: '600', fontSize: '0.85rem', color: 'var(--text)' }}>
                    {f.playerName}
                  </span>
                  <span style={{ fontSize: '0.75rem', color: f.expectedProfit >= 0 ? 'var(--success)' : 'var(--danger)', fontWeight: '600', flexShrink: 0 }}>
                    {f.expectedProfit >= 0 ? '+' : ''}₪{cleanNumber(f.expectedProfit)}
                  </span>
                </div>
                {f.sentence && (
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.25rem', paddingRight: '2rem', direction: 'rtl', lineHeight: 1.5 }}>
                    {f.sentence}
                  </div>
                )}
              </div>
            ))}
          </div>

          {role === 'admin' && (
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
              <button
                onClick={handleSharePublished}
                style={{
                  padding: '0.4rem 0.8rem',
                  borderRadius: '6px',
                  border: '1px solid rgba(34, 197, 94, 0.3)',
                  background: 'rgba(34, 197, 94, 0.1)',
                  color: '#22c55e',
                  fontSize: '0.75rem',
                  cursor: 'pointer',
                }}
              >
                📤 שתף
              </button>
              <button
                onClick={handleShowForecast}
                disabled={selectedIds.size < 2}
                style={{
                  padding: '0.4rem 0.8rem',
                  borderRadius: '6px',
                  border: '1px solid rgba(139, 92, 246, 0.3)',
                  background: 'rgba(139, 92, 246, 0.1)',
                  color: '#a78bfa',
                  fontSize: '0.75rem',
                  cursor: 'pointer',
                }}
              >
                🔄 חדש
              </button>
              <button
                onClick={handleUnpublishForecast}
                style={{
                  padding: '0.4rem 0.8rem',
                  borderRadius: '6px',
                  border: '1px solid var(--border)',
                  background: 'var(--surface)',
                  color: 'var(--text-muted)',
                  fontSize: '0.75rem',
                  cursor: 'pointer',
                }}
              >
                🔒 הסתר
              </button>
              <button
                onClick={handleDeleteForecast}
                style={{
                  padding: '0.4rem 0.8rem',
                  borderRadius: '6px',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  background: 'rgba(239, 68, 68, 0.1)',
                  color: '#ef4444',
                  fontSize: '0.75rem',
                  cursor: 'pointer',
                }}
              >
                🗑️ מחק
              </button>
            </div>
          )}
        </div>
      )}

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
                <AIProgressBar operationKey="forecast" />
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
                          // Clear AI state and generate local forecast
                          setAiForecasts(null);
                          setAiError(null);
                          setRetryCountdown(null);
                          if (retryTimerRef.current) clearInterval(retryTimerRef.current);
                          // Generate local forecasts
                          const localForecasts = generateForecasts();
                          setCachedForecasts(localForecasts);
                          console.log('📊 Generated local forecast for', localForecasts.length, 'players');
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
                        Generate Local Forecast Instead
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
                  {aiModelName && (
                    <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: '0.15rem', opacity: 0.7 }}>
                      model: {aiModelName}
                    </div>
                  )}
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                    {new Date().toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' })}
                  </div>
                </div>

                {/* Pre-Game Teaser card */}
                {aiForecasts[0]?.preGameTeaser && (
                  <div style={{
                    padding: '1rem 1.1rem',
                    marginBottom: '1.25rem',
                    borderRadius: '14px',
                    background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.12), rgba(59, 130, 246, 0.10))',
                    border: '1px solid rgba(139, 92, 246, 0.35)',
                    textAlign: 'right',
                    direction: 'rtl',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.5rem', flexDirection: 'row-reverse', justifyContent: 'center' }}>
                      <span style={{ fontSize: '1.1rem' }}>🎙️</span>
                      <span style={{ fontSize: '0.8rem', fontWeight: 700, color: '#a78bfa', letterSpacing: '0.5px' }}>טיזר המשחק</span>
                    </div>
                    <div style={{ fontSize: '0.92rem', color: '#e2e8f0', lineHeight: 1.7, fontWeight: 400 }}>
                      {aiForecasts[0].preGameTeaser}
                    </div>
                  </div>
                )}

                {/* Combo History indicator */}
                {comboHistory && (
                  <div style={{
                    padding: '0.85rem 1rem',
                    marginBottom: '1.25rem',
                    borderRadius: '12px',
                    background: comboHistory.isFirstTime
                      ? 'linear-gradient(135deg, rgba(34, 197, 94, 0.10), rgba(16, 185, 129, 0.08))'
                      : 'linear-gradient(135deg, rgba(251, 191, 36, 0.10), rgba(245, 158, 11, 0.08))',
                    border: `1px solid ${comboHistory.isFirstTime ? 'rgba(34, 197, 94, 0.3)' : 'rgba(251, 191, 36, 0.3)'}`,
                    textAlign: 'right',
                    direction: 'rtl',
                  }}>
                    {comboHistory.isFirstTime ? (
                      <div style={{ fontSize: '0.85rem', color: '#e2e8f0' }}>
                        <span style={{ fontSize: '1rem' }}>🆕</span>{' '}
                        <strong style={{ color: '#4ade80' }}>הרכב חדש!</strong> זו הפעם הראשונה שבדיוק {comboHistory.playerCount} השחקנים האלה משחקים יחד. מה יקרה?
                      </div>
                    ) : (
                      <div>
                        {/* Header */}
                        <div style={{ marginBottom: '0.75rem' }}>
                          <div style={{ fontSize: '0.88rem', color: '#e2e8f0' }}>
                            <span style={{ fontSize: '1rem' }}>🔄</span>{' '}
                            <strong style={{ color: '#fbbf24' }}>הרכב חוזר!</strong>
                          </div>
                          <div style={{ fontSize: '0.76rem', color: '#94a3b8', marginTop: '0.2rem' }}>
                            פעם {comboHistory.totalGamesWithCombo + 1} שאותם {comboHistory.playerCount} שחקנים נפגשים
                          </div>
                        </div>

                        {comboHistory.totalGamesWithCombo === 1 ? (
                          /* === SINGLE GAME: compact result + unique insights === */
                          (() => {
                            const game = comboHistory.previousGames[0];
                            if (!game) return null;
                            const dateStr = (() => { try { return new Date(game.date).toLocaleDateString('he-IL', { day: 'numeric', month: 'short', year: '2-digit' }); } catch { return game.date; } })();
                            const daysAgo = Math.round((Date.now() - new Date(game.date).getTime()) / (1000 * 60 * 60 * 24));
                            const timeAgoStr = daysAgo <= 1 ? 'אתמול' : daysAgo <= 7 ? `לפני ${daysAgo} ימים` : daysAgo <= 30 ? `לפני ${Math.round(daysAgo / 7)} שבועות` : daysAgo <= 60 ? 'לפני חודש' : `לפני ${Math.round(daysAgo / 30)} חודשים`;
                            const topRebuyer = [...game.results].sort((a, b) => b.rebuys - a.rebuys)[0];
                            const winnersCount = game.results.filter(r => r.profit > 0).length;

                            const insights: { emoji: string; text: string; color: string }[] = [];
                            if (topRebuyer && topRebuyer.rebuys >= 3 && topRebuyer.playerName !== game.winnerName) {
                              insights.push({ emoji: '💸', text: `${topRebuyer.playerName} קנה הכי הרבה (${topRebuyer.rebuys}) אבל לא ניצח`, color: '#f59e0b' });
                            } else if (topRebuyer && topRebuyer.playerName === game.winnerName && topRebuyer.rebuys >= 3) {
                              insights.push({ emoji: '🔥', text: `${topRebuyer.playerName} קנה הכי הרבה (${topRebuyer.rebuys}) ובכל זאת ניצח`, color: '#4ade80' });
                            }
                            if (winnersCount === 1) {
                              insights.push({ emoji: '🎯', text: `רק מנצח אחד מתוך ${game.results.length} — ערב קשה`, color: '#a78bfa' });
                            } else if (winnersCount >= Math.ceil(game.results.length / 2)) {
                              insights.push({ emoji: '⚖️', text: `${winnersCount} מתוך ${game.results.length} סיימו ברווח — ערב מאוזן`, color: '#94a3b8' });
                            }
                            const loserRebuys = game.results[game.results.length - 1]?.rebuys || 0;
                            if (loserRebuys <= 1) {
                              insights.push({ emoji: '😱', text: `${game.loserName} הפסיד הכי הרבה עם רק קנייה אחת`, color: '#f87171' });
                            }

                            return (
                              <div>
                                <div style={{ padding: '0.4rem 0.55rem', borderRadius: '8px', background: 'rgba(255,255,255,0.04)', marginBottom: '0.5rem' }}>
                                  <div style={{ color: '#64748b', fontSize: '0.7rem', marginBottom: '0.2rem' }}>{dateStr} ({timeAgoStr})</div>
                                  <div style={{ fontSize: '0.8rem' }}>
                                    <span style={{ color: '#4ade80' }}>👑 {game.winnerName} (+{Math.round(game.winnerProfit)}₪)</span>
                                    {'  '}
                                    <span style={{ color: '#f87171' }}>💀 {game.loserName} ({Math.round(game.loserProfit)}₪)</span>
                                  </div>
                                  <div style={{ fontSize: '0.72rem', color: '#64748b', marginTop: '0.2rem' }}>
                                    {game.totalRebuys} קניות סה"כ • {game.results.length} שחקנים
                                  </div>
                                </div>
                                {insights.length > 0 && (
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', marginBottom: '0.3rem' }}>
                                    {insights.map((ins, i) => (
                                      <div key={i} style={{ fontSize: '0.76rem', color: ins.color }}>
                                        {ins.emoji} {ins.text}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })()
                        ) : (
                          /* === MULTIPLE GAMES: Leader/bottom + patterns + insights === */
                          <div>
                            {/* Combo leader + bottom with avg */}
                            {comboHistory.playerStats.length >= 2 && (() => {
                              const top = comboHistory.playerStats[0];
                              const bottom = comboHistory.playerStats[comboHistory.playerStats.length - 1];
                              return (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginBottom: '0.75rem', padding: '0.5rem 0.65rem', borderRadius: '8px', background: 'rgba(255,255,255,0.04)', direction: 'rtl', textAlign: 'right' }}>
                                  <div style={{ fontSize: '0.8rem', color: '#e2e8f0' }}>
                                    👑 <span style={{ color: '#fbbf24', fontWeight: 600 }}>מוביל ההרכב:</span>{' '}
                                    {top.playerName}{' '}
                                    <span style={{ color: top.totalProfit >= 0 ? '#4ade80' : '#f87171' }}>
                                      ({top.totalProfit >= 0 ? '+' : ''}{Math.round(top.totalProfit)}₪)
                                    </span>
                                    <span style={{ color: '#64748b', fontSize: '0.72rem' }}>{' '}ממוצע {top.avgProfit >= 0 ? '+' : ''}{Math.round(top.avgProfit)}₪ • {top.wins}/{comboHistory.totalGamesWithCombo} נצחונות</span>
                                  </div>
                                  <div style={{ fontSize: '0.8rem', color: '#e2e8f0' }}>
                                    📉 <span style={{ fontWeight: 600 }}>תחתית ההרכב:</span>{' '}
                                    {bottom.playerName}{' '}
                                    <span style={{ color: '#f87171' }}>
                                      ({bottom.totalProfit >= 0 ? '+' : ''}{Math.round(bottom.totalProfit)}₪)
                                    </span>
                                    <span style={{ color: '#64748b', fontSize: '0.72rem' }}>{' '}ממוצע {bottom.avgProfit >= 0 ? '+' : ''}{Math.round(bottom.avgProfit)}₪</span>
                                  </div>
                                </div>
                              );
                            })()}

                            {/* Patterns */}
                            {(comboHistory.playerStats.some(p => p.alwaysWon) || comboHistory.playerStats.some(p => p.alwaysLost) || (comboHistory.uniqueWinners.length === comboHistory.totalGamesWithCombo) || comboHistory.repeatWinners.length > 0) && (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', marginBottom: '0.75rem', direction: 'rtl', textAlign: 'right' }}>
                                {comboHistory.playerStats.filter(p => p.alwaysWon).length > 0 && (
                                  <div style={{ fontSize: '0.78rem', color: '#4ade80' }}>
                                    ⭐ תמיד ברווח: {comboHistory.playerStats.filter(p => p.alwaysWon).map(p => `${p.playerName} (${p.wins}/${comboHistory.totalGamesWithCombo})`).join(', ')}
                                  </div>
                                )}
                                {comboHistory.playerStats.filter(p => p.alwaysLost).length > 0 && (
                                  <div style={{ fontSize: '0.78rem', color: '#f87171' }}>
                                    ⚠️ תמיד בהפסד: {comboHistory.playerStats.filter(p => p.alwaysLost).map(p => p.playerName).join(', ')}
                                  </div>
                                )}
                                {comboHistory.uniqueWinners.length === comboHistory.totalGamesWithCombo && (
                                  <div style={{ fontSize: '0.78rem', color: '#a78bfa' }}>
                                    🎲 מנצח שונה בכל משחק — מי הפעם?
                                  </div>
                                )}
                                {comboHistory.repeatWinners.length > 0 && (
                                  <div style={{ fontSize: '0.78rem', color: '#fbbf24' }}>
                                    🏆 ניצחו יותר מפעם: {comboHistory.repeatWinners.map(w => `${w.name} (${w.count}/${comboHistory.totalGamesWithCombo})`).join(', ')}
                                  </div>
                                )}
                              </div>
                            )}

                            {/* Combo insights */}
                            {(() => {
                              const insights: string[] = [];
                              const avgRebuys = Math.round(comboHistory.playerStats.reduce((s, p) => s + p.totalRebuys, 0) / comboHistory.totalGamesWithCombo);
                              const biggestWin = comboHistory.playerStats.reduce((best, p) => p.bestResult > best.profit ? { name: p.playerName, profit: p.bestResult } : best, { name: '', profit: 0 });
                              const biggestLoss = comboHistory.playerStats.reduce((worst, p) => p.worstResult < worst.profit ? { name: p.playerName, profit: p.worstResult } : worst, { name: '', profit: 0 });

                              if (avgRebuys > 0) insights.push(`📊 ממוצע ${avgRebuys} קניות למשחק בהרכב הזה`);
                              if (biggestWin.profit > 0) insights.push(`🏆 רווח שיא: ${biggestWin.name} +${Math.round(biggestWin.profit)}₪`);
                              if (biggestLoss.profit < 0) insights.push(`💸 הפסד שיא: ${biggestLoss.name} ${Math.round(biggestLoss.profit)}₪`);
                              if (comboHistory.spanDays > 30) insights.push(`📅 ההרכב הזה משחק יחד כבר ${Math.round(comboHistory.spanDays / 30)} חודשים`);

                              if (insights.length === 0) return null;
                              return (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', marginBottom: '0.6rem', direction: 'rtl', textAlign: 'right' }}>
                                  {insights.map((insight, i) => (
                                    <div key={i} style={{ fontSize: '0.76rem', color: '#94a3b8' }}>{insight}</div>
                                  ))}
                                </div>
                              );
                            })()}

                            {/* Previous games */}
                            <div style={{ fontSize: '0.75rem', color: '#64748b', fontWeight: 600, marginBottom: '0.3rem', direction: 'rtl', textAlign: 'right' }}>
                              📅 משחקים קודמים:
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', marginBottom: '0.6rem' }}>
                              {comboHistory.previousGames.slice(-3).map((game, i) => {
                                const dateStr = (() => { try { return new Date(game.date).toLocaleDateString('he-IL', { day: 'numeric', month: 'short', year: '2-digit' }); } catch { return game.date; } })();
                                return (
                                  <div key={i} style={{ padding: '0.35rem 0.5rem', borderRadius: '6px', background: 'rgba(255,255,255,0.03)', fontSize: '0.76rem', color: '#94a3b8', direction: 'rtl', textAlign: 'right' }}>
                                    <div style={{ color: '#64748b', fontSize: '0.7rem', marginBottom: '0.15rem' }}>{dateStr}</div>
                                    <div>
                                      <span style={{ color: '#4ade80' }}>👑 {game.winnerName} (+{Math.round(game.winnerProfit)}₪)</span>
                                      {'  '}
                                      <span style={{ color: '#f87171' }}>💀 {game.loserName} ({Math.round(game.loserProfit)}₪)</span>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* AI Player forecasts - sorted by expected profit (highest first) */}
                <div style={{ marginBottom: '1rem' }}>
                  {[...aiForecasts].sort((a, b) => b.expectedProfit - a.expectedProfit).map((forecast, index) => {
                    const { name, expectedProfit, sentence, highlight, isSurprise } = forecast;
                    
                    const getStyle = () => {
                      if (isSurprise) return { bg: 'rgba(168, 85, 247, 0.15)', border: '#a855f7' };
                      if (expectedProfit >= 0) return { bg: 'rgba(34, 197, 94, 0.12)', border: '#22c55e' };
                      return { bg: 'rgba(239, 68, 68, 0.12)', border: '#ef4444' };
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
                            color: 'white',
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
                            color: 'white',
                            fontFamily: 'system-ui'
                          }}>
                            {expectedProfit >= 0 ? '+' : '-'}₪{cleanNumber(Math.abs(expectedProfit))}
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
                          color: 'var(--text-muted)',
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
                    תחזית המשחק
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
                      if (isSurprise) return { bg: 'rgba(168, 85, 247, 0.15)', border: '#a855f7' };
                      if (expected >= 0) return { bg: 'rgba(34, 197, 94, 0.12)', border: '#22c55e' };
                      return { bg: 'rgba(239, 68, 68, 0.12)', border: '#ef4444' };
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
                            color: 'white',
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
                            color: 'white',
                            fontFamily: 'system-ui'
                          }}>
                            {expected >= 0 ? '+' : '-'}₪{cleanNumber(Math.abs(expected))}
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
                          color: 'var(--text-muted)',
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
              <div style={{ marginTop: '1rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <div className="actions">
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
                {role === 'admin' && (
                  <button
                    onClick={() => handlePublishForecast()}
                    disabled={!!publishedForecast}
                    style={{
                      width: '100%',
                      padding: '0.6rem',
                      borderRadius: '8px',
                      border: publishedForecast
                        ? '1px solid rgba(16, 185, 129, 0.2)'
                        : '1px solid rgba(16, 185, 129, 0.4)',
                      background: publishedForecast
                        ? 'rgba(16, 185, 129, 0.05)'
                        : 'rgba(16, 185, 129, 0.1)',
                      color: publishedForecast ? '#6ee7b7' : '#10b981',
                      fontSize: '0.85rem',
                      fontWeight: '600',
                      cursor: publishedForecast ? 'default' : 'pointer',
                      opacity: publishedForecast ? 0.7 : 1,
                    }}
                  >
                    {publishedForecast ? '✅ התחזית פורסמה' : '📢 פרסם תחזית לכולם'}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
      
      {/* Forecast Mismatch Dialog */}
      {showMismatchDialog && mismatchInfo && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.85)',
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
            maxWidth: '380px',
            width: '100%',
            textAlign: 'center',
            direction: 'rtl'
          }}>
            <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>⚠️</div>
            <h3 style={{ marginBottom: '0.5rem', color: 'var(--text)' }}>השחקנים השתנו</h3>
            <p style={{ marginBottom: '0.75rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              קיימת תחזית מ-{mismatchInfo.pendingDate} עם שחקנים שונים
            </p>
            
            {/* Changes summary */}
            <div style={{ 
              background: 'var(--surface)', 
              borderRadius: '10px', 
              padding: '0.75rem',
              marginBottom: '1rem',
              fontSize: '0.85rem',
              textAlign: 'right'
            }}>
              {mismatchInfo.removedPlayers.length > 0 && (
                <div style={{ marginBottom: '0.5rem', color: '#ef4444' }}>
                  <strong>ביטלו:</strong> {mismatchInfo.removedPlayers.join(', ')}
                </div>
              )}
              {mismatchInfo.addedPlayers.length > 0 && (
                <div style={{ color: '#22c55e' }}>
                  <strong>הצטרפו:</strong> {mismatchInfo.addedPlayers.join(', ')}
                </div>
              )}
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              <button 
                className="btn btn-primary"
                onClick={handleUpdateForecast}
                style={{ width: '100%' }}
              >
                🤖 צור תחזית חדשה
              </button>
              <button 
                className="btn btn-secondary"
                onClick={handleKeepOldForecast}
                style={{ width: '100%' }}
              >
                📊 המשך עם התחזית הקיימת
                <div style={{ fontSize: '0.7rem', opacity: 0.7, marginTop: '0.2rem' }}>
                  (רק שחקנים שבשניהם יושוו)
                </div>
              </button>
              <button 
                onClick={handleStartWithoutForecast}
                style={{ 
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-muted)',
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                  padding: '0.5rem'
                }}
              >
                התחל ללא תחזית
              </button>
            </div>
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

      {/* Abandon Game Confirmation Modal */}
      {showAbandonConfirm && (
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
            <div style={{ fontSize: '3rem', marginBottom: '0.75rem' }}>🗑️</div>
            <h3 style={{ marginBottom: '0.5rem', color: 'var(--text)' }}>לבטל את המשחק?</h3>
            <p style={{ marginBottom: '1.25rem', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
              כל הנתונים של המשחק הזה יימחקו לצמיתות.
            </p>
            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
              <button 
                className="btn btn-secondary"
                onClick={() => setShowAbandonConfirm(false)}
                style={{ flex: 1 }}
              >
                חזור
              </button>
              <button 
                className="btn btn-danger"
                onClick={handleAbandonGame}
                style={{ flex: 1 }}
              >
                🗑️ בטל משחק
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default NewGameScreen;