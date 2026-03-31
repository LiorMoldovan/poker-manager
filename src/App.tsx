import { Component, useEffect, useState, useRef, useCallback, createContext, useContext } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { initializeStorage, getStorageUsage, formatStorageSize, StorageUsage, cleanupOrphanedTTSPools, getAllPlayers } from './database/storage';
import { syncFromCloud, restoreTrainingFromGitHub } from './database/githubSync';
import { PermissionRole } from './types';
import { getRoleFromPin, hasPermission, ROLE_PINS } from './permissions';
import { logActivity, updateSessionActivity, getScreenName, resetSession } from './utils/activityLogger';
import Navigation from './components/Navigation';
import PinLock from './components/PinLock';
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

// Error boundary — catches runtime rendering crashes and shows a recovery UI
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

// Permission context
interface PermissionContextType {
  role: PermissionRole | null;
  playerName: string | null;
  hasPermission: (permission: Parameters<typeof hasPermission>[1]) => boolean;
  signOut: () => void;
}

const PermissionContext = createContext<PermissionContextType>({
  role: null,
  playerName: null,
  hasPermission: () => false,
  signOut: () => {},
});

const IDENTITY_KEY = 'poker_player_identity';

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

function IdentityPrompt({ role, onSelect }: { role: PermissionRole; onSelect: (name: string) => void }) {
  const [selectedName, setSelectedName] = useState('');
  const [customName, setCustomName] = useState('');
  const players = getAllPlayers();
  const permanentPlayers = players.filter(p => p.type === 'permanent');
  const guestPlayers = players.filter(p => p.type === 'guest');

  const isMember = role === 'member' || role === 'memberSync';
  const isViewer = role === 'viewer';

  const handleConfirm = () => {
    const name = isViewer && selectedName === '__custom__' ? customName.trim() : selectedName;
    if (name) onSelect(name);
  };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--background)',
      padding: '2rem',
      direction: 'rtl'
    }}>
      <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
        <div style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>👤</div>
        <h2 style={{ fontSize: '1.3rem', fontWeight: '700', color: 'var(--text)', marginBottom: '0.5rem' }}>
          מי אתה?
        </h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
          {isMember ? 'בחר את השם שלך מהרשימה' : 'בחר או הקלד את השם שלך'}
        </p>
      </div>

      <div style={{ width: '100%', maxWidth: '300px' }}>
        <select
          value={selectedName}
          onChange={e => setSelectedName(e.target.value)}
          style={{
            width: '100%',
            padding: '0.75rem 1rem',
            fontSize: '1rem',
            borderRadius: '10px',
            border: '2px solid var(--border)',
            background: '#1a1a2e',
            color: '#e2e8f0',
            direction: 'rtl',
            marginBottom: '0.75rem',
          }}
        >
          <option value="">בחר שם...</option>
          {isMember && permanentPlayers.map(p => (
            <option key={p.id} value={p.name}>{p.name}</option>
          ))}
          {isViewer && (
            <>
              {guestPlayers.length > 0 && <option disabled>── אורחים ──</option>}
              {guestPlayers.map(p => (
                <option key={p.id} value={p.name}>{p.name}</option>
              ))}
              {permanentPlayers.length > 0 && <option disabled>── שחקנים ──</option>}
              {permanentPlayers.map(p => (
                <option key={p.id} value={p.name}>{p.name}</option>
              ))}
              <option disabled>──────</option>
              <option value="__custom__">שם אחר...</option>
            </>
          )}
        </select>

        {isViewer && selectedName === '__custom__' && (
          <input
            type="text"
            value={customName}
            onChange={e => setCustomName(e.target.value)}
            placeholder="הקלד את שמך..."
            autoFocus
            style={{
              width: '100%',
              padding: '0.75rem 1rem',
              fontSize: '1rem',
              borderRadius: '10px',
              border: '2px solid var(--border)',
              background: '#1a1a2e',
              color: '#e2e8f0',
              direction: 'rtl',
              marginBottom: '0.75rem',
              boxSizing: 'border-box',
            }}
          />
        )}

        <button
          onClick={handleConfirm}
          disabled={!selectedName || (selectedName === '__custom__' && !customName.trim())}
          style={{
            width: '100%',
            padding: '0.85rem',
            fontSize: '1rem',
            fontWeight: '600',
            borderRadius: '10px',
            border: 'none',
            background: (!selectedName || (selectedName === '__custom__' && !customName.trim()))
              ? 'var(--surface-light)'
              : 'var(--primary)',
            color: (!selectedName || (selectedName === '__custom__' && !customName.trim()))
              ? 'var(--text-muted)'
              : 'white',
            cursor: (!selectedName || (selectedName === '__custom__' && !customName.trim()))
              ? 'not-allowed'
              : 'pointer',
            transition: 'all 0.2s ease',
          }}
        >
          המשך
        </button>
      </div>
    </div>
  );
}

