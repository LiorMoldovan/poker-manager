import { useState, useEffect, useCallback, useMemo, Fragment } from 'react';
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh';
import { forceRefreshPlayersFromDb } from '../database/supabaseCache';
import { useNavigate, useLocation } from 'react-router-dom';
import { Player, PlayerType, PlayerGender, ChipValue, Settings, BlockedTransferPair, PlayerTraits, PhotoChipCountResult } from '../types';
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
import { isGeminiEnabledForCurrentGroup } from '../utils/aiEligibility';
// v5.62.2 — chip-count feedback loop fully retired. The
// `chip_count_feedback` table + `chip-count-feedback-photos` bucket
// stay in Supabase as harmless legacy; the dashboard card, the
// "submit feedback" UI on the test card, and the silent live-game
// submission were all removed in one pass because the v5.62.0
// architecture rewrite made the data they fed unconsumable.
// The Recharts imports went with the dashboard — no other usage
// in this file.
import { getElevenLabsApiKey, getElevenLabsUsageLive, getElevenLabsGameHistory, deleteElevenLabsGameEntry } from '../utils/tts';
import { proxyGeminiGenerate, proxyElevenLabsTTS, proxySendPush, proxySendBroadcastEmail, proxyEmailUsage, proxyGetEmailQuotaConfig, proxySetEmailQuotaConfig, type EmailUsageResponse } from '../utils/apiProxy';
import { isEmailEnabledForCurrentGroup } from '../utils/emailEligibility';
import { verbForName } from '../utils/hebrewGender';
import {
  previewScheduleEmail,
  previewAllScheduleEmails,
  SCHEDULE_EMAIL_VARIANTS,
  type ScheduleEmailVariantId,
} from '../utils/previewScheduleEmails';
import { getAIStatus, getTodayActions, getTodayTokens, getTodayLog, resetUsage, type AIStatusData } from '../utils/aiUsageTracker';
import { fetchActivityLog, getDeviceId, getCurrentSessionTimestamp } from '../utils/activityLogger';
import { fetchTrainingAnswers, fetchTrainingPool } from '../database/trainingData';
import { ActivityLogEntry, TrainingPlayerData } from '../types';
import { APP_VERSION, CHANGELOG } from '../version';
import { isEdgeBrowser } from '../utils/tts';
import PhotoCaptureModal from '../components/PhotoCaptureModal';
import ChipDetectionOverlay from '../components/ChipDetectionOverlay';
import { captureChipSelfie } from '../utils/imageUtils';
import { usePermissions } from '../App';
import { getRoleDisplayName, getRoleEmoji } from '../permissions';
import { supabase } from '../database/supabaseClient';
import { getGroupId } from '../database/supabaseCache';
import TrainingAdminTab from '../components/TrainingAdminTab';
import TriviaReportsTab from '../components/TriviaReportsTab';
import GroupManagementTab from '../components/GroupManagementTab';
import { NumericInput } from '../components/NumericInput';
import GroupSetupScreen from './GroupSetupScreen';
import type { GroupMember } from '../hooks/useSupabaseAuth';
import { useTranslation, translateChipColor } from '../i18n';
import { shareToWhatsApp } from '../utils/sharing';

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
  // v5.59 chip-selfie capture: which chip row is currently waiting on a
  // file pick + processing, so the row can show a spinner. Cleared on
  // success or error. Capture flow uses a single hidden file input,
  // re-targeted per chip via this state.
  const [chipSelfieBusyId, setChipSelfieBusyId] = useState<string | null>(null);
  const [chipSelfieError, setChipSelfieError] = useState<string>('');
  // Collapsed/expanded state for the player groups (by type) on the Players tab.
  // Defaults to all collapsed so the long roster doesn't dominate the view.
  const [playerGroupsCollapsed, setPlayerGroupsCollapsed] = useState<Record<PlayerType, boolean>>({
    permanent: true,
    permanent_guest: true,
    guest: true,
  });
  
  // Gemini AI state
  const [geminiKey, setGeminiKey] = useState<string>('');
  // ElevenLabs TTS state (used by AI tab model tests)
  const [elKey, setElKey] = useState<string>('');
  const [elUsageLive, setElUsageLive] = useState<{ used: number; limit: number; remaining: number; resetDate: string } | null>(null);
  // EmailJS usage (super-admin only). Loaded lazily when the AI tab is open
  // and refreshed on `email-sent` events + tab visibility changes — no
  // setInterval polling, per the project's no-cache rule.
  const [emailUsage, setEmailUsage] = useState<EmailUsageResponse | null>(null);
  const [showEmailRecent, setShowEmailRecent] = useState(false);
  // EmailJS quota config editor (super-admin). Lets the operator seed
  // the baseline + cap + reset day from the UI instead of dealing with
  // env vars. Persisted to `system_config` via SECURITY DEFINER RPCs.
  const [showQuotaEditor, setShowQuotaEditor] = useState(false);
  const [quotaEditor, setQuotaEditor] = useState<{
    resetDay: string;
    monthlyCap: string;
    baselineUsed: string;
    baselineCycleStart: string;
  }>({ resetDay: '', monthlyCap: '', baselineUsed: '', baselineCycleStart: '' });
  const [quotaEditorSaving, setQuotaEditorSaving] = useState(false);

  // AI Status state
  const [, setAiStatus] = useState<AIStatusData | null>(null);
  const [aiTestResults, setAiTestResults] = useState<ModelTestResult[] | null>(null);
  const [isTestingModels, setIsTestingModels] = useState(false);
  const [showAiLog, setShowAiLog] = useState(false);
  const [aiTick, setAiTick] = useState(0);

  // Photo chip-counting test (Services tab — owner only).
  // No game context, no settlement impact. Pure accuracy verification.
  // v5.62.2: the test card used to double as a feedback-submission
  // tool (save ground-truth counts to `chip_count_feedback`). That
  // submission was retired alongside the dashboard since nothing
  // reads the rows any more — see top-of-file note. The remaining
  // state is just camera + result display.
  const [photoTestOpen, setPhotoTestOpen] = useState(false);
  const [photoTestResult, setPhotoTestResult] = useState<PhotoChipCountResult | null>(null);
  const [photoTestPreview, setPhotoTestPreview] = useState<string>('');
  const [photoTestPreviewMime, setPhotoTestPreviewMime] = useState<string>('image/jpeg');

  // v5.62.2 — chip-count accuracy dashboard state and the tuning UI
  // were removed alongside the feedback loop. See top-of-file note.

  // Group setup overlay (create/join)
  const [groupSetupMode, setGroupSetupMode] = useState<'create' | 'join' | null>(null);

  // Activity log state
  const [activityLog, setActivityLog] = useState<ActivityLogEntry[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  const [activityMembers, setActivityMembers] = useState<GroupMember[]>([]);
  const [trainingPlayers, setTrainingPlayers] = useState<TrainingPlayerData[]>([]);
  const [trainingActionCount, setTrainingActionCount] = useState(0);
  const [triviaPendingCount, setTriviaPendingCount] = useState(0);
  const [deviceLabels] = useState<Record<string, string>>(() => {
    try { return JSON.parse(localStorage.getItem('poker_device_labels') || '{}'); } catch { return {}; }
  });

  // Issue reports state
  interface IssueReport {
    id: string;
    group_id: string;
    reporter_name: string;
    reporter_user_id: string | null;
    category: string;
    description: string;
    device: string | null;
    status: string;
    created_at: string;
    group_name?: string;
  }
  const [reportCategory, setReportCategory] = useState('');
  const [reportText, setReportText] = useState('');
  const [reportSending, setReportSending] = useState(false);
  const [reportResult, setReportResult] = useState<'success' | 'error' | null>(null);
  const [reports, setReports] = useState<IssueReport[]>([]);
  const [reportsLoaded, setReportsLoaded] = useState(false);

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
    // Activity-log session count over the last 30 days. Populated by
    // get_global_stats but the field had been missing from the TS shape
    // for a while — exposing it here so the dashboard can show cadence
    // without a new RPC round-trip.
    sessions_30d: number;
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
  // Member detail rows surfaced when a super-admin expands a group
  // card. Fetched lazily (per-group) by `get_group_members_for_super_admin`
  // — see `supabase/059-super-admin-group-members.sql` — so we only
  // pay the join cost for groups the admin actually drills into.
  interface GroupMemberDetail {
    user_id: string | null;
    role: 'admin' | 'member';
    player_id: string | null;
    linked_player_name: string | null;
    email: string | null;
    joined_at: string;
  }
  const [globalStats, setGlobalStats] = useState<GlobalStats | null>(null);
  const [globalLoading, setGlobalLoading] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [globalSubTab, setGlobalSubTab] = useState<'mine' | 'others'>('mine');
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  // Per-group cache: undefined = never fetched, [] = fetched & empty,
  // 'loading' = in-flight, 'error:<msg>' = failed. Stored as a plain
  // object (not Map) so React notices the reference change.
  const [groupMembersCache, setGroupMembersCache] = useState<Record<string, GroupMemberDetail[] | 'loading' | `error:${string}`>>({});

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


  type TabId = 'group' | 'game' | 'chips' | 'players' | 'backup' | 'about' | 'activity' | 'ai' | 'training' | 'triviaReports' | 'superadmin' | 'push' | 'report';
  const VALID_TAB_IDS: readonly TabId[] = ['group', 'game', 'chips', 'players', 'backup', 'about', 'activity', 'ai', 'training', 'triviaReports', 'superadmin', 'push', 'report'];
  const location = useLocation();
  const getDefaultTab = (): TabId => {
    // Honor ?tab=<id> URL param (used by deep links from push notifications).
    // Note: `?tab=schedule` is intentionally NOT honored here — schedule was
    // promoted to its own `/schedule` top-level route, and the URL-sync
    // effect below transparently redirects legacy `?tab=schedule` deep
    // links before they affect activeTab.
    const params = new URLSearchParams(location.search);
    const t = params.get('tab');
    if (t && (VALID_TAB_IDS as readonly string[]).includes(t)) return t as TabId;
    return 'group';
  };

  const [activeTab, setActiveTab] = useState<TabId>(getDefaultTab());

  // Re-sync if URL changes while screen mounted (back/forward / re-deeplink)
  useEffect(() => {
    const params = new URLSearchParams(location.search);

    // Backward-compat: old push notifications, broadcast emails, and the
    // post-Google-OAuth redirect chain still ship `/settings?tab=schedule`
    // URLs. The Schedule tab was promoted to its own `/schedule` route in
    // v5.60 (home is now the primary launcher; schedule is a recurring
    // task, not a setting). Reroute legacy URLs transparently, preserving
    // every other query param (`poll`, `pollId`, `action`) so deep-link
    // behaviour inside ScheduleTab is identical to a direct `/schedule?...`
    // hit. `replace: true` keeps the back button clean — a tap from an
    // email lands directly on /schedule with no /settings intermediate.
    if (params.get('tab') === 'schedule') {
      params.delete('tab');
      const rest = params.toString();
      navigate(`/schedule${rest ? `?${rest}` : ''}`, { replace: true });
      return;
    }

    const t = params.get('tab');
    if (t && (VALID_TAB_IDS as readonly string[]).includes(t) && t !== activeTab) {
      setActiveTab(t as TabId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);
  const [wizardStepIdx, setWizardStepIdx] = useState<number | null>(null);
  const [wizardDismissed, setWizardDismissed] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);
  const [showGameFlow, setShowGameFlow] = useState(false);

  // Shared confirmation dialog — replaces the five legacy native
  // confirm() popups across this screen with a single styled modal so
  // the destructive backup/AI/report actions match the rest of the app.
  // Body supports newlines via `white-space: pre-line`.
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    body: string;
    confirmLabel: string;
    destructive?: boolean;
    onConfirm: () => void | Promise<void>;
  } | null>(null);
  const [confirmDialogBusy, setConfirmDialogBusy] = useState(false);

  const runConfirmDialog = async () => {
    if (!confirmDialog || confirmDialogBusy) return;
    setConfirmDialogBusy(true);
    try {
      await confirmDialog.onConfirm();
    } finally {
      setConfirmDialogBusy(false);
      setConfirmDialog(null);
    }
  };

  // Backup state
  const [backupLoading, setBackupLoading] = useState(false);
  const [backupStatus, setBackupStatus] = useState<string | null>(null);
  const [githubBackups, setGithubBackups] = useState<{ name: string; size: number }[]>([]);
  const [githubLoading, setGithubLoading] = useState(false);
  const [githubLoaded, setGithubLoaded] = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);

  // Push notification state
  const [pushMsg, setPushMsg] = useState('');
  const [pushTarget, setPushTarget] = useState<'all' | 'permanent' | 'permanent_guest' | 'guest' | 'select'>('all');
  const [pushSelectedPlayers, setPushSelectedPlayers] = useState<string[]>([]);
  const [pushSending, setPushSending] = useState(false);
  const [pushResult, setPushResult] = useState<string | null>(null);
  const [pushDetails, setPushDetails] = useState<{ player: string; type: string; status: number | string; ok: boolean }[] | null>(null);
  const [pushSubscriberCount, setPushSubscriberCount] = useState(0);
  const [sendVia, setSendVia] = useState<'push' | 'email' | 'both'>('push');

  // Schedule-email preview tester (super admin only). Defaults the
  // recipient to the signed-in user's auth email so the most common
  // path ("send to me") is one click. Variant 'all' fans out to all
  // 8 templates; specific variants hit just one. State stays local —
  // none of this is persisted because previews are inherently ephemeral.
  const [emailPreviewTo, setEmailPreviewTo] = useState<string>('');
  const [emailPreviewVariant, setEmailPreviewVariant] = useState<ScheduleEmailVariantId | 'all'>('all');
  const [emailPreviewSending, setEmailPreviewSending] = useState(false);
  const [emailPreviewResult, setEmailPreviewResult] = useState<string | null>(null);
  // Pre-fill the recipient with the signed-in user's address as soon as
  // it's known. We only set the default once (when the field is empty)
  // so manual edits aren't clobbered if `userEmail` re-resolves later.
  useEffect(() => {
    const userEmail = multiGroup?.userEmail ?? '';
    if (userEmail && !emailPreviewTo) setEmailPreviewTo(userEmail);
  }, [multiGroup?.userEmail, emailPreviewTo]);

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (!isSuperAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const [pool, ans] = await Promise.all([fetchTrainingPool(), fetchTrainingAnswers()]);
        if (cancelled || !pool || !ans) return;

        const poolIdSet = new Set(pool.scenarios.map(s => s.poolId));
        const flaggedIds = new Set<string>();
        ans.players.forEach(p => p.sessions.forEach(s => {
          (s.flaggedPoolIds || []).forEach(id => { if (poolIdSet.has(id)) flaggedIds.add(id); });
          (s.flagReports || []).forEach(r => { if (poolIdSet.has(r.poolId)) flaggedIds.add(r.poolId); });
        }));

        const needsInsight = ans.players.filter(p =>
          p.pendingReportMilestones && p.pendingReportMilestones.length > 0
        ).length;

        if (!cancelled) setTrainingActionCount(flaggedIds.size + needsInsight);
      } catch { /* best-effort */ }
    })();
    return () => { cancelled = true; };
  }, [isSuperAdmin]);

  // Trivia-reports badge: lightweight RPC that returns 0 for non
  // super admins. Re-run when the tab is opened (so the badge clears
  // after the super-admin triages reports inside the tab).
  useEffect(() => {
    if (!isSuperAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const { data, error: err } = await supabase.rpc('count_pending_trivia_reports');
        if (cancelled) return;
        if (err) {
          setTriviaPendingCount(0);
          return;
        }
        setTriviaPendingCount(typeof data === 'number' ? data : 0);
      } catch { /* best-effort */ }
    })();
    return () => { cancelled = true; };
  }, [isSuperAdmin, activeTab]);

  // v5.62.2 — chip-count accuracy dashboard loader removed alongside
  // the feedback loop. See top-of-file note.

  const [pushSubscribers, setPushSubscribers] = useState<{ userId: string | null; playerName: string | null; endpoint: string }[]>([]);

  const refreshPushSubscribers = useCallback(() => {
    const gid = getGroupId();
    if (!gid) return;
    getGroupPushSubscribers(gid).then(subs => {
      // Dedup by user_id — that's the stable identity. Earlier this
      // was keyed on playerName, which double-counted users whose
      // display name changed (e.g. "ספי" vs "ספי טורס" — same user_id,
      // different label captured at subscribe-time).
      const uniqueUsers = new Set(subs.map(s => s.userId || `name:${s.playerName || '?'}`));
      setPushSubscriberCount(uniqueUsers.size);
      setPushSubscribers(subs);
    });
  }, []);

  useEffect(() => {
    if (activeTab === 'push') refreshPushSubscribers();
  }, [activeTab, refreshPushSubscribers]);

  useEffect(() => {
    if ((isOwner || activeTab === 'push') && groupMgmt && activityMembers.length === 0) {
      groupMgmt.fetchMembers().then(m => setActivityMembers(m));
    }
  }, [isOwner, groupMgmt, activeTab]);

  useEffect(() => {
    if (activeTab === 'activity' && isOwner && !activityLoading) {
      loadActivityLog();
    }
  }, [activeTab]);

  // 60-second ticker that re-renders the Activity tab while it's open.
  // Drives the live elapsed-time computation for the user's own current
  // session (see `lastSessionMin` derivation in the expanded card).
  // Without this, the displayed duration would only update when the
  // user collapsed and re-expanded their card, which is exactly the
  // "still says < 1 דק׳ after 5 minutes" symptom Lior reported. Tied
  // to the activity tab so we don't tick uselessly on other tabs.
  const [, setActivityNowTick] = useState(0);
  useEffect(() => {
    if (activeTab !== 'activity') return;
    const id = setInterval(() => setActivityNowTick(n => n + 1), 60 * 1000);
    return () => clearInterval(id);
  }, [activeTab]);

  // Stable handle to THIS browser's device id. The Activity tab uses it
  // (together with `currentSessionTimestamp`) to identify the viewer's
  // own live-session row so we can render its duration as live wall-
  // clock elapsed time instead of trusting the throttled DB value
  // (which lags by up to ~5–7 minutes).
  const ownDeviceId = useMemo(() => getDeviceId(), []);

  // Auto-load global stats when super admin tab is selected
  useEffect(() => {
    if (activeTab === 'superadmin' && isSuperAdmin && !globalStats && !globalLoading && !globalError) {
      loadGlobalStats();
    }
  }, [activeTab, isSuperAdmin, globalStats, globalLoading, globalError, loadGlobalStats]);

  // Lazy-fetch the member list for a group when its card is expanded.
  // Skips if we already have data (or an in-flight request) to avoid
  // re-querying on every collapse/expand cycle. Keyed on the group id
  // so each card has its own cache slot.
  useEffect(() => {
    if (!expandedGroupId || !isSuperAdmin) return;
    if (groupMembersCache[expandedGroupId] !== undefined) return;
    const gid = expandedGroupId;
    setGroupMembersCache(prev => ({ ...prev, [gid]: 'loading' }));
    (async () => {
      const { data, error } = await supabase.rpc('get_group_members_for_super_admin', {
        target_group_id: gid,
      });
      setGroupMembersCache(prev => ({
        ...prev,
        [gid]: error
          ? (`error:${error.message}` as const)
          : ((data ?? []) as GroupMemberDetail[]),
      }));
    })();
  }, [expandedGroupId, isSuperAdmin, groupMembersCache]);

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

  // EmailJS usage: fetch once on AI tab open (super admin only). Refresh
  // triggers are event-driven — `email-sent` after a successful send, and
  // `visibilitychange` when the user comes back from another tab. No
  // polling: the data only changes when an email is actually sent.
  useEffect(() => {
    if (activeTab !== 'ai' || !isSuperAdmin) return;
    let cancelled = false;
    const refresh = () => {
      proxyEmailUsage().then(u => { if (!cancelled) setEmailUsage(u); });
    };
    refresh();
    const onSent = () => refresh();
    const onVis = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('email-sent', onSent);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      window.removeEventListener('email-sent', onSent);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [activeTab, isSuperAdmin]);

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

  // On tab focus / app return, force a DB refresh of the players cache so
  // the Players sub-tab paints the latest roster after a peer admin's
  // edits — not the stale cache that survives a Realtime WS gap (e.g.
  // phone slept while another admin added or renamed a player). The
  // other cache slices `loadData` reads (chip values, game settings,
  // API keys) almost never change between sessions, so we don't pay the
  // round-trip cost to refresh them — they stay on the existing
  // cache-event-driven path which is enough for their volatility.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useRealtimeRefresh(useCallback(() => loadData(), []), forceRefreshPlayersFromDb);

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

  // v5.60.14 — the v5.60.13 selfie-hex auto-migration effect was
  // removed here. selfieDominantHex is no longer used by the chip-
  // counting pipeline (stackDetection.ts now uses displayColor
  // directly), so there's nothing to migrate. See stackDetection.ts
  // header comment + SQL migration 078 for the full story.

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

  /**
   * v5.59 — capture a per-color chip selfie from the user's camera and
   * save base64 + dominant hex back into `chip_values`. The selfie is
   * used by the photo chip-counting pipeline as:
   *  - a few-shot reference image bundled with each per-stack LLM call
   *  - precomputed dominant color for HSL-based stack-to-chip mapping
   * Both fields are nullable: if the user skips a color the pipeline
   * falls back to `displayColor` for matching and drops the
   * reference-image clause from the LLM prompt.
   */
  const handleSelfieFile = async (chipId: string, file: File | undefined) => {
    if (!file) {
      setChipSelfieBusyId(null);
      return;
    }
    setChipSelfieError('');
    try {
      const result = await captureChipSelfie(file);
      const chip = chipValues.find(c => c.id === chipId);
      if (!chip) return;
      const updated: ChipValue = {
        ...chip,
        selfieBase64: result.base64,
        // v5.60.14 — selfieDominantHex deprecated. The pipeline uses
        // displayColor for HSL matching now (see stackDetection.ts
        // header). Always write null going forward.
        selfieDominantHex: null,
      };
      saveChipValue(updated);
      setChipValues(chipValues.map(c => c.id === chipId ? updated : c));
      showSaved();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setChipSelfieError(msg);
    } finally {
      setChipSelfieBusyId(null);
    }
  };

  const handleClearSelfie = (chipId: string) => {
    const chip = chipValues.find(c => c.id === chipId);
    if (!chip) return;
    const updated: ChipValue = {
      ...chip,
      selfieBase64: null,
      selfieDominantHex: null,
    };
    saveChipValue(updated);
    setChipValues(chipValues.map(c => c.id === chipId ? updated : c));
    showSaved();
  };

  const loadActivityLog = async () => {
    setActivityLoading(true);
    setActivityError(null);
    try {
      const [entries, trainingData] = await Promise.all([
        fetchActivityLog(isSuperAdmin ? groupMgmt?.currentUserId : undefined),
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

  const loadReports = async () => {
    const gid = getGroupId();
    if (!gid && !isSuperAdmin) return;

    let query = supabase
      .from('issue_reports')
      .select('id, group_id, reporter_name, reporter_user_id, category, description, device, status, created_at')
      .order('created_at', { ascending: false })
      .limit(100);

    if (!isSuperAdmin && gid) {
      query = query.eq('group_id', gid);
    }

    const { data } = await query;
    if (data) {
      let items = data as IssueReport[];
      // For super admin: resolve group names
      if (isSuperAdmin && items.length > 0) {
        const groupIds = [...new Set(items.map(r => r.group_id))];
        const { data: groups } = await supabase
          .from('groups').select('id, name').in('id', groupIds);
        if (groups) {
          const nameMap = Object.fromEntries(groups.map((g: { id: string; name: string }) => [g.id, g.name]));
          items = items.map(r => ({ ...r, group_name: nameMap[r.group_id] || '?' }));
        }
      }
      setReports(items);
      setReportsLoaded(true);
    }
  };

  const submitReport = async () => {
    if (!reportCategory || !reportText.trim() || reportSending) return;
    setReportSending(true);
    setReportResult(null);
    try {
      const gid = getGroupId();
      const { data: { user } } = await supabase.auth.getUser();
      const deviceInfo = `${navigator.userAgent.includes('Mobile') ? 'Mobile' : 'Desktop'} / ${navigator.platform}`;

      const { error } = await supabase.from('issue_reports').insert({
        group_id: gid,
        reporter_name: authPlayerName || 'Unknown',
        reporter_user_id: user?.id || null,
        category: reportCategory,
        description: reportText.trim(),
        device: deviceInfo,
      });

      if (error) throw error;

      // Email the group owner
      try {
        let ownerEmail: string | null = null;

        const { data: rpcEmail, error: rpcErr } = await supabase.rpc('get_group_owner_email', { p_group_id: gid });
        if (rpcEmail && !rpcErr) {
          ownerEmail = rpcEmail as string;
        } else {
          const { data: members } = await supabase.rpc('fetch_group_members_with_email', { p_group_id: gid });
          const { data: group } = await supabase.from('groups').select('created_by').eq('id', gid).single();
          if (members && group?.created_by) {
            const owner = (members as { user_id: string; email: string | null }[])
              .find(m => m.user_id === group.created_by);
            ownerEmail = owner?.email || null;
          }
        }

        if (ownerEmail) {
          const catLabel = t(`report.categories.${reportCategory}` as 'report.categories.bug');
          // Gender-aware verb based on the reporter's `Player.gender`.
          // Falls back to male form if the reporter isn't in the player
          // roster (rare — auth users without a linked Player).
          const sentVerb = verbForName('sent', authPlayerName);
          const subjectActor = authPlayerName || 'מישהו';
          const bodyActor = authPlayerName || 'משתמש';
          await proxySendBroadcastEmail({
            to: ownerEmail,
            subject: `📩 ${subjectActor} ${sentVerb} דיווח חדש`,
            message: `היי 👋\n\n${bodyActor} ${sentVerb} דיווח חדש:\n\n📌 ${catLabel}\n${reportText.trim()}\n\nאפשר לבדוק את זה בלשונית "דיווחים" בהגדרות כשנוח 🙏`,
            senderName: 'Poker Manager',
            kind: 'broadcast',
          });
        }
      } catch {
        // best-effort
      }

      setReportCategory('');
      setReportText('');
      setReportResult('success');
      loadReports();
      setTimeout(() => setReportResult(null), 4000);
    } catch {
      setReportResult('error');
    } finally {
      setReportSending(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'report' && !reportsLoaded) {
      loadReports();
    }
  }, [activeTab, reportsLoaded]);

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
    // 'ai' (Services) tab is admin-accessible — admins see only the
    // Photo Chip Counting Test Card inside; all other cards (Game
    // Readiness, API Keys, AI Usage) are individually gated on
    // `isOwner`. This lets a non-owner admin co-tester (e.g. another
    // player with a chip color the owner doesn't have on hand) try
    // the photo→count pipeline before a real game. v5.62.2 — the
    // dashboard + tuning UI that used to live in this tab were
    // removed; the feedback loop they fed has no consumer.
    { id: 'ai', label: t('settings.tabAI'), icon: '🤖', requiresPermission: null, ownerOnly: false, adminOnly: true, superAdminOnly: false },
    { id: 'training', label: t('settings.tabTraining'), icon: '🎯', requiresPermission: null, ownerOnly: false, adminOnly: false, superAdminOnly: true },
    { id: 'triviaReports', label: t('settings.tabTriviaReports'), icon: '🚩', requiresPermission: null, ownerOnly: false, adminOnly: false, superAdminOnly: true },
    { id: 'push', label: t('push.tabLabel'), icon: '🔔', requiresPermission: null, ownerOnly: false, adminOnly: true, superAdminOnly: false },
    { id: 'activity', label: t('settings.tabActivity'), icon: '📊', requiresPermission: null, ownerOnly: true, adminOnly: false, superAdminOnly: false },
    { id: 'superadmin', label: t('settings.tabSuperAdmin'), icon: '🛡️', requiresPermission: null, ownerOnly: false, adminOnly: false, superAdminOnly: true },
    { id: 'report', label: t('settings.tabReport'), icon: '📩', requiresPermission: null, ownerOnly: false, adminOnly: false, superAdminOnly: false },
    { id: 'about', label: t('settings.tabAbout'), icon: 'ℹ️', requiresPermission: null, ownerOnly: false, adminOnly: false, superAdminOnly: false },
    // Schedule moved out of Settings into its own top-level `/schedule`
    // route (v5.60). The Home dashboard is now the primary launcher for
    // poll actions; old `/settings?tab=schedule` deep links continue to
    // work via the redirect in the URL-sync useEffect above.
  ];
  
  const tabs = allTabs.filter(tab => {
    if (tab.superAdminOnly && !isSuperAdmin) return false;
    if (tab.ownerOnly && !isOwner) return false;
    if (tab.adminOnly && role !== 'admin' && !isSuperAdmin && !isOwner) return false;
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
        const hasGameSettings = (settings.locations ?? []).length > 0 || settings.rebuyValue > 0 || getAllGames().length > 0;
        const hasChips = chipValues.length > 0 || getAllGames().length > 0;
        // Honest signal — past `aiSummary` rows are NOT proof the call
        // path works for this group (pre-v5.60.3 the bug let non-owner
        // groups generate AI using the platform owner's key, leaving
        // `aiSummary` rows that don't reflect THIS group's viability).
        const aiWorking = isGeminiEnabledForCurrentGroup();
        const hasInvited = (activityMembers.length > 1) || getAllGames().length > 0;
        const steps = [
          { done: hasPlayers, optional: false, label: t('settings.setup.stepPlayers'), desc: t('settings.setup.stepPlayersDesc'), icon: hasPlayers ? '✅' : '👥', tab: 'players' as TabId },
          { done: hasGameSettings, optional: false, label: t('settings.setup.stepLocations'), desc: t('settings.setup.stepLocationsDesc'), icon: hasGameSettings ? '✅' : '⚙️', tab: 'game' as TabId },
          { done: hasChips, optional: false, label: t('settings.setup.stepChips'), desc: t('settings.setup.stepChipsDesc'), icon: hasChips ? '✅' : '🎰', tab: 'chips' as TabId },
          { done: aiWorking, optional: true, label: t('settings.setup.stepAi'), desc: t('settings.setup.stepAiDesc'), icon: aiWorking ? '✅' : '🔑', tab: 'ai' as TabId },
          { done: hasInvited, optional: false, label: t('settings.setup.stepInvite'), desc: t('settings.setup.stepInviteDesc'), icon: hasInvited ? '✅' : '📨', tab: 'group' as TabId },
        ];
        const allDone = steps.every(s => s.done || s.optional);
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
            // Note: the "pending vote" alert dot that used to sit on the
            // Schedule tab here was removed in v5.60 — Schedule is no
            // longer a Settings tab, and the global VoteReminderBanner
            // (rendered above all routes in App.tsx) already nudges
            // members + admins about pending votes far more visibly.
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
                  ...(tab.id === 'training' && trainingActionCount > 0 && !isActive ? { position: 'relative' as const } : {}),
                  ...(tab.id === 'triviaReports' && triviaPendingCount > 0 && !isActive ? { position: 'relative' as const } : {}),
                }}
              >
                {tab.label}
                {tab.id === 'training' && trainingActionCount > 0 && (
                  <span style={{
                    marginInlineStart: '0.3rem',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    minWidth: '16px', height: '16px', padding: '0 4px',
                    borderRadius: '8px', fontSize: '0.6rem', fontWeight: 700,
                    background: '#f59e0b', color: '#0f172a',
                    lineHeight: 1,
                  }}>
                    {trainingActionCount}
                  </span>
                )}
                {tab.id === 'triviaReports' && triviaPendingCount > 0 && (
                  <span style={{
                    marginInlineStart: '0.3rem',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    minWidth: '16px', height: '16px', padding: '0 4px',
                    borderRadius: '8px', fontSize: '0.6rem', fontWeight: 700,
                    background: '#ef4444', color: '#fff',
                    lineHeight: 1,
                  }}>
                    {triviaPendingCount}
                  </span>
                )}
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

      {/* Multi-group management — create/join */}
      {activeTab === 'group' && multiGroup && (
        <div className="card" style={{ padding: '1rem', marginBottom: '0.75rem' }}>
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

      {/* Group Management Tab */}
      {activeTab === 'group' && groupMgmt && (
        <GroupManagementTab
          groupName={groupMgmt.groupName}
          inviteCode={groupMgmt.inviteCode}
          isOwner={isOwner}
          isAdmin={role === 'admin' || isSuperAdmin || isOwner}
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
          readOnly={multiGroup?.isObservingNonMember ?? false}
        />
      )}

      {/* Schedule Tab (Game Polls) */}
      {/* Game Settings Tab */}
      {activeTab === 'game' && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <h2 className="card-title" style={{ margin: 0 }}>{t('settings.game.title')}</h2>
            {!canEditSettings && (
              <span style={{
                padding: '0.25rem 0.6rem', borderRadius: '6px',
                background: 'rgba(234, 179, 8, 0.1)', border: '1px solid rgba(234, 179, 8, 0.25)',
                color: '#EAB308', fontSize: '0.7rem', fontWeight: 600,
              }}>
                🔒 {t('settings.game.adminOnly')}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', marginBottom: '1rem' }}>
            <div className="settings-row" style={{ animation: 'contentFadeIn 0.25s ease-out both' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{t('settings.game.buyinValue')}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>{t('settings.game.buyinValueHelper')}</div>
              </div>
              <NumericInput
                className="input"
                style={{ width: '90px', textAlign: 'center', fontSize: '0.85rem' }}
                value={settings.rebuyValue}
                onChange={n => handleSettingsChange('rebuyValue', n)}
                min={1}
                disabled={!canEditSettings}
              />
            </div>

            <div className="settings-row" style={{ animation: 'contentFadeIn 0.25s ease-out 0.03s both' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{t('settings.game.chipsPerBuyin')}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
                  {t('settings.game.buyinHelper', { value: cleanNumber(settings.rebuyValue), chips: (settings.chipsPerRebuy || 10000).toLocaleString() })}
                </div>
              </div>
              <NumericInput
                className="input"
                style={{ width: '90px', textAlign: 'center', fontSize: '0.85rem' }}
                value={settings.chipsPerRebuy}
                onChange={n => handleSettingsChange('chipsPerRebuy', n)}
                min={1}
                disabled={!canEditSettings}
              />
            </div>

            <div className="settings-row" style={{ animation: 'contentFadeIn 0.25s ease-out 0.06s both' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{t('settings.game.minTransfer')}</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
                  {t('settings.game.minTransferHelper')}
                </div>
              </div>
              <NumericInput
                className="input"
                style={{ width: '90px', textAlign: 'center', fontSize: '0.85rem' }}
                value={settings.minTransfer}
                onChange={n => handleSettingsChange('minTransfer', n)}
                min={0}
                disabled={!canEditSettings}
              />
            </div>
          </div>

          <div style={{ marginBottom: '1rem', animation: 'contentFadeIn 0.25s ease-out 0.09s both' }}>
            <label className="label" style={{ marginBottom: '0.4rem', display: 'block' }}>{t('settings.game.gameNightDays')}</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
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
                      padding: '0.4rem 0.7rem',
                      borderRadius: '8px',
                      fontSize: '0.8rem',
                      fontWeight: isSelected ? '600' : '400',
                      background: isSelected ? 'var(--primary)' : 'rgba(255,255,255,0.04)',
                      color: isSelected ? 'white' : 'var(--text-muted)',
                      border: `1px solid ${isSelected ? 'var(--primary)' : 'rgba(255,255,255,0.06)'}`,
                      cursor: canEditSettings ? 'pointer' : 'default',
                      opacity: canEditSettings ? 1 : 0.6,
                      transition: 'all 0.15s ease',
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.35rem', marginBottom: 0 }}>
              {t('settings.game.daysHelper')}
            </p>
          </div>

          <div style={{ marginBottom: '1rem', animation: 'contentFadeIn 0.25s ease-out 0.12s both' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
              <label className="label" style={{ margin: 0 }}>{t('settings.game.locations')}</label>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
              {(settings.locations ?? []).length === 0 && (
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                  {t('settings.game.noLocations')}
                </span>
              )}
              {(settings.locations ?? []).map(loc => (
                <div key={loc} style={{
                  display: 'flex', alignItems: 'center', gap: '0.3rem',
                  padding: '0.3rem 0.6rem', borderRadius: '8px',
                  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)',
                  fontSize: '0.8rem', color: 'var(--text)',
                  transition: 'all 0.15s ease',
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
                  disabled={!newLocation.trim()}
                  onClick={() => {
                    const current = settings.locations ?? [];
                    if (!current.includes(newLocation.trim())) {
                      handleSettingsChange('locations', [...current, newLocation.trim()]);
                    }
                    setNewLocation('');
                  }}
                  style={{
                    padding: '0.35rem 0.7rem', borderRadius: '8px',
                    fontSize: '0.8rem', fontFamily: 'Outfit, sans-serif', fontWeight: 600,
                    background: 'rgba(16,185,129,0.12)', color: '#10B981',
                    border: '1px solid rgba(16,185,129,0.3)', cursor: 'pointer',
                  }}
                >{t('settings.game.addLocation')}</button>
              </div>
            )}
          </div>

          {/* Blocked Transfers */}
          <div style={{ animation: 'contentFadeIn 0.25s ease-out 0.15s both' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
              <label className="label" style={{ margin: 0 }}>{t('settings.game.blockedTransfers')}</label>
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
              {t('settings.game.blockedDesc')}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              {(settings.blockedTransfers || []).map((pair, idx) => (
                <div key={idx} className="settings-row" style={{
                  background: 'rgba(239, 68, 68, 0.06)',
                  borderColor: 'rgba(239, 68, 68, 0.12)',
                }}>
                  <span style={{ flex: 1, fontSize: '0.85rem', fontWeight: 500 }}>
                    {pair.playerA} ↔ {pair.playerB}
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem', marginRight: '0.5rem' }}>
                      (מ-{new Date(pair.after).toLocaleDateString(language === 'he' ? 'he-IL' : 'en-US')})
                    </span>
                  </span>
                  {canEditSettings && (
                    <button
                      className="row-action row-action-danger"
                      onClick={() => {
                        const updated = (settings.blockedTransfers || []).filter((_, i) => i !== idx);
                        handleSettingsChange('blockedTransfers', updated);
                      }}
                    >✕</button>
                  )}
                </div>
              ))}
            </div>
            {canEditSettings && (
              <div style={{ marginTop: '0.5rem' }}>
                <div style={{ display: 'flex', gap: '0.3rem', marginBottom: '0.3rem' }}>
                  <select
                    value={newBlockedA}
                    onChange={e => setNewBlockedA(e.target.value)}
                    style={{ flex: 1, fontSize: '0.75rem', padding: '0.4rem 0.5rem', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.04)', color: '#e2e8f0', fontFamily: 'Outfit, sans-serif', cursor: 'pointer' }}
                  >
                    <option value="" style={{ background: '#1a1a2e', color: '#94a3b8' }}>{t('settings.game.playerA')}</option>
                    {players.filter(p => p.type === 'permanent').map(p => (
                      <option key={p.id} value={p.name} style={{ background: '#1a1a2e', color: '#ffffff' }}>{p.name}</option>
                    ))}
                  </select>
                  <select
                    value={newBlockedB}
                    onChange={e => setNewBlockedB(e.target.value)}
                    style={{ flex: 1, fontSize: '0.75rem', padding: '0.4rem 0.5rem', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.04)', color: '#e2e8f0', fontFamily: 'Outfit, sans-serif', cursor: 'pointer' }}
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
                    style={{ flex: 1, fontSize: '0.75rem', background: 'rgba(255,255,255,0.04)', color: '#e2e8f0' }}
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
                    style={{
                      padding: '0.35rem 0.7rem', borderRadius: '8px',
                      fontSize: '0.75rem', fontFamily: 'Outfit, sans-serif', fontWeight: 600,
                      background: 'rgba(16,185,129,0.12)', color: '#10B981',
                      border: '1px solid rgba(16,185,129,0.3)', whiteSpace: 'nowrap', cursor: 'pointer',
                    }}
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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
            <h2 className="card-title" style={{ margin: 0 }}>{t('settings.chips.title')}</h2>
            {canEditChips && (
              <button
                onClick={() => setShowAddChip(true)}
                style={{
                  padding: '0.35rem 0.75rem', borderRadius: '8px',
                  border: '1px solid rgba(16,185,129,0.3)', background: 'rgba(16,185,129,0.12)',
                  color: '#10B981', cursor: 'pointer',
                  fontSize: '0.75rem', fontFamily: 'Outfit, sans-serif', fontWeight: 600,
                }}
              >
                {t('settings.chips.add')}
              </button>
            )}
          </div>

          {chipValues.length === 0 ? (
            <div className="empty-state" style={{ padding: '2rem 1rem' }}>
              <div className="empty-icon">🎰</div>
              <p>{t('settings.chips.title')}</p>
            </div>
          ) : (
            <div>
              {/* v5.59 chip-selfie tip — only shown when at least one
                  configured chip is missing a selfie. The selfie isn't
                  required (the photo pipeline falls back gracefully)
                  but it materially improves accuracy because it
                  anchors stack-to-chip color matching to a calibrated
                  reference instead of `displayColor` (which is just
                  the swatch the user picked in this same UI). */}
              {canEditChips && chipValues.some(c => !c.selfieBase64) && (
                <div style={{
                  marginBottom: '0.75rem',
                  padding: '0.6rem 0.85rem',
                  background: 'rgba(245,158,11,0.08)',
                  border: '1px solid rgba(245,158,11,0.25)',
                  borderRadius: '10px',
                  fontSize: '0.78rem',
                  color: 'var(--text)',
                  lineHeight: 1.5,
                }}>
                  {t('settings.chips.selfieTip')}
                </div>
              )}
              {chipSelfieError && (
                <div style={{
                  marginBottom: '0.5rem',
                  padding: '0.5rem 0.75rem',
                  background: 'rgba(239,68,68,0.10)',
                  border: '1px solid rgba(239,68,68,0.30)',
                  borderRadius: '8px',
                  fontSize: '0.75rem',
                  color: '#fca5a5',
                }}>
                  {chipSelfieError}
                </div>
              )}
              {chipValues.map((chip, idx) => {
                const hasSelfie = !!chip.selfieBase64;
                const busy = chipSelfieBusyId === chip.id;
                return (
                <div
                  key={chip.id}
                  className="settings-row"
                  style={{
                    animation: `contentFadeIn 0.25s ease-out ${idx * 0.03}s both`,
                    flexWrap: 'wrap',
                    rowGap: '0.4rem',
                  }}
                >
                  <div
                    className="chip-circle"
                    style={{
                      backgroundColor: chip.displayColor,
                      border: chip.displayColor === '#FFFFFF' ? '2px solid #ccc' : 'none',
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ flex: 1, fontWeight: 600, fontSize: '0.85rem' }}>{translateChipColor(chip.color, t)}</span>
                  <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem', fontWeight: 500 }}>=</span>
                  <NumericInput
                    className="input"
                    style={{ width: '80px', textAlign: 'center', fontSize: '0.85rem' }}
                    value={chip.value}
                    onChange={n => handleChipValueChange(chip.id, n)}
                    min={1}
                    disabled={!canEditChips}
                  />
                  {canEditChips && (
                    <>
                      {/* v5.62 — selfie cell. ONE compact widget instead
                          of the old three-button cluster (thumb + retake +
                          clear ✕). When a selfie exists: render the thumb;
                          clicking the thumb retakes; the tiny × in the
                          corner clears. When no selfie: a 📷 button takes
                          the first one. The hidden <input> handles the
                          actual file pick for both paths. */}
                      {hasSelfie ? (
                        <div
                          style={{
                            position: 'relative',
                            width: '32px',
                            height: '32px',
                            flexShrink: 0,
                          }}
                        >
                          <img
                            src={`data:image/jpeg;base64,${chip.selfieBase64}`}
                            alt={t('settings.chips.selfieAlt')}
                            title={busy ? t('settings.chips.selfieTake') : t('settings.chips.selfieRetake')}
                            onClick={() => {
                              if (busy) return;
                              setChipSelfieBusyId(chip.id);
                              const input = document.getElementById(`chip-selfie-input-${chip.id}`) as HTMLInputElement | null;
                              input?.click();
                            }}
                            style={{
                              width: '32px',
                              height: '32px',
                              borderRadius: '50%',
                              objectFit: 'cover',
                              cursor: busy ? 'wait' : 'pointer',
                              border: '2px solid rgba(16,185,129,0.5)',
                              opacity: busy ? 0.4 : 1,
                              display: 'block',
                            }}
                          />
                          {/* Tiny × overlay to clear the selfie without
                              having to dig through a context menu. Stops
                              propagation so it never accidentally retakes. */}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (busy) return;
                              handleClearSelfie(chip.id);
                            }}
                            title={t('settings.chips.selfieClear')}
                            aria-label={t('settings.chips.selfieClear')}
                            style={{
                              position: 'absolute',
                              top: '-4px',
                              insetInlineEnd: '-4px',
                              width: '16px',
                              height: '16px',
                              borderRadius: '50%',
                              background: '#1f2937',
                              border: '1px solid var(--border)',
                              color: '#fca5a5',
                              fontSize: '0.65rem',
                              lineHeight: 1,
                              padding: 0,
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontFamily: 'inherit',
                              opacity: busy ? 0.4 : 1,
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      ) : (
                        <button
                          className="row-action"
                          onClick={() => {
                            if (busy) return;
                            setChipSelfieBusyId(chip.id);
                            const input = document.getElementById(`chip-selfie-input-${chip.id}`) as HTMLInputElement | null;
                            input?.click();
                          }}
                          title={t('settings.chips.selfieTake')}
                          disabled={busy}
                          style={{ opacity: busy ? 0.5 : 1 }}
                        >
                          {busy ? '⏳' : '📷'}
                        </button>
                      )}
                      <input
                        id={`chip-selfie-input-${chip.id}`}
                        type="file"
                        accept="image/*"
                        capture="environment"
                        style={{ display: 'none' }}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          e.target.value = '';
                          void handleSelfieFile(chip.id, f);
                        }}
                      />
                      <button
                        className="row-action row-action-danger"
                        onClick={() => setDeleteChipConfirm({ id: chip.id, name: translateChipColor(chip.color, t) })}
                        title={t('settings.chips.deleteTitle')}
                      >
                        🗑️
                      </button>
                    </>
                  )}
                </div>
                );
              })}
            </div>
          )}

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
                {t('settings.players.add')}
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
              {(['permanent', 'permanent_guest', 'guest'] as const).map(groupType => {
                const groupPlayers = players.filter(p => p.type === groupType);
                if (groupPlayers.length === 0) return null;

                const groupTitle = groupType === 'permanent'
                  ? (language === 'he' ? '⭐ קבועים' : '⭐ Permanent')
                  : groupType === 'permanent_guest'
                    ? (language === 'he' ? '🏠 אורחים' : '🏠 Guests')
                    : (language === 'he' ? '👤 מזדמנים' : '👤 Occasional');
                const isCollapsed = playerGroupsCollapsed[groupType];
                const chevron = isCollapsed ? (isRTL ? '◀' : '▶') : '▼';

                return (
                  <div key={groupType} style={{ marginBottom: '0.5rem' }}>
                    <button
                      type="button"
                      onClick={() => setPlayerGroupsCollapsed(prev => ({ ...prev, [groupType]: !prev[groupType] }))}
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '0.5rem',
                        padding: '0.5rem 0.75rem',
                        background: 'var(--surface)',
                        border: '1px solid var(--border)',
                        borderRadius: '8px',
                        color: 'var(--text)',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        fontSize: '0.85rem',
                        fontWeight: 600,
                        marginBottom: isCollapsed ? 0 : '0.25rem',
                      }}
                      aria-expanded={!isCollapsed}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <span>{groupTitle}</span>
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem', fontWeight: 500 }}>
                          ({groupPlayers.length})
                        </span>
                      </span>
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.7rem' }}>{chevron}</span>
                    </button>

                    {!isCollapsed && (
                      <div>
                        {groupPlayers.map((player, idx) => {
                          // Gender glyph (♀ / ♂) sits inline directly after
                          // the name, gender-coloured (pink / blue) for an
                          // immediate visual cue. Sized 0.95rem and bold
                          // — an explicit upgrade over the prior almost-
                          // invisible 0.55rem @ 60% opacity rendering.
                          const genderGlyph = player.gender === 'female' ? '♀' : '♂';
                          const genderColor = player.gender === 'female' ? '#EC4899' : '#60A5FA';
                          return (
                            <div
                              key={player.id}
                              className="settings-row"
                              style={{ animation: `contentFadeIn 0.25s ease-out ${idx * 0.03}s both` }}
                            >
                              <div style={{
                                flex: 1, minWidth: 0,
                                display: 'flex', alignItems: 'center', gap: '0.4rem',
                              }}>
                                <span style={{
                                  fontWeight: 600, fontSize: '0.9rem',
                                  color: 'var(--text)',
                                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                                  minWidth: 0,
                                }}>
                                  {player.name}
                                </span>
                                <span
                                  title={player.gender === 'female' ? 'נקבה' : 'זכר'}
                                  style={{
                                    fontSize: '0.95rem',
                                    fontWeight: 700,
                                    color: genderColor,
                                    flexShrink: 0,
                                    lineHeight: 1,
                                  }}>
                                  {genderGlyph}
                                </span>
                              </div>

                              {(canEditPlayers || canDeletePlayers) && (
                                <div style={{ display: 'flex', gap: '0.25rem', flexShrink: 0 }}>
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
          setConfirmDialog({
            title: t('settings.backup.restoreConfirmTitle'),
            body: msg,
            confirmLabel: t('settings.backup.restoreAction'),
            destructive: true,
            onConfirm: async () => {
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
            },
          });
        };

        const handleGitHubRestore = (fileName: string) => {
          setConfirmDialog({
            title: t('settings.backup.restoreConfirmTitle'),
            body: t('settings.backup.restoreConfirm'),
            confirmLabel: t('settings.backup.restoreAction'),
            destructive: true,
            onConfirm: async () => {
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
            },
          });
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
      {/* v5.58: outer gate widened from `isOwner` to "admin or
          owner" so the Photo Test Card (which sits OUTSIDE the
          inner `{isOwner && (<>…</>)}` wrapper, see below) can
          render for non-owner admin co-testers. The IIFE-level
          computations (getTodayActions etc.) are cheap reads,
          safe to run for admins. All owner-only cards inside the
          IIFE are gated on isOwner separately. */}
      {activeTab === 'ai' && (isOwner || role === 'admin' || isSuperAdmin) && (() => {
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
            {/* Owner-only block — everything in the Services tab EXCEPT
                the Photo Chip Counting Test Card is gated on isOwner.
                The test card sits outside this wrapper so non-owner
                admin co-testers (e.g. another player who has access
                to a chip color the owner doesn't have on hand) can
                use it. v5.58. */}
            {isOwner && (<>
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
                                onClick={() => setConfirmDialog({
                                  title: t('settings.ai.confirmDeleteTitle'),
                                  body: t('settings.ai.confirmDeleteUsage'),
                                  confirmLabel: t('common.delete'),
                                  destructive: true,
                                  onConfirm: () => { deleteElevenLabsGameEntry(h.gameId); setAiTick(u => u + 1); },
                                })}
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

            {/* EmailJS Usage Card — super admin only.
                Mirrors the ElevenLabs Usage card directly above it: same
                quota bar, same stats row, same recent-list pattern. Data
                comes from `email_usage_log` (we maintain it ourselves —
                EmailJS Free has no usage API). The card refreshes on
                `email-sent` events so the bar updates immediately when an
                admin sends a poll notification or settlement email. */}
            {isSuperAdmin && (() => {
              const used = emailUsage?.used ?? 0;
              const limit = emailUsage?.limit ?? 200;
              const limitSource = emailUsage?.limitSource ?? 'default';
              const remaining = emailUsage?.remaining ?? Math.max(limit - used, 0);
              const failed = emailUsage?.failed ?? 0;
              const resetDate = emailUsage?.resetDate;
              const loggingSince = emailUsage?.loggingSince || null;
              const usedPct = Math.min(Math.round((used / limit) * 100), 100);
              const perKind = emailUsage?.perKind || {};
              const perDay = emailUsage?.perDay || [];
              const recent = emailUsage?.recent || [];
              const avgPerDay = perDay.length > 0
                ? Math.round(perDay.reduce((s, d) => s + d.count, 0) / perDay.length)
                : 0;
              const loggingSinceLoc = language === 'he' ? 'he-IL' : 'en-US';
              const loggingSinceStr = loggingSince
                ? new Date(loggingSince).toLocaleDateString(loggingSinceLoc, { day: 'numeric', month: 'short', year: 'numeric' })
                : null;
              // EmailJS-cache provenance. When `usedSource` is 'emailjs'
              // the headline number is derived from EmailJS's own
              // /history API — caches locally so we beat their 7-day
              // retention. The "last synced" line tells the operator
              // when the local cache was last refreshed against EmailJS.
              const usedSource = emailUsage?.usedSource ?? 'self_log';
              // Note: emailjsLastSyncedAt was used in the previous design
              // where EmailJS API was the primary source. Since v5.43.3
              // the self-log (with operator-supplied baseline) is the
              // primary; the EmailJS cache is only a cross-check, so the
              // sync timestamp surfaces in the in-sync line below
              // instead of the source caption.
              // Sort kinds by count desc for the breakdown — most-frequent at the top.
              const kindEntries = Object.entries(perKind).sort((a, b) => b[1] - a[1]);
              // Translation key map. Falls back to the raw kind string for any
              // future kinds we add before remembering to register a label.
              const kindLabel = (kind: string): string => {
                const key = `settings.ai.emailKind.${kind}` as 'settings.ai.emailKind.invitation';
                const translated = t(key);
                return translated === key ? kind : translated;
              };
              const usageLoc = language === 'he' ? 'he-IL' : 'en-US';
              return (
                <div className="card" style={{ padding: '1rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', gap: '0.5rem' }}>
                    <h2 className="card-title" style={{ margin: 0 }}>{t('settings.ai.emailJsUsage')}</h2>
                    {/* Inline quota config editor toggle. Super-admin
                        opens this to seed the baseline (e.g. 86 from
                        the EmailJS dashboard), set the monthly cap,
                        and the cycle reset day — no env-var changes
                        required. Persisted to `system_config`. */}
                    <button
                      onClick={async () => {
                        if (!showQuotaEditor) {
                          // Pre-fill with whatever's currently configured.
                          const cfg = await proxyGetEmailQuotaConfig();
                          setQuotaEditor({
                            resetDay: cfg?.resetDay ? String(cfg.resetDay) : '',
                            monthlyCap: cfg?.monthlyCap ? String(cfg.monthlyCap) : '',
                            baselineUsed: cfg?.baseline ? String(cfg.baseline.used) : '',
                            baselineCycleStart: cfg?.baseline ? cfg.baseline.cycleStart.slice(0, 10) : '',
                          });
                        }
                        setShowQuotaEditor(s => !s);
                      }}
                      style={{
                        fontSize: '0.65rem',
                        padding: '0.25rem 0.55rem',
                        background: 'rgba(99, 102, 241, 0.12)',
                        border: '1px solid rgba(99, 102, 241, 0.4)',
                        borderRadius: '6px',
                        color: '#a5b4fc',
                        cursor: 'pointer',
                      }}
                    >
                      {showQuotaEditor ? t('common.cancel') : `🔧 ${t('settings.ai.emailQuotaEdit')}`}
                    </button>
                  </div>
                  {showQuotaEditor && (
                    <div style={{
                      padding: '0.75rem', marginBottom: '0.75rem',
                      borderRadius: '8px', border: '1px solid var(--border)',
                      background: 'var(--surface)',
                    }}>
                      <p style={{ margin: '0 0 0.5rem', fontSize: '0.65rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                        {t('settings.ai.emailQuotaEditHelp')}
                      </p>
                      <div style={{ display: 'grid', gap: '0.45rem' }}>
                        <label style={{ fontSize: '0.7rem', color: 'var(--text)', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                          <span>{t('settings.ai.emailQuotaCap')}</span>
                          <input
                            type="number" min={1} placeholder="200"
                            value={quotaEditor.monthlyCap}
                            onChange={e => setQuotaEditor(s => ({ ...s, monthlyCap: e.target.value }))}
                            style={{ padding: '0.4rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--background)', color: 'var(--text)', fontSize: '0.8rem' }}
                          />
                        </label>
                        <label style={{ fontSize: '0.7rem', color: 'var(--text)', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                          <span>{t('settings.ai.emailQuotaResetDay')}</span>
                          <input
                            type="number" min={1} max={31} placeholder="19"
                            value={quotaEditor.resetDay}
                            onChange={e => setQuotaEditor(s => ({ ...s, resetDay: e.target.value }))}
                            style={{ padding: '0.4rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--background)', color: 'var(--text)', fontSize: '0.8rem' }}
                          />
                        </label>
                        <label style={{ fontSize: '0.7rem', color: 'var(--text)', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                          <span>{t('settings.ai.emailQuotaBaselineUsed')}</span>
                          <input
                            type="number" min={0} placeholder="86"
                            value={quotaEditor.baselineUsed}
                            onChange={e => setQuotaEditor(s => ({ ...s, baselineUsed: e.target.value }))}
                            style={{ padding: '0.4rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--background)', color: 'var(--text)', fontSize: '0.8rem' }}
                          />
                        </label>
                        <label style={{ fontSize: '0.7rem', color: 'var(--text)', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                          <span>{t('settings.ai.emailQuotaBaselineCycleStart')}</span>
                          <input
                            type="date"
                            value={quotaEditor.baselineCycleStart}
                            onChange={e => setQuotaEditor(s => ({ ...s, baselineCycleStart: e.target.value }))}
                            style={{ padding: '0.4rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--background)', color: 'var(--text)', fontSize: '0.8rem' }}
                          />
                        </label>
                      </div>
                      <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.6rem', justifyContent: 'flex-end' }}>
                        <button
                          disabled={quotaEditorSaving}
                          onClick={async () => {
                            setQuotaEditorSaving(true);
                            try {
                              const updates: Parameters<typeof proxySetEmailQuotaConfig>[0] = {};
                              if (quotaEditor.monthlyCap.trim()) updates.monthlyCap = Number(quotaEditor.monthlyCap);
                              if (quotaEditor.resetDay.trim()) updates.resetDay = Number(quotaEditor.resetDay);
                              if (quotaEditor.baselineUsed.trim() && quotaEditor.baselineCycleStart) {
                                // takenAt = now (rows from this point onward count as new sends)
                                updates.baseline = {
                                  used: Number(quotaEditor.baselineUsed),
                                  takenAt: new Date().toISOString(),
                                  cycleStart: new Date(quotaEditor.baselineCycleStart + 'T00:00:00Z').toISOString(),
                                };
                              } else if (!quotaEditor.baselineUsed.trim() && !quotaEditor.baselineCycleStart) {
                                // Both blank → clear baseline (next cycle, no seed needed)
                                updates.baseline = null;
                              }
                              const res = await proxySetEmailQuotaConfig(updates);
                              if (res.ok) {
                                setShowQuotaEditor(false);
                                // Refresh the Usage card.
                                const fresh = await proxyEmailUsage();
                                setEmailUsage(fresh);
                              }
                            } finally {
                              setQuotaEditorSaving(false);
                            }
                          }}
                          style={{ padding: '0.4rem 0.85rem', borderRadius: '6px', border: '1px solid rgba(16,185,129,0.4)', background: 'rgba(16,185,129,0.15)', color: '#10B981', fontSize: '0.75rem', cursor: 'pointer' }}
                        >
                          {quotaEditorSaving ? '…' : t('common.save')}
                        </button>
                      </div>
                    </div>
                  )}
                  <div>
                    {/* Quota warning banner — shows when usage crosses
                        80% / 95% / 100%. The server fires a push at the
                        same thresholds (api/send-email.ts), so this
                        banner is the in-app visual companion that
                        always shows regardless of push permissions. */}
                    {usedPct >= 80 && (
                      <div
                        role="alert"
                        style={{
                          marginBottom: '0.75rem',
                          padding: '0.6rem 0.75rem',
                          borderRadius: 8,
                          background: usedPct >= 100
                            ? 'rgba(239, 68, 68, 0.18)'
                            : usedPct >= 95
                              ? 'rgba(239, 68, 68, 0.12)'
                              : 'rgba(245, 158, 11, 0.12)',
                          border: `1px solid ${usedPct >= 95 ? 'rgba(239,68,68,0.45)' : 'rgba(245,158,11,0.45)'}`,
                          color: usedPct >= 95 ? '#FCA5A5' : '#FCD34D',
                          fontSize: '0.72rem',
                          lineHeight: 1.5,
                          display: 'flex',
                          alignItems: 'center',
                          gap: '0.4rem',
                        }}
                      >
                        <span style={{ fontSize: '0.95rem' }}>
                          {usedPct >= 100 ? '🚫' : usedPct >= 95 ? '🔴' : '⚠️'}
                        </span>
                        <span>
                          {usedPct >= 100
                            ? t('settings.ai.emailQuotaFull', { used: used.toLocaleString(), limit: limit.toLocaleString() })
                            : usedPct >= 95
                              ? t('settings.ai.emailQuotaCritical', { used: used.toLocaleString(), remaining: remaining.toLocaleString() })
                              : t('settings.ai.emailQuotaWarning', { pct: Math.round(usedPct), remaining: remaining.toLocaleString() })}
                        </span>
                      </div>
                    )}
                    {/* Monthly quota bar */}
                    <div style={{ marginBottom: '0.75rem' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.3rem' }}>
                        <span style={{ fontSize: '0.7rem', color: 'var(--text)' }}>
                          {emailUsage ? t('settings.ai.emailUsedLimit', { used: used.toLocaleString(), limit: limit.toLocaleString() }) : t('settings.ai.emailUsageLoading')}
                        </span>
                        <span style={{ fontSize: '0.65rem', color: usedPct > 80 ? '#EF4444' : usedPct > 50 ? '#F59E0B' : '#10B981', fontWeight: 600 }}>
                          {emailUsage ? t('settings.ai.emailRemaining', { remaining: remaining.toLocaleString() }) : ''}
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
                          {t('settings.ai.emailResetLine', { date: resetDate, perDay: avgPerDay })}
                          {/* If the operator hasn't set EMAILJS_QUOTA_RESET_DAY,
                              EmailJS's actual reset day (signup-anniversary,
                              shown on dashboard) won't match what we display.
                              Surface it loudly so the operator either sets the
                              env var or knows the date is calendar-month. */}
                          {emailUsage?.resetDaySource === 'default' && (
                            <span style={{ color: '#F59E0B', marginInlineStart: '0.4rem' }}>
                              · {t('settings.ai.emailResetDefault')}
                            </span>
                          )}
                        </div>
                      )}
                      {/* Honesty block: the "limit" is a configured default, not a
                          live read from EmailJS (they don't expose plan info via
                          API), and the headline number is labelled with its
                          actual source — EmailJS's own /history API (cached
                          locally) when available, otherwise our self-log as
                          fallback. Without this context the card looks
                          fabricated to anyone who's ever clicked through to
                          their actual EmailJS dashboard. */}
                      {emailUsage && (
                        <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: '0.4rem', lineHeight: 1.45 }}>
                          {/* Source provenance.
                              - baseline_plus_self_log: operator-confirmed
                                EmailJS-dashboard reading at cycle start +
                                every send since. Active for the partial
                                first cycle.
                              - self_log: pure email_usage_log count. From
                                the second cycle onward (audit log
                                covers the whole cycle natively). */}
                          {usedSource === 'baseline_plus_self_log' && emailUsage.baselineApplied
                            ? t('settings.ai.emailSourceBaseline', {
                                baseline: emailUsage.baselineApplied.toLocaleString(),
                                tracked: (emailUsage.used - emailUsage.baselineApplied).toLocaleString(),
                              })
                            : (loggingSinceStr
                                ? t('settings.ai.emailSourceSelfLog', { date: loggingSinceStr })
                                : t('settings.ai.emailNoLogsYet'))}
                          {' · '}
                          {/* Source provenance for the limit:
                              'config'  = stored in system_config (UI-edited, the preferred path)
                              'env'     = legacy env var fallback
                              'default' = neither set; we used 200. Nudge with a warning color. */}
                          {limitSource === 'default'
                            ? <span style={{ color: '#F59E0B' }}>{t('settings.ai.emailLimitDefault')}</span>
                            : t('settings.ai.emailLimitFromEnv')}
                          {' · '}
                          <a
                            href="https://dashboard.emailjs.com/admin"
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: '#3B82F6', textDecoration: 'underline', textDecorationStyle: 'dotted' }}
                          >
                            {t('settings.ai.emailOpenDashboard')}
                          </a>
                        </div>
                      )}
                      {/* EmailJS upstream cross-check (last 7 days). Visible
                          only when the /history API is reachable; if the
                          private key isn't configured we silently hide this
                          line — there's no useful info to show. The 7-day
                          window matches EmailJS Free-tier retention, so
                          this works on every plan. */}
                      {emailUsage?.emailjsAvailable && (() => {
                        const eUsed = emailUsage.emailjsLast7d ?? 0;
                        const our7d = emailUsage.ourLast7d ?? 0;
                        const sync = emailUsage.inSync ?? 'unknown';
                        const color = sync === 'ok' ? '#10B981' : sync === 'gap' ? '#F59E0B' : 'var(--text-muted)';
                        const icon = sync === 'ok' ? '✓' : sync === 'gap' ? '⚠' : '·';
                        const label = sync === 'gap'
                          ? t('settings.ai.emailJsGap', { emailjs: eUsed, ours: our7d })
                          : t('settings.ai.emailJsInSync', { count: eUsed });
                        return (
                          <div style={{
                            fontSize: '0.6rem', color, marginTop: '0.3rem', lineHeight: 1.45,
                            display: 'flex', alignItems: 'baseline', gap: '0.3rem',
                          }}>
                            <span style={{ fontWeight: 700 }}>{icon}</span>
                            <span>{label}</span>
                          </div>
                        );
                      })()}
                    </div>

                    {/* Stats row */}
                    {emailUsage && used + failed > 0 && (
                      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                        <div style={{ background: 'rgba(59,130,246,0.08)', borderRadius: 8, padding: '0.4rem 0.6rem', flex: 1, textAlign: 'center' }}>
                          <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#3B82F6' }}>{used.toLocaleString()}</div>
                          <div style={{ fontSize: '0.55rem', color: 'var(--text-muted)' }}>{t('settings.ai.emailUsedLimit', { used, limit }).split(' /')[0]}</div>
                        </div>
                        <div style={{ background: 'rgba(239,68,68,0.08)', borderRadius: 8, padding: '0.4rem 0.6rem', flex: 1, textAlign: 'center' }}>
                          <div style={{ fontSize: '0.95rem', fontWeight: 700, color: failed > 0 ? '#EF4444' : 'var(--text-muted)' }}>{failed.toLocaleString()}</div>
                          <div style={{ fontSize: '0.55rem', color: 'var(--text-muted)' }}>{t('settings.ai.emailFailed')}</div>
                        </div>
                        <div style={{ background: 'rgba(16,185,129,0.08)', borderRadius: 8, padding: '0.4rem 0.6rem', flex: 1, textAlign: 'center' }}>
                          <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#10B981' }}>{avgPerDay.toLocaleString()}</div>
                          <div style={{ fontSize: '0.55rem', color: 'var(--text-muted)' }}>{t('settings.ai.emailAvgPerDay')}</div>
                        </div>
                      </div>
                    )}

                    {/* Per-kind breakdown */}
                    {kindEntries.length > 0 && (
                      <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.5rem', marginBottom: '0.5rem' }}>
                        <div style={{ fontSize: '0.65rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.3rem' }}>{t('settings.ai.emailByKind')}</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                          {kindEntries.map(([kind, count]) => (
                            <span key={kind} style={{
                              fontSize: '0.65rem', padding: '0.2rem 0.5rem', borderRadius: '0.4rem',
                              background: 'rgba(99, 102, 241, 0.1)', border: '1px solid rgba(99, 102, 241, 0.3)',
                              color: '#a5b4fc', fontFeatureSettings: '"tnum"',
                            }}>
                              {kindLabel(kind)} · {count}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Recent sends — collapsible to keep the card compact */}
                    {recent.length > 0 ? (
                      <div style={{ borderTop: '1px solid var(--border)', paddingTop: '0.5rem' }}>
                        <button
                          onClick={() => setShowEmailRecent(s => !s)}
                          style={{
                            width: '100%', background: 'transparent', border: 'none', cursor: 'pointer',
                            display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 0,
                            color: 'var(--text-muted)',
                          }}
                        >
                          <span style={{ fontSize: '0.65rem', fontWeight: 600 }}>{t('settings.ai.emailRecent')} · {recent.length}</span>
                          <span style={{ fontSize: '0.6rem', transform: showEmailRecent ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>▼</span>
                        </button>
                        {showEmailRecent && (
                          <div style={{ marginTop: '0.4rem', maxHeight: '240px', overflowY: 'auto' }}>
                            {recent.map((entry, i) => {
                              const d = new Date(entry.sent_at);
                              const dateStr = d.toLocaleDateString(usageLoc, { day: 'numeric', month: 'short' });
                              const timeStr = d.toLocaleTimeString(usageLoc, { hour: '2-digit', minute: '2-digit' });
                              return (
                                <div key={`${entry.sent_at}-${i}`} style={{
                                  display: 'flex', alignItems: 'center', gap: '0.5rem',
                                  padding: '0.3rem 0',
                                  borderBottom: i < recent.length - 1 ? '1px solid var(--border)' : 'none',
                                  fontSize: '0.65rem',
                                }}>
                                  <span style={{ minWidth: '70px', color: 'var(--text-muted)' }}>{dateStr} {timeStr}</span>
                                  <span style={{ minWidth: '85px', color: 'var(--text)' }}>{kindLabel(entry.kind)}</span>
                                  <span style={{ flex: 1, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'ltr', textAlign: isRTL ? 'right' : 'left' }}>{entry.recipient}</span>
                                  <span style={{ color: entry.success ? '#10B981' : '#EF4444', fontWeight: 700 }}>
                                    {entry.success ? '✓' : '✗'}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ) : (
                      emailUsage && (
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', textAlign: 'center', padding: '0.5rem 0', borderTop: '1px solid var(--border)' }}>
                          {t('settings.ai.emailUsageEmpty')}
                        </div>
                      )
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
                  onClick={() => setConfirmDialog({
                    title: t('settings.ai.confirmResetTitle'),
                    body: t('settings.ai.confirmReset'),
                    confirmLabel: t('settings.ai.resetData'),
                    destructive: true,
                    onConfirm: () => { resetUsage(); setAiStatus(getAIStatus()); setAiTestResults(null); },
                  })}
                  style={{ fontSize: '0.6rem', padding: '0.2rem 0.5rem', background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)' }}
                >
                  {t('settings.ai.resetData')}
                </button>
              </div>
            </div>

            {/* Per-Group API Keys (config — moved to bottom of tab so live
                quota/usage cards lead the page; configuration is a one-time
                setup task that doesn't need top billing). */}
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

            {/* API Key Setup Guide (only when no key configured — first-run
                onboarding companion to the API Keys card right above). */}
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

            </>)}
            {/* Photo Chip Counting Test Card — visible to ALL admins
                (owner + non-owner admins) so a co-tester can take
                test photos. v5.58 (opened to non-owner admins).
                v5.62.2 — removed the "submit feedback" submission;
                the card is now read-only proof-of-life for the
                photo→count pipeline. */}
            <div className="card" style={{ padding: '1rem', marginBottom: '0.75rem' }}>
              <h2 className="card-title" style={{ margin: '0 0 0.4rem 0' }}>
                {t('settings.photoTest.title')}
              </h2>
              <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.8rem', color: 'var(--text-muted)', lineHeight: 1.55 }}>
                {t('settings.photoTest.helper')}
              </p>
              {(() => {
                // Two real prerequisites for the photo flow:
                //   1. `aiAvailable` — the Gemini call path must work
                //      for THIS group right now. Pre-v5.60.3 we also
                //      accepted "any past game has an aiSummary" as
                //      proof, but non-owner groups silently used the
                //      platform owner's key for AI — past summaries
                //      don't prove the group can call AI today. The
                //      eligibility helper covers both per-group key
                //      AND owner-group env-var fallback honestly.
                //   2. `noChips` — at least one chip value must be
                //      defined; nothing to count without them.
                // We surface only the more actionable reason — a
                // missing key beats missing chips because the API
                // Keys card is one panel up on this same tab while
                // chips live under a separate Chips tab.
                const aiAvailable = isGeminiEnabledForCurrentGroup();
                const noChips = chipValues.length === 0;
                const disabled = !aiAvailable || noChips;
                const reasonKey = !aiAvailable
                  ? 'settings.photoTest.disabledNoKey'
                  : noChips
                    ? 'settings.photoTest.disabledNoChips'
                    : null;
                return (
                  <>
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => setPhotoTestOpen(true)}
                      disabled={disabled}
                      style={{ width: '100%', padding: '0.65rem' }}
                    >
                      {t('settings.photoTest.takePhoto')}
                    </button>
                    {reasonKey && (
                      <p style={{
                        margin: '0.5rem 0 0',
                        fontSize: '0.75rem',
                        color: 'var(--text-muted)',
                        lineHeight: 1.5,
                        fontStyle: 'italic',
                      }}>
                        {t(reasonKey)}
                      </p>
                    )}
                  </>
                );
              })()}

              {photoTestResult && !photoTestResult.error && (
                <div style={{ marginTop: '0.85rem' }}>
                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '0.5rem',
                  }}>
                    <h3 style={{ fontSize: '0.9rem', margin: 0, fontWeight: 700 }}>
                      {t('settings.photoTest.resultsTitle')}
                    </h3>
                    <span style={{
                      fontSize: '0.85rem',
                      fontWeight: 700,
                      color: photoTestResult.overallConfidence >= 95 ? '#10b981'
                        : photoTestResult.overallConfidence >= 80 ? '#eab308'
                        : '#ef4444',
                    }}>
                      {t('settings.photoTest.confidenceLabel')}: {photoTestResult.overallConfidence}%
                    </span>
                  </div>

                  {photoTestPreview && (
                    <div style={{ marginBottom: '0.5rem' }}>
                      <ChipDetectionOverlay
                        photoBase64={photoTestPreview}
                        photoMimeType={photoTestPreviewMime}
                        stacks={photoTestResult.stacks}
                        chipById={new Map(chipValues.map(c => [c.id, c]))}
                        adjustedStackId={photoTestResult.totalValueCheckResult?.adjustedStackId ?? null}
                        maxHeight={220}
                      />
                    </div>
                  )}

                  {/* v5.59 — pipeline diagnostics strip. Compact one-
                      liner showing how the detector found the stacks,
                      whether WB correction fired, and (test card has
                      no `expectedTotalValue`, so this branch typically
                      stays empty here, but kept for symmetry with the
                      live game flow). */}
                  {(photoTestResult.detectionSignal || photoTestResult.whiteBalanceApplied !== undefined) && (
                    <div style={{
                      marginBottom: '0.55rem',
                      padding: '0.4rem 0.6rem',
                      background: 'rgba(99,102,241,0.06)',
                      border: '1px solid rgba(99,102,241,0.20)',
                      borderRadius: '8px',
                      fontSize: '0.7rem',
                      color: 'var(--text-muted)',
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '0.25rem 0.7rem',
                    }}>
                      {photoTestResult.detectionSignal && (
                        <span>
                          {t('chips.photo.banner.detectionSignal')}:&nbsp;
                          <span style={{
                            color: photoTestResult.detectionSignal === 'position-only' ? '#fca5a5' : 'var(--text)',
                            fontWeight: 600,
                          }}>
                            {t(`chips.photo.banner.detection.${photoTestResult.detectionSignal}` as const)}
                          </span>
                        </span>
                      )}
                      {photoTestResult.whiteBalanceApplied && (
                        <span style={{ color: '#10b981', fontWeight: 600 }}>
                          ✓ {t('chips.photo.banner.wbOn')}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Per-chip rows. v5.62.2: the ground-truth input
                      column and "save feedback" submission were
                      removed. The test card is now a pure read-out
                      of the AI's count + confidence per color — same
                      data the live-game flow shows, with no extra
                      ask of the user.

                      Aggregation note (v5.60.3, still applies): the
                      pipeline can emit multiple stacks for the same
                      color (user split chips into separate piles, or
                      detection over-segmented). We sum the AI counts
                      per chipId and take the MIN confidence (most
                      conservative — flags any weak stack of that
                      color), so there's exactly ONE row per color
                      and React keys are unique. Per-stack provenance
                      is still preserved on `photoTestResult.stacks`
                      and surfaced via the confidence-cell tooltip. */}
                  <div>
                    {(() => {
                      type AggStack = {
                        chipId: string;
                        color: string;
                        aiCount: number;
                        minConfidence: number;
                        stacks: typeof photoTestResult.stacks;
                      };
                      const aggMap = new Map<string, AggStack>();
                      for (const stack of photoTestResult.stacks) {
                        const existing = aggMap.get(stack.chipId);
                        if (existing) {
                          existing.aiCount += stack.count;
                          existing.minConfidence = Math.min(existing.minConfidence, stack.confidence);
                          existing.stacks.push(stack);
                        } else {
                          aggMap.set(stack.chipId, {
                            chipId: stack.chipId,
                            color: stack.color,
                            aiCount: stack.count,
                            minConfidence: stack.confidence,
                            stacks: [stack],
                          });
                        }
                      }
                      return [...aggMap.values()];
                    })().map(agg => {
                      const chip = chipValues.find(c => c.id === agg.chipId);
                      if (!chip) return null;
                      const stack = agg.stacks[0];
                      const stackCount = agg.stacks.length;
                      const borderColor = agg.minConfidence >= 80
                        ? 'rgba(16,185,129,0.5)'
                        : agg.minConfidence >= 60
                          ? 'rgba(234,179,8,0.5)'
                          : 'rgba(239,68,68,0.6)';
                      return (
                        <div
                          key={agg.chipId}
                          className="settings-row"
                          style={{ borderInlineStart: `3px solid ${borderColor}` }}
                        >
                          <div
                            className="chip-circle"
                            style={{
                              backgroundColor: chip.displayColor,
                              border: chip.displayColor === '#FFFFFF' ? '2px solid #ccc' : 'none',
                              flexShrink: 0,
                              width: '1.4rem',
                              height: '1.4rem',
                            }}
                          />
                          <span style={{ flex: 1, fontWeight: 600, fontSize: '0.85rem' }}>
                            {translateChipColor(chip.color, t)}
                          </span>
                          <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>
                            ×{chip.value}
                          </span>
                          <span
                            style={{
                              fontWeight: 700,
                              fontSize: '1.05rem',
                              minWidth: '2.5rem',
                              textAlign: 'center',
                              color: 'var(--text)',
                            }}
                            title={stackCount > 1 ? `(${stackCount}×)` : undefined}
                          >
                            {agg.aiCount}
                          </span>
                          <span
                            style={{
                              fontSize: '0.7rem',
                              color: 'var(--text-muted)',
                              minWidth: '2.5rem',
                              textAlign: 'end',
                              cursor: stack.provenance ? 'help' : 'default',
                              textDecoration: stack.provenance ? 'underline dotted' : 'none',
                              textUnderlineOffset: '2px',
                            }}
                            title={
                              stack.provenance
                                ? [
                                    stackCount > 1 ? `(${stackCount} stacks — showing first)` : null,
                                    `LLM: ${stack.provenance.llmCount ?? '—'}`,
                                    `→ ${stack.provenance.finalCount} (${stack.provenance.finalConfidence}%)`,
                                    stack.provenance.reasoning,
                                  ].filter(Boolean).join(' · ')
                                : `${agg.minConfidence}%${stackCount > 1 ? ` (min of ${stackCount})` : ''}`
                            }
                          >
                            {agg.minConfidence}%
                          </span>
                        </div>
                      );
                    })}
                  </div>

                  <div style={{
                    marginTop: '0.5rem',
                    padding: '0.5rem 0.75rem',
                    background: 'rgba(255,255,255,0.04)',
                    borderRadius: '8px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: '0.85rem',
                    fontWeight: 600,
                  }}>
                    <span>{t('settings.photoTest.totalEstimate')}</span>
                    <span>{photoTestResult.totalValue.toLocaleString()}</span>
                  </div>


                  <button
                    type="button"
                    onClick={() => {
                      // Reset prior photo before re-opening the camera.
                      setPhotoTestResult(null);
                      setPhotoTestPreview('');
                      setPhotoTestPreviewMime('image/jpeg');
                      setPhotoTestOpen(true);
                    }}
                    style={{
                      marginTop: '0.5rem',
                      width: '100%',
                      background: 'transparent',
                      border: '1px solid var(--border)',
                      color: 'var(--text)',
                      padding: '0.45rem',
                      borderRadius: '8px',
                      fontSize: '0.8rem',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    {t('settings.photoTest.tryAgain')}
                  </button>
                </div>
              )}

              {photoTestResult?.error && (
                <div style={{
                  marginTop: '0.75rem',
                  padding: '0.6rem 0.75rem',
                  background: 'rgba(239,68,68,0.1)',
                  border: '1px solid rgba(239,68,68,0.3)',
                  borderRadius: '8px',
                  fontSize: '0.8rem',
                  color: '#fca5a5',
                }}>
                  {photoTestResult.error}
                </div>
              )}
            </div>
          </>
        );
      })()}

      {/* v5.62.2 — chip-count accuracy dashboard removed.
          The card aggregated `chip_count_feedback` rows for the
          retired tuning loop. Since v5.62.0 the tuner is gone and
          the feedback rows have no consumer, so showing a "more
          samples = better tuning" pitch was misleading. The table
          + storage bucket remain in Supabase as harmless legacy;
          if tuning ever returns, restore this card from
          src/screens/SettingsScreen.tsx history (last v5.62.1). */}

      {/* Photo Test Modal — mounted at the SettingsScreen root so it
          works regardless of which tab is active (only the trigger
          button is gated by activeTab === 'ai' && isOwner). */}
      <PhotoCaptureModal
        isOpen={photoTestOpen}
        onClose={() => setPhotoTestOpen(false)}
        onResult={(result, previewBase64, previewMimeType) => {
          setPhotoTestResult(result);
          setPhotoTestPreview(previewBase64);
          setPhotoTestPreviewMime(previewMimeType);
        }}
        chipValues={chipValues}
        title={t('settings.photoTest.title')}
      />

      {/* Report Tab */}
      {activeTab === 'report' && (
        <>
          {/* Report Form */}
          <div className="card" style={{ padding: '1rem', marginBottom: '0.75rem' }}>
            {/* Category selector — its label doubles as the card's
                section heading, so we drop the redundant `דיווח על
                בעיה` h3 and promote the category label to h3-level
                size + centred alignment. */}
            <div style={{ marginBottom: '0.75rem' }}>
              <div style={{
                fontSize: '1rem', fontWeight: 600,
                color: 'var(--text)', textAlign: 'center',
                marginBottom: '0.6rem',
              }}>
                {t('report.categoryLabel')}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                {(['bug', 'feature', 'display', 'data', 'other'] as const).map(cat => {
                  const label = t(`report.categories.${cat}`);
                  const selected = reportCategory === cat;
                  return (
                    <button
                      key={cat}
                      onClick={() => setReportCategory(cat)}
                      style={{
                        padding: '0.45rem 0.7rem',
                        borderRadius: '20px',
                        fontSize: '0.78rem',
                        border: selected ? '1.5px solid #10b981' : '1px solid var(--border)',
                        background: selected ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface)',
                        color: selected ? '#34d399' : 'var(--text)',
                        cursor: 'pointer',
                        transition: 'all 0.15s ease',
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Description */}
            <textarea
              value={reportText}
              onChange={e => setReportText(e.target.value)}
              placeholder={t('report.descriptionPlaceholder')}
              maxLength={500}
              style={{
                width: '100%',
                minHeight: '100px',
                padding: '0.65rem',
                borderRadius: '10px',
                border: '1px solid var(--border)',
                background: 'var(--surface)',
                color: 'var(--text)',
                fontSize: '0.85rem',
                resize: 'vertical',
                fontFamily: 'inherit',
                direction: 'rtl',
                boxSizing: 'border-box',
              }}
            />
            <div style={{ textAlign: 'left', fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.2rem' }}>
              {reportText.length}/500
            </div>

            {/* Submit */}
            <button
              onClick={submitReport}
              disabled={!reportCategory || !reportText.trim() || reportSending}
              className="btn btn-primary"
              style={{
                width: '100%',
                marginTop: '0.5rem',
                padding: '0.6rem',
                fontSize: '0.9rem',
                borderRadius: '10px',
                opacity: (!reportCategory || !reportText.trim() || reportSending) ? 0.5 : 1,
              }}
            >
              {reportSending ? t('report.sending') : t('report.submit')}
            </button>

            {/* Result feedback */}
            {reportResult && (
              <div style={{
                marginTop: '0.5rem',
                padding: '0.5rem',
                borderRadius: '8px',
                textAlign: 'center',
                fontSize: '0.85rem',
                background: reportResult === 'success' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                color: reportResult === 'success' ? '#34d399' : '#ef4444',
              }}>
                {reportResult === 'success' ? t('report.success') : t('report.error')}
              </div>
            )}
          </div>

          {/* Report History — separated by status */}
          {(() => {
            const openReports = reports.filter(r => r.status === 'open');
            const resolvedReports = reports.filter(r => r.status !== 'open');

            const renderReport = (r: IssueReport) => (
              <div key={r.id} style={{
                padding: '0.55rem 0.7rem',
                borderRadius: '8px',
                background: 'var(--surface)',
                border: `1px solid ${r.status === 'open' ? 'rgba(245, 158, 11, 0.25)' : 'rgba(16, 185, 129, 0.2)'}`,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                  <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>
                    {t(`report.categories.${r.category}` as 'report.categories.bug')}
                  </span>
                  {(isOwner || isSuperAdmin) && (
                    <button
                      onClick={async () => {
                        const newStatus = r.status === 'open' ? 'resolved' : 'open';
                        await supabase.from('issue_reports').update({ status: newStatus }).eq('id', r.id);
                        loadReports();
                        if (newStatus === 'resolved' && r.reporter_user_id) {
                          try {
                            let reporterEmail: string | null = null;
                            // Try RPC (admin sees all emails)
                            const { data: members } = await supabase.rpc('fetch_group_members_with_email', { p_group_id: r.group_id });
                            const reporter = (members as { user_id: string; email: string | null }[] | null)
                              ?.find(m => m.user_id === r.reporter_user_id);
                            reporterEmail = reporter?.email || null;
                            // Fallback: if reporter is self, get own email
                            if (!reporterEmail) {
                              const { data: { user: me } } = await supabase.auth.getUser();
                              if (me?.id === r.reporter_user_id) reporterEmail = me.email || null;
                            }
                            if (reporterEmail) {
                              const catLabel = t(`report.categories.${r.category}` as 'report.categories.bug');
                              await proxySendBroadcastEmail({
                                to: reporterEmail,
                                subject: '✅ הדיווח שלך טופל — תודה!',
                                message: `היי 👋\n\nרק רצינו לעדכן שטיפלנו בדיווח שלך:\n\n📌 ${catLabel}\n${r.description || ''}\n\nתודה שעזרת לשפר את האפליקציה 🙏\n— ${authPlayerName || 'Poker Manager'}`,
                                senderName: 'Poker Manager',
                                kind: 'broadcast',
                              });
                            }
                          } catch (err) {
                            console.warn('[Report] Resolve email failed:', err);
                          }
                        }
                      }}
                      className="btn btn-sm"
                      style={{
                        padding: '0.15rem 0.5rem',
                        fontSize: '0.65rem',
                        borderRadius: '12px',
                        background: r.status === 'open' ? 'rgba(16, 185, 129, 0.12)' : 'rgba(245, 158, 11, 0.12)',
                        border: `1px solid ${r.status === 'open' ? 'rgba(16, 185, 129, 0.3)' : 'rgba(245, 158, 11, 0.3)'}`,
                        color: r.status === 'open' ? '#10b981' : '#f59e0b',
                        cursor: 'pointer',
                      }}
                    >
                      {r.status === 'open' ? '✓ ' + t('report.resolve') : '↩ ' + t('report.reopen')}
                    </button>
                  )}
                </div>
                {r.description && (
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
                    {r.description}
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.68rem', color: 'var(--text-secondary)' }}>
                  <span>
                    {(isOwner || isSuperAdmin) ? `${r.reporter_name} · ` : ''}
                    {isSuperAdmin && r.group_name ? `${r.group_name} · ` : ''}
                    {new Date(r.created_at).toLocaleDateString('he-IL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <button
                    onClick={() => setConfirmDialog({
                      title: t('settings.report.confirmDeleteTitle'),
                      body: t('settings.report.confirmDeleteBody'),
                      confirmLabel: t('common.delete'),
                      destructive: true,
                      onConfirm: async () => {
                        await supabase.from('issue_reports').delete().eq('id', r.id);
                        loadReports();
                      },
                    })}
                    style={{
                      background: 'none', border: 'none', color: '#ef4444',
                      fontSize: '0.65rem', cursor: 'pointer', padding: '0.1rem 0.25rem',
                      opacity: 0.7,
                    }}
                  >✕</button>
                </div>
              </div>
            );

            return (
              <>
                {/* Open Reports */}
                {openReports.length > 0 && (
                  <div className="card" style={{ padding: '0.75rem', marginBottom: '0.5rem' }}>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: '0.4rem',
                      marginBottom: '0.5rem', paddingBottom: '0.4rem',
                      borderBottom: '1px solid rgba(245, 158, 11, 0.2)',
                    }}>
                      <span style={{
                        width: '8px', height: '8px', borderRadius: '50%',
                        background: '#f59e0b', display: 'inline-block',
                      }} />
                      <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#f59e0b' }}>
                        {t('report.statusOpen')} ({openReports.length})
                      </span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                      {openReports.map(renderReport)}
                    </div>
                  </div>
                )}

                {/* Resolved Reports */}
                {resolvedReports.length > 0 && (
                  <div className="card" style={{ padding: '0.75rem' }}>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: '0.4rem',
                      marginBottom: '0.5rem', paddingBottom: '0.4rem',
                      borderBottom: '1px solid rgba(16, 185, 129, 0.2)',
                    }}>
                      <span style={{
                        width: '8px', height: '8px', borderRadius: '50%',
                        background: '#10b981', display: 'inline-block',
                      }} />
                      <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#10b981' }}>
                        {t('report.statusResolved')} ({resolvedReports.length})
                      </span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                      {resolvedReports.map(renderReport)}
                    </div>
                  </div>
                )}

                {reports.length === 0 && reportsLoaded && (
                  <div className="card" style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                    {t('report.noReports')}
                  </div>
                )}
              </>
            );
          })()}
        </>
      )}

      {/* About Tab */}
      {activeTab === 'about' && (
        <>
        {/* App Guide + Game Flow buttons */}
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
          <button
            onClick={() => setShowWelcome(true)}
            style={{
              flex: 1, padding: '0.7rem', borderRadius: '10px',
              border: '1px solid var(--border)', background: 'var(--surface)',
              color: 'var(--text)', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600,
              fontFamily: 'Outfit, sans-serif',
            }}
          >{t('settings.setup.aboutApp')}</button>
          <button
            onClick={() => setShowGameFlow(true)}
            style={{
              flex: 1, padding: '0.7rem', borderRadius: '10px',
              border: '1px solid var(--border)', background: 'var(--surface)',
              color: 'var(--text)', cursor: 'pointer', fontSize: '0.82rem', fontWeight: 600,
              fontFamily: 'Outfit, sans-serif',
            }}
          >{t('settings.setup.gameFlowBtn')}</button>
        </div>
        {/* Identity section */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: '0.4rem',
          marginBottom: '0.5rem', padding: '0.4rem 0.75rem',
          borderRadius: '8px', background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.06)',
        }}>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{t('settings.about.identifiedAs')}</span>
          <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text)' }}>{authPlayerName || '—'}</span>
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
                    border: language === lang ? '2px solid #10B981' : '1px solid var(--border)',
                    background: language === lang ? 'rgba(16,185,129,0.15)' : 'var(--surface)',
                    color: language === lang ? '#10B981' : 'var(--text)',
                    cursor: 'pointer',
                    fontWeight: language === lang ? 600 : 400,
                    fontSize: '0.875rem',
                    fontFamily: 'Outfit, sans-serif',
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
              color: 'var(--text-muted)', 
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
                {showFullChangelog ? t('settings.about.hideHistory') : t('settings.about.showHistory', { count: Math.min(CHANGELOG.length - 1, 9) })}
              </button>
            )}

            {/* Full changelog history (show up to 10 total) */}
            {showFullChangelog && CHANGELOG.slice(1, 10).map((entry, index) => (
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

      {/* Trivia Reports Tab - Super Admin Only */}
      {activeTab === 'triviaReports' && isSuperAdmin && <TriviaReportsTab />}

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
                    {/* Engagement row — only the signals that mean what
                        they say. Earlier iterations tried to surface
                        "Sessions 30d" (= activity_log row count, every
                        screen view), a derived games-per-month rate
                        (divides a possibly-bogus completed_game_count
                        by a created_at that can be reset on re-create),
                        and a "🔥 top screens" chip strip that just
                        reflected navigation patterns rather than feature
                        love. All three were removed (v5.61.1 / v5.61.3)
                        because they read as data-rich but were not
                        actionable. The chips below ARE actionable:
                        active/trainers this week, lifetime trainers. */}
                    <div style={{ display: 'flex', gap: '0.5rem', fontSize: '0.6rem', color: 'var(--text-muted)', flexWrap: 'wrap' }}>
                      {g.active_users_7d > 0 && (
                        <span>📊 <span style={{ color: '#10B981', fontWeight: 600 }}>{g.active_users_7d}</span> {language === 'he' ? 'פעילים השבוע' : 'active this week'}</span>
                      )}
                      {g.training_players > 0 && (
                        <span>🎯 <span style={{ color: '#f59e0b', fontWeight: 600 }}>{g.training_players}</span> {language === 'he' ? 'מתאמנים השבוע' : 'trainers this week'}</span>
                      )}
                      {(g.training_players_total ?? 0) > 0 && (
                        <span>🏆 <span style={{ color: '#818cf8', fontWeight: 600 }}>{g.training_players_total}</span> {language === 'he' ? 'מתאמנים בסה״כ' : 'lifetime trainers'}</span>
                      )}
                    </div>
                  </div>
                );
              };

              // Aggregations across the "Others" set. Members /
              // Players / Games are set sizes (each row belongs to
              // exactly one group), so summing is correct. We
              // deliberately do NOT sum active_users_7d /
              // training_players across groups — those are per-group
              // distinct-user counts and a single user active in two
              // groups would be double-counted, producing a number
              // that's neither "sum of per-group distincts" (because
              // it pretends to be a platform aggregate) nor "true
              // distinct across the set" (which we don't have the data
              // to compute client-side). Removed in v5.61.2 after live
              // data confirmed the drift (sum=17 vs true=16).
              const othersTotalMembers = otherGroups.reduce((s, g) => s + g.member_count, 0);
              const othersTotalPlayers = otherGroups.reduce((s, g) => s + (g.player_count ?? 0), 0);
              const othersTotalCompleted = otherGroups.reduce((s, g) => s + g.completed_game_count, 0);
              // Sort the Others list with active groups first, then by
              // most recent activity. Cold/never-played fall to the
              // bottom. Without this the list was implicit-creation-order
              // and a long-dormant group could push real activity off
              // the first screen.
              const otherGroupsSorted = [...otherGroups].sort((a, b) => {
                const aDate = a.last_game_date ? new Date(a.last_game_date).getTime() : 0;
                const bDate = b.last_game_date ? new Date(b.last_game_date).getTime() : 0;
                return bDate - aDate;
              });

              return (
                <>
                  {/* Platform Overview */}
                  {(() => {
                    // Most recent activity across the whole platform —
                    // surfaces "the last meaningful thing that happened
                    // anywhere" without a separate audit RPC. The
                    // active/dormant/cold pill row that used to live
                    // here was removed in v5.61.4 because at the user's
                    // scale (3 groups) it just restated what you can
                    // count from the list itself a few pixels below.
                    // Re-introduce the pills if/when the platform grows
                    // past ~10 groups and the list starts to scroll.
                    const allGroups = globalStats.groups;
                    const mostRecentGroup = allGroups
                      .filter(g => g.last_game_date)
                      .sort((a, b) => new Date(b.last_game_date!).getTime() - new Date(a.last_game_date!).getTime())[0];
                    const mostRecentDays = mostRecentGroup ? daysAgo(mostRecentGroup.last_game_date!) : null;

                    return (
                      <div style={{
                        padding: '0.65rem 0.75rem', borderRadius: '12px', marginBottom: '0.65rem',
                        background: 'linear-gradient(135deg, rgba(99,102,241,0.08), rgba(16,185,129,0.06))',
                        border: '1px solid rgba(99,102,241,0.15)',
                      }}>
                        <div style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          marginBottom: '0.4rem',
                        }}>
                          <div style={{ fontSize: '0.65rem', fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.02em' }}>
                            {t('settings.superAdmin.platformTotals')}
                          </div>
                          <button
                            onClick={loadGlobalStats}
                            disabled={globalLoading}
                            aria-label={language === 'he' ? 'רענן' : 'Refresh'}
                            style={{
                              fontSize: '0.6rem', fontWeight: 600,
                              padding: '0.2rem 0.5rem', borderRadius: '6px',
                              border: '1px solid rgba(99,102,241,0.25)',
                              background: 'rgba(99,102,241,0.08)',
                              color: '#818cf8',
                              cursor: globalLoading ? 'wait' : 'pointer',
                              fontFamily: 'Outfit, sans-serif',
                              opacity: globalLoading ? 0.5 : 1,
                              transition: 'all 0.2s',
                            }}
                          >
                            {globalLoading ? '⏳' : '🔄'} {language === 'he' ? 'רענן' : 'Refresh'}
                          </button>
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

                        {/* Engagement pulse — only the two signals
                            that map to distinct-people counts. The
                            previous "Sessions 30d" tile was raw
                            activity_log row count (every screen view),
                            which read as gibberish (e.g. 23k for one
                            small group). Removed in v5.61.1. */}
                        <div style={{
                          display: 'flex', justifyContent: 'space-between',
                          gap: '0.4rem', marginTop: '0.55rem',
                          paddingTop: '0.45rem', borderTop: '1px solid rgba(99,102,241,0.12)',
                          flexWrap: 'wrap',
                        }}>
                          {[
                            {
                              label: language === 'he' ? 'פעילים השבוע' : 'Active 7d',
                              value: globalStats.total_active_users_7d,
                              color: '#10B981', icon: '🟢',
                            },
                            {
                              label: language === 'he' ? 'מתאמנים השבוע' : 'Trainers 7d',
                              value: globalStats.total_training_players,
                              color: '#f59e0b', icon: '🎯',
                            },
                          ].map(p => (
                            <div key={p.label} style={{
                              flex: 1, minWidth: 0, textAlign: 'center',
                              padding: '0.3rem 0.2rem', borderRadius: '8px',
                              background: 'rgba(255,255,255,0.04)',
                            }}>
                              <div style={{ fontSize: '0.55rem', color: 'var(--text-muted)', marginBottom: '0.1rem' }}>
                                {p.icon} {p.label}
                              </div>
                              <div style={{ fontSize: '0.95rem', fontWeight: 700, color: p.color, lineHeight: 1 }}>
                                {p.value}
                              </div>
                            </div>
                          ))}
                        </div>

                        {/* Last-activity spotlight — answers "when was
                            the last meaningful thing on the platform?"
                            in one glance, useful even on small lists. */}
                        {globalStats.orphaned_groups.length > 0 && (
                          <div style={{
                            display: 'flex', flexWrap: 'wrap', gap: '0.3rem',
                            marginTop: '0.5rem',
                          }}>
                            <span style={{
                              fontSize: '0.55rem', fontWeight: 700,
                              padding: '0.15rem 0.4rem', borderRadius: '6px',
                              background: 'rgba(167,139,250,0.12)', color: '#a78bfa',
                            }}>
                              {language === 'he'
                                ? `⚠️ ${globalStats.orphaned_groups.length} יתומות`
                                : `⚠️ ${globalStats.orphaned_groups.length} orphaned`}
                            </span>
                          </div>
                        )}
                        {mostRecentGroup && mostRecentDays !== null && (
                          <div style={{
                            marginTop: '0.4rem', fontSize: '0.6rem',
                            color: 'var(--text-muted)',
                            display: 'flex', justifyContent: 'space-between',
                            alignItems: 'center', gap: '0.5rem',
                          }}>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {language === 'he'
                                ? `🕒 משחק אחרון: ${mostRecentGroup.name}`
                                : `🕒 Last game: ${mostRecentGroup.name}`}
                            </span>
                            <span style={{
                              color: mostRecentDays === 0 ? '#10B981' : mostRecentDays <= 7 ? '#10B981' : mostRecentDays <= 30 ? '#f59e0b' : '#ef4444',
                              fontWeight: 600, whiteSpace: 'nowrap',
                            }}>
                              {mostRecentDays === 0
                                ? (language === 'he' ? 'היום' : 'today')
                                : mostRecentDays === 1
                                  ? (language === 'he' ? 'אתמול' : 'yesterday')
                                  : language === 'he' ? `לפני ${mostRecentDays} ימים` : `${mostRecentDays}d ago`}
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })()}

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
                          {/* Aggregate totals — primary row of headline
                              numbers. Pulls double duty as a "what does
                              the rest of the platform look like?"
                              snapshot when scoping out new feature work. */}
                          <div style={{
                            display: 'flex', justifyContent: 'space-between', padding: '0.5rem 0.75rem',
                            borderRadius: '10px', background: 'var(--surface)', border: '1px solid var(--border)',
                            marginBottom: '0.4rem',
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

                          {/* Per-group engagement deliberately not
                              aggregated here — see the comment near
                              othersTotalMembers for why. The platform-
                              wide distinct counts are already shown in
                              the Platform Overview card above. */}

                          {/* Group list — click to expand. Sorted by
                              most-recent activity (see otherGroupsSorted)
                              so the live groups land at the top. */}
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                            {otherGroupsSorted.map(g => {
                              const status = getActivityStatus(g.last_game_date);
                              const isExpanded = expandedGroupId === g.id;
                              const lastDays = daysAgo(g.last_game_date);
                              const lastDaysLabel = lastDays === null
                                ? (language === 'he' ? 'אף פעם' : 'never')
                                : lastDays === 0
                                  ? (language === 'he' ? 'היום' : 'today')
                                  : lastDays === 1
                                    ? (language === 'he' ? 'אתמול' : 'yesterday')
                                    : language === 'he' ? `${lastDays}י׳` : `${lastDays}d`;
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
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.4rem' }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', minWidth: 0, flex: 1 }}>
                                        <span style={{ fontWeight: 700, fontSize: '0.9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.name}</span>
                                        <span style={{
                                          fontSize: '0.55rem', fontWeight: 600, padding: '0.1rem 0.3rem',
                                          borderRadius: '6px', background: status.bg, color: status.color,
                                          flexShrink: 0,
                                        }}>
                                          {status.label}
                                        </span>
                                        {g.training_enabled && (
                                          <span title={language === 'he' ? 'אימון פעיל' : 'Training enabled'} style={{
                                            fontSize: '0.55rem', fontWeight: 600, padding: '0.1rem 0.3rem',
                                            borderRadius: '6px', background: 'rgba(245,158,11,0.12)', color: '#f59e0b',
                                            flexShrink: 0,
                                          }}>
                                            🎯
                                          </span>
                                        )}
                                      </div>
                                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', transition: 'transform 0.2s', transform: isExpanded ? 'rotate(180deg)' : 'none', flexShrink: 0 }}>▼</span>
                                    </div>
                                    {/* Compact metrics strip — one
                                        scannable line that surfaces the
                                        same things you'd expand the card
                                        to learn. Owner on the start,
                                        member/game counts + active-this-
                                        week + last-game recency on the
                                        end. All four numeric tiles map
                                        to real distinct-people / row
                                        counts (not raw event volume). */}
                                    <div style={{
                                      display: 'flex', justifyContent: 'space-between',
                                      alignItems: 'center', gap: '0.5rem',
                                      fontSize: '0.62rem', color: 'var(--text-muted)',
                                      marginTop: '0.2rem',
                                    }}>
                                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }}>
                                        {g.owner_email || t('settings.superAdmin.noOwner')}
                                      </span>
                                      <span style={{
                                        display: 'flex', gap: '0.4rem', flexShrink: 0,
                                        fontSize: '0.6rem',
                                      }}>
                                        <span title={language === 'he' ? 'חברים' : 'Members'}>👥 {g.member_count}</span>
                                        <span title={language === 'he' ? 'משחקים' : 'Games'} style={{ color: g.completed_game_count > 0 ? '#10B981' : 'var(--text-muted)' }}>🃏 {g.completed_game_count}</span>
                                        {g.active_users_7d > 0 && (
                                          <span title={language === 'he' ? 'פעילים השבוע' : 'Active this week'} style={{ color: '#10B981' }}>
                                            🟢 {g.active_users_7d}
                                          </span>
                                        )}
                                        <span title={language === 'he' ? 'משחק אחרון' : 'Last game'} style={{ color: status.color }}>
                                          🕒 {lastDaysLabel}
                                        </span>
                                      </span>
                                    </div>
                                  </div>

                                  {isExpanded && (
                                    <div style={{ padding: '0 0.75rem 0.75rem' }}>
                                      {renderStatCards(g)}

                                      {/* Member roster — answers "who are
                                          these N people?" without leaving
                                          the screen. Loaded lazily per
                                          card; see groupMembersCache + the
                                          dedicated effect above. */}
                                      {(() => {
                                        const cacheEntry = groupMembersCache[g.id];
                                        if (cacheEntry === undefined || cacheEntry === 'loading') {
                                          return (
                                            <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', padding: '0.4rem 0', opacity: 0.7 }}>
                                              {language === 'he' ? 'טוען חברים…' : 'Loading members…'}
                                            </div>
                                          );
                                        }
                                        if (typeof cacheEntry === 'string' && cacheEntry.startsWith('error:')) {
                                          return (
                                            <div style={{ fontSize: '0.62rem', color: '#EF4444', padding: '0.4rem 0' }}>
                                              {language === 'he' ? 'טעינת חברים נכשלה' : 'Failed to load members'}: {cacheEntry.slice('error:'.length)}
                                            </div>
                                          );
                                        }
                                        const members = cacheEntry as GroupMemberDetail[];
                                        if (members.length === 0) {
                                          return (
                                            <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', padding: '0.4rem 0', opacity: 0.7 }}>
                                              {language === 'he' ? 'אין חברים' : 'No members'}
                                            </div>
                                          );
                                        }
                                        return (
                                          <div style={{ marginBottom: '0.5rem' }}>
                                            <div style={{
                                              fontSize: '0.55rem', fontWeight: 700, color: 'var(--text-muted)',
                                              textTransform: 'uppercase', letterSpacing: '0.05em',
                                              margin: '0.3rem 0 0.3rem',
                                            }}>
                                              👥 {language === 'he' ? `חברים (${members.length})` : `Members (${members.length})`}
                                            </div>
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                                              {members.map(m => {
                                                const joinedStr = new Date(m.joined_at).toLocaleDateString(
                                                  language === 'he' ? 'he-IL' : 'en-US',
                                                  { day: '2-digit', month: '2-digit', year: '2-digit' },
                                                );
                                                const display = m.linked_player_name
                                                  ?? m.email
                                                  ?? (language === 'he' ? '(ללא שם)' : '(no name)');
                                                return (
                                                  <div
                                                    key={m.user_id ?? `${m.email}-${m.joined_at}`}
                                                    style={{
                                                      display: 'flex', justifyContent: 'space-between',
                                                      alignItems: 'center', gap: '0.5rem',
                                                      padding: '0.3rem 0.45rem', borderRadius: '6px',
                                                      background: 'var(--background)',
                                                      border: '1px solid var(--border)',
                                                    }}
                                                  >
                                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.1rem', minWidth: 0 }}>
                                                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', minWidth: 0 }}>
                                                        <span style={{
                                                          fontSize: '0.5rem', fontWeight: 700, padding: '0.05rem 0.25rem',
                                                          borderRadius: '4px',
                                                          background: m.role === 'admin' ? 'rgba(99,102,241,0.18)' : 'rgba(100,100,100,0.18)',
                                                          color: m.role === 'admin' ? '#818cf8' : 'var(--text-muted)',
                                                          textTransform: 'uppercase', letterSpacing: '0.04em',
                                                        }}>
                                                          {m.role}
                                                        </span>
                                                        <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                          {display}
                                                        </span>
                                                      </div>
                                                      {m.email && m.linked_player_name && (
                                                        <span style={{ fontSize: '0.55rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                          {m.email}
                                                        </span>
                                                      )}
                                                    </div>
                                                    <span style={{ fontSize: '0.55rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', opacity: 0.8 }}>
                                                      {joinedStr}
                                                    </span>
                                                  </div>
                                                );
                                              })}
                                            </div>
                                          </div>
                                        );
                                      })()}

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
          {/* Push-howto hint — surfaced at the top of every member's
              Notifications tab so the path from "I want notifications" to
              "I'm actually receiving them" is one short sentence away.
              Phrased generically (no "in v5.43 we dropped X") because it's
              user-facing forever; the why is captured in the changelog. */}
          <p style={{
            margin: '0 0 0.75rem',
            fontSize: '0.78rem',
            color: 'var(--text-muted)',
            lineHeight: 1.55,
          }}>
            {t('settings.notifications.pushHowTo')}
          </p>
          {/* Email-disabled banner for non-owner groups. Visible to every
              member (not just admins) so anyone wondering why they don't
              receive email sees the explanation. Server-side enforcement
              lives in api/send-email.ts; this card is purely informational. */}
          {!isEmailEnabledForCurrentGroup() && (
            <div className="card" style={{
              marginBottom: '0.75rem',
              background: 'rgba(245, 158, 11, 0.08)',
              borderColor: 'rgba(245, 158, 11, 0.45)',
              borderStyle: 'solid',
              borderWidth: 1,
            }}>
              <h3 style={{ margin: '0 0 0.4rem', fontSize: '0.95rem', color: '#F59E0B', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <span>ℹ️</span>
                <span>{t('settings.notifications.emailDisabledTitle')}</span>
              </h3>
              <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text)', lineHeight: 1.55 }}>
                {t('settings.notifications.emailDisabledBody')}
              </p>
            </div>
          )}
          <div className="card" style={{ marginBottom: '0.75rem' }}>
            <h3 style={{ margin: '0 0 0.5rem', fontSize: '1rem' }}>
              🔔 {t('push.title')}
            </h3>
            <p style={{ margin: '0 0 0.5rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              {t('push.subscriberCount', { count: String(pushSubscriberCount) })}
            </p>
            {pushSubscribers.length > 0 && (() => {
              // Dedup chips by user_id (stable identity), not playerName
              // (mutable label). Using the name caused a single user to
              // render multiple chips after a rename — e.g. Sefi appeared
              // as both "ספי" and "ספי טורס". Falls back to name when
              // user_id is somehow missing.
              const seen = new Map<string, { name: string; icon: string }>();
              for (const s of pushSubscribers) {
                const key = s.userId || `name:${s.playerName || '?'}`;
                if (seen.has(key)) continue;
                const isFCM = s.endpoint.includes('fcm.googleapis.com') || s.endpoint.includes('firebase');
                const isMozilla = s.endpoint.includes('mozilla');
                seen.set(key, {
                  name: s.playerName || '?',
                  icon: isFCM ? '📱' : isMozilla ? '🦊' : '💻',
                });
              }
              return (
                <div style={{ margin: '0 0 1rem', display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                  {[...seen.entries()].map(([key, { name, icon }]) => (
                    <span key={key} style={{
                      fontSize: '0.7rem', padding: '0.2rem 0.5rem', borderRadius: '0.4rem',
                      background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.3)',
                      color: '#10B981',
                    }}>
                      {icon} {name}
                    </span>
                  ))}
                </div>
              );
            })()}

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
              <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                {([
                  { key: 'all' as const, label: language === 'he' ? 'כולם' : 'All' },
                  { key: 'permanent' as const, label: language === 'he' ? '⭐ קבועים' : '⭐ Permanent' },
                  { key: 'permanent_guest' as const, label: language === 'he' ? '🏠 אורחים' : '🏠 Guests' },
                  { key: 'guest' as const, label: language === 'he' ? '👤 מזדמנים' : '👤 Occasional' },
                  { key: 'select' as const, label: language === 'he' ? 'בחירה ידנית' : 'Manual' },
                ]).map(opt => (
                  <button
                    key={opt.key}
                    onClick={() => { setPushTarget(opt.key); if (opt.key !== 'select') setPushSelectedPlayers([]); }}
                    style={{
                      padding: '0.3rem 0.65rem', borderRadius: '0.5rem',
                      border: pushTarget === opt.key ? '2px solid #10B981' : '1px solid var(--border)',
                      background: pushTarget === opt.key ? 'rgba(16,185,129,0.15)' : 'var(--surface)',
                      color: 'var(--text)', cursor: 'pointer', fontSize: '0.75rem',
                      fontFamily: 'Outfit, sans-serif', fontWeight: pushTarget === opt.key ? 600 : 400,
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
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
              {(['permanent', 'permanent_guest', 'guest'] as const).includes(pushTarget as 'permanent' | 'permanent_guest' | 'guest') && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                  {players.filter(p => p.type === pushTarget).map(p => (
                    <span key={p.id} style={{
                      fontSize: '0.7rem', padding: '0.2rem 0.5rem', borderRadius: '0.4rem',
                      background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.3)',
                      color: '#10B981',
                    }}>
                      {p.name}
                    </span>
                  ))}
                  {players.filter(p => p.type === pushTarget).length === 0 && (
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                      {language === 'he' ? 'אין שחקנים מסוג זה' : 'No players of this type'}
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Send via toggle */}
            <div style={{ marginBottom: '0.75rem' }}>
              <label style={{ fontSize: '0.8rem', fontWeight: 600, display: 'block', marginBottom: '0.4rem' }}>
                {language === 'he' ? 'שליחה דרך' : 'Send via'}
              </label>
              <div style={{ display: 'flex', gap: '0.35rem' }}>
                {([
                  { key: 'push' as const, label: '🔔 Push', icon: '' },
                  { key: 'email' as const, label: '📧 Email', icon: '' },
                  { key: 'both' as const, label: language === 'he' ? '🔔+📧 שניהם' : '🔔+📧 Both', icon: '' },
                ]).map(opt => (
                  <button
                    key={opt.key}
                    onClick={() => setSendVia(opt.key)}
                    style={{
                      padding: '0.3rem 0.65rem', borderRadius: '0.5rem',
                      border: sendVia === opt.key ? '2px solid #10B981' : '1px solid var(--border)',
                      background: sendVia === opt.key ? 'rgba(16,185,129,0.15)' : 'var(--surface)',
                      color: 'var(--text)', cursor: 'pointer', fontSize: '0.75rem',
                      fontFamily: 'Outfit, sans-serif', fontWeight: sendVia === opt.key ? 600 : 400,
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Send button */}
            <button
              disabled={pushSending || !pushMsg.trim() || (pushTarget === 'select' && pushSelectedPlayers.length === 0) || (['permanent', 'permanent_guest', 'guest'].includes(pushTarget) && players.filter(p => p.type === pushTarget).length === 0)}
              onClick={async () => {
                const gid = getGroupId();
                if (!gid || !pushMsg.trim()) return;
                setPushSending(true);
                setPushResult(null);
                setPushDetails(null);
                try {
                  let targetNames: string[] | undefined;
                  if (pushTarget === 'select') {
                    targetNames = pushSelectedPlayers;
                  } else if (['permanent', 'permanent_guest', 'guest'].includes(pushTarget)) {
                    targetNames = players.filter(p => p.type === pushTarget).map(p => p.name);
                  }

                  const results: string[] = [];

                  if (sendVia === 'push' || sendVia === 'both') {
                    const result = await proxySendPush({
                      groupId: gid,
                      title: '🃏 Poker Manager',
                      body: pushMsg.trim(),
                      targetPlayerNames: targetNames,
                    });
                    if (result) {
                      if (result.details) setPushDetails(result.details);
                      results.push(`🔔 ${result.sent}/${result.total}`);
                    } else {
                      results.push(`🔔 ❌`);
                    }
                  }

                  if (sendVia === 'email' || sendVia === 'both') {
                    const targetSet = targetNames ? new Set(targetNames) : null;
                    const emails = activityMembers
                      .filter(m => m.email && (targetSet ? targetSet.has(m.playerName || '') : true))
                      .map(m => ({ email: m.email!, name: m.playerName || m.displayName || '' }));

                    let emailSent = 0;
                    let lastEmailErr: string | null = null;
                    for (const { email } of emails) {
                      const r = await proxySendBroadcastEmail({
                        to: email,
                        subject: `🃏 הודעה מ${authPlayerName || 'הקבוצה'}`,
                        message: pushMsg.trim(),
                        senderName: authPlayerName || 'Poker Manager',
                        kind: 'broadcast',
                      });
                      if (r.ok) emailSent++;
                      else if (r.error) lastEmailErr = r.error;
                    }
                    const failBadge = emailSent === emails.length ? '' : ` (${lastEmailErr || 'failed'})`;
                    results.push(`📧 ${emailSent}/${emails.length}${failBadge}`);
                  }

                  const allOk = results.every(r => !r.includes('❌') && !r.includes(' 0/'));
                  setPushResult(`${allOk ? '✅' : '⚠️'} ${results.join('  ')}`);
                  if (allOk) setPushMsg('');
                } catch (err) {
                  setPushResult(`❌ ${err instanceof Error ? err.message : 'Unknown error'}`);
                } finally {
                  setPushSending(false);
                  refreshPushSubscribers();
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
            {pushResult && !pushDetails?.length && (
              <p style={{
                marginTop: '0.5rem', fontSize: '0.8rem', textAlign: 'center',
                color: pushResult.includes('❌') || pushResult === t('push.error') ? '#EF4444' : '#10B981',
              }}>
                {pushResult}
              </p>
            )}

            {pushDetails && pushDetails.length > 0 && (() => {
              const statusLabel = (s: number | string): string => {
                if (typeof s === 'number') {
                  if (s === 410) return language === 'he' ? 'מנוי פג תוקף — המכשיר הוסר' : 'Subscription expired — device removed';
                  if (s === 404) return language === 'he' ? 'מנוי לא נמצא — המכשיר הוסר' : 'Subscription not found — device removed';
                  if (s === 403) return language === 'he' ? 'גישה נדחתה — בעיית הרשאות' : 'Access denied — permission issue';
                  if (s === 429) return language === 'he' ? 'יותר מדי בקשות — נסה שוב מאוחר יותר' : 'Too many requests — try again later';
                  if (s >= 500) return language === 'he' ? `שגיאת שרת (${s})` : `Server error (${s})`;
                  return `HTTP ${s}`;
                }
                if (s === 'removed') return language === 'he' ? 'מנוי לא תקין — הוסר' : 'Invalid subscription — removed';
                if (s.includes('AbortError') || s.includes('timeout')) return language === 'he' ? 'זמן תגובה חרג — הרשת איטית' : 'Timed out — slow network';
                if (s.includes('fetch') || s.includes('network') || s.includes('Failed')) return language === 'he' ? 'שגיאת רשת' : 'Network error';
                return s.slice(0, 40);
              };

              const byPlayer = new Map<string, { subs: { ok: boolean; status: number | string; type: string }[] }>();
              for (const d of pushDetails) {
                const existing = byPlayer.get(d.player);
                if (existing) {
                  existing.subs.push({ ok: d.ok, status: d.status, type: d.type });
                } else {
                  byPlayer.set(d.player, { subs: [{ ok: d.ok, status: d.status, type: d.type }] });
                }
              }

              const entries = Array.from(byPlayer.entries());
              const successCount = entries.filter(([, v]) => v.subs.some(s => s.ok)).length;
              const failCount = entries.length - successCount;

              return (
                <div style={{
                  marginTop: '0.75rem', borderRadius: '10px',
                  border: '1px solid var(--border)', overflow: 'hidden',
                }}>
                  <div style={{
                    padding: '0.5rem 0.75rem',
                    background: failCount === 0 ? 'rgba(16,185,129,0.08)' : 'rgba(239,68,68,0.06)',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    borderBottom: '1px solid var(--border)',
                  }}>
                    <span style={{ fontWeight: 600, fontSize: '0.8rem' }}>
                      {pushResult}
                    </span>
                    <div style={{ display: 'flex', gap: '0.5rem', fontSize: '0.75rem' }}>
                      {successCount > 0 && (
                        <span style={{ color: '#10B981' }}>✓ {successCount}</span>
                      )}
                      {failCount > 0 && (
                        <span style={{ color: '#EF4444' }}>✗ {failCount}</span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    {entries.map(([player, info], idx) => {
                      const anyOk = info.subs.some(s => s.ok);
                      const failedSubs = info.subs.filter(s => !s.ok);
                      return (
                        <div key={player} style={{
                          padding: '0.5rem 0.75rem',
                          borderBottom: idx < entries.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none',
                          display: 'flex', flexDirection: 'column', gap: '0.2rem',
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                            <span style={{
                              width: 18, height: 18, borderRadius: '50%', display: 'flex',
                              alignItems: 'center', justifyContent: 'center', fontSize: '0.6rem', flexShrink: 0,
                              background: anyOk ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
                              color: anyOk ? '#10B981' : '#EF4444',
                            }}>
                              {anyOk ? '✓' : '✗'}
                            </span>
                            <span style={{ fontWeight: 600, fontSize: '0.82rem', flex: 1 }}>{player}</span>
                            <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
                              {[...new Set(info.subs.map(s => s.type))].join(', ')}
                              {info.subs.length > 1 ? ` (${info.subs.length})` : ''}
                            </span>
                          </div>
                          {!anyOk && failedSubs.length > 0 && (
                            <div style={{ paddingRight: '1.6rem', fontSize: '0.72rem', color: '#EF4444', lineHeight: 1.4 }}>
                              {[...new Set(failedSubs.map(s => statusLabel(s.status)))].map((reason, ri) => (
                                <div key={ri}>{reason}</div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* Quick self-tests */}
            <div style={{ marginTop: '1rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border)', display: 'flex', gap: '0.4rem' }}>
              <button
                onClick={async () => {
                  const gid = getGroupId();
                  if (!gid || !authPlayerName) return;
                  setPushSending(true);
                  setPushResult(null);
                  setPushDetails(null);
                  try {
                    const pushRes = await proxySendPush({
                      groupId: gid,
                      title: '🧪 בדיקה',
                      body: language === 'he' ? 'הודעת בדיקה' : 'Test notification',
                      targetPlayerNames: [authPlayerName],
                    });
                    setPushResult(pushRes && pushRes.sent > 0 ? '🔔 ✅' : '🔔 ❌');
                  } catch (err) {
                    setPushResult(`🔔 ❌ ${err instanceof Error ? err.message : 'Error'}`);
                  } finally {
                    setPushSending(false);
                    refreshPushSubscribers();
                  }
                }}
                disabled={pushSending}
                style={{
                  flex: 1, padding: '0.45rem', borderRadius: '0.5rem',
                  border: '1px solid var(--border)', background: 'var(--surface)',
                  color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.75rem',
                  fontFamily: 'Outfit, sans-serif', fontWeight: 500,
                }}
              >
                🔔 {language === 'he' ? 'בדיקת התראה' : 'Test Push'}
              </button>
              <button
                onClick={async () => {
                  if (!authPlayerName) return;
                  setPushSending(true);
                  setPushResult(null);
                  setPushDetails(null);
                  try {
                    const { supabase: sb } = await import('../database/supabaseClient');
                    const { data: { user } } = await sb.auth.getUser();
                    if (!user?.email) { setPushResult('📧 ❌ No email'); return; }
                    const r = await proxySendBroadcastEmail({
                      to: user.email,
                      subject: '🧪 Poker Manager - בדיקה',
                      message: language === 'he' ? 'הודעת בדיקה' : 'Test message',
                      senderName: authPlayerName,
                      kind: 'preview',
                    });
                    setPushResult(r.ok ? '📧 ✅' : `📧 ❌ ${r.error || r.reason || 'failed'}`);
                  } catch (err) {
                    setPushResult(`📧 ❌ ${err instanceof Error ? err.message : 'Error'}`);
                  } finally {
                    setPushSending(false);
                  }
                }}
                disabled={pushSending}
                style={{
                  flex: 1, padding: '0.45rem', borderRadius: '0.5rem',
                  border: '1px solid var(--border)', background: 'var(--surface)',
                  color: 'var(--text-muted)', cursor: 'pointer', fontSize: '0.75rem',
                  fontFamily: 'Outfit, sans-serif', fontWeight: 500,
                }}
              >
                📧 {language === 'he' ? 'בדיקת מייל' : 'Test Email'}
              </button>
            </div>

          </div>

          {/* Schedule-email preview tester — super admin only, AND only on
              the owner group. On non-owner groups email is hard-blocked at
              the Edge Function, so we replace this card with a tiny lock
              notice instead of letting the super admin spam the disabled
              endpoint. The actual builders + synthetic poll fixture live in
              `previewScheduleEmails.ts`. */}
          {isSuperAdmin && !isEmailEnabledForCurrentGroup() && (
            <div className="card" style={{
              marginBottom: '0.75rem',
              background: 'rgba(107, 114, 128, 0.08)',
              borderStyle: 'dashed',
              borderColor: 'rgba(107, 114, 128, 0.4)',
              borderWidth: 1,
            }}>
              <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-muted)', textAlign: 'center' }}>
                {t('settings.notifications.emailLockedPreview')}
              </p>
            </div>
          )}
          {isSuperAdmin && isEmailEnabledForCurrentGroup() && (
            <div className="card" style={{ marginBottom: '0.75rem' }}>
              <h3 style={{ margin: '0 0 0.5rem', fontSize: '1rem' }}>
                {t('push.previewTitle')}
              </h3>
              <p style={{ margin: '0 0 0.85rem', fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
                {t('push.previewHelper')}
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', marginBottom: '0.75rem' }}>
                <label style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text)' }}>
                  {t('push.previewEmailLabel')}
                  <input
                    type="email"
                    value={emailPreviewTo}
                    onChange={(e) => { setEmailPreviewTo(e.target.value); setEmailPreviewResult(null); }}
                    disabled={emailPreviewSending}
                    dir="ltr"
                    style={{
                      width: '100%', marginTop: '0.3rem',
                      padding: '0.5rem 0.6rem', borderRadius: '0.5rem',
                      border: '1px solid var(--border)', background: 'var(--surface)',
                      color: 'var(--text)', fontSize: '0.85rem',
                      fontFamily: 'Outfit, sans-serif',
                    }}
                  />
                </label>

                <label style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--text)' }}>
                  {t('push.previewVariantLabel')}
                  <select
                    value={emailPreviewVariant}
                    onChange={(e) => { setEmailPreviewVariant(e.target.value as ScheduleEmailVariantId | 'all'); setEmailPreviewResult(null); }}
                    disabled={emailPreviewSending}
                    style={{
                      width: '100%', marginTop: '0.3rem',
                      padding: '0.5rem 0.6rem', borderRadius: '0.5rem',
                      border: '1px solid var(--border)',
                      background: '#1f2937', color: '#f9fafb',
                      fontSize: '0.85rem',
                      fontFamily: 'Outfit, sans-serif',
                    }}
                  >
                    <option value="all" style={{ background: '#1f2937', color: '#f9fafb' }}>
                      {t('push.previewVariantAll')}
                    </option>
                    {SCHEDULE_EMAIL_VARIANTS.map((id) => {
                      // Translation keys use camelCase but variant ids use
                      // kebab-case (matches the subject prefix). Map at the
                      // call site to keep both ergonomic.
                      const labelKey = ({
                        'invitation': 'push.previewVariant.invitation',
                        'expanded': 'push.previewVariant.expanded',
                        'confirmed-at-target': 'push.previewVariant.confirmedAtTarget',
                        'confirmed-below-target-yes': 'push.previewVariant.confirmedBelowTargetYes',
                        'confirmed-below-target-others': 'push.previewVariant.confirmedBelowTargetOthers',
                        'target-filled': 'push.previewVariant.targetFilled',
                        'cancellation': 'push.previewVariant.cancellation',
                        'vote-change': 'push.previewVariant.voteChange',
                      } as const)[id];
                      return (
                        <option key={id} value={id} style={{ background: '#1f2937', color: '#f9fafb' }}>
                          {t(labelKey)}
                        </option>
                      );
                    })}
                  </select>
                </label>
              </div>

              <button
                onClick={async () => {
                  const target = emailPreviewTo.trim();
                  if (!target || !target.includes('@') || target.length < 5) {
                    setEmailPreviewResult(`❌ ${t('push.previewInvalidEmail')}`);
                    return;
                  }
                  setEmailPreviewSending(true);
                  setEmailPreviewResult(null);
                  try {
                    if (emailPreviewVariant === 'all') {
                      const results = await previewAllScheduleEmails(target);
                      const sent = results.filter(r => r.ok).length;
                      const total = results.length;
                      const ok = sent === total;
                      // Surface the first underlying failure reason — for the
                      // "all" run we get N independent results and any one
                      // of them might fail for a different cause; showing
                      // the first one is enough to point the operator at
                      // the right place (env var, EmailJS quota, template).
                      const firstFail = results.find(r => !r.ok);
                      const reasonSuffix = firstFail?.error
                        ? ` — ${firstFail.error}${firstFail.status ? ` (${firstFail.status})` : ''}`
                        : '';
                      setEmailPreviewResult(`${ok ? '✓' : '⚠'} ${t('push.previewSentAll', { sent, total })}${reasonSuffix}`);
                    } else {
                      const r = await previewScheduleEmail(target, emailPreviewVariant);
                      if (r.ok) {
                        setEmailPreviewResult(`✓ ${t('push.previewSent', { variant: r.variant })}`);
                      } else {
                        // Show the actual server message + HTTP status so
                        // future failures self-explain. Falls back to the
                        // generic Hebrew label if the proxy didn't surface
                        // a string (shouldn't happen with the new contract,
                        // but defensive — UI should never render `undefined`).
                        const detail = r.error
                          ? `${r.error}${r.status ? ` (${r.status})` : ''}`
                          : t('push.previewError');
                        setEmailPreviewResult(`❌ ${t('push.previewError')} — ${detail}`);
                      }
                    }
                  } catch (err) {
                    console.error('previewScheduleEmail threw:', err);
                    setEmailPreviewResult(`❌ ${err instanceof Error ? err.message : t('push.previewError')}`);
                  } finally {
                    setEmailPreviewSending(false);
                  }
                }}
                disabled={emailPreviewSending}
                style={{
                  width: '100%',
                  padding: '0.65rem',
                  borderRadius: '0.5rem',
                  border: '1px solid rgba(168, 85, 247, 0.55)',
                  background: emailPreviewSending ? 'rgba(168, 85, 247, 0.1)' : 'rgba(168, 85, 247, 0.18)',
                  color: '#c084fc',
                  cursor: emailPreviewSending ? 'wait' : 'pointer',
                  fontSize: '0.85rem',
                  fontFamily: 'Outfit, sans-serif',
                  fontWeight: 600,
                  opacity: emailPreviewSending ? 0.7 : 1,
                }}
              >
                {emailPreviewSending
                  ? t('push.previewSending')
                  : emailPreviewVariant === 'all'
                    ? t('push.previewSendAll')
                    : t('push.previewSend')}
              </button>

              {emailPreviewResult && (
                <p style={{
                  margin: '0.6rem 0 0',
                  fontSize: '0.78rem',
                  color: emailPreviewResult.startsWith('❌') ? '#EF4444'
                    : emailPreviewResult.startsWith('⚠') ? '#F59E0B'
                    : '#10B981',
                }}>
                  {emailPreviewResult}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Activity Tab - Owner Only - Enhanced Dashboard */}
      {activeTab === 'activity' && isOwner && (() => {
        // Rolling 7-day window ending today (inclusive). Decision in 5.35.6:
        // calendar weeks (Sun→Sat) caused a "Sunday surprise" where opening
        // the tab on a Sunday morning showed near-empty stats because the
        // week had just reset. A rolling window always covers 7 days of
        // context regardless of what day it is — same shape every visit,
        // no artificial drops at week boundaries. Heatmap math is unaffected:
        // its rows aggregate by day-of-week, and a rolling 7-day window
        // contains exactly one of each day-of-week. Computed once here so
        // the header can expose the date range next to the title without
        // waiting for activityLog data to load.
        const _now = new Date();
        const _wkStart = (() => {
          const r = new Date(_now.getFullYear(), _now.getMonth(), _now.getDate());
          r.setDate(r.getDate() - 6); // [today-6 00:00, now] = 7 calendar days
          return r;
        })();
        const _sameMonth = _wkStart.getMonth() === _now.getMonth();
        const headerWeekRangeLabel = _sameMonth
          ? `${_wkStart.getDate()}–${_now.getDate()}.${_now.getMonth() + 1}`
          : `${_wkStart.getDate()}.${_wkStart.getMonth() + 1}–${_now.getDate()}.${_now.getMonth() + 1}`;
        return (
        <div>
          {/* Header */}
          <div style={{ marginBottom: '0.6rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
            <h2 style={{ margin: 0, fontSize: '1.1rem', color: 'var(--text)', display: 'inline-flex', alignItems: 'baseline', gap: '0.4rem', flexWrap: 'wrap' }}>
              {t('settings.activity.title')}
              <span style={{
                fontSize: '0.6rem', fontWeight: 500, color: 'var(--text-muted)',
                fontVariantNumeric: 'tabular-nums', direction: 'ltr', unicodeBidi: 'isolate',
              }}>
                📆 {headerWeekRangeLabel}
              </span>
            </h2>
            <button
              onClick={() => { if (!activityLoading) loadActivityLog(); }}
              disabled={activityLoading}
              style={{
                background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '8px',
                padding: '0.3rem 0.6rem', cursor: activityLoading ? 'default' : 'pointer',
                fontSize: '0.7rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.25rem',
                opacity: activityLoading ? 0.5 : 1,
              }}
            >
              🔄 {language === 'he' ? 'רענן' : 'Refresh'}
            </button>
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
            const thirtyDaysMs = 30 * oneDayMs;
            // Captured once per render. Used downstream in the expanded
            // card to identify the viewer's own live session row so we
            // can render its duration as live wall-clock elapsed time
            // instead of the throttled DB value. Null when the user
            // isn't currently tracking a session (e.g. mid-logout).
            const currentSessionTs = getCurrentSessionTimestamp();

            // Group by stable identity, not display name. Activity rows for the
            // same physical user can carry different `player_name` values across
            // sessions (e.g. an early row written before membership had loaded
            // has NULL, later rows have "ספי טורס") — grouping by name would
            // render those as TWO separate cards. user_id is the strongest
            // signal (collapses the same authenticated user across multiple
            // devices); device_id is the fallback for never-signed-in visitors.
            const keyOf = (e: ActivityLogEntry): string => e.userId || e.deviceId;

            // Pre-compute the canonical display name per group: the most recent
            // row that actually has a player_name wins. If no row in the group
            // ever carried a name, fall back to the manual device label or the
            // 8-char device id prefix (legacy behavior).
            //
            // BUT — and this is the bit that broke after migration 046 merged
            // ספי טורס into ספי — `entry.playerName` is a stamp captured at
            // session start, not a live join. If the user's *linked* player
            // record was renamed/merged later, the stamp lags forever (until
            // they open the app again under the new linked name). To make
            // the Activity tab reflect the *current* identity of each human
            // we override the stamped name with the live linked-player name
            // from `activityMembers` whenever we have a userId match. The
            // historical stamp survives only when no live link exists (user
            // left the group, or anonymous device-only session). See SQL
            // migration 049 for the matching one-shot heal of the stamps
            // themselves so other consumers of activity_log.player_name
            // (none today, but defensive) see the same truth.
            const liveNameByUserId = new Map<string, string>();
            for (const m of activityMembers) {
              if (m.userId && m.playerName) liveNameByUserId.set(m.userId, m.playerName);
            }
            const latestNamedByKey = new Map<string, { date: number; name: string }>();
            for (const entry of activityLog) {
              const stampedName = entry.userId ? (liveNameByUserId.get(entry.userId) || entry.playerName) : entry.playerName;
              if (!stampedName) continue;
              const k = keyOf(entry);
              const ts = new Date(entry.lastActive || entry.timestamp).getTime();
              const cur = latestNamedByKey.get(k);
              if (!cur || ts > cur.date) latestNamedByKey.set(k, { date: ts, name: stampedName });
            }
            const nameByKey = new Map<string, string>();
            for (const entry of activityLog) {
              const k = keyOf(entry);
              if (nameByKey.has(k)) continue;
              // Prefer the live linked name, then the latest stamped, then fallback.
              const liveName = entry.userId ? liveNameByUserId.get(entry.userId) : undefined;
              const named = latestNamedByKey.get(k);
              const fallback = deviceLabels[entry.deviceId] || entry.deviceId.slice(0, 8);
              nameByKey.set(k, liveName || named?.name || fallback);
            }
            const nameOf = (e: ActivityLogEntry): string => nameByKey.get(keyOf(e)) || e.deviceId.slice(0, 8);

            const userMap = new Map<string, ActivityLogEntry[]>();
            for (const entry of activityLog) {
              const k = keyOf(entry);
              const existing = userMap.get(k) || [];
              existing.push(entry);
              userMap.set(k, existing);
            }

            const liveUsers = Array.from(userMap.entries()).filter(([, entries]) =>
              entries.some(e => new Date(e.lastActive || e.timestamp) > tenMinAgo)
            );



            const todayStr = now.toDateString();
            const todayUniqueKeys = new Set(
              activityLog.filter(e => {
                const lastTime = new Date(e.lastActive || e.timestamp);
                return lastTime.toDateString() === todayStr;
              }).map(keyOf)
            );
            const todayUniqueUsers = todayUniqueKeys.size;
            const todayUniqueNames = Array.from(todayUniqueKeys).map(k => nameByKey.get(k) || k.slice(0, 8));

            // Rolling 7-day window ending now. Mirrors `_wkStart` above —
            // they're computed twice because the section header renders
            // before activityLog has loaded and needs its own copy of the
            // boundary, then the body needs the same boundary tied to the
            // post-load `now`. Keep both in sync if the semantics ever
            // change again. The variable name `currentWeekStart` is kept
            // for diff hygiene across all the consumers below — it really
            // means "start of the rolling 7-day window" now.
            const startOfRolling7d = (d: Date): Date => {
              const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
              r.setDate(r.getDate() - 6);
              return r;
            };
            const currentWeekStart = startOfRolling7d(now);

            const weekUserDays = new Set(
              activityLog
                .filter(e => new Date(e.lastActive || e.timestamp).getTime() >= currentWeekStart.getTime())
                .map(e => {
                  const day = new Date(e.lastActive || e.timestamp).toDateString();
                  return `${keyOf(e)}|${day}`;
                })
            );
            const weekSessions = weekUserDays.size;

            const mostActiveThisWeek = (() => {
              const userDays = new Map<string, Set<string>>();
              const userSessions = new Map<string, number>();
              for (const e of activityLog) {
                const lastTime = new Date(e.lastActive || e.timestamp);
                if (lastTime.getTime() < currentWeekStart.getTime()) continue;
                const k = keyOf(e);
                if (!userDays.has(k)) userDays.set(k, new Set());
                userDays.get(k)!.add(lastTime.toDateString());
                userSessions.set(k, (userSessions.get(k) || 0) + 1);
              }
              let bestKey = '';
              let max = 0;
              for (const [k, days] of userDays) { if (days.size > max) { max = days.size; bestKey = k; } }
              if (!bestKey) return null;
              return { name: nameByKey.get(bestKey) || bestKey.slice(0, 8), days: max, sessions: userSessions.get(bestKey) || 0 };
            })();

            const lastVisitor = (() => {
              if (activityLog.length === 0) return null;
              const latest = activityLog.reduce((a, b) =>
                new Date(b.lastActive || b.timestamp) > new Date(a.lastActive || a.timestamp) ? b : a
              );
              const name = nameOf(latest);
              const ago = Math.floor((now.getTime() - new Date(latest.lastActive || latest.timestamp).getTime()) / 60000);
              const agoLabel = ago < 60 ? `${ago}${language === 'he' ? ' דק׳' : 'm'}` : `${Math.floor(ago / 60)}${language === 'he' ? ' שע׳' : 'h'}`;
              return { name, agoLabel };
            })();


            // Heatmap shares the same rolling 7-day window as the summary
            // stats and the weekly trend's current bar — one source of truth
            // for the dashboard's "recent activity" view. With a 7-day window
            // each `dayNames[]` row gets exactly one calendar day's data,
            // which is what makes the heatmap legible.
            const heatmap: number[][] = Array.from({ length: 7 }, () => [0, 0, 0, 0]);
            const heatmapSeen = new Set<string>();
            for (const entry of activityLog) {
              const d = new Date(entry.lastActive || entry.timestamp);
              if (d.getTime() < currentWeekStart.getTime()) continue;
              const slot = d.getHours() < 6 ? 0 : d.getHours() < 12 ? 1 : d.getHours() < 18 ? 2 : 3;
              const dedupKey = `${keyOf(entry)}|${d.toDateString()}|${slot}`;
              if (heatmapSeen.has(dedupKey)) continue;
              heatmapSeen.add(dedupKey);
              heatmap[d.getDay()][slot]++;
            }
            const maxHeat = Math.max(1, ...heatmap.flat());
            const dayNames = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
            // slotNames[i] correspond to indices 0/1/2/3 = 0-6 / 6-12 / 12-18
            // / 18-24 respectively. Slot 0 is "לילה" (per user preference);
            // the previous "Sun night already happened?" confusion is now
            // resolved by (a) the chronological column order below — slot 0
            // sits at the start-of-day end of the row, not the end-of-day
            // end — and (b) the live `todaySlotIdx` border that visibly
            // marks "you are here" so readers can tell which cells are
            // past, present, and future without parsing the label.
            const slotNames = ['לילה', 'בוקר', 'צהריים', 'ערב'];
            const slotHours = ['0–6', '6–12', '12–18', '18–24'];
            // Display columns chronologically: 0-6 → 6-12 → 12-18 → 18-24.
            // Old order [1, 2, 3, 0] put the 0-6 column at the visual end
            // (left in RTL), which made it look like the LATEST part of
            // the day even though it's actually the EARLIEST. Combined with
            // a rolling 7-day window where today's row only has data for
            // hours that have elapsed, the old layout produced an empty
            // "evening" cell sandwiched between filled "noon" and filled
            // "0-6" cells — visually nonsensical. The chronological order
            // makes today's row fill from the right (in RTL) toward the
            // left as the day progresses, with empty cells at the
            // not-yet-happened end.
            const slotDisplayOrder = [0, 1, 2, 3];
            // "You are here" marker: which (day-of-week, slot) cell the
            // user's clock is currently sitting inside. Used by the cell
            // renderer to draw a high-contrast border on the live cell so
            // readers can immediately tell "this is now; cells before it
            // chronologically are past, cells after are not-yet-happened".
            // Mirrors the same hour-bucketing used when populating the
            // heatmap so the marker can never disagree with the data.
            const _hourNow = now.getHours();
            const todaySlotIdx = _hourNow < 6 ? 0 : _hourNow < 12 ? 1 : _hourNow < 18 ? 2 : 3;
            const todayDayIdx = now.getDay();

            const userStats = Array.from(userMap.entries()).map(([groupKey, entries]) => {
              const last30 = entries.filter(e => now.getTime() - new Date(e.lastActive || e.timestamp).getTime() < thirtyDaysMs);
              const uniqueDays30d = new Set(last30.map(e => new Date(e.lastActive || e.timestamp).toDateString())).size;
              const totalMin = last30.reduce((s, e) => s + (e.sessionDuration || 0), 0);
              const latest = entries.reduce((a, b) => new Date(b.lastActive || b.timestamp) > new Date(a.lastActive || a.timestamp) ? b : a);
              const latestDate = new Date(latest.lastActive || latest.timestamp);
              const latestDay = new Date(latestDate.getFullYear(), latestDate.getMonth(), latestDate.getDate());
              const todayDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
              const daysSince = Math.round((todayDay.getTime() - latestDay.getTime()) / oneDayMs);
              const name = nameByKey.get(groupKey) || groupKey.slice(0, 8);
              const member = activityMembers.find(m => m.playerName === name || m.displayName === name);
              const memberRole = member?.role || latest.role || 'member';
              return { groupKey, name, sessions30d: uniqueDays30d, avgDuration: totalMin, daysSince, latestEntry: latest, latestTs: latestDate.getTime(), entries, memberRole };
              // Sort by the *full* timestamp of each member's most recent
              // activity, not the day-rounded `daysSince`. The previous
              // `daysSince`-only ordering bucketed everyone who visited
              // today together (and likewise for yesterday, two days ago,
              // …) so within each bucket the rendered order followed the
              // arbitrary `userMap` iteration order rather than real
              // recency. Descending `latestTs` puts the member who was
              // last active 5 minutes ago above the one who logged in
              // 8 hours ago, which is what "recent entrance" actually
              // means at the per-row level.
            }).sort((a, b) => b.latestTs - a.latestTs);



            // Trend buckets: 3 rolling 7-day windows ending today, today-7,
            // and today-14. Each bucket is a half-open interval
            // [bucketStart, bucketStart+7d) so consecutive buckets never
            // double-count an entry on the boundary. The most-recent bucket's
            // label end is capped at "now" so the range reads e.g.
            // "27.4–3.5" rather than running into tomorrow's date.
            const weeklyTrend = Array.from({ length: 3 }, (_, i) => {
              const weekStart = new Date(currentWeekStart);
              weekStart.setDate(weekStart.getDate() - i * 7);
              const nextWeekStart = new Date(weekStart);
              nextWeekStart.setDate(nextWeekStart.getDate() + 7);
              const isCurrentBucket = i === 0;
              const labelEnd = isCurrentBucket
                ? now
                : new Date(nextWeekStart.getTime() - oneDayMs);
              const entries = activityLog.filter(e => {
                const ts = new Date(e.lastActive || e.timestamp).getTime();
                return ts >= weekStart.getTime() && ts < nextWeekStart.getTime();
              });
              const users = new Set(entries.map(keyOf));
              const userDays = new Set(entries.map(e => {
                const day = new Date(e.lastActive || e.timestamp).toDateString();
                return `${keyOf(e)}|${day}`;
              }));
              return { start: weekStart, end: labelEnd, users: users.size, sessions: userDays.size };
            }).reverse();

            // Bars represent total visits (user-days) — the "real" weekly activity
            // total — not unique-user counts. Unique-user count is still shown in the
            // bottom legend so both metrics are visible.
            const trendMaxSessions = Math.max(1, ...weeklyTrend.map(w => w.sessions));
            const thisWeekUsers = weeklyTrend[weeklyTrend.length - 1]?.users ?? 0;
            const thisWeekSessions = weeklyTrend[weeklyTrend.length - 1]?.sessions ?? 0;
            const lastWeekSessions = weeklyTrend[weeklyTrend.length - 2]?.sessions ?? 0;
            const sessionsDelta = thisWeekSessions - lastWeekSessions;

            // Date-range label for the rolling 7-day window, reused by any
            // sub-card that wants to clarify which 7 days the stats cover.
            // Always spans 7 calendar days so the label is always a real
            // range — the same-day collapse from 5.35.5 (when the window
            // could degenerate to a single day on a Sunday) is no longer
            // needed.
            const currentWeekRangeLabel = (() => {
              const s = currentWeekStart;
              const e = now;
              const sameMonth = s.getMonth() === e.getMonth();
              return sameMonth
                ? `${s.getDate()}–${e.getDate()}.${e.getMonth() + 1}`
                : `${s.getDate()}.${s.getMonth() + 1}–${e.getDate()}.${e.getMonth() + 1}`;
            })();

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
                      {liveUsers.map(([groupKey, entries]) => {
                        const latest = entries.reduce((a, b) => new Date(b.lastActive || b.timestamp) > new Date(a.lastActive || a.timestamp) ? b : a);
                        const screen = latest.screensVisited.length > 0 ? latest.screensVisited[latest.screensVisited.length - 1] : '';
                        const name = nameByKey.get(groupKey) || groupKey.slice(0, 8);
                        return (
                          <span key={groupKey} style={{
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
                    { label: t('settings.activity.mostActive'), value: mostActiveThisWeek?.name || '—', sub: mostActiveThisWeek ? `${mostActiveThisWeek.days} ${language === 'he' ? 'ימים' : 'days'} · ${mostActiveThisWeek.sessions} ${language === 'he' ? 'כניסות' : 'visits'}` : undefined, icon: '🏆', color: mostActiveThisWeek ? '#f59e0b' : 'var(--text-muted)', small: true },
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

                {/* Rolling 7-day coverage caption — clarifies which dates
                    every "weekly" stat below (and the heatmap) is computed
                    over. The "(נע)" / "(rolling)" hint signals to readers
                    that this isn't a Sun→Sat calendar week — it follows
                    them as days pass, always covering the latest 7 days. */}
                <div style={{
                  fontSize: '0.55rem', color: 'var(--text-muted)',
                  marginBottom: '0.5rem', marginTop: '-0.25rem',
                  display: 'flex', alignItems: 'center', gap: '0.3rem',
                }}>
                  <span>📆 {language === 'he' ? '7 ימים אחרונים' : 'Last 7 days'}:</span>
                  <span style={{ fontVariantNumeric: 'tabular-nums', direction: 'ltr', unicodeBidi: 'isolate' }}>
                    {currentWeekRangeLabel}
                  </span>
                  <span style={{ opacity: 0.7 }}>
                    ({language === 'he' ? 'נע' : 'rolling'})
                  </span>
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
                    {sessionsDelta !== 0 && (
                      <span style={{
                        fontSize: '0.62rem', fontWeight: 600, padding: '0.1rem 0.4rem',
                        borderRadius: '8px',
                        background: sessionsDelta > 0 ? 'rgba(16, 185, 129, 0.12)' : 'rgba(239, 68, 68, 0.12)',
                        color: sessionsDelta > 0 ? '#10B981' : '#ef4444',
                      }}>
                        {sessionsDelta > 0 ? '▲' : '▼'} {Math.abs(sessionsDelta)} {t('settings.activity.vsLastWeek')}
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: '4px', height: '64px' }}>
                    {weeklyTrend.map((week, i) => {
                      const barH = Math.max(4, (week.sessions / trendMaxSessions) * 44);
                      const isCurrent = i === weeklyTrend.length - 1;
                      const startD = week.start.getDate();
                      const startM = week.start.getMonth() + 1;
                      const endD = week.end.getDate();
                      const endM = week.end.getMonth() + 1;
                      const sameMonth = startM === endM;
                      const rangeLabel = sameMonth
                        ? `${startD}–${endD}.${endM}`
                        : `${startD}.${startM}–${endD}.${endM}`;
                      const tooltipFull = `${week.start.toLocaleDateString(language === 'he' ? 'he-IL' : 'en-US', { day: 'numeric', month: 'numeric' })} – ${week.end.toLocaleDateString(language === 'he' ? 'he-IL' : 'en-US', { day: 'numeric', month: 'numeric' })}`;
                      return (
                        <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px', height: '100%', justifyContent: 'flex-end' }}>
                          <span style={{
                            fontSize: '0.65rem',
                            fontWeight: isCurrent ? 700 : 600,
                            color: isCurrent ? 'var(--primary)' : 'var(--text)',
                            lineHeight: 1,
                            fontVariantNumeric: 'tabular-nums',
                          }}>
                            {week.sessions}
                          </span>
                          <div
                            title={`${tooltipFull}: ${week.users} ${t('settings.activity.users')}, ${week.sessions} ${t('settings.activity.sessionsLabel')}`}
                            style={{
                              width: '100%', height: `${barH}px`, borderRadius: '3px',
                              background: isCurrent
                                ? 'linear-gradient(180deg, #6366f1, #818cf8)'
                                : `rgba(99, 102, 241, ${0.2 + (week.sessions / trendMaxSessions) * 0.4})`,
                              transition: 'height 0.3s ease',
                            }}
                          />
                          <span style={{ fontSize: '0.5rem', color: 'var(--text-muted)', lineHeight: 1, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', direction: 'ltr', unicodeBidi: 'isolate' }}>
                            {rangeLabel}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.35rem', fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                    <span>{t('settings.activity.trendUsers')}: {thisWeekUsers}</span>
                    <span>{t('settings.activity.trendSessions')}: {thisWeekSessions}</span>
                  </div>
                </div>



                {/* Training Engagement */}
                {trainingPlayers.length > 0 && (() => {
                  const now = new Date();
                  // Sunday-anchored window — same semantics as the weekly trend
                  // and "ביקורים השבוע" stat above so all "this week" numbers in
                  // this card cover the exact same date range.
                  const weekStartMs = currentWeekStart.getTime();
                  const trainers = trainingPlayers.map(p => {
                    type TSession = TrainingPlayerData['sessions'][0];
                    const weekSessions = p.sessions.filter((s: TSession) => new Date(s.date).getTime() >= weekStartMs);
                    const weekQs = weekSessions.reduce((sum: number, s: TSession) => sum + s.questionsAnswered, 0);
                    const lastSession = p.sessions.length > 0
                      ? p.sessions.reduce((latest: TSession, s: TSession) => new Date(s.date) > new Date(latest.date) ? s : latest)
                      : null;
                    return { name: p.playerName, totalSessions: p.sessions.length, weekQs, accuracy: p.accuracy, lastSession };
                  }).sort((a, b) => {
                    // Most recent activity first. Players who never trained sink to the bottom.
                    const aTime = a.lastSession ? new Date(a.lastSession.date).getTime() : 0;
                    const bTime = b.lastSession ? new Date(b.lastSession.date).getTime() : 0;
                    if (bTime !== aTime) return bTime - aTime;
                    // Tiebreaker: more questions this week first, then by name for stability.
                    if (b.weekQs !== a.weekQs) return b.weekQs - a.weekQs;
                    return a.name.localeCompare(b.name);
                  });

                  const activeThisWeek = trainers.filter(t => t.weekQs > 0);

                  return (
                    <div style={{
                      padding: '0.5rem 0.65rem', borderRadius: '10px', marginBottom: '0.5rem',
                      background: 'var(--surface)', border: '1px solid var(--border)',
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem', gap: '0.4rem' }}>
                        <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)', display: 'inline-flex', alignItems: 'baseline', gap: '0.35rem', flexWrap: 'wrap' }}>
                          🎯 {language === 'he' ? 'אימון ב-7 ימים אחרונים' : 'Training (last 7d)'}
                          <span style={{ fontSize: '0.55rem', fontWeight: 500, color: 'var(--text-muted)', opacity: 0.8, fontVariantNumeric: 'tabular-nums', direction: 'ltr', unicodeBidi: 'isolate' }}>
                            {currentWeekRangeLabel}
                          </span>
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
                                {isActive && `${Math.round(tr.accuracy)}% · ${tr.totalSessions} ${language === 'he' ? 'סשנים' : 'sess'}`}
                                {tr.lastSession && (() => {
                                  const d = new Date(tr.lastSession.date);
                                  const dateLabel = `${d.getDate()}/${d.getMonth() + 1} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                                  return (
                                    <Fragment>
                                      {isActive ? ' · ' : ''}
                                      <span dir="ltr" style={{ unicodeBidi: 'isolate' }}>{dateLabel}</span>
                                    </Fragment>
                                  );
                                })()}
                              </span>
                              <span style={{
                                fontSize: '0.6rem', fontWeight: 600, textAlign: 'end',
                                color: isActive ? '#10B981' : 'var(--text-muted)',
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
                {userStats.map((user) => {
                  const isExpanded = expandedUser === user.groupKey;
                  const roleInfo = getRoleInfo(user.memberRole);
                  const isActive = user.daysSince === 0;
                  const borderColor = isActive ? 'rgba(16, 185, 129, 0.4)' : user.daysSince > 7 ? 'rgba(239, 68, 68, 0.3)' : 'var(--border)';
                  return (
                    <div key={user.groupKey}>
                      <div
                        onClick={() => setExpandedUser(isExpanded ? null : user.groupKey)}
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

                      </div>

                      {/* Expanded: activity details */}
                      {isExpanded && (
                        <div style={{
                          padding: '0.5rem 0.65rem', borderRadius: '0 0 10px 10px',
                          background: 'var(--surface)', marginBottom: '0.4rem',
                          border: `1px solid ${borderColor}`, borderTop: '1px solid var(--border)',
                        }}>
                          {(() => {
                            const lastEntry = user.latestEntry;
                            const lastDate = new Date(lastEntry.lastActive || lastEntry.timestamp);
                            const lastStr = lastDate.toLocaleDateString(language === 'he' ? 'he-IL' : 'en-US', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
                            // Stored DB value. For OTHER users / OTHER devices
                            // this is always what we render — we don't have a
                            // live clock for someone else's session.
                            const storedMin = lastEntry.sessionDuration || 0;
                            // For the viewer's OWN current session we override
                            // with wall-clock elapsed time since the row was
                            // INSERTed. The DB value is throttled (5-min
                            // interval + 2-min cooldown), so a user parked on
                            // this very screen for 6 minutes would otherwise
                            // see "< 1 דק׳" until the next push catches up.
                            // We identify "this is my live session" by
                            // matching the row's timestamp against the
                            // in-process `currentSessionTimestamp` —
                            // bulletproof because that variable holds the
                            // exact value the row was INSERTed with and
                            // resets only on logout / session end. The
                            // 60-second ticker re-runs this every minute so
                            // the value advances on its own. max(stored,
                            // live) ensures we never shrink a value already
                            // persisted.
                            const isOwnLiveSession =
                              lastEntry.deviceId === ownDeviceId
                              && currentSessionTs !== null
                              && lastEntry.timestamp === currentSessionTs;
                            const liveMin = isOwnLiveSession
                              ? (now.getTime() - new Date(lastEntry.timestamp).getTime()) / 60000
                              : 0;
                            const lastSessionMin = Math.max(storedMin, liveMin);
                            const lastSessionScreens = (lastEntry.screensVisited || []).slice();

                            // Format minutes for display. `sessionDuration` is
                            // rounded to whole minutes upstream
                            // (`activityLogger.ts:269`) so we can't render
                            // sub-minute precision — for very short sessions
                            // we show "< 1 דק׳" / "< 1 min" instead of "0
                            // דק׳" which would imply the visit didn't happen.
                            const formatDuration = (min: number): string => {
                              if (min < 1) return language === 'he' ? '< 1 דק׳' : '< 1 min';
                              if (min < 60) return `${Math.round(min)} ${language === 'he' ? 'דק׳' : 'min'}`;
                              // Multi-hour totals get an "Xh Ym" form so a
                              // power user with 547 minutes reads as "9 שע׳
                              // 7 דק׳" instead of an opaque "547 דק׳".
                              const h = Math.floor(min / 60);
                              const m = Math.round(min % 60);
                              const hLbl = language === 'he' ? 'שע׳' : 'h';
                              const mLbl = language === 'he' ? 'דק׳' : 'm';
                              return m > 0 ? `${h} ${hLbl} ${m} ${mLbl}` : `${h} ${hLbl}`;
                            };

                            // Stats in two scopes:
                            //   - last 30 days (recent activity window)
                            //   - all-time (total time invested in the app)
                            // Previously this section labelled itself
                            // "30 days" but the totals were summed across
                            // `user.entries` (all-time), so a member with
                            // 91 lifetime sessions and 8 minutes in the
                            // current month read as "91 sessions in the
                            // last 30 days" — wrong. We compute both
                            // windows explicitly below and surface them
                            // under separate headings so each number
                            // means what its label says.
                            const last30 = user.entries.filter(e =>
                              now.getTime() - new Date(e.lastActive || e.timestamp).getTime() < thirtyDaysMs,
                            );
                            const sessions30d = last30.length;
                            const min30d = last30.reduce((s, e) => s + (e.sessionDuration || 0), 0);
                            const days30d = user.sessions30d; // unique active days, last 30
                            const screenCounts30d: Record<string, number> = {};
                            for (const e of last30) {
                              for (const s of e.screensVisited) {
                                screenCounts30d[s] = (screenCounts30d[s] || 0) + 1;
                              }
                            }
                            const screens30dSorted = Object.entries(screenCounts30d).sort((a, b) => b[1] - a[1]);

                            const totalSessions = user.entries.length;
                            const totalMin = user.entries.reduce((s, e) => s + (e.sessionDuration || 0), 0);
                            const totalUniqueDays = new Set(
                              user.entries.map(e => new Date(e.lastActive || e.timestamp).toDateString()),
                            ).size;

                            const sectionLabelStyle: React.CSSProperties = {
                              fontSize: '0.58rem', fontWeight: 700, color: 'var(--text-muted)',
                              textTransform: 'uppercase', letterSpacing: '0.05em',
                            };
                            const statRowStyle: React.CSSProperties = {
                              display: 'flex', gap: '0.6rem', fontSize: '0.62rem',
                              color: 'var(--text-muted)', flexWrap: 'wrap',
                            };
                            const chipStyle: React.CSSProperties = {
                              fontSize: '0.62rem', padding: '0.15rem 0.4rem', borderRadius: '10px',
                              background: 'var(--background)', color: 'var(--text-muted)',
                              border: '1px solid var(--border)',
                            };

                            return (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
                                {/* ── Last session ── */}
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                                  <div style={sectionLabelStyle}>
                                    🎯 {language === 'he' ? 'ביקור אחרון' : 'Last visit'}
                                  </div>
                                  <div style={statRowStyle}>
                                    <span>🕐 {lastStr}</span>
                                    {/* Always render the duration, even for
                                        sub-1-minute sessions. The previous
                                        `>= 1` gate hid useful information
                                        ("they bounced after 30 seconds")
                                        and made the row feel inconsistent
                                        across members. */}
                                    <span>⏱️ {formatDuration(lastSessionMin)}</span>
                                  </div>
                                  {lastSessionScreens.length > 0 ? (
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                                      {lastSessionScreens.map((screen, idx) => (
                                        <span key={`${screen}-${idx}`} style={chipStyle}>{screen}</span>
                                      ))}
                                    </div>
                                  ) : (
                                    <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', opacity: 0.6 }}>
                                      {language === 'he' ? 'אין פירוט מסכים לביקור הזה' : 'No screen data for this visit'}
                                    </div>
                                  )}
                                </div>

                                {/* divider */}
                                <div style={{ height: '1px', background: 'var(--border)', opacity: 0.7 }} />

                                {/* ── Last 30 days ── all numbers in this
                                     block are scoped to the last 30 days,
                                     including the screens chip cloud. */}
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                                  <div style={sectionLabelStyle}>
                                    📈 {language === 'he' ? '30 ימים אחרונים' : 'Last 30 days'}
                                  </div>
                                  <div style={statRowStyle}>
                                    <span>📊 {days30d} {language === 'he' ? 'ימים' : 'days'}</span>
                                    <span>🔁 {sessions30d} {language === 'he' ? 'סשנים' : 'sessions'}</span>
                                    <span>⏱️ {formatDuration(min30d)}</span>
                                  </div>
                                  {screens30dSorted.length > 0 ? (
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.25rem' }}>
                                      {screens30dSorted.map(([screen, count]) => (
                                        <span key={screen} style={chipStyle}>
                                          {screen} <span style={{ color: '#818cf8', fontWeight: 600 }}>×{count}</span>
                                        </span>
                                      ))}
                                    </div>
                                  ) : (
                                    <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)', textAlign: 'center', opacity: 0.6 }}>
                                      {language === 'he' ? 'אין פעילות ב-30 הימים האחרונים' : 'No activity in the last 30 days'}
                                    </div>
                                  )}
                                </div>

                                {/* divider */}
                                <div style={{ height: '1px', background: 'var(--border)', opacity: 0.7 }} />

                                {/* ── All-time totals ── single line: a
                                     member's lifetime engagement with the
                                     app at a glance. Surfaces the "time
                                     spent" headline that was previously
                                     hidden inside the 30-day block under a
                                     mislabelled total. */}
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                                  <div style={sectionLabelStyle}>
                                    🌍 {language === 'he' ? 'כל הזמן' : 'All time'}
                                  </div>
                                  <div style={statRowStyle}>
                                    <span>📊 {totalUniqueDays} {language === 'he' ? 'ימים' : 'days'}</span>
                                    <span>🔁 {totalSessions} {language === 'he' ? 'סשנים' : 'sessions'}</span>
                                    <span>
                                      ⏱️ {formatDuration(totalMin)}
                                      {' '}
                                      <span style={{ opacity: 0.7 }}>
                                        ({language === 'he' ? 'באפליקציה' : 'on app'})
                                      </span>
                                    </span>
                                  </div>
                                </div>
                              </div>
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
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.35rem', gap: '0.5rem' }}>
                    <div style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                      {t('settings.activity.heatmapTitle')}
                    </div>
                    <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums', direction: 'ltr', unicodeBidi: 'isolate' }}>
                      {currentWeekRangeLabel}
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'auto repeat(4, 1fr)', gap: '2px', fontSize: '0.6rem' }}>
                    <div />
                    {slotDisplayOrder.map(si => (
                      <div key={si} style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.55rem', paddingBottom: '2px', lineHeight: 1.2 }}>
                        <div>{slotNames[si]}</div>
                        <div style={{ fontSize: '0.5rem', opacity: 0.7, fontVariantNumeric: 'tabular-nums', direction: 'ltr', unicodeBidi: 'isolate' }}>{slotHours[si]}</div>
                      </div>
                    ))}
                    {dayNames.map((day, di) => {
                      const isToday = di === todayDayIdx;
                      return (
                        <>
                          <div key={`label-${di}`} style={{
                            color: isToday ? 'var(--primary)' : 'var(--text-muted)',
                            fontWeight: isToday ? 700 : 400,
                            paddingLeft: '2px', display: 'flex', alignItems: 'center',
                          }}>
                            {day}{isToday ? '·' : ''}
                          </div>
                          {slotDisplayOrder.map(si => {
                            const count = heatmap[di][si];
                            const intensity = count / maxHeat;
                            const showHighContrast = intensity > 0.55;
                            // "You are here" marker — a thicker, brighter
                            // outline on the single cell representing
                            // today + the current 6-hour slot. Wins over
                            // the row-level `isToday` outline below via
                            // CSS specificity (set on the same `outline`
                            // property).
                            const isLiveCell = isToday && si === todaySlotIdx;
                            const cellOutline = isLiveCell
                              ? '2px solid rgba(99,102,241,0.95)'
                              : isToday
                                ? '1px solid rgba(99,102,241,0.35)'
                                : 'none';
                            return (
                              <div
                                key={`${di}-${si}`}
                                title={`${dayNames[di]} ${slotNames[si]}: ${count} sessions${isLiveCell ? ' (now)' : ''}`}
                                style={{
                                  height: '18px', borderRadius: '3px',
                                  background: count === 0
                                    ? 'var(--background)'
                                    : `rgba(99, 102, 241, ${0.15 + intensity * 0.7})`,
                                  outline: cellOutline,
                                  outlineOffset: isLiveCell ? '1px' : 0,
                                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                                  fontSize: '0.55rem', fontWeight: 600, lineHeight: 1,
                                  fontVariantNumeric: 'tabular-nums',
                                  color: count === 0
                                    ? 'transparent'
                                    : showHighContrast ? '#fff' : 'var(--text)',
                                }}
                              >
                                {count > 0 ? count : ''}
                              </div>
                            );
                          })}
                        </>
                      );
                    })}
                  </div>
                </div>

                <div style={{ marginTop: '0.5rem', fontSize: '0.65rem', color: 'var(--text-muted)', textAlign: 'center' }}>
                  {userStats.length} {language === 'he' ? 'משתמשים מזוהים' : 'identified users'}
                </div>
              </div>
            );
          })()}
        </div>
        );
      })()}

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
              if (!result.error) {
                multiGroup.triggerGroupWizard();
                setGroupSetupMode(null);
              }
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
              { icon: '📅', text: t('settings.setup.welcomeSchedule') },
              { icon: '🎮', text: t('settings.setup.welcomeNewGame') },
              { icon: '📡', text: t('settings.setup.welcomeLive') },
              { icon: '🧮', text: t('settings.setup.welcomeEnd') },
              { icon: '💰', text: t('settings.setup.welcomeSettlements') },
              { icon: '📜', text: t('settings.setup.welcomeHistory') },
              { icon: '📊', text: t('settings.setup.welcomeStats') },
              { icon: '📈', text: t('settings.setup.welcomeGraphs') },
              { icon: '🏋️', text: t('settings.setup.welcomeTraining') },
              { icon: '🧠', text: t('settings.setup.welcomeTrivia') },
              { icon: '📤', text: t('settings.setup.welcomeShare') },
            ].map((item, i, arr) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'flex-start', gap: '0.6rem',
                padding: '0.5rem 0', borderBottom: i < arr.length - 1 ? '1px solid var(--border)' : 'none',
              }}>
                <span style={{ fontSize: '1.1rem', flexShrink: 0 }}>{item.icon}</span>
                <span style={{ fontSize: '0.78rem', color: 'var(--text)', lineHeight: 1.5 }}>{item.text}</span>
              </div>
            ))}
            <div style={{
              fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.75rem',
              padding: '0.5rem 0.6rem', borderRadius: '8px',
              background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.15)',
              lineHeight: 1.5,
            }}>{t('settings.setup.aiDisclaimer')}</div>
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
              <button
                onClick={() => {
                  const items = [
                    { icon: '📅', key: 'settings.setup.welcomeSchedule' },
                    { icon: '🎮', key: 'settings.setup.welcomeNewGame' },
                    { icon: '📡', key: 'settings.setup.welcomeLive' },
                    { icon: '🧮', key: 'settings.setup.welcomeEnd' },
                    { icon: '💰', key: 'settings.setup.welcomeSettlements' },
                    { icon: '📜', key: 'settings.setup.welcomeHistory' },
                    { icon: '📊', key: 'settings.setup.welcomeStats' },
                    { icon: '📈', key: 'settings.setup.welcomeGraphs' },
                    { icon: '🏋️', key: 'settings.setup.welcomeTraining' },
                    { icon: '🧠', key: 'settings.setup.welcomeTrivia' },
                    { icon: '📤', key: 'settings.setup.welcomeShare' },
                  ] as const;
                  const lines = items.map(i => `${i.icon} ${t(i.key)}`).join('\n');
                  shareToWhatsApp(`${t('settings.setup.welcomeTitle')}\n${t('settings.setup.welcomeSubtitle')}\n\n${lines}`);
                }}
                style={{
                  flex: 1, padding: '0.7rem', borderRadius: '10px',
                  border: '1px solid rgba(37,211,102,0.3)', background: 'rgba(37,211,102,0.1)',
                  color: '#25D366', cursor: 'pointer',
                  fontSize: '0.8rem', fontWeight: 700, fontFamily: 'Outfit, sans-serif',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem',
                }}
              >
                <span style={{ fontSize: '1rem' }}>📲</span> WhatsApp
              </button>
              <button
                onClick={() => setShowWelcome(false)}
                style={{
                  flex: 1, padding: '0.7rem', borderRadius: '10px',
                  border: 'none', background: '#10B981', color: '#fff', cursor: 'pointer',
                  fontSize: '0.9rem', fontWeight: 700, fontFamily: 'Outfit, sans-serif',
                }}
              >{t('settings.setup.welcomeClose')}</button>
            </div>
          </div>
        </div>
      )}
      {/* Game Flow Modal */}
      {showGameFlow && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.6)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '1rem',
        }} onClick={() => setShowGameFlow(false)}>
          <div style={{
            background: 'var(--surface)', borderRadius: '14px', padding: '1rem 1rem 0.75rem',
            maxWidth: '400px', width: '100%',
            border: '1px solid var(--border)',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ textAlign: 'center', marginBottom: '0.6rem' }}>
              <div style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text)' }}>🎮 {t('settings.setup.gameFlowTitle')}</div>
              <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>{t('settings.setup.gameFlowSubtitle')}</div>
            </div>
            {[
              { step: 1, icon: '📅', color: '#0ea5e9', title: t('settings.setup.gameFlowScheduleTitle'), desc: t('settings.setup.gameFlowScheduleDesc') },
              { step: 2, icon: '🃏', color: '#6366f1', title: t('settings.setup.gameFlowStep1Title'), desc: t('settings.setup.gameFlowStep1Desc') },
              { step: 3, icon: '📡', color: '#f59e0b', title: t('settings.setup.gameFlowStep2Title'), desc: t('settings.setup.gameFlowStep2Desc') },
              { step: 4, icon: '🧮', color: '#ef4444', title: t('settings.setup.gameFlowStep3Title'), desc: t('settings.setup.gameFlowStep3Desc') },
              { step: 5, icon: '🏆', color: '#10B981', title: t('settings.setup.gameFlowStep4Title'), desc: t('settings.setup.gameFlowStep4Desc') },
              { step: 6, icon: '📊', color: '#a78bfa', title: t('settings.setup.gameFlowStep5Title'), desc: t('settings.setup.gameFlowStep5Desc') },
            ].map((s, i, arr) => (
              <div key={s.step}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '0.5rem',
                  padding: '0.4rem 0.45rem', borderRadius: '8px',
                  background: `${s.color}10`, border: `1px solid ${s.color}25`,
                }}>
                  <div style={{
                    width: '26px', height: '26px', borderRadius: '50%',
                    background: `${s.color}20`, border: `2px solid ${s.color}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '0.7rem', fontWeight: 800, color: s.color, flexShrink: 0,
                  }}>
                    {s.step}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                      <span style={{ fontSize: '0.8rem' }}>{s.icon}</span>
                      <span style={{ fontSize: '0.78rem', fontWeight: 700, color: s.color }}>{s.title}</span>
                    </div>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>{s.desc}</div>
                  </div>
                </div>
                {i < arr.length - 1 && (
                  <div style={{ display: 'flex', justifyContent: 'center', padding: '0.1rem 0' }}>
                    <div style={{ width: '2px', height: '10px', background: 'var(--border)', borderRadius: '1px' }} />
                  </div>
                )}
              </div>
            ))}
            <div style={{
              fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: '0.5rem',
              padding: '0.35rem 0.5rem', borderRadius: '6px',
              background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.12)',
              lineHeight: 1.4,
            }}>{t('settings.setup.aiDisclaimer')}</div>
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
              <button
                onClick={() => {
                  const steps = [
                    { step: 1, icon: '📅', titleKey: 'settings.setup.gameFlowScheduleTitle', descKey: 'settings.setup.gameFlowScheduleDesc' },
                    { step: 2, icon: '🃏', titleKey: 'settings.setup.gameFlowStep1Title', descKey: 'settings.setup.gameFlowStep1Desc' },
                    { step: 3, icon: '📡', titleKey: 'settings.setup.gameFlowStep2Title', descKey: 'settings.setup.gameFlowStep2Desc' },
                    { step: 4, icon: '🧮', titleKey: 'settings.setup.gameFlowStep3Title', descKey: 'settings.setup.gameFlowStep3Desc' },
                    { step: 5, icon: '🏆', titleKey: 'settings.setup.gameFlowStep4Title', descKey: 'settings.setup.gameFlowStep4Desc' },
                    { step: 6, icon: '📊', titleKey: 'settings.setup.gameFlowStep5Title', descKey: 'settings.setup.gameFlowStep5Desc' },
                  ] as const;
                  const lines = steps.map(s => `${s.icon} ${s.step}. ${t(s.titleKey)}\n   ${t(s.descKey)}`).join('\n\n');
                  shareToWhatsApp(`🎮 ${t('settings.setup.gameFlowTitle')}\n${t('settings.setup.gameFlowSubtitle')}\n\n${lines}`);
                }}
                style={{
                  flex: 1, padding: '0.5rem', borderRadius: '8px',
                  border: '1px solid rgba(37,211,102,0.3)', background: 'rgba(37,211,102,0.1)',
                  color: '#25D366', cursor: 'pointer',
                  fontSize: '0.75rem', fontWeight: 700, fontFamily: 'Outfit, sans-serif',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem',
                }}
              >
                <span style={{ fontSize: '0.95rem' }}>📲</span> WhatsApp
              </button>
              <button
                onClick={() => setShowGameFlow(false)}
                style={{
                  flex: 1, padding: '0.5rem', borderRadius: '8px',
                  border: 'none', background: '#10B981', color: '#fff', cursor: 'pointer',
                  fontSize: '0.8rem', fontWeight: 700, fontFamily: 'Outfit, sans-serif',
                }}
              >{t('settings.setup.gameFlowClose')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Shared confirmation modal — replaces the legacy native confirm()
          dialogs across this screen so destructive actions (backup
          restore, AI usage reset/delete, issue-report delete) match the
          rest of the app's premium chrome. */}
      {confirmDialog && (
        <div className="modal-overlay" onClick={() => !confirmDialogBusy && setConfirmDialog(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <div className="modal-header">
              <h3 className="modal-title">{confirmDialog.title}</h3>
              <button
                className="modal-close"
                onClick={() => setConfirmDialog(null)}
                disabled={confirmDialogBusy}
                aria-label={t('common.close')}
              >×</button>
            </div>
            <p style={{
              fontSize: '0.9rem', marginBottom: '1rem', lineHeight: 1.5,
              color: 'var(--text)', whiteSpace: 'pre-line',
            }}>
              {confirmDialog.body}
            </p>
            <div className="actions">
              <button
                className="btn btn-secondary"
                onClick={() => setConfirmDialog(null)}
                disabled={confirmDialogBusy}
              >
                {t('common.cancel')}
              </button>
              <button
                className="btn"
                onClick={runConfirmDialog}
                disabled={confirmDialogBusy}
                style={{
                  background: confirmDialog.destructive ? '#ef4444' : '#10b981',
                  color: '#fff', fontWeight: 600,
                  opacity: confirmDialogBusy ? 0.7 : 1,
                  cursor: confirmDialogBusy ? 'wait' : 'pointer',
                }}
              >
                {confirmDialogBusy ? '...' : confirmDialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SettingsScreen;

