import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh';
import { useNavigate, useLocation } from 'react-router-dom';
import { captureAndSplit, hideForCapture, shareFiles } from '../utils/sharing';
import { PlayerStats, Player, PlayerType } from '../types';
import { getPlayerStats, getAllPlayers, getAllGames, getAllGamePlayers, getSettings, getChronicleProfiles, saveChronicleProfiles } from '../database/storage';
import { formatCurrency, getProfitColor, cleanNumber, formatHebrewHalf } from '../utils/calculations';
import { generateMilestones, adaptPlayerStats, MilestoneOptions } from '../utils/milestones';
import { generatePlayerChronicle, ChroniclePlayerData, getModelDisplayName, getGeminiApiKey } from '../utils/geminiAI';
import { usePermissions } from '../App';
import { useTranslation } from '../i18n';
import AIProgressBar from '../components/AIProgressBar';
import AIKeyMissingNotice from '../components/AIKeyMissingNotice';
import { withAITiming } from '../utils/aiTiming';
import { hapticTap } from '../utils/haptics';

type TimePeriod = 'all' | 'h1' | 'h2' | 'year' | 'month' | 'custom';
type ViewMode = 'table' | 'records' | 'players';
type PlayerSubTab = 'stats' | 'stories';
type RecordsSubTab = 'global' | 'playerRecords';

const ME_BG = 'rgba(59, 130, 246, 0.14)';
const ME_NAME_COLOR = '#60a5fa';
const meRowStyle = { background: ME_BG, borderRight: '3px solid #3b82f6' } as const;
const meNameStyle = { color: ME_NAME_COLOR } as const;

// Auto-shrink long player names so narrow mobile cells don't ellipsize.
// Tiered: short names render at base size, longer names step down.
const getNameFontSize = (name: string, baseRem: number): string => {
  const len = (name || '').length;
  if (len <= 9) return `${baseRem}rem`;
  if (len <= 12) return `${(baseRem * 0.92).toFixed(3)}rem`;
  if (len <= 15) return `${(baseRem * 0.85).toFixed(3)}rem`;
  return `${(baseRem * 0.75).toFixed(3)}rem`;
};

