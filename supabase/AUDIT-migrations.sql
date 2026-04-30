-- ============================================================
-- Migration audit (read-only) — paste into Supabase SQL Editor
-- and run. Modifies NOTHING. Returns one row per migration with
-- a PASS/MISSING/INDIRECT verdict so you can spot any migration
-- that wasn't applied.
--
-- How it works:
--   * Each migration introduces a distinctive artifact (a table,
--     column, function, index, trigger, or publication entry).
--     We check `information_schema` / `pg_catalog` for that
--     artifact's existence — no source-code parsing, no writes.
--   * Some migrations only MODIFY an existing function/trigger
--     and don't add a new artifact (e.g. 020/026/031/034/035/036/037/038
--     all rewrite functions that an earlier migration already
--     created). For those we either probe the function body for
--     a unique marker string OR mark the row as
--     `INDIRECT — verified by a later migration's check`.
--
-- Reading the result:
--   * ✅ PASS     — artifact is present, migration applied.
--   * ❌ MISSING  — artifact is absent, migration was skipped or
--                   failed. RUN THE CORRESPONDING `.sql` FILE.
--   * 🟡 INDIRECT — migration only modifies an existing function
--                   so we can't directly detect application; the
--                   later migration that re-modifies the same
--                   function (one row down) carries the canonical
--                   shape, so a PASS there means this one is
--                   effectively in place.
--
-- Shape of the output:
--   #  | migration                | artifact                | status     | notes
-- ============================================================

