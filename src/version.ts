/**
 * App Version Management
 * Increment version with each change for tracking purposes
 */

export const APP_VERSION = '4.10.3';

export interface ChangelogEntry {
  version: string;
  date: string;
  changes: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '4.10.3',
    date: '2025-12-18',
    changes: [
      'AI Forecast: Smarter, cleaner prompt 🧠',
      'No more repetitive "loses to X" for every player',
      'Each player gets unique highlight - different angle',
      'Common sense: dominant player mentioned once, not everywhere',
      'Shorter, punchier sentences'
    ]
  },
  {
    version: '4.10.2',
    date: '2025-12-18',
    changes: [
      'Forecast screenshot: Fixed sort order (highest to lowest)',
      'Forecast screenshot: Shows minus sign for negative amounts',
      'Screenshot now matches on-screen display order'
    ]
  },
  {
    version: '4.10.1',
    date: '2025-12-18',
    changes: [
      'AI Forecast: Rate limit countdown timer ⏳',
      'Shows 60-second countdown when rate limited',
      'Option to use static forecast while waiting',
      'Notifies when ready to retry'
    ]
  },
  {
    version: '4.10.0',
    date: '2025-12-18',
    changes: [
      'AI Forecast: Player dynamics analysis 🤝',
      'Analyzes how players perform when playing TOGETHER',
      'Finds rivalries and patterns between specific players',
      'Sentences reference the actual group dynamics',
      'More game history (15 games) for better analysis'
    ]
  },
  {
    version: '4.9.9',
    date: '2025-12-18',
    changes: [
      'AI Forecast: Enhanced creativity and variety 🎲',
      'Random seed + timestamp ensures different results each time',
      'Prompt emphasizes: surprise, originality, varied styles',
      'Never boring or repetitive - even with same players!'
    ]
  },
  {
    version: '4.9.8',
    date: '2025-12-18',
    changes: [
      'Data Fix: Corrected all player types (permanent/guest/occasional)',
      '11 permanent, 5 permanent_guest, 24 guest players',
      'Synced to all users via cloud sync'
    ]
  },
  {
    version: '4.9.7',
    date: '2025-12-18',
    changes: [
      'Forecast: Sorted by expected profit (highest first) 📊',
      'Winners at the top, losers at the bottom'
    ]
  },
  {
    version: '4.9.6',
    date: '2025-12-18',
    changes: [
      'Forecast: Split into multiple screenshots for many players 📸',
      '5 players per screenshot to fit WhatsApp better',
      'Page numbers shown when multiple screenshots (1/2, 2/2)',
      'All screenshots shared in one click'
    ]
  },
  {
    version: '4.9.4',
    date: '2025-12-18',
    changes: [
      'UI: Aligned medal positions across all tables 🏅',
      'Medals now appear AFTER player name everywhere',
      'Game Summary, Game Details, WhatsApp sharing - all consistent'
    ]
  },
  {
    version: '4.9.2',
    date: '2025-12-18',
    changes: [
      'Voice: Improved English voice - prefers female voices 🎙️',
      'Tries Samantha, Zira, Susan, Karen voices',
      'Console logs available voices for debugging',
      'Natural pace and pitch settings'
    ]
  },
  {
    version: '4.9.1',
    date: '2025-12-18',
    changes: [
      'Voice: Better English voice selection 🎙️',
      'Prefers Google/Enhanced/Premium voices',
      'Falls back to British English for clarity',
      'Pre-loads voices on page load'
    ]
  },
  {
    version: '4.9.0',
    date: '2024-12-18',
    changes: [
      'AI Forecast: Complete API diagnostic rewrite',
      'First lists available models to verify API key access',
      'Tries v1beta AND v1 API versions',
      'Detailed troubleshooting in console'
    ]
  },
  {
    version: '4.8.11',
    date: '2025-12-18',
    changes: [
      'Voice: Hebrew name + English "buyin" 🗣️',
      'Player name spoken in natural Hebrew',
      'Action spoken in natural English ("buyin" / "half buyin")'
    ]
  },
  {
    version: '4.8.10',
    date: '2025-12-18',
    changes: [
      'Voice: Added alert chime before announcement 🔔',
      'Pleasant ding-dong sound to get attention',
      'Then speaks the player name + action'
    ]
  },
  {
    version: '4.8.9',
    date: '2024-12-18',
    changes: [
      'AI Forecast: Auto-detects working Gemini model',
      'Tries: gemini-pro, gemini-1.5-pro, gemini-1.5-flash, gemini-1.0-pro',
      'Saves working model for future use',
      'Better error logging in console'
    ]
  },
  {
    version: '4.8.8',
    date: '2025-12-18',
    changes: [
      'Voice: Changed to natural Hebrew - "קנה" / "קנה חצי"',
      'Sounds better than English "buyin" transliteration'
    ]
  },
  {
    version: '4.8.7',
    date: '2025-12-18',
    changes: [
      'NEW: Voice announcement for buyins! 🔊',
      'Says player name + action in Hebrew',
      'Helps prevent mistakes during the game'
    ]
  },
  {
    version: '4.8.6',
    date: '2024-12-18',
    changes: [
      'Fixed: AI API model endpoint (was 404)',
      'Now using gemini-pro model'
    ]
  },
  {
    version: '4.8.5',
    date: '2024-12-18',
    changes: [
      'AI Forecast: Dynamic profit range per player',
      'Based on player historical range (best win to worst loss)',
      'High variance players get more extreme forecasts',
      'Low variance players get moderate forecasts'
    ]
  },
  {
    version: '4.8.4',
    date: '2024-12-18',
    changes: [
      'AI Forecast: Enhanced prompt with better rules',
      'Highlight now explains the REASON for the forecast',
      'Extra weight given to recent games',
      'Detects patterns: gaps, streaks, trend changes',
      'If forecast goes against history - mentions it'
    ]
  },
  {
    version: '4.8.3',
    date: '2025-12-18',
    changes: [
      'Screenshot: Reverted to original vertical layout on screen',
      'Share now sends 2 separate images (Results + Settlements)',
      'Both images sent in one click via native share'
    ]
  },
  {
    version: '4.8.2',
    date: '2024-12-18',
    changes: [
      'AI Forecast: Fixed API key test function',
      'AI now receives FULL game history (not just last 10)',
      'Data sent only for selected players',
      'Better error logging for debugging'
    ]
  },
  {
    version: '4.8.1',
    date: '2025-12-18',
    changes: [
      'Screenshot: 2-column layout - Results and Settlements side by side',
      'More compact screenshot for sharing with many players',
      'Smaller fonts and tighter spacing in screenshot'
    ]
  },
  {
    version: '4.8.0',
    date: '2024-12-18',
    changes: [
      'NEW: AI-Powered Forecasts! 🤖',
      'Uses Google Gemini AI for creative, personalized predictions',
      'AI receives ALL player data: stats, streaks, recent games, history',
      'Dynamic, unique forecasts every time',
      'Sarcastic comments for inactive players',
      'Free to use - just add your Gemini API key in Settings',
      'Fallback to static forecasts if no API key'
    ]
  },
  {
    version: '4.7.0',
    date: '2025-12-18',
    changes: [
      'NEW: Graphs feature (Admin only) 📊',
      'Cumulative Profit Line Chart - visualize profit trends over time',
      'Head-to-Head Comparison - compare any 2 players side by side',
      'Leaderboard Race - animated ranking progression with replay',
      'Player selector for filtering graphs',
      'Interactive tooltips and legends'
    ]
  },
  {
    version: '4.6.41',
    date: '2025-12-18',
    changes: [
      'Removed "Import Historical Data" feature (replaced by cloud sync)',
      'Cleaned up unused import scripts and files'
    ]
  },
  {
    version: '4.6.40',
    date: '2025-12-18',
    changes: [
      'Fix: CORS error when fetching from GitHub API',
      'Removed Cache-Control header that was blocked'
    ]
  },
  {
    version: '4.6.39',
    date: '2025-12-18',
    changes: [
      'Fix: Proper UTF-8 decoding for Hebrew names in sync',
      'Added sync debugging logs to console'
    ]
  },
  {
    version: '4.6.38',
    date: '2025-12-18',
    changes: [
      'Fix: Sync now uses GitHub API instead of raw CDN (fixes caching issue)',
      'Deletions now properly sync to all devices'
    ]
  },
  {
    version: '4.6.37',
    date: '2025-12-18',
    changes: [
      'Sync: Page now reloads after cloud sync to show new data',
      'New games synced from cloud are now immediately visible'
    ]
  },
  {
    version: '4.6.36',
    date: '2025-12-18',
    changes: [
      'CRITICAL FIX: Statistics now works after sync',
      'Player IDs now correctly matched to game data during sync',
      'Default players no longer conflict with synced data'
    ]
  },
  {
    version: '4.6.35',
    date: '2025-12-18',
    changes: [
      'Player Stats: Arrow (❯) now grey to match Records view'
    ]
  },
  {
    version: '4.6.34',
    date: '2025-12-18',
    changes: [
      'Fix: Synced players now have correct type (permanent/guest)',
      'Statistics now shows synced players correctly'
    ]
  },
  {
    version: '4.6.33',
    date: '2025-12-18',
    changes: [
      'Player Stats: Aligned with Records design - icons + labels above values',
      'Added icons: 💰 Biggest Win, 💸 Biggest Loss, 🏆 Win Streak, 💔 Loss Streak',
      'Changed to 2-column grid layout matching Records view',
      'Values now show "X wins ❯" / "X losses ❯" format'
    ]
  },
  {
    version: '4.6.32',
    date: '2025-12-18',
    changes: [
      'Cloud Sync: Full replacement with version tracking',
      'Sync only happens when cloud data is newer (no redundant syncs)',
      'Game deletion auto-syncs to cloud (admin only)',
      'Players NOT synced - auto-created from game data if missing'
    ]
  },
  {
    version: '4.6.30',
    date: '2025-12-18',
    changes: [
      'Aligned stat-card boxes with Records design (same background, border-radius, padding)',
      'Smaller stat value font size to match Records style'
    ]
  },
  {
    version: '4.6.29',
    date: '2025-12-18',
    changes: [
      'Player Stats: Added timeframe header matching Records view',
      'Aligned player streak badges with Records design style'
    ]
  },
  {
    version: '4.6.28',
    date: '2025-12-18',
    changes: [
      'Current Streaks: Changed "3W" to "3 Wins" and "4L" to "4 Losses" for clarity'
    ]
  },
  {
    version: '4.6.27',
    date: '2025-12-18',
    changes: [
      'Cloud Sync: Delta mode - only adds new games (safe)',
      'Players NOT synced - auto-created from game data if missing',
      'Admin: Force Full Sync button to propagate deletions'
    ]
  },
  {
    version: '4.6.26',
    date: '2025-12-18',
    changes: [
      'Records title now shows filtered timeframe (e.g., "Records (H1 2025)")'
    ]
  },
  {
    version: '4.6.25',
    date: '2025-12-18',
    changes: [
      'Records header: Changed to English only "🏆 Records"',
      'Current Streaks: Compact display "3W" / "4L" instead of long text',
      'Fixed text wrapping in streak cards'
    ]
  },
  {
    version: '4.6.24',
    date: '2025-12-18',
    changes: [
      'Records: Added gray arrow indicator for clickable items',
      'Aligned records and player stats - both now show gray ❯ arrow'
    ]
  },
  {
    version: '4.6.23',
    date: '2025-12-18',
    changes: [
      'Records: Cleaner layout - click row for details, removed green buttons',
      'Player stats: Shorter labels (Best, Worst, W Streak, L Streak)',
      'All labels now prevent text wrapping for better display'
    ]
  },
  {
    version: '4.6.22',
    date: '2025-12-18',
    changes: [
      'Cloud Sync: Full data replacement - admin is master of all data',
      'Deleted games now sync to all users (removes from their devices)',
      'App reloads after sync to show updated data immediately'
    ]
  },
  {
    version: '4.6.21',
    date: '2025-12-18',
    changes: [
      'Records: Fixed layout - details arrow no longer wraps to new line',
      'Compact record display fits screen properly'
    ]
  },
  {
    version: '4.6.20',
    date: '2025-12-18',
    changes: [
      'NEW: GitHub Cloud Sync - games auto-sync to cloud when completed',
      'Admin can upload data to GitHub, other users auto-download on app open',
      'Viewer role excluded from sync (stays isolated)',
      'Sync settings in Backup tab (admin only)'
    ]
  },
  {
    version: '4.6.19',
    date: '2025-12-18',
    changes: [
      'All numbers now display as whole numbers (no decimals)',
      'Cleaner display throughout the app'
    ]
  },
  {
    version: '4.6.18',
    date: '2025-12-18',
    changes: [
      'Numbers with 4+ digits now show thousand separators (e.g., 1,234)',
      'Applied across all screens: Statistics, History, Game Summary, etc.'
    ]
  },
  {
    version: '4.6.17',
    date: '2025-12-18',
    changes: [
      'Player records W/L bar: Latest game now on the right',
      'Player records W/L bar: Date now includes year',
      'Player records W/L bar: Date font slightly larger'
    ]
  },
  {
    version: '4.6.16',
    date: '2025-12-18',
    changes: [
      'Statistics table: Share button NOT included in screenshot (clean table only)'
    ]
  },
  {
    version: '4.6.15',
    date: '2025-12-18',
    changes: [
      'Statistics table: Share button now visible in screenshot'
    ]
  },
  {
    version: '4.6.14',
    date: '2025-12-18',
    changes: [
      'Statistics table: Share button smaller and centered'
    ]
  },
  {
    version: '4.6.13',
    date: '2025-12-18',
    changes: [
      'Fixed: Player games list now respects time period filter',
      'Clicking player name shows only games from selected period'
    ]
  },
  {
    version: '4.6.12',
    date: '2025-12-18',
    changes: [
      'Statistics table: Added share button to send screenshot to WhatsApp',
      'Screenshot includes period info header for context'
    ]
  },
  {
    version: '4.6.11',
    date: '2025-12-18',
    changes: [
      'Fixed: Statistics page crash (missing useRef import)'
    ]
  },
  {
    version: '4.6.10',
    date: '2025-12-18',
    changes: [
      'Import button now shows file preparation date',
      'Dynamic display of games count from import file'
    ]
  },
  {
    version: '4.6.9',
    date: '2025-12-18',
    changes: [
      'Fixed: Time period preserved when navigating from records to game details',
      'Fixed: Record details modal no longer re-opens when changing filters',
      'Navigation now preserves all filter settings (period, year)'
    ]
  },
  {
    version: '4.6.8',
    date: '2025-12-18',
    changes: [
      'Import historical data now shows when the file was prepared',
      'Updated import data with latest games'
    ]
  },
  {
    version: '4.6.7',
    date: '2025-12-18',
    changes: [
      'Statistics table: Better spacing between columns',
      'More balanced distribution of space across the table'
    ]
  },
  {
    version: '4.6.6',
    date: '2025-12-18',
    changes: [
      'Statistics table: Compact layout - no more line wrapping',
      'Shorter column headers (G for Games, W% for Win%)',
      'All cells use nowrap for clean display'
    ]
  },
  {
    version: '4.6.5',
    date: '2025-12-18',
    changes: [
      'Records: Changed Hebrew labels back to English',
      'Leaders section: "Top Earner" and "Biggest Loser" (not all-time)'
    ]
  },
  {
    version: '4.6.4',
    date: '2025-12-18',
    changes: [
      'Statistics table: Added Average (Avg) column',
      'Statistics table: Removed decimal points - whole numbers only',
      'Statistics table: Medals (🥇🥈🥉) now appear after player name'
    ]
  },
  {
    version: '4.6.3',
    date: '2025-12-18',
    changes: [
      'Fixed: Renamed "All-Time Leaders" to "מובילים" (reflects selected period)',
      'Records now correctly show data for the selected time period'
    ]
  },
  {
    version: '4.6.1',
    date: '2025-12-17',
    changes: [
      'Simplified active players formula: 33% of total games in period',
      'Shows "מינימום X הופעות מתוך Y משחקים" (minimum appearances)'
    ]
  },
  {
    version: '4.6.0',
    date: '2024-12-17',
    changes: [
      'Forecast: Gender support only for מור (female)',
      'All other players use male Hebrew forms'
    ]
  },
  {
    version: '4.5.9',
    date: '2025-12-17',
    changes: [
      'Clarified filter explanation: "מעל 33%" (above 33%)'
    ]
  },
  {
    version: '4.5.8',
    date: '2025-12-17',
    changes: [
      'Changed active filter label to "שחקנים פעילים בלבד"',
      'Added explanation: "33% מממוצע המשחקים בתקופה"'
    ]
  },
  {
    version: '4.5.7',
    date: '2025-12-17',
    changes: [
      'Fixed: Filter buttons (H1/H2/Year/etc) no longer trigger game popups',
      'Added type=button and preventDefault to ALL filter buttons',
      'Comprehensive fix for all filter interactions in Statistics page'
    ]
  },
  {
    version: '4.5.6',
    date: '2025-12-17',
    changes: [
      'Fixed: Stat box data now respects the selected time period filter',
      'Fixed: Game details page scrolls to top when opened',
      'Fixed: Back navigation returns to correct view (individual/records/table)',
      'Fixed: Navigation from individual view stays in individual view'
    ]
  },
  {
    version: '4.5.5',
    date: '2024-12-17',
    changes: [
      'Forecast: Gender-aware sentences in Hebrew!',
      'Correct male/female forms (הוא/היא, שלו/שלה, etc.)',
      'Automatic detection of female names (מור, נועה, etc.)',
      'All forecast sentences updated with proper grammar'
    ]
  },
  {
    version: '4.5.4',
    date: '2025-12-17',
    changes: [
      'Individual player view: All stat boxes now clickable (Games, Wins, Losses, Best Win, etc.)',
      'W/L tiles now navigate directly to game details (simpler flow)',
      'Stat box clicks open records-style modal with game list',
      'Clickable stats show ❯ indicator',
      'Aligned UX with records view pattern'
    ]
  },
  {
    version: '4.5.3',
    date: '2024-12-17',
    changes: [
      'Forecast: Sarcastic/cynical sentences for long absences!',
      'Different levels: 3+ months, 6+ months, year+ absence',
      'Highlights also sarcastic for inactive players',
      'More humor and personality in returning player messages'
    ]
  },
  {
    version: '4.5.2',
    date: '2025-12-17',
    changes: [
      'Fixed: Filter buttons (H1/H2/Year) no longer trigger unwanted popups',
      'Table view: Click on any player row to see their game history',
      'Player game history modal shows all games with navigation to full details'
    ]
  },
  {
    version: '4.5.1',
    date: '2025-12-17',
    changes: [
      'Renamed Settings tab from "Backup" to "Backup & Restore"'
    ]
  },
  {
    version: '4.5.0',
    date: '2025-12-17',
    changes: [
      'Individual player stats: Last 6 games only (not 10)',
      'Clickable game tiles in player stats - shows game details modal',
      'Navigate from game modal to full game details with back navigation',
      'Scroll to player card when returning from game details'
    ]
  },
  {
    version: '4.4.0',
    date: '2024-12-17',
    changes: [
      'Forecast: Smart time awareness - checks actual game dates',
      'No more "לאחרונה" for players who havent played in months',
      'Much longer, more engaging forecast sentences',
      'Special handling for returning players after long breaks',
      'Highlights adapted to player activity level'
    ]
  },
  {
    version: '4.3.6',
    date: '2025-12-17',
    changes: [
      'Back button returns to exact record details modal (not just Records page)',
      'Record info is preserved when navigating from game details back to records'
    ]
  },
  {
    version: '4.3.5',
    date: '2024-12-17',
    changes: [
      'Navigation: Back to Records now returns to Records view (not Table)',
      'Preserves the view mode when navigating back from game details'
    ]
  },
  {
    version: '4.3.4',
    date: '2024-12-17',
    changes: [
      'Records: Each tied player now has their own "פרטים ❯" button',
      'Click to see game details for any player sharing a record',
      'Better layout for expanded tied players list'
    ]
  },
  {
    version: '4.3.3',
    date: '2024-12-17',
    changes: [
      'Navigation: "Back to Records" when coming from record drill-down',
      'Bottom button changes to "📊 Records" accordingly',
      'Seamless flow: Records → Game Details → Back to Records'
    ]
  },
  {
    version: '4.3.2',
    date: '2024-12-17',
    changes: [
      'Forecast: Now fully dynamic - different results each time!',
      'Highlights: Random selection from top relevant insights',
      'Sentences: Doubled the variety (10+ options per category)',
      'Expected values: Added significant variance for uniqueness'
    ]
  },
  {
    version: '4.3.1',
    date: '2024-12-17',
    changes: [
      'Records: Fixed date format (DD/MM/YYYY)',
      'Records: Click any game row to see full game details',
      'Hover effect and arrow indicator for clickable games'
    ]
  },
  {
    version: '4.3.0',
    date: '2024-12-17',
    changes: [
      'Forecast: Dynamic personalized highlights for each player',
      'Each player gets unique insight based on their actual data',
      'Detects: streaks, improvement/decline, comebacks, volatility',
      'Compares recent (last 10 games) vs historical performance'
    ]
  },
  {
    version: '4.2.3',
    date: '2024-12-17',
    changes: [
      'Fixed: Records drill-down now shows actual game data',
      'UI: Changed icon to clearer "פרטים ❯" button',
      'Added getAllGamePlayers function for record details'
    ]
  },
  {
    version: '4.2.2',
    date: '2024-12-17',
    changes: [
      'Forecast: Highlights line shows stats from last games (wins, streak, average)',
      'Forecast: Creative fun sentences separate from data',
      'Forecast: Cleaner layout - highlights first, then prediction',
      'Removed formula mention from footer'
    ]
  },
  {
    version: '4.2.1',
    date: '2024-12-17',
    changes: [
      'Records: Click 🔍 to see game details behind any record',
      'Modal shows all relevant games with dates and profits',
      'Works for streaks, wins, losses, biggest games, etc.'
    ]
  },
  {
    version: '4.2.0',
    date: '2024-12-17',
    changes: [
      'Improved: Forecast now weighs recent performance (60%) over overall history (40%)',
      'Improved: Sentences reference actual data (X/Y wins, streak info, averages)',
      'Added: Streak badges show hot/cold streaks (🔥/❄️)',
      'Added: Trend detection - improving vs declining players',
      'Fixed: Smarter surprise predictions based on contradicting trends'
    ]
  },
  {
    version: '4.1.3',
    date: '2024-12-17',
    changes: [
      'Fixed: Forecast button now works correctly',
      'Added missing imports for screenshot sharing'
    ]
  },
  {
    version: '4.1.2',
    date: '2024-12-17',
    changes: [
      'Fixed: אורח filter button now highlights green like others'
    ]
  },
  {
    version: '4.1.1',
    date: '2024-12-17',
    changes: [
      'Forecast: Completely rewritten engaging sentences',
      'Personal, witty predictions with real player stats',
      'Fun commentary players will enjoy sharing',
      'Smart surprise system (up to 30%, not forced)',
      'Screenshot-based WhatsApp sharing',
      'Cleaner UI with RTL support'
    ]
  },
  {
    version: '4.1.0',
    date: '2024-12-17',
    changes: [
      'Role-Based Permissions: Admin, Member, Viewer',
      'Admin (2351): Full control over everything',
      'Member (2580): Can manage games and add players',
      'Viewer (9876): View-only access + backup features',
      'Settings shows current role with emoji indicator',
      'UI adapts based on permissions (hide/disable buttons)',
      'All roles can use Backup & Data features'
    ]
  },
  {
    version: '4.0.0',
    date: '2024-12-17',
    changes: [
      'Forecast 3.0: Complete professional overhaul',
      'Smart surprise system - UP TO 35% (not forced)',
      'Unique sentences per player - no duplicates',
      'Cleaner sentence structure - less repetitive',
      'Screenshot-based WhatsApp sharing',
      'Clear visual legend (green=win, red=loss, purple=surprise)',
      'Better UI with RTL support',
      'Cached forecasts - consistent display'
    ]
  },
  {
    version: '3.9.9',
    date: '2024-12-17',
    changes: [
      'Records: Name and value now side by side',
      'Ties show value once (same for all)',
      'Expanded ties just show additional names'
    ]
  },
  {
    version: '3.9.8',
    date: '2024-12-17',
    changes: [
      'Records: Shows ties with expandable list',
      'Click "+N" badge to see all tied players',
      'Works for all record categories'
    ]
  },
  {
    version: '3.9.7',
    date: '2024-12-17',
    changes: [
      'History: Consistent buyins display for all games'
    ]
  },
  {
    version: '3.9.6',
    date: '2024-12-17',
    changes: [
      'History: Show ALL players sorted by profit (highest first)',
      'History: Added "פרטים מלאים" button for game details',
      'History: Shows total buyins instead of pot for new games',
      'Smaller badges to fit all players in view'
    ]
  },
  {
    version: '3.9.5',
    date: '2024-12-17',
    changes: [
      'Active Players toggle moved to top of filters',
      'Active Players filter ON by default',
      'Better filter organization in Statistics'
    ]
  },
  {
    version: '3.9.4',
    date: '2024-12-17',
    changes: [
      'Statistics defaults to current half year (H1 Jan-Jun, H2 Jul-Dec)',
      'Automatically selects the relevant half based on current date'
    ]
  },
  {
    version: '3.9.3',
    date: '2024-12-17',
    changes: [
      'UI: Active Players filter now uses iOS-style toggle switch',
      'UI: Year selector made more compact and elegant',
      'Cleaner filter section appearance'
    ]
  },
  {
    version: '3.9.2',
    date: '2024-12-17',
    changes: [
      'Bugfix: Fixed JSX syntax error causing Vercel build failure',
      'Statistics time period filter now correctly wrapped'
    ]
  },
  {
    version: '3.8.0',
    date: '2024-12-17',
    changes: [
      'New Game: Added optional location selector',
      'Quick options: ליאור, סגל, ליכטר, אייל',
      'Custom location via free text input',
      'Location stored for future analysis'
    ]
  },
  {
    version: '3.7.2',
    date: '2024-12-17',
    changes: [
      'Removed hardcoded Dec 6 game auto-import',
      'Buyin King only shows with real buyin data'
    ]
  },
  {
    version: '3.7.1',
    date: '2024-12-17',
    changes: [
      'New Game: More compact layout - less scrolling',
      'Smaller tiles, reduced spacing, compact header',
      'All 11 permanent players visible without scroll'
    ]
  },
  {
    version: '3.7.0',
    date: '2024-12-17',
    changes: [
      'Terminology: Changed "Rebuy" to "Buyin" across the app',
      'Buyin = total purchases (initial + additional)',
      'Updated: Settings, Live Game, Summary, Statistics, Sharing'
    ]
  },
  {
    version: '3.6.4',
    date: '2024-12-17',
    changes: [
      'Guest badge now uses grey background (same as Occasional)',
      'Only Permanent uses green highlight'
    ]
  },
  {
    version: '3.6.3',
    date: '2024-12-17',
    changes: [
      'Changed labels: אורח (singular), מזדמן (singular)',
      'New icon for Guest: 🏠 (was 👥)',
      'Occasional keeps: 👤'
    ]
  },
  {
    version: '3.6.2',
    date: '2024-12-17',
    changes: [
      'Settings: Players sorted by type (Permanent → Guests → Occasional)',
      'Alphabetical within each type',
      'Auto-sorts when adding/editing players'
    ]
  },
  {
    version: '3.6.1',
    date: '2024-12-17',
    changes: [
      'Import reads player types from Excel (קבוע/אורח/מזדמן column)',
      '11 Permanent, 5 Guests, 24 Occasional players'
    ]
  },
  {
    version: '3.6.0',
    date: '2024-12-17',
    changes: [
      'Import now REPLACES all data (full reset)',
      'Includes all 217 games from Excel',
      'Warning dialog before import'
    ]
  },
  {
    version: '3.5.0',
    date: '2024-12-16',
    changes: [
      'Renamed player types: קבוע, אורח, מזדמן',
      'New icons: ⭐ Permanent, 🏠 Guest, 👤 Occasional',
      'Hebrew descriptions for player type selection'
    ]
  },
  {
    version: '3.4.3',
    date: '2024-12-16',
    changes: [
      'UI: Unified selection colors across all screens',
      'All selected/active buttons now use consistent green'
    ]
  },
  {
    version: '3.4.2',
    date: '2024-12-16',
    changes: [
      'BUGFIX: Fixed Select/Deselect All in New Game screen',
      'BUGFIX: Fixed Clear button in Statistics screen',
      'Select All now works with visible players only'
    ]
  },
  {
    version: '3.4.1',
    date: '2024-12-16',
    changes: [
      'BUGFIX: Fixed screen freeze when switching tabs',
      'Performance: Added memoization to Statistics screen'
    ]
  },
  {
    version: '3.4.0',
    date: '2024-12-16',
    changes: [
      'Statistics: Player type filter now supports multi-select',
      'Select any combination of Permanent, Permanent Guest, Guest'
    ]
  },
  {
    version: '3.3.0',
    date: '2024-12-16',
    changes: [
      'Statistics: Added minimum games filter',
      'Filter players by games played (All, 5+, 10+, 20+, 50+)'
    ]
  },
  {
    version: '3.2.0',
    date: '2024-12-16',
    changes: [
      'Statistics: Added time period filter (All, Year, H1, H2)',
      'Filter by any year from 2021 to present',
      'H1 = Jan-Jun, H2 = Jul-Dec'
    ]
  },
  {
    version: '3.1.0',
    date: '2024-12-16',
    changes: [
      'Excel Import: Added one-click import for ~213 historical games',
      'Import creates backup before applying',
      'Intelligent merge - avoids duplicate games/players'
    ]
  },
  {
    version: '3.0.0',
    date: '2024-12-16',
    changes: [
      'Player Types: Added 3 categories - Permanent, Permanent Guest, Guest',
      'New Game: 3 collapsible sections for player types',
      'Statistics: Filter by player type',
      'Settings: Edit player type with 3 options',
      'Preparing for Excel history import'
    ]
  },
  {
    version: '2.10.0',
    date: '2024-12-16',
    changes: [
      'Backup: Simplified UI - Download button saves backup file to Downloads'
    ]
  },
  {
    version: '2.9.9',
    date: '2024-12-16',
    changes: [
      'Backup: "Open WhatsApp" button now opens WhatsApp directly after download'
    ]
  },
  {
    version: '2.9.8',
    date: '2024-12-16',
    changes: [
      'Backup: Added step-by-step instructions for sharing backup to WhatsApp'
    ]
  },
  {
    version: '2.9.7',
    date: '2024-12-16',
    changes: [
      'Backup: Improved share - downloads file first if direct file sharing not supported'
    ]
  },
  {
    version: '2.9.6',
    date: '2024-12-16',
    changes: [
      'Backup: Share now sends actual JSON file (not text) for easy restore'
    ]
  },
  {
    version: '2.9.5',
    date: '2024-12-16',
    changes: [
      'Backup: Added "Share to WhatsApp" option for cloud backup via WhatsApp'
    ]
  },
  {
    version: '2.9.4',
    date: '2024-12-16',
    changes: [
      'Statistics: Game tiles now show date below each game (DD/MM format)'
    ]
  },
  {
    version: '2.9.3',
    date: '2024-12-16',
    changes: [
      'Statistics: Changed indicator to "אחרון" label for clarity'
    ]
  },
  {
    version: '2.9.2',
    date: '2024-12-16',
    changes: [
      'Statistics: Added ▲ indicator under the most recent game'
    ]
  },
  {
    version: '2.9.1',
    date: '2024-12-16',
    changes: [
      'Statistics: Last games display now shows 6 games instead of 5',
      'Statistics: Most recent game now appears first (left side)'
    ]
  },
  {
    version: '2.9.0',
    date: '2024-12-16',
    changes: [
      'Forecast 2.0: Complete overhaul of prediction system',
      '40% surprise rate - predictions that go against history',
      '100+ unique Hebrew sentences across all categories',
      'No duplicate sentences in same forecast',
      'Surprise predictions highlighted with 🎲 and purple color',
      'All sentences reference historical data when available'
    ]
  },
  {
    version: '2.8.4',
    date: '2024-12-15',
    changes: [
      'Forecast now balanced: total wins = total losses (zero-sum)',
      'Sentences match the balanced expected values'
    ]
  },
  {
    version: '2.8.3',
    date: '2024-12-15',
    changes: [
      'Auto backup changed from Sunday to Friday'
    ]
  },
  {
    version: '2.8.2',
    date: '2024-12-15',
    changes: [
      'Chip delete icon now matches player delete icon style'
    ]
  },
  {
    version: '2.8.1',
    date: '2024-12-15',
    changes: [
      'Auto backup after each game ends',
      'Backups now show type: Auto (Game End), Auto (Sunday), Manual',
      'Backup list shows trigger information'
    ]
  },
  {
    version: '2.8.0',
    date: '2024-12-15',
    changes: [
      'Delete confirmation dialogs for players and chips',
      'All deletions now require confirmation before proceeding'
    ]
  },
  {
    version: '2.7.9',
    date: '2024-12-15',
    changes: [
      'Forecast: Sentences now match expected profit direction',
      'Forecast: Much longer and more detailed sentences',
      'Forecast: 100+ unique sentences with player name and stats',
      'Forecast: Surprises now also adjust the expected profit'
    ]
  },
  {
    version: '2.7.8',
    date: '2024-12-15',
    changes: [
      'Settings: Unified player edit - name & type in one modal',
      'Settings: Cleaner player buttons (Edit + Delete only)',
      'Settings: Backup section redesigned with grouped actions'
    ]
  },
  {
    version: '2.7.7',
    date: '2024-12-15',
    changes: [
      'Settings: Players tab is now first',
      'Settings: Tabs styled like Statistics page (max 4 per row)',
      'Settings: Tab layout matches Statistics page format'
    ]
  },
  {
    version: '2.7.6',
    date: '2024-12-15',
    changes: [
      'Settings: Can now edit player names with ✏️ button',
      'All historical data and statistics migrate to new name'
    ]
  },
  {
    version: '2.7.5',
    date: '2024-12-15',
    changes: [
      'Forecast: Much more variety in sentences (100+ options)',
      'Forecast: 15% chance for surprise predictions against the data',
      'Forecast: More categories based on stats depth'
    ]
  },
  {
    version: '2.7.4',
    date: '2024-12-15',
    changes: [
      'Settings tabs now wrap to new line instead of scrolling'
    ]
  },
  {
    version: '2.7.3',
    date: '2024-12-15',
    changes: [
      'Settings: Player list now shows type (קבוע/אורח)',
      'Settings: Can choose player type when adding new player',
      'Settings: Can toggle player type for existing players'
    ]
  },
  {
    version: '2.7.2',
    date: '2024-12-15',
    changes: [
      'Forecast sentences now in Hebrew'
    ]
  },
  {
    version: '2.7.1',
    date: '2024-12-15',
    changes: [
      'Settings page now has tabs: Game, Chips, Players, Backup, About',
      'Cleaner navigation between settings sections'
    ]
  },
  {
    version: '2.7.0',
    date: '2024-12-15',
    changes: [
      'Added Forecast feature on New Game screen',
      'Predicts player profit/loss based on history',
      'Generates funny/cynical sentences for each player',
      'Share forecast to WhatsApp'
    ]
  },
  {
    version: '2.6.0',
    date: '2024-12-15',
    changes: [
      'Added Backup & Restore feature in Settings',
      'Auto-backup every Sunday on app open',
      'Manual backup, download, and import options',
      'Keeps last 4 backups (1 month)'
    ]
  },
  {
    version: '2.5.6',
    date: '2024-12-15',
    changes: [
      'Simplified Game Details - removed stat tiles, added Total Rebuys to Results header'
    ]
  },
  {
    version: '2.5.5',
    date: '2024-12-15',
    changes: [
      'Added Total Rebuys display at top of Results table in Game Summary'
    ]
  },
  {
    version: '2.5.4',
    date: '2024-12-15',
    changes: [
      'Fixed Game Details table to fit screen - no horizontal scroll'
    ]
  },
  {
    version: '2.5.3',
    date: '2024-12-15',
    changes: [
      'Fixed Game Details table - restored Chips column with proper calculation'
    ]
  },
  {
    version: '2.5.2',
    date: '2024-12-15',
    changes: [
      'Simplified Game Details table - removed Chips column, fixed value formatting'
    ]
  },
  {
    version: '2.5.1',
    date: '2024-12-15',
    changes: [
      'Fixed table alignment - profit column no longer wraps to new line'
    ]
  },
  {
    version: '2.5.0',
    date: '2024-12-15',
    changes: [
      'Simplified chip display - always uses stored finalValue for reliability'
    ]
  },
  {
    version: '2.4.9',
    date: '2024-12-15',
    changes: [
      'Fixed chip display for games without detailed chip counts'
    ]
  },
  {
    version: '2.4.8',
    date: '2024-12-15',
    changes: [
      'Game Details now uses screenshot sharing like Game Summary'
    ]
  },
  {
    version: '2.4.7',
    date: '2024-12-15',
    changes: [
      'Fixed table width in Game Details to fit container'
    ]
  },
  {
    version: '2.4.6',
    date: '2024-12-15',
    changes: [
      'Fixed Chips column in Game Details - shows chips not shekels'
    ]
  },
  {
    version: '2.4.5',
    date: '2024-12-15',
    changes: [
      'Added historical game import (Dec 6, 2024)',
      'Historical data automatically imported on first load'
    ]
  },
  {
    version: '2.4.4',
    date: '2024-12-14',
    changes: [
      'Sort tabs (Profit/Games/Win Rate) now equally spread'
    ]
  },
  {
    version: '2.4.3',
    date: '2024-12-14',
    changes: [
      'Fixed bug: small transfers no longer displayed twice',
      'Settlements and Small Amounts are now separate lists'
    ]
  },
  {
    version: '2.4.2',
    date: '2024-12-14',
    changes: [
      'Fixed sort buttons layout - icon above text for all tabs'
    ]
  },
  {
    version: '2.4.1',
    date: '2024-12-14',
    changes: [
      'Added stats-only PIN (9876) for view-only access',
      'Stats-only users can only see Statistics page',
      'Full access PIN (2580) unchanged'
    ]
  },
  {
    version: '2.4.0',
    date: '2024-12-14',
    changes: [
      'Added permanent vs guest player types',
      'Settings: new players are permanent by default',
      'New Game: new players are guests by default with toggle',
      'New Game: guests shown in collapsible section',
      'Statistics: toggle to include/exclude guests',
      'Existing players migrated to permanent'
    ]
  },
  {
    version: '2.3.9',
    date: '2024-12-14',
    changes: [
      'Added multi-select player filter to Statistics page',
      'Filter works across Table, Records, and Players views',
      'Select/deselect players to compare stats'
    ]
  },
  {
    version: '2.3.8',
    date: '2024-12-14',
    changes: [
      'Changed Total Rebuys text to white in statistics'
    ]
  },
  {
    version: '2.3.7',
    date: '2024-12-14',
    changes: [
      'Enriched player statistics with more data',
      'Added wins/losses count, avg win/loss, best/worst streak',
      'Added Average Performance records section',
      'Added Most Wins, Most Losses, Worst Win Rate records',
      'Fixed streak calculations in storage'
    ]
  },
  {
    version: '2.3.6',
    date: '2024-12-14',
    changes: [
      'Restored nice progress bar format',
      'Colored border at top, stats row, proper spacing'
    ]
  },
  {
    version: '2.3.5',
    date: '2024-12-14',
    changes: [
      'Fixed Statistics: loss colors now red (not blue)',
      'Removed confusing Best/Worst streak from player cards',
      'Fixed -0 display - shows dash if no value',
      'Streak records only show if > 1 game',
      'Changed Ice Cold to Cold Streak with red color'
    ]
  },
  {
    version: '2.3.4',
    date: '2024-12-14',
    changes: [
      'Fixed chip entry page - reduced empty space',
      'More compact bottom bar with progress overlay'
    ]
  },
  {
    version: '2.3.3',
    date: '2024-12-14',
    changes: [
      'Removed Reset Statistics button',
      'Fixed table: medal and number on same line'
    ]
  },
  {
    version: '2.3.2',
    date: '2024-12-14',
    changes: [
      'Restored Records view in Statistics',
      'Current streaks (On Fire / Ice Cold)',
      'All-time leaders and single game records',
      'Streak records and other achievements',
      'Individual view with last 5 games trend'
    ]
  },
  {
    version: '2.3.1',
    date: '2024-12-14',
    changes: [
      'Restored player selector on chip count page',
      'Select one player at a time to count chips',
      'Done button marks player complete and auto-advances',
      'Tap completed player to edit their count'
    ]
  },
  {
    version: '2.3.0',
    date: '2024-12-14',
    changes: [
      'MAJOR FIX: Restored Vercel rewrites for page refresh',
      'Added loading states to all game screens',
      'Added catch-all route for unknown URLs',
      'Fixed chip grid to always show 2 columns',
      'App initialization loading screen'
    ]
  },
  {
    version: '2.2.9',
    date: '2024-12-14',
    changes: [
      'Restored version display on PIN login screen'
    ]
  },
  {
    version: '2.2.8',
    date: '2024-12-14',
    changes: [
      'Statistics: Simplified to Table and Individual views',
      'Removed Records view',
      'Table is default, no horizontal scroll',
      'Restored Reset Statistics button'
    ]
  },
  {
    version: '2.2.7',
    date: '2024-12-14',
    changes: [
      'Statistics: Table is now default view and first tab',
      'Tabs appear on same line',
      'Table fits in one view'
    ]
  },
  {
    version: '2.2.6',
    date: '2024-12-14',
    changes: [
      'Fixed progress bar - now 28px with visible background',
      'Bottom bar fixed to bottom - no scrolling past it'
    ]
  },
  {
    version: '2.2.5',
    date: '2024-12-14',
    changes: [
      'Removed Reset All Statistics button'
    ]
  },
  {
    version: '2.2.4',
    date: '2024-12-14',
    changes: [
      'Progress bar 36px with chip count overlay'
    ]
  },
  {
    version: '2.2.3',
    date: '2024-12-14',
    changes: [
      'Bottom bar flows with content - no empty space'
    ]
  },
  {
    version: '2.2.2',
    date: '2024-12-14',
    changes: [
      'Added version to PIN login screen'
    ]
  },
  {
    version: '1.9.4',
    date: '2024-12-14',
    changes: [
      'Changed summary table headers to text: Chips, Rebuy'
    ]
  },
  {
    version: '1.9.3',
    date: '2024-12-14',
    changes: [
      'Updated chips and rebuy icons in summary table'
    ]
  },
  {
    version: '1.9.2',
    date: '2024-12-14',
    changes: [
      'Centered Home and Share buttons on summary screen'
    ]
  },
  {
    version: '1.9.1',
    date: '2024-12-14',
    changes: [
      'Updated PIN code'
    ]
  },
  {
    version: '1.9.0',
    date: '2024-12-14',
    changes: [
      'Added PIN lock screen for app access',
      'Session persists until browser is closed'
    ]
  },
  {
    version: '1.8.0',
    date: '2024-12-14',
    changes: [
      'Neutral +/- buttons - no red/green colors',
      'Cleaner top counter design',
      'Simplified Expected vs Counted display'
    ]
  },
  {
    version: '1.7.8',
    date: '2024-12-14',
    changes: [
      'Changelog shows only latest version by default',
      'Click to expand and see full version history'
    ]
  },
  {
    version: '1.7.7',
    date: '2024-12-14',
    changes: [
      'Player tiles now spread evenly using grid layout',
      'Tiles fill the available width edge to edge'
    ]
  },
  {
    version: '1.7.6',
    date: '2024-12-14',
    changes: [
      'Larger player tiles with bigger names',
      'More spacing between tiles'
    ]
  },
  {
    version: '1.7.5',
    date: '2024-12-14',
    changes: [
      'Increased spacing between player selection tiles'
    ]
  },
  {
    version: '1.7.4',
    date: '2024-12-14',
    changes: [
      'Progress stays red/orange longer - only green near 100%',
      'Summary card visible and styled from start',
      'Consistent color scheme using progress color'
    ]
  },
  {
    version: '1.7.3',
    date: '2024-12-14',
    changes: [
      'Players with 0 chips can now be marked as Done',
      'Removed long-press rapid increment feature',
      'Simplified +/- button behavior'
    ]
  },
  {
    version: '1.7.2',
    date: '2024-12-14',
    changes: [
      'Progress bar now uses gradient colors',
      'Red (0%) → Orange → Yellow → Green (100%)',
      'Smooth color transition as you count'
    ]
  },
  {
    version: '1.7.1',
    date: '2024-12-14',
    changes: [
      'Progress bar now at absolute bottom of screen'
    ]
  },
  {
    version: '1.7.0',
    date: '2024-12-14',
    changes: [
      'Progress bar moved to fixed bottom position',
      'Always visible while counting chips',
      'Shows players done, chips remaining, and Calculate button'
    ]
  },
  {
    version: '1.6.3',
    date: '2024-12-14',
    changes: [
      'Compact player selection with pill-style buttons',
      'Reduced page header and spacing for less scrolling',
      'Start Game button now visible without scrolling'
    ]
  },
  {
    version: '1.6.2',
    date: '2024-12-14',
    changes: [
      'Added visible Done button to collapse player after counting',
      'Button turns green when player has chips counted'
    ]
  },
  {
    version: '1.6.1',
    date: '2024-12-14',
    changes: [
      'Fixed chip counting screen blank issue'
    ]
  },
  {
    version: '1.6.0',
    date: '2024-12-14',
    changes: [
      'Added collapsible player cards in chip counting',
      'Added floating progress bar showing count progress',
      'Tap player header to collapse/expand after counting'
    ]
  },
  {
    version: '1.5.1',
    date: '2024-12-14',
    changes: [
      'Removed winner box from summary page'
    ]
  },
  {
    version: '1.5.0',
    date: '2024-12-14',
    changes: [
      'Added long-press rapid increment on +/- buttons',
      'Added numpad modal for quick chip count entry',
      'Tap chip color to open numpad for direct input'
    ]
  },
  {
    version: '1.4.1',
    date: '2024-12-14',
    changes: [
      'Reduced winner box size for better layout'
    ]
  },
  {
    version: '1.4.0',
    date: '2024-12-14',
    changes: [
      'WhatsApp share now sends screenshot of summary',
      'Captures results table and settlements as image',
      'Uses native share on mobile devices'
    ]
  },
  {
    version: '1.3.0',
    date: '2024-12-14',
    changes: [
      'Simplified rebuys column to show only count',
      'Improved table layout for mobile screens',
      'Redesigned WhatsApp export with clean table format'
    ]
  },
  {
    version: '1.2.0',
    date: '2024-12-14',
    changes: [
      'Added total chips column to game summary table',
      'Added total rebuy column to game summary table',
      'Included total chips and rebuys in WhatsApp export message'
    ]
  },
  {
    version: '1.1.0',
    date: '2024-12-14',
    changes: [
      'Added app versioning system',
      'Added changelog tracking in Settings',
      'Version now displayed in Settings screen'
    ]
  },
  {
    version: '1.0.0',
    date: '2024-12-01',
    changes: [
      'Initial release',
      'Poker game management',
      'Player tracking',
      'Chip calculations',
      'Game history and statistics'
    ]
  }
];
