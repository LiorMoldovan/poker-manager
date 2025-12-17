import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import html2canvas from 'html2canvas';
import { Player, PlayerType, PlayerStats } from '../types';
import { getAllPlayers, addPlayer, createGame, getPlayerByName, getPlayerStats } from '../database/storage';

// Default location options
const LOCATION_OPTIONS = ['ליאור', 'סגל', 'ליכטר', 'אייל'];

const NewGameScreen = () => {
  const navigate = useNavigate();
  const [players, setPlayers] = useState<Player[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showAddPlayer, setShowAddPlayer] = useState(false);
  const [newPlayerName, setNewPlayerName] = useState('');
  const [newPlayerType, setNewPlayerType] = useState<PlayerType>('guest');
  const [error, setError] = useState('');
  const [showPermanentGuests, setShowPermanentGuests] = useState(false);
  const [showGuests, setShowGuests] = useState(false);
  const [showForecast, setShowForecast] = useState(false);
  const [playerStats, setPlayerStats] = useState<PlayerStats[]>([]);
  const [gameLocation, setGameLocation] = useState<string>('');
  const [customLocation, setCustomLocation] = useState<string>('');
  const [isSharing, setIsSharing] = useState(false);
  const [cachedForecasts, setCachedForecasts] = useState<ReturnType<typeof generateForecasts> | null>(null);
  const forecastRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadPlayers();
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
    const game = createGame(Array.from(selectedIds), location || undefined);
    navigate(`/live-game/${game.id}`);
  };

  // Get stats for a player
  const getStatsForPlayer = (playerId: string): PlayerStats | undefined => {
    return playerStats.find(s => s.playerId === playerId);
  };

  // ============ SMART FORECAST SYSTEM WITH RECENT DATA ============
  
  // Analyze recent performance (last 6 games)
  interface RecentAnalysis {
    recentWins: number;
    recentLosses: number;
    recentProfit: number;
    recentAvg: number;
    trend: 'hot' | 'cold' | 'improving' | 'declining' | 'stable';
    streakText: string;
  }
  
  const analyzeRecent = (stats: PlayerStats): RecentAnalysis => {
    const lastGames = stats.lastGameResults || [];
    if (lastGames.length === 0) {
      return { recentWins: 0, recentLosses: 0, recentProfit: 0, recentAvg: 0, trend: 'stable', streakText: '' };
    }
    
    const recentWins = lastGames.filter(g => g.profit > 0).length;
    const recentLosses = lastGames.filter(g => g.profit < 0).length;
    const recentProfit = lastGames.reduce((sum, g) => sum + g.profit, 0);
    const recentAvg = recentProfit / lastGames.length;
    
    // Determine trend
    let trend: RecentAnalysis['trend'] = 'stable';
    const streak = stats.currentStreak;
    
    if (streak >= 3) trend = 'hot';
    else if (streak <= -3) trend = 'cold';
    else if (recentAvg > stats.avgProfit + 15) trend = 'improving';
    else if (recentAvg < stats.avgProfit - 15) trend = 'declining';
    
    // Build streak text
    let streakText = '';
    if (streak >= 2) streakText = `🔥 ${streak} נצחונות ברצף`;
    else if (streak <= -2) streakText = `❄️ ${Math.abs(streak)} הפסדים ברצף`;
    else if (recentWins >= 4) streakText = `${recentWins} מתוך ${lastGames.length} אחרונים ברווח`;
    else if (recentLosses >= 4) streakText = `${recentLosses} מתוך ${lastGames.length} אחרונים בהפסד`;
    
    return { recentWins, recentLosses, recentProfit, recentAvg, trend, streakText };
  };

  // Generate dynamic sentence based on actual data
  const generateSentence = (
    name: string, 
    stats: PlayerStats, 
    recent: RecentAnalysis,
    expectedOutcome: 'big_win' | 'win' | 'slight_win' | 'neutral' | 'slight_loss' | 'loss' | 'big_loss',
    isSurprise: boolean
  ): string => {
    const { recentWins, recentLosses, recentAvg, trend, streakText } = recent;
    const lastGamesCount = stats.lastGameResults?.length || 0;
    const overallAvg = Math.round(stats.avgProfit);
    const recentAvgRound = Math.round(recentAvg);
    
    // Hot streak - player is on fire
    if (trend === 'hot' && stats.currentStreak >= 3) {
      const sentences = [
        `${name} בוער! ${stats.currentStreak} נצחונות ברצף ולא נראה שהוא מתכוון לעצור`,
        `${name} על גל חם - ${stats.currentStreak} נצחונות רצופים. קשה להמר נגדו עכשיו`,
        `מי עוצר את ${name}? ${stats.currentStreak} נצחונות ברצף, ממוצע ${recentAvgRound > 0 ? '+' : ''}${recentAvgRound}₪ לאחרונה`,
      ];
      return sentences[Math.floor(Math.random() * sentences.length)];
    }
    
    // Cold streak - player is struggling
    if (trend === 'cold' && stats.currentStreak <= -3) {
      const sentences = [
        `${name} בתקופה קשה - ${Math.abs(stats.currentStreak)} הפסדים ברצף. השאלה אם הלילה זה ישתנה`,
        `${Math.abs(stats.currentStreak)} הפסדים רצופים ל${name}. הסטטיסטיקה לא לצידו`,
        `${name} סובל לאחרונה - ${Math.abs(stats.currentStreak)} הפסדים ברצף, ${recentAvgRound}₪ ממוצע אחרון`,
      ];
      return sentences[Math.floor(Math.random() * sentences.length)];
    }
    
    // Improving - recent better than overall
    if (trend === 'improving' && lastGamesCount >= 4) {
      const sentences = [
        `${name} בעלייה! ממוצע ${recentAvgRound > 0 ? '+' : ''}${recentAvgRound}₪ ב-${lastGamesCount} משחקים אחרונים (לעומת ${overallAvg}₪ כללי)`,
        `${name} השתפר: ${recentWins} מתוך ${lastGamesCount} אחרונים ברווח. המומנטום לצידו`,
        `שינוי מגמה ל${name} - מ-${overallAvg}₪ ממוצע כללי ל-${recentAvgRound}₪ לאחרונה`,
      ];
      return sentences[Math.floor(Math.random() * sentences.length)];
    }
    
    // Declining - recent worse than overall  
    if (trend === 'declining' && lastGamesCount >= 4) {
      const sentences = [
        `${name} בירידה: ממוצע ${recentAvgRound}₪ ב-${lastGamesCount} אחרונים (לעומת ${overallAvg > 0 ? '+' : ''}${overallAvg}₪ כללי)`,
        `${name} לא באותה פורמה - ${recentLosses} הפסדים מתוך ${lastGamesCount} אחרונים`,
        `הנתונים האחרונים של ${name} מדאיגים: ${recentAvgRound}₪ ממוצע, ${recentWins}/${lastGamesCount} נצחונות`,
      ];
      return sentences[Math.floor(Math.random() * sentences.length)];
    }
    
    // Surprise prediction
    if (isSurprise) {
      if (expectedOutcome.includes('win')) {
        const sentences = [
          `נגד הנתונים: ${name} עם ${overallAvg}₪ ממוצע, אבל ${recentWins}/${lastGamesCount} נצחונות אחרונים. יכול להפתיע`,
          `${name} בדרך כלל מפסיד (${overallAvg}₪), אבל משהו באחרונה השתנה. שווה לעקוב`,
          `הפתעה אפשרית: ${name} עם היסטוריה קשה, אבל ${recentWins} נצחונות ב-${lastGamesCount} אחרונים`,
        ];
        return sentences[Math.floor(Math.random() * sentences.length)];
      } else {
        const sentences = [
          `אזהרה ל${name}: למרות ${overallAvg > 0 ? '+' : ''}${overallAvg}₪ ממוצע, רק ${recentWins}/${lastGamesCount} נצחונות אחרונים`,
          `${name} רגיל לנצח (${stats.winPercentage.toFixed(0)}%), אבל הנתונים האחרונים (${recentAvgRound}₪) מדאיגים`,
          `לא הכל ורוד ל${name} - ${recentLosses} הפסדים מתוך ${lastGamesCount} אחרונים למרות היסטוריה טובה`,
        ];
        return sentences[Math.floor(Math.random() * sentences.length)];
      }
    }
    
    // Regular predictions based on combined data
    const winPct = Math.round(stats.winPercentage);
    const totalProfit = Math.round(Math.abs(stats.totalProfit));
    
    switch (expectedOutcome) {
      case 'big_win':
        const bigWinSentences = [
          `${name} שולט: ${recentWins}/${lastGamesCount} נצחונות אחרונים, +${overallAvg}₪ ממוצע כללי. המועמד לכתר`,
          `הנתונים ברורים - ${name} עם ${winPct}% נצחונות, +${recentAvgRound}₪ לאחרונה. מסוכן`,
          `${name} לקח ${totalProfit}₪ עד היום. ${recentWins} נצחונות ב-${lastGamesCount} אחרונים. ממשיך לשלוט`,
        ];
        return bigWinSentences[Math.floor(Math.random() * bigWinSentences.length)];
        
      case 'win':
        const winSentences = [
          `${name} בפורמה טובה: ${recentWins}/${lastGamesCount} נצחונות אחרונים, ${winPct}% הצלחה כללית`,
          `הנתונים תומכים ב${name} - ממוצע +${overallAvg}₪, ${recentAvgRound > 0 ? '+' : ''}${recentAvgRound}₪ לאחרונה`,
          `${name} עקבי: ${winPct}% נצחונות כלליים, ${recentWins} מתוך ${lastGamesCount} אחרונים ברווח`,
        ];
        return winSentences[Math.floor(Math.random() * winSentences.length)];
        
      case 'slight_win':
        const slightWinSentences = [
          `${name} עם יתרון קל: ${recentWins}/${lastGamesCount} אחרונים, ממוצע +${overallAvg}₪`,
          `סיכוי טוב ל${name} - ${winPct}% הצלחה כללית, ${recentAvgRound > 0 ? 'פלוס' : 'מאוזן'} לאחרונה`,
          `${name} בכיוון חיובי: ממוצע +${overallAvg}₪, ${recentWins} נצחונות מתוך ${lastGamesCount} אחרונים`,
        ];
        return slightWinSentences[Math.floor(Math.random() * slightWinSentences.length)];
        
      case 'neutral':
        const neutralSentences = [
          `${name} על הגבול: ${recentWins}/${lastGamesCount} נצחונות אחרונים, ממוצע ${overallAvg}₪. יכול ללכת לכל כיוון`,
          `50-50 ל${name} - ${winPct}% הצלחה כללית, ${recentAvgRound}₪ לאחרונה. תלוי במזל`,
          `${name} באמצע: ${recentWins} נצחונות, ${recentLosses} הפסדים ב-${lastGamesCount} אחרונים. מי יודע?`,
        ];
        return neutralSentences[Math.floor(Math.random() * neutralSentences.length)];
        
      case 'slight_loss':
        const slightLossSentences = [
          `${name} עם נטייה למינוס: ${recentLosses}/${lastGamesCount} הפסדים אחרונים, ממוצע ${overallAvg}₪`,
          `הנתונים לא לטובת ${name} - ${winPct}% הצלחה, ${recentAvgRound}₪ לאחרונה`,
          `${name} מתקשה: ${recentWins} נצחונות מתוך ${lastGamesCount} אחרונים, ממוצע כללי ${overallAvg}₪`,
        ];
        return slightLossSentences[Math.floor(Math.random() * slightLossSentences.length)];
        
      case 'loss':
        const lossSentences = [
          `${name} בקושי: רק ${recentWins}/${lastGamesCount} נצחונות אחרונים, ${winPct}% הצלחה כללית`,
          `הנתונים קשים ל${name} - ממוצע ${overallAvg}₪, ${recentAvgRound}₪ לאחרונה`,
          `${name} צפוי להפסד: ${recentLosses} הפסדים מתוך ${lastGamesCount} אחרונים, ${winPct}% הצלחה`,
        ];
        return lossSentences[Math.floor(Math.random() * lossSentences.length)];
        
      case 'big_loss':
        const bigLossSentences = [
          `${name} בבעיה: ${recentLosses}/${lastGamesCount} הפסדים אחרונים, ${totalProfit}₪- עד היום`,
          `הנתונים חד משמעיים - ${name} עם ${winPct}% הצלחה, ${recentAvgRound}₪ לאחרונה. קשה`,
          `${name} הספונסר שלנו: ${recentWins} נצחונות מתוך ${lastGamesCount} אחרונים, ממוצע ${overallAvg}₪`,
        ];
        return bigLossSentences[Math.floor(Math.random() * bigLossSentences.length)];
    }
    
    return `${name} - ${recentWins}/${lastGamesCount} נצחונות אחרונים`;
  };

  // NEW PLAYERS - No history
  const newPlayerSentences = [
    `{name} - שחקן חדש, אין נתונים. הכל פתוח!`,
    `אין לנו היסטוריה על {name}. הלילה נגלה מה הוא שווה`,
    `{name} מתחיל מאפס - בלי יתרון, בלי חיסרון. טאבולה ראסה`,
    `{name} נכנס בלי תיק עבר. יכול להיות הכל`,
  ];


  // Generate forecasts for all selected players - WEIGHTED RECENT PERFORMANCE
  const generateForecasts = () => {
    // Step 1: Analyze all players with recent performance
    const playerAnalysis = Array.from(selectedIds).map(playerId => {
      const player = players.find(p => p.id === playerId);
      if (!player) return null;
      
      const stats = getStatsForPlayer(playerId);
      const gamesPlayed = stats?.gamesPlayed || 0;
      const avgProfit = stats?.avgProfit || 0;
      
      // Get recent analysis (last 6 games)
      const recent = stats ? analyzeRecent(stats) : { 
        recentWins: 0, recentLosses: 0, recentProfit: 0, recentAvg: 0, trend: 'stable' as const, streakText: '' 
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
        expectedValue = -expectedValue * (0.5 + Math.random() * 0.3);
      } else {
        // Add small variance
        expectedValue = expectedValue + (Math.random() - 0.5) * 10;
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
      
      // Generate sentence - new players get template, others get dynamic
      let sentence: string;
      
      if (f.gamesPlayed === 0) {
        const template = newPlayerSentences[Math.floor(Math.random() * newPlayerSentences.length)];
        sentence = template.replace(/{name}/g, f.player.name);
      } else {
        sentence = generateSentence(f.player.name, f.stats!, f.recent, outcome, f.isSurprise);
      }
      
      return {
        player: f.player,
        expected: balancedExpected,
        sentence,
        gamesPlayed: f.gamesPlayed,
        isSurprise: f.isSurprise,
        recent: f.recent
      };
    });

    return balanced.sort((a, b) => b.expected - a.expected);
  };

  // Share forecast as screenshot to WhatsApp
  const shareForecast = async () => {
    if (!forecastRef.current || isSharing) return;
    
    setIsSharing(true);
    
    try {
      const canvas = await html2canvas(forecastRef.current, {
        backgroundColor: '#1a1a2e',
        scale: 2,
        useCORS: true,
        logging: false,
      });
      
      const blob = await new Promise<Blob>((resolve) => {
        canvas.toBlob((b) => resolve(b!), 'image/png', 1.0);
      });
      
      const file = new File([blob], 'poker-forecast.png', { type: 'image/png' });
      
      if (navigator.share && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'תחזית פוקר' });
      } else {
        // Fallback: download + WhatsApp
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'poker-forecast.png';
        a.click();
        URL.revokeObjectURL(url);
        
        const today = new Date().toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'short' });
        window.open(`https://wa.me/?text=${encodeURIComponent(`🔮 תחזית פוקר - ${today}\n\n(התמונה הורדה - צרף אותה)`)}`, '_blank');
      }
    } catch (error) {
      console.error('Error sharing forecast:', error);
    } finally {
      setIsSharing(false);
    }
  };

  const handleShowForecast = () => {
    if (selectedIds.size < 2) {
      setError('Select at least 2 players');
      return;
    }
    // Generate and cache forecasts when modal opens
    setCachedForecasts(generateForecasts());
    setShowForecast(true);
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
        <button 
          className="btn btn-secondary"
          onClick={handleShowForecast}
          disabled={selectedIds.size < 2}
          style={{ padding: '0.6rem', flex: '1', fontSize: '0.85rem' }}
        >
          🔮 Forecast
        </button>
        <button 
          className="btn btn-primary"
          onClick={handleStartGame}
          disabled={selectedIds.size < 2}
          style={{ padding: '0.6rem', flex: '2', fontSize: '0.9rem' }}
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

      {/* Forecast Modal */}
      {showForecast && cachedForecasts && (
        <div className="modal-overlay" onClick={() => { setShowForecast(false); setCachedForecasts(null); }}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxHeight: '85vh', overflow: 'auto', maxWidth: '420px' }}>
            {/* Screenshotable content */}
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

              {/* Player forecasts */}
              <div style={{ marginBottom: '1rem' }}>
                {cachedForecasts.map((forecast, index) => {
                  const { player, expected, sentence, gamesPlayed, isSurprise, recent } = forecast;
                  
                  // Simple, clear colors
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
                        marginBottom: '0.35rem'
                      }}>
                        <span style={{ 
                          fontWeight: '700', 
                          fontSize: '1rem',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.3rem'
                        }}>
                          {index === 0 && expected > 0 && <span>👑</span>}
                          {isSurprise && <span>⚡</span>}
                          {player.name}
                        </span>
                        <span style={{ 
                          fontWeight: '700', 
                          fontSize: '1.05rem',
                          color: style.text,
                          fontFamily: 'system-ui'
                        }}>
                          {expected >= 0 ? '+' : ''}₪{expected}
                        </span>
                      </div>
                      
                      {/* Sentence - with data reference */}
                      <div style={{ 
                        fontSize: '0.85rem', 
                        color: 'var(--text-muted)',
                        lineHeight: '1.5',
                        direction: 'rtl'
                      }}>
                        {sentence}
                      </div>
                      
                      {/* Recent form badge */}
                      {gamesPlayed > 0 && recent?.streakText && (
                        <div style={{ 
                          fontSize: '0.75rem', 
                          color: recent.trend === 'hot' ? '#22c55e' : recent.trend === 'cold' ? '#ef4444' : 'var(--text-muted)', 
                          marginTop: '0.35rem',
                          fontWeight: '600',
                          direction: 'rtl'
                        }}>
                          {recent.streakText}
                        </div>
                      )}
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
                Poker Manager 🎲 • 60% משחקים אחרונים + 40% היסטוריה
              </div>
            </div>

            {/* Action buttons - outside screenshot */}
            <div className="actions" style={{ marginTop: '1rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border)' }}>
              <button 
                className="btn btn-secondary" 
                onClick={() => { setShowForecast(false); setCachedForecasts(null); }}
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
          </div>
        </div>
      )}
    </div>
  );
};

export default NewGameScreen;