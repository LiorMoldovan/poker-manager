import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { captureAndSplit, shareFiles } from '../utils/sharing';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { Player, Game, GamePlayer } from '../types';
import { getAllPlayers, getAllGames, getAllGamePlayers, getPlayerStats, getGraphInsights, saveGraphInsights } from '../database/storage';
import { cleanNumber } from '../utils/calculations';
import { usePermissions } from '../App';
import { getGeminiApiKey, generateGraphInsights, getLastUsedModel, getModelDisplayName } from '../utils/geminiAI';
import { syncToCloud } from '../database/githubSync';
import AIProgressBar from '../components/AIProgressBar';
import { withAITiming } from '../utils/aiTiming';

type ViewMode = 'cumulative' | 'headToHead' | 'impact';
type TimePeriod = 'all' | 'h1' | 'h2' | 'year' | 'month';

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
  
  
  // Time period filter
  const [timePeriod, setTimePeriod] = useState<TimePeriod>(() => {
    const currentMonth = new Date().getMonth() + 1;
    return currentMonth <= 6 ? 'h1' : 'h2';
  });
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear());
  const [selectedMonth, setSelectedMonth] = useState<number>(new Date().getMonth() + 1); // 1-12
  
  // Head-to-head specific state
  const [player1Id, setPlayer1Id] = useState<string>('');
  const [player2Id, setPlayer2Id] = useState<string>('');
  
  // Impact view state
  const [impactPlayerId, setImpactPlayerId] = useState<string>('');
  const [showLimitedData, setShowLimitedData] = useState(false);
  const prevTimePeriodRef = useRef<{ period: TimePeriod; year: number } | null>(null);

  // AI Graph Insights state
  const { role } = usePermissions();
  const [insightsText, setInsightsText] = useState<string>('');
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [insightsError, setInsightsError] = useState<string | null>(null);
  const [insightsGeneratedAt, setInsightsGeneratedAt] = useState<string>('');
  const [insightsModelName, setInsightsModelName] = useState<string>('');
  const insightsGenRef = useRef(false);
  const chartRef = useRef<HTMLDivElement>(null);
  const insightsRef = useRef<HTMLDivElement>(null);
  const [isSharingChart, setIsSharingChart] = useState(false);
  const [isSharingInsights, setIsSharingInsights] = useState(false);

  const handleShareSection = async (ref: React.RefObject<HTMLDivElement | null>, setSharing: (v: boolean) => void, title: string) => {
    if (!ref.current) return;
    setSharing(true);
    try {
      const files = await captureAndSplit(ref.current, `poker-${title}`);
      await shareFiles(files, `Poker ${title}`);
    } catch { /* */ }
    finally { setSharing(false); }
  };

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
    
    if (permanentPlayerIds.length >= 1) {
      setImpactPlayerId(permanentPlayerIds[0]);
    }
  };

  // ─── AI Graph Insights helpers ───

  const getInsightsKey = useCallback(() => {
    if (timePeriod === 'all') return 'all';
    if (timePeriod === 'year') return `${selectedYear}`;
    if (timePeriod === 'h1') return `H1-${selectedYear}`;
    if (timePeriod === 'h2') return `H2-${selectedYear}`;
    if (timePeriod === 'month') return `${selectedYear}-${String(selectedMonth).padStart(2, '0')}`;
    return 'all';
  }, [timePeriod, selectedYear, selectedMonth]);

  const getInsightsPeriodLabel = useCallback(() => {
    if (timePeriod === 'all') return 'כל הזמנים';
    if (timePeriod === 'year') return `${selectedYear}`;
    if (timePeriod === 'h1') return `חציון ראשון ${selectedYear}`;
    if (timePeriod === 'h2') return `חציון שני ${selectedYear}`;
    if (timePeriod === 'month') {
      const months = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
      return `${months[selectedMonth - 1]} ${selectedYear}`;
    }
    return '';
  }, [timePeriod, selectedYear, selectedMonth]);

  const getDateFilter = useCallback((): { start?: Date; end?: Date } | undefined => {
    const year = selectedYear;
    switch (timePeriod) {
      case 'h1': return { start: new Date(year, 0, 1), end: new Date(year, 5, 30, 23, 59, 59) };
      case 'h2': return { start: new Date(year, 6, 1), end: new Date(year, 11, 31, 23, 59, 59) };
      case 'year': return { start: new Date(year, 0, 1), end: new Date(year, 11, 31, 23, 59, 59) };
      case 'month': {
        const monthIdx = selectedMonth - 1;
        const lastDay = new Date(year, monthIdx + 1, 0).getDate();
        return { start: new Date(year, monthIdx, 1), end: new Date(year, monthIdx, lastDay, 23, 59, 59) };
      }
      case 'all':
      default: return undefined;
    }
  }, [timePeriod, selectedYear, selectedMonth]);

  // Load cached insights when period changes
  useEffect(() => {
    const key = getInsightsKey();
    const cached = getGraphInsights(key);
    if (cached) {
      setInsightsText(cached.text);
      setInsightsGeneratedAt(cached.generatedAt);
      setInsightsModelName(cached.model || '');
    } else {
      setInsightsText('');
      setInsightsGeneratedAt('');
      setInsightsModelName('');
    }
    setInsightsError(null);
    insightsGenRef.current = false;
  }, [getInsightsKey]);

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
        case 'month':
          const monthIndex = selectedMonth - 1;
          const lastDay = new Date(year, monthIndex + 1, 0).getDate();
          return gameDate >= new Date(year, monthIndex, 1) && gameDate <= new Date(year, monthIndex, lastDay, 23, 59, 59);
        case 'all':
        default:
          return true;
      }
    });
  }, [allGames, timePeriod, selectedYear, selectedMonth]);

  // Auto-generate insights for admin only when cache is empty for this period
  useEffect(() => {
    if (role !== 'admin') return;
    if (insightsGenRef.current || insightsLoading) return;
    if (!getGeminiApiKey()) return;
    if (filteredGames.length === 0) return;

    const key = getInsightsKey();
    const cached = getGraphInsights(key);
    if (cached) return;

    insightsGenRef.current = true;
    (async () => {
      setInsightsLoading(true);
      setInsightsError(null);
      try {
        const dateFilter = getDateFilter();
        const stats = getPlayerStats(dateFilter)
          .filter(s => {
            const p = players.find(pl => pl.id === s.playerId);
            return p && p.type === 'permanent' && s.gamesPlayed > 0;
          })
          .sort((a, b) => b.totalProfit - a.totalProfit);

        if (stats.length === 0) {
          setInsightsLoading(false);
          return;
        }

        const periodLabel = getInsightsPeriodLabel();
        const totalGames = filteredGames.length;
        const now = new Date();
        const currentHalf = now.getMonth() < 6 ? 1 : 2;
        const isEarlyPeriod = timePeriod === 'h1' || timePeriod === 'h2'
          ? (selectedYear === now.getFullYear() && ((timePeriod === 'h1' && currentHalf === 1) || (timePeriod === 'h2' && currentHalf === 2)) && totalGames <= 5)
          : totalGames <= 3;

        const text = await withAITiming('graph_insights', () => generateGraphInsights(stats, periodLabel, totalGames, isEarlyPeriod));
        const modelDisplay = getModelDisplayName(getLastUsedModel());
        saveGraphInsights(key, text, modelDisplay);
        setInsightsText(text);
        setInsightsGeneratedAt(new Date().toISOString());
        setInsightsModelName(modelDisplay);
        syncToCloud().catch(err => console.warn('Graph insights cloud sync failed:', err));
      } catch (err) {
        console.error('Graph insights auto-generation failed:', err);
        setInsightsError(err instanceof Error ? err.message : 'שגיאה ביצירת תובנות');
      } finally {
        setInsightsLoading(false);
      }
    })();
  }, [role, filteredGames, insightsLoading, getInsightsKey, getDateFilter, getInsightsPeriodLabel, players, timePeriod, selectedYear]);

  const handleGenerateInsights = useCallback(async () => {
    if (insightsLoading) return;
    const apiKey = getGeminiApiKey();
    if (!apiKey) {
      setInsightsError('לא הוגדר מפתח API של Gemini');
      return;
    }

    setInsightsLoading(true);
    setInsightsError(null);
    try {
      const dateFilter = getDateFilter();
      const stats = getPlayerStats(dateFilter)
        .filter(s => {
          const p = players.find(pl => pl.id === s.playerId);
          return p && p.type === 'permanent' && s.gamesPlayed > 0;
        })
        .sort((a, b) => b.totalProfit - a.totalProfit);

      if (stats.length === 0) {
        setInsightsError('אין מספיק נתונים לתקופה זו');
        setInsightsLoading(false);
        return;
      }

      const periodLabel = getInsightsPeriodLabel();
      const totalGames = filteredGames.length;
      const now = new Date();
      const currentHalf = now.getMonth() < 6 ? 1 : 2;
      const isEarlyPeriod = timePeriod === 'h1' || timePeriod === 'h2'
        ? (selectedYear === now.getFullYear() && ((timePeriod === 'h1' && currentHalf === 1) || (timePeriod === 'h2' && currentHalf === 2)) && totalGames <= 5)
        : totalGames <= 3;

      const text = await withAITiming('graph_insights', () => generateGraphInsights(stats, periodLabel, totalGames, isEarlyPeriod));
      const key = getInsightsKey();
      const modelDisplay = getModelDisplayName(getLastUsedModel());
      saveGraphInsights(key, text, modelDisplay);
      setInsightsText(text);
      setInsightsGeneratedAt(new Date().toISOString());
      setInsightsModelName(modelDisplay);
      syncToCloud().catch(err => console.warn('Graph insights cloud sync failed:', err));
    } catch (err) {
      console.error('Graph insights generation failed:', err);
      setInsightsError(err instanceof Error ? err.message : 'שגיאה ביצירת תובנות');
    } finally {
      setInsightsLoading(false);
    }
  }, [insightsLoading, players, filteredGames, getDateFilter, getInsightsPeriodLabel, getInsightsKey, timePeriod, selectedYear]);

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

    // Count total games each player played in the filtered period
    const filteredGameIds = new Set(filteredGames.map(g => g.id));
    const player1TotalGames = gamePlayers.filter(
      gp => gp.playerId === player1Id && filteredGameIds.has(gp.gameId)
    ).length;
    const player2TotalGames = gamePlayers.filter(
      gp => gp.playerId === player2Id && filteredGameIds.has(gp.gameId)
    ).length;

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

    // Direct battles - who outperformed whom in each shared game
    let player1Wins = 0;
    let player2Wins = 0;
    let ties = 0;
    
    // Recent form - last 5 shared games
    const recentGames: Array<{ date: string; p1Profit: number; p2Profit: number; winner: string }> = [];
    
    // Session distribution buckets
    const p1Distribution = { bigWin: 0, smallWin: 0, smallLoss: 0, bigLoss: 0 };
    const p2Distribution = { bigWin: 0, smallWin: 0, smallLoss: 0, bigLoss: 0 };
    
    // For volatility calculation
    const p1Profits: number[] = [];
    const p2Profits: number[] = [];

    const sharedGamesOrdered = filteredGames.filter(g => sharedGameIds.has(g.id));
    
    sharedGamesOrdered.forEach(game => {
      const p1Game = player1Games.find(g => g.gameId === game.id);
      const p2Game = player2Games.find(g => g.gameId === game.id);
      
      if (p1Game && p2Game) {
        p1Profits.push(p1Game.profit);
        p2Profits.push(p2Game.profit);
        
        // Direct battle
        if (p1Game.profit > p2Game.profit) player1Wins++;
        else if (p2Game.profit > p1Game.profit) player2Wins++;
        else ties++;
        
        // Session distribution (big = >150, small = <=150)
        const threshold = 150;
        if (p1Game.profit > threshold) p1Distribution.bigWin++;
        else if (p1Game.profit > 0) p1Distribution.smallWin++;
        else if (p1Game.profit >= -threshold) p1Distribution.smallLoss++;
        else p1Distribution.bigLoss++;
        
        if (p2Game.profit > threshold) p2Distribution.bigWin++;
        else if (p2Game.profit > 0) p2Distribution.smallWin++;
        else if (p2Game.profit >= -threshold) p2Distribution.smallLoss++;
        else p2Distribution.bigLoss++;
        
        // Recent games
        const dateStr = new Date(game.date).toLocaleDateString('en-GB', { 
          day: '2-digit', 
          month: '2-digit' 
        });
        recentGames.push({
          date: dateStr,
          p1Profit: p1Game.profit,
          p2Profit: p2Game.profit,
          winner: p1Game.profit > p2Game.profit ? 'p1' : p2Game.profit > p1Game.profit ? 'p2' : 'tie'
        });
      }
    });
    
    // Calculate volatility (standard deviation)
    const calcStdDev = (arr: number[]) => {
      if (arr.length === 0) return 0;
      const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
      const variance = arr.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / arr.length;
      return Math.sqrt(variance);
    };
    
    const p1Volatility = calcStdDev(p1Profits);
    const p2Volatility = calcStdDev(p2Profits);
    
    // Last 5 games only
    const last5Games = recentGames.slice(-5);

    // Cumulative data for shared games (for the chart)
    const cumulativeComparison: Array<{
      gameIndex: number;
      date: string;
      [key: string]: string | number;
    }> = [];
    
    let p1Cumulative = 0;
    let p2Cumulative = 0;
    let gameIdx = 0;

    sharedGamesOrdered.forEach(game => {
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
      totalGamesInPeriod: filteredGames.length,
      player1TotalGames,
      player2TotalGames,
      cumulativeComparison,
      // New H2H insights
      directBattles: { player1Wins, player2Wins, ties },
      recentForm: last5Games,
      distribution: { p1: p1Distribution, p2: p2Distribution },
      volatility: { p1: p1Volatility, p2: p2Volatility },
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

  // Impact data - for a selected player, how their avg changes with/without each other player
  const impactData = useMemo(() => {
    if (!impactPlayerId) return [];

    const permanentPlayers = players.filter(p => p.type === 'permanent' && p.id !== impactPlayerId);
    const results: Array<{
      otherPlayerId: string;
      otherPlayerName: string;
      otherColor: string;
      withGames: number;
      withoutGames: number;
      avgWith: number;
      avgWithout: number;
      impact: number;
      winRateWith: number;
      winRateWithout: number;
      withWins: number;
      withoutWins: number;
      totalWith: number;
      totalWithout: number;
    }> = [];

    for (const other of permanentPlayers) {
      let withProfit = 0, withGames = 0, withWins = 0;
      let withoutProfit = 0, withoutGames = 0, withoutWins = 0;

      for (const game of filteredGames) {
        const gps = gamePlayers.filter(gp => gp.gameId === game.id);
        const selectedGp = gps.find(gp => gp.playerId === impactPlayerId);
        if (!selectedGp) continue;

        const otherPlayed = gps.some(gp => gp.playerId === other.id);

        if (otherPlayed) {
          withProfit += selectedGp.profit;
          withGames++;
          if (selectedGp.profit > 0) withWins++;
        } else {
          withoutProfit += selectedGp.profit;
          withoutGames++;
          if (selectedGp.profit > 0) withoutWins++;
        }
      }

      if (withGames >= 1 && withoutGames >= 1) {
        const avgWith = withProfit / withGames;
        const avgWithout = withoutProfit / withoutGames;
        results.push({
          otherPlayerId: other.id,
          otherPlayerName: other.name,
          otherColor: getPlayerColor(other.id),
          withGames,
          withoutGames,
          avgWith,
          avgWithout,
          impact: avgWith - avgWithout,
          winRateWith: (withWins / withGames) * 100,
          winRateWithout: (withoutWins / withoutGames) * 100,
          withWins,
          withoutWins,
          totalWith: withProfit,
          totalWithout: withoutProfit,
        });
      }
    }

    results.sort((a, b) => b.impact - a.impact);
    return results;
  }, [impactPlayerId, filteredGames, gamePlayers, players, getPlayerColor]);

  // Get timeframe label
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

  return (
    <div className="fade-in">
      <div className="page-header">
        <h1 className="page-title">Analysis</h1>
        <p className="page-subtitle">Trends, comparisons and player chemistry</p>
      </div>

      {/* View Mode Toggle */}
      <div className="card" style={{ padding: '0.75rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button 
            className={`btn btn-sm ${viewMode === 'cumulative' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => {
              if (viewMode === 'impact' && prevTimePeriodRef.current) {
                setTimePeriod(prevTimePeriodRef.current.period);
                setSelectedYear(prevTimePeriodRef.current.year);
                prevTimePeriodRef.current = null;
              }
              setViewMode('cumulative');
            }}
            style={{ flex: 1, minWidth: 0, padding: '0.5rem 0.25rem', fontSize: '0.75rem' }}
          >
            📈 Trends
          </button>
          <button 
            className={`btn btn-sm ${viewMode === 'headToHead' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => {
              if (viewMode === 'impact' && prevTimePeriodRef.current) {
                setTimePeriod(prevTimePeriodRef.current.period);
                setSelectedYear(prevTimePeriodRef.current.year);
                prevTimePeriodRef.current = null;
              }
              setViewMode('headToHead');
            }}
            style={{ flex: 1, minWidth: 0, padding: '0.5rem 0.25rem', fontSize: '0.75rem' }}
          >
            🆚 Head-to-Head
          </button>
          <button 
            className={`btn btn-sm ${viewMode === 'impact' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => {
              if (viewMode !== 'impact') {
                prevTimePeriodRef.current = { period: timePeriod, year: selectedYear };
                setTimePeriod('all');
              }
              setViewMode('impact');
            }}
            style={{ flex: 1, minWidth: 0, padding: '0.5rem 0.25rem', fontSize: '0.75rem' }}
          >
            🎯 Impact
          </button>
        </div>
      </div>

      {/* Filters Card - Always visible */}
      <div className="card" style={{ padding: '0.75rem' }}>
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
                      background: '#1a1a2e',
                      color: '#ffffff',
                      cursor: 'pointer',
                      minWidth: '60px'
                    }}
                  >
                    {getAvailableYears().map(year => (
                      <option key={year} value={year} style={{ background: '#1a1a2e', color: '#ffffff' }}>{year}</option>
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
                          background: '#1a1a2e',
                          color: '#ffffff',
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
                          <option key={month.value} value={month.value} style={{ background: '#1a1a2e', color: '#ffffff' }}>{month.label}</option>
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

        {/* Player Filter - Only show for cumulative view */}
        {viewMode === 'cumulative' && (
          <>
            <button 
              type="button"
              onClick={(e) => { e.stopPropagation(); e.preventDefault(); setShowPlayerSelector(!showPlayerSelector); }}
              style={{ 
                display: 'flex', 
                justifyContent: 'space-between', 
                alignItems: 'center',
                width: '100%',
                padding: 0,
                marginBottom: showPlayerSelector ? '0.5rem' : 0,
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--text)'
              }}
            >
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: '600' }}>
                FILTER PLAYERS ({selectedPlayers.size}/{players.filter(p => p.type === 'permanent').length})
              </span>
              <span style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>
                {showPlayerSelector ? '▲' : '▼'}
              </span>
            </button>
            
            {showPlayerSelector && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); e.preventDefault(); selectAllPermanent(); }}
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
                  <button
                    type="button"
                    onClick={(e) => { 
                      e.stopPropagation(); 
                      e.preventDefault(); 
                      setSelectedPlayers(new Set()); 
                    }}
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
                    Clear
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
                          onClick={(e) => { e.stopPropagation(); e.preventDefault(); togglePlayer(player.id); }}
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
          </>
        )}
      </div>

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
                background: '#1a1a2e',
                color: '#ffffff',
                fontSize: '0.9rem',
                fontWeight: '600',
              }}
            >
              {players.filter(p => p.type === 'permanent').map(p => (
                <option key={p.id} value={p.id} style={{ background: '#1a1a2e', color: '#ffffff' }}>{p.name}</option>
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
                background: '#1a1a2e',
                color: '#ffffff',
                fontSize: '0.9rem',
                fontWeight: '600',
              }}
            >
              {players.filter(p => p.type === 'permanent').map(p => (
                <option key={p.id} value={p.id} style={{ background: '#1a1a2e', color: '#ffffff' }}>{p.name}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* CUMULATIVE PROFIT CHART */}
      {viewMode === 'cumulative' && cumulativeData.length > 0 && (
        <div ref={chartRef} className="card">
          <h2 className="card-title mb-2">📈 Cumulative Profit Over Time</h2>
          <div style={{ 
            fontSize: '0.7rem', 
            color: 'var(--text-muted)',
            textAlign: 'center',
            marginBottom: '0.5rem' 
          }}>
            {getTimeframeLabel()} • {filteredGames.length} games
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
                  tickFormatter={(value) => cleanNumber(value)}
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
                    activeDot={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <CustomLegend />
        </div>
      )}
      {viewMode === 'cumulative' && cumulativeData.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: '-0.5rem', marginBottom: '0.5rem' }}>
          <button
            onClick={() => handleShareSection(chartRef, setIsSharingChart, 'cumulative-profit')}
            disabled={isSharingChart}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem', fontSize: '0.75rem', padding: '0.4rem 0.8rem', background: 'var(--surface)', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: '6px', cursor: 'pointer' }}
          >
            {isSharingChart ? '📸...' : '📤 שתף גרף'}
          </button>
        </div>
      )}

      {/* 🤖 AI GRAPH INSIGHTS */}
      {viewMode === 'cumulative' && (insightsText || insightsLoading || role === 'admin') && (
        <div ref={insightsRef} className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <h2 className="card-title" style={{ margin: 0 }}>🤖 תובנות AI</h2>
            {role === 'admin' && !insightsLoading && filteredGames.length > 0 && (
              <button
                onClick={handleGenerateInsights}
                style={{
                  fontSize: '0.7rem',
                  padding: '0.3rem 0.7rem',
                  borderRadius: '8px',
                  background: 'var(--surface-hover)',
                  color: 'var(--text-muted)',
                  border: '1px solid var(--border)',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {insightsText ? 'יצירה מחדש' : 'יצירת תובנות'}
              </button>
            )}
          </div>

          {insightsLoading && (
            <div style={{
              textAlign: 'center',
              padding: '1.5rem',
              color: 'var(--text-muted)',
              fontSize: '0.8rem',
            }}>
              ⏳ יוצר תובנות AI לתקופה...
              <AIProgressBar operationKey="graph_insights" />
            </div>
          )}

          {insightsError && (
            <div style={{
              padding: '0.6rem',
              borderRadius: '6px',
              background: 'rgba(239, 68, 68, 0.1)',
              color: '#EF4444',
              fontSize: '0.75rem',
              textAlign: 'center',
            }}>
              {insightsError}
            </div>
          )}

          {insightsText && !insightsLoading && (
            <>
              <div style={{
                direction: 'rtl',
                textAlign: 'right',
                fontSize: '0.85rem',
                lineHeight: '1.7',
                color: 'var(--text-primary)',
                padding: '0.5rem',
                background: 'var(--surface)',
                borderRadius: '8px',
                borderRight: '3px solid #8B5CF6',
              }}>
                {insightsText}
              </div>
              {insightsGeneratedAt && (
                <div style={{
                  fontSize: '0.6rem',
                  color: 'var(--text-muted)',
                  textAlign: 'center',
                  marginTop: '0.4rem',
                }}>
                  נוצר: {new Date(insightsGeneratedAt).toLocaleDateString('he-IL', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  {insightsModelName && ` · model: ${insightsModelName}`}
                </div>
              )}
            </>
          )}

          {!insightsText && !insightsLoading && !insightsError && role !== 'admin' && (
            <div style={{
              textAlign: 'center',
              padding: '1rem',
              color: 'var(--text-muted)',
              fontSize: '0.75rem',
            }}>
              אין תובנות AI לתקופה זו עדיין
            </div>
          )}
        </div>
      )}
      {viewMode === 'cumulative' && insightsText && !insightsLoading && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: '-0.5rem', marginBottom: '0.5rem' }}>
          <button
            onClick={() => handleShareSection(insightsRef, setIsSharingInsights, 'ai-insights')}
            disabled={isSharingInsights}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem', fontSize: '0.75rem', padding: '0.4rem 0.8rem', background: 'var(--surface)', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: '6px', cursor: 'pointer' }}
          >
            {isSharingInsights ? '📸...' : '📤 שתף תובנות'}
          </button>
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
              {getTimeframeLabel()} • {headToHeadData.sharedGamesCount} shared games (out of {headToHeadData.totalGamesInPeriod})
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
                  {headToHeadData.player1Stats.totalProfit >= 0 ? '\u200E+' : ''}{cleanNumber(headToHeadData.player1Stats.totalProfit)}
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
                  <div style={{ fontSize: '0.55rem', fontWeight: '400', opacity: 0.7, marginTop: '1px' }}>סה״כ במשחקים משותפים</div>
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
                  {headToHeadData.player2Stats.totalProfit >= 0 ? '\u200E+' : ''}{cleanNumber(headToHeadData.player2Stats.totalProfit)}
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
                  <div style={{ fontSize: '0.55rem', fontWeight: '400', opacity: 0.7, marginTop: '1px' }}>משחקים שסיימו ברווח</div>
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
                  {headToHeadData.player1Stats.avgProfit >= 0 ? '\u200E+' : ''}{cleanNumber(headToHeadData.player1Stats.avgProfit)}
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
                  <div style={{ fontSize: '0.55rem', fontWeight: '400', opacity: 0.7, marginTop: '1px' }}>ממוצע למשחק משותף</div>
                </div>
                <div style={{ 
                  flex: 1, 
                  textAlign: 'left',
                  fontWeight: '600',
                  color: headToHeadData.player2Stats.avgProfit >= headToHeadData.player1Stats.avgProfit 
                    ? 'var(--success)' 
                    : 'var(--danger)'
                }}>
                  {headToHeadData.player2Stats.avgProfit >= 0 ? '\u200E+' : ''}{cleanNumber(headToHeadData.player2Stats.avgProfit)}
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
                  {'\u200E'}+{cleanNumber(headToHeadData.player1Stats.biggestWin)}
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
                  <div style={{ fontSize: '0.55rem', fontWeight: '400', opacity: 0.7, marginTop: '1px' }}>שיא רווח במשחק בודד</div>
                </div>
                <div style={{ 
                  flex: 1, 
                  textAlign: 'left',
                  fontWeight: '600',
                  color: headToHeadData.player2Stats.biggestWin >= headToHeadData.player1Stats.biggestWin 
                    ? 'var(--success)' 
                    : 'var(--text)'
                }}>
                  {'\u200E'}+{cleanNumber(headToHeadData.player2Stats.biggestWin)}
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
                  {cleanNumber(headToHeadData.player1Stats.biggestLoss)}
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
                  <div style={{ fontSize: '0.55rem', fontWeight: '400', opacity: 0.7, marginTop: '1px' }}>שיא הפסד במשחק בודד</div>
                </div>
                <div style={{ 
                  flex: 1, 
                  textAlign: 'left',
                  fontWeight: '600',
                  color: headToHeadData.player2Stats.biggestLoss >= headToHeadData.player1Stats.biggestLoss 
                    ? 'var(--text)' 
                    : 'var(--danger)'
                }}>
                  {cleanNumber(headToHeadData.player2Stats.biggestLoss)}
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

          {/* 🏆 DIRECT BATTLES */}
          <div className="card">
            <h2 className="card-title mb-2">🏆 Direct Battles</h2>
            <div style={{ 
              fontSize: '0.7rem', 
              color: 'var(--text-muted)',
              textAlign: 'center',
              marginBottom: '0.75rem' 
            }}>
              Who outperformed the other in shared games?
            </div>
            
            {/* Battle bar visualization */}
            <div style={{ 
              display: 'flex', 
              alignItems: 'center',
              gap: '0.5rem',
              marginBottom: '0.75rem',
            }}>
              <span style={{ fontWeight: '700', color: '#10B981', minWidth: '30px', textAlign: 'right' }}>
                {headToHeadData.directBattles.player1Wins}
              </span>
              <div style={{ 
                flex: 1, 
                height: '24px', 
                background: 'var(--surface)',
                borderRadius: '12px',
                overflow: 'hidden',
                display: 'flex',
              }}>
                {headToHeadData.sharedGamesCount > 0 && (
                  <>
                    <div style={{ 
                      width: `${(headToHeadData.directBattles.player1Wins / headToHeadData.sharedGamesCount) * 100}%`,
                      background: '#10B981',
                      transition: 'width 0.3s ease',
                    }} />
                    <div style={{ 
                      width: `${(headToHeadData.directBattles.ties / headToHeadData.sharedGamesCount) * 100}%`,
                      background: 'var(--text-muted)',
                      transition: 'width 0.3s ease',
                    }} />
                    <div style={{ 
                      width: `${(headToHeadData.directBattles.player2Wins / headToHeadData.sharedGamesCount) * 100}%`,
                      background: '#3B82F6',
                      transition: 'width 0.3s ease',
                    }} />
                  </>
                )}
              </div>
              <span style={{ fontWeight: '700', color: '#3B82F6', minWidth: '30px' }}>
                {headToHeadData.directBattles.player2Wins}
              </span>
            </div>
            
            {/* Battle stats */}
            <div style={{ 
              display: 'flex', 
              justifyContent: 'space-around',
              padding: '0.5rem',
              background: 'var(--surface)',
              borderRadius: '8px',
              fontSize: '0.75rem',
            }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ color: '#10B981', fontWeight: '700', fontSize: '1.1rem' }}>
                  {headToHeadData.sharedGamesCount > 0 
                    ? Math.round((headToHeadData.directBattles.player1Wins / headToHeadData.sharedGamesCount) * 100) 
                    : 0}%
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: '0.65rem' }}>Win Rate</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ color: 'var(--text-muted)', fontWeight: '600' }}>
                  {headToHeadData.directBattles.ties} Ties
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: '0.65rem' }}>
                  ({headToHeadData.sharedGamesCount > 0 
                    ? Math.round((headToHeadData.directBattles.ties / headToHeadData.sharedGamesCount) * 100) 
                    : 0}%)
                </div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ color: '#3B82F6', fontWeight: '700', fontSize: '1.1rem' }}>
                  {headToHeadData.sharedGamesCount > 0 
                    ? Math.round((headToHeadData.directBattles.player2Wins / headToHeadData.sharedGamesCount) * 100) 
                    : 0}%
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: '0.65rem' }}>Win Rate</div>
              </div>
            </div>
          </div>

          {/* 🔥 RECENT FORM */}
          {headToHeadData.recentForm.length > 0 && (
            <div className="card">
              <h2 className="card-title mb-2">🔥 Recent Form</h2>
              <div style={{ 
                fontSize: '0.7rem', 
                color: 'var(--text-muted)',
                textAlign: 'center',
                marginBottom: '0.75rem' 
              }}>
                Last {headToHeadData.recentForm.length} shared games
              </div>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {headToHeadData.recentForm.map((game, idx) => (
                  <div key={idx} style={{ 
                    display: 'flex', 
                    alignItems: 'center',
                    padding: '0.4rem 0.5rem',
                    background: 'var(--surface)',
                    borderRadius: '8px',
                  }}>
                    <div style={{ 
                      flex: 1, 
                      textAlign: 'right',
                      fontWeight: '600',
                      fontSize: '0.85rem',
                      color: game.p1Profit >= 0 ? 'var(--success)' : 'var(--danger)',
                    }}>
                      {game.p1Profit >= 0 ? '\u200E+' : ''}{cleanNumber(game.p1Profit)}
                    </div>
                    <div style={{ 
                      padding: '0.15rem 0.5rem',
                      margin: '0 0.5rem',
                      fontSize: '0.65rem',
                      color: 'var(--text-muted)',
                      background: game.winner === 'p1' ? 'rgba(16, 185, 129, 0.2)' 
                        : game.winner === 'p2' ? 'rgba(59, 130, 246, 0.2)' 
                        : 'var(--border)',
                      borderRadius: '4px',
                      minWidth: '55px',
                      textAlign: 'center',
                    }}>
                      {game.date}
                    </div>
                    <div style={{ 
                      flex: 1, 
                      textAlign: 'left',
                      fontWeight: '600',
                      fontSize: '0.85rem',
                      color: game.p2Profit >= 0 ? 'var(--success)' : 'var(--danger)',
                    }}>
                      {game.p2Profit >= 0 ? '\u200E+' : ''}{cleanNumber(game.p2Profit)}
                    </div>
                  </div>
                ))}
              </div>
              
              {/* Recent form summary */}
              <div style={{ 
                display: 'flex', 
                justifyContent: 'space-between',
                marginTop: '0.75rem',
                padding: '0.5rem',
                borderTop: '1px solid var(--border)',
                fontSize: '0.75rem',
              }}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ color: '#10B981', fontWeight: '700' }}>
                    {headToHeadData.recentForm.filter(g => g.winner === 'p1').length} wins
                  </div>
                </div>
                <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                  Last {headToHeadData.recentForm.length}
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ color: '#3B82F6', fontWeight: '700' }}>
                    {headToHeadData.recentForm.filter(g => g.winner === 'p2').length} wins
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 📊 SESSION DISTRIBUTION & VOLATILITY */}
          <div className="card">
            <h2 className="card-title mb-2">📊 Play Style Comparison</h2>
            
            {/* Session Distribution */}
            <div style={{ marginBottom: '1rem' }}>
              <div style={{ 
                fontSize: '0.7rem', 
                color: 'var(--text-muted)',
                marginBottom: '0.5rem',
                fontWeight: '600',
              }}>
                Session Results Distribution
              </div>
              
              {/* Legend */}
              <div style={{ 
                display: 'flex', 
                justifyContent: 'center', 
                gap: '0.75rem', 
                marginBottom: '0.5rem',
                padding: '0.35rem',
                background: 'var(--surface)',
                borderRadius: '6px',
                fontSize: '0.55rem',
                color: 'var(--text-muted)',
              }}>
                <span><span style={{ color: '#10B981' }}>■</span> Big Win &gt;150</span>
                <span><span style={{ color: '#6EE7B7' }}>■</span> Win 1-150</span>
                <span><span style={{ color: '#FCA5A5' }}>■</span> Loss 1-150</span>
                <span><span style={{ color: '#EF4444' }}>■</span> Big Loss &gt;150</span>
              </div>
              
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {/* Player 1 distribution */}
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '0.65rem', color: '#10B981', fontWeight: '600', marginBottom: '0.25rem', textAlign: 'center' }}>
                    {headToHeadData.player1Stats.playerName}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                      <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', width: '45px' }}>Big Win</span>
                      <div style={{ flex: 1, height: '12px', background: 'var(--surface)', borderRadius: '6px', overflow: 'hidden' }}>
                        <div style={{ 
                          width: `${headToHeadData.sharedGamesCount > 0 ? (headToHeadData.distribution.p1.bigWin / headToHeadData.sharedGamesCount) * 100 : 0}%`,
                          height: '100%',
                          background: '#10B981',
                        }} />
                      </div>
                      <span style={{ fontSize: '0.65rem', fontWeight: '600', minWidth: '18px' }}>{headToHeadData.distribution.p1.bigWin}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                      <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', width: '45px' }}>Win</span>
                      <div style={{ flex: 1, height: '12px', background: 'var(--surface)', borderRadius: '6px', overflow: 'hidden' }}>
                        <div style={{ 
                          width: `${headToHeadData.sharedGamesCount > 0 ? (headToHeadData.distribution.p1.smallWin / headToHeadData.sharedGamesCount) * 100 : 0}%`,
                          height: '100%',
                          background: '#6EE7B7',
                        }} />
                      </div>
                      <span style={{ fontSize: '0.65rem', fontWeight: '600', minWidth: '18px' }}>{headToHeadData.distribution.p1.smallWin}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                      <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', width: '45px' }}>Loss</span>
                      <div style={{ flex: 1, height: '12px', background: 'var(--surface)', borderRadius: '6px', overflow: 'hidden' }}>
                        <div style={{ 
                          width: `${headToHeadData.sharedGamesCount > 0 ? (headToHeadData.distribution.p1.smallLoss / headToHeadData.sharedGamesCount) * 100 : 0}%`,
                          height: '100%',
                          background: '#FCA5A5',
                        }} />
                      </div>
                      <span style={{ fontSize: '0.65rem', fontWeight: '600', minWidth: '18px' }}>{headToHeadData.distribution.p1.smallLoss}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                      <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', width: '45px' }}>Big Loss</span>
                      <div style={{ flex: 1, height: '12px', background: 'var(--surface)', borderRadius: '6px', overflow: 'hidden' }}>
                        <div style={{ 
                          width: `${headToHeadData.sharedGamesCount > 0 ? (headToHeadData.distribution.p1.bigLoss / headToHeadData.sharedGamesCount) * 100 : 0}%`,
                          height: '100%',
                          background: '#EF4444',
                        }} />
                      </div>
                      <span style={{ fontSize: '0.65rem', fontWeight: '600', minWidth: '18px' }}>{headToHeadData.distribution.p1.bigLoss}</span>
                    </div>
                  </div>
                </div>
                
                {/* Player 2 distribution */}
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '0.65rem', color: '#3B82F6', fontWeight: '600', marginBottom: '0.25rem', textAlign: 'center' }}>
                    {headToHeadData.player2Stats.playerName}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                      <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', width: '45px' }}>Big Win</span>
                      <div style={{ flex: 1, height: '12px', background: 'var(--surface)', borderRadius: '6px', overflow: 'hidden' }}>
                        <div style={{ 
                          width: `${headToHeadData.sharedGamesCount > 0 ? (headToHeadData.distribution.p2.bigWin / headToHeadData.sharedGamesCount) * 100 : 0}%`,
                          height: '100%',
                          background: '#3B82F6',
                        }} />
                      </div>
                      <span style={{ fontSize: '0.65rem', fontWeight: '600', minWidth: '18px' }}>{headToHeadData.distribution.p2.bigWin}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                      <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', width: '45px' }}>Win</span>
                      <div style={{ flex: 1, height: '12px', background: 'var(--surface)', borderRadius: '6px', overflow: 'hidden' }}>
                        <div style={{ 
                          width: `${headToHeadData.sharedGamesCount > 0 ? (headToHeadData.distribution.p2.smallWin / headToHeadData.sharedGamesCount) * 100 : 0}%`,
                          height: '100%',
                          background: '#93C5FD',
                        }} />
                      </div>
                      <span style={{ fontSize: '0.65rem', fontWeight: '600', minWidth: '18px' }}>{headToHeadData.distribution.p2.smallWin}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                      <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', width: '45px' }}>Loss</span>
                      <div style={{ flex: 1, height: '12px', background: 'var(--surface)', borderRadius: '6px', overflow: 'hidden' }}>
                        <div style={{ 
                          width: `${headToHeadData.sharedGamesCount > 0 ? (headToHeadData.distribution.p2.smallLoss / headToHeadData.sharedGamesCount) * 100 : 0}%`,
                          height: '100%',
                          background: '#FCA5A5',
                        }} />
                      </div>
                      <span style={{ fontSize: '0.65rem', fontWeight: '600', minWidth: '18px' }}>{headToHeadData.distribution.p2.smallLoss}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                      <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', width: '45px' }}>Big Loss</span>
                      <div style={{ flex: 1, height: '12px', background: 'var(--surface)', borderRadius: '6px', overflow: 'hidden' }}>
                        <div style={{ 
                          width: `${headToHeadData.sharedGamesCount > 0 ? (headToHeadData.distribution.p2.bigLoss / headToHeadData.sharedGamesCount) * 100 : 0}%`,
                          height: '100%',
                          background: '#EF4444',
                        }} />
                      </div>
                      <span style={{ fontSize: '0.65rem', fontWeight: '600', minWidth: '18px' }}>{headToHeadData.distribution.p2.bigLoss}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            
            {/* Volatility Comparison */}
            <div style={{ 
              padding: '0.5rem',
              background: 'var(--surface)',
              borderRadius: '8px',
            }}>
              <div style={{ 
                fontSize: '0.7rem', 
                color: 'var(--text-muted)',
                marginBottom: '0.5rem',
                fontWeight: '600',
                textAlign: 'center',
              }}>
                🎲 Volatility (Consistency)
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-around' }}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ 
                    fontSize: '1rem', 
                    fontWeight: '700',
                    color: headToHeadData.volatility.p1 <= headToHeadData.volatility.p2 ? '#10B981' : 'var(--text)',
                  }}>
                    {cleanNumber(headToHeadData.volatility.p1)}
                  </div>
                  <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                    {headToHeadData.volatility.p1 <= headToHeadData.volatility.p2 ? '🎯 More Consistent' : '🎲 More Volatile'}
                  </div>
                </div>
                <div style={{ 
                  width: '1px', 
                  background: 'var(--border)',
                  margin: '0 0.5rem',
                }} />
                <div style={{ textAlign: 'center' }}>
                  <div style={{ 
                    fontSize: '1rem', 
                    fontWeight: '700',
                    color: headToHeadData.volatility.p2 <= headToHeadData.volatility.p1 ? '#3B82F6' : 'var(--text)',
                  }}>
                    {cleanNumber(headToHeadData.volatility.p2)}
                  </div>
                  <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                    {headToHeadData.volatility.p2 <= headToHeadData.volatility.p1 ? '🎯 More Consistent' : '🎲 More Volatile'}
                  </div>
                </div>
              </div>
              <div style={{ 
                fontSize: '0.55rem', 
                color: 'var(--text-muted)',
                textAlign: 'center',
                marginTop: '0.4rem',
              }}>
                Lower = more consistent results (standard deviation)
              </div>
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
                      tickFormatter={(value) => cleanNumber(value)}
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

      {/* IMPACT VIEW */}
      {viewMode === 'impact' && (
        <>
          {/* Player Selector */}
          <div className="card" style={{ padding: '0.75rem' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: '600', marginBottom: '0.5rem' }}>
              SELECT A PLAYER
            </div>
            <select
              value={impactPlayerId}
              onChange={(e) => setImpactPlayerId(e.target.value)}
              style={{
                width: '100%',
                padding: '0.5rem',
                borderRadius: '8px',
                border: '2px solid var(--primary)',
                background: '#1a1a2e',
                color: '#ffffff',
                fontSize: '0.9rem',
                fontWeight: '600',
              }}
            >
              {players.filter(p => p.type === 'permanent').map(p => (
                <option key={p.id} value={p.id} style={{ background: '#1a1a2e', color: '#ffffff' }}>{p.name}</option>
              ))}
            </select>
          </div>

          {/* With/Without Table */}
          {impactData.length > 0 && (() => {
            const totalPeriodGames = filteredGames.length;
            const minGamesThreshold = Math.max(3, Math.min(10, Math.ceil(totalPeriodGames * 0.10)));
            const isLowConf = (r: typeof impactData[0]) => {
              const min = Math.min(r.withGames, r.withoutGames);
              return min < minGamesThreshold;
            };
            const confidenceScore = (r: typeof impactData[0]) => {
              const min = Math.min(r.withGames, r.withoutGames);
              const max = Math.max(r.withGames, r.withoutGames);
              const winRateDelta = r.winRateWith - r.winRateWithout;
              const agrees = (r.impact > 0 && winRateDelta >= 0) || (r.impact < 0 && winRateDelta <= 0) || Math.round(r.impact) === 0;
              const winRateWeight = agrees ? 1 + Math.abs(winRateDelta) / 100 : 0.6;
              return Math.abs(r.impact) * (min / max) * Math.sqrt(min) * winRateWeight;
            };
            const reliable = impactData
              .filter(r => !isLowConf(r))
              .sort((a, b) => confidenceScore(b) - confidenceScore(a));
            const limited = impactData
              .filter(r => isLowConf(r))
              .sort((a, b) => confidenceScore(b) - confidenceScore(a));
            const formatSignedShekelLocal = (value: number) => `\u200E${value > 0 ? '+' : value < 0 ? '-' : ''}${cleanNumber(Math.abs(value))}`;

            const getImpactIcon = (row: typeof impactData[0], isLimited: boolean): string | null => {
              if (isLimited) return null;
              const minSide = Math.min(row.withGames, row.withoutGames);
              const maxSide = Math.max(row.withGames, row.withoutGames);
              const sampleBalance = minSide / maxSide;
              if (minSide < minGamesThreshold && sampleBalance < 0.08) return null;

              const winRateDelta = row.winRateWith - row.winRateWithout;
              const contradicts = (row.impact > 0 && winRateDelta < -10) || (row.impact < 0 && winRateDelta > 10);
              if (contradicts) return null;

              if (Math.abs(row.impact) >= 15) {
                return row.impact > 0 ? '🍀' : '💀';
              }
              return null;
            };

            const renderRow = (row: typeof impactData[0], isLimited: boolean) => {
              const roundedImpact = Math.round(row.impact);
              const isZero = roundedImpact === 0;
              const impactColor = isZero ? 'var(--text-muted)' : row.impact > 0 ? '#10B981' : '#EF4444';
              const impactIcon = getImpactIcon(row, isLimited);
              const avgWithRounded = Math.round(row.avgWith);
              const avgWithoutRounded = Math.round(row.avgWithout);
              const avgWithColor = avgWithRounded === 0 ? 'var(--text-muted)' : avgWithRounded > 0 ? '#10B981' : '#EF4444';
              const avgWithoutColor = avgWithoutRounded === 0 ? 'var(--text-muted)' : avgWithoutRounded > 0 ? '#10B981' : '#EF4444';
              const totalGames = row.withGames + row.withoutGames;
              const withPct = totalGames > 0 ? (row.withGames / totalGames) * 100 : 50;
              const rowInsightLines = (() => {
                const lines: string[] = [];
                const wrWith = Math.round(row.winRateWith);
                const wrWithout = Math.round(row.winRateWithout);
                const wrDelta = wrWith - wrWithout;
                const minSide = Math.min(row.withGames, row.withoutGames);
                const totalWith = Math.round(row.totalWith);
                const avgW = Math.round(row.avgWith);
                const avgWo = Math.round(row.avgWithout);
                const together = row.withGames;
                const apart = row.withoutGames;
                const total = together + apart;
                const pctTogether = Math.round((together / total) * 100);
                const winsWithCount = row.withWins;
                const winsWithoutCount = row.withoutWins;
                const lossesWithCount = together - winsWithCount;

                if (minSide >= 2 && wrWithout === 0 && wrWith > 0) {
                  lines.push(`0 נצחונות בלעדיו ב-${apart} משחקים, ${wrWith}% כשמשחקים ביחד`);
                } else if (minSide >= 2 && wrWith === 0 && wrWithout > 0) {
                  lines.push(`0 נצחונות ביחד ב-${together} משחקים, ${wrWithout}% בלעדיו`);
                } else if (wrWith === 100 && together >= 3) {
                  lines.push(`${together} מתוך ${together} נצחונות ביחד — רצף מושלם`);
                } else if (wrWithout === 100 && apart >= 3) {
                  lines.push(`${apart} מתוך ${apart} נצחונות בלעדיו`);
                }

                if (avgW > 0 && avgWo < 0) {
                  const ratio = Math.abs(avgW) > Math.abs(avgWo) ? Math.round(Math.abs(avgW) / Math.max(1, Math.abs(avgWo))) : null;
                  lines.push(ratio && ratio >= 2
                    ? `הופך הפסד ממוצע של ${cleanNumber(Math.abs(avgWo))} לרווח של ${cleanNumber(avgW)} — פי ${ratio}`
                    : `הופך ממפסיד (${formatSignedShekelLocal(avgWo)}) למרוויח (${formatSignedShekelLocal(avgW)}) למשחק`);
                } else if (avgW < 0 && avgWo > 0) {
                  lines.push(`הופך ממרוויח (${formatSignedShekelLocal(avgWo)}) למפסיד (${formatSignedShekelLocal(avgW)}) למשחק`);
                } else if (avgW > 0 && avgWo > 0 && avgW > avgWo * 1.5 && avgW > 10) {
                  lines.push(`ממוצע ${formatSignedShekelLocal(avgW)} איתו לעומת ${formatSignedShekelLocal(avgWo)} בלעדיו`);
                } else if (avgW < 0 && avgWo < 0 && Math.abs(avgW) > Math.abs(avgWo) * 1.5) {
                  lines.push(`הפסד גדל מ-${cleanNumber(Math.abs(avgWo))} ל-${cleanNumber(Math.abs(avgW))} למשחק איתו`);
                }

                if (Math.abs(wrDelta) >= 8 && !lines.some(l => l.includes('נצחונות'))) {
                  lines.push(`${wrWith}% נצחונות איתו (${winsWithCount}/${together}) לעומת ${wrWithout}% בלעדיו (${winsWithoutCount}/${apart})`);
                }

                if (together >= 5 && lossesWithCount <= 1 && wrWith >= 80 && !lines.some(l => l.includes('רצף'))) {
                  lines.push(`הפסיד ${lossesWithCount === 0 ? 'אפס' : 'רק פעם אחת'} ב-${together} משחקים משותפים`);
                }

                if (avgW > 0 && avgWo > 0 && Math.abs(row.impact) < 8 && together >= 5 && apart >= 3 && lines.length < 2) {
                  lines.push(`רווח יציב בשני המצבים — ${row.otherPlayerName} לא באמת משנה את התמונה`);
                } else if (avgW < 0 && avgWo < 0 && Math.abs(row.impact) < 8 && together >= 5 && apart >= 3 && lines.length < 2) {
                  lines.push(`הפסד עקבי גם איתו וגם בלעדיו — הבעיה לא ב${row.otherPlayerName}`);
                }

                if (wrWith >= 60 && wrWithout >= 60 && together >= 5 && apart >= 3 && lines.length < 2) {
                  lines.push(`אחוז נצחונות גבוה בשני המצבים — ${wrWith}% ביחד, ${wrWithout}% בנפרד`);
                } else if (wrWith <= 35 && wrWithout <= 35 && together >= 5 && apart >= 3 && lines.length < 2) {
                  lines.push(`אחוז נצחונות נמוך בשני המצבים — ${wrWith}% ביחד, ${wrWithout}% בנפרד`);
                }

                if (pctTogether >= 80 && together >= 10) {
                  lines.push(`משחקים ביחד ${pctTogether}% מהזמן (${together} מתוך ${total})`);
                } else if (pctTogether <= 20 && apart >= 10) {
                  lines.push(`לעתים נדירות ביחד — רק ${together} מתוך ${total} משחקים`);
                }

                if (Math.abs(totalWith) >= 100) {
                  lines.push(totalWith > 0
                    ? `סה"כ \u200E+${cleanNumber(totalWith)} ב-${together} משחקים משותפים`
                    : `סה"כ \u200E-${cleanNumber(Math.abs(totalWith))} ב-${together} משחקים משותפים`);
                }

                if (lines.length === 0) {
                  const impactRound = Math.round(row.impact);
                  if (impactRound > 0) {
                    lines.push(`ממוצע ${formatSignedShekelLocal(avgW)} למשחק איתו, ${formatSignedShekelLocal(avgWo)} בלעדיו — השפעה חיובית`);
                  } else if (impactRound < 0) {
                    lines.push(`ממוצע ${formatSignedShekelLocal(avgW)} למשחק איתו, ${formatSignedShekelLocal(avgWo)} בלעדיו — השפעה שלילית`);
                  } else {
                    lines.push(`ממוצע ${formatSignedShekelLocal(avgW)} למשחק איתו, ${formatSignedShekelLocal(avgWo)} בלעדיו — השפעה ניטרלית`);
                  }
                  lines.push(`${winsWithCount} נצחונות מתוך ${together} ביחד, ${winsWithoutCount} מתוך ${apart} בלעדיו`);
                }

                return lines.slice(0, 2);
              })();

              return (
                <div key={row.otherPlayerId} style={{
                  padding: '0.75rem',
                  background: 'var(--surface)',
                  borderRadius: '10px',
                  borderLeft: `4px solid ${impactColor}`,
                  opacity: isLimited ? 0.65 : 1,
                }}>
                  {/* Top row: Name + Impact badge */}
                  <div style={{ 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    alignItems: 'center',
                    marginBottom: rowInsightLines ? '0.25rem' : '0.6rem',
                  }}>
                    <span style={{
                      fontWeight: '700',
                      color: row.otherColor,
                      fontSize: '1rem',
                    }}>
                      {row.otherPlayerName}
                    </span>
                    <div style={{ 
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.3rem',
                      padding: '0.25rem 0.6rem',
                      background: row.impact > 0 ? 'rgba(16, 185, 129, 0.15)' : row.impact < 0 ? 'rgba(239, 68, 68, 0.15)' : 'rgba(255,255,255,0.05)',
                      borderRadius: '12px',
                      flexShrink: 0,
                      whiteSpace: 'nowrap',
                    }}>
                      {impactIcon && <span style={{ fontSize: '0.9rem' }}>{impactIcon}</span>}
                      <span style={{ 
                        fontWeight: '700', 
                        fontSize: '0.95rem',
                        color: impactColor,
                      }}>
                        {isZero ? '0' : `${row.impact > 0 ? '\u200E+' : ''}${cleanNumber(row.impact)}`}
                      </span>
                    </div>
                  </div>
                  {rowInsightLines && (
                    <div style={{ marginBottom: '0.5rem' }}>
                      {rowInsightLines.map((line, li) => (
                        <div key={li} style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: li === 0 ? 0 : '0.12rem', lineHeight: '1.4', direction: 'rtl', textAlign: 'right' }}>
                          {li === 0 ? '💡' : '📊'} {line}
                        </div>
                      ))}
                    </div>
                  )}
                  
                  {/* Two cards side by side */}
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    {/* WITH card */}
                    <div style={{
                      flex: 1,
                      padding: '0.5rem',
                      background: 'rgba(16, 185, 129, 0.08)',
                      borderRadius: '8px',
                      textAlign: 'center',
                    }}>
                      <div style={{ 
                        fontSize: '0.65rem', 
                        color: '#10B981', 
                        fontWeight: '600',
                        marginBottom: '0.25rem',
                        textTransform: 'uppercase',
                        letterSpacing: '0.5px',
                      }}>
                        With ({row.withGames})
                      </div>
                      <div style={{ 
                        fontWeight: '700', 
                        fontSize: '1.1rem',
                        color: avgWithColor,
                        marginBottom: '0.15rem',
                      }}>
                        {avgWithRounded === 0 ? '0' : `${avgWithRounded > 0 ? '\u200E+' : ''}${cleanNumber(row.avgWith)}`}
                      </div>
                      <div style={{ 
                        fontSize: '0.7rem', 
                        color: 'var(--text-muted)',
                      }}>
                        {Math.round(row.winRateWith)}% win rate
                      </div>
                    </div>
                    
                    {/* WITHOUT card */}
                    <div style={{
                      flex: 1,
                      padding: '0.5rem',
                      background: 'rgba(239, 68, 68, 0.08)',
                      borderRadius: '8px',
                      textAlign: 'center',
                    }}>
                      <div style={{ 
                        fontSize: '0.65rem', 
                        color: '#EF4444', 
                        fontWeight: '600',
                        marginBottom: '0.25rem',
                        textTransform: 'uppercase',
                        letterSpacing: '0.5px',
                      }}>
                        Without ({row.withoutGames})
                      </div>
                      <div style={{ 
                        fontWeight: '700', 
                        fontSize: '1.1rem',
                        color: avgWithoutColor,
                        marginBottom: '0.15rem',
                      }}>
                        {avgWithoutRounded === 0 ? '0' : `${avgWithoutRounded > 0 ? '\u200E+' : ''}${cleanNumber(row.avgWithout)}`}
                      </div>
                      <div style={{ 
                        fontSize: '0.7rem', 
                        color: 'var(--text-muted)',
                      }}>
                        {Math.round(row.winRateWithout)}% win rate
                      </div>
                    </div>
                  </div>
                  
                  {/* Balance bar at bottom */}
                  <div style={{ 
                    display: 'flex', 
                    alignItems: 'center', 
                    gap: '0.3rem',
                    marginTop: '0.5rem',
                  }}>
                    <div style={{
                      flex: 1,
                      height: '3px',
                      background: 'rgba(255,255,255,0.1)',
                      borderRadius: '2px',
                      overflow: 'hidden',
                      display: 'flex',
                    }}>
                      <div style={{ 
                        width: `${withPct}%`, 
                        background: '#10B981', 
                        borderRadius: '2px 0 0 2px',
                      }} />
                      <div style={{ 
                        width: `${100 - withPct}%`, 
                        background: '#EF4444', 
                        borderRadius: '0 2px 2px 0',
                        opacity: 0.5,
                      }} />
                    </div>
                  </div>
                  <div style={{
                    fontSize: '0.6rem',
                    color: 'var(--text-muted)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    marginTop: '0.25rem',
                    opacity: 0.7,
                  }}>
                    <span>{row.withGames} games together</span>
                    <span>{row.withoutGames} games apart</span>
                  </div>
                </div>
              );
            };

            return (
              <div className="card">
                <h2 className="card-title mb-2">🎯 With vs Without</h2>
                <div style={{ 
                  fontSize: '0.7rem', 
                  color: 'var(--text-muted)',
                  textAlign: 'center',
                  marginBottom: '0.75rem' 
                }}>
                  How does {getPlayerName(impactPlayerId)}'s average change when each player is at the table?
                </div>

                {/* Reliable results */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {reliable.map(row => renderRow(row, false))}
                </div>

                {/* Limited data section */}
                {limited.length > 0 && (
                  <div style={{ marginTop: '0.6rem' }}>
                    <button
                      type="button"
                      onClick={() => setShowLimitedData(!showLimitedData)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '0.3rem',
                        width: '100%',
                        padding: '0.4rem',
                        background: 'none',
                        border: '1px dashed var(--border)',
                        borderRadius: '6px',
                        color: 'var(--text-muted)',
                        fontSize: '0.65rem',
                        cursor: 'pointer',
                      }}
                    >
                      <span>Rarely Apart ({limited.length})</span>
                      <span>{showLimitedData ? '▲' : '▼'}</span>
                    </button>
                    {showLimitedData && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
                        {limited.map(row => renderRow(row, true))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Chemistry Summary - derived from reliable impact data only */}
          {impactData.length > 0 && (() => {
            const totalPeriodGames = filteredGames.length;
            const minGamesThreshold = Math.max(3, Math.min(10, Math.ceil(totalPeriodGames * 0.10)));
            const reliableOnly = impactData.filter(r => {
              const min = Math.min(r.withGames, r.withoutGames);
              return min >= minGamesThreshold;
            });

            const isStrongChemistry = (r: typeof impactData[0]) => {
              const minSide = Math.min(r.withGames, r.withoutGames);
              const maxSide = Math.max(r.withGames, r.withoutGames);
              const sampleBalance = minSide / maxSide;
              if (minSide < minGamesThreshold && sampleBalance < 0.08) return false;
              const winRateDelta = r.winRateWith - r.winRateWithout;
              const contradicts = (r.impact > 0 && winRateDelta < -10) || (r.impact < 0 && winRateDelta > 10);
              if (contradicts) return false;
              if (Math.abs(r.impact) >= 15) return true;
              return false;
            };

            // Rarely-apart mode: allow strong monetary signal even on very unbalanced samples.
            const isStrongChemistryRare = (r: typeof impactData[0]) => {
              const winRateDelta = r.winRateWith - r.winRateWithout;
              const contradicts = (r.impact > 0 && winRateDelta < -10) || (r.impact < 0 && winRateDelta > 10);
              if (contradicts) return false;
              return Math.abs(r.impact) >= 15;
            };

            const luckyCharms = reliableOnly
              .filter(r => r.impact > 0 && isStrongChemistry(r))
              .slice(0, 3);
            const kryptonite = reliableOnly
              .filter(r => r.impact < 0 && isStrongChemistry(r))
              .slice(-3).reverse();
            const rareLuckyCharms = impactData
              .filter(r => Math.min(r.withGames, r.withoutGames) < minGamesThreshold)
              .filter(r => r.impact > 0 && isStrongChemistryRare(r))
              .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
              .slice(0, 5);
            const rareKryptonite = impactData
              .filter(r => Math.min(r.withGames, r.withoutGames) < minGamesThreshold)
              .filter(r => r.impact < 0 && isStrongChemistryRare(r))
              .sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact))
              .slice(0, 5);
            const selectedName = getPlayerName(impactPlayerId);
            const formatSignedShekel = (value: number) => `\u200E${value > 0 ? '+' : value < 0 ? '-' : ''}${cleanNumber(Math.abs(value))}`;

            const chemistryInsights = (row: typeof impactData[0], headlineMentioned: Set<string>): string[] => {
              const isInHeadline = headlineMentioned.has(row.otherPlayerId);
              const lines: string[] = [];
              const wrWith = Math.round(row.winRateWith);
              const wrWithout = Math.round(row.winRateWithout);
              const wrDelta = wrWith - wrWithout;
              const minSide = Math.min(row.withGames, row.withoutGames);
              const totalWith = Math.round(row.totalWith);
              const avgW = Math.round(row.avgWith);
              const avgWo = Math.round(row.avgWithout);
              const together = row.withGames;
              const apart = row.withoutGames;
              const total = together + apart;
              const winsWithCount = row.withWins;
              const lossesWithCount = together - winsWithCount;
              const winsWithoutCount = row.withoutWins;
              const pctTogether = Math.round((together / total) * 100);
              const signFlip = (avgW > 0 && avgWo < 0) || (avgW < 0 && avgWo > 0);

              if (minSide >= 2 && wrWithout === 0 && wrWith > 0 && !isInHeadline) {
                lines.push(`${apart} משחקים בלעדיו — אפס נצחונות. איתו ${winsWithCount} מתוך ${together}`);
              } else if (minSide >= 2 && wrWith === 0 && wrWithout > 0 && !isInHeadline) {
                lines.push(`${together} משחקים ביחד — אפס נצחונות. בלעדיו ${winsWithoutCount} מתוך ${apart}`);
              } else if (wrWith === 100 && together >= 3 && !isInHeadline) {
                lines.push(`${together} משחקים ביחד, ${together} נצחונות — רצף מושלם`);
              } else if (wrWithout === 100 && apart >= 3) {
                lines.push(`${apart} נצחונות רצופים בלעדיו`);
              }

              if (signFlip && !isInHeadline) {
                if (avgW > 0) {
                  const ratio = Math.round(Math.abs(avgW) / Math.max(1, Math.abs(avgWo)));
                  lines.push(ratio >= 3
                    ? `ממוצע ${formatSignedShekel(avgW)} איתו לעומת ${formatSignedShekel(avgWo)} בלעדיו — פער של פי ${ratio}`
                    : `הופך ממפסיד (${formatSignedShekel(avgWo)}) למרוויח (${formatSignedShekel(avgW)}) למשחק`);
                } else {
                  lines.push(`יורד מ-${formatSignedShekel(avgWo)} ל-${formatSignedShekel(avgW)} למשחק כשמשחקים ביחד`);
                }
              } else if (!signFlip) {
                if (avgW > 0 && avgWo > 0 && avgW >= avgWo * 1.5) {
                  lines.push(`ממוצע ${formatSignedShekel(avgW)} איתו לעומת ${formatSignedShekel(avgWo)} בלעדיו`);
                } else if (avgW < 0 && avgWo < 0 && Math.abs(avgW) >= Math.abs(avgWo) * 1.5) {
                  lines.push(`הפסד גדל מ-${cleanNumber(Math.abs(avgWo))} ל-${cleanNumber(Math.abs(avgW))} למשחק איתו`);
                }
              }

              if (Math.abs(wrDelta) >= 8 && !lines.some(l => l.includes('נצחונות'))) {
                lines.push(`${wrWith}% נצחונות ביחד (${winsWithCount}/${together}) לעומת ${wrWithout}% בלעדיו (${winsWithoutCount}/${apart})`);
              }

              if (together >= 5 && lossesWithCount <= 1 && wrWith >= 80 && !lines.some(l => l.includes('רצף'))) {
                lines.push(`הפסיד ${lossesWithCount === 0 ? 'אפס' : 'רק פעם אחת'} ב-${together} משחקים משותפים`);
              }

              if (pctTogether >= 80 && together >= 10 && lines.length < 3) {
                lines.push(`שותפים קבועים — ${pctTogether}% מהמשחקים ביחד (${together} מתוך ${total})`);
              } else if (pctTogether <= 20 && together >= 3 && lines.length < 3) {
                lines.push(`לעתים נדירות ביחד — רק ${together} מתוך ${total} משחקים`);
              }

              if (Math.abs(totalWith) >= 100) {
                lines.push(totalWith > 0
                  ? `סה"כ \u200E+${cleanNumber(totalWith)} ב-${together} משחקים משותפים`
                  : `סה"כ \u200E-${cleanNumber(Math.abs(totalWith))} ב-${together} משחקים משותפים`);
              }

              if (lines.length === 0) {
                lines.push(`ממוצע ${formatSignedShekel(avgW)} למשחק איתו, ${formatSignedShekel(avgWo)} בלעדיו`);
                lines.push(`${winsWithCount} נצחונות מתוך ${together} ביחד, ${winsWithoutCount} מתוך ${apart} בלעדיו`);
              }

              return lines.slice(0, 3);
            };

            const { headlineLines: headlineInsights, mentionedIds: headlineMentionedIds } = (() => {
              const allRows = [...luckyCharms, ...kryptonite, ...rareLuckyCharms, ...rareKryptonite];
              const mentioned = new Set<string>();
              const lines: string[] = [];
              const seen = new Set<string>();

              // Global patterns — check ALL impactData (with >= 3 games together)
              const allCheck = impactData.filter(r => r.withGames >= 3);
              if (allCheck.length >= 3) {
                // Sign flips only count as dependencies when the negative side is significant.
                // A -6 average doesn't mean "goes to loss" — many individual games were still profitable.
                const SIGN_FLIP_MIN = 15;
                const criticalDeps = allCheck.filter(r => Math.round(r.avgWith) > 0 && r.avgWithout < -SIGN_FLIP_MIN);
                const toxicWith = allCheck.filter(r => r.avgWith < -SIGN_FLIP_MIN && Math.round(r.avgWithout) > 0);
                const loseToRows = allCheck.filter(r => Math.round(r.avgWith) < 0);
                const profitRows = allCheck.filter(r => Math.round(r.avgWith) > 0);
                const alwaysLoss = profitRows.length === 0;
                const alwaysProfit = loseToRows.length === 0;
                const noSignFlips = criticalDeps.length === 0 && toxicWith.length === 0;

                // Weak sign flips: avgWithout barely negative (above -SIGN_FLIP_MIN) — not "dependency" but still interesting
                const weakDeps = allCheck.filter(r => Math.round(r.avgWith) > 0 && Math.round(r.avgWithout) < 0 && r.avgWithout >= -SIGN_FLIP_MIN);

                if (alwaysLoss) {
                  lines.push(`${selectedName} בהפסד בכל הרכב — לא משנה מי על השולחן`);
                  seen.add('global');
                } else if (alwaysProfit && noSignFlips) {
                  const hurtBy = allCheck.filter(r => r.impact < -10);
                  if (weakDeps.length >= 1 && weakDeps.length <= 2) {
                    weakDeps.forEach(r => mentioned.add(r.otherPlayerId));
                    const wdNames = weakDeps.map(r => r.otherPlayerName).join(' ו');
                    lines.push(`${selectedName} ברווח עם כל שחקן — בלי ${wdNames} הממוצע יורד למינוס קל`);
                    if (hurtBy.length > 0) {
                      const topHurt = [...hurtBy].filter(r => !weakDeps.some(d => d.otherPlayerId === r.otherPlayerId)).sort((a, b) => a.impact - b.impact).slice(0, 3);
                      if (topHurt.length > 0) {
                        topHurt.forEach(r => mentioned.add(r.otherPlayerId));
                        lines.push(`${topHurt.map(r => r.otherPlayerName).join(', ')} ${topHurt.length === 1 ? 'מוריד' : 'מורידים'} את הממוצע`);
                      }
                    }
                  } else if (hurtBy.length === 0) {
                    lines.push(`${selectedName} ברווח עם כל שחקן — אף אחד לא מוריד את הממוצע`);
                  } else {
                    const topHurt = [...hurtBy].sort((a, b) => a.impact - b.impact).slice(0, 3);
                    topHurt.forEach(r => mentioned.add(r.otherPlayerId));
                    lines.push(`${selectedName} ברווח עם כל שחקן, אבל ${topHurt.map(r => r.otherPlayerName).join(', ')} ${topHurt.length === 1 ? 'מוריד' : 'מורידים'} את הממוצע`);
                  }
                  seen.add('global');
                } else if (criticalDeps.length >= 1 && criticalDeps.length <= 3) {
                  criticalDeps.forEach(r => mentioned.add(r.otherPlayerId));
                  const depNames = criticalDeps.map(r => r.otherPlayerName).join(', ');
                  lines.push(`${selectedName} תלוי ב${depNames} — בלעדי${criticalDeps.length === 1 ? 'ו' : 'הם'} יורד להפסד`);
                  seen.add('global');
                } else if (toxicWith.length >= 1 && toxicWith.length <= 2) {
                  toxicWith.forEach(r => mentioned.add(r.otherPlayerId));
                  const toxNames = toxicWith.map(r => r.otherPlayerName).join(' ו');
                  lines.push(`${selectedName} מפסיד רק עם ${toxNames} — בלעדיהם ברווח`);
                  seen.add('global');
                } else if (loseToRows.length === 1) {
                  mentioned.add(loseToRows[0].otherPlayerId);
                  lines.push(`${selectedName} ברווח עם כולם חוץ מ${loseToRows[0].otherPlayerName} (${formatSignedShekel(Math.round(loseToRows[0].avgWith))} למשחק)`);
                  seen.add('global');
                } else if (profitRows.length === 1) {
                  mentioned.add(profitRows[0].otherPlayerId);
                  lines.push(`${selectedName} בהפסד עם כולם — רק כש${profitRows[0].otherPlayerName} על השולחן יוצא ברווח`);
                  seen.add('global');
                } else if (loseToRows.length === 2 && allCheck.length >= 5) {
                  const names = loseToRows.map(r => r.otherPlayerName).join(' ו');
                  lines.push(`${selectedName} ברווח עם כמעט כולם — מפסיד רק עם ${names}`);
                  seen.add('global');
                } else if (profitRows.length >= 1 && profitRows.length <= 2 && allCheck.length >= 5) {
                  const names = profitRows.map(r => r.otherPlayerName).join(' ו');
                  lines.push(`${selectedName} מתקשה מול רוב השולחן — ברווח רק עם ${names}`);
                  seen.add('global');
                } else if (criticalDeps.length + toxicWith.length >= 4) {
                  lines.push(`ההרכב משנה הכל — ${selectedName} תלוי מאוד במי שעל השולחן`);
                  seen.add('global');
                }

                if (reliableOnly.length >= 3 && lines.length < 2) {
                  const avgImpactSpread = reliableOnly.reduce((sum, r) => sum + Math.abs(r.impact), 0) / reliableOnly.length;
                  if (avgImpactSpread < 8) {
                    lines.push(`${selectedName} עקבי — ההרכב כמעט לא משפיע על הביצועים (פער ממוצע ${cleanNumber(Math.round(avgImpactSpread))})`);
                  }
                }
              }

              // Row-specific insights from chemistry rows
              for (const r of allRows) {
                if (lines.length >= 4) break;
                const wrWith = Math.round(r.winRateWith);
                const wrWithout = Math.round(r.winRateWithout);
                const avgW = Math.round(r.avgWith);
                const avgWo = Math.round(r.avgWithout);
                const signFlip = (avgW > 0 && avgWo < 0) || (avgW < 0 && avgWo > 0);
                const minSide = Math.min(r.withGames, r.withoutGames);

                if (signFlip && !seen.has('flip') && !mentioned.has(r.otherPlayerId)) {
                  seen.add('flip');
                  mentioned.add(r.otherPlayerId);
                  lines.push(avgW > 0
                    ? `${selectedName} עובר מהפסד לרווח עם ${r.otherPlayerName} (בלעדיו ${formatSignedShekel(avgWo)}, איתו ${formatSignedShekel(avgW)})`
                    : `${selectedName} עובר מרווח להפסד עם ${r.otherPlayerName} (בלעדיו ${formatSignedShekel(avgWo)}, איתו ${formatSignedShekel(avgW)})`);
                } else if (minSide >= 2 && wrWithout === 0 && wrWith > 0 && !seen.has('zero_wr')) {
                  seen.add('zero_wr');
                  mentioned.add(r.otherPlayerId);
                  lines.push(`אפס נצחונות בלי ${r.otherPlayerName} (${r.withoutGames} משחקים)`);
                } else if (minSide >= 2 && wrWith === 0 && wrWithout > 0 && !seen.has('zero_wr_with')) {
                  seen.add('zero_wr_with');
                  mentioned.add(r.otherPlayerId);
                  lines.push(`אפס נצחונות עם ${r.otherPlayerName} (${r.withGames} משחקים)`);
                } else if (wrWith === 100 && r.withGames >= 3 && !seen.has('perfect')) {
                  seen.add('perfect');
                  mentioned.add(r.otherPlayerId);
                  lines.push(`${r.withGames} נצחונות רצופים עם ${r.otherPlayerName}`);
                } else if (Math.abs(r.impact) >= 30 && !seen.has(r.otherPlayerId) && !mentioned.has(r.otherPlayerId)) {
                  seen.add(r.otherPlayerId);
                  mentioned.add(r.otherPlayerId);
                  lines.push(`השפעה של ${formatSignedShekel(Math.round(r.impact))} למשחק עם ${r.otherPlayerName}`);
                }
              }

              if (lines.length === 0 && allRows.length > 0) {
                const strongest = allRows.reduce((a, b) => Math.abs(a.impact) > Math.abs(b.impact) ? a : b);
                mentioned.add(strongest.otherPlayerId);
                lines.push(`ההשפעה החזקה ביותר: ${strongest.otherPlayerName} (${formatSignedShekel(Math.round(strongest.impact))} למשחק)`);
              }

              return { headlineLines: lines.slice(0, 4), mentionedIds: mentioned };
            })();


            return (
              <div className="card">
                <h2 className="card-title mb-2">🧪 {selectedName}'s Chemistry</h2>
                <div style={{ 
                  fontSize: '0.7rem', 
                  color: 'var(--text-muted)',
                  textAlign: 'center',
                  marginBottom: headlineInsights.length > 0 ? '0.35rem' : '0.75rem',
                }}>
                  Based on balanced samples only ({minGamesThreshold}+ games on each side)
                </div>
                {headlineInsights.length > 0 && (
                  <div style={{ marginBottom: '0.75rem' }}>
                    <div style={{ 
                      fontSize: '0.7rem', 
                      fontWeight: '700', 
                      color: '#A78BFA', 
                      marginBottom: '0.4rem',
                    }}>
                      🔍 Key Insights
                    </div>
                    <div style={{
                      padding: '0.4rem 0.5rem',
                      background: 'rgba(139, 92, 246, 0.08)',
                      borderRadius: '6px',
                      fontSize: '0.75rem',
                      direction: 'rtl',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.2rem',
                    }}>
                      {headlineInsights.map((line, i) => (
                        <div key={i} style={{
                          display: 'flex',
                          alignItems: 'baseline',
                          gap: '0.3rem',
                          color: 'var(--text)',
                          fontWeight: '500',
                        }}>
                          <span style={{ flexShrink: 0 }}>📌</span>
                          <span>{line}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div style={{ marginBottom: '0.75rem' }}>
                  <div style={{ 
                    fontSize: '0.7rem', 
                    fontWeight: '700', 
                    color: '#10B981', 
                    marginBottom: '0.4rem',
                  }}>
                    🍀 Lucky Charms
                  </div>
                  {luckyCharms.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                      {luckyCharms.map((row, idx) => {
                        const wrDelta = Math.round(row.winRateWith - row.winRateWithout);
                        return (
                        <div key={idx} style={{
                          padding: '0.4rem 0.5rem',
                          background: 'rgba(16, 185, 129, 0.08)',
                          borderRadius: '6px',
                          fontSize: '0.75rem',
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div>
                              <span style={{ fontWeight: '700', color: row.otherColor }}>{row.otherPlayerName}</span>
                              <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginRight: '0.3rem' }}>
                                {' '}({row.withGames} games together)
                              </span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                              <span style={{ fontWeight: '700', color: '#10B981' }}>
                                {'\u200E'}+{cleanNumber(row.impact)}
                              </span>
                              {wrDelta !== 0 && (
                                <span style={{ fontSize: '0.6rem', color: wrDelta > 0 ? '#10B981' : '#EF4444', fontWeight: '600' }}>
                                  {wrDelta > 0 ? '↑' : '↓'}{Math.abs(wrDelta)}%W
                                </span>
                              )}
                            </div>
                          </div>
                          {chemistryInsights(row, headlineMentionedIds).map((line, li) => (
                            <div key={li} style={{ display: 'flex', alignItems: 'baseline', gap: '0.25rem', fontSize: '0.7rem', color: 'var(--text)', marginTop: li === 0 ? '0.3rem' : '0.12rem', direction: 'rtl', lineHeight: '1.4' }}>
                              <span style={{ flexShrink: 0 }}>{li === 0 ? '💡' : '📊'}</span>
                              <span>{line}</span>
                            </div>
                          ))}
                        </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div style={{
                      padding: '0.5rem',
                      background: 'rgba(16, 185, 129, 0.05)',
                      borderRadius: '6px',
                      fontSize: '0.7rem',
                      color: 'var(--text-muted)',
                      textAlign: 'center',
                      fontStyle: 'italic',
                    }}>
                      No standout lucky charm — {selectedName} performs consistently regardless of company
                    </div>
                  )}
                  {rareLuckyCharms.length > 0 && (
                    <div style={{ marginTop: '0.45rem' }}>
                      <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                        Rarely Apart (מדגם קטן)
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                        {rareLuckyCharms.map((row, idx) => {
                          const wrDelta = Math.round(row.winRateWith - row.winRateWithout);
                          return (
                            <div key={`rare-lucky-${idx}`} style={{ padding: '0.4rem 0.5rem', background: 'rgba(16, 185, 129, 0.08)', borderRadius: '6px', fontSize: '0.75rem', opacity: 0.9 }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div>
                                  <span style={{ fontWeight: '700', color: row.otherColor }}>{row.otherPlayerName}</span>
                                  <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginRight: '0.3rem' }}>
                                    {' '}({row.withGames} games together)
                                  </span>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                  <span style={{ fontWeight: '700', color: '#10B981' }}>
                                    {'\u200E'}+{cleanNumber(row.impact)}
                                  </span>
                                  {wrDelta !== 0 && (
                                    <span style={{ fontSize: '0.6rem', color: wrDelta > 0 ? '#10B981' : '#EF4444', fontWeight: '600' }}>
                                      {wrDelta > 0 ? '↑' : '↓'}{Math.abs(wrDelta)}%W
                                    </span>
                                  )}
                                </div>
                              </div>
                              {chemistryInsights(row, headlineMentionedIds).map((line, li) => (
                                <div key={li} style={{ display: 'flex', alignItems: 'baseline', gap: '0.25rem', fontSize: '0.7rem', color: 'var(--text)', marginTop: li === 0 ? '0.3rem' : '0.12rem', direction: 'rtl', lineHeight: '1.4' }}>
                                  <span style={{ flexShrink: 0 }}>{li === 0 ? '💡' : '📊'}</span>
                                  <span>{line}</span>
                                </div>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                <div>
                  <div style={{ 
                    fontSize: '0.7rem', 
                    fontWeight: '700', 
                    color: '#EF4444', 
                    marginBottom: '0.4rem',
                  }}>
                    💀 Kryptonite
                  </div>
                  {kryptonite.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                      {kryptonite.map((row, idx) => {
                        const wrDelta = Math.round(row.winRateWith - row.winRateWithout);
                        return (
                        <div key={idx} style={{
                          padding: '0.4rem 0.5rem',
                          background: 'rgba(239, 68, 68, 0.08)',
                          borderRadius: '6px',
                          fontSize: '0.75rem',
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div>
                              <span style={{ fontWeight: '700', color: row.otherColor }}>{row.otherPlayerName}</span>
                              <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginRight: '0.3rem' }}>
                                {' '}({row.withGames} games together)
                              </span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                              <span style={{ fontWeight: '700', color: '#EF4444' }}>
                                {cleanNumber(row.impact)}
                              </span>
                              {wrDelta !== 0 && (
                                <span style={{ fontSize: '0.6rem', color: wrDelta > 0 ? '#10B981' : '#EF4444', fontWeight: '600' }}>
                                  {wrDelta > 0 ? '↑' : '↓'}{Math.abs(wrDelta)}%W
                                </span>
                              )}
                            </div>
                          </div>
                          {chemistryInsights(row, headlineMentionedIds).map((line, li) => (
                            <div key={li} style={{ display: 'flex', alignItems: 'baseline', gap: '0.25rem', fontSize: '0.7rem', color: 'var(--text)', marginTop: li === 0 ? '0.3rem' : '0.12rem', direction: 'rtl', lineHeight: '1.4' }}>
                              <span style={{ flexShrink: 0 }}>{li === 0 ? '💡' : '📊'}</span>
                              <span>{line}</span>
                            </div>
                          ))}
                        </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div style={{
                      padding: '0.5rem',
                      background: 'rgba(239, 68, 68, 0.05)',
                      borderRadius: '6px',
                      fontSize: '0.7rem',
                      color: 'var(--text-muted)',
                      textAlign: 'center',
                      fontStyle: 'italic',
                    }}>
                      No clear kryptonite — {selectedName} holds strong against everyone
                    </div>
                  )}
                  {rareKryptonite.length > 0 && (
                    <div style={{ marginTop: '0.45rem' }}>
                      <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                        Rarely Apart (מדגם קטן)
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                        {rareKryptonite.map((row, idx) => {
                          const wrDelta = Math.round(row.winRateWith - row.winRateWithout);
                          return (
                            <div key={`rare-krypto-${idx}`} style={{ padding: '0.4rem 0.5rem', background: 'rgba(239, 68, 68, 0.08)', borderRadius: '6px', fontSize: '0.75rem', opacity: 0.9 }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div>
                                  <span style={{ fontWeight: '700', color: row.otherColor }}>{row.otherPlayerName}</span>
                                  <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginRight: '0.3rem' }}>
                                    {' '}({row.withGames} games together)
                                  </span>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                  <span style={{ fontWeight: '700', color: '#EF4444' }}>
                                    {cleanNumber(row.impact)}
                                  </span>
                                  {wrDelta !== 0 && (
                                    <span style={{ fontSize: '0.6rem', color: wrDelta > 0 ? '#10B981' : '#EF4444', fontWeight: '600' }}>
                                      {wrDelta > 0 ? '↑' : '↓'}{Math.abs(wrDelta)}%W
                                    </span>
                                  )}
                                </div>
                              </div>
                              {chemistryInsights(row, headlineMentionedIds).map((line, li) => (
                                <div key={li} style={{ display: 'flex', alignItems: 'baseline', gap: '0.25rem', fontSize: '0.7rem', color: 'var(--text)', marginTop: li === 0 ? '0.3rem' : '0.12rem', direction: 'rtl', lineHeight: '1.4' }}>
                                  <span style={{ flexShrink: 0 }}>{li === 0 ? '💡' : '📊'}</span>
                                  <span>{line}</span>
                                </div>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                <div style={{ 
                  fontSize: '0.55rem', 
                  color: 'var(--text-muted)',
                  textAlign: 'center',
                  marginTop: '0.6rem',
                }}>
                  Impact = avg profit difference + win rate alignment • {getTimeframeLabel()}
                </div>
              </div>
            );
          })()}
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
