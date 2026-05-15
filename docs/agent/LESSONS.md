# LESSONS — Hard-Won Knowledge

> **What this is**: Lessons that were learned the hard way. Each entry is rooted in a real incident — a bug, a wrong assumption, a wasted hour. **Not a best-practices list.** If you're tempted to add something generic ("always validate inputs"), stop — it doesn't belong here. It belongs in a `.cursor/rules/*.mdc` file.
>
> **Promotion path**: When a lesson here gets cited 3+ times or shapes how we work going forward, promote it to a proper rule in `.cursor/rules/` and shorten the entry here to a one-line pointer.

---

## How to add a lesson

```
## YYYY-MM-DD — Short title

**Incident**: What happened. One or two sentences.
**Root cause**: Why it happened. Be honest, even if the cause was "I didn't check".
**Lesson**: What to do differently next time. Specific, actionable.
**Session**: Link to the session entry that birthed this (date is enough).
```

Keep each lesson under ~10 lines. If it needs more, it's probably a rule, not a lesson.

## Canonical example of promotion (lesson → rule)

`.cursor/rules/schedule-poll-dates.mdc` is the gold-standard example. A past implementation enforced "2 ≤ date count ≤ 5" on schedule polls. The user explicitly removed the cap and said never to reintroduce it. That ask graduated straight into a permanent always-on rule rather than living forever in `LESSONS.md`. When something here reaches that level of "this is now how we work", do the same.

---

## 2026-05-15 — Center-patch sampling on stickered objects: don't sample where the sticker is

**Incident**: v5.59.0 shipped chip-counting selfies. `captureChipSelfie` averaged the dead-center 24×24 pixels of each selfie to compute `selfieDominantHex`. After ~4 days in production, Lior reported the new pipeline was "not even close, didn't catch anything." DB inspection showed every chip's stored hex was muddy grey/beige (red→#b59e94, blue→#7b86a3, green→#aaaa94, black→#989493). Root cause: most poker chips have a printed value inlay/sticker dead-center. The center patch sampled the inlay, not the colored body. Downstream, `stackDetection.ts` mapped detected stack regions to chips by HSL distance against these hexes — with every reference looking like the same shade of grey, the mapping was effectively random. Counts went into wrong color rows; feature appeared totally broken.

**Root cause**: I assumed "chip selfie = clean shot of one object on plain background → center pixel = dominant color." That's true for unstickered objects. Poker chips, casino chips, coins, branded mugs, labeled bottles, button caps — most physical objects of interest in CV have **decorations, text, or stickers in the visually-prominent center** because that's where the design language of the object lives. The center-patch heuristic actively prefers the LEAST representative region. I built the prototype against my mental model of an idealized chip (uniform color disc) and shipped without testing on the real artifact (chip with printed inlay). The stored hex was never inspected via the dashboard before declaring done.

**Lesson**: When extracting the dominant color of a real-world object via canvas sampling, **never sample only the center**. Default to a ring of patches at 30–75% of the radius and take the per-channel median (robust against outliers from text/inlay/edges/background). Verify by querying the DB for the actual stored values — not just by checking that "the function returned a hex." For any color-extraction code in the future: if the result looks suspiciously like a uniform mid-grey across multiple distinct-colored inputs, that's the inlay-bug signature; don't ship until you've sampled an off-center region. **Session**: 2026-05-15.

---

## 2026-05-13 — Retry-with-fallback loops collapse failure modes — distinguish at the wrapper layer

**Incident**: Lior on localhost saw `🤖 תובנות AI יצירת תובנות ALL_MODELS_FAILED: Status 404` rendered as a red error card in GraphsScreen. The cause: Vite dev server doesn't serve `/api/*` Vercel Edge Functions, so every fetch to `/api/gemini` returns an HTML-404 page. The `runGeminiText` retry loop's 404-handler treats 404 as "this model deprecated, try the next one" — so all 3 models retry against the same missing endpoint, all fail with HTML-404, and the loop throws `ALL_MODELS_FAILED: Status 404` with the last error string. UI catches got an unrecognized error → red banner. The loop's 404-handler was correct for one failure mode (Google deprecated this model name, model B might exist) and catastrophically wrong for another (proxy doesn't exist in this env, every model will fail identically). By the time the loop exited, the structure that distinguished the two cases was gone.

