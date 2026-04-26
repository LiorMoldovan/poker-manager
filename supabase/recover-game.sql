-- ══════════════════════════════════════════════
-- Recovery: Restore yesterday's game from the auto backup
-- Backup ID: 2f4a3090-2056-434b-9cc1-18a82004d399
--
-- Run each step in order in Supabase SQL Editor.
-- ══════════════════════════════════════════════

-- STEP 1: Check which games in the backup are missing from the games table
-- This should show yesterday's game
SELECT g->>'id' as game_id,
       g->>'date' as game_date,
       g->>'status' as status,
       g->>'location' as location
FROM backups b,
     jsonb_array_elements(b.data->'games') as g
WHERE b.id = '2f4a3090-2056-434b-9cc1-18a82004d399'
  AND NOT EXISTS (
    SELECT 1 FROM games WHERE id = (g->>'id')::uuid
  )
ORDER BY g->>'date' DESC;

-- STEP 2: Insert missing game(s) from backup into games table
INSERT INTO games (id, group_id, date, status, location, chip_gap, chip_gap_per_player,
                   ai_summary, ai_summary_model, pre_game_teaser, forecast_comment,
                   forecast_accuracy, created_at)
SELECT
  (g->>'id')::uuid,
  b.group_id,
  (g->>'date')::timestamptz,
  g->>'status',
  g->>'location',
  (g->>'chipGap')::numeric,
  (g->>'chipGapPerPlayer')::numeric,
  g->>'aiSummary',
  g->>'aiSummaryModel',
  g->>'preGameTeaser',
  g->>'forecastComment',
  CASE WHEN g->'forecastAccuracy' IS NOT NULL AND g->>'forecastAccuracy' != 'null'
       THEN g->'forecastAccuracy' ELSE NULL END,
  (g->>'createdAt')::timestamptz
FROM backups b,
     jsonb_array_elements(b.data->'games') as g
WHERE b.id = '2f4a3090-2056-434b-9cc1-18a82004d399'
  AND NOT EXISTS (
    SELECT 1 FROM games WHERE id = (g->>'id')::uuid
  )
ON CONFLICT (id) DO NOTHING;

-- STEP 3: Insert missing game_players from backup
INSERT INTO game_players (id, game_id, player_id, player_name, rebuys, chip_counts, final_value, profit)
SELECT
  (gp->>'id')::uuid,
  (gp->>'gameId')::uuid,
  (gp->>'playerId')::uuid,
  gp->>'playerName',
  (gp->>'rebuys')::integer,
  COALESCE(gp->'chipCounts', '{}'::jsonb),
  (gp->>'finalValue')::numeric,
  (gp->>'profit')::numeric
FROM backups b,
     jsonb_array_elements(b.data->'gamePlayers') as gp
WHERE b.id = '2f4a3090-2056-434b-9cc1-18a82004d399'
  AND (gp->>'gameId')::uuid IN (
    -- Only for games that were missing (just inserted above)
    SELECT (g->>'id')::uuid
    FROM jsonb_array_elements(b.data->'games') as g
    WHERE NOT EXISTS (
      SELECT 1 FROM game_players WHERE game_id = (g->>'id')::uuid
    )
  )
ON CONFLICT (id) DO UPDATE SET
  rebuys = EXCLUDED.rebuys,
  chip_counts = EXCLUDED.chip_counts,
  final_value = EXCLUDED.final_value,
  profit = EXCLUDED.profit;

-- STEP 4: Restore shared expenses if the game had any
INSERT INTO shared_expenses (id, game_id, description, paid_by, paid_by_name, amount,
                             participants, participant_names, created_at)
SELECT
  (e->>'id')::uuid,
  (g->>'id')::uuid,
  e->>'description',
  NULLIF(e->>'paidBy', '')::uuid,
  e->>'paidByName',
  (e->>'amount')::numeric,
  COALESCE(e->'participants', '[]'::jsonb),
  COALESCE(e->'participantNames', '[]'::jsonb),
  (e->>'createdAt')::timestamptz
FROM backups b,
     jsonb_array_elements(b.data->'games') as g,
     jsonb_array_elements(g->'sharedExpenses') as e
WHERE b.id = '2f4a3090-2056-434b-9cc1-18a82004d399'
  AND NOT EXISTS (SELECT 1 FROM games orig WHERE orig.id = (g->>'id')::uuid
                  AND orig.created_at < b.created_at)
ON CONFLICT (id) DO NOTHING;

-- STEP 5: Restore forecasts if the game had any
INSERT INTO game_forecasts (game_id, player_name, expected_profit, highlight, sentence, is_surprise)
SELECT
  (g->>'id')::uuid,
  f->>'playerName',
  (f->>'expectedProfit')::numeric,
  f->>'highlight',
  f->>'sentence',
  COALESCE((f->>'isSurprise')::boolean, false)
FROM backups b,
     jsonb_array_elements(b.data->'games') as g,
     jsonb_array_elements(g->'forecasts') as f
WHERE b.id = '2f4a3090-2056-434b-9cc1-18a82004d399'
  AND NOT EXISTS (
    SELECT 1 FROM game_forecasts WHERE game_id = (g->>'id')::uuid
  )
  AND g->'forecasts' IS NOT NULL
  AND jsonb_array_length(g->'forecasts') > 0;

-- STEP 6: Verify the recovery worked
SELECT g.id, g.date, g.status, g.location,
       COUNT(gp.id) as player_count,
       SUM(gp.profit) as profit_sum
FROM games g
LEFT JOIN game_players gp ON gp.game_id = g.id
WHERE g.created_at > now() - interval '3 days'
GROUP BY g.id, g.date, g.status, g.location
ORDER BY g.date DESC;
