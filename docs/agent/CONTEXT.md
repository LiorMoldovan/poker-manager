# CONTEXT — Current State

> **What this is**: A 30-second orientation for the agent at the start of a chat. Refreshed in place (overwrite, not append). If something here is stale, fix it before doing other work.
> **Last refreshed**: 2026-05-15 (post v5.61.1 — vote_change push-only + email-log service-role fix)

---

## Right now

- **`origin/main`**: `5.61.1` — Lior reported "Eyal opened new poll and I get emails for each and every vote change" — and on the same Settings screen the EmailJS Usage card showed 122/200 while EmailJS dashboard showed 195/200 (5 quota slots left, 4 days till May 19 reset). Two distinct compounding bugs:
  1. **vote_change emails going out.** Client-side `EMAIL_ALLOWLIST` in `scheduleNotifications.ts` correctly excludes `vote_change` (push-only by design — fires on every RSVP cast/edit), but the server-side `api/notification-worker.ts` (v5.49.0's pg_net-driven worker) never got the equivalent allowlist. `planForJob`'s `vote_change` branch returned `pushOnly: false`, so every vote dispatched both push + email. The browser worker can't claim vote_change jobs (its switch only covers 5 lifecycle kinds), so vote_change jobs are exclusively handled by the Edge Function worker — and exclusively emailed. Fix: set `pushOnly = true` in the `vote_change` branch of `planForJob`. Belt-and-suspenders parallel to the client-side allowlist.
  2. **Worker-dispatched emails silently dropped from `email_usage_log`.** `log_email_send` (migration 052) had `if auth.uid() is null then raise 42501 'unauthenticated'` as a defense-in-depth guard. The browser worker's calls to `/api/send-email` forward the user's JWT → `auth.uid()` resolves → log row inserted. But the Edge Function worker forwards `Bearer SUPABASE_SERVICE_ROLE_KEY` (no user JWT) → `auth.uid()` is NULL → the RPC raised → `send-email.ts`'s try/catch swallowed it silently → email went out via EmailJS, no log row. Migration 079 drops the auth.uid() check (function is already SECURITY DEFINER + grant-restricted, so service-role being trusted adds zero attack surface). Applied + verified live.
  - **Baseline resync**: while at it, updated `system_config.emailjs_baseline` from `{used:86, taken_at:2026-05-06}` to `{used:195, taken_at:now, cycle_start:2026-04-19}` so the Usage card immediately reflects EmailJS reality. From now, new sends after the new takenAt are added to 195; the 73 missing rows are absorbed into the baseline.
- **v5.61.0 (previous main)** — merged parallel agent's pending work: weekend roster-wipe permanent fix (scoped GAMES upsert + migration 077 BEFORE-UPDATE-OF-status trigger blocking `completed → *` transitions) + TTS pool fire-and-forget (Start button no longer blocks 20-30s on TTS generation, navigation instant, `tts-pool-ready` CustomEvent swaps amber pill for model badge once pool arrives).
- **v5.60.14** — retired the `selfieDominantHex` per-user color calibration code path entirely. Use the user-configured `display_color` for HSL matching instead. Selfie JPEGs themselves still pass to the LLM as few-shot reference images.
- **Working tree**: clean of my work after v5.61.1 commit. There's still WIP from other sessions in `src/utils/geminiAI.ts` (pre-existing TS6133 on a `_legacyCountChipsFromPhoto_DEPRECATED` symbol), `src/screens/GraphsScreen.tsx`, and `.cursor/rules/agent-memory.mdc`. Not mine; left untouched.

## Open follow-ups

- **Watch EmailJS quota carefully through May 19**: only 5 slots left at v5.61.1 deploy. The vote_change patch and worker-logging fix BOTH take effect on the next Vercel deploy — meaning live volume should drop precipitously (no more emails on every vote, and the few legitimate worker-dispatched emails will now be logged). If the Usage card hits 200 before May 19, members will see EmailJS hard-fails until reset.
- **Verify v5.61.0 lands cleanly on next weekend's game**: the roster-wipe fix is the real test. Two layers of defense (TS scoped upsert + DB trigger) should prevent recurrence.
- **Verify v5.60.14 chip-counting fix for Lior**: the displayColor-matching change is purely runtime-side. Counts should now route to the correct chip-color rows. If still misbehaving, failure mode is in the LLM count or stack region detection.
- **One selfie worth retaking**: Lior's Black chip selfie photographed as grey/silver (under-exposed). Other 5 selfies fine to keep as LLM few-shot references.
- **Local dev shows zero admin controls in LiveGameScreen** (Lior, from 2026-05-13). Almost certainly wrong-account-on-localhost; pending confirmation before digging into `usePermissions()` resolution timing.
  1. **Weekend roster wipe permanent fix.** Lior reported the THIRD weekend in a row that a just-completed game showed "0 שחקנים • 0 קניות" on History. Backups taken hours after completion still had the full roster — wipe was post-completion, post-backup, only against game_players. Migrations 043 + 050 + 051 (the existing completed-game guards) were verified-correct, yet the roster vanished. Root cause: the TS GAMES sync was a BLANKET upsert pushing every game in local memory, not just touched ones. A stale tab whose cache had `status='live'` for a game completed elsewhere would push the stale row back, flipping `'completed' → 'live'`, which made the BEFORE-DELETE guard read the now-stale parent status and let the roster be wiped one row at a time. Fix in two layers: (a) `supabaseCache.ts` GAMES upsert now scopes to ONLY games whose `gameLocalWriteAt` marker is set (passive stale tabs push nothing); (b) `supabase/077-block-completed-status-downgrade.sql` adds a BEFORE-UPDATE-OF-status trigger that rejects any `completed → *` transition unless `app.cascade_group_delete` (delete_group RPC) or `app.allow_completed_reopen` (the new `reopen_completed_game` SECURITY DEFINER RPC) flag is set. The "Reopen Chip Entry" admin button now routes through the RPC instead of a direct UPDATE — `storage.ts` `updateGameStatus` detects the downgrade and dispatches the RPC, deliberately skipping `markGameLocallyWritten` so the debounced upsert won't race the RPC. Both function + trigger were already applied to live DB by the parallel agent before commit; my merge added the file for audit-trail consistency.
  2. **TTS pool fire-and-forget.** Previously `startGameWithForecast` awaited `generateLiveGameTTSPool` and showed a "🎙️ מכין את הערב..." spinner blocking the Start button for 20-30s. Pool is purely additive flavor (consumers fall back to hardcoded Hebrew lines when absent), so blocking was unnecessary. Now: navigation happens instantly; TTS generation runs as `void promise.then(...)`, dispatches a gameId-scoped `tts-pool-ready` CustomEvent on completion. `LiveGameScreen.tsx` initializes `ttsLoading` from nav state, listens for the event, swaps the new amber "🎙️ מכין קולות" pill for the model badge once the pool arrives. Translations cleaned up.
- **v5.60.14 (the previous main entry)** retired the `selfieDominantHex` per-user color calibration code path entirely. v5.60.13 had tried to fix the v5.59.0 inlay-sampling bug with ring sampling + auto-migration, but Lior's actual stored selfies revealed two compounding issues that v5.60.13 didn't fully resolve:
  1. The `looksLikeInlayBugHex` threshold (sat<0.15) was too tight — Red and Blue stored hexes had sat≈0.18 and were skipped by auto-migration.
  2. Even when the migration ran (White, Green, Black), the new ring sampling at 60-75% radius reached OUT to the green-poker-felt background for chips that didn't fill the frame, producing wrong-color hexes (white→#0c805c dark green, black→#338665 green).
  
  Diagnosis: extracting reliable chip body color from arbitrary phone selfies is fundamentally fragile — depends on chip size in frame, inlay presence, background color. None of which we can reliably detect client-side without real CV (chip-boundary detection). The user-configured `display_color` (e.g. #EF4444 red, #3B82F6 blue) is well-saturated, hue-correct, and 100% reliable. Verified empirically with stress tests: HSL distance matching against `display_color` correctly identifies all 6 chips with healthy 5-15× margin under realistic lighting; only a narrow zone of very dim/desaturated blue bodies could mistake for green, narrowed further by the white-balance pass already in `stackDetection.ts`.
  
  Changes:
  * `stackDetection.ts`: drop `selfieDominantHex` reads, always use `chip.displayColor` as the HSL reference. Removed the v5.60.13 `looksLikeInlayBugHex` defensive fallback (no longer needed).
  * `imageUtils.ts`: `captureChipSelfie` no longer computes/returns `dominantHex` — just `{ base64, mimeType }`. Removed the `computeChipBodyHex` helper, `recomputeDominantHexFromBase64`, and `looksLikeInlayBugHex` from v5.60.13.
  * `SettingsScreen.tsx`: removed the v5.60.13 auto-migration `useEffect`. `handleSelfieFile` now writes `selfieDominantHex: null`. Cleaned the `useRef` import.
  * `supabase/078-deprecate-chip-selfie-hex.sql`: NULLs out all existing `selfie_dominant_hex` (already known-bad). Updates column comment marking it deprecated. Column itself preserved (not dropped) for forward compat.
  
  Selfie JPEGs themselves are STILL valuable and STILL passed to the LLM call (`runSingleStackShot` in `geminiAI.ts`) as few-shot reference images. Lior + Eyal don't lose any selfies. The DB column `chip_values.selfie_base64` is intact; only `selfie_dominant_hex` is now deprecated/null.
  
  Lesson promoted to LESSONS.md: "verify-against-real-data before claiming fixed" — when shipping a heuristic that depends on a numeric threshold, compute that threshold against the user's actual stored data BEFORE shipping. v5.60.13 shipped a sat<0.15 threshold without checking that Lior's stored Red/Blue hexes had sat=0.18, and the user caught the resulting fiasco minutes later.
- **Working tree clean** as of v5.61.0 merge. All parallel-agent work is now on `origin/main`.

## Open follow-ups

- **Verify v5.61.0 lands cleanly on next weekend's game**: the roster-wipe fix is the real test. Two layers of defense (TS scoped upsert + DB trigger) should prevent recurrence, but only a real game with multiple devices in play exercises the stale-tab path that triggered it the last 3 weekends.
- **Verify v5.60.14 chip-counting fix for Lior**: the displayColor-matching change is purely runtime-side. Counts should now route to the correct chip-color rows. If still misbehaving, failure mode is now in the LLM count itself or stack region detection.
- **One selfie worth retaking**: Lior's Black chip selfie photographed as grey/silver (under-exposed). Suggested he retake it with better lighting; other 5 selfies are fine to keep as LLM few-shot references.
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

- **v5.61.1** — vote_change push-only + email-log service-role fix. Migration 079 drops `auth.uid() is null` guard from `log_email_send`. Baseline resynced 86→195.
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
