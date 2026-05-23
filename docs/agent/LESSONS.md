# LESSONS

> Non-obvious gotchas that bit us. Each entry: gotcha, fix, when it burned us.
> Hard cap ~10 entries. New one means an older one is either promoted to `.cursor/rules/*.mdc` (if it's now "how we work") or deleted.

---

## `CREATE EXTENSION ... WITH SCHEMA X IF NOT EXISTS` does NOT relocate

**Gotcha**: If the extension already exists, the `WITH SCHEMA` clause is silently discarded. No warning, no error.

**Fix**: verify with `SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON e.extnamespace = n.oid WHERE e.extname = '<ext>'`. Supabase defaults: pg_net at `net`, pg_cron at `cron`, http at `extensions`.

**Burned**: migration 066 (v5.49.0) — silent webhook failure for 30min, caught only because operator ran a manual test.

---

## Postgres FK cascade order doesn't respect inter-child dependencies

**Gotcha**: `DELETE FROM parent` with cascade rules to multiple children processes them in implementation-dependent order (≈OID/insertion). A NO-ACTION FK from child A → child B will fire while A's cascade runs before B is drained → FK violation, whole transaction aborts.

**Fix**: orchestrate the delete manually in dependency order inside a SECURITY DEFINER RPC, gated by a transaction-local flag the guard triggers honor.

**Burned**: `delete_group` (v5.60.9) — silently failed for every group with at least one game.

---

## Lock event-derived values at the click, not in a downstream effect

**Gotcha**: `useEffect` that does `state.someArray[indexFromClick]?.x` re-derives on every dep change. Any intervening render (deferred-cache events, batching, etc.) can stale-lookup → user's choice becomes the wrong value.

**Fix**: compute and `setState` the final value in the synchronous event handler. Effects read the captured boolean.

**Burned**: Trivia scored 0/N for Lior reproducibly (v5.50.2) while other players in the same group scored normally on identical code — render-timing race, not a logic bug.

---

## Truthy sentinel return values silently bypass UI gates

**Gotcha**: Returning a non-empty string sentinel (e.g. `'server-managed'`) from a function callers use as `if (!fn())` → every gate evaluates true → feature silently fires when it shouldn't.

**Fix**: absence-of-feature MUST be falsy (`null`/`''`/`false`). Sentinels only work if every call site checks them explicitly — audit call sites before adding one. Don't implement the same gate at two layers with one half "fail open" and the other "fail closed" — they drift.

**Burned**: AI key billing leak — every non-owner group's AI usage drained the platform Gemini quota until v5.60.3.

---

## Retry-with-fallback loops collapse failure modes

**Gotcha**: A loop that exits with `ALL_FAILED: <last error>` loses the structure that distinguished "model A deprecated, B might exist" (application, retry helps) from "every model will fail identically because the proxy doesn't exist" (infrastructure, retry is waste).

**Fix**: distinguish at the wrapper/fetch layer BEFORE entering the loop (e.g. content-type check on 4xx: HTML body = wrong-layer-answered = infrastructure, JSON body with `error.code` = application). Synthesize a structured error the loop recognizes as "fail fast, do not retry".

**Burned**: `ALL_MODELS_FAILED: Status 404` rendered as a red error card on localhost (v5.60.11) — every AI feature looked broken when really `/api/*` just doesn't exist on Vite.

---

## Reconciliation UI against a meaningless target panics the user

**Gotcha**: Adding a `running / expected` element with red coloring only works if there's a target the running value should converge to. If divergence is legitimate (profit/loss, partial entry, queued vs committed), red paints correct usage as broken.

**Fix**: before adding any "X vs Y" element, write down what condition you expect it to flag as wrong. If users can legitimately produce that state, drop the element or reframe it as informational with non-alarming colors. Red is a promise that something IS broken — only use it when something actually is.

**Burned**: numpad running-total strip (v5.60.5) painted winning players red. Reverted in v5.60.6.

---

## `git stash --keep-index` is unreliable on Windows

**Gotcha**: Supposed to stash unstaged + leave staged ready to commit. On Windows + recent git, restoration of staged paths is unreliable — newly-tracked files and recently-touched files can vanish from the staging area silently.

**Fix**: don't reach for stash when the goal is "extract my files from a mixed working tree". Use `git add <my-files-only>` → `git status` to verify the staged set → `git commit` directly. Other-agent unstaged stuff stays in working tree untouched. When `git status` mentions divergence from origin, run `git log --oneline --all --graph -10` BEFORE committing.

**Burned**: 30min untangling the v5.58.0 commit on 2026-05-10 — wrong files captured, soft-reset exposed a separate origin divergence.

---

## `overflow: hidden` on `<html>` breaks iOS Safari vertical touch scroll

**Gotcha**: Setting `overflow-x: hidden` (or any axis) on `<html>` moves the scroll context off the viewport onto the html element. Combined with `body { min-height: 100vh }` (universal in this app) it silently kills vertical touch scrolling on iPhone. Desktop, Android, and `tsc`/lint all pass — the diff looks like a one-line CSS tweak.

**Fix**: use `overflow-x: clip` instead. Same visual no-overflow effect, but by spec does NOT establish a scroll container, so iOS keeps scrolling on the viewport. Supported Safari 16+ / Chrome 90+ / Firefox 81+ — universal in 2026. Any future `html`/`body`/`#root`/`*` rule that touches `overflow`, `position: fixed`, `touch-action`, or `overscroll-behavior` is global-blast-radius and needs a real-device iPhone pass before merge.

**Burned**: v5.62.6 merged another agent's "iOS Safari backstop" CSS without real-device testing. Entire app un-scrollable on iPhone in production. Caught by Lior, fixed in v5.62.7.

---

## "Deployed bundle contains the hotfix code" ≠ "hotfix actually works"

**Gotcha**: Verifying a hotfix by grep'ing the deployed JS chunk for a literal string (e.g. ` ```json `) proves the code path exists in production. It does NOT prove the path is reached on a real failure, or that it covers the actual failure shape. Without an end-to-end test exercising the recovery branch against a real (or mocked) upstream response, the hotfix can be a no-op for the user and you'll think it shipped.

**Fix**: when fixing a recovery/parser path, write a small standalone test (node `.mjs` script is enough) that feeds plausible failure-shape inputs through the recovery function and verifies each one is salvaged or correctly rejected. Run it BEFORE shipping. The static "the deployed bundle has the function" check is a sanity check, not a validation.

**Burned**: v5.62.1 hotfix added markdown-fence handling for the chip-count parser. Static verification confirmed the fenced-JSON branch existed in `geminiAI-B1tyAH7s.js` on prod. Real user kept getting parseFailed on every photo for the entire v5.62.1 + v5.62.2 window because the actual failure mode wasn't markdown-fenced — it was something else we never saw. Cost two failed Lior tests and a frustrated "do you have logs? do you see the issue?" before v5.62.3 added the 5-strategy salvager AND surfaced the raw response so we'd finally have visibility.

---

## Hand-rolled `<input type="number" value={n}>` snaps backspace-to-empty back to a number

**Gotcha**: A controlled `<input type="number">` bound to a number state (`value={n}`) with `onChange={e => set(parseInt(e.target.value, 10) || 0)}` silently snaps an empty field back to 0 (or whatever fallback we passed). Users hitting backspace to clear the cell watch their digits get replaced by `0` and have to tap-and-select-all to actually overwrite. tsc + lints don't catch it; you only notice when you're a user trying to retype.

**Fix**: use `src/components/NumericInput.tsx` instead. It holds a string draft internally, lets the field be empty mid-edit, and only emits a number to its `onChange` when the draft is parseable. Snaps back to the last committed value on blur (or `0` if you allow it). Drop-in replacement: same `value` / `min` / `max` / `style` / `onBlur` props. The component's header comment documents the bug for the next person.

**Burned**: hit three times in three weeks — the chip-row in v5.62.x (fixed when NumericInput was originally built), the chip-correction cell on the Settings test card in v6.3.1, and **six** more in `ScheduleTab.tsx` in v6.4.0 (create-poll target/delay, edit-poll target/delay, group-config default target/default delay). If this pattern reappears one more time, promote this lesson to `.cursor/rules/numeric-inputs.mdc` ("any new `<input type="number">` must use `NumericInput`, no exceptions").

---

## Native `<select>` ≠ a dark-theme custom popover on mobile

**Gotcha**: Swapping a custom React popover for a native `<select>` "for consistency with sibling selects" looks fine on desktop and in dev tools, but on iOS Safari / Android Chrome the OS renders its own open chrome (iOS white wheel picker, Android system list). There's no CSS hook to style the open content of a native `<select>` — once the OS owns the menu, your dark theme stops at the trigger.

**Fix**: if the surrounding UI is dark-themed and you need rich styling (selected-state accent, custom layout, scoped icons), use a custom React popover even when sibling controls are native selects. Style the closed trigger to match the siblings (same padding / border-radius / font-size) so the layout doesn't shift — only the open menu diverges, and that's the OS-vs-dark-theme escape hatch you're explicitly avoiding.

**Burned**: v6.7.0 → v6.7.2 — the per-table period selector on Statistics was a custom popover (yesterday), an agent converted it to a native `<select>` "to match sort/mode chrome", looked fine on desktop, Lior hit it on mobile and got "ugly white box" everywhere. Reverted in v6.7.2.

---

## A fallback that fabricates plausible-looking output is worse than no answer

**Gotcha**: When the primary model/service fails and the fallback "succeeds" but produces semantically wrong output (looks like a real result, but isn't actually doing the task), users trust the fake answer instead of retrying. A user-visible result with structure but no real signal is a confidence trap — every time the fallback fires, the user's mental model of "the AI is broken in obvious ways" gets weaker, and the next subtle real failure goes uncaught. Better to surface "model busy, try again" than to ship something that grammatically matches the schema but ignored the input.

**Fix**: don't add a fallback model/service to a chain unless you have evidence it actually does the task. "It's in the same family" / "the docs say it's multimodal" is not evidence — empirical telemetry is. If your fallback ever produces output that's distinguishable from the primary's correct output (constant values, repeated patterns, hits a canonical example from the prompt verbatim), it's not a fallback — it's a liar. Pull it. Show a clean error and let the user retry or escalate.

**Burned**: chip-count `gemini-2.5-flash` fallback (v5.59 → v6.4.0). It was added as a "safety net" for when `gemini-3-flash-preview` was rate-limited. Telemetry from `chip_count_corrections` on 2026-05-16 showed it returned `10` for every non-zero color across every photo it ran on (4 of Lior's 6 test photos). It wasn't counting — it was pattern-matching the "stack of 10" canonical example in our prompt. For ~7 months it silently degraded the feature's effective accuracy whenever the primary hiccupped. Removing it in v6.4.1 was a strict improvement.

---

## "Block X if game is completed" must read a time-monotonic marker, not current status

**Gotcha**: A trigger that says `IF parent.status = 'completed' THEN BLOCK` looks correct in isolation. The minute you introduce ANY legitimate path that downgrades status (a sanctioned reopen RPC, an admin "edit" button, anything), you've also given an attacker — or just a sequence of innocent events — a window where the guard reads `chip_entry`/`live` instead of `completed`, and lets the destructive operation through. The reverse-status flip itself is allowed (you sanctioned it for good UX reasons), but the secondary guards that depended on the status word naively keep using it as their invariant. The result: a status round-trip (`completed → chip_entry → delete → completed`) wipes data, and every layer fired its trigger and "passed".

**Fix**: when sealing a state ("once X, never delete child rows"), gate on a **time-monotonic** column (e.g. `completed_at TIMESTAMPTZ`) that is set on first entry into the state and explicitly forbidden from being cleared. The guard reads `IF parent.completed_at IS NOT NULL THEN BLOCK`. Sanctioned reopens leave `completed_at` set — they only flip `status` for UI routing. Cascade-delete-from-parent stays exempt via `pg_trigger_depth() > 1`. UPDATE operations on child rows (the legit chip-entry-edit path) stay allowed because they don't trip a DELETE guard. The same idea applies to any "has-been-X" invariant: don't reuse the mutable state column, add a sealed timestamp.

**Burned**: four weekend roster wipes (2026-05-03, 2026-05-08, 2026-05-14, 2026-05-20). Migrations 050, 051, 077 each closed a previously-observed vector but every one kept reading `games.status = 'completed'` as the invariant. The fourth incident finally exposed it: the sanctioned `reopen_completed_game` RPC flipped status to `chip_entry`, migration 050 then read `chip_entry`, and 8 game_players got DELETEd individually. Fixed for good in v6.8.4 by migration 088 — added `games.completed_at`, repointed migration 050's check, plus a comprehensive `game_audit_log` table so we never have to investigate the next incident blind.

---

## Triggers that write to RLS-protected tables MUST be SECURITY DEFINER (and the sandbox MUST use a real user JWT)

**Gotcha**: A PL/pgSQL trigger function defaults to `SECURITY INVOKER` — meaning it executes with the privileges of whatever user fired the triggering DML. If the trigger writes to a table that has RLS enabled, the trigger's INSERT is checked against RLS policies as the invoking user. So an "internal" audit table with RLS gating only SELECT/DELETE (no INSERT policy, the common pattern for append-only audit logs) silently breaks every authenticated-user write that fires the trigger — and because the failed INSERT rolls back the whole transaction, the user-facing write fails too. The user sees a toast like "Save failed: games/upsert — new row violates row-level security policy for table game_audit_log" and has no idea why a games table write was blocked by an audit-log policy.

The trap deepens during sandbox testing: the Supabase Management API (and any direct `psql` as `postgres`) runs as superuser, which bypasses RLS unconditionally. Triggers fire and writes succeed. The migration looks bulletproof in your sandbox. Then a real `authenticated`-role PostgREST request from the deployed app hits the same code path, RLS kicks in, and the trigger fails — but only in production. You have no way to discover this without sandboxing with a real-user role + JWT claim.

**Fix**: For any trigger function that INSERTs into an RLS-protected table:
1. Declare it `SECURITY DEFINER` so it runs as the function owner (typically `postgres`).
2. Verify the function owner has write privilege on the target table AND is the table owner (or the table doesn't have `FORCE ROW LEVEL SECURITY`). Table owners bypass RLS by default unless `FORCE ROW LEVEL SECURITY` is set.
3. Always declare `SET search_path = public, pg_temp` on SECURITY DEFINER functions (no change in privilege model, but it closes the search-path attack surface that SECURITY DEFINER opens).
4. `auth.uid()` continues to work inside a SECURITY DEFINER function — the JWT context is session-level, not function-level — so audit rows still record the real authenticated user, not `postgres`.

**Sandbox protocol for ANY new trigger/RLS change** (this is the part I keep skipping):
```sql
BEGIN;
SELECT set_config('request.jwt.claim.sub', '<real-user-uuid>', true);
SET LOCAL ROLE authenticated;
<do the action a real user would do>;
RESET ROLE;
SELECT <observe the resulting state>;
ROLLBACK;
```
This is the ONLY way to validate the user-context path. Running the test as `postgres` via Management API proves nothing about whether real users will be blocked by RLS. **A clean Management-API sandbox + a green tsc + green ReadLints together still don't catch this class of bug.** The role-switched sandbox is mandatory.

**Burned**: v6.8.4 (mig 088 — audit log) shipped with both audit trigger functions as default `SECURITY INVOKER`. My mig 088 comment block actually asserted the opposite ("Service role / table owner bypasses RLS implicitly — the trigger functions run as the table owner (postgres)") — that assertion was flat wrong, but because every sandbox test ran as superuser, the assertion was never falsified. Lior caught it on first production game completion after the deploy (2026-05-22) — toast "Save failed: games/upsert — new row violates row-level security policy for table game_audit_log". His exact response was the one I deserved: "very fraustrating i have to find such things, you reduce the quality of the app so people will stopusing it". Fixed in v6.8.8 by migration 090 (one-line `ALTER FUNCTION ... SECURITY DEFINER` per audit trigger) + a sandbox protocol I should have followed the first time. Two production games got stuck in `status='live'` with profits already entered, because the games-status UPDATE always rolled back together with the audit-log INSERT.

---

## Group-shared JSONB columns lose updates when clients serialize the whole blob

**Gotcha**: A `JSONB` settings column written by every admin's full-row upsert (e.g. `settingsToRow`'s `schedule_email_kinds: { …all 7 keys… }`) silently reverts another admin's flipped key whenever the second writer's local cache hasn't echoed via realtime. The bug is invisible — no error, no audit row, no console warning — and any unrelated settings save (push toggle, default target, auto-create time) is enough to trigger it because the JSONB is always carried along for the ride.

**Fix**: a dedicated atomic-merge RPC (`jsonb_set` on ONE key, `SECURITY DEFINER` + manual admin check + whitelist of allowed keys) becomes the SOLE sanctioned write path. Remove the column from the generic settings-upsert payload entirely so PostgREST's `ON CONFLICT DO UPDATE SET …` clause can't touch it. Proven on the live DB with three SQL probes: positive merge, positive omission (column untouched when payload skips it), and the negative control reproducing the historical stomp.

**Burned**: v6.8.7 / migration 090 shipped the per-event email allowlist. Lior received a `creation` invitation email on 2026-05-21 19:48 IL despite his recollection that `creation` was off. Forensic dig couldn't prove timing (settings has no `updated_at`) — but Eyal sat on the Settings screen 58s before triggering the poll, with a stale cache. That fits the lost-update race exactly. Fix shipped as migration 092 (`update_schedule_email_kind` RPC) + `settingsToRow` deletion of the column block.