**Root cause**: Retry-with-fallback patterns are lossy. They reduce N attempts × M failure-modes-per-attempt to one final string. When the loop exits with `ALL_MODELS_FAILED: <last error>`, the caller can't tell "all 3 returned 404 with HTML body from Vite" (infrastructure: proxy missing) from "model A had safety filter, B hit token limit, C returned JSON-404 from Google" (application: try later, different request). The 404-handler in the loop was the wrong layer to make the distinction — at that point we still saw the response, but we already chose to bucket it as "transient, try next" without checking content-type. By the time we DID need to distinguish, we were two function frames up with nothing but a string.

**Lesson**: When designing or reviewing a retry-with-fallback loop, explicitly enumerate the failure classes the loop CAN encounter and decide UPFRONT which ones short-circuit (no point retrying) vs which ones advance to the next attempt. For network failures specifically: 4xx-with-JSON-error-code is application; 4xx-with-HTML-body almost always means "wrong layer answered" (proxy missing, gateway error, redirect to login page) and is infrastructure — retrying against the same endpoint will produce identical results. Inspect content-type at the wrapper / fetch layer where the structure is intact, BEFORE entering the retry loop, and synthesize a cleanly-coded structured error the loop can recognize as "fail fast, not retry" (here: synthetic `503 { code: 'aiProxyUnavailable' }` from the new `aiFetch` wrapper → propagated as `AI_PROXY_UNAVAILABLE` sentinel). Generalizes: any time you see a retry loop bucket a status code into a `continue`, ask "would EVERY retry attempt produce this same status?" — if yes, the bucket is wrong; the failure short-circuits.

**Session**: 2026-05-13 (v5.60.11 — `ALL_MODELS_FAILED: Status 404` localhost UX fix).

---

## 2026-05-13 — Postgres FK cascade order does not respect inter-child dependencies

**Incident**: `delete_group(uuid)` shipped in migration 014 as `DELETE FROM groups WHERE id = $1`, trusting that every child table's `ON DELETE CASCADE` would handle cleanup. It silently failed for every group with at least one game. Lior clicked Delete Group on his test group, typed the confirmation, and nothing happened (the secondary UX bug — toast at top, action at bottom — hid the real error from him too). Root cause when reproduced via MCP: `update or delete on table "players" violates foreign key constraint "game_players_player_id_fkey" on table "game_players"` (sqlstate 23503). The `game_players.player_id → players` FK is `NO ACTION` on purpose (DB-side safety for the UI's `playerHasGames()` guard against single-player deletes). When PG fans out cascades from `DELETE FROM groups`, it processes `groups → players` and `groups → games → game_players` in implementation-dependent order, and the `players` cascade runs while `game_players` rows still reference each player.

**Root cause**: I (and the original migration 014 author) treated "every child has ON DELETE CASCADE back to groups" as sufficient. It isn't, when one child has a NO-ACTION FK to another child. PG processes each cascade independently and the FK check fires at end-of-statement against the in-progress state. The cascade fan-out is not a topological sort of the FK graph — it's roughly OID order, which happens to be insertion order, which is the order the tables were created in `schema.sql`. The fact that this had worked for months for groups with 0 games was pure luck.

