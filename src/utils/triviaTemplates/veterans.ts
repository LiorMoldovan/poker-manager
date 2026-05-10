// Veteran (50+ games) templates.
//
// Every template here filters down to players who have played
// AT LEAST 50 completed games. The point is to surface "deep
// history" facts that only feel meaningful for the regulars —
// new joiners would dilute these answers without context.
//
// All "wins" semantics use TRUE 1st-place counts from
// `firstPlaceByPlayer` (chip leader of the night), NOT
// PlayerStats.winCount which counts profit > 0.

import {
  buildAnswers, formatExplanationDate, gParams, numericDistractors, whoAnswers,
  type BuildBundle, type Template,
} from '../triviaGenerator';
import { formatCurrency } from '../calculations';

// Floor for "veteran" filter. 50+ games = ~5 years of monthly play
// or ~1.5 years of weekly play in this group.
const VETERAN_GAMES_FLOOR = 50;

function veterans(b: BuildBundle) {
  return b.ctx.playerStats
    .filter(s => s.gamesPlayed >= VETERAN_GAMES_FLOOR && b.eligibleNames.includes(s.playerName));
}

export const VETERAN_TEMPLATES: Template[] = [
  // Highest TOTAL profit among players with 50+ games. Different
  // from `topProfitAllTime` because that one includes anyone with
  // 5+ games. This narrows to the "core" of the group.
  {
    id: 'veteranTopProfit',
    mode: 'group',
    category: 'profit_loss',
    build: (b) => {
      const ranked = veterans(b)
        .sort((a, z) => z.totalProfit - a.totalProfit || a.playerName.localeCompare(z.playerName));
      if (ranked.length < 4) return null;
      const subject = ranked[0];
      const answers = whoAnswers(subject.playerName, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.veteranTopProfit'),
        answers,
        icon: '👑',
        explanation: b.ctx.t('trivia.exp.veteranTopProfit', {
          name: subject.playerName,
          profit: formatCurrency(Math.round(subject.totalProfit)),
          games: subject.gamesPlayed,
        }),
      };
    },
  },

  // Best AVG profit per game among 50+ games — controls for play
  // volume so you can't just "play a lot" your way to the top.
  {
    id: 'veteranBestAvg',
    mode: 'group',
    category: 'profit_loss',
    build: (b) => {
      const ranked = veterans(b)
        .sort((a, z) => z.avgProfit - a.avgProfit || a.playerName.localeCompare(z.playerName));
      if (ranked.length < 4 || ranked[0].avgProfit <= 0) return null;
      const subject = ranked[0];
      const answers = whoAnswers(subject.playerName, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.veteranBestAvg'),
        answers,
        icon: '📊',
        explanation: b.ctx.t('trivia.exp.veteranBestAvg', {
          name: subject.playerName,
          avg: formatCurrency(Math.round(subject.avgProfit)),
          games: subject.gamesPlayed,
        }),
      };
    },
  },

  // Highest 1st-place rate among 50+ games. Uses the trivia-
  // specific firstPlaceByPlayer (NOT winCount).
  {
    id: 'veteranHighestFirstPlaceRate',
    mode: 'group',
    category: 'wins',
    build: (b) => {
      const ranked = veterans(b)
        .map(s => {
          const firsts = b.firstPlaceByPlayer.get(s.playerName) ?? 0;
          return { stats: s, firsts, rate: (firsts / s.gamesPlayed) * 100 };
        })
        .sort((a, z) => z.rate - a.rate
          || z.stats.gamesPlayed - a.stats.gamesPlayed
          || a.stats.playerName.localeCompare(z.stats.playerName));
      if (ranked.length < 4 || ranked[0].firsts < 1) return null;
      const subject = ranked[0];
      const answers = whoAnswers(subject.stats.playerName, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.veteranHighestFirstPlaceRate'),
        answers,
        icon: '💎',
        explanation: b.ctx.t('trivia.exp.veteranHighestFirstPlaceRate', {
          name: subject.stats.playerName,
          pct: Math.round(subject.rate),
          wins: subject.firsts,
          games: subject.stats.gamesPlayed,
        }),
      };
    },
  },

  // Most 1st-place finishes (count, not rate) among 50+ games.
  {
    id: 'veteranMostFirstPlaces',
    mode: 'group',
    category: 'wins',
    build: (b) => {
      const ranked = veterans(b)
        .map(s => ({ stats: s, firsts: b.firstPlaceByPlayer.get(s.playerName) ?? 0 }))
        .sort((a, z) => z.firsts - a.firsts || a.stats.playerName.localeCompare(z.stats.playerName));
      if (ranked.length < 4 || ranked[0].firsts < 5) return null;
      const subject = ranked[0];
      const answers = whoAnswers(subject.stats.playerName, b);
      if (!answers) return null;
      const pct = subject.stats.gamesPlayed > 0
        ? Math.round((subject.firsts / subject.stats.gamesPlayed) * 100) : 0;
      return {
        text: b.ctx.t('trivia.q.veteranMostFirstPlaces'),
        answers,
        icon: '🥇',
        explanation: b.ctx.t('trivia.exp.veteranMostFirstPlaces', {
          name: subject.stats.playerName,
          wins: subject.firsts,
          games: subject.stats.gamesPlayed,
          pct,
        }),
      };
    },
  },

  // Most podiums (top 3) among 50+ games.
  {
    id: 'veteranMostPodiums',
    mode: 'group',
    category: 'wins',
    build: (b) => {
      const veteranSet = new Set(veterans(b).map(s => s.playerName));
      const podiumCount = new Map<string, number>();
      for (const arr of b.rowsByGame.values()) {
        const sorted = [...arr].sort((a, z) => z.profit - a.profit);
        for (let i = 0; i < Math.min(3, sorted.length); i++) {
          if (veteranSet.has(sorted[i].playerName)) {
            podiumCount.set(sorted[i].playerName, (podiumCount.get(sorted[i].playerName) ?? 0) + 1);
          }
        }
      }
      const ranked = [...podiumCount.entries()]
        .sort((a, z) => z[1] - a[1] || a[0].localeCompare(z[0]));
      if (ranked.length < 4) return null;
      const subject = ranked[0];
      const answers = whoAnswers(subject[0], b);
      if (!answers) return null;
      const subjectStats = b.ctx.playerStats.find(s => s.playerName === subject[0]);
      return {
        text: b.ctx.t('trivia.q.veteranMostPodiums'),
        answers,
        icon: '🏅',
        explanation: b.ctx.t('trivia.exp.veteranMostPodiums', {
          name: subject[0],
          podiums: subject[1],
          games: subjectStats?.gamesPlayed ?? '?',
        }),
      };
    },
  },

  // Biggest single-night win achieved by a 50+ game veteran.
  {
    id: 'veteranBiggestSingleWin',
    mode: 'group',
    category: 'profit_loss',
    build: (b) => {
      const veteranSet = new Set(veterans(b).map(s => s.playerName));
      const winnerRow = b.rows.reduce<typeof b.rows[number] | null>((best, r) => {
        if (!veteranSet.has(r.playerName)) return best;
        if (best == null || r.profit > best.profit) return r;
        return best;
      }, null);
      if (!winnerRow || winnerRow.profit <= 0) return null;
      const correct = formatCurrency(Math.round(winnerRow.profit));
      const distractors = numericDistractors(winnerRow.profit);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.veteranBiggestSingleWin'),
        answers,
        icon: '💰',
        explanation: b.ctx.t('trivia.exp.veteranBiggestSingleWin', {
          name: winnerRow.playerName,
          profit: correct,
          date: formatExplanationDate(winnerRow.date, b.ctx.language),
          ...gParams(b, winnerRow.playerName),
        }),
      };
    },
  },

  // Biggest single-night loss suffered by a 50+ game veteran.
  {
    id: 'veteranBiggestSingleLoss',
    mode: 'group',
    category: 'profit_loss',
    build: (b) => {
      const veteranSet = new Set(veterans(b).map(s => s.playerName));
      const loserRow = b.rows.reduce<typeof b.rows[number] | null>((worst, r) => {
        if (!veteranSet.has(r.playerName)) return worst;
        if (worst == null || r.profit < worst.profit) return r;
        return worst;
      }, null);
      if (!loserRow || loserRow.profit >= 0) return null;
      const correct = formatCurrency(Math.round(loserRow.profit));
      const distractors = numericDistractors(loserRow.profit);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.veteranBiggestSingleLoss'),
        answers,
        icon: '🥶',
        explanation: b.ctx.t('trivia.exp.veteranBiggestSingleLoss', {
          name: loserRow.playerName,
          loss: correct,
          date: formatExplanationDate(loserRow.date, b.ctx.language),
          ...gParams(b, loserRow.playerName),
        }),
      };
    },
  },

  // Longest streak of consecutive 1st-place finishes among veterans.
  {
    id: 'veteranLongestFirstPlaceStreak',
    mode: 'group',
    category: 'wins',
    build: (b) => {
      const ranked = veterans(b)
        .map(s => ({ stats: s, streak: b.firstPlaceStreakByPlayer.get(s.playerName) ?? 0 }))
        .sort((a, z) => z.streak - a.streak
          || z.stats.gamesPlayed - a.stats.gamesPlayed
          || a.stats.playerName.localeCompare(z.stats.playerName));
      if (ranked.length < 4 || ranked[0].streak < 2) return null;
      const subject = ranked[0];
      const answers = whoAnswers(subject.stats.playerName, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.veteranLongestFirstPlaceStreak'),
        answers,
        icon: '🔥',
        explanation: b.ctx.t('trivia.exp.veteranLongestFirstPlaceStreak', {
          name: subject.stats.playerName,
          streak: subject.streak,
          games: subject.stats.gamesPlayed,
        }),
      };
    },
  },

  // Most consistent veteran — lowest standard deviation of profit.
  // "Consistent" = least variance from their own average. Wraps
  // around `niceRound` distractors via numericDistractors on the
  // SD itself, but the question is about identity (who?).
  {
    id: 'veteranMostConsistent',
    mode: 'group',
    category: 'profit_loss',
    build: (b) => {
      const scored = veterans(b).map(s => {
        const myRows = b.rowsByPlayer.get(s.playerName) ?? [];
        if (myRows.length === 0) return { stats: s, sd: Infinity };
        const mean = myRows.reduce((a, r) => a + r.profit, 0) / myRows.length;
        const variance = myRows.reduce((a, r) => a + (r.profit - mean) ** 2, 0) / myRows.length;
        return { stats: s, sd: Math.sqrt(variance) };
      })
        .sort((a, z) => a.sd - z.sd || a.stats.playerName.localeCompare(z.stats.playerName));
      if (scored.length < 4 || !Number.isFinite(scored[0].sd)) return null;
      const subject = scored[0];
      const answers = whoAnswers(subject.stats.playerName, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.veteranMostConsistent'),
        answers,
        icon: '🎯',
        explanation: b.ctx.t('trivia.exp.veteranMostConsistent', {
          name: subject.stats.playerName,
          sd: formatCurrency(Math.round(subject.sd)),
          avg: formatCurrency(Math.round(subject.stats.avgProfit)),
          games: subject.stats.gamesPlayed,
        }),
      };
    },
  },

  // Most volatile veteran — highest standard deviation. "Boom or
  // bust" player who swings hardest from night to night.
  {
    id: 'veteranMostVolatile',
    mode: 'group',
    category: 'profit_loss',
    build: (b) => {
      const scored = veterans(b).map(s => {
        const myRows = b.rowsByPlayer.get(s.playerName) ?? [];
        if (myRows.length === 0) return { stats: s, sd: 0 };
        const mean = myRows.reduce((a, r) => a + r.profit, 0) / myRows.length;
        const variance = myRows.reduce((a, r) => a + (r.profit - mean) ** 2, 0) / myRows.length;
        return { stats: s, sd: Math.sqrt(variance) };
      })
        .sort((a, z) => z.sd - a.sd || a.stats.playerName.localeCompare(z.stats.playerName));
      if (scored.length < 4 || scored[0].sd < 1) return null;
      const subject = scored[0];
      const answers = whoAnswers(subject.stats.playerName, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.veteranMostVolatile'),
        answers,
        icon: '🎢',
        explanation: b.ctx.t('trivia.exp.veteranMostVolatile', {
          name: subject.stats.playerName,
          sd: formatCurrency(Math.round(subject.sd)),
          games: subject.stats.gamesPlayed,
        }),
      };
    },
  },

  // Hottest single calendar year for any veteran — across all
  // veterans + all years they played, which year-player combo
  // had the highest total profit?
  {
    id: 'veteranHottestYearWho',
    mode: 'group',
    category: 'wins',
    build: (b) => {
      const veteranSet = new Set(veterans(b).map(s => s.playerName));
      // Map<"year|player", profit>
      const byYearPlayer = new Map<string, number>();
      for (const r of b.rows) {
        if (!veteranSet.has(r.playerName)) continue;
        const y = new Date(r.date).getFullYear();
        if (!Number.isFinite(y)) continue;
        const k = `${y}|${r.playerName}`;
        byYearPlayer.set(k, (byYearPlayer.get(k) ?? 0) + r.profit);
      }
      const ranked = [...byYearPlayer.entries()]
        .map(([k, profit]) => {
          const [yearStr, name] = k.split('|');
          return { year: Number(yearStr), name, profit };
        })
        .sort((a, z) => z.profit - a.profit
          || z.year - a.year
          || a.name.localeCompare(z.name));
      if (ranked.length < 4 || ranked[0].profit <= 0) return null;
      const subject = ranked[0];
      const answers = whoAnswers(subject.name, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.veteranHottestYearWho'),
        answers,
        icon: '🌋',
        explanation: b.ctx.t('trivia.exp.veteranHottestYearWho', {
          name: subject.name,
          year: subject.year,
          profit: formatCurrency(Math.round(subject.profit)),
        }),
      };
    },
  },

  // Most rebuys this year (2026+) among veterans only — gives the
  // "rebuy king" question a stricter, more honest cohort.
  {
    id: 'veteranMostRebuysThisYear',
    mode: 'group',
    category: 'profit_loss',
    build: (b) => {
      const REBUY_TRACKING_START = '2026-01-01';
      const veteranSet = new Set(veterans(b).map(s => s.playerName));
      const tally = new Map<string, number>();
      for (const r of b.rows) {
        if (r.date < REBUY_TRACKING_START) continue;
        if (!veteranSet.has(r.playerName)) continue;
        tally.set(r.playerName, (tally.get(r.playerName) ?? 0) + r.rebuys);
      }
      const ranked = [...tally.entries()]
        .sort((a, z) => z[1] - a[1] || a[0].localeCompare(z[0]));
      if (ranked.length < 4 || ranked[0][1] < 3) return null;
      const subject = ranked[0];
      const answers = whoAnswers(subject[0], b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.veteranMostRebuysThisYear'),
        answers,
        icon: '🪙',
        explanation: b.ctx.t('trivia.exp.veteranMostRebuysThisYear', {
          name: subject[0],
          rebuys: subject[1],
        }),
      };
    },
  },

];
