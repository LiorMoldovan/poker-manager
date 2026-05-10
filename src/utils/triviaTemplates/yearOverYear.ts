// Year-over-year templates.
//
// Compares this year vs last year for both players and the group.
// Requires at least 3 games per player in both years to qualify.

import {
  buildAnswers, numericDistractors, whoAnswers, yearDistractors,
  type BuildBundle, type Template, type PlayerGameRow,
} from '../triviaGenerator';
import { formatCurrency } from '../calculations';

const MIN_GAMES_EACH_YEAR = 3;

interface YoYStat {
  name: string;
  thisYearProfit: number;
  lastYearProfit: number;
  thisYearGames: number;
  lastYearGames: number;
  thisYearFirsts: number;
  lastYearFirsts: number;
  delta: number;
}

function computeYoY(b: BuildBundle): YoYStat[] {
  const ty = b.currentYear;
  const ly = b.currentYear - 1;
  const out = new Map<string, YoYStat>();
  // Aggregate profit + games per player per year.
  for (const r of b.rows) {
    const y = new Date(r.date).getFullYear();
    if (y !== ty && y !== ly) continue;
    if (!b.eligibleNames.includes(r.playerName)) continue;
    let cur = out.get(r.playerName);
    if (!cur) {
      cur = { name: r.playerName, thisYearProfit: 0, lastYearProfit: 0,
        thisYearGames: 0, lastYearGames: 0, thisYearFirsts: 0, lastYearFirsts: 0, delta: 0 };
      out.set(r.playerName, cur);
    }
    if (y === ty) { cur.thisYearProfit += r.profit; cur.thisYearGames += 1; }
    else          { cur.lastYearProfit += r.profit; cur.lastYearGames += 1; }
  }
  // Tally 1st-place finishes per year (top profit per game).
  const seen = new Set<string>();
  for (const r of b.rows) {
    if (seen.has(r.gameId)) continue;
    seen.add(r.gameId);
    const y = new Date(r.date).getFullYear();
    if (y !== ty && y !== ly) continue;
    const arr = b.rowsByGame.get(r.gameId) ?? [];
    if (arr.length < 2) continue;
    const sorted = [...arr].sort((a, z) => z.profit - a.profit);
    if (sorted[0].profit <= 0) continue;
    const winnerName = sorted[0].playerName;
    const cur = out.get(winnerName);
    if (!cur) continue;
    if (y === ty) cur.thisYearFirsts += 1;
    else          cur.lastYearFirsts += 1;
  }
  // Compute delta (this year minus last year) and filter by min games.
  return [...out.values()]
    .filter(s => s.thisYearGames >= MIN_GAMES_EACH_YEAR && s.lastYearGames >= MIN_GAMES_EACH_YEAR)
    .map(s => ({ ...s, delta: s.thisYearProfit - s.lastYearProfit }));
}