**Lesson**: Whenever a parent table has cascade rules to two or more children AND any of those children has a NO-ACTION FK to another, the cascade is a foot-gun — write a sandbox test (DELETE the parent row in a rolled-back transaction, read SQLERRM) before claiming the cascade is enough. If the FK can be made CASCADE without breaking semantics, do that. If it can't (as here — losing per-player roster history on single-player delete would be data destruction), orchestrate the deletion manually in dependency order, inside the SECURITY DEFINER RPC that's the only legitimate caller. Companion lesson on writing migrations that touch trigger logic: every "no inbound FKs" or "no cascade context to detect" claim in a migration's prose has a half-life. Migration 051 was correct for the `games → game_players` chain it was reasoning about, and the prose generalization was wrong for the `groups → players → game_players` chain the author hadn't considered. Future agents who touch a guard trigger should re-derive the FK graph from `pg_constraint` rather than trusting the older migration's prose summary. The graph is one query away and tells the truth.

**Session**: 2026-05-13 (v5.60.9 — delete_group rewrite + migration 076 flag-gated guard escape).

---

## 2026-05-13 — A "reconciliation strip" against a meaningless target panics the user

**Incident**: v5.60.5 item 1 added a `running / expected` chip-points strip in the numpad header, color-coded red on overcount. Lior took a real photo on his phone, saw `(+2,000) 1,000 / 3,000` in red for a player who'd had a successful game, and asked "i think something is wrong, lets assume i did 2 rebuys and then i ended the game with more chips it simply means i completed the game in profit". He was right — per-player `running != expected` IS profit/loss, never an error. The strip was painting winning players red. Reverted entirely in v5.60.6.

**Root cause**: I built the strip from the audit text I'd written earlier ("the mid-flow running total is invisible — self-correcting feedback during entry instead of after"). That sentence only makes sense if there's a target the running total should converge to. Per-player there isn't one — chips conserve table-wide, not per-player. Aggregate-level reconciliation (Σ counted vs Σ expected) WAS already covered by the top-of-screen progress bar AND the chip-gap warning at finalize (item 3). I added a third surface for the same signal but at the wrong granularity, and gave it the most alarming color. Cost: shipped a bug to production for ~3 hours and reverted in the next session.

**Lesson**: Before adding a "feedback / reconciliation / sanity-check" UI element, write down — in one sentence — what condition you expect the element to flag as "wrong". If the answer is "this number being different from that number", check whether there's a *legitimate* reason the numbers can differ. If yes (profit/loss, partial entry, queued vs committed, etc.), either drop the element or reframe it explicitly as "informational, not error" with non-alarming colors. **A red color cue is a promise that something is broken; only use it when something actually is.** Also: the user's audit-time enthusiasm for an idea doesn't validate the idea's premise. The audit said "running total is invisible" — that was the symptom; the proposed cure was "expose it with color cues". The right question to ask before building was "is the comparison meaningful at this granularity?" — not asked, so the bug shipped.

**Session**: 2026-05-13 (v5.60.5 → v5.60.6 — running-total strip revert).

---

## 2026-05-13 — Truthy sentinel return values silently bypass UI gates

**Incident**: `getGeminiApiKey()` and `getElevenLabsApiKey()` returned the sentinel string `'server-managed'` whenever a group had no per-group API key set — the intent was "the server will use the env-var fallback, treat it as available". But every UI gate across the app (`if (!getGeminiApiKey())` in NewGameScreen, GameSummaryScreen, GraphsScreen, ChipEntryScreen, LiveGameScreen, TrainingScreen, backgroundAI, comicGeneration, pokerTraining, etc.) checked it as a boolean. `'server-managed'` is a non-empty truthy string → every gate returned `true` → AI features fired for every group, regardless of whether they had a key. Combined with the server-side fallback being un-gated by group, this meant every non-owner group's AI usage silently drained Lior's platform Gemini quota for who knows how long. A friend opened a brand-new group, never added a key, used AI features extensively, and Lior got billed.

