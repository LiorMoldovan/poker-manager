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

  // ============ ENGAGING FORECAST SENTENCES ============
  
  // NEW PLAYERS - Mystery, intrigue, fun
  const newPlayerSentences = [
    `מי זה בכלל {name}? בלי היסטוריה, הוא יכול להיות הכל - גאון או טרגדיה`,
    `{name} נכנס כמו סוס אפל. אין לנו מושג מה הוא מסתיר`,
    `פרק ראשון בסאגה של {name}. מתרגשים לראות איך הוא מתמודד עם לחץ`,
    `{name} עדיין לא הספיק לבנות אויבים על השולחן. הלילה זה ישתנה`,
    `הכל חדש ל{name} - הריח של הצ'יפים, הטעם של בלאף כושל. או אולי של ניצחון?`,
    `{name} מגיע בלי תיק עבר. לפעמים זה בדיוק מה שצריך כדי להפתיע`,
    `דף חלק, קלפים חדשים: {name} מתחיל מאפס. כולם שווים בהתחלה`,
    `אין לנו נתונים על {name}, אז נסמוך על אינטואיציה. יש משהו באוויר...`,
  ];

  // SURPRISE WIN - The underdog rises
  const surpriseWinSentences = [
    `תשכחו מה{avgProfit}₪- שהוא הפסיד בממוצע. {name} מגיע עם עיניים רעבות הלילה`,
    `{name} השאיר {totalProfit}₪ על השולחנות. הלילה הוא מתכנן לקחת משהו בחזרה`,
    `נגד {lossPercent}% הפסדים, נגד הסיכויים - {name} מריח הזדמנות`,
    `{name} נמאס לו להיות פרייר. הלילה יש אנרגיה של קאמבק באוויר`,
    `{name} עם {gamesPlayed} משחקים של לימוד. אולי סוף סוף ישתלם?`,
    `הסטטיסטיקה נגדו, אבל {name} מגיע עם חיוך מסוכן הלילה`,
  ];

  // SURPRISE LOSS - The mighty may fall
  const surpriseLossSentences = [
    `{name} התרגל ל{winPercent}% נצחונות. אבל ביטחון יתר הוא אויב מסוכן`,
    `+{avgProfit}₪ ממוצע? מרשים. אבל יש תחושה ש{name} הולך לאכול אותה הלילה`,
    `{name} חושב שהוא המלך. הקלפים עשויים להזכיר לו מי באמת שולט`,
    `אזהרה ל{name}: {totalProfit}₪ רווח לא מגן עליך הלילה`,
    `{name} בא עם הביטחון של מנצח. לפעמים זו בדיוק הנפילה`,
    `הכוכבים לא לצד {name} הערב. משהו עומד לקרות`,
  ];

  // BIG WINNERS - Respect mixed with fear
  const bigWinnerSentences = [
    `{name} לקח {totalProfit}₪ מכולנו. השאלה היחידה: כמה עוד הלילה?`,
    `{winPercent}% נצחונות? {name} לא משחק פוקר - הוא גובה מיסים`,
    `ב-{gamesPlayed} משחקים {name} הוכיח: הוא יודע משהו שאחרים לא`,
    `{name} מרוויח {avgProfit}₪ בממוצע. עכשיו חשבו כמה זה יעלה לכם הלילה`,
    `{name} הוא הסיבה שחלק מכם חוזרים הביתה בלי כסף לפיצה`,
    `יש שחקנים, ויש {name}. הפער? {totalProfit}₪`,
    `אם {name} היה מניה, כולם היו קונים. {avgProfit}₪ ממוצע לא משקר`,
    `{name} קורא אתכם כמו ספר פתוח. {winPercent}% הצלחה - לא מקרי`,
  ];

  // GOOD WINNERS - Solid performers
  const goodWinnerSentences = [
    `{name} לא הכי רעשני, אבל +{avgProfit}₪ ממוצע אומר שהוא יודע את העבודה`,
    `{name} משחק שקט ולוקח כסף. {winPercent}% הצלחה מדברים`,
    `הכסף אוהב את {name}. לא רומן סוער, אבל יחסים יציבים`,
    `{name} לא יגנוב כותרות, אבל כנראה יגנוב מהכסף שלכם`,
    `ב-{gamesPlayed} משחקים {name} בנה רפוטציה של שחקן רווחי. זה לא ישתנה`,
    `{name} מהסוג שמדבר בשקט ויוצא עם הכסף`,
    `{name} יודע שפוקר זה מרתון. אחרי {gamesPlayed} משחקים - הוא מוביל`,
    `+{avgProfit}₪ ממוצע אומר הכל על {name}. צפו לעוד ערב רווחי בשבילו`,
  ];

  // SLIGHT WINNERS - Small edge
  const slightWinnerSentences = [
    `{name} עם יתרון קל. לא מרשים, אבל כסף זה כסף`,
    `{avgProfit}₪ ממוצע - {name} לא יהיה עשיר, אבל גם לא עני`,
    `{name} בדרך כלל יוצא עם קצת יותר ממה שהביא. צפוי להמשיך`,
    `{winPercent}% הצלחה נותנים ל{name} סיכוי קל. נראה`,
    `{name} בירוק קל - לא פסטיבל, אבל חיובי`,
    `{name} צפוי לערב סביר. לא עושר, לא עוני`,
    `יתרון סטטיסטי קטן ל{name}. מספיק לשמור על חיוך`,
    `{name} - לא הכי טוב, לא הכי גרוע. באמצע עם נטייה לטוב`,
  ];

  // NEUTRAL - Wild cards
  const neutralSentences = [
    `{name} הוא הג'וקר הלילה. יכול לקחת הכל או להפסיד הכל`,
    `אם היו שואלים את {name} מה יקרה, גם הוא לא היה יודע`,
    `{name} על קו האפס. הערב יחליט לאן`,
    `{name} הוא חידה: לא מספיק טוב לפחד ממנו, לא מספיק גרוע לזלזל`,
    `50-50 ל{name}. השאלה באיזה צד הוא ינחת`,
    `ההיסטוריה של {name} לא עוזרת. הלילה זה משחק חדש`,
    `{name} יכול להפתיע לכל כיוון. זה מה שמעניין בו`,
    `{name} - תעלומה. הנתונים לא מספרים כלום`,
  ];

  // SLIGHT LOSERS - Struggling
  const slightLoserSentences = [
    `{name} עם נטייה קלה למינוס. לא דרמטי, אבל בואו נודה - כואב`,
    `{avgProfit}₪ ממוצע לא משקר. {name} יצטרך מזל`,
    `{name} בדרך כלל יוצא עם קצת פחות. הלילה כנראה אותו דבר`,
    `{lossPercent}% הפסדים. {name} עדיין מחפש את הנוסחה`,
    `{name} לא בדיוק כוכב פוקר. אבל הוא ממשיך לנסות`,
    `רוח קלה נגד {name}. צריך לעבוד קשה כדי להפוך`,
    `{name} מעט מתחת לאפס. לא אסון, אבל גם לא מסיבה`,
    `{name} עם הפסד קטן צפוי. כבר ראינו את הסרט הזה`,
  ];

  // MODERATE LOSERS - Clear pattern
  const moderateLoserSentences = [
    `{name} משלם שכר לימוד יקר - {totalProfit}₪ עד היום. השאלה אם הוא לומד`,
    `{avgProfit}₪ ממוצע? {name} צריך להתחיל לדאוג`,
    `{lossPercent}% הפסדים. {name} או אופטימי מדי או עיקש מדי`,
    `ב-{gamesPlayed} משחקים {name} ראה יותר הפסדים מנצחונות. הלילה לא ישנה`,
    `{name} יודע שהוא מתחיל מאחור. השאלה אם הוא יודע למה`,
    `האמת כואבת: {name} לא בדיוק מומחה פוקר`,
    `{name} - הארנק שלו פתוח והכסף זורם החוצה`,
    `{name} מביא למשחק יותר תקווה מאשר כישרון. הנתונים ברורים`,
  ];

  // BIG LOSERS - The sponsors
  const bigLoserSentences = [
    `{name} השאיר {totalProfit}₪ על השולחנות. הספונסר הלא רשמי שלנו`,
    `רק {winPercent}% נצחונות? {name} או הכי אופטימי בעולם או לא מבין רמז`,
    `{name} תורם למשחק כל ערב. תודה על {totalProfit}₪ חבר`,
    `{avgProfit}₪ ממוצע. {name} כנראה אוהב את החברה יותר מאשר לנצח`,
    `ב-{gamesPlayed} משחקים {name} הוכיח עקביות מרשימה - בהפסדים`,
    `כולם שמחים כש{name} מגיע. בעיקר הארנקים של כולם`,
    `אם {name} היה מניה - הייתם מוכרים מזמן. {avgProfit}₪ ממוצע`,
    `{name} ההוכחה שאופטימיות לא משלמת חשבונות. {totalProfit}₪ בהפסדים`,
  ];

  // Helper to fill in template with stats
  const fillTemplate = (template: string, name: string, stats: PlayerStats): string => {
    return template
      .replace(/{name}/g, name)
      .replace(/{avgProfit}/g, String(Math.round(stats.avgProfit)))
      .replace(/{winPercent}/g, String(Math.round(stats.winPercentage)))
      .replace(/{lossPercent}/g, String(Math.round(100 - stats.winPercentage)))
      .replace(/{gamesPlayed}/g, String(stats.gamesPlayed))
      .replace(/{totalProfit}/g, String(Math.round(stats.totalProfit)))
      .replace(/{streak}/g, String(Math.abs(stats.currentStreak)));
  };

  // Pick random sentence from pool, avoiding already used ones
  const pickUniqueSentence = (pool: string[], usedSentences: Set<string>, name: string, stats?: PlayerStats): string => {
    const availablePool = pool.filter(s => !usedSentences.has(s));
    const selectedPool = availablePool.length > 0 ? availablePool : pool;
    const template = selectedPool[Math.floor(Math.random() * selectedPool.length)];
    
    if (stats) {
      return fillTemplate(template, name, stats);
    }
    return template.replace(/{name}/g, name);
  };

  // Generate forecasts for all selected players (balanced to sum to zero)
  const generateForecasts = () => {
    const usedSentences = new Set<string>();
    
    // Step 1: Analyze all players
    const playerAnalysis = Array.from(selectedIds).map(playerId => {
      const player = players.find(p => p.id === playerId);
      if (!player) return null;
      
      const stats = getStatsForPlayer(playerId);
      const gamesPlayed = stats?.gamesPlayed || 0;
      const avgProfit = stats?.avgProfit || 0;
      
      // Determine historical tendency
      let tendency: 'strong_winner' | 'winner' | 'neutral' | 'loser' | 'strong_loser' | 'new' = 'new';
      if (gamesPlayed === 0) {
        tendency = 'new';
      } else if (avgProfit > 20) {
        tendency = 'strong_winner';
      } else if (avgProfit > 5) {
        tendency = 'winner';
      } else if (avgProfit >= -5) {
        tendency = 'neutral';
      } else if (avgProfit >= -20) {
        tendency = 'loser';
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
      tendency: 'strong_winner' | 'winner' | 'neutral' | 'loser' | 'strong_loser' | 'new';
      rawExpected: number;
    }[];

    // Step 2: Smart surprise selection - UP TO 30% (not forced!)
    // Only apply to players with strong historical patterns
    const eligibleForSurprise = playerAnalysis.filter(p => 
      p.gamesPlayed >= 5 && (p.tendency === 'strong_winner' || p.tendency === 'strong_loser')
    );
    
    const maxSurprises = Math.min(
      Math.ceil(playerAnalysis.length * 0.30), // Max 30%
      eligibleForSurprise.length
    );
    
    // Random number of surprises (0 to max)
    const numSurprises = Math.floor(Math.random() * (maxSurprises + 1));
    
    // Randomly pick which players get surprised
    const surprisePlayerIds = new Set<string>();
    const shuffled = [...eligibleForSurprise].sort(() => Math.random() - 0.5);
    shuffled.slice(0, numSurprises).forEach(p => surprisePlayerIds.add(p.player.id));

    // Step 3: Calculate expected values
    const withExpected = playerAnalysis.map(p => {
      const isSurprise = surprisePlayerIds.has(p.player.id);
      let expectedValue = p.rawExpected;
      
      if (isSurprise) {
        // Flip the expected value
        expectedValue = -expectedValue * (0.6 + Math.random() * 0.4);
      } else {
        // Add some variance
        expectedValue = expectedValue + (Math.random() - 0.5) * 15;
        
        // Streak adjustments
        if (p.stats && p.stats.currentStreak >= 2) expectedValue *= 1.15;
        if (p.stats && p.stats.currentStreak <= -2) expectedValue *= 0.85;
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
      
      // Pick sentence based on category
      let sentence: string;
      
      if (f.gamesPlayed === 0) {
        sentence = pickUniqueSentence(newPlayerSentences, usedSentences, f.player.name);
      } else if (f.isSurprise) {
        if (f.tendency === 'strong_loser' || f.tendency === 'loser') {
          sentence = pickUniqueSentence(surpriseWinSentences, usedSentences, f.player.name, f.stats);
        } else {
          sentence = pickUniqueSentence(surpriseLossSentences, usedSentences, f.player.name, f.stats);
        }
      } else {
        let pool: string[];
        if (balancedExpected > 35) pool = bigWinnerSentences;
        else if (balancedExpected > 15) pool = goodWinnerSentences;
        else if (balancedExpected > 3) pool = slightWinnerSentences;
        else if (balancedExpected >= -3) pool = neutralSentences;
        else if (balancedExpected >= -15) pool = slightLoserSentences;
        else if (balancedExpected >= -35) pool = moderateLoserSentences;
        else pool = bigLoserSentences;
        
        sentence = pickUniqueSentence(pool, usedSentences, f.player.name, f.stats);
      }
      
      usedSentences.add(sentence);
      
      return {
        player: f.player,
        expected: balancedExpected,
        sentence,
        gamesPlayed: f.gamesPlayed,
        isSurprise: f.isSurprise
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
                  const { player, expected, sentence, gamesPlayed, isSurprise } = forecast;
                  
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
                      
                      {/* Sentence */}
                      <div style={{ 
                        fontSize: '0.85rem', 
                        color: 'var(--text-muted)',
                        lineHeight: '1.5',
                        direction: 'rtl'
                      }}>
                        {sentence}
                      </div>
                      
                      {/* Games count */}
                      {gamesPlayed > 0 && (
                        <div style={{ 
                          fontSize: '0.7rem', 
                          color: 'var(--text-muted)', 
                          marginTop: '0.3rem',
                          opacity: 0.6,
                          direction: 'rtl'
                        }}>
                          {gamesPlayed} משחקים בהיסטוריה
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
                Poker Manager 🎲 • מבוסס על היסטוריה + קצת מזל
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