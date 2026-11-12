import { Game, GamePlayer, Player } from '../types';
import { cleanNumber } from './calculations';

export interface TurningPointInfo {
  date: string;
  gameIndex: number;
  direction: 'down_after_peak' | 'up_after_trough';
  beforeAvg: number;
  afterAvg: number;
  beforeGames: number;
  afterGames: number;
  rebuysBefore: number;
  rebuysAfter: number;
  hint: string;
}

export interface PlayerTrendSummary {
  playerId: string;
  playerName: string;
  gamesPlayed: number;
  currentProfit: number;
  peakProfit: number;
  peakDate: string;
  troughProfit: number;
  troughDate: string;
  drawdownFromPeak: number;
  firstHalfAvg: number;
  secondHalfAvg: number;
  last5Avg: number;
  momentumKind: 'rising' | 'falling' | 'comeback' | 'cooling' | 'steady';
  turningPoint: TurningPointInfo | null;
  contextHint: string | null;
}

export interface TrendConclusion {
  id: string;
  icon: string;
  headline: string;
  evidence: string[];
  focusPlayerIds: string[];
  score: number;
}

export interface TrendAnalysisResult {
  conclusions: TrendConclusion[];
  playerSummaries: Map<string, PlayerTrendSummary>;
}

// Prefix signed numbers with LRM (\u200E) so +/- stays on the left of digits in RTL Hebrew prose
const fmtSigned = (n: number): string => {
  const rounded = Math.round(n);
  if (rounded === 0) return '0';
  return `\u200E${rounded > 0 ? '+' : '-'}${cleanNumber(Math.abs(rounded))}`;
};

const makeDateFormatter = (includeYear: boolean) => (dateStr: string): string => {
  const d = new Date(dateStr);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  if (!includeYear) return `${dd}/${mm}`;
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
};

function pearsonCorrelation(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return 0;
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += xs[i];
    sumY += ys[i];
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  if (den === 0) return 0;
  return num / den;
}

/**
 * Deep, multi-factor trend analysis across the selected games and players.
 * Decomposes turning points into win-rate vs loss-sizing/tilt shifts, detects
 * single-night outlier distortions, lineup changes, and table-wide dynamics.
 */
