export interface Player {
  id: string;
  name: string;
  createdAt: string;
  type: 'permanent' | 'guest';
}

export interface Game {
  id: string;
  date: string;
  status: 'live' | 'chip_entry' | 'completed';
  createdAt: string;
  chipGap?: number; // Gap in money value (positive = extra chips, negative = missing chips)
  chipGapPerPlayer?: number; // How much each player's profit was adjusted
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
  lastGameResults: number[];  // Last 6 game results (profit values, most recent first)
  // Additional stats
  avgRebuysPerGame: number;
  avgWin: number;             // Average profit when winning
  avgLoss: number;            // Average loss when losing (as positive number)
}

export interface GameWithDetails extends Game {
  players: GamePlayer[];
  totalPot: number;
}

