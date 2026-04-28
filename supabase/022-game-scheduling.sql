-- ============================================================
-- Migration 022: Game Scheduling Polls
-- Run in Supabase SQL Editor after 021-super-admin-email.sql
--
-- Adds a date-poll workflow for organizing the next game night:
--   - Admin creates a poll with 2-5 candidate dates and a target headcount.
--   - Permanent members RSVP yes/no/maybe per date.
--   - When a date hits the target yes-count, the poll auto-confirms via trigger.
--   - If 48h pass without target, invitations expand to permanent_guest + guest.
--   - Admin starts the game from the confirmed poll card.
--
-- All tables are group-scoped; group_id cascades from groups.
-- Notification dispatch is handled client-side, gated by atomic claim columns.
-- ============================================================

-- ============================================================
-- 1. TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS game_polls (
  id                                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id                          UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_by                        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at                        TIMESTAMPTZ NOT NULL DEFAULT now(),
  status                            TEXT NOT NULL DEFAULT 'open'
                                      CHECK (status IN ('open', 'expanded', 'confirmed', 'cancelled', 'expired')),
  target_player_count               INT NOT NULL DEFAULT 8 CHECK (target_player_count >= 2),
  expansion_delay_hours             INT NOT NULL DEFAULT 48 CHECK (expansion_delay_hours >= 0),
  expanded_at                       TIMESTAMPTZ,
  confirmed_date_id                 UUID, -- FK added below (forward reference)
  confirmed_at                      TIMESTAMPTZ,
  confirmed_game_id                 UUID REFERENCES games(id) ON DELETE SET NULL,
  note                              TEXT,
  default_location                  TEXT,
  allow_maybe                       BOOLEAN NOT NULL DEFAULT TRUE,
  cancellation_reason               TEXT CHECK (cancellation_reason IS NULL OR length(cancellation_reason) <= 280),
  creation_notifications_sent_at    TIMESTAMPTZ,
  expanded_notifications_sent_at    TIMESTAMPTZ,
  confirmed_notifications_sent_at   TIMESTAMPTZ,
  cancellation_notifications_sent_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS game_poll_dates (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  poll_id         UUID NOT NULL REFERENCES game_polls(id) ON DELETE CASCADE,
  proposed_date   DATE NOT NULL,
  proposed_time   TIME,
  location        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS game_poll_votes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  poll_id     UUID NOT NULL REFERENCES game_polls(id) ON DELETE CASCADE,
  date_id     UUID NOT NULL REFERENCES game_poll_dates(id) ON DELETE CASCADE,
  player_id   UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  response    TEXT NOT NULL CHECK (response IN ('yes', 'no', 'maybe')),
  comment     TEXT,
  voted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (date_id, player_id)
);

-- Forward FK on confirmed_date_id (added after game_poll_dates exists)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'game_polls_confirmed_date_id_fkey'
      AND table_name = 'game_polls'
  ) THEN
    ALTER TABLE game_polls
      ADD CONSTRAINT game_polls_confirmed_date_id_fkey
      FOREIGN KEY (confirmed_date_id) REFERENCES game_poll_dates(id) ON DELETE SET NULL;
  END IF;
END;
$$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_game_polls_group_status ON game_polls(group_id, status);
CREATE INDEX IF NOT EXISTS idx_game_poll_dates_poll ON game_poll_dates(poll_id);
CREATE INDEX IF NOT EXISTS idx_game_poll_votes_poll ON game_poll_votes(poll_id);
CREATE INDEX IF NOT EXISTS idx_game_poll_votes_date_response ON game_poll_votes(date_id, response);

-- ============================================================
-- 2. ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE game_polls ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_poll_dates ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_poll_votes ENABLE ROW LEVEL SECURITY;

-- Polls: any group member can SELECT
CREATE POLICY "Group members read polls"
  ON game_polls FOR SELECT
  USING (
    group_id IN (SELECT gm.group_id FROM group_members gm WHERE gm.user_id = auth.uid())
  );

