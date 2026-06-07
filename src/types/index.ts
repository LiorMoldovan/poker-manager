export type PlayerType = 'permanent' | 'permanent_guest' | 'guest';

// Permission system
export type PermissionRole = 'admin' | 'member';

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

export interface PlayerTraits {
  team?: string;
  job?: string;
  nickname?: string;
  style: string[];
  quirks: string[];
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
  aiModel?: string; // Model used to generate the forecast
  published?: boolean; // When true, visible to all roles on the new game page
  location?: string; // Location used when generating the forecast
}

export interface PeriodMarkers {
  isFirstGameOfMonth: boolean;
  isLastGameOfMonth: boolean;
  isFirstGameOfHalf: boolean;
  isLastGameOfHalf: boolean;
  isFirstGameOfYear: boolean;
  isLastGameOfYear: boolean;
  monthName: string;       // Hebrew month name
  halfLabel: string;       // e.g. "חציון ראשון 2026"
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
  aiSummaryModel?: string; // Model used to generate the AI summary
  preGameTeaser?: string; // AI-generated pre-game teaser text
  periodMarkers?: PeriodMarkers; // Period context stored at game creation
  paidSettlements?: PaidSettlement[];
  comicUrl?: string; // Public Supabase Storage URL of the rendered comic PNG
  comicScript?: ComicScript; // Panels, dialogue + per-character bboxes for client-side bubble overlay
  comicStyle?: ComicStyleKey; // Which visual style was used (newspaper, manga, ...)
  comicGeneratedAt?: string; // ISO timestamp of last generation (for regen rate-limit)
}

// ─── Game-Night Comic ─────────────────────────────────────────
// Cached on `games` row so every group member sees the same comic.
// Hebrew speech text lives in this script and is rendered as DOM
// over the art image; the model never draws letters itself, which
// guarantees crisp Hebrew typography regardless of style.

export type ComicStyleKey =
  | 'newspaper'
  | 'manga'
  | 'noir'
  | 'pixar3d'
  | 'tintin'
  | 'retro70s';

export type ComicBubbleType = 'speech' | 'thought' | 'shout' | 'caption';

export interface ComicBubble {
  speaker: string;       // exact player name from `tonight`, or 'narrator' for captions
  text: string;          // Hebrew dialogue (1 short line, ≤ ~40 chars)
  type: ComicBubbleType;
}

export interface ComicPanel {
  id: 1 | 2 | 3 | 4;
  scene: string;         // English description of the scene fed back into the art prompt
  characters: string[];  // Character descriptions ('name:expression') — drives consistency
  bubbles: ComicBubble[];
  /**
   * Bounding box of the speaker's face (or bubble anchor target) in NORMALIZED
   * coordinates [0..1] of the full comic image. [yMin, xMin, yMax, xMax]
   * matches Gemini's native bbox format. Filled by the bbox-detection stage.
   */
  bboxes?: Record<string, [number, number, number, number]>;
}

export interface ComicScript {
  style: ComicStyleKey;
  title: string;         // Short Hebrew title (optional caption strip)
  panels: ComicPanel[];
  /** 2x2 grid layout (default). Reserved for future single-row variants. */
  layout?: '2x2' | '1x4';
  /** Total image dimensions (px) — used to convert normalized bboxes to pixels. */
  width?: number;
  height?: number;
  modelText?: string;    // Display name of model used for script (debug)
  modelImage?: string;   // Display name of model used for art (debug)
}

export interface PaidSettlement {
  from: string;
  to: string;
  paidAt: string;
  amount?: number;
  autoClosed?: boolean;
}

// ─────────────────────────────────────────────────────────────
// Game Scheduling Polls (migration 022)
// ─────────────────────────────────────────────────────────────

export type GamePollStatus = 'open' | 'expanded' | 'confirmed' | 'cancelled' | 'expired';

export type RsvpResponse = 'yes' | 'no' | 'maybe';

export interface GamePollDate {
  id: string;
  pollId: string;
  proposedDate: string;          // ISO date 'YYYY-MM-DD'
  proposedTime?: string | null;  // 'HH:MM' or null
  location?: string | null;
  createdAt: string;
  // Migration 086: admin per-date exclude. When set, the date is
  // greyed out, RSVPs are blocked server-side ('date_disabled'),
  // and the auto-close trigger ignores it. Existing votes are
  // preserved — clearing the field brings the voter list back as-is.
  disabledAt?: string | null;
}

