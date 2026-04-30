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
} from '../database/trainingData';
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh';
import {
  SCENARIO_CATEGORIES,
  generatePoolBatch,
  normalizeTrainingPlayers,
  GAME_CONTEXT,
  TRAINING_SCENARIO_FIX_FORMAT_RULES,
  PLAYER_STYLES,
  analyzePlayerTraining,
  formatAnalysisForPrompt,
  getPlayerGameSummary,
  resetSharedTrainingProgress,
  clearPendingUploadsForPlayer,
  updatePoolCache,
} from '../utils/pokerTraining';
import { getGeminiApiKey, runGeminiTextPrompt } from '../utils/geminiAI';
import { proxyGeminiGenerate } from '../utils/apiProxy';
import { notifyReportersOfResolution, type AiResolutionText } from '../utils/trainingReportNotifications';
import { LEGACY_NAME_CORRECTIONS } from '../App';

const RATE_LIMIT_DELAY = 7500;

async function shareAnalysisAsImage(messageText: string): Promise<void> {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const lines = messageText.split('\n');

  let greeting = '';
  const contextLines: string[] = [];
  const bodyLines: string[] = [];
  let section: 'greeting' | 'context' | 'body' = 'greeting';

  for (const line of lines) {
    const trimmed = line.trim();
    if (section === 'greeting') {
      if (trimmed.startsWith('היי') || trimmed.startsWith('לגבי')) {
        greeting += (greeting ? '<br>' : '') + esc(trimmed);
      } else if (trimmed.startsWith('🃏') || trimmed.startsWith('🂠') || trimmed.startsWith('📋') || trimmed.startsWith('✅') || trimmed.startsWith('💬')) {
        section = 'context';
        contextLines.push(trimmed);
      } else if (trimmed === '') {
        continue;
      } else {
        section = 'body';
        bodyLines.push(trimmed);
      }
    } else if (section === 'context') {
      if (trimmed.startsWith('🃏') || trimmed.startsWith('🂠') || trimmed.startsWith('📋') || trimmed.startsWith('✅') || trimmed.startsWith('💬')) {
        contextLines.push(trimmed);
      } else if (trimmed === '') {
        section = 'body';
      } else {
        section = 'body';
        bodyLines.push(trimmed);
      }
    } else {
      if (trimmed === '— Poker Manager 🃏' || trimmed === '') continue;
      bodyLines.push(trimmed);
    }
  }

  const contextHtml = contextLines.map(l => {
    const escaped = esc(l);
    const emoji = l.substring(0, 2);
    const rest = escaped.substring(escaped.indexOf(' ') + 1);
    return `<div style="display:flex;align-items:flex-start;gap:0.4rem;margin-bottom:0.35rem;">
      <span style="flex-shrink:0;font-size:1rem;">${emoji}</span>
      <span>${rest}</span>
    </div>`;
  }).join('');

  const container = document.createElement('div');
  container.style.cssText = `
    position: fixed; left: -9999px; top: 0; width: 380px;
    background: #0f172a; font-family: Outfit, sans-serif; direction: rtl;
  `;
  container.innerHTML = `
    <div style="padding: 1.25rem 1.25rem 1rem;">
      <div style="font-size: 1.05rem; font-weight: 700; color: #f8fafc; margin-bottom: 0.15rem;">${greeting}</div>
    </div>
    <div style="margin: 0 1.25rem; padding: 0.75rem; background: #1e293b; border-radius: 10px; border-right: 3px solid #6366f1; font-size: 0.82rem; color: #e2e8f0; line-height: 1.6;">
      ${contextHtml}
    </div>
    <div style="padding: 1rem 1.25rem; font-size: 0.88rem; color: #f8fafc; line-height: 1.75; word-break: break-word;">
      ${bodyLines.map(l => `<p style="margin:0 0 0.5rem;">${esc(l)}</p>`).join('')}
    </div>
    <div style="text-align: center; padding: 0.5rem 1.25rem 1rem; font-size: 0.6rem; color: #475569;">Poker Manager 🎲</div>
  `;
  document.body.appendChild(container);

  try {
    const { default: html2canvas } = await import('html2canvas');
    const canvas = await html2canvas(container, {
      backgroundColor: '#0f172a', scale: 2, logging: false, useCORS: true,
    });
    const blob = await new Promise<Blob>(resolve => canvas.toBlob(b => resolve(b!), 'image/png', 1.0));
    const file = new File([blob], 'training-analysis.png', { type: 'image/png' });

    if (navigator.share && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
    } else {
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url; a.download = file.name; a.click();
      URL.revokeObjectURL(url);
    }
  } finally {
    document.body.removeChild(container);
  }
}

/** קלפים בצבעי חליפה (כמו במסכי אימון) — לתצוגה בניהול */
const TrainingColoredCards = ({ text }: { text: string }) => {
  const parts = text.split(/(\S+)/g);
  return (
    <span style={{ direction: 'ltr', unicodeBidi: 'isolate' as const }}>
      {parts.map((part, i) => {
        const hasRed = part.includes('\u2665') || part.includes('\u2666');
        const hasSuit = hasRed || part.includes('\u2660') || part.includes('\u2663');
        if (!hasSuit) return <span key={i}>{part}</span>;
        return (
          <span key={i} style={{ color: hasRed ? '#ef4444' : '#e2e8f0', fontWeight: 700 }}>
            {part}
          </span>
        );
      })}
    </span>
  );
};


/** Insights JSON keys may not match `playerName` after renames; merge legacy aliases. */
const trainingInsightAliasNames = (canonicalName: string): string[] => {
  const keys = [canonicalName];
  for (const [oldName, newName] of Object.entries(LEGACY_NAME_CORRECTIONS)) {
    if (newName === canonicalName && !keys.includes(oldName)) keys.push(oldName);
    if (oldName === canonicalName && !keys.includes(newName)) keys.push(newName);
  }
  return keys;
};

const MIN_MEANINGFUL_INSIGHT_CHARS = 40;

interface TrainingInsightEntry {
  generatedAt: string;
  sessionsAtGeneration: number;
  improvement: string;
}

const getTrainingInsightForPlayer = (
  insightsFile: TrainingInsightsFile | null | undefined,
  playerName: string,
): TrainingInsightEntry | undefined => {
  if (!insightsFile?.insights) return undefined;
  for (const key of trainingInsightAliasNames(playerName)) {
    const e = insightsFile.insights[key];
    if (e?.improvement && e.improvement.trim().length >= MIN_MEANINGFUL_INSIGHT_CHARS) return e;
  }
  return undefined;
};

/** אימונים מאז יצירת התובנות — מעל זה מציגים המלצה לעדכון */
const INSIGHT_STALE_AFTER_SESSIONS = 3;

