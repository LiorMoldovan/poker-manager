-- 041: Activity log — backfill NULL player_name / user_id from sibling rows
--
-- Why this exists:
--   `activity_log` has one row per *session start*. The client effect that
--   inserts those rows can fire BEFORE `auth.membership.playerName` is loaded
--   (the membership data is fetched in a separate async pass after auth.user
--   is set). For users that ever existed in this loading window — or for
--   members who were briefly unlinked from a player record — the earliest
--   sessions land in the table with `player_name = NULL` while later sessions
--   for the *same physical device* carry the correct name.
--
--   The Activity tab in SettingsScreen.tsx then grouped entries by display
--   name (`playerName || deviceLabel || deviceId.slice(0,8)`), so identity-
--   equivalent rows with one NULL and one named field rendered as TWO
--   separate user cards (e.g. "ספי טורס" + "4e34f3a9").
--
--   The frontend has been updated to group by stable identity (user_id ||
--   device_id), and `logActivity` now self-heals NULLs on insert. This
--   migration cleans the historical bad rows once so the activity audit
--   shows a single canonical card per user from this point forward.
--
-- Strategy:
--   For every (group_id, device_id) pair we pick the most recent row that
--   has a non-null player_name and copy its player_name + user_id onto all
--   sibling rows where those columns are NULL. We never overwrite a value
--   that's already present — the LATEST known name wins, and any earlier
--   non-null name (e.g. before a rename) is preserved as-is on its own row.

-- Idempotent: running twice is a no-op because the second pass finds no
-- NULL rows that have a named sibling.

WITH latest_named AS (
  SELECT DISTINCT ON (group_id, device_id)
         group_id,
         device_id,
         player_name,
         user_id
    FROM activity_log
   WHERE player_name IS NOT NULL
   ORDER BY group_id, device_id, COALESCE(last_active, timestamp) DESC
)
UPDATE activity_log al
   SET player_name = COALESCE(al.player_name, ln.player_name),
       user_id     = COALESCE(al.user_id,     ln.user_id)
  FROM latest_named ln
 WHERE al.group_id  = ln.group_id
   AND al.device_id = ln.device_id
   AND (al.player_name IS NULL OR al.user_id IS NULL)
   AND (ln.player_name IS NOT NULL OR ln.user_id IS NOT NULL);

-- Sanity probe — surfaces remaining NULL-named rows so you can spot any
-- truly anonymous device that has NO named sibling at all (those stay
-- NULL on purpose; they're walk-by visitors that never identified).
SELECT group_id,
       device_id,
       count(*)             AS null_rows,
       max(last_active)     AS last_seen
  FROM activity_log
 WHERE player_name IS NULL
 GROUP BY group_id, device_id
 ORDER BY last_seen DESC NULLS LAST;
