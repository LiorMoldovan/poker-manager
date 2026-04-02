import { useState, useEffect, useCallback } from 'react';
import {
  TrainingPool,
  TrainingAnswersFile,
  TrainingInsightsFile,
  TrainingPlayerData,
  TrainingExploitationLocal,
  PoolScenario,
} from '../types';
import {
  fetchTrainingPool,
  fetchTrainingAnswers,
  fetchTrainingInsights,
  uploadTrainingPool,
  uploadTrainingInsights,
  removeFromTrainingPool,
} from '../database/githubSync';
import {
  SCENARIO_CATEGORIES,
  generatePoolBatch,
  CategoryInfo,
} from '../utils/pokerTraining';
import { getGeminiApiKey, API_CONFIGS } from '../utils/geminiAI';

const RATE_LIMIT_DELAY = 7500;

const TrainingAdminTab = () => {
  const [pool, setPool] = useState<TrainingPool | null>(null);
  const [answers, setAnswers] = useState<TrainingAnswersFile | null>(null);
  const [insights, setInsights] = useState<TrainingInsightsFile | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);

  // Pool generation
  const [generating, setGenerating] = useState(false);
  const [genProgress, setGenProgress] = useState({ current: 0, total: 0, category: '' });
  const [genMessage, setGenMessage] = useState<string | null>(null);
  const [genLog, setGenLog] = useState<{ cat: string; icon: string; status: string; count: number }[]>([]);

  // Expanded player
  const [expandedPlayer, setExpandedPlayer] = useState<string | null>(null);

  // Flagged removal
  const [removingFlagged, setRemovingFlagged] = useState(false);
  const [flagMsg, setFlagMsg] = useState<string | null>(null);

  // AI insight generation
  const [generatingInsight, setGeneratingInsight] = useState<string | null>(null);
  const [insightMsg, setInsightMsg] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [p, a, i] = await Promise.all([
        fetchTrainingPool(),
        fetchTrainingAnswers(),
        fetchTrainingInsights(),
      ]);
      setPool(p);
      setAnswers(a);
      setInsights(i);
      setLastRefresh(new Date().toLocaleTimeString('he-IL'));
    } catch (err) {
      console.error('Failed to load training data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // ── Alerts ──
  const getAlerts = (): { text: string; color: string }[] => {
    const alerts: { text: string; color: string }[] = [];

    if (!pool || pool.totalScenarios === 0) {
      alerts.push({ text: 'אין מאגר שאלות - צור מאגר חדש', color: '#ef4444' });
    }

    if (answers) {
      // Check depleted categories
      const maxSeen = new Map<string, number>();
      answers.players.forEach(player => {
        const seen = new Set(player.sessions.flatMap(s => s.results.map(r => r.poolId)));
        if (pool) {
          SCENARIO_CATEGORIES.forEach(cat => {
            const catPool = pool.scenarios.filter(s => s.categoryId === cat.id);
            const catUnseen = catPool.filter(s => !seen.has(s.poolId)).length;
            const current = maxSeen.get(cat.id) ?? Infinity;
            maxSeen.set(cat.id, Math.min(current, catUnseen));
          });
        }
      });
      const lowCats = [...maxSeen.entries()].filter(([, v]) => v < 5).length;
      if (lowCats > 0) {
        alerts.push({ text: `${lowCats} קטגוריות עם פחות מ-5 שאלות לשחקן הפעיל ביותר`, color: '#f59e0b' });
      }

      // Flagged questions (only count those still in pool)
      if (pool) {
        const poolIdSet = new Set(pool.scenarios.map(s => s.poolId));
        const flagCounts = new Map<string, number>();
        answers.players.forEach(p => {
          p.sessions.forEach(s => {
            (s.flaggedPoolIds || []).forEach(id => {
              if (poolIdSet.has(id)) {
                flagCounts.set(id, (flagCounts.get(id) || 0) + 1);
              }
            });
          });
        });
        if (flagCounts.size > 0) {
          alerts.push({ text: `${flagCounts.size} שאלות מדווחות לבדיקה`, color: '#f59e0b' });
        }
      }
    }

    return alerts;
  };

  // ── Build pool object from scenarios ──
  const buildPoolObject = (scenarios: PoolScenario[]): TrainingPool => {
    const byCategory: Record<string, number> = {};
    scenarios.forEach(s => {
      byCategory[s.categoryId] = (byCategory[s.categoryId] || 0) + 1;
    });
    return {
      generatedAt: new Date().toISOString(),
      totalScenarios: scenarios.length,
      byCategory,
      scenarios,
    };
  };

  const POOL_DRAFT_KEY = 'training_pool_draft';

  const savePoolDraft = (scenarios: PoolScenario[]) => {
    try { localStorage.setItem(POOL_DRAFT_KEY, JSON.stringify(scenarios)); } catch { /* full */ }
  };

  const loadPoolDraft = (): PoolScenario[] | null => {
    try {
      const raw = localStorage.getItem(POOL_DRAFT_KEY);
      if (!raw) return null;
      const arr = JSON.parse(raw);
      return Array.isArray(arr) && arr.length > 0 ? arr : null;
    } catch { return null; }
  };

  const clearPoolDraft = () => localStorage.removeItem(POOL_DRAFT_KEY);

  const MIN_PER_CATEGORY = 20;

  // ── Generate full pool (with auto-resume) ──
  const handleGeneratePool = async () => {
    const apiKey = getGeminiApiKey();
    if (!apiKey) {
      setGenMessage('חסר מפתח Gemini API');
      return;
    }

    setGenerating(true);
    setGenMessage(null);
    setGenLog([]);

    const draft = loadPoolDraft();
    const allScenarios: PoolScenario[] = draft || pool?.scenarios || [];

    const existingPerCat: Record<string, number> = {};
    allScenarios.forEach(s => {
      existingPerCat[s.categoryId] = (existingPerCat[s.categoryId] || 0) + 1;
    });

    const catsToGenerate = SCENARIO_CATEGORIES.filter(
      cat => (existingPerCat[cat.id] || 0) < MIN_PER_CATEGORY
    );

    if (catsToGenerate.length === 0) {
      setGenerating(false);
      const newPool = buildPoolObject(allScenarios);
      const result = await uploadTrainingPool(newPool);
      clearPoolDraft();
      if (result.success) setPool(newPool);
      setGenMessage(`כל הקטגוריות מלאות! סה"כ: ${allScenarios.length} שאלות`);
      return;
    }

    const skipped = SCENARIO_CATEGORIES.length - catsToGenerate.length;
    const log: { cat: string; icon: string; status: string; count: number }[] = [];

    if (skipped > 0) {
      SCENARIO_CATEGORIES.filter(c => (existingPerCat[c.id] || 0) >= MIN_PER_CATEGORY).forEach(c => {
        log.push({ cat: c.name, icon: c.icon, status: 'skip', count: existingPerCat[c.id] || 0 });
      });
      setGenLog([...log]);
    }

    const total = catsToGenerate.length;
    let totalGenerated = 0;
    let totalFailed = 0;
    let lastUploadedCount = allScenarios.length;
    const startTime = Date.now();

    for (let i = 0; i < total; i++) {
      const cat = catsToGenerate[i];
      const existing = existingPerCat[cat.id] || 0;
      const needed = 30 - existing;
      setGenProgress({ current: i + 1, total, category: cat.name });

      let batchCount = 0;
      let catStatus = 'fail';

      try {
        const batch = await generatePoolBatch(cat, needed, allScenarios, apiKey);
        if (batch.length > 0) {
          allScenarios.push(...batch);
          batchCount = batch.length;
          totalGenerated += batch.length;
          catStatus = batch.length >= needed ? 'ok' : 'partial';
        } else {
          totalFailed++;
        }
      } catch (err) {
        console.error(`Pool gen failed for ${cat.id}:`, err);
        totalFailed++;
        catStatus = err instanceof Error && err.message === 'INVALID_API_KEY' ? 'key_error' : 'fail';
        if (catStatus === 'key_error') {
          log.push({ cat: cat.name, icon: cat.icon, status: catStatus, count: 0 });
          setGenLog([...log]);
          setGenMessage('מפתח API לא תקין — עצירה');
          break;
        }
      }

      log.push({ cat: cat.name, icon: cat.icon, status: catStatus, count: batchCount });
      setGenLog([...log]);
      savePoolDraft(allScenarios);

      // Upload after every successful category
      if (allScenarios.length > lastUploadedCount) {
        const uploadResult = await uploadTrainingPool(buildPoolObject(allScenarios)).catch(() => ({ success: false }));
        if (uploadResult.success) {
          lastUploadedCount = allScenarios.length;
        }
      }

      // Time estimate based on actual measured pace
      const elapsed = Date.now() - startTime;
      const avgPerCat = elapsed / (i + 1);
      const remaining = total - (i + 1);
      const etaMin = Math.ceil((remaining * avgPerCat) / 60000);
      setGenMessage(`${totalGenerated} שאלות נוצרו${totalFailed > 0 ? ` · ${totalFailed} נכשלו` : ''} · ~${etaMin} דק׳ נותרו`);

      if (i < total - 1) {
        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY));
      }
    }

    // Final upload
    const newPool = buildPoolObject(allScenarios);
    const result = await uploadTrainingPool(newPool);
    setGenerating(false);
    clearPoolDraft();

    const elapsedMin = Math.round((Date.now() - startTime) / 60000);

    if (result.success) {
      setPool(newPool);
      setGenMessage(
        `סיום! ${totalGenerated} שאלות חדשות` +
        (totalFailed > 0 ? ` · ${totalFailed} קטגוריות נכשלו` : '') +
        ` · סה"כ ${allScenarios.length} שאלות · ${elapsedMin} דקות`
      );
    } else {
      setGenMessage(`שגיאה בהעלאה סופית: ${result.message} — אך ${lastUploadedCount} שאלות כבר נשמרו בענן`);
    }
  };

  // ── Smart expand ──
  const handleExpandPool = async () => {
    const apiKey = getGeminiApiKey();
    if (!apiKey || !pool || !answers) return;

    const seenByPlayer = new Map<string, Set<string>>();
    answers.players.forEach(p => {
      seenByPlayer.set(p.playerName, new Set(p.sessions.flatMap(s => s.results.map(r => r.poolId))));
    });

    const depletedCats: CategoryInfo[] = [];
    SCENARIO_CATEGORIES.forEach(cat => {
      const catPool = pool.scenarios.filter(s => s.categoryId === cat.id);
      const anyLow = [...seenByPlayer.values()].some(seen => {
        const unseen = catPool.filter(s => !seen.has(s.poolId)).length;
        return unseen < 5;
      });
      if (anyLow) depletedCats.push(cat);
    });

    if (depletedCats.length === 0) {
      setGenMessage('אין קטגוריות שצריכות הרחבה');
      return;
    }

    setGenerating(true);
    setGenMessage(null);
    setGenLog([]);
    const allScenarios = [...pool.scenarios];
    const log: { cat: string; icon: string; status: string; count: number }[] = [];
    let totalAdded = 0;
    let totalFailed = 0;
    let lastUploadedCount = allScenarios.length;
    const startTime = Date.now();

    for (let i = 0; i < depletedCats.length; i++) {
      const cat = depletedCats[i];
      setGenProgress({ current: i + 1, total: depletedCats.length, category: cat.name });

      let batchCount = 0;
      let catStatus = 'fail';

      try {
        const batch = await generatePoolBatch(cat, 15, allScenarios, apiKey);
        if (batch.length > 0) {
          allScenarios.push(...batch);
          batchCount = batch.length;
          totalAdded += batch.length;
          catStatus = batch.length >= 10 ? 'ok' : 'partial';
        } else {
          totalFailed++;
        }
      } catch (err) {
        console.error(`Expand failed for ${cat.id}:`, err);
        totalFailed++;
      }

      log.push({ cat: cat.name, icon: cat.icon, status: catStatus, count: batchCount });
      setGenLog([...log]);
      savePoolDraft(allScenarios);

      if (allScenarios.length > lastUploadedCount) {
        const uploadResult = await uploadTrainingPool(buildPoolObject(allScenarios)).catch(() => ({ success: false }));
        if (uploadResult.success) {
          lastUploadedCount = allScenarios.length;
        }
      }

      const elapsed = Date.now() - startTime;
      const avgPerCat = elapsed / (i + 1);
      const remaining = depletedCats.length - (i + 1);
      const etaMin = Math.ceil((remaining * avgPerCat) / 60000);
      setGenMessage(`${totalAdded} שאלות חדשות${totalFailed > 0 ? ` · ${totalFailed} נכשלו` : ''} · ~${etaMin} דק׳ נותרו`);

      if (i < depletedCats.length - 1) {
        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY));
      }
    }

    const newPool = buildPoolObject(allScenarios);
    const result = await uploadTrainingPool(newPool);
    setGenerating(false);
    clearPoolDraft();

    const elapsedMin = Math.round((Date.now() - startTime) / 60000);

    if (result.success) {
      setPool(newPool);
      setGenMessage(
        `הרחבה הסתיימה! ${totalAdded} שאלות חדשות` +
        (totalFailed > 0 ? ` · ${totalFailed} נכשלו` : '') +
        ` · סה"כ ${allScenarios.length} · ${elapsedMin} דקות`
      );
    } else {
      setGenMessage(`שגיאה בהעלאה סופית: ${result.message} — ${lastUploadedCount} שאלות נשמרו`);
    }
  };

  // ── Remove flagged ──
  const handleRemoveFlagged = async (poolIds: string[]) => {
    if (removingFlagged) return;
    setRemovingFlagged(true);
    setFlagMsg(`מסיר ${poolIds.length} שאלות...`);
    try {
      const result = await removeFromTrainingPool(poolIds);
      if (result.success) {
        // Use localStorage cache (already updated by removeFromTrainingPool)
        // instead of re-fetching from GitHub which may return stale data
        const cached = localStorage.getItem('training_pool_cached');
        if (cached) {
          try { setPool(JSON.parse(cached) as TrainingPool); } catch { /* fall through */ }
        }
        setFlagMsg(`✅ הוסרו ${poolIds.length} שאלות`);
      } else {
        setFlagMsg(`❌ שגיאה: ${result.message}`);
      }
    } catch (err) {
      setFlagMsg(`❌ שגיאה: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setRemovingFlagged(false);
    }
  };

  // ── Generate AI insights ──
  const handleGenerateInsight = async (player: TrainingPlayerData) => {
    const apiKey = getGeminiApiKey();
    if (!apiKey) return;

    setGeneratingInsight(player.playerName);
    setInsightMsg(null);

    const catAccuracy = SCENARIO_CATEGORIES.map(cat => {
      const results = player.sessions.flatMap(s => s.results.filter(r => r.categoryId === cat.id));
      const total = results.length;
      const correct = results.filter(r => r.correct).length;
      return { name: cat.name, id: cat.id, total, correct, accuracy: total > 0 ? (correct / total) * 100 : -1 };
    }).filter(c => c.total > 0);

    const weakCats = catAccuracy.filter(c => c.accuracy < 50).sort((a, b) => a.accuracy - b.accuracy);
    const strongCats = catAccuracy.filter(c => c.accuracy >= 70).sort((a, b) => b.accuracy - a.accuracy);

    const wrongPatterns = player.sessions.flatMap(s =>
      s.results.filter(r => !r.correct).map(r => `${r.categoryId}: chose ${r.chosenId}`)
    ).slice(-30);

    const dataBlock = `שחקן: ${player.playerName}
סה"כ שאלות: ${player.totalQuestions}, נכונות: ${player.totalCorrect} (${player.accuracy.toFixed(1)}%)
אימונים: ${player.sessions.length}

קטגוריות חלשות: ${weakCats.map(c => `${c.name} (${c.accuracy.toFixed(0)}%, ${c.total} שאלות)`).join(', ') || 'אין'}
קטגוריות חזקות: ${strongCats.map(c => `${c.name} (${c.accuracy.toFixed(0)}%, ${c.total} שאלות)`).join(', ') || 'אין'}

דוגמאות טעויות אחרונות: ${wrongPatterns.join('; ')}`;

    try {
      // 1. Player-facing improvement tips
      const improvementPrompt = `אתה מאמן פוקר. בהתבסס על הנתונים הבאים, כתוב 3-4 טיפים מעשיים לשיפור בעברית פשוטה. התייחס לנקודות החלשות הספציפיות. אל תחזור על הנתונים עצמם.

${dataBlock}

כתוב טיפים קצרים ומעשיים, כל אחד בשורה חדשה. עברית בלבד.`;

      const improvResult = await callGemini(apiKey, improvementPrompt);

      // 2. Admin-facing exploitation analysis
      const exploitPrompt = `אתה יועץ פוקר אסטרטגי. בהתבסס על הנתונים הבאים, נתח איך לנצל את החולשות של השחקן הזה במשחק. תן עצות קונקרטיות ומעשיות שאפשר להשתמש בהן בזמן אמת בשולחן.

${dataBlock}

כתוב 3-5 טקטיקות ניצול ספציפיות. לדוגמה: "כשהוא על הריבר, הימור גדול יגרום לו לוותר ב-X% מהמקרים". עברית בלבד.`;

      const exploitResult = await callGemini(apiKey, exploitPrompt);

      // Save improvement to GitHub
      const currentInsights = insights || { lastUpdated: '', insights: {} };
      currentInsights.insights[player.playerName] = {
        generatedAt: new Date().toISOString(),
        sessionsAtGeneration: player.sessions.length,
        improvement: improvResult,
      };
      currentInsights.lastUpdated = new Date().toISOString();
      await uploadTrainingInsights(currentInsights);
      setInsights({ ...currentInsights });

      // Save exploitation to admin localStorage ONLY
      const exploitData: TrainingExploitationLocal = {
        generatedAt: new Date().toISOString(),
        sessionsAtGeneration: player.sessions.length,
        text: exploitResult,
      };
      localStorage.setItem(`training_exploitation_${player.playerName}`, JSON.stringify(exploitData));

      setInsightMsg(`תובנות נוצרו עבור ${player.playerName}`);
    } catch (err) {
      setInsightMsg(`שגיאה: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      setGeneratingInsight(null);
    }
  };

  const callGemini = async (apiKey: string, prompt: string): Promise<string> => {
    for (const config of API_CONFIGS) {
      const modelPath = config.model.startsWith('models/') ? config.model : `models/${config.model}`;
      const url = `https://generativelanguage.googleapis.com/${config.version}/${modelPath}:generateContent?key=${apiKey}`;

      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
          }),
        });
        if (!resp.ok) continue;
        const data = await resp.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return text;
      } catch { continue; }
    }
    throw new Error('All models failed');
  };

  // ── Flagged questions ──
  const getFlaggedQuestions = (): { poolId: string; scenario: PoolScenario; flagCount: number }[] => {
    if (!answers || !pool) return [];
    const poolIdSet = new Set(pool.scenarios.map(s => s.poolId));
    const flagCounts = new Map<string, number>();
    answers.players.forEach(p => {
      p.sessions.forEach(s => {
        (s.flaggedPoolIds || []).forEach(id => {
          if (poolIdSet.has(id)) {
            flagCounts.set(id, (flagCounts.get(id) || 0) + 1);
          }
        });
      });
    });
    return [...flagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([poolId, flagCount]) => ({
        poolId,
        scenario: pool.scenarios.find(s => s.poolId === poolId)!,
        flagCount,
      }));
  };

  const alerts = getAlerts();
  const flagged = getFlaggedQuestions();
  const players = answers?.players || [];
  const sortedPlayers = [...players].sort((a, b) => b.accuracy - a.accuracy || b.totalQuestions - a.totalQuestions);

  if (loading) {
    return (
      <div className="card" style={{ padding: '2rem', textAlign: 'center' }}>
        <div style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>🎯</div>
        <div style={{ color: 'var(--text-muted)' }}>טוען נתוני אימון...</div>
      </div>
    );
  }

  return (
    <div style={{ direction: 'rtl' }}>
      {/* Header */}
      <div className="card" style={{ padding: '0.75rem 1rem', marginBottom: '0.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 700 }}>🎯 ניהול אימונים</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {lastRefresh && <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{lastRefresh}</span>}
            <button onClick={loadAll} style={{
              fontSize: '0.75rem', padding: '0.25rem 0.5rem', borderRadius: '6px',
              background: 'var(--surface-hover)', color: 'var(--text-muted)',
              border: '1px solid var(--border)', cursor: 'pointer',
            }}>
              🔄
            </button>
          </div>
        </div>
      </div>

      {/* Alerts */}
      {alerts.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', marginBottom: '0.5rem' }}>
          {alerts.map((a, i) => (
            <div key={i} style={{
              padding: '0.5rem 0.75rem', borderRadius: '8px',
              background: `${a.color}15`, border: `1px solid ${a.color}40`,
              fontSize: '0.8rem', color: a.color, fontWeight: 500,
            }}>
              ⚠️ {a.text}
            </div>
          ))}
        </div>
      )}

      {/* Draft recovery banner */}
      {!generating && (() => {
        const draft = loadPoolDraft();
        if (!draft) return null;

        const draftPerCat: Record<string, number> = {};
        draft.forEach(s => { draftPerCat[s.categoryId] = (draftPerCat[s.categoryId] || 0) + 1; });
        const doneCats = SCENARIO_CATEGORIES.filter(c => (draftPerCat[c.id] || 0) >= MIN_PER_CATEGORY).length;

        return (
          <div style={{
            padding: '0.75rem', borderRadius: '8px', marginBottom: '0.5rem',
            background: 'rgba(249,115,22,0.1)', border: '1px solid rgba(249,115,22,0.3)',
          }}>
            <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#f97316', marginBottom: '0.4rem' }}>
              🔄 נמצא טיוטה: {draft.length} שאלות ({doneCats}/{SCENARIO_CATEGORIES.length} קטגוריות)
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.4rem' }}>
              לחץ "המשך ייצור" כדי להשלים את הקטגוריות החסרות, או "שחזר והעלה" כדי להעלות מה שיש.
            </div>
            <div style={{ display: 'flex', gap: '0.4rem' }}>
              <button onClick={handleGeneratePool} style={{
                flex: 1, padding: '0.5rem', borderRadius: '8px', border: 'none',
                background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', color: 'white',
                fontWeight: 600, fontSize: '0.8rem', cursor: 'pointer',
              }}>
                ▶ המשך ייצור ({SCENARIO_CATEGORIES.length - doneCats} קטגוריות)
              </button>
              <button onClick={async () => {
                const recovered = buildPoolObject(draft);
                const result = await uploadTrainingPool(recovered);
                if (result.success) {
                  setPool(recovered);
                  clearPoolDraft();
                  setGenMessage(`שוחזרו ${draft.length} שאלות מטיוטה`);
                }
              }} style={{
                padding: '0.5rem 0.75rem', borderRadius: '8px', border: 'none',
                background: '#f97316', color: 'white', fontWeight: 600, fontSize: '0.75rem', cursor: 'pointer',
              }}>
                שחזר
              </button>
              <button onClick={() => { clearPoolDraft(); setGenMessage(null); }} style={{
                padding: '0.5rem 0.5rem', borderRadius: '8px',
                border: '1px solid var(--border)', background: 'var(--surface)',
                color: 'var(--text-muted)', fontSize: '0.75rem', cursor: 'pointer',
              }}>
                מחק
              </button>
            </div>
          </div>
        );
      })()}

      {/* Pool Management */}
      <div className="card" style={{ padding: '1rem', marginBottom: '0.5rem' }}>
        <h3 style={{ fontSize: '0.9rem', fontWeight: 700, marginBottom: '0.5rem', marginTop: 0 }}>📦 מאגר שאלות</h3>

        {pool && (
          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
            סה"כ: {pool.totalScenarios} שאלות | נוצר: {new Date(pool.generatedAt).toLocaleDateString('he-IL')}
          </div>
        )}

        {generating ? (
          <div style={{ padding: '0.5rem 0' }}>
            {/* Current category + progress bar */}
            <div style={{
              padding: '0.6rem 0.75rem', borderRadius: '8px', marginBottom: '0.5rem',
              background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.2)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.3rem' }}>
                <span style={{ fontWeight: 600, fontSize: '0.8rem' }}>
                  ⚡ {genProgress.category}
                </span>
                <span style={{ fontSize: '0.75rem', color: 'var(--primary)', fontWeight: 700 }}>
                  {genProgress.current}/{genProgress.total}
                </span>
              </div>
              <div style={{ height: '6px', borderRadius: '3px', background: 'var(--surface-light)', overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: '3px',
                  background: 'linear-gradient(90deg, #6366f1, #a855f7)',
                  width: `${(genProgress.current / Math.max(genProgress.total, 1)) * 100}%`,
                  transition: 'width 0.5s ease',
                }} />
              </div>
              {genMessage && (
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.3rem' }}>
                  {genMessage}
                </div>
              )}
            </div>

            {/* Live log */}
            {genLog.length > 0 && (
              <div style={{
                maxHeight: '200px', overflowY: 'auto', fontSize: '0.7rem',
                display: 'flex', flexDirection: 'column', gap: '2px',
              }}>
                {genLog.map((entry, idx) => (
                  <div key={idx} style={{
                    display: 'flex', alignItems: 'center', gap: '0.3rem',
                    padding: '0.15rem 0.3rem', borderRadius: '4px',
                    background: entry.status === 'fail' ? 'rgba(239,68,68,0.08)' :
                               entry.status === 'partial' ? 'rgba(249,115,22,0.08)' :
                               entry.status === 'skip' ? 'rgba(107,114,128,0.08)' :
                               'rgba(34,197,94,0.08)',
                  }}>
                    <span>{entry.icon}</span>
                    <span style={{ flex: 1 }}>{entry.cat}</span>
                    <span style={{
                      fontWeight: 600,
                      color: entry.status === 'fail' ? 'var(--danger)' :
                             entry.status === 'partial' ? '#f97316' :
                             entry.status === 'skip' ? 'var(--text-muted)' :
                             'var(--success)',
                    }}>
                      {entry.status === 'ok' ? `✓ ${entry.count}` :
                       entry.status === 'partial' ? `⚠ ${entry.count}` :
                       entry.status === 'skip' ? `↷ ${entry.count}` :
                       entry.status === 'key_error' ? '🔑 שגיאה' :
                       '✗ נכשל'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button onClick={handleGeneratePool} style={{
              flex: 1, padding: '0.6rem', borderRadius: '10px', border: 'none',
              background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', color: 'white',
              fontWeight: 600, fontSize: '0.8rem', cursor: 'pointer',
            }}>
              {pool ? '🔄 ייצור מחדש' : '✨ צור מאגר חדש'}
            </button>
            {pool && answers && answers.players.length > 0 && (
              <button onClick={handleExpandPool} style={{
                flex: 1, padding: '0.6rem', borderRadius: '10px', border: '1px solid var(--primary)',
                background: 'transparent', color: 'var(--primary)',
                fontWeight: 600, fontSize: '0.8rem', cursor: 'pointer',
              }}>
                📈 הרחב מאגר
              </button>
            )}
          </div>
        )}

        {/* Result message (shown after generation ends) */}
        {!generating && genMessage && (
          <div style={{
            marginTop: '0.5rem', fontSize: '0.8rem', textAlign: 'center', fontWeight: 500,
            padding: '0.5rem', borderRadius: '8px',
            background: genMessage.includes('שגיאה') ? 'rgba(239,68,68,0.08)' : 'rgba(34,197,94,0.08)',
            color: genMessage.includes('שגיאה') ? 'var(--danger)' : 'var(--success)',
          }}>
            {genMessage}
          </div>
        )}

        {/* Post-generation log summary */}
        {!generating && genLog.length > 0 && (
          <details style={{ marginTop: '0.4rem' }}>
            <summary style={{ fontSize: '0.7rem', color: 'var(--text-muted)', cursor: 'pointer' }}>
              פירוט ייצור ({genLog.filter(l => l.status === 'ok').length} הצליחו / {genLog.filter(l => l.status === 'fail').length} נכשלו)
            </summary>
            <div style={{ maxHeight: '200px', overflowY: 'auto', marginTop: '0.3rem', display: 'flex', flexDirection: 'column', gap: '2px' }}>
              {genLog.map((entry, idx) => (
                <div key={idx} style={{
                  display: 'flex', alignItems: 'center', gap: '0.3rem',
                  padding: '0.15rem 0.3rem', borderRadius: '4px', fontSize: '0.7rem',
                  background: entry.status === 'fail' ? 'rgba(239,68,68,0.08)' :
                             entry.status === 'partial' ? 'rgba(249,115,22,0.08)' :
                             entry.status === 'skip' ? 'rgba(107,114,128,0.08)' :
                             'rgba(34,197,94,0.08)',
                }}>
                  <span>{entry.icon}</span>
                  <span style={{ flex: 1 }}>{entry.cat}</span>
                  <span style={{
                    fontWeight: 600,
                    color: entry.status === 'fail' ? 'var(--danger)' :
                           entry.status === 'partial' ? '#f97316' :
                           entry.status === 'skip' ? 'var(--text-muted)' :
                           'var(--success)',
                  }}>
                    {entry.status === 'ok' ? `✓ ${entry.count}` :
                     entry.status === 'partial' ? `⚠ ${entry.count}` :
                     entry.status === 'skip' ? `↷ ${entry.count}` :
                     '✗ נכשל'}
                  </span>
                </div>
              ))}
            </div>
          </details>
        )}

        {/* Per-category breakdown (collapsed by default) */}
        {pool && (
          <details style={{ marginTop: '0.75rem' }}>
            <summary style={{ fontSize: '0.75rem', color: 'var(--text-muted)', cursor: 'pointer', fontWeight: 500 }}>
              פירוט לפי קטגוריה
            </summary>
            <div style={{ marginTop: '0.4rem' }}>
              {SCENARIO_CATEGORIES.map(cat => {
                const count = pool.byCategory[cat.id] || 0;
                return (
                  <div key={cat.id} style={{
                    display: 'flex', justifyContent: 'space-between', padding: '0.2rem 0',
                    fontSize: '0.75rem',
                  }}>
                    <span>{cat.icon} {cat.name}</span>
                    <span style={{ color: count >= 20 ? '#22c55e' : count >= 10 ? '#eab308' : '#ef4444', fontWeight: 600 }}>
                      {count}
                    </span>
                  </div>
                );
              })}
            </div>
          </details>
        )}
      </div>

      {/* Player Summary Table */}
      <div className="card" style={{ padding: '1rem', marginBottom: '0.5rem' }}>
        <h3 style={{ fontSize: '0.9rem', fontWeight: 700, marginBottom: '0.5rem', marginTop: 0 }}>👥 שחקנים</h3>

        {sortedPlayers.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '0.75rem', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
            אין נתוני אימון עדיין
          </div>
        ) : (
          <div>
            {sortedPlayers.map((player, i) => {
              const isExpanded = expandedPlayer === player.playerName;
              const exploit = getExploitLocal(player.playerName);
              const insight = insights?.insights?.[player.playerName];
              const sessionsSinceInsight = insight ? player.sessions.length - insight.sessionsAtGeneration : player.sessions.length;
              const staleness = sessionsSinceInsight <= 2 ? '#22c55e' : sessionsSinceInsight <= 5 ? '#eab308' : '#ef4444';

              const medals = ['🥇', '🥈', '🥉'];

              return (
                <div key={player.playerName} style={{ marginBottom: '0.3rem' }}>
                  {/* Row */}
                  <div
                    onClick={() => setExpandedPlayer(isExpanded ? null : player.playerName)}
                    style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '0.5rem 0.4rem', borderRadius: '8px', cursor: 'pointer',
                      background: isExpanded ? 'rgba(99,102,241,0.08)' : 'transparent',
                      border: isExpanded ? '1px solid rgba(99,102,241,0.15)' : '1px solid transparent',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                      <span style={{ width: '24px', textAlign: 'center', fontSize: '0.8rem' }}>{medals[i] || `${i + 1}`}</span>
                      <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{player.playerName}</span>
                      <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: staleness }} title={`${sessionsSinceInsight} sessions since insight`} />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem' }}>
                      <span style={{ color: 'var(--text-muted)' }}>{player.totalQuestions}Q</span>
                      <span style={{
                        fontWeight: 700,
                        color: player.accuracy >= 60 ? '#22c55e' : player.accuracy >= 40 ? '#eab308' : '#ef4444',
                      }}>
                        {player.accuracy.toFixed(0)}%
                      </span>
                      <span style={{ fontSize: '0.7rem' }}>{isExpanded ? '▲' : '▼'}</span>
                    </div>
                  </div>

                  {/* Expanded card */}
                  {isExpanded && (
                    <div style={{
                      padding: '0.75rem', borderRadius: '0 0 8px 8px',
                      background: 'rgba(99,102,241,0.04)', border: '1px solid rgba(99,102,241,0.1)',
                      borderTop: 'none', marginTop: '-2px',
                    }}>
                      {/* Stats */}
                      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                        <div style={{ flex: 1, textAlign: 'center', padding: '0.4rem', borderRadius: '6px', background: 'var(--surface)' }}>
                          <div style={{ fontSize: '1rem', fontWeight: 700 }}>{player.sessions.length}</div>
                          <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>אימונים</div>
                        </div>
                        <div style={{ flex: 1, textAlign: 'center', padding: '0.4rem', borderRadius: '6px', background: 'var(--surface)' }}>
                          <div style={{ fontSize: '1rem', fontWeight: 700 }}>{player.totalQuestions}</div>
                          <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>שאלות</div>
                        </div>
                        <div style={{ flex: 1, textAlign: 'center', padding: '0.4rem', borderRadius: '6px', background: 'var(--surface)' }}>
                          <div style={{ fontSize: '1rem', fontWeight: 700 }}>
                            {pool ? `${Math.round((new Set(player.sessions.flatMap(s => s.results.map(r => r.poolId))).size / pool.totalScenarios) * 100)}%` : '—'}
                          </div>
                          <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>ניצול מאגר</div>
                        </div>
                      </div>

                      {/* Weak/Strong cats */}
                      {(() => {
                        const catData = SCENARIO_CATEGORIES.map(cat => {
                          const results = player.sessions.flatMap(s => s.results.filter(r => r.categoryId === cat.id));
                          const total = results.length;
                          const correct = results.filter(r => r.correct).length;
                          return { ...cat, total, correct, accuracy: total > 0 ? (correct / total) * 100 : -1 };
                        }).filter(c => c.total >= 3);

                        const weakest = catData.filter(c => c.accuracy < 50).sort((a, b) => a.accuracy - b.accuracy).slice(0, 3);
                        const strongest = catData.filter(c => c.accuracy >= 70).sort((a, b) => b.accuracy - a.accuracy).slice(0, 3);

                        return (
                          <div style={{ fontSize: '0.75rem', marginBottom: '0.5rem' }}>
                            {weakest.length > 0 && (
                              <div style={{ marginBottom: '0.3rem' }}>
                                <span style={{ color: '#ef4444', fontWeight: 600 }}>חלש: </span>
                                {weakest.map(c => `${c.icon} ${c.name} (${c.accuracy.toFixed(0)}%)`).join(', ')}
                              </div>
                            )}
                            {strongest.length > 0 && (
                              <div>
                                <span style={{ color: '#22c55e', fontWeight: 600 }}>חזק: </span>
                                {strongest.map(c => `${c.icon} ${c.name} (${c.accuracy.toFixed(0)}%)`).join(', ')}
                              </div>
                            )}
                          </div>
                        );
                      })()}

                      {/* AI Insights */}
                      {insight && (
                        <div style={{
                          padding: '0.6rem', borderRadius: '8px', marginBottom: '0.4rem',
                          background: 'rgba(168,85,247,0.06)', border: '1px solid rgba(168,85,247,0.15)',
                        }}>
                          <div style={{ fontSize: '0.7rem', color: '#a855f7', fontWeight: 600, marginBottom: '0.2rem' }}>
                            מה השחקן רואה:
                          </div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                            {insight.improvement}
                          </div>
                        </div>
                      )}

                      {exploit && (
                        <div style={{
                          padding: '0.6rem', borderRadius: '8px', marginBottom: '0.4rem',
                          background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.15)',
                        }}>
                          <div style={{ fontSize: '0.7rem', color: '#ef4444', fontWeight: 600, marginBottom: '0.2rem' }}>
                            🔒 לעיניך בלבד:
                          </div>
                          <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                            {exploit.text}
                          </div>
                        </div>
                      )}

                      {/* Generate insight button */}
                      <button
                        onClick={() => handleGenerateInsight(player)}
                        disabled={generatingInsight === player.playerName}
                        style={{
                          width: '100%', padding: '0.5rem', borderRadius: '8px', border: 'none',
                          background: generatingInsight === player.playerName ? 'var(--surface-light)' : 'linear-gradient(135deg, #a855f7, #7c3aed)',
                          color: 'white', fontWeight: 600, fontSize: '0.8rem', cursor: 'pointer',
                        }}
                      >
                        {generatingInsight === player.playerName ? '⏳ מייצר...' : `✨ ${insight ? 'עדכן' : 'צור'} תובנות`}
                        {sessionsSinceInsight > 0 && insight && (
                          <span style={{ fontSize: '0.65rem', opacity: 0.8, marginRight: '0.3rem' }}>
                            ({sessionsSinceInsight} אימונים חדשים)
                          </span>
                        )}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Flagged Questions */}
      {flagged.length > 0 && (
        <div className="card" style={{ padding: '1rem', marginBottom: '0.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <h3 style={{ fontSize: '0.9rem', fontWeight: 700, margin: 0 }}>🚩 שאלות שדווחו כשגויות ({flagged.length})</h3>
            <button
              onClick={() => handleRemoveFlagged(flagged.map(f => f.poolId))}
              disabled={removingFlagged}
              style={{
                fontSize: '0.7rem', padding: '0.25rem 0.5rem', borderRadius: '6px',
                background: 'rgba(239,68,68,0.1)', color: '#ef4444',
                border: '1px solid rgba(239,68,68,0.2)', cursor: removingFlagged ? 'wait' : 'pointer',
                opacity: removingFlagged ? 0.5 : 1,
              }}
            >
              {removingFlagged ? '⏳ מסיר...' : '🗑 הסר הכל'}
            </button>
          </div>

          {flagMsg && (
            <div style={{
              padding: '0.4rem 0.6rem', borderRadius: '6px', marginBottom: '0.5rem',
              fontSize: '0.75rem', fontWeight: 500, textAlign: 'center',
              background: flagMsg.includes('✅') ? 'rgba(34,197,94,0.08)' : flagMsg.includes('❌') ? 'rgba(239,68,68,0.08)' : 'rgba(99,102,241,0.08)',
              color: flagMsg.includes('✅') ? 'var(--success)' : flagMsg.includes('❌') ? 'var(--danger)' : 'var(--text-muted)',
            }}>
              {flagMsg}
            </div>
          )}

          <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
            שחקנים דיווחו שהשאלות הבאות שגויות או לא הגיוניות. בדוק והחלט אם להסיר.
          </div>
          {flagged.map(f => {
            const cat = SCENARIO_CATEGORIES.find(c => c.id === f.scenario?.categoryId);
            const correctOpt = f.scenario?.options?.find(o => o.isCorrect);
            return (
              <div key={f.poolId} style={{
                padding: '0.6rem', borderRadius: '8px', marginBottom: '0.4rem',
                background: f.flagCount >= 2 ? 'rgba(239,68,68,0.08)' : 'var(--surface)',
                border: f.flagCount >= 2 ? '1px solid rgba(239,68,68,0.2)' : '1px solid var(--border)',
              }}>
                {cat && (
                  <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginBottom: '0.2rem' }}>
                    {cat.icon} {cat.name} · דווח {f.flagCount} {f.flagCount === 1 ? 'פעם' : 'פעמים'}
                  </div>
                )}
                <div style={{ fontSize: '0.75rem', color: 'var(--text)', lineHeight: 1.5, marginBottom: '0.3rem' }}>
                  {f.scenario?.situation || '(שאלה כבר הוסרה)'}
                </div>
                {correctOpt && (
                  <div style={{ fontSize: '0.65rem', color: 'var(--success)', marginBottom: '0.3rem' }}>
                    ✓ תשובה נכונה: {correctOpt.text}
                  </div>
                )}
                <div style={{ display: 'flex', gap: '0.3rem', justifyContent: 'flex-end' }}>
                  <button
                    onClick={() => handleRemoveFlagged([f.poolId])}
                    disabled={removingFlagged}
                    style={{
                      fontSize: '0.65rem', padding: '0.2rem 0.5rem', borderRadius: '6px',
                      background: '#ef4444', color: 'white',
                      border: 'none', cursor: removingFlagged ? 'wait' : 'pointer', fontWeight: 600,
                      opacity: removingFlagged ? 0.5 : 1,
                    }}
                  >
                    {removingFlagged ? '⏳' : '🗑 הסר שאלה'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {insightMsg && (
        <div style={{ textAlign: 'center', fontSize: '0.8rem', color: 'var(--text-muted)', padding: '0.5rem' }}>
          {insightMsg}
        </div>
      )}
    </div>
  );
};

const getExploitLocal = (playerName: string): TrainingExploitationLocal | null => {
  try {
    const raw = localStorage.getItem(`training_exploitation_${playerName}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

export default TrainingAdminTab;
