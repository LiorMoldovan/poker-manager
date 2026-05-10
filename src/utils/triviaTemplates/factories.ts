// Factory-generated trivia templates.
//
// Why this file exists: hand-coding 100 nearly-identical "top profit
// in <window>" templates is both error-prone (one typo and the
// template silently miscomputes) and a maintenance nightmare. So
// instead we declare a handful of WINDOWS and a handful of FACTORIES
// (one per question shape), then cross-product them. ~10 stat shapes
// × ~5 windows = ~50 group templates from one audited code path,
// plus ~8 player shapes × ~3 windows = ~24 player templates. Add
// the hand-coded "creative" templates at the bottom of this file
// (position-specific, day-of-week, etc.) and we more than double
// the catalogue without copy-paste.
//
// Translation strategy: every factory uses a SINGLE generic-period
// translation key per stat (e.g. `trivia.q.fp.topProfit`) with a
// `{period}` placeholder. The factory fills `{period}` with the
// localized window phrase ("השנה" / "ב-30 הימים האחרונים" / etc.)
// so we don't end up with 50 nearly-identical translation keys.
// Existing window-specific keys (e.g. `trivia.q.topProfitThisYear`)
// stay as-is — those are used by the older one-off templates and
// we don't touch them.
//
// Quality guardrails baked in:
// • Every factory checks `eligibleNames.length >= 4` so we always
//   have enough distractors for a real "who" question.
// • Every factory bails (`return null`) when the window has too
//   few rows / players to produce a meaningful question (the floor
//   is per-stat — e.g. "best avg per game" needs ≥ 3 games per
//   ranked player, "biggest single win" needs at least one
//   positive-profit row in the window).
// • Numeric stats use `numericDistractors` which guarantees 3
//   plausible-but-wrong values rounded to a "nice" magnitude.
// • Player names in explanations get `gParams(b, name)` spread so
//   Hebrew copy renders the right gendered verb (סיים / סיימה,
//   לקח / לקחה, etc.) — the user has explicitly forbidden the
//   "/ה" slash form, no exceptions.

import {
  buildAnswers, formatExplanationDate, gParams, numericDistractors,
  pickSubject, shuffle, whoAnswers,
  type BuildBundle, type Template, type PlayerGameRow,
  type TriviaCategory,
} from '../triviaGenerator';
import { formatCurrency } from '../calculations';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const REBUY_TRACKING_START = '2026-01-01';

// ─── Windows ────────────────────────────────────────────────────
//
// Each window is (id, period-phrase HE/EN, row filter, min-rows).
// `period` is what fills the `{period}` placeholder in the
// translation strings. Keep these phrases natural-sounding in
// Hebrew — they appear at the END of every question/explanation
// the factories generate, so awkward phrasing here multiplies into
// dozens of awkward questions.
//
// We deliberately do NOT define an `allTime` window here because
// the existing all-time templates (in triviaGenerator.ts) already
// cover that bucket. Adding a duplicate would just give the user
// the same question twice in different sessions.

interface WindowSpec {
  id: string;
  periodHe: string;
  periodEn: string;
  filter: (b: BuildBundle) => PlayerGameRow[];
}

const WINDOWS: WindowSpec[] = [
  {
    id: 'thisYear',
    periodHe: 'השנה',
    periodEn: 'this year',
    filter: (b) => {
      const yr = b.currentYear;
      return b.rows.filter(r => new Date(r.date).getFullYear() === yr);
    },
  },
  {
    id: 'lastYear',
    periodHe: 'בשנה שעברה',
    periodEn: 'last year',
    filter: (b) => {
      const yr = b.currentYear - 1;
      return b.rows.filter(r => new Date(r.date).getFullYear() === yr);
    },
  },
  {
    id: 'last30Days',
    periodHe: 'ב-30 הימים האחרונים',
    periodEn: 'in the last 30 days',
    filter: (b) => {
      const cutoff = Date.now() - 30 * MS_PER_DAY;
      return b.rows.filter(r => {
        const t = new Date(r.date).getTime();
        return Number.isFinite(t) && t >= cutoff;
      });
    },
  },
  {
    id: 'last90Days',
    periodHe: 'ב-90 הימים האחרונים',
    periodEn: 'in the last 90 days',
    filter: (b) => {
      const cutoff = Date.now() - 90 * MS_PER_DAY;
      return b.rows.filter(r => {
        const t = new Date(r.date).getTime();
        return Number.isFinite(t) && t >= cutoff;
      });
    },
  },
  {
    id: 'last10Games',
    periodHe: 'ב-10 המשחקים האחרונים של הקבוצה',
    periodEn: 'in the last 10 group games',
    filter: (b) => {
      const games = [...b.gameById.values()]
        .filter(g => g.date)
        .sort((a, z) => a.date.localeCompare(z.date))
        .slice(-10)
        .map(g => g.id);
      const ids = new Set(games);
      return b.rows.filter(r => ids.has(r.gameId));
    },
  },
];

// Returns localized period phrase for the active language.
function periodFor(b: BuildBundle, w: WindowSpec): string {
  return b.ctx.language === 'he' ? w.periodHe : w.periodEn;
}

// ─── Aggregation helpers ────────────────────────────────────────

interface PlayerAgg { profit: number; games: number; rebuys: number }

function aggregate(rows: PlayerGameRow[]): Map<string, PlayerAgg> {
  const m = new Map<string, PlayerAgg>();
  for (const r of rows) {
    const cur = m.get(r.playerName) ?? { profit: 0, games: 0, rebuys: 0 };
    cur.profit += r.profit;
    cur.games += 1;
    cur.rebuys += r.rebuys;
    m.set(r.playerName, cur);
  }
  return m;
}

