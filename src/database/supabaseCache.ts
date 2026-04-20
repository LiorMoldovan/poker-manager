import { supabase } from './supabaseClient';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { Player, Game, GamePlayer, ChipValue, Settings, SharedExpense, GameForecast, PendingForecast, PaidSettlement, AppNotification, PlayerTraits } from '../types';
import type { ChronicleEntry, GraphInsightsEntry } from './storage';

// ── Cache state ──

interface CacheState {
  groupId: string;
  data: Map<string, unknown>;
  ttsPools: Map<string, { pool: unknown; model?: string }>;
  playerTraits: Map<string, PlayerTraits>;
  initialized: boolean;
}

let state: CacheState | null = null;
let realtimeChannel: RealtimeChannel | null = null;
let realtimeRefreshTimer: ReturnType<typeof setTimeout> | null = null;

// ── Supabase → App format mappers ──

function toPlayer(row: Record<string, unknown>): Player {
  return {
    id: row.id as string,
    name: row.name as string,
    type: (row.type as Player['type']) || 'permanent',
    gender: (row.gender as Player['gender']) || 'male',
    createdAt: row.created_at as string,
  };
}

function toGame(row: Record<string, unknown>): Game {
  const game: Game = {
    id: row.id as string,
    date: row.date as string,
    status: row.status as Game['status'],
    createdAt: row.created_at as string,
  };
  if (row.location) game.location = row.location as string;
  if (row.chip_gap != null) game.chipGap = Number(row.chip_gap);
  if (row.chip_gap_per_player != null) game.chipGapPerPlayer = Number(row.chip_gap_per_player);
  if (row.ai_summary) game.aiSummary = row.ai_summary as string;
  if (row.ai_summary_model) game.aiSummaryModel = row.ai_summary_model as string;
  if (row.pre_game_teaser) game.preGameTeaser = row.pre_game_teaser as string;
  if (row.forecast_comment) game.forecastComment = row.forecast_comment as string;
  if (row.forecast_accuracy) game.forecastAccuracy = row.forecast_accuracy as Game['forecastAccuracy'];
  return game;
}

function toGamePlayer(row: Record<string, unknown>): GamePlayer {
  return {
    id: row.id as string,
    gameId: row.game_id as string,
    playerId: row.player_id as string,
    playerName: row.player_name as string,
    rebuys: Number(row.rebuys),
    chipCounts: (row.chip_counts as Record<string, number>) || {},
    finalValue: Number(row.final_value),
    profit: Number(row.profit),
  };
}

function toChipValue(row: Record<string, unknown>): ChipValue {
  return {
    id: row.id as string,
    color: row.color as string,
    value: Number(row.value),
    displayColor: row.display_color as string,
  };
}

function toSettings(row: Record<string, unknown>): Settings {
  const s: Settings = {
    rebuyValue: Number(row.rebuy_value),
    chipsPerRebuy: Number(row.chips_per_rebuy),
    minTransfer: Number(row.min_transfer),
    gameNightDays: (row.game_night_days as number[]) || [4, 6],
    locations: (row.locations as string[]) || [],
    blockedTransfers: (row.blocked_transfers as Settings['blockedTransfers']) || [],
  };
  if (row.gemini_api_key) s.geminiApiKey = row.gemini_api_key as string;
  if (row.elevenlabs_api_key) s.elevenlabsApiKey = row.elevenlabs_api_key as string;
  if (row.language) s.language = row.language as 'he' | 'en';
  return s;
}

function toSharedExpense(row: Record<string, unknown>): SharedExpense {
  return {
    id: row.id as string,
    description: row.description as string,
    paidBy: (row.paid_by as string) || '',
    paidByName: (row.paid_by_name as string) || '',
    amount: Number(row.amount),
    participants: (row.participants as string[]) || [],
    participantNames: (row.participant_names as string[]) || [],
    createdAt: row.created_at as string,
  };
}

function toForecast(row: Record<string, unknown>): GameForecast {
  return {
    playerName: row.player_name as string,
    expectedProfit: Number(row.expected_profit),
    highlight: row.highlight as string | undefined,
    sentence: row.sentence as string | undefined,
    isSurprise: row.is_surprise as boolean | undefined,
  };
}

function toPendingForecast(row: Record<string, unknown>): PendingForecast {
  const pf: PendingForecast = {
    id: row.id as string,
    createdAt: row.created_at as string,
    playerIds: (row.player_ids as string[]) || [],
    forecasts: (row.forecasts as GameForecast[]) || [],
  };
  if (row.linked_game_id) pf.linkedGameId = row.linked_game_id as string;
  if (row.pre_game_teaser) pf.preGameTeaser = row.pre_game_teaser as string;
  if (row.ai_model) pf.aiModel = row.ai_model as string;
  if (row.published != null) pf.published = row.published as boolean;
  if (row.location) pf.location = row.location as string;
  return pf;
}

// ── App → Supabase format mappers ──

function playerToRow(p: Player, groupId: string) {
  return {
    id: p.id,
    group_id: groupId,
    name: p.name,
    type: p.type,
    gender: p.gender,
    created_at: p.createdAt,
  };
}

function gameToRow(g: Game, groupId: string) {
  return {
    id: g.id,
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
    created_at: g.createdAt,
  };
}

function gamePlayerToRow(gp: GamePlayer) {
  return {
    id: gp.id,
    game_id: gp.gameId,
    player_id: gp.playerId,
    player_name: gp.playerName,
    rebuys: gp.rebuys,
    chip_counts: gp.chipCounts,
    final_value: gp.finalValue,
    profit: gp.profit,
  };
}

function chipValueToRow(cv: ChipValue, groupId: string) {
  return {
    id: cv.id,
    group_id: groupId,
    color: cv.color,
    value: cv.value,
    display_color: cv.displayColor,
  };
}

