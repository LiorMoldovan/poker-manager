import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Player, PlayerStats } from '../types';
import { getAllPlayers, addPlayer, createGame, getPlayerByName, getPlayerStats } from '../database/storage';

const NewGameScreen = () => {
  const navigate = useNavigate();
  const [players, setPlayers] = useState<Player[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showAddPlayer, setShowAddPlayer] = useState(false);
  const [newPlayerName, setNewPlayerName] = useState('');
  const [newPlayerType, setNewPlayerType] = useState<'permanent' | 'guest'>('guest');
  const [error, setError] = useState('');
  const [showGuests, setShowGuests] = useState(false);
  const [showForecast, setShowForecast] = useState(false);
  const [playerStats, setPlayerStats] = useState<PlayerStats[]>([]);

  useEffect(() => {
    loadPlayers();
  }, []);

  const loadPlayers = () => {
    setPlayers(getAllPlayers());
    setPlayerStats(getPlayerStats());
  };

  // Separate permanent and guest players
  const permanentPlayers = players.filter(p => p.type === 'permanent');
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

  const selectAll = () => {
    if (selectedIds.size === players.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(players.map(p => p.id)));
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
    // If adding a guest, expand the guests section
    if (newPlayerType === 'guest') {
      setShowGuests(true);
    }
  };

  const handleStartGame = () => {
    if (selectedIds.size < 2) {
      setError('Select at least 2 players');
      return;
    }
    
    const game = createGame(Array.from(selectedIds));
    navigate(`/live-game/${game.id}`);
  };

  // Get stats for a player
  const getStatsForPlayer = (playerId: string): PlayerStats | undefined => {
    return playerStats.find(s => s.playerId === playerId);
  };

  // Generate funny sentence based on player stats (Hebrew) - with variety and surprises!
  const generateFunnySentence = (stats: PlayerStats | undefined, player: Player): string => {
    const random = Math.random();
    
    if (!stats || stats.gamesPlayed === 0) {
      const newPlayerSentences = [
        "🆕 בשר טרי לשולחן!",
        "🎲 מזל מתחילים בדרך?",
        "👀 החידה המסתורית...",
        "🤔 בלי היסטוריה, בלי רחמים!",
        "🌟 כוכב עולה או נופל?",
        "🎭 הפנים החדשות - מסוכן או קל?",
        "🔮 הכדור הבדולח לא עובד עליו",
        "❓ סימן שאלה גדול",
        "🎪 הפתעה בדרך?",
        "🐣 טירון בזירה",
        "🎯 מטרה קלה או מלכודת?",
        "🌊 גל חדש מתקרב",
      ];
      return newPlayerSentences[Math.floor(Math.random() * newPlayerSentences.length)];
    }

    const { avgProfit, currentStreak, winPercentage, biggestWin, biggestLoss, gamesPlayed } = stats;
    
    // 15% chance for a SURPRISE prediction that goes against the data
    if (random < 0.15) {
      if (avgProfit > 30) {
        // Predict bad night for a usually good player
        const surpriseDownSentences = [
          "🔄 משהו אומר לי שהלילה יהיה שונה...",
          "⚠️ יש תחושה שהמזל עומד להסתובב",
          "🌙 גם לאלופים יש לילות קשים",
          "💫 הכוכבים מסמנים הפתעה הלילה",
          "🎲 הסטטיסטיקה לא תמיד צודקת...",
          "🔮 חזון: לילה מאתגר בדרך",
          "⬇️ בניגוד להיסטוריה - הרגשה שהיום קשה",
          "🌪️ סערה בדרך לאלוף?",
        ];
        return surpriseDownSentences[Math.floor(Math.random() * surpriseDownSentences.length)];
      } else if (avgProfit < -30) {
        // Predict good night for a usually bad player
        const surpriseUpSentences = [
          "✨ הלילה הכל משתנה!",
          "🌈 סוף סוף הלילה של הקאמבק הגדול",
          "🚀 משהו באוויר אומר: הלילה שלו!",
          "🔥 בניגוד לכל הסיכויים - מרגיש ניצחון",
          "💎 היהלום המוסתר יתגלה הלילה",
          "⭐ הלילה הוא יפתיע את כולם",
          "🎰 המכונה עומדת לפלוט ג'קפוט",
          "🦋 הזחל יהפוך לפרפר הלילה",
        ];
        return surpriseUpSentences[Math.floor(Math.random() * surpriseUpSentences.length)];
      }
    }

    // Big winner (avg profit > 50)
    if (avgProfit > 50) {
      const winnerSentences = [
        "🔥 הסיוט של השולחן",
        "💰 אספן ז'יטונים מקצועי",
        "👑 תשתחוו בפני המלך",
        "🎯 מגנט כסף מופעל",
        "🦈 התראת כריש! תחביאו את הז'יטונים!",
        "💵 הבנקאי של הערב",
        "🏆 פשוט ברמה אחרת",
        "🎖️ ותיק מנוסה ומסוכן",
        "📈 גרף שרק עולה",
        "🌟 כוכב על בפוקר",
        "🐺 הזאב של השולחן",
        "💪 שריר הפוקר מפותח",
        "🎩 ג'נטלמן שלוקח את הכל",
        "⚔️ לוחם ותיק בזירה",
        "🏦 הקופה האישית שלו",
      ];
      return winnerSentences[Math.floor(Math.random() * winnerSentences.length)];
    }

    // Good winner (avg profit 20-50)
    if (avgProfit > 20) {
      const goodWinnerSentences = [
        "📊 ברווח יציב - מסוכן!",
        "💵 עושה כסף בשקט",
        "🎯 מדויק ויעיל",
        "📈 מגמה חיובית ברורה",
        "🧠 שחקן חכם עם תוצאות",
        "💎 יהלום לא מלוטש",
        "🎖️ בדרך לפסגה",
        "✨ כישרון אמיתי",
        "🌱 צומח בכל משחק",
      ];
      return goodWinnerSentences[Math.floor(Math.random() * goodWinnerSentences.length)];
    }

    // Big loser (avg profit < -50)
    if (avgProfit < -50) {
      const loserSentences = [
        "💸 ראש מחלקת תרומות",
        "🎁 הספונסר האהוב של הקבוצה",
        "🏧 כספומט מהלך",
        "😇 ממן את המשקאות של כולם",
        "🙏 תודה על השירות",
        "🎪 הבדרן של הערב",
        "💝 לב רחב מאוד",
        "🌧️ ענן גשם אישי",
        "🎭 טרגדיה יוונית בזמן אמת",
        "📉 גרף שרק יורד",
        "🕳️ בור עמוק מאוד",
        "🎰 מכור להפסדים?",
        "🤝 נותן צדקה בכל משחק",
        "💔 הלב נשבר שוב ושוב",
        "🌊 שוחה נגד הזרם",
      ];
      return loserSentences[Math.floor(Math.random() * loserSentences.length)];
    }

    // Moderate loser (avg profit -20 to -50)
    if (avgProfit < -20) {
      const moderateLoserSentences = [
        "📉 במגמת ירידה קלה",
        "🎢 רכבת הרים למטה",
        "🌧️ ימים אפורים",
        "🤔 צריך לשנות אסטרטגיה",
        "💭 חולם על ימים טובים יותר",
        "🎲 המזל לא לצידו לאחרונה",
        "🌪️ בעין הסערה",
      ];
      return moderateLoserSentences[Math.floor(Math.random() * moderateLoserSentences.length)];
    }

    // On a hot winning streak (3+)
    if (currentStreak >= 3) {
      const hotStreakSentences = [
        `🔥 ${currentStreak} נצחונות ברצף! בוער!`,
        "⚡ בלתי ניתן לעצירה!",
        "🚀 טיל בדרך לירח",
        "💥 פיצוץ של הצלחה",
        "🌋 הר געש פעיל",
        "⭐ כוכב על בשיאו",
        "🎯 כל יריה בול!",
        "👊 מכה ולא מפסיק",
      ];
      return hotStreakSentences[Math.floor(Math.random() * hotStreakSentences.length)];
    }

    // On a winning streak (2)
    if (currentStreak >= 2) {
      const streakSentences = [
        `✌️ ${currentStreak} נצחונות ברצף - ממשיך?`,
        "📈 רוכב על הגל",
        "🎰 המזל חזק לאחרונה",
        "💪 בנייה של מומנטום",
        "🌊 גל חיובי",
        "✨ ניצוץ שהופך ללהבה",
      ];
      return streakSentences[Math.floor(Math.random() * streakSentences.length)];
    }

    // On a bad losing streak (3+)
    if (currentStreak <= -3) {
      const badStreakSentences = [
        `😱 ${Math.abs(currentStreak)} הפסדים ברצף! אסון!`,
        "🆘 קריאת מצוקה",
        "🌑 חושך בקצה המנהרה",
        "💀 סימן מוות לארנק",
        "🕳️ נופל לתהום",
        "❄️ תקופת קרח ארוכה",
        "🏳️ דגל לבן באופק?",
        "😵 סחרחורת הפסדים",
      ];
      return badStreakSentences[Math.floor(Math.random() * badStreakSentences.length)];
    }

    // On a losing streak (2)
    if (currentStreak <= -2) {
      const loseStreakSentences = [
        `😰 ${Math.abs(currentStreak)} הפסדים ברצף...`,
        "📉 מגיע לו קאמבק",
        "🍀 צריך קצת מזל",
        "🤞 מצב התאוששות",
        "🌧️ עננים מעל הראש",
        "💫 מחפש את הכוכב שלו",
      ];
      return loseStreakSentences[Math.floor(Math.random() * loseStreakSentences.length)];
    }

    // High win rate (60%+)
    if (winPercentage > 60) {
      const highWinRateSentences = [
        "📊 סטטיסטית מסוכן",
        "🧮 המספרים לטובתו",
        "📈 אחוזי ניצחון גבוהים",
        "🎯 יותר פעמים מנצח מפסיד",
        "🏅 סיכויים טובים",
        "⚖️ ההיסטוריה לצידו",
      ];
      return highWinRateSentences[Math.floor(Math.random() * highWinRateSentences.length)];
    }

    // Low win rate (40% or less)
    if (winPercentage < 40 && gamesPlayed >= 3) {
      const lowWinRateSentences = [
        "🎲 אופטימיות מנצחת סטטיסטיקה?",
        "📉 ההיסטוריה לא לצידו",
        "🤞 מקווה לשינוי",
        "🌈 מחכה לקשת",
        "🎰 מאמין בנסים",
        "💭 חלומות גדולים",
      ];
      return lowWinRateSentences[Math.floor(Math.random() * lowWinRateSentences.length)];
    }

    // Had a massive win
    if (biggestWin > 200) {
      const bigWinSentences = [
        "💎 זוכר את הלילה האגדי...",
        "🏆 יש לו רגע שיא להגן עליו",
        "⭐ כוכב עם רגע מזהיר",
        "🎰 פעם אחת פגע בג'קפוט",
        "💰 יודע איך זה להרוויח גדול",
      ];
      return bigWinSentences[Math.floor(Math.random() * bigWinSentences.length)];
    }

    // Had a big win
    if (biggestWin > 100) {
      return "✨ יודע לעשות לילות טובים";
    }

    // Had a massive loss
    if (biggestLoss < -200) {
      const bigLossSentences = [
        "😅 עדיין מתאושש מהלילה ההוא",
        "💔 צלקות עמוקות",
        "🌪️ שרד סופה קשה",
        "📚 למד שיעור יקר",
      ];
      return bigLossSentences[Math.floor(Math.random() * bigLossSentences.length)];
    }

    // Had a big loss
    if (biggestLoss < -100) {
      return "😬 יודע איך זה להפסיד גדול";
    }

    // Experienced player
    if (gamesPlayed >= 10) {
      const experiencedSentences = [
        "🎖️ ותיק מנוסה",
        "🧠 יודע את המשחק",
        "🎭 ראה הכל",
        "📊 הרבה נתונים עליו",
        "⚔️ לוחם ותיק",
      ];
      return experiencedSentences[Math.floor(Math.random() * experiencedSentences.length)];
    }

    // Few games played
    if (gamesPlayed <= 3) {
      const newishSentences = [
        "🌱 עדיין לומד את השטח",
        "📝 מעט נתונים",
        "❓ עדיין סימן שאלה",
        "🔍 תחת תצפית",
      ];
      return newishSentences[Math.floor(Math.random() * newishSentences.length)];
    }

    // Break-even / neutral player - many options!
    const neutralSentences = [
      "😐 שומר ז'יטונים מקצועי",
      "⚖️ מאוזן לחלוטין",
      "🎭 הקלף הפראי",
      "🤷 יכול ללכת לכל כיוון",
      "📊 מר ממוצע",
      "🎲 הכל יכול לקרות",
      "🌊 שוחה עם הזרם",
      "☁️ לא שמש ולא גשם",
      "🔄 עקבי בחוסר עקביות",
      "🎯 לפעמים כאן, לפעמים שם",
      "🧩 חתיכה במשחק",
      "🎪 חלק מההצגה",
      "🌙 תלוי במצב הרוח",
      "🎵 רוקד לפי המוזיקה",
      "🌿 זורם עם הרוח",
      "🎨 צבעים משתנים",
      "🔮 קשה לחזות",
      "⚡ פוטנציאל מוסתר",
      "🌀 מסתורי",
      "🎭 בעל שני פנים",
    ];
    return neutralSentences[Math.floor(Math.random() * neutralSentences.length)];
  };

  // Get expected profit for a player
  const getExpectedProfit = (stats: PlayerStats | undefined): number => {
    if (!stats || stats.gamesPlayed === 0) return 0;
    return Math.round(stats.avgProfit);
  };

  // Generate forecast for all selected players
  const generateForecast = () => {
    const forecasts = Array.from(selectedIds).map(playerId => {
      const player = players.find(p => p.id === playerId);
      if (!player) return null;
      
      const stats = getStatsForPlayer(playerId);
      const expected = getExpectedProfit(stats);
      const sentence = generateFunnySentence(stats, player);
      
      return {
        player,
        expected,
        sentence,
        gamesPlayed: stats?.gamesPlayed || 0
      };
    }).filter(Boolean) as { player: Player; expected: number; sentence: string; gamesPlayed: number }[];

    // Sort by expected profit (winners first)
    return forecasts.sort((a, b) => b.expected - a.expected);
  };

  // Share forecast to WhatsApp
  const shareForecast = () => {
    const forecasts = generateForecast();
    const today = new Date().toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'short' });
    
    let message = `🔮 *תחזית פוקר - ${today}*\n\n`;
    
    forecasts.forEach((f, index) => {
      const emoji = f.expected > 20 ? '🟢' : f.expected < -20 ? '🔴' : '⚪';
      const profitStr = f.expected >= 0 ? `+₪${f.expected}` : `-₪${Math.abs(f.expected)}`;
      message += `${emoji} *${f.player.name}*: ${profitStr}\n`;
      message += `   ${f.sentence}\n\n`;
    });

    message += `\n🃏 Good luck everyone!`;

    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank');
  };

  const handleShowForecast = () => {
    if (selectedIds.size < 2) {
      setError('Select at least 2 players');
      return;
    }
    setShowForecast(true);
  };

  // Render player tile
  const renderPlayerTile = (player: Player) => (
    <div
      key={player.id}
      onClick={() => togglePlayer(player.id)}
      style={{
        padding: '0.6rem 0.5rem',
        borderRadius: '12px',
        fontSize: '1rem',
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
        <div>
          <h1 className="page-title" style={{ fontSize: '1.5rem', marginBottom: '0.1rem' }}>New Game</h1>
          <p className="page-subtitle" style={{ fontSize: '0.8rem' }}>Select players</p>
        </div>
        {players.length > 0 && (
          <button className="btn btn-sm btn-secondary" onClick={selectAll} style={{ fontSize: '0.75rem', padding: '0.3rem 0.6rem' }}>
            {selectedIds.size === players.length ? 'Deselect All' : 'Select All'}
          </button>
        )}
      </div>

      {error && (
        <div style={{ background: 'rgba(239, 68, 68, 0.1)', padding: '0.5rem', borderRadius: '6px', marginBottom: '0.5rem', borderLeft: '3px solid var(--danger)' }}>
          <p style={{ color: 'var(--danger)', fontSize: '0.85rem', margin: 0 }}>{error}</p>
        </div>
      )}

      {/* Permanent Players */}
      <div className="card" style={{ padding: '0.75rem', marginBottom: '0.75rem' }}>
        {permanentPlayers.length === 0 && guestPlayers.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '1rem' }}>
            <div style={{ fontSize: '2rem' }}>👥</div>
            <p style={{ margin: '0.5rem 0 0.25rem', fontWeight: '500' }}>No players yet</p>
            <p className="text-muted" style={{ fontSize: '0.8rem', margin: 0 }}>Add players to get started</p>
          </div>
        ) : (
          <>
            {permanentPlayers.length > 0 && (
              <div style={{ 
                display: 'grid', 
                gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))',
                gap: '0.75rem'
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
            marginTop: permanentPlayers.length > 0 ? '0.75rem' : '0',
            padding: '0.5rem',
            border: '2px dashed var(--border)',
            borderRadius: '8px',
            background: 'transparent',
            color: 'var(--text-muted)',
            fontSize: '0.85rem',
            cursor: 'pointer'
          }}
        >
          + Add Player
        </button>
      </div>

      {/* Guest Players Section */}
      {guestPlayers.length > 0 && (
        <div className="card" style={{ padding: '0.75rem', marginBottom: '0.75rem' }}>
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
              👤 Guest Players ({guestPlayers.length})
            </span>
            <span style={{ fontSize: '1.2rem', color: 'var(--text-muted)' }}>
              {showGuests ? '▲' : '▼'}
            </span>
          </button>
          
          {showGuests && (
            <div style={{ 
              display: 'grid', 
              gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))',
              gap: '0.75rem',
              marginTop: '0.75rem'
            }}>
              {guestPlayers.map(renderPlayerTile)}
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem' }}>
        <button 
          className="btn btn-secondary btn-lg"
          onClick={handleShowForecast}
          disabled={selectedIds.size < 2}
          style={{ padding: '0.875rem', flex: '1' }}
        >
          🔮 Forecast
        </button>
        <button 
          className="btn btn-primary btn-lg"
          onClick={handleStartGame}
          disabled={selectedIds.size < 2}
          style={{ padding: '0.875rem', flex: '2' }}
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
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  type="button"
                  onClick={() => setNewPlayerType('guest')}
                  style={{
                    flex: 1,
                    padding: '0.6rem',
                    borderRadius: '8px',
                    border: newPlayerType === 'guest' ? '2px solid var(--primary)' : '2px solid var(--border)',
                    background: newPlayerType === 'guest' ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
                    color: newPlayerType === 'guest' ? 'var(--primary)' : 'var(--text-muted)',
                    cursor: 'pointer',
                    fontWeight: '600',
                    fontSize: '0.9rem'
                  }}
                >
                  👤 Guest
                </button>
                <button
                  type="button"
                  onClick={() => setNewPlayerType('permanent')}
                  style={{
                    flex: 1,
                    padding: '0.6rem',
                    borderRadius: '8px',
                    border: newPlayerType === 'permanent' ? '2px solid var(--primary)' : '2px solid var(--border)',
                    background: newPlayerType === 'permanent' ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
                    color: newPlayerType === 'permanent' ? 'var(--primary)' : 'var(--text-muted)',
                    cursor: 'pointer',
                    fontWeight: '600',
                    fontSize: '0.9rem'
                  }}
                >
                  ⭐ Permanent
                </button>
              </div>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.35rem' }}>
                {newPlayerType === 'guest' 
                  ? 'Guest players appear in a separate section' 
                  : 'Permanent players always appear in the main list'}
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
      {showForecast && (
        <div className="modal-overlay" onClick={() => setShowForecast(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxHeight: '80vh', overflow: 'auto' }}>
            <div className="modal-header">
              <h3 className="modal-title">🔮 Tonight's Forecast</h3>
              <button className="modal-close" onClick={() => setShowForecast(false)}>×</button>
            </div>
            
            <div style={{ marginBottom: '1rem' }}>
              {generateForecast().map((forecast, index) => {
                const { player, expected, sentence, gamesPlayed } = forecast;
                const isWinner = expected > 20;
                const isLoser = expected < -20;
                
                return (
                  <div 
                    key={player.id}
                    style={{
                      padding: '0.75rem',
                      marginBottom: '0.5rem',
                      borderRadius: '10px',
                      background: isWinner 
                        ? 'rgba(34, 197, 94, 0.1)' 
                        : isLoser 
                          ? 'rgba(239, 68, 68, 0.1)' 
                          : 'rgba(100, 100, 100, 0.1)',
                      borderLeft: `4px solid ${isWinner ? 'var(--success)' : isLoser ? 'var(--danger)' : 'var(--text-muted)'}`
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                      <span style={{ fontWeight: '600', fontSize: '1rem' }}>
                        {index === 0 && expected > 0 && '👑 '}
                        {player.name}
                      </span>
                      <span style={{ 
                        fontWeight: '700', 
                        fontSize: '1rem',
                        color: isWinner ? 'var(--success)' : isLoser ? 'var(--danger)' : 'var(--text)'
                      }}>
                        {expected >= 0 ? '+' : ''}₪{expected}
                      </span>
                    </div>
                    <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                      {sentence}
                    </div>
                    {gamesPlayed > 0 && (
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.25rem', opacity: 0.7 }}>
                        Based on {gamesPlayed} game{gamesPlayed > 1 ? 's' : ''}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textAlign: 'center', marginBottom: '1rem' }}>
              ⚠️ Forecast based on historical averages. Actual results may vary! 🎲
            </p>

            <div className="actions">
              <button className="btn btn-secondary" onClick={() => setShowForecast(false)}>
                Close
              </button>
              <button className="btn btn-primary" onClick={shareForecast}>
                📤 Share to WhatsApp
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default NewGameScreen;