export interface GamePollVote {
  id: string;
  pollId: string;
  dateId: string;
  playerId: string;
  userId: string | null;            // NULL when admin cast on behalf of an unregistered player
  response: RsvpResponse;
  comment?: string | null;
  votedAt: string;
  createdAt: string;                // first time this row was inserted; stays fixed across edits
  castByUserId?: string | null;     // auth.uid() of the user who last cast/edited this vote
}

export interface GamePoll {
  id: string;
  groupId: string;
  createdBy: string;
  createdAt: string;
  status: GamePollStatus;
  targetPlayerCount: number;
  expansionDelayHours: number;
  expandedAt?: string | null;
  confirmedDateId?: string | null;
  confirmedAt?: string | null;
  confirmedGameId?: string | null;
  note?: string | null;
  defaultLocation?: string | null;
  allowMaybe: boolean;
  cancellationReason?: string | null;
  // Migration 039: admin-toggleable soft lock on voting. NULL = open
  // to votes; non-null timestamp = frozen by admin (status keeps its
  // independent meaning, so an open/expanded/confirmed poll can be
  // locked without changing status). Members see RSVP buttons greyed
  // out; cast_poll_vote / admin_cast_poll_vote / admin_delete_poll_vote
  // raise 'voting_locked' on the server side.
  votingLockedAt?: string | null;
  // Migration 040: short auto-generated 6-char base32 slug used as a
  // pretty alternative to the UUID in WhatsApp share captions
  // (`/p/<slug>`). Server-side: NOT NULL after the trigger fires.
  // Client-side: optional because old in-flight rows / SSR snapshots
  // may not have it yet.
  shareSlug?: string | null;
  creationNotificationsSentAt?: string | null;
  expandedNotificationsSentAt?: string | null;
  confirmedNotificationsSentAt?: string | null;
  cancellationNotificationsSentAt?: string | null;
  // Migration 051: independent claim slot for the post-pin "המשחק מלא"
  // follow-up. NULL until the seat target has been reached AND we've
  // sent (or preemptively claimed for the at-target confirmed flow) the
  // follow-up notification. Reset to NULL on re-pin.
  targetFilledNotificationsSentAt?: string | null;
  // Migration 098: how the poll was opened. 'admin' = a person opened it
  // (createdByName holds their snapshotted display name); 'auto' = the weekly
  // auto-schedule opened it (client OR server cron), createdByName is null.
  createdSource: 'admin' | 'auto';
  createdByName?: string | null;
  // Embedded children (populated by cache layer)
  dates: GamePollDate[];
  votes: GamePollVote[];
}

export interface CreatePollDateInput {
  proposedDate: string;          // 'YYYY-MM-DD'
  proposedTime?: string | null;  // 'HH:MM'
  location?: string | null;
}

export interface CreatePollInput {
  dates: CreatePollDateInput[];   // 2-5
  targetPlayerCount?: number;     // default 8
  expansionDelayHours?: number;   // default 48
  defaultLocation?: string | null;
  allowMaybe?: boolean;           // default true
  note?: string | null;
  // 'admin' (default) when a person opens the poll; 'auto' when the
  // client-side weekly auto-schedule opens it. Threaded to create_game_poll.
  source?: 'admin' | 'auto';
}

export interface AppNotification {
  id: string;
  groupId: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  read: boolean;
  createdAt: string;
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
  // Migration 080 — quick-total chip entry mode.
  // 'color' (default) reads chipCounts the way it always did.
  // 'total' reads totalChipCount and ignores chipCounts (which stays {}).
  // Stored on game_players so reload / mid-entry refresh / reopen-after-
  // completion all render the right modal without local state guessing.
  entryMode: 'color' | 'total';
  totalChipCount?: number | null;
}

export interface ChipValue {
  id: string;
  color: string;
  value: number;
  displayColor: string;
  // Per-color reference photo for the rebuilt photo chip-counting
  // pipeline (v5.59+). Both fields are optional — groups that haven't
  // taken selfies still work, the pipeline falls back to displayColor
  // for color matching and drops the few-shot reference image from
  // the per-stack LLM prompt.
  selfieBase64?: string | null;
  selfieDominantHex?: string | null;
}

