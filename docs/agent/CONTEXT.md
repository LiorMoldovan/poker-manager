# CONTEXT — Current State

> **What this is**: A 30-second orientation for the agent at the start of a chat. Refreshed in place (overwrite, not append). If something here is stale, fix it before doing other work.
> **Last refreshed**: 2026-05-10 (post v5.58.0 — combined chip-permissions + trivia kill-switch + leaderboard sort + AI trait diet, all merged in one go)

---

## Right now

- **Version on `origin/main`**: `5.58.0` — combined release that bundled three parallel agents' work: (1) Lior+me opening photo chip-counting test card + accuracy dashboard to all admins so Eyal can co-test, (2) trivia template kill-switch (super-admin can permanently exclude bad questions from a group's pool, restorable from inbox), (3) trivia leaderboard re-sorted to accuracy-first instead of total-correct-first, (4) "My stats" card removed from trivia landing as redundant with leaderboard, (5) AI personality-trait blocks dialed back so prompts lean ~90% on game stats and only sometimes (~70% probability, max 1–2 players per call) surface trait flavor.
- **No in-flight WIP**: working tree clean after the v5.58.0 merge push.
- **Applied SQL migrations** (all three new ones live + committed in v5.58.0):
  - `070-chip-count-tuning.sql` (committed earlier in v5.55).
  - `071-chip-feedback-admin-read.sql` — replaced `chip_count_feedback_select_owner` with `chip_count_feedback_select_admin` so admins (not just owner) can SELECT feedback rows for the dashboard. INSERT was already group-member-wide; DELETE stays owner-only.
  - `072-trivia-leaderboard-sort-by-accuracy.sql` — `CREATE OR REPLACE` of `fetch_trivia_leaderboard` so ORDER BY chain is `accuracy DESC NULLS LAST, SUM(score) DESC, SUM(total_questions) DESC, player_name ASC`. Same column shape, only row order changes.
  - `073-trivia-deleted-templates.sql` — new `trivia_deleted_templates` table + RPCs `delete_trivia_template` / `restore_trivia_template` (super-admin-only via SECURITY DEFINER). Realtime publication added so every client's exclusion set updates live without a reload. **Filename note**: this was authored as `070-…` but renumbered to 073 to avoid an on-disk collision with the already-committed `070-chip-count-tuning.sql`. The DB record (`070_trivia_deleted_templates`) is immutable timestamp-keyed history — only the on-disk filename changed.
- **Vercel env vars (no change)**: `WORKER_INTERNAL_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `OWNER_GROUP_ID`, plus per-feature keys (Gemini/ElevenLabs/EmailJS).
- **Notification dispatch (still as of v5.49.x architecture)**: fully server-side. Every notification flows through `notification_jobs` → pg_net `net.http_post` trigger → `/api/notification-worker` Edge Function → `/api/send-push` + `/api/send-email`. Browser worker (`src/utils/notificationWorker.ts`) is redundant fallback only. DB triggers from 066: `trg_enqueue_vote_change_on_vote` on `game_poll_votes`, `trg_enqueue_trivia_report_on_insert` + `trg_enqueue_trivia_report_on_resolve` on `trivia_reports`, plus the `trg_http_dispatch_notification_job` webhook on `notification_jobs`. pg_cron job `notification-jobs-sweep` runs every minute as the retry path.

## Chip-counting permission model (v5.58.0 — live)

The Services tab (`'ai'`) is admin-accessible:

| Card | Visible to | Why |
|------|-----------|-----|
| Game Readiness, AI Usage, API Keys, key setup guide, share-photos opt-in | Owner only (`{isOwner && (...)}`) | API/billing config + privacy decisions |
| Photo Chip Counting Test Card | All admins | Co-tester needs to take photos |
| Accuracy Dashboard (KPIs, per-color, trend chart) | All admins (`isOwner || role==='admin' || isSuperAdmin`) | RLS migration 071 lets admins SELECT `chip_count_feedback` |
| Tune button + Revert button | Owner only (read-only hint shown to admins) | RLS on `chip_count_tuning_overrides` INSERT is owner-only — keeps DB and UI aligned |
| Auto-rollback safety net (`checkAndAutoRollbackIfNeeded`) | Owner only (gated in load `useEffect`) | It writes a revert row → owner-only RLS would reject for admins |

In Lior's group (`Poker Night`, owner = Lior `2c8d9de2-…`): admins are Lior, אייל (`eyalerz@gmail.com`), חרדון. Both non-owner admins will get test-card + dashboard access; only Lior can trigger tunings.

## Spot-check queries

For the in-app feedback loop (what's coming in from real games):

```sql
SELECT created_at, player_name, model_used, overall_confidence,
       shots_used, total_stacks, correct_stacks, total_chip_delta, total_abs_delta
