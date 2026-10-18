-- ==============================================================================
-- Migration 138: Poll Maybe-Reminders Include Mixed Yes/Maybe Voters
--
-- Previously, fn_sweep_poll_reminders excluded any player from reminder_maybe
-- if they had voted 'yes' on ANY proposed date in the poll:
--   AND NOT EXISTS (SELECT 1 FROM game_poll_votes v WHERE ... AND v.response = 'yes')
--
-- This prevented players who confirmed for one date (e.g. Thursday) but also
-- answered 'maybe' for another date (e.g. Friday) from receiving a reminder
-- about the date they chose 'maybe' for.
--
-- This migration updates fn_sweep_poll_reminders:
-- 1. When poll is open/expanded: includes any permanent player who voted 'maybe'
--    on at least one proposed date, so they receive a reminder regarding their 'maybe' date(s).
-- 2. When poll is confirmed: only includes players who voted 'maybe' on the pinned date
--    and haven't confirmed 'yes' on that pinned date.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.fn_sweep_poll_reminders(
  p_noon_hour    INT DEFAULT 12,
  p_evening_hour INT DEFAULT 18
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_poll          RECORD;
  v_expansion     TIMESTAMPTZ;
  v_release       TIMESTAMPTZ;
  v_slot_time     TIMESTAMPTZ;
  v_names         TEXT[];
  v_title         TEXT;
  v_body          TEXT;
  v_yes_cnt       INT;
  v_rules         JSONB;
  v_rule          JSONB;
  v_kind          TEXT;
  v_slot          INT;
  v_days          INT;
  v_time          TIME;
  v_deadline      TIMESTAMPTZ;
  v_evening_time  TEXT;
  v_noon_time     TEXT;
  v_default_rules JSONB;
