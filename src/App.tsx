import { useEffect, useState, createContext, useContext } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { initializeStorage } from './database/storage';
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

  useEffect(() => {
    initializeStorage();
    setIsInitialized(true);
    // Check if already authenticated
    const savedRole = sessionStorage.getItem('poker_role') as PermissionRole;
    if (savedRole && Object.keys(ROLE_PINS).includes(savedRole)) {
      setRole(savedRole);
    }
  }, []);

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
    return (
      <PermissionContext.Provider value={permissionValue}>
        <div className="app-container">
          <main className="main-content">
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

  return (
    <PermissionContext.Provider value={permissionValue}>
      <div className="app-container">
        <main className="main-content">
          <Routes>
            <Route path="/" element={<NewGameScreen />} />
            <Route path="/live-game/:gameId" element={<LiveGameScreen />} />
            <Route path="/chip-entry/:gameId" element={<ChipEntryScreen />} />
            <Route path="/game-summary/:gameId" element={<GameSummaryScreen />} />
            <Route path="/history" element={<HistoryScreen />} />
            <Route path="/game/:gameId" element={<GameDetailsScreen />} />
            <Route path="/statistics" element={<StatisticsScreen />} />
            <Route path="/settings" element={<SettingsScreen />} />
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
