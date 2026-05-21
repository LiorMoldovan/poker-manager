# CONTEXT

> 30-second orientation. Refresh in place. Bullets only, no paragraphs.
> Last refreshed: 2026-05-21 (post mig 088 — completed-game immutability + audit log)

## Now

- **`origin/main`**: v6.8.3 deployed. **Working version locally: v6.8.4** (uncommitted — awaiting Lior's push approval).
- **v6.8.4** in flight: **three-layer fix for the recurring weekend roster wipes**.
  - **Layer 1 — DB (mig 088, ALREADY APPLIED)**: `games.completed_at TIMESTAMPTZ` set on first `X → completed`, never cleared (backfilled 242 games). `block_completed_game_player_delete` now gates on `completed_at IS NOT NULL` not `status = 'completed'`. Immutability is time-monotonic — surviving reopen windows. New `game_audit_log` table + 3 triggers capture every STATUS_UPDATE, every GAME_PLAYER_DELETE_ATTEMPT (allowed/blocked), every REOPEN_RPC. Sandbox: 10/10 pass.
  - **Layer 2 — client logic**: `updateGameStatus` refuses to downgrade a completed game. The silent `reopen_completed_game` RPC call from this code path is GONE. Console-warns and no-ops.
  - **Layer 3 — UI**: "Reopen Chip Entry" button + handler + `showReopenConfirm` state + reopenChips/reopenWarning translations all DELETED from GameSummaryScreen. LiveGameScreen now redirects to `/game-summary/<id>` if loaded for a completed game (closes the stale-cache LiveGameScreen → "End Game" → updateGameStatus attack path that was the actual May 21 vector — חרדון couldn't even see the Reopen button because it's gated by `cameFromChipEntry`).
  - The `reopen_completed_game` RPC stays server-side, sealed, super-admin-SQL-only, audit-logged. If a botched chip entry ever needs fixing → ask agent → manual SQL with audit trail.
- **May 20 game restored**: id `8b02cfcb-…`, 8 game_players back from the 02:39 IL game-end backup, profit_sum=0.00. Status remains `completed`, completed_at now set.
- **Recent deployed versions on main** (just before today's hotfix):
  - v6.8.0–v6.8.3: stats period dropdowns unified across tables, share-screenshot subtitles, dark popovers, polls + new game period chip overlays. None DB-touching.
  - v6.4.0–v6.4.2 (2026-05-16): chip-count correction loop (mig 085), NumericInput sweep, schedule release-pin (mig 084), per-date exclude (mig 086), Gemini fallback chain cleanup, PollCard refactor.
- **Working tree** (pre-commit): `src/version.ts` (6.8.3 → 6.8.4), `supabase/088-*.sql` (new), `docs/agent/*.md` (this).
- **Recently-applied SQL**: 080–087 + **088 (today)** all applied to live DB. Don't re-apply.

## Open follow-ups

- **Awaiting Lior's push approval for v6.8.4** (mig 088 + completed_at + audit log). Migration ALREADY applied to live DB via Management API — git commit is purely for source-of-truth + Vercel deploy + version label in Settings → About.
- **Game-wipe forensics for next time** (audit log queries Lior or I can run):
  ```sql
  -- Who reopened games this week
  SELECT to_char(occurred_at AT TIME ZONE 'Asia/Jerusalem','MM-DD HH24:MI') AS at_il,
         actor_email, game_id, notes
  FROM game_audit_log
  WHERE op = 'REOPEN_RPC' AND occurred_at >= now() - interval '7 days'
  ORDER BY occurred_at DESC;

  -- Every blocked DELETE attempt + who did it + why blocked
  SELECT to_char(occurred_at AT TIME ZONE 'Asia/Jerusalem','MM-DD HH24:MI:SS') AS at_il,
         actor_id, game_id, before_value->>'player_name' AS player,
         before_value->>'parent_status' AS parent_status,
         before_value->>'parent_completed_at' AS parent_completed_at,
         notes, flags
  FROM game_audit_log
  WHERE op = 'GAME_PLAYER_DELETE_ATTEMPT' AND occurred_at >= now() - interval '7 days'
  ORDER BY occurred_at DESC;

  -- Every status change including reopens
  SELECT to_char(occurred_at AT TIME ZONE 'Asia/Jerusalem','MM-DD HH24:MI:SS') AS at_il,
         actor_id, game_id, before_value->>'status' AS from_status, after_value->>'status' AS to_status,
         flags
  FROM game_audit_log WHERE op = 'STATUS_UPDATE'
  ORDER BY occurred_at DESC LIMIT 50;
  ```
- **Lior testing v6.4.1.** Six samples in the 16:49–17:10 window confirmed the diagnosis: 4 of 6 fell back to `gemini-2.5-flash` (all returned "10 everywhere" — fixed in v6.4.1 by dropping the model). The 2 that hit `gemini-3-flash-preview` directly: 17:04 diff=4 (good), 17:08 diff=19 (tall-stack cap at 10 — addressed by v6.4.1 prompt hardening). Awaiting next batch to confirm the retry + prompt changes actually move the needle. Diagnosis query unchanged from before.
- **Vision sanity check is live**: agent can pull any `chip_count_corrections` photo via chunked `execute_sql` (substring photo_base64 in 120000-char chunks, regex-extract `\\"cN\\":\\"...\\"` per chunk, concat, base64-decode, Read as image). Validated against Lior's 17:10 photo — counted exactly matched truth. Use this when in doubt about whether a model is actually counting or just hallucinating.
- **Agent's diagnosis query** when Lior is done with the batch:
  ```sql
  SELECT id, created_at AT TIME ZONE 'Asia/Jerusalem' AS at_il,
         app_version, model, selfies_attached,
         ai_counts, truth_counts, total_diff,
         length(photo_base64) AS photo_bytes
  FROM public.chip_count_corrections
  ORDER BY created_at DESC LIMIT 20;
  ```
  Plus full photo via `SELECT photo_base64 FROM ... WHERE id = ...` for visual inspection.
- **Companion telemetry query** for the same window:
  ```sql
  SELECT created_at AT TIME ZONE 'Asia/Jerusalem' AS at_il,
         model, attempt_index, outcome, http_status, salvage_strategy,
         duration_ms, left(error_message, 200) AS err, final_counts
  FROM public.chip_count_debug
  ORDER BY created_at DESC LIMIT 20;
  ```
  Context auto-detection: `expectedTotalValue > 0` → 'live-game', else → 'settings-test'.
- **`window.__lastChipRaw`** is set on every photo attempt (model, raw, at) for any reachable DevTools session.
- **Free-tier quota ceiling**: 20 RPD per model per project. Shared across ALL Gemini features (forecast, summary, chronicles, graph insights, trivia, photo count). Realistic photo-test budget on a busy day: 5–10 photos before something else trips. To lift: link a billing account → Tier 1.
- **Live-game confidence gate**: PhotoCaptureModal's `LOW_CONFIDENCE_THRESHOLD = 50` now actually fires (used to be dead because every photo was 80%). May surface review screens that didn't appear before — flag if Lior reports friction during a real game.
- v5.61.0 roster-wipe fix needs a real weekend game with multiple devices to validate.
- v5.60.14 `displayColor`-matching chip-counting fix awaits Lior's re-test.
- Lior's Black chip selfie photographed as grey/silver (under-exposed). He should retake.
- Local dev shows zero admin controls in LiveGameScreen (likely wrong-account-on-localhost; pending Lior's confirmation).
- "Mini table with more details" home-card memory — needs a screenshot to pin down which view. Deferred.

## Project-specific gotchas not in `AGENTS.md` or rules

- **Forward-only cleanup is Lior's default**: when fixing labels/routes/displayed fields, change the WRITE path so new entries are correct and let old rows age out. No backfills, no auto-fix of historical rows.
- **Hebrew copy needs care**: dual forms ("שלשום"), avoid bare prepositions ("ל" without infinitive), prefer warm forward-looking verbs over formal scheduling words. Simple + inviting beats technically-correct-but-stiff.
- **Repo dev artifacts** (don't delete unprompted): `temp_prompt.txt`, `pool-full-dump.txt`, `*.cjs` validation scripts in root.
- **Sensitive user data**: `Poker results.xlsx`, `poker-export-*.xlsx` — never commit modifications.
- **Selfie chip color extraction is retired** (v5.60.14): `chip_values.selfie_dominant_hex` is deprecated/NULL. The selfie JPEG is still used as an LLM few-shot reference; chip mapping uses `display_color` directly.
- **Chip-count feedback loop is fully retired** (v5.62.2): `chip_count_feedback` table + `chip-count-feedback-photos` storage bucket + `chip_count_tuning_overrides` table all still exist in Supabase but nothing reads or writes them. Safe to drop later if we need the schema slot.
- **Chip-count whole-photo prompt** (v5.62.3): uses worked example numbers (5/3/0/0…) not `<integer>` placeholders. Some free Gemini variants echoed `<integer>` back verbatim as a string and failed schema validation.
- **Chip-count telemetry** (v5.62.4): `public.chip_count_debug` table receives a fire-and-forget INSERT for every photo attempt. RLS pattern mirrors `chip_count_feedback` (member INSERT, admin/owner SELECT, super-admin SELECT/DELETE). Logs raw_response_excerpt (4KB cap), final_counts JSONB, salvage_strategy 1..5, http_status, image_byte_count, chip_colors_configured, selfies_attached, duration_ms. **NO photo bytes, no API keys.**
- **Chip-count corrections** (v6.3.0): `public.chip_count_corrections` IS where photo bytes live (base64 TEXT). Tap "save correct count" on the photo test card writes the row. Same RLS pattern. Don't INSERT from the live-game flow (no surface for it).
- **AI per-color confidence** (v6.3.1): the response now includes an optional `confidence: INTEGER` per item. Salvage strategies 4 and 5 return `confidence: null` (truncated/plain-text formats can't carry it). Consumers fall back to `FALLBACK_CONFIDENCE = 60` when null.
- **Chip-count model chain is now single-model** (v6.4.1): `CHIP_COUNT_MODELS = [gemini-3-flash-preview]`, retried up to 2 times total (initial + 1 retry, 800ms backoff). Retry skipped on `quotaExceeded` / `cancelled`. If the primary genuinely 504s twice in a row, the user gets a clean error — never "10 everywhere" fake data. New `quotaExceeded` error code detected by HTTP 429 OR error body matching `/quota|RESOURCE_EXHAUSTED|rate.?limit/i`. `ChipCountDebugOutcome` and `PhotoChipCountErrorCode` both have the new value.
- **Schema example numbers matter** (v6.4.1): the `exampleCounts` block in the prompt was carrying `5/3/0/0/0/0` which implicitly biased the model toward small counts. Now uses `7/14/0/17/3/0` so the schema-example shows a 14 and a 17 before the model produces its own answer. Classic LLM few-shot bias control — don't revert without re-validating tall-stack accuracy.

## Spot-check queries when debugging

```sql
-- Chip corrections (Lior's ground truth + AI's guess)
SELECT created_at, model, total_diff, ai_counts, truth_counts
FROM chip_count_corrections ORDER BY created_at DESC LIMIT 20;

-- Chip-count attempt telemetry (every Gemini call)
SELECT created_at, model, outcome, http_status, final_counts
FROM chip_count_debug ORDER BY created_at DESC LIMIT 20;

-- Notification health (all should be done/attempts=1)
SELECT id, kind, status, attempts, last_error FROM notification_jobs
ORDER BY created_at DESC LIMIT 10;
```
