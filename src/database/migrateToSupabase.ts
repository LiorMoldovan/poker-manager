import { supabase } from './supabaseClient';
import type { Player, Game, GamePlayer, ChipValue, Settings, SharedExpense, GameForecast, PendingForecast } from '../types';
import type { ChronicleEntry, GraphInsightsEntry } from './storage';

// ID mapping: old localStorage IDs → new UUIDs
type IdMap = Map<string, string>;

function newUUID(): string {
  return crypto.randomUUID();
}

function readLS<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function remapChipCounts(chipCounts: Record<string, number>, chipIdMap: IdMap): Record<string, number> {
  if (!chipCounts || Object.keys(chipCounts).length === 0) return chipCounts;
  const remapped: Record<string, number> = {};
  for (const [oldId, count] of Object.entries(chipCounts)) {
    const newId = chipIdMap.get(oldId);
    remapped[newId || oldId] = count;
  }
  return remapped;
}

export interface MigrationProgress {
  step: string;
  current: number;
  total: number;
}

export async function migrateLocalStorageToSupabase(
  groupId: string,
  onProgress?: (p: MigrationProgress) => void,
): Promise<{ success: boolean; message: string; stats: Record<string, number> }> {
  const stats: Record<string, number> = {};
  const playerIdMap: IdMap = new Map();
  const gameIdMap: IdMap = new Map();
  const gamePlayerIdMap: IdMap = new Map();
  const chipIdMap: IdMap = new Map();

  try {
    // Safety: prevent double migration
    const alreadyHasData = await checkGroupHasData(groupId);
    if (alreadyHasData) {
      return {
        success: false,
        message: 'הקבוצה כבר מכילה נתונים — אם ברצונך להעביר מחדש, מחק את הנתונים בקבוצה קודם',
        stats,
      };
    }

    // Pre-build chip ID map so chipCounts keys can be remapped in game_players
    const chipValues = readLS<ChipValue[]>('poker_chip_values', []);
    for (const cv of chipValues) chipIdMap.set(cv.id, newUUID());

    // ── 1. Players ──
    onProgress?.({ step: 'שחקנים', current: 1, total: 9 });
    const players = readLS<Player[]>('poker_players', []);
    if (players.length > 0) {
      const rows = players.map(p => {
        const uuid = newUUID();
        playerIdMap.set(p.id, uuid);
        return {
          id: uuid,
          group_id: groupId,
          name: p.name,
          type: p.type || 'permanent',
          gender: p.gender || 'male',
          created_at: p.createdAt || new Date().toISOString(),
        };
      });
      const { error } = await supabase.from('players').insert(rows);
      if (error) throw new Error(`Players: ${error.message}`);
      stats.players = rows.length;
    }

    // ── 2. Games ──
    onProgress?.({ step: 'משחקים', current: 2, total: 9 });
    const games = readLS<Game[]>('poker_games', []);
    if (games.length > 0) {
      const rows = games.map(g => {
        const uuid = newUUID();
        gameIdMap.set(g.id, uuid);
        return {
          id: uuid,
          group_id: groupId,
          date: g.date,
          status: g.status,
          location: g.location || null,
          chip_gap: g.chipGap ?? null,
          chip_gap_per_player: g.chipGapPerPlayer ?? null,
          ai_summary: g.aiSummary || null,
          ai_summary_model: g.aiSummaryModel || null,
          pre_game_teaser: g.preGameTeaser || null,
          forecast_comment: g.forecastComment || null,
          forecast_accuracy: g.forecastAccuracy || null,
          created_at: g.createdAt || g.date || new Date().toISOString(),
        };
      });
      for (let i = 0; i < rows.length; i += 50) {
        const batch = rows.slice(i, i + 50);
        const { error } = await supabase.from('games').insert(batch);
        if (error) throw new Error(`Games batch ${i}: ${error.message}`);
      }
      stats.games = rows.length;
    }

    // ── 3. Game Players ──
    onProgress?.({ step: 'שחקני משחק', current: 3, total: 9 });
    const gamePlayers = readLS<GamePlayer[]>('poker_game_players', []);
    if (gamePlayers.length > 0) {
      const orphanedPlayerIds = new Set<string>();
      for (const gp of gamePlayers) {
        if (!playerIdMap.has(gp.playerId)) orphanedPlayerIds.add(gp.playerId);
      }
      if (orphanedPlayerIds.size > 0) {
        console.warn(`Migration: ${orphanedPlayerIds.size} orphaned player ID(s) found, creating placeholders`);
        for (const oldId of orphanedPlayerIds) {
          const uuid = newUUID();
          playerIdMap.set(oldId, uuid);
          const gp = gamePlayers.find(g => g.playerId === oldId);
          const { error } = await supabase.from('players').insert({
            id: uuid,
            group_id: groupId,
            name: gp?.playerName || `[שחקן ${oldId}]`,
            type: 'guest',
            gender: 'male',
            created_at: new Date().toISOString(),
          });
          if (error) console.warn(`Placeholder player ${oldId}:`, error.message);
        }
        stats.orphanedPlayers = orphanedPlayerIds.size;
      }

      const rows = gamePlayers
        .filter(gp => gameIdMap.has(gp.gameId) && playerIdMap.has(gp.playerId))
        .map(gp => {
          const uuid = newUUID();
          gamePlayerIdMap.set(gp.id, uuid);
          return {
            id: uuid,
            game_id: gameIdMap.get(gp.gameId)!,
            player_id: playerIdMap.get(gp.playerId)!,
            player_name: gp.playerName,
            rebuys: Math.round(gp.rebuys ?? 0),
            chip_counts: remapChipCounts(gp.chipCounts, chipIdMap),
            final_value: gp.finalValue,
            profit: gp.profit,
          };
        });
      for (let i = 0; i < rows.length; i += 50) {
        const batch = rows.slice(i, i + 50);
        const { error } = await supabase.from('game_players').insert(batch);
        if (error) throw new Error(`GamePlayers batch ${i}: ${error.message}`);
      }
      stats.gamePlayers = rows.length;
    }

    // ── 4. Game Forecasts (embedded in games) ──
    onProgress?.({ step: 'תחזיות', current: 4, total: 9 });
    let forecastCount = 0;
    for (const game of games) {
      if (game.forecasts && game.forecasts.length > 0) {
        const newGameId = gameIdMap.get(game.id);
        if (!newGameId) continue;
        const rows = game.forecasts.map((f: GameForecast) => ({
          game_id: newGameId,
          player_name: f.playerName,
          expected_profit: f.expectedProfit,
          highlight: f.highlight || null,
          sentence: f.sentence || null,
          is_surprise: f.isSurprise || false,
        }));
        const { error } = await supabase.from('game_forecasts').insert(rows);
        if (error) console.warn(`Forecasts for game ${game.id}:`, error.message);
        else forecastCount += rows.length;
      }
    }
    stats.forecasts = forecastCount;

    // ── 5. Shared Expenses (embedded in games) ──
    onProgress?.({ step: 'הוצאות משותפות', current: 5, total: 9 });
    let expenseCount = 0;
    for (const game of games) {
      if (game.sharedExpenses && game.sharedExpenses.length > 0) {
        const newGameId = gameIdMap.get(game.id);
        if (!newGameId) continue;
        const rows = game.sharedExpenses.map((e: SharedExpense) => ({
          id: newUUID(),
          game_id: newGameId,
          description: e.description,
          paid_by: playerIdMap.get(e.paidBy) || null,
          paid_by_name: e.paidByName,
          amount: e.amount,
          participants: e.participants.map(pid => playerIdMap.get(pid) || pid),
          participant_names: e.participantNames,
          created_at: e.createdAt,
        }));
        const { error } = await supabase.from('shared_expenses').insert(rows);
        if (error) console.warn(`Expenses for game ${game.id}:`, error.message);
        else expenseCount += rows.length;
      }
    }
    stats.sharedExpenses = expenseCount;

    // ── 6. Paid Settlements ──
    let settlementCount = 0;
    for (const game of games) {
      if (game.paidSettlements && game.paidSettlements.length > 0) {
        const newGameId = gameIdMap.get(game.id);
        if (!newGameId) continue;
        const rows = game.paidSettlements.map(ps => ({
          game_id: newGameId,
          from_player: ps.from,
          to_player: ps.to,
          paid_at: ps.paidAt,
        }));
        const { error } = await supabase.from('paid_settlements').insert(rows);
        if (error) console.warn(`Settlements for game ${game.id}:`, error.message);
        else settlementCount += rows.length;
      }
    }
    stats.settlements = settlementCount;

    // ── 6b. Period Markers (embedded in games) ──
    let markerCount = 0;
    for (const game of games) {
      if (game.periodMarkers) {
        const newGameId = gameIdMap.get(game.id);
        if (!newGameId) continue;
        const pm = game.periodMarkers;
        const { error } = await supabase.from('period_markers').insert({
          game_id: newGameId,
          is_first_game_of_month: pm.isFirstGameOfMonth,
          is_last_game_of_month: pm.isLastGameOfMonth,
          is_first_game_of_half: pm.isFirstGameOfHalf,
          is_last_game_of_half: pm.isLastGameOfHalf,
          is_first_game_of_year: pm.isFirstGameOfYear,
          is_last_game_of_year: pm.isLastGameOfYear,
          month_name: pm.monthName,
          half_label: pm.halfLabel,
          year: pm.year,
        });
        if (error) console.warn(`PeriodMarkers for game ${game.id}:`, error.message);
        else markerCount++;
      }
    }
    stats.periodMarkers = markerCount;

    // ── 7. Chip Values (use pre-built chipIdMap) ──
    onProgress?.({ step: 'ערכי ז\'יטונים', current: 6, total: 9 });
    if (chipValues.length > 0) {
      const rows = chipValues.map(cv => ({
        id: chipIdMap.get(cv.id) || newUUID(),
        group_id: groupId,
        color: cv.color,
        value: cv.value,
        display_color: cv.displayColor,
      }));
      const { error } = await supabase.from('chip_values').insert(rows);
      if (error) throw new Error(`ChipValues: ${error.message}`);
      stats.chipValues = rows.length;
    }

    // ── 8. Settings ──
    onProgress?.({ step: 'הגדרות', current: 7, total: 9 });
    const settings = readLS<Settings>('poker_settings', {} as Settings);
    if (settings.rebuyValue) {
      const { error } = await supabase.from('settings').insert({
        group_id: groupId,
        rebuy_value: settings.rebuyValue,
        chips_per_rebuy: settings.chipsPerRebuy,
        min_transfer: settings.minTransfer,
        game_night_days: settings.gameNightDays || [4, 6],
        locations: settings.locations || [],
        blocked_transfers: settings.blockedTransfers || [],
      });
      if (error) throw new Error(`Settings: ${error.message}`);
      stats.settings = 1;
    }

    // ── 9. AI Caches (chronicles + graph insights) ──
    onProgress?.({ step: 'קאש AI', current: 8, total: 9 });
    const chroniclesRaw = localStorage.getItem('poker_chronicle_profiles');
    if (chroniclesRaw) {
      try {
        const all: Record<string, ChronicleEntry> = JSON.parse(chroniclesRaw);
        for (const [periodKey, entry] of Object.entries(all)) {
          await supabase.from('chronicle_profiles').insert({
            group_id: groupId,
            period_key: periodKey,
            profiles: entry.profiles,
            generated_at: entry.generatedAt,
            model: entry.model || null,
          });
        }
        stats.chronicles = Object.keys(all).length;
      } catch { /* ignore corrupt data */ }
    }

    const insightsRaw = localStorage.getItem('poker_graph_insights');
    if (insightsRaw) {
      try {
        const all: Record<string, GraphInsightsEntry> = JSON.parse(insightsRaw);
        for (const [periodKey, entry] of Object.entries(all)) {
          await supabase.from('graph_insights').insert({
            group_id: groupId,
            period_key: periodKey,
            text: entry.text,
            generated_at: entry.generatedAt,
            model: entry.model || null,
          });
        }
        stats.graphInsights = Object.keys(all).length;
      } catch { /* ignore corrupt data */ }
    }

    // ── 10. Pending Forecast ──
    onProgress?.({ step: 'תחזית ממתינה', current: 9, total: 9 });
    const pendingRaw = localStorage.getItem('poker_pending_forecast');
    if (pendingRaw) {
      try {
        const pf = JSON.parse(pendingRaw);
        if (pf && pf.playerIds) {
          await supabase.from('pending_forecasts').insert({
            id: newUUID(),
            group_id: groupId,
            player_ids: pf.playerIds.map((pid: string) => playerIdMap.get(pid) || pid),
            forecasts: pf.forecasts,
            linked_game_id: pf.linkedGameId ? (gameIdMap.get(pf.linkedGameId) || null) : null,
            pre_game_teaser: pf.preGameTeaser || null,
            ai_model: pf.aiModel || null,
            published: pf.published || false,
            location: pf.location || null,
            created_at: pf.createdAt,
          });
          stats.pendingForecast = 1;
        }
      } catch { /* ignore */ }
    }

    return {
      success: true,
      message: `הועברו בהצלחה: ${stats.players || 0} שחקנים, ${stats.games || 0} משחקים, ${stats.gamePlayers || 0} רשומות`,
      stats,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Migration failed:', msg);
    return { success: false, message: `שגיאה בהעברה: ${msg}`, stats };
  }
}

// Check if a group already has data (to prevent double migration)
export async function checkGroupHasData(groupId: string): Promise<boolean> {
  const { count } = await supabase
    .from('players')
    .select('id', { count: 'exact', head: true })
    .eq('group_id', groupId);
  return (count ?? 0) > 0;
}

// Clean all group data (use before retrying a failed migration)
export async function cleanGroupData(groupId: string): Promise<void> {
  await supabase.from('pending_forecasts').delete().eq('group_id', groupId);
  await supabase.from('chronicle_profiles').delete().eq('group_id', groupId);
  await supabase.from('graph_insights').delete().eq('group_id', groupId);
  await supabase.from('games').delete().eq('group_id', groupId);
  await supabase.from('chip_values').delete().eq('group_id', groupId);
  await supabase.from('settings').delete().eq('group_id', groupId);
  await supabase.from('players').delete().eq('group_id', groupId);
}

// ── Cloud Migration: fetch from GitHub and migrate to Supabase ──

const GH_OWNER = 'LiorMoldovan';
const GH_REPO = 'poker-manager';
const GH_BRANCH = 'main';

async function fetchGitHubJSON<T>(path: string): Promise<T | null> {
  try {
    const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${path}?ref=${GH_BRANCH}`;
    const res = await fetch(url, { headers: { 'Accept': 'application/vnd.github.v3+json' } });
    if (!res.ok) return null;
    const info = await res.json();
    const bin = atob(info.content.replace(/\n/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder('utf-8').decode(bytes)) as T;
  } catch { return null; }
}

interface CloudSyncData {
  players: Player[];
  games: Game[];
  gamePlayers: GamePlayer[];
  chronicleProfiles?: Record<string, ChronicleEntry>;
  graphInsights?: Record<string, GraphInsightsEntry>;
  pendingForecast?: PendingForecast | null;
}

interface CloudBackupData {
  players: Player[];
  games: Game[];
  gamePlayers: GamePlayer[];
  chipValues: ChipValue[];
  settings: Settings;
}

export async function migrateFromCloud(
  groupName: string = 'Poker Night',
  onProgress?: (p: MigrationProgress) => void,
): Promise<{ success: boolean; message: string; stats: Record<string, number>; groupId?: string }> {
  const stats: Record<string, number> = {};
  const playerIdMap: IdMap = new Map();
  const gameIdMap: IdMap = new Map();
  const chipIdMap: IdMap = new Map();

  try {
    // ── Step 1: Fetch data from GitHub ──
    onProgress?.({ step: 'מוריד נתונים מהענן...', current: 1, total: 12 });

    const [syncData, backupData] = await Promise.all([
      fetchGitHubJSON<CloudSyncData>('public/sync-data.json'),
      fetchGitHubJSON<CloudBackupData>('public/full-backup.json'),
    ]);

    const source = syncData || backupData;
    if (!source || !source.players?.length) {
      return { success: false, message: 'לא נמצאו נתונים בענן (sync-data.json / full-backup.json)', stats };
    }

    const players: Player[] = source.players;
    const games: Game[] = source.games || [];
    const gamePlayers: GamePlayer[] = source.gamePlayers || [];
    const chipValues: ChipValue[] = backupData?.chipValues || [];
    const settings: Settings = backupData?.settings || { rebuyValue: 30, chipsPerRebuy: 10000, minTransfer: 5 };
    const chronicles = syncData?.chronicleProfiles || {};
    const insights = syncData?.graphInsights || {};
    const pending = syncData?.pendingForecast || null;

    // Pre-build chip ID map so chipCounts keys can be remapped in game_players
    for (const cv of chipValues) chipIdMap.set(cv.id, newUUID());

    console.log(`Cloud data: ${players.length} players, ${games.length} games, ${gamePlayers.length} game-players`);

    // ── Step 2: Create group ──
    onProgress?.({ step: 'יוצר קבוצה...', current: 2, total: 12 });

    const { data: groupResult, error: groupError } = await supabase.rpc('create_group', { group_name: groupName });
    if (groupError) throw new Error(`Group creation: ${groupError.message}`);

    const groupId = (groupResult as { group_id: string }).group_id;
    console.log(`Created group "${groupName}" with ID: ${groupId}`);

    // ── Step 3: Players ──
    onProgress?.({ step: 'שחקנים', current: 3, total: 12 });
    if (players.length > 0) {
      const rows = players.map(p => {
        const uuid = newUUID();
        playerIdMap.set(p.id, uuid);
        return {
          id: uuid,
          group_id: groupId,
          name: p.name,
          type: p.type || 'permanent',
          gender: p.gender || 'male',
          created_at: p.createdAt || new Date().toISOString(),
        };
      });
      const { error } = await supabase.from('players').insert(rows);
      if (error) throw new Error(`Players: ${error.message}`);
      stats.players = rows.length;
    }

    // ── Step 4: Games ──
    onProgress?.({ step: 'משחקים', current: 4, total: 12 });
    if (games.length > 0) {
      const rows = games.map(g => {
        const uuid = newUUID();
        gameIdMap.set(g.id, uuid);
        return {
          id: uuid,
          group_id: groupId,
          date: g.date,
          status: g.status,
          location: g.location || null,
          chip_gap: g.chipGap ?? null,
          chip_gap_per_player: g.chipGapPerPlayer ?? null,
          ai_summary: g.aiSummary || null,
          ai_summary_model: g.aiSummaryModel || null,
          pre_game_teaser: g.preGameTeaser || null,
          forecast_comment: g.forecastComment || null,
          forecast_accuracy: g.forecastAccuracy || null,
          created_at: g.createdAt || g.date || new Date().toISOString(),
        };
      });
      for (let i = 0; i < rows.length; i += 50) {
        const { error } = await supabase.from('games').insert(rows.slice(i, i + 50));
        if (error) throw new Error(`Games batch ${i}: ${error.message}`);
      }
      stats.games = rows.length;
    }

    // ── Step 5: Game Players (with orphan handling) ──
    onProgress?.({ step: 'שחקני משחק', current: 5, total: 12 });
    if (gamePlayers.length > 0) {
      const orphaned = new Set<string>();
      for (const gp of gamePlayers) {
        if (!playerIdMap.has(gp.playerId)) orphaned.add(gp.playerId);
      }
      if (orphaned.size > 0) {
        console.warn(`Migration: ${orphaned.size} orphaned player(s), creating placeholders`);
        for (const oldId of orphaned) {
          const uuid = newUUID();
          playerIdMap.set(oldId, uuid);
          const gp = gamePlayers.find(g => g.playerId === oldId);
          await supabase.from('players').insert({
            id: uuid, group_id: groupId,
            name: gp?.playerName || `[שחקן ${oldId}]`,
            type: 'guest', gender: 'male', created_at: new Date().toISOString(),
          });
        }
        stats.orphanedPlayers = orphaned.size;
      }

      const rows = gamePlayers
        .filter(gp => gameIdMap.has(gp.gameId) && playerIdMap.has(gp.playerId))
        .map(gp => ({
          id: newUUID(),
          game_id: gameIdMap.get(gp.gameId)!,
          player_id: playerIdMap.get(gp.playerId)!,
          player_name: gp.playerName,
          rebuys: Math.round(gp.rebuys ?? 0),
          chip_counts: remapChipCounts(gp.chipCounts, chipIdMap),
          final_value: gp.finalValue,
          profit: gp.profit,
        }));
      for (let i = 0; i < rows.length; i += 50) {
        const { error } = await supabase.from('game_players').insert(rows.slice(i, i + 50));
        if (error) throw new Error(`GamePlayers batch ${i}: ${error.message}`);
      }
      stats.gamePlayers = rows.length;
    }

    // ── Step 6: Game Forecasts ──
    onProgress?.({ step: 'תחזיות', current: 6, total: 12 });
    let forecastCount = 0;
    for (const game of games) {
      if (game.forecasts?.length) {
        const gid = gameIdMap.get(game.id);
        if (!gid) continue;
        const rows = game.forecasts.map((f: GameForecast) => ({
          game_id: gid, player_name: f.playerName, expected_profit: f.expectedProfit,
          highlight: f.highlight || null, sentence: f.sentence || null, is_surprise: f.isSurprise || false,
        }));
        const { error } = await supabase.from('game_forecasts').insert(rows);
        if (!error) forecastCount += rows.length;
      }
    }
    stats.forecasts = forecastCount;

    // ── Step 7: Shared Expenses + Paid Settlements + Period Markers ──
    onProgress?.({ step: 'הוצאות והתחשבנויות', current: 7, total: 12 });
    let expCount = 0, settleCount = 0, markerCount = 0;
    for (const game of games) {
      const gid = gameIdMap.get(game.id);
      if (!gid) continue;

      if (game.sharedExpenses?.length) {
        const rows = game.sharedExpenses.map((e: SharedExpense) => ({
          id: newUUID(), game_id: gid, description: e.description,
          paid_by: playerIdMap.get(e.paidBy) || null, paid_by_name: e.paidByName,
          amount: e.amount, participants: e.participants.map(pid => playerIdMap.get(pid) || pid),
          participant_names: e.participantNames, created_at: e.createdAt,
        }));
        const { error } = await supabase.from('shared_expenses').insert(rows);
        if (!error) expCount += rows.length;
      }

      if (game.paidSettlements?.length) {
        const rows = game.paidSettlements.map(ps => ({
          game_id: gid, from_player: ps.from, to_player: ps.to, paid_at: ps.paidAt,
        }));
        const { error } = await supabase.from('paid_settlements').insert(rows);
        if (!error) settleCount += rows.length;
      }

      if (game.periodMarkers) {
        const pm = game.periodMarkers;
        const { error } = await supabase.from('period_markers').insert({
          game_id: gid,
          is_first_game_of_month: pm.isFirstGameOfMonth, is_last_game_of_month: pm.isLastGameOfMonth,
          is_first_game_of_half: pm.isFirstGameOfHalf, is_last_game_of_half: pm.isLastGameOfHalf,
          is_first_game_of_year: pm.isFirstGameOfYear, is_last_game_of_year: pm.isLastGameOfYear,
          month_name: pm.monthName, half_label: pm.halfLabel, year: pm.year,
        });
        if (!error) markerCount++;
      }
    }
    stats.sharedExpenses = expCount;
    stats.settlements = settleCount;
    stats.periodMarkers = markerCount;

    // ── Step 8: Chip Values (use pre-built chipIdMap) ──
    onProgress?.({ step: 'ערכי ז\'יטונים', current: 8, total: 12 });
    if (chipValues.length > 0) {
      const rows = chipValues.map(cv => ({
        id: chipIdMap.get(cv.id) || newUUID(), group_id: groupId, color: cv.color, value: cv.value, display_color: cv.displayColor,
      }));
      const { error } = await supabase.from('chip_values').insert(rows);
      if (error) console.warn('ChipValues:', error.message);
      else stats.chipValues = rows.length;
    }

    // ── Step 9: Settings ──
    onProgress?.({ step: 'הגדרות', current: 9, total: 12 });
    if (settings.rebuyValue) {
      const { error } = await supabase.from('settings').insert({
        group_id: groupId, rebuy_value: settings.rebuyValue,
        chips_per_rebuy: settings.chipsPerRebuy, min_transfer: settings.minTransfer,
        game_night_days: settings.gameNightDays || [4, 6],
        locations: settings.locations || [], blocked_transfers: settings.blockedTransfers || [],
      });
      if (error) console.warn('Settings:', error.message);
      else stats.settings = 1;
    }

    // ── Step 10: AI Caches ──
    onProgress?.({ step: 'קאש AI', current: 10, total: 12 });
    for (const [key, entry] of Object.entries(chronicles)) {
      await supabase.from('chronicle_profiles').insert({
        group_id: groupId, period_key: key,
        profiles: entry.profiles, generated_at: entry.generatedAt, model: entry.model || null,
      });
    }
    stats.chronicles = Object.keys(chronicles).length;

    for (const [key, entry] of Object.entries(insights)) {
      await supabase.from('graph_insights').insert({
        group_id: groupId, period_key: key,
        text: entry.text, generated_at: entry.generatedAt, model: entry.model || null,
      });
    }
    stats.graphInsights = Object.keys(insights).length;

    // ── Step 11: Pending Forecast ──
    onProgress?.({ step: 'תחזית ממתינה', current: 11, total: 12 });
    if (pending?.playerIds) {
      await supabase.from('pending_forecasts').insert({
        id: newUUID(), group_id: groupId,
        player_ids: pending.playerIds.map((pid: string) => playerIdMap.get(pid) || pid),
        forecasts: pending.forecasts,
        linked_game_id: pending.linkedGameId ? (gameIdMap.get(pending.linkedGameId) || null) : null,
        pre_game_teaser: pending.preGameTeaser || null,
        ai_model: pending.aiModel || null,
        published: pending.published || false,
        location: pending.location || null,
        created_at: pending.createdAt,
      });
      stats.pendingForecast = 1;
    }

    // ── Step 12: Training Data ──
    onProgress?.({ step: 'אימון פוקר', current: 12, total: 12 });
    const trainingStats = await migrateTrainingFromCloud(groupId);
    stats.trainingPool = trainingStats.pool;
    stats.trainingAnswers = trainingStats.answers;
    stats.trainingInsights = trainingStats.insights;

    const msg = `הועברו בהצלחה: ${stats.players || 0} שחקנים, ${stats.games || 0} משחקים, ${stats.gamePlayers || 0} רשומות`;
    console.log('Migration complete!', msg, stats);
    console.log('Reloading in 2 seconds...');
    setTimeout(() => window.location.reload(), 2000);

    return { success: true, message: msg, stats, groupId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Cloud migration failed:', msg);
    return { success: false, message: `שגיאה בהעברה: ${msg}`, stats };
  }
}

// ── Training Data Migration (can be called independently) ──

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
    // Fetch training data from GitHub
    onProgress?.('מוריד נתוני אימון...');
    const [pool, answersFile, insightsFile] = await Promise.all([
      fetchGitHubJSON<TrainingPoolData>('public/training-pool.json'),
      fetchGitHubJSON<TrainingAnswersData>('public/training-answers.json'),
      fetchGitHubJSON<TrainingInsightsData>('public/training-insights.json'),
    ]);

    // Pool scenarios — batch insert
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

    // Player answers
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

    // Player insights
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

/**
 * One-time fix for chip_counts in existing migrated data.
 * Builds a mapping from old chip IDs (from GitHub backup) to current Supabase UUIDs
 * by matching on value+color, then updates all game_players rows.
 */
export async function fixChipCountIds(groupId: string): Promise<{ updated: number; skipped: number }> {
  const result = { updated: 0, skipped: 0 };

  // 1. Fetch old chip values from GitHub backup
  const backupData = await fetchGitHubJSON<CloudBackupData>('public/full-backup.json');
  if (!backupData?.chipValues?.length) {
    console.warn('fixChipCountIds: no chip values in backup');
    return result;
  }

  // 2. Fetch current chip values from Supabase
  const { data: supaChips, error } = await supabase
    .from('chip_values')
    .select('id, color, value')
    .eq('group_id', groupId);
  if (error || !supaChips?.length) {
    console.warn('fixChipCountIds: no chip values in Supabase', error?.message);
    return result;
  }

  // 3. Build mapping: old ID → new UUID (match by value + color)
  const oldToNew = new Map<string, string>();
  for (const oldCv of backupData.chipValues) {
    const match = supaChips.find(sc => Number(sc.value) === oldCv.value && sc.color === oldCv.color);
    if (match) oldToNew.set(oldCv.id, match.id);
  }
  console.log(`fixChipCountIds: ${oldToNew.size} chip ID mappings built`);
  if (oldToNew.size === 0) return result;

  // 4. Fetch all game_players for this group's games
  const { data: games } = await supabase.from('games').select('id').eq('group_id', groupId);
  if (!games?.length) return result;

  const BATCH = 30;
  const allGps: Array<{ id: string; chip_counts: Record<string, number> }> = [];
  for (let i = 0; i < games.length; i += BATCH) {
    const ids = games.slice(i, i + BATCH).map(g => g.id);
    const { data: gps } = await supabase.from('game_players').select('id, chip_counts').in('game_id', ids);
    if (gps) allGps.push(...(gps as Array<{ id: string; chip_counts: Record<string, number> }>));
  }

  // 5. Update chip_counts keys
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
