import { useState, useEffect, useCallback, Fragment } from 'react';
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh';
import { useNavigate } from 'react-router-dom';
import { Player, PlayerType, PlayerGender, ChipValue, Settings, BlockedTransferPair, PlayerTraits } from '../types';
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
  getAllGames,
  downloadFullBackup,
  pushBackupToGitHub,
  listGitHubBackups,
  fetchGitHubBackup,
  restoreFromBackup,
  parseBackupSummary,
  getLastBackupDate,
  getAllPlayerTraits,
  savePlayerTraits,
  getGroupPushSubscribers,
} from '../database/storage';
import { getGeminiApiKey, getModelDisplayName, testModelAvailability, ModelTestResult } from '../utils/geminiAI';
import { getElevenLabsApiKey, getElevenLabsUsageLive, getElevenLabsGameHistory, deleteElevenLabsGameEntry } from '../utils/tts';
import { proxyGeminiGenerate, proxyElevenLabsTTS, proxySendPush, proxySendEmail } from '../utils/apiProxy';
import { getAIStatus, getTodayActions, getTodayTokens, getTodayLog, resetUsage, type AIStatusData } from '../utils/aiUsageTracker';
import { fetchActivityLog } from '../utils/activityLogger';
import { fetchTrainingAnswers } from '../database/trainingData';
import { ActivityLogEntry, TrainingPlayerData } from '../types';
import { APP_VERSION, CHANGELOG } from '../version';
import { isEdgeBrowser } from '../utils/tts';
import { usePermissions } from '../App';
import { getRoleDisplayName, getRoleEmoji } from '../permissions';
import { supabase } from '../database/supabaseClient';
import { getGroupId } from '../database/supabaseCache';
import TrainingAdminTab from '../components/TrainingAdminTab';
import GroupManagementTab from '../components/GroupManagementTab';
import GroupSetupScreen from './GroupSetupScreen';
import type { GroupMember } from '../hooks/useSupabaseAuth';
import { useTranslation } from '../i18n';

