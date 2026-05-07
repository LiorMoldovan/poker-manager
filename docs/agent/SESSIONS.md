# SESSIONS — Work Journal

> **What this is**: Append-only chronological log of agent sessions. Newest at the top. One entry per chat that touched code or made a meaningful decision. Skip drive-by tweaks (typo fixes, single-line patches) unless they revealed something worth remembering.
>
> **Format**: Date, what was asked, what was done, what was learned, what's next. Keep entries tight — bullets, not essays.

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
