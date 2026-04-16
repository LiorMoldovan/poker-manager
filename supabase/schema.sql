-- ============================================================
-- Poker Manager — Supabase Schema
-- Run this entire file in Supabase SQL Editor (one shot).
--
-- Structure: CREATE all tables first, then ENABLE RLS,
-- then CREATE all policies (avoids forward-reference errors).
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ══════════════════════════════════════════════
-- PART 1: CREATE ALL TABLES
-- ══════════════════════════════════════════════

-- 1. GROUPS
CREATE TABLE groups (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL,
  created_by  UUID NOT NULL REFERENCES auth.users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. GROUP MEMBERS
CREATE TABLE group_members (
  id        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id  UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(group_id, user_id)
);

-- 3. PLAYERS
CREATE TABLE players (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id    UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'permanent' CHECK (type IN ('permanent', 'permanent_guest', 'guest')),
  gender      TEXT NOT NULL DEFAULT 'male' CHECK (gender IN ('male', 'female')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(group_id, name)
);

-- 4. PLAYER TRAITS
CREATE TABLE player_traits (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id   UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE UNIQUE,
  nickname    TEXT,
  job         TEXT,
  team        TEXT,
  style       JSONB DEFAULT '[]'::jsonb,
  quirks      JSONB DEFAULT '[]'::jsonb
);

-- 5. GAMES
CREATE TABLE games (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id            UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  date                TIMESTAMPTZ NOT NULL,
  status              TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live', 'chip_entry', 'completed')),
  location            TEXT,
  chip_gap            NUMERIC,
  chip_gap_per_player NUMERIC,
  ai_summary          TEXT,
  ai_summary_model    TEXT,
  pre_game_teaser     TEXT,
  forecast_comment    TEXT,
  forecast_accuracy   JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6. GAME PLAYERS
CREATE TABLE game_players (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  game_id     UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_id   UUID NOT NULL REFERENCES players(id),
  player_name TEXT NOT NULL,
  rebuys      INTEGER NOT NULL DEFAULT 1 CHECK (rebuys >= 0),
  chip_counts JSONB DEFAULT '{}'::jsonb,
  final_value NUMERIC NOT NULL DEFAULT 0,
  profit      NUMERIC NOT NULL DEFAULT 0,
  UNIQUE(game_id, player_id)
);

-- 7. GAME FORECASTS
CREATE TABLE game_forecasts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  game_id         UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_name     TEXT NOT NULL,
  expected_profit NUMERIC NOT NULL,
  highlight       TEXT,
  sentence        TEXT,
  is_surprise     BOOLEAN DEFAULT false
);

-- 8. SHARED EXPENSES
CREATE TABLE shared_expenses (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  game_id           UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  description       TEXT NOT NULL,
  paid_by           UUID REFERENCES players(id),
  paid_by_name      TEXT NOT NULL,
  amount            NUMERIC NOT NULL CHECK (amount > 0),
  participants      JSONB NOT NULL DEFAULT '[]'::jsonb,
  participant_names JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 9. PAID SETTLEMENTS
CREATE TABLE paid_settlements (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  game_id     UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  from_player TEXT NOT NULL,
  to_player   TEXT NOT NULL,
  amount      NUMERIC,
  paid_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 10. PERIOD MARKERS
CREATE TABLE period_markers (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  game_id                UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE UNIQUE,
  is_first_game_of_month BOOLEAN DEFAULT false,
  is_last_game_of_month  BOOLEAN DEFAULT false,
  is_first_game_of_half  BOOLEAN DEFAULT false,
  is_last_game_of_half   BOOLEAN DEFAULT false,
  is_first_game_of_year  BOOLEAN DEFAULT false,
  is_last_game_of_year   BOOLEAN DEFAULT false,
  month_name             TEXT,
  half_label             TEXT,
  year                   INTEGER
);

-- 11. CHIP VALUES
CREATE TABLE chip_values (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id      UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  color         TEXT NOT NULL,
  value         NUMERIC NOT NULL,
  display_color TEXT NOT NULL
);

-- 12. SETTINGS
CREATE TABLE settings (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id          UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE UNIQUE,
  rebuy_value       NUMERIC NOT NULL DEFAULT 50,
  chips_per_rebuy   INTEGER NOT NULL DEFAULT 1000,
  min_transfer      NUMERIC NOT NULL DEFAULT 20,
  game_night_days   JSONB DEFAULT '[4, 6]'::jsonb,
  locations         JSONB DEFAULT '[]'::jsonb,
  blocked_transfers JSONB DEFAULT '[]'::jsonb
);

-- 13. PENDING FORECASTS
CREATE TABLE pending_forecasts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id        UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  player_ids      JSONB NOT NULL DEFAULT '[]'::jsonb,
  forecasts       JSONB NOT NULL DEFAULT '[]'::jsonb,
  linked_game_id  UUID REFERENCES games(id) ON DELETE SET NULL,
  pre_game_teaser TEXT,
  ai_model        TEXT,
  published       BOOLEAN DEFAULT false,
  location        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 14. CHRONICLE PROFILES
CREATE TABLE chronicle_profiles (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id     UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  period_key   TEXT NOT NULL,
  profiles     JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at TEXT,
  model        TEXT,
  UNIQUE(group_id, period_key)
);

-- 15. GRAPH INSIGHTS
CREATE TABLE graph_insights (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id     UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  period_key   TEXT NOT NULL,
  text         TEXT NOT NULL,
  generated_at TEXT,
  model        TEXT,
  UNIQUE(group_id, period_key)
);

-- 16. TTS POOLS
CREATE TABLE tts_pools (
  id       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  game_id  UUID NOT NULL REFERENCES games(id) ON DELETE CASCADE UNIQUE,
  pool     JSONB NOT NULL,
  model    TEXT
);

-- 17. ACTIVITY LOG
CREATE TABLE activity_log (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id         UUID REFERENCES groups(id) ON DELETE CASCADE,
  device_id        TEXT NOT NULL,
  role             TEXT NOT NULL,
  timestamp        TIMESTAMPTZ NOT NULL DEFAULT now(),
  device           TEXT,
  screen_size      TEXT,
  screens_visited  JSONB DEFAULT '[]'::jsonb,
  session_duration INTEGER DEFAULT 0,
  last_active      TIMESTAMPTZ,
  fingerprint      JSONB,
  player_name      TEXT
);

-- 18. TRAINING POOL
CREATE TABLE training_pool (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id    UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  scenario_id TEXT NOT NULL,
  category    TEXT NOT NULL,
  category_id TEXT NOT NULL,
  scenario    JSONB NOT NULL,
  reviewed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(group_id, scenario_id)
);

-- 19. TRAINING ANSWERS
CREATE TABLE training_answers (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id    UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  player_name TEXT NOT NULL,
  sessions    JSONB NOT NULL DEFAULT '[]'::jsonb,
  stats       JSONB NOT NULL DEFAULT '{}'::jsonb,
  reports     JSONB DEFAULT '[]'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(group_id, player_name)
);

-- 20. TRAINING INSIGHTS
CREATE TABLE training_insights (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  group_id    UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  player_name TEXT NOT NULL,
  insights    JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(group_id, player_name)
);

-- ══════════════════════════════════════════════
-- PART 2: ENABLE RLS ON ALL TABLES
-- ══════════════════════════════════════════════

ALTER TABLE groups             ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_members      ENABLE ROW LEVEL SECURITY;
ALTER TABLE players            ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_traits      ENABLE ROW LEVEL SECURITY;
ALTER TABLE games              ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_players       ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_forecasts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_expenses    ENABLE ROW LEVEL SECURITY;
ALTER TABLE paid_settlements   ENABLE ROW LEVEL SECURITY;
ALTER TABLE period_markers     ENABLE ROW LEVEL SECURITY;
ALTER TABLE chip_values        ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings           ENABLE ROW LEVEL SECURITY;
ALTER TABLE pending_forecasts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE chronicle_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_insights     ENABLE ROW LEVEL SECURITY;
ALTER TABLE tts_pools          ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log       ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_pool      ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_answers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_insights  ENABLE ROW LEVEL SECURITY;

-- ══════════════════════════════════════════════
-- PART 3: RLS POLICIES (all tables exist now)
-- ══════════════════════════════════════════════

-- ── GROUPS ──
CREATE POLICY "groups_select" ON groups
  FOR SELECT USING (
    id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid())
  );
CREATE POLICY "groups_insert" ON groups
  FOR INSERT WITH CHECK (auth.uid() = created_by);

-- ── GROUP MEMBERS ──
CREATE POLICY "gm_select" ON group_members
  FOR SELECT USING (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid())
  );
CREATE POLICY "gm_admin_manage" ON group_members
  FOR ALL USING (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid() AND role = 'admin')
  );
CREATE POLICY "gm_self_join" ON group_members
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ── PLAYERS ──
CREATE POLICY "players_select" ON players
  FOR SELECT USING (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid())
  );
