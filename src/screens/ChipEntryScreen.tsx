import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { GamePlayer, ChipValue, PhotoChipCountResult } from '../types';
import { 
  getGamePlayers, 
  getChipValues, 
  getSettings,
  updateGamePlayerChips,
  updateGamePlayerResults,
  updateGameStatus,
  updateGameChipGap,
  updateGamePlayerEntryMode,
  createGameEndBackup,
  invalidateAICaches,
  deleteTTSPool,
  flushGameCompletion,
} from '../database/storage';
import { calculateChipTotal, calculateProfitLoss, cleanNumber, formatCurrency } from '../utils/calculations';
import { usePermissions } from '../App';
import { getGeminiApiKey } from '../utils/geminiAI';
import { isGeminiEnabledForCurrentGroup } from '../utils/aiEligibility';
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh';
import { useTranslation, translateChipColor } from '../i18n';
import PhotoCaptureModal from '../components/PhotoCaptureModal';
import ChipDetectionOverlay from '../components/ChipDetectionOverlay';
import AIKeyMissingNotice from '../components/AIKeyMissingNotice';

// Per-stack confidence → border color helper. Used by both the
// chip-entry inputs (left-border) and the header banner. Kept as a
// pure function outside the component so it doesn't capture stale
// closures.
//
// Thresholds rebuilt in v5.48 around the new computed-confidence
// scale (capped at 90%, with real signal from inter-shot agreement,
// color verification, height penalty, and total-value sanity check):
//   ≥80 = green  — both shots agree, color matches, stack short, total close
//   ≥60 = yellow — minor disagreement OR moderate height OR small total drift
//   <60 = red    — please verify this stack manually
const confidenceColor = (confidence: number, isMismatch = false): string => {
  if (isMismatch) return 'rgba(239,68,68,0.7)';   // red — contributes to total mismatch
  if (confidence >= 80) return 'rgba(16,185,129,0.6)';   // green — high
  if (confidence >= 60) return 'rgba(234,179,8,0.6)';    // yellow — medium
  return 'rgba(239,68,68,0.7)';                          // red — low
};

// Numpad Modal Component with auto-advance
interface NumpadModalProps {
  isOpen: boolean;
  playerName: string;
  chipColor: string;
  chipDisplayColor: string;
  currentValue: number;
  onConfirm: (value: number) => void;
  onClose: () => void;
  // Auto-advance props
  chipIndex: number;
  totalChips: number;
  nextChipColor?: string;
  nextChipDisplayColor?: string;
  isLastChip: boolean;
  // Optional escape-hatch to the photo chip-counting flow. When
  // both are supplied, a 📷 icon button is rendered in the green
  // player-name header bar. Tapping it should close this modal
  // and open the photo capture modal in the parent — the manual
  // typing flow stays byte-identical when the button isn't tapped.
  showPhotoButton?: boolean;
  onPhotoRequest?: () => void;
  // NOTE (v5.60.6 revert): a `runningChipPoints / expectedChipPoints`
  // reconciliation strip was added in v5.60.5 and removed here. The
  // framing was wrong — per-player `running != expected` is profit/
  // loss, not an error. Aggregate (table-wide) reconciliation is
  // already covered by the progress bar at the top of ChipEntryScreen
  // and the chip-gap warning at finalize. Resist the urge to re-add
  // a per-player strip here without explicit profit/loss framing.
}

const NumpadModal = ({
  isOpen,
  playerName,
  chipColor,
  chipDisplayColor,
  currentValue,
  onConfirm,
  onClose,
  chipIndex,
  totalChips,
  nextChipColor,
  nextChipDisplayColor,
  isLastChip,
  showPhotoButton = false,
  onPhotoRequest,
}: NumpadModalProps) => {
  const { t } = useTranslation();
  const [value, setValue] = useState(currentValue.toString());
  
  useEffect(() => {
    if (isOpen) {
      setValue(currentValue.toString());
    }
  }, [isOpen, currentValue, chipColor]); // Reset when chip changes

  if (!isOpen) return null;

  const handleKey = (key: string) => {
    if (key === 'C') {
      setValue('0');
    } else if (key === '⌫') {
      setValue(prev => prev.length > 1 ? prev.slice(0, -1) : '0');
    } else {
      setValue(prev => prev === '0' ? key : prev + key);
    }
  };

  const handleConfirm = () => {
    onConfirm(parseInt(value) || 0);
    // Don't close - parent handles advancing to next chip
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '320px' }}>
        {/* Player name header.
            Flex layout with a symmetrical spacer keeps the player
            name visually centered whether or not the optional 📷
            photo-escape button is rendered. The 📷 button is the
            ONLY way to reach the photo flow from inside the
            numpad — the manual flow is otherwise unchanged. */}
        <div style={{
          background: 'var(--primary)',
          margin: '-1.5rem -1.5rem 1rem -1.5rem',
          padding: '0.75rem 1rem',
          borderRadius: '16px 16px 0 0',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.5rem',
        }}>
          {showPhotoButton && onPhotoRequest ? (
            <button
              type="button"
              onClick={onPhotoRequest}
              title={t('chips.photo.button')}
              aria-label={t('chips.photo.button')}
              style={{
                background: 'rgba(255,255,255,0.18)',
                border: 'none',
                color: 'white',
                fontSize: '1rem',
                cursor: 'pointer',
                padding: '0.25rem 0.55rem',
                borderRadius: '8px',
                lineHeight: 1,
                fontFamily: 'inherit',
                minWidth: '2rem',
              }}
            >
              📷
            </button>
          ) : (
            <span style={{ minWidth: '2rem', display: 'inline-block' }} />
          )}
          <span style={{
            color: 'white',
            fontWeight: '700',
            fontSize: '1.1rem',
            flex: 1,
            textAlign: 'center',
          }}>
            {playerName}
          </span>
          {/* Right-side spacer mirrors the left-side button width so
              the player name stays optically centered regardless of
              whether the photo button is rendered. */}
          <span style={{ minWidth: '2rem', display: 'inline-block' }} />
        </div>
        
        <div className="modal-header" style={{ marginBottom: '0.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <div 
              style={{ 
                width: '24px', 
                height: '24px', 
                borderRadius: '50%', 
                backgroundColor: chipDisplayColor,
                border: chipDisplayColor === '#FFFFFF' || chipDisplayColor === '#EAB308' ? '2px solid #888' : 'none'
              }} 
            />
            <h3 className="modal-title">{translateChipColor(chipColor, t)}{t('chips.chipsSuffix')}</h3>
          </div>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        
        {/* Progress indicator */}
        <div style={{ 
          display: 'flex', 
          justifyContent: 'center', 
          gap: '0.35rem', 
          marginBottom: '0.75rem' 
        }}>
          {Array.from({ length: totalChips }).map((_, i) => (
            <div
              key={i}
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: i < chipIndex ? 'var(--success)' : i === chipIndex ? 'var(--primary)' : 'var(--border)',
                transition: 'background 0.2s ease'
              }}
            />
          ))}
        </div>
        
        <div style={{ 
          fontSize: '2.5rem', 
          fontWeight: '700', 
          textAlign: 'center', 
          padding: '1rem',
          background: 'var(--surface)',
          borderRadius: '8px',
          marginBottom: '1rem',
          fontFamily: 'monospace'
        }}>
          {value}
        </div>
        
        <div style={{ 
          display: 'grid', 
          gridTemplateColumns: 'repeat(3, 1fr)', 
          gap: '0.5rem',
          marginBottom: '1rem',
          direction: 'ltr'
        }}>
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map(key => (
            <button
              key={key}
              onClick={() => handleKey(key)}
              style={{
                padding: '1rem',
                fontSize: '1.5rem',
                fontWeight: '600',
                borderRadius: '8px',
                border: 'none',
                background: key === 'C' ? 'var(--danger)' : key === '⌫' ? 'var(--warning)' : 'var(--surface)',
                color: key === 'C' || key === '⌫' ? 'white' : 'var(--text)',
                cursor: 'pointer'
              }}
            >
              {key}
            </button>
          ))}
        </div>
        
        {/* Confirm button - shows what's next */}
        <button 
          className="btn btn-primary btn-block" 
          onClick={handleConfirm}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '0.5rem'
          }}
        >
          {isLastChip ? (
            <>{t('chips.numpadDone')}</>
          ) : (
            <>
              {t('chips.numpadNext')}
              {nextChipDisplayColor && (
                <div 
                  style={{ 
                    width: '16px', 
                    height: '16px', 
                    borderRadius: '50%', 
                    backgroundColor: nextChipDisplayColor,
                    border: nextChipDisplayColor === '#FFFFFF' || nextChipDisplayColor === '#EAB308' ? '2px solid #888' : 'none'
                  }} 
                />
              )}
              {nextChipColor ? translateChipColor(nextChipColor, t) : ''}
            </>
          )}
        </button>
      </div>
    </div>
  );
};

// ── TotalNumpadModal — quick-total chip entry (migration 080) ──
//
// Single-input variant of NumpadModal for groups (or admins) that
// don't count color-by-color. Admin types ONE total chip count for
// the player, sees a live money-equivalent below the input, taps
// Done. No per-color iteration, no progress dots, no photo escape
// (photo flow is per-color and irrelevant in this mode). Visual
// frame mirrors NumpadModal so it feels native.
interface TotalNumpadModalProps {
  isOpen: boolean;
  playerName: string;
  currentValue: number;
  valuePerChip: number;       // for the live ≈ {money} hint
  formatMoney: (n: number) => string;
  onConfirm: (value: number) => void;
  onClose: () => void;
}

