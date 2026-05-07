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

## 2026-05-07 — Audit existing knowledge before bootstrapping anything that claims to honor it

**Incident**: While bootstrapping the agent-memory system, I read 5 of 13 `.cursor/rules/*.mdc` files (the always-applied ones already in my context) plus `AGENTS.md`, then designed and committed the system. Lior asked: "did you refer to everything we already had?" Answer was no — I'd skipped 8 rules. Materially the design didn't suffer (the missed rules are domain-specific), but I missed `schedule-poll-dates.mdc` as the canonical promotion example, and I committed a system claiming to "complement existing knowledge" without exhaustively reading that knowledge.

**Root cause**: I assumed domain-specific rules (AI, UI, Supabase, groups, activity) wouldn't affect a meta-level system. That assumption was mostly right but not fully right — and more importantly, "mostly right" isn't the bar when you're building the foundation that future agents will inherit.

**Lesson**: Before bootstrapping anything that integrates with or references existing standing knowledge (rules, docs, established patterns), read **all** of it first — even the parts that "feel off-topic". Cost is one extra minute; cost of skipping is committing a foundation with blind spots that propagate forward.

**Session**: 2026-05-07 (Bootstrap entry).
