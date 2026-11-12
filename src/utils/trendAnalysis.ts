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

// Always prefix signed numbers with LRM (\u200E) so +/- stays on the left of digits in RTL Hebrew prose
const fmtSigned = (n: number): string => {
  const rounded = Math.round(n);
  if (rounded === 0) return '0';
  return `\u200E${rounded > 0 ? '+' : '-'}${cleanNumber(Math.abs(rounded))}`;
};

const fmtShortDate = (dateStr: string): string => {
  const d = new Date(dateStr);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
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
 * Produces high-signal, evidence-backed trend conclusions across the selected
 * games and players. Adapts thresholds dynamically so both short windows (e.g.
 * last 5 games) and full-season/all-time ranges yield relevant insights.
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
    let rebuySum = 0;
    let guestNet = 0;
    if (byPlayer) {
      totalPlayers = byPlayer.size;
      byPlayer.forEach((gp, pid) => {
        rebuySum += gp.rebuys || 0;
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
      avgRebuys: totalPlayers > 0 ? rebuySum / totalPlayers : 0,
      guestNet,
      location: g.location?.trim() || '',
    };
  });

  interface AttendedGame {
    globalIdx: number;
    gameId: string;
    date: string;
    profit: number;
    rebuys: number;
    totalPlayers: number;
    hasGuests: boolean;
    location: string;
  }

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
      const shortD = fmtShortDate(game.date);

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

      attended.push({
        globalIdx: idx,
        gameId: game.id,
        date: game.date,
        profit: gp.profit,
        rebuys: gp.rebuys || 0,
        totalPlayers: gameMeta[idx].totalPlayers,
        hasGuests: gameMeta[idx].hasGuests,
        location: gameMeta[idx].location,
      });
    });

    if (attended.length < 2) continue;

    if (peakProfit < 0) {
      peakProfit = 0;
      peakDate = fmtShortDate(attended[0].date);
    }
    if (troughProfit > 0) {
      troughProfit = 0;
      troughDate = fmtShortDate(attended[0].date);
    }

    const drawdownFromPeak = peakProfit - cumulative;
    const mid = Math.floor(attended.length / 2);
    const firstHalf = attended.slice(0, mid);
    const secondHalf = attended.slice(mid);
    const avgOf = (arr: AttendedGame[]) =>
      arr.length > 0 ? arr.reduce((s, x) => s + x.profit, 0) / arr.length : 0;
    const avgRebuysOf = (arr: AttendedGame[]) =>
      arr.length > 0 ? arr.reduce((s, x) => s + x.rebuys, 0) / arr.length : 0;

    const firstHalfAvg = avgOf(firstHalf);
    const secondHalfAvg = avgOf(secondHalf);
    const last5 = attended.slice(-Math.min(5, attended.length));
    const last5Avg = avgOf(last5);

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
        if (before.length < 2 || after.length < 2) return null;

        const beforeAvg = avgOf(before);
        const afterAvg = avgOf(after);
        const rebuysBefore = avgRebuysOf(before);
        const rebuysAfter = avgRebuysOf(after);
        const turnDate = fmtShortDate(attended[splitIdx].date);

        let hint = '';
        if (direction === 'down_after_peak') {
          if (rebuysAfter - rebuysBefore >= 0.5) {
            hint = `ממוצע קניות קפץ מ-${rebuysBefore.toFixed(1)} ל-${rebuysAfter.toFixed(1)} למשחק`;
          } else {
            const bigLoss = after.reduce((min, g) => Math.min(min, g.profit), 0);
            const afterLossSum = after.filter(g => g.profit < 0).reduce((s, g) => s + g.profit, 0);
            if (afterLossSum < 0 && Math.abs(bigLoss) >= Math.abs(afterLossSum) * 0.55) {
              hint = `לילה אחד חריג (${fmtSigned(bigLoss)}) גרם לרוב הירידה`;
            } else {
              hint = `ממוצע למשחק ירד מ-${fmtSigned(beforeAvg)} ל-${fmtSigned(afterAvg)}`;
            }
          }
        } else {
          if (rebuysBefore - rebuysAfter >= 0.5) {
            hint = `ממוצע קניות ירד מ-${rebuysBefore.toFixed(1)} ל-${rebuysAfter.toFixed(1)} למשחק`;
          } else {
            hint = `ממוצע למשחק קפץ מ-${fmtSigned(beforeAvg)} ל-${fmtSigned(afterAvg)}`;
          }
        }

        return {
          date: turnDate,
          gameIndex: attended[splitIdx].globalIdx + 1,
          direction,
          beforeAvg,
          afterAvg,
          beforeGames: before.length,
          afterGames: after.length,
          rebuysBefore,
          rebuysAfter,
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
        const gAvg = avgOf(withGuests);
        const rAvg = avgOf(noGuests);
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

    // A) Turning point conclusion
    if (turningPoint && Math.abs(turningPoint.afterAvg - turningPoint.beforeAvg) >= 45) {
      const splitGlobalIdx = turningPoint.gameIndex - 1;
      const afterGames = attended.filter(g => g.globalIdx > splitGlobalIdx);
      const afterSum = afterGames.reduce((s, g) => s + g.profit, 0);
      const afterWins = afterGames.filter(g => g.profit > 0).length;
      const isDown = turningPoint.direction === 'down_after_peak';

      const counterMovers: Array<{ id: string; name: string; sum: number; shared: number }> = [];
      for (const other of candidatePlayers) {
        if (other.id === player.id) continue;
        let sum = 0;
        let shared = 0;
        for (const ag of afterGames) {
          const gp = gamePlayersByGameId.get(ag.gameId)?.get(other.id);
          if (gp) {
            sum += gp.profit;
            shared++;
          }
        }
        if (shared >= 2 && ((isDown && sum >= 150) || (!isDown && sum <= -150))) {
          counterMovers.push({ id: other.id, name: other.name, sum, shared });
        }
      }
      counterMovers.sort((a, b) => Math.abs(b.sum) - Math.abs(a.sum));

      const evidence: string[] = [
        isDown
          ? `עד ${turningPoint.date} הגיע לשיא של ${fmtSigned(peakProfit)} (ממוצע ${fmtSigned(turningPoint.beforeAvg)} לערב ב-${turningPoint.beforeGames} משחקים)`
          : `עד ${turningPoint.date} היה בשפל של ${fmtSigned(troughProfit)} (ממוצע ${fmtSigned(turningPoint.beforeAvg)} לערב ב-${turningPoint.beforeGames} משחקים)`,
        `מאז: ${fmtSigned(afterSum)} ב-${afterGames.length} משחקים (${afterWins} נצחונות, ממוצע ${fmtSigned(turningPoint.afterAvg)})`,
      ];

      if (Math.abs(turningPoint.rebuysAfter - turningPoint.rebuysBefore) >= 0.4) {
        evidence.push(
          `רמת קניות: ממוצע של ${turningPoint.rebuysBefore.toFixed(1)} לפני המפנה לעומת ${turningPoint.rebuysAfter.toFixed(1)} אחריו`
        );
      } else {
        const biggestNight = isDown
          ? afterGames.reduce((min, g) => (g.profit < min.profit ? g : min), afterGames[0])
          : afterGames.reduce((max, g) => (g.profit > max.profit ? g : max), afterGames[0]);
        evidence.push(
          isDown
            ? `הלילה הקשה בתקופה: ${fmtSigned(biggestNight.profit)} ב-${fmtShortDate(biggestNight.date)}`
            : `שיא הריצה: ${fmtSigned(biggestNight.profit)} ב-${fmtShortDate(biggestNight.date)}`
        );
      }

      if (counterMovers.length > 0) {
        const topNames = counterMovers
          .slice(0, 2)
          .map(m => `${m.name} (${fmtSigned(m.sum)})`)
          .join(' ו-');
        evidence.push(
          isDown
            ? `באותם משחקים משותפים עלו במקביל: ${topNames}`
            : `באותם משחקים משותפים ירדו במקביל: ${topNames}`
        );
      }

      conclusions.push({
        id: `tp-${player.id}`,
        icon: isDown ? '📉' : '📈',
        headline: isDown
          ? `${player.name} איבד גובה מאז ${turningPoint.date} (${fmtSigned(afterSum)})`
          : `${player.name} התהפך לעלייה מאז ${turningPoint.date} (${fmtSigned(afterSum)})`,
        evidence,
        focusPlayerIds: [player.id],
        score: Math.abs(afterSum) + Math.abs(turningPoint.afterAvg - turningPoint.beforeAvg) * 2,
      });
    }

    // B) Rebuy discipline / tilt pattern (0-1 rebuys vs 2+ rebuys)
    if (attended.length >= 6) {
      const lowRebuy = attended.filter(g => g.rebuys <= 1);
      const highRebuy = attended.filter(g => g.rebuys >= 2);
      if (lowRebuy.length >= 3 && highRebuy.length >= 2) {
        const lowAvg = avgOf(lowRebuy);
        const highAvg = avgOf(highRebuy);
        const lowWinRate = Math.round((lowRebuy.filter(g => g.profit > 0).length / lowRebuy.length) * 100);
        const highWinRate = Math.round((highRebuy.filter(g => g.profit > 0).length / highRebuy.length) * 100);
        if (lowAvg > 15 && highAvg < -40 && lowAvg - highAvg >= 95) {
          conclusions.push({
            id: `rebuy-${player.id}`,
            icon: '💸',
            headline: `אצל ${player.name} קניות חוזרות הופכות הפסד: ${fmtSigned(highAvg)} עם 2+ קניות`,
            evidence: [
              `בערבים רגועים (עד קנייה 1): ממוצע ${fmtSigned(lowAvg)} לערב (${lowWinRate}% נצחונות ב-${lowRebuy.length} משחקים)`,
              `בערבים עם 2+ קניות חוזרות: ממוצע ${fmtSigned(highAvg)} לערב (${highWinRate}% נצחונות ב-${highRebuy.length} משחקים)`,
              `סה"כ הפסיד ${fmtSigned(highRebuy.reduce((s, g) => s + g.profit, 0))} באותם ערבי ריבאי גבוה`,
            ],
            focusPlayerIds: [player.id],
            score: (lowAvg - highAvg) * 1.6,
          });
        }
      }
    }

    // C) Host / location effect (if location data exists and shows a major split)
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
        const locAvg = avgOf(locGames);
        const otherAvg = avgOf(otherGames);
        if (Math.abs(locAvg - otherAvg) >= 85 && ((locAvg > 20 && otherAvg < -10) || (locAvg < -20 && otherAvg > 10))) {
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

    // D) Table size effect (short-handed <= 6 vs full table >= 8)
    if (attended.length >= 6) {
      const shortTable = attended.filter(g => g.totalPlayers > 0 && g.totalPlayers <= 6);
      const fullTable = attended.filter(g => g.totalPlayers >= 8);
      if (shortTable.length >= 3 && fullTable.length >= 3) {
        const sAvg = avgOf(shortTable);
        const fAvg = avgOf(fullTable);
        if (Math.abs(sAvg - fAvg) >= 90 && ((sAvg > 20 && fAvg < -10) || (fAvg > 20 && sAvg < -10))) {
          const prefersShort = sAvg > fAvg;
          conclusions.push({
            id: `size-${player.id}`,
            icon: '🪑',
            headline: prefersShort
              ? `${player.name} מעדיף שולחן מצומצם (${fmtSigned(sAvg)} למשחק)`
              : `${player.name} מרוויח בשולחן מלא (${fmtSigned(fAvg)} למשחק)`,
            evidence: [
              `שולחן של עד 6 שחקנים (${shortTable.length} משחקים): ממוצע ${fmtSigned(sAvg)} לערב`,
              `שולחן של 8+ שחקנים (${fullTable.length} משחקים): ממוצע ${fmtSigned(fAvg)} לערב`,
            ],
            focusPlayerIds: [player.id],
            score: Math.abs(sAvg - fAvg) * 1.4,
          });
        }
      }
    }
  }

  // E) Table-wide wave (adapts to short windows like "Last 5 games" as well as full periods)
  const recentWindow = games.length <= 6 ? games.length : Math.min(6, Math.max(4, Math.floor(games.length * 0.4)));
  if (games.length >= 3) {
    const recentGames = games.slice(-recentWindow);
    const windowStart = fmtShortDate(recentGames[0].date);
    const windowEnd = fmtShortDate(recentGames[recentGames.length - 1].date);

    const movers: Array<{ id: string; name: string; sum: number; count: number }> = [];
    for (const p of candidatePlayers) {
      let sum = 0;
      let count = 0;
      for (const g of recentGames) {
        const gp = gamePlayersByGameId.get(g.id)?.get(p.id);
        if (gp) {
          sum += gp.profit;
          count++;
        }
      }
      if (count >= 2) {
        movers.push({ id: p.id, name: p.name, sum, count });
      }
    }

    const climbers = movers.filter(m => m.sum >= 120).sort((a, b) => b.sum - a.sum);
    const droppers = movers.filter(m => m.sum <= -120).sort((a, b) => a.sum - b.sum);

    if (climbers.length >= 1 && droppers.length >= 1) {
      const topClimbers = climbers.slice(0, 2);
      const topDroppers = droppers.slice(0, 2);
      const climbNames = topClimbers.map(c => c.name).join(' ו-');
      const dropNames = topDroppers.map(d => d.name).join(' ו-');

      const c0 = topClimbers[0];
      const d0 = topDroppers[0];
      const sharedProfitsC: number[] = [];
      const sharedProfitsD: number[] = [];
      let oppositeCount = 0;
      for (const g of games) {
        const byP = gamePlayersByGameId.get(g.id);
        const gpc = byP?.get(c0.id);
        const gpd = byP?.get(d0.id);
        if (gpc && gpd) {
          sharedProfitsC.push(gpc.profit);
          sharedProfitsD.push(gpd.profit);
          if ((gpc.profit > 0 && gpd.profit < 0) || (gpc.profit < 0 && gpd.profit > 0)) {
            oppositeCount++;
          }
        }
      }

      const corr = pearsonCorrelation(sharedProfitsC, sharedProfitsD);
      const evidence: string[] = [
        `חלון זמן: ${recentWindow} המשחקים האחרונים (${windowStart} – ${windowEnd})`,
        `בעלייה: ${topClimbers.map(c => `${c.name} (${fmtSigned(c.sum)} ב-${c.count} משחקים)`).join(', ')}`,
        `בירידה: ${topDroppers.map(d => `${d.name} (${fmtSigned(d.sum)} ב-${d.count} משחקים)`).join(', ')}`,
      ];
      if (sharedProfitsC.length >= 4 && (corr <= -0.3 || oppositeCount / sharedProfitsC.length >= 0.6)) {
        evidence.push(
          `ב-${sharedProfitsC.length} משחקים משותפים של ${c0.name} ו-${d0.name}, הם סיימו בכיוונים הפוכים ב-${Math.round((oppositeCount / sharedProfitsC.length) * 100)}% מהערבים`
        );
      }

      conclusions.push({
        id: 'table-recent-wave',
        icon: '⚖️',
        headline: `תנועת השולחן: ${climbNames} ↗ מול ${dropNames} ↘`,
        evidence,
        focusPlayerIds: [c0.id, d0.id],
        score: (Math.abs(c0.sum) + Math.abs(d0.sum)) * 0.9,
      });
    }
  }

  // F) Guest flow impact (only if genuinely significant)
  if (games.length >= 5) {
    const guestGames = gameMeta.filter(m => m.hasGuests);
    const regOnlyGames = gameMeta.filter(m => !m.hasGuests);
    const totalGuestNet = guestGames.reduce((s, m) => s + m.guestNet, 0);

    if (guestGames.length >= 3 && regOnlyGames.length >= 2 && Math.abs(totalGuestNet) >= 300) {
      const avgGuestImpact = totalGuestNet / guestGames.length;
      const rebuysWithGuests = guestGames.reduce((s, m) => s + m.avgRebuys, 0) / guestGames.length;
      const rebuysRegOnly = regOnlyGames.reduce((s, m) => s + m.avgRebuys, 0) / regOnlyGames.length;
      const regularsFavored = totalGuestNet < 0;

      const evidence: string[] = [
        `ב-${guestGames.length} משחקים השתתפו אורחים (מתוך ${games.length} משחקים בתקופה)`,
        regularsFavored
          ? `בממוצע נשארו בקופת הקבועים ${cleanNumber(Math.abs(Math.round(avgGuestImpact)))} לערב מהאורחים`
          : `בממוצע יצאו האורחים עם ${cleanNumber(Math.round(avgGuestImpact))} לערב`,
      ];
      if (Math.abs(rebuysWithGuests - rebuysRegOnly) >= 0.25) {
        evidence.push(
          `קצב קניות: ${rebuysWithGuests.toFixed(1)} לשחקן עם אורחים לעומת ${rebuysRegOnly.toFixed(1)} בהרכב קבועים בלבד`
        );
      }

      conclusions.push({
        id: 'lineup-guests-effect',
        icon: '👥',
        headline: regularsFavored
          ? `משחקים עם אורחים מזרימים כסף לשולחן (${fmtSigned(Math.abs(totalGuestNet))})`
          : `האורחים מפתיעים ולוקחים כסף מהשולחן (${fmtSigned(totalGuestNet)})`,
        evidence,
        focusPlayerIds: [],
        score: Math.abs(totalGuestNet) * 0.65,
      });
    }
  }

  conclusions.sort((a, b) => b.score - a.score);

  // Deduplicate so we don't show 2 conclusions about the exact same single player
  const finalConclusions: TrendConclusion[] = [];
  const usedSinglePlayer = new Set<string>();
  for (const c of conclusions) {
    if (c.focusPlayerIds.length === 1) {
      const pid = c.focusPlayerIds[0];
      if (usedSinglePlayer.has(pid)) continue;
      usedSinglePlayer.add(pid);
    }
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
