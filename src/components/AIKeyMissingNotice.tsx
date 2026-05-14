import { useNavigate } from 'react-router-dom';
import { useTranslation } from '../i18n';
import { usePermissions } from '../App';

// Friendly empty-state notice rendered wherever an AI feature can't run
// for the current group. Two reasons supported:
//
//   reason='noKey' (default)
//     The current group has no Gemini API key configured. Owner sees an
//     actionable CTA → Settings → Services. Member sees informational
//     copy ("ask the group owner").
//
//   reason='proxyUnavailable'
//     The /api/* AI proxy isn't reachable from this environment — almost
//     always: localhost dev (Vite doesn't serve Vercel Edge Functions).
//     Adding a key would NOT help, so we suppress the CTA and switch the
//     copy to "AI runs only on the deployed site". Same look-and-feel.
//
// Two visual modes:
//   - default: a small card with a title + body + (owner-only, noKey
//     reason only) a CTA button that navigates to Settings → Services.
//   - compact: a single inline pill, used on dense surfaces like the
//     LiveGameScreen subtitle where a full card would crowd the layout.
//
// We deliberately do NOT auto-detect role inside this component because
// some surfaces (LiveGameScreen TTS) want the same compact notice for
// everyone. The caller decides via the `role` prop.

export type AIKeyMissingNoticeRole = 'owner' | 'member' | 'auto';
export type AIKeyMissingNoticeReason = 'noKey' | 'proxyUnavailable';

export interface AIKeyMissingNoticeProps {
  /** What feature is unavailable (used in the body copy). */
  feature: 'summary' | 'forecast' | 'insights' | 'comic' | 'tts' | 'photo' | 'training' | 'generic';
  /** Why it's unavailable. Defaults to 'noKey'. */
  reason?: AIKeyMissingNoticeReason;
  /** 'auto' picks owner/member from PermissionContext. */
  role?: AIKeyMissingNoticeRole;
  /** 'compact' = inline pill; default = card. */
  variant?: 'card' | 'compact';
  /** Optional accent color override (defaults to indigo for noKey,
   *  amber for proxyUnavailable to visually distinguish "infrastructure"
   *  from "configuration"). */
  accent?: string;
  /** Override the inline style (e.g. margin). */
  style?: React.CSSProperties;
}

