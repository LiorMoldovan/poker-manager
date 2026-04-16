import { supabase } from './supabaseClient';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { Player, Game, GamePlayer, ChipValue, Settings, SharedExpense, GameForecast, PendingForecast } from '../types';
import type { ChronicleEntry, GraphInsightsEntry } from './storage';

// ── Cache state ──

interface CacheState {
  groupId: string;
  data: Map<string, unknown>;
  ttsPools: Map<string, { pool: unknown; model?: string }>;
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
  return {
    rebuyValue: Number(row.rebuy_value),
    chipsPerRebuy: Number(row.chips_per_rebuy),
    minTransfer: Number(row.min_transfer),
    gameNightDays: (row.game_night_days as number[]) || [4, 6],
    locations: (row.locations as string[]) || [],
    blockedTransfers: (row.blocked_transfers as Settings['blockedTransfers']) || [],
  };
}

function toSharedExpense(row: Record<string, unknown>): SharedExpense {
  return {
    id: row.id as string,
    description: row.description as string,
    paidBy: row.paid_by as string,
    paidByName: row.paid_by_name as string,
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
  };
}

// ── Storage key mapping ──

const STORAGE_KEYS = {
  PLAYERS: 'poker_players',
  GAMES: 'poker_games',
  GAME_PLAYERS: 'poker_game_players',
  CHIP_VALUES: 'poker_chip_values',
  SETTINGS: 'poker_settings',
  BACKUPS: 'poker_backups',
  LAST_BACKUP_DATE: 'poker_last_backup_date',
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

async function pushToSupabase(key: string) {
  if (!state) return;
  const gid = state.groupId;

  switch (key) {
    case STORAGE_KEYS.PLAYERS: {
      const players = (state.data.get(key) as Player[]) || [];
      const rows = players.map(p => playerToRow(p, gid));
      if (rows.length > 0) {
        await supabase.from('players').upsert(rows, { onConflict: 'id' });
      }
      const { data: existing } = await supabase.from('players').select('id').eq('group_id', gid);
      const currentIds = new Set(players.map(p => p.id));
      const toDelete = (existing || []).filter(r => !currentIds.has(r.id)).map(r => r.id);
      if (toDelete.length > 0) {
        await supabase.from('players').delete().in('id', toDelete);
      }
      break;
    }
    case STORAGE_KEYS.GAMES: {
      const games = (state.data.get(key) as Game[]) || [];
      const rows = games.map(g => gameToRow(g, gid));
      if (rows.length > 0) {
        await supabase.from('games').upsert(rows, { onConflict: 'id' });
      }
      // Sync embedded shared_expenses
      for (const game of games) {
        if (game.sharedExpenses && game.sharedExpenses.length > 0) {
          const currentExpIds = new Set(game.sharedExpenses.map(e => e.id));
          const { data: existingExps } = await supabase.from('shared_expenses').select('id').eq('game_id', game.id);
          const expToDelete = (existingExps || []).filter(r => !currentExpIds.has(r.id)).map(r => r.id);
          if (expToDelete.length > 0) {
            await supabase.from('shared_expenses').delete().in('id', expToDelete);
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
          await supabase.from('shared_expenses').upsert(expRows, { onConflict: 'id' });
        } else {
          await supabase.from('shared_expenses').delete().eq('game_id', game.id);
        }
        if (game.forecasts && game.forecasts.length > 0) {
          await supabase.from('game_forecasts').delete().eq('game_id', game.id);
          const fcRows = game.forecasts.map(f => ({
            game_id: game.id,
            player_name: f.playerName,
            expected_profit: f.expectedProfit,
            highlight: f.highlight || null,
            sentence: f.sentence || null,
            is_surprise: f.isSurprise || false,
          }));
          await supabase.from('game_forecasts').insert(fcRows);
        }
        if (game.paidSettlements) {
          await supabase.from('paid_settlements').delete().eq('game_id', game.id);
          const psRows = game.paidSettlements.map(ps => ({
            game_id: game.id,
            from_player: ps.from,
            to_player: ps.to,
            paid_at: ps.paidAt,
          }));
          if (psRows.length > 0) await supabase.from('paid_settlements').insert(psRows);
        }
        if (game.periodMarkers) {
          await supabase.from('period_markers').upsert({
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
        }
      }
      // Delete games removed from cache
      const { data: existing } = await supabase.from('games').select('id').eq('group_id', gid);
      const currentIds = new Set(games.map(g => g.id));
      const toDelete = (existing || []).filter(r => !currentIds.has(r.id)).map(r => r.id);
      if (toDelete.length > 0) {
        await supabase.from('games').delete().in('id', toDelete);
      }
      break;
    }
    case STORAGE_KEYS.GAME_PLAYERS: {
      const gps = (state.data.get(key) as GamePlayer[]) || [];
      const rows = gps.map(gamePlayerToRow);
      if (rows.length > 0) {
        await supabase.from('game_players').upsert(rows, { onConflict: 'id' });
      }
      // Remove game_players that were deleted from cache
      const gameIds = [...new Set(gps.map(gp => gp.gameId))];
      if (gameIds.length > 0) {
        const { data: existing } = await supabase.from('game_players').select('id').in('game_id', gameIds);
        const currentIds = new Set(gps.map(gp => gp.id));
        const toDelete = (existing || []).filter(r => !currentIds.has(r.id)).map(r => r.id);
        if (toDelete.length > 0) {
          await supabase.from('game_players').delete().in('id', toDelete);
        }
      }
      break;
    }
    case STORAGE_KEYS.CHIP_VALUES: {
      const cvs = (state.data.get(key) as ChipValue[]) || [];
      await supabase.from('chip_values').delete().eq('group_id', gid);
      if (cvs.length > 0) {
        await supabase.from('chip_values').insert(cvs.map(cv => chipValueToRow(cv, gid)));
      }
      break;
    }
    case STORAGE_KEYS.SETTINGS: {
      const settings = state.data.get(key) as Settings;
      if (settings) {
        await supabase.from('settings').upsert(settingsToRow(settings, gid), { onConflict: 'group_id' });
      }
      break;
    }
    case STORAGE_KEYS.PENDING_FORECAST: {
      const pf = state.data.get(key) as PendingForecast | null;
      await supabase.from('pending_forecasts').delete().eq('group_id', gid);
      if (pf) {
        await supabase.from('pending_forecasts').insert({
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
      }
      break;
    }
    case CHRONICLE_KEY: {
      const all = state.data.get(key) as Record<string, ChronicleEntry> | null;
      if (!all) break;
      for (const [periodKey, entry] of Object.entries(all)) {
        await supabase.from('chronicle_profiles').upsert({
          group_id: gid,
          period_key: periodKey,
          profiles: entry.profiles,
          generated_at: entry.generatedAt,
          model: entry.model || null,
        }, { onConflict: 'group_id,period_key' });
      }
      break;
    }
    case GRAPH_INSIGHTS_KEY: {
      const all = state.data.get(key) as Record<string, GraphInsightsEntry> | null;
      if (!all) break;
      for (const [periodKey, entry] of Object.entries(all)) {
        await supabase.from('graph_insights').upsert({
          group_id: gid,
          period_key: periodKey,
          text: entry.text,
          generated_at: entry.generatedAt,
          model: entry.model || null,
        }, { onConflict: 'group_id,period_key' });
      }
      break;
    }
  }
}

// ── Public API ──

export async function initSupabaseCache(groupId: string): Promise<void> {
  const data = new Map<string, unknown>();
  const ttsPools = new Map<string, { pool: unknown; model?: string }>();

  const [
    playersRes, gamesRes, gamePlayersRes, chipValuesRes, settingsRes,
    sharedExpRes, forecastsRes, settlementsRes, periodMarkersRes, pendingRes,
    chroniclesRes, insightsRes, ttsRes,
  ] = await Promise.all([
    supabase.from('players').select('*').eq('group_id', groupId),
    supabase.from('games').select('*').eq('group_id', groupId),
    supabase.from('game_players').select('*'),
    supabase.from('chip_values').select('*').eq('group_id', groupId),
    supabase.from('settings').select('*').eq('group_id', groupId).maybeSingle(),
    supabase.from('shared_expenses').select('*'),
    supabase.from('game_forecasts').select('*'),
    supabase.from('paid_settlements').select('*'),
    supabase.from('period_markers').select('*'),
    supabase.from('pending_forecasts').select('*').eq('group_id', groupId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('chronicle_profiles').select('*').eq('group_id', groupId),
    supabase.from('graph_insights').select('*').eq('group_id', groupId),
    supabase.from('tts_pools').select('*'),
  ]);

  // Players
  data.set(STORAGE_KEYS.PLAYERS, (playersRes.data || []).map(r => toPlayer(r)));

  // Games (with embedded shared_expenses, forecasts, paidSettlements)
  const sharedExpByGame = new Map<string, SharedExpense[]>();
  for (const row of sharedExpRes.data || []) {
    const gameId = row.game_id as string;
    if (!sharedExpByGame.has(gameId)) sharedExpByGame.set(gameId, []);
    sharedExpByGame.get(gameId)!.push(toSharedExpense(row));
  }
  const forecastsByGame = new Map<string, GameForecast[]>();
  for (const row of forecastsRes.data || []) {
    const gameId = row.game_id as string;
    if (!forecastsByGame.has(gameId)) forecastsByGame.set(gameId, []);
    forecastsByGame.get(gameId)!.push(toForecast(row));
  }
  const settlementsByGame = new Map<string, { from: string; to: string; paidAt: string }[]>();
  for (const row of settlementsRes.data || []) {
    const gameId = row.game_id as string;
    if (!settlementsByGame.has(gameId)) settlementsByGame.set(gameId, []);
    settlementsByGame.get(gameId)!.push({
      from: row.from_player as string,
      to: row.to_player as string,
      paidAt: row.paid_at as string,
    });
  }
  const periodMarkersByGame = new Map<string, Game['periodMarkers']>();
  for (const row of periodMarkersRes.data || []) {
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
  const games = (gamesRes.data || []).map(r => {
    const game = toGame(r);
    const se = sharedExpByGame.get(game.id);
    if (se && se.length > 0) game.sharedExpenses = se;
    const fc = forecastsByGame.get(game.id);
    if (fc && fc.length > 0) game.forecasts = fc;
    const ps = settlementsByGame.get(game.id);
    if (ps && ps.length > 0) game.paidSettlements = ps;
    const pm = periodMarkersByGame.get(game.id);
    if (pm) game.periodMarkers = pm;
    return game;
  });
  data.set(STORAGE_KEYS.GAMES, games);

  // Filter game_players to only include games in this group
  const groupGameIds = new Set(games.map(g => g.id));
  const gps = (gamePlayersRes.data || [])
    .filter(r => groupGameIds.has(r.game_id as string))
    .map(r => toGamePlayer(r));
  data.set(STORAGE_KEYS.GAME_PLAYERS, gps);

  // Chip values
  data.set(STORAGE_KEYS.CHIP_VALUES, (chipValuesRes.data || []).map(r => toChipValue(r)));

  // Settings
  if (settingsRes.data) {
    data.set(STORAGE_KEYS.SETTINGS, toSettings(settingsRes.data));
  }

  // Pending forecast
  if (pendingRes.data) {
    data.set(STORAGE_KEYS.PENDING_FORECAST, toPendingForecast(pendingRes.data));
  }

  // Backups (not stored in Supabase — data IS the backup)
  data.set(STORAGE_KEYS.BACKUPS, []);

  // Chronicles
  const chronicles: Record<string, ChronicleEntry> = {};
  for (const row of chroniclesRes.data || []) {
    chronicles[row.period_key as string] = {
      profiles: row.profiles as Record<string, string>,
      generatedAt: row.generated_at as string,
      model: row.model as string | undefined,
    };
  }
  data.set(CHRONICLE_KEY, chronicles);

  // Graph insights
  const insights: Record<string, GraphInsightsEntry> = {};
  for (const row of insightsRes.data || []) {
    insights[row.period_key as string] = {
      text: row.text as string,
      generatedAt: row.generated_at as string,
      model: row.model as string | undefined,
    };
  }
  data.set(GRAPH_INSIGHTS_KEY, insights);

  // TTS Pools
  for (const row of ttsRes.data || []) {
    if (groupGameIds.has(row.game_id as string)) {
      ttsPools.set(row.game_id as string, {
        pool: row.pool,
        model: row.model as string | undefined,
      });
    }
  }

  state = { groupId, data, ttsPools, initialized: true };
}

export function isInitialized(): boolean {
  return state?.initialized === true;
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

// ── Realtime subscriptions ──

const REALTIME_TABLES = [
  'players', 'games', 'game_players', 'shared_expenses', 'game_forecasts',
  'paid_settlements', 'settings', 'chip_values', 'pending_forecasts',
  'chronicle_profiles', 'graph_insights',
];

function scheduleRealtimeRefresh() {
  if (realtimeRefreshTimer) clearTimeout(realtimeRefreshTimer);
  realtimeRefreshTimer = setTimeout(async () => {
    realtimeRefreshTimer = null;
    if (!state) return;
    try {
      await initSupabaseCache(state.groupId);
      window.dispatchEvent(new CustomEvent('supabase-cache-updated'));
    } catch (err) {
      console.warn('Realtime cache refresh failed:', err);
    }
  }, 500);
}

export function subscribeToRealtime(): void {
  if (realtimeChannel || !state) return;

  const channel = supabase.channel('group-data-changes');

  for (const table of REALTIME_TABLES) {
    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table } as { event: '*'; schema: 'public'; table: string },
      () => scheduleRealtimeRefresh()
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
