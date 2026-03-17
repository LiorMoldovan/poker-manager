import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import html2canvas from 'html2canvas';
import { PlayerStats, Player, PlayerType } from '../types';
import { getPlayerStats, getAllPlayers, getAllGames, getAllGamePlayers, getSettings, getChronicleProfiles, saveChronicleProfiles } from '../database/storage';
import { formatCurrency, getProfitColor, cleanNumber, formatHebrewHalf } from '../utils/calculations';
import { generateMilestones, adaptPlayerStats, MilestoneOptions } from '../utils/milestones';
import { generatePlayerChronicle, ChroniclePlayerData, getLastUsedModel } from '../utils/geminiAI';
import { usePermissions } from '../App';
import { syncToCloud } from '../database/githubSync';

type TimePeriod = 'all' | 'h1' | 'h2' | 'year' | 'month';
type ViewMode = 'table' | 'records' | 'players';
type PlayerSubTab = 'stats' | 'stories';
type RecordsSubTab = 'global' | 'playerRecords';

const StatisticsScreen = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { role } = usePermissions();
  const locationState = location.state as { 
    viewMode?: ViewMode;
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
  const [viewMode, setViewMode] = useState<ViewMode>(initialViewMode);
  const [playerSubTab, setPlayerSubTab] = useState<PlayerSubTab>('stats');
  const [recordsSubTab, setRecordsSubTab] = useState<RecordsSubTab>('global');
  const [sortBy, setSortBy] = useState<'profit' | 'games' | 'winRate'>('profit');
  const [tableMode, setTableMode] = useState<'profit' | 'gainLoss'>('profit');
  const [selectedPlayers, setSelectedPlayers] = useState<Set<string>>(new Set());
  const [selectedTypes] = useState<Set<PlayerType>>(new Set(['permanent', 'permanent_guest', 'guest']));
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
  const [isSharingPodium, setIsSharingPodium] = useState(false);
  const [isSharingHallOfFame, setIsSharingHallOfFame] = useState(false);
  const [isSharingRebuyStats, setIsSharingRebuyStats] = useState(false);
  const [isSharingTop10, setIsSharingTop10] = useState(false);
  const tableRef = useRef<HTMLDivElement>(null);
  const top20Ref = useRef<HTMLDivElement>(null);
  const top10Ref = useRef<HTMLDivElement>(null);
  const podiumRef = useRef<HTMLDivElement>(null);
  const hallOfFameRef = useRef<HTMLDivElement>(null);
  const rebuyStatsRef = useRef<HTMLDivElement>(null);
  const chronicleRef = useRef<HTMLDivElement>(null);

  // Chronicle AI state
  const [chronicleStories, setChronicleStories] = useState<Record<string, string>>({});
  const [chronicleLoading, setChronicleLoading] = useState(false);
  const [chronicleError, setChronicleError] = useState<string | null>(null);
  const [isSharingChronicle, setIsSharingChronicle] = useState(false);
  const [chronicleModelName, setChronicleModelName] = useState<string>('');
  const chronicleGenRef = useRef(false);

  const HEBREW_MONTH_NAMES = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

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

  const getHebrewTimeframeLabel = () => {
    if (timePeriod === 'all') return 'כל הזמנים';
    if (timePeriod === 'year') return `שנת ${selectedYear}`;
    if (timePeriod === 'h1') return formatHebrewHalf(1, selectedYear);
    if (timePeriod === 'h2') return formatHebrewHalf(2, selectedYear);
    if (timePeriod === 'month') return `${HEBREW_MONTH_NAMES[selectedMonth - 1]} ${selectedYear}`;
    return '';
  };

  const getChronicleKey = () => {
    if (timePeriod === 'all') return 'all';
    if (timePeriod === 'year') return `${selectedYear}`;
    if (timePeriod === 'h1') return `H1-${selectedYear}`;
    if (timePeriod === 'h2') return `H2-${selectedYear}`;
    if (timePeriod === 'month') return `${selectedYear}-${String(selectedMonth).padStart(2, '0')}`;
    return 'all';
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

  const handleShareTop10 = async () => {
    if (!top10Ref.current) return;
    setIsSharingTop10(true);
    try {
      const canvas = await html2canvas(top10Ref.current, {
        backgroundColor: '#1a1a2e',
        scale: 2,
      });
      canvas.toBlob(async (blob) => {
        if (!blob) { setIsSharingTop10(false); return; }
        const file = new File([blob], 'poker-top10-wins.png', { type: 'image/png' });
        if (navigator.share && navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({ files: [file], title: 'Top 10 Single Night Wins' });
          } catch {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = 'poker-top10-wins.png'; a.click();
            URL.revokeObjectURL(url);
          }
        } else {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = 'poker-top10-wins.png'; a.click();
          URL.revokeObjectURL(url);
        }
        setIsSharingTop10(false);
      }, 'image/png');
    } catch (error) {
      console.error('Error sharing top 10:', error);
      setIsSharingTop10(false);
    }
  };

  // Share rebuy stats as screenshot
  const handleShareRebuyStats = async () => {
    if (!rebuyStatsRef.current) return;
    
    setIsSharingRebuyStats(true);
    try {
      const canvas = await html2canvas(rebuyStatsRef.current, {
        backgroundColor: '#1a1a2e',
        scale: 2,
      });
      
      canvas.toBlob(async (blob) => {
        if (!blob) {
          setIsSharingRebuyStats(false);
          return;
        }
        
        const file = new File([blob], 'poker-rebuy-stats.png', { type: 'image/png' });
        
        if (navigator.share && navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({
              files: [file],
              title: 'Poker Rebuy Stats',
            });
          } catch (err) {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'poker-rebuy-stats.png';
            a.click();
            URL.revokeObjectURL(url);
          }
        } else {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'poker-rebuy-stats.png';
          a.click();
          URL.revokeObjectURL(url);
        }
        setIsSharingRebuyStats(false);
      }, 'image/png');
    } catch (error) {
      console.error('Error sharing rebuy stats:', error);
      setIsSharingRebuyStats(false);
    }
  };

  // Share podium as screenshot
  const handleSharePodium = async () => {
    if (!podiumRef.current) return;
    
    setIsSharingPodium(true);
    try {
      const canvas = await html2canvas(podiumRef.current, {
        backgroundColor: '#1a1a2e',
        scale: 2,
      });
      
      canvas.toBlob(async (blob) => {
        if (!blob) {
          setIsSharingPodium(false);
          return;
        }
        
        const file = new File([blob], 'poker-podium.png', { type: 'image/png' });
        
        if (navigator.share && navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({
              files: [file],
              title: 'Poker Podium',
            });
          } catch (err) {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'poker-podium.png';
            a.click();
            URL.revokeObjectURL(url);
          }
        } else {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'poker-podium.png';
          a.click();
          URL.revokeObjectURL(url);
        }
        setIsSharingPodium(false);
      }, 'image/png');
    } catch (error) {
      console.error('Error sharing podium:', error);
      setIsSharingPodium(false);
    }
  };

  // Share Hall of Fame as screenshot
  const handleShareHallOfFame = async () => {
    if (!hallOfFameRef.current) return;
    
    setIsSharingHallOfFame(true);
    try {
      const canvas = await html2canvas(hallOfFameRef.current, {
        backgroundColor: '#1a1a2e',
        scale: 2,
      });
      
      canvas.toBlob(async (blob) => {
        if (!blob) {
          setIsSharingHallOfFame(false);
          return;
        }
        
        const file = new File([blob], 'poker-hall-of-fame.png', { type: 'image/png' });
        
        if (navigator.share && navigator.canShare({ files: [file] })) {
          try {
            await navigator.share({
              files: [file],
              title: 'Poker Hall of Fame',
            });
          } catch (err) {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'poker-hall-of-fame.png';
            a.click();
            URL.revokeObjectURL(url);
          }
        } else {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'poker-hall-of-fame.png';
          a.click();
          URL.revokeObjectURL(url);
        }
        setIsSharingHallOfFame(false);
      }, 'image/png');
    } catch (error) {
      console.error('Error sharing hall of fame:', error);
      setIsSharingHallOfFame(false);
    }
  };

  const handleShareChronicle = async () => {
    if (!chronicleRef.current) return;
    setIsSharingChronicle(true);
    try {
      const playerCards = chronicleRef.current.querySelectorAll<HTMLElement>('[data-chronicle-player]');
      if (playerCards.length === 0) { setIsSharingChronicle(false); return; }

      const PLAYERS_PER_PAGE = 3;
      const chunks: HTMLElement[][] = [];
      const allCards = Array.from(playerCards);
      for (let i = 0; i < allCards.length; i += PLAYERS_PER_PAGE) {
        chunks.push(allCards.slice(i, i + PLAYERS_PER_PAGE));
      }

      const titleLabel = getTimeframeLabel();
      const files: File[] = [];

      for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];
        const pageNum = chunks.length > 1 ? ` (${ci + 1}/${chunks.length})` : '';

        const container = document.createElement('div');
        container.style.cssText = 'position: absolute; left: -9999px; top: 0; width: 375px; padding: 1.25rem; background: #1a1a2e; border-radius: 12px; font-family: system-ui, -apple-system, sans-serif;';
        container.innerHTML = `
          <div style="text-align: center; margin-bottom: 1.25rem;">
            <div style="font-size: 2rem; margin-bottom: 0.25rem;">📜</div>
            <h3 style="margin: 0; font-size: 1.2rem; font-weight: 700; color: #f1f5f9;">
              הכרוניקה — ${titleLabel}${pageNum}
            </h3>
            <div style="font-size: 0.75rem; color: #A855F7; margin-top: 0.25rem;">Powered by Gemini ✨</div>
            ${chronicleModelName ? `<div style="font-size: 0.55rem; color: #64748b; margin-top: 0.1rem; opacity: 0.7;">model: ${chronicleModelName}</div>` : ''}
          </div>
          <div id="players-slot"></div>
          <div style="text-align: center; margin-top: 1rem; font-size: 0.65rem; color: #94a3b8; opacity: 0.5;">Poker Manager 🎲</div>
        `;

        const slot = container.querySelector('#players-slot')!;
        for (const card of chunk) {
          const clone = card.cloneNode(true) as HTMLElement;
          clone.style.marginBottom = '0.75rem';
          slot.appendChild(clone);
        }

        document.body.appendChild(container);
        const canvas = await html2canvas(container, { backgroundColor: '#1a1a2e', scale: 2, logging: false, useCORS: true });
        document.body.removeChild(container);

        const blob = await new Promise<Blob>((resolve) => { canvas.toBlob((b) => resolve(b!), 'image/png', 1.0); });
        const fileName = chunks.length > 1 ? `poker-chronicle-${ci + 1}.png` : 'poker-chronicle.png';
        files.push(new File([blob], fileName, { type: 'image/png' }));
      }

      if (navigator.share && navigator.canShare({ files })) {
        try {
          await navigator.share({ files, title: 'Poker Chronicle' });
        } catch {
          for (const file of files) {
            const url = URL.createObjectURL(file);
            const a = document.createElement('a');
            a.href = url; a.download = file.name; a.click();
            URL.revokeObjectURL(url);
          }
        }
      } else {
        for (const file of files) {
          const url = URL.createObjectURL(file);
          const a = document.createElement('a');
          a.href = url; a.download = file.name; a.click();
          URL.revokeObjectURL(url);
        }
      }
      setIsSharingChronicle(false);
    } catch (error) {
      console.error('Error sharing chronicle:', error);
      setIsSharingChronicle(false);
    }
  };

  // Show all games for a player (for table row click)
  const showPlayerGames = (player: PlayerStats) => {
    const dateFilter = getDateFilter();
    const allGames = getAllGames().filter(g => {
      if (g.status !== 'completed') return false;
      if (!dateFilter) return true;
      const gameDate = new Date(g.date || g.createdAt);
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

  // Get top 20 single night wins (filtered by period and player types)
  const top20Wins = useMemo(() => {
    const dateFilter = getDateFilter();
    const allGames = getAllGames().filter(g => {
      if (g.status !== 'completed') return false;
      if (!dateFilter) return true;
      const gameDate = new Date(g.date || g.createdAt);
      if (dateFilter.start && gameDate < dateFilter.start) return false;
      if (dateFilter.end && gameDate > dateFilter.end) return false;
      return true;
    });
    const allGamePlayers = getAllGamePlayers();
    
    // Get player IDs that match selected types
    const validPlayerIds = new Set(
      players.filter(p => selectedTypes.has(p.type)).map(p => p.id)
    );
    
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
        // Filter by player type
        if (!validPlayerIds.has(gp.playerId)) continue;
        
        if (gp.profit > 0) { // Only wins
          // Look up current player name from database
          const currentPlayer = players.find(p => p.id === gp.playerId);
          const playerName = currentPlayer?.name || gp.playerName;
          
          allResults.push({
            playerName: playerName,
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
  }, [stats, players, selectedTypes, timePeriod, selectedYear, selectedMonth]);

  // Get top 20 single night wins ALL TIME (no date filter, for Global Records)
  const top20WinsAllTime = useMemo(() => {
    const allGames = getAllGames().filter(g => g.status === 'completed');
    const allGamePlayers = getAllGamePlayers();
    
    const validPlayerIds = new Set(
      players.filter(p => selectedTypes.has(p.type)).map(p => p.id)
    );
    
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
        if (!validPlayerIds.has(gp.playerId)) continue;
        
        if (gp.profit > 0) {
          const currentPlayer = players.find(p => p.id === gp.playerId);
          const playerName = currentPlayer?.name || gp.playerName;
          
          allResults.push({
            playerName,
            profit: gp.profit,
            date: game.date,
            gameId: game.id,
            playersCount
          });
        }
      }
    }
    
    return allResults
      .sort((a, b) => b.profit - a.profit)
      .slice(0, 20);
  }, [players, selectedTypes]);

  // Calculate podium data for H1, H2, and Yearly - INDEPENDENT of current filters
  const podiumData = useMemo(() => {
    // If players not loaded yet, return empty data
    if (players.length === 0) {
      return { h1: [], h2: [], yearly: [], year: new Date().getFullYear(), history: [] };
    }
    
    const currentYear = new Date().getFullYear();
    const allGames = getAllGames().filter(g => g.status === 'completed');
    const allGamePlayers = getAllGamePlayers();
    // USE STATE DATA instead of fetching from storage - ensures we use current synced data
    const allPlayers = players;
    
    // Helper to calculate stats for a specific period - returns top 3 for Hall of Fame
    // Only includes permanent players (matches Season Podium logic)
    const calculatePeriodTop3 = (start: Date, end: Date): Array<{ playerName: string; profit: number }> => {
      const periodGames = allGames.filter(g => {
        const gameDate = new Date(g.date || g.createdAt);
        return gameDate >= start && gameDate <= end;
      });
      
      if (periodGames.length === 0) return [];
      
      // Calculate profit per player - ALL player types for historical accuracy
      const playerProfits: Record<string, { playerId: string; playerName: string; profit: number; gamesPlayed: number }> = {};
      
      for (const game of periodGames) {
        const gamePlayers = allGamePlayers.filter(gp => gp.gameId === game.id);
        for (const gp of gamePlayers) {
          // Include ALL player types - Hall of Fame is historical, shows everyone
          if (!playerProfits[gp.playerId]) {
            playerProfits[gp.playerId] = {
              playerId: gp.playerId,
              playerName: gp.playerName, // Temporary, will be updated below
              profit: 0,
              gamesPlayed: 0
            };
          }
          playerProfits[gp.playerId].profit += gp.profit;
          playerProfits[gp.playerId].gamesPlayed += 1;
        }
      }
      
      // Update all player names to use CURRENT names from database
      Object.values(playerProfits).forEach(p => {
        const currentPlayer = allPlayers.find(player => player.id === p.playerId);
        if (currentPlayer) {
          p.playerName = currentPlayer.name; // Use current name from database
        }
      });
      
      // Minimum games to qualify = 33% of period games - consistent with active players filter
      const minGames = Math.ceil(periodGames.length * 0.33);
      
      // Filter to ACTIVE players (met min games) and sort by profit - return top 3
      return Object.values(playerProfits)
        .filter(p => p.gamesPlayed >= minGames)
        .sort((a, b) => b.profit - a.profit)
        .slice(0, 3)
        .map(p => ({ playerName: p.playerName, profit: p.profit }));
    };

    // Helper to calculate stats for a specific period - returns top 3 for Season Podium
    // Only includes PERMANENT players for current season
    const calculatePeriodStats = (start: Date, end: Date) => {
      const periodGames = allGames.filter(g => {
        const gameDate = new Date(g.date || g.createdAt);
        return gameDate >= start && gameDate <= end;
      });
      
      if (periodGames.length === 0) return [];
      
      // Calculate profit per player - ALL player types
      const playerProfits: Record<string, { playerId: string; playerName: string; profit: number; gamesPlayed: number }> = {};
      
      for (const game of periodGames) {
        const gamePlayers = allGamePlayers.filter(gp => gp.gameId === game.id);
        for (const gp of gamePlayers) {
          // Include ALL player types - show whoever has highest profit
          if (!playerProfits[gp.playerId]) {
            playerProfits[gp.playerId] = {
              playerId: gp.playerId,
              playerName: gp.playerName, // Temporary, will be updated below
              profit: 0,
              gamesPlayed: 0
            };
          }
          playerProfits[gp.playerId].profit += gp.profit;
          playerProfits[gp.playerId].gamesPlayed += 1;
        }
      }
      
      // Update all player names to use CURRENT names from database
      Object.values(playerProfits).forEach(p => {
        const currentPlayer = allPlayers.find(player => player.id === p.playerId);
        if (currentPlayer) {
          p.playerName = currentPlayer.name; // Use current name from database
        }
      });
      
      // Calculate min games threshold (33% of period games)
      const minGames = Math.ceil(periodGames.length * 0.33);
      
      // Filter to active players and sort by profit
      return Object.values(playerProfits)
        .filter(p => p.gamesPlayed >= minGames)
        .sort((a, b) => b.profit - a.profit)
        .slice(0, 3); // Top 3
    };
    
    // H1: Jan-Jun of current year
    const h1Start = new Date(currentYear, 0, 1);
    const h1End = new Date(currentYear, 5, 30, 23, 59, 59);
    const h1 = calculatePeriodStats(h1Start, h1End);
    
    // H2: Jul-Dec of current year
    const h2Start = new Date(currentYear, 6, 1);
    const h2End = new Date(currentYear, 11, 31, 23, 59, 59);
    const h2 = calculatePeriodStats(h2Start, h2End);
    
    // Full Year
    const yearStart = new Date(currentYear, 0, 1);
    const yearEnd = new Date(currentYear, 11, 31, 23, 59, 59);
    const yearly = calculatePeriodStats(yearStart, yearEnd);
    
    // Calculate historical champions for all years (from 2021 to current year)
    // This updates automatically each year - in 2026 it will include 2026, 2025, etc.
    const history: Array<{
      year: number;
      h1Top3: Array<{ playerName: string; profit: number }>;
      h2Top3: Array<{ playerName: string; profit: number }>;
      yearlyTop3: Array<{ playerName: string; profit: number }>;
    }> = [];
    
    for (let year = currentYear; year >= 2021; year--) {
      let h1Top3, h2Top3, yearlyTop3;
      
      // For CURRENT year, use the SAME data as Season Podium to ensure consistency
      if (year === currentYear) {
        h1Top3 = h1.slice(0, 3).map(p => ({ playerName: p.playerName, profit: p.profit }));
        h2Top3 = h2.slice(0, 3).map(p => ({ playerName: p.playerName, profit: p.profit }));
        yearlyTop3 = yearly.slice(0, 3).map(p => ({ playerName: p.playerName, profit: p.profit }));
      } else {
        // For historical years, calculate separately
        const yearH1Start = new Date(year, 0, 1);
        const yearH1End = new Date(year, 5, 30, 23, 59, 59);
        const yearH2Start = new Date(year, 6, 1);
        const yearH2End = new Date(year, 11, 31, 23, 59, 59);
        const fullYearStart = new Date(year, 0, 1);
        const fullYearEnd = new Date(year, 11, 31, 23, 59, 59);
        
        h1Top3 = calculatePeriodTop3(yearH1Start, yearH1End);
        h2Top3 = calculatePeriodTop3(yearH2Start, yearH2End);
        yearlyTop3 = calculatePeriodTop3(fullYearStart, fullYearEnd);

        if (year === 2021 && yearlyTop3.length >= 3) {
          yearlyTop3[2] = { playerName: 'אייל', profit: 185 };
        }
        if (year === 2023 && yearlyTop3.length >= 3) {
          yearlyTop3[2] = { playerName: 'מלמד', profit: 159 };
        }
      }
      
      // Only add if there's at least one result
      if (h1Top3.length > 0 || h2Top3.length > 0 || yearlyTop3.length > 0) {
        history.push({
          year,
          h1Top3,
          h2Top3,
          yearlyTop3
        });
      }
    }
    
    return { h1, h2, yearly, year: currentYear, history };
  }, [players]); // Recalculate when player data changes (name updates, syncs, etc.)

  // Load initial data on mount
  useEffect(() => {
    loadStats();
    
    // Listen for storage changes (e.g., from GitHub sync)
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'poker_players' || e.key === 'poker_games' || e.key === 'poker_game_players') {
        loadStats();
      }
    };
    
    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  
  // Reload data when filters change
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
    if (savedPlayerInfo && viewMode === 'players' && stats.length > 0) {
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
      const gameDate = new Date(g.date || g.createdAt);
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
      const gameDate = new Date(g.date || g.createdAt);
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

  // Stats available for selection (all types included)
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

  // Update selected players when active filter or stats change — default to permanent players only
  useEffect(() => {
    if (availableStats.length > 0) {
      const permanentPlayerIds = new Set(
        players.filter(p => p.type === 'permanent').map(p => p.id)
      );
      const permanentStatsIds = availableStats
        .filter(s => permanentPlayerIds.has(s.playerId))
        .map(s => s.playerId);
      setSelectedPlayers(new Set(
        permanentStatsIds.length > 0 ? permanentStatsIds : availableStats.map(p => p.playerId)
      ));
    }
  }, [filterActiveOnly, stats.length, availableStats]);

  // Load cached chronicle stories on period change; auto-generate for admin if new data
  useEffect(() => {
    if (viewMode !== 'players' || playerSubTab !== 'stories') return;
    const periodKey = getChronicleKey();
    const cached = getChronicleProfiles(periodKey);
    if (cached) {
      setChronicleStories(cached.profiles);
    } else {
      setChronicleStories({});
    }
    setChronicleError(null);
    chronicleGenRef.current = false;
  }, [viewMode, playerSubTab, timePeriod, selectedYear, selectedMonth]);

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

  // Rebuy stats per player for the selected period
  const rebuyStats = useMemo(() => {
    const dateFilter = getDateFilter();
    const allGames = getAllGames().filter(g => {
      if (g.status !== 'completed') return false;
      if (!dateFilter) return true;
      const gameDate = new Date(g.date || g.createdAt);
      if (dateFilter.start && gameDate < dateFilter.start) return false;
      if (dateFilter.end && gameDate > dateFilter.end) return false;
      return true;
    });
    const allGamePlayers = getAllGamePlayers();
    const settings = getSettings();
    const gameIds = new Set(allGames.map(g => g.id));

    const playerMap = new Map<string, {
      playerName: string;
      gamesPlayed: number;
      totalBuyins: number;
      maxBuyinsInGame: number;
      maxBuyinsDate: string;
      totalInvested: number;
      totalProfit: number;
    }>();

    for (const gp of allGamePlayers) {
      if (!gameIds.has(gp.gameId)) continue;
      const game = allGames.find(g => g.id === gp.gameId);
      if (!game) continue;

      const existing = playerMap.get(gp.playerId);
      if (existing) {
        existing.gamesPlayed++;
        existing.totalBuyins += gp.rebuys;
        existing.totalInvested += gp.rebuys * settings.rebuyValue;
        existing.totalProfit += gp.profit;
        if (gp.rebuys > existing.maxBuyinsInGame) {
          existing.maxBuyinsInGame = gp.rebuys;
          existing.maxBuyinsDate = game.date || game.createdAt;
        }
      } else {
        const currentPlayer = players.find(p => p.id === gp.playerId);
        playerMap.set(gp.playerId, {
          playerName: currentPlayer?.name || gp.playerName,
          gamesPlayed: 1,
          totalBuyins: gp.rebuys,
          maxBuyinsInGame: gp.rebuys,
          maxBuyinsDate: game.date || game.createdAt,
          totalInvested: gp.rebuys * settings.rebuyValue,
          totalProfit: gp.profit,
        });
      }
    }

    return Array.from(playerMap.values())
      .filter(p => p.gamesPlayed > 0 && filteredStats.some(s => s.playerName === p.playerName))
      .sort((a, b) => (b.totalBuyins / b.gamesPlayed) - (a.totalBuyins / a.gamesPlayed));
  }, [stats, players, filteredStats, timePeriod, selectedYear, selectedMonth]);

  const rebuyDataCoverage = useMemo(() => {
    const dateFilter = getDateFilter();
    const allGames = getAllGames().filter(g => {
      if (g.status !== 'completed') return false;
      if (!dateFilter) return true;
      const gameDate = new Date(g.date || g.createdAt);
      if (dateFilter.start && gameDate < dateFilter.start) return false;
      if (dateFilter.end && gameDate > dateFilter.end) return false;
      return true;
    });
    const allGamePlayers = getAllGamePlayers();
    const totalGames = allGames.length;
    let gamesWithoutRebuys = 0;
    for (const game of allGames) {
      const players = allGamePlayers.filter(gp => gp.gameId === game.id);
      if (players.length > 0 && players.every(p => p.rebuys <= 1)) {
        gamesWithoutRebuys++;
      }
    }
    return { totalGames, gamesWithoutRebuys };
  }, [timePeriod, selectedYear, selectedMonth]);

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
    const avgBuyinKings = findTied(filteredStats.filter(s => s.gamesPlayed >= 3), s => s.avgRebuysPerGame, true);
    
    const sharpshooters = findTied(filteredStats.filter(s => s.gamesPlayed >= 3), s => s.winPercentage, true);
    const worstWinRates = findTied(filteredStats.filter(s => s.gamesPlayed >= 3), s => s.winPercentage, false);
    
    const onFirePlayers = findTied(filteredStats.filter(s => s.currentStreak > 0), s => s.currentStreak, true);
    const iceColdPlayers = findTied(filteredStats.filter(s => s.currentStreak < 0), s => s.currentStreak, false);
    const mostDedicatedPlayers = findTied(filteredStats, s => s.gamesPlayed, true);
    const longestWinStreakPlayers = findTied(filteredStats, s => s.longestWinStreak, true);
    const longestLossStreakPlayers = findTied(filteredStats, s => s.longestLossStreak, true);
    
    // Additional records
    const highestAvgProfits = findTied(filteredStats, s => s.avgProfit, true);
    const lowestAvgProfits = findTied(filteredStats, s => s.avgProfit, false);
    const mostWinsPlayers = findTied(filteredStats, s => s.winCount, true);
    const mostLossesPlayers = findTied(filteredStats, s => s.lossCount, true);
    
    return {
      leaders,
      biggestLosers,
      biggestWinPlayers,
      biggestLossPlayers,
      rebuyKings,
      avgBuyinKings,
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
      const gameDate = new Date(g.date || g.createdAt);
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
    } else if (recordType === 'currentWinStreak') {
      const streakGames: typeof playerGames = [];
      for (const game of playerGames) {
        if (game.profit > 0) {
          streakGames.push(game);
        } else {
          break;
        }
      }
      filteredGames = streakGames;
    } else if (recordType === 'currentLossStreak') {
      const streakGames: typeof playerGames = [];
      for (const game of playerGames) {
        if (game.profit < 0) {
          streakGames.push(game);
        } else {
          break;
        }
      }
      filteredGames = streakGames;
    } else if (recordType === 'longestWinStreak' || recordType === 'longestLossStreak') {
      const isWin = recordType === 'longestWinStreak';
      const chronological = [...playerGames].reverse();
      let bestStreak: typeof playerGames = [];
      let currentRun: typeof playerGames = [];
      for (const game of chronological) {
        if (isWin ? game.profit > 0 : game.profit < 0) {
          currentRun.push(game);
          if (currentRun.length >= bestStreak.length) {
            bestStreak = [...currentRun];
          }
        } else {
          currentRun = [];
        }
      }
      filteredGames = bestStreak.reverse();
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

      {/* View Mode Toggle - Always visible */}
      <div className="card" style={{ padding: '0.75rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button 
            className={`btn btn-sm ${viewMode === 'table' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setViewMode('table')}
            style={{ flex: 1, minWidth: 0, padding: '0.5rem 0.25rem', fontSize: '0.75rem' }}
          >
            📊 Table
          </button>
          <button 
            className={`btn btn-sm ${viewMode === 'records' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setViewMode('records')}
            style={{ flex: 1, minWidth: 0, padding: '0.5rem 0.25rem', fontSize: '0.75rem' }}
          >
            🏆 Records
          </button>
          <button 
            className={`btn btn-sm ${viewMode === 'players' ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setViewMode('players')}
            style={{ flex: 1, minWidth: 0, padding: '0.5rem 0.25rem', fontSize: '0.75rem' }}
          >
            👤 Players
          </button>
        </div>
      </div>

      {/* Filters Card - hidden when Global Records sub-tab is active */}
      {!(viewMode === 'records' && recordsSubTab === 'global') && (
      <div className="card" style={{ padding: '0.75rem' }}>
        {/* Active Players Filter - Toggle Switch */}
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
      )}

      {/* Empty state when no stats for selected period (skip for Global Records) */}
      {stats.length === 0 && !(viewMode === 'records' && recordsSubTab === 'global') ? (
        <div className="card">
          <div className="empty-state">
            <div className="empty-icon">📈</div>
            <p>אין סטטיסטיקות לתקופה הנבחרת</p>
            <p className="text-muted">נסה לבחור תקופה אחרת למעלה</p>
          </div>
        </div>
      ) : (
        <>
          {/* RECORDS VIEW */}
          {viewMode === 'records' && (
            <>
              {/* Records Sub-Tab Toggle */}
              <div style={{ 
                display: 'flex', 
                gap: '0.25rem',
                padding: '0.4rem',
                background: 'var(--surface)',
                borderRadius: '8px',
                marginBottom: '0.5rem'
              }}>
                <button
                  onClick={() => setRecordsSubTab('global')}
                  style={{
                    flex: 1,
                    padding: '0.4rem',
                    fontSize: '0.75rem',
                    fontWeight: '600',
                    borderRadius: '6px',
                    border: 'none',
                    cursor: 'pointer',
                    background: recordsSubTab === 'global' ? 'var(--primary)' : 'transparent',
                    color: recordsSubTab === 'global' ? 'white' : 'var(--text-muted)',
                    transition: 'all 0.2s ease'
                  }}
                >
                  🏆 Hall of Fame
                </button>
                <button
                  onClick={() => setRecordsSubTab('playerRecords')}
                  style={{
                    flex: 1,
                    padding: '0.4rem',
                    fontSize: '0.75rem',
                    fontWeight: '600',
                    borderRadius: '6px',
                    border: 'none',
                    cursor: 'pointer',
                    background: recordsSubTab === 'playerRecords' ? 'var(--primary)' : 'transparent',
                    color: recordsSubTab === 'playerRecords' ? 'white' : 'var(--text-muted)',
                    transition: 'all 0.2s ease'
                  }}
                >
                  👑 Personal Records
                </button>
              </div>

              {/* GLOBAL RECORDS sub-tab */}
              {recordsSubTab === 'global' && (
                <>
              {/* Season Podium - Independent of Filters */}
              <div ref={podiumRef} className="card" style={{ padding: '0.75rem' }}>
                <div style={{ 
                  textAlign: 'center', 
                  padding: '0.5rem', 
                  marginBottom: '0.75rem',
                  background: 'linear-gradient(135deg, rgba(251, 191, 36, 0.15), rgba(245, 158, 11, 0.1))',
                  borderRadius: '6px',
                  fontSize: '0.85rem',
                  fontWeight: '600',
                  color: '#fbbf24'
                }}>
                  🏆 Season Podium {podiumData.year}
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <div style={{ 
                  flex: '1 1 30%', 
                  minWidth: '140px',
                  background: 'rgba(59, 130, 246, 0.08)',
                  borderRadius: '8px',
                  padding: '0.5rem',
                  border: '1px solid rgba(59, 130, 246, 0.2)'
                }}>
                  <div style={{ 
                    textAlign: 'center', 
                    fontSize: '0.7rem', 
                    fontWeight: '600', 
                    color: '#3b82f6',
                    marginBottom: '0.4rem',
                    padding: '0.25rem',
                    background: 'rgba(59, 130, 246, 0.15)',
                    borderRadius: '4px'
                  }}>
                    H1 (Jan-Jun)
                  </div>
                  {podiumData.h1.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                      {podiumData.h1.map((player, idx) => (
                        <div key={player.playerId} style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.35rem',
                          padding: '0.3rem 0.4rem',
                          background: idx === 0 ? 'linear-gradient(135deg, rgba(251, 191, 36, 0.2), rgba(251, 191, 36, 0.1))' :
                                     idx === 1 ? 'linear-gradient(135deg, rgba(156, 163, 175, 0.2), rgba(156, 163, 175, 0.1))' :
                                     'linear-gradient(135deg, rgba(217, 119, 6, 0.2), rgba(217, 119, 6, 0.1))',
                          borderRadius: '4px',
                          fontSize: '0.65rem'
                        }}>
                          <span style={{ fontSize: '0.9rem' }}>
                            {idx === 0 ? '🥇' : idx === 1 ? '🥈' : '🥉'}
                          </span>
                          <span style={{ flex: 1, fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {player.playerName}
                          </span>
                          <span style={{ fontWeight: '600', color: player.profit >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                            {formatCurrency(player.profit)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ textAlign: 'center', fontSize: '0.6rem', color: 'var(--text-muted)', padding: '0.5rem' }}>No data</div>
                  )}
                </div>
                <div style={{ 
                  flex: '1 1 30%', 
                  minWidth: '140px',
                  background: 'rgba(139, 92, 246, 0.08)',
                  borderRadius: '8px',
                  padding: '0.5rem',
                  border: '1px solid rgba(139, 92, 246, 0.2)'
                }}>
                  <div style={{ 
                    textAlign: 'center', 
                    fontSize: '0.7rem', 
                    fontWeight: '600', 
                    color: '#8b5cf6',
                    marginBottom: '0.4rem',
                    padding: '0.25rem',
                    background: 'rgba(139, 92, 246, 0.15)',
                    borderRadius: '4px'
                  }}>
                    H2 (Jul-Dec)
                  </div>
                  {podiumData.h2.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                      {podiumData.h2.map((player, idx) => (
                        <div key={player.playerId} style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.35rem',
                          padding: '0.3rem 0.4rem',
                          background: idx === 0 ? 'linear-gradient(135deg, rgba(251, 191, 36, 0.2), rgba(251, 191, 36, 0.1))' :
                                     idx === 1 ? 'linear-gradient(135deg, rgba(156, 163, 175, 0.2), rgba(156, 163, 175, 0.1))' :
                                     'linear-gradient(135deg, rgba(217, 119, 6, 0.2), rgba(217, 119, 6, 0.1))',
                          borderRadius: '4px',
                          fontSize: '0.65rem'
                        }}>
                          <span style={{ fontSize: '0.9rem' }}>{idx === 0 ? '🥇' : idx === 1 ? '🥈' : '🥉'}</span>
                          <span style={{ flex: 1, fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{player.playerName}</span>
                          <span style={{ fontWeight: '600', color: player.profit >= 0 ? 'var(--success)' : 'var(--danger)' }}>{formatCurrency(player.profit)}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ textAlign: 'center', fontSize: '0.6rem', color: 'var(--text-muted)', padding: '0.5rem' }}>No data</div>
                  )}
                </div>
                <div style={{ 
                  flex: '1 1 30%', 
                  minWidth: '140px',
                  background: 'rgba(16, 185, 129, 0.08)',
                  borderRadius: '8px',
                  padding: '0.5rem',
                  border: '1px solid rgba(16, 185, 129, 0.2)'
                }}>
                  <div style={{ 
                    textAlign: 'center', 
                    fontSize: '0.7rem', 
                    fontWeight: '600', 
                    color: 'var(--primary)',
                    marginBottom: '0.4rem',
                    padding: '0.25rem',
                    background: 'rgba(16, 185, 129, 0.15)',
                    borderRadius: '4px'
                  }}>
                    Full Year
                  </div>
                  {podiumData.yearly.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                      {podiumData.yearly.map((player, idx) => (
                        <div key={player.playerId} style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.35rem',
                          padding: '0.3rem 0.4rem',
                          background: idx === 0 ? 'linear-gradient(135deg, rgba(251, 191, 36, 0.2), rgba(251, 191, 36, 0.1))' :
                                     idx === 1 ? 'linear-gradient(135deg, rgba(156, 163, 175, 0.2), rgba(156, 163, 175, 0.1))' :
                                     'linear-gradient(135deg, rgba(217, 119, 6, 0.2), rgba(217, 119, 6, 0.1))',
                          borderRadius: '4px',
                          fontSize: '0.65rem'
                        }}>
                          <span style={{ fontSize: '0.9rem' }}>{idx === 0 ? '🥇' : idx === 1 ? '🥈' : '🥉'}</span>
                          <span style={{ flex: 1, fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{player.playerName}</span>
                          <span style={{ fontWeight: '600', color: player.profit >= 0 ? 'var(--success)' : 'var(--danger)' }}>{formatCurrency(player.profit)}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{ textAlign: 'center', fontSize: '0.6rem', color: 'var(--text-muted)', padding: '0.5rem' }}>No data</div>
                  )}
                </div>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: '0.5rem', marginBottom: '1rem' }}>
                <button
                  onClick={handleSharePodium}
                  disabled={isSharingPodium}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem', fontSize: '0.75rem', padding: '0.4rem 0.8rem', background: 'var(--surface)', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: '6px', cursor: 'pointer' }}
                >
                  {isSharingPodium ? '📸...' : '📤 שתף פודיום'}
                </button>
              </div>

              {/* Hall of Fame - All Years Champions */}
              {podiumData.history.length > 0 && (
                <div ref={hallOfFameRef} className="card" style={{ padding: '0.75rem', marginBottom: '1rem' }}>
                  <div style={{ 
                    textAlign: 'center', 
                    padding: '0.5rem', 
                    marginBottom: '0.75rem',
                    background: 'linear-gradient(135deg, rgba(168, 85, 247, 0.15), rgba(139, 92, 246, 0.1))',
                    borderRadius: '6px',
                    fontSize: '0.85rem',
                    fontWeight: '600',
                    color: '#a855f7'
                  }}>
                    🏅 Hall of Fame
                  </div>
                  <div style={{ 
                    display: 'grid', 
                    gridTemplateColumns: '45px 1fr 1fr 1fr',
                    gap: '0.25rem',
                    marginBottom: '0.35rem',
                    padding: '0.25rem 0.4rem',
                    background: 'rgba(255, 255, 255, 0.03)',
                    borderRadius: '4px',
                    fontSize: '0.55rem',
                    fontWeight: '600',
                    color: 'var(--text-muted)',
                    textAlign: 'center'
                  }}>
                    <div>Year</div>
                    <div style={{ color: '#3b82f6' }}>H1</div>
                    <div style={{ color: '#8b5cf6' }}>H2</div>
                    <div style={{ color: 'var(--primary)' }}>Year</div>
                  </div>
                  {podiumData.history.map((yearData) => (
                    <div 
                      key={yearData.year}
                      style={{ 
                        display: 'grid', 
                        gridTemplateColumns: '45px 1fr 1fr 1fr',
                        gap: '0.25rem',
                        padding: '0.4rem',
                        marginBottom: '0.35rem',
                        background: 'rgba(255, 255, 255, 0.02)',
                        borderRadius: '6px',
                        border: '1px solid rgba(255, 255, 255, 0.05)',
                        fontSize: '0.55rem'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: '700', fontSize: '0.7rem', color: 'var(--text)' }}>{yearData.year}</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', padding: '0.2rem', background: yearData.h1Top3.length > 0 ? 'rgba(59, 130, 246, 0.08)' : 'transparent', borderRadius: '4px' }}>
                        {yearData.h1Top3.length > 0 ? yearData.h1Top3.map((player, idx) => (
                          <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '0.2rem', justifyContent: 'center' }}>
                            <span style={{ fontSize: '0.6rem' }}>{idx === 0 ? '🥇' : idx === 1 ? '🥈' : '🥉'}</span>
                            <span style={{ fontWeight: idx === 0 ? '600' : '400', color: 'var(--text)', fontSize: idx === 0 ? '0.58rem' : '0.52rem' }}>{player.playerName}</span>
                            <span style={{ fontSize: '0.48rem', color: player.profit >= 0 ? 'var(--success)' : 'var(--danger)' }}>{formatCurrency(player.profit)}</span>
                          </div>
                        )) : <span style={{ color: 'var(--text-muted)', fontSize: '0.5rem', textAlign: 'center' }}>-</span>}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', padding: '0.2rem', background: yearData.h2Top3.length > 0 ? 'rgba(139, 92, 246, 0.08)' : 'transparent', borderRadius: '4px' }}>
                        {yearData.h2Top3.length > 0 ? yearData.h2Top3.map((player, idx) => (
                          <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '0.2rem', justifyContent: 'center' }}>
                            <span style={{ fontSize: '0.6rem' }}>{idx === 0 ? '🥇' : idx === 1 ? '🥈' : '🥉'}</span>
                            <span style={{ fontWeight: idx === 0 ? '600' : '400', color: 'var(--text)', fontSize: idx === 0 ? '0.58rem' : '0.52rem' }}>{player.playerName}</span>
                            <span style={{ fontSize: '0.48rem', color: player.profit >= 0 ? 'var(--success)' : 'var(--danger)' }}>{formatCurrency(player.profit)}</span>
                          </div>
                        )) : <span style={{ color: 'var(--text-muted)', fontSize: '0.5rem', textAlign: 'center' }}>-</span>}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', padding: '0.2rem', background: yearData.yearlyTop3.length > 0 ? 'linear-gradient(135deg, rgba(251, 191, 36, 0.1), rgba(251, 191, 36, 0.05))' : 'transparent', borderRadius: '4px', border: yearData.yearlyTop3.length > 0 ? '1px solid rgba(251, 191, 36, 0.15)' : 'none' }}>
                        {yearData.yearlyTop3.length > 0 ? yearData.yearlyTop3.map((player, idx) => (
                          <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '0.2rem', justifyContent: 'center' }}>
                            <span style={{ fontSize: '0.6rem' }}>{idx === 0 ? '🏆' : idx === 1 ? '🥈' : '🥉'}</span>
                            <span style={{ fontWeight: idx === 0 ? '700' : '400', color: idx === 0 ? '#fbbf24' : 'var(--text)', fontSize: idx === 0 ? '0.58rem' : '0.52rem' }}>{player.playerName}</span>
                            <span style={{ fontSize: '0.48rem', color: player.profit >= 0 ? 'var(--success)' : 'var(--danger)' }}>{formatCurrency(player.profit)}</span>
                          </div>
                        )) : <span style={{ color: 'var(--text-muted)', fontSize: '0.5rem', textAlign: 'center' }}>-</span>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {podiumData.history.length > 0 && (
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1rem' }}>
                  <button
                    onClick={handleShareHallOfFame}
                    disabled={isSharingHallOfFame}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem', fontSize: '0.75rem', padding: '0.4rem 0.8rem', background: 'var(--surface)', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: '6px', cursor: 'pointer' }}
                  >
                    {isSharingHallOfFame ? '📸...' : '📤 שתף היכל התהילה'}
                  </button>
                </div>
              )}

              {/* Top 20 Single Night Wins - ALL TIME */}
              {top20WinsAllTime.length > 0 && (
                <div ref={top20Ref} className="card" style={{ padding: '0.5rem', marginBottom: '1rem' }}>
                  <div style={{ textAlign: 'center', fontSize: '0.85rem', fontWeight: '600', color: 'var(--text)', marginBottom: '0.5rem' }}>
                    🏆 Top 20 Single Night Wins
                  </div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '0.35rem' }}>All Time</div>
                  <table style={{ width: '100%', fontSize: '0.7rem', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border)' }}>
                        <th style={{ textAlign: 'left', padding: '0.25rem 0.2rem' }}>#</th>
                        <th style={{ textAlign: 'left', padding: '0.25rem 0.2rem' }}>Player</th>
                        <th style={{ textAlign: 'right', padding: '0.25rem 0.2rem' }}>Profit</th>
                        <th style={{ textAlign: 'center', padding: '0.25rem 0.2rem' }}>Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {top20WinsAllTime.map((entry, idx) => (
                        <tr 
                          key={idx}
                          style={{ borderBottom: '1px solid rgba(255,255,255,0.03)', cursor: 'pointer' }}
                          onClick={() => navigate(`/game-summary/${entry.gameId}`, { state: { from: 'statistics', viewMode: 'records', timePeriod, selectedYear, selectedMonth } })}
                        >
                          <td style={{ padding: '0.3rem 0.2rem', whiteSpace: 'nowrap' }}>{idx + 1}{idx < 3 ? ` ${['🥇', '🥈', '🥉'][idx]}` : ''}</td>
                          <td style={{ padding: '0.3rem 0.2rem', fontWeight: '500' }}>{entry.playerName}</td>
                          <td style={{ padding: '0.3rem 0.2rem', textAlign: 'right', color: 'var(--success)', fontWeight: '600' }}>+{formatCurrency(entry.profit)}</td>
                          <td style={{ padding: '0.3rem 0.2rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.65rem' }}>{new Date(entry.date).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {top20WinsAllTime.length > 0 && (
                <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1rem' }}>
                  <button
                    onClick={handleShareTop20}
                    disabled={isSharingTop20}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem', fontSize: '0.75rem', padding: '0.4rem 0.8rem', background: 'var(--surface)', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: '6px', cursor: 'pointer' }}
                  >
                    {isSharingTop20 ? '📸...' : '📤 שתף Top 20'}
                  </button>
                </div>
              )}
                </>
              )}

              {/* PLAYER RECORDS sub-tab */}
              {recordsSubTab === 'playerRecords' && records && (
                <>
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
                👑 Personal Records ({getTimeframeLabel()})
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
                <div className="grid grid-2">
                  <div style={{ padding: '0.75rem', background: 'rgba(34, 197, 94, 0.1)', borderRadius: '8px', textAlign: 'center' }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>🥇 Top Earner</div>
                    {renderRecord(
                      'leader',
                      records.leaders,
                      (p) => <div className="profit" style={{ fontWeight: '700' }}>+{formatCurrency(p.totalProfit)}</div>,
                      undefined,
                      'all',
                      '🥇 כל המשחקים'
                    )}
                  </div>
                  <div style={{ padding: '0.75rem', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '8px', textAlign: 'center' }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>📉 Biggest Loser</div>
                    {renderRecord(
                      'biggestLoser',
                      records.biggestLosers,
                      (p) => <div className="loss" style={{ fontWeight: '700' }}>{formatCurrency(p.totalProfit)}</div>,
                      undefined,
                      'all',
                      '📉 כל המשחקים'
                    )}
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
                          (p) => <div className="profit" style={{ fontWeight: '700' }}>{p.avgProfit >= 0 ? '+' : ''}{formatCurrency(p.avgProfit)}</div>,
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
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                      <span style={{ color: 'var(--text-muted)' }}>🎰 Buyin King</span>
                      {renderRecord(
                        'rebuyKing',
                        records.rebuyKings.filter(p => p.totalRebuys > 0),
                        (p) => <span style={{ fontWeight: '600' }}>({p.totalRebuys} total)</span>,
                        undefined,
                        'all',
                        '🎰 רכישות'
                      )}
                  </div>
                  )}
                  {records.avgBuyinKings[0]?.avgRebuysPerGame > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '0.5rem 0' }}>
                      <span style={{ color: 'var(--text-muted)' }}>💸 Avg Buyin King</span>
                      {renderRecord(
                        'avgBuyinKing',
                        records.avgBuyinKings.filter(p => p.avgRebuysPerGame > 0),
                        (p) => <span style={{ fontWeight: '600' }}>({p.avgRebuysPerGame.toFixed(1)} avg)</span>,
                        undefined,
                        'all',
                        '💸 ממוצע רכישות'
                      )}
                  </div>
                  )}
                </div>
              </div>
                </>
              )}
            </>
          )}

          {/* TABLE Options - Sort dropdown + Table Mode toggle */}
          {viewMode === 'table' && (
            <div className="card" style={{ padding: '0.4rem', display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as 'profit' | 'games' | 'winRate')}
                style={{
                  padding: '0.35rem 0.5rem',
                  fontSize: '0.75rem',
                  borderRadius: '6px',
                  border: '1px solid var(--border)',
                  background: '#1a1a2e',
                  color: '#ffffff',
                  cursor: 'pointer',
                }}
              >
                <option value="profit" style={{ background: '#1a1a2e', color: '#ffffff' }}>💰 Profit</option>
                <option value="games" style={{ background: '#1a1a2e', color: '#ffffff' }}>🎮 Games</option>
                <option value="winRate" style={{ background: '#1a1a2e', color: '#ffffff' }}>📊 Win%</option>
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
                          {getMedal(index, sortBy === 'profit' ? player.totalProfit : 
                            sortBy === 'games' ? player.gamesPlayed : player.winPercentage)}
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

              {/* Rebuy Stats Table */}
              {rebuyStats.length > 0 && (
                <div ref={rebuyStatsRef} className="card" style={{ padding: '0.5rem', marginTop: '1rem' }}>
                  <div style={{ textAlign: 'center', fontSize: '0.85rem', fontWeight: '600', color: 'var(--text)', marginBottom: '0.5rem' }}>
                    🎰 Rebuy Stats
                  </div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '0.35rem' }}>{getTimeframeLabel()}</div>
                  {rebuyDataCoverage.gamesWithoutRebuys > 0 && (
                    <div style={{
                      fontSize: '0.65rem',
                      color: '#f59e0b',
                      background: 'rgba(245, 158, 11, 0.1)',
                      border: '1px solid rgba(245, 158, 11, 0.2)',
                      borderRadius: '4px',
                      padding: '0.3rem 0.5rem',
                      marginBottom: '0.4rem',
                      textAlign: 'center'
                    }}>
                      ⚠️ {rebuyDataCoverage.gamesWithoutRebuys} of {rebuyDataCoverage.totalGames} games have no rebuy data — averages may be lower than actual
                    </div>
                  )}
                  <table style={{ width: '100%', fontSize: '0.7rem', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border)' }}>
                        <th style={{ textAlign: 'left', padding: '0.25rem 0.2rem' }}>#</th>
                        <th style={{ textAlign: 'left', padding: '0.25rem 0.2rem', whiteSpace: 'nowrap' }}>Player</th>
                        <th style={{ textAlign: 'center', padding: '0.25rem 0.2rem', whiteSpace: 'nowrap' }} title="Average buyins per game">Avg</th>
                        <th style={{ textAlign: 'center', padding: '0.25rem 0.2rem', whiteSpace: 'nowrap' }} title="Total buyins">Total</th>
                        <th style={{ textAlign: 'center', padding: '0.25rem 0.2rem', whiteSpace: 'nowrap' }} title="Max buyins in a single game">Max</th>
                        <th style={{ textAlign: 'center', padding: '0.25rem 0.2rem', whiteSpace: 'nowrap' }} title="Games played">G</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rebuyStats.map((player, index) => {
                        const avgBuyins = player.totalBuyins / player.gamesPlayed;
                        return (
                          <tr 
                            key={index}
                            style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}
                          >
                            <td style={{ padding: '0.3rem 0.2rem', whiteSpace: 'nowrap' }}>
                              {index + 1}
                            </td>
                            <td style={{ 
                              padding: '0.3rem 0.2rem', 
                              whiteSpace: 'nowrap',
                              fontWeight: '500'
                            }}>
                              {player.playerName}
                            </td>
                            <td style={{ 
                              textAlign: 'center', 
                              padding: '0.3rem 0.2rem',
                              fontWeight: '600'
                            }}>
                              {avgBuyins.toFixed(1)}
                            </td>
                            <td style={{ 
                              textAlign: 'center', 
                              padding: '0.3rem 0.2rem',
                              color: 'var(--text-muted)'
                            }}>
                              {cleanNumber(player.totalBuyins)}
                            </td>
                            <td style={{ 
                              textAlign: 'center', 
                              padding: '0.3rem 0.2rem'
                            }}>
                              {cleanNumber(player.maxBuyinsInGame)}
                            </td>
                            <td style={{ 
                              textAlign: 'center', 
                              padding: '0.3rem 0.2rem',
                              color: 'var(--text-muted)'
                            }}>
                              {player.gamesPlayed}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {rebuyStats.length > 0 && (
                <div style={{ display: 'flex', justifyContent: 'center', marginTop: '0.5rem', marginBottom: '0.5rem' }}>
                  <button
                    onClick={handleShareRebuyStats}
                    disabled={isSharingRebuyStats}
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
                    {isSharingRebuyStats ? '📸...' : '📤 שתף'}
                  </button>
                </div>
              )}

              {/* Top 10 Single Night Wins - Filtered by period */}
              {top20Wins.length > 0 && (
                <div ref={top10Ref} className="card" style={{ padding: '0.5rem', marginTop: '0.5rem' }}>
                  <div style={{ textAlign: 'center', fontSize: '0.85rem', fontWeight: '600', color: 'var(--text)', marginBottom: '0.5rem' }}>
                    🏆 Top 10 Single Night Wins
                  </div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '0.35rem' }}>{getTimeframeLabel()}</div>
                  <table style={{ width: '100%', fontSize: '0.7rem', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border)' }}>
                        <th style={{ textAlign: 'left', padding: '0.25rem 0.2rem' }}>#</th>
                        <th style={{ textAlign: 'left', padding: '0.25rem 0.2rem' }}>Player</th>
                        <th style={{ textAlign: 'right', padding: '0.25rem 0.2rem' }}>Profit</th>
                        <th style={{ textAlign: 'center', padding: '0.25rem 0.2rem' }}>Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {top20Wins.slice(0, 10).map((entry, idx) => (
                        <tr 
                          key={idx}
                          style={{ borderBottom: '1px solid rgba(255,255,255,0.03)', cursor: 'pointer' }}
                          onClick={() => navigate(`/game-summary/${entry.gameId}`, { state: { from: 'statistics', viewMode: 'table', timePeriod, selectedYear, selectedMonth } })}
                        >
                          <td style={{ padding: '0.3rem 0.2rem', whiteSpace: 'nowrap' }}>{idx + 1}{idx < 3 ? ` ${['🥇', '🥈', '🥉'][idx]}` : ''}</td>
                          <td style={{ padding: '0.3rem 0.2rem', fontWeight: '500' }}>{entry.playerName}</td>
                          <td style={{ padding: '0.3rem 0.2rem', textAlign: 'right', color: 'var(--success)', fontWeight: '600' }}>+{formatCurrency(entry.profit)}</td>
                          <td style={{ padding: '0.3rem 0.2rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.65rem' }}>{new Date(entry.date).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {top20Wins.length > 0 && (
                <div style={{ display: 'flex', justifyContent: 'center', marginTop: '0.5rem', marginBottom: '0.5rem' }}>
                  <button
                    onClick={handleShareTop10}
                    disabled={isSharingTop10}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem', fontSize: '0.75rem', padding: '0.4rem 0.8rem', background: 'var(--surface)', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: '6px', cursor: 'pointer' }}
                  >
                    {isSharingTop10 ? '📸...' : '📤 שתף Top 10'}
                  </button>
                </div>
              )}
            </>
          )}

          {/* PLAYERS VIEW */}
          {viewMode === 'players' && (
            <>
              {/* Players Sub-Tab Toggle */}
              <div style={{ 
                display: 'flex', 
                gap: '0.25rem',
                padding: '0.4rem',
                background: 'var(--surface)',
                borderRadius: '8px',
                marginBottom: '0.5rem'
              }}>
                <button
                  onClick={() => setPlayerSubTab('stats')}
                  style={{
                    flex: 1,
                    padding: '0.4rem',
                    fontSize: '0.75rem',
                    fontWeight: '600',
                    borderRadius: '6px',
                    border: 'none',
                    cursor: 'pointer',
                    background: playerSubTab === 'stats' ? 'var(--primary)' : 'transparent',
                    color: playerSubTab === 'stats' ? 'white' : 'var(--text-muted)',
                    transition: 'all 0.2s ease'
                  }}
                >
                  📊 Stats
                </button>
                <button
                  onClick={() => setPlayerSubTab('stories')}
                  style={{
                    flex: 1,
                    padding: '0.4rem',
                    fontSize: '0.75rem',
                    fontWeight: '600',
                    borderRadius: '6px',
                    border: 'none',
                    cursor: 'pointer',
                    background: playerSubTab === 'stories' ? 'var(--primary)' : 'transparent',
                    color: playerSubTab === 'stories' ? 'white' : 'var(--text-muted)',
                    transition: 'all 0.2s ease'
                  }}
                >
                  🤖 AI Stories
                </button>
              </div>

              {playerSubTab === 'stats' && (
                <>
                  {/* Timeframe Header - Stats sub-tab only */}
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

                  {sortedStats.map((player, index) => (
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
                  <div className="text-muted" style={{ fontSize: '0.7rem', marginBottom: '0.35rem' }}>Last {Math.min(6, player.lastGameResults.length)} games (latest on right, click for details)</div>
                  <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'flex-start' }}>
                    {player.lastGameResults.slice(0, 6).reverse().map((game, i) => {
                      const gameDate = new Date(game.date);
                      const dateStr = gameDate.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: '2-digit' });
                      return (
                      <div 
                        key={i}
                          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer' }}
                          onClick={() => {
                            navigate(`/game-summary/${game.gameId}`, { state: { from: 'players', viewMode: 'players', playerInfo: { playerId: player.playerId, playerName: player.playerName }, timePeriod, selectedYear, selectedMonth } });
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

              {/* AI Stories sub-tab content */}
              {playerSubTab === 'stories' && (
                <>
                  {/* Timeframe Header */}
                  <div className="card" style={{ padding: '0.75rem', textAlign: 'center' }}>
                    <span style={{ fontSize: '0.9rem', fontWeight: '600' }}>
                      🤖 AI Stories — {getTimeframeLabel()}
                    </span>
                  </div>

          {/* Player Chronicle Section */}
          {(() => {
            // ===== DATA SETUP =====
            const isRebuyDataValid = timePeriod !== 'all' && selectedYear >= 2026;
            const allTimeStatsRaw = getPlayerStats();
            const activePlayerIds = new Set(players.filter(p => selectedTypes.has(p.type)).map(p => p.id));
            const allTimeStats = allTimeStatsRaw.filter(s => activePlayerIds.has(s.playerId));
            const chronicleDateFilter = getDateFilter();
            const periodGames = getAllGames().filter(pg => {
              if (pg.status !== 'completed') return false;
              if (!chronicleDateFilter) return true;
              const gd = new Date(pg.date || pg.createdAt);
              if (chronicleDateFilter.start && gd < chronicleDateFilter.start) return false;
              if (chronicleDateFilter.end && gd > chronicleDateFilter.end) return false;
              return true;
            });
            const totalPeriodGames = periodGames.length;
            const latestGameDate = periodGames.length > 0
              ? new Date(Math.max(...periodGames.map(pg => new Date(pg.date || pg.createdAt).getTime())))
              : null;
            const rankedByProfit = [...sortedStats].sort((a, b) => b.totalProfit - a.totalProfit);
            const allTimeRanked = [...allTimeStats].sort((a, b) => b.totalProfit - a.totalProfit);
            const numPlayers = rankedByProfit.length;

            if (numPlayers === 0) return null;

            // Group means for z-score
            const gMean = {
              profit: rankedByProfit.reduce((s, p) => s + p.avgProfit, 0) / numPlayers,
              winPct: rankedByProfit.reduce((s, p) => s + p.winPercentage, 0) / numPlayers,
              rebuys: isRebuyDataValid ? rankedByProfit.reduce((s, p) => s + (p.avgRebuysPerGame || 0), 0) / numPlayers : 0,
              vol: rankedByProfit.reduce((s, p) => s + p.biggestWin + Math.abs(p.biggestLoss), 0) / numPlayers,
            };
            const gStd = {
              profit: Math.sqrt(rankedByProfit.reduce((s, p) => s + (p.avgProfit - gMean.profit) ** 2, 0) / numPlayers) || 1,
              winPct: Math.sqrt(rankedByProfit.reduce((s, p) => s + (p.winPercentage - gMean.winPct) ** 2, 0) / numPlayers) || 1,
              rebuys: isRebuyDataValid ? Math.sqrt(rankedByProfit.reduce((s, p) => s + ((p.avgRebuysPerGame || 0) - gMean.rebuys) ** 2, 0) / numPlayers) || 1 : 1,
              vol: Math.sqrt(rankedByProfit.reduce((s, p) => s + (p.biggestWin + Math.abs(p.biggestLoss) - gMean.vol) ** 2, 0) / numPlayers) || 1,
            };
            const zs = (v: number, m: number, sd: number) => (v - m) / sd;

            // ===== ARCHETYPE ENGINE =====
            type Arch = { id: string; title: string; icon: string; color: string };
            const A: Record<string, Arch> = {
              dominator: { id: 'dominator', title: 'השולט', icon: '👑', color: '#f59e0b' },
              shark:     { id: 'shark', title: 'הכריש', icon: '🦈', color: '#3b82f6' },
              sniper:    { id: 'sniper', title: 'הצלף', icon: '🎯', color: '#14b8a6' },
              gambler:   { id: 'gambler', title: 'המהמר', icon: '🎰', color: '#ef4444' },
              rock:      { id: 'rock', title: 'הסלע', icon: '🪨', color: '#64748b' },
              phoenix:   { id: 'phoenix', title: 'הפניקס', icon: '🐦', color: '#a855f7' },
              streaker:  { id: 'streaker', title: 'ברצף', icon: '⚡', color: '#f97316' },
              coaster:   { id: 'coaster', title: 'רכבת הרים', icon: '🎢', color: '#ec4899' },
              fighter:   { id: 'fighter', title: 'הלוחם', icon: '⚔️', color: '#d97706' },
              newcomer:  { id: 'newcomer', title: 'החדש', icon: '🌱', color: '#22c55e' },
            };

            const getArch = (p: typeof rankedByProfit[0]): Arch => {
              if (p.gamesPlayed <= 2) return A.newcomer;
              const pw = (p.avgWin || 0) > 0 && (p.avgLoss || 0) > 0 ? (p.avgWin || 0) / (p.avgLoss || 0) : 1;
              const vol = p.biggestWin + Math.abs(p.biggestLoss);
              const rec = (p.lastGameResults || []).slice(0, Math.min(6, (p.lastGameResults || []).length));
              const recAvg = rec.length > 0 ? rec.reduce((s, r) => s + r.profit, 0) / rec.length : 0;
              const rec3 = (p.lastGameResults || []).slice(0, Math.min(3, (p.lastGameResults || []).length));
              const rec3Avg = rec3.length > 0 ? rec3.reduce((s, r) => s + r.profit, 0) / rec3.length : 0;
              const mom = Math.max(recAvg - p.avgProfit, rec3Avg - p.avgProfit);

              const lg = p.lastGameResults || [];
              const chrono = [...lg].reverse();
              let cumT = 0;
              const trajT = chrono.map((g2) => { cumT += g2.profit; return { y: cumT }; });
              let valT = 0;
              for (let i2 = 1; i2 < trajT.length; i2++) { if (trajT[i2].y < trajT[valT].y) valT = i2; }
              const hasComeback = trajT.length >= 5 && valT > 0 && valT < trajT.length - 1 && (trajT[trajT.length - 1].y - trajT[valT].y) > 100;

              if (Math.abs(p.currentStreak) >= 3) return A.streaker;

              if (p.gamesPlayed <= 4) {
                if (p.avgProfit > 0 && p.winPercentage >= 50) return A.dominator;
                if (p.avgProfit > 0 && p.winPercentage < 50) return A.sniper;
                if (p.avgProfit < 0 && (mom > 15 || hasComeback)) return A.phoenix;
                if (p.avgProfit < 0) return A.fighter;
                return A.rock;
              }

              const scores: { a: Arch; s: number }[] = [];
              const zP = zs(p.avgProfit, gMean.profit, gStd.profit);
              const zW = zs(p.winPercentage, gMean.winPct, gStd.winPct);
              const zV = zs(vol, gMean.vol, gStd.vol);
              const zR = isRebuyDataValid ? zs(p.avgRebuysPerGame || 0, gMean.rebuys, gStd.rebuys) : 0;

              if (zP > 0.3) scores.push({ a: A.dominator, s: zP + zW * 0.5 });
              if (pw > 1.3 && p.avgProfit > 0) scores.push({ a: A.shark, s: pw * 0.8 });
              if (p.avgProfit > 0 && zW < -0.2) scores.push({ a: A.sniper, s: zP + Math.abs(zW) * 0.5 });
              if (isRebuyDataValid && zR > 0.5) scores.push({ a: A.gambler, s: zR });
              if (zV < -0.3) scores.push({ a: A.rock, s: Math.abs(zV) });
              if (p.avgProfit <= 0 && (mom > 15 || hasComeback)) scores.push({ a: A.phoenix, s: Math.max(mom / 25, hasComeback ? 1.2 : 0) + 0.5 });
              if (zV > 0.5) scores.push({ a: A.coaster, s: zV });
              if (p.avgProfit < 0) scores.push({ a: A.fighter, s: Math.abs(zP) * 0.4 + p.gamesPlayed / 30 });

              scores.sort((a, b) => b.s - a.s);
              return scores.length > 0 ? scores[0].a : A.rock;
            };

            // ===== COMPUTE MILESTONES FOR AI CONTEXT =====
            const computeMilestoneStrings = (): string[] => {
              const allStatsForRanking = getPlayerStats(getDateFilter());
              const allRankedForMilestones = [...allStatsForRanking].sort((a, b) => b.totalProfit - a.totalProfit);
              const overallRankMap = new Map<string, number>();
              allRankedForMilestones.forEach((stat, idx) => overallRankMap.set(stat.playerId, idx + 1));
              const currentYear = new Date().getFullYear();
              const currentMonth = new Date().getMonth();
              const maxGamesPlayed = rankedByProfit.length > 0 ? Math.max(...rankedByProfit.map(p => p.gamesPlayed)) : 0;
              const isLowData = totalPeriodGames <= 3 || maxGamesPlayed <= 2;
              const isHistorical = (() => {
                if (timePeriod === 'all') return false;
                if (timePeriod === 'year') return selectedYear < currentYear;
                if (timePeriod === 'h1') return selectedYear < currentYear || (selectedYear === currentYear && currentMonth >= 6);
                if (timePeriod === 'h2') return selectedYear < currentYear;
                if (timePeriod === 'month') return selectedYear < currentYear || (selectedYear === currentYear && selectedMonth < currentMonth + 1);
                return false;
              })();
              const milestonePlayers = rankedByProfit.map(adaptPlayerStats);
              const milestoneOpts: MilestoneOptions = {
                mode: 'period', periodLabel: getHebrewTimeframeLabel(), isHistorical, isLowData, overallRankMap, uniqueGamesInPeriod: totalPeriodGames,
              };
              const items = generateMilestones(milestonePlayers, milestoneOpts);
              return items.map(m => `${m.emoji} ${m.title}: ${m.description}`);
            };

            // ===== AUTO-GENERATE AI STORIES (admin only) =====
            const periodKey = getChronicleKey();
            const isAdmin = role === 'admin';
            const cached = getChronicleProfiles(periodKey);
            const hasNewData = latestGameDate && (!cached || latestGameDate.toISOString() > cached.generatedAt);

            if (isAdmin && hasNewData && !chronicleLoading && !chronicleGenRef.current && totalPeriodGames > 0) {
              chronicleGenRef.current = true;
              const latestGD = latestGameDate as Date;

              const buildPayloadAndGenerate = async () => {
                setChronicleLoading(true);
                setChronicleError(null);
                try {
                  const payloadPlayers: ChroniclePlayerData[] = rankedByProfit.map((p, idx) => {
                    const lg = p.lastGameResults || [];
                    const rec = lg.slice(0, Math.min(6, lg.length));
                    const recForm = rec.map(r => r.profit > 0 ? 'W' : r.profit < 0 ? 'L' : 'D').join('');
                    const pLastDate = lg.length > 0 ? lg[0].date : null;
                    const daysSince = pLastDate ? Math.floor((latestGD.getTime() - new Date(pLastDate).getTime()) / 86400000) : 999;
                    const atP = allTimeRanked.find(a => a.playerId === p.playerId);
                    const atRank = atP ? allTimeRanked.findIndex(a => a.playerId === p.playerId) + 1 : null;
                    const arch = getArch(p);

                    return {
                      playerId: p.playerId,
                      name: p.playerName,
                      periodRank: idx + 1,
                      totalProfit: p.totalProfit,
                      gamesPlayed: p.gamesPlayed,
                      winPercentage: p.winPercentage,
                      avgProfit: p.avgProfit,
                      currentStreak: p.currentStreak,
                      biggestWin: p.biggestWin,
                      biggestLoss: p.biggestLoss,
                      avgRebuysPerGame: isRebuyDataValid ? (p.avgRebuysPerGame ?? null) : null,
                      lastGameDate: pLastDate,
                      daysSinceLastGame: daysSince,
                      recentForm: recForm || 'N/A',
                      archetype: arch.title,
                      allTimeRank: atRank,
                      allTimeGames: atP?.gamesPlayed ?? null,
                      allTimeProfit: atP?.totalProfit ?? null,
                    };
                  });

                  const profiles = await generatePlayerChronicle({
                    players: payloadPlayers,
                    periodLabel: getHebrewTimeframeLabel(),
                    totalPeriodGames,
                    isEarlyPeriod: totalPeriodGames <= 3,
                    milestones: computeMilestoneStrings(),
                  });

                  saveChronicleProfiles(periodKey, profiles);
                  setChronicleStories(profiles);
                  setChronicleModelName(getLastUsedModel());

                  syncToCloud().catch(err => console.warn('Chronicle cloud sync failed:', err));
                } catch (err) {
                  console.error('Chronicle generation failed:', err);
                  setChronicleError(err instanceof Error ? err.message : 'Generation failed');
                  if (cached) setChronicleStories(cached.profiles);
                } finally {
                  setChronicleLoading(false);
                }
              };

              buildPayloadAndGenerate();
            }

            const handleRegenerate = async () => {
              chronicleGenRef.current = false;
              setChronicleLoading(true);
              setChronicleError(null);
              try {
                const payloadPlayers: ChroniclePlayerData[] = rankedByProfit.map((p, idx) => {
                  const lg = p.lastGameResults || [];
                  const rec = lg.slice(0, Math.min(6, lg.length));
                  const recForm = rec.map(r => r.profit > 0 ? 'W' : r.profit < 0 ? 'L' : 'D').join('');
                  const pLastDate = lg.length > 0 ? lg[0].date : null;
                  const daysSince = pLastDate && latestGameDate ? Math.floor((latestGameDate.getTime() - new Date(pLastDate).getTime()) / 86400000) : 999;
                  const atP = allTimeRanked.find(a => a.playerId === p.playerId);
                  const atRank = atP ? allTimeRanked.findIndex(a => a.playerId === p.playerId) + 1 : null;
                  const arch = getArch(p);

                  return {
                    playerId: p.playerId,
                    name: p.playerName,
                    periodRank: idx + 1,
                    totalProfit: p.totalProfit,
                    gamesPlayed: p.gamesPlayed,
                    winPercentage: p.winPercentage,
                    avgProfit: p.avgProfit,
                    currentStreak: p.currentStreak,
                    biggestWin: p.biggestWin,
                    biggestLoss: p.biggestLoss,
                    avgRebuysPerGame: isRebuyDataValid ? (p.avgRebuysPerGame ?? null) : null,
                    lastGameDate: pLastDate,
                    daysSinceLastGame: daysSince,
                    recentForm: recForm || 'N/A',
                    archetype: arch.title,
                    allTimeRank: atRank,
                    allTimeGames: atP?.gamesPlayed ?? null,
                    allTimeProfit: atP?.totalProfit ?? null,
                  };
                });

                const profiles = await generatePlayerChronicle({
                  players: payloadPlayers,
                  periodLabel: getHebrewTimeframeLabel(),
                  totalPeriodGames,
                  isEarlyPeriod: totalPeriodGames <= 3,
                  milestones: computeMilestoneStrings(),
                });

                saveChronicleProfiles(periodKey, profiles);
                setChronicleStories(profiles);
                setChronicleModelName(getLastUsedModel());

                syncToCloud().catch(err => console.warn('Chronicle cloud sync failed:', err));
              } catch (err) {
                console.error('Chronicle regeneration failed:', err);
                setChronicleError(err instanceof Error ? err.message : 'Generation failed');
              } finally {
                setChronicleLoading(false);
              }
            };

            // ===== SPARKLINE HELPER =====
            const buildSparkline = (player: typeof rankedByProfit[0]) => {
              const lg = player.lastGameResults || [];
              const chrono = [...lg].reverse();
              let cum = 0;
              const pts = chrono.map((g, i) => { cum += g.profit; return { x: i, y: cum }; });

              const SW = 300, SH = 40, SP = 4;
              const lineColor = player.totalProfit >= 0 ? 'var(--success)' : 'var(--danger)';

              if (pts.length < 2) {
                if (pts.length === 1) {
                  return (
                    <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '0.5rem' }}>
                      <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: lineColor }} />
                    </div>
                  );
                }
                return null;
              }

              const minY = Math.min(0, ...pts.map(pt => pt.y));
              const maxY = Math.max(0, ...pts.map(pt => pt.y));
              const yR = maxY - minY || 1;
              const scX = (SW - SP * 2) / Math.max(pts.length - 1, 1);
              const scY = (SH - SP * 2) / yR;
              const scaled = pts.map((pt, i) => ({ x: SP + i * scX, y: SH - SP - (pt.y - minY) * scY }));

              // Smooth curve (catmull-rom to cubic bezier)
              let curvePath = `M${scaled[0].x.toFixed(1)},${scaled[0].y.toFixed(1)}`;
              for (let i = 0; i < scaled.length - 1; i++) {
                const p0 = scaled[Math.max(0, i - 1)];
                const p1 = scaled[i];
                const p2 = scaled[i + 1];
                const p3 = scaled[Math.min(scaled.length - 1, i + 2)];
                const tension = 0.3;
                const cp1x = p1.x + (p2.x - p0.x) * tension;
                const cp1y = p1.y + (p2.y - p0.y) * tension;
                const cp2x = p2.x - (p3.x - p1.x) * tension;
                const cp2y = p2.y - (p3.y - p1.y) * tension;
                curvePath += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
              }

              const last = scaled[scaled.length - 1], first = scaled[0];
              const fillPath = `${curvePath} L${last.x.toFixed(1)},${SH} L${first.x.toFixed(1)},${SH} Z`;
              const zeroY = SH - SP - (0 - minY) * scY;
              const showZero = minY < 0 && maxY > 0;
              const gradId = `cg2-${player.playerId}`;

              return (
                <svg viewBox={`0 0 ${SW} ${SH}`} style={{ width: '100%', height: '40px', display: 'block', marginBottom: '0.5rem' }} preserveAspectRatio="none">
                  <defs>
                    <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={lineColor} stopOpacity={0.25} />
                      <stop offset="100%" stopColor={lineColor} stopOpacity={0.03} />
                    </linearGradient>
                  </defs>
                  <path d={fillPath} fill={`url(#${gradId})`} />
                  {showZero && <line x1={SP} y1={zeroY} x2={SW - SP} y2={zeroY} stroke="rgba(255,255,255,0.25)" strokeWidth="1" strokeDasharray="4 3" />}
                  <path d={curvePath} fill="none" stroke={lineColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  {scaled.map((pt, i) => (
                    <circle key={i} cx={pt.x} cy={pt.y} r="2.5" fill={lineColor} />
                  ))}
                </svg>
              );
            };

            const hasAiStories = Object.keys(chronicleStories).length > 0;

            // ===== RENDER =====
            return (
              <div className="card" ref={chronicleRef} style={{ padding: '1rem' }}>
                <div style={{ marginBottom: '1rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <h3 style={{ margin: 0, fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        הכרוניקה — {getTimeframeLabel()}
                      </h3>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.3rem' }}>
                        {totalPeriodGames} משחקים | {numPlayers} שחקנים פעילים
                      </div>
                      {chronicleModelName && hasAiStories && (
                        <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: '0.15rem', opacity: 0.6 }}>
                          model: {chronicleModelName}
                        </div>
                      )}
                    </div>
                    {isAdmin && !chronicleLoading && totalPeriodGames > 0 && (
                      <button
                        onClick={handleRegenerate}
                        style={{
                          fontSize: '0.7rem', padding: '0.3rem 0.7rem', borderRadius: '8px',
                          background: 'var(--surface-hover)', color: 'var(--text-muted)',
                          border: '1px solid var(--border)', cursor: 'pointer', whiteSpace: 'nowrap',
                        }}
                      >
                        {hasAiStories ? 'יצירה מחדש' : 'יצירת סיפורים'}
                      </button>
                    )}
                  </div>
                  {totalPeriodGames > 0 && totalPeriodGames <= 3 && (
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.2rem', fontStyle: 'italic' }}>
                      התקופה רק התחילה — הסיפורים יתעדכנו עם כל משחק חדש
                    </div>
                  )}
                  {chronicleError && (
                    <div style={{ fontSize: '0.7rem', color: 'var(--danger)', marginTop: '0.3rem' }}>
                      שגיאה: {chronicleError}
                    </div>
                  )}
                </div>

                {chronicleLoading && (
                  <div style={{ textAlign: 'center', padding: '2rem 0', color: 'var(--text-muted)' }}>
                    <div style={{ fontSize: '0.85rem', animation: 'pulse 1.5s ease-in-out infinite' }}>
                      מייצר סיפורים...
                    </div>
                  </div>
                )}

                {!chronicleLoading && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    {!hasAiStories && !isAdmin && totalPeriodGames > 0 && (
                      <div style={{ textAlign: 'center', padding: '1rem', color: 'var(--text-muted)', fontSize: '0.8rem', fontStyle: 'italic' }}>
                        הסיפורים טרם נוצרו לתקופה זו
                      </div>
                    )}
                    {rankedByProfit.map((player, idx) => {
                      const aiStory = chronicleStories[player.playerId];
                      const profitColor = player.totalProfit >= 0 ? 'var(--success)' : 'var(--danger)';

                      return (
                        <div key={player.playerId} data-chronicle-player style={{
                          padding: '0.85rem', background: 'var(--surface)',
                          borderRadius: '12px', direction: 'rtl',
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: '500', minWidth: '1.2rem' }}>#{idx + 1}</span>
                              <span style={{ fontSize: '1rem', fontWeight: '600' }}>{player.playerName}</span>
                            </div>
                            <span style={{ fontWeight: '700', fontSize: '1rem', color: profitColor }}>
                              {player.totalProfit >= 0 ? '+' : ''}{formatCurrency(player.totalProfit)}
                            </span>
                          </div>
                          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.4rem', paddingRight: '1.7rem' }}>
                            {player.gamesPlayed} משחקים | {Math.round(player.winPercentage)}% נצחונות | ממוצע {player.avgProfit >= 0 ? '+' : ''}{Math.round(player.avgProfit)}₪
                          </div>

                          {buildSparkline(player)}

                          {aiStory && (
                            <p style={{ margin: 0, fontSize: '0.8rem', lineHeight: 1.7, color: 'var(--text)', textAlign: 'right' }}>
                              {aiStory}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}
          {Object.keys(chronicleStories).length > 0 && (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: '0.5rem', marginBottom: '2rem' }}>
              <button
                onClick={handleShareChronicle}
                disabled={isSharingChronicle}
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
                  cursor: 'pointer',
                }}
              >
                {isSharingChronicle ? '📸...' : '📤 שתף'}
              </button>
            </div>
          )}
                </>
              )}
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
                    navigate(`/game-summary/${game.gameId}`, { 
                      state: { 
                        from: viewMode === 'players' ? 'players' : 'records', 
                        viewMode: viewMode,
                        recordInfo: savedRecordInfo,
                        playerInfo: viewMode === 'players' ? { playerId: recordDetails.playerId, playerName: recordDetails.playerName } : undefined,
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
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', maxHeight: '60vh', overflowY: 'auto' }}>
              {playerAllGames.games.map((game, idx) => (
                <div 
                  key={idx}
                  onClick={() => {
                    setPlayerAllGames(null);
                    navigate(`/game-summary/${game.gameId}`, { 
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
      </>
      )}
    </div>
  );
};

export default StatisticsScreen;

