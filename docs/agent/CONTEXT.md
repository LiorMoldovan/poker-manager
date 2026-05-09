# CONTEXT — Current State

> **What this is**: A 30-second orientation for the agent at the start of a chat. Refreshed in place (overwrite, not append). If something here is stale, fix it before doing other work.
> **Last refreshed**: 2026-05-09 (post v5.47.0 — photo chip counting + home "About You" card + tab-return cache recovery)

---

## Right now

- **Version on `main`**: `5.47.0` (commit `80c36ca`).
- **Branch**: `main`. Working tree clean.
- **No in-flight WIP.** v5.47.0 bundled three parallel agent streams: (1) photo-based chip counting at end-of-game (admin tool in `ChipEntryScreen` + owner test card in Settings → Services, anchored on a configurable left-to-right `chip_color_order` so the AI doesn't need to discriminate colors); (2) home dashboard `AboutYouCard` extracted alongside trivia via a shared `RotatingFactCard`; (3) `useRealtimeRefresh` opt-in `forceRefreshOnReturn` callback + new `forceRefreshPlayersFromDb` / `forceRefreshPollsFromDb` exports so Schedule/Group/Home screens recover from WebSocket gaps after the phone wakes. `npx tsc --noEmit` clean, lints clean.
- **No pending SQL migrations.** All migrations through `060` are applied to the live DB.
- **Photo chip counting — known limitations**: gemini-2.5-flash via the existing `/api/gemini` proxy. Owner needs to (a) configure the chip color order under Settings → Chips, (b) shoot at ~30–45° angled side view on a plain background with chips separated into per-color vertical stacks. The owner-only test card under Services lets them validate accuracy on their own chip set + lighting before relying on it in a live game. Like all `/api/*` features, only works on deployed Vercel — not localhost.

## Active themes (last ~10 versions)

- **Photo chip counting + multi-stream merge** (v5.47.0, this session): "snap photo → AI proposes counts with per-stack confidence + total reconciliation banner → human confirms or edits" flow. Position-based identity (configurable color order) replaces color discrimination as the accuracy lever. Plus home `AboutYouCard` and tab-return cache recovery shipped in the same release.
- **Home/schedule UX polish + new-group onboarding** (v5.45.0–v5.46.0): home dashboard forward-looking teaser for brand-new groups; schedule card empty state rewritten; schedule tab empty state shows next auto-create anchor; polls auto-link to games and auto-archive when their game completes; activity log shows live session minutes; observer mode for super admins viewing foreign groups.
- **Data-integrity hardening** (v5.44.6): row-level `BEFORE DELETE` guard on `game_players` for completed games + parent-existence-based cascade detection. SQL migrations `050` + `051`. Resolved a 5-day-latent bug in 043 where `pg_trigger_depth()` returned the wrong value in AFTER-STATEMENT context.
- **Realtime cache-recovery on tab return** (v5.47.0): `useRealtimeRefresh` accepts an optional `forceRefreshOnReturn` callback so screens whose underlying tables get write-heavy from peers (votes, member adds) actually re-fetch from Supabase when the tab regains focus, instead of just re-rendering stale in-memory cache.
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
- **"Forward-only" is the user's default cleanup preference**: when fixing labels, route names, classifications, or any displayed-from-historical-data field, change the WRITE path so new entries are correct and let old rows age out. Never backfill, never auto-fix existing rows. (Surfaced again in v5.45.0 around the activity log "/new-game" → "Home" rename.)
- **Hebrew copy needs care**: dual forms ("שלשום"), avoid bare prepositions ("ל" without infinitive), prefer warm forward-looking verbs over formal/scheduling words. The user pushes back hard on awkward Hebrew. When in doubt, prefer simple, inviting phrasing over technically-correct-but-stiff phrasing.

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
