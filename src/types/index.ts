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

export type PlayerGender = 'male' | 'female';

export interface Player {
  id: string;
  name: string;
  createdAt: string;
  type: PlayerType;
  gender: PlayerGender;
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
  preGameTeaser?: string; // AI-generated pre-game teaser text (group-level)
}

export interface PeriodMarkers {
  isFirstGameOfMonth: boolean;
  isLastGameOfMonth: boolean;
  isFirstGameOfHalf: boolean;
  isLastGameOfHalf: boolean;
  isFirstGameOfYear: boolean;
  isLastGameOfYear: boolean;
  monthName: string;       // Hebrew month name
  halfLabel: string;       // e.g. "H1 2026"
  year: number;
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
  forecastComment?: string; // Cached AI summary comment for forecast vs reality
  forecastAccuracy?: {
    directionHits: number; // How many players' win/loss direction was predicted correctly
    totalPlayers: number;  // Total players compared
    avgGap: number;        // Average gap between forecast and actual
    score: number;         // 0-100 score (accurate=2, close=1, missed=0)
  };
  sharedExpenses?: SharedExpense[]; // Shared expenses (food, etc.) during the game
  aiSummary?: string; // Cached AI-generated game night narrative summary
  preGameTeaser?: string; // AI-generated pre-game teaser text
  periodMarkers?: PeriodMarkers; // Period context stored at game creation
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
  gameNightDays?: number[]; // Days of week for game nights (0=Sun..6=Sat), default [4,6]
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
  // Full game history (most recent first) - recent games weighted higher in forecasts
  lastGameResults: { profit: number; date: string; gameId: string }[];
  // Additional stats
  avgRebuysPerGame: number;
  avgWin: number;             // Average profit when winning
  avgLoss: number;            // Average loss when losing (as positive number)
}

export interface GameWithDetails extends Game {
  players: GamePlayer[];
  totalPot: number;
}

export type MilestoneCategory = 'battle' | 'streak' | 'milestone' | 'form' | 'drama' | 'record' | 'season' | 'h2h' | 'rebuy';
export type MilestoneSentiment = 'positive' | 'negative' | 'battle' | 'surprise';

export interface MilestoneItem {
  emoji: string;
  title: string;
  description: string;
  priority: number;
  category: MilestoneCategory;
  sentiment: MilestoneSentiment;
}

export interface DeviceFingerprint {
  gpu: string;
  cores: number;
  memory: number;
  touchPoints: number;
  language: string;
  timezone: string;
  canvasHash: string;
}

export interface ActivityLogEntry {
  deviceId: string;
  role: PermissionRole;
  timestamp: string;
  device: string;
  screenSize: string;
  screensVisited: string[];
  sessionDuration: number;
  lastActive: string;
  fingerprint?: DeviceFingerprint;
}

// --- Live Game AI TTS Pool ---

export type TTSPlaceholder = '{PLAYER}' | '{COUNT}' | '{POT}' | '{RECORD}' | '{RIVAL}' | '{RANK}';

export interface TTSMessage {
  text: string;
  placeholders?: TTSPlaceholder[];
}

export type TTSAnticipatedCategory =
  | 'above_avg'
  | 'record_tied'
  | 'record_broken'
  | 'is_leader'
  | 'rival_matched'
  | 'tied_for_lead';

export interface TTSPlayerMessages {
  generic: TTSMessage[];
  anticipated?: Partial<Record<TTSAnticipatedCategory, TTSMessage[]>>;
}

export interface TTSRivalry {
  player1: string;
  player2: string;
  description: string;
}

export interface LiveGameTTSPool {
  gameId: string;
  generatedAt: string;
  players: Record<string, TTSPlayerMessages>;
  shared: {
    first_blood: Record<string, TTSMessage[]>;
    bad_beat: Record<string, TTSMessage[]>;
    bad_beat_generic: TTSMessage[];
    big_hand: Record<string, TTSMessage[]>;
    big_hand_generic: TTSMessage[];
    break_time: TTSMessage[];
    auto_announce: TTSMessage[];
    awards_generosity: Record<string, TTSMessage[]>;
    awards_survival: Record<string, TTSMessage[]>;
  };
  rivalries: TTSRivalry[];
  usedIndices: Record<string, number[]>;
  spokenTexts: string[];
}