-- Polls: only admins can INSERT/UPDATE/DELETE
CREATE POLICY "Admins manage polls"
  ON game_polls FOR ALL
  USING (
    group_id IN (
      SELECT gm.group_id FROM group_members gm
      WHERE gm.user_id = auth.uid() AND gm.role = 'admin'
    )
  )
  WITH CHECK (
    group_id IN (
      SELECT gm.group_id FROM group_members gm
      WHERE gm.user_id = auth.uid() AND gm.role = 'admin'
    )
  );

-- Super admins can do anything on polls (cross-group visibility)
CREATE POLICY "Super admins manage all polls"
  ON game_polls FOR ALL
  USING (EXISTS (SELECT 1 FROM super_admins WHERE user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM super_admins WHERE user_id = auth.uid()));

-- Dates: any group member reads, only admins write
CREATE POLICY "Group members read poll dates"
  ON game_poll_dates FOR SELECT
  USING (
    poll_id IN (
      SELECT p.id FROM game_polls p
      JOIN group_members gm ON gm.group_id = p.group_id
      WHERE gm.user_id = auth.uid()
    )
  );

CREATE POLICY "Admins manage poll dates"
  ON game_poll_dates FOR ALL
  USING (
    poll_id IN (
      SELECT p.id FROM game_polls p
      JOIN group_members gm ON gm.group_id = p.group_id
      WHERE gm.user_id = auth.uid() AND gm.role = 'admin'
    )
  )
  WITH CHECK (
    poll_id IN (
      SELECT p.id FROM game_polls p
      JOIN group_members gm ON gm.group_id = p.group_id
      WHERE gm.user_id = auth.uid() AND gm.role = 'admin'
    )
  );

CREATE POLICY "Super admins manage all poll dates"
  ON game_poll_dates FOR ALL
  USING (EXISTS (SELECT 1 FROM super_admins WHERE user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM super_admins WHERE user_id = auth.uid()));

-- Votes: any group member reads (so everyone sees who voted what)
CREATE POLICY "Group members read votes"
  ON game_poll_votes FOR SELECT
  USING (
    poll_id IN (
      SELECT p.id FROM game_polls p
      JOIN group_members gm ON gm.group_id = p.group_id
      WHERE gm.user_id = auth.uid()
    )
  );

-- Votes: writes go through cast_poll_vote RPC only (no direct INSERT/UPDATE/DELETE policies).
-- The RPC is SECURITY DEFINER and enforces tier + status + player-link checks internally.
-- Super admins still get direct write access for support / cleanup.
CREATE POLICY "Super admins manage all votes"
  ON game_poll_votes FOR ALL
  USING (EXISTS (SELECT 1 FROM super_admins WHERE user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM super_admins WHERE user_id = auth.uid()));

-- ============================================================
-- 3. AUTO-CLOSE TRIGGER
--    Fires after a yes-vote is inserted or a vote's response changes.
--    Atomically confirms the poll if a date crosses target_player_count yes-votes.
--    Race-safe via WHERE status IN ('open','expanded') re-check after row lock.
-- ============================================================

CREATE OR REPLACE FUNCTION auto_close_poll_on_vote()
RETURNS TRIGGER AS $$
DECLARE
  v_target  INT;
  v_yes_cnt INT;
BEGIN
  IF NEW.response <> 'yes' THEN
    RETURN NEW;
  END IF;

  SELECT target_player_count INTO v_target
    FROM game_polls WHERE id = NEW.poll_id;

  SELECT count(*) INTO v_yes_cnt
    FROM game_poll_votes
    WHERE date_id = NEW.date_id AND response = 'yes';

  IF v_yes_cnt >= v_target THEN
    UPDATE game_polls
       SET status = 'confirmed',
           confirmed_date_id = NEW.date_id,
           confirmed_at = now()
     WHERE id = NEW.poll_id
       AND status IN ('open', 'expanded');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auto_close_poll_on_vote ON game_poll_votes;
CREATE TRIGGER trg_auto_close_poll_on_vote
  AFTER INSERT OR UPDATE OF response ON game_poll_votes
  FOR EACH ROW
  EXECUTE FUNCTION auto_close_poll_on_vote();

-- ============================================================
-- 4. RPCs
-- ============================================================

