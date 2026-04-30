import { supabase } from './supabaseClient';
import type { RealtimeChannel } from '@supabase/supabase-js';
import type { Player, Game, GamePlayer, ChipValue, Settings, SharedExpense, GameForecast, PendingForecast, PaidSettlement, AppNotification, PlayerTraits, GamePoll, GamePollDate, GamePollVote, GamePollStatus, RsvpResponse, ComicScript, ComicStyleKey } from '../types';
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
  if (row.comic_url) game.comicUrl = row.comic_url as string;
  if (row.comic_script) game.comicScript = row.comic_script as ComicScript;
  if (row.comic_style) game.comicStyle = row.comic_style as ComicStyleKey;
  if (row.comic_generated_at) game.comicGeneratedAt = row.comic_generated_at as string;
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
  if (row.schedule_emails_enabled != null) s.scheduleEmailsEnabled = row.schedule_emails_enabled === true;
  // Default push to true if column is missing/null (matches DB default)
  s.schedulePushEnabled = row.schedule_push_enabled == null ? true : row.schedule_push_enabled === true;
  // Schedule defaults — fall back to hardcoded constants when columns are
  // missing (older DB) so the UI never crashes during migration windows.
  if (row.schedule_default_target != null) s.scheduleDefaultTarget = Number(row.schedule_default_target);
  if (row.schedule_default_delay_hours != null) s.scheduleDefaultDelayHours = Number(row.schedule_default_delay_hours);
  if (row.schedule_default_time != null) s.scheduleDefaultTime = String(row.schedule_default_time);
  if (row.schedule_default_allow_maybe != null) s.scheduleDefaultAllowMaybe = row.schedule_default_allow_maybe === true;
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

