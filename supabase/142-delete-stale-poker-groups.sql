-- Migration 142: Delete stale test groups
--
-- Deletes the 3 specific groups requested by the user:
-- 1. "פוקר" (c1f3628d-55da-47ab-bedc-241ba31fc6bb) - created by Yuval (יובל זובה לוי) on 2026-10-21 (0 games, 1 player)
-- 2. "פוקר אצל מלמן 30.7" (9639e705-86f1-45d5-9444-5f853bd41bde) - created by Sagi Melman on 2026-07-30 (1 game, 5 players)
-- 3. "פוקר אצל רטיק" (af9e3df6-0d0d-435d-9d3c-cd42af2ddb1e) - created by Sagi Melman on 2026-07-22 (1 game, 6 players)
--
-- Preserves all active groups:
-- - "Poker Night" (d1998bed-7bae-4221-8877-20c537acfc43)
-- - "פוקר חמישי או שבת" (4a14e170-7c35-48bb-9723-2c61aa279918)
-- - "ניסיון" (add6732b-17ef-4b94-87a5-a17385e68e30)

DO $$
BEGIN
  -- Enable cascade delete flag to bypass bulk delete & completed game guards
  PERFORM set_config('app.cascade_group_delete', '1', true);

  -- Delete game_players for games in these groups
  DELETE FROM game_players
  WHERE game_id IN (
    SELECT id FROM games
    WHERE group_id IN (
      'c1f3628d-55da-47ab-bedc-241ba31fc6bb',
      '9639e705-86f1-45d5-9444-5f853bd41bde',
      'af9e3df6-0d0d-435d-9d3c-cd42af2ddb1e'
    )
  );

  -- Delete games in these groups
  DELETE FROM games
  WHERE group_id IN (
    'c1f3628d-55da-47ab-bedc-241ba31fc6bb',
    '9639e705-86f1-45d5-9444-5f853bd41bde',
    'af9e3df6-0d0d-435d-9d3c-cd42af2ddb1e'
  );

  -- Delete players in these groups
  DELETE FROM players
  WHERE group_id IN (
    'c1f3628d-55da-47ab-bedc-241ba31fc6bb',
    '9639e705-86f1-45d5-9444-5f853bd41bde',
    'af9e3df6-0d0d-435d-9d3c-cd42af2ddb1e'
  );

  -- Delete the groups themselves (foreign keys cascade all other group-scoped records)
  DELETE FROM groups
  WHERE id IN (
    'c1f3628d-55da-47ab-bedc-241ba31fc6bb',
    '9639e705-86f1-45d5-9444-5f853bd41bde',
    'af9e3df6-0d0d-435d-9d3c-cd42af2ddb1e'
  );
END $$;