WITH probe AS (
  -- ── 001 ────────────────────────────────────────────────────
  SELECT 1 AS ord, '001-schema.sql' AS migration,
         'public.players, games, groups, settings tables' AS artifact,
         (SELECT count(*) FROM information_schema.tables
            WHERE table_schema='public' AND table_name IN ('players','games','groups','settings'))
         = 4 AS present,
         ''::text AS notes
  -- ── 002 ────────────────────────────────────────────────────
  UNION ALL SELECT 2, '002-auth-support.sql',
         'groups.invite_code column',
         EXISTS(SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='groups' AND column_name='invite_code'),
         ''
  -- ── 003 ────────────────────────────────────────────────────
  UNION ALL SELECT 3, '003-realtime.sql',
         'players in supabase_realtime publication',
         EXISTS(SELECT 1 FROM pg_publication_tables
                  WHERE pubname='supabase_realtime' AND tablename='players'),
         ''
  -- ── 004 ────────────────────────────────────────────────────
  UNION ALL SELECT 4, '004-group-management.sql',
         'public.player_invites table',
         EXISTS(SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='player_invites'),
         ''
  -- ── 005 ────────────────────────────────────────────────────
  UNION ALL SELECT 5, '005-security-hardening.sql',
         'gm_self_join policy on group_members',
         EXISTS(SELECT 1 FROM pg_policies
                  WHERE schemaname='public' AND tablename='group_members' AND policyname='gm_self_join'),
         ''
  -- ── 006 ────────────────────────────────────────────────────
  UNION ALL SELECT 6, '006-supabase-improvements.sql',
         'public.backups table + cleanup_old_activity fn',
         EXISTS(SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='backups')
         AND EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
                  WHERE n.nspname='public' AND p.proname='cleanup_old_activity'),
         ''
  -- ── 007 ────────────────────────────────────────────────────
  UNION ALL SELECT 7, '007-permissions-overhaul.sql',
         'public.super_admins table + groups.training_enabled',
         EXISTS(SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='super_admins')
         AND EXISTS(SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='groups' AND column_name='training_enabled'),
         ''
  -- ── 008-multi-group ────────────────────────────────────────
  UNION ALL SELECT 8, '008-multi-group.sql',
         'self_create_and_link fn (multi-group signature)',
         EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
                  WHERE n.nspname='public' AND p.proname='self_create_and_link'),
         ''
  -- ── 008-realtime-and-zero-sum ──────────────────────────────
  UNION ALL SELECT 9, '008-realtime-and-zero-sum.sql',
         'check_game_players_zero_sum trigger fn',
         EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
                  WHERE n.nspname='public' AND p.proname='check_game_players_zero_sum'),
         'Note: filename overlaps 008-multi-group; both files exist'
  -- ── 009 ────────────────────────────────────────────────────
  UNION ALL SELECT 10, '009-settlement-notifications.sql',
         'public.notifications table + paid_settlements.auto_closed',
         EXISTS(SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='notifications')
         AND EXISTS(SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='paid_settlements' AND column_name='auto_closed'),
         ''
  -- ── 010 ────────────────────────────────────────────────────
  UNION ALL SELECT 11, '010-api-key-security.sql',
         'get_group_settings fn',
         EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
                  WHERE n.nspname='public' AND p.proname='get_group_settings'),
         ''
  -- ── 011 ────────────────────────────────────────────────────
  UNION ALL SELECT 12, '011-push-notifications.sql',
         'public.push_subscriptions table',
         EXISTS(SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='push_subscriptions'),
         ''
  -- ── 012 ────────────────────────────────────────────────────
  UNION ALL SELECT 13, '012-push-subs-update-policy.sql',
         'UPDATE policy on push_subscriptions',
         EXISTS(SELECT 1 FROM pg_policies
                  WHERE schemaname='public' AND tablename='push_subscriptions' AND cmd='UPDATE'),
         ''
  -- ── 013 ────────────────────────────────────────────────────
  UNION ALL SELECT 14, '013-members-visibility.sql',
         'fetch_group_members_with_email fn',
         EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
                  WHERE n.nspname='public' AND p.proname='fetch_group_members_with_email'),
         '🟡 Recreated by 008/013 — pass means "function exists at all"; cannot distinguish 013-specific body'
  -- ── 014 ────────────────────────────────────────────────────
  UNION ALL SELECT 15, '014-delete-leave-group.sql',
         'delete_group + leave_group fns',
         EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
                  WHERE n.nspname='public' AND p.proname='delete_group')
         AND EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
                  WHERE n.nspname='public' AND p.proname='leave_group'),
         ''
  -- ── 015 ────────────────────────────────────────────────────
  UNION ALL SELECT 16, '015-training-realtime.sql',
         'training_pool in supabase_realtime publication',
         EXISTS(SELECT 1 FROM pg_publication_tables
                  WHERE pubname='supabase_realtime' AND tablename='training_pool'),
         ''
  -- ── 016 ────────────────────────────────────────────────────
  UNION ALL SELECT 17, '016-group-member-counts.sql',
         'get_group_member_counts fn',
         EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
                  WHERE n.nspname='public' AND p.proname='get_group_member_counts'),
         ''
  -- ── 017 ────────────────────────────────────────────────────
  UNION ALL SELECT 18, '017-global-stats-player-count.sql',
         'get_global_stats fn (any version)',
         EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
                  WHERE n.nspname='public' AND p.proname='get_global_stats'),
         '🟡 Superseded by 018 — pass means "function exists"; the 018-specific body is checked below'
  -- ── 018 ────────────────────────────────────────────────────
  UNION ALL SELECT 19, '018-global-stats-activity.sql',
         'get_global_stats body returns activity_count',
         EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
                  WHERE n.nspname='public' AND p.proname='get_global_stats'
                    AND pg_get_functiondef(p.oid) ILIKE '%activity_count%'),
         ''
  -- ── 019 ────────────────────────────────────────────────────
  UNION ALL SELECT 20, '019-issue-reports.sql',
         'public.issue_reports table',
         EXISTS(SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='issue_reports'),
         ''
  -- ── 020 ────────────────────────────────────────────────────
  UNION ALL SELECT 21, '020-fix-zero-sum-trigger.sql',
         'check_game_zero_sum fn (modifies existing)',
         EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
                  WHERE n.nspname='public' AND p.proname='check_game_zero_sum'),
         '🟡 Modifies existing fn from 006; later re-modified by 035. PASS here just confirms fn exists'
  -- ── 021 ────────────────────────────────────────────────────
  UNION ALL SELECT 22, '021-super-admin-email.sql',
         'get_super_admin_emails fn',
         EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
                  WHERE n.nspname='public' AND p.proname='get_super_admin_emails'),
         ''
  -- ── 022 ────────────────────────────────────────────────────
  UNION ALL SELECT 23, '022-game-scheduling.sql',
         'game_polls + game_poll_dates + game_poll_votes tables',
         (SELECT count(*) FROM information_schema.tables
            WHERE table_schema='public'
              AND table_name IN ('game_polls','game_poll_dates','game_poll_votes')) = 3,
         ''
  -- ── 023 ────────────────────────────────────────────────────
  UNION ALL SELECT 24, '023-schedule-config.sql',
         'settings.schedule_emails_enabled column',
         EXISTS(SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='settings'
                    AND column_name='schedule_emails_enabled'),
         ''
  -- ── 024 ────────────────────────────────────────────────────
  UNION ALL SELECT 25, '024-schedule-roles.sql',
         'is_schedule_admin fn',
         EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
                  WHERE n.nspname='public' AND p.proname='is_schedule_admin'),
         ''
  -- ── 025 ────────────────────────────────────────────────────
  UNION ALL SELECT 26, '025-schedule-proxy-votes.sql',
         'game_poll_votes.cast_by_user_id + admin_cast_poll_vote fn',
         EXISTS(SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='game_poll_votes'
                    AND column_name='cast_by_user_id')
         AND EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
                  WHERE n.nspname='public' AND p.proname='admin_cast_poll_vote'),
         ''
  -- ── 026 ────────────────────────────────────────────────────
  UNION ALL SELECT 27, '026-schedule-flexible-date-count.sql',
         'create_game_poll fn (modifies existing)',
         EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
                  WHERE n.nspname='public' AND p.proname='create_game_poll'),
         '🟡 Re-created by later migrations too; PASS just confirms fn exists'
  -- ── 027 ────────────────────────────────────────────────────
  UNION ALL SELECT 28, '027-schedule-delete-poll.sql',
         'delete_game_poll fn',
         EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
                  WHERE n.nspname='public' AND p.proname='delete_game_poll'),
         ''
  -- ── 028 ────────────────────────────────────────────────────
  UNION ALL SELECT 29, '028-schedule-edit-poll.sql',
         'update_game_poll_meta fn',
         EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
                  WHERE n.nspname='public' AND p.proname='update_game_poll_meta'),
         ''
  -- ── 029 ────────────────────────────────────────────────────
  UNION ALL SELECT 30, '029-schedule-vote-history.sql',
         'game_poll_votes.created_at column',
         EXISTS(SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='game_poll_votes'
                    AND column_name='created_at'),
         ''
  -- ── 030 ────────────────────────────────────────────────────
  UNION ALL SELECT 31, '030-schedule-vote-change-notifications.sql',
         'game_poll_change_subscribers table + subscribe_to_poll_changes fn',
         EXISTS(SELECT 1 FROM information_schema.tables
                  WHERE table_schema='public' AND table_name='game_poll_change_subscribers')
         AND EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
                  WHERE n.nspname='public' AND p.proname='subscribe_to_poll_changes'),
         ''
  -- ── 031 ────────────────────────────────────────────────────
  UNION ALL SELECT 32, '031-schedule-allow-confirmed-vote-changes.sql',
         'cast_poll_vote body allows status=''confirmed''',
         EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
                  WHERE n.nspname='public' AND p.proname='cast_poll_vote'
                    AND pg_get_functiondef(p.oid) ILIKE '%''open'', ''expanded'', ''confirmed''%'),
         '🟡 Function-body probe — looks for the widened status whitelist'
  -- ── 032 ────────────────────────────────────────────────────
  UNION ALL SELECT 33, '032-schedule-admin-vote-change-optout.sql',
         'group_members.schedule_vote_change_notifs column',
         EXISTS(SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='group_members'
                    AND column_name='schedule_vote_change_notifs'),
         ''
  -- ── 033 ────────────────────────────────────────────────────
  UNION ALL SELECT 34, '033-game-comics.sql',
         'games.comic_url column',
         EXISTS(SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='games'
                    AND column_name='comic_url'),
         ''
  -- ── 034 ────────────────────────────────────────────────────
  UNION ALL SELECT 35, '034-edit-confirmed-poll.sql',
         'update_game_poll_meta body permits confirmed-poll edits',
         EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
                  WHERE n.nspname='public' AND p.proname='update_game_poll_meta'
                    AND pg_get_functiondef(p.oid) ILIKE '%''open'', ''expanded'', ''confirmed''%'),
         '🟡 Function-body probe — looks for the widened status whitelist (028 used the narrower open/expanded only)'
  -- ── 035 ────────────────────────────────────────────────────
  UNION ALL SELECT 36, '035-fix-zero-sum-trigger.sql',
         'check_game_zero_sum fn (re-fixed body)',
         EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
                  WHERE n.nspname='public' AND p.proname='check_game_zero_sum'),
         '🟡 Re-modifies existing fn — PASS just confirms fn exists'
  -- ── 036 ────────────────────────────────────────────────────
  UNION ALL SELECT 37, '036-cancel-confirmed-poll.sql',
         'cancel_game_poll body permits status=''confirmed''',
         EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
                  WHERE n.nspname='public' AND p.proname='cancel_game_poll'
                    AND pg_get_functiondef(p.oid) ILIKE '%''open'', ''expanded'', ''confirmed''%'),
         '🟡 Function-body probe — looks for the widened cancel-allowed whitelist'
  -- ── 037 ────────────────────────────────────────────────────
  UNION ALL SELECT 38, '037-enforce-seat-cap.sql',
         'cast_poll_vote body enforces seat cap',
         EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
                  WHERE n.nspname='public' AND p.proname='cast_poll_vote'
                    AND pg_get_functiondef(p.oid) ILIKE '%seat_full%'),
         '🟡 Function-body probe — looks for the seat_full exception name'
  -- ── 038 ────────────────────────────────────────────────────
  UNION ALL SELECT 39, '038-schedule-repin-confirmed.sql',
         'manual_close_game_poll body permits re-pin on confirmed',
         EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
                  WHERE n.nspname='public' AND p.proname='manual_close_game_poll'
                    AND pg_get_functiondef(p.oid) ILIKE '%''open'', ''expanded'', ''confirmed''%'),
         '🟡 Function-body probe — looks for the widened status whitelist'
  -- ── 039 ────────────────────────────────────────────────────
  UNION ALL SELECT 40, '039-schedule-voting-lock.sql',
         'game_polls.voting_locked_at + set_poll_voting_lock fn',
         EXISTS(SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='game_polls'
                    AND column_name='voting_locked_at')
         AND EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
                  WHERE n.nspname='public' AND p.proname='set_poll_voting_lock'),
         ''
  -- ── 040 ────────────────────────────────────────────────────
  UNION ALL SELECT 41, '040-poll-share-slug.sql',
         'game_polls.share_slug + resolve_poll_share_slug fn',
         EXISTS(SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='game_polls'
                    AND column_name='share_slug')
         AND EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
                  WHERE n.nspname='public' AND p.proname='resolve_poll_share_slug'),
         ''
)
SELECT
  ord  AS "#",
  migration,
  artifact,
  CASE
    WHEN present AND notes LIKE '🟡%' THEN '🟡 INDIRECT'
    WHEN present                      THEN '✅ PASS'
    ELSE                                   '❌ MISSING'
  END AS status,
  notes
