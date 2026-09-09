-- Poll invariant suite
--
-- Exercises the deployed poll RPCs (cast_poll_vote, expand_game_poll) against
-- synthetic polls, then throws everything away. Run the whole file as one
-- statement — it opens a transaction and ends in ROLLBACK, so nothing persists
-- and no notification is dispatched.
--
-- WHY THIS EXISTS
-- The poll rules are spread across migrations 104-112. Each one is correct in
-- isolation; the bugs live in the seams between them. Reading the files one at
-- a time cannot find those. Migration 112 fixed a case where a poll opened to
-- guests while the only votable date was full — caught by asserting a property,
-- not by reading code. Scenario 3 below is that case.
--
-- THE INVARIANTS BEING ASSERTED
--   I1  Open to guests implies a guest can actually cast a yes somewhere.
--   I2  Seats held by permanent maybes are not offered to guests until the
--       hold lapses at created_at + delay + hold.
--   I3  Yes votes on a date never exceed target_player_count.
--   I4  A picked date is the only votable one; rival dates reject votes.
--   I5  Excluded dates neither accept votes nor donate seats to the gate.
--   I6  A frozen poll rejects every vote.
--   I7  Expansion is monotonic and idempotent.
--   I8  Only group members can drive expansion.
--   I9  Every transition that changes who can vote announces itself exactly once.
--  I10  The cron sweep reaches the same verdict as the client-driven RPC.
--  I11  Nothing is delivered outside 07:00-23:00, by either worker.
--  I12  A nudge reaches only people it still applies to, exactly once per slot.
--  I13  Vote-change notifications follow the person's switch, not their role.
--  I14  The full-game channel reopens only when the game is genuinely not full.
--
-- ADDING A SCENARIO
-- Start from an invariant, not from the code. Ask which combination of
-- {picked, seats, elapsed time, voter tier, frozen, excluded} could violate it,
-- then assert the outcome. If you find yourself transcribing an existing WHERE
-- clause into a test, you are testing the implementation, not the rule.

BEGIN;

-- Second guard against outbound HTTP. pg_net queues into a table and would roll
-- back anyway, but a rolled-back DDL disable costs nothing and removes the doubt.
ALTER TABLE notification_jobs DISABLE TRIGGER trg_http_dispatch_notification_job;

CREATE TEMP TABLE res(n int, invariant text, scenario text, expected text, actual text, pass boolean) ON COMMIT DROP;

-- Build an open poll aged `age` into the past, with 1 or 2 proposed dates.
CREATE FUNCTION pg_temp.mkpoll(g uuid, owner uuid, target int, ndates int, age interval)
RETURNS uuid LANGUAGE plpgsql AS $f$
DECLARE p uuid;
BEGIN
  INSERT INTO game_polls(group_id, created_by, status, target_player_count,
                         expansion_delay_hours, maybe_hold_hours, allow_maybe, created_at)
  VALUES (g, owner, 'open', target, 24, 48, true, now() - age)
  RETURNING id INTO p;
  INSERT INTO game_poll_dates(poll_id, proposed_date) VALUES (p, current_date + 3);
  IF ndates > 1 THEN
    INSERT INTO game_poll_dates(poll_id, proposed_date) VALUES (p, current_date + 5);
  END IF;
  RETURN p;
END $f$;

-- Cast a vote as `u`. Returns 'ok' or the RPC's error code, never raises, so a
-- rejection under test does not abort the surrounding transaction.
CREATE FUNCTION pg_temp.vote(u uuid, d uuid, r text) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u)::text, true);
  PERFORM cast_poll_vote(d, r);
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN RETURN SQLERRM;
END $f$;

CREATE FUNCTION pg_temp.tryexpand(u uuid, p uuid) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', u)::text, true);
  PERFORM expand_game_poll(p);
  RETURN 'ok';
EXCEPTION WHEN OTHERS THEN RETURN SQLERRM;
END $f$;

