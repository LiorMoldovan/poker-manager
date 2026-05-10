// Group dynamics templates.
//
// Facts about how the GROUP plays as a whole — not about any
// single player. Table sizes, schedule patterns, hiatus lengths,
// rebuy nights, etc.

import {
  buildAnswers, formatExplanationDate, jerusalemDayOfWeek, numericDistractors, shuffle,
  type Template,
} from '../triviaGenerator';
import { formatCurrency } from '../calculations';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const GROUP_DYNAMICS_TEMPLATES: Template[] = [
  // Most common table size all-time. Mode of player count per game.
  {
    id: 'mostCommonTableSize',
    mode: 'group',
    category: 'history',
    build: (b) => {
      const sizeCounts = new Map<number, number>();
      for (const arr of b.rowsByGame.values()) {
        const n = arr.length;
        if (n < 2) continue;
        sizeCounts.set(n, (sizeCounts.get(n) ?? 0) + 1);
      }
      if (sizeCounts.size < 2) return null;
      const ranked = [...sizeCounts.entries()].sort((a, z) => z[1] - a[1] || a[0] - z[0]);
      const [size, count] = ranked[0];
      const totalGames = [...sizeCounts.values()].reduce((a, c) => a + c, 0);
      const candidates = [size - 1, size + 1, size - 2, size + 2]
        .filter(v => v >= 2 && v !== size);
      const distractors = candidates.slice(0, 3).map(String);
      const answers = buildAnswers(String(size), distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.mostCommonTableSize'),
        answers,
        icon: '👥',
        explanation: b.ctx.t('trivia.exp.mostCommonTableSize', {
          players: size,
          games: count,
          total: totalGames,
        }),
      };
    },
  },

  // Busiest single calendar week ever (Mon-Sun ISO week, in
  // Asia/Jerusalem). Numeric question: how many games happened?
  {
    id: 'busiestWeekEver',
    mode: 'group',
    category: 'history',
    build: (b) => {
      const byWeek = new Map<string, { count: number; sample: string }>();
      for (const g of b.gameById.values()) {
        const d = new Date(g.date);
        if (Number.isNaN(d.getTime())) continue;
        // ISO week key. Roughly correct enough for our purposes
        // (we don't need RFC-perfect week boundaries — just a
        // stable bucket that doesn't span more than 7 days).
        const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
        const dayNum = (tmp.getUTCDay() + 6) % 7;
        tmp.setUTCDate(tmp.getUTCDate() - dayNum + 3);
        const firstThursday = tmp.valueOf();
        tmp.setUTCMonth(0, 1);
        if (tmp.getUTCDay() !== 4) {
          tmp.setUTCMonth(0, 1 + ((4 - tmp.getUTCDay() + 7) % 7));
        }
        const week = 1 + Math.ceil((firstThursday - tmp.valueOf()) / (7 * MS_PER_DAY));
        const key = `${d.getUTCFullYear()}-W${week}`;
        const cur = byWeek.get(key) ?? { count: 0, sample: g.date };
        cur.count += 1;
        if (g.date < cur.sample) cur.sample = g.date;
        byWeek.set(key, cur);
      }
      if (byWeek.size === 0) return null;
      const top = [...byWeek.values()].sort((a, z) => z.count - a.count)[0];
      if (top.count < 2) return null;
      const correct = String(top.count);
      const candidates = [top.count + 1, top.count + 2, Math.max(1, top.count - 1), top.count + 3]
        .filter((v, i, arr) => v !== top.count && arr.indexOf(v) === i);
      const distractors = candidates.slice(0, 3).map(String);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.busiestWeekEver'),
        answers,
        icon: '⚡',
        explanation: b.ctx.t('trivia.exp.busiestWeekEver', {
          count: top.count,
          date: formatExplanationDate(top.sample, b.ctx.language),
        }),
      };
    },
  },

  // Busiest single calendar month ever.
  {
    id: 'busiestMonthEver',
    mode: 'group',
    category: 'history',
    build: (b) => {
      const byMonth = new Map<string, number>();
      for (const g of b.gameById.values()) {
        const d = new Date(g.date);
        if (Number.isNaN(d.getTime())) continue;
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        byMonth.set(key, (byMonth.get(key) ?? 0) + 1);
      }
      if (byMonth.size === 0) return null;
      const ranked = [...byMonth.entries()].sort((a, z) => z[1] - a[1] || z[0].localeCompare(a[0]));
      const [, count] = ranked[0];
      if (count < 3) return null;
      const correct = String(count);
      const candidates = [count + 1, count + 2, Math.max(1, count - 1), count + 3]
        .filter((v, i, arr) => v !== count && arr.indexOf(v) === i);
      const distractors = candidates.slice(0, 3).map(String);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.busiestMonthEver'),
        answers,
        icon: '📆',
        explanation: b.ctx.t('trivia.exp.busiestMonthEver', {
          count,
        }),
      };
    },
  },

  // Longest gap between two consecutive games (group hiatus).
  {
    id: 'longestGapBetweenGames',
    mode: 'group',
    category: 'history',
    build: (b) => {
      const dates = [...b.gameById.values()]
        .map(g => g.date)
        .filter(d => !!d)
        .sort();
      if (dates.length < 4) return null;
      let maxGapDays = 0;
      let beforeIso = '';
      let afterIso = '';
      for (let i = 1; i < dates.length; i++) {
        const ms = new Date(dates[i]).getTime() - new Date(dates[i - 1]).getTime();
        if (!Number.isFinite(ms)) continue;
        const days = Math.round(ms / MS_PER_DAY);
        if (days > maxGapDays) {
          maxGapDays = days;
          beforeIso = dates[i - 1];
          afterIso = dates[i];
        }
      }
      if (maxGapDays < 14) return null;
      const correct = String(maxGapDays);
      const candidates = [maxGapDays - 5, maxGapDays + 5, maxGapDays - 10, maxGapDays + 10, maxGapDays - 2, maxGapDays + 2]
        .filter(v => v > 0 && v !== maxGapDays);
      const distractors = shuffle(candidates).slice(0, 3).map(String);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.longestGapBetweenGames'),
        answers,
        icon: '🕰️',
        explanation: b.ctx.t('trivia.exp.longestGapBetweenGames', {
          days: maxGapDays,
          before: formatExplanationDate(beforeIso, b.ctx.language),
          after: formatExplanationDate(afterIso, b.ctx.language),
        }),
      };
    },
  },

  // Single-game rebuy record (2026+ when tracking is honest).
  {
    id: 'gameWithMostRebuysSince2026',
    mode: 'group',
    category: 'profit_loss',
    build: (b) => {
      const REBUY_TRACKING_START = '2026-01-01';
      let bestId = '';
      let bestRebuys = 0;
      let bestDate = '';
      for (const [gameId, arr] of b.rowsByGame.entries()) {
        if (arr.length === 0 || arr[0].date < REBUY_TRACKING_START) continue;
        const total = arr.reduce((a, r) => a + r.rebuys, 0);
        if (total > bestRebuys) {
          bestRebuys = total;
          bestId = gameId;
          bestDate = arr[0].date;
        }
      }
      if (bestRebuys < 5 || !bestId) return null;
      const correct = String(bestRebuys);
      const candidates = [bestRebuys + 1, bestRebuys + 2, Math.max(1, bestRebuys - 1), bestRebuys + 3, bestRebuys + 5]
        .filter((v, i, arr) => v !== bestRebuys && arr.indexOf(v) === i);
      const distractors = shuffle(candidates).slice(0, 3).map(String);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.gameWithMostRebuysSince2026'),
        answers,
        icon: '🪙',
        explanation: b.ctx.t('trivia.exp.gameWithMostRebuysSince2026', {
          rebuys: bestRebuys,
          date: formatExplanationDate(bestDate, b.ctx.language),
        }),
      };
    },
  },

  // Average players per game (group all-time).
  {
    id: 'avgPlayersPerGame',
    mode: 'group',
    category: 'history',
    build: (b) => {
      let totalPlayers = 0;
      let totalGames = 0;
      for (const arr of b.rowsByGame.values()) {
        if (arr.length === 0) continue;
        totalPlayers += arr.length;
        totalGames += 1;
      }
      if (totalGames < 10) return null;
      const avg = totalPlayers / totalGames;
      const rounded = Math.round(avg * 10) / 10; // 1 decimal
      const correct = `${rounded}`;
      const candidates = [
        rounded - 0.5, rounded + 0.5, rounded - 1, rounded + 1,
      ]
        .filter(v => v > 1 && Math.abs(v - rounded) > 0.01)
        .map(v => Math.round(v * 10) / 10);
      const distractors = shuffle(candidates).slice(0, 3).map(String);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.avgPlayersPerGame'),
        answers,
        icon: '📐',
        explanation: b.ctx.t('trivia.exp.avgPlayersPerGame', {
          avg: rounded,
          total: totalGames,
        }),
      };
    },
  },

  // Total chips moved all-time across the group.
  {
    id: 'chipsMovedAllTime',
    mode: 'group',
    category: 'history',
    build: (b) => {
      const total = b.rows.reduce((a, r) => a + Math.max(0, r.profit), 0);
      if (total < 1000) return null;
      const correct = formatCurrency(Math.round(total));
      const distractors = numericDistractors(total, 0.25);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.chipsMovedAllTime'),
        answers,
        icon: '💸',
        explanation: b.ctx.t('trivia.exp.chipsMovedAllTime', {
          amount: correct,
          total: b.gameById.size,
        }),
      };
    },
  },

  // Saturday-specific count: how many of the group's games
  // happened on a Saturday (most popular weekday in this group)?
  {
    id: 'gamesOnPopularDay',
    mode: 'group',
    category: 'history',
    build: (b) => {
      const counts = [0, 0, 0, 0, 0, 0, 0];
      for (const g of b.gameById.values()) {
        const d = jerusalemDayOfWeek(g.date);
        if (d >= 0) counts[d]++;
      }
      const top = counts.indexOf(Math.max(...counts));
      const popularCount = counts[top];
      if (popularCount < 5) return null;
      const correct = String(popularCount);
      const distractors = numericDistractors(popularCount, 0.3);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
      const dayName = b.ctx.t(`home.trivia.dayOfWeek.${dayKeys[top]}`);
      return {
        text: b.ctx.t('trivia.q.gamesOnPopularDay', { day: dayName }),
        answers,
        icon: '📅',
        explanation: b.ctx.t('trivia.exp.gamesOnPopularDay', {
          day: dayName,
          count: popularCount,
          total: b.gameById.size,
        }),
      };
    },
  },
];
