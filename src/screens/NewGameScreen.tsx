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

  // ============ PROFESSIONAL FORECAST SYSTEM ============
  
  // Sentence templates organized by category - each player gets a truly unique sentence
  // Templates use {name} and stats placeholders: {avgProfit}, {winPercent}, {gamesPlayed}, {totalProfit}
  
  interface ForecastTemplate {
    text: string;
    minGames?: number; // Minimum games required for this template
  }

  // NEW PLAYERS - First time playing, no historical data
  const newPlayerTemplates: ForecastTemplate[] = [
    { text: `{name} נכנס בפעם הראשונה - הכל פתוח!` },
    { text: `שחקן חדש על השולחן: {name}. מה יהיה?` },
    { text: `{name} פותח את הדרך שלו הלילה` },
    { text: `טריק חדש? {name} מצטרף למשחק` },
    { text: `{name} - דף חלק, סיפור חדש` },
    { text: `ברוכים הבאים {name}! נראה מה יש לך` },
    { text: `{name} בהופעת בכורה` },
    { text: `פרצוף חדש: {name} מתחיל מאפס` },
  ];

  // STRONG WINNERS - Very positive history, expected to win big
  const strongWinnerTemplates: ForecastTemplate[] = [
    { text: `{name} בא לנצח. ממוצע {avgProfit}₪ לא משקר`, minGames: 3 },
    { text: `{name} - {winPercent}% נצחונות. הבאנק רועד`, minGames: 5 },
    { text: `{name} כבר הרוויח {totalProfit}₪ כולל. עוד הלילה?`, minGames: 5 },
    { text: `הכסף אוהב את {name}. ממוצע +{avgProfit}₪`, minGames: 3 },
    { text: `{name} ב-{gamesPlayed} משחקים הוכיח: הוא מנצח`, minGames: 5 },
    { text: `{name} עם אחוזי נצחון של {winPercent}% - סיכויים טובים`, minGames: 3 },
    { text: `{name} המועדף הלילה`, minGames: 2 },
    { text: `רצף של הצלחות: {name} ממשיך`, minGames: 3 },
  ];

  // MODERATE WINNERS - Positive history, expected small profit
  const moderateWinnerTemplates: ForecastTemplate[] = [
    { text: `{name} בכיוון טוב עם ממוצע {avgProfit}₪`, minGames: 2 },
    { text: `{name} - {winPercent}% הצלחה, צפוי לפלוס`, minGames: 3 },
    { text: `{name} נראה מבטיח הלילה`, minGames: 1 },
    { text: `{name} עם סיכוי טוב לרווח`, minGames: 2 },
    { text: `{name} בדרך כלל מסיים חיובי`, minGames: 3 },
    { text: `{name} צפוי לערב נעים`, minGames: 2 },
    { text: `{name} - ההיסטוריה לטובתו`, minGames: 3 },
    { text: `{name} עם ממוצע חיובי של {avgProfit}₪`, minGames: 2 },
  ];

  // NEUTRAL - Could go either way
  const neutralTemplates: ForecastTemplate[] = [
    { text: `{name} - יכול ללכת לכל כיוון`, minGames: 1 },
    { text: `{name} על הגדר הלילה`, minGames: 2 },
    { text: `{name} עם סיכויים שווים`, minGames: 2 },
    { text: `{name} - 50/50`, minGames: 1 },
    { text: `{name} בתחום הניטרלי`, minGames: 2 },
    { text: `{name} יכול להפתיע לכל כיוון`, minGames: 1 },
    { text: `{name} - ממוצע קרוב לאפס`, minGames: 3 },
    { text: `{name} בערפל - נראה מה יהיה`, minGames: 1 },
  ];

  // MODERATE LOSERS - Negative history, expected small loss
  const moderateLoserTemplates: ForecastTemplate[] = [
    { text: `{name} עם ממוצע {avgProfit}₪ - לא מזהיר`, minGames: 2 },
    { text: `{name} - {winPercent}% הצלחה לא מספיק`, minGames: 3 },
    { text: `{name} צפוי ללילה מאתגר`, minGames: 2 },
    { text: `{name} - ההיסטוריה לא לטובתו`, minGames: 3 },
    { text: `{name} בכיוון הפחות טוב`, minGames: 2 },
    { text: `{name} יצטרך מזל הלילה`, minGames: 2 },
    { text: `{name} עם מגמה שלילית`, minGames: 3 },
    { text: `{name} - הנתונים לא משקרים`, minGames: 2 },
  ];

  // STRONG LOSERS - Very negative history, expected to lose
  const strongLoserTemplates: ForecastTemplate[] = [
    { text: `{name} עם ממוצע {avgProfit}₪. קשה`, minGames: 3 },
    { text: `{name} הפסיד {totalProfit}₪ עד היום`, minGames: 5 },
    { text: `{name} - {winPercent}% הצלחה בלבד`, minGames: 5 },
    { text: `{name} צפוי לתרום לקופה`, minGames: 3 },
    { text: `{name} ב-{gamesPlayed} משחקים לא מצא את הקצב`, minGames: 5 },
    { text: `{name} - הסטטיסטיקה לא חברה שלו`, minGames: 3 },
    { text: `{name} יצטרך נס`, minGames: 2 },
    { text: `{name} עם היסטוריה לא קלה`, minGames: 3 },
  ];

  // SURPRISE TEMPLATES - When prediction goes AGAINST history
  const surpriseWinTemplates: ForecastTemplate[] = [
    { text: `הפתעה! {name} בדרך כלל מפסיד, אבל הלילה יש תחושה אחרת`, minGames: 3 },
    { text: `{name} נגד הסטטיסטיקה - הלילה יכול להפוך`, minGames: 3 },
    { text: `{name} שובר את התבנית?`, minGames: 2 },
    { text: `{name} - אולי זה הלילה של המפנה`, minGames: 3 },
    { text: `{name} מוכן להפתיע`, minGames: 2 },
  ];

  const surpriseLossTemplates: ForecastTemplate[] = [
    { text: `{name} בדרך כלל מנצח, אבל הלילה נראה אחרת`, minGames: 3 },
    { text: `{name} - גם אלופים נופלים לפעמים`, minGames: 3 },
    { text: `{name} עלול להיתקע הלילה`, minGames: 2 },
    { text: `{name} - המזל עשוי להתהפך`, minGames: 3 },
    { text: `{name} בזהירות הלילה`, minGames: 2 },
  ];

  // Get appropriate template for player
  const getTemplate = (
    pool: ForecastTemplate[], 
    usedTemplates: Set<string>, 
    gamesPlayed: number
  ): string => {
    // Filter by minimum games required
    const eligible = pool.filter(t => (t.minGames || 0) <= gamesPlayed);
    // Filter out already used templates
    const available = eligible.filter(t => !usedTemplates.has(t.text));
    // Use eligible if no available (all used)
    const finalPool = available.length > 0 ? available : eligible.length > 0 ? eligible : pool;
    return finalPool[Math.floor(Math.random() * finalPool.length)].text;
  };

  // Fill template with actual values
  const fillTemplate = (template: string, name: string, stats?: PlayerStats): string => {
    let result = template.replace(/{name}/g, name);
    if (stats) {
      result = result
        .replace(/{avgProfit}/g, String(Math.round(Math.abs(stats.avgProfit))))
        .replace(/{winPercent}/g, String(Math.round(stats.winPercentage)))
        .replace(/{gamesPlayed}/g, String(stats.gamesPlayed))
        .replace(/{totalProfit}/g, String(Math.round(Math.abs(stats.totalProfit))));
    }
    return result;
  };

  // Generate forecasts for all selected players (balanced zero-sum)
  const generateForecasts = () => {
    const usedTemplates = new Set<string>();
    const MAX_SURPRISE_RATIO = 0.35; // Up to 35% can be surprises (not forced!)
    
    // Step 1: Analyze all players
    const playerAnalysis = Array.from(selectedIds).map(playerId => {
      const player = players.find(p => p.id === playerId);
      if (!player) return null;
      
      const stats = getStatsForPlayer(playerId);
      const gamesPlayed = stats?.gamesPlayed || 0;
      const avgProfit = stats?.avgProfit || 0;
      
      // Determine historical tendency
      let tendency: 'strong_winner' | 'moderate_winner' | 'neutral' | 'moderate_loser' | 'strong_loser' | 'new' = 'new';
      if (gamesPlayed === 0) {
        tendency = 'new';
      } else if (avgProfit > 25) {
        tendency = 'strong_winner';
      } else if (avgProfit > 8) {
        tendency = 'moderate_winner';
      } else if (avgProfit >= -8) {
        tendency = 'neutral';
      } else if (avgProfit >= -25) {
        tendency = 'moderate_loser';
      } else {
        tendency = 'strong_loser';
      }
      
      return {
        player,
        stats,
        gamesPlayed,
        avgProfit,
        tendency,
        rawExpected: gamesPlayed > 0 ? avgProfit : 0
      };
    }).filter(Boolean) as {
      player: Player;
      stats: PlayerStats | undefined;
      gamesPlayed: number;
      avgProfit: number;
      tendency: 'strong_winner' | 'moderate_winner' | 'neutral' | 'moderate_loser' | 'strong_loser' | 'new';
      rawExpected: number;
    }[];

    // Step 2: Decide which players get surprises (UP TO max ratio, not forced)
    const eligibleForSurprise = playerAnalysis.filter(p => 
      p.tendency === 'strong_winner' || 
      p.tendency === 'strong_loser' ||
      p.tendency === 'moderate_winner' ||
      p.tendency === 'moderate_loser'
    );
    
    const maxSurprises = Math.floor(playerAnalysis.length * MAX_SURPRISE_RATIO);
    const actualSurprises = Math.min(
      Math.floor(Math.random() * (maxSurprises + 1)), // 0 to maxSurprises (inclusive)
      eligibleForSurprise.length
    );
    
    // Randomly select which players get surprised
    const surprisePlayerIds = new Set<string>();
    const shuffled = [...eligibleForSurprise].sort(() => Math.random() - 0.5);
    shuffled.slice(0, actualSurprises).forEach(p => surprisePlayerIds.add(p.player.id));

    // Step 3: Calculate expected values with surprises applied
    const withExpected = playerAnalysis.map(p => {
      const isSurprise = surprisePlayerIds.has(p.player.id);
      let expectedValue = p.rawExpected;
      
      if (isSurprise) {
        // Flip the expected value with some randomness
        const flipFactor = 0.6 + Math.random() * 0.4; // 60-100% flip
        expectedValue = -expectedValue * flipFactor;
      } else {
        // Add some variance to non-surprise predictions
        const variance = (Math.random() - 0.5) * 15;
        expectedValue = expectedValue + variance;
      }
      
      // Apply streak adjustments (mild)
      if (p.stats && p.stats.currentStreak >= 2) expectedValue *= 1.1;
      if (p.stats && p.stats.currentStreak <= -2) expectedValue *= 0.9;
      
      return { ...p, expectedValue: Math.round(expectedValue), isSurprise };
    });

    // Step 4: Balance to zero-sum
    const totalExpected = withExpected.reduce((sum, p) => sum + p.expectedValue, 0);
    const totalWeight = withExpected.reduce((sum, p) => sum + Math.abs(p.expectedValue) + 10, 0);
    
    const balanced = withExpected.map(p => {
      const weight = (Math.abs(p.expectedValue) + 10) / totalWeight;
      const adjustment = -totalExpected * weight;
      const balancedExpected = Math.round(p.expectedValue + adjustment);
      
      // Pick appropriate template
      let template: string;
      let category: 'new' | 'winner' | 'loser' | 'neutral' | 'surprise';
      
      if (p.gamesPlayed === 0) {
        template = getTemplate(newPlayerTemplates, usedTemplates, 0);
        category = 'new';
      } else if (p.isSurprise) {
        // Surprise: use opposite templates
        if (balancedExpected > 0 && (p.tendency === 'moderate_loser' || p.tendency === 'strong_loser')) {
          template = getTemplate(surpriseWinTemplates, usedTemplates, p.gamesPlayed);
        } else if (balancedExpected < 0 && (p.tendency === 'moderate_winner' || p.tendency === 'strong_winner')) {
          template = getTemplate(surpriseLossTemplates, usedTemplates, p.gamesPlayed);
        } else {
          // Fallback
          template = balancedExpected > 0 
            ? getTemplate(moderateWinnerTemplates, usedTemplates, p.gamesPlayed)
            : getTemplate(moderateLoserTemplates, usedTemplates, p.gamesPlayed);
        }
        category = 'surprise';
      } else {
        // Regular prediction based on balanced expected value
        if (balancedExpected > 30) {
          template = getTemplate(strongWinnerTemplates, usedTemplates, p.gamesPlayed);
          category = 'winner';
        } else if (balancedExpected > 10) {
          template = getTemplate(moderateWinnerTemplates, usedTemplates, p.gamesPlayed);
          category = 'winner';
        } else if (balancedExpected >= -10) {
          template = getTemplate(neutralTemplates, usedTemplates, p.gamesPlayed);
          category = 'neutral';
        } else if (balancedExpected >= -30) {
          template = getTemplate(moderateLoserTemplates, usedTemplates, p.gamesPlayed);
          category = 'loser';
        } else {
          template = getTemplate(strongLoserTemplates, usedTemplates, p.gamesPlayed);
          category = 'loser';
        }
      }
      
      usedTemplates.add(template);
      const sentence = fillTemplate(template, p.player.name, p.stats);
      
      return {
        player: p.player,
        expected: balancedExpected,
        sentence,
        gamesPlayed: p.gamesPlayed,
        isSurprise: p.isSurprise,
        category
      };
    });

    // Sort by expected profit (winners first)
    return balanced.sort((a, b) => b.expected - a.expected);
  };

  // Share forecast as screenshot to WhatsApp
  const shareForecast = async () => {
    if (!forecastRef.current || isSharing) return;
    
    setIsSharing(true);
    
    try {
      // Capture the forecast section as an image
      const canvas = await html2canvas(forecastRef.current, {
        backgroundColor: '#1a1a2e',
        scale: 2, // Higher quality
        useCORS: true,
        logging: false,
      });
      
      // Convert to blob
      const blob = await new Promise<Blob>((resolve) => {
        canvas.toBlob((b) => resolve(b!), 'image/png', 1.0);
      });
      
      const file = new File([blob], 'poker-forecast.png', { type: 'image/png' });
      
      // Try native share first (works on mobile)
      if (navigator.share && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: 'תחזית פוקר',
        });
      } else {
        // Fallback: download the image and open WhatsApp
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'poker-forecast.png';
        a.click();
        URL.revokeObjectURL(url);
        
        // Then open WhatsApp
        const today = new Date().toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'short' });
        const text = `🔮 תחזית פוקר - ${today}\n\n(התמונה הורדה - צרף אותה להודעה)`;
        window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
      }
    } catch (error) {
      console.error('Error sharing forecast:', error);
      alert('לא הצלחנו לשתף. נסה שוב.');
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
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxHeight: '85vh', overflow: 'auto', maxWidth: '400px' }}>
            {/* Screenshotable content */}
            <div ref={forecastRef} style={{ padding: '1rem', background: '#1a1a2e', borderRadius: '12px' }}>
              {/* Header */}
              <div style={{ textAlign: 'center', marginBottom: '1rem' }}>
                <div style={{ fontSize: '1.5rem', marginBottom: '0.25rem' }}>🔮</div>
                <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: '700', color: 'var(--text)' }}>
                  תחזית הלילה
                </h3>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                  {new Date().toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' })}
                </div>
              </div>

              {/* Player forecasts */}
              <div style={{ marginBottom: '0.75rem' }}>
                {cachedForecasts.map((forecast, index) => {
                  const { player, expected, sentence, gamesPlayed, isSurprise, category } = forecast;
                  
                  // Clean, simple color scheme
                  const getRowStyle = () => {
                    if (isSurprise) return { bg: 'rgba(168, 85, 247, 0.12)', border: '#a855f7' }; // Purple
                    if (expected > 15) return { bg: 'rgba(34, 197, 94, 0.12)', border: '#22c55e' }; // Green
                    if (expected < -15) return { bg: 'rgba(239, 68, 68, 0.12)', border: '#ef4444' }; // Red
                    return { bg: 'rgba(100, 116, 139, 0.12)', border: '#64748b' }; // Gray
                  };
                  
                  const style = getRowStyle();
                  
                  return (
                    <div 
                      key={player.id}
                      style={{
                        padding: '0.65rem 0.75rem',
                        marginBottom: '0.4rem',
                        borderRadius: '8px',
                        background: style.bg,
                        borderRight: `3px solid ${style.border}`,
                      }}
                    >
                      {/* Name and amount row */}
                      <div style={{ 
                        display: 'flex', 
                        justifyContent: 'space-between', 
                        alignItems: 'center',
                        marginBottom: '0.3rem'
                      }}>
                        <span style={{ 
                          fontWeight: '600', 
                          fontSize: '0.95rem',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.3rem'
                        }}>
                          {index === 0 && expected > 0 && <span>👑</span>}
                          {isSurprise && <span style={{ fontSize: '0.75rem' }}>⚡</span>}
                          {player.name}
                        </span>
                        <span style={{ 
                          fontWeight: '700', 
                          fontSize: '0.95rem',
                          color: expected > 0 ? '#22c55e' : expected < 0 ? '#ef4444' : 'var(--text)',
                          fontFamily: 'monospace'
                        }}>
                          {expected >= 0 ? '+' : ''}₪{expected}
                        </span>
                      </div>
                      
                      {/* Sentence */}
                      <div style={{ 
                        fontSize: '0.8rem', 
                        color: 'var(--text-muted)',
                        lineHeight: '1.4'
                      }}>
                        {sentence}
                      </div>
                      
                      {/* Games count - subtle */}
                      {gamesPlayed > 0 && (
                        <div style={{ 
                          fontSize: '0.65rem', 
                          color: 'var(--text-muted)', 
                          marginTop: '0.2rem',
                          opacity: 0.6 
                        }}>
                          {gamesPlayed} משחקים
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Legend - simple and clear */}
              <div style={{ 
                display: 'flex', 
                justifyContent: 'center',
                gap: '1rem',
                fontSize: '0.65rem',
                color: 'var(--text-muted)',
                paddingTop: '0.5rem',
                borderTop: '1px solid var(--border)'
              }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '2px', background: '#22c55e' }}></span>
                  רווח
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '2px', background: '#ef4444' }}></span>
                  הפסד
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '2px', background: '#a855f7' }}></span>
                  ⚡ הפתעה
                </span>
              </div>

              {/* Footer */}
              <div style={{ 
                textAlign: 'center', 
                marginTop: '0.75rem', 
                fontSize: '0.6rem', 
                color: 'var(--text-muted)',
                opacity: 0.5
              }}>
                Poker Manager 🎲 • מבוסס על נתונים היסטוריים
              </div>
            </div>

            {/* Action buttons - outside screenshot area */}
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
                {isSharing ? '📸 מצלם...' : '📤 שתף'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default NewGameScreen;
