import { Game, GamePlayer, Player } from '../types';
import { getAllGames, getAllGamePlayers, getAllPlayers, getSettings } from '../database/storage';

export type RecapPeriodType = 'month' | 'h1' | 'h2' | 'year';

export const HEBREW_MONTHS = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
];

export interface RecapPlayerEntry {
  playerId: string;
  playerName: string;
  profit: number;
  gamesPlayed: number;
  wins: number;
  winRate: number;
  avgProfit: number;
  totalRebuys: number;
  totalInvested: number;
  bestSingleWin: number;
  bestSingleWinDate: string;
  longestWinStreak: number;
  rank: number;
}

export interface PeriodRecordHighlight {
  id: string;
  icon: string;
  type: 'career_best_win' | 'career_best_month' | 'streak' | 'iron_man' | 'big_comeback' | 'turbulent_game' | 'group_record' | 'all_time_record';
  title: string;
  playerName?: string;
  playerId?: string;
  badge?: string;
  description: string;
}

export interface PeriodStory {
  id: string;
  icon: string;
  type: 'rank_surge' | 'rank_fall' | 'top_takeover' | 'all_time_shift' | 'career_milestone';
  title: string;
  badge?: string;
  badgeVariant?: 'green' | 'amber' | 'red' | 'blue' | 'purple';
  playerName?: string;
  description: string;
}

export interface FourthAward {
  type: 'hotStreak' | 'topAverage' | 'ironAttendance';
  icon: string;
  title: string;
  playerName: string;
  subtitle: string;
  profit?: number;
}

export interface PeriodRecapData {
  periodKey: string;         // e.g. 'recap_2025-10', 'recap_2025-H1', 'recap_2025-YEAR'
  periodType: RecapPeriodType;
  year: number;
  month?: number;            // 1..12 when periodType === 'month'
  title: string;             // e.g. 'סיכום אוקטובר 2025'
  shortLabel: string;        // e.g. 'אוקטובר 2025'
  isCompletedPeriod: boolean;
  gamesCount: number;
  totalUniquePlayers: number;      // ALL distinct players who played in the period
  activeThreshold: number;         // Minimum games to be considered active
  nonActivePlayers: RecapPlayerEntry[]; // Players who played < activeThreshold (guests & infrequent)
  totalPot: number;
  totalRebuys: number;
  avgPotPerGame: number;
  avgPlayersPerGame: number;
  maxPlayersInGame: number;
  profitablePlayersCount: number;
  topLocation?: { name: string; count: number };
  biggestGamePot?: { pot: number; date: string };
  podium: RecapPlayerEntry[];     // top 3 active players with profit > 0 (or top 3 active)
  allRanked: RecapPlayerEntry[];  // all active players ranked by profit
  records: PeriodRecordHighlight[]; // High-impact milestones and broken records
  stories: PeriodStory[];          // Key stories, standing shifts & macro movements
  awards: {
    sniper?: { playerName: string; winRate: number; wins: number; games: number; profit: number };
    bigHit?: { playerName: string; profit: number; date: string };
    hotStreak?: { playerName: string; streak: number; profit: number };
    fourthAward?: FourthAward;
    atm?: { playerName: string; totalRebuys: number; avgRebuys: number; totalInvested: number; games: number; profit: number };
  };
  deterministicHighlights: string[];
  regularPlayersSummary?: Array<{
    playerId: string;
    playerName: string;
    gamesPlayed: number;
    profit: number;
    winRate: number;
    totalRebuys: number;
    status: string;
  }>;
}

export interface PlayerMonthCell {
  year: number;
  month: number; // 1..12
  monthName: string;
  gamesInMonth: number;
  playerGames: number;
  profit: number;
  rank: number | null; // 1, 2, 3, or >3 among active players (null if didn't meet threshold or 0 games)
  isChamp: boolean;
  isSilver: boolean;
  isBronze: boolean;
  isSniper: boolean;
  isBigHit: boolean;
}

export interface PlayerYearTrophyMatrix {
  year: number;
  isYearChamp: boolean;
  yearRank: number | null;
  yearProfit: number;
  isH1Champ: boolean;
  h1Rank: number | null;
  isH2Champ: boolean;
  h2Rank: number | null;
  months: PlayerMonthCell[]; // 12 items (1..12)
}

export interface CompactTrophyPill {
  id: string;
  icon: string;
  label: string;
  count: number;
  color: string;
  bg: string;
  border: string;
}

export interface PlayerTrophyCabinet {
  playerId: string;
  playerName: string;
  reigningBadge?: {
    label: string; // e.g. '👑 אלוף אוקטובר'
    periodType: RecapPeriodType;
    year: number;
    month?: number;
  };
  yearlyChamps: string[];    // e.g. ['2025', '2024']
  yearlyPodiums: number;
  halfChamps: string[];      // e.g. ['H2 2025', 'H1 2025']
  halfPodiums: number;
  monthlyChamps: number;     // 🥇
  monthlySilvers: number;    // 🥈
  monthlyBronzes: number;    // 🥉
  monthlyPodiums: number;    // 🥇 + 🥈 + 🥉
  monthlySnipers: number;    // 🎯
  monthlyBigHits: number;    // 💥
  totalTrophiesCount: number;
  compactPills: CompactTrophyPill[]; // Max 4 pills for the mobile player card
  yearsMatrix: PlayerYearTrophyMatrix[];
}

export interface MonthlyHallOfFameRow {
  year: number;
  month: number; // 1..12
  monthName: string;
  gamesCount: number;
  totalPot: number;
  top3: Array<{ playerId: string; playerName: string; profit: number; games: number }>;
  bigHit?: { playerName: string; profit: number };
  sniper?: { playerName: string; winRate: number };
}

function getGameDate(g: Game): Date {
  return new Date(g.date || g.createdAt);
}

function formatShortDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return '';
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

export function buildPeriodKey(periodType: RecapPeriodType, year: number, month?: number): string {
  if (periodType === 'month' && month) {
    return `recap_${year}-${String(month).padStart(2, '0')}`;
  }
  if (periodType === 'h1') return `recap_${year}-H1`;
  if (periodType === 'h2') return `recap_${year}-H2`;
  return `recap_${year}-YEAR`;
}

function isPeriodCompleted(periodType: RecapPeriodType, year: number, month?: number): boolean {
  const now = new Date();
  const curY = now.getFullYear();
  const curM = now.getMonth() + 1;
  if (periodType === 'year') return year < curY;
  if (periodType === 'h1') return year < curY || (year === curY && curM > 6);
  if (periodType === 'h2') return year < curY;
  if (periodType === 'month' && month) {
    return year < curY || (year === curY && month < curM);
  }
  return false;
}

/**
 * Unifies two significant records of the same player into a single prestigious card,
 * preventing duplicate cards for the same person without losing either milestone.
 */
function combinePlayerRecords(
  r1: PeriodRecordHighlight,
  r2: PeriodRecordHighlight
): PeriodRecordHighlight {
  function recordScore(r: PeriodRecordHighlight): number {
    if (r.type === 'all_time_record' || r.type === 'group_record') return 100;
    if (r.type === 'career_best_month') return 90;
    if (r.type === 'career_best_win') return 80;
    if (r.title.includes('מושלם') || r.title.includes('רצף')) return 70;
    if (r.title.includes('מלך הריבאי')) return 60;
    if (r.type === 'big_comeback') return 50;
    return 40;
  }

  const [primary, secondary] = recordScore(r1) >= recordScore(r2) ? [r1, r2] : [r2, r1];
  const pName = primary.playerName || secondary.playerName || 'שחקן';
  const pId = primary.playerId || secondary.playerId;

  const icon = (primary.icon === '👑' || secondary.icon === '👑')
    ? '👑'
    : (primary.icon === '🔥' || secondary.icon === '🔥')
      ? '🔥'
      : (primary.icon === '🌟' || secondary.icon === '🌟')
        ? '🌟'
        : primary.icon;

  let title = `דאבל הישגים היסטורי: ${pName}`;
  const t1 = primary.title || '';
  const t2 = secondary.title || '';

  if (t1.includes('חודש שיא') && (t2.includes('מושלם') || t2.includes('רצף'))) {
    title = `חודש שיא ומאזן מושלם: ${pName}`;
  } else if ((t1.includes('מושלם') || t1.includes('רצף')) && t2.includes('חודש שיא')) {
    title = `חודש שיא ומאזן מושלם: ${pName}`;
  } else if (t1.includes('טופ 10') && t2.includes('חודש שיא')) {
    title = `חודש שיא וטופ 10 היסטורי: ${pName}`;
  } else if (t1.includes('חודש שיא') && t2.includes('טופ 10')) {
    title = `חודש שיא וטופ 10 היסטורי: ${pName}`;
  } else if ((t1.includes('שיא') || t1.includes('טופ')) && (t2.includes('רצף') || t2.includes('אקשן'))) {
    title = `שיא אישי ורצף לוהט: ${pName}`;
  } else if (t1.includes('מלך הריבאי') && (t2.includes('רצף') || t2.includes('קאמבק'))) {
    title = `מנוע אקשן ומהפך: ${pName}`;
  } else {
    title = `דאבל שיאים והישגים: ${pName}`;
  }

  const badge = 'דאבל שיאים אישי';

  const d1Clean = primary.description.trim().replace(/[!.]+$/, '');
  let d2Clean = secondary.description.trim().replace(/[!.]+$/, '');

  if (pName && d2Clean.startsWith(pName)) {
    d2Clean = d2Clean.slice(pName.length).trim();
  }

  const combinedDesc = `${d1Clean}, ובנוסף ${d2Clean}!`;

  return {
    id: `unified_${primary.id}_${secondary.id}`,
    playerId: pId,
    icon,
    type: primary.type,
    title,
    playerName: pName,
    badge,
    description: combinedDesc,
  };
}

/**
 * Detects milestone achievements, historic records broken, and notable highlights
 * that specifically took place during this period vs all prior games or within the period.
 */
