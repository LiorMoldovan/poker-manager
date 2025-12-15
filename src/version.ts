/**
 * App Version Management
 * Increment version with each change for tracking purposes
 */

export const APP_VERSION = '2.4.2';

export interface ChangelogEntry {
  version: string;
  date: string;
  changes: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
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

