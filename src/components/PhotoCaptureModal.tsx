import { useEffect, useRef, useState } from 'react';
import { ChipValue, PhotoChipCountResult, PhotoChipCountErrorCode } from '../types';
import { downscaleImage, enhanceForChipCounting, varianceOfLaplacian } from '../utils/imageUtils';
import { countChipsFromPhoto } from '../utils/geminiAI';
import { useTranslation, type TranslationKey } from '../i18n';

// Static map from PhotoChipCountErrorCode to translation key. Built
// statically (rather than concatenating `chips.photo.error.code.${code}`
// at call sites) so TypeScript's strict TranslationKey union catches
// any drift between the code enum and the i18n bundle. Adding a new
// code without adding the matching key here is a compile error, which
// is what we want.
const ERROR_CODE_TO_TRANSLATION: Record<PhotoChipCountErrorCode, TranslationKey> = {
  missingImage:         'chips.photo.error.code.missingImage',
  noChipsConfig:        'chips.photo.error.code.noChipsConfig',
  network:              'chips.photo.error.code.network',
  httpError:            'chips.photo.error.code.httpError',
  parseFailed:          'chips.photo.error.code.parseFailed',
  unexpectedShape:      'chips.photo.error.code.unexpectedShape',
  cancelled:            'chips.photo.error.code.cancelled',
  stackDetectionFailed: 'chips.photo.error.code.stackDetectionFailed',
  quotaExceeded:        'chips.photo.error.code.quotaExceeded',
};

/**
 * Reusable modal for capturing a chip photo and getting back per-color
 * counts via Gemini Vision.
 *
 * Used in two places:
 *   1. ChipEntryScreen — per-player flow, with `expectedTotalValue` set
 *      so the AI can lower confidence on totals far from expected.
 *   2. SettingsScreen Services tab — standalone test card, no
 *      expectedTotalValue, no game context.
 *
 * Lifecycle: caller controls open/close via `isOpen`. On a successful
 * AI call, `onResult(result, previewBase64)` fires and the modal stays
 * open ONLY long enough to show "done"; caller decides whether to
 * close or keep open. We pass the previewBase64 back so the caller can
 * display a thumbnail next to the populated counts.
 *
 * MANUAL-FLOW PROTECTION: this modal is purely additive UI. It never
 * touches game state directly — the caller takes the result and
 * decides what to do with it. Closing the modal mid-flight aborts the
 * Gemini call (AbortController) and returns nothing.
 */

const BLUR_THRESHOLD = 50; // empirical: below this, ring-counting becomes unreliable
// v5.60.3: if the AI's own self-reported overall confidence is below
// this threshold, we DON'T auto-apply the result. Instead we surface
// a review screen showing the proposed counts and let the user
// choose between "apply anyway" and "retake". 50% is the threshold
// chosen empirically — at confidence < 50 the AI is essentially
// guessing per-stack and the per-player chip totals end up wrong
// often enough that silent auto-apply is more cost than benefit.
const LOW_CONFIDENCE_THRESHOLD = 50;

type Phase = 'instruction' | 'preview' | 'processing' | 'error' | 'lowConfidence';

interface PhotoCaptureModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Fires once with the AI result. `previewBase64` is the ENHANCED
   * image we sent to the model (NOT the raw camera output) — that's
   * the image the developer would need to replay any failure case,
   * so it's also what gets uploaded if the group has opted in to
   * the chip-count feedback photo bucket. `previewMimeType` is the
   * matching content-type for that base64 (always `image/jpeg` at
   * present, but plumbed explicitly so a future PNG path stays
   * sound).
   */
  onResult: (result: PhotoChipCountResult, previewBase64: string, previewMimeType: string) => void;
  chipValues: ChipValue[];
  expectedTotalValue?: number;
  /** Title shown in the modal header. Defaults to a generic Hebrew string. */
  title?: string;
  /** Telemetry tag (v5.62.4) — passed straight into `countChipsFromPhoto`
   *  so the `chip_count_debug` row records WHICH call site this came
   *  from. Defaults to 'unknown'. The live-game flow should set
   *  'live-game'; the Settings test card should set 'settings-test'. */
  debugContext?: 'live-game' | 'settings-test' | 'unknown';
}