function detectPeriodRecords(
  periodGames: Game[],
  periodGP: GamePlayer[],
  allGames: Game[],
  allGP: GamePlayer[],
  playerMap: Map<string, Player>,
  periodType: RecapPeriodType,
  year: number,
  month?: number,
  yearGpCounts?: Map<string, number>
): PeriodRecordHighlight[] {
  const records: PeriodRecordHighlight[] = [];
  if (periodGames.length === 0) return records;

  const periodNoun = periodType === 'year' ? 'בעונה' : periodType === 'h1' || periodType === 'h2' ? 'בחציון' : 'בחודש';
  const periodName = periodType === 'year' ? 'העונה' : periodType === 'h1' || periodType === 'h2' ? 'החציון' : 'החודש';

  const periodStartDate = periodGames[0]
    ? getGameDate(periodGames[0])
    : new Date(year, (month || 1) - 1, 1);
  const priorCompletedGames = allGames.filter(g => getGameDate(g).getTime() < periodStartDate.getTime());
  const priorGameIds = new Set(priorCompletedGames.map(g => g.id));
  const priorGPs = allGP.filter(gp => priorGameIds.has(gp.gameId));

  // 1. All-time club records and single-win rankings in this period
  const allHistoricalProfits = allGP
    .map(gp => Number(gp.profit || 0))
    .sort((a, b) => b - a);

  const positiveGPs = [...periodGP]
    .filter(gp => Number(gp.profit || 0) > 0)
    .sort((a, b) => Number(b.profit || 0) - Number(a.profit || 0));

  const seenWinPlayers = new Set<string>();
  for (const gp of positiveGPs) {
    if (seenWinPlayers.has(gp.playerId)) continue;

    const profitVal = Number(gp.profit || 0);
    const playerObj = playerMap.get(gp.playerId);
    const pName = playerObj?.name || gp.playerName || 'שחקן';
    const isGuest = playerObj?.type === 'guest';
    const yearGamesCount = yearGpCounts ? (yearGpCounts.get(gp.playerId) || 0) : 99;
    const isCameo = yearGamesCount <= 1;
    const pPeriodCount = periodGP.filter(x => x.playerId === gp.playerId).length;
    const isFrequentGuest = isGuest && (yearGamesCount >= 3 || pPeriodCount >= 2);
    const gObj = periodGames.find(x => x.id === gp.gameId);
    const dStr = gObj ? formatShortDate(gObj.date || gObj.createdAt) : '';

    const allTimeRank = allHistoricalProfits.filter(val => val > profitVal).length + 1;

    // For 1-game cameos (<= 1 game in the entire year):
    // ONLY include if they achieved a legendary Top 3 all-time single win in club history!
    if (isCameo && allTimeRank > 3) {
      continue;
    }

    seenWinPlayers.add(gp.playerId);

    const pPriorGPs = priorGPs.filter(x => x.playerId === gp.playerId);
    const priorBest = pPriorGPs.reduce((m, x) => Math.max(m, Number(x.profit || 0)), 0);
    const isCareerBest = (!isGuest || isFrequentGuest) && !isCameo && pPriorGPs.length >= 3 && profitVal > priorBest + 15 && priorBest >= 80;

    if (allTimeRank === 1) {
      records.push({
        id: `all_time_rec_${gp.id}`,
        playerId: gp.playerId,
        icon: '👑',
        type: 'group_record',
        title: 'שיא כל הזמנים בערב בודד!',
        playerName: pName,
        badge: 'שיא מועדון היסטורי',
        description: `${pName}${isGuest ? ' (אורח)' : ''} ניפץ את שיא הרווח למשחק בודד בתולדות הקבוצה עם +₪${Math.round(profitVal)} (${dStr})!`,
      });
      break;
    } else if (allTimeRank <= 10) {
      records.push({
        id: `all_time_top10_${gp.id}`,
        playerId: gp.playerId,
        icon: '🌟',
        type: 'all_time_record',
        title: `טופ 10 של כל הזמנים (+₪${Math.round(profitVal)})`,
        playerName: pName,
        badge: `מקום ${allTimeRank} בכל הזמנים`,
        description: `הזכייה של ${pName}${isGuest ? ' (אורח)' : ''} ב-+₪${Math.round(profitVal)} (${dStr}) נכנסה למקום ה-${allTimeRank} בשיאי כל הזמנים של המועדון${isCareerBest ? ' ומהווה שיא קריירה אישי!' : '!'}`,
      });
      break; // At most one all-time single win spotlight per period
    } else if (isCareerBest) {
      records.push({
        id: `career_win_${gp.id}`,
        playerId: gp.playerId,
        icon: '🚀',
        type: 'career_best_win',
        title: 'שיא קריירה בערב יחיד',
        playerName: pName,
        badge: 'שיא אישי חדש',
        description: `${pName} ניפץ את שיא הרווח האישי לערב יחיד בקריירה: +₪${Math.round(profitVal)} (${dStr}), מעל שיאו הקודם (+₪${Math.round(priorBest)})!`,
      });
      break;
    }
  }

  // 2. Career best month
  if (periodType === 'month' && month) {
    for (const [pId, pObj] of playerMap.entries()) {
      const yCnt = yearGpCounts ? (yearGpCounts.get(pId) || 0) : 99;
      const isCameo = yCnt <= 1;
      const pPeriodGPs = periodGP.filter(gp => gp.playerId === pId);
      if (pPeriodGPs.length === 0) continue;
      const isFrequentGuest = pObj.type === 'guest' && (yCnt >= 3 || pPeriodGPs.length >= 2);
      if (isCameo || (pObj.type === 'guest' && !isFrequentGuest)) continue;
      const pName = pObj.name;
      const periodProfit = pPeriodGPs.reduce((s, gp) => s + Number(gp.profit || 0), 0);
      if (periodProfit < 250) continue;

      const pastMonthProfits = new Map<string, number>();
      for (const gp of priorGPs) {
        if (gp.playerId !== pId) continue;
        const gObj = allGames.find(x => x.id === gp.gameId);
        if (!gObj) continue;
        const d = getGameDate(gObj);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        pastMonthProfits.set(key, (pastMonthProfits.get(key) || 0) + Number(gp.profit || 0));
      }

      if (pastMonthProfits.size >= 3) {
        let priorBestMonth = -Infinity;
        for (const val of pastMonthProfits.values()) {
          if (val > priorBestMonth) priorBestMonth = val;
        }
        if (periodProfit > priorBestMonth + 30 && priorBestMonth > 0) {
          records.push({
            id: `career_month_${pId}`,
            playerId: pId,
            icon: '🌟',
            type: 'career_best_month',
            title: 'חודש שיא בכל הזמנים',
            playerName: pName,
            badge: 'חודש שיא אישי',
            description: `${pName} רשם את החודש הרווחי ביותר שלו מאז ומעולם עם +₪${Math.round(periodProfit)} (הקודם: +₪${Math.round(priorBestMonth)})!`,
          });
          break; // At most one career month record
        }
      }
    }
  }

  // 4. Iron Man (100% attendance or top attendance in longer periods)
  if (periodGames.length >= 3) {
    const pCounts = new Map<string, number>();
    periodGP.forEach(gp => {
      pCounts.set(gp.playerId, (pCounts.get(gp.playerId) || 0) + 1);
    });
    const ironNames: string[] = [];
    let maxAttendance = 0;
    for (const [pId, cnt] of pCounts.entries()) {
      if (cnt > maxAttendance) maxAttendance = cnt;
      if (cnt === periodGames.length) {
        const name = playerMap.get(pId)?.name;
        if (name) ironNames.push(name);
      }
    }
    if (ironNames.length > 0 && ironNames.length <= 4) {
      records.push({
        id: 'iron_man',
        icon: '🛡️',
        type: 'iron_man',
        title: 'נוכחות ברזל (100%)',
        badge: 'התייצבות מלאה',
        description: `${ironNames.join(', ')} לא החמיצו אף ערב והתייצבו לכל ${periodGames.length} המשחקים ${periodNoun}!`,
      });
    } else if (periodGames.length >= 8 && maxAttendance >= periodGames.length * 0.75) {
      const topAttendees: string[] = [];
      for (const [pId, cnt] of pCounts.entries()) {
        if (cnt === maxAttendance) {
          const name = playerMap.get(pId)?.name;
          if (name) topAttendees.push(name);
        }
      }
      if (topAttendees.length > 0 && topAttendees.length <= 3) {
        const isSingle = topAttendees.length === 1;
        const verb = isSingle ? 'הוביל' : 'הובילו';
        const title = isSingle ? `שיאן הנוכחות ${periodNoun}` : `שיאני הנוכחות ${periodNoun}`;
        records.push({
          id: 'iron_man_top',
          icon: '🛡️',
          type: 'iron_man',
          title,
          badge: `${maxAttendance}/${periodGames.length} משחקים`,
          description: `${topAttendees.join(' ו-')} ${verb} את הטבלה עם הנוכחות הגבוהה ביותר: ${maxAttendance} מתוך ${periodGames.length} ערבים!`,
        });
      }
    }
  }

  // 4b. Rebuys / Action King record (gives prominent spotlight to action generators like Eyal / Segal)
  let maxRebuysVal = 0;
  let topRebuyPId = '';
  for (const [pId, pObj] of playerMap.entries()) {
    const yCnt = yearGpCounts ? (yearGpCounts.get(pId) || 0) : 99;
    const isCameo = yCnt <= 1;
    const pGps = periodGP.filter(gp => gp.playerId === pId);
    const isFrequentGuest = pObj.type === 'guest' && (yCnt >= 3 || pGps.length >= 2);
    if (isCameo || (pObj.type === 'guest' && !isFrequentGuest)) continue;
    const totalR = pGps.reduce((s, x) => s + Number(x.rebuys || 0), 0);
    if (totalR > maxRebuysVal) {
      maxRebuysVal = totalR;
      topRebuyPId = pId;
    }
  }
  const minActionThreshold = periodType === 'month' ? 12 : 25;
  if (topRebuyPId && maxRebuysVal >= minActionThreshold) {
    const rebuyP = playerMap.get(topRebuyPId);
    const pGps = periodGP.filter(gp => gp.playerId === topRebuyPId);
    const avgR = (maxRebuysVal / (pGps.length || 1)).toFixed(1);
    records.push({
      id: `top_rebuys_${topRebuyPId}`,
      playerId: topRebuyPId,
      icon: '🎰',
      type: 'streak',
      title: 'מלך הריבאי ומחולל האקשן',
      playerName: rebuyP?.name || '',
      badge: `${maxRebuysVal} קניות ${periodNoun}`,
      description: `${rebuyP?.name} הרעיד את השולחן ${periodNoun} עם ${maxRebuysVal} קניות (ממוצע ${avgR} לערב) והזרים ₪${Math.round(maxRebuysVal * 30).toLocaleString('he-IL')} לקופות המשחק!`,
    });
  }

  // 5. Streaks in period (COMBINED - at most one record, prevents repetitive streak cards!)
  const streakList: { pId: string; pName: string; streak: number }[] = [];
  for (const [pId, pObj] of playerMap.entries()) {
    const yCnt = yearGpCounts ? (yearGpCounts.get(pId) || 0) : 99;
    const isCameo = yCnt <= 1;
    const pGps = periodGP.filter(gp => gp.playerId === pId);
    const isFrequentGuest = pObj.type === 'guest' && (yCnt >= 3 || pGps.length >= 2);
    if (isCameo || (pObj.type === 'guest' && !isFrequentGuest)) continue;
    const pName = pObj.name;
    let streak = 0;
    let maxStreak = 0;
    for (const g of periodGames) {
      const gp = periodGP.find(x => x.gameId === g.id && x.playerId === pId);
      if (!gp) continue;
      if (Number(gp.profit || 0) > 0) {
        streak++;
        if (streak > maxStreak) maxStreak = streak;
      } else {
        streak = 0;
      }
    }
    const minStreakThreshold = periodType === 'month' ? 3 : 4;
    if (maxStreak >= minStreakThreshold) {
      streakList.push({ pId, pName, streak: maxStreak });
    }
  }

  streakList.sort((a, b) => b.streak - a.streak);

  const perfectAccuracyHandledPIds = new Set<string>();

  if (streakList.length > 0) {
    const topStreakVal = streakList[0].streak;
    const topTied = streakList.filter(s => s.streak === topStreakVal);
    const runnersUp = streakList.filter(s => s.streak < topStreakVal && s.streak >= 3).slice(0, 2);

    let desc = '';
    let title = `רצף הניצחונות של ${periodName}`;
    let badge = `${topStreakVal} ניצחונות ברצף`;

    if (topTied.length === 1) {
      const topP = topTied[0];
      const topPGps = periodGP.filter(gp => gp.playerId === topP.pId);
      const isPerfect = topPGps.length === topStreakVal && topPGps.length >= 3;
      if (isPerfect) {
        perfectAccuracyHandledPIds.add(topP.pId);
        title = `מאזן מושלם ורצף ניצחונות`;
        badge = `100% הצלחה (רצף ${topStreakVal})`;
      }
      const runnersUpStr = runnersUp.length > 0
        ? ` (ואחריו ${runnersUp.map(r => `${r.pName} עם ${r.streak}`).join(' ו-')})`
        : '';
      desc = isPerfect
        ? `${topP.pName} נעל את ${periodName} במאזן מושלם של 100% הצלחה עם ${topStreakVal} ניצחונות מתוך ${topStreakVal} ערבים${runnersUpStr}!`
        : `${topP.pName} רשם את רצף הניצחונות הארוך ביותר ${periodNoun} עם ${topStreakVal} ניצחונות רצופים${runnersUpStr}!`;
    } else {
      const names = topTied.map(t => t.pName).join(' ו-');
      desc = `${names} הובילו את ${periodName} עם רצף פנטסטי של ${topStreakVal} ניצחונות רצופים כל אחד!`;
    }

    records.push({
      id: 'period_top_win_streak',
      playerId: topTied.length === 1 ? topTied[0].pId : undefined,
      icon: '🔥',
      type: 'streak',
      title,
      playerName: topTied.map(t => t.pName).join(', '),
      badge,
      description: desc,
    });
  }

  // 6. The Big Comeback
  for (const [pId, pObj] of playerMap.entries()) {
    const yCnt = yearGpCounts ? (yearGpCounts.get(pId) || 0) : 99;
    const isCameo = yCnt <= 1;
    const pGpsAll = periodGP.filter(gp => gp.playerId === pId);
    const isFrequentGuest = pObj.type === 'guest' && (yCnt >= 3 || pGpsAll.length >= 2);
    if (isCameo || (pObj.type === 'guest' && !isFrequentGuest)) continue;
    const pName = pObj.name;
    const pGps = periodGames
      .map(g => periodGP.find(x => x.gameId === g.id && x.playerId === pId))
      .filter((x): x is GamePlayer => Boolean(x));
    if (pGps.length >= 3) {
      const halfCount = Math.floor(pGps.length / 2);
      const firstHalfProfit = pGps.slice(0, halfCount).reduce((s, x) => s + Number(x.profit || 0), 0);
      const totalProfit = pGps.reduce((s, x) => s + Number(x.profit || 0), 0);
      if (firstHalfProfit <= -120 && totalProfit >= 80) {
        records.push({
          id: `comeback_${pId}`,
          playerId: pId,
          icon: '🔄',
          type: 'big_comeback',
          title: `קאמבק ${periodName}`,
          playerName: pName,
          badge: 'מהפך מפיגור',
          description: `${pName} התאושש מבור של ₪${Math.abs(Math.round(firstHalfProfit))} בחצי הראשון, ועשה מהפך ענק לסיום ברווח נקי של +₪${Math.round(totalProfit)}!`,
        });
        break; // at most one comeback record
      }
    }
  }

  // 7. Perfect accuracy (100% win rate with >= 3 games) — skipped if already combined in streak!
  for (const [pId, pObj] of playerMap.entries()) {
    const yCnt = yearGpCounts ? (yearGpCounts.get(pId) || 0) : 99;
    const isCameo = yCnt <= 1;
    const pGps = periodGP.filter(gp => gp.playerId === pId);
    const isFrequentGuest = pObj.type === 'guest' && (yCnt >= 3 || pGps.length >= 2);
    if (isCameo || (pObj.type === 'guest' && !isFrequentGuest) || perfectAccuracyHandledPIds.has(pId)) continue;
    const pName = pObj.name;
    if (pGps.length >= 3) {
      const wins = pGps.filter(gp => Number(gp.profit || 0) > 0).length;
      if (wins === pGps.length) {
        records.push({
          id: `perfect_acc_${pId}`,
          playerId: pId,
          icon: '🎯',
          type: 'streak',
          title: 'דיוק מושלם (100% הצלחה)',
          playerName: pName,
          badge: `${wins}/${wins} ניצחונות`,
          description: `${pName} סיים את התקופה במאזן מושלם של 100% הצלחה עם ${wins} ניצחונות מתוך ${wins} ערבים!`,
        });
        break;
      }
    }
  }

  // 8. Rollercoaster / Extreme Volatility in period (for players not yet featured)
  for (const [pId, pObj] of playerMap.entries()) {
    const yCnt = yearGpCounts ? (yearGpCounts.get(pId) || 0) : 99;
    const isCameo = yCnt <= 1;
    const pGps = periodGP.filter(gp => gp.playerId === pId);
    const isFrequentGuest = pObj.type === 'guest' && (yCnt >= 3 || pGps.length >= 2);
    if (isCameo || (pObj.type === 'guest' && !isFrequentGuest)) continue;
    const pName = pObj.name;
    if (pGps.length >= 3) {
      const maxWin = pGps.reduce((m, x) => Math.max(m, Number(x.profit || 0)), 0);
      const maxLoss = pGps.reduce((m, x) => Math.min(m, Number(x.profit || 0)), 0);
      if (maxWin >= 180 && maxLoss <= -120) {
        records.push({
          id: `rollercoaster_${pId}`,
          playerId: pId,
          icon: '🎢',
          type: 'streak',
          title: `רכבת הרים ${periodNoun}`,
          playerName: pName,
          badge: 'פער קיצוני',
          description: `${pName} חווה את המסע הכי סוער: מניצחון שיא של +₪${Math.round(maxWin)} ועד הפסד של -₪${Math.abs(Math.round(maxLoss))}!`,
        });
        break;
      }
    }
  }

  // 9. Turbulent / Peak Action Game
  let topAction: { g: Game; players: number; totalRebuys: number } | null = null;
  for (const g of periodGames) {
    const gGps = periodGP.filter(x => x.gameId === g.id);
    const totalRebuys = gGps.reduce((s, x) => s + Number(x.rebuys || 0), 0);
    if (!topAction || totalRebuys > topAction.totalRebuys) {
      topAction = { g, players: gGps.length, totalRebuys };
    }
  }
  if (topAction && topAction.totalRebuys >= 8) {
    const dStr = formatShortDate(topAction.g.date || topAction.g.createdAt);
    const loc = topAction.g.location ? ` (אצל ${topAction.g.location})` : '';
    records.push({
      id: 'turbulent_game',
      icon: '⚡',
      type: 'turbulent_game',
      title: `ערב האקשן של ${periodName}`,
      badge: `${Math.round(topAction.totalRebuys * 10) / 10} קניות`,
      description: `ב-${dStr}${loc} נרשם האקשן הגבוה ביותר: ${Math.round(topAction.totalRebuys * 10) / 10} קניות ו-${topAction.players} שחקנים סביב השולחן!`,
    });
  }

  // Consolidation / Unification:
  // If any player achieved 2 (or more) significant records, unify them into a single compound card
  // so neither milestone is lost, while avoiding duplicate cards for the same player.
  const playerRecordsMap = new Map<string, PeriodRecordHighlight[]>();
  const nonPlayerRecords: PeriodRecordHighlight[] = [];

  for (const r of records) {
    const pKey = r.playerId || (r.playerName && !r.playerName.includes(',') && !r.playerName.includes(' ו-') ? r.playerName : null);
    if (!pKey || r.type === 'turbulent_game' || (r.type === 'iron_man' && r.description.includes(','))) {
      nonPlayerRecords.push(r);
    } else {
      const list = playerRecordsMap.get(pKey) || [];
      list.push(r);
      playerRecordsMap.set(pKey, list);
    }
  }

  const consolidated: PeriodRecordHighlight[] = [];
  for (const [, pRecs] of playerRecordsMap.entries()) {
    // If a player has substantive positive milestones, filter out pure volatility (rollercoaster)
    const substantive = pRecs.filter(r => !r.id.startsWith('rollercoaster') && r.type !== 'rollercoaster');
    const validRecs = substantive.length > 0 ? substantive : pRecs;

    if (validRecs.length === 1) {
      consolidated.push(validRecs[0]);
    } else {
      consolidated.push(combinePlayerRecords(validRecs[0], validRecs[1]));
    }
  }
  consolidated.push(...nonPlayerRecords);

  // Score records for priority display in top 5
  function getRecordWeight(r: PeriodRecordHighlight): number {
    if (r.id.startsWith('unified_') || (r.badge && r.badge.includes('דאבל'))) return 100;
    if (r.id.startsWith('all_time_rec')) return 95;
    if (r.id.startsWith('all_time_top10') || r.type === 'career_best_month') return 85;
    if (r.type === 'career_best_win') return 80;
    if (r.id.includes('win_streak') || r.id.startsWith('perfect_acc')) return 75;
    if (r.id.startsWith('top_rebuys')) return 70;
    if (r.id.startsWith('iron_man')) return 65;
    if (r.type === 'big_comeback') return 60;
    if (r.type === 'turbulent_game') return 55;
    return 50;
  }

  consolidated.sort((a, b) => getRecordWeight(b) - getRecordWeight(a));
  return consolidated.slice(0, 5);
}