function toGamePollDate(row: Record<string, unknown>): GamePollDate {
  return {
    id: row.id as string,
    pollId: row.poll_id as string,
    proposedDate: row.proposed_date as string,
    proposedTime: (row.proposed_time as string | null) ?? null,
    location: (row.location as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

function toGamePollVote(row: Record<string, unknown>): GamePollVote {
  // created_at fell back to voted_at if the column hasn't been migrated
  // yet (pre-029 deployments). Once 029 is applied this branch never hits.
  const createdAt = (row.created_at as string | null) ?? (row.voted_at as string);
  return {
    id: row.id as string,
    pollId: row.poll_id as string,
    dateId: row.date_id as string,
    playerId: row.player_id as string,
    userId: (row.user_id as string | null) ?? null,
    response: row.response as RsvpResponse,
    comment: (row.comment as string | null) ?? null,
    votedAt: row.voted_at as string,
    createdAt,
    castByUserId: (row.cast_by_user_id as string | null) ?? null,
  };
}

function toGamePoll(row: Record<string, unknown>): GamePoll {
  return {
    id: row.id as string,
    groupId: row.group_id as string,
    createdBy: row.created_by as string,
    createdAt: row.created_at as string,
    status: row.status as GamePollStatus,
    targetPlayerCount: Number(row.target_player_count),
    expansionDelayHours: Number(row.expansion_delay_hours),
    expandedAt: (row.expanded_at as string | null) ?? null,
    confirmedDateId: (row.confirmed_date_id as string | null) ?? null,
    confirmedAt: (row.confirmed_at as string | null) ?? null,
    confirmedGameId: (row.confirmed_game_id as string | null) ?? null,
    note: (row.note as string | null) ?? null,
    defaultLocation: (row.default_location as string | null) ?? null,
    allowMaybe: row.allow_maybe !== false,
    cancellationReason: (row.cancellation_reason as string | null) ?? null,
    creationNotificationsSentAt: (row.creation_notifications_sent_at as string | null) ?? null,
    expandedNotificationsSentAt: (row.expanded_notifications_sent_at as string | null) ?? null,
    confirmedNotificationsSentAt: (row.confirmed_notifications_sent_at as string | null) ?? null,
    cancellationNotificationsSentAt: (row.cancellation_notifications_sent_at as string | null) ?? null,
    dates: [],
    votes: [],
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

function gameToRow(g: Game, groupId: string): Record<string, unknown> {
  // Always-present columns: identity + status fields every game has from
  // the moment of creation. Safe to always include.
  const row: Record<string, unknown> = {
    id: g.id,
    group_id: groupId,
    date: g.date,
    status: g.status,
    created_at: g.createdAt,
  };

  // CRITICAL — multi-device safety: optional columns are only included
  // when the local Game object actually has them set. If we wrote `null`
  // whenever local was undefined, a stale cache on another device/tab
  // could clobber a freshly-saved AI summary (or location, chip_gap, etc.)
  // just by upserting some unrelated game change. Postgres-on-conflict
  // UPDATE only touches columns present in the payload, so omitting them
  // keeps the existing DB value intact.
  //
  // `toGame` sets these only when DB has a non-null value, so:
  //   - undefined locally  ⇒  not loaded yet  ⇒  omit (preserve DB)
  //   - empty string/null  ⇒  user cleared    ⇒  send null
  //   - real value         ⇒  send value
  if (g.location !== undefined) row.location = g.location || null;
  if (g.chipGap !== undefined) row.chip_gap = g.chipGap ?? null;
  if (g.chipGapPerPlayer !== undefined) row.chip_gap_per_player = g.chipGapPerPlayer ?? null;
  if (g.aiSummary !== undefined) row.ai_summary = g.aiSummary || null;
  if (g.aiSummaryModel !== undefined) row.ai_summary_model = g.aiSummaryModel || null;
  if (g.preGameTeaser !== undefined) row.pre_game_teaser = g.preGameTeaser || null;
  if (g.forecastComment !== undefined) row.forecast_comment = g.forecastComment || null;
  if (g.forecastAccuracy !== undefined) row.forecast_accuracy = g.forecastAccuracy || null;
  if (g.comicUrl !== undefined) row.comic_url = g.comicUrl || null;
  if (g.comicScript !== undefined) row.comic_script = g.comicScript || null;
  if (g.comicStyle !== undefined) row.comic_style = g.comicStyle || null;
  if (g.comicGeneratedAt !== undefined) row.comic_generated_at = g.comicGeneratedAt || null;
  return row;
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
    schedule_emails_enabled: s.scheduleEmailsEnabled ?? false,
    schedule_push_enabled: s.schedulePushEnabled ?? true,
    schedule_default_target: s.scheduleDefaultTarget ?? 8,
    schedule_default_delay_hours: s.scheduleDefaultDelayHours ?? 48,
    schedule_default_time: s.scheduleDefaultTime ?? '21:00',
    schedule_default_allow_maybe: s.scheduleDefaultAllowMaybe ?? true,
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
  GAME_POLLS: 'poker_game_polls',
};

const CHRONICLE_KEY = 'poker_chronicle_profiles';
const GRAPH_INSIGHTS_KEY = 'poker_graph_insights';

// ── Local-write tracking (race protection) ──
//
// Realtime echoes of `games` upserts trigger a full refetch which then
// REPLACES local memory wholesale. If a user has just made a local write
// (e.g. saveGameAiSummary, saveGameComic) that hasn't yet been flushed to
// Supabase, the refetch can race and overwrite the not-yet-synced fields
// — the user sees their AI summary / comic vanish back to the old value.
//
// Fix: every save that modifies a single game row registers a timestamp
// here, and refreshGroups({games}) preserves local copies of any game
// whose last-local-write is within the protection window. After a successful
// upsert the timestamps are cleared, so subsequent realtime echoes can
// authoritatively replace local memory.
const PRESERVE_WINDOW_MS = 15_000;
const gameLocalWriteAt = new Map<string, number>();

/**
 * Mark a single game row as having a pending local write. Call this from
 * any save fn in storage.ts that mutates a specific game's column(s).
 */
export function markGameLocallyWritten(gameId: string): void {
  gameLocalWriteAt.set(gameId, Date.now());
}

function clearLocalWriteMarker(gameId: string): void {
  gameLocalWriteAt.delete(gameId);
}

function hasRecentLocalWrite(gameId: string): boolean {
  const at = gameLocalWriteAt.get(gameId);
  if (!at) return false;
  return Date.now() - at < PRESERVE_WINDOW_MS;
}

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

export async function flushSync(key: string): Promise<void> {
  const existing = syncTimers.get(key);
  if (existing) {
    clearTimeout(existing);
    syncTimers.delete(key);
  }
  await pushToSupabase(key);
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
        if (error) {
          logSyncError('games', 'upsert', error);
          // CRITICAL: surface the failure so users (and devs) see *why*
          // a save didn't stick. Without this, AI summary / comic writes
          // can silently fail (e.g. missing migration column) and then
          // get clobbered by the next realtime refresh, leading to the
          // confusing "the new format keeps falling back to the old"
          // bug. Subscribed UI can show a toast.
          window.dispatchEvent(new CustomEvent('supabase-sync-error', {
            detail: { table: 'games', op: 'upsert', message: error.message },
          }));
          break;
        }
        // Successful upsert — clear local-write markers for synced rows
        // so subsequent realtime echoes can authoritatively refresh them.
        for (const g of games) clearLocalWriteMarker(g.id);
      }

      // Collect all child rows across all games for batch operations
      const allGameIds = games.map(g => g.id);
      const allExpRows: Record<string, unknown>[] = [];
      const allExpIds = new Set<string>();
      const allFcRows: Record<string, unknown>[] = [];
      const allPsRows: Record<string, unknown>[] = [];
      const allPmRows: Record<string, unknown>[] = [];
      const gamesWithMarkers = new Set<string>();

      for (const game of games) {
        if (game.sharedExpenses && game.sharedExpenses.length > 0) {
          for (const e of game.sharedExpenses) {
            allExpIds.add(e.id);
            allExpRows.push({
              id: e.id, game_id: game.id, description: e.description,
              paid_by: e.paidBy, paid_by_name: e.paidByName, amount: e.amount,
              participants: e.participants, participant_names: e.participantNames,
              created_at: e.createdAt,
            });
          }
        }
        if (game.forecasts && game.forecasts.length > 0) {
          for (const f of game.forecasts) {
            allFcRows.push({
              game_id: game.id, player_name: f.playerName,
              expected_profit: f.expectedProfit, highlight: f.highlight || null,
              sentence: f.sentence || null, is_surprise: f.isSurprise || false,
            });
          }
        }
        if (game.paidSettlements && game.paidSettlements.length > 0) {
          for (const ps of game.paidSettlements) {
            allPsRows.push({
              game_id: game.id, from_player: ps.from, to_player: ps.to,
              paid_at: ps.paidAt, amount: ps.amount ?? null,
              auto_closed: ps.autoClosed ?? false,
            });
          }
        }
        if (game.periodMarkers) {
          gamesWithMarkers.add(game.id);
          allPmRows.push({
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
          });
        }
      }

      // Batch sync all child tables in parallel
      const UPSERT_BATCH = 200;
      await Promise.all([
        // Shared expenses: upsert all + delete orphans
        (async () => {
          if (allExpRows.length > 0) {
            for (let i = 0; i < allExpRows.length; i += UPSERT_BATCH) {
              const { error: ue } = await supabase.from('shared_expenses').upsert(allExpRows.slice(i, i + UPSERT_BATCH), { onConflict: 'id' });
              if (ue) logSyncError('shared_expenses', 'upsert', ue);
            }
          }
          if (allGameIds.length > 0) {
            const { data: existingExps } = await supabase.from('shared_expenses').select('id').in('game_id', allGameIds);
            const orphanIds = (existingExps || []).filter(r => !allExpIds.has(r.id)).map(r => r.id);
            if (orphanIds.length > 0) {
              const { error: de } = await supabase.from('shared_expenses').delete().in('id', orphanIds);
              if (de) logSyncError('shared_expenses', 'delete', de);
            }
          }
        })(),
        // Forecasts: delete all for group games, then bulk insert
        (async () => {
          if (allGameIds.length > 0) {
            const { error: de } = await supabase.from('game_forecasts').delete().in('game_id', allGameIds);
            if (de) logSyncError('game_forecasts', 'delete', de);
          }
          if (allFcRows.length > 0) {
            for (let i = 0; i < allFcRows.length; i += UPSERT_BATCH) {
              const { error: ie } = await supabase.from('game_forecasts').insert(allFcRows.slice(i, i + UPSERT_BATCH));
              if (ie) logSyncError('game_forecasts', 'insert', ie);
            }
          }
        })(),
        // Paid settlements: delete all for group games, then bulk insert
        (async () => {
          if (allGameIds.length > 0) {
            const { error: de } = await supabase.from('paid_settlements').delete().in('game_id', allGameIds);
            if (de) logSyncError('paid_settlements', 'delete', de);
          }
          if (allPsRows.length > 0) {
            for (let i = 0; i < allPsRows.length; i += UPSERT_BATCH) {
              const { error: ie } = await supabase.from('paid_settlements').insert(allPsRows.slice(i, i + UPSERT_BATCH));
              if (ie) logSyncError('paid_settlements', 'insert', ie);
            }
          }
        })(),
        // Period markers: upsert all with markers, delete orphans without
        (async () => {
          if (allPmRows.length > 0) {
            for (let i = 0; i < allPmRows.length; i += UPSERT_BATCH) {
              const { error: ue } = await supabase.from('period_markers').upsert(allPmRows.slice(i, i + UPSERT_BATCH), { onConflict: 'game_id' });
              if (ue) logSyncError('period_markers', 'upsert', ue);
            }
          }
          const noMarkerIds = allGameIds.filter(id => !gamesWithMarkers.has(id));
          if (noMarkerIds.length > 0) {
            const { error: de } = await supabase.from('period_markers').delete().in('game_id', noMarkerIds);
            if (de) logSyncError('period_markers', 'delete', de);
          }
        })(),
      ]);

      // Delete removed games
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

// Fetch + assemble all polls for a group (with their dates and votes attached).
// Returns sorted newest-first by created_at.
async function loadGamePolls(groupId: string): Promise<GamePoll[]> {
  try {
    const pollsRows = await fetchAllRows('game_polls', { column: 'group_id', value: groupId });
    if (pollsRows.length === 0) return [];
    const polls = pollsRows.map(r => toGamePoll(r));
    const pollIds = polls.map(p => p.id);

    const [dateRows, voteRows] = await Promise.all([
      fetchByGameIds('game_poll_dates', pollIds, 'poll_id'),
      fetchByGameIds('game_poll_votes', pollIds, 'poll_id'),
    ]);

    const datesByPoll = new Map<string, GamePollDate[]>();
    for (const row of dateRows) {
      const pid = row.poll_id as string;
      if (!datesByPoll.has(pid)) datesByPoll.set(pid, []);
      datesByPoll.get(pid)!.push(toGamePollDate(row));
    }
    const votesByPoll = new Map<string, GamePollVote[]>();
    for (const row of voteRows) {
      const pid = row.poll_id as string;
      if (!votesByPoll.has(pid)) votesByPoll.set(pid, []);
      votesByPoll.get(pid)!.push(toGamePollVote(row));
    }

    for (const poll of polls) {
      poll.dates = (datesByPoll.get(poll.id) || []).sort((a, b) =>
        a.proposedDate.localeCompare(b.proposedDate));
      poll.votes = votesByPoll.get(poll.id) || [];
    }

    return polls.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch (err) {
    console.warn('loadGamePolls failed:', err);
    return [];
  }
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

  // Build game ID set for child table filtering
  const games = gamesRows.map(r => toGame(r));
  const groupGameIds = new Set(games.map(g => g.id));
  const gameIds = Array.from(groupGameIds);
  const playerIds = players.map(p => p.id);

  // Phase 2: fetch child tables AND player traits AND game polls in parallel
  const [
    gamePlayersRows, sharedExpRows, forecastsRows, settlementsRows, periodMarkersRows,
    traitsRows, polls,
  ] = await Promise.all([
    fetchByGameIds('game_players', gameIds),
    fetchByGameIds('shared_expenses', gameIds),
    fetchByGameIds('game_forecasts', gameIds),
    fetchByGameIds('paid_settlements', gameIds),
    fetchByGameIds('period_markers', gameIds),
    playerIds.length > 0 ? fetchByGameIds('player_traits', playerIds, 'player_id') : Promise.resolve([]),
    loadGamePolls(groupId),
  ]);

  // Player traits (keyed by player name for quick lookup)
  const playerTraits = new Map<string, PlayerTraits>();
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

  // Game polls (with embedded dates + votes)
  data.set(STORAGE_KEYS.GAME_POLLS, polls);

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

type RefreshGroup = 'players' | 'games' | 'game_players' | 'game_children' | 'settings' | 'forecast' | 'ai' | 'tts' | 'notifications' | 'training' | 'polls';

const TABLE_TO_GROUP: Record<string, RefreshGroup> = {
  players: 'players',
  games: 'games',
  game_players: 'game_players',
  shared_expenses: 'game_players',
  game_forecasts: 'game_children',
  paid_settlements: 'game_children',
  period_markers: 'game_children',
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
  training_answers: 'training',
  training_pool: 'training',
  training_insights: 'training',
  game_polls: 'polls',
  game_poll_dates: 'polls',
  game_poll_votes: 'polls',
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

  // Lightweight refresh: only forecasts/settlements/markers changed (no game_players refetch)
  if (groups.has('game_children') && !groups.has('games')) {
    const existingGames = (state.data.get(STORAGE_KEYS.GAMES) as Game[]) || [];
    const gameIds = existingGames.map(g => g.id);
    if (gameIds.length > 0) {
      const [fcRows, psRows, pmRows] = await Promise.all([
        fetchByGameIds('game_forecasts', gameIds),
        fetchByGameIds('paid_settlements', gameIds),
        fetchByGameIds('period_markers', gameIds),
      ]);
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
      for (const game of existingGames) {
        game.forecasts = fcByGame.get(game.id) || undefined;
        game.paidSettlements = psByGame.get(game.id) || undefined;
        game.periodMarkers = pmByGame.get(game.id);
      }
    }
  }

  // Full game refresh: games table changed (new/deleted/status transition)
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

    // Race protection: preserve local copies of any games with a pending
    // local write that hasn't yet been flushed to Supabase. Without this,
    // realtime echo of an unrelated upsert can wipe an in-flight aiSummary
    // / comic save before sync completes, causing the user-visible "old
    // format keeps coming back" regression.
    const oldGames = (state.data.get(STORAGE_KEYS.GAMES) as Game[] | undefined) || [];
    if (oldGames.length > 0 && gameLocalWriteAt.size > 0) {
      const oldById = new Map(oldGames.map(g => [g.id, g]));
      for (let i = 0; i < games.length; i++) {
        const id = games[i].id;
        if (hasRecentLocalWrite(id)) {
          const local = oldById.get(id);
          if (local) {
            console.log(`[cache] Preserving local copy of game ${id} (pending sync within ${PRESERVE_WINDOW_MS}ms)`);
            games[i] = local;
          }
        }
      }
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

  if (groups.has('polls')) {
    const polls = await loadGamePolls(gid);
    state.data.set(STORAGE_KEYS.GAME_POLLS, polls);
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

// ─── Game Polls (RPC-driven) ───

export function getAllPolls(): GamePoll[] {
  return cacheGet<GamePoll[]>(STORAGE_KEYS.GAME_POLLS, []);
}

export function getPollById(pollId: string): GamePoll | undefined {
  return getAllPolls().find(p => p.id === pollId);
}

export function getConfirmedPlayerIds(pollId: string): string[] {
  const poll = getPollById(pollId);
  if (!poll || !poll.confirmedDateId) return [];
  return poll.votes
    .filter(v => v.dateId === poll.confirmedDateId && v.response === 'yes')
    .map(v => v.playerId);
}

export function getAnyResponseVoterIds(pollId: string): string[] {
  const poll = getPollById(pollId);
  if (!poll) return [];
  const ids = new Set<string>();
  for (const v of poll.votes) ids.add(v.playerId);
  return Array.from(ids);
}

async function refreshPollsNow(): Promise<void> {
  if (!state) return;
  const polls = await loadGamePolls(state.groupId);
  state.data.set(STORAGE_KEYS.GAME_POLLS, polls);
  window.dispatchEvent(new CustomEvent('supabase-cache-updated'));
}

export interface CreatePollRpcInput {
  dates: { proposedDate: string; proposedTime?: string | null; location?: string | null }[];
  targetPlayerCount?: number;
  expansionDelayHours?: number;
  defaultLocation?: string | null;
  allowMaybe?: boolean;
  note?: string | null;
}

export async function createPollRpc(input: CreatePollRpcInput): Promise<GamePoll> {
  if (!state) throw new Error('cache_not_initialized');
  const datesPayload = input.dates.map(d => ({
    proposed_date: d.proposedDate,
    proposed_time: d.proposedTime || null,
    location: d.location || null,
  }));
  const { data, error } = await supabase.rpc('create_game_poll', {
    p_group_id: state.groupId,
    p_dates: datesPayload,
    p_target: input.targetPlayerCount ?? 8,
    p_expansion_delay: input.expansionDelayHours ?? 48,
    p_default_location: input.defaultLocation || null,
    p_allow_maybe: input.allowMaybe ?? true,
    p_note: input.note || null,
  });
  if (error) throw error;
  const newId = data as string;
  await refreshPollsNow();
  const poll = getPollById(newId);
  if (!poll) throw new Error('poll_not_loaded_after_create');
  return poll;
}

export async function castPollVoteRpc(
  dateId: string,
  response: RsvpResponse,
  comment?: string | null,
): Promise<GamePoll> {
  const { data, error } = await supabase.rpc('cast_poll_vote', {
    p_date_id: dateId,
    p_response: response,
    p_comment: comment || null,
  });
  if (error) throw error;
  const rows = data as Record<string, unknown>[] | null;
  if (!rows || rows.length === 0) throw new Error('poll_not_returned');
  const poll = toGamePoll(rows[0]);
  await refreshPollsNow();
  // Return refreshed copy with dates+votes attached
  return getPollById(poll.id) ?? poll;
}

// Admin / owner / super-admin: cast or edit a vote on behalf of any
// player in the group's roster (typically used for unregistered players).
export async function adminCastPollVoteRpc(
  dateId: string,
  voterPlayerId: string,
  response: RsvpResponse,
  comment?: string | null,
): Promise<GamePoll> {
  const { data, error } = await supabase.rpc('admin_cast_poll_vote', {
    p_date_id: dateId,
    p_voter_player_id: voterPlayerId,
    p_response: response,
    p_comment: comment || null,
  });
  if (error) throw error;
  const rows = data as Record<string, unknown>[] | null;
  if (!rows || rows.length === 0) throw new Error('poll_not_returned');
  const poll = toGamePoll(rows[0]);
  await refreshPollsNow();
  return getPollById(poll.id) ?? poll;
}

export async function adminDeletePollVoteRpc(
  dateId: string,
  voterPlayerId: string,
): Promise<GamePoll> {
  const { data, error } = await supabase.rpc('admin_delete_poll_vote', {
    p_date_id: dateId,
    p_voter_player_id: voterPlayerId,
  });
  if (error) throw error;
  const rows = data as Record<string, unknown>[] | null;
  if (!rows || rows.length === 0) throw new Error('poll_not_returned');
  const poll = toGamePoll(rows[0]);
  await refreshPollsNow();
  return getPollById(poll.id) ?? poll;
}

export async function cancelPollRpc(pollId: string, reason?: string | null): Promise<void> {
  const { error } = await supabase.rpc('cancel_game_poll', {
    p_poll_id: pollId,
    p_reason: reason || null,
  });
  if (error) throw error;
  await refreshPollsNow();
}

// Permanently remove a poll and all its dates + votes. Admin-only via
// the underlying RPC. Cascades on the FKs handle child cleanup.
export async function deletePollRpc(pollId: string): Promise<void> {
  const { error } = await supabase.rpc('delete_game_poll', {
    p_poll_id: pollId,
  });
  if (error) throw error;
  await refreshPollsNow();
}

export async function manuallyClosePollRpc(pollId: string, dateId: string): Promise<void> {
  const { error } = await supabase.rpc('manual_close_game_poll', {
    p_poll_id: pollId,
    p_date_id: dateId,
  });
  if (error) throw error;
  await refreshPollsNow();
}

export async function expandPollRpc(pollId: string): Promise<void> {
  const { error } = await supabase.rpc('expand_game_poll', { p_poll_id: pollId });
  if (error) throw error;
  await refreshPollsNow();
}

export async function updatePollTargetRpc(pollId: string, target: number): Promise<void> {
  const { error } = await supabase.rpc('update_poll_target', {
    p_poll_id: pollId,
    p_new_target: target,
  });
  if (error) throw error;
  await refreshPollsNow();
}

export async function updatePollExpansionDelayRpc(pollId: string, hours: number): Promise<void> {
  const { error } = await supabase.rpc('update_poll_expansion_delay', {
    p_poll_id: pollId,
    p_new_delay: hours,
  });
  if (error) throw error;
  await refreshPollsNow();
}

export interface PollMetaPatch {
  target: number;
  expansionDelay: number;
  note: string | null;
  defaultLocation: string | null;
  allowMaybe: boolean;
}

export async function updatePollMetaRpc(pollId: string, patch: PollMetaPatch): Promise<void> {
  const { error } = await supabase.rpc('update_game_poll_meta', {
    p_poll_id: pollId,
    p_target: patch.target,
    p_expansion_delay: patch.expansionDelay,
    // Empty strings are normalized to NULL on the SQL side so the user
    // can clear note/location by submitting an empty field.
    p_note: patch.note ?? '',
    p_default_location: patch.defaultLocation ?? '',
    p_allow_maybe: patch.allowMaybe,
  });
  if (error) throw error;
  await refreshPollsNow();
}

// ─── Vote-change notifications opt-in ───────────────────
// Per-poll subscriptions stored in game_poll_change_subscribers. Admins,
// owners, and super-admins are implicitly always notified — only members
// need to opt in via the poll card toggle.

export async function subscribeToPollChangesRpc(pollId: string): Promise<void> {
  const { error } = await supabase.rpc('subscribe_to_poll_changes', { p_poll_id: pollId });
  if (error) throw error;
}

export async function unsubscribeFromPollChangesRpc(pollId: string): Promise<void> {
  const { error } = await supabase.rpc('unsubscribe_from_poll_changes', { p_poll_id: pollId });
  if (error) throw error;
}

export async function getMyPollChangeSubscriptionsRpc(): Promise<string[]> {
  const { data, error } = await supabase.rpc('get_my_poll_change_subscriptions');
  if (error) {
    console.warn('get_my_poll_change_subscriptions failed:', error);
    return [];
  }
  const rows = (data as { poll_id: string }[] | null) ?? [];
  return rows.map(r => r.poll_id);
}

export interface PollChangeRecipient {
  playerName: string;
  role: 'admin' | 'super_admin' | 'subscriber';
}

export async function getPollChangeRecipientsRpc(pollId: string): Promise<PollChangeRecipient[]> {
  const { data, error } = await supabase.rpc('get_poll_change_recipients', { p_poll_id: pollId });
  if (error) {
    console.warn('get_poll_change_recipients failed:', error);
    return [];
  }
  const rows = (data as { player_name: string; role: string }[] | null) ?? [];
  return rows.map(r => ({
    playerName: r.player_name,
    role: (r.role as PollChangeRecipient['role']),
  }));
}

// Per-(user, group) preference for receiving vote-change push pings.
// Defaults to TRUE server-side; admins use this to mute the chatty
// vote_change channel without losing the four major-update channels
// (creation / expansion / confirmation / cancellation). Migration 032.
export async function getMyVoteChangeNotifsRpc(groupId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('get_my_vote_change_notifs', {
    p_group_id: groupId,
  });
  if (error) {
    console.warn('get_my_vote_change_notifs failed:', error);
    return true;
  }
  return data !== false;
}

export async function setMyVoteChangeNotifsRpc(groupId: string, enabled: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_my_vote_change_notifs', {
    p_group_id: groupId,
    p_enabled:  enabled,
  });
  if (error) throw error;
}

export async function claimPollNotificationsRpc(
  pollId: string,
  kind: 'creation' | 'expanded' | 'confirmed' | 'cancellation',
): Promise<boolean> {
  const { data, error } = await supabase.rpc('claim_poll_notifications', {
    p_poll_id: pollId,
    p_kind: kind,
  });
  if (error) { console.warn('claim_poll_notifications failed:', error); return false; }
  return data === true;
}

export async function linkPollToGameRpc(pollId: string, gameId: string): Promise<void> {
  const { error } = await supabase.rpc('link_poll_to_game', {
    p_poll_id: pollId,
    p_game_id: gameId,
  });
  if (error) throw error;
  await refreshPollsNow();
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
