import { Player, Game, GamePlayer, ChipValue, Settings, GameWithDetails, PlayerStats } from '../types';

const STORAGE_KEYS = {
  PLAYERS: 'poker_players',
  GAMES: 'poker_games',
  GAME_PLAYERS: 'poker_game_players',
  CHIP_VALUES: 'poker_chip_values',
  SETTINGS: 'poker_settings',
  BACKUPS: 'poker_backups',
  LAST_BACKUP_DATE: 'poker_last_backup_date',
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
  { id: '5', color: 'Black', value: 1000, displayColor: '#000000' },
  { id: '6', color: 'Yellow', value: 5000, displayColor: '#EAB308' },
];

const DEFAULT_SETTINGS: Settings = {
  rebuyValue: 30,
  chipsPerRebuy: 10000,
  minTransfer: 5,
};

// Default players (all permanent)
const DEFAULT_PLAYERS: Player[] = [
  { id: 'p1', name: 'ליאור', createdAt: new Date().toISOString(), type: 'permanent' },
  { id: 'p2', name: 'אייל', createdAt: new Date().toISOString(), type: 'permanent' },
  { id: 'p3', name: 'ארז', createdAt: new Date().toISOString(), type: 'permanent' },
  { id: 'p4', name: 'אורן', createdAt: new Date().toISOString(), type: 'permanent' },
  { id: 'p5', name: 'ליכטר', createdAt: new Date().toISOString(), type: 'permanent' },
  { id: 'p6', name: 'סגל', createdAt: new Date().toISOString(), type: 'permanent' },
  { id: 'p7', name: 'תומר', createdAt: new Date().toISOString(), type: 'permanent' },
  { id: 'p8', name: 'פיליפ', createdAt: new Date().toISOString(), type: 'permanent' },
  { id: 'p9', name: 'אסף', createdAt: new Date().toISOString(), type: 'permanent' },
  { id: 'p10', name: 'פבל', createdAt: new Date().toISOString(), type: 'permanent' },
  { id: 'p11', name: 'מלמד', createdAt: new Date().toISOString(), type: 'permanent' },
];

// Initialize default values if not exist
export const initializeStorage = (): void => {
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
  }
  if (!localStorage.getItem(STORAGE_KEYS.GAME_PLAYERS)) {
    setItem(STORAGE_KEYS.GAME_PLAYERS, []);
  }
  
  // Import historical games if not already imported
  importDec6GameIfNeeded();
  
  // Check for automatic Sunday backup
  checkAndAutoBackup();
};

// Players
export const getAllPlayers = (): Player[] => {
  return getItem<Player[]>(STORAGE_KEYS.PLAYERS, []);
};

export const addPlayer = (name: string, type: 'permanent' | 'guest' = 'permanent'): Player => {
  const players = getAllPlayers();
  const newPlayer: Player = {
    id: generateId(),
    name,
    createdAt: new Date().toISOString(),
    type,
  };
  players.push(newPlayer);
  setItem(STORAGE_KEYS.PLAYERS, players);
  return newPlayer;
};

// Update player type
export const updatePlayerType = (playerId: string, type: 'permanent' | 'guest'): void => {
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
        // Break-even doesn't break streaks but doesn't extend them either
      }
    }
    
    // Calculate current streak (from most recent games)
    for (let i = sortedPlayerGames.length - 1; i >= 0; i--) {
      const profit = sortedPlayerGames[i].profit;
      if (profit > 0) {
        if (currentStreak >= 0) currentStreak++;
        else break;
      } else if (profit < 0) {
        if (currentStreak <= 0) currentStreak--;
        else break;
      } else {
        break; // Break-even ends streak counting
      }
    }
    
    // Last 5 game results (most recent first)
    const lastFiveResults = sortedPlayerGames
      .slice(-5)
      .reverse()
      .map(pg => pg.profit);
    
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
      lastFiveResults,
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

