import { Player, PlayerType, PlayerGender, Game, GamePlayer, ChipValue, Settings, PlayerStats, PendingForecast, GameForecast, SharedExpense, AppNotification, PlayerTraits } from '../types';
import {
  cacheGet, cacheSet, cacheRemove,
  cacheGetItem, cacheSetItem, cacheRemoveItem,
  cacheSaveTTS, cacheLoadTTS, cacheLoadTTSModel, cacheDeleteTTS,
  getGroupId, resetCache, initSupabaseCache,
  fetchNotifications, getCachedNotifications, getUnreadNotificationCount,
  markNotificationRead, createNotification,
  resolvePlayerUserId, getPlayerEmailForNotification,
  getPlayerTraitsByName, getAllPlayerTraits, savePlayerTraits,
  savePushSubscription, deletePushSubscription, getGroupPushSubscribers,
} from './supabaseCache';
import { supabase } from './supabaseClient';

const STORAGE_KEYS = {
  PLAYERS: 'poker_players',
  GAMES: 'poker_games',
  GAME_PLAYERS: 'poker_game_players',
  CHIP_VALUES: 'poker_chip_values',
  SETTINGS: 'poker_settings',
  PENDING_FORECAST: 'poker_pending_forecast',
};

// Generate unique ID (UUID for Supabase rows)
export const generateId = (): string => crypto.randomUUID();

// Helper functions — delegate to Supabase in-memory cache
const getItem = <T>(key: string, defaultValue: T): T => cacheGet<T>(key, defaultValue);

const setItem = <T>(key: string, value: T): void => {
  cacheSet<T>(key, value);
};

// Default chip values
const DEFAULT_CHIP_VALUES: ChipValue[] = [
  { id: '1', color: 'White', value: 50, displayColor: '#FFFFFF' },
  { id: '2', color: 'Red', value: 100, displayColor: '#EF4444' },
  { id: '3', color: 'Blue', value: 200, displayColor: '#3B82F6' },
  { id: '4', color: 'Green', value: 500, displayColor: '#22C55E' },
  { id: '5', color: 'Black', value: 1000, displayColor: '#000000' },
  { id: '6', color: 'Yellow', value: 5000, displayColor: '#EAB308' },
];

const DEFAULT_SETTINGS: Settings = {
  rebuyValue: 30,
  chipsPerRebuy: 10000,
  minTransfer: 5,
  gameNightDays: [4, 6],
  locations: [],
  blockedTransfers: [],
};

// Players
export const getAllPlayers = (): Player[] => {
  const players = getItem<Player[]>(STORAGE_KEYS.PLAYERS, []);
  let migrated = false;
  for (const p of players) {
    if (!p.gender) {
      p.gender = p.name === 'מור' ? 'female' : 'male';
      migrated = true;
    }
  }
  if (migrated) setItem(STORAGE_KEYS.PLAYERS, players);
  return players;
};

export const addPlayer = (name: string, type: PlayerType = 'permanent', gender: PlayerGender = 'male'): Player => {
  const players = getAllPlayers();
  const newPlayer: Player = {
    id: generateId(),
    name,
    createdAt: new Date().toISOString(),
    type,
    gender,
  };
  players.push(newPlayer);
  setItem(STORAGE_KEYS.PLAYERS, players);
  return newPlayer;
};

export const updatePlayerGender = (playerId: string, gender: PlayerGender): void => {
  const players = getAllPlayers();
  const player = players.find(p => p.id === playerId);
  if (player) {
    player.gender = gender;
    setItem(STORAGE_KEYS.PLAYERS, players);
  }
};

// Update player type
export const updatePlayerType = (playerId: string, type: PlayerType): void => {
  const players = getAllPlayers();
  const player = players.find(p => p.id === playerId);
  if (player) {
    player.type = type;
    setItem(STORAGE_KEYS.PLAYERS, players);
  }
};

// Update player name and migrate all historical data
export const updatePlayerName = (playerId: string, newName: string): boolean => {
  const players = getAllPlayers();
  const player = players.find(p => p.id === playerId);
  
  if (!player) return false;
  
  // Check if new name already exists (different player)
  const existingPlayer = players.find(p => p.name.toLowerCase() === newName.toLowerCase() && p.id !== playerId);
  if (existingPlayer) return false;
  
  // Update player name
  player.name = newName;
  setItem(STORAGE_KEYS.PLAYERS, players);
  
  // Update all GamePlayer entries with this playerId
  const gamePlayers = getItem<GamePlayer[]>(STORAGE_KEYS.GAME_PLAYERS, []);
  gamePlayers.forEach(gp => {
    if (gp.playerId === playerId) {
      gp.playerName = newName;
    }
  });
  setItem(STORAGE_KEYS.GAME_PLAYERS, gamePlayers);
  
  return true;
};

export const playerHasGames = (playerId: string): boolean => {
  return getAllGamePlayers().some(gp => gp.playerId === playerId);
};

export const deletePlayer = (id: string): void => {
  const players = getAllPlayers().filter(p => p.id !== id);
  setItem(STORAGE_KEYS.PLAYERS, players);
};

export const getPlayerByName = (name: string): Player | undefined => {
  return getAllPlayers().find(p => p.name.toLowerCase() === name.toLowerCase());
};

export const isPlayerFemale = (name: string): boolean => {
  const player = getAllPlayers().find(p => p.name === name);
  return player?.gender === 'female';
};

// Games
export const getAllGames = (): Game[] => {
  return getItem<Game[]>(STORAGE_KEYS.GAMES, []);
};

