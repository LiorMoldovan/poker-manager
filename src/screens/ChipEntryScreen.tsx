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

const ChipEntryScreen = () => {
  const { gameId } = useParams<{ gameId: string }>();
  const navigate = useNavigate();
  const [players, setPlayers] = useState<GamePlayer[]>([]);
  const [chipValues, setChipValues] = useState<ChipValue[]>([]);
  const [chipCounts, setChipCounts] = useState<Record<string, Record<string, number>>>({});
  const [rebuyValue, setRebuyValue] = useState(30);
  const [chipsPerRebuy, setChipsPerRebuy] = useState(10000);

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
    <div className="fade-in">
      <div className="page-header">
        <h1 className="page-title">Count Chips</h1>
        <p className="page-subtitle">Enter chip counts for each player</p>
      </div>

      {/* Live Summary Card */}
      <div className="card" style={{ 
        background: isBalanced && totalChipPoints > 0 
          ? 'rgba(34, 197, 94, 0.1)' 
          : totalChipPoints > expectedChipPoints 
            ? 'rgba(239, 68, 68, 0.1)' 
            : 'rgba(255, 255, 255, 0.95)',
        borderLeft: `4px solid ${
          isBalanced && totalChipPoints > 0 
            ? '#22c55e' 
            : totalChipPoints > expectedChipPoints 
              ? '#ef4444' 
              : '#3b82f6'
        }` 
      }}>
        <div className="grid grid-2" style={{ gap: '1.5rem' }}>
          {/* Buy-ins (Expected) */}
          <div style={{ 
            padding: '0.75rem', 
            background: '#e0f2fe', 
            borderRadius: '8px',
            textAlign: 'center',
            border: '1px solid #7dd3fc'
          }}>
            <div style={{ fontSize: '0.8rem', marginBottom: '0.25rem', color: '#0369a1', fontWeight: '700' }}>
              📥 TOTAL BUY-INS
            </div>
            <div style={{ fontSize: '1.6rem', fontWeight: '800', color: '#0c4a6e' }}>
              ₪{cleanNumber(totalBuyIns)}
            </div>
            <div style={{ fontSize: '1.1rem', color: '#0284c7', fontWeight: '700' }}>
              {expectedChipPoints.toLocaleString()} chips
            </div>
            <div style={{ fontSize: '0.8rem', marginTop: '0.25rem', color: '#0369a1' }}>
              {cleanNumber(players.reduce((sum, p) => sum + p.rebuys, 0))} rebuys total
            </div>
          </div>
          
          {/* Counted Chips (Live) */}
          <div style={{ 
            padding: '0.75rem', 
            background: isBalanced && totalChipPoints > 0 
              ? '#dcfce7' 
              : totalChipPoints > expectedChipPoints 
                ? '#fee2e2' 
                : '#f1f5f9', 
            borderRadius: '8px',
            textAlign: 'center',
            border: `1px solid ${
              isBalanced && totalChipPoints > 0 
                ? '#86efac' 
                : totalChipPoints > expectedChipPoints 
                  ? '#fca5a5' 
                  : '#cbd5e1'
            }`
          }}>
            <div style={{ 
              fontSize: '0.8rem', 
              marginBottom: '0.25rem', 
              fontWeight: '700',
              color: isBalanced && totalChipPoints > 0 
                ? '#166534' 
                : totalChipPoints > expectedChipPoints 
                  ? '#b91c1c' 
                  : '#475569'
            }}>
              🔢 CHIPS COUNTED
            </div>
            <div style={{ 
              fontSize: '1.6rem', 
              fontWeight: '800', 
              color: isBalanced && totalChipPoints > 0 
                ? '#166534' 
                : totalChipPoints > expectedChipPoints 
                  ? '#dc2626' 
                  : '#1e293b'
            }}>
              ₪{cleanNumber(totalChipPoints * valuePerChip)}
            </div>
            <div style={{ 
              fontSize: '1.1rem', 
              fontWeight: '700',
              color: isBalanced && totalChipPoints > 0 
                ? '#22c55e' 
                : totalChipPoints > expectedChipPoints 
                  ? '#ef4444' 
                  : '#64748b'
            }}>
              {totalChipPoints.toLocaleString()} chips
            </div>
            <div style={{ fontSize: '0.8rem', marginTop: '0.25rem', color: '#64748b' }}>
              Live count
            </div>
          </div>
        </div>
        
        {/* Difference indicator */}
        {!isBalanced && totalChipPoints > 0 && (
          <div style={{ 
            marginTop: '1rem', 
            padding: '0.5rem', 
            background: totalChipPoints > expectedChipPoints ? 'rgba(239, 68, 68, 0.15)' : 'rgba(245, 158, 11, 0.15)', 
            borderRadius: '6px',
            textAlign: 'center'
          }}>
            <span style={{ color: totalChipPoints > expectedChipPoints ? '#dc2626' : '#b45309', fontWeight: '700' }}>
              {totalChipPoints > expectedChipPoints ? '🔴 Over by: +' : '🟡 Under by: '}
              {Math.abs(totalChipPoints - expectedChipPoints).toLocaleString()} chips 
              ({totalChipPoints > expectedChipPoints ? '+' : '-'}₪{cleanNumber(Math.abs((totalChipPoints - expectedChipPoints) * valuePerChip))})
            </span>
          </div>
        )}
        {isBalanced && totalChipPoints > 0 && (
          <div style={{ 
            marginTop: '1rem', 
            padding: '0.5rem', 
            background: 'rgba(34, 197, 94, 0.2)', 
            borderRadius: '6px',
            textAlign: 'center'
          }}>
            <span style={{ color: '#166534', fontWeight: '700' }}>
              🟢 Chip count matches!
            </span>
          </div>
        )}
      </div>

      {players.map(player => (
        <div key={player.id} className="card">
          <div className="card-header">
            <h3 className="card-title">{player.playerName}</h3>
            <div>
              <span className={getProfitColor(getPlayerProfit(player.id))}>
                {getPlayerProfit(player.id) >= 0 ? '+' : ''}₪{cleanNumber(getPlayerProfit(player.id))}
              </span>
            </div>
          </div>
          
          <div className="text-muted mb-1" style={{ fontSize: '0.875rem' }}>
            {cleanNumber(player.rebuys)} buy-in{player.rebuys !== 1 ? 's' : ''} (₪{cleanNumber(player.rebuys * rebuyValue)} = {cleanNumber(player.rebuys * chipsPerRebuy).toLocaleString()} chips)
          </div>

          <div className="chip-grid">
            {chipValues.map(chip => (
              <div key={chip.id} className="chip-entry-card" style={{ 
                borderLeft: `4px solid ${chip.displayColor}`,
                background: chip.displayColor === '#FFFFFF' ? 'rgba(255,255,255,0.1)' : `${chip.displayColor}15`
              }}>
                <div className="chip-entry-header">
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
          
          <div style={{ textAlign: 'right', marginTop: '0.75rem', fontWeight: '600' }}>
            Chips: {getPlayerChipPoints(player.id).toLocaleString()} = ₪{cleanNumber(getPlayerMoneyValue(player.id))}
          </div>
        </div>
      ))}

      {/* Bottom Summary Counter */}
      <div className="card" style={{ 
        background: isBalanced && totalChipPoints > 0 
          ? '#dcfce7' 
          : totalChipPoints > expectedChipPoints 
            ? '#fee2e2' 
            : '#f8fafc',
        borderLeft: `4px solid ${
          isBalanced && totalChipPoints > 0 
            ? '#22c55e' 
            : totalChipPoints > expectedChipPoints 
              ? '#ef4444' 
              : '#3b82f6'
        }`,
        position: 'sticky',
        bottom: '70px',
        boxShadow: '0 -4px 12px rgba(0,0,0,0.15)'
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
          <div>
            <div style={{ fontSize: '0.75rem', color: '#0369a1', fontWeight: '600' }}>Expected</div>
            <div style={{ fontWeight: '800', color: '#0c4a6e', fontSize: '1.1rem' }}>₪{cleanNumber(totalBuyIns)}</div>
            <div style={{ fontSize: '0.8rem', color: '#0284c7' }}>{expectedChipPoints.toLocaleString()} chips</div>
          </div>
          <div style={{ textAlign: 'center' }}>
            {isBalanced && totalChipPoints > 0 ? (
              <span style={{ color: '#166534', fontWeight: '800', fontSize: '1.3rem' }}>🟢 Match!</span>
            ) : totalChipPoints > 0 ? (
              <div>
                <span style={{ 
                  color: totalChipPoints > expectedChipPoints ? '#dc2626' : '#b45309', 
                  fontWeight: '700',
                  fontSize: '1.1rem'
                }}>
                  {totalChipPoints > expectedChipPoints ? '🔴 +' : '🟡 '}{(totalChipPoints - expectedChipPoints).toLocaleString()}
                </span>
                <div style={{ fontSize: '0.75rem', color: '#64748b' }}>chips diff</div>
              </div>
            ) : (
              <span style={{ color: '#64748b' }}>-</span>
            )}
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ 
              fontSize: '0.75rem', 
              fontWeight: '600',
              color: isBalanced && totalChipPoints > 0 
                ? '#166534' 
                : totalChipPoints > expectedChipPoints 
                  ? '#b91c1c' 
                  : '#475569'
            }}>Counted</div>
            <div style={{ 
              fontWeight: '800', 
              fontSize: '1.1rem',
              color: isBalanced && totalChipPoints > 0 
                ? '#166534' 
                : totalChipPoints > expectedChipPoints 
                  ? '#dc2626' 
                  : '#1e293b'
            }}>
              ₪{cleanNumber(totalChipPoints * valuePerChip)}
            </div>
            <div style={{ 
              fontSize: '0.8rem',
              color: isBalanced && totalChipPoints > 0 
                ? '#22c55e' 
                : totalChipPoints > expectedChipPoints 
                  ? '#ef4444' 
                  : '#64748b'
            }}>{totalChipPoints.toLocaleString()} chips</div>
          </div>
        </div>
      </div>

      <button 
        className="btn btn-primary btn-lg btn-block"
        onClick={handleCalculate}
      >
        🧮 Calculate Results
      </button>
    </div>
  );
};

const getProfitColor = (profit: number): string => {
  if (profit > 0) return 'profit';
  if (profit < 0) return 'loss';
  return 'neutral';
};

export default ChipEntryScreen;

