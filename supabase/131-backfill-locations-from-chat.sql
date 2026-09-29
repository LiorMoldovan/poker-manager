-- Migration 131: Backfill 4 historical game locations verified with high certainty from WhatsApp chat
-- Group ID: d1998bed-7bae-4221-8877-20c537acfc43
--
-- 1. 2023-01-07 -> ליכטר (Lichter confirmed 6 players, Eyal: "פתח קבוצה, נשחק אצלך?", Lichter opened group and sent results)
-- 2. 2023-01-21 -> אייל (Eyal organized at his house while Lichter and Tomer were away in the Golan, Kobi asked "איפה? @אייל", Eyal confirmed)
-- 3. 2023-05-11 -> פאבל (Pavel: "אצלי!!! אין לי אפשרות אחרת יש לי קורס באותו יום עד 21:00 ברמלה", Eyal: "אצל פאבל")
-- 4. 2024-03-23 -> אייל (Eyal morning after: "מעבר לזה גם השולחן אצלי מאוד לא נוח. קשה לאסוף קלפים/ציפים")

DO $$
BEGIN
  -- 2023-01-07 -> ליכטר
  UPDATE games 
  SET location = 'ליכטר' 
  WHERE id = '92c63ee3-ec09-4e67-b03f-f857029bfe18' 
    AND location IS NULL;

  -- 2023-01-21 -> אייל
  UPDATE games 
  SET location = 'אייל' 
  WHERE id = '7a2270c1-0540-48fe-a535-5c2312717740' 
    AND location IS NULL;

  -- 2023-05-11 -> פאבל
  UPDATE games 
  SET location = 'פאבל' 
  WHERE id = 'ca380edb-43f5-40d1-8ccb-9e1b6c38f64f' 
    AND location IS NULL;

  -- 2024-03-23 -> אייל
  UPDATE games 
  SET location = 'אייל' 
  WHERE id = '436dbe0e-9ac7-4465-9672-79db6fe7bcdf' 
    AND location IS NULL;
END $$;
