-- Backfill historical "Other" and "Poll Link" entries in activity_log.screens_visited:
-- 1. Rows whose user_id & time window match a completed trivia_sessions row -> "Trivia"
-- 2. All remaining "Other" and "Poll Link" entries -> "Schedule" (deduplicated in order)

WITH trivia_rows AS (
  SELECT al.id
  FROM public.activity_log al
  WHERE al.screens_visited @> '["Other"]'::jsonb
    AND EXISTS (
      SELECT 1
      FROM public.trivia_sessions ts
      WHERE ts.user_id = al.user_id
        AND ts.completed_at BETWEEN al.timestamp - interval '15 minutes'
                                AND COALESCE(al.last_active, al.timestamp) + interval '5 minutes'
    )
)
UPDATE public.activity_log al
SET screens_visited = (
  SELECT COALESCE(jsonb_agg(mapped ORDER BY first_ord), '[]'::jsonb)
  FROM (
    SELECT mapped, MIN(ord) AS first_ord
    FROM (
      SELECT CASE WHEN elem = 'Other' THEN 'Trivia' ELSE elem END AS mapped, ord
      FROM jsonb_array_elements_text(al.screens_visited) WITH ORDINALITY AS t(elem, ord)
    ) s
    GROUP BY mapped
  ) dedup
)
WHERE al.id IN (SELECT id FROM trivia_rows);

UPDATE public.activity_log al
SET screens_visited = (
  SELECT COALESCE(jsonb_agg(mapped ORDER BY first_ord), '[]'::jsonb)
  FROM (
    SELECT mapped, MIN(ord) AS first_ord
    FROM (
      SELECT CASE WHEN elem IN ('Other', 'Poll Link') THEN 'Schedule' ELSE elem END AS mapped, ord
      FROM jsonb_array_elements_text(al.screens_visited) WITH ORDINALITY AS t(elem, ord)
    ) s
    GROUP BY mapped
  ) dedup
)
WHERE al.screens_visited @> '["Other"]'::jsonb
   OR al.screens_visited @> '["Poll Link"]'::jsonb;
