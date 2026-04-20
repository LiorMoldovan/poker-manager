import { Component, useEffect, useState, useRef, useCallback, createContext, useContext } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { PermissionRole } from './types';
import { hasPermission } from './permissions';
import { logActivity, updateSessionActivity, getScreenName, resetSession } from './utils/activityLogger';
import { useSupabaseAuth } from './hooks/useSupabaseAuth';
import { LanguageProvider, useTranslation } from './i18n';
import { initSupabaseCache, isCacheForGroup, resetCache, subscribeToRealtime, unsubscribeFromRealtime, fetchNotifications, getCachedNotifications, markNotificationRead, getUnreadNotificationCount, savePushSubscription } from './database/supabaseCache';
import { fixChipCountIds } from './database/migrateToSupabase';
import Navigation from './components/Navigation';
import GroupSwitcher from './components/GroupSwitcher';
import AuthScreen from './screens/AuthScreen';
import GroupSetupScreen from './screens/GroupSetupScreen';
import NewGameScreen from './screens/NewGameScreen';
import LiveGameScreen from './screens/LiveGameScreen';
import ChipEntryScreen from './screens/ChipEntryScreen';
import GameSummaryScreen from './screens/GameSummaryScreen';
import HistoryScreen from './screens/HistoryScreen';

import StatisticsScreen from './screens/StatisticsScreen';
import SettingsScreen from './screens/SettingsScreen';
import GraphsScreen from './screens/GraphsScreen';
import TrainingScreen from './screens/TrainingScreen';
import TrainingHandScreen from './screens/TrainingHandScreen';
import QuickTrainingScreen from './screens/QuickTrainingScreen';
import SharedTrainingScreen from './screens/SharedTrainingScreen';
import SharedQuickPlayScreen from './screens/SharedQuickPlayScreen';

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info.componentStack);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          minHeight: '100vh', padding: '2rem', textAlign: 'center',
          background: 'var(--background, #0f0f1a)', color: 'var(--text, #e2e8f0)',
          fontFamily: 'Outfit, sans-serif', direction: 'rtl',
        }}>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>⚠️</div>
          <h1 style={{ fontSize: '1.3rem', fontWeight: 700, marginBottom: '0.5rem' }}>משהו השתבש</h1>
          <p style={{ fontSize: '0.9rem', color: 'var(--text-muted, #94a3b8)', marginBottom: '1.5rem' }}>
            אירעה שגיאה לא צפויה. לחצו לרענון.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '0.75rem 2rem', borderRadius: '10px', border: 'none', cursor: 'pointer',
              background: 'var(--primary, #6366f1)', color: '#fff', fontSize: '1rem', fontWeight: 600,
              fontFamily: 'Outfit, sans-serif',
            }}
          >
            🔄 רענון
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

interface GroupManagementFns {
  groupName: string;
  inviteCode: string | null;
  currentUserId: string;
  fetchMembers: () => Promise<import('./hooks/useSupabaseAuth').GroupMember[]>;
  updateMemberRole: (userId: string, role: string) => Promise<{ error: unknown }>;
  removeMember: (userId: string) => Promise<{ error: unknown }>;
  transferOwnership: (userId: string) => Promise<{ error: unknown }>;
  regenerateInviteCode: () => Promise<{ data: string | null; error: unknown }>;
  unlinkMemberPlayer: (userId: string) => Promise<{ error: unknown }>;
  createPlayerInvite: (playerId: string) => Promise<{ data: { invite_code: string; player_name: string; already_existed: boolean } | null; error: unknown }>;
  addMemberByEmail: (email: string, playerId?: string) => Promise<{ data: { user_id: string; display_name: string; player_id: string | null } | null; error: unknown }>;
}

interface PermissionContextType {
  role: PermissionRole | null;
  isOwner: boolean;
  isSuperAdmin: boolean;
  trainingEnabled: boolean;
  playerName: string | null;
  hasPermission: (permission: Parameters<typeof hasPermission>[1]) => boolean;
  signOut: () => void;
  groupMgmt?: GroupManagementFns;
  multiGroup?: {
    memberships: import('./hooks/useSupabaseAuth').GroupMembership[];
    switchGroup: (groupId: string) => void;
    createGroup: (name: string) => Promise<{ data: unknown; error: unknown }>;
    joinGroup: (code: string) => Promise<{ data: unknown; error: unknown }>;
    joinByPlayerInvite: (code: string) => Promise<{ data: unknown; error: unknown }>;
    refreshMembership: () => void;
    userEmail: string;
  };
}

