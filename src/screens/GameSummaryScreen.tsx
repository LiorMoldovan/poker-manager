import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import html2canvas from 'html2canvas';
import { GamePlayer, Settlement, SkippedTransfer, GameForecast, SharedExpense } from '../types';
import { getGame, getGamePlayers, getSettings, getChipValues, getPlayerStats, getAllGames, getAllGamePlayers } from '../database/storage';
import { calculateSettlement, formatCurrency, getProfitColor, cleanNumber, calculateCombinedSettlement } from '../utils/calculations';
import { generateForecastComparison, getGeminiApiKey } from '../utils/geminiAI';

const hebrewNum = (n: number, feminine: boolean): string => {
  const abs = Math.round(Math.abs(n));
  if (abs === 0) return 'אפס';
  if (abs > 10) return String(abs);
  if (feminine) {
    return ['', 'אחת', 'שתיים', 'שלוש', 'ארבע', 'חמש', 'שש', 'שבע', 'שמונה', 'תשע', 'עשר'][abs];
  }
  return ['', 'אחד', 'שניים', 'שלושה', 'ארבעה', 'חמישה', 'שישה', 'שבעה', 'שמונה', 'תשעה', 'עשרה'][abs];
};

const GameSummaryScreen = () => {
  const { gameId } = useParams<{ gameId: string }>();
  const navigate = useNavigate();
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
  const summaryRef = useRef<HTMLDivElement>(null);
  const settlementsRef = useRef<HTMLDivElement>(null);
  const forecastCompareRef = useRef<HTMLDivElement>(null);
  const expenseSettlementsRef = useRef<HTMLDivElement>(null);
  const funStatsRef = useRef<HTMLDivElement>(null);

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
    
    const sortedPlayers = gamePlayers.sort((a, b) => b.profit - a.profit);
    setPlayers(sortedPlayers);
    
    // Load shared expenses first
    const gameExpenses = game.sharedExpenses || [];
    if (gameExpenses.length > 0) {
      setSharedExpenses(gameExpenses);
    }
    
    // Calculate settlements - use COMBINED if there are expenses
    if (gameExpenses.length > 0) {
      const { settlements: settl, smallTransfers: small } = calculateCombinedSettlement(
        gamePlayers,
        gameExpenses,
        settings.minTransfer
      );
      setSettlements(settl);
      setSkippedTransfers(small);
    } else {
      const { settlements: settl, smallTransfers: small } = calculateSettlement(
        gamePlayers, 
        settings.minTransfer
      );
      setSettlements(settl);
      setSkippedTransfers(small);
    }
    
    // Load forecasts if available
    if (game.forecasts && game.forecasts.length > 0) {
      setForecasts(game.forecasts);
      
      // Generate AI comment about forecast accuracy
      if (getGeminiApiKey()) {
        setIsLoadingComment(true);
        try {
          const comment = await generateForecastComparison(game.forecasts, sortedPlayers);
          setForecastComment(comment);
        } catch (err) {
          console.error('Error generating forecast comment:', err);
        } finally {
          setIsLoadingComment(false);
        }
      }
    }
    
    // Calculate highlights — prioritized, period-focused, always exactly 10
    type Highlight = { emoji: string; label: string; detail: string; priority: number };
    const bank: Highlight[] = [];
    const settings2 = getSettings();
    const totalRebuysTonight = sortedPlayers.reduce((sum, p) => sum + p.rebuys, 0);
    const tonightsPot = totalRebuysTonight * settings2.rebuyValue;

    // Determine current period (H1/H2)
    const gameDate = new Date();
    const periodMonth = gameDate.getMonth() + 1;
    const periodYear = gameDate.getFullYear();
    const periodStart = new Date(periodYear, periodMonth <= 6 ? 0 : 6, 1);
    const periodLabel = periodMonth <= 6 ? `H1 ${periodYear}` : `H2 ${periodYear}`;

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
    setIsLoading(false);

    // TTS game summary announcement
    if ('speechSynthesis' in window && sortedPlayers.length >= 2) {
      setTimeout(() => {
        const voices = window.speechSynthesis.getVoices();
        const hebrewVoice = voices.find(v => v.lang.startsWith('he') && v.name.toLowerCase().includes('female'))
          || voices.find(v => v.lang.startsWith('he'))
          || null;

        const winner = sortedPlayers[0];
        const loser = sortedPlayers[sortedPlayers.length - 1];
        const totalBuyins = sortedPlayers.reduce((sum, p) => sum + p.rebuys, 0);
        const totalRebuysOnly = totalBuyins - sortedPlayers.length;

        // Format rebuy count with proper Hebrew for halves
        const formatRebuysHebrew = (n: number): string => {
          const hasHalf = Math.abs((n % 1) - 0.5) < 0.01;
          const whole = Math.floor(n);
          if (hasHalf) {
            if (whole === 0) return 'חצי';
            return `${hebrewNum(whole, true)} וחצי`;
          }
          return hebrewNum(whole, true);
        };

        const winMessages = [
          `המנצח הגדול של הערב הוא ${winner.playerName} עם פלוס ${cleanNumber(winner.profit)} שקל!`,
          `${winner.playerName} לוקח הכל הערב! פלוס ${cleanNumber(winner.profit)} שקל`,
          `ונצחון גדול ל${winner.playerName}! פלוס ${cleanNumber(winner.profit)} שקל`,
          `${winner.playerName} הולך הביתה עם פלוס ${cleanNumber(winner.profit)} שקל, כל הכבוד!`,
          `${winner.playerName} שולט הערב, פלוס ${cleanNumber(winner.profit)} שקל`,
          `הכסף הולך ל${winner.playerName}! פלוס ${cleanNumber(winner.profit)} שקל בכיס`,
          `${winner.playerName} סוגר את הערב עם חיוך, פלוס ${cleanNumber(winner.profit)} שקל`,
          `ו${winner.playerName} יוצא עם ${cleanNumber(winner.profit)} שקל יותר ממה שנכנס!`,
        ];
        const loseMessages = [
          `והתורם הרשמי של הערב, ${loser.playerName}, מינוס ${cleanNumber(Math.abs(loser.profit))} שקל. תודה על המימון!`,
          `${loser.playerName}, תודה על ${cleanNumber(Math.abs(loser.profit))} שקל. נתראה בפעם הבאה`,
          `ו${loser.playerName} משאיר ${cleanNumber(Math.abs(loser.profit))} שקל על השולחן. קלאסי`,
          `${loser.playerName} תרם ${cleanNumber(Math.abs(loser.profit))} שקל לשולחן, גיבור אמיתי`,
          `${loser.playerName} מפסיד ${cleanNumber(Math.abs(loser.profit))} שקל, אבל מי סופר`,
          `${loser.playerName} חוזר הביתה עם מינוס ${cleanNumber(Math.abs(loser.profit))} שקל, הערב לא היה שלו`,
          `ו${loser.playerName} שילם את החשבון הערב, מינוס ${cleanNumber(Math.abs(loser.profit))} שקל`,
          `${loser.playerName}, ${cleanNumber(Math.abs(loser.profit))} שקל מינוס, אבל מה זה כסף בין חברים`,
        ];
        const potMessage = `סך הכל ${formatRebuysHebrew(totalRebuysOnly)} קניות חוזרות הערב.`;

        const winMsg = winMessages[Math.floor(Math.random() * winMessages.length)];
        const loseMsg = loseMessages[Math.floor(Math.random() * loseMessages.length)];

        const fullMessage = `סיכום המשחק. ${potMessage} ${winMsg} ${loseMsg}`;

        const utterance = new SpeechSynthesisUtterance(fullMessage);
        utterance.lang = 'he-IL';
        if (hebrewVoice) utterance.voice = hebrewVoice;
        utterance.rate = 0.9;
        utterance.pitch = 1.0;
        utterance.volume = 1;
        window.speechSynthesis.speak(utterance);
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
      
      // Capture the Fun Stats / Highlights section if it exists
      if (funStatsRef.current && funStats.length > 0) {
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
      setIsSharing(false);
    }
  };

  return (
    <div className="fade-in">
      {/* Results Section - for screenshot */}
      <div ref={summaryRef} style={{ padding: '1rem', background: '#1a1a2e' }}>
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
                    <td style={{ whiteSpace: 'nowrap' }}>
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
          
          {chipGap !== null && chipGap !== 0 && (
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
        
        <div style={{ 
          textAlign: 'center', 
          marginTop: '1rem', 
          fontSize: '0.75rem', 
          color: 'var(--text-muted)',
          opacity: 0.7
        }}>
          Poker Manager 🎲
        </div>
      </div>

      {/* Settlements Section - for separate screenshot */}
      {settlements.length > 0 && (
        <div ref={settlementsRef} style={{ padding: '1rem', background: '#1a1a2e', marginTop: '-1rem' }}>
          <div className="card">
            <h2 className="card-title mb-2">💸 Settlements {sharedExpenses.length > 0 && <span style={{ fontSize: '0.7rem', color: '#f59e0b' }}>(+ 🍕)</span>}</h2>
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
          </div>

          {skippedTransfers.length > 0 && (
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
          
          <div style={{ 
            textAlign: 'center', 
            marginTop: '1rem', 
            fontSize: '0.75rem', 
            color: 'var(--text-muted)',
            opacity: 0.7
          }}>
            Poker Manager 🎲
          </div>
        </div>
      )}

      {/* Forecast vs Actual Comparison - for screenshot */}
      {forecasts.length > 0 && (
        <div ref={forecastCompareRef} style={{ padding: '0.75rem', background: '#1a1a2e', marginTop: '-1rem' }}>
          <div className="card" style={{ padding: '0.75rem' }}>
            <h2 className="card-title" style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>🎯 Forecast vs Reality</h2>
            
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
              {isLoadingComment && <span style={{ color: '#a855f7' }}>🤖 מסכם...</span>}
              {forecastComment && !isLoadingComment && <span>🤖 {forecastComment}</span>}
              {!forecastComment && !isLoadingComment && <span style={{ color: 'var(--text-muted)' }}>🤖 אין סיכום זמין</span>}
            </div>
          </div>
          
          <div style={{ 
            textAlign: 'center', 
            marginTop: '1rem', 
            fontSize: '0.75rem', 
            color: 'var(--text-muted)',
            opacity: 0.7
          }}>
            Poker Manager 🎲
          </div>
        </div>
      )}

      {/* Shared Expenses Info - separate screenshot (for reference only, settlements are combined) */}
      {sharedExpenses.length > 0 && (
        <div ref={expenseSettlementsRef} style={{ padding: '1rem', background: '#1a1a2e', marginTop: '-1rem' }}>
          <div className="card">
            <h2 className="card-title mb-2">🍕 Shared Expenses</h2>
            
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
                    {expense.paidByName} paid • {expense.participantNames.length} participants • ₪{cleanNumber(expense.amount / expense.participants.length)} each
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
          </div>
          
          <div style={{ 
            textAlign: 'center', 
            marginTop: '1rem', 
            fontSize: '0.75rem', 
            color: 'var(--text-muted)',
            opacity: 0.7
          }}>
            Poker Manager 🎲
          </div>
        </div>
      )}

      {/* Fun Stats & Shame Section - for screenshot */}
      {funStats.length > 0 && (
        <div ref={funStatsRef} style={{ padding: '1rem', background: '#1a1a2e', marginTop: '-1rem' }}>
          <div className="card">
            <h2 className="card-title mb-2">🎭 הרגעים של הערב</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {funStats.map((stat, idx) => (
                <div 
                  key={idx} 
                  style={{ 
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.75rem',
                    padding: '0.5rem 0.6rem',
                    background: 'rgba(255,255,255,0.03)',
                    borderRadius: '8px',
                    direction: 'rtl',
                  }}
                >
                  <span style={{ fontSize: '1.1rem', flexShrink: 0 }}>{stat.emoji}</span>
                  <span style={{ 
                    fontSize: '0.8rem', 
                    fontWeight: 600, 
                    color: 'var(--primary)',
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                    minWidth: '100px',
                  }}>
                    {stat.label}
                  </span>
                  <span style={{ 
                    fontSize: '0.8rem', 
                    color: 'var(--text)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}>
                    {stat.detail}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div style={{
            textAlign: 'center',
            marginTop: '1rem',
            fontSize: '0.75rem',
            color: 'var(--text-muted)',
            opacity: 0.7
          }}>
            Poker Manager 🎲
          </div>
        </div>
      )}

      {/* Action buttons - outside the screenshot area */}
      <div className="actions mt-3" style={{ display: 'flex', justifyContent: 'center', gap: '1rem' }}>
        <button className="btn btn-secondary btn-lg" onClick={() => navigate('/')}>
          🏠 Home
        </button>
        <button 
          className="btn btn-primary btn-lg" 
          onClick={handleShare}
          disabled={isSharing}
        >
          {isSharing ? '📸 Capturing...' : '📤 Share'}
        </button>
      </div>
    </div>
  );
};

export default GameSummaryScreen;