// Check if Dec 6 game needs to be imported
export const importDec6GameIfNeeded = (): void => {
  const games = getAllGames();
  
  // Check if Dec 6 game already exists
  const dec6Exists = games.some(g => g.date.includes('2024-12-06'));
  if (dec6Exists) {
    return; // Already imported
  }
  
  // Dec 6, 2024 game data
  // Chip values: White=50, Red=100, Blue=200, Green=500, Black=1000, Yellow=5000
  const dec6Data = [
    { playerName: 'אייל', rebuys: 2.5, chipCounts: { '1': 14, '2': 14, '3': 11, '4': 25, '5': 11, '6': 6 }, finalValue: 57800, profit: 98.4 },
    { playerName: 'ליאור', rebuys: 2, chipCounts: { '1': 1, '2': 7, '3': 7, '4': 12, '5': 24, '6': 7 }, finalValue: 67150, profit: 141.5 },
    { playerName: 'ארז', rebuys: 3, chipCounts: { '1': 9, '2': 0, '3': 9, '4': 1, '5': 2, '6': 13 }, finalValue: 69750, profit: 119.3 },
    { playerName: 'ליכטר', rebuys: 6, chipCounts: { '1': 7, '2': 1, '3': 11, '4': 10, '5': 3, '6': 2 }, finalValue: 20650, profit: -118.1 },
    { playerName: 'תומר', rebuys: 3, chipCounts: { '1': 49, '2': 13, '3': 10, '4': 0, '5': 3, '6': 9 }, finalValue: 53750, profit: 71.3 },
    { playerName: 'אסף', rebuys: 3, chipCounts: { '1': 7, '2': 3, '3': 0, '4': 0, '5': 4, '6': 0 }, finalValue: 4650, profit: -76.1 },
    { playerName: 'סגל', rebuys: 8, chipCounts: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0, '6': 0 }, finalValue: 0, profit: -240.0 },
    { playerName: 'אורן', rebuys: 2, chipCounts: { '1': 13, '2': 11, '3': 2, '4': 2, '5': 3, '6': 3 }, finalValue: 21150, profit: 3.5 },
  ];
  
  importHistoricalGame('2024-12-06T22:00:00.000Z', dec6Data);
  console.log('Dec 6, 2024 game imported successfully!');
};

// ==================== BACKUP & RESTORE ====================

export interface BackupData {
  id: string;
  date: string;
  players: Player[];
  games: Game[];
  gamePlayers: GamePlayer[];
  chipValues: ChipValue[];
  settings: Settings;
}

// Create a backup of all data
export const createBackup = (isAutomatic: boolean = false): BackupData => {
  const backup: BackupData = {
    id: generateId(),
    date: new Date().toISOString(),
    players: getAllPlayers(),
    games: getAllGames(),
    gamePlayers: getItem<GamePlayer[]>(STORAGE_KEYS.GAME_PLAYERS, []),
    chipValues: getChipValues(),
    settings: getSettings(),
  };
  
  // Save to backups list
  const backups = getBackups();
  backups.unshift(backup); // Add to beginning (newest first)
  
  // Keep only last 4 backups
  while (backups.length > 4) {
    backups.pop();
  }
  
  setItem(STORAGE_KEYS.BACKUPS, backups);
  
  if (isAutomatic) {
    // Record that we did an auto-backup today
    setItem(STORAGE_KEYS.LAST_BACKUP_DATE, new Date().toDateString());
  }
  
  return backup;
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

// Download backup as JSON file
export const downloadBackup = (): void => {
  const backup = createBackup(false);
  const dataStr = JSON.stringify(backup, null, 2);
  const blob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = `poker-backup-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
  
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

// Check if we should auto-backup (Sunday and not already backed up today)
export const checkAndAutoBackup = (): boolean => {
  const today = new Date();
  const isSunday = today.getDay() === 0;
  
  if (!isSunday) return false;
  
  const lastBackupDate = getItem<string | null>(STORAGE_KEYS.LAST_BACKUP_DATE, null);
  const todayStr = today.toDateString();
  
  if (lastBackupDate === todayStr) {
    // Already backed up today
    return false;
  }
  
  // Create automatic backup
  createBackup(true);
  console.log('Automatic Sunday backup created!');
  return true;
};

