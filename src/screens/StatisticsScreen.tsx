import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import html2canvas from 'html2canvas';
import { PlayerStats, Player, PlayerType, GamePlayer } from '../types';
import { getPlayerStats, getAllPlayers, getAllGames, getAllGamePlayers } from '../database/storage';
import { formatCurrency, getProfitColor, cleanNumber } from '../utils/calculations';

type TimePeriod = 'all' | 'h1' | 'h2' | 'year' | 'month';

const StatisticsScreen = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const locationState = location.state as { 
    viewMode?: 'table' | 'records' | 'individual';
    recordInfo?: { title: string; playerId: string; recordType: string };
    playerInfo?: { playerId: string; playerName: string };
    timePeriod?: TimePeriod;
    selectedYear?: number;
    selectedMonth?: number;
  } | null;
  const initialViewMode = locationState?.viewMode || 'table';
  const savedRecordInfo = locationState?.recordInfo;
  const savedPlayerInfo = locationState?.playerInfo;
  const savedTimePeriod = locationState?.timePeriod;
  const savedSelectedYear = locationState?.selectedYear;
  const savedSelectedMonth = locationState?.selectedMonth;
  
  const [stats, setStats] = useState<PlayerStats[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [viewMode, setViewMode] = useState<'table' | 'records' | 'individual'>(initialViewMode);
  const [selectedIndividualPlayer, setSelectedIndividualPlayer] = useState<string | null>(savedPlayerInfo?.playerId || null);
  const [sortBy, setSortBy] = useState<'profit' | 'games' | 'winRate'>('profit');
  const [tableMode, setTableMode] = useState<'profit' | 'gainLoss'>('profit');
  const [selectedPlayers, setSelectedPlayers] = useState<Set<string>>(new Set());
  const [selectedTypes, setSelectedTypes] = useState<Set<PlayerType>>(new Set(['permanent']));
  const [timePeriod, setTimePeriod] = useState<TimePeriod>(() => {
    // Restore from navigation state if available, otherwise default to current half year
    if (savedTimePeriod) return savedTimePeriod;
    const currentMonth = new Date().getMonth() + 1; // 1-12
    return currentMonth <= 6 ? 'h1' : 'h2';
  });
  const [selectedYear, setSelectedYear] = useState<number>(savedSelectedYear || new Date().getFullYear());
  const [selectedMonth, setSelectedMonth] = useState<number>(savedSelectedMonth || new Date().getMonth() + 1); // 1-12
  const [filterActiveOnly, setFilterActiveOnly] = useState(true); // Default: show only active players (> 33% of avg games)
  const [showPlayerFilter, setShowPlayerFilter] = useState(false); // Collapsed by default
  const [showTimePeriod, setShowTimePeriod] = useState(false); // Collapsed by default
  const [showPlayerType, setShowPlayerType] = useState(false); // Collapsed by default
  const [expandedRecords, setExpandedRecords] = useState<Set<string>>(new Set()); // Track which record sections are expanded
  const [recordDetails, setRecordDetails] = useState<{
    title: string;
    playerName: string;
    playerId: string;
    recordType: string;
    games: Array<{ date: string; profit: number; gameId: string }>;
  } | null>(null); // Modal for record details
  const [playerAllGames, setPlayerAllGames] = useState<{
    playerName: string;
    playerId: string;
    games: Array<{ date: string; profit: number; gameId: string }>;
  } | null>(null); // Modal for all player games
  const [isSharing, setIsSharing] = useState(false);
  const [isSharingTop20, setIsSharingTop20] = useState(false);
  const tableRef = useRef<HTMLDivElement>(null);
  const top20Ref = useRef<HTMLDivElement>(null);

  // Get formatted timeframe string for display
  const getTimeframeLabel = () => {
    if (timePeriod === 'all') return 'All Time';
    if (timePeriod === 'year') return `${selectedYear}`;
    if (timePeriod === 'h1') return `H1 ${selectedYear}`;
    if (timePeriod === 'h2') return `H2 ${selectedYear}`;
    if (timePeriod === 'month') {
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return `${monthNames[selectedMonth - 1]} ${selectedYear}`;
    }
    return '';
  };

  // Share table as screenshot to WhatsApp
  const handleShareTable = async () => {
    if (!tableRef.current) return;
    
    setIsSharing(true);
    try {
      const canvas = await html2canvas(tableRef.current, {
        backgroundColor: '#1a1a2e',
        scale: 2,
      });
      
      canvas.toBlob(async (blob) => {
        if (!blob) {
          setIsSharing(false);
          return;
        }
        
        const file = new File([blob], 'poker-statistics.png', { type: 'image/png' });
        
        if (navigator.share && navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({
              files: [file],
              title: 'Poker Statistics',
            });
          } catch (err) {
            // User cancelled or share failed - download instead
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'poker-statistics.png';
            a.click();
            URL.revokeObjectURL(url);
          }
        } else {
          // Fallback: download the image
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'poker-statistics.png';
          a.click();
          URL.revokeObjectURL(url);
        }
        setIsSharing(false);
      }, 'image/png');
    } catch (error) {
      console.error('Error sharing:', error);
      setIsSharing(false);
    }
  };

  // Get top 20 single night wins (all-time, all players)
  const top20Wins = useMemo(() => {
    const allGames = getAllGames().filter(g => g.status === 'completed');
    const allGamePlayers = getAllGamePlayers();
    
    // Create array of all player-game results
    const allResults: Array<{
      playerName: string;
      profit: number;
      date: string;
      gameId: string;
      playersCount: number;
    }> = [];
    
    for (const game of allGames) {
      const gamePlayers = allGamePlayers.filter(gp => gp.gameId === game.id);
      const playersCount = gamePlayers.length;
      
      for (const gp of gamePlayers) {
        if (gp.profit > 0) { // Only wins
          allResults.push({
            playerName: gp.playerName,
            profit: gp.profit,
            date: game.date,
            gameId: game.id,
            playersCount
          });
        }
      }
    }
    
    // Sort by profit descending and take top 20
    return allResults
      .sort((a, b) => b.profit - a.profit)
      .slice(0, 20);
  }, [stats]); // Recalculate when stats change

  // Share top 20 table as screenshot
  const handleShareTop20 = async () => {
    if (!top20Ref.current) return;
    
    setIsSharingTop20(true);
    try {
      const canvas = await html2canvas(top20Ref.current, {
        backgroundColor: '#1a1a2e',
        scale: 2,
      });
      
      canvas.toBlob(async (blob) => {
        if (!blob) {
          setIsSharingTop20(false);
          return;
        }
        
        const file = new File([blob], 'poker-top20-wins.png', { type: 'image/png' });
        
        if (navigator.share && navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({
              files: [file],
              title: 'Top 20 Single Night Wins',
            });
          } catch (err) {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'poker-top20-wins.png';
            a.click();
            URL.revokeObjectURL(url);
          }
        } else {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'poker-top20-wins.png';
          a.click();
          URL.revokeObjectURL(url);
        }
        setIsSharingTop20(false);
      }, 'image/png');
    } catch (error) {
      console.error('Error sharing top 20:', error);
      setIsSharingTop20(false);
    }
  };

  // Show all games for a player (for table row click)
  const showPlayerGames = (player: PlayerStats) => {
    const dateFilter = getDateFilter();
    const allGames = getAllGames().filter(g => {
      if (g.status !== 'completed') return false;
      if (!dateFilter) return true;
      const gameDate = new Date(g.date);
      if (dateFilter.start && gameDate < dateFilter.start) return false;
      if (dateFilter.end && gameDate > dateFilter.end) return false;
      return true;
    });
    const allGamePlayers = getAllGamePlayers();
    
    const playerGames = allGamePlayers
      .filter(gp => gp.playerId === player.playerId)
      .map(gp => {
        const game = allGames.find(g => g.id === gp.gameId);
        return game ? { date: game.date, profit: gp.profit, gameId: game.id } : null;
      })
      .filter((g): g is { date: string; profit: number; gameId: string } => g !== null)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    setPlayerAllGames({
      playerName: player.playerName,
      playerId: player.playerId,
      games: playerGames
    });
  };

  // Show stat details for individual player view (uses recordDetails modal)
  const showPlayerStatDetails = (player: PlayerStats, statType: string, title: string) => {
    showRecordDetails(title, player, statType);
  };

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
      case 'month': // Specific month
        const monthIndex = selectedMonth - 1; // Convert 1-12 to 0-11
        const lastDay = new Date(year, monthIndex + 1, 0).getDate(); // Get last day of month
        return {
          start: new Date(year, monthIndex, 1),
          end: new Date(year, monthIndex, lastDay, 23, 59, 59)
        };
      case 'all':
      default:
        return undefined;
    }
  };

  useEffect(() => {
    loadStats();
  }, [timePeriod, selectedYear, selectedMonth]);

  // Restore record details modal when coming back from game details - only once on mount
  const hasRestoredRecordRef = useRef(false);
  useEffect(() => {
    if (savedRecordInfo && stats.length > 0 && !hasRestoredRecordRef.current) {
      hasRestoredRecordRef.current = true;
      const player = stats.find(s => s.playerId === savedRecordInfo.playerId);
      if (player) {
        // Restore the modal with the saved record info
        showRecordDetails(savedRecordInfo.title, player, savedRecordInfo.recordType);
      }
      // Clear the location state to prevent re-triggering
      window.history.replaceState({}, document.title);
    }
  }, [savedRecordInfo, stats]);

  // Scroll to selected player when coming back from individual game view
  useEffect(() => {
    if (savedPlayerInfo && viewMode === 'individual' && stats.length > 0) {
      // Small delay to ensure the cards are rendered
      setTimeout(() => {
        const playerCard = document.getElementById(`player-card-${savedPlayerInfo.playerId}`);
        if (playerCard) {
          playerCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
          // Add a brief highlight effect
          playerCard.style.boxShadow = '0 0 0 3px var(--primary)';
          setTimeout(() => {
            playerCard.style.boxShadow = '';
          }, 2000);
        }
        // Clear the location state to prevent re-triggering
        window.history.replaceState({}, document.title);
      }, 100);
    }
  }, [savedPlayerInfo, viewMode, stats]);

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

  // Calculate total games in the selected period (for active filter)
  const totalGamesInPeriod = useMemo(() => {
    const dateFilter = getDateFilter();
    const games = getAllGames().filter(g => {
      if (g.status !== 'completed') return false;
      if (!dateFilter) return true;
      const gameDate = new Date(g.date);
      if (dateFilter.start && gameDate < dateFilter.start) return false;
      if (dateFilter.end && gameDate > dateFilter.end) return false;
      return true;
    });
    return games.length;
  }, [timePeriod, selectedYear, selectedMonth]);

  // Minimum games threshold = 33% of total games in period
  const activeThreshold = useMemo(() => Math.ceil(totalGamesInPeriod * 0.33), [totalGamesInPeriod]);

  // Calculate previous rankings (before the last game in period) for movement indicator
  // This must use the SAME filters as the current view (player type, active filter)
  const previousRankings = useMemo(() => {
    const dateFilter = getDateFilter();
    const allGames = getAllGames().filter(g => {
      if (g.status !== 'completed') return false;
      if (!dateFilter) return true;
      const gameDate = new Date(g.date);
      if (dateFilter.start && gameDate < dateFilter.start) return false;
      if (dateFilter.end && gameDate > dateFilter.end) return false;
      return true;
    }).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    
    if (allGames.length < 2) return new Map<string, number>();
    
    // Get the last game ID to exclude
    const lastGameId = allGames[0].id;
    const allGamePlayers = getAllGamePlayers();
    
    // Calculate stats excluding the last game (same as current but without last game)
    const playerStatsMap = new Map<string, { profit: number; games: number }>();
    
    for (const gp of allGamePlayers) {
      if (gp.gameId === lastGameId) continue; // Skip last game
      const game = allGames.find(g => g.id === gp.gameId);
      if (!game) continue;
      
      const current = playerStatsMap.get(gp.playerId) || { profit: 0, games: 0 };
      playerStatsMap.set(gp.playerId, {
        profit: current.profit + gp.profit,
        games: current.games + 1
      });
    }
    
    // Calculate previous active threshold (games - 1 since we exclude last game)
    const prevTotalGames = allGames.length - 1;
    const prevActiveThreshold = Math.ceil(prevTotalGames * 0.33);
    
    // Filter by same criteria as current view
    const filteredPrevStats = [...playerStatsMap.entries()]
      .filter(([playerId, data]) => {
        // Apply player type filter
        const playerType = getPlayerType(playerId);
        if (!selectedTypes.has(playerType)) return false;
        
        // Apply active filter if enabled
        if (filterActiveOnly && data.games < prevActiveThreshold) return false;
        
        return true;
      });
    
    // Sort by profit to get rankings
    const sorted = filteredPrevStats.sort((a, b) => b[1].profit - a[1].profit);
    
    const rankMap = new Map<string, number>();
    sorted.forEach(([playerId], index) => {
      rankMap.set(playerId, index + 1);
    });
    
    return rankMap;
  }, [timePeriod, selectedYear, selectedMonth, stats, selectedTypes, filterActiveOnly, getPlayerType]);

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
    if (index === 0) return ' 🥇';
    if (index === 1) return ' 🥈';
    if (index === 2) return ' 🥉';
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
    // Apply the current date filter to games
    const dateFilter = getDateFilter();
    const allGames = getAllGames().filter(g => {
      if (g.status !== 'completed') return false;
      if (!dateFilter) return true;
      const gameDate = new Date(g.date);
      if (dateFilter.start && gameDate < dateFilter.start) return false;
      if (dateFilter.end && gameDate > dateFilter.end) return false;
      return true;
    });
    const allGamePlayers = getAllGamePlayers();
    
    // Get all games for this player (filtered by date)
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
    if (recordType === 'allGames') {
      // Show all games (no filtering needed)
      filteredGames = playerGames;
    } else if (recordType === 'wins') {
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
      playerId: player.playerId,
      recordType,
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
      <div style={{ ...style }}>
        <div 
          style={{ 
            display: 'flex', 
            alignItems: 'center', 
            gap: '0.3rem',
            cursor: canShowDetails ? 'pointer' : 'default'
          }}
          onClick={canShowDetails ? () => showRecordDetails(recordTitle, players[0], recordType) : undefined}
        >
          <span style={{ fontWeight: '700' }}>{players[0].playerName}</span>
          {hasTies && (
            <span 
              style={{ 
                fontSize: '0.6rem', 
                color: 'var(--text-muted)',
                cursor: 'pointer'
              }}
              onClick={(e) => { e.stopPropagation(); toggleRecordExpand(recordKey); }}
            >
              (+{players.length - 1})
            </span>
          )}
          {renderValue(players[0])}
          {canShowDetails && (
            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>❯</span>
          )}
        </div>
        {isExpanded && hasTies && (
          <div style={{ 
            marginTop: '0.25rem', 
            paddingTop: '0.25rem', 
            borderTop: '1px dashed var(--border)',
            fontSize: '0.8rem'
          }}>
            {players.slice(1).map(p => (
              <div 
                key={p.playerId} 
                style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: '0.3rem',
                  padding: '0.15rem 0',
                  cursor: canShowDetails ? 'pointer' : 'default'
                }}
                onClick={canShowDetails ? () => showRecordDetails(recordTitle!, p, recordType!) : undefined}
              >
                <span style={{ fontWeight: '500' }}>{p.playerName}</span>
                {canShowDetails && (
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>❯</span>
                )}
              </div>
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
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>🎮</span>
                  <span style={{ fontSize: '0.7rem', color: filterActiveOnly ? 'var(--primary)' : 'var(--text-muted)', fontWeight: '500' }}>
                    שחקנים פעילים בלבד
                </span>
                  <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                    ({activeThreshold}+ משחקים)
                  </span>
                </div>
                <span style={{ fontSize: '0.55rem', color: 'var(--text-muted)', marginLeft: '1.1rem' }}>
                  מינימום השתתפויות נדרשות: {activeThreshold}/{totalGamesInPeriod}
                </span>
              </div>
                <button
                type="button"
                onClick={(e) => { e.stopPropagation(); e.preventDefault(); setFilterActiveOnly(!filterActiveOnly); }}
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
                type="button"
                onClick={(e) => { e.stopPropagation(); e.preventDefault(); setShowTimePeriod(!showTimePeriod); }}
                style={{ 
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  width: '100%', padding: 0, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text)',
                  marginBottom: showTimePeriod ? '0.5rem' : 0
                }}
              >
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: '600' }}>
                  📅 TIME PERIOD {timePeriod === 'all' ? '(הכל)' : timePeriod === 'year' ? `(${selectedYear})` : timePeriod === 'month' ? `(${['ינו׳', 'פבר׳', 'מרץ', 'אפר׳', 'מאי', 'יוני', 'יולי', 'אוג׳', 'ספט׳', 'אוק׳', 'נוב׳', 'דצמ׳'][selectedMonth - 1]} ${selectedYear})` : `(${timePeriod.toUpperCase()} ${selectedYear})`}
                </span>
                <span style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>{showTimePeriod ? '▲' : '▼'}</span>
              </button>
              {showTimePeriod && (
              <>
              <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); e.preventDefault(); setTimePeriod('all'); }}
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
                  type="button"
                  onClick={(e) => { e.stopPropagation(); e.preventDefault(); setTimePeriod('year'); }}
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
                  type="button"
                  onClick={(e) => { e.stopPropagation(); e.preventDefault(); setTimePeriod('h1'); }}
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
                  type="button"
                  onClick={(e) => { e.stopPropagation(); e.preventDefault(); setTimePeriod('h2'); }}
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
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); e.preventDefault(); setTimePeriod('month'); }}
                  style={{
                    flex: 1,
                    minWidth: '50px',
                    padding: '0.4rem',
                    fontSize: '0.7rem',
                    borderRadius: '6px',
                    border: timePeriod === 'month' ? '2px solid var(--primary)' : '1px solid var(--border)',
                    background: timePeriod === 'month' ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
                    color: timePeriod === 'month' ? 'var(--primary)' : 'var(--text-muted)',
                    cursor: 'pointer'
                  }}
                >
                  חודש
                </button>
              </div>
              {/* Year Selector - only show when not "all" */}
              {timePeriod !== 'all' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.4rem', flexWrap: 'wrap' }}>
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
                  {timePeriod === 'month' && (
                    <>
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginLeft: '0.3rem' }}>חודש:</span>
                      <select
                        value={selectedMonth}
                        onChange={(e) => setSelectedMonth(parseInt(e.target.value))}
                        style={{
                          padding: '0.25rem 0.4rem',
                          fontSize: '0.7rem',
                          borderRadius: '4px',
                          border: '1px solid var(--border)',
                          background: 'var(--surface)',
                          color: 'var(--text)',
                          cursor: 'pointer',
                          minWidth: '70px'
                        }}
                      >
                        {[
                          { value: 1, label: 'ינואר' },
                          { value: 2, label: 'פברואר' },
                          { value: 3, label: 'מרץ' },
                          { value: 4, label: 'אפריל' },
                          { value: 5, label: 'מאי' },
                          { value: 6, label: 'יוני' },
                          { value: 7, label: 'יולי' },
                          { value: 8, label: 'אוגוסט' },
                          { value: 9, label: 'ספטמבר' },
                          { value: 10, label: 'אוקטובר' },
                          { value: 11, label: 'נובמבר' },
                          { value: 12, label: 'דצמבר' },
                        ].map(month => (
                          <option key={month.value} value={month.value}>{month.label}</option>
                        ))}
                      </select>
                    </>
                  )}
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
                type="button"
                onClick={(e) => { e.stopPropagation(); e.preventDefault(); setShowPlayerType(!showPlayerType); }}
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
                  type="button"
                  onClick={(e) => { e.stopPropagation(); e.preventDefault(); selectAllTypes(); }}
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
                  type="button"
                  onClick={(e) => { e.stopPropagation(); e.preventDefault(); toggleType('permanent'); }}
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
                  type="button"
                  onClick={(e) => { e.stopPropagation(); e.preventDefault(); toggleType('permanent_guest'); }}
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
                  type="button"
                  onClick={(e) => { e.stopPropagation(); e.preventDefault(); toggleType('guest'); }}
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
              type="button"
              onClick={(e) => { e.stopPropagation(); e.preventDefault(); setShowPlayerFilter(!showPlayerFilter); }}
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
                type="button"
                onClick={(e) => { e.stopPropagation(); e.preventDefault(); toggleAllPlayers(); }}
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
                    type="button"
                    key={player.playerId}
                    onClick={(e) => { e.stopPropagation(); e.preventDefault(); togglePlayer(player.playerId); }}
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
              {/* All-Time Notice */}
              <div style={{ 
                textAlign: 'center', 
                padding: '0.5rem', 
                marginBottom: '0.5rem',
                background: 'rgba(16, 185, 129, 0.1)',
                borderRadius: '8px',
                fontSize: '0.75rem',
                color: 'var(--primary)',
                fontWeight: '500'
              }}>
                🏆 Records ({getTimeframeLabel()})
              </div>
              
              {/* Current Streaks */}
              <div className="card">
                <h2 className="card-title mb-2">🔥 Current Streaks</h2>
                <div className="grid grid-2">
                  <div style={{ 
                    padding: '0.75rem', 
                    background: 'linear-gradient(135deg, rgba(249, 115, 22, 0.2), rgba(239, 68, 68, 0.1))',
                    borderRadius: '12px',
                    border: '1px solid rgba(249, 115, 22, 0.3)'
                  }}>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.3rem' }}>🔥 On Fire</div>
                    {records.onFirePlayers.length > 0 ? (
                      renderRecord(
                        'onFire',
                        records.onFirePlayers,
                        (p) => <span style={{ fontSize: '0.85rem', color: 'var(--success)', whiteSpace: 'nowrap' }}>{p.currentStreak} Wins</span>,
                        { fontSize: '1rem', color: '#f97316' },
                        'currentWinStreak',
                        '🔥 רצף נצחונות נוכחי'
                      )
                    ) : (
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>-</div>
                    )}
                  </div>
                  <div style={{ 
                    padding: '0.75rem', 
                    background: 'linear-gradient(135deg, rgba(239, 68, 68, 0.2), rgba(220, 38, 38, 0.1))',
                    borderRadius: '12px',
                    border: '1px solid rgba(239, 68, 68, 0.3)'
                  }}>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.3rem' }}>❄️ Cold Streak</div>
                    {records.iceColdPlayers.length > 0 ? (
                      renderRecord(
                        'iceCold',
                        records.iceColdPlayers,
                        (p) => <span style={{ fontSize: '0.85rem', color: 'var(--danger)', whiteSpace: 'nowrap' }}>{Math.abs(p.currentStreak)} Losses</span>,
                        { fontSize: '1rem', color: '#ef4444' },
                        'currentLossStreak',
                        '❄️ רצף הפסדים נוכחי'
                      )
                    ) : (
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>-</div>
                    )}
                  </div>
                </div>
              </div>

              {/* All-Time Leaders */}
              <div className="card">
                <h2 className="card-title mb-2">👑 Leaders</h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '0.75rem', background: 'rgba(34, 197, 94, 0.1)', borderRadius: '8px', borderLeft: '4px solid var(--success)' }}>
                    <div style={{ flex: 1 }}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>🥇 Top Earner</span>
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

          {/* TABLE/INDIVIDUAL Options - Sort dropdown + Table Mode toggle */}
          {(viewMode === 'table' || viewMode === 'individual') && (
            <div className="card" style={{ padding: '0.4rem', display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as 'profit' | 'games' | 'winRate')}
                style={{
                  padding: '0.35rem 0.5rem',
                  fontSize: '0.75rem',
                  borderRadius: '6px',
                  border: '1px solid var(--border)',
                  background: 'var(--surface)',
                  color: 'var(--text)',
                  cursor: 'pointer',
                }}
              >
                <option value="profit">💰 Profit</option>
                <option value="games">🎮 Games</option>
                <option value="winRate">📊 Win%</option>
              </select>
              {viewMode === 'table' && (
                <button
                  onClick={() => setTableMode(tableMode === 'profit' ? 'gainLoss' : 'profit')}
                  style={{
                    padding: '0.35rem 0.6rem',
                    fontSize: '0.75rem',
                    borderRadius: '6px',
                    border: tableMode === 'gainLoss' ? '2px solid var(--primary)' : '1px solid var(--border)',
                    background: tableMode === 'gainLoss' ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
                    color: tableMode === 'gainLoss' ? 'var(--primary)' : 'var(--text-muted)',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  📊 Gain/Loss
                </button>
              )}
            </div>
          )}

          {/* TABLE VIEW */}
          {viewMode === 'table' && (
            <>
              <div ref={tableRef} className="card" style={{ padding: '0.5rem' }}>
                <div style={{ 
                  textAlign: 'center', 
                  fontSize: '0.7rem', 
                  color: 'var(--text-muted)', 
                  marginBottom: '0.5rem',
                  paddingBottom: '0.3rem',
                  borderBottom: '1px solid var(--border)'
                }}>
                  📊 {timePeriod === 'all' ? 'כל הזמנים' : 
                      timePeriod === 'year' ? `שנת ${selectedYear}` :
                      timePeriod === 'h1' ? `H1 ${selectedYear} (ינו׳-יוני׳)` :
                      timePeriod === 'h2' ? `H2 ${selectedYear} (יולי׳-דצמ׳)` :
                      `${['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'][selectedMonth - 1]} ${selectedYear}`}
                  {' • '}{totalGamesInPeriod} משחקים
                  {filterActiveOnly && ' • שחקנים פעילים'}
                </div>
                <table style={{ width: '100%', fontSize: '0.8rem', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                      <th style={{ padding: '0.3rem 0.2rem', whiteSpace: 'nowrap', width: '24px' }}>#</th>
                      <th style={{ padding: '0.3rem 0.2rem', whiteSpace: 'nowrap', textAlign: 'left' }}>Player</th>
                      {tableMode === 'profit' ? (
                        <>
                          <th style={{ textAlign: 'right', padding: '0.3rem 0.4rem', whiteSpace: 'nowrap' }}>Profit</th>
                          <th style={{ textAlign: 'right', padding: '0.3rem 0.4rem', whiteSpace: 'nowrap' }}>Avg</th>
                        </>
                      ) : (
                        <>
                          <th style={{ textAlign: 'right', padding: '0.3rem 0.3rem', whiteSpace: 'nowrap', color: 'var(--success)' }}>Gain</th>
                          <th style={{ textAlign: 'right', padding: '0.3rem 0.3rem', whiteSpace: 'nowrap', color: 'var(--danger)' }}>Loss</th>
                        </>
                      )}
                      <th style={{ textAlign: 'center', padding: '0.3rem 0.3rem', whiteSpace: 'nowrap' }}>G</th>
                      <th style={{ textAlign: 'center', padding: '0.3rem 0.2rem', whiteSpace: 'nowrap' }}>W%</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedStats.map((player, index) => {
                    const currentRank = index + 1;
                    const prevRank = previousRankings.get(player.playerId);
                    const movement = prevRank ? prevRank - currentRank : 0; // positive = moved up
                    
                    return (
                      <tr 
                        key={player.playerId}
                        onClick={() => showPlayerGames(player)}
                        style={{ cursor: 'pointer' }}
                        onMouseEnter={(e) => e.currentTarget.style.background = 'var(--surface)'}
                        onMouseLeave={(e) => e.currentTarget.style.background = ''}
                      >
                        <td style={{ padding: '0.3rem 0.2rem', whiteSpace: 'nowrap', width: '40px' }}>
                          {currentRank}
                          {movement !== 0 && (
                            <span style={{ 
                              fontSize: '0.6rem', 
                              marginLeft: '2px',
                              color: movement > 0 ? 'var(--success)' : 'var(--danger)'
                            }}>
                              {movement > 0 ? '↑' : '↓'}{Math.abs(movement) > 1 ? Math.abs(movement) : ''}
                        </span>
                          )}
                      </td>
                        <td style={{ fontWeight: '600', padding: '0.3rem 0.2rem', whiteSpace: 'nowrap' }}>
                          {player.playerName}
                          {getMedal(index, sortBy === 'profit' ? player.totalProfit : 
                            sortBy === 'games' ? player.gamesPlayed : player.winPercentage)}
                      </td>
                        {tableMode === 'profit' ? (
                          <>
                            <td style={{ textAlign: 'right', fontWeight: '700', padding: '0.3rem 0.4rem', whiteSpace: 'nowrap' }} className={getProfitColor(player.totalProfit)}>
                              {player.totalProfit >= 0 ? '+' : '-'}₪{cleanNumber(Math.abs(player.totalProfit))}
                            </td>
                            <td style={{ textAlign: 'right', padding: '0.3rem 0.4rem', whiteSpace: 'nowrap' }} className={getProfitColor(player.avgProfit)}>
                              {player.avgProfit >= 0 ? '+' : '-'}₪{cleanNumber(Math.abs(player.avgProfit))}
                            </td>
                          </>
                        ) : (
                          <>
                            <td style={{ textAlign: 'right', fontWeight: '600', padding: '0.3rem 0.3rem', whiteSpace: 'nowrap', color: 'var(--success)' }}>
                              +₪{cleanNumber(player.totalGains)}
                            </td>
                            <td style={{ textAlign: 'right', fontWeight: '600', padding: '0.3rem 0.3rem', whiteSpace: 'nowrap', color: 'var(--danger)' }}>
                              -₪{cleanNumber(player.totalLosses)}
                            </td>
                          </>
                        )}
                        <td style={{ textAlign: 'center', padding: '0.3rem 0.3rem', whiteSpace: 'nowrap' }}>{player.gamesPlayed}</td>
                      <td style={{ 
                        textAlign: 'center',
                          padding: '0.3rem 0.2rem',
                          whiteSpace: 'nowrap',
                        color: player.winPercentage >= 50 ? 'var(--success)' : 'var(--danger)',
                        fontWeight: '600'
                      }}>
                          {Math.round(player.winPercentage)}%
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: '0.5rem' }}>
                <button
                  onClick={handleShareTable}
                  disabled={isSharing}
                  style={{ 
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '0.3rem',
                    fontSize: '0.75rem',
                    padding: '0.4rem 0.8rem',
                    background: 'var(--surface)',
                    color: 'var(--text-muted)',
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                    cursor: 'pointer'
                  }}
                >
                  {isSharing ? '📸...' : '📤 שתף'}
                </button>
              </div>

              {/* Top 20 Single Night Wins */}
              <div ref={top20Ref} className="card" style={{ padding: '0.5rem', marginTop: '1rem' }}>
                <div style={{ 
                  textAlign: 'center', 
                  fontSize: '0.85rem', 
                  fontWeight: '600',
                  color: 'var(--text)',
                  marginBottom: '0.5rem',
                  padding: '0.25rem',
                  background: 'linear-gradient(135deg, rgba(234, 179, 8, 0.15) 0%, rgba(245, 158, 11, 0.1) 100%)',
                  borderRadius: '6px'
                }}>
                  🏆 Top 20 Single Night Wins
                </div>
                <table style={{ width: '100%', fontSize: '0.7rem', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)' }}>
                      <th style={{ textAlign: 'center', padding: '0.25rem', width: '25px' }}>#</th>
                      <th style={{ textAlign: 'left', padding: '0.25rem' }}>Player</th>
                      <th style={{ textAlign: 'right', padding: '0.25rem' }}>Amount</th>
                      <th style={{ textAlign: 'center', padding: '0.25rem' }}>👥</th>
                      <th style={{ textAlign: 'right', padding: '0.25rem' }}>Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {top20Wins.map((record, index) => (
                      <tr 
                        key={`${record.gameId}-${record.playerName}`}
                        onClick={() => navigate(`/game/${record.gameId}`, { 
                          state: { from: 'statistics', viewMode: 'table' } 
                        })}
                        style={{ 
                          borderBottom: '1px solid rgba(255,255,255,0.03)',
                          cursor: 'pointer'
                        }}
                      >
                        <td style={{ 
                          textAlign: 'center', 
                          padding: '0.3rem 0.25rem',
                          color: index < 3 ? 'var(--warning)' : 'var(--text-muted)',
                          fontWeight: index < 3 ? '700' : '400'
                        }}>
                          {index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : index + 1}
                        </td>
                        <td style={{ padding: '0.3rem 0.25rem', whiteSpace: 'nowrap' }}>
                          {record.playerName}
                        </td>
                        <td style={{ 
                          textAlign: 'right', 
                          padding: '0.3rem 0.25rem',
                          color: 'var(--success)',
                          fontWeight: '600'
                        }}>
                          +{cleanNumber(record.profit)}
                        </td>
                        <td style={{ 
                          textAlign: 'center', 
                          padding: '0.3rem 0.25rem',
                          color: 'var(--text-muted)'
                        }}>
                          {record.playersCount}
                        </td>
                        <td style={{ 
                          textAlign: 'right', 
                          padding: '0.3rem 0.25rem',
                          color: 'var(--text-muted)',
                          fontSize: '0.65rem'
                        }}>
                          {new Date(record.date).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: '0.5rem', marginBottom: '2rem' }}>
                <button
                  onClick={handleShareTop20}
                  disabled={isSharingTop20}
                  style={{ 
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '0.3rem',
                    fontSize: '0.75rem',
                    padding: '0.4rem 0.8rem',
                    background: 'var(--surface)',
                    color: 'var(--text-muted)',
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                    cursor: 'pointer'
                  }}
                >
                  {isSharingTop20 ? '📸...' : '📤 שתף'}
                </button>
              </div>
            </>
          )}

          {/* INDIVIDUAL VIEW */}
          {viewMode === 'individual' && (
            <>
              {/* Timeframe Header */}
              <div style={{ 
                textAlign: 'center', 
                padding: '0.5rem', 
                marginBottom: '0.5rem',
                background: 'rgba(16, 185, 129, 0.1)',
                borderRadius: '8px',
                fontSize: '0.75rem',
                color: 'var(--primary)',
                fontWeight: '500'
              }}>
                👤 Player Stats ({getTimeframeLabel()})
              </div>
            </>
          )}

          {viewMode === 'individual' && sortedStats.map((player, index) => (
            <div key={player.playerId} id={`player-card-${player.playerId}`} className="card" style={{ transition: 'box-shadow 0.3s ease' }}>
              <div className="card-header">
                <h3 className="card-title">
                  {player.playerName}
                  {getMedal(index, sortBy === 'profit' ? player.totalProfit : 
                    sortBy === 'games' ? player.gamesPlayed : player.winPercentage)}
                </h3>
                <span className={getProfitColor(player.totalProfit)} style={{ fontSize: '1.25rem', fontWeight: '700' }}>
                  {player.totalProfit >= 0 ? '+' : '-'}{formatCurrency(Math.abs(player.totalProfit))}
                </span>
              </div>

              {/* Current Streak Badge */}
              {player.currentStreak !== 0 && (
                <div style={{ 
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  marginBottom: '0.75rem',
                  padding: '0.4rem 0.75rem',
                  borderRadius: '8px',
                  fontSize: '0.8rem',
                  fontWeight: '600',
                  background: player.currentStreak > 0 
                    ? 'linear-gradient(135deg, rgba(249, 115, 22, 0.2), rgba(239, 68, 68, 0.1))' 
                    : 'linear-gradient(135deg, rgba(239, 68, 68, 0.2), rgba(220, 38, 38, 0.1))',
                  color: player.currentStreak > 0 ? '#f97316' : '#ef4444',
                  border: `1px solid ${player.currentStreak > 0 ? 'rgba(249, 115, 22, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`
                }}>
                  <span>{player.currentStreak > 0 ? '🔥' : '❄️'}</span>
                  <span style={{ color: player.currentStreak > 0 ? 'var(--success)' : 'var(--danger)' }}>
                    {Math.abs(player.currentStreak)} {player.currentStreak > 0 ? 'Wins' : 'Losses'}
                  </span>
                </div>
              )}

              {/* Last 6 Games */}
              {player.lastGameResults && player.lastGameResults.length > 0 && (
                <div style={{ marginBottom: '0.75rem' }}>
                  <div className="text-muted" style={{ fontSize: '0.7rem', marginBottom: '0.35rem' }}>Last {player.lastGameResults.length} games (latest on right, click for details)</div>
                  <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'flex-start' }}>
                    {player.lastGameResults.slice().reverse().map((game, i) => {
                      const gameDate = new Date(game.date);
                      const dateStr = gameDate.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: '2-digit' });
                      return (
                      <div 
                        key={i}
                          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer' }}
                          onClick={() => {
                            navigate(`/game/${game.gameId}`, { state: { from: 'individual', viewMode: 'individual', playerInfo: { playerId: player.playerId, playerName: player.playerName }, timePeriod, selectedYear, selectedMonth } });
                            window.scrollTo(0, 0);
                          }}
                        >
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
                              border: `1px solid ${game.profit > 0 ? 'var(--success)' : game.profit < 0 ? 'var(--danger)' : 'var(--border)'}`,
                              transition: 'transform 0.1s ease'
                            }}
                            onMouseEnter={(e) => e.currentTarget.style.transform = 'scale(1.1)'}
                            onMouseLeave={(e) => e.currentTarget.style.transform = 'scale(1)'}
                          >
                            {game.profit > 0 ? 'W' : game.profit < 0 ? 'L' : '-'}
                      </div>
                          <div style={{ 
                            fontSize: '0.6rem', 
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
              <div className="grid grid-2" style={{ marginBottom: '0.5rem' }}>
                <div 
                  className="stat-card" 
                  style={{ cursor: 'pointer' }}
                  onClick={() => showPlayerStatDetails(player, 'allGames', `🎮 All Games`)}
                >
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>🎮 Games</div>
                  <div className="stat-value">{player.gamesPlayed} <span style={{ color: 'var(--text-muted)' }}>❯</span></div>
                </div>
                <div className="stat-card" style={{ background: player.winPercentage >= 50 ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>{player.winPercentage >= 50 ? '📈' : '📉'} Win Rate</div>
                  <div className="stat-value" style={{ color: player.winPercentage >= 50 ? 'var(--success)' : 'var(--danger)' }}>
                    {player.winPercentage.toFixed(0)}%
                  </div>
                </div>
                <div 
                  className="stat-card" 
                  style={{ cursor: player.winCount > 0 ? 'pointer' : 'default', background: 'rgba(34, 197, 94, 0.1)' }}
                  onClick={() => player.winCount > 0 && showPlayerStatDetails(player, 'wins', `🏆 Wins`)}
                >
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>🏆 Wins</div>
                  <div className="stat-value" style={{ color: player.winCount > 0 ? 'var(--success)' : 'var(--text-muted)' }}>
                    {player.winCount}{player.winCount > 0 && <span style={{ color: 'var(--text-muted)' }}> ❯</span>}
                  </div>
                </div>
                <div 
                  className="stat-card" 
                  style={{ cursor: player.lossCount > 0 ? 'pointer' : 'default', background: 'rgba(239, 68, 68, 0.1)' }}
                  onClick={() => player.lossCount > 0 && showPlayerStatDetails(player, 'losses', `💔 Losses`)}
                >
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>💔 Losses</div>
                  <div className="stat-value" style={{ color: player.lossCount > 0 ? 'var(--danger)' : 'var(--text-muted)' }}>
                    {player.lossCount}{player.lossCount > 0 && <span style={{ color: 'var(--text-muted)' }}> ❯</span>}
                  </div>
                </div>
              </div>

              {/* Main Stats Row 2 */}
              <div className="grid grid-2" style={{ marginBottom: '0.5rem' }}>
                <div 
                  className="stat-card" 
                  style={{ cursor: player.biggestWin > 0 ? 'pointer' : 'default', background: 'rgba(34, 197, 94, 0.1)' }}
                  onClick={() => player.biggestWin > 0 && showPlayerStatDetails(player, 'biggestWin', `💰 Biggest Win`)}
                >
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>💰 Biggest Win</div>
                  <div className="stat-value" style={{ color: 'var(--success)' }}>
                    {player.biggestWin > 0 ? `+₪${cleanNumber(player.biggestWin)}` : '-'}{player.biggestWin > 0 && <span style={{ color: 'var(--text-muted)' }}> ❯</span>}
                  </div>
                </div>
                <div 
                  className="stat-card" 
                  style={{ cursor: player.biggestLoss < 0 ? 'pointer' : 'default', background: 'rgba(239, 68, 68, 0.1)' }}
                  onClick={() => player.biggestLoss < 0 && showPlayerStatDetails(player, 'biggestLoss', `💸 Biggest Loss`)}
                >
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>💸 Biggest Loss</div>
                  <div className="stat-value" style={{ color: 'var(--danger)' }}>
                    {player.biggestLoss < 0 ? `-₪${cleanNumber(Math.abs(player.biggestLoss))}` : '-'}{player.biggestLoss < 0 && <span style={{ color: 'var(--text-muted)' }}> ❯</span>}
                  </div>
                </div>
              </div>

              {/* Streaks Row */}
              <div className="grid grid-2" style={{ marginBottom: '0.5rem' }}>
                <div 
                  className="stat-card" 
                  style={{ cursor: player.longestWinStreak > 0 ? 'pointer' : 'default', background: 'rgba(34, 197, 94, 0.1)' }}
                  onClick={() => player.longestWinStreak > 0 && showPlayerStatDetails(player, 'longestWinStreak', `🏆 Longest Win Streak`)}
                >
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>🏆 Longest Win Streak</div>
                  <div className="stat-value" style={{ color: player.longestWinStreak > 0 ? 'var(--success)' : 'var(--text-muted)' }}>
                    {player.longestWinStreak > 0 ? `${player.longestWinStreak} wins` : '-'}{player.longestWinStreak > 0 && <span style={{ color: 'var(--text-muted)' }}> ❯</span>}
                  </div>
                </div>
                <div 
                  className="stat-card" 
                  style={{ cursor: player.longestLossStreak > 0 ? 'pointer' : 'default', background: 'rgba(239, 68, 68, 0.1)' }}
                  onClick={() => player.longestLossStreak > 0 && showPlayerStatDetails(player, 'longestLossStreak', `💔 Longest Loss Streak`)}
                >
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>💔 Longest Loss Streak</div>
                  <div className="stat-value" style={{ color: player.longestLossStreak > 0 ? 'var(--danger)' : 'var(--text-muted)' }}>
                    {player.longestLossStreak > 0 ? `${player.longestLossStreak} losses` : '-'}{player.longestLossStreak > 0 && <span style={{ color: 'var(--text-muted)' }}> ❯</span>}
                  </div>
                </div>
              </div>

              {/* Averages Row */}
              <div className="grid grid-2" style={{ marginBottom: '0.5rem' }}>
                <div className="stat-card" style={{ background: 'rgba(34, 197, 94, 0.1)' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>📈 Avg Win</div>
                  <div className="stat-value" style={{ color: player.avgWin > 0 ? 'var(--success)' : 'var(--text-muted)' }}>
                    {player.avgWin > 0 ? `+₪${cleanNumber(player.avgWin)}` : '-'}
                  </div>
                </div>
                <div className="stat-card" style={{ background: 'rgba(239, 68, 68, 0.1)' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>📉 Avg Loss</div>
                  <div className="stat-value" style={{ color: player.avgLoss > 0 ? 'var(--danger)' : 'var(--text-muted)' }}>
                    {player.avgLoss > 0 ? `-₪${cleanNumber(player.avgLoss)}` : '-'}
                  </div>
                </div>
              </div>

              {/* Additional Stats Row */}
              <div className="grid grid-2">
                <div className="stat-card" style={{ background: player.avgProfit >= 0 ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>{player.avgProfit >= 0 ? '📈' : '📉'} Avg/Game</div>
                  <div className="stat-value" style={{ color: player.avgProfit >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                    {player.avgProfit >= 0 ? '+' : '-'}₪{cleanNumber(Math.abs(player.avgProfit))}
                  </div>
                </div>
                <div className="stat-card">
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>🎰 Total Buyins</div>
                  <div className="stat-value" style={{ color: 'var(--text)' }}>{player.totalRebuys}</div>
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
                    const savedRecordInfo = recordDetails ? {
                      title: recordDetails.title,
                      playerId: recordDetails.playerId,
                      recordType: recordDetails.recordType
                    } : null;
                    setRecordDetails(null);
                    navigate(`/game/${game.gameId}`, { 
                      state: { 
                        from: viewMode === 'individual' ? 'individual' : 'records', 
                        viewMode: viewMode,
                        recordInfo: savedRecordInfo,
                        playerInfo: viewMode === 'individual' ? { playerId: recordDetails.playerId, playerName: recordDetails.playerName } : undefined,
                        timePeriod,
                        selectedYear
                      } 
                    });
                    // Scroll to top after navigation
                    window.scrollTo(0, 0);
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

      {/* Player All Games Modal */}
      {playerAllGames && (
        <div 
          className="modal-overlay" 
          onClick={() => setPlayerAllGames(null)}
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
                <h3 style={{ margin: 0, fontSize: '1rem' }}>🎮 Game History</h3>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{playerAllGames.playerName}</div>
              </div>
              <button 
                type="button"
                onClick={() => setPlayerAllGames(null)}
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
              {playerAllGames.games.length} משחקים
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
              {playerAllGames.games.slice(0, 20).map((game, idx) => (
                <div 
                  key={idx}
                  onClick={() => {
                    const savedPlayerInfo = {
                      playerId: playerAllGames.playerId,
                      playerName: playerAllGames.playerName
                    };
                    setPlayerAllGames(null);
                    navigate(`/game/${game.gameId}`, { 
                      state: { 
                        from: 'statistics', 
                        viewMode: viewMode,
                        timePeriod,
                        selectedYear
                      } 
                    });
                    window.scrollTo(0, 0);
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
              {playerAllGames.games.length > 20 && (
                <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '0.5rem', fontSize: '0.75rem' }}>
                  + {playerAllGames.games.length - 20} more games
                </div>
              )}
            </div>
            
            {playerAllGames.games.length === 0 && (
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

