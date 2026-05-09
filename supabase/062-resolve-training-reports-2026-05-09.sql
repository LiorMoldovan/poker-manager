-- ─────────────────────────────────────────────────────────────────────────
-- One-off resolution of 10 training-question reports (all submitted by
-- חרדון, group d1998bed-7bae-4221-8877-20c537acfc43, 2026-05-09).
--
-- Authored by the assistant after a manual poker-logic review of every
-- reported scenario against:
--   • src/utils/pokerTraining.ts → GAME_CONTEXT (home-game philosophy:
--     casual play, ~8 players, opponents call light, "isolation" doesn't
--     work, value-bet over slow-play, fold to small bets only when no
--     pair / no draw)
--   • the existing answer key + nearMiss flags
--   • each reporter comment
--
-- VERDICT BREAKDOWN
--   REJECT (7) — question + answer key are sound; report is dismissed,
--                question stays in pool, no regrade:
--     1. bcw412   — 2nd pair vs aggro home-game small bet → call is correct
--     2. kdt8ml   — TPTK vs aggro home-game small bet → raise for value
--     3. 1kdqbh   — missed flush, board paired, K-high → fold is correct
--     4. po6rms   — A8o OOP vs tight UTG raise → fold (textbook)
--     5. 3qklzq   — TT in BB facing 4 limpers → check (raise wouldn't thin
--                   the field at all per the home-game rule)
--     6. ivn6eu   — 2nd pair vs aggressive Lichter, pot 2.5k facing 1.5k →
--                   call is consistent with the home-game philosophy
--     7. jf8qv1   — 2nd pair OOP, multiway, no aggression yet → check
--
--   ACCEPT (3) — question or answer key has a real flaw; AI-style hand
--                authored fix applied; flagReports cleared, past answers
--                regraded:
--     8. lszteu                       — top set on Q♥10♥9♠ (wet 2-flush
--                                       + straight-draw board): slow-play
--                                       is genuinely poor. CORRECT ANSWER
--                                       changed from A (check) → B (bet
--                                       1,800). A becomes nearMiss. The
--                                       fix matches GAME_CONTEXT rule
--                                       "value bet with strong hand =
--                                       correct, they will pay you".
--     9. math_1775389545260_tgeobz    — option A text said "8.5% נמוך
--                                       מהעלות 40%" but the explanation
--                                       (correctly) used 28.6%. The 40%
--                                       was a math bug; fixed to 28.6%.
--                                       No regrade — חרדון never answered
--                                       this scenario.
--    10. uyjqcx                       — boardCards field was MISSING
--                                       entirely (format bug — every
--                                       flush-draw scenario must declare
--                                       the 2-suited flop). Added board
--                                       9♥ 7♥ 2♣ which matches the
--                                       existing answer key (nut-flush
--                                       draw + two overcards → raising
--                                       in multiway pot is +EV).
--
-- DATA EFFECTS
--   • training_pool   — UPDATE 3 rows (the accepts), set new scenario
--                       JSONB + reviewedAt = now().
--   • training_answers — for חרדון:
--                          - clear flagReports[] entries for all 10 pool
--                            ids in every session
--                          - clear flaggedPoolIds[] entries for all 10
--                          - regrade his lszteu result (chosenId='B'):
--                              correct: false → true
--                              nearMiss: true → removed
--                          - recompute session.correctAnswers per session
--                          - recompute root stats.totalQuestions /
--                            totalCorrect / accuracy
--                       Net effect on stats: +1 question, +1 correct
--                       (lszteu graduated from nearMiss-excluded to a
--                       correct counted answer).
--   • push notifications — NOT fired by this migration (Vercel Edge
--                          Function /api/send-push requires Supabase
--                          JWT; sent separately via a one-off helper
--                          using the operator's session token).
--
-- IDEMPOTENCY
--   The file is idempotent: re-running it re-applies the same fixed
--   scenario JSONB (same content; reviewedAt bumps to the new now), and
--   re-clears flagReports for the 10 ids (already empty). The result
--   regrade is also idempotent (B is already correct after first run).
-- ─────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  -- All variables prefixed v_ to avoid collisions with column names
  -- (postgres ambiguity rule: PL/pgSQL var vs column in SQL statement).
  v_group_id constant uuid := 'd1998bed-7bae-4221-8877-20c537acfc43';
  v_all_resolved constant text[] := ARRAY[
    'bcw412','kdt8ml','1kdqbh','po6rms','3qklzq','ivn6eu','jf8qv1',
    'lszteu','math_1775389545260_tgeobz','uyjqcx'
  ];
  v_now_iso text := to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  v_sessions       jsonb;
  v_new_sessions   jsonb;
  v_total_q        int;
  v_total_c        int;
  v_acc            numeric;

  -- New scenario JSONBs ------------------------------------------------
  v_lszteu_scenario jsonb;
  v_math_scenario   jsonb;
  v_uyjqcx_scenario jsonb;
BEGIN
  ----------------------------------------------------------------------
  -- 1. Build the 3 fixed scenarios as JSONB literals.
  ----------------------------------------------------------------------

  -- 8) lszteu — top set on wet board → bet for value+protection.
  v_lszteu_scenario := jsonb_build_object(
    'id',          'je2neuharbgg',
    'poolId',      'lszteu',
    'category',    'משחק איטי',
    'categoryId',  'slow_play',
    'yourCards',   'Q♠ Q♦',
    'boardCards',  'Q♥ 10♥ 9♠',
    'situation',   'הקופה היא 2,500. פיליפ (שחקן אגרסיבי) עושה צ''ק.',
    'reviewedAt',  v_now_iso,
    'options', jsonb_build_array(
      jsonb_build_object(
        'id', 'A', 'text', 'צ''ק',
        'isCorrect', false, 'nearMiss', true,
        'explanation', 'שלישייה עליונה זה חזק, אבל הלוח רטוב מאוד — שני קלפי לב + קירבה (9-10-Q) פותחים סטרייטים ופלאשים. צ''ק כאן נותן לפיליפ קלף חינם שיכול להרוג את היד שלך. עדיף לבנות קופה ולהגן על היד.'
      ),
      jsonb_build_object(
        'id', 'B', 'text', 'הימור 1,800',
        'isCorrect', true,
        'explanation', 'יד מפלצת על לוח רטוב = בונים קופה עכשיו. במשחק שלנו ישלמו לך עם זוג כפול, פלאש דרו או סטרייט דרו, וגם תוציא ערך וגם תגן מקלף לב או 8/J/K שיכולים להרוג את ההכנסה.'
      ),
      jsonb_build_object(
        'id', 'C', 'text', 'ויתור',
        'isCorrect', false,
        'explanation', 'יש לך שלישייה עליונה — לזרוק את היד הזו לא בא בחשבון.'
      )
    )
  );

  -- 9) math_1775389545260_tgeobz — fix the "40%" math error in option A.
  v_math_scenario := jsonb_build_object(
    'id',          'math_1775389545260_tgeobz',
    'poolId',      'math_1775389545260_tgeobz',
    'category',    'סיכויים וחישובים',
    'categoryId',  'true_false',
    'difficulty',  'intermediate',
    'yourCards',   'Q♠ 10♥',
    'situation',   'ליאור מהמר 2,000 לתוך קופה של 3,000. גאטשוט בטרן.',
    'reviewedAt',  v_now_iso,
    'options', jsonb_build_array(
      jsonb_build_object(
        'id', 'A', 'text', 'לא, כי הסיכוי 8.5% נמוך מסיכויי הקופה הנדרשים (28.6%).',
        'isCorrect', true,
        'explanation', 'אתה משלם 2,000 כדי לזכות בקופה של 5,000 — צריך לפחות 28.6% הצלחה. גאטשוט נותן לך רק 8.5%, רחוק מאוד מהסף.'
      ),
      jsonb_build_object(
        'id', 'B', 'text', 'כן, בגלל הפוטנציאל לסטרייט.',
        'isCorrect', false,
        'explanation', 'הסיכוי לפגוע בסטרייט הוא 8.5%. זה לא מספיק כדי להצדיק השקעה של 28.6% מהקופה.'
      ),
      jsonb_build_object(
        'id', 'C', 'text', 'כן, אם הקופה הבאה תהיה גדולה מספיק.',
        'isCorrect', false,
        'explanation', 'גם עם Implied Odds (סיכויי רווח עתידיים), צריך יחס של פי ~12 כדי שהקריאה תוצדק. כאן היחס הוא רק 1:2.5, לא קרוב.'
      )
    )
  );

  -- 10) uyjqcx — add the missing boardCards (nut-flush-draw flop).
  v_uyjqcx_scenario := jsonb_build_object(
    'poolId',      'uyjqcx',
    'category',    'חסר קלף לצבע',
    'categoryId',  'flush_draw',
    'yourCards',   'A♥ K♥',
    'boardCards',  '9♥ 7♥ 2♣',
    'situation',   'היריב מהמר 1,000 לתוך קופה של 1,650 בפלופ. שני שחקנים נוספים עדיין ביד.',
    'reviewedAt',  v_now_iso,
    'options', jsonb_build_array(
      jsonb_build_object(
        'id', 'A', 'text', 'העלאה ל-3,000',
        'isCorrect', true,
        'explanation', 'יש לך פלאש דרו לנאט + שני אוברקארדים — יד ענקית מבחינת אקוויטי. העלאה כאן בונה קופה גדולה כי במשחק שלנו יריבים ישלמו עם זוגות או דרו חלשים יותר, וגם משאירה לך פתח לקחת את הקופה אם הם יוותרו.'
      ),
      jsonb_build_object(
        'id', 'B', 'text', 'קריאה 1,000',
        'isCorrect', false, 'nearMiss', true,
        'explanation', 'קריאה היא פסיבית מדי לידיים כל כך חזקות. במשחק שלנו, כשיש לך אקוויטי כזו, עדיף להמר ולהגדיל את הקופה כי השחקנים ימשיכו לשלם.'
      ),
      jsonb_build_object(
        'id', 'C', 'text', 'ויתור',
        'isCorrect', false,
        'explanation', 'לוותר עם פלאש דרו לנאט + אוברקארדים זו טעות חמורה — יש לך לפחות 12 אאוטים.'
      )
    )
  );

  ----------------------------------------------------------------------
  -- 2. Apply the 3 fixes to training_pool.
  --    Replace the whole `scenario` JSONB and bump reviewedAt.
  ----------------------------------------------------------------------
  UPDATE training_pool
    SET scenario = v_lszteu_scenario,
        reviewed_at = now()
    WHERE training_pool.group_id = v_group_id AND scenario_id = 'lszteu';

  UPDATE training_pool
    SET scenario = v_math_scenario,
        reviewed_at = now()
    WHERE training_pool.group_id = v_group_id AND scenario_id = 'math_1775389545260_tgeobz';

  UPDATE training_pool
    SET scenario = v_uyjqcx_scenario,
        reviewed_at = now()
    WHERE training_pool.group_id = v_group_id AND scenario_id = 'uyjqcx';

  ----------------------------------------------------------------------
  -- 3. Transform חרדון's training_answers row.
  --    Walk every session: regrade lszteu result, drop flagReports +
  --    flaggedPoolIds for all 10 resolved pools, recompute per-session
  --    correctAnswers count.
  ----------------------------------------------------------------------
  SELECT sessions
    INTO v_sessions
    FROM training_answers
    WHERE training_answers.group_id = v_group_id AND player_name = 'חרדון';

  IF v_sessions IS NULL THEN
    RAISE EXCEPTION 'חרדון row not found in training_answers';
  END IF;

  WITH
    src_sessions AS (
      SELECT s.value AS sess, s.ordinality AS pos
        FROM jsonb_array_elements(v_sessions) WITH ORDINALITY AS s(value, ordinality)
    ),
    rebuilt AS (
      SELECT
        pos,
        sess
          || jsonb_build_object(
               -- regrade lszteu in results[]
               'results', COALESCE((
                 SELECT jsonb_agg(
                   CASE
                     WHEN (r.value->>'poolId') = 'lszteu' THEN
                       (r.value - 'nearMiss')
                         || jsonb_build_object('correct', true)
                     ELSE r.value
                   END
                 )
                 FROM jsonb_array_elements(sess->'results') AS r(value)
               ), '[]'::jsonb),
               -- drop flagReports for any of the 10 resolved pools
               'flagReports', COALESCE((
                 SELECT jsonb_agg(f.value)
                 FROM jsonb_array_elements(COALESCE(sess->'flagReports', '[]'::jsonb)) AS f(value)
                 WHERE NOT ((f.value->>'poolId') = ANY(v_all_resolved))
               ), '[]'::jsonb),
               -- drop flaggedPoolIds for any of the 10 resolved pools
               'flaggedPoolIds', COALESCE((
                 SELECT jsonb_agg(fid.value)
                 FROM jsonb_array_elements(COALESCE(sess->'flaggedPoolIds', '[]'::jsonb)) AS fid(value)
                 WHERE NOT ((fid.value #>> '{}') = ANY(v_all_resolved))
               ), '[]'::jsonb)
             ) AS sess_with_payload
        FROM src_sessions
    ),
    -- recompute session.correctAnswers AFTER the regrade above
    final_sessions AS (
      SELECT
        pos,
        sess_with_payload || jsonb_build_object(
          'correctAnswers', COALESCE((
            SELECT count(*)::int
              FROM jsonb_array_elements(sess_with_payload->'results') AS r(value)
              WHERE (r.value->>'correct') = 'true'
                AND COALESCE(r.value->>'nearMiss', 'false') <> 'true'
                AND COALESCE(r.value->>'neutralized', 'false') <> 'true'
          ), 0)
        ) AS final_sess
        FROM rebuilt
    )
  SELECT jsonb_agg(final_sess ORDER BY pos)
    INTO v_new_sessions
    FROM final_sessions;

  ----------------------------------------------------------------------
  -- 4. Recompute aggregate totals from the new sessions array.
  --    Mirror src/components/TrainingAdminTab.tsx → recomputePlayerTotals:
  --    nearMiss + neutralized excluded from totals.
  ----------------------------------------------------------------------
  SELECT
    COUNT(*) FILTER (
      WHERE COALESCE(r.value->>'neutralized', 'false') <> 'true'
        AND COALESCE(r.value->>'nearMiss', 'false') <> 'true'
    )::int,
    COUNT(*) FILTER (
      WHERE COALESCE(r.value->>'neutralized', 'false') <> 'true'
        AND COALESCE(r.value->>'nearMiss', 'false') <> 'true'
        AND (r.value->>'correct') = 'true'
    )::int
  INTO v_total_q, v_total_c
  FROM jsonb_array_elements(v_new_sessions) AS s(value)
  CROSS JOIN LATERAL jsonb_array_elements(s.value->'results') AS r(value);

  v_acc := CASE WHEN v_total_q > 0
                THEN ROUND((v_total_c::numeric / v_total_q::numeric) * 100, 2)
                ELSE 0
           END;

  ----------------------------------------------------------------------
  -- 5. Persist the rewritten sessions + new totals back to the row.
  ----------------------------------------------------------------------
  UPDATE training_answers
    SET sessions = v_new_sessions,
        stats = COALESCE(stats, '{}'::jsonb)
                  || jsonb_build_object(
                       'totalQuestions', v_total_q,
                       'totalCorrect',   v_total_c,
                       'accuracy',       v_acc
                     ),
        updated_at = now()
    WHERE training_answers.group_id = v_group_id AND player_name = 'חרדון';

  RAISE NOTICE 'training-reports resolved: 7 rejected, 3 fixed; חרדון totals → q=%, c=%, acc=%',
               v_total_q, v_total_c, v_acc;
END
$$;
