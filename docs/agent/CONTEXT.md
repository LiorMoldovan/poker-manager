# CONTEXT — Current State

> **What this is**: A 30-second orientation for the agent at the start of a chat. Refreshed in place (overwrite, not append). If something here is stale, fix it before doing other work.
> **Last refreshed**: 2026-05-15 (post v5.60.13 chip-counting selfie color fix)

---

## Right now

- **`origin/main`**: `5.60.13` — surgical fix for a v5.59.0 regression where `captureChipSelfie` sampled the dead-center 24×24 patch of every chip selfie and computed `selfieDominantHex` from it. Most poker chips have a printed value inlay/sticker dead-center → every stored hex came out muddy grey/beige (red→#b59e94, blue→#7b86a3, green→#aaaa94, black→#989493) → `stackDetection.ts` HSL-distance mapping was effectively random → counts went into wrong color rows → feature appeared totally broken. Fix: rewrote dominant-color extraction in `imageUtils.ts` to sample 32 patches across 4 concentric rings at 30/45/60/75% radius and take per-channel median (robust against text/inlay/edge outliers). Added `recomputeDominantHexFromBase64` + `looksLikeInlayBugHex` predicate (sat<0.15 AND 0.30<lum<0.75 — the muddy grey zone no real chip body lands in). Added one-time per-session auto-migration in `SettingsScreen` that recomputes existing inlay-bug-shape hexes from saved JPEGs on chipValues load. Defensive fallback in `stackDetection.ts`: if a hex still looks bug-shaped after recompute, use `displayColor` instead of a known-bad reference. Lior + Eyal don't need to retake selfies — JPEGs are fine, only the broken hex got fixed. Lesson promoted to LESSONS.md (2026-05-15: never sample the center patch on stickered objects). The history of pre-v5.60.13 chip-counting bullets above is preserved in CHANGELOG (`src/version.ts`) for anyone reading the in-app About screen.
- **Pending parallel-agent work in working tree** (NOT in this commit): v5.61.0 immutable-games line — `supabase/077-block-completed-status-downgrade.sql` (untracked) + ~16 modified files (`AIKeyMissingNotice`, `storage`, `supabaseCache`, several screens, `aiEligibility`, `apiProxy`, `geminiAI`, `pokerTraining`, plus their version.ts bump to 5.61.0). My v5.60.13 commit deliberately staged ONLY my 4 files (`imageUtils.ts`, `stackDetection.ts`, `SettingsScreen.tsx`, `version.ts`) so the parallel work stays in their hands to commit when ready. They'll need to bump to 5.61.0 from this new 5.60.13 base when they merge.

## Open follow-ups

- **Verify v5.60.13 fix landed for Lior**: after Vercel deploy, Lior opens Settings → Chips, the auto-migration runs silently, then re-tests photo chip counting from the test card. If still misbehaving, the failure mode will be a DIFFERENT one (inlay-bug class is patched + guarded) — investigate from there.
- **Local dev shows zero admin controls in LiveGameScreen** (Lior, from 2026-05-13). Almost certainly wrong-account-on-localhost; pending his confirmation before digging into `usePermissions()` resolution timing.
- **"Mini table with more details" home-card memory** (Lior). Needs a screenshot to pin down which view he's remembering. Deferred.

## Standing infrastructure (changes infrequently)

- **Notification dispatch (v5.49.x)**: server-side via `notification_jobs` → pg_net → `/api/notification-worker` → send-push + send-email. Browser worker is redundant fallback. pg_cron `notification-jobs-sweep` retries every minute.
- **Chip-counting permission model (v5.58.0)**: Services tab admin-accessible; Test Card + Accuracy Dashboard for all admins; Tune+Revert + auto-rollback owner-only (RLS-aligned).
- **Vercel env vars**: `WORKER_INTERNAL_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`, `OWNER_GROUP_ID`, per-feature keys (Gemini/ElevenLabs/EmailJS).
- **Recently-applied SQL** (do not re-apply): `070`–`076`. See `supabase/` folder for current set. `076` rewrites `delete_group` + relaxes `block_bulk_direct_delete` + `block_completed_game_player_delete` to honor a transaction-local `app.cascade_group_delete` flag. Untracked `077-block-completed-status-downgrade.sql` belongs to the parallel agent's pending v5.61.0 work — not yet committed and not yet applied.

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

- **v5.60.11** — `ALL_MODELS_FAILED: Status 404` localhost UX fix. Vite dev server returns SPA-fallback HTML-404 for any `/api/*` POST (Vercel Edge Functions only exist at deploy time). The `runGeminiText` retry loop's 404-handler treats 404 as "model deprecated, try next" — so all 3 models retry → throws `ALL_MODELS_FAILED: Status 404` → red banner. New `aiFetch` wrapper in `apiProxy.ts` distinguishes HTML-404 (proxy missing) from JSON-404 (model missing) by content-type, synthesizes a `503 aiProxyUnavailable` JSON that propagates as `AI_PROXY_UNAVAILABLE` sentinel through 5 retry loops, and caches the result (subsequent calls short-circuit instantly — first call still wastes one fetch to keep `vercel dev` working). 6 AI screens route the sentinel to a dedicated proxy-down state and render the existing `AIKeyMissingNotice` with new `reason="proxyUnavailable"` (amber + 🛠️, no CTA).
- **v5.60.10** — Forecast `NO_API_KEY` no longer triggers a fake 60s rate-limit countdown. A third retry loop in `generateAIForecasts` (separate from the main `runGeminiText` loop and the pokerTraining loops) was missing the `403 aiKeyRequired → throw NO_API_KEY` short-circuit, so it cascaded to "All AI models are rate limited or unavailable" which the NewGameScreen catch matched against `.includes('rate limit')`. Also: Insights button hidden when no key (was silent no-op); forecast no-key notice moved INSIDE the forecast modal (was hidden behind overlay); comic regenerate button gated by `getGeminiApiKey()`.
- **v5.60.9** — Delete Group RPC actually deletes the group. Two-bug compound: (1) `delete_group` body was `DELETE FROM groups WHERE id = X` and trusted cascades, but the `game_players.player_id → players` NO-ACTION FK is checked while `players` cascade runs before `game_players` is cleaned (PG cascade order ≠ FK dependency order), so the delete failed with a 23503; (2) even with manual ordering, the bulk-delete + completed-game guards from 043/050/051 would block the cleanup (051's claim that `games`/`players` have "no inbound FKs" missed `groups`). Migration 076 introduces a transaction-local `app.cascade_group_delete` flag honored by both guards; `delete_group` sets it and does ordered `game_players → games → players → groups`. UX side: modal now stays open + renders the error inline on failure (was a top-of-page toast invisible to a user at the delete button at the bottom).
- **v5.60.7 / v5.60.8** — friendly-notice copy polish for the no-AI-key empty states. Each notice now explains what specifically is missing (summary / forecast / insights / comic / TTS / photo / training) with owner-vs-member variants, plus tighter "fail fast on missing key" wiring on training paths.
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
