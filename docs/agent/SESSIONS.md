# SESSIONS — Work Journal

> **What this is**: Append-only chronological log of agent sessions. Newest at the top. One entry per chat that touched code or made a meaningful decision. Skip drive-by tweaks (typo fixes, single-line patches) unless they revealed something worth remembering.
>
> **Format**: Date, what was asked, what was done, what was learned, what's next. Keep entries tight — bullets, not essays.

---

## 2026-05-08 — Home/schedule UX polish + new-group teaser + activity log accuracy (v5.45.0)

**Asked**: A long iterative polish session against the home dashboard, the schedule card, the schedule tab empty state, and the settings activity log. Multiple discrete bugs surfaced via DOM dumps from an established group AND a brand-new test group:
- Activity log session card showed "⏱ < 1 דק׳" forever for a parked user, even after 6+ minutes on the same screen.
- "New Game" chip kept appearing in activity log though `/new-game` is now functionally "Home" (user explicitly: forward-fix only, do NOT backfill old rows).
- May 7 confirmed poll lingered as "ערב פוקר נקבע" on home dashboard hours after the game completed.
- Empty schedule card was a dead "🗓 אין הצבעה פעילה לחצו לצפייה בלוח הזמנים" — uninviting.
- Then: redundant subtitle, double calendar icon, wrong navigation (admin → create-poll modal instead of schedule tab), "מי בפנים?" in wrong slot, awkward "לוח הזמנים" wording.
- "👀 צפייה בלבד" card on member home was bureaucratic noise, especially in a fresh group.
- Monthly leaderboard in fresh group said "אין עדיין מספיק משחקים" — wrong, there are ZERO not "not enough".
- After the leaderboard fix, fresh-group home was nearly empty — needed a real onboarding teaser.

**Did**:
- **Activity log live duration** (`activityLogger.ts` + `SettingsScreen.tsx`): dropped the `screensChanged` early-return guard that prevented `session_duration` updates for parked users, exported `getCurrentSessionTimestamp()`, added a 60s ticker on the Activity tab, and switched the displayed duration to `Math.max(storedMin, liveMin)` for the viewer's own session (matched by `deviceId` + `currentSessionTimestamp`). Killed the 2 unused-symbol TS errors that were lingering on `main`.
- **Forward-only "New Game" → "Home" rename**: changed `ROUTE_NAMES['/new-game']` to `'Home'` so new entries are correct; old rows age out naturally per user's explicit instruction.
- **Stale confirmed-poll on home**: reverted an interim 4h display hack, made `!confirmedGameId` the single source of truth, added an admin-only self-heal `useEffect` in `HomeDashboard` that backfills `confirmedGameId` for orphan polls by matching against completed games (±6h) using `linkPollToGame`, and proactively auto-links in `NewGameScreen.startGameWithForecast` when the regular New Game flow creates a game without going through the poll's "Start Scheduled Game" button. `inFlightLinksRef` dedupes the brief window before realtime cache updates.
- **Schedule card empty state copy**: rewrote `home.schedule.emptyTitle` / `emptyHelper` HE+EN to a forward-looking "מי בפנים לערב הבא?" / "ההצבעה הבאה תיפתח בקרוב · לחצו לצפייה בהצבעות" pattern; dropped the `recentPastPoll` prop + 5 stale translation keys that were referencing the removed "yesterday/days ago" subtitle. Removed the redundant 🗓 emoji (HomeCard already renders the icon). Fixed `goSchedule` to always navigate to `/settings?tab=schedule` (no more accidental admin→create-poll-modal jump).
- **Schedule tab empty state**: rebuilt to show three states (auto-create ON → "next poll opens at <day> <date> <time>"; OFF + has history → "no active poll right now"; brand-new → original onboarding explainer). Added `computeNextScheduledTrigger` forward walker. Empty state now renders whenever there's no active poll, not only when the entire history is empty.
- **Linked-game-completed → archive**: `shouldArchive` now also takes `completedGameIds` and archives any poll whose `confirmedGameId` lives in that set. Cleans up polls that resolved via an early game with future-dated alternatives still on the calendar.
- **Monthly leaderboard fixes** (`HomeDashboard.LeaderboardCard`): copy `אין עדיין מספיק משחקים החודש` → `אין עדיין משחקים החודש` (plus EN equivalent — drop the misleading "not enough" threshold). Hide the entire card when zero completed games exist (brand-new group).
- **New-group home teaser** (`NewGroupTeaserCard` in `HomeDashboard`): blue-accent HomeCard rendered after `ScheduleCard` when no completed games exist anywhere in the group. Body lists 4 feature previews (🏆 / 📊 / 🏅 / 📈) so a fresh-group landing page actually conveys what the app does. Visible to all roles. Disappears the instant the group's first game completes.
- **Removed redundant member-only "view only" card** from `NewGameScreen` and its 2 translation keys — the dashboard teaser supersedes it for all roles.
- **Super-admin observer foundation surfaced**: `App.tsx` PermissionContext now exposes `isSuperAdmin` / `allGroups` / `isObservingNonMember`, `useSupabaseAuth` initializes `allGroups: []` in the signed-out state. This kills the 9 pre-existing TS errors flagged in the previous CONTEXT.md.
- Bumped to v5.45.0, 6-bullet changelog. Pushed to `main`.

**Learned**:
- The user is sensitive to Hebrew quality. First pass at "ערב הפוקר האחרון" subtitle copy was grammatically awkward and got the "your Hebrew is not good — improve it" pushback. Lesson: when writing user-facing Hebrew teaser copy, default to checking dual forms ("שלשום"), avoid bare prepositions ("ל" without infinitive), and prefer warm forward-looking verbs over formal/scheduling words. Also: don't repeat info already shown in adjacent cards (e.g. last-game subtitle was redundant with `LastGameCard`).
- Iterative DOM-dump-driven polish is incredibly efficient for catching wording/UX issues — the user pastes the rendered HTML, you see exactly what they see, fix it, they paste the next one. Faster than asking "what's the issue?".
- When a fix makes the screen LESS informative (e.g. hiding leaderboard for fresh groups), check what's left on screen before claiming done — a near-empty home page is a regression even if each individual card is technically correct. The "what's coming" teaser idea came from this.
- "Forward-only" is a recurring user preference for cleanups: never backfill rows, never auto-fix existing data, just ensure new data is correct. Old labels age out organically. (Already in `LESSONS.md`? Worth a check — if it shows up again it might warrant a rule promotion.)
- `StrReplace` reliability dropped a few times mid-session — likely racing with HMR / editor auto-save. Mitigation: re-read the affected section before retrying, and use larger surrounding context for uniqueness.

**Next**:
- After push, ask Lior to refresh and verify: (a) leaderboard card hidden in fresh group, (b) new-group teaser appears with the 4 feature previews, (c) activity log session minutes advance live without leaving the page, (d) schedule tab empty state shows the correct text for his auto-create config.
- Watch the "schedule auto-archive on game completion" rule on Lior's actual data — first time the rule fires in production it may surface a poll that he didn't expect to disappear.

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
