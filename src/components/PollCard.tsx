// ─── PollCard ─────────────────────────────────────────────────────────
// Single schedule-poll card. One tile per proposed date, each tile is
// self-contained with its own count pills, progress bar, and
// (👑 Leading / ✅ Locked) badge.
//
// Rendered inside `ScheduleTab` which owns the data fetch, modal stack
// (EditPollModal, PollManualCloseModal, cancel/delete confirms), and
// the toast queue. This component handles all per-poll affordances:
//
//   - onVote(yes/maybe/no)             → per-tile RSVP buttons
//   - admin proxy vote                 → per-tile "+ proxy" chip → ProxyVoteModal
//   - admin manual pick / re-pin       → per-tile pick chip (multi-date only,
//                                         hidden on the already-pinned tile,
//                                         hidden after the linked game starts)
//   - onEdit                           → "✎ ערוך" admin chip
//   - handleToggleVotingLock           → "🔒/🔓" admin chip (lock/unlock)
//   - onCancel                         → "בטל" admin chip
//   - onDelete                         → "מחק" admin chip
//   - reminder                         → "📣 תזכורת" admin chip → ReminderModal
//                                         (open / expanded only)
//   - start scheduled game             → "התחל משחק" admin chip
//                                         (admin, confirmed-at-target, !confirmedGameId)
//   - handleShareInvitation            → "📤 שתף הצבעה" chip
//                                         (open / expanded, !confirmed-below-target)
//   - share chooser modal              → "📤 שתף ▾" chip
//                                         (confirmed-below-target only)
//   - handleShareConfirmation          → "📤 שתף משחק" chip
//                                         (confirmed at target)
//   - handleShareCancellation          → "📤 שתף" chip (cancelled, admin)
//   - onToggleSubscription             → "🔔" chip (member, active polls)
//   - VoterGroups w/ highlightPlayerId → expandable voter list per tile

import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import type { CSSProperties } from 'react';
import {
  PollTimer,
  VoterGroups,
  PollShareCard,
  ProxyVoteModal,
  ReminderModal,
  ModalPortal,
  fmtHebrewDate,
  ghostBtn,
  shareBtn,
} from './ScheduleTab';
import type { PollCardProps, DateStat } from './ScheduleTab';
import { getAllPolls, setPollVotingLock } from '../database/storage';
import { captureAndSplit, shareFiles } from '../utils/sharing';
import type { TranslationKey } from '../i18n/translations';
import type { RsvpResponse, Player } from '../types';

