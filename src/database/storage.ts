import { Player, PlayerType, PlayerGender, Game, GamePlayer, ChipValue, Settings, GameWithDetails, PlayerStats, PendingForecast, GameForecast, SharedExpense } from '../types';
import { uploadBackupToGitHub, syncToCloud, fetchBackupFromGitHub } from './githubSync';
import { USE_SUPABASE } from './config';
import {
  cacheGet, cacheSet, cacheRemove,
  cacheGetItem, cacheSetItem, cacheRemoveItem,
  cacheSaveTTS, cacheLoadTTS, cacheLoadTTSModel, cacheDeleteTTS,
  isInitialized as isCacheReady,
} from './supabaseCache';

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

// Generate unique ID (UUID for Supabase, short string for localStorage)
export const generateId = (): string => {
  if (USE_SUPABASE) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).substring(2);
};

// Helper functions — delegate to Supabase cache or localStorage
const getItem = <T>(key: string, defaultValue: T): T => {
  if (USE_SUPABASE) return cacheGet<T>(key, defaultValue);
  const item = localStorage.getItem(key);
  if (!item) return defaultValue;
  try {
    return JSON.parse(item);
  } catch {
    console.warn(`Corrupted localStorage key "${key}", using default`);
    return defaultValue;
  }
};

const setItem = <T>(key: string, value: T): void => {
  if (USE_SUPABASE) { cacheSet<T>(key, value); return; }
  localStorage.setItem(key, JSON.stringify(value));
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
  locations: ['ליאור', 'סגל', 'ליכטר', 'מקלט ליכטר', 'אייל'],
  blockedTransfers: [
    { playerA: 'פיליפ', playerB: 'תומר', after: '2026-03-24' },
  ],
};

// Default players (all permanent, all male)
const DEFAULT_PLAYERS: Player[] = [
  { id: 'p1', name: 'ליאור', createdAt: new Date().toISOString(), type: 'permanent', gender: 'male' },
  { id: 'p2', name: 'אייל', createdAt: new Date().toISOString(), type: 'permanent', gender: 'male' },
  { id: 'p3', name: 'ארז', createdAt: new Date().toISOString(), type: 'permanent', gender: 'male' },
  { id: 'p4', name: 'אורן', createdAt: new Date().toISOString(), type: 'permanent', gender: 'male' },
  { id: 'p5', name: 'ליכטר', createdAt: new Date().toISOString(), type: 'permanent', gender: 'male' },
  { id: 'p6', name: 'סגל', createdAt: new Date().toISOString(), type: 'permanent', gender: 'male' },
  { id: 'p7', name: 'תומר', createdAt: new Date().toISOString(), type: 'permanent', gender: 'male' },
  { id: 'p8', name: 'פיליפ', createdAt: new Date().toISOString(), type: 'permanent', gender: 'male' },
  { id: 'p9', name: 'אסף', createdAt: new Date().toISOString(), type: 'permanent', gender: 'male' },
  { id: 'p10', name: 'פבל', createdAt: new Date().toISOString(), type: 'permanent', gender: 'male' },
  { id: 'p11', name: 'מלמד', createdAt: new Date().toISOString(), type: 'permanent', gender: 'male' },
];

