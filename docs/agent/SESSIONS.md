# SESSIONS

> Chronological journal of agent sessions, newest first. Append at the top.
> Tight bullets: asked / did / learned / next. Skip drive-by tweaks.

---

## 2026-05-15 (later) — v5.62.4 chip-count telemetry table

**Asked**: After v5.62.3 ship, Lior pushed back: "will you be able to track the results and fix yourself post that? for now seems you just guess without knowing the real issues." Wanted server-side visibility so the agent can read every attempt directly via the MCP, not just whatever the user screenshots.

**Did**:
- Authored `supabase/081-chip-count-debug.sql` (idempotent). Table columns: id, group_id, user_id, created_at, app_version, model, attempt_index, total_models, context, outcome, salvage_strategy, error_message, raw_response_excerpt (4KB cap), raw_response_byte_count, final_counts JSONB, image_byte_count, chip_colors_configured TEXT[], selfies_attached, http_status, duration_ms. RLS pattern mirrors `chip_count_feedback`: members can INSERT into their group, group admins + owner + super admins can SELECT, super admin can DELETE.
- Applied via Supabase MCP `apply_migration`. Verified table structure + super-admin SELECT works from MCP.
- New `src/utils/chipCountDebug.ts` — `logChipCountAttempt(row)` fire-and-forget helper. Swallows ALL errors (RLS denial, missing groupId, network, anything) so a logger bug never blocks the photo flow.
- Hooked into `runWholePhotoShot` via a `logAttempt(outcome, fields)` closure. Every exit path (network err, http err, response.json parse err, salvage success, salvage failure) calls it exactly once.
- `extractChipCounts` now returns `{ counts, strategy: 1..5 }` so we can record WHICH strategy salvaged each response — over time we'll see which strategies are dead weight.
- Context auto-detection in `countChipsFromPhoto`: `expectedTotalValue > 0` → 'live-game', else → 'settings-test'. Avoided entangling with other-agent WIP in ChipEntryScreen/SettingsScreen by detecting from existing args instead of threading a new prop through both screens.
- Bumped to v5.62.4. tsc + ReadLints clean.

**Learned**:
- When an existing arg (`expectedTotalValue`) already discriminates two call sites perfectly, that's a free context tag — don't add a new prop just to label things.
- Diff lesson reinforced from `git-stash` failure: rather than fighting `git add -p` to extract two single-line additions from an other-agent's mixed working tree, find an in-code path that doesn't need the entangled edit at all.

**Next**:
- Lior takes 1–2 test photos.
- Agent runs the diagnosis query in CONTEXT.md, reports findings, fixes whatever the rows actually show.
- If the rows show successful salvage (strategy 4/5) and not a parseFailed: the v5.62.3 salvager is doing its job and the bug is elsewhere (wrong colors, wrong counts).
- If rows show `outcome='parseFailed'` with raw_response_excerpt: now the agent can SEE the response and tighten the salvager OR rewrite the prompt for the specific shape.
- If rows show `outcome='httpError'` with http_status 4xx/5xx: it was never a parse problem — it's a model/quota/key issue.

---

## 2026-05-15 (late) — v5.62.3 chip-count parser hardening

**Asked**: Lior merged v5.62.2 and got "exactly the same exception as before" on 3 different photos (even single-stack, single-color shots). Wanted it fixed, not investigated through questions.

**Did**:
- Diagnosed: v5.62.2 didn't touch parser code at all (only removed dead feedback UI). The "same exception" was the v5.62.1 hotfix not actually covering Lior's failure mode — markdown-fence-strip alone was insufficient. Static verification on the deployed bundle had confirmed the code path existed, but no one had run it against a real Gemini response.
- Shipped v5.62.3 with three things:
  1. `extractChipCounts(raw, validColors)` — 5-strategy salvager in `src/utils/geminiAI.ts`: raw JSON.parse → markdown fence strip → balanced `{...}` slice → regex pair scan (handles broken/truncated JSON + reverse key order) → plain-text scan (color-name + digit, restricted to valid color set).
  2. Simplified the chip-count prompt — replaced `<integer>` literal placeholder with worked example digits (5/3/0/0…); some free Gemini variants were echoing `<integer>` back verbatim.
  3. Raw response now surfaces in the photo-error UI: localized headline + monospaced LTR scrollable block (max-h 180px) with the first 250 chars of what Gemini actually returned. Also stashed on `window.__lastChipRaw` for DevTools.
- Validated salvager locally against 15 plausible response shapes (JSON, markdown, prose+JSON, truncated, reversed keys, uppercase, plain text, refusal, empty array, etc.) — all 12 recoverable cases salvaged; 3 unrecoverable cases (empty/refusal/empty array) return null so the caller surfaces the raw response.
- Committed only my 3 files (geminiAI.ts, PhotoCaptureModal.tsx, version.ts) — another agent has WIP across ~12 files for "chip entry total mode" (`supabase/080-chip-entry-total-mode.sql`), left untouched.

**Learned**:
- "Deployed bundle contains the hotfix code" ≠ "hotfix works against real inputs". A static grep on the chunk is a sanity check, not validation. Promoted to LESSONS.md.
- For parsers/recovery paths, write a standalone node `.mjs` test that exercises each strategy against plausible failure shapes BEFORE shipping. Cheap and would have caught the v5.62.1 gap.
- Diagnostic visibility in the UI (raw response right there in the error toast) beats diagnostic visibility in logs the user can't reach. Mobile users have no F12.

**Next**:
- Lior tests v5.62.3 once Vercel finishes deploying (~1 min). Two outcomes:
  - Photo flow returns numbers (parser salvaged the response) → done.
  - Still errors, but now we see the raw response in the error panel → fix the parser for the specific shape we finally see, OR rewrite the prompt if Gemini is refusing/safety-blocking.
- Other agent's "chip entry total mode" WIP still in tree. Don't auto-merge.

---
