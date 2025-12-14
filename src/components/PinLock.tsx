import { useState, useEffect } from 'react';

interface PinLockProps {
  correctPin: string;
  onUnlock: () => void;
}

const PinLock = ({ correctPin, onUnlock }: PinLockProps) => {
  const [pin, setPin] = useState('');
  const [error, setError] = useState(false);
  const [shake, setShake] = useState(false);

  useEffect(() => {
    // Check if already authenticated this session
    if (sessionStorage.getItem('poker_authenticated') === 'true') {
      onUnlock();
    }
  }, [onUnlock]);

  const handleKeyPress = (digit: string) => {
    if (pin.length < 4) {
      const newPin = pin + digit;
      setPin(newPin);
      setError(false);
      
      // Auto-submit when 4 digits entered
      if (newPin.length === 4) {
        if (newPin === correctPin) {
          sessionStorage.setItem('poker_authenticated', 'true');
          onUnlock();
        } else {
          setError(true);
          setShake(true);
          setTimeout(() => {
            setPin('');
            setShake(false);
          }, 500);
        }
      }
    }
  };

  const handleDelete = () => {
    setPin(pin.slice(0, -1));
    setError(false);
  };

  const handleClear = () => {
    setPin('');
    setError(false);
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--background)',
      padding: '2rem'
    }}>
      {/* Logo/Title */}
      <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
        <div style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>🃏</div>
        <h1 style={{ 
          fontSize: '1.5rem', 
          fontWeight: '700',
          background: 'linear-gradient(135deg, var(--primary), var(--secondary))',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
          backgroundClip: 'text'
        }}>
          Poker Manager
        </h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: '0.25rem' }}>
          Enter PIN to continue
        </p>
      </div>

      {/* PIN dots */}
      <div style={{
        display: 'flex',
        gap: '1rem',
        marginBottom: '2rem',
        animation: shake ? 'shake 0.5s ease-in-out' : 'none'
      }}>
        {[0, 1, 2, 3].map(i => (
          <div
            key={i}
            style={{
              width: '20px',
              height: '20px',
              borderRadius: '50%',
              border: `2px solid ${error ? '#ef4444' : 'var(--primary)'}`,
              background: i < pin.length 
                ? (error ? '#ef4444' : 'var(--primary)') 
                : 'transparent',
              transition: 'all 0.15s ease'
            }}
          />
        ))}
      </div>

      {/* Error message */}
      {error && (
        <p style={{ 
          color: '#ef4444', 
          fontSize: '0.875rem', 
          marginBottom: '1rem',
          fontWeight: '500'
        }}>
          Incorrect PIN
        </p>
      )}

      {/* Keypad */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: '0.75rem',
        maxWidth: '280px',
        width: '100%'
      }}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map(key => (
          <button
            key={key}
            onClick={() => {
              if (key === 'C') handleClear();
              else if (key === '⌫') handleDelete();
              else handleKeyPress(key);
            }}
            style={{
              padding: '1.25rem',
              fontSize: '1.5rem',
              fontWeight: '600',
              borderRadius: '12px',
              border: 'none',
              background: key === 'C' || key === '⌫' ? 'var(--surface)' : 'var(--surface-light)',
              color: key === 'C' ? '#ef4444' : 'var(--text)',
              cursor: 'pointer',
              transition: 'all 0.15s ease'
            }}
          >
            {key}
          </button>
        ))}
      </div>

      {/* Shake animation */}
      <style>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          20%, 60% { transform: translateX(-10px); }
          40%, 80% { transform: translateX(10px); }
        }
      `}</style>
    </div>
  );
};

export default PinLock;

