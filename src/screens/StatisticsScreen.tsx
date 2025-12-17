import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { PlayerStats, Player, PlayerType, GamePlayer } from '../types';
import { getPlayerStats, getAllPlayers, getAllGames, getAllGamePlayers } from '../database/storage';
import { formatCurrency, getProfitColor, cleanNumber } from '../utils/calculations';

type TimePeriod = 'all' | 'h1' | 'h2' | 'year' | 'custom';

const StatisticsScreen = () => {
  const navigate = useNavigate();
  const [stats, setStats] = useState<PlayerStats[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [viewMode, setViewMode] = useState<'table' | 'records' | 'individual'>('table');
  const [sortBy, setSortBy] = useState<'profit' | 'games' | 'winRate'>('profit');
  const [selectedPlayers, setSelectedPlayers] = useState<Set<string>>(new Set());
  const [selectedTypes, setSelectedTypes] = useState<Set<PlayerType>>(new Set(['permanent']));
  const [timePeriod, setTimePeriod] = useState<TimePeriod>(() => {
    // Default to current half year
    const currentMonth = new Date().getMonth() + 1; // 1-12
    return currentMonth <= 6 ? 'h1' : 'h2';
  });
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear());
  const [filterActiveOnly, setFilterActiveOnly] = useState(true); // Default: show only active players (> 33% of avg games)
  const [showPlayerFilter, setShowPlayerFilter] = useState(false); // Collapsed by default
  const [showTimePeriod, setShowTimePeriod] = useState(false); // Collapsed by default
  const [showPlayerType, setShowPlayerType] = useState(false); // Collapsed by default
  const [expandedRecords, setExpandedRecords] = useState<Set<string>>(new Set()); // Track which record sections are expanded
  const [recordDetails, setRecordDetails] = useState<{
    title: string;
    playerName: string;
    games: Array<{ date: string; profit: number; gameId: string }>;
  } | null>(null); // Modal for record details

  // Get available years from games
  const getAvailableYears = (): number[] => {
    const years = new Set<number>();
    const now = new Date();
    // Add current year and go back to 2021
    for (let y = now.getFullYear(); y >= 2021; y--) {
      years.add(y);
    }
    return Array.from(years).sort((a, b) => b - a);
  };

  // Get date filter based on time period
  const getDateFilter = (): { start?: Date; end?: Date } | undefined => {
    const now = new Date();
    const year = selectedYear;
    
    switch (timePeriod) {
      case 'h1': // First half of selected year (Jan-Jun)
        return {
          start: new Date(year, 0, 1),
          end: new Date(year, 5, 30, 23, 59, 59)
        };
      case 'h2': // Second half of selected year (Jul-Dec)
        return {
          start: new Date(year, 6, 1),
          end: new Date(year, 11, 31, 23, 59, 59)
        };
      case 'year': // Full selected year
        return {
          start: new Date(year, 0, 1),
          end: new Date(year, 11, 31, 23, 59, 59)
        };
      case 'all':
      default:
        return undefined;
    }
  };

  useEffect(() => {
    loadStats();
  }, [timePeriod, selectedYear]);

  const loadStats = () => {
    const dateFilter = getDateFilter();
    const playerStats = getPlayerStats(dateFilter);
    const allPlayers = getAllPlayers();
    setStats(playerStats);
    setPlayers(allPlayers);
    // By default, select only permanent players
    const permanentPlayerIds = allPlayers
      .filter(p => p.type === 'permanent')
      .map(p => p.id);
    const permanentStatsIds = playerStats
      .filter(s => permanentPlayerIds.includes(s.playerId))
      .map(s => s.playerId);
    setSelectedPlayers(new Set(permanentStatsIds.length > 0 ? permanentStatsIds : playerStats.map(p => p.playerId)));
  };

  // Get player type - memoized
  const getPlayerType = useCallback((playerId: string): PlayerType => {
    const player = players.find(p => p.id === playerId);
    return player?.type || 'permanent';
  }, [players]);

  // Calculate average games played across ALL players (for active filter)
  const avgGamesPlayed = useMemo(() => {
    if (stats.length === 0) return 0;
    const totalGames = stats.reduce((sum, s) => sum + s.gamesPlayed, 0);
    return totalGames / stats.length;
  }, [stats]);

  // Minimum games threshold = 33% of average
  const activeThreshold = useMemo(() => Math.ceil(avgGamesPlayed * 0.33), [avgGamesPlayed]);

  // Memoize filtered stats - filter by active threshold if enabled
  const statsWithMinGames = useMemo(() => 
    filterActiveOnly ? stats.filter(s => s.gamesPlayed >= activeThreshold) : stats,
    [stats, filterActiveOnly, activeThreshold]
  );

  // Separate stats by player type (after minGames filter) - memoized
  const permanentStats = useMemo(() => 
    statsWithMinGames.filter(s => getPlayerType(s.playerId) === 'permanent'),
    [statsWithMinGames, getPlayerType]
  );
  const permanentGuestStats = useMemo(() => 
    statsWithMinGames.filter(s => getPlayerType(s.playerId) === 'permanent_guest'),
    [statsWithMinGames, getPlayerType]
  );
  const guestStats = useMemo(() => 
    statsWithMinGames.filter(s => getPlayerType(s.playerId) === 'guest'),
    [statsWithMinGames, getPlayerType]
  );

  // Stats available for selection based on selected types - memoized
  const availableStats = useMemo(() => 
    statsWithMinGames.filter(s => selectedTypes.has(getPlayerType(s.playerId))),
    [statsWithMinGames, selectedTypes, getPlayerType]
  );

  // Toggle player selection
  const togglePlayer = useCallback((playerId: string) => {
    setSelectedPlayers(prev => {
      const newSet = new Set(prev);
      if (newSet.has(playerId)) {
        // Don't allow deselecting if only one player is selected
        if (newSet.size > 1) {
          newSet.delete(playerId);
        }
      } else {
        newSet.add(playerId);
      }
      return newSet;
    });
  }, []);

  // Select/Deselect all players
  const toggleAllPlayers = useCallback(() => {
    if (selectedPlayers.size === availableStats.length && availableStats.length > 0) {
      // If all selected - deselect all (keep only first for stats to work)
      setSelectedPlayers(new Set([availableStats[0]?.playerId].filter(Boolean)));
    } else if (selectedPlayers.size === 1 && availableStats.length > 0 && 
               selectedPlayers.has(availableStats[0]?.playerId)) {
      // If only first one is selected (after clear) - select all
      setSelectedPlayers(new Set(availableStats.map(p => p.playerId)));
    } else {
      // Otherwise - select all available
      setSelectedPlayers(new Set(availableStats.map(p => p.playerId)));
    }
  }, [selectedPlayers, availableStats]);

  // Toggle player type in filter
  const toggleType = useCallback((type: PlayerType) => {
    setSelectedTypes(prev => {
      const newSet = new Set(prev);
      if (newSet.has(type)) {
        // Don't allow deselecting if only one type is selected
        if (newSet.size > 1) {
          newSet.delete(type);
        }
      } else {
        newSet.add(type);
      }
      return newSet;
    });
  }, []);

  // Select all types
  const selectAllTypes = useCallback(() => {
    setSelectedTypes(new Set(['permanent', 'permanent_guest', 'guest']));
  }, []);

  // Create a stable key for selectedTypes to use in useEffect
  const selectedTypesKey = useMemo(() => 
    Array.from(selectedTypes).sort().join(','),
    [selectedTypes]
  );

  // Update selected players when types or active filter changes
  useEffect(() => {
    if (availableStats.length > 0) {
      setSelectedPlayers(new Set(availableStats.map(p => p.playerId)));
    }
  }, [selectedTypesKey, filterActiveOnly, stats.length]);

  // Filtered stats based on selection
  const filteredStats = useMemo(() => 
    availableStats.filter(s => selectedPlayers.has(s.playerId)),
    [availableStats, selectedPlayers]
  );


  const sortedStats = [...filteredStats].sort((a, b) => {
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

  // Calculate group records based on filtered stats
  // Helper to find all players tied for a record
  const findTied = <T extends PlayerStats>(
    arr: T[],
    getValue: (s: T) => number,
    sortDesc: boolean = true
  ): T[] => {
    if (arr.length === 0) return [];
    const sorted = [...arr].sort((a, b) => sortDesc ? getValue(b) - getValue(a) : getValue(a) - getValue(b));
    const topValue = getValue(sorted[0]);
    return sorted.filter(s => getValue(s) === topValue);
  };

  const getRecords = () => {
    if (filteredStats.length === 0) return null;
    
    const leaders = findTied(filteredStats, s => s.totalProfit, true);
    const biggestLosers = findTied(filteredStats, s => s.totalProfit, false);
    const biggestWinPlayers = findTied(filteredStats, s => s.biggestWin, true);
    const biggestLossPlayers = findTied(filteredStats, s => s.biggestLoss, false);
    const rebuyKings = findTied(filteredStats, s => s.totalRebuys, true);
    
    const qualifiedForWinRate = filteredStats.filter(s => s.gamesPlayed >= 3);
    const sharpshooters = qualifiedForWinRate.length > 0 
      ? findTied(qualifiedForWinRate, s => s.winPercentage, true)
      : [];
    const worstWinRates = qualifiedForWinRate.length > 0
      ? findTied(qualifiedForWinRate, s => s.winPercentage, false)
      : [];
    
    const onFirePlayers = findTied(filteredStats.filter(s => s.currentStreak > 0), s => s.currentStreak, true);
    const iceColdPlayers = findTied(filteredStats.filter(s => s.currentStreak < 0), s => s.currentStreak, false);
    const mostDedicatedPlayers = findTied(filteredStats, s => s.gamesPlayed, true);
    const longestWinStreakPlayers = findTied(filteredStats, s => s.longestWinStreak, true);
    const longestLossStreakPlayers = findTied(filteredStats, s => s.longestLossStreak, true);
    
    // Additional records
    const qualifiedForAvg = filteredStats.filter(s => s.gamesPlayed >= 3);
    const highestAvgProfits = qualifiedForAvg.length > 0
      ? findTied(qualifiedForAvg, s => s.avgProfit, true)
      : [];
    const lowestAvgProfits = qualifiedForAvg.length > 0
      ? findTied(qualifiedForAvg, s => s.avgProfit, false)
      : [];
    const mostWinsPlayers = findTied(filteredStats, s => s.winCount, true);
    const mostLossesPlayers = findTied(filteredStats, s => s.lossCount, true);
    
    return {
      leaders,
      biggestLosers,
      biggestWinPlayers,
      biggestLossPlayers,
      rebuyKings,
      sharpshooters,
      worstWinRates,
      onFirePlayers,
      iceColdPlayers,
      mostDedicatedPlayers,
      longestWinStreakPlayers,
      longestLossStreakPlayers,
      highestAvgProfits,
      lowestAvgProfits,
      mostWinsPlayers,
      mostLossesPlayers,
    };
  };

  // Toggle expanded state for a record
  const toggleRecordExpand = (recordKey: string) => {
    setExpandedRecords(prev => {
      const next = new Set(prev);
      if (next.has(recordKey)) {
        next.delete(recordKey);
      } else {
        next.add(recordKey);
      }
      return next;
    });
  };

  // Show record details modal
  const showRecordDetails = (title: string, player: PlayerStats, recordType: string) => {
    const allGames = getAllGames().filter(g => g.status === 'completed');
    const allGamePlayers = getAllGamePlayers();
    
    // Get all games for this player
    const playerGames = allGamePlayers
      .filter(gp => gp.playerId === player.playerId)
      .map(gp => {
        const game = allGames.find(g => g.id === gp.gameId);
        return game ? { date: game.date, profit: gp.profit, gameId: game.id } : null;
      })
      .filter((g): g is { date: string; profit: number; gameId: string } => g !== null)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    let filteredGames = playerGames;

    // Filter based on record type
    if (recordType === 'wins') {
      filteredGames = playerGames.filter(g => g.profit > 0);
    } else if (recordType === 'losses') {
      filteredGames = playerGames.filter(g => g.profit < 0);
    } else if (recordType === 'biggestWin') {
      const maxProfit = Math.max(...playerGames.map(g => g.profit));
      filteredGames = playerGames.filter(g => g.profit === maxProfit);
    } else if (recordType === 'biggestLoss') {
      const minProfit = Math.min(...playerGames.map(g => g.profit));
      filteredGames = playerGames.filter(g => g.profit === minProfit);
    } else if (recordType === 'currentWinStreak' || recordType === 'longestWinStreak') {
      // Find consecutive wins from most recent
      const streakGames: typeof playerGames = [];
      for (const game of playerGames) {
        if (game.profit > 0) {
          streakGames.push(game);
        } else if (recordType === 'currentWinStreak') {
          break; // Current streak stops at first loss
        }
      }
      filteredGames = recordType === 'currentWinStreak' ? streakGames : streakGames.slice(0, player.longestWinStreak);
    } else if (recordType === 'currentLossStreak' || recordType === 'longestLossStreak') {
      // Find consecutive losses from most recent
      const streakGames: typeof playerGames = [];
      for (const game of playerGames) {
        if (game.profit < 0) {
          streakGames.push(game);
        } else if (recordType === 'currentLossStreak') {
          break; // Current streak stops at first win
        }
      }
      filteredGames = recordType === 'currentLossStreak' ? streakGames : streakGames.slice(0, player.longestLossStreak);
    }

    setRecordDetails({
      title,
      playerName: player.playerName,
      games: filteredGames
    });
  };

  // Render a record with tie support
  const renderRecord = (
    recordKey: string,
    players: PlayerStats[],
    renderValue: (p: PlayerStats) => React.ReactNode,
    style?: React.CSSProperties,
    recordType?: string,
    recordTitle?: string
  ) => {
    if (players.length === 0) return null;
    const isExpanded = expandedRecords.has(recordKey);
    const hasTies = players.length > 1;
    const canShowDetails = recordType && recordTitle;
    
    return (
      <div style={{ ...style, display: 'flex', alignItems: 'center', gap: '0.3rem', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: '700' }}>{players[0].playerName}</span>
        {hasTies && (
          <span 
            style={{ 
              fontSize: '0.6rem', 
              background: 'var(--primary)', 
              color: 'white',
              padding: '0.1rem 0.25rem',
              borderRadius: '6px',
              fontWeight: '600',
              cursor: 'pointer'
            }}
            onClick={() => toggleRecordExpand(recordKey)}
          >
            +{players.length - 1} {isExpanded ? '▲' : '▼'}
          </span>
        )}
        {renderValue(players[0])}
        {canShowDetails && (
          <span
            style={{ 
              fontSize: '0.55rem', 
              cursor: 'pointer',
              background: 'var(--primary)',
              color: 'white',
              padding: '0.15rem 0.3rem',
              borderRadius: '4px',
              fontWeight: '600',
              marginLeft: '0.2rem'
            }}
            onClick={() => showRecordDetails(recordTitle, players[0], recordType)}
            title="לחץ לפרטים"
          >
            פרטים ❯
          </span>
        )}
        {isExpanded && hasTies && (
          <div style={{ 
            width: '100%',
            marginTop: '0.2rem', 
            paddingTop: '0.2rem', 
            borderTop: '1px dashed var(--border)',
            fontSize: '0.75rem',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.3rem'
          }}>
            {players.slice(1).map(p => (
              <span key={p.playerId} style={{ fontWeight: '500' }}>
                {p.playerName}{p !== players[players.length - 1] ? ',' : ''}
              </span>
            ))}
          </div>
        )}
      </div>
    );
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

          {/* Player Selector */}
          <div className="card" style={{ padding: '0.75rem' }}>
            {/* Active Players Filter - Toggle Switch (FIRST) */}
            <div style={{ 
              marginBottom: '0.75rem',
              paddingBottom: '0.75rem',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>🎮</span>
                <span style={{ fontSize: '0.7rem', color: filterActiveOnly ? 'var(--primary)' : 'var(--text-muted)', fontWeight: '500' }}>
                  פעילים בלבד
                </span>
                <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                  ({activeThreshold}+)
                </span>
              </div>
              <button
                onClick={() => setFilterActiveOnly(!filterActiveOnly)}
                style={{ 
                  position: 'relative',
                  width: '36px',
                  height: '20px',
                  borderRadius: '10px',
                  border: 'none',
                  background: filterActiveOnly ? 'var(--primary)' : 'var(--border)',
                  cursor: 'pointer',
                  transition: 'background 0.2s ease',
                  padding: 0
                }}
              >
                <span style={{
                  position: 'absolute',
                  top: '2px',
                  left: filterActiveOnly ? '18px' : '2px',
                  width: '16px',
                  height: '16px',
                  borderRadius: '50%',
                  background: 'white',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                  transition: 'left 0.2s ease'
                }} />
              </button>
            </div>

            {/* Time Period Filter */}
            <div style={{ 
              marginBottom: '0.75rem',
              paddingBottom: '0.75rem',
              borderBottom: '1px solid var(--border)'
            }}>
              <button
                onClick={() => setShowTimePeriod(!showTimePeriod)}
                style={{ 
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  width: '100%', padding: 0, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text)',
                  marginBottom: showTimePeriod ? '0.5rem' : 0
                }}
              >
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: '600' }}>
                  📅 TIME PERIOD {timePeriod !== 'all' ? `(${timePeriod === 'year' ? selectedYear : timePeriod.toUpperCase() + ' ' + selectedYear})` : '(הכל)'}
                </span>
                <span style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>{showTimePeriod ? '▲' : '▼'}</span>
              </button>
              {showTimePeriod && (
              <>
              <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                <button
                  onClick={() => setTimePeriod('all')}
                  style={{
                    flex: 1,
                    minWidth: '50px',
                    padding: '0.4rem',
                    fontSize: '0.7rem',
                    borderRadius: '6px',
                    border: timePeriod === 'all' ? '2px solid var(--primary)' : '1px solid var(--border)',
                    background: timePeriod === 'all' ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
                    color: timePeriod === 'all' ? 'var(--primary)' : 'var(--text-muted)',
                    cursor: 'pointer'
                  }}
                >
                  הכל
                </button>
                <button
                  onClick={() => setTimePeriod('year')}
                  style={{
                    flex: 1,
                    minWidth: '50px',
                    padding: '0.4rem',
                    fontSize: '0.7rem',
                    borderRadius: '6px',
                    border: timePeriod === 'year' ? '2px solid var(--primary)' : '1px solid var(--border)',
                    background: timePeriod === 'year' ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
                    color: timePeriod === 'year' ? 'var(--primary)' : 'var(--text-muted)',
                    cursor: 'pointer'
                  }}
                >
                  שנה
                </button>
                <button
                  onClick={() => setTimePeriod('h1')}
                  style={{
                    flex: 1,
                    minWidth: '50px',
                    padding: '0.4rem',
                    fontSize: '0.7rem',
                    borderRadius: '6px',
                    border: timePeriod === 'h1' ? '2px solid var(--primary)' : '1px solid var(--border)',
                    background: timePeriod === 'h1' ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
                    color: timePeriod === 'h1' ? 'var(--primary)' : 'var(--text-muted)',
                    cursor: 'pointer'
                  }}
                >
                  H1
                </button>
                <button
                  onClick={() => setTimePeriod('h2')}
                  style={{
                    flex: 1,
                    minWidth: '50px',
                    padding: '0.4rem',
                    fontSize: '0.7rem',
                    borderRadius: '6px',
                    border: timePeriod === 'h2' ? '2px solid var(--primary)' : '1px solid var(--border)',
                    background: timePeriod === 'h2' ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
                    color: timePeriod === 'h2' ? 'var(--primary)' : 'var(--text-muted)',
                    cursor: 'pointer'
                  }}
                >
                  H2
                </button>
              </div>
              {/* Year Selector - only show when not "all" */}
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

            {/* Player Type Filter (Multi-select) */}
            <div style={{ 
              marginBottom: '0.75rem',
              paddingBottom: '0.75rem',
              borderBottom: '1px solid var(--border)'
            }}>
              <button
                onClick={() => setShowPlayerType(!showPlayerType)}
                style={{ 
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  width: '100%', padding: 0, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text)',
                  marginBottom: showPlayerType ? '0.5rem' : 0
                }}
              >
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: '600' }}>
                  PLAYER TYPE ({selectedTypes.size === 3 ? 'הכל' : Array.from(selectedTypes).map(t => t === 'permanent' ? 'קבוע' : t === 'permanent_guest' ? 'אורח' : 'מזדמן').join(', ')})
                </span>
                <span style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>{showPlayerType ? '▲' : '▼'}</span>
              </button>
              {showPlayerType && (
              <>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.4rem' }}>
                <button
                  onClick={selectAllTypes}
                  style={{
                    padding: '0.2rem 0.4rem',
                    fontSize: '0.65rem',
                    borderRadius: '4px',
                    border: '1px solid var(--border)',
                    background: 'var(--surface)',
                    color: 'var(--text-muted)',
                    cursor: 'pointer'
                  }}
                >
                  הכל
                </button>
              </div>
              <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                <button
                  onClick={() => toggleType('permanent')}
                  style={{
                    flex: 1,
                    minWidth: '60px',
                    padding: '0.4rem',
                    fontSize: '0.7rem',
                    borderRadius: '6px',
                    border: selectedTypes.has('permanent') ? '2px solid var(--primary)' : '1px solid var(--border)',
                    background: selectedTypes.has('permanent') ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
                    color: selectedTypes.has('permanent') ? 'var(--primary)' : 'var(--text-muted)',
                    cursor: 'pointer'
                  }}
                >
                  {selectedTypes.has('permanent') && '✓ '}⭐ קבוע ({permanentStats.length})
                </button>
                <button
                  onClick={() => toggleType('permanent_guest')}
                  style={{
                    flex: 1,
                    minWidth: '60px',
                    padding: '0.4rem',
                    fontSize: '0.7rem',
                    borderRadius: '6px',
                    border: selectedTypes.has('permanent_guest') ? '2px solid var(--primary)' : '1px solid var(--border)',
                    background: selectedTypes.has('permanent_guest') ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
                    color: selectedTypes.has('permanent_guest') ? 'var(--primary)' : 'var(--text-muted)',
                    cursor: 'pointer'
                  }}
                >
                  {selectedTypes.has('permanent_guest') && '✓ '}🏠 אורח ({permanentGuestStats.length})
                </button>
                <button
                  onClick={() => toggleType('guest')}
                  style={{
                    flex: 1,
                    minWidth: '60px',
                    padding: '0.4rem',
                    fontSize: '0.7rem',
                    borderRadius: '6px',
                    border: selectedTypes.has('guest') ? '2px solid var(--primary)' : '1px solid var(--border)',
                    background: selectedTypes.has('guest') ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
                    color: selectedTypes.has('guest') ? 'var(--primary)' : 'var(--text-muted)',
                    cursor: 'pointer'
                  }}
                >
                  {selectedTypes.has('guest') && '✓ '}👤 מזדמן ({guestStats.length})
                </button>
              </div>
              </>
              )}
            </div>

            <button 
              onClick={() => setShowPlayerFilter(!showPlayerFilter)}
              style={{ 
                display: 'flex', 
                justifyContent: 'space-between', 
                alignItems: 'center',
                width: '100%',
                padding: 0,
                marginBottom: showPlayerFilter ? '0.5rem' : 0,
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--text)'
              }}
            >
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: '600' }}>
                FILTER PLAYERS ({selectedPlayers.size}/{availableStats.length})
              </span>
              <span style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>
                {showPlayerFilter ? '▲' : '▼'}
              </span>
            </button>
            {showPlayerFilter && (
              <>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.4rem' }}>
                  <button
                    onClick={toggleAllPlayers}
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
                    {selectedPlayers.size === availableStats.length ? 'Clear' : 'Select All'}
                  </button>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                  {availableStats.map(player => {
                    const isSelected = selectedPlayers.has(player.playerId);
                    const isGuest = getPlayerType(player.playerId) === 'guest';
                    return (
                      <button
                        key={player.playerId}
                        onClick={() => togglePlayer(player.playerId)}
                        style={{
                          padding: '0.4rem 0.65rem',
                          borderRadius: '16px',
                          border: isSelected ? '2px solid var(--primary)' : '2px solid var(--border)',
                          background: isSelected ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
                          cursor: 'pointer',
                          fontSize: '0.8rem',
                          fontWeight: '600',
                          color: isSelected ? 'var(--primary)' : 'var(--text-muted)',
                          transition: 'all 0.15s ease'
                        }}
                      >
                        {isSelected && '✓ '}{isGuest && '👤 '}{player.playerName}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
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
                    {records.onFirePlayers.length > 0 ? (
                      renderRecord(
                        'onFire',
                        records.onFirePlayers,
                        (p) => <div style={{ fontSize: '0.9rem', color: 'var(--success)' }}>{p.currentStreak} wins in a row!</div>,
                        { fontSize: '1.25rem', color: '#f97316' },
                        'currentWinStreak',
                        '🔥 רצף נצחונות נוכחי'
                      )
                    ) : (
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>No active win streak</div>
                    )}
                  </div>
                  <div style={{ 
                    padding: '1rem', 
                    background: 'linear-gradient(135deg, rgba(239, 68, 68, 0.2), rgba(220, 38, 38, 0.1))',
                    borderRadius: '12px',
                    textAlign: 'center',
                    border: '1px solid rgba(239, 68, 68, 0.3)'
                  }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>❄️ Cold Streak</div>
                    {records.iceColdPlayers.length > 0 ? (
                      renderRecord(
                        'iceCold',
                        records.iceColdPlayers,
                        (p) => <div style={{ fontSize: '0.9rem', color: 'var(--danger)' }}>{Math.abs(p.currentStreak)} losses in a row</div>,
                        { fontSize: '1.25rem', color: '#ef4444' },
                        'currentLossStreak',
                        '❄️ רצף הפסדים נוכחי'
                      )
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
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '0.75rem', background: 'rgba(34, 197, 94, 0.1)', borderRadius: '8px', borderLeft: '4px solid var(--success)' }}>
                    <div style={{ flex: 1 }}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>🥇 All-Time Leader</span>
                      {renderRecord(
                        'leader',
                        records.leaders,
                        (p) => <div className="profit" style={{ fontSize: '1.1rem', fontWeight: '700' }}>+{formatCurrency(p.totalProfit)}</div>,
                        { fontSize: '1.1rem' },
                        'all',
                        '🥇 כל המשחקים'
                      )}
                    </div>
                  </div>
                  
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '0.75rem', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '8px', borderLeft: '4px solid var(--danger)' }}>
                    <div style={{ flex: 1 }}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>📉 Biggest Loser</span>
                      {renderRecord(
                        'biggestLoser',
                        records.biggestLosers,
                        (p) => <div className="loss" style={{ fontSize: '1.1rem', fontWeight: '700' }}>{formatCurrency(p.totalProfit)}</div>,
                        { fontSize: '1.1rem' },
                        'all',
                        '📉 כל המשחקים'
                      )}
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
                    {renderRecord(
                      'biggestWin',
                      records.biggestWinPlayers,
                      (p) => <div className="profit" style={{ fontWeight: '700' }}>+{formatCurrency(p.biggestWin)}</div>,
                      undefined,
                      'biggestWin',
                      '💰 הניצחון הגדול'
                    )}
                  </div>
                  <div style={{ padding: '0.75rem', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '8px', textAlign: 'center' }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>💸 Biggest Loss</div>
                    {renderRecord(
                      'biggestLoss',
                      records.biggestLossPlayers,
                      (p) => <div className="loss" style={{ fontWeight: '700' }}>{formatCurrency(p.biggestLoss)}</div>,
                      undefined,
                      'biggestLoss',
                      '💸 ההפסד הגדול'
                    )}
                  </div>
                </div>
              </div>

              {/* Streak Records - only show if there are meaningful streaks */}
              {(records.longestWinStreakPlayers[0]?.longestWinStreak > 1 || records.longestLossStreakPlayers[0]?.longestLossStreak > 1) && (
                <div className="card">
                  <h2 className="card-title mb-2">📈 Streak Records</h2>
                  <div className="grid grid-2">
                    {records.longestWinStreakPlayers[0]?.longestWinStreak > 1 && (
                      <div style={{ padding: '0.75rem', background: 'rgba(34, 197, 94, 0.1)', borderRadius: '8px', textAlign: 'center' }}>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>🏆 Longest Win Streak</div>
                        {renderRecord(
                          'longestWinStreak',
                          records.longestWinStreakPlayers.filter(p => p.longestWinStreak > 1),
                          (p) => <div style={{ color: 'var(--success)', fontWeight: '700' }}>{p.longestWinStreak} wins</div>,
                          undefined,
                          'longestWinStreak',
                          '🏆 רצף נצחונות ארוך'
                        )}
                      </div>
                    )}
                    {records.longestLossStreakPlayers[0]?.longestLossStreak > 1 && (
                      <div style={{ padding: '0.75rem', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '8px', textAlign: 'center' }}>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>💔 Longest Loss Streak</div>
                        {renderRecord(
                          'longestLossStreak',
                          records.longestLossStreakPlayers.filter(p => p.longestLossStreak > 1),
                          (p) => <div style={{ color: 'var(--danger)', fontWeight: '700' }}>{p.longestLossStreak} losses</div>,
                          undefined,
                          'longestLossStreak',
                          '💔 רצף הפסדים ארוך'
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Average Performance Records */}
              {(records.highestAvgProfits.length > 0 || records.lowestAvgProfits.length > 0) && (
                <div className="card">
                  <h2 className="card-title mb-2">📊 Average Performance</h2>
                  <div className="grid grid-2">
                    {records.highestAvgProfits.length > 0 && (
                      <div style={{ padding: '0.75rem', background: 'rgba(34, 197, 94, 0.1)', borderRadius: '8px', textAlign: 'center' }}>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>📈 Best Avg/Game</div>
                        {renderRecord(
                          'highestAvgProfit',
                          records.highestAvgProfits,
                          (p) => <div className="profit" style={{ fontWeight: '700' }}>+{formatCurrency(p.avgProfit)}</div>,
                          undefined,
                          'all',
                          '📈 ממוצע למשחק'
                        )}
                      </div>
                    )}
                    {records.lowestAvgProfits.length > 0 && (
                      <div style={{ padding: '0.75rem', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '8px', textAlign: 'center' }}>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>📉 Worst Avg/Game</div>
                        {renderRecord(
                          'lowestAvgProfit',
                          records.lowestAvgProfits,
                          (p) => <div className="loss" style={{ fontWeight: '700' }}>{formatCurrency(p.avgProfit)}</div>,
                          undefined,
                          'all',
                          '📉 ממוצע למשחק'
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Other Records */}
              <div className="card">
                <h2 className="card-title mb-2">🎖️ Other Records</h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ color: 'var(--text-muted)' }}>🎮 Most Games</span>
                    {renderRecord(
                      'mostGames',
                      records.mostDedicatedPlayers,
                      (p) => <span style={{ fontWeight: '600' }}>({p.gamesPlayed})</span>,
                      undefined,
                      'all',
                      '🎮 כל המשחקים'
                    )}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ color: 'var(--text-muted)' }}>🏆 Most Wins</span>
                    {renderRecord(
                      'mostWins',
                      records.mostWinsPlayers,
                      (p) => <span style={{ fontWeight: '600', color: 'var(--success)' }}>({p.winCount})</span>,
                      undefined,
                      'wins',
                      '🏆 ניצחונות'
                    )}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ color: 'var(--text-muted)' }}>💔 Most Losses</span>
                    {renderRecord(
                      'mostLosses',
                      records.mostLossesPlayers,
                      (p) => <span style={{ fontWeight: '600', color: 'var(--danger)' }}>({p.lossCount})</span>,
                      undefined,
                      'losses',
                      '💔 הפסדים'
                    )}
                  </div>
                  {records.sharpshooters.length > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                      <span style={{ color: 'var(--text-muted)' }}>🎯 Best Win Rate</span>
                      {renderRecord(
                        'sharpshooter',
                        records.sharpshooters,
                        (p) => <span style={{ fontWeight: '600', color: 'var(--success)' }}>({p.winPercentage.toFixed(0)}%)</span>,
                        undefined,
                        'wins',
                        '🎯 ניצחונות'
                      )}
                    </div>
                  )}
                  {records.worstWinRates.length > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                      <span style={{ color: 'var(--text-muted)' }}>🎲 Worst Win Rate</span>
                      {renderRecord(
                        'worstWinRate',
                        records.worstWinRates,
                        (p) => <span style={{ fontWeight: '600', color: 'var(--danger)' }}>({p.winPercentage.toFixed(0)}%)</span>,
                        undefined,
                        'losses',
                        '🎲 הפסדים'
                      )}
                    </div>
                  )}
                  {records.rebuyKings[0]?.totalRebuys > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '0.5rem 0' }}>
                      <span style={{ color: 'var(--text-muted)' }}>🎰 Buyin King</span>
                      {renderRecord(
                        'rebuyKing',
                        records.rebuyKings.filter(p => p.totalRebuys > 0),
                        (p) => <span style={{ fontWeight: '600' }}>({p.totalRebuys} total)</span>,
                        undefined,
                        'all',
                        '🎰 כל המשחקים'
                      )}
                    </div>
                  )}
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
                  style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.15rem', padding: '0.5rem' }}
                >
                  <span>💰</span>
                  <span style={{ fontSize: '0.7rem' }}>Profit</span>
                </button>
                <button 
                  className={`btn btn-sm ${sortBy === 'games' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setSortBy('games')}
                  style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.15rem', padding: '0.5rem' }}
                >
                  <span>🎮</span>
                  <span style={{ fontSize: '0.7rem' }}>Games</span>
                </button>
                <button 
                  className={`btn btn-sm ${sortBy === 'winRate' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setSortBy('winRate')}
                  style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.15rem', padding: '0.5rem' }}
                >
                  <span>📊</span>
                  <span style={{ fontSize: '0.7rem' }}>Win Rate</span>
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
                    ? 'linear-gradient(135deg, rgba(34, 197, 94, 0.3), rgba(22, 163, 74, 0.2))' 
                    : 'linear-gradient(135deg, rgba(239, 68, 68, 0.3), rgba(220, 38, 38, 0.2))',
                  color: player.currentStreak > 0 ? '#22c55e' : '#ef4444',
                  border: `1px solid ${player.currentStreak > 0 ? 'rgba(34, 197, 94, 0.4)' : 'rgba(239, 68, 68, 0.4)'}`
                }}>
                  {player.currentStreak > 0 ? '🔥' : '❄️'} {Math.abs(player.currentStreak)} {player.currentStreak > 0 ? 'wins' : 'losses'} in a row
                </div>
              )}

              {/* Last 6 Games */}
              {player.lastGameResults && player.lastGameResults.length > 0 && (
                <div style={{ marginBottom: '0.75rem' }}>
                  <div className="text-muted" style={{ fontSize: '0.7rem', marginBottom: '0.35rem' }}>Last {player.lastGameResults.length} games</div>
                  <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'flex-start' }}>
                    {player.lastGameResults.map((game, i) => {
                      const gameDate = new Date(game.date);
                      const dateStr = gameDate.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' });
                      return (
                        <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                          <div 
                            style={{
                              width: '32px',
                              height: '32px',
                              borderRadius: '6px',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: '0.9rem',
                              fontWeight: '700',
                              background: game.profit > 0 ? 'rgba(34, 197, 94, 0.2)' : game.profit < 0 ? 'rgba(239, 68, 68, 0.2)' : 'rgba(156, 163, 175, 0.2)',
                              color: game.profit > 0 ? 'var(--success)' : game.profit < 0 ? 'var(--danger)' : 'var(--text-muted)',
                              border: `1px solid ${game.profit > 0 ? 'var(--success)' : game.profit < 0 ? 'var(--danger)' : 'var(--border)'}`
                            }}
                          >
                            {game.profit > 0 ? 'W' : game.profit < 0 ? 'L' : '-'}
                          </div>
                          <div style={{ 
                            fontSize: '0.5rem', 
                            color: 'var(--text-muted)', 
                            marginTop: '2px',
                            whiteSpace: 'nowrap'
                          }}>{dateStr}</div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Main Stats Row 1 */}
              <div className="grid grid-4" style={{ marginBottom: '0.5rem' }}>
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
                  <div className="stat-value" style={{ color: player.winCount > 0 ? 'var(--success)' : 'var(--text-muted)' }}>
                    {player.winCount}
                  </div>
                  <div className="stat-label">Wins</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value" style={{ color: player.lossCount > 0 ? 'var(--danger)' : 'var(--text-muted)' }}>
                    {player.lossCount}
                  </div>
                  <div className="stat-label">Losses</div>
                </div>
              </div>

              {/* Main Stats Row 2 */}
              <div className="grid grid-4" style={{ marginBottom: '0.5rem' }}>
                <div className="stat-card">
                  <div className="stat-value" style={{ color: 'var(--success)' }}>
                    {player.biggestWin > 0 ? `+₪${cleanNumber(player.biggestWin)}` : '-'}
                  </div>
                  <div className="stat-label">Best Win</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value" style={{ color: 'var(--danger)' }}>
                    {player.biggestLoss < 0 ? `₪${cleanNumber(Math.abs(player.biggestLoss))}` : '-'}
                  </div>
                  <div className="stat-label">Worst Loss</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value" style={{ color: player.avgWin > 0 ? 'var(--success)' : 'var(--text-muted)' }}>
                    {player.avgWin > 0 ? `+₪${cleanNumber(player.avgWin)}` : '-'}
                  </div>
                  <div className="stat-label">Avg Win</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value" style={{ color: player.avgLoss > 0 ? 'var(--danger)' : 'var(--text-muted)' }}>
                    {player.avgLoss > 0 ? `₪${cleanNumber(player.avgLoss)}` : '-'}
                  </div>
                  <div className="stat-label">Avg Loss</div>
                </div>
              </div>

              {/* Additional Stats Row */}
              <div className="grid grid-4">
                <div className="stat-card">
                  <div className="stat-value" style={{ color: player.avgProfit >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                    {player.avgProfit >= 0 ? '+' : ''}₪{cleanNumber(player.avgProfit)}
                  </div>
                  <div className="stat-label">Avg/Game</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value" style={{ color: 'var(--text)' }}>{player.totalRebuys}</div>
                  <div className="stat-label">Total Buyins</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value" style={{ color: player.longestWinStreak > 0 ? 'var(--success)' : 'var(--text-muted)' }}>
                    {player.longestWinStreak > 0 ? player.longestWinStreak : '-'}
                  </div>
                  <div className="stat-label">Best Streak</div>
                </div>
                <div className="stat-card">
                  <div className="stat-value" style={{ color: player.longestLossStreak > 0 ? 'var(--danger)' : 'var(--text-muted)' }}>
                    {player.longestLossStreak > 0 ? player.longestLossStreak : '-'}
                  </div>
                  <div className="stat-label">Worst Streak</div>
                </div>
              </div>
            </div>
          ))}

          </>
      )}

      {/* Record Details Modal */}
      {recordDetails && (
        <div 
          className="modal-overlay" 
          onClick={() => setRecordDetails(null)}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '1rem'
          }}
        >
          <div 
            className="modal"
            onClick={e => e.stopPropagation()}
            style={{
              background: 'var(--card)',
              borderRadius: '12px',
              padding: '1rem',
              maxWidth: '400px',
              width: '100%',
              maxHeight: '70vh',
              overflow: 'auto'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '1rem' }}>{recordDetails.title}</h3>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{recordDetails.playerName}</div>
              </div>
              <button 
                onClick={() => setRecordDetails(null)}
                style={{ 
                  background: 'none', 
                  border: 'none', 
                  fontSize: '1.5rem', 
                  cursor: 'pointer',
                  color: 'var(--text-muted)'
                }}
              >
                ×
              </button>
            </div>
            
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
              {recordDetails.games.length} משחקים
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              {recordDetails.games.map((game, idx) => (
                <div 
                  key={idx}
                  onClick={() => {
                    setRecordDetails(null);
                    navigate(`/game/${game.gameId}`, { state: { from: 'records' } });
                  }}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '0.5rem 0.75rem',
                    background: 'var(--surface)',
                    borderRadius: '6px',
                    borderRight: `3px solid ${game.profit > 0 ? 'var(--success)' : game.profit < 0 ? 'var(--danger)' : 'var(--border)'}`,
                    cursor: 'pointer',
                    transition: 'background 0.2s'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--border)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'var(--surface)'}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text)' }}>
                      {new Date(game.date).toLocaleDateString('en-GB', { 
                        day: '2-digit', 
                        month: '2-digit',
                        year: 'numeric'
                      })}
                    </span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>❯</span>
                  </div>
                  <span style={{ 
                    fontWeight: '600',
                    color: game.profit > 0 ? 'var(--success)' : game.profit < 0 ? 'var(--danger)' : 'var(--text)'
                  }}>
                    {game.profit > 0 ? '+' : ''}{formatCurrency(game.profit)}
                  </span>
                </div>
              ))}
            </div>
            
            {recordDetails.games.length === 0 && (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '1rem' }}>
                אין נתונים להצגה
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default StatisticsScreen;

