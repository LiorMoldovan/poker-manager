# LESSONS

> Non-obvious gotchas that bit us. Each entry: gotcha, fix, when it burned us.
> Hard cap ~10 entries. New one means an older one is either promoted to `.cursor/rules/*.mdc` (if it's now "how we work") or deleted.

---

## `pg_trigger_depth()` doesn't detect cascade in AFTER-STATEMENT

**Gotcha**: In BEFORE-ROW it returns 2 during cascade (works). In AFTER-STATEMENT it returns 1 during cascade (fails — early-return branch skipped, transaction aborted).

**Fix**: parent-existence check, or transaction-local `set_config('app.flag', '1', true)` set by the SECURITY DEFINER RPC and read with `current_setting('app.flag', true)`.

**Burned**: migration 043 (v5.34.2) — `deleteGame` silently broken for multi-player games for 5 days.

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

## "Deployed bundle contains the hotfix code" ≠ "hotfix actually works"

**Gotcha**: Verifying a hotfix by grep'ing the deployed JS chunk for a literal string (e.g. ` ```json `) proves the code path exists in production. It does NOT prove the path is reached on a real failure, or that it covers the actual failure shape. Without an end-to-end test exercising the recovery branch against a real (or mocked) upstream response, the hotfix can be a no-op for the user and you'll think it shipped.

**Fix**: when fixing a recovery/parser path, write a small standalone test (node `.mjs` script is enough) that feeds plausible failure-shape inputs through the recovery function and verifies each one is salvaged or correctly rejected. Run it BEFORE shipping. The static "the deployed bundle has the function" check is a sanity check, not a validation.

**Burned**: v5.62.1 hotfix added markdown-fence handling for the chip-count parser. Static verification confirmed the fenced-JSON branch existed in `geminiAI-B1tyAH7s.js` on prod. Real user kept getting parseFailed on every photo for the entire v5.62.1 + v5.62.2 window because the actual failure mode wasn't markdown-fenced — it was something else we never saw. Cost two failed Lior tests and a frustrated "do you have logs? do you see the issue?" before v5.62.3 added the 5-strategy salvager AND surfaced the raw response so we'd finally have visibility.
