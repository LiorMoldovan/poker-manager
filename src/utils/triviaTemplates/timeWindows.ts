// Time-window variants of the all-time templates.
//
// Same shape as the originals but scoped to a finite window:
// "this year", "last year", "last 30 days", "last 5 games".
// Surfaces facts that go stale week-to-week so the trivia
// catalogue stays fresh as the group keeps playing.
//
// Every question's translation copy carries the window in plain
// language ("השנה" / "this year") so the user is never guessing
// what time frame the answer covers.

import {
  buildAnswers, formatExplanationDate, gParams, numericDistractors, whoAnswers,
  type BuildBundle, type Template, type PlayerGameRow,
} from '../triviaGenerator';
import { formatCurrency } from '../calculations';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function rowsThisYear(b: BuildBundle): PlayerGameRow[] {
  const yr = b.currentYear;
  return b.rows.filter(r => new Date(r.date).getFullYear() === yr);
}
function rowsLastYear(b: BuildBundle): PlayerGameRow[] {
  const yr = b.currentYear - 1;
  return b.rows.filter(r => new Date(r.date).getFullYear() === yr);
}
function rowsLastNDays(b: BuildBundle, n: number): PlayerGameRow[] {
  const cutoff = Date.now() - n * MS_PER_DAY;
  return b.rows.filter(r => {
    const t = new Date(r.date).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });
}

// Aggregate rows into per-player totals + game counts.
function aggregate(rows: PlayerGameRow[]) {
  const map = new Map<string, { profit: number; games: number; rebuys: number }>();
  for (const r of rows) {
    const cur = map.get(r.playerName) ?? { profit: 0, games: 0, rebuys: 0 };
    cur.profit += r.profit;
    cur.games += 1;
    cur.rebuys += r.rebuys;
    map.set(r.playerName, cur);
  }
  return map;
}

// 1st-place counts within a row subset (winner = top profit per game).
function firstPlacesIn(rows: PlayerGameRow[], rowsByGame: Map<string, PlayerGameRow[]>): Map<string, number> {
  const seenGames = new Set<string>();
  const out = new Map<string, number>();
  for (const r of rows) {
    if (seenGames.has(r.gameId)) continue;
    seenGames.add(r.gameId);
    const arr = rowsByGame.get(r.gameId) ?? [];
    if (arr.length < 2) continue;
    const sorted = [...arr].sort((a, z) => z.profit - a.profit);
    if (sorted[0].profit <= 0) continue;
    out.set(sorted[0].playerName, (out.get(sorted[0].playerName) ?? 0) + 1);
  }
  return out;
}

