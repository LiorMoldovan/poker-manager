/**
 * Game-Night Comic generation orchestrator.
 *
 * Wires the three Gemini stages together, uploads the PNG to Supabase
 * Storage, and saves the metadata onto the game row. Designed to be
 * called from the UI's "Generate Comic" button (admin only).
 *
 * Failure model: each stage either succeeds or throws a localized error
 * message. The caller (GameSummaryScreen) shows the error inline and
 * leaves the section in the "no comic" state — never auto-retries.
 */

import {
  generateComicScript,
  generateComicArt,
  detectComicBoundingBoxes,
  getGeminiApiKey,
  getModelDisplayName,
} from './geminiAI';
import {
  pickStyleForGame,
  ComicVibePayload,
  COMIC_STYLE_ORDER,
} from './comicStyles';
import { uploadComicImage, saveGameComic, deleteComicAsset, clearGameComic } from '../database/storage';
import { ComicStyleKey } from '../types';

export interface ComicGenerationInput {
  gameId: string;
  /** Same payload shape that drives the AI text summary. */
  vibe: ComicVibePayload;
  date: string;       // ISO
  weekday: string;    // already-formatted Hebrew weekday
  totalPot: number;
  totalRebuys: number;
  /** Drama context — same fields fed to generateGameNightSummary. */
  recordsBroken: string[];
  notableStreaks: string[];
  upsets: string[];
  rankingShifts: string[];
  comboHistoryText?: string;
  /**
   * If set, force this exact style. Used by the "Regenerate (next style)"
   * button. If omitted, the orchestrator picks the style from the vibe.
   */
  forceStyle?: ComicStyleKey;
  /**
   * If set, picks the next style after this one in the rotation. Used so
   * "Regenerate" cycles instead of repeating.
   */
  cycleFromStyle?: ComicStyleKey;
  /** Progress reporter for the UI. */
  onProgress?: (stage: 'script' | 'art' | 'bbox' | 'upload') => void;
}

export interface ComicGenerationResult {
  url: string;
  style: ComicStyleKey;
  scriptModel: string;
  imageModel: string;
}

/** How many times an admin may regenerate a single game's comic. */
export const MAX_REGENERATIONS_PER_GAME = 3;

/** Style cycle helper — exposed so the UI can preview "next style" labels. */
export const nextStyleAfter = (current?: ComicStyleKey): ComicStyleKey => {
  if (!current) return COMIC_STYLE_ORDER[0];
  const idx = COMIC_STYLE_ORDER.indexOf(current);
  return COMIC_STYLE_ORDER[(idx + 1) % COMIC_STYLE_ORDER.length];
};

/**
 * Stage-tagged error so the UI / logs can show *which* step failed
 * (script / art / bbox / upload) instead of a flat error string.
 */
export class ComicStageError extends Error {
  readonly stage: 'script' | 'art' | 'bbox' | 'upload';
  readonly cause?: unknown;
  constructor(stage: 'script' | 'art' | 'bbox' | 'upload', message: string, cause?: unknown) {
    super(message);
    this.name = 'ComicStageError';
    this.stage = stage;
    this.cause = cause;
  }
}