export default function PollCard(props: PollCardProps) {
  const {
    poll, players, currentPlayer, isAdmin, now,
    onVote, onEdit, onManualClose, onCancel, onDelete,
    isSubscribed, onToggleSubscription,
    onError, onSuccess, handleRpcError, navigate, t,
  } = props;

  // The progress-bar fill direction follows the page's `dir` attribute
  // (set on <html> via i18n bootstrap) — Hebrew bar fills from the right
  // automatically because the parent flex container inherits `dir=rtl`.
  // No JS-side RTL flag is needed since we ship a solid colour now,
  // not a gradient image whose `background-position` had to be flipped.

  const playerById = useMemo(() => new Map(players.map(p => [p.id, p])), [players]);

  // Per-date yes/maybe/no counts + proxy-vote breakdown.
  // Shape matches what VoterGroups expects.
  const dateStats = useMemo(() => {
    const stats = new Map<string, DateStat>();
    for (const d of poll.dates) {
      stats.set(d.id, { yes: 0, maybe: 0, no: 0, voters: [], proxyCount: 0 });
    }
    for (const v of poll.votes) {
      const s = stats.get(v.dateId);
      if (!s) continue;
      s[v.response]++;
      const isProxy = !!v.castByUserId && (v.userId == null || v.castByUserId !== v.userId);
      s.voters.push({
        playerId: v.playerId,
        response: v.response,
        isProxy,
        votedAt: v.votedAt,
        createdAt: v.createdAt,
        castByUserId: v.castByUserId ?? null,
      });
      if (isProxy) s.proxyCount++;
    }
    return stats;
  }, [poll]);

  // Resolve user_id → player.name for proxy-vote attribution. We
  // derive the mapping from every self-cast vote across all polls —
  // when userId === castByUserId, the playerId on that row tells us
  // which player belongs to that auth user. Admins are typically
  // permanent players who self-vote on at least one poll, so this
  // covers the common case without requiring a server RPC. Falls back
  // to a generic label when the actor has never voted themselves.
  const userIdToPlayerName = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of getAllPolls()) {
      for (const v of p.votes) {
        if (!v.userId || v.castByUserId !== v.userId) continue;
        const name = playerById.get(v.playerId)?.name;
        if (name) m.set(v.userId, name);
      }
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poll, playerById]);

  // Per-date current-user vote (powers the "Your vote" chip + the
  // active-state on each RSVP button).
  const currentUserVoteByDate = useMemo(() => {
    const m = new Map<string, RsvpResponse>();
    if (!currentPlayer) return m;
    for (const v of poll.votes) {
      if (v.playerId === currentPlayer.id) m.set(v.dateId, v.response);
    }
    return m;
  }, [poll.votes, currentPlayer]);

  // Migration 039 admin-toggleable soft lock.
  const isVotingLocked = !!poll.votingLockedAt;

  // Permission gate — same SQL semantics + error-reason discriminants
  // the server's cast_poll_vote enforces. Critical that this stays in
  // sync so the disabled-button reasoning here matches what the
  // server actually rejects.
  const canVote = useMemo(() => {
    if (!currentPlayer) return { allowed: false, reason: 'no_player_link' as const };
    if (poll.status === 'cancelled' || poll.status === 'expired') {
      return { allowed: false, reason: 'poll_locked' as const };
    }
    if (isVotingLocked) {
      return { allowed: false, reason: 'voting_locked' as const };
    }
    if (poll.status === 'open' && currentPlayer.type !== 'permanent') {
      return { allowed: false, reason: 'tier_not_allowed' as const };
    }
    if (poll.status === 'confirmed'
        && !poll.expandedAt
        && currentPlayer.type !== 'permanent') {
      return { allowed: false, reason: 'tier_not_allowed' as const };
    }
    return { allowed: true as const };
  }, [poll.status, poll.expandedAt, currentPlayer, isVotingLocked]);

  // Admin proxy-vote modal state — keyed by date id; null when closed.
  const [proxyDateId, setProxyDateId] = useState<string | null>(null);

  // Reminder modal state — admin nudge for non-voters on open / expanded
  // polls. Opens a list of eligible non-voters with checkboxes, defaults
  // to "all checked", sends push + email through the existing dispatch
  // path (which respects the group's Push / Email toggles).
  const [reminderOpen, setReminderOpen] = useState(false);

  // Per-date "show voters" toggle. Default collapsed.
  const [expandedVoterDates, setExpandedVoterDates] = useState<Set<string>>(() => new Set());
  const toggleVotersExpanded = (dateId: string) => {
    setExpandedVoterDates(prev => {
      const next = new Set(prev);
      if (next.has(dateId)) next.delete(dateId); else next.add(dateId);
      return next;
    });
  };

  // Share chooser modal — only opens for the ambiguous confirmed-
  // below-target state (recruit-more vs announce-locked).
  const [shareChooserOpen, setShareChooserOpen] = useState(false);

  // Admin "more actions" kebab menu — collapses the destructive
  // Cancel / Delete chips behind a single ⋯ button so they don't
  // sit shoulder-to-shoulder with constructive admin actions
  // (which made accidental misclicks more likely on mobile and
  // also visually overweighted the bottom strip with red).
  //
  // The menu has to escape the card's own CSS stacking context to
  // be visible — `.poll-card { will-change: transform }` locks any
  // descendant z-index inside the card. With two poll cards on
  // screen the second card's body paints over the first card's
  // popover. We solve this by rendering the popover via
  // `ModalPortal` (appends to document.body) and `position: fixed`
  // anchored to the kebab button's getBoundingClientRect.
  const [adminMenuOpen, setAdminMenuOpen] = useState(false);
  const adminMenuRef = useRef<HTMLDivElement | null>(null);
  const adminMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const [adminMenuPos, setAdminMenuPos] = useState<{ top: number; left: number } | null>(null);
  // Track hovered/pressed item so the destructive options read as
  // real clickable buttons (transparent rows looked like plain text).
  const [adminMenuHover, setAdminMenuHover] = useState<'lock' | 'cancel' | 'delete' | null>(null);
  useEffect(() => {
    if (!adminMenuOpen) {
      setAdminMenuHover(null);
      return;
    }
    const handleDocClick = (e: MouseEvent) => {
      const inMenu = adminMenuRef.current?.contains(e.target as Node);
      const onButton = adminMenuButtonRef.current?.contains(e.target as Node);
      if (!inMenu && !onButton) {
        setAdminMenuOpen(false);
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAdminMenuOpen(false);
    };
    // Recompute popover position whenever the page scrolls / resizes
    // — getBoundingClientRect is a snapshot, not reactive. We use
    // plain physical `top`/`left` (NOT logical `inset-inline-*`)
    // because logical properties mirror under `dir="rtl"` and the
    // app's main shell is RTL — that flipped our previous attempt
    // off-screen to the right. We anchor the menu's right edge to
    // the kebab's right edge (so it opens inward in both LTR and
    // RTL), then clamp to the viewport with an 8px safe gutter.
    const updatePos = () => {
      const btn = adminMenuButtonRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const menuWidth = 144; // matches the rendered popover (minWidth 130 + 2*4 padding + a small buffer)
      let left = r.right - menuWidth;
      const maxLeft = window.innerWidth - menuWidth - 8;
      if (left > maxLeft) left = maxLeft;
      if (left < 8) left = 8;
      setAdminMenuPos({ top: r.bottom + 6, left });
    };
    updatePos();
    // Defer the listener so the click that opened the menu doesn't
    // immediately close it on the same tick.
    const timer = window.setTimeout(() => {
      document.addEventListener('mousedown', handleDocClick);
      document.addEventListener('keydown', handleEsc);
    }, 0);
    window.addEventListener('scroll', updatePos, { passive: true, capture: true });
    window.addEventListener('resize', updatePos);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('mousedown', handleDocClick);
      document.removeEventListener('keydown', handleEsc);
      window.removeEventListener('scroll', updatePos, true);
      window.removeEventListener('resize', updatePos);
    };
  }, [adminMenuOpen]);

  const confirmedDate = poll.dates.find(d => d.id === poll.confirmedDateId);
  const confirmedPlayers = useMemo(() => {
    if (!confirmedDate) return [] as Player[];
    return poll.votes
      .filter(v => v.dateId === confirmedDate.id && v.response === 'yes')
      .map(v => playerById.get(v.playerId))
      .filter((p): p is Player => !!p);
  }, [confirmedDate, poll.votes, playerById]);

  // visualStatus pivot: a confirmed-below-target poll renders with the
  // same chrome it had before lock-in (open / expanded), so members
  // immediately see "still recruiting" instead of the green "locked"
  // skin that no longer matches reality.
  const confirmedDateYes = confirmedDate
    ? (dateStats.get(confirmedDate.id)?.yes ?? 0)
    : 0;
  const isConfirmedBelowTarget =
    poll.status === 'confirmed' && confirmedDateYes < poll.targetPlayerCount;
  const visualStatus: typeof poll.status = isConfirmedBelowTarget
    ? (poll.expandedAt ? 'expanded' : 'open')
    : poll.status;

  const statusColor: Record<string, string> = {
    open:      '#3b82f6',
    expanded:  '#f97316',
    confirmed: '#10b981',
    cancelled: '#ef4444',
    expired:   '#94a3b8',
  };

  // ─── Leader detection (multi-date polls only) ───
  // Powers the per-tile "👑 Leading" badge. Suppressed when the
  // poll is single-date, already pinned/confirmed (the locked tile
  // shows ✅ Locked instead), no yes-votes yet, or there's a tie at
  // the top (showing "Leading" on both tiles is misleading).
  const leaderDateId = useMemo(() => {
    if (poll.dates.length < 2) return null;
    if (poll.confirmedDateId) return null;
    let bestId: string | null = null;
    let bestYes = 0;
    let tied = false;
    for (const d of poll.dates) {
      const y = dateStats.get(d.id)?.yes ?? 0;
      if (y === 0) continue;
      if (y > bestYes) { bestId = d.id; bestYes = y; tied = false; }
      else if (y === bestYes) { tied = true; }
    }
    return tied ? null : bestId;
  }, [poll.dates, poll.confirmedDateId, dateStats]);

  // ─── WhatsApp screenshot share ─────────────────────────
  // Off-screen `<PollShareCard>` rendered into a fixed-position div,
  // captured via html2canvas, split into N images, and handed to
  // navigator.share / fallback download.
  const shareCardRef = useRef<HTMLDivElement>(null);
  const [shareMode, setShareMode] = useState<'invitation' | 'confirmation' | 'cancellation' | null>(null);
  const [isSharing, setIsSharing] = useState(false);

  const captureShare = useCallback(async (
    mode: 'invitation' | 'confirmation' | 'cancellation',
    baseName: string,
    title: string,
    caption: string,
  ) => {
    if (isSharing) return;
    setShareMode(mode);
    setIsSharing(true);
    try {
      // Two animation frames so React commits the share-card DOM.
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      if (!shareCardRef.current) return;
      const files = await captureAndSplit(shareCardRef.current, baseName, { backgroundColor: '#0f172a' });
      await shareFiles(files, title, caption);
    } catch (e) {
      onError(handleRpcError(e));
    } finally {
      setIsSharing(false);
      setShareMode(null);
    }
  }, [isSharing, onError, handleRpcError]);

  // Per-mode WhatsApp caption with deep-link to the specific poll
  // (`/p/<token>` short-form, falls back to UUID for old in-flight
  // rows).
  const buildShareCaption = (mode: 'invitation' | 'confirmation' | 'cancellation'): string => {
    const captionKey = (
      mode === 'invitation'   ? 'schedule.share.captionInvitation' :
      mode === 'confirmation' ? 'schedule.share.captionConfirmation' :
                                'schedule.share.captionCancellation'
    ) as TranslationKey;
    const line = t(captionKey);
    if (typeof window === 'undefined') return line;
    const linkToken = poll.shareSlug ?? poll.id;
    const deepLink = `${window.location.origin}/p/${encodeURIComponent(linkToken)}`;
    return `${line}\n${deepLink}`;
  };

  const handleShareInvitation = () => captureShare(
    'invitation',
    `poker-poll-invitation-${poll.id.slice(0, 8)}`,
    t('schedule.share.invitationTitle'),
    buildShareCaption('invitation'),
  );
  const handleShareConfirmation = () => captureShare(
    'confirmation',
    `poker-poll-confirmed-${poll.id.slice(0, 8)}`,
    t('schedule.share.confirmationTitle'),
    buildShareCaption('confirmation'),
  );
  const handleShareCancellation = () => captureShare(
    'cancellation',
    `poker-poll-cancelled-${poll.id.slice(0, 8)}`,
    t('schedule.share.cancellationTitle'),
    buildShareCaption('cancellation'),
  );

  // Lock / unlock voting (migration 039).
  const [lockSubmitting, setLockSubmitting] = useState(false);
  const handleToggleVotingLock = async () => {
    if (lockSubmitting) return;
    setLockSubmitting(true);
    const nextLocked = !isVotingLocked;
    try {
      await setPollVotingLock(poll.id, nextLocked);
      onSuccess(nextLocked
        ? t('schedule.votingLockedSuccess')
        : t('schedule.votingUnlockedSuccess'));
    } catch (e) {
      onError(handleRpcError(e));
    } finally {
      setLockSubmitting(false);
    }
  };

  return (
    <div className="card poll-card" style={{
      padding: 14, marginBottom: 12,
      // Phase-color top border — visible on both LTR and RTL without
      // depending on physical sides.
      borderTop: `3px solid ${statusColor[visualStatus] || 'var(--border)'}`,
    }}>
      {/* Phase-aware countdown banner. Self-hides on cancelled / expired. */}
      <PollTimer poll={poll} now={now} t={t} />

      {/* Optional admin note */}
      {poll.note && (
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 10 }}>
          {t('schedule.notePrefix')} {poll.note}
        </div>
      )}

      {/* Cancelled reason — surfaced before the tiles so members
          immediately see why a previously-active poll was killed. */}
      {poll.status === 'cancelled' && poll.cancellationReason && (
        <div style={{
          padding: 10, borderRadius: 6, marginBottom: 10,
          background: 'rgba(239, 68, 68, 0.08)',
          fontSize: 13, color: 'var(--text-muted)',
        }}>
          💬 {poll.cancellationReason}
        </div>
      )}

      {/* Voting-locked banner (migration 039). Renders above the
          tiles so members see "voting frozen" before they tap a
          (now-disabled) RSVP button. */}
      {isVotingLocked && (poll.status === 'open' || poll.status === 'expanded' || poll.status === 'confirmed') && (
        <div
          title={t('schedule.errorVotingLocked')}
          style={{
            marginBottom: 10, padding: '6px 10px', borderRadius: 6,
            background: 'rgba(250, 204, 21, 0.10)',
            border: '1px solid rgba(250, 204, 21, 0.35)',
            color: '#facc15', fontSize: 12, fontWeight: 600,
            display: 'flex', alignItems: 'center', gap: 6,
          }}
        >
          <span aria-hidden>🔒</span>
          <span>{t('schedule.votingLockedBadge')}</span>
        </div>
      )}

      {/* Per-date tiles. Hidden on expired (the timer banner
          already says "expired" and there's no actionable vote);
          cancelled polls still render so members can see the
          frozen vote roster — RSVP buttons disable themselves
          via `canVote.allowed`. */}
      {poll.status !== 'expired' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {poll.dates.map(d => {
            const s = dateStats.get(d.id) || { yes: 0, maybe: 0, no: 0, voters: [], proxyCount: 0 };
            const myVote = currentUserVoteByDate.get(d.id);
            const loc = d.location || poll.defaultLocation;
            const isPinnedHere = poll.confirmedDateId === d.id;
            const isLockedHere = isPinnedHere && poll.status === 'confirmed' && !isConfirmedBelowTarget;
            const isLeading = leaderDateId === d.id;
            const expanded = expandedVoterDates.has(d.id);
            const pct = poll.targetPlayerCount > 0
              ? Math.min(100, Math.round((s.yes / poll.targetPlayerCount) * 100))
              : 0;
            const tileBorderColor = isPinnedHere
              ? 'rgba(16, 185, 129, 0.40)'
              : isLeading
                ? 'rgba(99, 102, 241, 0.32)'
                : 'var(--border)';
            const tileBg = isPinnedHere
              ? 'rgba(16, 185, 129, 0.06)'
              : 'var(--surface-elevated, var(--surface))';
            // Tiles in an active state (locked or leading) get a
            // softly-coloured glow + slightly stronger drop shadow
            // so they "lift" off the page when the user scans the
            // poll. Neutral tiles keep the original subtle shadow.
            const tileShadow = isPinnedHere
              ? '0 2px 6px rgba(16, 185, 129, 0.20), 0 1px 2px rgba(0, 0, 0, 0.18)'
              : isLeading
                ? '0 2px 6px rgba(99, 102, 241, 0.18), 0 1px 2px rgba(0, 0, 0, 0.18)'
                : '0 1px 2px rgba(0, 0, 0, 0.18)';

            return (
              <div
                key={d.id}
                id={`poll-date-row-${poll.id}-${d.id}`}
                className="poll-date-row"
                style={{
                  padding: 10, borderRadius: 8,
                  background: tileBg,
                  border: `1px solid ${tileBorderColor}`,
                  boxShadow: tileShadow,
                }}
              >
                {/* Tile header — date / location + STATE badges +
                    admin manual-pick affordance.
                    The proxy count is data, not state, so it moved
                    to the summary row below to keep the header from
                    line-wrapping on multi-state confirmed polls
                    with long Hebrew location names. Locked wins
                    over Leading (a locked date isn't "leading"
                    any more — it's settled). The 📌 button lives
                    here (not in the RSVP/action row) because at
                    five buttons (yes / maybe / no / ➕ / 📌) the
                    action row would wrap on a 360px viewport.
                    Conceptually the manual-pick is a state change
                    on the tile ("admin overrides the leader") so
                    it groups naturally with the Locked / Leading
                    badges.
                    On narrow phones (≤360px) Hebrew dates +
                    long location names + Leading + 📌 used to push
                    the header onto 3 visual lines. The fix: the
                    left column stacks date-on-top, location-below
                    (truncated with ellipsis), so the badge cluster
                    on the right always pairs with the date row,
                    not with whatever the location wrap left behind.
                    `minWidth: 0` on the left column is what allows
                    `text-overflow: ellipsis` to actually clip
                    inside a flex child (otherwise the child grows
                    to its content's intrinsic width). */}
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
                  flexWrap: 'wrap', gap: 6, marginBottom: 8,
                }}>
                  <div style={{
                    display: 'flex', flexDirection: 'column',
                    minWidth: 0, flex: '1 1 auto', gap: 1,
                  }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
                      {fmtHebrewDate(d)}
                    </div>
                    {loc && (
                      <div
                        title={loc}
                        style={{
                          fontSize: 12, fontWeight: 400, color: 'var(--text-muted)',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                          maxWidth: '100%',
                          display: 'flex', alignItems: 'center', gap: 4,
                        }}
                      >
                        <span aria-hidden style={{ fontSize: 11, opacity: 0.85 }}>📍</span>
                        <span style={{
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>{loc}</span>
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', flexShrink: 0 }}>
                    {isLockedHere && (
                      <span style={{
                        padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700,
                        background: 'rgba(16, 185, 129, 0.14)', color: '#34d399',
                        border: '1px solid rgba(16, 185, 129, 0.40)',
                      }}>✅ {t('schedule.lockedDate')}</span>
                    )}
                    {!isLockedHere && isLeading && (
                      <span style={{
                        padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
                        background: 'rgba(99, 102, 241, 0.14)', color: '#a5b4fc',
                        border: '1px solid rgba(99, 102, 241, 0.40)',
                      }}>👑 {t('schedule.leadingDate')}</span>
                    )}
                    {/* Admin manual-pick / re-pin. Multi-date polls only,
                        hidden on the already-pinned tile, hidden once a
                        game has been started from the poll. */}
                    {isAdmin
                      && onManualClose
                      && poll.dates.length >= 2
                      && poll.confirmedDateId !== d.id
                      && !poll.confirmedGameId
                      && (
                      <button
                        onClick={() => onManualClose(d.id)}
                        title={poll.status === 'confirmed'
                          ? t('schedule.manualRepin')
                          : t('schedule.manualClose')}
                        style={{
                          padding: '2px 8px', borderRadius: 999,
                          border: '1px dashed var(--border)', background: 'transparent',
                          color: 'var(--text-muted)', fontSize: 11, fontWeight: 600,
                          cursor: 'pointer',
                        }}>📌 {t('schedule.manualPickShort')}</button>
                    )}
                  </div>
                </div>

                {/* Single-row vote summary: progress bar · yes/target ratio.
                    The bar takes flex:1 so it stretches to fill the row, with
                    the small ratio chip clamped to the trailing edge. The
                    colour-ramped gradient gives an at-a-glance fill cue
                    ("almost full" reads instantly off a half-green bar) that
                    the textual "X/Y" alone wouldn't.
                    The per-response count pills (`✓ N ? N ✗ N`) used to live
                    here but were removed per user feedback — same numbers
                    are visible in the expandable voter list below, and the
                    bar already conveys the "yes" progress. The proxy
                    "N הוזנו ע״י אדמין" badge was removed for the same
                    reason: each proxy vote already carries a ★ glyph in the
                    expanded voter list, so a top-level count chip just adds
                    visual noise. */}
                <div style={{
                  display: 'flex', alignItems: 'center',
                  flexWrap: 'wrap', gap: 8, marginBottom: 8,
                }}>
                  {/* Solid-emerald progress bar. The bar's only job
                      is "how far toward target" — width alone is enough,
                      colour stays neutral-green for the whole fill. Same
                      `#10b981` as RSVP-yes / Locked badge so the colour
                      identity stays consistent across the tile. */}
                  <div style={{
                    flex: 1, minWidth: 60,
                    height: 4, background: 'rgba(148, 163, 184, 0.18)',
                    borderRadius: 999, overflow: 'hidden',
                  }}>
                    <div style={{
                      width: `${pct}%`, height: '100%',
                      background: '#10b981',
                      borderRadius: 999,
                      transition: 'width 0.3s ease',
                    }} />
                  </div>
                  <span style={{
                    fontSize: 11, color: 'var(--text-muted)', fontWeight: 600,
                    fontVariantNumeric: 'tabular-nums',
                  }}>
                    {s.yes}/{poll.targetPlayerCount}
                  </span>
                </div>

                {/* RSVP buttons + admin proxy.
                    Active vote is rendered with a bolder coloured border + a
                    soft ~12% tint of the response colour. The admin proxy
                    chip shares the same base height/font as the RSVP buttons
                    (so it doesn't read as a visually-squashed afterthought)
                    and lives behind a `marginInlineStart: auto` divider
                    that pushes it to the row's end — flexbox handles
                    RTL/LTR mirroring naturally. The 📌 manual-pick button
                    used to live on this row but moved to the tile header
                    so the action row stays at four buttons max
                    (yes/maybe/no/➕) and never wraps on mobile. */}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  {(['yes', 'maybe', 'no'] as RsvpResponse[]).map(resp => {
                    if (resp === 'maybe' && !poll.allowMaybe) return null;
                    const active = myVote === resp;
                    const colorMap: Record<RsvpResponse, string> = {
                      yes: '#10b981', maybe: '#eab308', no: '#ef4444',
                    };
                    const labelMap: Record<RsvpResponse, string> = {
                      yes: t('schedule.rsvpYes'),
                      maybe: t('schedule.rsvpMaybe'),
                      no: t('schedule.rsvpNo'),
                    };
                    // Per-date seat-cap on yes upgrades. SQL is the
                    // source of truth (migration 037 raises 'seat_full');
                    // disabling proactively gives instant feedback.
                    const wouldOverfill =
                      resp === 'yes' && !active && s.yes >= poll.targetPlayerCount;
                    const disabled = !canVote.allowed || wouldOverfill;
                    return (
                      <button
                        key={resp}
                        disabled={disabled}
                        onClick={() => onVote(poll, d.id, resp)}
                        title={
                          wouldOverfill ? t('schedule.errorSeatFull') :
                          canVote.allowed ? '' :
                          canVote.reason === 'no_player_link' ? t('schedule.errorNoPlayerLink') :
                          canVote.reason === 'tier_not_allowed' ? t('schedule.errorTierNotAllowed') :
                          canVote.reason === 'voting_locked' ? t('schedule.errorVotingLocked') :
                          t('schedule.errorPollLocked')
                        }
                        className={`poll-rsvp-btn${active ? ' poll-rsvp-btn--active' : ''}`}
                        style={{
                          padding: '6px 12px', borderRadius: 8,
                          border: active ? `1.5px solid ${colorMap[resp]}` : '1px solid var(--border)',
                          background: active ? `${colorMap[resp]}1f` : 'transparent',
                          color: active ? colorMap[resp] : 'var(--text)',
                          fontWeight: active ? 700 : 500, fontSize: 13,
                          cursor: disabled ? 'not-allowed' : 'pointer',
                          opacity: disabled ? 0.4 : 1,
                        }}>{labelMap[resp]}</button>
                    );
                  })}
                  {isAdmin && (
                    <button
                      onClick={() => setProxyDateId(d.id)}
                      disabled={isVotingLocked}
                      title={isVotingLocked
                        ? t('schedule.errorVotingLocked')
                        : t('schedule.proxy.modalTitle')}
                      className="poll-rsvp-btn"
                      style={{
                        // Icon-only button: keep the vertical box matched
                        // to the RSVP buttons (so the row's baseline aligns)
                        // but tighten the horizontal padding — a single ➕
                        // glyph doesn't need 12px of breathing room on
                        // each side.
                        marginInlineStart: 'auto',
                        padding: '6px 8px', borderRadius: 8,
                        border: '1px solid rgba(16, 185, 129, 0.4)',
                        background: 'rgba(16, 185, 129, 0.12)',
                        color: '#34d399', fontSize: 13, fontWeight: 600,
                        cursor: isVotingLocked ? 'not-allowed' : 'pointer',
                        opacity: isVotingLocked ? 0.4 : 1,
                        lineHeight: 1,
                      }}>{t('schedule.proxy.add')}</button>
                  )}
                </div>

                {/* Voter list — collapsed by default. Empty list
                    renders nothing. `highlightPlayerId` tags the
                    current member's name with a "(you)" badge.
                    Borderless text-only toggle so it reads as a
                    list-expander affordance, not as another admin
                    chip (the dashed-border style is reserved for
                    admin actions like 📌 pick / re-pin). Hover lifts
                    the colour from muted to text — keeps it
                    discoverable without competing for attention. */}
                {s.voters.length > 0 && (
                  <>
                    <button
                      onClick={() => toggleVotersExpanded(d.id)}
                      className="poll-ghost-btn"
                      style={{
                        marginTop: 6,
                        width: '100%',
                        padding: '4px 10px', borderRadius: 6,
                        border: 'none', background: 'transparent',
                        color: 'var(--text-muted)', fontSize: 11, cursor: 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                        fontWeight: 500,
                      }}
                      aria-expanded={expanded}
                    >
                      <span aria-hidden>{expanded ? '▲' : '▼'}</span>
                      <span>
                        {expanded
                          ? t('schedule.voters.hideList')
                          : `${t('schedule.voters.showList')} (${s.voters.length})`}
                      </span>
                    </button>
                    {expanded && (
                      <VoterGroups
                        voters={s.voters}
                        playerById={playerById}
                        userIdToPlayerName={userIdToPlayerName}
                        allowMaybe={poll.allowMaybe}
                        highlightPlayerId={currentPlayer?.id ?? null}
                        youLabel={t(
                          currentPlayer?.gender === 'male'
                            ? 'schedule.voters.youTag.male'
                            : 'schedule.voters.youTag.female',
                        )}
                        t={t}
                      />
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Action chip strip — card-level admin actions + member
          subscribe + member-or-admin share. Visual hierarchy is
          tuned for mobile:
            * Constructive chips (Start game / Share / Edit /
              Subscribe) sit at the row's start.
            * Secondary admin toggles (Lock voting) and destructive
              actions (Cancel / Delete) collapse into a single ⋯
              kebab popover at the row's end. This keeps the
              visible strip at ≤3 chips + kebab on every status,
              which fits one row on a 375px-wide phone (the
              `confirmed` flow used to spill onto two rows with
              `[Start] [Share] [Edit] [Lock] [⋯]` — and the
              auto-margin on the kebab made the wrap look broken).
          Wraps naturally on narrow viewports if it ever needs to. */}
      <div role="group" aria-label={t('schedule.adminBarLabel')} style={{
        display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12,
      }}>
        {/* Start Scheduled Game — admin, confirmed-at-target,
            !confirmedGameId. Routes to NewGameScreen. */}
        {isAdmin && poll.status === 'confirmed' && confirmedDate && !poll.confirmedGameId && (
          <button
            onClick={() => {
              navigate('/', {
                state: {
                  fromPoll: {
                    pollId: poll.id,
                    playerIds: confirmedPlayers.map(p => p.id),
                    location: confirmedDate.location || poll.defaultLocation || undefined,
                  },
                },
              });
            }}
            style={{
              padding: '6px 12px', borderRadius: 6, border: 'none',
              background: 'var(--primary)', color: '#fff',
              fontWeight: 600, fontSize: 12, cursor: 'pointer',
            }}>{t('schedule.startScheduledGame')}</button>
        )}
        {poll.status === 'confirmed' && poll.confirmedGameId && (
          <span style={{ fontSize: 13, fontWeight: 600, color: '#10b981' }}>
            ✓ {t('schedule.gameStarted')}
          </span>
        )}
        {/* Share invitation — open / expanded. */}
        {(poll.status === 'open' || poll.status === 'expanded') && !isConfirmedBelowTarget && (
          <button onClick={handleShareInvitation} disabled={isSharing} style={shareBtn}>
            {isSharing ? t('common.capturing') : t('schedule.share.shareInvitationLabel')}
          </button>
        )}
        {/* Share menu — confirmed-below-target opens the chooser. */}
        {isConfirmedBelowTarget && (
          <button
            onClick={() => setShareChooserOpen(true)}
            disabled={isSharing}
            style={shareBtn}
            title={t('schedule.share.chooserTitle')}
          >
            {isSharing ? t('common.capturing') : t('schedule.share.shareMenuLabel')}
          </button>
        )}
        {/* Vote-change subscription toggle — members on active polls. */}
        {!isAdmin && (visualStatus === 'open' || visualStatus === 'expanded') && (
          <button
            onClick={onToggleSubscription}
            title={isSubscribed
              ? t('schedule.subscribe.tooltipOn')
              : t('schedule.subscribe.tooltipOff')}
            style={{
              ...shareBtn,
              color: isSubscribed ? '#34d399' : 'var(--text-muted)',
              borderColor: isSubscribed ? 'rgba(16, 185, 129, 0.5)' : 'var(--border)',
              background: isSubscribed ? 'rgba(16, 185, 129, 0.10)' : 'var(--surface)',
            }}>
            {isSubscribed ? t('schedule.subscribe.on') : t('schedule.subscribe.off')}
          </button>
        )}
        {/* Share confirmation — confirmed at target. */}
        {poll.status === 'confirmed' && confirmedDate && !isConfirmedBelowTarget && (
          <button onClick={handleShareConfirmation} disabled={isSharing} style={shareBtn}>
            {isSharing ? t('common.capturing') : t('schedule.share.shareConfirmationLabel')}
          </button>
        )}
        {/* Share cancellation — admin-only heads-up screenshot. */}
        {poll.status === 'cancelled' && isAdmin && (
          <button onClick={handleShareCancellation} disabled={isSharing} style={shareBtn}>
            {isSharing ? t('common.capturing') : t('common.share')}
          </button>
        )}
        {/* Reminder — admin-only, open + expanded polls only. Confirmed
            polls already have a locked date; "didn't vote yet" is no
            longer the relevant axis there (the relevant action is
            confirming attendance, which the share-game flow covers).
            Sits with the constructive cluster (start / share / edit)
            since it's a non-destructive nudge action. */}
        {isAdmin && (poll.status === 'open' || poll.status === 'expanded') && (
          <button
            onClick={() => setReminderOpen(true)}
            title={t('schedule.reminder.button')}
            style={ghostBtn}
          >
            📣 {t('schedule.reminder.button')}
          </button>
        )}
        {/* Edit (admin, active polls). */}
        {isAdmin && (poll.status === 'open' || poll.status === 'expanded' || poll.status === 'confirmed') && (
          <button onClick={onEdit} style={ghostBtn}>✎ {t('schedule.editPoll')}</button>
        )}
        {/* Secondary + destructive admin actions — Lock voting +
            Cancel + Delete — collapsed into a single ⋯ kebab
            popover so the visible strip stays short on mobile.
            The kebab itself sits at the row's end via
            `marginInlineStart: 'auto'` (RTL/LTR safe via flexbox).
            On `cancelled` / `expired` polls we still show the
            kebab so the Delete option remains reachable. */}
        {isAdmin && (
          <>
            <button
              ref={adminMenuButtonRef}
              type="button"
              onClick={() => setAdminMenuOpen(open => !open)}
              aria-haspopup="menu"
              aria-expanded={adminMenuOpen}
              title={t('schedule.adminBarLabel')}
              style={{
                ...ghostBtn,
                marginInlineStart: 'auto',
                padding: '6px 10px',
                lineHeight: 1,
                fontSize: 16,
                fontWeight: 700,
                color: 'var(--text-muted)',
              }}
            >
              ⋯
            </button>
            {adminMenuOpen && adminMenuPos && (
              // Render via ModalPortal so the menu escapes the
              // `.poll-card { will-change: transform }` stacking
              // context. Anchored with `position: fixed` to the
              // kebab button via getBoundingClientRect — keeps it
              // visible above other poll cards / sticky headers.
              <ModalPortal>
                <div
                  ref={adminMenuRef}
                  role="menu"
                  style={{
                    position: 'fixed',
                    top: adminMenuPos.top,
                    left: adminMenuPos.left,
                    minWidth: 130,
                    padding: 4,
                    borderRadius: 8,
                    background: 'var(--surface-elevated, var(--surface))',
                    border: '1px solid var(--border)',
                    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
                    display: 'flex', flexDirection: 'column', gap: 4,
                    zIndex: 1100,
                  }}
                >
                  {(() => {
                    // Chip-style menu items — each option is its
                    // own coloured tinted pill, white text so the
                    // colour reads as semantic accent rather
                    // than as the dominant palette. Hover deepens
                    // the tint instead of swapping to a neutral
                    // wash.
                    const lockTone = isVotingLocked
                      ? { rgb: '16, 185, 129' /* emerald — voting frozen */ }
                      : { rgb: '250, 204, 21' /* amber — voting open */ };
                    const dangerTone = { rgb: '239, 68, 68' /* red */ };
                    const chipStyle = (
                      tone: { rgb: string },
                      hovered: boolean,
                      extra?: CSSProperties,
                    ): CSSProperties => ({
                      textAlign: 'start',
                      padding: '7px 10px',
                      borderRadius: 6,
                      background: `rgba(${tone.rgb}, ${hovered ? 0.22 : 0.12})`,
                      border: `1px solid rgba(${tone.rgb}, ${hovered ? 0.7 : 0.45})`,
                      color: '#fff',
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: 'pointer',
                      transition: 'background 120ms ease, border-color 120ms ease',
                      ...extra,
                    });
                    return (
                      <>
                        {(poll.status === 'open' || poll.status === 'expanded' || poll.status === 'confirmed') && (
                          <button
                            role="menuitem"
                            type="button"
                            onClick={() => { setAdminMenuOpen(false); handleToggleVotingLock(); }}
                            disabled={lockSubmitting}
                            onMouseEnter={() => setAdminMenuHover('lock')}
                            onMouseLeave={() => setAdminMenuHover(prev => (prev === 'lock' ? null : prev))}
                            onFocus={() => setAdminMenuHover('lock')}
                            onBlur={() => setAdminMenuHover(prev => (prev === 'lock' ? null : prev))}
                            title={isVotingLocked
                              ? t('schedule.unlockVotesTooltip')
                              : t('schedule.lockVotesTooltip')}
                            style={chipStyle(lockTone, adminMenuHover === 'lock', {
                              cursor: lockSubmitting ? 'wait' : 'pointer',
                              opacity: lockSubmitting ? 0.6 : 1,
                            })}
                          >
                            {isVotingLocked ? t('schedule.unlockVotes') : t('schedule.lockVotes')}
                          </button>
                        )}
                        {(poll.status === 'open' || poll.status === 'expanded' || poll.status === 'confirmed') && (
                          <button
                            role="menuitem"
                            type="button"
                            onClick={() => { setAdminMenuOpen(false); onCancel(); }}
                            onMouseEnter={() => setAdminMenuHover('cancel')}
                            onMouseLeave={() => setAdminMenuHover(prev => (prev === 'cancel' ? null : prev))}
                            onFocus={() => setAdminMenuHover('cancel')}
                            onBlur={() => setAdminMenuHover(prev => (prev === 'cancel' ? null : prev))}
                            title={t('schedule.cancelPoll')}
                            style={chipStyle(dangerTone, adminMenuHover === 'cancel')}
                          >
                            {t('schedule.cancelPollShort')}
                          </button>
                        )}
                        <button
                          role="menuitem"
                          type="button"
                          onClick={() => { setAdminMenuOpen(false); onDelete(); }}
                          onMouseEnter={() => setAdminMenuHover('delete')}
                          onMouseLeave={() => setAdminMenuHover(prev => (prev === 'delete' ? null : prev))}
                          onFocus={() => setAdminMenuHover('delete')}
                          onBlur={() => setAdminMenuHover(prev => (prev === 'delete' ? null : prev))}
                          title={t('schedule.deletePoll')}
                          style={chipStyle(dangerTone, adminMenuHover === 'delete')}
                        >
                          {t('schedule.deletePollShort')}
                        </button>
                      </>
                    );
                  })()}
                </div>
              </ModalPortal>
            )}
          </>
        )}
      </div>

      {/* Admin proxy-vote modal — admin/owner/super_admin only */}
      {isAdmin && proxyDateId && (
        <ProxyVoteModal
          poll={poll}
          dateId={proxyDateId}
          players={players}
          onClose={() => setProxyDateId(null)}
          onSuccess={onSuccess}
          onError={onError}
          handleRpcError={handleRpcError}
          t={t}
        />
      )}

      {/* Reminder modal — admin-only, open + expanded polls only */}
      {isAdmin && reminderOpen && (
        <ReminderModal
          poll={poll}
          players={players}
          onClose={() => setReminderOpen(false)}
          onSuccess={onSuccess}
          onError={onError}
          t={t}
        />
      )}

      {/* Share-target chooser modal — only opens for confirmed-
          below-target where invitation + confirmation both apply. */}
      {shareChooserOpen && (
        <ModalPortal>
          <div
            className="modal-overlay"
            onClick={() => !isSharing && setShareChooserOpen(false)}
          >
            <div className="modal" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h3 className="modal-title">{t('schedule.share.chooserTitle')}</h3>
                <button
                  className="modal-close"
                  onClick={() => setShareChooserOpen(false)}
                  disabled={isSharing}
                  aria-label={t('common.close')}
                >×</button>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                <button
                  onClick={() => {
                    setShareChooserOpen(false);
                    handleShareInvitation();
                  }}
                  disabled={isSharing}
                  style={shareBtn}
                >
                  {t('schedule.share.shareInvitationLabel')}
                </button>
                <button
                  onClick={() => {
                    setShareChooserOpen(false);
                    handleShareConfirmation();
                  }}
                  disabled={isSharing}
                  style={shareBtn}
                >
                  {t('schedule.share.shareConfirmationLabel')}
                </button>
              </div>
            </div>
          </div>
        </ModalPortal>
      )}

      {/* Off-screen premium screenshot card (rendered only while
          sharing). `direction: 'ltr'` host wrapper prevents RTL
          inheritance from confusing the screenshot. */}
      {shareMode && (
        <div style={{
          position: 'fixed', left: -10000, top: 0,
          pointerEvents: 'none',
          direction: 'ltr',
        }} aria-hidden="true">
          <div ref={shareCardRef}>
            <PollShareCard
              mode={shareMode}
              poll={poll}
              dateStats={dateStats}
              playerById={playerById}
              confirmedDate={confirmedDate}
              confirmedPlayers={confirmedPlayers}
              appUrl={typeof window !== 'undefined' ? window.location.origin : undefined}
              t={t}
            />
          </div>
        </div>
      )}
    </div>
  );
}