const SettingsScreen = () => {
  const navigate = useNavigate();
  const { t, isRTL, language, setLanguage } = useTranslation();
  const { role, isOwner, isSuperAdmin, playerName: authPlayerName, hasPermission, signOut, groupMgmt, multiGroup } = usePermissions();
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

  // Group setup overlay (create/join)
  const [groupSetupMode, setGroupSetupMode] = useState<'create' | 'join' | null>(null);
  const [groupJustCreated, setGroupJustCreated] = useState(false);

  // Activity log state
  const [activityLog, setActivityLog] = useState<ActivityLogEntry[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  const [activityMembers, setActivityMembers] = useState<GroupMember[]>([]);
  const [trainingPlayers, setTrainingPlayers] = useState<TrainingPlayerData[]>([]);
  const [deviceLabels] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('poker_device_labels') || '{}'); } catch { return {}; }
  });

  // Player traits editor state
  const [editingTraitsPlayer, setEditingTraitsPlayer] = useState<Player | null>(null);
  const [traitsForm, setTraitsForm] = useState<PlayerTraits>({ style: [], quirks: [] });
  const [traitsStyleText, setTraitsStyleText] = useState('');
  const [traitsQuirksText, setTraitsQuirksText] = useState('');
  const [traitsSaving, setTraitsSaving] = useState(false);

  // Super Admin dashboard state
  interface GlobalGroup {
    id: string;
    name: string;
    created_at: string;
    created_by: string;
    training_enabled: boolean;
    owner_email: string | null;
    member_count: number;
    player_count: number;
    game_count: number;
    completed_game_count: number;
    last_game_date: string | null;
    active_users_7d: number;
    training_players: number;
    training_players_total: number;
    feature_adoption: { screen: string; users: number }[];
  }
  interface GlobalStats {
    total_groups: number;
    total_users: number;
    total_games: number;
    total_players: number;
    total_active_users_7d: number;
    total_training_players: number;
    groups: GlobalGroup[];
    orphaned_groups: { id: string; name: string; created_at: string; created_by: string }[];
  }
  const [globalStats, setGlobalStats] = useState<GlobalStats | null>(null);
  const [globalLoading, setGlobalLoading] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [globalSubTab, setGlobalSubTab] = useState<'mine' | 'others'>('mine');
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);

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
      setGlobalError(t('settings.superAdmin.trainingToggleError', { message: error.message }));
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


  type TabId = 'group' | 'game' | 'chips' | 'players' | 'backup' | 'about' | 'activity' | 'ai' | 'training' | 'superadmin' | 'push';
  const getDefaultTab = (): TabId => 'group';
  
  const [activeTab, setActiveTab] = useState<TabId>(getDefaultTab());
  const [wizardStepIdx, setWizardStepIdx] = useState<number | null>(null);
  const [wizardDismissed, setWizardDismissed] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);

  // Backup state
  const [backupLoading, setBackupLoading] = useState(false);
  const [backupStatus, setBackupStatus] = useState<string | null>(null);
  const [githubBackups, setGithubBackups] = useState<{ name: string; size: number }[]>([]);
  const [githubLoading, setGithubLoading] = useState(false);
  const [githubLoaded, setGithubLoaded] = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);

  // Push notification state
  const [pushMsg, setPushMsg] = useState('');
  const [pushTarget, setPushTarget] = useState<'all' | 'select'>('all');
  const [pushSelectedPlayers, setPushSelectedPlayers] = useState<string[]>([]);
  const [pushSending, setPushSending] = useState(false);
  const [pushResult, setPushResult] = useState<string | null>(null);
  const [pushDetails, setPushDetails] = useState<{ player: string; type: string; status: number | string; ok: boolean; log?: string[] }[] | null>(null);
  const [pushSubscriberCount, setPushSubscriberCount] = useState(0);

  useEffect(() => {
    loadData();
  }, []);

  const [pushSubscribers, setPushSubscribers] = useState<{ playerName: string | null; endpoint: string }[]>([]);

  // Load push subscribers when tab is active
  useEffect(() => {
    const gid = getGroupId();
    if (activeTab === 'push' && gid) {
      getGroupPushSubscribers(gid).then(subs => {
        setPushSubscriberCount(subs.length);
        setPushSubscribers(subs);
      });
    }
  }, [activeTab]);

  // Auto-load activity log + group members when tab is selected
  useEffect(() => {
    if (isOwner && groupMgmt && activityMembers.length === 0) {
      groupMgmt.fetchMembers().then(m => setActivityMembers(m));
    }
  }, [isOwner, groupMgmt]);

  useEffect(() => {
    if (activeTab === 'activity' && isOwner && activityLog.length === 0 && !activityLoading) {
      loadActivityLog();
    }
  }, [activeTab]);

  // Auto-load global stats when super admin tab is selected
  useEffect(() => {
    if (activeTab === 'superadmin' && isSuperAdmin && !globalStats && !globalLoading && !globalError) {
      loadGlobalStats();
    }
  }, [activeTab, isSuperAdmin, globalStats, globalLoading, globalError, loadGlobalStats]);

  // Auto-load GitHub backups when backup tab is selected
  useEffect(() => {
    if (activeTab === 'backup' && isOwner && groupMgmt?.groupName && !githubLoaded && !githubLoading) {
      setGithubLoading(true);
      listGitHubBackups(groupMgmt.groupName).then(files => {
        setGithubBackups(files);
        setGithubLoading(false);
        setGithubLoaded(true);
      });
    }
  }, [activeTab, isOwner, groupMgmt?.groupName, githubLoaded, githubLoading]);

  // Load AI status when AI tab is selected + tick for countdowns
  useEffect(() => {
    if (activeTab !== 'ai') return;
    setAiStatus(getAIStatus());
    const savedElKey = getElevenLabsApiKey();
    if (savedElKey) {
      getElevenLabsUsageLive(savedElKey).then(u => setElUsageLive(u ?? { used: 0, limit: 10000, remaining: 10000, resetDate: '' }));
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
      const { data: { user } } = await supabase.auth.getUser();
      const [entries, trainingData] = await Promise.all([
        fetchActivityLog(user?.id),
        fetchTrainingAnswers(),
      ]);
      setActivityLog(entries.reverse());
      setTrainingPlayers(trainingData?.players || []);
    } catch (err) {
      setActivityError(err instanceof Error ? err.message : t('settings.activity.loadError'));
    } finally {
      setActivityLoading(false);
    }
  };

  // handleClearActivityLog removed — trash button was removed from Activity tab


  const getRoleInfo = (r: string) => {
    switch (r) {
      case 'admin': return { emoji: '👑', name: t('settings.role.admin'), color: '#f59e0b' };
      case 'member': return { emoji: '⭐', name: t('settings.role.member'), color: '#10B981' };
      default: return { emoji: '👤', name: r, color: '#94a3b8' };
    }
  };

  // Filter tabs based on permissions
  const allTabs = [
    { id: 'group', label: t('settings.tabGroup'), icon: '🏠', requiresPermission: null, ownerOnly: false, adminOnly: false, superAdminOnly: false },
    { id: 'players', label: t('settings.tabPlayers'), icon: '👥', requiresPermission: 'player:add' as const, ownerOnly: false, adminOnly: false, superAdminOnly: false },
    { id: 'chips', label: t('settings.tabChips'), icon: '🎰', requiresPermission: 'chips:edit' as const, ownerOnly: false, adminOnly: false, superAdminOnly: false },
    { id: 'game', label: t('settings.tabGame'), icon: '💰', requiresPermission: 'settings:edit' as const, ownerOnly: false, adminOnly: false, superAdminOnly: false },
    { id: 'backup', label: t('settings.tabBackup'), icon: '📦', requiresPermission: null, ownerOnly: true, adminOnly: false, superAdminOnly: false },
    { id: 'ai', label: t('settings.tabAI'), icon: '🤖', requiresPermission: null, ownerOnly: true, adminOnly: false, superAdminOnly: false },
    { id: 'training', label: t('settings.tabTraining'), icon: '🎯', requiresPermission: null, ownerOnly: false, adminOnly: false, superAdminOnly: true },
    { id: 'push', label: t('push.tabLabel'), icon: '🔔', requiresPermission: null, ownerOnly: false, adminOnly: true, superAdminOnly: false },
    { id: 'activity', label: t('settings.tabActivity'), icon: '📊', requiresPermission: null, ownerOnly: true, adminOnly: false, superAdminOnly: false },
    { id: 'superadmin', label: t('settings.tabSuperAdmin'), icon: '🛡️', requiresPermission: null, ownerOnly: false, adminOnly: false, superAdminOnly: true },
    { id: 'about', label: t('settings.tabAbout'), icon: 'ℹ️', requiresPermission: null, ownerOnly: false, adminOnly: false, superAdminOnly: false },
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

      {/* Poker Training - Super Admin Only (hidden banner, navigable via Training tab) */}
      {isSuperAdmin && false && (
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
        const hasGameSettings = (settings.locations ?? []).length > 0 || getAllGames().length > 0;
        const hasChips = chipValues.length > 0 || getAllGames().length > 0;
        const aiWorking = !!settings.geminiApiKey || getAllGames().some(g => g.aiSummary);
        const hasInvited = (activityMembers.length > 1) || getAllGames().length > 0;
        const steps = [
          { done: hasPlayers, label: t('settings.setup.stepPlayers'), desc: t('settings.setup.stepPlayersDesc'), icon: hasPlayers ? '✅' : '👥', tab: 'players' as TabId },
          { done: hasGameSettings, label: t('settings.setup.stepLocations'), desc: t('settings.setup.stepLocationsDesc'), icon: hasGameSettings ? '✅' : '⚙️', tab: 'game' as TabId },
          { done: hasChips, label: t('settings.setup.stepChips'), desc: t('settings.setup.stepChipsDesc'), icon: hasChips ? '✅' : '🎰', tab: 'chips' as TabId },
          { done: aiWorking, label: t('settings.setup.stepAi'), desc: t('settings.setup.stepAiDesc'), icon: aiWorking ? '✅' : '🔑', tab: 'ai' as TabId },
          { done: hasInvited, label: t('settings.setup.stepInvite'), desc: t('settings.setup.stepInviteDesc'), icon: hasInvited ? '✅' : '📨', tab: 'group' as TabId },
        ];
        const allDone = steps.every(s => s.done);
        if (allDone || wizardDismissed) return null;
        const navigableSteps = steps.filter(s => s.tab);
        const firstIncomplete = navigableSteps.findIndex(s => !s.done);
        const defaultIdx = firstIncomplete >= 0 ? firstIncomplete : 0;
        return (
          <div style={{
            background: 'linear-gradient(135deg, rgba(99,102,241,0.08), rgba(168,85,247,0.08))',
            border: '1px solid rgba(99,102,241,0.2)',
            borderRadius: '12px',
            padding: '0.75rem 1rem',
            marginBottom: '0.75rem',
          }}>
            {(() => {
              const wizardIdx = wizardStepIdx ?? defaultIdx;
              const current = navigableSteps[wizardIdx];
              if (!current) return null;
              const activeStepIndex = steps.indexOf(current);
              const isFirst = wizardIdx === 0;
              const isLast = wizardIdx === navigableSteps.length - 1;
              const arrowStyle: React.CSSProperties = {
                background: 'none', border: 'none', color: '#818cf8', cursor: 'pointer',
                fontSize: '1.1rem', padding: '0.3rem 0.5rem', opacity: 1,
              };
              const disabledArrow: React.CSSProperties = { ...arrowStyle, opacity: 0.25, cursor: 'default' };
              return (<>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                  <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#a78bfa' }}>{t('settings.setup.bannerTitle')}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                      {wizardIdx + 1}/{navigableSteps.length}
                    </span>
                    <button
                      onClick={() => setWizardDismissed(true)}
                      style={{
                        background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer',
                        fontSize: '0.7rem', padding: '0.15rem 0.4rem', borderRadius: '4px',
                        opacity: 0.7,
                      }}
                    >{language === 'he' ? 'סגור' : 'Close'}</button>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.5rem' }}>
                  {steps.map((s, i) => (
                    <div key={i} style={{
                      flex: 1, height: '4px', borderRadius: '2px',
                      background: i === activeStepIndex
                        ? (s.done ? '#10B981' : '#818cf8')
                        : (s.done ? 'rgba(16,185,129,0.3)' : 'rgba(100,100,100,0.2)'),
                    }} />
                  ))}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', direction: 'rtl' }}>
                  <button
                    onClick={() => { if (!isFirst) { const ni = wizardIdx - 1; setWizardStepIdx(ni); setActiveTab(navigableSteps[ni].tab!); } }}
                    style={isFirst ? disabledArrow : arrowStyle}
                    disabled={isFirst}
                  >→</button>
                  <button
                    onClick={() => setActiveTab(current.tab!)}
                    style={{
                      flex: 1, padding: '0.5rem', borderRadius: '8px', border: 'none',
                      background: 'rgba(99,102,241,0.15)', color: '#818cf8', cursor: 'pointer',
                      fontSize: '0.8rem', fontWeight: 600, fontFamily: 'Outfit, sans-serif',
                    }}
                  >
                    {current.icon} {current.label}
                  </button>
                  <button
                    onClick={() => {
                      if (isLast) { setWizardDismissed(true); setShowWelcome(true); }
                      else { const ni = wizardIdx + 1; setWizardStepIdx(ni); setActiveTab(navigableSteps[ni].tab!); }
                    }}
                    style={isLast ? {
                      background: '#10B981', border: 'none', color: '#fff', cursor: 'pointer',
                      fontSize: '0.9rem', fontWeight: 700, padding: '0.3rem 0.6rem', borderRadius: '6px',
                    } : arrowStyle}
                  >{isLast ? '✓' : '←'}</button>
                </div>
                <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)', textAlign: 'center', marginTop: '0.35rem' }}>
                  {current.desc}
                </div>
              </>);
            })()}
          </div>
        );
      })()}

      {/* Tabs */}
      <div className="card" style={{ padding: '0.75rem' }}>
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.35rem',
        }}>
          {tabs.map(tab => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                className="btn btn-sm btn-secondary"
                onClick={() => setActiveTab(tab.id)}
                style={{
                  padding: '0.4rem 0.55rem', fontSize: '0.7rem',
                  whiteSpace: 'nowrap',
                  ...(isActive ? {
                    background: 'rgba(16, 185, 129, 0.15)',
                    border: '1px solid rgba(16, 185, 129, 0.4)',
                    color: '#34d399',
                  } : {}),
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
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

      {/* Backup reminder banner - show when >30 days since last backup */}
      {isOwner && activeTab !== 'backup' && (() => {
        const last = getLastBackupDate();
        if (!last) return null;
        const days = Math.floor((Date.now() - new Date(last).getTime()) / 86400000);
        if (days <= 30) return null;
        return (
          <div className="card" style={{
            background: 'rgba(234, 179, 8, 0.1)',
            borderLeft: '4px solid #eab308',
            marginBottom: '1rem',
            cursor: 'pointer',
          }} onClick={() => setActiveTab('backup')}>
            <p style={{ color: '#eab308', fontSize: '0.85rem', margin: 0 }}>
              {t('settings.backup.reminder')}
            </p>
          </div>
        );
      })()}

      {/* Tab content with crossfade */}
      <div key={activeTab} style={{ animation: 'contentFadeIn 0.2s ease-out' }}>

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
          createPlayerInvite={groupMgmt.createPlayerInvite}
          addMemberByEmail={groupMgmt.addMemberByEmail}
          deleteGroup={multiGroup ? () => multiGroup.deleteGroup(multiGroup.activeGroupId ?? '') : undefined}
          leaveGroup={multiGroup ? () => multiGroup.leaveGroup(multiGroup.activeGroupId ?? '') : undefined}
          appUrl={window.location.origin}
        />
      )}
      {activeTab === 'group' && multiGroup && (
        <div className="card" style={{ padding: '1rem', marginTop: '0.75rem' }}>
          <h2 className="card-title" style={{ margin: '0 0 0.5rem 0' }}>{t('groupSwitcher.manageGroups')}</h2>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
            {t('groupSwitcher.manageGroupsDesc')}
          </p>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              onClick={() => setGroupSetupMode('create')}
              style={{
                flex: 1, padding: '0.6rem', borderRadius: '8px',
                border: 'none', background: 'var(--primary)', color: 'white',
                cursor: 'pointer', fontFamily: 'Outfit, sans-serif',
                fontSize: '0.8rem', fontWeight: 600,
              }}
            >
              {t('groupSwitcher.createNew')}
            </button>
            <button
              onClick={() => setGroupSetupMode('join')}
              style={{
                flex: 1, padding: '0.6rem', borderRadius: '8px',
                border: '1px solid var(--border)', background: 'transparent',
                color: 'var(--text)', cursor: 'pointer',
                fontFamily: 'Outfit, sans-serif',
                fontSize: '0.8rem', fontWeight: 600,
              }}
            >
              {t('groupSwitcher.joinGroup')}
            </button>
          </div>
        </div>
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
              {(settings.locations ?? []).length === 0 && (
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                  {t('settings.game.noLocations')}
                </span>
              )}
              {(settings.locations ?? []).map(loc => (
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
                        const current = settings.locations ?? [];
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
                      const current = settings.locations ?? [];
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
                    const current = settings.locations ?? [];
                    if (!current.includes(newLocation.trim())) {
                      handleSettingsChange('locations', [...current, newLocation.trim()]);
                    }
                    setNewLocation('');
                  }}
                  style={{
                    fontSize: '0.8rem', padding: '0.35rem 0.7rem',
                    background: 'rgba(16,185,129,0.12)', color: '#10B981',
                    border: '1px solid rgba(16,185,129,0.3)', cursor: 'pointer',
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
                    (מ-{new Date(pair.after).toLocaleDateString(language === 'he' ? 'he-IL' : 'en-US')})
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
                    style={{ flex: 1, fontSize: '0.75rem', padding: '0.4rem 0.5rem', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.15)', background: '#1a1a2e', color: '#e2e8f0', fontFamily: 'Outfit, sans-serif', cursor: 'pointer' }}
                  >
                    <option value="" style={{ background: '#1a1a2e', color: '#94a3b8' }}>{t('settings.game.playerA')}</option>
                    {players.filter(p => p.type === 'permanent').map(p => (
                      <option key={p.id} value={p.name} style={{ background: '#1a1a2e', color: '#ffffff' }}>{p.name}</option>
                    ))}
                  </select>
                  <select
                    value={newBlockedB}
                    onChange={e => setNewBlockedB(e.target.value)}
                    style={{ flex: 1, fontSize: '0.75rem', padding: '0.4rem 0.5rem', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.15)', background: '#1a1a2e', color: '#e2e8f0', fontFamily: 'Outfit, sans-serif', cursor: 'pointer' }}
                  >
                    <option value="" style={{ background: '#1a1a2e', color: '#94a3b8' }}>{t('settings.game.playerB')}</option>
                    {players.filter(p => p.type === 'permanent' && p.name !== newBlockedA).map(p => (
                      <option key={p.id} value={p.name} style={{ background: '#1a1a2e', color: '#ffffff' }}>{p.name}</option>
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
                    style={{ fontSize: '0.75rem', padding: '0.35rem 0.7rem', background: 'rgba(16,185,129,0.12)', color: '#10B981', border: '1px solid rgba(16,185,129,0.3)', whiteSpace: 'nowrap', cursor: 'pointer' }}
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
                  className="row-action row-action-danger"
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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <h2 className="card-title" style={{ margin: 0 }}>{t('settings.players.title', { count: players.length })}</h2>
            </div>
            {canAddPlayers && (
              <button
                onClick={() => setShowAddPlayer(true)}
                style={{
                  padding: '0.35rem 0.75rem', borderRadius: '8px',
                  border: '1px solid rgba(16,185,129,0.3)', background: 'rgba(16,185,129,0.12)',
                  color: '#10B981', cursor: 'pointer',
                  fontSize: '0.75rem', fontFamily: 'Outfit, sans-serif', fontWeight: 600,
                }}
              >
                + {t('settings.players.add')}
              </button>
            )}
          </div>

          {players.length === 0 ? (
            <div className="empty-state" style={{ padding: '2rem 1rem' }}>
              <div className="empty-icon">👥</div>
              <p>{t('settings.players.noPlayers')}</p>
            </div>
          ) : (
            <div>
              {players.map((player, idx) => {
                const typeLabel = player.type === 'permanent' ? '⭐'
                  : player.type === 'permanent_guest' ? '🏠' : '👤';

                return (
                  <div
                    key={player.id}
                    className="settings-row"
                    style={{ animation: `contentFadeIn 0.25s ease-out ${idx * 0.03}s both` }}
                  >
                    <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                      <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{player.name}</span>
                      <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>{typeLabel}</span>
                      <span style={{ fontSize: '0.55rem', color: player.gender === 'female' ? '#EC4899' : '#60A5FA', opacity: 0.6 }}>
                        {player.gender === 'female' ? '♀' : '♂'}
                      </span>
                    </div>

                    {(canEditPlayers || canDeletePlayers) && (
                      <div style={{ display: 'flex', gap: '0.2rem', flexShrink: 0 }}>
                        {canEditPlayers && (
                          <button
                            className="row-action"
                            onClick={() => openEditPlayer(player)}
                            title={t('common.edit')}
                          >✏️</button>
                        )}
                        {canEditPlayers && (
                          <button
                            className="row-action row-action-purple"
                            onClick={() => {
                              const existing = getAllPlayerTraits().get(player.name);
                              setTraitsForm(existing ? { ...existing, style: [...existing.style], quirks: [...existing.quirks] } : { style: [], quirks: [] });
                              setTraitsStyleText(existing?.style.join(', ') || '');
                              setTraitsQuirksText(existing?.quirks.join(', ') || '');
                              setEditingTraitsPlayer(player);
                            }}
                            title={t('settings.traits.button')}
                          >🎭</button>
                        )}
                        {canDeletePlayers && (
                          <button
                            className="row-action row-action-danger"
                            onClick={() => setDeletePlayerConfirm({ id: player.id, name: player.name })}
                            title={t('settings.players.deleteTitle')}
                          >🗑️</button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Player Traits Editor Modal */}
      {editingTraitsPlayer && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.7)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem',
        }} onClick={() => setEditingTraitsPlayer(null)}>
          <div style={{
            background: 'var(--surface-card)', borderRadius: '12px', padding: '1.5rem',
            width: '100%', maxWidth: '420px', maxHeight: '85vh', overflowY: 'auto',
            border: '1px solid var(--border)',
          }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 1rem', color: 'var(--text)' }}>
              {t('settings.traits.title', { name: editingTraitsPlayer.name })}
            </h3>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <label style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{t('settings.traits.nickname')}</label>
              <input
                type="text"
                value={traitsForm.nickname || ''}
                onChange={e => setTraitsForm(f => ({ ...f, nickname: e.target.value || undefined }))}
                placeholder={t('settings.traits.nicknamePlaceholder')}
                style={{ background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.5rem 0.75rem', direction: 'rtl' }}
              />

              <label style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{t('settings.traits.job')}</label>
              <input
                type="text"
                value={traitsForm.job || ''}
                onChange={e => setTraitsForm(f => ({ ...f, job: e.target.value || undefined }))}
                placeholder={t('settings.traits.jobPlaceholder')}
                style={{ background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.5rem 0.75rem', direction: 'rtl' }}
              />

              <label style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{t('settings.traits.team')}</label>
              <input
                type="text"
                value={traitsForm.team || ''}
                onChange={e => setTraitsForm(f => ({ ...f, team: e.target.value || undefined }))}
                placeholder={t('settings.traits.teamPlaceholder')}
                style={{ background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.5rem 0.75rem', direction: 'rtl' }}
              />

              <label style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{t('settings.traits.style')}</label>
              <input
                type="text"
                value={traitsStyleText}
                onChange={e => setTraitsStyleText(e.target.value)}
                placeholder={t('settings.traits.stylePlaceholder')}
                style={{ background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.5rem 0.75rem', direction: 'rtl' }}
              />

              <label style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{t('settings.traits.quirks')}</label>
              <input
                type="text"
                value={traitsQuirksText}
                onChange={e => setTraitsQuirksText(e.target.value)}
                placeholder={t('settings.traits.quirksPlaceholder')}
                style={{ background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '8px', padding: '0.5rem 0.75rem', direction: 'rtl' }}
              />

              <p style={{ color: 'var(--text-muted)', fontSize: '0.7rem', margin: 0 }}>
                {t('settings.traits.help')}
              </p>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', justifyContent: 'flex-end' }}>
              <button
                className="btn btn-sm"
                style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--text)' }}
                onClick={() => setEditingTraitsPlayer(null)}
              >
                {t('common.cancel')}
              </button>
              <button
                className="btn btn-sm"
                style={{ background: 'rgba(16,185,129,0.12)', color: '#10B981', border: '1px solid rgba(16,185,129,0.3)', opacity: traitsSaving ? 0.6 : 1, cursor: 'pointer' }}
                disabled={traitsSaving}
                onClick={async () => {
                  setTraitsSaving(true);
                  const finalTraits = {
                    ...traitsForm,
                    style: traitsStyleText.split(',').map(s => s.trim()).filter(Boolean),
                    quirks: traitsQuirksText.split(',').map(s => s.trim()).filter(Boolean),
                  };
                  await savePlayerTraits(editingTraitsPlayer.id, editingTraitsPlayer.name, finalTraits);
                  setTraitsSaving(false);
                  setEditingTraitsPlayer(null);
                  setSaved(true);
                  setTimeout(() => setSaved(false), 2000);
                }}
              >
                {traitsSaving ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Backup Tab - Owner Only */}
      {activeTab === 'backup' && isOwner && (() => {
        const lastDate = getLastBackupDate();
        const daysSince = lastDate ? Math.floor((Date.now() - new Date(lastDate).getTime()) / 86400000) : null;
        const statusColor = daysSince === null ? 'var(--text-muted)' : daysSince <= 14 ? '#22c55e' : daysSince <= 30 ? '#eab308' : '#ef4444';
        const statusKey = daysSince === null ? 'settings.backup.never' : daysSince <= 14 ? 'settings.backup.statusGood' : daysSince <= 30 ? 'settings.backup.statusWarning' : 'settings.backup.statusCritical';
        const gameCount = getAllGames().length;
        const playerCount = getAllPlayers().length;
        const groupName = groupMgmt?.groupName || 'group';

        const handleDownload = async () => {
          setBackupLoading(true);
          setBackupStatus(null);
          try {
            const json = await downloadFullBackup(groupName);
            setBackupStatus(t('settings.backup.downloaded'));
            setBackupStatus(t('settings.backup.pushingGithub'));
            const ghResult = await pushBackupToGitHub(groupName, json);
            if (ghResult.success) {
              setBackupStatus(t('settings.backup.githubSuccess'));
              setGithubLoaded(false);
              setGithubBackups([]);
            } else {
              setBackupStatus(t('settings.backup.githubFailed', { error: ghResult.error || '' }));
            }
          } catch (err) {
            setBackupStatus(t('settings.backup.failed'));
            console.error('Backup failed:', err);
          }
          setBackupLoading(false);
        };

        const handleFileRestore = async (e: React.ChangeEvent<HTMLInputElement>) => {
          const file = e.target.files?.[0];
          if (!file) return;
          e.target.value = '';
          const text = await file.text();
          const summary = parseBackupSummary(text);
          if (!summary.valid) {
            setBackupStatus(t('settings.backup.invalidFile'));
            return;
          }
          const msg = `${t('settings.backup.restoreConfirm')}\n\n${summary.groupName} - ${summary.exportedAt?.split('T')[0]}\n${t('settings.backup.stats', { players: String(summary.playerCount || 0), games: String(summary.gameCount || 0) })}`;
          if (!window.confirm(msg)) return;
          const currentGroupId = getGroupId();
          if (!currentGroupId) { setBackupStatus(t('settings.backup.failed')); return; }
          setRestoreLoading(true);
          setBackupStatus(t('settings.backup.restoring'));
          const result = await restoreFromBackup(text, currentGroupId);
          if (result.success) {
            setBackupStatus(t('settings.backup.restoreSuccess', { tables: String(result.tablesRestored) }));
          } else {
            setBackupStatus(t('settings.backup.restoreErrors', { errors: result.errors.slice(0, 3).join(', ') }));
          }
          setRestoreLoading(false);
        };

        const handleGitHubRestore = async (fileName: string) => {
          if (!window.confirm(t('settings.backup.restoreConfirm'))) return;
          const currentGroupId = getGroupId();
          if (!currentGroupId) { setBackupStatus(t('settings.backup.failed')); return; }
          setRestoreLoading(true);
          setBackupStatus(t('settings.backup.fetchingBackup'));
          const content = await fetchGitHubBackup(groupName, fileName);
          if (!content) {
            setBackupStatus(t('settings.backup.failed'));
            setRestoreLoading(false);
            return;
          }
          setBackupStatus(t('settings.backup.restoring'));
          const result = await restoreFromBackup(content, currentGroupId);
          if (result.success) {
            setBackupStatus(t('settings.backup.restoreSuccess', { tables: String(result.tablesRestored) }));
          } else {
            setBackupStatus(t('settings.backup.restoreErrors', { errors: result.errors.slice(0, 3).join(', ') }));
          }
          setRestoreLoading(false);
        };

        return (
          <div>
            {/* Status Card */}
            <div className="card" style={{ marginBottom: '1rem' }}>
              <h2 className="card-title mb-2">{t('settings.backup.title')}</h2>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
                <div style={{
                  width: 12, height: 12, borderRadius: '50%',
                  background: statusColor, flexShrink: 0,
                }} />
                <div>
                  <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{t(statusKey as never)}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    {lastDate
                      ? `${t('settings.backup.lastBackup')} ${new Date(lastDate).toLocaleDateString(language === 'he' ? 'he-IL' : 'en-US')} (${t('settings.backup.daysAgo', { days: String(daysSince) })})`
                      : `${t('settings.backup.lastBackup')} ${t('settings.backup.never')}`}
                  </div>
                </div>
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
                {t('settings.backup.stats', { players: String(playerCount), games: String(gameCount) })}
              </div>

              {/* Download + Push Button */}
              <button
                className="btn btn-primary"
                onClick={handleDownload}
                disabled={backupLoading || restoreLoading}
                style={{ width: '100%', padding: '0.75rem', fontSize: '0.9rem', fontWeight: 600 }}
              >
                {backupLoading ? t('settings.backup.downloading') : t('settings.backup.downloadFull')}
              </button>

              {backupStatus && (
                <div style={{
                  marginTop: '0.75rem', padding: '0.5rem 0.75rem',
                  borderRadius: '0.5rem', fontSize: '0.85rem',
                  background: backupStatus.includes('✅') ? 'rgba(34, 197, 94, 0.1)' : backupStatus.includes('⚠️') ? 'rgba(234, 179, 8, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                  color: backupStatus.includes('✅') ? 'var(--success)' : backupStatus.includes('⚠️') ? '#eab308' : 'var(--danger)',
                }}>
                  {backupStatus}
                </div>
              )}
            </div>

            {/* Restore from File */}
            <div className="card" style={{ marginBottom: '1rem' }}>
              <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem' }}>
                {t('settings.backup.fromFile')} {t('settings.backup.restoreData')}
              </h3>
              <label
                className="btn btn-secondary"
                style={{ display: 'block', textAlign: 'center', cursor: restoreLoading ? 'not-allowed' : 'pointer', opacity: restoreLoading ? 0.5 : 1 }}
              >
                {restoreLoading ? t('settings.backup.restoring') : t('settings.backup.fromFile')}
                <input
                  type="file"
                  accept=".json"
                  onChange={handleFileRestore}
                  disabled={restoreLoading || backupLoading}
                  style={{ display: 'none' }}
                />
              </label>
            </div>

            {/* GitHub Backups */}
            <div className="card">
              <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '0.75rem' }}>
                {t('settings.backup.githubBackups')}
              </h3>
              {githubLoading ? (
                <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                  {t('settings.backup.loadingGithub')}
                </div>
              ) : githubBackups.length === 0 ? (
                <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                  {t('settings.backup.noGithubBackups')}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {githubBackups.map(f => (
                    <div key={f.name} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '0.5rem 0.75rem', borderRadius: '0.5rem',
                      background: 'var(--surface-alt, rgba(255,255,255,0.05))',
                      border: '1px solid var(--border)',
                    }}>
                      <div>
                        <div style={{ fontSize: '0.85rem', fontWeight: 500 }}>
                          {f.name.replace('poker-backup-', '').replace('.json', '')}
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                          {(f.size / 1024).toFixed(0)} KB
                        </div>
                      </div>
                      <button
                        className="btn btn-sm btn-secondary"
                        onClick={() => handleGitHubRestore(f.name)}
                        disabled={restoreLoading || backupLoading}
                        style={{ fontSize: '0.8rem' }}
                      >
                        {t('settings.backup.restore')}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })()}

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
                          padding: '0.5rem 0.75rem', borderRadius: '6px',
                          border: '1px solid rgba(16,185,129,0.3)', background: 'rgba(16,185,129,0.12)',
                          color: '#10B981', fontSize: '0.75rem',
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
                            padding: '0.5rem 0.75rem', borderRadius: '6px',
                            border: '1px solid rgba(16,185,129,0.3)', background: 'rgba(16,185,129,0.12)',
                            color: '#10B981', fontSize: '0.75rem',
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
                  המפתח בחינם עד 1,500 בקשות ביום — מספיק לגמרי לערבי פוקר
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
                  style={{ fontSize: '0.7rem', padding: '0.3rem 0.7rem', background: 'rgba(16,185,129,0.12)', color: '#10B981', border: '1px solid rgba(16,185,129,0.3)', borderRadius: 8, cursor: 'pointer' }}
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
                          const usageLoc = language === 'he' ? 'he-IL' : 'en-US';
                          const dateStr = d.toLocaleDateString(usageLoc, { day: 'numeric', month: 'short' });
                          const dayStr = d.toLocaleDateString(usageLoc, { weekday: 'short' });
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
                        const time = new Date(entry.timestamp).toLocaleTimeString(language === 'he' ? 'he-IL' : 'en-US', { hour: '2-digit', minute: '2-digit' });
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
        {/* App Guide button */}
        <button
          onClick={() => setShowWelcome(true)}
          style={{
            width: '100%', padding: '0.7rem', marginBottom: '0.75rem', borderRadius: '10px',
            border: '1px solid rgba(99,102,241,0.3)', background: 'rgba(99,102,241,0.08)',
            color: '#818cf8', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600,
            fontFamily: 'Outfit, sans-serif',
          }}
        >{t('settings.setup.aboutApp')}</button>
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
            <span style={{ fontSize: '1rem', fontWeight: '600' }}>{t('settings.about.language')}</span>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              {(['he', 'en'] as const).map(lang => (
                <button
                  key={lang}
                  onClick={() => {
                    setLanguage(lang);
                  }}
                  style={{
                    padding: '0.4rem 1rem',
                    borderRadius: '0.5rem',
                    border: language === lang ? '2px solid var(--primary)' : '1px solid var(--border)',
                    background: language === lang ? 'var(--primary)' : 'var(--surface)',
                    color: language === lang ? 'white' : 'var(--text)',
                    cursor: 'pointer',
                    fontWeight: '600',
                    fontSize: '0.875rem',
                  }}
                >
                  {lang === 'he' ? t('settings.lang.he') : t('settings.lang.en')}
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
        const myGroupId = getGroupId();
        const myGroup = globalStats?.groups.find(g => g.id === myGroupId);
        const otherGroups = globalStats?.groups.filter(g => g.id !== myGroupId) ?? [];
        const now = new Date();
        const oneDayMs = 86400000;

        const getActivityStatus = (lastGameDate: string | null) => {
          if (!lastGameDate) return { label: t('settings.superAdmin.inactive'), color: '#ef4444', bg: 'rgba(239,68,68,0.1)' };
          const days = Math.floor((now.getTime() - new Date(lastGameDate).getTime()) / oneDayMs);
          if (days <= 30) return { label: t('settings.superAdmin.active'), color: '#10B981', bg: 'rgba(16,185,129,0.1)' };
          if (days <= 90) return { label: t('settings.superAdmin.dormant'), color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' };
          return { label: t('settings.superAdmin.inactive'), color: '#ef4444', bg: 'rgba(239,68,68,0.1)' };
        };

        const daysAgo = (dateStr: string | null) => {
          if (!dateStr) return null;
          return Math.floor((now.getTime() - new Date(dateStr).getTime()) / oneDayMs);
        };

        return (
          <div>
            {globalLoading && (
              <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>🔄</div>
                {t('settings.superAdmin.loading')}
              </div>
            )}

            {globalError && (
              <div className="card" style={{ padding: '1rem', background: 'rgba(239,68,68,0.1)', borderInlineStart: '3px solid #EF4444' }}>
                <p style={{ color: '#EF4444', margin: 0, fontSize: '0.85rem' }}>{t('common.errorDetail', { detail: globalError })}</p>
                <button className="btn btn-sm" onClick={loadGlobalStats} style={{ marginTop: '0.5rem' }}>{t('common.retry')}</button>
              </div>
            )}

            {globalStats && (() => {
              const renderStatCards = (g: GlobalGroup) => {
                const lastGameLabel = g.last_game_date
                  ? new Date(g.last_game_date).toLocaleDateString(language === 'he' ? 'he-IL' : 'en-US', { day: '2-digit', month: '2-digit', year: '2-digit' })
                  : '—';
                const lastGameColor = g.last_game_date && daysAgo(g.last_game_date)! <= 30 ? '#10B981' : '#f59e0b';
                return (
                  <div style={{ marginBottom: '0.5rem' }}>
                    {/* Core stats row */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.4rem 0', borderBottom: '1px solid var(--border)', marginBottom: '0.35rem' }}>
                      {[
                        { label: language === 'he' ? 'חברים' : 'Members', value: g.member_count, color: 'var(--text)' },
                        { label: language === 'he' ? 'שחקנים' : 'Players', value: g.player_count ?? '—', color: '#818cf8' },
                        { label: language === 'he' ? 'משחקים' : 'Games', value: g.completed_game_count, color: '#10B981' },
                        { label: language === 'he' ? 'אחרון' : 'Last', value: lastGameLabel, color: lastGameColor },
                      ].map(s => (
                        <div key={s.label} style={{ textAlign: 'center' }}>
                          <div style={{ fontSize: '0.9rem', fontWeight: 700, color: s.color, lineHeight: 1.1 }}>{s.value}</div>
                          <div style={{ fontSize: '0.48rem', color: 'var(--text-muted)', marginTop: '0.05rem' }}>{s.label}</div>
                        </div>
                      ))}
                    </div>
                    {/* Engagement row */}
                    <div style={{ display: 'flex', gap: '0.5rem', fontSize: '0.6rem', color: 'var(--text-muted)', flexWrap: 'wrap' }}>
                      {g.active_users_7d > 0 && (
                        <span>📊 <span style={{ color: '#10B981', fontWeight: 600 }}>{g.active_users_7d}</span> {language === 'he' ? 'פעילים השבוע' : 'active this week'}</span>
                      )}
                      {g.training_players > 0 && (
                        <span>🎯 <span style={{ color: '#f59e0b', fontWeight: 600 }}>{g.training_players}</span> {language === 'he' ? 'מתאמנים השבוע' : 'trainers this week'}</span>
                      )}
                    </div>
                    {/* Feature Adoption */}
                    {g.feature_adoption && g.feature_adoption.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.2rem', marginTop: '0.3rem' }}>
                        {g.feature_adoption.map(f => {
                          const total = (g.player_count ?? g.member_count) || 1;
                          const pct = Math.round((f.users / total) * 100);
                          const color = pct >= 75 ? '#10B981' : pct >= 40 ? '#f59e0b' : '#ef4444';
                          return (
                            <span key={f.screen} style={{
                              fontSize: '0.52rem', padding: '0.1rem 0.3rem', borderRadius: '6px',
                              background: `${color}12`, color, fontWeight: 600,
                            }}>
                              {f.screen} {f.users}/{total}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              };

              const othersTotalMembers = otherGroups.reduce((s, g) => s + g.member_count, 0);
              const othersTotalPlayers = otherGroups.reduce((s, g) => s + (g.player_count ?? 0), 0);
              const othersTotalCompleted = otherGroups.reduce((s, g) => s + g.completed_game_count, 0);

              return (
                <>
                  {/* Platform Overview */}
                  <div style={{
                    padding: '0.65rem 0.75rem', borderRadius: '12px', marginBottom: '0.65rem',
                    background: 'linear-gradient(135deg, rgba(99,102,241,0.08), rgba(16,185,129,0.06))',
                    border: '1px solid rgba(99,102,241,0.15)',
                  }}>
                    <div style={{ fontSize: '0.65rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.4rem', letterSpacing: '0.02em' }}>
                      {t('settings.superAdmin.platformTotals')}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                      {[
                        { label: language === 'he' ? 'קבוצות' : 'Groups', value: globalStats.total_groups, color: '#818cf8' },
                        { label: language === 'he' ? 'משתמשים' : 'Users', value: globalStats.total_users, color: 'var(--text)' },
                        { label: language === 'he' ? 'שחקנים' : 'Players', value: globalStats.total_players, color: 'var(--text)' },
                        { label: language === 'he' ? 'משחקים' : 'Games', value: globalStats.total_games, color: '#10B981' },
                      ].map(s => (
                        <div key={s.label} style={{ textAlign: 'center' }}>
                          <div style={{ fontSize: '1.15rem', fontWeight: 700, color: s.color, lineHeight: 1.1 }}>{s.value}</div>
                          <div style={{ fontSize: '0.5rem', color: 'var(--text-muted)', marginTop: '0.1rem' }}>{s.label}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Sub-tab toggle */}
                  <div style={{ display: 'flex', gap: '0.35rem', marginBottom: '0.75rem' }}>
                    {(['mine', 'others'] as const).map(tab => (
                      <button
                        key={tab}
                        onClick={() => { setGlobalSubTab(tab); setExpandedGroupId(null); }}
                        style={{
                          flex: 1, padding: '0.5rem', borderRadius: '10px', border: 'none',
                          cursor: 'pointer', fontFamily: 'Outfit, sans-serif',
                          fontSize: '0.78rem', fontWeight: 600,
                          background: globalSubTab === tab ? 'rgba(99, 102, 241, 0.15)' : 'var(--surface)',
                          color: globalSubTab === tab ? '#818cf8' : 'var(--text-muted)',
                          transition: 'all 0.2s ease',
                        }}
                      >
                        {tab === 'mine' ? t('settings.superAdmin.tabMine') : t('settings.superAdmin.tabOthers', { count: otherGroups.length })}
                      </button>
                    ))}
                  </div>

                  {/* My Group sub-tab */}
                  {globalSubTab === 'mine' && myGroup && (
                    <>
                      <div style={{ fontWeight: 700, fontSize: '1rem', marginBottom: '0.5rem' }}>{myGroup.name}</div>
                      {renderStatCards(myGroup)}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.25rem' }}>
                        <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                          {myGroup.owner_email || t('settings.superAdmin.noOwner')}
                        </span>
                        <button
                          onClick={() => handleToggleTraining(myGroup.id, !myGroup.training_enabled)}
                          style={{
                            padding: '0.3rem 0.6rem', borderRadius: '8px', border: 'none', cursor: 'pointer',
                            fontSize: '0.7rem', fontWeight: 600, fontFamily: 'Outfit, sans-serif',
                            background: myGroup.training_enabled ? 'rgba(16,185,129,0.15)' : 'rgba(100,100,100,0.15)',
                            color: myGroup.training_enabled ? '#10B981' : 'var(--text-muted)',
                          }}
                        >
                          {myGroup.training_enabled ? t('settings.superAdmin.trainingOn') : t('settings.superAdmin.trainingOff')}
                        </button>
                      </div>

                      {globalStats.orphaned_groups.length > 0 && (
                        <div style={{ marginTop: '0.75rem', padding: '0.65rem', borderRadius: '10px', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)' }}>
                          <div style={{ fontSize: '0.72rem', fontWeight: 600, color: '#f59e0b', marginBottom: '0.25rem' }}>
                            {t('settings.superAdmin.orphanedTitle', { count: globalStats.orphaned_groups.length })}
                          </div>
                          {globalStats.orphaned_groups.map(og => (
                            <div key={og.id} style={{ fontSize: '0.68rem', color: 'var(--text-muted)', marginBottom: '0.15rem' }}>
                              {og.name} — {new Date(og.created_at).toLocaleDateString(language === 'he' ? 'he-IL' : 'en-US')}
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}

                  {/* Others sub-tab */}
                  {globalSubTab === 'others' && (
                    <>
                      {otherGroups.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                          {t('settings.superAdmin.noOtherGroups')}
                        </div>
                      ) : (
                        <>
                          {/* Aggregate totals */}
                          <div style={{
                            display: 'flex', justifyContent: 'space-between', padding: '0.5rem 0.75rem',
                            borderRadius: '10px', background: 'var(--surface)', border: '1px solid var(--border)',
                            marginBottom: '0.65rem',
                          }}>
                            {[
                              { label: language === 'he' ? 'קבוצות' : 'Groups', value: otherGroups.length, color: '#818cf8' },
                              { label: language === 'he' ? 'חברים' : 'Members', value: othersTotalMembers, color: 'var(--text)' },
                              { label: language === 'he' ? 'שחקנים' : 'Players', value: othersTotalPlayers, color: 'var(--text)' },
                              { label: language === 'he' ? 'משחקים' : 'Games', value: othersTotalCompleted, color: '#10B981' },
                            ].map(s => (
                              <div key={s.label} style={{ textAlign: 'center' }}>
                                <div style={{ fontSize: '1rem', fontWeight: 700, color: s.color, lineHeight: 1.1 }}>{s.value}</div>
                                <div style={{ fontSize: '0.48rem', color: 'var(--text-muted)', marginTop: '0.05rem' }}>{s.label}</div>
                              </div>
                            ))}
                          </div>

                          {/* Group list — click to expand */}
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                            {otherGroups.map(g => {
                              const status = getActivityStatus(g.last_game_date);
                              const isExpanded = expandedGroupId === g.id;
                              return (
                                <div key={g.id} data-group-card style={{
                                  borderRadius: '10px', overflow: 'hidden',
                                  border: isExpanded ? '1px solid rgba(99, 102, 241, 0.3)' : '1px solid var(--border)',
                                  background: isExpanded ? 'rgba(99, 102, 241, 0.04)' : 'var(--surface)',
                                  transition: 'all 0.2s ease',
                                }}>
                                  <div
                                    onClick={() => setExpandedGroupId(isExpanded ? null : g.id)}
                                    style={{ padding: '0.65rem 0.75rem', cursor: 'pointer' }}
                                  >
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                        <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>{g.name}</span>
                                        <span style={{
                                          fontSize: '0.55rem', fontWeight: 600, padding: '0.1rem 0.3rem',
                                          borderRadius: '6px', background: status.bg, color: status.color,
                                        }}>
                                          {status.label}
                                        </span>
                                      </div>
                                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', transition: 'transform 0.2s', transform: isExpanded ? 'rotate(180deg)' : 'none' }}>▼</span>
                                    </div>
                                    <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
                                      {g.owner_email || t('settings.superAdmin.noOwner')} · 👥 {g.member_count} · 🃏 {g.completed_game_count}
                                    </div>
                                  </div>

                                  {isExpanded && (
                                    <div style={{ padding: '0 0.75rem 0.75rem' }}>
                                      {renderStatCards(g)}
                                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        <span style={{ fontSize: '0.62rem', color: 'var(--text-muted)', opacity: 0.7 }}>
                                          {t('settings.superAdmin.createdLabel')} {new Date(g.created_at).toLocaleDateString(language === 'he' ? 'he-IL' : 'en-US')}
                                        </span>
                                        <button
                                          onClick={(e) => { e.stopPropagation(); handleToggleTraining(g.id, !g.training_enabled); }}
                                          style={{
                                            padding: '0.3rem 0.6rem', borderRadius: '8px', border: 'none', cursor: 'pointer',
                                            fontSize: '0.7rem', fontWeight: 600, fontFamily: 'Outfit, sans-serif',
                                            background: g.training_enabled ? 'rgba(16,185,129,0.15)' : 'rgba(100,100,100,0.15)',
                                            color: g.training_enabled ? '#10B981' : 'var(--text-muted)',
                                          }}
                                        >
                                          {g.training_enabled ? t('settings.superAdmin.trainingOn') : t('settings.superAdmin.trainingOff')}
                                        </button>
                                      </div>
                                      <div ref={el => { if (el) setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'end' }), 50); }} />
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </>
                      )}
                    </>
                  )}
                </>
              );
            })()}
          </div>
        );
      })()}

      {/* Push Notifications Tab */}
      {activeTab === 'push' && (
        <div>
          <div className="card" style={{ marginBottom: '0.75rem' }}>
            <h3 style={{ margin: '0 0 0.5rem', fontSize: '1rem' }}>
              🔔 {t('push.title')}
            </h3>
            <p style={{ margin: '0 0 0.5rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              {t('push.subscriberCount', { count: String(pushSubscriberCount) })}
            </p>
            {pushSubscribers.length > 0 && (
              <div style={{ margin: '0 0 1rem', display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                {pushSubscribers.map((s, i) => {
                  const isFCM = s.endpoint.includes('fcm.googleapis.com') || s.endpoint.includes('firebase');
                  const isMozilla = s.endpoint.includes('mozilla');
                  const icon = isFCM ? '📱' : isMozilla ? '🦊' : '💻';
                  return (
                    <span key={i} style={{
                      fontSize: '0.7rem', padding: '0.2rem 0.5rem', borderRadius: '0.4rem',
                      background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.3)',
                      color: '#10B981',
                    }}>
                      {icon} {s.playerName || '?'}
                    </span>
                  );
                })}
              </div>
            )}

            {/* Templates */}
            <div style={{ marginBottom: '1rem' }}>
              <label style={{ fontSize: '0.8rem', fontWeight: 600, display: 'block', marginBottom: '0.4rem' }}>
                {t('push.templates')}
              </label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                {[
                  { key: 'tplPokerNight', msg: t('push.tplPokerNight') },
                  { key: 'tplPayReminder', msg: t('push.tplPayReminder') },
                  { key: 'tplGameCancelled', msg: t('push.tplGameCancelled') },
                  { key: 'tplGameStarting', msg: t('push.tplGameStarting') },
                ].map(tpl => (
                  <button
                    key={tpl.key}
                    onClick={() => setPushMsg(tpl.msg)}
                    style={{
                      padding: '0.35rem 0.7rem', borderRadius: '0.5rem',
                      border: '1px solid var(--border)', background: 'var(--surface)',
                      color: 'var(--text)', cursor: 'pointer', fontSize: '0.78rem',
                      fontFamily: 'Outfit, sans-serif',
                    }}
                  >
                    {tpl.msg}
                  </button>
                ))}
              </div>
            </div>

            {/* Message input */}
            <div style={{ marginBottom: '1rem' }}>
              <label style={{ fontSize: '0.8rem', fontWeight: 600, display: 'block', marginBottom: '0.4rem' }}>
                {t('push.messageLabel')}
              </label>
              <textarea
                value={pushMsg}
                onChange={e => { setPushMsg(e.target.value); setPushResult(null); }}
                placeholder={t('push.messagePlaceholder')}
                rows={3}
                style={{
                  width: '100%', padding: '0.6rem', borderRadius: '0.5rem',
                  border: '1px solid var(--border)', background: 'var(--surface)',
                  color: 'var(--text)', fontSize: '0.85rem', fontFamily: 'Outfit, sans-serif',
                  resize: 'vertical', direction: 'rtl', boxSizing: 'border-box',
                }}
              />
            </div>

            {/* Recipients */}
            <div style={{ marginBottom: '1rem' }}>
              <label style={{ fontSize: '0.8rem', fontWeight: 600, display: 'block', marginBottom: '0.4rem' }}>
                {t('push.recipients')}
              </label>
              <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <button
                  onClick={() => { setPushTarget('all'); setPushSelectedPlayers([]); }}
                  style={{
                    padding: '0.35rem 0.8rem', borderRadius: '0.5rem',
                    border: pushTarget === 'all' ? '2px solid #10B981' : '1px solid var(--border)',
                    background: pushTarget === 'all' ? 'rgba(16,185,129,0.15)' : 'var(--surface)',
                    color: 'var(--text)', cursor: 'pointer', fontSize: '0.8rem',
                    fontFamily: 'Outfit, sans-serif', fontWeight: pushTarget === 'all' ? 600 : 400,
                  }}
                >
                  {t('push.allPlayers')}
                </button>
                <button
                  onClick={() => setPushTarget('select')}
                  style={{
                    padding: '0.35rem 0.8rem', borderRadius: '0.5rem',
                    border: pushTarget === 'select' ? '2px solid #10B981' : '1px solid var(--border)',
                    background: pushTarget === 'select' ? 'rgba(16,185,129,0.15)' : 'var(--surface)',
                    color: 'var(--text)', cursor: 'pointer', fontSize: '0.8rem',
                    fontFamily: 'Outfit, sans-serif', fontWeight: pushTarget === 'select' ? 600 : 400,
                  }}
                >
                  {t('push.selectPlayers')}
                </button>
              </div>
              {pushTarget === 'select' && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                  {players.map(p => (
                    <button
                      key={p.id}
                      onClick={() => {
                        setPushSelectedPlayers(prev =>
                          prev.includes(p.name) ? prev.filter(n => n !== p.name) : [...prev, p.name]
                        );
                      }}
                      style={{
                        padding: '0.3rem 0.6rem', borderRadius: '0.4rem',
                        border: pushSelectedPlayers.includes(p.name) ? '2px solid #10B981' : '1px solid var(--border)',
                        background: pushSelectedPlayers.includes(p.name) ? 'rgba(16,185,129,0.15)' : 'var(--surface)',
                        color: 'var(--text)', cursor: 'pointer', fontSize: '0.75rem',
                        fontFamily: 'Outfit, sans-serif',
                      }}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Send button */}
            <button
              disabled={pushSending || !pushMsg.trim() || (pushTarget === 'select' && pushSelectedPlayers.length === 0)}
              onClick={async () => {
                const gid = getGroupId();
                if (!gid || !pushMsg.trim()) return;
                setPushSending(true);
                setPushResult(null);
                setPushDetails(null);
                try {
                  const result = await proxySendPush({
                    groupId: gid,
                    title: '🃏 Poker Manager',
                    body: pushMsg.trim(),
                    targetPlayerNames: pushTarget === 'select' ? pushSelectedPlayers : undefined,
                  });
                  if (result) {
                    setPushResult(`${result.sent > 0 ? '✅' : '❌'} ${t('push.sent', { sent: String(result.sent), total: String(result.total) })}`);
                    if (result.details) setPushDetails(result.details);
                    if (result.sent > 0) setPushMsg('');
                  } else {
                    setPushResult(t('push.error'));
                  }
                } catch (err) {
                  setPushResult(`❌ ${err instanceof Error ? err.message : 'Unknown error'}`);
                } finally {
                  setPushSending(false);
                }
              }}
              style={{
                width: '100%', padding: '0.7rem', borderRadius: '0.5rem',
                border: 'none', fontWeight: 600, fontSize: '0.9rem',
                fontFamily: 'Outfit, sans-serif', cursor: 'pointer',
                background: pushSending || !pushMsg.trim() ? '#374151' : '#10B981',
                color: pushSending || !pushMsg.trim() ? '#6B7280' : 'white',
              }}
            >
              {pushSending ? t('push.sending') : t('push.send')}
            </button>

            {/* Result */}
            {pushResult && (
              <p style={{
                marginTop: '0.5rem', fontSize: '0.8rem', textAlign: 'center',
                color: pushResult.includes('❌') || pushResult === t('push.error') ? '#EF4444' : '#10B981',
              }}>
                {pushResult}
              </p>
            )}

            {/* Per-subscription diagnostic details */}
            {pushDetails && pushDetails.length > 0 && (
              <div style={{
                marginTop: '0.5rem', padding: '0.5rem', borderRadius: '0.5rem',
                background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)',
                fontSize: '0.72rem', direction: 'ltr',
              }}>
                {pushDetails.map((d, i) => (
                  <div key={i} style={{
                    padding: '0.4rem 0',
                    borderBottom: i < pushDetails.length - 1 ? '1px solid rgba(255,255,255,0.05)' : undefined,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: 600 }}>{d.player} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({d.type})</span></span>
                      <span style={{
                        padding: '0.1rem 0.4rem', borderRadius: '0.3rem',
                        background: d.ok ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
                        color: d.ok ? '#10B981' : '#EF4444',
                        fontWeight: 600,
                      }}>
                        {d.ok ? '✓' : '✗'} {d.status}
                      </span>
                    </div>
                    {d.log && d.log.length > 0 && (
                      <pre style={{
                        margin: '0.2rem 0 0', padding: '0.3rem', borderRadius: '0.3rem',
                        background: 'rgba(0,0,0,0.3)', color: 'var(--text-muted)',
                        fontSize: '0.62rem', lineHeight: 1.4, whiteSpace: 'pre-wrap',
                        wordBreak: 'break-all', fontFamily: 'monospace',
                      }}>
                        {d.log.join('\n')}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Diagnostic info */}
            {isSuperAdmin && (
              <div style={{
                marginTop: '0.75rem', padding: '0.5rem', borderRadius: '0.5rem',
                background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)',
                fontSize: '0.68rem', direction: 'ltr', color: 'var(--text-muted)',
              }}>
                <div style={{ fontWeight: 600, marginBottom: '0.3rem' }}>📋 Subscription Debug</div>
                {pushSubscribers.map((s, i) => {
                  const isFCM = s.endpoint.includes('fcm.googleapis.com');
                  const isMoz = s.endpoint.includes('mozilla');
                  return (
                    <div key={i} style={{ padding: '0.15rem 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      <span style={{ color: isFCM ? '#10B981' : isMoz ? '#F59E0B' : '#3B82F6' }}>
                        {isFCM ? 'FCM' : isMoz ? 'Mozilla' : 'Other'}
                      </span>
                      {' '}{s.playerName || '?'} — {s.endpoint.slice(0, 80)}...
                    </div>
                  );
                })}
                {pushSubscribers.length === 0 && <div>No subscriptions in DB</div>}
              </div>
            )}

            {/* Test section */}
            <div style={{ marginTop: '1.5rem', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
              <h4 style={{ margin: '0 0 0.5rem', fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                🧪 {language === 'he' ? 'בדיקה' : 'Test'}
              </h4>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                <button
                  onClick={async () => {
                    const gid = getGroupId();
                    if (!gid || !authPlayerName) return;
                    setPushSending(true);
                    setPushResult(null);
                    setPushDetails(null);
                    try {
                      const result = await proxySendPush({
                        groupId: gid,
                        title: '🧪 Test — ' + authPlayerName,
                        body: language === 'he' ? 'בדיקת התראה למכשיר זה' : 'Test notification for this device',
                        targetPlayerNames: [authPlayerName],
                      });
                      if (result) {
                        if (result.details) setPushDetails(result.details);
                        if (result.total === 0) {
                          setPushResult(`⚠️ ${language === 'he' ? 'אין מנוי עבורך — סגור ופתח מחדש את האפליקציה' : 'No subscription for you — close and reopen the app'}`);
                        } else if (result.sent > 0) {
                          setPushResult(`✅ ${language === 'he' ? 'נשלח' : 'Sent'}: ${result.sent}/${result.total} — ${language === 'he' ? 'אם לא קיבלת, מזער את האפליקציה ונסה שוב' : 'If not received, minimize the app and try again'}`);
                        } else {
                          setPushResult(`❌ ${language === 'he' ? 'שגיאה בשליחה' : 'Send failed'}: 0/${result.total}`);
                        }
                      } else {
                        setPushResult(`❌ ${language === 'he' ? 'שגיאה - בדוק הגדרות' : 'Error - check settings'}`);
                      }
                    } catch (err) {
                      setPushResult(`❌ ${err instanceof Error ? err.message : 'Unknown error'}`);
                    } finally {
                      setPushSending(false);
                    }
                  }}
                  disabled={pushSending}
                  style={{
                    flex: 1, padding: '0.5rem', borderRadius: '0.5rem',
                    border: '1px solid rgba(59,130,246,0.3)', background: 'rgba(59,130,246,0.1)',
                    color: '#3B82F6', cursor: 'pointer', fontSize: '0.8rem',
                    fontFamily: 'Outfit, sans-serif', fontWeight: 500, minWidth: '140px',
                  }}
                >
                  🔔 {language === 'he' ? 'בדיקה למכשיר שלי' : 'Test My Device'}
                </button>
                <button
                  onClick={async () => {
                    setPushSending(true);
                    setPushResult(null);
                    try {
                      const { supabase: sb } = await import('../database/supabaseClient');
                      const { data: { user } } = await sb.auth.getUser();
                      const email = user?.email;
                      if (!email) {
                        setPushResult(`❌ ${language === 'he' ? 'לא נמצא מייל בחשבון' : 'No email found in account'}`);
                        return;
                      }
                      const ok = await proxySendEmail({
                        to: email,
                        subject: '🧪 Poker Manager - Test Email',
                        playerName: 'Test Player',
                        reporterName: 'Admin',
                        amount: 100,
                        gameDate: new Date().toLocaleDateString('he-IL'),
                        payLink: '',
                      });
                      if (ok) {
                        setPushResult(`✅ ${language === 'he' ? 'מייל נשלח לחשבון שלך' : 'Email sent to your account'}`);
                      } else {
                        setPushResult(`❌ ${language === 'he' ? 'שליחת מייל נכשלה - בדוק הגדרות EmailJS' : 'Email send failed - check EmailJS settings'}`);
                      }
                    } catch (err) {
                      setPushResult(`❌ ${err instanceof Error ? err.message : 'Unknown error'}`);
                    } finally {
                      setPushSending(false);
                    }
                  }}
                  disabled={pushSending}
                  style={{
                    flex: 1, padding: '0.5rem', borderRadius: '0.5rem',
                    border: '1px solid rgba(168,85,247,0.3)', background: 'rgba(168,85,247,0.1)',
                    color: '#A855F7', cursor: 'pointer', fontSize: '0.8rem',
                    fontFamily: 'Outfit, sans-serif', fontWeight: 500,
                  }}
                >
                  📧 {language === 'he' ? 'בדיקת מייל' : 'Test Email'}
                </button>
              </div>
              <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.4rem', textAlign: 'center' }}>
                {language === 'he'
                  ? `Push נשלח ל${pushTarget === 'select' ? 'שחקנים שנבחרו' : 'כל המנויים'}, מייל נשלח לחשבון שלך`
                  : `Push sent to ${pushTarget === 'select' ? 'selected players' : 'all subscribers'}, email sent to your account`}
              </p>
            </div>

          </div>
        </div>
      )}

      {/* Activity Tab - Owner Only - Enhanced Dashboard */}
      {activeTab === 'activity' && isOwner && (
        <div>
          {/* Header */}
          <div style={{ marginBottom: '0.6rem' }}>
            <h2 style={{ margin: 0, fontSize: '1.1rem', color: 'var(--text)' }}>{t('settings.activity.title')}</h2>
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

            const memberNames = activityMembers.map(m => m.playerName || m.displayName || '').filter(n => n && n !== authPlayerName);

            const todayUniqueNames = [...new Set(
              activityLog.filter(e => new Date(e.timestamp).toDateString() === now.toDateString())
                .map(e => e.playerName || deviceLabels[e.deviceId] || e.deviceId.slice(0, 8))
            )];
            const todayUniqueUsers = todayUniqueNames.length;

            const weekAgo = new Date(now.getTime() - sevenDaysMs);
            

            const weekSessions = activityLog.filter(e => new Date(e.timestamp) > weekAgo).length;

            const mostActiveThisWeek = (() => {
              const counts = new Map<string, number>();
              for (const e of activityLog) {
                if (new Date(e.timestamp) <= weekAgo) continue;
                const n = e.playerName || deviceLabels[e.deviceId] || e.deviceId.slice(0, 8);
                counts.set(n, (counts.get(n) || 0) + 1);
              }
              let best = '';
              let max = 0;
              for (const [n, c] of counts) { if (c > max) { max = c; best = n; } }
              return best;
            })();

            const lastVisitor = (() => {
              if (activityLog.length === 0) return null;
              const latest = activityLog.reduce((a, b) =>
                new Date(b.lastActive || b.timestamp) > new Date(a.lastActive || a.timestamp) ? b : a
              );
              const name = latest.playerName || deviceLabels[latest.deviceId] || latest.deviceId.slice(0, 8);
              const ago = Math.floor((now.getTime() - new Date(latest.lastActive || latest.timestamp).getTime()) / 60000);
              const agoLabel = ago < 60 ? `${ago}${language === 'he' ? ' דק׳' : 'm'}` : `${Math.floor(ago / 60)}${language === 'he' ? ' שע׳' : 'h'}`;
              return { name, agoLabel };
            })();


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

            const activeMemberCount = memberNames.filter(name => {
              const entries = userMap.get(name);
              return entries && entries.length > 0;
            }).length || 1;

            

            const weeklyTrend = Array.from({ length: 8 }, (_, i) => {
              const weekEnd = new Date(now.getTime() - i * 7 * oneDayMs);
              const weekStart = new Date(weekEnd.getTime() - 7 * oneDayMs);
              const entries = activityLog.filter(e => {
                const ts = new Date(e.timestamp).getTime();
                return ts >= weekStart.getTime() && ts < weekEnd.getTime();
              });
              const users = new Set(entries.map(e =>
                e.playerName || deviceLabels[e.deviceId] || e.deviceId
              ));
              return { start: weekStart, users: users.size, sessions: entries.length };
            }).reverse();

            const trendMaxUsers = Math.max(1, ...weeklyTrend.map(w => w.users));
            const thisWeekUsers = weeklyTrend[weeklyTrend.length - 1]?.users ?? 0;
            const lastWeekUsers = weeklyTrend[weeklyTrend.length - 2]?.users ?? 0;
            const usersDelta = thisWeekUsers - lastWeekUsers;

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

                {/* Summary Stats */}
                <div style={{
                  display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.35rem', marginBottom: '0.5rem',
                }}>
                  {/* Active Today — with names */}
                  <div style={{ padding: '0.5rem', borderRadius: '8px', background: 'var(--surface)', border: '1px solid var(--border)' }}>
                    <div style={{ fontSize: '0.58rem', color: 'var(--text-muted)', marginBottom: '0.15rem' }}>👤 {t('settings.activity.activeToday')}</div>
                    <div style={{ fontSize: '1rem', fontWeight: 700, color: todayUniqueUsers > 0 ? '#10B981' : 'var(--text-muted)' }}>
                      {todayUniqueUsers > 0 ? String(todayUniqueUsers) : '—'}
                    </div>
                    {todayUniqueNames.length > 0 && (
                      <div style={{ fontSize: '0.55rem', color: 'var(--text-muted)', marginTop: '0.15rem', lineHeight: 1.4 }}>
                        {todayUniqueNames.join(', ')}
                      </div>
                    )}
                  </div>
                  {[
                    { label: t('settings.activity.weekSessions'), value: weekSessions > 0 ? String(weekSessions) : '—', icon: '📊', color: weekSessions > 0 ? '#6366f1' : 'var(--text-muted)' },
                    { label: t('settings.activity.mostActive'), value: mostActiveThisWeek || '—', icon: '🏆', color: mostActiveThisWeek ? '#f59e0b' : 'var(--text-muted)', small: true },
                    { label: t('settings.activity.lastVisitor'), value: lastVisitor ? `${lastVisitor.name}` : '—', sub: lastVisitor?.agoLabel, icon: '🕐', color: lastVisitor ? 'var(--text)' : 'var(--text-muted)', small: true },
                  ].map(stat => (
                    <div key={stat.label} style={{
                      padding: '0.5rem', borderRadius: '8px', background: 'var(--surface)',
                      border: '1px solid var(--border)',
                    }}>
                      <div style={{ fontSize: '0.58rem', color: 'var(--text-muted)', marginBottom: '0.15rem' }}>{stat.icon} {stat.label}</div>
                      <div style={{ fontSize: (stat as { small?: boolean }).small ? '0.82rem' : '1rem', fontWeight: 700, color: stat.color }}>
                        {stat.value}
                        {(stat as { sub?: string }).sub && (
                          <span style={{ fontSize: '0.6rem', fontWeight: 400, color: 'var(--text-muted)', marginInlineStart: '0.3rem' }}>
                            {(stat as { sub?: string }).sub}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Weekly Trend */}
                <div style={{
                  padding: '0.5rem 0.65rem', borderRadius: '10px', marginBottom: '0.5rem',
                  background: 'var(--surface)', border: '1px solid var(--border)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                    <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                      {t('settings.activity.weeklyTrend')}
                    </span>
                    {usersDelta !== 0 && (
                      <span style={{
                        fontSize: '0.62rem', fontWeight: 600, padding: '0.1rem 0.4rem',
                        borderRadius: '8px',
                        background: usersDelta > 0 ? 'rgba(16, 185, 129, 0.12)' : 'rgba(239, 68, 68, 0.12)',
                        color: usersDelta > 0 ? '#10B981' : '#ef4444',
                      }}>
                        {usersDelta > 0 ? '▲' : '▼'} {Math.abs(usersDelta)} {t('settings.activity.vsLastWeek')}
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: '3px', height: '48px' }}>
                    {weeklyTrend.map((week, i) => {
                      const barH = Math.max(4, (week.users / trendMaxUsers) * 44);
                      const isCurrent = i === weeklyTrend.length - 1;
                      const weekLabel = week.start.toLocaleDateString(language === 'he' ? 'he-IL' : 'en-US', { day: 'numeric', month: 'numeric' });
                      return (
                        <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
                          <div
                            title={`${weekLabel}: ${week.users} ${t('settings.activity.users')}, ${week.sessions} ${t('settings.activity.sessionsLabel')}`}
                            style={{
                              width: '100%', height: `${barH}px`, borderRadius: '3px',
                              background: isCurrent
                                ? 'linear-gradient(180deg, #6366f1, #818cf8)'
                                : `rgba(99, 102, 241, ${0.2 + (week.users / trendMaxUsers) * 0.4})`,
                              transition: 'height 0.3s ease',
                            }}
                          />
                          <span style={{ fontSize: '0.45rem', color: 'var(--text-muted)', lineHeight: 1 }}>
                            {week.start.toLocaleDateString(language === 'he' ? 'he-IL' : 'en-US', { day: 'numeric', month: 'numeric' })}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.35rem', fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                    <span>{t('settings.activity.trendUsers')}: {thisWeekUsers}</span>
                    <span>{t('settings.activity.trendSessions')}: {weeklyTrend[weeklyTrend.length - 1]?.sessions ?? 0}</span>
                  </div>
                </div>

                {/* Top Screens: visits + time */}
                {(() => {
                  const screenVisits: Record<string, number> = {};
                  const screenTime: Record<string, number> = {};
                  for (const entry of activityLog) {
                    const screens = entry.screensVisited || [];
                    const perScreenMin = screens.length > 0 ? (entry.sessionDuration || 0) / screens.length : 0;
                    for (const s of screens) {
                      screenVisits[s] = (screenVisits[s] || 0) + 1;
                      screenTime[s] = (screenTime[s] || 0) + perScreenMin;
                    }
                  }
                  const allScreens = Object.keys(screenVisits);
                  const byVisits = [...allScreens].sort((a, b) => screenVisits[b] - screenVisits[a]);
                  const byTime = [...allScreens].sort((a, b) => screenTime[b] - screenTime[a]);
                  const maxVisits = screenVisits[byVisits[0]] || 1;
                  const maxTime = screenTime[byTime[0]] || 1;
                  const totalTime = Object.values(screenTime).reduce((a, b) => a + b, 0);
                  const totalVisits = Object.values(screenVisits).reduce((a, b) => a + b, 0);

                  return (
                    <div style={{
                      padding: '0.5rem 0.65rem', borderRadius: '10px', marginBottom: '0.5rem',
                      background: 'var(--surface)', border: '1px solid var(--border)',
                    }}>
                      <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
                        📱 {language === 'he' ? 'מסכים פופולריים' : 'Popular Screens'}
                      </div>
                      {allScreens.length === 0 ? (
                        <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', textAlign: 'center', padding: '0.3rem', opacity: 0.6 }}>
                          {language === 'he' ? 'נתונים יתעדכנו בכניסות הבאות' : 'Data will populate from new sessions'}
                        </div>
                      ) : <div style={{ display: 'flex', gap: '0.5rem' }}>
                        {/* By visits */}
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: '0.58rem', color: 'var(--text-muted)', marginBottom: '0.25rem', fontWeight: 600 }}>
                            {language === 'he' ? 'לפי כניסות' : 'By visits'} ({totalVisits})
                          </div>
                          {byVisits.slice(0, 5).map((screen, i) => {
                            const pct = Math.round((screenVisits[screen] / maxVisits) * 100);
                            return (
                              <div key={screen} style={{ marginBottom: '0.2rem' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.58rem', color: 'var(--text)' }}>
                                  <span>{i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  '} {screen}</span>
                                  <span style={{ color: '#818cf8', fontWeight: 600 }}>{screenVisits[screen]}</span>
                                </div>
                                <div style={{ height: '3px', borderRadius: '2px', background: 'var(--background)', overflow: 'hidden', marginTop: '1px' }}>
                                  <div style={{ width: `${pct}%`, height: '100%', borderRadius: '2px', background: '#818cf8' }} />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        {/* By time */}
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: '0.58rem', color: 'var(--text-muted)', marginBottom: '0.25rem', fontWeight: 600 }}>
                            {language === 'he' ? 'לפי זמן' : 'By time'} ({Math.round(totalTime)} {language === 'he' ? 'דק׳' : 'min'})
                          </div>
                          {byTime.slice(0, 5).map((screen, i) => {
                            const pct = Math.round((screenTime[screen] / maxTime) * 100);
                            const mins = Math.round(screenTime[screen]);
                            return (
                              <div key={screen} style={{ marginBottom: '0.2rem' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.58rem', color: 'var(--text)' }}>
                                  <span>{i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '  '} {screen}</span>
                                  <span style={{ color: '#10B981', fontWeight: 600 }}>{mins}{language === 'he' ? 'ד׳' : 'm'}</span>
                                </div>
                                <div style={{ height: '3px', borderRadius: '2px', background: 'var(--background)', overflow: 'hidden', marginTop: '1px' }}>
                                  <div style={{ width: `${pct}%`, height: '100%', borderRadius: '2px', background: '#10B981' }} />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>}
                    </div>
                  );
                })()}

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
                      const label = d.toLocaleDateString(language === 'he' ? 'he-IL' : 'en-US', { day: 'numeric', month: 'short' });
                      const total = activeMemberCount;
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

                {/* Feature Adoption */}
                {(() => {
                  const featureUsers = new Map<string, Set<string>>();
                  for (const entry of activityLog) {
                    const name = entry.playerName || deviceLabels[entry.deviceId] || entry.deviceId.slice(0, 8);
                    for (const s of (entry.screensVisited || [])) {
                      if (!featureUsers.has(s)) featureUsers.set(s, new Set());
                      featureUsers.get(s)!.add(name);
                    }
                  }
                  const totalMembers = players.length || userMap.size || 1;
                  const features = [...featureUsers.entries()]
                    .map(([name, users]) => ({ name, count: users.size }))
                    .sort((a, b) => b.count - a.count);
                  if (features.length === 0) return null;
                  return (
                    <div style={{
                      padding: '0.5rem 0.65rem', borderRadius: '10px', marginBottom: '0.5rem',
                      background: 'var(--surface)', border: '1px solid var(--border)',
                    }}>
                      <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.35rem' }}>
                        🧩 {language === 'he' ? 'אימוץ פיצ׳רים' : 'Feature Adoption'}
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                        {features.map(f => {
                          const pct = Math.round((f.count / totalMembers) * 100);
                          const color = pct >= 75 ? '#10B981' : pct >= 40 ? '#f59e0b' : '#ef4444';
                          return (
                            <div key={f.name} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                              <span style={{ fontSize: '0.62rem', color: 'var(--text)', minWidth: '70px' }}>{f.name}</span>
                              <div style={{ flex: 1, height: '5px', borderRadius: '3px', background: 'var(--background)', overflow: 'hidden' }}>
                                <div style={{ width: `${pct}%`, height: '100%', borderRadius: '3px', background: color }} />
                              </div>
                              <span style={{ fontSize: '0.6rem', color, fontWeight: 600, minWidth: '48px', textAlign: isRTL ? 'left' : 'right' }}>
                                {f.count}/{totalMembers}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}

                {/* Training Engagement */}
                {trainingPlayers.length > 0 && (() => {
                  const now = new Date();
                  const weekAgoMs = now.getTime() - 7 * 86400000;
                  const trainers = trainingPlayers.map(p => {
                    type TSession = TrainingPlayerData['sessions'][0];
                    const weekSessions = p.sessions.filter((s: TSession) => new Date(s.date).getTime() > weekAgoMs);
                    const weekQs = weekSessions.reduce((sum: number, s: TSession) => sum + s.questionsAnswered, 0);
                    const lastSession = p.sessions.length > 0
                      ? p.sessions.reduce((latest: TSession, s: TSession) => new Date(s.date) > new Date(latest.date) ? s : latest)
                      : null;
                    return { name: p.playerName, totalSessions: p.sessions.length, weekQs, accuracy: p.accuracy, lastSession };
                  }).sort((a, b) => b.weekQs - a.weekQs);

                  const activeThisWeek = trainers.filter(t => t.weekQs > 0);

                  return (
                    <div style={{
                      padding: '0.5rem 0.65rem', borderRadius: '10px', marginBottom: '0.5rem',
                      background: 'var(--surface)', border: '1px solid var(--border)',
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem' }}>
                        <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                          🎯 {language === 'he' ? 'אימון השבוע' : 'Training This Week'}
                        </span>
                        <span style={{ fontSize: '0.58rem', color: '#818cf8', fontWeight: 600 }}>
                          {activeThisWeek.length}/{trainers.length} {language === 'he' ? 'פעילים' : 'active'}
                        </span>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: '0.15rem 0.5rem', alignItems: 'center' }}>
                        {trainers.map(tr => {
                          const daysSince = tr.lastSession
                            ? Math.floor((now.getTime() - new Date(tr.lastSession.date).getTime()) / 86400000)
                            : null;
                          const isActive = tr.weekQs > 0;
                          return (
                            <Fragment key={tr.name}>
                              <span style={{ fontSize: '0.64rem', fontWeight: isActive ? 600 : 400, color: isActive ? 'var(--text)' : 'var(--text-muted)' }}>
                                {tr.name}
                              </span>
                              <span style={{ fontSize: '0.56rem', color: 'var(--text-muted)' }}>
                                {isActive
                                  ? `${Math.round(tr.accuracy)}% · ${tr.totalSessions} ${language === 'he' ? 'סשנים' : 'sess'}`
                                  : ''
                                }
                              </span>
                              <span style={{
                                fontSize: '0.6rem', fontWeight: 600, textAlign: 'end',
                                color: isActive ? '#818cf8' : 'var(--text-muted)',
                              }}>
                                {isActive
                                  ? `${tr.weekQs} ${language === 'he' ? 'שאלות' : 'Q'}`
                                  : daysSince !== null
                                    ? `${daysSince} ${language === 'he' ? 'ימים' : 'd ago'}`
                                    : '—'
                                }
                              </span>
                            </Fragment>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}

                {/* Member Cards */}
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

                        {/* Row 3: total time + screens visited */}
                        <div style={{
                          display: 'flex', gap: '0.6rem', fontSize: '0.62rem', color: 'var(--text-muted)', marginTop: '0.25rem', flexWrap: 'wrap',
                        }}>
                          {(() => {
                            const totalMin = user.entries.reduce((s, e) => s + (e.sessionDuration || 0), 0);
                            const allScreens = new Set<string>();
                            for (const e of user.entries) {
                              for (const s of e.screensVisited) allScreens.add(s);
                            }
                            return (
                              <>
                                <span>⏱️ {totalMin < 1 ? '<1' : Math.round(totalMin)} {language === 'he' ? 'דק׳ סה"כ' : 'min total'}</span>
                                {allScreens.size > 0 && (
                                  <span style={{ wordBreak: 'break-word' }}>📱 {[...allScreens].join(', ')}</span>
                                )}
                              </>
                            );
                          })()}
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
                            // Screen visit counts across all sessions
                            const screenCounts: Record<string, number> = {};
                            const totalMin = user.entries.reduce((s, e) => s + (e.sessionDuration || 0), 0);
                            for (const e of user.entries) {
                              for (const s of e.screensVisited) {
                                screenCounts[s] = (screenCounts[s] || 0) + 1;
                              }
                            }
                            const screensSorted = Object.entries(screenCounts).sort((a, b) => b[1] - a[1]);

                            return (
                              <>
                                {/* Summary: total time + total visits */}
                                <div style={{
                                  display: 'flex', justifyContent: 'space-between', fontSize: '0.68rem',
                                  color: 'var(--text)', fontWeight: 600, marginBottom: '0.4rem',
                                  padding: '0.25rem 0.3rem', borderRadius: '6px', background: 'var(--background)',
                                }}>
                                  <span>⏱️ {totalMin < 1 ? '<1' : Math.round(totalMin)} {language === 'he' ? 'דק׳ סה"כ' : 'min total'}</span>
                                  <span>{user.entries.length} {language === 'he' ? 'כניסות' : 'visits'}</span>
                                </div>

                                {/* Screens visited with frequency */}
                                {screensSorted.length > 0 ? (
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem', marginBottom: '0.15rem' }}>
                                    {screensSorted.map(([screen, count]) => (
                                      <span key={screen} style={{
                                        fontSize: '0.62rem', padding: '0.15rem 0.4rem', borderRadius: '10px',
                                        background: 'var(--background)', color: 'var(--text-muted)',
                                        border: '1px solid var(--border)',
                                      }}>
                                        {screen} <span style={{ color: '#818cf8', fontWeight: 600 }}>×{count}</span>
                                      </span>
                                    ))}
                                  </div>
                                ) : (
                                  <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', textAlign: 'center', opacity: 0.6 }}>
                                    {language === 'he' ? 'אין נתוני מסכים (כניסות קצרות)' : 'No screen data (brief visits)'}
                                  </div>
                                )}
                              </>
                            );
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

      </div>{/* end tab crossfade wrapper */}

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

      {/* Group Setup Overlay (create/join) */}
      {groupSetupMode && multiGroup && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 10000,
          background: 'var(--background)',
        }}>
          <GroupSetupScreen
            userEmail={multiGroup.userEmail}
            onCreateGroup={async (name) => {
              const result = await multiGroup.createGroup(name);
              if (!result.error) setGroupJustCreated(true);
              return result;
            }}
            onJoinGroup={async (code) => {
              const result = await multiGroup.joinGroup(code);
              if (!result.error) setGroupSetupMode(null);
              return result;
            }}
            onJoinByPlayerInvite={async (code) => {
              const result = await multiGroup.joinByPlayerInvite(code);
              if (!result.error) setGroupSetupMode(null);
              return result;
            }}
            onSignOut={() => setGroupSetupMode(null)}
            onContinue={() => {
              multiGroup.refreshMembership();
              if (groupJustCreated) {
                multiGroup.triggerGroupWizard();
                setGroupJustCreated(false);
              }
              setGroupSetupMode(null);
            }}
            onClose={() => setGroupSetupMode(null)}
            initialMode={groupSetupMode}
          />
        </div>
      )}
      {/* Welcome Summary Modal */}
      {showWelcome && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.6)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '1rem',
        }} onClick={() => setShowWelcome(false)}>
          <div style={{
            background: 'var(--surface)', borderRadius: '16px', padding: '1.5rem',
            maxWidth: '400px', width: '100%', maxHeight: '85vh', overflowY: 'auto',
            border: '1px solid var(--border)',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ textAlign: 'center', marginBottom: '1rem' }}>
              <div style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--text)' }}>{t('settings.setup.welcomeTitle')}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.3rem' }}>{t('settings.setup.welcomeSubtitle')}</div>
            </div>
            {[
              { icon: '🎮', text: t('settings.setup.welcomeNewGame') },
              { icon: '📡', text: t('settings.setup.welcomeLive') },
              { icon: '🧮', text: t('settings.setup.welcomeEnd') },
              { icon: '💰', text: t('settings.setup.welcomeSettlements') },
              { icon: '📜', text: t('settings.setup.welcomeHistory') },
              { icon: '📊', text: t('settings.setup.welcomeStats') },
              { icon: '📈', text: t('settings.setup.welcomeGraphs') },
              { icon: '🏋️', text: t('settings.setup.welcomeTraining') },
              { icon: '📤', text: t('settings.setup.welcomeShare') },
              { icon: '🔔', text: t('settings.setup.welcomeNotify') },
            ].map((item, i, arr) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'flex-start', gap: '0.6rem',
                padding: '0.5rem 0', borderBottom: i < arr.length - 1 ? '1px solid var(--border)' : 'none',
              }}>
                <span style={{ fontSize: '1.1rem', flexShrink: 0 }}>{item.icon}</span>
                <span style={{ fontSize: '0.78rem', color: 'var(--text)', lineHeight: 1.5 }}>{item.text}</span>
              </div>
            ))}
            <button
              onClick={() => setShowWelcome(false)}
              style={{
                width: '100%', marginTop: '1rem', padding: '0.7rem', borderRadius: '10px',
                border: 'none', background: '#10B981', color: '#fff', cursor: 'pointer',
                fontSize: '0.9rem', fontWeight: 700, fontFamily: 'Outfit, sans-serif',
              }}
            >{t('settings.setup.welcomeClose')}</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default SettingsScreen;