/**
 * Detects key stories and macro standings movements (Yearly, Half-year, All-Time)
 * triggered by this period's results (replaces the awards grid with narrative stories).
 */
function detectPeriodStories(
  periodGames: Game[],
  periodGP: GamePlayer[],
  allGames: Game[],
  allGP: GamePlayer[],
  playerMap: Map<string, Player>,
  allRanked: RecapPlayerEntry[],
  champ: RecapPlayerEntry | undefined,
  periodType: RecapPeriodType,
  year: number,
  month?: number,
  soloRecordPlayerIds?: Set<string>,
  yearGpCounts?: Map<string, number>
): PeriodStory[] {
  const stories: PeriodStory[] = [];
  if (periodGames.length === 0) return stories;

  // Prioritize players who haven't starred in Card 2 (Records),
  // ensuring the entire circle of active players is represented!
  const usedPlayerIds = new Set<string>();
  if (soloRecordPlayerIds) {
    soloRecordPlayerIds.forEach(id => usedPlayerIds.add(id));
  }

  // Primary factor: appearances (games played). Secondary factor: player type (regular vs guest).
  // 1-game cameo players (<= 1 game in the entire year) and infrequent guests are excluded.
  // Guests who attended many games (>= 3 in year or >= 2 in period) CAN be included in stories!
  for (const [pId, pObj] of playerMap.entries()) {
    const yCnt = yearGpCounts ? (yearGpCounts.get(pId) || 0) : 0;
    const pPeriodGps = periodGP.filter(gp => gp.playerId === pId);
    const isCameo = yCnt <= 1;
    const isGuest = pObj.type === 'guest';
    const isFrequentGuest = isGuest && (yCnt >= 3 || pPeriodGps.length >= 2);
    if (isCameo || (isGuest && !isFrequentGuest)) {
      usedPlayerIds.add(pId);
    }
  }

  const periodNoun = periodType === 'year' ? 'בעונה' : periodType === 'h1' || periodType === 'h2' ? 'בחציון' : 'בחודש';

  const periodStartDate = periodGames[0]
    ? getGameDate(periodGames[0])
    : new Date(year, (month || 1) - 1, 1);
  const periodEndDate = periodGames[periodGames.length - 1]
    ? getGameDate(periodGames[periodGames.length - 1])
    : new Date(year, (month || 12), 0, 23, 59, 59);

  function getRankMap(gamesSubset: Game[]): Map<string, { rank: number; profit: number }> {
    const ids = new Set(gamesSubset.map(g => g.id));
    const subGps = allGP.filter(gp => ids.has(gp.gameId));
    const totals = new Map<string, number>();
    for (const gp of subGps) {
      totals.set(gp.playerId, (totals.get(gp.playerId) || 0) + Number(gp.profit || 0));
    }
    const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    const map = new Map<string, { rank: number; profit: number }>();
    sorted.forEach(([pId, profit], idx) => {
      map.set(pId, { rank: idx + 1, profit });
    });
    return map;
  }

  // 1. All-Time Shifts & Milestones
  const gamesAllBefore = allGames.filter(g => getGameDate(g).getTime() < periodStartDate.getTime());
  const gamesAllThrough = allGames.filter(g => getGameDate(g).getTime() <= periodEndDate.getTime());
  const allBefore = getRankMap(gamesAllBefore);
  const allThrough = getRankMap(gamesAllThrough);

  // 2. Yearly Season Shifts (עונת year)
  const gamesYearBefore = allGames.filter(g => getGameDate(g).getFullYear() === year && getGameDate(g).getTime() < periodStartDate.getTime());
  const gamesYearThrough = allGames.filter(g => getGameDate(g).getFullYear() === year && getGameDate(g).getTime() <= periodEndDate.getTime());
  const yBefore = getRankMap(gamesYearBefore);
  const yThrough = getRankMap(gamesYearThrough);

  const priorYearGPs = allGP.filter(gp => {
    const g = allGames.find(x => x.id === gp.gameId);
    if (!g) return false;
    const d = getGameDate(g);
    return d.getFullYear() === year && d.getTime() < periodStartDate.getTime();
  });

  // Story 1: Chaser Overtake or Gap Closing / Defense in the top ranks (if prior games exist in season)
  if (gamesYearBefore.length > 0) {
    const priorTotalsSorted = [...yBefore.entries()].sort((a, b) => b[1].profit - a[1].profit);
    for (let rank = 1; rank <= 4; rank++) {
      const leaderBefore = priorTotalsSorted[rank - 1];
      const chaserBefore = priorTotalsSorted[rank];
      if (!leaderBefore || !chaserBefore) continue;

      const gapBefore = leaderBefore[1].profit - chaserBefore[1].profit;
      const leaderAfterProfit = yThrough.get(leaderBefore[0])?.profit || 0;
      const chaserAfterProfit = yThrough.get(chaserBefore[0])?.profit || 0;
      const chaserName = playerMap.get(chaserBefore[0])?.name || 'רודף';
      const leaderName = playerMap.get(leaderBefore[0])?.name || 'מוביל';

      // Check if chaser OVERTOOK leader
      if (chaserAfterProfit > leaderAfterProfit && gapBefore > 0) {
        if (!usedPlayerIds.has(chaserBefore[0])) {
          const newLead = Math.round(chaserAfterProfit - leaderAfterProfit);
          const chaserNowRank = yThrough.get(chaserBefore[0])?.rank || rank;
          const isTopSpot = chaserNowRank === 1;
          const title = isTopSpot
            ? `מהפך בפסגת עונת ${year}: ${chaserName}`
            : chaserNowRank === 2
            ? `כיבוש הסגנות בעונת ${year}: ${chaserName}`
            : chaserNowRank === 3
            ? `פריצה לפודיום עונת ${year}: ${chaserName}`
            : `טיפוס למקום ה-${chaserNowRank} בעונת ${year}: ${chaserName}`;
          const badge = isTopSpot ? `מקום 1 בעונה` : `מקום ${chaserNowRank} בעונה`;
          const desc = isTopSpot
            ? `${chaserName} משלים מהפך עונתי ענק: עוקף את ${leaderName} וכובש את הפסגה והמקום ה-1 בעונת ${year} עם יתרון של ₪${newLead.toLocaleString('he-IL')}!`
            : `${chaserName} משלים מהפך מרשים: עוקף את ${leaderName} ועולה למקום ה-${chaserNowRank} בעונת ${year} עם יתרון של ₪${newLead.toLocaleString('he-IL')}!`;
          stories.push({
            id: `overtake_${chaserBefore[0]}`,
            icon: isTopSpot ? '👑' : '🚀',
            type: 'top_takeover',
            title,
            badge,
            badgeVariant: 'green',
            playerName: chaserName,
            description: desc,
          });
          usedPlayerIds.add(chaserBefore[0]);
          break;
        }
      }

      // Check if chaser significantly narrowed gap (gapAfter > 0)
      const gapAfter = leaderAfterProfit - chaserAfterProfit;
      const closed = gapBefore - gapAfter;
      if (closed >= 250 && gapAfter > 0) {
        const targetRank = rank;
        const rankLabel = targetRank === 1
          ? 'הפסגה והמקום ה-1'
          : targetRank === 2
          ? 'המקום ה-2 והסגנות'
          : targetRank === 3
          ? 'המקום ה-3 והפודיום'
          : `המקום ה-${targetRank}`;

        if (!usedPlayerIds.has(chaserBefore[0])) {
          stories.push({
            id: `gap_closed_${chaserBefore[0]}`,
            icon: '⚔️',
            type: 'top_takeover',
            title: `סגירת פערים בצמרת: ${chaserName}`,
            badge: `סגירת ₪${Math.round(closed)}`,
            badgeVariant: 'amber',
            playerName: chaserName,
            description: `${chaserName} סגר פער של ₪${Math.round(closed)} מול ${leaderName} במירוץ על ${rankLabel}, וצימצם את הפער ביניהם ל-₪${Math.round(gapAfter)} בלבד!`,
          });
          usedPlayerIds.add(chaserBefore[0]);
          break;
        } else if (!usedPlayerIds.has(leaderBefore[0])) {
          // If chaser was already featured (e.g. Oren in records), feature the LEADER defending their spot!
          const leaderNowRank = yThrough.get(leaderBefore[0])?.rank || targetRank;
          const isFirstPlace = leaderNowRank === 1;
          const title = isFirstPlace
            ? `קרב ההגנה על הפסגה: ${leaderName}`
            : leaderNowRank === 2
            ? `הקרב על הסגנות בצמרת: ${leaderName}`
            : leaderNowRank === 3
            ? `הקרב על הפודיום: ${leaderName}`
            : `הקרב על המקום ה-${leaderNowRank}: ${leaderName}`;
          const badge = isFirstPlace ? `שומר על הפסגה` : `שומר על מקום ${leaderNowRank}`;
          const desc = isFirstPlace
            ? `${leaderName} מגן בנחישות על הפסגה והמקום ה-1 בצמרת עונת ${year} מול המרדף הסוער של ${chaserName}, ומחזיק בפער של ₪${Math.round(gapAfter)}!`
            : `${leaderName} מגן בנחישות על המקום ה-${leaderNowRank} בצמרת עונת ${year} מול המרדף הסוער של ${chaserName}, ומחזיק בפער של ₪${Math.round(gapAfter)}!`;

          stories.push({
            id: `title_defense_${leaderBefore[0]}`,
            icon: '🛡️',
            type: 'top_takeover',
            title,
            badge,
            badgeVariant: 'amber',
            playerName: leaderName,
            description: desc,
          });
          usedPlayerIds.add(leaderBefore[0]);
          break;
        }
      }
    }
  }

  // Story 2: Slump Breaker / Positive Momentum Reversal (was in deep deficit, now strongly green)
  for (const p of allRanked) {
    if (usedPlayerIds.has(p.playerId) || p.gamesPlayed < 2) continue;
    const pPriorGps = priorYearGPs.filter(gp => gp.playerId === p.playerId);
    const priorProfit = pPriorGps.reduce((s, x) => s + Number(x.profit || 0), 0);
    if (priorProfit <= -250 && p.profit >= 100 && p.winRate >= 50) {
      stories.push({
        id: `slump_breaker_${p.playerId}`,
        icon: '🔄',
        type: 'rank_surge',
        title: `שבירת בצורת ותפנית חדה: ${p.playerName}`,
        badge: 'תפנית חיובית',
        badgeVariant: 'green',
        playerName: p.playerName,
        description: `${p.playerName} שובר רצף עונתי קשה: אחרי שהיה בפיגור של -₪${Math.abs(Math.round(priorProfit))}, הוא רושם ${periodNoun} פנטסטי עם רווח נקי של +₪${Math.round(p.profit)} ו-${p.winRate}% הצלחה!`,
      });
      usedPlayerIds.add(p.playerId);
      break;
    }
  }

  // Story 2b: Action Engine & Attendance (e.g. Segal / Eyal with high attendance & rebuys)
  for (const p of allRanked) {
    if (usedPlayerIds.has(p.playerId)) continue;
    if (p.gamesPlayed >= Math.max(3, periodGames.length - 1) && p.totalRebuys >= 6) {
      stories.push({
        id: `action_anchor_${p.playerId}`,
        icon: '🔥',
        type: 'rank_surge',
        title: `מנוע האקשן וההתמדה: ${p.playerName}`,
        badge: `${p.gamesPlayed}/${periodGames.length} משחקים`,
        badgeVariant: 'amber',
        playerName: p.playerName,
        description: `${p.playerName} הראה מחויבות ברזל עם ${p.gamesPlayed} התייצבויות מתוך ${periodGames.length} ערבים ${periodNoun}, דחף ${p.totalRebuys} קניות לקופה והיווה את הלב הפועם של האקשן סביב השולחן!`,
      });
      usedPlayerIds.add(p.playerId);
      break;
    }
  }

  // Story 2c: Season Top Tier Pillar (e.g. Eyal or Lichter anchoring top tier in season)
  for (const p of allRanked) {
    if (usedPlayerIds.has(p.playerId)) continue;
    const t = yThrough.get(p.playerId);
    if (t && t.rank <= 6 && t.profit > 0) {
      stories.push({
        id: `season_pillar_${p.playerId}`,
        icon: '⚓',
        type: 'rank_surge',
        title: `עוגן בצמרת עונת ${year}: ${p.playerName}`,
        badge: `מקום ${t.rank} בעונה`,
        badgeVariant: 'blue',
        playerName: p.playerName,
        description: `${p.playerName} מבצר את מעמדו בצמרת עונת ${year} (מקום ${t.rank} עם רווח מצטבר של +₪${Math.round(t.profit)}) וממשיך להוות עמוד תווך סביב השולחן!`,
      });
      usedPlayerIds.add(p.playerId);
      break;
    }
  }

  // Story 2d: High Tempo & Aggression Catalyst (e.g. Lichter or Eyal driving high action / rebuys)
  for (const p of allRanked) {
    if (usedPlayerIds.has(p.playerId)) continue;
    const avgRebuys = p.totalRebuys / (p.gamesPlayed || 1);
    if (avgRebuys >= 3.8 && p.totalRebuys >= 8 && p.gamesPlayed >= 2) {
      stories.push({
        id: `high_tempo_${p.playerId}`,
        icon: '⚡',
        type: 'rank_surge',
        title: `קצב משחק ואקשן גבוה: ${p.playerName}`,
        badge: `${avgRebuys.toFixed(1)} קניות לערב`,
        badgeVariant: 'amber',
        playerName: p.playerName,
        description: `${p.playerName} הזרים אנרגיה וקצב גבוה לקופות עם ${p.totalRebuys} קניות ב-${p.gamesPlayed} ערבים ${periodNoun} (ממוצע חריג של ${avgRebuys.toFixed(1)} לערב), ודחף את השולחן לרמות מתח גבוהות!`,
      });
      usedPlayerIds.add(p.playerId);
      break;
    }
  }

  // Story 3: Check climbers in current year or all-time (player not yet used)
  const yearlyClimbers: { p: RecapPlayerEntry; delta: number; bRank: number; tRank: number }[] = [];
  for (const p of allRanked) {
    if (usedPlayerIds.has(p.playerId)) continue;
    const b = yBefore.get(p.playerId);
    const t = yThrough.get(p.playerId);
    if (!b || !t) continue;
    const delta = b.rank - t.rank;
    if (delta >= 2) {
      yearlyClimbers.push({ p, delta, bRank: b.rank, tRank: t.rank });
    }
  }
  yearlyClimbers.sort((a, b) => b.delta - a.delta);

  if (yearlyClimbers.length > 0) {
    const topC = yearlyClimbers[0];
    const isBigJump = topC.delta >= 4;
    stories.push({
      id: `yearly_climber_${topC.p.playerId}`,
      icon: isBigJump ? '🚀' : '📈',
      type: 'rank_surge',
      title: isBigJump ? `זינוק בדירוג עונת ${year}: ${topC.p.playerName}` : `התקדמות בדירוג עונת ${year}: ${topC.p.playerName}`,
      badge: isBigJump ? `זינוק של ${topC.delta} מקומות` : `עלייה של ${topC.delta} שלבים`,
      badgeVariant: 'green',
      playerName: topC.p.playerName,
      description: isBigJump
        ? `${topC.p.playerName} רושם זינוק ענק ומטפס ${topC.delta} שלבים בטבלת עונת ${year} ממקום ${topC.bRank} למקום ה-${topC.tRank}!`
        : `${topC.p.playerName} מתקדם ${topC.delta} שלבים בטבלת עונת ${year} ומטפס ממקום ${topC.bRank} למקום ה-${topC.tRank}!`,
    });
    usedPlayerIds.add(topC.p.playerId);
  } else {
    // Fallback to all-time rank jumps
    const allTimeJumps: { p: RecapPlayerEntry; delta: number; bRank: number; tRank: number; tProfit: number }[] = [];
    for (const p of allRanked) {
      if (usedPlayerIds.has(p.playerId)) continue;
      const b = allBefore.get(p.playerId);
      const t = allThrough.get(p.playerId);
      if (!b || !t) continue;
      const delta = b.rank - t.rank;
      if (delta >= 3) {
        allTimeJumps.push({ p, delta, bRank: b.rank, tRank: t.rank, tProfit: t.profit });
      }
    }
    allTimeJumps.sort((a, b) => b.delta - a.delta);
    if (allTimeJumps.length > 0) {
      const topJump = allTimeJumps[0];
      stories.push({
        id: `all_time_jump_${topJump.p.playerId}`,
        icon: '⚡',
        type: 'all_time_shift',
        title: `זינוק היסטורי בכל הזמנים: ${topJump.p.playerName}`,
        badge: `עלייה של ${topJump.delta} מקומות`,
        badgeVariant: 'purple',
        playerName: topJump.p.playerName,
        description: `${topJump.p.playerName} רושם את הזינוק הגדול של התקופה בכל הזמנים: מטפס ${topJump.delta} שלבים (ממקום ${topJump.bRank} למקום ${topJump.tRank}) ועובר לרווח מצטבר של +₪${Math.round(topJump.tProfit).toLocaleString('he-IL')}!`,
      });
      usedPlayerIds.add(topJump.p.playerId);
    }
  }

  // Story 3b: Drops in season standings
  const yearlyDrops: { p: RecapPlayerEntry; delta: number; bRank: number; tRank: number }[] = [];
  for (const p of allRanked) {
    if (usedPlayerIds.has(p.playerId)) continue;
    const b = yBefore.get(p.playerId);
    const t = yThrough.get(p.playerId);
    if (!b || !t) continue;
    const delta = t.rank - b.rank;
    if (delta >= 2 && p.profit < 0) {
      yearlyDrops.push({ p, delta, bRank: b.rank, tRank: t.rank });
    }
  }
  yearlyDrops.sort((a, b) => b.delta - a.delta);
  if (yearlyDrops.length > 0) {
    const topDrop = yearlyDrops[0];
    stories.push({
      id: `yearly_drop_${topDrop.p.playerId}`,
      icon: '📉',
      type: 'rank_fall',
      title: `נסיגה בדירוג עונת ${year}: ${topDrop.p.playerName}`,
      badge: `ירידה של ${topDrop.delta} שלבים`,
      badgeVariant: 'red',
      playerName: topDrop.p.playerName,
      description: `${topDrop.p.playerName} נסוג ${topDrop.delta} שלבים בטבלת עונת ${year} ממקום ${topDrop.bRank} למקום ה-${topDrop.tRank} בעקבות תקופה של ${topDrop.p.profit}₪.`,
    });
    usedPlayerIds.add(topDrop.p.playerId);
  }

  // Story 4: The Sniper / High Precision Master (focusing on an active regular not yet used)
  const precisionCandidates = [...allRanked]
    .filter(p => !usedPlayerIds.has(p.playerId) && p.winRate >= 50 && p.gamesPlayed >= 3 && p.profit > 0)
    .sort((a, b) => b.winRate - a.winRate || b.profit - a.profit);

  if (precisionCandidates.length > 0) {
    const precP = precisionCandidates[0];
    stories.push({
      id: `precision_${precP.playerId}`,
      icon: '🎯',
      type: 'rank_surge',
      title: `דיוק יוצא דופן ויציבות: ${precP.playerName}`,
      badge: `${precP.winRate}% הצלחה`,
      badgeVariant: 'blue',
      playerName: precP.playerName,
      description: `${precP.playerName} הפגין יציבות מרשימה ${periodNoun} עם ${precP.wins} ניצחונות מתוך ${precP.gamesPlayed} ערבים (${precP.winRate}% הצלחה) ורווח נקי של +₪${precP.profit}!`,
    });
    usedPlayerIds.add(precP.playerId);
  }

  // Story 5: Absent regular (established player with >= 3 games this year or >= 10 all-time who played 0 games this period)
  if (periodGames.length >= 3) {
    for (const [pId, pObj] of playerMap.entries()) {
      if (pObj.type === 'guest' || usedPlayerIds.has(pId)) continue;
      const allPriorGamesCount = allGP.filter(gp => gp.playerId === pId).length;
      const priorYearCount = priorYearGPs.filter(gp => gp.playerId === pId).length;
      // Core regular must have genuine volume (>= 5 games this year or >= 15 all-time)
      if (priorYearCount < 5 && allPriorGamesCount < 15) continue;

      const inPeriodGps = periodGP.filter(gp => gp.playerId === pId);
      if (inPeriodGps.length === 0) {
        stories.push({
          id: `absent_${pId}`,
          icon: '🏖️',
          type: 'rank_fall',
          title: `פגרה מהשולחן: ${pObj.name}`,
          badge: `0 משחקים ${periodNoun}`,
          badgeVariant: 'amber',
          playerName: pObj.name,
          description: `${pObj.name} לקח פגרה ${periodNoun} ולא התייצב לאף אחד מ-${periodGames.length} הערבים שהתקיימו. חסרונו הורגש באקשן סביב השולחן!`,
        });
        usedPlayerIds.add(pId);
        break; // at most one absent regular story
      }
    }
  }

  // Story 6: Tough Period at the Table (authentic down-period description)
  const roughCandidates = [...allRanked]
    .filter(p => !usedPlayerIds.has(p.playerId) && p.profit <= -200 && p.gamesPlayed >= 2)
    .sort((a, b) => a.profit - b.profit);

  if (roughCandidates.length > 0) {
    const roughP = roughCandidates[0];
    const roughTitleNoun = periodType === 'year' ? 'עונה מאתגרת' : (periodType === 'h1' || periodType === 'h2') ? 'חציון מאתגר' : 'חודש קשוח';
    stories.push({
      id: `rough_volume_${roughP.playerId}`,
      icon: '📉',
      type: 'rank_fall',
      title: `${roughTitleNoun} בשולחן: ${roughP.playerName}`,
      badge: `${roughP.profit}₪ ${periodNoun}`,
      badgeVariant: 'red',
      playerName: roughP.playerName,
      description: `${roughP.playerName} חווה ${periodNoun} תקופה מאתגרת וספג הפסדים מצטברים של -₪${Math.abs(roughP.profit)} ב-${roughP.gamesPlayed} ערבים, אך ממשיך לספק נוכחות ואקשן סביב השולחן.`,
    });
    usedPlayerIds.add(roughP.playerId);
  }

  // Story 7: Action Generator (high rebuys among regular players)
  const actionCandidates = [...allRanked]
    .filter(p => !usedPlayerIds.has(p.playerId) && p.totalRebuys >= 4)
    .sort((a, b) => b.totalRebuys - a.totalRebuys);

  if (actionCandidates.length > 0) {
    const actP = actionCandidates[0];
    stories.push({
      id: `action_gen_${actP.playerId}`,
      icon: '🔥',
      type: 'rank_surge',
      title: `מחולל האקשן: ${actP.playerName}`,
      badge: `${actP.totalRebuys} קניות`,
      badgeVariant: 'amber',
      playerName: actP.playerName,
      description: `${actP.playerName} סיפק מנוע אקשן משמעותי ${periodNoun} עם ${actP.totalRebuys} קניות (ממוצע ${(actP.totalRebuys / actP.gamesPlayed).toFixed(1)} לערב)!`,
    });
    usedPlayerIds.add(actP.playerId);
  }

  // Story 8: Cementing Leader Status / Milestone
  if (champ && !usedPlayerIds.has(champ.playerId) && yThrough.get(champ.playerId)?.rank === 1 && champ.profit >= 300) {
    stories.push({
      id: `leader_cement_${champ.playerId}`,
      icon: '🏰',
      type: 'top_takeover',
      title: `ביצור הפסגה בעונת ${year}: ${champ.playerName}`,
      badge: 'מוביל העונה',
      badgeVariant: 'green',
      playerName: champ.playerName,
      description: `${champ.playerName} מגדיל את הפער בצמרת הדירוג השנתי של ${year} עם תוספת עוצמתית של +₪${champ.profit.toLocaleString('he-IL')} ${periodNoun}!`,
    });
    usedPlayerIds.add(champ.playerId);
  }

  return stories.slice(0, 5);
}

