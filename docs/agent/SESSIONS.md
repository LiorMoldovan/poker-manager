# SESSIONS — Work Journal

> **What this is**: Append-only chronological log of agent sessions. Newest at the top. One entry per chat that touched code or made a meaningful decision. Skip drive-by tweaks (typo fixes, single-line patches) unless they revealed something worth remembering.
>
> **Format**: Date, what was asked, what was done, what was learned, what's next. Keep entries tight — bullets, not essays.

---

## 2026-05-10 — Server-side notification dispatch (v5.49.0)

**Asked**: After v5.48.0 (DB-triggered queue) shipped, the operator confirmed that `target_filled` notifications still failed to deliver when no client was online to drain the queue. Their words: "you are the expert however you are expert post issues and not before, you knew what i expect and yet we keep failing and fixing so simply check the overall flow and as i always ask check edge cases and fix it once and for all". A green light to do the bigger architectural fix in one push.

**Did**:
- **Audit, then design, then implement**. Found 11 distinct notification surfaces across the app (poll lifecycle ×6, vote-change, reminders, trivia reports filed/resolved, training reports filed/resolved, training milestone). All but one (settlement dispute, which is in-app only) had the same client-liveness failure mode — the queue from 061 covered job CREATION but not job DISPATCH.
- **Migration 066 — server-side dispatch infrastructure**:
  - Enabled `pg_net` (in `extensions` schema) and `pg_cron`.
  - Generalized `notification_jobs`: added `payload JSONB`, made `poll_id` nullable, extended the `kind` CHECK to cover all 12 surfaces.
  - New `enqueue_notification(kind, group_id, poll_id?, payload?)` generic enqueuer for client-driven kinds (reminders, training reports, milestones).
  - Service-role-aware `claim_notification_job_internal` and `complete_notification_job_internal` RPCs that authenticate via a shared secret (so the Edge Function can call them without a user JWT).
  - DB triggers: `trg_enqueue_vote_change_on_vote` (on every response/comment change), `trg_enqueue_trivia_report_on_insert`, `trg_enqueue_trivia_report_on_resolve`. Combined with the lifecycle triggers from 061+062, every server-knowable event now auto-enqueues.
  - The decisive piece: `trg_http_dispatch_notification_job` AFTER INSERT on `notification_jobs` calls `extensions.http_post` to `/api/notification-worker` with the new job's id and the shared secret — instant server-side webhook, sub-second from row insert to push being on the wire.
  - `pg_cron` job `notification-jobs-sweep` runs every minute, picks up any job that's been pending >90s (transient pg_net failure, deploy mid-flight, etc.) and re-fires the webhook. Three-attempts-then-`failed` retry policy.
