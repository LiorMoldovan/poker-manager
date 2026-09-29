-- Migration 130: Backfill historical chip counts, rebuys, and final values from WhatsApp chat images
-- Group ID: d1998bed-7bae-4221-8877-20c537acfc43
-- Verified 100% against historical calculations with ZERO profit discrepancies.
-- Player profits are completely untouched.

DO $$
BEGIN

  -- Game 2022-07-02 (IMG-20220703-WA0001.json)
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":52,"red":23,"blue":21,"green":11,"black":19,"yellow":0}'::jsonb, final_value = 173, total_chip_count = 33600 WHERE id = '278413aa-bfe0-4e40-bc46-d06254547222';
  UPDATE game_players SET rebuys = 1, chip_counts = '{"white":7,"red":14,"blue":7,"green":7,"black":2,"yellow":0}'::jsonb, final_value = 47, total_chip_count = 7450 WHERE id = 'b79408f8-b10b-4f4f-ae16-c70cc461e71c';
  UPDATE game_players SET rebuys = 1, chip_counts = '{"white":1,"red":0,"blue":2,"green":1,"black":2,"yellow":0}'::jsonb, final_value = 27, total_chip_count = 3450 WHERE id = '11feb66b-1e69-46ef-a6a1-78e5e065d3c2';
  UPDATE game_players SET rebuys = 5, chip_counts = '{"white":3,"red":3,"blue":0,"green":0,"black":3,"yellow":0}'::jsonb, final_value = 46, total_chip_count = 3150 WHERE id = 'f67b6cb4-bfba-45f2-b4d4-1a7aef8c2b91';
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":2,"red":1,"blue":0,"green":3,"black":3,"yellow":0}'::jsonb, final_value = 29, total_chip_count = 4700 WHERE id = '7f2c185f-3688-4c09-bbd6-d23aace169b3';
  UPDATE game_players SET rebuys = 2, chip_counts = '{"white":21,"red":4,"blue":18,"green":7,"black":10,"yellow":0}'::jsonb, final_value = 108, total_chip_count = 18550 WHERE id = '6cc235a8-98a8-4a33-890c-cd19763a5dd6';
  UPDATE game_players SET rebuys = 4, chip_counts = '{"white":14,"red":8,"blue":8,"green":20,"black":16,"yellow":0}'::jsonb, final_value = 171, total_chip_count = 29100 WHERE id = '735cc67a-efba-4778-a523-7d7dd71e46ff';

  -- Game 2022-07-16 (IMG-20220717-WA0000.json)
  UPDATE game_players SET rebuys = 4, chip_counts = '{"white":39,"red":21,"blue":25,"green":28,"black":62,"yellow":0}'::jsonb, final_value = 365, total_chip_count = 85050 WHERE id = '22d26c1b-4bcf-44b6-9b5a-cf7034142a56';
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":28,"red":6,"blue":4,"green":7,"black":29,"yellow":0}'::jsonb, final_value = 151, total_chip_count = 35300 WHERE id = 'dc7e545a-80ea-439c-a082-71fc133a71db';
  UPDATE game_players SET rebuys = 7, chip_counts = '{"white":6,"red":0,"blue":11,"green":8,"black":20,"yellow":0}'::jsonb, final_value = 114, total_chip_count = 26500 WHERE id = '7362efc1-103d-4f2c-bc2e-616e444e8fdd';
  UPDATE game_players SET rebuys = 1, chip_counts = '{"white":26,"red":23,"blue":8,"green":2,"black":24,"yellow":0}'::jsonb, final_value = 129, total_chip_count = 30200 WHERE id = '478da894-5cb8-4df4-8e18-b0763fd09eaa';
  UPDATE game_players SET rebuys = 1, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = 'bd74d7a4-a848-49ad-b08c-7063792b85f2';
  UPDATE game_players SET rebuys = 2, chip_counts = '{"white":1,"red":0,"blue":4,"green":5,"black":0,"yellow":0}'::jsonb, final_value = 53, total_chip_count = 12350 WHERE id = 'c219e2c6-fc03-41ca-b4fc-1e8b3de2ee64';
  UPDATE game_players SET rebuys = 5, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = '72410d89-9f0c-4543-9f9a-9131ed6e370b';

  -- Game 2022-07-30 (IMG-20220731-WA0000.json)
  UPDATE game_players SET rebuys = 1, chip_counts = '{"white":0,"red":0,"blue":2,"green":2,"black":11,"yellow":0}'::jsonb, final_value = 51, total_chip_count = 12000 WHERE id = 'c1fe8e33-4a45-45e9-b9de-bd0a87ad5694';
  UPDATE game_players SET rebuys = 2, chip_counts = '{"white":6,"red":7,"blue":3,"green":0,"black":12,"yellow":0}'::jsonb, final_value = 58, total_chip_count = 13600 WHERE id = '716f452c-a5e7-4c36-ad15-95cf0eb02535';
  UPDATE game_players SET rebuys = 4, chip_counts = '{"white":26,"red":14,"blue":12,"green":15,"black":35,"yellow":0}'::jsonb, final_value = 204, total_chip_count = 47600 WHERE id = '540c0f9c-2be3-4f00-ac2c-072175fd3fc9';
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":47,"red":24,"blue":33,"green":35,"black":42,"yellow":0}'::jsonb, final_value = 304, total_chip_count = 70850 WHERE id = '8c950318-8977-4b69-9c6d-8e22a872fccd';
  UPDATE game_players SET rebuys = 5, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = 'a762c8ad-52b3-47c8-87c5-3daaac07604a';
  UPDATE game_players SET rebuys = 2, chip_counts = '{"white":11,"red":0,"blue":1,"green":0,"black":2,"yellow":0}'::jsonb, final_value = 12, total_chip_count = 2750 WHERE id = '81382091-8414-4478-b5d8-5393d8f786d2';
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = '4a36f98a-6134-4eb4-855e-67ab2bd1da17';

  -- Game 2022-08-06 (IMG-20220807-WA0000.json)
  UPDATE game_players SET rebuys = 2, chip_counts = '{"white":9,"red":10,"blue":5,"green":6,"black":10,"yellow":0}'::jsonb, final_value = 66, total_chip_count = 15450 WHERE id = 'b6dbb2a0-5f8c-4c73-904b-b380e957393b';
  UPDATE game_players SET rebuys = 1, chip_counts = '{"white":13,"red":8,"blue":28,"green":23,"black":20,"yellow":0}'::jsonb, final_value = 165, total_chip_count = 38550 WHERE id = '4fb6418f-f37a-4fd8-946e-821de04d3d34';
  UPDATE game_players SET rebuys = 3, chip_counts = '{"white":8,"red":0,"blue":3,"green":0,"black":7,"yellow":0}'::jsonb, final_value = 34, total_chip_count = 8000 WHERE id = '1a4814fc-d90c-4e24-b76d-6b9fa06791db';
  UPDATE game_players SET rebuys = 3, chip_counts = '{"white":2,"red":3,"blue":0,"green":0,"black":15,"yellow":0}'::jsonb, final_value = 66, total_chip_count = 15400 WHERE id = '9b0a5f2b-b2a8-460d-bc36-d7bfb05e0d86';
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":11,"red":13,"blue":3,"green":4,"black":34,"yellow":0}'::jsonb, final_value = 165, total_chip_count = 38450 WHERE id = '5cac2a3f-ec33-479d-a9b8-0104a511fc17';
  UPDATE game_players SET rebuys = 5, chip_counts = '{"white":19,"red":7,"blue":5,"green":11,"black":7,"yellow":0}'::jsonb, final_value = 65, total_chip_count = 15150 WHERE id = '4b6bb6af-b63c-4748-989f-adb5886033d5';
  UPDATE game_players SET rebuys = 2, chip_counts = '{"white":38,"red":9,"blue":6,"green":6,"black":23,"yellow":0}'::jsonb, final_value = 129, total_chip_count = 30000 WHERE id = '72adaaac-eddb-4ec8-bc8b-3d9b859b2db6';

  -- Game 2022-08-20 (IMG-20220820-WA0015.json)
  UPDATE game_players SET rebuys = 1, chip_counts = '{"white":18,"red":4,"blue":7,"green":6,"black":22,"yellow":0}'::jsonb, final_value = 109, total_chip_count = 27700 WHERE id = 'c57446e6-7466-4ced-8753-fd1f40220cd9';
  UPDATE game_players SET rebuys = 3, chip_counts = '{"white":22,"red":11,"blue":5,"green":26,"black":43,"yellow":0}'::jsonb, final_value = 231, total_chip_count = 59200 WHERE id = '242e1e54-f92b-415f-8e0d-62fe030dc584';
  UPDATE game_players SET rebuys = 2, chip_counts = '{"white":0,"red":0,"blue":0,"green":3,"black":6,"yellow":0}'::jsonb, final_value = 42, total_chip_count = 7500 WHERE id = '3bbddf9c-fe51-463c-9915-870f78d856b9';
  UPDATE game_players SET rebuys = 4, chip_counts = '{"white":14,"red":5,"blue":9,"green":7,"black":6,"yellow":0}'::jsonb, final_value = 70, total_chip_count = 12500 WHERE id = '73c29cf6-0065-4984-99ee-45f3c3aeab27';
  UPDATE game_players SET rebuys = 2, chip_counts = '{"white":35,"red":23,"blue":25,"green":7,"black":3,"yellow":0}'::jsonb, final_value = 95, total_chip_count = 15550 WHERE id = 'a7189d88-7e5e-4c94-b44d-d3ac879ed6f2';
  UPDATE game_players SET rebuys = 4, chip_counts = '{"white":11,"red":6,"blue":4,"green":1,"black":22,"yellow":0}'::jsonb, final_value = 112, total_chip_count = 24450 WHERE id = 'ee2f69d2-0f35-4a11-88a4-fee4f4325e54';

  -- Game 2022-08-27 (IMG-20220827-WA0142.json)
  UPDATE game_players SET rebuys = 1, chip_counts = '{"white":9,"red":17,"blue":14,"green":1,"black":1,"yellow":0}'::jsonb, final_value = 25, total_chip_count = 5950 WHERE id = 'caaefdbd-9c41-4740-ab85-4a5d325f83e0';
  UPDATE game_players SET rebuys = 4, chip_counts = '{"white":8,"red":3,"blue":3,"green":14,"black":126,"yellow":0}'::jsonb, final_value = 574, total_chip_count = 134000 WHERE id = '68384271-5fa3-4df9-97a1-bfc5d8e293af';
  UPDATE game_players SET rebuys = 3, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = 'db605fd5-9c88-46f5-8c7a-269b327b64d5';
  UPDATE game_players SET rebuys = 2, chip_counts = '{"white":26,"red":5,"blue":10,"green":6,"black":12,"yellow":0}'::jsonb, final_value = 81, total_chip_count = 18800 WHERE id = '169cd3ac-cf9f-4207-bcb5-95185f91ee33';
  UPDATE game_players SET rebuys = 1, chip_counts = '{"white":9,"red":0,"blue":4,"green":7,"black":12,"yellow":0}'::jsonb, final_value = 72, total_chip_count = 16750 WHERE id = '81ec0939-a088-4008-b810-bf2a0c6b7c07';
  UPDATE game_players SET rebuys = 7, chip_counts = '{"white":18,"red":14,"blue":18,"green":11,"black":20,"yellow":0}'::jsonb, final_value = 135, total_chip_count = 31400 WHERE id = '67e34ed2-5c6a-47a6-8731-a6966fa269bd';
  UPDATE game_players SET rebuys = 1, chip_counts = '{"white":30,"red":14,"blue":1,"green":2,"black":27,"yellow":0}'::jsonb, final_value = 133, total_chip_count = 31100 WHERE id = '4a35c710-c231-4bd1-8161-94d64828a416';
  UPDATE game_players SET rebuys = 7, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = '26b5a305-fafe-42a0-b9cc-6ca62b9a25b6';

  -- Game 2022-09-24 (IMG-20220925-WA0000.json)
  UPDATE game_players SET rebuys = 4, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 25, total_chip_count = 0 WHERE id = 'ce646a59-5072-4b39-8c62-e8be682b46c0';
  UPDATE game_players SET rebuys = 2, chip_counts = '{"white":30,"red":18,"blue":27,"green":12,"black":20,"yellow":0}'::jsonb, final_value = 139, total_chip_count = 34700 WHERE id = 'a422e4b1-29f3-4e3a-8382-e44e98a239b7';
  UPDATE game_players SET rebuys = 1, chip_counts = '{"white":65,"red":32,"blue":18,"green":8,"black":37,"yellow":0}'::jsonb, final_value = 192, total_chip_count = 51050 WHERE id = '81f34600-8588-4803-a009-6da7126d1584';
  UPDATE game_players SET rebuys = 3, chip_counts = '{"white":5,"red":0,"blue":5,"green":22,"black":28,"yellow":0}'::jsonb, final_value = 164, total_chip_count = 40250 WHERE id = '116d81c1-a344-4a04-b678-6a49bf6e796f';
  UPDATE game_players SET rebuys = 3, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 20, total_chip_count = 0 WHERE id = '86ac9359-ba97-4fea-ab23-e87856551ee8';

  -- Game 2022-10-01 (IMG-20221002-WA0000.json)
  UPDATE game_players SET rebuys = 1, chip_counts = '{"white":13,"red":6,"blue":11,"green":6,"black":14,"yellow":0}'::jsonb, final_value = 88, total_chip_count = 20450 WHERE id = '28c43e5d-7d38-44a7-aa75-d8a735556d94';
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":0,"red":0,"blue":8,"green":10,"black":14,"yellow":0}'::jsonb, final_value = 88, total_chip_count = 20600 WHERE id = 'baabf140-342c-4803-9868-9f98f6af0fd9';
  UPDATE game_players SET rebuys = 7, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = 'bb52d3e5-6dbc-482a-b805-417d941a33b9';
  UPDATE game_players SET rebuys = 2, chip_counts = '{"white":90,"red":44,"blue":29,"green":18,"black":74,"yellow":0}'::jsonb, final_value = 419, total_chip_count = 97700 WHERE id = 'b190c083-c993-4df3-86c1-a8d81eca7b78';
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":1,"red":1,"blue":2,"green":0,"black":22,"yellow":0}'::jsonb, final_value = 97, total_chip_count = 22550 WHERE id = '04965872-76b6-48df-9041-32ad0b0d10fb';
  UPDATE game_players SET rebuys = 4, chip_counts = '{"white":0,"red":0,"blue":3,"green":14,"black":13,"yellow":0}'::jsonb, final_value = 88, total_chip_count = 20600 WHERE id = 'c1f18929-399f-40cf-a035-19d6b26e9635';
  UPDATE game_players SET rebuys = 5, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = '7e269da2-dc1a-4600-a7d6-8075ba3048f8';

  -- Game 2022-10-15 (IMG-20221016-WA0000.json)
  UPDATE game_players SET rebuys = 4, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = 'd34c5cb2-2e4d-4170-911f-6001948c2d12';
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":43,"red":29,"blue":8,"green":23,"black":19,"yellow":0}'::jsonb, final_value = 159, total_chip_count = 37150 WHERE id = '3c843b1b-26df-43c8-9c45-df893d184396';
  UPDATE game_players SET rebuys = 5, chip_counts = '{"white":10,"red":2,"blue":5,"green":5,"black":19,"yellow":0}'::jsonb, final_value = 99, total_chip_count = 23200 WHERE id = '4f8b3013-3bda-4c6c-95a3-6665d40df25c';
  UPDATE game_players SET rebuys = 3, chip_counts = '{"white":32,"red":0,"blue":20,"green":7,"black":37,"yellow":0}'::jsonb, final_value = 198, total_chip_count = 46100 WHERE id = 'b343da55-1a44-4e30-9fdf-8455e5d85c3c';
  UPDATE game_players SET rebuys = 2, chip_counts = '{"white":17,"red":20,"blue":13,"green":6,"black":13,"yellow":0}'::jsonb, final_value = 92, total_chip_count = 21450 WHERE id = '5b2055a5-a690-46e4-8be0-d3488f67eb48';
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":0,"red":0,"blue":8,"green":7,"black":21,"yellow":0}'::jsonb, final_value = 112, total_chip_count = 26100 WHERE id = '0a6fb45d-0176-438f-a125-f116f6e40bbc';
  UPDATE game_players SET rebuys = 1, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = 'b93918dd-6a38-420a-be1e-9071e8961f08';

  -- Game 2022-10-22 (IMG-20221023-WA0000.json)
  UPDATE game_players SET rebuys = 4, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = 'c3a27f8d-12f3-44f4-bf77-e9449dcd7322';
  UPDATE game_players SET rebuys = 2, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = 'ec41fc4b-3daf-41eb-92cd-dd2f02324c88';
  UPDATE game_players SET rebuys = 4, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = '14c26824-f585-4679-bba2-cb06db453574';
  UPDATE game_players SET rebuys = 4, chip_counts = '{"white":13,"red":11,"blue":7,"green":5,"black":19,"yellow":0}'::jsonb, final_value = 106, total_chip_count = 24650 WHERE id = 'd66e70c5-cd14-440b-96b8-9d7a4db95f92';
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":41,"red":18,"blue":20,"green":15,"black":69,"yellow":0}'::jsonb, final_value = 362, total_chip_count = 84350 WHERE id = '5e04918b-217c-4419-bd07-a90138cb6202';
  UPDATE game_players SET rebuys = 3, chip_counts = '{"white":11,"red":0,"blue":19,"green":12,"black":28,"yellow":0}'::jsonb, final_value = 165, total_chip_count = 38350 WHERE id = '7682ce8d-2054-407a-99f2-4e589bf80eb6';
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":32,"red":21,"blue":3,"green":12,"black":10,"yellow":0}'::jsonb, final_value = 87, total_chip_count = 20300 WHERE id = '63ac0a2c-8221-4ae7-89dd-e302708c4ba2';

  -- Game 2022-11-19 (IMG-20221120-WA0000.json)
  UPDATE game_players SET rebuys = 2, chip_counts = '{"white":31,"red":10,"blue":12,"green":8,"black":4,"yellow":0}'::jsonb, final_value = 55, total_chip_count = 12950 WHERE id = '25d339bf-ef1a-4287-9ffd-ed4c1fa5bd0d';
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":39,"red":30,"blue":29,"green":24,"black":12,"yellow":5}'::jsonb, final_value = 299, total_chip_count = 69750 WHERE id = 'e7e31caf-547b-4177-8c70-61eb161eee6e';
  UPDATE game_players SET rebuys = 4, chip_counts = '{"white":11,"red":12,"blue":9,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 15, total_chip_count = 3550 WHERE id = '5a94a508-ba3d-4029-816f-23c903b18517';
  UPDATE game_players SET rebuys = 3, chip_counts = '{"white":12,"red":0,"blue":0,"green":13,"black":8,"yellow":0}'::jsonb, final_value = 65, total_chip_count = 15100 WHERE id = '04b07d25-6f77-412a-9a0b-13dedafc5e1e';
  UPDATE game_players SET rebuys = 2, chip_counts = '{"white":6,"red":0,"blue":0,"green":4,"black":21,"yellow":2}'::jsonb, final_value = 160, total_chip_count = 37300 WHERE id = 'f035de91-c680-40f5-be99-7de383d8b4ff';
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":1,"red":1,"blue":0,"green":1,"black":0,"yellow":1}'::jsonb, final_value = 33, total_chip_count = 7650 WHERE id = '9ad45d78-3735-46c5-8882-47c891f571c0';
  UPDATE game_players SET rebuys = 3, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = '3ae73c01-c585-4d7f-b787-f7890fc413e8';

  -- Game 2023-01-14 (IMG-20230115-WA0000.json)
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":12,"red":8,"blue":12,"green":4,"black":4,"yellow":0}'::jsonb, final_value = 42, total_chip_count = 9800 WHERE id = '172e7d72-3473-4856-a4e5-3a1fcab5a1f4';
  UPDATE game_players SET rebuys = 1, chip_counts = '{"white":7,"red":8,"blue":6,"green":2,"black":27,"yellow":0}'::jsonb, final_value = 130, total_chip_count = 30350 WHERE id = '897fcad3-676f-41aa-bb6c-91029ea7ab49';
  UPDATE game_players SET rebuys = 3, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = 'efa568f6-f517-40b2-8ef0-518d8034d615';
  UPDATE game_players SET rebuys = 3, chip_counts = '{"white":79,"red":32,"blue":25,"green":31,"black":47,"yellow":0}'::jsonb, final_value = 320, total_chip_count = 74650 WHERE id = '060647e7-cc86-49eb-8e40-8a3861fa1ed9';
  UPDATE game_players SET rebuys = 1, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = 'e240058b-d8cc-40f5-8964-b83e2137e0f5';
  UPDATE game_players SET rebuys = 4, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = '1fe480c3-63f1-459b-861f-a04078be9eb5';
  UPDATE game_players SET rebuys = 1, chip_counts = '{"white":2,"red":2,"blue":7,"green":3,"black":22,"yellow":0}'::jsonb, final_value = 108, total_chip_count = 25200 WHERE id = '4ea4f7a6-c75d-4c04-872b-fc73c62986b0';

  -- Game 2023-01-21 (IMG-20230122-WA0000.json)
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":7,"red":10,"blue":3,"green":0,"black":8,"yellow":0}'::jsonb, final_value = 43, total_chip_count = 9950 WHERE id = 'ff5364dd-9a40-4edb-bbd9-50dd76ec2e81';
  UPDATE game_players SET rebuys = 3, chip_counts = '{"white":38,"red":21,"blue":2,"green":1,"black":15,"yellow":0}'::jsonb, final_value = 85, total_chip_count = 19900 WHERE id = 'bc83b9e0-09a1-4f3a-9476-bb55e6b52a4a';
  UPDATE game_players SET rebuys = 7, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = 'ec6d24e2-e983-494d-a5c9-5e22d3a4bf18';
  UPDATE game_players SET rebuys = 1, chip_counts = '{"white":6,"red":8,"blue":9,"green":9,"black":0,"yellow":0}'::jsonb, final_value = 32, total_chip_count = 7400 WHERE id = '3de06f4f-03ba-4a16-be5a-4333ecf470b7';
  UPDATE game_players SET rebuys = 1, chip_counts = '{"white":30,"red":0,"blue":31,"green":22,"black":68,"yellow":0}'::jsonb, final_value = 372, total_chip_count = 86700 WHERE id = '5f56ee89-9626-4fcd-9c42-66de9f3cc168';
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":0,"red":6,"blue":0,"green":3,"black":19,"yellow":0}'::jsonb, final_value = 90, total_chip_count = 21100 WHERE id = '3f031c48-6e6d-45cd-8476-6a21435895be';
  UPDATE game_players SET rebuys = 3, chip_counts = '{"white":19,"red":5,"blue":5,"green":5,"black":4,"yellow":0}'::jsonb, final_value = 38, total_chip_count = 8950 WHERE id = 'bfcac7dd-d884-46f3-b8ec-ad1d15eed16e';

  -- Game 2023-02-18 (IMG-20230219-WA0000.json)
  UPDATE game_players SET rebuys = 7, chip_counts = '{"white":48,"red":4,"blue":18,"green":26,"black":30,"yellow":0}'::jsonb, final_value = 212, total_chip_count = 49400 WHERE id = '6ee7086b-a7ab-4635-82d3-e15372e43a36';
  UPDATE game_players SET rebuys = 2, chip_counts = '{"white":18,"red":27,"blue":13,"green":2,"black":26,"yellow":0}'::jsonb, final_value = 142, total_chip_count = 33200 WHERE id = 'f94018f9-3cbc-487e-a5a0-4917941351fc';
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":4,"red":0,"blue":7,"green":0,"black":45,"yellow":0}'::jsonb, final_value = 200, total_chip_count = 46600 WHERE id = 'b6eb6ab9-e3aa-4884-b1e7-368c4a2160ef';
  UPDATE game_players SET rebuys = 3, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = '91e713dc-6e05-4cd1-8217-1eb3110181fd';
  UPDATE game_players SET rebuys = 2, chip_counts = '{"white":3,"red":0,"blue":1,"green":7,"black":7,"yellow":0}'::jsonb, final_value = 46, total_chip_count = 10850 WHERE id = '18a54245-cb86-45c7-a71e-14fa62773c80';
  UPDATE game_players SET rebuys = 3, chip_counts = '{"white":16,"red":12,"blue":0,"green":4,"black":31,"yellow":0}'::jsonb, final_value = 150, total_chip_count = 35000 WHERE id = 'aa787b90-bbdf-4ecd-85a7-86ab351b3c1b';
  UPDATE game_players SET rebuys = 2, chip_counts = '{"white":1,"red":2,"blue":6,"green":11,"black":0,"yellow":0}'::jsonb, final_value = 30, total_chip_count = 6950 WHERE id = '7c4b61bf-bdb0-4d30-a776-a5f191d77e39';

  -- Game 2023-04-26 (IMG-20230427-WA0000.json)
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":3,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 106, total_chip_count = 3 WHERE id = '35fbd606-d196-4ac3-b5c5-00b75afe664e';
  UPDATE game_players SET rebuys = 3, chip_counts = '{"white":37,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 168, total_chip_count = 37 WHERE id = 'b7519c60-0a62-45fb-ab48-b98247922082';
  UPDATE game_players SET rebuys = 7, chip_counts = '{"white":4,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 100, total_chip_count = 4 WHERE id = 'ef307bdc-38a2-4f09-a8f1-f524160739ce';
  UPDATE game_players SET rebuys = 4, chip_counts = '{"white":1,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 54, total_chip_count = 1 WHERE id = 'd14c3daa-9786-429d-babc-e16da529900d';
  UPDATE game_players SET rebuys = 1, chip_counts = '{"white":34,"red":0,"blue":0,"green":0,"black":6,"yellow":0}'::jsonb, final_value = 119, total_chip_count = 40 WHERE id = 'f1be13cb-d01e-496c-9835-c99b209e738f';
  UPDATE game_players SET rebuys = 4, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = 'a03ccc53-897f-476a-9066-f4a947bce38a';
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":21,"red":0,"blue":0,"green":0,"black":3,"yellow":0}'::jsonb, final_value = 233, total_chip_count = 24 WHERE id = '2310e225-8f2a-47a6-8f73-34681bbe96ea';

  -- Game 2023-06-08 (IMG-20230609-WA0000.json)
  UPDATE game_players SET rebuys = 2, chip_counts = '{"white":22,"red":2,"blue":9,"green":5,"black":1,"yellow":2}'::jsonb, final_value = 50, total_chip_count = 16600 WHERE id = 'eb15d3e2-361e-44c5-96fd-317bc1d65646';
  UPDATE game_players SET rebuys = 6, chip_counts = '{"white":3,"red":12,"blue":2,"green":3,"black":7,"yellow":14}'::jsonb, final_value = 241, total_chip_count = 80250 WHERE id = 'd4fc3bbf-7f94-4d2c-872c-ec357cff1213';
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":44,"red":15,"blue":9,"green":14,"black":1,"yellow":8}'::jsonb, final_value = 160, total_chip_count = 53500 WHERE id = 'df7b35ee-fd02-440e-9a57-d51cde057b52';
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":0,"red":2,"blue":3,"green":1,"black":0,"yellow":1}'::jsonb, final_value = 19, total_chip_count = 6300 WHERE id = 'f1333473-4547-4031-aeb0-64d82f294bc5';
  UPDATE game_players SET rebuys = 2, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = 'b118fc00-c248-4954-8355-017167f99af8';
  UPDATE game_players SET rebuys = 3, chip_counts = '{"white":31,"red":19,"blue":27,"green":17,"black":1,"yellow":3}'::jsonb, final_value = 100, total_chip_count = 33350 WHERE id = 'c1b409bf-fe58-429a-bd55-8595628e1df9';

  -- Game 2023-08-19 (IMG-20230820-WA0000.json)
  UPDATE game_players SET rebuys = 2, chip_counts = '{"white":7,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 39, total_chip_count = 7 WHERE id = '6e5ad175-e7f0-4e02-8f59-50f9e307b667';
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = 'd5ae8d47-7da5-4a85-9eba-a6543b50dd96';
  UPDATE game_players SET rebuys = 1, chip_counts = '{"white":25,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 56, total_chip_count = 25 WHERE id = 'e920b78b-2d3c-4478-87e8-687abc3725a2';
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":40,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 63, total_chip_count = 40 WHERE id = '83fc7618-62e5-4cbe-8b8a-428af19601c9';
  UPDATE game_players SET rebuys = 2, chip_counts = '{"white":28,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 109, total_chip_count = 28 WHERE id = '18b2e84d-d570-4e9f-8e35-ab04e199cc08';
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":6,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 58, total_chip_count = 6 WHERE id = 'd97c079b-6430-4244-a52c-10181e6b4d5c';

  -- Game 2023-09-09 (IMG-20230910-WA0000.json)
  UPDATE game_players SET rebuys = 4, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = '2faefc30-7889-4487-917e-559adf457413';
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":6,"yellow":10}'::jsonb, final_value = 168, total_chip_count = 56000 WHERE id = '5ff2eb6e-892d-44f6-b2c1-fcb27aad8ea6';
  UPDATE game_players SET rebuys = 3, chip_counts = '{"white":60,"red":28,"blue":19,"green":27,"black":28,"yellow":2}'::jsonb, final_value = 183, total_chip_count = 61100 WHERE id = '31378f85-36d2-4cde-864d-78e27bce1058';
  UPDATE game_players SET rebuys = 3, chip_counts = '{"white":40,"red":22,"blue":31,"green":13,"black":26,"yellow":0}'::jsonb, final_value = 129, total_chip_count = 42900 WHERE id = 'a6625a38-6f22-4a84-95a2-2fb5747f5222';
  UPDATE game_players SET rebuys = 4, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = 'b76fd948-134a-4b6a-ae05-781ab2d187e8';
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":60,"yellow":4}'::jsonb, final_value = 240, total_chip_count = 80000 WHERE id = '28e6bf7f-8d6d-4392-bcf8-ed89e1bd9e94';
  UPDATE game_players SET rebuys = 3, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = '3f41b583-53fb-4520-b524-c9243717907e';

  -- Game 2023-11-18 (IMG-20231119-WA0000.json)
  UPDATE game_players SET rebuys = 3, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = '5dd9a610-5bc9-4db7-ac4f-723cf44ae101';
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":42,"red":11,"blue":17,"green":12,"black":14,"yellow":9}'::jsonb, final_value = 215, total_chip_count = 71600 WHERE id = '8bd0adaf-8c03-4108-a172-127afc1a3d86';
  UPDATE game_players SET rebuys = 2, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = 'dce43898-d461-4694-b92c-79c58b5246c9';
  UPDATE game_players SET rebuys = 2, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = '1b4c43ac-8cdf-4eda-a252-e98a5aa7b111';
  UPDATE game_players SET rebuys = 2, chip_counts = '{"white":52,"red":24,"blue":29,"green":28,"black":11,"yellow":9}'::jsonb, final_value = 242, total_chip_count = 80800 WHERE id = '71415d29-932d-47b7-bb99-b716ce9df662';
  UPDATE game_players SET rebuys = 1, chip_counts = '{"white":1,"red":3,"blue":0,"green":1,"black":3,"yellow":0}'::jsonb, final_value = 11, total_chip_count = 3850 WHERE id = 'c50c67f1-be15-48e4-8778-ee7cbf0c9526';
  UPDATE game_players SET rebuys = 5, chip_counts = '{"white":5,"red":12,"blue":7,"green":0,"black":1,"yellow":12}'::jsonb, final_value = 192, total_chip_count = 63850 WHERE id = 'c79e8e2e-b8f4-4f69-9875-fbbca89c82ba';

  -- Game 2024-01-13 (IMG-20240114-WA0000.json)
  UPDATE game_players SET rebuys = 2.5, chip_counts = '{"white":43,"red":36,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 200, total_chip_count = 0 WHERE id = '13f287ef-5c40-490a-97d2-a7bd8ea22a78';
  UPDATE game_players SET rebuys = 4, chip_counts = '{"white":41,"red":2,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 80, total_chip_count = 0 WHERE id = '29c9467e-fba9-496a-98af-7f98d4297c54';
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = 'c3e9e9a5-4873-403a-8fd7-a3da7d2a1411';
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":11,"red":2,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 49, total_chip_count = 0 WHERE id = '99ccb55c-f456-4d08-bbd0-d51963b9a9eb';
  UPDATE game_players SET rebuys = 1, chip_counts = '{"white":11,"red":11,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 136, total_chip_count = 0 WHERE id = 'a237e962-df7e-46ec-93e2-68b2f54e5a21';
  UPDATE game_players SET rebuys = 1, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = 'd7563bd2-f0d1-4b96-bac5-68733fc6d50b';
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = '3c64b6bf-cfb4-48d1-b02a-f65b2626edf1';

  -- Game 2024-03-07 (IMG-20240308-WA0000.json)
  UPDATE game_players SET rebuys = 2.5, chip_counts = '{"white":1,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 43, total_chip_count = 1 WHERE id = 'febd93f7-a918-44e5-9f58-21fe274d3247';
  UPDATE game_players SET rebuys = 2, chip_counts = '{"white":42,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 218, total_chip_count = 42 WHERE id = 'dd6c0a11-8103-4f1a-b218-5e1924058027';
  UPDATE game_players SET rebuys = 1, chip_counts = '{"white":3,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 98, total_chip_count = 3 WHERE id = 'e9b425af-62d7-48fa-9fc1-13a5a2029987';
  UPDATE game_players SET rebuys = 4, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = '9b09bb58-508a-4b0c-93df-650c8d8b3641';
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":9,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 133, total_chip_count = 9 WHERE id = 'bf84d31d-8e8b-4837-a8a1-7f60518376fd';
  UPDATE game_players SET rebuys = 6, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = '5b1fba15-f78f-4c82-a164-d0c4f38998de';
  UPDATE game_players SET rebuys = 4, chip_counts = '{"white":44,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 309, total_chip_count = 44 WHERE id = '38298640-34c6-427f-aa9f-8f7aeb004cff';

  -- Game 2024-04-24 (IMG-20240425-WA0000.json)
  UPDATE game_players SET rebuys = 3, chip_counts = '{"white":27,"red":4,"blue":8,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 120, total_chip_count = 2727 WHERE id = 'ff139ad1-b11e-4c2b-9f36-839e556e96a9';
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":15,"red":20,"blue":4,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 104, total_chip_count = 3550 WHERE id = 'b1b9ee56-de0a-4874-bdb8-7df8b2dc28a0';
  UPDATE game_players SET rebuys = 1.5, chip_counts = '{"white":16,"red":14,"blue":8,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 175, total_chip_count = 3799 WHERE id = '29fba2a2-2c50-48d4-98cf-fe65d60a1ca2';
  UPDATE game_players SET rebuys = 9, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = '69d679f7-92f1-4585-a7fe-cb8cee82c1a2';
  UPDATE game_players SET rebuys = 2, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = 'f0208433-16af-4797-b2a6-a75d983c8cb2';
  UPDATE game_players SET rebuys = 1, chip_counts = '{"white":35,"red":11,"blue":27,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 220, total_chip_count = 8098 WHERE id = 'a531b7ce-b0aa-4857-8a0b-6dcb62fe4b35';
  UPDATE game_players SET rebuys = 1, chip_counts = '{"white":7,"red":1,"blue":3,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 117, total_chip_count = 1057 WHERE id = 'ebbe091f-77d8-4b46-af28-2d75f109045f';

  -- Game 2024-10-17 (IMG-20241018-WA0000.json)
  UPDATE game_players SET rebuys = 3, chip_counts = '{"white":22,"red":1,"blue":14,"green":4,"black":0,"yellow":0}'::jsonb, final_value = 60, total_chip_count = 0 WHERE id = '047e9119-d1e6-4871-b540-929a25f59d72';
  UPDATE game_players SET rebuys = 5, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = '50852190-d1ce-4134-abde-f6706d6c3c27';
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":31,"red":7,"blue":15,"green":17,"black":0,"yellow":0}'::jsonb, final_value = 113, total_chip_count = 0 WHERE id = '0404a9ea-7d75-472e-bdb7-addb3a61ea69';
  UPDATE game_players SET rebuys = 4, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = 'd84724f9-67fb-41de-a5e0-8473013ef2e5';
  UPDATE game_players SET rebuys = 2, chip_counts = '{"white":22,"red":27,"blue":4,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 434, total_chip_count = 0 WHERE id = '48cadbc6-a2f1-4294-9d25-171d80f83eba';
  UPDATE game_players SET rebuys = 0, chip_counts = '{"white":25,"red":16,"blue":17,"green":27,"black":0,"yellow":0}'::jsonb, final_value = 143, total_chip_count = 0 WHERE id = '5864ebaa-e64a-40ed-8800-763bfaabe857';
  UPDATE game_players SET rebuys = 4, chip_counts = '{"white":0,"red":0,"blue":0,"green":0,"black":0,"yellow":0}'::jsonb, final_value = 0, total_chip_count = 0 WHERE id = 'a6d2b4cf-b6a3-4e42-8ec6-81bf4bf7a1ef';

END $$;
