export type PlayerType = 'permanent' | 'permanent_guest' | 'guest';

// Permission system
export type PermissionRole = 'admin' | 'member' | 'memberSync' | 'viewer';

export type Permission = 
  // Game management
  | 'game:create'
  | 'game:manage_rebuys'
  | 'game:enter_chips'
  | 'game:finalize'
  | 'game:delete'
  | 'game:clear_all'
  // Player management
  | 'player:add'
  | 'player:edit'
  | 'player:change_type'
  | 'player:delete'
  // Chip values
  | 'chips:edit'
  // Settings
  | 'settings:edit'
  // Backup (all roles have this)
  | 'backup:all'
  // View (all roles have this)
  | 'view:all';

export interface Player {
  id: string;
  name: string;
  createdAt: string;
  type: PlayerType;
}

export interface GameForecast {
  playerName: string;
  expectedProfit: number;
  highlight?: string;
  sentence?: string;
  isSurprise?: boolean;
}

export interface PendingForecast {
  id: string;
  createdAt: string;
  playerIds: string[];  // Selected player IDs at time of forecast
  forecasts: GameForecast[];
  linkedGameId?: string;  // Set when game starts
}

// Shared expense (food, pizza, etc.) during a game
export interface SharedExpense {
  id: string;
  description: string;      // e.g., "Pizza", "Food", etc.
  paidBy: string;           // playerId of who paid
  paidByName: string;       // player name of who paid (for display)
  amount: number;           // total amount paid
  participants: string[];   // playerIds who are splitting the cost
  participantNames: string[]; // player names (for display)
  createdAt: string;
}

export interface Game {
  id: string;
  date: string;
  status: 'live' | 'chip_entry' | 'completed';
  createdAt: string;
  location?: string; // Optional game location (e.g., host name)
  chipGap?: number; // Gap in money value (positive = extra chips, negative = missing chips)
  chipGapPerPlayer?: number; // How much each player's profit was adjusted
  forecasts?: GameForecast[]; // Forecasts made before the game started
  sharedExpenses?: SharedExpense[]; // Shared expenses (food, etc.) during the game
}

export interface GamePlayer {
  id: string;
  gameId: string;
  playerId: string;
  playerName: string;
  rebuys: number;
  chipCounts: Record<string, number>;
  finalValue: number;
  profit: number;
}

export interface ChipValue {
  id: string;
  color: string;
  value: number;
  displayColor: string;
}

export interface Settings {
  rebuyValue: number;
  chipsPerRebuy: number;
  minTransfer: number;
}

export interface Settlement {
  from: string;
  to: string;
  amount: number;
}

export interface SkippedTransfer {
  from: string;
  to: string;
  amount: number;
}

export interface GameAction {
  type: 'rebuy';
  playerId: string;
  playerName: string;
  timestamp: string;
  amount: number; // 1 for full rebuy, 0.5 for half rebuy
}

export interface PlayerStats {
  playerId: string;
  playerName: string;
  gamesPlayed: number;
  totalProfit: number;
  totalGains: number;    // Sum of all positive profits
  totalLosses: number;   // Sum of all negative profits (as positive number)
  avgProfit: number;
  winCount: number;
  lossCount: number;
  winPercentage: number;
  totalRebuys: number;
  biggestWin: number;
  biggestLoss: number;
  // Streaks
  currentStreak: number;      // Positive = wins, negative = losses
  longestWinStreak: number;
  longestLossStreak: number;
  // Recent history
  lastGameResults: { profit: number; date: string; gameId: string }[];  // Last 6 game results (most recent first)
  // Additional stats
  avgRebuysPerGame: number;
  avgWin: number;             // Average profit when winning
  avgLoss: number;            // Average loss when losing (as positive number)
}

export interface GameWithDetails extends Game {
  players: GamePlayer[];
  totalPot: number;
}