export default function AIKeyMissingNotice({
  feature,
  reason = 'noKey',
  role = 'auto',
  variant = 'card',
  accent,
  style,
}: AIKeyMissingNoticeProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isOwner } = usePermissions();

  // Default accent depends on reason — proxyUnavailable uses amber to
  // signal "something environmental is wrong" vs the indigo "you need
  // to configure something" of noKey.
  const resolvedAccent = accent ?? (reason === 'proxyUnavailable' ? '#f59e0b' : '#6366f1');

  const resolvedRole: 'owner' | 'member' = role === 'auto'
    ? (isOwner ? 'owner' : 'member')
    : role;

  // Adding a key won't fix proxyUnavailable, so we suppress the
  // owner-only CTA and treat both roles identically: pure information.
  const showCTA = reason === 'noKey' && resolvedRole === 'owner';

  // Per-feature body so the user knows WHAT is unavailable without us
  // having to write 7 wrapping copies. The headline is shared.
  const bodyKey = (() => {
    if (reason === 'proxyUnavailable') {
      // Reason swamps feature here — the message is environmental
      // ("not deployed in this environment"), independent of which
      // AI feature you tried to use. One body for all.
      return 'aiProxyNotice.body';
    }
    switch (feature) {
      case 'summary':   return resolvedRole === 'owner' ? 'aiKeyNotice.body.summaryOwner' : 'aiKeyNotice.body.summaryMember';
      case 'forecast':  return resolvedRole === 'owner' ? 'aiKeyNotice.body.forecastOwner' : 'aiKeyNotice.body.forecastMember';
      case 'insights':  return resolvedRole === 'owner' ? 'aiKeyNotice.body.insightsOwner' : 'aiKeyNotice.body.insightsMember';
      case 'comic':     return resolvedRole === 'owner' ? 'aiKeyNotice.body.comicOwner' : 'aiKeyNotice.body.comicMember';
      case 'tts':       return resolvedRole === 'owner' ? 'aiKeyNotice.body.ttsOwner' : 'aiKeyNotice.body.ttsMember';
      case 'photo':     return resolvedRole === 'owner' ? 'aiKeyNotice.body.photoOwner' : 'aiKeyNotice.body.photoMember';
      case 'training':  return resolvedRole === 'owner' ? 'aiKeyNotice.body.trainingOwner' : 'aiKeyNotice.body.trainingMember';
      default:          return resolvedRole === 'owner' ? 'aiKeyNotice.body.genericOwner' : 'aiKeyNotice.body.genericMember';
    }
  })();

  const titleKey = reason === 'proxyUnavailable' ? 'aiProxyNotice.title' : 'aiKeyNotice.title';
  const icon = reason === 'proxyUnavailable' ? '🛠️' : '🔑';

  const goToServices = () => navigate('/settings?tab=ai');

  if (variant === 'compact') {
    // Inline pill — clickable only when the CTA actually exists
    // (owner + noKey). Otherwise it's info-only.
    return (
      <span
        onClick={showCTA ? goToServices : undefined}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.3rem',
          fontSize: '0.65rem',
          padding: '0.15rem 0.5rem',
          borderRadius: '999px',
          background: `${resolvedAccent}1f`,
          color: resolvedAccent,
          border: `1px solid ${resolvedAccent}40`,
          cursor: showCTA ? 'pointer' : 'default',
          fontWeight: 500,
          whiteSpace: 'nowrap',
          ...style,
        }}
        title={showCTA ? t('aiKeyNotice.cta') : undefined}
      >
        {icon} {t(bodyKey)}
      </span>
    );
  }

  // Slim single-line card for proxyUnavailable. The body is one terse
  // line ("works on the deployed site") — a full hero card with title +
  // body + CTA would massively over-weight a localhost-dev-only signal
  // that no production user will ever see. Real-group no-key keeps the
  // full card shape below since its message has actual instructions.
  if (reason === 'proxyUnavailable') {
    return (
      <div
        style={{
          padding: '0.4rem 0.65rem',
          background: `${resolvedAccent}14`,
          border: `1px solid ${resolvedAccent}33`,
          borderRadius: '6px',
          fontSize: '0.72rem',
          color: 'var(--text-muted)',
          textAlign: 'center',
          ...style,
        }}
      >
        {icon} <span style={{ fontWeight: 600, color: 'var(--text)' }}>{t(titleKey)}</span> · {t(bodyKey)}
      </div>
    );
  }

  return (
    <div
      onClick={showCTA ? goToServices : undefined}
      style={{
        padding: '0.75rem 0.85rem',
        background: `${resolvedAccent}14`,
        border: `1px solid ${resolvedAccent}33`,
        borderRadius: '8px',
        fontSize: '0.8rem',
        color: 'var(--text)',
        textAlign: 'center',
        cursor: showCTA ? 'pointer' : 'default',
        transition: 'background 0.15s ease',
        ...style,
      }}
      onMouseEnter={(e) => {
        if (showCTA) {
          (e.currentTarget as HTMLDivElement).style.background = `${resolvedAccent}22`;
        }
      }}
      onMouseLeave={(e) => {
        if (showCTA) {
          (e.currentTarget as HTMLDivElement).style.background = `${resolvedAccent}14`;
        }
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>
        {icon} {t(titleKey)}
      </div>
      <div style={{ color: 'var(--text-muted)', lineHeight: 1.5 }}>
        {t(bodyKey)}
      </div>
      {showCTA && (
        <div
          style={{
            marginTop: '0.5rem',
            display: 'inline-block',
            padding: '0.25rem 0.65rem',
            borderRadius: '6px',
            background: resolvedAccent,
            color: '#fff',
            fontSize: '0.72rem',
            fontWeight: 600,
          }}
        >
          {t('aiKeyNotice.cta')} →
        </div>
      )}
    </div>
  );
}
