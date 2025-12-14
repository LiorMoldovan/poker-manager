import { useState, useEffect } from 'react';
import { PlayerStats } from '../types';
import { getPlayerStats } from '../database/storage';
import { formatCurrency, getProfitColor, cleanNumber } from '../utils/calculations';

const StatisticsScreen = () => {
  const [stats, setStats] = useState<PlayerStats[]>([]);
  const [viewMode, setViewMode] = useState<'table' | 'records' | 'individual'>('table');
  const [sortBy, setSortBy] = useState<'profit' | 'games' | 'winRate'>('profit');

  useEffect(() => {
    loadStats();
  }, []);

  const loadStats = () => {
    const playerStats = getPlayerStats();
    setStats(playerStats);
  };


  const sortedStats = [...stats].sort((a, b) => {
    switch (sortBy) {
      case 'profit':
        return b.totalProfit - a.totalProfit;
      case 'games':
        return b.gamesPlayed - a.gamesPlayed;
      case 'winRate':
        return b.winPercentage - a.winPercentage;
      default:
        return 0;
    }
  });

  const getMedal = (index: number, value: number) => {
    if (value <= 0) return '';
    if (index === 0) return '🥇 ';
    if (index === 1) return '🥈 ';
    if (index === 2) return '🥉 ';
    return '';
  };

  // Calculate group records
  const getRecords = () => {
    if (stats.length === 0) return null;
    
    const leader = [...stats].sort((a, b) => b.totalProfit - a.totalProfit)[0];
    const biggestLoser = [...stats].sort((a, b) => a.totalProfit - b.totalProfit)[0];
    const biggestWinPlayer = [...stats].sort((a, b) => b.biggestWin - a.biggestWin)[0];
    const biggestLossPlayer = [...stats].sort((a, b) => a.biggestLoss - b.biggestLoss)[0];
    const rebuyKing = [...stats].sort((a, b) => b.totalRebuys - a.totalRebuys)[0];
    
    const qualifiedForWinRate = stats.filter(s => s.gamesPlayed >= 3);
    const sharpshooter = qualifiedForWinRate.length > 0 
      ? [...qualifiedForWinRate].sort((a, b) => b.winPercentage - a.winPercentage)[0]
      : null;
    
    const onFire = [...stats].sort((a, b) => b.currentStreak - a.currentStreak)[0];
    const iceCold = [...stats].sort((a, b) => a.currentStreak - b.currentStreak)[0];
    const mostDedicated = [...stats].sort((a, b) => b.gamesPlayed - a.gamesPlayed)[0];
    const longestWinStreakPlayer = [...stats].sort((a, b) => b.longestWinStreak - a.longestWinStreak)[0];
    const longestLossStreakPlayer = [...stats].sort((a, b) => b.longestLossStreak - a.longestLossStreak)[0];
    
    return {
      leader,
      biggestLoser,
      biggestWinPlayer,
      biggestLossPlayer,
      rebuyKing,
      sharpshooter,
      onFire: onFire.currentStreak > 0 ? onFire : null,
      iceCold: iceCold.currentStreak < 0 ? iceCold : null,
      mostDedicated,
      longestWinStreakPlayer,
      longestLossStreakPlayer,
    };
  };

  const records = getRecords();

  return (
    <div className="fade-in">
      <div className="page-header">
        <h1 className="page-title">Statistics</h1>
        <p className="page-subtitle">Player performance over time</p>
      </div>

      {stats.length === 0 ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-icon">📈</div>
            <p>No statistics yet</p>
            <p className="text-muted">Complete some games to see player stats</p>
          </div>
        </div>
      ) : (
        <>
          {/* View Mode Toggle */}
          <div className="card" style={{ padding: '0.75rem' }}>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button 
                className={`btn btn-sm ${viewMode === 'table' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setViewMode('table')}
                style={{ flex: 1 }}
              >
                📊 Table
              </button>
              <button 
                className={`btn btn-sm ${viewMode === 'records' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setViewMode('records')}
                style={{ flex: 1 }}
              >
                🏆 Records
              </button>
              <button 
                className={`btn btn-sm ${viewMode === 'individual' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setViewMode('individual')}
                style={{ flex: 1 }}
              >
                👤 Players
              </button>
            </div>
          </div>

          {/* RECORDS VIEW */}
          {viewMode === 'records' && records && (
            <>
              {/* Current Streaks */}
              <div className="card">
                <h2 className="card-title mb-2">🔥 Current Streaks</h2>
                <div className="grid grid-2">
                  <div style={{ 
                    padding: '1rem', 
                    background: 'linear-gradient(135deg, rgba(249, 115, 22, 0.2), rgba(239, 68, 68, 0.1))',
                    borderRadius: '12px',
                    textAlign: 'center',
                    border: '1px solid rgba(249, 115, 22, 0.3)'
                  }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>🔥 On Fire</div>
                    {records.onFire ? (
                      <>
                        <div style={{ fontSize: '1.25rem', fontWeight: '700', color: '#f97316' }}>
                          {records.onFire.playerName}
                        </div>
                        <div style={{ fontSize: '0.9rem', color: 'var(--success)' }}>
                          {records.onFire.currentStreak} wins in a row!
                        </div>
                      </>
                    ) : (
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>No active win streak</div>
                    )}
                  </div>
                  <div style={{ 
                    padding: '1rem', 
                    background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.2), rgba(147, 51, 234, 0.1))',
                    borderRadius: '12px',
                    textAlign: 'center',
                    border: '1px solid rgba(59, 130, 246, 0.3)'
                  }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>❄️ Ice Cold</div>
                    {records.iceCold ? (
                      <>
                        <div style={{ fontSize: '1.25rem', fontWeight: '700', color: '#3b82f6' }}>
                          {records.iceCold.playerName}
                        </div>
                        <div style={{ fontSize: '0.9rem', color: 'var(--danger)' }}>
                          {Math.abs(records.iceCold.currentStreak)} losses in a row
                        </div>
                      </>
                    ) : (
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>No active loss streak</div>
                    )}
                  </div>
                </div>
              </div>

              {/* All-Time Leaders */}
              <div className="card">
                <h2 className="card-title mb-2">👑 All-Time Leaders</h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem', background: 'rgba(34, 197, 94, 0.1)', borderRadius: '8px', borderLeft: '4px solid var(--success)' }}>
                    <div>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>🥇 All-Time Leader</span>
                      <div style={{ fontWeight: '700', fontSize: '1.1rem' }}>{records.leader.playerName}</div>
                    </div>
                    <div className="profit" style={{ fontSize: '1.1rem', fontWeight: '700' }}>
                      +{formatCurrency(records.leader.totalProfit)}
                    </div>
                  </div>
                  
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '8px', borderLeft: '4px solid var(--danger)' }}>
                    <div>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>📉 Biggest Loser</span>
                      <div style={{ fontWeight: '700', fontSize: '1.1rem' }}>{records.biggestLoser.playerName}</div>
                    </div>
                    <div className="loss" style={{ fontSize: '1.1rem', fontWeight: '700' }}>
                      {formatCurrency(records.biggestLoser.totalProfit)}
                    </div>
                  </div>
                </div>
              </div>

              {/* Single Game Records */}
              <div className="card">
                <h2 className="card-title mb-2">🎰 Single Game Records</h2>
                <div className="grid grid-2">
                  <div style={{ padding: '0.75rem', background: 'rgba(34, 197, 94, 0.1)', borderRadius: '8px', textAlign: 'center' }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>💰 Biggest Win</div>
                    <div style={{ fontWeight: '700' }}>{records.biggestWinPlayer.playerName}</div>
                    <div className="profit" style={{ fontWeight: '700' }}>+{formatCurrency(records.biggestWinPlayer.biggestWin)}</div>
                  </div>
                  <div style={{ padding: '0.75rem', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '8px', textAlign: 'center' }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>💸 Biggest Loss</div>
                    <div style={{ fontWeight: '700' }}>{records.biggestLossPlayer.playerName}</div>
                    <div className="loss" style={{ fontWeight: '700' }}>{formatCurrency(records.biggestLossPlayer.biggestLoss)}</div>
                  </div>
                </div>
              </div>

              {/* Streak Records */}
              <div className="card">
                <h2 className="card-title mb-2">📈 Streak Records</h2>
                <div className="grid grid-2">
                  <div style={{ padding: '0.75rem', background: 'rgba(34, 197, 94, 0.1)', borderRadius: '8px', textAlign: 'center' }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>🏆 Longest Win Streak</div>
                    <div style={{ fontWeight: '700' }}>{records.longestWinStreakPlayer.playerName}</div>
                    <div style={{ color: 'var(--success)', fontWeight: '700' }}>{records.longestWinStreakPlayer.longestWinStreak} wins</div>
                  </div>
                  <div style={{ padding: '0.75rem', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '8px', textAlign: 'center' }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>💔 Longest Loss Streak</div>
                    <div style={{ fontWeight: '700' }}>{records.longestLossStreakPlayer.playerName}</div>
                    <div style={{ color: 'var(--danger)', fontWeight: '700' }}>{records.longestLossStreakPlayer.longestLossStreak} losses</div>
                  </div>
                </div>
              </div>

              {/* Other Records */}
              <div className="card">
                <h2 className="card-title mb-2">🎖️ Other Records</h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ color: 'var(--text-muted)' }}>🎮 Most Games</span>
                    <span style={{ fontWeight: '600' }}>{records.mostDedicated.playerName} ({records.mostDedicated.gamesPlayed})</span>
                  </div>
                  {records.sharpshooter && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                      <span style={{ color: 'var(--text-muted)' }}>🎯 Best Win Rate (3+ games)</span>
                      <span style={{ fontWeight: '600' }}>{records.sharpshooter.playerName} ({records.sharpshooter.winPercentage.toFixed(0)}%)</span>
                    </div>
                  )}
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem 0' }}>
                    <span style={{ color: 'var(--text-muted)' }}>🎰 Rebuy King</span>
                    <span style={{ fontWeight: '600' }}>{records.rebuyKing.playerName} ({records.rebuyKing.totalRebuys} total)</span>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* TABLE/INDIVIDUAL Sort Options */}
          {(viewMode === 'table' || viewMode === 'individual') && (
            <div className="card" style={{ padding: '0.75rem' }}>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>Sort by</div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button 
                  className={`btn btn-sm ${sortBy === 'profit' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setSortBy('profit')}
                >
                  💰 Profit
                </button>
                <button 
                  className={`btn btn-sm ${sortBy === 'games' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setSortBy('games')}
                >
                  🎮 Games
                </button>
                <button 
                  className={`btn btn-sm ${sortBy === 'winRate' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setSortBy('winRate')}
                >
                  📊 Win Rate
                </button>
              </div>
            </div>
          )}

          {/* TABLE VIEW */}
          {viewMode === 'table' && (
            <div className="card" style={{ padding: '0.75rem' }}>
              <table style={{ width: '100%', fontSize: '0.85rem' }}>
                <thead>
                  <tr>
                    <th style={{ padding: '0.4rem 0.25rem', width: '30px' }}>#</th>
                    <th style={{ padding: '0.4rem 0.25rem' }}>Player</th>
                    <th style={{ textAlign: 'right', padding: '0.4rem 0.25rem' }}>Profit</th>
                    <th style={{ textAlign: 'center', padding: '0.4rem 0.25rem', width: '45px' }}>Games</th>
                    <th style={{ textAlign: 'center', padding: '0.4rem 0.25rem', width: '45px' }}>Win%</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedStats.map((player, index) => (
                    <tr key={player.playerId}>
                      <td style={{ padding: '0.4rem 0.25rem', whiteSpace: 'nowrap' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.15rem' }}>
                          {getMedal(index, sortBy === 'profit' ? player.totalProfit : 
                            sortBy === 'games' ? player.gamesPlayed : player.winPercentage)}{index + 1}
                        </span>
                      </td>
                      <td style={{ fontWeight: '600', padding: '0.4rem 0.25rem' }}>{player.playerName}</td>
                      <td style={{ textAlign: 'right', fontWeight: '700', padding: '0.4rem 0.25rem' }} className={getProfitColor(player.totalProfit)}>
                        {player.totalProfit >= 0 ? '+' : ''}₪{cleanNumber(player.totalProfit)}
                      </td>
                      <td style={{ textAlign: 'center', padding: '0.4rem 0.25rem' }}>{player.gamesPlayed}</td>
                      <td style={{ 
                        textAlign: 'center',
                        padding: '0.4rem 0.25rem',
                        color: player.winPercentage >= 50 ? 'var(--success)' : 'var(--danger)',
                        fontWeight: '600'
                      }}>
                        {player.winPercentage.toFixed(0)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* INDIVIDUAL VIEW */}
          {viewMode === 'individual' && sortedStats.map((player, index) => (
            <div key={player.playerId} className="card">
              <div className="card-header">
                <h3 className="card-title">
                  {getMedal(index, sortBy === 'profit' ? player.totalProfit : 
                    sortBy === 'games' ? player.gamesPlayed : player.winPercentage)}
                  {player.playerName}
                </h3>
                <span className={getProfitColor(player.totalProfit)} style={{ fontSize: '1.25rem', fontWeight: '700' }}>
                  {player.totalProfit >= 0 ? '+' : ''}{formatCurrency(player.totalProfit)}
                </span>
              </div>

              {/* Current Streak Badge */}
              {player.currentStreak !== 0 && (
                <div style={{ 
                  display: 'inline-block',
                  marginBottom: '0.75rem',
                  padding: '0.35rem 0.75rem',
                  borderRadius: '20px',
                  fontSize: '0.8rem',
                  fontWeight: '600',
                  background: player.currentStreak > 0 
                    ? 'linear-gradient(135deg, rgba(249, 115, 22, 0.3), rgba(234, 88, 12, 0.2))' 
                    : 'linear-gradient(135deg, rgba(59, 130, 246, 0.3), rgba(37, 99, 235, 0.2))',
                  color: player.currentStreak > 0 ? '#f97316' : '#3b82f6',
                  border: `1px solid ${player.currentStreak > 0 ? 'rgba(249, 115, 22, 0.4)' : 'rgba(59, 130, 246, 0.4)'}`
                }}>
                  {player.currentStreak > 0 ? '🔥' : '❄️'} {Math.abs(player.currentStreak)} {player.currentStreak > 0 ? 'wins' : 'losses'} in a row
                </div>
              )}

              {/* Last 5 Games */}
              {player.lastFiveResults && player.lastFiveResults.length > 0 && (
                <div style={{ marginBottom: '0.75rem' }}>
                  <div className="text-muted" style={{ fontSize: '0.7rem', marginBottom: '0.35rem' }}>Last {player.lastFiveResults.length} games</div>
                  <div style={{ display: 'flex', gap: '0.35rem' }}>
                    {player.lastFiveResults.map((result, i) => (
                      <div 
                        key={i}
                        style={{
                          width: '32px',
                          height: '32px',
                          borderRadius: '6px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '0.9rem',
                          fontWeight: '700',
                          background: result > 0 ? 'rgba(34, 197, 94, 0.2)' : result < 0 ? 'rgba(239, 68, 68, 0.2)' : 'rgba(156, 163, 175, 0.2)',
                          color: result > 0 ? 'var(--success)' : result < 0 ? 'var(--danger)' : 'var(--text-muted)',
                          border: `1px solid ${result > 0 ? 'var(--success)' : result < 0 ? 'var(--danger)' : 'var(--border)'}`
                        }}
                      >
                        {result > 0 ? 'W' : result < 0 ? 'L' : '-'}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid grid-4">
                <div className="stat-card">
                  <div className="stat-value">{player.gamesPlayed}</div>
                  <div className="stat-label">Games</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value" style={{ color: player.winPercentage >= 50 ? 'var(--success)' : 'var(--danger)' }}>
                    {player.winPercentage.toFixed(0)}%
                  </div>
                  <div className="stat-label">Win Rate</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value profit">+₪{cleanNumber(player.biggestWin)}</div>
                  <div className="stat-label">Best Win</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value loss">-₪{cleanNumber(Math.abs(player.biggestLoss))}</div>
                  <div className="stat-label">Worst Loss</div>
                </div>
              </div>
              
              {/* Streak Records */}
              <div className="grid grid-2 mt-1">
                <div style={{ 
                  padding: '0.5rem', 
                  background: 'rgba(249, 115, 22, 0.1)', 
                  borderRadius: '8px',
                  textAlign: 'center'
                }}>
                  <div className="text-muted" style={{ fontSize: '0.75rem' }}>🏅 Best Streak</div>
                  <div style={{ fontWeight: '600', color: 'var(--success)' }}>{player.longestWinStreak} wins</div>
                </div>
                <div style={{ 
                  padding: '0.5rem', 
                  background: 'rgba(59, 130, 246, 0.1)', 
                  borderRadius: '8px',
                  textAlign: 'center'
                }}>
                  <div className="text-muted" style={{ fontSize: '0.75rem' }}>💔 Worst Streak</div>
                  <div style={{ fontWeight: '600', color: 'var(--danger)' }}>{player.longestLossStreak} losses</div>
                </div>
              </div>
            </div>
          ))}

          </>
      )}
    </div>
  );
};

export default StatisticsScreen;

