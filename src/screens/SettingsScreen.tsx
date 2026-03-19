import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Player, PlayerType, PlayerGender, ChipValue, Settings } from '../types';
import { cleanNumber } from '../utils/calculations';
import { 
  getAllPlayers, 
  addPlayer, 
  deletePlayer,
  updatePlayerType,
  updatePlayerName,
  updatePlayerGender,
  getChipValues, 
  saveChipValue,
  deleteChipValue,
  getSettings, 
  saveSettings,
  getPlayerByName,
  getBackups,
  getLastBackupDate,
  createBackupWithCloudSync,
  restoreFromBackup,
  restoreFromCloudBackup,
  downloadBackup,
  importBackupFromFile,
  BackupData,
  getStorageUsage,
  formatStorageSize,
  StorageUsage
} from '../database/storage';
import { getGitHubToken, saveGitHubToken, syncToCloud, syncFromCloud } from '../database/githubSync';
import { getGeminiApiKey, setGeminiApiKey, testGeminiApiKey, getModelDisplayName, testModelAvailability, ModelTestResult } from '../utils/geminiAI';
import { getElevenLabsApiKey, setElevenLabsApiKey, getElevenLabsUsageLive, getElevenLabsGameHistory } from '../utils/tts';
import { getAIStatus, getTodayActions, getTodayTokens, getTodayLog, resetUsage, type AIStatusData } from '../utils/aiUsageTracker';
import { fetchActivityLog, clearActivityLog } from '../utils/activityLogger';
import { ActivityLogEntry } from '../types';
import { APP_VERSION, CHANGELOG } from '../version';
import { isEdgeBrowser } from '../utils/tts';
import { usePermissions } from '../App';
import { getRoleDisplayName, getRoleEmoji } from '../permissions';

