import { useState, useEffect } from 'react';
import { Player, ChipValue, Settings } from '../types';
import { 
  getAllPlayers, 
  addPlayer, 
  deletePlayer,
  getChipValues, 
  saveChipValue,
  deleteChipValue,
  getSettings, 
  saveSettings,
  getPlayerByName
} from '../database/storage';

const SettingsScreen = () => {
  const [settings, setSettings] = useState<Settings>({ rebuyValue: 30, chipsPerRebuy: 10000, minTransfer: 5 });
  const [chipValues, setChipValues] = useState<ChipValue[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [showAddPlayer, setShowAddPlayer] = useState(false);
  const [showAddChip, setShowAddChip] = useState(false);
  const [newPlayerName, setNewPlayerName] = useState('');
  const [newChip, setNewChip] = useState({ color: '', value: '', displayColor: '#3B82F6' });
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = () => {
    setSettings(getSettings());
    setChipValues(getChipValues());
    setPlayers(getAllPlayers());
  };

  const handleSettingsChange = (key: keyof Settings, value: number) => {
    const newSettings = { ...settings, [key]: value };
    setSettings(newSettings);
    saveSettings(newSettings);
    showSaved();
  };

  const showSaved = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleAddPlayer = () => {
    const trimmedName = newPlayerName.trim();
    if (!trimmedName) {
      setError('Please enter a name');
      return;
    }
    if (getPlayerByName(trimmedName)) {
      setError('Player already exists');
      return;
    }
    const player = addPlayer(trimmedName);
    setPlayers([...players, player]);
    setNewPlayerName('');
    setShowAddPlayer(false);
    setError('');
  };

  const handleDeletePlayer = (id: string) => {
    deletePlayer(id);
    setPlayers(players.filter(p => p.id !== id));
  };

  const handleAddChip = () => {
    if (!newChip.color.trim() || !newChip.value) {
      setError('Please fill in all fields');
      return;
    }
    const chip = saveChipValue({
      color: newChip.color.trim(),
      value: parseInt(newChip.value),
      displayColor: newChip.displayColor,
    });
    setChipValues([...chipValues, chip]);
    setNewChip({ color: '', value: '', displayColor: '#3B82F6' });
    setShowAddChip(false);
    setError('');
  };

  const handleDeleteChip = (id: string) => {
    deleteChipValue(id);
    setChipValues(chipValues.filter(c => c.id !== id));
  };

  const handleChipValueChange = (chipId: string, value: number) => {
    const chip = chipValues.find(c => c.id === chipId);
    if (chip) {
      const updated = { ...chip, value };
      saveChipValue(updated);
      setChipValues(chipValues.map(c => c.id === chipId ? updated : c));
      showSaved();
    }
  };

  return (
    <div className="fade-in">
      <div className="page-header">
        <h1 className="page-title">Settings</h1>
        <p className="page-subtitle">Configure your poker games</p>
      </div>

      {saved && (
        <div className="card" style={{ 
          background: 'rgba(34, 197, 94, 0.1)', 
          borderLeft: '4px solid var(--success)',
          marginBottom: '1rem'
        }}>
          <p style={{ color: 'var(--success)' }}>✓ Settings saved</p>
        </div>
      )}

      {/* Game Settings */}
      <div className="card">
        <h2 className="card-title mb-2">💰 Game Settings</h2>
        
        <div className="input-group">
          <label className="label">Rebuy Value (₪)</label>
          <input
            type="number"
            className="input"
            value={settings.rebuyValue}
            onChange={e => handleSettingsChange('rebuyValue', parseInt(e.target.value) || 0)}
            min="1"
          />
        </div>

        <div className="input-group">
          <label className="label">Chips per Rebuy</label>
          <input
            type="number"
            className="input"
            value={settings.chipsPerRebuy}
            onChange={e => handleSettingsChange('chipsPerRebuy', parseInt(e.target.value) || 0)}
            min="1"
          />
          <p className="text-muted" style={{ fontSize: '0.875rem', marginTop: '0.25rem' }}>
            Each rebuy of ₪{settings.rebuyValue.toString()} gives {(settings.chipsPerRebuy || 10000).toLocaleString()} chips
            <br />
            Value per chip: ₪{(settings.rebuyValue / (settings.chipsPerRebuy || 10000)).toFixed(4)}
          </p>
        </div>

        <div className="input-group">
          <label className="label">Minimum Transfer (₪)</label>
          <input
            type="number"
            className="input"
            value={settings.minTransfer}
            onChange={e => handleSettingsChange('minTransfer', parseInt(e.target.value) || 0)}
            min="0"
          />
          <p className="text-muted" style={{ fontSize: '0.875rem', marginTop: '0.25rem' }}>
            Transfers below this amount will be skipped
          </p>
        </div>
      </div>

      {/* Chip Values */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">🎰 Chip Values</h2>
          <button className="btn btn-sm btn-outline" onClick={() => setShowAddChip(true)}>
            + Add Chip
          </button>
        </div>

        {chipValues.map(chip => (
          <div key={chip.id} className="chip-input-row">
            <div 
              className="chip-circle" 
              style={{ 
                backgroundColor: chip.displayColor,
                border: chip.displayColor === '#FFFFFF' ? '2px solid #ccc' : 'none'
              }} 
            />
            <span style={{ flex: 1, fontWeight: '500' }}>{chip.color}</span>
            <span className="text-muted">×</span>
            <input
              type="number"
              className="input"
              style={{ width: '80px', textAlign: 'center' }}
              value={chip.value}
              onChange={e => handleChipValueChange(chip.id, parseInt(e.target.value) || 0)}
              min="1"
            />
            <button 
              className="btn btn-sm btn-danger"
              onClick={() => handleDeleteChip(chip.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {/* Players */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">👥 Players ({players.length})</h2>
          <button className="btn btn-sm btn-outline" onClick={() => setShowAddPlayer(true)}>
            + Add Player
          </button>
        </div>

        {players.length === 0 ? (
          <p className="text-muted">No players added yet</p>
        ) : (
          <div className="list">
            {players.map(player => (
              <div key={player.id} className="list-item">
                <span>{player.name}</span>
                <button 
                  className="btn btn-sm btn-danger"
                  onClick={() => handleDeletePlayer(player.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add Player Modal */}
      {showAddPlayer && (
        <div className="modal-overlay" onClick={() => setShowAddPlayer(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Add New Player</h3>
              <button className="modal-close" onClick={() => setShowAddPlayer(false)}>×</button>
            </div>
            {error && <p style={{ color: 'var(--danger)', marginBottom: '0.5rem' }}>{error}</p>}
            <div className="input-group">
              <label className="label">Player Name</label>
              <input
                type="text"
                className="input"
                placeholder="Enter name"
                value={newPlayerName}
                onChange={e => setNewPlayerName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddPlayer()}
                autoFocus
              />
            </div>
            <div className="actions">
              <button className="btn btn-secondary" onClick={() => setShowAddPlayer(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={handleAddPlayer}>
                Add Player
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Chip Modal */}
      {showAddChip && (
        <div className="modal-overlay" onClick={() => setShowAddChip(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Add New Chip</h3>
              <button className="modal-close" onClick={() => setShowAddChip(false)}>×</button>
            </div>
            {error && <p style={{ color: 'var(--danger)', marginBottom: '0.5rem' }}>{error}</p>}
            <div className="input-group">
              <label className="label">Chip Name</label>
              <input
                type="text"
                className="input"
                placeholder="e.g., Purple"
                value={newChip.color}
                onChange={e => setNewChip({ ...newChip, color: e.target.value })}
              />
            </div>
            <div className="input-group">
              <label className="label">Chip Points (multiplier)</label>
              <input
                type="number"
                className="input"
                placeholder="e.g., 50"
                value={newChip.value}
                onChange={e => setNewChip({ ...newChip, value: e.target.value })}
                min="1"
              />
              <p className="text-muted" style={{ fontSize: '0.875rem', marginTop: '0.25rem' }}>
                How many chip points this chip is worth
              </p>
            </div>
            <div className="input-group">
              <label className="label">Display Color</label>
              <input
                type="color"
                className="input"
                value={newChip.displayColor}
                onChange={e => setNewChip({ ...newChip, displayColor: e.target.value })}
                style={{ height: '48px', padding: '4px' }}
              />
            </div>
            <div className="actions">
              <button className="btn btn-secondary" onClick={() => setShowAddChip(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={handleAddChip}>
                Add Chip
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SettingsScreen;

