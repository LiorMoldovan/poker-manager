// Hook returning the user's currently-pending poll vote (or null), with
// reactive updates on cache changes and a 1-minute tick for time-based
// urgency transitions.
//
// Used by:
//   * VoteReminderBanner — global "you should vote" banner above routes.
//   * SettingsScreen     — pending-vote dot on the schedule tab nav button.

import { useEffect, useMemo, useState } from 'react';
import { findPendingVote, type PendingVoteInfo } from '../utils/voteReminder';
import { getAllPolls, getAllPlayers } from '../database/storage';
import { usePermissions } from '../App';

export function usePendingVote(): PendingVoteInfo | null {
  const { playerName } = usePermissions();
  const [now, setNow] = useState(Date.now());
  const [version, setVersion] = useState(0);

  // Re-render when the supabase cache emits an update — that's how new polls
  // and new votes propagate from realtime listeners.
  useEffect(() => {
    const onUpdate = () => setVersion(v => v + 1);
    window.addEventListener('supabase-cache-updated', onUpdate);
    return () => window.removeEventListener('supabase-cache-updated', onUpdate);
  }, []);

  // Tick every minute so a poll that becomes "time-critical" (≤6h to phase
  // boundary) flips its urgency without requiring an unrelated re-render.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  return useMemo(() => {
    if (!playerName) return null;
    const player = getAllPlayers().find(p => p.name === playerName) ?? null;
    return findPendingVote(player, getAllPolls(), now);
    // version is a dependency: it changes when the cache mutates, prompting
    // recomputation against the freshly-loaded data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerName, now, version]);
}
