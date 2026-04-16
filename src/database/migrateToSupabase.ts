import { supabase } from './supabaseClient';
import type { Player, Game, GamePlayer, ChipValue, Settings, SharedExpense, GameForecast } from '../types';
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
      // Insert in batches of 50 to avoid payload limits
      for (let i = 0; i < rows.length; i += 50) {
        const batch = rows.slice(i, i + 50);
        const { error } = await supabase.from('games').insert(batch);
        if (error) throw new Error(`Games batch ${i}: ${error.message}`);
      }
      stats.games = rows.length;
    }

    // ── 3. Game Players ──
    // Handle orphaned players: if a player was deleted from localStorage but their
    // game records remain, we create a placeholder so FK constraints are satisfied.
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
            rebuys: gp.rebuys,
            chip_counts: gp.chipCounts,
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

    // ── 7. Chip Values ──
    onProgress?.({ step: 'ערכי ז\'יטונים', current: 6, total: 9 });
    const chipValues = readLS<ChipValue[]>('poker_chip_values', []);
    if (chipValues.length > 0) {
      const rows = chipValues.map(cv => ({
        id: newUUID(),
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
  // Delete in reverse FK order to avoid constraint violations
  // game_players, game_forecasts, shared_expenses, paid_settlements, period_markers
  // are cascade-deleted when games are deleted
  await supabase.from('pending_forecasts').delete().eq('group_id', groupId);
  await supabase.from('chronicle_profiles').delete().eq('group_id', groupId);
  await supabase.from('graph_insights').delete().eq('group_id', groupId);
  await supabase.from('games').delete().eq('group_id', groupId);
  await supabase.from('chip_values').delete().eq('group_id', groupId);
  await supabase.from('settings').delete().eq('group_id', groupId);
  await supabase.from('players').delete().eq('group_id', groupId);
}
