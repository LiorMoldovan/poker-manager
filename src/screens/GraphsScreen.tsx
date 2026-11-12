import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh';
import { captureAndSplit, shareFiles } from '../utils/sharing';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  ReferenceLine,
  Tooltip,
} from 'recharts';
import { Player, Game, GamePlayer } from '../types';
import { getAllPlayers, getAllGames, getAllGamePlayers, getPlayerStats, getGraphInsights, saveGraphInsights } from '../database/storage';
import { cleanNumber, formatHebrewHalf } from '../utils/calculations';
import { usePermissions } from '../App';
import { getGeminiApiKey, generateGraphInsights, getLastUsedModel, getModelDisplayName } from '../utils/geminiAI';
import { canUserGenerateAI } from '../utils/aiEligibility';
import AIProgressBar from '../components/AIProgressBar';
import AIKeyMissingNotice from '../components/AIKeyMissingNotice';
import { StyledSelect, StyledSelectOption } from '../components/StyledSelect';
import { withAITiming } from '../utils/aiTiming';
import { useTranslation } from '../i18n';
import { analyzeTrends, formatTrendsForAI } from '../utils/trendAnalysis';

type ViewMode = 'cumulative' | 'headToHead' | 'impact';
type TimePeriod = 'all' | 'h1' | 'h2' | 'year' | 'month' | 'custom';

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
  shortDate: string;
  gameId: string;
  [playerId: string]: string | number;
}

/**
 * Returns up to `maxTicks` evenly spaced 1-based `gameIndex` values
 * (always including first and last when length > 1) so mobile X-axes
 * never crowd or overlap regardless of total game count.
 */
function computeEvenTicks(length: number, maxTicks = 5): number[] {
  if (length <= 0) return [];
  if (length <= maxTicks) {
    return Array.from({ length }, (_, i) => i + 1);
  }
  const ticks: number[] = [1];
  const step = (length - 1) / (maxTicks - 1);
  for (let i = 1; i < maxTicks - 1; i++) {
    ticks.push(Math.round(1 + i * step));
  }
  ticks.push(length);
  return Array.from(new Set(ticks));
}

