import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Player } from '../types';
import { getAllPlayers, addPlayer, createGame, getPlayerByName } from '../database/storage';

const NewGameScreen = () => {
  const navigate = useNavigate();
  const [players, setPlayers] = useState<Player[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showAddPlayer, setShowAddPlayer] = useState(false);
  const [newPlayerName, setNewPlayerName] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    loadPlayers();
  }, []);

  const loadPlayers = () => {
    setPlayers(getAllPlayers());
  };

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

    const newPlayer = addPlayer(trimmedName);
    setPlayers([...players, newPlayer]);
    setSelectedIds(new Set([...selectedIds, newPlayer.id]));
    setNewPlayerName('');
    setShowAddPlayer(false);
    setError('');
  };

  const handleStartGame = () => {
    if (selectedIds.size < 2) {
      setError('Select at least 2 players');
      return;
    }
    
    const game = createGame(Array.from(selectedIds));
    navigate(`/live-game/${game.id}`);
  };

  return (
    <div className="fade-in">
      <div className="page-header">
        <h1 className="page-title">New Game</h1>
        <p className="page-subtitle">Select players for tonight's game</p>
      </div>

      {error && (
        <div className="card" style={{ background: 'rgba(239, 68, 68, 0.1)', borderLeft: '4px solid var(--danger)' }}>
          <p style={{ color: 'var(--danger)' }}>{error}</p>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Players ({selectedIds.size} selected)</h2>
          {players.length > 0 && (
            <button className="btn btn-sm btn-secondary" onClick={selectAll}>
              {selectedIds.size === players.length ? 'Deselect All' : 'Select All'}
            </button>
          )}
        </div>

        {players.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">👥</div>
            <p>No players yet</p>
            <p className="text-muted">Add players to get started</p>
          </div>
        ) : (
          <div className="list">
            {players.map(player => (
              <div
                key={player.id}
                className={`player-card ${selectedIds.has(player.id) ? 'selected' : ''}`}
                onClick={() => togglePlayer(player.id)}
              >
                <span className="player-name">{player.name}</span>
                <div className={`checkbox ${selectedIds.has(player.id) ? 'checked' : ''}`}>
                  {selectedIds.has(player.id) && <span className="checkbox-mark">✓</span>}
                </div>
              </div>
            ))}
          </div>
        )}

        <button 
          className="btn btn-outline btn-block mt-2"
          onClick={() => setShowAddPlayer(true)}
        >
          + Add New Player
        </button>
      </div>

      <button 
        className="btn btn-primary btn-lg btn-block"
        onClick={handleStartGame}
        disabled={selectedIds.size < 2}
      >
        🎰 Start Game ({selectedIds.size} players)
      </button>

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
    </div>
  );
};

export default NewGameScreen;

