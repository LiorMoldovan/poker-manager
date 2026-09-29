-- ==============================================================================
-- Migration 126: Backfill remaining historical locations with 'רוטציה'
-- All games from October 2022 to October 2024 took place in home rotation across
-- regular hosts (Segal, Lior, Lichter, Eyal, Pavel, Mor) without addresses recorded.
-- Group: Poker Night (d1998bed-7bae-4221-8877-20c537acfc43)
-- Total games targeted: 105
-- ==============================================================================

UPDATE games
SET location = 'רוטציה'
WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43'
  AND (location IS NULL OR TRIM(location) = '');
