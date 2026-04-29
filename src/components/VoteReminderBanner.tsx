// Global "you should vote" banner.
//
// Mounted in App.tsx above the routed screens (only when the standard nav is
// shown — not during live-game / chip-entry / game-summary). Uses the
// usePendingVote hook for eligibility + urgency, and stores per-poll
// dismissals in localStorage keyed by status so an open→expanded transition
// re-shows the banner with fresh context.
//
// Visual:
//   * Compact card-style banner that sits inside the page scroll above all
//     route content. Subtle gradient background tinted by urgency level
//     (calm green / amber spots / blue time / red critical).
//   * Single line of title + body, with a primary "Vote now" pill on the end
//     and a small × dismiss in the corner.
//   * On mobile the title and body wrap onto separate lines automatically.
//   * Tapping the body or the CTA navigates to the schedule tab in Settings
//     with the relevant pollId in the query string (the same deep-link the
//     push notifications use).

import { useNavigate } from 'react-router-dom';
import { useTranslation } from '../i18n';
import type { TranslationKey } from '../i18n/translations';
import { usePendingVote } from '../hooks/usePendingVote';
import { bucketRemaining, type PendingVoteInfo } from '../utils/voteReminder';
import { useEffect, useState } from 'react';

const DISMISS_KEY_PREFIX = 'poker-vote-banner-dismissed:';

// Dismissal key includes poll status AND a "critical" flag. Reasons:
//   * status: an open→expanded transition is a fresh prompt, so the banner
//     re-shows even if the user dismissed it during the open phase.
//   * critical bucket: if the user dismissed a low/spots/time banner and
//     the situation later escalates to 'critical' (≤6h to deadline AND ≤2
//     spots left), they should see it again. We DO NOT bucket the other
//     levels — toggling between low/spots/time on every vote would feel
//     spammy.
const isCriticalBucket = (info: PendingVoteInfo): boolean => info.urgency === 'critical';

const dismissKey = (info: PendingVoteInfo): string =>
  `${DISMISS_KEY_PREFIX}${info.poll.id}:${info.poll.status}:${isCriticalBucket(info) ? 'critical' : 'normal'}`;

const isDismissed = (info: PendingVoteInfo): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(dismissKey(info)) === '1';
  } catch {
    return false;
  }
};

const markDismissed = (info: PendingVoteInfo): void => {
  try {
    localStorage.setItem(dismissKey(info), '1');
  } catch {
    /* localStorage unavailable — fail silently */
  }
};

