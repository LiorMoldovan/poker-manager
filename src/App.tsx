import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { initializeStorage } from './database/storage';
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

// PIN codes for app access
const FULL_ACCESS_PIN = '2580';
const STATS_ONLY_PIN = '9876';

export type AccessLevel = 'none' | 'stats_only' | 'full';

function App() {
  const location = useLocation();
  const [accessLevel, setAccessLevel] = useState<AccessLevel>('none');
  const [isInitialized, setIsInitialized] = useState(false);

  useEffect(() => {
    initializeStorage();
    setIsInitialized(true);
    // Check if already authenticated
    const savedAccess = sessionStorage.getItem('poker_access_level') as AccessLevel;
    if (savedAccess === 'full' || savedAccess === 'stats_only') {
      setAccessLevel(savedAccess);
    }
  }, []);

  const handleUnlock = (pin: string) => {
    if (pin === FULL_ACCESS_PIN) {
      setAccessLevel('full');
      sessionStorage.setItem('poker_access_level', 'full');
    } else if (pin === STATS_ONLY_PIN) {
      setAccessLevel('stats_only');
      sessionStorage.setItem('poker_access_level', 'stats_only');
    }
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
  if (accessLevel === 'none') {
    return (
      <PinLock 
        validPins={[FULL_ACCESS_PIN, STATS_ONLY_PIN]} 
        onUnlock={handleUnlock} 
      />
    );
  }

  // Stats-only access - show only statistics page
  if (accessLevel === 'stats_only') {
    return (
      <div className="app-container">
        <main className="main-content">
          <Routes>
            <Route path="/statistics" element={<StatisticsScreen />} />
            {/* Redirect everything to statistics */}
            <Route path="*" element={<Navigate to="/statistics" replace />} />
          </Routes>
        </main>
        {/* No navigation for stats-only users */}
      </div>
    );
  }

  // Full access
  // Hide navigation on game flow screens
  const hideNav = ['/live-game', '/chip-entry', '/game-summary'].some(path => 
    location.pathname.startsWith(path)
  );

  return (
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
  );
}

export default App;
