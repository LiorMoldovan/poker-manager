import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import html2canvas from 'html2canvas';
import { GamePlayer, Settlement, SkippedTransfer, GameForecast, SharedExpense } from '../types';
import { getGame, getGamePlayers, getSettings, getChipValues } from '../database/storage';
import { calculateSettlement, formatCurrency, getProfitColor, cleanNumber, calculateCombinedSettlement } from '../utils/calculations';
import { generateForecastComparison, getGeminiApiKey } from '../utils/geminiAI';

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
  const [forecasts, setForecasts] = useState<GameForecast[]>([]);
  const [forecastComment, setForecastComment] = useState<string | null>(null);
  const [isLoadingComment, setIsLoadingComment] = useState(false);
  const [sharedExpenses, setSharedExpenses] = useState<SharedExpense[]>([]);
  const summaryRef = useRef<HTMLDivElement>(null);
  const settlementsRef = useRef<HTMLDivElement>(null);
  const forecastCompareRef = useRef<HTMLDivElement>(null);
  const expenseSettlementsRef = useRef<HTMLDivElement>(null);

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

  const loadData = async () => {
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
    const sortedPlayers = gamePlayers.sort((a, b) => b.profit - a.profit);
    setPlayers(sortedPlayers);
    
    // Load shared expenses first
    const gameExpenses = game.sharedExpenses || [];
    if (gameExpenses.length > 0) {
      setSharedExpenses(gameExpenses);
    }
    
    // Calculate settlements - use COMBINED if there are expenses
    if (gameExpenses.length > 0) {
      const { settlements: settl, smallTransfers: small } = calculateCombinedSettlement(
        gamePlayers,
        gameExpenses,
        settings.minTransfer
      );
      setSettlements(settl);
      setSkippedTransfers(small);
    } else {
      const { settlements: settl, smallTransfers: small } = calculateSettlement(
        gamePlayers, 
        settings.minTransfer
      );
      setSettlements(settl);
      setSkippedTransfers(small);
    }
    
    // Load forecasts if available
    if (game.forecasts && game.forecasts.length > 0) {
      setForecasts(game.forecasts);
      
      // Generate AI comment about forecast accuracy
      if (getGeminiApiKey()) {
        setIsLoadingComment(true);
        try {
          const comment = await generateForecastComparison(game.forecasts, sortedPlayers);
          setForecastComment(comment);
        } catch (err) {
          console.error('Error generating forecast comment:', err);
        } finally {
          setIsLoadingComment(false);
        }
      }
    }
    
    setIsLoading(false);
  };
  
  // Calculate expense total for display
  const totalExpenseAmount = sharedExpenses.reduce((sum, e) => sum + e.amount, 0);
  
  // Helper to get food role for a player name (for settlement display)
  const getFoodRole = (playerName: string): 'buyer' | 'eater' | null => {
    if (sharedExpenses.length === 0) return null;
    
    // Check if they paid for any food
    const isBuyer = sharedExpenses.some(e => e.paidByName === playerName);
    if (isBuyer) return 'buyer';
    
    // Check if they participated in any food
    const isEater = sharedExpenses.some(e => e.participantNames.includes(playerName));
    if (isEater) return 'eater';
    
    return null;
  };
  
  // Render player name with food icon if applicable
  const renderPlayerWithFoodIcon = (playerName: string) => {
    const role = getFoodRole(playerName);
    if (role === 'buyer') {
      return <>{playerName} <span style={{ fontSize: '1rem' }}>🍕</span></>;
    } else if (role === 'eater') {
      return <>{playerName} <span style={{ fontSize: '0.65rem', opacity: 0.8 }}>🍕</span></>;
    }
    return playerName;
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
      const files: File[] = [];
      
      // Capture the Results section
      const resultsCanvas = await html2canvas(summaryRef.current, {
        backgroundColor: '#1a1a2e',
        scale: 2,
        useCORS: true,
        logging: false,
      });
      
      const resultsBlob = await new Promise<Blob>((resolve) => {
        resultsCanvas.toBlob((b) => resolve(b!), 'image/png', 1.0);
      });
      files.push(new File([resultsBlob], 'poker-results.png', { type: 'image/png' }));
      
      // Capture the Settlements section if it exists
      if (settlementsRef.current && settlements.length > 0) {
        const settlementsCanvas = await html2canvas(settlementsRef.current, {
          backgroundColor: '#1a1a2e',
          scale: 2,
          useCORS: true,
          logging: false,
        });
        
        const settlementsBlob = await new Promise<Blob>((resolve) => {
          settlementsCanvas.toBlob((b) => resolve(b!), 'image/png', 1.0);
        });
        files.push(new File([settlementsBlob], 'poker-settlements.png', { type: 'image/png' }));
      }
      
      // Capture the Forecast vs Reality section if it exists
      if (forecastCompareRef.current && forecasts.length > 0) {
        const forecastCanvas = await html2canvas(forecastCompareRef.current, {
          backgroundColor: '#1a1a2e',
          scale: 2,
          useCORS: true,
          logging: false,
        });
        
        const forecastBlob = await new Promise<Blob>((resolve) => {
          forecastCanvas.toBlob((b) => resolve(b!), 'image/png', 1.0);
        });
        files.push(new File([forecastBlob], 'poker-forecast-vs-reality.png', { type: 'image/png' }));
      }
      
      // Capture the Expense Settlements section if it exists
      if (expenseSettlementsRef.current && sharedExpenses.length > 0) {
        const expenseCanvas = await html2canvas(expenseSettlementsRef.current, {
          backgroundColor: '#1a1a2e',
          scale: 2,
          useCORS: true,
          logging: false,
        });
        
        const expenseBlob = await new Promise<Blob>((resolve) => {
          expenseCanvas.toBlob((b) => resolve(b!), 'image/png', 1.0);
        });
        files.push(new File([expenseBlob], 'poker-expenses.png', { type: 'image/png' }));
      }
      
      // Try native share first (works on mobile)
      if (navigator.share && navigator.canShare({ files })) {
        await navigator.share({
          files,
          title: 'Poker Game Summary',
        });
      } else {
        // Fallback: download all images
        files.forEach((file, index) => {
          const url = URL.createObjectURL(file);
          const a = document.createElement('a');
          a.href = url;
          a.download = file.name;
          a.click();
          URL.revokeObjectURL(url);
        });
        
        // Then open WhatsApp
        const dateStr = new Date(gameDate).toLocaleDateString('en-US', { 
          weekday: 'short', 
          month: 'short', 
          day: 'numeric' 
        });
        const text = `🃏 Poker Night Results - ${dateStr}\n\n(${files.length} images downloaded - attach them to this message)`;
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
      {/* Results Section - for screenshot */}
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

        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <h2 className="card-title" style={{ margin: 0 }}>Results</h2>
            <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              Total Buyins: <span style={{ color: 'var(--text)', fontWeight: '600' }}>{players.reduce((sum, p) => sum + p.rebuys, 0)}</span>
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ fontSize: '0.9rem' }}>
              <thead>
                <tr>
                  <th>Player</th>
                  <th style={{ textAlign: 'center', padding: '0.5rem 0.25rem' }}>Chips</th>
                  <th style={{ textAlign: 'center', padding: '0.5rem 0.25rem' }}>Buyins</th>
                  <th style={{ textAlign: 'right' }}>+/-</th>
                </tr>
              </thead>
              <tbody>
                {players.map((player, index) => (
                  <tr key={player.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {player.playerName}
                      {index === 0 && player.profit > 0 && ' 🥇'}
                      {index === 1 && player.profit > 0 && ' 🥈'}
                      {index === 2 && player.profit > 0 && ' 🥉'}
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

      {/* Settlements Section - for separate screenshot */}
      {settlements.length > 0 && (
        <div ref={settlementsRef} style={{ padding: '1rem', background: '#1a1a2e', marginTop: '-1rem' }}>
          <div className="card">
            <h2 className="card-title mb-2">💸 Settlements {sharedExpenses.length > 0 && <span style={{ fontSize: '0.7rem', color: '#f59e0b' }}>(+ 🍕)</span>}</h2>
            {settlements.map((s, index) => (
              <div key={index} className="settlement-row">
                <span>{renderPlayerWithFoodIcon(s.from)}</span>
                <span className="settlement-arrow">➜</span>
                <span>{renderPlayerWithFoodIcon(s.to)}</span>
                <span className="settlement-amount">{formatCurrency(s.amount)}</span>
              </div>
            ))}
            {sharedExpenses.length > 0 && (
              <div style={{ 
                marginTop: '0.75rem', 
                paddingTop: '0.5rem', 
                borderTop: '1px solid rgba(255,255,255,0.1)',
                fontSize: '0.7rem',
                color: 'var(--text-muted)',
                display: 'flex',
                gap: '1rem',
                justifyContent: 'center'
              }}>
                <span><span style={{ fontSize: '0.9rem' }}>🍕</span> = שילם</span>
                <span><span style={{ fontSize: '0.6rem' }}>🍕</span> = אכל</span>
              </div>
            )}
          </div>

          {skippedTransfers.length > 0 && (
            <div className="card">
              <h2 className="card-title mb-2">💡 Small Amounts</h2>
              <p className="text-muted mb-1" style={{ fontSize: '0.875rem' }}>
                Payments below ₪{cleanNumber(getSettings().minTransfer)} are not mandatory
              </p>
              {skippedTransfers.map((s, index) => (
                <div key={index} className="settlement-row" style={{ opacity: 0.8 }}>
                  <span>{renderPlayerWithFoodIcon(s.from)}</span>
                  <span className="settlement-arrow">➜</span>
                  <span>{renderPlayerWithFoodIcon(s.to)}</span>
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
      )}

      {/* Forecast vs Actual Comparison - for screenshot */}
      {forecasts.length > 0 && (
        <div ref={forecastCompareRef} style={{ padding: '0.75rem', background: '#1a1a2e', marginTop: '-1rem' }}>
          <div className="card" style={{ padding: '0.75rem' }}>
            <h2 className="card-title" style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>🎯 Forecast vs Reality</h2>
            
            {/* Legend - compact */}
            <div style={{ 
              marginBottom: '0.5rem',
              padding: '0.3rem 0.5rem',
              background: 'rgba(100, 100, 100, 0.1)',
              borderRadius: '4px',
              fontSize: '0.65rem',
              color: 'var(--text-muted)',
              display: 'flex',
              justifyContent: 'center',
              gap: '0.75rem'
            }}>
              <span><span style={{ color: 'var(--success)' }}>✓</span> ≤30</span>
              <span><span style={{ color: 'var(--warning)' }}>~</span> 31-60</span>
              <span><span style={{ color: 'var(--danger)' }}>✗</span> &gt;60</span>
            </div>
            
            {/* Compact table - no scroll */}
            <table style={{ 
              width: '100%', 
              fontSize: '0.75rem',
              borderCollapse: 'collapse'
            }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th style={{ textAlign: 'left', padding: '0.3rem 0.2rem', fontSize: '0.7rem' }}>Player</th>
                  <th style={{ textAlign: 'center', padding: '0.3rem 0.2rem', fontSize: '0.7rem' }}>Fcst</th>
                  <th style={{ textAlign: 'center', padding: '0.3rem 0.2rem', fontSize: '0.7rem' }}>Real</th>
                  <th style={{ textAlign: 'center', padding: '0.3rem 0.2rem', fontSize: '0.7rem' }}>Gap</th>
                </tr>
              </thead>
              <tbody>
                {forecasts
                  .sort((a, b) => b.expectedProfit - a.expectedProfit)
                  .map((forecast) => {
                    const actual = players.find(p => p.playerName === forecast.playerName);
                    const actualProfit = actual?.profit || 0;
                    const gap = Math.abs(actualProfit - forecast.expectedProfit);
                    
                    // Accuracy indicator based on gap
                    const getAccuracyIndicator = () => {
                      if (gap <= 30) return { symbol: '✓', color: 'var(--success)' };
                      if (gap <= 60) return { symbol: '~', color: 'var(--warning)' };
                      return { symbol: '✗', color: 'var(--danger)' };
                    };
                    const accuracy = getAccuracyIndicator();
                    
                    return (
                      <tr key={forecast.playerName} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                        <td style={{ padding: '0.25rem 0.2rem', whiteSpace: 'nowrap' }}>
                          <span style={{ color: accuracy.color }}>{accuracy.symbol}</span> {forecast.playerName}
                        </td>
                        <td style={{ 
                          textAlign: 'center',
                          padding: '0.25rem 0.2rem',
                          color: forecast.expectedProfit >= 0 ? 'var(--success)' : 'var(--danger)'
                        }}>
                          {forecast.expectedProfit >= 0 ? '+' : ''}{Math.round(forecast.expectedProfit)}
                        </td>
                        <td style={{ 
                          textAlign: 'center',
                          padding: '0.25rem 0.2rem',
                          color: actualProfit >= 0 ? 'var(--success)' : 'var(--danger)',
                          fontWeight: '600'
                        }}>
                          {actualProfit >= 0 ? '+' : ''}{Math.round(actualProfit)}
                        </td>
                        <td style={{ 
                          textAlign: 'center',
                          padding: '0.25rem 0.2rem',
                          color: accuracy.color
                        }}>
                          {Math.round(gap)}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
            
            {/* AI Summary - always show area */}
            <div style={{ 
              marginTop: '0.5rem', 
              padding: '0.5rem', 
              background: 'rgba(168, 85, 247, 0.1)',
              borderRadius: '6px',
              borderRight: '3px solid #a855f7',
              fontSize: '0.8rem',
              color: 'var(--text)',
              direction: 'rtl',
              textAlign: 'center',
              minHeight: '2rem'
            }}>
              {isLoadingComment && <span style={{ color: '#a855f7' }}>🤖 מסכם...</span>}
              {forecastComment && !isLoadingComment && <span>🤖 {forecastComment}</span>}
              {!forecastComment && !isLoadingComment && <span style={{ color: 'var(--text-muted)' }}>🤖 אין סיכום זמין</span>}
            </div>
          </div>
          
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
      )}

      {/* Shared Expenses Info - separate screenshot (for reference only, settlements are combined) */}
      {sharedExpenses.length > 0 && (
        <div ref={expenseSettlementsRef} style={{ padding: '1rem', background: '#1a1a2e', marginTop: '-1rem' }}>
          <div className="card">
            <h2 className="card-title mb-2">🍕 Shared Expenses</h2>
            
            {/* Expense Summary */}
            <div>
              {sharedExpenses.map(expense => (
                <div key={expense.id} style={{ 
                  padding: '0.5rem', 
                  background: 'rgba(100, 100, 100, 0.1)', 
                  borderRadius: '6px',
                  marginBottom: '0.5rem',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: '600' }}>{expense.description}</span>
                    <span>₪{cleanNumber(expense.amount)}</span>
                  </div>
                  <div className="text-muted" style={{ fontSize: '0.8rem' }}>
                    {expense.paidByName} paid • {expense.participantNames.length} participants • ₪{cleanNumber(expense.amount / expense.participants.length)} each
                  </div>
                </div>
              ))}
            </div>
            
            {/* Total */}
            <div style={{ 
              marginTop: '0.5rem', 
              padding: '0.5rem', 
              background: 'rgba(245, 158, 11, 0.1)', 
              borderRadius: '6px',
              textAlign: 'center',
            }}>
              <span className="text-muted">Total: </span>
              <span style={{ fontWeight: '600', color: '#f59e0b' }}>₪{cleanNumber(totalExpenseAmount)}</span>
            </div>
            
            {/* Note about combined settlements */}
            <div style={{ 
              marginTop: '0.5rem', 
              fontSize: '0.75rem', 
              color: 'var(--text-muted)',
              textAlign: 'center',
              fontStyle: 'italic',
            }}>
              ✓ Included in settlements above (combined with poker)
            </div>
          </div>
          
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
      )}

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

