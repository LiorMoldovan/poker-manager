# CONTEXT

> 30-second orientation. Refresh in place. Bullets only, no paragraphs.
> Last refreshed: 2026-05-16 (post v6.4.2 push)

## Now

- **`origin/main`**: v6.4.2 — five commits today.
  - **v6.3.0**: chip-count correction loop on the photo test card. New `chip_count_corrections` table (mig 085) stores photo + AI's per-color counts + Lior's truth.
  - **v6.3.1**: hand-rolled `<input type="number">` → `NumericInput`. AI now self-rates per-color confidence (new optional `confidence: INTEGER` in the schema).
  - **v6.4.0**: merged 2 other agents' schedule work — release-pin (mig 084), per-date exclude (mig 086), expansion-clock-through-mid-pin (mig 086). Plus 6 more NumericInput swaps in ScheduleTab.tsx.
  - **v6.4.1**: chip-count: dropped `gemini-2.5-flash` from the fallback chain (it returned "10 for everything" — 4 of Lior's 6 test photos got hit by this). Primary `gemini-3-flash-preview` now retries once on transient 503/504/network. New `quotaExceeded` error code skips retry on 429. Prompt hardened against "default to 10" + schema example now uses varied numbers (7/14/0/17/3/0) instead of 5/3/0/0/0/0 to remove small-number bias. Vision-validated by me: I counted Lior's worst-case photo (17:10 all-10s disaster) and matched truth exactly — task IS solvable, problem was the fallback model lying.
  - **v6.4.2**: other-agent PollCard refactor — state badges (Locked / Leading / Disabled / FillPinned) moved to a dedicated banner row so the tile header doesn't wrap to 3 lines on narrow phones.
- v5.62.7 — earlier-today hotfix: iOS Safari vertical scroll was dead because `overflow-x: hidden` on `html,body`. Switched to `overflow-x: clip`. (See LESSONS.)
- **Working tree**: clean except agent-memory edits.
- **Recently-applied SQL**: 080–086 all applied. Don't re-apply. `085-chip-count-corrections.sql` (mine) and `085-schedule-exclude-date.sql` (other agent, local file `086-schedule-exclude-date.sql`) coexist in DB under different timestamped versions.

## Open follow-ups

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