const PermissionContext = createContext<PermissionContextType>({
  role: null,
  isOwner: false,
  isSuperAdmin: false,
  trainingEnabled: false,
  playerName: null,
  hasPermission: () => false,
  signOut: () => {},
});

export const LEGACY_NAME_CORRECTIONS: Record<string, string> = {
  'פבל': 'פאבל',
  'ארז': 'חרדון',
};

export const usePermissions = () => useContext(PermissionContext);

export const useOnlineStatus = () => {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);
  return online;
};

function PlayerPicker({ onSelfCreate, userDisplayName }: {
  onSelfCreate: (name: string) => Promise<{ data: unknown; error: unknown }>;
  userDisplayName: string;
}) {
  const { t } = useTranslation();
  const [newName, setNewName] = useState(userDisplayName);
  const [error, setError] = useState('');

  const handleSelfCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed) { setError(t('picker.emptyName')); return; }
    setError('');
    const { error: err } = await onSelfCreate(trimmed);
    if (err) {
      const msg = (err as { message?: string })?.message || '';
      setError(msg.includes('duplicate') ? t('picker.duplicate') : msg || t('picker.createError'));
    }
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--background)', direction: 'rtl',
    }}>
      <div style={{
        background: 'var(--surface)', borderRadius: '16px', padding: '1.5rem',
        maxWidth: '400px', width: '90%', boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
      }}>
        <div style={{ textAlign: 'center', marginBottom: '1rem' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>🃏</div>
          <h2 style={{ color: 'var(--text)', marginBottom: '0.25rem' }}>{t('picker.welcome')}</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            {t('picker.subtitle')}
          </p>
        </div>
        <input
          type="text"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          placeholder={t('picker.placeholder')}
          autoFocus
          dir="rtl"
          style={{
            width: '100%', padding: '0.75rem 1rem', fontSize: '1rem', borderRadius: '10px',
            border: '2px solid var(--border)', background: 'var(--background)', color: 'var(--text)',
            marginBottom: '0.75rem', boxSizing: 'border-box', outline: 'none', fontFamily: 'Outfit, sans-serif',
          }}
          onKeyDown={e => { if (e.key === 'Enter') handleSelfCreate(); }}
        />
        {error && <p style={{ color: '#ef4444', fontSize: '0.85rem', textAlign: 'center', marginBottom: '0.5rem' }}>{error}</p>}
        <button
          onClick={handleSelfCreate}
          style={{
            width: '100%', padding: '0.75rem', fontSize: '1rem', fontWeight: 600, borderRadius: '10px',
            border: 'none', background: 'var(--primary)', color: 'white', cursor: 'pointer',
            fontFamily: 'Outfit, sans-serif',
          }}
        >
          {t('picker.continue')}
        </button>
      </div>
    </div>
  );
}

