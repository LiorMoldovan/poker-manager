import { useEffect } from 'react';
import { Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { initializeStorage } from './database/storage';
import Navigation from './components/Navigation';
import NewGameScreen from './screens/NewGameScreen';
import LiveGameScreen from './screens/LiveGameScreen';
import ChipEntryScreen from './screens/ChipEntryScreen';
import GameSummaryScreen from './screens/GameSummaryScreen';
import HistoryScreen from './screens/HistoryScreen';
import GameDetailsScreen from './screens/GameDetailsScreen';
import StatisticsScreen from './screens/StatisticsScreen';
import SettingsScreen from './screens/SettingsScreen';

function App() {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    initializeStorage();
  }, []);

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

