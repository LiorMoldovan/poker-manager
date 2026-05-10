// Recent-form templates.
//
// Questions about who's hot, who's cold, and what just happened.
// These all rotate naturally — last week's answer is rarely
// next week's answer.

import {
  buildAnswers, formatExplanationDate, gParams, numericDistractors, whoAnswers,
  type BuildBundle, type Template, type PlayerGameRow,
} from '../triviaGenerator';
import { formatCurrency } from '../calculations';

// Last N games per player, in chronological order (oldest first).
function lastNFor(b: BuildBundle, name: string, n: number): PlayerGameRow[] {
  const rows = b.rowsByPlayer.get(name) ?? [];
  return [...rows]
    .sort((a, z) => a.date.localeCompare(z.date))
    .slice(-n);
}

// All games in the group, chronological. Cached per call.
function allGamesChrono(b: BuildBundle): { gameId: string; date: string; rows: PlayerGameRow[] }[] {
  const out: { gameId: string; date: string; rows: PlayerGameRow[] }[] = [];
  for (const [gameId, rows] of b.rowsByGame.entries()) {
    if (rows.length === 0) continue;
    out.push({ gameId, date: rows[0].date, rows });
  }
  return out.sort((a, z) => a.date.localeCompare(z.date));
}

// Per-player CURRENT 1st-place streak: walk their games in
// chronological order, count from the end backwards while they
// kept finishing 1st. Returns 0 if their most recent game wasn't
// a 1st-place finish.
function currentFirstPlaceStreak(b: BuildBundle, name: string): number {
  const games = allGamesChrono(b).filter(g => g.rows.some(r => r.playerName === name));
  let streak = 0;
  for (let i = games.length - 1; i >= 0; i--) {
    const arr = games[i].rows;
    if (arr.length < 2) break;
    const sorted = [...arr].sort((a, z) => z.profit - a.profit);
    if (sorted[0].profit > 0 && sorted[0].playerName === name) streak++;
    else break;
  }
  return streak;
}

// Per-player CURRENT losing streak (consecutive games with
// profit < 0, walking back from most recent).
function currentLossStreak(b: BuildBundle, name: string): number {
  const rows = (b.rowsByPlayer.get(name) ?? [])
    .slice()
    .sort((a, z) => a.date.localeCompare(z.date));
  let streak = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].profit < 0) streak++;
    else break;
  }
  return streak;
}