// 1st-place counts within a row subset.
function firstPlacesIn(
  rows: PlayerGameRow[],
  rowsByGame: Map<string, PlayerGameRow[]>,
): Map<string, number> {
  const seen = new Set<string>();
  const out = new Map<string, number>();
  for (const r of rows) {
    if (seen.has(r.gameId)) continue;
    seen.add(r.gameId);
    const arr = rowsByGame.get(r.gameId) ?? [];
    if (arr.length < 2) continue;
    const sorted = [...arr].sort((a, z) => z.profit - a.profit);
    if (sorted[0].profit <= 0) continue;
    out.set(sorted[0].playerName, (out.get(sorted[0].playerName) ?? 0) + 1);
  }
  return out;
}

// Podium counts (top-3 by profit per game) within a row subset.
function podiumsIn(
  rows: PlayerGameRow[],
  rowsByGame: Map<string, PlayerGameRow[]>,
): Map<string, number> {
  const seen = new Set<string>();
  const out = new Map<string, number>();
  for (const r of rows) {
    if (seen.has(r.gameId)) continue;
    seen.add(r.gameId);
    const arr = rowsByGame.get(r.gameId) ?? [];
    if (arr.length < 3) continue;
    const sorted = [...arr].sort((a, z) => z.profit - a.profit);
    for (let i = 0; i < Math.min(3, sorted.length); i++) {
      out.set(sorted[i].playerName, (out.get(sorted[i].playerName) ?? 0) + 1);
    }
  }
  return out;
}

// ─── Group factories ────────────────────────────────────────────
//
// Each factory takes a window and returns a Template. We never
// expose the factory directly — only the cross-product result.

function topProfitFactory(w: WindowSpec): Template {
  return {
    id: `topProfit_${w.id}`,
    mode: 'group',
    category: 'profit_loss',
    group: `topProfit_${w.id}`,
    build: (b) => {
      const rows = w.filter(b);
      if (rows.length === 0) return null;
      const agg = aggregate(rows);
      const ranked = [...agg.entries()]
        .filter(([n]) => b.eligibleNames.includes(n))
        .sort((a, z) => z[1].profit - a[1].profit || a[0].localeCompare(z[0]));
      if (ranked.length < 4 || ranked[0][1].profit <= 0) return null;
      const [name, v] = ranked[0];
      const answers = whoAnswers(name, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.fp.topProfit', { period: periodFor(b, w) }),
        answers,
        icon: '🚀',
        explanation: b.ctx.t('trivia.exp.fp.topProfit', {
          name,
          profit: formatCurrency(Math.round(v.profit)),
          games: v.games,
          period: periodFor(b, w),
        }),
      };
    },
  };
}

function biggestNetLoserFactory(w: WindowSpec): Template {
  return {
    id: `biggestNetLoser_${w.id}`,
    mode: 'group',
    category: 'profit_loss',
    group: `biggestNetLoser_${w.id}`,
    build: (b) => {
      const rows = w.filter(b);
      if (rows.length === 0) return null;
      const agg = aggregate(rows);
      const ranked = [...agg.entries()]
        .filter(([n]) => b.eligibleNames.includes(n))
        .sort((a, z) => a[1].profit - z[1].profit || a[0].localeCompare(z[0]));
      if (ranked.length < 4 || ranked[0][1].profit >= 0) return null;
      const [name, v] = ranked[0];
      const answers = whoAnswers(name, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.fp.biggestNetLoser', { period: periodFor(b, w) }),
        answers,
        icon: '📉',
        explanation: b.ctx.t('trivia.exp.fp.biggestNetLoser', {
          name,
          loss: formatCurrency(Math.round(v.profit)),
          games: v.games,
          period: periodFor(b, w),
        }),
      };
    },
  };
}

function mostGamesFactory(w: WindowSpec): Template {
  return {
    id: `mostGames_${w.id}`,
    mode: 'group',
    category: 'history',
    group: `mostGames_${w.id}`,
    build: (b) => {
      const rows = w.filter(b);
      if (rows.length === 0) return null;
      const agg = aggregate(rows);
      const ranked = [...agg.entries()]
        .filter(([n]) => b.eligibleNames.includes(n))
        .sort((a, z) => z[1].games - a[1].games || a[0].localeCompare(z[0]));
      if (ranked.length < 4 || ranked[0][1].games < 2) return null;
      const [name, v] = ranked[0];
      const answers = whoAnswers(name, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.fp.mostGames', { period: periodFor(b, w) }),
        answers,
        icon: '📅',
        explanation: b.ctx.t('trivia.exp.fp.mostGames', {
          name,
          games: v.games,
          period: periodFor(b, w),
          ...gParams(b, name),
        }),
      };
    },
  };
}

function mostFirstPlacesFactory(w: WindowSpec): Template {
  return {
    id: `mostFirstPlaces_${w.id}`,
    mode: 'group',
    category: 'wins',
    group: `mostFirstPlaces_${w.id}`,
    build: (b) => {
      const rows = w.filter(b);
      if (rows.length === 0) return null;
      const fp = firstPlacesIn(rows, b.rowsByGame);
      const ranked = [...fp.entries()]
        .filter(([n]) => b.eligibleNames.includes(n))
        .sort((a, z) => z[1] - a[1] || a[0].localeCompare(z[0]));
      if (ranked.length < 4 || ranked[0][1] < 1) return null;
      const [name, count] = ranked[0];
      const answers = whoAnswers(name, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.fp.mostFirstPlaces', { period: periodFor(b, w) }),
        answers,
        icon: '🥇',
        explanation: b.ctx.t('trivia.exp.fp.mostFirstPlaces', {
          name,
          wins: count,
          period: periodFor(b, w),
        }),
      };
    },
  };
}

