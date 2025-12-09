import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { GamePlayer, Settlement, SkippedTransfer } from '../types';
import { getGame, getGamePlayers, getSettings } from '../database/storage';
import { calculateSettlement, formatCurrency, getProfitColor } from '../utils/calculations';
import { generateGameSummary, shareToWhatsApp } from '../utils/sharing';

const GameDetailsScreen = () => {
  const { gameId } = useParams<{ gameId: string }>();
  const navigate = useNavigate();
  const [players, setPlayers] = useState<GamePlayer[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [skippedTransfers, setSkippedTransfers] = useState<SkippedTransfer[]>([]);
  const [gameDate, setGameDate] = useState('');
  const [rebuyValue, setRebuyValue] = useState(50);
  const [chipGap, setChipGap] = useState<number | null>(null);
  const [chipGapPerPlayer, setChipGapPerPlayer] = useState<number | null>(null);

  useEffect(() => {
    if (gameId) {
      loadData();
    }
  }, [gameId]);

  const loadData = () => {
    if (!gameId) return;
    const game = getGame(gameId);
    const gamePlayers = getGamePlayers(gameId);
    const settings = getSettings();
    
    if (game) {
      setGameDate(game.date);
      setChipGap(game.chipGap || null);
      setChipGapPerPlayer(game.chipGapPerPlayer || null);
    }
    
    setPlayers(gamePlayers.sort((a, b) => b.profit - a.profit));
    setRebuyValue(settings.rebuyValue);
    
    const { settlements: settl, smallTransfers: small } = calculateSettlement(
      gamePlayers, 
      settings.minTransfer
    );
    setSettlements(settl);
    setSkippedTransfers(small);
  };

  const handleShare = () => {
    const summary = generateGameSummary(gameDate, players, settlements, skippedTransfers, chipGap, chipGapPerPlayer);
    shareToWhatsApp(summary);
  };

  const totalPot = players.reduce((sum, p) => sum + p.rebuys * rebuyValue, 0);

  return (
    <div className="fade-in">
      <div className="page-header">
        <button 
          className="btn btn-sm btn-secondary mb-2"
          onClick={() => navigate('/history')}
        >
          ← Back to History
        </button>
        <h1 className="page-title">Game Details</h1>
        <p className="page-subtitle">
          {new Date(gameDate).toLocaleDateString('en-US', { 
            weekday: 'long', 
            month: 'long', 
            day: 'numeric',
            year: 'numeric'
          })}
        </p>
      </div>

      <div className="grid grid-3 mb-2">
        <div className="stat-card">
          <div className="stat-value">{players.length}</div>
          <div className="stat-label">Players</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">₪{totalPot.toString()}</div>
          <div className="stat-label">Total Pot</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{players.reduce((sum, p) => sum + p.rebuys, 0)}</div>
          <div className="stat-label">Total Buy-ins</div>
        </div>
      </div>

      <div className="card">
        <h2 className="card-title mb-2">Results</h2>
        <table>
          <thead>
            <tr>
              <th>Player</th>
              <th style={{ textAlign: 'center' }}>Buy-ins</th>
              <th style={{ textAlign: 'right' }}>Chips</th>
              <th style={{ textAlign: 'right' }}>Profit/Loss</th>
            </tr>
          </thead>
          <tbody>
            {players.map((player, index) => (
              <tr key={player.id}>
                <td>
                  {index === 0 && player.profit > 0 && '🥇 '}
                  {index === 1 && player.profit > 0 && '🥈 '}
                  {index === 2 && player.profit > 0 && '🥉 '}
                  {player.playerName}
                </td>
                <td style={{ textAlign: 'center' }}>{player.rebuys}</td>
                <td style={{ textAlign: 'right' }}>₪{player.finalValue.toString()}</td>
                <td style={{ textAlign: 'right' }} className={getProfitColor(player.profit)}>
                  {player.profit >= 0 ? '+' : ''}{formatCurrency(player.profit)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        
        {chipGap !== null && chipGap !== 0 && (
          <div style={{ 
            marginTop: '1rem', 
            padding: '0.75rem', 
            background: 'rgba(245, 158, 11, 0.1)', 
            borderRadius: '8px',
            borderLeft: '3px solid var(--warning)'
          }}>
            <div style={{ fontSize: '0.875rem', color: 'var(--warning)', fontWeight: '600' }}>
              ⚠️ Chip Count Adjustment
            </div>
            <div className="text-muted" style={{ fontSize: '0.875rem', marginTop: '0.25rem' }}>
              {chipGap > 0 ? (
                <>Counted ₪{chipGap.toString()} more than expected</>
              ) : (
                <>Counted ₪{Math.abs(chipGap).toString()} less than expected</>
              )}
              {' '}• Adjusted {chipGapPerPlayer && chipGapPerPlayer > 0 ? '-' : '+'}₪{Math.abs(chipGapPerPlayer || 0).toString()} per player
            </div>
          </div>
        )}
      </div>

      {settlements.length > 0 && (
        <div className="card">
          <h2 className="card-title mb-2">💸 Settlements</h2>
          {settlements.map((s, index) => (
            <div key={index} className="settlement-row">
              <span>{s.from}</span>
              <span className="settlement-arrow">➜</span>
              <span>{s.to}</span>
              <span className="settlement-amount">{formatCurrency(s.amount)}</span>
            </div>
          ))}
        </div>
      )}

      {skippedTransfers.length > 0 && (
        <div className="card">
          <h2 className="card-title mb-2">💡 Small Amounts Note</h2>
          <p className="text-muted mb-1" style={{ fontSize: '0.875rem' }}>
            Below minimum threshold but included in settlements above
          </p>
          {skippedTransfers.map((s, index) => (
            <div key={index} className="settlement-row" style={{ opacity: 0.8 }}>
              <span>{s.from}</span>
              <span className="settlement-arrow">➜</span>
              <span>{s.to}</span>
              <span style={{ color: 'var(--warning)' }}>{formatCurrency(s.amount)}</span>
            </div>
          ))}
        </div>
      )}

      <button className="btn btn-primary btn-lg btn-block mt-2" onClick={handleShare}>
        📤 Share to WhatsApp
      </button>
    </div>
  );
};

export default GameDetailsScreen;

