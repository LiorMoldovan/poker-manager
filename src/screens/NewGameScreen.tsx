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

  // Generate funny sentence based on player stats (Hebrew)
  const generateFunnySentence = (stats: PlayerStats | undefined, player: Player): string => {
    if (!stats || stats.gamesPlayed === 0) {
      const newPlayerSentences = [
        "🆕 בשר טרי לשולחן!",
        "🎲 מזל מתחילים בדרך?",
        "👀 החידה המסתורית...",
        "🤔 בלי היסטוריה, בלי רחמים!",
      ];
      return newPlayerSentences[Math.floor(Math.random() * newPlayerSentences.length)];
    }

    const { avgProfit, currentStreak, winPercentage, biggestWin, biggestLoss } = stats;

    // Big winner
    if (avgProfit > 50) {
      const winnerSentences = [
        "🔥 הסיוט של השולחן",
        "💰 אספן ז'יטונים מקצועי",
        "👑 תשתחוו בפני המלך",
        "🎯 מגנט כסף מופעל",
        "🦈 התראת כריש! תחביאו את הז'יטונים!",
      ];
      return winnerSentences[Math.floor(Math.random() * winnerSentences.length)];
    }

    // Big loser
    if (avgProfit < -50) {
      const loserSentences = [
        "💸 ראש מחלקת תרומות",
        "🎁 הספונסר האהוב של הקבוצה",
        "🏧 כספומט מהלך",
        "😇 ממן את המשקאות של כולם",
        "🙏 תודה על השירות",
      ];
      return loserSentences[Math.floor(Math.random() * loserSentences.length)];
    }

    // On a winning streak
    if (currentStreak >= 2) {
      const streakSentences = [
        `🔥 ${currentStreak} נצחונות ברצף! יד חמה!`,
        "⚡ כרגע בלתי ניתן לעצירה",
        "📈 רוכב על הגל",
        "🎰 המזל חזק איתו הלילה",
      ];
      return streakSentences[Math.floor(Math.random() * streakSentences.length)];
    }

    // On a losing streak
    if (currentStreak <= -2) {
      const loseStreakSentences = [
        `😰 ${Math.abs(currentStreak)} הפסדים ברצף... אאוץ'`,
        "📉 מגיע לו קאמבק... נכון?",
        "🍀 צריך מזל רציני הלילה",
        "🤞 מצב התאוששות מופעל",
      ];
      return loseStreakSentences[Math.floor(Math.random() * loseStreakSentences.length)];
    }

    // High win rate
    if (winPercentage > 60) {
      return "📊 סטטיסטית מסוכן";
    }

    // Low win rate
    if (winPercentage < 40 && stats.gamesPlayed >= 3) {
      return "🎲 אופטימיות מנצחת סטטיסטיקה";
    }

    // Had a big win recently
    if (biggestWin > 150) {
      return "💎 זוכר את הלילה המטורף ההוא...";
    }

    // Had a big loss
    if (biggestLoss < -150) {
      return "😅 עדיין מתאושש רגשית";
    }

    // Break-even player
    const neutralSentences = [
      "😐 שומר ז'יטונים מקצועי",
      "⚖️ מאוזן לחלוטין",
      "🎭 הקלף הפראי",
      "🤷 יכול ללכת לכל כיוון",
      "📊 מר ממוצע",
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
