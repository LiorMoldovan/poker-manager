import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { GamePlayer, ChipValue } from '../types';
import { 
  getGamePlayers, 
  getChipValues, 
  getSettings,
  updateGamePlayerChips,
  updateGamePlayerResults,
  updateGameStatus,
  updateGameChipGap,
  createGameEndBackup
} from '../database/storage';
import { syncToCloud } from '../database/githubSync';
import { calculateChipTotal, calculateProfitLoss, cleanNumber } from '../utils/calculations';
import { usePermissions } from '../App';

// Numpad Modal Component with auto-advance
interface NumpadModalProps {
  isOpen: boolean;
  playerName: string;
  chipColor: string;
  chipDisplayColor: string;
  currentValue: number;
  onConfirm: (value: number) => void;
  onClose: () => void;
  // Auto-advance props
  chipIndex: number;
  totalChips: number;
  nextChipColor?: string;
  nextChipDisplayColor?: string;
  isLastChip: boolean;
}

const NumpadModal = ({ 
  isOpen, 
  playerName,
  chipColor, 
  chipDisplayColor, 
  currentValue, 
  onConfirm, 
  onClose,
  chipIndex,
  totalChips,
  nextChipColor,
  nextChipDisplayColor,
  isLastChip
}: NumpadModalProps) => {
  const [value, setValue] = useState(currentValue.toString());
  
  useEffect(() => {
    if (isOpen) {
      setValue(currentValue.toString());
    }
  }, [isOpen, currentValue, chipColor]); // Reset when chip changes

  if (!isOpen) return null;

  const handleKey = (key: string) => {
    if (key === 'C') {
      setValue('0');
    } else if (key === '⌫') {
      setValue(prev => prev.length > 1 ? prev.slice(0, -1) : '0');
    } else {
      setValue(prev => prev === '0' ? key : prev + key);
    }
  };

  const handleConfirm = () => {
    onConfirm(parseInt(value) || 0);
    // Don't close - parent handles advancing to next chip
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '320px' }}>
        {/* Player name header */}
        <div style={{
          background: 'var(--primary)',
          margin: '-1.5rem -1.5rem 1rem -1.5rem',
          padding: '0.75rem 1.5rem',
          borderRadius: '16px 16px 0 0',
          textAlign: 'center'
        }}>
          <span style={{ 
            color: 'white', 
            fontWeight: '700', 
            fontSize: '1.1rem'
          }}>
            {playerName}
          </span>
        </div>
        
        <div className="modal-header" style={{ marginBottom: '0.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div 
              style={{ 
                width: '24px', 
                height: '24px', 
                borderRadius: '50%', 
                backgroundColor: chipDisplayColor,
                border: chipDisplayColor === '#FFFFFF' || chipDisplayColor === '#EAB308' ? '2px solid #888' : 'none'
              }} 
            />
            <h3 className="modal-title">{chipColor} Chips</h3>
          </div>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        
        {/* Progress indicator */}
        <div style={{ 
          display: 'flex', 
          justifyContent: 'center', 
          gap: '0.35rem', 
          marginBottom: '0.75rem' 
        }}>
          {Array.from({ length: totalChips }).map((_, i) => (
            <div
              key={i}
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: i < chipIndex ? 'var(--success)' : i === chipIndex ? 'var(--primary)' : 'var(--border)',
                transition: 'background 0.2s ease'
              }}
            />
          ))}
        </div>
        
        <div style={{ 
          fontSize: '2.5rem', 
          fontWeight: '700', 
          textAlign: 'center', 
          padding: '1rem',
          background: 'var(--surface)',
          borderRadius: '8px',
          marginBottom: '1rem',
          fontFamily: 'monospace'
        }}>
          {value}
        </div>
        
        <div style={{ 
          display: 'grid', 
          gridTemplateColumns: 'repeat(3, 1fr)', 
          gap: '0.5rem',
          marginBottom: '1rem'
        }}>
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map(key => (
            <button
              key={key}
              onClick={() => handleKey(key)}
              style={{
                padding: '1rem',
                fontSize: '1.5rem',
                fontWeight: '600',
                borderRadius: '8px',
                border: 'none',
                background: key === 'C' ? 'var(--danger)' : key === '⌫' ? 'var(--warning)' : 'var(--surface)',
                color: key === 'C' || key === '⌫' ? 'white' : 'var(--text)',
                cursor: 'pointer'
              }}
            >
              {key}
            </button>
          ))}
        </div>
        
        {/* Confirm button - shows what's next */}
        <button 
          className="btn btn-primary btn-block" 
          onClick={handleConfirm}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.5rem'
          }}
        >
          {isLastChip ? (
            <>✓ Done with Player</>
          ) : (
            <>
              Next →
              {nextChipDisplayColor && (
                <div 
                  style={{ 
                    width: '16px', 
                    height: '16px', 
                    borderRadius: '50%', 
                    backgroundColor: nextChipDisplayColor,
                    border: nextChipDisplayColor === '#FFFFFF' || nextChipDisplayColor === '#EAB308' ? '2px solid #888' : 'none'
                  }} 
                />
              )}
              {nextChipColor}
            </>
          )}
        </button>
      </div>
    </div>
  );
};