/**
 * Computes full Recap data for a given Month, Half-Year, or Year.
 */
export function computePeriodRecap(
  periodType: RecapPeriodType,
  year: number,
  month?: number,
  preloaded?: { games: Game[]; gamePlayers: GamePlayer[]; players: Player[]; rebuyValue: number }
): PeriodRecapData | null {
  try {
    const allGames = (preloaded?.games || getAllGames()).filter(g => g && g.status === 'completed');
    const allGP = preloaded?.gamePlayers || getAllGamePlayers() || [];
    const allPlayers = preloaded?.players || getAllPlayers() || [];
    const rebuyValue = preloaded?.rebuyValue || getSettings().rebuyValue || 30;

  const playerMap = new Map<string, Player>();
  allPlayers.forEach(p => playerMap.set(p.id, p));

  const periodGames = allGames
    .filter(g => {
      const d = getGameDate(g);
      const y = d.getFullYear();
      const m = d.getMonth() + 1;
      if (y !== year) return false;
      if (periodType === 'month') return m === month;
      if (periodType === 'h1') return m >= 1 && m <= 6;
      if (periodType === 'h2') return m >= 7 && m <= 12;
      return true;
    })
    .sort((a, b) => getGameDate(a).getTime() - getGameDate(b).getTime());

  if (periodGames.length === 0) return null;

  const gameIds = new Set(periodGames.map(g => g.id));
  const gameDateById = new Map<string, string>();
  periodGames.forEach(g => gameDateById.set(g.id, g.date || g.createdAt));

  const periodGP = allGP.filter(gp => gameIds.has(gp.gameId));
  const activeThreshold = Math.max(1, Math.ceil(periodGames.length * 0.33));

  let totalRebuys = 0;
  const potByGame = new Map<string, number>();

  // Group GP by player
  const byPlayer = new Map<string, GamePlayer[]>();
  for (const gp of periodGP) {
    totalRebuys += gp.rebuys || 0;
    potByGame.set(gp.gameId, (potByGame.get(gp.gameId) || 0) + (gp.rebuys || 0) * rebuyValue);
    const list = byPlayer.get(gp.playerId) || [];
    list.push(gp);
    byPlayer.set(gp.playerId, list);
  }

  const totalPot = Math.round(totalRebuys * rebuyValue);
  const avgPotPerGame = Math.round(totalPot / periodGames.length);

  // Biggest game pot
  let biggestGamePot: { pot: number; date: string } | undefined;
  for (const g of periodGames) {
    const pot = Math.round(potByGame.get(g.id) || 0);
    if (!biggestGamePot || pot > biggestGamePot.pot) {
      biggestGamePot = { pot, date: formatShortDate(g.date || g.createdAt) };
    }
  }

  // Top location
  const locCounts = new Map<string, number>();
  for (const g of periodGames) {
    const loc = (g.location || '').trim();
    if (loc) locCounts.set(loc, (locCounts.get(loc) || 0) + 1);
  }
  let topLocation: { name: string; count: number } | undefined;
  for (const [name, count] of locCounts.entries()) {
    if (!topLocation || count > topLocation.count) {
      topLocation = { name, count };
    }
  }

  // Compute yearly and all-time attendance maps upfront
  const yearGameIds = new Set(allGames.filter(g => getGameDate(g).getFullYear() === year).map(g => g.id));
  const yearGpCounts = new Map<string, number>();
  const allTimeGpCounts = new Map<string, number>();
  allGP.forEach(gp => {
    allTimeGpCounts.set(gp.playerId, (allTimeGpCounts.get(gp.playerId) || 0) + 1);
    if (yearGameIds.has(gp.gameId)) {
      yearGpCounts.set(gp.playerId, (yearGpCounts.get(gp.playerId) || 0) + 1);
    }
  });

  const allHistoricalProfits = allGP
    .map(gp => Number(gp.profit || 0))
    .sort((a, b) => b - a);

  // Compute player stats (chronological order for streaks)
  const gameOrderIndex = new Map<string, number>();
  periodGames.forEach((g, idx) => gameOrderIndex.set(g.id, idx));

  const allPlayerEntries: RecapPlayerEntry[] = [];
  let globalBigHit: { playerName: string; profit: number; date: string } | undefined;

  for (const [playerId, gps] of byPlayer.entries()) {
    const pObj = playerMap.get(playerId);
    const playerName = pObj?.name || gps[0]?.playerName || 'שחקן';
    const sortedGps = [...gps].sort(
      (a, b) => (gameOrderIndex.get(a.gameId) || 0) - (gameOrderIndex.get(b.gameId) || 0)
    );

    let profit = 0;
    let wins = 0;
    let pRebuys = 0;
    let bestSingleWin = 0;
    let bestSingleWinDate = '';
    let curStreak = 0;
    let longestWinStreak = 0;

    for (const gp of sortedGps) {
      profit += gp.profit;
      pRebuys += gp.rebuys || 0;
      const gDate = formatShortDate(gameDateById.get(gp.gameId) || '');
      if (gp.profit > 0) {
        wins++;
        curStreak++;
        if (curStreak > longestWinStreak) longestWinStreak = curStreak;
        if (gp.profit > bestSingleWin) {
          bestSingleWin = gp.profit;
          bestSingleWinDate = gDate;
        }

        const yCnt = yearGpCounts.get(playerId) || 0;
        const isGuestOr1Game = pObj?.type === 'guest' || yCnt <= 1;
        const atRank = allHistoricalProfits.filter(v => v > gp.profit).length + 1;
        // 1-game cameo/guest only qualifies for bigHit if it's a top 3 all-time single win in club history
        const allowHit = !isGuestOr1Game || atRank <= 3;
        if (allowHit && (!globalBigHit || gp.profit > globalBigHit.profit)) {
          globalBigHit = { playerName, profit: Math.round(gp.profit), date: gDate };
        }
      } else {
        curStreak = 0;
      }
    }

    const gamesPlayed = sortedGps.length;
    const winRate = gamesPlayed > 0 ? Math.round((wins / gamesPlayed) * 100) : 0;
    const avgProfit = gamesPlayed > 0 ? Math.round(profit / gamesPlayed) : 0;

    allPlayerEntries.push({
      playerId,
      playerName,
      profit: Math.round(profit),
      gamesPlayed,
      wins,
      winRate,
      avgProfit,
      totalRebuys: Math.round(pRebuys * 10) / 10,
      totalInvested: Math.round(pRebuys * rebuyValue),
      bestSingleWin: Math.round(bestSingleWin),
      bestSingleWinDate,
      longestWinStreak,
      rank: 0,
    });
  }

  // Filter active players (meeting 33% attendance threshold)
  const activeEntries = allPlayerEntries
    .filter(e => e.gamesPlayed >= activeThreshold)
    .sort((a, b) => b.profit - a.profit || b.wins - a.wins);

  const nonActiveEntries = allPlayerEntries
    .filter(e => e.gamesPlayed < activeThreshold)
    .sort((a, b) => b.profit - a.profit || b.wins - a.wins);

  // Fallback if somehow no one met threshold
  const rankedList = activeEntries.length > 0
    ? activeEntries
    : [...allPlayerEntries].sort((a, b) => b.profit - a.profit);

  rankedList.forEach((e, idx) => {
    e.rank = idx + 1;
  });

  const podium = rankedList.slice(0, 3);

  // Awards - Enforce that awards belong to regular players with sufficient games (never 1-game cameos)
  const minAwardGames = periodType === 'month' ? Math.max(2, activeThreshold) : Math.max(3, activeThreshold);

  // 1. Sniper (highest win rate among active players with >= minAwardGames; frequent guests eligible)
  const sniperCandidate = [...rankedList]
    .filter(e => {
      const pObj = playerMap.get(e.playerId);
      const yCnt = yearGpCounts.get(e.playerId) || 0;
      const isFrequent = pObj?.type !== 'guest' ? yCnt >= 2 : (yCnt >= 3 || e.gamesPlayed >= 2);
      return e.wins > 0 && e.gamesPlayed >= minAwardGames && isFrequent;
    })
    .sort((a, b) => b.winRate - a.winRate || b.gamesPlayed - a.gamesPlayed || b.profit - a.profit)[0];

  // 2. Hot streak (longest win streak in period across regular/frequent players)
  const streakCandidate = [...allPlayerEntries]
    .filter(e => {
      const pObj = playerMap.get(e.playerId);
      const yCnt = yearGpCounts.get(e.playerId) || 0;
      const isFrequent = pObj?.type !== 'guest' ? yCnt >= 2 : (yCnt >= 3 || e.gamesPlayed >= 2);
      return e.longestWinStreak >= 2 && isFrequent;
    })
    .sort((a, b) => b.longestWinStreak - a.longestWinStreak || b.profit - a.profit)[0];

  // 3. Rebuy King (highest average rebuys per game among active players)
  const eligibleForRebuy = rankedList.filter(e => {
    const pObj = playerMap.get(e.playerId);
    const yCnt = yearGpCounts.get(e.playerId) || 0;
    const isFrequent = pObj?.type !== 'guest' ? yCnt >= 2 : (yCnt >= 3 || e.gamesPlayed >= 2);
    return e.totalRebuys > 0 && e.gamesPlayed >= (periodType === 'month' ? 2 : 3) && isFrequent;
  });
  const atmCandidate = [...eligibleForRebuy].sort((a, b) => {
    const aAvg = a.totalRebuys / a.gamesPlayed;
    const bAvg = b.totalRebuys / b.gamesPlayed;
    return bAvg - aAvg || b.totalRebuys - a.totalRebuys || a.profit - b.profit;
  })[0];
  const atmAvgRebuys = atmCandidate && atmCandidate.gamesPlayed > 0
    ? Math.round((atmCandidate.totalRebuys / atmCandidate.gamesPlayed) * 10) / 10
    : 0;

  // 4. Fourth Award - guarantees a DISTINCT player from the Sniper
  let fourthAward: FourthAward | undefined;
  const distinctStreakCandidate = [...allPlayerEntries]
    .filter(e => {
      const pObj = playerMap.get(e.playerId);
      const yCnt = yearGpCounts.get(e.playerId) || 0;
      const isFrequent = pObj?.type !== 'guest' ? yCnt >= 2 : (yCnt >= 3 || e.gamesPlayed >= 2);
      return e.playerName !== sniperCandidate?.playerName && e.longestWinStreak >= 2 && isFrequent;
    })
    .sort((a, b) => b.longestWinStreak - a.longestWinStreak || b.profit - a.profit)[0];

  if (distinctStreakCandidate) {
    fourthAward = {
      type: 'hotStreak',
      icon: '🔥',
      title: 'הרצף החם',
      playerName: distinctStreakCandidate.playerName,
      subtitle: `${distinctStreakCandidate.longestWinStreak} ניצחונות ברצף`,
      profit: distinctStreakCandidate.profit,
    };
  } else {
    const topAvgCandidate = [...rankedList]
      .filter(e => {
        const pObj = playerMap.get(e.playerId);
        const yCnt = yearGpCounts.get(e.playerId) || 0;
        const isFrequent = pObj?.type !== 'guest' ? yCnt >= 2 : (yCnt >= 3 || e.gamesPlayed >= 2);
        return e.playerName !== sniperCandidate?.playerName && e.avgProfit > 0 && e.gamesPlayed >= minAwardGames && isFrequent;
      })
      .sort((a, b) => b.avgProfit - a.avgProfit)[0];

    if (topAvgCandidate) {
      fourthAward = {
        type: 'topAverage',
        icon: '⚡',
        title: 'מלך היציבות',
        playerName: topAvgCandidate.playerName,
        subtitle: `+₪${topAvgCandidate.avgProfit} ממוצע לערב (${topAvgCandidate.gamesPlayed} מש׳)`,
        profit: topAvgCandidate.profit,
      };
    } else {
      const ironCandidate = [...allPlayerEntries]
        .filter(e => {
          const pObj = playerMap.get(e.playerId);
          const yCnt = yearGpCounts.get(e.playerId) || 0;
          const isFrequent = pObj?.type !== 'guest' ? yCnt >= 2 : (yCnt >= 3 || e.gamesPlayed >= 2);
          return e.playerName !== sniperCandidate?.playerName && isFrequent;
        })
        .sort((a, b) => b.gamesPlayed - a.gamesPlayed || b.profit - a.profit)[0];

      if (ironCandidate) {
        fourthAward = {
          type: 'ironAttendance',
          icon: '🛡️',
          title: 'עוגן ההתייצבות',
          playerName: ironCandidate.playerName,
          subtitle: `${ironCandidate.gamesPlayed} משחקים מלאים בתקופה`,
          profit: ironCandidate.profit,
        };
      }
    }
  }

  // Peak attendance in single game
  let maxPlayersInGame = 0;
  for (const g of periodGames) {
    const cnt = periodGP.filter(gp => gp.gameId === g.id).length;
    if (cnt > maxPlayersInGame) maxPlayersInGame = cnt;
  }

  // Labels
  let shortLabel = `${year}`;
  let title = `סיכום עונת ${year}`;
  if (periodType === 'month' && month) {
    const mName = HEBREW_MONTHS[month - 1] || '';
    shortLabel = `${mName} ${year}`;
    title = `סיכום חודש ${mName} ${year}`;
  } else if (periodType === 'h1') {
    shortLabel = `חציון א׳ ${year}`;
    title = `סיכום חציון א׳ ${year}`;
  } else if (periodType === 'h2') {
    shortLabel = `חציון ב׳ ${year}`;
    title = `סיכום חציון ב׳ ${year}`;
  }

  // Deterministic highlights (always accurate, instant fallback or companion to AI)
  const highlights: string[] = [];
  if (podium[0]) {
    const champ = podium[0];
    const diff = podium[1] ? champ.profit - podium[1].profit : 0;
    if (podium[1] && diff <= 100) {
      highlights.push(`קרב צמוד בפסגה: ${champ.playerName} קטף את המקום הראשון בפער של ₪${diff} בלבד מ-${podium[1].playerName}!`);
    } else {
      highlights.push(`דומיננטיות בפסגה: ${champ.playerName} סיים במקום הראשון עם רווח נקי של ₪${champ.profit.toLocaleString('he-IL')} ב-${champ.gamesPlayed} משחקים.`);
    }
  }
  if (sniperCandidate && sniperCandidate.winRate >= 60) {
    highlights.push(`אחוזי פגיעה קטלניים: ${sniperCandidate.playerName} רשם ${sniperCandidate.winRate}% הצלחה (${sniperCandidate.wins} ניצחונות מתוך ${sniperCandidate.gamesPlayed} ערבים).`);
  }
  if (globalBigHit && globalBigHit.profit > 0) {
    highlights.push(`הניצחון הגדול של התקופה: ${globalBigHit.playerName} התפוצץ עם +₪${globalBigHit.profit.toLocaleString('he-IL')} בערב אחד (${globalBigHit.date}).`);
  }
  if (atmCandidate) {
    if (atmCandidate.profit > 0) {
      highlights.push(`מלך הריבאי שלא מוותר: ${atmCandidate.playerName} רשם ממוצע של ${atmAvgRebuys} קניות למשחק (סה״כ ${atmCandidate.totalRebuys} ב-${atmCandidate.gamesPlayed} מש׳) והצליח לסיים ברווח נקי של +₪${atmCandidate.profit.toLocaleString('he-IL')}!`);
    } else {
      highlights.push(`מלך הריבאי והאקשן: ${atmCandidate.playerName} הזרים לקופה ממוצע של ${atmAvgRebuys} קניות למשחק (סה״כ ${atmCandidate.totalRebuys} ב-${atmCandidate.gamesPlayed} מש׳, ₪${atmCandidate.totalInvested.toLocaleString('he-IL')}) שהקפיצו את האקשן בשולחן.`);
    }
  }

  const avgPlayersPerGame = periodGames.length > 0
    ? Math.round((periodGP.length / periodGames.length) * 10) / 10
    : 0;
  const profitablePlayersCount = allPlayerEntries.filter(e => e.profit > 0).length;

  const records = detectPeriodRecords(
    periodGames,
    periodGP,
    allGames,
    allGP,
    playerMap,
    periodType,
    year,
    month,
    yearGpCounts
  );

  const soloRecordPlayerIds = new Set<string>();
  records.forEach(r => {
    if (r.playerName && !r.playerName.includes(',')) {
      const p = [...playerMap.values()].find(x => x.name === r.playerName);
      if (p) soloRecordPlayerIds.add(p.id);
    }
  });

  const stories = detectPeriodStories(
    periodGames,
    periodGP,
    allGames,
    allGP,
    playerMap,
    rankedList,
    podium[0],
    periodType,
    year,
    month,
    soloRecordPlayerIds,
    yearGpCounts
  );

  const coreRegularMap = new Map<string, {
    playerId: string;
    playerName: string;
    gamesPlayed: number;
    profit: number;
    winRate: number;
    totalRebuys: number;
    status: string;
  }>();

  allPlayers.forEach(p => {
    const isGuest = p.type === 'guest';
    const yCnt = yearGpCounts.get(p.id) || 0;
    const atCnt = allTimeGpCounts.get(p.id) || 0;
    // Core members or frequent guests who attended many games
    const isCore = (!isGuest && (yCnt >= 3 || (atCnt >= 15 && yCnt >= 1))) || (isGuest && (yCnt >= 3 || atCnt >= 15));
    if (!isCore) return;

    const pEntry = allPlayerEntries.find(e => e.playerId === p.id);
    const gamesPlayed = pEntry ? pEntry.gamesPlayed : 0;
    const profit = pEntry ? pEntry.profit : 0;
    const winRate = pEntry ? pEntry.winRate : 0;
    const totalRebuys = pEntry ? pEntry.totalRebuys : 0;
    const status = gamesPlayed === 0
      ? 'נעדר ולא שיחק כלל בתקופה זו (0 משחקים)'
      : `${gamesPlayed} משחקים, ${profit >= 0 ? '+' : ''}₪${profit} (${winRate}% הצלחה, ${totalRebuys} קניות)`;

    // Deduplicate by name if multiple player records exist with same name
    const existing = coreRegularMap.get(p.name);
    if (!existing || gamesPlayed > existing.gamesPlayed) {
      coreRegularMap.set(p.name, {
        playerId: p.id,
        playerName: p.name,
        gamesPlayed,
        profit,
        winRate,
        totalRebuys,
        status,
      });
    }
  });

  const regularPlayersSummary = [...coreRegularMap.values()]
    .sort((a, b) => b.gamesPlayed - a.gamesPlayed || b.profit - a.profit);

  return {
    periodKey: buildPeriodKey(periodType, year, month),
    periodType,
    year,
    month,
    title,
    shortLabel,
    isCompletedPeriod: isPeriodCompleted(periodType, year, month),
    gamesCount: periodGames.length,
    totalUniquePlayers: allPlayerEntries.length,
    activeThreshold,
    nonActivePlayers: nonActiveEntries,
    regularPlayersSummary,
    totalPot,
    totalRebuys: Math.round(totalRebuys * 10) / 10,
    avgPotPerGame,
    avgPlayersPerGame,
    maxPlayersInGame,
    profitablePlayersCount,
    topLocation,
    biggestGamePot,
    podium,
    allRanked: rankedList,
    records,
    stories,
    awards: {
      sniper: sniperCandidate
        ? {
            playerName: sniperCandidate.playerName,
            winRate: sniperCandidate.winRate,
            wins: sniperCandidate.wins,
            games: sniperCandidate.gamesPlayed,
            profit: sniperCandidate.profit,
          }
        : undefined,
      bigHit: globalBigHit,
      hotStreak: streakCandidate
        ? {
            playerName: streakCandidate.playerName,
            streak: streakCandidate.longestWinStreak,
            profit: streakCandidate.profit,
          }
        : undefined,
      fourthAward,
      atm: atmCandidate
        ? {
            playerName: atmCandidate.playerName,
            totalRebuys: atmCandidate.totalRebuys,
            avgRebuys: atmAvgRebuys,
            totalInvested: atmCandidate.totalInvested,
            games: atmCandidate.gamesPlayed,
            profit: atmCandidate.profit,
          }
        : undefined,
    },
    deterministicHighlights: highlights,
  };
  } catch (err) {
    console.warn('computePeriodRecap failed:', err);
    return null;
  }
}

