import { useEffect, useState } from 'react';
import { Routes, Route, useLocation } from 'react-router-dom';
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

// PIN code for app access
const APP_PIN = '2580';

function App() {
  const location = useLocation();
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  useEffect(() => {
    initializeStorage();
    // Check if already authenticated
    if (sessionStorage.getItem('poker_authenticated') === 'true') {
      setIsAuthenticated(true);
    }
  }, []);

  // Show PIN lock if not authenticated
  if (!isAuthenticated) {
    return <PinLock correctPin={APP_PIN} onUnlock={() => setIsAuthenticated(true)} />;
  }

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
        </Routes>
      </main>
      {!hideNav && <Navigation />}
    </div>
  );
}

export default App;