export const generateGameComic = async (
  input: ComicGenerationInput,
): Promise<ComicGenerationResult> => {
  if (!getGeminiApiKey()) throw new Error('NO_API_KEY');
  if (!navigator.onLine) throw new Error('OFFLINE');

  const pipelineStart = Date.now();
  // eslint-disable-next-line no-console
  console.log('[comic] pipeline:start', { gameId: input.gameId, players: input.vibe.tonight.length });

  // Best-effort cleanup of any stale storage object before re-uploading
  // (upsert overwrites anyway but this also clears any half-finished prior
  //  state if the bucket cache-control is aggressive).
  try { await deleteComicAsset(input.gameId); } catch { /* ignore */ }

  // ── Decide style ──
  const styleKey: ComicStyleKey = input.forceStyle
    ?? pickStyleForGame(input.vibe, input.cycleFromStyle);
  // eslint-disable-next-line no-console
  console.log('[comic] pipeline:style_picked', { styleKey, forced: !!input.forceStyle, cycledFrom: input.cycleFromStyle });

  // ── Stage 1: script ──
  input.onProgress?.('script');
  let rawScript;
  let scriptModel;
  try {
    const out = await generateComicScript(
      {
        date: formatDateShort(input.date),
        weekday: input.weekday,
        tonight: input.vibe.tonight.map((p, i) => ({
          name: p.name,
          profit: Math.round(p.profit),
          rebuys: p.rebuys,
          rank: i + 1,
        })),
        totalPot: Math.round(input.totalPot),
        totalRebuys: input.totalRebuys,
        recordsBroken: input.recordsBroken,
        notableStreaks: input.notableStreaks,
        upsets: input.upsets,
        rankingShifts: input.rankingShifts,
        comboHistoryText: input.comboHistoryText,
        styleVibe: styleVibeFor(styleKey),
      },
      styleKey,
    );
    rawScript = out.script;
    scriptModel = out.model;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[comic] pipeline:fail_at_script', { message: err instanceof Error ? err.message : String(err) });
    throw new ComicStageError('script', err instanceof Error ? err.message : String(err), err);
  }

  // ── Stage 2: art ──
  // Pollinations.ai (anonymous FLUX). 60-90s typical latency on free tier.
  input.onProgress?.('art');
  let art;
  try {
    art = await generateComicArt(rawScript);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[comic] pipeline:fail_at_art', { message: err instanceof Error ? err.message : String(err) });
    throw new ComicStageError('art', err instanceof Error ? err.message : String(err), err);
  }

  // ── Stage 3: bboxes (best-effort — never fatal) ──
  input.onProgress?.('bbox');
  let scriptWithBoxes = rawScript;
  try {
    scriptWithBoxes = await detectComicBoundingBoxes(art.base64, art.mimeType, rawScript);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[comic] bbox detection threw (non-fatal):', err);
  }

  scriptWithBoxes = {
    ...scriptWithBoxes,
    width: art.width,
    height: art.height,
    modelImage: getModelDisplayName(art.model),
  };

  // ── Upload PNG to Storage and save metadata to games row ──
  input.onProgress?.('upload');
  let url: string;
  try {
    const blob = base64ToBlob(art.base64, art.mimeType);
    url = await uploadComicImage(input.gameId, blob);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[comic] pipeline:fail_at_upload', { message: err instanceof Error ? err.message : String(err) });
    throw new ComicStageError('upload', err instanceof Error ? err.message : String(err), err);
  }

  // Clear-then-save sequence so the realtime fan-out shows the new state cleanly.
  clearGameComic(input.gameId);
  saveGameComic(input.gameId, url, scriptWithBoxes, styleKey);

  // eslint-disable-next-line no-console
  console.log('[comic] pipeline:success', {
    gameId: input.gameId,
    styleKey,
    scriptModel,
    imageModel: art.model,
    totalMs: Date.now() - pipelineStart,
  });

  return {
    url,
    style: styleKey,
    scriptModel: scriptModel,
    imageModel: art.model,
  };
};

// ─── helpers ───────────────────────────────────────────────────

const styleVibeFor = (key: ComicStyleKey): string => {
  // Inline import-free lookup — keeps the orchestrator tree-shake friendly.
  // Falls back to a generic vibe if a style somehow isn't found.
  switch (key) {
    case 'newspaper': return 'lighthearted Sunday-comic warmth';
    case 'manga': return 'high tension, dramatic stakes';
    case 'noir': return 'fatalistic, brooding, smoke-and-shadow';
    case 'pixar3d': return 'warm, character-driven, optimistic';
    case 'tintin': return 'understated, witty, observational';
    case 'retro70s': return 'kinetic, surreal, slightly stoned';
    default: return 'observational with a punchline at the end';
  }
};

const formatDateShort = (iso: string): string => {
  try {
    const d = new Date(iso);
    return `${d.getDate()}/${d.getMonth() + 1}`;
  } catch {
    return iso;
  }
};

const base64ToBlob = (b64: string, mimeType: string): Blob => {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
};