// One stack the AI saw in a chip-counting photo.
// `position` is 1-indexed in the canonical chip order — always
// chipValues sorted by denomination ascending (small → high).
// `count` may be 0 when the player has none of that denomination.
// `confidence` is the AI's self-reported certainty (0-100); we treat
// it as a soft signal, not a probability — the per-stack colored
// borders in ChipEntryScreen surface it visually so the user can
// glance-verify before accepting.
export interface PhotoChipCountStack {
  position: number;
  chipId: string;       // matches ChipValue.id
  color: string;        // canonical color name from ChipValue.color (for display)
  count: number;
  // 0-100. As of v5.59 (per-stack rebuild) this is COMPUTED by
  // `combineLLMAndGeometry` from cross-method agreement — LLM count
  // vs. three independent geometric methods (bottom-chip self-cal,
  // gradient counting, shared cross-stack cal). The model's own
  // self-reported confidence is ignored entirely; we derive an honest
  // signal from physical / mathematical checks plus stack-height
  // weighting (taller stacks start with lower confidence regardless
  // of method agreement).
  confidence: number;
  // ── Legacy v5.48-v5.58 fields (kept for backward-compat with
  //    feedback rows already written; new pipeline doesn't populate). ──
  rawCounts?: number[];
  topColorHex?: string;
  colorMatch?: boolean;
  needsRecount?: boolean;
  // ── v5.59+ rebuild fields (all optional for backward compat). ──
  // The detected chip-stack region in source-image pixel coordinates.
  // Used by ChipEntryScreen / SettingsScreen to draw the detection
  // overlay (colored bounding boxes + count labels) on the photo
  // thumbnail. Empty-stack placeholders carry a tiny placeholder
  // region (1×1) that the UI knows to skip.
  region?: { x: number; y: number; width: number; height: number };
  // Geometric count from chipGeometry.ts (the better of bottom-chip /
  // gradient / shared-cal methods after voting). null when all three
  // methods failed.
  geometricCount?: number | null;
  geometricMethod?:
    | 'bottom-chip'
    | 'gradient-count'
    | 'shared-cal'
    | 'failed'
    | 'empty-stack-detected';
  // 0-1. Cross-method agreement signal computed by
  // `combineLLMAndGeometry`. Higher = more confidence both signals
  // landed on the same value. The new chip_count_feedback dashboard
  // surfaces aggregate "agreement %" as a per-color KPI.
  agreementScore?: number;
  // True when LLM and geometry disagreed enough that the user should
  // double-check this stack. Drives the yellow-border + tooltip in
  // the chip-row inputs.
  needsVerify?: boolean;
  // Detected dominant body color of the stack (after white-balance
  // correction). Useful for debugging color-mapping decisions.
  detectedDominantHex?: string;
  // Full provenance of how the final count was reached, persisted to
  // the feedback row for diagnostic purposes. When the user reports
  // "AI was wrong by 2", we can see whether LLM, geometry, color
  // mapping, or total-value reconciliation was the culprit.
  provenance?: {
    llmCount: number | null;
    geometryBottomChip: number | null;
    geometryGradientCount: number | null;
    geometrySharedCal: number | null;
    totalValueAdjustedFrom?: number | null;
    finalCount: number;
    finalConfidence: number;
    reasoning: string; // human-readable English summary
  };
}

// Stable error code for photo-based chip counting failures. The UI
// translates these into the user's language; `error` itself stays
// English so it's still useful in console logs.
//
//   missingImage         — no image data was sent (caller bug)
//   noChipsConfig        — group has no chip values defined
//   network              — fetch threw before a response came back
//   httpError            — proxy/upstream returned non-2xx (message in `error`)
//   parseFailed          — model returned text we couldn't parse as JSON
//                          even after the tolerant repair pass
//   unexpectedShape      — JSON parsed OK but `stacks` array is missing
//   cancelled            — caller aborted the request before it finished
//   stackDetectionFailed — v5.59+: client-side stack detection found nothing
//                          usable (extremely rare; only blank/corrupt photos)
export type PhotoChipCountErrorCode =
  | 'missingImage'
  | 'noChipsConfig'
  | 'network'
  | 'httpError'
  | 'parseFailed'
  | 'unexpectedShape'
  | 'cancelled'
  | 'stackDetectionFailed'
  // v6.4.1 — distinguish "out of free-tier RPM/RPD" from generic
  // HTTP errors so the retry loop skips burning a second attempt
  // on the same wall (retry can't fix quota; user must wait or
  // upgrade tier). UI can also render a quota-specific message
  // instead of the generic "model busy".
  | 'quotaExceeded';

