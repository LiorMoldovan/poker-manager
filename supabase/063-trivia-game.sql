-- 063 — Trivia game: per-session score table + leaderboard RPC.
--
-- The "Did you know?" trivia card and the personal "About you" card on
-- the home dashboard each gain a CTA that opens a 10-question quiz with
-- a 15-second timer per question. Scores are persisted per session so a
-- group-wide leaderboard can rank "trivia kings".
--
-- Storage shape: one row per completed session (NOT per-player rollup
-- like training_answers). Per-session rows make it trivial to compute
-- "best score in a single game", "accuracy across all sessions", and
-- "games played" via a single GROUP BY in the leaderboard RPC, and
-- gives us a free history we can surface later (e.g. "your last 5
-- games" mini-graph) without a schema change.
--
-- mode: 'group' = group/all-time facts (questions about records,
--                 winners, records), 'players' = questions about
--                 specific players (nemesis, biggest win, etc.).
-- Both share the leaderboard so a player's TOTAL score reflects
-- engagement with both modes.

CREATE TABLE IF NOT EXISTS trivia_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  player_name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('group', 'players')),
  score INT NOT NULL CHECK (score >= 0),
  total_questions INT NOT NULL CHECK (total_questions > 0),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Compound index for the most common query path:
--   "all sessions in MY group, grouped by player_name". Trailing
--   completed_at lets the leaderboard's "most-recent session" tile
--   resolve via an index-only seek.
CREATE INDEX IF NOT EXISTS trivia_sessions_group_player_idx
  ON trivia_sessions (group_id, player_name, completed_at DESC);

CREATE INDEX IF NOT EXISTS trivia_sessions_group_completed_idx
  ON trivia_sessions (group_id, completed_at DESC);

ALTER TABLE trivia_sessions ENABLE ROW LEVEL SECURITY;

-- RLS mirrors training_answers: anyone in the group can read; anyone
-- in the group can insert (their own row is implicit because the RPC
-- enforces user_id = auth.uid()); only admins can delete; super
-- admins have cross-group visibility for moderation.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename='trivia_sessions' AND policyname='ts_select') THEN
    DROP POLICY ts_select ON trivia_sessions;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename='trivia_sessions' AND policyname='ts_insert') THEN
    DROP POLICY ts_insert ON trivia_sessions;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename='trivia_sessions' AND policyname='ts_admin_delete') THEN
    DROP POLICY ts_admin_delete ON trivia_sessions;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename='trivia_sessions' AND policyname='ts_super_admin') THEN
    DROP POLICY ts_super_admin ON trivia_sessions;
  END IF;
END $$;

CREATE POLICY ts_select ON trivia_sessions FOR SELECT
  USING (group_id IN (
    SELECT group_id FROM group_members WHERE user_id = (SELECT auth.uid())
  ));

CREATE POLICY ts_insert ON trivia_sessions FOR INSERT
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND group_id IN (
      SELECT group_id FROM group_members WHERE user_id = (SELECT auth.uid())
    )
  );

CREATE POLICY ts_admin_delete ON trivia_sessions FOR DELETE
  USING (group_id IN (
    SELECT group_id FROM group_members
     WHERE user_id = (SELECT auth.uid()) AND role = 'admin'
  ));

CREATE POLICY ts_super_admin ON trivia_sessions FOR ALL
  USING (EXISTS (SELECT 1 FROM super_admins sa WHERE sa.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM super_admins sa WHERE sa.user_id = auth.uid()));

-- Leaderboard RPC. Returns one row per player_name in the caller's
-- current group. Ordered by total_correct DESC then accuracy DESC
-- so the headline rank prizes engagement (more correct answers
-- across sessions wins ties between two equally-accurate players).
--
-- p_group_id: optional override for super-admin observer mode; when
-- NULL we resolve to the caller's first group_membership. Mirrors
-- the multi-group RPC convention in 008-multi-group.sql.
DROP FUNCTION IF EXISTS fetch_trivia_leaderboard(UUID);

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

  -- Resolve target group. If p_group_id is provided, verify the
  -- caller is a member (or super admin). If omitted, fall back to
  -- the caller's group membership.
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
  ORDER BY SUM(ts.score) DESC, accuracy DESC NULLS LAST;
END;
$$;

GRANT EXECUTE ON FUNCTION fetch_trivia_leaderboard(UUID) TO authenticated;

-- Realtime so other group members see new sessions appear without
-- needing a refresh (matches the existing training pattern).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'trivia_sessions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE trivia_sessions;
  END IF;
END $$;
