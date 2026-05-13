# CONTEXT — Current State

> **What this is**: A 30-second orientation for the agent at the start of a chat. Refreshed in place (overwrite, not append). If something here is stale, fix it before doing other work.
> **Last refreshed**: 2026-05-13

---

## Right now

- **`origin/main`**: `5.60.6` (reverted the v5.60.5 numpad running-total strip after Lior caught the framing bug — per-player chip running != expected IS profit/loss, NOT an error; aggregate signal is correctly handled by the existing top-of-screen progress bar + the chip-gap warning at finalize. Also patched a stale-preview bug in the chip-gap warning where editing counts after the first calculate tap would bypass the second-tap confirmation).
- **CRLF ghost files** in `git status` (TriviaReportsTab, TriviaGameScreen, supabaseCache, types/index, geminiAI, triviaGenerator, triviaReportNotifications, etc.) — `git diff --numstat` shows 0/0 line delta. Pure CRLF noise; resolves itself on next real edit.

## Open follow-ups

- **Local dev shows zero admin controls in LiveGameScreen** (Lior). Almost certainly wrong-account-on-localhost; pending his confirmation before digging into `usePermissions()` resolution timing.
- **"Mini table with more details" home-card memory** (Lior). Needs a screenshot to pin down which view he's remembering. Deferred.

## Standing infrastructure (changes infrequently)

- **Notification dispatch (v5.49.x)**: server-side via `notification_jobs` → pg_net → `/api/notification-worker` → send-push + send-email. Browser worker is redundant fallback. pg_cron `notification-jobs-sweep` retries every minute.
- **Chip-counting permission model (v5.58.0)**: Services tab admin-accessible; Test Card + Accuracy Dashboard for all admins; Tune+Revert + auto-rollback owner-only (RLS-aligned).
- **Vercel env vars**: `WORKER_INTERNAL_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `OWNER_GROUP_ID`, per-feature keys (Gemini/ElevenLabs/EmailJS).
- **Recently-applied SQL** (do not re-apply): `070`–`075`. See `supabase/` folder for current set.

## Spot-check queries (when debugging)

```sql
-- Chip feedback loop (after games using photo button)
SELECT created_at, player_name, overall_confidence, total_stacks, correct_stacks, total_chip_delta
FROM public.chip_count_feedback ORDER BY created_at DESC LIMIT 20;

-- Notification health (all should be done/attempts=1)
SELECT id, kind, status, attempts, last_error, claimed_at, completed_at
FROM public.notification_jobs ORDER BY created_at DESC LIMIT 10;
```

## Active themes (last ~5 versions)

- **v5.60.6** — reverted the v5.60.5 numpad running-total strip (framing bug — per-player running ≠ expected is profit/loss, not error; aggregate signal already covered by top progress bar + chip-gap warning). Also patched a stale-preview bug: chip-gap warning now invalidated on `chipCounts` change so editing counts after the first calculate tap forces a fresh re-confirmation.
- **v5.60.5** — chip-entry self-correction polish: `handleCalculate` requires a second tap when `|gap| >= 1₪` and surfaces the per-player deduction/credit, photo modal gates auto-apply on `overallConfidence < 50` via new `'lowConfidence'` review phase, and the SettingsScreen test card aggregates multi-stack same-color rows for display + sums them when seeding initial actual counts. (The fourth item — numpad running-total strip — was reverted in v5.60.6.)
- **v5.60.3–v5.60.4** — per-group AI key enforcement: server gates `groupId === OWNER_GROUP_ID` or 403; client `aiEligibility.ts` + friendly `AIKeyMissingNotice` across 6 surfaces.
- **v5.60.0–v5.60.2** — `/schedule` promoted out of Settings (rich single-date home card, auto-elevation); photo chip tip rewritten + defensive same-color sum in `applyPhotoResult`.
- **v5.59.0** — photo chip-counting rebuild: per-stack LLM + 3 geometric methods + weighted vote, chip selfies, white balance, total-value sanity check. Auto-tuner is the improvement lever.
- **v5.58.0** — chip Test Card + Accuracy Dashboard opened to admins (Tune+Revert stay owner-only via RLS); trivia template kill-switch; AI traits dialed back.
- **v5.49.x** — server-side notification dispatch via pg_net + pg_cron. Browser worker now redundant fallback.

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
