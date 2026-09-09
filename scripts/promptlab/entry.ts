// Prompt lab entry. Builds PlayerForecastData / GameNightSummaryPayload the
// same way the screens do, then drives the REAL generators in geminiAI.ts so
// what we capture is exactly what production sends.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import {
  generateAIForecasts,
  generateGameNightSummary,
  buildLocationInsights,
  type PlayerForecastData,
  type GlobalRankingContext,
} from '../../src/utils/geminiAI';
import { getComboHistory, buildComboHistoryText } from '../../src/utils/comboHistory';
import { formatHebrewHalf } from '../../src/utils/calculations';
import { captures, setCaptureLabel, isLive } from './stubs/apiProxy';

const fixture = JSON.parse(readFileSync('scripts/promptlab/fixture.json', 'utf8'));
const OUT = 'scripts/promptlab/out';
mkdirSync(OUT, { recursive: true });

type Row = { gameId: string; playerId: string; playerName: string; profit: number; rebuys: number };
const games: { id: string; date: string; location?: string }[] = fixture.games;
const rows: Row[] = fixture.gamePlayers;
const gameById = new Map(games.map(g => [g.id, g]));
const locById = new Map(games.map(g => [g.id, g.location]));

const fmt = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};

// Mirrors getPlayerStats in storage.ts (all-time, unfiltered).
function statsFor(playerId: string) {
  const mine = rows
    .filter(r => r.playerId === playerId && gameById.has(r.gameId))
    .sort((a, b) => +new Date(gameById.get(a.gameId)!.date) - +new Date(gameById.get(b.gameId)!.date));
  const profits = mine.map(m => m.profit);
  const gamesPlayed = mine.length;
  const totalProfit = profits.reduce((s, p) => s + p, 0);
  const winCount = profits.filter(p => p > 0).length;
  const lossCount = profits.filter(p => p < 0).length;

  let currentStreak = 0;
  for (let i = mine.length - 1; i >= 0; i--) {
    const p = mine[i].profit;
    if (p > 0) { if (currentStreak >= 0) currentStreak++; else break; }
    else if (p < 0) { if (currentStreak <= 0) currentStreak--; else break; }
    else break;
  }

  const history = mine.slice().reverse().map(m => ({
    profit: m.profit,
    date: fmt(gameById.get(m.gameId)!.date),
    gameId: m.gameId,
    location: locById.get(m.gameId),
    rebuys: m.rebuys,
    iso: gameById.get(m.gameId)!.date,
  }));

  return {
    gamesPlayed,
    totalProfit,
    avgProfit: gamesPlayed ? totalProfit / gamesPlayed : 0,
    winCount,
    lossCount,
    winPercentage: gamesPlayed ? (winCount / gamesPlayed) * 100 : 0,
    currentStreak,
    bestWin: profits.length ? Math.max(...profits, 0) : 0,
    worstLoss: profits.length ? Math.min(...profits, 0) : 0,
    history,
  };
}

const NOW = new Date();
const nameToId = new Map<string, string>(fixture.players.map((p: any) => [p.name, p.id]));

function forecastDataFor(names: string[]): PlayerForecastData[] {
  return names.map(name => {
    const id = nameToId.get(name)!;
    const s = statsFor(id);
    const last = s.history[0];
    const daysSince = last ? Math.floor((+NOW - +new Date(last.iso)) / 86400000) : 999;
    return {
      name,
      isFemale: fixture.players.find((p: any) => p.id === id)?.gender === 'female',
      gamesPlayed: s.gamesPlayed,
      totalProfit: s.totalProfit,
      avgProfit: s.avgProfit,
      winCount: s.winCount,
      lossCount: s.lossCount,
      winPercentage: s.winPercentage,
      currentStreak: s.currentStreak,
      bestWin: s.bestWin,
      worstLoss: s.worstLoss,
      gameHistory: s.history.map(h => ({ profit: h.profit, date: h.date, gameId: h.gameId, location: h.location })),
      daysSinceLastGame: daysSince,
      isActive: daysSince <= 60,
    };
  });
}

