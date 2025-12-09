import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { GamePlayer, Settlement, SkippedTransfer } from '../types';
import { getGame, getGamePlayers, getSettings } from '../database/storage';
import { calculateSettlement, formatCurrency, getProfitColor } from '../utils/calculations';
import { generateGameSummary, shareToWhatsApp } from '../utils/sharing';

const GameSummaryScreen = () => {
  const { gameId } = useParams<{ gameId: string }>();
  const navigate = useNavigate();
  const [players, setPlayers] = useState<GamePlayer[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [skippedTransfers, setSkippedTransfers] = useState<SkippedTransfer[]>([]);
  const [gameDate, setGameDate] = useState('');
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

  const winner = players[0];

  return (
    <div className="fade-in">
      <div className="page-header">
        <h1 className="page-title">Game Summary</h1>
        <p className="page-subtitle">
          {new Date(gameDate).toLocaleDateString('en-US', { 
            weekday: 'long', 
            month: 'short', 
            day: 'numeric' 
          })}
        </p>
      </div>

      {winner && winner.profit > 0 && (
        <div className="summary-card">
          <div className="summary-title">🏆 Winner</div>
          <div className="summary-value">{winner.playerName}</div>
          <div style={{ opacity: 0.9 }}>+{formatCurrency(winner.profit)}</div>
        </div>
      )}

      <div className="card">
        <h2 className="card-title mb-2">Results</h2>
        <table>
          <thead>
            <tr>
              <th>Player</th>
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
                <>Counted ₪{chipGap.toString()} more than expected (extra chips)</>
              ) : (
                <>Counted ₪{Math.abs(chipGap).toString()} less than expected (missing chips)</>
              )}
            </div>
            <div className="text-muted" style={{ fontSize: '0.875rem' }}>
              Adjusted {chipGapPerPlayer && chipGapPerPlayer > 0 ? '-' : '+'}₪{Math.abs(chipGapPerPlayer || 0).toString()} per player to balance
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
          <h2 className="card-title mb-2">💡 Small Amounts</h2>
          <p className="text-muted mb-1" style={{ fontSize: '0.875rem' }}>
            Payments below ₪{getSettings().minTransfer.toString()} are not mandatory
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

      <div className="actions mt-3">
        <button className="btn btn-secondary btn-lg" onClick={() => navigate('/')}>
          🏠 Home
        </button>
        <button className="btn btn-primary btn-lg" onClick={handleShare}>
          📤 Share to WhatsApp
        </button>
      </div>
    </div>
  );
};

export default GameSummaryScreen;

