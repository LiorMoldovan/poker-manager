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
