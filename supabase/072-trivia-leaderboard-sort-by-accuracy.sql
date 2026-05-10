-- 072-trivia-leaderboard-sort-by-accuracy.sql
--
-- Re-rank `fetch_trivia_leaderboard` from total-correct-first to
-- accuracy-first.
--
-- WHY
-- The original implementation in 063 sorted by `SUM(score) DESC`
-- with accuracy as a tiebreaker. That meant a player who simply
-- played MORE rounds outranked a player who answered more
-- accurately — the headline number on the landing screen
-- (`60% / 80% / 45%`) suggested otherwise. Lior pointed out the
-- mismatch on 2026-05-10:
--
--   1 🥇 אייל   50  32  64%
--   2 🥈 ליכטר  30  24  80%   ← higher accuracy, lower rank
--   3 🥉 סגל    20   9  45%
--   4    ליאור  10   6  60%   ← higher accuracy than #3, lower rank
--   5    חרדון  10   4  40%
--
-- WHAT
-- This migration replaces the function body so the ORDER BY chain
-- becomes:
--   1. accuracy DESC NULLS LAST  — primary, what users actually
--      see in the table column.
--   2. total_correct DESC        — tiebreaker among equally
--      accurate players: whoever produced that accuracy across
--      MORE answered questions ranks higher (a 5/5 = 100% should
--      not outrank a 30/30 = 100%).
--   3. total_questions DESC      — secondary tiebreaker for
--      players with identical accuracy AND identical correct
--      counts (rare but possible — e.g. two 10/10 sessions).
--      Effectively a no-op when total_correct is already tied
--      (since accuracy = correct/questions), but kept for
--      clarity and to keep ordering deterministic in the edge
--      case where rounding produces matching accuracy with
--      different question totals.
--   4. player_name ASC           — final deterministic
--      tiebreaker so identical players don't shuffle between
--      page loads.
--
-- The 0-score-and-≥5-questions guard from v5.57.1 (client-side
-- skip in TriviaGameScreen) plus realistic session lengths (≥5
-- questions per round) means no player can register on the
-- leaderboard with a tiny denominator. We do NOT add a
-- minimum-question threshold here — every persisted session
-- contributes at least 5 questions to the player's totals, which
-- is already enough sample size for the headline accuracy to be
-- meaningful.
--
-- SAFETY
-- - CREATE OR REPLACE: idempotent, no schema/permissions change,
--   no data touched.
-- - GRANT not re-issued — the existing GRANT from migration 063
--   stays in effect across the replace.
-- - No client-side change required: the columns returned are
--   identical, only the row order changes.

CREATE OR REPLACE FUNCTION fetch_trivia_leaderboard(p_group_id UUID DEFAULT NULL)
RETURNS TABLE (
  player_name TEXT,
  games INT,
  total_questions INT,
  total_correct INT,
  accuracy NUMERIC,
  best_score INT,
  last_played TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group_id UUID;
  v_user_id UUID;
  v_is_super BOOLEAN;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_is_super := EXISTS (SELECT 1 FROM super_admins WHERE super_admins.user_id = v_user_id);

  IF p_group_id IS NOT NULL THEN
    IF NOT v_is_super AND NOT EXISTS (
      SELECT 1 FROM group_members
       WHERE group_members.user_id = v_user_id
         AND group_members.group_id = p_group_id
    ) THEN
      RAISE EXCEPTION 'Not a member of group %', p_group_id;
    END IF;
    v_group_id := p_group_id;
  ELSE
    SELECT gm.group_id INTO v_group_id
      FROM group_members gm
     WHERE gm.user_id = v_user_id
     LIMIT 1;
    IF v_group_id IS NULL THEN
      RAISE EXCEPTION 'User is not a member of any group';
    END IF;
  END IF;

  RETURN QUERY
  SELECT
    ts.player_name,
    COUNT(*)::INT AS games,
    SUM(ts.total_questions)::INT AS total_questions,
    SUM(ts.score)::INT AS total_correct,
    ROUND((SUM(ts.score)::NUMERIC / NULLIF(SUM(ts.total_questions), 0)) * 100, 1) AS accuracy,
    MAX(ts.score)::INT AS best_score,
    MAX(ts.completed_at) AS last_played
  FROM trivia_sessions ts
  WHERE ts.group_id = v_group_id
  GROUP BY ts.player_name
  ORDER BY
    -- Primary: accuracy %, descending. NULLS LAST guards the
    -- impossible-but-defensive case where a player exists with
    -- only score-0 / total_questions-0 rows (the v5.57.1 guard
    -- prevents this on insert, but defensive coding keeps the
    -- query robust if old rows ever leak in).
    accuracy DESC NULLS LAST,
    -- Tiebreaker: total correct answers. Bigger denominator
    -- supporting the same accuracy = more credible.
    SUM(ts.score) DESC,
    -- Secondary tiebreaker: total questions. Same correct count
    -- across more questions is a separate (rare) tie case.
    SUM(ts.total_questions) DESC,
    -- Deterministic final tiebreaker so two identical players
    -- don't visually swap between page loads.
    ts.player_name ASC;
END;
$$;
