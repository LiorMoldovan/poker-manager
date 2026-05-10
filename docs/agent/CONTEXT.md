# CONTEXT — Current State

> **What this is**: A 30-second orientation for the agent at the start of a chat. Refreshed in place (overwrite, not append). If something here is stale, fix it before doing other work.
> **Last refreshed**: 2026-05-10 (post v5.49.1 — server-side notification dispatch verified end-to-end)

---

## Right now

- **Version on `main`**: `5.49.1` (pushed; Vercel deployed).
- **Branch**: `main`.
- **In-flight WIP**: NONE. Server-side notification dispatch is **fully live and verified end-to-end** via synthetic test on 2026-05-10 13:29: row insert → pg_net webhook fired in 35ms → worker claimed in 1.2s → marked `done` 200ms later. HTTP 200 with `{ok:true,processed:1,pushOk:1,emailOk:1,failed:0}`. No outstanding operator action.
- **Vercel env vars confirmed live**: `WORKER_INTERNAL_SECRET` (matches `worker_config.notification_worker_secret`) and `SUPABASE_SERVICE_ROLE_KEY` are both set and working. `OWNER_GROUP_ID` was already in place from prior work.
- **Pending SQL migrations**: NONE. `066-server-side-notification-dispatch.sql`, `067-worker-config-table.sql`, and `068-fix-http-post-schema.sql` are all applied to the live DB. Up through 068 is current.
- **What v5.49.x changed (architecturally important)**: dispatch is now fully server-side. Every notification — poll lifecycle, vote-change, trivia reports, training reports, milestones, reminders — flows through `notification_jobs` → pg_net `net.http_post` trigger → `/api/notification-worker` (Edge Function) → `/api/send-push` + `/api/send-email`. The browser worker (`src/utils/notificationWorker.ts`) is now a redundant fallback only — atomic `FOR UPDATE SKIP LOCKED` claim means both can run concurrently without double-dispatch. DB triggers added in 066: `trg_enqueue_vote_change_on_vote` on `game_poll_votes`, `trg_enqueue_trivia_report_on_insert` + `trg_enqueue_trivia_report_on_resolve` on `trivia_reports`, plus the `trg_http_dispatch_notification_job` webhook on `notification_jobs`. pg_cron job `notification-jobs-sweep` runs every minute as the retry path. New extensions: `pg_net` (already in `net` schema — see lesson below), `pg_cron`. New table: `worker_config (key, value)` — RLS denies anon/authenticated, only service-role and SECURITY DEFINER functions read. `claim_notification_job_internal` and `complete_notification_job_internal` RPCs authenticate via the secret in that table.
- **v5.49.1 hotfix (2026-05-10)**: 066 used `extensions.http_post(...)` everywhere, but Supabase pre-installs pg_net at the `net` schema and our `CREATE EXTENSION ... WITH SCHEMA extensions IF NOT EXISTS` was a no-op (extension already present at `net` — relocation skipped). Both webhook trigger and cron sweep functions silently failed for ~30 minutes between 066 deploy and 068 fix because of `EXCEPTION WHEN OTHERS THEN RAISE NOTICE` blocks. Migration 068 swaps to `net.http_post` in both function bodies. Lesson promoted to `LESSONS.md`.
- **Client-side helper changes**: `sendVoteChangeNotifications` and `notifyReporterOfTriviaResolution` + `notifySuperAdminsOfTriviaReport` are now no-op shims (DB triggers handle dispatch). `sendReminderNotifications` and the three `notify*OfTraining*` helpers now enqueue via the new generic `enqueueNotificationRpc` instead of dispatching directly. `proxySendPush`/`proxySendBroadcastEmail` are no longer called from notification paths — only from the test cards in Settings.

## Spot-check query for live notification health

If anything ever feels off, run this in the SQL editor:

```sql
SELECT id, kind, status, attempts, last_error, claimed_at, completed_at, created_at
FROM public.notification_jobs ORDER BY created_at DESC LIMIT 10;
```

Healthy = all `done` with `attempts=1`, `last_error=null`. `pending` rows older than ~90s mean pg_cron sweep isn't draining (check `cron.job` and `net._http_response` for the failure mode). `failed` after `attempts=3` means the worker rejected the job three times — `last_error` will say why.

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
