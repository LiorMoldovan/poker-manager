# CONTEXT

> 30-second orientation. Refresh in place. Bullets only, no paragraphs.
> Last refreshed: 2026-05-15 (later)

## Now

- **`origin/main`**: v5.62.4 — chip-count telemetry: every photo attempt now logs a row to `public.chip_count_debug` (raw response, salvage strategy, http status, image bytes, chip colors, duration). Agent reads via Supabase MCP → no more "the user can't tell us what Gemini returned" blindness. Built on top of v5.62.3's 5-strategy salvager.
- **Working tree**: NOT clean — another agent is mid-flight on "chip-entry total mode" (new file `supabase/080-chip-entry-total-mode.sql`, edits across `ChipEntryScreen`, `HomeDashboard`, `Statistics`, `Game(Summary|Details)`, `storage`, `supabaseCache`, `translations`, `sharing`, `index.css`). Don't stage those — not mine.
- **Recently-applied SQL**: 070–078, **081** (chip_count_debug) — don't re-apply. `080-*` exists locally, NOT applied.

## Open follow-ups

- **Waiting on Lior's v5.62.4 test**: he agreed to "try it again" if I could track results myself. v5.62.4 logs every photo attempt to `chip_count_debug` with raw response + salvage_strategy. Agent's diagnosis query after his test:
  ```sql
  SELECT created_at, model, attempt_index, context, outcome, salvage_strategy,
         http_status, image_byte_count, duration_ms,
         left(error_message, 120) AS err,
         left(raw_response_excerpt, 400) AS raw,
         final_counts
  FROM public.chip_count_debug
  ORDER BY created_at DESC LIMIT 20;
  ```
  Context is auto-detected: `expectedTotalValue > 0` → 'live-game', else → 'settings-test'.
- **`window.__lastChipRaw`** is set on every photo attempt (model, raw, at) for any reachable DevTools session.
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
