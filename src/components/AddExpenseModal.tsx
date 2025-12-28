import { useState } from 'react';
import { GamePlayer, SharedExpense } from '../types';
import { generateId } from '../database/storage';

interface AddExpenseModalProps {
  players: GamePlayer[];
  onClose: () => void;
  onAdd: (expense: SharedExpense) => void;
  existingExpense?: SharedExpense; // For editing
}

const AddExpenseModal = ({ players, onClose, onAdd, existingExpense }: AddExpenseModalProps) => {
  const [description, setDescription] = useState(existingExpense?.description || 'פיצה');
  const [amount, setAmount] = useState(existingExpense?.amount?.toString() || '');
  const [paidBy, setPaidBy] = useState(existingExpense?.paidBy || '');
  const [participants, setParticipants] = useState<string[]>(existingExpense?.participants || []);
  
  const isEditing = !!existingExpense;

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
      id: existingExpense?.id || generateId(),
      description: description || 'הוצאה משותפת',
      paidBy,
      paidByName: payer?.playerName || '',
      amount: amountNum,
      participants,
      participantNames: participantPlayers.map(p => p.playerName),
      createdAt: existingExpense?.createdAt || new Date().toISOString(),
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
        padding: '0.5rem',
      }}
      onClick={onClose}
    >
      <div 
        className="card"
        style={{
          width: '100%',
          maxWidth: '360px',
          padding: '0.75rem',
          background: '#1a1a2e',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <h2 style={{ fontSize: '1.1rem', marginBottom: '0.75rem', textAlign: 'center' }}>
          🍕 {isEditing ? 'עריכת הוצאה' : 'הוצאה משותפת'}
        </h2>

        {/* Description + Amount Row */}
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.6rem' }}>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', marginBottom: '0.2rem', color: 'var(--text-muted)', fontSize: '0.7rem' }}>
              תיאור
            </label>
            <input
              type="text"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="פיצה"
              className="input"
              style={{ width: '100%', direction: 'rtl', padding: '0.4rem', fontSize: '0.85rem' }}
            />
          </div>
          <div style={{ width: '100px' }}>
            <label style={{ display: 'block', marginBottom: '0.2rem', color: 'var(--text-muted)', fontSize: '0.7rem' }}>
              סכום ₪
            </label>
            <input
              type="number"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="0"
              className="input"
              style={{ width: '100%', fontSize: '1rem', textAlign: 'center', padding: '0.4rem' }}
              min="0"
              step="1"
            />
          </div>
        </div>

        {/* Who Paid */}
        <div style={{ marginBottom: '0.6rem' }}>
          <label style={{ display: 'block', marginBottom: '0.2rem', color: 'var(--text-muted)', fontSize: '0.7rem' }}>
            מי שילם?
          </label>
          <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
            {players.map(player => (
              <button
                key={player.playerId}
                type="button"
                className={`btn ${paidBy === player.playerId ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setPaidBy(player.playerId)}
                style={{ padding: '0.2rem 0.4rem', fontSize: '0.75rem' }}
              >
                {player.playerName}
              </button>
            ))}
          </div>
        </div>

        {/* Participants */}
        <div style={{ marginBottom: '0.6rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.2rem' }}>
            <label style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>
              משתתפים ({participants.length}/{players.length})
            </label>
            <div style={{ display: 'flex', gap: '0.25rem' }}>
              <button 
                type="button" 
                className="btn btn-secondary"
                onClick={handleSelectAll}
                style={{ padding: '0.15rem 0.35rem', fontSize: '0.65rem' }}
              >
                כולם
              </button>
              <button 
                type="button" 
                className="btn btn-secondary"
                onClick={handleDeselectAll}
                style={{ padding: '0.15rem 0.35rem', fontSize: '0.65rem' }}
              >
                נקה
              </button>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap' }}>
            {players.map(player => (
              <button
                key={player.playerId}
                type="button"
                className={`btn ${participants.includes(player.playerId) ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => handleToggleParticipant(player.playerId)}
                style={{
                  padding: '0.2rem 0.4rem',
                  fontSize: '0.75rem',
                  opacity: participants.includes(player.playerId) ? 1 : 0.6,
                }}
              >
                {participants.includes(player.playerId) ? '✓' : ''}{player.playerName}
              </button>
            ))}
          </div>
        </div>

        {/* Summary - compact inline */}
        {participants.length > 0 && amount && parseFloat(amount) > 0 && (
          <div style={{ 
            padding: '0.4rem 0.6rem', 
            background: 'rgba(16, 185, 129, 0.15)', 
            borderRadius: '6px',
            marginBottom: '0.6rem',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            gap: '0.5rem',
            direction: 'rtl',
          }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>לכל אחד:</span>
            <span style={{ fontSize: '1.1rem', fontWeight: 'bold', color: 'var(--success)' }}>
              ₪{perPersonCost.toFixed(0)}
            </span>
            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
              ({participants.length})
            </span>
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button 
            type="button" 
            className="btn btn-secondary" 
            style={{ flex: 1, padding: '0.5rem' }}
            onClick={onClose}
          >
            ביטול
          </button>
          <button 
            type="button"
            className="btn btn-primary" 
            style={{ flex: 1, padding: '0.5rem' }}
            onClick={handleSubmit}
            disabled={!isValid}
          >
            {isEditing ? 'עדכן' : 'הוסף'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AddExpenseModal;