// Mirrors calculateGlobalRankings: active = played >= 33% of games in scope.
function rankingsFor(filter: (iso: string) => boolean) {
  const scope = games.filter(g => filter(g.date));
  const ids = new Set(scope.map(g => g.id));
  const agg = new Map<string, { name: string; profit: number; gamesPlayed: number }>();
  for (const r of rows) {
    if (!ids.has(r.gameId)) continue;
    const cur = agg.get(r.playerId) || { name: r.playerName, profit: 0, gamesPlayed: 0 };
    cur.profit += r.profit;
    cur.gamesPlayed += 1;
    agg.set(r.playerId, cur);
  }
  const threshold = Math.max(1, Math.floor(scope.length * 0.33));
  const ranked = [...agg.values()]
    .filter(a => a.gamesPlayed >= threshold)
    .sort((a, b) => b.profit - a.profit)
    .map((a, i) => ({ name: a.name, rank: i + 1, profit: Math.round(a.profit), gamesPlayed: a.gamesPlayed }));
  return { totalActivePlayers: ranked.length, totalGames: scope.length, threshold, rankings: ranked };
}

const year = NOW.getFullYear();
const half: 1 | 2 = NOW.getMonth() < 6 ? 1 : 2;
const globalRankings: GlobalRankingContext = {
  allTime: rankingsFor(() => true),
  currentYear: { year, ...rankingsFor(iso => new Date(iso).getFullYear() === year) },
  currentHalf: {
    half, year,
    ...rankingsFor(iso => {
      const d = new Date(iso);
      return d.getFullYear() === year && (half === 1 ? d.getMonth() < 6 : d.getMonth() >= 6);
    }),
  },
};

const noMarkers = {
  isFirstGameOfMonth: false, isLastGameOfMonth: false,
  isFirstGameOfHalf: false, isLastGameOfHalf: false,
  isFirstGameOfYear: false, isLastGameOfYear: false,
  monthName: 'ספטמבר', halfLabel: formatHebrewHalf(half, year), year,
};

// ── Scenarios ────────────────────────────────────────────────────────────
// Rosters lifted from real recent nights so every card has true history.
const rosterOf = (gameId: string) => rows.filter(r => r.gameId === gameId).map(r => r.playerName);

const SCENARIOS: { id: string; label: string; names: string[]; location?: string; markers?: any }[] = [
  {
    id: 'S1-regulars',
    label: 'Standard 8-player night at אייל (the real 03/09 roster)',
    names: rosterOf('5169e81d-ea09-4eca-a915-fe616f30ef26'),
    location: 'אייל',
  },
  {
    id: 'S2-small',
    label: 'Small 5-player night, no location set',
    names: ['ליאור', 'אייל', 'סגל', 'ליכטר', 'תומר'],
  },
  {
    id: 'S3-newcomer',
    label: 'Regulars plus a true newcomer with zero history',
    names: ['ליאור', 'אייל', 'סגל', 'ליכטר', 'חרדון', 'רועי דויד'],
    location: 'ליכטר',
  },
  {
    id: 'S4-periodedge',
    label: 'Last game of the half — triggers the period paragraph',
    names: rosterOf('936d472c-2f22-484e-a4ed-87af9ba19c74'),
    location: 'סגל',
    markers: { ...noMarkers, isLastGameOfHalf: true, isLastGameOfMonth: true },
  },
  {
    id: 'S5-rusty',
    label: 'Mix of hot regulars and long-absent players',
    names: ['ליאור', 'ליכטר', 'נועם', 'סמי', 'מאור בולו', 'פיליפ', 'אורן'],
    location: 'ליאור',
  },
];

async function runForecasts() {
  for (const sc of SCENARIOS) {
    const names = [...new Set(sc.names)].filter(n => nameToId.has(n));
    const players = forecastDataFor(names);
    const combo = getComboHistory(names.map(n => nameToId.get(n)!));
    const comboText = combo.totalGamesWithCombo > 1 ? buildComboHistoryText(combo) : undefined;
    // Location insights are derived inside generateAIForecasts; passing them
    // in here as well would duplicate the whole 🏠 block in the prompt.
    setCaptureLabel(sc.id);
    console.log(`\n▶ ${sc.id}: ${sc.label} (${players.length} players)`);
    try {
      const res = await generateAIForecasts(
        players, globalRankings, sc.markers || noMarkers, sc.location, comboText,
      );
      writeFileSync(`${OUT}/${sc.id}.result.json`, JSON.stringify(res, null, 2), 'utf8');
      console.log(`  → ${res.length} player entries`);
    } catch (e) {
      console.log(`  ! ${String(e).slice(0, 200)}`);
    }
  }
}

