-- One-time cleanup of dev-loop bloat in activity_log from April-May 2026
-- for user 2c8d9de2-3eb6-4e83-9a37-1274370076cf (23,996 rows out of 28,495),
-- preserving 100% of all other members' history and all rows from June 2026 onward.

DELETE FROM public.activity_log
WHERE user_id = '2c8d9de2-3eb6-4e83-9a37-1274370076cf'
  AND timestamp < '2026-06-01T00:00:00Z';
