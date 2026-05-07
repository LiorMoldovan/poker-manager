-- ============================================================
-- Migration 058: Auto-lock voting when seat target is hit
-- Run in Supabase SQL Editor after 057-training-super-admin-notifications.sql
-- (Idempotent — uses CREATE OR REPLACE.)
--
-- Why: Today, the `auto_close_poll_on_vote` trigger (migration 022)
--   transitions a poll to status='confirmed' when a date crosses
--   target_player_count yes-votes — but only while the poll is still
--   in 'open' or 'expanded'. Once an admin manually pins a date
--   below target (`manual_close_game_poll` from migration 038), the
--   poll is already 'confirmed' and the auto-close branch becomes a
--   no-op. The seat-cap trigger (migration 037) prevents new yes
--   votes past target, but voting is otherwise still live: members
--   can drop out (`yes`→`no`/`maybe`), late no-voters can flip, and
--   admins can keep proxy-poking the lineup. There's no automatic
--   "we're locked in, stop fiddling" signal beyond the 7/7 ratio
--   chip — admins have to remember to click 🔒 manually.
--
--   Real reproduction (poll c5051bfb-...-... on 2026-05-06): admin
--   pinned a date with 6/7 yes, the 7th yes-vote came in the next
--   day at 14:42, but voting stayed open until the admin manually
--   locked at 16:25 — a ~1h 43min window where someone could have
--   silently flipped the lineup.
--
-- Behavior:
--   * Same trigger fires AFTER INSERT OR UPDATE OF response on
--     game_poll_votes. Only acts on yes-votes (no-op for no/maybe
--     and for vote deletions).
--   * If the date that just hit target IS the confirmed_date_id
--     (either pre-existing from a manual pin, or just set by the
--     auto-confirm UPDATE in this same trigger), AND
--     voting_locked_at is currently NULL — set it to now().
--   * Idempotent: never overwrites a non-NULL voting_locked_at, so
--     a re-cast of an already-yes vote is a no-op and the original
--     auto-lock timestamp is preserved.
--   * NOT triggered when target is hit on a NON-confirmed date in
--     a multi-date poll (two dates can both reach target before an
--     admin pins). Locking the poll based on a leading-but-not-
--     pinned date would freeze voting against the admin's intent —
--     they may still want to repin to the other date.
--   * Admin can still manually unlock via set_poll_voting_lock to
--     allow late changes (e.g. "X needs to drop, swap them with Y").
--
-- Notification:
--   * The existing `target_filled` notification (migration 051)
--     already fires when the seat target is filled on a confirmed
--     date. It tells members "🎉 המשחק מלא — ניפגש!". That message
--     now matches reality: voting is actually frozen at the time of
--     the announcement, not just "you can probably stop checking".
--
-- Client UI:
--   * src/components/PollCard.tsx already renders the
--     "🔒 ההצבעה נעולה" banner whenever `votingLockedAt` is set, and
--     greys out RSVP buttons. Realtime sync (~500ms) propagates the
--     auto-lock to every member's open tab. No client changes
--     needed.
-- ============================================================

CREATE OR REPLACE FUNCTION auto_close_poll_on_vote()
RETURNS TRIGGER AS $$
DECLARE
  v_target          INT;
  v_yes_cnt         INT;
  v_confirmed_date  UUID;
BEGIN
  IF NEW.response <> 'yes' THEN
    RETURN NEW;
  END IF;

  SELECT target_player_count, confirmed_date_id
    INTO v_target, v_confirmed_date
    FROM game_polls WHERE id = NEW.poll_id;

  SELECT count(*) INTO v_yes_cnt
    FROM game_poll_votes
    WHERE date_id = NEW.date_id AND response = 'yes';

  IF v_yes_cnt >= v_target THEN
    -- Auto-confirm an open/expanded poll. Same row-locked WHERE
    -- guard as before — race-safe between concurrent yes-casts.
    UPDATE game_polls
       SET status = 'confirmed',
           confirmed_date_id = NEW.date_id,
           confirmed_at = now()
     WHERE id = NEW.poll_id
       AND status IN ('open', 'expanded');

    -- Auto-lock voting iff the date that just filled IS the
    -- pinned/confirmed date. Two cases that satisfy this:
    --   1. Auto-confirm above just set confirmed_date_id = NEW.date_id.
    --   2. Admin previously pinned NEW.date_id via manual_close_game_poll
    --      and the seat target was just reached.
    -- Idempotent via `voting_locked_at IS NULL` — never overwrites a
    -- pre-existing manual lock timestamp. The check on
    -- confirmed_date_id = NEW.date_id is also what keeps a
    -- multi-date "leader hits target before admin pins" from
    -- accidentally locking voting on the wrong date.
    UPDATE game_polls
       SET voting_locked_at = now()
     WHERE id = NEW.poll_id
       AND voting_locked_at IS NULL
       AND confirmed_date_id = NEW.date_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

-- Trigger binding is unchanged from 022; CREATE OR REPLACE FUNCTION
-- preserves it. No need to DROP+CREATE the trigger here.

-- ============================================================
-- DONE — Verify with:
--   -- 1. Function body now references voting_locked_at:
--   SELECT pg_get_functiondef('public.auto_close_poll_on_vote'::regproc);
--   -- expect a body that contains "voting_locked_at = now()"
--
--   -- 2. Trigger still bound:
--   SELECT tgname FROM pg_trigger WHERE tgname = 'trg_auto_close_poll_on_vote';
--   -- expect 1 row
--
--   -- 3. Reproduction smoke test (run against a test poll):
--   --    a. Create a poll with target=2, two dates A and B.
--   --    b. Cast yes from user 1 on A. → status='open', not locked.
--   --    c. Admin pins A via manual_close_game_poll. → status='confirmed',
--   --       confirmed_date_id=A, voting_locked_at=NULL.
--   --    d. Cast yes from user 2 on A. → THIS migration's path:
--   --       voting_locked_at = now(). status stays 'confirmed'.
--   --    e. cast_poll_vote on A from user 3 should now raise
--   --       'voting_locked' (existing 039 guard).
--
--   -- 4. Multi-date negative case (lock should NOT fire on the
--   --    non-confirmed date):
--   --    a. Poll with target=2, dates A and B, status='open'.
--   --    b. 2 yes on B → auto-confirm B → auto-lock B. Correct.
--   --    c. Reset and try with admin pinning A first: status='confirmed',
--   --       confirmed_date_id=A. Now cast 2 yes on B → seat-cap may
--   --       allow because B is not the confirmed date; trigger fires
--   --       but voting_locked_at stays NULL (confirmed_date_id != B).
-- ============================================================
