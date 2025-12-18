import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
  BarChart,
  Bar,
} from 'recharts';
import { Player, PlayerType, Game, GamePlayer } from '../types';
import { getAllPlayers, getAllGames, getAllGamePlayers, getPlayerStats } from '../database/storage';
import { cleanNumber } from '../utils/calculations';

type ViewMode = 'cumulative' | 'headToHead' | 'leaderboardRace';

// Color palette for players
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

interface RaceDataPoint {
  gameIndex: number;
  date: string;
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
  const [games, setGames] = useState<Game[]>([]);
  const [gamePlayers, setGamePlayers] = useState<GamePlayer[]>([]);
  const [selectedPlayers, setSelectedPlayers] = useState<Set<string>>(new Set());
  const [showPlayerSelector, setShowPlayerSelector] = useState(false);
  const [animationProgress, setAnimationProgress] = useState(100);
  const [isAnimating, setIsAnimating] = useState(false);
  
  // Head-to-head specific state
  const [player1Id, setPlayer1Id] = useState<string>('');
  const [player2Id, setPlayer2Id] = useState<string>('');

  useEffect(() => {
    loadData();
  }, []);

  const loadData = () => {
    const allPlayers = getAllPlayers();
    const allGames = getAllGames()
      .filter(g => g.status === 'completed')
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const allGamePlayers = getAllGamePlayers();
    
    setPlayers(allPlayers);
    setGames(allGames);
    setGamePlayers(allGamePlayers);
    
    // Default: select all permanent players
    const permanentPlayerIds = allPlayers
      .filter(p => p.type === 'permanent')
      .map(p => p.id);
    setSelectedPlayers(new Set(permanentPlayerIds));
    
    // Set default head-to-head players
    if (permanentPlayerIds.length >= 2) {
      setPlayer1Id(permanentPlayerIds[0]);
      setPlayer2Id(permanentPlayerIds[1]);
    }
  };

  const getPlayerType = useCallback((playerId: string): PlayerType => {
    const player = players.find(p => p.id === playerId);
    return player?.type || 'permanent';
  }, [players]);

  const getPlayerName = useCallback((playerId: string): string => {
    const player = players.find(p => p.id === playerId);
    return player?.name || 'Unknown';
  }, [players]);

  const getPlayerColor = useCallback((playerId: string, index: number): string => {
    return PLAYER_COLORS[index % PLAYER_COLORS.length];
  }, []);

  // Calculate cumulative profit data
  const cumulativeData: CumulativeDataPoint[] = useMemo(() => {
    const data: CumulativeDataPoint[] = [];
    const playerCumulatives: Record<string, number> = {};
    
    // Initialize all selected players with 0
    selectedPlayers.forEach(playerId => {
      playerCumulatives[playerId] = 0;
    });

    games.forEach((game, gameIndex) => {
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
  }, [games, gamePlayers, selectedPlayers, getPlayerName]);

  // Calculate leaderboard race data (with rankings)
  const raceData: RaceDataPoint[] = useMemo(() => {
    const data: RaceDataPoint[] = [];
    const playerCumulatives: Record<string, number> = {};
    
    // Initialize all selected players with 0
    selectedPlayers.forEach(playerId => {
      playerCumulatives[playerId] = 0;
    });

    games.forEach((game, gameIndex) => {
      const gameDate = new Date(game.date);
      const dateStr = gameDate.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });
      
      // Update cumulative for each selected player
      selectedPlayers.forEach(playerId => {
        const gp = gamePlayers.find(
          g => g.gameId === game.id && g.playerId === playerId
        );
        if (gp) {
          playerCumulatives[playerId] += gp.profit;
        }
      });

      // Calculate ranks based on cumulative profit
      const sortedPlayers = Array.from(selectedPlayers)
        .map(playerId => ({
          playerId,
          cumulative: playerCumulatives[playerId],
        }))
        .sort((a, b) => b.cumulative - a.cumulative);

      const dataPoint: RaceDataPoint = {
        gameIndex: gameIndex + 1,
        date: dateStr,
      };

      sortedPlayers.forEach((player, rank) => {
        const playerName = getPlayerName(player.playerId);
        // Use rank (lower is better) for the Y axis
        dataPoint[playerName] = rank + 1;
      });

      data.push(dataPoint);
    });

    return data;
  }, [games, gamePlayers, selectedPlayers, getPlayerName]);

