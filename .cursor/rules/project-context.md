# Project Context

## About This Project

This is a **Hebrew-language** poker game manager web app for tracking friendly poker games.

- **Stack**: React 19 + TypeScript + Vite
- **Styling**: CSS variables with dark theme (see `src/index.css`)
- **Data Storage**: LocalStorage (no backend)
- **Language**: Hebrew (RTL) - all user-facing text should be in Hebrew
- **Target**: Mobile-first, but must also work on PC

## Key Files

| Purpose | Location |
|---------|----------|
| App version & changelog | `src/version.ts` |
| Player data storage | `src/storage.ts` |
| AI forecasts (Gemini) | `src/geminiAI.ts` |
| Live game logic | `src/screens/LiveGameScreen.tsx` |
| Statistics & insights | `src/screens/StatisticsScreen.tsx` |
| Graphs & charts | `src/screens/GraphsScreen.tsx` |
| Game summary | `src/screens/GameSummaryScreen.tsx` |
| CSS variables | `src/index.css` |

## Important Patterns

### Hebrew Text
All user-facing strings should be in Hebrew. Example:
```typescript
// CORRECT
const message = 'ברוך הבא למשחק';

// WRONG
const message = 'Welcome to the game';
```

### Dark Theme CSS Variables
Use CSS variables for colors, but note that **native HTML elements (select, option) may not inherit them on PC**. Use explicit hex colors for dropdowns:
```typescript
// For <select> and <option> elements on PC compatibility:
style={{ background: '#1a1a2e', color: '#ffffff' }}
```

### Audio/Speech APIs
- **Speech**: Use `window.speechSynthesis` with Hebrew voice
- **Sound**: Use shared `AudioContext` (don't create new instances per sound - browsers limit to ~6)

### RTL Layout
Many components use `direction: 'rtl'` for proper Hebrew text alignment.
