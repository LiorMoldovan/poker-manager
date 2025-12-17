/**
 * App Version Management
 * Increment version with each change for tracking purposes
 */

export const APP_VERSION = '3.6.4';

export interface ChangelogEntry {
  version: string;
  date: string;
  changes: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
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

