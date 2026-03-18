import { useState, useEffect, useRef } from 'react';
import { getEstimatedDuration } from '../utils/aiTiming';

const AIProgressBar = ({ operationKey }: { operationKey: string }) => {
  const [progress, setProgress] = useState(0);
  const [timeLeft, setTimeLeft] = useState(0);
  const startRef = useRef(Date.now());
  const estimateRef = useRef(getEstimatedDuration(operationKey));

  useEffect(() => {
    const baseEstimate = estimateRef.current;
    setTimeLeft(baseEstimate);

    const interval = setInterval(() => {
      const elapsed = (Date.now() - startRef.current) / 1000;

      // Dynamic extension: if we've passed the estimate, stretch the curve
      // so the bar keeps moving slowly instead of freezing near 95%
      let effective = baseEstimate;
      if (elapsed > baseEstimate) {
        effective = baseEstimate + (elapsed - baseEstimate) * 0.7;
      }

      const p = 92 * (1 - Math.exp(-2 * elapsed / effective));
      setProgress(Math.min(p, 97));

      const remaining = Math.max(0, Math.ceil(effective - elapsed));
      setTimeLeft(remaining);
    }, 300);

    return () => clearInterval(interval);
  }, []);

  return (
    <div style={{ width: '100%', marginTop: '0.75rem' }}>
      <div style={{
        width: '100%',
        height: '4px',
        borderRadius: '2px',
        background: 'var(--surface-light)',
        overflow: 'hidden',
      }}>
        <div style={{
          width: `${progress}%`,
          height: '100%',
          borderRadius: '2px',
          background: 'linear-gradient(90deg, #A855F7, #EC4899)',
          transition: 'width 0.3s ease-out',
        }} />
      </div>
      <div style={{
        textAlign: 'center',
        fontSize: '0.7rem',
        color: 'var(--text-muted)',
        marginTop: '0.35rem',
        direction: 'rtl',
      }}>
        {timeLeft > 0 ? `~${timeLeft} שניות` : 'כמעט שם...'}
      </div>
    </div>
  );
};

export default AIProgressBar;