function settingsToRow(s: Settings, groupId: string) {
  return {
    group_id: groupId,
    rebuy_value: s.rebuyValue,
    chips_per_rebuy: s.chipsPerRebuy,
    min_transfer: s.minTransfer,
    game_night_days: s.gameNightDays,
    locations: s.locations,
    blocked_transfers: s.blockedTransfers,
    gemini_api_key: s.geminiApiKey || null,
    elevenlabs_api_key: s.elevenlabsApiKey || null,
    language: s.language || 'he',
  };
}

// ── Storage key mapping ──

const STORAGE_KEYS = {
  PLAYERS: 'poker_players',
  GAMES: 'poker_games',
  GAME_PLAYERS: 'poker_game_players',
  CHIP_VALUES: 'poker_chip_values',
  SETTINGS: 'poker_settings',
  PENDING_FORECAST: 'poker_pending_forecast',
};

const CHRONICLE_KEY = 'poker_chronicle_profiles';
const GRAPH_INSIGHTS_KEY = 'poker_graph_insights';

// ── Debounced sync ──

const syncTimers = new Map<string, ReturnType<typeof setTimeout>>();

function debouncedSync(key: string) {
  const existing = syncTimers.get(key);
  if (existing) clearTimeout(existing);
  syncTimers.set(key, setTimeout(() => {
    syncTimers.delete(key);
    pushToSupabase(key).catch(err => console.warn(`Supabase sync failed for ${key}:`, err));
  }, 300));
}

// ── Push changes to Supabase ──

function logSyncError(table: string, op: string, error: { message: string }) {
  console.warn(`Sync failed [${table}/${op}]:`, error.message);
}

