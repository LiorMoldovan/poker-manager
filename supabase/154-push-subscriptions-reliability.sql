-- =============================================================================
-- Migration 154: Multi-Group Push Subscription Isolation & Sync RPC
-- =============================================================================
-- Problem:
--   `push_subscriptions` had a unique constraint on `(user_id, endpoint)` instead
--   of `(group_id, user_id, endpoint)`. Because a browser/PWA has a single push
--   endpoint per origin, whenever a multi-group member (e.g. Idan Torres) opened
--   or switched to a second group, `savePushSubscription` upserted on
--   `(user_id, endpoint)` and overwrote `group_id`, stealing their active device
--   subscription away from their primary group.
--
-- Solution:
--   1. Replace the unique index on `(user_id, endpoint)` with a unique index on
--      `(group_id, user_id, endpoint)` and add `updated_at TIMESTAMPTZ`.
--   2. Provide `sync_user_push_subscription(p_group_id, p_player_name, p_endpoint,
--      p_keys_p256dh, p_keys_auth)` which upserts the subscription for the active
--      group AND automatically syncs the same device endpoint across all other
--      groups where the user is a member with a linked player.
--   3. Backfill any missing multi-group rows for existing active subscriptions
--      and remove Idan's dead September endpoint from his secondary group.
-- =============================================================================

-- 1. Add updated_at column to track last verification/refresh
ALTER TABLE public.push_subscriptions
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- 2. Replace UNIQUE (user_id, endpoint) with UNIQUE (group_id, user_id, endpoint)
ALTER TABLE public.push_subscriptions
  DROP CONSTRAINT IF EXISTS push_subscriptions_user_id_endpoint_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.push_subscriptions'::regclass
      AND conname = 'push_subscriptions_group_user_endpoint_key'
  ) THEN
    ALTER TABLE public.push_subscriptions
      ADD CONSTRAINT push_subscriptions_group_user_endpoint_key
      UNIQUE (group_id, user_id, endpoint);
  END IF;
END $$;

-- 3. RPC to save/sync a push subscription across all of the user's memberships
CREATE OR REPLACE FUNCTION public.sync_user_push_subscription(
  p_group_id uuid,
  p_player_name text,
  p_endpoint text,
  p_keys_p256dh text,
  p_keys_auth text
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_m RECORD;
BEGIN
  IF v_user_id IS NULL OR p_endpoint IS NULL OR p_keys_p256dh IS NULL OR p_keys_auth IS NULL THEN
    RETURN;
  END IF;

  -- Upsert for the explicitly requested group (if user is a member of it)
  IF p_group_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.group_members gm
    WHERE gm.group_id = p_group_id AND gm.user_id = v_user_id
  ) THEN
    INSERT INTO public.push_subscriptions (
      group_id, user_id, player_name, endpoint, keys_p256dh, keys_auth, updated_at
    ) VALUES (
      p_group_id, v_user_id, p_player_name, p_endpoint, p_keys_p256dh, p_keys_auth, now()
    )
    ON CONFLICT (group_id, user_id, endpoint) DO UPDATE
      SET player_name = COALESCE(EXCLUDED.player_name, public.push_subscriptions.player_name),
          keys_p256dh = EXCLUDED.keys_p256dh,
          keys_auth   = EXCLUDED.keys_auth,
          updated_at  = now();
  END IF;

  -- Also sync this active device endpoint to every other group the user belongs to
  FOR v_m IN
    SELECT gm.group_id, p.name AS linked_player_name
      FROM public.group_members gm
      LEFT JOIN public.players p ON p.id = gm.player_id
     WHERE gm.user_id = v_user_id
       AND (p_group_id IS NULL OR gm.group_id <> p_group_id)
  LOOP
    INSERT INTO public.push_subscriptions (
      group_id, user_id, player_name, endpoint, keys_p256dh, keys_auth, updated_at
    ) VALUES (
      v_m.group_id,
      v_user_id,
      COALESCE(v_m.linked_player_name, p_player_name),
      p_endpoint,
      p_keys_p256dh,
      p_keys_auth,
      now()
    )
    ON CONFLICT (group_id, user_id, endpoint) DO UPDATE
      SET player_name = COALESCE(EXCLUDED.player_name, public.push_subscriptions.player_name),
          keys_p256dh = EXCLUDED.keys_p256dh,
          keys_auth   = EXCLUDED.keys_auth,
          updated_at  = now();
  END LOOP;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.sync_user_push_subscription(uuid, text, text, text, text)
  TO authenticated;

-- 4. Clean up Idan's dead Sept 3 endpoint in his secondary group and backfill
--    his active Nov 15 endpoint across both of his groups.
DELETE FROM public.push_subscriptions
 WHERE id = 'bf52b023-4e1c-42d7-89c4-149f581feee9'
   AND user_id = 'ef354c7a-e70b-493c-bf38-e1e9b5995208';

INSERT INTO public.push_subscriptions (
  group_id, user_id, player_name, endpoint, keys_p256dh, keys_auth, created_at, updated_at
)
SELECT
  gm.group_id,
  ps.user_id,
  COALESCE(p.name, ps.player_name),
  ps.endpoint,
  ps.keys_p256dh,
  ps.keys_auth,
  ps.created_at,
  now()
FROM public.push_subscriptions ps
JOIN public.group_members gm ON gm.user_id = ps.user_id AND gm.group_id <> ps.group_id
LEFT JOIN public.players p ON p.id = gm.player_id
ON CONFLICT (group_id, user_id, endpoint) DO NOTHING;