CREATE POLICY "players_insert" ON players
  FOR INSERT WITH CHECK (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid() AND role IN ('admin', 'member'))
  );
CREATE POLICY "players_update" ON players
  FOR UPDATE USING (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid() AND role IN ('admin', 'member'))
  );
CREATE POLICY "players_delete" ON players
  FOR DELETE USING (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid() AND role = 'admin')
  );

-- ── PLAYER TRAITS ──
CREATE POLICY "traits_select" ON player_traits
  FOR SELECT USING (
    player_id IN (SELECT id FROM players WHERE group_id IN (
      SELECT group_id FROM group_members WHERE user_id = auth.uid()
    ))
  );
CREATE POLICY "traits_admin" ON player_traits
  FOR ALL USING (
    player_id IN (SELECT id FROM players WHERE group_id IN (
      SELECT group_id FROM group_members WHERE user_id = auth.uid() AND role = 'admin'
    ))
  );

-- ── GAMES ──
CREATE POLICY "games_select" ON games
  FOR SELECT USING (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid())
  );
CREATE POLICY "games_insert" ON games
  FOR INSERT WITH CHECK (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid() AND role IN ('admin', 'member'))
  );
CREATE POLICY "games_update" ON games
  FOR UPDATE USING (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid() AND role IN ('admin', 'member'))
  );
