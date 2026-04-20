/**
 * Training helpers — pool, answers, insights — all backed by Supabase tables.
 */

import type { TrainingPool, TrainingAnswersFile, TrainingInsightsFile, PoolScenario } from '../types';
import { supabase } from './supabaseClient';
import { getGroupId } from './supabaseCache';

// ════════════════════════════════════════════════════════════
// SHARED TRAINING (Supabase)
// ════════════════════════════════════════════════════════════

function supabaseRowsToTrainingPool(allRows: Record<string, unknown>[]): TrainingPool {
  const scenarios: PoolScenario[] = allRows.map(row => ({
    ...(row.scenario as Record<string, unknown>),
    poolId: row.scenario_id as string,
    categoryId: row.category_id as string,
    category: row.category as string,
  } as PoolScenario));
  const byCategory: Record<string, number> = {};
  scenarios.forEach(s => { byCategory[s.categoryId] = (byCategory[s.categoryId] || 0) + 1; });
  const latestCreatedAt = allRows.reduce((max, row) => {
    const t = (row.created_at as string) || '';
    return t > max ? t : max;
  }, '');
  return {
    generatedAt: latestCreatedAt || new Date().toISOString(),
    totalScenarios: scenarios.length,
    byCategory,
    scenarios,
  };
}

async function fetchAllTrainingRows(gid: string): Promise<Record<string, unknown>[]> {
  const allRows: Record<string, unknown>[] = [];
  const PAGE = 1000;
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from('training_pool')
      .select('*')
      .eq('group_id', gid)
      .range(offset, offset + PAGE - 1);
    if (error) { console.warn('fetchTrainingPool error:', error.message); break; }
    if (!data || data.length === 0) break;
    allRows.push(...(data as Record<string, unknown>[]));
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return allRows;
}

let _trainingAutoImportDone = false;

export const fetchTrainingPool = async (): Promise<TrainingPool | null> => {
  const gid = getGroupId();
  if (!gid) return null;
  const allRows = await fetchAllTrainingRows(gid);
  if (allRows.length > 0) return supabaseRowsToTrainingPool(allRows);

  if (_trainingAutoImportDone) return null;
  _trainingAutoImportDone = true;
  console.warn('Training pool empty in Supabase, auto-importing from GitHub...');
  try {
    const { migrateTrainingFromCloud } = await import('./migrateToSupabase');
    const result = await migrateTrainingFromCloud(gid);
    console.warn('Training auto-import done:', result);
    if (result.pool > 0) {
      const rows = await fetchAllTrainingRows(gid);
      if (rows.length > 0) return supabaseRowsToTrainingPool(rows);
    }
  } catch (err) {
    console.warn('Training auto-import failed:', err);
  }
  return null;
};

export const fetchTrainingAnswers = async (): Promise<TrainingAnswersFile | null> => {
  const gid = getGroupId();
  if (!gid) return null;
  const { data: rows } = await supabase.from('training_answers').select('*').eq('group_id', gid);
  if (!rows || rows.length === 0) return { lastUpdated: '', players: [] };
  return {
    lastUpdated: rows.reduce((latest, r) => ((r.updated_at as string) || '') > latest ? (r.updated_at as string) : latest, ''),
    players: rows.map(row => {
      const stats = (row.stats || {}) as Record<string, unknown>;
      return {
        playerName: row.player_name as string,
        sessions: (row.sessions || []) as TrainingAnswersFile['players'][0]['sessions'],
        totalQuestions: (stats.totalQuestions as number) || 0,
        totalCorrect: (stats.totalCorrect as number) || 0,
        accuracy: (stats.accuracy as number) || 0,
        reports: (row.reports || []) as TrainingAnswersFile['players'][0]['reports'],
        pendingReportMilestones: (stats.pendingReportMilestones as number[]) || [],
      };
    }),
  };
};

export const fetchTrainingInsights = async (): Promise<TrainingInsightsFile | null> => {
  const gid = getGroupId();
  if (!gid) return null;
  const { data: rows } = await supabase.from('training_insights').select('*').eq('group_id', gid);
  if (!rows || rows.length === 0) return { lastUpdated: '', insights: {} };
  const insights: TrainingInsightsFile['insights'] = {};
  for (const row of rows) {
    const data = row.insights as Record<string, unknown>;
    insights[row.player_name as string] = {
      generatedAt: (data.generatedAt as string) || '',
      sessionsAtGeneration: (data.sessionsAtGeneration as number) || 0,
      improvement: (data.improvement as string) || '',
    };
  }
  return {
    lastUpdated: rows.reduce((latest, r) => ((r.updated_at as string) || '') > latest ? (r.updated_at as string) : latest, ''),
    insights,
  };
};

export const uploadTrainingPool = async (pool: TrainingPool): Promise<{ success: boolean; message: string }> => {
  const gid = getGroupId();
  if (!gid) return { success: false, message: 'No active group' };
  await supabase.from('training_pool').delete().eq('group_id', gid);
  if (pool.scenarios.length > 0) {
    const rows = pool.scenarios.map(s => ({
      group_id: gid,
      scenario_id: s.poolId,
      category: s.category,
      category_id: s.categoryId,
      scenario: s,
      reviewed_at: s.reviewedAt || null,
    }));
    for (let i = 0; i < rows.length; i += 50) {
      const { error } = await supabase.from('training_pool').insert(rows.slice(i, i + 50));
      if (error) return { success: false, message: error.message };
    }
  }
  return { success: true, message: `${pool.totalScenarios} scenarios uploaded` };
};

export const uploadTrainingInsights = async (data: TrainingInsightsFile): Promise<{ success: boolean; message: string }> => {
  const gid = getGroupId();
  if (!gid) return { success: false, message: 'No active group' };
  for (const [playerName, insight] of Object.entries(data.insights)) {
    const { error } = await supabase.from('training_insights').upsert({
      group_id: gid,
      player_name: playerName,
      insights: insight,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'group_id,player_name' });
    if (error) return { success: false, message: error.message };
  }
  return { success: true, message: 'Insights uploaded' };
};

export const writeTrainingAnswersWithRetry = async (
  mutate: (data: TrainingAnswersFile) => TrainingAnswersFile,
  _keepalive = false,
): Promise<boolean> => {
  const gid = getGroupId();
  if (!gid) return false;
  try {
    const existing = await fetchTrainingAnswers() || { lastUpdated: '', players: [] };
    const updated = mutate(existing);
    for (const player of updated.players) {
      await supabase.from('training_answers').upsert({
        group_id: gid,
        player_name: player.playerName,
        sessions: player.sessions,
        stats: {
          totalQuestions: player.totalQuestions,
          totalCorrect: player.totalCorrect,
          accuracy: player.accuracy,
          pendingReportMilestones: player.pendingReportMilestones,
        },
        reports: player.reports || [],
        updated_at: new Date().toISOString(),
      }, { onConflict: 'group_id,player_name' });
    }
    return true;
  } catch (err) {
    console.warn('Training answers Supabase write failed:', err);
    return false;
  }
};

export const removeFromTrainingPool = async (poolIdsToRemove: string[]): Promise<{ success: boolean; message: string }> => {
  const gid = getGroupId();
  if (!gid) return { success: false, message: 'No active group' };
  const { error } = await supabase.from('training_pool')
    .delete()
    .eq('group_id', gid)
    .in('scenario_id', poolIdsToRemove);
  if (error) return { success: false, message: error.message };
  return { success: true, message: `Removed ${poolIdsToRemove.length} scenarios` };
};
