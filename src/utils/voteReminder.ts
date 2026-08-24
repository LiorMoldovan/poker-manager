// Eligibility + urgency logic for the global "you should vote" reminder.
//
// A user has a "pending vote" when:
//   * They have a linked Player record.
//   * There's at least one poll still collecting votes where:
//       - Tier rule: permanents always qualify; other tiers join once the
//         poll has opened to them (`expandedAt`).
//       - The user has NOT cast a vote on any date they can still vote on.
//   * If the user qualifies for multiple polls, the most urgent one wins.
//
// "Still collecting votes" includes a poll whose date is already PICKED but
// hasn't filled its seats. Since migration 106 a pick funnels voting to the
// chosen date rather than freezing it, so a picked-but-short poll is the
// phase where a nudge matters most — those last seats are exactly what the
// admin is chasing. Only the picked date counts there: the server rejects
// votes on every other date, so a stale 'no' on a rival date is not an
// answer to "are you coming on the 29th?".
//
// "Urgent" means either:
//   * Time is short — < SOON_HOURS until the next phase boundary
//     (expansion-due for 'open' polls, soonest proposed date for 'expanded').
//   * Few spots left — within FEW_SPOTS yes-votes of the target on the best
//     date.
// Both signals → 'critical'. Either alone → 'time' / 'spots'. Neither → 'low'.
//
// All logic is pure so it can be tested in isolation and reused both by the
// banner component and the Settings schedule-tab dot.

import type { GamePoll, Player } from '../types';

export type VoteUrgency = 'low' | 'spots' | 'time' | 'critical';

export interface PendingVoteInfo {
  poll: GamePoll;
  urgency: VoteUrgency;
  // Yes-votes still needed on the best date to confirm the game.
  spotsLeft: number;
  // Milliseconds until the relevant phase boundary; Infinity if there is no
  // boundary in sight (e.g. expanded poll with all dates already past — but
  // those would already be expired, so practically rare).
  msUntilDeadline: number;
  // Which boundary we're counting toward — drives the body copy ("expands in
  // X" vs "starts in X"). Currently we don't differentiate copy further but
  // the field is here for future polishing.
  deadlineKind: 'expansion' | 'gameDate';
  // True when a date is already picked and we're chasing the remaining
  // seats. The banner swaps its calm body copy for this case — "dates have
  // been proposed" is wrong once the night is chosen.
  pickedDate: boolean;
}

const SOON_HOURS = 6;
const FEW_SPOTS = 2;
const HOUR_MS = 60 * 60 * 1000;

const dateRowMs = (proposedDate: string, proposedTime: string | null | undefined): number => {
  const time = proposedTime || '21:00';
  const ts = new Date(`${proposedDate}T${time}`).getTime();
  return Number.isFinite(ts) ? ts : 0;
};

const earliestUpcomingDateMs = (poll: GamePoll, now: number): number => {
  let best = Infinity;
  for (const d of poll.dates) {
    const t = dateRowMs(d.proposedDate, d.proposedTime);
    if (t > now && t < best) best = t;
  }
  return best;
};

// Highest yes-count among the dates that can still receive a vote. Scoped
// to `votableDateIds` so a picked poll measures the picked date only — the
// rival date's tally is frozen history and must not mask a seat shortage.
const bestYesCount = (poll: GamePoll, votableDateIds: string[]): number => {
  const counts = new Map<string, number>();
  for (const v of poll.votes) {
    if (v.response === 'yes' && votableDateIds.includes(v.dateId)) {
      counts.set(v.dateId, (counts.get(v.dateId) ?? 0) + 1);
    }
  }
  let max = 0;
  for (const c of counts.values()) if (c > max) max = c;
  return max;
};

// Permanents can always vote. Other tiers wait for the poll to open to
// them, which the server marks with `expandedAt` — migration 086 stamps it
// even when the poll was pinned during the permanents-only window, so this
// reads correctly for a 'confirmed' poll too. The status check covers
// legacy rows that flipped to 'expanded' before `expandedAt` existed.
const isPlayerEligible = (player: Player, poll: GamePoll): boolean => {
  if (player.type === 'permanent') return true;
  return poll.status === 'expanded' || !!poll.expandedAt;
};