export const getGame = (id: string): Game | undefined => {
  return getAllGames().find(g => g.id === id);
};

// Get active game (live or chip_entry status) - returns the most recent one if multiple exist
export const getActiveGame = (): Game | undefined => {
  const games = getAllGames();
  const activeGames = games.filter(g => g.status === 'live' || g.status === 'chip_entry');
  if (activeGames.length === 0) return undefined;
  // Return the most recent one (by createdAt)
  return activeGames.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
};

export const createGame = (playerIds: string[], location?: string, forecasts?: { playerName: string; expectedProfit: number; sentence?: string }[]): Game => {
  const games = getAllGames();
  const players = getAllPlayers();
  const gamePlayers = getItem<GamePlayer[]>(STORAGE_KEYS.GAME_PLAYERS, []);
  
  const newGame: Game = {
    id: generateId(),
    date: new Date().toISOString(),
    status: 'live',
    createdAt: new Date().toISOString(),
    ...(location && { location }), // Only add location if provided
    ...(forecasts && forecasts.length > 0 && { forecasts }), // Store forecasts if provided
  };
  
  // Create GamePlayer entries
  playerIds.forEach(playerId => {
    const player = players.find(p => p.id === playerId);
    if (player) {
      gamePlayers.push({
        id: generateId(),
        gameId: newGame.id,
        playerId,
        playerName: player.name,
        rebuys: 1, // Start with 1 buy-in
        chipCounts: {},
        finalValue: 0,
        profit: 0,
      });
    }
  });
  
  games.push(newGame);
  setItem(STORAGE_KEYS.GAMES, games);
  setItem(STORAGE_KEYS.GAME_PLAYERS, gamePlayers);
  
  return newGame;
};

export const updateGameStatus = (gameId: string, status: Game['status']): void => {
  const games = getAllGames();
  const gameIndex = games.findIndex(g => g.id === gameId);
  if (gameIndex !== -1) {
    games[gameIndex].status = status;
    setItem(STORAGE_KEYS.GAMES, games);
  }
};

export const updateGameChipGap = (gameId: string, chipGap: number, chipGapPerPlayer: number): void => {
  const games = getAllGames();
  const gameIndex = games.findIndex(g => g.id === gameId);
  if (gameIndex !== -1) {
    games[gameIndex].chipGap = chipGap;
    games[gameIndex].chipGapPerPlayer = chipGapPerPlayer;
    setItem(STORAGE_KEYS.GAMES, games);
  }
};

export const updateGame = (gameId: string, updates: Partial<Game>): void => {
  const games = getAllGames();
  const gameIndex = games.findIndex(g => g.id === gameId);
  if (gameIndex !== -1) {
    games[gameIndex] = { ...games[gameIndex], ...updates };
    setItem(STORAGE_KEYS.GAMES, games);
  }
};

// Add a shared expense to a game
export const addSharedExpense = (gameId: string, expense: SharedExpense): void => {
  const games = getAllGames();
  const gameIndex = games.findIndex(g => g.id === gameId);
  if (gameIndex !== -1) {
    const game = games[gameIndex];
    game.sharedExpenses = game.sharedExpenses || [];
    game.sharedExpenses.push(expense);
    setItem(STORAGE_KEYS.GAMES, games);
  }
};

// Remove a shared expense from a game
export const removeSharedExpense = (gameId: string, expenseId: string): void => {
  const games = getAllGames();
  const gameIndex = games.findIndex(g => g.id === gameId);
  if (gameIndex !== -1) {
    const game = games[gameIndex];
    if (game.sharedExpenses) {
      game.sharedExpenses = game.sharedExpenses.filter(e => e.id !== expenseId);
      setItem(STORAGE_KEYS.GAMES, games);
    }
  }
};

// Update a shared expense in a game
export const updateSharedExpense = (gameId: string, expense: SharedExpense): void => {
  const games = getAllGames();
  const gameIndex = games.findIndex(g => g.id === gameId);
  if (gameIndex !== -1) {
    const game = games[gameIndex];
    if (game.sharedExpenses) {
      const expenseIndex = game.sharedExpenses.findIndex(e => e.id === expense.id);
      if (expenseIndex !== -1) {
        game.sharedExpenses[expenseIndex] = expense;
        setItem(STORAGE_KEYS.GAMES, games);
      }
    }
  }
};

export const deleteGame = (id: string): void => {
  const games = getAllGames().filter(g => g.id !== id);
  const gamePlayers = getItem<GamePlayer[]>(STORAGE_KEYS.GAME_PLAYERS, []).filter(gp => gp.gameId !== id);
  setItem(STORAGE_KEYS.GAMES, games);
  setItem(STORAGE_KEYS.GAME_PLAYERS, gamePlayers);
};


// Game Players
export const getGamePlayers = (gameId: string): GamePlayer[] => {
  return getItem<GamePlayer[]>(STORAGE_KEYS.GAME_PLAYERS, []).filter(gp => gp.gameId === gameId);
};

export const getAllGamePlayers = (): GamePlayer[] => {
  return getItem<GamePlayer[]>(STORAGE_KEYS.GAME_PLAYERS, []);
};

