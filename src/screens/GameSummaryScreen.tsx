import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { captureAndSplit } from '../utils/sharing';
import { GamePlayer, Settlement, SkippedTransfer, GameForecast, SharedExpense, PlayerStats, PeriodMarkers, Game } from '../types';
import { getGame, getGamePlayers, getSettings, getChipValues, getPlayerStats, getAllGames, getAllGamePlayers, getAllPlayers, saveForecastAccuracy, saveForecastComment, saveGameAiSummary, isPlayerFemale, updateGameStatus, invalidateAICaches, updateGame } from '../database/storage';
import { calculateSettlement, formatCurrency, cleanNumber, calculateCombinedSettlement, formatHebrewHalf } from '../utils/calculations';
import { generateForecastComparison, getGeminiApiKey, generateGameNightSummary, GameNightSummaryPayload, detectPeriodMarkers, buildLocationInsights, getModelDisplayName } from '../utils/geminiAI';
import { getComboHistory, buildComboHistoryText, ComboHistory } from '../utils/comboHistory';
import { speakHebrew, hebrewNum } from '../utils/tts';
import { usePermissions } from '../App';
import AIProgressBar from '../components/AIProgressBar';
import { withAITiming } from '../utils/aiTiming';

const GameSummaryScreen = () => {
  const { gameId } = useParams<{ gameId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const locationState = location.state as { 
    from?: string; 
    viewMode?: string;
    recordInfo?: { title: string; playerId: string; recordType: string };
    playerInfo?: { playerId: string; playerName: string };
    timePeriod?: string;
    selectedYear?: number;
    selectedMonth?: number;
    autoAI?: boolean;
  } | null;
  const cameFromRecords = locationState?.from === 'records';
  const cameFromPlayers = locationState?.from === 'players';
  const cameFromTable = locationState?.from === 'statistics';
  const cameFromStatistics = cameFromRecords || cameFromPlayers || cameFromTable;
  const cameFromChipEntry = locationState?.from === 'chip-entry';
  const { role, playerName: identityName } = usePermissions();
  const highlightName = cameFromChipEntry ? null : identityName;
  const [players, setPlayers] = useState<GamePlayer[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [skippedTransfers, setSkippedTransfers] = useState<SkippedTransfer[]>([]);
  const [gameDate, setGameDate] = useState('');
  const [chipGap, setChipGap] = useState<number | null>(null);
  const [chipGapPerPlayer, setChipGapPerPlayer] = useState<number | null>(null);
  
  const [isSharing, setIsSharing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [gameNotFound, setGameNotFound] = useState(false);
  const [forecasts, setForecasts] = useState<GameForecast[]>([]);
  const [forecastComment, setForecastComment] = useState<string | null>(null);
  const [isLoadingComment, setIsLoadingComment] = useState(false);
  const [sharedExpenses, setSharedExpenses] = useState<SharedExpense[]>([]);
  const [funStats, setFunStats] = useState<{ emoji: string; label: string; detail: string }[]>([]);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [aiSummaryModel, setAiSummaryModel] = useState<string>('');
  const [isLoadingAiSummary, setIsLoadingAiSummary] = useState(false);
  const [aiSummaryError, setAiSummaryError] = useState<string | null>(null);
  const [preGameTeaser, setPreGameTeaser] = useState<string | null>(null);
  const [showHistoricalForecast, setShowHistoricalForecast] = useState(false);
  const isPayModeInit = new URLSearchParams(location.search).get('pay') === '1';
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({ settlements: !isPayModeInit, forecast: true, expenses: true, aiSummary: true, combo: true, monthly: true, standings: true });
  const toggleSection = (key: string) => setCollapsedSections(prev => ({ ...prev, [key]: !prev[key] }));
  const forceGenerateRef = useRef(false);
  const summaryRef = useRef<HTMLDivElement>(null);
  const settlementsRef = useRef<HTMLDivElement>(null);
  const forecastCompareRef = useRef<HTMLDivElement>(null);
  const expenseSettlementsRef = useRef<HTMLDivElement>(null);
  const funStatsRef = useRef<HTMLDivElement>(null);
  const comboHistoryRef = useRef<HTMLDivElement>(null);
  const standingsRef = useRef<HTMLDivElement>(null);
  const [standingsData, setStandingsData] = useState<PlayerStats[]>([]);
  const [standingsLabel, setStandingsLabel] = useState('');
  const [previousRankMap, setPreviousRankMap] = useState<Record<string, number>>({});
  const [monthlyStats, setMonthlyStats] = useState<PlayerStats[]>([]);
  const [monthLabel, setMonthLabel] = useState('');
  const monthlyRef = useRef<HTMLDivElement>(null);
  const [comboHistory, setComboHistory] = useState<ComboHistory | null>(null);
  const [showReopenConfirm, setShowReopenConfirm] = useState(false);
  const [paidSettlements, setPaidSettlements] = useState<{ from: string; to: string; paidAt: string }[]>([]);
  const [paymentModal, setPaymentModal] = useState<{ from: string; to: string; amount: number } | null>(null);
  const settlementsSectionRef = useRef<HTMLDivElement>(null);
  const isPayMode = new URLSearchParams(location.search).get('pay') === '1';

  useEffect(() => {
    if (isPayMode && settlements.length > 0 && settlementsSectionRef.current) {
      setTimeout(() => {
        settlementsSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 500);
    }
  }, [isPayMode, settlements]);

  const handleReopenChipEntry = () => {
    if (!gameId) return;
    updateGameStatus(gameId, 'chip_entry');
    updateGame(gameId, { aiSummary: '', forecastComment: '', forecastAccuracy: undefined, chipGap: undefined, chipGapPerPlayer: undefined });
    invalidateAICaches();
    navigate(`/chip-entry/${gameId}`);
  };

  const isSettlementPaid = (from: string, to: string) =>
    paidSettlements.some(p => p.from === from && p.to === to);

  const toggleSettlementPaid = (from: string, to: string) => {
    if (!gameId) return;
    let updated: Game['paidSettlements'];
    if (isSettlementPaid(from, to)) {
      updated = paidSettlements.filter(p => !(p.from === from && p.to === to));
    } else {
      updated = [...paidSettlements, { from, to, paidAt: new Date().toISOString() }];
    }
    setPaidSettlements(updated || []);
    updateGame(gameId, { paidSettlements: updated });
  };

  const [amountCopied, setAmountCopied] = useState(false);

  const copyAmount = async (amount: number) => {
    const roundedAmount = Math.round(amount);
    try {
      await navigator.clipboard.writeText(String(roundedAmount));
      setAmountCopied(true);
      setTimeout(() => setAmountCopied(false), 2000);
    } catch { /* fallback: no clipboard */ }
  };

  const openPaymentApp = async (app: 'bit' | 'paybox', amount: number) => {
    await copyAmount(amount);
    setTimeout(() => {
      if (app === 'bit') {
        window.location.href = 'https://www.bitpay.co.il/app';
      } else {
        window.location.href = 'https://payboxapp.page.link/send';
      }
    }, 300);
  };

  const handleRegenerateAiSummary = () => {
    if (!gameId) return;
    saveGameAiSummary(gameId, '');
    setAiSummary(null);
    setAiSummaryError(null);
    setIsLoadingAiSummary(false);
    forceGenerateRef.current = true;
    loadData();
  };

  // Calculate total chips for a player
  const getTotalChips = (player: GamePlayer): number => {
    const chipValues = getChipValues();
    let total = 0;
    for (const [chipId, count] of Object.entries(player.chipCounts)) {
      const chip = chipValues.find(c => c.id === chipId);
      if (chip) {
        total += count * chip.value;
      }
    }
    return total;
  };

  useEffect(() => {
    if (gameId) {
      loadData();
    } else {
      setGameNotFound(true);
      setIsLoading(false);
    }
  }, [gameId]);

  const loadData = async () => {
    if (!gameId) {
      setGameNotFound(true);
      setIsLoading(false);
      return;
    }
    const game = getGame(gameId);
    const gamePlayers = getGamePlayers(gameId);
    
    if (!game || gamePlayers.length === 0) {
      setGameNotFound(true);
      setIsLoading(false);
      return;
    }
    
    const settings = getSettings();
    
    setGameDate(game.date);
    setPaidSettlements(game.paidSettlements || []);
    setChipGap(game.chipGap || null);
    setChipGapPerPlayer(game.chipGapPerPlayer || null);
    setPreGameTeaser(game.preGameTeaser || null);
    
    const sortedPlayers = gamePlayers.sort((a, b) => b.profit - a.profit);
    setPlayers(sortedPlayers);
    
    // Load shared expenses first
    const gameExpenses = game.sharedExpenses || [];
    if (gameExpenses.length > 0) {
      setSharedExpenses(gameExpenses);
    }
    
    // Calculate settlements - use COMBINED if there are expenses
    const gameDateStr = game.date || game.createdAt;
    const blockedPairs = settings.blockedTransfers;
    if (gameExpenses.length > 0) {
      const { settlements: settl, smallTransfers: small } = calculateCombinedSettlement(
        gamePlayers,
        gameExpenses,
        settings.minTransfer,
        gameDateStr,
        blockedPairs
      );
      setSettlements(settl);
      setSkippedTransfers(small);
    } else {
      const { settlements: settl, smallTransfers: small } = calculateSettlement(
        gamePlayers, 
        settings.minTransfer,
        gameDateStr,
        blockedPairs
      );
      setSettlements(settl);
      setSkippedTransfers(small);
    }
    
    // Load forecasts if available
    if (game.forecasts && game.forecasts.length > 0) {
      setForecasts(game.forecasts);
      
      // Compute and persist accuracy data if not already done
      if (!game.forecastAccuracy && game.status === 'completed') {
        saveForecastAccuracy(game.id);
      }
      
      // Use cached comment if available, otherwise generate and cache
      if (game.forecastComment) {
        setForecastComment(game.forecastComment);
      } else if (getGeminiApiKey()) {
        setIsLoadingComment(true);
        try {
          const comment = await withAITiming('forecast_comparison', () => generateForecastComparison(game.forecasts!, sortedPlayers));
          setForecastComment(comment);
          saveForecastComment(game.id, comment);
        } catch (err) {
          console.error('Error generating forecast comment:', err);
        } finally {
          setIsLoadingComment(false);
        }
      }
    }
    
    // Compute combo history for this game's player set (include tonight's game)
    const comboPlayerIds = gamePlayers.map(gp => gp.playerId);
    const combo = getComboHistory(comboPlayerIds);
    setComboHistory(combo);

    // Pre-load shared data once to avoid repeated localStorage parsing
    const cachedAllGames = getAllGames();
    const cachedAllGP = getAllGamePlayers();

    // Calculate highlights — prioritized, period-focused, always exactly 10
    type Highlight = { emoji: string; label: string; detail: string; priority: number };
    const bank: Highlight[] = [];
    const settings2 = getSettings();
    const totalRebuysTonight = sortedPlayers.reduce((sum, p) => sum + p.rebuys, 0);
    const tonightsPot = totalRebuysTonight * settings2.rebuyValue;

    // Determine period (H1/H2) based on the actual game date
    const actualGameDate = new Date(game.date);
    const periodMonth = actualGameDate.getMonth() + 1;
    const periodYear = actualGameDate.getFullYear();
    const periodStart = new Date(periodYear, periodMonth <= 6 ? 0 : 6, 1);
    const periodLabel = formatHebrewHalf(periodMonth <= 6 ? 1 : 2, periodYear);

    // --- Tonight's game highlights ---
    const pLabel = periodLabel;

    // 1. Rebuy King
    const maxRebuys = Math.max(...sortedPlayers.map(p => p.rebuys));
    const rebuyKings = sortedPlayers.filter(p => p.rebuys === maxRebuys);
    if (maxRebuys >= 5) {
      const names = rebuyKings.map(p => p.playerName).join(' ו');
      bank.push({ emoji: '👑', label: 'מלך הקניות', detail: `${names} — ${maxRebuys} קניות (${cleanNumber(maxRebuys * settings2.rebuyValue)})`, priority: 3 });
    }

    // 2. Comeback Win
    const comebackWinners = sortedPlayers.filter(p => p.profit > 0 && p.rebuys >= 5);
    if (comebackWinners.length > 0) {
      const parts = comebackWinners.sort((a, b) => b.rebuys - a.rebuys).map(p => `${p.playerName} (${p.rebuys} קניות, \u200E+${cleanNumber(p.profit)})`);
      bank.push({ emoji: '🔄', label: 'קאמבק', detail: parts.join(', '), priority: 2 });
    }

    // 3. Quiet Loser
    const losers = sortedPlayers.filter(p => p.profit < 0);
    if (losers.length > 0) {
      const minLoseRebuys = Math.min(...losers.map(p => p.rebuys));
      if (minLoseRebuys <= 2) {
        const quietLoser = losers.find(p => p.rebuys === minLoseRebuys);
        if (quietLoser) {
          bank.push({ emoji: '🤫', label: 'חוסר מזל', detail: `${quietLoser.playerName} — ${formatCurrency(quietLoser.profit)} עם ${quietLoser.rebuys} קניות בלבד`, priority: 4 });
        }
      }
    }

    // 4. Best ROI
    const winners = sortedPlayers.filter(p => p.profit > 0);
    if (winners.length >= 2) {
      const withROI = winners.map(p => ({
        ...p,
        roi: (p.profit / (p.rebuys * settings2.rebuyValue)) * 100
      }));
      const bestROI = [...withROI].sort((a, b) => b.roi - a.roi)[0];
      if (bestROI.roi >= 30) {
        bank.push({ emoji: '📈', label: 'תשואה הכי גבוהה', detail: `${bestROI.playerName} — ${Math.round(bestROI.roi)}%`, priority: 5 });
      }
    }

    // --- Period & historical highlights ---
    try {
      const allStats = getPlayerStats();
      const periodStats = getPlayerStats({ start: periodStart });
      const allGP = cachedAllGP;
      const previousGP = allGP.filter(gp => gp.gameId !== gameId);

      const periodGames = cachedAllGames.filter(g => {
        if (g.status !== 'completed' || g.id === gameId) return false;
        return new Date(g.date || g.createdAt) >= periodStart;
      });
      const periodGameIds = new Set(periodGames.map(g => g.id));
      const periodPrevGP = previousGP.filter(gp => periodGameIds.has(gp.gameId));

      // Collect candidates per highlight type
      const periodBestWins: { name: string; profit: number }[] = [];
      const periodWorstLosses: { name: string; profit: number }[] = [];
      const streaks: { name: string; streak: number; type: 'win' | 'loss' }[] = [];
      const upsets: { name: string; wp: number; type: 'win' | 'loss' }[] = [];
      const periodMilestones: { name: string; num: number }[] = [];
      const welcomeBacks: { name: string; days: number }[] = [];
      const firstInPeriod: string[] = [];
      const periodProfitMilestones: { name: string; amount: number }[] = [];
      const periodTurnarounds: { name: string; newTotal: number }[] = [];
      const periodSpenders: { name: string; rebuys: number }[] = [];
      const highWinRates: { name: string; wp: number; record: string }[] = [];
      const lowWinRates: { name: string; wp: number; record: string }[] = [];
      const rebuysAboveAvg: { name: string; tonight: number; avg: number }[] = [];

      for (const player of sortedPlayers) {
        const pStats = periodStats.find(s => s.playerId === player.playerId);
        const allTimeStats = allStats.find(s => s.playerId === player.playerId);
        const playerPeriodPrevGames = periodPrevGP.filter(gp => gp.playerId === player.playerId);

        if (player.profit > 0 && playerPeriodPrevGames.length >= 1) {
          const prevBestWin = Math.max(0, ...playerPeriodPrevGames.map(gp => gp.profit));
          if (player.profit > prevBestWin && prevBestWin > 0) {
            periodBestWins.push({ name: player.playerName, profit: player.profit });
          }
        }

        if (player.profit < 0 && playerPeriodPrevGames.length >= 1) {
          const prevWorstLoss = Math.min(0, ...playerPeriodPrevGames.map(gp => gp.profit));
          if (player.profit < prevWorstLoss && prevWorstLoss < 0) {
            periodWorstLosses.push({ name: player.playerName, profit: player.profit });
          }
        }

        if (pStats && pStats.currentStreak >= 4) {
          streaks.push({ name: player.playerName, streak: pStats.currentStreak, type: 'win' });
        } else if (pStats && pStats.currentStreak <= -4) {
          streaks.push({ name: player.playerName, streak: Math.abs(pStats.currentStreak), type: 'loss' });
        }

        if (pStats && pStats.gamesPlayed >= 4) {
          const wp = Math.round(pStats.winPercentage);
          if (wp >= 60 && player.profit < 0) upsets.push({ name: player.playerName, wp, type: 'loss' });
          else if (wp <= 30 && player.profit > 0) upsets.push({ name: player.playerName, wp, type: 'win' });
        }

        if (pStats && [5, 10, 15, 20, 25].includes(pStats.gamesPlayed)) {
          periodMilestones.push({ name: player.playerName, num: pStats.gamesPlayed });
        }

        if (allTimeStats && allTimeStats.lastGameResults.length >= 2) {
          const currentDate = new Date(allTimeStats.lastGameResults[0].date);
          const prevDate = new Date(allTimeStats.lastGameResults[1].date);
          const daysSince = Math.floor((currentDate.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24));
          if (daysSince >= 30) welcomeBacks.push({ name: player.playerName, days: daysSince });
        }

        if (pStats && pStats.gamesPlayed === 1) firstInPeriod.push(player.playerName);

        if (pStats && player.profit > 0) {
          const periodBefore = pStats.totalProfit - player.profit;
          for (const m of [250, 500, 1000, 1500, 2000]) {
            if (periodBefore < m && pStats.totalProfit >= m) {
              periodProfitMilestones.push({ name: player.playerName, amount: m });
              break;
            }
          }
        }

        if (pStats && player.profit > 0 && pStats.gamesPlayed >= 3) {
          const periodBefore = pStats.totalProfit - player.profit;
          if (periodBefore < 0 && pStats.totalProfit > 0) {
            periodTurnarounds.push({ name: player.playerName, newTotal: pStats.totalProfit });
          }
        }

        if (pStats && pStats.totalRebuys > 0 && pStats.gamesPlayed >= 3) {
          const allPeriodRebuys = periodStats.filter(s => s.gamesPlayed >= 3);
          const maxPeriodRebuys = Math.max(...allPeriodRebuys.map(s => s.totalRebuys));
          if (pStats.totalRebuys === maxPeriodRebuys && pStats.totalRebuys >= 15) {
            periodSpenders.push({ name: player.playerName, rebuys: pStats.totalRebuys });
          }
        }

        if (allTimeStats && player.profit > 0) {
          const allTimeBefore = allTimeStats.totalProfit - player.profit;
          for (const m of [1000, 2000, 3000, 5000]) {
            if (allTimeBefore < m && allTimeStats.totalProfit >= m) {
              bank.push({ emoji: '⭐', label: 'שיא כל הזמנים', detail: `${player.playerName} חצה \u200E+${m} רווח כולל!`, priority: 1 });
              break;
            }
          }
        }

        if (pStats && pStats.gamesPlayed >= 5) {
          const wp = Math.round(pStats.winPercentage);
          if (wp >= 70) highWinRates.push({ name: player.playerName, wp, record: `${pStats.winCount}/${pStats.gamesPlayed}` });
          else if (wp <= 20) lowWinRates.push({ name: player.playerName, wp, record: `${pStats.winCount}/${pStats.gamesPlayed}` });
        }

        if (pStats && pStats.gamesPlayed >= 3 && pStats.avgRebuysPerGame > 0) {
          if (player.rebuys / pStats.avgRebuysPerGame >= 2 && player.rebuys >= 4) {
            rebuysAboveAvg.push({ name: player.playerName, tonight: player.rebuys, avg: Math.round(pStats.avgRebuysPerGame) });
          }
        }
      }

      // --- Build combined entries ---

      if (periodBestWins.length > 0) {
        const parts = periodBestWins.map(w => `${w.name} (\u200E+${cleanNumber(w.profit)})`);
        bank.push({ emoji: '🏆', label: `שיא נצחון ב${pLabel}`, detail: parts.join(', '), priority: 2 });
      }
      if (periodWorstLosses.length > 0) {
        const parts = periodWorstLosses.map(w => `${w.name} (${formatCurrency(w.profit)})`);
        bank.push({ emoji: '📉', label: `שיא הפסד ב${pLabel}`, detail: parts.join(', '), priority: 3 });
      }
      if (streaks.length > 0) {
        streaks.sort((a, b) => b.streak - a.streak);
        const parts = streaks.map(s => {
          const label = s.type === 'win' ? 'נצחונות' : 'הפסדים';
          return `${s.name} — ${s.streak} ${label} ברצף`;
        });
        bank.push({ emoji: streaks[0].type === 'win' ? '🔥' : '❄️', label: 'רצף', detail: parts.join(', '), priority: 2 });
      }
      if (upsets.length > 0) {
        const parts = upsets.map(u => {
          const action = u.type === 'win' ? 'ניצח' : 'הפסיד';
          return `${u.name} (${u.wp}%) ${action}`;
        });
        bank.push({ emoji: '🎯', label: 'הפתעות', detail: parts.join(', '), priority: 2 });
      }
      if (periodMilestones.length > 0) {
        const parts = periodMilestones.map(m => `${m.name} — משחק #${m.num}`);
        bank.push({ emoji: '🎮', label: `אבן דרך ב${pLabel}`, detail: parts.join(', '), priority: 7 });
      }
      if (welcomeBacks.length > 0) {
        const parts = welcomeBacks.map(w => `${w.name} (${w.days} יום)`);
        bank.push({ emoji: '👋', label: 'חזרו לשולחן', detail: parts.join(', '), priority: 3 });
      }
      if (firstInPeriod.length > 0) {
        bank.push({ emoji: '🆕', label: `משחק ראשון ב${pLabel}`, detail: firstInPeriod.join(', '), priority: 5 });
      }
      if (periodProfitMilestones.length > 0) {
        const parts = periodProfitMilestones.map(m => `${m.name} — חצה \u200E+${m.amount}`);
        bank.push({ emoji: '💰', label: `אבן דרך רווח ב${pLabel}`, detail: parts.join(', '), priority: 2 });
      }
      if (periodTurnarounds.length > 0) {
        const parts = periodTurnarounds.map(t => `${t.name} (\u200E+${cleanNumber(t.newTotal)})`);
        bank.push({ emoji: '↗️', label: `עברו לרווח ב${pLabel}`, detail: parts.join(', '), priority: 3 });
      }
      if (periodSpenders.length > 0) {
        const names = periodSpenders.map(s => s.name).join(' ו');
        bank.push({ emoji: '🏧', label: `הכי הרבה קניות ב${pLabel}`, detail: `${names} — ${periodSpenders[0].rebuys} סה״כ`, priority: 6 });
      }
      if (highWinRates.length > 0) {
        const parts = highWinRates.map(w => `${w.name} — ${w.wp}% (${w.record})`);
        bank.push({ emoji: '🎰', label: `אחוז נצחון גבוה ב${pLabel}`, detail: parts.join(', '), priority: 6 });
      }
      if (lowWinRates.length > 0) {
        const parts = lowWinRates.map(w => `${w.name} — ${w.wp}% (${w.record})`);
        bank.push({ emoji: '🎰', label: `אחוז נצחון נמוך ב${pLabel}`, detail: parts.join(', '), priority: 6 });
      }
      if (rebuysAboveAvg.length > 0) {
        const parts = rebuysAboveAvg.map(r => `${r.name} — ${r.tonight} (ממוצע ${r.avg})`);
        bank.push({ emoji: '📊', label: 'מעל הממוצע בקניות', detail: parts.join(', '), priority: 6 });
      }

      // --- Period leader ---
      const periodRanked = [...periodStats].filter(s => s.gamesPlayed >= 2).sort((a, b) => b.totalProfit - a.totalProfit);
      if (periodRanked.length > 0) {
        const leader = periodRanked[0];
        bank.push({ emoji: '🥇', label: `מוביל ${pLabel}`, detail: `${leader.playerName} — \u200E+${cleanNumber(leader.totalProfit)}`, priority: 2 });
      }

      // --- Global records ---

      const historicalMaxRebuys = previousGP.length > 0 ? Math.max(...previousGP.map(gp => gp.rebuys)) : 0;
      if (maxRebuys > historicalMaxRebuys && historicalMaxRebuys > 0) {
        bank.push({ emoji: '📛', label: 'שיא קבוצתי — קניות', detail: `${rebuyKings[0].playerName} עם ${maxRebuys} (היה ${historicalMaxRebuys})`, priority: 1 });
      }

      const bigWinner = sortedPlayers[0];
      const historicalMaxProfit = previousGP.length > 0 ? Math.max(0, ...previousGP.map(gp => gp.profit)) : 0;
      if (bigWinner && bigWinner.profit > 0 && bigWinner.profit > historicalMaxProfit && historicalMaxProfit > 0) {
        bank.push({ emoji: '🌟', label: 'שיא קבוצתי — נצחון', detail: `${bigWinner.playerName} \u200E+${cleanNumber(bigWinner.profit)} (היה \u200E+${cleanNumber(historicalMaxProfit)})`, priority: 1 });
      }

      const allCompletedGames = cachedAllGames.filter(g => g.status === 'completed' && g.id !== gameId);
      let historicalMaxPot = 0;
      for (const g of allCompletedGames) {
        const gPlayers = allGP.filter(gp => gp.gameId === g.id);
        const pot = gPlayers.reduce((sum, gp) => sum + gp.rebuys, 0) * settings2.rebuyValue;
        if (pot > historicalMaxPot) historicalMaxPot = pot;
      }
      if (tonightsPot > historicalMaxPot && historicalMaxPot > 0) {
        bank.push({ emoji: '🏦', label: 'שיא קבוצתי — קופה', detail: `${cleanNumber(tonightsPot)} (היה ${cleanNumber(historicalMaxPot)})`, priority: 1 });
      }

      if (periodPrevGP.length > 0) {
        const periodMaxProfit = Math.max(0, ...periodPrevGP.map(gp => gp.profit));
        const topWinner = sortedPlayers[0];
        if (topWinner && topWinner.profit > 0 && topWinner.profit > periodMaxProfit && periodMaxProfit > 0) {
          bank.push({ emoji: '🌟', label: `שיא ${pLabel} — נצחון`, detail: `${topWinner.playerName} \u200E+${cleanNumber(topWinner.profit)} (היה \u200E+${cleanNumber(periodMaxProfit)})`, priority: 1 });
        }
      }

      // --- Fillers ---

      bank.push({ emoji: '💵', label: 'קופה הערב', detail: `${cleanNumber(tonightsPot)} — ${totalRebuysTonight} קניות סה״כ`, priority: 8 });

      const topProfit = sortedPlayers[0]?.profit || 0;
      const bottomProfit = sortedPlayers[sortedPlayers.length - 1]?.profit || 0;
      if (topProfit > 0 && bottomProfit < 0) {
        bank.push({ emoji: '📏', label: 'פער הערב', detail: `${cleanNumber(topProfit - bottomProfit)} — ${sortedPlayers[0].playerName} מול ${sortedPlayers[sortedPlayers.length - 1].playerName}`, priority: 8 });
      }

      bank.push({ emoji: '🎲', label: `מספר משחק ב${pLabel}`, detail: `#${periodGames.length + 1}`, priority: 9 });

      if (sortedPlayers[0] && sortedPlayers[0].profit > 0) {
        const winnerPeriod = periodStats.find(s => s.playerId === sortedPlayers[0].playerId);
        if (winnerPeriod && winnerPeriod.gamesPlayed >= 3) {
          bank.push({ emoji: '📊', label: `ממוצע המנצח ב${pLabel}`, detail: `${sortedPlayers[0].playerName} — ${formatCurrency(Math.round(winnerPeriod.avgProfit))} למשחק`, priority: 8 });
        }
      }
    } catch {
      // Stats unavailable, continue with tonight-only highlights
    }

    // Sort by priority (1 = highest) and always output exactly 10
    bank.sort((a, b) => a.priority - b.priority);
    setFunStats(bank.slice(0, 10).map(({ emoji, label, detail }) => ({ emoji, label, detail })));

    // Compute standings table for the game's half-year period
    const gameMonth = actualGameDate.getMonth() + 1;
    const gameYear = actualGameDate.getFullYear();
    const halfStart = new Date(gameYear, gameMonth <= 6 ? 0 : 6, 1);
    const halfEnd = new Date(gameYear, gameMonth <= 6 ? 6 : 12, 0, 23, 59, 59);
    const halfLabel = formatHebrewHalf(gameMonth <= 6 ? 1 : 2, gameYear);

    const halfStats = getPlayerStats({ start: halfStart, end: halfEnd });
    const allPlayers = getAllPlayers();

    const halfGames = cachedAllGames.filter(g => {
      if (g.status !== 'completed') return false;
      const gd = new Date(g.date || g.createdAt);
      return gd >= halfStart && gd <= halfEnd;
    });
    const totalHalfGames = halfGames.length;
    const activeThreshold = Math.ceil(totalHalfGames * 0.33);

    const tonightPlayerIds = new Set(sortedPlayers.map(p => p.playerId));

    const activeStats = halfStats
      .filter(s => {
        const player = allPlayers.find(p => p.id === s.playerId);
        return player && (player.type === 'permanent' || player.type === 'permanent_guest' || player.type === 'guest');
      })
      .filter(s => s.gamesPlayed >= activeThreshold || tonightPlayerIds.has(s.playerId))
      .sort((a, b) => b.totalProfit - a.totalProfit);

    setStandingsData(activeStats);
    setStandingsLabel(halfLabel);

    // Compute previous rankings (before this game) for ranking change indicators
    const thisGameProfitMap = new Map<string, number>();
    sortedPlayers.forEach(p => thisGameProfitMap.set(p.playerId, p.profit));

    const prevStats = activeStats
      .map(s => ({
        playerId: s.playerId,
        totalProfit: s.totalProfit - (thisGameProfitMap.get(s.playerId) ?? 0),
        gamesPlayed: s.gamesPlayed - (thisGameProfitMap.has(s.playerId) ? 1 : 0),
      }))
      .filter(s => s.gamesPlayed > 0)
      .sort((a, b) => b.totalProfit - a.totalProfit);

    const prevRankMap: Record<string, number> = {};
    prevStats.forEach((s, i) => { prevRankMap[s.playerId] = i + 1; });
    setPreviousRankMap(prevRankMap);

    // Monthly summary table — primary: user confirmed at game creation; fallback: history-based
    const hebrewMonths = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
    const gameMonthIdx = actualGameDate.getMonth();
    const isLastGameOfMonth = gameYear >= 2026 && (
      game.periodMarkers?.isLastGameOfMonth ??
      !cachedAllGames.some(g => {
        if (g.status !== 'completed' || g.id === game.id) return false;
        const gd = new Date(g.date || g.createdAt);
        return gd.getFullYear() === gameYear && gd.getMonth() === gameMonthIdx && gd > actualGameDate;
      })
    );
    if (isLastGameOfMonth) {
      const monthStart = new Date(gameYear, gameMonthIdx, 1);
      const monthEnd = new Date(gameYear, gameMonthIdx + 1, 0, 23, 59, 59);
      const mStats = getPlayerStats({ start: monthStart, end: monthEnd });
      const monthGames = cachedAllGames.filter(g => {
        if (g.status !== 'completed') return false;
        const gd = new Date(g.date || g.createdAt);
        return gd >= monthStart && gd <= monthEnd;
      });
      if (monthGames.length >= 2) {
        const mThreshold = Math.ceil(monthGames.length * 0.33);
        const activeMonthly = mStats
          .filter(s => {
            const pl = allPlayers.find(p => p.id === s.playerId);
            return pl && (pl.type === 'permanent' || pl.type === 'permanent_guest' || pl.type === 'guest');
          })
          .filter(s => s.gamesPlayed >= mThreshold || tonightPlayerIds.has(s.playerId))
          .sort((a, b) => b.totalProfit - a.totalProfit);
        setMonthlyStats(activeMonthly);
        setMonthLabel(hebrewMonths[gameMonthIdx]);
      } else {
        setMonthlyStats([]);
      }
    } else {
      setMonthlyStats([]);
    }

    // --- AI Game Night Summary ---
    // Never auto-generate. Show cached version if it exists, otherwise show "Generate" button.
    const cachedSummary = game.aiSummary;
    const isCachedValid = cachedSummary && cachedSummary.length > 80;

    const shouldAutoGenerate = locationState?.autoAI && !isCachedValid;
    if (isCachedValid && !forceGenerateRef.current) {
      setAiSummary(cachedSummary);
      setAiSummaryModel(game.aiSummaryModel || '');
    } else if ((forceGenerateRef.current || shouldAutoGenerate) && getGeminiApiKey() && game.status === 'completed') {
      forceGenerateRef.current = false;
      setIsLoadingAiSummary(true);

      // Build payload from already-computed data
      const aiTonightResults = sortedPlayers.map((p, i) => ({
        name: p.playerName,
        profit: Math.round(p.profit),
        rebuys: p.rebuys,
        rank: i + 1,
      }));

      // Include top 5 + all tonight's players for full context
      const aiPeriodStandings = activeStats
        .filter((s, idx) => idx < 5 || tonightPlayerIds.has(s.playerId))
        .map((s) => {
          const overallRank = activeStats.findIndex(a => a.playerId === s.playerId) + 1;
          return {
            name: s.playerName,
            periodRank: overallRank,
            totalProfit: Math.round(s.totalProfit),
            gamesPlayed: s.gamesPlayed,
            winPct: s.winPercentage,
            currentStreak: s.currentStreak,
          };
        });

      const aiRecords: string[] = [];
      const aiStreaks: string[] = [];
      const aiUpsets: string[] = [];
      const aiMilestones: string[] = [];
      const aiWelcomeBacks: string[] = [];
      const aiRankingShifts: string[] = [];

      // Extract from the already-computed highlight bank
      for (const h of bank) {
        if (h.label.includes('שיא')) {
          aiRecords.push(`${h.emoji} ${h.detail}`);
        }
        if (h.label === 'רצף') {
          aiStreaks.push(h.detail);
        }
        if (h.label === 'הפתעות') {
          aiUpsets.push(h.detail);
        }
        if (h.label.includes('אבן דרך') || h.label.includes('עברו לרווח') || h.label.includes('משחק ראשון')) {
          aiMilestones.push(`${h.label}: ${h.detail}`);
        }
        if (h.label === 'חזרו לשולחן') {
          aiWelcomeBacks.push(h.detail);
        }
        if (h.label.includes('קאמבק') || h.label.includes('מלך הקניות') || h.label.includes('תשואה') || h.label.includes('חוסר מזל')) {
          aiMilestones.push(`${h.label}: ${h.detail}`);
        }
        if (h.label.includes('אחוז נצחון') || h.label.includes('מעל הממוצע')) {
          aiMilestones.push(`${h.label}: ${h.detail}`);
        }
      }

      // Compute ranking shifts: who overtook whom / who dropped because of tonight
      try {
        const beforeTonight = activeStats.map(s => {
          const tonightPlayer = sortedPlayers.find(p => p.playerId === s.playerId);
          const tonightProfit = tonightPlayer ? tonightPlayer.profit : 0;
          return { ...s, totalProfit: s.totalProfit - tonightProfit };
        }).sort((a, b) => b.totalProfit - a.totalProfit);

        const afterTonight = [...activeStats];

        for (const stat of activeStats) {
          const newRank = afterTonight.findIndex(s => s.playerId === stat.playerId) + 1;
          const oldRank = beforeTonight.findIndex(s => s.playerId === stat.playerId) + 1;
          if (newRank > 0 && oldRank > 0 && newRank < oldRank) {
            const passedPlayers = beforeTonight
              .slice(newRank - 1, oldRank - 1)
              .filter(s => s.playerId !== stat.playerId)
              .map(s => s.playerName);
            if (passedPlayers.length > 0) {
              aiRankingShifts.push(`${stat.playerName} עלה ממקום ${oldRank} למקום ${newRank} (עקף את ${passedPlayers.join(' ואת ')})`);
            }
          } else if (newRank > 0 && oldRank > 0 && newRank > oldRank) {
            aiRankingShifts.push(`${stat.playerName} ירד ממקום ${oldRank} למקום ${newRank}`);
          }
        }
      } catch {}

      // Count games in period (for "game #X")
      const periodGameCount = halfGames.length;

      const resolvedPeriodMarkers: PeriodMarkers | undefined = game.periodMarkers || (() => {
        try {
          const allGamesForPeriod = cachedAllGames;
          const s = getSettings();
          return detectPeriodMarkers(new Date(game.date || game.createdAt), allGamesForPeriod, s.gameNightDays || [4, 6]);
        } catch { return undefined; }
      })();

      // Build location insights for the summary (only if genuinely interesting)
      const summaryLocInsights = (() => {
        if (!game.location) return undefined;
        const allGp = cachedAllGP;
        const allGm = cachedAllGames.filter(g => g.status === 'completed');
        const tonightNames = sortedPlayers.map(p => p.playerName);
        const playerHistories = tonightNames.map(name => {
          const playerGames = allGp.filter(gp => gp.playerName === name);
          return {
            name,
            avgProfit: (() => { const pg = playerGames; if (pg.length === 0) return 0; return pg.reduce((s, g) => s + g.profit, 0) / pg.length; })(),
            gameHistory: playerGames.map(gp => {
              const gm = allGm.find(g => g.id === gp.gameId);
              return { profit: gp.profit, date: gm?.date || gm?.createdAt || '', location: gm?.location };
            }),
          };
        });
        const allGamesWithLoc = allGm.map(g => ({ location: g.location, date: g.date || g.createdAt }));
        return buildLocationInsights(playerHistories, game.location, allGamesWithLoc) || undefined;
      })();

      const summaryPayload: GameNightSummaryPayload = {
        tonight: aiTonightResults,
        totalRebuys: totalRebuysTonight,
        totalPot: Math.round(tonightsPot),
        periodLabel: halfLabel,
        periodStandings: aiPeriodStandings,
        recordsBroken: aiRecords,
        notableStreaks: aiStreaks,
        upsets: aiUpsets,
        milestones: aiMilestones,
        welcomeBacks: aiWelcomeBacks,
        rankingShifts: aiRankingShifts,
        gameNumberInPeriod: periodGameCount,
        location: game.location,
        locationInsights: summaryLocInsights,
        periodMarkers: resolvedPeriodMarkers,
        comboHistoryText: combo.totalGamesWithCombo > 1 ? buildComboHistoryText(combo) : undefined,
      };

      setAiSummaryError(null);
      withAITiming('game_summary', () => generateGameNightSummary(summaryPayload))
        .then(async result => {
          const modelDisplay = getModelDisplayName(result.meta.model);
          setAiSummary(result.text);
          setAiSummaryModel(modelDisplay);
          setAiSummaryError(null);
          saveGameAiSummary(game.id, result.text, modelDisplay);
          if (shouldAutoGenerate) {
            try {
              const { syncToCloud } = await import('../database/githubSync');
              await syncToCloud();
              console.log('Background: synced after auto AI summary');
            } catch (e) { console.warn('Background sync failed:', e); }
            import('../utils/backgroundAI').then(({ regenerateAIInBackground }) => {
              regenerateAIInBackground();
            }).catch(() => {});
          }
        })
        .catch(err => {
          console.error('AI summary generation failed:', err);
          const msg = err?.message || String(err);
          if (msg.includes('quota') || msg.includes('429') || msg.includes('rate')) {
            setAiSummaryError('מכסת ה-AI נגמרה. נסה שוב מאוחר יותר');
          } else if (msg.includes('NO_API_KEY')) {
            setAiSummaryError('מפתח Gemini לא מוגדר. הוסף אותו בהגדרות');
          } else {
            setAiSummaryError('שגיאה ביצירת הסיכום. נסה שוב');
          }
        })
        .finally(() => {
          setIsLoadingAiSummary(false);
        });
    } else {
      forceGenerateRef.current = false;
    }

    setIsLoading(false);

    // TTS game summary announcement — only when arriving from game end, not when browsing history
    if (sortedPlayers.length >= 2 && locationState?.from === 'chip-entry') {
      setTimeout(() => {
        const winner = sortedPlayers[0];
        const loser = sortedPlayers[sortedPlayers.length - 1];
        const totalBuyins = sortedPlayers.reduce((sum, p) => sum + p.rebuys, 0);
        const totalRebuysOnly = totalBuyins - sortedPlayers.length;

        const formatRebuysHebrew = (n: number): string => {
          const hasHalf = Math.abs((n % 1) - 0.5) < 0.01;
          const whole = Math.floor(n);
          if (hasHalf) {
            if (whole === 0) return 'חצי';
            return `${hebrewNum(whole, true)} וחצי`;
          }
          return hebrewNum(whole, true);
        };

        const wFem = isPlayerFemale(winner.playerName);
        const wg = (m: string, f: string) => wFem ? f : m;
        const lFem = isPlayerFemale(loser.playerName);
        const lg = (m: string, f: string) => lFem ? f : m;

        const winMessages = [
          `${wg('המנצח הגדול', 'המנצחת הגדולה')} של הערב ${wg('הוא', 'היא')} ${winner.playerName} עם פלוס ${cleanNumber(winner.profit)} שקל!`,
          `${winner.playerName} ${wg('לוקח', 'לוקחת')} הכל הערב! פלוס ${cleanNumber(winner.profit)} שקל`,
          `ונצחון גדול של ${winner.playerName}! פלוס ${cleanNumber(winner.profit)} שקל`,
          `${winner.playerName} ${wg('הולך', 'הולכת')} הביתה עם פלוס ${cleanNumber(winner.profit)} שקל. כל הכבוד!`,
          `${winner.playerName} ${wg('שולט', 'שולטת')} הערב. פלוס ${cleanNumber(winner.profit)} שקל`,
          `הכסף הולך אל ${winner.playerName}! פלוס ${cleanNumber(winner.profit)} שקל בכיס`,
          `${winner.playerName} ${wg('סוגר', 'סוגרת')} את הערב עם חיוך. פלוס ${cleanNumber(winner.profit)} שקל`,
          `ו${winner.playerName} ${wg('יוצא', 'יוצאת')} עם ${cleanNumber(winner.profit)} שקל יותר ממה ${wg('שנכנס', 'שנכנסה')}!`,
        ];
        const loseMessages = [
          `${lg('והתורם הרשמי', 'והתורמת הרשמית')} של הערב. ${loser.playerName}. מינוס ${cleanNumber(Math.abs(loser.profit))} שקל. תודה על המימון!`,
          `${loser.playerName}. תודה על ${cleanNumber(Math.abs(loser.profit))} שקל. נתראה בפעם הבאה`,
          `ו${loser.playerName} ${lg('משאיר', 'משאירה')} ${cleanNumber(Math.abs(loser.profit))} שקל על השולחן. קלאסי`,
          `${loser.playerName} ${lg('תרם', 'תרמה')} ${cleanNumber(Math.abs(loser.profit))} שקל לשולחן. ${lg('גיבור אמיתי', 'גיבורה אמיתית')}`,
          `${loser.playerName} ${lg('מפסיד', 'מפסידה')} ${cleanNumber(Math.abs(loser.profit))} שקל. אבל מי סופר`,
          `${loser.playerName} ${lg('חוזר', 'חוזרת')} הביתה עם מינוס ${cleanNumber(Math.abs(loser.profit))} שקל. הערב לא היה ${lg('שלו', 'שלה')}`,
          `ו${loser.playerName} ${lg('שילם', 'שילמה')} את החשבון הערב. מינוס ${cleanNumber(Math.abs(loser.profit))} שקל`,
          `${loser.playerName}. ${cleanNumber(Math.abs(loser.profit))} שקל מינוס. אבל מה זה כסף בין חברים`,
        ];
        const potMessage = `סך הכל ${formatRebuysHebrew(totalRebuysOnly)} קניות חוזרות הערב.`;

        const winMsg = winMessages[Math.floor(Math.random() * winMessages.length)];
        const loseMsg = loseMessages[Math.floor(Math.random() * loseMessages.length)];

        speakHebrew([`סיכום המשחק. ${potMessage}`, winMsg, loseMsg], getGeminiApiKey(), { freeOnly: true });
      }, 1500);
    }
  };
  
  // Calculate expense total for display
  const totalExpenseAmount = sharedExpenses.reduce((sum, e) => sum + e.amount, 0);
  
  // Helper to get food role for a player name (for settlement display)
  const getFoodRole = (playerName: string): 'buyer' | 'eater' | null => {
    if (sharedExpenses.length === 0) return null;
    
    // Check if they paid for any food
    const isBuyer = sharedExpenses.some(e => e.paidByName === playerName);
    if (isBuyer) return 'buyer';
    
    // Check if they participated in any food
    const isEater = sharedExpenses.some(e => e.participantNames.includes(playerName));
    if (isEater) return 'eater';
    
    return null;
  };
  
  // Render player name with food icon if applicable
  const renderPlayerWithFoodIcon = (playerName: string) => {
    const role = getFoodRole(playerName);
    if (role === 'buyer') {
      return <>{playerName} <span style={{ fontSize: '1rem' }}>🍕</span></>;
    } else if (role === 'eater') {
      return <>{playerName} <span style={{ fontSize: '0.65rem', opacity: 0.8 }}>🍕</span></>;
    }
    return playerName;
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="fade-in" style={{ textAlign: 'center', padding: '3rem' }}>
        <div style={{ fontSize: '2rem', marginBottom: '1rem' }}>🃏</div>
        <p className="text-muted">Loading summary...</p>
      </div>
    );
  }

  // Game not found
  if (gameNotFound) {
    return (
      <div className="fade-in" style={{ textAlign: 'center', padding: '3rem' }}>
        <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>😕</div>
        <h2 style={{ marginBottom: '0.5rem' }}>Game Not Found</h2>
        <p className="text-muted" style={{ marginBottom: '1.5rem' }}>This game may have been deleted or doesn't exist.</p>
        <button className="btn btn-primary" onClick={() => navigate('/')}>Go Home</button>
      </div>
    );
  }

  const handleShare = async () => {
    if (!summaryRef.current || isSharing) return;
    
    setIsSharing(true);
    
    // Expand all sections before capturing screenshots
    const savedCollapsed = { ...collapsedSections };
    const allExpanded: Record<string, boolean> = {};
    for (const key of Object.keys(collapsedSections)) allExpanded[key] = false;
    setCollapsedSections(allExpanded);
    await new Promise(r => setTimeout(r, 150));

    try {

      const files: File[] = [];
      
      // Each section is captured and auto-split if too tall
      files.push(...await captureAndSplit(summaryRef.current, 'poker-results'));
      
      if (settlementsRef.current && settlements.length > 0) {
        files.push(...await captureAndSplit(settlementsRef.current, 'poker-settlements'));
      }
      
      if (forecastCompareRef.current && forecasts.length > 0) {
        files.push(...await captureAndSplit(forecastCompareRef.current, 'poker-forecast-vs-reality'));
      }
      
      if (expenseSettlementsRef.current && sharedExpenses.length > 0) {
        files.push(...await captureAndSplit(expenseSettlementsRef.current, 'poker-expenses'));
      }
      
      if (funStatsRef.current && (aiSummary || funStats.length > 0)) {
        files.push(...await captureAndSplit(funStatsRef.current, 'poker-highlights'));
      }

      if (comboHistoryRef.current && comboHistory && !comboHistory.isFirstTime) {
        files.push(...await captureAndSplit(comboHistoryRef.current, 'poker-combo-history'));
      }

      if (standingsRef.current && standingsData.length > 0) {
        files.push(...await captureAndSplit(standingsRef.current, 'poker-standings'));
      }
      
      const payLink = `https://poker-manager-blond.vercel.app/game-summary/${gameId}?pay=1`;
      const shareText = `🃏 תוצאות ערב הפוקר\n\n📲 לצפייה בתוצאות ותשלום דרך Bit/PayBox:\n${payLink}`;

      // Try native share first (works on mobile)
      if (navigator.share && navigator.canShare({ files })) {
        await navigator.share({
          files,
          text: shareText,
          title: 'Poker Game Summary',
        });
      } else {
        // Fallback: download all images
        files.forEach((file) => {
          const url = URL.createObjectURL(file);
          const a = document.createElement('a');
          a.href = url;
          a.download = file.name;
          a.click();
          URL.revokeObjectURL(url);
        });
        
        const text = `${shareText}\n\n(${files.length} images downloaded - attach them to this message)`;
        window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
      }
    } catch (error) {
      console.error('Error sharing:', error);
      alert('Could not share. Please try again.');
    } finally {
      setCollapsedSections(savedCollapsed);
      setIsSharing(false);
    }
  };

  const navigateBack = () => {
    if (cameFromStatistics) {
      navigate('/statistics', { 
        state: { 
          viewMode: locationState?.viewMode, 
          recordInfo: locationState?.recordInfo,
          playerInfo: locationState?.playerInfo,
          timePeriod: locationState?.timePeriod,
          selectedYear: locationState?.selectedYear,
        } 
      });
    } else if (cameFromChipEntry) {
      navigate('/');
    } else {
      navigate('/history');
    }
  };

  return (
    <div className="fade-in">
      <button 
        className="btn btn-sm btn-secondary mb-2"
        onClick={navigateBack}
      >
        ← {cameFromRecords ? 'Back to Records' : cameFromStatistics ? 'Back to Statistics' : cameFromChipEntry ? 'Home' : 'Back to History'}
      </button>

      {/* Results Section - for screenshot */}
      <div ref={summaryRef} style={{ padding: '0.75rem', background: '#1a1a2e' }}>
        <div className="page-header">
          <h1 className="page-title">🃏 Poker Night</h1>
          <p className="page-subtitle">
            {new Date(gameDate).toLocaleDateString('en-US', { 
              weekday: 'long', 
              month: 'short', 
              day: 'numeric' 
            })}
          </p>
        </div>

        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <h2 className="card-title" style={{ margin: 0 }}>Results</h2>
            <div style={{ fontSize: '0.85rem', color: '#94a3b8' }}>
              Total Buyins: <span style={{ color: '#f8fafc', fontWeight: '600' }}>{players.reduce((sum, p) => sum + p.rebuys, 0)}</span>
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ fontSize: '0.9rem' }}>
              <thead>
                <tr>
                  <th>Player</th>
                  <th style={{ textAlign: 'center', padding: '0.5rem 0.25rem' }}>Chips</th>
                  <th style={{ textAlign: 'center', padding: '0.5rem 0.25rem' }}>Buyins</th>
                  <th style={{ textAlign: 'right' }}>+/-</th>
                </tr>
              </thead>
              <tbody>
                {players.map((player, index) => (
                  <tr key={player.id} style={highlightName && player.playerName === highlightName ? { background: '#243a5e' } : undefined}>
                    <td style={{ ...(highlightName && player.playerName === highlightName ? { color: '#60a5fa', borderLeft: '3px solid #3b82f6' } : { borderLeft: '3px solid transparent' }) }}>
                      {player.playerName}
                      {index === 0 && player.profit > 0 && ' 🥇'}
                      {index === 1 && player.profit > 0 && ' 🥈'}
                      {index === 2 && player.profit > 0 && ' 🥉'}
                    </td>
                    <td style={{ textAlign: 'center', padding: '0.5rem 0.25rem', color: '#94a3b8' }}>
                      {(getTotalChips(player) / 1000).toFixed(0)}k
                    </td>
                    <td style={{ textAlign: 'center', padding: '0.5rem 0.25rem', color: '#94a3b8' }}>
                      {player.rebuys}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap', color: player.profit > 0 ? '#22c55e' : player.profit < 0 ? '#ef4444' : '#94a3b8' }}>
                      {player.profit >= 0 ? '\u200E+' : ''}{formatCurrency(player.profit)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          
          {chipGap !== null && Math.abs(chipGap) > 5 && (
            <div style={{ 
              marginTop: '1rem', 
              padding: '0.75rem', 
              background: '#2a2518', 
              borderRadius: '8px',
              borderLeft: '3px solid #f59e0b'
            }}>
              <div style={{ fontSize: '0.875rem', color: '#f59e0b', fontWeight: '600' }}>
                ⚠️ Chip Count Adjustment
              </div>
              <div style={{ fontSize: '0.875rem', marginTop: '0.25rem', color: '#94a3b8' }}>
                {chipGap > 0 ? (
                  <>Counted {cleanNumber(chipGap)} more than expected (extra chips)</>
                ) : (
                  <>Counted {cleanNumber(Math.abs(chipGap))} less than expected (missing chips)</>
                )}
              </div>
              <div style={{ fontSize: '0.875rem', color: '#94a3b8' }}>
                Adjusted {chipGapPerPlayer && chipGapPerPlayer > 0 ? '-' : '+'}{cleanNumber(Math.abs(chipGapPerPlayer || 0))} per player to balance
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Settlements Section - for separate screenshot */}
      {settlements.length > 0 && (
        <div ref={(el) => { (settlementsRef as React.MutableRefObject<HTMLDivElement | null>).current = el; (settlementsSectionRef as React.MutableRefObject<HTMLDivElement | null>).current = el; }} style={{ padding: '0.75rem', background: '#1a1a2e', marginTop: '-1rem' }}>
          <div className="card" style={{ padding: '0.75rem' }}>
            <button onClick={() => toggleSection('settlements')} style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 0, color: '#f8fafc', marginBottom: collapsedSections.settlements ? 0 : '0.5rem' }}>
              <h2 className="card-title" style={{ margin: 0 }}>💸 Settlements {sharedExpenses.length > 0 && <span style={{ fontSize: '0.7rem', color: '#f59e0b' }}>(+ 🍕)</span>}</h2>
              <span style={{ fontSize: '0.8rem', color: '#94a3b8', transform: collapsedSections.settlements ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform 0.2s' }}>▼</span>
            </button>
            {!collapsedSections.settlements && (<>
              {(() => {
                const iOwe = identityName && settlements.some(s => s.from === identityName && !isSettlementPaid(s.from, s.to));
                const iReceive = identityName && settlements.some(s => s.to === identityName && !isSettlementPaid(s.from, s.to));
                if (iOwe) return (
                  <div style={{ direction: 'rtl', fontSize: '0.75rem', color: '#3b82f6', padding: '0.3rem 0.5rem', marginBottom: '0.4rem', background: '#1e2d45', borderRadius: '6px', textAlign: 'center' }}>
                    יש לך תשלום — לחץ על <strong>שלם</strong> בשורה שלך
                  </div>
                );
                if (iReceive) return (
                  <div style={{ direction: 'rtl', fontSize: '0.75rem', color: '#94a3b8', padding: '0.3rem 0.5rem', marginBottom: '0.4rem', background: '#1f2b3d', borderRadius: '6px', textAlign: 'center' }}>
                    ממתין לתשלומים אליך
                  </div>
                );
                return null;
              })()}
              {settlements.map((s, index) => {
                const paid = isSettlementPaid(s.from, s.to);
                const iAmFrom = identityName && s.from === identityName;
                const iAmTo = identityName && s.to === identityName;
                const isMySettlement = iAmFrom || iAmTo;
                const isClickable = iAmFrom && !paid;
                return (
                  <div
                    key={index}
                    className="settlement-row"
                    style={{
                      cursor: isClickable ? 'pointer' : 'default',
                      opacity: paid ? 0.5 : 1,
                      background: isMySettlement && !paid ? '#1e2d45' : undefined,
                      borderRadius: '8px',
                      padding: '0.3rem 0.6rem',
                      margin: '0.1rem -0.4rem',
                      position: 'relative',
                      transition: 'all 0.2s ease',
                    }}
                    onClick={() => isClickable && setPaymentModal({ from: s.from, to: s.to, amount: s.amount })}
                  >
                    <span style={iAmFrom ? { color: '#60a5fa', fontWeight: '700' } : undefined}>{renderPlayerWithFoodIcon(s.from)}</span>
                    <span className="settlement-arrow">➜</span>
                    <span style={iAmTo ? { color: '#60a5fa', fontWeight: '700' } : undefined}>{renderPlayerWithFoodIcon(s.to)}</span>
                    <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.35rem', flexShrink: 0 }}>
                      {isClickable && (
                        <button
                          style={{
                            background: '#3b82f6',
                            color: 'white',
                            border: 'none',
                            borderRadius: '6px',
                            padding: '0.2rem 0.5rem',
                            fontSize: '0.7rem',
                            fontWeight: '700',
                            cursor: 'pointer',
                            whiteSpace: 'nowrap',
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setPaymentModal({ from: s.from, to: s.to, amount: s.amount });
                          }}
                        >
                          💳 שלם
                        </button>
                      )}
                      <span className="settlement-amount" style={{ textDecoration: paid ? 'line-through' : undefined, marginLeft: 0 }}>
                        {formatCurrency(s.amount)}
                      </span>
                      {paid && <span style={{ fontSize: '0.85rem' }}>✅</span>}
                    </span>
                  </div>
                );
              })}
              {sharedExpenses.length > 0 && (
                <div style={{ 
                  marginTop: '0.75rem', 
                  paddingTop: '0.5rem', 
                  borderTop: '1px solid #2d3a4d',
                }}>
                  {sharedExpenses.map((expense, idx) => (
                    <div key={idx} style={{ 
                      fontSize: '0.75rem', 
                      color: '#94a3b8',
                      direction: 'rtl',
                      marginBottom: idx < sharedExpenses.length - 1 ? '0.4rem' : 0
                    }}>
                      <div>
                        <span style={{ fontSize: '0.9rem' }}>🍕</span> {expense.description} - {cleanNumber(expense.amount)}
                      </div>
                      <div style={{ marginRight: '1.2rem', fontSize: '0.7rem' }}>
                        שילם: <span style={{ color: '#6366f1' }}>{expense.paidByName}</span>
                        {' • '}
                        אכלו: {expense.participantNames.join(', ')}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>)}
          </div>

          {!collapsedSections.settlements && skippedTransfers.length > 0 && (
            <div className="card">
              <h2 className="card-title mb-2">💡 Small Amounts</h2>
              <p style={{ fontSize: '0.875rem', color: '#94a3b8', marginBottom: '0.25rem' }}>
                Payments below {cleanNumber(getSettings().minTransfer)} are not mandatory
              </p>
              {skippedTransfers.map((s, index) => (
                <div key={index} className="settlement-row" style={{ opacity: 0.8 }}>
                  <span>{renderPlayerWithFoodIcon(s.from)}</span>
                  <span className="settlement-arrow">➜</span>
                  <span>{renderPlayerWithFoodIcon(s.to)}</span>
                  <span style={{ color: '#f59e0b', fontWeight: '700', marginLeft: 'auto' }}>{formatCurrency(s.amount)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Forecast vs Actual Comparison - for screenshot */}
      {forecasts.length > 0 && (
        <div ref={forecastCompareRef} style={{ padding: '0.75rem', background: '#1a1a2e', marginTop: '-1rem' }}>
          <div className="card" style={{ padding: '0.75rem' }}>
            <button onClick={() => toggleSection('forecast')} style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 0, color: '#f8fafc', marginBottom: collapsedSections.forecast ? 0 : '0.5rem' }}>
              <h2 className="card-title" style={{ margin: 0 }}>🎯 Forecast vs Reality</h2>
              <span style={{ fontSize: '0.8rem', color: '#94a3b8', transform: collapsedSections.forecast ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform 0.2s' }}>▼</span>
            </button>
            
            {!collapsedSections.forecast && (<>
            {/* Legend - compact */}
            <div style={{ 
              marginBottom: '0.5rem',
              padding: '0.3rem 0.5rem',
              background: '#252f3f',
              borderRadius: '4px',
              fontSize: '0.65rem',
              color: '#94a3b8',
              display: 'flex',
              justifyContent: 'center',
              gap: '0.75rem'
            }}>
              <span><span style={{ color: '#22c55e' }}>✓</span> ≤30</span>
              <span><span style={{ color: '#f59e0b' }}>~</span> 31-60</span>
              <span><span style={{ color: '#ef4444' }}>✗</span> &gt;60</span>
            </div>
            
            {/* Compact table - no scroll */}
            <table style={{ 
              width: '100%', 
              fontSize: '0.75rem',
              borderCollapse: 'collapse'
            }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #475569' }}>
                  <th style={{ textAlign: 'left', padding: '0.3rem 0.2rem', fontSize: '0.7rem', color: '#94a3b8' }}>Player</th>
                  <th style={{ textAlign: 'center', padding: '0.3rem 0.2rem', fontSize: '0.7rem', color: '#94a3b8' }}>Fcst</th>
                  <th style={{ textAlign: 'center', padding: '0.3rem 0.2rem', fontSize: '0.7rem', color: '#94a3b8' }}>Real</th>
                  <th style={{ textAlign: 'center', padding: '0.3rem 0.2rem', fontSize: '0.7rem', color: '#94a3b8' }}>Gap</th>
                </tr>
              </thead>
              <tbody>
                {forecasts
                  .sort((a, b) => b.expectedProfit - a.expectedProfit)
                  .map((forecast) => {
                    const actual = players.find(p => p.playerName === forecast.playerName);
                    const actualProfit = actual?.profit || 0;
                    const gap = Math.abs(actualProfit - forecast.expectedProfit);
                    
                    // Accuracy indicator based on gap
                    const getAccuracyIndicator = () => {
                      if (gap <= 30) return { symbol: '✓', color: '#22c55e' };
                      if (gap <= 60) return { symbol: '~', color: '#f59e0b' };
                      return { symbol: '✗', color: '#ef4444' };
                    };
                    const accuracy = getAccuracyIndicator();
                    
                    return (
                      <tr key={forecast.playerName} style={{ borderBottom: '1px solid #252f3f' }}>
                        <td style={{ padding: '0.25rem 0.2rem', whiteSpace: 'nowrap', color: '#f8fafc' }}>
                          <span style={{ color: accuracy.color }}>{accuracy.symbol}</span> {forecast.playerName}
                        </td>
                        <td style={{ 
                          textAlign: 'center',
                          padding: '0.25rem 0.2rem',
                          color: forecast.expectedProfit >= 0 ? '#22c55e' : '#ef4444'
                        }}>
                          {forecast.expectedProfit >= 0 ? '\u200E+' : '\u200E'}{Math.round(forecast.expectedProfit)}
                        </td>
                        <td style={{ 
                          textAlign: 'center',
                          padding: '0.25rem 0.2rem',
                          color: actualProfit >= 0 ? '#22c55e' : '#ef4444',
                          fontWeight: '600'
                        }}>
                          {actualProfit >= 0 ? '\u200E+' : '\u200E'}{Math.round(actualProfit)}
                        </td>
                        <td style={{ 
                          textAlign: 'center',
                          padding: '0.25rem 0.2rem',
                          color: accuracy.color
                        }}>
                          {Math.round(gap)}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
            
            {/* Direction accuracy + gap summary */}
            {(() => {
              const matched = forecasts
                .map(f => {
                  const actual = players.find(p => p.playerName === f.playerName);
                  if (!actual) return null;
                  const dirOk = (f.expectedProfit >= 0 && actual.profit >= 0) || (f.expectedProfit < 0 && actual.profit < 0);
                  const gap = Math.abs(actual.profit - f.expectedProfit);
                  return { dirOk, gap };
                })
                .filter(Boolean) as { dirOk: boolean; gap: number }[];
              const dirHits = matched.filter(m => m.dirOk).length;
              const avgGap = matched.length > 0 ? Math.round(matched.reduce((s, m) => s + m.gap, 0) / matched.length) : 0;
              return (
                <div style={{
                  marginTop: '0.5rem',
                  display: 'flex',
                  justifyContent: 'center',
                  gap: '1rem',
                  fontSize: '0.75rem',
                  color: '#94a3b8',
                  direction: 'rtl'
                }}>
                  <span>🎯 כיוון: <span style={{ color: dirHits >= matched.length * 0.6 ? '#22c55e' : '#f59e0b', fontWeight: 600 }}>{dirHits}/{matched.length}</span></span>
                  <span>📊 פער ממוצע: <span style={{ color: avgGap <= 40 ? '#22c55e' : avgGap <= 70 ? '#f59e0b' : '#ef4444', fontWeight: 600 }}>{avgGap}</span></span>
                </div>
              );
            })()}

            {/* AI Summary - always show area */}
            <div style={{ 
              marginTop: '0.5rem', 
              padding: '0.5rem', 
              background: '#231e35',
              borderRadius: '6px',
              borderRight: '3px solid #a855f7',
              fontSize: '0.8rem',
              color: '#f8fafc',
              direction: 'rtl',
              textAlign: 'center',
              minHeight: '2rem'
            }}>
              {isLoadingComment && <><span style={{ color: '#a855f7' }}>🤖 Summarizing...</span><AIProgressBar operationKey="forecast_comparison" /></>}
              {forecastComment && !isLoadingComment && <span>🤖 {forecastComment}</span>}
              {!forecastComment && !isLoadingComment && <span style={{ color: '#94a3b8' }}>🤖 No summary available</span>}
            </div>
            </>)}
          </div>
        </div>
      )}

      {/* Historical Forecast Section (collapsible, not included in screenshots) */}
      {forecasts.length > 0 && (preGameTeaser || forecasts.some(f => f.highlight || f.sentence)) && (
        <div style={{ padding: '0.75rem', background: '#1a1a2e', marginTop: '-1rem' }}>
          <div className="card" style={{ padding: '0.75rem' }}>
            <button
              onClick={() => setShowHistoricalForecast(!showHistoricalForecast)}
              style={{
                width: '100%',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: 0,
                color: 'var(--text)',
              }}
            >
              <h2 className="card-title" style={{ margin: 0 }}>🔮 Pre-Game Forecast</h2>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', transform: showHistoricalForecast ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>▼</span>
            </button>

            {showHistoricalForecast && (
              <div style={{ paddingTop: '0.5rem', direction: 'rtl' }}>
                {preGameTeaser && (
                  <div style={{
                    padding: '0.85rem 1rem',
                    marginBottom: '0.75rem',
                    borderRadius: '12px',
                    background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.12), rgba(59, 130, 246, 0.10))',
                    border: '1px solid rgba(139, 92, 246, 0.35)',
                    textAlign: 'right',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.4rem', flexDirection: 'row-reverse', justifyContent: 'center' }}>
                      <span style={{ fontSize: '1rem' }}>🎙️</span>
                      <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#a78bfa' }}>טיזר המשחק</span>
                    </div>
                    <div style={{ fontSize: '0.82rem', color: '#e2e8f0', lineHeight: 1.6 }}>{preGameTeaser}</div>
                  </div>
                )}

                {forecasts.filter(f => f.highlight || f.sentence).map((forecast, index) => (
                  <div key={index} style={{
                    padding: '0.6rem 0.75rem',
                    marginBottom: '0.4rem',
                    borderRadius: '8px',
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.06)',
                    textAlign: 'right',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                      <span style={{ fontSize: '0.75rem', fontWeight: 600, color: forecast.expectedProfit >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                        {forecast.expectedProfit >= 0 ? '\u200E+' : '\u200E'}{forecast.expectedProfit}
                      </span>
                      <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>{forecast.playerName}</span>
                    </div>
                    {forecast.highlight && (
                      <div style={{ fontSize: '0.7rem', color: '#a78bfa', fontWeight: 600, marginBottom: '0.2rem' }}>{forecast.highlight}</div>
                    )}
                    {forecast.sentence && (
                      <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>{forecast.sentence}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Shared Expenses Info - separate screenshot (for reference only, settlements are combined) */}
      {sharedExpenses.length > 0 && (
        <div ref={expenseSettlementsRef} style={{ padding: '0.75rem', background: '#1a1a2e', marginTop: '-1rem' }}>
          <div className="card" style={{ padding: '0.75rem' }}>
            <button onClick={() => toggleSection('expenses')} style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 0, color: '#f8fafc', marginBottom: collapsedSections.expenses ? 0 : '0.5rem' }}>
              <h2 className="card-title" style={{ margin: 0 }}>🍕 Shared Expenses</h2>
              <span style={{ fontSize: '0.8rem', color: '#94a3b8', transform: collapsedSections.expenses ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform 0.2s' }}>▼</span>
            </button>
            
            {!collapsedSections.expenses && (<>
            {/* Expense Summary */}
            <div>
              {sharedExpenses.map(expense => (
                <div key={expense.id} style={{ 
                  padding: '0.5rem', 
                  background: '#252f3f', 
                  borderRadius: '6px',
                  marginBottom: '0.5rem',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: '600' }}>{expense.description}</span>
                    <span>{cleanNumber(expense.amount)}</span>
                  </div>
                  <div style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
                    {expense.paidByName} paid • {expense.participantNames.length} participants • {cleanNumber(expense.participants.length > 0 ? expense.amount / expense.participants.length : 0)} each
                  </div>
                </div>
              ))}
            </div>
            
            {/* Total */}
            <div style={{ 
              marginTop: '0.5rem', 
              padding: '0.5rem', 
              background: '#2a2518', 
              borderRadius: '6px',
              textAlign: 'center',
            }}>
              <span style={{ color: '#94a3b8' }}>Total: </span>
              <span style={{ fontWeight: '600', color: '#f59e0b' }}>{cleanNumber(totalExpenseAmount)}</span>
            </div>
            
            {/* Note about combined settlements */}
            <div style={{ 
              marginTop: '0.5rem', 
              fontSize: '0.75rem', 
              color: '#94a3b8',
              textAlign: 'center',
              fontStyle: 'italic',
            }}>
              ✓ Included in settlements above (combined with poker)
            </div>
            </>)}
          </div>
        </div>
      )}

      {/* Game Night Summary Section - for screenshot */}
      {(aiSummary || isLoadingAiSummary || funStats.length > 0) && (
        <div ref={funStatsRef} style={{ padding: '0.75rem', background: '#1a1a2e', marginTop: '-1rem' }}>
          <div className="card" style={{ padding: '0.75rem' }}>
            <button onClick={() => toggleSection('aiSummary')} style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 0, color: '#f8fafc', marginBottom: collapsedSections.aiSummary ? 0 : '0.5rem' }}>
              <h2 className="card-title" style={{ margin: 0 }}>{aiSummary ? '🎭 Game Night Summary' : '🎭 Game Highlights'}</h2>
              <span style={{ fontSize: '0.8rem', color: '#94a3b8', transform: collapsedSections.aiSummary ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform 0.2s' }}>▼</span>
            </button>
            {!collapsedSections.aiSummary && role === 'admin' && aiSummary && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.4rem' }}>
                <span
                  className="btn btn-sm"
                  style={{ background: '#2a1f3d', color: '#A855F7', border: '1px solid #4a2f6e', fontSize: '0.7rem', padding: '0.2rem 0.5rem', cursor: 'pointer' }}
                  onClick={() => handleRegenerateAiSummary()}
                >
                  🔄 Regenerate
                </span>
              </div>
            )}
            {!collapsedSections.aiSummary && role === 'admin' && !aiSummary && !isLoadingAiSummary && getGeminiApiKey() && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.4rem' }}>
                <span
                  className="btn btn-sm"
                  style={{ background: 'linear-gradient(135deg, #A855F7, #EC4899)', color: 'white', fontSize: '0.7rem', padding: '0.2rem 0.5rem', cursor: 'pointer' }}
                  onClick={() => handleRegenerateAiSummary()}
                >
                  ✨ Generate AI Summary
                </span>
              </div>
            )}
            {!collapsedSections.aiSummary && (
              <>
                {aiSummary ? (
                  <div style={{
                    direction: 'rtl',
                    fontSize: '0.85rem',
                    lineHeight: 1.8,
                    color: '#f8fafc',
                    padding: '0.75rem',
                    background: '#211e35',
                    borderRadius: '8px',
                    borderRight: '3px solid #6366f1',
                    wordBreak: 'break-word',
                    overflowWrap: 'break-word',
                  }}>
                    {aiSummary.split('\n').filter(line => line.trim()).map((paragraph, i) => (
                      <p key={i} style={{
                        margin: i === 0 ? 0 : '0.75rem 0 0 0',
                        textAlign: 'right',
                      }}>
                        {paragraph}
                      </p>
                    ))}
                    {aiSummaryModel && (
                      <div style={{ fontSize: '0.55rem', color: '#94a3b8', textAlign: 'center', marginTop: '0.5rem', opacity: 0.6 }}>
                        model: {aiSummaryModel}
                      </div>
                    )}
                  </div>
                ) : isLoadingAiSummary ? (
                  <div style={{
                    direction: 'rtl',
                    textAlign: 'center',
                    padding: '1.5rem',
                    color: '#94a3b8',
                    fontSize: '0.85rem',
                  }}>
                    <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem', animation: 'pulse 1.5s infinite' }}>✍️</div>
                    Generating summary...
                    <AIProgressBar operationKey="game_summary" />
                  </div>
                ) : (
                  <>
                    {aiSummaryError && (
                      <div style={{
                        direction: 'rtl',
                        padding: '0.6rem 0.75rem',
                        marginBottom: '0.5rem',
                        background: '#2d1f1f',
                        border: '1px solid #6b2828',
                        borderRadius: '8px',
                        fontSize: '0.8rem',
                        color: '#f87171',
                        textAlign: 'center',
                      }}>
                        ⚠️ {aiSummaryError}
                      </div>
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                      {funStats.map((stat, idx) => (
                        <div
                          key={idx}
                          style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: '0.5rem',
                            padding: '0.4rem 0.5rem',
                            background: '#1f2b3d',
                            borderRadius: '6px',
                            direction: 'rtl',
                          }}
                        >
                          <span style={{ fontSize: '0.95rem', flexShrink: 0, lineHeight: 1.4 }}>{stat.emoji}</span>
                          <span style={{
                            fontSize: '0.75rem',
                            lineHeight: 1.5,
                            color: '#f8fafc',
                            flex: 1,
                            minWidth: 0,
                            wordBreak: 'break-word',
                          }}>
                            <span style={{ fontWeight: 600, color: '#6366f1' }}>{stat.label}</span>
                            {' — '}
                            {stat.detail}
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Combo History Section */}
      {comboHistory && comboHistory.totalGamesWithCombo > 1 && (
        <div ref={comboHistoryRef} style={{ padding: '0.75rem', background: '#1a1a2e', marginTop: '-1rem' }}>
          <div className="card" style={{ padding: '0.75rem' }}>
            <button onClick={() => toggleSection('combo')} style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 0, color: '#f8fafc', marginBottom: collapsedSections.combo ? 0 : '0.75rem' }}>
              <h2 className="card-title" style={{ margin: 0 }}>
                {comboHistory.isFirstTime ? '🆕 New Combo' : '🔄 Returning Combo'}
              </h2>
              <span style={{ fontSize: '0.8rem', color: '#94a3b8', transform: collapsedSections.combo ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform 0.2s' }}>▼</span>
            </button>

            {!collapsedSections.combo && (comboHistory.isFirstTime ? (
              <div style={{
                direction: 'rtl',
                textAlign: 'right',
                fontSize: '0.85rem',
                color: '#e2e8f0',
                padding: '0.75rem',
                borderRadius: '10px',
                background: '#1e2e28',
                border: '1px solid #1f5c35',
              }}>
                זו הפעם הראשונה שבדיוק {comboHistory.playerCount} השחקנים האלה שיחקו יחד!
              </div>
            ) : (
              <div style={{ direction: 'rtl', textAlign: 'right' }}>
                <div style={{
                  fontSize: '0.85rem',
                  color: '#fbbf24',
                  marginBottom: '0.75rem',
                  fontWeight: 600,
                }}>
                  אותם {comboHistory.playerCount} שחקנים שיחקו יחד {comboHistory.totalGamesWithCombo} פעמים
                </div>

                {/* Player leaderboard for this combo */}
                <div style={{
                  fontSize: '0.75rem',
                  marginBottom: '0.4rem',
                  color: '#94a3b8',
                  fontWeight: 600,
                }}>
                  📊 דירוג מצטבר בהרכב הזה:
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', marginBottom: '0.75rem' }}>
                  {comboHistory.playerStats.map((ps, i) => (
                    <div key={i} style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      fontSize: '0.78rem',
                      padding: '0.25rem 0.5rem',
                      borderRadius: '6px',
                      background: ps.alwaysWon ? '#1e2e28' : ps.alwaysLost ? '#2d1f1f' : 'transparent',
                    }}>
                      <span style={{ color: '#e2e8f0', fontWeight: 500 }}>
                        {i + 1}. {ps.playerName} {i === 0 ? '👑' : i === comboHistory.playerStats.length - 1 ? '💀' : ''}
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                        <span style={{ color: '#64748b', fontSize: '0.7rem' }}>
                          {ps.wins}/{comboHistory.totalGamesWithCombo} נצ׳
                        </span>
                        <span style={{
                          fontWeight: 600,
                          color: ps.totalProfit > 0 ? '#22c55e' : ps.totalProfit < 0 ? '#ef4444' : '#94a3b8',
                          fontSize: '0.78rem',
                          minWidth: '3.5rem',
                          textAlign: 'left',
                        }}>
                          {ps.totalProfit >= 0 ? '\u200E+' : '\u200E'}{Math.round(ps.totalProfit)}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>

                {/* Combo insights */}
                {comboHistory.totalGamesWithCombo >= 2 && (() => {
                  const insights: { emoji: string; text: string; color: string }[] = [];
                  const n = comboHistory.totalGamesWithCombo;
                  const stats = comboHistory.playerStats;

                  const alwaysWon = stats.filter(p => p.alwaysWon);
                  const alwaysLost = stats.filter(p => p.alwaysLost);
                  const neverWon = stats.filter(p => p.wins === 0);
                  const neverLost = stats.filter(p => p.losses === 0);

                  if (comboHistory.uniqueWinners.length === n) {
                    insights.push({ emoji: '🎲', text: `מנצח שונה בכל אחד מ-${n} המשחקים!`, color: '#a78bfa' });
                  }
                  if (alwaysWon.length > 0) {
                    insights.push({ emoji: '⭐', text: `תמיד ברווח: ${alwaysWon.map(p => `${p.playerName} (${p.wins}/${n})`).join(', ')}`, color: '#4ade80' });
                  }
                  if (alwaysLost.length > 0) {
                    insights.push({ emoji: '💀', text: `תמיד בהפסד: ${alwaysLost.map(p => `${p.playerName} (${p.losses}/${n})`).join(', ')}`, color: '#f87171' });
                    const neverWonNotAlwaysLost = neverWon.filter(p => !p.alwaysLost);
                    if (neverWonNotAlwaysLost.length > 0 && neverWonNotAlwaysLost.length <= 3) {
                      insights.push({ emoji: '📉', text: `אף פעם לא ניצחו בהרכב: ${neverWonNotAlwaysLost.map(p => p.playerName).join(', ')}`, color: '#f87171' });
                    }
                  } else if (neverWon.length > 0 && neverWon.length <= 3) {
                    insights.push({ emoji: '📉', text: `אף פעם לא ניצחו בהרכב: ${neverWon.map(p => p.playerName).join(', ')}`, color: '#f87171' });
                  }
                  {
                    const neverLostNotAlwaysWon = neverLost.filter(p => !p.alwaysWon);
                    if (neverLostNotAlwaysWon.length > 0 && neverLostNotAlwaysWon.length <= 3) {
                      insights.push({ emoji: '🛡️', text: `אף פעם לא הפסידו בהרכב: ${neverLostNotAlwaysWon.map(p => p.playerName).join(', ')}`, color: '#94a3b8' });
                    }
                  }

                  const topRebuyer = [...stats].sort((a, b) => b.avgRebuys - a.avgRebuys)[0];
                  const lowestRebuyer = [...stats].sort((a, b) => a.avgRebuys - b.avgRebuys)[0];
                  if (topRebuyer && lowestRebuyer && topRebuyer.avgRebuys > lowestRebuyer.avgRebuys * 2) {
                    insights.push({ emoji: '💸', text: `${topRebuyer.playerName} קונה בממוצע ${topRebuyer.avgRebuys.toFixed(1)} לעומת ${lowestRebuyer.playerName} עם ${lowestRebuyer.avgRebuys.toFixed(1)} בלבד`, color: '#f59e0b' });
                  }

                  const bigSwing = [...stats].sort((a, b) => (b.bestResult - b.worstResult) - (a.bestResult - a.worstResult))[0];
                  if (bigSwing && n >= 2) {
                    insights.push({ emoji: '🎢', text: `התנודה הגדולה: ${bigSwing.playerName} — בין \u200E+${Math.round(bigSwing.bestResult)} ל-\u200E${Math.round(bigSwing.worstResult)}`, color: '#94a3b8' });
                  }

                  if (insights.length === 0) return null;
                  return (
                    <div>
                      <div style={{ fontSize: '0.75rem', marginBottom: '0.4rem', color: '#94a3b8', fontWeight: 600 }}>
                        💡 תובנות מההרכב:
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                        {insights.map((ins, i) => (
                          <div key={i} style={{ fontSize: '0.78rem', color: '#e2e8f0' }}>
                            {ins.emoji} {ins.text}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Monthly Summary Table — only shown for last game of month */}
      {monthlyStats.length > 0 && (
        <div ref={monthlyRef} style={{ padding: '0.75rem', background: '#1a1a2e', marginTop: '-1rem' }}>
          <div className="card" style={{ padding: '0.75rem' }}>
            <button onClick={() => toggleSection('monthly')} style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 0, color: '#f8fafc', marginBottom: collapsedSections.monthly ? 0 : '0.5rem' }}>
              <h2 className="card-title" style={{ margin: 0 }}>📅 סיכום חודש {monthLabel}</h2>
              <span style={{ fontSize: '0.8rem', color: '#94a3b8', transform: collapsedSections.monthly ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform 0.2s' }}>▼</span>
            </button>
            {!collapsedSections.monthly && (<>
            <div style={{
              textAlign: 'center',
              fontSize: '0.65rem',
              color: '#94a3b8',
              marginBottom: '0.5rem',
              paddingBottom: '0.3rem',
              borderBottom: '1px solid #475569',
            }}>
              <span>📊 {monthlyStats.reduce((max, s) => Math.max(max, s.gamesPlayed), 0)} games this month</span>
            </div>
            <table style={{ width: '100%', fontSize: '0.75rem', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #475569' }}>
                  <th style={{ padding: '0.3rem 0.2rem', whiteSpace: 'nowrap', width: '24px', textAlign: 'left', color: '#94a3b8' }}>#</th>
                  <th style={{ padding: '0.3rem 0.2rem', whiteSpace: 'nowrap', textAlign: 'left', color: '#94a3b8' }}>Player</th>
                  <th style={{ textAlign: 'right', padding: '0.3rem 0.3rem', whiteSpace: 'nowrap', color: '#94a3b8' }}>Profit</th>
                  <th style={{ textAlign: 'right', padding: '0.3rem 0.3rem', whiteSpace: 'nowrap', color: '#94a3b8' }}>Avg</th>
                  <th style={{ textAlign: 'center', padding: '0.3rem 0.2rem', whiteSpace: 'nowrap', color: '#94a3b8' }}>G</th>
                  <th style={{ textAlign: 'center', padding: '0.3rem 0.2rem', whiteSpace: 'nowrap', color: '#94a3b8' }}>W%</th>
                </tr>
              </thead>
              <tbody>
                {monthlyStats.map((player, index) => {
                  const isInThisGame = players.some(p => p.playerId === player.playerId);
                  const isMe = highlightName && player.playerName === highlightName;
                  return (
                    <tr key={player.playerId} style={{
                      borderBottom: '1px solid #252f3f',
                      background: isMe ? '#243d64' : isInThisGame ? '#2d3055' : undefined,
                    }}>
                      <td style={{ padding: '0.25rem 0.2rem', whiteSpace: 'nowrap', color: '#f8fafc', borderLeft: isMe ? '3px solid #3b82f6' : isInThisGame ? '3px solid #554399' : '3px solid transparent' }}>
                        {index + 1}
                        {index === 0 && ' 🥇'}
                        {index === 1 && ' 🥈'}
                        {index === 2 && ' 🥉'}
                      </td>
                      <td style={{
                        fontWeight: isMe ? '700' : isInThisGame ? '600' : '500',
                        padding: '0.25rem 0.2rem',
                        color: isMe ? '#60a5fa' : '#f8fafc',
                      }}>
                        {player.playerName}
                      </td>
                      <td style={{
                        textAlign: 'right',
                        padding: '0.25rem 0.3rem',
                        whiteSpace: 'nowrap',
                        fontWeight: '700',
                        color: player.totalProfit >= 0 ? '#22c55e' : '#ef4444',
                      }}>
                        {player.totalProfit >= 0 ? '\u200E+' : '\u200E-'}{cleanNumber(Math.abs(player.totalProfit))}
                      </td>
                      <td style={{
                        textAlign: 'right',
                        padding: '0.25rem 0.3rem',
                        whiteSpace: 'nowrap',
                        color: player.avgProfit >= 0 ? '#22c55e' : '#ef4444',
                      }}>
                        {player.avgProfit >= 0 ? '\u200E+' : '\u200E-'}{cleanNumber(Math.abs(player.avgProfit))}
                      </td>
                      <td style={{ textAlign: 'center', padding: '0.25rem 0.2rem', whiteSpace: 'nowrap', color: '#f8fafc' }}>
                        {player.gamesPlayed}
                      </td>
                      <td style={{
                        textAlign: 'center',
                        padding: '0.25rem 0.2rem',
                        whiteSpace: 'nowrap',
                        color: player.winPercentage >= 50 ? '#22c55e' : '#ef4444',
                        fontWeight: '600',
                      }}>
                        {Math.round(player.winPercentage)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </>)}
          </div>
        </div>
      )}

      {/* Updated Standings Table - for screenshot */}
      {standingsData.length > 0 && (
        <div ref={standingsRef} style={{ padding: '0.75rem', background: '#1a1a2e', marginTop: '-1rem' }}>
          <div style={{ padding: '0.75rem', background: '#1e293b', borderRadius: '12px', border: '1px solid #475569' }}>
            <button onClick={() => toggleSection('standings')} style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 0, color: '#f8fafc', marginBottom: collapsedSections.standings ? 0 : '0.5rem' }}>
              <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: '#f8fafc' }}>🏆 Updated Standings — {standingsLabel}</h2>
              <span style={{ fontSize: '0.8rem', color: '#94a3b8', transform: collapsedSections.standings ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform 0.2s' }}>▼</span>
            </button>
            {!collapsedSections.standings && (<>
            <div style={{
              textAlign: 'center',
              fontSize: '0.65rem',
              color: '#94a3b8',
              marginBottom: '0.5rem',
              paddingBottom: '0.3rem',
              borderBottom: '1px solid #475569',
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              gap: '0.75rem',
            }}>
              <span>📊 Active players • Including latest game</span>
              <span style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.25rem',
              }}>
                <span style={{
                  display: 'inline-block',
                  width: '8px',
                  height: '8px',
                  borderRadius: '2px',
                  background: '#3b3560',
                  border: '1px solid #554399',
                }} />
                Played tonight
              </span>
            </div>
            <table style={{ width: '100%', fontSize: '0.75rem', borderCollapse: 'collapse', color: '#f8fafc' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #475569' }}>
                  <th style={{ padding: '0.3rem 0.2rem', whiteSpace: 'nowrap', width: '24px', textAlign: 'left', color: '#94a3b8' }}>#</th>
                  <th style={{ padding: '0.3rem 0.2rem', whiteSpace: 'nowrap', textAlign: 'left', color: '#94a3b8' }}>Player</th>
                  <th style={{ textAlign: 'right', padding: '0.3rem 0.3rem', whiteSpace: 'nowrap', color: '#94a3b8' }}>Profit</th>
                  <th style={{ textAlign: 'right', padding: '0.3rem 0.3rem', whiteSpace: 'nowrap', color: '#94a3b8' }}>Avg</th>
                  <th style={{ textAlign: 'center', padding: '0.3rem 0.2rem', whiteSpace: 'nowrap', color: '#94a3b8' }}>G</th>
                  <th style={{ textAlign: 'center', padding: '0.3rem 0.2rem', whiteSpace: 'nowrap', color: '#94a3b8' }}>W%</th>
                </tr>
              </thead>
              <tbody>
                {standingsData.map((player, index) => {
                  const isInThisGame = players.some(p => p.playerId === player.playerId);
                  const currentRank = index + 1;
                  const prevRank = previousRankMap[player.playerId];
                  const rankDiff = prevRank ? prevRank - currentRank : 0;
                  const isNewEntry = !prevRank;
                  const isMe = highlightName && player.playerName === highlightName;
                  return (
                    <tr key={player.playerId} style={{
                      borderBottom: '1px solid #252f3f',
                      background: isMe ? '#243d64' : isInThisGame ? '#2d3055' : undefined,
                    }}>
                      <td style={{ padding: '0.25rem 0.2rem', whiteSpace: 'nowrap', color: '#f8fafc', borderLeft: isMe ? '3px solid #3b82f6' : isInThisGame ? '3px solid #554399' : '3px solid transparent' }}>
                        <span>{currentRank}</span>
                        {index === 0 && ' 🥇'}
                        {index === 1 && ' 🥈'}
                        {index === 2 && ' 🥉'}
                        {isNewEntry ? (
                          <span style={{ fontSize: '0.55rem', color: '#60a5fa', marginLeft: '0.2rem', fontWeight: 700 }}>NEW</span>
                        ) : rankDiff > 0 ? (
                          <span style={{ fontSize: '0.6rem', color: '#22c55e', marginLeft: '0.15rem' }}>▲{rankDiff}</span>
                        ) : rankDiff < 0 ? (
                          <span style={{ fontSize: '0.6rem', color: '#ef4444', marginLeft: '0.15rem' }}>▼{Math.abs(rankDiff)}</span>
                        ) : null}
                      </td>
                      <td style={{
                        fontWeight: isMe ? '700' : isInThisGame ? '600' : '500',
                        padding: '0.25rem 0.2rem',
                        whiteSpace: 'nowrap',
                        color: isMe ? '#60a5fa' : '#f8fafc',
                      }}>
                        {player.playerName}
                      </td>
                      <td style={{
                        textAlign: 'right',
                        padding: '0.25rem 0.3rem',
                        whiteSpace: 'nowrap',
                        fontWeight: '700',
                        color: player.totalProfit >= 0 ? '#22c55e' : '#ef4444',
                      }}>
                        {player.totalProfit >= 0 ? '\u200E+' : '\u200E-'}{cleanNumber(Math.abs(player.totalProfit))}
                      </td>
                      <td style={{
                        textAlign: 'right',
                        padding: '0.25rem 0.3rem',
                        whiteSpace: 'nowrap',
                        color: player.avgProfit >= 0 ? '#22c55e' : '#ef4444',
                      }}>
                        {player.avgProfit >= 0 ? '\u200E+' : '\u200E-'}{cleanNumber(Math.abs(player.avgProfit))}
                      </td>
                      <td style={{ textAlign: 'center', padding: '0.25rem 0.2rem', whiteSpace: 'nowrap', color: '#f8fafc' }}>
                        {player.gamesPlayed}
                      </td>
                      <td style={{
                        textAlign: 'center',
                        padding: '0.25rem 0.2rem',
                        whiteSpace: 'nowrap',
                        color: player.winPercentage >= 50 ? '#22c55e' : '#ef4444',
                        fontWeight: '600',
                      }}>
                        {Math.round(player.winPercentage)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </>)}
            <div style={{
              textAlign: 'center',
              marginTop: '0.5rem',
              fontSize: '0.75rem',
              color: '#94a3b8',
              opacity: 0.7
            }}>
              Poker Manager 🎲
            </div>
          </div>
        </div>
      )}

      {/* Action buttons - outside the screenshot area */}
      <div className="actions mt-3" style={{ display: 'flex', justifyContent: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        <button className="btn btn-secondary btn-lg" onClick={navigateBack}>
          {cameFromRecords ? '📊 Records' : cameFromStatistics ? '📈 Statistics' : cameFromChipEntry ? '🏠 Home' : '📜 History'}
        </button>
        <button 
          className="btn btn-primary btn-lg" 
          onClick={handleShare}
          disabled={isSharing || isLoadingAiSummary}
        >
          {isSharing ? '📸 Capturing...' : isLoadingAiSummary ? '✍️ Waiting for summary...' : '📤 Share'}
        </button>
      </div>

      {/* Re-open chip entry - admin only, only from game flow */}
      {role === 'admin' && cameFromChipEntry && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: '1rem' }}>
          {!showReopenConfirm ? (
            <button
              className="btn btn-sm"
              style={{ background: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b', border: '1px solid rgba(245, 158, 11, 0.3)', fontSize: '0.75rem' }}
              onClick={() => setShowReopenConfirm(true)}
            >
              🔄 Re-open Chip Entry
            </button>
          ) : (
            <div style={{ textAlign: 'center', padding: '0.75rem', background: 'rgba(245, 158, 11, 0.1)', borderRadius: '10px', border: '1px solid rgba(245, 158, 11, 0.3)' }}>
              <div style={{ fontSize: '0.8rem', color: '#f59e0b', marginBottom: '0.5rem', direction: 'rtl' }}>
                פעולה זו תפתח מחדש את ספירת הצ׳יפים. הסיכום וה-AI יאופסו.
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center' }}>
                <button className="btn btn-sm btn-secondary" onClick={() => setShowReopenConfirm(false)}>ביטול</button>
                <button className="btn btn-sm" style={{ background: '#f59e0b', color: 'white' }} onClick={handleReopenChipEntry}>אישור</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Payment Modal */}
      {paymentModal && (
        <div
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.7)', zIndex: 2000,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '1rem',
          }}
          onClick={() => setPaymentModal(null)}
        >
          <div
            style={{
              background: 'var(--surface)', borderRadius: '16px', padding: '1.5rem',
              maxWidth: '320px', width: '100%', direction: 'rtl', textAlign: 'center',
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ fontSize: '1.1rem', fontWeight: '600', marginBottom: '0.25rem', color: 'var(--text)' }}>
              {paymentModal.from} ➜ {paymentModal.to}
            </div>
            <button
              onClick={() => copyAmount(paymentModal.amount)}
              style={{
                background: amountCopied ? 'rgba(16, 185, 129, 0.15)' : 'rgba(255,255,255,0.05)',
                border: amountCopied ? '1px solid rgba(16, 185, 129, 0.4)' : '1px dashed var(--border)',
                borderRadius: '10px',
                padding: '0.5rem 1rem',
                marginBottom: '0.5rem',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                width: '100%',
              }}
            >
              <div style={{ fontSize: '1.5rem', fontWeight: '700', color: 'var(--primary)' }}>
                {cleanNumber(paymentModal.amount)}
              </div>
              <div style={{ fontSize: '0.65rem', color: amountCopied ? 'var(--success)' : 'var(--text-muted)', fontWeight: amountCopied ? '600' : '400' }}>
                {amountCopied ? '✅ הסכום הועתק!' : '📋 לחץ להעתקת הסכום'}
              </div>
            </button>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.75rem', direction: 'rtl' }}>
              העתיקו את הסכום והדביקו באפליקציית התשלום
            </div>

            <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem' }}>
              <button
                onClick={() => openPaymentApp('bit', paymentModal.amount)}
                style={{
                  flex: 1, padding: '0.75rem', borderRadius: '12px', border: 'none',
                  background: 'linear-gradient(135deg, #00d4aa, #00b894)', color: 'white',
                  fontSize: '1rem', fontWeight: '600', cursor: 'pointer',
                }}
              >
                💚 Bit
              </button>
              <button
                onClick={() => openPaymentApp('paybox', paymentModal.amount)}
                style={{
                  flex: 1, padding: '0.75rem', borderRadius: '12px', border: 'none',
                  background: 'linear-gradient(135deg, #667eea, #764ba2)', color: 'white',
                  fontSize: '1rem', fontWeight: '600', cursor: 'pointer',
                }}
              >
                💜 PayBox
              </button>
            </div>

            <button
              onClick={() => {
                toggleSettlementPaid(paymentModal.from, paymentModal.to);
                setPaymentModal(null);
              }}
              style={{
                width: '100%', padding: '0.6rem', borderRadius: '10px',
                border: '1px solid var(--border)', background: 'transparent',
                color: 'var(--text)', fontSize: '0.85rem', cursor: 'pointer',
                marginBottom: '0.5rem',
              }}
            >
              {isSettlementPaid(paymentModal.from, paymentModal.to) ? '↩️ סמן כלא שולם' : '✅ סמן כשולם'}
            </button>

            <button
              onClick={() => setPaymentModal(null)}
              style={{
                width: '100%', padding: '0.5rem', borderRadius: '10px',
                border: 'none', background: 'transparent',
                color: 'var(--text-muted)', fontSize: '0.8rem', cursor: 'pointer',
              }}
            >
              סגור
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default GameSummaryScreen;

