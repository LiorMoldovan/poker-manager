import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import html2canvas from 'html2canvas';
import { GamePlayer, Settlement, SkippedTransfer } from '../types';
import { getGame, getGamePlayers, getSettings, getChipValues } from '../database/storage';
import { calculateSettlement, formatCurrency, getProfitColor, cleanNumber } from '../utils/calculations';

const GameSummaryScreen = () => {
  const { gameId } = useParams<{ gameId: string }>();
  const navigate = useNavigate();
  const [players, setPlayers] = useState<GamePlayer[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [skippedTransfers, setSkippedTransfers] = useState<SkippedTransfer[]>([]);
  const [gameDate, setGameDate] = useState('');
  const [chipGap, setChipGap] = useState<number | null>(null);
  const [chipGapPerPlayer, setChipGapPerPlayer] = useState<number | null>(null);
  const [rebuyValue, setRebuyValue] = useState(30);
  const [isSharing, setIsSharing] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);

  // Calculate total chips for a player
  const getTotalChips = (player: GamePlayer): number => {
    const chipValues = getChipValues();
    let total = 0;
    for (const [chipId, count] of Object.entries(player.chipCounts)) {
      const chip = chipValues.find(c => c.id === chipId);
      if (chip) {
        total += count * chip.value;
      }
    }
    return total;
  };

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
    
    setRebuyValue(settings.rebuyValue);
    setPlayers(gamePlayers.sort((a, b) => b.profit - a.profit));
    
    const { settlements: settl, smallTransfers: small } = calculateSettlement(
      gamePlayers, 
      settings.minTransfer
    );
    setSettlements(settl);
    setSkippedTransfers(small);
  };

  const handleShare = async () => {
    if (!summaryRef.current || isSharing) return;
    
    setIsSharing(true);
    
    try {
      // Capture the summary section as an image
      const canvas = await html2canvas(summaryRef.current, {
        backgroundColor: '#1a1a2e',
        scale: 2, // Higher quality
        useCORS: true,
        logging: false,
      });
      
      // Convert to blob
      const blob = await new Promise<Blob>((resolve) => {
        canvas.toBlob((b) => resolve(b!), 'image/png', 1.0);
      });
      
      const file = new File([blob], 'poker-summary.png', { type: 'image/png' });
      
      // Try native share first (works on mobile)
      if (navigator.share && navigator.canShare({ files: [file] })) {
        await navigator.share({
          files: [file],
          title: 'Poker Game Summary',
        });
      } else {
        // Fallback: open WhatsApp with a message to share the image manually
        // First download the image
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'poker-summary.png';
        a.click();
        URL.revokeObjectURL(url);
        
        // Then open WhatsApp
        const dateStr = new Date(gameDate).toLocaleDateString('en-US', { 
          weekday: 'short', 
          month: 'short', 
          day: 'numeric' 
        });
        const text = `🃏 Poker Night Results - ${dateStr}\n\n(Image downloaded - attach it to this message)`;
        window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
      }
    } catch (error) {
      console.error('Error sharing:', error);
      alert('Could not share. Please try again.');
    } finally {
      setIsSharing(false);
    }
  };

  const winner = players[0];

  return (
    <div className="fade-in">
      {/* Content to be captured for screenshot */}
      <div ref={summaryRef} style={{ padding: '1rem', background: '#1a1a2e' }}>
        <div className="page-header">
          <h1 className="page-title">🃏 Poker Night</h1>
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
          <div style={{ overflowX: 'auto' }}>
            <table style={{ fontSize: '0.9rem' }}>
              <thead>
                <tr>
                  <th>Player</th>
                  <th style={{ textAlign: 'center', padding: '0.5rem 0.25rem' }}>🎰</th>
                  <th style={{ textAlign: 'center', padding: '0.5rem 0.25rem' }}>🔄</th>
                  <th style={{ textAlign: 'right' }}>+/-</th>
                </tr>
              </thead>
              <tbody>
                {players.map((player, index) => (
                  <tr key={player.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {index === 0 && player.profit > 0 && '🥇'}
                      {index === 1 && player.profit > 0 && '🥈'}
                      {index === 2 && player.profit > 0 && '🥉'}
                      {index > 2 || player.profit <= 0 ? '' : ' '}
                      {player.playerName}
                    </td>
                    <td style={{ textAlign: 'center', padding: '0.5rem 0.25rem' }} className="text-muted">
                      {(getTotalChips(player) / 1000).toFixed(0)}k
                    </td>
                    <td style={{ textAlign: 'center', padding: '0.5rem 0.25rem' }} className="text-muted">
                      {player.rebuys}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} className={getProfitColor(player.profit)}>
                      {player.profit >= 0 ? '+' : ''}{formatCurrency(player.profit)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          
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
                  <>Counted ₪{cleanNumber(chipGap)} more than expected (extra chips)</>
                ) : (
                  <>Counted ₪{cleanNumber(Math.abs(chipGap))} less than expected (missing chips)</>
                )}
              </div>
              <div className="text-muted" style={{ fontSize: '0.875rem' }}>
                Adjusted {chipGapPerPlayer && chipGapPerPlayer > 0 ? '-' : '+'}₪{cleanNumber(Math.abs(chipGapPerPlayer || 0))} per player to balance
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
              Payments below ₪{cleanNumber(getSettings().minTransfer)} are not mandatory
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
        
        <div style={{ 
          textAlign: 'center', 
          marginTop: '1rem', 
          fontSize: '0.75rem', 
          color: 'var(--text-muted)',
          opacity: 0.7
        }}>
          Poker Manager 🎲
        </div>
      </div>

      {/* Action buttons - outside the screenshot area */}
      <div className="actions mt-3">
        <button className="btn btn-secondary btn-lg" onClick={() => navigate('/')}>
          🏠 Home
        </button>
        <button 
          className="btn btn-primary btn-lg" 
          onClick={handleShare}
          disabled={isSharing}
        >
          {isSharing ? '📸 Capturing...' : '📤 Share'}
        </button>
      </div>
    </div>
  );
};

export default GameSummaryScreen;

