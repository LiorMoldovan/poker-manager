-- 105 — Allow fractional buy-ins (half rebuy) to persist
--
-- ROOT CAUSE of the Jun 27 weekend wipe:
--   game_players.rebuys was INTEGER. The app has long supported a
--   "half buy-in" (+0.5) in LiveGameScreen, which makes a player's
--   rebuys fractional (e.g. 3.5). Writing 3.5 to an INTEGER column is
--   rejected by Postgres with: invalid input syntax for type integer: "3.5".
--   Because game_players is upserted as a batch (statement-atomic), one
--   bad 3.5 row fails the ENTIRE batch. Before v6.8.11 that failure was
--   swallowed (the half was silently dropped, game still saved). v6.8.11
--   hardened the write path to throw + roll back the whole game on a
--   failed save — which turned the previously-silent half-buy-in loss
--   into a full game wipe (3 games deleted Jun 27 22:59 → Jun 28 02:38).
--
-- FIX: widen rebuys to NUMERIC so half buy-ins persist correctly.
--   Widening INTEGER -> NUMERIC is lossless and backward-compatible;
--   every existing value is a whole number and stays identical.
--   Client already reads rebuys via Number(row.rebuys), so a numeric
--   value returned by PostgREST (as a JSON number or string) hydrates
--   cleanly with no client change.

ALTER TABLE game_players
  ALTER COLUMN rebuys TYPE NUMERIC USING rebuys::numeric;

-- The DEFAULT and the CHECK (rebuys >= 0) constraint carry over and
-- remain valid for NUMERIC. Re-assert the default defensively.
ALTER TABLE game_players
  ALTER COLUMN rebuys SET DEFAULT 1;
