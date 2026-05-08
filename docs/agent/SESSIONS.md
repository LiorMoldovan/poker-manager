# SESSIONS — Work Journal

> **What this is**: Append-only chronological log of agent sessions. Newest at the top. One entry per chat that touched code or made a meaningful decision. Skip drive-by tweaks (typo fixes, single-line patches) unless they revealed something worth remembering.
>
> **Format**: Date, what was asked, what was done, what was learned, what's next. Keep entries tight — bullets, not essays.

---

## 2026-05-08 — Permanent fix for completed-game roster wipes (v5.44.6)

**Asked**: For the second weekend in a row, the just-completed game shows in History/Statistics for a few minutes and then "loses" all its players (card shows `0 שחקנים • 0 קניות`, the games row stays). User explicitly: "this is in production, I can't login after every game to fix deletion issues — solve it once and for all."

**Diagnosis (via Supabase MCP, no asking the user to run queries)**:
- `games` row for the May 7 "אייל" game intact (`status: completed`); 0 `game_players` rows. Auto game-end backup taken 6h after completion still had all 7 player rows. Wipe happened ~30 min before the user noticed, long after game completion.
- Root cause class: same shape as the 2026-05-03 incident that triggered migration 043. The v5.34.2 client patches + 043 bulk-delete guard close the BULK-shaped wipe path, but a stale or misbehaving client doing **iterative single-row** deletes slips right past 043 (each statement is a "1-row direct DELETE" and the count check `affected > 1` doesn't catch it). RLS policy `gp_delete` lets any group member delete any `game_players` row in the group — no completion-status guard.

**Did**:
- Authored & applied **migration 050** (`block_completed_game_player_delete`): BEFORE DELETE row-level trigger on `game_players` that rejects any direct DELETE when the parent `games.status = 'completed'`. Cascade allowed via the row-level `pg_trigger_depth() > 1` exit.
- While testing 050, discovered migration 043's cascade exemption was BROKEN: `pg_trigger_depth()` returns 2 in BEFORE-ROW context but only **1** in AFTER-STATEMENT context during cascade — empirically verified with a `_depth_log` test on real triggers. Meaning `deleteGame` for any multi-player game has been silently rejected by 043 since it shipped on May 3. The user just hasn't tried to delete a multi-player game in 5 days.
- Authored & applied **migration 051** (`fix_bulk_delete_cascade_detection`): replaces 043's `pg_trigger_depth() > 1` cascade probe (which doesn't work for AFTER-STATEMENT) with a `game_players`-specific parent-existence check. If every OLD row's parent `games` row is gone, this is a cascade and we exit early; otherwise the affected-count check stays as before. For the other tables (`games`, `players`) the function falls through to the original bulk-block — they have no inbound FKs so no cascade context to detect.
- Restored the 7 missing player rows for the May 7 game from backup `2bad11f4-…` (verified zero-sum: `+4.20 -56.55 -38.7 +313.95 -87.3 +59.85 -195.45 = 0.00`).
- Wrote a 5-test sandbox harness (cascade-on-completed / cascade-on-live / single-on-live / single-on-completed / bulk-on-live) and ran it inside `BEGIN…ROLLBACK` so no real data was touched. All 5 cases pass.
- Bumped to v5.44.6, 4-bullet changelog. NOT committing the unrelated WIP files (live wall-clock session-duration in `SettingsScreen.tsx` + `activityLogger.ts`) — those are someone else's in-progress work and have 2 lingering TS errors (`getDeviceId` / `currentSessionTs` unused).

**Learned**:
- `pg_trigger_depth()` is the wrong tool for cascade detection in statement-level triggers. The PG docs technically say "nesting level of triggers" but RI cascades don't manifest as a depth-incrementing trigger frame in AFTER-STATEMENT context. Use parent-existence check (or a session-config flag set by an RPC) instead — see `LESSONS.md` entry from this session.
- Migration 043's self-verification block (`-- a) Confirm the guard rejects a bulk delete (this should ERROR …)`) only tested the "block bulk" path. It didn't test the "allow cascade" path. If it had, the cascade-detection bug would have been caught on day one. Adding a sandbox cascade-test pattern to my own working harness pays off when the existing migration's tests have blind spots.
- The user's diagnostic instinct is sharp ("this is the second week in a row, solve it once and for all") and they hate "fix-then-fix-the-fix" loops. Worth a structural fix (DB invariant) rather than another client-side patch.

**Next**:
- After push, ask Lior to verify the May 7 game card now shows "7 שחקנים" with the correct buy-in count.
- The unrelated WIP in `SettingsScreen.tsx` + `activityLogger.ts` should be picked up in a fresh chat — it's tantalizingly close to compiling but still has 2 unused-symbol errors.
- The 9 pre-existing TS errors in `GroupSwitcher.tsx` + `useSupabaseAuth.ts` (super-admin observer mode foundation, v5.44.2) shipped to production. Worth verifying they don't manifest as a runtime crash, and either finishing the AuthState shape or rolling back the foundation.

---

## 2026-05-07 — Bootstrap agent memory system

**Asked**: Set up a lightweight knowledge-retention system so future agents (and Claude in the next chat) don't waste time re-discovering things. Lean by design.

**Did**:
- Created `docs/agent/` with `CONTEXT.md`, `SESSIONS.md` (this file), `LESSONS.md`.
- Created `.cursor/rules/agent-memory.mdc` (always-applied) defining strict start/end rituals.
- Captured current in-flight work in `CONTEXT.md`: push-subscriber dedup fix migrating from `playerName` to `user_id` (uncommitted in `supabaseCache.ts` + `SettingsScreen.tsx`).
- Did **not** touch `AGENTS.md` — the new rule auto-loads, no need to pollute.
- Did **not** pre-populate `LESSONS.md` — lessons must be earned through real incidents per the explicit ask.

**Learned**: Project already has heavy standing documentation (`AGENTS.md` + 13 `.cursor/rules/*.mdc`). The genuine gap was *between-session memory*, not standards. Three files is the right number for a solo project — `CONTEXT` (now), `SESSIONS` (history), `LESSONS` (incidents). A `DECISIONS.md` would be overkill since the changelog and commit messages already capture decisions implicitly.

**Audit follow-up (same day)**: Lior asked whether I'd actually read all existing rules before designing the new system. I'd read 5 of 13 (the always-applied ones already in context) plus `AGENTS.md`. Read the remaining 8: 7 are pure domain rules with no impact on the meta-system; 1 (`schedule-poll-dates.mdc`) is a perfect canonical example of the lesson→rule promotion path I'd described abstractly. Added that as a reference in `LESSONS.md` and logged the audit miss as the first real entry.

**Next**:
- Finish the push-subscriber dedup work (the WIP in `CONTEXT.md`) — verify with `tsc`, lint, and a manual peek at Settings → Push.
- When the next chat starts, the agent should automatically read these three files before any tool call.
