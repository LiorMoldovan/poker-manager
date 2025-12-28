import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { GamePlayer, GameAction, SharedExpense } from '../types';
import { getGamePlayers, updateGamePlayerRebuys, getSettings, updateGameStatus, getGame, updateGame, addSharedExpense, removeSharedExpense, updateSharedExpense } from '../database/storage';
import { cleanNumber } from '../utils/calculations';
import { usePermissions } from '../App';
import AddExpenseModal from '../components/AddExpenseModal';

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
  const [sharedExpenses, setSharedExpenses] = useState<SharedExpense[]>([]);
  const [showExpenseModal, setShowExpenseModal] = useState(false);
  const [editingExpense, setEditingExpense] = useState<SharedExpense | null>(null);
  
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
    
    // Load existing shared expenses
    const game = getGame(gameId);
    if (game?.sharedExpenses) {
      setSharedExpenses(game.sharedExpenses);
    }
    
    setIsLoading(false);
  };
  
  const handleAddExpense = (expense: SharedExpense) => {
    if (!gameId) return;
    
    // Check if we're editing an existing expense
    if (editingExpense) {
      updateSharedExpense(gameId, expense);
      setSharedExpenses(prev => prev.map(e => e.id === expense.id ? expense : e));
      setEditingExpense(null);
    } else {
      addSharedExpense(gameId, expense);
      setSharedExpenses(prev => [...prev, expense]);
    }
  };
  
  const handleEditExpense = (expense: SharedExpense) => {
    setEditingExpense(expense);
    setShowExpenseModal(true);
  };
  
  const handleRemoveExpense = (expenseId: string) => {
    if (!gameId) return;
    removeSharedExpense(gameId, expenseId);
    setSharedExpenses(prev => prev.filter(e => e.id !== expenseId));
  };
  
  const handleCloseExpenseModal = () => {
    setShowExpenseModal(false);
    setEditingExpense(null);
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

  // Casino rebuy sounds - randomly picks from 20 different sounds
  const playRebuyCasinoSound = (): Promise<void> => {
    return new Promise((resolve) => {
      try {
        const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
        
        // Helper functions
        const tone = (freq: number, start: number, dur: number, type: OscillatorType = 'sine', vol: number = 0.2) => {
          const osc = audioContext.createOscillator();
          const gain = audioContext.createGain();
          osc.type = type;
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(vol, audioContext.currentTime + start);
          gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + start + dur);
          osc.connect(gain);
          gain.connect(audioContext.destination);
          osc.start(audioContext.currentTime + start);
          osc.stop(audioContext.currentTime + start + dur);
        };

        const noise = (start: number, dur: number, vol: number = 0.15) => {
          const bufferSize = audioContext.sampleRate * dur;
          const buffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate);
          const data = buffer.getChannelData(0);
          for (let i = 0; i < bufferSize; i++) {
            data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.15));
          }
          const source = audioContext.createBufferSource();
          const gainNode = audioContext.createGain();
          source.buffer = buffer;
          gainNode.gain.value = vol;
          source.connect(gainNode);
          gainNode.connect(audioContext.destination);
          source.start(audioContext.currentTime + start);
        };

        const metallic = (freq: number, start: number, dur: number, vol: number = 0.2) => {
          [1, 2.4, 4.5, 6.8].forEach((mult, i) => {
            tone(freq * mult, start, dur * (1 - i * 0.15), 'sine', vol / (i + 1.5));
          });
        };

        const chord = (freqs: number[], start: number, dur: number, type: OscillatorType = 'triangle', vol: number = 0.15) => {
          freqs.forEach(f => tone(f, start, dur, type, vol));
        };

        // 20 different casino sounds
        const sounds = [
          // 1. Hero Returns - triumphant comeback
          () => {
            chord([261, 329], 0, 0.3, 'triangle', 0.15);
            chord([329, 392], 0.25, 0.3, 'triangle', 0.18);
            chord([392, 523], 0.5, 0.4, 'triangle', 0.2);
            chord([523, 659, 784], 0.8, 0.6, 'triangle', 0.25);
            noise(0.8, 0.1, 0.15);
            return 1400;
          },
          // 2. Second Chance
          () => {
            tone(440, 0, 0.2, 'sine', 0.2);
            tone(554, 0.15, 0.2, 'sine', 0.22);
            tone(659, 0.3, 0.2, 'sine', 0.24);
            tone(880, 0.45, 0.4, 'sine', 0.28);
            metallic(2000, 0.5, 0.2, 0.1);
            return 900;
          },
          // 3. Revenge Mode
          () => {
            tone(110, 0, 0.3, 'sawtooth', 0.15);
            tone(147, 0.1, 0.25, 'sawtooth', 0.15);
            tone(220, 0.2, 0.3, 'square', 0.12);
            for (let i = 0; i < 4; i++) tone(440 + i * 110, 0.35 + i * 0.08, 0.2, 'square', 0.12);
            noise(0.55, 0.15, 0.2);
            tone(880, 0.65, 0.4, 'sawtooth', 0.18);
            return 1100;
          },
          // 4. Back in Action
          () => {
            tone(523, 0, 0.08, 'square', 0.15);
            tone(659, 0.07, 0.08, 'square', 0.15);
            tone(784, 0.14, 0.08, 'square', 0.15);
            tone(1047, 0.21, 0.2, 'triangle', 0.22);
            noise(0.25, 0.05, 0.1);
            return 450;
          },
          // 5. Monster Pot
          () => {
            for (let i = 0; i < 6; i++) tone(200 + i * 50, i * 0.08, 0.15, 'sawtooth', 0.1);
            chord([523, 659, 784], 0.5, 0.5, 'triangle', 0.2);
            chord([784, 988, 1175], 0.7, 0.6, 'triangle', 0.22);
            for (let i = 0; i < 12; i++) {
              noise(0.5 + i * 0.05, 0.06, 0.12);
              metallic(2000 + Math.random() * 1500, 0.55 + i * 0.06, 0.08, 0.08);
            }
            chord([1047, 1319, 1568], 1.0, 0.7, 'sine', 0.25);
            return 1700;
          },
          // 6. All-In Victory
          () => {
            tone(150, 0, 0.3, 'sawtooth', 0.12);
            noise(0.2, 0.1, 0.2);
            chord([392, 494, 587], 0.35, 0.3, 'triangle', 0.18);
            chord([523, 659, 784], 0.55, 0.4, 'triangle', 0.22);
            chord([784, 988, 1175], 0.8, 0.5, 'triangle', 0.25);
            for (let i = 0; i < 6; i++) metallic(2500, 0.9 + i * 0.08, 0.1, 0.08);
            return 1400;
          },
          // 7. Knockout
          () => {
            tone(80, 0, 0.2, 'sawtooth', 0.2);
            noise(0.1, 0.15, 0.25);
            tone(200, 0.2, 0.15, 'square', 0.15);
            tone(400, 0.3, 0.15, 'square', 0.15);
            chord([523, 659, 784], 0.45, 0.4, 'triangle', 0.2);
            for (let i = 0; i < 8; i++) metallic(2000 + i * 200, 0.5 + i * 0.05, 0.08, 0.1);
            return 1000;
          },
          // 8. Ship It!
          () => {
            for (let i = 0; i < 15; i++) noise(i * 0.04, 0.05, 0.15 + i * 0.01);
            for (let i = 0; i < 8; i++) metallic(2000 + Math.random() * 1000, 0.3 + i * 0.06, 0.1, 0.1);
            tone(600, 0.7, 0.2, 'sine', 0.15);
            tone(800, 0.8, 0.25, 'sine', 0.18);
            return 1100;
          },
          // 9. Fresh Stack
          () => {
            for (let i = 0; i < 8; i++) {
              const t = i * 0.08;
              noise(t, 0.04, 0.2);
              metallic(2200 + i * 100, t + 0.02, 0.08, 0.12);
            }
            tone(523, 0.7, 0.2, 'sine', 0.15);
            return 950;
          },
          // 10. Chip Reload
          () => {
            for (let i = 0; i < 6; i++) {
              noise(i * 0.1, 0.03, 0.18);
              metallic(2400, i * 0.1 + 0.015, 0.06, 0.15);
            }
            tone(880, 0.65, 0.15, 'sine', 0.12);
            tone(1047, 0.75, 0.2, 'sine', 0.15);
            return 1000;
          },
          // 11. Money Drop
          () => {
            noise(0, 0.08, 0.3);
            metallic(2800, 0.02, 0.15, 0.2);
            noise(0.12, 0.04, 0.15);
            metallic(2400, 0.15, 0.12, 0.15);
            noise(0.22, 0.03, 0.1);
            return 400;
          },
          // 12. Buy-In Complete
          () => {
            tone(659, 0, 0.1, 'sine', 0.2);
            tone(784, 0.08, 0.1, 'sine', 0.2);
            tone(988, 0.16, 0.1, 'sine', 0.22);
            tone(1175, 0.24, 0.2, 'sine', 0.25);
            metallic(2000, 0.35, 0.15, 0.1);
            return 550;
          },
          // 13. Vegas Winner
          () => {
            const melody = [523, 659, 784, 1047, 784, 659, 784, 1047, 1319];
            melody.forEach((f, i) => tone(f, i * 0.1, 0.2, 'square', 0.1));
            for (let i = 0; i < 10; i++) noise(i * 0.08, 0.05, 0.08);
            chord([1047, 1319, 1568], 0.9, 0.5, 'triangle', 0.2);
            return 1400;
          },
          // 14. Jackpot Hit
          () => {
            for (let i = 0; i < 3; i++) {
              tone(800, i * 0.15, 0.08, 'square', 0.15);
              tone(1000, i * 0.15 + 0.04, 0.08, 'square', 0.15);
            }
            chord([523, 659, 784, 1047], 0.5, 0.6, 'triangle', 0.2);
            for (let i = 0; i < 20; i++) metallic(2000 + Math.random() * 2000, 0.55 + i * 0.04, 0.06, 0.06);
            return 1400;
          },
          // 15. Lucky Strike
          () => {
            metallic(3000, 0, 0.3, 0.2);
            tone(880, 0.1, 0.2, 'sine', 0.2);
            tone(1175, 0.2, 0.2, 'sine', 0.22);
            tone(1397, 0.3, 0.3, 'sine', 0.25);
            metallic(3500, 0.4, 0.2, 0.15);
            return 700;
          },
          // 16. Table Winner
          () => {
            chord([392, 494], 0, 0.2, 'triangle', 0.15);
            chord([523, 659], 0.18, 0.2, 'triangle', 0.18);
            chord([659, 784, 988], 0.36, 0.35, 'triangle', 0.22);
            for (let i = 0; i < 5; i++) noise(0.5 + i * 0.06, 0.05, 0.1);
            return 850;
          },
          // 17. Power Up
          () => {
            const notes = [262, 330, 392, 523, 659, 784, 1047];
            notes.forEach((f, i) => tone(f, i * 0.05, 0.15, 'square', 0.08 + i * 0.02));
            tone(1047, 0.4, 0.3, 'sine', 0.2);
            return 750;
          },
          // 18. Level Up
          () => {
            tone(392, 0, 0.12, 'triangle', 0.2);
            tone(523, 0.1, 0.12, 'triangle', 0.22);
            tone(659, 0.2, 0.12, 'triangle', 0.24);
            tone(784, 0.3, 0.25, 'triangle', 0.28);
            metallic(2500, 0.4, 0.15, 0.12);
            return 600;
          },
          // 19. Cha-Ching
          () => {
            noise(0, 0.05, 0.2);
            tone(1200, 0.03, 0.08, 'square', 0.2);
            tone(1500, 0.1, 0.08, 'square', 0.2);
            tone(2000, 0.18, 0.15, 'sine', 0.25);
            metallic(2800, 0.25, 0.2, 0.15);
            return 500;
          },
          // 20. Ready to Roll
          () => {
            tone(330, 0, 0.1, 'sawtooth', 0.12);
            tone(440, 0.08, 0.1, 'sawtooth', 0.12);
            tone(554, 0.16, 0.1, 'sawtooth', 0.14);
            tone(659, 0.24, 0.15, 'triangle', 0.18);
            tone(880, 0.35, 0.25, 'triangle', 0.22);
            noise(0.4, 0.08, 0.1);
            return 650;
          },
        ];

        // Pick a random sound and play it
        const randomIndex = Math.floor(Math.random() * sounds.length);
        
        // Resume AudioContext if suspended (required on some browsers)
        if (audioContext.state === 'suspended') {
          audioContext.resume();
        }
        
        const duration = sounds[randomIndex]();
        
        setTimeout(resolve, duration);
      } catch (e) {
        console.log('Could not play rebuy sound:', e);
        resolve();
      }
    });
  };

  // Creative messages for each REBUY (not total buyins)
  // rebuyNumber = totalBuyins - 1 (since everyone starts with 1 buyin)
  // All sentences are gender-neutral (no "אתה/את") for natural female voice
  const getBuyinMessage = (totalBuyins: number, isQuickRebuy: boolean): string => {
    // Calculate rebuy number (first rebuy = 1, not 2)
    const rebuyNumber = Math.max(1, totalBuyins - 1);
    
    // Quick rebuy messages (< 5 min since last) - no gender
    const quickMessages = [
      'תנשום קצת בין הקניות',
      'תזכור שזה על כסף אמיתי',
    ];
    
    // Messages by REBUY number (not total) - gender neutral, natural Hebrew
    const messages: Record<number, string[]> = {
      1: [
        // First rebuy - encouraging
        'הכל יהיה בסדר',
        'עכשיו מתחילים ברצינות',
        'לא נורא, הערב עוד ארוך',
        'עוד הזדמנות',
        'הפעם זה יעבוד',
        'בהצלחה הפעם',
        'זו רק ההתחלה',
        'המזל ישתנה',
        'הלילה עוד צעיר',
        'עכשיו באמת מתחילים',
      ],
      2: [
        // Second rebuy - still positive
        'לא נורא, יהיה בסדר',
        'זה קורה לכולם',
        'עדיין בתחילת הדרך',
        'אין מה לדאוג',
        'הכל עוד יכול להשתנות',
        'זה חלק מהמשחק',
        'נשאר חיובי',
        'הערב עוד לא נגמר',
      ],
      3: [
        // Third rebuy - mild concern
        'פעם שלישית גלידה',
        'נו טוב, עכשיו ברצינות',
        'בוא נשנה את המזל',
        'עדיין יש סיכוי',
        'שלוש זה מספר מזל',
        'עכשיו באמת צריך להתרכז',
        'בוא נהיה חכמים מכאן',
        'אוקיי, עכשיו ברצינות',
      ],
      4: [
        // Fourth rebuy - concern
        'כבר ארבע, שימו לב',
        'מתחיל להיות יקר',
        'אולי הפסקה קטנה',
        'וואו, ארבע כבר',
      ],
      5: [
        // Fifth rebuy - serious
        'חמש כבר, רציני',
        'ערב יקר הולך להיות',
        'בטוח שכדאי להמשיך',
        'חמש זה הרבה',
      ],
    };
    
    // Messages for 6-8 rebuys
    const highMessages = [
      'שיא אישי בדרך',
      'נו באמת, מספיק',
      'שוברים שיאים הלילה',
      'זה כבר מוגזם',
    ];
    
    // Messages for 9+ rebuys
    const finalMessages = [
      'בבקשה לעצור',
      'מספיק להיום',
      'די, נגמר',
      'הביתה, יאללה',
    ];
    
    let message: string;
    
    if (rebuyNumber >= 9) {
      message = finalMessages[Math.floor(Math.random() * finalMessages.length)];
    } else if (rebuyNumber >= 6) {
      message = highMessages[Math.floor(Math.random() * highMessages.length)];
    } else {
      const levelMessages = messages[rebuyNumber] || messages[5];
      message = levelMessages[Math.floor(Math.random() * levelMessages.length)];
    }
    
    // Use ONLY quick rebuy message if applicable (only for 2nd rebuy onwards)
    if (isQuickRebuy && rebuyNumber > 1) {
      message = quickMessages[Math.floor(Math.random() * quickMessages.length)];
    }
    
    return message;
  };

  // Text-to-speech for buyin announcements - ALL HEBREW
  const speakBuyin = async (playerName: string, totalBuyins: number, isQuickRebuy: boolean, isHalfBuyin: boolean) => {
    // Play random casino sound first
    await playRebuyCasinoSound();
    
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      
      // Get available voices - prefer Hebrew female voice for natural sound
      const voices = window.speechSynthesis.getVoices();
      const hebrewVoice = voices.find(v => v.lang.startsWith('he') && v.name.toLowerCase().includes('female')) 
        || voices.find(v => v.lang.startsWith('he'))
        || null;
      
      // Check if total has half (0.5) - use tolerance for floating point
      const hasHalf = Math.abs((totalBuyins % 1) - 0.5) < 0.01;
      const whole = Math.floor(totalBuyins);
      
      // Hebrew numbers for speech - feminine forms for female voice
      const hebrewNumbers = ['אפס', 'אחת', 'שתיים', 'שלוש', 'ארבע', 'חמש', 'שש', 'שבע', 'שמונה', 'תשע', 'עשר'];
      
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
      
      // Use neutral "לקח/לקחה" (took) instead of gendered "קנה/קנתה"
      // Or use simple "עוד" (another) for natural flow
      let buyAction: string;
      if (isHalfBuyin) {
        buyAction = 'עוד חצי';
      } else {
        buyAction = 'עוד אחד';
      }
      
      const creativeMessage = getBuyinMessage(Math.ceil(totalBuyins), isQuickRebuy);
      const fullMessage = `${playerName}, ${buyAction}. סך הכל ${totalText}. ${creativeMessage}`;
      
      const utterance = new SpeechSynthesisUtterance(fullMessage);
      utterance.lang = 'he-IL';
      if (hebrewVoice) utterance.voice = hebrewVoice;
      utterance.rate = 0.9;   // Natural pace
      utterance.pitch = 1.0;  // Natural pitch for female voice
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
    const isQuickRebuy = lastRebuyTime > 0 && (now - lastRebuyTime) < 5 * 60 * 1000; // 5 minutes
    
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

      {/* Shared Expenses Section - Compact */}
      <div className="card" style={{ padding: '0.6rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
          <span style={{ fontSize: '0.9rem', fontWeight: '600' }}>🍕 Expenses</span>
          <button 
            className="btn btn-sm btn-primary"
            onClick={() => setShowExpenseModal(true)}
            style={{ padding: '0.2rem 0.5rem', fontSize: '0.7rem' }}
          >
            + Add
          </button>
        </div>
        
        {sharedExpenses.length === 0 ? (
          <div className="text-muted" style={{ textAlign: 'center', padding: '0.5rem', fontSize: '0.75rem' }}>
            No expenses yet
          </div>
        ) : (
          <>
            {sharedExpenses.map(expense => {
              const perPerson = expense.amount / expense.participants.length;
              return (
                <div key={expense.id} style={{ 
                  padding: '0.4rem', 
                  background: 'rgba(255,255,255,0.03)', 
                  borderRadius: '4px',
                  marginBottom: '0.3rem',
                  fontSize: '0.75rem'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <span style={{ fontWeight: '600' }}>{expense.description}</span>
                      <span className="text-muted" style={{ marginLeft: '0.3rem' }}>
                        ₪{cleanNumber(expense.amount)}
                      </span>
                      <span className="text-muted" style={{ marginLeft: '0.3rem', fontSize: '0.65rem' }}>
                        (₪{cleanNumber(perPerson)}/person)
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: '0.15rem' }}>
                      <button 
                        className="btn btn-sm btn-secondary"
                        onClick={() => handleEditExpense(expense)}
                        style={{ padding: '0.15rem 0.3rem', fontSize: '0.65rem' }}
                      >
                        ✏️
                      </button>
                      <button 
                        className="btn btn-sm btn-secondary"
                        onClick={() => handleRemoveExpense(expense.id)}
                        style={{ padding: '0.15rem 0.3rem', fontSize: '0.65rem' }}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                  <div className="text-muted" style={{ fontSize: '0.65rem', marginTop: '0.2rem', direction: 'rtl' }}>
                    <span style={{ fontSize: '0.8rem' }}>🍕</span> {expense.paidByName}
                    {' • '}
                    <span style={{ fontSize: '0.55rem' }}>🍕</span> {expense.participantNames.join(', ')}
                  </div>
                </div>
              );
            })}
            <div style={{ 
              padding: '0.3rem', 
              background: 'rgba(16, 185, 129, 0.1)', 
              borderRadius: '4px',
              textAlign: 'center',
              fontSize: '0.75rem',
            }}>
              Total: <span style={{ fontWeight: '600' }}>₪{cleanNumber(sharedExpenses.reduce((sum, e) => sum + e.amount, 0))}</span>
            </div>
          </>
        )}
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
              <span className="rebuy-count">{player.rebuys % 1 === 0.5 ? player.rebuys.toFixed(1) : player.rebuys}</span>
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

      {/* Expense Modal */}
      {showExpenseModal && (
        <AddExpenseModal
          players={players}
          onClose={handleCloseExpenseModal}
          onAdd={handleAddExpense}
          existingExpense={editingExpense || undefined}
        />
      )}
    </div>
  );
};

export default LiveGameScreen;

