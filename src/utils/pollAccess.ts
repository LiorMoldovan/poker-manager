import type { GamePoll, PlayerType } from '../types';

// Single source of truth for "may this viewer vote right now?".
//
// This mirrors the tier/lock gate in the server's cast_poll_vote. It lived in
// two places before — PollCard had the full rule, HomeDashboard had a shortened
// copy that omitted the cap fallback — so the Home card stayed silent for guests
// the server would happily accept, and nudged guests the server would reject.
// Any surface that decides whether to show a vote CTA must call this rather
// than re-deriving the rule.
//
// Keep in lockstep with cast_poll_vote. The server clause is:
//   player_type <> 'permanent'
//   AND expanded_at IS NULL
//   AND now() < created_at + (expansion_delay_hours + maybe_hold_hours)

export type PollVoteBlockReason =
  | 'no_player_link'
  | 'poll_locked'
  | 'voting_locked'
  | 'tier_not_allowed';

export type PollVoteGate =
  | { allowed: true; reason?: undefined }
  | { allowed: false; reason: PollVoteBlockReason };

type PollGateFields = Pick<
  GamePoll,
  'status' | 'createdAt' | 'expandedAt' | 'expansionDelayHours' | 'maybeHoldHours' | 'votingLockedAt'
>;

// The instant guests stop being gated even if the poll never expanded. The
// clock runs from creation rather than expansion: a fully-held poll
// deliberately doesn't expand, so an expansion-based clock would never release.
export const guestGateLiftsAt = (poll: PollGateFields): number =>
  new Date(poll.createdAt).getTime()
  + (poll.expansionDelayHours + (poll.maybeHoldHours ?? 48)) * 3600_000;

export const evaluatePollVoteGate = (
  poll: PollGateFields,
  playerType: PlayerType | null,
  now: number,
): PollVoteGate => {
  if (!playerType) return { allowed: false, reason: 'no_player_link' };
  if (poll.status === 'cancelled' || poll.status === 'expired') {
    return { allowed: false, reason: 'poll_locked' };
  }
  if (poll.votingLockedAt) return { allowed: false, reason: 'voting_locked' };
  if (playerType !== 'permanent' && !poll.expandedAt && now < guestGateLiftsAt(poll)) {
    return { allowed: false, reason: 'tier_not_allowed' };
  }
  return { allowed: true };
};

export const canViewerVoteNow = (
  poll: PollGateFields,
  playerType: PlayerType | null,
  now: number,
): boolean => evaluatePollVoteGate(poll, playerType, now).allowed;
