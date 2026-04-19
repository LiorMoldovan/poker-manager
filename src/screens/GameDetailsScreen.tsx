import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import html2canvas from 'html2canvas';
import { GamePlayer, Settlement, SkippedTransfer, SharedExpense } from '../types';
import { getGame, getGamePlayers, getSettings, getChipValues } from '../database/storage';
import { calculateSettlement, formatCurrency, getProfitColor, cleanNumber, calculateCombinedSettlement } from '../utils/calculations';
import { getComboHistory, ComboHistory } from '../utils/comboHistory';
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh';
import { useTranslation } from '../i18n';

const GameDetailsScreen = () => {
  const { t } = useTranslation();
  const { gameId } = useParams<{ gameId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const locationState = location.state as { 
    from?: string; 
    viewMode?: string;
    recordInfo?: { title: string; playerId: string; recordType: string };
    playerInfo?: { playerId: string; playerName: string };
    timePeriod?: string;
    selectedYear?: number;
  } | null;
  const cameFromRecords = locationState?.from === 'records';
  const cameFromPlayers = locationState?.from === 'players';
  const cameFromTable = locationState?.from === 'statistics';
  const cameFromStatistics = cameFromRecords || cameFromPlayers || cameFromTable;
  const savedViewMode = locationState?.viewMode;
  const savedRecordInfo = locationState?.recordInfo;
  const savedPlayerInfo = locationState?.playerInfo;
  const savedTimePeriod = locationState?.timePeriod;
  const savedSelectedYear = locationState?.selectedYear;
  const [players, setPlayers] = useState<GamePlayer[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [skippedTransfers, setSkippedTransfers] = useState<SkippedTransfer[]>([]);
  const [gameDate, setGameDate] = useState('');
  const [chipGap, setChipGap] = useState<number | null>(null);
  const [chipGapPerPlayer, setChipGapPerPlayer] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [gameNotFound, setGameNotFound] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [sharedExpenses, setSharedExpenses] = useState<SharedExpense[]>([]);
  const [comboHistory, setComboHistory] = useState<ComboHistory | null>(null);
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

  const loadData = useCallback(() => {
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
    
    const sortedPlayers = gamePlayers.sort((a, b) => b.profit - a.profit);
    setPlayers(sortedPlayers);

    // Compute combo history
    const comboPlayerIds = gamePlayers.map(gp => gp.playerId);
    const combo = getComboHistory(comboPlayerIds, gameId);
    setComboHistory(combo);

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
    
    setIsLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId]);

  useEffect(() => {
    window.scrollTo(0, 0);
    if (gameId) {
      loadData();
    } else {
      setGameNotFound(true);
      setIsLoading(false);
    }
  }, [gameId, loadData]);

  useRealtimeRefresh(loadData);
  
  // Calculate expense total
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
        <p className="text-muted">{t('gameDetails.loading')}</p>
      </div>
    );
  }

  // Game not found
  if (gameNotFound) {
    return (
      <div className="fade-in" style={{ textAlign: 'center', padding: '3rem' }}>
        <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>😕</div>
        <h2 style={{ marginBottom: '0.5rem' }}>{t('gameDetails.notFound')}</h2>
        <p className="text-muted" style={{ marginBottom: '1.5rem' }}>{t('gameDetails.notFoundDesc')}</p>
        <button className="btn btn-primary" onClick={() => navigate('/history')}>{t('gameDetails.goToHistory')}</button>
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
        onClick={() => {
          if (cameFromStatistics) {
            navigate('/statistics', { 
              state: { 
                viewMode: savedViewMode, 
                recordInfo: savedRecordInfo,
                playerInfo: savedPlayerInfo,
                timePeriod: savedTimePeriod,
                selectedYear: savedSelectedYear
              } 
            });
          } else {
            navigate('/history');
          }
        }}
      >
        ← {cameFromRecords ? 'Back to Records' : cameFromStatistics ? 'Back to Statistics' : 'Back to History'}
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
                    {player.playerName}
                    {index === 0 && player.profit > 0 && ' 🥇'}
                    {index === 1 && player.profit > 0 && ' 🥈'}
                    {index === 2 && player.profit > 0 && ' 🥉'}
                  </td>
                  <td style={{ textAlign: 'center' }} className="text-muted">
                    {formatChips(getTotalChips(player))}
                  </td>
                  <td style={{ textAlign: 'center' }} className="text-muted">
                    {Math.round(player.rebuys)}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} className={getProfitColor(player.profit)}>
                    {player.profit >= 0 ? '\u200E+' : ''}{formatCurrency(player.profit)}
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
                  <>Counted {cleanNumber(chipGap)} more than expected</>
                ) : (
                  <>Counted {cleanNumber(Math.abs(chipGap))} less than expected</>
                )}
                {' '}• Adjusted {chipGapPerPlayer && chipGapPerPlayer > 0 ? '-' : '+'}{cleanNumber(Math.abs(chipGapPerPlayer || 0))} per player
              </div>
            </div>
          )}
        </div>

        {settlements.length > 0 && (
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
              }}>
                {sharedExpenses.map((expense, idx) => (
                  <div key={idx} style={{ 
                    fontSize: '0.75rem', 
                    color: 'var(--text-muted)',
                    direction: 'rtl',
                    marginBottom: idx < sharedExpenses.length - 1 ? '0.4rem' : 0
                  }}>
                    <div>
                      <span style={{ fontSize: '0.9rem' }}>🍕</span> {expense.description} - {cleanNumber(expense.amount)}
                    </div>
                    <div style={{ marginRight: '1.2rem', fontSize: '0.7rem' }}>
                      {t('gameDetails.expensePaidBy')} <span style={{ color: 'var(--primary)' }}>{expense.paidByName}</span>
                      {' • '}
                      {t('gameDetails.expenseParticipants')} {expense.participantNames.join(', ')}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {skippedTransfers.length > 0 && (
          <div className="card">
            <h2 className="card-title mb-2">💡 Small Amounts</h2>
            <p className="text-muted mb-1" style={{ fontSize: '0.875rem' }}>
              Payments below {cleanNumber(getSettings().minTransfer)} are not mandatory
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

        {/* Shared Expenses Section */}
        {sharedExpenses.length > 0 && (
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
                    <span>{cleanNumber(expense.amount)}</span>
                  </div>
                  <div className="text-muted" style={{ fontSize: '0.8rem' }}>
                    {expense.paidByName} paid • {expense.participantNames.length} participants • {cleanNumber(expense.amount / expense.participants.length)} each
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
              <span style={{ fontWeight: '600', color: '#f59e0b' }}>{cleanNumber(totalExpenseAmount)}</span>
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
        )}
        
        {/* Combo History Section */}
        {comboHistory && !comboHistory.isFirstTime && (
          <div className="card">
            <h2 className="card-title" style={{ marginBottom: '0.75rem' }}>
              {t('gameDetails.returningCombo')}
            </h2>
            <div style={{ direction: 'rtl', textAlign: 'right' }}>
              <div style={{
                fontSize: '0.85rem',
                color: '#fbbf24',
                marginBottom: '0.75rem',
                fontWeight: 600,
              }}>
                אותם {comboHistory.playerCount} שחקנים שיחקו יחד {comboHistory.totalGamesWithCombo + 1} פעמים (כולל הערב)
              </div>

              <div style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.4rem',
                marginBottom: '0.75rem',
              }}>
                {comboHistory.previousGames.map((game, i) => {
                  const dateStr = (() => { try { return new Date(game.date).toLocaleDateString('he-IL', { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return game.date; } })();
                  return (
                    <div key={i} style={{
                      fontSize: '0.78rem',
                      color: '#94a3b8',
                      padding: '0.4rem 0.6rem',
                      borderRadius: '8px',
                      background: 'rgba(255,255,255,0.03)',
                      border: '1px solid rgba(255,255,255,0.06)',
                    }}>
                      <span style={{ color: '#64748b' }}>📅 {dateStr}</span>
                      {' · '}
                      <span style={{ color: '#4ade80' }}>👑 {game.winnerName} ({'\u200E'}+{Math.round(game.winnerProfit)})</span>
                      {' · '}
                      <span style={{ color: '#f87171' }}>💀 {game.loserName} ({'\u200E'}{Math.round(game.loserProfit)})</span>
                    </div>
                  );
                })}
              </div>

              <div style={{
                fontSize: '0.75rem',
                marginBottom: '0.5rem',
                color: '#94a3b8',
                fontWeight: 600,
              }}>
                📊 דירוג שחקנים בהרכב הזה:
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                {comboHistory.playerStats.map((ps, i) => {
                  const isInProfit = ps.totalProfit > 0;
                  const currentGamePlayer = players.find(p => p.playerName === ps.playerName);
                  const tonightProfit = currentGamePlayer?.profit || 0;
                  return (
                    <div key={i} style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      fontSize: '0.78rem',
                      padding: '0.3rem 0.5rem',
                      borderRadius: '6px',
                      background: ps.alwaysWon ? 'rgba(34, 197, 94, 0.08)' : ps.alwaysLost ? 'rgba(239, 68, 68, 0.08)' : 'transparent',
                      borderRight: ps.alwaysWon ? '3px solid rgba(34, 197, 94, 0.5)' : ps.alwaysLost ? '3px solid rgba(239, 68, 68, 0.5)' : '3px solid transparent',
                    }}>
                      <span style={{ color: '#64748b', fontSize: '0.7rem' }}>
                        {ps.wins}/{comboHistory.totalGamesWithCombo} ({Math.round(ps.winRate)}%)
                        {ps.alwaysWon && ' ⭐'}
                        {ps.alwaysLost && ' ⚠️'}
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span style={{
                          fontWeight: 600,
                          color: isInProfit ? 'var(--success)' : 'var(--danger)',
                          fontSize: '0.75rem',
                        }}>
                          {ps.totalProfit >= 0 ? '\u200E+' : '\u200E'}{Math.round(ps.totalProfit)}
                        </span>
                        <span style={{ color: '#e2e8f0', fontWeight: 500 }}>
                          {i === 0 && '👑 '}{ps.playerName}
                        </span>
                        {tonightProfit !== 0 && (
                          <span style={{
                            fontSize: '0.65rem',
                            color: tonightProfit > 0 ? '#4ade80' : '#f87171',
                            opacity: 0.8,
                          }}>
                            (הערב: {tonightProfit >= 0 ? '\u200E+' : '\u200E'}{Math.round(tonightProfit)})
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>

              <div style={{ marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                {comboHistory.uniqueWinners.length === comboHistory.totalGamesWithCombo && comboHistory.totalGamesWithCombo >= 2 && (
                  <div style={{ fontSize: '0.78rem', color: '#a78bfa' }}>
                    🎲 מנצח שונה בכל משחק!
                  </div>
                )}
                {comboHistory.repeatWinners.length > 0 && (
                  <div style={{ fontSize: '0.78rem', color: '#fbbf24' }}>
                    👑 ניצחו יותר מפעם: {comboHistory.repeatWinners.map(w => `${w.name} (${w.count}x)`).join(', ')}
                  </div>
                )}
                {comboHistory.repeatLosers.length > 0 && (
                  <div style={{ fontSize: '0.78rem', color: '#f87171' }}>
                    💀 סיימו אחרונים יותר מפעם: {comboHistory.repeatLosers.map(l => `${l.name} (${l.count}x)`).join(', ')}
                  </div>
                )}
              </div>

              <div style={{ fontSize: '0.72rem', color: '#64748b', marginTop: '0.5rem', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: '0.4rem' }}>
                💰 סה״כ עבר בהרכב: {Math.round(comboHistory.totalMoneyMoved).toLocaleString()} ב-{comboHistory.totalGamesWithCombo} משחקים
              </div>
            </div>
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
        <button className="btn btn-secondary btn-lg" onClick={() => {
          if (cameFromStatistics) {
            navigate('/statistics', { 
              state: { 
                viewMode: savedViewMode, 
                recordInfo: savedRecordInfo,
                playerInfo: savedPlayerInfo,
                timePeriod: savedTimePeriod,
                selectedYear: savedSelectedYear
              } 
            });
          } else {
            navigate('/history');
          }
        }}>
          {cameFromRecords ? '📊 Records' : cameFromStatistics ? '📈 Statistics' : '📜 History'}
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

