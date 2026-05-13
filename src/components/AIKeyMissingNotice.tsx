import { useNavigate } from 'react-router-dom';
import { useTranslation } from '../i18n';
import { usePermissions } from '../App';

// Friendly empty-state notice rendered wherever an AI feature can't run
// for the current group because no Gemini key is configured. Two visual
// modes:
//   - default: a small card with a title + body + (owner only) a CTA
//     button that navigates to Settings → Services → API Keys.
//   - compact: a single inline pill, used on dense surfaces like the
//     LiveGameScreen subtitle where a full card would crowd the layout.
//
// Two role variants:
//   - owner: actionable copy ("set up a key here"), CTA visible.
//   - member: informational copy ("ask the group owner"), no CTA.
//
// We deliberately do NOT auto-detect role inside this component because
// some surfaces (LiveGameScreen TTS) want the same compact notice for
// everyone. The caller decides via the `role` prop.

export type AIKeyMissingNoticeRole = 'owner' | 'member' | 'auto';

export interface AIKeyMissingNoticeProps {
  /** What feature is unavailable (used in the body copy). */
  feature: 'summary' | 'forecast' | 'insights' | 'comic' | 'tts' | 'photo' | 'training' | 'generic';
  /** 'auto' picks owner/member from PermissionContext. */
  role?: AIKeyMissingNoticeRole;
  /** 'compact' = inline pill; default = card. */
  variant?: 'card' | 'compact';
  /** Optional accent color override (defaults to indigo). */
  accent?: string;
  /** Override the inline style (e.g. margin). */
  style?: React.CSSProperties;
}

export default function AIKeyMissingNotice({
  feature,
  role = 'auto',
  variant = 'card',
  accent = '#6366f1',
  style,
}: AIKeyMissingNoticeProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isOwner } = usePermissions();

  const resolvedRole: 'owner' | 'member' = role === 'auto'
    ? (isOwner ? 'owner' : 'member')
    : role;

  // Per-feature body so the user knows WHAT is unavailable without us
  // having to write 7 wrapping copies. The headline is shared.
  const bodyKey = (() => {
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

  const goToServices = () => navigate('/settings?tab=ai');

  if (variant === 'compact') {
    // Inline pill — the whole pill is clickable for owners, info-only
    // for members. Keeps line-height tight enough to live next to a
    // page subtitle without breaking the layout.
    return (
      <span
        onClick={resolvedRole === 'owner' ? goToServices : undefined}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.3rem',
          fontSize: '0.65rem',
          padding: '0.15rem 0.5rem',
          borderRadius: '999px',
          background: `${accent}1f`, // ~12% alpha
          color: accent,
          border: `1px solid ${accent}40`,
          cursor: resolvedRole === 'owner' ? 'pointer' : 'default',
          fontWeight: 500,
          whiteSpace: 'nowrap',
          ...style,
        }}
        title={resolvedRole === 'owner' ? t('aiKeyNotice.cta') : undefined}
      >
        🔑 {t(bodyKey)}
      </span>
    );
  }

  // Default: card variant. Whole card is the click target for owners.
  return (
    <div
      onClick={resolvedRole === 'owner' ? goToServices : undefined}
      style={{
        padding: '0.75rem 0.85rem',
        background: `${accent}14`, // ~8% alpha
        border: `1px solid ${accent}33`,
        borderRadius: '8px',
        fontSize: '0.8rem',
        color: 'var(--text)',
        textAlign: 'center',
        cursor: resolvedRole === 'owner' ? 'pointer' : 'default',
        transition: 'background 0.15s ease',
        ...style,
      }}
      onMouseEnter={(e) => {
        if (resolvedRole === 'owner') {
          (e.currentTarget as HTMLDivElement).style.background = `${accent}22`;
        }
      }}
      onMouseLeave={(e) => {
        if (resolvedRole === 'owner') {
          (e.currentTarget as HTMLDivElement).style.background = `${accent}14`;
        }
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>
        🔑 {t('aiKeyNotice.title')}
      </div>
      <div style={{ color: 'var(--text-muted)', lineHeight: 1.5 }}>
        {t(bodyKey)}
      </div>
      {resolvedRole === 'owner' && (
        <div
          style={{
            marginTop: '0.5rem',
            display: 'inline-block',
            padding: '0.25rem 0.65rem',
            borderRadius: '6px',
            background: accent,
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