function mostPodiumsFactory(w: WindowSpec): Template {
  return {
    id: `mostPodiums_${w.id}`,
    mode: 'group',
    category: 'wins',
    group: `mostPodiums_${w.id}`,
    build: (b) => {
      const rows = w.filter(b);
      if (rows.length === 0) return null;
      const pod = podiumsIn(rows, b.rowsByGame);
      const ranked = [...pod.entries()]
        .filter(([n]) => b.eligibleNames.includes(n))
        .sort((a, z) => z[1] - a[1] || a[0].localeCompare(z[0]));
      if (ranked.length < 4 || ranked[0][1] < 2) return null;
      const [name, count] = ranked[0];
      const answers = whoAnswers(name, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.fp.mostPodiums', { period: periodFor(b, w) }),
        answers,
        icon: '🏅',
        explanation: b.ctx.t('trivia.exp.fp.mostPodiums', {
          name,
          podiums: count,
          period: periodFor(b, w),
        }),
      };
    },
  };
}

function bestAvgFactory(w: WindowSpec): Template {
  return {
    id: `bestAvg_${w.id}`,
    mode: 'group',
    category: 'profit_loss',
    group: `bestAvg_${w.id}`,
    build: (b) => {
      const rows = w.filter(b);
      if (rows.length === 0) return null;
      const agg = aggregate(rows);
      const ranked = [...agg.entries()]
        .filter(([n, v]) => v.games >= 3 && b.eligibleNames.includes(n))
        .map(([n, v]) => ({ name: n, avg: v.profit / v.games, games: v.games }))
        .sort((a, z) => z.avg - a.avg || a.name.localeCompare(z.name));
      if (ranked.length < 4 || ranked[0].avg <= 0) return null;
      const top = ranked[0];
      const answers = whoAnswers(top.name, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.fp.bestAvg', { period: periodFor(b, w) }),
        answers,
        icon: '📈',
        explanation: b.ctx.t('trivia.exp.fp.bestAvg', {
          name: top.name,
          avg: formatCurrency(Math.round(top.avg)),
          games: top.games,
          period: periodFor(b, w),
        }),
      };
    },
  };
}

function worstAvgFactory(w: WindowSpec): Template {
  return {
    id: `worstAvg_${w.id}`,
    mode: 'group',
    category: 'profit_loss',
    group: `worstAvg_${w.id}`,
    build: (b) => {
      const rows = w.filter(b);
      if (rows.length === 0) return null;
      const agg = aggregate(rows);
      const ranked = [...agg.entries()]
        .filter(([n, v]) => v.games >= 3 && b.eligibleNames.includes(n))
        .map(([n, v]) => ({ name: n, avg: v.profit / v.games, games: v.games }))
        .sort((a, z) => a.avg - z.avg || a.name.localeCompare(z.name));
      if (ranked.length < 4 || ranked[0].avg >= 0) return null;
      const bottom = ranked[0];
      const answers = whoAnswers(bottom.name, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.fp.worstAvg', { period: periodFor(b, w) }),
        answers,
        icon: '📉',
        explanation: b.ctx.t('trivia.exp.fp.worstAvg', {
          name: bottom.name,
          avg: formatCurrency(Math.round(bottom.avg)),
          games: bottom.games,
          period: periodFor(b, w),
        }),
      };
    },
  };
}

function biggestSingleWinFactory(w: WindowSpec): Template {
  return {
    id: `biggestSingleWin_${w.id}`,
    mode: 'group',
    category: 'profit_loss',
    group: `biggestSingleWin_${w.id}`,
    build: (b) => {
      const rows = w.filter(b);
      if (rows.length === 0) return null;
      const winner = rows.reduce<PlayerGameRow | null>(
        (best, r) => (best == null || r.profit > best.profit ? r : best), null);
      if (!winner || winner.profit <= 0) return null;
      const correct = formatCurrency(Math.round(winner.profit));
      const distractors = numericDistractors(winner.profit);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.fp.biggestSingleWin', { period: periodFor(b, w) }),
        answers,
        icon: '💰',
        explanation: b.ctx.t('trivia.exp.fp.biggestSingleWin', {
          name: winner.playerName,
          profit: correct,
          date: formatExplanationDate(winner.date, b.ctx.language),
          ...gParams(b, winner.playerName),
        }),
      };
    },
  };
}

function biggestSingleLossFactory(w: WindowSpec): Template {
  return {
    id: `biggestSingleLoss_${w.id}`,
    mode: 'group',
    category: 'profit_loss',
    group: `biggestSingleLoss_${w.id}`,
    build: (b) => {
      const rows = w.filter(b);
      if (rows.length === 0) return null;
      const loser = rows.reduce<PlayerGameRow | null>(
        (worst, r) => (worst == null || r.profit < worst.profit ? r : worst), null);
      if (!loser || loser.profit >= 0) return null;
      const correct = formatCurrency(Math.round(loser.profit));
      const distractors = numericDistractors(loser.profit);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.fp.biggestSingleLoss', { period: periodFor(b, w) }),
        answers,
        icon: '🥶',
        explanation: b.ctx.t('trivia.exp.fp.biggestSingleLoss', {
          name: loser.playerName,
          loss: correct,
          date: formatExplanationDate(loser.date, b.ctx.language),
          ...gParams(b, loser.playerName),
        }),
      };
    },
  };
}