/**
 * Returns the most recently completed month that has at least 1 completed game.
 */
export function getLatestCompletedMonthPeriod(providedGames?: Game[]): { year: number; month: number; label: string } | null {
  try {
    const rawGames = providedGames || getAllGames();
    if (!Array.isArray(rawGames) || rawGames.length === 0) return null;
    const completedGames = rawGames.filter(g => g && g.status === 'completed');
    if (completedGames.length === 0) return null;

    const now = new Date();
    const curY = now.getFullYear();
    const curM = now.getMonth() + 1;

    const ymSet = new Set<string>();
    for (const g of completedGames) {
      const d = getGameDate(g);
      if (isNaN(d.getTime())) continue;
      const y = d.getFullYear();
      const m = d.getMonth() + 1;
      if (isNaN(y) || isNaN(m)) continue;
      // Completed months only (strictly before current calendar month)
      if (y < curY || (y === curY && m < curM)) {
        ymSet.add(`${y}-${String(m).padStart(2, '0')}`);
      }
    }

    if (ymSet.size === 0) return null;
    const sorted = Array.from(ymSet).sort().reverse();
    if (!sorted[0]) return null;
    const parts = sorted[0].split('-');
    if (parts.length !== 2) return null;
    const year = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10);
    if (isNaN(year) || isNaN(month) || month < 1 || month > 12) return null;
    return {
      year,
      month,
      label: `${HEBREW_MONTHS[month - 1]} ${year}`,
    };
  } catch (err) {
    console.warn('getLatestCompletedMonthPeriod error:', err);
    return null;
  }
}

