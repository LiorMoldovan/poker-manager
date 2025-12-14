/**
 * App Version Management
 * Increment version with each change for tracking purposes
 */

export const APP_VERSION = '1.6.1';

export interface ChangelogEntry {
  version: string;
  date: string;
  changes: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
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