function biggestSingleWinPlayerFactory(w: WindowSpec): Template {
  return {
    id: `biggestSingleWinPlayer_${w.id}`,
    mode: 'group',
    category: 'profit_loss',
    group: `biggestSingleWin_${w.id}`,
    build: (b) => {
      const rows = w.filter(b);
      if (rows.length === 0) return null;
      const winner = rows.reduce<PlayerGameRow | null>(
        (best, r) => (best == null || r.profit > best.profit ? r : best), null);
      if (!winner || winner.profit <= 0) return null;
      const answers = whoAnswers(winner.playerName, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.fp.biggestSingleWinPlayer', { period: periodFor(b, w) }),
        answers,
        icon: '🚀',
        explanation: b.ctx.t('trivia.exp.fp.biggestSingleWin', {
          name: winner.playerName,
          profit: formatCurrency(Math.round(winner.profit)),
          date: formatExplanationDate(winner.date, b.ctx.language),
          ...gParams(b, winner.playerName),
        }),
      };
    },
  };
}

function biggestSingleLossPlayerFactory(w: WindowSpec): Template {
  return {
    id: `biggestSingleLossPlayer_${w.id}`,
    mode: 'group',
    category: 'profit_loss',
    group: `biggestSingleLoss_${w.id}`,
    build: (b) => {
      const rows = w.filter(b);
      if (rows.length === 0) return null;
      const loser = rows.reduce<PlayerGameRow | null>(
        (worst, r) => (worst == null || r.profit < worst.profit ? r : worst), null);
      if (!loser || loser.profit >= 0) return null;
      const answers = whoAnswers(loser.playerName, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.fp.biggestSingleLossPlayer', { period: periodFor(b, w) }),
        answers,
        icon: '💔',
        explanation: b.ctx.t('trivia.exp.fp.biggestSingleLoss', {
          name: loser.playerName,
          loss: formatCurrency(Math.round(loser.profit)),
          date: formatExplanationDate(loser.date, b.ctx.language),
          ...gParams(b, loser.playerName),
        }),
      };
    },
  };
}

function gamesCountFactory(w: WindowSpec): Template {
  return {
    id: `gamesCount_${w.id}`,
    mode: 'group',
    category: 'history',
    group: `gamesCount_${w.id}`,
    build: (b) => {
      const rows = w.filter(b);
      const games = new Set(rows.map(r => r.gameId));
      const n = games.size;
      if (n < 2) return null;
      const correct = String(n);
      const candidates = [n + 1, n + 2, Math.max(1, n - 1), n + 3, Math.max(1, n - 2)]
        .filter((v, i, arr) => v !== n && arr.indexOf(v) === i);
      const distractors = shuffle(candidates).slice(0, 3).map(String);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.fp.gamesCount', { period: periodFor(b, w) }),
        answers,
        icon: '🎲',
        explanation: b.ctx.t('trivia.exp.fp.gamesCount', {
          games: n,
          period: periodFor(b, w),
        }),
      };
    },
  };
}

function chipsMovedFactory(w: WindowSpec): Template {
  return {
    id: `chipsMoved_${w.id}`,
    mode: 'group',
    category: 'profit_loss',
    group: `chipsMoved_${w.id}`,
    build: (b) => {
      const rows = w.filter(b);
      if (rows.length === 0) return null;
      // Zero-sum: sum of positive profits = chips moved across the table.
      const total = rows.reduce((a, r) => a + Math.max(0, r.profit), 0);
      if (total < 100) return null;
      const correct = formatCurrency(Math.round(total));
      const distractors = numericDistractors(total, 0.25);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.fp.chipsMoved', { period: periodFor(b, w) }),
        answers,
        icon: '💸',
        explanation: b.ctx.t('trivia.exp.fp.chipsMoved', {
          amount: correct,
          period: periodFor(b, w),
        }),
      };
    },
  };
}

function avgPlayersPerGameFactory(w: WindowSpec): Template {
  return {
    id: `avgPlayersPerGame_${w.id}`,
    mode: 'group',
    category: 'history',
    group: `avgPlayersPerGame_${w.id}`,
    build: (b) => {
      const rows = w.filter(b);
      if (rows.length === 0) return null;
      const byGame = new Map<string, number>();
      for (const r of rows) byGame.set(r.gameId, (byGame.get(r.gameId) ?? 0) + 1);
      if (byGame.size < 4) return null;
      const avg = [...byGame.values()].reduce((a, n) => a + n, 0) / byGame.size;
      const correct = (Math.round(avg * 10) / 10).toFixed(1);
      const candidates = [avg + 0.5, avg - 0.5, avg + 1.0, avg - 1.0, avg + 1.5]
        .map(v => Math.max(2, v))
        .filter((v, i, arr) => v.toFixed(1) !== correct && arr.findIndex(x => x.toFixed(1) === v.toFixed(1)) === i);
      const distractors = shuffle(candidates).slice(0, 3).map(v => (Math.round(v * 10) / 10).toFixed(1));
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.fp.avgPlayers', { period: periodFor(b, w) }),
        answers,
        icon: '👥',
        explanation: b.ctx.t('trivia.exp.fp.avgPlayers', {
          avg: correct,
          games: byGame.size,
          period: periodFor(b, w),
        }),
      };
    },
  };
}