const PhotoCaptureModal = ({
  isOpen,
  onClose,
  onResult,
  chipValues,
  expectedTotalValue,
  title,
  debugContext = 'unknown',
}: PhotoCaptureModalProps) => {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('instruction');

  // Canonical photo arrangement order shown in the instructions —
  // ascending by denomination, exactly the order countChipsFromPhoto
  // also uses to label positions. Computed here (not as a prop) so the
  // modal and the AI ALWAYS agree on what the user is being told to do.
  const orderedChips: ChipValue[] = [...chipValues].sort((a, b) => a.value - b.value);
  const [previewUrl, setPreviewUrl] = useState<string>('');
  const [previewBase64, setPreviewBase64] = useState<string>('');
  const [previewMimeType, setPreviewMimeType] = useState<string>('image/jpeg');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [statusMsg, setStatusMsg] = useState<string>('');
  // v5.60.3: when AI confidence is below LOW_CONFIDENCE_THRESHOLD we
  // hold the result here instead of applying it, and the
  // `lowConfidence` phase renders a review screen with "apply anyway"
  // / "retake" buttons. Cleared on every modal open (see reset effect
  // below) and on any explicit retake/apply action.
  const [pendingResult, setPendingResult] = useState<PhotoChipCountResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Reset state whenever the modal opens.
  useEffect(() => {
    if (isOpen) {
      setPhase('instruction');
      setPreviewUrl('');
      setPreviewBase64('');
      setErrorMsg('');
      setStatusMsg('');
      setPendingResult(null);
    } else {
      // Modal closed — abort any in-flight Gemini call.
      abortRef.current?.abort();
      abortRef.current = null;
    }
  }, [isOpen]);

  // Free preview blob URL on unmount/preview change to avoid leaking memory.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  if (!isOpen) return null;

  const openCamera = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;

    setPhase('processing');
    setStatusMsg(t('chips.photo.status.preparing'));

    try {
      // Step 1 — downscale to 1280px @ JPEG 0.92. Blocks payload size
      // for the Vercel proxy and gives the AI consistent input sizing.
      const downscaled = await downscaleImage(file, 1280);

      // Step 2 — vision-targeted preprocessing: auto-crop to the
      // chip-stack region (Sobel edge bounding box + 8% padding) and
      // per-channel histogram stretch to restore contrast on the
      // white-on-color edge rings. Falls back to the unenhanced
      // downscale on any failure (always returns a usable image).
      setStatusMsg(t('chips.photo.status.enhancing'));
      const enhanced = await enhanceForChipCounting(downscaled);

      setPreviewBase64(enhanced.base64);
      setPreviewMimeType(enhanced.mimeType);

      // Build a blob URL preview FROM THE ORIGINAL file (so the user
      // sees what they shot, not the auto-cropped version we send to
      // the AI). Cheaper than re-decoding the base64 for an <img>.
      const url = URL.createObjectURL(file);
      setPreviewUrl(url);

      setStatusMsg(t('chips.photo.status.checking'));
      // Run blur check on the ENHANCED image (the one we'll actually
      // send) — the histogram stretch might bump a borderline-blurry
      // photo above the threshold by sharpening the edge contrast.
      const blur = await varianceOfLaplacian(enhanced.base64, enhanced.mimeType);
      if (blur > 0 && blur < BLUR_THRESHOLD) {
        setPhase('error');
        setErrorMsg(t('chips.photo.error.blurry'));
        return;
      }

      setPhase('preview');
      setStatusMsg('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setPhase('error');
      setErrorMsg(`${t('chips.photo.error.imageFailed')}: ${msg}`);
    }
  };

  const handleAnalyze = async () => {
    setPhase('processing');
    setStatusMsg(t('chips.photo.status.analyzing'));

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await countChipsFromPhoto({
        imageBase64: previewBase64,
        mimeType: previewMimeType,
        chipValues,
        expectedTotalValue,
        debugContext,
        abortSignal: controller.signal,
        // Live status updates throughout the per-stack pipeline (v5.59
        // rebuild). The orchestrator emits four primary phases —
        // `detecting-stacks`, `calibrating`, `counting-stacks` (with
        // a stackIndex/stackTotal so we can render "3/6"), and
        // `reconciling-totals` (only fires when expectedTotalValue is
        // set). The legacy `attempting` phase is still typed for
        // backward-compat with any pre-rebuild caller; new pipeline
        // doesn't emit it.
        onProgress: ({ phase, modelDisplay, attempt, stackIndex, stackTotal }) => {
          if (phase === 'detecting-stacks') {
            setStatusMsg(t('chips.photo.status.detectingStacks'));
          } else if (phase === 'calibrating') {
            setStatusMsg(t('chips.photo.status.calibrating'));
          } else if (phase === 'counting-stacks') {
            const total = stackTotal ?? 0;
            const idx = stackIndex ?? 0;
            const tail = modelDisplay ? ` · ${modelDisplay}` : '';
            setStatusMsg(`${t('chips.photo.status.countingStacks')} ${idx}/${total}${tail}`);
          } else if (phase === 'reconciling-totals') {
            setStatusMsg(t('chips.photo.status.reconciling'));
          } else if (phase === 'attempting') {
            // Legacy path — kept so older orchestrators don't go silent.
            const key: TranslationKey = attempt === 0
              ? 'chips.photo.status.askingModel'
              : 'chips.photo.status.tryingFallback';
            setStatusMsg(`${t(key)} (${modelDisplay})`);
          }
        },
      });

      if (controller.signal.aborted) return;

      if (result.error) {
        setPhase('error');
        // Build the displayed error message.
        //   * Localized headline (one of `chips.photo.error.code.*`) goes
        //     first so the user sees the human-readable summary.
        //   * For `parseFailed` / `unexpectedShape` / `httpError` we
        //     APPEND the raw `result.error` payload — these are the cases
        //     where the headline alone is unactionable; the appended
        //     bracketed `[model] excerpt` from runWholePhotoShot tells
        //     the user (and us, via screenshot) exactly what the AI
        //     returned. v5.62.3.
        const localized = result.errorCode
          ? t(ERROR_CODE_TO_TRANSLATION[result.errorCode])
          : '';
        const wantsDiagnostic =
          result.errorCode === 'parseFailed' ||
          result.errorCode === 'unexpectedShape' ||
          result.errorCode === 'httpError';
        const detail = wantsDiagnostic && result.error && !result.error.startsWith('Cancelled')
          ? `\n\n${result.error}`
          : '';
        setErrorMsg((localized || result.error) + detail);
        return;
      }

      // v5.60.3: gate auto-apply on overall confidence. When the AI
      // says "I'm not sure" (< 50%), don't silently dump probably-
      // wrong counts into the player's chip total — surface the
      // review phase and let the user pick "apply anyway" or
      // "retake". The auto-apply remains the default for high-
      // confidence runs (which is the common case), so the friction
      // only kicks in when it should.
      if (typeof result.overallConfidence === 'number' && result.overallConfidence < LOW_CONFIDENCE_THRESHOLD) {
        setPendingResult(result);
        setPhase('lowConfidence');
        return;
      }

      onResult(result, previewBase64, previewMimeType);
      onClose();
    } catch (err) {
      if (controller.signal.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      setPhase('error');
      setErrorMsg(msg);
    } finally {
      abortRef.current = null;
    }
  };

  const handleRetake = () => {
    setPhase('instruction');
    setPreviewUrl('');
    setPreviewBase64('');
    setErrorMsg('');
    setPendingResult(null);
  };

  // v5.60.3: explicit "apply anyway" path from the low-confidence
  // review screen. Same end-state as the auto-apply path in
  // handleAnalyze — fires onResult with the held-back result and
  // closes the modal.
  const handleApplyLowConfidence = () => {
    if (!pendingResult) return;
    const result = pendingResult;
    setPendingResult(null);
    onResult(result, previewBase64, previewMimeType);
    onClose();
  };

  const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.7)',
    backdropFilter: 'blur(4px)',
    zIndex: 1000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '1rem',
  };

  const cardStyle: React.CSSProperties = {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: '16px',
    maxWidth: '480px',
    width: '100%',
    maxHeight: '90vh',
    overflow: 'auto',
    padding: '1.25rem',
    direction: 'rtl',
    color: 'var(--text)',
  };

  const headerStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '0.75rem',
  };

  const closeBtnStyle: React.CSSProperties = {
    background: 'transparent',
    border: 'none',
    color: 'var(--text-muted)',
    fontSize: '1.5rem',
    cursor: 'pointer',
    padding: '0.25rem 0.5rem',
    lineHeight: 1,
  };

  return (
    <div
      style={overlayStyle}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={cardStyle}>
        <div style={headerStyle}>
          <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700 }}>
            {title || t('chips.photo.title')}
          </h3>
          <button
            type="button"
            style={closeBtnStyle}
            onClick={onClose}
            aria-label={t('common.close')}
          >×</button>
        </div>

        {/* Hidden file input — opens device camera on mobile, picker on desktop. */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: 'none' }}
          onChange={handleFileSelected}
        />

        {phase === 'instruction' && (
          <div>
            <div style={{
              padding: '0.85rem',
              background: 'rgba(16,185,129,0.08)',
              border: '1px solid rgba(16,185,129,0.25)',
              borderRadius: '10px',
              marginBottom: '0.85rem',
              fontSize: '0.85rem',
              lineHeight: 1.55,
              color: 'var(--text)',
            }}>
              <div style={{ fontWeight: 700, marginBottom: '0.4rem' }}>
                {t('chips.photo.instructionTitle')}
              </div>
              <ul style={{ margin: 0, paddingInlineStart: '1.25rem' }}>
                <li>
                  {t('chips.photo.instructionStep1')}
                  {orderedChips.length > 0 && (
                    /* Visual order strip: colored swatches left-to-right
                       in the EXACT sequence the AI will use to interpret
                       the photo (positions 1..N, ascending by denomination).
                       This is the load-bearing UX guarantee that arrangement
                       and AI interpretation can never disagree. */
                    <div style={{
                      display: 'flex',
                      flexWrap: 'nowrap',
                      gap: '0.25rem',
                      marginTop: '0.5rem',
                      direction: 'ltr', // photo arrangement is ALWAYS left→right ascending, regardless of UI language
                      width: '100%',
                    }}>
                      {orderedChips.map((chip, idx) => (
                        <div key={chip.id} style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          gap: '2px',
                          flex: '1 1 0',
                          minWidth: 0,
                        }}>
                          <div style={{
                            fontSize: '0.65rem',
                            color: 'var(--text-secondary, #9ca3af)',
                            lineHeight: 1,
                          }}>
                            {idx + 1}
                          </div>
                          <div style={{
                            width: '28px',
                            height: '28px',
                            borderRadius: '50%',
                            background: chip.displayColor,
                            border: '2px solid rgba(255,255,255,0.85)',
                            boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
                          }} title={`${chip.color} — ${chip.value}`} />
                          <div style={{
                            fontSize: '0.7rem',
                            fontWeight: 600,
                            color: 'var(--text)',
                            lineHeight: 1.1,
                          }}>
                            {chip.value}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </li>
                <li>{t('chips.photo.instructionStep2')}</li>
                <li>{t('chips.photo.instructionStep3')}</li>
                <li>{t('chips.photo.instructionStep4')}</li>
              </ul>
            </div>

            {/* v5.49: actionable tips to improve AI accuracy. Expandable
                because they're not strictly required (the AI works
                without them) but they materially improve the count
                quality. Default-collapsed so we don't overwhelm the
                instruction phase. The tips block targets the systematic
                undercount-by-1-2 failure mode reported in field tests
                — every tip directly addresses one mechanism causing it. */}
            <details style={{
              marginBottom: '0.85rem',
              padding: '0.6rem 0.85rem',
              background: 'rgba(59,130,246,0.06)',
              border: '1px solid rgba(59,130,246,0.20)',
              borderRadius: '10px',
              fontSize: '0.82rem',
              color: 'var(--text)',
            }}>
              <summary style={{
                fontWeight: 700,
                cursor: 'pointer',
                listStyle: 'none',
                color: '#60a5fa',
              }}>
                {t('chips.photo.tipsTitle')}
              </summary>
              <ul style={{
                margin: '0.5rem 0 0 0',
                paddingInlineStart: '1.25rem',
                lineHeight: 1.55,
              }}>
                <li>{t('chips.photo.tip.angle')}</li>
                <li>{t('chips.photo.tip.lighting')}</li>
                <li>{t('chips.photo.tip.background')}</li>
                <li>{t('chips.photo.tip.maxStack')}</li>
                <li>{t('chips.photo.tip.steady')}</li>
                <li>{t('chips.photo.tip.gap')}</li>
                <li>{t('chips.photo.tip.fillFrame')}</li>
              </ul>
            </details>

            <button
              type="button"
              className="btn btn-primary btn-block"
              onClick={openCamera}
              style={{ padding: '0.85rem', fontSize: '1rem' }}
            >
              {t('chips.photo.openCamera')}
            </button>
          </div>
        )}

        {phase === 'preview' && previewUrl && (
          <div>
            <img
              src={previewUrl}
              alt="chip preview"
              style={{
                width: '100%',
                maxHeight: '50vh',
                objectFit: 'contain',
                borderRadius: '10px',
                background: '#000',
                marginBottom: '0.75rem',
              }}
            />
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleRetake}
                style={{ flex: 1 }}
              >
                {t('chips.photo.retake')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleAnalyze}
                style={{ flex: 2 }}
              >
                {t('chips.photo.analyze')}
              </button>
            </div>
          </div>
        )}

        {phase === 'processing' && (
          <div style={{ textAlign: 'center', padding: '1.5rem 0.5rem' }}>
            <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>📸</div>
            <div style={{ fontSize: '0.9rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
              {statusMsg || t('chips.photo.status.analyzing')}
            </div>
            <div style={{
              width: '100%',
              height: '4px',
              background: 'rgba(255,255,255,0.08)',
              borderRadius: '2px',
              overflow: 'hidden',
            }}>
              <div style={{
                width: '40%',
                height: '100%',
                background: 'linear-gradient(90deg, transparent, #10b981, transparent)',
                animation: 'photoProgressSlide 1.4s ease-in-out infinite',
              }} />
            </div>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              style={{ marginTop: '1rem' }}
            >
              {t('common.cancel')}
            </button>
            <style>{`
              @keyframes photoProgressSlide {
                0%   { transform: translateX(-100%); }
                100% { transform: translateX(350%); }
              }
            `}</style>
          </div>
        )}

        {phase === 'lowConfidence' && pendingResult && (
          <div>
            {/* v5.60.3 review screen: side-by-side photo + AI's
                proposed per-color counts so the user can sanity-
                check before deciding. Confidence is shown
                prominently in amber/red so the "this might be
                wrong" framing is unmissable. */}
            {previewUrl && (
              <img
                src={previewUrl}
                alt="chip preview"
                style={{
                  width: '100%',
                  maxHeight: '32vh',
                  objectFit: 'contain',
                  borderRadius: '10px',
                  background: '#000',
                  marginBottom: '0.75rem',
                }}
              />
            )}
            <div style={{
              padding: '0.75rem 0.85rem',
              background: 'rgba(245, 158, 11, 0.10)',
              border: '1px solid rgba(245, 158, 11, 0.35)',
              borderRadius: '10px',
              marginBottom: '0.75rem',
              fontSize: '0.85rem',
              color: '#fbbf24',
              lineHeight: 1.5,
            }}>
              <div style={{ fontWeight: 700, marginBottom: '0.3rem' }}>
                {t('chips.photo.lowConfidence.title', { confidence: pendingResult.overallConfidence })}
              </div>
              <div style={{ fontSize: '0.78rem', opacity: 0.9 }}>
                {t('chips.photo.lowConfidence.subtitle')}
              </div>
            </div>

            {/* Aggregate the per-stack counts by chipId so the
                preview matches the per-color shape the user
                expects (matches the test-card display fix). */}
            <div style={{ marginBottom: '0.75rem' }}>
              {(() => {
                const summed = new Map<string, number>();
                for (const stack of pendingResult.stacks) {
                  summed.set(stack.chipId, (summed.get(stack.chipId) ?? 0) + stack.count);
                }
                return [...summed.entries()].map(([chipId, count]) => {
                  const chip = chipValues.find(c => c.id === chipId);
                  if (!chip) return null;
                  return (
                    <div
                      key={chipId}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.5rem',
                        padding: '0.4rem 0.6rem',
                        background: 'rgba(255,255,255,0.03)',
                        borderRadius: '8px',
                        marginBottom: '0.25rem',
                        fontSize: '0.85rem',
                      }}
                    >
                      <div style={{
                        width: '1.2rem',
                        height: '1.2rem',
                        borderRadius: '50%',
                        backgroundColor: chip.displayColor,
                        border: chip.displayColor === '#FFFFFF' ? '2px solid #ccc' : 'none',
                        flexShrink: 0,
                      }} />
                      <span style={{ flex: 1, fontWeight: 600 }}>{chip.color}</span>
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>×{chip.value}</span>
                      <span style={{ fontWeight: 700, fontSize: '0.95rem', minWidth: '2.5rem', textAlign: 'center' }}>
                        {count}
                      </span>
                    </div>
                  );
                });
              })()}
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: '0.5rem 0.6rem 0.2rem',
                fontSize: '0.85rem',
                fontWeight: 700,
                borderTop: '1px solid var(--border)',
                marginTop: '0.35rem',
              }}>
                <span>{t('chips.photo.lowConfidence.totalEstimate')}</span>
                <span>{pendingResult.totalValue.toLocaleString()}</span>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleRetake}
                style={{ flex: 1 }}
              >
                {t('chips.photo.lowConfidence.retake')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleApplyLowConfidence}
                style={{ flex: 1 }}
              >
                {t('chips.photo.lowConfidence.applyAnyway')}
              </button>
            </div>
          </div>
        )}

        {phase === 'error' && (() => {
          // v5.62.3 — split errorMsg on '\n\n' to separate the localized
          // headline from the raw diagnostic payload. The payload is
          // rendered in a small monospaced block with horizontal-scroll
          // overflow so long lines (Gemini response excerpts) don't
          // blow up the modal width on mobile.
          const splitAt = errorMsg.indexOf('\n\n');
          const headline = splitAt >= 0 ? errorMsg.slice(0, splitAt) : errorMsg;
          const payload = splitAt >= 0 ? errorMsg.slice(splitAt + 2).trim() : '';
          return (
          <div>
            <div style={{
              padding: '0.85rem',
              background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.3)',
              borderRadius: '10px',
              marginBottom: '0.85rem',
              fontSize: '0.85rem',
              color: '#fca5a5',
            }}>
              <div style={{ fontWeight: 700, marginBottom: '0.4rem' }}>
                {t('chips.photo.error.title')}
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{headline}</div>
              {payload && (
                <div style={{
                  marginTop: '0.6rem',
                  padding: '0.5rem 0.65rem',
                  background: 'rgba(0,0,0,0.35)',
                  border: '1px solid rgba(239,68,68,0.2)',
                  borderRadius: '6px',
                  fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
                  fontSize: '0.72rem',
                  color: '#fecaca',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: '180px',
                  overflowY: 'auto',
                  direction: 'ltr',
                  textAlign: 'left',
                }}>
                  {payload}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={onClose}
                style={{ flex: 1 }}
              >
                {t('common.close')}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleRetake}
                style={{ flex: 1 }}
              >
                {t('chips.photo.retake')}
              </button>
            </div>
          </div>
          );
        })()}
      </div>
    </div>
  );
};

export default PhotoCaptureModal;
