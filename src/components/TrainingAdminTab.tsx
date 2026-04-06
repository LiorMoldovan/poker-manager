import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  TrainingPool,
  TrainingAnswersFile,
  TrainingInsightsFile,
  TrainingPlayerData,
  TrainingExploitationLocal,
  PoolScenario,
  TrainingFlagReport,
} from '../types';
import {
  fetchTrainingPool,
  fetchTrainingAnswers,
  fetchTrainingInsights,
  uploadTrainingPool,
  uploadTrainingInsights,
  removeFromTrainingPool,
  writeTrainingAnswersWithRetry,
} from '../database/githubSync';
import {
  SCENARIO_CATEGORIES,
  generatePoolBatch,
  normalizeTrainingPlayers,
  GAME_CONTEXT,
  PLAYER_STYLES,
  analyzePlayerTraining,
  formatAnalysisForPrompt,
  getPlayerGameSummary,
  generatePlayerCoaching,
} from '../utils/pokerTraining';
import { getGeminiApiKey, API_CONFIGS } from '../utils/geminiAI';
import { shareToWhatsApp } from '../utils/sharing';


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
  const [genLog, setGenLog] = useState<{ cat: string; icon: string; status: string; count: number; error?: string; elapsed?: number }[]>([]);

  // Expanded player
  const [expandedPlayer, setExpandedPlayer] = useState<string | null>(null);

  // Flagged removal / dismiss / AI fix
  const [removingFlagged, setRemovingFlagged] = useState(false);
  const [dismissingFlagged, setDismissingFlagged] = useState<string | null>(null);
  const [fixingFlagged, setFixingFlagged] = useState<string | null>(null);
  const [fixPreview, setFixPreview] = useState<{ poolId: string; original: PoolScenario; fixed: PoolScenario } | null>(null);
  const [fixFeedback, setFixFeedback] = useState('');
  const [fixHistory, setFixHistory] = useState<string[]>([]);
  const [regenerating, setRegenerating] = useState(false);
  const [savingFix, setSavingFix] = useState(false);
  const [flagMsg, setFlagMsg] = useState<string | null>(null);

  // Report AI analysis
  const [analyses, setAnalyses] = useState<Record<string, { verdict: string; explanation: string; rejectText: string; acceptText?: string }>>({});
  const [analyzingReport, setAnalyzingReport] = useState<string | null>(null);
  const [analysisFeedback, setAnalysisFeedback] = useState<Record<string, string>>({});
  const [refiningAnalysis, setRefiningAnalysis] = useState<string | null>(null);

  // Pool review
  const [reviewing, setReviewing] = useState(false);
  const [reviewProgress, setReviewProgress] = useState({ current: 0, total: 0 });
  const [reviewMsg, setReviewMsg] = useState<string | null>(null);
  const [reviewLog, setReviewLog] = useState<string[]>([]);

  // AI insight generation
  const [generatingInsight, setGeneratingInsight] = useState<string | null>(null);
  const [generatingStep, setGeneratingStep] = useState<string | null>(null);
  const [insightMsg, setInsightMsg] = useState<string | null>(null);


  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [p, rawA, i] = await Promise.all([
        fetchTrainingPool(),
        fetchTrainingAnswers(),
        fetchTrainingInsights(),
      ]);
      const a = rawA ? normalizeTrainingPlayers(rawA) : rawA;
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

  // Auto-generate coaching for players who need it:
  // 1. Players with pendingReportMilestones (crossed milestone during session)
  // 2. Players with 100+ questions but no insights yet
  const [autoGenRunning, setAutoGenRunning] = useState(false);
  useEffect(() => {
    if (!answers || answers.players.length === 0 || !insights) return;
    if (autoGenRunning) return;
    const apiKey = getGeminiApiKey();
    if (!apiKey) return;

    const needsCoaching = answers.players.filter(p => {
      const allAnswered = p.sessions.reduce((sum, s) => sum + s.results.length, 0);
      const hasPending = p.pendingReportMilestones && p.pendingReportMilestones.length > 0;
      const hasInsight = !!insights.insights?.[p.playerName];
      const eligible = allAnswered >= 100 && !hasInsight;
      return hasPending || eligible;
    });
    if (needsCoaching.length === 0) return;

    setAutoGenRunning(true);
    (async () => {
      for (const player of needsCoaching) {
        setInsightMsg(`⏳ מייצר תובנות אוטומטיות ל${player.playerName}...`);
        const coachingText = await generatePlayerCoaching(player.playerName, player, answers.players);
        if (coachingText) {
          const currentInsights = insights || { lastUpdated: '', insights: {} };
          currentInsights.insights[player.playerName] = {
            generatedAt: new Date().toISOString(),
            sessionsAtGeneration: player.sessions.length,
            improvement: coachingText,
          };
          currentInsights.lastUpdated = new Date().toISOString();
          await uploadTrainingInsights(currentInsights);
          setInsights({ ...currentInsights });

          if (player.pendingReportMilestones && player.pendingReportMilestones.length > 0) {
            await writeTrainingAnswersWithRetry((data) => {
              const p = data.players.find(pl => pl.playerName === player.playerName);
              if (p) {
                p.pendingReportMilestones = [];
              }
              data.lastUpdated = new Date().toISOString();
              return data;
            });
          }
          setInsightMsg(`✅ תובנות נוצרו ל${player.playerName}`);
        }
        await new Promise(r => setTimeout(r, 3000));
      }
      setInsightMsg(null);
      loadAll();
    })().finally(() => setAutoGenRunning(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answers?.players.length, insights]);

  // ── Alerts ──
  const getAlerts = (): { text: string; color: string }[] => {
    const alerts: { text: string; color: string }[] = [];

    if (answers && pool) {
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

    return alerts;
  };

  const MIN_PER_CATEGORY = 20;

  // ── Pool health status ──
  const poolStatus = useMemo(() => {
    if (!pool || pool.totalScenarios === 0) {
      return { status: 'empty' as const, label: 'אין מאגר — צריך ליצור', incompleteCats: SCENARIO_CATEGORIES.length, depletedCats: 0 };
    }

    const perCat: Record<string, number> = {};
    pool.scenarios.forEach(s => { perCat[s.categoryId] = (perCat[s.categoryId] || 0) + 1; });
    const incompleteCats = SCENARIO_CATEGORIES.filter(c => (perCat[c.id] || 0) < MIN_PER_CATEGORY).length;

    let depletedCats = 0;
    if (answers && answers.players.length > 0) {
      const seenByPlayer = new Map<string, Set<string>>();
      answers.players.forEach(p => {
        seenByPlayer.set(p.playerName, new Set(p.sessions.flatMap(s => s.results.map(r => r.poolId))));
      });
      SCENARIO_CATEGORIES.forEach(cat => {
        if ((perCat[cat.id] || 0) < MIN_PER_CATEGORY) return;
        const catPool = pool.scenarios.filter(s => s.categoryId === cat.id);
        const anyLow = [...seenByPlayer.values()].some(seen => {
          return catPool.filter(s => !seen.has(s.poolId)).length < 5;
        });
        if (anyLow) depletedCats++;
      });
    }

    if (incompleteCats === 0 && depletedCats === 0) {
      return { status: 'healthy' as const, label: 'מאגר תקין', incompleteCats: 0, depletedCats: 0 };
    }

    const parts: string[] = [];
    if (incompleteCats > 0) parts.push(`${incompleteCats} קטגוריות לא מלאות`);
    if (depletedCats > 0) parts.push(`${depletedCats} נגמרות לשחקנים`);

    return { status: 'needs_work' as const, label: parts.join(' + '), incompleteCats, depletedCats };
  }, [pool, answers]);

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

  // ── Smart generate: fill incomplete → expand depleted → upload ──
  const handleSmartGenerate = async (forceExpand = false) => {
    const apiKey = getGeminiApiKey();
    if (!apiKey) {
      setGenMessage('חסר מפתח Gemini API');
      return;
    }

    setGenerating(true);
    setGenMessage(null);
    setGenLog([]);

    const draft = loadPoolDraft();
    const allScenarios: PoolScenario[] = draft || (pool ? [...pool.scenarios] : []);

    const existingPerCat: Record<string, number> = {};
    allScenarios.forEach(s => {
      existingPerCat[s.categoryId] = (existingPerCat[s.categoryId] || 0) + 1;
    });

    // Pass 1: fill categories below MIN_PER_CATEGORY
    const incompleteCats = SCENARIO_CATEGORIES.filter(
      cat => (existingPerCat[cat.id] || 0) < MIN_PER_CATEGORY
    );

    // Pass 2: expand depleted categories (players running out of unseen questions)
    const seenByPlayer = new Map<string, Set<string>>();
    if (answers) {
      answers.players.forEach(p => {
        seenByPlayer.set(p.playerName, new Set(p.sessions.flatMap(s => s.results.map(r => r.poolId))));
      });
    }
    const depletedCats = SCENARIO_CATEGORIES.filter(cat => {
      if (incompleteCats.some(ic => ic.id === cat.id)) return false;
      if (seenByPlayer.size === 0) return false;
      const catPool = allScenarios.filter(s => s.categoryId === cat.id);
      return [...seenByPlayer.values()].some(seen => catPool.filter(s => !seen.has(s.poolId)).length < 5);
    });

    // Pass 3: force expand — add 10 questions to each category (when admin explicitly requests more)
    const forceExpandCats = forceExpand && incompleteCats.length === 0 && depletedCats.length === 0
      ? SCENARIO_CATEGORIES
      : [];

    const workItems = [
      ...incompleteCats.map(cat => ({ cat, needed: 30 - (existingPerCat[cat.id] || 0), phase: 'fill' as const })),
      ...depletedCats.map(cat => ({ cat, needed: 15, phase: 'expand' as const })),
      ...forceExpandCats.map(cat => ({ cat, needed: 10, phase: 'expand' as const })),
    ];

    if (workItems.length === 0) {
      setGenerating(false);
      if (draft) {
        const newPool = buildPoolObject(allScenarios);
        const result = await uploadTrainingPool(newPool);
        clearPoolDraft();
        if (result.success) setPool(newPool);
        setGenMessage(`טיוטה הועלתה! סה"כ: ${allScenarios.length} שאלות`);
      } else {
        setGenMessage(`מאגר תקין — אין מה לייצר`);
      }
      return;
    }

    const log: { cat: string; icon: string; status: string; count: number; error?: string; elapsed?: number }[] = [];
    const workIds = new Set(workItems.map(w => w.cat.id));
    SCENARIO_CATEGORIES.filter(c => !workIds.has(c.id)).forEach(c => {
      log.push({ cat: c.name, icon: c.icon, status: 'skip', count: existingPerCat[c.id] || 0 });
    });
    if (log.length > 0) setGenLog([...log]);

    let totalGenerated = 0;
    let totalFailed = 0;
    const startTime = Date.now();

    for (let i = 0; i < workItems.length; i++) {
      const { cat, needed, phase } = workItems[i];
      const phaseLabel = phase === 'fill' ? 'השלמה' : 'הרחבה';
      setGenProgress({ current: i + 1, total: workItems.length, category: `${phaseLabel}: ${cat.name}` });

      let batchCount = 0;
      let catStatus = 'fail';
      let catError: string | undefined;
      const catStart = Date.now();

      try {
        const batch = await generatePoolBatch(cat, needed, allScenarios, apiKey);
        if (batch.length > 0) {
          allScenarios.push(...batch);
          batchCount = batch.length;
          totalGenerated += batch.length;
          catStatus = batch.length >= needed * 0.6 ? 'ok' : 'partial';
          if (catStatus === 'partial') catError = `ביקשנו ${needed}, קיבלנו ${batch.length}`;
        } else {
          totalFailed++;
          catError = 'AI החזיר 0 שאלות תקינות';
        }
      } catch (err) {
        console.error(`Smart gen failed for ${cat.id} (${phase}):`, err);
        totalFailed++;
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg === 'INVALID_API_KEY') {
          catStatus = 'key_error';
          catError = 'מפתח API לא תקין';
          log.push({ cat: cat.name, icon: cat.icon, status: catStatus, count: 0, error: catError, elapsed: Date.now() - catStart });
          setGenLog([...log]);
          setGenMessage('מפתח API לא תקין — עצירה');
          break;
        }
        catStatus = 'fail';
        catError = errMsg.length > 80 ? errMsg.slice(0, 80) + '…' : errMsg;
      }

      const catElapsed = Date.now() - catStart;
      log.push({ cat: cat.name, icon: cat.icon, status: catStatus, count: batchCount, error: catError, elapsed: catElapsed });
      setGenLog([...log]);
      savePoolDraft(allScenarios);

      const elapsed = Date.now() - startTime;
      const avgPerCat = elapsed / (i + 1);
      const remaining = workItems.length - (i + 1);
      const etaMin = Math.ceil((remaining * avgPerCat) / 60000);
      const etaText = remaining > 0 ? ` · ~${etaMin} דק׳ נותרו` : '';
      setGenMessage(`${totalGenerated} שאלות נוצרו${totalFailed > 0 ? ` · ${totalFailed} נכשלו` : ''}${etaText}`);

      if (i < workItems.length - 1) {
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
      const failedCats = log.filter(l => l.status === 'fail' || l.status === 'key_error');
      const failDetail = failedCats.length > 0
        ? ` · נכשלו: ${failedCats.map(f => `${f.icon} ${f.cat}${f.error ? ` (${f.error})` : ''}`).join(', ')}`
        : '';
      setGenMessage(
        `סיום! ${totalGenerated} שאלות חדשות` +
        (totalFailed > 0 ? ` · ${totalFailed} נכשלו` : '') +
        ` · סה"כ ${allScenarios.length} שאלות · ${elapsedMin} דקות` +
        failDetail +
        ` · מתחיל סריקת איכות...`
      );
      // Auto-scan new questions after generation
      setTimeout(() => handleReviewPool(), 2000);
    } else {
      setGenMessage(`שגיאה בהעלאה סופית: ${result.message} — הטיוטה שמורה מקומית, נסה שוב`);
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

  // ── Dismiss flag reports (reject reports, keep question) ──
  const clearFlagsLocally = (data: TrainingAnswersFile, poolId: string): TrainingAnswersFile => {
    const clone = JSON.parse(JSON.stringify(data)) as TrainingAnswersFile;
    clone.players.forEach(player => {
      player.sessions.forEach(session => {
        if (session.flaggedPoolIds) {
          session.flaggedPoolIds = session.flaggedPoolIds.filter(id => id !== poolId);
        }
        if (session.flagReports) {
          session.flagReports = session.flagReports.filter(r => r.poolId !== poolId);
        }
      });
    });
    clone.lastUpdated = new Date().toISOString();
    return clone;
  };

  const handleDismissFlagged = async (poolId: string) => {
    setDismissingFlagged(poolId);
    setFlagMsg(`דוחה דיווחים...`);
    try {
      const ok = await writeTrainingAnswersWithRetry((data) => clearFlagsLocally(data, poolId));
      if (ok) {
        if (answers) setAnswers(clearFlagsLocally(answers, poolId));
        setFlagMsg('✅ הדיווחים נדחו — השאלה נשארת');
      } else {
        setFlagMsg('❌ שגיאה בעדכון');
      }
    } catch (err) {
      setFlagMsg(`❌ שגיאה: ${err instanceof Error ? err.message : 'Unknown'}`);
    } finally {
      setDismissingFlagged(null);
    }
  };

  // ── Analyze report with AI ──
  const handleAnalyzeReport = async (poolId: string, scenario: PoolScenario, reports: TrainingFlagReport[]) => {
    const apiKey = getGeminiApiKey();
    if (!apiKey) return;

    setAnalyzingReport(poolId);

    const reportSummary = reports.map(r => {
      const reasonLabel: Record<string, string> = {
        wrong_answer: 'התשובה הנכונה שגויה',
        unclear_question: 'השאלה לא ברורה',
        wrong_for_home_game: 'מתאים למקצועי אבל לא למשחק ביתי',
        other: 'אחר',
      };
      return `${r.playerName}: ${reasonLabel[r.reason] || r.reason}${r.comment ? ` — "${r.comment}"` : ''}`;
    }).join('\n');

    const prompt = `אתה מנהל משחק פוקר ביתי. שחקנים דיווחו על שאלה באימון.
נתח את הדיווח: האם הוא מוצדק? האם השאלה והתשובה הנכונה באמת בעייתיות?

${GAME_CONTEXT}

השאלה:
מצב: ${scenario.situation}
קלפים: ${scenario.yourCards || 'לא צוינו'}
${scenario.options.map(o => `${o.id}. ${o.text}${o.isCorrect ? ' ✓' : ''}${o.nearMiss ? ' (ניטרלי)' : ''} — ${o.explanation || ''}`).join('\n')}

הדיווחים:
${reportSummary}

החזר JSON בלבד בפורמט:
{"verdict":"accept|reject|partial","explanation":"ניתוח קצר של 2-3 משפטים — האם הדיווח מוצדק ולמה","rejectText":"הודעה קצרה וידידותית של משפט אחד שאפשר לשלוח למדווח בוואטסאפ אם דוחים את הדיווח, כולל הסבר למה התשובה נכונה","acceptText":"הודעה קצרה וידידותית למדווח שתודה לו על הדיווח ומסבירה שתיקנו/עדכנו את השאלה בזכותו"}
- acceptText חובה כש-verdict הוא accept או partial
- rejectText חובה כש-verdict הוא reject או partial
JSON בלבד, בלי markdown:`;

    try {
      const text = await callGemini(apiKey, prompt);
      const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const result = JSON.parse(cleaned);
      setAnalyses(prev => ({ ...prev, [poolId]: result }));
    } catch (err) {
      setAnalyses(prev => ({
        ...prev,
        [poolId]: { verdict: 'error', explanation: `שגיאה: ${err instanceof Error ? err.message : 'Unknown'}`, rejectText: '' }
      }));
    } finally {
      setAnalyzingReport(null);
    }
  };

  const handleRefineAnalysis = async (poolId: string, scenario: PoolScenario, reports: TrainingFlagReport[]) => {
    const apiKey = getGeminiApiKey();
    const feedback = analysisFeedback[poolId]?.trim();
    if (!apiKey || !feedback || !analyses[poolId]) return;

    setRefiningAnalysis(poolId);

    const prev = analyses[poolId];
    const reportSummary = reports.map(r => {
      const rl: Record<string, string> = { wrong_answer: 'התשובה שגויה', unclear_question: 'לא ברור', wrong_for_home_game: 'לא למשחק ביתי', other: 'אחר' };
      return `${r.playerName}: ${rl[r.reason] || r.reason}${r.comment ? ` — "${r.comment}"` : ''}`;
    }).join('\n');

    const prompt = `אתה מנהל משחק פוקר ביתי. ניתחת דיווח על שאלה ועכשיו המנהל נותן משוב.

${GAME_CONTEXT}

השאלה: ${scenario.situation}
קלפים: ${scenario.yourCards || 'לא צוינו'}
${scenario.options.map(o => `${o.id}. ${o.text}${o.isCorrect ? ' ✓' : ''} — ${o.explanation || ''}`).join('\n')}

דיווחים: ${reportSummary}

הניתוח הקודם שלך:
verdict: ${prev.verdict}
explanation: ${prev.explanation}
rejectText: ${prev.rejectText}
acceptText: ${prev.acceptText || ''}

הערת המנהל: "${feedback}"

עדכן את הניתוח בהתאם. החזר JSON בלבד:
{"verdict":"accept|reject|partial","explanation":"ניתוח מעודכן 2-3 משפטים","rejectText":"הודעה ידידותית למדווח אם דוחים","acceptText":"הודעה ידידותית למדווח שתודה לו ומסבירה שתוקן"}
JSON בלבד:`;

    try {
      const text = await callGemini(apiKey, prompt);
      const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const result = JSON.parse(cleaned);
      setAnalyses(prev => ({ ...prev, [poolId]: result }));
      setAnalysisFeedback(prev => ({ ...prev, [poolId]: '' }));
    } catch (err) {
      setAnalyses(prev => ({
        ...prev,
        [poolId]: { ...prev[poolId], explanation: prev[poolId].explanation + `\n\nשגיאה בעדכון: ${err instanceof Error ? err.message : 'Unknown'}` }
      }));
    } finally {
      setRefiningAnalysis(null);
    }
  };

  // ── AI Fix flagged question (generates preview) ──
  const handleAIFix = async (poolId: string, reports: TrainingFlagReport[]) => {
    const apiKey = getGeminiApiKey();
    if (!apiKey || !pool) return;

    const scenario = pool.scenarios.find(s => s.poolId === poolId);
    if (!scenario) return;

    setFixingFlagged(poolId);
    setFlagMsg(`AI מייצר תיקון...`);

    const reportSummary = reports.map(r => {
      const reasonLabel: Record<string, string> = {
        wrong_answer: 'התשובה הנכונה שגויה',
        unclear_question: 'השאלה לא ברורה',
        wrong_for_home_game: 'מתאים למקצועי אבל לא למשחק ביתי',
        other: 'אחר',
      };
      return `- ${r.playerName}: ${reasonLabel[r.reason] || r.reason}${r.comment ? ` — "${r.comment}"` : ''}`;
    }).join('\n');

    const playerStylesList = Object.entries(PLAYER_STYLES)
      .map(([name, style]) => `- ${name}: ${style}`)
      .join('\n');

    const prompt = `אתה מומחה פוקר. שחקנים דיווחו על בעיה בשאלה הבאה. תקן אותה.

${GAME_CONTEXT}

שחקנים קבועים (ניתן להשתמש בשמות שלהם):
${playerStylesList}

שאלה נוכחית:
${JSON.stringify({
  poolId: scenario.poolId,
  situation: scenario.situation,
  yourCards: scenario.yourCards,
  options: scenario.options.map(o => ({ id: o.id, text: o.text, isCorrect: o.isCorrect, explanation: o.explanation, nearMiss: o.nearMiss })),
  category: scenario.category,
  categoryId: scenario.categoryId,
})}

דיווחי שחקנים:
${reportSummary}

תקן כך:
1. בדיוק 3 אופציות (A, B, C) — בדיוק אחת נכונה למשחק ביתי
2. מצב: 2-3 משפטים תמציתיים. אל תחזור על הקלפים בטקסט
3. כל הסכומים בצ'יפים (לא שקלים)
4. הסברים בעברית פשוטה, ספציפיים ללוח ולקלפים
5. nearMiss: true לתשובות שנכונות בפוקר מקצועי אך לא למשחק ביתי
6. שמור על poolId, categoryId ו-category מקוריים
7. מונחים: פלופ/טרן/ריבר (לא "נהר"), בליינד (לא "עיוור"), ביד (לא "בכיס"), כפתור (לא "מפיץ")
8. מונחים באנגלית — חובה תרגום בסוגריים בפעם הראשונה: Pot Odds (יחס קופה), Implied Odds (סיכויי רווח עתידיים), EV (ערך צפוי), Equity (אחוז ניצחון) וכו'
9. **הנמקה חייבת להתאים למשחק ביתי** — אסור להשתמש בלוגיקה מקצועית:
   - אסור: "העלאה תדלל/תבודד", "fold equity", "לבודד יריב"
   - נכון: "העלאה בונה קופה גדולה כי הם ישלמו", "בלוף לא יעבוד — תמיד מישהו קורא"
   - בגלל שהשחקנים שלנו קוראים הרבה: העלאה = בניית קופה, לא בידוד

החזר JSON בלבד, אובייקט אחד:
{"poolId":"...","situation":"...","yourCards":"...","options":[{"id":"A","text":"...","isCorrect":false,"explanation":"...","nearMiss":true},{"id":"B","text":"...","isCorrect":true,"explanation":"..."},{"id":"C","text":"...","isCorrect":false,"explanation":"..."}],"category":"...","categoryId":"..."}

JSON בלבד, בלי markdown:`;

    try {
      const fixedText = await callGemini(apiKey, prompt);
      const cleaned = fixedText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const fixedScenario = JSON.parse(cleaned) as PoolScenario;

      if (!fixedScenario.poolId || !fixedScenario.options || fixedScenario.options.length === 0) {
        setFlagMsg('❌ AI החזיר תוצאה לא תקינה');
        setFixingFlagged(null);
        return;
      }

      fixedScenario.poolId = poolId;
      fixedScenario.categoryId = scenario.categoryId;
      fixedScenario.category = scenario.category;

      setFixPreview({ poolId, original: scenario, fixed: fixedScenario });
      setFixFeedback('');
      setFixHistory([]);
      setFlagMsg(null);
    } catch (err) {
      setFlagMsg(`❌ שגיאת AI: ${err instanceof Error ? err.message : 'Unknown'}`);
    } finally {
      setFixingFlagged(null);
    }
  };

  const handleRegenerateFix = async () => {
    if (!fixPreview || !fixFeedback.trim()) return;
    const apiKey = getGeminiApiKey();
    if (!apiKey) return;
    setRegenerating(true);

    const historyContext = fixHistory.length > 0
      ? `\nשיפורים קודמים שביקשתי:\n${fixHistory.map((h, i) => `${i + 1}. ${h}`).join('\n')}\n`
      : '';

    const prompt = `אתה מומחה פוקר. תקנת שאלה אבל צריך שיפור נוסף.

${GAME_CONTEXT}

שאלה מקורית:
${JSON.stringify(fixPreview.original)}

תיקון נוכחי:
${JSON.stringify(fixPreview.fixed)}
${historyContext}
הערה חדשה מהמנהל: "${fixFeedback}"

חוקים: בדיוק 3 אופציות (A, B, C), מצב תמציתי (2-3 משפטים), סכומים בצ'יפים, שמור poolId/categoryId/category.
הנמקה חייבת להתאים למשחק ביתי — אסור: "תדלל/תבודד", "fold equity". נכון: "בונה קופה", "הם ישלמו".

החזר JSON בלבד, אובייקט אחד מתוקן:`;

    try {
      const fixedText = await callGemini(apiKey, prompt);
      const cleaned = fixedText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const fixedScenario = JSON.parse(cleaned) as PoolScenario;
      fixedScenario.poolId = fixPreview.poolId;
      fixedScenario.categoryId = fixPreview.original.categoryId;
      fixedScenario.category = fixPreview.original.category;
      setFixHistory(prev => [...prev, fixFeedback]);
      setFixPreview({ ...fixPreview, fixed: fixedScenario });
      setFixFeedback('');
    } catch (err) {
      setFlagMsg(`❌ שגיאת AI: ${err instanceof Error ? err.message : 'Unknown'}`);
    } finally {
      setRegenerating(false);
    }
  };

  // ── Confirm AI fix (save to pool + clear flags) ──
  const confirmAIFix = async () => {
    if (!fixPreview || !pool) return;
    setSavingFix(true);
    setFlagMsg('שומר תיקון...');

    const { poolId, fixed } = fixPreview;
    try {
      const updatedScenarios = pool.scenarios.map(s => s.poolId === poolId ? fixed : s);
      const newPool = buildPoolObject(updatedScenarios);
      const result = await uploadTrainingPool(newPool);

      if (result.success) {
        setPool(newPool);
        const ok = await writeTrainingAnswersWithRetry((data) => clearFlagsLocally(data, poolId));
        if (ok && answers) {
          setAnswers(clearFlagsLocally(answers, poolId));
        }
        setFlagMsg('✅ השאלה תוקנה — הדיווחים נמחקו');
      } else {
        setFlagMsg(`❌ שגיאה בהעלאה: ${result.message}`);
      }
    } catch (err) {
      setFlagMsg(`❌ שגיאה: ${err instanceof Error ? err.message : 'Unknown'}`);
    } finally {
      setFixPreview(null);
      setSavingFix(false);
    }
  };

  // ── Review pool with AI ──
  const handleReviewPool = async () => {
    if (!pool || pool.scenarios.length === 0) return;
    const apiKey = getGeminiApiKey();
    if (!apiKey) { setReviewMsg('❌ אין מפתח Gemini'); return; }
    setReviewing(true);
    setReviewLog([]);
    setReviewMsg(null);

    const BATCH = 10;
    const updatedScenarios = [...pool.scenarios];
    const unreviewedIndices = updatedScenarios
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => !s.reviewedAt)
      .map(({ i }) => i);

    if (unreviewedIndices.length === 0) {
      setReviewMsg(`✅ כל ${updatedScenarios.length} השאלות כבר נסרקו — אין מה לבדוק`);
      setReviewing(false);
      return;
    }

    const skipped = updatedScenarios.length - unreviewedIndices.length;
    if (skipped > 0) {
      setReviewLog(prev => [...prev, `⏭ דילוג על ${skipped} שאלות שכבר נסרקו`]);
    }

    const scenarios = unreviewedIndices.map(i => updatedScenarios[i]);
    const totalBatches = Math.ceil(scenarios.length / BATCH);
    let fixed = 0, removed = 0, ok = 0, errors = 0;

    for (let b = 0; b < totalBatches; b++) {
      const start = b * BATCH;
      const batch = scenarios.slice(start, start + BATCH);
      setReviewProgress({ current: b + 1, total: totalBatches });
      setReviewMsg(`סורק אצווה ${b + 1}/${totalBatches}...`);

      const prompt = `אתה מומחה פוקר. בדוק ${batch.length} שאלות אימון.

${GAME_CONTEXT}

⚠️ בדיקות קריטיות:
1. **לוגיקה פוקרית**: התשובה הנכונה באמת נכונה? בדוק:
   - הקלפים ביד + על הלוח — האם יוצרים סטרייט/צבע/פול האוס שלא זוהה?
   - סכומי הימור הגיוניים? (צ'יפים, לא שקלים)
   - "קריאה" = סכום ההימור, לא הקופה?
2. **התאמה למשחק ביתי**: בלוף גדול = לא תשובה נכונה (שחקנים קוראים). צ'ק-רייז מתוחכם = לא מתאים.
3. **nearMiss**: סמן תשובות שגויות שהיו נכונות בפוקר מקצועי
4. **עברית**: אין מונחים באנגלית, סכומים בצ'יפים
5. **שגיאות**: placeholder טקסט, קלפים כפולים, חזרה על הקלפים בטקסט
6. **3 אופציות בדיוק**: אם יש 2 או 4 — תקן ל-3 (A, B, C)
7. אם יריבים גנריים ואפשר להחליף בשמות אמיתיים מהמשחק — סמן כ-fixed

שאלות:
${JSON.stringify(batch.map(s => ({ poolId: s.poolId, yourCards: s.yourCards, situation: s.situation, options: s.options.map(o => ({ id: o.id, text: o.text, isCorrect: o.isCorrect, explanation: o.explanation, nearMiss: o.nearMiss })), categoryId: s.categoryId })))}

החזר JSON בלבד, מערך:
[{"poolId":"xxx","status":"ok"|"fixed"|"remove","issues":["בעיה"],"fixedScenario":{...כל השדות המתוקנים אם fixed},"nearMissFlags":["B"]}]

- "ok": תקין (עדיין הוסף nearMissFlags אם רלוונטי)
- "fixed": מחזיר fixedScenario מתוקן עם כל השדות (situation, yourCards, options עם id/text/isCorrect/explanation/nearMiss, category, categoryId, poolId)
- "remove": גרוע מדי

JSON בלבד, בלי markdown:`;

      try {
        const models = API_CONFIGS.map(c => c.model);
        let result: unknown[] | null = null;

        let lastError = '';
        for (const model of models) {
          try {
            const resp = await fetch(
              `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  contents: [{ parts: [{ text: prompt }] }],
                  generationConfig: { temperature: 0.1, maxOutputTokens: 8192 },
                }),
              }
            );
            if (!resp.ok) {
              const errBody = await resp.text().catch(() => '');
              const errMsg = errBody.includes('RESOURCE_EXHAUSTED') ? 'חריגה ממכסת API' :
                errBody.includes('INVALID_ARGUMENT') ? 'בקשה לא תקינה' :
                `HTTP ${resp.status}`;
              lastError = `${model}: ${errMsg}`;
              setReviewLog(prev => [...prev, `⚠️ ${model}: ${errMsg} — מנסה מודל הבא...`]);
              continue;
            }
            const data = await resp.json();
            const finishReason = data.candidates?.[0]?.finishReason;
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
            if (!text) {
              lastError = `${model}: תשובה ריקה (${finishReason || 'no content'})`;
              setReviewLog(prev => [...prev, `⚠️ ${lastError}`]);
              continue;
            }
            const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
            try {
              result = JSON.parse(cleaned);
            } catch (parseErr) {
              lastError = `${model}: JSON לא תקין — ${cleaned.slice(0, 80)}...`;
              setReviewLog(prev => [...prev, `⚠️ ${lastError}`]);
              continue;
            }
            break;
          } catch (fetchErr) {
            lastError = `${model}: ${fetchErr instanceof Error ? fetchErr.message : 'network error'}`;
            continue;
          }
        }

        if (!result || !Array.isArray(result)) {
          errors++;
          setReviewLog(prev => [...prev, `❌ אצווה ${b + 1}: כל המודלים נכשלו — ${lastError}`]);
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        for (const r of result) {
          const item = r as { poolId: string; status: string; issues?: string[]; fixedScenario?: PoolScenario; nearMissFlags?: string[] };
          const idx = updatedScenarios.findIndex(s => s.poolId === item.poolId);
          if (idx === -1) continue;

          const reviewStamp = new Date().toISOString();

          if (item.status === 'remove') {
            removed++;
            updatedScenarios.splice(idx, 1);
            setReviewLog(prev => [...prev, `🗑 ${item.poolId}: ${item.issues?.join(', ')}`]);
          } else if (item.status === 'fixed' && item.fixedScenario) {
            fixed++;
            const orig = updatedScenarios[idx];
            const f = item.fixedScenario as unknown as Record<string, unknown>;
            const mappedOpts = (f.options || f.o || orig.options) as Array<Record<string, unknown>>;
            updatedScenarios[idx] = {
              poolId: orig.poolId,
              situation: (f.situation || f.s || orig.situation) as string,
              yourCards: (f.yourCards || f.c || orig.yourCards) as string,
              options: mappedOpts.map((o: Record<string, unknown>) => ({
                id: (o.id || o.i || '') as string,
                text: (o.text || o.t || '') as string,
                isCorrect: typeof o.isCorrect === 'boolean' ? o.isCorrect : (typeof o.ok === 'boolean' ? o.ok : false),
                explanation: (o.explanation || o.e || '') as string,
                nearMiss: o.nearMiss ? true : undefined,
              })),
              category: (f.category || orig.category) as string,
              categoryId: (f.categoryId || orig.categoryId) as string,
              reviewedAt: reviewStamp,
            };
            setReviewLog(prev => [...prev, `✏️ ${item.poolId}: ${item.issues?.join(', ')}`]);
          } else {
            ok++;
            updatedScenarios[idx] = {
              ...updatedScenarios[idx],
              reviewedAt: reviewStamp,
              ...(item.nearMissFlags && item.nearMissFlags.length > 0 ? {
                options: updatedScenarios[idx].options.map(o => ({
                  ...o,
                  nearMiss: item.nearMissFlags!.includes(o.id) ? true : o.nearMiss,
                })),
              } : {}),
            };
          }
        }
        const batchOk = result.filter((r: unknown) => (r as {status:string}).status === 'ok').length;
        const batchFixed = result.filter((r: unknown) => (r as {status:string}).status === 'fixed').length;
        const batchRemoved = result.filter((r: unknown) => (r as {status:string}).status === 'remove').length;
        const batchMissing = batch.length - result.length;
        let batchSummary = `✓ אצווה ${b + 1}: ${batchOk} תקינות, ${batchFixed} תוקנו, ${batchRemoved} הוסרו`;
        if (batchMissing > 0) batchSummary += `, ${batchMissing} חסרות בתשובה`;
        setReviewLog(prev => [...prev, batchSummary]);
      } catch (err) {
        errors++;
        setReviewLog(prev => [...prev, `❌ אצווה ${b + 1}: ${err instanceof Error ? err.message : 'שגיאה לא צפויה'}`]);
      }

      if (b < totalBatches - 1) await new Promise(r => setTimeout(r, 5000));
    }

    // Save updated pool
    const newPool: TrainingPool = {
      generatedAt: new Date().toISOString(),
      totalScenarios: updatedScenarios.length,
      byCategory: {},
      scenarios: updatedScenarios,
    };
    updatedScenarios.forEach(s => {
      newPool.byCategory[s.categoryId] = (newPool.byCategory[s.categoryId] || 0) + 1;
    });

    try {
      const uploadResult = await uploadTrainingPool(newPool);
      if (uploadResult.success) {
        localStorage.setItem('training_pool_cached', JSON.stringify(newPool));
        localStorage.setItem('training_pool_generatedAt', newPool.generatedAt);
        setPool(newPool);
        setReviewMsg(`✅ סיום: ${ok} תקינות, ${fixed} תוקנו, ${removed} הוסרו, ${errors} שגיאות`);
      } else {
        setReviewMsg(`⚠️ ${ok} ok / ${fixed} fixed / ${removed} removed — שגיאת העלאה: ${uploadResult.message}`);
      }
    } catch {
      setReviewMsg(`⚠️ ${ok} ok / ${fixed} fixed / ${removed} removed — שגיאת העלאה`);
    }

    setReviewing(false);
  };

  // ── Generate AI insights ──
  const handleGenerateInsight = async (player: TrainingPlayerData) => {
    const apiKey = getGeminiApiKey();
    if (!apiKey) return;

    setGeneratingInsight(player.playerName);
    setGeneratingStep('מנתח נתונים...');
    setInsightMsg(null);

    const allPlayersData = answers?.players || [];
    const a = analyzePlayerTraining(player, allPlayersData);
    const dataBlock = formatAnalysisForPrompt(a, player.playerName);
    const gameSummary = getPlayerGameSummary(player.playerName);

    const playerStyle = PLAYER_STYLES[player.playerName] || 'לא ידוע';

    const wrongByCat: Record<string, string[]> = {};
    player.sessions.flatMap(s => s.results).filter(r => !r.correct && !r.nearMiss).slice(-40).forEach(r => {
      const cat = SCENARIO_CATEGORIES.find(c => c.id === r.categoryId);
      const catName = cat?.name || r.categoryId;
      if (!wrongByCat[catName]) wrongByCat[catName] = [];
      wrongByCat[catName].push(r.chosenId);
    });
    const mistakePatterns = Object.entries(wrongByCat)
      .filter(([, ids]) => ids.length >= 2)
      .map(([cat, ids]) => `${cat}: ${ids.length} טעויות`)
      .join(', ');

    try {
      // 1. Player-facing holistic coaching (stored on GitHub, visible to player)
      setGeneratingStep('1/3 — מייצר תובנות לשחקן...');
      const coachingPrompt = `אתה מאמן פוקר אישי של ${player.playerName} במשחק ביתי חברתי. כתוב סקירה אישית ומעשית — הוא קורא את זה בעצמו.
עברית בלבד.

═══ נתוני אימון ═══
${dataBlock}
${gameSummary ? `\n${gameSummary}` : ''}
${playerStyle ? `\nסגנון משחק ידוע: ${playerStyle}` : ''}

═══ הנחיות ═══
המטרה: טקסט אישי שמרגיש כמו מאמן שמכיר אותו, לא טיפים גנריים שמתאימים לכולם.

מבנה:
1. פתיחה אישית (2-3 משפטים): פנה ל${player.playerName} בשמו. ציין דירוג, מגמה, וה"סיפור" שלו.${gameSummary ? ` שלב תוצאות אמיתיות.` : ''}
2. חוזקות (2-3 משפטים): הנושאים הטובים ביותר, למה זה עוזר בשולחן.${gameSummary ? ` קשר להצלחה אמיתית.` : ''}
3. נקודות לשיפור (3-5 טיפים ממוספרים): שם נושא + עצה מעשית${gameSummary ? ` + קשר לתוצאות` : ''}.${a.consistentMistakeCats.length > 0 ? ` חולשות עקביות: ${a.consistentMistakeCats.join(', ')}` : ''}
4. סיכום מעודד (1-2 משפטים).

חוקים: אל תחזור על מספרים מהטבלה. כתוב כאילו מכיר אותו. הומור קל מותר. שלב נתונים טבעית. 12-18 שורות.`;

      const improvResult = await callGemini(apiKey, coachingPrompt);

      // 2. Admin-facing exploitation analysis (localStorage only, never synced)
      setGeneratingStep('2/3 — מייצר ניתוח ניצול...');
      const exploitPrompt = `נתח את ${player.playerName} ותן טקטיקות ניצול לשולחן. תמציתי וישיר — רק מה שאני צריך לדעת כשאני יושב מולו.

נתונים:
${dataBlock}
${gameSummary ? `\n${gameSummary}` : ''}
סגנון: ${playerStyle}
טעויות חוזרות: ${mistakePatterns || 'אין דפוס ברור'}

תן בפורמט הזה בדיוק:

🎯 סיכום ב-2 משפטים: מה הסיפור שלו — איפה חלש ומה זה אומר בשולחן

⚡ 4-5 טקטיקות ניצול (כל אחת שורה אחת):
מתי → מה לעשות → למה עובד

${a.consistentMistakeCats.length > 0 ? `🔴 חולשות שלא משתפרות: ${a.consistentMistakeCats.join(', ')}` : ''}
${gameSummary ? `💰 קשר ביצועים: קשר בין חולשות אימון לתוצאות אמיתיות בשורה אחת` : ''}

עברית, קצר, בלי הקדמות`;

      const exploitResult = await callGemini(apiKey, exploitPrompt);

      // 3. Save to GitHub + localStorage
      setGeneratingStep('3/3 — שומר...');
      const currentInsights = insights || { lastUpdated: '', insights: {} };
      currentInsights.insights[player.playerName] = {
        generatedAt: new Date().toISOString(),
        sessionsAtGeneration: player.sessions.length,
        improvement: improvResult,
      };
      currentInsights.lastUpdated = new Date().toISOString();
      await uploadTrainingInsights(currentInsights);
      setInsights({ ...currentInsights });

      const exploitData: TrainingExploitationLocal = {
        generatedAt: new Date().toISOString(),
        sessionsAtGeneration: player.sessions.length,
        text: exploitResult,
      };
      localStorage.setItem(`training_exploitation_${player.playerName}`, JSON.stringify(exploitData));

      setInsightMsg(`✅ תובנות נוצרו עבור ${player.playerName}`);
    } catch (err) {
      setInsightMsg(`שגיאה: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      setGeneratingInsight(null);
      setGeneratingStep(null);
    }
  };


  const callGemini = async (apiKey: string, prompt: string, maxTokens = 2048): Promise<string> => {
    for (const config of API_CONFIGS) {
      const modelPath = config.model.startsWith('models/') ? config.model : `models/${config.model}`;
      const url = `https://generativelanguage.googleapis.com/${config.version}/${modelPath}:generateContent?key=${apiKey}`;

      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.7, maxOutputTokens: maxTokens },
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
  const getFlaggedQuestions = (): { poolId: string; scenario: PoolScenario; flagCount: number; reports: TrainingFlagReport[] }[] => {
    if (!answers || !pool) return [];
    const poolIdSet = new Set(pool.scenarios.map(s => s.poolId));
    const flagCounts = new Map<string, number>();
    const reportsByPool = new Map<string, TrainingFlagReport[]>();

    answers.players.forEach(p => {
      p.sessions.forEach(s => {
        (s.flaggedPoolIds || []).forEach(id => {
          if (poolIdSet.has(id)) {
            flagCounts.set(id, (flagCounts.get(id) || 0) + 1);
          }
        });
        (s.flagReports || []).forEach(report => {
          if (poolIdSet.has(report.poolId)) {
            const existing = reportsByPool.get(report.poolId) || [];
            existing.push(report);
            reportsByPool.set(report.poolId, existing);
            if (!flagCounts.has(report.poolId)) {
              flagCounts.set(report.poolId, 1);
            }
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
        reports: reportsByPool.get(poolId) || [],
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
              <button onClick={() => handleSmartGenerate()} style={{
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
                maxHeight: '250px', overflowY: 'auto', fontSize: '0.7rem',
                display: 'flex', flexDirection: 'column', gap: '2px',
              }}>
                {genLog.map((entry, idx) => (
                  <div key={idx} style={{
                    padding: '0.2rem 0.3rem', borderRadius: '4px',
                    background: entry.status === 'fail' || entry.status === 'key_error' ? 'rgba(239,68,68,0.08)' :
                               entry.status === 'partial' ? 'rgba(249,115,22,0.08)' :
                               entry.status === 'skip' ? 'rgba(107,114,128,0.08)' :
                               'rgba(34,197,94,0.08)',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                      <span>{entry.icon}</span>
                      <span style={{ flex: 1 }}>{entry.cat}</span>
                      {entry.elapsed != null && entry.status !== 'skip' && (
                        <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                          {Math.round(entry.elapsed / 1000)}s
                        </span>
                      )}
                      <span style={{
                        fontWeight: 600,
                        color: entry.status === 'fail' || entry.status === 'key_error' ? 'var(--danger)' :
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
                    {entry.error && (
                      <div style={{ fontSize: '0.6rem', color: entry.status === 'fail' || entry.status === 'key_error' ? '#ef4444' : '#f97316', paddingRight: '1.2rem', marginTop: '0.1rem' }}>
                        {entry.error}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : reviewing ? (
          <div style={{ padding: '0.5rem 0' }}>
            <div style={{
              padding: '0.6rem 0.75rem', borderRadius: '8px', marginBottom: '0.5rem',
              background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.3rem' }}>
                <span style={{ fontWeight: 600, fontSize: '0.8rem' }}>🔍 סריקת שאלות</span>
                <span style={{ fontSize: '0.75rem', color: '#f59e0b', fontWeight: 700 }}>
                  {reviewProgress.current}/{reviewProgress.total}
                </span>
              </div>
              <div style={{ height: '6px', borderRadius: '3px', background: 'var(--surface-light)', overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: '3px', background: 'linear-gradient(90deg, #f59e0b, #ef4444)',
                  width: `${(reviewProgress.current / Math.max(reviewProgress.total, 1)) * 100}%`,
                  transition: 'width 0.5s ease',
                }} />
              </div>
              {reviewMsg && <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.3rem' }}>{reviewMsg}</div>}
            </div>
            {reviewLog.length > 0 && (
              <div style={{ maxHeight: '200px', overflowY: 'auto', fontSize: '0.65rem', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {reviewLog.map((entry, idx) => (
                  <div key={idx} style={{ padding: '0.15rem 0.3rem', borderRadius: '4px', background: entry.startsWith('❌') ? 'rgba(239,68,68,0.08)' : entry.startsWith('✏️') ? 'rgba(245,158,11,0.08)' : entry.startsWith('🗑') ? 'rgba(239,68,68,0.06)' : 'rgba(34,197,94,0.06)' }}>
                    {entry}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {/* Smart generate button + status */}
            {poolStatus.status === 'healthy' ? (
              <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                <div style={{
                  flex: 1, padding: '0.5rem 0.75rem', borderRadius: '10px',
                  border: '1px solid rgba(34,197,94,0.3)', background: 'rgba(34,197,94,0.06)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem',
                }}>
                  <span style={{ color: '#22c55e', fontWeight: 600, fontSize: '0.8rem' }}>✅ {poolStatus.label}</span>
                </div>
                <button onClick={() => handleSmartGenerate(true)} style={{
                  padding: '0.5rem 0.75rem', borderRadius: '10px', border: 'none',
                  background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
                  color: 'white', fontWeight: 600, fontSize: '0.75rem', cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}>
                  ➕ הוסף שאלות
                </button>
              </div>
            ) : (
              <div>
                <button onClick={() => handleSmartGenerate()} style={{
                  width: '100%', padding: '0.6rem', borderRadius: '10px', border: 'none',
                  background: poolStatus.status === 'empty'
                    ? 'linear-gradient(135deg, #6366f1, #8b5cf6)'
                    : 'linear-gradient(135deg, #f59e0b, #f97316)',
                  color: 'white', fontWeight: 600, fontSize: '0.8rem', cursor: 'pointer',
                }}>
                  {poolStatus.status === 'empty' ? '✨ צור מאגר חדש' : '⚡ השלם מאגר'}
                </button>
                <div style={{
                  marginTop: '0.3rem', fontSize: '0.7rem', color: 'var(--text-muted)', textAlign: 'center',
                }}>
                  {poolStatus.label}
                </div>
              </div>
            )}
            {pool && pool.totalScenarios > 0 && (() => {
              const unreviewed = pool.scenarios.filter(s => !s.reviewedAt).length;
              return unreviewed > 0 ? (
              <button onClick={handleReviewPool} style={{
                padding: '0.5rem', borderRadius: '10px', border: '1px solid rgba(245,158,11,0.3)',
                background: 'rgba(245,158,11,0.06)', color: '#f59e0b',
                fontWeight: 600, fontSize: '0.75rem', cursor: 'pointer',
              }}>
                🔍 סרוק ותקן {unreviewed} שאלות חדשות
              </button>
              ) : (
              <div style={{
                padding: '0.5rem', borderRadius: '10px', border: '1px solid rgba(34,197,94,0.3)',
                background: 'rgba(34,197,94,0.06)', color: '#22c55e',
                fontWeight: 600, fontSize: '0.75rem', textAlign: 'center',
              }}>
                ✅ כל {pool.totalScenarios} השאלות נסרקו
              </div>
              );
            })()}
            {reviewMsg && !reviewing && (
              <div style={{
                fontSize: '0.8rem', textAlign: 'center', fontWeight: 500, padding: '0.5rem', borderRadius: '8px',
                background: reviewMsg.includes('❌') ? 'rgba(239,68,68,0.08)' : 'rgba(34,197,94,0.08)',
                color: reviewMsg.includes('❌') ? 'var(--danger)' : 'var(--success)',
              }}>
                {reviewMsg}
              </div>
            )}
            {!reviewing && reviewLog.length > 0 && (
              <details>
                <summary style={{ fontSize: '0.7rem', color: 'var(--text-muted)', cursor: 'pointer' }}>
                  פירוט סריקה ({reviewLog.filter(l => l.startsWith('✏️')).length} תוקנו, {reviewLog.filter(l => l.startsWith('🗑')).length} הוסרו)
                </summary>
                <div style={{ maxHeight: '200px', overflowY: 'auto', marginTop: '0.3rem', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  {reviewLog.filter(l => !l.startsWith('✓')).map((entry, idx) => (
                    <div key={idx} style={{ padding: '0.15rem 0.3rem', borderRadius: '4px', fontSize: '0.65rem', background: entry.startsWith('❌') ? 'rgba(239,68,68,0.08)' : 'rgba(245,158,11,0.08)' }}>
                      {entry}
                    </div>
                  ))}
                </div>
              </details>
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

        {/* Post-generation log summary — auto-open when failures exist */}
        {!generating && genLog.length > 0 && (() => {
          const failCount = genLog.filter(l => l.status === 'fail' || l.status === 'key_error').length;
          const okCount = genLog.filter(l => l.status === 'ok').length;
          const partialCount = genLog.filter(l => l.status === 'partial').length;
          return (
            <details open={failCount > 0} style={{ marginTop: '0.4rem' }}>
              <summary style={{ fontSize: '0.7rem', color: failCount > 0 ? '#ef4444' : 'var(--text-muted)', cursor: 'pointer', fontWeight: failCount > 0 ? 600 : 400 }}>
                פירוט ייצור ({okCount} הצליחו{partialCount > 0 ? ` / ${partialCount} חלקי` : ''}{failCount > 0 ? ` / ${failCount} נכשלו` : ''})
              </summary>
              <div style={{ maxHeight: '250px', overflowY: 'auto', marginTop: '0.3rem', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                {genLog.filter(l => l.status !== 'skip').map((entry, idx) => (
                  <div key={idx} style={{
                    padding: '0.2rem 0.3rem', borderRadius: '4px', fontSize: '0.7rem',
                    background: entry.status === 'fail' || entry.status === 'key_error' ? 'rgba(239,68,68,0.08)' :
                               entry.status === 'partial' ? 'rgba(249,115,22,0.08)' :
                               'rgba(34,197,94,0.08)',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                      <span>{entry.icon}</span>
                      <span style={{ flex: 1 }}>{entry.cat}</span>
                      {entry.elapsed != null && (
                        <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                          {Math.round(entry.elapsed / 1000)}s
                        </span>
                      )}
                      <span style={{
                        fontWeight: 600,
                        color: entry.status === 'fail' || entry.status === 'key_error' ? 'var(--danger)' :
                               entry.status === 'partial' ? '#f97316' :
                               'var(--success)',
                      }}>
                        {entry.status === 'ok' ? `✓ ${entry.count}` :
                         entry.status === 'partial' ? `⚠ ${entry.count}` :
                         entry.status === 'key_error' ? '🔑 שגיאה' :
                         '✗ נכשל'}
                      </span>
                    </div>
                    {entry.error && (
                      <div style={{ fontSize: '0.6rem', color: entry.status === 'fail' || entry.status === 'key_error' ? '#ef4444' : '#f97316', paddingRight: '1.2rem', marginTop: '0.1rem' }}>
                        {entry.error}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </details>
          );
        })()}

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
              const displayName = player.playerName;
              const isExpanded = expandedPlayer === player.playerName;
              const exploit = getExploitLocal(player.playerName);
              const insight = insights?.insights?.[player.playerName];
              const sessionsSinceInsight = insight ? player.sessions.length - insight.sessionsAtGeneration : -1;
              const staleness = !insight ? '#64748b' : sessionsSinceInsight <= 2 ? '#22c55e' : sessionsSinceInsight <= 5 ? '#eab308' : '#ef4444';
              const stalenessLabel = !insight ? 'אין תובנות' : sessionsSinceInsight <= 2 ? 'תובנות עדכניות' : sessionsSinceInsight <= 5 ? `${sessionsSinceInsight} אימונים מאז תובנות` : `${sessionsSinceInsight} אימונים מאז תובנות — לעדכן`;
              const allResultsCount = player.sessions.reduce((sum, s) => sum + s.results.length, 0);

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
                      <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{displayName}</span>
                      <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: staleness }} title={stalenessLabel} />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem' }}>
                      <span style={{ color: 'var(--text-muted)' }}>{allResultsCount}Q</span>
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
                          <div style={{ fontSize: '1rem', fontWeight: 700 }}>{allResultsCount}</div>
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
                          const results = player.sessions.flatMap(s => s.results.filter(r => r.categoryId === cat.id && !r.nearMiss));
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
                                {weakest.map(c => `${c.icon} ${c.name} (${c.accuracy.toFixed(0)}%, ${c.total}ש)`).join(', ')}
                              </div>
                            )}
                            {strongest.length > 0 && (
                              <div>
                                <span style={{ color: '#22c55e', fontWeight: 600 }}>חזק: </span>
                                {strongest.map(c => `${c.icon} ${c.name} (${c.accuracy.toFixed(0)}%, ${c.total}ש)`).join(', ')}
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

                      {/* Action button */}
                      <button
                        onClick={() => handleGenerateInsight(player)}
                        disabled={generatingInsight === player.playerName}
                        style={{
                          width: '100%', padding: '0.5rem', borderRadius: '8px', border: 'none',
                          background: generatingInsight === player.playerName ? 'var(--surface-light)' : 'linear-gradient(135deg, #a855f7, #7c3aed)',
                          color: generatingInsight === player.playerName ? 'var(--text-muted)' : 'white',
                          fontWeight: 600, fontSize: '0.75rem', cursor: 'pointer',
                        }}
                      >
                        {generatingInsight === player.playerName
                          ? `⏳ ${generatingStep || 'מייצר...'}`
                          : `✨ ${insight ? 'עדכן' : 'צור'} תובנות אישיות`}
                        {generatingInsight !== player.playerName && sessionsSinceInsight > 0 && insight && (
                          <span style={{ fontSize: '0.6rem', opacity: 0.8, marginRight: '0.3rem' }}>
                            ({sessionsSinceInsight} חדשים)
                          </span>
                        )}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginTop: '0.5rem', direction: 'rtl', lineHeight: 1.6 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#64748b', display: 'inline-block' }} /> אין תובנות
              </span>
              {' · '}
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} /> עדכניות
              </span>
              {' · '}
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#eab308', display: 'inline-block' }} /> מיושנות
              </span>
              {' · '}
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.2rem' }}>
                <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} /> לעדכן
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Flagged Questions */}
      {flagged.length > 0 && (
        <div className="card" style={{ padding: '1rem', marginBottom: '0.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <h3 style={{ fontSize: '0.9rem', fontWeight: 700, margin: 0 }}>🚩 שאלות שדווחו ({flagged.length})</h3>
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

          {flagged.map(f => {
            const cat = SCENARIO_CATEGORIES.find(c => c.id === f.scenario?.categoryId);
            const correctOpt = f.scenario?.options?.find(o => o.isCorrect);
            const isBusy = dismissingFlagged === f.poolId || fixingFlagged === f.poolId || removingFlagged || analyzingReport === f.poolId;
            const reasonLabels: Record<string, string> = {
              wrong_answer: '❌ תשובה שגויה',
              unclear_question: '❓ שאלה לא ברורה',
              wrong_for_home_game: '🏠 לא מתאים למשחק ביתי',
              other: '💬 אחר',
            };

            return (
              <div key={f.poolId} style={{
                padding: '0.6rem', borderRadius: '8px', marginBottom: '0.5rem',
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
                {f.scenario?.yourCards && (
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '0.2rem' }}>
                    קלפים: {f.scenario.yourCards}
                  </div>
                )}
                {correctOpt && (
                  <div style={{ fontSize: '0.65rem', color: 'var(--success)', marginBottom: '0.3rem' }}>
                    ✓ תשובה נכונה: {correctOpt.text}
                  </div>
                )}

                {/* Reports from players */}
                {f.reports.length > 0 && (
                  <div style={{
                    marginTop: '0.3rem', marginBottom: '0.4rem', padding: '0.4rem',
                    borderRadius: '6px', background: 'rgba(245,158,11,0.06)',
                    border: '1px solid rgba(245,158,11,0.15)',
                  }}>
                    <div style={{ fontSize: '0.6rem', color: '#f59e0b', fontWeight: 600, marginBottom: '0.25rem' }}>
                      דיווחים:
                    </div>
                    {f.reports.map((report, ri) => (
                      <div key={ri} style={{
                        fontSize: '0.65rem', color: 'var(--text-muted)', lineHeight: 1.6,
                        paddingBottom: ri < f.reports.length - 1 ? '0.2rem' : 0,
                        borderBottom: ri < f.reports.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none',
                        marginBottom: ri < f.reports.length - 1 ? '0.2rem' : 0,
                      }}>
                        <span style={{ fontWeight: 600, color: 'var(--text)' }}>{report.playerName}</span>
                        {' — '}
                        <span>{reasonLabels[report.reason] || report.reason}</span>
                        {report.comment && (
                          <div style={{
                            marginTop: '0.15rem', fontStyle: 'italic', color: 'var(--text-muted)',
                            paddingRight: '0.5rem',
                          }}>
                            "{report.comment}"
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* AI Analysis */}
                {analyses[f.poolId] && (
                  <div style={{
                    marginBottom: '0.4rem', padding: '0.4rem',
                    borderRadius: '6px',
                    background: analyses[f.poolId].verdict === 'accept' ? 'rgba(239,68,68,0.06)' :
                      analyses[f.poolId].verdict === 'reject' ? 'rgba(34,197,94,0.06)' :
                      analyses[f.poolId].verdict === 'partial' ? 'rgba(245,158,11,0.06)' : 'rgba(99,102,241,0.06)',
                    border: `1px solid ${analyses[f.poolId].verdict === 'accept' ? 'rgba(239,68,68,0.15)' :
                      analyses[f.poolId].verdict === 'reject' ? 'rgba(34,197,94,0.15)' :
                      'rgba(245,158,11,0.15)'}`,
                  }}>
                    <div style={{ fontSize: '0.6rem', fontWeight: 600, marginBottom: '0.2rem', color:
                      analyses[f.poolId].verdict === 'accept' ? '#ef4444' :
                      analyses[f.poolId].verdict === 'reject' ? '#22c55e' :
                      analyses[f.poolId].verdict === 'partial' ? '#f59e0b' : 'var(--text-muted)',
                    }}>
                      {analyses[f.poolId].verdict === 'accept' ? '⚠️ הדיווח מוצדק — צריך תיקון' :
                       analyses[f.poolId].verdict === 'reject' ? '✅ השאלה תקינה — אפשר לדחות' :
                       analyses[f.poolId].verdict === 'partial' ? '⚡ מוצדק חלקית' : '❌ שגיאה'}
                    </div>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text)', lineHeight: 1.5 }}>
                      {analyses[f.poolId].explanation}
                    </div>
                    {(() => {
                      const a = analyses[f.poolId];
                      const shareText = a.verdict === 'accept' ? a.acceptText :
                        a.verdict === 'reject' ? a.rejectText :
                        a.acceptText || a.rejectText;
                      if (!shareText) return null;
                      const correctOpt2 = f.scenario?.options?.find(o => o.isCorrect);
                      const reporterName = f.reports[0]?.playerName || '';
                      const reporterComment = f.reports[0]?.comment || '';
                      const questionContext = [
                        f.scenario?.yourCards ? `🃏 קלפים: ${f.scenario.yourCards}` : '',
                        f.scenario?.situation ? `📋 ${f.scenario.situation}` : '',
                        correctOpt2 ? `✅ תשובה: ${correctOpt2.text}` : '',
                      ].filter(Boolean).join('\n');
                      const reportContext = reporterComment ? `\n💬 דיווחת: "${reporterComment}"` : '';
                      const fullWhatsApp = `היי ${reporterName}! 🎯\n\nלגבי הדיווח שלך על שאלת אימון:\n\n${questionContext}${reportContext}\n\n${shareText}\n\n— Poker Manager 🃏`;
                      return (
                        <div style={{
                          marginTop: '0.3rem', paddingTop: '0.3rem',
                          borderTop: '1px solid rgba(255,255,255,0.05)',
                        }}>
                          <div style={{ fontSize: '0.6rem', fontWeight: 600, marginBottom: '0.15rem', color: 'var(--text-muted)' }}>
                            {a.verdict === 'accept' ? '💬 הודעה למדווח (תודה + תוקן):' :
                             a.verdict === 'reject' ? '💬 הודעה למדווח (הסבר):' :
                             '💬 הודעה למדווח:'}
                          </div>
                          <div style={{ fontSize: '0.65rem', color: 'var(--text)', padding: '0.3rem',
                            borderRadius: '4px', background: 'rgba(255,255,255,0.03)',
                            lineHeight: 1.5, marginBottom: '0.3rem', whiteSpace: 'pre-line',
                          }}>
                            {fullWhatsApp}
                          </div>
                          <button
                            onClick={() => shareToWhatsApp(fullWhatsApp)}
                            style={{
                              fontSize: '0.65rem', padding: '0.3rem 0.6rem', borderRadius: '6px',
                              background: '#25D366', color: 'white', border: 'none',
                              cursor: 'pointer', fontWeight: 600, width: '100%',
                            }}
                          >
                            📤 שלח בוואטסאפ
                          </button>
                        </div>
                      );
                    })()}

                    {/* Chat to refine analysis */}
                    <div style={{ marginTop: '0.3rem', display: 'flex', gap: '0.25rem' }}>
                      <input
                        type="text"
                        value={analysisFeedback[f.poolId] || ''}
                        onChange={e => setAnalysisFeedback(prev => ({ ...prev, [f.poolId]: e.target.value }))}
                        onKeyDown={e => { if (e.key === 'Enter' && analysisFeedback[f.poolId]?.trim()) handleRefineAnalysis(f.poolId, f.scenario, f.reports); }}
                        placeholder="הערה לשיפור הניתוח..."
                        style={{
                          flex: 1, fontSize: '0.65rem', padding: '0.3rem 0.4rem',
                          borderRadius: '6px', border: '1px solid var(--border)',
                          background: 'var(--surface)', color: 'var(--text)',
                          direction: 'rtl',
                        }}
                      />
                      <button
                        onClick={() => handleRefineAnalysis(f.poolId, f.scenario, f.reports)}
                        disabled={!analysisFeedback[f.poolId]?.trim() || refiningAnalysis === f.poolId}
                        style={{
                          fontSize: '0.65rem', padding: '0.3rem 0.5rem', borderRadius: '6px',
                          background: 'rgba(99,102,241,0.1)', color: '#6366f1',
                          border: '1px solid rgba(99,102,241,0.2)',
                          cursor: !analysisFeedback[f.poolId]?.trim() ? 'default' : 'pointer',
                          fontWeight: 500, opacity: !analysisFeedback[f.poolId]?.trim() ? 0.4 : 1,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {refiningAnalysis === f.poolId ? '⏳' : '💬 שלח'}
                      </button>
                    </div>

                    {/* Action buttons inside analysis card */}
                    <div style={{ marginTop: '0.4rem', paddingTop: '0.4rem', borderTop: '1px solid rgba(255,255,255,0.05)', display: 'flex', gap: '0.3rem', flexWrap: 'wrap' }}>
                      {(analyses[f.poolId].verdict === 'accept' || analyses[f.poolId].verdict === 'partial') && (
                        <button
                          onClick={() => handleAIFix(f.poolId, f.reports)}
                          disabled={isBusy}
                          style={{
                            flex: 1, fontSize: '0.65rem', padding: '0.35rem 0.5rem', borderRadius: '6px',
                            background: 'rgba(168,85,247,0.1)', color: '#a855f7',
                            border: '1px solid rgba(168,85,247,0.2)', cursor: isBusy ? 'wait' : 'pointer',
                            fontWeight: 600, opacity: isBusy ? 0.5 : 1,
                          }}
                        >
                          {fixingFlagged === f.poolId ? '⏳ מתקן...' : '✨ תקן עם AI'}
                        </button>
                      )}
                      {(analyses[f.poolId].verdict === 'reject' || analyses[f.poolId].verdict === 'partial') && (
                        <button
                          onClick={() => handleDismissFlagged(f.poolId)}
                          disabled={isBusy}
                          style={{
                            flex: 1, fontSize: '0.65rem', padding: '0.35rem 0.5rem', borderRadius: '6px',
                            background: 'var(--surface)', color: 'var(--text-muted)',
                            border: '1px solid var(--border)', cursor: isBusy ? 'wait' : 'pointer',
                            fontWeight: 500, opacity: isBusy ? 0.5 : 1,
                          }}
                        >
                          {dismissingFlagged === f.poolId ? '⏳' : '✓ דחה דיווח'}
                        </button>
                      )}
                      <button
                        onClick={() => handleRemoveFlagged([f.poolId])}
                        disabled={isBusy}
                        style={{
                          fontSize: '0.65rem', padding: '0.35rem 0.5rem', borderRadius: '6px',
                          background: 'rgba(239,68,68,0.08)', color: '#ef4444',
                          border: '1px solid rgba(239,68,68,0.15)', cursor: isBusy ? 'wait' : 'pointer',
                          fontWeight: 500, opacity: isBusy ? 0.5 : 1,
                        }}
                      >
                        {removingFlagged ? '⏳' : '🗑 הסר שאלה'}
                      </button>
                    </div>
                  </div>
                )}

                {/* Action buttons — before analysis: analyze is primary, dismiss + remove as quick actions */}
                {!analyses[f.poolId] && (
                  <div style={{ display: 'flex', gap: '0.3rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                    <button
                      onClick={() => handleAnalyzeReport(f.poolId, f.scenario, f.reports)}
                      disabled={isBusy || analyzingReport === f.poolId}
                      style={{
                        flex: 1, fontSize: '0.65rem', padding: '0.35rem 0.5rem', borderRadius: '6px',
                        background: 'rgba(99,102,241,0.15)', color: '#6366f1',
                        border: '1px solid rgba(99,102,241,0.3)', cursor: isBusy ? 'wait' : 'pointer',
                        fontWeight: 600, opacity: isBusy ? 0.5 : 1,
                      }}
                    >
                      {analyzingReport === f.poolId ? '⏳ מנתח...' : '🔍 נתח עם AI'}
                    </button>
                    <button
                      onClick={() => handleDismissFlagged(f.poolId)}
                      disabled={isBusy}
                      style={{
                        fontSize: '0.65rem', padding: '0.35rem 0.5rem', borderRadius: '6px',
                        background: 'var(--surface)', color: 'var(--text-muted)',
                        border: '1px solid var(--border)', cursor: isBusy ? 'wait' : 'pointer',
                        fontWeight: 500, opacity: isBusy ? 0.5 : 1,
                      }}
                    >
                      {dismissingFlagged === f.poolId ? '⏳' : '✓ דחה'}
                    </button>
                    <button
                      onClick={() => handleRemoveFlagged([f.poolId])}
                      disabled={isBusy}
                      style={{
                        fontSize: '0.65rem', padding: '0.35rem 0.5rem', borderRadius: '6px',
                        background: 'rgba(239,68,68,0.08)', color: '#ef4444',
                        border: '1px solid rgba(239,68,68,0.15)', cursor: isBusy ? 'wait' : 'pointer',
                        fontWeight: 500, opacity: isBusy ? 0.5 : 1,
                      }}
                    >
                      {removingFlagged ? '⏳' : '🗑 הסר'}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* AI Fix Preview */}
      {fixPreview && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 999,
          background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '1rem',
        }}>
          <div style={{
            background: 'var(--surface)', borderRadius: '12px', padding: '1rem',
            maxWidth: '95vw', maxHeight: '85vh', overflowY: 'auto', direction: 'rtl',
            border: '1px solid var(--border)', width: '500px',
          }}>
            <div style={{ fontWeight: 700, fontSize: '0.9rem', marginBottom: '0.75rem', textAlign: 'center' }}>
              ✨ תצוגה מקדימה — תיקון AI
            </div>

            {/* Original */}
            <div style={{
              padding: '0.5rem', borderRadius: '8px', marginBottom: '0.5rem',
              background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)',
            }}>
              <div style={{ fontSize: '0.65rem', color: '#ef4444', fontWeight: 600, marginBottom: '0.3rem' }}>מקור:</div>
              <div style={{ fontSize: '0.75rem', lineHeight: 1.5, marginBottom: '0.2rem' }}>{fixPreview.original.situation}</div>
              <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '0.2rem' }}>קלפים: {fixPreview.original.yourCards}</div>
              {fixPreview.original.options.map(o => (
                <div key={o.id} style={{
                  fontSize: '0.65rem', padding: '0.15rem 0.3rem', marginBottom: '0.1rem',
                  color: o.isCorrect ? '#22c55e' : o.nearMiss ? '#f59e0b' : 'var(--text-muted)',
                }}>
                  {o.id}. {o.text} {o.isCorrect ? '✓' : o.nearMiss ? '~' : ''}
                </div>
              ))}
            </div>

            {/* Fixed */}
            <div style={{
              padding: '0.5rem', borderRadius: '8px', marginBottom: '0.75rem',
              background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.15)',
            }}>
              <div style={{ fontSize: '0.65rem', color: '#22c55e', fontWeight: 600, marginBottom: '0.3rem' }}>תיקון:</div>
              <div style={{ fontSize: '0.75rem', lineHeight: 1.5, marginBottom: '0.2rem' }}>{fixPreview.fixed.situation}</div>
              <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '0.2rem' }}>קלפים: {fixPreview.fixed.yourCards}</div>
              {fixPreview.fixed.options.map(o => (
                <div key={o.id} style={{ marginBottom: '0.25rem' }}>
                  <div style={{
                    fontSize: '0.7rem', padding: '0.15rem 0.3rem',
                    fontWeight: o.isCorrect ? 600 : 400,
                    color: o.isCorrect ? '#22c55e' : o.nearMiss ? '#f59e0b' : 'var(--text)',
                  }}>
                    {o.id}. {o.text} {o.isCorrect ? '✓' : o.nearMiss ? '~' : ''}
                  </div>
                  {o.explanation && (
                    <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', paddingRight: '1rem', lineHeight: 1.4 }}>
                      {o.explanation}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Iterative tuning */}
            <div style={{
              display: 'flex', gap: '0.3rem', marginBottom: '0.5rem',
              alignItems: 'center',
            }}>
              <input
                type="text"
                value={fixFeedback}
                onChange={e => setFixFeedback(e.target.value)}
                placeholder="הערות לשיפור..."
                disabled={regenerating || savingFix}
                style={{
                  flex: 1, padding: '0.4rem 0.6rem', borderRadius: '8px',
                  border: '1px solid var(--border)', background: 'var(--background)',
                  color: 'var(--text)', fontSize: '0.75rem', direction: 'rtl',
                }}
                onKeyDown={e => { if (e.key === 'Enter' && fixFeedback.trim()) handleRegenerateFix(); }}
              />
              <button
                onClick={handleRegenerateFix}
                disabled={!fixFeedback.trim() || regenerating || savingFix}
                style={{
                  padding: '0.4rem 0.8rem', borderRadius: '8px', border: 'none',
                  background: fixFeedback.trim() ? '#a855f7' : 'var(--surface)',
                  color: fixFeedback.trim() ? 'white' : 'var(--text-muted)',
                  fontWeight: 600, fontSize: '0.7rem', cursor: regenerating ? 'wait' : 'pointer',
                  whiteSpace: 'nowrap', opacity: regenerating ? 0.6 : 1,
                }}
              >
                {regenerating ? '⏳' : '🔄 שלח שוב'}
              </button>
            </div>
            {fixHistory.length > 0 && (
              <div style={{ fontSize: '0.6rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
                שיפורים קודמים: {fixHistory.length}
              </div>
            )}

            {/* Actions */}
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center' }}>
              <button
                onClick={confirmAIFix}
                disabled={savingFix || regenerating}
                style={{
                  padding: '0.5rem 1.5rem', borderRadius: '8px', border: 'none',
                  background: '#22c55e', color: 'white', fontWeight: 700,
                  fontSize: '0.85rem', cursor: savingFix ? 'wait' : 'pointer',
                  opacity: savingFix || regenerating ? 0.6 : 1,
                }}
              >
                {savingFix ? '⏳ שומר...' : '✓ אשר תיקון'}
              </button>
              <button
                onClick={() => setFixPreview(null)}
                disabled={savingFix}
                style={{
                  padding: '0.5rem 1.5rem', borderRadius: '8px',
                  border: '1px solid var(--border)', background: 'var(--surface)',
                  color: 'var(--text-muted)', fontWeight: 600,
                  fontSize: '0.85rem', cursor: 'pointer',
                }}
              >
                ✗ דחה
              </button>
            </div>
          </div>
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