async function pushToSupabase(key: string) {
  if (!state) return;
  const gid = state.groupId;

  switch (key) {
    case STORAGE_KEYS.PLAYERS: {
      const players = (state.data.get(key) as Player[]) || [];
      const rows = players.map(p => playerToRow(p, gid));
      if (rows.length > 0) {
        const { error } = await supabase.from('players').upsert(rows, { onConflict: 'id' });
        if (error) { logSyncError('players', 'upsert', error); break; }
      }
      const { data: existing, error: selErr } = await supabase.from('players').select('id').eq('group_id', gid);
      if (selErr) { logSyncError('players', 'select', selErr); break; }
      const currentIds = new Set(players.map(p => p.id));
      const toDelete = (existing || []).filter(r => !currentIds.has(r.id)).map(r => r.id);
      if (toDelete.length > 0) {
        const { error: delErr } = await supabase.from('players').delete().in('id', toDelete);
        if (delErr) logSyncError('players', 'delete', delErr);
      }
      break;
    }
    case STORAGE_KEYS.GAMES: {
      const games = (state.data.get(key) as Game[]) || [];
      const rows = games.map(g => gameToRow(g, gid));
      if (rows.length > 0) {
        const { error } = await supabase.from('games').upsert(rows, { onConflict: 'id' });
        if (error) { logSyncError('games', 'upsert', error); break; }
      }
      for (const game of games) {
        if (game.sharedExpenses && game.sharedExpenses.length > 0) {
          const currentExpIds = new Set(game.sharedExpenses.map(e => e.id));
          const { data: existingExps } = await supabase.from('shared_expenses').select('id').eq('game_id', game.id);
          const expToDelete = (existingExps || []).filter(r => !currentExpIds.has(r.id)).map(r => r.id);
          if (expToDelete.length > 0) {
            const { error: de } = await supabase.from('shared_expenses').delete().in('id', expToDelete);
            if (de) logSyncError('shared_expenses', 'delete', de);
          }
          const expRows = game.sharedExpenses.map(e => ({
            id: e.id,
            game_id: game.id,
            description: e.description,
            paid_by: e.paidBy,
            paid_by_name: e.paidByName,
            amount: e.amount,
            participants: e.participants,
            participant_names: e.participantNames,
            created_at: e.createdAt,
          }));
          const { error: ue } = await supabase.from('shared_expenses').upsert(expRows, { onConflict: 'id' });
          if (ue) logSyncError('shared_expenses', 'upsert', ue);
        } else {
          const { error: de } = await supabase.from('shared_expenses').delete().eq('game_id', game.id);
          if (de) logSyncError('shared_expenses', 'delete', de);
        }
        if (game.forecasts && game.forecasts.length > 0) {
          const { error: de } = await supabase.from('game_forecasts').delete().eq('game_id', game.id);
          if (de) logSyncError('game_forecasts', 'delete', de);
          const fcRows = game.forecasts.map(f => ({
            game_id: game.id,
            player_name: f.playerName,
            expected_profit: f.expectedProfit,
            highlight: f.highlight || null,
            sentence: f.sentence || null,
            is_surprise: f.isSurprise || false,
          }));
          const { error: ie } = await supabase.from('game_forecasts').insert(fcRows);
          if (ie) logSyncError('game_forecasts', 'insert', ie);
        } else {
          const { error: de } = await supabase.from('game_forecasts').delete().eq('game_id', game.id);
          if (de) logSyncError('game_forecasts', 'delete', de);
        }
        if (game.paidSettlements && game.paidSettlements.length > 0) {
          const { error: de } = await supabase.from('paid_settlements').delete().eq('game_id', game.id);
          if (de) logSyncError('paid_settlements', 'delete', de);
          const psRows = game.paidSettlements.map(ps => ({
            game_id: game.id,
            from_player: ps.from,
            to_player: ps.to,
            paid_at: ps.paidAt,
            amount: ps.amount ?? null,
            auto_closed: ps.autoClosed ?? false,
          }));
          const { error: ie } = await supabase.from('paid_settlements').insert(psRows);
          if (ie) logSyncError('paid_settlements', 'insert', ie);
        } else {
          const { error: de } = await supabase.from('paid_settlements').delete().eq('game_id', game.id);
          if (de) logSyncError('paid_settlements', 'delete', de);
        }
        if (game.periodMarkers) {
          const { error: ue } = await supabase.from('period_markers').upsert({
            game_id: game.id,
            is_first_game_of_month: game.periodMarkers.isFirstGameOfMonth,
            is_last_game_of_month: game.periodMarkers.isLastGameOfMonth,
            is_first_game_of_half: game.periodMarkers.isFirstGameOfHalf,
            is_last_game_of_half: game.periodMarkers.isLastGameOfHalf,
            is_first_game_of_year: game.periodMarkers.isFirstGameOfYear,
            is_last_game_of_year: game.periodMarkers.isLastGameOfYear,
            month_name: game.periodMarkers.monthName,
            half_label: game.periodMarkers.halfLabel,
            year: game.periodMarkers.year,
          }, { onConflict: 'game_id' });
          if (ue) logSyncError('period_markers', 'upsert', ue);
        } else {
          const { error: de } = await supabase.from('period_markers').delete().eq('game_id', game.id);
          if (de) logSyncError('period_markers', 'delete', de);
        }
      }
      const { data: existing, error: selErr } = await supabase.from('games').select('id').eq('group_id', gid);
      if (selErr) { logSyncError('games', 'select', selErr); break; }
      const currentIds = new Set(games.map(g => g.id));
      const toDelete = (existing || []).filter(r => !currentIds.has(r.id)).map(r => r.id);
      if (toDelete.length > 0) {
        const { error: delErr } = await supabase.from('games').delete().in('id', toDelete);
        if (delErr) logSyncError('games', 'delete', delErr);
      }
      break;
    }
    case STORAGE_KEYS.GAME_PLAYERS: {
      const gps = (state.data.get(key) as GamePlayer[]) || [];
      const rows = gps.map(gamePlayerToRow);
      if (rows.length > 0) {
        const { error } = await supabase.from('game_players').upsert(rows, { onConflict: 'id' });
        if (error) { logSyncError('game_players', 'upsert', error); break; }
      }
      const gameIds = [...new Set(gps.map(gp => gp.gameId))];
      if (gameIds.length > 0) {
        const { data: existing, error: selErr } = await supabase.from('game_players').select('id').in('game_id', gameIds);
        if (selErr) { logSyncError('game_players', 'select', selErr); break; }
        const currentIds = new Set(gps.map(gp => gp.id));
        const toDelete = (existing || []).filter(r => !currentIds.has(r.id)).map(r => r.id);
        if (toDelete.length > 0) {
          const { error: delErr } = await supabase.from('game_players').delete().in('id', toDelete);
          if (delErr) logSyncError('game_players', 'delete', delErr);
        }
      }
      break;
    }
    case STORAGE_KEYS.CHIP_VALUES: {
      const cvs = (state.data.get(key) as ChipValue[]) || [];
      const { error: delErr } = await supabase.from('chip_values').delete().eq('group_id', gid);
      if (delErr) { logSyncError('chip_values', 'delete', delErr); break; }
      if (cvs.length > 0) {
        const { error } = await supabase.from('chip_values').insert(cvs.map(cv => chipValueToRow(cv, gid)));
        if (error) logSyncError('chip_values', 'insert', error);
      }
      break;
    }
    case STORAGE_KEYS.SETTINGS: {
      const settings = state.data.get(key) as Settings;
      if (settings) {
        const { error } = await supabase.from('settings').upsert(settingsToRow(settings, gid), { onConflict: 'group_id' });
        if (error) logSyncError('settings', 'upsert', error);
      }
      break;
    }
    case STORAGE_KEYS.PENDING_FORECAST: {
      const pf = state.data.get(key) as PendingForecast | null;
      const { error: delErr } = await supabase.from('pending_forecasts').delete().eq('group_id', gid);
      if (delErr) { logSyncError('pending_forecasts', 'delete', delErr); break; }
      if (pf) {
        const { error } = await supabase.from('pending_forecasts').insert({
          id: pf.id,
          group_id: gid,
          player_ids: pf.playerIds,
          forecasts: pf.forecasts,
          linked_game_id: pf.linkedGameId || null,
          pre_game_teaser: pf.preGameTeaser || null,
          ai_model: pf.aiModel || null,
          published: pf.published || false,
          location: pf.location || null,
          created_at: pf.createdAt,
        });
        if (error) logSyncError('pending_forecasts', 'insert', error);
      }
      break;
    }
    case CHRONICLE_KEY: {
      const all = state.data.get(key) as Record<string, ChronicleEntry> | null;
      if (!all) {
        const { error } = await supabase.from('chronicle_profiles').delete().eq('group_id', gid);
        if (error) logSyncError('chronicle_profiles', 'delete', error);
        break;
      }
      for (const [periodKey, entry] of Object.entries(all)) {
        const { error } = await supabase.from('chronicle_profiles').upsert({
          group_id: gid,
          period_key: periodKey,
          profiles: entry.profiles,
          generated_at: entry.generatedAt,
          model: entry.model || null,
        }, { onConflict: 'group_id,period_key' });
        if (error) logSyncError('chronicle_profiles', 'upsert', error);
      }
      break;
    }
    case GRAPH_INSIGHTS_KEY: {
      const all = state.data.get(key) as Record<string, GraphInsightsEntry> | null;
      if (!all) {
        const { error } = await supabase.from('graph_insights').delete().eq('group_id', gid);
        if (error) logSyncError('graph_insights', 'delete', error);
        break;
      }
      for (const [periodKey, entry] of Object.entries(all)) {
        const { error } = await supabase.from('graph_insights').upsert({
          group_id: gid,
          period_key: periodKey,
          text: entry.text,
          generated_at: entry.generatedAt,
          model: entry.model || null,
        }, { onConflict: 'group_id,period_key' });
        if (error) logSyncError('graph_insights', 'upsert', error);
      }
      break;
    }
  }
}