function mostRebuysWindowFactory(w: WindowSpec): Template {
  return {
    id: `mostRebuys_${w.id}`,
    mode: 'group',
    category: 'profit_loss',
    group: `mostRebuys_${w.id}`,
    build: (b) => {
      // Rebuys only reliably tracked from REBUY_TRACKING_START.
      const rows = w.filter(b).filter(r => r.date >= REBUY_TRACKING_START);
      if (rows.length === 0) return null;
      const agg = aggregate(rows);
      const ranked = [...agg.entries()]
        .filter(([n, v]) => v.rebuys > 0 && b.eligibleNames.includes(n))
        .sort((a, z) => z[1].rebuys - a[1].rebuys || a[0].localeCompare(z[0]));
      if (ranked.length < 4) return null;
      const [name, v] = ranked[0];
      const answers = whoAnswers(name, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.fp.mostRebuys', { period: periodFor(b, w) }),
        answers,
        icon: '🪙',
        explanation: b.ctx.t('trivia.exp.fp.mostRebuys', {
          name,
          rebuys: v.rebuys,
          games: v.games,
          period: periodFor(b, w),
          ...gParams(b, name),
        }),
      };
    },
  };
}

// ─── Player factories ───────────────────────────────────────────
//
// One subject per session, picked by `pickSubject` (which already
// excludes the current user — they shouldn't be the answer to a
// "who" question about themselves).

function playerProfitFactory(w: WindowSpec): Template {
  return {
    id: `playerProfit_${w.id}`,
    mode: 'players',
    category: 'profit_loss',
    build: (b) => {
      const subject = pickSubject(b);
      if (!subject) return null;
      const rows = w.filter(b).filter(r => r.playerName === subject);
      if (rows.length < 3) return null;
      const total = rows.reduce((a, r) => a + r.profit, 0);
      const correct = formatCurrency(Math.round(total));
      const seed = Math.abs(total) > 10 ? total : (total >= 0 ? 100 : -100);
      const distractors = numericDistractors(seed, 0.4);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.fp.playerProfit', {
          name: subject, period: periodFor(b, w),
        }),
        answers,
        icon: '💵',
        explanation: b.ctx.t('trivia.exp.fp.playerProfit', {
          name: subject,
          profit: correct,
          games: rows.length,
          period: periodFor(b, w),
        }),
      };
    },
  };
}

function playerGamesFactory(w: WindowSpec): Template {
  return {
    id: `playerGames_${w.id}`,
    mode: 'players',
    category: 'history',
    build: (b) => {
      const subject = pickSubject(b);
      if (!subject) return null;
      const rows = w.filter(b).filter(r => r.playerName === subject);
      if (rows.length < 2) return null;
      const correct = String(rows.length);
      const candidates = [rows.length + 1, rows.length + 2, Math.max(1, rows.length - 1), rows.length + 3, Math.max(1, rows.length - 2)]
        .filter((v, i, arr) => v !== rows.length && arr.indexOf(v) === i);
      const distractors = shuffle(candidates).slice(0, 3).map(String);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.fp.playerGames', {
          name: subject, period: periodFor(b, w), ...gParams(b, subject),
        }),
        answers,
        icon: '🗓️',
        explanation: b.ctx.t('trivia.exp.fp.playerGames', {
          name: subject,
          games: rows.length,
          period: periodFor(b, w),
          ...gParams(b, subject),
        }),
      };
    },
  };
}

function playerFirstsFactory(w: WindowSpec): Template {
  return {
    id: `playerFirsts_${w.id}`,
    mode: 'players',
    category: 'wins',
    build: (b) => {
      const subject = pickSubject(b);
      if (!subject) return null;
      const rows = w.filter(b).filter(r => r.playerName === subject);
      if (rows.length < 3) return null;
      // Count games where subject was the chip leader.
      let firsts = 0;
      const seen = new Set<string>();
      for (const r of rows) {
        if (seen.has(r.gameId)) continue;
        seen.add(r.gameId);
        const arr = b.rowsByGame.get(r.gameId) ?? [];
        if (arr.length < 2) continue;
        const sorted = [...arr].sort((a, z) => z.profit - a.profit);
        if (sorted[0].playerName === subject && sorted[0].profit > 0) firsts++;
      }
      if (firsts < 1) return null;
      const correct = String(firsts);
      const candidates = [firsts + 1, firsts + 2, Math.max(0, firsts - 1), firsts + 3, Math.max(0, firsts - 2)]
        .filter((v, i, arr) => v !== firsts && arr.indexOf(v) === i);
      const distractors = shuffle(candidates).slice(0, 3).map(String);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.fp.playerFirsts', {
          name: subject, period: periodFor(b, w), ...gParams(b, subject),
        }),
        answers,
        icon: '🥇',
        explanation: b.ctx.t('trivia.exp.fp.playerFirsts', {
          name: subject,
          wins: firsts,
          games: rows.length,
          period: periodFor(b, w),
          ...gParams(b, subject),
        }),
      };
    },
  };
}