const StatisticsScreen = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { playerName: identityName, isOwner } = usePermissions();
  const { t, isRTL, language } = useTranslation();
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
  const [tableMode, setTableMode] = useState<'profit' | 'gainLoss' | 'avgGainLoss'>('profit');
  // Local sort key for the Podium-Rate table (independent of the
  // main player table's `sortBy`). Defaults to 'total' to match
  // the table's headline metric (the 🏆 column).
  const [podiumSort, setPodiumSort] = useState<'total' | 'first' | 'second' | 'third' | 'games'>('total');
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
  const [customStartDate, setCustomStartDate] = useState<string>('');
  const [customEndDate, setCustomEndDate] = useState<string>('');
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
  const [isSharingPodiumRates, setIsSharingPodiumRates] = useState(false);
  const [isSharingAvgPlacement, setIsSharingAvgPlacement] = useState(false);
  const tableRef = useRef<HTMLDivElement>(null);
  const top20Ref = useRef<HTMLDivElement>(null);
  const top10Ref = useRef<HTMLDivElement>(null);
  const podiumRef = useRef<HTMLDivElement>(null);
  const hallOfFameRef = useRef<HTMLDivElement>(null);
  const rebuyStatsRef = useRef<HTMLDivElement>(null);
  const podiumRatesRef = useRef<HTMLDivElement>(null);
  const avgPlacementRef = useRef<HTMLDivElement>(null);
  const chronicleRef = useRef<HTMLDivElement>(null);
  // Refs for the interactive controls strips inside two of the
  // share-able cards. Hidden via `hideForCapture` during the
  // screenshot so the snapshot keeps the card chrome (background,
  // rounded corners, padding) but excludes the dropdown/buttons.
  const tableControlsRef = useRef<HTMLDivElement>(null);
  const podiumControlsRef = useRef<HTMLDivElement>(null);
  // Per-table "active only" override refs. Wrap each local toggle in a
  // div with one of these refs so we can `hideForCapture` it during the
  // table's share screenshot — the toggle is a live UI control, not
  // part of the data the user wants to share. The main + podium
  // toggles sit inside their existing controls-strip refs
  // (`tableControlsRef`, `podiumControlsRef`) so they're already hidden
  // during share screenshots. Top 10 / rebuy / avg placement sit on
  // the timeframe / title row, outside those strips, so they need
  // their own dedicated refs.
  const top10ActiveToggleRef = useRef<HTMLDivElement>(null);
  const rebuyActiveToggleRef = useRef<HTMLDivElement>(null);
  const avgPlacementActiveToggleRef = useRef<HTMLDivElement>(null);

  // Per-table override of the "active only" filter. Each table in the
  // טבלה view gets its own toggle that defaults to mirroring the global
  // `filterActiveOnly`. When the user flips a local toggle, that table
  // alone uses the overridden value; touching the global toggle clears
  // every override (clean-slate reset). When override differs from
  // global, we re-derive the table's rows from `stats` ignoring
  // `selectedPlayers` — which is the right semantic, since
  // `selectedPlayers` was auto-clamped by global at useEffect time and
  // override means "show this table as if global were the override
  // value".
  type ActiveOverrideTableId = 'main' | 'podium' | 'top10' | 'rebuy' | 'avgPlacement';
  const [tableActiveOverrides, setTableActiveOverrides] = useState<Partial<Record<ActiveOverrideTableId, boolean>>>({});
  const getEffectiveActive = (id: ActiveOverrideTableId): boolean =>
    tableActiveOverrides[id] ?? filterActiveOnly;
  const handleGlobalActiveToggle = () => {
    setFilterActiveOnly(prev => !prev);
    setTableActiveOverrides({});
  };
  const toggleTableActiveOverride = (id: ActiveOverrideTableId) => {
    const current = tableActiveOverrides[id] ?? filterActiveOnly;
    setTableActiveOverrides(prev => ({ ...prev, [id]: !current }));
  };

  // Chronicle AI state
  const [chronicleStories, setChronicleStories] = useState<Record<string, string>>({});
  const [chronicleLoading, setChronicleLoading] = useState(false);
  const [chronicleError, setChronicleError] = useState<string | null>(null);
  // Marks "AI proxy isn't reachable in this environment" — typically
  // localhost dev (Vite doesn't serve /api/*). Routed from the
  // AI_PROXY_UNAVAILABLE sentinel and rendered via the friendly
  // proxy-unavailable notice instead of a raw error.
  const [chronicleProxyDown, setChronicleProxyDown] = useState(false);
  const [isSharingChronicle, setIsSharingChronicle] = useState(false);
  const [chronicleModelName, setChronicleModelName] = useState<string>('');
  const [chronicleGeneratedAt, setChronicleGeneratedAt] = useState<string>('');
  const chronicleGenRef = useRef(false);
  const isInitialActiveFilterRef = useRef(true);

  const HEBREW_MONTH_NAMES = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

  const formatCustomRange = () => {
    if (!customStartDate && !customEndDate) return t('stats.selectDates');
    const locale = language === 'he' ? 'he-IL' : 'en-US';
    const fmt = (d: string) => new Date(d).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: '2-digit' });
    if (customStartDate && customEndDate) return `${fmt(customStartDate)} — ${fmt(customEndDate)}`;
    if (customStartDate) return `${t('stats.from')} ${fmt(customStartDate)}`;
    return `${t('stats.to')} ${fmt(customEndDate)}`;
  };

  const getTimeframeLabel = () => {
    if (language === 'he') {
      if (timePeriod === 'all') return 'כל הזמנים';
      if (timePeriod === 'year') return `שנת ${selectedYear}`;
      if (timePeriod === 'h1') return formatHebrewHalf(1, selectedYear);
      if (timePeriod === 'h2') return formatHebrewHalf(2, selectedYear);
      if (timePeriod === 'custom') return formatCustomRange();
      if (timePeriod === 'month') return `${HEBREW_MONTH_NAMES[selectedMonth - 1]} ${selectedYear}`;
      return '';
    }
    if (timePeriod === 'all') return 'All Time';
    if (timePeriod === 'year') return `${selectedYear}`;
    if (timePeriod === 'h1') return `H1 ${selectedYear}`;
    if (timePeriod === 'h2') return `H2 ${selectedYear}`;
    if (timePeriod === 'custom') return formatCustomRange();
    if (timePeriod === 'month') return `${new Intl.DateTimeFormat('en-US', { month: 'long' }).format(new Date(2024, selectedMonth - 1, 1))} ${selectedYear}`;
    return '';
  };

  const getHebrewTimeframeLabel = () => {
    if (timePeriod === 'all') return 'כל הזמנים';
    if (timePeriod === 'year') return `שנת ${selectedYear}`;
    if (timePeriod === 'h1') return formatHebrewHalf(1, selectedYear);
    if (timePeriod === 'h2') return formatHebrewHalf(2, selectedYear);
    if (timePeriod === 'custom') return formatCustomRange();
    if (timePeriod === 'month') return `${HEBREW_MONTH_NAMES[selectedMonth - 1]} ${selectedYear}`;
    return '';
  };

  const getChronicleKey = () => {
    if (timePeriod === 'all') return 'all';
    if (timePeriod === 'year') return `${selectedYear}`;
    if (timePeriod === 'h1') return `H1-${selectedYear}`;
    if (timePeriod === 'h2') return `H2-${selectedYear}`;
    if (timePeriod === 'custom') return `custom-${customStartDate || 'x'}-${customEndDate || 'x'}`;
    if (timePeriod === 'month') return `${selectedYear}-${String(selectedMonth).padStart(2, '0')}`;
    return 'all';
  };

  const handleShareTable = async () => {
    if (!tableRef.current) return;
    setIsSharing(true);
    const restoreControls = hideForCapture(tableControlsRef.current);
    try {
      const files = await captureAndSplit(tableRef.current, 'poker-statistics');
      await shareFiles(files, t('stats.title'));
    } catch (e) { console.error('Error sharing:', e); }
    finally {
      restoreControls();
      setIsSharing(false);
    }
  };

  const handleShareTop20 = async () => {
    if (!top20Ref.current) return;
    setIsSharingTop20(true);
    try {
      const files = await captureAndSplit(top20Ref.current, 'poker-top20-wins');
      await shareFiles(files, t('stats.top20'));
    } catch (e) { console.error('Error sharing top 20:', e); }
    finally { setIsSharingTop20(false); }
  };

  const handleShareTop10 = async () => {
    if (!top10Ref.current) return;
    setIsSharingTop10(true);
    const restoreToggle = hideForCapture(top10ActiveToggleRef.current);
    try {
      const files = await captureAndSplit(top10Ref.current, 'poker-top10-wins');
      await shareFiles(files, t('stats.top10'));
    } catch (e) { console.error('Error sharing top 10:', e); }
    finally {
      restoreToggle();
      setIsSharingTop10(false);
    }
  };

  const handleShareRebuyStats = async () => {
    if (!rebuyStatsRef.current) return;
    setIsSharingRebuyStats(true);
    const restoreToggle = hideForCapture(rebuyActiveToggleRef.current);
    try {
      const files = await captureAndSplit(rebuyStatsRef.current, 'poker-rebuy-stats');
      await shareFiles(files, t('stats.rebuyStats'));
    } catch (e) { console.error('Error sharing rebuy stats:', e); }
    finally {
      restoreToggle();
      setIsSharingRebuyStats(false);
    }
  };

  const handleSharePodiumRates = async () => {
    if (!podiumRatesRef.current) return;
    setIsSharingPodiumRates(true);
    const restoreControls = hideForCapture(podiumControlsRef.current);
    try {
      const files = await captureAndSplit(podiumRatesRef.current, 'poker-podium-rates');
      await shareFiles(files, t('stats.podiumRates'));
    } catch (e) { console.error('Error sharing podium rates:', e); }
    finally {
      restoreControls();
      setIsSharingPodiumRates(false);
    }
  };

  const handleShareAvgPlacement = async () => {
    if (!avgPlacementRef.current) return;
    setIsSharingAvgPlacement(true);
    const restoreToggle = hideForCapture(avgPlacementActiveToggleRef.current);
    try {
      const files = await captureAndSplit(avgPlacementRef.current, 'poker-avg-placement');
      await shareFiles(files, t('stats.avgPlacement'));
    } catch (e) { console.error('Error sharing avg placement:', e); }
    finally {
      restoreToggle();
      setIsSharingAvgPlacement(false);
    }
  };

  const handleSharePodium = async () => {
    if (!podiumRef.current) return;
    setIsSharingPodium(true);
    try {
      const files = await captureAndSplit(podiumRef.current, 'poker-podium');
      await shareFiles(files, t('stats.seasonPodium', { year: podiumData.year }));
    } catch (e) { console.error('Error sharing podium:', e); }
    finally { setIsSharingPodium(false); }
  };

  const handleShareHallOfFame = async () => {
    if (!hallOfFameRef.current) return;
    setIsSharingHallOfFame(true);
    try {
      const files = await captureAndSplit(hallOfFameRef.current, 'poker-hall-of-fame');
      await shareFiles(files, t('stats.hallOfFame'));
    } catch (e) { console.error('Error sharing hall of fame:', e); }
    finally { setIsSharingHallOfFame(false); }
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
              ${t('stats.chronicle')} — ${titleLabel}${pageNum}
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
        const { default: html2canvas } = await import('html2canvas');
        const canvas = await html2canvas(container, { backgroundColor: '#0f172a', scale: 2, logging: false, useCORS: true });
        document.body.removeChild(container);

        const blob = await new Promise<Blob>((resolve) => { canvas.toBlob((b) => resolve(b!), 'image/png', 1.0); });
        const fileName = chunks.length > 1 ? `poker-chronicle-${ci + 1}.png` : 'poker-chronicle.png';
        files.push(new File([blob], fileName, { type: 'image/png' }));
      }

      if (navigator.share && navigator.canShare({ files })) {
        try {
          await navigator.share({ files, title: t('stats.chronicle') });
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
      case 'h1':
        return {
          start: new Date(year, 0, 1),
          end: new Date(year, 5, 30, 23, 59, 59)
        };
      case 'h2':
        return {
          start: new Date(year, 6, 1),
          end: new Date(year, 11, 31, 23, 59, 59)
        };
      case 'year':
        return {
          start: new Date(year, 0, 1),
          end: new Date(year, 11, 31, 23, 59, 59)
        };
      case 'month': {
        const monthIndex = selectedMonth - 1;
        const lastDay = new Date(year, monthIndex + 1, 0).getDate();
        return {
          start: new Date(year, monthIndex, 1),
          end: new Date(year, monthIndex, lastDay, 23, 59, 59)
        };
      }
      case 'custom': {
        if (!customStartDate && !customEndDate) return undefined;
        const result: { start?: Date; end?: Date } = {};
        if (customStartDate) result.start = new Date(customStartDate + 'T00:00:00');
        if (customEndDate) result.end = new Date(customEndDate + 'T23:59:59');
        return result;
      }
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
      playerId: string;
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
        // No `selectedPlayers` filter here — top10TableData applies it
        // (or its override-equivalent) at consumer time so the
        // per-table "active only" toggle can swap visibility without
        // re-iterating game data.

        if (gp.profit > 0) {
          const currentPlayer = players.find(p => p.id === gp.playerId);
          const playerName = currentPlayer?.name || gp.playerName;

          allResults.push({
            playerName: playerName,
            playerId: gp.playerId,
            profit: gp.profit,
            date: game.date,
            gameId: game.id,
            playersCount
          });
        }
      }
    }

    return allResults
      .sort((a, b) => b.profit - a.profit);
    // No `.slice` here — top10TableData slices to 10 after applying
    // its visibility filter, so a player who would only land in the
    // top 10 once we widen visibility doesn't get pre-truncated.
  }, [stats, players, selectedTypes, timePeriod, selectedYear, selectedMonth, customStartDate, customEndDate]);

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

  useEffect(() => {
    loadStats();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  
  // Reload data when filters change
  useEffect(() => {
    loadStats();
  }, [timePeriod, selectedYear, selectedMonth, customStartDate, customEndDate]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useRealtimeRefresh(useCallback(() => loadStats(true), []));

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

  const loadStats = (preserveSelection = false) => {
    const dateFilter = getDateFilter();
    const playerStats = getPlayerStats(dateFilter);
    const allPlayers = getAllPlayers();
    setStats(playerStats);
    setPlayers(allPlayers);
    if (!preserveSelection) {
      const permanentPlayerIds = allPlayers
        .filter(p => p.type === 'permanent')
        .map(p => p.id);
      const permanentStatsIds = playerStats
        .filter(s => permanentPlayerIds.includes(s.playerId))
        .map(s => s.playerId);
      setSelectedPlayers(new Set(permanentStatsIds.length > 0 ? permanentStatsIds : playerStats.map(p => p.playerId)));
    }
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
  }, [timePeriod, selectedYear, selectedMonth, customStartDate, customEndDate]);

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
  }, [timePeriod, selectedYear, selectedMonth, customStartDate, customEndDate, stats, selectedTypes, filterActiveOnly, getPlayerType]);

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

  // Update selected players when active filter or stats change
  // All players who pass the threshold are selected by default
  useEffect(() => {
    if (availableStats.length > 0) {
      isInitialActiveFilterRef.current = false;
      setSelectedPlayers(new Set(availableStats.map(p => p.playerId)));
    }
  }, [filterActiveOnly, stats.length, availableStats]);

  // Load cached chronicle stories on period change
  useEffect(() => {
    if (viewMode !== 'players' || playerSubTab !== 'stories') return;
    const periodKey = getChronicleKey();
    const cached = getChronicleProfiles(periodKey);
    if (cached) {
      setChronicleStories(cached.profiles);
      setChronicleModelName(cached.model || '');
      setChronicleGeneratedAt(cached.generatedAt || '');
    } else {
      setChronicleStories({});
      setChronicleModelName('');
      setChronicleGeneratedAt('');
    }
    setChronicleError(null);
    chronicleGenRef.current = false;
  }, [viewMode, playerSubTab, timePeriod, selectedYear, selectedMonth, customStartDate, customEndDate]);

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

    // Return rebuy data for ALL players who played in the period.
    // `rebuyTableData` applies the visibility filter at consumer time
    // (driven by the global toggle, or the per-table override). This
    // is what lets the local override widen back to inactive players
    // without re-iterating game data.
    return Array.from(playerMap.values())
      .filter(p => p.gamesPlayed > 0)
      .sort((a, b) => (b.totalBuyins / b.gamesPlayed) - (a.totalBuyins / a.gamesPlayed));
  }, [stats, players, timePeriod, selectedYear, selectedMonth, customStartDate, customEndDate]);

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
  }, [timePeriod, selectedYear, selectedMonth, customStartDate, customEndDate]);

  // Per-player place-finish rates (1st/2nd/3rd) for the current time
  // period:
  //  · Place is awarded only when the top finisher actually won
  //    (sorted[0].profit > 0). Avoids crediting "winners" of all-loss
  //    games where the highest profit is still negative.
  //  · Eligibility piggy-backs on `filteredStats`, which already
  //    respects the screen-wide "active only" toggle and the
  //    player-selection filter — so this table follows the same
  //    inclusion rules as every other table on the screen. We do NOT
  //    apply a separate 30%-participation gate here (we used to);
  //    that double-gated a player who passed the screen's threshold
  //    but not the trivia gate, which was confusing — the visible
  //    "active only (7+ games)" badge said one thing and the table
  //    silently said another.
  //  · Sorted by 1st-place rate desc, then 2nd, then 3rd, then
  //    games desc — the table headlines the win-rate dimension while
  //    keeping consistent finishers visible.
  const podiumRateStats = useMemo(() => {
    const dateFilter = getDateFilter();
    const periodGames = getAllGames().filter(g => {
      if (g.status !== 'completed') return false;
      if (!dateFilter) return true;
      const gameDate = new Date(g.date || g.createdAt);
      if (dateFilter.start && gameDate < dateFilter.start) return false;
      if (dateFilter.end && gameDate > dateFilter.end) return false;
      return true;
    });
    const totalGames = periodGames.length;
    if (totalGames === 0) return { rows: [], totalGames: 0 };

    const periodGameIds = new Set(periodGames.map(g => g.id));
    const periodGP = getAllGamePlayers().filter(gp => periodGameIds.has(gp.gameId));

    type Counts = { playerName: string; games: number; firsts: number; seconds: number; thirds: number };
    const counts = new Map<string, Counts>();

    const playersByGame = new Map<string, typeof periodGP>();
    for (const gp of periodGP) {
      const arr = playersByGame.get(gp.gameId);
      if (arr) arr.push(gp);
      else playersByGame.set(gp.gameId, [gp]);
    }

    for (const players of playersByGame.values()) {
      if (players.length === 0) continue;
      for (const p of players) {
        const e = counts.get(p.playerName) ?? { playerName: p.playerName, games: 0, firsts: 0, seconds: 0, thirds: 0 };
        e.games++;
        counts.set(p.playerName, e);
      }
      const sorted = [...players].sort((a, b) => b.profit - a.profit);
      if (sorted[0].profit <= 0) continue;
      const e1 = counts.get(sorted[0].playerName); if (e1) e1.firsts++;
      if (sorted.length >= 2) { const e2 = counts.get(sorted[1].playerName); if (e2) e2.seconds++; }
      if (sorted.length >= 3) { const e3 = counts.get(sorted[2].playerName); if (e3) e3.thirds++; }
    }

    // Build podium rows for ALL players who played in the period —
    // no `filteredStats` filter applied here. Consumers (the global
    // view via `podiumTableRows`, or any per-table override) decide
    // which subset of names to show. This lets a per-table "active
    // only" override widen back to inactive players without needing
    // to re-iterate the game data.
    const rows = Array.from(counts.values())
      .map(c => {
        const totalPodiums = c.firsts + c.seconds + c.thirds;
        return {
          ...c,
          totalPodiums,
          firstRate: c.games > 0 ? (c.firsts / c.games) * 100 : 0,
          secondRate: c.games > 0 ? (c.seconds / c.games) * 100 : 0,
          thirdRate: c.games > 0 ? (c.thirds / c.games) * 100 : 0,
          // Total podium rate = how often the player reaches the
          // top 3 in any capacity. Mathematically equivalent to
          // summing the three per-medal rates (same denominator),
          // and that's how it will read on the row: the new
          // column's % equals the sum of the three medal columns.
          totalRate: c.games > 0 ? (totalPodiums / c.games) * 100 : 0,
        };
      });
    // Sort + visibility filter happen in `podiumTableRows`.
    return { rows, totalGames };
  }, [timePeriod, selectedYear, selectedMonth, customStartDate, customEndDate]);

  // Per-table visibility helpers for the "active only" override.
  // When a table's effective flag matches the global, we reuse the
  // globally-derived visibility (filteredStats — respects user's
  // manual selectedPlayers refinement). When the effective flag
  // differs, we derive afresh from `stats` — applying selectedTypes
  // and the effective active filter, but NOT selectedPlayers (which
  // was auto-clamped by the global toggle's useEffect and would
  // otherwise hide the very rows the override is meant to surface).
  const visibleNamesForActive = (eff: boolean): Set<string> => {
    if (eff === filterActiveOnly) {
      return new Set(filteredStats.map(s => s.playerName));
    }
    let pool = stats.filter(s => selectedTypes.has(getPlayerType(s.playerId)));
    if (eff) pool = pool.filter(s => s.gamesPlayed >= activeThreshold);
    return new Set(pool.map(s => s.playerName));
  };

  // Main stats table rows — uses 'main' effective flag.
  const mainTableSortedStats = useMemo(() => {
    const eff = tableActiveOverrides.main ?? filterActiveOnly;
    let pool: PlayerStats[];
    if (eff === filterActiveOnly) {
      pool = filteredStats;
    } else {
      pool = stats.filter(s => selectedTypes.has(getPlayerType(s.playerId)));
      if (eff) pool = pool.filter(s => s.gamesPlayed >= activeThreshold);
    }
    return [...pool].sort((a, b) => {
      switch (sortBy) {
        case 'profit': return b.totalProfit - a.totalProfit;
        case 'games': return b.gamesPlayed - a.gamesPlayed;
        case 'winRate': return b.winPercentage - a.winPercentage;
        default: return 0;
      }
    });
  }, [tableActiveOverrides.main, filterActiveOnly, filteredStats, stats, selectedTypes, getPlayerType, activeThreshold, sortBy]);

  // Podium-rate rows — uses 'podium' effective flag plus user's sort.
  // Replaces the old `sortedPodiumRows`: tie-break chain is unchanged.
  const podiumTableRows = useMemo(() => {
    const eff = tableActiveOverrides.podium ?? filterActiveOnly;
    const visible = visibleNamesForActive(eff);
    const rows = podiumRateStats.rows.filter(r => visible.has(r.playerName));
    const cmp = (a: typeof rows[number], b: typeof rows[number]) => {
      switch (podiumSort) {
        case 'first':
          return b.firstRate - a.firstRate || b.totalRate - a.totalRate || b.games - a.games;
        case 'second':
          return b.secondRate - a.secondRate || b.totalRate - a.totalRate || b.games - a.games;
        case 'third':
          return b.thirdRate - a.thirdRate || b.totalRate - a.totalRate || b.games - a.games;
        case 'games':
          return b.games - a.games || b.totalRate - a.totalRate;
        case 'total':
        default:
          return (
            b.totalRate - a.totalRate ||
            b.firstRate - a.firstRate ||
            b.secondRate - a.secondRate ||
            b.thirdRate - a.thirdRate ||
            b.games - a.games
          );
      }
    };
    return [...rows].sort(cmp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableActiveOverrides.podium, filterActiveOnly, podiumRateStats.rows, podiumSort, filteredStats, stats, selectedTypes, getPlayerType, activeThreshold]);

  // Top 10 single-night wins — uses 'top10' effective flag.
  // top20Wins is now unfiltered + unsliced (only `selectedTypes` was
  // applied upstream); we filter by visibility here, then take the
  // first 10. When effective matches global we still apply the
  // selectedPlayers refinement; when it differs the override widens.
  const top10TableData = useMemo(() => {
    const eff = tableActiveOverrides.top10 ?? filterActiveOnly;
    let allowed: (entry: { playerId: string; playerName: string }) => boolean;
    if (eff === filterActiveOnly) {
      allowed = (entry) => selectedPlayers.has(entry.playerId);
    } else {
      const visible = visibleNamesForActive(eff);
      allowed = (entry) => visible.has(entry.playerName);
    }
    return top20Wins.filter(allowed).slice(0, 10);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableActiveOverrides.top10, filterActiveOnly, top20Wins, selectedPlayers, filteredStats, stats, selectedTypes, getPlayerType, activeThreshold]);

  // Rebuy stats table rows — uses 'rebuy' effective flag.
  const rebuyTableData = useMemo(() => {
    const eff = tableActiveOverrides.rebuy ?? filterActiveOnly;
    const visible = visibleNamesForActive(eff);
    return rebuyStats.filter(p => visible.has(p.playerName));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableActiveOverrides.rebuy, filterActiveOnly, rebuyStats, filteredStats, stats, selectedTypes, getPlayerType, activeThreshold]);

  // Per-player average finishing placement across all games in the
  // current period:
  //  · Within each game, players are ranked by profit (descending);
  //    ties get the average of the positions they would have occupied
  //    (fractional / "average" ranking — e.g. tied for 2nd & 3rd both
  //    get 2.5). This is the mathematically defensible choice when the
  //    aggregate metric is itself an average — competition ranking
  //    (1, 2, 2, 4) would bias heavily toward whoever sits earlier in
  //    the data after the tie, which is meaningless here.
  //  · Aggregates per playerName: avg rank, best (min) rank, worst
  //    (max) rank, games played. Same playerName-keyed shape used by
  //    `podiumRateStats` so the same `visibleNamesForActive` filter
  //    applies cleanly downstream.
  //  · Like `podiumRateStats`, this returns rows for ALL players who
  //    appeared in the period — visibility filtering happens in
  //    `avgPlacementTableRows`.
  const avgPlacementStats = useMemo(() => {
    const dateFilter = getDateFilter();
    const periodGames = getAllGames().filter(g => {
      if (g.status !== 'completed') return false;
      if (!dateFilter) return true;
      const gameDate = new Date(g.date || g.createdAt);
      if (dateFilter.start && gameDate < dateFilter.start) return false;
      if (dateFilter.end && gameDate > dateFilter.end) return false;
      return true;
    });
    if (periodGames.length === 0) return [] as Array<{ playerName: string; games: number; avgRank: number; bestRank: number; worstRank: number }>;

    const periodGameIds = new Set(periodGames.map(g => g.id));
    const periodGP = getAllGamePlayers().filter(gp => periodGameIds.has(gp.gameId));

    const playersByGame = new Map<string, typeof periodGP>();
    for (const gp of periodGP) {
      const arr = playersByGame.get(gp.gameId);
      if (arr) arr.push(gp);
      else playersByGame.set(gp.gameId, [gp]);
    }

    type Acc = { playerName: string; games: number; sumRank: number; bestRank: number; worstRank: number };
    const acc = new Map<string, Acc>();

    for (const players of playersByGame.values()) {
      if (players.length === 0) continue;
      const sorted = [...players].sort((a, b) => b.profit - a.profit);
      // Walk runs of equal profit and assign each member the average
      // of their would-be positions (1-indexed). Iterative O(n).
      let i = 0;
      while (i < sorted.length) {
        let j = i;
        while (j + 1 < sorted.length && sorted[j + 1].profit === sorted[i].profit) j++;
        const avgPos = ((i + 1) + (j + 1)) / 2;
        for (let k = i; k <= j; k++) {
          const p = sorted[k];
          const e = acc.get(p.playerName) ?? { playerName: p.playerName, games: 0, sumRank: 0, bestRank: Infinity, worstRank: -Infinity };
          e.games++;
          e.sumRank += avgPos;
          if (avgPos < e.bestRank) e.bestRank = avgPos;
          if (avgPos > e.worstRank) e.worstRank = avgPos;
          acc.set(p.playerName, e);
        }
        i = j + 1;
      }
    }

    return Array.from(acc.values()).map(e => ({
      playerName: e.playerName,
      games: e.games,
      avgRank: e.games > 0 ? e.sumRank / e.games : 0,
      bestRank: e.games > 0 ? e.bestRank : 0,
      worstRank: e.games > 0 ? e.worstRank : 0,
    }));
  }, [timePeriod, selectedYear, selectedMonth, customStartDate, customEndDate]);

  // Avg-placement rows — uses 'avgPlacement' effective flag, sorted
  // by avg rank ascending (lower = better finishes).
  const avgPlacementTableRows = useMemo(() => {
    const eff = tableActiveOverrides.avgPlacement ?? filterActiveOnly;
    const visible = visibleNamesForActive(eff);
    const rows = avgPlacementStats.filter(r => visible.has(r.playerName));
    return [...rows].sort((a, b) =>
      a.avgRank - b.avgRank ||
      a.bestRank - b.bestRank ||
      b.games - a.games
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableActiveOverrides.avgPlacement, filterActiveOnly, avgPlacementStats, filteredStats, stats, selectedTypes, getPlayerType, activeThreshold]);

  const getMedal = (index: number, value: number) => {
    if (value <= 0) return '';
    if (index === 0) return ' 🥇';
    if (index === 1) return ' 🥈';
    if (index === 2) return ' 🥉';
    return '';
  };

  // Compact "active only" toggle rendered inside each table card. When
  // the table is overriding the global filter the border switches to
  // the primary accent so the user can tell at a glance that this
  // table no longer follows the page-level toggle. Tapping the global
  // toggle clears every override; that's why we don't bother with a
  // per-table reset link.
  const renderActiveOverrideToggle = (id: ActiveOverrideTableId) => {
    const eff = getEffectiveActive(id);
    const overriding = tableActiveOverrides[id] !== undefined && tableActiveOverrides[id] !== filterActiveOnly;
    return (
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); toggleTableActiveOverride(id); }}
        title={overriding ? t('stats.localOverrideHint') : t('stats.activeOnly')}
        style={{
          padding: '0.2rem 0.5rem',
          fontSize: '0.65rem',
          borderRadius: '12px',
          border: `1px solid ${overriding ? 'var(--primary)' : 'var(--border)'}`,
          background: eff ? 'rgba(99, 102, 241, 0.12)' : 'var(--surface)',
          color: eff ? 'var(--primary)' : 'var(--text-muted)',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          fontWeight: 500,
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.25rem',
        }}
      >
        🎮 {eff ? t('stats.activeOnlyShort') : t('stats.allPlayersShort')}
      </button>
    );
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
    hapticTap();
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
          <span style={{ fontWeight: '700', ...(identityName && players[0].playerName === identityName ? meNameStyle : {}) }}>{players[0].playerName}</span>
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
                <span style={{ fontWeight: '500', ...(identityName && p.playerName === identityName ? meNameStyle : {}) }}>{p.playerName}</span>
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

  const timePeriodChip = `(${getTimeframeLabel()})`;

  return (
    <div className="fade-in">
      <div className="page-header">
        <h1 className="page-title">{t('stats.title')}</h1>
        <p className="page-subtitle">{t('stats.subtitle')}</p>
      </div>

      {/* View Mode Toggle - Always visible */}
      <div className="card" style={{ padding: '0.75rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button 
            className="btn btn-sm btn-secondary"
            onClick={() => setViewMode('table')}
            style={{ flex: 1, minWidth: 0, padding: '0.5rem 0.25rem', fontSize: '0.75rem', ...(viewMode === 'table' ? { background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.4)', color: '#34d399' } : {}) }}
          >
            {t('stats.tableView')}
          </button>
          <button 
            className="btn btn-sm btn-secondary"
            onClick={() => setViewMode('records')}
            style={{ flex: 1, minWidth: 0, padding: '0.5rem 0.25rem', fontSize: '0.75rem', ...(viewMode === 'records' ? { background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.4)', color: '#34d399' } : {}) }}
          >
            {t('stats.recordsView')}
          </button>
          <button 
            className="btn btn-sm btn-secondary"
            onClick={() => setViewMode('players')}
            style={{ flex: 1, minWidth: 0, padding: '0.5rem 0.25rem', fontSize: '0.75rem', ...(viewMode === 'players' ? { background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.4)', color: '#34d399' } : {}) }}
          >
            {t('stats.playersView')}
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
                {t('stats.activeOnly')}
              </span>
              <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                {t('stats.minGames', { threshold: activeThreshold })}
              </span>
            </div>
            <span style={{ fontSize: '0.55rem', color: 'var(--text-muted)', marginLeft: '1.1rem' }}>
              {t('stats.minRequired', { threshold: activeThreshold, total: totalGamesInPeriod })}
            </span>
          </div>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); e.preventDefault(); handleGlobalActiveToggle(); }}
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
                  {t('stats.timePeriod')} {timePeriodChip}
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
                  {t('stats.allTime')}
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
                  {t('stats.year')}
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
                  {t('stats.h1Label')}
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
                  {t('stats.h2Label')}
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
                  {t('stats.month')}
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); e.preventDefault(); setTimePeriod('custom'); }}
                  style={{
                    flex: 1,
                    minWidth: '50px',
                    padding: '0.4rem',
                    fontSize: '0.7rem',
                    borderRadius: '6px',
                    border: timePeriod === 'custom' ? '2px solid var(--primary)' : '1px solid var(--border)',
                    background: timePeriod === 'custom' ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
                    color: timePeriod === 'custom' ? 'var(--primary)' : 'var(--text-muted)',
                    cursor: 'pointer'
                  }}
                >
                  {t('stats.custom')}
                </button>
              </div>
              {/* Year Selector - show when not "all" and not "custom" */}
              {timePeriod !== 'all' && timePeriod !== 'custom' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.4rem', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{t('stats.yearLabel')}</span>
                  <select
                    value={selectedYear}
                    onChange={(e) => setSelectedYear(parseInt(e.target.value))}
                    style={{
                      padding: '0.25rem 0.4rem',
                      fontSize: '0.7rem',
                      borderRadius: '4px',
                      border: '1px solid rgba(16,185,129,0.3)',
                      background: 'rgba(16,185,129,0.08)',
                      color: '#10B981',
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
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginLeft: '0.3rem' }}>{t('stats.monthLabel')}</span>
                      <select
                        value={selectedMonth}
                        onChange={(e) => setSelectedMonth(parseInt(e.target.value))}
                        style={{
                          padding: '0.25rem 0.4rem',
                          fontSize: '0.7rem',
                          borderRadius: '4px',
                          border: '1px solid rgba(16,185,129,0.3)',
                          background: 'rgba(16,185,129,0.08)',
                          color: '#10B981',
                          cursor: 'pointer',
                          minWidth: '70px'
                        }}
                      >
                        {Array.from({ length: 12 }, (_, monthIndex) => {
                          const value = monthIndex + 1;
                          const label = new Intl.DateTimeFormat(language === 'he' ? 'he-IL' : 'en-US', { month: 'long' }).format(new Date(2024, monthIndex, 1));
                          return (
                            <option key={value} value={value} style={{ background: '#1a1a2e', color: '#ffffff' }}>{label}</option>
                          );
                        })}
                      </select>
                    </>
                  )}
                  <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                    {timePeriod === 'h1' && t('stats.h1Hint')}
                    {timePeriod === 'h2' && t('stats.h2Hint')}
                  </span>
              </div>
            )}
              {/* Custom date range pickers */}
              {timePeriod === 'custom' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.4rem', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text)', fontWeight: 600 }}>{t('stats.from')}</span>
                  <input
                    type="date"
                    value={customStartDate}
                    onChange={(e) => setCustomStartDate(e.target.value)}
                    className="custom-date-input"
                    style={{
                      padding: '0.3rem 0.5rem',
                      fontSize: '0.75rem',
                      borderRadius: '6px',
                      border: '1px solid rgba(99,102,241,0.4)',
                      background: '#1e1e3a',
                      color: '#ffffff',
                      cursor: 'pointer',
                      colorScheme: 'dark',
                    }}
                  />
                  <span style={{ fontSize: '0.7rem', color: 'var(--text)', fontWeight: 600 }}>{t('stats.to')}</span>
                  <input
                    type="date"
                    value={customEndDate}
                    onChange={(e) => setCustomEndDate(e.target.value)}
                    min={customStartDate || undefined}
                    className="custom-date-input"
                    style={{
                      padding: '0.3rem 0.5rem',
                      fontSize: '0.75rem',
                      borderRadius: '6px',
                      border: '1px solid rgba(99,102,241,0.4)',
                      background: '#1e1e3a',
                      color: '#ffffff',
                      cursor: 'pointer',
                      colorScheme: 'dark',
                    }}
                  />
                  {(customStartDate || customEndDate) && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setCustomStartDate(''); setCustomEndDate(''); }}
                      style={{
                        padding: '0.2rem 0.4rem', fontSize: '0.65rem', borderRadius: '4px',
                        border: '1px solid var(--border)', background: 'var(--surface)',
                        color: 'var(--text-muted)', cursor: 'pointer',
                      }}
                    >
                      {t('stats.clearDates')}
                    </button>
                  )}
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
                {t('stats.filterPlayers', { selected: selectedPlayers.size, total: availableStats.length })}
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
                {selectedPlayers.size === availableStats.length ? t('common.clear') : t('common.selectAll')}
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
            <p>{t('stats.noStatsForPeriod')}</p>
            <p className="text-muted">{t('stats.tryDifferent')}</p>
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
                  {t('stats.hallOfFame')}
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
                  {t('stats.personalRecords')}
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
                  {t('stats.seasonPodium', { year: podiumData.year })}
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
                    {t('stats.h1Col')}
                  </div>
                  {podiumData.h1.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                      {podiumData.h1.map((player, idx) => {
                        const isMe = identityName && player.playerName === identityName;
                        return (
                        <div key={player.playerId} style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.35rem',
                          padding: '0.3rem 0.4rem',
                          background: idx === 0 ? 'linear-gradient(135deg, rgba(251, 191, 36, 0.2), rgba(251, 191, 36, 0.1))' :
                                     idx === 1 ? 'linear-gradient(135deg, rgba(156, 163, 175, 0.2), rgba(156, 163, 175, 0.1))' :
                                     'linear-gradient(135deg, rgba(217, 119, 6, 0.2), rgba(217, 119, 6, 0.1))',
                          borderRadius: '4px',
                          fontSize: '0.65rem',
                          ...(isMe ? { outline: '1.5px solid #3b82f6' } : {})
                        }}>
                          <span style={{ fontSize: '0.9rem' }}>
                            {idx === 0 ? '🥇' : idx === 1 ? '🥈' : '🥉'}
                          </span>
                          <span style={{ flex: 1, fontWeight: isMe ? '700' : '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: getNameFontSize(player.playerName, 0.65), ...(isMe ? meNameStyle : {}) }}>
                            {player.playerName}
                          </span>
                          <span style={{ fontWeight: '600', color: player.profit >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                            {formatCurrency(player.profit)}
                          </span>
                        </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div style={{ textAlign: 'center', fontSize: '0.6rem', color: 'var(--text-muted)', padding: '0.5rem' }}>{t('stats.noDataShort')}</div>
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
                    {t('stats.h2Col')}
                  </div>
                  {podiumData.h2.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                      {podiumData.h2.map((player, idx) => {
                        const isMe = identityName && player.playerName === identityName;
                        return (
                        <div key={player.playerId} style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.35rem',
                          padding: '0.3rem 0.4rem',
                          background: idx === 0 ? 'linear-gradient(135deg, rgba(251, 191, 36, 0.2), rgba(251, 191, 36, 0.1))' :
                                     idx === 1 ? 'linear-gradient(135deg, rgba(156, 163, 175, 0.2), rgba(156, 163, 175, 0.1))' :
                                     'linear-gradient(135deg, rgba(217, 119, 6, 0.2), rgba(217, 119, 6, 0.1))',
                          borderRadius: '4px',
                          fontSize: '0.65rem',
                          ...(isMe ? { outline: '1.5px solid #3b82f6' } : {})
                        }}>
                          <span style={{ fontSize: '0.9rem' }}>{idx === 0 ? '🥇' : idx === 1 ? '🥈' : '🥉'}</span>
                          <span style={{ flex: 1, fontWeight: isMe ? '700' : '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: getNameFontSize(player.playerName, 0.65), ...(isMe ? meNameStyle : {}) }}>{player.playerName}</span>
                          <span style={{ fontWeight: '600', color: player.profit >= 0 ? 'var(--success)' : 'var(--danger)' }}>{formatCurrency(player.profit)}</span>
                        </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div style={{ textAlign: 'center', fontSize: '0.6rem', color: 'var(--text-muted)', padding: '0.5rem' }}>{t('stats.noDataShort')}</div>
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
                    {t('stats.fullYear')}
                  </div>
                  {podiumData.yearly.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                      {podiumData.yearly.map((player, idx) => {
                        const isMe = identityName && player.playerName === identityName;
                        return (
                        <div key={player.playerId} style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.35rem',
                          padding: '0.3rem 0.4rem',
                          background: idx === 0 ? 'linear-gradient(135deg, rgba(251, 191, 36, 0.2), rgba(251, 191, 36, 0.1))' :
                                     idx === 1 ? 'linear-gradient(135deg, rgba(156, 163, 175, 0.2), rgba(156, 163, 175, 0.1))' :
                                     'linear-gradient(135deg, rgba(217, 119, 6, 0.2), rgba(217, 119, 6, 0.1))',
                          borderRadius: '4px',
                          fontSize: '0.65rem',
                          ...(isMe ? { outline: '1.5px solid #3b82f6' } : {})
                        }}>
                          <span style={{ fontSize: '0.9rem' }}>{idx === 0 ? '🥇' : idx === 1 ? '🥈' : '🥉'}</span>
                          <span style={{ flex: 1, fontWeight: isMe ? '700' : '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: getNameFontSize(player.playerName, 0.65), ...(isMe ? meNameStyle : {}) }}>{player.playerName}</span>
                          <span style={{ fontWeight: '600', color: player.profit >= 0 ? 'var(--success)' : 'var(--danger)' }}>{formatCurrency(player.profit)}</span>
                        </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div style={{ textAlign: 'center', fontSize: '0.6rem', color: 'var(--text-muted)', padding: '0.5rem' }}>{t('stats.noDataShort')}</div>
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
                  {isSharingPodium ? t('common.capturing') : t('common.share')}
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
                    {t('stats.hallOfFame')}
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
                    <div>{t('stats.yearColShort')}</div>
                    <div style={{ color: '#3b82f6' }}>{t('stats.h1Label')}</div>
                    <div style={{ color: '#8b5cf6' }}>{t('stats.h2Label')}</div>
                    <div style={{ color: 'var(--primary)' }}>{t('stats.yearColShort')}</div>
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
                            <span style={{ fontWeight: idx === 0 ? '600' : '400', color: identityName && player.playerName === identityName ? ME_NAME_COLOR : 'var(--text)', fontSize: idx === 0 ? '0.58rem' : '0.52rem' }}>{player.playerName}</span>
                            <span style={{ fontSize: '0.48rem', color: player.profit >= 0 ? 'var(--success)' : 'var(--danger)' }}>{formatCurrency(player.profit)}</span>
                          </div>
                        )) : <span style={{ color: 'var(--text-muted)', fontSize: '0.5rem', textAlign: 'center' }}>-</span>}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', padding: '0.2rem', background: yearData.h2Top3.length > 0 ? 'rgba(139, 92, 246, 0.08)' : 'transparent', borderRadius: '4px' }}>
                        {yearData.h2Top3.length > 0 ? yearData.h2Top3.map((player, idx) => (
                          <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '0.2rem', justifyContent: 'center' }}>
                            <span style={{ fontSize: '0.6rem' }}>{idx === 0 ? '🥇' : idx === 1 ? '🥈' : '🥉'}</span>
                            <span style={{ fontWeight: idx === 0 ? '600' : '400', color: identityName && player.playerName === identityName ? ME_NAME_COLOR : 'var(--text)', fontSize: idx === 0 ? '0.58rem' : '0.52rem' }}>{player.playerName}</span>
                            <span style={{ fontSize: '0.48rem', color: player.profit >= 0 ? 'var(--success)' : 'var(--danger)' }}>{formatCurrency(player.profit)}</span>
                          </div>
                        )) : <span style={{ color: 'var(--text-muted)', fontSize: '0.5rem', textAlign: 'center' }}>-</span>}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', padding: '0.2rem', background: yearData.yearlyTop3.length > 0 ? 'linear-gradient(135deg, rgba(251, 191, 36, 0.1), rgba(251, 191, 36, 0.05))' : 'transparent', borderRadius: '4px', border: yearData.yearlyTop3.length > 0 ? '1px solid rgba(251, 191, 36, 0.15)' : 'none' }}>
                        {yearData.yearlyTop3.length > 0 ? yearData.yearlyTop3.map((player, idx) => (
                          <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: '0.2rem', justifyContent: 'center' }}>
                            <span style={{ fontSize: '0.6rem' }}>{idx === 0 ? '🏆' : idx === 1 ? '🥈' : '🥉'}</span>
                            <span style={{ fontWeight: idx === 0 ? '700' : '400', color: identityName && player.playerName === identityName ? ME_NAME_COLOR : (idx === 0 ? '#fbbf24' : 'var(--text)'), fontSize: idx === 0 ? '0.58rem' : '0.52rem' }}>{player.playerName}</span>
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
                    {isSharingHallOfFame ? t('common.capturing') : t('common.share')}
                  </button>
                </div>
              )}

              {/* Top 20 Single Night Wins - ALL TIME */}
              {top20WinsAllTime.length > 0 && (
                <div ref={top20Ref} className="card" style={{ padding: '0.5rem', marginBottom: '1rem' }}>
                  <div style={{ textAlign: 'center', fontSize: '0.85rem', fontWeight: '600', color: 'var(--text)', marginBottom: '0.5rem' }}>
                    {t('stats.top20')}
                  </div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '0.35rem' }}>{t('stats.allTimeLabel')}</div>
                  <table style={{ width: '100%', fontSize: '0.7rem', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border)' }}>
                        <th style={{ textAlign: isRTL ? 'right' : 'left', padding: '0.25rem 0.2rem' }}>{t('stats.rankCol')}</th>
                        <th style={{ textAlign: isRTL ? 'right' : 'left', padding: '0.25rem 0.2rem' }}>{t('stats.playerCol')}</th>
                        <th style={{ textAlign: 'right', padding: '0.25rem 0.2rem' }}>{t('stats.profitCol')}</th>
                        <th style={{ textAlign: 'center', padding: '0.25rem 0.2rem' }}>{t('stats.dateCol')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {top20WinsAllTime.map((entry, idx) => {
                        const isMe = identityName && entry.playerName === identityName;
                        return (
                        <tr 
                          key={idx}
                          style={{ borderBottom: '1px solid rgba(255,255,255,0.03)', cursor: 'pointer', ...(isMe ? meRowStyle : {}) }}
                          onClick={() => navigate(`/game/${entry.gameId}`, { state: { from: 'statistics', viewMode: 'records', timePeriod, selectedYear, selectedMonth } })}
                        >
                          <td style={{ padding: '0.3rem 0.2rem', whiteSpace: 'nowrap', textAlign: isRTL ? 'right' : 'left' }}>{idx + 1}{idx < 3 ? ` ${['🥇', '🥈', '🥉'][idx]}` : ''}</td>
                          <td style={{ padding: '0.3rem 0.2rem', fontWeight: '500', textAlign: isRTL ? 'right' : 'left', ...(isMe ? meNameStyle : {}) }}>{entry.playerName}</td>
                          <td style={{ padding: '0.3rem 0.2rem', textAlign: 'right', color: 'var(--success)', fontWeight: '600' }}>{'\u200E'}+{formatCurrency(entry.profit)}</td>
                          <td style={{ padding: '0.3rem 0.2rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.65rem' }}>{new Date(entry.date).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' })}</td>
                        </tr>
                        );
                      })}
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
                    {isSharingTop20 ? t('common.capturing') : t('common.share')}
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
                {t('stats.personalRecords')} ({getTimeframeLabel()})
              </div>

              {/* Current Streaks */}
              <div className="card">
                <h2 className="card-title mb-2">{t('stats.currentStreaks')}</h2>
                <div className="grid grid-2">
                  <div style={{ 
                    padding: '0.75rem', 
                    background: 'linear-gradient(135deg, rgba(249, 115, 22, 0.2), rgba(239, 68, 68, 0.1))',
                    borderRadius: '12px',
                    border: '1px solid rgba(249, 115, 22, 0.3)'
                  }}>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.3rem' }}>{t('stats.onFire')}</div>
                    {records.onFirePlayers.length > 0 ? (
                      renderRecord(
                        'onFire',
                        records.onFirePlayers,
                        (p) => <span style={{ fontSize: '0.85rem', color: 'var(--success)', whiteSpace: 'nowrap' }}>{t('graphs.winsCount', { n: p.currentStreak })}</span>,
                        { fontSize: '1rem', color: '#f97316' },
                        'currentWinStreak',
                        t('stats.recordCurrentStreak')
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
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.3rem' }}>{t('stats.coldStreak')}</div>
                    {records.iceColdPlayers.length > 0 ? (
                      renderRecord(
                        'iceCold',
                        records.iceColdPlayers,
                        (p) => <span style={{ fontSize: '0.85rem', color: 'var(--danger)', whiteSpace: 'nowrap' }}>{t('stats.nLosses', { n: Math.abs(p.currentStreak) })}</span>,
                        { fontSize: '1rem', color: '#ef4444' },
                        'currentLossStreak',
                        t('stats.recordCurrentLossStreak')
                      )
                    ) : (
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>-</div>
                    )}
                  </div>
                </div>
              </div>

              {/* All-Time Leaders */}
              <div className="card">
                <h2 className="card-title mb-2">{t('stats.leaders')}</h2>
                <div className="grid grid-2">
                  <div style={{ padding: '0.75rem', background: 'rgba(34, 197, 94, 0.1)', borderRadius: '8px', textAlign: 'center' }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('stats.topEarner')}</div>
                    {renderRecord(
                      'leader',
                      records.leaders,
                      (p) => <div className="profit" style={{ fontWeight: '700' }}>{'\u200E'}+{formatCurrency(p.totalProfit)}</div>,
                      undefined,
                      'all',
                      t('stats.recordAllGamesWin')
                    )}
                  </div>
                  <div style={{ padding: '0.75rem', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '8px', textAlign: 'center' }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('stats.biggestLoser')}</div>
                    {renderRecord(
                      'biggestLoser',
                      records.biggestLosers,
                      (p) => <div className="loss" style={{ fontWeight: '700' }}>{formatCurrency(p.totalProfit)}</div>,
                      undefined,
                      'all',
                      t('stats.recordAllGamesLoss')
                    )}
                  </div>
                </div>
              </div>

              {/* Single Game Records */}
              <div className="card">
                <h2 className="card-title mb-2">{t('stats.singleGameRecords')}</h2>
                <div className="grid grid-2">
                  <div style={{ padding: '0.75rem', background: 'rgba(34, 197, 94, 0.1)', borderRadius: '8px', textAlign: 'center' }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('stats.biggestWinRecord')}</div>
                    {renderRecord(
                      'biggestWin',
                      records.biggestWinPlayers,
                      (p) => <div className="profit" style={{ fontWeight: '700' }}>{'\u200E'}+{formatCurrency(p.biggestWin)}</div>,
                      undefined,
                      'biggestWin',
                      t('stats.recordBiggestWin')
                    )}
                  </div>
                  <div style={{ padding: '0.75rem', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '8px', textAlign: 'center' }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('stats.biggestLossRecord')}</div>
                    {renderRecord(
                      'biggestLoss',
                      records.biggestLossPlayers,
                      (p) => <div className="loss" style={{ fontWeight: '700' }}>{formatCurrency(p.biggestLoss)}</div>,
                      undefined,
                      'biggestLoss',
                      t('stats.recordBiggestLoss')
                    )}
                  </div>
                </div>
              </div>

              {/* Streak Records - only show if there are meaningful streaks */}
              {(records.longestWinStreakPlayers[0]?.longestWinStreak > 1 || records.longestLossStreakPlayers[0]?.longestLossStreak > 1) && (
                <div className="card">
                  <h2 className="card-title mb-2">{t('stats.streakRecords')}</h2>
                  <div className="grid grid-2">
                    {records.longestWinStreakPlayers[0]?.longestWinStreak > 1 && (
                      <div style={{ padding: '0.75rem', background: 'rgba(34, 197, 94, 0.1)', borderRadius: '8px', textAlign: 'center' }}>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('stats.longestWinRecord')}</div>
                        {renderRecord(
                          'longestWinStreak',
                          records.longestWinStreakPlayers.filter(p => p.longestWinStreak > 1),
                          (p) => <div style={{ color: 'var(--success)', fontWeight: '700' }}>{t('graphs.winsCount', { n: p.longestWinStreak })}</div>,
                          undefined,
                          'longestWinStreak',
                          t('stats.recordLongestWinStreak')
                        )}
                      </div>
                    )}
                    {records.longestLossStreakPlayers[0]?.longestLossStreak > 1 && (
                      <div style={{ padding: '0.75rem', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '8px', textAlign: 'center' }}>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('stats.longestLossRecord')}</div>
                        {renderRecord(
                          'longestLossStreak',
                          records.longestLossStreakPlayers.filter(p => p.longestLossStreak > 1),
                          (p) => <div style={{ color: 'var(--danger)', fontWeight: '700' }}>{t('stats.nLosses', { n: p.longestLossStreak })}</div>,
                          undefined,
                          'longestLossStreak',
                          t('stats.recordLongestLossStreak')
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Average Performance Records */}
              {(records.highestAvgProfits.length > 0 || records.lowestAvgProfits.length > 0) && (
                <div className="card">
                  <h2 className="card-title mb-2">{t('stats.averagePerf')}</h2>
                  <div className="grid grid-2">
                    {records.highestAvgProfits.length > 0 && (
                      <div style={{ padding: '0.75rem', background: 'rgba(34, 197, 94, 0.1)', borderRadius: '8px', textAlign: 'center' }}>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('stats.bestAvg')}</div>
                        {renderRecord(
                          'highestAvgProfit',
                          records.highestAvgProfits,
                          (p) => <div className="profit" style={{ fontWeight: '700' }}>{p.avgProfit >= 0 ? '\u200E+' : ''}{formatCurrency(p.avgProfit)}</div>,
                          undefined,
                          'all',
                          t('stats.recordBestAvg')
                        )}
                      </div>
                    )}
                    {records.lowestAvgProfits.length > 0 && (
                      <div style={{ padding: '0.75rem', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '8px', textAlign: 'center' }}>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('stats.worstAvg')}</div>
                        {renderRecord(
                          'lowestAvgProfit',
                          records.lowestAvgProfits,
                          (p) => <div className="loss" style={{ fontWeight: '700' }}>{formatCurrency(p.avgProfit)}</div>,
                          undefined,
                          'all',
                          t('stats.recordWorstAvg')
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Other Records */}
              <div className="card">
                <h2 className="card-title mb-2">{t('stats.otherRecords')}</h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ color: 'var(--text-muted)' }}>{t('stats.mostGames')}</span>
                    {renderRecord(
                      'mostGames',
                      records.mostDedicatedPlayers,
                      (p) => <span style={{ fontWeight: '600' }}>({p.gamesPlayed})</span>,
                      undefined,
                      'all',
                      t('stats.recordAllGames')
                    )}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ color: 'var(--text-muted)' }}>{t('stats.mostWins')}</span>
                    {renderRecord(
                      'mostWins',
                      records.mostWinsPlayers,
                      (p) => <span style={{ fontWeight: '600', color: 'var(--success)' }}>({p.winCount})</span>,
                      undefined,
                      'wins',
                        t('stats.recordWins')
                    )}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ color: 'var(--text-muted)' }}>{t('stats.mostLosses')}</span>
                    {renderRecord(
                      'mostLosses',
                      records.mostLossesPlayers,
                      (p) => <span style={{ fontWeight: '600', color: 'var(--danger)' }}>({p.lossCount})</span>,
                      undefined,
                      'losses',
                      t('stats.recordLosses')
                    )}
                  </div>
                  {records.sharpshooters.length > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                      <span style={{ color: 'var(--text-muted)' }}>{t('stats.bestWinRate')}</span>
                      {renderRecord(
                        'sharpshooter',
                        records.sharpshooters,
                        (p) => <span style={{ fontWeight: '600', color: 'var(--success)' }}>({p.winPercentage.toFixed(0)}%)</span>,
                        undefined,
                        'wins',
                        t('stats.recordWinRate')
                      )}
                    </div>
                  )}
                  {records.worstWinRates.length > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                      <span style={{ color: 'var(--text-muted)' }}>{t('stats.worstWinRate')}</span>
                      {renderRecord(
                        'worstWinRate',
                        records.worstWinRates,
                        (p) => <span style={{ fontWeight: '600', color: 'var(--danger)' }}>({p.winPercentage.toFixed(0)}%)</span>,
                        undefined,
                        'losses',
                        t('stats.recordLossRate')
                      )}
                    </div>
                  )}
                  {records.rebuyKings[0]?.totalRebuys > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                      <span style={{ color: 'var(--text-muted)' }}>{t('stats.buyinKing')}</span>
                      {renderRecord(
                        'rebuyKing',
                        records.rebuyKings.filter(p => p.totalRebuys > 0),
                        (p) => <span style={{ fontWeight: '600' }}>{t('stats.parenTotal', { n: p.totalRebuys })}</span>,
                        undefined,
                        'all',
                        t('stats.recordBuyins')
                      )}
                  </div>
                  )}
                  {records.avgBuyinKings[0]?.avgRebuysPerGame > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '0.5rem 0' }}>
                      <span style={{ color: 'var(--text-muted)' }}>{t('stats.avgBuyinKing')}</span>
                      {renderRecord(
                        'avgBuyinKing',
                        records.avgBuyinKings.filter(p => p.avgRebuysPerGame > 0),
                        (p) => <span style={{ fontWeight: '600' }}>{t('stats.parenAvg', { n: p.avgRebuysPerGame.toFixed(1) })}</span>,
                        undefined,
                        'all',
                        t('stats.recordAvgBuyins')
                      )}
                  </div>
                  )}
                </div>
              </div>
                </>
              )}
            </>
          )}

          {/* TABLE VIEW
              Card structure: outer .card carries `tableRef` so the
              shareable screenshot inherits the full card chrome
              (background, rounded corners, padding, shadow). The
              controls strip carries `tableControlsRef` and is
              hidden via `hideForCapture` only during snapshotting,
              so it stays visible to the live user but is excluded
              from the shared image. */}
          {viewMode === 'table' && (
            <>
              <div ref={tableRef} className="card" style={{ padding: '0.5rem' }}>
                {/* Single-row controls strip with `space-between`:
                    [sort] and [mode] anchor to the inline-start
                    (physical right in RTL), [active-toggle] anchors
                    to the inline-end (physical left in RTL). The 3
                    mode buttons used to live on a separate row;
                    collapsing them into a single <select> matches
                    the chrome of the sort dropdown and frees the row
                    to fit everything on mobile. */}
                <div ref={tableControlsRef} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.5rem', paddingBottom: '0.4rem', borderBottom: '1px solid var(--border)' }}>
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as 'profit' | 'games' | 'winRate')}
                    style={{
                      padding: '0.3rem 0.4rem',
                      fontSize: '0.7rem',
                      borderRadius: '6px',
                      border: '1px solid var(--border)',
                      background: 'var(--surface)',
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                    }}
                  >
                    <option value="profit" style={{ background: '#1a1a2e', color: '#ffffff' }}>{t('stats.sortProfit')}</option>
                    <option value="games" style={{ background: '#1a1a2e', color: '#ffffff' }}>{t('stats.sortGames')}</option>
                    <option value="winRate" style={{ background: '#1a1a2e', color: '#ffffff' }}>{t('stats.sortWinRate')}</option>
                  </select>
                  <select
                    value={tableMode}
                    onChange={(e) => setTableMode(e.target.value as 'profit' | 'gainLoss' | 'avgGainLoss')}
                    style={{
                      padding: '0.3rem 0.4rem',
                      fontSize: '0.7rem',
                      borderRadius: '6px',
                      border: '1px solid var(--border)',
                      background: 'var(--surface)',
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                    }}
                  >
                    <option value="profit" style={{ background: '#1a1a2e', color: '#ffffff' }}>{t('stats.modeProfit')}</option>
                    <option value="avgGainLoss" style={{ background: '#1a1a2e', color: '#ffffff' }}>{t('stats.avgGainLoss')}</option>
                    <option value="gainLoss" style={{ background: '#1a1a2e', color: '#ffffff' }}>{t('stats.gainLoss')}</option>
                  </select>
                  {renderActiveOverrideToggle('main')}
                </div>
                <div style={{ overflowX: 'auto' }}>
                {/* Timeframe row is plain text now — the active-only
                    toggle moved up into the controls strip beside the
                    sort dropdown, so the redundant
                    " • שחקנים פעילים" suffix was dropped. */}
                <div style={{
                  textAlign: 'center',
                  fontSize: '0.7rem',
                  color: 'var(--text-muted)',
                  marginBottom: '0.5rem',
                  paddingBottom: '0.3rem',
                  borderBottom: '1px solid var(--border)',
                }}>
                  📊 {getTimeframeLabel()}
                  {' • '}{t('stats.gamesCount', { count: totalGamesInPeriod })}
                </div>
                <table style={{ width: '100%', fontSize: '0.8rem', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                <thead>
                  <tr>
                      <th style={{ padding: '0.3rem 0.2rem', whiteSpace: 'nowrap', width: '32px', textAlign: isRTL ? 'right' : 'left' }}>{t('stats.rankCol')}</th>
                      <th style={{ padding: '0.3rem 0.2rem', whiteSpace: 'nowrap', textAlign: isRTL ? 'right' : 'left' }}>{t('stats.playerCol')}</th>
                      {tableMode === 'profit' ? (
                        <>
                          <th style={{ textAlign: 'right', padding: '0.3rem 0.4rem', whiteSpace: 'nowrap', width: '20%' }}>{t('stats.profitCol')}</th>
                          <th style={{ textAlign: 'right', padding: '0.3rem 0.4rem', whiteSpace: 'nowrap', width: '14%' }}>{t('stats.avgCol')}</th>
                        </>
                      ) : tableMode === 'gainLoss' ? (
                        <>
                          <th style={{ textAlign: 'right', padding: '0.3rem 0.3rem', whiteSpace: 'nowrap', width: '17%', color: 'var(--success)' }}>{t('stats.gainCol')}</th>
                          <th style={{ textAlign: 'right', padding: '0.3rem 0.3rem', whiteSpace: 'nowrap', width: '17%', color: 'var(--danger)' }}>{t('stats.lossCol')}</th>
                        </>
                      ) : (
                        <>
                          <th style={{ textAlign: 'right', padding: '0.3rem 0.3rem', whiteSpace: 'nowrap', width: '17%', color: 'var(--success)' }}>{t('stats.avgWinCol')}</th>
                          <th style={{ textAlign: 'right', padding: '0.3rem 0.3rem', whiteSpace: 'nowrap', width: '17%', color: 'var(--danger)' }}>{t('stats.avgLossCol')}</th>
                        </>
                      )}
                      <th style={{ textAlign: 'center', padding: '0.3rem 0.3rem', whiteSpace: 'nowrap', width: '10%' }}>{t('stats.gamesCol')}</th>
                      <th style={{ textAlign: 'center', padding: '0.3rem 0.2rem', whiteSpace: 'nowrap', width: '11%' }}>{t('stats.winRateCol')}</th>
                  </tr>
                </thead>
                <tbody>
                  {mainTableSortedStats.map((player, index) => {
                    const currentRank = index + 1;
                    const prevRank = previousRankings.get(player.playerId);
                    const movement = prevRank ? prevRank - currentRank : 0; // positive = moved up
                    const isMe = identityName && player.playerName === identityName;
                    
                    return (
                      <tr 
                        key={player.playerId}
                        onClick={() => showPlayerGames(player)}
                        style={{
                          cursor: 'pointer',
                          ...(isMe ? meRowStyle : {}),
                          animation: index < 15 ? 'contentFadeIn 0.25s ease-out backwards' : undefined,
                          animationDelay: index < 15 ? `${index * 0.03}s` : undefined,
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.background = isMe ? 'rgba(59, 130, 246, 0.22)' : 'var(--surface)'}
                        onMouseLeave={(e) => e.currentTarget.style.background = isMe ? ME_BG : ''}
                      >
                        <td style={{ padding: '0.3rem 0.2rem', whiteSpace: 'nowrap', width: '40px', textAlign: isRTL ? 'right' : 'left' }}>
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
                        <td style={{ fontWeight: '600', padding: '0.3rem 0.2rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textAlign: isRTL ? 'right' : 'left', fontSize: getNameFontSize(player.playerName, 0.8), ...(isMe ? meNameStyle : {}) }}>
                          {player.playerName}
                      </td>
                        {tableMode === 'profit' ? (
                          <>
                            <td style={{ textAlign: 'right', fontWeight: '700', padding: '0.3rem 0.4rem', whiteSpace: 'nowrap' }} className={getProfitColor(player.totalProfit)}>
                              {player.totalProfit >= 0 ? '\u200E+' : '\u200E-'}{cleanNumber(Math.abs(player.totalProfit))}
                            </td>
                            <td style={{ textAlign: 'right', padding: '0.3rem 0.4rem', whiteSpace: 'nowrap' }} className={getProfitColor(player.avgProfit)}>
                              {player.avgProfit >= 0 ? '\u200E+' : '\u200E-'}{cleanNumber(Math.abs(player.avgProfit))}
                            </td>
                          </>
                        ) : tableMode === 'gainLoss' ? (
                          <>
                            <td style={{ textAlign: 'right', fontWeight: '600', padding: '0.3rem 0.3rem', whiteSpace: 'nowrap', color: 'var(--success)' }}>
                              {'\u200E'}+{cleanNumber(player.totalGains)}
                            </td>
                            <td style={{ textAlign: 'right', fontWeight: '600', padding: '0.3rem 0.3rem', whiteSpace: 'nowrap', color: 'var(--danger)' }}>
                              {'\u200E'}-{cleanNumber(player.totalLosses)}
                            </td>
                          </>
                        ) : (
                          <>
                            <td style={{ textAlign: 'right', fontWeight: '600', padding: '0.3rem 0.3rem', whiteSpace: 'nowrap', color: 'var(--success)' }}>
                              {player.avgWin > 0 ? `\u200E+${cleanNumber(player.avgWin)}` : '-'}
                            </td>
                            <td style={{ textAlign: 'right', fontWeight: '600', padding: '0.3rem 0.3rem', whiteSpace: 'nowrap', color: 'var(--danger)' }}>
                              {player.avgLoss > 0 ? `\u200E-${cleanNumber(player.avgLoss)}` : '-'}
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
                  {isSharing ? t('common.capturing') : t('common.share')}
                </button>
              </div>

              {/* Podium Rate Stats — 1st/2nd/3rd-place rates per player (period-scoped) */}
              {/* Card structure: outer .card carries `podiumRatesRef`
                  so the screenshot inherits full card chrome. The
                  sort-dropdown strip carries `podiumControlsRef`
                  and is hidden via `hideForCapture` only during
                  snapshotting — visible to live users, excluded
                  from the shared image. */}
              {podiumTableRows.length > 0 && (
                <div ref={podiumRatesRef} className="card" style={{ padding: '0.5rem', marginTop: '1rem' }}>
                  <div ref={podiumControlsRef} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.45rem', paddingBottom: '0.4rem', borderBottom: '1px solid var(--border)' }}>
                    <select
                      value={podiumSort}
                      onChange={(e) => setPodiumSort(e.target.value as 'total' | 'first' | 'second' | 'third' | 'games')}
                      style={{
                        padding: '0.25rem 0.4rem',
                        fontSize: '0.7rem',
                        borderRadius: '6px',
                        border: '1px solid var(--border)',
                        background: 'var(--surface)',
                        color: 'var(--text-muted)',
                        cursor: 'pointer',
                      }}
                    >
                      <option value="total" style={{ background: '#1a1a2e', color: '#ffffff' }}>{t('stats.podiumSort.total')}</option>
                      <option value="first" style={{ background: '#1a1a2e', color: '#ffffff' }}>{t('stats.podiumSort.first')}</option>
                      <option value="second" style={{ background: '#1a1a2e', color: '#ffffff' }}>{t('stats.podiumSort.second')}</option>
                      <option value="third" style={{ background: '#1a1a2e', color: '#ffffff' }}>{t('stats.podiumSort.third')}</option>
                      <option value="games" style={{ background: '#1a1a2e', color: '#ffffff' }}>{t('stats.podiumSort.games')}</option>
                    </select>
                    {renderActiveOverrideToggle('podium')}
                  </div>
                  <div style={{ textAlign: 'center', fontSize: '0.85rem', fontWeight: '600', color: 'var(--text)', marginBottom: '0.5rem' }}>
                    {t('stats.podiumRates')}
                  </div>
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>{getTimeframeLabel()}</div>
                  {/* Horizontal-scroll fallback is scoped to just the
                      <table>, not the whole card. Wrapping title +
                      footer + table together caused a phantom
                      horizontal scrollbar on mobile from sub-pixel
                      rounding even when everything fit. With the
                      wrapper around only the table, the card's title
                      and footer note flow naturally; the table still
                      scrolls within its own little box if a future
                      long player name pushes it wider than the viewport. */}
                  <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', fontSize: '0.7rem', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border)' }}>
                        <th style={{ textAlign: isRTL ? 'right' : 'left', padding: '0.25rem 0.2rem' }}>{t('stats.rankCol')}</th>
                        <th style={{ textAlign: isRTL ? 'right' : 'left', padding: '0.25rem 0.2rem', whiteSpace: 'nowrap' }}>{t('stats.playerCol')}</th>
                        <th style={{ textAlign: 'center', padding: '0.25rem 0.2rem', whiteSpace: 'nowrap' }} title={t('stats.gamesCol')}>{t('stats.gamesCol')}</th>
                        <th style={{ textAlign: 'center', padding: '0.25rem 0.2rem' }}>🥇</th>
                        <th style={{ textAlign: 'center', padding: '0.25rem 0.2rem' }}>🥈</th>
                        <th style={{ textAlign: 'center', padding: '0.25rem 0.2rem' }}>🥉</th>
                        <th style={{ textAlign: 'center', padding: '0.25rem 0.2rem', whiteSpace: 'nowrap', borderInlineStart: '1px solid rgba(255,255,255,0.06)' }} title={t('stats.podiumTotalCol')}>{t('stats.podiumTotalCol')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {podiumTableRows.map((row, index) => {
                        const isMe = identityName && row.playerName === identityName;
                        const renderCell = (count: number, rate: number, isTotal = false) => (
                          <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: '0.15rem', whiteSpace: 'nowrap' }}>
                            <span style={{ fontWeight: isTotal ? 700 : 600, color: isTotal ? 'var(--text)' : undefined }}>{Math.round(rate)}%</span>
                            <span style={{ color: 'var(--text-muted)', fontSize: '0.6rem' }}>({count})</span>
                          </span>
                        );
                        // Rank-medal value follows the active sort:
                        // sort by 🥇 → medal reflects gold count, etc.
                        const medalValue =
                          podiumSort === 'first' ? row.firsts :
                          podiumSort === 'second' ? row.seconds :
                          podiumSort === 'third' ? row.thirds :
                          podiumSort === 'games' ? row.games :
                          row.totalPodiums;
                        return (
                          <tr
                            key={row.playerName}
                            style={{ borderBottom: '1px solid rgba(255,255,255,0.03)', ...(isMe ? meRowStyle : {}) }}
                          >
                            <td style={{ padding: '0.3rem 0.2rem', whiteSpace: 'nowrap', textAlign: isRTL ? 'right' : 'left' }}>
                              {index + 1}{getMedal(index, medalValue)}
                            </td>
                            <td style={{
                              padding: '0.3rem 0.2rem',
                              whiteSpace: 'nowrap',
                              fontWeight: '500',
                              textAlign: isRTL ? 'right' : 'left',
                              ...(isMe ? meNameStyle : {})
                            }}>
                              {row.playerName}
                            </td>
                            <td style={{ textAlign: 'center', padding: '0.3rem 0.2rem', color: 'var(--text-muted)' }}>
                              {row.games}
                            </td>
                            <td style={{ textAlign: 'center', padding: '0.3rem 0.2rem' }}>
                              {renderCell(row.firsts, row.firstRate)}
                            </td>
                            <td style={{ textAlign: 'center', padding: '0.3rem 0.2rem' }}>
                              {renderCell(row.seconds, row.secondRate)}
                            </td>
                            <td style={{ textAlign: 'center', padding: '0.3rem 0.2rem' }}>
                              {renderCell(row.thirds, row.thirdRate)}
                            </td>
                            <td style={{ textAlign: 'center', padding: '0.3rem 0.2rem', borderInlineStart: '1px solid rgba(255,255,255,0.06)' }}>
                              {renderCell(row.totalPodiums, row.totalRate, true)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  </div>
                  <div style={{
                    fontSize: '0.6rem',
                    color: 'var(--text-muted)',
                    marginTop: '0.5rem',
                    paddingTop: '0.4rem',
                    borderTop: '1px solid rgba(255,255,255,0.06)',
                    opacity: 0.75,
                    fontStyle: 'italic',
                    lineHeight: 1.5,
                  }}>
                    {t('stats.podiumRatesNote')}
                  </div>
                </div>
              )}
              {podiumTableRows.length > 0 && (
                <div style={{ display: 'flex', justifyContent: 'center', marginTop: '0.5rem', marginBottom: '0.5rem' }}>
                  <button
                    onClick={handleSharePodiumRates}
                    disabled={isSharingPodiumRates}
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
                    {isSharingPodiumRates ? t('common.capturing') : t('common.share')}
                  </button>
                </div>
              )}

              {/* Top 10 Single Night Wins - Filtered by period
                  Title sits clean and centered. The toggle is on the
                  timeframe row underneath: absolute-positioned at the
                  physical left edge (`left: 0` works in both LTR/RTL),
                  with the timeframe text getting paddingLeft so the
                  two never collide. Wrapped in `top10ActiveToggleRef`
                  for `hideForCapture` on share. */}
              {top10TableData.length > 0 && (
                <div ref={top10Ref} className="card" style={{ padding: '0.5rem', marginTop: '0.5rem' }}>
                  <div style={{ textAlign: 'center', fontSize: '0.85rem', fontWeight: '600', color: 'var(--text)', marginBottom: '0.5rem' }}>
                    {t('stats.top10')}
                  </div>
                  <div style={{ position: 'relative', fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '0.35rem', minHeight: '22px', paddingLeft: '72px', display: 'flex', alignItems: 'center' }}>
                    <div ref={top10ActiveToggleRef} style={{ position: 'absolute', left: 0, top: 0 }}>
                      {renderActiveOverrideToggle('top10')}
                    </div>
                    {getTimeframeLabel()}
                  </div>
                  <table style={{ width: '100%', fontSize: '0.7rem', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border)' }}>
                        <th style={{ textAlign: isRTL ? 'right' : 'left', padding: '0.25rem 0.2rem' }}>{t('stats.rankCol')}</th>
                        <th style={{ textAlign: isRTL ? 'right' : 'left', padding: '0.25rem 0.2rem' }}>{t('stats.playerCol')}</th>
                        <th style={{ textAlign: 'right', padding: '0.25rem 0.2rem' }}>{t('stats.profitCol')}</th>
                        <th style={{ textAlign: 'center', padding: '0.25rem 0.2rem' }}>{t('stats.dateCol')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {top10TableData.map((entry, idx) => {
                        const isMe = identityName && entry.playerName === identityName;
                        return (
                        <tr 
                          key={idx}
                          style={{ borderBottom: '1px solid rgba(255,255,255,0.03)', cursor: 'pointer', ...(isMe ? meRowStyle : {}) }}
                          onClick={() => navigate(`/game/${entry.gameId}`, { state: { from: 'statistics', viewMode: 'table', timePeriod, selectedYear, selectedMonth } })}
                        >
                          <td style={{ padding: '0.3rem 0.2rem', whiteSpace: 'nowrap', textAlign: isRTL ? 'right' : 'left' }}>{idx + 1}{idx < 3 ? ` ${['🥇', '🥈', '🥉'][idx]}` : ''}</td>
                          <td style={{ padding: '0.3rem 0.2rem', fontWeight: '500', textAlign: isRTL ? 'right' : 'left', ...(isMe ? meNameStyle : {}) }}>{entry.playerName}</td>
                          <td style={{ padding: '0.3rem 0.2rem', textAlign: 'right', color: 'var(--success)', fontWeight: '600' }}>{'\u200E'}+{formatCurrency(entry.profit)}</td>
                          <td style={{ padding: '0.3rem 0.2rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.65rem' }}>{new Date(entry.date).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' })}</td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {top10TableData.length > 0 && (
                <div style={{ display: 'flex', justifyContent: 'center', marginTop: '0.5rem', marginBottom: '0.5rem' }}>
                  <button
                    onClick={handleShareTop10}
                    disabled={isSharingTop10}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem', fontSize: '0.75rem', padding: '0.4rem 0.8rem', background: 'var(--surface)', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: '6px', cursor: 'pointer' }}
                  >
                    {isSharingTop10 ? t('common.capturing') : t('common.share')}
                  </button>
                </div>
              )}

              {/* Rebuy Stats Table — title stays clean & centered;
                  toggle lives on the timeframe row, pinned to physical
                  left via absolute positioning (same pattern as top 10). */}
              {rebuyTableData.length > 0 && (
                <div ref={rebuyStatsRef} className="card" style={{ padding: '0.5rem', marginTop: '1rem' }}>
                  <div style={{ textAlign: 'center', fontSize: '0.85rem', fontWeight: '600', color: 'var(--text)', marginBottom: '0.5rem' }}>
                    {t('stats.rebuyStats')}
                  </div>
                  <div style={{ position: 'relative', fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '0.35rem', minHeight: '22px', paddingLeft: '72px', display: 'flex', alignItems: 'center' }}>
                    <div ref={rebuyActiveToggleRef} style={{ position: 'absolute', left: 0, top: 0 }}>
                      {renderActiveOverrideToggle('rebuy')}
                    </div>
                    {getTimeframeLabel()}
                  </div>
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
                      {t('stats.rebuyWarning', { missing: rebuyDataCoverage.gamesWithoutRebuys, total: rebuyDataCoverage.totalGames })}
                    </div>
                  )}
                  <table style={{ width: '100%', fontSize: '0.7rem', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border)' }}>
                        <th style={{ textAlign: isRTL ? 'right' : 'left', padding: '0.25rem 0.2rem' }}>{t('stats.rankCol')}</th>
                        <th style={{ textAlign: isRTL ? 'right' : 'left', padding: '0.25rem 0.2rem', whiteSpace: 'nowrap' }}>{t('stats.playerCol')}</th>
                        <th style={{ textAlign: 'center', padding: '0.25rem 0.2rem', whiteSpace: 'nowrap' }} title={t('stats.rebuyAvg')}>{t('stats.rebuyAvg')}</th>
                        <th style={{ textAlign: 'center', padding: '0.25rem 0.2rem', whiteSpace: 'nowrap' }} title={t('stats.rebuyTotal')}>{t('stats.rebuyTotal')}</th>
                        <th style={{ textAlign: 'center', padding: '0.25rem 0.2rem', whiteSpace: 'nowrap' }} title={t('stats.rebuyMax')}>{t('stats.rebuyMax')}</th>
                        <th style={{ textAlign: 'center', padding: '0.25rem 0.2rem', whiteSpace: 'nowrap' }} title={t('stats.gamesCol')}>{t('stats.gamesCol')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rebuyTableData.map((player, index) => {
                        const avgBuyins = player.totalBuyins / player.gamesPlayed;
                        const isMe = identityName && player.playerName === identityName;
                        return (
                          <tr 
                            key={index}
                            style={{ borderBottom: '1px solid rgba(255,255,255,0.03)', ...(isMe ? meRowStyle : {}) }}
                          >
                            <td style={{ padding: '0.3rem 0.2rem', whiteSpace: 'nowrap', textAlign: isRTL ? 'right' : 'left' }}>
                              {index + 1}
                            </td>
                            <td style={{ 
                              padding: '0.3rem 0.2rem', 
                              whiteSpace: 'nowrap',
                              fontWeight: '500',
                              textAlign: isRTL ? 'right' : 'left',
                              ...(isMe ? meNameStyle : {})
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
              {rebuyTableData.length > 0 && (
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
                    {isSharingRebuyStats ? t('common.capturing') : t('common.share')}
                  </button>
                </div>
              )}

              {/* Average Placement Table — driven by the same period
                  + active-only + selected-players filters as every
                  other table on this screen. Lower avg = better
                  finishes. Toggle pinned top-left of the title row,
                  same chrome pattern as top10/rebuy. */}
              {avgPlacementTableRows.length > 0 && (
                <div ref={avgPlacementRef} className="card" style={{ padding: '0.5rem', marginTop: '1rem' }}>
                  <div style={{ textAlign: 'center', fontSize: '0.85rem', fontWeight: '600', color: 'var(--text)', marginBottom: '0.35rem' }}>
                    {t('stats.avgPlacement')}
                  </div>
                  <div style={{ position: 'relative', minHeight: '22px', marginBottom: '0.35rem' }}>
                    <div ref={avgPlacementActiveToggleRef} style={{ position: 'absolute', left: 0, top: 0 }}>
                      {renderActiveOverrideToggle('avgPlacement')}
                    </div>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', lineHeight: '22px', paddingLeft: '72px' }}>{getTimeframeLabel()}</div>
                  </div>
                  <table style={{ width: '100%', fontSize: '0.7rem', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border)' }}>
                        <th style={{ textAlign: isRTL ? 'right' : 'left', padding: '0.25rem 0.2rem' }}>{t('stats.rankCol')}</th>
                        <th style={{ textAlign: isRTL ? 'right' : 'left', padding: '0.25rem 0.2rem', whiteSpace: 'nowrap' }}>{t('stats.playerCol')}</th>
                        <th style={{ textAlign: 'center', padding: '0.25rem 0.2rem', whiteSpace: 'nowrap' }} title={t('stats.avgPlacementCol')}>{t('stats.avgPlacementCol')}</th>
                        <th style={{ textAlign: 'center', padding: '0.25rem 0.2rem', whiteSpace: 'nowrap' }} title={t('stats.bestPlacementCol')}>{t('stats.bestPlacementCol')}</th>
                        <th style={{ textAlign: 'center', padding: '0.25rem 0.2rem', whiteSpace: 'nowrap' }} title={t('stats.worstPlacementCol')}>{t('stats.worstPlacementCol')}</th>
                        <th style={{ textAlign: 'center', padding: '0.25rem 0.2rem', whiteSpace: 'nowrap' }} title={t('stats.gamesCol')}>{t('stats.gamesCol')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {avgPlacementTableRows.map((row, index) => {
                        const isMe = identityName && row.playerName === identityName;
                        const formatRank = (r: number) => Number.isInteger(r) ? String(r) : r.toFixed(1);
                        return (
                          <tr key={index} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)', ...(isMe ? meRowStyle : {}) }}>
                            <td style={{ padding: '0.3rem 0.2rem', whiteSpace: 'nowrap', textAlign: isRTL ? 'right' : 'left' }}>
                              {index + 1}{index < 3 ? ` ${['🥇', '🥈', '🥉'][index]}` : ''}
                            </td>
                            <td style={{
                              padding: '0.3rem 0.2rem',
                              whiteSpace: 'nowrap',
                              fontWeight: '500',
                              textAlign: isRTL ? 'right' : 'left',
                              fontSize: getNameFontSize(row.playerName, 0.7),
                              ...(isMe ? meNameStyle : {})
                            }}>
                              {row.playerName}
                            </td>
                            <td style={{ textAlign: 'center', padding: '0.3rem 0.2rem', fontWeight: '600' }}>
                              {row.avgRank.toFixed(2)}
                            </td>
                            <td style={{ textAlign: 'center', padding: '0.3rem 0.2rem', color: 'var(--success)' }}>
                              {formatRank(row.bestRank)}
                            </td>
                            <td style={{ textAlign: 'center', padding: '0.3rem 0.2rem', color: 'var(--text-muted)' }}>
                              {formatRank(row.worstRank)}
                            </td>
                            <td style={{ textAlign: 'center', padding: '0.3rem 0.2rem', color: 'var(--text-muted)' }}>
                              {row.games}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {avgPlacementTableRows.length > 0 && (
                <div style={{ display: 'flex', justifyContent: 'center', marginTop: '0.5rem', marginBottom: '0.5rem' }}>
                  <button
                    onClick={handleShareAvgPlacement}
                    disabled={isSharingAvgPlacement}
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
                    {isSharingAvgPlacement ? t('common.capturing') : t('common.share')}
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
                  {t('stats.playerStats')}
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
                  {t('stats.aiStories')}
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
                    {t('stats.playerStats')} ({getTimeframeLabel()})
                  </div>

                  {sortedStats.map((player, index) => {
                    const isMe = identityName && player.playerName === identityName;
                    return (
            <div key={player.playerId} id={`player-card-${player.playerId}`} className="card" style={{ transition: 'box-shadow 0.3s ease', ...(isMe ? { border: '1.5px solid #3b82f6', boxShadow: '0 0 8px rgba(59, 130, 246, 0.2)' } : {}), animation: index < 10 ? 'contentFadeIn 0.25s ease-out backwards' : undefined, animationDelay: index < 10 ? `${index * 0.05}s` : undefined }}>
              <div className="card-header">
                <h3 className="card-title" style={isMe ? meNameStyle : undefined}>
                  {player.playerName}
                  {getMedal(index, sortBy === 'profit' ? player.totalProfit : 
                    sortBy === 'games' ? player.gamesPlayed : player.winPercentage)}
                </h3>
                <span className={getProfitColor(player.totalProfit)} style={{ fontSize: '1.25rem', fontWeight: '700' }}>
                  {player.totalProfit >= 0 ? '\u200E+' : '\u200E-'}{formatCurrency(Math.abs(player.totalProfit))}
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
                    {player.currentStreak > 0
                      ? t('graphs.winsCount', { n: Math.abs(player.currentStreak) })
                      : t('stats.nLosses', { n: Math.abs(player.currentStreak) })}
                  </span>
                </div>
              )}

              {/* Last 6 Games */}
              {player.lastGameResults && player.lastGameResults.length > 0 && (
                <div style={{ marginBottom: '0.75rem' }}>
                  <div className="text-muted" style={{ fontSize: '0.7rem', marginBottom: '0.35rem' }}>{t('stats.lastGames', { n: Math.min(6, player.lastGameResults.length) })}</div>
                  <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'flex-start' }}>
                    {player.lastGameResults.slice(0, 6).reverse().map((game, i) => {
                      const gameDate = new Date(game.date);
                      const dateStr = gameDate.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: '2-digit' });
                      return (
                      <div 
                        key={i}
                          style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'pointer' }}
                          onClick={() => {
                            navigate(`/game/${game.gameId}`, { state: { from: 'players', viewMode: 'players', playerInfo: { playerId: player.playerId, playerName: player.playerName }, timePeriod, selectedYear, selectedMonth } });
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
                  onClick={() => showPlayerStatDetails(player, 'allGames', t('stats.allGamesModal'))}
                >
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>{t('stats.gamesPlayed')}</div>
                  <div className="stat-value">{player.gamesPlayed} <span style={{ color: 'var(--text-muted)' }}>❯</span></div>
                </div>
                <div className="stat-card" style={{ background: player.winPercentage >= 50 ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>{player.winPercentage >= 50 ? '📈' : '📉'} {t('stats.winRate')}</div>
                  <div className="stat-value" style={{ color: player.winPercentage >= 50 ? 'var(--success)' : 'var(--danger)' }}>
                    {player.winPercentage.toFixed(0)}%
                  </div>
                </div>
                <div 
                  className="stat-card" 
                  style={{ cursor: player.winCount > 0 ? 'pointer' : 'default', background: 'rgba(34, 197, 94, 0.1)' }}
                  onClick={() => player.winCount > 0 && showPlayerStatDetails(player, 'wins', t('stats.winsCount'))}
                >
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>{t('stats.winsCount')}</div>
                  <div className="stat-value" style={{ color: player.winCount > 0 ? 'var(--success)' : 'var(--text-muted)' }}>
                    {player.winCount}{player.winCount > 0 && <span style={{ color: 'var(--text-muted)' }}> ❯</span>}
                  </div>
                </div>
                <div 
                  className="stat-card" 
                  style={{ cursor: player.lossCount > 0 ? 'pointer' : 'default', background: 'rgba(239, 68, 68, 0.1)' }}
                  onClick={() => player.lossCount > 0 && showPlayerStatDetails(player, 'losses', t('stats.lossesCount'))}
                >
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>{t('stats.lossesCount')}</div>
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
                  onClick={() => player.biggestWin > 0 && showPlayerStatDetails(player, 'biggestWin', t('stats.biggestWin'))}
                >
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>{t('stats.biggestWin')}</div>
                  <div className="stat-value" style={{ color: 'var(--success)' }}>
                    {player.biggestWin > 0 ? `\u200E+${cleanNumber(player.biggestWin)}` : '-'}{player.biggestWin > 0 && <span style={{ color: 'var(--text-muted)' }}> ❯</span>}
                  </div>
                </div>
                <div 
                  className="stat-card" 
                  style={{ cursor: player.biggestLoss < 0 ? 'pointer' : 'default', background: 'rgba(239, 68, 68, 0.1)' }}
                  onClick={() => player.biggestLoss < 0 && showPlayerStatDetails(player, 'biggestLoss', t('stats.biggestLoss'))}
                >
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>{t('stats.biggestLoss')}</div>
                  <div className="stat-value" style={{ color: 'var(--danger)' }}>
                    {player.biggestLoss < 0 ? `\u200E-${cleanNumber(Math.abs(player.biggestLoss))}` : '-'}{player.biggestLoss < 0 && <span style={{ color: 'var(--text-muted)' }}> ❯</span>}
                  </div>
                </div>
              </div>

              {/* Streaks Row */}
              <div className="grid grid-2" style={{ marginBottom: '0.5rem' }}>
                <div 
                  className="stat-card" 
                  style={{ cursor: player.longestWinStreak > 0 ? 'pointer' : 'default', background: 'rgba(34, 197, 94, 0.1)' }}
                  onClick={() => player.longestWinStreak > 0 && showPlayerStatDetails(player, 'longestWinStreak', t('stats.longestWinStreak'))}
                >
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>{t('stats.longestWinStreak')}</div>
                  <div className="stat-value" style={{ color: player.longestWinStreak > 0 ? 'var(--success)' : 'var(--text-muted)' }}>
                    {player.longestWinStreak > 0 ? t('graphs.winsCount', { n: player.longestWinStreak }) : '-'}{player.longestWinStreak > 0 && <span style={{ color: 'var(--text-muted)' }}> ❯</span>}
                  </div>
                </div>
                <div 
                  className="stat-card" 
                  style={{ cursor: player.longestLossStreak > 0 ? 'pointer' : 'default', background: 'rgba(239, 68, 68, 0.1)' }}
                  onClick={() => player.longestLossStreak > 0 && showPlayerStatDetails(player, 'longestLossStreak', t('stats.longestLossStreak'))}
                >
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>{t('stats.longestLossStreak')}</div>
                  <div className="stat-value" style={{ color: player.longestLossStreak > 0 ? 'var(--danger)' : 'var(--text-muted)' }}>
                    {player.longestLossStreak > 0 ? t('stats.nLosses', { n: player.longestLossStreak }) : '-'}{player.longestLossStreak > 0 && <span style={{ color: 'var(--text-muted)' }}> ❯</span>}
                  </div>
                </div>
              </div>

              {/* Averages Row */}
              <div className="grid grid-2" style={{ marginBottom: '0.5rem' }}>
                <div className="stat-card" style={{ background: 'rgba(34, 197, 94, 0.1)' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>{t('stats.avgWin')}</div>
                  <div className="stat-value" style={{ color: player.avgWin > 0 ? 'var(--success)' : 'var(--text-muted)' }}>
                    {player.avgWin > 0 ? `\u200E+${cleanNumber(player.avgWin)}` : '-'}
                  </div>
                </div>
                <div className="stat-card" style={{ background: 'rgba(239, 68, 68, 0.1)' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>{t('stats.avgLoss')}</div>
                  <div className="stat-value" style={{ color: player.avgLoss > 0 ? 'var(--danger)' : 'var(--text-muted)' }}>
                    {player.avgLoss > 0 ? `\u200E-${cleanNumber(player.avgLoss)}` : '-'}
                  </div>
                </div>
              </div>

              {/* Additional Stats Row */}
              <div className="grid grid-2">
                <div className="stat-card" style={{ background: player.avgProfit >= 0 ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)' }}>
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>{player.avgProfit >= 0 ? '📈' : '📉'} {t('stats.avgPerGame')}</div>
                  <div className="stat-value" style={{ color: player.avgProfit >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                    {player.avgProfit >= 0 ? '\u200E+' : '\u200E-'}{cleanNumber(Math.abs(player.avgProfit))}
                  </div>
                </div>
                <div className="stat-card">
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>{t('stats.totalBuyins')}</div>
                  <div className="stat-value" style={{ color: 'var(--text)' }}>{player.totalRebuys}</div>
                </div>
                  </div>
                </div>
          );
          })}
                </>
              )}

              {/* AI Stories sub-tab content */}
              {playerSubTab === 'stories' && (
                <>
                  {/* Timeframe Header */}
                  <div className="card" style={{ padding: '0.75rem', textAlign: 'center' }}>
                    <span style={{ fontSize: '0.9rem', fontWeight: '600' }}>
                      {t('stats.aiStories')} — {getTimeframeLabel()}
                    </span>
                  </div>

          {/* Player Chronicle Section */}
          {(() => {
            // ===== DATA SETUP =====
            const isRebuyDataValid = timePeriod !== 'all' && (timePeriod === 'custom' ? (!customStartDate || new Date(customStartDate).getFullYear() >= 2026) : selectedYear >= 2026);
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
              dominator: { id: 'dominator', title: t('stats.archDominator'), icon: '👑', color: '#f59e0b' },
              shark:     { id: 'shark', title: t('stats.archShark'), icon: '🦈', color: '#3b82f6' },
              sniper:    { id: 'sniper', title: t('stats.archSniper'), icon: '🎯', color: '#14b8a6' },
              gambler:   { id: 'gambler', title: t('stats.archGambler'), icon: '🎰', color: '#ef4444' },
              rock:      { id: 'rock', title: t('stats.archRock'), icon: '🪨', color: '#64748b' },
              phoenix:   { id: 'phoenix', title: t('stats.archPhoenix'), icon: '🐦', color: '#a855f7' },
              streaker:  { id: 'streaker', title: t('stats.archStreaker'), icon: '⚡', color: '#f97316' },
              coaster:   { id: 'coaster', title: t('stats.archCoaster'), icon: '🎢', color: '#ec4899' },
              fighter:   { id: 'fighter', title: t('stats.archFighter'), icon: '⚔️', color: '#d97706' },
              newcomer:  { id: 'newcomer', title: t('stats.archNewcomer'), icon: '🌱', color: '#22c55e' },
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
                if (timePeriod === 'custom') return customEndDate ? new Date(customEndDate) < new Date() : false;
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

            // ===== AUTO-GENERATE AI STORIES (owner only) =====
            const periodKey = getChronicleKey();
            // Generation requires (1) owner role and (2) a working Gemini
            // path for this group — either a per-group key in settings or
            // the platform-owner env-var fallback. Without (2) the AI call
            // would 403 immediately, so don't bother firing — render the
            // friendly notice instead (see the keyMissing branch below).
            const hasAIKey = !!getGeminiApiKey();
            const canGenerateAI = isOwner && hasAIKey;
            const cached = getChronicleProfiles(periodKey);
            // Only auto-generate if there are games newer than the cached chronicle
            const hasNewData = latestGameDate && (!cached || latestGameDate.getTime() > new Date(cached.generatedAt).getTime());

            if (canGenerateAI && hasNewData && !chronicleLoading && !chronicleGenRef.current && totalPeriodGames > 0) {
              chronicleGenRef.current = true;
              const latestGD = latestGameDate as Date;

              const buildPayloadAndGenerate = async () => {
                setChronicleLoading(true);
                setChronicleError(null);
                setChronicleProxyDown(false);
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

                  const result = await withAITiming('chronicle', () => generatePlayerChronicle({
                    players: payloadPlayers,
                    periodLabel: getHebrewTimeframeLabel(),
                    totalPeriodGames,
                    isEarlyPeriod: totalPeriodGames <= 3,
                    milestones: computeMilestoneStrings(),
                  }));

                  const modelDisplay = getModelDisplayName(result.model);
                  const genTime = new Date().toISOString();
                  saveChronicleProfiles(periodKey, result.profiles, modelDisplay);
                  setChronicleStories(result.profiles);
                  setChronicleModelName(modelDisplay);
                  setChronicleGeneratedAt(genTime);

                } catch (err) {
                  console.error('Chronicle generation failed:', err);
                  const msg = err instanceof Error ? err.message : 'Generation failed';
                  // No-key isn't a failure — it's expected. Suppress the
                  // red error line; the keyMissing branch below already
                  // shows the friendly notice for owners.
                  if (msg.includes('NO_API_KEY') || msg.includes('aiKeyRequired')) {
                    setChronicleError(null);
                    setChronicleProxyDown(false);
                  } else if (msg.includes('AI_PROXY_UNAVAILABLE') || msg.includes('aiProxyUnavailable')) {
                    setChronicleError(null);
                    setChronicleProxyDown(true);
                  } else {
                    setChronicleError(msg);
                  }
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
              setChronicleProxyDown(false);
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

                const result = await withAITiming('chronicle', () => generatePlayerChronicle({
                  players: payloadPlayers,
                  periodLabel: getHebrewTimeframeLabel(),
                  totalPeriodGames,
                  isEarlyPeriod: totalPeriodGames <= 3,
                  milestones: computeMilestoneStrings(),
                }));

                const modelDisplay = getModelDisplayName(result.model);
                const genTime = new Date().toISOString();
                saveChronicleProfiles(periodKey, result.profiles, modelDisplay);
                setChronicleStories(result.profiles);
                setChronicleModelName(modelDisplay);
                setChronicleGeneratedAt(genTime);

              } catch (err) {
                console.error('Chronicle regeneration failed:', err);
                const msg = err instanceof Error ? err.message : 'Generation failed';
                if (msg.includes('NO_API_KEY') || msg.includes('aiKeyRequired')) {
                  setChronicleError(null);
                  setChronicleProxyDown(false);
                } else if (msg.includes('AI_PROXY_UNAVAILABLE') || msg.includes('aiProxyUnavailable')) {
                  setChronicleError(null);
                  setChronicleProxyDown(true);
                } else {
                  setChronicleError(msg);
                }
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
                        {t('stats.chronicle')} — {getTimeframeLabel()}
                      </h3>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.3rem' }}>
                        {t('stats.periodGamesPlayers', { games: totalPeriodGames, players: numPlayers })}
                      </div>
                      {hasAiStories && (chronicleModelName || chronicleGeneratedAt) && (
                        <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: '0.15rem', opacity: 0.6 }}>
                          {chronicleModelName && <>model: {chronicleModelName}</>}
                          {chronicleModelName && chronicleGeneratedAt && ' · '}
                          {chronicleGeneratedAt && new Date(chronicleGeneratedAt).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' }) + ' ' + new Date(chronicleGeneratedAt).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}
                        </div>
                      )}
                    </div>
                    {canGenerateAI && !chronicleLoading && totalPeriodGames > 0 && (
                      <button
                        onClick={handleRegenerate}
                        style={{
                          fontSize: '0.7rem', padding: '0.3rem 0.7rem', borderRadius: '8px',
                          background: 'var(--surface-hover)', color: 'var(--text-muted)',
                          border: '1px solid var(--border)', cursor: 'pointer', whiteSpace: 'nowrap',
                        }}
                      >
                        {hasAiStories ? t('stats.recreateChronicle') : t('stats.createChronicle')}
                      </button>
                    )}
                  </div>
                  {totalPeriodGames > 0 && totalPeriodGames <= 3 && (
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.2rem', fontStyle: 'italic' }}>
                      {t('stats.periodJustStarted')}
                    </div>
                  )}
                  {chronicleError && (
                    <div style={{ fontSize: '0.7rem', color: 'var(--danger)', marginTop: '0.3rem' }}>
                      {t('common.errorDetail', { detail: chronicleError })}
                    </div>
                  )}
                </div>

                {chronicleLoading && (
                  <div style={{ textAlign: 'center', padding: '2rem 0', color: 'var(--text-muted)' }}>
                    <div style={{ fontSize: '0.85rem', animation: 'pulse 1.5s ease-in-out infinite' }}>
                      {t('stats.generatingChronicle')}
                    </div>
                    <AIProgressBar operationKey="chronicle" />
                  </div>
                )}

                {!chronicleLoading && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                    {/* Owner without a Gemini key: explain why the
                        chronicle is empty and how to fix it. Members fall
                        through to the existing `chronicleNotCreated`
                        copy because they can't add the key themselves —
                        the owner has to do it. */}
                    {/* Three distinct empty-state reasons, mutually
                        exclusive — pick the one that's actually true.
                        Order matters: proxyDown (env infra) wins over
                        no-key (config), wins over "just not generated
                        yet" (waiting). */}
                    {!hasAiStories && totalPeriodGames > 0 && (() => {
                      // a) Localhost dev / undeployed env — owner-only
                      //    state because only owner can trigger gen.
                      if (isOwner && chronicleProxyDown) {
                        return <AIKeyMissingNotice feature="generic" reason="proxyUnavailable" />;
                      }
                      // b) No Gemini key configured for this group.
                      //    Both owner AND member need to know — member
                      //    used to fall through to "not yet created"
                      //    italic which implied "wait, it's coming"
                      //    but in a no-key group it never will.
                      if (!hasAIKey) {
                        return <AIKeyMissingNotice feature="generic" />;
                      }
                      // c) Group has a key, owner just hasn't triggered
                      //    chronicle generation for this period yet.
                      //    Genuine "wait" state — keep the existing
                      //    quiet italic line.
                      if (!canGenerateAI) {
                        return (
                          <div style={{ textAlign: 'center', padding: '1rem', color: 'var(--text-muted)', fontSize: '0.8rem', fontStyle: 'italic' }}>
                            {t('stats.chronicleNotCreated')}
                          </div>
                        );
                      }
                      return null;
                    })()}
                    {rankedByProfit.map((player, idx) => {
                      const aiStory = chronicleStories[player.playerId];
                      const profitColor = player.totalProfit >= 0 ? 'var(--success)' : 'var(--danger)';

                      return (
                        <div key={player.playerId} data-chronicle-player style={{
                          padding: '0.85rem', background: 'var(--surface)',
                          borderRadius: '12px',
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: '500', minWidth: '1.2rem' }}>#{idx + 1}</span>
                              <span style={{ fontSize: '1rem', fontWeight: '600' }}>{player.playerName}</span>
                            </div>
                            <span style={{ fontWeight: '700', fontSize: '1rem', color: profitColor }}>
                              {player.totalProfit >= 0 ? '\u200E+' : ''}{formatCurrency(player.totalProfit)}
                            </span>
                          </div>
                          <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.4rem', paddingInlineEnd: '1.7rem' }}>
                            {t('stats.playerDetailLine', { games: player.gamesPlayed, winPct: Math.round(player.winPercentage), avg: `${player.avgProfit >= 0 ? '\u200E+' : '\u200E'}${Math.round(player.avgProfit)}` })}
                          </div>

                          {buildSparkline(player)}

                          {aiStory && (
                            <p style={{ margin: 0, fontSize: '0.8rem', lineHeight: 1.7, color: 'var(--text)', textAlign: isRTL ? 'right' : 'left' }}>
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
                {isSharingChronicle ? t('common.capturing') : t('common.share')}
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
              {t('stats.gamesCount', { count: recordDetails.games.length })}
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
                    borderInlineEnd: `3px solid ${game.profit > 0 ? 'var(--success)' : game.profit < 0 ? 'var(--danger)' : 'var(--border)'}`,
                    cursor: 'pointer',
                    transition: 'background 0.2s'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--border)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'var(--surface)'}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text)' }}>
                      {new Date(game.date).toLocaleDateString(language === 'he' ? 'he-IL' : 'en-GB', { 
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
                    {game.profit > 0 ? '\u200E+' : ''}{formatCurrency(game.profit)}
                  </span>
            </div>
          ))}
            </div>
            
            {recordDetails.games.length === 0 && (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '1rem' }}>
                {t('common.noData')}
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
                <h3 style={{ margin: 0, fontSize: '1rem' }}>{t('stats.gameHistory')}</h3>
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
              {t('stats.gamesCount', { count: playerAllGames.games.length })}
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', maxHeight: '60vh', overflowY: 'auto' }}>
              {playerAllGames.games.map((game, idx) => (
                <div 
                  key={idx}
                  onClick={() => {
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
                    borderInlineEnd: `3px solid ${game.profit > 0 ? 'var(--success)' : game.profit < 0 ? 'var(--danger)' : 'var(--border)'}`,
                    cursor: 'pointer',
                    transition: 'background 0.2s'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--border)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'var(--surface)'}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text)' }}>
                      {new Date(game.date).toLocaleDateString(language === 'he' ? 'he-IL' : 'en-GB', { 
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
                    {game.profit > 0 ? '\u200E+' : ''}{formatCurrency(game.profit)}
                  </span>
                </div>
              ))}
              {playerAllGames.games.length > 20 && (
                <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '0.5rem', fontSize: '0.75rem' }}>
                  {t('stats.moreGames', { count: playerAllGames.games.length - 20 })}
                </div>
              )}
            </div>
            
            {playerAllGames.games.length === 0 && (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '1rem' }}>
                {t('common.noData')}
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