// Remove a player from an active game (player didn't show up)
export const removeGamePlayer = (gamePlayerId: string): boolean => {
  const gamePlayers = getItem<GamePlayer[]>(STORAGE_KEYS.GAME_PLAYERS, []);
  const index = gamePlayers.findIndex(gp => gp.id === gamePlayerId);
  if (index !== -1) {
    // Only allow removal if player hasn't bought in yet (rebuys = 1 means initial buyin only)
    const player = gamePlayers[index];
    if (player.rebuys <= 1) {
      gamePlayers.splice(index, 1);
      setItem(STORAGE_KEYS.GAME_PLAYERS, gamePlayers);
      return true;
    }
  }
  return false;
};

export const updateGamePlayerRebuys = (gamePlayerId: string, rebuys: number): void => {
  const gamePlayers = getItem<GamePlayer[]>(STORAGE_KEYS.GAME_PLAYERS, []);
  const index = gamePlayers.findIndex(gp => gp.id === gamePlayerId);
  if (index !== -1) {
    gamePlayers[index].rebuys = rebuys;
    setItem(STORAGE_KEYS.GAME_PLAYERS, gamePlayers);
  }
};

export const updateGamePlayerChips = (gamePlayerId: string, chipCounts: Record<string, number>): void => {
  const gamePlayers = getItem<GamePlayer[]>(STORAGE_KEYS.GAME_PLAYERS, []);
  const index = gamePlayers.findIndex(gp => gp.id === gamePlayerId);
  if (index !== -1) {
    gamePlayers[index].chipCounts = chipCounts;
    setItem(STORAGE_KEYS.GAME_PLAYERS, gamePlayers);
  }
};

export const updateGamePlayerResults = (gamePlayerId: string, finalValue: number, profit: number): void => {
  const gamePlayers = getItem<GamePlayer[]>(STORAGE_KEYS.GAME_PLAYERS, []);
  const index = gamePlayers.findIndex(gp => gp.id === gamePlayerId);
  if (index !== -1) {
    gamePlayers[index].finalValue = finalValue;
    gamePlayers[index].profit = profit;
    setItem(STORAGE_KEYS.GAME_PLAYERS, gamePlayers);
  }
};

// Chip Values
export const getChipValues = (): ChipValue[] => {
  const values = getItem<ChipValue[]>(STORAGE_KEYS.CHIP_VALUES, DEFAULT_CHIP_VALUES);
  return values.length > 0 ? values : DEFAULT_CHIP_VALUES;
};

export const saveChipValue = (chipValue: Omit<ChipValue, 'id'> & { id?: string }): ChipValue => {
  const chipValues = getChipValues();
  if (chipValue.id) {
    const index = chipValues.findIndex(cv => cv.id === chipValue.id);
    if (index !== -1) {
      chipValues[index] = chipValue as ChipValue;
    }
  } else {
    const newChipValue = { ...chipValue, id: generateId() } as ChipValue;
    chipValues.push(newChipValue);
    setItem(STORAGE_KEYS.CHIP_VALUES, chipValues);
    return newChipValue;
  }
  setItem(STORAGE_KEYS.CHIP_VALUES, chipValues);
  return chipValue as ChipValue;
};

export const deleteChipValue = (id: string): void => {
  const chipValues = getChipValues().filter(cv => cv.id !== id);
  setItem(STORAGE_KEYS.CHIP_VALUES, chipValues);
};

// Settings
export const getSettings = (): Settings => {
  const stored = getItem<Partial<Settings>>(STORAGE_KEYS.SETTINGS, {});
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  if (stored.gameNightDays?.length === 0 && DEFAULT_SETTINGS.gameNightDays?.length) {
    merged.gameNightDays = DEFAULT_SETTINGS.gameNightDays;
  }
  return merged;
};

export const saveSettings = (settings: Settings): void => {
  setItem(STORAGE_KEYS.SETTINGS, settings);
};


