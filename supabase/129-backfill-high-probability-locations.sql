-- ==============================================================================
-- Migration 129: Backfill 10 locations with high-probability textual and
-- contextual evidence from "פוקר הקבועים 2026" and group titles.
-- Group: Poker Night (d1998bed-7bae-4221-8877-20c537acfc43)
-- Total games targeted: 10
-- ==============================================================================

-- 1. 2023-01-28: Lichter explicitly confirms next morning: "בחצר של קרני"
UPDATE games SET location = 'קרני' WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43' AND date = '2023-01-28T00:00:00+00:00';

-- 2. 2023-04-26: Pavel explicitly writes: "אצל אייל", Eyal confirms: "אצלי"
UPDATE games SET location = 'אייל' WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43' AND date = '2023-04-26T00:00:00+00:00';

-- 3. 2023-09-24: Lichter writes: "סביר להניח משחקים אצלי, ליאור אתה יכול לשמש גיבוי?"
UPDATE games SET location = 'ליכטר' WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43' AND date = '2023-09-24T00:00:00+00:00';

-- 4. 2024-01-20: Lichter next morning: "שיחקתי אצל ההורים של סגל... ב-10 מהן ישבתי במקום בו הייתי אתמול"
UPDATE games SET location = 'סגל' WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43' AND date = '2024-01-20T00:00:00+00:00';

-- 5. 2024-02-17: Group title "פוקר שבת - כפר סבא", Segal absent, Lichter only Kfar Saba player
UPDATE games SET location = 'ליכטר' WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43' AND date = '2024-02-17T00:00:00+00:00';

-- 6. 2024-03-08: Lichter writes: "אפרת כנראה יוצאת מחר... אני חושב שאוכל לארח"
UPDATE games SET location = 'ליכטר' WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43' AND date = '2024-03-08T00:00:00+00:00';

-- 7. 2024-03-30: Eyal writes: "משחקים בשבת. ככל הנראה אצל ליאור"
UPDATE games SET location = 'ליאור' WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43' AND date = '2024-03-30T00:00:00+00:00';

-- 8. 2024-04-24: Eyal writes: "אשאיר אצל ליכטר", Lichter shares flop photo from home
UPDATE games SET location = 'ליכטר' WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43' AND date = '2024-04-24T00:00:00+00:00';

-- 9. 2024-04-26: Friday in Ramla during stabbing incident (Philip: "רמלה מי יעצור באדום", Eyal: "בדרך 20:53")
UPDATE games SET location = 'פאבל' WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43' AND date = '2024-04-26T00:00:00+00:00';

-- 10. 2024-06-01: Lior has cover, Segal replies: "אני יכול לפרוש מפת שולחן רגילה, אבל זה נוגד את אמנת לאס וגאס" (Lior absent)
UPDATE games SET location = 'סגל' WHERE group_id = 'd1998bed-7bae-4221-8877-20c537acfc43' AND date = '2024-06-01T00:00:00+00:00';
