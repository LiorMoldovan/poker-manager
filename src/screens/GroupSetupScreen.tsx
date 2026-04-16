import { useState } from 'react';

interface GroupSetupScreenProps {
  userEmail: string;
  onCreateGroup: (name: string) => Promise<{ data: any; error: any }>;
  onJoinGroup: (code: string) => Promise<{ data: any; error: any }>;
  onSignOut: () => void;
}

export default function GroupSetupScreen({
  userEmail,
  onCreateGroup,
  onJoinGroup,
  onSignOut,
}: GroupSetupScreenProps) {
  const [mode, setMode] = useState<'choose' | 'create' | 'join'>('choose');
  const [groupName, setGroupName] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleCreate = async () => {
    if (!groupName.trim()) {
      setError('נא להזין שם קבוצה');
      return;
    }
    setLoading(true);
    setError('');
    const { error: err } = await onCreateGroup(groupName.trim());
    if (err) {
      setError(err.message || 'שגיאה ביצירת הקבוצה');
    }
    setLoading(false);
  };

  const handleJoin = async () => {
    const code = inviteCode.trim().toLowerCase();
    if (!code) {
      setError('נא להזין קוד הזמנה');
      return;
    }
    setLoading(true);
    setError('');
    const { error: err } = await onJoinGroup(code);
    if (err) {
      setError(
        err.message?.includes('Invalid invite')
          ? 'קוד הזמנה לא תקין'
          : err.message || 'שגיאה בהצטרפות'
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
      <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
        <div style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>🃏</div>
        <h1 style={{
          fontSize: '1.4rem',
          fontWeight: 700,
          color: 'var(--text)',
          marginBottom: '0.25rem',
        }}>
          {mode === 'choose' && 'ברוך הבא!'}
          {mode === 'create' && 'צור קבוצה חדשה'}
          {mode === 'join' && 'הצטרף לקבוצה'}
        </h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
          {mode === 'choose' && 'כדי להתחיל, צור קבוצה או הצטרף לקיימת'}
          {mode === 'create' && 'תן שם לקבוצת הפוקר שלך'}
          {mode === 'join' && 'הזן את קוד ההזמנה שקיבלת מהמנהל'}
        </p>
      </div>

      {mode === 'choose' && (
        <div style={{ width: '100%', maxWidth: '320px', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {error && <p style={errorStyle}>{error}</p>}

          <button onClick={() => setMode('create')} style={cardButtonStyle}>
            <span style={{ fontSize: '1.5rem' }}>👑</span>
            <div>
              <div style={{ fontWeight: 600, fontSize: '1rem', color: 'var(--text)' }}>צור קבוצה</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                אתה מנהל הקבוצה — הזמן שחקנים
              </div>
            </div>
          </button>

          <button onClick={() => setMode('join')} style={cardButtonStyle}>
            <span style={{ fontSize: '1.5rem' }}>🤝</span>
            <div>
              <div style={{ fontWeight: 600, fontSize: '1rem', color: 'var(--text)' }}>הצטרף לקבוצה</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '2px' }}>
                יש לך קוד הזמנה מחבר
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
            placeholder="למשל: פוקר יום חמישי"
            autoFocus
            dir="rtl"
            style={inputStyle}
          />

          {error && <p style={errorStyle}>{error}</p>}

          <button
            onClick={handleCreate}
            disabled={loading}
            style={{ ...actionButtonStyle, opacity: loading ? 0.6 : 1, cursor: loading ? 'not-allowed' : 'pointer' }}
          >
            {loading ? '...' : 'צור קבוצה'}
          </button>

          <button onClick={() => { setMode('choose'); setError(''); }} style={backLinkStyle}>
            חזרה
          </button>
        </div>
      )}

      {mode === 'join' && (
        <div style={{ width: '100%', maxWidth: '320px' }}>
          <input
            type="text"
            value={inviteCode}
            onChange={e => setInviteCode(e.target.value)}
            placeholder="קוד הזמנה (6 תווים)"
            autoFocus
            dir="ltr"
            maxLength={6}
            style={{ ...inputStyle, textAlign: 'center', letterSpacing: '4px', fontSize: '1.3rem', fontWeight: 600 }}
          />

          {error && <p style={errorStyle}>{error}</p>}

          <button
            onClick={handleJoin}
            disabled={loading}
            style={{ ...actionButtonStyle, opacity: loading ? 0.6 : 1, cursor: loading ? 'not-allowed' : 'pointer' }}
          >
            {loading ? '...' : 'הצטרף'}
          </button>

          <button onClick={() => { setMode('choose'); setError(''); }} style={backLinkStyle}>
            חזרה
          </button>
        </div>
      )}

      {/* Signed in as + sign out */}
      <div style={{ marginTop: '2.5rem', textAlign: 'center' }}>
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
          התנתק
        </button>
      </div>
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
  direction: 'rtl',
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
  textAlign: 'right',
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