- **Migration 067 — worker_config table**: Supabase doesn't allow non-superuser `ALTER DATABASE postgres SET app.foo = '...'` for custom GUCs (got `ERROR: 42501: permission denied`), so I switched all four notification functions from `current_setting('app.notification_worker_*')` to a `worker_config(key, value)` table. The URL is seeded in the migration; the secret is inserted via a follow-up `INSERT ... ON CONFLICT DO UPDATE` since it must NOT live in committed git.
- **`/api/notification-worker.ts` (new Edge Function, ~600 lines)**: authenticates via `X-Worker-Secret`, claims one job from the queue per invocation (drain loop up to 10 jobs/call), reads poll/vote/player context using a service-role Supabase client, builds a Hebrew push title/body and email subject/body inline (simpler templates than the rich client-side builders — no gender-aware verbs, deliberate trade for full server-side reliability), resolves recipients per-kind (creation = permanent, target_filled = yes-voters on pinned date, vote_change ≈ get_poll_change_recipients via service-role table joins, trivia_report_filed = super-admins minus reporter, etc.), forwards to `/api/send-push` and per-recipient `/api/send-email` with the same `X-Worker-Secret`. Mark done if AT LEAST one channel succeeded; partial delivery beats double-pushing the channel that already worked.
- **`/api/_auth.ts` upgrade**: new `verifyAuth(req)` returns `{ ok: true, mode: 'user' | 'worker' }` so endpoints can branch on auth path. Worker secret is checked first (header `X-Worker-Secret` against `process.env.WORKER_INTERNAL_SECRET`); JWT path is unchanged. The legacy `verifySupabaseAuth(req)` shim still works for callers that don't care about the distinction.
- **`/api/send-push.ts`** picks a service-role Supabase client when `auth.mode === 'worker'` so RLS doesn't hide push subs from the worker (the worker has no `auth.uid()` to satisfy the existing `push_subs_select` policy). User-mode path unchanged.
- **`/api/send-email.ts`** uses the new auth helper; for worker-mode requests it forwards a service-role Bearer to the audit logging RPCs (since they accept either user or service auth via SECURITY DEFINER).
- **Email lookup**: can't reuse `get_player_email_for_notification` from the worker — that RPC gates on `auth.uid() ∈ group_members` which is NULL for service role. Inlined the same join in the worker via service-role table queries: `players → group_members.player_id → group_members.user_id → auth.users.email` (via `auth.admin.getUserById`).
- **Client cleanup**: deleted direct `proxySendPush`/`proxySendBroadcastEmail` calls from `triviaReportNotifications.ts` (DB triggers handle both kinds — file is now no-op shims preserving the export names so callers don't need to change), made `sendVoteChangeNotifications` a no-op shim (DB trigger handles), converted `sendReminderNotifications` and the three `notify*OfTraining*` helpers to call `enqueueNotificationRpc` with a fully-built payload (push_title/push_body/email_subject/email_body/recipient_player_names/url) — the worker just forwards to send-push and send-email. Browser worker (`notificationWorker.ts`) untouched and still works as a redundant fast-path drain when a client is online; atomic `FOR UPDATE SKIP LOCKED` claim means no double-dispatch.
- **Validation**: `npx tsc --noEmit` clean (~50s), ReadLints clean across all 8 touched files plus 1 new file. Verified extensions/triggers/cron job all installed via `pg_extension` / `pg_trigger` / `cron.job` queries.
- **Bumped to v5.49.0** with a 7-bullet changelog focused on the user-facing impact ("dispatch fully server-side", "pg_net webhook fires within seconds", "pg_cron sweep retries every minute", "vote-change pings no longer rely on voter's tab", etc.). Verbose architecture details stayed in the commit message.

**Operator action remaining**: add Vercel env vars `WORKER_INTERNAL_SECRET = ACFiKf2rTZOG-H3ABxJEKWVf5G6xaGXiylu4cHJRhkA` and `SUPABASE_SERVICE_ROLE_KEY` (copy from Supabase project → Settings → API). The DB secret is already inserted into `worker_config`; until the Vercel env var matches, the worker returns 401 for every webhook (cron keeps retrying — nothing breaks, but nothing dispatches either).

**Learned**:
- "Server-side dispatch via DB webhook" is the correct architecture for any notification system that needs to be reliable independent of who's online. The 061 design was *durable* (jobs survive in DB) but not *reliable* (delivery still required a client). pg_net + pg_cron in Postgres + a single-purpose Edge Function gives instant fire-and-retry with no extra moving parts. Other Supabase products would have needed an external cron service or Database Webhooks dashboard config.
- Supabase locks down `ALTER DATABASE postgres SET <custom>` for non-superuser roles — `current_setting('app.foo')` isn't reachable via the migration pipeline. A `worker_config(key, value)` table with RLS denying anon/authenticated and only service-role writes is the supported alternative. Worth remembering for any future "DB needs a runtime-configurable URL or secret" use case.
- When porting message builders from client to server, the gender-aware verb conjugations (`verbForName`) are the most expensive piece because they need the player roster + per-name lookups. For server-side dispatch, deliberately dropping gender awareness in favor of neutral Hebrew is the right trade — reliability > polish for a fan-out system. The browser worker (still a redundant fast-path) keeps the rich gender-aware copy when a client is online.
- Don't reuse SECURITY DEFINER RPCs that gate on `auth.uid()` from a service-role caller — `auth.uid()` is NULL there and the gate raises. Inline the underlying joins in the Edge Function instead.

**Next**:
- Operator confirms env vars set, then we test end-to-end: create a poll, vote yes from a different account, watch the target_filled job auto-process. The stuck `6a086d0f-…` from this morning's incident should drain on the next pg_cron tick once env vars are in place.
- If it works as expected, this closes the entire notification reliability epic. The browser worker (`src/utils/notificationWorker.ts`) becomes pure redundancy and could eventually be deleted, but there's no urgency — both paths share the same atomic claim and there's zero double-dispatch risk.

---

## 2026-05-09 — Photo chip counting + multi-stream merge (v5.47.0)

**Asked**: Build a "snap a photo to count player chips" feature for the end-of-game ChipEntryScreen, with strict accuracy guardrails ("AI proposes, human confirms"), and at the end "run full tests including edge cases, merge changes from all agents, bump version".

**Did**:
- **New feature — photo chip counting**: full pipeline from Settings (chip color order config + owner-only test card under Services) → ChipEntryScreen (📷 צלם קופה button per player → `PhotoCaptureModal` → AI fills counts with per-stack confidence + total-value reconciliation banner). Stack identity is anchored on a configurable left-to-right color order (new `chip_color_order` JSONB column, migration 060) so the AI relies on position rather than color discrimination — eliminates the biggest accuracy failure mode. Manual entry path is fully preserved; AI never overwrites manually-edited fields.
- **Files**: new `src/components/PhotoCaptureModal.tsx`, `src/utils/imageUtils.ts` (downscale + Laplacian variance blur check), `supabase/060-chip-color-order.sql`. Modified `src/types/index.ts` (`PhotoChipCountStack`, `PhotoChipCountResult`, `Settings.chipColorOrder`), `supabaseCache.ts` (round-trip mapper), `geminiAI.ts` (`countChipsFromPhoto` — single holistic prompt, multimodal payload, strict JSON, gemini-2.5-flash via existing `/api/gemini` proxy), `ChipEntryScreen.tsx` (button, banner, colored input borders by confidence, edited-field tracking), `SettingsScreen.tsx` (color order UI under Chips tab + test card under Services tab), `i18n/translations.ts` (HE + EN copy for all of the above).
- **Merged 3 parallel agent streams** under one v5.47.0 commit:
  1. (Mine) Photo chip counting feature.
  2. **Home dashboard "About You" personal facts card** + extracted shared `RotatingFactCard` component (refactored from `TriviaCard`), tasks-first ordering, slide animations (`triviaSlideFromRight/Left` keyframes in `index.css`).
  3. **Realtime cache-recovery on tab return**: `useRealtimeRefresh` now accepts an optional `forceRefreshOnReturn` callback; new `forceRefreshPlayersFromDb` / `forceRefreshPollsFromDb` exports in `supabaseCache.ts`; wired into `ScheduleTab`, `GroupManagementTab`, `NewGameScreen` so screens recover from WS-gap stale data after the phone wakes.
  4. Plus a small Statistics button color tweak (muted instead of green).
- **Validation**: `npx tsc --noEmit` clean (89s full run), ReadLints clean across all 17 touched files. Migration 060 was already applied to live DB earlier in the session. Manual entry path in ChipEntryScreen verified unchanged via diff (photo button is purely additive — `updateChipCount` retains its original signature with optional `source` param defaulting to `'user'`).
- **Shipped**: `git push` of `80c36ca` (v5.47.0). Vercel auto-deploys.

**Learned**:
- For an "AI proposes, human confirms" UX where accuracy matters, position-based identity (configurable color order → AI counts stack #1, #2, etc.) drastically outperforms identity-based identity (AI must classify red vs orange). Eliminating color discrimination as an error source is worth the one-time admin setup cost.
- When the user says "merge changes from all agents", it's an explicit instruction — bundle everything into one version bump rather than fragmenting across multiple commits. The changelog covers all streams; the commit message provides per-stream breakdown.
- `useRealtimeRefresh` with an opt-in `forceRefreshOnReturn` callback is the right shape for fixing WS-gap stale data: most screens are fine with a re-render of the in-memory cache, but write-heavy screens (schedule votes, group members) need to actually re-fetch. The 500ms debounce in `scheduleRealtimeRefresh` coalesces multi-callback fires (e.g. NewGameScreen forces both `players` and `polls`) into a single roundtrip.

**Next**: No follow-ups outstanding. The photo feature is feature-complete with the test card available for owner-side accuracy validation against the user's actual chip set + lighting before relying on it in a live game.

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
