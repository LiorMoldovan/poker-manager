import { getAllPlayers, getAllGames, getPlayerStats, saveGraphInsights, saveChronicleProfiles } from '../database/storage';
import { generateGraphInsights, generatePlayerChronicle, ChroniclePlayerData, getGeminiApiKey, getLastUsedModel, getModelDisplayName } from './geminiAI';
import { generateMilestones, adaptPlayerStats, MilestoneOptions } from './milestones';
import { formatHebrewHalf } from './calculations';
import { PlayerStats } from '../types';

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

function getCurrentHalfPeriod(): { key: string; label: string; dateFilter: { start: Date; end: Date } } {
  const now = new Date();
  const year = now.getFullYear();
  const half = now.getMonth() < 6 ? 1 : 2;
  return {
    key: `H${half}-${year}`,
    label: half === 1 ? `H1 ${year}` : `H2 ${year}`,
    dateFilter: half === 1
      ? { start: new Date(year, 0, 1), end: new Date(year, 5, 30, 23, 59, 59) }
      : { start: new Date(year, 6, 1), end: new Date(year, 11, 31, 23, 59, 59) },
  };
}

function getSimpleArchetype(p: PlayerStats): string {
  if (p.gamesPlayed <= 2) return 'החדש';
  if (p.avgProfit > 0 && p.winPercentage >= 55) return 'הדומיננטי';
  if (p.avgProfit > 0 && p.winPercentage < 50) return 'הצלף';
  if (p.avgProfit > 0) return 'הכריש';
  if (Math.abs(p.currentStreak) >= 3) return 'ברצף';
  if (p.biggestWin + Math.abs(p.biggestLoss) > 500) return 'רכבת הרים';
  if (p.avgProfit < -20) return 'הלוחם';
  return 'הסלע';
}

async function regenerateGraphInsights(periodKey: string, periodLabel: string, dateFilter: { start: Date; end: Date }): Promise<boolean> {
  const players = getAllPlayers();
  const allGames = getAllGames().filter(g => g.status === 'completed');
  const filteredGames = allGames.filter(g => {
    const d = new Date(g.date);
    return d >= dateFilter.start && d <= dateFilter.end;
  });
  if (filteredGames.length === 0) return false;

  const stats = getPlayerStats(dateFilter)
    .filter(s => {
      const p = players.find(pl => pl.id === s.playerId);
      return p && p.type === 'permanent' && s.gamesPlayed > 0;
    })
    .sort((a, b) => b.totalProfit - a.totalProfit);
  if (stats.length === 0) return false;

  const now = new Date();
  const currentHalf = now.getMonth() < 6 ? 1 : 2;
  const isCurrentHalf = dateFilter.start.getFullYear() === now.getFullYear();
  const isEarlyPeriod = isCurrentHalf && currentHalf <= 2 && filteredGames.length <= 5;

  const text = await generateGraphInsights(stats, periodLabel, filteredGames.length, isEarlyPeriod);
  const modelDisplay = getModelDisplayName(getLastUsedModel());
  saveGraphInsights(periodKey, text, modelDisplay);
  return true;
}

