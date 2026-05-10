// Player-specific time-window and "personality" templates.
//
// Each picks a random eligible player as the subject and asks
// a question scoped to a specific window or trait. Subjects
// rotate per session via pickSubject (which excludes the user
// themself by default).

import {
  buildAnswers, formatExplanationDate, gParams, jerusalemDayOfWeek,
  numericDistractors, pickSubject, shuffle, yearDistractors,
  type Template,
} from '../triviaGenerator';
import { formatCurrency } from '../calculations';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const PLAYER_EXTENSION_TEMPLATES: Template[] = [
  // X's best calendar year — which year did X earn the most?
  {
    id: 'playerBestYear',
    mode: 'players',
    category: 'history',
    build: (b) => {
      const subject = pickSubject(b);
      if (!subject) return null;
      const myRows = b.rowsByPlayer.get(subject) ?? [];
      if (myRows.length < 10) return null;
      const byYear = new Map<number, { profit: number; games: number }>();
      for (const r of myRows) {
        const y = new Date(r.date).getFullYear();
        if (!Number.isFinite(y)) continue;
        const cur = byYear.get(y) ?? { profit: 0, games: 0 };
        cur.profit += r.profit;
        cur.games += 1;
        byYear.set(y, cur);
      }
      const ranked = [...byYear.entries()]
        .filter(([, v]) => v.games >= 3)
        .sort((a, z) => z[1].profit - a[1].profit || z[0] - a[0]);
      if (ranked.length < 4 || ranked[0][1].profit <= 0) return null;
      const [year, v] = ranked[0];
      const distractors = yearDistractors(year, b.currentYear);
      if (distractors.length < 3) return null;
      const answers = buildAnswers(String(year), distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.playerBestYear', { name: subject }),
        answers,
        icon: '🌟',
        explanation: b.ctx.t('trivia.exp.playerBestYear', {
          name: subject,
          year,
          profit: formatCurrency(Math.round(v.profit)),
          games: v.games,
        }),
      };
    },
  },

  // X's worst calendar year — which year did X lose the most?
  {
    id: 'playerWorstYear',
    mode: 'players',
    category: 'history',
    build: (b) => {
      const subject = pickSubject(b);
      if (!subject) return null;
      const myRows = b.rowsByPlayer.get(subject) ?? [];
      if (myRows.length < 10) return null;
      const byYear = new Map<number, { profit: number; games: number }>();
      for (const r of myRows) {
        const y = new Date(r.date).getFullYear();
        if (!Number.isFinite(y)) continue;
        const cur = byYear.get(y) ?? { profit: 0, games: 0 };
        cur.profit += r.profit;
        cur.games += 1;
        byYear.set(y, cur);
      }
      const ranked = [...byYear.entries()]
        .filter(([, v]) => v.games >= 3)
        .sort((a, z) => a[1].profit - z[1].profit || z[0] - a[0]);
      if (ranked.length < 4 || ranked[0][1].profit >= 0) return null;
      const [year, v] = ranked[0];
      const distractors = yearDistractors(year, b.currentYear);
      if (distractors.length < 3) return null;
      const answers = buildAnswers(String(year), distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.playerWorstYear', { name: subject }),
        answers,
        icon: '🌧️',
        explanation: b.ctx.t('trivia.exp.playerWorstYear', {
          name: subject,
          year,
          loss: formatCurrency(Math.round(v.profit)),
          games: v.games,
        }),
      };
    },
  },

  // X's 1st-place rate THIS YEAR (5+ games this year required).
  {
    id: 'playerFirstPlaceRateThisYear',
    mode: 'players',
    category: 'wins',
    build: (b) => {
      const subject = pickSubject(b);
      if (!subject) return null;
      const myRows = (b.rowsByPlayer.get(subject) ?? [])
        .filter(r => new Date(r.date).getFullYear() === b.currentYear);
      if (myRows.length < 5) return null;
      let firsts = 0;
      for (const r of myRows) {
        const arr = b.rowsByGame.get(r.gameId) ?? [];
        if (arr.length < 2) continue;
        const sorted = [...arr].sort((a, z) => z.profit - a.profit);
        if (sorted[0].profit > 0 && sorted[0].playerName === subject) firsts++;
      }
      const rate = (firsts / myRows.length) * 100;
      const correct = `${Math.round(rate)}%`;
      const distractors = [
        Math.max(0, Math.round(rate - 10)) + '%',
        Math.max(0, Math.round(rate - 5)) + '%',
        Math.min(100, Math.round(rate + 5)) + '%',
        Math.min(100, Math.round(rate + 12)) + '%',
      ].filter((v, i, arr) => v !== correct && arr.indexOf(v) === i);
      const answers = buildAnswers(correct, distractors.slice(0, 3));
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.playerFirstPlaceRateThisYear', {
          name: subject, year: b.currentYear,
        }),
        answers,
        icon: '🎯',
        explanation: b.ctx.t('trivia.exp.playerFirstPlaceRateThisYear', {
          name: subject,
          year: b.currentYear,
          firsts,
          games: myRows.length,
          pct: Math.round(rate),
        }),
      };
    },
  },

  // X's avg profit per game THIS YEAR.
  {
    id: 'playerAvgProfitThisYear',
    mode: 'players',
    category: 'profit_loss',
    build: (b) => {
      const subject = pickSubject(b);
      if (!subject) return null;
      const myRows = (b.rowsByPlayer.get(subject) ?? [])
        .filter(r => new Date(r.date).getFullYear() === b.currentYear);
      if (myRows.length < 5) return null;
      const total = myRows.reduce((a, r) => a + r.profit, 0);
      const avg = total / myRows.length;
      const correct = formatCurrency(Math.round(avg));
      const distractors = numericDistractors(avg || 1, 0.6);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.playerAvgProfitThisYear', {
          name: subject, year: b.currentYear,
        }),
        answers,
        icon: '📊',
        explanation: b.ctx.t('trivia.exp.playerAvgProfitThisYear', {
          name: subject,
          year: b.currentYear,
          avg: correct,
          games: myRows.length,
          total: formatCurrency(Math.round(total)),
        }),
      };
    },
  },

  // X's longest dry spell (longest run of games WITHOUT a 1st-
  // place finish, walking chronologically).
  {
    id: 'playerLongestDrySpell',
    mode: 'players',
    category: 'wins',
    build: (b) => {
      const subject = pickSubject(b);
      if (!subject) return null;
      const chronological = (b.rowsByPlayer.get(subject) ?? [])
        .slice()
        .sort((a, z) => a.date.localeCompare(z.date));
      if (chronological.length < 10) return null;
      let longest = 0;
      let current = 0;
      for (const r of chronological) {
        const arr = b.rowsByGame.get(r.gameId) ?? [];
        if (arr.length < 2) { current = 0; continue; }
        const sorted = [...arr].sort((a, z) => z.profit - a.profit);
        const wonNight = sorted[0].profit > 0 && sorted[0].playerName === subject;
        if (wonNight) {
          current = 0;
        } else {
          current++;
          if (current > longest) longest = current;
        }
      }
      if (longest < 3) return null;
      const correct = String(longest);
      const candidates = [longest + 1, longest + 2, Math.max(1, longest - 1), longest + 3, longest - 2]
        .filter(v => v > 0 && v !== longest);
      const distractors = shuffle(candidates).slice(0, 3).map(String);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.playerLongestDrySpell', { name: subject }),
        answers,
        icon: '🏜️',
        explanation: b.ctx.t('trivia.exp.playerLongestDrySpell', {
          name: subject,
          dryspell: longest,
        }),
      };
    },
  },

  // X's favorite weekday (the weekday they played the most games on).
  {
    id: 'playerFavoriteWeekday',
    mode: 'players',
    category: 'history',
    build: (b) => {
      const subject = pickSubject(b);
      if (!subject) return null;
      const myRows = b.rowsByPlayer.get(subject) ?? [];
      if (myRows.length < 10) return null;
      const counts = [0, 0, 0, 0, 0, 0, 0];
      for (const r of myRows) {
        const d = jerusalemDayOfWeek(r.date);
        if (d >= 0) counts[d]++;
      }
      const top = counts.indexOf(Math.max(...counts));
      if (counts[top] < 3) return null;
      const dayKeys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
      const correct = b.ctx.t(`home.trivia.dayOfWeek.${dayKeys[top]}`);
      const otherDows = [0, 1, 2, 3, 4, 5, 6].filter(d => d !== top);
      const distractors = shuffle(otherDows).slice(0, 3).map(d => b.ctx.t(`home.trivia.dayOfWeek.${dayKeys[d]}`));
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.playerFavoriteWeekday', { name: subject, ...gParams(b, subject) }),
        answers,
        icon: '📅',
        explanation: b.ctx.t('trivia.exp.playerFavoriteWeekday', {
          name: subject,
          day: correct,
          count: counts[top],
          total: myRows.length,
          ...gParams(b, subject),
        }),
      };
    },
  },

  // What was X's profit in their LAST game?
  {
    id: 'playerLastGameProfit',
    mode: 'players',
    category: 'profit_loss',
    build: (b) => {
      const subject = pickSubject(b);
      if (!subject) return null;
      const myRows = (b.rowsByPlayer.get(subject) ?? [])
        .slice()
        .sort((a, z) => a.date.localeCompare(z.date));
      if (myRows.length === 0) return null;
      const last = myRows[myRows.length - 1];
      const correct = formatCurrency(Math.round(last.profit));
      const seed = Math.abs(last.profit) > 5 ? last.profit : (last.profit >= 0 ? 50 : -50);
      const distractors = numericDistractors(seed, 0.6);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.playerLastGameProfit', { name: subject, ...gParams(b, subject) }),
        answers,
        icon: '🎴',
        explanation: b.ctx.t('trivia.exp.playerLastGameProfit', {
          name: subject,
          profit: correct,
          date: formatExplanationDate(last.date, b.ctx.language),
          ...gParams(b, subject),
        }),
      };
    },
  },

  // X's number of games THIS YEAR.
  {
    id: 'playerGamesThisYear',
    mode: 'players',
    category: 'history',
    build: (b) => {
      const subject = pickSubject(b);
      if (!subject) return null;
      const myRows = (b.rowsByPlayer.get(subject) ?? [])
        .filter(r => new Date(r.date).getFullYear() === b.currentYear);
      if (myRows.length < 3) return null;
      const correct = String(myRows.length);
      const candidates = [myRows.length + 1, myRows.length + 2, Math.max(1, myRows.length - 1), myRows.length + 3, myRows.length - 2]
        .filter(v => v > 0 && v !== myRows.length);
      const distractors = shuffle(candidates).slice(0, 3).map(String);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.playerGamesThisYear', {
          name: subject, year: b.currentYear, ...gParams(b, subject),
        }),
        answers,
        icon: '🗓️',
        explanation: b.ctx.t('trivia.exp.playerGamesThisYear', {
          name: subject,
          year: b.currentYear,
          games: myRows.length,
          ...gParams(b, subject),
        }),
      };
    },
  },

  // X's total profit THIS YEAR (5+ games this year required).
  {
    id: 'playerProfitThisYear',
    mode: 'players',
    category: 'profit_loss',
    build: (b) => {
      const subject = pickSubject(b);
      if (!subject) return null;
      const myRows = (b.rowsByPlayer.get(subject) ?? [])
        .filter(r => new Date(r.date).getFullYear() === b.currentYear);
      if (myRows.length < 5) return null;
      const total = myRows.reduce((a, r) => a + r.profit, 0);
      const correct = formatCurrency(Math.round(total));
      const seed = Math.abs(total) > 10 ? total : (total >= 0 ? 100 : -100);
      const distractors = numericDistractors(seed, 0.4);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.playerProfitThisYear', {
          name: subject, year: b.currentYear,
        }),
        answers,
        icon: '💵',
        explanation: b.ctx.t('trivia.exp.playerProfitThisYear', {
          name: subject,
          year: b.currentYear,
          profit: correct,
          games: myRows.length,
        }),
      };
    },
  },

  // What's X's most common position (rank) per game (1st / 2nd / 3rd / ...)?
  // We compute the modal rank across all their games.
  {
    id: 'playerMostCommonRank',
    mode: 'players',
    category: 'wins',
    build: (b) => {
      const subject = pickSubject(b);
      if (!subject) return null;
      const myRows = b.rowsByPlayer.get(subject) ?? [];
      if (myRows.length < 10) return null;
      const rankCounts = new Map<number, number>();
      for (const r of myRows) {
        const arr = b.rowsByGame.get(r.gameId) ?? [];
        if (arr.length < 2) continue;
        const sorted = [...arr].sort((a, z) => z.profit - a.profit);
        const idx = sorted.findIndex(x => x.playerName === subject);
        if (idx < 0) continue;
        rankCounts.set(idx + 1, (rankCounts.get(idx + 1) ?? 0) + 1);
      }
      if (rankCounts.size === 0) return null;
      const ranked = [...rankCounts.entries()]
        .sort((a, z) => z[1] - a[1] || a[0] - z[0]);
      const [topRank, count] = ranked[0];
      const correct = String(topRank);
      const allRanks = [...rankCounts.keys()].filter(r => r !== topRank);
      const candidates = allRanks.length >= 3
        ? allRanks
        : [topRank + 1, topRank + 2, Math.max(1, topRank - 1), topRank + 3, Math.max(1, topRank - 2)]
            .filter((v, i, arr) => v !== topRank && arr.indexOf(v) === i);
      const distractors = shuffle(candidates).slice(0, 3).map(String);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.playerMostCommonRank', { name: subject, ...gParams(b, subject) }),
        answers,
        icon: '🏷️',
        explanation: b.ctx.t('trivia.exp.playerMostCommonRank', {
          name: subject,
          rank: topRank,
          count,
          games: myRows.length,
          ...gParams(b, subject),
        }),
      };
    },
  },

  // Player's longest consecutive attendance streak (most games
  // in a row attended without skipping any group game).
  {
    id: 'playerAttendanceStreak',
    mode: 'players',
    category: 'history',
    build: (b) => {
      const subject = pickSubject(b);
      if (!subject) return null;
      const myRows = b.rowsByPlayer.get(subject) ?? [];
      if (myRows.length < 10) return null;
      const allGames = [...b.gameById.values()]
        .map(g => g.date)
        .filter(Boolean)
        .sort();
      const myDates = new Set(myRows.map(r => r.date));
      let longest = 0;
      let current = 0;
      for (const d of allGames) {
        if (myDates.has(d)) {
          current++;
          if (current > longest) longest = current;
        } else {
          current = 0;
        }
      }
      if (longest < 3) return null;
      const correct = String(longest);
      const candidates = [longest + 1, longest + 2, Math.max(1, longest - 1), longest + 3, longest - 2]
        .filter(v => v > 0 && v !== longest);
      const distractors = shuffle(candidates).slice(0, 3).map(String);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.playerAttendanceStreak', { name: subject, ...gParams(b, subject) }),
        answers,
        icon: '✋',
        explanation: b.ctx.t('trivia.exp.playerAttendanceStreak', {
          name: subject,
          streak: longest,
        }),
      };
    },
  },

  // X's most recent game date.
  {
    id: 'playerLastGameDate',
    mode: 'players',
    category: 'history',
    build: (b) => {
      const subject = pickSubject(b);
      if (!subject) return null;
      const myRows = (b.rowsByPlayer.get(subject) ?? [])
        .slice()
        .sort((a, z) => a.date.localeCompare(z.date));
      if (myRows.length === 0) return null;
      const last = myRows[myRows.length - 1];
      const lastTime = new Date(last.date).getTime();
      if (!Number.isFinite(lastTime)) return null;
      const daysSince = Math.max(0, Math.round((Date.now() - lastTime) / MS_PER_DAY));
      const correct = String(daysSince);
      const candidates = [daysSince + 7, daysSince - 7, daysSince + 14, daysSince + 30, Math.max(0, daysSince - 14)]
        .filter(v => v >= 0 && v !== daysSince);
      const distractors = shuffle(candidates).slice(0, 3).map(String);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.playerLastGameDate', { name: subject, ...gParams(b, subject) }),
        answers,
        icon: '📅',
        explanation: b.ctx.t('trivia.exp.playerLastGameDate', {
          name: subject,
          days: daysSince,
          date: formatExplanationDate(last.date, b.ctx.language),
          ...gParams(b, subject),
        }),
      };
    },
  },

  // X's nemesis THIS YEAR — opponent who finished above them
  // most often in current year shared games (3+ shared games).
  {
    id: 'playerNemesisThisYear',
    mode: 'players',
    category: 'matchups',
    build: (b) => {
      const subject = pickSubject(b, b.ctx.selfPlayerName);
      if (!subject) return null;
      const myGames = (b.rowsByPlayer.get(subject) ?? [])
        .filter(r => new Date(r.date).getFullYear() === b.currentYear)
        .map(r => r.gameId);
      if (myGames.length < 3) return null;
      const aboveMe = new Map<string, number>();
      for (const gid of myGames) {
        const arr = b.rowsByGame.get(gid) ?? [];
        const myProfit = arr.find(r => r.playerName === subject)?.profit ?? 0;
        for (const opp of arr) {
          if (opp.playerName === subject) continue;
          if (!b.eligibleNames.includes(opp.playerName)) continue;
          if (opp.profit > myProfit) aboveMe.set(opp.playerName, (aboveMe.get(opp.playerName) ?? 0) + 1);
        }
      }
      const ranked = [...aboveMe.entries()].sort((a, z) => z[1] - a[1] || a[0].localeCompare(z[0]));
      if (ranked.length < 4 || ranked[0][1] < 2) return null;
      const nemesis = ranked[0][0];
      const distractors = b.eligibleNames
        .filter(n => n !== nemesis && n !== subject)
        .slice(0, 6);
      const picked = shuffle(distractors).slice(0, 3);
      if (picked.length < 3) return null;
      const answers = buildAnswers(nemesis, picked);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.playerNemesisThisYear', {
          name: subject, year: b.currentYear, ...gParams(b, subject),
        }),
        answers,
        icon: '😈',
        explanation: b.ctx.t('trivia.exp.playerNemesisThisYear', {
          name: subject,
          nemesis,
          count: ranked[0][1],
          shared: myGames.length,
          year: b.currentYear,
          ...gParams(b, nemesis, 'n'),
        }),
      };
    },
  },
];
