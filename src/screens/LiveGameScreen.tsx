import { useState, useEffect } from 'react';
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

  // Track last rebuy time per player for quick rebuy detection
  const lastRebuyTimeRef = useRef<Map<string, number>>(new Map());

  // Play cash register / money sound
  const playCashSound = (): Promise<void> => {
    return new Promise((resolve) => {
      try {
        const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        
        // Create cash register "ching-ching" sound
        const playTone = (frequency: number, startTime: number, duration: number, type: OscillatorType = 'sine') => {
          const oscillator = audioContext.createOscillator();
          const gainNode = audioContext.createGain();
          
          oscillator.connect(gainNode);
          gainNode.connect(audioContext.destination);
          
          oscillator.frequency.value = frequency;
          oscillator.type = type;
          
          gainNode.gain.setValueAtTime(0, audioContext.currentTime + startTime);
          gainNode.gain.linearRampToValueAtTime(0.4, audioContext.currentTime + startTime + 0.02);
          gainNode.gain.linearRampToValueAtTime(0, audioContext.currentTime + startTime + duration);
          
          oscillator.start(audioContext.currentTime + startTime);
          oscillator.stop(audioContext.currentTime + startTime + duration);
        };
        
        // Cash register sound: metallic ching-ching
        playTone(2500, 0, 0.08, 'square');      // First ching (high metallic)
        playTone(3000, 0.02, 0.06, 'triangle'); // Overtone
        playTone(2500, 0.15, 0.08, 'square');   // Second ching
        playTone(3200, 0.17, 0.06, 'triangle'); // Overtone
        
        setTimeout(resolve, 300);
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
      'מהר חזרת!',
      'לא הספקת להתקרר!',
      'רגע, עכשיו קנית!',
      'וואו, זה היה מהיר!',
      'בלי הפסקה!',
      'עוד פעם? כבר?',
    ];
    
    const messages: Record<number, string[]> = {
      1: [
        'בהצלחה הלילה!',
        'שהמזל יהיה איתך!',
        'יאללה, בוא נראה מה יהיה!',
        'התחלה חדשה!',
        'בוא נעשה את זה!',
        'הערב שלך!',
        'שיהיה בהצלחה!',
      ],
      2: [
        'עוד סיבוב, עוד סיכוי!',
        'הקלפים ישתפרו!',
        'לא נורא, עדיין מוקדם!',
        'זה חלק מהמשחק!',
        'עכשיו מתחילים!',
        'הפעם זה יעבוד!',
        'מתחממים!',
        'עוד ניסיון!',
      ],
      3: [
        'שלוש פעמים גישה!',
        'עדיין בטווח הסביר...',
        'המזל כבר חייב להשתנות!',
        'התמדה משתלמת!',
        'לא מוותרים!',
        'שלישית זה קסם!',
        'עוד קצת סבלנות!',
        'ממשיכים להילחם!',
      ],
      4: [
        'מתחילים להתחמם פה...',
        'אולי כדאי לקחת אוויר?',
        'הארנק מתחיל להרגיש...',
        'ערב יקר מתהווה!',
        'נשימה עמוקה!',
        'אתה בטוח?',
        'שים לב לעצמך!',
        'זה מתחיל להיות רציני!',
      ],
      5: [
        'תזכור, זה רק משחק...',
        'הערב הזה יהיה בלתי נשכח!',
        'חמש פעמים, לא מתייאש!',
        'האמיצים לא מפחדים!',
        'או שמנצחים גדול או...',
        'עכשיו זה אישי!',
        'לא יום רגיל!',
        'כבוד על ההתמדה!',
      ],
    };
    
    // Messages for 6-9 buyins (dramatic/creative)
    const highMessages = [
      'אגדות נולדות ככה!',
      'או גיבור או... נו, אתה יודע!',
      'מחר זה יום חדש!',
      'אתה כותב היסטוריה!',
      'הלילה הזה יזכר לעד!',
      'לב אמיץ יש לך!',
      'זה כבר מעבר לפוקר!',
      'סיפור לנכדים!',
      'אין דרך חזרה!',
      'עד הסוף!',
      'כל הכבוד על האומץ!',
      'שחקן אמיתי!',
      'לא כל יום רואים כזה דבר!',
      'תקרא לגינס!',
      'וואו, פשוט וואו!',
    ];
    
    // Messages for 10+ buyins (final approval)
    const finalMessages = [
      'זאת הפעם האחרונה שאני מאשר לך!',
      'רשמית, זה מספיק להיום!',
      'אני כבר לא אחראי!',
      'אתה בעצמך מעכשיו!',
      'הגעת למקסימום שפוי!',
      'אחרי זה, אין לי מה להגיד!',
      'תעצור כאן, בבקשה!',
      'האחרון שאני מכריז עליו!',
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
  const speakBuyin = async (playerName: string, totalBuyins: number, isQuickRebuy: boolean) => {
    // Play cash register sound first
    await playCashSound();
    
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      
      const voices = window.speechSynthesis.getVoices();
      const hebrewVoice = voices.find(v => v.lang.startsWith('he')) || null;
      
      // Build the full Hebrew message
      const creativeMessage = getBuyinMessage(totalBuyins, isQuickRebuy);
      const fullMessage = `${playerName} קנה. סה"כ ${totalBuyins}. ${creativeMessage}`;
      
      const utterance = new SpeechSynthesisUtterance(fullMessage);
      utterance.lang = 'he-IL';
      if (hebrewVoice) utterance.voice = hebrewVoice;
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
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
    speakBuyin(player.playerName, newRebuys, isQuickRebuy);
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

