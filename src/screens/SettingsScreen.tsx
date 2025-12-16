import { useState, useEffect } from 'react';
import { Player, ChipValue, Settings } from '../types';
import { cleanNumber } from '../utils/calculations';
import { 
  getAllPlayers, 
  addPlayer, 
  deletePlayer,
  updatePlayerType,
  updatePlayerName,
  getChipValues, 
  saveChipValue,
  deleteChipValue,
  getSettings, 
  saveSettings,
  getPlayerByName,
  getBackups,
  getLastBackupDate,
  createBackup,
  restoreFromBackup,
  downloadBackup,
  shareBackupAsFile,
  importBackupFromFile,
  BackupData
} from '../database/storage';
import { APP_VERSION, CHANGELOG } from '../version';

const SettingsScreen = () => {
  const [settings, setSettings] = useState<Settings>({ rebuyValue: 30, chipsPerRebuy: 10000, minTransfer: 5 });
  const [chipValues, setChipValues] = useState<ChipValue[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [showAddPlayer, setShowAddPlayer] = useState(false);
  const [showAddChip, setShowAddChip] = useState(false);
  const [showEditPlayer, setShowEditPlayer] = useState(false);
  const [editingPlayer, setEditingPlayer] = useState<{ id: string; name: string; type: 'permanent' | 'guest' } | null>(null);
  const [editPlayerName, setEditPlayerName] = useState('');
  const [editPlayerType, setEditPlayerType] = useState<'permanent' | 'guest'>('permanent');
  const [newPlayerName, setNewPlayerName] = useState('');
  const [newPlayerType, setNewPlayerType] = useState<'permanent' | 'guest'>('permanent');
  const [newChip, setNewChip] = useState({ color: '', value: '', displayColor: '#3B82F6' });
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [showFullChangelog, setShowFullChangelog] = useState(false);
  const [activeTab, setActiveTab] = useState<'game' | 'chips' | 'players' | 'backup' | 'about'>('players');
  const [backups, setBackups] = useState<BackupData[]>([]);
  const [lastBackup, setLastBackup] = useState<string | null>(null);
  const [showRestoreModal, setShowRestoreModal] = useState(false);
  const [restoreConfirm, setRestoreConfirm] = useState<string | null>(null);
  const [backupMessage, setBackupMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);
  const [deletePlayerConfirm, setDeletePlayerConfirm] = useState<{ id: string; name: string } | null>(null);
  const [deleteChipConfirm, setDeleteChipConfirm] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = () => {
    setSettings(getSettings());
    setChipValues(getChipValues());
    setPlayers(getAllPlayers());
    setBackups(getBackups());
    setLastBackup(getLastBackupDate());
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
    const player = addPlayer(trimmedName, newPlayerType);
    setPlayers([...players, player]);
    setNewPlayerName('');
    setNewPlayerType('permanent');
    setShowAddPlayer(false);
    setError('');
  };

  const handlePlayerTypeChange = (playerId: string, type: 'permanent' | 'guest') => {
    updatePlayerType(playerId, type);
    setPlayers(players.map(p => p.id === playerId ? { ...p, type } : p));
    showSaved();
  };

  const openEditPlayer = (player: { id: string; name: string; type: 'permanent' | 'guest' }) => {
    setEditingPlayer(player);
    setEditPlayerName(player.name);
    setEditPlayerType(player.type || 'permanent');
    setShowEditPlayer(true);
    setError('');
  };

  const handleEditPlayer = () => {
    if (!editingPlayer) return;
    
    const trimmedName = editPlayerName.trim();
    if (!trimmedName) {
      setError('Please enter a name');
      return;
    }
    
    const success = updatePlayerName(editingPlayer.id, trimmedName);
    if (!success) {
      setError('Player name already exists');
      return;
    }
    
    // Also update type if changed
    if (editPlayerType !== editingPlayer.type) {
      updatePlayerType(editingPlayer.id, editPlayerType);
    }
    
    setPlayers(players.map(p => p.id === editingPlayer.id ? { ...p, name: trimmedName, type: editPlayerType } : p));
    setShowEditPlayer(false);
    setEditingPlayer(null);
    setEditPlayerName('');
    setError('');
    showSaved();
  };

  const handleDeletePlayer = (id: string) => {
    deletePlayer(id);
    setPlayers(players.filter(p => p.id !== id));
    setDeletePlayerConfirm(null);
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
    setDeleteChipConfirm(null);
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

  // Backup handlers
  const handleCreateBackup = () => {
    createBackup('manual');
    setBackups(getBackups());
    setLastBackup(getLastBackupDate());
    setBackupMessage({ type: 'success', text: 'Backup created successfully!' });
    setTimeout(() => setBackupMessage(null), 3000);
  };

  const handleDownloadBackup = () => {
    downloadBackup();
    setBackupMessage({ type: 'success', text: 'Backup downloaded!' });
    setTimeout(() => setBackupMessage(null), 3000);
  };

  const handleShareBackup = async () => {
    const shared = await shareBackupAsFile();
    if (shared) {
      setBackupMessage({ type: 'success', text: 'Backup shared!' });
    } else {
      setBackupMessage({ type: 'success', text: 'Backup downloaded!' });
    }
    setTimeout(() => setBackupMessage(null), 3000);
  };

  const handleRestore = (backupId: string) => {
    const success = restoreFromBackup(backupId);
    if (success) {
      setBackupMessage({ type: 'success', text: 'Data restored successfully! Reloading...' });
      setTimeout(() => window.location.reload(), 1500);
    } else {
      setBackupMessage({ type: 'error', text: 'Failed to restore backup' });
    }
    setShowRestoreModal(false);
    setRestoreConfirm(null);
  };

  const handleImportFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      const success = importBackupFromFile(content);
      if (success) {
        setBackupMessage({ type: 'success', text: 'Backup imported successfully! Reloading...' });
        setTimeout(() => window.location.reload(), 1500);
      } else {
        setBackupMessage({ type: 'error', text: 'Failed to import backup - invalid file' });
        setTimeout(() => setBackupMessage(null), 3000);
      }
    };
    reader.readAsText(file);
    // Reset input
    event.target.value = '';
  };

  const formatBackupDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const tabs = [
    { id: 'players', label: '👥 Players', icon: '👥' },
    { id: 'chips', label: '🎰 Chips', icon: '🎰' },
    { id: 'game', label: '💰 Game', icon: '💰' },
    { id: 'backup', label: '📦 Backup', icon: '📦' },
    { id: 'about', label: 'ℹ️ About', icon: 'ℹ️' },
  ] as const;

  return (
    <div className="fade-in">
      <div className="page-header" style={{ marginBottom: '0.5rem' }}>
        <h1 className="page-title">Settings</h1>
      </div>

      {/* Tabs */}
      <div className="card" style={{ padding: '0.75rem', marginBottom: '1rem' }}>
        <div style={{ 
          display: 'flex', 
          flexWrap: 'wrap',
          gap: '0.5rem'
        }}>
          {tabs.slice(0, 4).map(tab => (
            <button
              key={tab.id}
              className={`btn btn-sm ${activeTab === tab.id ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setActiveTab(tab.id)}
              style={{ flex: '1 1 calc(25% - 0.5rem)', minWidth: '70px' }}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {tabs.length > 4 && (
          <div style={{ 
            display: 'flex', 
            flexWrap: 'wrap',
            gap: '0.5rem',
            marginTop: '0.5rem'
          }}>
            {tabs.slice(4).map(tab => (
              <button
                key={tab.id}
                className={`btn btn-sm ${activeTab === tab.id ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setActiveTab(tab.id)}
                style={{ flex: '1 1 calc(25% - 0.5rem)', minWidth: '70px' }}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}
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

      {/* Game Settings Tab */}
      {activeTab === 'game' && (
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
              Each rebuy of ₪{cleanNumber(settings.rebuyValue)} gives {(settings.chipsPerRebuy || 10000).toLocaleString()} chips
              <br />
              Value per 1000 chips: ₪{((settings.rebuyValue / (settings.chipsPerRebuy || 10000)) * 1000).toFixed(1)}
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
      )}

      {/* Chip Values Tab */}
      {activeTab === 'chips' && (
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
                className="btn btn-sm"
                style={{ 
                  padding: '0.35rem 0.5rem', 
                  fontSize: '0.75rem',
                  background: 'rgba(239, 68, 68, 0.1)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  color: 'var(--danger)'
                }}
                onClick={() => setDeleteChipConfirm({ id: chip.id, name: chip.color })}
                title="Delete chip"
              >
                🗑️
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Players Tab */}
      {activeTab === 'players' && (
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
                <div key={player.id} className="list-item" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1 }}>
                    <span style={{ fontWeight: '500' }}>{player.name}</span>
                    <span style={{ 
                      fontSize: '0.7rem', 
                      padding: '0.15rem 0.4rem', 
                      borderRadius: '4px',
                      background: player.type === 'permanent' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(100, 100, 100, 0.15)',
                      color: player.type === 'permanent' ? 'var(--primary)' : 'var(--text-muted)'
                    }}>
                      {player.type === 'permanent' ? '⭐ קבוע' : '👤 אורח'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '0.35rem' }}>
                    <button 
                      className="btn btn-sm"
                      style={{ 
                        padding: '0.35rem 0.6rem', 
                        fontSize: '0.75rem',
                        background: 'var(--surface)',
                        border: '1px solid var(--border)',
                        color: 'var(--text)'
                      }}
                      onClick={() => openEditPlayer(player)}
                      title="Edit player"
                    >
                      ✏️ Edit
                    </button>
                    <button 
                      className="btn btn-sm"
                      style={{ 
                        padding: '0.35rem 0.5rem', 
                        fontSize: '0.75rem',
                        background: 'rgba(239, 68, 68, 0.1)',
                        border: '1px solid rgba(239, 68, 68, 0.3)',
                        color: 'var(--danger)'
                      }}
                      onClick={() => setDeletePlayerConfirm({ id: player.id, name: player.name })}
                      title="Delete player"
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Backup & Restore Tab */}
      {activeTab === 'backup' && (
        <div className="card">
          <h2 className="card-title mb-2">📦 Backup & Restore</h2>
          
          {backupMessage && (
            <div style={{ 
              padding: '0.75rem', 
              marginBottom: '1rem',
              borderRadius: '8px',
              background: backupMessage.type === 'success' ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
              borderLeft: `4px solid ${backupMessage.type === 'success' ? 'var(--success)' : 'var(--danger)'}`
            }}>
              <p style={{ color: backupMessage.type === 'success' ? 'var(--success)' : 'var(--danger)', margin: 0 }}>
                {backupMessage.text}
              </p>
            </div>
          )}

          {/* Status info */}
          <div style={{ 
            background: 'var(--surface)', 
            borderRadius: '8px', 
            padding: '0.75rem',
            marginBottom: '1rem'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Last backup:</span>
              <span style={{ fontSize: '0.85rem', fontWeight: '500' }}>{lastBackup ? formatBackupDate(lastBackup) : 'Never'}</span>
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0 }}>
              ⏰ Auto-backup after each game + every Friday
            </p>
          </div>

          {/* Backup Actions */}
          <div style={{ marginBottom: '1rem' }}>
            <p style={{ fontSize: '0.8rem', fontWeight: '600', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
              Create Backup
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
              <button 
                className="btn btn-primary" 
                onClick={handleCreateBackup}
                style={{ flex: 1 }}
              >
                💾 Backup Now
              </button>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button 
                className="btn btn-secondary" 
                onClick={handleDownloadBackup}
                style={{ flex: 1 }}
              >
                📥 Download
              </button>
              <button 
                className="btn btn-secondary" 
                onClick={handleShareBackup}
                style={{ flex: 1 }}
              >
                📤 Share
              </button>
            </div>
          </div>

          {/* Restore Actions */}
          <div>
            <p style={{ fontSize: '0.8rem', fontWeight: '600', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
              Restore Data
            </p>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button 
                className="btn btn-secondary" 
                onClick={() => setShowRestoreModal(true)}
                style={{ flex: 1 }}
              >
                🔄 From Backup
              </button>
              <label 
                className="btn btn-secondary" 
                style={{ flex: 1, textAlign: 'center', cursor: 'pointer', margin: 0 }}
              >
                📤 From File
                <input 
                  type="file" 
                  accept=".json"
                  onChange={handleImportFile}
                  style={{ display: 'none' }}
                />
              </label>
            </div>
          </div>
        </div>
      )}

      {/* About Tab */}
      {activeTab === 'about' && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">ℹ️ App Version</h2>
            <span style={{ 
              background: 'var(--primary)', 
              color: 'white', 
              padding: '0.25rem 0.75rem', 
              borderRadius: '1rem',
              fontSize: '0.875rem',
              fontWeight: '600'
            }}>
              v{APP_VERSION}
            </span>
          </div>
          
          <div style={{ marginTop: '1rem' }}>
            <h3 style={{ fontSize: '0.875rem', fontWeight: '600', marginBottom: '0.75rem', color: 'var(--text-secondary)' }}>
              Latest Changes
            </h3>
            
            {/* Show only the latest entry */}
            {CHANGELOG.length > 0 && (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                  <span style={{ fontWeight: '600', color: 'var(--primary)' }}>v{CHANGELOG[0].version}</span>
                  <span className="text-muted" style={{ fontSize: '0.75rem' }}>{CHANGELOG[0].date}</span>
                </div>
                <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
                  {CHANGELOG[0].changes.map((change, i) => (
                    <li key={i} style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
                      {change}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Show history button */}
            {CHANGELOG.length > 1 && (
              <button
                onClick={() => setShowFullChangelog(!showFullChangelog)}
                style={{
                  marginTop: '1rem',
                  padding: '0.5rem 1rem',
                  background: 'transparent',
                  border: '1px solid var(--border)',
                  borderRadius: '8px',
                  color: 'var(--text-muted)',
                  fontSize: '0.8rem',
                  cursor: 'pointer',
                  width: '100%'
                }}
              >
                {showFullChangelog ? '▲ Hide History' : `▼ Show History (${CHANGELOG.length - 1} more)`}
              </button>
            )}

            {/* Full changelog history */}
            {showFullChangelog && CHANGELOG.slice(1).map((entry, index) => (
              <div key={entry.version} style={{ 
                marginTop: index === 0 ? '1rem' : '0.75rem',
                paddingTop: '0.75rem',
                borderTop: '1px solid var(--border)'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                  <span style={{ fontWeight: '600', color: 'var(--text-muted)' }}>v{entry.version}</span>
                  <span className="text-muted" style={{ fontSize: '0.75rem' }}>{entry.date}</span>
                </div>
                <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
                  {entry.changes.map((change, i) => (
                    <li key={i} style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.15rem' }}>
                      {change}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}

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
            <div className="input-group">
              <label className="label">Player Type</label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  className="btn"
                  style={{
                    flex: 1,
                    background: newPlayerType === 'permanent' ? 'rgba(16, 185, 129, 0.2)' : 'var(--surface)',
                    border: newPlayerType === 'permanent' ? '2px solid var(--primary)' : '1px solid var(--border)',
                    color: newPlayerType === 'permanent' ? 'var(--primary)' : 'var(--text-muted)'
                  }}
                  onClick={() => setNewPlayerType('permanent')}
                >
                  ⭐ קבוע
                </button>
                <button
                  className="btn"
                  style={{
                    flex: 1,
                    background: newPlayerType === 'guest' ? 'rgba(100, 100, 100, 0.2)' : 'var(--surface)',
                    border: newPlayerType === 'guest' ? '2px solid var(--text-muted)' : '1px solid var(--border)',
                    color: newPlayerType === 'guest' ? 'var(--text)' : 'var(--text-muted)'
                  }}
                  onClick={() => setNewPlayerType('guest')}
                >
                  👤 אורח
                </button>
              </div>
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

      {/* Edit Player Modal */}
      {showEditPlayer && editingPlayer && (
        <div className="modal-overlay" onClick={() => setShowEditPlayer(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Edit Player</h3>
              <button className="modal-close" onClick={() => setShowEditPlayer(false)}>×</button>
            </div>
            {error && <p style={{ color: 'var(--danger)', marginBottom: '0.5rem' }}>{error}</p>}
            <div className="input-group">
              <label className="label">Player Name</label>
              <input
                type="text"
                className="input"
                placeholder="Enter name"
                value={editPlayerName}
                onChange={e => setEditPlayerName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleEditPlayer()}
                autoFocus
              />
            </div>
            <div className="input-group">
              <label className="label">Player Type</label>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  className={`btn ${editPlayerType === 'permanent' ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ flex: 1 }}
                  onClick={() => setEditPlayerType('permanent')}
                >
                  ⭐ קבוע
                </button>
                <button
                  className={`btn ${editPlayerType === 'guest' ? 'btn-primary' : 'btn-secondary'}`}
                  style={{ flex: 1 }}
                  onClick={() => setEditPlayerType('guest')}
                >
                  👤 אורח
                </button>
              </div>
            </div>
            <p className="text-muted" style={{ fontSize: '0.8rem', marginBottom: '1rem' }}>
              ⚠️ Changing name will update all historical data
            </p>
            <div className="actions">
              <button className="btn btn-secondary" onClick={() => setShowEditPlayer(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={handleEditPlayer}>
                Save Changes
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

      {/* Restore Backup Modal */}
      {showRestoreModal && (
        <div className="modal-overlay" onClick={() => { setShowRestoreModal(false); setRestoreConfirm(null); }}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">Restore from Backup</h3>
              <button className="modal-close" onClick={() => { setShowRestoreModal(false); setRestoreConfirm(null); }}>×</button>
            </div>
            
            {restoreConfirm ? (
              <>
                <p style={{ marginBottom: '1rem', color: 'var(--warning)' }}>
                  ⚠️ This will replace ALL current data with the backup from {formatBackupDate(backups.find(b => b.id === restoreConfirm)?.date || '')}.
                </p>
                <p className="text-muted" style={{ marginBottom: '1rem', fontSize: '0.875rem' }}>
                  This action cannot be undone. Consider downloading current data first.
                </p>
                <div className="actions">
                  <button className="btn btn-secondary" onClick={() => setRestoreConfirm(null)}>
                    Cancel
                  </button>
                  <button className="btn btn-danger" onClick={() => handleRestore(restoreConfirm)}>
                    Restore
                  </button>
                </div>
              </>
            ) : (
              <>
                {backups.length === 0 ? (
                  <p className="text-muted">No backups available yet. Create a backup first.</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {backups.map((backup, index) => (
                      <button
                        key={backup.id}
                        className="btn btn-outline"
                        style={{ textAlign: 'left', justifyContent: 'space-between', display: 'flex', alignItems: 'center' }}
                        onClick={() => setRestoreConfirm(backup.id)}
                      >
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
                          <span>{formatBackupDate(backup.date)}</span>
                          <span style={{ 
                            fontSize: '0.7rem', 
                            color: backup.type === 'auto' ? 'var(--primary)' : 'var(--text-muted)',
                            marginTop: '0.15rem'
                          }}>
                            {backup.type === 'auto' 
                              ? (backup.trigger === 'game-end' ? '🎮 Auto (Game End)' : '📅 Auto (Friday)')
                              : '👤 Manual'}
                          </span>
                        </div>
                        <span className="text-muted" style={{ fontSize: '0.8rem' }}>
                          {index === 0 ? '(Latest)' : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                <button 
                  className="btn btn-secondary mt-2" 
                  style={{ width: '100%' }}
                  onClick={() => setShowRestoreModal(false)}
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Delete Player Confirmation Modal */}
      {deletePlayerConfirm && (
        <div className="modal-overlay" onClick={() => setDeletePlayerConfirm(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">🗑️ Delete Player</h3>
              <button className="modal-close" onClick={() => setDeletePlayerConfirm(null)}>×</button>
            </div>
            <p style={{ marginBottom: '1rem' }}>
              Are you sure you want to delete <strong>{deletePlayerConfirm.name}</strong>?
            </p>
            <p className="text-muted" style={{ fontSize: '0.85rem', marginBottom: '1rem' }}>
              ⚠️ This will not delete their game history, but they will no longer appear in the player list.
            </p>
            <div className="actions">
              <button className="btn btn-secondary" onClick={() => setDeletePlayerConfirm(null)}>
                Cancel
              </button>
              <button className="btn btn-danger" onClick={() => handleDeletePlayer(deletePlayerConfirm.id)}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Chip Confirmation Modal */}
      {deleteChipConfirm && (
        <div className="modal-overlay" onClick={() => setDeleteChipConfirm(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">🗑️ Delete Chip</h3>
              <button className="modal-close" onClick={() => setDeleteChipConfirm(null)}>×</button>
            </div>
            <p style={{ marginBottom: '1rem' }}>
              Are you sure you want to delete the <strong>{deleteChipConfirm.name}</strong> chip?
            </p>
            <div className="actions">
              <button className="btn btn-secondary" onClick={() => setDeleteChipConfirm(null)}>
                Cancel
              </button>
              <button className="btn btn-danger" onClick={() => handleDeleteChip(deleteChipConfirm.id)}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SettingsScreen;

