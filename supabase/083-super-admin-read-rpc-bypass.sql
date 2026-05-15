-- 083-super-admin-read-rpc-bypass.sql
--
-- Sister fix to migration 082: a sweep of READ-only RPCs that
-- `RAISE EXCEPTION 'Not a member of this group'` for any caller
-- without a group_members row. The same defect that bit the
-- settings load (Bug #1 in 082) bites these too — when a super
-- admin observes a group via GroupSwitcher they're not a member,
-- the RPC throws, and the screen renders empty/blank widgets
-- instead of the observed group's real data. Stats screen comes
-- back blank, History counts show 0, owner email lookup fails,
-- etc.
--
-- These are pure SELECT RPCs — no writes, no notifications, no
-- side effects — so granting super admins the same bypass that
-- super_admins_full_access RLS already grants on the underlying
-- tables is consistent and safe.
--
-- Functions covered:
--   get_player_stats               — Statistics screen aggregates
--   get_game_counts                — History/Stats game counts
--   get_group_owner_email          — Settings > Group owner contact
--   get_player_email_for_notification — Notification target lookup
--
-- Already bypassed (NOT touched here for reference):
--   fetch_trivia_leaderboard       — bypass added in earlier mig
--   fetch_group_members_with_email — bypass added in mig 061
--   get_group_settings             — bypass added in mig 082
--
-- Write RPCs intentionally NOT touched (observer must be rejected
-- because the mutation would actually take effect via RLS):
--   transfer_ownership, leave_group, add_member_by_email,
--   update_member_role, remove_group_member, regenerate_invite_code,
--   self_create_and_link, link_member_to_player, unlink_member_player,
--   create_player_invite, join_group_by_invite, cast_poll_vote,
--   admin_cast_poll_vote, create_game_poll, expand_game_poll,
--   set_my_vote_change_notifs.
--
-- Idempotency: all CREATE OR REPLACE.

-- ─── get_player_stats ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_player_stats(p_group_id uuid)
  RETURNS TABLE(
    player_id uuid,
    player_name text,
    games_played bigint,
    total_profit numeric,
    total_rebuys bigint,
    biggest_win numeric,
    biggest_loss numeric,
    avg_profit numeric,
    win_count bigint,
    loss_count bigint,
    current_streak integer
  )
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM super_admins WHERE user_id = auth.uid())
     AND NOT EXISTS (
       SELECT 1 FROM group_members WHERE group_id = p_group_id AND user_id = auth.uid()
     ) THEN
    RAISE EXCEPTION 'Not a member of this group';
  END IF;

  RETURN QUERY
  SELECT
    gp.player_id,
    gp.player_name,
    COUNT(*)::BIGINT AS games_played,
    SUM(gp.profit) AS total_profit,
    SUM(gp.rebuys)::BIGINT AS total_rebuys,
    MAX(gp.profit) AS biggest_win,
    MIN(gp.profit) AS biggest_loss,
    AVG(gp.profit) AS avg_profit,
    COUNT(*) FILTER (WHERE gp.profit > 0)::BIGINT AS win_count,
    COUNT(*) FILTER (WHERE gp.profit < 0)::BIGINT AS loss_count,
    0 AS current_streak
  FROM game_players gp
  JOIN games g ON g.id = gp.game_id
  WHERE g.group_id = p_group_id
    AND g.status = 'completed'
  GROUP BY gp.player_id, gp.player_name;
END;
$function$;

-- ─── get_game_counts ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_game_counts(p_group_id uuid)
  RETURNS TABLE(status text, cnt bigint)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM super_admins WHERE user_id = auth.uid())
     AND NOT EXISTS (
       SELECT 1 FROM group_members WHERE group_id = p_group_id AND user_id = auth.uid()
     ) THEN
    RAISE EXCEPTION 'Not a member of this group';
  END IF;

  RETURN QUERY
  SELECT g.status, COUNT(*)::BIGINT
  FROM games g
  WHERE g.group_id = p_group_id
  GROUP BY g.status;
END;
$function$;

-- ─── get_group_owner_email ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_group_owner_email(p_group_id uuid)
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
DECLARE
  caller_authorized BOOLEAN;
  owner_email TEXT;
BEGIN
  -- Super admin OR member of the group can look up the owner email.
  -- Super admins use this for cross-group support / quota checks.
  caller_authorized := EXISTS (SELECT 1 FROM super_admins WHERE user_id = auth.uid())
                     OR EXISTS (
                       SELECT 1 FROM group_members
                       WHERE user_id = auth.uid() AND group_id = p_group_id
                     );
  IF NOT caller_authorized THEN
    RAISE EXCEPTION 'Not a member of this group';
  END IF;

  SELECT u.email INTO owner_email
    FROM groups g
    JOIN auth.users u ON u.id = g.created_by
    WHERE g.id = p_group_id;

  RETURN owner_email;
END;
$function$;

-- ─── get_player_email_for_notification ────────────────────
CREATE OR REPLACE FUNCTION public.get_player_email_for_notification(
  p_group_id uuid,
  p_player_name text
)
  RETURNS TABLE(target_user_id uuid, email text)
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM super_admins WHERE user_id = auth.uid())
     AND NOT EXISTS (
       SELECT 1 FROM group_members WHERE group_id = p_group_id AND user_id = auth.uid()
     ) THEN
    RAISE EXCEPTION 'Not a member of this group';
  END IF;

  RETURN QUERY
    SELECT gm.user_id, au.email::TEXT
    FROM group_members gm
    JOIN players p ON p.id = gm.player_id
    JOIN auth.users au ON au.id = gm.user_id
    WHERE gm.group_id = p_group_id AND p.name = p_player_name
    LIMIT 1;
END;
$function$;
