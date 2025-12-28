import { useState } from 'react';
import { GamePlayer, SharedExpense } from '../types';
import { generateId } from '../database/storage';

interface AddExpenseModalProps {
  players: GamePlayer[];
  onClose: () => void;
  onAdd: (expense: SharedExpense) => void;
}

const AddExpenseModal = ({ players, onClose, onAdd }: AddExpenseModalProps) => {
  const [description, setDescription] = useState('פיצה');
  const [amount, setAmount] = useState('');
  const [paidBy, setPaidBy] = useState('');
  const [participants, setParticipants] = useState<string[]>([]);

  const quickDescriptions = ['פיצה', 'אוכל', 'שתייה', 'חטיפים'];

  const handleToggleParticipant = (playerId: string) => {
    setParticipants(prev => 
      prev.includes(playerId) 
        ? prev.filter(id => id !== playerId)
        : [...prev, playerId]
    );
  };

  const handleSelectAll = () => {
    setParticipants(players.map(p => p.playerId));
  };

  const handleDeselectAll = () => {
    setParticipants([]);
  };

  const handleSubmit = () => {
    const amountNum = parseFloat(amount);
    if (!paidBy || !amount || isNaN(amountNum) || amountNum <= 0 || participants.length === 0) {
      return;
    }

    const payer = players.find(p => p.playerId === paidBy);
    const participantPlayers = players.filter(p => participants.includes(p.playerId));

    const expense: SharedExpense = {
      id: generateId(),
      description: description || 'הוצאה משותפת',
      paidBy,
      paidByName: payer?.playerName || '',
      amount: amountNum,
      participants,
      participantNames: participantPlayers.map(p => p.playerName),
      createdAt: new Date().toISOString(),
    };

    onAdd(expense);
    onClose();
  };

  const perPersonCost = participants.length > 0 ? parseFloat(amount) / participants.length : 0;
  const isValid = paidBy && amount && parseFloat(amount) > 0 && participants.length > 0;

  return (
    <div 
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0,0,0,0.8)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: '1rem',
      }}
      onClick={onClose}
    >
      <div 
        className="card"
        style={{
          width: '100%',
          maxWidth: '400px',
          maxHeight: '85vh',
          overflow: 'auto',
          background: '#1a1a2e',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div className="card-header" style={{ marginBottom: '1rem' }}>
          <h2 className="card-title">🍕 הוצאה משותפת</h2>
        </div>

        {/* Description */}
        <div style={{ marginBottom: '1rem' }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
            תיאור
          </label>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
            {quickDescriptions.map(desc => (
              <button
                key={desc}
                type="button"
                className={`btn btn-sm ${description === desc ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setDescription(desc)}
              >
                {desc}
              </button>
            ))}
          </div>
          <input
            type="text"
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="תיאור מותאם אישית"
            className="input"
            style={{ width: '100%', direction: 'rtl' }}
          />
        </div>

        {/* Amount */}
        <div style={{ marginBottom: '1rem' }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
            סכום ₪
          </label>
          <input
            type="number"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="הכנס סכום"
            className="input"
            style={{ width: '100%', fontSize: '1.25rem', textAlign: 'center' }}
            min="0"
            step="1"
          />
        </div>

        {/* Who Paid */}
        <div style={{ marginBottom: '1rem' }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', color: 'var(--text-muted)', fontSize: '0.875rem' }}>
            מי שילם?
          </label>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {players.map(player => (
              <button
                key={player.playerId}
                type="button"
                className={`btn btn-sm ${paidBy === player.playerId ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setPaidBy(player.playerId)}
              >
                {player.playerName}
              </button>
            ))}
          </div>
        </div>

        {/* Participants */}
        <div style={{ marginBottom: '1rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <label style={{ color: 'var(--text-muted)', fontSize: '0.875rem' }}>
              מי משתתף? ({participants.length}/{players.length})
            </label>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button 
                type="button" 
                className="btn btn-sm btn-secondary"
                onClick={handleSelectAll}
              >
                כולם
              </button>
              <button 
                type="button" 
                className="btn btn-sm btn-secondary"
                onClick={handleDeselectAll}
              >
                נקה
              </button>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {players.map(player => (
              <button
                key={player.playerId}
                type="button"
                className={`btn btn-sm ${participants.includes(player.playerId) ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => handleToggleParticipant(player.playerId)}
                style={{
                  opacity: participants.includes(player.playerId) ? 1 : 0.6,
                }}
              >
                {participants.includes(player.playerId) ? '✓ ' : ''}{player.playerName}
              </button>
            ))}
          </div>
        </div>

        {/* Summary */}
        {participants.length > 0 && amount && parseFloat(amount) > 0 && (
          <div style={{ 
            padding: '0.75rem', 
            background: 'rgba(16, 185, 129, 0.1)', 
            borderRadius: '8px',
            marginBottom: '1rem',
            textAlign: 'center',
            direction: 'rtl',
          }}>
            <div style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>
              לכל משתתף:
            </div>
            <div style={{ fontSize: '1.5rem', fontWeight: 'bold', color: 'var(--success)' }}>
              ₪{perPersonCost.toFixed(0)}
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              ({participants.length} משתתפים)
            </div>
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
          <button 
            type="button" 
            className="btn btn-secondary" 
            style={{ flex: 1 }}
            onClick={onClose}
          >
            ביטול
          </button>
          <button 
            type="button"
            className="btn btn-primary" 
            style={{ flex: 1 }}
            onClick={handleSubmit}
            disabled={!isValid}
          >
            הוסף
          </button>
        </div>
      </div>
    </div>
  );
};

export default AddExpenseModal;

