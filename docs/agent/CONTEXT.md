# CONTEXT

> 30-second orientation. Refresh in place. Bullets only, no paragraphs.
> Last refreshed: 2026-05-15

## Now

- **`origin/main`**: v5.61.0 — weekend roster-wipe permanent fix (scoped GAMES upsert + DB trigger blocking `completed → *` status downgrade) + TTS pool fire-and-forget.
- **Working tree**: clean.
- **Recently-applied SQL**: 070–078 — don't re-apply.

## Open follow-ups

- v5.61.0 roster-wipe fix needs a real weekend game with multiple devices to validate (the path the bug took the last 3 weekends).
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

## Spot-check queries when debugging

```sql
-- Chip feedback (post-photo-count test card submissions)
SELECT created_at, player_name, overall_confidence, total_stacks, correct_stacks
FROM chip_count_feedback ORDER BY created_at DESC LIMIT 20;

-- Notification health (all should be done/attempts=1)
SELECT id, kind, status, attempts, last_error FROM notification_jobs
ORDER BY created_at DESC LIMIT 10;
```