// Player Statistics
export const getPlayerStats = (dateFilter?: { start?: Date; end?: Date }): PlayerStats[] => {
  const players = getAllPlayers();
  const allGamePlayers = getItem<GamePlayer[]>(STORAGE_KEYS.GAME_PLAYERS, []);
  let games = getAllGames().filter(g => g.status === 'completed');
  
  // Apply date filter if provided
  if (dateFilter) {
    games = games.filter(g => {
      const gameDate = new Date(g.date || g.createdAt);
      if (dateFilter.start && gameDate < dateFilter.start) return false;
      if (dateFilter.end && gameDate > dateFilter.end) return false;
      return true;
    });
  }
  
  const completedGameIds = new Set(games.map(g => g.id));
  
  // Sort games by date for streak calculation
  const sortedGames = [...games].sort((a, b) => 
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
  
  return players.map(player => {
    const playerGames = allGamePlayers.filter(
      gp => gp.playerId === player.id && completedGameIds.has(gp.gameId)
    );
    
    // Sort player games by game date
    const sortedPlayerGames = [...playerGames].sort((a, b) => {
      const gameA = sortedGames.find(g => g.id === a.gameId);
      const gameB = sortedGames.find(g => g.id === b.gameId);
      if (!gameA || !gameB) return 0;
      return new Date(gameA.createdAt).getTime() - new Date(gameB.createdAt).getTime();
    });
    
    const gamesPlayed = playerGames.length;
    const totalProfit = playerGames.reduce((sum, pg) => sum + pg.profit, 0);
    const winCount = playerGames.filter(pg => pg.profit > 0).length;
    const lossCount = playerGames.filter(pg => pg.profit < 0).length;
    const totalRebuys = playerGames.reduce((sum, pg) => sum + pg.rebuys, 0);
    
    // Calculate total gains (sum of positive profits) and total losses (sum of negative profits as positive)
    const winningGames = playerGames.filter(pg => pg.profit > 0);
    const losingGames = playerGames.filter(pg => pg.profit < 0);
    const totalGains = winningGames.reduce((sum, pg) => sum + pg.profit, 0);
    const totalLosses = Math.abs(losingGames.reduce((sum, pg) => sum + pg.profit, 0));
    
    const profits = playerGames.map(pg => pg.profit);
    const biggestWin = profits.length > 0 ? Math.max(...profits, 0) : 0;
    const biggestLoss = profits.length > 0 ? Math.min(...profits, 0) : 0;
    
    // Calculate streaks
    let currentStreak = 0;
    let longestWinStreak = 0;
    let longestLossStreak = 0;
    let tempWinStreak = 0;
    let tempLossStreak = 0;
    
    for (const pg of sortedPlayerGames) {
      if (pg.profit > 0) {
        tempWinStreak++;
        tempLossStreak = 0;
        if (tempWinStreak > longestWinStreak) longestWinStreak = tempWinStreak;
      } else if (pg.profit < 0) {
        tempLossStreak++;
        tempWinStreak = 0;
        if (tempLossStreak > longestLossStreak) longestLossStreak = tempLossStreak;
      } else {
        // Break-even (profit === 0) breaks both streaks
        tempWinStreak = 0;
        tempLossStreak = 0;
      }
    }
    
    // Calculate current streak (from most recent games)
    // Break-even (profit === 0) breaks streaks
    for (let i = sortedPlayerGames.length - 1; i >= 0; i--) {
      const profit = sortedPlayerGames[i].profit;
      if (profit > 0) {
        if (currentStreak >= 0) currentStreak++;
        else break;
      } else if (profit < 0) {
        if (currentStreak <= 0) currentStreak--;
        else break;
      } else {
        // Break-even (profit === 0) breaks the streak
        break;
      }
    }
    
    // ALL game results (most recent first) with dates and gameId
    // We need ALL games for accurate year/month/period calculations!
    const lastGameResults = sortedPlayerGames
      .slice() // Take ALL games, not just last 6!
      .reverse()
      .map(pg => {
        const game = sortedGames.find(g => g.id === pg.gameId);
        return {
          profit: pg.profit,
          date: game ? game.date || game.createdAt : '',
          gameId: pg.gameId
        };
      });
    
    // Average stats
    const avgRebuysPerGame = gamesPlayed > 0 ? totalRebuys / gamesPlayed : 0;
    const avgWin = winCount > 0 ? totalGains / winCount : 0;
    const avgLoss = lossCount > 0 ? totalLosses / lossCount : 0;
    
    return {
      playerId: player.id,
      playerName: player.name,
      gamesPlayed,
      totalProfit,
      totalGains,
      totalLosses,
      avgProfit: gamesPlayed > 0 ? totalProfit / gamesPlayed : 0,
      winCount,
      lossCount,
      winPercentage: gamesPlayed > 0 ? (winCount / gamesPlayed) * 100 : 0,
      totalRebuys,
      biggestWin,
      biggestLoss,
      currentStreak,
      longestWinStreak,
      longestLossStreak,
      lastGameResults,
      avgRebuysPerGame,
      avgWin,
      avgLoss,
    };
  }).filter(stats => stats.gamesPlayed > 0);
};



// ==================== BACKUP ====================

interface BackupData {
  id: string;
  date: string;
  type: 'auto' | 'manual';
  trigger?: 'friday' | 'game-end';
  players: Player[];
  games: Game[];
  gamePlayers: GamePlayer[];
  chipValues: ChipValue[];
  settings: Settings;
  chronicleProfiles?: Record<string, ChronicleEntry>;
  graphInsights?: Record<string, GraphInsightsEntry>;
}

const createBackup = (type: 'auto' | 'manual' = 'manual', trigger?: 'friday' | 'game-end'): BackupData => {
  const chronicleRaw = cacheGetItem(CHRONICLE_STORAGE_KEY);
  const insightsRaw = cacheGetItem(GRAPH_INSIGHTS_KEY);

  const backup: BackupData = {
    id: generateId(),
    date: new Date().toISOString(),
    type,
    trigger: type === 'auto' ? trigger : undefined,
    players: getAllPlayers(),
    games: getAllGames(),
    gamePlayers: getItem<GamePlayer[]>(STORAGE_KEYS.GAME_PLAYERS, []),
    chipValues: getChipValues(),
    settings: getSettings(),
    chronicleProfiles: chronicleRaw ? JSON.parse(chronicleRaw) : {},
    graphInsights: insightsRaw ? JSON.parse(insightsRaw) : {},
  };

  const groupId = getGroupId();
  if (groupId) {
    supabase.from('backups').insert({
      id: backup.id,
      group_id: groupId,
      type: backup.type,
      trigger: backup.trigger || null,
      data: {
        players: backup.players,
        games: backup.games,
        gamePlayers: backup.gamePlayers,
        chipValues: backup.chipValues,
        settings: backup.settings,
        chronicleProfiles: backup.chronicleProfiles,
        graphInsights: backup.graphInsights,
      },
      created_at: backup.date,
    }).then(({ error }) => {
      if (error) console.warn('Backup save to DB failed:', error.message);
      else supabase.rpc('prune_old_backups', { p_group_id: groupId }).then(null, () => {});
    });
  }

  return backup;
};

export const createGameEndBackup = (): void => {
  createBackup('auto', 'game-end');
};

// ========== Pending Forecast Management ==========

// Get pending forecast (if exists)
export const getPendingForecast = (): PendingForecast | null => {
  return getItem<PendingForecast | null>(STORAGE_KEYS.PENDING_FORECAST, null);
};

// Save pending forecast
export const savePendingForecast = (playerIds: string[], forecasts: GameForecast[], preGameTeaser?: string, aiModel?: string, location?: string): PendingForecast => {
  const pendingForecast: PendingForecast = {
    id: generateId(),
    createdAt: new Date().toISOString(),
    playerIds,
    forecasts,
    ...(preGameTeaser && { preGameTeaser }),
    ...(aiModel && { aiModel }),
    ...(location && { location }),
  };
  setItem(STORAGE_KEYS.PENDING_FORECAST, pendingForecast);
  return pendingForecast;
};

// Link pending forecast to a game
export const linkForecastToGame = (gameId: string): void => {
  const pending = getPendingForecast();
  if (pending) {
    pending.linkedGameId = gameId;
    setItem(STORAGE_KEYS.PENDING_FORECAST, pending);
    
    const games = getItem<Game[]>(STORAGE_KEYS.GAMES, []);
    const gameIndex = games.findIndex(g => g.id === gameId);
    if (gameIndex !== -1) {
      games[gameIndex].forecasts = pending.forecasts;
      if (pending.preGameTeaser) {
        games[gameIndex].preGameTeaser = pending.preGameTeaser;
      }
      setItem(STORAGE_KEYS.GAMES, games);
    }
  }
};

// Clear pending forecast
export const clearPendingForecast = (): void => {
  cacheRemove(STORAGE_KEYS.PENDING_FORECAST);
};

// Publish/unpublish pending forecast (makes it visible to all roles)
export const publishPendingForecast = (publish: boolean): void => {
  const pending = getPendingForecast();
  if (pending) {
    pending.published = publish;
    setItem(STORAGE_KEYS.PENDING_FORECAST, pending);
  }
};

// Check if pending forecast matches current players (100% match)
export const checkForecastMatch = (currentPlayerIds: string[]): { 
  matches: boolean; 
  pending: PendingForecast | null;
  addedPlayers: string[];
  removedPlayers: string[];
} => {
  const pending = getPendingForecast();
  
  if (!pending) {
    return { matches: false, pending: null, addedPlayers: [], removedPlayers: [] };
  }
  
  const pendingSet = new Set(pending.playerIds);
  const currentSet = new Set(currentPlayerIds);
  
  // Find players added (in current but not in pending)
  const addedPlayers = currentPlayerIds.filter(id => !pendingSet.has(id));
  
  // Find players removed (in pending but not in current)
  const removedPlayers = pending.playerIds.filter(id => !currentSet.has(id));
  
  const matches = addedPlayers.length === 0 && removedPlayers.length === 0;
  
  return { matches, pending, addedPlayers, removedPlayers };
};

// Get forecast comparison for a completed game
export const getForecastComparison = (gameId: string): {
  hasComparison: boolean;
  comparisons: Array<{
    playerName: string;
    forecast: number;
    actual: number;
    gap: number;
    accuracyPercent: number;
    directionCorrect: boolean;
  }>;
  overallAccuracy: number;
  directionHits: number;
  directionTotal: number;
  missingFromGame: string[];
  missingFromForecast: string[];
} | null => {
  const game = getGame(gameId);
  if (!game || !game.forecasts || game.forecasts.length === 0) {
    return null;
  }
  
  const gamePlayers = getGamePlayers(gameId);
  if (gamePlayers.length === 0) {
    return null;
  }
  
  const comparisons: Array<{
    playerName: string;
    forecast: number;
    actual: number;
    gap: number;
    accuracyPercent: number;
    directionCorrect: boolean;
  }> = [];
  
  const forecastNames = new Set(game.forecasts.map(f => f.playerName));
  const gamePlayerNames = new Set(gamePlayers.map(p => p.playerName));
  
  const missingFromGame = game.forecasts
    .filter(f => !gamePlayerNames.has(f.playerName))
    .map(f => f.playerName);
  
  const missingFromForecast = gamePlayers
    .filter(p => !forecastNames.has(p.playerName))
    .map(p => p.playerName);
  
  for (const forecast of game.forecasts) {
    const gamePlayer = gamePlayers.find(p => p.playerName === forecast.playerName);
    if (gamePlayer) {
      const gap = Math.abs(forecast.expectedProfit - gamePlayer.profit);
      const accuracyPercent = Math.max(0, 100 - (gap / 5));
      const directionCorrect = (forecast.expectedProfit >= 0 && gamePlayer.profit >= 0) ||
                               (forecast.expectedProfit < 0 && gamePlayer.profit < 0);
      
      comparisons.push({
        playerName: forecast.playerName,
        forecast: forecast.expectedProfit,
        actual: gamePlayer.profit,
        gap,
        accuracyPercent,
        directionCorrect,
      });
    }
  }
  
  const overallAccuracy = comparisons.length > 0
    ? comparisons.reduce((sum, c) => sum + c.accuracyPercent, 0) / comparisons.length
    : 0;
  
  const directionHits = comparisons.filter(c => c.directionCorrect).length;
  
  return {
    hasComparison: true,
    comparisons,
    overallAccuracy,
    directionHits,
    directionTotal: comparisons.length,
    missingFromGame,
    missingFromForecast,
  };
};

// Save forecast accuracy data on a game record (called after game completes)
export const saveForecastAccuracy = (gameId: string): void => {
  const comparison = getForecastComparison(gameId);
  if (!comparison || !comparison.hasComparison) return;
  
  const games = getItem<Game[]>(STORAGE_KEYS.GAMES, []);
  const gameIndex = games.findIndex(g => g.id === gameId);
  if (gameIndex === -1) return;
  
  const { comparisons, directionHits, directionTotal } = comparison;
  const avgGap = comparisons.length > 0 
    ? Math.round(comparisons.reduce((sum, c) => sum + c.gap, 0) / comparisons.length)
    : 0;
  
  const accurate = comparisons.filter(c => c.gap <= 30).length;
  const close = comparisons.filter(c => c.gap > 30 && c.gap <= 60).length;
  const maxScore = comparisons.length * 2;
  const score = maxScore > 0 ? Math.round(((accurate * 2 + close * 1) / maxScore) * 100) : 0;
  
  games[gameIndex].forecastAccuracy = {
    directionHits,
    totalPlayers: directionTotal,
    avgGap,
    score,
  };
  
  setItem(STORAGE_KEYS.GAMES, games);
};

// Save forecast AI comment on game record (so it's not re-generated)
export const saveForecastComment = (gameId: string, comment: string): void => {
  const games = getItem<Game[]>(STORAGE_KEYS.GAMES, []);
  const gameIndex = games.findIndex(g => g.id === gameId);
  if (gameIndex !== -1) {
    games[gameIndex].forecastComment = comment;
    setItem(STORAGE_KEYS.GAMES, games);
  }
};

// Save AI-generated game night summary on game record (so it's not re-generated)
export const saveGameAiSummary = (gameId: string, summary: string, model?: string): void => {
  const games = getItem<Game[]>(STORAGE_KEYS.GAMES, []);
  const gameIndex = games.findIndex(g => g.id === gameId);
  if (gameIndex !== -1) {
    games[gameIndex].aiSummary = summary;
    if (model) games[gameIndex].aiSummaryModel = model;
    setItem(STORAGE_KEYS.GAMES, games);
  }
};


// ========== Chronicle Profiles (AI-generated player stories) ==========

const CHRONICLE_STORAGE_KEY = 'poker_chronicle_profiles';

export interface ChronicleEntry {
  profiles: Record<string, string>;
  generatedAt: string;
  model?: string;
}

export const getChronicleProfiles = (periodKey: string): ChronicleEntry | null => {
  const raw = cacheGetItem(CHRONICLE_STORAGE_KEY);
  if (!raw) return null;
  try {
    const all: Record<string, ChronicleEntry> = JSON.parse(raw);
    return all[periodKey] || null;
  } catch {
    return null;
  }
};

export const saveChronicleProfiles = (periodKey: string, profiles: Record<string, string>, model?: string): void => {
  const raw = cacheGetItem(CHRONICLE_STORAGE_KEY);
  const all: Record<string, ChronicleEntry> = raw ? JSON.parse(raw) : {};
  all[periodKey] = { profiles, generatedAt: new Date().toISOString(), model };
  cacheSetItem(CHRONICLE_STORAGE_KEY, JSON.stringify(all));
};


// ========== Graph Insights (AI-generated group narrative for Graphs page) ==========

const GRAPH_INSIGHTS_KEY = 'poker_graph_insights';

export interface GraphInsightsEntry {
  text: string;
  generatedAt: string;
  model?: string;
}

export const getGraphInsights = (periodKey: string): GraphInsightsEntry | null => {
  const raw = cacheGetItem(GRAPH_INSIGHTS_KEY);
  if (!raw) return null;
  try {
    const all: Record<string, GraphInsightsEntry> = JSON.parse(raw);
    return all[periodKey] || null;
  } catch {
    return null;
  }
};

export const saveGraphInsights = (periodKey: string, text: string, model?: string): void => {
  const raw = cacheGetItem(GRAPH_INSIGHTS_KEY);
  const all: Record<string, GraphInsightsEntry> = raw ? JSON.parse(raw) : {};
  all[periodKey] = { text, generatedAt: new Date().toISOString(), model };
  cacheSetItem(GRAPH_INSIGHTS_KEY, JSON.stringify(all));
};


export const invalidateAICaches = (): void => {
  cacheRemoveItem(CHRONICLE_STORAGE_KEY);
  cacheRemoveItem(GRAPH_INSIGHTS_KEY);
};

// --- Rebuy Records (2026+) ---

export interface RebuyRecords {
  playerMax: Map<string, number>;
  groupMax: number;
  groupMaxHolder: string;
}

export const getRebuyRecords = (): RebuyRecords => {
  const completedGames = getAllGames().filter(g => {
    if (g.status !== 'completed') return false;
    const year = new Date(g.date || g.createdAt).getFullYear();
    return year >= 2026;
  });
  const completedIds = new Set(completedGames.map(g => g.id));
  const allGP = getAllGamePlayers().filter(gp => completedIds.has(gp.gameId));

  const playerMax = new Map<string, number>();
  let groupMax = 0;
  let groupMaxPlayerId = '';

  for (const gp of allGP) {
    const current = playerMax.get(gp.playerId) || 0;
    if (gp.rebuys > current) playerMax.set(gp.playerId, gp.rebuys);
    if (gp.rebuys > groupMax) {
      groupMax = gp.rebuys;
      groupMaxPlayerId = gp.playerId;
    }
  }

  const groupHolder = groupMaxPlayerId
    ? (getAllPlayers().find(p => p.id === groupMaxPlayerId)?.name || '')
    : '';

  return { playerMax, groupMax, groupMaxHolder: groupHolder };
};

// --- TTS Pool Storage ---

export const saveTTSPool = (gameId: string, pool: unknown, model?: string): void => {
  cacheSaveTTS(gameId, pool, model);
};

export const loadTTSPool = <T>(gameId: string): T | null => cacheLoadTTS(gameId) as T | null;

export const loadTTSPoolModel = (gameId: string): string | null => cacheLoadTTSModel(gameId);

export const deleteTTSPool = (gameId: string): void => {
  cacheDeleteTTS(gameId);
};

// ==================== FULL BACKUP & RESTORE ====================

interface FullBackupData {
  version: number;
  exportedAt: string;
  groupId: string;
  groupName: string;
  tables: Record<string, unknown>;
}

async function getBackupAuthHeaders(): Promise<Record<string, string>> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token) {
      const parts = session.access_token.split('.');
      if (parts.length === 3) {
        try {
          const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
          if (payload.exp && payload.exp * 1000 < Date.now() + 60_000) {
            const { data: refreshed } = await supabase.auth.refreshSession();
            if (refreshed.session?.access_token) {
              return { 'Authorization': `Bearer ${refreshed.session.access_token}` };
            }
          }
        } catch { /* token decode failed, use as-is */ }
      }
      return { 'Authorization': `Bearer ${session.access_token}` };
    }
    const { data: refreshed } = await supabase.auth.refreshSession();
    if (refreshed.session?.access_token) {
      return { 'Authorization': `Bearer ${refreshed.session.access_token}` };
    }
  } catch { /* session unavailable */ }
  return {};
}

