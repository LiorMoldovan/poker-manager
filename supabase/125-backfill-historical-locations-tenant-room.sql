-- ==============================================================================
-- Migration 125: Backfill historical locations with 'חדר דיירים'
-- All games up to 2022-10-01 were hosted in Eyal's tenant room ("חדר דיירים")
-- prior to the start of home hosting rotation.
-- Group: Poker Night (d1998bed-7bae-4221-8877-20c537acfc43)
-- Total games targeted: 45
-- ==============================================================================

UPDATE games
SET location = 'חדר דיירים'
WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43'
  AND date <= '2022-10-01T23:59:59+00:00'
  AND (location IS NULL OR TRIM(location) = '');
