import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { GamePlayer, GameAction, SharedExpense } from '../types';
import { getGamePlayers, updateGamePlayerRebuys, getSettings, updateGameStatus, getGame, addSharedExpense, removeSharedExpense, updateSharedExpense, removeGamePlayer, getPlayerStats, getAllGames, getAllGamePlayers } from '../database/storage';
import { cleanNumber } from '../utils/calculations';
import { numberToHebrewTTS, speakHebrew } from '../utils/tts';
import { getGeminiApiKey } from '../utils/geminiAI';
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

  // Track which players already received a trait-based TTS message this game
  const traitSpokenRef = useRef<Set<string>>(new Set());

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
      'תנשום קצת בין הקניות, אני צריכה לנוח',
      'רגע רגע, עוד אחד? אפילו לא הספקנו לערבב',
      'וואו, זה היה מהיר אפילו בשביל פוקר',
      'קצב קניות שנשבר את מד המהירות',
      'הכסף נעלם כמו קסם, הודיני היה מתגאה',
      'אפילו לא הספקנו לשתות לחיים ויש כבר קנייה חדשה',
      'כספומט אנושי, מוציא כסף בלי להתאמץ',
      'יש פה מירוץ שאני לא יודעת עליו? כי זה מהיר',
      'שנייה, הקלפים לא הספיקו להתקרר',
      'נו, לפחות לא מבזבזים זמן, ישר לקנייה',
      'מהיר על ההדק, חבל שלא על הקלפים',
      'קנייה אקספרס, בלי תור, בלי המתנה',
    ];
    
    // Messages keyed by totalBuyins - gender neutral, natural Hebrew
    const messages: Record<number, string[]> = {
      2: [
        'עכשיו מתחילים ברצינות',
        'הפעם זה יעבוד, מרגישים את זה',
        'חימום נגמר, עכשיו העניינים מתחילים',
        'זה היה רק אימון, עכשיו ברצינות',
        'הראשון תמיד על חשבון הבית, רגע, אין בית',
        'טוב שבאת עם ארנק מלא, כי הוא הולך להתרוקן',
        'נו, לפחות עכשיו יודעים שהערב לא יהיה משעמם',
        'הכסף הראשון הלך, עכשיו נראה אם השני יצליח יותר',
        'שתיים בפנים, עוד אפשר להגיד שזה ערב רגיל',
        'קנייה שנייה, עדיין אופטימיים, מחכים לרגע שזה ישתנה',
        'מישהו אמר פעם שצריך להפסיד כדי ללמוד, נו, עכשיו לומדים',
        'הקלפים שומרים את הטובים לסוף, בטוח',
      ],
      3: [
        'שלוש קניות, עדיין בטווח של מה שאפשר לספר בבית',
        'הקלפים חייבים טובה אחרי הכל הזה',
        'אם תנצח עכשיו זה יהיה סיפור מעולה לספר',
        'הכסף יחזור, אולי לא הערב, אבל מתישהו',
        'בוא נקרא לזה השקעה ארוכת טווח מאוד ארוכת טווח',
        'עוד ישבו פה כולם ויספרו על הקאמבק, אם יהיה',
        'שלוש, זה עדיין מספר נורמלי, נכון? נכון?',
        'הארנק מתחיל לבכות, אבל עוד לא ייללות',
        'ראינו קאמבקים יותר גדולים, נכון, לא? מישהו יאשר?',
        'שלוש קניות, הנדיבות הזאת לא תשכח',
        'תודה על התרומה לקופה, השולחן מעריך',
      ],
      4: [
        'ארבע קניות, הארנק כבר שולח הודעות פרידה',
        'באנק אישי שלם על השולחן, מכאן כל יד חשובה',
        'אני מתחילה לדאוג, לא עלייך, על הכסף שלך',
        'הקלפים ישלמו על זה בסוף, ככה אומרים',
        'ארבע בפנים, עכשיו באמת צריך יד אחת טובה',
        'אולי פשוט תשב, תנשום, ותחכה ליד שתעשה פלא',
        'ארבע, הקופה אוהבת אותך, החברים גם',
        'עכשיו ההימור האמיתי הוא כמה עוד יקנה',
        'ארבע קניות, האפליקציה נהנית, הבנק פחות',
        'הצד הטוב, כבר אי אפשר להפסיד יותר, רגע, כן אפשר',
      ],
      5: [
        'חמש קניות, האשראי עדיין חי?',
        'הבנק מתקשר, מומלץ לא לענות',
        'אם זה היה קזינו כבר היו מביאים שתייה חינם לפחות',
        'חמש, אבל מי סופר? חוץ ממני כמובן',
        'תודה על המימון, השולחן לא היה אותו דבר בלעדייך',
        'חמש קניות, באירופה קוראים לזה ערב יקר',
        'חמש בפנים, ואני חושבת שהארנק כבר ישן',
        'רגע, בטוח שזה פוקר ולא לוטו? כי הסיכויים דומים',
        'חמש, והחיוך עדיין על הפנים, כל הכבוד על האופטימיות',
        'חמש קניות, היועץ הפיננסי היה מתעלף',
      ],
      6: [
        'שש קניות, השולחן שמח, הארנק כתב מכתב התפטרות',
        'אני לא שופטת, אני רק סופרת, ובינתיים הגענו לשש',
        'כולם מחייכים, חוץ מחשבון הבנק שבוכה',
        'לפחות הערב הזה לא ישכח, שש קניות זה זיכרון',
        'מימנת כמעט חצי מהקופה, אפשר שלט על כיסא בחסות',
        'שש, אבל האופטימיות עדיין חיה, איכשהו',
        'שש בפנים, ערב יקר, אבל הסיפורים שווים את זה',
        'שש קניות, זה כבר לא מזל רע, זה כישרון',
        'עם שש קניות אפשר כבר לבקש הנחת כמות',
        'שש, והערב רק בחצי, אז כל דבר אפשרי',
      ],
    };
    
    const highMessages = [
      'שיא אישי מתקרב, ואני לא בטוחה שזה סיבה לחגוג',
      'הערב הזה יכנס להיסטוריה של הקבוצה, לצד הלא נכון',
      'מה קורה פה בכלל? שאלה שגם הקלפים שואלים',
      'הערב הזה יעלה ביוקר, ממש ביוקר',
      'אני כבר לא יודעת מה להגיד, וזה אומר הרבה',
      'אפשר כבר לפתוח חשבונית, הסכום מצדיק',
      'הספונסר הרשמי של הערב, תודה על ההשקעה',
      'כולם חייבים לך על הערב המעולה, ברצינות',
      'אם היה אוסקר לנדיבות בפוקר, הנה הזוכה',
      'הקלפים מסרבים לשתף פעולה, ועדיין ממשיכים',
      'הבנקאי של הקבוצה, מימנת את הערב כמעט לבד',
      'עם קצב הקניות הזה, הארנק כבר התפטר',
    ];
    
    const finalMessages = [
      'בבקשה, חבל על הארנק, הוא כבר לא מרגיש את הרגליים',
      'אין מילים, באמת אין, ואני בדרך כלל לא שותקת',
      'שיא שלא ישבר בקרוב, ואולי אף פעם',
      'זה נכנס לספר השיאים, עם כוכבית וסימן קריאה',
      'נו, מספיק באמת, אני אומרת את זה בגובה העיניים',
      'כבר לא מצחיק, טוב, אולי קצת מצחיק, אבל גם עצוב',
      'הכסף הולך למקום טוב, לכיסים של כל החברים',
      'אני חושבת שהקלפים חתמו עלייך חרם הערב',
      'המחויבות הזאת מרשימה, הכסף כבר פחות',
      'תראה את זה ככה, עשית ערב בלתי נשכח לכולם',
      'לפחות יש סיפור מעולה למחר, לא? זה שווה משהו',
      'מציעה להפסיק לספור, זה כבר כואב לכולנו',
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

  // Personal traits keyed by player NAME for robust matching (IDs may vary across devices)
  const playerTraitsByName: Record<string, { team?: string; job?: string; style: string[]; nickname?: string; quirks: string[] }> = {
    'ליאור': { job: 'הייטק', team: 'מכבי הרצליה', style: ['מחושב'], quirks: ['מנצח עם מעט קניות', 'שחקן אסטרטגי'] },
    'אייל': { job: 'פיננסים', team: 'הפועל פתח תקווה', style: ['אגרסיבי', 'בלופר'], quirks: ['אמרגן הקבוצה', 'מתאם את המשחקים', 'הולך למשחקים של הפועל פתח תקווה למרות שלא באמת אוהד'] },
    'ארז': { job: 'מהנדס בטיחות', style: ['מחושב', 'אגרסיבי'], quirks: ['צנח חופשי', 'מהנדס בטיחות שמסתכן'] },
    'אורן': { job: 'מס הכנסה', team: 'הפועל כפר סבא', style: ['אגרסיבי', 'מזלן'], quirks: ['אבא לתינוק חדש', 'תמיד עייף', 'טוען שאין לו מזל'] },
    'ליכטר': { job: 'רואה חשבון', team: 'הפועל כפר סבא', style: ['בלופר', 'אגרסיבי'], quirks: ['אוהב נרגילה'] },
    'סגל': { job: 'בוחן תוכנה', nickname: 'איוון סטיבן', style: ['שמרני'], quirks: ['תמיד יוצא באפס', 'לאחרונה התחיל להפסיד', 'שחקן הכי שמרני בשולחן'] },
    'תומר': { team: 'הפועל פתח תקווה', style: ['מזלן'], quirks: ['מהלכים מוזרים', 'אוהב חטיפים ועוגות', 'אף אחד לא מבין את המשחק שלו'] },
    'פיליפ': { job: 'מנהל מוצר', team: 'באיירן מינכן', style: ['בלופר', 'מזלן', 'רגשי'], quirks: ['מחפש עסקאות מפוקפקות', 'רגשי על השולחן'] },
    'אסף': { team: 'מכבי תל אביב', style: ['מחושב', 'אגרסיבי'], quirks: ['אבא לתינוק חדש'] },
    'פבל': { job: 'IT', style: ['רגשי', 'בלופר', 'מזלן'], quirks: ['אוהב לעשן', 'מכוניות מרוץ'] },
    'מלמד': { job: 'הייטק', style: ['מחושב'], quirks: ['משחק כדורעף', 'משחק פוקר כמו מחשבון'] },
  };

  // Generate trait-only messages for a player (standalone for forced selection)
  const generateTraitMessages = (playerName: string, currentGameRebuys: number): string[] => {
    const traits = playerTraitsByName[playerName];
    if (!traits) return [];
    const cr = hebrewNum(Math.ceil(currentGameRebuys), true);
    const msgs: string[] = [];

    if (playerName === 'ליאור') {
      msgs.push(`${playerName} בנה את האפליקציה הזאת, אבל לא בנה אסטרטגיה לערב`);
      msgs.push(`מכבי הרצליה ו${playerName} עם מסורת משותפת של ציפיות גבוהות ותוצאות מאכזבות`);
      msgs.push(`הקוד של ${playerName} רץ מושלם, הקלפים שלו קורסים, כבר ${cr}`);
      msgs.push(`${playerName} כתב אלגוריתם לכל דבר חוץ מאיך לא להפסיד`);
      msgs.push(`איש ההייטק שפיתח חצי אפליקציה ולא פיתח משחק פוקר, כבר ${cr} קניות`);
      msgs.push(`${playerName} מריץ דיבאג על הערב, ומוצא רק באגים`);
      msgs.push(`בדרך כלל ${playerName} סוגר עם מינימום קניות, מי שינה לו את הסטטינגס?`);
      msgs.push(`${playerName} מחשב הכל, חוץ מהסיכוי שלו הערב, כבר ${cr}`);
      msgs.push(`${playerName} ניסה לעשות קונטרול זד על הקנייה האחרונה, לא עבד`);
      msgs.push(`האסטרטג של הקבוצה, הערב שכח את האסטרטגיה בבית`);
    }
    if (playerName === 'אייל') {
      msgs.push(`${playerName} מארגן את הערב, מממן את הערב, ולא מנצח בערב`);
      msgs.push(`איש הפיננסים קיבל תשואה שלילית של ${cr} קניות, שוק דובי`);
      msgs.push(`${playerName} הולך למשחקים של הפועל פתח תקווה בלי לאהוד, ומשחק פוקר בלי לנצח`);
      msgs.push(`האמרגן שמארגן ערב מעולה לכולם חוץ מעצמו, כבר ${cr}`);
      msgs.push(`${playerName} מנהל תיק השקעות כל היום, הערב התיק שלו במינוס`);
      msgs.push(`בפיננסים ${playerName} סוגר עסקאות, בפוקר ${playerName} סוגר ארנק, כבר ${cr}`);
      msgs.push(`${playerName} מתאם משחקים ברמת שיא, משחק ברמת שפל, כבר ${cr} קניות`);
      msgs.push(`${playerName} יודע לארגן ערב, אבל הערב ארגן לעצמו ${cr} קניות`);
      msgs.push(`האנליסט הפיננסי ממליץ מכירה חזקה על הקלפים של ${playerName}`);
      msgs.push(`${playerName} הבטיח שהערב יהיה שווה, הוא צדק, עבור כולם חוץ ממנו`);
    }
    if (playerName === 'ארז') {
      msgs.push(`מהנדס בטיחות בעבודה, מהנדס הרס עצמי בפוקר, כבר ${cr} קניות`);
      msgs.push(`${playerName} צונח מעשרת אלפים רגל ולא פוחד, אבל מ${cr} קניות כדאי לפחד`);
      msgs.push(`${playerName} בודק ציוד בטיחות כל יום, הערב שכח לבדוק את הארנק`);
      msgs.push(`הצנחן של השולחן, הערב הנחיתה בלי מצנח, כבר ${cr}`);
      msgs.push(`${playerName} קופץ מגובה של אלפי מטרים, הערב קופץ מגובה של ${cr} קניות`);
      msgs.push(`בצניחה חופשית יש אדרנלין, בפוקר עם ${playerName} יש רק חשבון, כבר ${cr}`);
      msgs.push(`${playerName} עושה תדריך בטיחות לכולם, חוץ מלארנק שלו`);
      msgs.push(`אסור לצנוח בלי ציוד, אבל מותר לשחק פוקר בלי תוכנית, שאלו את ${playerName}`);
      msgs.push(`${playerName} מחשב גובה וזוויות נפילה, אבל לא חישב את הנפילה הזאת`);
      msgs.push(`מהנדס הבטיחות עבר את כל תקני הסיכון הערב, כבר ${cr} קניות`);
    }
    if (playerName === 'אורן') {
      msgs.push(`${playerName} גובה מיסים מכולם מהבוקר, ובערב כולם גובים ממנו, כבר ${cr}`);
      msgs.push(`התינוק ישן סוף סוף, ו${playerName} ער כדי לממן את שאר השולחן`);
      msgs.push(`${playerName} טוען שאין לו מזל, והערב מוכיח את זה עם ${cr} קניות`);
      msgs.push(`במס הכנסה יודעים לגבות, בפוקר ${playerName} יודע רק לשלם, כבר ${cr}`);
      msgs.push(`${playerName} לא ישן בלילה בגלל התינוק, ולא מנצח בערב בגלל הקלפים`);
      msgs.push(`גם הפועל כפר סבא לא מנצחת, אז ${playerName} לפחות בחברה טובה`);
      msgs.push(`${playerName} עם עיניים עייפות, ארנק ריק, ו${cr} קניות, אבא שנה`);
      msgs.push(`במס הכנסה לוקחים אחוזים, בפוקר ${playerName} נותן מאה אחוז, כבר ${cr}`);
      msgs.push(`${playerName} בודק הצהרות הון כל היום, הערב ההצהרה שלו מצערת`);
      msgs.push(`אם הקניות של ${playerName} היו מוכרות מס, הוא היה יוצא בפלוס`);
    }
    if (playerName === 'ליכטר') {
      msgs.push(`רואה חשבון שלא רואה את הרווחים הערב, כבר ${cr} קניות`);
      msgs.push(`${playerName} סופר מיליונים בעבודה, ובפוקר סופר קניות, כבר ${cr}`);
      msgs.push(`${playerName} מעשן נרגילה ושורף כסף, הערב שניהם על טורבו`);
      msgs.push(`הבלפן הרשמי של השולחן, הערב אפילו הבלוף לא עובד, כבר ${cr}`);
      msgs.push(`${playerName} מבלף בפוקר ומעשן נרגילה, שניהם עשן, כבר ${cr} קניות`);
      msgs.push(`רואה חשבון ביום, בלפן בלילה, ובשניהם ${playerName} לא מרוויח הערב`);
      msgs.push(`הנרגילה של ${playerName} מוציאה יותר עשן מהקלפים שלו, כבר ${cr}`);
      msgs.push(`${playerName} מאזן ספרים כל היום, הערב המאזן שלו במינוס עמוק`);
      msgs.push(`גם כפר סבא וגם ${playerName} מאבדים הערב, לפחות ביחד`);
      msgs.push(`${playerName} מומחה לבלופים, אבל הקלפים לא מאמינים לו הערב`);
    }
    if (playerName === 'סגל') {
      msgs.push(`איוון סטיבן קנה עוד אחד, מישהו יבדוק שזה באמת ${playerName}?`);
      msgs.push(`${playerName} תמיד יוצא באפס, הערב שובר את המסורת עם ${cr} קניות`);
      msgs.push(`בוחן תוכנה שלא בדק את הקלפים לפני שישב, כבר ${cr}`);
      msgs.push(`איוון סטיבן הפך לאיוון קניות, ${cr} ועולה`);
      msgs.push(`השמרן הכי גדול בשולחן יצא מהכלוב, מה קרה ${playerName}?`);
      msgs.push(`${playerName} מוצא באגים בתוכנה, אבל לא מוצא קלפים טובים, כבר ${cr}`);
      msgs.push(`השיטת אפס של ${playerName} נשברה, כבר ${cr} קניות, היסטוריה`);
      msgs.push(`${playerName} שובר שיגעון, אפס היה פעם, ${cr} קניות זה עכשיו`);
      msgs.push(`הממלכה השמרנית של ${playerName} קורסת, כבר ${cr} בפנים`);
      msgs.push(`${playerName} מחפש באגים בקלפים, עדיין לא מצא, כבר ${cr}`);
    }
    if (playerName === 'תומר') {
      msgs.push(`אף אחד לא מבין את המשחק של ${playerName}, כולל ${playerName} עצמו`);
      msgs.push(`${playerName} משחק כמו הפועל פתח תקווה, טקטיקה מסתורית ותוצאות צפויות`);
      msgs.push(`לפחות ${playerName} הביא חטיפים, כי קלפים טובים הוא לא הביא, כבר ${cr}`);
      msgs.push(`${playerName} משחק לפי חוקים שהמציא עכשיו, כמו אימון של פתח תקווה`);
      msgs.push(`${playerName}, ${cr} קניות ואפס עוגות, תביא לפחות מאפה`);
      msgs.push(`בפתח תקווה רגילים להפסיד, ${playerName} מרגיש בבית גם על השולחן`);
      msgs.push(`${playerName} אוכל במבה ומשלם קניות, שני תחביבים יקרים, כבר ${cr}`);
      msgs.push(`המהלכים של ${playerName} כמו טקטיקה של פתח תקווה, מבלבלים את כולם כולל את עצמו`);
      msgs.push(`${playerName} הביא אנרגיה לשולחן, חבל שלא הביא מזל, כבר ${cr}`);
      msgs.push(`תומר, ${cr} קניות, אבל החטיפים שווים את זה, נכון?`);
    }
    if (playerName === 'פיליפ') {
      msgs.push(`${playerName} הציע עוד עסקה מפוקפקת, הפעם קנייה מספר ${cr}`);
      msgs.push(`מנהל מוצר שהמוצר שלו הערב זה הפסד, כבר ${cr} יחידות`);
      msgs.push(`${playerName} רגשי על השולחן כרגיל, הרגש הזה עולה ${cr} קניות`);
      msgs.push(`באיירן מינכן מנצחים בעקביות, ${playerName} מפסיד בעקביות, כבר ${cr}`);
      msgs.push(`${playerName} מחפש עסקת חייו על השולחן, כבר ${cr} ניסיונות ועדיין מחפש`);
      msgs.push(`${playerName} אוהד באיירן, אבל הערב משחק כמו קבוצה מליגה ג, כבר ${cr}`);
      msgs.push(`${playerName} השיק גרסה חדשה של ההפסד, עכשיו עם ${cr} קניות`);
      msgs.push(`בגרמניה היו כבר פוטרים את ${playerName}, פה רק קונים לו עוד קנייה`);
      msgs.push(`${playerName} עושה פיבוט מהפסד להפסד, כבר ${cr}, סטארטאפ שורף כסף`);
      msgs.push(`כל קנייה של ${playerName} מלווה בנאום רגשני, כבר ${cr} נאומים`);
    }
    if (playerName === 'אסף') {
      msgs.push(`${playerName} אבא טרי, הלילות הלבנים עכשיו גם בפוקר, כבר ${cr} קניות`);
      msgs.push(`מכבי תל אביב בגמר ו${playerName} בתחתית, כבר ${cr} קניות`);
      msgs.push(`${playerName} מחושב ואגרסיבי, הערב רק אגרסיבי עם הארנק, כבר ${cr}`);
      msgs.push(`אוהד מכבי ואבא חדש, ${playerName} לא ישן ולא מנצח, קומבו קלאסי`);
      msgs.push(`${playerName}, ${cr} קניות, הוצאה נוספת לצד חיתולים ומוצצים`);
      msgs.push(`התינוק בבית בוכה, ${playerName} פה משלם, מי מרוויח? אף אחד`);
      msgs.push(`${playerName} אוהד מכבי ומפסיד בפוקר, לפחות אחד מהשניים נגמר בצהריים`);
      msgs.push(`כסף החיתולים, הסמיפורמולה והקניות, ${playerName} ההוצאות לא נגמרות, כבר ${cr}`);
      msgs.push(`${playerName} מחליף חיתולים ומחליף קניות, כבר ${cr} הערב`);
      msgs.push(`הלילה הלבן של ${playerName} ממשיך, ${cr} קניות ואפס שעות שינה`);
    }
    if (playerName === 'פבל') {
      msgs.push(`${playerName} יצא לעשן, חזר, וקנה עוד אחד, כבר ${cr}, כמו תחנת דלק`);
      msgs.push(`איש ה IT שהמערכת שלו קרסה ואין גיבוי, כבר ${cr} קניות`);
      msgs.push(`${playerName} מתקן מחשבים כל היום, אבל הערב שום דבר לא מתוקן ולא ניתן לתיקון`);
      msgs.push(`${playerName} נוהג מהר במכוניות מרוץ, הערב הכסף שלו בנסיעת פרידה, כבר ${cr}`);
      msgs.push(`${playerName} בלף גדול, סיגריה קטנה, ותוצאה עגומה, כבר ${cr} קניות`);
      msgs.push(`${playerName} במרוצים עוקף את כולם, בפוקר כולם עוקפים אותו, כבר ${cr}`);
      msgs.push(`${playerName} שורף סיגריות בקצב של שחקן וקניות בקצב של חובבן, כבר ${cr}`);
      msgs.push(`הפרארי של ${playerName} על המסלול, הכסף שלו מחוץ למסלול, כבר ${cr}`);
      msgs.push(`${playerName} מפרמט מחשבים ביום ומפרמט ארנקים בלילה, כבר ${cr} קניות`);
      msgs.push(`${playerName} מעשן סיגריה אחרי כל קנייה, הריאות והארנק סובלים, כבר ${cr}`);
    }
    if (playerName === 'מלמד') {
      msgs.push(`${playerName} משחק כמו מחשבון, הערב מחשבון שלימדו אותו לחשב לא נכון`);
      msgs.push(`שחקן כדורעף שהכדור נוחת תמיד על הצד השני, כבר ${cr} קניות`);
      msgs.push(`${playerName} מדויק כמו אלגוריתם, חוץ מכשהוא יושב על שולחן פוקר`);
      msgs.push(`${playerName} עושה סמאש בכדורעף, בפוקר עושים לו סמאש, כבר ${cr}`);
      msgs.push(`החישוב של ${playerName} הערב, קנייה כפול ${cr} שווה הפסד`);
      msgs.push(`בכדורעף יש סט שני, ${playerName} כבר בסט ${cr} בקניות`);
      msgs.push(`${playerName} מחשב כמו מכונה, אבל הערב מכונה שתקועה על קנייה, כבר ${cr}`);
      msgs.push(`הייטקיסט שהקוד שלו מושלם, אבל הקלפים שלו מלאים באגים`);
      msgs.push(`${playerName} סוגר ספרינטים בזמן, סוגר ערבי פוקר במינוס, כבר ${cr}`);
      msgs.push(`ב${playerName} יש דיוק של מחשבון ומזל של קזינו, כבר ${cr} קניות`);
    }
    return msgs;
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
        messages.push(`${playerName} על רצף של ${hebrewNum(streak, false)} נצחונות ברצף, מתי זה ייגמר?`);
        messages.push(`${hebrewNum(streak, false)} נצחונות ברצף, אבל הקניות של ${playerName} מספרות סיפור אחר`);
        messages.push(`${playerName} על רצף חם של ${hebrewNum(streak, false)}, הערב ייבדק`);
        messages.push(`${playerName} שולט עם ${hebrewNum(streak, false)} נצחונות ברצף, נראה אם זה ימשיך`);
        messages.push(`רצף של ${hebrewNum(streak, false)} נצחונות, ${playerName} בדרך כלל לא קונה ככה`);
        messages.push(`${playerName} ניצח ${hebrewNum(streak, false)} ברצף, אז למה הקניות לא נעצרות?`);
      } else if (streak === 3) {
        messages.push(`${playerName} על רצף של שלושה נצחונות ברצף, מעניין כמה זה יחזיק`);
        messages.push(`שלושה ברצף, אבל ${playerName} עדיין קונה, מה קורה פה?`);
        messages.push(`${playerName} ניצח שלושה ברצף, אז למה בכלל צריך לקנות?`);
        messages.push(`שלושה ברצף של ${playerName}, מסתבר שגם מנצחים קונים לפעמים`);
      } else if (streak === 2) {
        messages.push(`${playerName} ניצח פעמיים ברצף, הערב יהיה שלישי?`);
        messages.push(`${playerName} על רצף קטן של שניים, נראה מה הערב יביא`);
        messages.push(`שני נצחונות ברצף, אבל ${playerName} הערב בכיוון אחר`);
      } else if (streak <= -4) {
        messages.push(`${playerName} עם ${hebrewNum(absStreak, false)} הפסדים ברצף, הקניות לא יפתרו את זה`);
        messages.push(`${hebrewNum(absStreak, false)} הפסדים ברצף, ${playerName} לא שובר את הרצף הערב`);
        messages.push(`${playerName} עם ${hebrewNum(absStreak, false)} הפסדים, מתי הגלגל יסתובב?`);
        messages.push(`${playerName}, כבר ${hebrewNum(absStreak, false)} הפסדים ברצף, הגיע הזמן לשבור את זה`);
        messages.push(`כבר ${hebrewNum(absStreak, false)} ברצף של ${playerName}, מתי זה נגמר?`);
        messages.push(`${hebrewNum(absStreak, false)} ברצף, ${playerName} מחזיק בשיא שאף אחד לא רוצה`);
      } else if (streak === -3) {
        messages.push(`${playerName} הפסיד שלושה ברצף, אולי הערב ייגמר אחרת`);
        messages.push(`שלושה הפסדים ברצף, ${playerName} מחכה לשינוי מזל`);
        messages.push(`${playerName} הפסיד שלושה ברצף, לפי הסטטיסטיקה מגיע לו כבר נצחון`);
        messages.push(`שלושה ברצף, ${playerName} חייב שהערב יהיה שונה`);
      } else if (streak === -2) {
        messages.push(`${playerName} הפסיד שניים ברצף, הערב צריך נצחון`);
        messages.push(`שני הפסדים ברצף, ${playerName} מקווה שהערב ישנה כיוון`);
        messages.push(`שניים ברצף של ${playerName}, הגיע הזמן להפוך את המגמה`);
      }

      // --- Win percentage ---
      const wp = Math.round(stats.winPercentage);
      if (wp >= 65 && stats.gamesPlayed >= 5) {
        messages.push(`${playerName} מנצח ב${wp} אחוז מהמשחקים, אבל הערב הכיוון הפוך`);
        messages.push(`${wp} אחוז נצחונות, ${playerName} בדרך כלל לא צריך לקנות ככה`);
        messages.push(`${playerName} עם אחוז נצחונות של ${wp}, הערב חריג במיוחד`);
        messages.push(`מנצח ב${wp} אחוז ועדיין קונה, ${playerName} הערב לא בקטע שלו`);
      } else if (wp >= 55 && stats.gamesPlayed >= 5) {
        messages.push(`${playerName} מנצח ב${wp} אחוז מהמשחקים, מה קורה הערב?`);
        messages.push(`${wp} אחוז נצחונות של ${playerName}, אבל הערב המספרים לא עובדים`);
        messages.push(`${playerName} רגיל לנצח ב${wp} אחוז, הערב חריג`);
      } else if (wp <= 30 && stats.gamesPlayed >= 5) {
        messages.push(`${playerName} מנצח רק ב${wp} אחוז מהמשחקים, אין מה להתפלא`);
        messages.push(`${wp} אחוז נצחונות, ${playerName} לפחות עקבי בהפסדים`);
        messages.push(`${playerName} עם ${wp} אחוז נצחונות, הקניות הן חלק מהשגרה`);
        messages.push(`רק ${wp} אחוז נצחונות, ${playerName} לפחות נהנה מהחברה`);
      } else if (wp <= 40 && stats.gamesPlayed >= 8) {
        messages.push(`${playerName} מנצח ב${wp} אחוז, יש לאן לשפר`);
        messages.push(`${wp} אחוז נצחונות של ${playerName}, יש מקום לצמיחה`);
        messages.push(`${playerName} עם ${wp} אחוז, הקניות הן חלק מהנוף`);
      }

      // --- Overall profit/loss ---
      const profit = Math.round(stats.totalProfit);
      const absProfit = Math.round(Math.abs(stats.totalProfit));
      if (stats.totalProfit > 500) {
        messages.push(`${playerName} ברווח של ${profit} שקל סך הכל, אז יש מאיפה לממן קניות`);
        messages.push(`${playerName} עדיין בפלוס של ${profit} שקל, אז מה זה עוד קנייה קטנה`);
        messages.push(`פלוס ${profit} שקל סך הכל, ${playerName} יכול להרשות לעצמו`);
        messages.push(`${playerName} בפלוס ${profit} שקל, זה כסף קטן בשבילו`);
      } else if (stats.totalProfit > 200) {
        messages.push(`${playerName} ברווח של ${profit} שקל סך הכל, יש מאיפה לקנות`);
        messages.push(`${playerName} עדיין בפלוס ${profit} שקל, קנייה אחת לא תשנה`);
        messages.push(`${playerName} בפלוס ${profit}, עדיין יש רווח לאבד`);
      } else if (stats.totalProfit > 0 && stats.totalProfit <= 200) {
        messages.push(`${playerName} עדיין בפלוס ${profit} שקל, אבל הרווח הולך ומתכווץ`);
        messages.push(`${playerName} עם פלוס קטן של ${profit} שקל, הערב יקבע אם זה יישאר`);
        messages.push(`הפלוס של ${profit} שקל של ${playerName} הולך ומתכווץ`);
      } else if (stats.totalProfit < -500) {
        messages.push(`${playerName} במינוס של ${absProfit} שקל סך הכל, עוד קנייה זה טיפה בים`);
        messages.push(`${playerName} מנסה לסגור חוב של ${absProfit} שקל, דרך ארוכה`);
        messages.push(`מינוס ${absProfit} שקל סך הכל, ${playerName} כבר לא סופר`);
        messages.push(`${playerName} במינוס ${absProfit} שקל, עוד קנייה כבר לא תורגש`);
      } else if (stats.totalProfit < -200) {
        messages.push(`${playerName} במינוס של ${absProfit} שקל סך הכל, עוד קנייה לא תשנה הרבה`);
        messages.push(`${playerName} מנסה לסגור ${absProfit} שקל מינוס, בהצלחה עם זה`);
        messages.push(`${playerName} במינוס ${absProfit} שקל, הערב הזדמנות נוספת`);
      } else if (stats.totalProfit < -50) {
        messages.push(`${playerName} במינוס ${absProfit} שקל סך הכל, הקניות לא עוזרות`);
        messages.push(`מינוס ${absProfit} שקל של ${playerName}, צריך שינוי מגמה`);
        messages.push(`${playerName} במינוס ${absProfit} שקל, נראה אם הערב ישפר את המצב`);
      }

      // --- Last game result ---
      if (stats.lastGameResults.length > 0) {
        const lastGame = stats.lastGameResults[0];
        const lastProfit = Math.round(lastGame.profit);
        const lastAbsProfit = Math.round(Math.abs(lastGame.profit));
        if (lastGame.profit > 200) {
          messages.push(`${playerName} הרוויח ${lastProfit} שקל במשחק הקודם, הערב סיפור אחר לגמרי`);
          messages.push(`אחרי רווח של ${lastProfit} שקל בפעם שעברה, ${playerName} חוזר לקנות`);
          messages.push(`${playerName} הגיע בביטחון אחרי ${lastProfit} שקל, אבל הערב לא פשוט`);
          messages.push(`רווח גדול של ${lastProfit} שקל בפעם שעברה, ${playerName} הערב מחזיר לקופה`);
        } else if (lastGame.profit > 0) {
          messages.push(`${playerName} הרוויח ${lastProfit} שקל במשחק הקודם, הערב קצת אחרת`);
          messages.push(`אחרי פלוס ${lastProfit} שקל בפעם שעברה, ${playerName} הערב מתקשה`);
          messages.push(`${playerName} הרוויח ${lastProfit} שקל בפעם שעברה, הערב הכיוון הפוך`);
        } else if (lastGame.profit < -200) {
          messages.push(`${playerName} הפסיד ${lastAbsProfit} שקל במשחק הקודם ומנסה להחזיר`);
          messages.push(`אחרי הפסד של ${lastAbsProfit} שקל בפעם שעברה, ${playerName} ממשיך לקנות`);
          messages.push(`${playerName} עם מינוס ${lastAbsProfit} שקל מהמשחק הקודם, הערב ממשיך באותו כיוון`);
          messages.push(`הפסד של ${lastAbsProfit} שקל בפעם שעברה, ${playerName} לא מוותר`);
        } else if (lastGame.profit < -50) {
          messages.push(`${playerName} הפסיד ${lastAbsProfit} שקל במשחק הקודם, הערב לא מתחיל טוב יותר`);
          messages.push(`${playerName} סיים מינוס ${lastAbsProfit} שקל בפעם שעברה, הערב אותו סיפור`);
          messages.push(`${playerName} הפסיד ${lastAbsProfit} שקל במשחק הקודם ועדיין קונה`);
        } else if (lastGame.profit < 0) {
          messages.push(`${playerName} סיים עם מינוס קטן בפעם שעברה, הערב מקווה לטוב יותר`);
        }
      }

      // --- Avg profit per game ---
      if (stats.avgProfit > 80 && stats.gamesPlayed >= 5) {
        messages.push(`${playerName} מרוויח בממוצע ${Math.round(stats.avgProfit)} שקל למשחק, הערב מוריד את הממוצע`);
        messages.push(`ממוצע רווח של ${Math.round(stats.avgProfit)} שקל למשחק, ${playerName} הערב לא ברמה הרגילה`);
        messages.push(`${playerName} רגיל לפלוס ${Math.round(stats.avgProfit)} למשחק, הערב חריג`);
      } else if (stats.avgProfit > 30 && stats.gamesPlayed >= 5) {
        messages.push(`${playerName} בממוצע מרוויח ${Math.round(stats.avgProfit)} שקל למשחק, הערב מוריד את הממוצע`);
        messages.push(`${playerName} רגיל לפלוס ${Math.round(stats.avgProfit)} למשחק, הערב משנה את הסיפור`);
      } else if (stats.avgProfit < -80 && stats.gamesPlayed >= 5) {
        messages.push(`${playerName} מפסיד בממוצע ${Math.round(Math.abs(stats.avgProfit))} שקל למשחק, הערב ממשיך את המגמה`);
        messages.push(`${playerName} מפסיד בממוצע ${Math.round(Math.abs(stats.avgProfit))} שקל למשחק, לפחות עקבי`);
        messages.push(`ממוצע הפסד של ${Math.round(Math.abs(stats.avgProfit))} שקל, ${playerName} הערב לא משפר`);
      } else if (stats.avgProfit < -30 && stats.gamesPlayed >= 5) {
        messages.push(`${playerName} מפסיד בממוצע ${Math.round(Math.abs(stats.avgProfit))} שקל למשחק, המגמה ממשיכה`);
        messages.push(`ממוצע הפסד של ${Math.round(Math.abs(stats.avgProfit))} שקל למשחק, ${playerName} הערב לא משנה`);
      }

      // --- Games played milestones ---
      const gp = stats.gamesPlayed;
      if (gp >= 50) {
        messages.push(`${playerName} ותיק עם ${gp} משחקים, הניסיון לא עוזר הערב`);
        messages.push(`${gp} משחקים, ו${playerName} עדיין קונה כמו מתחיל`);
        messages.push(`${playerName} שיחק כבר ${gp} משחקים, מכיר כל קלף ועדיין לא למד`);
        messages.push(`ותיק של ${gp} משחקים, אבל ${playerName} לא לומד מטעויות`);
      } else if (gp >= 30) {
        messages.push(`${playerName} שיחק כבר ${gp} משחקים, ולא מפסיק לקנות`);
        messages.push(`${gp} משחקים ו${playerName} עדיין מממן את השולחן`);
        messages.push(`${playerName} עם ${gp} משחקי ניסיון, אבל הניסיון לא מונע קניות`);
      } else if (gp >= 15) {
        messages.push(`${gp} משחקים, ${playerName} כבר מכיר את הדרך לארנק`);
        messages.push(`${playerName} עם ${gp} משחקים, שחקן מנוסה שקונה כמו חדש`);
        messages.push(`${gp} משחקים ו${playerName} עדיין לא הפנים את הלקח`);
      } else if (gp >= 8) {
        messages.push(`${playerName} עם ${gp} משחקים, עדיין לומד את השולחן`);
        messages.push(`${gp} משחקים של ${playerName}, צובר ניסיון על חשבון הארנק`);
      } else if (gp <= 5) {
        messages.push(`${playerName} חדש יחסית עם רק ${gp} משחקים, עדיין לומד לשלם`);
        messages.push(`${playerName} רק ${gp} משחקים, הניסיון עוד יבוא`);
        messages.push(`רק ${gp} משחקים של ${playerName}, אבל הקניות כבר ברמת מקצוענים`);
      }

      // --- Biggest win/loss references ---
      if (stats.biggestWin > 200) {
        messages.push(`הנצחון הכי גדול של ${playerName} היה ${Math.round(stats.biggestWin)} שקל, הערב בכיוון ההפוך`);
        messages.push(`${playerName} פעם לקח ${Math.round(stats.biggestWin)} שקל, איפה הרגע הזה הערב?`);
        messages.push(`שיא רווח של ${Math.round(stats.biggestWin)} שקל, ${playerName} הערב רחוק מזה`);
      } else if (stats.biggestWin > 100) {
        messages.push(`הנצחון הכי גדול של ${playerName} היה ${Math.round(stats.biggestWin)} שקל, הערב הכיוון הפוך`);
        messages.push(`${playerName} יודע לנצח, פעם לקח ${Math.round(stats.biggestWin)} שקל, הערב לא אותו סיפור`);
      }
      if (stats.biggestLoss < -200) {
        messages.push(`ההפסד הכי גדול של ${playerName} היה ${Math.round(Math.abs(stats.biggestLoss))} שקל, נקווה שהערב לא נגיע לשם`);
        messages.push(`${playerName} פעם הפסיד ${Math.round(Math.abs(stats.biggestLoss))} שקל, הערב בדרך לשבור את השיא?`);
        messages.push(`שיא הפסד של ${Math.round(Math.abs(stats.biggestLoss))} שקל, ${playerName} הערב עוד לא שם`);
      } else if (stats.biggestLoss < -100) {
        messages.push(`ההפסד הכי גדול של ${playerName} היה ${Math.round(Math.abs(stats.biggestLoss))} שקל, נקווה שהערב לא נגיע לשם`);
        messages.push(`${playerName} פעם הפסיד ${Math.round(Math.abs(stats.biggestLoss))} שקל, הערב מנסה לא לחזור על זה`);
      }

      // --- Longest streaks ---
      if (stats.longestWinStreak >= 4) {
        messages.push(`השיא של ${playerName} הוא ${stats.longestWinStreak} נצחונות ברצף, הערב לא נראה שזה יקרה`);
        messages.push(`${playerName} פעם ניצח ${stats.longestWinStreak} ברצף, הערב סיפור אחר`);
        messages.push(`רצף שיא של ${stats.longestWinStreak} נצחונות, ${playerName} הערב רחוק מזה`);
      }
      if (stats.longestLossStreak >= 4) {
        messages.push(`${playerName} פעם הפסיד ${stats.longestLossStreak} ברצף, אז מה זה עוד קנייה`);
        messages.push(`שיא הפסדים של ${stats.longestLossStreak} ברצף, ${playerName} מכיר תקופות קשות`);
        messages.push(`${playerName} שרד ${stats.longestLossStreak} הפסדים ברצף, עוד קנייה לא תשבור אותו`);
      }

      // --- Avg win vs avg loss ---
      if (stats.avgWin > 0 && stats.avgLoss > 0) {
        if (stats.avgWin > stats.avgLoss * 1.5) {
          messages.push(`כש${playerName} מנצח, הוא מנצח גדול, ממוצע של ${Math.round(stats.avgWin)} שקל, רק צריך להגיע לשם`);
          messages.push(`${playerName} מרוויח בממוצע ${Math.round(stats.avgWin)} שקל כשהוא מנצח, חבל שהערב זה לא קורה`);
          messages.push(`רווח ממוצע של ${Math.round(stats.avgWin)} שקל, ${playerName} צריך רק הזדמנות אחת טובה`);
        } else if (stats.avgLoss > stats.avgWin * 1.5) {
          messages.push(`${playerName} מפסיד בממוצע ${Math.round(stats.avgLoss)} שקל ומרוויח רק ${Math.round(stats.avgWin)}, היחס לא טוב`);
          messages.push(`${playerName} מפסיד גדול ומנצח קטן, ממוצע הפסד של ${Math.round(stats.avgLoss)} שקל`);
          messages.push(`הפסד ממוצע של ${Math.round(stats.avgLoss)} מול רווח ממוצע של ${Math.round(stats.avgWin)}, ${playerName} צריך לשנות גישה`);
        }
      }

      // --- Win count facts ---
      if (stats.winCount >= 10 && stats.gamesPlayed >= 15) {
        messages.push(`${playerName} ניצח ${stats.winCount} משחקים סך הכל, הערב לא נראה שזה יתווסף`);
        messages.push(`${stats.winCount} נצחונות של ${playerName}, אבל הערב הצד השני גדל`);
      }
      if (stats.winCount <= 3 && stats.gamesPlayed >= 10) {
        messages.push(`${playerName} ניצח רק ${stats.winCount} מתוך ${gp} משחקים, אין מה להתפלא על הקניות`);
        messages.push(`רק ${stats.winCount} נצחונות מתוך ${gp} משחקים, ${playerName} לפחות עקבי`);
      }

      // --- Rebuy-related (2026 data only) ---
      if (stats2026 && stats2026.gamesPlayed >= 2) {
        const avgRebuys = stats2026.avgRebuysPerGame;
        if (currentGameRebuys > avgRebuys * 1.5 && currentGameRebuys >= 3) {
          messages.push(`${playerName} בדרך כלל קונה ${Math.round(avgRebuys)} למשחק, הערב כבר ${Math.ceil(currentGameRebuys)}`);
          messages.push(`${playerName} מעל הממוצע שלו, בדרך כלל ${Math.round(avgRebuys)} קניות וכבר ${Math.ceil(currentGameRebuys)}`);
          messages.push(`ממוצע של ${Math.round(avgRebuys)} קניות למשחק, ${playerName} הערב שובר שיאים`);
          messages.push(`${playerName} רגיל ל${Math.round(avgRebuys)} קניות למשחק, הערב עובר את זה בהרבה`);
        } else if (currentGameRebuys > avgRebuys && currentGameRebuys >= 2) {
          messages.push(`${playerName} עבר את הממוצע שלו של ${Math.round(avgRebuys)} קניות למשחק`);
          messages.push(`${playerName} בדרך כלל קונה ${Math.round(avgRebuys)} למשחק, וכבר ${Math.ceil(currentGameRebuys)} הערב`);
        }
        if (currentGameRebuys <= 2 && avgRebuys >= 4) {
          messages.push(`${playerName} בדרך כלל קונה ${Math.round(avgRebuys)} למשחק, אז עוד יבואו`);
          messages.push(`עם ממוצע של ${Math.round(avgRebuys)} קניות, ${playerName} עוד רחוק מהשיא שלו`);
          messages.push(`${playerName} רגיל ל${Math.round(avgRebuys)} למשחק, הערב עוד רק ההתחלה`);
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
          messages.push(`אפילו ${playerWithMax.playerName} קנה פחות מ${playerName} הערב`);
          messages.push(`${playerName} מוביל את טבלת הקניות, עקף את ${playerWithMax.playerName}`);
          messages.push(`אף אחד לא קנה כמו ${playerName} הערב, אפילו ${playerWithMax.playerName} לא`);
        }
        if (currentGameRebuys >= 3 && playerWithMin && Math.ceil(minRebuysOther) <= 1) {
          messages.push(`${playerName} כבר ${Math.ceil(currentGameRebuys)} קניות ו${playerWithMin.playerName} עדיין על הראשונה`);
          messages.push(`${playerWithMin.playerName} עדיין על הראשונה, ${playerName} כבר ב${Math.ceil(currentGameRebuys)}, פער עצום`);
        }

        const rival = otherPlayers.find(p => Math.ceil(p.rebuys) === Math.ceil(currentGameRebuys));
        if (rival) {
          messages.push(`${playerName} ו${rival.playerName} שווים בקניות הערב, מי ישבור ראשון?`);
          messages.push(`מירוץ קניות בין ${playerName} ל${rival.playerName}, שניהם ב${Math.ceil(currentGameRebuys)}`);
          messages.push(`${playerName} ו${rival.playerName} ראש בראש, ${Math.ceil(currentGameRebuys)} קניות כל אחד`);
          messages.push(`תיקו בקניות, ${playerName} ו${rival.playerName} שניהם ב${Math.ceil(currentGameRebuys)}`);
        }

        for (const other of otherPlayers) {
          const otherStats = allStats.find(s => s.playerId === other.playerId);
          if (!otherStats || otherStats.gamesPlayed < 5) continue;

          if (stats.totalProfit > 100 && otherStats.totalProfit < -100) {
            messages.push(`${playerName} בפלוס ${Math.round(stats.totalProfit)} שקל ו${other.playerName} במינוס ${Math.round(Math.abs(otherStats.totalProfit))}, הערב שניהם קונים`);
            messages.push(`${playerName} מרוויח ו${other.playerName} מפסיד סך הכל, אבל הערב שניהם באותה סירה`);
          }

          const myWp = Math.round(stats.winPercentage);
          const theirWp = Math.round(otherStats.winPercentage);
          if (myWp >= 55 && theirWp <= 35 && stats.gamesPlayed >= 5) {
            messages.push(`${playerName} מנצח ב${myWp} אחוז ו${other.playerName} רק ב${theirWp}, אבל הערב שניהם קונים`);
            messages.push(`${myWp} אחוז מול ${theirWp} אחוז, ${playerName} ו${other.playerName} שונים לגמרי, אבל הערב דומים`);
          }

          if (stats.currentStreak >= 2 && otherStats.currentStreak <= -2) {
            messages.push(`${playerName} על רצף של ${stats.currentStreak} נצחונות ו${other.playerName} עם ${Math.abs(otherStats.currentStreak)} הפסדים, מי צריך לקנות יותר?`);
          }

          if (stats2026 && stats2026.avgRebuysPerGame >= 3) {
            const otherStats2026 = getPlayerStats({ start: new Date('2026-01-01') }).find(s => s.playerId === other.playerId);
            if (otherStats2026 && otherStats2026.avgRebuysPerGame >= 3) {
              messages.push(`${playerName} ו${other.playerName} שניהם בממוצע של ${Math.round(stats2026.avgRebuysPerGame)} קניות למשחק, השותפים הכי נדיבים`);
              messages.push(`שני הנדיבנים של השולחן, ${playerName} ו${other.playerName}, ממוצע ${Math.round(stats2026.avgRebuysPerGame)} קניות`);
            }
          }
        }

        const mySpent = currentGameRebuys * settings.rebuyValue;
        const totalTableSpent = allPlayers.reduce((sum, p) => sum + p.rebuys * settings.rebuyValue, 0);
        const mySharePercent = Math.round((mySpent / totalTableSpent) * 100);
        if (mySharePercent >= 30 && currentGameRebuys >= 3) {
          messages.push(`${playerName} אחראי על ${mySharePercent} אחוז מהכסף הערב, תודה על התמיכה`);
          messages.push(`${mySharePercent} אחוז מהכסף על השולחן הוא של ${playerName}, נדיבות יוצאת דופן`);
          messages.push(`${playerName} מממן ${mySharePercent} אחוז מהקופה הערב, כל הכבוד`);
        } else if (mySharePercent >= 20 && currentGameRebuys >= 3) {
          messages.push(`${playerName} אחראי על ${mySharePercent} אחוז מהכסף על השולחן הערב`);
          messages.push(`${playerName} תורם ${mySharePercent} אחוז מהקופה, תודה על ההשקעה`);
        }
      }

      // --- Head to head with tonight's current leader ---
      if (otherPlayers.length > 0 && currentGameRebuys >= 2) {
        const stillOnFirst = otherPlayers.filter(p => p.rebuys === 1);
        if (stillOnFirst.length >= 2 && currentGameRebuys >= 3) {
          messages.push(`${playerName} כבר ב${Math.ceil(currentGameRebuys)} קניות ו${stillOnFirst.length} שחקנים עדיין על הראשונה`);
          messages.push(`${stillOnFirst.length} שחקנים עדיין על הראשונה, ${playerName} כבר ב${Math.ceil(currentGameRebuys)}`);
        }
      }

      // --- Spending personality ---
      if (stats.gamesPlayed >= 5) {
        const totalSpentAllTime = stats.totalRebuys * settings.rebuyValue;
        if (totalSpentAllTime >= 3000) {
          messages.push(`${playerName} שילם כבר ${totalSpentAllTime} שקל על קניות סך הכל, הבנקאי הרשמי של הקבוצה`);
          messages.push(`${totalSpentAllTime} שקל על קניות של ${playerName}, הספונסר שלא ביקש קרדיט`);
          messages.push(`${playerName} השקיע ${totalSpentAllTime} שקל בקניות, מתישהו זה חייב לחזור`);
        } else if (totalSpentAllTime >= 1500) {
          messages.push(`${playerName} שילם כבר ${totalSpentAllTime} שקל על קניות סך הכל, נדיבות שלא נשכחת`);
          messages.push(`${totalSpentAllTime} שקל על קניות של ${playerName}, סכום שראוי לטקס הוקרה`);
        }
        if (stats.totalGains > 0 && stats.totalLosses > 0) {
          const volatility = stats.totalGains + stats.totalLosses;
          if (volatility > stats.gamesPlayed * 200) {
            messages.push(`${playerName} שחקן של קיצוניות, ${Math.round(stats.totalGains)} שקל רווחים ו${Math.round(stats.totalLosses)} שקל הפסדים`);
            messages.push(`${playerName} הכל או כלום, ${Math.round(stats.totalGains)} שקל למעלה ו${Math.round(stats.totalLosses)} למטה`);
            messages.push(`${Math.round(stats.totalGains)} שקל רווחים ו${Math.round(stats.totalLosses)} הפסדים, ${playerName} על רכבת הרים`);
          } else if (volatility > stats.gamesPlayed * 120) {
            messages.push(`${playerName} שחקן של קיצוניות, ${Math.round(stats.totalGains)} שקל רווחים ו${Math.round(stats.totalLosses)} שקל הפסדים`);
            messages.push(`${playerName} לא משעמם אף פעם, ההיסטוריה שלו מלאה עליות וירידות`);
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
          messages.push(`${playerName} הפסיד בשלושת המשחקים האחרונים, מינוס ${totalLoss3} שקל, הערב חייב להשתנות`);
          messages.push(`שלושה הפסדים אחרונים, סך הכל מינוס ${totalLoss3} שקל, ${playerName} מחכה לקאמבק`);
          messages.push(`${playerName} במינוס ${totalLoss3} שקל בשלושה אחרונים, הערב חייב להיות שונה`);
        }
        if (all3Won) {
          const totalWin3 = Math.round(last3.reduce((sum, g) => sum + g.profit, 0));
          messages.push(`${playerName} ניצח בשלושת האחרונים, פלוס ${totalWin3} שקל, אבל הערב הכיוון התהפך`);
          messages.push(`שלושה נצחונות אחרונים, פלוס ${totalWin3} שקל, ${playerName} הערב סיפור אחר`);
          messages.push(`${playerName} בפלוס ${totalWin3} שקל בשלושה אחרונים, אבל הערב לא אותו דבר`);
        }
      }
      if (stats.lastGameResults.length >= 5) {
        const last5 = stats.lastGameResults.slice(0, 5);
        const wins5 = last5.filter(g => g.profit > 0).length;
        const losses5 = last5.filter(g => g.profit < 0).length;
        if (wins5 >= 4) {
          messages.push(`${playerName} ניצח ב${wins5} מתוך 5 משחקים אחרונים, הערב מנסה לשנות את המגמה`);
        } else if (losses5 >= 4) {
          messages.push(`${playerName} הפסיד ב${losses5} מתוך 5 אחרונים, הערב ממשיך באותו קו`);
          messages.push(`${losses5} הפסדים מתוך 5 אחרונים, ${playerName} לא בתקופה הכי טובה`);
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

      // --- Player-specific trait messages (reuse generateTraitMessages) ---
      messages.push(...generateTraitMessages(playerName, currentGameRebuys));

      // --- Always-applicable mixed-stat messages (broad pool for any player with history) ---
      const spent = currentGameRebuys * settings.rebuyValue;
      const wc = stats.winCount;
      const lc = stats.gamesPlayed - stats.winCount;
      messages.push(`${playerName} עם ${wc} נצחונות ו${lc} הפסדים, הערב עוד משחק למאזן`);
      messages.push(`${playerName}, ${gp} משחקים, ${wc} נצחונות, הערב צריך עוד אחד לרשימה`);
      messages.push(`${playerName} שם ${spent} שקל הערב, נראה אם ההשקעה תחזיר את עצמה`);
      messages.push(`עוד קנייה של ${playerName}, כבר ${Math.ceil(currentGameRebuys)} הערב`);
      messages.push(`${playerName} ממשיך להאמין, ${Math.ceil(currentGameRebuys)} קניות ולא עוצר`);
      messages.push(`${playerName} ניצח ב${wc} מתוך ${gp} משחקים, הערב מוסיף עוד קנייה`);
      if (stats.biggestWin > 50) {
        messages.push(`${playerName} יודע מה זה לנצח, פעם לקח ${Math.round(stats.biggestWin)} שקל, מחכה לרגע כזה`);
        messages.push(`שיא רווח של ${Math.round(stats.biggestWin)} שקל, ${playerName} עדיין מחפש את הרגע`);
      }
      if (stats.avgProfit !== 0) {
        const dir = stats.avgProfit > 0 ? 'פלוס' : 'מינוס';
        messages.push(`${playerName} בממוצע ${dir} ${Math.round(Math.abs(stats.avgProfit))} שקל למשחק, נראה מה הערב יעשה`);
      }
      if (wp >= 40 && wp <= 60) {
        messages.push(`${playerName} מנצח ב${wp} אחוז, שחקן ממוצע שקונה מעל הממוצע`);
        messages.push(`${wp} אחוז נצחונות, ${playerName} הערב צריך לשפר את המספר`);
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
    
    // Check if total has half (0.5) - use tolerance for floating point
    const hasHalf = Math.abs((totalBuyins % 1) - 0.5) < 0.01;
    const whole = Math.floor(totalBuyins);

    // Format total in Hebrew words (feminine for קניות)
    let totalText: string;
    if (hasHalf) {
      totalText = whole === 0 ? 'חצי' : `${hebrewNum(whole, true)} וחצי`;
    } else {
      totalText = whole <= 10 ? hebrewNum(whole, true) : numberToHebrewTTS(whole);
    }

    const buyAction = isHalfBuyin ? 'עוד חצי' : 'עוד אחד';

    // Decide which extra announcement to make (priority system)
    // Rebuy leader/tied/record announcements only kick in at 4+ rebuys (totalBuyins >= 5)
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
        `${playerName} תפס את המקום הראשון בקניות. כבר ${hebrewNum(ceilBuyins, true)}!`,
        `כל הכבוד ${playerName}. מוביל חדש עם ${hebrewNum(ceilBuyins, true)} קניות`,
      ];
      extraMessage = leaderMessages[Math.floor(Math.random() * leaderMessages.length)];
    } else if (rebuyThresholdMet && ctx.isTiedForLead) {
      extraMessage = getTiedForLeadMessage(playerName, ctx.tiedLeaderNames, totalBuyins);
    } else if (isHalfBuyin) {
      const halfMessages = [
        'רק חצי? חסכן או פשוט זהיר?',
        'חצי קנייה, חצי סיכון, כל הכבוד על האיפוק',
        'חצי בפנים, נראה אם זה מספיק',
        'חצי קנייה, גישה חכמה, לא משקיעים הכל בבת אחת',
        'רגל אחת בפנים, רגל אחת בחוץ, גישה מעניינת',
        'חצי קנייה, חצי תקווה, אבל תקווה שלמה',
        'נו, לפחות הארנק לא הרגיש את זה כל כך',
        'חצי חצי, בינתיים חוסכים, נראה כמה זמן זה יחזיק',
        'מזמינים חצי מנה גם במסעדה? סגנון עקבי',
        'חצי קנייה, כי למה לסכן הכל כשאפשר לסכן חצי',
        'אצבע על הדופק וחצי יד בכיס, תכלס גישה נכונה',
        'חצי קנייה, חצי כאב, הארנק מודה',
        'קונים בזהירות הערב, מעניין כמה זה יחזיק',
        'חצי עכשיו, חצי אחר כך, או שאולי זה מספיק',
        'טיפה בים, אבל לפעמים טיפה משנה הכל',
        'רק חצי, כי מה הטעם לבזבז הכל בבת אחת',
        'מינימליסט גם בפוקר, רק מה שצריך',
        'חצי קנייה, חצי חיוך, נראה איך זה ייגמר',
        'נכנסים בעדינות, לא צריך לשבור דלתות',
        'חצי? זה כמו להזמין מים בבר, אבל בסדר',
        'לפחות החצי הזה קטן על הארנק',
        'בואו נקרא לזה טעימה, לא קנייה',
        'חצי עכשיו ונראה מה הקלפים אומרים',
        'קנייה דיאטטית, פחות קלוריות לארנק',
      ];
      extraMessage = halfMessages[Math.floor(Math.random() * halfMessages.length)];
    } else {
      const personal = getPersonalMessage(playerName, playerId, ceilBuyins, isQuickRebuy, ctx.allPlayers);
      extraMessage = personal || getBuyinMessage(ceilBuyins, isQuickRebuy);
    }

    // Force a trait message at least once per player per game (skip on half buyins to avoid count mismatch)
    if (!isHalfBuyin && playerTraitsByName[playerName] && !traitSpokenRef.current.has(playerName)) {
      const rebuysCount = ceilBuyins - 1;
      const shouldForce = rebuysCount >= 2 || (rebuysCount === 1 && Math.random() < 0.5);
      if (shouldForce) {
        const traitPool = generateTraitMessages(playerName, ceilBuyins);
        const unusedTraits = traitPool.filter(m => !usedMessagesRef.current.has(m));
        const pool = unusedTraits.length > 0 ? unusedTraits : traitPool;
        if (pool.length > 0) {
          const chosen = pool[Math.floor(Math.random() * pool.length)];
          usedMessagesRef.current.add(chosen);
          extraMessage = chosen;
          traitSpokenRef.current.add(playerName);
        }
      }
    }

    const fullMessage = `${playerName}. ${buyAction}. סך הכל ${totalText}. ${extraMessage}`;

    // Build follow-up announcements
    const allMessages: string[] = [fullMessage];

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
        `וואו. סך הכל ${hebrewNum(crossedMilestone, true)} קניות הערב!`,
        `הגענו כבר ${hebrewNum(crossedMilestone, true)} קניות הערב!`,
      ];
      allMessages.push(milestoneMessages[Math.floor(Math.random() * milestoneMessages.length)]);
    }

    // Last man standing
    if (ctx.lastManStanding) {
      const lastManMessages = [
        `${ctx.lastManStanding} האחרון שעוד מחזיק מהקנייה הראשונה!`,
        `רק ${ctx.lastManStanding} נשאר בלי קנייה נוספת. כל השאר כבר קנו`,
        `${ctx.lastManStanding} עדיין על הראשונה. כל הכבוד`,
        `כולם כבר קנו חוץ מ${ctx.lastManStanding}. מי יחזיק יותר?`,
        `${ctx.lastManStanding} האחרון על הקנייה הראשונה. לחץ!`,
      ];
      allMessages.push(lastManMessages[Math.floor(Math.random() * lastManMessages.length)]);
    }

    speakHebrew(allMessages, getGeminiApiKey());
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
    const hasHalf = Math.abs((newTotal % 1) - 0.5) < 0.01;
    const whole = Math.floor(newTotal);
    let totalText: string;
    if (hasHalf) {
      totalText = whole === 0 ? 'חצי' : `${hebrewNum(whole, true)} וחצי`;
    } else {
      totalText = whole <= 10 ? hebrewNum(whole, true) : numberToHebrewTTS(whole);
    }

    const undoText = undoAmount === 0.5 ? 'חצי' : 'אחד';
    const message = `ביטול. ${playerName} מינוס ${undoText}. סך הכל ${totalText}.`;

    speakHebrew([message], getGeminiApiKey());
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
              const perPerson = expense.participants.length > 0 ? expense.amount / expense.participants.length : 0;
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

