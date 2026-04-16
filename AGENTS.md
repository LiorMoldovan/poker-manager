# Poker Manager — Agent Guide

## What Is This Project?

A Hebrew-language web app for managing friendly poker nights among ~8-10 regular players. Tracks games, calculates settlements, generates AI-powered narratives, forecasts, statistics, and training.

**Active migration**: Moving from LocalStorage + GitHub Pages to **Supabase** (PostgreSQL). Controlled by `USE_SUPABASE` flag in `src/database/config.ts`. When `false` (current live): localStorage + GitHub. When `true`: Supabase. The `supabase-migration` branch contains all migration work.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | React 19 + TypeScript 5 (strict mode) |
| Build | Vite 6 |
| Charts | Recharts |
| Screenshots | html2canvas |
| AI | Google Gemini API (gemini-2.0-flash) |
| Cloud sync | GitHub API → GitHub Pages repo (legacy) / **Supabase** (migration) |
| Backend DB | **Supabase** (PostgreSQL + RLS + Auth) — migration in progress |
| Deployment | Vercel (auto-deploy from `main`) |
| Dev server | `npm run dev` → **http://localhost:3000** (NEVER 3001) |
| Data | LocalStorage (legacy) / Supabase PostgreSQL (migration) |
| Styling | Inline React styles + CSS variables (dark theme) |
| Font | Outfit (Google Fonts) |

## Critical Rules

### 1. Never Commit Without Permission
Do NOT commit, push, or merge unless the user explicitly asks. When they say "merge" / "push" / "push to BB", execute the full pipeline: commit → push → Vercel deploys automatically → bump version in `src/version.ts`.

### 2. Hebrew RTL
All user-facing text in Hebrew. Use `direction: 'rtl'` on containers. Use `gap` not `marginRight` in flex layouts.

### 3. Dual Data Layer (Migration In Progress)
**Legacy** (`USE_SUPABASE = false`): LocalStorage = database, GitHub Pages = cloud sync. **New** (`USE_SUPABASE = true`): Supabase PostgreSQL via `supabaseCache.ts` (in-memory cache that syncs to Supabase). Feature flag in `src/database/config.ts` controls which path runs. All `storage.ts` functions have `USE_SUPABASE` branches. Training functions in `githubSync.ts` and activity functions in `activityLogger.ts` also have branches.

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
**Legacy** (`USE_SUPABASE = false`): PIN-based. 4 roles: admin (2351), member (2580), memberSync (0852), viewer (9876). Stored in sessionStorage.
**Supabase** (`USE_SUPABASE = true`): Supabase Auth (email/password). Group-based multi-tenancy with invite codes. Hook: `src/hooks/useSupabaseAuth.ts`. SQL functions: `create_group`, `join_group_by_invite`, `link_member_to_player`.

### AI Pipeline
Admin generates → cached in localStorage → synced to GitHub (legacy) or Supabase (migration) → non-admin users pull from cloud. All AI functions in `src/utils/geminiAI.ts`.
**Legacy** (`USE_SUPABASE = false`): API keys in localStorage, direct client-side calls to Google/ElevenLabs.
**Supabase** (`USE_SUPABASE = true`): API keys in Vercel env vars (`GEMINI_API_KEY`, `ELEVENLABS_API_KEY`). All calls routed through Vercel Edge Functions (`/api/gemini`, `/api/elevenlabs-tts`, etc.) via `src/utils/apiProxy.ts`.

### Cloud Sync
**Legacy**: Admin pushes via personal GitHub token. Non-admin reads via embedded obfuscated token (`embeddedToken.ts`). Sync file: `public/full-backup.json` on `LiorMoldovan/poker-manager`.
**Supabase**: Direct DB reads/writes through `supabaseCache.ts`. RLS policies enforce group isolation. Supabase Realtime subscriptions on 11 tables auto-refresh the cache (500ms debounce). `syncToCloud`/`syncFromCloud` are no-ops. Screens use `useRealtimeRefresh` hook for live updates.

### Activity Tracking
Silent tracking of non-admin sessions. Device fingerprint (GPU, cores, RAM, canvas hash) + screens visited + duration.
**Legacy**: Stored in `public/activity-log.json` on GitHub.
**Supabase**: Stored in `activity_log` table with `group_id` isolation.
Admin views in Settings → Activity tab.

## File Map

| Area | Files |
|------|-------|
| **Entry** | `src/main.tsx`, `src/App.tsx` |
| **Types** | `src/types/index.ts` (ALL interfaces) |
| **Auth** | `src/permissions.ts`, `src/components/PinLock.tsx`, `src/hooks/useSupabaseAuth.ts` |
| **Storage** | `src/database/storage.ts` (dual: localStorage OR supabaseCache) |
| **Supabase** | `src/database/supabaseClient.ts`, `src/database/supabaseCache.ts`, `src/database/config.ts`, `src/database/migrateToSupabase.ts` |
| **Cloud** | `src/database/githubSync.ts` (dual: GitHub OR Supabase for training), `src/database/embeddedToken.ts` |
| **AI** | `src/utils/geminiAI.ts` (forecasts, summaries, chronicles, graph insights) |
| **Screens** | `src/screens/*.tsx` (12 screen components), `src/screens/AuthScreen.tsx`, `src/screens/GroupSetupScreen.tsx` |
| **Nav** | `src/components/Navigation.tsx` (bottom tab bar) |
| **Utils** | `src/utils/calculations.ts` (formatting), `milestones.ts`, `comboHistory.ts`, `activityLogger.ts` (dual: GitHub OR Supabase), `sharing.ts`, `tts.ts`, `pokerTraining.ts` |
| **Styles** | `src/styles/index.css` (CSS variables, dark theme) |
| **Version** | `src/version.ts` (APP_VERSION + CHANGELOG) |
| **API Proxy** | `src/utils/apiProxy.ts` (centralizes USE_SUPABASE branching for all external API calls) |
| **API Routes** | `api/gemini.ts`, `api/gemini-models.ts`, `api/elevenlabs-tts.ts`, `api/elevenlabs-usage.ts` (Vercel Edge Functions) |
| **Schema** | `supabase/schema.sql` (20 tables), `supabase/002-auth-support.sql` (auth functions) |
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
