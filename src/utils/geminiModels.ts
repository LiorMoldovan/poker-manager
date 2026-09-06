import type { TranslationKey } from '../i18n/translations';

// ──────────────────────────────────────────────────────────────────────
// Central registry of every Gemini model id the app pins.
//
// These ids used to be string literals scattered across six files, each
// list tuned separately against its own failure history. That was fine
// until Google retired one out from under us: nothing could answer
// "which models are we actually depending on?", so a deprecation only
// surfaced as a 404 in production. The Settings → Services model checker
// reads `PINNED_MODELS` and diffs it against the live ListModels
// response, which only works while this file is the single source of
// truth. Import the constants; don't re-introduce literals.
//
// Model choice is still per-call-site — the constants below are named
// for the JOB, not the vendor's tier, because the reason a given path
// picked a given model is the part worth preserving across a swap.
// ──────────────────────────────────────────────────────────────────────

// Creative long-form generation: forecasts, summaries, chronicles,
// graph insights — the output members actually read. Newest GA Flash,
// free tier. Promoted in v6.28.0 from gemini-3-flash-preview (a
// December-2025 preview) on the straightforward theory that the newest
// generally-available model writes better; the chain below means a bad
// bet costs one wasted call, not an outage.
//
// Note this is a "short-term availability" release: Google may retire it
// 45 days after a successor ships. That used to be a reason to avoid it,
// because we'd find out from a 404 in production. Two things changed —
// callWithFallback treats 404 as "try the next model", so retirement
// degrades silently to the slot below, and the Settings model checker
// now surfaces it explicitly.
export const TEXT_PRIMARY = 'gemini-3.8-flash';

// Long-term anchor directly behind the primary. Google guarantees it to
// at least 2027-05-19, so however the short-term releases above churn,
// the chain always has a supported model one step down.
export const TEXT_SECONDARY = 'gemini-3.5-flash';

// Third slot, and the model everything ran on until v6.28.0. Kept
// because it is known-good against these specific Hebrew prompts: if a
// newer model reads worse, this is the voice we are comparing against.
// Deprecated by Google but with no announced shutdown date. Doubles as
// the chip-count model — see CHIP_COUNT_MODEL below, same id, different
// reason, deliberately separate constants so one can move without the
// other.
export const TEXT_FALLBACK_PREVIEW = 'gemini-3-flash-preview';

// Last-ditch. Weakest of the four, but a thin forecast beats no
// forecast when everything above is rate-limited. GA, retires
// 2027-05-07 (successor: gemini-3.5-flash-lite).
export const TEXT_FALLBACK_LITE = 'gemini-3.1-flash-lite';

// Chip counting from a photo. Deliberately a single model with no
// fallback: v6.4.1 removed gemini-2.5-flash from this chain after
// telemetry showed it returned "10" for every colour rather than
// counting. Do not add a fallback here without a photo test set —
// a confidently wrong count is worse than an error.
export const CHIP_COUNT_MODEL = 'gemini-3-flash-preview';

// Deterministic structured extraction on a latency budget: comic
// bounding boxes, training pool generation, training content scan.
// These want fast and cheap over clever — pool generation in particular
// has to fit inside the ~25s Vercel Edge timeout. Long-term GA, safe to
// at least 2027-07-21. Replaced gemini-2.5-flash in v6.28.0.
export const STRUCTURED_FAST = 'gemini-3.5-flash-lite';

// Hebrew speech. No longer listed in Google's current lineup; the
// successor is gemini-3.1-flash-tts-preview, which needs a voice
// comparison pass before switching (the voice names differ).
export const TTS_MODEL = 'gemini-2.5-flash-preview-tts';

export interface PinnedModel {
  model: string;
  /** i18n key describing what this model is responsible for. */
  roleKey: TranslationKey;
}

// What the model checker diffs against the live ListModels response.
// Deduplicated by model id — TEXT_PRIMARY and CHIP_COUNT_MODEL currently
// point at the same model, and reporting it twice would just be noise.
export const PINNED_MODELS: readonly PinnedModel[] = [
  { model: TEXT_PRIMARY, roleKey: 'settings.models.role.text' },
  { model: TEXT_SECONDARY, roleKey: 'settings.models.role.fallback' },
  { model: TEXT_FALLBACK_PREVIEW, roleKey: 'settings.models.role.chipCount' },
  { model: TEXT_FALLBACK_LITE, roleKey: 'settings.models.role.lastResort' },
  { model: STRUCTURED_FAST, roleKey: 'settings.models.role.structured' },
  { model: TTS_MODEL, roleKey: 'settings.models.role.tts' },
];

// Family version out of a model id: gemini-3.5-flash-lite → 3.5,
// gemini-3-flash-preview → 3. Returns null for anything that doesn't
// start with a gemini version number, which is how non-Gemini entries
// in the ListModels response (gemma, imagen, veo) get filtered out.
export function modelVersion(id: string): number | null {
  const m = /^gemini-(\d+(?:\.\d+)?)/.exec(id.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

// Specialised variants we don't want to propose as drop-in upgrades for
// a text or structured slot. Suggesting an embedding model as "newer"
// would be worse than saying nothing.
const NON_SUBSTITUTABLE = /embedding|imagen|veo|gemma|aqa|native-audio|live|-image|-tts|thinking/;

export interface ModelScan {
  /** Pinned models Google no longer lists — these will 404 in production. */
  missing: PinnedModel[];
  /** Available models from a newer family than anything we pin. */
  newer: string[];
}

/**
 * Diff the live ListModels response against what the app pins.
 *
 * The `missing` half is the one that matters: a pinned model absent from
 * the list is either retired or not available to this API key's tier,
 * and both mean the calls using it are failing (or about to). `newer` is
 * advisory — a newer family exists, go read its release notes — and is
 * deliberately not turned into an automatic swap, because a higher
 * version number says nothing about whether the prompts still land or
 * whether the model is a short-term-availability release that will be
 * pulled again in 45 days.
 */
export function scanModels(availableIds: string[]): ModelScan {
  const available = new Set(availableIds.map(id => id.replace(/^models\//, '').trim()));

  const missing = PINNED_MODELS.filter(p => !available.has(p.model));

  const pinnedVersions = PINNED_MODELS
    .map(p => modelVersion(p.model))
    .filter((v): v is number => v !== null);
  const newestPinned = pinnedVersions.length ? Math.max(...pinnedVersions) : 0;

  const pinnedIds = new Set(PINNED_MODELS.map(p => p.model));
  const newer = [...available]
    .filter(id => !pinnedIds.has(id))
    .filter(id => !NON_SUBSTITUTABLE.test(id))
    .filter(id => {
      const v = modelVersion(id);
      return v !== null && v > newestPinned;
    })
    .sort((a, b) => (modelVersion(b) ?? 0) - (modelVersion(a) ?? 0) || a.localeCompare(b));

  return { missing, newer };
}