// Result of one photo-based chip count attempt. Returned by
// countChipsFromPhoto in geminiAI.ts. `error` is set only when the
// flow couldn't produce usable counts (network error, malformed JSON,
// no chips detected) — UI should surface it as a toast and leave the
// existing manual-entry state untouched. `errorCode` is set whenever
// `error` is, and lets the UI pick a localized message instead of
// showing the raw English diagnostic string to Hebrew users.
export interface PhotoChipCountResult {
  stacks: PhotoChipCountStack[];
  // 0-100. Capped at 95% even when all signals look perfect — the
  // honest framing is "AI estimate, please verify". 100% would imply
  // we'd risk the player's money on it, which we won't. As of v5.59
  // this is computed as the stack-count-weighted average of per-stack
  // confidence values (a 10-chip stack contributes more than a 2-chip
  // stack to the overall photo's confidence).
  overallConfidence: number;
  totalValue: number;            // Σ(count × chipValue) across all returned stacks
  modelUsed: string;             // e.g. 'gemini-2.5-flash×N' (model + per-stack call count)
  // ── Legacy v5.48-v5.58 fields (kept for backward-compat with
  //    callers that still read them; new pipeline doesn't populate). ──
  shotsUsed?: number;
  // Total-value mismatch as a fraction of expected, signed:
  //   +0.15 = reported total is 15% over expected
  //   -0.40 = reported total is 40% under expected
  // 0 / undefined when no expectedTotalValue was supplied.
  totalValueDelta?: number;
  // Chip IDs whose individual confidence dropped below 70% (legacy);
  // new pipeline writes the same info as `needsVerify` per stack.
  recountStackIds?: string[];
  // ── v5.59+ rebuild fields. ──
  // Did the per-photo white-balance correction kick in (>= 50 stripe
  // pixels were available)? When false, the camera color cast was not
  // neutralized and color-mapping accuracy is reduced.
  whiteBalanceApplied?: boolean;
  // Result of the post-LLM total-value sanity check (live game flow
  // only — null when no expectedTotalValue was supplied). When the
  // summed AI total is off by exactly one chip denomination from the
  // expected bankroll, the lowest-confidence non-edited stack gets a
  // ±1 nudge to reconcile. The provenance for the adjusted stack
  // records `totalValueAdjustedFrom`. UI surfaces a small purple badge.
  totalValueCheckResult?: {
    expected: number;
    computed: number;
    adjustedStackId: string | null;  // null when no adjustment was applied
    adjustmentChips: number;         // -1, 0, or +1
  } | null;
  // Diagnostic from `detectStackRegions`: which signal won (white-stripe
  // density / edge density / position-only fallback). Persisted to the
  // feedback row so we can spot photos where the primary signal kept
  // failing and tune the thresholds.
  detectionSignal?: 'white-stripe' | 'edge-density' | 'position-only';
  error?: string;                // English diagnostic for logs/devs
  errorCode?: PhotoChipCountErrorCode;
}

export interface BlockedTransferPair {
  playerA: string;
  playerB: string;
  after: string; // ISO date string — rule active for games after this date
}

