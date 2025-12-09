import { useState, useEffect } from 'react';
import { PlayerStats } from '../types';
import { getPlayerStats } from '../database/storage';
import { formatCurrency, getProfitColor } from '../utils/calculations';

const StatisticsScreen = () => {
  const [stats, setStats] = useState<PlayerStats[]>([]);
  const [viewMode, setViewMode] = useState<'table' | 'individual'>('table');
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
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">View</h2>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
              <button 
                className={`btn btn-sm ${viewMode === 'table' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setViewMode('table')}
              >
                📊 Summary Table
              </button>
              <button 
                className={`btn btn-sm ${viewMode === 'individual' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setViewMode('individual')}
              >
                👤 Individual Stats
              </button>
            </div>
            
            {/* Sort Options */}
            <div className="card-header" style={{ marginTop: '0.5rem' }}>
              <h2 className="card-title">Sort by</h2>
            </div>
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

          {/* TABLE VIEW */}
          {viewMode === 'table' && (
            <div className="card">
              <h2 className="card-title mb-2">📋 All Players Summary</h2>
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Player</th>
                      <th style={{ textAlign: 'right' }}>Gains</th>
                      <th style={{ textAlign: 'right' }}>Losses</th>
                      <th style={{ textAlign: 'right' }}>Profit</th>
                      <th style={{ textAlign: 'center' }}>Games</th>
                      <th style={{ textAlign: 'center' }}>Win %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedStats.map((player, index) => (
                      <tr key={player.playerId}>
                        <td>
                          {getMedal(index, sortBy === 'profit' ? player.totalProfit : 
                            sortBy === 'games' ? player.gamesPlayed : player.winPercentage)}
                          {index + 1}
                        </td>
                        <td style={{ fontWeight: '600' }}>{player.playerName}</td>
                        <td style={{ textAlign: 'right' }} className="profit">
                          +{formatCurrency(player.totalGains)}
                        </td>
                        <td style={{ textAlign: 'right' }} className="loss">
                          -{formatCurrency(player.totalLosses)}
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: '700' }} className={getProfitColor(player.totalProfit)}>
                          {player.totalProfit >= 0 ? '+' : ''}{formatCurrency(player.totalProfit)}
                        </td>
                        <td style={{ textAlign: 'center' }}>{player.gamesPlayed}</td>
                        <td style={{ textAlign: 'center' }}>{player.winPercentage.toFixed(0)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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

              <div className="grid grid-4">
                <div className="stat-card">
                  <div className="stat-value">{player.gamesPlayed}</div>
                  <div className="stat-label">Games</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{player.winPercentage.toFixed(0)}%</div>
                  <div className="stat-label">Win Rate</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value" style={{ color: 'var(--primary)' }}>
                    {formatCurrency(player.avgProfit)}
                  </div>
                  <div className="stat-label">Avg P/L</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value">{player.totalRebuys}</div>
                  <div className="stat-label">Rebuys</div>
                </div>
              </div>

              <div className="grid grid-2 mt-1">
                <div style={{ 
                  padding: '0.5rem', 
                  background: 'rgba(34, 197, 94, 0.1)', 
                  borderRadius: '8px',
                  textAlign: 'center'
                }}>
                  <div className="text-muted" style={{ fontSize: '0.75rem' }}>Total Gains</div>
                  <div className="profit">+{formatCurrency(player.totalGains)}</div>
                  <div className="text-muted" style={{ fontSize: '0.7rem' }}>{player.winCount} wins</div>
                </div>
                <div style={{ 
                  padding: '0.5rem', 
                  background: 'rgba(239, 68, 68, 0.1)', 
                  borderRadius: '8px',
                  textAlign: 'center'
                }}>
                  <div className="text-muted" style={{ fontSize: '0.75rem' }}>Total Losses</div>
                  <div className="loss">-{formatCurrency(player.totalLosses)}</div>
                  <div className="text-muted" style={{ fontSize: '0.7rem' }}>{player.lossCount} losses</div>
                </div>
              </div>

              <div className="grid grid-2 mt-1">
                <div style={{ 
                  padding: '0.5rem', 
                  background: 'rgba(59, 130, 246, 0.1)', 
                  borderRadius: '8px',
                  textAlign: 'center'
                }}>
                  <div className="text-muted" style={{ fontSize: '0.75rem' }}>Best Game</div>
                  <div className="profit">{formatCurrency(player.biggestWin)}</div>
                </div>
                <div style={{ 
                  padding: '0.5rem', 
                  background: 'rgba(59, 130, 246, 0.1)', 
                  borderRadius: '8px',
                  textAlign: 'center'
                }}>
                  <div className="text-muted" style={{ fontSize: '0.75rem' }}>Worst Game</div>
                  <div className="loss">{formatCurrency(player.biggestLoss)}</div>
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