const ChipEntryScreen = () => {
  const { gameId } = useParams<{ gameId: string }>();
  const navigate = useNavigate();
  const { role } = usePermissions();
  const [players, setPlayers] = useState<GamePlayer[]>([]);
  const [chipValues, setChipValues] = useState<ChipValue[]>([]);
  const [chipCounts, setChipCounts] = useState<Record<string, Record<string, number>>>({});
  const [rebuyValue, setRebuyValue] = useState(30);
  const [chipsPerRebuy, setChipsPerRebuy] = useState(10000);
  const [isLoading, setIsLoading] = useState(true);
  const [gameNotFound, setGameNotFound] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  
  // Numpad state - track by chip index for auto-advance
  const [numpadOpen, setNumpadOpen] = useState(false);
  const [numpadPlayerId, setNumpadPlayerId] = useState('');
  const [numpadChipIndex, setNumpadChipIndex] = useState(0); // Track chip by index for auto-advance
  
  // Player selector state
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
  const [completedPlayers, setCompletedPlayers] = useState<Set<string>>(new Set());

  // Value per chip point = rebuyValue / chipsPerRebuy (with fallback to prevent division by zero)
  const valuePerChip = rebuyValue / (chipsPerRebuy || 10000);

  // Get current numpad chip based on index
  const numpadChip = chipValues[numpadChipIndex] || null;
  const nextChip = chipValues[numpadChipIndex + 1] || null;

  useEffect(() => {
    if (gameId) {
      loadData();
    } else {
      setGameNotFound(true);
      setIsLoading(false);
    }
  }, [gameId]);

  // Auto-save chip counts to localStorage whenever they change (debounced)
  useEffect(() => {
    if (isLoading || Object.keys(chipCounts).length === 0) return;
    
    // Debounce: save after 500ms of no changes
    const saveTimeout = setTimeout(() => {
      players.forEach(player => {
        const playerChips = chipCounts[player.id] || {};
        // Only save if there are any non-zero chip counts
        if (Object.values(playerChips).some(v => v > 0)) {
          updateGamePlayerChips(player.id, playerChips);
        }
      });
    }, 500);

    return () => clearTimeout(saveTimeout);
  }, [chipCounts, players, isLoading]);

  const loadData = () => {
    if (!gameId) {
      setGameNotFound(true);
      setIsLoading(false);
      return;
    }
    const gamePlayers = getGamePlayers(gameId);
    if (gamePlayers.length === 0) {
      setGameNotFound(true);
      setIsLoading(false);
      return;
    }
    const chips = getChipValues();
    const settings = getSettings();
    
    setPlayers(gamePlayers);
    setChipValues(chips);
    setRebuyValue(settings.rebuyValue || 30);
    setChipsPerRebuy(settings.chipsPerRebuy || 10000);
    
    // Initialize chip counts
    const initialCounts: Record<string, Record<string, number>> = {};
    gamePlayers.forEach(player => {
      initialCounts[player.id] = {};
      chips.forEach(chip => {
        initialCounts[player.id][chip.id] = player.chipCounts[chip.id] || 0;
      });
    });
    setChipCounts(initialCounts);
    
    // Don't auto-select any player - let user choose
    setSelectedPlayerId(null);
    setNumpadOpen(false);  // Ensure numpad is closed
    setIsLoading(false);
  };

  // Mark player as done and return to player selection
  const markPlayerDone = (playerId: string) => {
    setCompletedPlayers(prev => new Set([...prev, playerId]));
    // Close numpad and deselect player - user chooses next
    setNumpadOpen(false);
    setSelectedPlayerId(null);
  };

  // Undo player completion
  const undoPlayerCompletion = (playerId: string) => {
    setCompletedPlayers(prev => {
      const newSet = new Set(prev);
      newSet.delete(playerId);
      return newSet;
    });
    setSelectedPlayerId(playerId);
  };

  // Select a player and auto-open numpad for first chip
  const selectPlayer = (playerId: string) => {
    setSelectedPlayerId(playerId);
    // Auto-open numpad for first chip
    if (chipValues.length > 0) {
      setNumpadPlayerId(playerId);
      setNumpadChipIndex(0);
      setNumpadOpen(true);
    }
  };

  const selectedPlayer = players.find(p => p.id === selectedPlayerId);
  const completedPlayersCount = completedPlayers.size;

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
        <button className="btn btn-primary" onClick={() => navigate('/')}>Go Home</button>
      </div>
    );
  }

  const updateChipCount = (playerId: string, chipId: string, value: number) => {
    const newValue = Math.max(0, value);
    setChipCounts(prev => ({
      ...prev,
      [playerId]: {
        ...prev[playerId],
        [chipId]: newValue,
      },
    }));
  };

  // Open numpad for a specific chip by index
  const openNumpad = (playerId: string, chipIndex: number) => {
    setNumpadPlayerId(playerId);
    setNumpadChipIndex(chipIndex);
    setNumpadOpen(true);
  };