// ── Data fetching helpers ──
// PostgREST defaults to max 1000 rows per request.

async function fetchAllRows(
  table: string,
  filter?: { column: string; value: string },
): Promise<Record<string, unknown>[]> {
  const PAGE = 1000;
  const all: Record<string, unknown>[] = [];
  let from = 0;
  for (;;) {
    let q = supabase.from(table).select('*');
    if (filter) q = q.eq(filter.column, filter.value);
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) { console.warn(`fetchAllRows(${table}):`, error.message); break; }
    if (!data || data.length === 0) break;
    all.push(...(data as Record<string, unknown>[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// Fetch child rows by game_id in batches — avoids RLS subquery performance issues
// and the 1000-row global limit for tables without a group_id column.
async function fetchByGameIds(
  table: string,
  gameIds: string[],
  column = 'game_id',
): Promise<Record<string, unknown>[]> {
  if (gameIds.length === 0) return [];
  const BATCH = 100;
  const batches: string[][] = [];
  for (let i = 0; i < gameIds.length; i += BATCH) {
    batches.push(gameIds.slice(i, i + BATCH));
  }
  const results = await Promise.all(batches.map(async (batch, idx) => {
    const { data, error } = await supabase.from(table).select('*').in(column, batch);
    if (error) console.warn(`${table} batch ${idx}:`, error.message);
    return (data || []) as Record<string, unknown>[];
  }));
  return results.flat();
}

// ── Public API ──

export async function initSupabaseCache(groupId: string): Promise<void> {
  const data = new Map<string, unknown>();
  const ttsPools = new Map<string, { pool: unknown; model?: string }>();

  // Phase 1: fetch essential tables in parallel (players, games, settings, chips)
  const [
    playersRows, gamesRows, chipValuesRes, settingsRes, pendingRes,
  ] = await Promise.all([
    fetchAllRows('players', { column: 'group_id', value: groupId }),
    fetchAllRows('games', { column: 'group_id', value: groupId }),
    supabase.from('chip_values').select('*').eq('group_id', groupId),
    supabase.rpc('get_group_settings', { p_group_id: groupId }) as unknown as { data: Record<string, unknown> | null; error: { message: string } | null },
    supabase.from('pending_forecasts').select('*').eq('group_id', groupId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);

  if (chipValuesRes.error) console.warn('chip_values:', chipValuesRes.error.message);
  if (settingsRes.error) console.warn('settings (RPC):', settingsRes.error.message);
  if (pendingRes.error) console.warn('pending_forecasts:', pendingRes.error.message);

  // Players
  const players = playersRows.map(r => toPlayer(r));
  data.set(STORAGE_KEYS.PLAYERS, players);

  // Player traits (keyed by player name for quick lookup)
  const playerTraits = new Map<string, PlayerTraits>();
  const playerIds = players.map(p => p.id);
  if (playerIds.length > 0) {
    const traitsRows = await fetchByGameIds('player_traits', playerIds, 'player_id');
    const idToName = new Map(players.map(p => [p.id, p.name]));
    for (const row of traitsRows) {
      const name = idToName.get(row.player_id as string);
      if (name) {
        playerTraits.set(name, {
          nickname: (row.nickname as string) || undefined,
          job: (row.job as string) || undefined,
          team: (row.team as string) || undefined,
          style: (row.style as string[]) || [],
          quirks: (row.quirks as string[]) || [],
        });
      }
    }
  }

  // Seed traits from hardcoded data if DB is empty (one-time migration)
  if (playerTraits.size === 0 && players.length > 0) {
    try {
      const { SEED_TRAITS } = await import('../utils/playerTraits');
      const nameToId = new Map(players.map(p => [p.name, p.id]));
      const seedRows: Array<{ player_id: string; nickname: string | null; job: string | null; team: string | null; style: string[]; quirks: string[] }> = [];
      for (const [name, traits] of Object.entries(SEED_TRAITS)) {
        const pid = nameToId.get(name);
        if (pid) {
          playerTraits.set(name, traits);
          seedRows.push({
            player_id: pid,
            nickname: traits.nickname || null,
            job: traits.job || null,
            team: traits.team || null,
            style: traits.style,
            quirks: traits.quirks,
          });
        }
      }
      if (seedRows.length > 0) {
        const { error: seedErr } = await supabase.from('player_traits').upsert(seedRows, { onConflict: 'player_id' });
        if (seedErr) console.warn('Trait seed failed:', seedErr);
        else console.log(`Seeded ${seedRows.length} player traits from hardcoded data`);
      }
    } catch (err) {
      console.warn('Trait seed import failed:', err);
    }
  }

  // Build game ID set for child table filtering
  const games = gamesRows.map(r => toGame(r));
  const groupGameIds = new Set(games.map(g => g.id));

  // Phase 2: fetch essential child tables by game_id in batches
  const gameIds = Array.from(groupGameIds);
  const [
    gamePlayersRows, sharedExpRows, forecastsRows, settlementsRows, periodMarkersRows,
  ] = await Promise.all([
    fetchByGameIds('game_players', gameIds),
    fetchByGameIds('shared_expenses', gameIds),
    fetchByGameIds('game_forecasts', gameIds),
    fetchByGameIds('paid_settlements', gameIds),
    fetchByGameIds('period_markers', gameIds),
  ]);

  // Games (with embedded shared_expenses, forecasts, paidSettlements, periodMarkers)
  const sharedExpByGame = new Map<string, SharedExpense[]>();
  for (const row of sharedExpRows) {
    const gameId = row.game_id as string;
    if (!sharedExpByGame.has(gameId)) sharedExpByGame.set(gameId, []);
    sharedExpByGame.get(gameId)!.push(toSharedExpense(row));
  }
  const forecastsByGame = new Map<string, GameForecast[]>();
  for (const row of forecastsRows) {
    const gameId = row.game_id as string;
    if (!forecastsByGame.has(gameId)) forecastsByGame.set(gameId, []);
    forecastsByGame.get(gameId)!.push(toForecast(row));
  }
  const settlementsByGame = new Map<string, PaidSettlement[]>();
  for (const row of settlementsRows) {
    const gameId = row.game_id as string;
    if (!settlementsByGame.has(gameId)) settlementsByGame.set(gameId, []);
    settlementsByGame.get(gameId)!.push({
      from: row.from_player as string,
      to: row.to_player as string,
      paidAt: row.paid_at as string,
      amount: row.amount != null ? Number(row.amount) : undefined,
      autoClosed: row.auto_closed === true,
    });
  }
  const periodMarkersByGame = new Map<string, Game['periodMarkers']>();
  for (const row of periodMarkersRows) {
    periodMarkersByGame.set(row.game_id as string, {
      isFirstGameOfMonth: !!row.is_first_game_of_month,
      isLastGameOfMonth: !!row.is_last_game_of_month,
      isFirstGameOfHalf: !!row.is_first_game_of_half,
      isLastGameOfHalf: !!row.is_last_game_of_half,
      isFirstGameOfYear: !!row.is_first_game_of_year,
      isLastGameOfYear: !!row.is_last_game_of_year,
      monthName: (row.month_name as string) || '',
      halfLabel: (row.half_label as string) || '',
      year: Number(row.year) || 0,
    });
  }
  for (const game of games) {
    const se = sharedExpByGame.get(game.id);
    if (se && se.length > 0) game.sharedExpenses = se;
    const fc = forecastsByGame.get(game.id);
    if (fc && fc.length > 0) game.forecasts = fc;
    const ps = settlementsByGame.get(game.id);
    if (ps && ps.length > 0) game.paidSettlements = ps;
    const pm = periodMarkersByGame.get(game.id);
    if (pm) game.periodMarkers = pm;
  }
  data.set(STORAGE_KEYS.GAMES, games);

  // Game players — already filtered to group's games by fetchByGameIds
  const gps = gamePlayersRows.map(r => toGamePlayer(r));
  data.set(STORAGE_KEYS.GAME_PLAYERS, gps);

  // Chip values (empty array → caller uses DEFAULT_CHIP_VALUES via storage.ts)
  const chipValues = (chipValuesRes.data || []).map(r => toChipValue(r as Record<string, unknown>));
  data.set(STORAGE_KEYS.CHIP_VALUES, chipValues);

  // Auto-repair: if any game_player chip_counts keys don't match chip_value IDs, fix them
  if (chipValues.length > 0 && gps.length > 0) {
    const cvIds = new Set(chipValues.map(cv => cv.id));
    const needsRepair = gps.some(gp =>
      Object.keys(gp.chipCounts).length > 0 && !Object.keys(gp.chipCounts).some(k => cvIds.has(k))
    );
    if (needsRepair) {
      console.warn('Auto-repair: chip_counts keys mismatch detected, triggering fixChipCountIds...');
      import('./migrateToSupabase').then(m => m.fixChipCountIds(groupId)).then(result => {
        console.warn('Auto-repair done:', result);
        if (result.updated > 0) window.location.reload();
      }).catch(err => console.warn('Auto-repair failed:', err));
    }
  }

  // Settings — always set the key so getSettings() merges with defaults consistently
  if (settingsRes.data) {
    data.set(STORAGE_KEYS.SETTINGS, toSettings(settingsRes.data as Record<string, unknown>));
  } else {
    data.set(STORAGE_KEYS.SETTINGS, {});
  }

  // Pending forecast
  if (pendingRes.data) {
    data.set(STORAGE_KEYS.PENDING_FORECAST, toPendingForecast(pendingRes.data as Record<string, unknown>));
  }

  // Set empty defaults for deferred data so the cache is usable immediately
  data.set(CHRONICLE_KEY, {});
  data.set(GRAPH_INSIGHTS_KEY, {});

  console.log(`Supabase cache loaded: ${games.length} games, ${gps.length} game-players, ${playersRows.length} players`);
  state = { groupId, data, ttsPools, playerTraits, initialized: true };

  // Phase 3 (deferred): load non-essential data in background after UI renders
  loadDeferredData(groupId, gameIds);
}

async function loadDeferredData(groupId: string, gameIds: string[]): Promise<void> {
  try {
    const [chroniclesRes, insightsRes, ttsRows] = await Promise.all([
      supabase.from('chronicle_profiles').select('*').eq('group_id', groupId),
      supabase.from('graph_insights').select('*').eq('group_id', groupId),
      fetchByGameIds('tts_pools', gameIds),
    ]);

    if (!state || state.groupId !== groupId) return;

    if (!chroniclesRes.error) {
      const chronicles: Record<string, ChronicleEntry> = {};
      for (const row of chroniclesRes.data || []) {
        chronicles[row.period_key as string] = {
          profiles: row.profiles as Record<string, string>,
          generatedAt: row.generated_at as string,
          model: row.model as string | undefined,
        };
      }
      state.data.set(CHRONICLE_KEY, chronicles);
    }

    if (!insightsRes.error) {
      const insights: Record<string, GraphInsightsEntry> = {};
      for (const row of insightsRes.data || []) {
        insights[row.period_key as string] = {
          text: row.text as string,
          generatedAt: row.generated_at as string,
          model: row.model as string | undefined,
        };
      }
      state.data.set(GRAPH_INSIGHTS_KEY, insights);
    }

    for (const row of ttsRows) {
      state.ttsPools.set(row.game_id as string, {
        pool: row.pool,
        model: row.model as string | undefined,
      });
    }

    window.dispatchEvent(new CustomEvent('supabase-cache-updated'));
  } catch (err) {
    console.warn('Deferred data load failed:', err);
  }
}

export function isInitialized(): boolean {
  return state?.initialized === true;
}

export function isCacheForGroup(groupId: string): boolean {
  return state?.initialized === true && state?.groupId === groupId;
}

export function resetCache(): void {
  if (state) {
    state.initialized = false;
    state.data.clear();
    state.playerTraits.clear();
  }
  state = null;
}

export function getGroupId(): string | null {
  return state?.groupId ?? null;
}

export function cacheGet<T>(key: string, defaultValue: T): T {
  if (!state) return defaultValue;
  const val = state.data.get(key);
  return val !== undefined ? (val as T) : defaultValue;
}

export function cacheSet<T>(key: string, value: T): void {
  if (!state) return;
  state.data.set(key, value);
  debouncedSync(key);
}

export function cacheRemove(key: string): void {
  if (!state) return;
  state.data.delete(key);
  debouncedSync(key);
}

export function cacheGetItem(key: string): string | null {
  if (!state) return null;
  const val = state.data.get(key);
  if (val === undefined) return null;
  return JSON.stringify(val);
}

export function cacheSetItem(key: string, value: string): void {
  if (!state) return;
  try {
    state.data.set(key, JSON.parse(value));
  } catch {
    state.data.set(key, value);
  }
  debouncedSync(key);
}

export function cacheRemoveItem(key: string): void {
  cacheRemove(key);
}

// TTS pool operations (per-game keys)
export function cacheSaveTTS(gameId: string, pool: unknown, model?: string): void {
  if (!state) return;
  state.ttsPools.set(gameId, { pool, model });
  supabase.from('tts_pools').upsert({
    game_id: gameId,
    pool,
    model: model || null,
  }, { onConflict: 'game_id' }).then(null, err => console.warn('TTS sync failed:', err));
}

export function cacheLoadTTS(gameId: string): unknown | null {
  return state?.ttsPools.get(gameId)?.pool ?? null;
}

export function cacheLoadTTSModel(gameId: string): string | null {
  return state?.ttsPools.get(gameId)?.model ?? null;
}

export function cacheDeleteTTS(gameId: string): void {
  if (!state) return;
  state.ttsPools.delete(gameId);
  supabase.from('tts_pools').delete().eq('game_id', gameId).then(null, () => {});
}

// ── Player Traits ──

export function getPlayerTraitsByName(playerName: string): PlayerTraits | undefined {
  return state?.playerTraits.get(playerName);
}

export function getAllPlayerTraits(): Map<string, PlayerTraits> {
  return state?.playerTraits ?? new Map();
}

export async function savePlayerTraits(playerId: string, playerName: string, traits: PlayerTraits): Promise<void> {
  if (!state) return;
  state.playerTraits.set(playerName, traits);
  const { error } = await supabase.from('player_traits').upsert({
    player_id: playerId,
    nickname: traits.nickname || null,
    job: traits.job || null,
    team: traits.team || null,
    style: traits.style,
    quirks: traits.quirks,
  }, { onConflict: 'player_id' });
  if (error) console.warn('Failed to save player traits:', error);
}

// ── Notifications ──

let cachedNotifications: AppNotification[] = [];

export async function fetchNotifications(): Promise<AppNotification[]> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) { console.warn('Failed to fetch notifications:', error); return []; }
  cachedNotifications = (data || []).map(r => ({
    id: r.id as string,
    groupId: r.group_id as string,
    userId: r.user_id as string,
    type: r.type as string,
    title: r.title as string,
    body: r.body as string,
    data: r.data as Record<string, unknown> | undefined,
    read: r.read as boolean,
    createdAt: r.created_at as string,
  }));
  return cachedNotifications;
}

export function getCachedNotifications(): AppNotification[] {
  return cachedNotifications;
}

export function getUnreadNotificationCount(): number {
  return cachedNotifications.filter(n => !n.read).length;
}

export async function markNotificationRead(notifId: string): Promise<void> {
  const idx = cachedNotifications.findIndex(n => n.id === notifId);
  if (idx >= 0) cachedNotifications[idx] = { ...cachedNotifications[idx], read: true };
  const { error } = await supabase.from('notifications').update({ read: true }).eq('id', notifId);
  if (error) console.warn('Failed to mark notification read:', error);
  window.dispatchEvent(new CustomEvent('supabase-cache-updated'));
}

export async function createNotification(
  groupId: string, targetUserId: string,
  type: string, title: string, body: string,
  data?: Record<string, unknown>
): Promise<void> {
  const { error } = await supabase.from('notifications').insert({
    group_id: groupId,
    user_id: targetUserId,
    type, title, body,
    data: data || null,
  });
  if (error) console.warn('Failed to create notification:', error);
}

export async function resolvePlayerUserId(groupId: string, playerName: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('get_user_id_for_player', {
    p_group_id: groupId,
    p_player_name: playerName,
  });
  if (error) { console.warn('Failed to resolve player user_id:', error); return null; }
  return data as string | null;
}

export async function getPlayerEmailForNotification(groupId: string, playerName: string): Promise<{ userId: string; email: string } | null> {
  const { data, error } = await supabase.rpc('get_player_email_for_notification', {
    p_group_id: groupId,
    p_player_name: playerName,
  });
  if (error || !data || (data as unknown[]).length === 0) return null;
  const row = (data as unknown[])[0] as { target_user_id: string; email: string };
  return { userId: row.target_user_id, email: row.email };
}

// ── Realtime subscriptions ──

type RefreshGroup = 'players' | 'games' | 'game_players' | 'settings' | 'forecast' | 'ai' | 'tts' | 'notifications';

const TABLE_TO_GROUP: Record<string, RefreshGroup> = {
  players: 'players',
  games: 'games',
  game_players: 'game_players',
  shared_expenses: 'game_players',
  game_forecasts: 'games',
  paid_settlements: 'games',
  period_markers: 'games',
  settings: 'settings',
  chip_values: 'settings',
  pending_forecasts: 'forecast',
  chronicle_profiles: 'ai',
  graph_insights: 'ai',
  tts_pools: 'tts',
  group_members: 'players',
  groups: 'settings',
  notifications: 'notifications',
  player_traits: 'players',
};

const pendingGroups = new Set<RefreshGroup>();

function scheduleRealtimeRefresh(group: RefreshGroup) {
  pendingGroups.add(group);
  if (realtimeRefreshTimer) clearTimeout(realtimeRefreshTimer);
  realtimeRefreshTimer = setTimeout(async () => {
    realtimeRefreshTimer = null;
    if (!state) return;
    const groups = new Set(pendingGroups);
    pendingGroups.clear();
    try {
      await refreshGroups(groups);
      window.dispatchEvent(new CustomEvent('supabase-cache-updated'));
    } catch (err) {
      console.warn('Realtime cache refresh failed:', err);
    }
  }, 500);
}

async function refreshGroups(groups: Set<RefreshGroup>): Promise<void> {
  if (!state) return;
  const gid = state.groupId;

  if (groups.has('players')) {
    const rows = await fetchAllRows('players', { column: 'group_id', value: gid });
    const refreshedPlayers = rows.map(r => toPlayer(r));
    state.data.set(STORAGE_KEYS.PLAYERS, refreshedPlayers);
    const pIds = refreshedPlayers.map(p => p.id);
    if (pIds.length > 0) {
      const traitRows = await fetchByGameIds('player_traits', pIds, 'player_id');
      const idToName = new Map(refreshedPlayers.map(p => [p.id, p.name]));
      state.playerTraits.clear();
      for (const row of traitRows) {
        const name = idToName.get(row.player_id as string);
        if (name) {
          state.playerTraits.set(name, {
            nickname: (row.nickname as string) || undefined,
            job: (row.job as string) || undefined,
            team: (row.team as string) || undefined,
            style: (row.style as string[]) || [],
            quirks: (row.quirks as string[]) || [],
          });
        }
      }
    }
  }

  // Lightweight refresh: only game_players + shared_expenses changed (e.g. rebuy during live game)
  if (groups.has('game_players') && !groups.has('games')) {
    const existingGames = (state.data.get(STORAGE_KEYS.GAMES) as Game[]) || [];
    const gameIds = existingGames.map(g => g.id);
    if (gameIds.length > 0) {
      const [gpRows, seRows] = await Promise.all([
        fetchByGameIds('game_players', gameIds),
        fetchByGameIds('shared_expenses', gameIds),
      ]);
      state.data.set(STORAGE_KEYS.GAME_PLAYERS, gpRows.map(r => toGamePlayer(r)));
      const seByGame = new Map<string, SharedExpense[]>();
      for (const row of seRows) {
        const id = row.game_id as string;
        if (!seByGame.has(id)) seByGame.set(id, []);
        seByGame.get(id)!.push(toSharedExpense(row));
      }
      for (const game of existingGames) {
        const se = seByGame.get(game.id);
        game.sharedExpenses = se && se.length > 0 ? se : undefined;
      }
    }
  }

  if (groups.has('games')) {
    const gamesRows = await fetchAllRows('games', { column: 'group_id', value: gid });
    const games = gamesRows.map(r => toGame(r));
    const gameIds = games.map(g => g.id);

    const [gpRows, seRows, fcRows, psRows, pmRows] = await Promise.all([
      fetchByGameIds('game_players', gameIds),
      fetchByGameIds('shared_expenses', gameIds),
      fetchByGameIds('game_forecasts', gameIds),
      fetchByGameIds('paid_settlements', gameIds),
      fetchByGameIds('period_markers', gameIds),
    ]);

    const seByGame = new Map<string, SharedExpense[]>();
    for (const row of seRows) {
      const id = row.game_id as string;
      if (!seByGame.has(id)) seByGame.set(id, []);
      seByGame.get(id)!.push(toSharedExpense(row));
    }
    const fcByGame = new Map<string, GameForecast[]>();
    for (const row of fcRows) {
      const id = row.game_id as string;
      if (!fcByGame.has(id)) fcByGame.set(id, []);
      fcByGame.get(id)!.push(toForecast(row));
    }
    const psByGame = new Map<string, PaidSettlement[]>();
    for (const row of psRows) {
      const id = row.game_id as string;
      if (!psByGame.has(id)) psByGame.set(id, []);
      psByGame.get(id)!.push({
        from: row.from_player as string,
        to: row.to_player as string,
        paidAt: row.paid_at as string,
        amount: row.amount != null ? Number(row.amount) : undefined,
        autoClosed: row.auto_closed === true,
      });
    }
    const pmByGame = new Map<string, Game['periodMarkers']>();
    for (const row of pmRows) {
      pmByGame.set(row.game_id as string, {
        isFirstGameOfMonth: !!row.is_first_game_of_month,
        isLastGameOfMonth: !!row.is_last_game_of_month,
        isFirstGameOfHalf: !!row.is_first_game_of_half,
        isLastGameOfHalf: !!row.is_last_game_of_half,
        isFirstGameOfYear: !!row.is_first_game_of_year,
        isLastGameOfYear: !!row.is_last_game_of_year,
        monthName: (row.month_name as string) || '',
        halfLabel: (row.half_label as string) || '',
        year: Number(row.year) || 0,
      });
    }
    for (const game of games) {
      const se = seByGame.get(game.id);
      if (se && se.length > 0) game.sharedExpenses = se;
      const fc = fcByGame.get(game.id);
      if (fc && fc.length > 0) game.forecasts = fc;
      const ps = psByGame.get(game.id);
      if (ps && ps.length > 0) game.paidSettlements = ps;
      const pm = pmByGame.get(game.id);
      if (pm) game.periodMarkers = pm;
    }
    state.data.set(STORAGE_KEYS.GAMES, games);
    state.data.set(STORAGE_KEYS.GAME_PLAYERS, gpRows.map(r => toGamePlayer(r)));
  }

  if (groups.has('settings')) {
    const [cvRes, sRes] = await Promise.all([
      supabase.from('chip_values').select('*').eq('group_id', gid),
      supabase.rpc('get_group_settings', { p_group_id: gid }) as unknown as { data: Record<string, unknown> | null; error: { message: string } | null },
    ]);
    if (!cvRes.error) {
      state.data.set(STORAGE_KEYS.CHIP_VALUES, (cvRes.data || []).map(r => toChipValue(r as Record<string, unknown>)));
    }
    if (!sRes.error && sRes.data) {
      state.data.set(STORAGE_KEYS.SETTINGS, toSettings(sRes.data as Record<string, unknown>));
    }
  }

  if (groups.has('forecast')) {
    const pfRes = await supabase.from('pending_forecasts').select('*').eq('group_id', gid)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!pfRes.error) {
      if (pfRes.data) {
        state.data.set(STORAGE_KEYS.PENDING_FORECAST, toPendingForecast(pfRes.data as Record<string, unknown>));
      } else {
        state.data.delete(STORAGE_KEYS.PENDING_FORECAST);
      }
    }
  }

  if (groups.has('ai')) {
    const [cRes, iRes] = await Promise.all([
      supabase.from('chronicle_profiles').select('*').eq('group_id', gid),
      supabase.from('graph_insights').select('*').eq('group_id', gid),
    ]);
    if (!cRes.error) {
      const chronicles: Record<string, ChronicleEntry> = {};
      for (const row of cRes.data || []) {
        chronicles[row.period_key as string] = {
          profiles: row.profiles as Record<string, string>,
          generatedAt: row.generated_at as string,
          model: row.model as string | undefined,
        };
      }
      state.data.set(CHRONICLE_KEY, chronicles);
    }
    if (!iRes.error) {
      const insights: Record<string, GraphInsightsEntry> = {};
      for (const row of iRes.data || []) {
        insights[row.period_key as string] = {
          text: row.text as string,
          generatedAt: row.generated_at as string,
          model: row.model as string | undefined,
        };
      }
      state.data.set(GRAPH_INSIGHTS_KEY, insights);
    }
  }

  if (groups.has('tts')) {
    const games = (state.data.get(STORAGE_KEYS.GAMES) as Game[]) || [];
    const gameIds = games.map(g => g.id);
    const ttsRows = await fetchByGameIds('tts_pools', gameIds);
    state.ttsPools.clear();
    for (const row of ttsRows) {
      state.ttsPools.set(row.game_id as string, {
        pool: row.pool,
        model: row.model as string | undefined,
      });
    }
  }

  if (groups.has('notifications')) {
    await fetchNotifications();
  }
}

export function subscribeToRealtime(): void {
  if (realtimeChannel || !state) return;

  const channel = supabase.channel('group-data-changes');

  for (const [table, group] of Object.entries(TABLE_TO_GROUP)) {
    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table } as { event: '*'; schema: 'public'; table: string },
      () => scheduleRealtimeRefresh(group)
    );
  }

  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      console.log('Realtime: subscribed to group data changes');
    }
  });

  realtimeChannel = channel;
}