-- 4.1 create_game_poll
CREATE OR REPLACE FUNCTION create_game_poll(
  p_group_id          UUID,
  p_dates             JSONB,
  p_target            INT DEFAULT 8,
  p_expansion_delay   INT DEFAULT 48,
  p_default_location  TEXT DEFAULT NULL,
  p_allow_maybe       BOOLEAN DEFAULT TRUE,
  p_note              TEXT DEFAULT NULL
)
RETURNS UUID AS $$
DECLARE
  v_poll_id    UUID;
  v_date_count INT;
  v_date       JSONB;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM group_members
    WHERE group_id = p_group_id AND user_id = auth.uid() AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  v_date_count := jsonb_array_length(COALESCE(p_dates, '[]'::jsonb));
  IF v_date_count < 2 OR v_date_count > 5 THEN
    RAISE EXCEPTION 'invalid_date_count';
  END IF;

  IF p_target < 2 THEN
    RAISE EXCEPTION 'invalid_target';
  END IF;

  INSERT INTO game_polls (
    group_id, created_by, status, target_player_count,
    expansion_delay_hours, default_location, allow_maybe, note
  )
  VALUES (
    p_group_id, auth.uid(), 'open', p_target,
    p_expansion_delay, p_default_location, p_allow_maybe, p_note
  )
  RETURNING id INTO v_poll_id;

  FOR v_date IN SELECT * FROM jsonb_array_elements(p_dates)
  LOOP
    IF (v_date->>'proposed_date')::DATE < CURRENT_DATE THEN
      RAISE EXCEPTION 'past_date';
    END IF;

    INSERT INTO game_poll_dates (poll_id, proposed_date, proposed_time, location)
    VALUES (
      v_poll_id,
      (v_date->>'proposed_date')::DATE,
      NULLIF(v_date->>'proposed_time', '')::TIME,
      NULLIF(v_date->>'location', '')
    );
  END LOOP;

  RETURN v_poll_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 4.2 cast_poll_vote
CREATE OR REPLACE FUNCTION cast_poll_vote(
  p_date_id   UUID,
  p_response  TEXT,
  p_comment   TEXT DEFAULT NULL
)
RETURNS SETOF game_polls AS $$
DECLARE
  v_poll        game_polls%ROWTYPE;
  v_player_id   UUID;
  v_player_type TEXT;
BEGIN
  SELECT p.* INTO v_poll
    FROM game_polls p
    JOIN game_poll_dates d ON d.poll_id = p.id
    WHERE d.id = p_date_id;

  IF v_poll.id IS NULL THEN
    RAISE EXCEPTION 'invalid_date_id';
  END IF;

  IF v_poll.status NOT IN ('open', 'expanded') THEN
    RAISE EXCEPTION 'poll_locked';
  END IF;

  SELECT gm.player_id INTO v_player_id
    FROM group_members gm
    WHERE gm.user_id = auth.uid() AND gm.group_id = v_poll.group_id;

  IF v_player_id IS NULL THEN
    RAISE EXCEPTION 'no_player_link';
  END IF;

  SELECT type INTO v_player_type FROM players WHERE id = v_player_id;
  IF v_player_type IS NULL THEN
    RAISE EXCEPTION 'no_player_link';
  END IF;

  IF v_poll.status = 'open' AND v_player_type <> 'permanent' THEN
    RAISE EXCEPTION 'tier_not_allowed';
  END IF;

  IF p_response NOT IN ('yes', 'no', 'maybe') THEN
    RAISE EXCEPTION 'invalid_response';
  END IF;

  IF p_response = 'maybe' AND NOT v_poll.allow_maybe THEN
    RAISE EXCEPTION 'maybe_not_allowed';
  END IF;

  INSERT INTO game_poll_votes (poll_id, date_id, player_id, user_id, response, comment, voted_at)
  VALUES (v_poll.id, p_date_id, v_player_id, auth.uid(), p_response, p_comment, now())
  ON CONFLICT (date_id, player_id) DO UPDATE
    SET response = EXCLUDED.response,
        comment  = EXCLUDED.comment,
        voted_at = EXCLUDED.voted_at,
        user_id  = EXCLUDED.user_id;

  -- Trigger fired in same transaction; SELECT now sees the updated status.
  RETURN QUERY SELECT * FROM game_polls WHERE id = v_poll.id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 4.3 cancel_game_poll (with optional reason)