  // Head-to-head comparison data
  const headToHeadData = useMemo(() => {
    if (!player1Id || !player2Id) return null;

    // Find games where both players participated
    const sharedGameIds = new Set<string>();
    games.forEach(game => {
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

    games
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

    // Bar chart data
    const comparisonBars = [
      { 
        metric: 'Total Profit', 
        [player1Stats.playerName]: player1Stats.totalProfit,
        [player2Stats.playerName]: player2Stats.totalProfit,
      },
      { 
        metric: 'Avg/Game', 
        [player1Stats.playerName]: player1Stats.avgProfit,
        [player2Stats.playerName]: player2Stats.avgProfit,
      },
      { 
        metric: 'Biggest Win', 
        [player1Stats.playerName]: player1Stats.biggestWin,
        [player2Stats.playerName]: player2Stats.biggestWin,
      },
    ];

    return {
      player1Stats,
      player2Stats,
      sharedGamesCount: sharedGameIds.size,
      cumulativeComparison,
      comparisonBars,
    };
  }, [player1Id, player2Id, games, gamePlayers, getPlayerName]);

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

  // Start race animation
  const startRaceAnimation = () => {
    setIsAnimating(true);
    setAnimationProgress(0);
    
    const duration = 5000; // 5 seconds
    const steps = 100;
    const stepDuration = duration / steps;
    let currentStep = 0;

    const interval = setInterval(() => {
      currentStep++;
      setAnimationProgress(currentStep);
      
      if (currentStep >= steps) {
        clearInterval(interval);
        setIsAnimating(false);
      }
    }, stepDuration);
  };

  // Animated race data
  const animatedRaceData = useMemo(() => {
    if (!isAnimating && animationProgress === 100) return raceData;
    const endIndex = Math.ceil((animationProgress / 100) * raceData.length);
    return raceData.slice(0, endIndex);
  }, [raceData, animationProgress, isAnimating]);

  // Get sorted players for current view
  const sortedPlayerIds = useMemo(() => {
    return Array.from(selectedPlayers).sort((a, b) => {
      const aName = getPlayerName(a);
      const bName = getPlayerName(b);
      return aName.localeCompare(bName);
    });
  }, [selectedPlayers, getPlayerName]);

  // Custom tooltip for cumulative chart
  const CumulativeTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null;
    
    const sortedPayload = [...payload].sort((a, b) => (b.value || 0) - (a.value || 0));
    
    return (
      <div style={{
        background: 'var(--card)',
        border: '1px solid var(--border)',
        borderRadius: '8px',
        padding: '0.75rem',
        fontSize: '0.8rem',
      }}>
        <div style={{ fontWeight: '600', marginBottom: '0.5rem', color: 'var(--text-muted)' }}>
          Game {label}
        </div>
        {sortedPayload.map((entry: any, index: number) => (
          <div key={index} style={{ 
            display: 'flex', 
            justifyContent: 'space-between', 
            gap: '1rem',
            padding: '0.15rem 0',
          }}>
            <span style={{ color: entry.color }}>{entry.name}</span>
            <span style={{ 
              fontWeight: '600',
              color: entry.value >= 0 ? 'var(--success)' : 'var(--danger)'
            }}>
              {entry.value >= 0 ? '+' : ''}₪{cleanNumber(entry.value)}
            </span>
          </div>
        ))}
      </div>
    );
  };

  // Custom tooltip for race chart
  const RaceTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null;
    
    const sortedPayload = [...payload].sort((a, b) => (a.value || 0) - (b.value || 0));
    
    return (
      <div style={{
        background: 'var(--card)',
        border: '1px solid var(--border)',
        borderRadius: '8px',
        padding: '0.75rem',
        fontSize: '0.8rem',
      }}>
        <div style={{ fontWeight: '600', marginBottom: '0.5rem', color: 'var(--text-muted)' }}>
          Game {label}
        </div>
        {sortedPayload.map((entry: any, index: number) => (
          <div key={index} style={{ 
            display: 'flex', 
            justifyContent: 'space-between', 
            gap: '1rem',
            padding: '0.15rem 0',
          }}>
            <span style={{ color: entry.color }}>#{entry.value} {entry.name}</span>
          </div>
        ))}
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
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button 
            className={`btn btn-sm ${viewMode === 'cumulative' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setViewMode('cumulative')}
            style={{ flex: 1, minWidth: '80px' }}
          >
            📈 Profit
          </button>
          <button 
            className={`btn btn-sm ${viewMode === 'headToHead' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setViewMode('headToHead')}
            style={{ flex: 1, minWidth: '80px' }}
          >
            🆚 H2H
          </button>
          <button 
            className={`btn btn-sm ${viewMode === 'leaderboardRace' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setViewMode('leaderboardRace')}
            style={{ flex: 1, minWidth: '80px' }}
          >
            🏁 Race
          </button>
        </div>
      </div>

      {/* Player Selector (for Cumulative and Race views) */}
      {(viewMode === 'cumulative' || viewMode === 'leaderboardRace') && (
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
                  Permanent Only
                </button>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                {players
                  .filter(p => p.type === 'permanent')
                  .map((player, index) => {
                    const isSelected = selectedPlayers.has(player.id);
                    return (
                      <button
                        type="button"
                        key={player.id}
                        onClick={() => togglePlayer(player.id)}
                        style={{
                          padding: '0.4rem 0.65rem',
                          borderRadius: '16px',
                          border: isSelected 
                            ? `2px solid ${getPlayerColor(player.id, index)}` 
                            : '2px solid var(--border)',
                          background: isSelected 
                            ? `${getPlayerColor(player.id, index)}22` 
                            : 'var(--surface)',
                          cursor: 'pointer',
                          fontSize: '0.8rem',
                          fontWeight: '600',
                          color: isSelected ? getPlayerColor(player.id, index) : 'var(--text-muted)',
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
            width: '100%', 
            height: '350px',
            marginLeft: '-10px',
          }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={cumulativeData} margin={{ top: 10, right: 10, left: 0, bottom: 10 }}>
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
                <Tooltip content={<CumulativeTooltip />} />
                <Legend 
                  wrapperStyle={{ fontSize: '0.7rem', paddingTop: '10px' }}
                  iconType="circle"
                  iconSize={8}
                />
                {sortedPlayerIds.map((playerId, index) => (
                  <Line
                    key={playerId}
                    type="monotone"
                    dataKey={getPlayerName(playerId)}
                    stroke={getPlayerColor(playerId, index)}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div style={{ 
            textAlign: 'center', 
            fontSize: '0.7rem', 
            color: 'var(--text-muted)',
            marginTop: '0.5rem' 
          }}>
            {games.length} games • X-axis: Game # • Y-axis: Cumulative Profit
          </div>
        </div>
      )}

      {/* LEADERBOARD RACE CHART */}
      {viewMode === 'leaderboardRace' && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <h2 className="card-title" style={{ margin: 0 }}>🏁 Leaderboard Race</h2>
            <button
              onClick={startRaceAnimation}
              disabled={isAnimating}
              className="btn btn-sm btn-primary"
              style={{ opacity: isAnimating ? 0.5 : 1 }}
            >
              {isAnimating ? '🏃 Racing...' : '▶️ Replay'}
            </button>
          </div>
          <div style={{ 
            width: '100%', 
            height: '350px',
            marginLeft: '-10px',
          }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={animatedRaceData} margin={{ top: 10, right: 10, left: 0, bottom: 10 }}>
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
                  reversed
                  domain={[1, selectedPlayers.size]}
                  ticks={Array.from({ length: selectedPlayers.size }, (_, i) => i + 1)}
                  tickFormatter={(value) => `#${value}`}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip content={<RaceTooltip />} />
                <Legend 
                  wrapperStyle={{ fontSize: '0.7rem', paddingTop: '10px' }}
                  iconType="circle"
                  iconSize={8}
                />
                {sortedPlayerIds.map((playerId, index) => (
                  <Line
                    key={playerId}
                    type="stepAfter"
                    dataKey={getPlayerName(playerId)}
                    stroke={getPlayerColor(playerId, index)}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div style={{ 
            textAlign: 'center', 
            fontSize: '0.7rem', 
            color: 'var(--text-muted)',
            marginTop: '0.5rem' 
          }}>
            Lower is better • #1 = Leader • Based on cumulative profit ranking
          </div>
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
              Based on {headToHeadData.sharedGamesCount} shared games
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
                height: '300px',
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
                    <Tooltip content={<CumulativeTooltip />} />
                    <Legend 
                      wrapperStyle={{ fontSize: '0.8rem', paddingTop: '10px' }}
                      iconType="circle"
                      iconSize={8}
                    />
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
              <div style={{ 
                textAlign: 'center', 
                fontSize: '0.7rem', 
                color: 'var(--text-muted)',
                marginTop: '0.5rem' 
              }}>
                Only includes games where both players participated
              </div>
            </div>
          )}
        </>
      )}

      {/* Empty State */}
      {games.length === 0 && (
        <div className="card">
          <div className="empty-state">
            <div className="empty-icon">📊</div>
            <p>No data yet</p>
            <p className="text-muted">Complete some games to see graphs</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default GraphsScreen;