/**
 * Lists all available periods (months, halves, years) that have games, sorted newest first.
 */
export function getAvailableRecapPeriods(): Array<{
  key: string;
  periodType: RecapPeriodType;
  year: number;
  month?: number;
  label: string;
  gamesCount: number;
}> {
  const allGames = getAllGames().filter(g => g.status === 'completed');
  const monthCounts = new Map<string, number>();
  const h1Counts = new Map<number, number>();
  const h2Counts = new Map<number, number>();
  const yearCounts = new Map<number, number>();

  for (const g of allGames) {
    const d = getGameDate(g);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    monthCounts.set(ym, (monthCounts.get(ym) || 0) + 1);
    if (m <= 6) h1Counts.set(y, (h1Counts.get(y) || 0) + 1);
    else h2Counts.set(y, (h2Counts.get(y) || 0) + 1);
    yearCounts.set(y, (yearCounts.get(y) || 0) + 1);
  }

  const result: Array<{
    key: string;
    periodType: RecapPeriodType;
    year: number;
    month?: number;
    label: string;
    gamesCount: number;
  }> = [];

  // Add months (newest first)
  const sortedMonths = Array.from(monthCounts.keys()).sort().reverse();
  for (const ym of sortedMonths) {
    const [yStr, mStr] = ym.split('-');
    const year = parseInt(yStr, 10);
    const month = parseInt(mStr, 10);
    result.push({
      key: buildPeriodKey('month', year, month),
      periodType: 'month',
      year,
      month,
      label: `חודש ${HEBREW_MONTHS[month - 1]} ${year}`,
      gamesCount: monthCounts.get(ym) || 0,
    });
  }

  // Add halves & years
  const years = Array.from(yearCounts.keys()).sort((a, b) => b - a);
  for (const y of years) {
    if ((h2Counts.get(y) || 0) >= 3) {
      result.push({
        key: buildPeriodKey('h2', y),
        periodType: 'h2',
        year: y,
        label: `חציון ב׳ ${y}`,
        gamesCount: h2Counts.get(y) || 0,
      });
    }
    if ((h1Counts.get(y) || 0) >= 3) {
      result.push({
        key: buildPeriodKey('h1', y),
        periodType: 'h1',
        year: y,
        label: `חציון א׳ ${y}`,
        gamesCount: h1Counts.get(y) || 0,
      });
    }
    if ((yearCounts.get(y) || 0) >= 4) {
      result.push({
        key: buildPeriodKey('year', y),
        periodType: 'year',
        year: y,
        label: `עונת ${y} (שנתי)`,
        gamesCount: yearCounts.get(y) || 0,
      });
    }
  }

  return result;
}