// Per-event email kinds the admin can individually toggle from
// Settings → Schedule. Mirrors the EMAIL_ALLOWLIST in
// `src/utils/scheduleNotifications.ts` plus `date_excluded` (which uses
// its own dispatch path but is the same shape of "an email goes out
// when X happens"). Persisted as a JSONB object on settings under
// `schedule_email_kinds` (migration 090). `vote_change` is push-only
// by design (every RSVP fires; emailing each one would flood quota) so
// it intentionally has no toggle here.
export type ScheduleEmailKind =
  | 'creation'        // 🃏 ערב פוקר חדש — invitation goes out
  | 'expanded'        // 🎯 ההצבעה פתוחה לכולם — opened to all tiers
  | 'confirmed'       // ✅ נסגר! / 🪑 חסרים שחקנים — date pinned
  | 'target_filled'   // 🎉 המשחק מלא — seat target finally hit post-pin
  | 'cancellation'    // ❌ ההצבעה בוטלה — admin cancelled
  | 'reminder'        // 📣 תזכורת להצבעה — admin sent manual reminder
  | 'date_excluded';  // ✂️ תאריך הוצא — admin removed a date

export interface Settings {
  rebuyValue: number;
  chipsPerRebuy: number;
  minTransfer: number;
  gameNightDays?: number[]; // Days of week for game nights (0=Sun..6=Sat), default [4,6]
  locations?: string[];
  // Optional exact street address per location NAME (migration 094).
  // Keyed by the same string stored in `locations` / `games.location`.
  // A name absent from the map has no known address → no Waze link.
  // Kept separate from `locations` so the string[] shape stays intact.
  locationAddresses?: Record<string, string>;
  // Optional free-text ARRIVAL DETAILS per location name (migration 095):
  // floor, apartment, door/key code, parking hints, etc. Multi-line.
  // Separate from the address so the Waze query stays clean. Keyed by
  // the same location NAME as `locations` / `locationAddresses`.
  locationNotes?: Record<string, string>;
  blockedTransfers?: BlockedTransferPair[];
  geminiApiKey?: string;
  elevenlabsApiKey?: string;
  language?: 'he' | 'en';
  scheduleEmailsEnabled?: boolean; // Master kill switch: when false, ALL schedule emails skip regardless of scheduleEmailKinds
  schedulePushEnabled?: boolean;   // Beta-period toggle: when false, schedule notifications skip push broadcasts (default true)
  // Per-event email allowlist (migration 090). Layered ON TOP of the
  // master `scheduleEmailsEnabled` toggle — both must be truthy for an
  // email of that kind to fire. Default object has every key = true,
  // so existing groups with the master ON keep blasting every kind.
  // Flipping a key to false lets an admin suppress (e.g.) reminder
  // emails while keeping invitation emails on, to manage EmailJS
  // quota without losing the high-signal "ערב פוקר חדש" broadcast.
  scheduleEmailKinds?: Partial<Record<ScheduleEmailKind, boolean>>;
  // Group-level defaults pre-filled in CreatePollModal (still editable per poll)
  scheduleDefaultTarget?: number;          // 2..12, default 7
  scheduleDefaultDelayHours?: number;      // 0..240, default 48
  scheduleDefaultTime?: string;            // 'HH:MM' 24h, default '21:00'
  scheduleDefaultAllowMaybe?: boolean;     // default true
  // Auto-create-poll schedule. When enabled, ScheduleTab auto-opens a new
  // poll the first time any admin loads the tab at-or-after the next
  // weekly trigger occurrence (day-of-week + time). Uses the group's
  // existing default-poll values for shape (target, delay, allow-maybe,
  // proposed date = nextGameNightIso).
  scheduleAutoCreateEnabled?: boolean;     // default false
  scheduleAutoCreateDay?: number;          // 0=Sun..6=Sat, default 0 (Sunday)
  scheduleAutoCreateTime?: string;         // 'HH:MM' 24h, default '18:00'
  scheduleAutoCreatedAt?: string;          // ISO timestamp of last auto-create fire (re-fire guard)
  // DEPRECATED (2026-05-09). Was a configurable left-to-right photo
  // order for chip stacks. Replaced by a single canonical rule:
  // "always sort by denomination ascending (small → high)" — derived
  // at call sites from getChipValues(). The DB column
  // `settings.chip_color_order` and this field are retained so existing
  // rows still load cleanly through the cache mappers; nothing reads
  // them anymore. Safe to drop in a future cleanup migration.
  chipColorOrder?: string[];
  // Owner opt-in (group-level): when true, the photo chip-counting
  // flow uploads the enhanced photo it sent to the AI to a PRIVATE
  // Supabase Storage bucket alongside the numeric feedback row, so
  // the developer can replay the exact image when tuning the
  // pipeline. Default false — only the anonymous-ish numeric data
  // (per-stack ai vs real counts, model, confidence) is captured
  // unless this is on. Migration 069. Owner-only toggle in Settings
  // → Services tab.
  shareChipPhotos?: boolean;
  // Migration 080 — group default for which chip-entry mode opens
  // with a single tap on the BIG (player name) zone of each player
  // tile. The OTHER mode is always one labeled tap away on the same
  // tile, so both modes mix freely inside the same game. 'color' =
  // today's per-color counting (default for all existing groups);
  // 'total' = quick single-input mode (new groups that don't count
  // by color flip this to 'total' once and never touch it again).
  chipEntryDefaultMode?: 'color' | 'total';
}

