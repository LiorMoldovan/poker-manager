# CONTEXT

> 30-second orientation. Refresh in place. Bullets only, no paragraphs.
> Last refreshed: 2026-05-15 (post v5.62.7 push)

## Now

- **`origin/main`**: v5.62.7 — hotfix: iOS Safari vertical touch scroll was dead since v5.62.6 because of `overflow-x: hidden` on `html, body`. Switched to `overflow-x: clip`. Confirmed working on Lior's iPhone. See new LESSON entry — any `html`/`body`/`*`/`#root` CSS rule needs real-device iPhone test before merge.
- v5.62.6 — merged the other agent's quick-total chip entry mode (migration 080) on top of v5.62.5's thinking-budget fix. Cumulative chip-count stack: 5-strategy salvager (v5.62.3) + telemetry table (v5.62.4) + thinkingBudget=0 + maxOutputTokens=2048 (v5.62.5) + per-player color/total mode (v5.62.6).
- **Working tree**: clean except agent-memory edits (this file + SESSIONS.md, both safe to leave uncommitted).
- **Recently-applied SQL**: 070–078, **080** (game_players.entry_mode + total_chip_count + settings.chip_entry_default_mode), **081** (chip_count_debug). All applied via MCP. Don't re-apply.
- **Pending validation: Lior's photo test BLOCKED on Gemini free-tier quota.** Live error in `chip_count_debug` confirmed `RESOURCE_EXHAUSTED` / `quotaValue: 20` / `GenerateRequestsPerDayPerProjectPerModel-FreeTier`. v5.62.5's truncation fix was never actually exercised because the API rejected every request with 429 before it ran. Quota resets at midnight Pacific = ~10:00 Sat Israel time.

## Open follow-ups

- **After Lior's quota resets** (~10:00 Sat Israel): single fresh photo test to verify v5.62.5's truncation fix actually works. Agent's diagnosis query (already in scripts memory):
  ```sql
  SELECT created_at, app_version, model, attempt_index, context, outcome,
         salvage_strategy, http_status, image_byte_count, duration_ms,
         left(error_message, 200) AS err,
         left(raw_response_excerpt, 400) AS raw,
         final_counts
  FROM public.chip_count_debug
  ORDER BY created_at DESC LIMIT 20;
  ```
  Context auto-detection (v5.62.6+): `expectedTotalValue > 0` → 'live-game', else → 'settings-test'.
  Success criterion: `outcome='success'`, `salvage_strategy=1`, no truncation in raw.
- **`window.__lastChipRaw`** is set on every photo attempt (model, raw, at) for any reachable DevTools session.
- **Free-tier quota ceiling**: 20 RPD per model. Shared across ALL Gemini features (forecast, summary, chronicles, graph insights, trivia, photo count). Realistic photo budget on a game night with everything firing: 5–10 photos. To lift: link a billing account → Tier 1.
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

## Spot-check queries when debugging

```sql
-- Chip feedback (post-photo-count test card submissions)
SELECT created_at, player_name, overall_confidence, total_stacks, correct_stacks
FROM chip_count_feedback ORDER BY created_at DESC LIMIT 20;

-- Notification health (all should be done/attempts=1)
SELECT id, kind, status, attempts, last_error FROM notification_jobs
ORDER BY created_at DESC LIMIT 10;
```