function SupabaseApp() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const auth = useSupabaseAuth();
  const [dataReady, setDataReady] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [addMemberPrompt, setAddMemberPrompt] = useState<string | null>(null);
  const [addMemberStatus, setAddMemberStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [addMemberMsg, setAddMemberMsg] = useState('');
  const [notifCount, setNotifCount] = useState(0);
  const [showNotifPanel, setShowNotifPanel] = useState(false);

  const groupId = auth.membership?.groupId ?? null;
  const role = auth.membership?.role ?? null;
  const isOwner = auth.membership?.isOwner ?? false;
  const isSuperAdmin = auth.isSuperAdmin;
  const trainingEnabled = auth.membership?.trainingEnabled ?? false;
  const playerName = auth.membership?.playerName ?? null;

  useEffect(() => {
    if (!groupId) return;
    const win = window as unknown as Record<string, unknown>;
    win.fixChipCounts = () => fixChipCountIds(groupId);
    return () => { delete win.fixChipCounts; };
  }, [groupId]);

  // Initialize Supabase cache once we have a group
  useEffect(() => {
    if (!groupId) return;
    if (isCacheForGroup(groupId)) { setDataReady(true); return; }
    setDataReady(false);
    setDataError(null);
    resetCache();
    const targetGroupId = groupId;
    initSupabaseCache(targetGroupId)
      .then(() => {
        if (!isCacheForGroup(targetGroupId)) return;
        setDataReady(true);
        subscribeToRealtime();
      })
      .catch(err => {
        if (!isCacheForGroup(targetGroupId)) return;
        console.error('Failed to load data from Supabase:', err);
        setDataError(t('app.cloudError'));
      });
    return () => unsubscribeFromRealtime();
  }, [groupId]);

  // Notification polling
  useEffect(() => {
    if (!dataReady) return;
    const load = () => fetchNotifications().then(() => setNotifCount(getUnreadNotificationCount()));
    load();
    const handler = () => { setNotifCount(getUnreadNotificationCount()); };
    window.addEventListener('supabase-cache-updated', handler);
    return () => window.removeEventListener('supabase-cache-updated', handler);
  }, [dataReady]);

  // Push notification subscription
  useEffect(() => {
    if (!dataReady || !groupId || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (Notification.permission === 'denied') return;

    const VAPID_PUBLIC = 'BIyHc2Q3XXbAYl1DgPRpqHZGJVM4i38ElcKYpeBib5RXVAUKSiG7IxZ-ZJPyt1UWokY_saRldY-CY54UXnvZbH8';
    const subscribe = async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();
        if (existing) {
          const existingKey = existing.options?.applicationServerKey;
          const expectedKey = Uint8Array.from(atob(VAPID_PUBLIC.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
          const keyMatches = existingKey && new Uint8Array(existingKey).length === expectedKey.length &&
            new Uint8Array(existingKey).every((b, i) => b === expectedKey[i]);
          if (keyMatches) {
            await savePushSubscription(groupId, playerName, existing);
            return;
          }
          await existing.unsubscribe();
        }
        if (Notification.permission === 'default') {
          const perm = await Notification.requestPermission();
          if (perm !== 'granted') return;
        }
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: VAPID_PUBLIC,
        });
        await savePushSubscription(groupId, playerName, sub);
      } catch (err) { console.warn('Push subscription failed:', err); }
    };
    subscribe();
  }, [dataReady, groupId, playerName]);

  // Activity tracking
  const sessionStartRef = useRef<number | null>(null);
  const screensVisitedRef = useRef<Set<string>>(new Set());
  const isTrackingRef = useRef(false);
  const activityIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pushSessionUpdate = useCallback((keepalive = false) => {
    if (!isTrackingRef.current || !sessionStartRef.current) return;
    const screens = Array.from(screensVisitedRef.current);
    const duration = (Date.now() - sessionStartRef.current) / 60000;
    updateSessionActivity(screens, duration, keepalive).catch(() => {});
  }, []);

  useEffect(() => {
    if (!dataReady || !role || !auth.user) return;
    sessionStartRef.current = Date.now();
    screensVisitedRef.current = new Set([getScreenName(location.pathname)]);
    isTrackingRef.current = true;

    logActivity(role, playerName || undefined, auth.user.id).catch(() => {});

    activityIntervalRef.current = setInterval(() => pushSessionUpdate(), 5 * 60 * 1000);

    const handleVisChange = () => {
      if (document.visibilityState === 'hidden') pushSessionUpdate(true);
    };
    document.addEventListener('visibilitychange', handleVisChange);

    return () => {
      if (isTrackingRef.current) {
        pushSessionUpdate(true);
        isTrackingRef.current = false;
        resetSession();
      }
      if (activityIntervalRef.current) clearInterval(activityIntervalRef.current);
      document.removeEventListener('visibilitychange', handleVisChange);
    };
  }, [dataReady, role, auth.user, playerName, pushSessionUpdate, location.pathname]);

  useEffect(() => {
    if (isTrackingRef.current) {
      screensVisitedRef.current.add(getScreenName(location.pathname));
    }
  }, [location.pathname]);

  // Detect ?addMember=email deep link
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const email = params.get('addMember');
    if (email && auth.membership && role === 'admin') {
      setAddMemberPrompt(email);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, [auth.membership, role]);

  const handleAddMemberFromLink = async () => {
    if (!addMemberPrompt) return;
    setAddMemberStatus('loading');
    const { error } = await auth.addMemberByEmail(addMemberPrompt);
    if (error) {
      const msg = (error as { message?: string })?.message || '';
      if (msg.includes('No registered user')) setAddMemberMsg(t('addMember.noUser'));
      else if (msg.includes('already a member')) setAddMemberMsg(t('addMember.alreadyMember'));
      else setAddMemberMsg(msg || t('addMember.error'));
      setAddMemberStatus('error');
    } else {
      setAddMemberMsg(t('addMember.added', { email: addMemberPrompt }));
      setAddMemberStatus('success');
      setTimeout(() => { setAddMemberPrompt(null); setAddMemberStatus('idle'); }, 3000);
    }
  };

  const permissionValue: PermissionContextType = {
    role,
    isOwner,
    isSuperAdmin,
    trainingEnabled,
    playerName,
    hasPermission: (permission) => isSuperAdmin || hasPermission(role, permission),
    signOut: () => { unsubscribeFromRealtime(); resetCache(); setDataReady(false); auth.signOut(); },
    groupMgmt: auth.membership ? {
      groupName: auth.membership.groupName,
      inviteCode: auth.membership.inviteCode,
      currentUserId: auth.user?.id ?? '',
      fetchMembers: auth.fetchMembers,
      updateMemberRole: auth.updateMemberRole,
      removeMember: auth.removeMember,
      transferOwnership: auth.transferOwnership,
      regenerateInviteCode: auth.regenerateInviteCode,
      unlinkMemberPlayer: auth.unlinkMemberPlayer,
      createPlayerInvite: auth.createPlayerInvite,
      addMemberByEmail: auth.addMemberByEmail,
    } : undefined,
    multiGroup: {
      memberships: auth.memberships,
      switchGroup: (gid: string) => {
        unsubscribeFromRealtime();
        resetCache();
        setDataReady(false);
        auth.switchGroup(gid);
      },
      createGroup: auth.createGroup,
      joinGroup: auth.joinGroup,
      joinByPlayerInvite: auth.joinByPlayerInvite,
      refreshMembership: auth.refreshMembership,
      userEmail: auth.user?.email ?? '',
    },
  };

  if (auth.loading) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--background)',
      }}>
        <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>🃏</div>
          {t('app.loading')}
        </div>
      </div>
    );
  }

  if (!auth.user) {
    return <AuthScreen onSignIn={auth.signIn} onSignUp={auth.signUp} onGoogleSignIn={auth.signInWithGoogle} />;
  }

  if (!auth.membership) {
    return (
      <GroupSetupScreen
        userEmail={auth.user.email ?? ''}
        onCreateGroup={auth.createGroup}
        onJoinGroup={auth.joinGroup}
        onJoinByPlayerInvite={auth.joinByPlayerInvite}
        onSignOut={auth.signOut}
        onContinue={() => auth.refreshMembership()}
      />
    );
  }

  if (dataReady && !playerName) {
    const displayName = auth.user?.user_metadata?.full_name
      || auth.user?.user_metadata?.name
      || auth.user?.email?.split('@')[0]
      || '';
    return (
      <PlayerPicker
        onSelfCreate={auth.selfCreateAndLink}
        userDisplayName={displayName}
      />
    );
  }

  if (!dataReady) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--background)', direction: 'rtl',
      }}>
        <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>🃏</div>
          {dataError ? (
            <>
              <p style={{ color: '#ef4444', marginBottom: '1rem' }}>{dataError}</p>
              <button
                onClick={() => window.location.reload()}
                style={{
                  padding: '0.6rem 1.5rem', borderRadius: '8px', border: 'none',
                  background: 'var(--primary)', color: 'white', cursor: 'pointer',
                  fontFamily: 'Outfit, sans-serif',
                }}
              >
                {t('common.retry')}
              </button>
            </>
          ) : (
            t('app.loadingData')
          )}
        </div>
      </div>
    );
  }

  const hideNav = ['/live-game', '/chip-entry', '/game-summary', '/training/play', '/shared-training/play'].some(path =>
    location.pathname.startsWith(path)
  );

  const addMemberBanner = addMemberPrompt && (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
      background: 'var(--surface)', borderBottom: '2px solid var(--primary)',
      padding: '1rem', direction: 'rtl', boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
    }}>
      {addMemberStatus === 'idle' && (
        <div style={{ textAlign: 'center' }}>
          <p style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--text)' }}>
            {t('addMember.title')}
          </p>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
            {t('addMember.question', { email: addMemberPrompt })}
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center' }}>
            <button
              onClick={handleAddMemberFromLink}
              style={{
                padding: '0.55rem 1.5rem', borderRadius: '8px', border: 'none',
                background: 'var(--primary)', color: 'white', cursor: 'pointer',
                fontSize: '0.9rem', fontFamily: 'Outfit, sans-serif', fontWeight: 600,
              }}
            >
              {t('addMember.confirm')}
            </button>
            <button
              onClick={() => { setAddMemberPrompt(null); setAddMemberStatus('idle'); }}
              style={{
                padding: '0.55rem 1.5rem', borderRadius: '8px',
                border: '1px solid var(--border)', background: 'none',
                color: 'var(--text-muted)', cursor: 'pointer',
                fontSize: '0.9rem', fontFamily: 'Outfit, sans-serif',
              }}
            >
              {t('addMember.dismiss')}
            </button>
          </div>
        </div>
      )}
      {addMemberStatus === 'loading' && (
        <p style={{ textAlign: 'center', color: 'var(--text-muted)' }}>{t('addMember.adding')}</p>
      )}
      {addMemberStatus === 'success' && (
        <p style={{ textAlign: 'center', color: '#10B981', fontWeight: 600 }}>✓ {addMemberMsg}</p>
      )}
      {addMemberStatus === 'error' && (
        <div style={{ textAlign: 'center' }}>
          <p style={{ color: '#EF4444', marginBottom: '0.5rem' }}>{addMemberMsg}</p>
          <button
            onClick={() => { setAddMemberPrompt(null); setAddMemberStatus('idle'); }}
            style={{
              padding: '0.4rem 1rem', borderRadius: '6px', border: '1px solid var(--border)',
              background: 'none', color: 'var(--text-muted)', cursor: 'pointer',
              fontSize: '0.8rem', fontFamily: 'Outfit, sans-serif',
            }}
          >
            {t('common.close')}
          </button>
        </div>
      )}
    </div>
  );

  const notificationBanner = notifCount > 0 && !showNotifPanel && (
    <div
      onClick={() => setShowNotifPanel(true)}
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9998,
        background: 'linear-gradient(135deg, #1e293b, #0f172a)', borderBottom: '2px solid #EAB308',
        padding: '0.5rem 1rem', direction: 'rtl', cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem',
        animation: 'contentFadeIn 0.3s ease-out',
        boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
      }}
    >
      <span style={{ fontSize: '1.1rem' }}>🔔</span>
      <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#EAB308' }}>
        {notifCount === 1
          ? (t('notification.settlementTitle'))
          : `${notifCount} ${t('notification.settlementTitle')}`}
      </span>
    </div>
  );

  const notificationPanel = showNotifPanel && (
    <div
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 10000,
        background: 'rgba(0,0,0,0.6)', animation: 'backdropFadeIn 0.2s ease-out',
      }}
      onClick={() => setShowNotifPanel(false)}
    >
      <div
        style={{
          position: 'absolute', top: 0, left: 0, right: 0,
          maxHeight: '60vh', overflowY: 'auto',
          background: 'var(--surface)', borderRadius: '0 0 16px 16px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)', padding: '1rem',
          direction: 'rtl', animation: 'modalSlideUp 0.3s ease-out',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <h3 style={{ margin: 0, fontSize: '1rem', color: 'var(--text)' }}>🔔 התראות</h3>
          <button
            onClick={() => setShowNotifPanel(false)}
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1.2rem' }}
          >✕</button>
        </div>
        {getCachedNotifications().filter(n => !n.read).map(n => (
          <div
            key={n.id}
            style={{
              background: '#1e2d45', borderRadius: '10px', padding: '0.75rem',
              marginBottom: '0.5rem', borderRight: '3px solid #EAB308',
            }}
          >
            <p style={{ margin: '0 0 0.3rem', fontSize: '0.85rem', fontWeight: 600, color: '#EAB308' }}>{n.title}</p>
            <p style={{ margin: '0 0 0.5rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>{n.body}</p>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              {!!n.data?.gameId && (
                <button
                  onClick={() => {
                    markNotificationRead(n.id).then(() => setNotifCount(getUnreadNotificationCount()));
                    setShowNotifPanel(false);
                    navigate(`/game-summary/${String(n.data!.gameId)}`);
                  }}
                  style={{
                    padding: '0.35rem 0.75rem', borderRadius: '6px', border: 'none',
                    background: '#3b82f6', color: 'white', fontSize: '0.75rem',
                    fontWeight: 600, cursor: 'pointer', fontFamily: 'Outfit, sans-serif',
                  }}
                >
                  {t('notification.open')}
                </button>
              )}
              <button
                onClick={() => markNotificationRead(n.id).then(() => setNotifCount(getUnreadNotificationCount()))}
                style={{
                  padding: '0.35rem 0.75rem', borderRadius: '6px',
                  border: '1px solid var(--border)', background: 'none',
                  color: 'var(--text-muted)', fontSize: '0.75rem', cursor: 'pointer',
                  fontFamily: 'Outfit, sans-serif',
                }}
              >
                {t('notification.dismiss')}
              </button>
            </div>
          </div>
        ))}
        {getCachedNotifications().filter(n => !n.read).length === 0 && (
          <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem', padding: '1rem 0' }}>
            אין התראות חדשות
          </p>
        )}
      </div>
    </div>
  );

  const isAdmin = role === 'admin';
  const defaultRoute = isAdmin ? '/' : '/statistics';

  return (
    <ErrorBoundary>
      <PermissionContext.Provider value={permissionValue}>
        {addMemberBanner}
        {notificationBanner}
        {notificationPanel}
        <div className="app-container">
          {!hideNav && <GroupSwitcher />}
          <main className="main-content">
            <Routes>
              <Route path="/" element={isAdmin || isSuperAdmin || trainingEnabled ? <NewGameScreen /> : <Navigate to="/statistics" replace />} />
              <Route path="/live-game/:gameId" element={<LiveGameScreen />} />
              <Route path="/chip-entry/:gameId" element={<ChipEntryScreen />} />
              <Route path="/game-summary/:gameId" element={<GameSummaryScreen />} />
              <Route path="/history" element={<HistoryScreen />} />
              <Route path="/game/:gameId" element={<GameSummaryScreen />} />
              <Route path="/statistics" element={<StatisticsScreen />} />
              <Route path="/settings" element={<SettingsScreen />} />
              <Route path="/graphs" element={<GraphsScreen />} />
              {isSuperAdmin && <Route path="/training" element={<TrainingScreen />} />}
              {isSuperAdmin && <Route path="/training/play" element={<TrainingHandScreen />} />}
              {isSuperAdmin && <Route path="/training/quick" element={<QuickTrainingScreen />} />}
              {trainingEnabled && <Route path="/shared-training" element={<SharedTrainingScreen />} />}
              {trainingEnabled && <Route path="/shared-training/play" element={<SharedQuickPlayScreen />} />}
              <Route path="*" element={<Navigate to={defaultRoute} replace />} />
            </Routes>
          </main>
          {!hideNav && <Navigation />}
        </div>
      </PermissionContext.Provider>
    </ErrorBoundary>
  );
}

function AppWithLanguage() {
  const { isRTL } = useTranslation();
  useEffect(() => {
    document.documentElement.dir = isRTL ? 'rtl' : 'ltr';
    document.documentElement.lang = isRTL ? 'he' : 'en';
  }, [isRTL]);
  return <SupabaseApp />;
}

function App() {
  return (
    <LanguageProvider>
      <AppWithLanguage />
    </LanguageProvider>
  );
}

export default App;
