import { useState } from 'react';
import { APP_VERSION } from '../version';

interface AuthScreenProps {
  onSignIn: (email: string, password: string) => Promise<{ error: any }>;
  onSignUp: (email: string, password: string) => Promise<{ data: any; error: any }>;
}

export default function AuthScreen({ onSignIn, onSignUp }: AuthScreenProps) {
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
      setError(mode === 'login' ? 'נא להזין אימייל וסיסמה' : 'נא למלא את כל השדות');
      return;
    }

    if (mode === 'signup') {
      if (password.length < 6) {
        setError('הסיסמה חייבת להכיל לפחות 6 תווים');
        return;
      }
      if (password !== confirmPassword) {
        setError('הסיסמאות לא תואמות');
        return;
      }
    }

    setLoading(true);

    if (mode === 'login') {
      const { error: err } = await onSignIn(email.trim(), password);
      if (err) {
        setError(
          err.message === 'Invalid login credentials'
            ? 'אימייל או סיסמה שגויים'
            : err.message
        );
      }
    } else {
      const { error: err } = await onSignUp(email.trim(), password);
      if (err) {
        setError(
          err.message?.includes('already registered')
            ? 'האימייל הזה כבר רשום — נסה להתחבר'
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
            בדוק את האימייל
          </h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: '1.5rem' }}>
            שלחנו לינק אימות ל-<br />
            <strong style={{ color: 'var(--primary)' }}>{email}</strong><br />
            לחץ על הלינק ואז חזור להתחבר.
          </p>
          <button
            onClick={() => { setSignupSuccess(false); setMode('login'); setPassword(''); setConfirmPassword(''); }}
            style={{ ...buttonStyle, background: 'var(--primary)', color: 'white', cursor: 'pointer' }}
          >
            חזרה להתחברות
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
          Poker Manager
        </h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: '0.25rem' }}>
          {mode === 'login' ? 'התחבר לחשבון שלך' : 'צור חשבון חדש'}
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
            {m === 'login' ? 'התחברות' : 'הרשמה'}
          </button>
        ))}
      </div>

      {/* Form */}
      <div style={{ width: '100%', maxWidth: '320px' }}>
        <input
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="אימייל"
          autoComplete="email"
          dir="ltr"
          style={inputStyle}
        />

        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="סיסמה"
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          dir="ltr"
          style={inputStyle}
        />

        {mode === 'signup' && (
          <input
            type="password"
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            placeholder="אימות סיסמה"
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
            direction: 'rtl',
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
          {loading ? '...' : mode === 'login' ? 'התחבר' : 'צור חשבון'}
        </button>
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
  direction: 'rtl',
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
