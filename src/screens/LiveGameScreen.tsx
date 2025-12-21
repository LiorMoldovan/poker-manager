import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { GamePlayer, GameAction } from '../types';
import { getGamePlayers, updateGamePlayerRebuys, getSettings, updateGameStatus, getGame, updateGame } from '../database/storage';
import { cleanNumber } from '../utils/calculations';
import { usePermissions } from '../App';

const LiveGameScreen = () => {
  const { gameId } = useParams<{ gameId: string }>();
  const navigate = useNavigate();
  const { role } = usePermissions();
  const isAdmin = role === 'admin';
  const [players, setPlayers] = useState<GamePlayer[]>([]);
  const [actions, setActions] = useState<GameAction[]>([]);
  const [rebuyValue, setRebuyValue] = useState(50);
  const [isLoading, setIsLoading] = useState(true);
  const [gameNotFound, setGameNotFound] = useState(false);
  
  // Track last rebuy time per player for quick rebuy detection
  const lastRebuyTimeRef = useRef<Map<string, number>>(new Map());

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

  // Cash drawer opening sound - mechanical slide + click
  const playCashSound = (): Promise<void> => {
    return new Promise((resolve) => {
      try {
        const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        
        // Create noise for mechanical sliding sound
        const createNoise = (duration: number, startTime: number, volume: number) => {
          const bufferSize = audioContext.sampleRate * duration;
          const buffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate);
          const data = buffer.getChannelData(0);
          
          for (let i = 0; i < bufferSize; i++) {
            data[i] = (Math.random() * 2 - 1) * 0.5;
          }
          
          const noise = audioContext.createBufferSource();
          noise.buffer = buffer;
          
          // Low-pass filter for rumble effect
          const filter = audioContext.createBiquadFilter();
          filter.type = 'lowpass';
          filter.frequency.value = 400;
          
          const gainNode = audioContext.createGain();
          gainNode.gain.setValueAtTime(0, audioContext.currentTime + startTime);
          gainNode.gain.linearRampToValueAtTime(volume, audioContext.currentTime + startTime + 0.02);
          gainNode.gain.linearRampToValueAtTime(volume * 0.7, audioContext.currentTime + startTime + duration * 0.8);
          gainNode.gain.linearRampToValueAtTime(0, audioContext.currentTime + startTime + duration);
          
          noise.connect(filter);
          filter.connect(gainNode);
          gainNode.connect(audioContext.destination);
          
          noise.start(audioContext.currentTime + startTime);
          noise.stop(audioContext.currentTime + startTime + duration);
        };
        
        // Mechanical click sound
        const playClick = (freq: number, startTime: number, duration: number, volume: number) => {
          const oscillator = audioContext.createOscillator();
          const gainNode = audioContext.createGain();
          
          oscillator.connect(gainNode);
          gainNode.connect(audioContext.destination);
          
          oscillator.frequency.value = freq;
          oscillator.type = 'square';
          
          gainNode.gain.setValueAtTime(volume, audioContext.currentTime + startTime);
          gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + startTime + duration);
          
          oscillator.start(audioContext.currentTime + startTime);
          oscillator.stop(audioContext.currentTime + startTime + duration);
        };
        
        // Random variant of drawer opening
        const variant = Math.floor(Math.random() * 3);
        
        if (variant === 0) {
          // Drawer slide + click
          createNoise(0.15, 0, 0.4);      // Drawer sliding
          playClick(200, 0.14, 0.05, 0.5); // Drawer hits stop
          playClick(150, 0.16, 0.03, 0.3); // Secondary click
        } else if (variant === 1) {
          // Quick drawer pop
          playClick(180, 0, 0.02, 0.4);   // Button click
          createNoise(0.12, 0.02, 0.35);  // Drawer slides
          playClick(220, 0.13, 0.04, 0.45); // Stop click
        } else {
          // Smooth drawer
          createNoise(0.18, 0, 0.35);     // Longer slide
          playClick(170, 0.17, 0.04, 0.4); // Soft stop
        }
        
        setTimeout(resolve, 250);
      } catch (e) {
        console.log('Could not play cash sound:', e);
        resolve();
      }
    });
  };

  // Creative messages for each buyin level
  const getBuyinMessage = (totalBuyins: number, isQuickRebuy: boolean): string => {
    // Quick rebuy messages (< 10 min since last)
    const quickMessages = [
      'זה היה מהיר!',
      'עוד פעם? רק עכשיו קנית!',
      'לא נותנים לך לנשום!',
      'הקלפים רודפים אותך!',
      'קצב מטורף!',
      'בלי רחמים עליך הלילה!',
    ];
    
    const messages: Record<number, string[]> = {
      1: [
        'יאללה, בהצלחה!',
        'שהקלפים יהיו איתך!',
        'משחק חדש, מזל חדש!',
        'בוא ננצח!',
        'הלילה שלך!',
      ],
      2: [
        'עוד הזדמנות!',
        'זה יהיה בסדר!',
        'הקלפים ישתפרו!',
        'זה רק ההתחלה!',
        'עכשיו באמת מתחילים!',
      ],
      3: [
        'עדיין סביר לגמרי!',
        'שלישית הקסם!',
        'לא מוותרים!',
        'עכשיו זה ברצינות!',
        'בוא ננצח את הלילה הזה!',
      ],
      4: [
        'מתחיל להיות יקר...',
        'ארנק עמוק יש לך!',
        'ערב משמעותי!',
        'אתה בטוח?',
        'שים לב לעצמך!',
      ],
      5: [
        'וואו, חמש פעמים!',
        'לא כל יום רואים כזה דבר!',
        'התמדה יוצאת דופן!',
        'בוא נקווה שזה האחרון!',
        'ערב לזכור!',
      ],
    };
    
    // Messages for 6-9 buyins (dramatic)
    const highMessages = [
      'שיא אישי מתקרב!',
      'מחר יום חדש!',
      'זה כבר היסטוריה!',
      'אין דרך חזרה!',
      'סיפור לספר!',
      'וואלה, כבוד!',
      'עד הסוף!',
      'מטורף!',
    ];
    
    // Messages for 10+ buyins (final)
    const finalMessages = [
      'זה האחרון שאני מאשר!',
      'מספיק להיום!',
      'אני כבר לא אחראי!',
      'הגעת למקסימום!',
      'בבקשה תעצור!',
      'נגמר הכסף הקטן!',
    ];
    
    let message: string;
    
    if (totalBuyins >= 10) {
      message = finalMessages[Math.floor(Math.random() * finalMessages.length)];
    } else if (totalBuyins >= 6) {
      message = highMessages[Math.floor(Math.random() * highMessages.length)];
    } else {
      const levelMessages = messages[totalBuyins] || messages[5];
      message = levelMessages[Math.floor(Math.random() * levelMessages.length)];
    }
    
    // Add quick rebuy prefix if applicable
    if (isQuickRebuy && totalBuyins > 1) {
      const quickMsg = quickMessages[Math.floor(Math.random() * quickMessages.length)];
      message = `${quickMsg} ${message}`;
    }
    
    return message;
  };

  // Text-to-speech for buyin announcements - ALL HEBREW
  const speakBuyin = async (playerName: string, totalBuyins: number, isQuickRebuy: boolean, isHalfBuyin: boolean) => {
    // Play cash drawer opening sound first
    await playCashSound();
    
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      
      // Get available voices and prefer Hebrew male voice
      const voices = window.speechSynthesis.getVoices();
      const hebrewVoice = voices.find(v => v.lang.startsWith('he') && v.name.toLowerCase().includes('male')) 
        || voices.find(v => v.lang.startsWith('he'))
        || null;
      
      // Check if total has half (0.5) - use tolerance for floating point
      const hasHalf = Math.abs((totalBuyins % 1) - 0.5) < 0.01;
      const whole = Math.floor(totalBuyins);
      
      // Hebrew numbers for speech
      const hebrewNumbers = ['אפס', 'אחד', 'שתיים', 'שלוש', 'ארבע', 'חמש', 'שש', 'שבע', 'שמונה', 'תשע', 'עשר'];
      
      // Format total in Hebrew
      let totalText: string;
      if (hasHalf) {
        if (whole === 0) {
          totalText = 'חצי';
        } else if (whole <= 10) {
          totalText = `${hebrewNumbers[whole]} וחצי`;
        } else {
          totalText = `${whole} וחצי`;
        }
      } else {
        if (whole <= 10) {
          totalText = hebrewNumbers[whole];
        } else {
          totalText = String(whole);
        }
      }
      
      // Use phonetic spelling for better pronunciation
      // "נכנס" (entered/joined) instead of "קנה" which TTS struggles with
      const buyAction = isHalfBuyin ? 'נכנס בחצי' : 'נכנס';
      
      const creativeMessage = getBuyinMessage(Math.ceil(totalBuyins), isQuickRebuy);
      const fullMessage = `${playerName} ${buyAction}. סך הכל ${totalText}. ${creativeMessage}`;
      
      const utterance = new SpeechSynthesisUtterance(fullMessage);
      utterance.lang = 'he-IL';
      if (hebrewVoice) utterance.voice = hebrewVoice;
      utterance.rate = 0.9;  // Slower for clarity
      utterance.pitch = 0.85; // Lower for male sound
      utterance.volume = 1;
      
      window.speechSynthesis.speak(utterance);
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
    
    // Check if this is a quick rebuy (< 10 min since last)
    const now = Date.now();
    const lastRebuyTime = lastRebuyTimeRef.current.get(player.id) || 0;
    const isQuickRebuy = lastRebuyTime > 0 && (now - lastRebuyTime) < 10 * 60 * 1000; // 10 minutes
    
    // Update last rebuy time
    lastRebuyTimeRef.current.set(player.id, now);
    
    // Announce in Hebrew with creative message
    const isHalfBuyin = amount === 0.5;
    speakBuyin(player.playerName, newRebuys, isQuickRebuy, isHalfBuyin);
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

