import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { GamePlayer, GameAction, SharedExpense, LiveGameTTSPool, TTSMessage, TTSAnticipatedCategory } from '../types';
import { getGamePlayers, updateGamePlayerRebuys, getSettings, updateGameStatus, getGame, addSharedExpense, removeSharedExpense, updateSharedExpense, removeGamePlayer, getPlayerStats, loadTTSPool, loadTTSPoolModel, saveTTSPool, isPlayerFemale } from '../database/storage';
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh';
import { cleanNumber } from '../utils/calculations';
import { numberToHebrewTTS, hebrewNum, hebrewNumConstruct, hebrewOrdinal, speakHebrew, setTTSStatusCallback, getElevenLabsApiKey, getElevenLabsUsageLive, initElevenLabsSession, warmupAudioContext } from '../utils/tts';
import { getGeminiApiKey } from '../utils/geminiAI';
import { generateTraitMessages } from '../utils/playerTraits';
import { getRebuyRecords as getRebuyRecordsFromStorage } from '../database/storage';
import { usePermissions } from '../App';
import AddExpenseModal from '../components/AddExpenseModal';
import { useTranslation } from '../i18n';

const LiveGameScreen = () => {
  const { gameId } = useParams<{ gameId: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
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
  const [socialAction, setSocialAction] = useState<'bad_beat' | 'big_hand' | null>(null);

  
  // Track last rebuy time per player for quick rebuy detection
  const lastRebuyTimeRef = useRef<Map<string, number>>(new Map());

  // Cache historical rebuy records (computed once per session)
  const rebuyRecordsRef = useRef<{ playerMax: Map<string, number>; groupMax: number; groupMaxHolder: string } | null>(null);
  // Track which records have been announced as broken during this game session
  // so "record broken" fires only ONCE per player/group
  const personalRecordAnnouncedRef = useRef<Set<string>>(new Set());
  const groupRecordAnnouncedRef = useRef<boolean>(false);

  // Track "last man standing" so it's only announced once per game
  const lastManAnnouncedRef = useRef(false);

  // AI TTS pool (loaded from cache on mount)
  const ttsPoolRef = useRef<LiveGameTTSPool | null>(null);
  const isSpeakingRef = useRef(false);
  const lastTTSActivityRef = useRef(Date.now());
  const [ttsModelName, setTtsModelName] = useState<string>('');
  const ttsQueueRef = useRef<Promise<void>>(Promise.resolve());

  // TTS debug overlay
  const [ttsLog, setTtsLog] = useState<Array<{ text: string; type: string; ts: number }>>([]);
  const [showTtsDebug, setShowTtsDebug] = useState(false);
  const ttsDebugTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    warmupAudioContext();
    setTTSStatusCallback((entry) => {
      const now = Date.now();
      setTtsLog(prev => [...prev.slice(-14), { text: entry.text, type: entry.type, ts: now }]);
      setShowTtsDebug(true);
      if (ttsDebugTimerRef.current) clearTimeout(ttsDebugTimerRef.current);
      ttsDebugTimerRef.current = setTimeout(() => setShowTtsDebug(false), 30000);
    });
    return () => {
      setTTSStatusCallback(null);
      if (ttsDebugTimerRef.current) clearTimeout(ttsDebugTimerRef.current);
    };
  }, []);

  // Load AI TTS pool on mount
  useEffect(() => {
    if (gameId) {
      const pool = loadTTSPool<LiveGameTTSPool>(gameId);
      if (pool) {
        ttsPoolRef.current = pool;
        console.log('🎙️ AI TTS pool loaded for game', gameId);
      }
      const model = loadTTSPoolModel(gameId);
      if (model) setTtsModelName(model);
    }
  }, [gameId]);

  // Format buyin count with proper half support: 2.5 → "שתיים וחצי", 3 → "שלוש"
  const formatBuyins = (n: number, construct = false): string => {
    const hasHalf = Math.abs((n % 1) - 0.5) < 0.01;
    const whole = Math.floor(n);
    if (hasHalf) {
      if (whole === 0) return 'חצי';
      return `${construct ? hebrewNumConstruct(whole, true) : hebrewNum(whole, true)} וחצי`;
    }
    return construct ? hebrewNumConstruct(whole, true) : hebrewNum(whole, true);
  };

  const fillPlaceholders = (
    msg: TTSMessage,
    vars: { PLAYER?: string; COUNT?: number; POT?: number; RECORD?: number; RIVAL?: string; RANK?: number }
  ): string | null => {
    let text = msg.text;
    const placeholders = msg.placeholders || [];
    for (const ph of placeholders) {
      switch (ph) {
        case '{PLAYER}':
          if (!vars.PLAYER) return null;
          text = text.replace('{PLAYER}', vars.PLAYER);
          break;
        case '{COUNT}':
          if (vars.COUNT == null) return null;
          {
            const countPos = text.indexOf('{COUNT}');
            const afterCount = text.substring(countPos + 7);
            const beforeNoun = /^\s+[\u0590-\u05FF]/.test(afterCount);
            text = text.replace('{COUNT}', formatBuyins(vars.COUNT, beforeNoun));
          }
          break;
        case '{POT}':
          if (vars.POT == null) return null;
          text = text.replace('{POT}', String(vars.POT));
          break;
        case '{RECORD}':
          if (vars.RECORD == null) return null;
          text = text.replace('{RECORD}', formatBuyins(vars.RECORD));
          break;
        case '{RIVAL}':
          if (!vars.RIVAL) return null;
          text = text.replace('{RIVAL}', vars.RIVAL);
          break;
        case '{RANK}':
          if (vars.RANK == null) return null;
          text = text.replace('{RANK}', hebrewOrdinal(vars.RANK));
          break;
      }
    }
    // Safety: ensure no unfilled placeholders remain
    if (text.includes('{') && text.includes('}')) return null;
    return text;
  };

  const pickFromPool = (
    messages: TTSMessage[] | undefined,
    categoryKey: string,
    vars: { PLAYER?: string; COUNT?: number; POT?: number; RECORD?: number; RIVAL?: string; RANK?: number }
  ): string | null => {
    if (!messages || messages.length === 0) return null;
    const pool = ttsPoolRef.current;
    if (!pool) return null;
    if (!pool.spokenTexts) pool.spokenTexts = [];

    const usedIndices = pool.usedIndices[categoryKey] || [];
    const unusedIndices = messages.map((_, i) => i).filter(i => !usedIndices.includes(i));
    const candidates = unusedIndices.length > 0 ? unusedIndices : messages.map((_, i) => i);

    const tried = new Set<number>();
    for (let attempt = 0; attempt < candidates.length; attempt++) {
      const remaining = candidates.filter(i => !tried.has(i));
      if (remaining.length === 0) break;
      const idx = remaining[Math.floor(Math.random() * remaining.length)];
      tried.add(idx);
      const filled = fillPlaceholders(messages[idx], vars);
      if (filled && !pool.spokenTexts.includes(filled)) {
        if (!pool.usedIndices[categoryKey]) pool.usedIndices[categoryKey] = [];
        pool.usedIndices[categoryKey].push(idx);
        pool.spokenTexts.push(filled);
        saveTTSPool(pool.gameId, pool);
        return filled;
      }
    }
    return null;
  };

  const pickAnticipated = (
    playerName: string,
    category: TTSAnticipatedCategory,
    vars: { PLAYER?: string; COUNT?: number; POT?: number; RECORD?: number; RIVAL?: string; RANK?: number }
  ): string | null => {
    const pool = ttsPoolRef.current;
    if (!pool) return null;
    const playerMsgs = pool.players[playerName];
    if (!playerMsgs?.anticipated?.[category]) return null;
    return pickFromPool(playerMsgs.anticipated[category], `players.${playerName}.anticipated.${category}`, vars);
  };

  const pickGeneric = (
    playerName: string,
    vars: { PLAYER?: string; COUNT?: number; POT?: number; RECORD?: number; RIVAL?: string; RANK?: number }
  ): string | null => {
    const pool = ttsPoolRef.current;
    if (!pool) return null;
    const playerMsgs = pool.players[playerName];
    if (!playerMsgs) return null;
    return pickFromPool(playerMsgs.generic, `players.${playerName}.generic`, vars);
  };

  // Pick a unique hardcoded message — avoids repeats across the entire game session
  const pickUniqueHardcoded = (messages: string[]): string => {
    const pool = ttsPoolRef.current;
    const spokenSet = pool?.spokenTexts || [];
    const unused = messages.filter(m => !spokenSet.includes(m));
    const candidates = unused.length > 0 ? unused : messages;
    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
    if (pool) {
      if (!pool.spokenTexts) pool.spokenTexts = [];
      pool.spokenTexts.push(chosen);
      saveTTSPool(pool.gameId, pool);
    }
    return chosen;
  };

  const getRebuyRecords = () => {
    if (rebuyRecordsRef.current) return rebuyRecordsRef.current;
    rebuyRecordsRef.current = getRebuyRecordsFromStorage();
    return rebuyRecordsRef.current;
  };
  
  // Shared AudioContext to avoid creating too many instances (browsers have limits)
  const audioContextRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    if (gameId) {
      loadData();
      const elKey = getElevenLabsApiKey();
      if (elKey) {
        getElevenLabsUsageLive(elKey).then(usage => {
          if (usage) initElevenLabsSession(usage.used, gameId);
        });
      }
    } else {
      setGameNotFound(true);
      setIsLoading(false);
    }
  }, [gameId]);

  useRealtimeRefresh(useCallback(() => { if (gameId) loadData(); }, [gameId]));

  // Pre-load voices (they may not be immediately available)
  useEffect(() => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.onvoiceschanged = () => {
        window.speechSynthesis.getVoices();
      };
    }
  }, []);

  // Auto-announcements: fire every 25 min of quiet, max 4 per game

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
      alert(t('live.cantRemove'));
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
        <p className="text-muted">{t('common.loading')}</p>
      </div>
    );
  }

  // Game not found
  if (gameNotFound) {
    return (
      <div className="fade-in" style={{ textAlign: 'center', padding: '3rem' }}>
        <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>😕</div>
        <h2 style={{ marginBottom: '0.5rem' }}>{t('live.gameNotFound')}</h2>
        <p className="text-muted" style={{ marginBottom: '1.5rem' }}>{t('live.gameNotFoundDesc')}</p>
        <button className="btn btn-primary" onClick={() => navigate('/')}>{t('live.goHome')}</button>
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
  const playRebuyCasinoSound = async (totalBuyins: number): Promise<void> => {
    try {
      const audioContext = getAudioContext();

      // Must await resume — if context is suspended, tones scheduled before
      // it resumes will silently not play, causing TTS to start with no tone
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }

      await new Promise<void>((resolve) => {
        
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
      });
    } catch (e) {
      console.log('Could not play rebuy sound:', e);
    }
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
        'אני מתחילה לדאוג, לא על הכסף. טוב, גם על הכסף',
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
        'תודה על המימון, השולחן לא היה אותו דבר בלי זה',
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
      'אני חושבת שהקלפים חתמו חרם על מישהו הערב',
      'המחויבות הזאת מרשימה, הכסף כבר פחות',
      'תראה את זה ככה, עשית ערב בלתי נשכח לכולם',
      'לפחות יש סיפור מעולה למחר, לא? זה שווה משהו',
      'מציעה להפסיק לספור, זה כבר כואב לכולנו',
    ];
    
    let message: string;
    const bucket = Math.ceil(totalBuyins);
    
    if (totalBuyins >= 10) {
      message = finalMessages[Math.floor(Math.random() * finalMessages.length)];
    } else if (totalBuyins >= 7) {
      message = highMessages[Math.floor(Math.random() * highMessages.length)];
    } else {
      const levelMessages = messages[bucket] || messages[6];
      message = levelMessages[Math.floor(Math.random() * levelMessages.length)];
    }
    
    // Use ONLY quick rebuy message if applicable (only for 3rd+ total buyin)
    if (isQuickRebuy && totalBuyins > 2) {
      message = quickMessages[Math.floor(Math.random() * quickMessages.length)];
    }
    
    // When totalBuyins has a half (e.g., 2.5), the bucket rounds up (to 3),
    // so messages may say "שלוש קניות" while the structural msg said "שתיים וחצי".
    // Replace the bucket's Hebrew number word with the actual formatted count.
    const hasHalf = Math.abs((totalBuyins % 1) - 0.5) < 0.01;
    if (hasHalf && bucket >= 2 && bucket <= 10) {
      const bucketWord = hebrewNum(bucket, true);
      const actualWord = formatBuyins(totalBuyins);
      message = message.replace(bucketWord, actualWord);
    }
    
    return message;
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
      const fem = isPlayerFemale(playerName);
      const g = (m: string, f: string) => fem ? f : m;

      // --- Current streak ---
      const streak = stats.currentStreak;
      const absStreak = Math.abs(streak);
      if (streak >= 4) {
        messages.push(`${playerName} על רצף של ${hebrewNum(streak, false)} נצחונות ברצף, מתי זה ייגמר?`);
        messages.push(`${hebrewNum(streak, false)} נצחונות ברצף, אבל הקניות של ${playerName} מספרות סיפור אחר`);
        messages.push(`${playerName} על רצף חם של ${hebrewNum(streak, false)}, הערב ייבדק`);
        messages.push(`${playerName} ${g('שולט', 'שולטת')} עם ${hebrewNum(streak, false)} נצחונות ברצף, נראה אם זה ימשיך`);
        messages.push(`רצף של ${hebrewNum(streak, false)} נצחונות, ${playerName} בדרך כלל לא קונה ככה`);
        messages.push(`${playerName} ${g('ניצח', 'ניצחה')} ${hebrewNum(streak, false)} ברצף, אז למה הקניות לא נעצרות?`);
      } else if (streak === 3) {
        messages.push(`${playerName} על רצף של שלושה נצחונות ברצף, מעניין כמה זה יחזיק`);
        messages.push(`שלושה ברצף, אבל ${playerName} עדיין קונה, מה קורה פה?`);
        messages.push(`${playerName} ${g('ניצח', 'ניצחה')} שלושה ברצף, אז למה בכלל צריך לקנות?`);
        messages.push(`שלושה ברצף של ${playerName}, מסתבר שגם ${g('מנצחים', 'מנצחות')} קונים לפעמים`);
      } else if (streak === 2) {
        messages.push(`${playerName} ${g('ניצח', 'ניצחה')} פעמיים ברצף, הערב יהיה שלישי?`);
        messages.push(`${playerName} על רצף קטן של שניים, נראה מה הערב יביא`);
        messages.push(`שני נצחונות ברצף, אבל ${playerName} הערב בכיוון אחר`);
      } else if (streak <= -4) {
        messages.push(`${playerName} עם ${hebrewNum(absStreak, false)} הפסדים ברצף, הקניות לא יפתרו את זה`);
        messages.push(`${hebrewNum(absStreak, false)} הפסדים ברצף, ${playerName} לא ${g('שובר', 'שוברת')} את הרצף הערב`);
        messages.push(`${playerName} עם ${hebrewNum(absStreak, false)} הפסדים, מתי הגלגל יסתובב?`);
        messages.push(`${playerName}, כבר ${hebrewNum(absStreak, false)} הפסדים ברצף, הגיע הזמן לשבור את זה`);
        messages.push(`כבר ${hebrewNum(absStreak, false)} ברצף של ${playerName}, מתי זה נגמר?`);
        messages.push(`${hebrewNum(absStreak, false)} ברצף, ${playerName} ${g('מחזיק', 'מחזיקה')} בשיא שאף אחד לא רוצה`);
      } else if (streak === -3) {
        messages.push(`${playerName} ${g('הפסיד', 'הפסידה')} שלושה ברצף, אולי הערב ייגמר אחרת`);
        messages.push(`שלושה הפסדים ברצף, ${playerName} מחכה לשינוי מזל`);
        messages.push(`${playerName} ${g('הפסיד', 'הפסידה')} שלושה ברצף, לפי הסטטיסטיקה ${g('מגיע לו', 'מגיע לה')} כבר נצחון`);
        messages.push(`שלושה ברצף, ${playerName} ${g('חייב', 'חייבת')} שהערב יהיה שונה`);
      } else if (streak === -2) {
        messages.push(`${playerName} ${g('הפסיד', 'הפסידה')} שניים ברצף, הערב צריך נצחון`);
        messages.push(`שני הפסדים ברצף, ${playerName} מקווה שהערב ישנה כיוון`);
        messages.push(`שניים ברצף של ${playerName}, ${g('הגיע', 'הגיעה')} הזמן להפוך את המגמה`);
      }

      // --- Win percentage ---
      const wp = Math.round(stats.winPercentage);
      if (wp >= 65 && stats.gamesPlayed >= 5) {
        messages.push(`${playerName} ${g('מנצח', 'מנצחת')} ב${wp} אחוז מהמשחקים, אבל הערב הכיוון הפוך`);
        messages.push(`${wp} אחוז נצחונות, ${playerName} בדרך כלל לא ${g('צריך', 'צריכה')} לקנות ככה`);
        messages.push(`${playerName} עם אחוז נצחונות של ${wp}, הערב חריג במיוחד`);
        messages.push(`${g('מנצח', 'מנצחת')} ב${wp} אחוז ועדיין קונה, ${playerName} הערב לא בקטע ${g('שלו', 'שלה')}`);
      } else if (wp >= 55 && stats.gamesPlayed >= 5) {
        messages.push(`${playerName} ${g('מנצח', 'מנצחת')} ב${wp} אחוז מהמשחקים, מה קורה הערב?`);
        messages.push(`${wp} אחוז נצחונות של ${playerName}, אבל הערב המספרים לא עובדים`);
        messages.push(`${playerName} ${g('רגיל', 'רגילה')} לנצח ב${wp} אחוז, הערב חריג`);
      } else if (wp <= 30 && stats.gamesPlayed >= 5) {
        messages.push(`${playerName} ${g('מנצח', 'מנצחת')} רק ב${wp} אחוז מהמשחקים, אין מה להתפלא`);
        messages.push(`${wp} אחוז נצחונות, ${playerName} לפחות ${g('עקבי', 'עקבית')} בהפסדים`);
        messages.push(`${playerName} עם ${wp} אחוז נצחונות, הקניות הן חלק מהשגרה`);
        messages.push(`רק ${wp} אחוז נצחונות, ${playerName} לפחות ${g('נהנה', 'נהנית')} מהחברה`);
      } else if (wp <= 40 && stats.gamesPlayed >= 8) {
        messages.push(`${playerName} ${g('מנצח', 'מנצחת')} ב${wp} אחוז, יש לאן לשפר`);
        messages.push(`${wp} אחוז נצחונות של ${playerName}, יש מקום לצמיחה`);
        messages.push(`${playerName} עם ${wp} אחוז, הקניות הן חלק מהנוף`);
      }

      // --- Overall profit/loss ---
      const profit = Math.round(stats.totalProfit);
      const absProfit = Math.round(Math.abs(stats.totalProfit));
      if (stats.totalProfit > 500) {
        messages.push(`${playerName} ברווח של ${profit} שקל סך הכל, אז יש מאיפה לממן קניות`);
        messages.push(`${playerName} עדיין בפלוס של ${profit} שקל, אז מה זה עוד קנייה קטנה`);
        messages.push(`פלוס ${profit} שקל סך הכל, ${playerName} ${g('יכול', 'יכולה')} להרשות ${g('לעצמו', 'לעצמה')}`);
        messages.push(`${playerName} בפלוס ${profit} שקל, זה כסף קטן ${g('בשבילו', 'בשבילה')}`);
      } else if (stats.totalProfit > 200) {
        messages.push(`${playerName} ברווח של ${profit} שקל סך הכל, יש מאיפה לקנות`);
        messages.push(`${playerName} עדיין בפלוס ${profit} שקל, קנייה אחת לא תשנה`);
        messages.push(`${playerName} בפלוס ${profit}, עדיין יש רווח לאבד`);
      } else if (stats.totalProfit > 0 && stats.totalProfit <= 200) {
        messages.push(`${playerName} עדיין בפלוס ${profit} שקל, אבל הרווח ${g('הולך', 'הולכת')} ומתכווץ`);
        messages.push(`${playerName} עם פלוס קטן של ${profit} שקל, הערב יקבע אם זה יישאר`);
        messages.push(`הפלוס של ${profit} שקל של ${playerName} ${g('הולך', 'הולכת')} ומתכווץ`);
      } else if (stats.totalProfit < -500) {
        messages.push(`${playerName} במינוס של ${absProfit} שקל סך הכל, עוד קנייה זה טיפה בים`);
        messages.push(`${playerName} מנסה לסגור חוב של ${absProfit} שקל, דרך ארוכה`);
        messages.push(`מינוס ${absProfit} שקל סך הכל, ${playerName} כבר לא ${g('סופר', 'סופרת')}`);
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
          messages.push(`${playerName} ${g('הרוויח', 'הרוויחה')} ${lastProfit} שקל במשחק הקודם, הערב סיפור אחר לגמרי`);
          messages.push(`אחרי רווח של ${lastProfit} שקל בפעם שעברה, ${playerName} ${g('חוזר', 'חוזרת')} לקנות`);
          messages.push(`${playerName} ${g('הגיע', 'הגיעה')} בביטחון אחרי ${lastProfit} שקל, אבל הערב לא פשוט`);
          messages.push(`רווח גדול של ${lastProfit} שקל בפעם שעברה, ${playerName} הערב ${g('מחזיר', 'מחזירה')} לקופה`);
        } else if (lastGame.profit > 0) {
          messages.push(`${playerName} ${g('הרוויח', 'הרוויחה')} ${lastProfit} שקל במשחק הקודם, הערב קצת אחרת`);
          messages.push(`אחרי פלוס ${lastProfit} שקל בפעם שעברה, ${playerName} הערב מתקשה`);
          messages.push(`${playerName} ${g('הרוויח', 'הרוויחה')} ${lastProfit} שקל בפעם שעברה, הערב הכיוון הפוך`);
        } else if (lastGame.profit < -200) {
          messages.push(`${playerName} ${g('הפסיד', 'הפסידה')} ${lastAbsProfit} שקל במשחק הקודם ומנסה להחזיר`);
          messages.push(`אחרי הפסד של ${lastAbsProfit} שקל בפעם שעברה, ${playerName} ${g('ממשיך', 'ממשיכה')} לקנות`);
          messages.push(`${playerName} עם מינוס ${lastAbsProfit} שקל מהמשחק הקודם, הערב ${g('ממשיך', 'ממשיכה')} באותו כיוון`);
          messages.push(`הפסד של ${lastAbsProfit} שקל בפעם שעברה, ${playerName} לא ${g('מוותר', 'מוותרת')}`);
        } else if (lastGame.profit < -50) {
          messages.push(`${playerName} ${g('הפסיד', 'הפסידה')} ${lastAbsProfit} שקל במשחק הקודם, הערב לא מתחיל טוב יותר`);
          messages.push(`${playerName} ${g('סיים', 'סיימה')} מינוס ${lastAbsProfit} שקל בפעם שעברה, הערב אותו סיפור`);
          messages.push(`${playerName} ${g('הפסיד', 'הפסידה')} ${lastAbsProfit} שקל במשחק הקודם ועדיין קונה`);
        } else if (lastGame.profit < 0) {
          messages.push(`${playerName} ${g('סיים', 'סיימה')} עם מינוס קטן בפעם שעברה, הערב מקווה לטוב יותר`);
        }
      }

      // --- Avg profit per game ---
      if (stats.avgProfit > 80 && stats.gamesPlayed >= 5) {
        messages.push(`${playerName} ${g('מרוויח', 'מרוויחה')} בממוצע ${Math.round(stats.avgProfit)} שקל למשחק, הערב מוריד את הממוצע`);
        messages.push(`ממוצע רווח של ${Math.round(stats.avgProfit)} שקל למשחק, ${playerName} הערב לא ברמה הרגילה`);
        messages.push(`${playerName} ${g('רגיל', 'רגילה')} לפלוס ${Math.round(stats.avgProfit)} למשחק, הערב חריג`);
      } else if (stats.avgProfit > 30 && stats.gamesPlayed >= 5) {
        messages.push(`${playerName} בממוצע ${g('מרוויח', 'מרוויחה')} ${Math.round(stats.avgProfit)} שקל למשחק, הערב מוריד את הממוצע`);
        messages.push(`${playerName} ${g('רגיל', 'רגילה')} לפלוס ${Math.round(stats.avgProfit)} למשחק, הערב משנה את הסיפור`);
      } else if (stats.avgProfit < -80 && stats.gamesPlayed >= 5) {
        messages.push(`${playerName} ${g('מפסיד', 'מפסידה')} בממוצע ${Math.round(Math.abs(stats.avgProfit))} שקל למשחק, הערב ממשיך את המגמה`);
        messages.push(`${playerName} ${g('מפסיד', 'מפסידה')} בממוצע ${Math.round(Math.abs(stats.avgProfit))} שקל למשחק, לפחות ${g('עקבי', 'עקבית')}`);
        messages.push(`ממוצע הפסד של ${Math.round(Math.abs(stats.avgProfit))} שקל, ${playerName} הערב לא ${g('משפר', 'משפרת')}`);
      } else if (stats.avgProfit < -30 && stats.gamesPlayed >= 5) {
        messages.push(`${playerName} ${g('מפסיד', 'מפסידה')} בממוצע ${Math.round(Math.abs(stats.avgProfit))} שקל למשחק, המגמה ממשיכה`);
        messages.push(`ממוצע הפסד של ${Math.round(Math.abs(stats.avgProfit))} שקל למשחק, ${playerName} הערב לא משנה`);
      }

      // --- Games played milestones ---
      const gp = stats.gamesPlayed;
      if (gp >= 50) {
        messages.push(`${playerName} ${g('ותיק', 'ותיקה')} עם ${gp} משחקים, הניסיון לא עוזר הערב`);
        messages.push(`${gp} משחקים, ו${playerName} עדיין קונה כמו מתחיל`);
        messages.push(`${playerName} ${g('שיחק', 'שיחקה')} כבר ${gp} משחקים, ${g('מכיר', 'מכירה')} כל קלף ועדיין לא ${g('למד', 'למדה')}`);
        messages.push(`${g('ותיק', 'ותיקה')} של ${gp} משחקים, אבל ${playerName} לא ${g('לומד', 'לומדת')} מטעויות`);
      } else if (gp >= 30) {
        messages.push(`${playerName} ${g('שיחק', 'שיחקה')} כבר ${gp} משחקים, ולא מפסיק לקנות`);
        messages.push(`${gp} משחקים ו${playerName} עדיין ${g('מממן', 'מממנת')} את השולחן`);
        messages.push(`${playerName} עם ${gp} משחקי ניסיון, אבל הניסיון לא מונע קניות`);
      } else if (gp >= 15) {
        messages.push(`${gp} משחקים, ${playerName} כבר ${g('מכיר', 'מכירה')} את הדרך לארנק`);
        messages.push(`${playerName} עם ${gp} משחקים, שחקן מנוסה שקונה כמו ${g('חדש', 'חדשה')}`);
        messages.push(`${gp} משחקים ו${playerName} עדיין לא ${g('הפנים', 'הפנימה')} את הלקח`);
      } else if (gp >= 8) {
        messages.push(`${playerName} עם ${gp} משחקים, עדיין ${g('לומד', 'לומדת')} את השולחן`);
        messages.push(`${gp} משחקים של ${playerName}, צובר ניסיון על חשבון הארנק`);
      } else if (gp <= 5) {
        messages.push(`${playerName} ${g('חדש', 'חדשה')} יחסית עם רק ${gp} משחקים, עדיין ${g('לומד', 'לומדת')} לשלם`);
        messages.push(`${playerName} רק ${gp} משחקים, הניסיון עוד יבוא`);
        messages.push(`רק ${gp} משחקים של ${playerName}, אבל הקניות כבר ברמת מקצוענים`);
      }

      // --- Biggest win/loss references ---
      if (stats.biggestWin > 200) {
        messages.push(`הנצחון הכי גדול של ${playerName} היה ${Math.round(stats.biggestWin)} שקל, הערב בכיוון ההפוך`);
        messages.push(`${playerName} פעם ${g('לקח', 'לקחה')} ${Math.round(stats.biggestWin)} שקל, איפה הרגע הזה הערב?`);
        messages.push(`שיא רווח של ${Math.round(stats.biggestWin)} שקל, ${playerName} הערב רחוק מזה`);
      } else if (stats.biggestWin > 100) {
        messages.push(`הנצחון הכי גדול של ${playerName} היה ${Math.round(stats.biggestWin)} שקל, הערב הכיוון הפוך`);
        messages.push(`${playerName} ${g('יודע', 'יודעת')} לנצח, פעם ${g('לקח', 'לקחה')} ${Math.round(stats.biggestWin)} שקל, הערב לא אותו סיפור`);
      }
      if (stats.biggestLoss < -200) {
        messages.push(`ההפסד הכי גדול של ${playerName} היה ${Math.round(Math.abs(stats.biggestLoss))} שקל, נקווה שהערב לא נגיע לשם`);
        messages.push(`${playerName} פעם ${g('הפסיד', 'הפסידה')} ${Math.round(Math.abs(stats.biggestLoss))} שקל, הערב בדרך לשבור את השיא?`);
        messages.push(`שיא הפסד של ${Math.round(Math.abs(stats.biggestLoss))} שקל, ${playerName} הערב עוד לא שם`);
      } else if (stats.biggestLoss < -100) {
        messages.push(`ההפסד הכי גדול של ${playerName} היה ${Math.round(Math.abs(stats.biggestLoss))} שקל, נקווה שהערב לא נגיע לשם`);
        messages.push(`${playerName} פעם ${g('הפסיד', 'הפסידה')} ${Math.round(Math.abs(stats.biggestLoss))} שקל, הערב מנסה לא לחזור על זה`);
      }

      // --- Longest streaks ---
      if (stats.longestWinStreak >= 4) {
        messages.push(`השיא של ${playerName} הוא ${stats.longestWinStreak} נצחונות ברצף, הערב לא נראה שזה יקרה`);
        messages.push(`${playerName} פעם ${g('ניצח', 'ניצחה')} ${stats.longestWinStreak} ברצף, הערב סיפור אחר`);
        messages.push(`רצף שיא של ${stats.longestWinStreak} נצחונות, ${playerName} הערב רחוק מזה`);
      }
      if (stats.longestLossStreak >= 4) {
        messages.push(`${playerName} פעם ${g('הפסיד', 'הפסידה')} ${stats.longestLossStreak} ברצף, אז מה זה עוד קנייה`);
        messages.push(`שיא הפסדים של ${stats.longestLossStreak} ברצף, ${playerName} ${g('מכיר', 'מכירה')} תקופות קשות`);
        messages.push(`${playerName} ${g('שרד', 'שרדה')} ${stats.longestLossStreak} הפסדים ברצף, עוד קנייה לא תשבור ${g('אותו', 'אותה')}`);
      }

      // --- Avg win vs avg loss ---
      if (stats.avgWin > 0 && stats.avgLoss > 0) {
        if (stats.avgWin > stats.avgLoss * 1.5) {
          messages.push(`כש${playerName} ${g('מנצח', 'מנצחת')}, ${g('הוא', 'היא')} ${g('מנצח', 'מנצחת')} גדול, ממוצע של ${Math.round(stats.avgWin)} שקל, רק צריך להגיע לשם`);
          messages.push(`${playerName} ${g('מרוויח', 'מרוויחה')} בממוצע ${Math.round(stats.avgWin)} שקל כש${g('הוא', 'היא')} ${g('מנצח', 'מנצחת')}, חבל שהערב זה לא קורה`);
          messages.push(`רווח ממוצע של ${Math.round(stats.avgWin)} שקל, ${playerName} צריך רק הזדמנות אחת טובה`);
        } else if (stats.avgLoss > stats.avgWin * 1.5) {
          messages.push(`${playerName} ${g('מפסיד', 'מפסידה')} בממוצע ${Math.round(stats.avgLoss)} שקל ו${g('מרוויח', 'מרוויחה')} רק ${Math.round(stats.avgWin)}, היחס לא טוב`);
          messages.push(`${playerName} ${g('מפסיד', 'מפסידה')} גדול ו${g('מנצח', 'מנצחת')} קטן, ממוצע הפסד של ${Math.round(stats.avgLoss)} שקל`);
          messages.push(`הפסד ממוצע של ${Math.round(stats.avgLoss)} מול רווח ממוצע של ${Math.round(stats.avgWin)}, ${playerName} ${g('צריך', 'צריכה')} לשנות גישה`);
        }
      }

      // --- Win count facts ---
      if (stats.winCount >= 10 && stats.gamesPlayed >= 15) {
        messages.push(`${playerName} ${g('ניצח', 'ניצחה')} ${stats.winCount} משחקים סך הכל, הערב לא נראה שזה יתווסף`);
        messages.push(`${stats.winCount} נצחונות של ${playerName}, אבל הערב הצד השני גדל`);
      }
      if (stats.winCount <= 3 && stats.gamesPlayed >= 10) {
        messages.push(`${playerName} ${g('ניצח', 'ניצחה')} רק ${stats.winCount} מתוך ${gp} משחקים, אין מה להתפלא על הקניות`);
        messages.push(`רק ${stats.winCount} נצחונות מתוך ${gp} משחקים, ${playerName} לפחות ${g('עקבי', 'עקבית')}`);
      }

      // --- Rebuy-related (2026 data only) ---
      if (stats2026 && stats2026.gamesPlayed >= 2) {
        const avgRebuys = stats2026.avgRebuysPerGame;
        if (currentGameRebuys > avgRebuys * 1.5 && currentGameRebuys >= 3) {
          messages.push(`${playerName} בדרך כלל קונה ${Math.round(avgRebuys)} למשחק, הערב כבר ${formatBuyins(currentGameRebuys)}`);
          messages.push(`${playerName} מעל הממוצע ${g('שלו', 'שלה')}, בדרך כלל ${Math.round(avgRebuys)} קניות וכבר ${formatBuyins(currentGameRebuys)}`);
          messages.push(`ממוצע של ${Math.round(avgRebuys)} קניות למשחק, ${playerName} הערב ${g('שובר', 'שוברת')} שיאים`);
          messages.push(`${playerName} ${g('רגיל', 'רגילה')} ל${Math.round(avgRebuys)} קניות למשחק, הערב עובר את זה בהרבה`);
        } else if (currentGameRebuys > avgRebuys && currentGameRebuys >= 2) {
          messages.push(`${playerName} ${g('עבר', 'עברה')} את הממוצע ${g('שלו', 'שלה')} של ${Math.round(avgRebuys)} קניות למשחק`);
          messages.push(`${playerName} בדרך כלל קונה ${Math.round(avgRebuys)} למשחק, וכבר ${formatBuyins(currentGameRebuys)} הערב`);
        }
        if (currentGameRebuys <= 2 && avgRebuys >= 4) {
          messages.push(`${playerName} בדרך כלל קונה ${Math.round(avgRebuys)} למשחק, אז עוד יבואו`);
          messages.push(`עם ממוצע של ${Math.round(avgRebuys)} קניות, ${playerName} עוד רחוק מהשיא ${g('שלו', 'שלה')}`);
          messages.push(`${playerName} ${g('רגיל', 'רגילה')} ל${Math.round(avgRebuys)} למשחק, הערב עוד רק ההתחלה`);
        }

        const totalRebuys2026 = stats2026.totalRebuys + currentGameRebuys;
        if (totalRebuys2026 >= 50) {
          const totalSpent = totalRebuys2026 * settings.rebuyValue;
          messages.push(`${playerName} כבר ${g('שילם', 'שילמה')} ${totalSpent} שקל על קניות מתחילת השנה, הבנקאי של הקבוצה`);
          messages.push(`${totalSpent} שקל על קניות של ${playerName} השנה, תודה על המימון`);
        } else if (totalRebuys2026 >= 30) {
          const totalSpent = totalRebuys2026 * settings.rebuyValue;
          messages.push(`${playerName} כבר ${g('שילם', 'שילמה')} ${totalSpent} שקל על קניות מתחילת השנה, תודה על המימון`);
          messages.push(`${playerName} עם ${formatBuyins(totalRebuys2026)} קניות השנה, ${g('נדיב', 'נדיבה')} כרגיל`);
        } else if (totalRebuys2026 >= 15) {
          messages.push(`${playerName} כבר ${formatBuyins(totalRebuys2026)} קניות מתחילת השנה, קצב יפה`);
          messages.push(`${formatBuyins(totalRebuys2026)} קניות של ${playerName} השנה, מגמה ברורה`);
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
          messages.push(`${playerName} ${g('עקף', 'עקפה')} את ${playerWithMax.playerName} בקניות הערב`);
          messages.push(`אפילו ${playerWithMax.playerName} ${isPlayerFemale(playerWithMax.playerName) ? 'קנתה' : 'קנה'} פחות מ${playerName} הערב`);
          messages.push(`${playerName} ${g('מוביל', 'מובילה')} את טבלת הקניות, ${g('עקף', 'עקפה')} את ${playerWithMax.playerName}`);
          messages.push(`אף אחד לא קנה כמו ${playerName} הערב, אפילו ${playerWithMax.playerName} לא`);
        }
        if (currentGameRebuys >= 3 && playerWithMin && Math.ceil(minRebuysOther) <= 1) {
          messages.push(`${playerName} כבר ${formatBuyins(currentGameRebuys)} קניות ו${playerWithMin.playerName} עדיין על הראשונה`);
          messages.push(`${playerWithMin.playerName} עדיין על הראשונה, ${playerName} כבר ב${formatBuyins(currentGameRebuys)}, פער עצום`);
        }

        const rival = otherPlayers.find(p => Math.abs(p.rebuys - currentGameRebuys) < 0.01);
        if (rival) {
          messages.push(`${playerName} ו${rival.playerName} שווים בקניות הערב, מי ישבור ראשון?`);
          messages.push(`מירוץ קניות בין ${playerName} ל${rival.playerName}, שניהם ב${formatBuyins(currentGameRebuys)}`);
          messages.push(`${playerName} ו${rival.playerName} ראש בראש, ${formatBuyins(currentGameRebuys)} קניות כל אחד`);
          messages.push(`תיקו בקניות, ${playerName} ו${rival.playerName} שניהם ב${formatBuyins(currentGameRebuys)}`);
        }

        for (const other of otherPlayers) {
          const otherStats = allStats.find(s => s.playerId === other.playerId);
          if (!otherStats || otherStats.gamesPlayed < 5) continue;

          if (stats.totalProfit > 100 && otherStats.totalProfit < -100) {
            messages.push(`${playerName} בפלוס ${Math.round(stats.totalProfit)} שקל ו${other.playerName} במינוס ${Math.round(Math.abs(otherStats.totalProfit))}, הערב שניהם קונים`);
            messages.push(`${playerName} ${g('מרוויח', 'מרוויחה')} ו${other.playerName} מפסיד סך הכל, אבל הערב שניהם באותה סירה`);
          }

          const myWp = Math.round(stats.winPercentage);
          const theirWp = Math.round(otherStats.winPercentage);
          if (myWp >= 55 && theirWp <= 35 && stats.gamesPlayed >= 5) {
            messages.push(`${playerName} ${g('מנצח', 'מנצחת')} ב${myWp} אחוז ו${other.playerName} רק ב${theirWp}, אבל הערב שניהם קונים`);
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
          messages.push(`${playerName} ${g('אחראי', 'אחראית')} על ${mySharePercent} אחוז מהכסף הערב, תודה על התמיכה`);
          messages.push(`${mySharePercent} אחוז מהכסף על השולחן הוא של ${playerName}, נדיבות יוצאת דופן`);
          messages.push(`${playerName} ${g('מממן', 'מממנת')} ${mySharePercent} אחוז מהקופה הערב, כל הכבוד`);
        } else if (mySharePercent >= 20 && currentGameRebuys >= 3) {
          messages.push(`${playerName} ${g('אחראי', 'אחראית')} על ${mySharePercent} אחוז מהכסף על השולחן הערב`);
          messages.push(`${playerName} ${g('תורם', 'תורמת')} ${mySharePercent} אחוז מהקופה, תודה על ההשקעה`);
        }
      }

      // --- Head to head with tonight's current leader ---
      if (otherPlayers.length > 0 && currentGameRebuys >= 2) {
        const stillOnFirst = otherPlayers.filter(p => p.rebuys === 1);
        if (stillOnFirst.length >= 2 && currentGameRebuys >= 3) {
          messages.push(`${playerName} כבר ב${formatBuyins(currentGameRebuys)} קניות ו${stillOnFirst.length} שחקנים עדיין על הראשונה`);
          messages.push(`${stillOnFirst.length} שחקנים עדיין על הראשונה, ${playerName} כבר ב${formatBuyins(currentGameRebuys)}`);
        }
      }

      // --- Spending personality ---
      if (stats.gamesPlayed >= 5) {
        const totalSpentAllTime = stats.totalRebuys * settings.rebuyValue;
        if (totalSpentAllTime >= 3000) {
          messages.push(`${playerName} שילם כבר ${totalSpentAllTime} שקל על קניות סך הכל, הבנקאי הרשמי של הקבוצה`);
          messages.push(`${totalSpentAllTime} שקל על קניות של ${playerName}, הספונסר שלא ביקש קרדיט`);
          messages.push(`${playerName} ${g('השקיע', 'השקיעה')} ${totalSpentAllTime} שקל בקניות, מתישהו זה חייב לחזור`);
        } else if (totalSpentAllTime >= 1500) {
          messages.push(`${playerName} ${g('שילם', 'שילמה')} כבר ${totalSpentAllTime} שקל על קניות סך הכל, נדיבות שלא נשכחת`);
          messages.push(`${totalSpentAllTime} שקל על קניות של ${playerName}, סכום שראוי לטקס הוקרה`);
        }
        if (stats.totalGains > 0 && stats.totalLosses > 0) {
          const volatility = stats.totalGains + stats.totalLosses;
          if (volatility > stats.gamesPlayed * 200) {
            messages.push(`${playerName} ${g('שחקן', 'שחקנית')} של קיצוניות, ${Math.round(stats.totalGains)} שקל רווחים ו${Math.round(stats.totalLosses)} שקל הפסדים`);
            messages.push(`${playerName} הכל או כלום, ${Math.round(stats.totalGains)} שקל למעלה ו${Math.round(stats.totalLosses)} למטה`);
            messages.push(`${Math.round(stats.totalGains)} שקל רווחים ו${Math.round(stats.totalLosses)} הפסדים, ${playerName} על רכבת הרים`);
          } else if (volatility > stats.gamesPlayed * 120) {
            messages.push(`${playerName} ${g('שחקן', 'שחקנית')} של קיצוניות, ${Math.round(stats.totalGains)} שקל רווחים ו${Math.round(stats.totalLosses)} שקל הפסדים`);
            messages.push(`${playerName} לא משעמם אף פעם, ההיסטוריה ${g('שלו', 'שלה')} מלאה עליות וירידות`);
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
          messages.push(`${playerName} ${g('הפסיד', 'הפסידה')} בשלושת המשחקים האחרונים, מינוס ${totalLoss3} שקל, הערב חייב להשתנות`);
          messages.push(`שלושה הפסדים אחרונים, סך הכל מינוס ${totalLoss3} שקל, ${playerName} מחכה לקאמבק`);
          messages.push(`${playerName} במינוס ${totalLoss3} שקל בשלושה אחרונים, הערב ${g('חייב', 'חייבת')} להיות שונה`);
        }
        if (all3Won) {
          const totalWin3 = Math.round(last3.reduce((sum, g) => sum + g.profit, 0));
          messages.push(`${playerName} ${g('ניצח', 'ניצחה')} בשלושת האחרונים, פלוס ${totalWin3} שקל, אבל הערב הכיוון התהפך`);
          messages.push(`שלושה נצחונות אחרונים, פלוס ${totalWin3} שקל, ${playerName} הערב סיפור אחר`);
          messages.push(`${playerName} בפלוס ${totalWin3} שקל בשלושה אחרונים, אבל הערב לא אותו דבר`);
        }
      }
      if (stats.lastGameResults.length >= 5) {
        const last5 = stats.lastGameResults.slice(0, 5);
        const wins5 = last5.filter(g => g.profit > 0).length;
        const losses5 = last5.filter(g => g.profit < 0).length;
        if (wins5 >= 4) {
          messages.push(`${playerName} ${g('ניצח', 'ניצחה')} ב${wins5} מתוך 5 משחקים אחרונים, הערב מנסה לשנות את המגמה`);
        } else if (losses5 >= 4) {
          messages.push(`${playerName} ${g('הפסיד', 'הפסידה')} ב${losses5} מתוך 5 אחרונים, הערב ממשיך באותו קו`);
          messages.push(`${losses5} הפסדים מתוך 5 אחרונים, ${playerName} לא בתקופה הכי טובה`);
        }
      }

      // --- Quick rebuy (personalized) ---
      if (isQuickRebuy && currentGameRebuys >= 3) {
        messages.push(`${playerName} ${g('קנה', 'קנתה')} שוב תוך דקות, הכסף לא מחזיק`);
          messages.push(`${playerName} ${g('חוזר', 'חוזרת')} מהר, כבר ${formatBuyins(currentGameRebuys)} קניות`);
        messages.push(`הכסף של ${playerName} נעלם מהר, כבר ${formatBuyins(currentGameRebuys)} קניות הערב`);
        messages.push(`${playerName}, שנייה, עוד לא הספקנו לערבב את הקלפים`);
        messages.push(`${playerName} קונה כאילו יש מבצע, כבר ${formatBuyins(currentGameRebuys)} הערב`);
        messages.push(`${playerName} לא מבזבז זמן, ישר קנייה חדשה`);
          messages.push(`מהיר, ${playerName} ${g('חזר', 'חזרה')} לקנות, כבר ${formatBuyins(currentGameRebuys)}`);
        messages.push(`${playerName} קונה כמו שקונים במכולת, מהר ובלי לחשוב`);
        messages.push(`עוד אחד של ${playerName}, הקלפים לא הספיקו להתקרר`);
        if (stats.totalProfit > 100) {
          messages.push(`${playerName} פלוס ${Math.round(stats.totalProfit)} שקל, אז מה אם זה מהר`);
        } else if (stats.totalProfit < -100) {
          messages.push(`${playerName} מנסה להחזיר ${Math.round(Math.abs(stats.totalProfit))} שקל, ובמהירות`);
        }
        if (stats2026 && stats2026.avgRebuysPerGame > 0 && currentGameRebuys > stats2026.avgRebuysPerGame) {
          messages.push(`${playerName} כבר ${g('עבר', 'עברה')} את הממוצע של ${hebrewNum(Math.round(stats2026.avgRebuysPerGame), true)} ובקצב שיא`);
        }
      }

      // --- High rebuy count personal messages with data ---
      const spentTonight = Math.round(currentGameRebuys * settings.rebuyValue);
      if (currentGameRebuys >= 7) {
        messages.push(`${playerName} כבר ${formatBuyins(currentGameRebuys)} קניות, ${spentTonight} שקל בפנים, הספונסר הרשמי של הערב`);
        messages.push(`הארנק של ${playerName} בוכה, ${formatBuyins(currentGameRebuys)} קניות, ${spentTonight} שקל ועולה`);
        messages.push(`${playerName} עם ${formatBuyins(currentGameRebuys)} קניות, כולם אומרים תודה בלב`);
        messages.push(`${formatBuyins(currentGameRebuys)} קניות של ${playerName}, ${spentTonight} שקל, נו, לפחות יש אופי`);
        messages.push(`${playerName} לא ${g('מוותר', 'מוותרת')}, ${formatBuyins(currentGameRebuys)} קניות ועדיין מחייך`);
        messages.push(`${playerName} שם ${spentTonight} שקל על השולחן הערב, ${formatBuyins(currentGameRebuys)} קניות ועולה`);
        messages.push(`${formatBuyins(currentGameRebuys)} קניות, ${spentTonight} שקל, ${playerName} לא ${g('עוצר', 'עוצרת')}`);
        messages.push(`${playerName}, ${formatBuyins(currentGameRebuys)} קניות, הערב יזכר`);
        if (stats.totalProfit > 0) {
          messages.push(`${playerName} פלוס ${Math.round(stats.totalProfit)} שקל סך הכל, אז מה זה עוד ${spentTonight}?`);
        } else {
          messages.push(`${playerName} מינוס ${Math.round(Math.abs(stats.totalProfit))} שקל, ועכשיו עוד ${spentTonight} הערב`);
        }
      } else if (currentGameRebuys >= 5) {
        messages.push(`${playerName} כבר ${formatBuyins(currentGameRebuys)} קניות, ${spentTonight} שקל, ערב יקר`);
        messages.push(`${formatBuyins(currentGameRebuys)} קניות של ${playerName}, ${spentTonight} שקל, תודה`);
        messages.push(`${playerName}, ${formatBuyins(currentGameRebuys)} קניות, הנדיבות לא נגמרת`);
        messages.push(`${playerName} שם ${spentTonight} שקל הערב, ${formatBuyins(currentGameRebuys)} קניות`);
        messages.push(`${formatBuyins(currentGameRebuys)} קניות ו ${spentTonight} שקל, ${playerName} לא ${g('חוסך', 'חוסכת')}`);
        messages.push(`${playerName} עם ${formatBuyins(currentGameRebuys)} קניות, הערב לא זול`);
        if (stats.winPercentage >= 50) {
          messages.push(`${playerName} ${g('מנצח', 'מנצחת')} ${hebrewNum(Math.round(stats.winPercentage), false)} אחוז מהמשחקים, אז אולי עוד קנייה תעזור`);
        } else {
          messages.push(`${playerName} ${g('מנצח', 'מנצחת')} רק ${hebrewNum(Math.round(stats.winPercentage), false)} אחוז, ${spentTonight} שקל לא ישנו את הסטטיסטיקה`);
        }
      } else if (currentGameRebuys >= 3) {
        messages.push(`${playerName} כבר ${formatBuyins(currentGameRebuys)} קניות, ${spentTonight} שקל, תודה על התרומה`);
        messages.push(`מישהו שיעצור את ${playerName}, כבר ${formatBuyins(currentGameRebuys)} קניות`);
        messages.push(`${playerName}, ${formatBuyins(currentGameRebuys)} קניות, מי אמר שכסף לא קונה אושר?`);
        messages.push(`${playerName} עם ${formatBuyins(currentGameRebuys)} קניות, ${spentTonight} שקל על השולחן`);
        messages.push(`${formatBuyins(currentGameRebuys)} קניות של ${playerName}, הערב מתחמם`);
        messages.push(`${playerName} כבר ${spentTonight} שקל הערב, ועדיין ${g('ממשיך', 'ממשיכה')}`);
        if (stats.gamesPlayed >= 5) {
          messages.push(`${playerName} עם ${hebrewNum(stats.gamesPlayed, false)} משחקים ניסיון, ועדיין ${formatBuyins(currentGameRebuys)} קניות הערב`);
        }
      }

      // --- Player-specific trait messages (limited to 2 random picks to keep data-driven ratio high) ---
      const traitPool = generateTraitMessages(playerName);
      if (traitPool.length > 0) {
        const shuffled = traitPool.sort(() => Math.random() - 0.5);
        messages.push(...shuffled.slice(0, 2));
      }

      // --- Always-applicable mixed-stat messages (broad pool for any player with history) ---
      const spent = currentGameRebuys * settings.rebuyValue;
      const wc = stats.winCount;
      const lc = stats.gamesPlayed - stats.winCount;
      messages.push(`${playerName} עם ${wc} נצחונות ו${lc} הפסדים, הערב עוד משחק למאזן`);
      messages.push(`${playerName}, ${gp} משחקים, ${wc} נצחונות, הערב צריך עוד אחד לרשימה`);
      messages.push(`${playerName} שם ${spent} שקל הערב, נראה אם ההשקעה תחזיר את עצמה`);
      messages.push(`עוד קנייה של ${playerName}, כבר ${formatBuyins(currentGameRebuys)} הערב`);
      messages.push(`${playerName} ${g('ממשיך', 'ממשיכה')} להאמין, ${formatBuyins(currentGameRebuys)} קניות ולא ${g('עוצר', 'עוצרת')}`);
      messages.push(`${playerName} ${g('ניצח', 'ניצחה')} ב${wc} מתוך ${gp} משחקים, הערב מוסיף עוד קנייה`);
      if (stats.biggestWin > 50) {
        messages.push(`${playerName} ${g('יודע', 'יודעת')} מה זה לנצח, פעם ${g('לקח', 'לקחה')} ${Math.round(stats.biggestWin)} שקל, מחכה לרגע כזה`);
        messages.push(`שיא רווח של ${Math.round(stats.biggestWin)} שקל, ${playerName} עדיין ${g('מחפש', 'מחפשת')} את הרגע`);
      }
      if (stats.avgProfit !== 0) {
        const dir = stats.avgProfit > 0 ? 'פלוס' : 'מינוס';
        messages.push(`${playerName} בממוצע ${dir} ${Math.round(Math.abs(stats.avgProfit))} שקל למשחק, נראה מה הערב יעשה`);
      }
      if (wp >= 40 && wp <= 60) {
        messages.push(`${playerName} ${g('מנצח', 'מנצחת')} ב${wp} אחוז, שחקן ממוצע שקונה מעל הממוצע`);
        messages.push(`${wp} אחוז נצחונות, ${playerName} הערב צריך לשפר את המספר`);
      }

      return pickUniqueHardcoded(messages);
    } catch {
      return null;
    }
  };

  const getTiedForLeadMessage = (playerName: string, leaderNames: string[], totalBuyins: number): string => {
    const fem = isPlayerFemale(playerName);
    const g = (m: string, f: string) => fem ? f : m;
    const otherLeader = leaderNames.find(n => n !== playerName) || leaderNames[0];
    const cw = formatBuyins(totalBuyins, true);
    const sw = formatBuyins(totalBuyins);
    const messages = [
      `תיקו! ${playerName} ו${otherLeader} שניהם עם ${cw} קניות`,
      `${playerName} ו${otherLeader} ראש בראש, ${cw} קניות כל אחד, מי ישבור ראשון?`,
      `יש לנו תיקו, ${cw} קניות בראש הטבלה!`,
      `${playerName} לא ${g('נותן', 'נותנת')} לאף אחד לברוח, שניהם עם ${sw}`,
      `מרוץ הקניות מתחמם! ${playerName} השווה את ${otherLeader}, שניהם ${sw}`,
    ];
    return pickUniqueHardcoded(messages);
  };

  const getPersonalRecordMessage = (playerName: string, previousRecord: number, currentCount: number, groupRecord?: number): string => {
    const fem = isPlayerFemale(playerName);
    const g = (m: string, f: string) => fem ? f : m;
    const cw = formatBuyins(currentCount, true);
    const prevWord = formatBuyins(previousRecord);
    const distToGroup = groupRecord && groupRecord > currentCount ? groupRecord - currentCount : 0;
    const groupContext = distToGroup > 0
      ? `. השיא הקבוצתי ${formatBuyins(groupRecord!)}, עוד ${formatBuyins(distToGroup)}`
      : '';
    const messages = [
      `שיא אישי חדש של ${playerName}! ${cw} קניות. הקודם היה ${prevWord}${groupContext}`,
      `${playerName} ${g('שובר', 'שוברת')} שיא אישי עם ${cw} קניות! הקודם היה ${prevWord}${groupContext}`,
      `${playerName} מתעלה על ${g('עצמו', 'עצמה')}. ${cw} קניות. הקודם היה רק ${prevWord}${groupContext}`,
    ];
    return pickUniqueHardcoded(messages);
  };

  const getGroupRecordMessage = (playerName: string, previousRecord: number, currentCount: number, previousHolder?: string): string => {
    const fem = isPlayerFemale(playerName);
    const g = (m: string, f: string) => fem ? f : m;
    const cw = formatBuyins(currentCount, true);
    const prevWord = formatBuyins(previousRecord);
    const holderPart = previousHolder && previousHolder !== playerName ? ` של ${previousHolder}` : '';
    const messages = [
      `שיא קבוצתי חדש! ${playerName} עם ${cw} קניות. ${g('שובר', 'שוברת')} את השיא${holderPart}. הקודם היה ${prevWord}`,
      `${playerName} ${g('שובר', 'שוברת')} שיא קבוצתי עם ${cw} קניות!${holderPart ? ` ${g('הדיח', 'הדיחה')} את ${previousHolder}` : ' אף אחד מעולם לא קנה כל כך הרבה'}`,
      `היסטוריה נכתבת! ${playerName} עם שיא קבוצתי חדש. ${cw} קניות. הקודם היה ${prevWord}${holderPart}`,
    ];
    return pickUniqueHardcoded(messages);
  };

  const getExtendingRecordMessage = (playerName: string, isGroupRecord: boolean, currentCount: number): string => {
    const fem = isPlayerFemale(playerName);
    const g = (m: string, f: string) => fem ? f : m;
    const cw = formatBuyins(currentCount, true);
    const sw = formatBuyins(currentCount);
    if (isGroupRecord) {
      const messages = [
        `${playerName} ${g('ממשיך', 'ממשיכה')} להרחיק את השיא הקבוצתי! כבר ${cw} קניות`,
        `השיא עולה, כבר ${sw}! ${playerName} לא ${g('עוצר', 'עוצרת')}`,
        `${playerName} בעולם ${g('משלו', 'משלה')}. השיא כבר ${sw}`,
      ];
      return pickUniqueHardcoded(messages);
    }
    const messages = [
      `${playerName} ${g('ממשיך', 'ממשיכה')} לשבור את השיא האישי. כבר ${cw} קניות!`,
      `השיא האישי עולה, כבר ${sw}! ${playerName} לא ${g('מוותר', 'מוותרת')}`,
      `${playerName} ${g('מגדיל', 'מגדילה')} את השיא האישי. כבר ${sw}. מה הגבול?`,
    ];
    return pickUniqueHardcoded(messages);
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
    groupRecordHolder: string;
    isExtendingPersonalRecord: boolean;
    isExtendingGroupRecord: boolean;
    allPlayers: GamePlayer[];
    totalGroupRebuys: number;
    previousTotalGroupRebuys: number;
    lastManStanding: string | null;
  };

  const speakBuyin = async (playerName: string, playerId: string, totalBuyins: number, isQuickRebuy: boolean, isHalfBuyin: boolean, ctx: RebuyContext) => {
    // Wait for any previous TTS to finish before starting
    await ttsQueueRef.current;

    // Check if total has half (0.5) - use tolerance for floating point
    const hasHalf = Math.abs((totalBuyins % 1) - 0.5) < 0.01;
    const whole = Math.floor(totalBuyins);

    // Format total in Hebrew words (feminine for קניות)
    let totalText: string;
    if (hasHalf) {
      totalText = whole === 0 ? 'חצי' : `${hebrewNum(whole, true)} וחצי`;
    } else {
      totalText = whole <= 10 ? hebrewNum(whole, true) : numberToHebrewTTS(whole, true);
    }

    const buyAction = isHalfBuyin ? 'עוד חצי' : 'עוד אחד';

    // 16-step priority cascade for extra message
    // Tries AI pool first for each category, falls back to hardcoded
    let extraMessage: string | null = null;
    const ceilBuyins = Math.ceil(totalBuyins);
    const rebuyThresholdMet = totalBuyins >= 5;
    const aiVars = { PLAYER: playerName, COUNT: totalBuyins, RECORD: ctx.previousGroupRecord || ctx.previousPersonalRecord, RANK: 0 };
    const hasAIPool = !!ttsPoolRef.current;

    // Compute rank for AI vars
    if (ctx.allPlayers.length > 0) {
      const sorted = [...ctx.allPlayers].sort((a, b) => b.rebuys - a.rebuys);
      const rank = sorted.findIndex(p => p.playerName === playerName) + 1;
      aiVars.RANK = rank;
    }

    // Find rival from pool rivalries
    const rivalName = ttsPoolRef.current?.rivalries?.find(
      r => r.player1 === playerName || r.player2 === playerName
    );
    const rivalPlayerName = rivalName ? (rivalName.player1 === playerName ? rivalName.player2 : rivalName.player1) : undefined;

    // Check anticipated conditions
    const records = getRebuyRecords();
    const historicalBest = records.playerMax.get(playerId) || 0;
    const playerStats2026 = getPlayerStats({ start: new Date('2026-01-01') }).find(s => s.playerId === playerId);
    const avgRebuys = playerStats2026?.avgRebuysPerGame || 0;
    const isAboveAvg = avgRebuys > 0 && totalBuyins > avgRebuys * 1.3 && totalBuyins >= 3;
    const isRecordTied = historicalBest > 0 && ceilBuyins === historicalBest && rebuyThresholdMet
      && !personalRecordAnnouncedRef.current.has(playerId);
    const isRivalMatched = rivalPlayerName && ctx.allPlayers.some(
      p => p.playerName === rivalPlayerName && Math.abs(p.rebuys - totalBuyins) < 0.01 && totalBuyins >= 3
    );

    // --- Priority cascade ---
    // 1-2: Group record broken / extending
    if (!extraMessage && rebuyThresholdMet && ctx.isGroupRecord) {
      extraMessage = pickAnticipated(playerName, 'record_broken', { ...aiVars, RECORD: ctx.previousGroupRecord });
      if (!extraMessage) extraMessage = getGroupRecordMessage(playerName, ctx.previousGroupRecord, totalBuyins, ctx.groupRecordHolder);
    }
    if (!extraMessage && rebuyThresholdMet && ctx.isExtendingGroupRecord && ceilBuyins % 2 === 0) {
      extraMessage = pickAnticipated(playerName, 'record_broken', aiVars);
      if (!extraMessage) extraMessage = getExtendingRecordMessage(playerName, true, totalBuyins);
    }
    // 3-4: Personal record broken / extending
    if (!extraMessage && rebuyThresholdMet && ctx.isPersonalRecord) {
      extraMessage = pickAnticipated(playerName, 'record_broken', { ...aiVars, RECORD: ctx.previousPersonalRecord });
      if (!extraMessage) extraMessage = getPersonalRecordMessage(playerName, ctx.previousPersonalRecord, totalBuyins, ctx.previousGroupRecord);
    }
    if (!extraMessage && rebuyThresholdMet && ctx.isExtendingPersonalRecord && ceilBuyins % 2 === 0) {
      extraMessage = pickAnticipated(playerName, 'record_broken', aiVars);
      if (!extraMessage) extraMessage = getExtendingRecordMessage(playerName, false, totalBuyins);
    }
    // 5: New rebuy leader
    if (!extraMessage && rebuyThresholdMet && ctx.isNewRebuyLeader) {
      extraMessage = pickAnticipated(playerName, 'is_leader', aiVars);
      if (!extraMessage) {
        const leaderFem = isPlayerFemale(playerName);
        const leaderG = (m: string, f: string) => leaderFem ? f : m;
        const leaderMessages = [
          `ויש לנו ${leaderG('מוביל', 'מובילה')} חדש בקניות הערב! ${playerName} עם ${formatBuyins(totalBuyins, true)} קניות`,
          `${playerName} ${leaderG('תפס', 'תפסה')} את המקום הראשון בקניות. כבר ${formatBuyins(totalBuyins)}!`,
          `כל הכבוד ${playerName}. ${leaderG('מוביל', 'מובילה')} חדש עם ${formatBuyins(totalBuyins, true)} קניות`,
        ];
        extraMessage = pickUniqueHardcoded(leaderMessages);
      }
    }
    // 6: Tied for lead
    if (!extraMessage && rebuyThresholdMet && ctx.isTiedForLead) {
      extraMessage = pickAnticipated(playerName, 'tied_for_lead', aiVars);
      if (!extraMessage) extraMessage = getTiedForLeadMessage(playerName, ctx.tiedLeaderNames, totalBuyins);
    }
    // 7: Record tied (anticipated)
    if (!extraMessage && isRecordTied) {
      extraMessage = pickAnticipated(playerName, 'record_tied', { ...aiVars, RECORD: historicalBest });
    }
    // 8: Above average (anticipated)
    if (!extraMessage && isAboveAvg) {
      extraMessage = pickAnticipated(playerName, 'above_avg', aiVars);
    }
    // 9: Rival matched (anticipated)
    if (!extraMessage && isRivalMatched && rivalPlayerName) {
      extraMessage = pickAnticipated(playerName, 'rival_matched', { ...aiVars, RIVAL: rivalPlayerName });
    }
    // 10: Half buyin (hardcoded only)
    if (!extraMessage && isHalfBuyin) {
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
      extraMessage = pickUniqueHardcoded(halfMessages);
    }
    // 11: AI generic message for this player
    if (!extraMessage && hasAIPool && !isHalfBuyin) {
      extraMessage = pickGeneric(playerName, aiVars);
    }
    // 12-13: Hardcoded personal + buyin fallback
    if (!extraMessage && !isHalfBuyin) {
      const personal = getPersonalMessage(playerName, playerId, totalBuyins, isQuickRebuy, ctx.allPlayers);
      extraMessage = personal || getBuyinMessage(totalBuyins, isQuickRebuy);
    }
    // 14: Final safety fallback
    if (!extraMessage) {
      extraMessage = getBuyinMessage(totalBuyins, isQuickRebuy);
    }


    // Structural announcement — short phrases with periods for natural TTS pauses
    const structuralMsg = `${playerName}. ${buyAction}. סך הכל ${totalText}.`;

    // Build all TTS messages as separate items for sequential playback
    const allMessages: string[] = [];

    allMessages.push(structuralMsg);

    // AI extra message as a separate TTS call for cleaner pronunciation
    if (extraMessage) {
      allMessages.push(extraMessage);
    }

    // Rebuy milestone (initial buyins don't count — subtract player count)
    const playerCount = ctx.allPlayers.length;
    const totalRebuysOnly = ctx.totalGroupRebuys - playerCount;
    const prevRebuysOnly = ctx.previousTotalGroupRebuys - playerCount;
    const milestones = [5, 10, 15, 20, 25, 30, 35, 40, 50, 60, 75, 100];
    const crossedMilestone = milestones.find(m => prevRebuysOnly < m && totalRebuysOnly >= m);
    if (crossedMilestone) {
      const numWord = hebrewNumConstruct(crossedMilestone, true);
      const milestoneMessages = [
        `ובמבט על השולחן כולו, כבר ${numWord} קניות הערב!`,
        `רגע, כל השולחן ביחד? ${numWord} קניות!`,
        `עדכון כללי. על השולחן כולו כבר ${numWord} קניות הערב!`,
        `ועוד עדכון. כל השחקנים ביחד, ${numWord} קניות הערב!`,
        `מבט על התמונה הגדולה, השולחן הגיע ל${numWord} קניות הערב!`,
      ];
      allMessages.push(pickUniqueHardcoded(milestoneMessages));
    }

    // Last man standing
    if (ctx.lastManStanding) {
      const lastFem = isPlayerFemale(ctx.lastManStanding);
      const lastG = (m: string, f: string) => lastFem ? f : m;
      const lastManMessages = [
        `${ctx.lastManStanding} ${lastG('האחרון', 'האחרונה')} שעוד ${lastG('מחזיק', 'מחזיקה')} מהקנייה הראשונה!`,
        `רק ${ctx.lastManStanding} ${lastG('נשאר', 'נשארה')} בלי קנייה נוספת. כל השאר כבר קנו`,
        `${ctx.lastManStanding} עדיין על הראשונה. כל הכבוד`,
        `כולם כבר קנו חוץ מ${ctx.lastManStanding}. מי יחזיק יותר?`,
        `${ctx.lastManStanding} ${lastG('האחרון', 'האחרונה')} על הקנייה הראשונה. לחץ!`,
      ];
      allMessages.push(pickUniqueHardcoded(lastManMessages));
    }

    isSpeakingRef.current = true;
    lastTTSActivityRef.current = Date.now();
    try {
      await speakHebrew(allMessages, getGeminiApiKey(), {
        onBeforePlay: () => playRebuyCasinoSound(totalBuyins),
      });
    } finally {
      isSpeakingRef.current = false;
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
    const isNowTied = Math.abs(newRebuys - othersMax) < 0.01 && newRebuys > 1 && othersMax > 0;
    const isTiedForLead = wasBehind && isNowTied;
    const tiedLeaderNames = isTiedForLead
      ? updatedPlayers.filter(p => Math.abs(p.rebuys - newRebuys) < 0.01).map(p => p.playerName)
      : [];

    // Detect personal and group rebuy records (since 2026)
    // Use announced flags so "record broken" fires ONCE, subsequent rebuys become "extending"
    const ceilNewRebuys = Math.ceil(newRebuys);
    const records = getRebuyRecords();
    const historicalPersonalBest = records.playerMax.get(player.playerId) || 0;
    const historicalGroupBest = records.groupMax;
    const alreadyAnnouncedPersonal = personalRecordAnnouncedRef.current.has(player.playerId);
    const alreadyAnnouncedGroup = groupRecordAnnouncedRef.current;

    const exceedsPersonal = ceilNewRebuys > historicalPersonalBest && historicalPersonalBest > 0;
    const isPersonalRecord = exceedsPersonal && !alreadyAnnouncedPersonal;
    const isExtendingPersonalRecord = exceedsPersonal && alreadyAnnouncedPersonal;

    const exceedsGroup = ceilNewRebuys > historicalGroupBest && historicalGroupBest > 0;
    const isGroupRecord = exceedsGroup && !alreadyAnnouncedGroup;
    const isExtendingGroupRecord = exceedsGroup && alreadyAnnouncedGroup;

    if (isPersonalRecord) personalRecordAnnouncedRef.current.add(player.playerId);
    if (isGroupRecord) groupRecordAnnouncedRef.current = true;

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
      previousPersonalRecord: historicalPersonalBest,
      isGroupRecord,
      previousGroupRecord: historicalGroupBest,
      groupRecordHolder: records.groupMaxHolder,
      isExtendingPersonalRecord,
      isExtendingGroupRecord,
      allPlayers: updatedPlayers,
      totalGroupRebuys: updatedPlayers.reduce((sum, p) => sum + p.rebuys, 0),
      previousTotalGroupRebuys: updatedPlayers.reduce((sum, p) => sum + p.rebuys, 0) - amount,
      lastManStanding,
    };

    // Announce in Hebrew with creative message — queued to prevent concurrent TTS calls
    const isHalfBuyin = amount === 0.5;
    const ttsPromise = speakBuyin(player.playerName, player.playerId, newRebuys, isQuickRebuy, isHalfBuyin, ctx);
    ttsQueueRef.current = ttsPromise.catch(() => {});
  };

  // Voice notification for undo
  const speakUndo = (playerName: string, undoAmount: number, newTotal: number) => {
    const hasHalf = Math.abs((newTotal % 1) - 0.5) < 0.01;
    const whole = Math.floor(newTotal);
    let totalText: string;
    if (hasHalf) {
      totalText = whole === 0 ? 'חצי' : `${hebrewNum(whole, true)} וחצי`;
    } else {
      totalText = whole <= 10 ? hebrewNum(whole, true) : numberToHebrewTTS(whole, true);
    }

    const undoText = undoAmount === 0.5 ? 'חצי' : 'אחד';
    const message = `ביטול. ${playerName} מינוס ${undoText}. סך הכל ${totalText}.`;

    speakHebrew([message], getGeminiApiKey());
  };

  const handleSocialMoment = (type: 'bad_beat' | 'big_hand', playerName: string) => {
    setSocialAction(null);
    const pool = ttsPoolRef.current;

    let msg: string | null = null;
    if (pool) {
      const shared = type === 'bad_beat' ? pool.shared.bad_beat : pool.shared.big_hand;
      const generic = type === 'bad_beat' ? pool.shared.bad_beat_generic : pool.shared.big_hand_generic;
      const categoryKey = `shared.${type}`;
      msg = pickFromPool(shared[playerName], `${categoryKey}.${playerName}`, { PLAYER: playerName });
      if (!msg) msg = pickFromPool(generic, `${categoryKey}_generic`, {});
    }
    if (!msg) {
      msg = type === 'bad_beat'
        ? `אאוטש. רגע כואב ל${playerName} על השולחן`
        : `יד ענקית של ${playerName}! רגע גדול`;
    }

    const soundTotalBuyins = type === 'bad_beat' ? 8 : 2;
    speakHebrew([msg!], getGeminiApiKey(), {
      onBeforePlay: () => playRebuyCasinoSound(soundTotalBuyins),
    });
  };

  const handleBreakTime = () => {
    const messages: string[] = [];

    // Build a live situation summary from current game data
    const totalReb = players.reduce((s, p) => s + p.rebuys, 0);
    const pot = totalReb * rebuyValue;
    const sorted = [...players].sort((a, b) => b.rebuys - a.rebuys);
    const leader = sorted[0];
    const survivor = [...players].sort((a, b) => a.rebuys - b.rebuys)[0];

    // Situation report line
    const potWord = pot >= 1000 ? `${(pot / 1000).toFixed(1).replace('.0', '')} אלף` : String(pot);
    messages.push(`הפסקה. ${formatBuyins(totalReb, true)} קניות עד עכשיו. ${potWord} שקל על השולחן.`);

    // Who leads / who survived
    if (leader && leader.rebuys > 1) {
      const leadFem = isPlayerFemale(leader.playerName);
      messages.push(`${leader.playerName} ${leadFem ? 'מובילה' : 'מוביל'} עם ${formatBuyins(leader.rebuys, true)} קניות.`);
    }
    if (survivor && survivor.rebuys <= 1 && players.length >= 4) {
      messages.push(`${survivor.playerName} עדיין על הקנייה הראשונה.`);
    }

    // Add an AI flavor line if available
    const pool = ttsPoolRef.current;
    if (pool) {
      const aiMsg = pickFromPool(pool.shared.break_time, 'shared.break_time', {});
      if (aiMsg) messages.push(aiMsg);
    }

    speakHebrew(messages, getGeminiApiKey());
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

  const navigateToChipEntry = () => {
    if (gameId) {
      updateGameStatus(gameId, 'chip_entry');
      navigate(`/chip-entry/${gameId}`);
    }
  };

  const handleEndGame = () => {
    if (!gameId) return;
    navigateToChipEntry();
  };

  const totalPot = players.reduce((sum, p) => sum + p.rebuys * rebuyValue, 0);
  const totalRebuys = players.reduce((sum, p) => sum + p.rebuys, 0);

  return (
    <div className="fade-in">
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h1 className="page-title" style={{ margin: 0 }}>{t('live.title')}</h1>
          {isAdmin && (
            <div style={{ display: 'flex', gap: '0.3rem', flexShrink: 0 }}>
              <button
                className="btn btn-sm"
                style={{ background: 'var(--danger, #dc3545)', color: '#fff', fontSize: '0.85rem', padding: '0.3rem 0.5rem', lineHeight: 1 }}
                onClick={() => setSocialAction('bad_beat')}
              >
                💀
              </button>
              <button
                className="btn btn-sm"
                style={{ background: 'var(--success, #28a745)', color: '#fff', fontSize: '0.85rem', padding: '0.3rem 0.5rem', lineHeight: 1 }}
                onClick={() => setSocialAction('big_hand')}
              >
                🔥
              </button>
              <button
                className="btn btn-sm"
                style={{ background: 'var(--surface-light, #555)', color: '#fff', fontSize: '0.85rem', padding: '0.3rem 0.5rem', lineHeight: 1 }}
                onClick={handleBreakTime}
              >
                ☕
              </button>
            </div>
          )}
        </div>
        <p className="page-subtitle" style={{ margin: 0 }}>
          {t('live.subtitle')}
          {ttsModelName && (
            <span style={{ marginLeft: '0.5rem', fontSize: '0.6rem', background: 'rgba(99, 102, 241, 0.15)', color: '#818cf8', padding: '0.1rem 0.35rem', borderRadius: '4px', fontWeight: 500 }}>
              🤖 {ttsModelName}
            </span>
          )}
        </p>
      </div>

      <div className="summary-card" style={{ display: 'flex', justifyContent: 'space-around', textAlign: 'center' }}>
        <div>
          <div className="summary-title">{t('live.totalPot')}</div>
          <div className="summary-value">{cleanNumber(totalPot)}</div>
        </div>
        <div>
          <div className="summary-title">{t('live.totalBuyins')}</div>
          <div className="summary-value">{totalRebuys % 1 !== 0 ? totalRebuys.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : cleanNumber(totalRebuys)}</div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h2 className="card-title">{t('live.playersSection')}</h2>
          <span className="text-muted">{players.length} {t('live.playing')}</span>
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
                title={t('live.removePlayer')}
              >
                ✕
              </button>
            )}
            <div>
              <div className="player-name">{player.playerName}</div>
              <div className="text-muted" style={{ fontSize: '0.875rem' }}>
                {cleanNumber(player.rebuys * rebuyValue)} {t('live.invested')}
              </div>
            </div>
            <div className="player-rebuys">
              <span key={player.rebuys} className="rebuy-count" style={{ animation: 'popIn 0.2s ease-out' }}>{Math.abs((player.rebuys % 1) - 0.5) < 0.01 ? player.rebuys.toFixed(1) : player.rebuys}</span>
              {isAdmin && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  <button 
                    className="btn btn-primary btn-sm"
                    onClick={() => handleRebuy(player, 1)}
                  >
                    {t('live.buyin')}
                  </button>
                  <button 
                    className="btn btn-secondary btn-sm"
                    onClick={() => handleRebuy(player, 0.5)}
                    style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
                  >
                    {t('live.halfBuyin')}
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {actions.length > 0 && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">{t('live.recentActions')}</h2>
            {isAdmin && (
              <button className="btn btn-sm btn-secondary" onClick={handleUndo}>
                {t('live.undo')}
              </button>
            )}
          </div>
          <div className="list">
            {actions.slice(0, 5).map((action, index) => (
              <div key={index} className="list-item">
                <span>
                  {action.playerName} {action.amount === 0.5 ? t('live.halfBuyinAction') : t('live.fullBuyin')}
                </span>
                <span className="text-muted">
                  {new Date(action.timestamp).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Shared Expenses Section - Compact */}
      <div className="card" style={{ padding: '0.6rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
          <span style={{ fontSize: '0.9rem', fontWeight: '600' }}>{t('live.expenses')}</span>
          {isAdmin && (
            <button 
              className="btn btn-sm btn-primary"
              onClick={() => setShowExpenseModal(true)}
              style={{ padding: '0.2rem 0.5rem', fontSize: '0.7rem' }}
            >
              {t('live.addExpense')}
            </button>
          )}
        </div>
        
        {sharedExpenses.length === 0 ? (
          <div className="text-muted" style={{ textAlign: 'center', padding: '0.5rem', fontSize: '0.75rem' }}>
            {t('live.noExpenses')}
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
                        {cleanNumber(expense.amount)}
                      </span>
                      <span className="text-muted" style={{ marginLeft: '0.3rem', fontSize: '0.65rem' }}>
                        ({cleanNumber(perPerson)}{t('live.perPerson')})
                      </span>
                    </div>
                    {isAdmin && (
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
                    )}
                  </div>
                  <div className="text-muted" style={{ fontSize: '0.65rem', marginTop: '0.2rem' }}>
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
              {t('live.expenseTotal')} <span style={{ fontWeight: '600' }}>{cleanNumber(sharedExpenses.reduce((sum, e) => sum + e.amount, 0))}</span>
            </div>
          </>
        )}
      </div>

      {/* Player picker for social moments */}
      {socialAction && (
        <div
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center',
            justifyContent: 'center', zIndex: 1000,
          }}
          onClick={() => setSocialAction(null)}
        >
          <div
            className="card"
            style={{ maxWidth: '350px', margin: '1rem', padding: '1.5rem', textAlign: 'center' }}
            onClick={e => e.stopPropagation()}
          >
            <h3 style={{ marginBottom: '1rem' }}>
              {socialAction === 'bad_beat' ? t('live.badHand') : t('live.bigHand')}
            </h3>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', justifyContent: 'center' }}>
              {players.map(p => (
                <button
                  key={p.id}
                  className="btn btn-sm btn-secondary"
                  style={{ fontSize: '0.85rem', padding: '0.4rem 0.8rem' }}
                  onClick={() => handleSocialMoment(socialAction, p.playerName)}
                >
                  {p.playerName}
                </button>
              ))}
            </div>
            <button
              className="btn btn-sm"
              style={{ marginTop: '1rem', color: 'var(--text-muted, #aaa)' }}
              onClick={() => setSocialAction(null)}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {isAdmin && (
        <button 
          className="btn btn-primary btn-lg btn-block mt-3"
          onClick={handleEndGame}
        >
          {t('live.endGame')}
        </button>
      )}

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
            <h3 style={{ marginBottom: '0.5rem' }}>{t('live.removeTitle')}</h3>
            <p className="text-muted" style={{ marginBottom: '1.5rem' }}>
              {t('live.removeConfirm', { name: playerToRemove.playerName })}
              <br />
              <span style={{ fontSize: '0.875rem' }}>{t('live.removeNote')}</span>
            </p>
            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
              <button 
                className="btn btn-secondary"
                onClick={() => setPlayerToRemove(null)}
              >
                {t('common.cancel')}
              </button>
              <button 
                className="btn btn-danger"
                onClick={confirmRemovePlayer}
                style={{ background: '#dc3545', borderColor: '#dc3545' }}
              >
                {t('live.removeTitle')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TTS Debug Overlay — centered, grows with content, auto-hides after 15s */}
      {showTtsDebug && ttsLog.length > 0 && (
        <div
          onClick={() => setShowTtsDebug(false)}
          style={{
            position: 'fixed',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.5)',
            zIndex: 9999,
          }}
        >
          <div
            style={{
              background: 'rgba(15,23,42,0.95)',
              borderRadius: 12,
              padding: '12px 16px',
              margin: '0 16px',
              minWidth: 280,
              maxWidth: 420,
              border: '1px solid rgba(148,163,184,0.2)',
              fontSize: '0.75rem',
              fontFamily: 'monospace',
              direction: 'ltr',
              textAlign: 'left',
            }}
          >
            <div style={{ color: '#94a3b8', marginBottom: 6, fontWeight: 600, fontSize: '0.8rem' }}>🔊 TTS Debug</div>
            {ttsLog.map((e, i) => {
              const color = e.type === 'success' ? '#4ade80'
                : (e.type === 'warn' || e.type === 'error') ? '#f87171'
                : '#e2e8f0';
              const timeStr = new Date(e.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
              return (
                <div key={i} style={{ color, lineHeight: 1.5 }}>
                  <span style={{ color: '#64748b' }}>{timeStr}</span> {e.text}
                </div>
              );
            })}
            <div style={{ color: '#475569', marginTop: 8, fontSize: '0.65rem', textAlign: 'center' }}>tap to dismiss</div>
          </div>
        </div>
      )}
    </div>
  );
};

export default LiveGameScreen;

