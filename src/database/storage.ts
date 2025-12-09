import { Player, Game, GamePlayer, ChipValue, Settings, GameWithDetails, PlayerStats } from '../types';

const STORAGE_KEYS = {
  PLAYERS: 'poker_players',
  GAMES: 'poker_games',
  GAME_PLAYERS: 'poker_game_players',
  CHIP_VALUES: 'poker_chip_values',
  SETTINGS: 'poker_settings',
};

// Generate unique ID
export const generateId = (): string => {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
};

// Helper functions for localStorage
const getItem = <T>(key: string, defaultValue: T): T => {
  const item = localStorage.getItem(key);
  return item ? JSON.parse(item) : defaultValue;
};

const setItem = <T>(key: string, value: T): void => {
  localStorage.setItem(key, JSON.stringify(value));
};

// Default chip values
const DEFAULT_CHIP_VALUES: ChipValue[] = [
  { id: '1', color: 'White', value: 50, displayColor: '#FFFFFF' },
  { id: '2', color: 'Red', value: 100, displayColor: '#EF4444' },
  { id: '3', color: 'Blue', value: 200, displayColor: '#3B82F6' },
  { id: '4', color: 'Green', value: 500, displayColor: '#22C55E' },
  { id: '5', color: 'Black', value: 1000, displayColor: '#1F2937' },
  { id: '6', color: 'Yellow', value: 5000, displayColor: '#EAB308' },
];

const DEFAULT_SETTINGS: Settings = {
  rebuyValue: 30,
  chipsPerRebuy: 10000,
  minTransfer: 5,
};

// Default players
const DEFAULT_PLAYERS: Player[] = [
  { id: 'p1', name: 'ליאור', createdAt: new Date().toISOString() },
  { id: 'p2', name: 'אייל', createdAt: new Date().toISOString() },
  { id: 'p3', name: 'ארז', createdAt: new Date().toISOString() },
  { id: 'p4', name: 'אורן', createdAt: new Date().toISOString() },
  { id: 'p5', name: 'ליכטר', createdAt: new Date().toISOString() },
  { id: 'p6', name: 'סגל', createdAt: new Date().toISOString() },
  { id: 'p7', name: 'תומר', createdAt: new Date().toISOString() },
  { id: 'p8', name: 'פיליפ', createdAt: new Date().toISOString() },
  { id: 'p9', name: 'אסף', createdAt: new Date().toISOString() },
  { id: 'p10', name: 'פבל', createdAt: new Date().toISOString() },
  { id: 'p11', name: 'מלמד', createdAt: new Date().toISOString() },
];

// Initialize default values if not exist
export const initializeStorage = (): void => {
  if (!localStorage.getItem(STORAGE_KEYS.CHIP_VALUES)) {
    setItem(STORAGE_KEYS.CHIP_VALUES, DEFAULT_CHIP_VALUES);
  }
  if (!localStorage.getItem(STORAGE_KEYS.SETTINGS)) {
    setItem(STORAGE_KEYS.SETTINGS, DEFAULT_SETTINGS);
  }
  // Initialize players - use defaults if no players exist or if array is empty
  const existingPlayers = localStorage.getItem(STORAGE_KEYS.PLAYERS);
  if (!existingPlayers || JSON.parse(existingPlayers).length === 0) {
    setItem(STORAGE_KEYS.PLAYERS, DEFAULT_PLAYERS);
  }
  if (!localStorage.getItem(STORAGE_KEYS.GAMES)) {
    setItem(STORAGE_KEYS.GAMES, []);
  }
  if (!localStorage.getItem(STORAGE_KEYS.GAME_PLAYERS)) {
    setItem(STORAGE_KEYS.GAME_PLAYERS, []);
  }
};

// Players
export const getAllPlayers = (): Player[] => {
  return getItem<Player[]>(STORAGE_KEYS.PLAYERS, []);
};

export const addPlayer = (name: string): Player => {
  const players = getAllPlayers();
  const newPlayer: Player = {
    id: generateId(),
    name,
    createdAt: new Date().toISOString(),
  };
  players.push(newPlayer);
  setItem(STORAGE_KEYS.PLAYERS, players);
  return newPlayer;
};

export const deletePlayer = (id: string): void => {
  const players = getAllPlayers().filter(p => p.id !== id);
  setItem(STORAGE_KEYS.PLAYERS, players);
};

export const getPlayerByName = (name: string): Player | undefined => {
  return getAllPlayers().find(p => p.name.toLowerCase() === name.toLowerCase());
};

// Games
export const getAllGames = (): Game[] => {
  return getItem<Game[]>(STORAGE_KEYS.GAMES, []);
};

export const getGame = (id: string): Game | undefined => {
  return getAllGames().find(g => g.id === id);
};

export const createGame = (playerIds: string[]): Game => {
  const games = getAllGames();
  const players = getAllPlayers();
  const gamePlayers = getItem<GamePlayer[]>(STORAGE_KEYS.GAME_PLAYERS, []);
  
  const newGame: Game = {
    id: generateId(),
    date: new Date().toISOString(),
    status: 'live',
    createdAt: new Date().toISOString(),
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
  return getItem<ChipValue[]>(STORAGE_KEYS.CHIP_VALUES, DEFAULT_CHIP_VALUES);
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
  // Merge with defaults to ensure all fields exist (handles migration from old versions)
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
  };
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
export const getPlayerStats = (): PlayerStats[] => {
  const players = getAllPlayers();
  const allGamePlayers = getItem<GamePlayer[]>(STORAGE_KEYS.GAME_PLAYERS, []);
  const games = getAllGames().filter(g => g.status === 'completed');
  const completedGameIds = new Set(games.map(g => g.id));
  
  return players.map(player => {
    const playerGames = allGamePlayers.filter(
      gp => gp.playerId === player.id && completedGameIds.has(gp.gameId)
    );
    
    const gamesPlayed = playerGames.length;
    const totalProfit = playerGames.reduce((sum, pg) => sum + pg.profit, 0);
    const winCount = playerGames.filter(pg => pg.profit > 0).length;
    const lossCount = playerGames.filter(pg => pg.profit < 0).length;
    const totalRebuys = playerGames.reduce((sum, pg) => sum + pg.rebuys, 0);
    
    // Calculate total gains (sum of positive profits) and total losses (sum of negative profits as positive)
    const totalGains = playerGames
      .filter(pg => pg.profit > 0)
      .reduce((sum, pg) => sum + pg.profit, 0);
    const totalLosses = Math.abs(playerGames
      .filter(pg => pg.profit < 0)
      .reduce((sum, pg) => sum + pg.profit, 0));
    
    const profits = playerGames.map(pg => pg.profit);
    const biggestWin = profits.length > 0 ? Math.max(...profits, 0) : 0;
    const biggestLoss = profits.length > 0 ? Math.min(...profits, 0) : 0;
    
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
    };
  }).filter(stats => stats.gamesPlayed > 0);
};

