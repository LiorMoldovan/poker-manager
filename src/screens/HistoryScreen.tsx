import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { GameWithDetails } from '../types';
import { getAllGames, getGamePlayers, getSettings, deleteGame } from '../database/storage';
import { cleanNumber } from '../utils/calculations';

const HistoryScreen = () => {
  const navigate = useNavigate();
  const [games, setGames] = useState<GameWithDetails[]>([]);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  useEffect(() => {
    loadGames();
  }, []);

  const loadGames = () => {
    const allGames = getAllGames();
    const settings = getSettings();
    
    const gamesWithDetails: GameWithDetails[] = allGames
      .filter(g => g.status === 'completed')
      .map(game => {
        const players = getGamePlayers(game.id);
        const totalPot = players.reduce((sum, p) => sum + p.rebuys * settings.rebuyValue, 0);
        return { ...game, players, totalPot };
      })
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    
    setGames(gamesWithDetails);
  };

  const handleDelete = (gameId: string) => {
    deleteGame(gameId);
    setGames(games.filter(g => g.id !== gameId));
    setDeleteConfirm(null);
  };

  const getWinner = (game: GameWithDetails) => {
    const sorted = [...game.players].sort((a, b) => b.profit - a.profit);
    return sorted[0];
  };

  return (
    <div className="fade-in">
      <div className="page-header">
        <h1 className="page-title">Game History</h1>
        <p className="page-subtitle">{games.length} completed game{games.length !== 1 ? 's' : ''}</p>
      </div>

      {games.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-icon">📚</div>
            <p>No games yet</p>
            <p className="text-muted">Your completed games will appear here</p>
          </div>
        </div>
      ) : (
        games.map(game => {
          const winner = getWinner(game);
          return (
            <div 
              key={game.id} 
              className="card" 
              style={{ cursor: 'pointer' }}
              onClick={() => navigate(`/game/${game.id}`)}
            >
              <div className="card-header">
                <div>
                  <div style={{ fontWeight: '600' }}>
                    {new Date(game.date).toLocaleDateString('en-US', {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </div>
                  <div className="text-muted" style={{ fontSize: '0.875rem' }}>
                    {game.players.length} players • ₪{cleanNumber(game.totalPot)} pot
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  {winner && winner.profit > 0 && (
                    <>
                      <div className="text-muted" style={{ fontSize: '0.75rem' }}>Winner</div>
                      <div style={{ fontWeight: '600', color: 'var(--success)' }}>
                        🏆 {winner.playerName}
                      </div>
                    </>
                  )}
                </div>
              </div>
              
              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
                {game.players.slice(0, 4).map(p => (
                  <span 
                    key={p.id}
                    className={`badge ${p.profit > 0 ? 'badge-success' : p.profit < 0 ? 'badge-danger' : ''}`}
                  >
                    {p.playerName}: {p.profit >= 0 ? '+' : ''}₪{cleanNumber(p.profit)}
                  </span>
                ))}
                {game.players.length > 4 && (
                  <span className="badge">+{game.players.length - 4} more</span>
                )}
              </div>

              <button 
                className="btn btn-sm btn-danger mt-2"
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleteConfirm(game.id);
                }}
              >
                🗑️ Delete
              </button>
            </div>
          );
        })
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div className="modal-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Delete Game?</h3>
              <button className="modal-close" onClick={() => setDeleteConfirm(null)}>×</button>
            </div>
            <p className="text-muted mb-2">This action cannot be undone.</p>
            <div className="actions">
              <button className="btn btn-secondary" onClick={() => setDeleteConfirm(null)}>
                Cancel
              </button>
              <button className="btn btn-danger" onClick={() => handleDelete(deleteConfirm)}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default HistoryScreen;

