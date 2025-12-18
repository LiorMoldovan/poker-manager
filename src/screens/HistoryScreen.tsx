import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { GameWithDetails } from '../types';
import { getAllGames, getGamePlayers, getSettings, deleteGame } from '../database/storage';
import { syncToCloud } from '../database/githubSync';
import { cleanNumber } from '../utils/calculations';
import { usePermissions } from '../App';

const HistoryScreen = () => {
  const navigate = useNavigate();
  const { role, hasPermission } = usePermissions();
  const [games, setGames] = useState<GameWithDetails[]>([]);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  
  const canDeleteGames = hasPermission('game:delete');
  const isAdmin = role === 'admin';

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
        // Sort players by profit (highest to lowest)
        const sortedPlayers = [...players].sort((a, b) => b.profit - a.profit);
        const totalBuyins = players.reduce((sum, p) => sum + p.rebuys, 0);
        const totalPot = totalBuyins * settings.rebuyValue;
        return { ...game, players: sortedPlayers, totalPot, totalBuyins };
      })
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    
    setGames(gamesWithDetails);
  };

  const handleDelete = async (gameId: string) => {
    deleteGame(gameId);
    setGames(games.filter(g => g.id !== gameId));
    setDeleteConfirm(null);
    
    // If admin, sync deletion to cloud
    if (isAdmin) {
      setSyncStatus('Syncing deletion...');
      const result = await syncToCloud();
      if (result.success) {
        setSyncStatus('✅ Deletion synced to cloud');
      } else {
        setSyncStatus('⚠️ Sync failed');
      }
      setTimeout(() => setSyncStatus(null), 2000);
    }
  };

  const getWinner = (game: GameWithDetails) => {
    const sorted = [...game.players].sort((a, b) => b.profit - a.profit);
    return sorted[0];
  };

  return (
    <div className="fade-in">
      {/* Sync Status Banner */}
      {syncStatus && (
        <div style={{
          background: syncStatus.includes('✅') ? 'linear-gradient(135deg, #10B981, #059669)' : 
                     syncStatus.includes('⚠️') ? 'linear-gradient(135deg, #F59E0B, #D97706)' :
                     'linear-gradient(135deg, #3B82F6, #2563EB)',
          color: 'white',
          padding: '0.5rem 1rem',
          borderRadius: '8px',
          marginBottom: '1rem',
          textAlign: 'center',
          fontSize: '0.9rem',
          fontWeight: '500'
        }}>
          {syncStatus}
        </div>
      )}
      
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
                    {game.players.length} players • {(game as any).totalBuyins || 0} buyins
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
              
              {/* All players sorted by profit */}
              <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
                {game.players.map(p => (
                  <span 
                    key={p.id}
                    className={`badge ${p.profit > 0 ? 'badge-success' : p.profit < 0 ? 'badge-danger' : ''}`}
                    style={{ fontSize: '0.7rem', padding: '0.2rem 0.4rem' }}
                  >
                    {p.playerName}: {p.profit >= 0 ? '+' : ''}₪{cleanNumber(p.profit)}
                  </span>
                ))}
              </div>

              {/* Actions row */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.75rem' }}>
                <button 
                  className="btn btn-sm"
                  style={{ 
                    background: 'var(--primary)', 
                    color: 'white',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.3rem'
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/game/${game.id}`);
                  }}
                >
                  📊 פרטים מלאים
                </button>
                {canDeleteGames && (
                  <button 
                    className="btn btn-sm btn-danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteConfirm(game.id);
                    }}
                  >
                    🗑️
                  </button>
                )}
              </div>
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

