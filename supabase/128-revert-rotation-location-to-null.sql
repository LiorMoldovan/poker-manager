-- ==============================================================================
-- Migration 128: Revert temporary 'רוטציה' locations back to NULL.
-- Keeps all verified hosts (21 newly extracted from regulars chat + previous ones)
-- and reverts games without a verified host back to unpopulated (NULL).
-- Group: Poker Night (d1998bed-7bae-4221-8877-20c537acfc43)
-- Total games targeted: 85
-- ==============================================================================

UPDATE games
SET location = NULL
WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43'
  AND location = 'רוטציה';