export function unsubscribeFromRealtime(): void {
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  if (realtimeRefreshTimer) {
    clearTimeout(realtimeRefreshTimer);
    realtimeRefreshTimer = null;
  }
}

// ─── Push Notification Subscriptions ───

export async function savePushSubscription(
  groupId: string,
  playerName: string | null,
  subscription: PushSubscription
): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const keys = subscription.toJSON().keys;
  if (!keys?.p256dh || !keys?.auth) return;

  const { error } = await supabase.from('push_subscriptions').upsert({
    group_id: groupId,
    user_id: user.id,
    player_name: playerName,
    endpoint: subscription.endpoint,
    keys_p256dh: keys.p256dh,
    keys_auth: keys.auth,
  }, { onConflict: 'user_id,endpoint' });
  if (error) console.warn('Failed to save push subscription:', error);
}

export async function deletePushSubscription(endpoint: string): Promise<void> {
  const { error } = await supabase.from('push_subscriptions')
    .delete().eq('endpoint', endpoint);
  if (error) console.warn('Failed to delete push subscription:', error);
}

export async function getGroupPushSubscribers(groupId: string): Promise<{ playerName: string | null; endpoint: string }[]> {
  const { data, error } = await supabase.from('push_subscriptions')
    .select('player_name, endpoint')
    .eq('group_id', groupId);
  if (error) { console.warn('Failed to fetch push subs:', error); return []; }
  return (data || []).map(r => ({
    playerName: r.player_name as string | null,
    endpoint: r.endpoint as string,
  }));
}
