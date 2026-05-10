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
