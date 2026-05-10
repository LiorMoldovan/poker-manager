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
  missingImage:    'chips.photo.error.code.missingImage',
  noChipsConfig:   'chips.photo.error.code.noChipsConfig',
  network:         'chips.photo.error.code.network',
  httpError:       'chips.photo.error.code.httpError',
  parseFailed:     'chips.photo.error.code.parseFailed',
  unexpectedShape: 'chips.photo.error.code.unexpectedShape',
  cancelled:       'chips.photo.error.code.cancelled',
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

type Phase = 'instruction' | 'preview' | 'processing' | 'error';

interface PhotoCaptureModalProps {
  isOpen: boolean;
  onClose: () => void;
  onResult: (result: PhotoChipCountResult, previewBase64: string) => void;
  chipValues: ChipValue[];
  expectedTotalValue?: number;
  /** Title shown in the modal header. Defaults to a generic Hebrew string. */
  title?: string;
}

const PhotoCaptureModal = ({
  isOpen,
  onClose,
  onResult,
  chipValues,
  expectedTotalValue,
  title,
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
        abortSignal: controller.signal,
        // Live status updates as the function tries each model in the
        // fallback chain. First attempt shows the model name; later
        // attempts add an "alternate model" label so the user knows
        // we're not stuck — we're recovering from a hiccup.
        onProgress: ({ phase, modelDisplay, attempt }) => {
          if (phase === 'attempting') {
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
        // Prefer the localized message keyed off `errorCode` if the
        // function set one — falls back to the raw English `error`
        // string for legacy/unknown cases. The raw string also stays
        // useful in the console (`countChipsFromPhoto` logs it on
        // parse failures) for debugging without round-tripping
        // through the user.
        const localized = result.errorCode
          ? t(ERROR_CODE_TO_TRANSLATION[result.errorCode])
          : '';
        setErrorMsg(localized || result.error);
        return;
      }

      onResult(result, previewBase64);
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
                      flexWrap: 'wrap',
                      gap: '0.4rem',
                      marginTop: '0.5rem',
                      direction: 'ltr', // photo arrangement is ALWAYS left→right ascending, regardless of UI language
                    }}>
                      {orderedChips.map((chip, idx) => (
                        <div key={chip.id} style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          gap: '2px',
                          minWidth: '38px',
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

        {phase === 'error' && (
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
              <div>{errorMsg}</div>
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
        )}
      </div>
    </div>
  );
};

export default PhotoCaptureModal;