async function runSummaries() {
  // Replay real completed nights as if they had just finished.
  const targets = [
    { id: '5169e81d-ea09-4eca-a915-fe616f30ef26', label: 'S6-summary-0309' },
    { id: '53af22c5-3151-44d9-a012-45b02a225fc0', label: 'S7-summary-1508' },
  ];
  for (const t of targets) {
    const g = gameById.get(t.id)!;
    const mine = rows.filter(r => r.gameId === t.id).sort((a, b) => b.profit - a.profit);
    const tonight = mine.map((m, i) => ({
      name: m.playerName, profit: Math.round(m.profit), rebuys: m.rebuys, rank: i + 1,
    }));
    const totalRebuys = mine.reduce((s, m) => s + m.rebuys, 0);
    const gDate = new Date(g.date);
    const gHalf: 1 | 2 = gDate.getMonth() < 6 ? 1 : 2;
    const periodLabel = formatHebrewHalf(gHalf, gDate.getFullYear());

    const inPeriod = games.filter(x => {
      const d = new Date(x.date);
      return d.getFullYear() === gDate.getFullYear()
        && (gHalf === 1 ? d.getMonth() < 6 : d.getMonth() >= 6)
        && d <= gDate;
    });
    const periodIds = new Set(inPeriod.map(x => x.id));
    const agg = new Map<string, { name: string; profit: number; games: number; wins: number }>();
    for (const r of rows) {
      if (!periodIds.has(r.gameId)) continue;
      const cur = agg.get(r.playerId) || { name: r.playerName, profit: 0, games: 0, wins: 0 };
      cur.profit += r.profit; cur.games += 1; if (r.profit > 0) cur.wins += 1;
      agg.set(r.playerId, cur);
    }
    const standings = [...agg.entries()]
      .sort((a, b) => b[1].profit - a[1].profit)
      .map(([pid, a], i) => ({
        name: a.name, periodRank: i + 1, totalProfit: Math.round(a.profit),
        gamesPlayed: a.games, winPct: (a.wins / a.games) * 100,
        currentStreak: statsFor(pid).currentStreak,
      }))
      .filter((s, i) => i < 5 || tonight.some(t2 => t2.name === s.name));

    setCaptureLabel(t.label);
    console.log(`\n▶ ${t.label}: replaying ${fmt(g.date)} @ ${g.location || '—'}`);
    try {
      const res = await generateGameNightSummary({
        tonight, totalRebuys, totalPot: Math.round(totalRebuys * fixture.settings.rebuyValue),
        periodLabel, periodStandings: standings,
        recordsBroken: [], notableStreaks: [], upsets: [], milestones: [],
        welcomeBacks: [], rankingShifts: [],
        gameNumberInPeriod: inPeriod.length,
        location: g.location,
      } as any);
      writeFileSync(`${OUT}/${t.label}.result.json`, JSON.stringify(res, null, 2), 'utf8');
      console.log('  → summary generated');
    } catch (e) {
      console.log(`  ! ${String(e).slice(0, 200)}`);
    }
  }
}

(async () => {
  console.log(isLive() ? '🔑 LIVE mode (GEMINI_API_KEY set)' : '📝 DRY mode — capturing prompts only');
  await runForecasts();
  await runSummaries();

  // One file per call. A scenario can emit several (model fallback, plus the
  // retry pass for players the first response skipped), so index them or the
  // retry silently overwrites the main prompt.
  const seen = new Map<string, number>();
  captures.forEach(c => {
    const n = (seen.get(c.label) || 0) + 1;
    seen.set(c.label, n);
    const base = `${OUT}/${c.label}.call${n}.${c.model}`;
    writeFileSync(`${base}.prompt.txt`, c.prompt, 'utf8');
    if (c.response) writeFileSync(`${base}.raw.txt`, c.response, 'utf8');
  });
  writeFileSync(`${OUT}/index.json`, JSON.stringify(
    captures.map(c => ({
      label: c.label, model: c.model,
      promptChars: c.prompt.length,
      responseChars: c.response?.length || 0,
      error: c.error,
    })), null, 2), 'utf8');
  console.log(`\n✅ ${captures.length} captures written to ${OUT}`);
})();