async function regenerateChronicles(periodKey: string, periodLabel: string, dateFilter: { start: Date; end: Date }): Promise<boolean> {
  const allGames = getAllGames().filter(g => g.status === 'completed');
  const filteredGames = allGames.filter(g => {
    const d = new Date(g.date);
    return d >= dateFilter.start && d <= dateFilter.end;
  });
  if (filteredGames.length === 0) return false;

  const stats = getPlayerStats(dateFilter)
    .filter(s => s.gamesPlayed > 0)
    .sort((a, b) => b.totalProfit - a.totalProfit);
  if (stats.length === 0) return false;

  const allTimeStats = getPlayerStats()
    .filter(s => s.gamesPlayed > 0)
    .sort((a, b) => b.totalProfit - a.totalProfit);

  const latestGameDate = filteredGames.reduce((latest, g) => {
    const d = new Date(g.date);
    return d > latest ? d : latest;
  }, new Date(0));

  const payloadPlayers: ChroniclePlayerData[] = stats.map((p, idx) => {
    const lg = p.lastGameResults || [];
    const rec = lg.slice(0, Math.min(6, lg.length));
    const recForm = rec.map(r => r.profit > 0 ? 'W' : r.profit < 0 ? 'L' : 'D').join('');
    const pLastDate = lg.length > 0 ? lg[0].date : null;
    const daysSince = pLastDate ? Math.floor((latestGameDate.getTime() - new Date(pLastDate).getTime()) / 86400000) : 999;
    const atIdx = allTimeStats.findIndex(a => a.playerId === p.playerId);

    return {
      playerId: p.playerId,
      name: p.playerName,
      periodRank: idx + 1,
      totalProfit: p.totalProfit,
      gamesPlayed: p.gamesPlayed,
      winPercentage: p.winPercentage,
      avgProfit: p.avgProfit,
      currentStreak: p.currentStreak,
      biggestWin: p.biggestWin,
      biggestLoss: p.biggestLoss,
      avgRebuysPerGame: p.avgRebuysPerGame ?? null,
      lastGameDate: pLastDate,
      daysSinceLastGame: daysSince,
      recentForm: recForm || 'N/A',
      archetype: getSimpleArchetype(p),
      allTimeRank: atIdx >= 0 ? atIdx + 1 : null,
      allTimeGames: atIdx >= 0 ? allTimeStats[atIdx].gamesPlayed : null,
      allTimeProfit: atIdx >= 0 ? allTimeStats[atIdx].totalProfit : null,
    };
  });

  const milestonePlayers = stats.map(adaptPlayerStats);
  const milestoneOpts: MilestoneOptions = {
    mode: 'period',
    periodLabel: formatHebrewHalf(dateFilter.start.getMonth() < 6 ? 1 : 2, dateFilter.start.getFullYear()),
    isHistorical: false,
    isLowData: filteredGames.length <= 3,
    overallRankMap: new Map(allTimeStats.map((s, i) => [s.playerId, i + 1])),
    uniqueGamesInPeriod: filteredGames.length,
  };
  const milestoneItems = generateMilestones(milestonePlayers, milestoneOpts);
  const milestones = milestoneItems.map(m => `${m.emoji} ${m.title}: ${m.description}`);

  const result = await generatePlayerChronicle({
    players: payloadPlayers,
    periodLabel,
    totalPeriodGames: filteredGames.length,
    isEarlyPeriod: filteredGames.length <= 3,
    milestones,
  });

  const modelDisplay = getModelDisplayName(result.model);
  saveChronicleProfiles(periodKey, result.profiles, modelDisplay);
  return true;
}

/**
 * Silently regenerates graph insights and player chronicles in the background.
 * Runs fire-and-forget — failures are logged but never surface to the user.
 * Staggers API calls to avoid rate limits.
 */
export async function regenerateAIInBackground(): Promise<void> {
  if (!getGeminiApiKey()) return;

  const period = getCurrentHalfPeriod();

  try {
    await delay(3000);
    const insightsOk = await regenerateGraphInsights(period.key, period.label, period.dateFilter);
    if (insightsOk) console.log(`Background: graph insights regenerated for ${period.key}`);
  } catch (e) {
    console.warn('Background graph insights failed:', e);
  }

  try {
    await delay(5000);
    const chronicleLabel = formatHebrewHalf(
      period.dateFilter.start.getMonth() < 6 ? 1 : 2,
      period.dateFilter.start.getFullYear()
    );
    const chroniclesOk = await regenerateChronicles(period.key, chronicleLabel, period.dateFilter);
    if (chroniclesOk) console.log(`Background: chronicles regenerated for ${period.key}`);
  } catch (e) {
    console.warn('Background chronicles failed:', e);
  }

}
