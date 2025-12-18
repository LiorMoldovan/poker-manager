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
  const [isLoading, setIsLoading] = useState(true);
  const [gameNotFound, setGameNotFound] = useState(false);
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
    
    setRebuyValue(settings.rebuyValue);
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
        <p className="text-muted">Loading summary...</p>
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
        <button className="btn btn-primary" onClick={() => navigate('/')}>Go Home</button>
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
      {/* Content to be captured for screenshot */}
      <div ref={summaryRef} style={{ padding: '1rem', background: '#1a1a2e' }}>
        <div className="page-header" style={{ textAlign: 'center', marginBottom: '0.75rem' }}>
          <h1 className="page-title" style={{ fontSize: '1.25rem', marginBottom: '0.25rem' }}>🃏 Poker Night</h1>
          <p className="page-subtitle" style={{ fontSize: '0.85rem', margin: 0 }}>
            {new Date(gameDate).toLocaleDateString('en-US', { 
              weekday: 'long', 
              month: 'short', 
              day: 'numeric',
              year: 'numeric'
            })}
          </p>
        </div>

        {/* Two-column layout for Results and Settlements */}
        <div style={{ display: 'grid', gridTemplateColumns: settlements.length > 0 ? '1fr 1fr' : '1fr', gap: '0.75rem', alignItems: 'start' }}>
          {/* Results Table */}
          <div className="card" style={{ margin: 0, padding: '0.75rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
              <h2 className="card-title" style={{ margin: 0, fontSize: '0.9rem' }}>📊 Results</h2>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                Buyins: <span style={{ color: 'var(--text)', fontWeight: '600' }}>{players.reduce((sum, p) => sum + p.rebuys, 0)}</span>
              </div>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ fontSize: '0.75rem', width: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ padding: '0.3rem 0.25rem' }}>Player</th>
                    <th style={{ textAlign: 'center', padding: '0.3rem 0.15rem' }}>Chips</th>
                    <th style={{ textAlign: 'center', padding: '0.3rem 0.15rem' }}>Buy</th>
                    <th style={{ textAlign: 'right', padding: '0.3rem 0.25rem' }}>+/-</th>
                  </tr>
                </thead>
                <tbody>
                  {players.map((player, index) => (
                    <tr key={player.id}>
                      <td style={{ whiteSpace: 'nowrap', padding: '0.3rem 0.25rem' }}>
                        {index === 0 && player.profit > 0 && '🥇'}
                        {index === 1 && player.profit > 0 && '🥈'}
                        {index === 2 && player.profit > 0 && '🥉'}
                        {index > 2 || player.profit <= 0 ? '' : ' '}
                        {player.playerName}
                      </td>
                      <td style={{ textAlign: 'center', padding: '0.3rem 0.15rem' }} className="text-muted">
                        {(getTotalChips(player) / 1000).toFixed(0)}k
                      </td>
                      <td style={{ textAlign: 'center', padding: '0.3rem 0.15rem' }} className="text-muted">
                        {player.rebuys}
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap', padding: '0.3rem 0.25rem' }} className={getProfitColor(player.profit)}>
                        {player.profit >= 0 ? '+' : ''}{formatCurrency(player.profit)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            
            {chipGap !== null && chipGap !== 0 && (
              <div style={{ 
                marginTop: '0.5rem', 
                padding: '0.5rem', 
                background: 'rgba(245, 158, 11, 0.1)', 
                borderRadius: '6px',
                borderLeft: '2px solid var(--warning)',
                fontSize: '0.7rem'
              }}>
                <div style={{ color: 'var(--warning)', fontWeight: '600' }}>
                  ⚠️ Adjustment: {chipGapPerPlayer && chipGapPerPlayer > 0 ? '-' : '+'}₪{cleanNumber(Math.abs(chipGapPerPlayer || 0))}/player
                </div>
              </div>
            )}
          </div>

          {/* Settlements Table */}
          {settlements.length > 0 && (
            <div className="card" style={{ margin: 0, padding: '0.75rem' }}>
              <h2 className="card-title" style={{ margin: 0, marginBottom: '0.5rem', fontSize: '0.9rem' }}>💸 Settlements</h2>
              {settlements.map((s, index) => (
                <div key={index} style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: '0.3rem', 
                  padding: '0.3rem 0',
                  fontSize: '0.75rem',
                  borderBottom: index < settlements.length - 1 ? '1px solid var(--border)' : 'none'
                }}>
                  <span style={{ flex: 1 }}>{s.from}</span>
                  <span style={{ color: 'var(--text-muted)' }}>→</span>
                  <span style={{ flex: 1 }}>{s.to}</span>
                  <span style={{ fontWeight: '600', color: 'var(--success)' }}>{formatCurrency(s.amount)}</span>
                </div>
              ))}
              
              {skippedTransfers.length > 0 && (
                <div style={{ marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px dashed var(--border)' }}>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                    💡 Below ₪{cleanNumber(getSettings().minTransfer)} (optional)
                  </div>
                  {skippedTransfers.map((s, index) => (
                    <div key={index} style={{ 
                      display: 'flex', 
                      alignItems: 'center', 
                      gap: '0.3rem', 
                      padding: '0.2rem 0',
                      fontSize: '0.7rem',
                      opacity: 0.7
                    }}>
                      <span style={{ flex: 1 }}>{s.from}</span>
                      <span style={{ color: 'var(--text-muted)' }}>→</span>
                      <span style={{ flex: 1 }}>{s.to}</span>
                      <span style={{ color: 'var(--warning)' }}>{formatCurrency(s.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        
        <div style={{ 
          textAlign: 'center', 
          marginTop: '0.75rem', 
          fontSize: '0.65rem', 
          color: 'var(--text-muted)',
          opacity: 0.7
        }}>
          Poker Manager 🎲
        </div>
      </div>

      {/* Action buttons - outside the screenshot area */}
      <div className="actions mt-3" style={{ display: 'flex', justifyContent: 'center', gap: '1rem' }}>
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

