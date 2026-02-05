# Version Management Rule

## IMPORTANT: App Version Location

The app version is managed in `src/version.ts`, NOT in `package.json`.

**DO NOT modify `package.json` version field** - it's only for npm package metadata and is unrelated to the app version.

## When Incrementing Version

1. Update `APP_VERSION` constant in `src/version.ts`:
   ```typescript
   export const APP_VERSION = 'X.Y.Z';
   ```

2. Add a new changelog entry at the TOP of the `CHANGELOG` array:
   ```typescript
   {
     version: 'X.Y.Z',
     date: 'YYYY-MM-DD',
     changes: [
       '✅ Main feature or fix description',
       'Additional change 1',
       'Additional change 2'
     ]
   },
   ```

## Version Format

- Major.Minor.Patch (e.g., 4.41.0)
- Increment patch for bug fixes
- Increment minor for new features
- Increment major for breaking changes

## Current Version

As of this writing: `4.41.0`

Always check `src/version.ts` for the current version before incrementing.