CREATE POLICY "games_delete" ON games
  FOR DELETE USING (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid() AND role = 'admin')
  );

-- ── GAME PLAYERS ──
CREATE POLICY "gp_select" ON game_players
  FOR SELECT USING (
    game_id IN (SELECT id FROM games WHERE group_id IN (
      SELECT group_id FROM group_members WHERE user_id = auth.uid()
    ))
  );
CREATE POLICY "gp_insert" ON game_players
  FOR INSERT WITH CHECK (
    game_id IN (SELECT id FROM games WHERE group_id IN (
      SELECT group_id FROM group_members WHERE user_id = auth.uid() AND role IN ('admin', 'member')
    ))
  );
CREATE POLICY "gp_update" ON game_players
  FOR UPDATE USING (
    game_id IN (SELECT id FROM games WHERE group_id IN (
      SELECT group_id FROM group_members WHERE user_id = auth.uid() AND role IN ('admin', 'member')
    ))
  );
CREATE POLICY "gp_delete" ON game_players
  FOR DELETE USING (
    game_id IN (SELECT id FROM games WHERE group_id IN (
      SELECT group_id FROM group_members WHERE user_id = auth.uid() AND role IN ('admin', 'member')
    ))
  );

-- ── GAME FORECASTS ──
CREATE POLICY "gf_select" ON game_forecasts
  FOR SELECT USING (
    game_id IN (SELECT id FROM games WHERE group_id IN (
      SELECT group_id FROM group_members WHERE user_id = auth.uid()
    ))
  );
CREATE POLICY "gf_write" ON game_forecasts
  FOR ALL USING (
    game_id IN (SELECT id FROM games WHERE group_id IN (
      SELECT group_id FROM group_members WHERE user_id = auth.uid() AND role IN ('admin', 'member')
    ))
  );

-- ── SHARED EXPENSES ──
CREATE POLICY "exp_select" ON shared_expenses
  FOR SELECT USING (
    game_id IN (SELECT id FROM games WHERE group_id IN (
      SELECT group_id FROM group_members WHERE user_id = auth.uid()
    ))
  );
CREATE POLICY "exp_write" ON shared_expenses
  FOR ALL USING (
    game_id IN (SELECT id FROM games WHERE group_id IN (
      SELECT group_id FROM group_members WHERE user_id = auth.uid() AND role IN ('admin', 'member')
    ))
  );

-- ── PAID SETTLEMENTS ──
CREATE POLICY "ps_select" ON paid_settlements
  FOR SELECT USING (
    game_id IN (SELECT id FROM games WHERE group_id IN (
      SELECT group_id FROM group_members WHERE user_id = auth.uid()
    ))
  );
CREATE POLICY "ps_write" ON paid_settlements
  FOR ALL USING (
    game_id IN (SELECT id FROM games WHERE group_id IN (
      SELECT group_id FROM group_members WHERE user_id = auth.uid() AND role IN ('admin', 'member')
    ))
  );

-- ── PERIOD MARKERS ──
CREATE POLICY "pm_select" ON period_markers
  FOR SELECT USING (
    game_id IN (SELECT id FROM games WHERE group_id IN (
      SELECT group_id FROM group_members WHERE user_id = auth.uid()
    ))
  );
CREATE POLICY "pm_write" ON period_markers
  FOR ALL USING (
    game_id IN (SELECT id FROM games WHERE group_id IN (
      SELECT group_id FROM group_members WHERE user_id = auth.uid() AND role IN ('admin', 'member')
    ))
  );

-- ── CHIP VALUES ──
CREATE POLICY "cv_select" ON chip_values
  FOR SELECT USING (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid())
  );
CREATE POLICY "cv_admin" ON chip_values
  FOR ALL USING (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid() AND role = 'admin')
  );

-- ── SETTINGS ──
CREATE POLICY "settings_select" ON settings
  FOR SELECT USING (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid())
  );
CREATE POLICY "settings_admin" ON settings
  FOR ALL USING (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid() AND role = 'admin')
  );

-- ── PENDING FORECASTS ──
CREATE POLICY "pf_select" ON pending_forecasts
  FOR SELECT USING (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid())
  );