const formatRemaining = (
  ms: number,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string => {
  const { key, params } = bucketRemaining(ms);
  switch (key) {
    case 'days':       return t('schedule.timer.fmtDays', params);
    case 'daysShort':  return t('schedule.timer.fmtDaysShort', params);
    case 'hours':      return t('schedule.timer.fmtHours', params);
    case 'hoursShort': return t('schedule.timer.fmtHoursShort', params);
    case 'minutes':    return t('schedule.timer.fmtMinutes', params);
    case 'seconds':    return t('schedule.timer.fmtSeconds');
  }
};

interface UrgencyTheme {
  bg: string;
  border: string;
  accent: string;
  titleKey: TranslationKey;
}

const themeFor = (info: PendingVoteInfo): UrgencyTheme => {
  switch (info.urgency) {
    case 'critical':
      return {
        bg: 'linear-gradient(135deg, rgba(239, 68, 68, 0.18), rgba(239, 68, 68, 0.06))',
        border: 'rgba(239, 68, 68, 0.50)',
        accent: '#ef4444',
        titleKey: 'voteReminder.titleCritical',
      };
    case 'time':
      return {
        bg: 'linear-gradient(135deg, rgba(59, 130, 246, 0.18), rgba(59, 130, 246, 0.06))',
        border: 'rgba(59, 130, 246, 0.45)',
        accent: '#3b82f6',
        titleKey: 'voteReminder.titleTime',
      };
    case 'spots':
      return {
        bg: 'linear-gradient(135deg, rgba(234, 179, 8, 0.18), rgba(234, 179, 8, 0.06))',
        border: 'rgba(234, 179, 8, 0.45)',
        accent: '#eab308',
        titleKey: 'voteReminder.titleSpots',
      };
    case 'low':
    default:
      return {
        bg: 'linear-gradient(135deg, rgba(16, 185, 129, 0.18), rgba(16, 185, 129, 0.05))',
        border: 'rgba(16, 185, 129, 0.40)',
        accent: '#10b981',
        titleKey: 'voteReminder.titleDefault',
      };
  }
};

const bodyFor = (
  info: PendingVoteInfo,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string => {
  const time = formatRemaining(Math.max(0, info.msUntilDeadline), t);
  switch (info.urgency) {
    case 'critical':
      return info.deadlineKind === 'expansion'
        ? t('voteReminder.bodyCriticalOpen', { n: info.spotsLeft, time })
        : t('voteReminder.bodyCriticalExpanded', { n: info.spotsLeft, time });
    case 'time':
      return info.deadlineKind === 'expansion'
        ? t('voteReminder.bodyTimeOpen', { time })
        : t('voteReminder.bodyTimeExpanded', { time });
    case 'spots':
      return t('voteReminder.bodySpots', { n: info.spotsLeft });
    case 'low':
    default:
      return t('voteReminder.bodyDefault');
  }
};

export function VoteReminderBanner() {
  const { t, isRTL } = useTranslation();
  const navigate = useNavigate();
  const pending = usePendingVote();
  // Local state forces a re-render after dismissal (localStorage write alone
  // wouldn't notify React). We use a counter to invalidate the dismiss check.
  const [dismissTick, setDismissTick] = useState(0);

  // Reset the tick whenever the dismiss bucket changes — pending poll id,
  // status, OR critical/normal escalation — so the freshly-keyed dismissal
  // gets re-checked on next render. The localStorage entry for the new key
  // is what actually decides visibility; tick is just a render trigger.
  useEffect(() => {
    setDismissTick(0);
  }, [pending?.poll.id, pending?.poll.status, pending && isCriticalBucket(pending)]);

  if (!pending) return null;
  // Single check (not duplicated): both branches of the previous tick guard
  // collapsed to the same condition.
  if (isDismissed(pending)) return null;
  // Reference dismissTick once so it remains a real dependency for React's
  // re-render flow without any user-visible effect.
  void dismissTick;

  const theme = themeFor(pending);
  const title = t(theme.titleKey);
  const body = bodyFor(pending, t);

  const handleVote = () => {
    navigate(`/settings?tab=schedule&pollId=${encodeURIComponent(pending.poll.id)}`);
  };

  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation();
    markDismissed(pending);
    setDismissTick(v => v + 1);
  };

  return (
    <div
      role="status"
      aria-live="polite"
      onClick={handleVote}
      style={{
        position: 'relative',
        marginBottom: '0.75rem',
        padding: '0.75rem 0.95rem',
        borderRadius: 12,
        background: theme.bg,
        border: `1px solid ${theme.border}`,
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.18)',
        cursor: 'pointer',
        direction: isRTL ? 'rtl' : 'ltr',
        textAlign: isRTL ? 'right' : 'left',
        animation: 'contentFadeIn 0.3s ease-out',
      }}
    >
      <button
        onClick={handleDismiss}
        aria-label={t('voteReminder.dismiss')}
        title={t('voteReminder.dismiss')}
        style={{
          position: 'absolute',
          top: 6,
          // Logical inset; in RTL × should sit at the visual left.
          insetInlineStart: 8,
          background: 'transparent',
          border: 'none',
          color: 'var(--text-muted)',
          fontSize: '0.95rem',
          cursor: 'pointer',
          padding: '2px 6px',
          lineHeight: 1,
          opacity: 0.7,
        }}
      >×</button>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        flexWrap: 'wrap',
        // Make room for the absolutely-positioned dismiss × in RTL/LTR.
        paddingInlineStart: 24,
      }}>
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          <div style={{
            fontSize: '0.9rem',
            fontWeight: 700,
            color: theme.accent,
            marginBottom: 2,
            lineHeight: 1.3,
          }}>
            {title}
          </div>
          <div style={{
            fontSize: '0.8rem',
            color: 'var(--text)',
            lineHeight: 1.4,
            opacity: 0.92,
          }}>
            {body}
          </div>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); handleVote(); }}
          style={{
            padding: '0.5rem 0.95rem',
            borderRadius: 10,
            border: 'none',
            background: theme.accent,
            color: '#fff',
            fontWeight: 700,
            fontSize: '0.8rem',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {t('voteReminder.cta')}
        </button>
      </div>
    </div>
  );
}