function playerPodiumsFactory(w: WindowSpec): Template {
  return {
    id: `playerPodiums_${w.id}`,
    mode: 'players',
    category: 'wins',
    build: (b) => {
      const subject = pickSubject(b);
      if (!subject) return null;
      const rows = w.filter(b).filter(r => r.playerName === subject);
      if (rows.length < 3) return null;
      let podiums = 0;
      const seen = new Set<string>();
      for (const r of rows) {
        if (seen.has(r.gameId)) continue;
        seen.add(r.gameId);
        const arr = b.rowsByGame.get(r.gameId) ?? [];
        if (arr.length < 3) continue;
        const sorted = [...arr].sort((a, z) => z.profit - a.profit);
        const idx = sorted.findIndex(x => x.playerName === subject);
        if (idx >= 0 && idx < 3) podiums++;
      }
      if (podiums < 1) return null;
      const correct = String(podiums);
      const candidates = [podiums + 1, podiums + 2, Math.max(0, podiums - 1), podiums + 3]
        .filter((v, i, arr) => v !== podiums && arr.indexOf(v) === i);
      const distractors = shuffle(candidates).slice(0, 3).map(String);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.fp.playerPodiums', {
          name: subject, period: periodFor(b, w), ...gParams(b, subject),
        }),
        answers,
        icon: '🏅',
        explanation: b.ctx.t('trivia.exp.fp.playerPodiums', {
          name: subject,
          podiums,
          games: rows.length,
          period: periodFor(b, w),
          ...gParams(b, subject),
        }),
      };
    },
  };
}

function playerBestNightFactory(w: WindowSpec): Template {
  return {
    id: `playerBestNight_${w.id}`,
    mode: 'players',
    category: 'profit_loss',
    build: (b) => {
      const subject = pickSubject(b);
      if (!subject) return null;
      const rows = w.filter(b).filter(r => r.playerName === subject);
      if (rows.length < 3) return null;
      const best = rows.reduce<PlayerGameRow | null>(
        (a, r) => (a == null || r.profit > a.profit ? r : a), null);
      if (!best || best.profit <= 0) return null;
      const correct = formatCurrency(Math.round(best.profit));
      const distractors = numericDistractors(best.profit);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.fp.playerBestNight', {
          name: subject, period: periodFor(b, w),
        }),
        answers,
        icon: '🏆',
        explanation: b.ctx.t('trivia.exp.fp.playerBestNight', {
          name: subject,
          profit: correct,
          date: formatExplanationDate(best.date, b.ctx.language),
        }),
      };
    },
  };
}

function playerWorstNightFactory(w: WindowSpec): Template {
  return {
    id: `playerWorstNight_${w.id}`,
    mode: 'players',
    category: 'profit_loss',
    build: (b) => {
      const subject = pickSubject(b);
      if (!subject) return null;
      const rows = w.filter(b).filter(r => r.playerName === subject);
      if (rows.length < 3) return null;
      const worst = rows.reduce<PlayerGameRow | null>(
        (a, r) => (a == null || r.profit < a.profit ? r : a), null);
      if (!worst || worst.profit >= 0) return null;
      const correct = formatCurrency(Math.round(worst.profit));
      const distractors = numericDistractors(worst.profit);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.fp.playerWorstNight', {
          name: subject, period: periodFor(b, w),
        }),
        answers,
        icon: '🥶',
        explanation: b.ctx.t('trivia.exp.fp.playerWorstNight', {
          name: subject,
          loss: correct,
          date: formatExplanationDate(worst.date, b.ctx.language),
        }),
      };
    },
  };
}

function playerAvgFactory(w: WindowSpec): Template {
  return {
    id: `playerAvg_${w.id}`,
    mode: 'players',
    category: 'profit_loss',
    build: (b) => {
      const subject = pickSubject(b);
      if (!subject) return null;
      const rows = w.filter(b).filter(r => r.playerName === subject);
      if (rows.length < 5) return null;
      const total = rows.reduce((a, r) => a + r.profit, 0);
      const avg = total / rows.length;
      const correct = formatCurrency(Math.round(avg));
      const seed = Math.abs(avg) > 5 ? avg : (avg >= 0 ? 25 : -25);
      const distractors = numericDistractors(seed, 0.5);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.fp.playerAvg', {
          name: subject, period: periodFor(b, w),
        }),
        answers,
        icon: '📊',
        explanation: b.ctx.t('trivia.exp.fp.playerAvg', {
          name: subject,
          avg: correct,
          games: rows.length,
          period: periodFor(b, w),
        }),
      };
    },
  };
}

function playerWinRateFactory(w: WindowSpec): Template {
  return {
    id: `playerWinRate_${w.id}`,
    mode: 'players',
    category: 'wins',
    build: (b) => {
      const subject = pickSubject(b);
      if (!subject) return null;
      const rows = w.filter(b).filter(r => r.playerName === subject);
      if (rows.length < 5) return null;
      let firsts = 0;
      const seen = new Set<string>();
      for (const r of rows) {
        if (seen.has(r.gameId)) continue;
        seen.add(r.gameId);
        const arr = b.rowsByGame.get(r.gameId) ?? [];
        if (arr.length < 2) continue;
        const sorted = [...arr].sort((a, z) => z.profit - a.profit);
        if (sorted[0].playerName === subject && sorted[0].profit > 0) firsts++;
      }
      const rate = (firsts / rows.length) * 100;
      const correct = `${Math.round(rate)}%`;
      const candidates = [
        Math.max(0, Math.round(rate - 10)),
        Math.max(0, Math.round(rate - 5)),
        Math.min(100, Math.round(rate + 5)),
        Math.min(100, Math.round(rate + 10)),
        Math.min(100, Math.round(rate + 15)),
      ].filter((v, i, arr) => `${v}%` !== correct && arr.indexOf(v) === i);
      const distractors = shuffle(candidates).slice(0, 3).map(v => `${v}%`);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.fp.playerWinRate', {
          name: subject, period: periodFor(b, w),
        }),
        answers,
        icon: '💎',
        explanation: b.ctx.t('trivia.exp.fp.playerWinRate', {
          name: subject,
          wins: firsts,
          games: rows.length,
          pct: Math.round(rate),
          period: periodFor(b, w),
        }),
      };
    },
  };
}