function formatSmartAxisDate(date: Date, useMonthYear: boolean): string {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  if (useMonthYear) {
    const yy = String(date.getFullYear()).slice(-2);
    return `${mm}/${yy}`;
  }
  const dd = String(date.getDate()).padStart(2, '0');
  return `${dd}/${mm}`;
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
  const { t, isRTL, language } = useTranslation();
  const [viewMode, setViewMode] = useState<ViewMode>('cumulative');
  const [players, setPlayers] = useState<Player[]>([]);
  const [allGames, setAllGames] = useState<Game[]>([]);
  const [gamePlayers, setGamePlayers] = useState<GamePlayer[]>([]);
  const [selectedPlayers, setSelectedPlayers] = useState<Set<string>>(new Set());
  const [showPlayerSelector, setShowPlayerSelector] = useState(false);
  const [showPermanentGuestsInSelector, setShowPermanentGuestsInSelector] = useState(false);
  const [showOccasionalGuestsInSelector, setShowOccasionalGuestsInSelector] = useState(false);
  const [showTimePeriod, setShowTimePeriod] = useState(false);
  
  
  // Time period filter
  const [timePeriod, setTimePeriod] = useState<TimePeriod>(() => {
    const currentMonth = new Date().getMonth() + 1;
    return currentMonth <= 6 ? 'h1' : 'h2';
  });
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear());
  const [selectedMonth, setSelectedMonth] = useState<number>(new Date().getMonth() + 1); // 1-12
  const [customStartDate, setCustomStartDate] = useState<string>('');
  const [customEndDate, setCustomEndDate] = useState<string>('');

  /** Hebrew-only range text for `getInsightsPeriodLabel` (AI prompts). */
  const formatCustomRangeHebrewForAI = useCallback(() => {
    if (!customStartDate && !customEndDate) return 'בחר תאריכים';
    const fmt = (d: string) => new Date(d).toLocaleDateString('he-IL', { day: 'numeric', month: 'short', year: '2-digit' });
    if (customStartDate && customEndDate) return `${fmt(customStartDate)} — ${fmt(customEndDate)}`;
    if (customStartDate) return `מ-${fmt(customStartDate)}`;
    return `עד ${fmt(customEndDate)}`;
  }, [customStartDate, customEndDate]);

  const formatCustomRange = useCallback(() => {
    if (!customStartDate && !customEndDate) return t('stats.selectDates');
    const locale = language === 'he' ? 'he-IL' : 'en-US';
    const fmt = (d: string) => new Date(d).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: '2-digit' });
    if (customStartDate && customEndDate) return `${fmt(customStartDate)} — ${fmt(customEndDate)}`;
    if (customStartDate) return `${t('stats.from')} ${fmt(customStartDate)}`;
    return `${t('stats.to')} ${fmt(customEndDate)}`;
  }, [customStartDate, customEndDate, t, language]);

  // Head-to-head specific state
  const [player1Id, setPlayer1Id] = useState<string>('');
  const [player2Id, setPlayer2Id] = useState<string>('');
  
  // Impact view state
  const [impactPlayerId, setImpactPlayerId] = useState<string>('');
  const [includeGuestsInImpact, setIncludeGuestsInImpact] = useState(false);
  const [showLimitedData, setShowLimitedData] = useState(false);
  const prevTimePeriodRef = useRef<{ period: TimePeriod; year: number } | null>(null);

  // AI Graph Insights state
  const { role, isOwner, isSuperAdmin } = usePermissions();
  // Owner, or a non-owner admin who set a personal device key, may trigger AI.
  const canUseAI = canUserGenerateAI(isOwner, role === 'admin' || isSuperAdmin || isOwner);
  const [insightsText, setInsightsText] = useState<string>('');
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [insightsError, setInsightsError] = useState<string | null>(null);
  // Tracks the "AI proxy isn't reachable in this environment" state
  // (typically: localhost dev — /api/* only runs on Vercel). We surface
  // a dedicated friendly notice instead of the raw "Status 404" red
  // banner that the underlying error would otherwise produce.
  const [insightsProxyDown, setInsightsProxyDown] = useState(false);
  const [insightsGeneratedAt, setInsightsGeneratedAt] = useState<string>('');
  const [insightsModelName, setInsightsModelName] = useState<string>('');
  const insightsGenRef = useRef(false);
  const chartRef = useRef<HTMLDivElement>(null);
  const h2hShareRef = useRef<HTMLDivElement>(null);
  const insightsRef = useRef<HTMLDivElement>(null);
  const [isSharingChart, setIsSharingChart] = useState(false);
  const [isSharingH2H, setIsSharingH2H] = useState(false);
  const [isSharingInsights, setIsSharingInsights] = useState(false);
  const [highlightedPlayerIds, setHighlightedPlayerIds] = useState<string[]>([]);
  const [expandedConclusionId, setExpandedConclusionId] = useState<string | null>(null);
  const [recentLimit, setRecentLimit] = useState<number | null>(null);
  const [activeCumulativeIdx, setActiveCumulativeIdx] = useState<number | null>(null);
  const [activeH2HIdx, setActiveH2HIdx] = useState<number | null>(null);

  const handleShareSection = async (ref: React.RefObject<HTMLDivElement | null>, setSharing: (v: boolean) => void, title: string) => {
    if (!ref.current) return;
    setSharing(true);
    try {
      const files = await captureAndSplit(ref.current, `poker-${title}`);
      await shareFiles(files, `Poker ${title}`);
    } catch { /* */ }
    finally { setSharing(false); }
  };

  // O(1) lookup map: gameId -> (playerId -> GamePlayer)
  const gamePlayersByGameId = useMemo(() => {
    const map = new Map<string, Map<string, GamePlayer>>();
    for (const gp of gamePlayers) {
      let byPlayer = map.get(gp.gameId);
      if (!byPlayer) {
        byPlayer = new Map<string, GamePlayer>();
        map.set(gp.gameId, byPlayer);
      }
      byPlayer.set(gp.playerId, gp);
    }
    return map;
  }, [gamePlayers]);

  // Options for the Head-to-Head + Impact player pickers: permanents flat at
  // the top, regular guests + occasional players behind collapsible headers.
  // Occasional players are filtered to those who actually played at least once
  // (sorted by total games descending) so the list stays practical.
  const totalGamesByPlayerId = useMemo(() => {
    const counts = new Map<string, number>();
    for (const gp of gamePlayers) {
      counts.set(gp.playerId, (counts.get(gp.playerId) || 0) + 1);
    }
    return counts;
  }, [gamePlayers]);

  const comparisonPlayerOptions = useMemo<StyledSelectOption<string>[]>(() => {
    const perms = players
      .filter(p => (p.type || 'permanent') === 'permanent')
      .map(p => ({ value: p.id, label: p.name }));
    const regularGuests = players
      .filter(p => p.type === 'permanent_guest')
      .sort((a, b) => (totalGamesByPlayerId.get(b.id) || 0) - (totalGamesByPlayerId.get(a.id) || 0))
      .map(p => ({
        value: p.id,
        label: p.name,
        group: t('settings.players.groupPermanentGuest'),
      }));
    const occasionals = players
      .filter(p => p.type === 'guest' && ((totalGamesByPlayerId.get(p.id) || 0) > 0 || p.id === player1Id || p.id === player2Id || p.id === impactPlayerId))
      .sort((a, b) => (totalGamesByPlayerId.get(b.id) || 0) - (totalGamesByPlayerId.get(a.id) || 0))
      .map(p => ({
        value: p.id,
        label: p.name,
        group: t('history.occasional'),
      }));
    return [...perms, ...regularGuests, ...occasionals];
  }, [players, totalGamesByPlayerId, player1Id, player2Id, impactPlayerId, t]);

  // Scope of the Impact view's "other players" loop — defaults to permanents
  // only (`includeGuestsInImpact === false`) so sparse guests don't clutter
  // the rows, with an opt-in toggle to also compare against regular guests.
  const impactComparisonPlayers = useMemo(
    () => players.filter(p =>
      p.type === 'permanent' || (includeGuestsInImpact && p.type === 'permanent_guest')
    ),
    [players, includeGuestsInImpact]
  );

  const regularGuestsCount = useMemo(
    () => players.filter(p => p.type === 'permanent_guest').length,
    [players]
  );

  // Color mapping — permanents first so their colors stay stable as guests
  // come and go, then everyone else. Every player gets a color because any
  // of them can now be picked in H2H / Impact.
  const playerColorMap = useMemo(() => {
    const map = new Map<string, string>();
    const permanentPlayers = players.filter(p => p.type === 'permanent');
    permanentPlayers.forEach((player, index) => {
      map.set(player.id, PLAYER_COLORS[index % PLAYER_COLORS.length]);
    });
    const others = players.filter(p => !map.has(p.id));
    others.forEach((player, index) => {
      map.set(player.id, PLAYER_COLORS[(permanentPlayers.length + index) % PLAYER_COLORS.length]);
    });
    return map;
  }, [players]);

  useEffect(() => {
    loadData();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useRealtimeRefresh(useCallback(() => loadData(true), []));

  const loadData = (preserveSelection = false) => {
    const allPlayersData = getAllPlayers();
    const allGamesData = getAllGames()
      .filter(g => g.status === 'completed')
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const allGamePlayersData = getAllGamePlayers();
    
    setPlayers(allPlayersData);
    setAllGames(allGamesData);
    setGamePlayers(allGamePlayersData);
    
    if (!preserveSelection) {
      const permanentPlayerIds = allPlayersData
        .filter(p => p.type === 'permanent')
        .map(p => p.id);
      setSelectedPlayers(new Set(permanentPlayerIds));
      
      if (permanentPlayerIds.length >= 2) {
        setPlayer1Id(permanentPlayerIds[0]);
        setPlayer2Id(permanentPlayerIds[1]);
      }
      
      if (permanentPlayerIds.length >= 1) {
        setImpactPlayerId(permanentPlayerIds[0]);
      }
    }
  };

  // ─── AI Graph Insights helpers ───

  const getInsightsKey = useCallback(() => {
    if (recentLimit !== null) return `recent-${recentLimit}`;
    if (timePeriod === 'all') return 'all';
    if (timePeriod === 'year') return `${selectedYear}`;
    if (timePeriod === 'h1') return `H1-${selectedYear}`;
    if (timePeriod === 'h2') return `H2-${selectedYear}`;
    if (timePeriod === 'month') return `${selectedYear}-${String(selectedMonth).padStart(2, '0')}`;
    if (timePeriod === 'custom') return `custom-${customStartDate || 'x'}-${customEndDate || 'x'}`;
    return 'all';
  }, [recentLimit, timePeriod, selectedYear, selectedMonth, customStartDate, customEndDate]);

  const getInsightsPeriodLabel = useCallback(() => {
    if (recentLimit !== null) return `${recentLimit} המשחקים האחרונים`;
    if (timePeriod === 'all') return 'כל הזמנים';
    if (timePeriod === 'year') return `${selectedYear}`;
    if (timePeriod === 'h1') return `חציון ראשון ${selectedYear}`;
    if (timePeriod === 'h2') return `חציון שני ${selectedYear}`;
    if (timePeriod === 'custom') return formatCustomRangeHebrewForAI();
    if (timePeriod === 'month') {
      const months = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
      return `${months[selectedMonth - 1]} ${selectedYear}`;
    }
    return '';
  }, [recentLimit, timePeriod, selectedYear, selectedMonth, formatCustomRangeHebrewForAI]);

  const getDateFilter = useCallback((): { start?: Date; end?: Date } | undefined => {
    if (recentLimit !== null) {
      const recent = allGames.slice(-recentLimit);
      if (recent.length === 0) return undefined;
      return {
        start: new Date(recent[0].date),
        end: new Date(recent[recent.length - 1].date),
      };
    }
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
      case 'custom': {
        if (!customStartDate && !customEndDate) return undefined;
        const result: { start?: Date; end?: Date } = {};
        if (customStartDate) result.start = new Date(customStartDate + 'T00:00:00');
        if (customEndDate) result.end = new Date(customEndDate + 'T23:59:59');
        return result;
      }
      case 'all':
      default: return undefined;
    }
  }, [timePeriod, selectedYear, selectedMonth, customStartDate, customEndDate]);

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

  // Filter games by time period (or quick last-N-games limit)
  const filteredGames = useMemo(() => {
    if (recentLimit !== null && viewMode !== 'impact') {
      return allGames.slice(-recentLimit);
    }
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
        case 'month': {
          const monthIndex = selectedMonth - 1;
          const lastDay = new Date(year, monthIndex + 1, 0).getDate();
          return gameDate >= new Date(year, monthIndex, 1) && gameDate <= new Date(year, monthIndex, lastDay, 23, 59, 59);
        }
        case 'custom': {
          if (!customStartDate && !customEndDate) return true;
          if (customStartDate && gameDate < new Date(customStartDate + 'T00:00:00')) return false;
          if (customEndDate && gameDate > new Date(customEndDate + 'T23:59:59')) return false;
          return true;
        }
        case 'all':
        default:
          return true;
      }
    });
  }, [allGames, recentLimit, viewMode, timePeriod, selectedYear, selectedMonth, customStartDate, customEndDate]);

  // Lineup-aware trend, turning point & pair correlation analysis
  const trendAnalysis = useMemo(
    () => analyzeTrends(filteredGames, players, gamePlayersByGameId, selectedPlayers),
    [filteredGames, players, gamePlayersByGameId, selectedPlayers]
  );

  // Game count per player in the currently filtered period (used to sort and
  // filter guest/occasional tiers in the cumulative trends selector).
  const periodGamesByPlayerId = useMemo(() => {
    const filteredIds = new Set(filteredGames.map(g => g.id));
    const counts = new Map<string, number>();
    for (const gp of gamePlayers) {
      if (filteredIds.has(gp.gameId)) {
        counts.set(gp.playerId, (counts.get(gp.playerId) || 0) + 1);
      }
    }
    return counts;
  }, [filteredGames, gamePlayers]);

  // Auto-generate insights when cache is empty for this period (owner, or
  // a non-owner admin who set a personal device key).
  useEffect(() => {
    if (!canUseAI) return;
    if (recentLimit !== null) return;
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
      setInsightsProxyDown(false);
      try {
        const dateFilter = getDateFilter();
        const minGamesForInsights = (timePeriod === 'h1' || timePeriod === 'h2' || timePeriod === 'year' || timePeriod === 'all') ? 2 : 1;
        const stats = getPlayerStats(dateFilter)
          .filter(s => {
            const p = players.find(pl => pl.id === s.playerId);
            return p && p.type === 'permanent' && s.gamesPlayed >= minGamesForInsights;
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

        const trendCtx = formatTrendsForAI(trendAnalysis);
        const text = await withAITiming('graph_insights', () => generateGraphInsights(stats, periodLabel, totalGames, isEarlyPeriod, trendCtx));
        const modelDisplay = getModelDisplayName(getLastUsedModel());
        saveGraphInsights(key, text, modelDisplay);
        setInsightsText(text);
        setInsightsGeneratedAt(new Date().toISOString());
        setInsightsModelName(modelDisplay);
      } catch (err) {
        console.error('Graph insights auto-generation failed:', err);
        const msg = err instanceof Error ? err.message : String(err);
        // 403 / NO_API_KEY = expected state for groups without a key —
        // suppress the red error so the friendly empty-state notice
        // (rendered above) stays the only signal.
        if (msg.includes('NO_API_KEY') || msg.includes('aiKeyRequired')) {
          setInsightsError(null);
          setInsightsProxyDown(false);
        } else if (msg.includes('AI_PROXY_UNAVAILABLE') || msg.includes('aiProxyUnavailable')) {
          // Localhost dev / undeployed env — show the dedicated
          // "proxy unavailable" notice instead of a raw 404 error.
          setInsightsError(null);
          setInsightsProxyDown(true);
        } else {
          setInsightsError(msg || t('graphs.errorInsights'));
        }
      } finally {
        setInsightsLoading(false);
      }
    })();
  }, [canUseAI, filteredGames, insightsLoading, getInsightsKey, getDateFilter, getInsightsPeriodLabel, players, timePeriod, selectedYear, selectedMonth, customStartDate, customEndDate, t]);

  const handleGenerateInsights = useCallback(async () => {
    if (insightsLoading) return;
    const apiKey = getGeminiApiKey();
    if (!apiKey) {
      // Don't surface a red error — the friendly <AIKeyMissingNotice/>
      // already explains the situation in the empty state. Just clear
      // any prior error so the notice has a clean slot to render in.
      setInsightsError(null);
      return;
    }

    setInsightsLoading(true);
    setInsightsError(null);
    setInsightsProxyDown(false);
    try {
      const dateFilter = getDateFilter();
      const minGamesForInsights = (timePeriod === 'h1' || timePeriod === 'h2' || timePeriod === 'year' || timePeriod === 'all') ? 2 : 1;
      const stats = getPlayerStats(dateFilter)
        .filter(s => {
          const p = players.find(pl => pl.id === s.playerId);
          return p && p.type === 'permanent' && s.gamesPlayed >= minGamesForInsights;
        })
        .sort((a, b) => b.totalProfit - a.totalProfit);

      if (stats.length === 0) {
        setInsightsError(t('graphs.notEnoughData'));
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

      const trendCtx = formatTrendsForAI(trendAnalysis);
      const text = await withAITiming('graph_insights', () => generateGraphInsights(stats, periodLabel, totalGames, isEarlyPeriod, trendCtx));
      const key = getInsightsKey();
      const modelDisplay = getModelDisplayName(getLastUsedModel());
      saveGraphInsights(key, text, modelDisplay);
      setInsightsText(text);
      setInsightsGeneratedAt(new Date().toISOString());
      setInsightsModelName(modelDisplay);
    } catch (err) {
      console.error('Graph insights generation failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('NO_API_KEY') || msg.includes('aiKeyRequired')) {
        // Same rationale as the auto-generation path — let the friendly
        // notice carry the message instead of a red error banner.
        setInsightsError(null);
        setInsightsProxyDown(false);
      } else if (msg.includes('AI_PROXY_UNAVAILABLE') || msg.includes('aiProxyUnavailable')) {
        setInsightsError(null);
        setInsightsProxyDown(true);
      } else {
        setInsightsError(msg || t('graphs.errorInsights'));
      }
    } finally {
      setInsightsLoading(false);
    }
  }, [insightsLoading, players, filteredGames, getDateFilter, getInsightsPeriodLabel, getInsightsKey, timePeriod, selectedYear, selectedMonth, customStartDate, customEndDate, t]);

  const getPlayerName = useCallback((playerId: string): string => {
    const player = players.find(p => p.id === playerId);
    return player?.name || 'Unknown';
  }, [players]);

  const getPlayerColor = useCallback((playerId: string): string => {
    return playerColorMap.get(playerId) || '#888888';
  }, [playerColorMap]);

  // Clear active scrub/highlight state when filters or selections change
  useEffect(() => {
    setActiveCumulativeIdx(null);
    setExpandedConclusionId(null);
  }, [filteredGames, selectedPlayers]);

  useEffect(() => {
    setActiveH2HIdx(null);
  }, [filteredGames, player1Id, player2Id]);

  useEffect(() => {
    setHighlightedPlayerIds(prev => prev.filter(id => selectedPlayers.has(id)));
  }, [selectedPlayers]);

  const toggleHighlightPlayer = useCallback((playerId: string) => {
    setHighlightedPlayerIds(prev => {
      if (prev.includes(playerId)) return prev.filter(id => id !== playerId);
      if (prev.length < 2) return [...prev, playerId];
      return [playerId];
    });
  }, []);

  const focusSignalPlayers = useCallback((playerIds: string[]) => {
    if (playerIds.length === 0) return;
    const isAlreadyFocused =
      highlightedPlayerIds.length === playerIds.length &&
      playerIds.every(id => highlightedPlayerIds.includes(id));
    if (isAlreadyFocused) {
      setHighlightedPlayerIds([]);
      return;
    }
    setSelectedPlayers(prev => {
      if (playerIds.every(id => prev.has(id))) return prev;
      const next = new Set(prev);
      playerIds.forEach(id => next.add(id));
      return next;
    });
    setHighlightedPlayerIds(playerIds);
    chartRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [highlightedPlayerIds]);

  // Calculate cumulative profit data (keyed by playerId to prevent name-collision bugs)
  const cumulativeData: CumulativeDataPoint[] = useMemo(() => {
    const data: CumulativeDataPoint[] = [];
    const playerCumulatives: Record<string, number> = {};

    selectedPlayers.forEach(playerId => {
      playerCumulatives[playerId] = 0;
    });

    const firstDate = filteredGames.length > 0 ? new Date(filteredGames[0].date) : null;
    const lastDate = filteredGames.length > 0 ? new Date(filteredGames[filteredGames.length - 1].date) : null;
    const spanDays = firstDate && lastDate ? (lastDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24) : 0;
    const useMonthYearAxis = (recentLimit === null && timePeriod === 'all') || spanDays > 180;

    filteredGames.forEach((game, gameIndex) => {
      const gameDate = new Date(game.date);
      const dateStr = gameDate.toLocaleDateString(isRTL ? 'he-IL' : 'en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });
      const shortDate = formatSmartAxisDate(gameDate, useMonthYearAxis);

      const dataPoint: CumulativeDataPoint = {
        gameIndex: gameIndex + 1,
        date: dateStr,
        shortDate,
        gameId: game.id,
      };

      const byPlayer = gamePlayersByGameId.get(game.id);
      selectedPlayers.forEach(playerId => {
        const gp = byPlayer?.get(playerId);
        if (gp) {
          playerCumulatives[playerId] += gp.profit;
        }
        dataPoint[playerId] = playerCumulatives[playerId];
      });

      data.push(dataPoint);
    });

    return data;
  }, [filteredGames, gamePlayersByGameId, selectedPlayers, isRTL, timePeriod, recentLimit]);

  const cumulativeXAxisTicks = useMemo(
    () => computeEvenTicks(cumulativeData.length, 5),
    [cumulativeData.length]
  );

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
        const dateStr = new Date(game.date).toLocaleDateString(isRTL ? 'he-IL' : 'en-GB', { 
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

    // Win rate with the opponent at the table vs without them. The raw "40%
    // when he shows up" only means something next to the same player's rate
    // when he doesn't, so both are computed off the same filtered period.
    const soloGamesFor = (playerId: string) => gamePlayers.filter(
      gp => gp.playerId === playerId && filteredGameIds.has(gp.gameId) && !sharedGameIds.has(gp.gameId)
    );
    const winPct = (wins: number, games: number) => (games > 0 ? Math.round((wins / games) * 100) : null);
    const splitFor = (playerId: string, stats: HeadToHeadStat) => {
      const solo = soloGamesFor(playerId);
      return {
        withPct: winPct(stats.wins, stats.gamesPlayed),
        withGames: stats.gamesPlayed,
        withoutPct: winPct(solo.filter(g => g.profit > 0).length, solo.length),
        withoutGames: solo.length,
      };
    };
    const winRateSplit = {
      p1: splitFor(player1Id, player1Stats),
      p2: splitFor(player2Id, player2Stats),
    };

    // Cumulative data for shared games (for the chart)
    const cumulativeComparison: Array<{
      gameIndex: number;
      date: string;
      shortDate: string;
      p1: number;
      p2: number;
    }> = [];

    const firstSharedDate = sharedGamesOrdered.length > 0 ? new Date(sharedGamesOrdered[0].date) : null;
    const lastSharedDate = sharedGamesOrdered.length > 0 ? new Date(sharedGamesOrdered[sharedGamesOrdered.length - 1].date) : null;
    const sharedSpanDays = firstSharedDate && lastSharedDate
      ? (lastSharedDate.getTime() - firstSharedDate.getTime()) / (1000 * 60 * 60 * 24)
      : 0;
    const useMonthYearH2H = timePeriod === 'all' || sharedSpanDays > 180;

    let p1Cumulative = 0;
    let p2Cumulative = 0;
    let gameIdx = 0;

    sharedGamesOrdered.forEach(game => {
      gameIdx++;
      const byPlayer = gamePlayersByGameId.get(game.id);
      const p1Game = byPlayer?.get(player1Id);
      const p2Game = byPlayer?.get(player2Id);

      if (p1Game) p1Cumulative += p1Game.profit;
      if (p2Game) p2Cumulative += p2Game.profit;

      const gameDate = new Date(game.date);
      const dateStr = gameDate.toLocaleDateString(isRTL ? 'he-IL' : 'en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
      });

      cumulativeComparison.push({
        gameIndex: gameIdx,
        date: dateStr,
        shortDate: formatSmartAxisDate(gameDate, useMonthYearH2H),
        p1: p1Cumulative,
        p2: p2Cumulative,
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
      winRateSplit,
    };
  }, [player1Id, player2Id, filteredGames, gamePlayers, gamePlayersByGameId, getPlayerName, isRTL, timePeriod]);

  const h2hXAxisTicks = useMemo(
    () => computeEvenTicks(headToHeadData?.cumulativeComparison.length || 0, 5),
    [headToHeadData?.cumulativeComparison.length]
  );

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

  // Impact data - for a selected player, how their avg changes with/without each other player.
  // The subject can be anyone the picker offers, but the comparison rows stay permanent-only
  // (`impactComparisonPlayers`) — guests' game counts are too low for the with/without delta
  // to mean anything.
  const impactData = useMemo(() => {
    if (!impactPlayerId) return [];

    const comparisonPlayers = impactComparisonPlayers.filter(p => p.id !== impactPlayerId);
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

    for (const other of comparisonPlayers) {
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
  }, [impactPlayerId, filteredGames, gamePlayers, impactComparisonPlayers, getPlayerColor]);

  const getTimeframeLabel = () => {
    if (recentLimit !== null && viewMode !== 'impact') {
      return t('graphs.lastNGamesLabel', { n: recentLimit });
    }
    const locale = language === 'he' ? 'he-IL' : 'en-US';
    if (timePeriod === 'all') return t('stats.allTimeLabel');
    if (timePeriod === 'custom') {
      if (!customStartDate && !customEndDate) return t('stats.custom');
      const fmt = (d: string) => new Date(d).toLocaleDateString(locale, { day: '2-digit', month: 'short', year: '2-digit' });
      if (customStartDate && customEndDate) return `${fmt(customStartDate)} – ${fmt(customEndDate)}`;
      if (customStartDate) return `${t('stats.from')} ${fmt(customStartDate)}`;
      return `${t('stats.to')} ${fmt(customEndDate)}`;
    }
    if (timePeriod === 'month') {
      const monthName = new Intl.DateTimeFormat(locale, { month: 'long' }).format(new Date(2024, selectedMonth - 1, 1));
      return `${monthName} ${selectedYear}`;
    }
    if (language === 'he') {
      if (timePeriod === 'year') return `שנת ${selectedYear}`;
      if (timePeriod === 'h1') return formatHebrewHalf(1, selectedYear);
      if (timePeriod === 'h2') return formatHebrewHalf(2, selectedYear);
      return '';
    }
    if (timePeriod === 'year') return `${selectedYear}`;
    if (timePeriod === 'h1') return `H1 ${selectedYear}`;
    if (timePeriod === 'h2') return `H2 ${selectedYear}`;
    return '';
  };

  // Interactive Legend sorted by final cumulative profit descending (tapping a pill highlights that player)
  const legendPlayerIds = useMemo(() => {
    const lastPoint = cumulativeData[cumulativeData.length - 1];
    if (!lastPoint) return sortedPlayerIds;
    return [...sortedPlayerIds].sort((a, b) => {
      const aVal = Number(lastPoint[a] ?? 0);
      const bVal = Number(lastPoint[b] ?? 0);
      return bVal - aVal;
    });
  }, [sortedPlayerIds, cumulativeData]);

  const CustomLegend = () => {
    const lastPoint = cumulativeData[cumulativeData.length - 1];
    const hasHighlight = highlightedPlayerIds.length > 0;
    return (
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: '0.35rem',
        padding: '0.5rem 0 0.15rem',
        marginTop: '0.35rem',
      }}>
        {legendPlayerIds.map(playerId => {
          const color = getPlayerColor(playerId);
          const isHighlighted = highlightedPlayerIds.includes(playerId);
          const isDimmed = hasHighlight && !isHighlighted;
          const finalVal = lastPoint ? Number(lastPoint[playerId] ?? 0) : null;
          return (
            <button
              key={playerId}
              type="button"
              onClick={() => toggleHighlightPlayer(playerId)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.3rem',
                fontSize: '0.72rem',
                padding: '0.28rem 0.55rem',
                borderRadius: '999px',
                border: isHighlighted ? `1.5px solid ${color}` : '1px solid var(--border)',
                background: isHighlighted ? `${color}24` : 'var(--surface)',
                opacity: isDimmed ? 0.45 : 1,
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
            >
              <span style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: color,
                flexShrink: 0,
              }} />
              <span style={{
                color,
                fontWeight: isHighlighted ? '700' : '600',
              }}>
                {getPlayerName(playerId)}
              </span>
              {finalVal !== null && (
                <span style={{
                  fontSize: '0.68rem',
                  fontWeight: '700',
                  color: finalVal > 0 ? '#10B981' : finalVal < 0 ? '#EF4444' : 'var(--text-muted)',
                  direction: 'ltr',
                  unicodeBidi: 'isolate',
                }}>
                  {finalVal > 0 ? '\u200E+' : ''}{cleanNumber(finalVal)}
                </span>
              )}
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <div className="fade-in">
      <div className="page-header">
        <h1 className="page-title">{t('graphs.title')}</h1>
        <p className="page-subtitle">{t('graphs.subtitle')}</p>
      </div>

      {/* View Mode Toggle */}
      <div className="card" style={{ padding: '0.75rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button 
            className="btn btn-sm btn-secondary"
            onClick={() => {
              if (viewMode === 'impact' && prevTimePeriodRef.current) {
                setTimePeriod(prevTimePeriodRef.current.period);
                setSelectedYear(prevTimePeriodRef.current.year);
                prevTimePeriodRef.current = null;
              }
              setViewMode('cumulative');
            }}
            style={{ flex: 1, minWidth: 0, padding: '0.5rem 0.25rem', fontSize: '0.75rem', ...(viewMode === 'cumulative' ? { background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.4)', color: '#34d399' } : {}) }}
          >
            {t('graphs.trends')}
          </button>
          <button 
            className="btn btn-sm btn-secondary"
            onClick={() => {
              if (viewMode === 'impact' && prevTimePeriodRef.current) {
                setTimePeriod(prevTimePeriodRef.current.period);
                setSelectedYear(prevTimePeriodRef.current.year);
                prevTimePeriodRef.current = null;
              }
              setViewMode('headToHead');
            }}
            style={{ flex: 1, minWidth: 0, padding: '0.5rem 0.25rem', fontSize: '0.75rem', ...(viewMode === 'headToHead' ? { background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.4)', color: '#34d399' } : {}) }}
          >
            {t('graphs.headToHead')}
          </button>
          <button 
            className="btn btn-sm btn-secondary"
            onClick={() => {
              if (viewMode !== 'impact') {
                prevTimePeriodRef.current = { period: timePeriod, year: selectedYear };
                setTimePeriod('all');
              }
              setViewMode('impact');
            }}
            style={{ flex: 1, minWidth: 0, padding: '0.5rem 0.25rem', fontSize: '0.75rem', ...(viewMode === 'impact' ? { background: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.4)', color: '#34d399' } : {}) }}
          >
            {t('graphs.impact')}
          </button>
        </div>
      </div>

      {/* Filters Card - Always visible */}
      <div className="card" style={{ padding: '0.75rem' }}>
        {/* Quick Last-N-Games Pills (Trends & H2H) */}
        {viewMode !== 'impact' && allGames.length >= 5 && (
          <div style={{ display: 'flex', gap: '0.35rem', marginBottom: '0.6rem' }}>
            {[
              { label: t('graphs.byFilter'), val: null as number | null },
              ...(allGames.length >= 10 ? [{ label: t('graphs.recent10'), val: 10 as number | null }] : []),
              { label: t('graphs.recent5'), val: 5 as number | null },
            ].map(opt => {
              const active = recentLimit === opt.val;
              return (
                <button
                  key={String(opt.val)}
                  type="button"
                  onClick={() => setRecentLimit(opt.val)}
                  style={{
                    flex: 1,
                    padding: '0.32rem 0.4rem',
                    fontSize: '0.7rem',
                    fontWeight: active ? '700' : '500',
                    borderRadius: '8px',
                    border: active ? '1.5px solid var(--primary)' : '1px solid var(--border)',
                    background: active ? 'rgba(16, 185, 129, 0.14)' : 'var(--surface)',
                    color: active ? 'var(--primary)' : 'var(--text-muted)',
                    cursor: 'pointer',
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        )}

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
              {t('stats.timePeriod')} {recentLimit !== null && viewMode !== 'impact' ? `(${t('graphs.lastNGamesLabel', { n: recentLimit })})` : timePeriod === 'all' ? `(${t('stats.allTime')})` : timePeriod === 'custom' ? `(${formatCustomRange()})` : timePeriod === 'year' ? `(${selectedYear})` : timePeriod === 'month' ? `(${new Intl.DateTimeFormat(language === 'he' ? 'he-IL' : 'en-US', { month: 'short' }).format(new Date(2024, selectedMonth - 1, 1))} ${selectedYear})` : `(${language === 'he' ? formatHebrewHalf(timePeriod === 'h1' ? 1 : 2, selectedYear) : `${timePeriod.toUpperCase()} ${selectedYear}`})`}
            </span>
            <span style={{ fontSize: '1rem', color: 'var(--text-muted)' }}>{showTimePeriod ? '▲' : '▼'}</span>
          </button>
          {showTimePeriod && (
            <>
              <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); e.preventDefault(); setRecentLimit(null); setTimePeriod('all'); }}
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
                  onClick={(e) => { e.stopPropagation(); e.preventDefault(); setRecentLimit(null); setTimePeriod('year'); }}
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
                  onClick={(e) => { e.stopPropagation(); e.preventDefault(); setRecentLimit(null); setTimePeriod('h1'); }}
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
                  onClick={(e) => { e.stopPropagation(); e.preventDefault(); setRecentLimit(null); setTimePeriod('h2'); }}
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
                  onClick={(e) => { e.stopPropagation(); e.preventDefault(); setRecentLimit(null); setTimePeriod('month'); }}
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
                  onClick={(e) => { e.stopPropagation(); e.preventDefault(); setRecentLimit(null); setTimePeriod('custom'); }}
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
              {/* Year Selector - only when not "all" and not custom range */}
              {timePeriod !== 'all' && timePeriod !== 'custom' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.4rem', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{t('stats.yearLabel')}</span>
                  <StyledSelect<string>
                    value={String(selectedYear)}
                    onChange={(next) => setSelectedYear(parseInt(next))}
                    options={getAvailableYears().map(year => ({ value: String(year), label: String(year) }))}
                    variant="green"
                    size="sm"
                    minWidth="60px"
                    title={t('stats.yearLabel')}
                  />
                  {timePeriod === 'month' && (
                    <>
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginLeft: '0.3rem' }}>{t('stats.monthLabel')}</span>
                      <StyledSelect<string>
                        value={String(selectedMonth)}
                        onChange={(next) => setSelectedMonth(parseInt(next))}
                        options={Array.from({ length: 12 }, (_, monthIndex) => {
                          const value = monthIndex + 1;
                          const label = new Intl.DateTimeFormat(language === 'he' ? 'he-IL' : 'en-US', { month: 'long' }).format(new Date(2024, monthIndex, 1));
                          return { value: String(value), label };
                        })}
                        variant="green"
                        size="sm"
                        minWidth="80px"
                        title={t('stats.monthLabel')}
                      />
                    </>
                  )}
                  <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                    {timePeriod === 'h1' && t('stats.h1Hint')}
                    {timePeriod === 'h2' && t('stats.h2Hint')}
                  </span>
                </div>
              )}
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

        {/* Player Filter - Only show for cumulative view */}
        {viewMode === 'cumulative' && (() => {
          const permanentList = players.filter(p => (p.type || 'permanent') === 'permanent');
          const guestList = players
            .filter(p => p.type === 'permanent_guest' && ((periodGamesByPlayerId.get(p.id) || 0) > 0 || selectedPlayers.has(p.id)))
            .sort((a, b) => (periodGamesByPlayerId.get(b.id) || 0) - (periodGamesByPlayerId.get(a.id) || 0));
          const occasionalList = players
            .filter(p => p.type === 'guest' && ((periodGamesByPlayerId.get(p.id) || 0) > 0 || selectedPlayers.has(p.id)))
            .sort((a, b) => (periodGamesByPlayerId.get(b.id) || 0) - (periodGamesByPlayerId.get(a.id) || 0));

          const selectedPermCount = permanentList.filter(p => selectedPlayers.has(p.id)).length;
          const selectedGuestCount = players.filter(p => (p.type || 'permanent') !== 'permanent' && selectedPlayers.has(p.id)).length;
          const selectedPermGuestsCount = guestList.filter(p => selectedPlayers.has(p.id)).length;
          const selectedOccasionalCount = occasionalList.filter(p => selectedPlayers.has(p.id)).length;

          const renderPlayerPill = (player: Player, showGameCount = false) => {
            const isSelected = selectedPlayers.has(player.id);
            const color = getPlayerColor(player.id);
            const gamesInPeriod = periodGamesByPlayerId.get(player.id) || 0;
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
                  transition: 'all 0.15s ease',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.25rem',
                }}
              >
                <span>{isSelected && '✓ '}{player.name}</span>
                {showGameCount && gamesInPeriod > 0 && (
                  <span style={{ fontSize: '0.65rem', opacity: 0.7, fontWeight: '500' }}>
                    ({gamesInPeriod})
                  </span>
                )}
              </button>
            );
          };

          return (
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
                  {selectedGuestCount > 0
                    ? t('graphs.filterPlayersWithGuests', {
                        selected: selectedPermCount,
                        total: permanentList.length,
                        guests: selectedGuestCount,
                      })
                    : t('graphs.filterPlayers', {
                        selected: selectedPermCount,
                        total: permanentList.length,
                      })}
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
                      {selectedGuestCount > 0 ? t('graphs.selectRegularsOnly') : t('common.selectAll')}
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
                      {t('common.clear')}
                    </button>
                  </div>

                  {/* Permanent Players */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                    {permanentList.map(player => renderPlayerPill(player, false))}
                  </div>

                  {/* Regular Guests Section (collapsible) */}
                  {guestList.length > 0 && (
                    <div style={{ marginTop: '0.6rem', paddingTop: '0.5rem', borderTop: '1px dashed var(--border)' }}>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); e.preventDefault(); setShowPermanentGuestsInSelector(v => !v); }}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          width: '100%',
                          padding: 0,
                          marginBottom: showPermanentGuestsInSelector ? '0.4rem' : 0,
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          color: 'var(--text)',
                        }}
                      >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.72rem', fontWeight: '600', color: 'var(--text-muted)' }}>
                          <span>{t('graphs.guestPlayersSection', { count: guestList.length })}</span>
                          {selectedPermGuestsCount > 0 && (
                            <span style={{
                              background: 'var(--primary)',
                              color: '#fff',
                              borderRadius: '999px',
                              padding: '0.05rem 0.4rem',
                              fontSize: '0.62rem',
                              fontWeight: '700',
                            }}>
                              {selectedPermGuestsCount}
                            </span>
                          )}
                        </span>
                        <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                          {showPermanentGuestsInSelector ? '▲' : '▼'}
                        </span>
                      </button>
                      {showPermanentGuestsInSelector && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                          {guestList.map(player => renderPlayerPill(player, true))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Occasional Guests Section (collapsible) */}
                  {occasionalList.length > 0 && (
                    <div style={{ marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px dashed var(--border)' }}>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); e.preventDefault(); setShowOccasionalGuestsInSelector(v => !v); }}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          width: '100%',
                          padding: 0,
                          marginBottom: showOccasionalGuestsInSelector ? '0.4rem' : 0,
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          color: 'var(--text)',
                        }}
                      >
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.72rem', fontWeight: '600', color: 'var(--text-muted)' }}>
                          <span>{t('graphs.occasionalPlayersSection', { count: occasionalList.length })}</span>
                          {selectedOccasionalCount > 0 && (
                            <span style={{
                              background: 'var(--primary)',
                              color: '#fff',
                              borderRadius: '999px',
                              padding: '0.05rem 0.4rem',
                              fontSize: '0.62rem',
                              fontWeight: '700',
                            }}>
                              {selectedOccasionalCount}
                            </span>
                          )}
                        </span>
                        <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                          {showOccasionalGuestsInSelector ? '▲' : '▼'}
                        </span>
                      </button>
                      {showOccasionalGuestsInSelector && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                          {occasionalList.map(player => renderPlayerPill(player, true))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </>
          );
        })()}
      </div>

      {/* Head-to-Head Player Selection */}
      {viewMode === 'headToHead' && (
        <div className="card" style={{ padding: '0.75rem' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: '600', marginBottom: '0.5rem' }}>
            {t('graphs.select2Players')}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <StyledSelect<string>
                value={player1Id}
                onChange={setPlayer1Id}
                options={comparisonPlayerOptions.filter(o => o.value !== player2Id)}
                variant="green"
                size="md"
                fullWidth
                title={t('graphs.select2Players')}
              />
            </div>
            <button
              type="button"
              onClick={() => {
                setPlayer1Id(player2Id);
                setPlayer2Id(player1Id);
              }}
              title={t('graphs.swapPlayers')}
              style={{
                background: 'none',
                border: 'none',
                fontSize: '1.2rem',
                fontWeight: '700',
                cursor: 'pointer',
                padding: '0.2rem',
                lineHeight: 1,
                flexShrink: 0,
              }}
            >
              🆚
            </button>
            <div style={{ flex: 1, minWidth: 0 }}>
              <StyledSelect<string>
                value={player2Id}
                onChange={setPlayer2Id}
                options={comparisonPlayerOptions.filter(o => o.value !== player1Id)}
                variant="green"
                size="md"
                fullWidth
                title={t('graphs.select2Players')}
              />
            </div>
          </div>
        </div>
      )}

      {/* CUMULATIVE PROFIT CHART */}
      {viewMode === 'cumulative' && cumulativeData.length > 0 && (
        <div ref={chartRef} className="card" style={{ animation: 'scaleIn 0.3s ease-out' }}>
          <h2 className="card-title mb-2">{t('graphs.cumulativeProfit')}</h2>
          <div style={{ 
            fontSize: '0.7rem', 
            color: 'var(--text-muted)',
            textAlign: 'center',
            marginBottom: '0.4rem' 
          }}>
            {getTimeframeLabel()} • {filteredGames.length} {t('common.games')}
          </div>

          {selectedPlayers.size === 0 ? (
            <div style={{ textAlign: 'center', padding: '2rem 1rem', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
              <p style={{ marginBottom: '0.6rem' }}>{t('graphs.selectAtLeastOne')}</p>
              <button
                type="button"
                onClick={selectAllPermanent}
                className="btn btn-sm btn-secondary"
                style={{ fontSize: '0.75rem' }}
              >
                {t('graphs.selectRegularsOnly')}
              </button>
            </div>
          ) : (
            <>
              {/* Mobile-friendly pinned scrub bar (never covers the chart) */}
              {(() => {
                const activePoint = activeCumulativeIdx !== null ? cumulativeData[activeCumulativeIdx] : null;
                if (!activePoint) {
                  return (
                    <div style={{
                      fontSize: '0.65rem',
                      color: 'var(--text-muted)',
                      textAlign: 'center',
                      padding: '0.28rem 0.5rem',
                      marginBottom: '0.35rem',
                      opacity: 0.75,
                    }}>
                      {t('graphs.tapHint')}
                    </div>
                  );
                }

                const byPlayer = gamePlayersByGameId.get(activePoint.gameId);

                return (
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '0.4rem',
                    padding: '0.35rem 0.55rem',
                    marginBottom: '0.35rem',
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    fontSize: '0.7rem',
                    flexWrap: 'wrap',
                  }}>
                    <span style={{ color: 'var(--text-muted)', fontWeight: '600', whiteSpace: 'nowrap' }}>
                      {t('graphs.gameNum', { n: activePoint.gameIndex })} • {activePoint.date}
                    </span>
                    {highlightedPlayerIds.length > 0 ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                        {highlightedPlayerIds.map(focusId => {
                          const cumVal = Number(activePoint[focusId] ?? 0);
                          const gp = byPlayer?.get(focusId);
                          const color = getPlayerColor(focusId);
                          return (
                            <div key={focusId} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                              <span style={{ color, fontWeight: '700' }}>{getPlayerName(focusId)}</span>
                              <span style={{
                                fontWeight: '700',
                                color: cumVal > 0 ? '#10B981' : cumVal < 0 ? '#EF4444' : 'var(--text)',
                                direction: 'ltr',
                              }}>
                                {cumVal > 0 ? '+' : ''}{cleanNumber(cumVal)}
                              </span>
                              <span style={{ fontSize: '0.62rem', color: 'var(--text-muted)' }}>
                                ({gp
                                  ? `${gp.profit > 0 ? '+' : ''}${cleanNumber(gp.profit)}`
                                  : t('graphs.didNotPlay')})
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                        {[...sortedPlayerIds]
                          .sort((a, b) => Number(activePoint[b] ?? 0) - Number(activePoint[a] ?? 0))
                          .slice(0, 3)
                          .map(pid => {
                            const val = Number(activePoint[pid] ?? 0);
                            return (
                              <span key={pid} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                                <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: getPlayerColor(pid) }} />
                                <span style={{ color: getPlayerColor(pid), fontWeight: '600' }}>{getPlayerName(pid)}</span>
                                <span style={{ fontWeight: '700', color: val > 0 ? '#10B981' : val < 0 ? '#EF4444' : 'var(--text-muted)', direction: 'ltr' }}>
                                  {val > 0 ? '+' : ''}{cleanNumber(val)}
                                </span>
                              </span>
                            );
                          })}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => setActiveCumulativeIdx(null)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--text-muted)',
                        cursor: 'pointer',
                        fontSize: '0.75rem',
                        padding: '0 0.2rem',
                        lineHeight: 1,
                      }}
                      aria-label="Clear"
                    >
                      ✕
                    </button>
                  </div>
                );
              })()}

              <div style={{ 
                width: '100%', 
                height: '320px',
                marginLeft: '-10px',
              }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart 
                    data={cumulativeData} 
                    margin={{ top: 10, right: 12, left: 0, bottom: 10 }}
                    onMouseMove={(state) => {
                      const rawIdx = state?.activeTooltipIndex;
                      const idx = typeof rawIdx === 'number' ? rawIdx : typeof rawIdx === 'string' ? parseInt(rawIdx, 10) : NaN;
                      if (!Number.isNaN(idx) && idx >= 0 && idx < cumulativeData.length) {
                        setActiveCumulativeIdx(idx);
                      }
                    }}
                    onMouseLeave={() => setActiveCumulativeIdx(null)}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.5} />
                    <XAxis 
                      dataKey="gameIndex" 
                      ticks={cumulativeXAxisTicks}
                      tickFormatter={(idx) => cumulativeData[Number(idx) - 1]?.shortDate || ''}
                      padding={{ left: 8, right: 8 }}
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
                    <Tooltip
                      content={() => null}
                      cursor={{ stroke: 'var(--text-muted)', strokeDasharray: '3 3', strokeWidth: 1 }}
                    />
                    <ReferenceLine y={0} stroke="var(--text-muted)" strokeDasharray="3 3" />
                    {sortedPlayerIds.map((playerId) => {
                      const hasHighlight = highlightedPlayerIds.length > 0;
                      const isHighlighted = highlightedPlayerIds.includes(playerId);
                      const isDimmed = hasHighlight && !isHighlighted;
                      return (
                        <Line
                          key={playerId}
                          type="monotone"
                          dataKey={playerId}
                          name={getPlayerName(playerId)}
                          stroke={getPlayerColor(playerId)}
                          strokeWidth={isHighlighted ? 3.5 : isDimmed ? 1.5 : 2}
                          strokeOpacity={isDimmed ? 0.16 : 1}
                          dot={false}
                          activeDot={isDimmed ? false : { r: isHighlighted ? 5 : 3.5, strokeWidth: 0 }}
                        />
                      );
                    })}
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <CustomLegend />

              {/* Focused player(s) quick summary strip: Peak/Trough + Turning Point + H2H shortcut */}
              {highlightedPlayerIds.length === 1 && (() => {
                const summary = trendAnalysis.playerSummaries.get(highlightedPlayerIds[0]);
                if (!summary) return null;
                return (
                  <div style={{
                    marginTop: '0.5rem',
                    padding: '0.45rem 0.6rem',
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    fontSize: '0.7rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.25rem',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.4rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                        <span>
                          <span style={{ color: 'var(--text-muted)' }}>{t('graphs.peakLabel')} </span>
                          <span style={{ color: '#10B981', fontWeight: '700', direction: 'ltr', unicodeBidi: 'isolate' }}>
                            {summary.peakProfit > 0 ? '\u200E+' : ''}{cleanNumber(summary.peakProfit)}
                          </span>
                          <span style={{ color: 'var(--text-muted)', fontSize: '0.62rem' }}> ({summary.peakDate})</span>
                        </span>
                        <span>
                          <span style={{ color: 'var(--text-muted)' }}>{t('graphs.troughLabel')} </span>
                          <span style={{ color: '#EF4444', fontWeight: '700', direction: 'ltr', unicodeBidi: 'isolate' }}>
                            {'\u200E'}{cleanNumber(summary.troughProfit)}
                          </span>
                          <span style={{ color: 'var(--text-muted)', fontSize: '0.62rem' }}> ({summary.troughDate})</span>
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setHighlightedPlayerIds([])}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--text-muted)',
                          fontSize: '0.65rem',
                          cursor: 'pointer',
                          textDecoration: 'underline',
                          padding: 0,
                        }}
                      >
                        {t('graphs.clearFocus')}
                      </button>
                    </div>
                    {summary.turningPoint && (
                      <div style={{ color: 'var(--text)', fontSize: '0.68rem' }}>
                        📍 מפנה ב-{summary.turningPoint.date}: {summary.turningPoint.hint}
                      </div>
                    )}
                    {summary.contextHint && (
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.66rem' }}>
                        👥 {summary.contextHint}
                      </div>
                    )}
                  </div>
                );
              })()}

              {highlightedPlayerIds.length === 2 && (
                <div style={{
                  marginTop: '0.5rem',
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                  gap: '0.6rem',
                }}>
                  <button
                    type="button"
                    onClick={() => {
                      setPlayer1Id(highlightedPlayerIds[0]);
                      setPlayer2Id(highlightedPlayerIds[1]);
                      setViewMode('headToHead');
                    }}
                    style={{
                      fontSize: '0.7rem',
                      padding: '0.28rem 0.65rem',
                      borderRadius: '999px',
                      border: '1px solid rgba(16, 185, 129, 0.4)',
                      background: 'rgba(16, 185, 129, 0.12)',
                      color: '#34d399',
                      fontWeight: '600',
                      cursor: 'pointer',
                    }}
                  >
                    🆚 {t('graphs.openInH2H')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setHighlightedPlayerIds([])}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'var(--text-muted)',
                      fontSize: '0.68rem',
                      cursor: 'pointer',
                      textDecoration: 'underline',
                    }}
                  >
                    {t('graphs.clearFocus')}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
      {viewMode === 'cumulative' && cumulativeData.length > 0 && selectedPlayers.size > 0 && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: '-0.5rem', marginBottom: '0.5rem' }}>
          <button
            onClick={() => handleShareSection(chartRef, setIsSharingChart, 'cumulative-profit')}
            disabled={isSharingChart}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem', fontSize: '0.75rem', padding: '0.4rem 0.8rem', background: 'var(--surface)', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: '6px', cursor: 'pointer' }}
          >
            {isSharingChart ? t('common.capturing') : t('common.share')}
          </button>
        </div>
      )}

      {/* 🔎 TABLE TREND ANALYSIS CARD (headline + tap-to-expand evidence) */}
      {viewMode === 'cumulative' && trendAnalysis.conclusions.length > 0 && (
        <div className="card" style={{ padding: '0.85rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.55rem', gap: '0.4rem' }}>
            <h2 className="card-title" style={{ margin: 0 }}>{t('graphs.trendAnalysis')}</h2>
            <span style={{ fontSize: '0.62rem', color: 'var(--text-muted)' }}>
              {t('graphs.trendAnalysisHint')}
            </span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
            {trendAnalysis.conclusions.map(c => {
              const isExpanded = expandedConclusionId === c.id;
              const isFocused =
                c.focusPlayerIds.length > 0 &&
                highlightedPlayerIds.length === c.focusPlayerIds.length &&
                c.focusPlayerIds.every(id => highlightedPlayerIds.includes(id));

              return (
                <div
                  key={c.id}
                  style={{
                    borderRadius: '8px',
                    background: isExpanded ? 'rgba(139, 92, 246, 0.08)' : 'var(--surface)',
                    border: isExpanded ? '1px solid rgba(139, 92, 246, 0.35)' : '1px solid var(--border)',
                    overflow: 'hidden',
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setExpandedConclusionId(prev => prev === c.id ? null : c.id)}
                    style={{
                      width: '100%',
                      padding: '0.55rem 0.65rem',
                      background: 'none',
                      border: 'none',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '0.5rem',
                      cursor: 'pointer',
                      textAlign: 'start',
                      color: 'var(--text)',
                    }}
                  >
                    <span style={{ fontSize: '0.78rem', fontWeight: '700', lineHeight: 1.35 }}>
                      {c.icon} {c.headline}
                    </span>
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', flexShrink: 0 }}>
                      {isExpanded ? '▲' : '▼'}
                    </span>
                  </button>

                  {isExpanded && (
                    <div style={{
                      padding: '0 0.65rem 0.6rem',
                      borderTop: '1px solid var(--border)',
                      marginTop: '0.1rem',
                      paddingTop: '0.45rem',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.28rem',
                    }}>
                      {c.evidence.map((line, i) => (
                        <div key={i} style={{ fontSize: '0.7rem', color: 'var(--text-muted)', lineHeight: 1.45, display: 'flex', gap: '0.35rem' }}>
                          <span style={{ color: '#A78BFA', flexShrink: 0 }}>•</span>
                          <span>{line}</span>
                        </div>
                      ))}

                      {c.focusPlayerIds.length > 0 && (
                        <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.35rem', flexWrap: 'wrap' }}>
                          <button
                            type="button"
                            onClick={() => focusSignalPlayers(c.focusPlayerIds)}
                            style={{
                              fontSize: '0.68rem',
                              padding: '0.24rem 0.55rem',
                              borderRadius: '999px',
                              border: isFocused ? '1px solid rgba(139, 92, 246, 0.5)' : '1px solid var(--border)',
                              background: isFocused ? 'rgba(139, 92, 246, 0.16)' : 'var(--card)',
                              color: isFocused ? '#C4B5FD' : 'var(--text)',
                              fontWeight: '600',
                              cursor: 'pointer',
                            }}
                          >
                            🎯 {isFocused ? t('graphs.clearFocus') : t('graphs.highlightOnChart')}
                          </button>
                          {c.focusPlayerIds.length === 2 && (
                            <button
                              type="button"
                              onClick={() => {
                                setPlayer1Id(c.focusPlayerIds[0]);
                                setPlayer2Id(c.focusPlayerIds[1]);
                                setViewMode('headToHead');
                              }}
                              style={{
                                fontSize: '0.68rem',
                                padding: '0.24rem 0.55rem',
                                borderRadius: '999px',
                                border: '1px solid rgba(16, 185, 129, 0.4)',
                                background: 'rgba(16, 185, 129, 0.1)',
                                color: '#34d399',
                                fontWeight: '600',
                                cursor: 'pointer',
                              }}
                            >
                              🆚 {t('graphs.openInH2H')}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 🤖 AI GRAPH INSIGHTS */}
      {viewMode === 'cumulative' && (insightsText || insightsLoading || !!role || isSuperAdmin) && (
        <div ref={insightsRef} className="card" style={{ animation: 'contentFadeIn 0.3s ease-out 0.15s backwards' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <h2 className="card-title" style={{ margin: 0 }}>{t('graphs.aiInsights')}</h2>
            {/* Hide the generate/regenerate button when this group can't
                actually call the AI. Without this gate the user taps a
                live-looking button and gets a silent no-op (see the
                early-return in `handleGenerateInsights` for `!apiKey`).
                The friendly <AIKeyMissingNotice/> renders just below
                instead, so the screen still explains what they're
                missing and how to enable it. */}
            {canUseAI && !insightsLoading && filteredGames.length > 0 && getGeminiApiKey() && (
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
                {insightsText ? t('graphs.recreateInsights') : t('graphs.createInsights')}
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
              {t('graphs.generatingInsights')}
              <AIProgressBar operationKey="graph_insights" />
            </div>
          )}

          {/* Friendly empty state when AI is unavailable for the current
              group (no per-group key + not the platform-owner group).
              Renders BEFORE the user clicks "Create insights" so they
              know why the auto-generate path was silently skipped. */}
          {!insightsText && !insightsLoading && !insightsError && !insightsProxyDown && !getGeminiApiKey() && (
            <AIKeyMissingNotice feature="insights" accent="#8B5CF6" style={{ marginBottom: '0.5rem' }} />
          )}

          {/* Proxy unreachable in this environment (typically: localhost
              dev — /api/* only runs on Vercel). Shown after a failed
              call so we don't preemptively block users running
              `vercel dev`, which DOES serve /api on localhost. */}
          {insightsProxyDown && !insightsLoading && (
            <AIKeyMissingNotice feature="insights" reason="proxyUnavailable" style={{ marginBottom: '0.5rem' }} />
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
                textAlign: 'start',
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
                  {t('graphs.generatedLabel')} {new Date(insightsGeneratedAt).toLocaleDateString(language === 'he' ? 'he-IL' : 'en-US', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  {insightsModelName && ` · model: ${insightsModelName}`}
                </div>
              )}
            </>
          )}

          {!insightsText && !insightsLoading && !insightsError && role !== 'admin' && !isSuperAdmin && !isOwner && (
            <div style={{
              textAlign: 'center',
              padding: '1rem',
              color: 'var(--text-muted)',
              fontSize: '0.75rem',
            }}>
              {t('graphs.noInsights')}
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
            {isSharingInsights ? t('common.capturing') : t('common.share')}
          </button>
        </div>
      )}

      {/* HEAD-TO-HEAD COMPARISON */}
      {viewMode === 'headToHead' && headToHeadData && headToHeadData.sharedGamesCount === 0 && (
        <div className="card">
          <div className="empty-state">
            <div className="empty-icon">🆚</div>
            <p>{t('graphs.noSharedGames')}</p>
            <p className="text-muted">{getTimeframeLabel()}</p>
          </div>
        </div>
      )}
      {viewMode === 'headToHead' && headToHeadData && headToHeadData.sharedGamesCount > 0 && (
        <>
          <div ref={h2hShareRef}>
          {/* Stats Comparison */}
          <div className="card">
            <h2 className="card-title mb-2">{t('graphs.statsComparison')}</h2>
            <div style={{ 
              fontSize: '0.75rem', 
              color: 'var(--text-muted)', 
              marginBottom: '0.75rem',
              textAlign: 'center' 
            }}>
              {t('graphs.sharedGames', {
                label: getTimeframeLabel(),
                shared: headToHeadData.sharedGamesCount,
                total: headToHeadData.totalGamesInPeriod,
              })}
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
                  textAlign: isRTL ? 'left' : 'right',
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
                  {t('graphs.totalProfit')}
                  <div style={{ fontSize: '0.55rem', fontWeight: '400', opacity: 0.7, marginTop: '1px' }}>{t('graphs.totalInShared')}</div>
                </div>
                <div style={{ 
                  flex: 1, 
                  textAlign: isRTL ? 'right' : 'left',
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
                  textAlign: isRTL ? 'left' : 'right',
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
                  {t('graphs.winsLabel')}
                  <div style={{ fontSize: '0.55rem', fontWeight: '400', opacity: 0.7, marginTop: '1px' }}>{t('graphs.winsInShared')}</div>
                </div>
                <div style={{ 
                  flex: 1, 
                  textAlign: isRTL ? 'right' : 'left',
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
                  textAlign: isRTL ? 'left' : 'right',
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
                  {t('graphs.avgPerGame')}
                  <div style={{ fontSize: '0.55rem', fontWeight: '400', opacity: 0.7, marginTop: '1px' }}>{t('graphs.avgSharedGame')}</div>
                </div>
                <div style={{ 
                  flex: 1, 
                  textAlign: isRTL ? 'right' : 'left',
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
                  textAlign: isRTL ? 'left' : 'right',
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
                  {t('graphs.biggestWin')}
                  <div style={{ fontSize: '0.55rem', fontWeight: '400', opacity: 0.7, marginTop: '1px' }}>{t('graphs.bigWinDesc')}</div>
                </div>
                <div style={{ 
                  flex: 1, 
                  textAlign: isRTL ? 'right' : 'left',
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
                  textAlign: isRTL ? 'left' : 'right',
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
                  {t('graphs.biggestLoss')}
                  <div style={{ fontSize: '0.55rem', fontWeight: '400', opacity: 0.7, marginTop: '1px' }}>{t('graphs.bigLossDesc')}</div>
                </div>
                <div style={{ 
                  flex: 1, 
                  textAlign: isRTL ? 'right' : 'left',
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
            <h2 className="card-title mb-2">{t('graphs.directBattles')}</h2>
            <div style={{ 
              fontSize: '0.7rem', 
              color: 'var(--text-muted)',
              textAlign: 'center',
              marginBottom: '0.75rem' 
            }}>
              {t('graphs.whoOutperformed')}
            </div>
            
            {/* Battle bar visualization */}
            <div style={{ 
              display: 'flex', 
              alignItems: 'center',
              gap: '0.5rem',
              marginBottom: '0.75rem',
            }}>
              <span style={{ fontWeight: '700', color: '#10B981', minWidth: '30px', textAlign: isRTL ? 'left' : 'right' }}>
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
              <span style={{ fontWeight: '700', color: '#3B82F6', minWidth: '30px', textAlign: isRTL ? 'right' : 'left' }}>
                {headToHeadData.directBattles.player2Wins}
              </span>
            </div>
            
            {/* Battle stats */}
            {(() => {
              const total = headToHeadData.sharedGamesCount;
              const p1Pct = total > 0 ? (headToHeadData.directBattles.player1Wins / total) * 100 : 0;
              const p2Pct = total > 0 ? (headToHeadData.directBattles.player2Wins / total) * 100 : 0;
              const tiesPct = total > 0 ? (headToHeadData.directBattles.ties / total) * 100 : 0;
              const needDecimal = Math.round(p1Pct) === Math.round(p2Pct) && headToHeadData.directBattles.player1Wins !== headToHeadData.directBattles.player2Wins;
              const fmt = (v: number) => needDecimal ? v.toFixed(1) : `${Math.round(v)}`;
              return (
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
                      {fmt(p1Pct)}%
                    </div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.65rem' }}>{t('graphs.winRateLabel')}</div>
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ color: 'var(--text-muted)', fontWeight: '600' }}>
                      {t('graphs.ties', { count: headToHeadData.directBattles.ties })}
                    </div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.65rem' }}>
                      ({Math.round(tiesPct)}%)
                    </div>
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ color: '#3B82F6', fontWeight: '700', fontSize: '1.1rem' }}>
                      {fmt(p2Pct)}%
                    </div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.65rem' }}>{t('graphs.winRateLabel')}</div>
                  </div>
                </div>
              );
            })()}
          </div>

          {/* 🔥 RECENT FORM */}
          {headToHeadData.recentForm.length > 0 && (
            <div className="card">
              <h2 className="card-title mb-2">{t('graphs.recentForm')}</h2>
              <div style={{ 
                fontSize: '0.7rem', 
                color: 'var(--text-muted)',
                textAlign: 'center',
                marginBottom: '0.75rem' 
              }}>
                {t('graphs.lastShared', { n: headToHeadData.recentForm.length })}
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
                      textAlign: isRTL ? 'left' : 'right',
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
                      textAlign: isRTL ? 'right' : 'left',
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
                    {t('graphs.winsCount', { n: headToHeadData.recentForm.filter(g => g.winner === 'p1').length })}
                  </div>
                </div>
                <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                  {t('graphs.lastShared', { n: headToHeadData.recentForm.length })}
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ color: '#3B82F6', fontWeight: '700' }}>
                    {t('graphs.winsCount', { n: headToHeadData.recentForm.filter(g => g.winner === 'p2').length })}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 📊 SESSION DISTRIBUTION & VOLATILITY */}
          <div className="card">
            <h2 className="card-title mb-2">{t('graphs.playStyle')}</h2>
            
            {/* Session Distribution */}
            <div style={{ marginBottom: '1rem' }}>
              <div style={{ 
                fontSize: '0.7rem', 
                color: 'var(--text-muted)',
                marginBottom: '0.5rem',
                fontWeight: '600',
              }}>
                {t('graphs.sessionDist')}
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
                <span><span style={{ color: '#10B981' }}>■</span> {t('graphs.bigWin')}</span>
                <span><span style={{ color: '#6EE7B7' }}>■</span> {t('graphs.win')}</span>
                <span><span style={{ color: '#FCA5A5' }}>■</span> {t('graphs.lossRange')}</span>
                <span><span style={{ color: '#EF4444' }}>■</span> {t('graphs.bigLoss')}</span>
              </div>
              
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {/* Player 1 distribution */}
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '0.65rem', color: '#10B981', fontWeight: '600', marginBottom: '0.25rem', textAlign: 'center' }}>
                    {headToHeadData.player1Stats.playerName}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                      <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', width: '45px' }}>{t('graphs.bigWinShort')}</span>
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
                      <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', width: '45px' }}>{t('graphs.winShort')}</span>
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
                      <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', width: '45px' }}>{t('graphs.lossShort')}</span>
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
                      <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', width: '45px' }}>{t('graphs.bigLossShort')}</span>
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
                      <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', width: '45px' }}>{t('graphs.bigWinShort')}</span>
                      <div style={{ flex: 1, height: '12px', background: 'var(--surface)', borderRadius: '6px', overflow: 'hidden' }}>
                        <div style={{ 
                          width: `${headToHeadData.sharedGamesCount > 0 ? (headToHeadData.distribution.p2.bigWin / headToHeadData.sharedGamesCount) * 100 : 0}%`,
                          height: '100%',
                          background: '#10B981',
                        }} />
                      </div>
                      <span style={{ fontSize: '0.65rem', fontWeight: '600', minWidth: '18px' }}>{headToHeadData.distribution.p2.bigWin}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                      <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', width: '45px' }}>{t('graphs.winShort')}</span>
                      <div style={{ flex: 1, height: '12px', background: 'var(--surface)', borderRadius: '6px', overflow: 'hidden' }}>
                        <div style={{ 
                          width: `${headToHeadData.sharedGamesCount > 0 ? (headToHeadData.distribution.p2.smallWin / headToHeadData.sharedGamesCount) * 100 : 0}%`,
                          height: '100%',
                          background: '#6EE7B7',
                        }} />
                      </div>
                      <span style={{ fontSize: '0.65rem', fontWeight: '600', minWidth: '18px' }}>{headToHeadData.distribution.p2.smallWin}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                      <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', width: '45px' }}>{t('graphs.lossShort')}</span>
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
                      <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', width: '45px' }}>{t('graphs.bigLossShort')}</span>
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
                {t('graphs.volatility')}
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
                    {headToHeadData.volatility.p1 <= headToHeadData.volatility.p2 ? t('graphs.moreConsistent') : t('graphs.moreVolatile')}
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
                    {headToHeadData.volatility.p2 <= headToHeadData.volatility.p1 ? t('graphs.moreConsistent') : t('graphs.moreVolatile')}
                  </div>
                </div>
              </div>
              <div style={{ 
                fontSize: '0.55rem', 
                color: 'var(--text-muted)',
                textAlign: 'center',
                marginTop: '0.4rem',
              }}>
                {t('graphs.volatilityDesc')}
              </div>
            </div>

            {/* Win rate with the opponent at the table vs without him */}
            <div style={{
              padding: '0.5rem',
              background: 'var(--surface)',
              borderRadius: '8px',
              marginTop: '0.75rem',
            }}>
              <div style={{
                fontSize: '0.7rem',
                color: 'var(--text-muted)',
                marginBottom: '0.5rem',
                fontWeight: '600',
                textAlign: 'center',
              }}>
                {t('graphs.presenceWinRate')}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-around' }}>
                {[
                  {
                    split: headToHeadData.winRateSplit.p1,
                    other: headToHeadData.player2Stats.playerName,
                    color: '#10B981',
                  },
                  {
                    split: headToHeadData.winRateSplit.p2,
                    other: headToHeadData.player1Stats.playerName,
                    color: '#3B82F6',
                  },
                ].map(({ split, other, color }, i) => {
                  const delta = split.withPct !== null && split.withoutPct !== null
                    ? split.withPct - split.withoutPct
                    : null;
                  return (
                    <div key={other} style={{
                      textAlign: 'center',
                      flex: 1,
                      borderInlineStart: i === 1 ? '1px solid var(--border)' : undefined,
                    }}>
                      <div style={{ fontSize: '1rem', fontWeight: '700', color }}>
                        {split.withPct !== null ? `${split.withPct}%` : '—'}
                      </div>
                      <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                        {t('graphs.presenceWith', { name: other, n: split.withGames })}
                      </div>
                      <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                        {split.withoutPct !== null
                          ? t('graphs.presenceWithout', { name: other, pct: split.withoutPct, n: split.withoutGames })
                          : t('graphs.presenceNoSolo', { name: other })}
                      </div>
                      {delta !== null && delta !== 0 && (
                        <div style={{
                          fontSize: '0.65rem',
                          fontWeight: '700',
                          marginTop: '0.2rem',
                          color: delta > 0 ? '#10B981' : '#EF4444',
                        }}>
                          {delta > 0 ? '▲' : '▼'} {Math.abs(delta)}%
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <div style={{
                fontSize: '0.55rem',
                color: 'var(--text-muted)',
                textAlign: 'center',
                marginTop: '0.4rem',
              }}>
                {t('graphs.presenceWinRateDesc')}
              </div>
            </div>
          </div>

          {/* Cumulative Comparison Chart */}
          {headToHeadData.cumulativeComparison.length > 0 && (
            <div className="card">
              <h2 className="card-title mb-2">{t('graphs.cumulativeComparison')}</h2>

              {/* Mobile-friendly pinned scrub bar for H2H */}
              {(() => {
                const activePt = activeH2HIdx !== null ? headToHeadData.cumulativeComparison[activeH2HIdx] : null;
                if (!activePt) return null;
                const gap = Math.abs(activePt.p1 - activePt.p2);
                return (
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '0.4rem',
                    padding: '0.35rem 0.55rem',
                    marginBottom: '0.4rem',
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    borderRadius: '8px',
                    fontSize: '0.7rem',
                    flexWrap: 'wrap',
                  }}>
                    <span style={{ color: 'var(--text-muted)', fontWeight: '600' }}>
                      {t('graphs.gameNum', { n: activePt.gameIndex })} • {activePt.date}
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <span style={{ color: '#10B981', fontWeight: '700', direction: 'ltr' }}>
                        {activePt.p1 > 0 ? '+' : ''}{cleanNumber(activePt.p1)}
                      </span>
                      <span style={{ color: 'var(--text-muted)' }}>|</span>
                      <span style={{ color: '#3B82F6', fontWeight: '700', direction: 'ltr' }}>
                        {activePt.p2 > 0 ? '+' : ''}{cleanNumber(activePt.p2)}
                      </span>
                      <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
                        ({t('graphs.gapLabel', { val: cleanNumber(gap) })})
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setActiveH2HIdx(null)}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--text-muted)',
                        cursor: 'pointer',
                        fontSize: '0.75rem',
                        padding: '0 0.2rem',
                        lineHeight: 1,
                      }}
                      aria-label="Clear"
                    >
                      ✕
                    </button>
                  </div>
                );
              })()}

              <div style={{ 
                width: '100%', 
                height: '280px',
                marginLeft: '-10px',
              }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart 
                    data={headToHeadData.cumulativeComparison} 
                    margin={{ top: 10, right: 12, left: 0, bottom: 10 }}
                    onMouseMove={(state) => {
                      const rawIdx = state?.activeTooltipIndex;
                      const idx = typeof rawIdx === 'number' ? rawIdx : typeof rawIdx === 'string' ? parseInt(rawIdx, 10) : NaN;
                      if (!Number.isNaN(idx) && idx >= 0 && idx < headToHeadData.cumulativeComparison.length) {
                        setActiveH2HIdx(idx);
                      }
                    }}
                    onMouseLeave={() => setActiveH2HIdx(null)}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" opacity={0.5} />
                    <XAxis 
                      dataKey="gameIndex" 
                      ticks={h2hXAxisTicks}
                      tickFormatter={(idx) => headToHeadData.cumulativeComparison[Number(idx) - 1]?.shortDate || ''}
                      padding={{ left: 8, right: 8 }}
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
                    <Tooltip
                      content={() => null}
                      cursor={{ stroke: 'var(--text-muted)', strokeDasharray: '3 3', strokeWidth: 1 }}
                    />
                    <ReferenceLine y={0} stroke="var(--text-muted)" strokeDasharray="3 3" />
                    <Line
                      type="monotone"
                      dataKey="p1"
                      name={headToHeadData.player1Stats.playerName}
                      stroke="#10B981"
                      strokeWidth={3}
                      dot={false}
                      activeDot={{ r: 5 }}
                    />
                    <Line
                      type="monotone"
                      dataKey="p2"
                      name={headToHeadData.player2Stats.playerName}
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
                {t('graphs.onlySharedGames')}
              </div>
            </div>
          )}
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: '-0.5rem', marginBottom: '0.5rem' }}>
            <button
              onClick={() => handleShareSection(h2hShareRef, setIsSharingH2H, 'head-to-head')}
              disabled={isSharingH2H}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem', fontSize: '0.75rem', padding: '0.4rem 0.8rem', background: 'var(--surface)', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: '6px', cursor: 'pointer' }}
            >
              {isSharingH2H ? t('common.capturing') : t('common.share')}
            </button>
          </div>
        </>
      )}

      {/* IMPACT VIEW */}
      {viewMode === 'impact' && (
        <>
          {/* Player Selector */}
          <div className="card" style={{ padding: '0.75rem' }}>
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: '0.5rem',
              gap: '0.5rem',
            }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: '600' }}>
                {t('graphs.selectPlayer')}
              </span>
              {regularGuestsCount > 0 && (
                <button
                  type="button"
                  onClick={() => setIncludeGuestsInImpact(v => !v)}
                  style={{
                    padding: '0.22rem 0.55rem',
                    fontSize: '0.68rem',
                    fontWeight: '600',
                    borderRadius: '999px',
                    border: includeGuestsInImpact ? '1.5px solid var(--primary)' : '1px solid var(--border)',
                    background: includeGuestsInImpact ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
                    color: includeGuestsInImpact ? 'var(--primary)' : 'var(--text-muted)',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {includeGuestsInImpact ? '✓ ' : ''}{t('graphs.includeGuestsInComparison', { count: regularGuestsCount })}
                </button>
              )}
            </div>
            <StyledSelect<string>
              value={impactPlayerId}
              onChange={setImpactPlayerId}
              options={comparisonPlayerOptions}
              variant="green"
              size="md"
              fullWidth
              title={t('graphs.selectPlayer')}
            />
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
                        <div key={li} style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: li === 0 ? 0 : '0.12rem', lineHeight: '1.4', textAlign: 'start' }}>
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
                        {t('graphs.withCount', { n: row.withGames })}
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
                        {t('graphs.winRatePct', { n: Math.round(row.winRateWith) })}
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
                        {t('graphs.withoutCount', { n: row.withoutGames })}
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
                        {t('graphs.winRatePct', { n: Math.round(row.winRateWithout) })}
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
                    <span>{t('graphs.gamesTogether', { n: row.withGames })}</span>
                    <span>{t('graphs.gamesApart', { n: row.withoutGames })}</span>
                  </div>
                </div>
              );
            };

            return (
              <div className="card">
                <h2 className="card-title mb-2">{t('graphs.withVsWithout')}</h2>
                <div style={{ 
                  fontSize: '0.7rem', 
                  color: 'var(--text-muted)',
                  textAlign: 'center',
                  marginBottom: '0.75rem' 
                }}>
                  {t('graphs.howAvgChanges', { name: getPlayerName(impactPlayerId) })}
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
                      <span>{t('graphs.rarelyApart', { n: limited.length })}</span>
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
                <h2 className="card-title mb-2">{t('graphs.chemistry', { name: selectedName })}</h2>
                <div style={{ 
                  fontSize: '0.7rem', 
                  color: 'var(--text-muted)',
                  textAlign: 'center',
                  marginBottom: headlineInsights.length > 0 ? '0.35rem' : '0.75rem',
                }}>
                  {t('graphs.balancedSamples', { min: minGamesThreshold })}
                </div>
                {headlineInsights.length > 0 && (
                  <div style={{ marginBottom: '0.75rem' }}>
                    <div style={{ 
                      fontSize: '0.7rem', 
                      fontWeight: '700', 
                      color: '#A78BFA', 
                      marginBottom: '0.4rem',
                    }}>
                      {t('graphs.keyInsights')}
                    </div>
                    <div style={{
                      padding: '0.4rem 0.5rem',
                      background: 'rgba(139, 92, 246, 0.08)',
                      borderRadius: '6px',
                      fontSize: '0.75rem',
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
                    {t('graphs.luckyCharms')}
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
                                {' '}({t('graphs.gamesTogether', { n: row.withGames })})
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
                            <div key={li} style={{ display: 'flex', alignItems: 'baseline', gap: '0.25rem', fontSize: '0.7rem', color: 'var(--text)', marginTop: li === 0 ? '0.3rem' : '0.12rem', lineHeight: '1.4' }}>
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
                      {t('graphs.noLuckyCharm', { name: selectedName })}
                    </div>
                  )}
                  {rareLuckyCharms.length > 0 && (
                    <div style={{ marginTop: '0.45rem' }}>
                      <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                        {t('graphs.smallSample')}
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
                                    {' '}({t('graphs.gamesTogether', { n: row.withGames })})
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
                                <div key={li} style={{ display: 'flex', alignItems: 'baseline', gap: '0.25rem', fontSize: '0.7rem', color: 'var(--text)', marginTop: li === 0 ? '0.3rem' : '0.12rem', lineHeight: '1.4' }}>
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
                    {t('graphs.kryptonite')}
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
                                {' '}({t('graphs.gamesTogether', { n: row.withGames })})
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
                            <div key={li} style={{ display: 'flex', alignItems: 'baseline', gap: '0.25rem', fontSize: '0.7rem', color: 'var(--text)', marginTop: li === 0 ? '0.3rem' : '0.12rem', lineHeight: '1.4' }}>
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
                      {t('graphs.noKryptonite', { name: selectedName })}
                    </div>
                  )}
                  {rareKryptonite.length > 0 && (
                    <div style={{ marginTop: '0.45rem' }}>
                      <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>
                        {t('graphs.smallSample')}
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
                                    {' '}({t('graphs.gamesTogether', { n: row.withGames })})
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
                                <div key={li} style={{ display: 'flex', alignItems: 'baseline', gap: '0.25rem', fontSize: '0.7rem', color: 'var(--text)', marginTop: li === 0 ? '0.3rem' : '0.12rem', lineHeight: '1.4' }}>
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
            <p>{t('graphs.noDataForPeriod')}</p>
            <p className="text-muted">{t('graphs.tryDifferentFilter')}</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default GraphsScreen;
