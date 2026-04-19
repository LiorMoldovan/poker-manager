import { useState, useEffect, useCallback } from 'react';
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh';
import { useNavigate } from 'react-router-dom';
import { Player, PlayerType, PlayerGender, ChipValue, Settings, BlockedTransferPair } from '../types';
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
  playerHasGames,
  getAllGames
} from '../database/storage';
import { getGeminiApiKey, getModelDisplayName, testModelAvailability, ModelTestResult } from '../utils/geminiAI';
import { getElevenLabsApiKey, getElevenLabsUsageLive, getElevenLabsGameHistory, deleteElevenLabsGameEntry } from '../utils/tts';
import { proxyGeminiGenerate, proxyElevenLabsTTS } from '../utils/apiProxy';
import { getAIStatus, getTodayActions, getTodayTokens, getTodayLog, resetUsage, type AIStatusData } from '../utils/aiUsageTracker';
import { fetchActivityLog, clearActivityLog } from '../utils/activityLogger';
import { ActivityLogEntry } from '../types';
import { APP_VERSION, CHANGELOG } from '../version';
import { isEdgeBrowser } from '../utils/tts';
import { usePermissions } from '../App';
import { getRoleDisplayName, getRoleEmoji } from '../permissions';
import { supabase } from '../database/supabaseClient';
import TrainingAdminTab from '../components/TrainingAdminTab';
import GroupManagementTab from '../components/GroupManagementTab';
import type { GroupMember } from '../hooks/useSupabaseAuth';
import { useTranslation } from '../i18n';

