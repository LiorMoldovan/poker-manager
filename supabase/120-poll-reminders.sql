-- 120 — Automatic nudges for people who haven't committed
--
-- Two audiences, both permanents only, both push only:
--   reminder_no_vote — never answered at all
--   reminder_maybe   — answered only אעדכן and never came back
--
-- Guests are never nudged. Reminders until now were entirely manual: an
-- admin had to notice and press a button, which meant they mostly didn't
-- happen.
--
-- Timing derives from the deadline that actually affects each audience,
-- so the nudge always arrives while the recipient can still act on it.
--
--   expansion_at = created_at + expansion_delay_hours
--                  the moment guests are let in
--   release_at   = created_at + expansion_delay_hours + maybe_hold_hours
--                  the moment a held seat is handed to everyone else.
--                  Runs from creation, not expansion — matches the
--                  cast_poll_vote gate and src/utils/pollAccess.ts.
--
--   reminder_no_vote  slot 1 → 12:00 on the day before expansion_at
--                     slot 2 → 19:00 on the day before expansion_at
--   reminder_maybe    slot 1 → 19:00 two days before release_at
--                     slot 2 → 19:00 one day before release_at
--
-- For the standard Poker Night poll (Sunday 07:30, 24h delay, 48h hold)
-- that lands on Sun 12:00, Sun 19:00, Mon 19:00, Tue 19:00. Because the
-- slots are always whole days before their deadline, the copy can say
-- "מחר" and "מחרתיים" and be right by construction.
--
-- All four slots sit inside the 07:00-23:00 delivery window from migration
-- 117, so none of them get deferred.

-- ── 1. Widen the three kind whitelists ─────────────────────────────────────

ALTER TABLE notification_jobs DROP CONSTRAINT IF EXISTS notification_jobs_kind_check;
ALTER TABLE notification_jobs ADD CONSTRAINT notification_jobs_kind_check CHECK (
  kind = ANY (ARRAY[
    'creation','expanded','confirmed','cancellation','target_filled',
    'vote_change','reminder',
    'reminder_no_vote','reminder_maybe',
    'trivia_report_filed','trivia_report_resolved',
    'training_report_filed','training_report_resolved','training_milestone',
    'date_excluded'
  ])
);