**Root cause**: The sentinel was added to communicate intent ("we'll let the server handle key resolution") to a hypothetical reader who would check `=== 'server-managed'` explicitly. Zero call sites did that — they all used the function as a boolean gate. So the sentinel pattern was load-bearing only in the author's head; in the actual code it just made the gate useless. Compounded by the server having a parallel un-gated fallback (`apiKey = clientKey || process.env.GEMINI_API_KEY`), creating a leak that no single layer would have produced alone.

**Lesson**: If a function's return value is used as a boolean gate, the absence-of-feature case MUST be falsy (`null` / `undefined` / `false` / `''` / `0`). Sentinels exist to be checked explicitly; if no caller checks them explicitly, they're a bug magnet, not a clarity tool. When implementing a "use sentinel value to mean X" pattern, audit every call site BEFORE shipping — if any of them treat the return as boolean, the sentinel is wrong. Companion lesson: never implement the same gate at two layers (client + server) with one half "fail open" and the other half "fail closed" — they will drift, and the fail-open half will become the de facto behavior. Both layers should fail closed; the client layer is for UX (hide affordances), the server layer is for security (refuse the call). The client should never decide whether the server can use a shared resource.

**Session**: 2026-05-13 (v5.60.3 — per-group AI key enforcement).

---

## 2026-05-10 — `git stash --keep-index` is a footgun on Windows; commit-only-my-files instead