function App() {
  const location = useLocation();
  const [role, setRole] = useState<PermissionRole | null>(null);
  const [playerName, setPlayerName] = useState<string | null>(null);
  const [pendingRole, setPendingRole] = useState<PermissionRole | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [syncStatus, setSyncStatus] = useState<{ syncing: boolean; message: string | null }>({ syncing: false, message: null });
  const [storageUsage, setStorageUsage] = useState<StorageUsage | null>(null);
  const [storageWarningDismissed, setStorageWarningDismissed] = useState(false);

  // Activity tracking
  const screensVisitedRef = useRef<Set<string>>(new Set());
  const sessionStartRef = useRef<number | null>(null);
  const activityIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isTrackingRef = useRef(false);

  const pushSessionUpdate = useCallback((keepalive = false) => {
    if (!isTrackingRef.current || !sessionStartRef.current) return;
    const screens = Array.from(screensVisitedRef.current);
    const duration = (Date.now() - sessionStartRef.current) / 60000;
    updateSessionActivity(screens, duration, keepalive).catch(() => {});
  }, []);

  useEffect(() => {
    initializeStorage();
    cleanupOrphanedTTSPools();
    setIsInitialized(true);
    const savedRole = sessionStorage.getItem('poker_role') as PermissionRole;
    if (savedRole && Object.keys(ROLE_PINS).includes(savedRole)) {
      const savedName = savedRole === 'admin' ? 'ליאור' : (sessionStorage.getItem('poker_player_name') || localStorage.getItem(IDENTITY_KEY));
      if (savedName) {
        setRole(savedRole);
        setPlayerName(savedName);
      } else {
        setPendingRole(savedRole);
      }
    }
  }, []);

  // Track screen visits for activity logging
  useEffect(() => {
    if (isTrackingRef.current) {
      const screenName = getScreenName(location.pathname);
      screensVisitedRef.current.add(screenName);
    }
  }, [location.pathname]);

  // Check storage usage on init and after navigation
  useEffect(() => {
    if (isInitialized) {
      const usage = getStorageUsage();
      setStorageUsage(usage);
      
      // Log to console for debugging
      if (usage.status !== 'safe') {
        console.warn(`⚠️ Storage ${usage.status}: ${usage.percent.toFixed(1)}% used (${formatStorageSize(usage.used)} / ${formatStorageSize(usage.limit)})`);
      }
    }
  }, [isInitialized, location.pathname]);

  // Sync from cloud when role is set (admin or member only)
  useEffect(() => {
    if (role && role !== 'viewer') {
      setSyncStatus({ syncing: true, message: 'Syncing...' });
      syncFromCloud().then(result => {
        const hasChanges = result.success && result.synced && 
          ((result.gamesChanged && result.gamesChanged > 0) || (result.playersChanged && result.playersChanged > 0));
        if (hasChanges) {
          setSyncStatus({ syncing: false, message: `☁️ ${result.message}` });
          setTimeout(() => {
            window.location.reload();
          }, 1500);
        } else {
          setSyncStatus({ syncing: false, message: null });
        }
      }).catch(() => {
        setSyncStatus({ syncing: false, message: '⚠️ סנכרון נכשל — ייתכן שהנתונים לא מעודכנים' });
        setTimeout(() => setSyncStatus(prev => ({ ...prev, message: null })), 6000);
      });

      if (role === 'admin') {
        restoreTrainingFromGitHub().catch(err =>
          console.warn('Training restore failed:', err)
        );
      }
    }
  }, [role]);

  const activateRole = useCallback((userRole: PermissionRole, name: string) => {
    setRole(userRole);
    setPlayerName(name);
    sessionStorage.setItem('poker_role', userRole);
    sessionStorage.setItem('poker_player_name', name);

    if (userRole !== 'admin') {
      sessionStartRef.current = Date.now();
      screensVisitedRef.current = new Set();
      isTrackingRef.current = true;

      logActivity(userRole, name).catch(() => {});

      activityIntervalRef.current = setInterval(() => {
        pushSessionUpdate();
      }, 5 * 60 * 1000);

      const handleVisibilityChange = () => {
        if (document.visibilityState === 'hidden') {
          pushSessionUpdate(true);
        }
      };
      document.addEventListener('visibilitychange', handleVisibilityChange);
      (window as any).__activityVisHandler = handleVisibilityChange;
    }
  }, [pushSessionUpdate]);

  const handleUnlock = (pin: string) => {
    const userRole = getRoleFromPin(pin);
    if (userRole) {
      if (userRole === 'admin') {
        const name = 'ליאור';
        localStorage.setItem(IDENTITY_KEY, name);
        activateRole(userRole, name);
      } else {
        const savedName = localStorage.getItem(IDENTITY_KEY);
        if (savedName) {
          activateRole(userRole, savedName);
        } else {
          setPendingRole(userRole);
        }
      }
    }
  };

  const handleSignOut = () => {
    // Push final activity update before clearing session
    if (isTrackingRef.current) {
      pushSessionUpdate();
      isTrackingRef.current = false;
      resetSession();
      if (activityIntervalRef.current) {
        clearInterval(activityIntervalRef.current);
        activityIntervalRef.current = null;
      }
      if ((window as any).__activityVisHandler) {
        document.removeEventListener('visibilitychange', (window as any).__activityVisHandler);
        delete (window as any).__activityVisHandler;
      }
    }
    setRole(null);
    sessionStorage.removeItem('poker_role');
  };

  // Permission context value
  const permissionValue: PermissionContextType = {
    role,
    playerName,
    hasPermission: (permission) => hasPermission(role, permission),
    signOut: handleSignOut,
  };

  // Show loading while initializing
  if (!isInitialized) {
    return (
      <div style={{ 
        minHeight: '100vh', 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'center',
        background: 'var(--background)'
      }}>
        <div style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>🃏</div>
          Loading...
        </div>
      </div>
    );
  }

  // Show PIN lock if not authenticated
  if (!role && !pendingRole) {
    return (
      <PinLock 
        validPins={Object.values(ROLE_PINS)} 
        onUnlock={handleUnlock} 
      />
    );
  }

  // Show identity prompt after PIN entry (non-admin, no saved identity)
  if (pendingRole && !role) {
    return (
      <IdentityPrompt
        role={pendingRole}
        onSelect={(name) => {
          localStorage.setItem(IDENTITY_KEY, name);
          activateRole(pendingRole, name);
          setPendingRole(null);
        }}
      />
    );
  }

  // Viewer role - limited access (view statistics, history, game details, settings for backup only)
  if (role === 'viewer') {
    // Storage warning banner for viewer (simpler version)
    const ViewerStorageWarning = () => {
      if (!storageUsage || storageUsage.status === 'safe' || storageWarningDismissed) return null;
      const isCritical = storageUsage.status === 'critical';
      return (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          background: isCritical 
            ? 'linear-gradient(135deg, #DC2626, #B91C1C)' 
            : 'linear-gradient(135deg, #F59E0B, #D97706)',
          color: 'white',
          padding: '0.6rem 1rem',
          fontSize: '0.8rem',
          fontWeight: '500',
          zIndex: 999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.5rem',
        }}>
          <span>{isCritical ? '🚨' : '⚠️'} Storage {storageUsage.percent.toFixed(0)}% full</span>
          <button 
            onClick={() => setStorageWarningDismissed(true)}
            style={{
              background: 'rgba(255,255,255,0.2)',
              border: 'none',
              color: 'white',
              padding: '0.2rem 0.5rem',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '0.75rem',
            }}
          >
            ✕
          </button>
        </div>
      );
    };

    return (
      <ErrorBoundary>
        <PermissionContext.Provider value={permissionValue}>
          <div className="app-container">
            <ViewerStorageWarning />
            <main className="main-content" style={{ 
              paddingTop: storageUsage && storageUsage.status !== 'safe' && !storageWarningDismissed ? '2.5rem' : undefined 
            }}>
              <Routes>
                <Route path="/statistics" element={<StatisticsScreen />} />
                <Route path="/history" element={<HistoryScreen />} />
                <Route path="/game/:gameId" element={<GameSummaryScreen />} />
                <Route path="/game-summary/:gameId" element={<GameSummaryScreen />} />
                <Route path="/graphs" element={<GraphsScreen />} />
                <Route path="/settings" element={<SettingsScreen />} />
                <Route path="/shared-training" element={<SharedTrainingScreen />} />
                <Route path="/shared-training/play" element={<SharedQuickPlayScreen />} />
                {/* Redirect everything else to statistics */}
                <Route path="*" element={<Navigate to="/statistics" replace />} />
              </Routes>
            </main>
            <Navigation />
          </div>
        </PermissionContext.Provider>
      </ErrorBoundary>
    );
  }

  // Admin and Member - full/partial access
  // Hide navigation on game flow screens
  const hideNav = ['/live-game', '/chip-entry', '/game-summary', '/training/play', '/shared-training/play'].some(path => 
    location.pathname.startsWith(path)
  );

  // Sync status banner component
  const SyncBanner = () => {
    if (!syncStatus.message) return null;
    return (
      <div style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        background: syncStatus.syncing ? 'var(--primary)' : syncStatus.message?.startsWith('⚠️') ? 'linear-gradient(135deg, #f59e0b, #d97706)' : 'linear-gradient(135deg, #10B981, #059669)',
        color: 'white',
        padding: '0.5rem 1rem',
        textAlign: 'center',
        fontSize: '0.85rem',
        fontWeight: '500',
        zIndex: 1000,
        animation: 'fadeIn 0.3s ease',
      }}>
        {syncStatus.syncing ? '⏳ ' : ''}{syncStatus.message}
      </div>
    );
  };

  // Storage warning banner component
  const StorageWarningBanner = () => {
    if (!storageUsage || storageUsage.status === 'safe' || storageWarningDismissed) return null;
    
    const isCritical = storageUsage.status === 'critical';
    const syncBannerOffset = syncStatus.message ? '2.5rem' : '0';
    
    return (
      <div style={{
        position: 'fixed',
        top: syncBannerOffset,
        left: 0,
        right: 0,
        background: isCritical 
          ? 'linear-gradient(135deg, #DC2626, #B91C1C)' 
          : 'linear-gradient(135deg, #F59E0B, #D97706)',
        color: 'white',
        padding: '0.6rem 1rem',
        fontSize: '0.8rem',
        fontWeight: '500',
        zIndex: 999,
        animation: 'fadeIn 0.3s ease',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '0.5rem',
      }}>
        <span>
          {isCritical ? '🚨' : '⚠️'} Storage {storageUsage.percent.toFixed(0)}% full 
          ({formatStorageSize(storageUsage.used)}/{formatStorageSize(storageUsage.limit)})
          {storageUsage.estimatedGamesRemaining > 0 && !isCritical && (
            <span style={{ opacity: 0.9 }}> • ~{storageUsage.estimatedGamesRemaining} games left</span>
          )}
          {isCritical && (
            <span style={{ opacity: 0.9 }}> • Export data in Settings!</span>
          )}
        </span>
        <button 
          onClick={() => setStorageWarningDismissed(true)}
          style={{
            background: 'rgba(255,255,255,0.2)',
            border: 'none',
            color: 'white',
            padding: '0.2rem 0.5rem',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '0.75rem',
            marginLeft: '0.5rem',
          }}
        >
          ✕
        </button>
      </div>
    );
  };

  // Calculate total banner offset for main content
  const getBannerOffset = () => {
    let offset = 0;
    if (syncStatus.message) offset += 2.5;
    if (storageUsage && storageUsage.status !== 'safe' && !storageWarningDismissed) offset += 2.5;
    return offset > 0 ? `${offset}rem` : undefined;
  };

  return (
    <ErrorBoundary>
      <PermissionContext.Provider value={permissionValue}>
        <div className="app-container">
          <SyncBanner />
          <StorageWarningBanner />
          <main className="main-content" style={{ paddingTop: getBannerOffset() }}>
            <Routes>
              <Route path="/" element={<NewGameScreen />} />
              <Route path="/live-game/:gameId" element={<LiveGameScreen />} />
              <Route path="/chip-entry/:gameId" element={<ChipEntryScreen />} />
              <Route path="/game-summary/:gameId" element={<GameSummaryScreen />} />
              <Route path="/history" element={<HistoryScreen />} />
              <Route path="/game/:gameId" element={<GameSummaryScreen />} />
              <Route path="/statistics" element={<StatisticsScreen />} />
              <Route path="/settings" element={<SettingsScreen />} />
              {/* Graphs page - all authenticated users (viewer = read-only) */}
              <Route path="/graphs" element={<GraphsScreen />} />
              {/* Training - admin only */}
              {role === 'admin' && <Route path="/training" element={<TrainingScreen />} />}
              {role === 'admin' && <Route path="/training/play" element={<TrainingHandScreen />} />}
              {role === 'admin' && <Route path="/training/quick" element={<QuickTrainingScreen />} />}
              {/* Shared training - all roles */}
              <Route path="/shared-training" element={<SharedTrainingScreen />} />
              <Route path="/shared-training/play" element={<SharedQuickPlayScreen />} />
              {/* Catch-all route - redirect unknown URLs to home */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
          {!hideNav && <Navigation />}
        </div>
      </PermissionContext.Provider>
    </ErrorBoundary>
  );
}

export default App;
