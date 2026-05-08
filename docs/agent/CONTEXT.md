# CONTEXT — Current State

> **What this is**: A 30-second orientation for the agent at the start of a chat. Refreshed in place (overwrite, not append). If something here is stale, fix it before doing other work.
> **Last refreshed**: 2026-05-08 (post completed-game-roster-wipe permanent fix)

---

## Right now

- **Version on `main`**: `5.44.5` (commit `cac3101`).
- **Pending push (this session, 5.44.6)**: SQL migrations `050` (block direct delete on completed `game_players`) + `051` (fix migration-043's broken cascade detection) + version bump. Once pushed, `main` will be at `5.44.6`. Both migrations are already APPLIED to the live DB via `apply_migration` (with full sandbox-rollback verification of all 5 cases: cascade-on-completed/cascade-on-live/single-on-live/single-on-completed/bulk-on-live).
- **Branch**: `main`.
- **In flight (uncommitted, NOT mine, do not include in 5.44.6 commit)**:
  - `src/screens/SettingsScreen.tsx` + `src/utils/activityLogger.ts` — live wall-clock session-duration WIP. Has 2 TS errors (`getDeviceId` declared but never read; `currentSessionTs` declared but never read). Carry forward into a future session.
- **Pre-existing TS errors on `main` (NOT mine, NOT in scope)**:
  - 9 errors in `src/components/GroupSwitcher.tsx` + `src/hooks/useSupabaseAuth.ts` from the v5.44.2 super-admin observer-mode foundation. `isSuperAdmin` / `allGroups` / `isObservingNonMember` are referenced but missing from `AuthState`. Verified these are present on commit `cac3101` BEFORE any of my work — production has compiled with these errors for 24+ hours and the user hasn't reported runtime fallout.
- **Migrations applied to live DB this session**: `050_block_completed_game_player_delete`, `051_fix_bulk_delete_cascade_detection`. Files on disk: `supabase/050-…sql`, `supabase/051-…sql`.

## Active themes (last ~10 versions)

- **Data-integrity hardening** (v5.44.6, this session): row-level `BEFORE DELETE` guard on `game_players` for completed games + parent-existence-based cascade detection in the existing bulk-delete guard. Plus restoration of 7 wiped player rows for the 2026-05-07 game from auto game-end backup.
- **Notification volume tuning** (v5.43.x → v5.44.0): cut email types, EmailJS quota system, push-only for chatty events. Owner manages quota config in Settings → Services.
- **Home dashboard rebuild** (v5.38–v5.41): pure dashboard with deep-links, gender-aware verbs, RTL emails, mobile polish.
- **Schedule / poll system** (v5.37): poll reminders, join-request banner with player linking on accept.

## Tooling capabilities you already have (do NOT ask the user, do NOT defer)

- **Supabase MCP — full READ AND WRITE access** to the live DB (project `ursjltxklmxmapfvkttj`, full privileges via PAT in `.cursor/mcp.json`). The server appears as **`supabase`** or legacy **`project-0-Poker Game-supabase`** — same project, use whichever your tool list shows. **Never** ask Lior to run a `SELECT` you can run yourself with `execute_sql`. **Never** silently fall back to "ask the user" if the MCP is missing — say so and instruct a Cursor reload.
  - Reads: `list_tables` (verbose), `execute_sql`, `list_migrations`, `get_logs`, `get_advisors`, `list_branches`, `list_edge_functions`, `generate_typescript_types`, `search_docs`.
  - Writes: `apply_migration` — but ONLY after authoring `supabase/0XX-name.sql` on disk (file IS the audit trail). No ad-hoc DDL/DML inside `execute_sql`.
  - Risky writes (`DROP`, `DELETE` w/o tight `WHERE`, RLS toggles, role grants, column drops, anything mutating user data) require explicit user confirmation FIRST. Idempotent additions (`CREATE OR REPLACE`, `IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) just apply, then verify with a `SELECT`.
  - Full reference: `AGENTS.md` → "Supabase MCP — Read AND Write Enabled" + `.cursor/rules/supabase-migration.mdc` + `.cursor/rules/confirm-before-risky.mdc`.

## Things to know that aren't in `AGENTS.md` or `.cursor/rules/`

- `temp_prompt.txt`, `pool-full-dump.txt`, `*.cjs` validation scripts in repo root are intentional dev artifacts. Don't delete unprompted.
- `Poker results.xlsx` and `poker-export-*.xlsx` are real user data exports. Treat as sensitive — never commit modifications.
- **`pg_trigger_depth()` does NOT increment for FK CASCADE in AFTER-STATEMENT trigger context** — see `LESSONS.md` 2026-05-08. It DOES work in BEFORE-ROW context. Migration 043 was authored on the wrong assumption and was latently broken for 5 days. When designing trigger logic that needs to distinguish cascade from direct delete, use parent-existence check, not `pg_trigger_depth()`.

## Where the agent memory lives

```
docs/agent/
  CONTEXT.md   ← you are here (refresh in place)
  SESSIONS.md  ← chronological journal (newest first, append-only)
  LESSONS.md   ← incident → lesson, earned not pre-populated
.cursor/rules/
  agent-memory.mdc  ← enforces start/end rituals
```

The standing rules (`.cursor/rules/*.mdc`) and project map (`AGENTS.md`) are still the source of truth for **how things should be done**. This folder is the source of truth for **what's happening right now and what we've learned the hard way**.
