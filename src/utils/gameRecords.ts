import { Game, GamePlayer, Player } from '../types';

export interface DetectedRecord {
  type: 'win_streak' | 'loss_streak' | 'best_win' | 'worst_loss' | 'max_rebuys' | 'pot';
  scope: 'all_time' | 'year' | 'period';
  scopeLabel: string;
  entity: 'group' | 'personal';
  isEqualed?: boolean;
  playerName?: string;
  emoji: string;
  label: string;
  detail: string;
  priority: number;
}

export interface NotableActiveStreak {
  playerId: string;
  playerName: string;
  type: 'win' | 'loss';
  streak: number;
  personalRecord: number;
  groupRecord: number;
  detail: string;
}

export interface GameNightRecordsResult {
  recordsBroken: DetectedRecord[];
  notableStreaks: NotableActiveStreak[];
}

export interface PlayerStreaks {
  currentStreak: number;
  longestWinStreak: number;
  longestLossStreak: number;
}

export interface StreakGameItem {
  id: string;
  date?: string;
  createdAt: string;
}

export interface StreakPlayerItem {
  gameId: string;
  playerId: string;
  profit: number;
}

export function computePlayerStreaks(
  playerId: string,
  gamesList: StreakGameItem[],
  gpList: StreakPlayerItem[]
): PlayerStreaks {
  const pGames = gpList.filter(gp => gp.playerId === playerId);
  if (pGames.length === 0) {
    return { currentStreak: 0, longestWinStreak: 0, longestLossStreak: 0 };
  }
  const gamesMap = new Map(gamesList.map(g => [g.id, g]));
  const sorted = pGames
    .filter(gp => gamesMap.has(gp.gameId))
    .sort((a, b) => {
      const ga = gamesMap.get(a.gameId)!;
      const gb = gamesMap.get(b.gameId)!;
      return new Date(ga.date || ga.createdAt).getTime() - new Date(gb.date || gb.createdAt).getTime();
    });

  let cur = 0;
  let maxW = 0;
  let maxL = 0;
  let tempW = 0;
  let tempL = 0;

  for (const pg of sorted) {
    if (pg.profit > 0) {
      tempW++;
      tempL = 0;
      if (tempW > maxW) maxW = tempW;
    } else if (pg.profit < 0) {
      tempL++;
      tempW = 0;
      if (tempL > maxL) maxL = tempL;
    } else {
      // Break-even (0) breaks streaks
      tempW = 0;
      tempL = 0;
    }
  }

  for (let i = sorted.length - 1; i >= 0; i--) {
    const profit = sorted[i].profit;
    if (profit > 0) {
      if (cur >= 0) cur++;
      else break;
    } else if (profit < 0) {
      if (cur <= 0) cur--;
      else break;
    } else {
      break;
    }
  }

  return { currentStreak: cur, longestWinStreak: maxW, longestLossStreak: maxL };
}

const fmtNum = (n: number) => Math.round(n).toLocaleString('he-IL');

