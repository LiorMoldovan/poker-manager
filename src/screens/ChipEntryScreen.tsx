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
  updateGameChipGap
} from '../database/storage';
import { calculateChipTotal, calculateProfitLoss, cleanNumber } from '../utils/calculations';

// Numpad Modal Component
interface NumpadModalProps {
  isOpen: boolean;
  chipColor: string;
  chipDisplayColor: string;
  currentValue: number;
  onConfirm: (value: number) => void;
  onClose: () => void;
}

const NumpadModal = ({ isOpen, chipColor, chipDisplayColor, currentValue, onConfirm, onClose }: NumpadModalProps) => {
  const [value, setValue] = useState(currentValue.toString());
  
  useEffect(() => {
    if (isOpen) {
      setValue(currentValue.toString());
    }
  }, [isOpen, currentValue]);

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
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '320px' }}>
        <div className="modal-header">
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
        
        <button className="btn btn-primary btn-block" onClick={handleConfirm}>
          ✓ Confirm
        </button>
      </div>
    </div>
  );
};

const ChipEntryScreen = () => {
  const { gameId } = useParams<{ gameId: string }>();
  const navigate = useNavigate();
  const [players, setPlayers] = useState<GamePlayer[]>([]);
  const [chipValues, setChipValues] = useState<ChipValue[]>([]);
  const [chipCounts, setChipCounts] = useState<Record<string, Record<string, number>>>({});
  const [rebuyValue, setRebuyValue] = useState(30);
  const [chipsPerRebuy, setChipsPerRebuy] = useState(10000);
  
  // Numpad state
  const [numpadOpen, setNumpadOpen] = useState(false);
  const [numpadPlayerId, setNumpadPlayerId] = useState('');
  const [numpadChip, setNumpadChip] = useState<ChipValue | null>(null);
  
  // Collapsed players state
  const [collapsedPlayers, setCollapsedPlayers] = useState<Set<string>>(new Set());

  // Value per chip point = rebuyValue / chipsPerRebuy (with fallback to prevent division by zero)
  const valuePerChip = rebuyValue / (chipsPerRebuy || 10000);

  useEffect(() => {
    if (gameId) {
      loadData();
    }
  }, [gameId]);

  const loadData = () => {
    if (!gameId) return;
    const gamePlayers = getGamePlayers(gameId);
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
  };

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

  // Open numpad for a specific chip
  const openNumpad = (playerId: string, chip: ChipValue) => {
    setNumpadPlayerId(playerId);
    setNumpadChip(chip);
    setNumpadOpen(true);
  };

  // Handle numpad confirm
  const handleNumpadConfirm = (value: number) => {
    if (numpadPlayerId && numpadChip) {
      updateChipCount(numpadPlayerId, numpadChip.id, value);
    }
  };

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

  // Toggle player collapsed state
  const togglePlayerCollapse = (playerId: string) => {
    setCollapsedPlayers(prev => {
      const newSet = new Set(prev);
      if (newSet.has(playerId)) {
        newSet.delete(playerId);
      } else {
        newSet.add(playerId);
      }
      return newSet;
    });
  };

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
  
  // Count completed players (those who are collapsed/marked done)
  const completedPlayersCount = players.filter(p => collapsedPlayers.has(p.id)).length;

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
    navigate(`/game-summary/${gameId}`);
  };

  return (
    <div className="fade-in" style={{ paddingBottom: '180px' }}>
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

      {players.map(player => {
        const isCollapsed = collapsedPlayers.has(player.id);
        
        return (
        <div key={player.id} className="card" style={{
          opacity: isCollapsed ? 0.7 : 1,
          transition: 'opacity 0.2s ease'
        }}>
          {/* Collapsible Header */}
          <div 
            className="card-header"
            onClick={() => togglePlayerCollapse(player.id)}
            style={{ cursor: 'pointer', userSelect: 'none' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ 
                display: 'inline-block',
                transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
                transition: 'transform 0.2s ease',
                fontSize: '0.75rem',
                color: 'var(--text-muted)'
              }}>
                ▼
              </span>
              <h3 className="card-title" style={{ margin: 0 }}>{player.playerName}</h3>
              {isCollapsed && (
                <span style={{ 
                  background: '#22c55e', 
                  color: 'white', 
                  fontSize: '0.65rem', 
                  padding: '0.15rem 0.4rem', 
                  borderRadius: '4px',
                  fontWeight: '600'
                }}>
                  ✓ Done
                </span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <span className="text-muted" style={{ fontSize: '0.875rem' }}>
                {getPlayerChipPoints(player.id).toLocaleString()} chips
              </span>
              <span className={getProfitColor(getPlayerProfit(player.id))}>
                {getPlayerProfit(player.id) >= 0 ? '+' : ''}₪{cleanNumber(getPlayerProfit(player.id))}
              </span>
            </div>
          </div>
          
          {/* Collapsible Content */}
          {!isCollapsed && (
            <>
              <div className="text-muted mb-1" style={{ fontSize: '0.875rem' }}>
                {cleanNumber(player.rebuys)} buy-in{player.rebuys !== 1 ? 's' : ''} (₪{cleanNumber(player.rebuys * rebuyValue)} = {cleanNumber(player.rebuys * chipsPerRebuy).toLocaleString()} chips)
              </div>

              <div className="chip-grid">
            {chipValues.map(chip => (
              <div key={chip.id} className="chip-entry-card" style={{ 
                borderLeft: `4px solid ${chip.displayColor}`,
                background: chip.displayColor === '#FFFFFF' ? 'rgba(255,255,255,0.1)' : `${chip.displayColor}15`
              }}>
                <div 
                  className="chip-entry-header"
                  onClick={() => openNumpad(player.id, chip)}
                  style={{ cursor: 'pointer' }}
                  title="Tap to enter with numpad"
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
                    onClick={() => updateChipCount(
                      player.id, 
                      chip.id, 
                      (chipCounts[player.id]?.[chip.id] || 0) - 1
                    )}
                  >
                    −
                  </button>
                  <input
                    type="number"
                    className="chip-count-input"
                    value={chipCounts[player.id]?.[chip.id] || 0}
                    onChange={e => updateChipCount(player.id, chip.id, parseInt(e.target.value) || 0)}
                    onClick={() => openNumpad(player.id, chip)}
                    readOnly
                    style={{ cursor: 'pointer' }}
                    min="0"
                  />
                  <button 
                    className="chip-btn chip-btn-plus"
                    onClick={() => updateChipCount(
                      player.id, 
                      chip.id, 
                      (chipCounts[player.id]?.[chip.id] || 0) + 1
                    )}
                  >
                    +
                  </button>
                </div>
              </div>
            ))}
          </div>
          
          <div style={{ 
                display: 'flex', 
                justifyContent: 'space-between', 
                alignItems: 'center',
                marginTop: '0.75rem',
                paddingTop: '0.75rem',
                borderTop: '1px solid var(--border)'
              }}>
                <span style={{ fontWeight: '600' }}>
                  {getPlayerChipPoints(player.id).toLocaleString()} chips = ₪{cleanNumber(getPlayerMoneyValue(player.id))}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    togglePlayerCollapse(player.id);
                  }}
                  style={{
                    background: '#22c55e',
                    color: 'white',
                    border: 'none',
                    padding: '0.5rem 1rem',
                    borderRadius: '8px',
                    fontWeight: '600',
                    fontSize: '0.875rem',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.25rem'
                  }}
                >
                  ✓ Done
                </button>
              </div>
            </>
          )}
        </div>
        );
      })}

      {/* Fixed Bottom Progress Bar */}
      <div style={{ 
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 200,
        background: 'var(--background)',
        padding: '0.75rem 1rem',
        boxShadow: '0 -4px 20px rgba(0,0,0,0.2)',
        borderTop: `3px solid ${getProgressColor(progressPercentage)}`
      }}>
        {/* Progress bar */}
        <div style={{
          height: '12px',
          background: 'rgba(0,0,0,0.15)',
          borderRadius: '6px',
          overflow: 'hidden',
          marginBottom: '0.5rem'
        }}>
          <div style={{
            height: '100%',
            width: `${Math.min(progressPercentage, 100)}%`,
            background: getProgressColor(progressPercentage),
            borderRadius: '6px',
            transition: 'width 0.3s ease, background 0.5s ease'
          }} />
        </div>
        
        {/* Stats row */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: '0.8rem' }}>
            <span style={{ color: 'var(--text-muted)' }}>{completedPlayersCount}/{players.length} done</span>
          </div>
          
          <div style={{ textAlign: 'center' }}>
            {isBalanced && totalChipPoints > 0 ? (
              <span style={{ color: '#166534', fontWeight: '700', fontSize: '1rem' }}>✓ Balanced!</span>
            ) : totalChipPoints > 0 ? (
              <span style={{ 
                color: totalChipPoints > expectedChipPoints ? '#dc2626' : '#b45309', 
                fontWeight: '700',
                fontSize: '0.9rem'
              }}>
                {totalChipPoints > expectedChipPoints 
                  ? `+${(totalChipPoints - expectedChipPoints).toLocaleString()} over` 
                  : `${(expectedChipPoints - totalChipPoints).toLocaleString()} left`}
              </span>
            ) : (
              <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Start counting</span>
            )}
          </div>
          
          <div style={{ fontSize: '0.8rem', textAlign: 'right' }}>
            <span style={{ 
              fontWeight: '700',
              color: isBalanced && totalChipPoints > 0 
                ? '#166534' 
                : totalChipPoints > expectedChipPoints 
                  ? '#dc2626' 
                  : 'var(--text)'
            }}>
              {totalChipPoints.toLocaleString()}/{expectedChipPoints.toLocaleString()}
            </span>
          </div>
        </div>
        
        {/* Calculate button */}
        <button 
          className="btn btn-primary btn-block"
          onClick={handleCalculate}
          style={{ marginTop: '0.5rem', padding: '0.75rem' }}
        >
          🧮 Calculate Results
        </button>
      </div>

      {/* Numpad Modal */}
      <NumpadModal
        isOpen={numpadOpen}
        chipColor={numpadChip?.color || ''}
        chipDisplayColor={numpadChip?.displayColor || '#3B82F6'}
        currentValue={numpadPlayerId && numpadChip ? (chipCounts[numpadPlayerId]?.[numpadChip.id] || 0) : 0}
        onConfirm={handleNumpadConfirm}
        onClose={() => setNumpadOpen(false)}
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

