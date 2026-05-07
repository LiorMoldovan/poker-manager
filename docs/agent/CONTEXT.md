# CONTEXT — Current State

> **What this is**: A 30-second orientation for the agent at the start of a chat. Refreshed in place (overwrite, not append). If something here is stale, fix it before doing other work.
> **Last refreshed**: 2026-05-07

---

## Right now

- **Version on `main`**: `5.44.0` (commit `ad7fe6f`)
- **Branch**: `main`
- **In flight (uncommitted)**:
  - `src/database/supabaseCache.ts` + `src/screens/SettingsScreen.tsx` — push subscriber dedup migrating from `playerName` (mutable label) to `user_id` (stable identity). Triggered by Sefi appearing twice in Settings → Push after a display-name rename (`ספי` → `ספי טורס`).
  - Other files in `git status` are CRLF-only diffs, not real edits.
- **No pending SQL migrations** that I'm aware of. (Always re-check `supabase/0XX-*.sql` vs `list_migrations` MCP call before claiming this.)

## Active themes (last ~10 versions)

- **Notification volume tuning** (v5.43.x → v5.44.0): cut email types, EmailJS quota system, push-only for chatty events. Owner manages quota config in Settings → Services.
- **Home dashboard rebuild** (v5.38–v5.41): pure dashboard with deep-links, gender-aware verbs, RTL emails, mobile polish.
- **Schedule / poll system** (v5.37): poll reminders, join-request banner with player linking on accept.

## Things to know that aren't in `AGENTS.md` or `.cursor/rules/`

- The Supabase MCP server might appear under either `supabase` or `project-0-Poker Game-supabase` in the available tools — both point to the same project (`ursjltxklmxmapfvkttj`). Use whichever shows up.
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
