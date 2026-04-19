import { useState } from 'react';
import { useTranslation } from '../i18n';

interface GroupSetupScreenProps {
  userEmail: string;
  onCreateGroup: (name: string) => Promise<{ data: any; error: any }>;
  onJoinGroup: (code: string) => Promise<{ data: any; error: any }>;
  onJoinByPlayerInvite: (code: string) => Promise<{ data: any; error: any }>;
  onSignOut: () => void;
  onContinue?: () => void;
  onClose?: () => void;
  initialMode?: 'choose' | 'create' | 'join';
}

export default function GroupSetupScreen({
  userEmail,
  onCreateGroup,
  onJoinGroup,
  onJoinByPlayerInvite,
  onSignOut,
  onContinue,
  onClose,
  initialMode = 'choose',
}: GroupSetupScreenProps) {
  const { t, isRTL } = useTranslation();
  const [mode, setMode] = useState<'choose' | 'create' | 'join' | 'created'>(initialMode);
  const [groupName, setGroupName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [createdInviteCode, setCreatedInviteCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCreate = async () => {
    if (!groupName.trim()) {
      setError(t('groupSetup.emptyName'));
      return;
    }
    setLoading(true);
    setError('');
    const { data, error: err } = await onCreateGroup(groupName.trim());
    if (err) {
      setError(err.message || t('groupSetup.createError'));
    } else {
      const code = data?.invite_code || '';
      setCreatedInviteCode(code);
      setMode('created');
    }
    setLoading(false);
  };

  const handleJoin = async () => {
    const code = inviteCode.trim().toLowerCase();
    if (!code) {
      setError(t('groupSetup.emptyCode'));
      return;
    }
    setLoading(true);
    setError('');

    // Try personal invite first (8 chars), then generic (6 chars)
    const { data: personalData } = await onJoinByPlayerInvite(code);
    if (personalData) {
      // Personal invite succeeded — player already linked, proceed
      setLoading(false);
      return;
    }

    // Fall back to generic group invite
    const { error: err } = await onJoinGroup(code);
    if (err) {
      setError(
        err.message?.includes('Invalid invite')
          ? t('groupSetup.invalidCode')
          : err.message || t('groupSetup.joinError')
      );
    }
    setLoading(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !loading) {
      if (mode === 'create') handleCreate();
      if (mode === 'join') handleJoin();
    }
  };

  return (
    <div style={containerStyle} onKeyDown={handleKeyDown}>
      {onClose && (
        <button
          onClick={onClose}
          style={{
            position: 'absolute', top: '1rem', right: '1rem',
            background: 'none', border: 'none', color: 'var(--text-muted)',
            fontSize: '1.5rem', cursor: 'pointer', padding: '0.25rem',
            lineHeight: 1, fontFamily: 'Outfit, sans-serif',
          }}
        >
          ✕
        </button>
      )}
      <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
        <div style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>🃏</div>
        <h1 style={{
          fontSize: '1.4rem',
          fontWeight: 700,
          color: 'var(--text)',
          marginBottom: '0.25rem',
        }}>
          {mode === 'choose' && t('groupSetup.welcome')}
          {mode === 'create' && t('groupSetup.createTitle')}
          {mode === 'join' && t('groupSetup.joinTitle')}
          {mode === 'created' && groupName}
        </h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
          {mode === 'choose' && t('groupSetup.subtitle')}
          {mode === 'create' && t('groupSetup.createSubtitle')}
          {mode === 'join' && t('groupSetup.joinSubtitle')}
          {mode === 'created' && t('groupSetup.inviteCode')}
        </p>
      </div>

      {mode === 'choose' && (
        <div style={{ width: '100%', maxWidth: '320px', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {error && <p style={errorStyle}>{error}</p>}

          <button onClick={() => setMode('create')} style={{ ...cardButtonStyle, textAlign: isRTL ? 'right' : 'left' }}>
            <span style={{ fontSize: '1.5rem' }}>👑</span>
            <div>
              <div style={{ fontWeight: 600, fontSize: '1rem', color: 'var(--text)' }}>{t('groupSetup.createCard')}</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                {t('groupSetup.createCardDesc')}
              </div>
            </div>
          </button>

          <button onClick={() => setMode('join')} style={{ ...cardButtonStyle, textAlign: isRTL ? 'right' : 'left' }}>
            <span style={{ fontSize: '1.5rem' }}>🤝</span>
            <div>
              <div style={{ fontWeight: 600, fontSize: '1rem', color: 'var(--text)' }}>{t('groupSetup.joinCard')}</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                {t('groupSetup.joinCardDesc')}
              </div>
            </div>
          </button>
        </div>
      )}

      {mode === 'create' && (
        <div style={{ width: '100%', maxWidth: '320px' }}>
          <input
            type="text"
            value={groupName}
            onChange={e => setGroupName(e.target.value)}
            placeholder={t('groupSetup.namePlaceholder')}
            autoFocus
            dir={isRTL ? 'rtl' : 'ltr'}
            style={inputStyle}
          />

          {error && <p style={errorStyle}>{error}</p>}

          <button
            onClick={handleCreate}
            disabled={loading}
            style={{ ...actionButtonStyle, opacity: loading ? 0.6 : 1, cursor: loading ? 'not-allowed' : 'pointer' }}
          >
            {loading ? '...' : t('groupSetup.createButton')}
          </button>

          <button onClick={() => { setMode('choose'); setError(''); }} style={backLinkStyle}>
            {t('common.back')}
          </button>
        </div>
      )}

      {mode === 'join' && (
        <div style={{ width: '100%', maxWidth: '320px' }}>
          <input
            type="text"
            value={inviteCode}
            onChange={e => setInviteCode(e.target.value)}
            placeholder={t('groupSetup.codePlaceholder')}
            autoFocus
            dir="ltr"
            maxLength={8}
            style={{ ...inputStyle, textAlign: 'center', letterSpacing: '4px', fontSize: '1.3rem', fontWeight: 600 }}
          />

          {error && <p style={errorStyle}>{error}</p>}

          <button
            onClick={handleJoin}
            disabled={loading}
            style={{ ...actionButtonStyle, opacity: loading ? 0.6 : 1, cursor: loading ? 'not-allowed' : 'pointer' }}
          >
            {loading ? '...' : t('groupSetup.joinButton')}
          </button>

          <button onClick={() => { setMode('choose'); setError(''); }} style={backLinkStyle}>
            {t('common.back')}
          </button>
        </div>
      )}

      {mode === 'created' && (
        <div style={{ width: '100%', maxWidth: '320px', textAlign: 'center' }}>
          <div style={{
            background: 'rgba(16, 185, 129, 0.1)',
            border: '1px solid rgba(16, 185, 129, 0.3)',
            borderRadius: '12px',
            padding: '1.25rem',
            marginBottom: '1.25rem',
          }}>
            <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>✅</div>
            <p style={{ color: '#10B981', fontWeight: 600, fontSize: '1rem', marginBottom: '0.5rem' }}>
              {t('groupSetup.created')}
            </p>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '1rem' }}>
              {t('groupSetup.shareCode')}
            </p>
            <div style={{
              background: 'var(--surface)',
              border: '2px dashed var(--border)',
              borderRadius: '10px',
              padding: '0.75rem',
              letterSpacing: '6px',
              fontSize: '1.6rem',
              fontWeight: 700,
              color: 'var(--text)',
              fontFamily: 'monospace',
              direction: 'ltr',
            }}>
              {createdInviteCode}
            </div>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
            <button
              onClick={() => {
                navigator.clipboard.writeText(createdInviteCode);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              style={{
                ...actionButtonStyle,
                flex: 1,
                background: copied ? '#10B981' : 'var(--surface)',
                color: copied ? 'white' : 'var(--text)',
                border: '1px solid var(--border)',
              }}
            >
              {copied ? t('groupSetup.copied') : t('groupSetup.copyCode')}
            </button>
            {typeof navigator.share === 'function' && (
              <button
                onClick={() => {
                  navigator.share({
                    title: t('groupSetup.shareJoinTitle', { name: groupName }),
                    text: t('groupSetup.shareJoinText', { code: createdInviteCode }),
                  }).catch(() => {});
                }}
                style={{
                  ...actionButtonStyle,
                  flex: 1,
                  background: 'var(--surface)',
                  color: 'var(--text)',
                  border: '1px solid var(--border)',
                }}
              >
                {t('common.share')}
              </button>
            )}
          </div>

          <button
            onClick={onContinue}
            style={actionButtonStyle}
          >
            {t('groupSetup.continue')}
          </button>
        </div>
      )}

      {/* Already added by admin? */}
      {(mode === 'choose' || mode === 'join') && (
        <div style={{
          marginTop: '2rem', padding: '1rem', borderRadius: '10px',
          background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.15)',
          textAlign: 'center', maxWidth: '320px', width: '100%',
        }}>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: '0.75rem' }}>
            {t('groupSetup.noCode')}
          </p>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              onClick={() => {
                const addLink = `${window.location.origin}?addMember=${encodeURIComponent(userEmail)}`;
                const msg = `היי, נרשמתי לאפליקציית הפוקר 🃏\nאפשר להוסיף אותי לקבוצה?\n\nלחץ כאן להוספה מהירה:\n${addLink}`;
                if (typeof navigator.share === 'function') {
                  navigator.share({ text: msg }).catch(() => {});
                } else {
                  const waUrl = `https://wa.me/?text=${encodeURIComponent(msg)}`;
                  window.open(waUrl, '_blank');
                }
              }}
              style={{
                flex: 1, padding: '0.5rem', borderRadius: '8px', border: 'none',
                background: '#25D366', color: 'white', cursor: 'pointer',
                fontSize: '0.8rem', fontFamily: 'Outfit, sans-serif', fontWeight: 600,
              }}
            >
              {t('groupSetup.sendRequest')}
            </button>
            <button
              onClick={onContinue}
              style={{
                flex: 1, padding: '0.5rem', borderRadius: '8px',
                background: 'none', border: '1px solid var(--border)',
                color: 'var(--text)', cursor: 'pointer',
                fontSize: '0.8rem', fontFamily: 'Outfit, sans-serif',
              }}
            >
              {t('groupSetup.checkAgain')}
            </button>
          </div>
        </div>
      )}

      {/* Signed in as + sign out (hidden in modal mode) */}
      {!onClose && (
        <div style={{ marginTop: '1.5rem', textAlign: 'center' }}>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginBottom: '0.5rem' }}>
            {userEmail}
          </p>
          <button onClick={onSignOut} style={{
            background: 'none',
            border: 'none',
            color: '#ef4444',
            fontSize: '0.8rem',
            cursor: 'pointer',
            fontFamily: 'Outfit, sans-serif',
            textDecoration: 'underline',
          }}>
            {t('common.signOut')}
          </button>
        </div>
      )}
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--background)',
  padding: '2rem',
  position: 'relative',
};

const cardButtonStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '1rem',
  padding: '1.25rem',
  borderRadius: '12px',
  border: '2px solid var(--border)',
  background: 'var(--surface)',
  cursor: 'pointer',
  transition: 'all 0.2s ease',
  fontFamily: 'Outfit, sans-serif',
  width: '100%',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.85rem 1rem',
  fontSize: '1rem',
  borderRadius: '10px',
  border: '2px solid var(--border)',
  background: 'var(--surface)',
  color: 'var(--text)',
  marginBottom: '0.75rem',
  boxSizing: 'border-box',
  outline: 'none',
  fontFamily: 'Outfit, sans-serif',
};

const errorStyle: React.CSSProperties = {
  color: '#ef4444',
  fontSize: '0.85rem',
  fontWeight: 500,
  textAlign: 'center',
  marginBottom: '0.75rem',
};

const actionButtonStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.85rem',
  fontSize: '1rem',
  fontWeight: 600,
  borderRadius: '10px',
  border: 'none',
  background: 'var(--primary)',
  color: 'white',
  fontFamily: 'Outfit, sans-serif',
  transition: 'all 0.2s ease',
};

const backLinkStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  marginTop: '0.75rem',
  background: 'none',
  border: 'none',
  color: 'var(--text-muted)',
  fontSize: '0.85rem',
  cursor: 'pointer',
  fontFamily: 'Outfit, sans-serif',
  textAlign: 'center',
};
