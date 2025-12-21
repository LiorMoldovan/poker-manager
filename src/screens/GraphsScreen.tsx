import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { Player, PlayerType, Game, GamePlayer } from '../types';
import { getAllPlayers, getAllGames, getAllGamePlayers } from '../database/storage';
import { cleanNumber } from '../utils/calculations';

type ViewMode = 'cumulative' | 'headToHead';
type TimePeriod = 'all' | 'h1' | 'h2' | 'year';

// Color palette for players - stable mapping by player ID
const PLAYER_COLORS = [
  '#10B981', // Green
  '#3B82F6', // Blue
  '#F59E0B', // Amber
  '#EF4444', // Red
  '#8B5CF6', // Purple
  '#EC4899', // Pink
  '#06B6D4', // Cyan
  '#F97316', // Orange
  '#84CC16', // Lime
  '#6366F1', // Indigo
  '#14B8A6', // Teal
  '#A855F7', // Violet
];

interface CumulativeDataPoint {
  gameIndex: number;
  date: string;
  gameId: string;
  [playerName: string]: string | number;
}

interface HeadToHeadStat {
  playerName: string;
  totalProfit: number;
  gamesPlayed: number;
  wins: number;
  losses: number;
  avgProfit: number;
  biggestWin: number;
  biggestLoss: number;
}