**Incident**: A parallel agent had ~5 unrelated trivia files modified in the working tree alongside my v5.58.0 chip-permissions work. To stage only mine, I ran `git stash --keep-index` after `git add`-ing my 4 files. The expected result was "stash unstaged, leave staged ready for commit". Actual result: the next `git commit` captured `TriviaLandingScreen.tsx` + `translations.ts` + `version.ts` and *missed* `SettingsScreen.tsx` and `supabase/071-…sql` entirely — wrong file mix. Soft-reset undid the bad commit and exposed a separate divergence (other agent committed `b933097 v5.57.2` to local `main` skipping origin's `v5.57.1`). Net cost: ~30 min of git untangling and one panicked `AskQuestion` to the user.

**Root cause**: `git stash --keep-index` actually stashes BOTH staged and unstaged content, then restores ONLY the staged content to the working tree. On Windows + my git version this restoration was unreliable for SOME staged paths (newly-tracked SQL file + a recently-touched .tsx). Compounded by the silent local-vs-origin divergence that `git status` only mentioned in passing.

**Lesson**: Don't reach for `git stash` when the goal is just "extract my files from a mixed working tree". The simpler, more reliable sequence is: `git add <my-files-only>` → `git status` to verify the staged set matches expectation → `git commit` directly. The unstaged other-agent stuff stays in the working tree untouched. If you DO need to stash, prefer `git stash push -- <unwanted-paths>` (path-scoped) over `--keep-index`. And **always run `git log --oneline --all --graph -10` before committing** when `git status` shows divergence with origin — `git status` mentions it but doesn't show whose commit caused it.

**Session**: 2026-05-10 (chip-counting permissions v5.58.0 — uncommitted).

---

## 2026-05-10 — Lock event-derived values at the click, not in the effect

**Incident**: `TriviaGameScreen.tsx` recorded answer correctness in an advance/reveal `useEffect` by re-deriving from `q.answers[selectedIdx]?.isCorrect` (with `questions` in the dep array). On 2026-05-10 the operator (Lior) reproducibly scored 0/N across 11 separate sessions in `mode=group` while another player in the same group (Eyal) scored a normal 65% on the same code. Code inspection couldn't find the bug — every single boolean evaluated correctly on paper. The asymmetry was the smoking gun: same code, same data, one user's clicks land, the other's don't.

**Root cause**: Deriving correctness from `q.answers[selectedIdx]` inside an effect that depends on `questions` makes the recorded result vulnerable to **any** intervening re-render that re-sets `questions` between the click and the effect. In our codebase that surface is non-trivial — `loadBatch` is `useCallback([mode, questionCount, playerName])`, the deferred-cache `'supabase-cache-updated'` event fires after login Phase 3, and React 19 batching changed timing. We never reproduced exactly *which* path fired for Lior, but the pattern is fragile: the user's intent (click index 2 → answer "X") becomes a stale lookup against a possibly-different `q.answers` array a few microseconds later. Eyal's render schedule must have avoided the race; Lior's hit it every time.

**Lesson**: When a user event commits a meaningful piece of business state (correctness, selection, captured value), **compute and store the final value in the synchronous event handler**, not in a downstream effect that re-derives from React state. Effects re-run when their deps change; events do not. In this case the fix was a one-line pattern shift — `setSelectedIsCorrect(q.answers[idx]?.isCorrect === true)` inside `handleSelect`, and the effect reads that captured boolean instead of re-looking-up. Generalization: any time you find an effect that does `state.someArray[indexFromUserClick]?.x === y`, treat it as a code smell and lift `x` capture to the click. Also: when one user reports a bug another user can't reproduce on the same code+data, lean toward render-timing / closure-staleness explanations before chasing logic bugs.

**Session**: 2026-05-10 (Trivia 0/N stale-state hardening v5.50.2).

---

## 2026-05-10 — `CREATE EXTENSION ... WITH SCHEMA X IF NOT EXISTS` does NOT relocate

**Incident**: Migration 066 (v5.49.0) created two SECURITY DEFINER functions that called `extensions.http_post(...)` to fire the notification webhook. The migration also began with `CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;`. I assumed this would either install pg_net into `extensions` or be a no-op. It was a no-op — but pg_net was already installed by Supabase at the `net` schema, so the `WITH SCHEMA extensions` clause was silently discarded. Both webhook trigger and pg_cron sweep then called the non-existent `extensions.http_post`. Each call raised `42883: function does not exist`, but the functions had `EXCEPTION WHEN OTHERS THEN RAISE NOTICE` blocks, so the trigger silently swallowed every failure for ~30 minutes between deploy and detection. No notifications dispatched. The bug surfaced when I gave the user a manual-test SQL using `extensions.http_post` and they got the explicit error — without that, the silent failure would have continued indefinitely.

**Root cause**: Two compounding mistakes. (1) Postgres' `CREATE EXTENSION ... IF NOT EXISTS` short-circuits **before** evaluating any other clauses (including `WITH SCHEMA`). If the extension already exists, the clause is silently ignored — there is no relocation, no warning, no error. I knew `IF NOT EXISTS` was idempotent but assumed `WITH SCHEMA` would still apply on the second run. It does not. (2) The dispatch function's `EXCEPTION WHEN OTHERS THEN RAISE NOTICE` block converted what should have been a screaming RAISE into a silent log line that the operator never sees. The "fail open" exception handler turned a configuration bug into an invisible reliability bug.

**Lesson**: When using `CREATE EXTENSION ... WITH SCHEMA X IF NOT EXISTS`, **immediately verify the actual install location** with `SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON e.extnamespace = n.oid WHERE e.extname = '<ext>'`. Don't assume the schema clause took effect. For Supabase specifically: pg_net lives at `net`, pg_cron at `cron`, http at `extensions` — verify per project before referencing. Second lesson: `EXCEPTION WHEN OTHERS THEN RAISE NOTICE` in a SECURITY DEFINER trigger is dangerous — it converts every config error into a silent miss. For dispatch / outbound-network functions specifically, prefer `RAISE WARNING` so the failure shows up in `pg_stat_statements`/Postgres logs at minimum, AND record a row in a side table (e.g. extend `notification_jobs.last_error` from the trigger when the http_post call returns an error) so the operator has an in-database signal. Third lesson: any new pg_net-driven feature MUST include a synthetic end-to-end test (`net.http_post(url, body) -> SELECT * FROM net._http_response`) as part of its migration verification, not just "tsc clean + lints clean". The user explicitly called this out: "you are the expert post issues and not before". The synthetic test that DID validate the pipeline took 3 minutes to write. Always do it before claiming done.

**Session**: 2026-05-10 (Server-side notification dispatch v5.49.x).

---

## 2026-05-08 — `pg_trigger_depth()` does not detect FK CASCADE in AFTER-STATEMENT triggers

**Incident**: Migration 043 (v5.34.2, May 3) shipped a `block_bulk_direct_delete` AFTER-STATEMENT trigger on `game_players`, `games`, `players` that was supposed to allow FK CASCADE deletes via `IF pg_trigger_depth() > 1 THEN RETURN NULL`. It does not. Empirically: in BEFORE-ROW context during cascade, `pg_trigger_depth()` returns 2 (works); in AFTER-STATEMENT context during cascade, it returns 1 (fails). So when the user's `deleteGame` flow issued `DELETE FROM games WHERE id = $1`, the cascade fired DELETE on multiple game_players, and the AFTER-STATEMENT trigger on game_players ran with depth=1, did NOT take the early-return branch, saw `affected > 1`, and aborted the entire transaction. The local cache pretended the delete succeeded; the realtime refresh would have brought the game back. `deleteGame` was silently broken for multi-player games for 5 days. The user only didn't notice because they didn't try to delete a multi-player game during that window. We discovered it while writing migration 050 because our cascade test failed unexpectedly.

**Root cause**: I (in 2026-05-03) reasoned about `pg_trigger_depth()` from the PG docs ("nesting level of triggers") without empirical verification. PG implements RI cascades as triggers, but the AFTER-STATEMENT trigger fires with depth=1 because the cascade DELETE statement is its own statement-level frame — the cascading trigger context above it doesn't propagate into the new statement's user-trigger depth. The migration 043 self-verification block only tested the "block bulk" path; it never tested the "allow cascade" path, so the broken assumption shipped silently.

**Lesson**: When designing a trigger that needs to distinguish FK CASCADE from a direct user statement, **don't trust `pg_trigger_depth()` alone — verify with a `_depth_log` test before relying on it**. For AFTER-STATEMENT context, the reliable signals are: (1) check whether the parent rows still exist (cascade leaves them gone, direct deletes don't), or (2) use a transaction-local `set_config('app.<flag>', '1', true)` set by a SECURITY DEFINER RPC and read with `current_setting('app.<flag>', true)`. For BEFORE-ROW context, `pg_trigger_depth() > 1` does work, but still write a sandbox test that verifies it. Pattern for DB-trigger migrations going forward: every migration that has an "allow X" branch MUST include a sandbox test that exercises that branch end-to-end (not just the "block Y" branch). The 5-test harness in session 2026-05-08 (cascade-on-completed / cascade-on-live / single-on-live / single-on-completed / bulk-on-live) is the model.