// Initialize default values if not exist
export const initializeStorage = (): void => {
  if (USE_SUPABASE) return; // Supabase cache is initialized separately via initSupabaseCache
  if (!localStorage.getItem(STORAGE_KEYS.CHIP_VALUES)) {
    setItem(STORAGE_KEYS.CHIP_VALUES, DEFAULT_CHIP_VALUES);
  } else {
    // Force update black chip to pure black if it's the old gray color
    const chipValues = getItem<ChipValue[]>(STORAGE_KEYS.CHIP_VALUES, []);
    const blackChip = chipValues.find(c => c.color === 'Black');
    if (blackChip && blackChip.displayColor !== '#000000') {
      blackChip.displayColor = '#000000';
      setItem(STORAGE_KEYS.CHIP_VALUES, chipValues);
    }
  }
  if (!localStorage.getItem(STORAGE_KEYS.SETTINGS)) {
    setItem(STORAGE_KEYS.SETTINGS, DEFAULT_SETTINGS);
  } else {
    const settings = getItem<Settings>(STORAGE_KEYS.SETTINGS, DEFAULT_SETTINGS);
    if (!settings.blockedTransfers) {
      settings.blockedTransfers = DEFAULT_SETTINGS.blockedTransfers;
      setItem(STORAGE_KEYS.SETTINGS, settings);
    }
  }
  // Initialize players - use defaults if no players exist or if array is empty
  const existingPlayers = localStorage.getItem(STORAGE_KEYS.PLAYERS);
  if (!existingPlayers || JSON.parse(existingPlayers).length === 0) {
    setItem(STORAGE_KEYS.PLAYERS, DEFAULT_PLAYERS);
  } else {
    // Migrate existing players - add type: 'permanent' if missing
    const players = JSON.parse(existingPlayers) as Player[];
    let needsUpdate = false;
    players.forEach(p => {
      if (!p.type) {
        p.type = 'permanent';
        needsUpdate = true;
      }
    });
    if (needsUpdate) {
      setItem(STORAGE_KEYS.PLAYERS, players);
    }
  }
  if (!localStorage.getItem(STORAGE_KEYS.GAMES)) {
    setItem(STORAGE_KEYS.GAMES, []);
  } else {
    // Fix: only the 2 most recent "מקלט ליכטר" games should keep that name;
    // all others should revert to "ליכטר" (undoes over-eager earlier migration).
    const games = getItem<Game[]>(STORAGE_KEYS.GAMES, []);
    const shelterGames = games
      .filter(g => g.location === 'מקלט ליכטר')
      .sort((a, b) => new Date(b.date || b.createdAt).getTime() - new Date(a.date || a.createdAt).getTime());
    if (shelterGames.length > 2) {
      const keepIds = new Set([shelterGames[0].id, shelterGames[1].id]);
      games.forEach(g => {
        if (g.location === 'מקלט ליכטר' && !keepIds.has(g.id)) {
          g.location = 'ליכטר';
        }
      });
      setItem(STORAGE_KEYS.GAMES, games);
    }
  }
  if (!localStorage.getItem(STORAGE_KEYS.GAME_PLAYERS)) {
    setItem(STORAGE_KEYS.GAME_PLAYERS, []);
  }
  
  // Check for automatic Friday backup
  checkAndAutoBackup();
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

// Clear all game history (reset statistics)
export const clearAllGameHistory = (): void => {
  setItem(STORAGE_KEYS.GAMES, []);
  setItem(STORAGE_KEYS.GAME_PLAYERS, []);
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
  // Empty arrays from Supabase migration should not override defaults
  if (stored.locations?.length === 0 && DEFAULT_SETTINGS.locations?.length) {
    merged.locations = DEFAULT_SETTINGS.locations;
  }
  if (stored.gameNightDays?.length === 0 && DEFAULT_SETTINGS.gameNightDays?.length) {
    merged.gameNightDays = DEFAULT_SETTINGS.gameNightDays;
  }
  return merged;
};

export const saveSettings = (settings: Settings): void => {
  setItem(STORAGE_KEYS.SETTINGS, settings);
};

// Game with details
export const getGameWithDetails = (gameId: string): GameWithDetails | null => {
  const game = getGame(gameId);
  if (!game) return null;
  
  const players = getGamePlayers(gameId);
  const settings = getSettings();
  const totalPot = players.reduce((sum, p) => sum + p.rebuys * settings.rebuyValue, 0);
  
  return {
    ...game,
    players,
    totalPot,
  };
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

// Import a historical completed game (safe - only adds data, doesn't modify existing)
export const importHistoricalGame = (
  gameDate: string,
  playersData: Array<{
    playerName: string;
    rebuys: number;
    chipCounts: Record<string, number>;
    finalValue: number;
    profit: number;
  }>
): Game | null => {
  const players = getAllPlayers();
  const games = getAllGames();
  const gamePlayers = getItem<GamePlayer[]>(STORAGE_KEYS.GAME_PLAYERS, []);
  
  // Check if a game with this exact date already exists (prevent duplicates)
  const existingGame = games.find(g => g.date.startsWith(gameDate.split('T')[0]));
  if (existingGame) {
    console.log('Game for this date already exists, skipping import');
    return null;
  }
  
  const gameId = generateId();
  const newGame: Game = {
    id: gameId,
    date: gameDate,
    status: 'completed',
    createdAt: gameDate,
  };
  
  // Create GamePlayer entries
  playersData.forEach(pd => {
    const player = players.find(p => p.name === pd.playerName);
    if (player) {
      gamePlayers.push({
        id: generateId(),
        gameId,
        playerId: player.id,
        playerName: pd.playerName,
        rebuys: pd.rebuys,
        chipCounts: pd.chipCounts,
        finalValue: pd.finalValue,
        profit: pd.profit,
      });
    }
  });
  
  games.push(newGame);
  setItem(STORAGE_KEYS.GAMES, games);
  setItem(STORAGE_KEYS.GAME_PLAYERS, gamePlayers);
  
  return newGame;
};

// ==================== BACKUP & RESTORE ====================

export interface BackupData {
  id: string;
  date: string;
  type: 'auto' | 'manual';
  trigger?: 'friday' | 'game-end';  // For auto backups, what triggered it
  players: Player[];
  games: Game[];
  gamePlayers: GamePlayer[];
  chipValues: ChipValue[];
  settings: Settings;
}

// Create a backup of all data
export const createBackup = (type: 'auto' | 'manual' = 'manual', trigger?: 'friday' | 'game-end'): BackupData => {
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
  };
  
  // Save to backups list
  const backups = getBackups();
  backups.unshift(backup); // Add to beginning (newest first)
  
  // Keep only the latest backup (1 backup max)
  while (backups.length > 1) {
    backups.pop();
  }
  
  setItem(STORAGE_KEYS.BACKUPS, backups);
  
  if (type === 'auto') {
    // Record that we did an auto-backup today
    setItem(STORAGE_KEYS.LAST_BACKUP_DATE, new Date().toDateString());
  }
  
  return backup;
};

// Create backup and also upload to GitHub cloud
export const createBackupWithCloudSync = async (
  type: 'auto' | 'manual' = 'manual', 
  trigger?: 'friday' | 'game-end',
  useMemberSyncToken: boolean = false
): Promise<{ backup: BackupData; cloudResult: { success: boolean; message: string } }> => {
  const backup = createBackup(type, trigger);

  if (USE_SUPABASE) {
    // Data is already in Supabase — no GitHub sync needed
    return { backup, cloudResult: { success: true, message: 'הנתונים מסונכרנים אוטומטית ב-Supabase' } };
  }
  
  const cloudResult = await uploadBackupToGitHub(backup, useMemberSyncToken);
  syncToCloud(useMemberSyncToken).catch(err =>
    console.warn('Sync after backup failed:', err)
  );
  
  return { backup, cloudResult };
};

// Get all available backups
export const getBackups = (): BackupData[] => {
  return getItem<BackupData[]>(STORAGE_KEYS.BACKUPS, []);
};

// Get last backup date
export const getLastBackupDate = (): string | null => {
  const backups = getBackups();
  if (backups.length === 0) return null;
  return backups[0].date;
};

// Restore from a backup
export const restoreFromBackup = (backupId: string): boolean => {
  const backups = getBackups();
  const backup = backups.find(b => b.id === backupId);
  
  if (!backup) return false;
  
  // Restore all data
  setItem(STORAGE_KEYS.PLAYERS, backup.players);
  setItem(STORAGE_KEYS.GAMES, backup.games);
  setItem(STORAGE_KEYS.GAME_PLAYERS, backup.gamePlayers);
  setItem(STORAGE_KEYS.CHIP_VALUES, backup.chipValues);
  setItem(STORAGE_KEYS.SETTINGS, backup.settings);
  
  return true;
};

// Restore from cloud backup (full-backup.json on GitHub)
export const restoreFromCloudBackup = async (): Promise<{ success: boolean; message: string; gamesCount?: number }> => {
  if (USE_SUPABASE) {
    return { success: false, message: 'ב-Supabase הנתונים כבר בענן — אין צורך בשחזור' };
  }
  try {
    const backup = await fetchBackupFromGitHub();
    if (!backup) {
      return { success: false, message: 'לא נמצא גיבוי בענן' };
    }

    if (!backup.games || !backup.players || !backup.gamePlayers) {
      return { success: false, message: 'הגיבוי בענן פגום' };
    }

    setItem(STORAGE_KEYS.PLAYERS, backup.players);
    setItem(STORAGE_KEYS.GAMES, backup.games);
    setItem(STORAGE_KEYS.GAME_PLAYERS, backup.gamePlayers);
    if (backup.chipValues) setItem(STORAGE_KEYS.CHIP_VALUES, backup.chipValues);
    if (backup.settings) setItem(STORAGE_KEYS.SETTINGS, backup.settings);

    return {
      success: true,
      message: `שוחזרו ${backup.games.length} משחקים מהגיבוי בענן`,
      gamesCount: backup.games.length,
    };
  } catch (error) {
    console.error('Cloud backup restore failed:', error);
    return { success: false, message: 'שגיאה בשחזור מהענן' };
  }
};

// Download backup as JSON file
export const downloadBackup = (): void => {
  const backup = createBackup('manual');
  const dataStr = JSON.stringify(backup, null, 2);
  const blob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = `poker-backup-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  
  URL.revokeObjectURL(url);
};

// Share backup as file (for WhatsApp, etc.)
export const shareBackupAsFile = async (): Promise<'shared' | 'downloaded' | 'error'> => {
  const backup = createBackup('manual');
  const today = new Date().toISOString().split('T')[0];
  const fileName = `poker-backup-${today}.json`;
  
  // Create the file
  const dataStr = JSON.stringify(backup, null, 2);
  const blob = new Blob([dataStr], { type: 'application/json' });
  const file = new File([blob], fileName, { type: 'application/json' });
  
  // Try Web Share API with files
  try {
    if (navigator.share) {
      // Check if we can share files
      const canShareFiles = navigator.canShare && navigator.canShare({ files: [file] });
      
      if (canShareFiles) {
        await navigator.share({
          files: [file],
          title: 'Poker Backup',
          text: `🎰 Poker Backup - ${today}`
        });
        return 'shared';
      } else {
        // Try sharing without files (just triggers share dialog, user downloads first)
        // Download the file first, then show share dialog for the text
        downloadFile(blob, fileName);
        await navigator.share({
          title: 'Poker Backup',
          text: `🎰 Poker Backup saved as ${fileName}. Send this file via WhatsApp or save it somewhere safe!`
        });
        return 'shared';
      }
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    // AbortError means user cancelled - that's fine
    if (errorMessage.includes('abort') || errorMessage.includes('cancel')) {
      return 'error';
    }
    console.log('Share failed:', errorMessage);
  }
  
  // Fallback: just download the file
  downloadFile(blob, fileName);
  return 'downloaded';
};

// Helper to download a file
const downloadFile = (blob: Blob, fileName: string): void => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

// Import backup from JSON file
export const importBackupFromFile = (jsonData: string): boolean => {
  try {
    const backup = JSON.parse(jsonData) as BackupData;
    
    // Validate backup structure
    if (!backup.players || !backup.games || !backup.gamePlayers || !backup.chipValues || !backup.settings) {
      console.error('Invalid backup file structure');
      return false;
    }
    
    // Restore all data
    setItem(STORAGE_KEYS.PLAYERS, backup.players);
    setItem(STORAGE_KEYS.GAMES, backup.games);
    setItem(STORAGE_KEYS.GAME_PLAYERS, backup.gamePlayers);
    setItem(STORAGE_KEYS.CHIP_VALUES, backup.chipValues);
    setItem(STORAGE_KEYS.SETTINGS, backup.settings);
    
    return true;
  } catch (error) {
    console.error('Error importing backup:', error);
    return false;
  }
};

// Check if we should auto-backup (Friday and not already backed up today)
export const checkAndAutoBackup = (): boolean => {
  const today = new Date();
  const isFriday = today.getDay() === 5;
  
  if (!isFriday) return false;
  
  const lastBackupDate = getItem<string | null>(STORAGE_KEYS.LAST_BACKUP_DATE, null);
  const todayStr = today.toDateString();
  
  if (lastBackupDate === todayStr) {
    // Already backed up today
    return false;
  }
  
  // Create automatic backup
  createBackup('auto', 'friday');
  console.log('Automatic Friday backup created!');
  return true;
};

// Create auto backup after game ends
export const createGameEndBackup = (): void => {
  createBackup('auto', 'game-end');
  console.log('Auto backup created after game end!');
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
  if (USE_SUPABASE) { cacheRemove(STORAGE_KEYS.PENDING_FORECAST); return; }
  localStorage.removeItem(STORAGE_KEYS.PENDING_FORECAST);
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

// Get aggregate forecast accuracy across all games
export const getOverallForecastAccuracy = (): {
  totalGames: number;
  avgScore: number;
  avgDirectionRate: number;
  avgGap: number;
  totalDirectionHits: number;
  totalDirectionAttempts: number;
} => {
  const games = getAllGames().filter(g => g.status === 'completed' && g.forecastAccuracy);
  if (games.length === 0) {
    return { totalGames: 0, avgScore: 0, avgDirectionRate: 0, avgGap: 0, totalDirectionHits: 0, totalDirectionAttempts: 0 };
  }
  
  let totalScore = 0;
  let totalDirectionHits = 0;
  let totalDirectionAttempts = 0;
  let totalGap = 0;
  
  for (const game of games) {
    const acc = game.forecastAccuracy!;
    totalScore += acc.score;
    totalDirectionHits += acc.directionHits;
    totalDirectionAttempts += acc.totalPlayers;
    totalGap += acc.avgGap;
  }
  
  return {
    totalGames: games.length,
    avgScore: Math.round(totalScore / games.length),
    avgDirectionRate: totalDirectionAttempts > 0 ? Math.round((totalDirectionHits / totalDirectionAttempts) * 100) : 0,
    avgGap: Math.round(totalGap / games.length),
    totalDirectionHits,
    totalDirectionAttempts,
  };
};

// ========== Storage Usage Monitoring ==========

export interface StorageUsage {
  used: number;           // bytes used
  limit: number;          // estimated limit (5MB)
  percent: number;        // percentage used
  breakdown: Record<string, number>;  // bytes per key
  status: 'safe' | 'warning' | 'critical';
  gamesCount: number;
  estimatedGamesRemaining: number;
}

const STORAGE_LIMIT = 5 * 1024 * 1024; // 5MB in bytes
const WARNING_THRESHOLD = 70;  // Show warning at 70%
const CRITICAL_THRESHOLD = 90; // Critical at 90%

export const getStorageUsage = (): StorageUsage => {
  if (USE_SUPABASE) {
    // Supabase has virtually unlimited storage; report as safe
    return {
      used: 0, limit: STORAGE_LIMIT, percent: 0, breakdown: {},
      status: 'safe', gamesCount: getAllGames().length, estimatedGamesRemaining: 9999,
    };
  }

  const breakdown: Record<string, number> = {};
  let totalUsed = 0;

  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('poker_') || key === 'github_token' || key === 'gemini_api_key' || key === 'elevenlabs_api_key') {
      const value = localStorage.getItem(key) || '';
      const size = (key.length + value.length) * 2;
      breakdown[key] = size;
      totalUsed += size;
    }
  }

  const percent = (totalUsed / STORAGE_LIMIT) * 100;
  const gamesCount = getAllGames().length;
  const avgBytesPerGame = gamesCount > 0 ? totalUsed / gamesCount : 3500;
  const remainingBytes = STORAGE_LIMIT - totalUsed;
  const estimatedGamesRemaining = Math.max(0, Math.floor(remainingBytes / avgBytesPerGame));

  let status: 'safe' | 'warning' | 'critical' = 'safe';
  if (percent >= CRITICAL_THRESHOLD) {
    status = 'critical';
  } else if (percent >= WARNING_THRESHOLD) {
    status = 'warning';
  }

  return {
    used: totalUsed, limit: STORAGE_LIMIT, percent, breakdown,
    status, gamesCount, estimatedGamesRemaining,
  };
};

// Check if storage write might fail
export const canWriteToStorage = (additionalBytes: number = 10000): boolean => {
  const usage = getStorageUsage();
  return (usage.used + additionalBytes) < STORAGE_LIMIT;
};

// Get human-readable storage size
export const formatStorageSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

// ========== Chronicle Profiles (AI-generated player stories) ==========

const CHRONICLE_STORAGE_KEY = 'poker_chronicle_profiles';

export interface ChronicleEntry {
  profiles: Record<string, string>;
  generatedAt: string;
  model?: string;
}

export const getChronicleProfiles = (periodKey: string): ChronicleEntry | null => {
  const raw = USE_SUPABASE ? cacheGetItem(CHRONICLE_STORAGE_KEY) : localStorage.getItem(CHRONICLE_STORAGE_KEY);
  if (!raw) return null;
  try {
    const all: Record<string, ChronicleEntry> = JSON.parse(raw);
    return all[periodKey] || null;
  } catch {
    return null;
  }
};

export const saveChronicleProfiles = (periodKey: string, profiles: Record<string, string>, model?: string): void => {
  const raw = USE_SUPABASE ? cacheGetItem(CHRONICLE_STORAGE_KEY) : localStorage.getItem(CHRONICLE_STORAGE_KEY);
  const all: Record<string, ChronicleEntry> = raw ? JSON.parse(raw) : {};
  all[periodKey] = { profiles, generatedAt: new Date().toISOString(), model };
  if (USE_SUPABASE) cacheSetItem(CHRONICLE_STORAGE_KEY, JSON.stringify(all));
  else localStorage.setItem(CHRONICLE_STORAGE_KEY, JSON.stringify(all));
};

export const getAllChronicleProfiles = (): Record<string, ChronicleEntry> | null => {
  const raw = USE_SUPABASE ? cacheGetItem(CHRONICLE_STORAGE_KEY) : localStorage.getItem(CHRONICLE_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export const setAllChronicleProfiles = (data: Record<string, ChronicleEntry>): void => {
  if (USE_SUPABASE) cacheSetItem(CHRONICLE_STORAGE_KEY, JSON.stringify(data));
  else localStorage.setItem(CHRONICLE_STORAGE_KEY, JSON.stringify(data));
};

// ========== Graph Insights (AI-generated group narrative for Graphs page) ==========

const GRAPH_INSIGHTS_KEY = 'poker_graph_insights';

export interface GraphInsightsEntry {
  text: string;
  generatedAt: string;
  model?: string;
}

export const getGraphInsights = (periodKey: string): GraphInsightsEntry | null => {
  const raw = USE_SUPABASE ? cacheGetItem(GRAPH_INSIGHTS_KEY) : localStorage.getItem(GRAPH_INSIGHTS_KEY);
  if (!raw) return null;
  try {
    const all: Record<string, GraphInsightsEntry> = JSON.parse(raw);
    return all[periodKey] || null;
  } catch {
    return null;
  }
};

export const saveGraphInsights = (periodKey: string, text: string, model?: string): void => {
  const raw = USE_SUPABASE ? cacheGetItem(GRAPH_INSIGHTS_KEY) : localStorage.getItem(GRAPH_INSIGHTS_KEY);
  const all: Record<string, GraphInsightsEntry> = raw ? JSON.parse(raw) : {};
  all[periodKey] = { text, generatedAt: new Date().toISOString(), model };
  if (USE_SUPABASE) cacheSetItem(GRAPH_INSIGHTS_KEY, JSON.stringify(all));
  else localStorage.setItem(GRAPH_INSIGHTS_KEY, JSON.stringify(all));
};

export const getAllGraphInsights = (): Record<string, GraphInsightsEntry> | null => {
  const raw = USE_SUPABASE ? cacheGetItem(GRAPH_INSIGHTS_KEY) : localStorage.getItem(GRAPH_INSIGHTS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export const setAllGraphInsights = (data: Record<string, GraphInsightsEntry>): void => {
  if (USE_SUPABASE) cacheSetItem(GRAPH_INSIGHTS_KEY, JSON.stringify(data));
  else localStorage.setItem(GRAPH_INSIGHTS_KEY, JSON.stringify(data));
};

export const invalidateAICaches = (): void => {
  if (USE_SUPABASE) {
    cacheRemoveItem(CHRONICLE_STORAGE_KEY);
    cacheRemoveItem(GRAPH_INSIGHTS_KEY);
  } else {
    localStorage.removeItem(CHRONICLE_STORAGE_KEY);
    localStorage.removeItem(GRAPH_INSIGHTS_KEY);
  }
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

const TTS_POOL_PREFIX = 'poker_tts_pool_';


export const saveTTSPool = (gameId: string, pool: unknown, model?: string): void => {
  if (USE_SUPABASE) { cacheSaveTTS(gameId, pool, model); return; }
  localStorage.setItem(`${TTS_POOL_PREFIX}${gameId}`, JSON.stringify(pool));
  if (model) localStorage.setItem(`${TTS_POOL_PREFIX}${gameId}_model`, model);
};

export const loadTTSPool = <T>(gameId: string): T | null => {
  if (USE_SUPABASE) return cacheLoadTTS(gameId) as T | null;
  const raw = localStorage.getItem(`${TTS_POOL_PREFIX}${gameId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

export const loadTTSPoolModel = (gameId: string): string | null => {
  if (USE_SUPABASE) return cacheLoadTTSModel(gameId);
  return localStorage.getItem(`${TTS_POOL_PREFIX}${gameId}_model`);
};

export const deleteTTSPool = (gameId: string): void => {
  if (USE_SUPABASE) { cacheDeleteTTS(gameId); return; }
  localStorage.removeItem(`${TTS_POOL_PREFIX}${gameId}`);
  localStorage.removeItem(`${TTS_POOL_PREFIX}${gameId}_model`);
};

export const cleanupOrphanedTTSPools = (): void => {
  if (USE_SUPABASE && isCacheReady()) return; // Supabase handles cleanup via FK cascades
  if (USE_SUPABASE) return;
  const liveGameIds = new Set(
    getAllGames().filter(g => g.status === 'live').map(g => g.id)
  );
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (key.startsWith(TTS_POOL_PREFIX)) {
      const gid = key.slice(TTS_POOL_PREFIX.length);
      if (!liveGameIds.has(gid)) keysToRemove.push(key);
    }
  }
  keysToRemove.forEach(k => localStorage.removeItem(k));
};