BEGIN
  FOR v_poll IN
    SELECT p.id, p.group_id, p.created_at, p.expanded_at, p.status,
           p.expansion_delay_hours, p.maybe_hold_hours,
           p.target_player_count, p.confirmed_date_id,
           COALESCE(
             NULLIF(p.reminder_evening_time, ''),
             NULLIF(s.schedule_reminder_evening_time, ''),
             CASE WHEN p_evening_hour IS NOT NULL AND p_evening_hour != 18
                  THEN lpad(p_evening_hour::text, 2, '0') || ':00'
                  ELSE '18:00' END
           ) AS evening_time_str,
           COALESCE(
             NULLIF(s.schedule_reminder_noon_time, ''),
             CASE WHEN p_noon_hour IS NOT NULL AND p_noon_hour != 12
                  THEN lpad(p_noon_hour::text, 2, '0') || ':00'
                  ELSE '12:00' END
           ) AS noon_time_str,
           s.schedule_reminders_config
      FROM game_polls p
      LEFT JOIN settings s ON s.group_id = p.group_id
     WHERE p.status IN ('open','expanded','confirmed')
       AND p.created_at > now() - interval '14 days'
  LOOP
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

    v_evening_time := v_poll.evening_time_str;
    v_noon_time    := v_poll.noon_time_str;

    -- Build default 4 rules if no custom schedule_reminders_config is saved
    v_default_rules := jsonb_build_array(
      jsonb_build_object(
        'id', 'no_vote_noon',
        'slot', 1,
        'kind', 'reminder_no_vote',
        'days_before', 1,
        'time', v_noon_time,
        'enabled', true,
        'label', 'תזכורת צהריים למי שטרם הצביע'
      ),
      jsonb_build_object(
        'id', 'no_vote_evening',
        'slot', 2,
        'kind', 'reminder_no_vote',
        'days_before', 1,
        'time', v_evening_time,
        'enabled', true,
        'label', 'תזכורת ערב לפני פתיחה לאורחים'
      ),
      jsonb_build_object(
        'id', 'maybe_first',
        'slot', 1,
        'kind', 'reminder_maybe',
        'days_before', 2,
        'time', v_evening_time,
        'enabled', true,
        'label', 'תזכורת ראשונה למתלבטים ("אעדכן")'
      ),
      jsonb_build_object(
        'id', 'maybe_final',
        'slot', 2,
        'kind', 'reminder_maybe',
        'days_before', 1,
        'time', v_evening_time,
        'enabled', true,
        'label', 'תזכורת אחרונה לפני שחרור מקום'
      )
    );

    IF v_poll.schedule_reminders_config IS NOT NULL
       AND jsonb_typeof(v_poll.schedule_reminders_config) = 'array'
       AND jsonb_array_length(v_poll.schedule_reminders_config) > 0
    THEN
      v_rules := v_poll.schedule_reminders_config;
    ELSE
      v_rules := v_default_rules;
    END IF;

    -- Iterate each reminder rule
    FOR v_rule IN SELECT * FROM jsonb_array_elements(v_rules)
    LOOP
      IF (v_rule->>'enabled')::boolean IS FALSE THEN
        CONTINUE;
      END IF;

      v_kind := v_rule->>'kind';
      v_slot := COALESCE((v_rule->>'slot')::int, 1);
      v_days := COALESCE((v_rule->>'daysBefore')::int, (v_rule->>'days_before')::int, 1);
      v_time := COALESCE(NULLIF(v_rule->>'time', '')::time, '18:00'::time);

      IF v_kind = 'reminder_no_vote' THEN
        -- No-vote reminders only fire while the poll is unexpanded
        IF v_poll.expanded_at IS NOT NULL THEN
          CONTINUE;
        END IF;
        v_deadline := v_expansion;
      ELSIF v_kind = 'reminder_maybe' THEN
        v_deadline := v_release;
      ELSE
        CONTINUE;
      END IF;

      v_slot_time := (
        date_trunc('day', v_deadline AT TIME ZONE 'Asia/Jerusalem')::date
        - make_interval(days => v_days)
        + v_time
      ) AT TIME ZONE 'Asia/Jerusalem';

      CONTINUE WHEN v_slot_time <= v_poll.created_at;
      CONTINUE WHEN now() < v_slot_time OR now() >= v_slot_time + interval '2 hours';
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM poll_reminder_log
         WHERE poll_id = v_poll.id AND kind = v_kind AND slot = v_slot
      );

      -- Build recipient list based on reminder kind
      IF v_kind = 'reminder_no_vote' THEN
        SELECT array_agg(pl.name ORDER BY pl.name) INTO v_names
          FROM players pl
         WHERE pl.group_id = v_poll.group_id
           AND pl.type     = 'permanent'
           AND NOT EXISTS (
             SELECT 1 FROM game_poll_votes v
              WHERE v.poll_id = v_poll.id AND v.player_id = pl.id
           );
      ELSIF v_kind = 'reminder_maybe' THEN
        -- If a date is pinned/confirmed, only remind those who answered 'maybe' for that date
        IF v_poll.status = 'confirmed' AND v_poll.confirmed_date_id IS NOT NULL THEN
          SELECT array_agg(pl.name ORDER BY pl.name) INTO v_names
            FROM players pl
           WHERE pl.group_id = v_poll.group_id
             AND pl.type     = 'permanent'
             AND EXISTS (
               SELECT 1 FROM game_poll_votes v
                WHERE v.poll_id = v_poll.id
                  AND v.date_id = v_poll.confirmed_date_id
                  AND v.player_id = pl.id
                  AND v.response = 'maybe'
             )
             AND NOT EXISTS (
               SELECT 1 FROM game_poll_votes v
                WHERE v.poll_id = v_poll.id
                  AND v.date_id = v_poll.confirmed_date_id
                  AND v.player_id = pl.id
                  AND v.response = 'yes'
             );
        ELSE
          -- Poll is open or expanded: include all permanent players who answered 'maybe'
          -- on at least one proposed date, even if they answered 'yes' on another date.
          SELECT array_agg(pl.name ORDER BY pl.name) INTO v_names
            FROM players pl
           WHERE pl.group_id = v_poll.group_id
             AND pl.type     = 'permanent'
             AND EXISTS (
               SELECT 1 FROM game_poll_votes v
                WHERE v.poll_id = v_poll.id AND v.player_id = pl.id AND v.response = 'maybe'
             );
        END IF;
      END IF;

      IF v_names IS NULL OR array_length(v_names, 1) IS NULL THEN
        INSERT INTO poll_reminder_log (poll_id, kind, slot)
        VALUES (v_poll.id, v_kind, v_slot)
        ON CONFLICT (poll_id, kind, slot) DO NOTHING;
        CONTINUE;
      END IF;

      -- Copy / dynamic text
      v_title := NULLIF(v_rule->>'title', '');
      v_body  := NULLIF(v_rule->>'body', '');

      IF v_title IS NULL THEN
        IF v_kind = 'reminder_no_vote' THEN
          IF v_days = 0 THEN
            v_title := '⏰ היום הסקר נפתח לאורחים';
            v_body  := 'היום המקומות נפתחים לכולם. מי שעוד לא הצביע — עכשיו הזמן לתפוס מקום';
          ELSIF v_slot = 1 AND v_days > 0 THEN
            v_title := '🃏 טרם הצבעת בסקר';
            v_body  := 'מחר הסקר נפתח גם לאורחים. כדאי להצביע היום ולשמור מקום';
          ELSE
            v_title := '⏰ הזדמנות אחרונה לפני האורחים';
            v_body  := 'מחר המקומות נפתחים לכולם. מי שעוד לא הצביע — עכשיו הזמן';
          END IF;
        ELSE -- reminder_maybe
          IF v_days = 0 THEN
            v_title := '⏳ המקום משתחרר היום';
            v_body  := 'היום המקום ייפתח לשאר השחקנים אם לא יאושר';
          ELSIF v_days >= 2 THEN
            v_title := '🤔 עדיין "אעדכן"';
            v_body  := 'המקום שמור עד מחרתיים. אישור מוקדם עוזר לסגור את הערב';
          ELSE
            v_title := '⏳ המקום משתחרר מחר';
            v_body  := 'בלי אישור הגעה, המקום ייפתח לשאר השחקנים מחר';
          END IF;
        END IF;
      END IF;

      PERFORM enqueue_notification(
        v_kind,
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
      VALUES (v_poll.id, v_kind, v_slot)
      ON CONFLICT (poll_id, kind, slot) DO NOTHING;
    END LOOP;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_sweep_poll_reminders(INT,INT) FROM PUBLIC, anon, authenticated;