const GraphsScreen = () => {
  const [viewMode, setViewMode] = useState<ViewMode>('cumulative');
  const [players, setPlayers] = useState<Player[]>([]);
  const [allGames, setAllGames] = useState<Game[]>([]);
  const [gamePlayers, setGamePlayers] = useState<GamePlayer[]>([]);
  const [selectedPlayers, setSelectedPlayers] = useState<Set<string>>(new Set());
  const [showPlayerSelector, setShowPlayerSelector] = useState(false);
  const [showTimePeriod, setShowTimePeriod] = useState(false);
  
  // Selected point for showing details below graph
  const [selectedPoint, setSelectedPoint] = useState<CumulativeDataPoint | null>(null);
  
  // Time period filter
  const [timePeriod, setTimePeriod] = useState<TimePeriod>(() => {
    const currentMonth = new Date().getMonth() + 1;
    return currentMonth <= 6 ? 'h1' : 'h2';
  });
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear());
  
  // Head-to-head specific state
  const [player1Id, setPlayer1Id] = useState<string>('');
  const [player2Id, setPlayer2Id] = useState<string>('');

  // Color mapping - stable by player order in permanent list
  const playerColorMap = useMemo(() => {
    const map = new Map<string, string>();
    const permanentPlayers = players.filter(p => p.type === 'permanent');
    permanentPlayers.forEach((player, index) => {
      map.set(player.id, PLAYER_COLORS[index % PLAYER_COLORS.length]);
    });
    return map;
  }, [players]);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = () => {
    const allPlayersData = getAllPlayers();
    const allGamesData = getAllGames()
      .filter(g => g.status === 'completed')
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const allGamePlayersData = getAllGamePlayers();
    
    setPlayers(allPlayersData);
    setAllGames(allGamesData);
    setGamePlayers(allGamePlayersData);
    
    // Default: select all permanent players
    const permanentPlayerIds = allPlayersData
      .filter(p => p.type === 'permanent')
      .map(p => p.id);
    setSelectedPlayers(new Set(permanentPlayerIds));
    
    // Set default head-to-head players
    if (permanentPlayerIds.length >= 2) {
      setPlayer1Id(permanentPlayerIds[0]);
      setPlayer2Id(permanentPlayerIds[1]);
    }
  };

  // Get available years
  const getAvailableYears = (): number[] => {
    const years: number[] = [];
    const now = new Date();
    for (let y = now.getFullYear(); y >= 2021; y--) {
      years.push(y);
    }
    return years;
  };

  // Filter games by time period
  const filteredGames = useMemo(() => {
    return allGames.filter(game => {
      const gameDate = new Date(game.date);
      const year = selectedYear;
      
      switch (timePeriod) {
        case 'h1':
          return gameDate >= new Date(year, 0, 1) && gameDate <= new Date(year, 5, 30, 23, 59, 59);
        case 'h2':
          return gameDate >= new Date(year, 6, 1) && gameDate <= new Date(year, 11, 31, 23, 59, 59);
        case 'year':
          return gameDate >= new Date(year, 0, 1) && gameDate <= new Date(year, 11, 31, 23, 59, 59);
        case 'all':
        default:
          return true;
      }
    });
  }, [allGames, timePeriod, selectedYear]);

  const getPlayerName = useCallback((playerId: string): string => {
    const player = players.find(p => p.id === playerId);
    return player?.name || 'Unknown';
  }, [players]);

  const getPlayerColor = useCallback((playerId: string): string => {
    return playerColorMap.get(playerId) || '#888888';
  }, [playerColorMap]);

  // Calculate cumulative profit data
  const cumulativeData: CumulativeDataPoint[] = useMemo(() => {
    const data: CumulativeDataPoint[] = [];
    const playerCumulatives: Record<string, number> = {};
    
    // Initialize all selected players with 0
    selectedPlayers.forEach(playerId => {
      playerCumulatives[playerId] = 0;
    });

    filteredGames.forEach((game, gameIndex) => {
      const gameDate = new Date(game.date);
      const dateStr = gameDate.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });
      
      const dataPoint: CumulativeDataPoint = {
        gameIndex: gameIndex + 1,
        date: dateStr,
        gameId: game.id,
      };

      // Update cumulative for each selected player
      selectedPlayers.forEach(playerId => {
        const gp = gamePlayers.find(
          g => g.gameId === game.id && g.playerId === playerId
        );
        if (gp) {
          playerCumulatives[playerId] += gp.profit;
        }
        const playerName = getPlayerName(playerId);
        dataPoint[playerName] = playerCumulatives[playerId];
      });

      data.push(dataPoint);
    });

    return data;
  }, [filteredGames, gamePlayers, selectedPlayers, getPlayerName]);

  // Head-to-head comparison data
  const headToHeadData = useMemo(() => {
    if (!player1Id || !player2Id) return null;

    // Find games where both players participated (filtered by time period)
    const sharedGameIds = new Set<string>();
    filteredGames.forEach(game => {
      const p1Played = gamePlayers.some(gp => gp.gameId === game.id && gp.playerId === player1Id);
      const p2Played = gamePlayers.some(gp => gp.gameId === game.id && gp.playerId === player2Id);
      if (p1Played && p2Played) {
        sharedGameIds.add(game.id);
      }
    });

    const player1Games = gamePlayers.filter(
      gp => gp.playerId === player1Id && sharedGameIds.has(gp.gameId)
    );
    const player2Games = gamePlayers.filter(
      gp => gp.playerId === player2Id && sharedGameIds.has(gp.gameId)
    );

    const player1Stats: HeadToHeadStat = {
      playerName: getPlayerName(player1Id),
      totalProfit: player1Games.reduce((sum, g) => sum + g.profit, 0),
      gamesPlayed: player1Games.length,
      wins: player1Games.filter(g => g.profit > 0).length,
      losses: player1Games.filter(g => g.profit < 0).length,
      avgProfit: player1Games.length > 0 
        ? player1Games.reduce((sum, g) => sum + g.profit, 0) / player1Games.length 
        : 0,
      biggestWin: Math.max(0, ...player1Games.map(g => g.profit)),
      biggestLoss: Math.min(0, ...player1Games.map(g => g.profit)),
    };

    const player2Stats: HeadToHeadStat = {
      playerName: getPlayerName(player2Id),
      totalProfit: player2Games.reduce((sum, g) => sum + g.profit, 0),
      gamesPlayed: player2Games.length,
      wins: player2Games.filter(g => g.profit > 0).length,
      losses: player2Games.filter(g => g.profit < 0).length,
      avgProfit: player2Games.length > 0 
        ? player2Games.reduce((sum, g) => sum + g.profit, 0) / player2Games.length 
        : 0,
      biggestWin: Math.max(0, ...player2Games.map(g => g.profit)),
      biggestLoss: Math.min(0, ...player2Games.map(g => g.profit)),
    };

    // Cumulative data for shared games only
    const cumulativeComparison: Array<{
      gameIndex: number;
      date: string;
      [key: string]: string | number;
    }> = [];
    
    let p1Cumulative = 0;
    let p2Cumulative = 0;
    let gameIdx = 0;

    filteredGames
      .filter(g => sharedGameIds.has(g.id))
      .forEach(game => {
        gameIdx++;
        const p1Game = player1Games.find(g => g.gameId === game.id);
        const p2Game = player2Games.find(g => g.gameId === game.id);
        
        if (p1Game) p1Cumulative += p1Game.profit;
        if (p2Game) p2Cumulative += p2Game.profit;

        const dateStr = new Date(game.date).toLocaleDateString('en-GB', { 
          day: '2-digit', 
          month: '2-digit', 
          year: '2-digit' 
        });

        cumulativeComparison.push({
          gameIndex: gameIdx,
          date: dateStr,
          [player1Stats.playerName]: p1Cumulative,
          [player2Stats.playerName]: p2Cumulative,
        });
      });

    return {
      player1Stats,
      player2Stats,
      sharedGamesCount: sharedGameIds.size,
      cumulativeComparison,
    };
  }, [player1Id, player2Id, filteredGames, gamePlayers, getPlayerName]);

  // Toggle player selection
  const togglePlayer = (playerId: string) => {
    setSelectedPlayers(prev => {
      const next = new Set(prev);
      if (next.has(playerId)) {
        if (next.size > 1) {
          next.delete(playerId);
        }
      } else {
        next.add(playerId);
      }
      return next;
    });
  };

  // Select all permanent players
  const selectAllPermanent = () => {
    const permanentIds = players
      .filter(p => p.type === 'permanent')
      .map(p => p.id);
    setSelectedPlayers(new Set(permanentIds));
  };

  // Get sorted players for current view - sorted by name
  const sortedPlayerIds = useMemo(() => {
    return Array.from(selectedPlayers).sort((a, b) => {
      const aName = getPlayerName(a);
      const bName = getPlayerName(b);
      return aName.localeCompare(bName);
    });
  }, [selectedPlayers, getPlayerName]);

  // Get timeframe label
  const getTimeframeLabel = () => {
    if (timePeriod === 'all') return 'All Time';
    if (timePeriod === 'year') return `${selectedYear}`;
    if (timePeriod === 'h1') return `H1 ${selectedYear}`;
    if (timePeriod === 'h2') return `H2 ${selectedYear}`;
    return '';
  };

  // Handle chart click to select a data point
  const handleChartClick = (data: any) => {
    if (data && data.activePayload && data.activePayload.length > 0) {
      const gameIndex = data.activeLabel;
      const point = cumulativeData.find(d => d.gameIndex === gameIndex);
      if (point) {
        setSelectedPoint(point);
      }
    }
  };

  // Custom Legend component with colored names
  const CustomLegend = () => (
    <div style={{ 
      display: 'flex', 
      flexWrap: 'wrap', 
      justifyContent: 'center',
      gap: '0.5rem',
      padding: '0.5rem 0',
      marginTop: '0.5rem',
    }}>
      {sortedPlayerIds.map(playerId => (
        <div key={playerId} style={{ 
          display: 'flex', 
          alignItems: 'center', 
          gap: '0.25rem',
          fontSize: '0.7rem',
        }}>
          <div style={{ 
            width: '8px', 
            height: '8px', 
            borderRadius: '50%', 
            background: getPlayerColor(playerId) 
          }} />
          <span style={{ 
            color: getPlayerColor(playerId), 
            fontWeight: '600' 
          }}>
            {getPlayerName(playerId)}
          </span>
        </div>
      ))}
    </div>
  );

  // Selected point details panel (shown below the graph)
  const SelectedPointDetails = () => {
    if (!selectedPoint) return null;
    
    // Get player values and sort by cumulative profit
    const playerValues = sortedPlayerIds.map(playerId => {
      const playerName = getPlayerName(playerId);
      return {
        playerId,
        playerName,
        value: selectedPoint[playerName] as number,
        color: getPlayerColor(playerId),
      };
    }).sort((a, b) => b.value - a.value);

    return (
      <div style={{
        background: 'var(--surface)',
        borderRadius: '8px',
        padding: '0.75rem',
        marginTop: '0.5rem',
      }}>
        <div style={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center',
          marginBottom: '0.5rem',
        }}>
          <span style={{ fontWeight: '600', color: 'var(--text)', fontSize: '0.8rem' }}>
            Game {selectedPoint.gameIndex} • {selectedPoint.date}
          </span>
          <button
            onClick={() => setSelectedPoint(null)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: '1rem',
              padding: '0',
            }}
          >
            ✕
          </button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
          {playerValues.map(({ playerId, playerName, value, color }) => (
            <div key={playerId} style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.3rem',
              padding: '0.25rem 0.5rem',
              background: `${color}15`,
              borderRadius: '12px',
              fontSize: '0.75rem',
            }}>
              <span style={{ color, fontWeight: '600' }}>{playerName}</span>
              <span style={{ 
                fontWeight: '700',
                color: value >= 0 ? 'var(--success)' : 'var(--danger)'
              }}>
                {value >= 0 ? '+' : ''}₪{cleanNumber(value)}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="fade-in">
      <div className="page-header">
        <h1 className="page-title">📊 Graphs</h1>
        <p className="page-subtitle">Visualize player performance trends</p>
      </div>

      {/* View Mode Toggle */}
      <div className="card" style={{ padding: '0.75rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button 
            className={`btn btn-sm ${viewMode === 'cumulative' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setViewMode('cumulative')}
            style={{ flex: 1 }}
          >
            📈 Profit
          </button>
          <button 
            className={`btn btn-sm ${viewMode === 'headToHead' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setViewMode('headToHead')}
            style={{ flex: 1 }}
          >
            🆚 Head-to-Head
          </button>
        </div>
      </div>

      {/* Time Period Filter */}
      <div className="card" style={{ padding: '0.75rem' }}>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); e.preventDefault(); setShowTimePeriod(!showTimePeriod); }}
          style={{ 
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            width: '100%', padding: 0, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text)',
            marginBottom: showTimePeriod ? '0.5rem' : 0
          }}
        >
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: '600' }}>
            📅 TIME PERIOD ({getTimeframeLabel()})
          </span>
          <span style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>{showTimePeriod ? '▲' : '▼'}</span>
        </button>
        {showTimePeriod && (
          <>
            <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
              {(['all', 'year', 'h1', 'h2'] as TimePeriod[]).map(period => (
                <button
                  key={period}
                  type="button"
                  onClick={(e) => { e.stopPropagation(); e.preventDefault(); setTimePeriod(period); }}
                  style={{
                    flex: 1,
                    minWidth: '50px',
                    padding: '0.4rem',
                    fontSize: '0.7rem',
                    borderRadius: '6px',
                    border: timePeriod === period ? '2px solid var(--primary)' : '1px solid var(--border)',
                    background: timePeriod === period ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
                    color: timePeriod === period ? 'var(--primary)' : 'var(--text-muted)',
                    cursor: 'pointer'
                  }}
                >
                  {period === 'all' ? 'הכל' : period === 'year' ? 'שנה' : period.toUpperCase()}
                </button>
              ))}
            </div>
            {timePeriod !== 'all' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.4rem' }}>
                <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>שנה:</span>
                <select
                  value={selectedYear}
                  onChange={(e) => setSelectedYear(parseInt(e.target.value))}
                  style={{
                    padding: '0.25rem 0.4rem',
                    fontSize: '0.7rem',
                    borderRadius: '4px',
                    border: '1px solid var(--border)',
                    background: 'var(--surface)',
                    color: 'var(--text)',
                    cursor: 'pointer',
                    minWidth: '60px'
                  }}
                >
                  {getAvailableYears().map(year => (
                    <option key={year} value={year}>{year}</option>
                  ))}
                </select>
                <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                  {timePeriod === 'h1' && `(ינו׳-יוני׳)`}
                  {timePeriod === 'h2' && `(יולי׳-דצמ׳)`}
                </span>
              </div>
            )}
          </>
        )}
      </div>

      {/* Player Selector (for Cumulative view) */}
      {viewMode === 'cumulative' && (
        <div className="card" style={{ padding: '0.75rem' }}>
          <button
            type="button"
            onClick={() => setShowPlayerSelector(!showPlayerSelector)}
            style={{ 
              display: 'flex', 
              justifyContent: 'space-between', 
              alignItems: 'center',
              width: '100%',
              padding: 0,
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--text)',
              marginBottom: showPlayerSelector ? '0.5rem' : 0
            }}
          >
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: '600' }}>
              SELECT PLAYERS ({selectedPlayers.size} selected)
            </span>
            <span style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>
              {showPlayerSelector ? '▲' : '▼'}
            </span>
          </button>
          
          {showPlayerSelector && (
            <>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.4rem' }}>
                <button
                  type="button"
                  onClick={selectAllPermanent}
                  style={{
                    padding: '0.25rem 0.5rem',
                    fontSize: '0.7rem',
                    borderRadius: '4px',
                    border: '1px solid var(--border)',
                    background: 'var(--surface)',
                    color: 'var(--text-muted)',
                    cursor: 'pointer'
                  }}
                >
                  Select All
                </button>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                {players
                  .filter(p => p.type === 'permanent')
                  .map((player) => {
                    const isSelected = selectedPlayers.has(player.id);
                    const color = getPlayerColor(player.id);
                    return (
                      <button
                        type="button"
                        key={player.id}
                        onClick={() => togglePlayer(player.id)}
                        style={{
                          padding: '0.4rem 0.65rem',
                          borderRadius: '16px',
                          border: isSelected 
                            ? `2px solid ${color}` 
                            : '2px solid var(--border)',
                          background: isSelected 
                            ? `${color}22` 
                            : 'var(--surface)',
                          cursor: 'pointer',
                          fontSize: '0.8rem',
                          fontWeight: '600',
                          color: isSelected ? color : 'var(--text-muted)',
                          transition: 'all 0.15s ease'
                        }}
                      >
                        {isSelected && '✓ '}{player.name}
                      </button>
                    );
                  })}
              </div>
            </>
          )}
        </div>
      )}

      {/* Head-to-Head Player Selection */}
      {viewMode === 'headToHead' && (
        <div className="card" style={{ padding: '0.75rem' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: '600', marginBottom: '0.5rem' }}>
            SELECT 2 PLAYERS TO COMPARE
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <select
              value={player1Id}
              onChange={(e) => setPlayer1Id(e.target.value)}
              style={{
                flex: 1,
                padding: '0.5rem',
                borderRadius: '8px',
                border: '2px solid #10B981',
                background: 'rgba(16, 185, 129, 0.1)',
                color: 'var(--text)',
                fontSize: '0.9rem',
                fontWeight: '600',
              }}
            >
              {players.filter(p => p.type === 'permanent').map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <span style={{ fontSize: '1.2rem', fontWeight: '700' }}>🆚</span>
            <select
              value={player2Id}
              onChange={(e) => setPlayer2Id(e.target.value)}
              style={{
                flex: 1,
                padding: '0.5rem',
                borderRadius: '8px',
                border: '2px solid #3B82F6',
                background: 'rgba(59, 130, 246, 0.1)',
                color: 'var(--text)',
                fontSize: '0.9rem',
                fontWeight: '600',
              }}
            >
              {players.filter(p => p.type === 'permanent').map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* CUMULATIVE PROFIT CHART */}
      {viewMode === 'cumulative' && cumulativeData.length > 0 && (
        <div className="card">
          <h2 className="card-title mb-2">📈 Cumulative Profit Over Time</h2>
          <div style={{ 
            fontSize: '0.7rem', 
            color: 'var(--text-muted)',
            textAlign: 'center',
            marginBottom: '0.5rem' 
          }}>
            {getTimeframeLabel()} • {filteredGames.length} games • Tap chart to see details
          </div>
          <div style={{ 
            width: '100%', 
            height: '320px',
            marginLeft: '-10px',
          }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart 
                data={cumulativeData} 
                margin={{ top: 10, right: 10, left: 0, bottom: 10 }}
                onClick={handleChartClick}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.5} />
                <XAxis 
                  dataKey="gameIndex" 
                  stroke="var(--text-muted)" 
                  fontSize={10}
                  tickLine={false}
                />
                <YAxis 
                  stroke="var(--text-muted)" 
                  fontSize={10}
                  tickFormatter={(value) => `₪${cleanNumber(value)}`}
                  tickLine={false}
                  axisLine={false}
                />
                <ReferenceLine y={0} stroke="var(--text-muted)" strokeDasharray="3 3" />
                {sortedPlayerIds.map((playerId) => (
                  <Line
                    key={playerId}
                    type="monotone"
                    dataKey={getPlayerName(playerId)}
                    stroke={getPlayerColor(playerId)}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 6, strokeWidth: 2, stroke: '#fff' }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <CustomLegend />
          <SelectedPointDetails />
        </div>
      )}

      {/* HEAD-TO-HEAD COMPARISON */}
      {viewMode === 'headToHead' && headToHeadData && (
        <>
          {/* Stats Comparison */}
          <div className="card">
            <h2 className="card-title mb-2">📊 Stats Comparison</h2>
            <div style={{ 
              fontSize: '0.75rem', 
              color: 'var(--text-muted)', 
              marginBottom: '0.75rem',
              textAlign: 'center' 
            }}>
              {getTimeframeLabel()} • {headToHeadData.sharedGamesCount} shared games
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {/* Total Profit Row */}
              <div style={{ 
                display: 'flex', 
                alignItems: 'center',
                padding: '0.5rem',
                background: 'var(--surface)',
                borderRadius: '8px',
              }}>
                <div style={{ 
                  flex: 1, 
                  textAlign: 'right',
                  fontWeight: '700',
                  fontSize: '1rem',
                  color: headToHeadData.player1Stats.totalProfit >= headToHeadData.player2Stats.totalProfit 
                    ? 'var(--success)' 
                    : 'var(--danger)'
                }}>
                  {headToHeadData.player1Stats.totalProfit >= 0 ? '+' : ''}₪{cleanNumber(headToHeadData.player1Stats.totalProfit)}
                </div>
                <div style={{ 
                  padding: '0.25rem 0.75rem',
                  fontSize: '0.7rem',
                  color: 'var(--text-muted)',
                  fontWeight: '600',
                  textAlign: 'center',
                  minWidth: '80px',
                }}>
                  Total Profit
                </div>
                <div style={{ 
                  flex: 1, 
                  textAlign: 'left',
                  fontWeight: '700',
                  fontSize: '1rem',
                  color: headToHeadData.player2Stats.totalProfit >= headToHeadData.player1Stats.totalProfit 
                    ? 'var(--success)' 
                    : 'var(--danger)'
                }}>
                  {headToHeadData.player2Stats.totalProfit >= 0 ? '+' : ''}₪{cleanNumber(headToHeadData.player2Stats.totalProfit)}
                </div>
              </div>

              {/* Wins Row */}
              <div style={{ 
                display: 'flex', 
                alignItems: 'center',
                padding: '0.5rem',
                background: 'var(--surface)',
                borderRadius: '8px',
              }}>
                <div style={{ 
                  flex: 1, 
                  textAlign: 'right',
                  fontWeight: '600',
                  color: headToHeadData.player1Stats.wins >= headToHeadData.player2Stats.wins 
                    ? 'var(--success)' 
                    : 'var(--text)'
                }}>
                  {headToHeadData.player1Stats.wins}
                </div>
                <div style={{ 
                  padding: '0.25rem 0.75rem',
                  fontSize: '0.7rem',
                  color: 'var(--text-muted)',
                  fontWeight: '600',
                  textAlign: 'center',
                  minWidth: '80px',
                }}>
                  Wins
                </div>
                <div style={{ 
                  flex: 1, 
                  textAlign: 'left',
                  fontWeight: '600',
                  color: headToHeadData.player2Stats.wins >= headToHeadData.player1Stats.wins 
                    ? 'var(--success)' 
                    : 'var(--text)'
                }}>
                  {headToHeadData.player2Stats.wins}
                </div>
              </div>

              {/* Avg/Game Row */}
              <div style={{ 
                display: 'flex', 
                alignItems: 'center',
                padding: '0.5rem',
                background: 'var(--surface)',
                borderRadius: '8px',
              }}>
                <div style={{ 
                  flex: 1, 
                  textAlign: 'right',
                  fontWeight: '600',
                  color: headToHeadData.player1Stats.avgProfit >= headToHeadData.player2Stats.avgProfit 
                    ? 'var(--success)' 
                    : 'var(--danger)'
                }}>
                  {headToHeadData.player1Stats.avgProfit >= 0 ? '+' : ''}₪{cleanNumber(headToHeadData.player1Stats.avgProfit)}
                </div>
                <div style={{ 
                  padding: '0.25rem 0.75rem',
                  fontSize: '0.7rem',
                  color: 'var(--text-muted)',
                  fontWeight: '600',
                  textAlign: 'center',
                  minWidth: '80px',
                }}>
                  Avg/Game
                </div>
                <div style={{ 
                  flex: 1, 
                  textAlign: 'left',
                  fontWeight: '600',
                  color: headToHeadData.player2Stats.avgProfit >= headToHeadData.player1Stats.avgProfit 
                    ? 'var(--success)' 
                    : 'var(--danger)'
                }}>
                  {headToHeadData.player2Stats.avgProfit >= 0 ? '+' : ''}₪{cleanNumber(headToHeadData.player2Stats.avgProfit)}
                </div>
              </div>

              {/* Biggest Win Row */}
              <div style={{ 
                display: 'flex', 
                alignItems: 'center',
                padding: '0.5rem',
                background: 'var(--surface)',
                borderRadius: '8px',
              }}>
                <div style={{ 
                  flex: 1, 
                  textAlign: 'right',
                  fontWeight: '600',
                  color: headToHeadData.player1Stats.biggestWin >= headToHeadData.player2Stats.biggestWin 
                    ? 'var(--success)' 
                    : 'var(--text)'
                }}>
                  +₪{cleanNumber(headToHeadData.player1Stats.biggestWin)}
                </div>
                <div style={{ 
                  padding: '0.25rem 0.75rem',
                  fontSize: '0.7rem',
                  color: 'var(--text-muted)',
                  fontWeight: '600',
                  textAlign: 'center',
                  minWidth: '80px',
                }}>
                  Biggest Win
                </div>
                <div style={{ 
                  flex: 1, 
                  textAlign: 'left',
                  fontWeight: '600',
                  color: headToHeadData.player2Stats.biggestWin >= headToHeadData.player1Stats.biggestWin 
                    ? 'var(--success)' 
                    : 'var(--text)'
                }}>
                  +₪{cleanNumber(headToHeadData.player2Stats.biggestWin)}
                </div>
              </div>

              {/* Biggest Loss Row */}
              <div style={{ 
                display: 'flex', 
                alignItems: 'center',
                padding: '0.5rem',
                background: 'var(--surface)',
                borderRadius: '8px',
              }}>
                <div style={{ 
                  flex: 1, 
                  textAlign: 'right',
                  fontWeight: '600',
                  color: headToHeadData.player1Stats.biggestLoss >= headToHeadData.player2Stats.biggestLoss 
                    ? 'var(--text)' 
                    : 'var(--danger)'
                }}>
                  ₪{cleanNumber(headToHeadData.player1Stats.biggestLoss)}
                </div>
                <div style={{ 
                  padding: '0.25rem 0.75rem',
                  fontSize: '0.7rem',
                  color: 'var(--text-muted)',
                  fontWeight: '600',
                  textAlign: 'center',
                  minWidth: '80px',
                }}>
                  Biggest Loss
                </div>
                <div style={{ 
                  flex: 1, 
                  textAlign: 'left',
                  fontWeight: '600',
                  color: headToHeadData.player2Stats.biggestLoss >= headToHeadData.player1Stats.biggestLoss 
                    ? 'var(--text)' 
                    : 'var(--danger)'
                }}>
                  ₪{cleanNumber(headToHeadData.player2Stats.biggestLoss)}
                </div>
              </div>
            </div>

            {/* Player names at bottom */}
            <div style={{ 
              display: 'flex', 
              justifyContent: 'space-between',
              marginTop: '1rem',
              padding: '0.5rem',
              borderTop: '1px solid var(--border)',
            }}>
              <span style={{ fontWeight: '700', color: '#10B981' }}>
                {headToHeadData.player1Stats.playerName}
              </span>
              <span style={{ fontWeight: '700', color: '#3B82F6' }}>
                {headToHeadData.player2Stats.playerName}
              </span>
            </div>
          </div>

          {/* Cumulative Comparison Chart */}
          {headToHeadData.cumulativeComparison.length > 0 && (
            <div className="card">
              <h2 className="card-title mb-2">📈 Cumulative Comparison</h2>
              <div style={{ 
                width: '100%', 
                height: '280px',
                marginLeft: '-10px',
              }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart 
                    data={headToHeadData.cumulativeComparison} 
                    margin={{ top: 10, right: 10, left: 0, bottom: 10 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.5} />
                    <XAxis 
                      dataKey="gameIndex" 
                      stroke="var(--text-muted)" 
                      fontSize={10}
                      tickLine={false}
                    />
                    <YAxis 
                      stroke="var(--text-muted)" 
                      fontSize={10}
                      tickFormatter={(value) => `₪${cleanNumber(value)}`}
                      tickLine={false}
                      axisLine={false}
                    />
                    <ReferenceLine y={0} stroke="var(--text-muted)" strokeDasharray="3 3" />
                    <Line
                      type="monotone"
                      dataKey={headToHeadData.player1Stats.playerName}
                      stroke="#10B981"
                      strokeWidth={3}
                      dot={false}
                      activeDot={{ r: 5 }}
                    />
                    <Line
                      type="monotone"
                      dataKey={headToHeadData.player2Stats.playerName}
                      stroke="#3B82F6"
                      strokeWidth={3}
                      dot={false}
                      activeDot={{ r: 5 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              {/* Custom Legend for H2H */}
              <div style={{ 
                display: 'flex', 
                justifyContent: 'center',
                gap: '1.5rem',
                padding: '0.5rem 0',
                marginTop: '0.5rem',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                  <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#10B981' }} />
                  <span style={{ color: '#10B981', fontWeight: '600', fontSize: '0.8rem' }}>
                    {headToHeadData.player1Stats.playerName}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                  <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: '#3B82F6' }} />
                  <span style={{ color: '#3B82F6', fontWeight: '600', fontSize: '0.8rem' }}>
                    {headToHeadData.player2Stats.playerName}
                  </span>
                </div>
              </div>
              <div style={{ 
                textAlign: 'center', 
                fontSize: '0.65rem', 
                color: 'var(--text-muted)',
                marginTop: '0.25rem' 
              }}>
                Only includes games where both players participated
              </div>
            </div>
          )}
        </>
      )}

      {/* Empty State */}
      {filteredGames.length === 0 && (
        <div className="card">
          <div className="empty-state">
            <div className="empty-icon">📊</div>
            <p>No data for this period</p>
            <p className="text-muted">Try a different time filter</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default GraphsScreen;
