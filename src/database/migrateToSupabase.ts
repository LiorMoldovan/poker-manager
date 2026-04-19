import { supabase } from './supabaseClient';
import type { Player, Game, GamePlayer, ChipValue, Settings } from '../types';

// ── GitHub JSON fetcher ──

const GH_OWNER = 'LiorMoldovan';
const GH_REPO = 'poker-manager';
const GH_BRANCH = 'main';

async function fetchGitHubJSON<T>(path: string): Promise<T | null> {
  try {
    const contentsUrl = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}?ref=${GH_BRANCH}`;
    const res = await fetch(contentsUrl, { headers: { 'Accept': 'application/vnd.github.v3+json' } });
    if (!res.ok) return null;
    const info = await res.json();
    if (info.content) {
      const bin = atob(info.content.replace(/\n/g, ''));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return JSON.parse(new TextDecoder('utf-8').decode(bytes)) as T;
    }
    const rawUrl = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}/${path}`;
    const rawRes = await fetch(rawUrl);
    if (!rawRes.ok) return null;
    return (await rawRes.json()) as T;
  } catch { return null; }
}

interface CloudBackupData {
  players: Player[];
  games: Game[];
  gamePlayers: GamePlayer[];
  chipValues: ChipValue[];
  settings: Settings;
}

// ── Training Data Migration ──

interface TrainingScenario {
  poolId: string;
  categoryId: string;
  category: string;
  [key: string]: unknown;
}

interface TrainingPoolData {
  scenarios: TrainingScenario[];
  totalScenarios: number;
}

interface TrainingPlayerData {
  playerName: string;
  sessions: unknown[];
  totalQuestions: number;
  totalCorrect: number;
  accuracy: number;
  pendingReportMilestones: number[];
  reports: unknown[];
}

interface TrainingAnswersData {
  players: TrainingPlayerData[];
}

interface TrainingInsightsData {
  insights: Record<string, unknown>;
}

export async function migrateTrainingFromCloud(
  groupId: string,
  onProgress?: (msg: string) => void
): Promise<{ pool: number; answers: number; insights: number }> {
  const result = { pool: 0, answers: 0, insights: 0 };

  try {
    onProgress?.('מוריד נתוני אימון...');
    const [pool, answersFile, insightsFile] = await Promise.all([
      fetchGitHubJSON<TrainingPoolData>('public/training-pool.json'),
      fetchGitHubJSON<TrainingAnswersData>('public/training-answers.json'),
      fetchGitHubJSON<TrainingInsightsData>('public/training-insights.json'),
    ]);

    if (pool?.scenarios?.length) {
      onProgress?.(`מעביר ${pool.scenarios.length} תרחישי אימון...`);
      const rows = pool.scenarios.map(s => ({
        group_id: groupId,
        scenario_id: s.poolId,
        category_id: s.categoryId,
        category: s.category,
        scenario: s,
      }));
      const BATCH = 50;
      for (let i = 0; i < rows.length; i += BATCH) {
        const { error } = await supabase.from('training_pool').insert(rows.slice(i, i + BATCH));
        if (error) console.warn(`Training pool batch ${i}: ${error.message}`);
        else result.pool += rows.slice(i, i + BATCH).length;
      }
    }

    if (answersFile?.players?.length) {
      onProgress?.(`מעביר תשובות ${answersFile.players.length} שחקנים...`);
      for (const player of answersFile.players) {
        const { error } = await supabase.from('training_answers').upsert({
          group_id: groupId,
          player_name: player.playerName,
          sessions: player.sessions,
          stats: {
            totalQuestions: player.totalQuestions,
            totalCorrect: player.totalCorrect,
            accuracy: player.accuracy,
            pendingReportMilestones: player.pendingReportMilestones || [],
          },
          reports: player.reports || [],
          updated_at: new Date().toISOString(),
        }, { onConflict: 'group_id,player_name' });
        if (error) console.warn(`Training answer ${player.playerName}: ${error.message}`);
        else result.answers++;
      }
    }

    if (insightsFile?.insights) {
      const entries = Object.entries(insightsFile.insights);
      onProgress?.(`מעביר תובנות ${entries.length} שחקנים...`);
      for (const [playerName, data] of entries) {
        const { error } = await supabase.from('training_insights').upsert({
          group_id: groupId,
          player_name: playerName,
          insights: data,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'group_id,player_name' });
        if (error) console.warn(`Training insight ${playerName}: ${error.message}`);
        else result.insights++;
      }
    }

    console.log('Training migration complete:', result);
  } catch (err) {
    console.error('Training migration error:', err);
  }
  return result;
}

// ── Chip Count ID Repair ──

/**
 * Fixes chip_counts keys in existing migrated data.
 * Maps old chip IDs (from GitHub backup) to current Supabase UUIDs
 * by matching on value+color, then updates all game_players rows.
 */
export async function fixChipCountIds(groupId: string): Promise<{ updated: number; skipped: number }> {
  const result = { updated: 0, skipped: 0 };

  const backupData = await fetchGitHubJSON<CloudBackupData>('public/full-backup.json');
  if (!backupData?.chipValues?.length) {
    console.warn('fixChipCountIds: no chip values in backup');
    return result;
  }

  const { data: supaChips, error } = await supabase
    .from('chip_values')
    .select('id, color, value')
    .eq('group_id', groupId);
  if (error || !supaChips?.length) {
    console.warn('fixChipCountIds: no chip values in Supabase', error?.message);
    return result;
  }

  const oldToNew = new Map<string, string>();
  for (const oldCv of backupData.chipValues) {
    const match = supaChips.find(sc => Number(sc.value) === oldCv.value && sc.color === oldCv.color);
    if (match) oldToNew.set(oldCv.id, match.id);
  }
  console.log(`fixChipCountIds: ${oldToNew.size} chip ID mappings built`);
  if (oldToNew.size === 0) return result;

  const { data: games } = await supabase.from('games').select('id').eq('group_id', groupId);
  if (!games?.length) return result;

  const BATCH = 30;
  const allGps: Array<{ id: string; chip_counts: Record<string, number> }> = [];
  for (let i = 0; i < games.length; i += BATCH) {
    const ids = games.slice(i, i + BATCH).map(g => g.id);
    const { data: gps } = await supabase.from('game_players').select('id, chip_counts').in('game_id', ids);
    if (gps) allGps.push(...(gps as Array<{ id: string; chip_counts: Record<string, number> }>));
  }

  for (const gp of allGps) {
    if (!gp.chip_counts || Object.keys(gp.chip_counts).length === 0) {
      result.skipped++;
      continue;
    }
    const hasOldKeys = Object.keys(gp.chip_counts).some(k => oldToNew.has(k));
    if (!hasOldKeys) {
      result.skipped++;
      continue;
    }
    const fixed: Record<string, number> = {};
    for (const [k, v] of Object.entries(gp.chip_counts)) {
      fixed[oldToNew.get(k) || k] = v;
    }
    const { error: upErr } = await supabase.from('game_players').update({ chip_counts: fixed }).eq('id', gp.id);
    if (upErr) console.warn(`fixChipCountIds ${gp.id}:`, upErr.message);
    else result.updated++;
  }

  console.log(`fixChipCountIds done: ${result.updated} updated, ${result.skipped} skipped`);
  return result;
}