export const YEAR_OVER_YEAR_TEMPLATES: Template[] = [
  // Biggest improver (highest YoY profit gain).
  {
    id: 'biggestImproverYoY',
    mode: 'group',
    category: 'profit_loss',
    build: (b) => {
      const ranked = computeYoY(b)
        .sort((a, z) => z.delta - a.delta || a.name.localeCompare(z.name));
      if (ranked.length < 4 || ranked[0].delta <= 0) return null;
      const subject = ranked[0];
      const answers = whoAnswers(subject.name, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.biggestImproverYoY', {
          ty: b.currentYear, ly: b.currentYear - 1,
        }),
        answers,
        icon: '📈',
        explanation: b.ctx.t('trivia.exp.biggestImproverYoY', {
          name: subject.name,
          delta: formatCurrency(Math.round(subject.delta)),
          ty: b.currentYear,
          ly: b.currentYear - 1,
        }),
      };
    },
  },

  // Biggest decliner (largest YoY profit drop).
  {
    id: 'biggestDeclinerYoY',
    mode: 'group',
    category: 'profit_loss',
    build: (b) => {
      const ranked = computeYoY(b)
        .sort((a, z) => a.delta - z.delta || a.name.localeCompare(z.name));
      if (ranked.length < 4 || ranked[0].delta >= 0) return null;
      const subject = ranked[0];
      const answers = whoAnswers(subject.name, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.biggestDeclinerYoY', {
          ty: b.currentYear, ly: b.currentYear - 1,
        }),
        answers,
        icon: '📉',
        explanation: b.ctx.t('trivia.exp.biggestDeclinerYoY', {
          name: subject.name,
          delta: formatCurrency(Math.round(Math.abs(subject.delta))),
          ty: b.currentYear,
          ly: b.currentYear - 1,
        }),
      };
    },
  },

  // Biggest YoY improvement in 1st-place count.
  {
    id: 'biggestFirstPlaceImproverYoY',
    mode: 'group',
    category: 'wins',
    build: (b) => {
      const ranked = computeYoY(b)
        .map(s => ({ ...s, fpDelta: s.thisYearFirsts - s.lastYearFirsts }))
        .sort((a, z) => z.fpDelta - a.fpDelta || a.name.localeCompare(z.name));
      if (ranked.length < 4 || ranked[0].fpDelta < 1) return null;
      const subject = ranked[0];
      const answers = whoAnswers(subject.name, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.biggestFirstPlaceImproverYoY', {
          ty: b.currentYear, ly: b.currentYear - 1,
        }),
        answers,
        icon: '🥇',
        explanation: b.ctx.t('trivia.exp.biggestFirstPlaceImproverYoY', {
          name: subject.name,
          ty: b.currentYear,
          ly: b.currentYear - 1,
          tyFirsts: subject.thisYearFirsts,
          lyFirsts: subject.lastYearFirsts,
        }),
      };
    },
  },

  // Most consistent player YoY — smallest absolute change in
  // total profit between this year and last year.
  {
    id: 'mostConsistentYoY',
    mode: 'group',
    category: 'profit_loss',
    build: (b) => {
      const ranked = computeYoY(b)
        .sort((a, z) => Math.abs(a.delta) - Math.abs(z.delta) || a.name.localeCompare(z.name));
      if (ranked.length < 4) return null;
      const subject = ranked[0];
      const answers = whoAnswers(subject.name, b);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.mostConsistentYoY', {
          ty: b.currentYear, ly: b.currentYear - 1,
        }),
        answers,
        icon: '⚖️',
        explanation: b.ctx.t('trivia.exp.mostConsistentYoY', {
          name: subject.name,
          ty: b.currentYear,
          ly: b.currentYear - 1,
          tyProfit: formatCurrency(Math.round(subject.thisYearProfit)),
          lyProfit: formatCurrency(Math.round(subject.lastYearProfit)),
        }),
      };
    },
  },

  // Best year for the GROUP in chips moved.
  {
    id: 'bestYearChips',
    mode: 'group',
    category: 'history',
    build: (b) => {
      const byYear = new Map<number, number>();
      for (const r of b.rows) {
        const y = new Date(r.date).getFullYear();
        if (!Number.isFinite(y)) continue;
        byYear.set(y, (byYear.get(y) ?? 0) + Math.max(0, r.profit));
      }
      if (byYear.size < 2) return null;
      const ranked = [...byYear.entries()].sort((a, z) => z[1] - a[1] || z[0] - a[0]);
      const [year, chips] = ranked[0];
      if (chips < 1000) return null;
      const distractors = yearDistractors(year, b.currentYear);
      if (distractors.length < 3) return null;
      const answers = buildAnswers(String(year), distractors);
      if (!answers) return null;
      return {
        text: b.ctx.t('trivia.q.bestYearChips'),
        answers,
        icon: '💰',
        explanation: b.ctx.t('trivia.exp.bestYearChips', {
          year,
          amount: formatCurrency(Math.round(chips)),
        }),
      };
    },
  },

  // What's the YoY group total profit volume change?
  // (Numeric question about the group itself.)
  {
    id: 'groupChipsMovedDeltaYoY',
    mode: 'group',
    category: 'history',
    build: (b) => {
      const ty = b.currentYear;
      const ly = b.currentYear - 1;
      const tyChips = b.rows
        .filter(r => new Date(r.date).getFullYear() === ty)
        .reduce((a, r) => a + Math.max(0, r.profit), 0);
      const lyChips = b.rows
        .filter((r: PlayerGameRow) => new Date(r.date).getFullYear() === ly)
        .reduce((a, r) => a + Math.max(0, r.profit), 0);
      if (tyChips < 100 || lyChips < 100) return null;
      const delta = Math.abs(tyChips - lyChips);
      const correct = formatCurrency(Math.round(delta));
      const distractors = numericDistractors(delta, 0.4);
      const answers = buildAnswers(correct, distractors);
      if (!answers) return null;
      const direction = tyChips > lyChips
        ? b.ctx.t('trivia.exp.groupChipsMovedDirectionUp')
        : b.ctx.t('trivia.exp.groupChipsMovedDirectionDown');
      return {
        text: b.ctx.t('trivia.q.groupChipsMovedDeltaYoY', { ty, ly }),
        answers,
        icon: '📊',
        explanation: b.ctx.t('trivia.exp.groupChipsMovedDeltaYoY', {
          delta: correct,
          direction,
          ty,
          ly,
          tyAmount: formatCurrency(Math.round(tyChips)),
          lyAmount: formatCurrency(Math.round(lyChips)),
        }),
      };
    },
  },
];