CREATE POLICY "pf_write" ON pending_forecasts
  FOR ALL USING (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid() AND role IN ('admin', 'member'))
  );

-- ── CHRONICLE PROFILES ──
CREATE POLICY "cp_select" ON chronicle_profiles
  FOR SELECT USING (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid())
  );
CREATE POLICY "cp_write" ON chronicle_profiles
  FOR ALL USING (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid() AND role IN ('admin', 'member'))
  );

-- ── GRAPH INSIGHTS ──
CREATE POLICY "gi_select" ON graph_insights
  FOR SELECT USING (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid())
  );
CREATE POLICY "gi_write" ON graph_insights
  FOR ALL USING (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid() AND role IN ('admin', 'member'))
  );

-- ── TTS POOLS ──
CREATE POLICY "tts_select" ON tts_pools
  FOR SELECT USING (
    game_id IN (SELECT id FROM games WHERE group_id IN (
      SELECT group_id FROM group_members WHERE user_id = auth.uid()
    ))
  );
CREATE POLICY "tts_write" ON tts_pools
  FOR ALL USING (
    game_id IN (SELECT id FROM games WHERE group_id IN (
      SELECT group_id FROM group_members WHERE user_id = auth.uid() AND role IN ('admin', 'member')
    ))
  );

-- ── ACTIVITY LOG ──
CREATE POLICY "al_admin_read" ON activity_log
  FOR SELECT USING (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid() AND role = 'admin')
  );
CREATE POLICY "al_insert" ON activity_log
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "al_update" ON activity_log
  FOR UPDATE USING (auth.uid() IS NOT NULL);
CREATE POLICY "al_admin_delete" ON activity_log
  FOR DELETE USING (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid() AND role = 'admin')
  );

-- ── TRAINING POOL ──
CREATE POLICY "tp_select" ON training_pool
  FOR SELECT USING (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid())
  );
CREATE POLICY "tp_admin" ON training_pool
  FOR ALL USING (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid() AND role = 'admin')
  );

-- ── TRAINING ANSWERS ──
CREATE POLICY "ta_select" ON training_answers
  FOR SELECT USING (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid())
  );
CREATE POLICY "ta_insert" ON training_answers
  FOR INSERT WITH CHECK (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid())
  );
CREATE POLICY "ta_update" ON training_answers
  FOR UPDATE USING (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid())
  );
CREATE POLICY "ta_admin_delete" ON training_answers
  FOR DELETE USING (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid() AND role = 'admin')
  );

-- ── TRAINING INSIGHTS ──
CREATE POLICY "ti_select" ON training_insights
  FOR SELECT USING (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid())
  );
CREATE POLICY "ti_insert" ON training_insights
  FOR INSERT WITH CHECK (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid())
  );
CREATE POLICY "ti_update" ON training_insights
  FOR UPDATE USING (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid())
  );
CREATE POLICY "ti_admin_delete" ON training_insights
  FOR DELETE USING (
    group_id IN (SELECT group_id FROM group_members WHERE user_id = auth.uid() AND role = 'admin')
  );

-- ══════════════════════════════════════════════
-- PART 4: INDEXES
-- ══════════════════════════════════════════════

CREATE INDEX idx_gm_user ON group_members(user_id);
CREATE INDEX idx_gm_group ON group_members(group_id);
CREATE INDEX idx_games_group_status ON games(group_id, status);
CREATE INDEX idx_games_group_date ON games(group_id, date DESC);
CREATE INDEX idx_game_players_game ON game_players(game_id);
CREATE INDEX idx_game_players_player ON game_players(player_id);
CREATE INDEX idx_game_forecasts_game ON game_forecasts(game_id);
CREATE INDEX idx_shared_expenses_game ON shared_expenses(game_id);
CREATE INDEX idx_paid_settlements_game ON paid_settlements(game_id);
CREATE INDEX idx_training_pool_group_cat ON training_pool(group_id, category_id);
CREATE INDEX idx_training_answers_group ON training_answers(group_id);
CREATE INDEX idx_activity_log_group ON activity_log(group_id, timestamp DESC);

-- ══════════════════════════════════════════════
-- PART 5: REALTIME (enable for live updates)
-- ══════════════════════════════════════════════

ALTER PUBLICATION supabase_realtime ADD TABLE game_players;
ALTER PUBLICATION supabase_realtime ADD TABLE shared_expenses;
ALTER PUBLICATION supabase_realtime ADD TABLE paid_settlements;
ALTER PUBLICATION supabase_realtime ADD TABLE games;
ALTER PUBLICATION supabase_realtime ADD TABLE training_answers;

-- ══════════════════════════════════════════════
-- Done! 20 tables, RLS on all, 50+ policies,
-- 12 indexes, 5 realtime subscriptions.
-- ══════════════════════════════════════════════
