import { useEffect, useState, createContext, useContext } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { initializeStorage, getStorageUsage, formatStorageSize, StorageUsage } from './database/storage';
import { syncFromCloud } from './database/githubSync';
import { PermissionRole } from './types';
import { getRoleFromPin, hasPermission, ROLE_PINS } from './permissions';
import Navigation from './components/Navigation';
import PinLock from './components/PinLock';
import NewGameScreen from './screens/NewGameScreen';
import LiveGameScreen from './screens/LiveGameScreen';
import ChipEntryScreen from './screens/ChipEntryScreen';
import GameSummaryScreen from './screens/GameSummaryScreen';
import HistoryScreen from './screens/HistoryScreen';
import GameDetailsScreen from './screens/GameDetailsScreen';
import StatisticsScreen from './screens/StatisticsScreen';
import SettingsScreen from './screens/SettingsScreen';
import GraphsScreen from './screens/GraphsScreen';

// Permission context
interface PermissionContextType {
  role: PermissionRole | null;
  hasPermission: (permission: Parameters<typeof hasPermission>[1]) => boolean;
}

const PermissionContext = createContext<PermissionContextType>({
  role: null,
  hasPermission: () => false,
});

export const usePermissions = () => useContext(PermissionContext);

function App() {
  const location = useLocation();
  const [role, setRole] = useState<PermissionRole | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [syncStatus, setSyncStatus] = useState<{ syncing: boolean; message: string | null }>({ syncing: false, message: null });
  const [storageUsage, setStorageUsage] = useState<StorageUsage | null>(null);
  const [storageWarningDismissed, setStorageWarningDismissed] = useState(false);

  useEffect(() => {
    initializeStorage();
    setIsInitialized(true);
    // Check if already authenticated
    const savedRole = sessionStorage.getItem('poker_role') as PermissionRole;
    if (savedRole && Object.keys(ROLE_PINS).includes(savedRole)) {
      setRole(savedRole);
    }
  }, []);

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
        if (result.success && result.synced && result.gamesChanged && result.gamesChanged > 0) {
          setSyncStatus({ syncing: false, message: `☁️ ${result.message}` });
          // Reload page after showing message to pick up new data
          setTimeout(() => {
            window.location.reload();
          }, 1500);
        } else {
          setSyncStatus({ syncing: false, message: null });
        }
      }).catch(() => {
        setSyncStatus({ syncing: false, message: null });
      });
    }
  }, [role]);

  const handleUnlock = (pin: string) => {
    const userRole = getRoleFromPin(pin);
    if (userRole) {
      setRole(userRole);
      sessionStorage.setItem('poker_role', userRole);
    }
  };

  // Permission context value
  const permissionValue: PermissionContextType = {
    role,
    hasPermission: (permission) => hasPermission(role, permission),
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
  if (!role) {
    return (
      <PinLock 
        validPins={Object.values(ROLE_PINS)} 
        onUnlock={handleUnlock} 
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
      <PermissionContext.Provider value={permissionValue}>
        <div className="app-container">
          <ViewerStorageWarning />
          <main className="main-content" style={{ 
            paddingTop: storageUsage && storageUsage.status !== 'safe' && !storageWarningDismissed ? '2.5rem' : undefined 
          }}>
            <Routes>
              <Route path="/statistics" element={<StatisticsScreen />} />
              <Route path="/history" element={<HistoryScreen />} />
              <Route path="/game/:gameId" element={<GameDetailsScreen />} />
              <Route path="/settings" element={<SettingsScreen />} />
              {/* Redirect everything else to statistics */}
              <Route path="*" element={<Navigate to="/statistics" replace />} />
            </Routes>
          </main>
          <Navigation />
        </div>
      </PermissionContext.Provider>
    );
  }

  // Admin and Member - full/partial access
  // Hide navigation on game flow screens
  const hideNav = ['/live-game', '/chip-entry', '/game-summary'].some(path => 
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
        background: syncStatus.syncing ? 'var(--primary)' : 'linear-gradient(135deg, #10B981, #059669)',
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
            <Route path="/game/:gameId" element={<GameDetailsScreen />} />
            <Route path="/statistics" element={<StatisticsScreen />} />
            <Route path="/settings" element={<SettingsScreen />} />
            {/* Graphs page - admin and member only */}
            {(role === 'admin' || role === 'member') && <Route path="/graphs" element={<GraphsScreen />} />}
            {/* Catch-all route - redirect unknown URLs to home */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        {!hideNav && <Navigation />}
      </div>
    </PermissionContext.Provider>
  );
}

export default App;
