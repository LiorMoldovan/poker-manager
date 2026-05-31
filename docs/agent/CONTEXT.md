# CONTEXT

> 30-second orientation. Refresh in place. Bullets only, no paragraphs.
> Last refreshed: 2026-05-31 (post v6.8.11 — silent-sync permanent fix)

## Now

- **`origin/main`**: v6.8.10. **Pushing v6.8.11 today** (this session).
- **v6.8.11 ships three things**:
  1. **Permanent fix for the "0 players • 0 buy-ins" recurrence** — see SESSIONS.md entry for full root cause. tl;dr: every gp mutator was firing a blanket 1,741-row upsert; on mobile that reliably failed silently, leaving server with a games row but no roster. mig 091 is the DB backstop, client now scopes upserts (~7 rows) and surfaces failures.
  2. **Other agent's feature**: Top 10 Record Months on Statistics screen (single-player monthly profit aggregate, all-time, click-through to that player's month view).
  3. **One-off data correction**: May 30 game's `date` shifted from `Sun 01:55 IL` → `Sat 21:00 IL` (Lior had to reopen-on-Sunday after the prior bug; the actual game was Saturday night). `completed_at` left intact (audit trail). Period markers untouched.

- **Recently-applied SQL**: 080–088 + 090 + **091 (today)** applied to live DB. Don't re-apply. (089 from another agent: silent poll meta edits. 092 — schedule-email JSONB merge RPC — already applied per v6.8.9 work; check `list_migrations` if unsure.)

- **Defense-in-depth stack for the roster-wipe bug class** (now 7 layers):
  | L | What | Where |
  |---|------|-------|
  | L1 | Scoped GAME_PLAYERS upsert (markers-driven, ~7 rows) | `supabaseCache.ts` GAME_PLAYERS case |
  | L2 | `pushToSupabase` throws on error + dispatches `supabase-sync-error` CustomEvent | `supabaseCache.ts` |
  | L3 | `await flushGameCreation` / `flushGameCompletion` in UI | NewGameScreen, ChipEntryScreen |
  | L4 | Rollback on failure (deleteGame; defer status-flip) + Hebrew toast | NewGameScreen, ChipEntryScreen |
  | L5 | mig 091: DB refuses `status='completed'` if 0 game_players | `check_game_zero_sum` |
  | L6 | mig 088: time-monotonic `completed_at` seals delete + downgrade guards | mig 088 |
  | L7 | mig 088+090: `game_audit_log` (`SECURITY DEFINER` audit triggers) | mig 088, 090 |

- **Verified end-to-end** before merge:
  - 10-test sandbox battery — all 10 pass expected (including the May 31 failure shape: `RAISE 23514`).
  - 0 zero-player completed games across ALL groups (was 2, restored).
  - All defensive triggers present + enabled (`tgenabled='O'`).
  - `npx tsc --noEmit` exit 0; ReadLints clean on 7 modified files.
  - Code-trace walked through every Saturday-night flow: new game, rebuy, chip entry, two-tab race, network blip mid-flow.

- **Residual risk** (documented, accepted): if network is offline >15s AND user stops editing AND realtime echo arrives, the merge guard's PRESERVE_WINDOW_MS expires and local edits could be clobbered. Rare in practice; mig 091 still prevents the worst case (no 0-player completion can land regardless). Increase to 60s or remove the window entirely if it surfaces.

## Open follow-ups

- **Monitor next real Saturday game (2026-06-06)**: if the chip-entry submit succeeds end-to-end with no Hebrew toast, the fix is fully validated in production. If a toast appears, the user will see it instead of silent corruption — that's the working failure mode now.
- **mig 092 (schedule-email JSONB atomic merge RPC)** — applied per v6.8.9 work. Confirm with `list_migrations` if confused; the file may or may not be in the repo depending on which agent shipped it.
- **`reopen_completed_game` RPC** stays as the sealed server-side escape hatch for manual chip-entry corrections (no UI affordance any more).
- **Game-wipe forensics queries** (in audit log) still relevant — see prior CONTEXT for the three canonical queries.
- **Other in-flight items from earlier sessions** (not touched today): chip-count vision testing (Lior's batch on `gemini-3-flash-preview`), free-tier quota ceiling, Lior's PC LiveGameScreen missing admin controls.

## Project-specific gotchas not in `AGENTS.md` or rules

- **Forward-only cleanup is Lior's default**: when fixing labels/routes/displayed fields, change the WRITE path so new entries are correct and let old rows age out.
- **Hebrew copy needs care**: dual forms ("שלשום"), avoid bare prepositions ("ל" without infinitive), prefer warm forward-looking verbs over formal scheduling words.
- **Repo dev artifacts** (don't delete unprompted): `temp_prompt.txt`, `pool-full-dump.txt`, `*.cjs` validation scripts in root.
- **Sensitive user data**: `Poker results.xlsx`, `poker-export-*.xlsx` — never commit modifications.
- **`markGamePlayersLocallyWritten` is mandatory**: every gp mutator in `storage.ts` MUST call it after editing local gp rows, otherwise the scoped upsert will SKIP that game and the change won't reach the server. Currently wired into: `createGame`, `addPlayerToGame`, `updateGamePlayerRebuys`, `updateGamePlayerChips`, `updateGamePlayerResults`, `updateGamePlayerEntryMode`, `renamePlayer`. If you add a new gp mutator, you MUST mark or you've introduced silent-data-loss.
- **mig 091's guard fires on every `status='completed'` transition** — both `UPDATE games SET status='completed'` AND `INSERT INTO games (..., status='completed')`. Don't try to direct-insert a completed game for a backfill without players in the same transaction.
- **Selfie chip color extraction is retired** (v5.60.14).
- **Chip-count feedback loop is fully retired** (v5.62.2).
- **Chip-count telemetry** (v5.62.4): `chip_count_debug` table; **chip-count corrections** (v6.3.0): `chip_count_corrections` table has photo bytes.
- **AI per-color confidence** (v6.3.1): may be null on salvage strategies 4-5; fall back to `FALLBACK_CONFIDENCE = 60`.
- **Chip-count model chain is single-model** (v6.4.1): `[gemini-3-flash-preview]`, 2 attempts max. Removing the `gemini-2.5-flash` fallback was a strict improvement.
- **Schema example numbers matter** in chip-count prompts (v6.4.1): use `7/14/0/17/3/0` not `5/3/0/0/0/0` to dodge LLM small-number anchor bias.

## Spot-check queries when debugging

```sql
-- Zero-player completed games (should always be 0 now thanks to mig 091)
SELECT g.id, g.name AS group_name, gm.id AS game_id, gm.date, gm.completed_at
FROM games gm
JOIN groups g ON g.id = gm.group_id
LEFT JOIN game_players gp ON gp.game_id = gm.id
WHERE gm.status = 'completed'
GROUP BY g.id, g.name, gm.id, gm.date, gm.completed_at
HAVING count(gp.id) = 0;

-- Recent audit-log activity (last 7 days)
SELECT to_char(occurred_at AT TIME ZONE 'Asia/Jerusalem','MM-DD HH24:MI:SS') AS at_il,
       op, game_id, actor_email, notes
FROM game_audit_log
WHERE occurred_at >= now() - interval '7 days'
ORDER BY occurred_at DESC;

-- Chip corrections + telemetry
SELECT created_at, model, total_diff, ai_counts, truth_counts
FROM chip_count_corrections ORDER BY created_at DESC LIMIT 20;
SELECT created_at, model, outcome, http_status, final_counts
FROM chip_count_debug ORDER BY created_at DESC LIMIT 20;
```
