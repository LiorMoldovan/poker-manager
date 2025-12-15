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

  // Generate forecasts for all selected players (balanced to sum to zero)
  const generateForecasts = () => {
    // Step 1: Get initial raw expected profits
    const rawForecasts = Array.from(selectedIds).map(playerId => {
      const player = players.find(p => p.id === playerId);
      if (!player) return null;
      
      const stats = getStatsForPlayer(playerId);
      // Get raw expected based on stats
      let rawExpected = 0;
      if (stats && stats.gamesPlayed > 0) {
        rawExpected = stats.avgProfit;
        // Adjust based on streak
        if (stats.currentStreak >= 2) rawExpected *= 1.2;
        if (stats.currentStreak <= -2) rawExpected *= 0.8;
      }
      
      return {
        player,
        stats,
        rawExpected: Math.round(rawExpected),
        gamesPlayed: stats?.gamesPlayed || 0
      };
    }).filter(Boolean) as { player: Player; stats: PlayerStats | undefined; rawExpected: number; gamesPlayed: number }[];
    
    // Step 2: Calculate total imbalance
    const totalRaw = rawForecasts.reduce((sum, f) => sum + f.rawExpected, 0);
    
    // Step 3: Distribute imbalance proportionally to balance to zero
    // Players with higher absolute expected values absorb more of the adjustment
    const totalAbsolute = rawForecasts.reduce((sum, f) => sum + Math.abs(f.rawExpected) + 10, 0); // +10 to avoid division by zero
    
    const balancedForecasts = rawForecasts.map(f => {
      const weight = (Math.abs(f.rawExpected) + 10) / totalAbsolute;
      const adjustment = -totalRaw * weight;
      const balancedExpected = Math.round(f.rawExpected + adjustment);
      
      // Generate sentence based on the BALANCED expected value
      const { sentence } = generateForecastSentence(f.stats, f.player.name, balancedExpected);
      
      return {
        player: f.player,
        expected: balancedExpected,
        sentence,
        gamesPlayed: f.gamesPlayed
      };
    });

    // Sort by expected profit (winners first)
    return balancedForecasts.sort((a, b) => b.expected - a.expected);
  };
  
  // Generate sentence based on the final balanced expected value
  const generateForecastSentence = (stats: PlayerStats | undefined, playerName: string, expected: number): { sentence: string } => {
    // New player - no data
    if (!stats || stats.gamesPlayed === 0) {
      const newPlayerSentences = [
        `🆕 ${playerName} מגיע בלי היסטוריה - הכל פתוח! התחזית מעורבת כי אין מספיק נתונים`,
        `🎲 שחקן חדש בזירה! ${playerName} יכול להפתיע לטוב או לרע`,
        `👀 ${playerName} הוא חידה עטופה בתעלומה. בלי נתונים, קשה לחזות`,
        `🐣 טירון על השולחן! ${playerName} עדיין לא נחשף לחוקי המשחק האמיתיים`,
        `❓ ${playerName} הוא סימן שאלה ענק - יכול להפתיע לכל כיוון`,
        `🎭 פנים חדשות! ${playerName} מביא אנרגיה לא ידועה לשולחן`,
        `🌟 ${playerName} עולה לבמה בפעם הראשונה - נראה מה יקרה`,
        `🎪 ${playerName} נכנס למעגל - מה שיקרה הלילה יכתוב את ההיסטוריה שלו`,
      ];
      return { sentence: newPlayerSentences[Math.floor(Math.random() * newPlayerSentences.length)] };
    }

    const { avgProfit, currentStreak, winPercentage, gamesPlayed, totalProfit } = stats;
    
    // Big winner expected (expected > 40)
    if (expected > 40) {
      const sentences = [
        `🔥 ${playerName} צפוי להיות הכוכב של הלילה! עם ממוצע של ${Math.round(avgProfit)}₪ והיסטוריה מרשימה, הכסף זורם אליו`,
        `👑 ${playerName} במצב מעולה! ${currentStreak > 0 ? `${currentStreak} נצחונות ברצף ו` : ''}התחזית מבטיחה רווח יפה`,
        `💰 ${playerName} הוא המועמד המוביל לרווח הגדול! ${Math.round(winPercentage)}% נצחונות מדברים בעד עצמם`,
        `🦈 ${playerName} מגיע כשהוא מסוכן ורעב! ההיסטוריה מראה שזה הזמן שלו לקצור`,
        `⭐ ${playerName} בשיא הפורמה! עם ${gamesPlayed} משחקים של ניסיון, הלילה נראה מבטיח מאוד`,
        `🎯 ${playerName} מכוון גבוה הלילה! הסטטיסטיקות והאינסטינקט אומרים: רווח משמעותי`,
      ];
      return { sentence: sentences[Math.floor(Math.random() * sentences.length)] };
    }
    
    // Good winner expected (expected 15-40)
    if (expected > 15) {
      const sentences = [
        `📈 ${playerName} במגמת עלייה! צפוי רווח נאה הלילה בהתבסס על ${gamesPlayed} משחקים של נתונים`,
        `✨ ${playerName} נראה טוב הלילה! הממוצע החיובי שלו (${Math.round(avgProfit)}₪) מרמז על רווח`,
        `💵 ${playerName} עושה כסף לאט אבל בטוח. הלילה לא יהיה שונה - צפוי רווח סולידי`,
        `🎖️ ${playerName} עם סיכויים טובים! ${Math.round(winPercentage)}% נצחונות זה בסיס חזק`,
        `🌱 ${playerName} צומח בכל משחק והלילה ימשיך את המגמה החיובית`,
      ];
      return { sentence: sentences[Math.floor(Math.random() * sentences.length)] };
    }
    
    // Slight winner (expected 5-15)  
    if (expected > 5) {
      const sentences = [
        `📊 ${playerName} צפוי לרווח קטן הלילה - לא מרשים אבל חיובי`,
        `⚖️ ${playerName} קרוב לאיזון עם נטייה קלה לחיוב. לילה סביר צפוי`,
        `🎲 ${playerName} במצב ניטרלי-חיובי. סיכוי לרווח קטן`,
        `✌️ ${playerName} עם יתרון קל - לא גדול אבל בכיוון הנכון`,
      ];
      return { sentence: sentences[Math.floor(Math.random() * sentences.length)] };
    }
    
    // Neutral (expected -5 to 5)
    if (expected >= -5) {
      const sentences = [
        `⚖️ ${playerName} במצב מאוזן לחלוטין - יכול ללכת לכל כיוון הלילה`,
        `🎭 ${playerName} הוא הקלף הפראי! עם תחזית קרובה לאפס, הכל פתוח`,
        `🤷 ${playerName} בדיוק על הגבול - לא מנצח ולא מפסיד, תלוי במזל`,
        `☁️ ${playerName} עם תחזית ניטרלית - לא שמש ולא גשם הלילה`,
        `🔮 ${playerName} קשה לחזות! התוצאה יכולה להפתיע לכל כיוון`,
      ];
      return { sentence: sentences[Math.floor(Math.random() * sentences.length)] };
    }
    
    // Slight loser (expected -15 to -5)
    if (expected >= -15) {
      const sentences = [
        `📉 ${playerName} עם סיכוי להפסד קטן הלילה - לא דרמטי אבל שלילי`,
        `🌧️ ${playerName} תחת ענן קל - צפוי הפסד קטן`,
        `💭 ${playerName} במגמה שלילית קלה - אולי הלילה יפתיע?`,
        `🎲 ${playerName} עם סיכויים לא אופטימיים - הפסד קטן צפוי`,
      ];
      return { sentence: sentences[Math.floor(Math.random() * sentences.length)] };
    }
    
    // Moderate loser (expected -40 to -15)
    if (expected >= -40) {
      const sentences = [
        `📉 ${playerName} צפוי להפסד הלילה. עם ממוצע של ${Math.round(avgProfit)}₪, המגמה לא משתנה`,
        `🌧️ ${playerName} תחת עננים כבדים. ${Math.round(100-winPercentage)}% הפסדים בהיסטוריה לא מבשרים טובות`,
        `💸 ${playerName} צפוי לתרום לקופה הלילה - ההיסטוריה לא לצידו`,
        `😕 ${playerName} עם סיכויים נמוכים. ${gamesPlayed} משחקים של נתונים מראים מגמה שלילית`,
        `🎢 ${playerName} על רכבת הרים יורדת - הלילה לא נראה טוב`,
      ];
      return { sentence: sentences[Math.floor(Math.random() * sentences.length)] };
    }
    
    // Big loser expected (expected < -40)
    const sentences = [
      `💸 ${playerName} צפוי להפסד משמעותי הלילה! ממוצע של ${Math.round(avgProfit)}₪ מספר את הסיפור`,
      `🏧 ${playerName} ימשיך לממן את הקבוצה הלילה! ${Math.round(Math.abs(totalProfit))}₪ הפסד כולל עד היום`,
      `📉 ${playerName} בירידה חופשית! ${Math.round(100-winPercentage)}% הפסדים - הלילה לא יהיה שונה`,
      `💔 ${playerName} והפוקר - סיפור טרגי שממשיך. הלילה צפוי להפסד נוסף`,
      `🌪️ ${playerName} בעין הסערה! ההיסטוריה מראה שהארנק שלו בסכנה`,
      `😓 ${playerName} יצטרך לחפור עמוק בכיס הלילה - התחזית לא אופטימית`,
    ];
    return { sentence: sentences[Math.floor(Math.random() * sentences.length)] };
  };

  // Share forecast to WhatsApp
  const shareForecast = () => {
    const forecasts = generateForecasts();
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
              {generateForecasts().map((forecast, index) => {
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
