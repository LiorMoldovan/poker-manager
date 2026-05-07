# CONTEXT — Current State

> **What this is**: A 30-second orientation for the agent at the start of a chat. Refreshed in place (overwrite, not append). If something here is stale, fix it before doing other work.
> **Last refreshed**: 2026-05-07 (MCP capability reinforcement)

---

## Right now

- **Version on `main`**: `5.44.0` (commit `ad7fe6f`)
- **Branch**: `main`
- **In flight (uncommitted)**:
  - `src/database/supabaseCache.ts` + `src/screens/SettingsScreen.tsx` — push subscriber dedup migrating from `playerName` (mutable label) to `user_id` (stable identity). Triggered by Sefi appearing twice in Settings → Push after a display-name rename (`ספי` → `ספי טורס`).
  - `src/utils/apiProxy.ts` + `src/utils/previewScheduleEmails.ts` + `src/utils/scheduleNotifications.ts` + `src/screens/SettingsScreen.tsx` — email proxies now return `{ ok, error?, status?, reason? }` instead of `boolean`. Email-preview tester surfaces the real server error (e.g. "EmailJS: quota exceeded (502)") instead of a generic toast. Console.error replaces the silent `catch {}`.
  - `src/auth/observerMode.ts` + `src/components/GroupSwitcher.tsx` + `src/hooks/useSupabaseAuth.ts` — observer/super-admin cross-group access WIP. Currently has 9 TS errors (`isSuperAdmin`/`allGroups`/`isObservingNonMember` not on `AuthState`). NOT introduced by me; exists on the working tree as I picked it up.
  - Other files in `git status` are CRLF-only diffs, not real edits.
- **No pending SQL migrations** that I'm aware of. (Always re-check `supabase/0XX-*.sql` vs `list_migrations` MCP call before claiming this.)

## Active themes (last ~10 versions)

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
