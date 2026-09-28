-- ============================================================================
-- Migration 122: Backfill historical game locations (2024-2025) and separate shelters
-- ============================================================================
-- 1. Updates 62 historical games (Nov 2024 - Dec 2025) with verified locations.
-- 2. Distinguishes 'מקלט ליכטר' (office shelter) from 'מקלט' (Herzog).
-- Note: Does NOT modify settings (locations/addresses/notes remain untouched).
-- ============================================================================

-- ── 2. Update 2026 shelter games (exact user manual specification) ─────────
UPDATE games SET location = 'מקלט ליכטר' WHERE id = 'bc58d699-1605-47ab-9708-6e295a60a4d7'; -- 2026-03-05
UPDATE games SET location = 'מקלט ליכטר' WHERE id = '1d590551-46ee-4bb1-b7e4-28baa95eca0b'; -- 2026-03-12
UPDATE games SET location = 'מקלט' WHERE id = '9e615c09-2b21-4d60-b1f5-f4019e8848e6'; -- 2026-03-21
UPDATE games SET location = 'מקלט' WHERE id = '0c14fd2e-75b5-4dfb-ab1c-9eb26e1a8688'; -- 2026-03-26
UPDATE games SET location = 'מקלט' WHERE id = '5795037e-390b-4aa4-a733-0123ff8683c2'; -- 2026-04-02
UPDATE games SET location = 'מקלט' WHERE id = 'b485e6b3-b0e8-44ae-8a37-4a0f694fa757'; -- 2026-04-05