FROM   public.chip_count_feedback
ORDER BY created_at DESC LIMIT 20;
```

Healthy = rows showing up after games where the photo button was used; `correct_stacks` ≈ `total_stacks` for in-tolerance counts; `total_chip_delta` skewed positive ⇒ AI still undercounting; near zero ⇒ MAX aggregation worked. Per-stack diffs live in the `stacks` JSONB column for deeper drill-down (`SELECT stacks FROM chip_count_feedback WHERE id = '…'`).

For the notification system (still relevant):

```sql
SELECT id, kind, status, attempts, last_error, claimed_at, completed_at, created_at
FROM public.notification_jobs ORDER BY created_at DESC LIMIT 10;
```

Healthy = all `done` with `attempts=1`, `last_error=null`. `pending` rows older than ~90s mean pg_cron sweep isn't draining (check `cron.job` and `net._http_response` for the failure mode). `failed` after `attempts=3` means the worker rejected the job three times.

## Spot-check query for live notification health

If anything ever feels off, run this in the SQL editor:

```sql
SELECT id, kind, status, attempts, last_error, claimed_at, completed_at, created_at
FROM public.notification_jobs ORDER BY created_at DESC LIMIT 10;
```

Healthy = all `done` with `attempts=1`, `last_error=null`. `pending` rows older than ~90s mean pg_cron sweep isn't draining (check `cron.job` and `net._http_response` for the failure mode). `failed` after `attempts=3` means the worker rejected the job three times — `last_error` will say why.

## Active themes (last ~10 versions)

- **v5.58.0 combined release — three streams merged** (2026-05-10): chip-counting permissions opened to admins (test card + dashboard, tune+revert stay owner-only), trivia template kill-switch landed (super-admin can permanently exclude bad questions, restorable), trivia leaderboard re-sorted accuracy-first, "My stats" card removed from trivia landing, AI personality traits dialed back (≤1–2 players surfaced per call, ~70% inclusion probability, prompts re-tuned to lean 90/10 game-stats vs personal facts in TTS pool — was 80/20).
- **Photo chip counting accuracy + feedback loop** (v5.47.0 → v5.49.x → v5.53.0): full evolution from "snap photo → AI proposes counts" (v5.47) through the multi-shot consensus + computed confidence rebuild (v5.49) to the in-app feedback capture infrastructure (v5.53, migration 069). Position-based identity (chips sorted ascending) replaces color discrimination as the accuracy lever, MAX aggregation across 3 parallel shots counters the systematic undercount bias, and silent diff capture in `markPlayerDone` now records (AI vs real) per-stack diffs to `chip_count_feedback` so future tuning can be empirical instead of intuitive.
- **Trivia hardening + UX polish** (v5.50.x → v5.53.0): stale-state click-time correctness lock (v5.50.2), difficulty moderation with 20-game eligibility floor and bucketed range answers (v5.51), trivia mode redesign — Group=broad, עליי=personal, Mixed=50/50 per-question (v5.52), and same-release tweaks to the report-problem button label + wider `numericDistractors` spread (0.55 → 0.85) so ±40% ballpark estimates win.
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