const TotalNumpadModal = ({
  isOpen,
  playerName,
  currentValue,
  valuePerChip,
  formatMoney,
  onConfirm,
  onClose,
}: TotalNumpadModalProps) => {
  const { t } = useTranslation();
  const [value, setValue] = useState(currentValue.toString());

  useEffect(() => {
    if (isOpen) setValue(currentValue.toString());
  }, [isOpen, currentValue]);

  if (!isOpen) return null;

  const handleKey = (key: string) => {
    if (key === 'C') setValue('0');
    else if (key === '⌫') setValue(prev => (prev.length > 1 ? prev.slice(0, -1) : '0'));
    else setValue(prev => (prev === '0' ? key : prev + key));
  };

  const numericValue = parseInt(value) || 0;
  const moneyEquivalent = numericValue * valuePerChip;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '320px' }}>
        {/* Player name header — same green bar as NumpadModal so the
            two flows feel like the same family of inputs. */}
        <div style={{
          background: 'var(--primary)',
          margin: '-1.5rem -1.5rem 1rem -1.5rem',
          padding: '0.75rem 1rem',
          borderRadius: '16px 16px 0 0',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.5rem',
        }}>
          <span style={{ minWidth: '2rem', display: 'inline-block' }} />
          <span style={{ color: 'white', fontWeight: 700, fontSize: '1.1rem', flex: 1, textAlign: 'center' }}>
            {playerName}
          </span>
          <span style={{ minWidth: '2rem', display: 'inline-block' }} />
        </div>

        <div className="modal-header" style={{ marginBottom: '0.5rem' }}>
          <h3 className="modal-title">{t('chips.entryMode.totalNumpadTitle')}</h3>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div style={{
          fontSize: '2.5rem',
          fontWeight: 700,
          textAlign: 'center',
          padding: '1rem',
          background: 'var(--surface)',
          borderRadius: '8px',
          marginBottom: '0.4rem',
          fontFamily: 'monospace',
        }}>
          {numericValue.toLocaleString('he-IL')}
        </div>

        {/* Live money equivalent — the only reference the admin
            actually needs while typing ("8,000 chips ≈ 24 ₪, sounds
            like roughly a buyin"). The chips-per-buyin constant is
            already shown in the selected-player header above the
            modal, so we don't duplicate it here. */}
        <div style={{
          textAlign: 'center',
          marginBottom: '1rem',
          fontSize: '0.85rem',
          color: 'var(--text-muted)',
        }}>
          {t('chips.entryMode.moneyEquivalent').replace('{amount}', formatMoney(moneyEquivalent))}
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '0.5rem',
          marginBottom: '1rem',
          direction: 'ltr',
        }}>
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map(key => (
            <button
              key={key}
              onClick={() => handleKey(key)}
              style={{
                padding: '1rem',
                fontSize: '1.5rem',
                fontWeight: 600,
                borderRadius: '8px',
                border: 'none',
                background: key === 'C' ? 'var(--danger)' : key === '⌫' ? 'var(--warning)' : 'var(--surface)',
                color: key === 'C' || key === '⌫' ? 'white' : 'var(--text)',
                cursor: 'pointer',
              }}
            >
              {key}
            </button>
          ))}
        </div>

        <button
          className="btn btn-primary btn-block"
          onClick={() => onConfirm(numericValue)}
        >
          {t('chips.done')}
        </button>
      </div>
    </div>
  );
};