const SettingsScreen = () => {
  const navigate = useNavigate();
  const { t, isRTL } = useTranslation();
  const { role, isOwner, isSuperAdmin, playerName: authPlayerName, hasPermission, signOut, groupMgmt } = usePermissions();
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
  const [newBlockedA, setNewBlockedA] = useState('');
  const [newBlockedB, setNewBlockedB] = useState('');
  const [newBlockedDate, setNewBlockedDate] = useState(new Date().toISOString().split('T')[0]);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [showFullChangelog, setShowFullChangelog] = useState(false);
  const [deletePlayerConfirm, setDeletePlayerConfirm] = useState<{ id: string; name: string } | null>(null);
  const [deleteChipConfirm, setDeleteChipConfirm] = useState<{ id: string; name: string } | null>(null);
  
  // Gemini AI state
  const [geminiKey, setGeminiKey] = useState<string>('');
  // ElevenLabs TTS state (used by AI tab model tests)
  const [elKey, setElKey] = useState<string>('');
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
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  const [activityMembers, setActivityMembers] = useState<GroupMember[]>([]);
  const [deviceLabels] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('poker_device_labels') || '{}'); } catch { return {}; }
  });

  // Super Admin dashboard state
  interface GlobalGroup {
    id: string;
    name: string;
    created_at: string;
    created_by: string;
    training_enabled: boolean;
    owner_email: string | null;
    member_count: number;
    game_count: number;
    completed_game_count: number;
    last_game_date: string | null;
  }
  interface GlobalStats {
    total_groups: number;
    total_users: number;
    total_games: number;
    total_players: number;
    groups: GlobalGroup[];
    orphaned_groups: { id: string; name: string; created_at: string; created_by: string }[];
  }
  const [globalStats, setGlobalStats] = useState<GlobalStats | null>(null);
  const [globalLoading, setGlobalLoading] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);

  const loadGlobalStats = useCallback(async () => {
    if (!isSuperAdmin) return;
    setGlobalLoading(true);
    setGlobalError(null);
    const { data, error } = await supabase.rpc('get_global_stats');
    if (error) {
      setGlobalError(error.message);
    } else {
      setGlobalStats(data as unknown as GlobalStats);
    }
    setGlobalLoading(false);
  }, [isSuperAdmin]);

  const handleToggleTraining = async (groupId: string, enabled: boolean) => {
    const { error } = await supabase.rpc('toggle_group_training', { target_group_id: groupId, enabled });
    if (error) {
      setGlobalError(`שגיאה בעדכון אימון: ${error.message}`);
      return;
    }
    if (globalStats) {
      setGlobalStats({
        ...globalStats,
        groups: globalStats.groups.map(g => g.id === groupId ? { ...g, training_enabled: enabled } : g),
      });
    }
  };

  // Permission checks
  const canEditSettings = hasPermission('settings:edit');
  const canEditChips = hasPermission('chips:edit');
  const canEditPlayers = hasPermission('player:edit');
  const canDeletePlayers = hasPermission('player:delete');
  const canAddPlayers = hasPermission('player:add');


  type TabId = 'group' | 'game' | 'chips' | 'players' | 'about' | 'activity' | 'ai' | 'training' | 'superadmin';
  const getDefaultTab = (): TabId => 'group';
  
  const [activeTab, setActiveTab] = useState<TabId>(getDefaultTab());

  useEffect(() => {
    loadData();
  }, []);

  // Auto-load activity log + group members when tab is selected
  useEffect(() => {
    if (activeTab === 'activity' && isOwner && activityLog.length === 0 && !activityLoading) {
      loadActivityLog();
      if (groupMgmt) {
        groupMgmt.fetchMembers().then(m => setActivityMembers(m));
      }
    }
  }, [activeTab]);

  // Auto-load global stats when super admin tab is selected
  useEffect(() => {
    if (activeTab === 'superadmin' && isSuperAdmin && !globalStats && !globalLoading && !globalError) {
      loadGlobalStats();
    }
  }, [activeTab, isSuperAdmin, globalStats, globalLoading, globalError, loadGlobalStats]);

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
      setAiTick(n => n + 1);
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

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useRealtimeRefresh(useCallback(() => loadData(), []));

  const loadData = () => {
    setSettings(getSettings());
    setChipValues(getChipValues());
    setPlayers(sortPlayersByType(getAllPlayers()));
    // Load Gemini API key
    const savedGeminiKey = getGeminiApiKey();
    if (savedGeminiKey) setGeminiKey(savedGeminiKey);
    // Load ElevenLabs API key
    const savedElKey = getElevenLabsApiKey();
    if (savedElKey) setElKey(savedElKey);
  };

  const handleSettingsChange = (key: keyof Settings, value: number | number[] | string[] | BlockedTransferPair[]) => {
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
      setError(t('settings.players.emptyName'));
      return;
    }
    if (getPlayerByName(trimmedName)) {
      setError(t('settings.players.duplicate'));
      return;
    }
    const player = addPlayer(trimmedName, newPlayerType, newPlayerGender);
    setPlayers(sortPlayersByType([...players, player]));
    setNewPlayerName('');
    setNewPlayerType('permanent');
    setNewPlayerGender('male');
    setShowAddPlayer(false);
    setError('');
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
      setError(t('settings.players.emptyName'));
      return;
    }
    
    const success = updatePlayerName(editingPlayer.id, trimmedName);
    if (!success) {
      setError(t('settings.players.duplicateEdit'));
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
  };

  const handleDeletePlayer = (id: string) => {
    if (playerHasGames(id)) {
      return;
    }
    deletePlayer(id);
    setPlayers(players.filter(p => p.id !== id));
    setDeletePlayerConfirm(null);
  };

  const handleAddChip = () => {
    if (!newChip.color.trim() || !newChip.value) {
      setError(t('settings.chips.emptyFields'));
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

  const loadActivityLog = async () => {
    setActivityLoading(true);
    setActivityError(null);
    try {
      const entries = await fetchActivityLog();
      setActivityLog(entries.reverse());
    } catch (err) {
      setActivityError(err instanceof Error ? err.message : t('settings.activity.loadError'));
    } finally {
      setActivityLoading(false);
    }
  };

  const handleClearActivityLog = async () => {
    if (!window.confirm(t('settings.activity.clearConfirm'))) return;
    setActivityLoading(true);
    try {
      await clearActivityLog();
      setActivityLog([]);
    } catch (err) {
      setActivityError(err instanceof Error ? err.message : t('settings.activity.loadError'));
    } finally {
      setActivityLoading(false);
    }
  };


  const formatRelativeTime = (isoString: string): string => {
    const date = new Date(isoString);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const entryDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const diffDays = Math.floor((today.getTime() - entryDay.getTime()) / 86400000);
    const time = date.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
    if (diffDays === 0) return `היום ${time}`;
    if (diffDays === 1) return `אתמול ${time}`;
    if (diffDays < 7) return `לפני ${diffDays} ימים ${time}`;
    return `${date.toLocaleDateString(isRTL ? 'he-IL' : 'en-GB', { day: 'numeric', month: 'short' })} ${time}`;
  };

  const getRoleInfo = (r: string) => {
    switch (r) {
      case 'admin': return { emoji: '👑', name: 'מנהל', color: '#f59e0b' };
      case 'member': return { emoji: '⭐', name: 'חבר', color: '#10B981' };
      default: return { emoji: '👤', name: r, color: '#94a3b8' };
    }
  };

  // Filter tabs based on permissions
  const allTabs = [
    { id: 'group', label: t('settings.tabGroup'), icon: '🏠', requiresPermission: null, ownerOnly: false, adminOnly: false, superAdminOnly: false },
    { id: 'players', label: t('settings.tabPlayers'), icon: '👥', requiresPermission: 'player:add' as const, ownerOnly: false, adminOnly: false, superAdminOnly: false },
    { id: 'chips', label: t('settings.tabChips'), icon: '🎰', requiresPermission: 'chips:edit' as const, ownerOnly: false, adminOnly: false, superAdminOnly: false },
    { id: 'game', label: t('settings.tabGame'), icon: '💰', requiresPermission: 'settings:edit' as const, ownerOnly: false, adminOnly: false, superAdminOnly: false },
    { id: 'ai', label: t('settings.tabAI'), icon: '🤖', requiresPermission: null, ownerOnly: true, adminOnly: false, superAdminOnly: false },
    { id: 'training', label: t('settings.tabTraining'), icon: '🎯', requiresPermission: null, ownerOnly: false, adminOnly: false, superAdminOnly: true },
    { id: 'activity', label: t('settings.tabActivity'), icon: '📊', requiresPermission: null, ownerOnly: true, adminOnly: false, superAdminOnly: false },
    { id: 'about', label: t('settings.tabAbout'), icon: 'ℹ️', requiresPermission: null, ownerOnly: false, adminOnly: false, superAdminOnly: false },
    { id: 'superadmin', label: 'ניהול גלובלי', icon: '🛡️', requiresPermission: null, ownerOnly: false, adminOnly: false, superAdminOnly: true },
  ];
  
  const tabs = allTabs.filter(tab => {
    if (tab.superAdminOnly && !isSuperAdmin) return false;
    if (tab.ownerOnly && !isOwner) return false;
    if (tab.adminOnly && role !== 'admin') return false;
    return tab.requiresPermission === null || hasPermission(tab.requiresPermission);
  }) as { id: TabId; label: string; icon: string }[];

  return (
    <div className="fade-in">
      <div className="page-header" style={{ marginBottom: '0.5rem' }}>
        <h1 className="page-title">{t('settings.title')}</h1>
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
          title={t('common.signOut')}
        >
          🔓
        </button>
      </div>

      {/* Poker Training - Super Admin Only */}
      {isSuperAdmin && (
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
          <div style={{ textAlign: isRTL ? 'right' : 'left', flex: 1 }}>
            <div style={{ fontWeight: '700', fontSize: '0.9rem', color: '#a78bfa' }}>
              {t('training.title')}
            </div>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
              {t('training.subtitle')}
            </div>
          </div>
          <span style={{ color: 'var(--text-muted)', fontSize: '1.2rem' }}>›</span>
        </button>
      )}

      {/* Setup Wizard Banner — shown for group owners when setup is incomplete */}
      {isOwner && (() => {
        const hasPlayers = players.length > 1;
        const hasApiKey = !!settings.geminiApiKey;
        const steps = [
          { done: true, label: 'יצירת קבוצה', icon: '✅' },
          { done: hasPlayers, label: 'הוספת שחקנים', icon: hasPlayers ? '✅' : '👥', tab: 'players' as TabId },
          { done: hasApiKey, label: 'מפתח AI (אופציונלי)', icon: hasApiKey ? '✅' : '🔑', tab: 'ai' as TabId },
        ];
        const allDone = steps.every(s => s.done);
        if (allDone) return null;
        const nextStep = steps.find(s => !s.done);
        return (
          <div style={{
            background: 'linear-gradient(135deg, rgba(99,102,241,0.08), rgba(168,85,247,0.08))',
            border: '1px solid rgba(99,102,241,0.2)',
            borderRadius: '12px',
            padding: '0.75rem 1rem',
            marginBottom: '0.75rem',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
              <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#a78bfa' }}>🚀 השלמת הגדרת הקבוצה</span>
              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                {steps.filter(s => s.done).length}/{steps.length}
              </span>
            </div>
            <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.5rem' }}>
              {steps.map((s, i) => (
                <div key={i} style={{
                  flex: 1, height: '4px', borderRadius: '2px',
                  background: s.done ? '#10B981' : 'rgba(100,100,100,0.3)',
                }} />
              ))}
            </div>
            {nextStep?.tab && (
              <button
                onClick={() => setActiveTab(nextStep.tab!)}
                style={{
                  width: '100%', padding: '0.5rem', borderRadius: '8px', border: 'none',
                  background: 'rgba(99,102,241,0.15)', color: '#818cf8', cursor: 'pointer',
                  fontSize: '0.8rem', fontWeight: 600, fontFamily: 'Outfit, sans-serif',
                }}
              >
                {nextStep.icon} {nextStep.label} →
              </button>
            )}
          </div>
        );
      })()}

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
          <p style={{ color: 'var(--success)' }}>{t('settings.saved')}</p>
        </div>
      )}

      {/* Group Management Tab */}
      {activeTab === 'group' && groupMgmt && (
        <GroupManagementTab
          groupName={groupMgmt.groupName}
          inviteCode={groupMgmt.inviteCode}
          isOwner={isOwner}
          isAdmin={role === 'admin'}
          currentUserId={groupMgmt.currentUserId}
          fetchMembers={groupMgmt.fetchMembers}
          updateMemberRole={groupMgmt.updateMemberRole}
          removeMember={groupMgmt.removeMember}
          transferOwnership={groupMgmt.transferOwnership}
          regenerateInviteCode={groupMgmt.regenerateInviteCode}
          unlinkMemberPlayer={groupMgmt.unlinkMemberPlayer}
          createPlayerInvite={groupMgmt.createPlayerInvite}
          addMemberByEmail={groupMgmt.addMemberByEmail}
          appUrl={window.location.origin}
        />
      )}

      {/* Game Settings Tab */}
      {activeTab === 'game' && (
        <div className="card">
          <h2 className="card-title mb-2">{t('settings.game.title')}</h2>
          
          {!canEditSettings && (
            <div style={{ 
              padding: '0.5rem 0.75rem', 
              marginBottom: '1rem',
              borderRadius: '8px',
              background: 'rgba(234, 179, 8, 0.1)',
              borderLeft: '4px solid #EAB308'
            }}>
              <p style={{ color: '#EAB308', margin: 0, fontSize: '0.85rem' }}>
                {t('settings.game.adminOnly')}
              </p>
            </div>
          )}
          
          <div className="input-group">
            <label className="label">{t('settings.game.buyinValue')}</label>
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
            <label className="label">{t('settings.game.chipsPerBuyin')}</label>
            <input
              type="number"
              className="input"
              value={settings.chipsPerRebuy}
              onChange={e => handleSettingsChange('chipsPerRebuy', parseInt(e.target.value) || 0)}
              min="1"
              disabled={!canEditSettings}
            />
            <p className="text-muted" style={{ fontSize: '0.875rem', marginTop: '0.25rem' }}>
              {t('settings.game.buyinHelper', { value: cleanNumber(settings.rebuyValue), chips: (settings.chipsPerRebuy || 10000).toLocaleString() })}
              <br />
              {t('settings.game.chipValueHelper', { value: String(Math.round((settings.rebuyValue / (settings.chipsPerRebuy || 10000)) * 1000)) })}
            </p>
          </div>

          <div className="input-group">
            <label className="label">{t('settings.game.minTransfer')}</label>
            <input
              type="number"
              className="input"
              value={settings.minTransfer}
              onChange={e => handleSettingsChange('minTransfer', parseInt(e.target.value) || 0)}
              min="0"
              disabled={!canEditSettings}
            />
            <p className="text-muted" style={{ fontSize: '0.875rem', marginTop: '0.25rem' }}>
              {t('settings.game.minTransferHelper')}
            </p>
          </div>

          <div className="input-group">
            <label className="label">{t('settings.game.gameNightDays')}</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.25rem' }}>
              {[
                { day: 0, label: t('settings.game.sun') },
                { day: 1, label: t('settings.game.mon') },
                { day: 2, label: t('settings.game.tue') },
                { day: 3, label: t('settings.game.wed') },
                { day: 4, label: t('settings.game.thu') },
                { day: 5, label: t('settings.game.fri') },
                { day: 6, label: t('settings.game.sat') },
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
              {t('settings.game.daysHelper')}
            </p>
          </div>

          <div className="input-group">
            <label className="label">{t('settings.game.locations')}</label>
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
                  placeholder={t('settings.game.newLocation')}
                  style={{ flex: 1, fontSize: '0.85rem' }}
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
                >{t('settings.game.addLocation')}</button>
              </div>
            )}
          </div>

          {/* Blocked Transfers */}
          <div className="setting-group" style={{ marginTop: '1rem' }}>
            <label className="label">{t('settings.game.blockedTransfers')}</label>
            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
              {t('settings.game.blockedDesc')}
            </div>
            {(settings.blockedTransfers || []).map((pair, idx) => (
              <div key={idx} style={{
                display: 'flex', alignItems: 'center', gap: '0.5rem',
                padding: '0.4rem 0.6rem', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '8px',
                marginBottom: '0.3rem', fontSize: '0.8rem'
              }}>
                <span style={{ flex: 1 }}>
                  {pair.playerA} ↔ {pair.playerB}
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.65rem', marginRight: '0.5rem' }}>
                    (מ-{new Date(pair.after).toLocaleDateString('he-IL')})
                  </span>
                </span>
                {canEditSettings && (
                  <button
                    onClick={() => {
                      const updated = (settings.blockedTransfers || []).filter((_, i) => i !== idx);
                      handleSettingsChange('blockedTransfers', updated);
                    }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', fontSize: '0.9rem' }}
                  >✕</button>
                )}
              </div>
            ))}
            {canEditSettings && (
              <div style={{ marginTop: '0.4rem' }}>
                <div style={{ display: 'flex', gap: '0.3rem', marginBottom: '0.3rem' }}>
                  <select
                    value={newBlockedA}
                    onChange={e => setNewBlockedA(e.target.value)}
                    className="input"
                    style={{ flex: 1, fontSize: '0.75rem', background: '#1a1a2e', color: '#e2e8f0' }}
                  >
                    <option value="">{t('settings.game.playerA')}</option>
                    {players.filter(p => p.type === 'permanent').map(p => (
                      <option key={p.id} value={p.name}>{p.name}</option>
                    ))}
                  </select>
                  <select
                    value={newBlockedB}
                    onChange={e => setNewBlockedB(e.target.value)}
                    className="input"
                    style={{ flex: 1, fontSize: '0.75rem', background: '#1a1a2e', color: '#e2e8f0' }}
                  >
                    <option value="">{t('settings.game.playerB')}</option>
                    {players.filter(p => p.type === 'permanent' && p.name !== newBlockedA).map(p => (
                      <option key={p.id} value={p.name}>{p.name}</option>
                    ))}
                  </select>
                </div>
                <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
                  <input
                    type="date"
                    value={newBlockedDate}
                    onChange={e => setNewBlockedDate(e.target.value)}
                    className="input"
                    style={{ flex: 1, fontSize: '0.75rem', background: '#1a1a2e', color: '#e2e8f0' }}
                  />
                  <button
                    disabled={!newBlockedA || !newBlockedB || newBlockedA === newBlockedB}
                    onClick={() => {
                      const current = settings.blockedTransfers || [];
                      const exists = current.some(p =>
                        (p.playerA === newBlockedA && p.playerB === newBlockedB) ||
                        (p.playerA === newBlockedB && p.playerB === newBlockedA)
                      );
                      if (!exists) {
                        handleSettingsChange('blockedTransfers', [...current, { playerA: newBlockedA, playerB: newBlockedB, after: newBlockedDate }]);
                      }
                      setNewBlockedA('');
                      setNewBlockedB('');
                    }}
                    className="btn btn-sm"
                    style={{ fontSize: '0.75rem', padding: '0.35rem 0.7rem', background: 'var(--primary)', color: 'white', border: 'none', whiteSpace: 'nowrap' }}
                  >{t('settings.game.addBlocked')}</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Chip Values Tab */}
      {activeTab === 'chips' && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">{t('settings.chips.title')}</h2>
            {canEditChips && (
              <button className="btn btn-sm btn-outline" onClick={() => setShowAddChip(true)}>
                {t('settings.chips.add')}
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
                  title={t('settings.chips.deleteTitle')}
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
            <h2 className="card-title">{t('settings.players.title', { count: players.length })}</h2>
            {canAddPlayers && (
              <button className="btn btn-sm btn-outline" onClick={() => setShowAddPlayer(true)}>
                {t('settings.players.add')}
              </button>
            )}
          </div>

          {players.length === 0 ? (
            <p className="text-muted">{t('settings.players.noPlayers')}</p>
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
                      {player.type === 'permanent' ? t('settings.players.permanent') : player.type === 'permanent_guest' ? t('settings.players.guest') : t('settings.players.occasional')}
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
                          title={t('common.edit')}
                        >
                          {t('common.edit')}
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
                          title={t('settings.players.deleteTitle')}
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

      {/* AI Tab - Owner Only */}
      {activeTab === 'ai' && isOwner && (() => {
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
            {/* Per-Group API Keys */}
            <div className="card" style={{ padding: '1rem', marginBottom: '0.75rem' }}>
                <h2 className="card-title" style={{ margin: '0 0 0.5rem 0' }}>{t('settings.ai.apiKeys')}</h2>
                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
                  {t('settings.ai.keysHelp')}
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', direction: 'ltr' }}>
                  <div>
                    <label style={{ fontSize: '0.7rem', color: 'var(--text-muted)', display: 'block', marginBottom: '0.2rem' }}>
                      {t('settings.ai.geminiKey')}
                    </label>
                    <div style={{ display: 'flex', gap: '0.4rem' }}>
                      <input
                        type="password"
                        value={settings.geminiApiKey || ''}
                        onChange={e => setSettings({ ...settings, geminiApiKey: e.target.value })}
                        placeholder={t('settings.ai.geminiPlaceholder')}
                        style={{
                          flex: 1, padding: '0.5rem', borderRadius: '6px', border: '1px solid var(--border)',
                          background: 'var(--background)', color: 'var(--text)', fontSize: '0.8rem',
                          fontFamily: 'monospace',
                        }}
                      />
                      <button
                        onClick={() => {
                          saveSettings(settings);
                          setSaved(true);
                          setTimeout(() => setSaved(false), 2000);
                        }}
                        style={{
                          padding: '0.5rem 0.75rem', borderRadius: '6px', border: 'none',
                          background: 'var(--primary)', color: 'white', fontSize: '0.75rem',
                          cursor: 'pointer', fontFamily: 'Outfit, sans-serif',
                        }}
                      >
                        {t('common.save')}
                      </button>
                    </div>
                  </div>
                  {isSuperAdmin && (
                    <div>
                      <label style={{ fontSize: '0.7rem', color: 'var(--text-muted)', display: 'block', marginBottom: '0.2rem' }}>
                        {t('settings.ai.elevenLabsKey')}
                      </label>
                      <div style={{ display: 'flex', gap: '0.4rem' }}>
                        <input
                          type="password"
                          value={settings.elevenlabsApiKey || ''}
                          onChange={e => setSettings({ ...settings, elevenlabsApiKey: e.target.value })}
                          placeholder={t('settings.ai.elevenLabsPlaceholder')}
                          style={{
                            flex: 1, padding: '0.5rem', borderRadius: '6px', border: '1px solid var(--border)',
                            background: 'var(--background)', color: 'var(--text)', fontSize: '0.8rem',
                            fontFamily: 'monospace',
                          }}
                        />
                        <button
                          onClick={() => {
                            saveSettings(settings);
                            setSaved(true);
                            setTimeout(() => setSaved(false), 2000);
                          }}
                          style={{
                            padding: '0.5rem 0.75rem', borderRadius: '6px', border: 'none',
                            background: 'var(--primary)', color: 'white', fontSize: '0.75rem',
                            cursor: 'pointer', fontFamily: 'Outfit, sans-serif',
                          }}
                        >
                          {t('common.save')}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

            {/* API Key Setup Guide */}
            {!settings.geminiApiKey && (
              <div className="card" style={{ padding: '1rem', marginBottom: '0.75rem', borderInlineStart: '3px solid #6366f1' }}>
                <h2 className="card-title" style={{ margin: '0 0 0.5rem 0' }}>📖 איך להשיג מפתח Gemini?</h2>
                <ol style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: '0', paddingInlineStart: '1.2rem', lineHeight: 1.8 }}>
                  <li>היכנס ל-<a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" style={{ color: '#818cf8' }}>Google AI Studio</a></li>
                  <li>לחץ על <strong style={{ color: 'var(--text)' }}>Create API Key</strong></li>
                  <li>העתק את המפתח והדבק בשדה למעלה</li>
                  <li>לחץ שמור — וזהו!</li>
                </ol>
                <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', margin: '0.5rem 0 0', opacity: 0.7 }}>
                  המפתח בחינם עד 1,500 בקשות ביום — מספיק בשופי לערבי פוקר
                </p>
              </div>
            )}

            {/* Game Readiness Card */}
            <div className="card" style={{ padding: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h2 className="card-title" style={{ margin: 0 }}>{t('settings.ai.readiness')}</h2>
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
                        const res = await proxyGeminiGenerate('v1beta', model, geminiKey, {
                          contents: [{ parts: [{ text: 'קרא את הטקסט הבא בעברית:\n\nשלום, זוהי בדיקת מערכת הקול. הכל תקין.' }] }],
                          generationConfig: {
                            responseModalities: ['AUDIO'],
                            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
                          },
                        });
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
                          proxyElevenLabsTTS(elKey, 'CwhRBWXzGAHq8TQ4Fs17', { text: 'בדיקה', model_id: 'eleven_v3', language_code: 'he' }),
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
                  {isTestingModels ? t('settings.ai.checking') : t('settings.ai.checkNow')}
                </button>
              </div>

              {!geminiKey && (
                <div style={{ textAlign: 'center', padding: '1rem 0', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                  {t('settings.ai.defineGeminiFirst')}
                </div>
              )}

              {geminiKey && !aiTestResults && !isTestingModels && (
                <div style={{ textAlign: 'center', padding: '1rem 0', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                  {t('settings.ai.promptCheck')}
                </div>
              )}

              {isTestingModels && (
                <div style={{ textAlign: 'center', padding: '1rem 0', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                  {t('settings.ai.checkingAllModels')}
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
                    <div style={{ fontSize: '0.9rem', fontWeight: 700, color: gameReady ? '#10B981' : '#EF4444' }}>
                      {gameReady ? t('settings.ai.ready') : contentBlocked ? t('settings.ai.notReady') : t('settings.ai.partial')}
                    </div>
                  </div>

                  {/* Feature checklist */}
                  {(() => {
                    const contentOk = !!contentModel;
                    const ttsOk = ttsResults.some(r => r.status === 'available');

                    const featureRow = (icon: string, label: string, ok: boolean, modelName?: string, remaining?: number, limit?: number, capacityLabel?: string) => (
                      <div style={{ padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <span style={{ fontSize: '1rem' }}>{icon}</span>
                          <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text)', flex: 1 }}>{label}</span>
                          <span style={{
                            fontSize: '0.75rem', fontWeight: 600, padding: '0.15rem 0.5rem', borderRadius: 6,
                            background: ok ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
                            color: ok ? '#10B981' : '#EF4444',
                          }}>
                            {ok ? t('settings.ai.working') : t('settings.ai.blocked')}
                          </span>
                        </div>
                        {(modelName || (remaining != null && limit != null)) && (
                          <div style={{ display: 'flex', gap: '0.75rem', paddingRight: '1.75rem', marginTop: '0.25rem', flexWrap: 'wrap' }}>
                            {modelName && (
                              <span style={{ fontSize: '0.65rem', color: '#A855F7' }}>
                                {t('settings.ai.model')} {modelName}
                              </span>
                            )}
                            {remaining != null && limit != null && (
                              <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
                                {t('settings.ai.remaining', { used: remaining, limit })}{capacityLabel ? ` (${capacityLabel})` : ''}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    );

                    const contentRemaining = contentModel?.remaining;
                    const contentLimit = contentModel?.limit;
                    const contentCapacity = contentRemaining != null ? t('settings.ai.gamesCapacity', { count: Math.floor(contentRemaining / 2) }) : undefined;

                    const geminiTts = ttsResults.find(r => r.model.startsWith('gemini'));
                    const geminiTtsCapacity = geminiTts?.remaining != null ? t('settings.ai.announceCapacity', { count: geminiTts.remaining }) : undefined;

                    return (
                      <div style={{ marginBottom: '0.5rem' }}>
                        {featureRow('🔮', t('settings.ai.forecast'), contentOk, contentModel?.displayName, contentRemaining, contentLimit, contentCapacity)}
                        {featureRow('📝', t('settings.ai.summary'), contentOk, contentModel?.displayName)}

                        {/* TTS engines — show each individually */}
                        <div style={{ padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem' }}>
                            <span style={{ fontSize: '1rem' }}>🔊</span>
                            <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text)', flex: 1 }}>{t('settings.ai.voice')}</span>
                            <span style={{
                              fontSize: '0.75rem', fontWeight: 600, padding: '0.15rem 0.5rem', borderRadius: 6,
                              background: ttsOk ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
                              color: ttsOk ? '#10B981' : '#EF4444',
                            }}>
                              {ttsOk ? t('settings.ai.working') : t('settings.ai.blocked')}
                            </span>
                          </div>

                          {ttsResults.map(r => {
                            const isOk = r.status === 'available';
                            const isRateLimited = r.status === 'rate_limited';
                            const statusColor = isOk ? '#10B981' : isRateLimited ? '#F59E0B' : '#EF4444';
                            const statusText = isOk ? '✓' : isRateLimited ? t('settings.ai.limited') : '✗';
                            return (
                              <div key={r.model} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', paddingRight: '1.75rem', marginTop: '0.25rem' }}>
                                <span style={{ fontSize: '0.65rem', fontWeight: 600, color: statusColor, minWidth: '1rem' }}>{statusText}</span>
                                <span style={{ fontSize: '0.7rem', color: 'var(--text)', flex: 1 }}>{r.displayName}</span>
                                {r.remaining != null && r.limit != null && (
                                  <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                                    {r.model === 'elevenlabs-tts'
                                      ? t('settings.ai.elevenQuotaBar', { used: r.remaining.toLocaleString(), limit: r.limit.toLocaleString(), games: Math.floor(r.remaining / 1300) })
                                      : `${t('settings.ai.geminiQuotaBar', { rem: r.remaining, lim: r.limit })}${geminiTtsCapacity && r.model.startsWith('gemini') ? ` (${geminiTtsCapacity})` : ''}`
                                    }
                                  </span>
                                )}
                                {r.model === 'edge-tts' && isOk && (
                                  <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>{t('settings.ai.unlimited')}</span>
                                )}
                              </div>
                            );
                          })}

                          {!ttsOk && ttsResults.length > 0 && (
                            <div style={{ fontSize: '0.65rem', color: '#F59E0B', paddingRight: '1.75rem', marginTop: '0.4rem' }}>
                              {isEdgeBrowser()
                                ? t('settings.ai.voiceFallbackEdge')
                                : t('settings.ai.voiceFallbackBrowser')}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                </>
              )}
            </div>

            {/* ElevenLabs TTS Usage Card — super admin only */}
            {isSuperAdmin && elKey && (() => {
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
                  <h2 className="card-title" style={{ margin: '0 0 0.75rem' }}>{t('settings.ai.elevenLabsUsage')}</h2>
                  <div>

                    {/* Monthly quota bar */}
                    <div style={{ marginBottom: '0.75rem' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.3rem' }}>
                        <span style={{ fontSize: '0.7rem', color: 'var(--text)' }}>
                          {elUsageLive ? t('settings.ai.charPair', { used: used.toLocaleString(), limit: limit.toLocaleString() }) : t('settings.ai.usageLoading')}
                        </span>
                        <span style={{ fontSize: '0.65rem', color: usedPct > 80 ? '#EF4444' : usedPct > 50 ? '#F59E0B' : '#10B981', fontWeight: 600 }}>
                          {elUsageLive ? t('settings.ai.remainingShort', { remaining: remaining.toLocaleString() }) : ''}
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
                          {t('settings.ai.resetLine', { date: resetDate, games: gamesLeft })}
                        </div>
                      )}
                    </div>

                    {/* Stats row */}
                    {history.length > 0 && (
                      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                        <div style={{ background: 'rgba(168,85,247,0.08)', borderRadius: 8, padding: '0.4rem 0.6rem', flex: 1, textAlign: 'center' }}>
                          <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#A855F7' }}>{avgPerGame.toLocaleString()}</div>
                          <div style={{ fontSize: '0.55rem', color: 'var(--text-muted)' }}>{t('settings.ai.avgPerGame')}</div>
                        </div>
                        <div style={{ background: 'rgba(59,130,246,0.08)', borderRadius: 8, padding: '0.4rem 0.6rem', flex: 1, textAlign: 'center' }}>
                          <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#3B82F6' }}>{history.length}</div>
                          <div style={{ fontSize: '0.55rem', color: 'var(--text-muted)' }}>{t('settings.ai.gamesWithTts')}</div>
                        </div>
                        <div style={{ background: 'rgba(16,185,129,0.08)', borderRadius: 8, padding: '0.4rem 0.6rem', flex: 1, textAlign: 'center' }}>
                          <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#10B981' }}>{totalGameChars.toLocaleString()}</div>
                          <div style={{ fontSize: '0.55rem', color: 'var(--text-muted)' }}>{t('settings.ai.totalChars')}</div>
                        </div>
                      </div>
                    )}

                    {/* Per-game breakdown */}
                    {history.length > 0 ? (
                      <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.5rem' }}>
                        <div style={{ fontSize: '0.65rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.3rem' }}>{t('settings.ai.usageByGame')}</div>
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
                              <span style={{ fontSize: '0.65rem', fontWeight: 600, color: 'var(--text)', minWidth: '48px', textAlign: isRTL ? 'left' : 'right' }}>{h.charsUsed.toLocaleString()} {t('settings.ai.charUnit')}</span>
                              <button
                                onClick={() => { if (confirm(t('settings.ai.confirmDeleteUsage'))) { deleteElevenLabsGameEntry(h.gameId); setAiTick(u => u + 1); } }}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.6rem', color: 'var(--text-muted)', padding: '0 0.15rem', opacity: 0.4 }}
                                title={t('settings.ai.deleteUsageRow')}
                              >🗑️</button>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textAlign: 'center', padding: '0.5rem 0', borderTop: '1px solid var(--border)' }}>
                        {t('settings.ai.usageNextGame')}
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* Today's Usage Card */}
            <div className="card" style={{ padding: '1rem' }}>
              <h2 className="card-title" style={{ margin: '0 0 0.75rem' }}>{t('settings.ai.todayUsage')}</h2>
              <div>
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
                        {t('settings.ai.callsTokens', { calls: Object.values(todayActions).reduce((s, c) => s + c, 0), tokens: formatTokens(todayTokens) })}
                      </div>
                    </>
                  ) : (
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textAlign: 'center' }}>
                      {t('settings.ai.noActivityToday')}
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
                    <span style={{ fontSize: '0.7rem', fontWeight: 600 }}>{t('settings.ai.activityLog', { count: todayLog.length })}</span>
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
                            <span style={{ color: entry.success ? 'var(--text-muted)' : '#F59E0B', flex: 1, textAlign: 'end' }}>
                              {entry.success
                                ? (entry.tokens > 0 ? `${formatTokens(entry.tokens)} ${t('settings.ai.tok')}` : '✓')
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
                  onClick={() => { if (confirm(t('settings.ai.confirmReset'))) { resetUsage(); setAiStatus(getAIStatus()); setAiTestResults(null); } }}
                  style={{ fontSize: '0.6rem', padding: '0.2rem 0.5rem', background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)' }}
                >
                  {t('settings.ai.resetData')}
                </button>
              </div>
            </div>
          </>
        );
      })()}

      {/* About Tab */}
      {activeTab === 'about' && (
        <>
        {/* Identity section */}
        <div className="card" style={{ marginBottom: '0.75rem' }}>
          <div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('settings.about.identifiedAs')}</div>
            <div style={{ fontSize: '1rem', fontWeight: '600', color: 'var(--text)' }}>
              {authPlayerName || '—'}
            </div>
          </div>
        </div>
        {/* Language toggle */}
        <div className="card" style={{ marginBottom: '0.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '1rem', fontWeight: '600' }}>🌐 Language / שפה</span>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              {(['he', 'en'] as const).map(lang => (
                <button
                  key={lang}
                  onClick={() => {
                    const newSettings = { ...settings, language: lang };
                    setSettings(newSettings);
                    saveSettings(newSettings);
                    window.location.reload();
                  }}
                  style={{
                    padding: '0.4rem 1rem',
                    borderRadius: '0.5rem',
                    border: settings.language === lang || (!settings.language && lang === 'he') ? '2px solid var(--primary)' : '1px solid var(--border)',
                    background: settings.language === lang || (!settings.language && lang === 'he') ? 'var(--primary)' : 'var(--surface)',
                    color: settings.language === lang || (!settings.language && lang === 'he') ? 'white' : 'var(--text)',
                    cursor: 'pointer',
                    fontWeight: '600',
                    fontSize: '0.875rem',
                  }}
                >
                  {lang === 'he' ? 'עברית' : 'English'}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">{t('settings.about.version')}</h2>
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
              {t('settings.about.latestChanges')}
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
                {showFullChangelog ? t('settings.about.hideHistory') : t('settings.about.showHistory', { count: CHANGELOG.length - 1 })}
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
        </>
      )}

      {/* Training Admin Tab - Super Admin Only */}
      {activeTab === 'training' && isSuperAdmin && <TrainingAdminTab />}

      {/* Super Admin Dashboard */}
      {activeTab === 'superadmin' && isSuperAdmin && (() => {
        return (
          <div>
            {globalLoading && (
              <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>🔄</div>
                טוען נתונים גלובליים...
              </div>
            )}

            {globalError && (
              <div className="card" style={{ padding: '1rem', background: 'rgba(239,68,68,0.1)', borderInlineStart: '3px solid #EF4444' }}>
                <p style={{ color: '#EF4444', margin: 0, fontSize: '0.85rem' }}>שגיאה: {globalError}</p>
                <button className="btn btn-sm" onClick={loadGlobalStats} style={{ marginTop: '0.5rem' }}>נסה שוב</button>
              </div>
            )}

            {globalStats && (
              <>
                {/* Global Overview Cards */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.5rem', marginBottom: '1rem' }}>
                  {[
                    { icon: '🏠', label: 'קבוצות', value: globalStats.total_groups },
                    { icon: '👥', label: 'משתמשים', value: globalStats.total_users },
                    { icon: '🃏', label: 'משחקים', value: globalStats.total_games },
                    { icon: '🎭', label: 'שחקנים', value: globalStats.total_players },
                  ].map(stat => (
                    <div key={stat.label} className="card" style={{ padding: '0.75rem', textAlign: 'center' }}>
                      <div style={{ fontSize: '1.2rem' }}>{stat.icon}</div>
                      <div style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--primary)' }}>{stat.value}</div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{stat.label}</div>
                    </div>
                  ))}
                </div>

                {/* Orphaned Groups Warning */}
                {globalStats.orphaned_groups.length > 0 && (
                  <div className="card" style={{ padding: '1rem', marginBottom: '1rem', background: 'rgba(245,158,11,0.08)', borderInlineStart: '3px solid #F59E0B' }}>
                    <h3 style={{ margin: '0 0 0.5rem', fontSize: '0.9rem', color: '#F59E0B' }}>
                      ⚠️ קבוצות ללא בעלים ({globalStats.orphaned_groups.length})
                    </h3>
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0 0 0.5rem' }}>
                      הבעלים מחק את החשבון — יש להעביר בעלות
                    </p>
                    {globalStats.orphaned_groups.map(og => (
                      <div key={og.id} style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '0.5rem', background: 'var(--surface)', borderRadius: '8px', marginBottom: '0.3rem',
                      }}>
                        <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{og.name}</span>
                        <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                          {new Date(og.created_at).toLocaleDateString('he-IL')}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Groups List */}
                <div className="card" style={{ padding: '1rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                    <h2 className="card-title" style={{ margin: 0 }}>🏠 כל הקבוצות</h2>
                    <button className="btn btn-sm" onClick={loadGlobalStats} style={{ fontSize: '0.7rem' }}>🔄 רענן</button>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                    {globalStats.groups.map(g => (
                      <div key={g.id} style={{
                        padding: '0.75rem', background: 'var(--surface)', borderRadius: '10px',
                        border: '1px solid var(--border)',
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.4rem' }}>
                          <div>
                            <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>{g.name}</div>
                            <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                              {g.owner_email || 'ללא בעלים'}
                            </div>
                          </div>
                          <button
                            onClick={() => handleToggleTraining(g.id, !g.training_enabled)}
                            style={{
                              padding: '0.3rem 0.6rem', borderRadius: '8px', border: 'none', cursor: 'pointer',
                              fontSize: '0.7rem', fontWeight: 600, fontFamily: 'Outfit, sans-serif',
                              background: g.training_enabled ? 'rgba(16,185,129,0.15)' : 'rgba(100,100,100,0.15)',
                              color: g.training_enabled ? '#10B981' : 'var(--text-muted)',
                            }}
                          >
                            {g.training_enabled ? '🎯 אימון פעיל' : '🎯 אימון כבוי'}
                          </button>
                        </div>
                        <div style={{ display: 'flex', gap: '1rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                          <span>👥 {g.member_count}</span>
                          <span>🃏 {g.completed_game_count}/{g.game_count}</span>
                          {g.last_game_date && (
                            <span>📅 {new Date(g.last_game_date).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' })}</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        );
      })()}

      {/* Activity Tab - Owner Only - Enhanced Dashboard */}
      {activeTab === 'activity' && isOwner && (
        <div>
          {/* Header with refresh */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem' }}>
            <h2 style={{ margin: 0, fontSize: '1.1rem', color: 'var(--text)' }}>{t('settings.activity.title')}</h2>
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
                {activityLoading ? '...' : '🔄'}
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
                  🗑️
                </button>
              )}
            </div>
          </div>

          {activityError && (
            <div style={{ padding: '0.5rem', color: '#ef4444', fontSize: '0.8rem', marginBottom: '0.5rem' }}>
              {activityError}
            </div>
          )}

          {activityLoading && (
            <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              {t('settings.activity.loading')}
            </div>
          )}

          {activityLog.length === 0 && !activityLoading && !activityError && (
            <div style={{ textAlign: 'center', padding: '2rem 1rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>📊</div>
              {t('settings.activity.emptyHint')}
            </div>
          )}

          {!activityLoading && activityLog.length > 0 && (() => {
            const now = new Date();
            const tenMinAgo = new Date(now.getTime() - 10 * 60 * 1000);
            const oneDayMs = 86400000;
            const sevenDaysMs = 7 * oneDayMs;
            const thirtyDaysMs = 30 * oneDayMs;

            const userMap = new Map<string, ActivityLogEntry[]>();
            for (const entry of activityLog) {
              const name = entry.playerName || deviceLabels[entry.deviceId] || entry.deviceId.slice(0, 8);
              const existing = userMap.get(name) || [];
              existing.push(entry);
              userMap.set(name, existing);
            }

            const liveUsers = Array.from(userMap.entries()).filter(([, entries]) =>
              entries.some(e => new Date(e.lastActive || e.timestamp) > tenMinAgo)
            );

            const games = getAllGames();
            const lastGame = games.length > 0 ? games.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0] : null;

            const memberNames = activityMembers.map(m => m.playerName || m.displayName || '').filter(Boolean);
            const dormantMembers: string[] = [];
            const neverLoggedIn: string[] = [];
            for (const name of memberNames) {
              const entries = userMap.get(name);
              if (!entries || entries.length === 0) {
                neverLoggedIn.push(name);
              } else {
                const latest = entries.reduce((a, b) => new Date(b.lastActive || b.timestamp) > new Date(a.lastActive || a.timestamp) ? b : a);
                if (now.getTime() - new Date(latest.lastActive || latest.timestamp).getTime() > sevenDaysMs) {
                  dormantMembers.push(name);
                }
              }
            }

            let didntCheckLastGame: string[] = [];
            if (lastGame) {
              const gameTime = new Date(lastGame.date).getTime();
              const cutoff = gameTime + 48 * 3600 * 1000;
              for (const name of memberNames) {
                const entries = userMap.get(name) || [];
                const visitedAfterGame = entries.some(e => {
                  const t = new Date(e.timestamp).getTime();
                  return t > gameTime && t < cutoff;
                });
                if (!visitedAfterGame) didntCheckLastGame.push(name);
              }
            }

            const hasAlerts = dormantMembers.length > 0 || neverLoggedIn.length > 0 || didntCheckLastGame.length > 0;

            const todayUniqueUsers = new Set(
              activityLog.filter(e => new Date(e.timestamp).toDateString() === now.toDateString())
                .map(e => e.playerName || deviceLabels[e.deviceId] || e.deviceId)
            ).size;

            const weekAgo = new Date(now.getTime() - sevenDaysMs);
            const weeklyActiveUsers = new Set(
              activityLog.filter(e => new Date(e.timestamp) > weekAgo).map(e => e.playerName || deviceLabels[e.deviceId] || e.deviceId)
            ).size;

            const engagementPct = memberNames.length > 0 ? Math.round((weeklyActiveUsers / memberNames.length) * 100) : 0;

            const sessionsWithDuration = activityLog.filter(e => (e.sessionDuration || 0) > 0);
            const avgSessionMin = sessionsWithDuration.length > 0
              ? sessionsWithDuration.reduce((s, e) => s + (e.sessionDuration || 0), 0) / sessionsWithDuration.length
              : 0;

            const daysSinceLastGame = lastGame
              ? Math.floor((now.getTime() - new Date(lastGame.date).getTime()) / oneDayMs)
              : -1;

            const heatmap: number[][] = Array.from({ length: 7 }, () => [0, 0, 0, 0]);
            for (const entry of activityLog) {
              const d = new Date(entry.timestamp);
              if (now.getTime() - d.getTime() > sevenDaysMs) continue;
              const day = d.getDay();
              const hour = d.getHours();
              const slot = hour < 6 ? 0 : hour < 12 ? 1 : hour < 18 ? 2 : 3;
              heatmap[day][slot]++;
            }
            const maxHeat = Math.max(1, ...heatmap.flat());
            const dayNames = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
            const slotNames = ['לילה', 'בוקר', 'צהריים', 'ערב'];

            const recentGames = games
              .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
              .slice(0, 3);
            const postGameEngagement = recentGames.map(g => {
              const gameTime = new Date(g.date).getTime();
              const visited = new Set<string>();
              for (const entry of activityLog) {
                const t = new Date(entry.timestamp).getTime();
                if (t > gameTime && t < gameTime + oneDayMs) {
                  visited.add(entry.playerName || deviceLabels[entry.deviceId] || entry.deviceId);
                }
              }
              return { game: g, visitedCount: visited.size };
            });

            const userStats = Array.from(userMap.entries()).map(([name, entries]) => {
              const last30 = entries.filter(e => now.getTime() - new Date(e.timestamp).getTime() < thirtyDaysMs);
              const avgDuration = last30.length > 0
                ? last30.reduce((s, e) => s + (e.sessionDuration || 0), 0) / last30.length
                : 0;
              const latest = entries.reduce((a, b) => new Date(b.lastActive || b.timestamp) > new Date(a.lastActive || a.timestamp) ? b : a);
              const daysSince = Math.floor((now.getTime() - new Date(latest.lastActive || latest.timestamp).getTime()) / oneDayMs);
              const member = activityMembers.find(m => m.playerName === name || m.displayName === name);
              const memberRole = member?.role || latest.role || 'member';
              return { name, sessions30d: last30.length, avgDuration, daysSince, latestEntry: latest, entries, memberRole };
            }).sort((a, b) => b.sessions30d - a.sessions30d);

            return (
              <div>
                {/* Live Now */}
                {liveUsers.length > 0 && (
                  <div style={{
                    padding: '0.5rem 0.65rem', borderRadius: '10px', marginBottom: '0.5rem',
                    background: 'rgba(16, 185, 129, 0.08)', border: '1px solid rgba(16, 185, 129, 0.3)',
                  }}>
                    <div style={{ fontSize: '0.72rem', fontWeight: 600, color: '#10B981', marginBottom: '0.3rem' }}>
                      {t('settings.activity.liveNow', { count: liveUsers.length })}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                      {liveUsers.map(([name, entries]) => {
                        const latest = entries.reduce((a, b) => new Date(b.lastActive || b.timestamp) > new Date(a.lastActive || a.timestamp) ? b : a);
                        const screen = latest.screensVisited.length > 0 ? latest.screensVisited[latest.screensVisited.length - 1] : '';
                        return (
                          <span key={name} style={{
                            fontSize: '0.7rem', padding: '0.15rem 0.45rem', borderRadius: '12px',
                            background: 'rgba(16, 185, 129, 0.15)', color: '#34d399',
                          }}>
                            {name}{screen ? ` (${screen})` : ''}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Health Alerts */}
                {hasAlerts && (
                  <div style={{
                    padding: '0.5rem 0.65rem', borderRadius: '10px', marginBottom: '0.5rem',
                    background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.3)',
                  }}>
                    <div style={{ fontSize: '0.72rem', fontWeight: 600, color: '#f59e0b', marginBottom: '0.3rem' }}>
                      {t('settings.activity.alertsTitle')}
                    </div>
                    <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', lineHeight: 1.6 }}>
                      {neverLoggedIn.length > 0 && (
                        <div>{t('settings.activity.neverLoggedIn')} <span style={{ color: '#ef4444' }}>{neverLoggedIn.join(', ')}</span></div>
                      )}
                      {dormantMembers.length > 0 && (
                        <div>{t('settings.activity.dormant7')} <span style={{ color: '#f59e0b' }}>{dormantMembers.join(', ')}</span></div>
                      )}
                      {didntCheckLastGame.length > 0 && lastGame && (
                        <div>{t('settings.activity.didntCheckResults')} <span style={{ color: '#818cf8' }}>{didntCheckLastGame.join(', ')}</span></div>
                      )}
                    </div>
                  </div>
                )}

                {/* Summary Stats */}
                <div style={{
                  display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.35rem', marginBottom: '0.5rem',
                }}>
                  {[
                    { label: t('settings.activity.activeToday'), value: todayUniqueUsers, icon: '👤', color: todayUniqueUsers > 0 ? '#10B981' : 'var(--text)' },
                    { label: t('settings.activity.weeklyEngagement'), value: engagementPct > 0 ? `${engagementPct}%` : '—', icon: '📊', color: engagementPct > 70 ? '#10B981' : engagementPct > 40 ? '#f59e0b' : '#ef4444' },
                    { label: t('settings.activity.avgVisit'), value: avgSessionMin < 1 ? t('settings.activity.lessThanMin') : t('settings.activity.durationMinutes', { n: Math.round(avgSessionMin) }), icon: '⏱️', color: 'var(--text)' },
                    { label: t('settings.activity.daysSinceGame'), value: daysSinceLastGame >= 0 ? daysSinceLastGame : '—', icon: '🃏', color: daysSinceLastGame > 10 ? '#ef4444' : daysSinceLastGame > 5 ? '#f59e0b' : '#10B981' },
                  ].map(stat => (
                    <div key={stat.label} style={{
                      padding: '0.4rem', borderRadius: '8px', background: 'var(--surface)',
                      textAlign: 'center', border: '1px solid var(--border)',
                    }}>
                      <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>{stat.icon} {stat.label}</div>
                      <div style={{ fontSize: '1rem', fontWeight: 700, color: stat.color }}>{stat.value}</div>
                    </div>
                  ))}
                </div>

                {/* Member Cards — moved above heatmap */}
                <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.3rem', marginTop: '0.3rem' }}>
                  {t('settings.activity.membersSection', { count: userStats.length })}
                </div>
                {userStats.map((user, rank) => {
                  const isExpanded = expandedUser === user.name;
                  const roleInfo = getRoleInfo(user.memberRole);
                  const medal = rank === 0 ? '🥇' : rank === 1 ? '🥈' : rank === 2 ? '🥉' : '';
                  const isActive = user.daysSince === 0;
                  const borderColor = isActive ? 'rgba(16, 185, 129, 0.4)' : user.daysSince > 7 ? 'rgba(239, 68, 68, 0.3)' : 'var(--border)';
                  const maxSessions = userStats[0]?.sessions30d || 1;
                  const barPct = Math.round((user.sessions30d / maxSessions) * 100);
                  const topScreen = (() => {
                    const counts: Record<string, number> = {};
                    for (const e of user.entries) {
                      for (const s of e.screensVisited) { counts[s] = (counts[s] || 0) + 1; }
                    }
                    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
                    return sorted[0]?.[0] || null;
                  })();

                  return (
                    <div key={user.name}>
                      <div
                        onClick={() => setExpandedUser(isExpanded ? null : user.name)}
                        style={{
                          padding: '0.55rem 0.7rem', borderRadius: '10px',
                          background: 'var(--surface)', marginBottom: isExpanded ? 0 : '0.4rem',
                          cursor: 'pointer', border: `1px solid ${borderColor}`,
                          borderBottom: isExpanded ? 'none' : undefined,
                          borderBottomLeftRadius: isExpanded ? 0 : '10px',
                          borderBottomRightRadius: isExpanded ? 0 : '10px',
                        }}
                      >
                        {/* Row 1: name + role + status */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                            {medal && <span style={{ fontSize: '0.8rem' }}>{medal}</span>}
                            <span style={{ fontWeight: 700, fontSize: '0.88rem', color: 'var(--text)' }}>{user.name}</span>
                            <span style={{
                              fontSize: '0.58rem', padding: '0.1rem 0.35rem', borderRadius: '4px',
                              background: `${roleInfo.color}20`, color: roleInfo.color, fontWeight: 600,
                            }}>
                              {roleInfo.emoji} {roleInfo.name}
                            </span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                            <span style={{
                              fontSize: '0.62rem', fontWeight: 600,
                              color: isActive ? '#10B981' : user.daysSince > 7 ? '#ef4444' : '#f59e0b',
                            }}>
                              {isActive ? t('settings.activity.activeTodayBadge') : user.daysSince > 30 ? t('settings.activity.weeksAgo', { weeks: Math.round(user.daysSince / 7) }) : t('settings.activity.daysAgo', { days: user.daysSince })}
                            </span>
                            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                              {isExpanded ? '▲' : '▼'}
                            </span>
                          </div>
                        </div>

                        {/* Row 2: activity bar + stats */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.35rem' }}>
                          <div style={{ flex: 1, height: '4px', borderRadius: '2px', background: 'var(--background)', overflow: 'hidden' }}>
                            <div style={{
                              width: `${barPct}%`, height: '100%', borderRadius: '2px',
                              background: isActive ? '#10B981' : user.daysSince > 7 ? '#ef4444' : '#818cf8',
                              transition: 'width 0.3s',
                            }} />
                          </div>
                          <span style={{ fontSize: '0.62rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                            {user.sessions30d} {t('settings.activity.visits')}
                          </span>
                        </div>

                        {/* Row 3: quick stats */}
                        <div style={{
                          display: 'flex', gap: '0.6rem', fontSize: '0.62rem', color: 'var(--text-muted)', marginTop: '0.25rem', flexWrap: 'wrap',
                        }}>
                          <span>{t('settings.activity.avgMin', { mins: user.avgDuration < 1 ? '<1' : String(Math.round(user.avgDuration)) })}</span>
                          {topScreen && <span>📱 {topScreen}</span>}
                        </div>
                      </div>

                      {/* Expanded: recent sessions */}
                      {isExpanded && (
                        <div style={{
                          padding: '0.5rem 0.65rem', borderRadius: '0 0 10px 10px',
                          background: 'var(--surface)', marginBottom: '0.4rem',
                          border: `1px solid ${borderColor}`, borderTop: '1px solid var(--border)',
                        }}>
                          {(() => {
                            const meaningful = user.entries
                              .filter(e => e.screensVisited.length > 0 || e.sessionDuration > 0)
                              .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
                              .slice(0, 5);

                            if (meaningful.length === 0) {
                              return (
                                <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textAlign: 'center', padding: '0.3rem' }}>
                                  אין נתוני סשן מפורטים
                                </div>
                              );
                            }
                            return meaningful.map((entry, i) => (
                              <div
                                key={`${entry.timestamp}-${i}`}
                                style={{
                                  padding: '0.3rem 0.4rem', borderRadius: '6px',
                                  background: 'var(--background)', fontSize: '0.68rem',
                                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                  flexWrap: 'wrap', marginBottom: '0.2rem',
                                }}
                              >
                                <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'baseline', flex: 1, minWidth: 0, flexWrap: 'wrap' }}>
                                  {entry.sessionDuration > 0 && (
                                    <span style={{ color: '#818cf8', fontWeight: 500, whiteSpace: 'nowrap' }}>
                                      {entry.sessionDuration < 1 ? '<1' : Math.round(entry.sessionDuration)}m
                                    </span>
                                  )}
                                  {entry.screensVisited.length > 0 && (
                                    <span style={{ color: 'var(--text-muted)', wordBreak: 'break-word' }}>
                                      {entry.screensVisited.join(' > ')}
                                    </span>
                                  )}
                                </div>
                                <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap', marginLeft: '0.5rem', opacity: 0.7 }}>
                                  {formatRelativeTime(entry.timestamp)}
                                </span>
                              </div>
                            ));
                          })()}
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Heatmap */}
                <div style={{
                  padding: '0.5rem 0.65rem', borderRadius: '10px', marginBottom: '0.5rem', marginTop: '0.3rem',
                  background: 'var(--surface)', border: '1px solid var(--border)',
                }}>
                  <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.35rem' }}>
                    {t('settings.activity.heatmapTitle')}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'auto repeat(4, 1fr)', gap: '2px', fontSize: '0.6rem' }}>
                    <div />
                    {slotNames.map(s => (
                      <div key={s} style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.55rem', paddingBottom: '2px' }}>{s}</div>
                    ))}
                    {dayNames.map((day, di) => (
                      <>
                        <div key={`label-${di}`} style={{ color: 'var(--text-muted)', paddingLeft: '2px', display: 'flex', alignItems: 'center' }}>{day}</div>
                        {heatmap[di].map((count, si) => {
                          const intensity = count / maxHeat;
                          return (
                            <div
                              key={`${di}-${si}`}
                              title={`${dayNames[di]} ${slotNames[si]}: ${count} sessions`}
                              style={{
                                height: '18px', borderRadius: '3px',
                                background: count === 0
                                  ? 'var(--background)'
                                  : `rgba(99, 102, 241, ${0.15 + intensity * 0.7})`,
                              }}
                            />
                          );
                        })}
                      </>
                    ))}
                  </div>
                </div>

                {/* Post-Game Engagement */}
                {postGameEngagement.length > 0 && (
                  <div style={{
                    padding: '0.5rem 0.65rem', borderRadius: '10px', marginBottom: '0.5rem',
                    background: 'var(--surface)', border: '1px solid var(--border)',
                  }}>
                    <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.35rem' }}>
                      {t('settings.activity.postGameEngagement')}
                    </div>
                    {postGameEngagement.map(({ game, visitedCount }) => {
                      const d = new Date(game.date);
                      const label = d.toLocaleDateString('he-IL', { day: 'numeric', month: 'short' });
                      const total = memberNames.length || 1;
                      const pct = Math.round((visitedCount / total) * 100);
                      return (
                        <div key={game.id} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.25rem' }}>
                          <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', minWidth: '50px' }}>{label}</span>
                          <div style={{ flex: 1, height: '6px', borderRadius: '3px', background: 'var(--background)', overflow: 'hidden' }}>
                            <div style={{
                              width: `${pct}%`, height: '100%', borderRadius: '3px',
                              background: pct > 70 ? '#10B981' : pct > 40 ? '#f59e0b' : '#ef4444',
                            }} />
                          </div>
                          <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', minWidth: '55px', textAlign: isRTL ? 'left' : 'right' }}>
                            {visitedCount}/{total} ({pct}%)
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}

                <div style={{ marginTop: '0.5rem', fontSize: '0.65rem', color: 'var(--text-muted)', textAlign: 'center' }}>
                  {t('settings.activity.recordsWithCount', { count: activityLog.length })}
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* Add Player Modal */}
      {showAddPlayer && (
        <div className="modal-overlay" onClick={() => setShowAddPlayer(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">{t('settings.players.addTitle')}</h3>
              <button className="modal-close" onClick={() => setShowAddPlayer(false)}>×</button>
            </div>
            {error && <p style={{ color: 'var(--danger)', marginBottom: '0.5rem' }}>{error}</p>}
            <div className="input-group">
              <label className="label">{t('settings.players.playerName')}</label>
              <input
                type="text"
                className="input"
                placeholder={t('settings.players.enterName')}
                value={newPlayerName}
                onChange={e => setNewPlayerName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddPlayer()}
                autoFocus
              />
            </div>
            <div className="input-group">
              <label className="label">{t('settings.players.playerType')}</label>
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
                  {t('settings.players.permanent')}
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
                  {t('settings.players.guest')}
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
                  {t('settings.players.occasional')}
                </button>
              </div>
            </div>
            <div className="input-group">
              <label className="label">{t('settings.players.gender')}</label>
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
                  {t('settings.players.male')}
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
                  {t('settings.players.female')}
                </button>
              </div>
            </div>
            <div className="actions">
              <button className="btn btn-secondary" onClick={() => setShowAddPlayer(false)}>
                {t('common.cancel')}
              </button>
              <button className="btn btn-primary" onClick={handleAddPlayer}>
                {t('settings.players.add')}
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
              <h3 className="modal-title">{t('settings.players.editTitle')}</h3>
              <button className="modal-close" onClick={() => setShowEditPlayer(false)}>×</button>
            </div>
            {error && <p style={{ color: 'var(--danger)', marginBottom: '0.5rem' }}>{error}</p>}
            <div className="input-group">
              <label className="label">{t('settings.players.playerName')}</label>
              <input
                type="text"
                className="input"
                placeholder={t('settings.players.enterName')}
                value={editPlayerName}
                onChange={e => setEditPlayerName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleEditPlayer()}
                autoFocus
              />
            </div>
            <div className="input-group">
              <label className="label">{t('settings.players.playerType')}</label>
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
                  {t('settings.players.permanent')}
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
                  {t('settings.players.guest')}
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
                  {t('settings.players.occasional')}
                </button>
              </div>
            </div>
            <div className="input-group">
              <label className="label">{t('settings.players.gender')}</label>
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
                  {t('settings.players.male')}
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
                  {t('settings.players.female')}
                </button>
              </div>
            </div>
            <p className="text-muted" style={{ fontSize: '0.8rem', marginBottom: '1rem' }}>
              {t('settings.players.nameWarning')}
            </p>
            <div className="actions">
              <button className="btn btn-secondary" onClick={() => setShowEditPlayer(false)}>
                {t('common.cancel')}
              </button>
              <button className="btn btn-primary" onClick={handleEditPlayer}>
                {t('settings.players.saveChanges')}
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
              <h3 className="modal-title">{t('settings.chips.addTitle')}</h3>
              <button className="modal-close" onClick={() => setShowAddChip(false)}>×</button>
            </div>
            {error && <p style={{ color: 'var(--danger)', marginBottom: '0.5rem' }}>{error}</p>}
            <div className="input-group">
              <label className="label">{t('settings.chips.chipName')}</label>
              <input
                type="text"
                className="input"
                placeholder={t('settings.chips.chipNamePlaceholder')}
                value={newChip.color}
                onChange={e => setNewChip({ ...newChip, color: e.target.value })}
              />
            </div>
            <div className="input-group">
              <label className="label">{t('settings.chips.chipPoints')}</label>
              <input
                type="number"
                className="input"
                placeholder={t('settings.chips.chipPointsPlaceholder')}
                value={newChip.value}
                onChange={e => setNewChip({ ...newChip, value: e.target.value })}
                min="1"
              />
              <p className="text-muted" style={{ fontSize: '0.875rem', marginTop: '0.25rem' }}>
                {t('settings.chips.chipPointsHelper')}
              </p>
            </div>
            <div className="input-group">
              <label className="label">{t('settings.chips.displayColor')}</label>
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
                {t('common.cancel')}
              </button>
              <button className="btn btn-primary" onClick={handleAddChip}>
                {t('settings.chips.confirmAdd')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Player Confirmation Modal */}
      {deletePlayerConfirm && (() => {
        const hasGames = playerHasGames(deletePlayerConfirm.id);
        return (
          <div className="modal-overlay" onClick={() => setDeletePlayerConfirm(null)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h3 className="modal-title">{t('settings.players.deleteTitle')}</h3>
                <button className="modal-close" onClick={() => setDeletePlayerConfirm(null)}>×</button>
              </div>
              {hasGames ? (
                <>
                  <p style={{ marginBottom: '1rem', color: '#ef4444', fontWeight: 600 }}>
                    {t('settings.players.cannotDelete', { name: deletePlayerConfirm.name })}
                  </p>
                  <p className="text-muted" style={{ fontSize: '0.85rem', marginBottom: '1rem' }}>
                    {t('settings.players.cannotDeleteReason')}
                  </p>
                  <div className="actions">
                    <button className="btn btn-secondary" onClick={() => setDeletePlayerConfirm(null)}>
                      {t('common.close')}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p style={{ marginBottom: '1rem' }}>
                    {t('settings.players.deleteConfirm', { name: deletePlayerConfirm.name })}
                  </p>
                  <p className="text-muted" style={{ fontSize: '0.85rem', marginBottom: '1rem' }}>
                    {t('settings.players.deleteNote')}
                  </p>
                  <div className="actions">
                    <button className="btn btn-secondary" onClick={() => setDeletePlayerConfirm(null)}>
                      {t('common.cancel')}
                    </button>
                    <button className="btn btn-danger" onClick={() => handleDeletePlayer(deletePlayerConfirm.id)}>
                      {t('common.delete')}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })()}

      {/* Delete Chip Confirmation Modal */}
      {deleteChipConfirm && (
        <div className="modal-overlay" onClick={() => setDeleteChipConfirm(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">{t('settings.chips.deleteTitle')}</h3>
              <button className="modal-close" onClick={() => setDeleteChipConfirm(null)}>×</button>
            </div>
            <p style={{ marginBottom: '1rem' }}>
              {t('settings.chips.deleteConfirm', { name: deleteChipConfirm.name })}
            </p>
            <div className="actions">
              <button className="btn btn-secondary" onClick={() => setDeleteChipConfirm(null)}>
                {t('common.cancel')}
              </button>
              <button className="btn btn-danger" onClick={() => handleDeleteChip(deleteChipConfirm.id)}>
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};

export default SettingsScreen;