// v5.62.2 — chip-count feedback types removed alongside the loop.
// `ChipCountFeedbackStack`, `ChipCountFeedbackPipelineMeta`, and
// `ChipCountFeedback` lived here to type the rows we wrote to
// `chip_count_feedback`. The Supabase table + storage bucket
// remain as harmless legacy; if a future pipeline brings the
// feedback loop back, recreate these types fresh from whatever
// shape that iteration actually needs (don't resurrect the
// v5.59-era per-stack diagnostics — they describe a pipeline
// that no longer exists).

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
  playerName?: string;
  userId?: string;
}

// --- Live Game AI TTS Pool ---

// ═══ Shared Training Pool ═══

export interface PoolScenario {
  poolId: string;
  situation: string;
  yourCards: string;
  boardCards?: string;
  options: {
    id: string;
    text: string;
    isCorrect: boolean;
    explanation: string;
    nearMiss?: boolean; // wrong answer that would be correct in professional/GTO poker
  }[];
  category: string;
  categoryId: string;
  reviewedAt?: string; // ISO timestamp — set when AI review marks this scenario as ok/fixed
}

export interface TrainingPool {
  generatedAt: string;
  totalScenarios: number;
  byCategory: Record<string, number>;
  scenarios: PoolScenario[];
}

export interface TrainingAnswerResult {
  poolId: string;
  categoryId: string;
  correct: boolean;
  nearMiss?: boolean; // chose a GTO-valid answer that's suboptimal for home game
  neutralized?: boolean; // question was later found faulty — doesn't count for/against score
  chosenId: string;
}

export type FlagReason = 'wrong_answer' | 'unclear_question' | 'wrong_for_home_game' | 'other';

export interface TrainingFlagReport {
  poolId: string;
  playerName: string;
  reason: FlagReason;
  comment?: string;
  date: string;
}

export interface TrainingSession {
  date: string;
  questionsAnswered: number;
  correctAnswers: number;
  results: TrainingAnswerResult[];
  flaggedPoolIds?: string[];
  flagReports?: TrainingFlagReport[];
}

export interface TrainingPlayerReport {
  milestone: number;
  text: string;
  date: string;
}

export interface TrainingPlayerData {
  playerName: string;
  sessions: TrainingSession[];
  totalQuestions: number;
  totalCorrect: number;
  accuracy: number;
  reports?: TrainingPlayerReport[];
  pendingReportMilestones?: number[];
}

export interface TrainingAnswersFile {
  lastUpdated: string;
  players: TrainingPlayerData[];
}

export interface TrainingInsightsFile {
  lastUpdated: string;
  insights: Record<string, {
    generatedAt: string;
    sessionsAtGeneration: number;
    improvement: string;
  }>;
}

export interface TrainingExploitationLocal {
  generatedAt: string;
  sessionsAtGeneration: number;
  text: string;
}

export interface TrainingBadge {
  id: string;
  name: string;
  icon: string;
  description: string;
  check: (progress: SharedTrainingProgress) => boolean;
}

export interface SharedTrainingProgress {
  totalQuestions: number;
  totalCorrect: number;
  totalNeutral: number;
  sessionsCompleted: number;
  byCategory: Record<string, { total: number; correct: number }>;
  streak: { current: number; lastTrainingDate: string | null };
  maxStreak: number;
  longestCorrectRun: number;
  currentCorrectRun: number;
  earnedBadgeIds: string[];
  seenPoolIds: string[];
  flaggedPoolIds: string[];
}

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