-- Second whitelist. Body is otherwise identical to migration 117's, whose
-- run_after stamp and payload refresh must survive this replacement.
--
-- NOT added here: 'date_excluded'. It is in the table CHECK and in the
-- worker's Kind union, but missing from this list, so every attempt to
-- enqueue one raises invalid_kind — which is why notification_jobs has
-- never held a single date_excluded row. Adding it would switch on a
-- notification nobody asked for, so it stays broken-as-is pending a
-- decision. Flagged, not fixed.
CREATE OR REPLACE FUNCTION public.enqueue_notification(
  p_kind     text,
  p_group_id uuid,
  p_poll_id  uuid  DEFAULT NULL::uuid,
  p_payload  jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id UUID;
BEGIN
  IF p_kind NOT IN (
    'creation','expanded','confirmed','cancellation','target_filled',
    'vote_change','reminder',
    'reminder_no_vote','reminder_maybe',
    'trivia_report_filed','trivia_report_resolved',
    'training_report_filed','training_report_resolved','training_milestone'
  ) THEN
    RAISE EXCEPTION 'invalid_kind: %', p_kind;
  END IF;

  IF p_group_id IS NULL THEN
    RAISE EXCEPTION 'missing_group_id';
  END IF;

  BEGIN
    INSERT INTO notification_jobs (group_id, poll_id, kind, status, payload, run_after)
    VALUES (p_group_id, p_poll_id, p_kind, 'pending', p_payload, fn_next_delivery_slot())
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    UPDATE notification_jobs
       SET payload = p_payload
     WHERE poll_id = p_poll_id
       AND kind    = p_kind
       AND status  = 'pending'
    RETURNING id INTO v_id;

    IF v_id IS NULL THEN
      SELECT id INTO v_id
        FROM notification_jobs
        WHERE poll_id = p_poll_id
          AND kind = p_kind
          AND status IN ('pending','running')
        LIMIT 1;
    END IF;
  END;

  RETURN v_id;
END;
$function$;

-- The third whitelist is the browser worker's claim list in
-- claim_notification_job, and it is deliberately NOT widened. Reminders are
-- server-built; letting a browser claim one would strand it.

-- ── 2. Fired-slot ledger ───────────────────────────────────────────────────
--
-- Keyed by slot rather than by person on purpose. The cohort is recomputed
-- at every slot, so someone who votes between noon and evening simply isn't
-- in the evening list — no per-person bookkeeping required, and no way for
-- a nudge to chase someone who already acted.

CREATE TABLE IF NOT EXISTS poll_reminder_log (
  poll_id UUID        NOT NULL REFERENCES game_polls(id) ON DELETE CASCADE,
  kind    TEXT        NOT NULL CHECK (kind IN ('reminder_no_vote','reminder_maybe')),
  slot    SMALLINT    NOT NULL CHECK (slot IN (1, 2)),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (poll_id, kind, slot)
);

ALTER TABLE poll_reminder_log ENABLE ROW LEVEL SECURITY;

-- No policies: only the SECURITY DEFINER sweep touches this table. Members
-- have no reason to read it and nothing in the client queries it.

-- ── 3. Slot arithmetic ─────────────────────────────────────────────────────
--
-- "N days before the local calendar day of `deadline`, at `hour`:00 local."
-- Works in Israel wall clock so a nudge lands at 19:00 as a human
-- experiences it, not 19:00 UTC, and stays right across a DST shift.
-- STABLE rather than IMMUTABLE: named-timezone conversion depends on the
-- server's timezone database.

CREATE OR REPLACE FUNCTION public.fn_reminder_slot_at(
  p_deadline    TIMESTAMPTZ,
  p_days_before INT,
  p_hour        INT
)
RETURNS TIMESTAMPTZ
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT (
    date_trunc('day', p_deadline AT TIME ZONE 'Asia/Jerusalem')
      - make_interval(days => p_days_before)
      + make_interval(hours => p_hour)
  ) AT TIME ZONE 'Asia/Jerusalem';
$$;

-- ── 4. The sweep ───────────────────────────────────────────────────────────

-- Signature changed from () to (INT, INT) below, so the argument-less
-- version has to go rather than linger as an overload the cron might
-- resolve to.
DROP FUNCTION IF EXISTS public.fn_sweep_poll_reminders();

-- The two slot hours are parameters rather than literals purely so the
-- sweep can be exercised outside 12:00 and 19:00. cron calls it with no
-- arguments and gets the real schedule; the test suite passes the current
-- hour to drive a firing window on demand. Without this seam the enqueue
-- branch is only reachable twice a day and effectively never gets tested.
CREATE OR REPLACE FUNCTION public.fn_sweep_poll_reminders(
  p_noon_hour    INT DEFAULT 12,
  p_evening_hour INT DEFAULT 19
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_poll        RECORD;
  v_expansion   TIMESTAMPTZ;
  v_release     TIMESTAMPTZ;
  v_slot_time   TIMESTAMPTZ;
  v_names       TEXT[];
  v_title       TEXT;
  v_body        TEXT;
  v_yes_cnt     INT;
BEGIN
  FOR v_poll IN
    SELECT p.id, p.group_id, p.created_at, p.expanded_at, p.status,
           p.expansion_delay_hours, p.maybe_hold_hours,
           p.target_player_count, p.confirmed_date_id
      FROM game_polls p
     WHERE p.status IN ('open','expanded','confirmed')
       AND p.created_at > now() - interval '14 days'
  LOOP
    -- A game that already has everyone it needs has nothing to nudge about.
    IF v_poll.status = 'confirmed' THEN
      IF v_poll.confirmed_date_id IS NULL THEN
        CONTINUE;
      END IF;
      SELECT count(*) INTO v_yes_cnt
        FROM game_poll_votes
       WHERE date_id = v_poll.confirmed_date_id AND response = 'yes';
      IF v_yes_cnt >= v_poll.target_player_count THEN
        CONTINUE;
      END IF;
    END IF;

    v_expansion := v_poll.created_at + make_interval(hours => v_poll.expansion_delay_hours);
    v_release   := v_expansion + make_interval(hours => COALESCE(v_poll.maybe_hold_hours, 48));

    -- ── reminder_no_vote ──
    -- Only while permanents still have the poll to themselves. Once guests
    -- are in, "answer before they take your seat" is no longer true, and
    -- the maybe nudge covers the remaining deadline.
    IF v_poll.expanded_at IS NULL THEN
      FOR v_slot IN 1..2 LOOP
        v_slot_time := fn_reminder_slot_at(v_expansion, 1, CASE v_slot WHEN 1 THEN p_noon_hour ELSE p_evening_hour END);

        CONTINUE WHEN v_slot_time <= v_poll.created_at;
        CONTINUE WHEN now() < v_slot_time OR now() >= v_slot_time + interval '2 hours';
        CONTINUE WHEN EXISTS (
          SELECT 1 FROM poll_reminder_log
           WHERE poll_id = v_poll.id AND kind = 'reminder_no_vote' AND slot = v_slot
        );

        SELECT array_agg(pl.name ORDER BY pl.name) INTO v_names
          FROM players pl
         WHERE pl.group_id = v_poll.group_id
           AND pl.type     = 'permanent'
           AND NOT EXISTS (
             SELECT 1 FROM game_poll_votes v
              WHERE v.poll_id = v_poll.id AND v.player_id = pl.id
           );

        IF v_names IS NULL OR array_length(v_names, 1) IS NULL THEN
          -- Everyone answered. Record the slot so we don't re-scan it.
          INSERT INTO poll_reminder_log (poll_id, kind, slot)
          VALUES (v_poll.id, 'reminder_no_vote', v_slot)
          ON CONFLICT DO NOTHING;
          CONTINUE;
        END IF;

        IF v_slot = 1 THEN
          v_title := '🃏 טרם הצבעת בסקר';
          v_body  := 'מחר הסקר נפתח גם לאורחים. כדאי להצביע היום ולשמור מקום';
        ELSE
          v_title := '⏰ הזדמנות אחרונה לפני האורחים';
          v_body  := 'מחר המקומות נפתחים לכולם. מי שעוד לא הצביע — עכשיו הזמן';
        END IF;

        PERFORM enqueue_notification(
          'reminder_no_vote',
          v_poll.group_id,
          v_poll.id,
          jsonb_build_object(
            'push_title', v_title,
            'push_body',  v_body,
            'url',        '/schedule?pollId=' || v_poll.id::text,
            'recipient_player_names', to_jsonb(v_names)
          )
        );

        INSERT INTO poll_reminder_log (poll_id, kind, slot)
        VALUES (v_poll.id, 'reminder_no_vote', v_slot)
        ON CONFLICT DO NOTHING;
      END LOOP;
    END IF;

    -- ── reminder_maybe ──
    -- Permanents holding a seat on אעדכן with no yes anywhere in the poll.
    FOR v_slot IN 1..2 LOOP
      v_slot_time := fn_reminder_slot_at(v_release, CASE v_slot WHEN 1 THEN 2 ELSE 1 END, p_evening_hour);

      CONTINUE WHEN v_slot_time <= v_poll.created_at;
      CONTINUE WHEN now() < v_slot_time OR now() >= v_slot_time + interval '2 hours';
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM poll_reminder_log
         WHERE poll_id = v_poll.id AND kind = 'reminder_maybe' AND slot = v_slot
      );

      SELECT array_agg(pl.name ORDER BY pl.name) INTO v_names
        FROM players pl
       WHERE pl.group_id = v_poll.group_id
         AND pl.type     = 'permanent'
         AND EXISTS (
           SELECT 1 FROM game_poll_votes v
            WHERE v.poll_id = v_poll.id AND v.player_id = pl.id AND v.response = 'maybe'
         )
         AND NOT EXISTS (
           SELECT 1 FROM game_poll_votes v
            WHERE v.poll_id = v_poll.id AND v.player_id = pl.id AND v.response = 'yes'
         );

      IF v_names IS NULL OR array_length(v_names, 1) IS NULL THEN
        INSERT INTO poll_reminder_log (poll_id, kind, slot)
        VALUES (v_poll.id, 'reminder_maybe', v_slot)
        ON CONFLICT DO NOTHING;
        CONTINUE;
      END IF;

      IF v_slot = 1 THEN
        v_title := '🤔 עדיין "אעדכן"';
        v_body  := 'המקום שמור עד מחרתיים. אישור מוקדם עוזר לסגור את הערב';
      ELSE
        v_title := '⏳ המקום משתחרר מחר';
        v_body  := 'בלי אישור הגעה, המקום ייפתח לשאר השחקנים מחר';
      END IF;

      PERFORM enqueue_notification(
        'reminder_maybe',
        v_poll.group_id,
        v_poll.id,
        jsonb_build_object(
          'push_title', v_title,
          'push_body',  v_body,
          'url',        '/schedule?pollId=' || v_poll.id::text,
          'recipient_player_names', to_jsonb(v_names)
        )
      );

      INSERT INTO poll_reminder_log (poll_id, kind, slot)
      VALUES (v_poll.id, 'reminder_maybe', v_slot)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END LOOP;
END;
$$;

-- ── 5. Schedule + lock down ────────────────────────────────────────────────
--
-- Every 15 minutes. Each slot has a two-hour firing window, so a handful of
-- missed ticks (or a paused cron) still delivers.

REVOKE ALL ON FUNCTION public.fn_sweep_poll_reminders(INT,INT)         FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_reminder_slot_at(TIMESTAMPTZ,INT,INT) FROM PUBLIC, anon, authenticated;

SELECT cron.unschedule('poll-reminders-sweep')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'poll-reminders-sweep');

SELECT cron.schedule('poll-reminders-sweep', '*/15 * * * *', 'SELECT public.fn_sweep_poll_reminders();');
