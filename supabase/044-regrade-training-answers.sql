-- 044: One-time regrade of historical training answers against current pool keys
--
-- Why this exists:
--   The Training admin "Save AI fix" path used to call clearFlagsLocally(),
--   which only removed the flag entries on training_answers and never
--   re-graded historical TrainingAnswerResult rows against the corrected
--   options[].isCorrect / nearMiss keys. Same gap existed in the bulk pool
--   review (handleReviewPool): scenarios marked "fixed" or "remove" updated
--   training_pool but left training_answers untouched.
--
--   As a result, players who answered a question correctly *per the new key*
--   stayed marked wrong, and stats.totalCorrect / accuracy never moved when
--   an admin accepted a flagged report. Players complained that the fix
--   "doesn't work".
--
--   The client-side bug has been fixed (regradeAnswersForFixedScenarios is
--   now called from confirmAIFix and handleReviewPool, so all future fixes
--   re-grade history automatically). This migration heals the historical
--   drift caused by past fixes that bit before the patch shipped.
--
-- Strategy:
--   For every training_answers row, walk sessions[].results[]. For each
--   non-neutralized result whose poolId still exists in training_pool for
--   the same group_id, look up the chosen option in the *current* scenario
--   options[] and re-derive `correct` / `nearMiss` from `isCorrect` /
--   `nearMiss` on that option. If the chosen option no longer exists in
--   the option set (e.g. the fix restructured options entirely), neutralize
--   the result (it can't be fairly graded against a different set).
--   Recompute session.correctAnswers and stats.totalQuestions /
--   totalCorrect / accuracy for any row that changed.
--
--   Results whose poolId is no longer in training_pool are left untouched —
--   those were either properly neutralized via the remove-flagged flow, or
--   are orphan history we shouldn't second-guess. The remove-flagged flow
--   also continues to neutralize on its own.
--
-- Idempotent:
--   Running twice is a no-op. The second pass finds every result already
--   matching the current keys, sets row_changes = 0 on every row, and
--   skips all UPDATE statements.

DO $$
DECLARE
  ans_rec       RECORD;
  new_sessions  JSONB;
  session_count INT;
  s_idx         INT;
  session_obj   JSONB;
  results_arr   JSONB;
  result_count  INT;
  r_idx         INT;
  result_obj    JSONB;
  pool_id       TEXT;
  chosen_id     TEXT;
  scenario      JSONB;
  option_obj    JSONB;
  was_neutral   BOOLEAN;
  is_neutral    BOOLEAN;
  was_correct   BOOLEAN;
  was_near_miss BOOLEAN;
  new_correct   BOOLEAN;
  new_near_miss BOOLEAN;
  new_correct_count INT;
  player_total_q    INT;
  player_total_c    INT;
  player_acc        INT;
  new_stats         JSONB;
  row_changes       INT;
  total_changes     INT := 0;
  rows_updated      INT := 0;
  rows_scanned      INT := 0;
BEGIN
  FOR ans_rec IN
    SELECT id, group_id, sessions, stats FROM training_answers
  LOOP
    rows_scanned := rows_scanned + 1;
    new_sessions := '[]'::jsonb;
    session_count := COALESCE(jsonb_array_length(ans_rec.sessions), 0);
    player_total_q := 0;
    player_total_c := 0;
    row_changes := 0;

    IF session_count = 0 THEN
      CONTINUE;
    END IF;

    FOR s_idx IN 0..(session_count - 1) LOOP
      session_obj := ans_rec.sessions -> s_idx;
      results_arr := COALESCE(session_obj -> 'results', '[]'::jsonb);
      result_count := COALESCE(jsonb_array_length(results_arr), 0);
      new_correct_count := 0;

      IF result_count > 0 THEN
        FOR r_idx IN 0..(result_count - 1) LOOP
          result_obj  := results_arr -> r_idx;
          was_neutral := COALESCE((result_obj ->> 'neutralized')::boolean, false);

          IF NOT was_neutral THEN
            pool_id   := result_obj ->> 'poolId';
            chosen_id := result_obj ->> 'chosenId';

            -- look up the current scenario for this poolId in this group
            SELECT tp.scenario INTO scenario
              FROM training_pool tp
             WHERE tp.group_id = ans_rec.group_id
               AND tp.scenario_id = pool_id
             LIMIT 1;

            IF scenario IS NOT NULL THEN
              -- find the chosen option in the current options[]
              SELECT o INTO option_obj
                FROM jsonb_array_elements(scenario -> 'options') o
               WHERE o ->> 'id' = chosen_id
               LIMIT 1;

              IF option_obj IS NULL THEN
                -- chosen option no longer exists → neutralize so it can't
                -- unfairly count for/against the player.
                result_obj := jsonb_set(result_obj, '{neutralized}', 'true'::jsonb, true);
                row_changes := row_changes + 1;
              ELSE
                new_correct   := COALESCE((option_obj ->> 'isCorrect')::boolean, false);
                new_near_miss := (NOT new_correct)
                                 AND COALESCE((option_obj ->> 'nearMiss')::boolean, false);

                was_correct   := COALESCE((result_obj ->> 'correct')::boolean, false);
                was_near_miss := COALESCE((result_obj ->> 'nearMiss')::boolean, false);

                IF was_correct IS DISTINCT FROM new_correct THEN
                  result_obj := jsonb_set(result_obj, '{correct}', to_jsonb(new_correct), true);
                  row_changes := row_changes + 1;
                END IF;

                IF new_near_miss THEN
                  IF NOT was_near_miss THEN
                    result_obj := jsonb_set(result_obj, '{nearMiss}', 'true'::jsonb, true);
                    row_changes := row_changes + 1;
                  END IF;
                ELSE
                  IF result_obj ? 'nearMiss' THEN
                    result_obj := result_obj - 'nearMiss';
                    row_changes := row_changes + 1;
                  END IF;
                END IF;
              END IF;
            END IF;
            -- scenario IS NULL: poolId not in current pool → leave result as-is
          END IF;

          results_arr := jsonb_set(results_arr, ARRAY[r_idx::text], result_obj, true);

          is_neutral := COALESCE((result_obj ->> 'neutralized')::boolean, false);

          -- per-session correctAnswers (excluding neutralized + nearMiss)
          IF NOT is_neutral
             AND NOT COALESCE((result_obj ->> 'nearMiss')::boolean, false)
             AND COALESCE((result_obj ->> 'correct')::boolean, false) THEN
            new_correct_count := new_correct_count + 1;
          END IF;

          -- per-player aggregate (excluding neutralized + nearMiss)
          IF NOT is_neutral
             AND NOT COALESCE((result_obj ->> 'nearMiss')::boolean, false) THEN
            player_total_q := player_total_q + 1;
            IF COALESCE((result_obj ->> 'correct')::boolean, false) THEN
              player_total_c := player_total_c + 1;
            END IF;
          END IF;
        END LOOP;
      END IF;

      session_obj := jsonb_set(session_obj, '{results}', results_arr, true);
      session_obj := jsonb_set(session_obj, '{correctAnswers}', to_jsonb(new_correct_count), true);
      new_sessions := new_sessions || jsonb_build_array(session_obj);
    END LOOP;

    -- Compare new vs. existing stats. If accuracy/totals changed, mark dirty
    -- so we still upsert even when no per-result fields flipped (e.g. when
    -- only stats drifted from a prior buggy partial write).
    player_acc := CASE WHEN player_total_q > 0
                       THEN ROUND(100.0 * player_total_c / player_total_q)::INT
                       ELSE 0 END;

    IF COALESCE((ans_rec.stats ->> 'totalQuestions')::INT, -1) IS DISTINCT FROM player_total_q THEN
      row_changes := row_changes + 1;
    END IF;
    IF COALESCE((ans_rec.stats ->> 'totalCorrect')::INT, -1) IS DISTINCT FROM player_total_c THEN
      row_changes := row_changes + 1;
    END IF;
    IF COALESCE(ROUND((ans_rec.stats ->> 'accuracy')::NUMERIC)::INT, -1) IS DISTINCT FROM player_acc THEN
      row_changes := row_changes + 1;
    END IF;

    IF row_changes = 0 THEN
      CONTINUE;
    END IF;

    new_stats := COALESCE(ans_rec.stats, '{}'::jsonb);
    new_stats := jsonb_set(new_stats, '{totalQuestions}', to_jsonb(player_total_q), true);
    new_stats := jsonb_set(new_stats, '{totalCorrect}',   to_jsonb(player_total_c), true);
    new_stats := jsonb_set(new_stats, '{accuracy}',       to_jsonb(player_acc),     true);

    UPDATE training_answers
       SET sessions   = new_sessions,
           stats      = new_stats,
           updated_at = now()
     WHERE id = ans_rec.id;

    rows_updated := rows_updated + 1;
    total_changes := total_changes + row_changes;
  END LOOP;

  RAISE NOTICE 'Regrade complete: scanned % training_answers rows, updated % rows, applied % field-level changes',
    rows_scanned, rows_updated, total_changes;
END $$;