/**
 * Computes Monthly Hall of Fame rows grouped by year (newest first).
 */
export function computeMonthlyHallOfFame(): Array<{
  year: number;
  months: MonthlyHallOfFameRow[];
}> {
  const games = getAllGames().filter(g => g.status === 'completed');
  const gamePlayers = getAllGamePlayers();
  const players = getAllPlayers();
  const rebuyValue = getSettings().rebuyValue || 30;
  const preloaded = { games, gamePlayers, players, rebuyValue };

  const now = new Date();
  const curY = now.getFullYear();
  const curM = now.getMonth() + 1;

  const ymSet = new Set<string>();
  for (const g of games) {
    const d = getGameDate(g);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    // Include completed months, or current month if it has >= 2 games
    if (y < curY || (y === curY && m <= curM)) {
      ymSet.add(`${y}-${String(m).padStart(2, '0')}`);
    }
  }

  const byYear = new Map<number, MonthlyHallOfFameRow[]>();
  const sortedYMs = Array.from(ymSet).sort().reverse();

  for (const ym of sortedYMs) {
    const [yStr, mStr] = ym.split('-');
    const year = parseInt(yStr, 10);
    const month = parseInt(mStr, 10);
    const recap = computePeriodRecap('month', year, month, preloaded);
    if (!recap || recap.gamesCount === 0) continue;

    const row: MonthlyHallOfFameRow = {
      year,
      month,
      monthName: HEBREW_MONTHS[month - 1],
      gamesCount: recap.gamesCount,
      totalPot: recap.totalPot,
      top3: recap.podium.map(p => ({
        playerId: p.playerId,
        playerName: p.playerName,
        profit: p.profit,
        games: p.gamesPlayed,
      })),
      bigHit: recap.awards.bigHit
        ? { playerName: recap.awards.bigHit.playerName, profit: recap.awards.bigHit.profit }
        : undefined,
      sniper: recap.awards.sniper
        ? { playerName: recap.awards.sniper.playerName, winRate: recap.awards.sniper.winRate }
        : undefined,
    };

    const list = byYear.get(year) || [];
    list.push(row);
    byYear.set(year, list);
  }

  return Array.from(byYear.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([year, months]) => ({ year, months }));
}