// ─── Hand-coded "creative" templates ────────────────────────────
//
// These don't fit the (stat × window) factory shape and need
// bespoke logic. Each is a single template, audited inline.

// "Most {N}th-place finishes" — surfaces players who consistently
// land in a specific rank (most common: 2nd-place specialists who
// rarely win but always cash). N ∈ {2, 3, 4}.
function makeRankSpecialist(rank: 2 | 3 | 4, icon: string, category: TriviaCategory): Template {
  return {
    id: `rankSpecialist_${rank}`,
    mode: 'group',
    category,
    build: (b) => {
      const counts = new Map<string, number>();
      for (const arr of b.rowsByGame.values()) {
        if (arr.length < rank + 1) continue;
        const sorted = [...arr].sort((a, z) => z.profit - a.profit);
        const target = sorted[rank - 1];
        counts.set(target.playerName, (counts.get(target.playerName) ?? 0) + 1);
      }
      const ranked = [...counts.entries()]
        .filter(([n]) => b.eligibleNames.includes(n))
        .sort((a, z) => z[1] - a[1] || a[0].localeCompare(z[0]));
      if (ranked.length < 4 || ranked[0][1] < 5) return null;
      const [name, count] = ranked[0];
      const answers = whoAnswers(name, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.fp.rankSpecialist', { rank }),
        answers,
        icon,
        explanation: b.ctx.t('trivia.exp.fp.rankSpecialist', {
          name, rank, count,
        }),
      };
    },
  };
}

// "Player's worst rank ever" / "Player's most common position".
const PLAYER_WORST_RANK_FACTORY: Template = {
  id: 'playerWorstRankEver',
  mode: 'players',
  category: 'history',
  build: (b) => {
    const subject = pickSubject(b);
    if (!subject) return null;
    const myRows = b.rowsByPlayer.get(subject) ?? [];
    if (myRows.length < 10) return null;
    let worstRank = 0;
    let worstDate = '';
    for (const r of myRows) {
      const arr = b.rowsByGame.get(r.gameId) ?? [];
      if (arr.length < 2) continue;
      const sorted = [...arr].sort((a, z) => z.profit - a.profit);
      const idx = sorted.findIndex(x => x.playerName === subject);
      if (idx + 1 > worstRank) {
        worstRank = idx + 1;
        worstDate = r.date;
      }
    }
    if (worstRank < 4) return null;
    const correct = String(worstRank);
    const candidates = [worstRank + 1, worstRank + 2, Math.max(2, worstRank - 1), worstRank - 2]
      .filter((v, i, arr) => v > 0 && v !== worstRank && arr.indexOf(v) === i);
    const distractors = shuffle(candidates).slice(0, 3).map(String);
    const answers = buildAnswers(correct, distractors);
    if (!answers) return null;
    return {
      text: b.ctx.t('trivia.q.fp.playerWorstRank', { name: subject }),
      answers,
      icon: '🪦',
      explanation: b.ctx.t('trivia.exp.fp.playerWorstRank', {
        name: subject,
        rank: worstRank,
        date: formatExplanationDate(worstDate, b.ctx.language),
        ...gParams(b, subject),
      }),
    };
  },
};

// "Player's best calendar month ever" — single calendar month
// where the player profited the most.
const PLAYER_BEST_MONTH_FACTORY: Template = {
  id: 'playerBestMonthEver',
  mode: 'players',
  category: 'profit_loss',
  build: (b) => {
    const subject = pickSubject(b);
    if (!subject) return null;
    const myRows = b.rowsByPlayer.get(subject) ?? [];
    if (myRows.length < 10) return null;
    const byMonth = new Map<string, { profit: number; games: number }>();
    for (const r of myRows) {
      const d = new Date(r.date);
      if (Number.isNaN(d.getTime())) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const cur = byMonth.get(key) ?? { profit: 0, games: 0 };
      cur.profit += r.profit;
      cur.games += 1;
      byMonth.set(key, cur);
    }
    const ranked = [...byMonth.entries()].sort((a, z) => z[1].profit - a[1].profit);
    if (ranked.length < 3 || ranked[0][1].profit <= 0) return null;
    const [bestKey, bestVal] = ranked[0];
    const correct = formatCurrency(Math.round(bestVal.profit));
    const distractors = numericDistractors(bestVal.profit, 0.4);
    const answers = buildAnswers(correct, distractors);
    if (!answers) return null;
    const [yearStr, monthStr] = bestKey.split('-');
    return {
      text: b.ctx.t('trivia.q.fp.playerBestMonth', {
        name: subject, ...gParams(b, subject),
      }),
      answers,
      icon: '📆',
      explanation: b.ctx.t('trivia.exp.fp.playerBestMonth', {
        name: subject,
        profit: correct,
        games: bestVal.games,
        month: monthStr,
        year: yearStr,
        ...gParams(b, subject),
      }),
    };
  },
};