async function fetchPaginated(
  table: string,
  column: string,
  value: string,
): Promise<Record<string, unknown>[]> {
  const PAGE = 1000;
  const all: Record<string, unknown>[] = [];
  let from = 0;
  for (;;) {
    const { data } = await supabase
      .from(table)
      .select('*')
      .eq(column, value)
      .range(from, from + PAGE - 1);
    if (!data || data.length === 0) break;
    all.push(...(data as Record<string, unknown>[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function fetchByIds(
  table: string,
  column: string,
  ids: string[],
): Promise<Record<string, unknown>[]> {
  if (ids.length === 0) return [];
  const BATCH = 100;
  const all: Record<string, unknown>[] = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    const { data } = await supabase.from(table).select('*').in(column, batch);
    if (data) all.push(...(data as Record<string, unknown>[]));
  }
  return all;
}

export async function downloadFullBackup(groupName: string): Promise<string> {
  const groupId = getGroupId();
  if (!groupId) throw new Error('No active group');

  const [
    players, games, chipValues, settingsRes, pendingRes,
    chronicles, insights,
    trainingPool, trainingAnswers, trainingInsights,
    groupMembers, playerInvites, activityLog,
  ] = await Promise.all([
    fetchPaginated('players', 'group_id', groupId),
    fetchPaginated('games', 'group_id', groupId),
    fetchPaginated('chip_values', 'group_id', groupId),
    supabase.from('settings').select('*').eq('group_id', groupId).maybeSingle(),
    supabase.from('pending_forecasts').select('*').eq('group_id', groupId)
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    fetchPaginated('chronicle_profiles', 'group_id', groupId),
    fetchPaginated('graph_insights', 'group_id', groupId),
    fetchPaginated('training_pool', 'group_id', groupId),
    fetchPaginated('training_answers', 'group_id', groupId),
    fetchPaginated('training_insights', 'group_id', groupId),
    fetchPaginated('group_members', 'group_id', groupId),
    fetchPaginated('player_invites', 'group_id', groupId),
    fetchPaginated('activity_log', 'group_id', groupId),
  ]);

  const gameIds = games.map(g => g.id as string);
  const playerIds = players.map(p => p.id as string);

  const [gamePlayers, gameForecasts, sharedExpenses, paidSettlements, periodMarkers, playerTraits] =
    await Promise.all([
      fetchByIds('game_players', 'game_id', gameIds),
      fetchByIds('game_forecasts', 'game_id', gameIds),
      fetchByIds('shared_expenses', 'game_id', gameIds),
      fetchByIds('paid_settlements', 'game_id', gameIds),
      fetchByIds('period_markers', 'game_id', gameIds),
      fetchByIds('player_traits', 'player_id', playerIds),
    ]);

  const backup: FullBackupData = {
    version: 2,
    exportedAt: new Date().toISOString(),
    groupId,
    groupName,
    tables: {
      players,
      games,
      game_players: gamePlayers,
      game_forecasts: gameForecasts,
      shared_expenses: sharedExpenses,
      paid_settlements: paidSettlements,
      period_markers: periodMarkers,
      chip_values: chipValues,
      settings: settingsRes.data ? { ...settingsRes.data, gemini_api_key: undefined, elevenlabs_api_key: undefined } : null,
      pending_forecasts: pendingRes.data || null,
      chronicle_profiles: chronicles,
      graph_insights: insights,
      training_pool: trainingPool,
      training_answers: trainingAnswers,
      training_insights: trainingInsights,
      group_members: groupMembers,
      player_invites: playerInvites,
      player_traits: playerTraits,
      activity_log: activityLog,
    },
  };

  const json = JSON.stringify(backup, null, 2);

  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const dateStr = new Date().toISOString().split('T')[0];
  a.href = url;
  a.download = `poker-backup-${groupName.replace(/\s+/g, '-')}-${dateStr}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  localStorage.setItem('lastBackupDownload', new Date().toISOString());

  return json;
}

async function compressToBase64(str: string): Promise<string> {
  const blob = new Blob([str]);
  const stream = blob.stream().pipeThrough(new CompressionStream('gzip'));
  const compressed = await new Response(stream).arrayBuffer();
  const bytes = new Uint8Array(compressed);
  const chunks: string[] = [];
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + CHUNK)));
  }
  return btoa(chunks.join(''));
}

export async function pushBackupToGitHub(
  groupName: string,
  content: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const auth = await getBackupAuthHeaders();
    const dateStr = new Date().toISOString().split('T')[0];
    const fileName = `poker-backup-${dateStr}.json`;

    const contentCompressed = await compressToBase64(content);

    const res = await fetch('/api/github-backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ action: 'push', groupName, fileName, contentCompressed }),
    });

    if (!res.ok) {
      const text = await res.text();
      try {
        const data = JSON.parse(text);
        return { success: false, error: data.error?.message || `HTTP ${res.status}` };
      } catch {
        return { success: false, error: text || `HTTP ${res.status}` };
      }
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

export async function listGitHubBackups(
  groupName: string,
): Promise<{ name: string; size: number }[]> {
  try {
    const auth = await getBackupAuthHeaders();
    const res = await fetch('/api/github-backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ action: 'list', groupName }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.files || [];
  } catch {
    return [];
  }
}

export async function fetchGitHubBackup(
  groupName: string,
  fileName: string,
): Promise<string | null> {
  try {
    const auth = await getBackupAuthHeaders();
    const res = await fetch('/api/github-backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ action: 'fetch', groupName, fileName }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.content || null;
  } catch {
    return null;
  }
}

const RESTORE_ORDER = [
  'players', 'chip_values', 'settings', 'games',
  'game_players', 'game_forecasts', 'shared_expenses', 'paid_settlements', 'period_markers',
  'pending_forecasts',
  'chronicle_profiles', 'graph_insights',
  'training_pool', 'training_answers', 'training_insights',
  'player_traits', 'player_invites', 'activity_log',
  'group_members',
];

export interface RestoreResult {
  success: boolean;
  tablesRestored: number;
  errors: string[];
}

export async function restoreFromBackup(json: string, groupId: string): Promise<RestoreResult> {
  const errors: string[] = [];
  let tablesRestored = 0;

  let backup: FullBackupData;
  try {
    backup = JSON.parse(json);
  } catch {
    return { success: false, tablesRestored: 0, errors: ['Invalid JSON'] };
  }

  if (!backup.version || !backup.tables) {
    return { success: false, tablesRestored: 0, errors: ['Invalid backup format'] };
  }

  const tables = backup.tables as Record<string, unknown>;

  for (const table of RESTORE_ORDER) {
    const data = tables[table];
    if (!data) continue;

    try {
      if (Array.isArray(data) && data.length > 0) {
        const rows = data.map((row: Record<string, unknown>) => {
          if ('group_id' in row) return { ...row, group_id: groupId };
          return { ...row };
        });

        const BATCH = 100;
        for (let i = 0; i < rows.length; i += BATCH) {
          const batch = rows.slice(i, i + BATCH);
          const { error } = await supabase.from(table).upsert(batch, { onConflict: 'id' });
          if (error) {
            errors.push(`${table}: ${error.message}`);
            break;
          }
        }
        tablesRestored++;
      } else if (data && typeof data === 'object' && !Array.isArray(data)) {
        const row = { ...(data as Record<string, unknown>), group_id: groupId };
        const onConflict = table === 'settings' ? 'group_id' : 'id';
        const { error } = await supabase.from(table).upsert(row, { onConflict });
        if (error) errors.push(`${table}: ${error.message}`);
        else tablesRestored++;
      }
    } catch (err) {
      errors.push(`${table}: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  // Reinitialize cache from freshly restored data
  resetCache();
  await initSupabaseCache(groupId);

  return { success: errors.length === 0, tablesRestored, errors };
}

export function parseBackupSummary(json: string): {
  valid: boolean;
  groupName?: string;
  exportedAt?: string;
  playerCount?: number;
  gameCount?: number;
  tableCount?: number;
} {
  try {
    const backup = JSON.parse(json) as FullBackupData;
    if (!backup.version || !backup.tables) return { valid: false };

    const t = backup.tables as Record<string, unknown>;
    const arrayCount = (key: string) => Array.isArray(t[key]) ? (t[key] as unknown[]).length : 0;

    return {
      valid: true,
      groupName: backup.groupName,
      exportedAt: backup.exportedAt,
      playerCount: arrayCount('players'),
      gameCount: arrayCount('games'),
      tableCount: Object.keys(t).filter(k => {
        const v = t[k];
        return (Array.isArray(v) && v.length > 0) || (v && typeof v === 'object' && !Array.isArray(v));
      }).length,
    };
  } catch {
    return { valid: false };
  }
}

export function getLastBackupDate(): string | null {
  return localStorage.getItem('lastBackupDownload');
}

// ── Notifications ──
export {
  fetchNotifications,
  getCachedNotifications,
  getUnreadNotificationCount,
  markNotificationRead,
  createNotification,
  resolvePlayerUserId,
  getPlayerEmailForNotification,
  getGroupId,
  getPlayerTraitsByName,
  getAllPlayerTraits,
  savePlayerTraits,
  savePushSubscription,
  deletePushSubscription,
  getGroupPushSubscribers,
};
export type { AppNotification, PlayerTraits };