CREATE OR REPLACE FUNCTION cancel_game_poll(
  p_poll_id  UUID,
  p_reason   TEXT DEFAULT NULL
)
RETURNS VOID AS $$
DECLARE
  v_group_id UUID;
BEGIN
  SELECT group_id INTO v_group_id FROM game_polls WHERE id = p_poll_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'invalid_poll';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM group_members
    WHERE group_id = v_group_id AND user_id = auth.uid() AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  UPDATE game_polls
     SET status = 'cancelled',
         cancellation_reason = NULLIF(TRIM(p_reason), '')
   WHERE id = p_poll_id
     AND status IN ('open', 'expanded');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 4.4 manual_close_game_poll (admin override)
CREATE OR REPLACE FUNCTION manual_close_game_poll(
  p_poll_id  UUID,
  p_date_id  UUID
)
RETURNS VOID AS $$
DECLARE
  v_group_id UUID;
BEGIN
  SELECT group_id INTO v_group_id FROM game_polls WHERE id = p_poll_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'invalid_poll';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM group_members
    WHERE group_id = v_group_id AND user_id = auth.uid() AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM game_poll_dates WHERE id = p_date_id AND poll_id = p_poll_id
  ) THEN
    RAISE EXCEPTION 'invalid_date_for_poll';
  END IF;

  UPDATE game_polls
     SET status = 'confirmed',
         confirmed_date_id = p_date_id,
         confirmed_at = now()
   WHERE id = p_poll_id
     AND status IN ('open', 'expanded');
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 4.5 expand_game_poll — callable by ANY group member (idempotent + time-gated)
CREATE OR REPLACE FUNCTION expand_game_poll(p_poll_id UUID)
RETURNS VOID AS $$
DECLARE
  v_group_id UUID;
BEGIN
  SELECT group_id INTO v_group_id FROM game_polls WHERE id = p_poll_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'invalid_poll';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM group_members
    WHERE group_id = v_group_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not_member';
  END IF;

  -- Atomic time-gated transition; no-op if already expanded/closed or too early.
  UPDATE game_polls
     SET status = 'expanded',
         expanded_at = now()
   WHERE id = p_poll_id
     AND status = 'open'
     AND now() - created_at >= make_interval(hours => expansion_delay_hours);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 4.6 update_poll_target — admin can change target mid-poll; re-runs threshold check
CREATE OR REPLACE FUNCTION update_poll_target(
  p_poll_id    UUID,
  p_new_target INT
)
RETURNS VOID AS $$
DECLARE
  v_group_id  UUID;
  v_winning_date UUID;
  v_yes_cnt   INT;
BEGIN
  SELECT group_id INTO v_group_id FROM game_polls WHERE id = p_poll_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'invalid_poll';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM group_members
    WHERE group_id = v_group_id AND user_id = auth.uid() AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  IF p_new_target < 2 THEN
    RAISE EXCEPTION 'invalid_target';
  END IF;

  UPDATE game_polls SET target_player_count = p_new_target
   WHERE id = p_poll_id AND status IN ('open', 'expanded');

  -- Re-evaluate threshold. Pick the date with the highest yes-count.
  SELECT date_id, count(*) INTO v_winning_date, v_yes_cnt
    FROM game_poll_votes
    WHERE poll_id = p_poll_id AND response = 'yes'
    GROUP BY date_id
    ORDER BY count(*) DESC, date_id ASC
    LIMIT 1;

  IF v_winning_date IS NOT NULL AND v_yes_cnt >= p_new_target THEN
    UPDATE game_polls
       SET status = 'confirmed',
           confirmed_date_id = v_winning_date,
           confirmed_at = now()
     WHERE id = p_poll_id
       AND status IN ('open', 'expanded');
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 4.7 update_poll_expansion_delay — admin only, only while poll is open
CREATE OR REPLACE FUNCTION update_poll_expansion_delay(
  p_poll_id   UUID,
  p_new_delay INT
)
RETURNS VOID AS $$
DECLARE
  v_group_id UUID;
