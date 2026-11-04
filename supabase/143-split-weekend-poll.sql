-- ============================================================
-- 143: One-off split of weekend poll af10a21c-95cf-4ca1-b4bc-06615d06b72b
--
-- Context:
-- Poll af10a21c-95cf-4ca1-b4bc-06615d06b72b had proposed dates for
-- Thursday 2026-11-05 (confirmed, 8 yes votes), Friday 2026-11-06 (disabled),
-- and Saturday 2026-11-07 (6 yes, 1 maybe, 3 no).
-- Because Thursday is confirmed/locked, Saturday is split into its own
-- separate active ('expanded') poll while preserving all existing Saturday
-- votes, timestamps, and expansion state without triggering duplicate emails.
-- ============================================================

DO $$
DECLARE
  v_orig_poll_id UUID := 'af10a21c-95cf-4ca1-b4bc-06615d06b72b';
  v_sat_date_id  UUID := 'ded64b12-6fdf-4b5e-952f-859e9a0be544';
  v_orig         game_polls%ROWTYPE;
  v_new_poll_id  UUID;
BEGIN
  -- Suppress poll notification triggers during this administrative split
  PERFORM set_config('app.suppress_poll_notifications', 'true', true);

  SELECT * INTO v_orig FROM game_polls WHERE id = v_orig_poll_id;
  IF v_orig.id IS NULL THEN
    RAISE NOTICE 'Original poll % not found — skipping.', v_orig_poll_id;
    RETURN;
  END IF;

  -- Idempotency check: only run if the Saturday date still belongs to the original poll
  IF NOT EXISTS (
    SELECT 1 FROM game_poll_dates
    WHERE id = v_sat_date_id AND poll_id = v_orig_poll_id
  ) THEN
    RAISE NOTICE 'Saturday date % already moved from poll % — skipping.', v_sat_date_id, v_orig_poll_id;
    RETURN;
  END IF;

  -- Create the separate poll for Saturday 2026-11-07 in 'expanded' status
  INSERT INTO game_polls (
    group_id,
    created_by,
    created_at,
    status,
    target_player_count,
    expansion_delay_hours,
    expanded_at,
    confirmed_date_id,
    confirmed_at,
    confirmed_game_id,
    note,
    default_location,
    allow_maybe,
    creation_notifications_sent_at,
    expanded_notifications_sent_at,
    created_source,
    created_by_name,
    maybe_hold_hours,
    reminder_evening_time
  ) VALUES (
    v_orig.group_id,
    v_orig.created_by,
    v_orig.created_at + interval '1 second',
    'expanded',
    v_orig.target_player_count,
    v_orig.expansion_delay_hours,
    v_orig.expanded_at,
    NULL,
    NULL,
    NULL,
    v_orig.note,
    NULL, -- Host for Saturday not set yet (Thursday's host ליכטר voted 'no' on Saturday)
    v_orig.allow_maybe,
    v_orig.creation_notifications_sent_at,
    v_orig.expanded_notifications_sent_at,
    v_orig.created_source,
    v_orig.created_by_name,
    v_orig.maybe_hold_hours,
    v_orig.reminder_evening_time
  )
  RETURNING id INTO v_new_poll_id;

  -- Move the Saturday date to the new poll
  UPDATE game_poll_dates
     SET poll_id = v_new_poll_id
   WHERE id = v_sat_date_id
     AND poll_id = v_orig_poll_id;

  -- Move all votes for Saturday to the new poll (does not fire response/comment triggers)
  UPDATE game_poll_votes
     SET poll_id = v_new_poll_id
   WHERE date_id = v_sat_date_id
     AND poll_id = v_orig_poll_id;

  -- Copy reminder logs so the cron sweep will not re-send old reminder slots
  INSERT INTO poll_reminder_log (poll_id, kind, slot, sent_at)
  SELECT v_new_poll_id, kind, slot, sent_at
    FROM poll_reminder_log
   WHERE poll_id = v_orig_poll_id
  ON CONFLICT (poll_id, kind, slot) DO NOTHING;

  RAISE NOTICE 'Split Saturday date % into new poll %', v_sat_date_id, v_new_poll_id;
END $$;