-- ── 3. Backfill 62 historical games (Nov 2024 - Dec 2025) ──────────────────
UPDATE games SET location = 'ליאור' WHERE id = 'a504e922-346c-49cb-ade6-86b39d2e22c7'; -- 2024-11-02 (ליאור: אפרים קציר 24 0521)
UPDATE games SET location = 'סגל' WHERE id = 'aecfc62b-ceee-41f8-ab40-c06736d89969'; -- 2024-11-09 (סגל: פנקס 7 כפר סבא 21:00)
UPDATE games SET location = 'ליכטר' WHERE id = '0155f84d-8aef-42e1-a725-d04974a4f294'; -- 2024-11-16 (ליכטר: דוד זהבי 16 כפר סבא קומה 0 דירה 1 קוד 5555)
UPDATE games SET location = 'סגל' WHERE id = '3e8db7e8-c6ce-44f4-8e96-f1f3ea924ac7'; -- 2024-11-23 (סגל: בעלי הנכס מוכנים... פנקס 7)
UPDATE games SET location = 'אורן' WHERE id = '9e21ad2c-bd28-4b0f-a9b6-5d029079cea7'; -- 2024-11-30 (תומר: אצל אורן | אורן: יש בירות ופיצה באחריות אשתי)
UPDATE games SET location = 'ליכטר' WHERE id = '0d549bbc-eb1a-4dc5-8cb6-c506941f6e43'; -- 2024-12-07 (ליכטר: היי בסופו של דבר משחקים אצלי... דוד זהבי 16)
UPDATE games SET location = 'סגל' WHERE id = 'd21658e3-26d0-478c-9313-404c13d0f6d5'; -- 2024-12-14 (סגל: פנקס 7 כפר סבא רשמית 21:00)
UPDATE games SET location = 'ליאור' WHERE id = 'b0109625-3a50-479f-9023-c50b1229d8d2'; -- 2024-12-19 (משחק חמישי: רוטציה מול סגל ואייל שאירחו סביב מועד זה)
UPDATE games SET location = 'אייל' WHERE id = '4a37854a-7d42-4465-9f8b-b3c54b3290e8'; -- 2024-12-21 (אייל המארח הקבוע היחיד ששיחק (ליאור, סגל, ליכטר לא שיחקו))
UPDATE games SET location = 'ליכטר' WHERE id = '27b6e46c-58a8-4cd7-a5b4-dbe97894df48'; -- 2024-12-28 (אייל: שבת 20:45 אצל ליכטר)
UPDATE games SET location = 'ליאור' WHERE id = '4978eb14-e415-42f4-b552-964313b9ed96'; -- 2025-01-04 (ליאור: נשחק אצלי | אייל: 20:30 אצל ליאור)
UPDATE games SET location = 'סגל' WHERE id = '7d1d9cc7-9aee-478d-aacf-ff4af28b88c9'; -- 2025-01-11 (סגל: הערב רשמית ב21:00 פנקס 7 כפר סבא)
UPDATE games SET location = 'סגל' WHERE id = 'e81c04c2-9834-48e5-8ffd-a1209b91503c'; -- 2025-01-18 (סגל: יש אישור אצלי, פנקס 7)
UPDATE games SET location = 'ליאור' WHERE id = '6e139dc0-5b2f-4f91-819c-349fc6dfa601'; -- 2025-01-25 (אייל: משחקים ב-20:30 אצל ליאור, קציר 24)
UPDATE games SET location = 'ליאור' WHERE id = 'f58d1cee-65e9-4e90-9e43-7455dc0659fb'; -- 2025-01-31 (ליאור נעץ הודעת כתובת; סגל לא שיחק; מרפסת אייל סגורה בחורף)
UPDATE games SET location = 'סגל' WHERE id = '7abff889-caf0-4b87-b76d-9c611ed1a3dd'; -- 2025-02-08 (סגל: אצלי, 21:00 פנקס 7 כפר סבא יש פטרית חימום)
UPDATE games SET location = 'ליאור' WHERE id = '7fd51326-75a7-41ca-a0af-b6b8019754fc'; -- 2025-02-15 (ליאור: בדיוק חזרתי... משחקים אצלי)
UPDATE games SET location = 'אורן' WHERE id = '4cedd64b-d68a-4902-bb43-388d859f95d1'; -- 2025-02-22 (אייל: ברוב קולות, מחר אצל אורן 20:45 | אורן: אין עישון בבית יש תינוקת)
UPDATE games SET location = 'ליכטר' WHERE id = 'bfd0baf9-8bcb-431b-972c-907293dcf347'; -- 2025-03-01 (עידן: איפה משחקים? | ליאור: ליכטר | אייל: תכין נרגילה)
UPDATE games SET location = 'סגל' WHERE id = '36628649-1e51-46e1-a8ba-0cb6f29ca70d'; -- 2025-03-08 (סגל: מחר אצלי, 21:00 פנקס 7 כפר סבא יש פטרית חימום)
UPDATE games SET location = 'ליאור' WHERE id = '867086fc-acd9-4baf-8854-61e4d58c9d1e'; -- 2025-03-15 (ליכטר: משחקים אצל ליאור | ליאור: אפרים קציר 24)
UPDATE games SET location = 'חרדון' WHERE id = '46a9b32e-9e79-4362-881b-00864962a346'; -- 2025-03-22 (אורן: מה הכתובת? | ארז חרדון: אצלי 🧮 | אייל: המשלחת בדרך)
UPDATE games SET location = 'ליכטר' WHERE id = '90bb210a-8f1b-456d-adb2-a59f5fa5fddf'; -- 2025-03-29 (ליכטר: יש אצלי נרגילה וכמה בירות... דוד זהבי)
UPDATE games SET location = 'סגל' WHERE id = 'a0918edf-d273-4b4e-9f20-725989058756'; -- 2025-04-05 (סגל: הערב אצלי, 21:00 פנקס 7 כפר סבא)
UPDATE games SET location = 'אייל' WHERE id = 'f8c26e65-68c9-45fc-8fc0-82e4f41c5755'; -- 2025-04-10 (אייל: בוקר. משחקים היום. 20:45 אצלי | סגל: עולה (קומה 11))
UPDATE games SET location = 'ליאור' WHERE id = '62f9e9de-9907-4b0e-9354-5841ce85c938'; -- 2025-04-14 (אייל: ליאור מארח | אייל: קציר 24 | סגל: תורם למארח)
UPDATE games SET location = 'ליאור' WHERE id = '7ccfab40-e5ae-4a4d-9cb9-56bf42f088a0'; -- 2025-04-17 (ליאור: לא תסיימו היום תקבלו שוב בפוקר של יום חמישי | קציר 24)
UPDATE games SET location = 'אייל' WHERE id = 'b23c9ac1-29a6-4742-848c-f83348913ee9'; -- 2025-04-26 (אייל: 20:45. בית הבד 6 הוד השרון קומה 11)
UPDATE games SET location = 'סגל' WHERE id = 'bd5b11e1-6edb-4b6b-819b-0a699c82bc4d'; -- 2025-05-01 (סגל: הערב אצלי, 21:00 פנקס 7 כפר סבא)
UPDATE games SET location = 'ליאור' WHERE id = '02a05684-2a74-4c77-a7dc-122e121047cb'; -- 2025-05-10 (עידן: היום אצל ליאור? | ליאור: כן | יש לי 2 בירות)
UPDATE games SET location = 'סגל' WHERE id = '60660c38-9d0e-414d-a577-29ef4244c52a'; -- 2025-05-17 (סגל: יש אישור עקרוני לעלות לשטח, מחר אצלי! הערב 21:00)
UPDATE games SET location = 'סגל' WHERE id = '7900ab12-2ea7-4590-aa9a-1b3111dc425e'; -- 2025-05-24 (סגל: הערב אצלי, 21:00 פנקס 7 כפר סבא)
UPDATE games SET location = 'סגל' WHERE id = 'ed7cea9a-1357-4105-8578-fa4109a58743'; -- 2025-05-31 (סגל: הערב אצלי, 21:00 פנקס 7 כפר סבא)
UPDATE games SET location = 'ליאור' WHERE id = 'c205c403-9d09-4c31-8d97-cebb774a53b6'; -- 2025-06-02 (שבועות: סגל לא שיחק; אייל אירח ב-6/6; ליאור אירח)
UPDATE games SET location = 'אייל' WHERE id = '62423061-a9ab-4b37-8f94-62a84fa37f40'; -- 2025-06-06 (אייל: 21:00 אצלי הערב. יש בירות. מרפסת)
UPDATE games SET location = 'מקלט ליכטר' WHERE id = '6ae5f871-ae95-4807-8940-30f2d0d52645'; -- 2025-06-19 (אישור ידני: שיחקנו במקלט ליכטר)
UPDATE games SET location = 'ליאור' WHERE id = 'ec48808e-6b6b-4066-a52a-43675a9b6f28'; -- 2025-06-28 (אייל: @Lior Moldovan יש אצלך בירות? | אייל: משחקים אבל אצל ליאור)
UPDATE games SET location = 'סגל' WHERE id = '718c75f3-c9ed-48ac-a00e-3cfc271d16e2'; -- 2025-07-03 (סגל: הערב אצלי, 21:00 פנקס 7 כפר סבא)
UPDATE games SET location = 'ליכטר' WHERE id = '87e68f10-529a-4501-86d5-dc2f00fdcb21'; -- 2025-07-10 (פאבל: אצל ליכטר כן ? | ליכטר אירח)
UPDATE games SET location = 'אייל' WHERE id = '4d81e21b-5723-40ea-ad37-434934c19d2d'; -- 2025-07-19 (אייל: משחקים 20:45 אצלי. בית הבד 6 הוד השרון קומה 11)
UPDATE games SET location = 'סגל' WHERE id = '91881d24-a9e4-4df3-aac1-471fce56d8f3'; -- 2025-07-26 (סגל: הערב אצלי, 21:00 פנקס 7 כפר סבא)
UPDATE games SET location = 'ליאור' WHERE id = '490b804f-251f-4ed4-b2ed-4a963bab58a4'; -- 2025-07-31 (ליאור: מזכיר שהיום ב-20:45 משחקים אצלי)
UPDATE games SET location = 'ליכטר' WHERE id = 'a218043d-e557-40ee-93ef-1d217696d577'; -- 2025-08-09 (פאבל: איפה משחקים ? | אייל: ליכטר)
UPDATE games SET location = 'אייל' WHERE id = '1a993fa9-4bcd-4c63-a982-0af865954042'; -- 2025-08-16 (אייל: 2. משחקים אצלי 20:45 במרפסת)
UPDATE games SET location = 'מור' WHERE id = 'fb9f0b22-8041-48ce-99d2-ade41148b4fe'; -- 2025-08-21 (מור: הכתובת זה: רוקח 106, רמת גן | אייל: אצל מור)
UPDATE games SET location = 'סגל' WHERE id = '0fd05c65-806c-459b-932d-8e76f66360c1'; -- 2025-08-30 (סגל: הערב 21:00 פנקס 7 כפר סבא)
UPDATE games SET location = 'ליכטר' WHERE id = 'ae8778dc-952e-47e8-be14-780e730a142b'; -- 2025-09-06 (ליכטר: היום אצלי 20:45 יש קצת בירות ונרגילה)
UPDATE games SET location = 'אייל' WHERE id = '6a94f61b-48b4-4a98-851d-3a55f86179e5'; -- 2025-09-11 (אייל: משחקים אצלי במרפסת 20:45)
UPDATE games SET location = 'סגל' WHERE id = 'c39ea5a4-d27a-440b-9569-60a58a4b8b18'; -- 2025-09-20 (ליאור: מזכיר לכולם שמשחקים הערב אצל סגל, פנקס 7 כפר סבא)
UPDATE games SET location = 'ליכטר' WHERE id = '49f5de51-3618-4cbc-ab68-e2aa9b6f492c'; -- 2025-09-26 (עידן: אצל ליכטר ב 20:45? | ליכטר: 21:00 | ליאור: דוד זהבי 16)
UPDATE games SET location = 'ליכטר' WHERE id = '69492c49-e78f-485f-a58b-2d6ac2c990b7'; -- 2025-09-28 (ליכטר: משחקים היום בשעה 21:00 אצלי | דוד זהבי 16)
UPDATE games SET location = 'פאבל' WHERE id = 'da63e38e-e4ee-4adc-90c9-03aa8658d6d1'; -- 2025-10-05 (פאבל: משחקים אצלי 20:45 דוגית 1 רמלה קומה 1 דירה 4)
UPDATE games SET location = 'סגל' WHERE id = '6df8edca-5692-4260-8728-378858696f37'; -- 2025-10-13 (סגל: הערב 21:00 פנקס 7 כפר סבא | עשיתי שוט גאן על הגינה)
UPDATE games SET location = 'סגל' WHERE id = '45f1ad18-882b-4d56-b27d-3f169cc8b01a'; -- 2025-10-18 (סגל: הערב 21:00 פנקס 7 כפר סבא)
UPDATE games SET location = 'סגל' WHERE id = 'c0697e23-9e22-473d-800b-43123455d8f4'; -- 2025-10-25 (סגל: הערב אצלי, פנקס 7)
UPDATE games SET location = 'אייל' WHERE id = '06c1ebdd-31bd-4f68-9085-66d9daf3e40b'; -- 2025-11-01 (אייל: יש רוחות אצלי במרפסת, תתלבשו בהתאם)
UPDATE games SET location = 'סגל' WHERE id = '01c1579d-3917-471b-804f-5c502984c8e0'; -- 2025-11-08 (סגל: כולם, משחקים אצלי)
UPDATE games SET location = 'ליאור' WHERE id = 'd5b7c90d-a5c3-4ef6-8929-2c5a0d872bfc'; -- 2025-11-15 (אייל: אצל ליאור בסוף | ליאור: נשחק אצלי תגיע לכיוון 9)
UPDATE games SET location = 'סגל' WHERE id = '13bab5e7-beb1-450c-aed3-1af0d9fb4846'; -- 2025-11-22 (סגל: אביא בירות... אצלי ב-21:00 פנקס 7)
UPDATE games SET location = 'ליאור' WHERE id = '35aa071c-824f-4a96-b94c-44b09d3f7712'; -- 2025-11-27 (ליאור: נשחק הערב אצלי אפרים קציר 24 הוד השרון 20:45)
UPDATE games SET location = 'סגל' WHERE id = 'cf85dc51-b3da-4dcc-951e-f23bc6d2f163'; -- 2025-12-06 (סגל: הערב 21:00 אצלי פנקס 7 כפר סבא)
UPDATE games SET location = 'ליכטר' WHERE id = 'dba7ad12-e029-4e34-99ff-a0bad722c495'; -- 2025-12-13 (אייל: 20:45 אצל ליכטר)

-- ============================================================================