BEGIN
  SELECT group_id INTO v_group_id FROM game_polls WHERE id = p_poll_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'invalid_poll';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM group_members
    WHERE group_id = v_group_id AND user_id = auth.uid() AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  IF p_new_delay < 0 THEN
    RAISE EXCEPTION 'invalid_delay';
  END IF;

  UPDATE game_polls SET expansion_delay_hours = p_new_delay
   WHERE id = p_poll_id AND status = 'open';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 4.8 claim_poll_notifications — atomic claim, returns true to first caller only
CREATE OR REPLACE FUNCTION claim_poll_notifications(
  p_poll_id  UUID,
  p_kind     TEXT
)
RETURNS BOOLEAN AS $$
DECLARE
  v_updated INT;
BEGIN
  IF p_kind NOT IN ('creation', 'expanded', 'confirmed', 'cancellation') THEN
    RAISE EXCEPTION 'invalid_kind';
  END IF;

  -- Caller must be a member of the poll's group (RLS-equivalent check)
  IF NOT EXISTS (
    SELECT 1 FROM game_polls p
    JOIN group_members gm ON gm.group_id = p.group_id
    WHERE p.id = p_poll_id AND gm.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not_member';
  END IF;

  IF p_kind = 'creation' THEN
    UPDATE game_polls SET creation_notifications_sent_at = now()
      WHERE id = p_poll_id AND creation_notifications_sent_at IS NULL;
  ELSIF p_kind = 'expanded' THEN
    UPDATE game_polls SET expanded_notifications_sent_at = now()
      WHERE id = p_poll_id AND expanded_notifications_sent_at IS NULL;
  ELSIF p_kind = 'confirmed' THEN
    UPDATE game_polls SET confirmed_notifications_sent_at = now()
      WHERE id = p_poll_id AND confirmed_notifications_sent_at IS NULL;
  ELSIF p_kind = 'cancellation' THEN
    UPDATE game_polls SET cancellation_notifications_sent_at = now()
      WHERE id = p_poll_id AND cancellation_notifications_sent_at IS NULL;
  END IF;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- 4.9 link_poll_to_game — admin only, sets confirmed_game_id if currently NULL
CREATE OR REPLACE FUNCTION link_poll_to_game(
  p_poll_id  UUID,
  p_game_id  UUID
)
RETURNS VOID AS $$
DECLARE
  v_group_id UUID;
BEGIN
  SELECT group_id INTO v_group_id FROM game_polls WHERE id = p_poll_id;
  IF v_group_id IS NULL THEN
    RAISE EXCEPTION 'invalid_poll';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM group_members
    WHERE group_id = v_group_id AND user_id = auth.uid() AND role = 'admin'
  ) THEN
    RAISE EXCEPTION 'not_admin';
  END IF;

  -- Game must belong to the same group
  IF NOT EXISTS (
    SELECT 1 FROM games WHERE id = p_game_id AND group_id = v_group_id
  ) THEN
    RAISE EXCEPTION 'game_not_in_group';
  END IF;

  UPDATE game_polls SET confirmed_game_id = p_game_id
   WHERE id = p_poll_id AND confirmed_game_id IS NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ============================================================
-- 5. REALTIME PUBLICATION
-- ============================================================

DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY['game_polls', 'game_poll_dates', 'game_poll_votes'])
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND tablename = tbl
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE %I', tbl);
      RAISE NOTICE 'Added % to supabase_realtime', tbl;
    ELSE
      RAISE NOTICE '% already in supabase_realtime, skipping', tbl;
    END IF;
  END LOOP;
END $$;

-- ============================================================
-- DONE — Verify with:
--   SELECT tablename FROM pg_publication_tables
--     WHERE pubname = 'supabase_realtime' AND tablename LIKE 'game_poll%';
--   SELECT tgname FROM pg_trigger WHERE tgname = 'trg_auto_close_poll_on_vote';
--   SELECT proname FROM pg_proc WHERE proname LIKE '%poll%' ORDER BY proname;
-- ============================================================
