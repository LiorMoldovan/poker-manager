# Poker Manager — Agent Guide

## What Is This Project?

A Hebrew-language web app for managing friendly poker nights among ~8-10 regular players. Tracks games, calculates settlements, generates AI-powered narratives, forecasts, statistics, and training. No backend — LocalStorage is the database, GitHub Pages is cloud sync, Vercel handles deployment.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | React 19 + TypeScript 5 (strict mode) |
| Build | Vite 6 |
| Charts | Recharts |
| Screenshots | html2canvas |
| AI | Google Gemini API (gemini-2.0-flash) |
| Cloud sync | GitHub API → GitHub Pages repo |
| Deployment | Vercel (auto-deploy from `main`) |
| Dev server | `npm run dev` → **http://localhost:3000** (NEVER 3001) |
| Data | LocalStorage (client-side only) |
| Styling | Inline React styles + CSS variables (dark theme) |
| Font | Outfit (Google Fonts) |

## Critical Rules

### 1. Never Commit Without Permission
Do NOT commit, push, or merge unless the user explicitly asks. When they say "merge" / "push" / "push to BB", execute the full pipeline: commit → push → Vercel deploys automatically → bump version in `src/version.ts`.

### 2. Hebrew RTL
All user-facing text in Hebrew. Use `direction: 'rtl'` on containers. Use `gap` not `marginRight` in flex layouts.

### 3. No Backend
Everything is client-side. LocalStorage = database. GitHub Pages repo = cloud sync. No server, no API routes.

### 4. Inline Styles
No CSS modules, no styled-components, no Tailwind. Follow existing inline React style patterns.

### 5. Zero-Sum
Game profits across all players must always sum to exactly zero.

### 6. Holistic AI Prompts
Build prompts as one flowing instruction set. NEVER patch prompts with constraints — it degrades quality. Refactor the entire prompt if something needs changing.

### 7. Version in `src/version.ts`
Not in `package.json`. Always bump as part of merge process.

### 8. Windows PowerShell
Dev environment is Windows. No bash syntax (`&&`, heredocs, `cat`, `grep`). Use Cursor tools or PowerShell.

### 9. No Automated Tests
Validate with `npx tsc --noEmit` and ReadLints. For algorithm changes, use `node -e` scripts against `public/full-backup.json`.

## Architecture

### Game Lifecycle
```
NewGameScreen → LiveGameScreen → ChipEntryScreen → GameSummaryScreen
   (setup)        (play)          (count)           (results + AI)
```

### Auth
PIN-based. 4 roles: admin (2351), member (2580), memberSync (0852), viewer (9876). Stored in sessionStorage.

### AI Pipeline
Admin generates → cached in localStorage → synced to GitHub → non-admin users pull from cloud. All AI functions in `src/utils/geminiAI.ts`.

### Cloud Sync
Admin pushes via personal GitHub token. Non-admin reads via embedded obfuscated token (`embeddedToken.ts`). Sync file: `public/full-backup.json` on `LiorMoldovan/poker-manager`.

### Activity Tracking
Silent tracking of non-admin sessions. Device fingerprint (GPU, cores, RAM, canvas hash) + screens visited + duration. Stored in `public/activity-log.json` on GitHub. Admin views in Settings → Activity tab.

## File Map

| Area | Files |
|------|-------|
| **Entry** | `src/main.tsx`, `src/App.tsx` |
| **Types** | `src/types/index.ts` (ALL interfaces) |
| **Auth** | `src/permissions.ts`, `src/components/PinLock.tsx` |
| **Storage** | `src/database/storage.ts` (LocalStorage CRUD) |
| **Cloud** | `src/database/githubSync.ts`, `src/database/embeddedToken.ts` |
| **AI** | `src/utils/geminiAI.ts` (forecasts, summaries, chronicles, graph insights) |
| **Screens** | `src/screens/*.tsx` (12 screen components) |
| **Nav** | `src/components/Navigation.tsx` (bottom tab bar) |
| **Utils** | `src/utils/calculations.ts` (formatting), `milestones.ts`, `comboHistory.ts`, `activityLogger.ts`, `sharing.ts`, `tts.ts`, `pokerTraining.ts` |
| **Styles** | `src/styles/index.css` (CSS variables, dark theme) |
| **Version** | `src/version.ts` (APP_VERSION + CHANGELOG) |
| **Config** | `vite.config.ts`, `tsconfig.json`, `vercel.json` |

## User Preferences

These are learned from extensive conversation history:

- Prefers **holistic, clean solutions** over patches — "don't create constraint patches"
- Wants AI content to be **creative, dynamic, non-repetitive**
- Values **data-driven accuracy** — AI must never invent stats
- Likes **surprising insights** — mention all players, find interesting correlations
- Dislikes **redundancy** — don't repeat data shown elsewhere
- Expects **one-shot quality** — "I want amazing solution in one try, not ping pong"
- Wants to **review before merge** — never auto-commit
- Refers to GitHub as **"BB"** (push to BB = push to GitHub)
- Game nights are typically **Thursday or Saturday**
- Prefers **concise explanations** — show tables, not walls of text
- When fixing bugs, **fix root cause** not symptoms
- For UI, prefers **compact, readable cards** — not long scrollable lists
