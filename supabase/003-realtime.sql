-- Enable Supabase Realtime for tables that need live updates
-- Run this in the Supabase SQL Editor after schema.sql and 002-auth-support.sql

ALTER PUBLICATION supabase_realtime ADD TABLE players;
ALTER PUBLICATION supabase_realtime ADD TABLE games;
ALTER PUBLICATION supabase_realtime ADD TABLE game_players;
ALTER PUBLICATION supabase_realtime ADD TABLE shared_expenses;
ALTER PUBLICATION supabase_realtime ADD TABLE game_forecasts;
ALTER PUBLICATION supabase_realtime ADD TABLE paid_settlements;
ALTER PUBLICATION supabase_realtime ADD TABLE settings;
ALTER PUBLICATION supabase_realtime ADD TABLE chip_values;
ALTER PUBLICATION supabase_realtime ADD TABLE pending_forecasts;
ALTER PUBLICATION supabase_realtime ADD TABLE chronicle_profiles;
ALTER PUBLICATION supabase_realtime ADD TABLE graph_insights;
