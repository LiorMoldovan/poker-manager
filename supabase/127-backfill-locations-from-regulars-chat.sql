-- ==============================================================================
-- Migration 127: Backfill locations with verified chat evidence from
-- "פוקר הקבועים 2026" (2022-10 to 2024-10 rotation era).
-- Group: Poker Night (d1998bed-7bae-4221-8877-20c537acfc43)
-- Total games targeted: 21
-- ==============================================================================

UPDATE games SET location = 'אייל' WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43' AND date = '2022-10-15T00:00:00+00:00';
UPDATE games SET location = 'אייל' WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43' AND date = '2022-11-05T00:00:00+00:00';
UPDATE games SET location = 'אייל' WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43' AND date = '2022-12-24T00:00:00+00:00';
UPDATE games SET location = 'אייל' WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43' AND date = '2023-02-25T00:00:00+00:00';
UPDATE games SET location = 'פאבל' WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43' AND date = '2023-04-20T00:00:00+00:00';
UPDATE games SET location = 'אייל' WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43' AND date = '2023-04-28T00:00:00+00:00';
UPDATE games SET location = 'פאבל' WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43' AND date = '2023-06-01T00:00:00+00:00';
UPDATE games SET location = 'אייל' WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43' AND date = '2023-06-08T00:00:00+00:00';
UPDATE games SET location = 'פאבל' WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43' AND date = '2024-01-11T00:00:00+00:00';
UPDATE games SET location = 'ליכטר' WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43' AND date = '2024-01-13T00:00:00+00:00';
UPDATE games SET location = 'ליכטר' WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43' AND date = '2024-02-03T00:00:00+00:00';
UPDATE games SET location = 'סגל' WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43' AND date = '2024-02-10T00:00:00+00:00';
UPDATE games SET location = 'סגל' WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43' AND date = '2024-05-02T00:00:00+00:00';
UPDATE games SET location = 'ליאור' WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43' AND date = '2024-05-04T00:00:00+00:00';
UPDATE games SET location = 'מלמד' WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43' AND date = '2024-05-11T00:00:00+00:00';
UPDATE games SET location = 'סגל' WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43' AND date = '2024-06-08T00:00:00+00:00';
UPDATE games SET location = 'ליאור' WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43' AND date = '2024-06-12T00:00:00+00:00';
UPDATE games SET location = 'ליכטר' WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43' AND date = '2024-09-15T00:00:00+00:00';
UPDATE games SET location = 'ליכטר' WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43' AND date = '2024-09-21T00:00:00+00:00';
UPDATE games SET location = 'מור' WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43' AND date = '2024-10-12T00:00:00+00:00';
UPDATE games SET location = 'מור' WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43' AND date = '2024-10-19T00:00:00+00:00';
