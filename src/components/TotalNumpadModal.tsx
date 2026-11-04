import { useState, useEffect } from 'react';
import { useTranslation } from '../i18n';

export interface TotalNumpadModalProps {
  isOpen: boolean;
  playerName: string;
  currentValue: number;
  valuePerChip: number;       // chip → money rate
  playerBuyinTotal: number;   // rebuys × rebuyValue, for the live profit hint
  formatMoney: (n: number) => string;
  onConfirm: (value: number) => void;
  onClose: () => void;
  /** Optional subtitle shown below the title (e.g. for early exit in LiveGameScreen) */
  subtitle?: string;
  /** Optional callback to revert an early exit back to active play */
  onCancelEarlyExit?: () => void;
}

export const TotalNumpadModal = ({
  isOpen,
  playerName,
  currentValue,
  valuePerChip,
  playerBuyinTotal,
  formatMoney,
  onConfirm,
  onClose,
  subtitle,
  onCancelEarlyExit,
}: TotalNumpadModalProps) => {
  const { t } = useTranslation();
  const [value, setValue] = useState(currentValue.toString());

  useEffect(() => {
    if (isOpen) setValue(currentValue.toString());
  }, [isOpen, currentValue]);

  if (!isOpen) return null;

  const handleKey = (key: string) => {
    if (key === 'C') setValue('0');
    else if (key === '⌫') setValue(prev => (prev.length > 1 ? prev.slice(0, -1) : '0'));
    else setValue(prev => (prev === '0' ? key : prev + key));
  };

  const numericValue = parseInt(value) || 0;
  const moneyEquivalent = numericValue * valuePerChip;
  const profit = moneyEquivalent - playerBuyinTotal;
  const profitColor =
    profit > 0 ? 'var(--success)'
    : profit < 0 ? 'var(--danger)'
    : 'var(--text-muted)';
  const profitSign = profit > 0 ? '+' : '';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '320px' }}>
        <div style={{
          background: 'var(--primary)',
          margin: '-1.5rem -1.5rem 1rem -1.5rem',
          padding: '0.75rem 1rem',
          borderRadius: '16px 16px 0 0',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.5rem',
        }}>
          <span style={{ minWidth: '2rem', display: 'inline-block' }} />
          <span style={{ color: 'white', fontWeight: 700, fontSize: '1.1rem', flex: 1, textAlign: 'center' }}>
            {playerName}
          </span>
          <span style={{ minWidth: '2rem', display: 'inline-block' }} />
        </div>

        <div className="modal-header" style={{ marginBottom: subtitle ? '0.25rem' : '0.5rem' }}>
          <h3 className="modal-title">{t('chips.entryMode.totalNumpadTitle')}</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        {subtitle && (
          <div style={{
            fontSize: '0.75rem',
            color: 'var(--text-muted)',
            marginBottom: '0.6rem',
            lineHeight: 1.35,
          }}>
            {subtitle}
          </div>
        )}

        <div style={{
          fontSize: '2.5rem',
          fontWeight: 700,
          textAlign: 'center',
          padding: '1rem',
          background: 'var(--surface)',
          borderRadius: '8px',
          marginBottom: '0.4rem',
          fontFamily: 'monospace',
        }}>
          {numericValue.toLocaleString('he-IL')}
        </div>

        <div style={{
          textAlign: 'center',
          marginBottom: '1rem',
          fontSize: '0.85rem',
          fontWeight: 600,
          direction: 'ltr',
        }}>
          <span style={{ color: 'var(--text-muted)' }}>
            {formatMoney(moneyEquivalent)} − {formatMoney(playerBuyinTotal)} =
          </span>
          {' '}
          <span style={{ color: profitColor }}>
            {profitSign}{formatMoney(profit)}
          </span>
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '0.5rem',
          marginBottom: '1rem',
          direction: 'ltr',
        }}>
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map(key => (
            <button
              key={key}
              onClick={() => handleKey(key)}
              style={{
                padding: '1rem',
                fontSize: '1.5rem',
                fontWeight: 600,
                borderRadius: '8px',
                border: 'none',
                background: key === 'C' ? 'var(--danger)' : key === '⌫' ? 'var(--warning)' : 'var(--surface)',
                color: key === 'C' || key === '⌫' ? 'white' : 'var(--text)',
                cursor: 'pointer',
              }}
            >
              {key}
            </button>
          ))}
        </div>

        <button
          className="btn btn-primary btn-block"
          onClick={() => onConfirm(numericValue)}
        >
          {t('chips.done')}
        </button>

        {onCancelEarlyExit && (
          <button
            type="button"
            className="btn btn-secondary btn-block"
            onClick={onCancelEarlyExit}
            style={{
              marginTop: '0.5rem',
              fontSize: '0.8rem',
              padding: '0.55rem',
              color: '#fca5a5',
              borderColor: 'rgba(239, 68, 68, 0.35)',
              background: 'rgba(239, 68, 68, 0.08)',
            }}
          >
            ↩️ החזר שחקן למשחק (בטל סיום)
          </button>
        )}
      </div>
    </div>
  );
};