FROM probe
ORDER BY ord;

-- ============================================================
-- Bonus: a few broader sanity checks. These verify side-effects
-- of multiple migrations together (extra-bedrock checks that
-- something didn't get partially undone). All read-only.
-- ============================================================

-- Side-effect 1: total tables in public schema (should be ≥ 30)
SELECT 'tables_in_public' AS check_name,
       count(*)            AS value,
       CASE WHEN count(*) >= 30 THEN '✅ PASS' ELSE '❌ LOW' END AS status
  FROM information_schema.tables
  WHERE table_schema='public' AND table_type='BASE TABLE';

-- Side-effect 2: poll-related RPCs all present
SELECT 'poll_rpcs_present'        AS check_name,
       string_agg(p.proname, ', ' ORDER BY p.proname) AS value,
       CASE WHEN count(*) = 18 THEN '✅ PASS'
            ELSE '⚠️ check list: expected 18, got ' || count(*) END AS status
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace=n.oid
 WHERE n.nspname='public'
   AND p.proname IN (
     'is_schedule_admin','create_game_poll','cast_poll_vote',
     'admin_cast_poll_vote','admin_delete_poll_vote',
     'cancel_game_poll','manual_close_game_poll','expand_game_poll',
     'update_poll_target','update_poll_expansion_delay',
     'update_game_poll_meta','delete_game_poll','link_poll_to_game',
     'claim_poll_notifications','subscribe_to_poll_changes',
     'unsubscribe_from_poll_changes','set_poll_voting_lock',
     'resolve_poll_share_slug'
   );

-- Side-effect 3: every existing poll has a share_slug
SELECT 'all_polls_have_share_slug' AS check_name,
       count(*) AS polls_without_slug,
       CASE WHEN count(*) = 0 THEN '✅ PASS'
            ELSE '❌ MISSING — re-run 040-poll-share-slug.sql'
       END AS status
  FROM game_polls
  WHERE share_slug IS NULL;

-- Side-effect 4: realtime publication includes all schedule tables
SELECT 'schedule_realtime_tables' AS check_name,
       string_agg(tablename, ', ' ORDER BY tablename) AS value,
       CASE WHEN count(*) >= 3 THEN '✅ PASS'
            ELSE '⚠️ schedule realtime missing tables' END AS status
  FROM pg_publication_tables
  WHERE pubname='supabase_realtime'
    AND tablename IN ('game_polls','game_poll_dates','game_poll_votes');