const ChipEntryScreen = () => {
  const { t } = useTranslation();
  const { gameId } = useParams<{ gameId: string }>();
  const navigate = useNavigate();
  const { role, isSuperAdmin, isOwner } = usePermissions();
  const isAdmin = role === 'admin' || isSuperAdmin || isOwner;
  const [players, setPlayers] = useState<GamePlayer[]>([]);
  const [chipValues, setChipValues] = useState<ChipValue[]>([]);
  const [chipCounts, setChipCounts] = useState<Record<string, Record<string, number>>>({});
  const [rebuyValue, setRebuyValue] = useState(30);
  const [chipsPerRebuy, setChipsPerRebuy] = useState(10000);
  const [isLoading, setIsLoading] = useState(true);
  const [gameNotFound, setGameNotFound] = useState(false);
  
  // Numpad state - track by chip index for auto-advance
  const [numpadOpen, setNumpadOpen] = useState(false);
  const [numpadPlayerId, setNumpadPlayerId] = useState('');
  const [numpadChipIndex, setNumpadChipIndex] = useState(0); // Track chip by index for auto-advance

  // Migration 080 — quick-total numpad state. Distinct from the
  // color numpad above so the two flows can't collide (admin can't
  // open both at once, but state separation makes the per-modal
  // open/close logic obvious). Default mode for the next "tap a
  // player" comes from settings.chipEntryDefaultMode (loaded in
  // loadData below).
  const [totalNumpadOpen, setTotalNumpadOpen] = useState(false);
  const [totalNumpadPlayerId, setTotalNumpadPlayerId] = useState('');
  const [defaultEntryMode, setDefaultEntryMode] = useState<'color' | 'total'>('color');

  // Player selector state
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
  const [completedPlayers, setCompletedPlayers] = useState<Set<string>>(new Set());
  const [showUncountedWarning, setShowUncountedWarning] = useState(false);
  // v5.60.3: surface the chip-gap adjustment before finalizing.
  // Until now the gap was applied silently — players could end up
  // with a profit different from what the chip math implied, with
  // no UI explanation. Now: if the counted total doesn't match the
  // expected buy-in pool (within 1₪), we set this state instead of
  // proceeding, render a warning banner explaining the gap and
  // per-player adjustment, and require a second tap to confirm.
  const [chipGapPreview, setChipGapPreview] = useState<{
    gapInMoney: number;
    gapPerPlayer: number;
  } | null>(null);
  const [isFinalizing, setIsFinalizing] = useState(false);

  // v5.60.6: stale-preview guard. If the admin clicks "calculate"
  // once (sees the gap banner), then goes back and changes a chip
  // count, the preview from the previous click reflects the OLD
  // gap — but `handleCalculate`'s `!chipGapPreview` early-return
  // guard would then SKIP showing the new banner on the second
  // click and finalize against a gap the user never explicitly
  // acknowledged. Resetting on any `chipCounts` change forces a
  // fresh preview tap so the user re-confirms with current
  // numbers. Cheap: just clears one state slot when the user
  // edits chips, with a `chipGapPreview` guard so we don't
  // dispatch a no-op state set on every chip type-and-confirm.

  // Photo chip-counting state — purely additive, lives alongside the
  // existing manual flow. Per-player; survives switching between
  // players in the same session but is intentionally NOT persisted
  // (re-photo if you come back later).
  //
  // photoResults: AI-proposed counts + per-stack confidences keyed by
  //   playerId. Drives the header banner and the colored input borders.
  // userEditedFields: which (playerId, chipId) pairs the human has
  //   manually overridden. Two purposes: (1) re-photo never overwrites
  //   them, (2) the colored AI-confidence border is replaced with a
  //   bold "edited" style for those fields.
  const [photoOpen, setPhotoOpen] = useState(false);
  // Locked at the moment the user opens the photo modal, so the result
  // is applied to the right player even if they somehow switch players
  // mid-flow (the modal is full-screen so this shouldn't normally
  // happen — defensive only).
  const [photoTargetPlayerId, setPhotoTargetPlayerId] = useState<string | null>(null);
  const [photoResults, setPhotoResults] = useState<Record<string, PhotoChipCountResult>>({});
  // The exact image we sent the AI, kept per-player so we can ship
  // it as part of the chip-count feedback row when the user
  // finalizes that player AND the group has opted in to photo
  // sharing. NOT persisted across reloads — re-photo if you come
  // back. base64 is the enhanced (auto-leveled) image, not the raw
  // camera output.
  const [photoImagesForFeedback, setPhotoImagesForFeedback] =
    useState<Record<string, { base64: string; mimeType: string }>>({});
  const [userEditedFields, setUserEditedFields] = useState<Record<string, Set<string>>>({});
  const [photoErrorToast, setPhotoErrorToast] = useState<string>('');
  // Per-player toggle: whether the AI detection overlay (boxes on the
  // photo) is expanded under the photo banner. Default collapsed —
  // most users never need to look at it, but when an AI count goes
  // wrong it's the fastest way to spot whether the model cropped the
  // wrong region. v5.59.
  const [overlayExpandedPlayerId, setOverlayExpandedPlayerId] = useState<string | null>(null);
  // Whether the photo chip-counting feature is available for this group.
  // True when EITHER (a) the group has its own Gemini API key set in
  // settings, OR (b) at least one past game in the group has an AI
  // summary — proof that the Gemini call path works (per-group key OR
  // Vercel `GEMINI_API_KEY` env-var fallback). When both signals are
  // false, we hide the photo button entirely so users mid-game don't
  // start a chip count, click photo, hit a downstream API error, and
  // have to fall back to manual after burning the modal flow. The
  // owner can enable the feature for a brand-new group by configuring
  // a key under Settings → Services and reopening this screen.
  const [photoAvailable, setPhotoAvailable] = useState(false);
  // Value per chip point = rebuyValue / chipsPerRebuy (with fallback to prevent division by zero)
  const valuePerChip = rebuyValue / (chipsPerRebuy || 10000);

  // Get current numpad chip based on index
  const numpadChip = chipValues[numpadChipIndex] || null;
  const nextChip = chipValues[numpadChipIndex + 1] || null;

  useEffect(() => {
    if (gameId) {
      loadData();
    } else {
      setGameNotFound(true);
      setIsLoading(false);
    }
  }, [gameId]);

  useRealtimeRefresh(useCallback(() => { if (gameId) loadData(); }, [gameId]));

  // Save chip counts to storage. Migration 080: total-mode players
  // are persisted explicitly at Done time (markPlayerDoneWithTotal)
  // and aren't part of the per-color chipCounts map — we skip them
  // here so the auto-save loop never overwrites their cleared
  // chip_counts column with stale local data.
  const saveChipCounts = useCallback(() => {
    if (isLoading || Object.keys(chipCounts).length === 0) return;
    players.forEach(player => {
      if (player.entryMode === 'total') return;
      const playerChips = chipCounts[player.id] || {};
      if (Object.values(playerChips).some(v => v > 0)) {
        updateGamePlayerChips(player.id, playerChips);
      }
    });
  }, [chipCounts, players, isLoading]);

  // Auto-save chip counts whenever they change (debounced)
  // Also flush immediately on unmount to prevent data loss
  useEffect(() => {
    if (isLoading || Object.keys(chipCounts).length === 0) return;
    
    const saveTimeout = setTimeout(saveChipCounts, 500);

    return () => {
      clearTimeout(saveTimeout);
      saveChipCounts();
    };
  }, [chipCounts, players, isLoading, saveChipCounts]);

  // Auto-dismiss the photo error toast after a few seconds.
  // IMPORTANT: keep this hook above the `if (isLoading)` / `if (gameNotFound)`
  // early returns below — moving it after them violates the Rules of Hooks
  // (React would call a different number of hooks across renders once the
  // game loads, throwing "Rendered more hooks than during the previous
  // render" and tripping the ErrorBoundary).
  useEffect(() => {
    if (!photoErrorToast) return;
    const id = setTimeout(() => setPhotoErrorToast(''), 5000);
    return () => clearTimeout(id);
  }, [photoErrorToast]);

  // v5.60.6: clear the chip-gap preview whenever chip counts change.
  // Without this, an admin who clicks "calculate" → sees the gap
  // banner → goes back to edit → returns and clicks again would
  // bypass the (stale) banner via the `!chipGapPreview` early-return
  // guard and finalize against a gap they never explicitly saw at
  // its current value. Resetting forces a fresh acknowledgement.
  // Guarded so we don't dispatch a no-op state set on every chip
  // edit — only fires when there's actually a stale preview to clear.
  useEffect(() => {
    if (chipGapPreview) setChipGapPreview(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chipCounts]);

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
    const chips = getChipValues();
    const settings = getSettings();
    
    setPlayers(gamePlayers);
    setChipValues(chips);
    setRebuyValue(settings.rebuyValue || 30);
    setChipsPerRebuy(settings.chipsPerRebuy || 10000);
    // Migration 080 — group default for the BIG-tap mode in chip entry.
    setDefaultEntryMode(settings.chipEntryDefaultMode === 'total' ? 'total' : 'color');
    // Photo button availability. Honest signal: the call path must work
    // for THIS group right now. Pre-v5.60.3 we also accepted "any past
    // game has an aiSummary" as proof of viability, but that signal is
    // tainted because non-owner groups silently used the platform owner's
    // key for AI before the gate landed — past summaries don't prove the
    // group can call AI today. Use the eligibility helper instead.
    setPhotoAvailable(isGeminiEnabledForCurrentGroup());
    // Initialize chip counts
    const initialCounts: Record<string, Record<string, number>> = {};
    gamePlayers.forEach(player => {
      initialCounts[player.id] = {};
      chips.forEach(chip => {
        initialCounts[player.id][chip.id] = player.chipCounts[chip.id] || 0;
      });
    });
    setChipCounts(initialCounts);
    
    // Don't auto-select any player - let user choose
    setSelectedPlayerId(null);
    setNumpadOpen(false);  // Ensure numpad is closed
    setIsLoading(false);
  };

  // Mark player as done and return to player selection.
  //
  // The chip-count feedback loop was removed in v5.62.2 — feedback
  // rows were never consumed (the tuning mechanism that read them
  // was retired with the v5.62.0 architecture rewrite). The
  // `chip_count_feedback` table and storage bucket remain in
  // Supabase as harmless legacy; if we ever bring tuning back,
  // re-add the silent submit call here.
  const markPlayerDone = (playerId: string) => {
    setCompletedPlayers(prev => new Set([...prev, playerId]));
    setNumpadOpen(false);
    setSelectedPlayerId(null);
  };

  // Migration 080 — total-mode equivalent of markPlayerDone. We
  // persist the total chip count atomically here (skipping the
  // per-color auto-save loop entirely — see saveChipCounts above),
  // so the source of truth lives in game_players.total_chip_count
  // and survives reload / realtime refresh. Final money +
  // adjustedProfit are RE-derived on finalize alongside chip-gap,
  // identical to the color-mode path.
  const markPlayerDoneWithTotal = (playerId: string, totalChips: number) => {
    updateGamePlayerEntryMode(playerId, 'total', totalChips);
    setPlayers(prev => prev.map(p => p.id === playerId
      ? { ...p, entryMode: 'total', totalChipCount: totalChips, chipCounts: {} }
      : p));
    setCompletedPlayers(prev => new Set([...prev, playerId]));
    setTotalNumpadOpen(false);
    setSelectedPlayerId(null);
  };

  // Undo player completion. Works for both modes — the row's
  // entry_mode/total_chip_count/chip_counts are preserved so a
  // re-tap on the player tile re-opens the same modal with the
  // existing values.
  const undoPlayerCompletion = (playerId: string) => {
    setCompletedPlayers(prev => {
      const newSet = new Set(prev);
      newSet.delete(playerId);
      return newSet;
    });
    setSelectedPlayerId(playerId);
  };

  // Migration 080. `selectPlayerWithMode` replaces the old
  // `selectPlayer` and routes the open to the right modal based on
  // the chosen mode. The mode is persisted to game_players.entry_mode
  // immediately (via updateGamePlayerEntryMode) so a realtime refresh
  // / mid-flow reload / reopen-after-completion all show the right
  // modal next time. Switching modes for a player wipes the
  // abandoned mode's data — see updateGamePlayerEntryMode in
  // storage.ts for the atomic behavior.
  //
  // Centralized data-loss guard: any caller switching a player to a
  // different entry mode while the current mode already has data
  // gets one confirm dialog. This is the single chokepoint — tile
  // taps and inline "switch mode" links all flow through here, so
  // the inline call sites no longer need their own confirm.
  const selectPlayerWithMode = (playerId: string, mode: 'color' | 'total') => {
    if (!isAdmin) return;
    const current = players.find(p => p.id === playerId);
    if (current && current.entryMode !== mode) {
      const hasColorData = Object.values(chipCounts[playerId] || {}).some(v => v > 0);
      const hasTotalData = (current.totalChipCount ?? 0) > 0;
      const wouldLoseData =
        (current.entryMode === 'color' && hasColorData) ||
        (current.entryMode === 'total' && hasTotalData);
      if (wouldLoseData && !window.confirm(
        t('chips.entryMode.switchConfirm').replace('{player}', current.playerName),
      )) {
        return;
      }
    }
    setSelectedPlayerId(playerId);
    if (mode === 'color') {
      if (chipValues.length === 0) return;  // no chips configured — nothing to count by color
      if (current?.entryMode !== 'color') {
        updateGamePlayerEntryMode(playerId, 'color', null);
        // Reflect the mode change in local state so getPlayerChipPoints
        // doesn't keep reading the stale total. Reload-from-DB will
        // arrive shortly via debounced cache flush; this just bridges
        // the gap.
        setPlayers(prev => prev.map(p => p.id === playerId
          ? { ...p, entryMode: 'color', totalChipCount: null }
          : p));
        // Re-init the per-color chip counts to all-zeros for this player.
        setChipCounts(prev => ({
          ...prev,
          [playerId]: chipValues.reduce<Record<string, number>>((acc, c) => {
            acc[c.id] = 0;
            return acc;
          }, {}),
        }));
      }
      setNumpadPlayerId(playerId);
      setNumpadChipIndex(0);
      setNumpadOpen(true);
    } else {
      // Re-opening total mode for an already-total player keeps the
      // existing total (so admin sees the prior number, can edit, or
      // confirm). For a fresh switch into total, init to 0.
      const initialTotal = current?.entryMode === 'total' ? (current.totalChipCount ?? 0) : 0;
      if (current?.entryMode !== 'total') {
        updateGamePlayerEntryMode(playerId, 'total', initialTotal);
        setPlayers(prev => prev.map(p => p.id === playerId
          ? { ...p, entryMode: 'total', totalChipCount: initialTotal, chipCounts: {} }
          : p));
        setChipCounts(prev => ({ ...prev, [playerId]: {} }));
      }
      setTotalNumpadPlayerId(playerId);
      setTotalNumpadOpen(true);
    }
  };

  const selectedPlayer = players.find(p => p.id === selectedPlayerId);
  const completedPlayersCount = completedPlayers.size;

  // Loading state
  if (isLoading) {
    return (
      <div className="fade-in" style={{ textAlign: 'center', padding: '3rem' }}>
        <div style={{ fontSize: '2rem', marginBottom: '1rem' }}>🃏</div>
        <p className="text-muted">{t('chips.loadingGame')}</p>
      </div>
    );
  }

  // Game not found
  if (gameNotFound) {
    return (
      <div className="fade-in" style={{ textAlign: 'center', padding: '3rem' }}>
        <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>😕</div>
        <h2 style={{ marginBottom: '0.5rem' }}>{t('chips.gameNotFound')}</h2>
        <p className="text-muted" style={{ marginBottom: '1.5rem' }}>{t('chips.gameNotFoundDesc')}</p>
        <button className="btn btn-primary" onClick={() => navigate('/')}>{t('chips.goHome')}</button>
      </div>
    );
  }

  // `source` distinguishes user edits (numpad / ± / direct typing)
  // from AI-populated values (PhotoCaptureModal result). User edits
  // mark the field in userEditedFields so future re-photos won't
  // overwrite them and the colored AI-border is replaced with a
  // bold "edited" style. Defaults to 'user' so the existing call
  // sites need no changes.
  const updateChipCount = (
    playerId: string,
    chipId: string,
    value: number,
    source: 'user' | 'photo' = 'user',
  ) => {
    const newValue = Math.max(0, value);
    setChipCounts(prev => ({
      ...prev,
      [playerId]: {
        ...prev[playerId],
        [chipId]: newValue,
      },
    }));
    if (source === 'user') {
      setUserEditedFields(prev => {
        const cur = prev[playerId] || new Set<string>();
        if (cur.has(chipId)) return prev;
        const next = new Set(cur);
        next.add(chipId);
        return { ...prev, [playerId]: next };
      });
    }
  };

  // Apply a PhotoChipCountResult to the currently selected player.
  // Honors the "manual flow protection" guarantee: any field already
  // edited by the user is preserved untouched.
  //
  // Also stashes the enhanced photo (base64 + mime) so we can
  // optionally upload it as part of the feedback row in
  // markPlayerDone — only happens when the group has opted in to
  // photo sharing (owner toggle in Services tab). When opted-out,
  // the base64 stays in memory until the player is finalized and
  // is then dropped (never persisted, never sent off-device).
  const applyPhotoResult = (
    result: PhotoChipCountResult,
    playerId: string,
    photoBase64?: string,
    photoMimeType?: string,
  ) => {
    if (result.error) {
      setPhotoErrorToast(result.error);
      return;
    }
    const editedForPlayer = userEditedFields[playerId] || new Set<string>();
    // Sum counts across stacks that share the same chipId before
    // writing into chipCounts. The v5.59 detection pipeline emits one
    // stack entry per detected pile, and the chip-grid write API is
    // keyed by chipId (overwrite semantics, not additive). Without
    // this aggregation, a user who accidentally splits chips of one
    // color into multiple piles (or builds the traditional poker
    // "5-stacks") would have all but the last pile's count silently
    // dropped — undercount with no UI signal. Happy path (one pile
    // per color) is unaffected: each chipId appears exactly once and
    // the sum equals the single stack's count. The userEditedFields
    // skip is preserved per chipId so any chip the user already
    // typed manually still wins over the AI proposal.
    const summedByChipId = new Map<string, number>();
    for (const stack of result.stacks) {
      summedByChipId.set(
        stack.chipId,
        (summedByChipId.get(stack.chipId) ?? 0) + stack.count,
      );
    }
    for (const [chipId, count] of summedByChipId) {
      if (editedForPlayer.has(chipId)) continue;
      updateChipCount(playerId, chipId, count, 'photo');
    }
    setPhotoResults(prev => ({ ...prev, [playerId]: result }));
    if (photoBase64 && photoMimeType) {
      setPhotoImagesForFeedback(prev => ({
        ...prev,
        [playerId]: { base64: photoBase64, mimeType: photoMimeType },
      }));
    }
    setPhotoErrorToast('');
  };

  const openNumpad = (playerId: string, chipIndex: number) => {
    if (!isAdmin) return;
    setNumpadPlayerId(playerId);
    setNumpadChipIndex(chipIndex);
    setNumpadOpen(true);
  };

  // Handle numpad confirm with auto-advance through chips
  const handleNumpadConfirm = (value: number) => {
    const currentChip = chipValues[numpadChipIndex];
    if (numpadPlayerId && currentChip) {
      updateChipCount(numpadPlayerId, currentChip.id, value);
      
      if (numpadChipIndex >= chipValues.length - 1) {
        markPlayerDone(numpadPlayerId);
      } else {
        setNumpadChipIndex(numpadChipIndex + 1);
      }
    }
  };

  // Get total chip points for a player
  // Migration 080 — single branch point for "how many chip points
  // does this player hold?". For total-mode players we read the
  // direct stored count; for color-mode (today's behavior) we sum
  // chip_counts × chip values. Every downstream calculation
  // (getPlayerMoneyValue, getPlayerProfit, totalChipPoints,
  // expectedChipPoints, progressPercentage, chip-gap preview, the
  // finalize loop) reads through this function — so the math is
  // identical for both modes and zero-sum is preserved by the
  // existing chip-gap distribution.
  const getPlayerChipPoints = (playerId: string): number => {
    const player = players.find(p => p.id === playerId);
    if (player?.entryMode === 'total') {
      return player.totalChipCount ?? 0;
    }
    return calculateChipTotal(chipCounts[playerId] || {}, chipValues);
  };

  // Convert chip points to money value
  const getPlayerMoneyValue = (playerId: string): number => {
    const chipPoints = getPlayerChipPoints(playerId);
    return chipPoints * valuePerChip; // No rounding - keep exact value
  };

  const getPlayerProfit = (playerId: string): number => {
    const player = players.find(p => p.id === playerId);
    if (!player) return 0;
    const moneyValue = getPlayerMoneyValue(playerId);
    return calculateProfitLoss(moneyValue, player.rebuys, rebuyValue);
  };

  const totalBuyIns = players.reduce((sum, p) => sum + p.rebuys * rebuyValue, 0);
  const totalChipPoints = players.reduce((sum, p) => sum + getPlayerChipPoints(p.id), 0);
  const expectedChipPoints = players.reduce((sum, p) => sum + p.rebuys * chipsPerRebuy, 0);
  const isBalanced = totalChipPoints === expectedChipPoints;

  // Calculate progress percentage
  const progressPercentage = expectedChipPoints > 0 
    ? Math.min(100, (totalChipPoints / expectedChipPoints) * 100) 
    : 0;

  // Get gradient color from red (0%) to green (100%)
  // Stays red/orange longer, only turns green near completion
  const getProgressColor = (percentage: number): string => {
    if (totalChipPoints > expectedChipPoints) {
      return '#ef4444'; // Red if over
    }
    // Clamp percentage between 0 and 100
    const p = Math.min(100, Math.max(0, percentage));
    
    // Use power curve to stay red/orange longer
    // 0-60%: red to orange (hue 0-30)
    // 60-90%: orange to yellow (hue 30-60)  
    // 90-100%: yellow to green (hue 60-120)
    let hue: number;
    if (p < 60) {
      hue = (p / 60) * 30; // 0-30 (red to orange)
    } else if (p < 90) {
      hue = 30 + ((p - 60) / 30) * 30; // 30-60 (orange to yellow)
    } else {
      hue = 60 + ((p - 90) / 10) * 60; // 60-120 (yellow to green)
    }
    
    return `hsl(${hue}, 80%, 45%)`;
  };

  const allPlayersCounted = completedPlayers.size === players.length;

  const handleCalculate = async () => {
    if (!gameId || isFinalizing) return;

    // Stage 1: uncounted-players warning. Same as before — user
    // must tap once to acknowledge that some players were skipped.
    if (!allPlayersCounted && !showUncountedWarning) {
      setShowUncountedWarning(true);
      return;
    }

    // Compute the chip-gap (in money) before deciding what to do
    // next. The gap is the difference between the counted chip
    // value and the pool created by all rebuys; it ends up
    // distributed evenly across players via the existing adjusted-
    // profit logic below.
    const totalCountedMoney = players.reduce((sum, p) => sum + getPlayerMoneyValue(p.id), 0);
    const gapInMoney = totalCountedMoney - totalBuyIns; // positive = extra, negative = missing
    const gapPerPlayer = players.length > 0 ? gapInMoney / players.length : 0;

    // Stage 2: chip-gap warning. If there's a meaningful gap and
    // we haven't yet shown the gap-confirmation banner, surface
    // it now and require one more tap. The 1₪ tolerance matches
    // the existing `updateGameChipGap` threshold (`> 0.01`) and
    // adds a small absolute floor so trivial fractional drift
    // (rounding) doesn't trigger a confirmation dialog.
    if (Math.abs(gapInMoney) >= 1 && !chipGapPreview) {
      setChipGapPreview({ gapInMoney, gapPerPlayer });
      return;
    }

    // All warnings acknowledged — proceed.
    setShowUncountedWarning(false);
    setChipGapPreview(null);
    setIsFinalizing(true);
    
    // Save chip counts and calculate results with gap adjustment
    players.forEach(player => {
      const playerChips = chipCounts[player.id] || {};
      updateGamePlayerChips(player.id, playerChips);
      
      const moneyValue = getPlayerMoneyValue(player.id);
      const baseProfit = calculateProfitLoss(moneyValue, player.rebuys, rebuyValue);
      const adjustedProfit = baseProfit - gapPerPlayer;
      updateGamePlayerResults(player.id, moneyValue, adjustedProfit);
    });
    
    // Save gap info to the game
    if (Math.abs(gapInMoney) > 0.01) {
      updateGameChipGap(gameId, gapInMoney, gapPerPlayer);
    }
    
    updateGameStatus(gameId, 'completed');
    invalidateAICaches();

    try {
      await flushGameCompletion();
    } catch (err) {
      console.warn('Game completion sync failed, will retry via debounce:', err);
    }
    
    createGameEndBackup();
    deleteTTSPool(gameId);
    
    navigate(`/game-summary/${gameId}`, {
      state: { from: 'chip-entry', autoAI: isOwner && !!getGeminiApiKey() },
    });
  };

  return (
    <div className="fade-in" style={{ paddingBottom: '115px' }}>
      <div className="page-header">
        <h1 className="page-title">{t('chips.title')}</h1>
      </div>

      {/* Photo-capture-unavailable hint. Without this, admins of groups
          without a Gemini key never discover the photo button exists —
          it's silently hidden by the `photoAvailable` gate further down.
          Owner gets the actionable card (tap → Settings → Services);
          non-owner admin gets the informational variant ("ask the
          owner"). Members never reach this screen. Hidden once a key
          is configured (or for the platform-owner group via env-var
          fallback). */}
      {isAdmin && !photoAvailable && (
        <div style={{ marginBottom: '0.5rem' }}>
          <AIKeyMissingNotice feature="photo" accent="#10b981" />
        </div>
      )}

      {/* Live progress lives ONLY in the sticky bottom bar now.
          A previous version of this screen rendered a duplicate
          "Live Summary" card here (Expected / Counted / delta) but
          it was the same numbers shown 100px below in the always-
          visible sticky bottom bar. Removed in v5.61.x to recover
          ~110px of vertical real-estate at the top of the screen. */}

      {/* Player Selector — two-zone tile (migration 080).
          Big top zone = the group's default chip-entry mode (set in
          Settings → Game). Small labeled bottom button = the OTHER
          mode. Both groups get one-tap-per-player for their preferred
          mode, with the alternative always one labeled tap away.

          Zones can't be nested <button>s, so the outer wrapper is a
          <div> when both zones are interactive (pending) and a single
          <button> when only the undo behavior matters (completed).
          Non-admin members see a static tile with no interactions. */}
      <div className="card" style={{ padding: '0.75rem' }}>
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.15rem', fontWeight: '600' }}>
          {t('chips.selectPlayer', { done: `${completedPlayersCount}/${players.length}` })}
        </div>
        {/* One-line description so first-time users immediately
            grasp the two-zone tile mechanic (default mode label on
            top, alternative mode button on the bottom — both
            tappable). Members and admins both see it; it's
            educational copy, not gated. Stays muted so it doesn't
            compete with the tiles below. */}
        <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.55rem', opacity: 0.8 }}>
          {t('chips.selectPlayerHint')}
        </div>
        {/* Grid (not flex-wrap): every tile in a row gets the
            same width regardless of name length. With flex-wrap,
            tiles sized to their content so "Lior Moldovan"
            stretched to ~130px while "ק" shrank to ~108px in the
            same row — visually ragged. auto-fill keeps a
            consistent column count even when the last row has
            fewer tiles, so a lonely 7th tile sits at its normal
            width instead of stretching to fill the whole row. */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))',
          gap: '0.5rem',
        }}>
          {players.map(player => {
            const isCompleted = completedPlayers.has(player.id);
            const isSelected = selectedPlayerId === player.id;
            const chips = getPlayerChipPoints(player.id);
            const profit = getPlayerProfit(player.id);
            const otherMode: 'color' | 'total' = defaultEntryMode === 'color' ? 'total' : 'color';
            const showSecondary = isAdmin && !isCompleted;

            // Outer tile styles shared between completed (button) and
            // pending (div) variants so the visual identity is identical.
            const tileBorder = isSelected
              ? '2px solid var(--primary)'
              : isCompleted
                ? '2px solid #22c55e'
                : '2px solid var(--border)';
            const tileBg = isCompleted
              ? 'rgba(34, 197, 94, 0.15)'
              : isSelected
                ? 'rgba(16, 185, 129, 0.15)'
                : 'var(--surface)';
            // Width is driven by the parent grid (auto-fill +
            // minmax(110px, 1fr)) so every tile in a row is the
            // same width. The grid resolves to ~3 columns at
            // 375-414px viewports (3-tile rows for an 8-player
            // group → 3 rows) and ~2 columns at 320px. No
            // minWidth/maxWidth on the tile itself — the column
            // width already enforces consistency, and adding tile
            // bounds would fight the grid. Tap targets clear the
            // 44px iOS minimum because the height is driven by the
            // top-button minHeight + the alt-button minHeight,
            // independent of column width.
            const tileStyle: React.CSSProperties = {
              borderRadius: '12px',
              border: tileBorder,
              background: tileBg,
              transition: 'all 0.15s ease',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              padding: 0,
            };

            // Mode labels for this tile. Using the SHORT forms
            // ("לפי צבע" / "סך הכל") instead of the longer
            // "ספירה לפי צבע" — the verb is implied by context
            // (we're on the chip-counting screen) and the short
            // forms let the tile fit in 100-112px on mobile.
            const defaultModeLabel = defaultEntryMode === 'total'
              ? t('chips.entryMode.total')
              : t('chips.entryMode.color');

            // Top zone content — same for both completed and pending.
            // The default-mode hint is appended ONLY for pending
            // tiles (rendered separately inside the pending button
            // so we can gate it without affecting completed tiles).
            //
            // Name span: wrap long names to 2 lines instead of
            // stretching the tile or truncating to ellipsis. Word
            // breaks first, char breaks only if a single word is
            // wider than the tile (rare). Centered alignment keeps
            // 1-line and 2-line tiles visually consistent.
            const topZone = (
              <>
                <span style={{
                  fontWeight: 600,
                  fontSize: '1rem',
                  color: isCompleted ? '#22c55e' : isSelected ? 'var(--primary)' : 'var(--text)',
                  textAlign: 'center',
                  overflowWrap: 'break-word',
                  wordBreak: 'break-word',
                  lineHeight: 1.2,
                  maxWidth: '100%',
                }}>
                  {isCompleted && '\u200E✓ '}{player.playerName}
                </span>
                {chips > 0 && (
                  <span style={{
                    fontSize: '0.78rem',
                    color: profit >= 0 ? 'var(--success)' : 'var(--danger)',
                    marginTop: '0.15rem',
                  }}>
                    {profit >= 0 ? '\u200E+' : ''}{cleanNumber(profit)}
                  </span>
                )}
              </>
            );

            // Completed variant: whole tile is one undo button. The
            // bottom zone is hidden — switching modes for a completed
            // player goes through "undo → re-tap with the desired
            // zone" which is more discoverable than a hidden affordance
            // on a "done" tile. justifyContent:center keeps the name
            // visually centered when the row stretches the tile to
            // match a taller pending neighbor.
            if (isCompleted) {
              return (
                <button
                  key={player.id}
                  onClick={() => isAdmin && undoPlayerCompletion(player.id)}
                  disabled={!isAdmin}
                  style={{
                    ...tileStyle,
                    cursor: isAdmin ? 'pointer' : 'default',
                    padding: '0.7rem 0.85rem',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {topZone}
                </button>
              );
            }

            // Pending / selected variant: two separate buttons inside a
            // div wrapper so each zone has its own tap target. Both
            // zones now carry an explicit mode label so the action
            // each button performs is self-evident — no implicit
            // "the top is the default" guesswork. Member (non-admin)
            // sees just the top zone as a static label.
            return (
              <div key={player.id} style={tileStyle}>
                <button
                  type="button"
                  onClick={() => selectPlayerWithMode(player.id, defaultEntryMode)}
                  disabled={!isAdmin}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: 'inherit',
                    cursor: isAdmin ? 'pointer' : 'default',
                    fontFamily: 'inherit',
                    padding: '0.7rem 0.85rem 0.55rem',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '100%',
                    flex: 1,
                    minHeight: '52px',
                  }}
                  title={defaultModeLabel}
                >
                  {topZone}
                  {/* Default-mode hint — primary label that reads
                      as the recommended action. Slightly larger
                      and full-opacity (vs the muted alternative
                      below) gives a modest ~65/35 visual weight so
                      the default zone is the obvious first tap. */}
                  <span style={{
                    fontSize: '0.78rem',
                    color: 'var(--text-muted)',
                    marginTop: '0.3rem',
                    fontWeight: 500,
                    opacity: 1,
                  }}>
                    {defaultModeLabel}
                  </span>
                </button>
                {showSecondary && (
                  <button
                    type="button"
                    onClick={() => selectPlayerWithMode(player.id, otherMode)}
                    style={{
                      background: 'rgba(148, 163, 184, 0.10)',
                      border: 'none',
                      borderTop: '1px solid rgba(148, 163, 184, 0.25)',
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      padding: '0.55rem 0.5rem',
                      fontSize: '0.72rem',
                      fontWeight: 600,
                      width: '100%',
                      textAlign: 'center',
                      minHeight: '34px',
                      opacity: 0.75,
                    }}
                    title={
                      otherMode === 'total'
                        ? t('chips.entryMode.total')
                        : t('chips.entryMode.color')
                    }
                  >
                    {otherMode === 'total'
                      ? t('chips.entryMode.total')
                      : t('chips.entryMode.color')}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Selected Player Chip Entry */}
      {selectedPlayer && (() => {
        // Migration 080 — branch the per-player view by entry mode.
        // For total-mode players, render a compact summary card with
        // an "edit total" button that re-opens the TotalNumpadModal
        // and a "switch to color" link (with confirm) for changing
        // mode mid-entry. The color-mode view (chip grid + photo AI
        // banner + per-color buttons) is the existing flow below.
        if (selectedPlayer.entryMode === 'total') {
          const totalChips = selectedPlayer.totalChipCount ?? 0;
          const moneyValue = totalChips * valuePerChip;
          const profit = getPlayerProfit(selectedPlayer.id);
          return (
            <div className="card">
              <div className="card-header">
                <h3 className="card-title" style={{ margin: 0 }}>{selectedPlayer.playerName}</h3>
                <span className={getProfitColor(profit)} style={{ fontWeight: 700 }}>
                  {profit >= 0 ? '\u200E+' : ''}{cleanNumber(profit)}
                </span>
              </div>

              <div className="text-muted mb-1" style={{ fontSize: '0.875rem' }}>
                {cleanNumber(selectedPlayer.rebuys)}{selectedPlayer.rebuys !== 1 ? t('chips.buyinPlural') : t('chips.buyinSingle')} · {cleanNumber(selectedPlayer.rebuys * chipsPerRebuy)}{t('chips.chipsExpected')}
              </div>

              {/* Switch-mode escape hatch (total → color). Same
                  position / size / alignment as the color-mode
                  escape hatch elsewhere in this screen, so users
                  only have to learn the affordance once. The
                  confirm dialog (when the totalChipCount would be
                  wiped) is handled centrally by
                  selectPlayerWithMode — no inline confirm needed
                  here. */}
              {isAdmin && chipValues.length > 0 && (
                <div style={{ marginTop: '0.15rem', marginBottom: '0.5rem', textAlign: 'end' }}>
                  <button
                    type="button"
                    onClick={() => selectPlayerWithMode(selectedPlayer.id, 'color')}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      fontSize: '0.75rem',
                      textDecoration: 'underline',
                      textUnderlineOffset: '2px',
                      padding: '0.2rem 0',
                    }}
                  >
                    {t('chips.entryMode.switchLink').replace('{mode}', t('chips.entryMode.color'))}
                  </button>
                </div>
              )}

              {/* Big editable total. Tapping the number re-opens the
                  TotalNumpadModal pre-filled, so admins can correct
                  a mistype without going through undo. */}
              <button
                type="button"
                onClick={() => isAdmin && selectPlayerWithMode(selectedPlayer.id, 'total')}
                disabled={!isAdmin}
                style={{
                  width: '100%',
                  marginTop: '0.5rem',
                  marginBottom: '0.5rem',
                  background: 'var(--surface)',
                  border: '1px dashed rgba(148, 163, 184, 0.4)',
                  borderRadius: '12px',
                  padding: '1.1rem',
                  cursor: isAdmin ? 'pointer' : 'default',
                  fontFamily: 'inherit',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '0.2rem',
                }}
              >
                <span style={{ fontSize: '2rem', fontWeight: 700, color: 'var(--text)' }}>
                  {totalChips.toLocaleString('he-IL')}{t('chips.chipsSuffix')}
                </span>
                <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                  = {cleanNumber(moneyValue)}
                </span>
              </button>

              <div style={{
                display: 'flex',
                justifyContent: 'flex-end',
                paddingTop: '0.5rem',
                borderTop: '1px solid var(--border)',
              }}>
                <button
                  onClick={() => markPlayerDoneWithTotal(selectedPlayer.id, totalChips)}
                  disabled={!isAdmin}
                  style={{
                    background: 'linear-gradient(135deg, #22c55e, #16a34a)',
                    color: 'white',
                    border: 'none',
                    padding: '0.75rem 1.5rem',
                    borderRadius: '12px',
                    fontWeight: 700,
                    fontSize: '1rem',
                    cursor: isAdmin ? 'pointer' : 'default',
                    boxShadow: '0 4px 12px rgba(34, 197, 94, 0.3)',
                    opacity: isAdmin ? 1 : 0.6,
                  }}
                >
                  {t('chips.done')}
                </button>
              </div>
            </div>
          );
        }

        // ── Color-mode view (today's flow) ──────────────────────
        // Per-player photo-counting derived state. All of this is
        // additive: when no photo has been taken for this player,
        // photoResult is undefined and the rendering below collapses
        // to identical-to-pre-photo behavior.
        const photoResult = photoResults[selectedPlayer.id];
        const expectedTotalForPlayer = (selectedPlayer.rebuys || 0) * rebuyValue;
        const stackByChipId = new Map(photoResult?.stacks.map(s => [s.chipId, s]) || []);
        const editedForPlayer = userEditedFields[selectedPlayer.id] || new Set<string>();
        // Banner reconciliation: AI counts × chip values vs (1+rebuys)×rebuyValue.
        // We compute it from photoResult.totalValue so the banner shows
        // exactly what the AI proposed, not what the user edited
        // afterward. Tolerance: 2% of buy-in OR smallest chip value,
        // whichever is bigger.
        const smallestChipValue = chipValues.reduce(
          (min, c) => (c.value > 0 && c.value < min ? c.value : min),
          Number.POSITIVE_INFINITY,
        );
        const tolerance = Math.max(
          (expectedTotalForPlayer || rebuyValue) * 0.02,
          Number.isFinite(smallestChipValue) ? smallestChipValue * valuePerChip : 0,
        );
        const totalDelta = photoResult ? photoResult.totalValue * valuePerChip - expectedTotalForPlayer : 0;
        const totalWithinTolerance = !photoResult || Math.abs(totalDelta) <= tolerance;
        const totalWildlyOff = photoResult && expectedTotalForPlayer > 0
          ? Math.abs(totalDelta) > expectedTotalForPlayer * 0.5
          : false;

        return (
        <div className="card">
          <div className="card-header">
            <h3 className="card-title" style={{ margin: 0 }}>{selectedPlayer.playerName}</h3>
            <span className={getProfitColor(getPlayerProfit(selectedPlayer.id))} style={{ fontWeight: '700' }}>
              {getPlayerProfit(selectedPlayer.id) >= 0 ? '\u200E+' : ''}{cleanNumber(getPlayerProfit(selectedPlayer.id))}
            </span>
          </div>
          
          <div className="text-muted mb-1" style={{ fontSize: '0.875rem' }}>
            {cleanNumber(selectedPlayer.rebuys)}{selectedPlayer.rebuys !== 1 ? t('chips.buyinPlural') : t('chips.buyinSingle')} · {cleanNumber(selectedPlayer.rebuys * chipsPerRebuy)}{t('chips.chipsExpected')}
          </div>

          {/* Migration 080 — switch-mode escape hatch (color → total).
              For when admin opened color-by-color but realised this
              player's stack is easier to total. The confirm dialog
              (when partial per-color counts would be wiped) is
              handled centrally by selectPlayerWithMode — no inline
              confirm needed here. Visually identical to the
              total-mode escape hatch above: same position (right
              after meta line), same font-size, same alignment — so
              users learn it once. */}
          {isAdmin && (
            <div style={{ marginTop: '0.15rem', marginBottom: '0.5rem', textAlign: 'end' }}>
              <button
                type="button"
                onClick={() => selectPlayerWithMode(selectedPlayer.id, 'total')}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontSize: '0.75rem',
                  textDecoration: 'underline',
                  textUnderlineOffset: '2px',
                  padding: '0.2rem 0',
                }}
              >
                {t('chips.entryMode.switchLink').replace('{mode}', t('chips.entryMode.total'))}
              </button>
            </div>
          )}

          {/* AI Photo Banner — appears only after a successful photo for this player */}
          {photoResult && (
            <div style={{
              marginTop: '0.5rem',
              marginBottom: '0.5rem',
              padding: '0.6rem 0.75rem',
              borderRadius: '10px',
              background: totalWildlyOff
                ? 'rgba(239,68,68,0.10)'
                : totalWithinTolerance
                  ? 'rgba(16,185,129,0.10)'
                  : 'rgba(245,158,11,0.10)',
              border: `1px solid ${totalWildlyOff
                ? 'rgba(239,68,68,0.35)'
                : totalWithinTolerance
                  ? 'rgba(16,185,129,0.35)'
                  : 'rgba(245,158,11,0.35)'}`,
              fontSize: '0.8rem',
            }}>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '0.5rem',
                flexWrap: 'wrap',
              }}>
                <span style={{ fontWeight: 700 }}>
                  {t('chips.photo.banner.confidence')}:&nbsp;
                  <span style={{
                    color: photoResult.overallConfidence >= 80 ? '#10b981'
                      : photoResult.overallConfidence >= 60 ? '#eab308'
                      : '#ef4444',
                  }}>
                    {photoResult.overallConfidence}%
                  </span>
                </span>
                <span>
                  {t('chips.photo.banner.totalLabel')}:&nbsp;
                  {cleanNumber(photoResult.totalValue * valuePerChip)} / {cleanNumber(expectedTotalForPlayer)}
                  &nbsp;
                  {totalWithinTolerance ? (
                    <span style={{ color: '#10b981', fontWeight: 700 }}>{t('chips.photo.banner.totalOk')}</span>
                  ) : (
                    <span style={{ color: totalWildlyOff ? '#ef4444' : '#eab308', fontWeight: 700 }}>
                      {totalDelta < 0
                        ? `⚠ ${t('chips.photo.banner.totalShort')} ${cleanNumber(Math.abs(totalDelta))}`
                        : `⚠ ${t('chips.photo.banner.totalOver')} ${cleanNumber(Math.abs(totalDelta))}`}
                    </span>
                  )}
                </span>
                <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                  <button
                    type="button"
                    onClick={() => {
                      if (!isAdmin) return;
                      setPhotoTargetPlayerId(selectedPlayer.id);
                      setPhotoOpen(true);
                    }}
                    style={{
                      background: 'transparent',
                      border: '1px solid var(--border)',
                      color: 'var(--text)',
                      borderRadius: '8px',
                      padding: '0.25rem 0.55rem',
                      fontSize: '0.75rem',
                      cursor: isAdmin ? 'pointer' : 'not-allowed',
                      fontFamily: 'inherit',
                    }}
                  >
                    {t('chips.photo.banner.retake')}
                  </button>
                  {/* v5.59: one-tap escape hatch — wipe ALL AI-proposed
                      counts for this player (preserving fields the user
                      already manually edited) and remove the banner so
                      they can finish manually from a clean slate.
                      Honors manual-flow protection: per-field user edits
                      stay untouched, only photo-sourced fields reset. */}
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={() => {
                        const playerId = selectedPlayer.id;
                        const editedForPlayer = userEditedFields[playerId] || new Set<string>();
                        // Reset only chips that were filled by the photo
                        // and not subsequently edited by the user.
                        for (const stack of photoResult.stacks) {
                          if (editedForPlayer.has(stack.chipId)) continue;
                          updateChipCount(playerId, stack.chipId, 0, 'photo');
                        }
                        setPhotoResults(prev => {
                          const next = { ...prev };
                          delete next[playerId];
                          return next;
                        });
                        setPhotoImagesForFeedback(prev => {
                          const next = { ...prev };
                          delete next[playerId];
                          return next;
                        });
                      }}
                      style={{
                        background: 'transparent',
                        border: '1px solid rgba(239,68,68,0.35)',
                        color: '#fca5a5',
                        borderRadius: '8px',
                        padding: '0.25rem 0.55rem',
                        fontSize: '0.75rem',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                      title={t('chips.photo.banner.clearAITooltip')}
                    >
                      {t('chips.photo.banner.clearAI')}
                    </button>
                  )}
                </div>
              </div>
              {totalWildlyOff && (
                <div style={{ marginTop: '0.4rem', fontSize: '0.75rem', color: '#fca5a5' }}>
                  {t('chips.photo.banner.warningOff')}
                </div>
              )}
              {/* Honest framing: AI is an estimate, not a final answer.
                  Always shown — confidence number alone is too easy to
                  misread as "trust it blindly". v5.48. */}
              <div style={{
                marginTop: '0.4rem',
                fontSize: '0.7rem',
                color: 'var(--text-muted)',
                opacity: 0.85,
              }}>
                {t('chips.photo.banner.verifyHint')}
                {photoResult.shotsUsed === 1 && (
                  <> · <span style={{ color: '#eab308' }}>{t('chips.photo.banner.singleShot')}</span></>
                )}
                {photoResult.recountStackIds && photoResult.recountStackIds.length > 0 && (
                  <> · <span style={{ color: '#fca5a5', fontWeight: 600 }}>
                    {t('chips.photo.banner.recountCount').replace('{n}', String(photoResult.recountStackIds.length))}
                  </span></>
                )}
              </div>
              {/* v5.62.2 — feedback-hint line removed (chip-count
                  feedback loop was retired alongside the tuning
                  mechanism it used to feed). */}
              {/* v5.59 — collapsible detection overlay. Only available
                  when we still have the photo in memory for this
                  player AND the result has at least one stack with
                  a region (= came from the new pipeline). */}
              {(() => {
                const photoImg = photoImagesForFeedback[selectedPlayer.id];
                const hasRegions = photoResult.stacks.some(s => s.region);
                if (!photoImg || !hasRegions) return null;
                const isOpen = overlayExpandedPlayerId === selectedPlayer.id;
                const adjustedStackId = photoResult.totalValueCheckResult?.adjustedStackId ?? null;
                return (
                  <div style={{ marginTop: '0.5rem' }}>
                    <button
                      type="button"
                      onClick={() => setOverlayExpandedPlayerId(prev =>
                        prev === selectedPlayer.id ? null : selectedPlayer.id,
                      )}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--text-muted)',
                        cursor: 'pointer',
                        fontSize: '0.72rem',
                        padding: '0.2rem 0',
                        fontFamily: 'inherit',
                        textDecoration: 'underline',
                        textUnderlineOffset: '2px',
                      }}
                    >
                      {isOpen
                        ? t('chips.photo.banner.hideOverlay')
                        : t('chips.photo.banner.showOverlay')}
                    </button>
                    {isOpen && (
                      <div style={{ marginTop: '0.4rem' }}>
                        <ChipDetectionOverlay
                          photoBase64={photoImg.base64}
                          photoMimeType={photoImg.mimeType}
                          stacks={photoResult.stacks}
                          chipById={new Map(chipValues.map(c => [c.id, c]))}
                          adjustedStackId={adjustedStackId}
                          maxHeight={220}
                        />
                        {photoResult.detectionSignal && (
                          <div style={{
                            marginTop: '0.3rem',
                            fontSize: '0.65rem',
                            color: 'var(--text-muted)',
                          }}>
                            {t('chips.photo.banner.detectionSignal')}:&nbsp;
                            <span style={{
                              color: photoResult.detectionSignal === 'position-only'
                                ? '#fca5a5'
                                : 'var(--text)',
                            }}>
                              {t(`chips.photo.banner.detection.${photoResult.detectionSignal}` as const)}
                            </span>
                            {photoResult.whiteBalanceApplied && (
                              <> · <span style={{ color: '#10b981' }}>
                                {t('chips.photo.banner.wbOn')}
                              </span></>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          )}

          {/* Photo capture button — admin only, additive to manual flow.
              Hidden when the group has no per-group Gemini key AND no
              past game has an AI summary (= no proof the call path
              works). This avoids the worst-case mid-game UX of "click
              photo → spinner → API error → fall back to manual" after
              the user has already committed to the modal flow. The
              gate intentionally treats env-var fallback as available
              once ANY past AI feature has succeeded in this group, so
              groups that rely on the Vercel `GEMINI_API_KEY` env var
              (no per-group key) still get the photo button as long as
              their other AI features are working. */}
          {isAdmin && photoAvailable && !photoResult && (
            <div style={{ marginTop: '0.5rem', marginBottom: '0.5rem' }}>
              <button
                type="button"
                onClick={() => {
                  setPhotoTargetPlayerId(selectedPlayer.id);
                  setPhotoOpen(true);
                }}
                style={{
                  width: '100%',
                  padding: '0.6rem',
                  borderRadius: '10px',
                  border: '1px dashed rgba(16,185,129,0.4)',
                  background: 'rgba(16,185,129,0.06)',
                  color: '#10b981',
                  fontWeight: 600,
                  fontSize: '0.85rem',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {t('chips.photo.button')}
              </button>
            </div>
          )}

          {/* Chip Grid */}
          <div className="chip-grid">
            {chipValues.map((chip, chipIndex) => {
              const stack = stackByChipId.get(chip.id);
              const isEdited = editedForPlayer.has(chip.id);
              const showAIBorder = !!stack && !isEdited;
              // v5.48: a stack is "mismatched" when EITHER the total is off
              // AND its individual confidence is mediocre (< 70%, not 95
              // — we cap confidence at 90 now), OR the model flagged it
              // as needing manual recount, OR the top color it saw didn't
              // match the expected color (= the player likely placed the
              // wrong chip in this slot). Any of those → red border.
              const stackIsMismatch = !!stack && (
                stack.needsRecount === true ||
                stack.needsVerify === true ||
                stack.colorMatch === false ||
                (!totalWithinTolerance && stack.confidence < 70)
              );
              const aiBorderColor = showAIBorder
                ? confidenceColor(stack.confidence, stackIsMismatch)
                : null;
              // Extra at-a-glance icons in the header so the user doesn't
              // have to read the percentage to spot a problem stack.
              const showRecountIcon = !!stack && (stack.needsRecount === true || stack.needsVerify === true) && !isEdited;
              const showColorMismatchIcon = !!stack && stack.colorMatch === false && !isEdited && stack.count > 0;
              // v5.59 — purple "🛟 adjusted" badge: this stack's count
              // was nudged by the total-value sanity check (sum of
              // chip values × counts didn't match expected; the
              // lowest-confidence stack was reconciled). Hidden when
              // the user already overrode the value, since their
              // edit superseded the AI's adjustment anyway.
              const wasAdjusted = !!stack
                && !isEdited
                && photoResult?.totalValueCheckResult?.adjustedStackId === chip.id
                && (photoResult.totalValueCheckResult?.adjustmentChips ?? 0) !== 0;
              return (
              <div key={chip.id} className="chip-entry-card" style={{ 
                borderLeft: aiBorderColor
                  ? `4px solid ${aiBorderColor}`
                  : `4px solid ${chip.displayColor}`,
                background: chip.displayColor === '#FFFFFF' ? 'rgba(255,255,255,0.1)' : `${chip.displayColor}15`,
                position: 'relative',
              }}>
                <div 
                  className="chip-entry-header"
                  onClick={() => openNumpad(selectedPlayer.id, chipIndex)}
                  style={{ cursor: 'pointer' }}
                >
                  <div 
                    className="chip-circle-small" 
                    style={{ 
                      backgroundColor: chip.displayColor,
                      border: chip.displayColor === '#FFFFFF' || chip.displayColor === '#EAB308' ? '2px solid #888' : 'none'
                    }} 
                  />
                  <span style={{ fontSize: '0.75rem', color: '#94a3b8' }}>×{chip.value}</span>
                  {showColorMismatchIcon && (
                    <span
                      title={t('chips.photo.stack.colorMismatch')}
                      style={{
                        marginInlineStart: 'auto',
                        fontSize: '0.85rem',
                      }}
                    >⚠</span>
                  )}
                  {showRecountIcon && !showColorMismatchIcon && (
                    <span
                      title={t('chips.photo.stack.recount')}
                      style={{
                        marginInlineStart: 'auto',
                        fontSize: '0.85rem',
                      }}
                    >🔍</span>
                  )}
                  {wasAdjusted && !showRecountIcon && !showColorMismatchIcon && (
                    <span
                      title={t('chips.photo.stack.adjustedTooltip').replace(
                        '{n}',
                        String(photoResult?.totalValueCheckResult?.adjustmentChips ?? 0),
                      )}
                      style={{
                        marginInlineStart: 'auto',
                        fontSize: '0.65rem',
                        fontWeight: 700,
                        color: '#a855f7',
                        background: 'rgba(168,85,247,0.12)',
                        border: '1px solid rgba(168,85,247,0.35)',
                        padding: '1px 5px',
                        borderRadius: '4px',
                        lineHeight: 1.2,
                      }}
                    >
                      🛟 {t('chips.photo.stack.adjustedBadge')}
                    </span>
                  )}
                  {showAIBorder && stack && (
                    <span
                      title={
                        stack.rawCounts && stack.rawCounts.length > 1
                          ? `AI: ${stack.confidence}% (shots: ${stack.rawCounts.join(', ')})`
                          : `AI: ${stack.confidence}%`
                      }
                      style={{
                        marginInlineStart: showRecountIcon || showColorMismatchIcon ? 0 : 'auto',
                        fontSize: '0.65rem',
                        color: aiBorderColor || 'var(--text-muted)',
                        fontWeight: 700,
                      }}
                    >
                      {stack.confidence}%
                    </span>
                  )}
                </div>
                {/* DOM order is [plus, input, minus] so that under
                    the page's RTL direction (Hebrew), the flex row
                    renders visually as [− | count | +] — minus on
                    the LEFT, plus on the RIGHT. The container has
                    no explicit direction override, so this DOM
                    order is the lever that controls visual order. */}
                <div className="chip-entry-controls">
                  {isAdmin && (
                    <button
                      className="chip-btn chip-btn-plus"
                      onClick={() => updateChipCount(selectedPlayer.id, chip.id, (chipCounts[selectedPlayer.id]?.[chip.id] || 0) + 1)}
                    >
                      +
                    </button>
                  )}
                  <input
                    type="number"
                    className="chip-count-input"
                    value={chipCounts[selectedPlayer.id]?.[chip.id] || 0}
                    onChange={e => isAdmin && updateChipCount(selectedPlayer.id, chip.id, parseInt(e.target.value) || 0)}
                    onClick={() => isAdmin && openNumpad(selectedPlayer.id, chipIndex)}
                    readOnly
                    style={{
                      cursor: isAdmin ? 'pointer' : 'default',
                      opacity: isAdmin ? 1 : 0.7,
                      fontWeight: isEdited ? 700 : undefined,
                    }}
                    min="0"
                  />
                  {isAdmin && (
                    <button
                      className="chip-btn chip-btn-minus"
                      onClick={() => updateChipCount(selectedPlayer.id, chip.id, (chipCounts[selectedPlayer.id]?.[chip.id] || 0) - 1)}
                    >
                      −
                    </button>
                  )}
                </div>
              </div>
              );
            })}
          </div>
          
          {/* Player Total & Done Button */}
          <div style={{ 
            display: 'flex', 
            justifyContent: 'space-between', 
            alignItems: 'center',
            marginTop: '1rem',
            paddingTop: '1rem',
            borderTop: '1px solid var(--border)'
          }}>
            <div>
              <div style={{ fontWeight: '700', fontSize: '1.1rem' }}>
                {getPlayerChipPoints(selectedPlayer.id).toLocaleString()}{t('chips.chipsSuffix')}
              </div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                = {cleanNumber(getPlayerMoneyValue(selectedPlayer.id))}
              </div>
            </div>
            <button
              onClick={() => markPlayerDone(selectedPlayer.id)}
              style={{
                background: 'linear-gradient(135deg, #22c55e, #16a34a)',
                color: 'white',
                border: 'none',
                padding: '0.75rem 1.5rem',
                borderRadius: '12px',
                fontWeight: '700',
                fontSize: '1rem',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                boxShadow: '0 4px 12px rgba(34, 197, 94, 0.3)'
              }}
            >
              {t('chips.done')}
            </button>
          </div>
        </div>
        );
      })()}

      {/* All Players Done Message */}
      {!selectedPlayer && completedPlayersCount === players.length && players.length > 0 && (
        <div className="card" style={{ textAlign: 'center', padding: '2rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>🎉</div>
          <h3 style={{ marginBottom: '0.5rem' }}>{t('chips.allCounted')}</h3>
          <p className="text-muted">{t('chips.clickCalculate')}</p>
        </div>
      )}

      {/* Fixed Bottom Bar */}
      <div style={{ 
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 200,
        background: 'var(--background)',
        padding: '0.5rem 1rem 0.75rem',
        boxShadow: '0 -4px 20px rgba(0,0,0,0.2)',
        borderTop: `3px solid ${getProgressColor(progressPercentage)}`
      }}>
        {/* Progress bar */}
        <div style={{
          height: '10px',
          background: 'rgba(255,255,255,0.1)',
          borderRadius: '5px',
          overflow: 'hidden',
          marginBottom: '0.5rem'
        }}>
          <div style={{
            height: '100%',
            width: `${Math.min(progressPercentage, 100)}%`,
            background: getProgressColor(progressPercentage),
            borderRadius: '5px',
            transition: 'width 0.3s ease'
          }} />
        </div>
        
        {/* Stats row */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            {t('chips.doneCount', { done: `${completedPlayersCount}/${players.length}` })}
          </span>
          <span style={{ 
            fontSize: '0.9rem', 
            fontWeight: '700', 
            color: isBalanced && totalChipPoints > 0 ? '#22c55e' : getProgressColor(progressPercentage)
          }}>
            {isBalanced && totalChipPoints > 0 ? t('chips.balanced') : `${totalChipPoints.toLocaleString()} / ${expectedChipPoints.toLocaleString()}`}
          </span>
          <span style={{ 
            fontSize: '0.8rem', 
            fontWeight: '600',
            color: totalChipPoints > expectedChipPoints ? '#ef4444' : totalChipPoints === expectedChipPoints && totalChipPoints > 0 ? '#22c55e' : '#f59e0b'
          }}>
            {totalChipPoints > expectedChipPoints 
              ? `\u200E+${(totalChipPoints - expectedChipPoints).toLocaleString()}` 
              : totalChipPoints === expectedChipPoints && totalChipPoints > 0
                ? '✓'
                : `-${(expectedChipPoints - totalChipPoints).toLocaleString()}`}
          </span>
        </div>
        
        {showUncountedWarning && (
          <div style={{
            background: 'rgba(245, 158, 11, 0.15)',
            border: '1px solid rgba(245, 158, 11, 0.4)',
            borderRadius: '8px',
            padding: '0.6rem',
            marginBottom: '0.5rem',
            fontSize: '0.8rem',
            color: '#f59e0b',
            textAlign: 'center'
          }}>
            {t('chips.warningUncounted', { count: players.length - completedPlayers.size })}
          </div>
        )}
        {chipGapPreview && (
          <div style={{
            background: 'rgba(239, 68, 68, 0.12)',
            border: '1px solid rgba(239, 68, 68, 0.4)',
            borderRadius: '8px',
            padding: '0.6rem 0.75rem',
            marginBottom: '0.5rem',
            fontSize: '0.8rem',
            color: '#fca5a5',
            textAlign: 'center',
            lineHeight: 1.45,
          }}>
            <div style={{ fontWeight: 700, marginBottom: '0.25rem' }}>
              {chipGapPreview.gapInMoney > 0
                ? t('chips.warningGapOver', { amount: formatCurrency(Math.abs(chipGapPreview.gapInMoney)) })
                : t('chips.warningGapShort', { amount: formatCurrency(Math.abs(chipGapPreview.gapInMoney)) })}
            </div>
            <div style={{ fontSize: '0.72rem', opacity: 0.85 }}>
              {t('chips.warningGapPerPlayer', {
                amount: formatCurrency(Math.abs(chipGapPreview.gapPerPlayer)),
                direction: chipGapPreview.gapPerPlayer > 0
                  ? t('chips.warningGapDirDeducted')
                  : t('chips.warningGapDirCredited'),
              })}
            </div>
          </div>
        )}
        <button 
          className="btn btn-primary btn-block"
          onClick={handleCalculate}
          disabled={!isAdmin || isFinalizing}
          style={{ padding: '0.6rem', opacity: isAdmin && !isFinalizing ? 1 : 0.5 }}
        >
          {!isAdmin ? t('common.viewOnly') : isFinalizing ? '...' : (showUncountedWarning || chipGapPreview) ? t('chips.confirmCalculate') : t('chips.calculateResults')}
        </button>
      </div>

      {/* Numpad Modal.
          The optional 📷 photo button in the numpad header is the
          ONLY discovery surface for the photo flow on this screen
          right now (the standalone overview photo button is
          unreachable when admins auto-jump straight from player
          select into the numpad). Same gating as the overview-
          screen button: only render when the group has a working
          AI path AND there is no existing photo result for this
          player yet (re-photo flow goes through the overview). */}
      <NumpadModal
        isOpen={numpadOpen}
        playerName={players.find(p => p.id === numpadPlayerId)?.playerName || ''}
        chipColor={numpadChip?.color || ''}
        chipDisplayColor={numpadChip?.displayColor || '#3B82F6'}
        currentValue={numpadPlayerId && numpadChip ? (chipCounts[numpadPlayerId]?.[numpadChip.id] || 0) : 0}
        onConfirm={handleNumpadConfirm}
        onClose={() => setNumpadOpen(false)}
        chipIndex={numpadChipIndex}
        totalChips={chipValues.length}
        nextChipColor={nextChip?.color}
        nextChipDisplayColor={nextChip?.displayColor}
        isLastChip={numpadChipIndex >= chipValues.length - 1}
        showPhotoButton={photoAvailable && !!numpadPlayerId && !photoResults[numpadPlayerId]}
        onPhotoRequest={() => {
          // Close the numpad and open the photo modal targeting the
          // same player. After the photo flow completes (or is
          // cancelled), the user lands on the per-player overview
          // screen — selectedPlayerId is still set, so the overview
          // is already mounted underneath the numpad and just
          // becomes visible. From there they can accept the AI
          // result via "Done" or tap any chip row to re-enter the
          // numpad. Per-field user edits already typed in the
          // numpad are preserved by `applyPhotoResult` (it skips
          // chipIds present in `userEditedFields`).
          if (!numpadPlayerId) return;
          const targetId = numpadPlayerId;
          setNumpadOpen(false);
          setPhotoTargetPlayerId(targetId);
          setPhotoOpen(true);
        }}
      />

      {/* Total Numpad Modal — quick-total chip entry (migration 080).
          Renders only when the admin opened a player tile via the
          "total" zone (or via the per-player switch link inside the
          color flow). currentValue reads from the player's persisted
          totalChipCount so re-opening the modal shows the prior
          number, allowing edits before tapping Done. */}
      <TotalNumpadModal
        isOpen={totalNumpadOpen}
        playerName={players.find(p => p.id === totalNumpadPlayerId)?.playerName || ''}
        currentValue={players.find(p => p.id === totalNumpadPlayerId)?.totalChipCount ?? 0}
        valuePerChip={valuePerChip}
        formatMoney={formatCurrency}
        onConfirm={(value) => {
          if (totalNumpadPlayerId) {
            markPlayerDoneWithTotal(totalNumpadPlayerId, value);
          }
        }}
        onClose={() => setTotalNumpadOpen(false)}
      />

      {/* Photo Capture Modal — additive to manual flow.
          Uses photoTargetPlayerId (locked at the moment the user
          opened the modal) so the result is applied to the right
          player even if state shifts mid-flow. */}
      {photoTargetPlayerId && (() => {
        const targetPlayer = players.find(p => p.id === photoTargetPlayerId);
        if (!targetPlayer) return null;
        return (
          <PhotoCaptureModal
            isOpen={photoOpen}
            onClose={() => {
              setPhotoOpen(false);
              setPhotoTargetPlayerId(null);
            }}
            onResult={(result, base64, mimeType) =>
              applyPhotoResult(result, targetPlayer.id, base64, mimeType)
            }
            chipValues={chipValues}
            expectedTotalValue={targetPlayer.rebuys * chipsPerRebuy}
            title={`📷 ${targetPlayer.playerName}`}
          />
        );
      })()}

      {/* Photo error toast — auto-dismisses after 5s */}
      {photoErrorToast && (
        <div style={{
          position: 'fixed',
          bottom: '120px',
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'rgba(239,68,68,0.95)',
          color: 'white',
          padding: '0.6rem 1rem',
          borderRadius: '10px',
          fontSize: '0.85rem',
          fontWeight: 600,
          maxWidth: '90vw',
          textAlign: 'center',
          zIndex: 500,
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        }}>
          {photoErrorToast}
        </div>
      )}
    </div>
  );
};

const getProfitColor = (profit: number): string => {
  if (profit > 0) return 'profit';
  if (profit < 0) return 'loss';
  return 'neutral';
};

export default ChipEntryScreen;
