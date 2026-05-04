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
| Deployment | Vercel (auto-deploy from `main`, preview from `supabase-migration`) |
| Dev server | `npm run dev` → **http://localhost:3000** (default; use `npx vite --port <PORT>` if 3000 is busy) |
| Styling | Inline React styles + CSS variables (dark theme) |
| Font | Outfit (Google Fonts) |

## Supabase MCP — Use It Before Writing SQL

**You have direct read access to the live Supabase DB via an MCP server.** It is configured in `.cursor/mcp.json` (which is gitignored — contains a Supabase Personal Access Token). The server is registered with Cursor under the name **`supabase`** (or possibly `project-0-Poker Game-supabase` for legacy account-level installs). Use whichever name is in your available MCP tools list — they both expose the same tools and project (`ursjltxklmxmapfvkttj`).

The server runs in **`--read-only`** mode, so you can freely run any `SELECT` / introspection without risk. Connected user is `supabase_read_only_user`.

### Always inspect the live DB before:
- Writing a new `supabase/0XX-*.sql` migration (check current schema, defaults, RLS, existing functions/triggers — don't infer from old SQL files)
- Diagnosing a bug that involves data shape, missing rows, RLS issues, or query results
- Asking the user "can you run this SELECT and paste the result?" — DON'T. Run it yourself.

### Available tools
| Tool | Use for |
|------|---------|
| `list_tables` | Inspect current schema (set `verbose: true` for columns + FKs + PKs + RLS) |
| `execute_sql` | Any read query (`SELECT`, `EXPLAIN`). Use for RLS (`pg_policies`), functions (`pg_get_functiondef`), triggers (`pg_trigger`), sample rows |
| `list_migrations` | What's applied to the live DB |
| `get_logs` | Postgres / API / Auth / Realtime / Edge Function logs |
| `get_advisors` | Security + performance advisors (RLS gaps, missing indexes) |
| `list_branches`, `list_edge_functions`, `generate_typescript_types`, `search_docs` | Other introspection |
| `apply_migration` | **DO NOT CALL.** Migrations go through the numbered SQL file workflow (user applies them; preserves audit trail per `supabase-migration` rule) |

### Required workflow for any DB-touching task
1. **Inspect** the live state with `list_tables` / `execute_sql`.
2. **Author** the migration as `supabase/0XX-name.sql`.
3. User applies it.
4. **Verify** with `execute_sql` (new columns exist, defaults set, policies active, sample rows correct).

### Anti-pattern (real past failure — do NOT repeat)
Reading `supabase/*.sql` and `schema.sql` to infer the live state, then asking the user "can you run this SELECT?" The MCP answers instantly. Asking the user to be a query relay wastes their time and erodes trust.

### If the MCP is unavailable
If neither `supabase` nor `project-0-Poker Game-supabase` appears in your tools, tell the user: "the Supabase MCP is not registered in this session — please check `.cursor/mcp.json` exists with a valid `SUPABASE_ACCESS_TOKEN` and reload Cursor (`Ctrl+Shift+P → Developer: Reload Window`)." Do not silently fall back to "ask the user to run queries."

## Critical Rules

### 1. Never Commit Without Permission
Do NOT commit, push, or merge unless the user explicitly asks. When they say "merge" / "push" / "push to BB", execute the full pipeline: bump version in `src/version.ts` → commit → push → Vercel deploys automatically.

### 2. Hebrew RTL
All user-facing text in Hebrew. Use `direction: 'rtl'` on containers. Use `gap` not `marginRight` in flex layouts.

### 3. Supabase-Only Data Layer
All data goes through `supabaseCache.ts` (in-memory cache that syncs to Supabase PostgreSQL). `storage.ts` delegates to the cache via `cacheGet`/`cacheSet`. There is no localStorage fallback — Supabase is the single source of truth. Realtime subscriptions auto-refresh the cache on remote changes.

### 4. Inline Styles
No CSS modules, no styled-components, no Tailwind. Follow existing inline React style patterns.

### 5. Zero-Sum
Game profits across all players must always sum to exactly zero. Enforced by two DB triggers (`check_game_zero_sum` on `games` status transition + `check_game_players_zero_sum` on `game_players` profit changes) and client-side validation.

### 6. Holistic AI Prompts
Build prompts as one flowing instruction set. NEVER patch prompts with constraints — it degrades quality. Refactor the entire prompt if something needs changing.

### 7. Version in `src/version.ts`
Not in `package.json`. Always bump as part of merge process. **Changelog bullets must be very short — 3–8 words each, hard cap 12 words.** They are headlines, not sentences (no periods, no "and"-chained ideas, no parenthetical asides). The changelog renders in Settings → About for every member. Verbose root-cause autopsies, benchmarks, methodology notes, and file lists belong in the commit message — not the user-facing changelog. Internal-only details (hard-coded constants, dev heuristics never surfaced in the UI) should be left out entirely. Apply the same short-bullet rules when updating older entries; don't leave a long-paragraph past while shipping short bullets going forward. See `.cursor/rules/version-management.mdc` for full guidance.

### 8. Windows PowerShell
Dev environment is Windows. No bash syntax (`&&`, heredocs, `cat`, `grep`). Use Cursor tools or PowerShell.

### 9. No Automated Tests — But Self-Validation Is Mandatory
Validate with `npx tsc --noEmit` and ReadLints on ALL modified files. For algorithm changes, use `node -e` scripts against `public/full-backup.json`. **Never claim "done" without running these checks.** The user should never have to ask "are you sure?" — if they do, you failed. Always trace the full data flow (client → API → DB → response → UI) and check all roles (member, admin, owner, super admin).

### 10. Roles: 2 Roles, Owner vs Admin Distinction
Roles are `admin` and `member` (the `viewer` role was removed in migration 007). The **owner** (group creator, `groups.created_by`) has extra powers beyond a regular admin — only the owner can modify other admins, transfer ownership, regenerate invite codes, manage API keys, and access training/activity tabs. This is enforced in SQL RPCs via `groups.created_by` checks and in the UI via `isOwner` boolean.

### 11. Per-Group API Keys
Each group stores its own `gemini_api_key` and `elevenlabs_api_key` in the `settings` table (mapped via `toSettings`/`settingsToRow` in `supabaseCache.ts`). The client reads keys from group settings and sends them in proxy requests. Vercel Edge Functions check: (1) key from request body, (2) env var fallback, (3) return error. **NEVER hardcode API keys.** Owner manages keys in Settings > AI tab.

## Architecture

### Game Lifecycle
```
NewGameScreen → LiveGameScreen → ChipEntryScreen → GameSummaryScreen
   (setup)        (play)          (count)           (results + AI)
```

### Auth & Group Management
- **Login**: Supabase Auth (email/password + Google OAuth) via `AuthScreen.tsx`
- **Groups**: Create or join via invite code in `GroupSetupScreen.tsx`
- **Player linking**: After joining, users self-create their player name via `PlayerPicker` in `App.tsx`
- **Roles**: `admin` | `member`. Owner = admin who created the group (`groups.created_by`)
- **Group management**: Settings > Group tab (`GroupManagementTab.tsx`): member list (with emails for admins), role changes, invite code, personal player invites, add by email, ownership transfer
- **SQL RPCs**: `004-group-management.sql` has 13 RPCs with owner-aware security
- **Hook**: `src/hooks/useSupabaseAuth.ts` exposes all auth + group management functions

### AI Pipeline
Admin generates → stored in Supabase → all group members see it via cache. All AI functions in `src/utils/geminiAI.ts`.
API calls go through `src/utils/apiProxy.ts` → Vercel Edge Functions (`api/*.ts`) → Google/ElevenLabs. Keys flow: group settings → client → proxy request body → upstream API.

### Data Sync
Direct DB reads/writes through `supabaseCache.ts`. RLS policies enforce group isolation. Supabase Realtime subscriptions on 15 tables auto-refresh the cache (500ms debounce). Screens use `useRealtimeRefresh` hook for live updates. `pushToSupabase` includes error handling with `logSyncError` for all Supabase write operations.

### Login Performance (Deferred Cache Loading)
`initSupabaseCache` uses a 3-phase approach for fast startup:
- **Phase 1**: Essential group tables (players, games, settings, chips) — parallel
- **Phase 2**: Child tables by game_id in batches of 100 (game_players, expenses, forecasts, settlements, markers)
- **Phase 3 (deferred)**: Non-essential data (chronicles, graph_insights, tts_pools) loads in background after UI renders. Dispatches `supabase-cache-updated` event so screens auto-refresh when deferred data arrives.

### Activity Tracking
Silent tracking of all user sessions. Device fingerprint + screens visited + duration.
`activity_log` table with `group_id` isolation. Owner views in Settings > Activity tab.

## File Map

| Area | Files |
|------|-------|
| **Entry** | `src/main.tsx`, `src/App.tsx` (routing, auth, PlayerPicker, PermissionContext) |
| **Types** | `src/types/index.ts` (ALL interfaces including Settings with API key fields) |
| **Auth** | `src/permissions.ts` (2 roles: admin/member), `src/hooks/useSupabaseAuth.ts` (Supabase auth + group mgmt + `GroupMember` with email), `src/hooks/useRealtimeRefresh.ts` (cache-updated event listener) |
| **Group Mgmt** | `src/components/GroupManagementTab.tsx`, `src/components/GroupSwitcher.tsx`, `src/screens/GroupSetupScreen.tsx`, `src/screens/AuthScreen.tsx` |
| **i18n** | `src/i18n/index.ts`, `src/i18n/translations.ts`, `src/i18n/LanguageContext.tsx` |
| **Storage** | `src/database/storage.ts` (delegates to supabaseCache) |
| **Supabase** | `src/database/supabaseClient.ts`, `src/database/supabaseCache.ts`, `src/database/migrateToSupabase.ts` (chip repair + training import only — legacy migration code removed) |
| **AI** | `src/utils/geminiAI.ts`, `src/utils/backgroundAI.ts`, `src/utils/apiProxy.ts` (proxy with per-group key support), `src/utils/tts.ts`, `src/utils/aiTiming.ts`, `src/utils/aiUsageTracker.ts` |
| **API Routes** | `api/gemini.ts` (POST), `api/gemini-models.ts` (POST), `api/elevenlabs-tts.ts` (POST), `api/elevenlabs-usage.ts` (POST), `api/_auth.ts` (JWT verification — returns 500 if secret missing) |
| **Screens** | `src/screens/*.tsx` (15 screen components including `GameDetailsScreen`, `SharedTrainingScreen`, `SharedQuickPlayScreen`) |
| **SQL** | `supabase/schema.sql` (21 tables), `supabase/002-auth-support.sql`, `supabase/003-realtime.sql`, `supabase/004-group-management.sql` (RPCs + `player_invites`), `supabase/005-security-hardening.sql`, `supabase/006-supabase-improvements.sql` (`backups`), `supabase/007-permissions-overhaul.sql` (viewer removal, `super_admins`), `supabase/008-realtime-and-zero-sum.sql`, `supabase/008-multi-group.sql` — **24 tables total** |
| **Config** | `vite.config.ts`, `tsconfig.json`, `vercel.json` |

## Group Management Security Model

| Operation | Who Can Do It | Enforced Where |
|-----------|--------------|----------------|
| Change member role | Any admin | `update_member_role` RPC |
| Change admin role | Owner only | RPC checks `groups.created_by` |
| Remove member | Any admin | `remove_group_member` RPC |
| Remove admin | Owner only | RPC checks `groups.created_by` |
| Remove owner | Nobody | RPC raises exception |
| Transfer ownership | Owner only | `transfer_ownership` RPC |
| Regenerate invite code | Owner only | `regenerate_invite_code` RPC |
| Manage API keys | Owner only | UI: `ownerOnly: true` on AI tab |
| Training/Activity tabs | Owner only | UI: `isOwner` gate + RLS |
| Delete player with games | Nobody | UI: `playerHasGames()` check blocks delete |
| Link to already-linked player | Nobody | Partial unique index + RPC check |
| View member emails | Admin only | `fetch_group_members_with_email` RPC (joins `auth.users`) |

## User Preferences

These are learned from extensive conversation history:

- Prefers **holistic, clean solutions** over patches — "don't create constraint patches"
- Wants AI content to be **creative, dynamic, non-repetitive**
- Values **data-driven accuracy** — AI must never invent stats
- Likes **surprising insights** — mention all players, find interesting correlations
- Dislikes **redundancy** — don't repeat data shown elsewhere
- Expects **one-shot quality** — "I want amazing solution in one try, not ping pong"
- **HATES ping-pong debugging** — validate thoroughly BEFORE claiming done, not after
- Wants to **review before merge** — never auto-commit
- Refers to GitHub as **"BB"** (push to BB = push to GitHub)
- Game nights are typically **Thursday or Saturday**
- Prefers **concise explanations** — show tables, not walls of text
- When fixing bugs, **fix root cause** not symptoms
- For UI, prefers **compact, readable cards** — not long scrollable lists
- Wants **perfect group management** — this was the main motivation for the Supabase migration

## Lessons Learned (Anti-Patterns to Avoid)

These are real mistakes from past conversations. Do NOT repeat them:

1. **Don't confirm then backtrack**: If you say "it works", it must actually work. Never say "done" then find issues when the user asks to double-check.
2. **Check all roles upfront**: When adding tables/RLS, always include super admin policies from the start. Don't wait for the user to point out "I'm super admin and can't see cross-group data."
3. **Localhost vs Production**: Vercel Edge Functions (`/api/*`) don't exist on localhost. If a feature depends on them (email, AI proxy), say so immediately when presenting the feature — not after the user tests and it fails.
4. **Silent error swallowing**: `catch {}` hides bugs. At minimum log to console during development. Don't ship empty catch blocks for features that need debugging.
5. **Test the data flow, not just the types**: `tsc` passing doesn't mean the feature works. Trace: where does the data come from? Who has permission to read it? Does the query return what the UI expects?
6. **Pre-merge: exclude temp files**: Always check `git status` before committing and unstage `temp-*.json`, `.env`, and other non-source files.