// "Player's biggest single comeback" — biggest game-over-game
// jump in profit. Captures dramatic recovery moments.
const PLAYER_BIGGEST_COMEBACK_FACTORY: Template = {
  id: 'playerBiggestComeback',
  mode: 'players',
  category: 'profit_loss',
  build: (b) => {
    const subject = pickSubject(b);
    if (!subject) return null;
    const myRows = (b.rowsByPlayer.get(subject) ?? [])
      .slice()
      .sort((a, z) => a.date.localeCompare(z.date));
    if (myRows.length < 5) return null;
    let bestSwing = 0;
    let bestPrev: PlayerGameRow | null = null;
    let bestNext: PlayerGameRow | null = null;
    for (let i = 1; i < myRows.length; i++) {
      const swing = myRows[i].profit - myRows[i - 1].profit;
      if (swing > bestSwing) {
        bestSwing = swing;
        bestPrev = myRows[i - 1];
        bestNext = myRows[i];
      }
    }
    if (bestSwing < 50 || !bestPrev || !bestNext) return null;
    const correct = formatCurrency(Math.round(bestSwing));
    const distractors = numericDistractors(bestSwing, 0.4);
    const answers = buildAnswers(correct, distractors);
    if (!answers) return null;
    return {
      text: b.ctx.t('trivia.q.fp.playerBiggestComeback', { name: subject }),
      answers,
      icon: '🚀',
      explanation: b.ctx.t('trivia.exp.fp.playerBiggestComeback', {
        name: subject,
        swing: correct,
        from: formatCurrency(Math.round(bestPrev.profit)),
        to: formatCurrency(Math.round(bestNext.profit)),
        date: formatExplanationDate(bestNext.date, b.ctx.language),
        ...gParams(b, subject),
      }),
    };
  },
};

// ─── Group: largest game (by player count) per window ───────────
function largestGameInWindowFactory(w: WindowSpec): Template {
  return {
    id: `largestGame_${w.id}`,
    mode: 'group',
    category: 'history',
    build: (b) => {
      const rows = w.filter(b);
      if (rows.length === 0) return null;
      const byGame = new Map<string, { count: number; date: string }>();
      for (const r of rows) {
        const cur = byGame.get(r.gameId) ?? { count: 0, date: r.date };
        cur.count += 1;
        byGame.set(r.gameId, cur);
      }
      const ranked = [...byGame.values()].sort((a, z) => z.count - a.count);
      if (ranked.length < 3 || ranked[0].count < 4) return null;
      const top = ranked[0];
      const correct = String(top.count);
      const candidates = [top.count - 1, top.count - 2, top.count + 1, Math.max(2, top.count - 3)]
        .filter((v, i, arr) => v >= 2 && v !== top.count && arr.indexOf(v) === i);
      const distractors = shuffle(candidates).slice(0, 3).map(String);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.fp.largestGame', { period: periodFor(b, w) }),
        answers,
        icon: '👥',
        explanation: b.ctx.t('trivia.exp.fp.largestGame', {
          players: top.count,
          date: formatExplanationDate(top.date, b.ctx.language),
          period: periodFor(b, w),
        }),
      };
    },
  };
}

// ─── Build the catalogue ────────────────────────────────────────
//
// Each cross-product is generated here, then the whole array is
// exported. Adding a new factory above means adding one line below
// — no copy-paste, no dozens of duplicate `build` functions.

const GROUP_FACTORIES = [
  topProfitFactory,
  biggestNetLoserFactory,
  mostGamesFactory,
  mostFirstPlacesFactory,
  mostPodiumsFactory,
  bestAvgFactory,
  worstAvgFactory,
  biggestSingleWinFactory,
  biggestSingleLossFactory,
  biggestSingleWinPlayerFactory,
  biggestSingleLossPlayerFactory,
  gamesCountFactory,
  chipsMovedFactory,
  avgPlayersPerGameFactory,
  mostRebuysWindowFactory,
  largestGameInWindowFactory,
];

const PLAYER_FACTORIES = [
  playerProfitFactory,
  playerGamesFactory,
  playerFirstsFactory,
  playerPodiumsFactory,
  playerBestNightFactory,
  playerWorstNightFactory,
  playerAvgFactory,
  playerWinRateFactory,
];

// `as const` would require all factories to share the exact same
// return type — they do, but TS doesn't infer that from an array
// of differently-named functions. Plain `Template[]` is fine.
const FACTORY_TEMPLATES: Template[] = [];
for (const f of GROUP_FACTORIES) {
  for (const w of WINDOWS) {
    FACTORY_TEMPLATES.push(f(w));
  }
}
for (const f of PLAYER_FACTORIES) {
  // Player factories use shorter window list — last90Days /
  // last10Games are too noisy for a single player (they often
  // have 0-2 games in those windows, which fails the data floor).
  for (const w of WINDOWS.filter(x => x.id !== 'last10Games' && x.id !== 'last90Days')) {
    FACTORY_TEMPLATES.push(f(w));
  }
}

// Hand-coded specialty templates appended last.
const SPECIALTY_TEMPLATES: Template[] = [
  makeRankSpecialist(2, '🥈', 'wins'),
  makeRankSpecialist(3, '🥉', 'wins'),
  makeRankSpecialist(4, '4️⃣', 'history'),
  PLAYER_WORST_RANK_FACTORY,
  PLAYER_BEST_MONTH_FACTORY,
  PLAYER_BIGGEST_COMEBACK_FACTORY,
];

export const FACTORY_GENERATED_TEMPLATES: Template[] = [
  ...FACTORY_TEMPLATES,
  ...SPECIALTY_TEMPLATES,
];

// Sanity export for any future debugging — lets tooling assert
// the catalogue size without importing the whole template list.
export const FACTORY_TEMPLATE_COUNT = FACTORY_GENERATED_TEMPLATES.length;