**Session**: 2026-05-08 (Permanent fix for completed-game roster wipes).

---

## 2026-05-07 — Don't ship HTML to a third-party template without verifying its content-type mode

**Incident**: v5.41.0 (May 6) added `wrapHebrewEmailForRTL` in `src/utils/apiProxy.ts` to fix Hebrew left-alignment in some clients by wrapping the broadcast body in `<div dir="rtl" style="…">…<br>…</div>`. The code comment confidently asserted "EmailJS templates render `{{message}}` as raw HTML by default — that's the EmailJS default." It is NOT the default for templates created in Plain Text mode. The user's `template_broadcast` was (and had always been) in Plain Text mode, so every broadcast email since v5.41.0 arrived in inboxes as literal `<div dir="rtl"…><br>…</div>` text instead of a rendered RTL block. The user discovered this ~24h later via the in-app preview tester and rightly called it "garbage emails". Reverted in v5.44.3 to a pass-through.

**Root cause**: I made an assumption about a third-party system's default behavior that was both unverified AND undocumented inside the system we control. EmailJS templates have a Plain-Text vs HTML toggle that lives ONLY in the dashboard (no API exposes it, no env var captures it, no Vercel setting reflects it). Our code treated "the template renders HTML" as a guaranteed invariant when it was actually a fragile out-of-band assumption that no one in the codebase could see or verify without dashboard access. The comment even acknowledged the dependency ("MUST render as raw HTML") — but a comment is documentation, not a guard. There was no test, no health check, and no startup assertion that would catch the template being in the "wrong" mode. The other half of the failure: low broadcast volume meant the regression went unnoticed for a full day.

