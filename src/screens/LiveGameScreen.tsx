import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { GamePlayer, GameAction } from '../types';
import { getGamePlayers, updateGamePlayerRebuys, getSettings, updateGameStatus } from '../database/storage';
import { cleanNumber } from '../utils/calculations';

const LiveGameScreen = () => {
  const { gameId } = useParams<{ gameId: string }>();
  const navigate = useNavigate();
  const [players, setPlayers] = useState<GamePlayer[]>([]);
  const [actions, setActions] = useState<GameAction[]>([]);
  const [rebuyValue, setRebuyValue] = useState(50);
  const [isLoading, setIsLoading] = useState(true);
  const [gameNotFound, setGameNotFound] = useState(false);

  useEffect(() => {
    if (gameId) {
      loadData();
    } else {
      setGameNotFound(true);
      setIsLoading(false);
    }
  }, [gameId]);

  // Pre-load voices (they may not be immediately available)
  useEffect(() => {
    if ('speechSynthesis' in window) {
      // Trigger voice loading
      window.speechSynthesis.getVoices();
      // Some browsers need this event to load voices
      window.speechSynthesis.onvoiceschanged = () => {
        window.speechSynthesis.getVoices();
      };
    }
  }, []);

  const loadData = () => {
    if (!gameId) {
      setGameNotFound(true);
      setIsLoading(false);
      return;
    }
    const gamePlayers = getGamePlayers(gameId);
    if (gamePlayers.length === 0) {
      setGameNotFound(true);
      setIsLoading(false);
      return;
    }
    setPlayers(gamePlayers);
    const settings = getSettings();
    setRebuyValue(settings.rebuyValue);
    setIsLoading(false);
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="fade-in" style={{ textAlign: 'center', padding: '3rem' }}>
        <div style={{ fontSize: '2rem', marginBottom: '1rem' }}>🃏</div>
        <p className="text-muted">Loading game...</p>
      </div>
    );
  }

  // Game not found
  if (gameNotFound) {
    return (
      <div className="fade-in" style={{ textAlign: 'center', padding: '3rem' }}>
        <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>😕</div>
        <h2 style={{ marginBottom: '0.5rem' }}>Game Not Found</h2>
        <p className="text-muted" style={{ marginBottom: '1.5rem' }}>This game may have been deleted or doesn't exist.</p>
        <button className="btn btn-primary" onClick={() => navigate('/')}>Go Home</button>
      </div>
    );
  }

  // Play alert beep sound
  const playAlertSound = (): Promise<void> => {
    return new Promise((resolve) => {
      try {
        const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        
        // Create a pleasant chime sound (two tones)
        const playTone = (frequency: number, startTime: number, duration: number) => {
          const oscillator = audioContext.createOscillator();
          const gainNode = audioContext.createGain();
          
          oscillator.connect(gainNode);
          gainNode.connect(audioContext.destination);
          
          oscillator.frequency.value = frequency;
          oscillator.type = 'sine';
          
          // Fade in and out for a pleasant sound
          gainNode.gain.setValueAtTime(0, audioContext.currentTime + startTime);
          gainNode.gain.linearRampToValueAtTime(0.3, audioContext.currentTime + startTime + 0.05);
          gainNode.gain.linearRampToValueAtTime(0, audioContext.currentTime + startTime + duration);
          
          oscillator.start(audioContext.currentTime + startTime);
          oscillator.stop(audioContext.currentTime + startTime + duration);
        };
        
        // Play two ascending tones (ding-dong)
        playTone(880, 0, 0.15);      // A5
        playTone(1175, 0.12, 0.2);   // D6
        
        // Resolve after the sound finishes
        setTimeout(resolve, 350);
      } catch (e) {
        console.log('Could not play alert sound:', e);
        resolve();
      }
    });
  };

  // Text-to-speech for buyin announcements
  const speak = async (hebrewName: string, englishAction: string) => {
    // Play alert sound first
    await playAlertSound();
    
    if ('speechSynthesis' in window) {
      // Cancel any ongoing speech
      window.speechSynthesis.cancel();
      
      // Get available voices
      const voices = window.speechSynthesis.getVoices();
      
      // Log available English voices for debugging
      const englishVoices = voices.filter(v => v.lang.startsWith('en'));
      console.log('Available English voices:', englishVoices.map(v => `${v.name} (${v.lang})`));
      
      // Find a good Hebrew voice
      const hebrewVoice = voices.find(v => v.lang.startsWith('he')) || null;
      
      // Find a good English voice - prioritize female voices (usually clearer)
      const englishVoice = 
        // Try Samantha (iOS/Mac - very natural)
        voices.find(v => v.name.includes('Samantha')) ||
        // Try Google US English female
        voices.find(v => v.name.includes('Google US English') && !v.name.includes('Male')) ||
        // Try any female voice
        voices.find(v => v.lang.startsWith('en') && (v.name.includes('Female') || v.name.includes('Zira') || v.name.includes('Susan') || v.name.includes('Karen'))) ||
        // Try Microsoft voices (Windows)
        voices.find(v => v.name.includes('Microsoft Zira') || v.name.includes('Microsoft Susan')) ||
        // Fallback to any US English
        voices.find(v => v.lang === 'en-US') ||
        // Any English
        voices.find(v => v.lang.startsWith('en')) ||
        null;
      
      if (englishVoice) {
        console.log('Selected English voice:', englishVoice.name);
      }
      
      // First: Say the name in Hebrew
      const nameUtterance = new SpeechSynthesisUtterance(hebrewName);
      nameUtterance.lang = 'he-IL';
      if (hebrewVoice) nameUtterance.voice = hebrewVoice;
      nameUtterance.rate = 1.0;
      nameUtterance.pitch = 1;
      nameUtterance.volume = 1;
      
      // Second: Say the action in English with natural female voice
      const actionUtterance = new SpeechSynthesisUtterance(englishAction);
      actionUtterance.lang = 'en-US';
      if (englishVoice) actionUtterance.voice = englishVoice;
      actionUtterance.rate = 0.95; // Natural pace
      actionUtterance.pitch = 1.0; // Natural pitch
      actionUtterance.volume = 1;
      
      // Queue both utterances
      window.speechSynthesis.speak(nameUtterance);
      window.speechSynthesis.speak(actionUtterance);
    }
  };

  const handleRebuy = (player: GamePlayer, amount: number = 1) => {
    const newRebuys = player.rebuys + amount;
    updateGamePlayerRebuys(player.id, newRebuys);
    
    setPlayers(players.map(p => 
      p.id === player.id ? { ...p, rebuys: newRebuys } : p
    ));
    
    setActions([
      {
        type: 'rebuy',
        playerId: player.id,
        playerName: player.playerName,
        timestamp: new Date().toISOString(),
        amount: amount,
      },
      ...actions,
    ]);
    
    // Announce: Hebrew name + English "buyin"
    const buyinText = amount === 1 ? 'buyin' : 'half buyin';
    speak(player.playerName, buyinText);
  };

  const handleUndo = () => {
    if (actions.length === 0) return;
    
    const lastAction = actions[0];
    const player = players.find(p => p.id === lastAction.playerId);
    
    if (player && player.rebuys >= lastAction.amount) {
      const newRebuys = player.rebuys - lastAction.amount;
      // Don't allow going below 0.5 (minimum buy-in)
      if (newRebuys >= 0.5) {
        updateGamePlayerRebuys(player.id, newRebuys);
        
        setPlayers(players.map(p => 
          p.id === player.id ? { ...p, rebuys: newRebuys } : p
        ));
        
        setActions(actions.slice(1));
      }
    }
  };

  const handleEndGame = () => {
    if (gameId) {
      updateGameStatus(gameId, 'chip_entry');
      navigate(`/chip-entry/${gameId}`);
    }
  };

  const totalPot = players.reduce((sum, p) => sum + p.rebuys * rebuyValue, 0);
  const totalRebuys = players.reduce((sum, p) => sum + p.rebuys, 0);

  return (
    <div className="fade-in">
      <div className="page-header">
        <h1 className="page-title">Live Game</h1>
        <p className="page-subtitle">Track buyins during the game</p>
      </div>

      <div className="summary-card" style={{ display: 'flex', justifyContent: 'space-around', textAlign: 'center' }}>
        <div>
          <div className="summary-title">Total Pot</div>
          <div className="summary-value">₪{cleanNumber(totalPot)}</div>
        </div>
        <div>
          <div className="summary-title">Total Buyins</div>
          <div className="summary-value">{cleanNumber(totalRebuys)}</div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Players</h2>
          <span className="text-muted">{players.length} playing</span>
        </div>

          {players.map(player => (
          <div key={player.id} className="player-card">
            <div>
              <div className="player-name">{player.playerName}</div>
              <div className="text-muted" style={{ fontSize: '0.875rem' }}>
                ₪{cleanNumber(player.rebuys * rebuyValue)} invested
              </div>
            </div>
            <div className="player-rebuys">
              <span className="rebuy-count">{cleanNumber(player.rebuys)}</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                <button 
                  className="btn btn-primary btn-sm"
                  onClick={() => handleRebuy(player, 1)}
                >
                  +1 Buyin
                </button>
                <button 
                  className="btn btn-secondary btn-sm"
                  onClick={() => handleRebuy(player, 0.5)}
                  style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
                >
                  +0.5
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {actions.length > 0 && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Recent Actions</h2>
            <button className="btn btn-sm btn-secondary" onClick={handleUndo}>
              ↩ Undo
            </button>
          </div>
          <div className="list">
            {actions.slice(0, 5).map((action, index) => (
              <div key={index} className="list-item">
                <span>
                  {action.playerName} {action.amount === 0.5 ? '+0.5 buyin' : '+1 buyin'}
                </span>
                <span className="text-muted">
                  {new Date(action.timestamp).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <button 
        className="btn btn-primary btn-lg btn-block mt-3"
        onClick={handleEndGame}
      >
        🏁 End Game & Count Chips
      </button>
    </div>
  );
};

export default LiveGameScreen;