export function detectGameNightRecords(params: {
  game: Game;
  tonightPlayers: { playerId: string; playerName: string; profit: number; rebuys: number }[];
  allGames: Game[];
  allGamePlayers: GamePlayer[];
  allPlayers: Player[];
  periodStart: Date;
  periodEnd: Date;
  periodLabel: string;
  rebuyValue: number;
}): GameNightRecordsResult {
  const {
    game,
    tonightPlayers,
    allGames,
    allGamePlayers,
    allPlayers,
    periodStart,
    periodEnd,
    periodLabel,
    rebuyValue,
  } = params;

  const gameId = game.id;
  const gameDate = new Date(game.date || game.createdAt);
  const gameYear = gameDate.getFullYear();

  // Completed games prior to tonight
  const allCompletedPrev = allGames.filter(g => g.status === 'completed' && g.id !== gameId);
  const yearCompletedPrev = allCompletedPrev.filter(
    g => new Date(g.date || g.createdAt).getFullYear() === gameYear
  );
  const periodCompletedPrev = allCompletedPrev.filter(g => {
    const d = new Date(g.date || g.createdAt);
    return d >= periodStart && d <= periodEnd;
  });

  const allPrevGP = allGamePlayers.filter(gp => gp.gameId !== gameId);
  const yearPrevGameIds = new Set(yearCompletedPrev.map(g => g.id));
  const yearPrevGP = allPrevGP.filter(gp => yearPrevGameIds.has(gp.gameId));
  const periodPrevGameIds = new Set(periodCompletedPrev.map(g => g.id));
  const periodPrevGP = allPrevGP.filter(gp => periodPrevGameIds.has(gp.gameId));

  const recordsBroken: DetectedRecord[] = [];
  const notableStreaks: NotableActiveStreak[] = [];

  // 1. Group Pot Record
  const tonightPot = tonightPlayers.reduce((s, p) => s + p.rebuys, 0) * rebuyValue;
  const prevPotsAllTime = allCompletedPrev.map(g =>
    allPrevGP.filter(gp => gp.gameId === g.id).reduce((s, gp) => s + gp.rebuys, 0) * rebuyValue
  );
  const maxPotAllTime = prevPotsAllTime.length ? Math.max(0, ...prevPotsAllTime) : 0;

  if (tonightPot > maxPotAllTime && maxPotAllTime > 0) {
    recordsBroken.push({
      type: 'pot',
      scope: 'all_time',
      scopeLabel: 'כל הזמנים',
      entity: 'group',
      emoji: '🏦',
      label: 'שיא קבוצתי כל הזמנים — קופה',
      detail: `קופה שוברת שיא היסטורי של ${fmtNum(tonightPot)} ש״ח! (השיא הקודם: ${fmtNum(maxPotAllTime)})`,
      priority: 1,
    });
  } else if (yearCompletedPrev.length >= 10) {
    const prevPotsYear = yearCompletedPrev.map(g =>
      yearPrevGP.filter(gp => gp.gameId === g.id).reduce((s, gp) => s + gp.rebuys, 0) * rebuyValue
    );
    const maxPotYear = prevPotsYear.length ? Math.max(0, ...prevPotsYear) : 0;
    if (tonightPot > maxPotYear && maxPotYear > 0) {
      recordsBroken.push({
        type: 'pot',
        scope: 'year',
        scopeLabel: `עונת ${gameYear}`,
        entity: 'group',
        emoji: '🏦',
        label: `שיא עונת ${gameYear} לקבוצה — קופה`,
        detail: `קופה שוברת שיא עונתי של ${fmtNum(tonightPot)} ש״ח! (היה ${fmtNum(maxPotYear)})`,
        priority: 2,
      });
    } else if (periodCompletedPrev.length >= 6) {
      const prevPotsPeriod = periodCompletedPrev.map(g =>
        periodPrevGP.filter(gp => gp.gameId === g.id).reduce((s, gp) => s + gp.rebuys, 0) * rebuyValue
      );
      const maxPotPeriod = prevPotsPeriod.length ? Math.max(0, ...prevPotsPeriod) : 0;
      if (tonightPot > maxPotPeriod && maxPotPeriod > 0) {
        recordsBroken.push({
          type: 'pot',
          scope: 'period',
          scopeLabel: periodLabel,
          entity: 'group',
          emoji: '🏦',
          label: `שיא ${periodLabel} לקבוצה — קופה`,
          detail: `קופה שוברת שיא ל${periodLabel} של ${fmtNum(tonightPot)} ש״ח! (היה ${fmtNum(maxPotPeriod)})`,
          priority: 2,
        });
      }
    }
  }

  // Group baselines for player comparisons
  let groupMaxWinStreakAllTime = 0;
  let groupMaxWinStreakHolder = '';
  for (const pl of allPlayers) {
    const s = computePlayerStreaks(pl.id, allCompletedPrev, allPrevGP);
    if (s.longestWinStreak > groupMaxWinStreakAllTime) {
      groupMaxWinStreakAllTime = s.longestWinStreak;
      groupMaxWinStreakHolder = pl.name;
    }
  }

  const groupMaxProfitAllTime = allPrevGP.length ? Math.max(0, ...allPrevGP.map(gp => gp.profit)) : 0;
  const groupWorstLossAllTime = allPrevGP.length ? Math.min(0, ...allPrevGP.map(gp => gp.profit)) : 0;
  const groupMaxRebuysAllTime = allPrevGP.length ? Math.max(0, ...allPrevGP.map(gp => gp.rebuys)) : 0;

  const groupMaxProfitYear = yearPrevGP.length ? Math.max(0, ...yearPrevGP.map(gp => gp.profit)) : 0;
  const groupWorstLossYear = yearPrevGP.length ? Math.min(0, ...yearPrevGP.map(gp => gp.profit)) : 0;
  const groupMaxRebuysYear = yearPrevGP.length ? Math.max(0, ...yearPrevGP.map(gp => gp.rebuys)) : 0;

  const groupMaxProfitPeriod = periodPrevGP.length ? Math.max(0, ...periodPrevGP.map(gp => gp.profit)) : 0;
  const groupWorstLossPeriod = periodPrevGP.length ? Math.min(0, ...periodPrevGP.map(gp => gp.profit)) : 0;
  const groupMaxRebuysPeriod = periodPrevGP.length ? Math.max(0, ...periodPrevGP.map(gp => gp.rebuys)) : 0;

  // 2. Group Single-Night Win Record
  const topWinner = tonightPlayers[0];
  if (topWinner && topWinner.profit > 0) {
    if (topWinner.profit > groupMaxProfitAllTime && groupMaxProfitAllTime > 0) {
      recordsBroken.push({
        type: 'best_win',
        scope: 'all_time',
        scopeLabel: 'כל הזמנים',
        entity: 'group',
        playerName: topWinner.playerName,
        emoji: '🌟',
        label: 'שיא קבוצתי כל הזמנים — נצחון',
        detail: `${topWinner.playerName} קבע שיא היסטורי לקבוצה עם \u200E+${fmtNum(topWinner.profit)} ש״ח! (היה \u200E+${fmtNum(groupMaxProfitAllTime)})`,
        priority: 1,
      });
    } else if (yearCompletedPrev.length >= 10 && topWinner.profit > groupMaxProfitYear && groupMaxProfitYear > 0) {
      recordsBroken.push({
        type: 'best_win',
        scope: 'year',
        scopeLabel: `עונת ${gameYear}`,
        entity: 'group',
        playerName: topWinner.playerName,
        emoji: '🌟',
        label: `שיא עונת ${gameYear} לקבוצה — נצחון`,
        detail: `${topWinner.playerName} קבע שיא עונתי לקבוצה עם \u200E+${fmtNum(topWinner.profit)} ש״ח! (היה \u200E+${fmtNum(groupMaxProfitYear)})`,
        priority: 2,
      });
    } else if (periodCompletedPrev.length >= 6 && topWinner.profit > groupMaxProfitPeriod && groupMaxProfitPeriod > 0) {
      recordsBroken.push({
        type: 'best_win',
        scope: 'period',
        scopeLabel: periodLabel,
        entity: 'group',
        playerName: topWinner.playerName,
        emoji: '🌟',
        label: `שיא ${periodLabel} לקבוצה — נצחון`,
        detail: `${topWinner.playerName} קבע שיא ל${periodLabel} עם \u200E+${fmtNum(topWinner.profit)} ש״ח! (היה \u200E+${fmtNum(groupMaxProfitPeriod)})`,
        priority: 2,
      });
    }
  }

  // 3. Group Single-Night Worst Loss Record
  const worstLoser = tonightPlayers[tonightPlayers.length - 1];
  if (worstLoser && worstLoser.profit < 0) {
    if (worstLoser.profit < groupWorstLossAllTime && groupWorstLossAllTime < 0) {
      recordsBroken.push({
        type: 'worst_loss',
        scope: 'all_time',
        scopeLabel: 'כל הזמנים',
        entity: 'group',
        playerName: worstLoser.playerName,
        emoji: '📉',
        label: 'שיא קבוצתי כל הזמנים — הפסד',
        detail: `${worstLoser.playerName} רשם את ההפסד הכבד בתולדות הקבוצה: ${fmtNum(worstLoser.profit)} ש״ח (היה ${fmtNum(groupWorstLossAllTime)})`,
        priority: 1,
      });
    } else if (yearCompletedPrev.length >= 10 && worstLoser.profit < groupWorstLossYear && groupWorstLossYear < 0) {
      recordsBroken.push({
        type: 'worst_loss',
        scope: 'year',
        scopeLabel: `עונת ${gameYear}`,
        entity: 'group',
        playerName: worstLoser.playerName,
        emoji: '📉',
        label: `שיא עונת ${gameYear} לקבוצה — הפסד`,
        detail: `${worstLoser.playerName} עם ההפסד הכבד ביותר בעונת ${gameYear}: ${fmtNum(worstLoser.profit)} ש״ח (היה ${fmtNum(groupWorstLossYear)})`,
        priority: 3,
      });
    } else if (periodCompletedPrev.length >= 6 && worstLoser.profit < groupWorstLossPeriod && groupWorstLossPeriod < 0) {
      recordsBroken.push({
        type: 'worst_loss',
        scope: 'period',
        scopeLabel: periodLabel,
        entity: 'group',
        playerName: worstLoser.playerName,
        emoji: '📉',
        label: `שיא ${periodLabel} לקבוצה — הפסד`,
        detail: `${worstLoser.playerName} עם ההפסד הכבד ב${periodLabel}: ${fmtNum(worstLoser.profit)} ש״ח (היה ${fmtNum(groupWorstLossPeriod)})`,
        priority: 3,
      });
    }
  }

  // 4. Group Max Rebuys Record
  const maxRebuysTonight = Math.max(...tonightPlayers.map(p => p.rebuys));
  const rebuyKings = tonightPlayers.filter(p => p.rebuys === maxRebuysTonight);
  if (maxRebuysTonight >= 4) {
    if (maxRebuysTonight > groupMaxRebuysAllTime && groupMaxRebuysAllTime > 0) {
      recordsBroken.push({
        type: 'max_rebuys',
        scope: 'all_time',
        scopeLabel: 'כל הזמנים',
        entity: 'group',
        emoji: '📛',
        label: 'שיא קבוצתי כל הזמנים — קניות',
        detail: `${rebuyKings.map(k => k.playerName).join(', ')} עם ${maxRebuysTonight} קניות (השיא הקודם: ${groupMaxRebuysAllTime})`,
        priority: 1,
      });
    } else if (yearCompletedPrev.length >= 10 && maxRebuysTonight > groupMaxRebuysYear && groupMaxRebuysYear > 0) {
      recordsBroken.push({
        type: 'max_rebuys',
        scope: 'year',
        scopeLabel: `עונת ${gameYear}`,
        entity: 'group',
        emoji: '📛',
        label: `שיא עונת ${gameYear} לקבוצה — קניות`,
        detail: `${rebuyKings.map(k => k.playerName).join(', ')} עם ${maxRebuysTonight} קניות (היה ${groupMaxRebuysYear})`,
        priority: 2,
      });
    } else if (periodCompletedPrev.length >= 6 && maxRebuysTonight > groupMaxRebuysPeriod && groupMaxRebuysPeriod > 0) {
      recordsBroken.push({
        type: 'max_rebuys',
        scope: 'period',
        scopeLabel: periodLabel,
        entity: 'group',
        emoji: '📛',
        label: `שיא ${periodLabel} לקבוצה — קניות`,
        detail: `${rebuyKings.map(k => k.playerName).join(', ')} עם ${maxRebuysTonight} קניות (היה ${groupMaxRebuysPeriod})`,
        priority: 2,
      });
    }
  }

  // 5. Individual Players: Streaks, Wins, Losses, Rebuys
  const tonightGameProxy: StreakGameItem = {
    id: gameId,
    date: game.date,
    createdAt: game.createdAt,
  };
  const tonightGPProxy: StreakPlayerItem[] = tonightPlayers.map(p => ({
    gameId,
    playerId: p.playerId,
    profit: p.profit,
  }));

  for (const tp of tonightPlayers) {
    const playerAllTimePrev = computePlayerStreaks(tp.playerId, allCompletedPrev, allPrevGP);
    const playerAllTimeNow = computePlayerStreaks(
      tp.playerId,
      [...allCompletedPrev, tonightGameProxy],
      [...allPrevGP, ...tonightGPProxy]
    );

    const activeStreak = playerAllTimeNow.currentStreak;
    let hasStreakRecord = false;

    // --- Win streak checks ---
    if (tp.profit > 0 && activeStreak >= 3) {
      // Group all-time streak record
      if (activeStreak > groupMaxWinStreakAllTime && groupMaxWinStreakAllTime >= 3) {
        recordsBroken.push({
          type: 'win_streak',
          scope: 'all_time',
          scopeLabel: 'כל הזמנים',
          entity: 'group',
          playerName: tp.playerName,
          emoji: '🌟',
          label: 'שיא קבוצתי כל הזמנים — רצף נצחונות',
          detail: `${tp.playerName} שבר את שיא כל הזמנים של הקבוצה עם ${activeStreak} נצחונות ברצף! (השיא הקודם: ${groupMaxWinStreakAllTime}${groupMaxWinStreakHolder ? ` של ${groupMaxWinStreakHolder}` : ''})`,
          priority: 1,
        });
        hasStreakRecord = true;
      } else if (
        activeStreak === groupMaxWinStreakAllTime &&
        groupMaxWinStreakAllTime >= 5 &&
        tp.playerName !== groupMaxWinStreakHolder
      ) {
        recordsBroken.push({
          type: 'win_streak',
          scope: 'all_time',
          scopeLabel: 'כל הזמנים',
          entity: 'group',
          isEqualed: true,
          playerName: tp.playerName,
          emoji: '🌟',
          label: 'השווה שיא קבוצתי כל הזמנים — רצף נצחונות',
          detail: `${tp.playerName} השווה את שיא כל הזמנים של הקבוצה עם ${activeStreak} נצחונות ברצף! (מוחזק ע״י ${groupMaxWinStreakHolder})`,
          priority: 1,
        });
        hasStreakRecord = true;
      }

      // Personal all-time streak record
      if (
        activeStreak > playerAllTimePrev.longestWinStreak &&
        playerAllTimePrev.longestWinStreak >= 2
      ) {
        recordsBroken.push({
          type: 'win_streak',
          scope: 'all_time',
          scopeLabel: 'כל הזמנים',
          entity: 'personal',
          playerName: tp.playerName,
          emoji: '🏆',
          label: 'שיא אישי כל הזמנים — רצף נצחונות',
          detail: `${tp.playerName} שבר את שיא כל הזמנים האישי שלו עם ${activeStreak} נצחונות ברצף! (השיא הקודם: ${playerAllTimePrev.longestWinStreak})`,
          priority: 1,
        });
        hasStreakRecord = true;
      } else if (
        activeStreak === playerAllTimePrev.longestWinStreak &&
        playerAllTimePrev.longestWinStreak >= 4
      ) {
        recordsBroken.push({
          type: 'win_streak',
          scope: 'all_time',
          scopeLabel: 'כל הזמנים',
          entity: 'personal',
          isEqualed: true,
          playerName: tp.playerName,
          emoji: '⭐',
          label: 'השווה שיא אישי כל הזמנים — רצף נצחונות',
          detail: `${tp.playerName} השווה את שיא כל הזמנים האישי שלו עם ${activeStreak} נצחונות ברצף!`,
          priority: 1,
        });
        hasStreakRecord = true;
      } else {
        // Season personal streak record
        const playerYearPrev = computePlayerStreaks(tp.playerId, yearCompletedPrev, yearPrevGP);
        const playerYearNow = computePlayerStreaks(
          tp.playerId,
          [...yearCompletedPrev, tonightGameProxy],
          [...yearPrevGP, ...tonightGPProxy]
        );
        if (
          yearCompletedPrev.length >= 10 &&
          playerYearNow.currentStreak > playerYearPrev.longestWinStreak &&
          playerYearNow.currentStreak >= 3 &&
          playerYearPrev.longestWinStreak >= 2
        ) {
          recordsBroken.push({
            type: 'win_streak',
            scope: 'year',
            scopeLabel: `עונת ${gameYear}`,
            entity: 'personal',
            playerName: tp.playerName,
            emoji: '🏆',
            label: `שיא אישי לעונת ${gameYear} — רצף נצחונות`,
            detail: `${tp.playerName} שבר את שיא עונת ${gameYear} שלו עם ${playerYearNow.currentStreak} נצחונות ברצף! (הקודם: ${playerYearPrev.longestWinStreak})`,
            priority: 2,
          });
          hasStreakRecord = true;
        } else {
          // Period personal streak record
          const playerPeriodPrev = computePlayerStreaks(
            tp.playerId,
            periodCompletedPrev,
            periodPrevGP
          );
          const playerPeriodNow = computePlayerStreaks(
            tp.playerId,
            [...periodCompletedPrev, tonightGameProxy],
            [...periodPrevGP, ...tonightGPProxy]
          );
          if (
            periodCompletedPrev.length >= 6 &&
            playerPeriodNow.currentStreak > playerPeriodPrev.longestWinStreak &&
            playerPeriodNow.currentStreak >= 3 &&
            playerPeriodPrev.longestWinStreak >= 2
          ) {
            recordsBroken.push({
              type: 'win_streak',
              scope: 'period',
              scopeLabel: periodLabel,
              entity: 'personal',
              playerName: tp.playerName,
              emoji: '🏆',
              label: `שיא אישי ל${periodLabel} — רצף נצחונות`,
              detail: `${tp.playerName} שבר את שיא ${periodLabel} שלו עם ${playerPeriodNow.currentStreak} נצחונות ברצף! (הקודם: ${playerPeriodPrev.longestWinStreak})`,
              priority: 2,
            });
            hasStreakRecord = true;
          }
        }
      }
    }

    // --- Loss streak checks ---
    if (tp.profit < 0 && activeStreak <= -4) {
      const absLoss = Math.abs(activeStreak);
      if (absLoss > playerAllTimePrev.longestLossStreak && playerAllTimePrev.longestLossStreak >= 3) {
        recordsBroken.push({
          type: 'loss_streak',
          scope: 'all_time',
          scopeLabel: 'כל הזמנים',
          entity: 'personal',
          playerName: tp.playerName,
          emoji: '💀',
          label: 'שיא שלילי אישי כל הזמנים — רצף הפסדים',
          detail: `${tp.playerName} ברצף הפסדים שובר שיא שלילי אישי של ${absLoss} הפסדים (הקודם: ${playerAllTimePrev.longestLossStreak})`,
          priority: 2,
        });
        hasStreakRecord = true;
      }
    }

    // --- Notable active streak (truthful comparison when NOT a record) ---
    if (activeStreak >= 4 && !hasStreakRecord) {
      notableStreaks.push({
        playerId: tp.playerId,
        playerName: tp.playerName,
        streak: activeStreak,
        type: 'win',
        personalRecord: playerAllTimePrev.longestWinStreak,
        groupRecord: groupMaxWinStreakAllTime,
        detail: `${tp.playerName} — רצף פעיל של ${activeStreak} נצחונות (שיא אישי: ${playerAllTimePrev.longestWinStreak}; שיא הקבוצה: ${groupMaxWinStreakAllTime})`,
      });
    } else if (activeStreak <= -4 && !hasStreakRecord) {
      notableStreaks.push({
        playerId: tp.playerId,
        playerName: tp.playerName,
        streak: Math.abs(activeStreak),
        type: 'loss',
        personalRecord: playerAllTimePrev.longestLossStreak,
        groupRecord: 0,
        detail: `${tp.playerName} — רצף פעיל של ${Math.abs(activeStreak)} הפסדים (שיא אישי שלילי: ${playerAllTimePrev.longestLossStreak})`,
      });
    }

    // --- Personal single-night best win ---
    if (tp.profit > 0) {
      const pPrevWinsAllTime = allPrevGP
        .filter(gp => gp.playerId === tp.playerId && gp.profit > 0)
        .map(gp => gp.profit);
      const pMaxWinAllTime = pPrevWinsAllTime.length ? Math.max(...pPrevWinsAllTime) : 0;

      if (tp.profit > pMaxWinAllTime && pMaxWinAllTime > 0 && pPrevWinsAllTime.length >= 3) {
        recordsBroken.push({
          type: 'best_win',
          scope: 'all_time',
          scopeLabel: 'כל הזמנים',
          entity: 'personal',
          playerName: tp.playerName,
          emoji: '🏆',
          label: 'שיא אישי כל הזמנים — נצחון',
          detail: `${tp.playerName} קבע את הניצחון הגדול בקריירה שלו: \u200E+${fmtNum(tp.profit)} ש״ח! (השיא הקודם: \u200E+${fmtNum(pMaxWinAllTime)})`,
          priority: 1,
        });
      } else {
        const pPrevWinsYear = yearPrevGP
          .filter(gp => gp.playerId === tp.playerId && gp.profit > 0)
          .map(gp => gp.profit);
        const pMaxWinYear = pPrevWinsYear.length ? Math.max(...pPrevWinsYear) : 0;

        if (
          yearCompletedPrev.length >= 10 &&
          tp.profit > pMaxWinYear &&
          pMaxWinYear > 0 &&
          pPrevWinsYear.length >= 2
        ) {
          recordsBroken.push({
            type: 'best_win',
            scope: 'year',
            scopeLabel: `עונת ${gameYear}`,
            entity: 'personal',
            playerName: tp.playerName,
            emoji: '🏆',
            label: `שיא אישי לעונת ${gameYear} — נצחון`,
            detail: `${tp.playerName} עם ניצחון השיא שלו בעונת ${gameYear}: \u200E+${fmtNum(tp.profit)} ש״ח (הקודם: \u200E+${fmtNum(pMaxWinYear)})`,
            priority: 2,
          });
        } else {
          const pPrevWinsPeriod = periodPrevGP
            .filter(gp => gp.playerId === tp.playerId && gp.profit > 0)
            .map(gp => gp.profit);
          const pMaxWinPeriod = pPrevWinsPeriod.length ? Math.max(...pPrevWinsPeriod) : 0;

          if (
            periodCompletedPrev.length >= 6 &&
            tp.profit > pMaxWinPeriod &&
            pMaxWinPeriod > 0 &&
            pPrevWinsPeriod.length >= 2
          ) {
            recordsBroken.push({
              type: 'best_win',
              scope: 'period',
              scopeLabel: periodLabel,
              entity: 'personal',
              playerName: tp.playerName,
              emoji: '🏆',
              label: `שיא אישי ל${periodLabel} — נצחון`,
              detail: `${tp.playerName} עם ניצחון השיא שלו ב${periodLabel}: \u200E+${fmtNum(tp.profit)} ש״ח (הקודם: \u200E+${fmtNum(pMaxWinPeriod)})`,
              priority: 2,
            });
          }
        }
      }
    }

    // --- Personal single-night worst loss ---
    if (tp.profit < 0) {
      const pPrevLossesAllTime = allPrevGP
        .filter(gp => gp.playerId === tp.playerId && gp.profit < 0)
        .map(gp => gp.profit);
      const pWorstLossAllTime = pPrevLossesAllTime.length ? Math.min(...pPrevLossesAllTime) : 0;

      if (tp.profit < pWorstLossAllTime && pWorstLossAllTime < 0 && pPrevLossesAllTime.length >= 3) {
        recordsBroken.push({
          type: 'worst_loss',
          scope: 'all_time',
          scopeLabel: 'כל הזמנים',
          entity: 'personal',
          playerName: tp.playerName,
          emoji: '📉',
          label: 'שיא אישי כל הזמנים — הפסד',
          detail: `${tp.playerName} רשם את ההפסד הכבד בקריירה שלו (${fmtNum(tp.profit)} ש״ח, הקודם היה ${fmtNum(pWorstLossAllTime)})`,
          priority: 2,
        });
      } else {
        const pPrevLossesYear = yearPrevGP
          .filter(gp => gp.playerId === tp.playerId && gp.profit < 0)
          .map(gp => gp.profit);
        const pWorstLossYear = pPrevLossesYear.length ? Math.min(...pPrevLossesYear) : 0;

        if (
          yearCompletedPrev.length >= 10 &&
          tp.profit < pWorstLossYear &&
          pWorstLossYear < 0 &&
          pPrevLossesYear.length >= 2
        ) {
          recordsBroken.push({
            type: 'worst_loss',
            scope: 'year',
            scopeLabel: `עונת ${gameYear}`,
            entity: 'personal',
            playerName: tp.playerName,
            emoji: '📉',
            label: `שיא אישי לעונת ${gameYear} — הפסד`,
            detail: `${tp.playerName} עם הפסד השיא שלו בעונת ${gameYear} (${fmtNum(tp.profit)} ש״ח, הקודם היה ${fmtNum(pWorstLossYear)})`,
            priority: 3,
          });
        } else {
          const pPrevLossesPeriod = periodPrevGP
            .filter(gp => gp.playerId === tp.playerId && gp.profit < 0)
            .map(gp => gp.profit);
          const pWorstLossPeriod = pPrevLossesPeriod.length ? Math.min(...pPrevLossesPeriod) : 0;

          if (
            periodCompletedPrev.length >= 6 &&
            tp.profit < pWorstLossPeriod &&
            pWorstLossPeriod < 0 &&
            pPrevLossesPeriod.length >= 2
          ) {
            recordsBroken.push({
              type: 'worst_loss',
              scope: 'period',
              scopeLabel: periodLabel,
              entity: 'personal',
              playerName: tp.playerName,
              emoji: '📉',
              label: `שיא אישי ל${periodLabel} — הפסד`,
              detail: `${tp.playerName} עם הפסד השיא שלו ב${periodLabel} (${fmtNum(tp.profit)} ש״ח, הקודם היה ${fmtNum(pWorstLossPeriod)})`,
              priority: 3,
            });
          }
        }
      }
    }

    // --- Personal single-night max rebuys ---
    if (tp.rebuys >= 5) {
      const pPrevRebuysAllTime = allPrevGP
        .filter(gp => gp.playerId === tp.playerId)
        .map(gp => gp.rebuys);
      const pMaxRebuysAllTime = pPrevRebuysAllTime.length ? Math.max(...pPrevRebuysAllTime) : 0;
      if (tp.rebuys > pMaxRebuysAllTime && pMaxRebuysAllTime >= 3) {
        recordsBroken.push({
          type: 'max_rebuys',
          scope: 'all_time',
          scopeLabel: 'כל הזמנים',
          entity: 'personal',
          playerName: tp.playerName,
          emoji: '📛',
          label: 'שיא אישי כל הזמנים — קניות',
          detail: `${tp.playerName} עם שיא אישי של ${tp.rebuys} קניות! (השיא הקודם שלו: ${pMaxRebuysAllTime})`,
          priority: 2,
        });
      }
    }
  }

  return { recordsBroken, notableStreaks };
}