const SettingsScreen = () => {
  const navigate = useNavigate();
  const { role, hasPermission, signOut } = usePermissions();
  const [settings, setSettings] = useState<Settings>({ rebuyValue: 30, chipsPerRebuy: 10000, minTransfer: 5 });
  const [chipValues, setChipValues] = useState<ChipValue[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [showAddPlayer, setShowAddPlayer] = useState(false);
  const [showAddChip, setShowAddChip] = useState(false);
  const [showEditPlayer, setShowEditPlayer] = useState(false);
  const [editingPlayer, setEditingPlayer] = useState<{ id: string; name: string; type: PlayerType; gender: PlayerGender } | null>(null);
  const [editPlayerName, setEditPlayerName] = useState('');
  const [editPlayerType, setEditPlayerType] = useState<PlayerType>('permanent');
  const [editPlayerGender, setEditPlayerGender] = useState<PlayerGender>('male');
  const [newPlayerName, setNewPlayerName] = useState('');
  const [newPlayerType, setNewPlayerType] = useState<PlayerType>('permanent');
  const [newPlayerGender, setNewPlayerGender] = useState<PlayerGender>('male');
  const [newChip, setNewChip] = useState({ color: '', value: '', displayColor: '#3B82F6' });
  const [newLocation, setNewLocation] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [showFullChangelog, setShowFullChangelog] = useState(false);
  const [backups, setBackups] = useState<BackupData[]>([]);
  const [lastBackup, setLastBackup] = useState<string | null>(null);
  const [storageUsage, setStorageUsage] = useState<StorageUsage | null>(null);
  const [showRestoreModal, setShowRestoreModal] = useState(false);
  const [restoreConfirm, setRestoreConfirm] = useState<string | null>(null);
  const [backupMessage, setBackupMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);
  const [deletePlayerConfirm, setDeletePlayerConfirm] = useState<{ id: string; name: string } | null>(null);
  const [deleteChipConfirm, setDeleteChipConfirm] = useState<{ id: string; name: string } | null>(null);
  
  // GitHub sync state
  const [githubToken, setGithubToken] = useState<string>('');
  const [showToken, setShowToken] = useState(false);
  const [syncMessage, setSyncMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  
  // Gemini AI state
  const [geminiKey, setGeminiKey] = useState<string>('');
  const [showGeminiKey, setShowGeminiKey] = useState(false);
  const [geminiMessage, setGeminiMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);
  const [isTestingGemini, setIsTestingGemini] = useState(false);
  // ElevenLabs TTS state
  const [elKey, setElKey] = useState<string>('');
  const [showElKey, setShowElKey] = useState(false);
  const [elMessage, setElMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null);
  const [isTestingEl, setIsTestingEl] = useState(false);
  const [elUsageLive, setElUsageLive] = useState<{ used: number; limit: number; remaining: number; resetDate: string } | null>(null);

  // AI Status state
  const [, setAiStatus] = useState<AIStatusData | null>(null);
  const [aiTestResults, setAiTestResults] = useState<ModelTestResult[] | null>(null);
  const [isTestingModels, setIsTestingModels] = useState(false);
  const [showAiLog, setShowAiLog] = useState(false);
  const [aiTick, setAiTick] = useState(0);

  // Activity log state
  const [activityLog, setActivityLog] = useState<ActivityLogEntry[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [deviceLabels, setDeviceLabels] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('poker_device_labels') || '{}'); } catch { return {}; }
  });
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [editLabelValue, setEditLabelValue] = useState('');

  // Permission checks
  const canEditSettings = hasPermission('settings:edit');
  const canEditChips = hasPermission('chips:edit');
  const canEditPlayers = hasPermission('player:edit');
  const canDeletePlayers = hasPermission('player:delete');
  const canAddPlayers = hasPermission('player:add');

  const syncPlayersToCloud = () => {
    if (role === 'admin' || role === 'memberSync') {
      const useMemberSyncToken = role === 'memberSync';
      syncToCloud(useMemberSyncToken).then(result => {
        console.log('Player sync:', result.message);
      });
    }
  };

  // Determine default tab based on permissions: players for admin/member, backup for viewer
  const getDefaultTab = (): 'game' | 'chips' | 'players' | 'backup' | 'about' | 'activity' | 'ai' => {
    if (canAddPlayers) return 'players';
    return 'backup';
  };
  
  const [activeTab, setActiveTab] = useState<'game' | 'chips' | 'players' | 'backup' | 'about' | 'activity' | 'ai'>(getDefaultTab());

  useEffect(() => {
    loadData();
  }, []);

  // Auto-load activity log when tab is selected
  useEffect(() => {
    if (activeTab === 'activity' && role === 'admin' && activityLog.length === 0 && !activityLoading) {
      loadActivityLog();
    }
  }, [activeTab]);

  // Load AI status when AI tab is selected + tick for countdowns
  useEffect(() => {
    if (activeTab !== 'ai') return;
    setAiStatus(getAIStatus());
    const savedElKey = getElevenLabsApiKey();
    if (savedElKey) {
      getElevenLabsUsageLive(savedElKey).then(u => { if (u) setElUsageLive(u); });
    }
    const interval = setInterval(() => {
      setAiStatus(getAIStatus());
      setAiTick(t => t + 1);
    }, 5000);
    return () => clearInterval(interval);
  }, [activeTab]);

  // Sort players by type: permanent first, then permanent_guest (guests), then guest (occasional)
  const sortPlayersByType = (playerList: Player[]): Player[] => {
    const typeOrder: Record<PlayerType, number> = {
      'permanent': 0,
      'permanent_guest': 1,
      'guest': 2
    };
    return [...playerList].sort((a, b) => {
      const orderDiff = typeOrder[a.type] - typeOrder[b.type];
      if (orderDiff !== 0) return orderDiff;
      // Within same type, sort alphabetically
      return a.name.localeCompare(b.name, 'he');
    });
  };

  const loadData = () => {
    setSettings(getSettings());
    setChipValues(getChipValues());
    setPlayers(sortPlayersByType(getAllPlayers()));
    setBackups(getBackups());
    setLastBackup(getLastBackupDate());
    setStorageUsage(getStorageUsage());
    // Load GitHub token if admin
    const savedToken = getGitHubToken();
    if (savedToken) setGithubToken(savedToken);
    // Load Gemini API key
    const savedGeminiKey = getGeminiApiKey();
    if (savedGeminiKey) setGeminiKey(savedGeminiKey);
    // Load ElevenLabs API key
    const savedElKey = getElevenLabsApiKey();
    if (savedElKey) setElKey(savedElKey);
  };

  const handleSettingsChange = (key: keyof Settings, value: number | number[] | string[]) => {
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
    const player = addPlayer(trimmedName, newPlayerType, newPlayerGender);
    setPlayers(sortPlayersByType([...players, player]));
    setNewPlayerName('');
    setNewPlayerType('permanent');
    setNewPlayerGender('male');
    setShowAddPlayer(false);
    setError('');
    syncPlayersToCloud();
  };

  const openEditPlayer = (player: Player) => {
    setEditingPlayer(player);
    setEditPlayerName(player.name);
    setEditPlayerType(player.type || 'permanent');
    setEditPlayerGender(player.gender || 'male');
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
    
    if (editPlayerType !== editingPlayer.type) {
      updatePlayerType(editingPlayer.id, editPlayerType);
    }
    if (editPlayerGender !== editingPlayer.gender) {
      updatePlayerGender(editingPlayer.id, editPlayerGender);
    }
    
    setPlayers(sortPlayersByType(players.map(p => p.id === editingPlayer.id ? { ...p, name: trimmedName, type: editPlayerType, gender: editPlayerGender } : p)));
    setShowEditPlayer(false);
    setEditingPlayer(null);
    setEditPlayerName('');
    setError('');
    showSaved();
    syncPlayersToCloud();
  };

  const handleDeletePlayer = (id: string) => {
    deletePlayer(id);
    setPlayers(players.filter(p => p.id !== id));
    setDeletePlayerConfirm(null);
    syncPlayersToCloud();
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
  const [isBackingUp, setIsBackingUp] = useState(false);
  
  const handleCreateBackup = async () => {
    setIsBackingUp(true);
    setBackupMessage({ type: 'success', text: '💾 Creating backup...' });
    
    try {
      // Use embedded token if memberSync role
      const useMemberSyncToken = role === 'memberSync';
      const { cloudResult } = await createBackupWithCloudSync('manual', undefined, useMemberSyncToken);
      
      setBackups(getBackups());
      setLastBackup(getLastBackupDate());
      setStorageUsage(getStorageUsage());
      
      if (cloudResult.success) {
        setBackupMessage({ type: 'success', text: '✅ Backup saved locally + uploaded to cloud!' });
      } else {
        setBackupMessage({ type: 'success', text: `✅ Backup saved locally. ⚠️ ${cloudResult.message}` });
      }
    } catch (error) {
      setBackupMessage({ type: 'error', text: 'Backup failed!' });
    } finally {
      setIsBackingUp(false);
      setTimeout(() => setBackupMessage(null), 4000);
    }
  };

  const handleDownloadBackup = () => {
    downloadBackup();
    setBackupMessage({ type: 'success', text: '✅ Backup saved to Downloads!' });
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

  const loadActivityLog = async () => {
    setActivityLoading(true);
    setActivityError(null);
    try {
      const entries = await fetchActivityLog();
      setActivityLog(entries.reverse());
    } catch (err) {
      setActivityError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setActivityLoading(false);
    }
  };

  const handleClearActivityLog = async () => {
    if (!window.confirm('Clear all activity log entries?')) return;
    setActivityLoading(true);
    try {
      await clearActivityLog();
      setActivityLog([]);
    } catch (err) {
      setActivityError(err instanceof Error ? err.message : 'Failed to clear');
    } finally {
      setActivityLoading(false);
    }
  };

  const saveDeviceLabel = (deviceId: string, label: string) => {
    const trimmed = label.trim();
    const updated = { ...deviceLabels };
    if (trimmed) {
      updated[deviceId] = trimmed;
    } else {
      delete updated[deviceId];
    }
    setDeviceLabels(updated);
    localStorage.setItem('poker_device_labels', JSON.stringify(updated));
    setEditingDeviceId(null);
    setEditLabelValue('');
  };

  const formatRelativeTime = (isoString: string): string => {
    const date = new Date(isoString);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const entryDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const diffDays = Math.floor((today.getTime() - entryDay.getTime()) / 86400000);
    const time = date.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
    if (diffDays === 0) return `Today ${time}`;
    if (diffDays === 1) return `Yesterday ${time}`;
    if (diffDays < 7) return `${diffDays} days ago ${time}`;
    return `${date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${time}`;
  };

  const getRoleInfo = (r: string) => {
    switch (r) {
      case 'member': return { emoji: '⭐', name: 'Member', color: '#10B981' };
      case 'memberSync': return { emoji: '🔄', name: 'Member+Sync', color: '#3B82F6' };
      case 'viewer': return { emoji: '👁️', name: 'Viewer', color: '#94a3b8' };
      default: return { emoji: '👤', name: r, color: '#94a3b8' };
    }
  };

  // Filter tabs based on permissions
  const allTabs = [
    { id: 'players', label: '👥 Players', icon: '👥', requiresPermission: 'player:add' as const, adminOnly: false },
    { id: 'chips', label: '🎰 Chips', icon: '🎰', requiresPermission: 'chips:edit' as const, adminOnly: false },
    { id: 'game', label: '💰 Game', icon: '💰', requiresPermission: 'settings:edit' as const, adminOnly: false },
    { id: 'backup', label: '📦 Backup', icon: '📦', requiresPermission: null, adminOnly: false },
    { id: 'ai', label: '🤖 AI', icon: '🤖', requiresPermission: null, adminOnly: true },
    { id: 'activity', label: '📊 Activity', icon: '📊', requiresPermission: null, adminOnly: true },
    { id: 'about', label: 'ℹ️ About', icon: 'ℹ️', requiresPermission: null, adminOnly: false },
  ];
  
  const tabs = allTabs.filter(tab => {
    if (tab.adminOnly && role !== 'admin') return false;
    return tab.requiresPermission === null || hasPermission(tab.requiresPermission);
  }) as { id: 'game' | 'chips' | 'players' | 'backup' | 'about' | 'activity'; label: string; icon: string }[];

  return (
    <div className="fade-in">
      <div className="page-header" style={{ marginBottom: '0.5rem' }}>
        <h1 className="page-title">Settings</h1>
        {role && (
          <span style={{ 
            fontSize: '0.75rem', 
            padding: '0.25rem 0.5rem', 
            borderRadius: '8px',
            background: role === 'admin' ? 'rgba(234, 179, 8, 0.15)' : role === 'member' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(100, 100, 100, 0.15)',
            color: role === 'admin' ? '#EAB308' : role === 'member' ? 'var(--primary)' : 'var(--text-muted)'
          }}>
            {getRoleEmoji(role)} {getRoleDisplayName(role)}
          </span>
        )}
        <button
          onClick={signOut}
          style={{
            background: 'none', border: 'none', color: 'var(--text-muted)',
            fontSize: '0.85rem', cursor: 'pointer', padding: '0.25rem',
          }}
          title="Sign Out"
        >
          🔓
        </button>
      </div>

      {/* Poker Training - Admin Only */}
      {role === 'admin' && (
        <button
          onClick={() => navigate('/training')}
          style={{
            width: '100%',
            padding: '0.75rem 1rem',
            borderRadius: '12px',
            border: '1px solid rgba(99, 102, 241, 0.3)',
            background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.12), rgba(168, 85, 247, 0.12))',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            marginBottom: '0.75rem',
            transition: 'all 0.15s ease',
          }}
        >
          <span style={{ fontSize: '1.5rem' }}>🎯</span>
          <div style={{ textAlign: 'right', flex: 1 }}>
            <div style={{ fontWeight: '700', fontSize: '0.9rem', color: '#a78bfa' }}>
              אימון פוקר
            </div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
              תרגול סיטואציות מותאם לשולחן שלך
            </div>
          </div>
          <span style={{ color: 'var(--text-muted)', fontSize: '1.2rem' }}>›</span>
        </button>
      )}

      {/* Tabs */}
      <div className="card" style={{ padding: '0.75rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {tabs.slice(0, 4).map(tab => (
            <button
              key={tab.id}
              className={`btn btn-sm ${activeTab === tab.id ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setActiveTab(tab.id)}
              style={{ flex: 1, minWidth: 0, padding: '0.5rem 0.25rem', fontSize: '0.75rem' }}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {tabs.length > 4 && (
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
            {tabs.slice(4).map(tab => (
              <button
                key={tab.id}
                className={`btn btn-sm ${activeTab === tab.id ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setActiveTab(tab.id)}
                style={{ flex: 1, minWidth: 0, padding: '0.5rem 0.25rem', fontSize: '0.75rem' }}
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
          
          {!canEditSettings && (
            <div style={{ 
              padding: '0.5rem 0.75rem', 
              marginBottom: '1rem',
              borderRadius: '8px',
              background: 'rgba(234, 179, 8, 0.1)',
              borderLeft: '4px solid #EAB308'
            }}>
              <p style={{ color: '#EAB308', margin: 0, fontSize: '0.85rem' }}>
                🔒 Only Admin can edit game settings
              </p>
            </div>
          )}
          
          <div className="input-group">
            <label className="label">Buyin Value (₪)</label>
            <input
              type="number"
              className="input"
              value={settings.rebuyValue}
              onChange={e => handleSettingsChange('rebuyValue', parseInt(e.target.value) || 0)}
              min="1"
              disabled={!canEditSettings}
            />
          </div>

          <div className="input-group">
            <label className="label">Chips per Buyin</label>
            <input
              type="number"
              className="input"
              value={settings.chipsPerRebuy}
              onChange={e => handleSettingsChange('chipsPerRebuy', parseInt(e.target.value) || 0)}
              min="1"
              disabled={!canEditSettings}
            />
            <p className="text-muted" style={{ fontSize: '0.875rem', marginTop: '0.25rem' }}>
              Each buyin of ₪{cleanNumber(settings.rebuyValue)} gives {(settings.chipsPerRebuy || 10000).toLocaleString()} chips
              <br />
              Value per 1000 chips: ₪{Math.round((settings.rebuyValue / (settings.chipsPerRebuy || 10000)) * 1000)}
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
              disabled={!canEditSettings}
            />
            <p className="text-muted" style={{ fontSize: '0.875rem', marginTop: '0.25rem' }}>
              Transfers below this amount will be skipped
            </p>
          </div>

          <div className="input-group">
            <label className="label">Game Night Days</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.25rem' }}>
              {[
                { day: 0, label: 'Sun' },
                { day: 1, label: 'Mon' },
                { day: 2, label: 'Tue' },
                { day: 3, label: 'Wed' },
                { day: 4, label: 'Thu' },
                { day: 5, label: 'Fri' },
                { day: 6, label: 'Sat' },
              ].map(({ day, label }) => {
                const days = settings.gameNightDays || [4, 6];
                const isSelected = days.includes(day);
                return (
                  <button
                    key={day}
                    disabled={!canEditSettings}
                    onClick={() => {
                      const current = settings.gameNightDays || [4, 6];
                      const updated = isSelected
                        ? current.filter(d => d !== day)
                        : [...current, day].sort();
                      if (updated.length > 0) {
                        handleSettingsChange('gameNightDays', updated);
                      }
                    }}
                    style={{
                      padding: '0.35rem 0.6rem',
                      borderRadius: '6px',
                      fontSize: '0.8rem',
                      fontWeight: isSelected ? '600' : '400',
                      background: isSelected ? 'var(--primary)' : 'var(--surface)',
                      color: isSelected ? 'white' : 'var(--text-muted)',
                      border: `1px solid ${isSelected ? 'var(--primary)' : 'var(--border)'}`,
                      cursor: canEditSettings ? 'pointer' : 'default',
                      opacity: canEditSettings ? 1 : 0.6,
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <p className="text-muted" style={{ fontSize: '0.875rem', marginTop: '0.25rem' }}>
              Used to auto-detect first/last game of a period
            </p>
          </div>

          <div className="input-group">
            <label className="label">📍 מיקומים</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.25rem' }}>
              {(settings.locations || ['ליאור', 'סגל', 'ליכטר', 'מקלט ליכטר', 'אייל']).map(loc => (
                <div key={loc} style={{
                  display: 'flex', alignItems: 'center', gap: '0.3rem',
                  padding: '0.3rem 0.5rem', borderRadius: '6px',
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  fontSize: '0.8rem', color: 'var(--text)',
                }}>
                  <span>{loc}</span>
                  {canEditSettings && (
                    <button
                      onClick={() => {
                        const current = settings.locations || ['ליאור', 'סגל', 'ליכטר', 'מקלט ליכטר', 'אייל'];
                        handleSettingsChange('locations', current.filter(l => l !== loc));
                      }}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: 'var(--text-muted)', fontSize: '0.7rem', padding: '0 0.1rem',
                        lineHeight: 1,
                      }}
                    >✕</button>
                  )}
                </div>
              ))}
            </div>
            {canEditSettings && (
              <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.5rem' }}>
                <input
                  type="text"
                  className="input"
                  value={newLocation}
                  onChange={e => setNewLocation(e.target.value)}
                  placeholder="מיקום חדש..."
                  style={{ flex: 1, fontSize: '0.85rem', direction: 'rtl' }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && newLocation.trim()) {
                      const current = settings.locations || ['ליאור', 'סגל', 'ליכטר', 'מקלט ליכטר', 'אייל'];
                      if (!current.includes(newLocation.trim())) {
                        handleSettingsChange('locations', [...current, newLocation.trim()]);
                      }
                      setNewLocation('');
                    }
                  }}
                />
                <button
                  className="btn btn-sm"
                  disabled={!newLocation.trim()}
                  onClick={() => {
                    const current = settings.locations || ['ליאור', 'סגל', 'ליכטר', 'מקלט ליכטר', 'אייל'];
                    if (!current.includes(newLocation.trim())) {
                      handleSettingsChange('locations', [...current, newLocation.trim()]);
                    }
                    setNewLocation('');
                  }}
                  style={{
                    fontSize: '0.8rem', padding: '0.35rem 0.7rem',
                    background: 'var(--primary)', color: 'white', border: 'none',
                  }}
                >+ הוסף</button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Chip Values Tab */}
      {activeTab === 'chips' && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">🎰 Chip Values</h2>
            {canEditChips && (
              <button className="btn btn-sm btn-outline" onClick={() => setShowAddChip(true)}>
                + Add Chip
              </button>
            )}
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
                disabled={!canEditChips}
              />
              {canEditChips && (
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
              )}
            </div>
          ))}
        </div>
      )}

      {/* Players Tab */}
      {activeTab === 'players' && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">👥 Players ({players.length})</h2>
            {canAddPlayers && (
              <button className="btn btn-sm btn-outline" onClick={() => setShowAddPlayer(true)}>
                + Add Player
              </button>
            )}
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
                      {player.type === 'permanent' ? '⭐ קבוע' : player.type === 'permanent_guest' ? '🏠 אורח' : '👤 מזדמן'}
                    </span>
                    <span style={{
                      fontSize: '0.65rem',
                      color: player.gender === 'female' ? '#EC4899' : '#3B82F6',
                      opacity: 0.7,
                    }}>
                      {player.gender === 'female' ? '♀' : '♂'}
                    </span>
                  </div>
                  {(canEditPlayers || canDeletePlayers) && (
                    <div style={{ display: 'flex', gap: '0.35rem' }}>
                      {canEditPlayers && (
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
                      )}
                      {canDeletePlayers && (
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
                      )}
                    </div>
                  )}
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

          {/* Storage Usage Info */}
          {storageUsage && (
            <div style={{ 
              background: storageUsage.status === 'critical' 
                ? 'rgba(239, 68, 68, 0.1)' 
                : storageUsage.status === 'warning' 
                  ? 'rgba(245, 158, 11, 0.1)' 
                  : 'var(--surface)',
              borderRadius: '8px', 
              padding: '0.75rem',
              marginBottom: '1rem',
              borderLeft: storageUsage.status === 'critical' 
                ? '4px solid var(--danger)' 
                : storageUsage.status === 'warning' 
                  ? '4px solid var(--warning)' 
                  : '4px solid var(--primary)'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                  {storageUsage.status === 'critical' ? '🚨' : storageUsage.status === 'warning' ? '⚠️' : '💾'} Storage Usage
                </span>
                <span style={{ 
                  fontSize: '0.85rem', 
                  fontWeight: '600',
                  color: storageUsage.status === 'critical' 
                    ? 'var(--danger)' 
                    : storageUsage.status === 'warning' 
                      ? 'var(--warning)' 
                      : 'var(--success)'
                }}>
                  {storageUsage.percent.toFixed(1)}%
                </span>
              </div>
              
              {/* Progress bar */}
              <div style={{ 
                width: '100%', 
                height: '8px', 
                background: 'var(--border)', 
                borderRadius: '4px',
                overflow: 'hidden',
                marginBottom: '0.5rem'
              }}>
                <div style={{ 
                  width: `${Math.min(storageUsage.percent, 100)}%`,
                  height: '100%',
                  background: storageUsage.status === 'critical' 
                    ? 'var(--danger)' 
                    : storageUsage.status === 'warning' 
                      ? 'var(--warning)' 
                      : 'var(--primary)',
                  borderRadius: '4px',
                  transition: 'width 0.3s ease'
                }} />
              </div>
              
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                <span>{formatStorageSize(storageUsage.used)} / {formatStorageSize(storageUsage.limit)}</span>
                <span>{storageUsage.gamesCount} games stored</span>
              </div>
              
              {storageUsage.status !== 'safe' && (
                <div style={{ 
                  marginTop: '0.5rem', 
                  padding: '0.5rem',
                  background: 'rgba(0,0,0,0.2)',
                  borderRadius: '6px',
                  fontSize: '0.75rem'
                }}>
                  {storageUsage.status === 'critical' ? (
                    <span style={{ color: 'var(--danger)' }}>
                      ⚠️ Storage almost full! Download a backup and clear old data to continue.
                    </span>
                  ) : (
                    <span style={{ color: 'var(--warning)' }}>
                      💡 ~{storageUsage.estimatedGamesRemaining} games remaining before storage is full. 
                      Consider downloading a backup.
                    </span>
                  )}
                </div>
              )}
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
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button 
                className="btn btn-primary" 
                onClick={handleCreateBackup}
                disabled={isBackingUp}
                style={{ flex: 1 }}
              >
                {isBackingUp ? '⏳ Saving...' : '💾 Backup Now'}
              </button>
              <button 
                className="btn btn-secondary" 
                onClick={handleDownloadBackup}
                style={{ flex: 1 }}
              >
                📥 Download
              </button>
            </div>
          </div>

          {/* Restore Actions */}
          <div style={{ marginBottom: '1rem' }}>
            <p style={{ fontSize: '0.8rem', fontWeight: '600', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
              Restore Data
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button
                className="btn btn-secondary"
                onClick={async () => {
                  setBackupMessage({ type: 'success', text: 'מוריד גיבוי מהענן...' });
                  const result = await restoreFromCloudBackup();
                  setBackupMessage({ type: result.success ? 'success' : 'error', text: result.message });
                  if (result.success) {
                    setTimeout(() => window.location.reload(), 1500);
                  }
                }}
                style={{ flex: 1, minWidth: '120px' }}
              >
                ☁️ From Cloud
              </button>
              <button 
                className="btn btn-secondary" 
                onClick={() => setShowRestoreModal(true)}
                style={{ flex: 1, minWidth: '120px' }}
              >
                🔄 From Local
              </button>
              <label 
                className="btn btn-secondary" 
                style={{ flex: 1, minWidth: '120px', textAlign: 'center', cursor: 'pointer', margin: 0 }}
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

          {/* GitHub Cloud Sync - Admin Only */}
          {role === 'admin' && (
            <div style={{ 
              background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.1), rgba(16, 185, 129, 0.1))',
              borderRadius: '8px',
              padding: '0.75rem',
              border: '1px solid rgba(59, 130, 246, 0.3)',
              marginBottom: '1rem'
            }}>
              <p style={{ fontSize: '0.8rem', fontWeight: '600', color: '#3B82F6', marginBottom: '0.5rem' }}>
                ☁️ Cloud Sync (Admin)
              </p>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
                Games sync automatically after completion. Other players receive updates on app open.
              </p>
              
              {/* Token Input */}
              <div style={{ marginBottom: '0.75rem' }}>
                <label style={{ fontSize: '0.7rem', color: 'var(--text-muted)', display: 'block', marginBottom: '0.25rem' }}>
                  GitHub Token
                </label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <input
                    type={showToken ? 'text' : 'password'}
                    value={githubToken}
                    onChange={(e) => setGithubToken(e.target.value)}
                    placeholder="ghp_..."
                    style={{
                      flex: 1,
                      padding: '0.5rem',
                      borderRadius: '6px',
                      border: '1px solid var(--border)',
                      background: 'var(--surface)',
                      color: 'var(--text)',
                      fontSize: '0.8rem'
                    }}
                  />
                  <button
                    className="btn btn-sm"
                    onClick={() => setShowToken(!showToken)}
                    style={{ padding: '0.5rem' }}
                  >
                    {showToken ? '🙈' : '👁️'}
                  </button>
                </div>
              </div>
              
              {/* Action Buttons */}
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    saveGitHubToken(githubToken);
                    setSyncMessage({ type: 'success', text: 'Token saved!' });
                    setTimeout(() => setSyncMessage(null), 2000);
                  }}
                  disabled={!githubToken}
                  style={{ 
                    flex: 1,
                    background: githubToken ? 'var(--primary)' : 'var(--surface)',
                    color: githubToken ? 'white' : 'var(--text-muted)'
                  }}
                >
                  💾 Save Token
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    setIsSyncing(true);
                    syncToCloud().then(result => {
                      setSyncMessage({ 
                        type: result.success ? 'success' : 'error', 
                        text: result.success ? '✅ Uploaded to cloud!' : `❌ ${result.message}` 
                      });
                      setIsSyncing(false);
                      setTimeout(() => setSyncMessage(null), 3000);
                    });
                  }}
                  disabled={!githubToken || isSyncing}
                  style={{ 
                    flex: 1,
                    background: githubToken ? 'linear-gradient(135deg, #3B82F6, #10B981)' : 'var(--surface)',
                    color: githubToken ? 'white' : 'var(--text-muted)'
                  }}
                >
                  {isSyncing ? '⏳ Uploading...' : '☁️ Upload Now'}
                </button>
              </div>
              
              {/* Manual Sync from Cloud */}
              <button
                className="btn btn-sm"
                onClick={() => {
                  setIsSyncing(true);
                  syncFromCloud().then(result => {
                    setSyncMessage({ 
                      type: result.success ? 'success' : 'error', 
                      text: result.success ? `✅ ${result.message}` : `❌ ${result.message}` 
                    });
                    setIsSyncing(false);
                    const hasChanges = result.synced && 
                      ((result.gamesChanged && result.gamesChanged > 0) || (result.playersChanged && result.playersChanged > 0));
                    if (hasChanges) {
                      setTimeout(() => window.location.reload(), 1500);
                    } else {
                      setTimeout(() => setSyncMessage(null), 3000);
                    }
                  });
                }}
                disabled={isSyncing}
                style={{ 
                  width: '100%',
                  marginTop: '0.5rem',
                  background: 'var(--surface)',
                  border: '1px solid var(--border)'
                }}
              >
                {isSyncing ? '⏳ Syncing...' : '⬇️ Sync from Cloud'}
              </button>
              
              {/* Sync Message */}
              {syncMessage && (
                <div style={{
                  marginTop: '0.5rem',
                  padding: '0.5rem',
                  borderRadius: '6px',
                  background: syncMessage.type === 'success' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                  color: syncMessage.type === 'success' ? '#10B981' : '#EF4444',
                  fontSize: '0.8rem',
                  textAlign: 'center'
                }}>
                  {syncMessage.text}
                </div>
              )}

              {/* Gemini API Key */}
              <div style={{ marginTop: '1rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border)' }}>
                <p style={{ fontSize: '0.8rem', fontWeight: '600', color: '#A855F7', marginBottom: '0.5rem' }}>
                  🔑 Gemini API Key
                </p>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
                  <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener noreferrer" style={{ color: '#A855F7' }}>
                    Get free API key →
                  </a>
                </p>
                <div style={{ marginBottom: '0.75rem' }}>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <input
                      type={showGeminiKey ? 'text' : 'password'}
                      value={geminiKey}
                      onChange={(e) => setGeminiKey(e.target.value)}
                      placeholder="AIza..."
                      style={{ flex: 1, padding: '0.5rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: '0.8rem' }}
                    />
                    <button className="btn btn-sm" onClick={() => setShowGeminiKey(!showGeminiKey)} style={{ padding: '0.5rem' }}>
                      {showGeminiKey ? '🙈' : '👁️'}
                    </button>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button className="btn btn-sm" onClick={() => { setGeminiApiKey(geminiKey); setGeminiMessage({ type: 'success', text: 'API key saved!' }); setTimeout(() => setGeminiMessage(null), 2000); }} disabled={!geminiKey}
                    style={{ flex: 1, background: geminiKey ? '#A855F7' : 'var(--surface)', color: geminiKey ? 'white' : 'var(--text-muted)' }}>
                    💾 Save Key
                  </button>
                  <button className="btn btn-sm" onClick={async () => { setIsTestingGemini(true); const isValid = await testGeminiApiKey(geminiKey); setGeminiMessage({ type: isValid ? 'success' : 'error', text: isValid ? '✅ API key works!' : '❌ Invalid API key' }); setIsTestingGemini(false); setTimeout(() => setGeminiMessage(null), 3000); }} disabled={!geminiKey || isTestingGemini}
                    style={{ flex: 1, background: geminiKey ? 'linear-gradient(135deg, #A855F7, #EC4899)' : 'var(--surface)', color: geminiKey ? 'white' : 'var(--text-muted)' }}>
                    {isTestingGemini ? '⏳ Testing...' : '🧪 Test Key'}
                  </button>
                </div>
                {geminiMessage && (
                  <div style={{ marginTop: '0.5rem', padding: '0.5rem', borderRadius: '6px', background: geminiMessage.type === 'success' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)', color: geminiMessage.type === 'success' ? '#10B981' : '#EF4444', fontSize: '0.8rem', textAlign: 'center' }}>
                    {geminiMessage.text}
                  </div>
                )}
              </div>

              {/* ElevenLabs API Key */}
              <div style={{ marginTop: '1rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border)' }}>
                <p style={{ fontSize: '0.8rem', fontWeight: '600', color: '#10B981', marginBottom: '0.5rem' }}>
                  🎙️ ElevenLabs API Key (TTS)
                </p>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
                  <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noopener noreferrer" style={{ color: '#10B981' }}>
                    Get free API key →
                  </a>
                  <span style={{ fontSize: '0.65rem', marginRight: '0.5rem' }}> (Text to Speech + Voices Read)</span>
                </p>
                <div style={{ marginBottom: '0.75rem' }}>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <input
                      type={showElKey ? 'text' : 'password'}
                      value={elKey}
                      onChange={(e) => setElKey(e.target.value)}
                      placeholder="sk_..."
                      style={{ flex: 1, padding: '0.5rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: '0.8rem' }}
                    />
                    <button className="btn btn-sm" onClick={() => setShowElKey(!showElKey)} style={{ padding: '0.5rem' }}>
                      {showElKey ? '🙈' : '👁️'}
                    </button>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button className="btn btn-sm" onClick={() => { setElevenLabsApiKey(elKey); setElMessage({ type: 'success', text: 'API key saved!' }); setTimeout(() => setElMessage(null), 2000); }} disabled={!elKey}
                    style={{ flex: 1, background: elKey ? '#10B981' : 'var(--surface)', color: elKey ? 'white' : 'var(--text-muted)' }}>
                    💾 Save Key
                  </button>
                  <button className="btn btn-sm" onClick={async () => {
                    setIsTestingEl(true);
                    try {
                      const res = await fetch('https://api.elevenlabs.io/v1/text-to-speech/CwhRBWXzGAHq8TQ4Fs17?output_format=mp3_22050_32', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'xi-api-key': elKey },
                        body: JSON.stringify({ text: 'שלום, זוהי בדיקת מערכת הקול. הכל תקין!', model_id: 'eleven_v3', language_code: 'he' }),
                      });
                      if (res.ok) {
                        const blob = await res.blob();
                        if (blob.size > 100) {
                          const url = URL.createObjectURL(blob);
                          const audio = new Audio(url);
                          audio.onended = () => URL.revokeObjectURL(url);
                          audio.play();
                        }
                        setElMessage({ type: 'success', text: '✅ Key works!' });
                      } else {
                        const errBody = await res.text().catch(() => '');
                        let detail = '';
                        try { detail = JSON.parse(errBody)?.detail?.message || errBody.slice(0, 100); } catch { detail = errBody.slice(0, 100); }
                        setElMessage({ type: 'error', text: `❌ ${res.status}: ${detail || res.statusText}` });
                      }
                    } catch (e) {
                      setElMessage({ type: 'error', text: `❌ ${e instanceof Error ? e.message : 'Connection failed'}` });
                    }
                    setIsTestingEl(false);
                    setTimeout(() => setElMessage(null), 5000);
                  }} disabled={!elKey || isTestingEl}
                    style={{ flex: 1, background: elKey ? 'linear-gradient(135deg, #10B981, #059669)' : 'var(--surface)', color: elKey ? 'white' : 'var(--text-muted)' }}>
                    {isTestingEl ? '⏳ Testing...' : '🧪 Test Key'}
                  </button>
                </div>
                {elMessage && (
                  <div style={{ marginTop: '0.5rem', padding: '0.5rem', borderRadius: '6px', background: elMessage.type === 'success' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)', color: elMessage.type === 'success' ? '#10B981' : '#EF4444', fontSize: '0.8rem', textAlign: 'center' }}>
                    {elMessage.text}
                  </div>
                )}
              </div>

            </div>
          )}

        </div>
      )}

      {/* AI Tab - Admin Only */}
      {activeTab === 'ai' && role === 'admin' && (() => {
        const todayActions = getTodayActions();
        const todayTokens = getTodayTokens();
        const todayLog = getTodayLog();
        void aiTick;

        const formatTokens = (n: number): string => {
          if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
          if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
          return String(n);
        };

        const contentModel = aiTestResults?.find(r => r.status === 'available');
        const contentBlocked = aiTestResults && !contentModel;
        const ttsResults = aiTestResults?.filter(r => r.model.includes('-tts')) || [];

        const gameReady = aiTestResults
          ? (!!contentModel && ttsResults.some(r => r.status === 'available'))
          : null;

        return (
          <>
            {/* Game Readiness Card */}
            <div className="card" style={{ padding: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h2 className="card-title" style={{ margin: 0 }}>🤖 מוכנות AI למשחק</h2>
                <button
                  className="btn btn-sm"
                  onClick={async () => {
                    setIsTestingModels(true);
                    setAiTestResults(null);

                    const contentTests = await testModelAvailability();

                    const ttsModels = ['gemini-2.5-flash-preview-tts'];
                    const ttsTests: ModelTestResult[] = [];
                    for (const model of ttsModels) {
                      try {
                        const res = await fetch(
                          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
                          {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              contents: [{ parts: [{ text: 'קרא את הטקסט הבא בעברית:\n\nשלום, זוהי בדיקת מערכת הקול. הכל תקין.' }] }],
                              generationConfig: {
                                responseModalities: ['AUDIO'],
                                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
                              },
                            }),
                          }
                        );
                        const shortName = 'Flash TTS';
                        const remStr = res.headers.get('x-ratelimit-remaining');
                        const limStr = res.headers.get('x-ratelimit-limit');
                        const remaining = remStr ? Number(remStr) : undefined;
                        const limit = limStr ? Number(limStr) : undefined;
                        if (res.ok) {
                          ttsTests.push({ model, displayName: shortName, status: 'available', remaining, limit });
                        } else if (res.status === 429) {
                          ttsTests.push({ model, displayName: shortName, status: 'rate_limited', remaining, limit });
                        } else {
                          ttsTests.push({ model, displayName: shortName, status: 'error' });
                        }
                      } catch {
                        ttsTests.push({ model, displayName: 'Flash TTS', status: 'error' });
                      }
                    }

                    // Test ElevenLabs TTS
                    if (elKey) {
                      try {
                        const [ttsRes, elUsage] = await Promise.all([
                          fetch('https://api.elevenlabs.io/v1/text-to-speech/CwhRBWXzGAHq8TQ4Fs17?output_format=mp3_22050_32', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'xi-api-key': elKey },
                            body: JSON.stringify({ text: 'בדיקה קצרה', model_id: 'eleven_v3', language_code: 'he' }),
                          }),
                          getElevenLabsUsageLive(elKey),
                        ]);
                        const remaining = elUsage?.remaining;
                        const limit = elUsage?.limit;
                        const resetDate = elUsage?.resetDate;
                        if (ttsRes.ok) {
                          ttsTests.push({ model: 'elevenlabs-tts', displayName: `ElevenLabs${resetDate ? ` (מתחדש ${resetDate})` : ''}`, status: 'available', remaining, limit });
                        } else if (ttsRes.status === 429) {
                          ttsTests.push({ model: 'elevenlabs-tts', displayName: `ElevenLabs${resetDate ? ` (מתחדש ${resetDate})` : ''}`, status: 'rate_limited', remaining, limit });
                        } else {
                          ttsTests.push({ model: 'elevenlabs-tts', displayName: 'ElevenLabs', status: 'error' });
                        }
                      } catch {
                        ttsTests.push({ model: 'elevenlabs-tts', displayName: 'ElevenLabs', status: 'error' });
                      }
                    }

                    // Test Edge TTS (Microsoft Neural voices — only works in Edge browser)
                    if (isEdgeBrowser()) {
                      try {
                        const { default: EdgeTTSBrowser } = await import('@kingdanx/edge-tts-browser');
                        const edgeTts = new EdgeTTSBrowser({ text: 'שלום, בדיקה', voice: 'he-IL-HilaNeural' });
                        const blob = await Promise.race([
                          edgeTts.ttsToFile(),
                          new Promise<never>((_r, rej) => setTimeout(() => rej(new Error('timeout')), 6000)),
                        ]);
                        if (blob && blob.size > 100) {
                          ttsTests.push({ model: 'edge-tts', displayName: 'Edge TTS (Microsoft)', status: 'available' });
                        } else {
                          ttsTests.push({ model: 'edge-tts', displayName: 'Edge TTS (Microsoft)', status: 'error' });
                        }
                      } catch {
                        ttsTests.push({ model: 'edge-tts', displayName: 'Edge TTS (Microsoft)', status: 'error' });
                      }
                    }

                    setAiTestResults([...contentTests, ...ttsTests]);
                    setAiStatus(getAIStatus());
                    setIsTestingModels(false);
                  }}
                  disabled={isTestingModels || !geminiKey}
                  style={{ fontSize: '0.7rem', padding: '0.3rem 0.7rem', background: 'var(--primary)', color: 'white', border: 'none', borderRadius: 8 }}
                >
                  {isTestingModels ? '⏳ בודק...' : '🔍 בדוק עכשיו'}
                </button>
              </div>

              {!geminiKey && (
                <div style={{ textAlign: 'center', padding: '1rem 0', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                  הגדר מפתח Gemini API למעלה כדי להשתמש בתכונות AI
                </div>
              )}

              {geminiKey && !aiTestResults && !isTestingModels && (
                <div style={{ textAlign: 'center', padding: '1rem 0', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                  לחץ ״בדוק עכשיו״ לבדוק אם אפשר להתחיל משחק
                </div>
              )}

              {isTestingModels && (
                <div style={{ textAlign: 'center', padding: '1rem 0', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                  ⏳ בודק חיבור לכל המודלים...
                </div>
              )}

              {/* Results */}
              {aiTestResults && !isTestingModels && (
                <>
                  {/* Big readiness indicator */}
                  <div style={{
                    textAlign: 'center', padding: '0.8rem', borderRadius: 10, marginBottom: '1rem',
                    background: gameReady ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
                    border: `1px solid ${gameReady ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'}`,
                  }}>
                    <div style={{ fontSize: '1.5rem', marginBottom: '0.3rem' }}>{gameReady ? '✅' : '⚠️'}</div>
                    <div style={{ fontSize: '0.9rem', fontWeight: 700, color: gameReady ? '#10B981' : '#EF4444', direction: 'rtl' }}>
                      {gameReady ? 'אפשר להתחיל משחק!' : contentBlocked ? 'אי אפשר לייצר תחזית וסיכום כרגע' : 'חלק מהתכונות לא זמינות'}
                    </div>
                  </div>

                  {/* Feature checklist */}
                  {(() => {
                    const contentOk = !!contentModel;
                    const ttsOk = ttsResults.some(r => r.status === 'available');

                    const featureRow = (icon: string, label: string, ok: boolean, modelName?: string, remaining?: number, limit?: number, capacityLabel?: string) => (
                      <div style={{ padding: '0.5rem 0', borderBottom: '1px solid var(--border)', direction: 'rtl' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <span style={{ fontSize: '1rem' }}>{icon}</span>
                          <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text)', flex: 1 }}>{label}</span>
                          <span style={{
                            fontSize: '0.75rem', fontWeight: 600, padding: '0.15rem 0.5rem', borderRadius: 6,
                            background: ok ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
                            color: ok ? '#10B981' : '#EF4444',
                          }}>
                            {ok ? 'עובד' : 'חסום'}
                          </span>
                        </div>
                        {(modelName || (remaining != null && limit != null)) && (
                          <div style={{ display: 'flex', gap: '0.75rem', paddingRight: '1.75rem', marginTop: '0.25rem', flexWrap: 'wrap' }}>
                            {modelName && (
                              <span style={{ fontSize: '0.65rem', color: '#A855F7' }}>
                                מודל: {modelName}
                              </span>
                            )}
                            {remaining != null && limit != null && (
                              <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
                                נשאר {remaining} מתוך {limit} קריאות{capacityLabel ? ` (${capacityLabel})` : ''}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    );

                    const contentRemaining = contentModel?.remaining;
                    const contentLimit = contentModel?.limit;
                    const contentCapacity = contentRemaining != null ? `~${Math.floor(contentRemaining / 2)} משחקים` : undefined;

                    const geminiTts = ttsResults.find(r => r.model.startsWith('gemini'));
                    const geminiTtsCapacity = geminiTts?.remaining != null ? `~${geminiTts.remaining} הכרזות` : undefined;

                    return (
                      <div style={{ marginBottom: '0.5rem' }}>
                        {featureRow('🔮', 'תחזית לפני משחק', contentOk, contentModel?.displayName, contentRemaining, contentLimit, contentCapacity)}
                        {featureRow('📝', 'סיכום אחרי משחק', contentOk, contentModel?.displayName)}

                        {/* TTS engines — show each individually */}
                        <div style={{ padding: '0.5rem 0', borderBottom: '1px solid var(--border)', direction: 'rtl' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem' }}>
                            <span style={{ fontSize: '1rem' }}>🔊</span>
                            <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text)', flex: 1 }}>הכרזות קול במשחק</span>
                            <span style={{
                              fontSize: '0.75rem', fontWeight: 600, padding: '0.15rem 0.5rem', borderRadius: 6,
                              background: ttsOk ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
                              color: ttsOk ? '#10B981' : '#EF4444',
                            }}>
                              {ttsOk ? 'עובד' : 'חסום'}
                            </span>
                          </div>

                          {ttsResults.map(r => {
                            const isOk = r.status === 'available';
                            const isRateLimited = r.status === 'rate_limited';
                            const statusColor = isOk ? '#10B981' : isRateLimited ? '#F59E0B' : '#EF4444';
                            const statusText = isOk ? '✓' : isRateLimited ? 'מוגבל' : '✗';
                            return (
                              <div key={r.model} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', paddingRight: '1.75rem', marginTop: '0.25rem' }}>
                                <span style={{ fontSize: '0.65rem', fontWeight: 600, color: statusColor, minWidth: '1rem' }}>{statusText}</span>
                                <span style={{ fontSize: '0.7rem', color: 'var(--text)', flex: 1 }}>{r.displayName}</span>
                                {r.remaining != null && r.limit != null && (
                                  <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                                    {r.model === 'elevenlabs-tts'
                                      ? `${r.remaining.toLocaleString()} / ${r.limit.toLocaleString()} תווים (~${Math.floor(r.remaining / 1300)} משחקים)`
                                      : `${r.remaining} / ${r.limit} קריאות${geminiTtsCapacity && r.model.startsWith('gemini') ? ` (${geminiTtsCapacity})` : ''}`
                                    }
                                  </span>
                                )}
                                {r.model === 'edge-tts' && isOk && (
                                  <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>ללא הגבלה</span>
                                )}
                              </div>
                            );
                          })}

                          {!ttsOk && ttsResults.length > 0 && (
                            <div style={{ fontSize: '0.65rem', color: '#F59E0B', paddingRight: '1.75rem', direction: 'rtl', marginTop: '0.4rem' }}>
                              {isEdgeBrowser()
                                ? 'הקול ייפול ל-Edge TTS (Microsoft) או לדפדפן'
                                : 'הקול ייפול לדפדפן — פתח ב-Edge לאיכות טובה יותר'}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                </>
              )}
            </div>

            {/* ElevenLabs TTS Usage Card */}
            {elKey && (() => {
              const history = getElevenLabsGameHistory();
              const totalGameChars = history.reduce((s, h) => s + h.charsUsed, 0);
              const avgPerGame = history.length > 0 ? Math.round(totalGameChars / history.length) : 0;
              const used = elUsageLive?.used ?? 0;
              const limit = elUsageLive?.limit ?? 10000;
              const remaining = elUsageLive?.remaining ?? (limit - used);
              const resetDate = elUsageLive?.resetDate;
              const usedPct = Math.round((used / limit) * 100);
              const gamesLeft = avgPerGame > 0 ? Math.floor(remaining / avgPerGame) : Math.floor(remaining / 1300);

              return (
                <div className="card" style={{ padding: '1rem' }}>
                  <h2 className="card-title" style={{ margin: '0 0 0.75rem' }}>🎙️ שימוש ElevenLabs TTS</h2>
                  <div style={{ direction: 'rtl', textAlign: 'right' }}>

                    {/* Monthly quota bar */}
                    <div style={{ marginBottom: '0.75rem' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.3rem' }}>
                        <span style={{ fontSize: '0.7rem', color: 'var(--text)' }}>
                          {elUsageLive ? `${used.toLocaleString()} / ${limit.toLocaleString()} תווים` : 'טוען...'}
                        </span>
                        <span style={{ fontSize: '0.65rem', color: usedPct > 80 ? '#EF4444' : usedPct > 50 ? '#F59E0B' : '#10B981', fontWeight: 600 }}>
                          {elUsageLive ? `${remaining.toLocaleString()} נשאר` : ''}
                        </span>
                      </div>
                      <div style={{ height: 8, background: 'var(--surface)', borderRadius: 4, overflow: 'hidden' }}>
                        <div style={{
                          width: `${usedPct}%`, height: '100%', borderRadius: 4, transition: 'width 0.5s',
                          background: usedPct > 80 ? '#EF4444' : usedPct > 50 ? '#F59E0B' : '#10B981',
                        }} />
                      </div>
                      {resetDate && (
                        <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                          מתאפס ב-{resetDate} · ~{gamesLeft} משחקים נותרו
                        </div>
                      )}
                    </div>

                    {/* Stats row */}
                    {history.length > 0 && (
                      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                        <div style={{ background: 'rgba(168,85,247,0.08)', borderRadius: 8, padding: '0.4rem 0.6rem', flex: 1, textAlign: 'center' }}>
                          <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#A855F7' }}>{avgPerGame.toLocaleString()}</div>
                          <div style={{ fontSize: '0.55rem', color: 'var(--text-muted)' }}>ממוצע למשחק</div>
                        </div>
                        <div style={{ background: 'rgba(59,130,246,0.08)', borderRadius: 8, padding: '0.4rem 0.6rem', flex: 1, textAlign: 'center' }}>
                          <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#3B82F6' }}>{history.length}</div>
                          <div style={{ fontSize: '0.55rem', color: 'var(--text-muted)' }}>משחקים עם TTS</div>
                        </div>
                        <div style={{ background: 'rgba(16,185,129,0.08)', borderRadius: 8, padding: '0.4rem 0.6rem', flex: 1, textAlign: 'center' }}>
                          <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#10B981' }}>{totalGameChars.toLocaleString()}</div>
                          <div style={{ fontSize: '0.55rem', color: 'var(--text-muted)' }}>סה״כ תווים</div>
                        </div>
                      </div>
                    )}

                    {/* Per-game breakdown */}
                    {history.length > 0 ? (
                      <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.5rem' }}>
                        <div style={{ fontSize: '0.65rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.3rem' }}>שימוש לפי משחק</div>
                        {history.slice(0, 10).map((h, i) => {
                          const d = new Date(h.date);
                          const dateStr = d.toLocaleDateString('he-IL', { day: 'numeric', month: 'short' });
                          const dayStr = d.toLocaleDateString('he-IL', { weekday: 'short' });
                          const pct = Math.round((h.charsUsed / limit) * 100);
                          return (
                            <div key={h.gameId} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.3rem 0', borderBottom: i < Math.min(history.length, 10) - 1 ? '1px solid var(--border)' : 'none' }}>
                              <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', minWidth: '55px' }}>{dayStr} {dateStr}</span>
                              <div style={{ flex: 1, height: 6, background: 'var(--surface)', borderRadius: 3, overflow: 'hidden' }}>
                                <div style={{ width: `${Math.min(pct * 4, 100)}%`, height: '100%', background: pct > 15 ? '#F59E0B' : '#10B981', borderRadius: 3 }} />
                              </div>
                              <span style={{ fontSize: '0.65rem', fontWeight: 600, color: 'var(--text)', minWidth: '48px', textAlign: 'left' }}>{h.charsUsed.toLocaleString()} תו</span>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textAlign: 'center', padding: '0.5rem 0', borderTop: '1px solid var(--border)' }}>
                        נתוני שימוש למשחק יופיעו אחרי המשחק הבא
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* Today's Usage Card */}
            <div className="card" style={{ padding: '1rem' }}>
              <h2 className="card-title" style={{ margin: '0 0 0.75rem' }}>📊 שימוש היום</h2>
              <div style={{ direction: 'rtl', textAlign: 'right' }}>
                {(() => {
                  const actionSummary = Object.entries(todayActions)
                    .filter(([, count]) => count > 0)
                    .map(([action, count]) => `${action} ×${count}`)
                    .join(' · ');
                  return actionSummary ? (
                    <>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text)', marginBottom: '0.2rem' }}>
                        {actionSummary}
                      </div>
                      <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
                        {Object.values(todayActions).reduce((s, c) => s + c, 0)} קריאות · {formatTokens(todayTokens)} טוקנים
                      </div>
                    </>
                  ) : (
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textAlign: 'center' }}>
                      אין פעילות AI היום
                    </div>
                  );
                })()}
              </div>

              {/* Activity Log (collapsible) */}
              {todayLog.length > 0 && (
                <>
                  <div style={{ height: '1px', background: 'var(--border)', margin: '0.75rem 0' }} />
                  <button
                    onClick={() => setShowAiLog(!showAiLog)}
                    style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 0, color: 'var(--text-muted)' }}
                  >
                    <span style={{ fontSize: '0.7rem', fontWeight: 600 }}>📋 לוג פעילות ({todayLog.length})</span>
                    <span style={{ fontSize: '0.6rem', transform: showAiLog ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>▼</span>
                  </button>

                  {showAiLog && (
                    <div style={{ marginTop: '0.5rem', maxHeight: '200px', overflowY: 'auto' }}>
                      {[...todayLog].reverse().map((entry, i) => {
                        const time = new Date(entry.timestamp).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
                        const displayModel = getModelDisplayName(entry.model);
                        const hasFallback = !!entry.fallbackFrom;
                        return (
                          <div key={i} style={{
                            display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.3rem 0',
                            borderRight: hasFallback ? '2px solid #F59E0B' : '2px solid transparent',
                            paddingRight: '0.4rem', fontSize: '0.65rem', direction: 'ltr',
                          }}>
                            <span style={{ color: 'var(--text-muted)', minWidth: '36px' }}>{time}</span>
                            <span style={{ color: 'var(--text)', minWidth: '50px', fontWeight: 500 }}>{entry.action}</span>
                            <span style={{ color: '#A855F7', minWidth: '60px' }}>{displayModel}</span>
                            <span style={{ color: entry.success ? 'var(--text-muted)' : '#F59E0B', flex: 1, textAlign: 'right' }}>
                              {entry.success
                                ? (entry.tokens > 0 ? `${formatTokens(entry.tokens)} tok` : '✓')
                                : `⚠ 429`}
                              {hasFallback && ` ← ${getModelDisplayName(entry.fallbackFrom!)}`}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}

              <div style={{ display: 'flex', justifyContent: 'center', marginTop: '0.75rem' }}>
                <button
                  className="btn btn-sm"
                  onClick={() => { if (confirm('לאפס את כל נתוני השימוש?')) { resetUsage(); setAiStatus(getAIStatus()); setAiTestResults(null); } }}
                  style={{ fontSize: '0.6rem', padding: '0.2rem 0.5rem', background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)' }}
                >
                  🗑️ איפוס נתונים
                </button>
              </div>
            </div>
          </>
        );
      })()}

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

      {/* Activity Tab - Admin Only */}
      {activeTab === 'activity' && role === 'admin' && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">📊 Activity Log</h2>
            <div style={{ display: 'flex', gap: '0.4rem' }}>
              <button
                onClick={loadActivityLog}
                disabled={activityLoading}
                style={{
                  fontSize: '0.75rem', padding: '0.3rem 0.6rem', borderRadius: '6px',
                  background: 'var(--surface-hover)', color: 'var(--text-muted)',
                  border: '1px solid var(--border)', cursor: 'pointer',
                }}
              >
                {activityLoading ? '...' : '🔄 Refresh'}
              </button>
              {activityLog.length > 0 && (
                <button
                  onClick={handleClearActivityLog}
                  disabled={activityLoading}
                  style={{
                    fontSize: '0.75rem', padding: '0.3rem 0.6rem', borderRadius: '6px',
                    background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444',
                    border: '1px solid rgba(239, 68, 68, 0.3)', cursor: 'pointer',
                  }}
                >
                  🗑️ Clear
                </button>
              )}
            </div>
          </div>

          {activityError && (
            <div style={{ padding: '0.5rem', color: '#ef4444', fontSize: '0.8rem', marginTop: '0.5rem' }}>
              {activityError}
            </div>
          )}

          {activityLog.length === 0 && !activityLoading && !activityError && (
            <div style={{ textAlign: 'center', padding: '2rem 1rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>📊</div>
              No activity recorded yet. Press Refresh to load.
            </div>
          )}

          {activityLoading && (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              Loading activity log...
            </div>
          )}

          {!activityLoading && activityLog.length > 0 && (() => {
            // Build device profiles from all entries
            const deviceMap = new Map<string, { entries: ActivityLogEntry[]; latest: ActivityLogEntry }>();
            for (const entry of activityLog) {
              const existing = deviceMap.get(entry.deviceId);
              if (!existing) {
                deviceMap.set(entry.deviceId, { entries: [entry], latest: entry });
              } else {
                existing.entries.push(entry);
                if (new Date(entry.timestamp) > new Date(existing.latest.timestamp)) {
                  existing.latest = entry;
                }
              }
            }
            const devices = Array.from(deviceMap.entries()).sort((a, b) =>
              new Date(b[1].latest.timestamp).getTime() - new Date(a[1].latest.timestamp).getTime()
            );

            const shortenGPU = (gpu: string): string => {
              if (!gpu || gpu === 'Unknown') return '—';
              return gpu
                .replace(/ANGLE \(/, '').replace(/\)$/, '')
                .replace(/Direct3D\d+\s*vs_\S+\s*ps_\S+\s*/, '')
                .replace(/,\s*D3D\d+.*/, '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 40);
            };

            return (
              <div>
                {/* Device Cards */}
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.5rem', marginBottom: '0.5rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  {devices.length} Known Device{devices.length !== 1 ? 's' : ''}
                </div>

                {devices.map(([deviceId, { entries, latest }]) => {
                  const label = deviceLabels[deviceId];
                  const isEditing = editingDeviceId === deviceId;
                  const roleInfo = getRoleInfo(latest.role);
                  const fp = latest.fingerprint;
                  const totalSessions = entries.length;
                  const totalMinutes = entries.reduce((s, e) => s + (e.sessionDuration || 0), 0);
                  const lastSeen = formatRelativeTime(latest.lastActive || latest.timestamp);

                  return (
                    <div
                      key={deviceId}
                      style={{
                        padding: '0.65rem',
                        borderRadius: '10px',
                        background: 'var(--surface)',
                        marginBottom: '0.5rem',
                        border: label ? '1px solid rgba(99, 102, 241, 0.3)' : '1px solid var(--border)',
                      }}
                    >
                      {/* Header: Label/Name + role badge */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: isEditing ? '0.25rem' : '0.4rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flex: 1, minWidth: 0 }}>
                          {!isEditing && (
                            <button
                              onClick={() => { setEditingDeviceId(deviceId); setEditLabelValue(label || ''); }}
                              style={{
                                fontSize: label ? '0.95rem' : '0.82rem',
                                fontWeight: label ? '700' : '500',
                                color: label ? 'var(--text)' : '#818cf8',
                                cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                background: 'none', border: 'none', padding: 0,
                                textAlign: 'left', minWidth: 0,
                              }}
                              title="Click to assign player name"
                            >
                              {label || '+ Assign Name'}
                            </button>
                          )}
                        </div>
                        <span style={{
                          fontSize: '0.65rem', padding: '0.15rem 0.4rem', borderRadius: '4px',
                          background: `${roleInfo.color}20`, color: roleInfo.color, fontWeight: '600',
                          whiteSpace: 'nowrap',
                        }}>
                          {roleInfo.emoji} {roleInfo.name}
                        </span>
                      </div>
                      {isEditing && (
                        <div style={{ display: 'flex', gap: '0.25rem', marginBottom: '0.4rem' }}>
                          <input
                            type="text"
                            value={editLabelValue}
                            onChange={e => setEditLabelValue(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter') saveDeviceLabel(deviceId, editLabelValue);
                              if (e.key === 'Escape') setEditingDeviceId(null);
                            }}
                            placeholder="Player name..."
                            autoFocus
                            style={{
                              flex: 1, padding: '0.25rem 0.5rem', fontSize: '0.8rem',
                              borderRadius: '6px', border: '1px solid var(--primary)',
                              background: 'var(--background)', color: 'var(--text)',
                              outline: 'none', minWidth: '80px',
                            }}
                          />
                          <button
                            onClick={() => saveDeviceLabel(deviceId, editLabelValue)}
                            style={{
                              fontSize: '0.75rem', padding: '0.2rem 0.5rem', borderRadius: '6px',
                              background: 'var(--primary)', color: 'white', border: 'none', cursor: 'pointer',
                            }}
                          >
                            Save
                          </button>
                          <button
                            onClick={() => setEditingDeviceId(null)}
                            style={{
                              fontSize: '0.75rem', padding: '0.2rem 0.4rem', borderRadius: '6px',
                              background: 'var(--surface-hover)', color: 'var(--text-muted)', border: 'none', cursor: 'pointer',
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      )}

                      {/* Device identity line */}
                      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '0.35rem', lineHeight: '1.45' }}>
                        <span style={{ color: 'var(--text)', fontWeight: 500 }}>{latest.device}</span>
                        {!label && (
                          <>
                            <span style={{ margin: '0 0.3rem', opacity: 0.4 }}>|</span>
                            {latest.screenSize}
                            {fp && fp.gpu !== 'Unknown' && (
                              <>
                                <span style={{ margin: '0 0.3rem', opacity: 0.4 }}>|</span>
                                <span title={fp.gpu}>{shortenGPU(fp.gpu)}</span>
                              </>
                            )}
                          </>
                        )}
                      </div>

                      {/* Fingerprint details - only for unidentified devices */}
                      {!label && fp && (
                        <div style={{
                          display: 'flex', flexWrap: 'wrap', gap: '0.3rem',
                          marginBottom: '0.35rem',
                        }}>
                          {fp.cores > 0 && (
                            <span style={{
                              fontSize: '0.62rem', padding: '0.1rem 0.35rem', borderRadius: '4px',
                              background: 'rgba(59, 130, 246, 0.1)', color: '#60a5fa',
                            }}>
                              {fp.cores} cores
                            </span>
                          )}
                          {fp.memory > 0 && (
                            <span style={{
                              fontSize: '0.62rem', padding: '0.1rem 0.35rem', borderRadius: '4px',
                              background: 'rgba(16, 185, 129, 0.1)', color: '#34d399',
                            }}>
                              {fp.memory}GB RAM
                            </span>
                          )}
                          {fp.touchPoints > 0 && (
                            <span style={{
                              fontSize: '0.62rem', padding: '0.1rem 0.35rem', borderRadius: '4px',
                              background: 'rgba(245, 158, 11, 0.1)', color: '#fbbf24',
                            }}>
                              {fp.touchPoints} touch
                            </span>
                          )}
                          {fp.language && (
                            <span style={{
                              fontSize: '0.62rem', padding: '0.1rem 0.35rem', borderRadius: '4px',
                              background: 'rgba(139, 92, 246, 0.1)', color: '#a78bfa',
                            }}>
                              {fp.language}
                            </span>
                          )}
                          {fp.canvasHash && (
                            <span style={{
                              fontSize: '0.62rem', padding: '0.1rem 0.35rem', borderRadius: '4px',
                              background: 'rgba(236, 72, 153, 0.1)', color: '#f472b6',
                            }}
                            title={`Unique canvas fingerprint: ${fp.canvasHash}`}
                            >
                              #{fp.canvasHash.slice(0, 6)}
                            </span>
                          )}
                        </div>
                      )}

                      {/* Stats row */}
                      <div style={{
                        display: 'flex', gap: '0.6rem', alignItems: 'center',
                        fontSize: '0.68rem', color: 'var(--text-muted)',
                        padding: '0.3rem 0', borderTop: '1px solid var(--border)',
                      }}>
                        <span>{totalSessions} session{totalSessions !== 1 ? 's' : ''}</span>
                        <span style={{ opacity: 0.4 }}>|</span>
                        <span>{totalMinutes < 1 ? '<1' : Math.round(totalMinutes)} min total</span>
                        <span style={{ opacity: 0.4 }}>|</span>
                        <span>Last: {lastSeen}</span>
                      </div>

                      {/* Recent sessions (last 3) */}
                      {entries.slice(0, 3).map((entry, i) => (
                        <div
                          key={`${entry.timestamp}-${i}`}
                          style={{
                            marginTop: '0.3rem',
                            padding: '0.3rem 0.4rem',
                            borderRadius: '6px',
                            background: 'var(--background)',
                            fontSize: '0.68rem',
                            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          }}
                        >
                          <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flex: 1, minWidth: 0 }}>
                            {entry.sessionDuration > 0 && (
                              <span style={{ color: '#818cf8', fontWeight: 500, whiteSpace: 'nowrap' }}>
                                {entry.sessionDuration < 1 ? '<1' : Math.round(entry.sessionDuration)}m
                              </span>
                            )}
                            {entry.screensVisited.length > 0 && (
                              <span style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {entry.screensVisited.join(' > ')}
                              </span>
                            )}
                          </div>
                          <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap', marginLeft: '0.5rem', opacity: 0.7 }}>
                            {formatRelativeTime(entry.timestamp)}
                          </span>
                        </div>
                      ))}
                      {entries.length > 3 && (
                        <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', textAlign: 'center', marginTop: '0.25rem', opacity: 0.6 }}>
                          +{entries.length - 3} older session{entries.length - 3 !== 1 ? 's' : ''}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}

          <div style={{ marginTop: '0.75rem', fontSize: '0.7rem', color: 'var(--text-muted)', textAlign: 'center' }}>
            {activityLog.length > 0 && `${activityLog.length} entries (max 200)`}
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
              <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                <button
                  className="btn"
                  style={{
                    flex: 1,
                    minWidth: '70px',
                    fontSize: '0.8rem',
                    padding: '0.5rem',
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
                    minWidth: '70px',
                    fontSize: '0.8rem',
                    padding: '0.5rem',
                    background: newPlayerType === 'permanent_guest' ? 'rgba(100, 100, 100, 0.2)' : 'var(--surface)',
                    border: newPlayerType === 'permanent_guest' ? '2px solid var(--text-muted)' : '1px solid var(--border)',
                    color: newPlayerType === 'permanent_guest' ? 'var(--text)' : 'var(--text-muted)'
                  }}
                  onClick={() => setNewPlayerType('permanent_guest')}
                >
                  🏠 אורח
                </button>
                <button
                  className="btn"
                  style={{
                    flex: 1,
                    minWidth: '70px',
                    fontSize: '0.8rem',
                    padding: '0.5rem',
                    background: newPlayerType === 'guest' ? 'rgba(100, 100, 100, 0.2)' : 'var(--surface)',
                    border: newPlayerType === 'guest' ? '2px solid var(--text-muted)' : '1px solid var(--border)',
                    color: newPlayerType === 'guest' ? 'var(--text)' : 'var(--text-muted)'
                  }}
                  onClick={() => setNewPlayerType('guest')}
                >
                  👤 מזדמן
                </button>
              </div>
            </div>
            <div className="input-group">
              <label className="label">Gender</label>
              <div style={{ display: 'flex', gap: '0.35rem' }}>
                <button
                  className="btn"
                  style={{
                    flex: 1,
                    fontSize: '0.8rem',
                    padding: '0.5rem',
                    background: newPlayerGender === 'male' ? 'rgba(59, 130, 246, 0.2)' : 'var(--surface)',
                    border: newPlayerGender === 'male' ? '2px solid #3B82F6' : '1px solid var(--border)',
                    color: newPlayerGender === 'male' ? '#3B82F6' : 'var(--text-muted)'
                  }}
                  onClick={() => setNewPlayerGender('male')}
                >
                  ♂ זכר
                </button>
                <button
                  className="btn"
                  style={{
                    flex: 1,
                    fontSize: '0.8rem',
                    padding: '0.5rem',
                    background: newPlayerGender === 'female' ? 'rgba(236, 72, 153, 0.2)' : 'var(--surface)',
                    border: newPlayerGender === 'female' ? '2px solid #EC4899' : '1px solid var(--border)',
                    color: newPlayerGender === 'female' ? '#EC4899' : 'var(--text-muted)'
                  }}
                  onClick={() => setNewPlayerGender('female')}
                >
                  ♀ נקבה
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
              <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                <button
                  className="btn"
                  style={{
                    flex: 1,
                    minWidth: '70px',
                    fontSize: '0.8rem',
                    padding: '0.5rem',
                    background: editPlayerType === 'permanent' ? 'rgba(16, 185, 129, 0.2)' : 'var(--surface)',
                    border: editPlayerType === 'permanent' ? '2px solid var(--primary)' : '1px solid var(--border)',
                    color: editPlayerType === 'permanent' ? 'var(--primary)' : 'var(--text-muted)'
                  }}
                  onClick={() => setEditPlayerType('permanent')}
                >
                  ⭐ קבוע
                </button>
                <button
                  className="btn"
                  style={{
                    flex: 1,
                    minWidth: '70px',
                    fontSize: '0.8rem',
                    padding: '0.5rem',
                    background: editPlayerType === 'permanent_guest' ? 'rgba(100, 100, 100, 0.2)' : 'var(--surface)',
                    border: editPlayerType === 'permanent_guest' ? '2px solid var(--text-muted)' : '1px solid var(--border)',
                    color: editPlayerType === 'permanent_guest' ? 'var(--text)' : 'var(--text-muted)'
                  }}
                  onClick={() => setEditPlayerType('permanent_guest')}
                >
                  🏠 אורח
                </button>
                <button
                  className="btn"
                  style={{
                    flex: 1,
                    minWidth: '70px',
                    fontSize: '0.8rem',
                    padding: '0.5rem',
                    background: editPlayerType === 'guest' ? 'rgba(100, 100, 100, 0.2)' : 'var(--surface)',
                    border: editPlayerType === 'guest' ? '2px solid var(--text-muted)' : '1px solid var(--border)',
                    color: editPlayerType === 'guest' ? 'var(--text)' : 'var(--text-muted)'
                  }}
                  onClick={() => setEditPlayerType('guest')}
                >
                  👤 מזדמן
                </button>
              </div>
            </div>
            <div className="input-group">
              <label className="label">Gender</label>
              <div style={{ display: 'flex', gap: '0.35rem' }}>
                <button
                  className="btn"
                  style={{
                    flex: 1,
                    fontSize: '0.8rem',
                    padding: '0.5rem',
                    background: editPlayerGender === 'male' ? 'rgba(59, 130, 246, 0.2)' : 'var(--surface)',
                    border: editPlayerGender === 'male' ? '2px solid #3B82F6' : '1px solid var(--border)',
                    color: editPlayerGender === 'male' ? '#3B82F6' : 'var(--text-muted)'
                  }}
                  onClick={() => setEditPlayerGender('male')}
                >
                  ♂ זכר
                </button>
                <button
                  className="btn"
                  style={{
                    flex: 1,
                    fontSize: '0.8rem',
                    padding: '0.5rem',
                    background: editPlayerGender === 'female' ? 'rgba(236, 72, 153, 0.2)' : 'var(--surface)',
                    border: editPlayerGender === 'female' ? '2px solid #EC4899' : '1px solid var(--border)',
                    color: editPlayerGender === 'female' ? '#EC4899' : 'var(--text-muted)'
                  }}
                  onClick={() => setEditPlayerGender('female')}
                >
                  ♀ נקבה
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

