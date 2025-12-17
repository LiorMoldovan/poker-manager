import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import html2canvas from 'html2canvas';
import { GamePlayer, Settlement, SkippedTransfer } from '../types';
import { getGame, getGamePlayers, getSettings, getChipValues } from '../database/storage';
import { calculateSettlement, formatCurrency, getProfitColor, cleanNumber } from '../utils/calculations';

const GameDetailsScreen = () => {
  const { gameId } = useParams<{ gameId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const cameFromRecords = (location.state as { from?: string })?.from === 'records';
  const [players, setPlayers] = useState<GamePlayer[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [skippedTransfers, setSkippedTransfers] = useState<SkippedTransfer[]>([]);
  const [gameDate, setGameDate] = useState('');
  const [chipGap, setChipGap] = useState<number | null>(null);
  const [chipGapPerPlayer, setChipGapPerPlayer] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [gameNotFound, setGameNotFound] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const summaryRef = useRef<HTMLDivElement>(null);

  // Calculate total chips for a player (same as GameSummaryScreen)
  const getTotalChips = (player: GamePlayer): number => {
    // First try to calculate from chipCounts
    if (player.chipCounts && Object.keys(player.chipCounts).length > 0) {
      const chipValues = getChipValues();
      let total = 0;
      for (const [chipId, count] of Object.entries(player.chipCounts)) {
        const chip = chipValues.find(c => c.id === chipId);
        if (chip) {
          total += count * chip.value;
        }
      }
      if (total > 0) return total;
    }
    // Fallback to finalValue
    return player.finalValue;
  };

  // Format chips for display
  const formatChips = (value: number): string => {
    if (value <= 0) return '0';
    if (value >= 1000) return `${Math.round(value / 1000)}k`;
    return Math.round(value).toString();
  };

  useEffect(() => {
    if (gameId) {
      loadData();
    } else {
      setGameNotFound(true);
      setIsLoading(false);
    }
  }, [gameId]);

  const loadData = () => {
    if (!gameId) {
      setGameNotFound(true);
      setIsLoading(false);
      return;
    }
    const game = getGame(gameId);
    const gamePlayers = getGamePlayers(gameId);
    
    if (!game || gamePlayers.length === 0) {
      setGameNotFound(true);
      setIsLoading(false);
      return;
    }
    
    const settings = getSettings();
    
    setGameDate(game.date);
    setChipGap(game.chipGap || null);
    setChipGapPerPlayer(game.chipGapPerPlayer || null);
    
    setPlayers(gamePlayers.sort((a, b) => b.profit - a.profit));
    
    const { settlements: settl, smallTransfers: small } = calculateSettlement(
      gamePlayers, 
      settings.minTransfer
    );
    setSettlements(settl);
    setSkippedTransfers(small);
    setIsLoading(false);
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="fade-in" style={{ textAlign: 'center', padding: '3rem' }}>
        <div style={{ fontSize: '2rem', marginBottom: '1rem' }}>🃏</div>
        <p className="text-muted">Loading game...</p>
      </div>
    );
  }

  // Game not found
  if (gameNotFound) {
    return (
      <div className="fade-in" style={{ textAlign: 'center', padding: '3rem' }}>
        <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>😕</div>
        <h2 style={{ marginBottom: '0.5rem' }}>Game Not Found</h2>
        <p className="text-muted" style={{ marginBottom: '1.5rem' }}>This game may have been deleted or doesn't exist.</p>
        <button className="btn btn-primary" onClick={() => navigate('/history')}>Go to History</button>
      </div>
    );
  }

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

  return (
    <div className="fade-in">
      <button 
        className="btn btn-sm btn-secondary mb-2"
        onClick={() => cameFromRecords ? navigate('/statistics') : navigate('/history')}
      >
        ← {cameFromRecords ? 'Back to Records' : 'Back to History'}
      </button>
      
      {/* Content to be captured for screenshot */}
      <div ref={summaryRef} style={{ padding: '1rem', background: '#1a1a2e', borderRadius: '12px' }}>
        <div className="page-header" style={{ marginBottom: '1rem' }}>
          <h1 className="page-title">🃏 Poker Night</h1>
          <p className="page-subtitle">
            {new Date(gameDate).toLocaleDateString('en-US', { 
              weekday: 'long', 
              month: 'short', 
              day: 'numeric',
              year: 'numeric'
            })}
          </p>
        </div>

        <div className="card" style={{ overflow: 'hidden' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <h2 className="card-title" style={{ margin: 0 }}>Results</h2>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              Total Buyins: <span style={{ color: 'var(--text)', fontWeight: '600' }}>{Math.round(players.reduce((sum, p) => sum + p.rebuys, 0))}</span>
            </div>
          </div>
          <table style={{ fontSize: '0.85rem', width: '100%', tableLayout: 'fixed' }}>
            <thead>
              <tr>
                <th style={{ width: '35%' }}>Player</th>
                <th style={{ textAlign: 'center', width: '18%' }}>Chips</th>
                <th style={{ textAlign: 'center', width: '15%' }}>Buyins</th>
                <th style={{ textAlign: 'right', width: '32%' }}>+/-</th>
              </tr>
            </thead>
            <tbody>
              {players.map((player, index) => (
                <tr key={player.id}>
                  <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {index === 0 && player.profit > 0 && '🥇'}
                    {index === 1 && player.profit > 0 && '🥈'}
                    {index === 2 && player.profit > 0 && '🥉'}
                    {index > 2 || player.profit <= 0 ? '' : ' '}
                    {player.playerName}
                  </td>
                  <td style={{ textAlign: 'center' }} className="text-muted">
                    {formatChips(getTotalChips(player))}
                  </td>
                  <td style={{ textAlign: 'center' }} className="text-muted">
                    {Math.round(player.rebuys)}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} className={getProfitColor(player.profit)}>
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
                  <>Counted ₪{cleanNumber(chipGap)} more than expected</>
                ) : (
                  <>Counted ₪{cleanNumber(Math.abs(chipGap))} less than expected</>
                )}
                {' '}• Adjusted {chipGapPerPlayer && chipGapPerPlayer > 0 ? '-' : '+'}₪{cleanNumber(Math.abs(chipGapPerPlayer || 0))} per player
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
      <div className="actions mt-3" style={{ display: 'flex', justifyContent: 'center', gap: '1rem' }}>
        <button className="btn btn-secondary btn-lg" onClick={() => cameFromRecords ? navigate('/statistics') : navigate('/history')}>
          {cameFromRecords ? '📊 Records' : '📜 History'}
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

export default GameDetailsScreen;