**Lesson**: Never send HTML (or any non-trivial format) to a third-party template engine without first verifying the template's render mode in that system AND documenting the dependency in a way the next change author cannot miss. Concretely: (1) before adding any HTML wrapping to an EmailJS broadcast send, the code change MUST include a manual-test checklist confirming the template is in HTML mode and the rendered output looks correct in at least one real client; (2) prefer the format the third-party template natively expects (here: plain text with `\n` newlines — Hebrew bidi handles RTL alignment in every modern client without help); (3) when an out-of-band invariant is unavoidable, surface it loudly — a comment at the call site is not enough; add a `/api/health` check, a startup log line, or a CI assertion that the operator will actually see; (4) after any change to email send formatting, send ONE preview to your own inbox and eyeball it before merging — the in-app tester literally exists for this and it's a 30-second sanity check that would have caught this immediately.

**Session**: 2026-05-07 (broadcast-email-rendering revert chat).

---

## 2026-05-07 — `boolean`-returning network helpers eat the only useful info

**Incident**: Lior triggered the email-preview tester from Settings → Notifications and saw "❌ שגיאה בשליחה". He had no way to tell which of the 5+ possible failure modes (group-not-allowed, EmailJS quota, template misconfig, EmailJS down, network throw) actually fired. The proxy returned `false`, the UI substituted a generic Hebrew label, and even the F12 console was empty because the catch block was `catch {}`.

**Root cause**: `proxySendBroadcastEmail` and `proxySendEmail` in `src/utils/apiProxy.ts` returned a bare `Promise<boolean>`. The Edge Function does send a structured `{ error: { message } }` body on every non-2xx — we just threw it away. Empty `catch {}` blocks finished the job by hiding network/CORS errors entirely. UI then had nothing to render except the hard-coded fallback.

**Lesson**: Network helpers that wrap a fetch should return `{ ok, error?, status? }` (or richer), not a `boolean`. Always read the response body on non-OK and log the error to console so future failures self-diagnose from F12 alone. `catch {}` is forbidden in any code path that can fail in production — at minimum `console.error` the caught value. The user-visible error string MUST include the underlying server message + HTTP status; the generic Hebrew fallback is only acceptable when the proxy genuinely has nothing to surface.

**Session**: 2026-05-07 (Email-error visibility chat).

---

## 2026-05-07 — Audit existing knowledge before bootstrapping anything that claims to honor it

**Incident**: While bootstrapping the agent-memory system, I read 5 of 13 `.cursor/rules/*.mdc` files (the always-applied ones already in my context) plus `AGENTS.md`, then designed and committed the system. Lior asked: "did you refer to everything we already had?" Answer was no — I'd skipped 8 rules. Materially the design didn't suffer (the missed rules are domain-specific), but I missed `schedule-poll-dates.mdc` as the canonical promotion example, and I committed a system claiming to "complement existing knowledge" without exhaustively reading that knowledge.

**Root cause**: I assumed domain-specific rules (AI, UI, Supabase, groups, activity) wouldn't affect a meta-level system. That assumption was mostly right but not fully right — and more importantly, "mostly right" isn't the bar when you're building the foundation that future agents will inherit.

**Lesson**: Before bootstrapping anything that integrates with or references existing standing knowledge (rules, docs, established patterns), read **all** of it first — even the parts that "feel off-topic". Cost is one extra minute; cost of skipping is committing a foundation with blind spots that propagate forward.

**Session**: 2026-05-07 (Bootstrap entry).