<<<<<<< Updated upstream
  // Handle numpad confirm with auto-advance through chips
  const handleNumpadConfirm = (value: number) => {
    const currentChip = chipValues[numpadChipIndex];
    if (numpadPlayerId && currentChip) {
      updateChipCount(numpadPlayerId, currentChip.id, value);
      
      // Check if this was the last chip
      if (numpadChipIndex >= chipValues.length - 1) {
        // Last chip - mark player as done and return to player selection
        markPlayerDone(numpadPlayerId);
      } else {
        // Advance to next chip (numpad stays open)
        setNumpadChipIndex(numpadChipIndex + 1);
      }
=======
  // Select a player and auto-open numpad for first chip
  const selectPlayer = (playerId: string) => {
    setSelectedPlayerId(playerId);
    // Auto-open numpad for first chip
    if (chipValues.length > 0) {
      setNumpadPlayerId(playerId);
      setNumpadChipIndex(0);
      setNumpadOpen(true);
>>>>>>> Stashed changes
    }
  };

  // Handle numpad confirm with auto-advance
  const handleNumpadConfirm = (value: number) => {
    const currentChip = chipValues[numpadChipIndex];
    if (numpadPlayerId && currentChip) {
      updateChipCount(numpadPlayerId, currentChip.id, value);
      
      // Check if this was the last chip
      if (numpadChipIndex >= chipValues.length - 1) {
        // Last chip - mark player as done and close numpad
        markPlayerDone(numpadPlayerId);
        setNumpadOpen(false);
      } else {
        // Advance to next chip (numpad stays open)
        setNumpadChipIndex(numpadChipIndex + 1);
      }
    }
  };

  // Get current numpad chip
  const numpadChip = chipValues[numpadChipIndex] || null;
  const nextChip = chipValues[numpadChipIndex + 1] || null;

  // Get total chip points for a player
  const getPlayerChipPoints = (playerId: string): number => {
    return calculateChipTotal(chipCounts[playerId] || {}, chipValues);
  };

  // Convert chip points to money value
  const getPlayerMoneyValue = (playerId: string): number => {
    const chipPoints = getPlayerChipPoints(playerId);
    return chipPoints * valuePerChip; // No rounding - keep exact value
  };

  const getPlayerProfit = (playerId: string): number => {
    const player = players.find(p => p.id === playerId);
    if (!player) return 0;
    const moneyValue = getPlayerMoneyValue(playerId);
    return calculateProfitLoss(moneyValue, player.rebuys, rebuyValue);
  };

  const totalBuyIns = players.reduce((sum, p) => sum + p.rebuys * rebuyValue, 0);
  const totalChipPoints = players.reduce((sum, p) => sum + getPlayerChipPoints(p.id), 0);
  const expectedChipPoints = players.reduce((sum, p) => sum + p.rebuys * chipsPerRebuy, 0);
  const isBalanced = totalChipPoints === expectedChipPoints;

  // Calculate progress percentage
  const progressPercentage = expectedChipPoints > 0 
    ? Math.min(100, (totalChipPoints / expectedChipPoints) * 100) 
    : 0;

  // Get gradient color from red (0%) to green (100%)
  // Stays red/orange longer, only turns green near completion
  const getProgressColor = (percentage: number): string => {
    if (totalChipPoints > expectedChipPoints) {
      return '#ef4444'; // Red if over
    }
    // Clamp percentage between 0 and 100
    const p = Math.min(100, Math.max(0, percentage));
    
    // Use power curve to stay red/orange longer
    // 0-60%: red to orange (hue 0-30)
    // 60-90%: orange to yellow (hue 30-60)  
    // 90-100%: yellow to green (hue 60-120)
    let hue: number;
    if (p < 60) {
      hue = (p / 60) * 30; // 0-30 (red to orange)
    } else if (p < 90) {
      hue = 30 + ((p - 60) / 30) * 30; // 30-60 (orange to yellow)
    } else {
      hue = 60 + ((p - 90) / 10) * 60; // 60-120 (yellow to green)
    }
    
    return `hsl(${hue}, 80%, 45%)`;
  };

  const handleCalculate = () => {
    if (!gameId) return;
    
    // Calculate the gap between expected and actual chips (in money terms)
    const totalCountedMoney = players.reduce((sum, p) => sum + getPlayerMoneyValue(p.id), 0);
    const gapInMoney = totalCountedMoney - totalBuyIns; // positive = extra, negative = missing
    const gapPerPlayer = players.length > 0 ? gapInMoney / players.length : 0;
    
    // Save chip counts and calculate results with gap adjustment
    players.forEach(player => {
      const playerChips = chipCounts[player.id] || {};
      updateGamePlayerChips(player.id, playerChips);
      
      const moneyValue = getPlayerMoneyValue(player.id);
      // Calculate base profit, then subtract player's share of the gap
      // If there are extra chips (gap > 0), each player's profit is reduced
      // If chips are missing (gap < 0), each player's loss is reduced (profit increased)
      const baseProfit = calculateProfitLoss(moneyValue, player.rebuys, rebuyValue);
      const adjustedProfit = baseProfit - gapPerPlayer;
      updateGamePlayerResults(player.id, moneyValue, adjustedProfit); // No rounding
    });
    
    // Save gap info to the game
    if (Math.abs(gapInMoney) > 0.01) {
      updateGameChipGap(gameId, gapInMoney, gapPerPlayer); // No rounding
    }
    
    updateGameStatus(gameId, 'completed');
    
    // Create auto backup after game ends
    createGameEndBackup();
    
    // Upload to GitHub if admin
    if (role === 'admin') {
      setUploadStatus('Syncing to cloud...');
      syncToCloud().then(result => {
        if (result.success) {
          setUploadStatus('✅ Synced!');
        } else {
          setUploadStatus('⚠️ Sync failed');
          console.error('Sync failed:', result.message);
        }
        // Navigate after a short delay to show status
        setTimeout(() => navigate(`/game-summary/${gameId}`), 1000);
      });
    } else {
      navigate(`/game-summary/${gameId}`);
    }
  };

  // Upload status overlay
  if (uploadStatus) {
    return (
      <div style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.9)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
      }}>
        <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>
          {uploadStatus.includes('Syncing') ? '☁️' : uploadStatus.includes('✅') ? '✅' : '⚠️'}
        </div>
        <div style={{ fontSize: '1.2rem', color: 'white', fontWeight: '600' }}>
          {uploadStatus}
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in" style={{ paddingBottom: '115px' }}>
      <div className="page-header">
        <h1 className="page-title">Count Chips</h1>
        <p className="page-subtitle">Tap Done when finished with each player</p>
      </div>

      {/* Live Summary Card */}
      <div className="card" style={{ 
        padding: '1rem',
        background: 'var(--surface)'
      }}>
        {/* Main comparison */}
        <div style={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center',
          marginBottom: '0.75rem'
        }}>
          {/* Expected */}
          <div style={{ textAlign: 'left' }}>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: '600', textTransform: 'uppercase' }}>
              Expected
            </div>
            <div style={{ fontSize: '1.5rem', fontWeight: '800', color: 'var(--text)' }}>
              {expectedChipPoints.toLocaleString()}
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              ₪{cleanNumber(totalBuyIns)}
            </div>
          </div>
          
          {/* Arrow/Status */}
          <div style={{ 
            fontSize: '1.5rem',
            color: getProgressColor(progressPercentage)
          }}>
            {isBalanced && totalChipPoints > 0 ? '✓' : '→'}
          </div>
          
          {/* Counted */}
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '0.7rem', color: getProgressColor(progressPercentage), fontWeight: '600', textTransform: 'uppercase' }}>
              Counted
            </div>
            <div style={{ fontSize: '1.5rem', fontWeight: '800', color: getProgressColor(progressPercentage) }}>
              {totalChipPoints.toLocaleString()}
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              ₪{cleanNumber(totalChipPoints * valuePerChip)}
            </div>
          </div>
        </div>
        
        {/* Difference text */}
        <div style={{ 
          textAlign: 'center',
          padding: '0.5rem',
          borderRadius: '8px',
          background: `${getProgressColor(progressPercentage)}15`,
          border: `1px solid ${getProgressColor(progressPercentage)}40`
        }}>
          {totalChipPoints === 0 ? (
            <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              Start counting chips below
            </span>
          ) : isBalanced ? (
            <span style={{ color: getProgressColor(progressPercentage), fontWeight: '700', fontSize: '0.9rem' }}>
              ✓ Balanced!
            </span>
          ) : (
            <span style={{ color: getProgressColor(progressPercentage), fontWeight: '600', fontSize: '0.85rem' }}>
              {totalChipPoints > expectedChipPoints 
                ? `+${(totalChipPoints - expectedChipPoints).toLocaleString()} over` 
                : `${(expectedChipPoints - totalChipPoints).toLocaleString()} remaining`}
            </span>
          )}
        </div>
      </div>

      {/* Player Selector */}
      <div className="card" style={{ padding: '0.75rem' }}>
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem', fontWeight: '600' }}>
          SELECT PLAYER ({completedPlayersCount}/{players.length} done)
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
          {players.map(player => {
            const isCompleted = completedPlayers.has(player.id);
            const isSelected = selectedPlayerId === player.id;
            const chips = getPlayerChipPoints(player.id);
            const profit = getPlayerProfit(player.id);
            
            return (
              <button
                key={player.id}
                onClick={() => isCompleted ? undoPlayerCompletion(player.id) : selectPlayer(player.id)}
                style={{
                  padding: '0.5rem 0.75rem',
                  borderRadius: '20px',
                  border: isSelected ? '2px solid var(--primary)' : isCompleted ? '2px solid #22c55e' : '2px solid var(--border)',
                  background: isCompleted ? 'rgba(34, 197, 94, 0.15)' : isSelected ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  minWidth: '80px',
                  transition: 'all 0.15s ease'
                }}
              >
                <span style={{ 
                  fontWeight: '600', 
                  fontSize: '0.9rem',
                  color: isCompleted ? '#22c55e' : isSelected ? 'var(--primary)' : 'var(--text)'
                }}>
                  {isCompleted && '✓ '}{player.playerName}
                </span>
                {chips > 0 && (
                  <span style={{ 
                    fontSize: '0.7rem', 
                    color: profit >= 0 ? 'var(--success)' : 'var(--danger)',
                    marginTop: '0.15rem'
                  }}>
                    {profit >= 0 ? '+' : ''}₪{cleanNumber(profit)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Selected Player Chip Entry */}
      {selectedPlayer && (
        <div className="card">
          <div className="card-header">
            <h3 className="card-title" style={{ margin: 0 }}>{selectedPlayer.playerName}</h3>
            <span className={getProfitColor(getPlayerProfit(selectedPlayer.id))} style={{ fontWeight: '700' }}>
              {getPlayerProfit(selectedPlayer.id) >= 0 ? '+' : ''}₪{cleanNumber(getPlayerProfit(selectedPlayer.id))}
            </span>
          </div>
          
          <div className="text-muted mb-1" style={{ fontSize: '0.875rem' }}>
            {cleanNumber(selectedPlayer.rebuys)} buy-in{selectedPlayer.rebuys !== 1 ? 's' : ''} (₪{cleanNumber(selectedPlayer.rebuys * rebuyValue)} = {cleanNumber(selectedPlayer.rebuys * chipsPerRebuy).toLocaleString()} chips expected)
          </div>

          {/* Chip Grid */}
          <div className="chip-grid">
            {chipValues.map((chip, chipIndex) => (
              <div key={chip.id} className="chip-entry-card" style={{ 
                borderLeft: `4px solid ${chip.displayColor}`,
                background: chip.displayColor === '#FFFFFF' ? 'rgba(255,255,255,0.1)' : `${chip.displayColor}15`
              }}>
                <div 
                  className="chip-entry-header"
                  onClick={() => openNumpad(selectedPlayer.id, chipIndex)}
                  style={{ cursor: 'pointer' }}
                >
                  <div 
                    className="chip-circle-small" 
                    style={{ 
                      backgroundColor: chip.displayColor,
                      border: chip.displayColor === '#FFFFFF' || chip.displayColor === '#EAB308' ? '2px solid #888' : 'none'
                    }} 
                  />
                  <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>×{chip.value}</span>
                </div>
                <div className="chip-entry-controls">
                  <button 
                    className="chip-btn chip-btn-minus"
                    onClick={() => updateChipCount(selectedPlayer.id, chip.id, (chipCounts[selectedPlayer.id]?.[chip.id] || 0) - 1)}
                  >
                    −
                  </button>
                  <input
                    type="number"
                    className="chip-count-input"
                    value={chipCounts[selectedPlayer.id]?.[chip.id] || 0}
                    onChange={e => updateChipCount(selectedPlayer.id, chip.id, parseInt(e.target.value) || 0)}
                    onClick={() => openNumpad(selectedPlayer.id, chipIndex)}
                    readOnly
                    style={{ cursor: 'pointer' }}
                    min="0"
                  />
                  <button 
                    className="chip-btn chip-btn-plus"
                    onClick={() => updateChipCount(selectedPlayer.id, chip.id, (chipCounts[selectedPlayer.id]?.[chip.id] || 0) + 1)}
                  >
                    +
                  </button>
                </div>
              </div>
            ))}
          </div>
          
          {/* Player Total & Done Button */}
          <div style={{ 
            display: 'flex', 
            justifyContent: 'space-between', 
            alignItems: 'center',
            marginTop: '1rem',
            paddingTop: '1rem',
            borderTop: '1px solid var(--border)'
          }}>
            <div>
              <div style={{ fontWeight: '700', fontSize: '1.1rem' }}>
                {getPlayerChipPoints(selectedPlayer.id).toLocaleString()} chips
              </div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                = ₪{cleanNumber(getPlayerMoneyValue(selectedPlayer.id))}
              </div>
            </div>
            <button
              onClick={() => markPlayerDone(selectedPlayer.id)}
              style={{
                background: 'linear-gradient(135deg, #22c55e, #16a34a)',
                color: 'white',
                border: 'none',
                padding: '0.75rem 1.5rem',
                borderRadius: '12px',
                fontWeight: '700',
                fontSize: '1rem',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                boxShadow: '0 4px 12px rgba(34, 197, 94, 0.3)'
              }}
            >
              ✓ Done
            </button>
          </div>
        </div>
      )}

      {/* All Players Done Message */}
      {!selectedPlayer && completedPlayersCount === players.length && players.length > 0 && (
        <div className="card" style={{ textAlign: 'center', padding: '2rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>🎉</div>
          <h3 style={{ marginBottom: '0.5rem' }}>All Players Counted!</h3>
          <p className="text-muted">Click Calculate Results below to finish</p>
        </div>
      )}

      {/* Fixed Bottom Bar */}
      <div style={{ 
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 200,
        background: 'var(--background)',
        padding: '0.5rem 1rem 0.75rem',
        boxShadow: '0 -4px 20px rgba(0,0,0,0.2)',
        borderTop: `3px solid ${getProgressColor(progressPercentage)}`
      }}>
        {/* Progress bar */}
        <div style={{
          height: '10px',
          background: 'rgba(255,255,255,0.1)',
          borderRadius: '5px',
          overflow: 'hidden',
          marginBottom: '0.5rem'
        }}>
          <div style={{
            height: '100%',
            width: `${Math.min(progressPercentage, 100)}%`,
            background: getProgressColor(progressPercentage),
            borderRadius: '5px',
            transition: 'width 0.3s ease'
          }} />
        </div>
        
        {/* Stats row */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            {completedPlayersCount}/{players.length} done
          </span>
          <span style={{ 
            fontSize: '0.9rem', 
            fontWeight: '700', 
            color: isBalanced && totalChipPoints > 0 ? '#22c55e' : getProgressColor(progressPercentage)
          }}>
            {isBalanced && totalChipPoints > 0 ? '✓ Balanced!' : `${totalChipPoints.toLocaleString()} / ${expectedChipPoints.toLocaleString()}`}
          </span>
          <span style={{ 
            fontSize: '0.8rem', 
            fontWeight: '600',
            color: totalChipPoints > expectedChipPoints ? '#ef4444' : totalChipPoints === expectedChipPoints && totalChipPoints > 0 ? '#22c55e' : '#f59e0b'
          }}>
            {totalChipPoints > expectedChipPoints 
              ? `+${(totalChipPoints - expectedChipPoints).toLocaleString()}` 
              : totalChipPoints === expectedChipPoints && totalChipPoints > 0
                ? '✓'
                : `-${(expectedChipPoints - totalChipPoints).toLocaleString()}`}
          </span>
        </div>
        
        <button 
          className="btn btn-primary btn-block"
          onClick={handleCalculate}
          style={{ padding: '0.6rem' }}
        >
          🧮 Calculate Results
        </button>
      </div>

      {/* Numpad Modal */}
      <NumpadModal
        isOpen={numpadOpen}
        playerName={players.find(p => p.id === numpadPlayerId)?.playerName || ''}
        chipColor={numpadChip?.color || ''}
        chipDisplayColor={numpadChip?.displayColor || '#3B82F6'}
        currentValue={numpadPlayerId && numpadChip ? (chipCounts[numpadPlayerId]?.[numpadChip.id] || 0) : 0}
        onConfirm={handleNumpadConfirm}
        onClose={() => setNumpadOpen(false)}
        chipIndex={numpadChipIndex}
        totalChips={chipValues.length}
        nextChipColor={nextChip?.color}
        nextChipDisplayColor={nextChip?.displayColor}
        isLastChip={numpadChipIndex >= chipValues.length - 1}
      />
    </div>
  );
};

const getProfitColor = (profit: number): string => {
  if (profit > 0) return 'profit';
  if (profit < 0) return 'loss';
  return 'neutral';
};

export default ChipEntryScreen;
<<<<<<< Updated upstream
=======


>>>>>>> Stashed changes
