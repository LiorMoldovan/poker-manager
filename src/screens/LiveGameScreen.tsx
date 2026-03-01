import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { GamePlayer, GameAction, SharedExpense } from '../types';
import { getGamePlayers, updateGamePlayerRebuys, getSettings, updateGameStatus, getGame, addSharedExpense, removeSharedExpense, updateSharedExpense, removeGamePlayer, getPlayerStats, getAllGames, getAllGamePlayers } from '../database/storage';
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
  const [playerToRemove, setPlayerToRemove] = useState<GamePlayer | null>(null);
  
  // Track last rebuy time per player for quick rebuy detection
  const lastRebuyTimeRef = useRef<Map<string, number>>(new Map());

  // Cache historical rebuy records (computed once per session)
  const rebuyRecordsRef = useRef<{ playerMax: Map<string, number>; groupMax: number } | null>(null);

  // Track "last man standing" so it's only announced once per game
  const lastManAnnouncedRef = useRef(false);

  // Track used TTS messages to avoid repetition within a game session
  const usedMessagesRef = useRef<Set<string>>(new Set());

  const getRebuyRecords = () => {
    if (rebuyRecordsRef.current) return rebuyRecordsRef.current;

    const completedGames = getAllGames().filter(g => {
      if (g.status !== 'completed') return false;
      const year = new Date(g.date || g.createdAt).getFullYear();
      return year >= 2026;
    });
    const completedIds = new Set(completedGames.map(g => g.id));
    const allGP = getAllGamePlayers().filter(gp => completedIds.has(gp.gameId));

    const playerMax = new Map<string, number>();
    let groupMax = 0;

    for (const gp of allGP) {
      const current = playerMax.get(gp.playerId) || 0;
      if (gp.rebuys > current) playerMax.set(gp.playerId, gp.rebuys);
      if (gp.rebuys > groupMax) groupMax = gp.rebuys;
    }

    rebuyRecordsRef.current = { playerMax, groupMax };
    return rebuyRecordsRef.current;
  };
  
  // Shared AudioContext to avoid creating too many instances (browsers have limits)
  const audioContextRef = useRef<AudioContext | null>(null);

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

  // Remove a player who didn't show up (only if they haven't rebought yet)
  const handleRemovePlayer = (player: GamePlayer) => {
    if (player.rebuys > 1) {
      // Player has already rebought, can't remove
      alert('לא ניתן להסיר שחקן שכבר עשה ריביי. אפשר להמשיך עם 0 ג\'יפים בסוף המשחק.');
      return;
    }
    setPlayerToRemove(player);
  };

  const confirmRemovePlayer = () => {
    if (!playerToRemove) return;
    const success = removeGamePlayer(playerToRemove.id);
    if (success) {
      setPlayers(prev => prev.filter(p => p.id !== playerToRemove.id));
    }
    setPlayerToRemove(null);
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

  // Get or create shared AudioContext (reuse to avoid browser limits)
  const getAudioContext = (): AudioContext => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    return audioContextRef.current;
  };

  // Casino rebuy sounds - mood shifts based on rebuy count
  const playRebuyCasinoSound = (totalBuyins: number): Promise<void> => {
    return new Promise((resolve) => {
      try {
        const audioContext = getAudioContext();
        
        // Resume AudioContext if suspended (required on some browsers after user interaction)
        if (audioContext.state === 'suspended') {
          audioContext.resume();
        }
        
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
          // 21. Sad Trombone - "wah wah wah wahhh"
          () => {
            tone(350, 0, 0.35, 'sawtooth', 0.18);
            tone(330, 0.35, 0.35, 'sawtooth', 0.18);
            tone(311, 0.7, 0.35, 'sawtooth', 0.18);
            tone(233, 1.05, 0.7, 'sawtooth', 0.22);
            return 1800;
          },
          // 22. Funeral March - slow somber chords
          () => {
            chord([147, 175, 220], 0, 0.6, 'sine', 0.15);
            chord([131, 165, 196], 0.7, 0.6, 'sine', 0.15);
            chord([123, 147, 185], 1.4, 0.8, 'sine', 0.18);
            return 2200;
          },
          // 23. Dramatic Fail - descending chromatic to buzz
          () => {
            const notes = [523, 494, 466, 440, 415, 392, 370, 349, 330, 311, 294, 262];
            notes.forEach((f, i) => tone(f, i * 0.08, 0.12, 'square', 0.1));
            tone(100, 0.96, 0.6, 'sawtooth', 0.15);
            noise(0.96, 0.3, 0.15);
            return 1600;
          },
          // 24. Game Over - classic descending
          () => {
            tone(392, 0, 0.25, 'triangle', 0.2);
            tone(330, 0.3, 0.25, 'triangle', 0.2);
            tone(262, 0.6, 0.25, 'triangle', 0.2);
            tone(196, 0.9, 0.5, 'triangle', 0.25);
            return 1400;
          },
          // 25. Crying Violin - high pitched descending
          () => {
            for (let i = 0; i < 8; i++) {
              tone(880 - i * 60, i * 0.15, 0.2, 'sine', 0.12 + i * 0.01);
            }
            tone(350, 1.2, 0.6, 'sine', 0.18);
            return 1800;
          },
        ];

        // Select sound based on rebuy progression (mood escalation)
        let soundPool: number[];
        if (totalBuyins <= 2) {
          soundPool = [0, 1, 3, 11, 16, 17, 18, 19]; // Upbeat
        } else if (totalBuyins <= 4) {
          soundPool = [4, 5, 7, 8, 9, 10, 12]; // Neutral
        } else if (totalBuyins <= 6) {
          soundPool = [2, 6, 13, 14, 15]; // Ominous
        } else {
          soundPool = [20, 21, 22, 23, 24]; // Sad/dramatic
        }
        const selectedIndex = soundPool[Math.floor(Math.random() * soundPool.length)];
        const duration = sounds[selectedIndex]();
        
        setTimeout(resolve, duration);
      } catch (e) {
        console.log('Could not play rebuy sound:', e);
        resolve();
      }
    });
  };

  // Hebrew number with proper gender agreement for nouns
  // feminine=true for feminine nouns (קניות, פעמים, קנייה)
  // feminine=false for masculine nouns (נצחונות, הפסדים, משחקים, שחקנים, אחוז)
  const hebrewNum = (n: number, feminine: boolean): string => {
    const abs = Math.round(Math.abs(n));
    if (abs === 0) return 'אפס';
    const femOnes = ['', 'אחת', 'שתיים', 'שלוש', 'ארבע', 'חמש', 'שש', 'שבע', 'שמונה', 'תשע', 'עשר'];
    const mascOnes = ['', 'אחד', 'שניים', 'שלושה', 'ארבעה', 'חמישה', 'שישה', 'שבעה', 'שמונה', 'תשעה', 'עשרה'];
    const ones = feminine ? femOnes : mascOnes;
    if (abs <= 10) return ones[abs];
    if (abs <= 19) {
      const unit = abs - 10;
      const tenWord = feminine ? 'עשרה' : 'עשר';
      return `${ones[unit]} ${tenWord}`;
    }
    if (abs <= 99) {
      const tensWords = ['', '', 'עשרים', 'שלושים', 'ארבעים', 'חמישים', 'שישים', 'שבעים', 'שמונים', 'תשעים'];
      const ten = Math.floor(abs / 10);
      const unit = abs % 10;
      if (unit === 0) return tensWords[ten];
      return `${tensWords[ten]} ו${ones[unit]}`;
    }
    if (abs === 100) return 'מאה';
    return String(abs);
  };

  // Creative messages by total buyins count (including the initial buy-in)
  // Numbers in sentences match totalBuyins so they align with "סך הכל X" in the announcement
  // All sentences are gender-neutral (no "אתה/את") for natural female voice
  const getBuyinMessage = (totalBuyins: number, isQuickRebuy: boolean): string => {
    // Quick rebuy messages (< 5 min since last) - no gender
    const quickMessages = [
      'תנשום קצת בין הקניות',
      'תזכור שזה על כסף אמיתי',
      'לאט לאט, אין מה למהר',
      'רגע, עוד אחד ככה מהר',
      'וואו, זה היה מהיר',
      'שנייה, מה קרה שם',
      'קצב מרשים של קניות',
      'הכסף נעלם כמו קסם',
      'וואלה, אפילו לא הספקנו לשתות',
      'מהיר, כמו כספומט אנושי',
      'יש פה מירוץ שאני לא יודעת עליו?',
    ];
    
    // Messages keyed by totalBuyins - gender neutral, natural Hebrew
    const messages: Record<number, string[]> = {
      2: [
        'הכל יהיה בסדר',
        'עכשיו מתחילים ברצינות',
        'לא נורא, הערב עוד ארוך',
        'הפעם זה יעבוד',
        'זו רק ההתחלה',
        'הערב עוד צעיר',
        'קורה לטובים ביותר',
        'חימום נגמר, עכשיו ברצינות',
        'זה היה רק אימון',
        'מוכנים לסיבוב שני',
        'הראשון תמיד על חשבון הבית, רגע, אין בית',
        'זה בסדר, תחשוב על זה כתרומה לקהילה',
        'עוד מעט נראה את הקלפים שאמורים לבוא',
        'טוב שבאת עם ארנק מלא',
        'נו, לפחות עכשיו יודעים שהערב לא יהיה משעמם',
      ],
      3: [
        'זה קורה לכולם',
        'הכל עוד יכול להשתנות',
        'זה חלק מהמשחק',
        'עדיין בטווח הנורמלי',
        'ראינו קאמבקים יותר גדולים',
        'עוד הכל פתוח',
        'מכאן רק למעלה',
        'שלוש קניות, זה עדיין קניות רגילות, נכון?',
        'תשמע, הקלפים חייבים לך טובה אחרי הכל',
        'לפחות תורם לאווירה הטובה',
        'אם תנצח עכשיו זה יהיה סיפור מעולה',
        'הכסף יחזור, אולי לא הערב, אבל יחזור',
        'בוא נקרא לזה השקעה ארוכת טווח',
        'אל דאגה, עוד ישבו פה כולם ויספרו על הקאמבק',
      ],
      4: [
        'נו טוב, עכשיו ברצינות',
        'עדיין יש סיכוי',
        'עכשיו באמת צריך להתרכז',
        'אוקיי, עכשיו ברצינות',
        'מכאן כל יד חשובה',
        'עכשיו צריך לשחק חכם',
        'הפעם זה יעבוד, מרגיש את זה',
        'ארבע קניות, הארנק כבר לא מדבר',
        'באנק אישי שלם על השולחן',
        'אני מתחילה לדאוג, אבל לא עלייך',
        'אולי פשוט תשב ותחכה ליד אחת טובה',
        'הקלפים ישלמו על זה בסוף',
        'נו, לפחות כולם שמחים לראות אותך קונה',
      ],
      5: [
        'מתחיל להיות יקר',
        'ערב לא פשוט',
        'אוקיי, זה כבר רציני',
        'זה מתחיל להצטבר',
        'חמש קניות, האשראי בסדר?',
        'הבנק מתקשר, לא עונים',
        'אם זה היה קזינו כבר היו מביאים שתייה חינם',
        'חמש, אבל מי סופר, חוץ ממני',
        'תודה על המימון, באמת',
        'הקופה אומרת תודה',
      ],
      6: [
        'שש כבר, רציני',
        'ערב יקר הולך להיות',
        'שש זה הרבה',
        'הערב הזה יזכר',
        'שש בפנים',
        'הולך להיות סיפור',
        'שש קניות, השולחן שמח, הארנק פחות',
        'אני לא שופטת, אני רק סופרת',
        'כולם מחייכים, חוץ מחשבון הבנק',
        'לפחות הערב לא ישכח אותך',
        'מימנת את חצי מהקופה, תודה',
        'שש, אבל האופטימיות עדיין חיה',
      ],
    };
    
    const highMessages = [
      'שיא אישי בדרך',
      'שוברים שיאים הערב',
      'הערב הזה יכנס להיסטוריה',
      'מה קורה פה בכלל',
      'שיא חדש מתקרב',
      'הערב הזה יעלה ביוקר',
      'אני כבר לא יודעת מה להגיד',
      'אפשר לפתוח כבר חשבונית',
      'אם זה היה ספורט זה היה שיא עולם',
      'הספונסר הרשמי של הערב',
      'אפשר לקרוא לזה נדיבות, לא חוסר מזל',
      'כולם חייבים לך על הערב המעולה',
    ];
    
    const finalMessages = [
      'בבקשה לעצור',
      'אין מילים',
      'שיא שלא ישבר בקרוב',
      'יכנס לספר השיאים',
      'נו, מספיק באמת',
      'אפשר כבר להגיד שזה ערב של שיאים',
      'כבר לא מצחיק, טוב אולי קצת',
      'הכסף הזה הולך למקום טוב, לכיסים של החברים',
      'אני חושבת שהקלפים פשוט לא אוהבים אותך הערב',
      'אנחנו מעריכים את המחויבות',
      'תראה את זה ככה, עשית ערב מעולה לכולם',
      'לפחות יש לך סיפור טוב למחר',
    ];
    
    let message: string;
    
    if (totalBuyins >= 10) {
      message = finalMessages[Math.floor(Math.random() * finalMessages.length)];
    } else if (totalBuyins >= 7) {
      message = highMessages[Math.floor(Math.random() * highMessages.length)];
    } else {
      const levelMessages = messages[totalBuyins] || messages[6];
      message = levelMessages[Math.floor(Math.random() * levelMessages.length)];
    }
    
    // Use ONLY quick rebuy message if applicable (only for 3rd+ total buyin)
    if (isQuickRebuy && totalBuyins > 2) {
      message = quickMessages[Math.floor(Math.random() * quickMessages.length)];
    }
    
    return message;
  };

  // Personal traits for permanent players — used to generate unique flavor messages
  const playerTraits: Record<string, { team?: string; job?: string; style: string[]; nickname?: string; quirks: string[] }> = {
    p1: { job: 'הייטק', team: 'מכבי הרצליה', style: ['מחושב'], quirks: ['מנצח עם מעט קניות', 'שחקן אסטרטגי'] },
    p2: { job: 'פיננסים', team: 'הפועל פתח תקווה', style: ['אגרסיבי', 'בלופר'], quirks: ['אמרגן הקבוצה', 'מתאם את המשחקים', 'הולך למשחקים של הפועל פתח תקווה למרות שלא באמת אוהד'] },
    p3: { job: 'מהנדס בטיחות', style: ['מחושב', 'אגרסיבי'], quirks: ['צנח חופשי', 'מהנדס בטיחות שמסתכן'] },
    p4: { job: 'מס הכנסה', team: 'הפועל כפר סבא', style: ['אגרסיבי', 'מזלן'], quirks: ['אבא לתינוק חדש', 'תמיד עייף', 'טוען שאין לו מזל'] },
    p5: { job: 'רואה חשבון', team: 'הפועל כפר סבא', style: ['בלופר', 'אגרסיבי'], quirks: ['אוהב נרגילה'] },
    p6: { job: 'בוחן תוכנה', nickname: 'איוון סטיבן', style: ['שמרני'], quirks: ['תמיד יוצא באפס', 'לאחרונה התחיל להפסיד', 'שחקן הכי שמרני בשולחן'] },
    p7: { team: 'הפועל פתח תקווה', style: ['מזלן'], quirks: ['מהלכים מוזרים', 'אוהב חטיפים ועוגות', 'אף אחד לא מבין את המשחק שלו'] },
    p8: { job: 'מנהל מוצר', team: 'באיירן מינכן', style: ['בלופר', 'מזלן', 'רגשי'], quirks: ['מחפש עסקאות מפוקפקות', 'רגשי על השולחן'] },
    p9: { team: 'מכבי תל אביב', style: ['מחושב', 'אגרסיבי'], quirks: ['אבא לתינוק חדש'] },
    p10: { job: 'IT', style: ['רגשי', 'בלופר', 'מזלן'], quirks: ['אוהב לעשן'] },
    p11: { job: 'הייטק', style: ['מחושב'], quirks: ['משחק כדורעף', 'משחק פוקר כמו מחשבון'] },
  };

  // Personalized messages using player stats, history, and table context
  // Always tries to return something specific to the player; null only if no history
  const getPersonalMessage = (
    playerName: string,
    playerId: string,
    currentGameRebuys: number,
    isQuickRebuy: boolean,
    allPlayers: GamePlayer[]
  ): string | null => {
    try {
      const allStats = getPlayerStats();
      const stats = allStats.find(s => s.playerId === playerId);
      if (!stats || stats.gamesPlayed < 2) return null;

      const stats2026 = getPlayerStats({ start: new Date('2026-01-01') }).find(s => s.playerId === playerId);
      const settings = getSettings();
      const messages: string[] = [];

      // --- Current streak ---
      const streak = stats.currentStreak;
      const absStreak = Math.abs(streak);
      if (streak >= 4) {
        messages.push(`${playerName} על רצף של ${hebrewNum(streak, false)} נצחונות, מתי זה יגמר?`);
        messages.push(`${hebrewNum(streak, false)} נצחונות רצוף של ${playerName}, אבל הקניות אומרות אחרת`);
        messages.push(`${playerName} על רצף חם של ${hebrewNum(streak, false)}, הערב יבדק`);
        messages.push(`${playerName} שולט, ${hebrewNum(streak, false)} נצחונות רצוף, הערב יראה אם זה ממשיך`);
        messages.push(`רצף של ${hebrewNum(streak, false)} של ${playerName}, אבל הקניות מספרות סיפור אחר`);
        messages.push(`${playerName} לא מפסיק לנצח, כבר ${hebrewNum(streak, false)} רצוף, הערב נראה קצת אחרת`);
      } else if (streak === 3) {
        messages.push(`${playerName} על רצף של שלושה נצחונות, מעניין כמה זה יחזיק`);
        messages.push(`שלושה נצחונות רצוף של ${playerName}, הקניות לא מסתדרות עם זה`);
        messages.push(`${playerName} ניצח שלושה רצוף, אז למה קונה?`);
        messages.push(`שלושה רצוף של ${playerName}, מסתבר שגם מנצחים קונים`);
      } else if (streak === 2) {
        messages.push(`${playerName} ניצח פעמיים רצוף, הערב יהיה שלישי?`);
        messages.push(`${playerName} על רצף קטן, פעמיים רצוף, נראה מה הערב יביא`);
        messages.push(`פעמיים רצוף של ${playerName}, אבל הערב נראה קצת אחרת`);
      } else if (streak <= -4) {
        messages.push(`${playerName} עם ${hebrewNum(absStreak, false)} הפסדים רצוף, הקניות לא יפתרו את זה`);
        messages.push(`${hebrewNum(absStreak, false)} הפסדים רצוף של ${playerName}, אין מילים`);
        messages.push(`${playerName} עם ${hebrewNum(absStreak, false)} הפסדים, הערב חייב להשתנות`);
        messages.push(`${playerName}, ${hebrewNum(absStreak, false)} הפסדים רצוף, הגיע הזמן לשבור את הרצף`);
        messages.push(`עוד הפסד של ${playerName}, כבר ${hebrewNum(absStreak, false)} רצוף, מתי זה נגמר?`);
        messages.push(`${hebrewNum(absStreak, false)} רצוף של ${playerName}, הסטטיסטיקה לא לטובתו`);
      } else if (streak === -3) {
        messages.push(`${playerName} עם שלושה הפסדים רצוף, אולי הערב זה ישתנה`);
        messages.push(`שלושה הפסדים רצוף של ${playerName}, הערב מוכרח להיות אחר`);
        messages.push(`${playerName} הפסיד שלושה רצוף, הערב חייב להיות שונה`);
        messages.push(`שלושה רצוף של ${playerName}, הסטטיסטיקה אומרת שמגיע לו נצחון`);
      } else if (streak === -2) {
        messages.push(`${playerName} הפסיד פעמיים רצוף, הערב צריך נצחון`);
        messages.push(`${playerName} עם שני הפסדים רצוף, הערב אמור להיות אחר`);
        messages.push(`פעמיים רצוף של ${playerName}, הגיע הזמן לשנות כיוון`);
      }

      // --- Win percentage ---
      const wp = Math.round(stats.winPercentage);
      if (wp >= 65 && stats.gamesPlayed >= 5) {
        messages.push(`${playerName} מנצח ${hebrewNum(wp, false)} אחוז מהמשחקים, אבל הערב הקניות אומרות אחרת`);
        messages.push(`${hebrewNum(wp, false)} אחוז נצחונות של ${playerName}, בדרך כלל לא צריך לקנות ככה`);
        messages.push(`${playerName} עם ${hebrewNum(wp, false)} אחוז נצחונות, הערב חריג`);
        messages.push(`מנצח ${hebrewNum(wp, false)} אחוז ועדיין קונה, ${playerName} הערב לא בקטע`);
      } else if (wp >= 55 && stats.gamesPlayed >= 5) {
        messages.push(`${playerName} מנצח ${hebrewNum(wp, false)} אחוז, מה קרה הערב?`);
        messages.push(`${hebrewNum(wp, false)} אחוז של ${playerName}, אבל הערב לא עובד`);
        messages.push(`${playerName} רגיל לנצח, ${hebrewNum(wp, false)} אחוז, אז מה קרה?`);
      } else if (wp <= 30 && stats.gamesPlayed >= 5) {
        messages.push(`${playerName} מנצח רק ${hebrewNum(wp, false)} אחוז מהמשחקים, הסטטיסטיקה מדברת`);
        messages.push(`${hebrewNum(wp, false)} אחוז נצחונות של ${playerName}, לפחות עקבי`);
        messages.push(`${playerName} עם ${hebrewNum(wp, false)} אחוז, הקניות לא מפתיעות`);
        messages.push(`רק ${hebrewNum(wp, false)} אחוז נצחונות, ${playerName} לפחות נהנה מהדרך`);
      } else if (wp <= 40 && stats.gamesPlayed >= 8) {
        messages.push(`${playerName} עם ${hebrewNum(wp, false)} אחוז נצחונות, צריך לשפר`);
        messages.push(`${hebrewNum(wp, false)} אחוז של ${playerName}, יש מקום לשיפור`);
        messages.push(`${playerName} מנצח ${hebrewNum(wp, false)} אחוז, הקניות לא עוזרות לסטטיסטיקה`);
      }

      // --- Overall profit/loss ---
      const profit = Math.round(stats.totalProfit);
      const absProfit = Math.round(Math.abs(stats.totalProfit));
      if (stats.totalProfit > 500) {
        messages.push(`${playerName} הרוויח ${profit} שקל סך הכל, יש מאיפה לקנות`);
        messages.push(`${playerName} עדיין פלוס ${profit} שקל, אז מה זה עוד קנייה`);
        messages.push(`פלוס ${profit} סך הכל של ${playerName}, הקניות לא מדאיגות`);
        messages.push(`${playerName} פלוס ${profit} שקל, כסף קטן בשבילו`);
      } else if (stats.totalProfit > 200) {
        messages.push(`${playerName} הרוויח ${profit} שקל סך הכל, יש מאיפה לקנות`);
        messages.push(`${playerName} עדיין פלוס ${profit} שקל, אז מה זה עוד קנייה`);
        messages.push(`${playerName} פלוס ${profit}, עדיין יש רווח לאבד`);
      } else if (stats.totalProfit > 0 && stats.totalProfit <= 200) {
        messages.push(`${playerName} עדיין פלוס ${profit} שקל, אבל זה מתכווץ`);
        messages.push(`${playerName} עם פלוס קטן של ${profit} שקל, הערב יקבע`);
        messages.push(`פלוס ${profit} של ${playerName} הולך ומתכווץ`);
      } else if (stats.totalProfit < -500) {
        messages.push(`${playerName} מינוס ${absProfit} שקל סך הכל, עוד קנייה זה טיפה בים`);
        messages.push(`${playerName} מנסה להחזיר ${absProfit} שקל מינוס, דרך ארוכה`);
        messages.push(`מינוס ${absProfit} סך הכל של ${playerName}, הערב לא ישנה הרבה`);
        messages.push(`${playerName} מינוס ${absProfit} שקל, עוד קנייה לא תורגש`);
      } else if (stats.totalProfit < -200) {
        messages.push(`${playerName} מינוס ${absProfit} שקל סך הכל, עוד קנייה זה טיפה בים`);
        messages.push(`${playerName} מנסה להחזיר ${absProfit} שקל, הצלחה עם זה`);
        messages.push(`${playerName} מינוס ${absProfit}, הערב עוד הזדמנות`);
      } else if (stats.totalProfit < -50) {
        messages.push(`${playerName} מינוס ${absProfit} שקל, הקניות לא עוזרות`);
        messages.push(`מינוס ${absProfit} של ${playerName}, הערב צריך שינוי מגמה`);
        messages.push(`${playerName} מינוס ${absProfit} שקל, נראה אם הערב ישפר`);
      }

      // --- Last game result ---
      if (stats.lastGameResults.length > 0) {
        const lastGame = stats.lastGameResults[0];
        const lastProfit = Math.round(lastGame.profit);
        const lastAbsProfit = Math.round(Math.abs(lastGame.profit));
        if (lastGame.profit > 200) {
          messages.push(`${playerName} ניצח ${lastProfit} שקל במשחק האחרון, הערב סיפור אחר`);
          messages.push(`אחרי נצחון של ${lastProfit} במשחק הקודם, ${playerName} חוזר לקנות`);
          messages.push(`${playerName} הגיע עם ביטחון אחרי ${lastProfit} שקל, אבל הערב לא פשוט`);
          messages.push(`נצחון גדול של ${lastProfit} במשחק הקודם, ${playerName} הערב מחזיר`);
        } else if (lastGame.profit > 0) {
          messages.push(`${playerName} ניצח ${lastProfit} במשחק האחרון, היום קצת אחרת`);
          messages.push(`אחרי פלוס ${lastProfit} במשחק הקודם, ${playerName} מתקשה הערב`);
          messages.push(`${playerName} ניצח ${lastProfit} שקל בפעם הקודמת, הערב הכיוון הפוך`);
        } else if (lastGame.profit < -200) {
          messages.push(`${playerName} הפסיד ${lastAbsProfit} במשחק האחרון, מנסה להחזיר`);
          messages.push(`אחרי הפסד של ${lastAbsProfit} במשחק הקודם, ${playerName} ממשיך לקנות`);
          messages.push(`${playerName} עם מינוס ${lastAbsProfit} מהפעם הקודמת, הערב ממשיך`);
          messages.push(`הפסד כבד של ${lastAbsProfit} בפעם הקודמת, ${playerName} לא מוותר`);
        } else if (lastGame.profit < -50) {
          messages.push(`${playerName} הפסיד ${lastAbsProfit} במשחק הקודם, הערב לא מתחיל טוב יותר`);
          messages.push(`מינוס ${lastAbsProfit} בפעם הקודמת של ${playerName}, הערב אותו דבר`);
          messages.push(`${playerName} הפסיד ${lastAbsProfit} במשחק הקודם, ועדיין קונה`);
        } else if (lastGame.profit < 0) {
          messages.push(`${playerName} סיים מינוס קטן בפעם הקודמת, הערב מקווה לטוב יותר`);
        }
      }

      // --- Avg profit per game ---
      if (stats.avgProfit > 80 && stats.gamesPlayed >= 5) {
        messages.push(`ממוצע של פלוס ${Math.round(stats.avgProfit)} למשחק של ${playerName}, הערב מוריד את הממוצע`);
        messages.push(`${playerName} מרוויח ממוצע ${Math.round(stats.avgProfit)} שקל, הערב לא עוזר`);
        messages.push(`ממוצע פלוס ${Math.round(stats.avgProfit)} של ${playerName}, הערב חריג`);
      } else if (stats.avgProfit > 30 && stats.gamesPlayed >= 5) {
        messages.push(`ממוצע של פלוס ${Math.round(stats.avgProfit)} למשחק של ${playerName}, הערב מוריד את הממוצע`);
        messages.push(`${playerName} ממוצע פלוס ${Math.round(stats.avgProfit)} למשחק, הערב משנה את המספרים`);
      } else if (stats.avgProfit < -80 && stats.gamesPlayed >= 5) {
        messages.push(`ממוצע של מינוס ${Math.round(Math.abs(stats.avgProfit))} למשחק של ${playerName}, הערב ממשיך את המגמה`);
        messages.push(`${playerName} מפסיד ממוצע ${Math.round(Math.abs(stats.avgProfit))} שקל, לפחות עקבי`);
        messages.push(`מינוס ${Math.round(Math.abs(stats.avgProfit))} ממוצע של ${playerName}, הערב לא עוזר`);
      } else if (stats.avgProfit < -30 && stats.gamesPlayed >= 5) {
        messages.push(`ממוצע של מינוס ${Math.round(Math.abs(stats.avgProfit))} למשחק של ${playerName}, הערב ממשיך את המגמה`);
        messages.push(`${playerName} ממוצע מינוס ${Math.round(Math.abs(stats.avgProfit))} למשחק, הערב לא משפר`);
      }

      // --- Games played milestones ---
      const gp = stats.gamesPlayed;
      if (gp >= 50) {
        messages.push(`${playerName} ותיק עם ${hebrewNum(gp, false)} משחקים, הניסיון לא עוזר הערב`);
        messages.push(`${hebrewNum(gp, false)} משחקים של ${playerName}, ועדיין קונה`);
        messages.push(`${playerName} כבר ${hebrewNum(gp, false)} משחקים, מכיר כל קלף ועדיין קונה`);
        messages.push(`ותיק של ${hebrewNum(gp, false)} משחקים, ${playerName} לא לומד מטעויות`);
      } else if (gp >= 30) {
        messages.push(`${playerName} כבר ${hebrewNum(gp, false)} משחקים, ולא מפסיק לקנות`);
        messages.push(`${hebrewNum(gp, false)} משחקים ו ${playerName} עדיין מממן את השולחן`);
        messages.push(`${playerName} עם ${hebrewNum(gp, false)} משחקים, הניסיון לא מונע קניות`);
      } else if (gp >= 15) {
        messages.push(`${hebrewNum(gp, false)} משחקים של ${playerName}, כבר מכיר את הדרך לארנק`);
        messages.push(`${playerName} עם ${hebrewNum(gp, false)} משחקים, כבר שחקן מנוסה`);
        messages.push(`${hebrewNum(gp, false)} משחקים ו ${playerName} עדיין לא למד`);
      } else if (gp >= 8) {
        messages.push(`${playerName} עם ${hebrewNum(gp, false)} משחקים, עוד לומד את השולחן`);
        messages.push(`${hebrewNum(gp, false)} משחקים של ${playerName}, עדיין צובר ניסיון`);
      } else if (gp <= 5) {
        messages.push(`${playerName} עם רק ${hebrewNum(gp, false)} משחקים, עדיין לומד לשלם`);
        messages.push(`${playerName} חדש יחסית, רק ${hebrewNum(gp, false)} משחקים`);
        messages.push(`רק ${hebrewNum(gp, false)} משחקים של ${playerName}, הניסיון יבוא`);
      }

      // --- Biggest win/loss references ---
      if (stats.biggestWin > 200) {
        messages.push(`הנצחון הגדול של ${playerName} היה ${Math.round(stats.biggestWin)} שקל, הערב בכיוון ההפוך`);
        messages.push(`${playerName} פעם ניצח ${Math.round(stats.biggestWin)} שקל, הערב זוכרים את זה`);
        messages.push(`שיא נצחון של ${Math.round(stats.biggestWin)} שקל, ${playerName} הערב רחוק מזה`);
      } else if (stats.biggestWin > 100) {
        messages.push(`הנצחון הגדול של ${playerName} היה ${Math.round(stats.biggestWin)} שקל, הערב בכיוון ההפוך`);
        messages.push(`${playerName} יודע לנצח, פעם לקח ${Math.round(stats.biggestWin)} שקל, הערב קצת אחרת`);
      }
      if (stats.biggestLoss < -200) {
        messages.push(`ההפסד הגדול של ${playerName} היה ${Math.round(Math.abs(stats.biggestLoss))} שקל, מקווים שהערב לא שם`);
        messages.push(`${playerName} פעם הפסיד ${Math.round(Math.abs(stats.biggestLoss))} שקל, הערב בדרך לשם?`);
        messages.push(`שיא הפסד של ${Math.round(Math.abs(stats.biggestLoss))} של ${playerName}, הערב עוד לא שם`);
      } else if (stats.biggestLoss < -100) {
        messages.push(`ההפסד הגדול של ${playerName} היה ${Math.round(Math.abs(stats.biggestLoss))} שקל, מקווים שהערב לא שם`);
        messages.push(`${playerName} פעם הפסיד ${Math.round(Math.abs(stats.biggestLoss))}, הערב מנסה לא לחזור על זה`);
      }

      // --- Longest streaks ---
      if (stats.longestWinStreak >= 4) {
        messages.push(`השיא של ${playerName} הוא ${hebrewNum(stats.longestWinStreak, false)} נצחונות רצוף, היום לא נראה שזה קורה`);
        messages.push(`${playerName} פעם ניצח ${hebrewNum(stats.longestWinStreak, false)} רצוף, הערב קצת אחרת`);
        messages.push(`רצף שיא של ${hebrewNum(stats.longestWinStreak, false)} נצחונות, ${playerName} הערב לא שם`);
      }
      if (stats.longestLossStreak >= 4) {
        messages.push(`${playerName} פעם הפסיד ${hebrewNum(stats.longestLossStreak, false)} רצוף, אז מה עוד קנייה`);
        messages.push(`שיא הפסדים של ${hebrewNum(stats.longestLossStreak, false)} רצוף, ${playerName} מכיר תקופות קשות`);
        messages.push(`${playerName} שרד ${hebrewNum(stats.longestLossStreak, false)} הפסדים רצוף, עוד קנייה לא תשבור אותו`);
      }

      // --- Avg win vs avg loss ---
      if (stats.avgWin > 0 && stats.avgLoss > 0) {
        if (stats.avgWin > stats.avgLoss * 1.5) {
          messages.push(`כאשר ${playerName} מנצח, זה גדול, ממוצע של ${Math.round(stats.avgWin)} שקל, הבעיה היא להגיע לשם`);
          messages.push(`${playerName} מנצח ממוצע ${Math.round(stats.avgWin)} שקל, חבל שזה לא קורה הערב`);
          messages.push(`ממוצע נצחון של ${Math.round(stats.avgWin)} שקל, ${playerName} צריך רק הזדמנות אחת`);
        } else if (stats.avgLoss > stats.avgWin * 1.5) {
          messages.push(`${playerName} מפסיד ממוצע ${Math.round(stats.avgLoss)} שקל ומנצח רק ${Math.round(stats.avgWin)}, נו, לפחות עקבי`);
          messages.push(`${playerName} מפסיד גדול ומנצח קטן, ממוצע מינוס ${Math.round(stats.avgLoss)} למשחק`);
          messages.push(`הפסד ממוצע של ${Math.round(stats.avgLoss)} מול נצחון ממוצע של ${Math.round(stats.avgWin)}, ${playerName} צריך לשנות משהו`);
        }
      }

      // --- Win count facts ---
      if (stats.winCount >= 10 && stats.gamesPlayed >= 15) {
        messages.push(`${playerName} ניצח ${hebrewNum(stats.winCount, false)} משחקים סך הכל, הערב לא אחד מהם`);
        messages.push(`${hebrewNum(stats.winCount, false)} נצחונות של ${playerName}, אבל הערב מוסיף לצד השני`);
      }
      if (stats.winCount <= 3 && stats.gamesPlayed >= 10) {
        messages.push(`${playerName} ניצח רק ${hebrewNum(stats.winCount, false)} מתוך ${hebrewNum(gp, false)} משחקים, הקניות לא מפתיעות`);
        messages.push(`רק ${hebrewNum(stats.winCount, false)} נצחונות של ${playerName} מתוך ${hebrewNum(gp, false)}, הסטטיסטיקה מדברת`);
      }

      // --- Rebuy-related (2026 data only) ---
      if (stats2026 && stats2026.gamesPlayed >= 2) {
        const avgRebuys = stats2026.avgRebuysPerGame;
        if (currentGameRebuys > avgRebuys * 1.5 && currentGameRebuys >= 3) {
          messages.push(`${playerName} ממוצע ${hebrewNum(Math.round(avgRebuys), true)} קניות למשחק, הערב כבר ${hebrewNum(currentGameRebuys, true)}`);
          messages.push(`${playerName} מעל הממוצע שלו הערב, רגיל קונה ${hebrewNum(Math.round(avgRebuys), true)} וכבר ${hebrewNum(currentGameRebuys, true)}`);
          messages.push(`ממוצע של ${hebrewNum(Math.round(avgRebuys), true)} קניות למשחק, ${playerName} הערב שובר שיאים`);
          messages.push(`${playerName} רגיל ${hebrewNum(Math.round(avgRebuys), true)} למשחק, הערב עובר את זה הרבה`);
        } else if (currentGameRebuys > avgRebuys && currentGameRebuys >= 2) {
          messages.push(`${playerName} עבר את הממוצע שלו של ${hebrewNum(Math.round(avgRebuys), true)} למשחק`);
          messages.push(`מעל הממוצע של ${playerName}, רגיל קונה ${hebrewNum(Math.round(avgRebuys), true)} וכבר ${hebrewNum(currentGameRebuys, true)}`);
        }
        if (currentGameRebuys <= 2 && avgRebuys >= 4) {
          messages.push(`${playerName} רגיל קונה ${hebrewNum(Math.round(avgRebuys), true)} פעמים למשחק, אז עוד יבואו`);
          messages.push(`ממוצע של ${hebrewNum(Math.round(avgRebuys), true)} קניות של ${playerName}, עוד רחוק מהשיא`);
          messages.push(`${playerName} ממוצע ${hebrewNum(Math.round(avgRebuys), true)} למשחק, הערב עוד בהתחלה`);
        }

        const totalRebuys2026 = stats2026.totalRebuys + currentGameRebuys;
        if (totalRebuys2026 >= 50) {
          const totalSpent = totalRebuys2026 * settings.rebuyValue;
          messages.push(`${playerName} כבר שילם ${totalSpent} שקל על קניות מתחילת השנה, הבנקאי של הקבוצה`);
          messages.push(`${totalSpent} שקל על קניות של ${playerName} השנה, תודה על המימון`);
        } else if (totalRebuys2026 >= 30) {
          const totalSpent = totalRebuys2026 * settings.rebuyValue;
          messages.push(`${playerName} כבר שילם ${totalSpent} שקל על קניות מתחילת השנה, תודה על המימון`);
          messages.push(`${playerName} עם ${hebrewNum(totalRebuys2026, true)} קניות השנה, נדיב כרגיל`);
        } else if (totalRebuys2026 >= 15) {
          messages.push(`${playerName} כבר ${hebrewNum(totalRebuys2026, true)} קניות מתחילת השנה, קצב יפה`);
          messages.push(`${hebrewNum(totalRebuys2026, true)} קניות של ${playerName} השנה, מגמה ברורה`);
        }
      }

      // --- Comparison with other players at the table tonight ---
      const otherPlayers = allPlayers.filter(p => p.playerId !== playerId && p.rebuys > 0);
      if (otherPlayers.length > 0) {
        const maxRebuysOther = Math.max(...otherPlayers.map(p => p.rebuys));
        const minRebuysOther = Math.min(...otherPlayers.map(p => p.rebuys));
        const playerWithMax = otherPlayers.find(p => p.rebuys === maxRebuysOther);
        const playerWithMin = otherPlayers.find(p => p.rebuys === minRebuysOther);

        if (currentGameRebuys > maxRebuysOther && playerWithMax && currentGameRebuys >= 3) {
          messages.push(`${playerName} עקף את ${playerWithMax.playerName} בקניות הערב`);
          messages.push(`אפילו ${playerWithMax.playerName} קנה פחות מאשר ${playerName} הערב`);
          messages.push(`${playerName} מוביל בקניות, עקף את ${playerWithMax.playerName}`);
          messages.push(`אף אחד לא קנה כמו ${playerName} הערב, אפילו לא ${playerWithMax.playerName}`);
        }
        if (currentGameRebuys >= 3 && playerWithMin && Math.ceil(minRebuysOther) <= 1) {
          messages.push(`${playerName} כבר ${hebrewNum(Math.ceil(currentGameRebuys), true)} קניות, ו ${playerWithMin.playerName} עדיין על הראשונה`);
          messages.push(`${playerWithMin.playerName} עדיין על הראשונה, ${playerName} כבר ${hebrewNum(Math.ceil(currentGameRebuys), true)}, פער גדול`);
        }

        const rival = otherPlayers.find(p => Math.ceil(p.rebuys) === Math.ceil(currentGameRebuys));
        if (rival) {
          messages.push(`${playerName} ו ${rival.playerName} שווים בקניות הערב, מי ישבור ראשון?`);
          messages.push(`מרוץ קניות בין ${playerName} לבין ${rival.playerName}, שניהם עם ${hebrewNum(Math.ceil(currentGameRebuys), true)}`);
          messages.push(`${playerName} ו ${rival.playerName} ראש בראש, ${hebrewNum(Math.ceil(currentGameRebuys), true)} קניות כל אחד`);
          messages.push(`תיקו בקניות, ${playerName} ו ${rival.playerName} שניהם ${hebrewNum(Math.ceil(currentGameRebuys), true)}`);
        }

        for (const other of otherPlayers) {
          const otherStats = allStats.find(s => s.playerId === other.playerId);
          if (!otherStats || otherStats.gamesPlayed < 5) continue;

          if (stats.totalProfit > 100 && otherStats.totalProfit < -100) {
            messages.push(`${playerName} פלוס ${Math.round(stats.totalProfit)} שקל, ${other.playerName} מינוס ${Math.round(Math.abs(otherStats.totalProfit))}, הערב הכל הפוך?`);
            messages.push(`${playerName} מרוויח ו ${other.playerName} מפסיד, אבל הערב שניהם קונים`);
          }

          const myWp = Math.round(stats.winPercentage);
          const theirWp = Math.round(otherStats.winPercentage);
          if (myWp >= 55 && theirWp <= 35 && stats.gamesPlayed >= 5) {
            messages.push(`${playerName} מנצח ${hebrewNum(myWp, false)} אחוז, ${other.playerName} רק ${hebrewNum(theirWp, false)} אחוז, אבל הערב שניהם קונים`);
            messages.push(`${hebrewNum(myWp, false)} אחוז מול ${hebrewNum(theirWp, false)} אחוז, ${playerName} ו ${other.playerName} שונים, אבל הערב דומים`);
          }

          if (stats.currentStreak >= 2 && otherStats.currentStreak <= -2) {
            messages.push(`${playerName} על רצף של ${hebrewNum(stats.currentStreak, false)} נצחונות, ${other.playerName} עם ${hebrewNum(Math.abs(otherStats.currentStreak), false)} הפסדים, אז מי צריך לקנות יותר?`);
          }

          if (stats2026 && stats2026.avgRebuysPerGame >= 3) {
            const otherStats2026 = getPlayerStats({ start: new Date('2026-01-01') }).find(s => s.playerId === other.playerId);
            if (otherStats2026 && otherStats2026.avgRebuysPerGame >= 3) {
              messages.push(`${playerName} ו ${other.playerName} שניהם ממוצע של ${hebrewNum(Math.round(stats2026.avgRebuysPerGame), true)} קניות למשחק, השותפים הכי נדיבים`);
              messages.push(`שני הנדיבים של השולחן, ${playerName} ו ${other.playerName}, ממוצע ${hebrewNum(Math.round(stats2026.avgRebuysPerGame), true)} קניות`);
            }
          }
        }

        const mySpent = currentGameRebuys * settings.rebuyValue;
        const totalTableSpent = allPlayers.reduce((sum, p) => sum + p.rebuys * settings.rebuyValue, 0);
        const mySharePercent = Math.round((mySpent / totalTableSpent) * 100);
        if (mySharePercent >= 30 && currentGameRebuys >= 3) {
          messages.push(`${playerName} אחראי על ${hebrewNum(mySharePercent, false)} אחוז מהכסף הערב, תודה על התמיכה`);
          messages.push(`${hebrewNum(mySharePercent, false)} אחוז מהכסף על השולחן שייך של ${playerName}, נדיבות`);
          messages.push(`${playerName} מממן ${hebrewNum(mySharePercent, false)} אחוז מהקופה הערב, כל הכבוד`);
        } else if (mySharePercent >= 20 && currentGameRebuys >= 3) {
          messages.push(`${playerName} אחראי על ${hebrewNum(mySharePercent, false)} אחוז מהכסף הערב, תודה על התמיכה`);
          messages.push(`${playerName} תורם ${hebrewNum(mySharePercent, false)} אחוז מהכסף הערב`);
        }
      }

      // --- Head to head with tonight's current leader ---
      if (otherPlayers.length > 0 && currentGameRebuys >= 2) {
        const stillOnFirst = otherPlayers.filter(p => p.rebuys === 1);
        if (stillOnFirst.length >= 2 && currentGameRebuys >= 3) {
          messages.push(`${playerName} כבר ${hebrewNum(Math.ceil(currentGameRebuys), true)} קניות, ו ${hebrewNum(stillOnFirst.length, false)} שחקנים עדיין על הראשונה`);
          messages.push(`${hebrewNum(stillOnFirst.length, false)} שחקנים עוד על הראשונה, ${playerName} כבר ${hebrewNum(Math.ceil(currentGameRebuys), true)}`);
        }
      }

      // --- Spending personality ---
      if (stats.gamesPlayed >= 5) {
        const totalSpentAllTime = stats.totalRebuys * settings.rebuyValue;
        if (totalSpentAllTime >= 3000) {
          messages.push(`${playerName} שילם כבר ${totalSpentAllTime} שקל על קניות סך הכל, הבנקאי של הקבוצה`);
          messages.push(`${totalSpentAllTime} שקל על קניות של ${playerName}, הספונסר הלא רשמי`);
          messages.push(`${playerName} שם ${totalSpentAllTime} שקל על קניות, הכסף חייב לחזור בסוף`);
        } else if (totalSpentAllTime >= 1500) {
          messages.push(`${playerName} שילם כבר ${totalSpentAllTime} שקל על קניות סך הכל, נדיב`);
          messages.push(`${totalSpentAllTime} שקל על קניות של ${playerName}, סכום יפה`);
        }
        if (stats.totalGains > 0 && stats.totalLosses > 0) {
          const volatility = stats.totalGains + stats.totalLosses;
          if (volatility > stats.gamesPlayed * 200) {
            messages.push(`${playerName} שחקן קיצוני, ${Math.round(stats.totalGains)} שקל נצחונות ו ${Math.round(stats.totalLosses)} שקל הפסדים`);
            messages.push(`${playerName} הכל או כלום, ${Math.round(stats.totalGains)} שקל למעלה ו ${Math.round(stats.totalLosses)} למטה`);
            messages.push(`סך הכל ${Math.round(stats.totalGains)} שקל נצחונות ו ${Math.round(stats.totalLosses)} הפסדים של ${playerName}, רכבת הרים`);
          } else if (volatility > stats.gamesPlayed * 120) {
            messages.push(`${playerName} שחקן קיצוני, ${Math.round(stats.totalGains)} שקל נצחונות ו ${Math.round(stats.totalLosses)} שקל הפסדים`);
            messages.push(`${playerName} לא משעמם, ההיסטוריה שלו מלאה עליות וירידות`);
          }
        }
      }

      // --- "Last few games" style facts ---
      if (stats.lastGameResults.length >= 3) {
        const last3 = stats.lastGameResults.slice(0, 3);
        const all3Lost = last3.every(g => g.profit < 0);
        const all3Won = last3.every(g => g.profit > 0);
        if (all3Lost) {
          const totalLoss3 = Math.round(last3.reduce((sum, g) => sum + Math.abs(g.profit), 0));
          messages.push(`${playerName} הפסיד שלושה משחקים אחרונים, מינוס ${totalLoss3} שקל, הערב חייב להשתנות`);
          messages.push(`שלושה הפסדים אחרונים של ${playerName}, סך הכל מינוס ${totalLoss3}, הערב אמור להיות שונה`);
          messages.push(`${playerName} מינוס ${totalLoss3} שקל, שלושה משחקים אחרונים, הערב חייב קאמבק`);
        }
        if (all3Won) {
          const totalWin3 = Math.round(last3.reduce((sum, g) => sum + g.profit, 0));
          messages.push(`${playerName} ניצח שלושה משחקים אחרונים, פלוס ${totalWin3} שקל, אבל הקניות לא מסתדרות עם זה`);
          messages.push(`שלושה נצחונות אחרונים של ${playerName}, פלוס ${totalWin3} שקל, הערב סיפור אחר`);
          messages.push(`${playerName} פלוס ${totalWin3} שקל, שלושה אחרונים, אבל הערב שונה`);
        }
      }
      if (stats.lastGameResults.length >= 5) {
        const last5 = stats.lastGameResults.slice(0, 5);
        const wins5 = last5.filter(g => g.profit > 0).length;
        const losses5 = last5.filter(g => g.profit < 0).length;
        if (wins5 >= 4) {
          messages.push(`${playerName} ניצח ${hebrewNum(wins5, false)} מתוך חמישה אחרונים, הערב מנסה לשנות את זה`);
        } else if (losses5 >= 4) {
          messages.push(`${playerName} הפסיד ${hebrewNum(losses5, false)} מתוך חמישה אחרונים, הערב ממשיך`);
          messages.push(`${hebrewNum(losses5, false)} הפסדים מתוך חמישה אחרונים של ${playerName}, לא פשוט`);
        }
      }

      // --- Quick rebuy (personalized) ---
      if (isQuickRebuy && currentGameRebuys >= 3) {
        messages.push(`${playerName} קנה שוב תוך דקות, הכסף לא מחזיק`);
        messages.push(`${playerName} חוזר מהר, כבר ${hebrewNum(Math.ceil(currentGameRebuys), true)} קניות`);
        messages.push(`הכסף של ${playerName} נעלם מהר, כבר ${hebrewNum(Math.ceil(currentGameRebuys), true)} קניות הערב`);
        messages.push(`${playerName}, שנייה, עוד לא הספקנו לערבב את הקלפים`);
        messages.push(`${playerName} קונה כאילו יש מבצע, כבר ${hebrewNum(Math.ceil(currentGameRebuys), true)} הערב`);
        messages.push(`${playerName} לא מבזבז זמן, ישר קנייה חדשה`);
        messages.push(`מהיר, ${playerName} חזר לקנות, כבר ${hebrewNum(Math.ceil(currentGameRebuys), true)}`);
        messages.push(`${playerName} קונה כמו שקונים במכולת, מהר ובלי לחשוב`);
        messages.push(`עוד אחד של ${playerName}, הקלפים לא הספיקו להתקרר`);
        if (stats.totalProfit > 100) {
          messages.push(`${playerName} פלוס ${Math.round(stats.totalProfit)} שקל, אז מה אם זה מהר`);
        } else if (stats.totalProfit < -100) {
          messages.push(`${playerName} מנסה להחזיר ${Math.round(Math.abs(stats.totalProfit))} שקל, ובמהירות`);
        }
        if (stats2026 && stats2026.avgRebuysPerGame > 0 && currentGameRebuys > stats2026.avgRebuysPerGame) {
          messages.push(`${playerName} כבר עבר את הממוצע של ${hebrewNum(Math.round(stats2026.avgRebuysPerGame), true)} ובקצב שיא`);
        }
      }

      // --- High rebuy count personal messages with data ---
      const spentTonight = Math.ceil(currentGameRebuys) * settings.rebuyValue;
      if (currentGameRebuys >= 7) {
        messages.push(`${playerName} כבר ${hebrewNum(Math.ceil(currentGameRebuys), true)} קניות, ${spentTonight} שקל בפנים, הספונסר הרשמי של הערב`);
        messages.push(`הארנק של ${playerName} בוכה, ${hebrewNum(Math.ceil(currentGameRebuys), true)} קניות, ${spentTonight} שקל ועולה`);
        messages.push(`${playerName} עם ${hebrewNum(Math.ceil(currentGameRebuys), true)} קניות, כולם אומרים תודה בלב`);
        messages.push(`${hebrewNum(Math.ceil(currentGameRebuys), true)} קניות של ${playerName}, ${spentTonight} שקל, נו, לפחות יש אופי`);
        messages.push(`${playerName} לא מוותר, ${hebrewNum(Math.ceil(currentGameRebuys), true)} קניות ועדיין מחייך`);
        messages.push(`${playerName} שם ${spentTonight} שקל על השולחן הערב, ${hebrewNum(Math.ceil(currentGameRebuys), true)} קניות ועולה`);
        messages.push(`${hebrewNum(Math.ceil(currentGameRebuys), true)} קניות, ${spentTonight} שקל, ${playerName} לא עוצר`);
        messages.push(`${playerName}, ${hebrewNum(Math.ceil(currentGameRebuys), true)} קניות, הערב יזכר`);
        if (stats.totalProfit > 0) {
          messages.push(`${playerName} פלוס ${Math.round(stats.totalProfit)} שקל סך הכל, אז מה זה עוד ${spentTonight}?`);
        } else {
          messages.push(`${playerName} מינוס ${Math.round(Math.abs(stats.totalProfit))} שקל, ועכשיו עוד ${spentTonight} הערב`);
        }
      } else if (currentGameRebuys >= 5) {
        messages.push(`${playerName} כבר ${hebrewNum(Math.ceil(currentGameRebuys), true)} קניות, ${spentTonight} שקל, ערב יקר`);
        messages.push(`${hebrewNum(Math.ceil(currentGameRebuys), true)} קניות של ${playerName}, ${spentTonight} שקל, תודה`);
        messages.push(`${playerName}, ${hebrewNum(Math.ceil(currentGameRebuys), true)} קניות, הנדיבות לא נגמרת`);
        messages.push(`${playerName} שם ${spentTonight} שקל הערב, ${hebrewNum(Math.ceil(currentGameRebuys), true)} קניות`);
        messages.push(`${hebrewNum(Math.ceil(currentGameRebuys), true)} קניות ו ${spentTonight} שקל, ${playerName} לא חוסך`);
        messages.push(`${playerName} עם ${hebrewNum(Math.ceil(currentGameRebuys), true)} קניות, הערב לא זול`);
        if (stats.winPercentage >= 50) {
          messages.push(`${playerName} מנצח ${hebrewNum(Math.round(stats.winPercentage), false)} אחוז מהמשחקים, אז אולי עוד קנייה תעזור`);
        } else {
          messages.push(`${playerName} מנצח רק ${hebrewNum(Math.round(stats.winPercentage), false)} אחוז, ${spentTonight} שקל לא ישנו את הסטטיסטיקה`);
        }
      } else if (currentGameRebuys >= 3) {
        messages.push(`${playerName} כבר ${hebrewNum(Math.ceil(currentGameRebuys), true)} קניות, ${spentTonight} שקל, תודה על התרומה`);
        messages.push(`מישהו שיעצור את ${playerName}, כבר ${hebrewNum(Math.ceil(currentGameRebuys), true)} קניות`);
        messages.push(`${playerName}, ${hebrewNum(Math.ceil(currentGameRebuys), true)} קניות, מי אמר שכסף לא קונה אושר?`);
        messages.push(`${playerName} עם ${hebrewNum(Math.ceil(currentGameRebuys), true)} קניות, ${spentTonight} שקל על השולחן`);
        messages.push(`${hebrewNum(Math.ceil(currentGameRebuys), true)} קניות של ${playerName}, הערב מתחמם`);
        messages.push(`${playerName} כבר ${spentTonight} שקל הערב, ועדיין ממשיך`);
        if (stats.gamesPlayed >= 5) {
          messages.push(`${playerName} עם ${hebrewNum(stats.gamesPlayed, false)} משחקים ניסיון, ועדיין ${hebrewNum(Math.ceil(currentGameRebuys), true)} קניות הערב`);
        }
      }

      // --- Player-specific trait messages (one punch per sentence, mixed with stats) ---
      const traits = playerTraits[playerId];
      if (traits) {
        const cr = hebrewNum(Math.ceil(currentGameRebuys), true);

        // ליאור (p1)
        if (playerId === 'p1') {
          messages.push(`האסטרטג של השולחן עם עוד קנייה, כבר ${cr}`);
          messages.push(`${playerName} בדרך כלל לא צריך הרבה קניות, הערב כבר ${cr}`);
          messages.push(`הערב יש באג באלגוריתם של ${playerName}, כבר ${cr} קניות`);
          messages.push(`מכבי הרצליה לא עוזרת הערב, כבר ${cr} קניות`);
          messages.push(`${playerName} שובר שיטה, בדרך כלל יעיל עם הקניות`);
          messages.push(`איש ההייטק הכי מחושב בשולחן, הערב כבר ${cr}`);
          messages.push(`${playerName} רגיל לנצח עם מינימום, הערב לא ככה`);
          messages.push(`${playerName} צריך לעדכן את התוכנית, כבר ${cr} קניות`);
        }

        // אייל (p2)
        if (playerId === 'p2') {
          messages.push(`האמרגן של הקבוצה ארגן לעצמו עוד קנייה`);
          messages.push(`${playerName} מתאם משחקים ומתאם קניות, כבר ${cr}`);
          messages.push(`איש הפיננסים עם עוד השקעה, כבר ${cr} קניות`);
          messages.push(`${playerName}, עדיף שתתאם פחות משחקים, כבר ${cr}`);
          messages.push(`הבלופן הגדול עם עוד קנייה, ${playerName} כבר ${cr}`);
          messages.push(`${playerName} הולך לפתח תקווה בלי לאהוד, ומשחק פוקר בלי לנצח`);
          messages.push(`האמרגן קונה עוד אחד, כבר ${cr} הערב`);
          messages.push(`התשואה של ${playerName} הערב שלילית, כבר ${cr} קניות`);
        }

        // ארז (p3)
        if (playerId === 'p3') {
          messages.push(`הצנחן קופץ שוב, ${playerName} כבר ${cr} קניות`);
          messages.push(`מהנדס בטיחות שלא שומר על הארנק, כבר ${cr}`);
          messages.push(`${playerName} מחשב סיכונים בעבודה אבל לא בפוקר`);
          messages.push(`צניחה חופשית לכיוון הארנק, ${playerName} כבר ${cr}`);
          messages.push(`${playerName} קופץ בלי מצנח, כבר ${cr} קניות`);
          messages.push(`בפוקר אין מצנח, ${playerName} כבר ${cr} קניות`);
          messages.push(`נחיתה קשה של ${playerName}, כבר ${cr} קניות`);
          messages.push(`מהנדס בטיחות שמסתכן הערב, עוד קנייה`);
        }

        // אורן (p4)
        if (playerId === 'p4') {
          messages.push(`${playerName} עייף מהתינוק ועייף מהקניות, כבר ${cr}`);
          messages.push(`${playerName} גובה מיסים ביום ומשלם קניות בערב`);
          messages.push(`${playerName} טוען שאין לו מזל, ${cr} קניות מוכיחות את זה`);
          messages.push(`התינוק בבית בוכה ו ${playerName} בשולחן קונה`);
          messages.push(`${playerName} אמר שאין לו מזל, אולי הוא צודק`);
          messages.push(`אוהד הפועל כפר סבא עם עוד קנייה, כבר ${cr}`);
          messages.push(`${playerName} עם אפס שעות שינה, כבר ${cr} קניות`);
          messages.push(`איש מס הכנסה קונה עוד אחד, הפעם בלי קבלה`);
        }

        // ליכטר (p5)
        if (playerId === 'p5') {
          messages.push(`רואה החשבון קונה עוד אחד, החשבון לא מסתדר`);
          messages.push(`${playerName} רואה חשבון שלא יודע לספור, כבר ${cr}`);
          messages.push(`הבלופן הרשמי של השולחן עם עוד קנייה`);
          messages.push(`${playerName} מעשן נרגילה ושורף כסף, כבר ${cr}`);
          messages.push(`אוהד הפועל כפר סבא עם ${cr} קניות, גם שם ככה`);
          messages.push(`${playerName} בלופר מקצועי, כבר ${cr} קניות`);
          messages.push(`הנרגילה לא עוזרת לריכוז של ${playerName}, כבר ${cr}`);
          messages.push(`${playerName} שורף כסף, עוד קנייה`);
        }

        // סגל (p6)
        if (playerId === 'p6') {
          messages.push(`איוון סטיבן קנה עוד אחד, סוף עידן האפסים?`);
          messages.push(`${playerName} בדרך כלל יוצא באפס, הערב לא נראה ככה`);
          messages.push(`השמרן הגדול של השולחן עם ${cr} קניות, מה קרה?`);
          messages.push(`איוון סטיבן הפך לאיוון קניות, כבר ${cr}`);
          messages.push(`בוחן התוכנה מצא באג בשמרנות שלו, כבר ${cr}`);
          messages.push(`${playerName} פתאום פראי, ${cr} קניות, לא רגיל`);
          messages.push(`${playerName} יוצא מהאפס, כבר ${cr} קניות`);
          messages.push(`איוון סטיבן לא כל כך סטיבן הערב`);
        }

        // תומר (p7)
        if (playerId === 'p7') {
          messages.push(`עוד מהלך מוזר של ${playerName}, קנייה מספר ${cr}`);
          messages.push(`אף אחד לא מבין את המשחק של ${playerName}, כבר ${cr}`);
          messages.push(`${playerName} עם עוד מהלך שאף אחד לא מבין`);
          messages.push(`לפחות יש חטיפים, ${playerName} כבר ${cr} קניות`);
          messages.push(`המזלן של השולחן עם עוד קנייה, כבר ${cr}`);
          messages.push(`${playerName}, תביא עוד עוגה, כבר ${cr} קניות`);
          messages.push(`גם בפתח תקווה לא תמיד מבינים מה קורה, כבר ${cr}`);
          messages.push(`${playerName} אוכל חטיפים וקונה קניות, כבר ${cr}`);
        }

        // פיליפ (p8)
        if (playerId === 'p8') {
          messages.push(`${playerName} מציע עוד עסקה מפוקפקת, כבר ${cr}`);
          messages.push(`מנהל המוצר מחפש עסקה, כבר ${cr} קניות`);
          messages.push(`${playerName} רגשי כמו תמיד, עוד קנייה`);
          messages.push(`אוהד באיירן מינכן עם עוד קנייה, כבר ${cr}`);
          messages.push(`${playerName} מחפש עסקאות מפוקפקות, כבר ${cr}`);
          messages.push(`לפחות באיירן מנצחים, ${playerName} כבר ${cr} קניות`);
          messages.push(`הבלופן הרגשי עם עוד קנייה`);
          messages.push(`${playerName} לא מנהל את הכסף הערב, כבר ${cr}`);
        }

        // אסף (p9)
        if (playerId === 'p9') {
          messages.push(`אוהד מכבי תל אביב עם עוד קנייה, כבר ${cr}`);
          messages.push(`${playerName} אבא חדש, כבר ${cr} קניות, התינוק עולה פחות`);
          messages.push(`${playerName} מחושב אבל הערב האגרסיביות ניצחה, כבר ${cr}`);
          messages.push(`${playerName} אוהד מכבי ומפסיד בפוקר, ערב קלאסי`);
          messages.push(`אבא טרי עם ${cr} קניות, החיתולים זולים יותר`);
          messages.push(`התינוק בבית ו ${playerName} כאן קונה, כבר ${cr}`);
          messages.push(`גם מכבי תל אביב לא תמיד מנצחת, כבר ${cr} קניות`);
          messages.push(`${playerName} אבא חדש עם הוצאות חדשות, עוד קנייה`);
        }

        // פבל (p10)
        if (playerId === 'p10') {
          messages.push(`${playerName} יצא לעשן וחזר לקנות, כבר ${cr}`);
          messages.push(`המערכת קרסה הערב, ${playerName} כבר ${cr} קניות`);
          messages.push(`${playerName} רגשי כמו תמיד, עוד קנייה`);
          messages.push(`המזל יבוא אחרי הסיגריה הבאה, ${playerName} כבר ${cr}`);
          messages.push(`${playerName} מתקן מחשבים ביום ושובר קופה בערב`);
          messages.push(`הבלופן ${playerName} עם עוד קנייה, כבר ${cr}`);
          messages.push(`עדיף לקנות סיגריות, ${playerName} כבר ${cr} קניות`);
          messages.push(`אפילו המזל יצא לעשן, ${playerName} כבר ${cr}`);
        }

        // מלמד (p11)
        if (playerId === 'p11') {
          messages.push(`המחשבון שיבר את החישוב, ${playerName} כבר ${cr}`);
          messages.push(`${playerName} משחק כמו מחשבון, הערב טעות חישוב`);
          messages.push(`שחקן הכדורעף עם עוד קנייה, כבר ${cr}`);
          messages.push(`${playerName} מדויק כמו מחשבון, אבל לא הערב`);
          messages.push(`הכדור לא נחת נכון, ${playerName} כבר ${cr} קניות`);
          messages.push(`המחשבון צריך עדכון, ${playerName} כבר ${cr}`);
          messages.push(`גם בכדורעף לפעמים מפסידים, ${playerName} כבר ${cr}`);
          messages.push(`${playerName} חישב ולא יצא, עוד קנייה`);
        }
      }

      // --- Always-applicable mixed-stat messages (broad pool for any player with history) ---
      const spent = currentGameRebuys * settings.rebuyValue;
      const wc = stats.winCount;
      const lc = stats.gamesPlayed - stats.winCount;
      messages.push(`${playerName} עם ${hebrewNum(wc, false)} נצחונות ו ${hebrewNum(lc, false)} הפסדים, הערב עוד משחק`);
      messages.push(`${playerName}, ${hebrewNum(gp, false)} משחקים, ${hebrewNum(wc, false)} נצחונות, הערב צריך עוד אחד`);
      messages.push(`${playerName} שם ${spent} שקל הערב, נראה אם זה ישתלם`);
      messages.push(`עוד קנייה של ${playerName}, כבר ${hebrewNum(currentGameRebuys, true)} הערב`);
      messages.push(`${playerName} ממשיך להאמין, ${hebrewNum(currentGameRebuys, true)} קניות ולא עוצר`);
      messages.push(`${playerName} ניצח ${hebrewNum(wc, false)} מתוך ${hebrewNum(gp, false)}, הערב מוסיף עוד קנייה`);
      if (stats.biggestWin > 50) {
        messages.push(`${playerName} יודע לנצח, פעם לקח ${Math.round(stats.biggestWin)} שקל, הערב מחכה להזדמנות`);
        messages.push(`שיא של ${Math.round(stats.biggestWin)} שקל של ${playerName}, הערב עדיין מחפש את הרגע`);
      }
      if (stats.avgProfit !== 0) {
        const dir = stats.avgProfit > 0 ? 'פלוס' : 'מינוס';
        messages.push(`${playerName} ממוצע ${dir} ${Math.round(Math.abs(stats.avgProfit))} למשחק, הערב נראה איך זה ישפיע`);
      }
      if (wp >= 40 && wp <= 60) {
        messages.push(`${playerName} מנצח ${hebrewNum(wp, false)} אחוז, שחקן ממוצע שקונה מעל הממוצע`);
        messages.push(`${hebrewNum(wp, false)} אחוז נצחונות של ${playerName}, הערב צריך לשפר את המספר`);
      }

      // Filter out already-used messages, pick from unused first
      const unused = messages.filter(m => !usedMessagesRef.current.has(m));
      const pool = unused.length > 0 ? unused : messages;
      const chosen = pool[Math.floor(Math.random() * pool.length)];
      usedMessagesRef.current.add(chosen);
      return chosen;
    } catch {
      return null;
    }
  };

  const getTiedForLeadMessage = (playerName: string, leaderNames: string[], totalBuyins: number): string => {
    const otherLeader = leaderNames.find(n => n !== playerName) || leaderNames[0];
    const count = Math.ceil(totalBuyins);
    const messages = [
      `תיקו! ${playerName} ו ${otherLeader} שניהם עם ${hebrewNum(count, true)} קניות`,
      `${playerName} ו ${otherLeader} ראש בראש, ${hebrewNum(count, true)} קניות כל אחד, מי ישבור ראשון?`,
      `יש לנו תיקו, ${hebrewNum(count, true)} קניות בראש הטבלה!`,
      `${playerName} לא נותן לאף אחד לברוח, שניהם עם ${hebrewNum(count, true)}`,
      `מרוץ הקניות מתחמם! ${playerName} השווה את ${otherLeader}, שניהם ${hebrewNum(count, true)}`,
    ];
    return messages[Math.floor(Math.random() * messages.length)];
  };

  const getPersonalRecordMessage = (playerName: string, previousRecord: number, currentCount: number): string => {
    const messages = [
      `שיא אישי חדש של ${playerName}! ${hebrewNum(currentCount, true)} קניות, השיא הקודם היה ${hebrewNum(previousRecord, true)}`,
      `${playerName} שובר שיא אישי עם ${hebrewNum(currentCount, true)} קניות! מעולם לא קנה כל כך הרבה`,
      `רגע היסטורי! ${playerName} עם שיא אישי חדש, ${hebrewNum(currentCount, true)} קניות הערב`,
      `${playerName} מתעלה על עצמו, ${hebrewNum(currentCount, true)} קניות, השיא הקודם היה רק ${hebrewNum(previousRecord, true)}`,
    ];
    return messages[Math.floor(Math.random() * messages.length)];
  };

  const getGroupRecordMessage = (playerName: string, previousRecord: number, currentCount: number): string => {
    const messages = [
      `שיא קבוצתי חדש! ${playerName} עם ${hebrewNum(currentCount, true)} קניות, שובר את השיא של ${hebrewNum(previousRecord, true)}`,
      `${playerName} נכנס לספר השיאים עם ${hebrewNum(currentCount, true)} קניות! אף אחד מעולם לא קנה כל כך הרבה`,
      `היסטוריה נכתבת! ${playerName} עם שיא קבוצתי חדש, ${hebrewNum(currentCount, true)} קניות`,
      `מזל טוב ${playerName}! ${hebrewNum(currentCount, true)} קניות, שיא שאף אחד לא רצה לשבור`,
    ];
    return messages[Math.floor(Math.random() * messages.length)];
  };

  const getExtendingRecordMessage = (playerName: string, isGroupRecord: boolean, currentCount: number): string => {
    if (isGroupRecord) {
      const messages = [
        `${playerName} ממשיך להרחיק את השיא הקבוצתי! כבר ${hebrewNum(currentCount, true)} קניות`,
        `השיא עולה, כבר ${hebrewNum(currentCount, true)}! ${playerName} לא עוצר`,
        `${playerName} בעולם משלו, השיא כבר ${hebrewNum(currentCount, true)}`,
        `עוד אחד לשיא! ${playerName} כבר ${hebrewNum(currentCount, true)} קניות`,
      ];
      return messages[Math.floor(Math.random() * messages.length)];
    }
    const messages = [
      `${playerName} ממשיך לשבור את השיא האישי, כבר ${hebrewNum(currentCount, true)} קניות!`,
      `השיא האישי עולה, כבר ${hebrewNum(currentCount, true)}! ${playerName} לא מוותר`,
      `${playerName} מגדיל את השיא האישי, כבר ${hebrewNum(currentCount, true)}, מה הגבול?`,
    ];
    return messages[Math.floor(Math.random() * messages.length)];
  };

  // Text-to-speech for buyin announcements - ALL HEBREW
  type RebuyContext = {
    isNewRebuyLeader: boolean;
    isTiedForLead: boolean;
    tiedLeaderNames: string[];
    isPersonalRecord: boolean;
    previousPersonalRecord: number;
    isGroupRecord: boolean;
    previousGroupRecord: number;
    isExtendingPersonalRecord: boolean;
    isExtendingGroupRecord: boolean;
    allPlayers: GamePlayer[];
    totalGroupRebuys: number;
    previousTotalGroupRebuys: number;
    lastManStanding: string | null;
  };

  const speakBuyin = async (playerName: string, playerId: string, totalBuyins: number, isQuickRebuy: boolean, isHalfBuyin: boolean, ctx: RebuyContext) => {
    // Play mood-appropriate casino sound
    await playRebuyCasinoSound(totalBuyins);
    
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
      
      // Hebrew numbers - feminine forms matching feminine noun קניות (buyins)
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
      
      // Decide which extra announcement to make (priority system)
      // Rebuy leader/tied/record announcements only kick in at 4+ rebuys (totalBuyins >= 5)
      // to avoid repetitive announcements early in the game
      let extraMessage: string;
      const ceilBuyins = Math.ceil(totalBuyins);
      const rebuyThresholdMet = totalBuyins >= 5;

      if (rebuyThresholdMet && ctx.isGroupRecord) {
        extraMessage = getGroupRecordMessage(playerName, ctx.previousGroupRecord, ceilBuyins);
      } else if (rebuyThresholdMet && ctx.isExtendingGroupRecord) {
        extraMessage = getExtendingRecordMessage(playerName, true, ceilBuyins);
      } else if (rebuyThresholdMet && ctx.isPersonalRecord) {
        extraMessage = getPersonalRecordMessage(playerName, ctx.previousPersonalRecord, ceilBuyins);
      } else if (rebuyThresholdMet && ctx.isExtendingPersonalRecord) {
        extraMessage = getExtendingRecordMessage(playerName, false, ceilBuyins);
      } else if (rebuyThresholdMet && ctx.isNewRebuyLeader) {
        const leaderMessages = [
          `ויש לנו מוביל חדש בקניות הערב! ${playerName} עם ${hebrewNum(ceilBuyins, true)} קניות`,
          `${playerName} תפס את המקום הראשון בקניות, כבר ${hebrewNum(ceilBuyins, true)}!`,
          `כל הכבוד ${playerName}, מוביל חדש עם ${hebrewNum(ceilBuyins, true)} קניות`,
        ];
        extraMessage = leaderMessages[Math.floor(Math.random() * leaderMessages.length)];
      } else if (rebuyThresholdMet && ctx.isTiedForLead) {
        extraMessage = getTiedForLeadMessage(playerName, ctx.tiedLeaderNames, totalBuyins);
      } else {
        const personal = getPersonalMessage(playerName, playerId, ceilBuyins, isQuickRebuy, ctx.allPlayers);
        extraMessage = personal || getBuyinMessage(ceilBuyins, isQuickRebuy);
      }

      const fullMessage = `${playerName}, ${buyAction}. סך הכל ${totalText}. ${extraMessage}`;
      
      const utterance = new SpeechSynthesisUtterance(fullMessage);
      utterance.lang = 'he-IL';
      if (hebrewVoice) utterance.voice = hebrewVoice;
      utterance.rate = 0.9;
      utterance.pitch = 1.0;
      utterance.volume = 1;
      
      // Build chain of follow-up announcements
      const followUps: string[] = [];

      // Rebuy milestone (initial buyins don't count — subtract player count)
      const playerCount = ctx.allPlayers.length;
      const totalRebuysOnly = ctx.totalGroupRebuys - playerCount;
      const prevRebuysOnly = ctx.previousTotalGroupRebuys - playerCount;
      const milestones = [5, 10, 15, 20, 25, 30, 35, 40, 50, 60, 75, 100];
      const crossedMilestone = milestones.find(m => prevRebuysOnly < m && totalRebuysOnly >= m);
      if (crossedMilestone) {
        const milestoneMessages = [
          `סך הכל ${hebrewNum(crossedMilestone, true)} קניות הערב!`,
          `כבר ${hebrewNum(crossedMilestone, true)} קניות הערב!`,
          `${hebrewNum(crossedMilestone, true)} קניות על השולחן הערב!`,
          `וואו, סך הכל ${hebrewNum(crossedMilestone, true)} קניות הערב!`,
          `הגענו כבר ${hebrewNum(crossedMilestone, true)} קניות הערב!`,
        ];
        followUps.push(milestoneMessages[Math.floor(Math.random() * milestoneMessages.length)]);
      }

      // Last man standing
      if (ctx.lastManStanding) {
        const lastManMessages = [
          `${ctx.lastManStanding} האחרון שעוד מחזיק מהקנייה הראשונה!`,
          `רק ${ctx.lastManStanding} נשאר בלי קנייה נוספת, כל השאר כבר קנו`,
          `${ctx.lastManStanding} עדיין על הראשונה, כל הכבוד`,
          `כולם כבר קנו חוץ מאשר ${ctx.lastManStanding}, מי יחזיק יותר?`,
          `${ctx.lastManStanding} האחרון על הקנייה הראשונה, לחץ!`,
        ];
        followUps.push(lastManMessages[Math.floor(Math.random() * lastManMessages.length)]);
      }

      // Chain follow-ups sequentially via onend
      const speakChain = (utt: SpeechSynthesisUtterance, msgs: string[]) => {
        if (msgs.length === 0) return;
        utt.onend = () => {
          const next = new SpeechSynthesisUtterance(msgs[0]);
          next.lang = 'he-IL';
          if (hebrewVoice) next.voice = hebrewVoice;
          next.rate = 0.9;
          next.pitch = 1.0;
          next.volume = 1;
          speakChain(next, msgs.slice(1));
          window.speechSynthesis.speak(next);
        };
      };
      speakChain(utterance, followUps);
      
      window.speechSynthesis.speak(utterance);
    }
  };

  const handleRebuy = (player: GamePlayer, amount: number = 1) => {
    const newRebuys = player.rebuys + amount;
    updateGamePlayerRebuys(player.id, newRebuys);
    
    const updatedPlayers = players.map(p => 
      p.id === player.id ? { ...p, rebuys: newRebuys } : p
    );
    setPlayers(updatedPlayers);
    
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
    
    // Detect leadership changes
    const previousRebuys = newRebuys - amount;
    const othersMax = Math.max(0, ...updatedPlayers.filter(p => p.id !== player.id).map(p => p.rebuys));
    const wasAlreadyLeader = previousRebuys > othersMax && previousRebuys > 1;
    const isNowSoleLeader = newRebuys > othersMax && newRebuys > 1;
    const isNewLeader = isNowSoleLeader && !wasAlreadyLeader;

    // Detect tied for lead (just matched someone else's max, creating a tie)
    const wasBehind = previousRebuys < othersMax;
    const isNowTied = newRebuys === othersMax && newRebuys > 1 && othersMax > 0;
    const isTiedForLead = wasBehind && isNowTied;
    const tiedLeaderNames = isTiedForLead
      ? updatedPlayers.filter(p => p.rebuys === newRebuys).map(p => p.playerName)
      : [];

    // Detect personal and group rebuy records (since 2026)
    const ceilNewRebuys = Math.ceil(newRebuys);
    const records = getRebuyRecords();
    const personalBest = records.playerMax.get(player.playerId) || 0;
    const groupBest = records.groupMax;
    const ceilPrevious = Math.ceil(previousRebuys);

    const isPersonalRecord = ceilNewRebuys > personalBest && personalBest > 0 && ceilPrevious <= personalBest;
    const isExtendingPersonalRecord = ceilNewRebuys > personalBest && personalBest > 0 && ceilPrevious > personalBest;

    const isGroupRecord = ceilNewRebuys > groupBest && groupBest > 0 && ceilPrevious <= groupBest;
    const isExtendingGroupRecord = ceilNewRebuys > groupBest && groupBest > 0 && ceilPrevious > groupBest;

    // Detect last man standing (only one player still on initial buyin)
    let lastManStanding: string | null = null;
    if (!lastManAnnouncedRef.current && updatedPlayers.length >= 3) {
      const noRebuyPlayers = updatedPlayers.filter(p => p.rebuys === 1);
      if (noRebuyPlayers.length === 1) {
        lastManStanding = noRebuyPlayers[0].playerName;
        lastManAnnouncedRef.current = true;
      }
    }

    const ctx: RebuyContext = {
      isNewRebuyLeader: isNewLeader,
      isTiedForLead,
      tiedLeaderNames,
      isPersonalRecord,
      previousPersonalRecord: personalBest,
      isGroupRecord,
      previousGroupRecord: groupBest,
      isExtendingPersonalRecord,
      isExtendingGroupRecord,
      allPlayers: updatedPlayers,
      totalGroupRebuys: updatedPlayers.reduce((sum, p) => sum + p.rebuys, 0),
      previousTotalGroupRebuys: updatedPlayers.reduce((sum, p) => sum + p.rebuys, 0) - amount,
      lastManStanding,
    };

    // Announce in Hebrew with creative message
    const isHalfBuyin = amount === 0.5;
    speakBuyin(player.playerName, player.playerId, newRebuys, isQuickRebuy, isHalfBuyin, ctx);
  };

  // Voice notification for undo
  const speakUndo = (playerName: string, undoAmount: number, newTotal: number) => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      
      const voices = window.speechSynthesis.getVoices();
      const hebrewVoice = voices.find(v => v.lang.startsWith('he') && v.name.toLowerCase().includes('female')) 
        || voices.find(v => v.lang.startsWith('he'))
        || null;
      
      // Hebrew numbers
      const hebrewNumbers = ['אפס', 'אחת', 'שתיים', 'שלוש', 'ארבע', 'חמש', 'שש', 'שבע', 'שמונה', 'תשע', 'עשר'];
      
      // Format new total
      const hasHalf = Math.abs((newTotal % 1) - 0.5) < 0.01;
      const whole = Math.floor(newTotal);
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
      
      // Undo message
      const undoText = undoAmount === 0.5 ? 'חצי' : 'אחד';
      const message = `ביטול. ${playerName} מינוס ${undoText}. סך הכל ${totalText}.`;
      
      const utterance = new SpeechSynthesisUtterance(message);
      utterance.lang = 'he-IL';
      if (hebrewVoice) utterance.voice = hebrewVoice;
      utterance.rate = 0.9;
      utterance.pitch = 1.0;
      utterance.volume = 1;
      
      window.speechSynthesis.speak(utterance);
    }
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
        
        // Voice notification for undo
        speakUndo(player.playerName, lastAction.amount, newRebuys);
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
          <div className="summary-value">{totalRebuys % 1 !== 0 ? totalRebuys.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : cleanNumber(totalRebuys)}</div>
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
          <div key={player.id} className="player-card" style={{ position: 'relative' }}>
            {/* Remove button - only show for players who haven't rebought yet */}
            {isAdmin && player.rebuys <= 1 && (
              <button
                onClick={() => handleRemovePlayer(player)}
                style={{
                  position: 'absolute',
                  top: '0.25rem',
                  left: '0.25rem',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  fontSize: '0.875rem',
                  padding: '0.25rem',
                  opacity: 0.6,
                  transition: 'opacity 0.2s'
                }}
                onMouseEnter={(e) => e.currentTarget.style.opacity = '1'}
                onMouseLeave={(e) => e.currentTarget.style.opacity = '0.6'}
                title="הסר שחקן (לא הגיע)"
              >
                ✕
              </button>
            )}
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

      {/* Remove Player Confirmation */}
      {playerToRemove && (
        <div 
          className="modal-overlay" 
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000
          }}
          onClick={() => setPlayerToRemove(null)}
        >
          <div 
            className="modal-content card"
            style={{
              maxWidth: '400px',
              margin: '1rem',
              padding: '1.5rem',
              textAlign: 'center'
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ fontSize: '2.5rem', marginBottom: '1rem' }}>👋</div>
            <h3 style={{ marginBottom: '0.5rem' }}>הסרת שחקן</h3>
            <p className="text-muted" style={{ marginBottom: '1.5rem' }}>
              להסיר את <strong>{playerToRemove.playerName}</strong> מהמשחק?
              <br />
              <span style={{ fontSize: '0.875rem' }}>(השחקן לא הגיע)</span>
            </p>
            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
              <button 
                className="btn btn-secondary"
                onClick={() => setPlayerToRemove(null)}
              >
                ביטול
              </button>
              <button 
                className="btn btn-danger"
                onClick={confirmRemovePlayer}
                style={{ background: '#dc3545', borderColor: '#dc3545' }}
              >
                הסר שחקן
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default LiveGameScreen;

