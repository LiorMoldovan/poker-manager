# Poker Manager — Agent Guide

## What Is This Project?

A Hebrew-language web app for managing friendly poker nights among ~8-10 regular players. Tracks games, calculates settlements, generates AI-powered narratives, forecasts, statistics, and training. No backend server — Supabase is the database, Vercel Edge Functions proxy AI calls, Vercel handles deployment.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | React 19 + TypeScript 5 (strict mode) |
| Build | Vite 6 |
| Charts | Recharts |
| Screenshots | html2canvas |
| AI | Google Gemini API (gemini-2.0-flash) |
| Database | **Supabase** (PostgreSQL + RLS + Auth + Realtime) |
| Legacy data | LocalStorage + GitHub API (controlled by `USE_SUPABASE` flag) |
| Deployment | Vercel (auto-deploy from `main`, preview from `supabase-migration`) |
| Dev server | `npm run dev` → **http://localhost:3000** (NEVER 3001) |
| Styling | Inline React styles + CSS variables (dark theme) |
| Font | Outfit (Google Fonts) |

## Critical Rules

### 1. Never Commit Without Permission
Do NOT commit, push, or merge unless the user explicitly asks. When they say "merge" / "push" / "push to BB", execute the full pipeline: bump version in `src/version.ts` → commit → push → Vercel deploys automatically.

### 2. Hebrew RTL
All user-facing text in Hebrew. Use `direction: 'rtl'` on containers. Use `gap` not `marginRight` in flex layouts.

### 3. Dual Data Layer
**Legacy** (`USE_SUPABASE = false`): LocalStorage = database, GitHub Pages = cloud sync. **Supabase** (`USE_SUPABASE = true`): PostgreSQL via `supabaseCache.ts` (in-memory cache that syncs). Feature flag in `src/database/config.ts` controls which path runs. All `storage.ts` functions have `USE_SUPABASE` branches.

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

### 10. Roles: 3 Roles, Owner vs Admin Distinction
Roles are `admin`, `member`, `viewer` (the old `memberSync` role was removed). In Supabase mode, the **owner** (group creator, `groups.created_by`) has extra powers beyond a regular admin — only the owner can modify other admins, transfer ownership, regenerate invite codes, manage API keys, and access training/activity tabs. This is enforced in SQL RPCs via `groups.created_by` checks and in the UI via `isOwner` boolean.

### 11. Per-Group API Keys
Each group stores its own `gemini_api_key` and `elevenlabs_api_key` in the `settings` table. The client reads keys from group settings and sends them in proxy requests. Vercel Edge Functions check: (1) key from request body, (2) env var fallback, (3) return error. **NEVER hardcode API keys.** Owner manages keys in Settings > AI tab.

## Architecture

### Game Lifecycle
```
NewGameScreen → LiveGameScreen → ChipEntryScreen → GameSummaryScreen
   (setup)        (play)          (count)           (results + AI)
```

### Auth & Group Management (Supabase mode)
- **Login**: Supabase Auth (email/password + Google OAuth) via `AuthScreen.tsx`
- **Groups**: Create or join via invite code in `GroupSetupScreen.tsx`
- **Player linking**: After joining, users pick their player name (or self-create) via `PlayerPicker` in `App.tsx`
- **Roles**: `admin` | `member` | `viewer`. Owner = admin who created the group (`groups.created_by`)
- **Group management**: Settings > Group tab (`GroupManagementTab.tsx`): member list, role changes, invite code, ownership transfer
- **SQL RPCs**: `004-group-management.sql` has all RPCs with owner-aware security
- **Hook**: `src/hooks/useSupabaseAuth.ts` exposes all auth + group management functions

### Auth (Legacy mode)
PIN-based. 3 roles: admin (2351), member (2580), viewer (9876). Stored in sessionStorage.

### AI Pipeline
Admin generates → stored in Supabase → all group members see it via cache. All AI functions in `src/utils/geminiAI.ts`.
API calls go through `src/utils/apiProxy.ts` → Vercel Edge Functions (`api/*.ts`) → Google/ElevenLabs. Keys flow: group settings → client → proxy request body → upstream API.

### Cloud Sync (Supabase mode)
Direct DB reads/writes through `supabaseCache.ts`. RLS policies enforce group isolation. Supabase Realtime subscriptions on 11 tables auto-refresh the cache (500ms debounce). Screens use `useRealtimeRefresh` hook for live updates.

### Activity Tracking
Silent tracking of non-admin sessions. Device fingerprint + screens visited + duration.
**Supabase**: `activity_log` table with `group_id` isolation. Owner views in Settings > Activity tab.

## File Map

| Area | Files |
|------|-------|
| **Entry** | `src/main.tsx`, `src/App.tsx` (routing, auth, PlayerPicker, PermissionContext) |
| **Types** | `src/types/index.ts` (ALL interfaces including Settings with API key fields) |
| **Auth** | `src/permissions.ts` (3 roles: admin/member/viewer), `src/hooks/useSupabaseAuth.ts` (Supabase auth + group mgmt), `src/components/PinLock.tsx` (legacy) |
| **Group Mgmt** | `src/components/GroupManagementTab.tsx`, `src/screens/GroupSetupScreen.tsx`, `src/screens/AuthScreen.tsx` |
| **Storage** | `src/database/storage.ts` (dual: localStorage OR supabaseCache) |
| **Supabase** | `src/database/supabaseClient.ts`, `src/database/supabaseCache.ts`, `src/database/config.ts`, `src/database/migrateToSupabase.ts` |
| **AI** | `src/utils/geminiAI.ts`, `src/utils/apiProxy.ts` (proxy with per-group key support), `src/utils/tts.ts` |
| **API Routes** | `api/gemini.ts`, `api/gemini-models.ts`, `api/elevenlabs-tts.ts`, `api/elevenlabs-usage.ts`, `api/_auth.ts` (JWT verification) |
| **Screens** | `src/screens/*.tsx` (12+ screen components) |
| **SQL** | `supabase/schema.sql` (20 tables), `supabase/002-auth-support.sql`, `supabase/004-group-management.sql` (RPCs with owner security) |
| **Config** | `vite.config.ts`, `tsconfig.json`, `vercel.json` |

## Group Management Security Model

| Operation | Who Can Do It | Enforced Where |
|-----------|--------------|----------------|
| Change member/viewer role | Any admin | `update_member_role` RPC |
| Change admin role | Owner only | RPC checks `groups.created_by` |
| Remove member/viewer | Any admin | `remove_group_member` RPC |
| Remove admin | Owner only | RPC checks `groups.created_by` |
| Remove owner | Nobody | RPC raises exception |
| Transfer ownership | Owner only | `transfer_ownership` RPC |
| Regenerate invite code | Owner only | `regenerate_invite_code` RPC |
| Manage API keys | Owner only | UI: `ownerOnly: true` on AI tab |
| Training/Activity tabs | Owner only | UI: `isOwner` gate + RLS |
| Delete player with games | Nobody | UI: `playerHasGames()` check blocks delete |
| Link to already-linked player | Nobody | Partial unique index + RPC check |

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
- Wants **perfect group management** — this was the main motivation for the Supabase migration
