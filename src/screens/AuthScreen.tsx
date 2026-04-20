import { useState } from 'react';
import { APP_VERSION } from '../version';
import { useTranslation } from '../i18n';

interface AuthScreenProps {
  onSignIn: (email: string, password: string) => Promise<{ error: any }>;
  onSignUp: (email: string, password: string) => Promise<{ data: any; error: any }>;
  onGoogleSignIn?: () => Promise<{ error: any }>;
}

export default function AuthScreen({ onSignIn, onSignUp, onGoogleSignIn }: AuthScreenProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [signupSuccess, setSignupSuccess] = useState(false);

  const handleSubmit = async () => {
    setError('');

    if (!email.trim() || !password) {
      setError(mode === 'login' ? t('auth.emptyFields') : t('auth.emptySignup'));
      return;
    }

    if (mode === 'signup') {
      if (password.length < 6) {
        setError(t('auth.shortPassword'));
        return;
      }
      if (password !== confirmPassword) {
        setError(t('auth.mismatch'));
        return;
      }
    }

    setLoading(true);

    if (mode === 'login') {
      const { error: err } = await onSignIn(email.trim(), password);
      if (err) {
        setError(
          err.message === 'Invalid login credentials'
            ? t('auth.invalidCreds')
            : err.message
        );
      }
    } else {
      const { error: err } = await onSignUp(email.trim(), password);
      if (err) {
        setError(
          err.message?.includes('already registered')
            ? t('auth.alreadyRegistered')
            : err.message
        );
      } else {
        setSignupSuccess(true);
      }
    }

    setLoading(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !loading) handleSubmit();
  };

  if (signupSuccess) {
    return (
      <div style={containerStyle}>
        <div style={{ textAlign: 'center', maxWidth: '320px' }}>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>📧</div>
          <h2 style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--text)', marginBottom: '0.75rem' }}>
            {t('auth.checkEmail')}
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: '1.5rem' }}>
            {t('auth.verifyMsg')}<br />
            <strong style={{ color: 'var(--primary)' }}>{email}</strong><br />
            {t('auth.verifyAction')}
          </p>
          <button
            onClick={() => { setSignupSuccess(false); setMode('login'); setPassword(''); setConfirmPassword(''); }}
            style={{ ...buttonStyle, background: 'var(--primary)', color: 'white', cursor: 'pointer' }}
          >
            {t('auth.backToLogin')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle} onKeyDown={handleKeyDown}>
      <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
        <div style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>🃏</div>
        <h1 style={{
          fontSize: '1.5rem',
          fontWeight: 700,
          background: 'linear-gradient(135deg, var(--primary), var(--secondary))',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text',
        }}>
          {t('auth.title')}
        </h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: '0.25rem' }}>
          {mode === 'login' ? t('auth.loginSubtitle') : t('auth.signupSubtitle')}
        </p>
      </div>

      {/* Mode Toggle */}
      <div style={{
        display: 'flex',
        background: 'var(--surface)',
        borderRadius: '10px',
        padding: '3px',
        marginBottom: '1.5rem',
        width: '100%',
        maxWidth: '320px',
      }}>
        {(['login', 'signup'] as const).map(m => (
          <button
            key={m}
            onClick={() => { setMode(m); setError(''); }}
            style={{
              flex: 1,
              padding: '0.6rem',
              fontSize: '0.9rem',
              fontWeight: 600,
              borderRadius: '8px',
              border: 'none',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
              background: mode === m ? 'var(--primary)' : 'transparent',
              color: mode === m ? 'white' : 'var(--text-muted)',
            }}
          >
            {m === 'login' ? t('auth.login') : t('auth.signup')}
          </button>
        ))}
      </div>

      {/* Form */}
      <div style={{ width: '100%', maxWidth: '320px' }}>
        <input
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder={t('auth.email')}
          autoComplete="email"
          dir="ltr"
          style={inputStyle}
        />

        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder={t('auth.password')}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          dir="ltr"
          style={inputStyle}
        />

        {mode === 'signup' && (
          <input
            type="password"
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            placeholder={t('auth.confirmPassword')}
            autoComplete="new-password"
            dir="ltr"
            style={inputStyle}
          />
        )}

        {error && (
          <p style={{
            color: '#ef4444',
            fontSize: '0.85rem',
            fontWeight: 500,
            textAlign: 'center',
            marginBottom: '0.75rem',
          }}>
            {error}
          </p>
        )}

        <button
          onClick={handleSubmit}
          disabled={loading}
          style={{
            ...buttonStyle,
            background: loading ? 'var(--surface-light)' : 'var(--primary)',
            color: loading ? 'var(--text-muted)' : 'white',
            cursor: loading ? 'not-allowed' : 'pointer',
          }}
        >
          {loading ? '...' : mode === 'login' ? t('auth.loginButton') : t('auth.signupButton')}
        </button>

        {onGoogleSignIn && (
          <>
            <div style={{
              display: 'flex', alignItems: 'center', gap: '0.75rem',
              margin: '1.25rem 0', color: 'var(--text-muted)', fontSize: '0.8rem',
            }}>
              <div style={{ flex: 1, height: '1px', background: 'var(--border)' }} />
              <span>{t('common.or')}</span>
              <div style={{ flex: 1, height: '1px', background: 'var(--border)' }} />
            </div>

            <button
              onClick={() => { setError(''); onGoogleSignIn(); }}
              disabled={loading}
              style={{
                ...buttonStyle,
                background: 'white',
                color: '#333',
                cursor: loading ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem',
                border: '2px solid var(--border)',
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              {t('auth.google')}
            </button>
          </>
        )}
      </div>

      <div style={{ marginTop: '2rem', color: 'var(--text-muted)', fontSize: '0.75rem' }}>
        v{APP_VERSION}
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
  textAlign: 'left',
};

const buttonStyle: React.CSSProperties = {
  width: '100%',
  padding: '0.85rem',
  fontSize: '1rem',
  fontWeight: 600,
  borderRadius: '10px',
  border: 'none',
  fontFamily: 'Outfit, sans-serif',
  transition: 'all 0.2s ease',
};
