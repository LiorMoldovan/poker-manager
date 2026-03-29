import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import html2canvas from 'html2canvas';
import { GamePlayer, Settlement, SkippedTransfer, GameForecast, SharedExpense, PlayerStats, PeriodMarkers } from '../types';
import { getGame, getGamePlayers, getSettings, getChipValues, getPlayerStats, getAllGames, getAllGamePlayers, getAllPlayers, saveForecastAccuracy, saveForecastComment, saveGameAiSummary, isPlayerFemale } from '../database/storage';
import { calculateSettlement, formatCurrency, getProfitColor, cleanNumber, calculateCombinedSettlement, formatHebrewHalf } from '../utils/calculations';
import { generateForecastComparison, getGeminiApiKey, generateGameNightSummary, GameNightSummaryPayload, detectPeriodMarkers, buildLocationInsights, getModelDisplayName } from '../utils/geminiAI';
import { getComboHistory, buildComboHistoryText, ComboHistory } from '../utils/comboHistory';
import { speakHebrew } from '../utils/tts';
import { usePermissions } from '../App';
import AIProgressBar from '../components/AIProgressBar';
import { withAITiming } from '../utils/aiTiming';

const hebrewNum = (n: number, feminine: boolean): string => {
  const abs = Math.round(Math.abs(n));
  if (abs === 0) return 'אפס';
  const femOnes = ['', 'אחת', 'שתיים', 'שלוש', 'ארבע', 'חמש', 'שש', 'שבע', 'שמונה', 'תשע', 'עשר'];
  const mascOnes = ['', 'אחד', 'שניים', 'שלושה', 'ארבעה', 'חמישה', 'שישה', 'שבעה', 'שמונה', 'תשעה', 'עשרה'];
  const ones = feminine ? femOnes : mascOnes;
  if (abs <= 10) return ones[abs];
  if (abs <= 19) {
    const unit = abs - 10;
    const tenWord = feminine ? 'עשרה' : 'עשר';
    return `${ones[unit]} ${tenWord}`;
  }
  if (abs <= 99) {
    const tensWords = ['', '', 'עשרים', 'שלושים', 'ארבעים', 'חמישים', 'שישים', 'שבעים', 'שמונים', 'תשעים'];
    const ten = Math.floor(abs / 10);
    const unit = abs % 10;
    if (unit === 0) return tensWords[ten];
    return `${tensWords[ten]} ו${ones[unit]}`;
  }
  if (abs === 100) return 'מאה';
  return String(abs);
};

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
  const { role } = usePermissions();
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
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({ settlements: true, forecast: true, expenses: true, aiSummary: true, combo: true, monthly: false, standings: true });
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
  const [monthlyStats, setMonthlyStats] = useState<PlayerStats[]>([]);
  const [monthLabel, setMonthLabel] = useState('');
  const monthlyRef = useRef<HTMLDivElement>(null);
  const [comboHistory, setComboHistory] = useState<ComboHistory | null>(null);

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
    if (gameExpenses.length > 0) {
      const { settlements: settl, smallTransfers: small } = calculateCombinedSettlement(
        gamePlayers,
        gameExpenses,
        settings.minTransfer,
        gameDateStr
      );
      setSettlements(settl);
      setSkippedTransfers(small);
    } else {
      const { settlements: settl, smallTransfers: small } = calculateSettlement(
        gamePlayers, 
        settings.minTransfer,
        gameDateStr
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
      bank.push({ emoji: '👑', label: 'מלך הקניות', detail: `${names} — ${maxRebuys} קניות (₪${cleanNumber(maxRebuys * settings2.rebuyValue)})`, priority: 3 });
    }

    // 2. Comeback Win
    const comebackWinners = sortedPlayers.filter(p => p.profit > 0 && p.rebuys >= 5);
    if (comebackWinners.length > 0) {
      const parts = comebackWinners.sort((a, b) => b.rebuys - a.rebuys).map(p => `${p.playerName} (${p.rebuys} קניות, +₪${cleanNumber(p.profit)})`);
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
      const allGP = getAllGamePlayers();
      const previousGP = allGP.filter(gp => gp.gameId !== gameId);

      const periodGames = getAllGames().filter(g => {
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
              bank.push({ emoji: '⭐', label: 'שיא כל הזמנים', detail: `${player.playerName} חצה +₪${m} רווח כולל!`, priority: 1 });
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
        const parts = periodBestWins.map(w => `${w.name} (+₪${cleanNumber(w.profit)})`);
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
        const parts = periodProfitMilestones.map(m => `${m.name} — חצה +₪${m.amount}`);
        bank.push({ emoji: '💰', label: `אבן דרך רווח ב${pLabel}`, detail: parts.join(', '), priority: 2 });
      }
      if (periodTurnarounds.length > 0) {
        const parts = periodTurnarounds.map(t => `${t.name} (+₪${cleanNumber(t.newTotal)})`);
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
        bank.push({ emoji: '🥇', label: `מוביל ${pLabel}`, detail: `${leader.playerName} — +₪${cleanNumber(leader.totalProfit)}`, priority: 2 });
      }

      // --- Global records ---

      const historicalMaxRebuys = previousGP.length > 0 ? Math.max(...previousGP.map(gp => gp.rebuys)) : 0;
      if (maxRebuys > historicalMaxRebuys && historicalMaxRebuys > 0) {
        bank.push({ emoji: '📛', label: 'שיא קבוצתי — קניות', detail: `${rebuyKings[0].playerName} עם ${maxRebuys} (היה ${historicalMaxRebuys})`, priority: 1 });
      }

      const bigWinner = sortedPlayers[0];
      const historicalMaxProfit = previousGP.length > 0 ? Math.max(0, ...previousGP.map(gp => gp.profit)) : 0;
      if (bigWinner && bigWinner.profit > 0 && bigWinner.profit > historicalMaxProfit && historicalMaxProfit > 0) {
        bank.push({ emoji: '🌟', label: 'שיא קבוצתי — נצחון', detail: `${bigWinner.playerName} +₪${cleanNumber(bigWinner.profit)} (היה +₪${cleanNumber(historicalMaxProfit)})`, priority: 1 });
      }

      const allCompletedGames = getAllGames().filter(g => g.status === 'completed' && g.id !== gameId);
      let historicalMaxPot = 0;
      for (const g of allCompletedGames) {
        const gPlayers = allGP.filter(gp => gp.gameId === g.id);
        const pot = gPlayers.reduce((sum, gp) => sum + gp.rebuys, 0) * settings2.rebuyValue;
        if (pot > historicalMaxPot) historicalMaxPot = pot;
      }
      if (tonightsPot > historicalMaxPot && historicalMaxPot > 0) {
        bank.push({ emoji: '🏦', label: 'שיא קבוצתי — קופה', detail: `₪${cleanNumber(tonightsPot)} (היה ₪${cleanNumber(historicalMaxPot)})`, priority: 1 });
      }

      if (periodPrevGP.length > 0) {
        const periodMaxProfit = Math.max(0, ...periodPrevGP.map(gp => gp.profit));
        const topWinner = sortedPlayers[0];
        if (topWinner && topWinner.profit > 0 && topWinner.profit > periodMaxProfit && periodMaxProfit > 0) {
          bank.push({ emoji: '🌟', label: `שיא ${pLabel} — נצחון`, detail: `${topWinner.playerName} +₪${cleanNumber(topWinner.profit)} (היה +₪${cleanNumber(periodMaxProfit)})`, priority: 1 });
        }
      }

      // --- Fillers ---

      bank.push({ emoji: '💵', label: 'קופה הערב', detail: `₪${cleanNumber(tonightsPot)} — ${totalRebuysTonight} קניות סה״כ`, priority: 8 });

      const topProfit = sortedPlayers[0]?.profit || 0;
      const bottomProfit = sortedPlayers[sortedPlayers.length - 1]?.profit || 0;
      if (topProfit > 0 && bottomProfit < 0) {
        bank.push({ emoji: '📏', label: 'פער הערב', detail: `₪${cleanNumber(topProfit - bottomProfit)} — ${sortedPlayers[0].playerName} מול ${sortedPlayers[sortedPlayers.length - 1].playerName}`, priority: 8 });
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

    const halfGames = getAllGames().filter(g => {
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

    // Monthly summary table — primary: user confirmed at game creation; fallback: history-based
    const hebrewMonths = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
    const gameMonthIdx = actualGameDate.getMonth();
    const isLastGameOfMonth = gameYear >= 2026 && (
      game.periodMarkers?.isLastGameOfMonth ??
      !getAllGames().some(g => {
        if (g.status !== 'completed' || g.id === game.id) return false;
        const gd = new Date(g.date || g.createdAt);
        return gd.getFullYear() === gameYear && gd.getMonth() === gameMonthIdx && gd > actualGameDate;
      })
    );
    if (isLastGameOfMonth) {
      const monthStart = new Date(gameYear, gameMonthIdx, 1);
      const monthEnd = new Date(gameYear, gameMonthIdx + 1, 0, 23, 59, 59);
      const mStats = getPlayerStats({ start: monthStart, end: monthEnd });
      const monthGames = getAllGames().filter(g => {
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
          const allGamesForPeriod = getAllGames();
          const s = getSettings();
          return detectPeriodMarkers(new Date(game.date || game.createdAt), allGamesForPeriod, s.gameNightDays || [4, 6]);
        } catch { return undefined; }
      })();

      // Build location insights for the summary (only if genuinely interesting)
      const summaryLocInsights = (() => {
        if (!game.location) return undefined;
        const allGp = getAllGamePlayers();
        const allGm = getAllGames().filter(g => g.status === 'completed');
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
        comboHistoryText: !combo.isFirstTime ? buildComboHistoryText(combo) : undefined,
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
      
      // Capture the Results section
      const resultsCanvas = await html2canvas(summaryRef.current, {
        backgroundColor: '#1a1a2e',
        scale: 2,
        useCORS: true,
        logging: false,
      });
      
      const resultsBlob = await new Promise<Blob>((resolve) => {
        resultsCanvas.toBlob((b) => resolve(b!), 'image/png', 1.0);
      });
      files.push(new File([resultsBlob], 'poker-results.png', { type: 'image/png' }));
      
      // Capture the Settlements section if it exists
      if (settlementsRef.current && settlements.length > 0) {
        const settlementsCanvas = await html2canvas(settlementsRef.current, {
          backgroundColor: '#1a1a2e',
          scale: 2,
          useCORS: true,
          logging: false,
        });
        
        const settlementsBlob = await new Promise<Blob>((resolve) => {
          settlementsCanvas.toBlob((b) => resolve(b!), 'image/png', 1.0);
        });
        files.push(new File([settlementsBlob], 'poker-settlements.png', { type: 'image/png' }));
      }
      
      // Capture the Forecast vs Reality section if it exists
      if (forecastCompareRef.current && forecasts.length > 0) {
        const forecastCanvas = await html2canvas(forecastCompareRef.current, {
          backgroundColor: '#1a1a2e',
          scale: 2,
          useCORS: true,
          logging: false,
        });
        
        const forecastBlob = await new Promise<Blob>((resolve) => {
          forecastCanvas.toBlob((b) => resolve(b!), 'image/png', 1.0);
        });
        files.push(new File([forecastBlob], 'poker-forecast-vs-reality.png', { type: 'image/png' }));
      }
      
      // Capture the Expense Settlements section if it exists
      if (expenseSettlementsRef.current && sharedExpenses.length > 0) {
        const expenseCanvas = await html2canvas(expenseSettlementsRef.current, {
          backgroundColor: '#1a1a2e',
          scale: 2,
          useCORS: true,
          logging: false,
        });
        
        const expenseBlob = await new Promise<Blob>((resolve) => {
          expenseCanvas.toBlob((b) => resolve(b!), 'image/png', 1.0);
        });
        files.push(new File([expenseBlob], 'poker-expenses.png', { type: 'image/png' }));
      }
      
      // Capture the Game Night Summary / Highlights section if it exists
      if (funStatsRef.current && (aiSummary || funStats.length > 0)) {
        const funStatsCanvas = await html2canvas(funStatsRef.current, {
          backgroundColor: '#1a1a2e',
          scale: 2,
          useCORS: true,
          logging: false,
        });
        
        const funStatsBlob = await new Promise<Blob>((resolve) => {
          funStatsCanvas.toBlob((b) => resolve(b!), 'image/png', 1.0);
        });
        files.push(new File([funStatsBlob], 'poker-highlights.png', { type: 'image/png' }));
      }

      // Capture the Combo History section if it exists and has data
      if (comboHistoryRef.current && comboHistory && !comboHistory.isFirstTime) {
        const comboCanvas = await html2canvas(comboHistoryRef.current, {
          backgroundColor: '#1a1a2e',
          scale: 2,
          useCORS: true,
          logging: false,
        });

        const comboBlob = await new Promise<Blob>((resolve) => {
          comboCanvas.toBlob((b) => resolve(b!), 'image/png', 1.0);
        });
        files.push(new File([comboBlob], 'poker-combo-history.png', { type: 'image/png' }));
      }

      // Capture the Updated Standings table if it exists
      if (standingsRef.current && standingsData.length > 0) {
        const standingsCanvas = await html2canvas(standingsRef.current, {
          backgroundColor: '#1a1a2e',
          scale: 2,
          useCORS: true,
          logging: false,
        });

        const standingsBlob = await new Promise<Blob>((resolve) => {
          standingsCanvas.toBlob((b) => resolve(b!), 'image/png', 1.0);
        });
        files.push(new File([standingsBlob], 'poker-standings.png', { type: 'image/png' }));
      }
      
      // Try native share first (works on mobile)
      if (navigator.share && navigator.canShare({ files })) {
        await navigator.share({
          files,
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
        
        // Then open WhatsApp
        const dateStr = new Date(gameDate).toLocaleDateString('en-US', { 
          weekday: 'short', 
          month: 'short', 
          day: 'numeric' 
        });
        const text = `🃏 Poker Night Results - ${dateStr}\n\n(${files.length} images downloaded - attach them to this message)`;
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
            <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              Total Buyins: <span style={{ color: 'var(--text)', fontWeight: '600' }}>{players.reduce((sum, p) => sum + p.rebuys, 0)}</span>
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
                  <tr key={player.id}>
                    <td>
                      {player.playerName}
                      {index === 0 && player.profit > 0 && ' 🥇'}
                      {index === 1 && player.profit > 0 && ' 🥈'}
                      {index === 2 && player.profit > 0 && ' 🥉'}
                    </td>
                    <td style={{ textAlign: 'center', padding: '0.5rem 0.25rem' }} className="text-muted">
                      {(getTotalChips(player) / 1000).toFixed(0)}k
                    </td>
                    <td style={{ textAlign: 'center', padding: '0.5rem 0.25rem' }} className="text-muted">
                      {player.rebuys}
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} className={getProfitColor(player.profit)}>
                      {player.profit >= 0 ? '+' : ''}{formatCurrency(player.profit)}
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
              background: 'rgba(245, 158, 11, 0.1)', 
              borderRadius: '8px',
              borderLeft: '3px solid var(--warning)'
            }}>
              <div style={{ fontSize: '0.875rem', color: 'var(--warning)', fontWeight: '600' }}>
                ⚠️ Chip Count Adjustment
              </div>
              <div className="text-muted" style={{ fontSize: '0.875rem', marginTop: '0.25rem' }}>
                {chipGap > 0 ? (
                  <>Counted ₪{cleanNumber(chipGap)} more than expected (extra chips)</>
                ) : (
                  <>Counted ₪{cleanNumber(Math.abs(chipGap))} less than expected (missing chips)</>
                )}
              </div>
              <div className="text-muted" style={{ fontSize: '0.875rem' }}>
                Adjusted {chipGapPerPlayer && chipGapPerPlayer > 0 ? '-' : '+'}₪{cleanNumber(Math.abs(chipGapPerPlayer || 0))} per player to balance
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Settlements Section - for separate screenshot */}
      {settlements.length > 0 && (
        <div ref={settlementsRef} style={{ padding: '0.75rem', background: '#1a1a2e', marginTop: '-1rem' }}>
          <div className="card" style={{ padding: '0.75rem' }}>
            <button onClick={() => toggleSection('settlements')} style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 0, color: 'var(--text)', marginBottom: collapsedSections.settlements ? 0 : '0.5rem' }}>
              <h2 className="card-title" style={{ margin: 0 }}>💸 Settlements {sharedExpenses.length > 0 && <span style={{ fontSize: '0.7rem', color: '#f59e0b' }}>(+ 🍕)</span>}</h2>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', transform: collapsedSections.settlements ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform 0.2s' }}>▼</span>
            </button>
            {!collapsedSections.settlements && (<>
              {settlements.map((s, index) => (
                <div key={index} className="settlement-row">
                  <span>{renderPlayerWithFoodIcon(s.from)}</span>
                  <span className="settlement-arrow">➜</span>
                  <span>{renderPlayerWithFoodIcon(s.to)}</span>
                  <span className="settlement-amount">{formatCurrency(s.amount)}</span>
                </div>
              ))}
              {sharedExpenses.length > 0 && (
                <div style={{ 
                  marginTop: '0.75rem', 
                  paddingTop: '0.5rem', 
                  borderTop: '1px solid rgba(255,255,255,0.1)',
                }}>
                  {sharedExpenses.map((expense, idx) => (
                    <div key={idx} style={{ 
                      fontSize: '0.75rem', 
                      color: 'var(--text-muted)',
                      direction: 'rtl',
                      marginBottom: idx < sharedExpenses.length - 1 ? '0.4rem' : 0
                    }}>
                      <div>
                        <span style={{ fontSize: '0.9rem' }}>🍕</span> {expense.description} - ₪{cleanNumber(expense.amount)}
                      </div>
                      <div style={{ marginRight: '1.2rem', fontSize: '0.7rem' }}>
                        שילם: <span style={{ color: 'var(--primary)' }}>{expense.paidByName}</span>
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
              <p className="text-muted mb-1" style={{ fontSize: '0.875rem' }}>
                Payments below ₪{cleanNumber(getSettings().minTransfer)} are not mandatory
              </p>
              {skippedTransfers.map((s, index) => (
                <div key={index} className="settlement-row" style={{ opacity: 0.8 }}>
                  <span>{renderPlayerWithFoodIcon(s.from)}</span>
                  <span className="settlement-arrow">➜</span>
                  <span>{renderPlayerWithFoodIcon(s.to)}</span>
                  <span style={{ color: 'var(--warning)' }}>{formatCurrency(s.amount)}</span>
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
            <button onClick={() => toggleSection('forecast')} style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 0, color: 'var(--text)', marginBottom: collapsedSections.forecast ? 0 : '0.5rem' }}>
              <h2 className="card-title" style={{ margin: 0 }}>🎯 Forecast vs Reality</h2>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', transform: collapsedSections.forecast ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform 0.2s' }}>▼</span>
            </button>
            
            {!collapsedSections.forecast && (<>
            {/* Legend - compact */}
            <div style={{ 
              marginBottom: '0.5rem',
              padding: '0.3rem 0.5rem',
              background: 'rgba(100, 100, 100, 0.1)',
              borderRadius: '4px',
              fontSize: '0.65rem',
              color: 'var(--text-muted)',
              display: 'flex',
              justifyContent: 'center',
              gap: '0.75rem'
            }}>
              <span><span style={{ color: 'var(--success)' }}>✓</span> ≤30</span>
              <span><span style={{ color: 'var(--warning)' }}>~</span> 31-60</span>
              <span><span style={{ color: 'var(--danger)' }}>✗</span> &gt;60</span>
            </div>
            
            {/* Compact table - no scroll */}
            <table style={{ 
              width: '100%', 
              fontSize: '0.75rem',
              borderCollapse: 'collapse'
            }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th style={{ textAlign: 'left', padding: '0.3rem 0.2rem', fontSize: '0.7rem' }}>Player</th>
                  <th style={{ textAlign: 'center', padding: '0.3rem 0.2rem', fontSize: '0.7rem' }}>Fcst</th>
                  <th style={{ textAlign: 'center', padding: '0.3rem 0.2rem', fontSize: '0.7rem' }}>Real</th>
                  <th style={{ textAlign: 'center', padding: '0.3rem 0.2rem', fontSize: '0.7rem' }}>Gap</th>
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
                      if (gap <= 30) return { symbol: '✓', color: 'var(--success)' };
                      if (gap <= 60) return { symbol: '~', color: 'var(--warning)' };
                      return { symbol: '✗', color: 'var(--danger)' };
                    };
                    const accuracy = getAccuracyIndicator();
                    
                    return (
                      <tr key={forecast.playerName} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                        <td style={{ padding: '0.25rem 0.2rem', whiteSpace: 'nowrap' }}>
                          <span style={{ color: accuracy.color }}>{accuracy.symbol}</span> {forecast.playerName}
                        </td>
                        <td style={{ 
                          textAlign: 'center',
                          padding: '0.25rem 0.2rem',
                          color: forecast.expectedProfit >= 0 ? 'var(--success)' : 'var(--danger)'
                        }}>
                          {forecast.expectedProfit >= 0 ? '+' : ''}{Math.round(forecast.expectedProfit)}
                        </td>
                        <td style={{ 
                          textAlign: 'center',
                          padding: '0.25rem 0.2rem',
                          color: actualProfit >= 0 ? 'var(--success)' : 'var(--danger)',
                          fontWeight: '600'
                        }}>
                          {actualProfit >= 0 ? '+' : ''}{Math.round(actualProfit)}
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
                  color: 'var(--text-muted)',
                  direction: 'rtl'
                }}>
                  <span>🎯 כיוון: <span style={{ color: dirHits >= matched.length * 0.6 ? 'var(--success)' : 'var(--warning)', fontWeight: 600 }}>{dirHits}/{matched.length}</span></span>
                  <span>📊 פער ממוצע: <span style={{ color: avgGap <= 40 ? 'var(--success)' : avgGap <= 70 ? 'var(--warning)' : 'var(--danger)', fontWeight: 600 }}>{avgGap}₪</span></span>
                </div>
              );
            })()}

            {/* AI Summary - always show area */}
            <div style={{ 
              marginTop: '0.5rem', 
              padding: '0.5rem', 
              background: 'rgba(168, 85, 247, 0.1)',
              borderRadius: '6px',
              borderRight: '3px solid #a855f7',
              fontSize: '0.8rem',
              color: 'var(--text)',
              direction: 'rtl',
              textAlign: 'center',
              minHeight: '2rem'
            }}>
              {isLoadingComment && <><span style={{ color: '#a855f7' }}>🤖 Summarizing...</span><AIProgressBar operationKey="forecast_comparison" /></>}
              {forecastComment && !isLoadingComment && <span>🤖 {forecastComment}</span>}
              {!forecastComment && !isLoadingComment && <span style={{ color: 'var(--text-muted)' }}>🤖 No summary available</span>}
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
                        {forecast.expectedProfit >= 0 ? '+' : ''}{forecast.expectedProfit}₪
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
            <button onClick={() => toggleSection('expenses')} style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 0, color: 'var(--text)', marginBottom: collapsedSections.expenses ? 0 : '0.5rem' }}>
              <h2 className="card-title" style={{ margin: 0 }}>🍕 Shared Expenses</h2>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', transform: collapsedSections.expenses ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform 0.2s' }}>▼</span>
            </button>
            
            {!collapsedSections.expenses && (<>
            {/* Expense Summary */}
            <div>
              {sharedExpenses.map(expense => (
                <div key={expense.id} style={{ 
                  padding: '0.5rem', 
                  background: 'rgba(100, 100, 100, 0.1)', 
                  borderRadius: '6px',
                  marginBottom: '0.5rem',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: '600' }}>{expense.description}</span>
                    <span>₪{cleanNumber(expense.amount)}</span>
                  </div>
                  <div className="text-muted" style={{ fontSize: '0.8rem' }}>
                    {expense.paidByName} paid • {expense.participantNames.length} participants • ₪{cleanNumber(expense.participants.length > 0 ? expense.amount / expense.participants.length : 0)} each
                  </div>
                </div>
              ))}
            </div>
            
            {/* Total */}
            <div style={{ 
              marginTop: '0.5rem', 
              padding: '0.5rem', 
              background: 'rgba(245, 158, 11, 0.1)', 
              borderRadius: '6px',
              textAlign: 'center',
            }}>
              <span className="text-muted">Total: </span>
              <span style={{ fontWeight: '600', color: '#f59e0b' }}>₪{cleanNumber(totalExpenseAmount)}</span>
            </div>
            
            {/* Note about combined settlements */}
            <div style={{ 
              marginTop: '0.5rem', 
              fontSize: '0.75rem', 
              color: 'var(--text-muted)',
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
            <button onClick={() => toggleSection('aiSummary')} style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 0, color: 'var(--text)', marginBottom: collapsedSections.aiSummary ? 0 : '0.5rem' }}>
              <h2 className="card-title" style={{ margin: 0 }}>{aiSummary ? '🎭 Game Night Summary' : '🎭 Game Highlights'}</h2>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', transform: collapsedSections.aiSummary ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform 0.2s' }}>▼</span>
            </button>
            {!collapsedSections.aiSummary && role === 'admin' && aiSummary && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.4rem' }}>
                <span
                  className="btn btn-sm"
                  style={{ background: 'rgba(168, 85, 247, 0.15)', color: '#A855F7', border: '1px solid rgba(168, 85, 247, 0.3)', fontSize: '0.7rem', padding: '0.2rem 0.5rem', cursor: 'pointer' }}
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
                    color: 'var(--text)',
                    padding: '0.75rem',
                    background: 'rgba(168, 85, 247, 0.06)',
                    borderRadius: '8px',
                    borderRight: '3px solid var(--primary)',
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
                      <div style={{ fontSize: '0.55rem', color: 'var(--text-muted)', textAlign: 'center', marginTop: '0.5rem', opacity: 0.6 }}>
                        model: {aiSummaryModel}
                      </div>
                    )}
                  </div>
                ) : isLoadingAiSummary ? (
                  <div style={{
                    direction: 'rtl',
                    textAlign: 'center',
                    padding: '1.5rem',
                    color: 'var(--text-muted)',
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
                        background: 'rgba(239, 68, 68, 0.12)',
                        border: '1px solid rgba(239, 68, 68, 0.3)',
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
                            background: 'rgba(255,255,255,0.03)',
                            borderRadius: '6px',
                            direction: 'rtl',
                          }}
                        >
                          <span style={{ fontSize: '0.95rem', flexShrink: 0, lineHeight: 1.4 }}>{stat.emoji}</span>
                          <span style={{
                            fontSize: '0.75rem',
                            lineHeight: 1.5,
                            color: 'var(--text)',
                            flex: 1,
                            minWidth: 0,
                            wordBreak: 'break-word',
                          }}>
                            <span style={{ fontWeight: 600, color: 'var(--primary)' }}>{stat.label}</span>
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
            <button onClick={() => toggleSection('combo')} style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 0, color: 'var(--text)', marginBottom: collapsedSections.combo ? 0 : '0.75rem' }}>
              <h2 className="card-title" style={{ margin: 0 }}>
                {comboHistory.isFirstTime ? '🆕 New Combo' : '🔄 Returning Combo'}
              </h2>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', transform: collapsedSections.combo ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform 0.2s' }}>▼</span>
            </button>

            {!collapsedSections.combo && (comboHistory.isFirstTime ? (
              <div style={{
                direction: 'rtl',
                textAlign: 'right',
                fontSize: '0.85rem',
                color: '#e2e8f0',
                padding: '0.75rem',
                borderRadius: '10px',
                background: 'linear-gradient(135deg, rgba(34, 197, 94, 0.08), rgba(16, 185, 129, 0.06))',
                border: '1px solid rgba(34, 197, 94, 0.2)',
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
                      background: ps.alwaysWon ? 'rgba(34, 197, 94, 0.08)' : ps.alwaysLost ? 'rgba(239, 68, 68, 0.08)' : 'transparent',
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
                          color: ps.totalProfit > 0 ? 'var(--success)' : ps.totalProfit < 0 ? 'var(--danger)' : '#94a3b8',
                          fontSize: '0.78rem',
                          minWidth: '3.5rem',
                          textAlign: 'left',
                        }}>
                          {ps.totalProfit >= 0 ? '+' : ''}{Math.round(ps.totalProfit)}₪
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
                    insights.push({ emoji: '🎢', text: `התנודה הגדולה: ${bigSwing.playerName} — בין +${Math.round(bigSwing.bestResult)}₪ ל-${Math.round(bigSwing.worstResult)}₪`, color: '#94a3b8' });
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
            <button onClick={() => toggleSection('monthly')} style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 0, color: 'var(--text)', marginBottom: collapsedSections.monthly ? 0 : '0.5rem' }}>
              <h2 className="card-title" style={{ margin: 0 }}>📅 סיכום חודש {monthLabel}</h2>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', transform: collapsedSections.monthly ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform 0.2s' }}>▼</span>
            </button>
            {!collapsedSections.monthly && (<>
            <div style={{
              textAlign: 'center',
              fontSize: '0.65rem',
              color: 'var(--text-muted)',
              marginBottom: '0.5rem',
              paddingBottom: '0.3rem',
              borderBottom: '1px solid var(--border)',
            }}>
              <span>📊 {monthlyStats.reduce((max, s) => Math.max(max, s.gamesPlayed), 0)} games this month</span>
            </div>
            <table style={{ width: '100%', fontSize: '0.75rem', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th style={{ padding: '0.3rem 0.2rem', whiteSpace: 'nowrap', width: '24px', textAlign: 'left' }}>#</th>
                  <th style={{ padding: '0.3rem 0.2rem', whiteSpace: 'nowrap', textAlign: 'left' }}>Player</th>
                  <th style={{ textAlign: 'right', padding: '0.3rem 0.3rem', whiteSpace: 'nowrap' }}>Profit</th>
                  <th style={{ textAlign: 'right', padding: '0.3rem 0.3rem', whiteSpace: 'nowrap' }}>Avg</th>
                  <th style={{ textAlign: 'center', padding: '0.3rem 0.2rem', whiteSpace: 'nowrap' }}>G</th>
                  <th style={{ textAlign: 'center', padding: '0.3rem 0.2rem', whiteSpace: 'nowrap' }}>W%</th>
                </tr>
              </thead>
              <tbody>
                {monthlyStats.map((player, index) => {
                  const isInThisGame = players.some(p => p.playerId === player.playerId);
                  return (
                    <tr key={player.playerId} style={{
                      borderBottom: '1px solid rgba(255,255,255,0.05)',
                      background: isInThisGame ? 'rgba(59, 130, 246, 0.12)' : undefined,
                      borderRight: isInThisGame ? '3px solid rgba(59, 130, 246, 0.5)' : '3px solid transparent',
                    }}>
                      <td style={{ padding: '0.25rem 0.2rem', whiteSpace: 'nowrap' }}>
                        {index + 1}
                        {index === 0 && ' 🥇'}
                        {index === 1 && ' 🥈'}
                        {index === 2 && ' 🥉'}
                      </td>
                      <td style={{
                        fontWeight: isInThisGame ? '700' : '500',
                        padding: '0.25rem 0.2rem',
                      }}>
                        {player.playerName}
                      </td>
                      <td style={{
                        textAlign: 'right',
                        padding: '0.25rem 0.3rem',
                        whiteSpace: 'nowrap',
                        fontWeight: '700',
                        color: player.totalProfit >= 0 ? 'var(--success)' : 'var(--danger)',
                      }}>
                        {player.totalProfit >= 0 ? '+' : '-'}₪{cleanNumber(Math.abs(player.totalProfit))}
                      </td>
                      <td style={{
                        textAlign: 'right',
                        padding: '0.25rem 0.3rem',
                        whiteSpace: 'nowrap',
                        color: player.avgProfit >= 0 ? 'var(--success)' : 'var(--danger)',
                      }}>
                        {player.avgProfit >= 0 ? '+' : '-'}₪{cleanNumber(Math.abs(player.avgProfit))}
                      </td>
                      <td style={{ textAlign: 'center', padding: '0.25rem 0.2rem', whiteSpace: 'nowrap' }}>
                        {player.gamesPlayed}
                      </td>
                      <td style={{
                        textAlign: 'center',
                        padding: '0.25rem 0.2rem',
                        whiteSpace: 'nowrap',
                        color: player.winPercentage >= 50 ? 'var(--success)' : 'var(--danger)',
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
          <div className="card" style={{ padding: '0.75rem' }}>
            <button onClick={() => toggleSection('standings')} style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 0, color: 'var(--text)', marginBottom: collapsedSections.standings ? 0 : '0.5rem' }}>
              <h2 className="card-title" style={{ margin: 0 }}>🏆 Updated Standings — {standingsLabel}</h2>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', transform: collapsedSections.standings ? 'rotate(0deg)' : 'rotate(180deg)', transition: 'transform 0.2s' }}>▼</span>
            </button>
            {!collapsedSections.standings && (<>
            <div style={{
              textAlign: 'center',
              fontSize: '0.65rem',
              color: 'var(--text-muted)',
              marginBottom: '0.5rem',
              paddingBottom: '0.3rem',
              borderBottom: '1px solid var(--border)',
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
                  background: 'rgba(168, 85, 247, 0.25)',
                  border: '1px solid rgba(168, 85, 247, 0.5)',
                }} />
                Played tonight
              </span>
            </div>
            <table style={{ width: '100%', fontSize: '0.75rem', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  <th style={{ padding: '0.3rem 0.2rem', whiteSpace: 'nowrap', width: '24px', textAlign: 'left' }}>#</th>
                  <th style={{ padding: '0.3rem 0.2rem', whiteSpace: 'nowrap', textAlign: 'left' }}>Player</th>
                  <th style={{ textAlign: 'right', padding: '0.3rem 0.3rem', whiteSpace: 'nowrap' }}>Profit</th>
                  <th style={{ textAlign: 'right', padding: '0.3rem 0.3rem', whiteSpace: 'nowrap' }}>Avg</th>
                  <th style={{ textAlign: 'center', padding: '0.3rem 0.2rem', whiteSpace: 'nowrap' }}>G</th>
                  <th style={{ textAlign: 'center', padding: '0.3rem 0.2rem', whiteSpace: 'nowrap' }}>W%</th>
                </tr>
              </thead>
              <tbody>
                {standingsData.map((player, index) => {
                  const isInThisGame = players.some(p => p.playerId === player.playerId);
                  return (
                    <tr key={player.playerId} style={{
                      borderBottom: '1px solid rgba(255,255,255,0.05)',
                      background: isInThisGame ? 'rgba(168, 85, 247, 0.15)' : undefined,
                      borderRight: isInThisGame ? '3px solid rgba(168, 85, 247, 0.6)' : '3px solid transparent',
                    }}>
                      <td style={{ padding: '0.25rem 0.2rem', whiteSpace: 'nowrap' }}>
                        {index + 1}
                        {index === 0 && ' 🥇'}
                        {index === 1 && ' 🥈'}
                        {index === 2 && ' 🥉'}
                      </td>
                      <td style={{
                        fontWeight: isInThisGame ? '700' : '500',
                        padding: '0.25rem 0.2rem',
                        whiteSpace: 'nowrap',
                      }}>
                        {player.playerName}
                      </td>
                      <td style={{
                        textAlign: 'right',
                        padding: '0.25rem 0.3rem',
                        whiteSpace: 'nowrap',
                        fontWeight: '700',
                        color: player.totalProfit >= 0 ? 'var(--success)' : 'var(--danger)',
                      }}>
                        {player.totalProfit >= 0 ? '+' : '-'}₪{cleanNumber(Math.abs(player.totalProfit))}
                      </td>
                      <td style={{
                        textAlign: 'right',
                        padding: '0.25rem 0.3rem',
                        whiteSpace: 'nowrap',
                        color: player.avgProfit >= 0 ? 'var(--success)' : 'var(--danger)',
                      }}>
                        {player.avgProfit >= 0 ? '+' : '-'}₪{cleanNumber(Math.abs(player.avgProfit))}
                      </td>
                      <td style={{ textAlign: 'center', padding: '0.25rem 0.2rem', whiteSpace: 'nowrap' }}>
                        {player.gamesPlayed}
                      </td>
                      <td style={{
                        textAlign: 'center',
                        padding: '0.25rem 0.2rem',
                        whiteSpace: 'nowrap',
                        color: player.winPercentage >= 50 ? 'var(--success)' : 'var(--danger)',
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
              color: 'var(--text-muted)',
              opacity: 0.7
            }}>
              Poker Manager 🎲
            </div>
          </div>
        </div>
      )}

      {/* Action buttons - outside the screenshot area */}
      <div className="actions mt-3" style={{ display: 'flex', justifyContent: 'center', gap: '1rem' }}>
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
    </div>
  );
};

export default GameSummaryScreen;