export function findPendingVote(
  currentPlayer: Player | null,
  polls: GamePoll[],
  now: number,
): PendingVoteInfo | null {
  if (!currentPlayer) return null;

  const candidates: PendingVoteInfo[] = [];

  for (const poll of polls) {
    // A picked poll still recruiting: the date is set, the seats are not
    // full, and no game has been started off it yet.
    const isRecruitingPick = poll.status === 'confirmed'
      && !!poll.confirmedDateId
      && !poll.confirmedGameId;
    if (poll.status !== 'open' && poll.status !== 'expanded' && !isRecruitingPick) continue;
    // An admin froze voting — pointing someone at a button the server will
    // reject is worse than staying quiet.
    if (poll.votingLockedAt) continue;
    if (!isPlayerEligible(currentPlayer, poll)) continue;

    // The dates a vote would actually be accepted on. Excluded dates never
    // qualify, and once one is picked it's the only one.
    const votableDateIds = isRecruitingPick
      ? [poll.confirmedDateId as string]
      : poll.dates.filter(d => !d.disabledAt).map(d => d.id);
    if (votableDateIds.length === 0) continue;

    // Already responded? Skip — we don't want to badger users who voted no
    // either; they've made their choice and can revisit on their own.
    if (poll.votes.some(v =>
      v.playerId === currentPlayer.id && votableDateIds.includes(v.dateId)
    )) continue;

    const spotsLeft = Math.max(0, poll.targetPlayerCount - bestYesCount(poll, votableDateIds));
    // The picked night is already full — nobody is waiting on this viewer.
    // (Open / expanded polls keep nudging at 0 spots: the admin hasn't
    // committed to a date yet, so another yes still shapes the outcome.)
    if (isRecruitingPick && spotsLeft === 0) continue;

    let msUntilDeadline = Infinity;
    let deadlineKind: PendingVoteInfo['deadlineKind'] = 'expansion';
    if (poll.status === 'open') {
      const expansionDue = new Date(poll.createdAt).getTime() + poll.expansionDelayHours * HOUR_MS;
      msUntilDeadline = expansionDue - now;
      deadlineKind = 'expansion';
    } else if (isRecruitingPick) {
      const picked = poll.dates.find(d => d.id === poll.confirmedDateId);
      const ts = picked ? dateRowMs(picked.proposedDate, picked.proposedTime) : 0;
      msUntilDeadline = ts > now ? ts - now : Infinity;
      deadlineKind = 'gameDate';
    } else {
      const earliest = earliestUpcomingDateMs(poll, now);
      msUntilDeadline = earliest === Infinity ? Infinity : earliest - now;
      deadlineKind = 'gameDate';
    }

    const timeCritical = msUntilDeadline > 0 && msUntilDeadline <= SOON_HOURS * HOUR_MS;
    const fewSpots = spotsLeft > 0 && spotsLeft <= FEW_SPOTS;

    let urgency: VoteUrgency = 'low';
    if (timeCritical && fewSpots) urgency = 'critical';
    else if (timeCritical) urgency = 'time';
    else if (fewSpots) urgency = 'spots';

    candidates.push({
      poll, urgency, spotsLeft, msUntilDeadline, deadlineKind,
      pickedDate: isRecruitingPick,
    });
  }

  if (candidates.length === 0) return null;

  // Sort by descending urgency. Ties broken by closest deadline first so a
  // truly time-sensitive poll wins over a calmer one with the same level.
  const order: Record<VoteUrgency, number> = { critical: 3, time: 2, spots: 1, low: 0 };
  candidates.sort((a, b) => {
    const cmp = order[b.urgency] - order[a.urgency];
    if (cmp !== 0) return cmp;
    return a.msUntilDeadline - b.msUntilDeadline;
  });
  return candidates[0];
}

// Format a remaining-time delta into a compact, localized string. Mirrors
// the formatter used by the in-card PollTimer so banner + card show the
// same numbers. We return a key + params so the caller can apply i18n.
export function bucketRemaining(ms: number): {
  key: 'days' | 'daysShort' | 'hours' | 'hoursShort' | 'minutes' | 'seconds';
  params: Record<string, number>;
} {
  if (ms <= 60_000) return { key: 'seconds', params: {} };
  const totalMin = Math.floor(ms / 60_000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin - days * 60 * 24) / 60);
  const minutes = totalMin - days * 60 * 24 - hours * 60;
  if (days >= 1) {
    return hours > 0
      ? { key: 'days', params: { d: days, h: hours } }
      : { key: 'daysShort', params: { d: days } };
  }
  if (hours >= 1) {
    return minutes > 0
      ? { key: 'hours', params: { h: hours, m: minutes } }
      : { key: 'hoursShort', params: { h: hours } };
  }
  return { key: 'minutes', params: { m: minutes } };
}