export const TIME_WINDOW_TEMPLATES: Template[] = [
  // Top profit THIS YEAR.
  {
    id: 'topProfitThisYear',
    mode: 'group',
    category: 'profit_loss',
    build: (b) => {
      const agg = aggregate(rowsThisYear(b));
      const ranked = [...agg.entries()]
        .filter(([name]) => b.eligibleNames.includes(name))
        .sort((a, z) => z[1].profit - a[1].profit || a[0].localeCompare(z[0]));
      if (ranked.length < 4 || ranked[0][1].profit <= 0) return null;
      const [name, v] = ranked[0];
      const answers = whoAnswers(name, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.topProfitThisYear', { year: b.currentYear }),
        answers,
        icon: '🚀',
        explanation: b.ctx.t('trivia.exp.topProfitThisYear', {
          name,
          profit: formatCurrency(Math.round(v.profit)),
          games: v.games,
          year: b.currentYear,
        }),
      };
    },
  },

  // Top profit LAST YEAR.
  {
    id: 'topProfitLastYear',
    mode: 'group',
    category: 'profit_loss',
    build: (b) => {
      const agg = aggregate(rowsLastYear(b));
      if (agg.size === 0) return null;
      const ranked = [...agg.entries()]
        .filter(([name]) => b.eligibleNames.includes(name))
        .sort((a, z) => z[1].profit - a[1].profit || a[0].localeCompare(z[0]));
      if (ranked.length < 4 || ranked[0][1].profit <= 0) return null;
      const [name, v] = ranked[0];
      const answers = whoAnswers(name, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.topProfitLastYear', { year: b.currentYear - 1 }),
        answers,
        icon: '🏆',
        explanation: b.ctx.t('trivia.exp.topProfitLastYear', {
          name,
          profit: formatCurrency(Math.round(v.profit)),
          games: v.games,
          year: b.currentYear - 1,
        }),
      };
    },
  },

  // Most 1st places THIS YEAR.
  {
    id: 'mostFirstPlacesThisYear',
    mode: 'group',
    category: 'wins',
    build: (b) => {
      const fp = firstPlacesIn(rowsThisYear(b), b.rowsByGame);
      const ranked = [...fp.entries()]
        .filter(([name]) => b.eligibleNames.includes(name))
        .sort((a, z) => z[1] - a[1] || a[0].localeCompare(z[0]));
      if (ranked.length < 4 || ranked[0][1] < 2) return null;
      const [name, count] = ranked[0];
      const answers = whoAnswers(name, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.mostFirstPlacesThisYear', { year: b.currentYear }),
        answers,
        icon: '🥇',
        explanation: b.ctx.t('trivia.exp.mostFirstPlacesThisYear', {
          name,
          wins: count,
          year: b.currentYear,
        }),
      };
    },
  },

  // Most 1st places LAST YEAR.
  {
    id: 'mostFirstPlacesLastYear',
    mode: 'group',
    category: 'wins',
    build: (b) => {
      const fp = firstPlacesIn(rowsLastYear(b), b.rowsByGame);
      if (fp.size === 0) return null;
      const ranked = [...fp.entries()]
        .filter(([name]) => b.eligibleNames.includes(name))
        .sort((a, z) => z[1] - a[1] || a[0].localeCompare(z[0]));
      if (ranked.length < 4 || ranked[0][1] < 2) return null;
      const [name, count] = ranked[0];
      const answers = whoAnswers(name, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.mostFirstPlacesLastYear', { year: b.currentYear - 1 }),
        answers,
        icon: '🥇',
        explanation: b.ctx.t('trivia.exp.mostFirstPlacesLastYear', {
          name,
          wins: count,
          year: b.currentYear - 1,
        }),
      };
    },
  },

  // Biggest single-night win THIS YEAR.
  {
    id: 'biggestSingleWinThisYear',
    mode: 'group',
    category: 'profit_loss',
    build: (b) => {
      const rows = rowsThisYear(b);
      const winnerRow = rows.reduce<PlayerGameRow | null>(
        (best, r) => (best == null || r.profit > best.profit ? r : best), null);
      if (!winnerRow || winnerRow.profit <= 0) return null;
      const correct = formatCurrency(Math.round(winnerRow.profit));
      const distractors = numericDistractors(winnerRow.profit);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.biggestSingleWinThisYear', { year: b.currentYear }),
        answers,
        icon: '💰',
        explanation: b.ctx.t('trivia.exp.biggestSingleWinThisYear', {
          name: winnerRow.playerName,
          profit: correct,
          date: formatExplanationDate(winnerRow.date, b.ctx.language),
          ...gParams(b, winnerRow.playerName),
        }),
      };
    },
  },

  // Biggest single-night win LAST 30 DAYS — totally fresh fact
  // that changes every week.
  {
    id: 'biggestSingleWinLast30Days',
    mode: 'group',
    category: 'profit_loss',
    build: (b) => {
      const rows = rowsLastNDays(b, 30);
      if (rows.length === 0) return null;
      const winnerRow = rows.reduce<PlayerGameRow | null>(
        (best, r) => (best == null || r.profit > best.profit ? r : best), null);
      if (!winnerRow || winnerRow.profit <= 0) return null;
      const correct = formatCurrency(Math.round(winnerRow.profit));
      const distractors = numericDistractors(winnerRow.profit);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.biggestSingleWinLast30Days'),
        answers,
        icon: '⚡',
        explanation: b.ctx.t('trivia.exp.biggestSingleWinLast30Days', {
          name: winnerRow.playerName,
          profit: correct,
          date: formatExplanationDate(winnerRow.date, b.ctx.language),
        }),
      };
    },
  },

  // Most painful single-night loss THIS YEAR.
  {
    id: 'biggestSingleLossThisYear',
    mode: 'group',
    category: 'profit_loss',
    build: (b) => {
      const rows = rowsThisYear(b);
      const loserRow = rows.reduce<PlayerGameRow | null>(
        (worst, r) => (worst == null || r.profit < worst.profit ? r : worst), null);
      if (!loserRow || loserRow.profit >= 0) return null;
      const correct = formatCurrency(Math.round(loserRow.profit));
      const distractors = numericDistractors(loserRow.profit);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.biggestSingleLossThisYear', { year: b.currentYear }),
        answers,
        icon: '🥶',
        explanation: b.ctx.t('trivia.exp.biggestSingleLossThisYear', {
          name: loserRow.playerName,
          loss: correct,
          date: formatExplanationDate(loserRow.date, b.ctx.language),
        }),
      };
    },
  },

  // Most podiums THIS YEAR.
  {
    id: 'mostPodiumsThisYear',
    mode: 'group',
    category: 'wins',
    build: (b) => {
      const seenGames = new Set<string>();
      const podiumCount = new Map<string, number>();
      for (const r of rowsThisYear(b)) {
        if (seenGames.has(r.gameId)) continue;
        seenGames.add(r.gameId);
        const arr = b.rowsByGame.get(r.gameId) ?? [];
        const sorted = [...arr].sort((a, z) => z.profit - a.profit);
        for (let i = 0; i < Math.min(3, sorted.length); i++) {
          podiumCount.set(sorted[i].playerName, (podiumCount.get(sorted[i].playerName) ?? 0) + 1);
        }
      }
      const ranked = [...podiumCount.entries()]
        .filter(([name]) => b.eligibleNames.includes(name))
        .sort((a, z) => z[1] - a[1] || a[0].localeCompare(z[0]));
      if (ranked.length < 4 || ranked[0][1] < 2) return null;
      const [name, count] = ranked[0];
      const answers = whoAnswers(name, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.mostPodiumsThisYear', { year: b.currentYear }),
        answers,
        icon: '🏅',
        explanation: b.ctx.t('trivia.exp.mostPodiumsThisYear', {
          name,
          podiums: count,
          year: b.currentYear,
        }),
      };
    },
  },

  // Best avg profit THIS YEAR (5+ games this year).
  {
    id: 'bestAvgThisYear',
    mode: 'group',
    category: 'profit_loss',
    build: (b) => {
      const agg = aggregate(rowsThisYear(b));
      const ranked = [...agg.entries()]
        .filter(([name, v]) => b.eligibleNames.includes(name) && v.games >= 5)
        .map(([name, v]) => ({ name, ...v, avg: v.profit / v.games }))
        .sort((a, z) => z.avg - a.avg || a.name.localeCompare(z.name));
      if (ranked.length < 4 || ranked[0].avg <= 0) return null;
      const subject = ranked[0];
      const answers = whoAnswers(subject.name, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.bestAvgThisYear', { year: b.currentYear }),
        answers,
        icon: '📊',
        explanation: b.ctx.t('trivia.exp.bestAvgThisYear', {
          name: subject.name,
          avg: formatCurrency(Math.round(subject.avg)),
          games: subject.games,
          year: b.currentYear,
        }),
      };
    },
  },

  // Most active player THIS YEAR (most games played).
  {
    id: 'mostGamesThisYear',
    mode: 'group',
    category: 'history',
    build: (b) => {
      const agg = aggregate(rowsThisYear(b));
      const ranked = [...agg.entries()]
        .filter(([name]) => b.eligibleNames.includes(name))
        .sort((a, z) => z[1].games - a[1].games || a[0].localeCompare(z[0]));
      if (ranked.length < 4 || ranked[0][1].games < 3) return null;
      const [name, v] = ranked[0];
      const answers = whoAnswers(name, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.mostGamesThisYear', { year: b.currentYear }),
        answers,
        icon: '📅',
        explanation: b.ctx.t('trivia.exp.mostGamesThisYear', {
          name,
          games: v.games,
          year: b.currentYear,
        }),
      };
    },
  },

  // Most active player LAST 30 DAYS.
  {
    id: 'mostActiveLast30Days',
    mode: 'group',
    category: 'history',
    build: (b) => {
      const agg = aggregate(rowsLastNDays(b, 30));
      const ranked = [...agg.entries()]
        .filter(([name]) => b.eligibleNames.includes(name))
        .sort((a, z) => z[1].games - a[1].games || a[0].localeCompare(z[0]));
      if (ranked.length < 4 || ranked[0][1].games < 2) return null;
      const [name, v] = ranked[0];
      const answers = whoAnswers(name, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.mostActiveLast30Days'),
        answers,
        icon: '🔋',
        explanation: b.ctx.t('trivia.exp.mostActiveLast30Days', {
          name,
          games: v.games,
        }),
      };
    },
  },

  // Most 1st places LAST 30 DAYS.
  {
    id: 'mostFirstPlacesLast30Days',
    mode: 'group',
    category: 'wins',
    build: (b) => {
      const fp = firstPlacesIn(rowsLastNDays(b, 30), b.rowsByGame);
      const ranked = [...fp.entries()]
        .filter(([name]) => b.eligibleNames.includes(name))
        .sort((a, z) => z[1] - a[1] || a[0].localeCompare(z[0]));
      if (ranked.length < 4 || ranked[0][1] < 1) return null;
      const [name, count] = ranked[0];
      const answers = whoAnswers(name, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.mostFirstPlacesLast30Days'),
        answers,
        icon: '🔥',
        explanation: b.ctx.t('trivia.exp.mostFirstPlacesLast30Days', {
          name,
          wins: count,
        }),
      };
    },
  },

  // Total chips moved THIS YEAR (sum of |profit| / 2 across all
  // game players, since profit is zero-sum).
  {
    id: 'chipsMovedThisYear',
    mode: 'group',
    category: 'history',
    build: (b) => {
      const rows = rowsThisYear(b);
      if (rows.length === 0) return null;
      const total = rows.reduce((a, r) => a + Math.max(0, r.profit), 0);
      if (total < 100) return null;
      const correct = formatCurrency(Math.round(total));
      const distractors = numericDistractors(total, 0.25);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.chipsMovedThisYear', { year: b.currentYear }),
        answers,
        icon: '💸',
        explanation: b.ctx.t('trivia.exp.chipsMovedThisYear', {
          amount: correct,
          year: b.currentYear,
        }),
      };
    },
  },

  // Most rebuys this year (single-game record, 2026+ only).
  {
    id: 'mostRebuysSingleGameThisYear',
    mode: 'group',
    category: 'profit_loss',
    build: (b) => {
      const REBUY_TRACKING_START = '2026-01-01';
      const totals = new Map<string, { rebuys: number; date: string }>();
      for (const r of rowsThisYear(b)) {
        if (r.date < REBUY_TRACKING_START) continue;
        const cur = totals.get(r.gameId) ?? { rebuys: 0, date: r.date };
        cur.rebuys += r.rebuys;
        totals.set(r.gameId, cur);
      }
      const ranked = [...totals.values()].sort((a, z) => z.rebuys - a.rebuys);
      if (ranked.length === 0 || ranked[0].rebuys < 5) return null;
      const top = ranked[0];
      const correct = String(top.rebuys);
      const candidates = [top.rebuys + 1, top.rebuys + 2, Math.max(1, top.rebuys - 1), top.rebuys + 3]
        .filter((v, i, arr) => v !== top.rebuys && arr.indexOf(v) === i);
      const distractors = candidates.slice(0, 3).map(String);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.mostRebuysSingleGameThisYear', { year: b.currentYear }),
        answers,
        icon: '🪙',
        explanation: b.ctx.t('trivia.exp.mostRebuysSingleGameThisYear', {
          rebuys: top.rebuys,
          date: formatExplanationDate(top.date, b.ctx.language),
        }),
      };
    },
  },
];
