/**
 * Training helpers — pool, answers, insights — all backed by Supabase tables.
 */

import type { TrainingPool, TrainingAnswersFile, TrainingInsightsFile, PoolScenario, TrainingSession } from '../types';
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

export const fetchTrainingPool = async (): Promise<TrainingPool | null> => {
  const gid = getGroupId();
  if (!gid) return null;
  const allRows = await fetchAllTrainingRows(gid);
  if (allRows.length > 0) return supabaseRowsToTrainingPool(allRows);
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

/**
 * Write a single player's training session directly to Supabase.
 * Reads only this player's row, appends the session (deduped by poolId),
 * recalculates stats, and upserts. Much faster than the read-all/mutate-all pattern.
 */
export const upsertPlayerSession = async (
  playerName: string,
  session: TrainingSession,
  pendingMilestone?: number,
): Promise<boolean> => {
  const gid = getGroupId();
  if (!gid) return false;
  try {
    const { data: row } = await supabase
      .from('training_answers')
      .select('*')
      .eq('group_id', gid)
      .eq('player_name', playerName)
      .maybeSingle();

    const existingSessions: TrainingSession[] = (row?.sessions || []) as TrainingSession[];
    const existingReports = (row?.reports || []) as TrainingAnswersFile['players'][0]['reports'];
    const existingStats = (row?.stats || {}) as Record<string, unknown>;
    const existingMilestones = (existingStats.pendingReportMilestones as number[]) || [];

    const existingPoolIds = new Set(existingSessions.flatMap(s => s.results.map(r => r.poolId)));
    const newResults = session.results.filter(r => !existingPoolIds.has(r.poolId));

    if (newResults.length > 0) {
      existingSessions.push({ ...session, results: newResults });
    }

    let scored = 0, correct = 0;
    for (const s of existingSessions) {
      for (const r of s.results) {
        if (r.neutralized) continue;
        if (!r.nearMiss) { scored++; if (r.correct) correct++; }
      }
    }

    const milestones = [...existingMilestones];
    if (pendingMilestone && !milestones.includes(pendingMilestone)) {
      milestones.push(pendingMilestone);
    }

    const { error } = await supabase.from('training_answers').upsert({
      group_id: gid,
      player_name: playerName,
      sessions: existingSessions,
      stats: {
        totalQuestions: scored,
        totalCorrect: correct,
        accuracy: scored > 0 ? (correct / scored) * 100 : 0,
        pendingReportMilestones: milestones,
      },
      reports: existingReports,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'group_id,player_name' });

    if (error) {
      console.warn('upsertPlayerSession failed:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('upsertPlayerSession error:', err);
    return false;
  }
};

export const writeTrainingAnswersWithRetry = async (
  mutate: (data: TrainingAnswersFile) => TrainingAnswersFile,
): Promise<boolean> => {
  const gid = getGroupId();
  if (!gid) return false;
  try {
    const existing = await fetchTrainingAnswers() || { lastUpdated: '', players: [] };
    const beforeMap = new Map(
      existing.players.map(p => [p.playerName, JSON.stringify(p)])
    );
    const updated = mutate(existing);
    const now = new Date().toISOString();
    const upsertPromises: PromiseLike<unknown>[] = [];

    for (const player of updated.players) {
      const afterJson = JSON.stringify(player);
      if (afterJson === beforeMap.get(player.playerName)) continue;
      upsertPromises.push(
        supabase.from('training_answers').upsert({
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
          updated_at: now,
        }, { onConflict: 'group_id,player_name' }).then()
      );
    }

    // Handle deleted players
    const updatedNames = new Set(updated.players.map(p => p.playerName));
    for (const oldName of beforeMap.keys()) {
      if (!updatedNames.has(oldName)) {
        upsertPromises.push(
          supabase.from('training_answers').delete()
            .eq('group_id', gid).eq('player_name', oldName).then()
        );
      }
    }

    if (upsertPromises.length > 0) {
      await Promise.all(upsertPromises);
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