export const RECENT_FORM_TEMPLATES: Template[] = [
  // Who's currently on the longest 1st-place streak?
  {
    id: 'currentWinStreakLeader',
    mode: 'group',
    category: 'wins',
    build: (b) => {
      const ranked = b.eligibleNames
        .map(name => ({ name, streak: currentFirstPlaceStreak(b, name) }))
        .filter(x => x.streak >= 2)
        .sort((a, z) => z.streak - a.streak || a.name.localeCompare(z.name));
      if (ranked.length === 0) return null;
      const subject = ranked[0];
      const answers = whoAnswers(subject.name, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.currentWinStreakLeader'),
        answers,
        icon: '🔥',
        explanation: b.ctx.t('trivia.exp.currentWinStreakLeader', {
          name: subject.name,
          streak: subject.streak,
        }),
      };
    },
  },

  // Who's currently on the longest losing streak?
  {
    id: 'currentLossStreakLeader',
    mode: 'group',
    category: 'wins',
    build: (b) => {
      const ranked = b.eligibleNames
        .map(name => ({ name, streak: currentLossStreak(b, name) }))
        .filter(x => x.streak >= 3)
        .sort((a, z) => z.streak - a.streak || a.name.localeCompare(z.name));
      if (ranked.length < 1) return null;
      const subject = ranked[0];
      const answers = whoAnswers(subject.name, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.currentLossStreakLeader'),
        answers,
        icon: '🥶',
        explanation: b.ctx.t('trivia.exp.currentLossStreakLeader', {
          name: subject.name,
          streak: subject.streak,
        }),
      };
    },
  },

  // Best total profit across each player's last 5 games — "who's
  // hot right now in their personal recent run".
  {
    id: 'last5GamesTopProfit',
    mode: 'group',
    category: 'profit_loss',
    build: (b) => {
      const ranked = b.eligibleNames
        .map(name => {
          const rows = lastNFor(b, name, 5);
          if (rows.length < 5) return null;
          const profit = rows.reduce((a, r) => a + r.profit, 0);
          return { name, profit };
        })
        .filter((x): x is { name: string; profit: number } => x !== null)
        .sort((a, z) => z.profit - a.profit || a.name.localeCompare(z.name));
      if (ranked.length < 4 || ranked[0].profit <= 0) return null;
      const subject = ranked[0];
      const answers = whoAnswers(subject.name, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.last5GamesTopProfit'),
        answers,
        icon: '🚀',
        explanation: b.ctx.t('trivia.exp.last5GamesTopProfit', {
          name: subject.name,
          profit: formatCurrency(Math.round(subject.profit)),
          ...gParams(b, subject.name),
        }),
      };
    },
  },

  // Worst total profit across each player's last 5 games — "who's
  // bleeding the most in their recent run".
  {
    id: 'last5GamesWorstProfit',
    mode: 'group',
    category: 'profit_loss',
    build: (b) => {
      const ranked = b.eligibleNames
        .map(name => {
          const rows = lastNFor(b, name, 5);
          if (rows.length < 5) return null;
          const profit = rows.reduce((a, r) => a + r.profit, 0);
          return { name, profit };
        })
        .filter((x): x is { name: string; profit: number } => x !== null)
        .sort((a, z) => a.profit - z.profit || a.name.localeCompare(z.name));
      if (ranked.length < 4 || ranked[0].profit >= 0) return null;
      const subject = ranked[0];
      const answers = whoAnswers(subject.name, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.last5GamesWorstProfit'),
        answers,
        icon: '🩸',
        explanation: b.ctx.t('trivia.exp.last5GamesWorstProfit', {
          name: subject.name,
          loss: formatCurrency(Math.round(subject.profit)),
          ...gParams(b, subject.name),
        }),
      };
    },
  },

  // Who won the most recent game?
  {
    id: 'lastGameWinner',
    mode: 'group',
    category: 'wins',
    build: (b) => {
      const games = allGamesChrono(b);
      if (games.length === 0) return null;
      const last = games[games.length - 1];
      if (last.rows.length < 2) return null;
      const sorted = [...last.rows].sort((a, z) => z.profit - a.profit);
      if (sorted[0].profit <= 0) return null;
      const winner = sorted[0];
      const answers = whoAnswers(winner.playerName, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.lastGameWinner'),
        answers,
        icon: '🥇',
        explanation: b.ctx.t('trivia.exp.lastGameWinner', {
          name: winner.playerName,
          profit: formatCurrency(Math.round(winner.profit)),
          date: formatExplanationDate(last.date, b.ctx.language),
          ...gParams(b, winner.playerName),
        }),
      };
    },
  },

  // Who lost the most in the most recent game?
  {
    id: 'lastGameBiggestLoser',
    mode: 'group',
    category: 'profit_loss',
    build: (b) => {
      const games = allGamesChrono(b);
      if (games.length === 0) return null;
      const last = games[games.length - 1];
      if (last.rows.length < 2) return null;
      const sorted = [...last.rows].sort((a, z) => a.profit - z.profit);
      if (sorted[0].profit >= 0) return null;
      const loser = sorted[0];
      const answers = whoAnswers(loser.playerName, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.lastGameBiggestLoser'),
        answers,
        icon: '💔',
        explanation: b.ctx.t('trivia.exp.lastGameBiggestLoser', {
          name: loser.playerName,
          loss: formatCurrency(Math.round(loser.profit)),
          date: formatExplanationDate(last.date, b.ctx.language),
        }),
      };
    },
  },

  // What was the size (player count) of the most recent game?
  {
    id: 'lastGameSize',
    mode: 'group',
    category: 'history',
    build: (b) => {
      const games = allGamesChrono(b);
      if (games.length === 0) return null;
      const last = games[games.length - 1];
      const size = last.rows.length;
      if (size < 4) return null;
      const candidates = [size - 1, size + 1, size - 2, size + 2]
        .filter(v => v >= 2 && v !== size);
      const distractors = candidates.slice(0, 3).map(String);
      const answers = buildAnswers(String(size), distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.lastGameSize'),
        answers,
        icon: '👥',
        explanation: b.ctx.t('trivia.exp.lastGameSize', {
          players: size,
          date: formatExplanationDate(last.date, b.ctx.language),
        }),
      };
    },
  },

  // Length of the longest active 1st-place streak right now.
  {
    id: 'currentLongestStreakLength',
    mode: 'group',
    category: 'wins',
    build: (b) => {
      const ranked = b.eligibleNames
        .map(name => ({ name, streak: currentFirstPlaceStreak(b, name) }))
        .filter(x => x.streak >= 2)
        .sort((a, z) => z.streak - a.streak || a.name.localeCompare(z.name));
      if (ranked.length === 0) return null;
      const top = ranked[0];
      const correct = String(top.streak);
      const candidates = [top.streak + 1, top.streak + 2, Math.max(1, top.streak - 1), top.streak + 3]
        .filter((v, i, arr) => v !== top.streak && arr.indexOf(v) === i);
      const distractors = candidates.slice(0, 3).map(String);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.currentLongestStreakLength'),
        answers,
        icon: '🔥',
        explanation: b.ctx.t('trivia.exp.currentLongestStreakLength', {
          name: top.name,
          streak: top.streak,
          ...gParams(b, top.name),
        }),
      };
    },
  },

  // Best avg profit across each player's last 3 games — "who's
  // peaking right now". Tighter than last-5 so streaks pop more.
  {
    id: 'last3GamesHottest',
    mode: 'group',
    category: 'profit_loss',
    build: (b) => {
      const ranked = b.eligibleNames
        .map(name => {
          const rows = lastNFor(b, name, 3);
          if (rows.length < 3) return null;
          const avg = rows.reduce((a, r) => a + r.profit, 0) / rows.length;
          return { name, avg };
        })
        .filter((x): x is { name: string; avg: number } => x !== null)
        .sort((a, z) => z.avg - a.avg || a.name.localeCompare(z.name));
      if (ranked.length < 4 || ranked[0].avg <= 0) return null;
      const subject = ranked[0];
      const answers = whoAnswers(subject.name, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.last3GamesHottest'),
        answers,
        icon: '🌶️',
        explanation: b.ctx.t('trivia.exp.last3GamesHottest', {
          name: subject.name,
          avg: formatCurrency(Math.round(subject.avg)),
        }),
      };
    },
  },

  // Who won the most of the last 10 games?
  {
    id: 'last10GamesMostWins',
    mode: 'group',
    category: 'wins',
    build: (b) => {
      const games = allGamesChrono(b).slice(-10);
      if (games.length < 5) return null;
      const wins = new Map<string, number>();
      for (const g of games) {
        if (g.rows.length < 2) continue;
        const sorted = [...g.rows].sort((a, z) => z.profit - a.profit);
        if (sorted[0].profit <= 0) continue;
        wins.set(sorted[0].playerName, (wins.get(sorted[0].playerName) ?? 0) + 1);
      }
      const ranked = [...wins.entries()]
        .filter(([name]) => b.eligibleNames.includes(name))
        .sort((a, z) => z[1] - a[1] || a[0].localeCompare(z[0]));
      if (ranked.length < 4 || ranked[0][1] < 2) return null;
      const [name, count] = ranked[0];
      const answers = whoAnswers(name, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.last10GamesMostWins'),
        answers,
        icon: '⚡',
        explanation: b.ctx.t('trivia.exp.last10GamesMostWins', {
          name,
          wins: count,
          games: games.length,
        }),
      };
    },
  },

  // What was the winning amount in the most recent game?
  {
    id: 'lastGameWinAmount',
    mode: 'group',
    category: 'profit_loss',
    build: (b) => {
      const games = allGamesChrono(b);
      if (games.length === 0) return null;
      const last = games[games.length - 1];
      const sorted = [...last.rows].sort((a, z) => z.profit - a.profit);
      if (sorted.length === 0 || sorted[0].profit <= 0) return null;
      const correct = formatCurrency(Math.round(sorted[0].profit));
      const distractors = numericDistractors(sorted[0].profit);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.lastGameWinAmount'),
        answers,
        icon: '💵',
        explanation: b.ctx.t('trivia.exp.lastGameWinAmount', {
          name: sorted[0].playerName,
          profit: correct,
          date: formatExplanationDate(last.date, b.ctx.language),
          ...gParams(b, sorted[0].playerName),
        }),
      };
    },
  },
];