CREATE FUNCTION pg_temp.expanded(p uuid) RETURNS text LANGUAGE sql AS $f$
  SELECT CASE WHEN expanded_at IS NULL THEN 'closed' ELSE 'open to guests' END
    FROM game_polls WHERE id = p;
$f$;

DO $harness$
DECLARE
  g uuid; p uuid; dPick uuid; dRival uuid; r text; i int; n int;
  ts timestamptz; hr int;
  pu uuid[];   -- linked permanent accounts
  gu uuid;     -- a linked non-permanent account
BEGIN
  SELECT id INTO g FROM groups WHERE name = 'Poker Night';
  IF g IS NULL THEN
    RAISE EXCEPTION 'fixture group not found — point this at a real group';
  END IF;

  SELECT array_agg(gm.user_id ORDER BY pl.name) INTO pu
    FROM players pl JOIN group_members gm ON gm.player_id = pl.id
   WHERE pl.group_id = g AND pl.type = 'permanent';

  SELECT gm.user_id INTO gu
    FROM players pl JOIN group_members gm ON gm.player_id = pl.id
   WHERE pl.group_id = g AND pl.type <> 'permanent'
   ORDER BY pl.name LIMIT 1;

  IF coalesce(array_length(pu, 1), 0) < 8 OR gu IS NULL THEN
    RAISE EXCEPTION 'need 8 linked permanents and 1 linked guest, found % and %',
      coalesce(array_length(pu, 1), 0), gu;
  END IF;

  ------------------------------------------------------------------ I1, I2
  -- No pick. The first date is spoken for (5 yes + 2 permanent holds vs 7) but
  -- the rival date is wide open, so guests have somewhere real to go.
  p := pg_temp.mkpoll(g, pu[1], 7, 2, interval '0 hours');
  SELECT id INTO dPick  FROM game_poll_dates WHERE poll_id = p ORDER BY proposed_date LIMIT 1;
  SELECT id INTO dRival FROM game_poll_dates WHERE poll_id = p ORDER BY proposed_date DESC LIMIT 1;
  FOR i IN 1..5 LOOP PERFORM pg_temp.vote(pu[i], dPick, 'yes'); END LOOP;
  PERFORM pg_temp.vote(pu[6], dPick, 'no');
  PERFORM pg_temp.vote(pu[7], dPick, 'maybe');
  PERFORM pg_temp.vote(pu[8], dPick, 'maybe');
  PERFORM pg_temp.tryexpand(pu[1], p);
  INSERT INTO res VALUES (1, 'I1', 'No pick, rival date free, everyone answered',
    'open to guests', pg_temp.expanded(p), pg_temp.expanded(p) = 'open to guests');
  r := pg_temp.vote(gu, dRival, 'yes');
  INSERT INTO res VALUES (2, 'I1', '  guest can actually claim the free rival seat',
    'ok', r, r = 'ok');

  ------------------------------------------------------------------ I1, I4
  -- Same board, but the full date is picked. Migration 106 funnels all voting to
  -- the pick, so the rival's free seats are unreachable and must not open the
  -- poll. This is the case migration 112 fixed; it failed before that.
  p := pg_temp.mkpoll(g, pu[1], 7, 2, interval '0 hours');
  SELECT id INTO dPick  FROM game_poll_dates WHERE poll_id = p ORDER BY proposed_date LIMIT 1;
  SELECT id INTO dRival FROM game_poll_dates WHERE poll_id = p ORDER BY proposed_date DESC LIMIT 1;
  FOR i IN 1..5 LOOP PERFORM pg_temp.vote(pu[i], dPick, 'yes'); END LOOP;
  PERFORM pg_temp.vote(pu[6], dPick, 'no');
  PERFORM pg_temp.vote(pu[7], dPick, 'maybe');
  PERFORM pg_temp.vote(pu[8], dPick, 'maybe');
  UPDATE game_polls SET status = 'confirmed', confirmed_date_id = dPick, confirmed_at = now() WHERE id = p;
  PERFORM pg_temp.tryexpand(pu[1], p);
  INSERT INTO res VALUES (3, 'I1', 'Picked date is full, rival has phantom seats',
    'closed', pg_temp.expanded(p), pg_temp.expanded(p) = 'closed');
  r := pg_temp.vote(gu, dRival, 'yes');
  INSERT INTO res VALUES (4, 'I4', '  rival date rejects votes once a date is picked',
    'date_not_picked', r, r = 'date_not_picked');

  ------------------------------------------------------------------ I1
  -- Single date, everyone answered, nothing free. The early trigger must not
  -- override the seat gate.
  p := pg_temp.mkpoll(g, pu[1], 7, 1, interval '0 hours');
  SELECT id INTO dPick FROM game_poll_dates WHERE poll_id = p;
  FOR i IN 1..5 LOOP PERFORM pg_temp.vote(pu[i], dPick, 'yes'); END LOOP;
  PERFORM pg_temp.vote(pu[6], dPick, 'no');
  PERFORM pg_temp.vote(pu[7], dPick, 'maybe');
  PERFORM pg_temp.vote(pu[8], dPick, 'maybe');
  PERFORM pg_temp.tryexpand(pu[1], p);
  INSERT INTO res VALUES (5, 'I1', 'Everyone answered but zero free seats',
    'closed', pg_temp.expanded(p), pg_temp.expanded(p) = 'closed');

  ------------------------------------------------------------------ I1
  -- The migration 111 trigger: everyone answered, seats genuinely free, and the
  -- 24h clock has not started running yet.
  p := pg_temp.mkpoll(g, pu[1], 7, 1, interval '0 hours');
  SELECT id INTO dPick FROM game_poll_dates WHERE poll_id = p;
  FOR i IN 1..5 LOOP PERFORM pg_temp.vote(pu[i], dPick, 'yes'); END LOOP;
  FOR i IN 6..8 LOOP PERFORM pg_temp.vote(pu[i], dPick, 'no');  END LOOP;
  PERFORM pg_temp.tryexpand(pu[1], p);
  INSERT INTO res VALUES (6, 'I1', 'Everyone answered, 2 seats free, 0h elapsed',
    'open to guests', pg_temp.expanded(p), pg_temp.expanded(p) = 'open to guests');

  ------------------------------------------------------------------ I1, I7
  -- Nobody near a full house, clock not elapsed: guests stay out, and repeated
  -- sweep calls must not drift the state.
  p := pg_temp.mkpoll(g, pu[1], 7, 1, interval '0 hours');
  SELECT id INTO dPick FROM game_poll_dates WHERE poll_id = p;
  FOR i IN 1..3 LOOP PERFORM pg_temp.vote(pu[i], dPick, 'yes'); END LOOP;
  r := pg_temp.vote(gu, dPick, 'yes');
  INSERT INTO res VALUES (7, 'I1', 'Guest votes during the permanents-only window',
    'tier_not_allowed', r, r = 'tier_not_allowed');
  PERFORM pg_temp.tryexpand(pu[1], p);
  PERFORM pg_temp.tryexpand(pu[1], p);
  INSERT INTO res VALUES (8, 'I7', 'Partial answers, delay not elapsed, swept twice',
    'closed', pg_temp.expanded(p), pg_temp.expanded(p) = 'closed');

  ------------------------------------------------------------------ I1
  -- The plain 24h path, with nobody having filled anything.
  p := pg_temp.mkpoll(g, pu[1], 7, 1, interval '25 hours');
  SELECT id INTO dPick FROM game_poll_dates WHERE poll_id = p;
  FOR i IN 1..3 LOOP PERFORM pg_temp.vote(pu[i], dPick, 'yes'); END LOOP;
  PERFORM pg_temp.tryexpand(pu[1], p);
  INSERT INTO res VALUES (9, 'I1', '25h old, partial answers, seats free',
    'open to guests', pg_temp.expanded(p), pg_temp.expanded(p) = 'open to guests');

  ------------------------------------------------------------------ I2
  -- Delay elapsed but the holds have not: 5 yes + 2 permanent maybes = a full
  -- table as far as guests are concerned.
  p := pg_temp.mkpoll(g, pu[1], 7, 1, interval '25 hours');
  SELECT id INTO dPick FROM game_poll_dates WHERE poll_id = p;
  FOR i IN 1..5 LOOP PERFORM pg_temp.vote(pu[i], dPick, 'yes'); END LOOP;
  PERFORM pg_temp.vote(pu[6], dPick, 'maybe');
  PERFORM pg_temp.vote(pu[7], dPick, 'maybe');
  PERFORM pg_temp.tryexpand(pu[1], p);
  INSERT INTO res VALUES (10, 'I2', 'Delay elapsed, maybe-holds still fill the table',
    'closed', pg_temp.expanded(p), pg_temp.expanded(p) = 'closed');

  ------------------------------------------------------------------ I2
  -- Identical board past the 72h cap: the holds lapse and those seats reappear.
  p := pg_temp.mkpoll(g, pu[1], 7, 1, interval '73 hours');
  SELECT id INTO dPick FROM game_poll_dates WHERE poll_id = p;
  FOR i IN 1..5 LOOP PERFORM pg_temp.vote(pu[i], dPick, 'yes'); END LOOP;
  PERFORM pg_temp.vote(pu[6], dPick, 'maybe');
  PERFORM pg_temp.vote(pu[7], dPick, 'maybe');
  PERFORM pg_temp.tryexpand(pu[1], p);
  INSERT INTO res VALUES (11, 'I2', 'Past the 72h cap, holds lapse, seats reappear',
    'open to guests', pg_temp.expanded(p), pg_temp.expanded(p) = 'open to guests');

  ------------------------------------------------------------------ I2
  -- The seat_held path: the poll legitimately opened with one seat free, then a
  -- permanent turned that seat into a hold before any guest claimed it.
  p := pg_temp.mkpoll(g, pu[1], 7, 1, interval '25 hours');
  SELECT id INTO dPick FROM game_poll_dates WHERE poll_id = p;
  FOR i IN 1..4 LOOP PERFORM pg_temp.vote(pu[i], dPick, 'yes'); END LOOP;
  PERFORM pg_temp.vote(pu[5], dPick, 'maybe');
  PERFORM pg_temp.vote(pu[6], dPick, 'maybe');
  PERFORM pg_temp.tryexpand(pu[1], p);
  PERFORM pg_temp.vote(pu[7], dPick, 'maybe');
  r := pg_temp.vote(gu, dPick, 'yes');
  INSERT INTO res VALUES (12, 'I2', 'Guest arrives after a permanent hold took the last seat',
    'seat_held', r, r = 'seat_held');

  ------------------------------------------------------------------ I1
  -- Tier gate lapses on its own past the cap, even with no expansion stamp —
  -- the fallback that keeps a stalled client sweep from locking guests out.
  p := pg_temp.mkpoll(g, pu[1], 7, 1, interval '73 hours');
  SELECT id INTO dPick FROM game_poll_dates WHERE poll_id = p;
  PERFORM pg_temp.vote(pu[1], dPick, 'yes');
  r := pg_temp.vote(gu, dPick, 'yes');
  INSERT INTO res VALUES (13, 'I1', 'Guest votes past the cap with no expansion stamp',
    'ok', r, r = 'ok');

  ------------------------------------------------------------------ I3
  p := pg_temp.mkpoll(g, pu[1], 7, 1, interval '73 hours');
  SELECT id INTO dPick FROM game_poll_dates WHERE poll_id = p;
  FOR i IN 1..7 LOOP PERFORM pg_temp.vote(pu[i], dPick, 'yes'); END LOOP;
  r := pg_temp.vote(gu, dPick, 'yes');
  INSERT INTO res VALUES (14, 'I3', 'Guest yes on a table already at target',
    'seat_full', r, r = 'seat_full');

  ------------------------------------------------------------------ I6
  p := pg_temp.mkpoll(g, pu[1], 7, 1, interval '25 hours');
  SELECT id INTO dPick FROM game_poll_dates WHERE poll_id = p;
  UPDATE game_polls SET voting_locked_at = now() WHERE id = p;
  r := pg_temp.vote(pu[1], dPick, 'yes');
  INSERT INTO res VALUES (15, 'I6', 'Permanent votes while the poll is frozen',
    'voting_locked', r, r = 'voting_locked');
  r := pg_temp.vote(gu, dPick, 'yes');
  INSERT INTO res VALUES (16, 'I6', 'Guest votes while the poll is frozen',
    'voting_locked', r, r = 'voting_locked');

  ------------------------------------------------------------------ I5
  p := pg_temp.mkpoll(g, pu[1], 7, 2, interval '25 hours');
  SELECT id INTO dPick  FROM game_poll_dates WHERE poll_id = p ORDER BY proposed_date LIMIT 1;
  SELECT id INTO dRival FROM game_poll_dates WHERE poll_id = p ORDER BY proposed_date DESC LIMIT 1;
  FOR i IN 1..7 LOOP PERFORM pg_temp.vote(pu[i], dPick, 'yes'); END LOOP;
  UPDATE game_poll_dates SET disabled_at = now() WHERE id = dRival;
  PERFORM pg_temp.tryexpand(pu[1], p);
  INSERT INTO res VALUES (17, 'I5', 'The only free seats sit on an excluded date',
    'closed', pg_temp.expanded(p), pg_temp.expanded(p) = 'closed');
  r := pg_temp.vote(gu, dRival, 'yes');
  INSERT INTO res VALUES (18, 'I5', '  excluded date rejects votes',
    'date_disabled', r, r = 'date_disabled');

  ------------------------------------------------------------------ I7
  -- Once open, a later sweep must not un-open it even as holds shift around.
  p := pg_temp.mkpoll(g, pu[1], 7, 1, interval '25 hours');
  SELECT id INTO dPick FROM game_poll_dates WHERE poll_id = p;
  FOR i IN 1..3 LOOP PERFORM pg_temp.vote(pu[i], dPick, 'yes'); END LOOP;
  PERFORM pg_temp.tryexpand(pu[1], p);
  FOR i IN 4..7 LOOP PERFORM pg_temp.vote(pu[i], dPick, 'yes'); END LOOP;
  PERFORM pg_temp.tryexpand(pu[1], p);
  INSERT INTO res VALUES (19, 'I7', 'Table fills after opening, swept again',
    'open to guests', pg_temp.expanded(p), pg_temp.expanded(p) = 'open to guests');

  ------------------------------------------------------------------ I8
  p := pg_temp.mkpoll(g, pu[1], 7, 1, interval '25 hours');
  r := pg_temp.tryexpand('00000000-0000-0000-0000-0000000000ff', p);
  INSERT INTO res VALUES (20, 'I8', 'Non-member calls expand',
    'not_member', r, r = 'not_member');

  ------------------------------------------------------------------ I9
  -- Migration 113. A picked poll keeps status 'confirmed' while expanded_at is
  -- stamped underneath it, so a status-keyed announcement never fired and
  -- guests were let in silently.
  p := pg_temp.mkpoll(g, pu[1], 7, 2, interval '25 hours');
  SELECT id INTO dPick FROM game_poll_dates WHERE poll_id = p ORDER BY proposed_date LIMIT 1;
  FOR i IN 1..3 LOOP PERFORM pg_temp.vote(pu[i], dPick, 'yes'); END LOOP;
  UPDATE game_polls SET status = 'confirmed', confirmed_date_id = dPick, confirmed_at = now() WHERE id = p;
  PERFORM pg_temp.tryexpand(pu[1], p);
  SELECT count(*) INTO n FROM notification_jobs WHERE poll_id = p AND kind = 'expanded';
  INSERT INTO res VALUES (21, 'I9', 'Picked poll opening to guests announces once',
    '1', n::text, n = 1);
  PERFORM pg_temp.tryexpand(pu[1], p);
  SELECT count(*) INTO n FROM notification_jobs WHERE poll_id = p AND kind = 'expanded';
  INSERT INTO res VALUES (22, 'I9', '  re-sweeping does not announce again',
    '1', n::text, n = 1);

  p := pg_temp.mkpoll(g, pu[1], 7, 1, interval '25 hours');
  SELECT id INTO dPick FROM game_poll_dates WHERE poll_id = p;
  PERFORM pg_temp.vote(pu[1], dPick, 'yes');
  PERFORM pg_temp.tryexpand(pu[1], p);
  SELECT count(*) INTO n FROM notification_jobs WHERE poll_id = p AND kind = 'expanded';
  INSERT INTO res VALUES (23, 'I9', 'Open poll opening to guests announces once, not twice',
    '1', n::text, n = 1);

  ------------------------------------------------------------------ I10
  -- Migration 114. The cron sweep and expand_game_poll share
  -- fn_expand_poll_internal, so they must agree on every board. Note this
  -- scenario is inert outside 08:00-23:00 Asia/Jerusalem by design.
  IF extract(hour from (now() AT TIME ZONE 'Asia/Jerusalem'))::int BETWEEN 8 AND 22 THEN
    p := pg_temp.mkpoll(g, pu[1], 7, 1, interval '25 hours');
    SELECT id INTO dPick FROM game_poll_dates WHERE poll_id = p;
    FOR i IN 1..3 LOOP PERFORM pg_temp.vote(pu[i], dPick, 'yes'); END LOOP;
    PERFORM fn_sweep_expand_polls();
    INSERT INTO res VALUES (24, 'I10', 'Sweep opens an eligible poll with no client running',
      'open to guests', pg_temp.expanded(p), pg_temp.expanded(p) = 'open to guests');

    p := pg_temp.mkpoll(g, pu[1], 7, 2, interval '25 hours');
    SELECT id INTO dPick FROM game_poll_dates WHERE poll_id = p ORDER BY proposed_date LIMIT 1;
    FOR i IN 1..7 LOOP PERFORM pg_temp.vote(pu[i], dPick, 'yes'); END LOOP;
    UPDATE game_polls SET status = 'confirmed', confirmed_date_id = dPick, confirmed_at = now() WHERE id = p;
    PERFORM fn_sweep_expand_polls();
    INSERT INTO res VALUES (25, 'I10', 'Sweep respects the picked-date seat check',
      'closed', pg_temp.expanded(p), pg_temp.expanded(p) = 'closed');
  END IF;

  ------------------------------------------------------------------ I11
  -- Migration 117. Asserted as a property rather than against a fixed clock:
  -- whatever hour the suite runs at, the next delivery slot has to be inside
  -- the waking window and never behind us. A regression that returned now()
  -- unconditionally would pass at noon and fail at 03:00 — this catches it
  -- at any hour.
  SELECT fn_next_delivery_slot() INTO ts;
  n := extract(hour from (ts AT TIME ZONE 'Asia/Jerusalem'))::int;
  INSERT INTO res VALUES (26, 'I11', 'Next delivery slot lands inside 07:00-23:00',
    'true', (n BETWEEN 7 AND 22)::text, n BETWEEN 7 AND 22);
  INSERT INTO res VALUES (27, 'I11', '  and never in the past',
    'true', (ts >= now() - interval '1 second')::text, ts >= now() - interval '1 second');

  -- A parked job is invisible to the browser claim. Without this the quiet
  -- window would only be honoured by the server worker, and any open tab
  -- would happily drain the queue at 03:00.
  --
  -- Earlier scenarios left claimable jobs in this group's queue, and the claim
  -- returns whichever one is oldest. Park them all first so the assertion can
  -- only be satisfied by the run_after filter, then unpark to prove the empty
  -- result was the filter talking and not some unrelated gate.
  UPDATE notification_jobs SET run_after = now() + interval '9 hours'
   WHERE group_id = g AND status = 'pending';
  p := pg_temp.mkpoll(g, pu[1], 7, 1, interval '25 hours');
  INSERT INTO notification_jobs (group_id, poll_id, kind, payload, run_after)
  VALUES (g, p, 'creation', '{}'::jsonb, now() + interval '4 hours');
  PERFORM set_config('request.jwt.claims', json_build_object('sub', pu[1])::text, true);
  SELECT count(*) INTO n FROM claim_notification_job(g);
  INSERT INTO res VALUES (28, 'I11', 'Browser claim skips every job inside quiet hours',
    '0', n::text, n = 0);

  UPDATE notification_jobs SET run_after = now() - interval '1 minute' WHERE poll_id = p;
  SELECT count(*) INTO n FROM claim_notification_job(g) c WHERE c.poll_id = p;
  INSERT INTO res VALUES (29, 'I11', '  and claims the same job once its slot arrives',
    '1', n::text, n = 1);

  ------------------------------------------------------------------ I12
  -- Migration 120. The sweep's hour arguments exist for exactly this: pin the
  -- slot to the current hour so the assertion is deterministic whenever the
  -- suite runs. The poll is aged to 00:30 local so its expansion lands
  -- tomorrow, putting the "day before" nudge slot on today at that hour.
  hr := extract(hour from (now() AT TIME ZONE 'Asia/Jerusalem'))::int;
  p := pg_temp.mkpoll(g, pu[1], 7, 1, interval '0 hours');
  UPDATE game_polls
     SET created_at = date_trunc('day', now() AT TIME ZONE 'Asia/Jerusalem')
                        AT TIME ZONE 'Asia/Jerusalem' + interval '30 minutes'
   WHERE id = p;
  PERFORM fn_sweep_poll_reminders(hr, hr);
  SELECT count(*) INTO n
    FROM notification_jobs WHERE poll_id = p AND kind = 'reminder_no_vote';
  INSERT INTO res VALUES (30, 'I12', 'Nobody answered, nudge slot is live',
    '1', n::text, n = 1);

  SELECT jsonb_array_length(payload->'recipient_player_names') INTO n
    FROM notification_jobs WHERE poll_id = p AND kind = 'reminder_no_vote';
  SELECT count(*) INTO i FROM players WHERE group_id = g AND type = 'permanent';
  INSERT INTO res VALUES (31, 'I12', '  and it names every permanent who is silent',
    i::text, n::text, n = i);

  -- The log, not the queue, is what makes this idempotent. A second sweep in
  -- the same window must be inert — the cron runs every 15 minutes and the
  -- slot is two hours wide, so this fires eight times per nudge in production.
  PERFORM fn_sweep_poll_reminders(hr, hr);
  SELECT count(*) INTO n
    FROM notification_jobs WHERE poll_id = p AND kind = 'reminder_no_vote';
  INSERT INTO res VALUES (32, 'I12', '  re-sweeping the same slot does not re-nudge',
    '1', n::text, n = 1);

  -- Guests are admitted, so "vote before the guests" is no longer true.
  p := pg_temp.mkpoll(g, pu[1], 7, 1, interval '0 hours');
  UPDATE game_polls
     SET created_at = date_trunc('day', now() AT TIME ZONE 'Asia/Jerusalem')
                        AT TIME ZONE 'Asia/Jerusalem' + interval '30 minutes',
         expanded_at = now()
   WHERE id = p;
  PERFORM fn_sweep_poll_reminders(hr, hr);
  SELECT count(*) INTO n
    FROM notification_jobs WHERE poll_id = p AND kind = 'reminder_no_vote';
  INSERT INTO res VALUES (33, 'I12', 'Already open to guests, so no non-voter nudge',
    '0', n::text, n = 0);

  -- A permanent who answered is not a non-voter, whatever they answered.
  p := pg_temp.mkpoll(g, pu[1], 7, 1, interval '0 hours');
  SELECT id INTO dPick FROM game_poll_dates WHERE poll_id = p;
  PERFORM pg_temp.vote(pu[1], dPick, 'maybe');
  UPDATE game_polls
     SET created_at = date_trunc('day', now() AT TIME ZONE 'Asia/Jerusalem')
                        AT TIME ZONE 'Asia/Jerusalem' + interval '30 minutes'
   WHERE id = p;
  PERFORM fn_sweep_poll_reminders(hr, hr);
  SELECT jsonb_array_length(payload->'recipient_player_names') INTO n
    FROM notification_jobs WHERE poll_id = p AND kind = 'reminder_no_vote';
  SELECT count(*) INTO i FROM players WHERE group_id = g AND type = 'permanent';
  INSERT INTO res VALUES (34, 'I12', 'An "אעדכן" answer counts as having voted',
    (i - 1)::text, n::text, n = i - 1);

  ------------------------------------------------------------------ I13
  -- Migration 118. Vote-change is a per-person switch, not a role perk. Being
  -- an admin used to be enough to receive them, which is the whole reason
  -- ליכטר could not turn them off.
  p := pg_temp.mkpoll(g, pu[1], 7, 1, interval '0 hours');
  UPDATE group_members SET schedule_vote_change_notifs = false
   WHERE group_id = g AND user_id = pu[1];
  SELECT count(*) INTO n FROM get_poll_change_recipients(p) rcp
   WHERE rcp.player_name = (SELECT pl.name FROM players pl
                              JOIN group_members gm ON gm.player_id = pl.id
                             WHERE gm.user_id = pu[1] AND pl.group_id = g);
  INSERT INTO res VALUES (35, 'I13', 'Opted-out member is excluded whatever their role',
    '0', n::text, n = 0);

  UPDATE group_members SET schedule_vote_change_notifs = true
   WHERE group_id = g AND user_id = pu[1];
  SELECT count(*) INTO n FROM get_poll_change_recipients(p) rcp
   WHERE rcp.player_name = (SELECT pl.name FROM players pl
                              JOIN group_members gm ON gm.player_id = pl.id
                             WHERE gm.user_id = pu[1] AND pl.group_id = g);
  INSERT INTO res VALUES (36, 'I13', '  and opted back in without an admin role',
    '1', n::text, n = 1);

  ------------------------------------------------------------------ I14
  -- Migration 119. The "game is full" sentinel mutes the channel for good, so
  -- a worker that skips a stale full-game notice has to be able to clear it —
  -- but only when the game really did empty out. Clearing it on a still-full
  -- poll would let the announcement fire twice.
  p := pg_temp.mkpoll(g, pu[1], 7, 1, interval '73 hours');
  SELECT id INTO dPick FROM game_poll_dates WHERE poll_id = p;
  FOR i IN 1..7 LOOP PERFORM pg_temp.vote(pu[i], dPick, 'yes'); END LOOP;
  UPDATE game_polls SET status = 'confirmed', confirmed_date_id = dPick,
                        confirmed_at = now(), target_filled_notifications_sent_at = now()
   WHERE id = p;
  SELECT reopen_target_filled_channel(p)::text INTO r;
  INSERT INTO res VALUES (37, 'I14', 'Still-full game keeps its channel muted',
    'false', r, r = 'false');

  -- Someone dropped out between the enqueue and the delivery.
  DELETE FROM game_poll_votes WHERE date_id = dPick AND player_id = (
    SELECT pl.id FROM players pl JOIN group_members gm ON gm.player_id = pl.id
     WHERE gm.user_id = pu[7] AND pl.group_id = g);
  SELECT reopen_target_filled_channel(p)::text INTO r;
  INSERT INTO res VALUES (38, 'I14', 'Game dipped below target, channel reopens',
    'true', r, r = 'true');
  SELECT count(*) INTO n FROM game_polls
   WHERE id = p AND target_filled_notifications_sent_at IS NULL;
  INSERT INTO res VALUES (39, 'I14', '  and the sentinel is actually cleared',
    '1', n::text, n = 1);
END $harness$;

SELECT n, invariant, scenario, expected, actual,
       CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END AS result
  FROM res ORDER BY n;

SELECT count(*) FILTER (WHERE pass)       AS passed,
       count(*) FILTER (WHERE NOT pass)   AS failed,
       count(*)                           AS total
  FROM res;

ROLLBACK;