export function analyzeTrends(
  games: Game[],
  players: Player[],
  gamePlayersByGameId: Map<string, Map<string, GamePlayer>>,
  activePlayerIds?: Set<string>
): TrendAnalysisResult {
  const playerSummaries = new Map<string, PlayerTrendSummary>();
  const conclusions: TrendConclusion[] = [];

  if (games.length < 3) {
    return { conclusions, playerSummaries };
  }

  const firstYear = new Date(games[0].date).getFullYear();
  const lastYear = new Date(games[games.length - 1].date).getFullYear();
  const spansMultipleYears = firstYear !== lastYear;
  const fmtDate = makeDateFormatter(spansMultipleYears);

  const candidatePlayers = players.filter(p => {
    if (activePlayerIds && activePlayerIds.size > 0) {
      return activePlayerIds.has(p.id);
    }
    return (p.type || 'permanent') === 'permanent';
  });

  if (candidatePlayers.length === 0) {
    return { conclusions, playerSummaries };
  }

  const playerTypeById = new Map<string, string>();
  for (const p of players) {
    playerTypeById.set(p.id, p.type || 'permanent');
  }

  const gameMeta = games.map(g => {
    const byPlayer = gamePlayersByGameId.get(g.id);
    let totalPlayers = 0;
    let guestCount = 0;
    let extraRebuySum = 0;
    let hasRebuyTracking = false;
    let absProfitSum = 0;
    let guestNet = 0;
    if (byPlayer) {
      totalPlayers = byPlayer.size;
      byPlayer.forEach(gp => {
        if ((gp.rebuys || 0) > 1) hasRebuyTracking = true;
      });
      byPlayer.forEach((gp, pid) => {
        if (hasRebuyTracking) {
          extraRebuySum += Math.max(0, (gp.rebuys || 1) - 1);
        }
        absProfitSum += Math.abs(gp.profit);
        if (playerTypeById.get(pid) !== 'permanent') {
          guestCount++;
          guestNet += gp.profit;
        }
      });
    }
    return {
      game: g,
      totalPlayers,
      hasGuests: guestCount > 0,
      hasRebuyTracking,
      avgRebuys: totalPlayers > 0 && hasRebuyTracking ? extraRebuySum / totalPlayers : 0,
      avgAbsProfit: totalPlayers > 0 ? absProfitSum / totalPlayers : 0,
      guestNet,
      location: g.location?.trim() || '',
    };
  });

  interface AttendedGame {
    globalIdx: number;
    gameId: string;
    date: string;
    profit: number;
    rebuys: number; // extra rebuys (0 = initial buy-in only)
    hasRebuyTracking: boolean;
    totalPlayers: number;
    hasGuests: boolean;
    location: string;
  }

  const avgProfit = (arr: AttendedGame[]) =>
    arr.length > 0 ? arr.reduce((s, x) => s + x.profit, 0) / arr.length : 0;
  const avgRebuys = (arr: AttendedGame[]) => {
    const tracked = arr.filter(x => x.hasRebuyTracking);
    return tracked.length > 0 ? tracked.reduce((s, x) => s + x.rebuys, 0) / tracked.length : 0;
  };

  for (const player of candidatePlayers) {
    const attended: AttendedGame[] = [];
    let cumulative = 0;
    let peakProfit = -Infinity;
    let peakDate = '';
    let peakAttendedIdx = -1;
    let troughProfit = Infinity;
    let troughDate = '';
    let troughAttendedIdx = -1;

    games.forEach((game, idx) => {
      const gp = gamePlayersByGameId.get(game.id)?.get(player.id);
      if (!gp) return;
      cumulative += gp.profit;
      const attendedIdx = attended.length;
      const shortD = fmtDate(game.date);

      if (cumulative > peakProfit) {
        peakProfit = cumulative;
        peakDate = shortD;
        peakAttendedIdx = attendedIdx;
      }
      if (cumulative < troughProfit) {
        troughProfit = cumulative;
        troughDate = shortD;
        troughAttendedIdx = attendedIdx;
      }

      const hasRebuyTracking = gameMeta[idx].hasRebuyTracking;
      const extraRebuys = hasRebuyTracking ? Math.max(0, (gp.rebuys || 1) - 1) : 0;

      attended.push({
        globalIdx: idx,
        gameId: game.id,
        date: game.date,
        profit: gp.profit,
        rebuys: extraRebuys,
        hasRebuyTracking,
        totalPlayers: gameMeta[idx].totalPlayers,
        hasGuests: gameMeta[idx].hasGuests,
        location: gameMeta[idx].location,
      });
    });

    if (attended.length < 2) continue;

    if (peakProfit < 0) {
      peakProfit = 0;
      peakDate = fmtDate(attended[0].date);
    }
    if (troughProfit > 0) {
      troughProfit = 0;
      troughDate = fmtDate(attended[0].date);
    }

    const drawdownFromPeak = peakProfit - cumulative;
    const mid = Math.floor(attended.length / 2);
    const firstHalf = attended.slice(0, mid);
    const secondHalf = attended.slice(mid);
    const firstHalfAvg = avgProfit(firstHalf);
    const secondHalfAvg = avgProfit(secondHalf);
    const last5 = attended.slice(-Math.min(5, attended.length));
    const last5Avg = avgProfit(last5);

    let momentumKind: PlayerTrendSummary['momentumKind'] = 'steady';
    if (attended.length >= 4) {
      if (firstHalfAvg < -10 && secondHalfAvg > 15) momentumKind = 'comeback';
      else if (firstHalfAvg > 15 && secondHalfAvg < -10) momentumKind = 'cooling';
      else if (secondHalfAvg - firstHalfAvg >= 25) momentumKind = 'rising';
      else if (firstHalfAvg - secondHalfAvg >= 25) momentumKind = 'falling';
    }

    let turningPoint: TurningPointInfo | null = null;
    if (attended.length >= 5) {
      const checkPeakTurn =
        peakAttendedIdx >= 1 &&
        peakAttendedIdx <= attended.length - 3 &&
        drawdownFromPeak >= 120;
      const checkTroughTurn =
        troughAttendedIdx >= 1 &&
        troughAttendedIdx <= attended.length - 3 &&
        cumulative - troughProfit >= 120;

      const buildTurn = (
        splitIdx: number,
        direction: 'down_after_peak' | 'up_after_trough'
      ): TurningPointInfo | null => {
        const before = attended.slice(0, splitIdx + 1);
        const after = attended.slice(splitIdx + 1);
        const minSide = attended.length >= 12 ? Math.max(3, Math.floor(attended.length * 0.12)) : 2;
        if (before.length < minSide || after.length < minSide) return null;

        const bAvg = avgProfit(before);
        const aAvg = avgProfit(after);
        const rBefore = avgRebuys(before);
        const rAfter = avgRebuys(after);
        const turnDate = fmtDate(attended[splitIdx].date);

        let hint = '';
        if (direction === 'down_after_peak') {
          if (rAfter - rBefore >= 0.6) {
            hint = `ריבאיים קפצו מ-${rBefore.toFixed(1)} ל-${rAfter.toFixed(1)} למשחק`;
          } else {
            hint = `ממוצע ירד מ-${fmtSigned(bAvg)} ל-${fmtSigned(aAvg)} למשחק`;
          }
        } else {
          if (rBefore - rAfter >= 0.6) {
            hint = `ריבאיים ירדו מ-${rBefore.toFixed(1)} ל-${rAfter.toFixed(1)} למשחק`;
          } else {
            hint = `ממוצע קפץ מ-${fmtSigned(bAvg)} ל-${fmtSigned(aAvg)} למשחק`;
          }
        }

        return {
          date: turnDate,
          gameIndex: attended[splitIdx].globalIdx + 1,
          direction,
          beforeAvg: bAvg,
          afterAvg: aAvg,
          beforeGames: before.length,
          afterGames: after.length,
          rebuysBefore: rBefore,
          rebuysAfter: rAfter,
          hint,
        };
      };

      if (checkPeakTurn && (!checkTroughTurn || drawdownFromPeak >= cumulative - troughProfit)) {
        turningPoint = buildTurn(peakAttendedIdx, 'down_after_peak');
      } else if (checkTroughTurn) {
        turningPoint = buildTurn(troughAttendedIdx, 'up_after_trough');
      }
    }

    let contextHint: string | null = null;
    if (attended.length >= 6) {
      const withGuests = attended.filter(g => g.hasGuests);
      const noGuests = attended.filter(g => !g.hasGuests);
      if (withGuests.length >= 3 && noGuests.length >= 3) {
        const gAvg = avgProfit(withGuests);
        const rAvg = avgProfit(noGuests);
        if (Math.abs(gAvg - rAvg) >= 50) {
          contextHint = gAvg > rAvg
            ? `עם אורחים: ${fmtSigned(gAvg)} למשחק (${withGuests.length}) לעומת ${fmtSigned(rAvg)} בלי`
            : `בלי אורחים: ${fmtSigned(rAvg)} למשחק (${noGuests.length}) לעומת ${fmtSigned(gAvg)} עם אורחים`;
        }
      }
    }

    playerSummaries.set(player.id, {
      playerId: player.id,
      playerName: player.name,
      gamesPlayed: attended.length,
      currentProfit: cumulative,
      peakProfit,
      peakDate,
      troughProfit,
      troughDate,
      drawdownFromPeak,
      firstHalfAvg,
      secondHalfAvg,
      last5Avg,
      momentumKind,
      turningPoint,
      contextHint,
    });

    // ─── A) Deep Turning Point Analysis (Win-Rate vs Loss-Sizing + Lineup Shift + Outlier) ───
    if (turningPoint && Math.abs(turningPoint.afterAvg - turningPoint.beforeAvg) >= 50) {
      const splitGlobalIdx = turningPoint.gameIndex - 1;
      const beforeGames = attended.filter(g => g.globalIdx <= splitGlobalIdx);
      const afterGames = attended.filter(g => g.globalIdx > splitGlobalIdx);
      const afterSum = afterGames.reduce((s, g) => s + g.profit, 0);
      const isDown = turningPoint.direction === 'down_after_peak';

      const wrBefore = Math.round((beforeGames.filter(g => g.profit > 0).length / beforeGames.length) * 100);
      const wrAfter = Math.round((afterGames.filter(g => g.profit > 0).length / afterGames.length) * 100);

      const lossBefore = beforeGames.filter(g => g.profit < 0);
      const lossAfter = afterGames.filter(g => g.profit < 0);
      const avgLossBefore = lossBefore.length > 0 ? avgProfit(lossBefore) : 0;
      const avgLossAfter = lossAfter.length > 0 ? avgProfit(lossAfter) : 0;

      const winBefore = beforeGames.filter(g => g.profit > 0);
      const winAfter = afterGames.filter(g => g.profit > 0);
      const avgWinBefore = winBefore.length > 0 ? avgProfit(winBefore) : 0;
      const avgWinAfter = winAfter.length > 0 ? avgProfit(winAfter) : 0;

      // Outlier check in post-turn stretch
      const extremeNight = isDown
        ? afterGames.reduce((min, g) => (g.profit < min.profit ? g : min), afterGames[0])
        : afterGames.reduce((max, g) => (g.profit > max.profit ? g : max), afterGames[0]);
      const sumWithoutExtreme = afterSum - extremeNight.profit;
      const outlierDominates =
        afterGames.length >= 3 &&
        ((isDown && extremeNight.profit < -150 && sumWithoutExtreme > -40) ||
         (!isDown && extremeNight.profit > 150 && sumWithoutExtreme < 40));

      // Lineup shift: did a specific other player's attendance with this player jump or drop?
      let lineupShiftText = '';
      if (beforeGames.length >= 3 && afterGames.length >= 3) {
        let bestShift = 0;
        for (const other of candidatePlayers) {
          if (other.id === player.id) continue;
          const pBefore = beforeGames.filter(g => gamePlayersByGameId.get(g.gameId)?.has(other.id)).length / beforeGames.length;
          const pAfter = afterGames.filter(g => gamePlayersByGameId.get(g.gameId)?.has(other.id)).length / afterGames.length;
          const diff = pAfter - pBefore;
          if (Math.abs(diff) >= 0.35 && Math.abs(diff) > Math.abs(bestShift)) {
            bestShift = diff;
            lineupShiftText = diff > 0
              ? `שינוי הרכב: ${other.name} השתתף ב-${Math.round(pAfter * 100)}% מהמשחקים מאז (לעומת ${Math.round(pBefore * 100)}% קודם)`
              : `שינוי הרכב: ${other.name} ירד לנוכחות של ${Math.round(pAfter * 100)}% מאז (לעומת ${Math.round(pBefore * 100)}% קודם)`;
          }
        }
      }

      // Diagnosis for headline
      let headline = '';
      if (outlierDominates) {
        headline = isDown
          ? `הירידה של ${player.name} מ-${turningPoint.date} נובעת מערב אחד (${fmtSigned(extremeNight.profit)})`
          : `הזינוק של ${player.name} מ-${turningPoint.date} נבנה מערב שיא (${fmtSigned(extremeNight.profit)})`;
      } else if (isDown && wrBefore - wrAfter < 12 && avgLossBefore < 0 && avgLossAfter <= avgLossBefore * 1.45) {
        headline = `${player.name} הפסיד עומק מ-${turningPoint.date}: ההפסדים גדלו למרות שיעור נצחונות דומה`;
      } else if (!isDown && wrAfter - wrBefore < 12 && avgWinBefore > 0 && avgWinAfter >= avgWinBefore * 1.45) {
        headline = `${player.name} התחזק מ-${turningPoint.date}: הרווח בערבי שיא גדל משמעותית`;
      } else {
        headline = isDown
          ? `${player.name} בשינוי מגמה שלילי מ-${turningPoint.date} (${fmtSigned(afterSum)} ב-${afterGames.length} משחקים)`
          : `${player.name} בשינוי מגמה חיובי מ-${turningPoint.date} (${fmtSigned(afterSum)} ב-${afterGames.length} משחקים)`;
      }

      const evidence: string[] = [
        isDown
          ? `לפני ${turningPoint.date}: שיא של ${fmtSigned(peakProfit)} (${wrBefore}% נצחונות, ממוצע ${fmtSigned(turningPoint.beforeAvg)} ב-${beforeGames.length} משחקים)`
          : `לפני ${turningPoint.date}: שפל של ${fmtSigned(troughProfit)} (${wrBefore}% נצחונות, ממוצע ${fmtSigned(turningPoint.beforeAvg)} ב-${beforeGames.length} משחקים)`,
        `מאז ${turningPoint.date}: ${fmtSigned(afterSum)} ב-${afterGames.length} משחקים (${wrAfter}% נצחונות, ממוצע ${fmtSigned(turningPoint.afterAvg)})`,
      ];

      if (outlierDominates) {
        evidence.push(
          `בלי הערב ב-${fmtDate(extremeNight.date)} (${fmtSigned(extremeNight.profit)}): שאר ${afterGames.length - 1} המשחקים מסתכמים ב-${fmtSigned(sumWithoutExtreme)}`
        );
      } else if (isDown && lossBefore.length >= 1 && lossAfter.length >= 2 && Math.abs(avgLossAfter - avgLossBefore) >= 40) {
        evidence.push(
          `גודל ההפסד בערב רע: ממוצע ${fmtSigned(avgLossBefore)} לפני המפנה לעומת ${fmtSigned(avgLossAfter)} אחריו`
        );
      } else if (!isDown && winBefore.length >= 1 && winAfter.length >= 2 && Math.abs(avgWinAfter - avgWinBefore) >= 40) {
        evidence.push(
          `גודל הזכייה בערב טוב: ממוצע ${fmtSigned(avgWinBefore)} לפני המפנה לעומת ${fmtSigned(avgWinAfter)} אחריו`
        );
      }

      if (Math.abs(turningPoint.rebuysAfter - turningPoint.rebuysBefore) >= 0.5) {
        evidence.push(
          `קצב ריבאיים: ${turningPoint.rebuysBefore.toFixed(1)} למשחק לפני המפנה → ${turningPoint.rebuysAfter.toFixed(1)} אחריו`
        );
      }

      if (lineupShiftText) {
        evidence.push(lineupShiftText);
      }

      conclusions.push({
        id: `tp-${player.id}`,
        icon: isDown ? '📉' : '📈',
        headline,
        evidence,
        focusPlayerIds: [player.id],
        score: (Math.abs(afterSum) + Math.abs(turningPoint.afterAvg - turningPoint.beforeAvg) * 2) * (outlierDominates ? 1.15 : 1),
      });
    }

    // ─── B) Full-period Outlier Distortion (when overall profit is skewed by 1 extreme night) ───
    if (attended.length >= 6) {
      const worst = attended.reduce((m, g) => (g.profit < m.profit ? g : m), attended[0]);
      const best = attended.reduce((m, g) => (g.profit > m.profit ? g : m), attended[0]);
      const withoutWorst = cumulative - worst.profit;
      const withoutBest = cumulative - best.profit;

      if (cumulative < -60 && worst.profit <= -220 && withoutWorst >= 50) {
        conclusions.push({
          id: `outlier-w-${player.id}`,
          icon: '🎭',
          headline: `הגרף של ${player.name} מטעה: בלי ערב אחד (${fmtDate(worst.date)}) הוא ברווח`,
          evidence: [
            `מאזן כולל בתקופה: ${fmtSigned(cumulative)} ב-${attended.length} משחקים`,
            `הנפילה ב-${fmtDate(worst.date)}: ${fmtSigned(worst.profit)} (${worst.rebuys} קניות חוזרות)`,
            `בכל שאר ${attended.length - 1} המשחקים יחד: ${fmtSigned(withoutWorst)} (ממוצע ${fmtSigned(withoutWorst / (attended.length - 1))})`,
          ],
          focusPlayerIds: [player.id],
          score: Math.abs(worst.profit) * 1.4,
        });
      } else if (cumulative > 120 && best.profit >= 250 && withoutBest <= -50) {
        conclusions.push({
          id: `outlier-b-${player.id}`,
          icon: '🎭',
          headline: `הפלוס של ${player.name} נשען על ערב שיא אחד (${fmtDate(best.date)})`,
          evidence: [
            `מאזן כולל בתקופה: ${fmtSigned(cumulative)} ב-${attended.length} משחקים`,
            `ערב השיא ב-${fmtDate(best.date)}: ${fmtSigned(best.profit)}`,
            `בלי אותו ערב, שאר ${attended.length - 1} המשחקים מסתכמים ב-${fmtSigned(withoutBest)}`,
          ],
          focusPlayerIds: [player.id],
          score: best.profit * 1.3,
        });
      }
    }

    // ─── C) Rebuy Discipline / Tilt Pattern (0–2 extra rebuys = normal vs 4+ extra rebuys = heavy) ───
    const trackedAttended = attended.filter(g => g.hasRebuyTracking);
    if (trackedAttended.length >= 6) {
      const lowMax = 2; // 0, 1, or 2 extra rebuys = normal/controlled (2 is group median P50)
      const highMin = 4; // 4+ extra rebuys = heavy rebuy night (P75 top quartile)
      const lowRebuy = trackedAttended.filter(g => g.rebuys <= lowMax);
      const highRebuy = trackedAttended.filter(g => g.rebuys >= highMin);
      if (lowRebuy.length >= 3 && highRebuy.length >= 3) {
        const lowAvg = avgProfit(lowRebuy);
        const highAvg = avgProfit(highRebuy);
        const lowWinRate = Math.round((lowRebuy.filter(g => g.profit > 0).length / lowRebuy.length) * 100);
        const highWinRate = Math.round((highRebuy.filter(g => g.profit > 0).length / highRebuy.length) * 100);
        if (lowAvg > 15 && highAvg < -55 && lowAvg - highAvg >= 120) {
          conclusions.push({
            id: `rebuy-${player.id}`,
            icon: '💸',
            headline: `אצל ${player.name} ערבי ${highMin}+ ריבאיים מוחקים את הרווח: ${fmtSigned(highAvg)} לערב`,
            evidence: [
              `ערבים מבוקרים (עד ${lowMax} ריבאיים, ${lowRebuy.length} משחקים): ממוצע ${fmtSigned(lowAvg)} לערב (${lowWinRate}% נצחונות)`,
              `ערבים של ${highMin}+ ריבאיים (${highRebuy.length} משחקים): ממוצע ${fmtSigned(highAvg)} לערב (${highWinRate}% נצחונות)`,
              `מאזן מצטבר בערבי ${highMin}+ ריבאיים: ${fmtSigned(highRebuy.reduce((s, g) => s + g.profit, 0))}`,
            ],
            focusPlayerIds: [player.id],
            score: (lowAvg - highAvg) * 1.45,
          });
        }
      }
    }

    // ─── D) Host / Location Effect ───
    if (attended.length >= 6) {
      const byLoc = new Map<string, AttendedGame[]>();
      for (const ag of attended) {
        if (!ag.location) continue;
        const arr = byLoc.get(ag.location) || [];
        arr.push(ag);
        byLoc.set(ag.location, arr);
      }
      for (const [loc, locGames] of byLoc.entries()) {
        if (locGames.length < 3) continue;
        const otherGames = attended.filter(g => g.location !== loc);
        if (otherGames.length < 3) continue;
        const locAvg = avgProfit(locGames);
        const otherAvg = avgProfit(otherGames);
        if (Math.abs(locAvg - otherAvg) >= 95 && ((locAvg > 25 && otherAvg < -15) || (locAvg < -25 && otherAvg > 15))) {
          const locSum = locGames.reduce((s, g) => s + g.profit, 0);
          const locWins = locGames.filter(g => g.profit > 0).length;
          conclusions.push({
            id: `loc-${player.id}-${loc}`,
            icon: '🏠',
            headline: locAvg > otherAvg
              ? `${player.name} פורח אצל ${loc} (${fmtSigned(locSum)} ב-${locGames.length} משחקים)`
              : `${player.name} מתקשה אצל ${loc} (${fmtSigned(locSum)} ב-${locGames.length} משחקים)`,
            evidence: [
              `אצל ${loc}: ממוצע ${fmtSigned(locAvg)} לערב (${locWins}/${locGames.length} נצחונות)`,
              `בשאר המקומות: ממוצע ${fmtSigned(otherAvg)} לערב (${otherGames.length} משחקים)`,
            ],
            focusPlayerIds: [player.id],
            score: Math.abs(locAvg - otherAvg) * Math.sqrt(locGames.length),
          });
          break;
        }
      }
    }
  }

  // ─── E) Table-wide Recent Wave & Structural Regime ───
  const recentWindow = games.length <= 6 ? games.length : Math.min(6, Math.max(4, Math.floor(games.length * 0.35)));
  if (games.length >= 3) {
    const recentGames = games.slice(-recentWindow);
    const windowStart = fmtDate(recentGames[0].date);
    const windowEnd = fmtDate(recentGames[recentGames.length - 1].date);

    const movers: Array<{ id: string; name: string; sum: number; count: number; rebuys: number }> = [];
    for (const p of candidatePlayers) {
      let sum = 0;
      let count = 0;
      let rebuySum = 0;
      let trackedCount = 0;
      for (const g of recentGames) {
        const gp = gamePlayersByGameId.get(g.id)?.get(p.id);
        if (gp) {
          sum += gp.profit;
          const byP = gamePlayersByGameId.get(g.id);
          let hasTrack = false;
          byP?.forEach(x => { if ((x.rebuys || 0) > 1) hasTrack = true; });
          if (hasTrack) {
            rebuySum += Math.max(0, (gp.rebuys || 1) - 1);
            trackedCount++;
          }
          count++;
        }
      }
      if (count >= 2) {
        movers.push({ id: p.id, name: p.name, sum, count, rebuys: trackedCount > 0 ? rebuySum / trackedCount : 0 });
      }
    }

    const climbers = movers.filter(m => m.sum >= 130).sort((a, b) => b.sum - a.sum);
    const droppers = movers.filter(m => m.sum <= -130).sort((a, b) => a.sum - b.sum);

    if (climbers.length >= 1 && droppers.length >= 1) {
      const topClimbers = climbers.slice(0, 2);
      const topDroppers = droppers.slice(0, 2);
      const climbNames = topClimbers.map(c => c.name).join(' ו');
      const dropNames = topDroppers.map(d => d.name).join(' ו');

      const c0 = topClimbers[0];
      const d0 = topDroppers[0];
      const sharedC: number[] = [];
      const sharedD: number[] = [];
      let oppositeCount = 0;
      for (const g of games) {
        const byP = gamePlayersByGameId.get(g.id);
        const gpc = byP?.get(c0.id);
        const gpd = byP?.get(d0.id);
        if (gpc && gpd) {
          sharedC.push(gpc.profit);
          sharedD.push(gpd.profit);
          if ((gpc.profit > 0 && gpd.profit < 0) || (gpc.profit < 0 && gpd.profit > 0)) {
            oppositeCount++;
          }
        }
      }

      const corr = pearsonCorrelation(sharedC, sharedD);
      const evidence: string[] = [
        `חלון זמן: ${recentWindow} המשחקים האחרונים (${windowStart} – ${windowEnd})`,
        `מובילים בעלייה: ${topClimbers.map(c => `${c.name} (${fmtSigned(c.sum)} ב-${c.count} משחקים, ${c.rebuys.toFixed(1)} ריבאיים לערב)`).join(', ')}`,
        `מובילים בירידה: ${topDroppers.map(d => `${d.name} (${fmtSigned(d.sum)} ב-${d.count} משחקים, ${d.rebuys.toFixed(1)} ריבאיים לערב)`).join(', ')}`,
      ];
      if (sharedC.length >= 4 && (corr <= -0.3 || oppositeCount / sharedC.length >= 0.6)) {
        evidence.push(
          `ב-${sharedC.length} משחקים משותפים של ${c0.name} ו-${d0.name}, הם סיימו בכיוונים הפוכים ב-${Math.round((oppositeCount / sharedC.length) * 100)}% מהערבים`
        );
      }

      conclusions.push({
        id: 'table-recent-wave',
        icon: '⚖️',
        headline: `חלוקת הכוחות לאחרונה: ${climbNames} ↗ מול ${dropNames} ↘`,
        evidence,
        focusPlayerIds: [c0.id, d0.id],
        score: (Math.abs(c0.sum) + Math.abs(d0.sum)) * 0.85,
      });
    }
  }

  conclusions.sort((a, b) => b.score - a.score);

  // Keep at most 1 conclusion per single player AND max 2 turning points so the card shows diverse insights
  const finalConclusions: TrendConclusion[] = [];
  const usedSinglePlayer = new Set<string>();
  let turningPointCount = 0;
  for (const c of conclusions) {
    const isTP = c.id.startsWith('tp-');
    if (isTP && turningPointCount >= 2) continue;
    if (c.focusPlayerIds.length === 1) {
      const pid = c.focusPlayerIds[0];
      if (usedSinglePlayer.has(pid)) continue;
      usedSinglePlayer.add(pid);
    }
    if (isTP) turningPointCount++;
    finalConclusions.push(c);
    if (finalConclusions.length >= 3) break;
  }

  return {
    conclusions: finalConclusions,
    playerSummaries,
  };
}

/**
 * Formats the holistic conclusions and their evidence for the AI prompt (`generateGraphInsights`).
 */
export function formatTrendsForAI(analysis: TrendAnalysisResult): string {
  if (analysis.conclusions.length === 0) return '';
  return analysis.conclusions
    .map(c => `- ${c.headline}: ${c.evidence.join(' | ')}`)
    .join('\n');
}