/**
 * Computes every player's Trophy Cabinet (Reigning badge + 4 compact mobile pills + 6x2 H1/H2 year grids).
 */
export function computeAllPlayerTrophies(): Map<string, PlayerTrophyCabinet> {
  const games = getAllGames().filter(g => g.status === 'completed');
  const gamePlayers = getAllGamePlayers();
  const players = getAllPlayers();
  const rebuyValue = getSettings().rebuyValue || 30;
  const preloaded = { games, gamePlayers, players, rebuyValue };

  const cabinets = new Map<string, PlayerTrophyCabinet>();
  for (const p of players) {
    cabinets.set(p.id, {
      playerId: p.id,
      playerName: p.name,
      yearlyChamps: [],
      yearlyPodiums: 0,
      halfChamps: [],
      halfPodiums: 0,
      monthlyChamps: 0,
      monthlySilvers: 0,
      monthlyBronzes: 0,
      monthlyPodiums: 0,
      monthlySnipers: 0,
      monthlyBigHits: 0,
      totalTrophiesCount: 0,
      compactPills: [],
      yearsMatrix: [],
    });
  }

  if (games.length === 0) return cabinets;

  // Pre-index games-per-player-per-month (O(n) once instead of O(n²) per cell)
  const gameYM = new Map<string, string>();
  for (const g of games) {
    const d = getGameDate(g);
    gameYM.set(g.id, `${d.getFullYear()}|${d.getMonth() + 1}`);
  }
  const playerMonthGames = new Map<string, number>();
  for (const gp of gamePlayers) {
    const ym = gameYM.get(gp.gameId);
    if (!ym) continue;
    const k = `${gp.playerId}|${ym}`;
    playerMonthGames.set(k, (playerMonthGames.get(k) || 0) + 1);
  }

  const now = new Date();
  const curY = now.getFullYear();
  const curM = now.getMonth() + 1;

  // Discover all years with games
  const yearsSet = new Set<number>();
  for (const g of games) {
    yearsSet.add(getGameDate(g).getFullYear());
  }
  const years = Array.from(yearsSet).sort((a, b) => b - a);

  // Track latest completed month for the reigning badge
  let latestCompletedRecap: PeriodRecapData | null = null;

  for (const y of years) {
    const yearRecap = computePeriodRecap('year', y, undefined, preloaded);
    const h1Recap = computePeriodRecap('h1', y, undefined, preloaded);
    const h2Recap = computePeriodRecap('h2', y, undefined, preloaded);

    const yearCompleted = y < curY;
    const h1Completed = y < curY || (y === curY && curM > 6);
    const h2Completed = y < curY;

    // Award yearly & half-year titles (require >= 4 games for year/half to be official)
    if (yearCompleted && yearRecap && yearRecap.gamesCount >= 4) {
      yearRecap.podium.forEach((entry, idx) => {
        if (entry.profit <= 0) return;
        const cab = cabinets.get(entry.playerId);
        if (!cab) return;
        cab.yearlyPodiums++;
        if (idx === 0) cab.yearlyChamps.push(`${y}`);
      });
    }

    if (h1Completed && h1Recap && h1Recap.gamesCount >= 4) {
      h1Recap.podium.forEach((entry, idx) => {
        if (entry.profit <= 0) return;
        const cab = cabinets.get(entry.playerId);
        if (!cab) return;
        cab.halfPodiums++;
        if (idx === 0) cab.halfChamps.push(`H1 ${y}`);
      });
    }

    if (h2Completed && h2Recap && h2Recap.gamesCount >= 4) {
      h2Recap.podium.forEach((entry, idx) => {
        if (entry.profit <= 0) return;
        const cab = cabinets.get(entry.playerId);
        if (!cab) return;
        cab.halfPodiums++;
        if (idx === 0) cab.halfChamps.push(`H2 ${y}`);
      });
    }

    // Compute all 12 months for this year
    const monthRecaps: Array<PeriodRecapData | null> = [];
    for (let m = 1; m <= 12; m++) {
      const mRecap = computePeriodRecap('month', y, m, preloaded);
      monthRecaps.push(mRecap);

      const mCompleted = y < curY || (y === curY && m < curM);
      if (mCompleted && mRecap && mRecap.gamesCount >= 1) {
        if (
          !latestCompletedRecap ||
          y > latestCompletedRecap.year ||
          (y === latestCompletedRecap.year && m > (latestCompletedRecap.month || 0))
        ) {
          latestCompletedRecap = mRecap;
        }

        // Podium medals
        mRecap.podium.forEach((entry, idx) => {
          if (entry.profit <= 0) return;
          const cab = cabinets.get(entry.playerId);
          if (!cab) return;
          cab.monthlyPodiums++;
          if (idx === 0) cab.monthlyChamps++;
          else if (idx === 1) cab.monthlySilvers++;
          else if (idx === 2) cab.monthlyBronzes++;
        });

        // Sniper
        if (mRecap.awards.sniper) {
          const sniperEntry = mRecap.allRanked.find(
            e => e.playerName === mRecap.awards.sniper?.playerName
          );
          if (sniperEntry) {
            const cab = cabinets.get(sniperEntry.playerId);
            if (cab) cab.monthlySnipers++;
          }
        }

        // Big Hit
        if (mRecap.awards.bigHit) {
          const hitPlayer = players.find(p => p.name === mRecap.awards.bigHit?.playerName);
          if (hitPlayer) {
            const cab = cabinets.get(hitPlayer.id);
            if (cab) cab.monthlyBigHits++;
          }
        }
      }
    }

    // Build per-player 12-month matrix for year `y`
    for (const p of players) {
      const cab = cabinets.get(p.id);
      if (!cab) continue;

      const yearEntry = yearRecap?.allRanked.find(e => e.playerId === p.id);
      const h1Entry = h1Recap?.allRanked.find(e => e.playerId === p.id);
      const h2Entry = h2Recap?.allRanked.find(e => e.playerId === p.id);

      let playedInYear = false;
      const monthsCells: PlayerMonthCell[] = [];

      for (let m = 1; m <= 12; m++) {
        const mRecap = monthRecaps[m - 1];
        if (!mRecap) {
          monthsCells.push({
            year: y,
            month: m,
            monthName: HEBREW_MONTHS[m - 1],
            gamesInMonth: 0,
            playerGames: 0,
            profit: 0,
            rank: null,
            isChamp: false,
            isSilver: false,
            isBronze: false,
            isSniper: false,
            isBigHit: false,
          });
          continue;
        }

        const pRanked = mRecap.allRanked.find(e => e.playerId === p.id);
        // Check if player played at all even if below active threshold
        const playedAny = pRanked
          ? pRanked.gamesPlayed
          : playerMonthGames.get(`${p.id}|${y}|${m}`) || 0;

        if (playedAny > 0) playedInYear = true;

        const profit = pRanked ? pRanked.profit : 0;
        const rank = pRanked && pRanked.profit > 0 ? pRanked.rank : pRanked ? pRanked.rank : null;

        monthsCells.push({
          year: y,
          month: m,
          monthName: HEBREW_MONTHS[m - 1],
          gamesInMonth: mRecap.gamesCount,
          playerGames: playedAny,
          profit,
          rank,
          isChamp: rank === 1 && profit > 0,
          isSilver: rank === 2 && profit > 0,
          isBronze: rank === 3 && profit > 0,
          isSniper: mRecap.awards.sniper?.playerName === p.name,
          isBigHit: mRecap.awards.bigHit?.playerName === p.name,
        });
      }

      if (playedInYear) {
        cab.yearsMatrix.push({
          year: y,
          isYearChamp: yearCompleted && yearEntry?.rank === 1 && (yearEntry?.profit || 0) > 0 && (yearRecap?.gamesCount || 0) >= 4,
          yearRank: yearEntry?.rank || null,
          yearProfit: yearEntry?.profit || 0,
          isH1Champ: h1Completed && h1Entry?.rank === 1 && (h1Entry?.profit || 0) > 0 && (h1Recap?.gamesCount || 0) >= 4,
          h1Rank: h1Entry?.rank || null,
          isH2Champ: h2Completed && h2Entry?.rank === 1 && (h2Entry?.profit || 0) > 0 && (h2Recap?.gamesCount || 0) >= 4,
          h2Rank: h2Entry?.rank || null,
          months: monthsCells,
        });
      }
    }
  }

  // Assign reigning badge from latest completed month
  if (latestCompletedRecap && latestCompletedRecap.podium[0] && latestCompletedRecap.podium[0].profit > 0) {
    const champId = latestCompletedRecap.podium[0].playerId;
    const cab = cabinets.get(champId);
    if (cab && latestCompletedRecap.month) {
      cab.reigningBadge = {
        label: `👑 אלוף ${HEBREW_MONTHS[latestCompletedRecap.month - 1]}`,
        periodType: 'month',
        year: latestCompletedRecap.year,
        month: latestCompletedRecap.month,
      };
    }
  }

  // Build the max-4 compact pills for each player's mobile card
  for (const cab of cabinets.values()) {
    cab.totalTrophiesCount =
      cab.yearlyChamps.length +
      cab.halfChamps.length +
      cab.monthlyPodiums +
      cab.monthlySnipers +
      cab.monthlyBigHits;

    const pills: CompactTrophyPill[] = [];

    if (cab.yearlyChamps.length > 0) {
      pills.push({
        id: 'year',
        icon: '👑',
        label: 'אלוף שנה',
        count: cab.yearlyChamps.length,
        color: '#fbbf24',
        bg: 'rgba(245, 158, 11, 0.14)',
        border: 'rgba(245, 158, 11, 0.35)',
      });
    }
    if (cab.halfChamps.length > 0) {
      pills.push({
        id: 'half',
        icon: '🏆',
        label: 'אלוף חציון',
        count: cab.halfChamps.length,
        color: '#f59e0b',
        bg: 'rgba(245, 158, 11, 0.1)',
        border: 'rgba(245, 158, 11, 0.28)',
      });
    }
    if (cab.monthlyChamps > 0) {
      pills.push({
        id: 'month_champ',
        icon: '🥇',
        label: 'אלוף חודש',
        count: cab.monthlyChamps,
        color: '#eab308',
        bg: 'rgba(234, 179, 8, 0.12)',
        border: 'rgba(234, 179, 8, 0.3)',
      });
    }
    if (cab.monthlyPodiums > 0) {
      pills.push({
        id: 'month_podium',
        icon: '🏅',
        label: 'פודיום חודש',
        count: cab.monthlyPodiums,
        color: '#38bdf8',
        bg: 'rgba(56, 189, 248, 0.12)',
        border: 'rgba(56, 189, 248, 0.28)',
      });
    }
    if (pills.length < 4 && cab.monthlySnipers > 0) {
      pills.push({
        id: 'sniper',
        icon: '🎯',
        label: 'צלף החודש',
        count: cab.monthlySnipers,
        color: '#34d399',
        bg: 'rgba(52, 211, 153, 0.12)',
        border: 'rgba(52, 211, 153, 0.28)',
      });
    }
    if (pills.length < 4 && cab.monthlyBigHits > 0) {
      pills.push({
        id: 'bighit',
        icon: '💥',
        label: 'שיא החודש',
        count: cab.monthlyBigHits,
        color: '#c084fc',
        bg: 'rgba(192, 132, 252, 0.12)',
        border: 'rgba(192, 132, 252, 0.28)',
      });
    }

    cab.compactPills = pills.slice(0, 4);
  }

  return cabinets;
}