const countTrainingAnswers = (p: TrainingPlayerData): number =>
  p.sessions.reduce((sum, s) => sum + s.results.length, 0);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const safeParseJSON = (raw: string): any => {
  let text = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  // Extract JSON object/array from surrounding text
  const objStart = text.indexOf('{');
  const arrStart = text.indexOf('[');
  if (objStart >= 0 && (arrStart < 0 || objStart < arrStart)) {
    text = text.slice(objStart);
  } else if (arrStart >= 0) {
    text = text.slice(arrStart);
  }
  // Try parsing as-is first
  try { return JSON.parse(text); } catch { /* continue */ }
  // Fix common AI issues: truncated strings, trailing commas
  let fixed = text
    .replace(/,\s*([}\]])/g, '$1')     // trailing commas
    .replace(/([^\\])"\s*$/gm, '$1"')  // line-end quote cleanup
    .replace(/\n/g, '\\n');            // unescaped newlines in strings
  try { return JSON.parse(fixed); } catch { /* continue */ }
  // Last resort: try to close unclosed braces/brackets
  fixed = text.replace(/,\s*([}\]])/g, '$1');
  let opens = 0, closes = 0;
  for (const ch of fixed) { if (ch === '{') opens++; if (ch === '}') closes++; }
  while (closes < opens) { fixed += '}'; closes++; }
  // Fix unterminated string: if odd number of unescaped quotes, add one
  const unescapedQuotes = (fixed.match(/(?<!\\)"/g) || []).length;
  if (unescapedQuotes % 2 !== 0) fixed = fixed.replace(/([^"]*$)/, '"$1');
  try { return JSON.parse(fixed); } catch { /* continue */ }
  throw new Error(`JSON parse failed: ${text.slice(0, 120)}...`);
};

type FixDetailLevel = 'info' | 'success' | 'error';

/** Hebrew validation after AI fix — avoids silent "invalid result" with no detail */
const validateAIFixedScenario = (s: PoolScenario): string | null => {
  if (!s.options || !Array.isArray(s.options)) return 'חסר מערך אופציות בתשובת ה-AI';
  if (s.options.length !== 3) return `נדרשות בדיוק 3 אופציות — התקבלו ${s.options.length}`;
  const correctN = s.options.filter(o => o.isCorrect).length;
  if (correctN !== 1) return `נדרשת בדיוק אופציה אחת עם isCorrect: true — נמצאו ${correctN}`;
  const ids = s.options.map(o => String(o.id ?? '').trim().toUpperCase());
  const need = ['A', 'B', 'C'];
  const idSet = new Set(ids);
  if (idSet.size !== 3 || !need.every(x => idSet.has(x))) {
    return `מזהי אופציות חייבים להיות A, B, C (קיבלת: ${s.options.map(o => o.id).join(', ')})`;
  }
  if (!String(s.situation ?? '').trim()) return 'שדה situation ריק או חסר';
  if (!String(s.yourCards ?? '').trim()) return 'שדה yourCards ריק או חסר';
  if (typeof s.boardCards !== 'string') return 'שדה boardCards חייב להיות מחרוזת (ריק "" לפני פלופ)';
  for (const o of s.options) {
    const id = String(o.id ?? '').trim().toUpperCase();
    if (!String(o.text ?? '').trim()) return `טקסט ריק באופציה ${id}`;
    if (!String(o.explanation ?? '').trim() || String(o.explanation).trim() === '—') {
      return `הסבר חסר או ריק באופציה ${id} — נדרש 1–2 משפטים`;
    }
    if (o.isCorrect && o.nearMiss) return 'אסור nearMiss על התשובה הנכונה';
  }
  return null;
};

/** סידור A/B/C, ניקוי nearMiss מהנכונה, השלמת category — אחרי parse לפני אימות */
const normalizeAIFixedScenario = (raw: PoolScenario, poolId: string, original: PoolScenario): PoolScenario => {
  const order = ['A', 'B', 'C'] as const;
  const byId = new Map(
    (raw.options || []).map(o => [String(o.id ?? '').trim().toUpperCase(), o]),
  );
  const options = order.map(id => {
    const o = byId.get(id);
    if (!o) {
      return { id, text: '', isCorrect: false, explanation: '' };
    }
    const isCorrect = !!o.isCorrect;
    const base: PoolScenario['options'][number] = {
      id,
      text: String(o.text ?? '').trim(),
      isCorrect,
      explanation: String(o.explanation ?? '').trim(),
    };
    if (isCorrect) return base;
    if (o.nearMiss) return { ...base, nearMiss: true };
    return base;
  });
  return {
    poolId,
    situation: String(raw.situation ?? '').trim(),
    yourCards: String(raw.yourCards ?? '').trim(),
    boardCards: raw.boardCards != null ? String(raw.boardCards).trim() : '',
    options,
    category: String(raw.category ?? original.category).trim() || original.category,
    categoryId: String(raw.categoryId ?? original.categoryId).trim() || original.categoryId,
  };
};

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
  const [genLog, setGenLog] = useState<{ cat: string; icon: string; status: string; count: number; error?: string; elapsed?: number; diagnostics?: string[] }[]>([]);

  // Expanded player
  const [expandedPlayer, setExpandedPlayer] = useState<string | null>(null);

  // Flagged removal / dismiss / AI fix
  const [removingFlagged, setRemovingFlagged] = useState(false);
  const [dismissingFlagged, setDismissingFlagged] = useState<string | null>(null);
  const [fixingFlagged, setFixingFlagged] = useState<string | null>(null);
  const [fixPreview, setFixPreview] = useState<{ poolId: string; original: PoolScenario; fixed: PoolScenario; reports: TrainingFlagReport[] } | null>(null);
  const [fixFeedback, setFixFeedback] = useState('');
  const [fixHistory, setFixHistory] = useState<string[]>([]);
  const [regenerating, setRegenerating] = useState(false);
  const [savingFix, setSavingFix] = useState(false);
  const [flagMsg, setFlagMsg] = useState<string | null>(null);
  const [showFixStepDetails, setShowFixStepDetails] = useState(false);
  const [fixDetailLog, setFixDetailLog] = useState<Array<{ text: string; level: FixDetailLevel }>>([]);

  const pushFixLog = useCallback((text: string, level: FixDetailLevel) => {
    setFixDetailLog(prev => [...prev, { text, level }]);
  }, []);

  const clearFixLog = useCallback(() => setFixDetailLog([]), []);

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
      setInsights(i && i.insights ? i : { lastUpdated: i?.lastUpdated ?? '', insights: i?.insights ?? {} });
      setLastRefresh(new Date().toLocaleTimeString('he-IL'));
    } catch (err) {
      console.error('Failed to load training data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);
  useRealtimeRefresh(loadAll);

  const [batchInsightsRunning, setBatchInsightsRunning] = useState(false);
  const [cloudCleaningPlayer, setCloudCleaningPlayer] = useState<string | null>(null);
  const [cloudCleanMsg, setCloudCleanMsg] = useState<string | null>(null);
  const [sessionCleanMode, setSessionCleanMode] = useState<string | null>(null);
  const [selectedSessions, setSelectedSessions] = useState<Set<number>>(new Set());
  // Styled confirm dialog — replaces the legacy native confirm() so
  // destructive cloud-cleaning actions match the rest of the app.
  // The owner-only training tab stays Hebrew-only by convention.
  const [confirmDialog, setConfirmDialog] = useState<{
    body: string;
    onConfirm: () => Promise<void>;
  } | null>(null);
  const [confirmDialogBusy, setConfirmDialogBusy] = useState(false);

  const runConfirmDialog = async () => {
    if (!confirmDialog || confirmDialogBusy) return;
    setConfirmDialogBusy(true);
    try {
      await confirmDialog.onConfirm();
    } finally {
      setConfirmDialogBusy(false);
      setConfirmDialog(null);
    }
  };

  const handleCleanPlayerFromCloud = useCallback((playerName: string, sessionIndices?: Set<number>) => {
    const isPartial = sessionIndices && sessionIndices.size > 0;
    const label = isPartial
      ? `למחוק ${sessionIndices.size} אימונים של ${playerName} מהענן?`
      : `למחוק את כל נתוני האימון של ${playerName} מהענן?`;
    setConfirmDialog({
      body: label,
      onConfirm: async () => {
        setCloudCleaningPlayer(playerName);
        setCloudCleanMsg(null);
        try {
          const okAnswers = await writeTrainingAnswersWithRetry((data) => {
            let players: typeof data.players;
            if (isPartial) {
              players = data.players.map(p => {
                if (p.playerName !== playerName) return p;
                const remaining = p.sessions.filter((_, idx) => !sessionIndices.has(idx));
                if (remaining.length === 0) return null;
                let scored = 0, corr = 0;
                for (const s of remaining) {
                  for (const r of s.results) {
                    if (r.neutralized) continue;
                    if (!r.nearMiss) { scored++; if (r.correct) corr++; }
                  }
                }
                return { ...p, sessions: remaining, totalQuestions: scored, totalCorrect: corr, accuracy: scored > 0 ? (corr / scored) * 100 : 0 };
              }).filter((p): p is TrainingPlayerData => p !== null);
            } else {
              players = data.players.filter(p => p.playerName !== playerName);
            }
            return normalizeTrainingPlayers({ ...data, lastUpdated: new Date().toISOString(), players });
          });

          const removeInsights = !isPartial;
          let okInsights = true;
          if (removeInsights) {
            const insightsRaw = await fetchTrainingInsights();
            if (insightsRaw?.insights) {
              const insights: TrainingInsightsFile = {
                ...insightsRaw,
                lastUpdated: new Date().toISOString(),
                insights: { ...insightsRaw.insights },
              };
              delete insights.insights[playerName];
              const up = await uploadTrainingInsights(insights);
              okInsights = up.success;
            }
          }
          if (okAnswers && okInsights) {
            if (!isPartial) {
              resetSharedTrainingProgress(playerName);
              clearPendingUploadsForPlayer(playerName);
            }
            const msg = isPartial
              ? `✅ ${sessionIndices.size} אימונים של ${playerName} הוסרו`
              : `✅ ${playerName} הוסר בהצלחה`;
            setCloudCleanMsg(msg);
            setSessionCleanMode(null);
            setSelectedSessions(new Set());
            await new Promise(r => setTimeout(r, 1500));
            await loadAll();
          } else {
            setCloudCleanMsg('⚠️ העלאה נכשלה — בדוק חיבור לאינטרנט');
          }
        } catch {
          setCloudCleanMsg('⚠️ שגיאה — נסה שוב');
        } finally {
          setCloudCleaningPlayer(null);
        }
      },
    });
  }, [loadAll]);

  const playersNeedingInsights = useMemo((): TrainingPlayerData[] => {
    if (!answers?.players?.length) return [];
    return answers.players.filter(p => {
      const totalQ = countTrainingAnswers(p);
      const hasPending = !!(p.pendingReportMilestones && p.pendingReportMilestones.length > 0);
      if (hasPending) return true;
      if (totalQ < 100) return false;
      const insight = getTrainingInsightForPlayer(insights, p.playerName);
      if (!insight) return true;
      const gen = typeof insight.sessionsAtGeneration === 'number'
        ? insight.sessionsAtGeneration
        : p.sessions.length;
      const sessionsSince = Math.max(0, p.sessions.length - gen);
      return sessionsSince > INSIGHT_STALE_AFTER_SESSIONS;
    });
  }, [answers, insights]);

  const players = answers?.players || [];
  /** אותו מיון כמו טבלת השחקנים: דיוק ואז מספר שאלות (countTrainingAnswers) */
  const sortedPlayers = useMemo(() => {
    return [...players].sort((a, b) => {
      if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
      return countTrainingAnswers(b) - countTrainingAnswers(a);
    });
  }, [players]);

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

    const log: { cat: string; icon: string; status: string; count: number; error?: string; elapsed?: number; diagnostics?: string[] }[] = [];
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
      let catDiag: string[] | undefined;
      const catStart = Date.now();

      try {
        const result = await generatePoolBatch(cat, needed, allScenarios, apiKey);
        catDiag = result.diagnostics;
        if (result.scenarios.length > 0) {
          allScenarios.push(...result.scenarios);
          batchCount = result.scenarios.length;
          totalGenerated += result.scenarios.length;
          catStatus = result.scenarios.length >= needed * 0.6 ? 'ok' : 'partial';
          if (catStatus === 'partial') catError = `ביקשנו ${needed}, קיבלנו ${result.scenarios.length}`;
        } else {
          totalFailed++;
          const lastDiag = result.diagnostics[result.diagnostics.length - 1] || '';
          catError = lastDiag || 'AI החזיר 0 שאלות תקינות';
        }
      } catch (err) {
        console.error(`Smart gen failed for ${cat.id} (${phase}):`, err);
        totalFailed++;
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg === 'INVALID_API_KEY') {
          catStatus = 'key_error';
          catError = 'מפתח API לא תקין';
          log.push({ cat: cat.name, icon: cat.icon, status: catStatus, count: 0, error: catError, elapsed: Date.now() - catStart, diagnostics: catDiag });
          setGenLog([...log]);
          setGenMessage('מפתח API לא תקין — עצירה');
          break;
        }
        catStatus = 'fail';
        catError = errMsg.length > 80 ? errMsg.slice(0, 80) + '…' : errMsg;
      }

      const catElapsed = Date.now() - catStart;
      log.push({ cat: cat.name, icon: cat.icon, status: catStatus, count: batchCount, error: catError, elapsed: catElapsed, diagnostics: catDiag });
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

  // ── Lookup helpers for notifying reporters ──
  // Captured before mutation since handlers below clear the flag reports as part of resolution.
  const collectReportsForPool = useCallback((poolId: string, source: TrainingAnswersFile | null): TrainingFlagReport[] => {
    if (!source) return [];
    const out: TrainingFlagReport[] = [];
    source.players.forEach(p => p.sessions.forEach(s => {
      (s.flagReports || []).forEach(r => { if (r.poolId === poolId) out.push(r); });
    }));
    return out;
  }, []);

  const lookupScenario = useCallback((poolId: string): PoolScenario | undefined => {
    return pool?.scenarios.find(s => s.poolId === poolId);
  }, [pool]);

  // ── Remove flagged + neutralize scores ──
  const handleRemoveFlagged = async (poolIds: string[]) => {
    if (removingFlagged) return;
    setRemovingFlagged(true);
    setFlagMsg(`מסיר ${poolIds.length} שאלות ומתקן ציונים...`);
    // Capture reports + scenarios BEFORE we mutate `answers` (the writeTrainingAnswers call below
    // strips flagReports for the removed pool ids — so we can't look them up after).
    const notifyPayload = poolIds.map(pid => ({
      poolId: pid,
      reports: collectReportsForPool(pid, answers),
      scenario: lookupScenario(pid) || null,
      ai: (analyses[pid] || null) as AiResolutionText | null,
    }));
    try {
      const result = await removeFromTrainingPool(poolIds);
      if (result.success) {
        const refreshed = await fetchTrainingPool();
        if (refreshed) {
          updatePoolCache(refreshed);
          setPool(refreshed);
        }

        const removeSet = new Set(poolIds);
        const neutralized = await writeTrainingAnswersWithRetry((data) => {
          const clone = JSON.parse(JSON.stringify(data)) as TrainingAnswersFile;
          let affected = 0;
          clone.players.forEach(player => {
            let changed = false;
            player.sessions.forEach(session => {
              session.results.forEach(r => {
                if (removeSet.has(r.poolId) && !r.neutralized) {
                  r.neutralized = true;
                  changed = true;
                  affected++;
                }
              });
              if (session.flaggedPoolIds) {
                session.flaggedPoolIds = session.flaggedPoolIds.filter(id => !removeSet.has(id));
              }
              if (session.flagReports) {
                session.flagReports = session.flagReports.filter(r => !removeSet.has(r.poolId));
              }
            });
            if (changed) {
              const nonNeutral = player.sessions.flatMap(s => s.results).filter(r => !r.neutralized && !r.nearMiss);
              player.totalQuestions = nonNeutral.length;
              player.totalCorrect = nonNeutral.filter(r => r.correct).length;
              player.accuracy = player.totalQuestions > 0
                ? Math.round((player.totalCorrect / player.totalQuestions) * 100)
                : 0;
            }
          });
          clone.lastUpdated = new Date().toISOString();
          return clone;
        });

        if (answers) {
          const updatedAnswers = JSON.parse(JSON.stringify(answers)) as TrainingAnswersFile;
          const removeSetLocal = new Set(poolIds);
          updatedAnswers.players.forEach(player => {
            player.sessions.forEach(session => {
              session.results.forEach(r => {
                if (removeSetLocal.has(r.poolId)) r.neutralized = true;
              });
              if (session.flaggedPoolIds) session.flaggedPoolIds = session.flaggedPoolIds.filter(id => !removeSetLocal.has(id));
              if (session.flagReports) session.flagReports = session.flagReports.filter(r => !removeSetLocal.has(r.poolId));
            });
            const nonNeutral = player.sessions.flatMap(s => s.results).filter(r => !r.neutralized && !r.nearMiss);
            player.totalQuestions = nonNeutral.length;
            player.totalCorrect = nonNeutral.filter(r => r.correct).length;
            player.accuracy = player.totalQuestions > 0 ? Math.round((player.totalCorrect / player.totalQuestions) * 100) : 0;
          });
          setAnswers(updatedAnswers);
        }

        setFlagMsg(neutralized
          ? `✅ הוסרו ${poolIds.length} שאלות + ציונים תוקנו`
          : `✅ הוסרו ${poolIds.length} שאלות (תיקון ציונים נכשל)`);
        // Notify each reporter (best-effort, fire-and-forget).
        for (const item of notifyPayload) {
          if (item.scenario) {
            notifyReportersOfResolution({
              reports: item.reports,
              scenario: item.scenario,
              outcome: 'accept_removed',
              ai: item.ai,
            }).catch(err => console.warn('[training-report-notify] remove dispatch failed:', err));
          }
        }
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
    // Capture reports BEFORE writeTrainingAnswers strips them.
    const reportsToNotify = collectReportsForPool(poolId, answers);
    const scenarioForNotify = lookupScenario(poolId) || null;
    const aiForNotify = (analyses[poolId] || null) as AiResolutionText | null;
    try {
      const ok = await writeTrainingAnswersWithRetry((data) => clearFlagsLocally(data, poolId));
      if (ok) {
        if (answers) setAnswers(clearFlagsLocally(answers, poolId));
        setFlagMsg('✅ הדיווחים נדחו — השאלה נשארת');
        if (scenarioForNotify) {
          notifyReportersOfResolution({
            reports: reportsToNotify,
            scenario: scenarioForNotify,
            outcome: 'reject_kept',
            ai: aiForNotify,
          }).catch(err => console.warn('[training-report-notify] dismiss dispatch failed:', err));
        }
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
קלפים: ${scenario.yourCards || 'לא צוינו'}${scenario.boardCards ? `\nלוח: ${scenario.boardCards}` : ''}
${scenario.options.map(o => `${o.id}. ${o.text}${o.isCorrect ? ' ✓' : ''}${o.nearMiss ? ' (ניטרלי)' : ''} — ${o.explanation || ''}`).join('\n')}

הדיווחים:
${reportSummary}

החזר JSON בלבד בפורמט:
{"verdict":"accept|reject|partial","explanation":"ניתוח קצר של 2-3 משפטים — האם הדיווח מוצדק ולמה","rejectText":"הודעה קצרה וידידותית של משפט אחד שאפשר לשלוח למדווח בוואטסאפ אם דוחים את הדיווח, כולל הסבר למה התשובה נכונה","acceptText":"הודעה קצרה וידידותית למדווח שתודה לו על הדיווח ומסבירה שתיקנו/עדכנו את השאלה בזכותו"}
- acceptText חובה כש-verdict הוא accept או partial
- rejectText חובה כש-verdict הוא reject או partial
JSON בלבד, בלי markdown:`;

    try {
      const text = await callGemini(apiKey, prompt, 4096, { jsonMode: true });
      const result = safeParseJSON(text);
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
      const text = await callGemini(apiKey, prompt, 4096, { jsonMode: true });
      const result = safeParseJSON(text);
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

  // ── Combined: Analyze report + generate fix in one AI call ──
  const handleAnalyzeAndFix = async (poolId: string, scenario: PoolScenario, reports: TrainingFlagReport[]) => {
    const apiKey = getGeminiApiKey();
    if (!apiKey || !pool) return;

    clearFixLog();
    setFixingFlagged(poolId);
    setAnalyzingReport(poolId);
    setFlagMsg('AI מנתח דיווח ומייצר תיקון...');
    pushFixLog('שלב 1/4: בניית פרומפט משולב (ניתוח + תיקון)', 'info');

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

    const prompt = `אתה עורך שאלות אימון פוקר ומנהל משחק ביתי. שחקנים דיווחו על בעיה בשאלה.
בצע שתי משימות בבת אחת:
1. נתח את הדיווח — האם מוצדק?
2. אם הדיווח מוצדק (verdict = accept או partial) — תקן את השאלה.

${GAME_CONTEXT}

${TRAINING_SCENARIO_FIX_FORMAT_RULES}

שחקנים קבועים (ניתן לדייק שמות בסיטואציה):
${playerStylesList}

שאלה נוכחית (JSON):
${JSON.stringify({
  poolId: scenario.poolId,
  situation: scenario.situation,
  yourCards: scenario.yourCards,
  boardCards: scenario.boardCards || '',
  options: scenario.options.map(o => ({ id: o.id, text: o.text, isCorrect: o.isCorrect, explanation: o.explanation, nearMiss: o.nearMiss })),
  category: scenario.category,
  categoryId: scenario.categoryId,
})}

דיווחי שחקנים:
${reportSummary}

החזר אובייקט JSON יחיד בפורמט הבא (בלי markdown, בלי טקסט לפני/אחרי):
{
  "verdict": "accept" | "reject" | "partial",
  "explanation": "ניתוח קצר 2-3 משפטים — האם הדיווח מוצדק ולמה",
  "rejectText": "הודעה ידידותית למדווח אם דוחים (חובה ב-reject/partial)",
  "acceptText": "הודעה ידידותית למדווח שמודה על הדיווח (חובה ב-accept/partial)",
  "fixedScenario": { ...שאלה מתוקנת עם כל השדות... } | null
}

כללים:
- אם verdict = "reject": fixedScenario חייב להיות null (השאלה תקינה, אין מה לתקן).
- אם verdict = "accept" או "partial": fixedScenario חייב להיות אובייקט מלא עם poolId, situation, yourCards, boardCards, options (3 אופציות), category, categoryId — בהתאם לכל כללי הפורמט למעלה.
- שמור poolId="${scenario.poolId}", categoryId ו-category כמו במקור.

דוגמת מבנה (ערכים לדוגמה בלבד):
{"verdict":"accept","explanation":"הדיווח מוצדק — התשובה הנכונה לא מתאימה למשחק ביתי.","rejectText":"","acceptText":"תודה על הדיווח! תיקנו את השאלה.","fixedScenario":{"poolId":"${scenario.poolId}","situation":"3 שחקנים בקופה של 2,400. חרדון מהמר 800. מה הפעולה?","yourCards":"K♣ J♣","boardCards":"10♦ 8♣ 2♣","options":[{"id":"A","text":"קריאה 800","isCorrect":true,"explanation":"מחיר נכון מול ההימור."},{"id":"B","text":"העלאה ל-2,500","isCorrect":false,"nearMiss":true,"explanation":"בטורניר הגיוני — כאן פחות."},{"id":"C","text":"ויתור","isCorrect":false,"explanation":"ויתור שגוי מול סכום כזה."}],"category":"${scenario.category.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}","categoryId":"${scenario.categoryId}"}}`;

    try {
      pushFixLog('שלב 2/4: שליחת בקשה ל-Gemini (ניתוח + תיקון ביחד)', 'info');
      const responseText = await callGemini(apiKey, prompt, 4096, { jsonMode: true });
      pushFixLog(`שלב 3/4: התקבלה תשובה (${responseText.length.toLocaleString('he-IL')} תווים) — מנתחים JSON`, 'info');

      let parsed: Record<string, unknown>;
      try {
        parsed = safeParseJSON(responseText) as Record<string, unknown>;
      } catch (parseErr) {
        const hint = responseText.length > 400
          ? `${responseText.slice(0, 200)} … ${responseText.slice(-120)}`
          : responseText;
        pushFixLog(`כשל בפענוח JSON: ${parseErr instanceof Error ? parseErr.message : 'לא ידוע'}`, 'error');
        pushFixLog(`תחילת/סוף תשובה גולמית:\n${hint}`, 'error');
        setShowFixStepDetails(true);
        setFlagMsg('❌ לא הצלחנו לפענח את תשובת ה-AI — פתח "פירוט שלבים" לפרטים');
        return;
      }

      const verdict = String(parsed.verdict || '').trim();
      const explanation = String(parsed.explanation || '').trim();
      const rejectText = String(parsed.rejectText || '').trim();
      const acceptText = String(parsed.acceptText || '').trim();

      setAnalyses(prev => ({ ...prev, [poolId]: { verdict, explanation, rejectText, acceptText } }));

      if (verdict === 'reject') {
        pushFixLog('שלב 4/4: הדיווח נדחה — השאלה תקינה, אין תיקון', 'info');
        setFlagMsg('✅ AI קבע שהשאלה תקינה — אפשר לדחות הדיווח');
        return;
      }

      const rawFixed = parsed.fixedScenario as PoolScenario | null;
      if (!rawFixed || typeof rawFixed !== 'object') {
        pushFixLog('שלב 4/4: verdict = accept/partial אבל fixedScenario חסר — מנסה תיקון נפרד', 'error');
        setFlagMsg('⚠️ הניתוח התקבל אבל ללא תיקון — לחץ "תקן עם AI" ליצירת תיקון');
        return;
      }

      let fixedScenario: PoolScenario;
      try {
        fixedScenario = normalizeAIFixedScenario(rawFixed, poolId, scenario);
      } catch (normErr) {
        pushFixLog(`כשל בנרמול השאלה המתוקנת: ${normErr instanceof Error ? normErr.message : 'לא ידוע'}`, 'error');
        setShowFixStepDetails(true);
        setFlagMsg('⚠️ הניתוח התקבל אבל התיקון לא תקין — לחץ "תקן עם AI" ליצירת תיקון חדש');
        return;
      }

      const validationError = validateAIFixedScenario(fixedScenario);
      if (validationError) {
        pushFixLog(`שלב 4/4: אימות התיקון נכשל — ${validationError}`, 'error');
        setShowFixStepDetails(true);
        setFlagMsg(`⚠️ הניתוח התקבל אבל התיקון לא עבר אימות — לחץ "תקן עם AI"`);
        return;
      }

      pushFixLog('שלב 4/4: ניתוח + תיקון הושלמו בהצלחה', 'success');
      setFixPreview({ poolId, original: scenario, fixed: fixedScenario, reports });
      setFixFeedback('');
      setFixHistory([]);
      setFlagMsg(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown';
      pushFixLog(`שגיאה: ${msg}`, 'error');
      if (msg.includes('ALL_MODELS_FAILED') || msg.includes('אין חיבור')) {
        pushFixLog('רמז: בדוק מפתח API, מכסת בקשות (429), או חיבור אינטרנט', 'info');
      }
      setShowFixStepDetails(true);
      setFlagMsg(`❌ שגיאת AI: ${msg}`);
    } finally {
      setFixingFlagged(null);
      setAnalyzingReport(null);
    }
  };

  // ── AI Fix flagged question (generates preview) ──
  const handleAIFix = async (poolId: string, reports: TrainingFlagReport[]) => {
    const apiKey = getGeminiApiKey();
    if (!apiKey || !pool) return;

    const scenario = pool.scenarios.find(s => s.poolId === poolId);
    if (!scenario) return;

    clearFixLog();
    setFixingFlagged(poolId);
    setFlagMsg(`AI מייצר תיקון...`);
    pushFixLog(`שלב 1/4: טעינת שאלה ${poolId} מהמאגר`, 'info');

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

    const prompt = `אתה עורך שאלות אימון פוקר (מאגר האפליקציה). שחקנים דיווחו על בעיה — תקן את השאלה כך שהפלט הראשון יעמוד במלואו בפורמט המאגר ובקונבנציות של משחק הבית.

${GAME_CONTEXT}

${TRAINING_SCENARIO_FIX_FORMAT_RULES}

שחקנים קבועים (ניתן לדייק שמות בסיטואציה):
${playerStylesList}

שאלה נוכחית (JSON):
${JSON.stringify({
  poolId: scenario.poolId,
  situation: scenario.situation,
  yourCards: scenario.yourCards,
  boardCards: scenario.boardCards || '',
  options: scenario.options.map(o => ({ id: o.id, text: o.text, isCorrect: o.isCorrect, explanation: o.explanation, nearMiss: o.nearMiss })),
  category: scenario.category,
  categoryId: scenario.categoryId,
})}

דיווחי שחקנים:
${reportSummary}

משימה:
- תקן את הבעיה לפי הדיווחים ובהתאם להקשר של משחק ביתי למעלה.
- הפלט חייב לעמוד בכל סעיפי "פורמט פלט" בשלמות — כולל yourCards ו-boardCards נפרדים מ-situation, שלוש אופציות עם הסברים לא ריקים, nearMiss רק על תשובות שגויות.

החזר אובייקט JSON יחיד בלבד (בלי markdown, בלי טקסט לפני/אחרי). שמור poolId="${scenario.poolId}", categoryId ו-category כמו במקור.

דוגמת מבנה תקין (ערכים לדוגמה בלבד — אל תעתיק אותם; רק המבנה):
{"poolId":"${scenario.poolId}","situation":"3 שחקנים בקופה של 2,400. חרדון מהמר 800. מה הפעולה?","yourCards":"K♣ J♣","boardCards":"10♦ 8♣ 2♣","options":[{"id":"A","text":"קריאה 800","isCorrect":true,"explanation":"מחיר נכון מול ההימור — אצלנו ישלמו הרבה פעמים."},{"id":"B","text":"העלאה ל-2,500","isCorrect":false,"nearMiss":true,"explanation":"בטורניר היה הגיוני — כאן עדיין יגיעו קוראים."},{"id":"C","text":"ויתור","isCorrect":false,"explanation":"מול סכום כזה ויתור כמעט תמיד שגוי."}],"category":"${scenario.category.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}","categoryId":"${scenario.categoryId}"}`;

    try {
      pushFixLog('שלב 2/4: שליחת בקשה ל-Gemini (JSON mode + מודל עם נפילה אוטומטית)', 'info');
      const fixedText = await callGemini(apiKey, prompt, 4096, { jsonMode: true });
      pushFixLog(`שלב 3/4: התקבלה תשובה (${fixedText.length.toLocaleString('he-IL')} תווים) — מנתחים JSON`, 'info');

      let fixedScenario: PoolScenario;
      try {
        const parsed = safeParseJSON(fixedText) as PoolScenario;
        fixedScenario = normalizeAIFixedScenario(parsed, poolId, scenario);
      } catch (parseErr) {
        const hint = fixedText.length > 400
          ? `${fixedText.slice(0, 200)} … ${fixedText.slice(-120)}`
          : fixedText;
        pushFixLog(`כשל בפענוח JSON: ${parseErr instanceof Error ? parseErr.message : 'לא ידוע'}`, 'error');
        pushFixLog(`תחילת/סוף תשובה גולמית:\n${hint}`, 'error');
        setShowFixStepDetails(true);
        setFlagMsg('❌ לא הצלחנו לפענח את תשובת ה-AI — פתח "פירוט שלבים" לפרטים');
        return;
      }

      const validationError = validateAIFixedScenario(fixedScenario);
      if (validationError) {
        pushFixLog(`שלב 4/4: אימות מבנה נכשל — ${validationError}`, 'error');
        setShowFixStepDetails(true);
        setFlagMsg(`❌ תשובת AI לא עומדת בדרישות: ${validationError}`);
        return;
      }

      pushFixLog('שלב 4/4: אימות מבנה עבר — תצוגה מקדימה מוכנה', 'success');
      setFixPreview({ poolId, original: scenario, fixed: fixedScenario, reports });
      setFixFeedback('');
      setFixHistory([]);
      setFlagMsg(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown';
      pushFixLog(`שגיאה בשלב קריאת AI: ${msg}`, 'error');
      if (msg.includes('ALL_MODELS_FAILED') || msg.includes('אין חיבור')) {
        pushFixLog('רמז: בדוק מפתח API, מכסת בקשות (429), או חיבור אינטרנט', 'info');
      }
      setShowFixStepDetails(true);
      setFlagMsg(`❌ שגיאת AI: ${msg}`);
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

    const prompt = `אתה עורך שאלות אימון פוקר. כבר הוצג תיקון — המנהל מבקש שיפור נוסף. החזר גרסה אחת שעומדת במלואה בפורמט המאגר.

${GAME_CONTEXT}

${TRAINING_SCENARIO_FIX_FORMAT_RULES}

שאלה מקורית:
${JSON.stringify(fixPreview.original)}

תיקון נוכחי:
${JSON.stringify(fixPreview.fixed)}
${historyContext}
הערה חדשה מהמנהל: "${fixFeedback}"

החזר אובייקט JSON יחיד בלבד (בלי markdown). שמור poolId="${fixPreview.poolId}", categoryId ו-category כמו במקור.

דוגמת מבנה תקין (ערכים לדוגמה בלבד):
{"poolId":"${fixPreview.poolId}","situation":"...","yourCards":"K♣ J♣","boardCards":"10♦ 8♣ 2♣","options":[{"id":"A","text":"...","isCorrect":true,"explanation":"..."},{"id":"B","text":"...","isCorrect":false,"nearMiss":true,"explanation":"..."},{"id":"C","text":"...","isCorrect":false,"explanation":"..."}],"category":"${fixPreview.original.category.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}","categoryId":"${fixPreview.original.categoryId}"}`;

    pushFixLog('תיקון חוזר: שליחה ל-Gemini (JSON mode)', 'info');
    try {
      const fixedText = await callGemini(apiKey, prompt, 4096, { jsonMode: true });
      pushFixLog(`תיקון חוזר: התקבלו ${fixedText.length.toLocaleString('he-IL')} תווים`, 'info');

      let fixedScenario: PoolScenario;
      try {
        const parsed = safeParseJSON(fixedText) as PoolScenario;
        fixedScenario = normalizeAIFixedScenario(parsed, fixPreview.poolId, fixPreview.original);
      } catch (parseErr) {
        const hint = fixedText.length > 400
          ? `${fixedText.slice(0, 200)} … ${fixedText.slice(-120)}`
          : fixedText;
        pushFixLog(`תיקון חוזר — כשל JSON: ${parseErr instanceof Error ? parseErr.message : ''}`, 'error');
        pushFixLog(hint, 'error');
        setShowFixStepDetails(true);
        setFlagMsg('❌ תיקון חוזר נכשל בפענוח — ראה פירוט שלבים');
        return;
      }

      const validationError = validateAIFixedScenario(fixedScenario);
      if (validationError) {
        pushFixLog(`תיקון חוזר — אימות: ${validationError}`, 'error');
        setShowFixStepDetails(true);
        setFlagMsg(`❌ תיקון חוזר לא תקין: ${validationError}`);
        return;
      }

      pushFixLog('תיקון חוזר הושלם בהצלחה', 'success');
      setFixHistory(prev => [...prev, fixFeedback]);
      setFixPreview({ ...fixPreview, fixed: fixedScenario });
      setFixFeedback('');
      setFlagMsg(null);
    } catch (err) {
      pushFixLog(`תיקון חוזר — ${err instanceof Error ? err.message : 'Unknown'}`, 'error');
      setShowFixStepDetails(true);
      setFlagMsg(`❌ שגיאת AI: ${err instanceof Error ? err.message : 'Unknown'}`);
    } finally {
      setRegenerating(false);
    }
  };

  // ── Confirm AI fix (save to pool + clear flags) ──
  const confirmAIFix = async () => {
    if (!fixPreview || !pool) return;
    const { poolId, fixed, reports: reportsForNotify } = fixPreview;
    const aiForNotify = (analyses[poolId] || null) as AiResolutionText | null;
    const again = validateAIFixedScenario(fixed);
    if (again) {
      pushFixLog(`שמירה בוטלה — אימות לפני שמירה נכשל: ${again}`, 'error');
      setShowFixStepDetails(true);
      setFlagMsg(`❌ לא ניתן לשמור: ${again}`);
      return;
    }

    setSavingFix(true);
    setFlagMsg('שומר תיקון...');
    pushFixLog(`שמירה 1/3: בניית מאגר מקומי — ${poolId}`, 'info');

    try {
      const updatedScenarios = pool.scenarios.map(s => s.poolId === poolId ? { ...fixed, reviewedAt: new Date().toISOString() } : s);
      const newPool = buildPoolObject(updatedScenarios);
      pushFixLog('שמירה 2/3: העלאת מאגר...', 'info');
      const result = await uploadTrainingPool(newPool);

      if (!result.success) {
        pushFixLog(`העלאת המאגר נכשלה: ${result.message}`, 'error');
        setShowFixStepDetails(true);
        setFlagMsg(`❌ שגיאה בהעלאה: ${result.message}`);
        return;
      }

      setPool(newPool);
      pushFixLog('שמירה 3/3: מנקה דיווחים בקובץ התשובות...', 'info');
      const ok = await writeTrainingAnswersWithRetry((data) => clearFlagsLocally(data, poolId));
      if (!ok) {
        pushFixLog('המאגר הועלה, אך עדכון קובץ התשובות נכשל — נסה רענון ואז "רענן" בלשונית', 'error');
        setShowFixStepDetails(true);
        setFlagMsg('⚠️ המאגר עודכן; ניקוי דיווחים בקובץ התשובות נכשל — רענן נתונים');
        setFixPreview(null);
        return;
      }
      if (answers) {
        setAnswers(clearFlagsLocally(answers, poolId));
      }
      pushFixLog('✅ כל השלבים הושלמו — השאלה במאגר והדיווחים אוחדו', 'success');
      setFlagMsg('✅ השאלה תוקנה — הדיווחים נמחקו');
      // Notify reporters that their report was accepted and the question was fixed.
      // Use the FIXED scenario for context so the message reflects the corrected question.
      notifyReportersOfResolution({
        reports: reportsForNotify,
        scenario: fixed,
        outcome: 'accept_fixed',
        ai: aiForNotify,
      }).catch(err => console.warn('[training-report-notify] fix dispatch failed:', err));
      setFixPreview(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown';
      pushFixLog(`שמירה נכשלה: ${msg}`, 'error');
      setShowFixStepDetails(true);
      setFlagMsg(`❌ שגיאה: ${msg}`);
    } finally {
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

    // Batch size kept small to fit within Vercel Edge ~25s timeout.
    // 10 questions × ~700 tokens output = ~7k tokens → often >25s. 4 questions is safer.
    const BATCH = 4;
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
2. **התאמה למשחק ביתי**: בלוף גדול = לא תשובה נכונה (שחקנים קוראים)
3. **nearMiss**: סמן תשובות שגויות שהיו נכונות בפוקר מקצועי
4. **שגיאות**: placeholder טקסט, קלפים כפולים
5. **פורמט**: situation חייב להיות קצר (1-2 משפטים — רק הפעולה). אם הקלפים או הלוח מוזכרים ב-situation — העבר אותם ל-boardCards וקצר את situation. אם boardCards ריק אבל יש קלפי לוח ב-situation — חלץ אותם ל-boardCards.
6. אם situation אומר "יש לך פלאש דרו/סט/סטרייט" — הסר את זה (השחקן צריך לזהות בעצמו)

שאלות:
${JSON.stringify(batch.map(s => ({ poolId: s.poolId, yourCards: s.yourCards, boardCards: s.boardCards || '', situation: s.situation, options: s.options.map(o => ({ id: o.id, text: o.text, isCorrect: o.isCorrect, explanation: o.explanation, nearMiss: o.nearMiss })), categoryId: s.categoryId })))}

החזר JSON בלבד, מערך:
[{"poolId":"xxx","status":"ok"|"fixed"|"remove","issues":["בעיה"],"fixedScenario":{...כל השדות המתוקנים אם fixed},"nearMissFlags":["B"]}]

- "ok": תקין (עדיין הוסף nearMissFlags אם רלוונטי)
- "fixed": מחזיר fixedScenario מתוקן עם כל השדות (situation, yourCards, boardCards, options עם id/text/isCorrect/explanation/nearMiss, category, categoryId, poolId)
- "remove": גרוע מדי

JSON בלבד, בלי markdown:`;

      try {
        // Try stable gemini-2.5-flash first (preview models often hit 503/504 under load)
        const SCAN_MODELS = ['gemini-2.5-flash', 'gemini-3.1-flash-lite-preview', 'gemini-3-flash-preview'];
        let result: unknown[] | null = null;

        let lastError = '';
        for (const model of SCAN_MODELS) {
          let retried = false;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const resp = await proxyGeminiGenerate('v1beta', model, apiKey, {
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
              });
              if (!resp.ok) {
                const errBody = await resp.text().catch(() => '');
                const errMsg = errBody.includes('RESOURCE_EXHAUSTED') ? 'חריגה ממכסת API' :
                  errBody.includes('INVALID_ARGUMENT') ? 'בקשה לא תקינה' :
                  `HTTP ${resp.status}`;
                lastError = `${model}: ${errMsg}`;
                // Retry once on transient errors before giving up on this model
                if ((resp.status === 429 || resp.status === 503 || resp.status === 504) && !retried) {
                  retried = true;
                  setReviewLog(prev => [...prev, `⏳ ${model}: ${errMsg} — ממתין 5s ומנסה שוב...`]);
                  await new Promise(r => setTimeout(r, 5000));
                  continue;
                }
                setReviewLog(prev => [...prev, `⚠️ ${model}: ${errMsg} — מנסה מודל הבא...`]);
                break;
              }
              const data = await resp.json();
              const finishReason = data.candidates?.[0]?.finishReason;
              const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
              if (!text) {
                lastError = `${model}: תשובה ריקה (${finishReason || 'no content'})`;
                setReviewLog(prev => [...prev, `⚠️ ${lastError}`]);
                break;
              }
              try {
                result = safeParseJSON(text);
              } catch {
                const snippet = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim().slice(0, 80);
                lastError = `${model}: JSON לא תקין — ${snippet}...`;
                setReviewLog(prev => [...prev, `⚠️ ${lastError}`]);
                break;
              }
              break;
            } catch (fetchErr) {
              lastError = `${model}: ${fetchErr instanceof Error ? fetchErr.message : 'network error'}`;
              break;
            }
          }
          if (result) break;
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
        updatePoolCache(newPool);
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
  const runPlayerInsightPipeline = async (
    player: TrainingPlayerData,
    allPlayersData: TrainingPlayerData[],
    insightsBase: TrainingInsightsFile,
    apiKey: string,
    setStep: (s: string | null) => void,
  ): Promise<TrainingInsightsFile> => {
    setStep('מנתח נתונים...');
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

    setStep('1/3 — מייצר תובנות לשחקן...');
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

חשוב: סיים את כל הסעיפים במלואם — אל תקטע באמצע משפט. אם נשאר מקום, העדף להשלים את סעיף הנקודות לשיפור לפני הסיכום.

חוקים: אל תחזור על מספרים מהטבלה. כתוב כאילו מכיר אותו. הומור קל מותר. שלב נתונים טבעית. בערך 12-18 שורות.`;

    const improvResult = await runGeminiTextPrompt(apiKey, coachingPrompt, {
      temperature: 0.7,
      maxOutputTokens: 8192,
      label: 'training_coaching',
    });

    setStep('2/3 — מייצר ניתוח ניצול...');
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

    const exploitResult = await runGeminiTextPrompt(apiKey, exploitPrompt, {
      temperature: 0.7,
      maxOutputTokens: 4096,
      label: 'training_exploit',
    });

    setStep('3/3 — שומר...');
    const currentInsights: TrainingInsightsFile = {
      lastUpdated: new Date().toISOString(),
      insights: { ...insightsBase.insights },
    };
    currentInsights.insights[player.playerName] = {
      generatedAt: new Date().toISOString(),
      sessionsAtGeneration: player.sessions.length,
      improvement: improvResult,
    };
    await uploadTrainingInsights(currentInsights);

    const exploitData: TrainingExploitationLocal = {
      generatedAt: new Date().toISOString(),
      sessionsAtGeneration: player.sessions.length,
      text: exploitResult,
    };
    localStorage.setItem(`training_exploitation_${player.playerName}`, JSON.stringify(exploitData));

    return currentInsights;
  };

  const handleGenerateInsight = async (player: TrainingPlayerData) => {
    const apiKey = getGeminiApiKey();
    if (!apiKey) return;

    setGeneratingInsight(player.playerName);
    setInsightMsg(null);
    const base = insights ?? { lastUpdated: '', insights: {} };
    try {
      const merged = await runPlayerInsightPipeline(
        player,
        answers?.players || [],
        { lastUpdated: base.lastUpdated, insights: { ...base.insights } },
        apiKey,
        (s) => setGeneratingStep(s),
      );
      setInsights(merged);
      setInsightMsg(`✅ תובנות נוצרו עבור ${player.playerName}`);
    } catch (err) {
      setInsightMsg(`שגיאה: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      setGeneratingInsight(null);
      setGeneratingStep(null);
    }
  };

  const handleBatchGenerateInsights = async () => {
    const apiKey = getGeminiApiKey();
    if (!apiKey || !answers || playersNeedingInsights.length === 0) return;

    setBatchInsightsRunning(true);
    setInsightMsg(null);
    const base = insights ?? { lastUpdated: '', insights: {} };
    let working: TrainingInsightsFile = {
      lastUpdated: base.lastUpdated,
      insights: { ...base.insights },
    };
    const list = playersNeedingInsights;

    try {
      for (let i = 0; i < list.length; i++) {
        const player = list[i];
        setInsightMsg(`⏳ מייצר תובנות (${i + 1}/${list.length}): ${player.playerName}...`);
        working = await runPlayerInsightPipeline(
          player,
          answers.players,
          working,
          apiKey,
          (s) => setGeneratingStep(s),
        );
        setInsights({ ...working });

        if (player.pendingReportMilestones && player.pendingReportMilestones.length > 0) {
          await writeTrainingAnswersWithRetry((data) => {
            const pl = data.players.find(pp => pp.playerName === player.playerName);
            if (pl) pl.pendingReportMilestones = [];
            data.lastUpdated = new Date().toISOString();
            return data;
          });
        }

        if (i < list.length - 1) {
          await new Promise(r => setTimeout(r, 2500));
        }
      }
      setInsightMsg(`✅ נוצרו תובנות ל-${list.length} שחקנים`);
      await loadAll();
    } catch (err) {
      setInsightMsg(`שגיאה: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      setBatchInsightsRunning(false);
      setGeneratingStep(null);
    }
  };

  const callGemini = async (
    apiKey: string,
    prompt: string,
    maxTokens = 4096,
    opts?: { jsonMode?: boolean },
  ): Promise<string> =>
    runGeminiTextPrompt(apiKey, prompt, {
      temperature: opts?.jsonMode ? 0.35 : 0.7,
      maxOutputTokens: maxTokens,
      label: 'training_admin',
      ...(opts?.jsonMode ? { responseMimeType: 'application/json' as const, topP: 0.9 } : {}),
    });

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
                    {entry.diagnostics && entry.diagnostics.length > 0 && (
                      <details style={{ marginTop: '0.15rem', paddingRight: '1.2rem' }}>
                        <summary style={{ fontSize: '0.58rem', cursor: 'pointer', color: 'var(--text-muted)' }}>
                          פירוט ({entry.diagnostics.length} שלבים)
                        </summary>
                        <div style={{ marginTop: '0.15rem' }}>
                          {entry.diagnostics.map((d, di) => (
                            <div key={di} style={{ fontSize: '0.55rem', lineHeight: 1.35, color: 'var(--text-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                              · {d}
                            </div>
                          ))}
                        </div>
                      </details>
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
                    {entry.diagnostics && entry.diagnostics.length > 0 && (
                      <details style={{ marginTop: '0.15rem', paddingRight: '1.2rem' }}>
                        <summary style={{ fontSize: '0.58rem', cursor: 'pointer', color: 'var(--text-muted)' }}>
                          פירוט ({entry.diagnostics.length} שלבים)
                        </summary>
                        <div style={{ marginTop: '0.15rem' }}>
                          {entry.diagnostics.map((d, di) => (
                            <div key={di} style={{ fontSize: '0.55rem', lineHeight: 1.35, color: 'var(--text-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                              · {d}
                            </div>
                          ))}
                        </div>
                      </details>
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

      {cloudCleanMsg && (
        <div className="card" style={{ padding: '0.5rem 1rem', marginBottom: '0.5rem', direction: 'rtl' }}>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{cloudCleanMsg}</div>
        </div>
      )}

      {/* Player Summary Table */}
      <div className="card" style={{ padding: '1rem', marginBottom: '0.5rem' }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem',
        }}>
          <h3 style={{ fontSize: '0.9rem', fontWeight: 700, margin: 0 }}>👥 שחקנים</h3>
          <button
            type="button"
            onClick={handleBatchGenerateInsights}
            title={
              !getGeminiApiKey()
                ? 'נדרש מפתח Gemini בהגדרות'
                : playersNeedingInsights.length === 0
                  ? 'אין צורך בעדכון — כל התובנות תקפות'
                  : `יצירה/עדכון תובנות ל-${playersNeedingInsights.length} שחקנים`
            }
            disabled={
              playersNeedingInsights.length === 0
              || batchInsightsRunning
              || generatingInsight !== null
              || !getGeminiApiKey()
            }
            style={{
              fontSize: '0.7rem',
              padding: '0.35rem 0.65rem',
              borderRadius: '8px',
              border: '1px solid var(--border)',
              background:
                batchInsightsRunning || generatingInsight !== null
                  ? 'var(--surface-light)'
                  : playersNeedingInsights.length === 0 || !getGeminiApiKey()
                    ? 'var(--surface-hover)'
                    : 'linear-gradient(135deg, #6366f1, #8b5cf6)',
              color:
                batchInsightsRunning || generatingInsight !== null
                  ? 'var(--text-muted)'
                  : playersNeedingInsights.length === 0 || !getGeminiApiKey()
                    ? 'var(--text-muted)'
                    : 'white',
              fontWeight: 600,
              cursor:
                batchInsightsRunning || generatingInsight !== null
                  ? 'wait'
                  : playersNeedingInsights.length === 0 || !getGeminiApiKey()
                    ? 'default'
                    : 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {batchInsightsRunning
              ? `⏳ ${generatingStep || 'מייצר...'}`
              : playersNeedingInsights.length === 0
                ? '✓ תובנות מעודכנות'
                : `✨ עדכן תובנות (${playersNeedingInsights.length})`}
          </button>
        </div>

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
              const insight = getTrainingInsightForPlayer(insights, player.playerName);
              const needsInsightRow = playersNeedingInsights.some(p => p.playerName === player.playerName);
              const insightGen = insight
                ? (typeof insight.sessionsAtGeneration === 'number' ? insight.sessionsAtGeneration : player.sessions.length)
                : 0;
              const sessionsSinceInsight = insight ? Math.max(0, player.sessions.length - insightGen) : -1;
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
                      {needsInsightRow && (
                        <span style={{
                          fontSize: '0.58rem', fontWeight: 700, padding: '0.12rem 0.35rem', borderRadius: '4px',
                          background: 'rgba(99,102,241,0.2)', color: '#a5b4fc', whiteSpace: 'nowrap',
                        }} title="צריך תובנות AI — פתח שורה או השתמש בכפתור למעלה">
                          תובנות
                        </span>
                      )}
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
                      {insight && (() => {
                        const genSessions = typeof insight.sessionsAtGeneration === 'number' ? insight.sessionsAtGeneration : player.sessions.length;
                        const sessionsAtGen = player.sessions.slice(0, genSessions);
                        let qAtGen = 0, cAtGen = 0, nearMissAtGen = 0;
                        for (const s of sessionsAtGen) {
                          for (const r of s.results) {
                            if (r.neutralized) continue;
                            if (r.nearMiss) { nearMissAtGen++; } else { qAtGen++; if (r.correct) cAtGen++; }
                          }
                        }
                        const wrongAtGen = qAtGen - cAtGen;
                        const allAtGen = qAtGen + nearMissAtGen;
                        const accAtGen = qAtGen > 0 ? Math.round((cAtGen / qAtGen) * 100) : 0;
                        const genDate = new Date(insight.generatedAt).toLocaleDateString('he-IL', { day: 'numeric', month: 'short', year: '2-digit' });
                        return (
                          <div style={{
                            padding: '0.6rem', borderRadius: '8px', marginBottom: '0.4rem',
                            background: 'rgba(168,85,247,0.06)', border: '1px solid rgba(168,85,247,0.15)',
                          }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.2rem' }}>
                              <span style={{ fontSize: '0.7rem', color: '#a855f7', fontWeight: 600 }}>
                                מה השחקן רואה:
                              </span>
                              <span style={{ display: 'flex', gap: '0.25rem', fontSize: '0.58rem', color: 'var(--text-muted)' }}>
                                <span>{genDate}</span>
                                <span>·</span>
                                <span>{genSessions} אימונים</span>
                                <span>·</span>
                                <span>{allAtGen} שאלות</span>
                                <span>·</span>
                                <span style={{ color: '#22c55e' }}>✓{cAtGen}</span>
                                <span>·</span>
                                <span style={{ color: '#f59e0b' }}>~{nearMissAtGen}</span>
                                <span>·</span>
                                <span style={{ color: '#ef4444' }}>✗{wrongAtGen}</span>
                                <span>·</span>
                                <span style={{ fontWeight: 600 }}>{accAtGen}%</span>
                              </span>
                            </div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                              {insight.improvement}
                            </div>
                          </div>
                        );
                      })()}

                      {exploit && (() => {
                        const exGenSessions = typeof exploit.sessionsAtGeneration === 'number' ? exploit.sessionsAtGeneration : player.sessions.length;
                        const exSessionsAtGen = player.sessions.slice(0, exGenSessions);
                        let exQ = 0, exC = 0, exNearMiss = 0;
                        for (const s of exSessionsAtGen) {
                          for (const r of s.results) {
                            if (r.neutralized) continue;
                            if (r.nearMiss) { exNearMiss++; } else { exQ++; if (r.correct) exC++; }
                          }
                        }
                        const exWrong = exQ - exC;
                        const exAll = exQ + exNearMiss;
                        const exAcc = exQ > 0 ? Math.round((exC / exQ) * 100) : 0;
                        const exDate = new Date(exploit.generatedAt).toLocaleDateString('he-IL', { day: 'numeric', month: 'short', year: '2-digit' });
                        return (
                          <div style={{
                            padding: '0.6rem', borderRadius: '8px', marginBottom: '0.4rem',
                            background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.15)',
                          }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.2rem' }}>
                              <span style={{ fontSize: '0.7rem', color: '#ef4444', fontWeight: 600 }}>
                                🔒 לעיניך בלבד:
                              </span>
                              <span style={{ display: 'flex', gap: '0.25rem', fontSize: '0.58rem', color: 'var(--text-muted)' }}>
                                <span>{exDate}</span>
                                <span>·</span>
                                <span>{exGenSessions} אימונים</span>
                                <span>·</span>
                                <span>{exAll} שאלות</span>
                                <span>·</span>
                                <span style={{ color: '#22c55e' }}>✓{exC}</span>
                                <span>·</span>
                                <span style={{ color: '#f59e0b' }}>~{exNearMiss}</span>
                                <span>·</span>
                                <span style={{ color: '#ef4444' }}>✗{exWrong}</span>
                                <span>·</span>
                                <span style={{ fontWeight: 600 }}>{exAcc}%</span>
                              </span>
                            </div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                              {exploit.text}
                            </div>
                          </div>
                        );
                      })()}

                      {/* Action buttons */}
                      <div style={{ display: 'flex', gap: '0.4rem' }}>
                        <button
                          type="button"
                          onClick={() => handleGenerateInsight(player)}
                          disabled={generatingInsight === player.playerName || batchInsightsRunning}
                          style={{
                            flex: 1, padding: '0.5rem', borderRadius: '8px', border: 'none',
                            background: generatingInsight === player.playerName || batchInsightsRunning ? 'var(--surface-light)' : 'linear-gradient(135deg, #a855f7, #7c3aed)',
                            color: generatingInsight === player.playerName || batchInsightsRunning ? 'var(--text-muted)' : 'white',
                            fontWeight: 600, fontSize: '0.75rem', cursor: generatingInsight === player.playerName || batchInsightsRunning ? 'wait' : 'pointer',
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
                        <button
                          type="button"
                          onClick={() => {
                            if (sessionCleanMode === player.playerName) {
                              setSessionCleanMode(null);
                              setSelectedSessions(new Set());
                            } else {
                              setSessionCleanMode(player.playerName);
                              setSelectedSessions(new Set());
                            }
                          }}
                          disabled={cloudCleaningPlayer === player.playerName}
                          style={{
                            padding: '0.5rem 0.6rem', borderRadius: '8px',
                            border: `1px solid rgba(239,68,68,${sessionCleanMode === player.playerName ? '0.5' : '0.3'})`,
                            background: cloudCleaningPlayer === player.playerName
                              ? 'var(--surface-light)'
                              : sessionCleanMode === player.playerName
                                ? 'rgba(239,68,68,0.15)'
                                : 'rgba(239,68,68,0.08)',
                            color: cloudCleaningPlayer === player.playerName ? 'var(--text-muted)' : '#ef4444',
                            fontWeight: 600, fontSize: '0.7rem',
                            cursor: cloudCleaningPlayer === player.playerName ? 'wait' : 'pointer',
                            whiteSpace: 'nowrap',
                          }}
                          title="מוחק נתוני אימון מהענן — אם השחקן יתאמן שוב הוא יחזור לטבלה"
                        >
                          {cloudCleaningPlayer === player.playerName ? '⏳' : '🧹'}
                        </button>
                      </div>

                      {/* Session clean mode */}
                      {sessionCleanMode === player.playerName && (
                        <div style={{
                          marginTop: '0.5rem', padding: '0.6rem', borderRadius: '8px',
                          background: 'rgba(239,68,68,0.04)', border: '1px solid rgba(239,68,68,0.15)',
                        }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                            <span style={{ fontSize: '0.72rem', fontWeight: 600, color: '#ef4444' }}>
                              🧹 בחר אימונים למחיקה
                            </span>
                            <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
                              <button
                                type="button"
                                onClick={() => {
                                  if (selectedSessions.size === player.sessions.length) {
                                    setSelectedSessions(new Set());
                                  } else {
                                    setSelectedSessions(new Set(player.sessions.map((_, idx) => idx)));
                                  }
                                }}
                                style={{
                                  fontSize: '0.6rem', padding: '0.2rem 0.4rem', borderRadius: '4px',
                                  border: '1px solid rgba(239,68,68,0.2)', background: 'transparent',
                                  color: '#ef4444', cursor: 'pointer',
                                }}
                              >
                                {selectedSessions.size === player.sessions.length ? 'בטל הכל' : 'בחר הכל'}
                              </button>
                            </div>
                          </div>
                          <div style={{ maxHeight: '180px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                            {player.sessions.map((session, sIdx) => {
                              const isSelected = selectedSessions.has(sIdx);
                              const correct = session.results.filter(r => r.correct && !r.neutralized && !r.nearMiss).length;
                              const scored = session.results.filter(r => !r.neutralized && !r.nearMiss).length;
                              const acc = scored > 0 ? Math.round((correct / scored) * 100) : 0;
                              const dateStr = new Date(session.date).toLocaleDateString('he-IL', { day: 'numeric', month: 'short' });
                              return (
                                <div
                                  key={sIdx}
                                  onClick={() => {
                                    const next = new Set(selectedSessions);
                                    if (next.has(sIdx)) next.delete(sIdx); else next.add(sIdx);
                                    setSelectedSessions(next);
                                  }}
                                  style={{
                                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                    padding: '0.3rem 0.4rem', borderRadius: '6px', cursor: 'pointer',
                                    background: isSelected ? 'rgba(239,68,68,0.1)' : 'var(--surface)',
                                    border: isSelected ? '1px solid rgba(239,68,68,0.3)' : '1px solid transparent',
                                    direction: 'rtl',
                                  }}
                                >
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.7rem' }}>
                                    <span style={{ opacity: isSelected ? 1 : 0.3 }}>{isSelected ? '☑' : '☐'}</span>
                                    <span style={{ color: 'var(--text-muted)' }}>{dateStr}</span>
                                    <span>{session.results.length} שאלות</span>
                                  </div>
                                  <span style={{
                                    fontSize: '0.68rem', fontWeight: 600,
                                    color: acc >= 60 ? '#22c55e' : acc >= 40 ? '#eab308' : '#ef4444',
                                  }}>
                                    {acc}%
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                          <div style={{ display: 'flex', gap: '0.3rem', marginTop: '0.4rem' }}>
                            <button
                              type="button"
                              disabled={selectedSessions.size === 0 || cloudCleaningPlayer === player.playerName}
                              onClick={() => handleCleanPlayerFromCloud(
                                player.playerName,
                                selectedSessions.size === player.sessions.length ? undefined : selectedSessions,
                              )}
                              style={{
                                flex: 1, padding: '0.4rem', borderRadius: '6px', border: 'none',
                                background: selectedSessions.size === 0 ? 'var(--surface-hover)' : '#ef4444',
                                color: selectedSessions.size === 0 ? 'var(--text-muted)' : 'white',
                                fontWeight: 600, fontSize: '0.7rem',
                                cursor: selectedSessions.size === 0 ? 'default' : 'pointer',
                              }}
                            >
                              {cloudCleaningPlayer === player.playerName
                                ? '⏳ מוחק...'
                                : selectedSessions.size === player.sessions.length
                                  ? `🗑 מחק הכל (${selectedSessions.size})`
                                  : selectedSessions.size > 0
                                    ? `🗑 מחק ${selectedSessions.size} אימונים`
                                    : 'בחר אימונים'}
                            </button>
                            <button
                              type="button"
                              onClick={() => { setSessionCleanMode(null); setSelectedSessions(new Set()); }}
                              style={{
                                padding: '0.4rem 0.6rem', borderRadius: '6px',
                                border: '1px solid var(--border)', background: 'transparent',
                                color: 'var(--text-muted)', fontSize: '0.7rem', cursor: 'pointer',
                              }}
                            >
                              ביטול
                            </button>
                          </div>
                        </div>
                      )}
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

          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.45rem',
          }}>
            <label style={{
              fontSize: '0.65rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.35rem',
              cursor: 'pointer', userSelect: 'none',
            }}>
              <input
                type="checkbox"
                checked={showFixStepDetails}
                onChange={e => setShowFixStepDetails(e.target.checked)}
                style={{ accentColor: '#6366f1' }}
              />
              הצג פירוט שלבים (תיקון AI)
            </label>
            {fixDetailLog.length > 0 && (
              <button
                type="button"
                onClick={() => clearFixLog()}
                disabled={fixingFlagged !== null || regenerating || savingFix}
                style={{
                  fontSize: '0.6rem', padding: '0.2rem 0.45rem', borderRadius: '6px',
                  border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-muted)',
                  cursor: fixingFlagged || regenerating || savingFix ? 'wait' : 'pointer',
                }}
              >
                נקה יומן
              </button>
            )}
          </div>

          {(showFixStepDetails || fixDetailLog.some(l => l.level === 'error')) && fixDetailLog.length > 0 && (
            <div style={{
              marginBottom: '0.5rem', padding: '0.5rem 0.55rem', borderRadius: '8px',
              background: 'rgba(15,23,42,0.5)', border: '1px solid var(--border)',
              maxHeight: '220px', overflowY: 'auto', direction: 'rtl', textAlign: 'right',
            }}>
              <div style={{ fontSize: '0.6rem', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '0.35rem' }}>
                יומן שלבי תיקון
              </div>
              {fixDetailLog.map((line, i) => (
                <div
                  key={i}
                  style={{
                    fontSize: '0.62rem', lineHeight: 1.45, marginBottom: '0.25rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    color: line.level === 'error' ? '#f87171' : line.level === 'success' ? '#4ade80' : 'var(--text-muted)',
                  }}
                >
                  <span style={{ opacity: 0.85 }}>{line.level === 'error' ? '✗' : line.level === 'success' ? '✓' : '·'}</span>
                  {' '}
                  {line.text}
                </div>
              ))}
            </div>
          )}

          {flagMsg && (
            <div style={{
              padding: '0.4rem 0.6rem', borderRadius: '6px', marginBottom: '0.5rem',
              fontSize: '0.75rem', fontWeight: 500, textAlign: 'center',
              background: flagMsg.includes('✅') ? 'rgba(34,197,94,0.08)' : flagMsg.includes('❌') ? 'rgba(239,68,68,0.08)' : flagMsg.includes('⚠️') ? 'rgba(245,158,11,0.08)' : 'rgba(99,102,241,0.08)',
              color: flagMsg.includes('✅') ? 'var(--success)' : flagMsg.includes('❌') ? 'var(--danger)' : flagMsg.includes('⚠️') ? '#f59e0b' : 'var(--text-muted)',
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
                    <span style={{ fontWeight: 600, color: '#94a3b8' }}>קלפים:&nbsp;</span>
                    <TrainingColoredCards text={f.scenario.yourCards} />
                  </div>
                )}
                {f.scenario?.boardCards?.trim() && (
                  <div style={{
                    fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '0.25rem',
                    display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.35rem',
                  }}>
                    <span style={{ fontWeight: 600, color: '#94a3b8' }}>לוח (פלופ / טרן / ריבר):</span>
                    <span style={{
                      display: 'inline-flex', flexWrap: 'wrap', gap: '0.2rem', alignItems: 'center',
                      padding: '0.2rem 0.45rem', borderRadius: '6px',
                      background: 'rgba(15, 23, 42, 0.55)', border: '1px solid rgba(148, 163, 184, 0.28)',
                      fontSize: '0.78rem', lineHeight: 1.35,
                    }}>
                      <TrainingColoredCards text={f.scenario.boardCards.trim()} />
                    </span>
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
                        f.scenario?.boardCards?.trim() ? `🂠 בורד: ${f.scenario.boardCards.trim()}` : '',
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
                            onClick={() => shareAnalysisAsImage(fullWhatsApp)}
                            style={{
                              fontSize: '0.65rem', padding: '0.3rem 0.6rem', borderRadius: '6px',
                              background: '#25D366', color: 'white', border: 'none',
                              cursor: 'pointer', fontWeight: 600, width: '100%',
                            }}
                          >
                            📤 שתף כתמונה
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

                {/* Action buttons — before analysis: analyze+fix is primary, analyze-only + dismiss + remove as secondary */}
                {!analyses[f.poolId] && (
                  <div style={{ display: 'flex', gap: '0.3rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                    <button
                      onClick={() => handleAnalyzeAndFix(f.poolId, f.scenario, f.reports)}
                      disabled={isBusy || fixingFlagged === f.poolId}
                      style={{
                        flex: 1, fontSize: '0.65rem', padding: '0.35rem 0.5rem', borderRadius: '6px',
                        background: 'rgba(168,85,247,0.15)', color: '#a855f7',
                        border: '1px solid rgba(168,85,247,0.3)', cursor: isBusy ? 'wait' : 'pointer',
                        fontWeight: 600, opacity: isBusy ? 0.5 : 1,
                      }}
                    >
                      {fixingFlagged === f.poolId ? '⏳ מנתח ומתקן...' : '✨ נתח + תקן'}
                    </button>
                    <button
                      onClick={() => handleAnalyzeReport(f.poolId, f.scenario, f.reports)}
                      disabled={isBusy || analyzingReport === f.poolId}
                      style={{
                        fontSize: '0.65rem', padding: '0.35rem 0.5rem', borderRadius: '6px',
                        background: 'rgba(99,102,241,0.08)', color: '#6366f1',
                        border: '1px solid rgba(99,102,241,0.15)', cursor: isBusy ? 'wait' : 'pointer',
                        fontWeight: 500, opacity: isBusy ? 0.5 : 1,
                      }}
                    >
                      {analyzingReport === f.poolId ? '⏳' : '🔍 נתח'}
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
              {fixPreview.original.boardCards?.trim() && (
                <div style={{
                  fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '0.2rem',
                  display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.35rem',
                }}>
                  <span style={{ fontWeight: 600, color: '#94a3b8' }}>בורד:</span>
                  <span style={{
                    display: 'inline-flex', flexWrap: 'wrap', gap: '0.2rem', alignItems: 'center',
                    padding: '0.15rem 0.4rem', borderRadius: '6px',
                    background: 'rgba(15, 23, 42, 0.55)', border: '1px solid rgba(148, 163, 184, 0.28)',
                    fontSize: '0.72rem', lineHeight: 1.35,
                  }}>
                    <TrainingColoredCards text={fixPreview.original.boardCards.trim()} />
                  </span>
                </div>
              )}
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
              {fixPreview.fixed.boardCards?.trim() && (
                <div style={{
                  fontSize: '0.65rem', color: 'var(--text-muted)', marginBottom: '0.2rem',
                  display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.35rem',
                }}>
                  <span style={{ fontWeight: 600, color: '#94a3b8' }}>בורד:</span>
                  <span style={{
                    display: 'inline-flex', flexWrap: 'wrap', gap: '0.2rem', alignItems: 'center',
                    padding: '0.15rem 0.4rem', borderRadius: '6px',
                    background: 'rgba(15, 23, 42, 0.55)', border: '1px solid rgba(148, 163, 184, 0.28)',
                    fontSize: '0.72rem', lineHeight: 1.35,
                  }}>
                    <TrainingColoredCards text={fixPreview.fixed.boardCards.trim()} />
                  </span>
                </div>
              )}
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

            {fixDetailLog.length > 0 && (
              <details
                open={savingFix || fixDetailLog.some(l => l.level === 'error')}
                style={{ marginBottom: '0.6rem', borderRadius: '8px', border: '1px solid var(--border)', padding: '0.35rem 0.5rem' }}
              >
                <summary style={{ fontSize: '0.65rem', cursor: 'pointer', color: 'var(--text-muted)', fontWeight: 600 }}>
                  פירוט שלבים ({fixDetailLog.length})
                </summary>
                <div style={{
                  marginTop: '0.35rem', maxHeight: '140px', overflowY: 'auto', direction: 'rtl', textAlign: 'right',
                }}>
                  {fixDetailLog.map((line, i) => (
                    <div
                      key={i}
                      style={{
                        fontSize: '0.58rem', lineHeight: 1.4, marginBottom: '0.2rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                        color: line.level === 'error' ? '#f87171' : line.level === 'success' ? '#4ade80' : 'var(--text-muted)',
                      }}
                    >
                      {line.level === 'error' ? '✗' : line.level === 'success' ? '✓' : '·'} {line.text}
                    </div>
                  ))}
                </div>
              </details>
            )}

            {/* WhatsApp share to reporter */}
            {(() => {
              const a = fixPreview ? analyses[fixPreview.poolId] : null;
              if (!a) return null;
              const shareText = a.verdict === 'accept' ? a.acceptText :
                a.verdict === 'reject' ? a.rejectText :
                a.acceptText || a.rejectText;
              if (!shareText) return null;
              const fq = flagged.find(q => q.poolId === fixPreview.poolId);
              const reporterName = fq?.reports[0]?.playerName || '';
              const reporterComment = fq?.reports[0]?.comment || '';
              const scenario = fixPreview.original;
              const correctOpt = scenario?.options?.find(o => o.isCorrect);
              const questionContext = [
                scenario?.yourCards ? `🃏 קלפים: ${scenario.yourCards}` : '',
                scenario?.boardCards?.trim() ? `🂠 בורד: ${scenario.boardCards.trim()}` : '',
                scenario?.situation ? `📋 ${scenario.situation}` : '',
                correctOpt ? `✅ תשובה: ${correctOpt.text}` : '',
              ].filter(Boolean).join('\n');
              const reportContext = reporterComment ? `\n💬 דיווחת: "${reporterComment}"` : '';
              const fullWhatsApp = `היי ${reporterName}! 🎯\n\nלגבי הדיווח שלך על שאלת אימון:\n\n${questionContext}${reportContext}\n\n${shareText}\n\n— Poker Manager 🃏`;
              return (
                <div style={{
                  marginBottom: '0.6rem', padding: '0.5rem',
                  borderRadius: '8px',
                  background: 'rgba(37,211,102,0.06)',
                  border: '1px solid rgba(37,211,102,0.15)',
                }}>
                  <div style={{ fontSize: '0.65rem', fontWeight: 600, marginBottom: '0.25rem', color: '#25D366' }}>
                    💬 הודעה למדווח ({reporterName}):
                  </div>
                  <div style={{ fontSize: '0.62rem', color: 'var(--text)', padding: '0.3rem',
                    borderRadius: '4px', background: 'rgba(255,255,255,0.03)',
                    lineHeight: 1.5, marginBottom: '0.3rem', whiteSpace: 'pre-line',
                    maxHeight: '6rem', overflowY: 'auto',
                  }}>
                    {fullWhatsApp}
                  </div>
                  <button
                    onClick={() => shareAnalysisAsImage(fullWhatsApp)}
                    style={{
                      fontSize: '0.7rem', padding: '0.35rem 0.6rem', borderRadius: '6px',
                      background: '#25D366', color: 'white', border: 'none',
                      cursor: 'pointer', fontWeight: 600, width: '100%',
                    }}
                  >
                    📤 שתף כתמונה בוואטסאפ
                  </button>
                </div>
              );
            })()}

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

      {/* Styled confirm modal — replaces the legacy native confirm()
          dialog for owner-only cloud cleanup actions. */}
      {confirmDialog && (
        <div
          className="modal-overlay"
          onClick={() => !confirmDialogBusy && setConfirmDialog(null)}
        >
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 380, direction: 'rtl' }}>
            <div className="modal-header">
              <h3 className="modal-title">מחיקה מהענן</h3>
              <button
                className="modal-close"
                onClick={() => setConfirmDialog(null)}
                disabled={confirmDialogBusy}
                aria-label="סגור"
              >×</button>
            </div>
            <p style={{ fontSize: '0.9rem', marginBottom: '1rem', lineHeight: 1.5, color: 'var(--text)' }}>
              {confirmDialog.body}
            </p>
            <div className="actions">
              <button
                className="btn btn-secondary"
                onClick={() => setConfirmDialog(null)}
                disabled={confirmDialogBusy}
              >
                ביטול
              </button>
              <button
                className="btn"
                onClick={runConfirmDialog}
                disabled={confirmDialogBusy}
                style={{
                  background: '#ef4444', color: '#fff', fontWeight: 600,
                  opacity: confirmDialogBusy ? 0.7 : 1,
                  cursor: confirmDialogBusy ? 'wait' : 'pointer',
                }}
              >
                {confirmDialogBusy ? '...' : 'מחק'}
              </button>
            </div>
          </div>
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
