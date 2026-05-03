import { useState, useEffect, useRef } from 'react';
import { useTranslation, translateChipColor } from '../i18n';
import { shareToWhatsApp } from '../utils/sharing';
import {
  getAllPlayers, addPlayer, getSettings, saveSettings, getChipValues,
  saveChipValue, deleteChipValue,
} from '../database/storage';
import type { Player, PlayerGender, Settings, ChipValue } from '../types';
import { NumericInput } from './NumericInput';

interface GroupWizardProps {
  ownerPlayerName: string | null;
  groupName: string | null;
  onComplete: () => void;
  onSelfCreate?: (name: string) => Promise<unknown>;
  createPlayerInvite: (playerId: string) => Promise<{
    data: { invite_code: string; player_name: string; already_existed: boolean } | null;
    error: unknown;
  }>;
  groupInviteCode: string | null;
}

type WizardStep = 'welcome' | 'players' | 'game' | 'ai' | 'invites' | 'done';
const STEPS: WizardStep[] = ['welcome', 'players', 'game', 'ai', 'invites', 'done'];

interface PlayerInviteState {
  code: string;
  message: string;
}

export default function GroupWizard({ ownerPlayerName, groupName, onComplete, onSelfCreate, createPlayerInvite, groupInviteCode }: GroupWizardProps) {
  const { t, isRTL } = useTranslation();
  const [currentStep, setCurrentStep] = useState<WizardStep>('welcome');
  
  const [players, setPlayers] = useState<Player[]>([]);
  const [newName, setNewName] = useState('');
  const [newGender, setNewGender] = useState<PlayerGender>('male');
  const [settings, setSettings] = useState<Settings>(getSettings());
  const [chipValues, setChipValues] = useState<ChipValue[]>(getChipValues());
  const [newLocation, setNewLocation] = useState('');
  const [geminiKey, setGeminiKey] = useState(settings.geminiApiKey || '');
  const [error, setError] = useState('');
  const [invites, setInvites] = useState<Record<string, PlayerInviteState>>({});
  const [inviteLoading, setInviteLoading] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [selfName, setSelfName] = useState('');
  const [selfCreating, setSelfCreating] = useState(false);
  const [showAddChip, setShowAddChip] = useState(false);
  const [newChipValue, setNewChipValue] = useState('');
  const [newChipColor, setNewChipColor] = useState('');
  const [newChipDisplayColor, setNewChipDisplayColor] = useState('#3B82F6');
  const needsSelfCreate = !ownerPlayerName && !!onSelfCreate;
  const playerInputRef = useRef<HTMLInputElement>(null);
  const [showWelcomeModal, setShowWelcomeModal] = useState(false);
  const [showGameFlowModal, setShowGameFlowModal] = useState(false);

  useEffect(() => {
    setPlayers(getAllPlayers());
    const s = getSettings();
    setSettings(s);
    setChipValues(getChipValues());
    setGeminiKey(s.geminiApiKey || '');
  }, []);

  useEffect(() => {
    if (ownerPlayerName) {
      setPlayers(getAllPlayers());
    }
  }, [ownerPlayerName]);

  const currentIdx = STEPS.indexOf(currentStep);

  const goNext = () => {
    if (currentStep === 'ai' && geminiKey.trim() && geminiKey.trim() !== (settings.geminiApiKey || '')) {
      handleSaveAiKey();
    }
    const next = currentIdx + 1;
    if (next < STEPS.length) setCurrentStep(STEPS[next]);
    else onComplete();
  };

  const handleAddPlayer = () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    if (players.some(p => p.name.toLowerCase() === trimmed.toLowerCase())) {
      setError(t('wizard.playerExists'));
      return;
    }
    addPlayer(trimmed, 'permanent', newGender);
    setPlayers(getAllPlayers());
    setNewName('');
    setNewGender('male');
    setError('');
    setTimeout(() => playerInputRef.current?.focus(), 0);
  };

  const handleSettingsChange = (key: keyof Settings, value: unknown) => {
    const updated = { ...settings, [key]: value };
    setSettings(updated);
    saveSettings(updated);
  };

  const handleAddLocation = () => {
    const trimmed = newLocation.trim();
    if (!trimmed) return;
    const current = settings.locations ?? [];
    if (!current.includes(trimmed)) {
      handleSettingsChange('locations', [...current, trimmed]);
    }
    setNewLocation('');
  };

  const handleSaveAiKey = () => {
    handleSettingsChange('geminiApiKey', geminiKey.trim());
  };

  const handleChipValueChange = (chipId: string, value: number) => {
    const chip = chipValues.find(c => c.id === chipId);
    if (chip) {
      const updated = { ...chip, value };
      saveChipValue(updated);
      setChipValues(chipValues.map(c => c.id === chipId ? updated : c));
    }
  };

  const handleDeleteChip = (chipId: string) => {
    deleteChipValue(chipId);
    setChipValues(chipValues.filter(c => c.id !== chipId));
  };

  const handleAddChip = () => {
    const val = parseInt(newChipValue);
    const name = newChipColor.trim();
    if (!val || val <= 0 || !name) return;
    const chip = saveChipValue({ color: name, value: val, displayColor: newChipDisplayColor });
    setChipValues([...chipValues, chip]);
    setNewChipValue('');
    setNewChipColor('');
    setNewChipDisplayColor('#3B82F6');
    setShowAddChip(false);
  };

  const appUrl = window.location.origin;
  const canShare = typeof navigator.share === 'function';

  const handleGenerateInvite = async (player: Player) => {
    setInviteLoading(player.id);
    setInviteError(null);
    const { data, error: err } = await createPlayerInvite(player.id);
    setInviteLoading(null);
    if (err) {
      setInviteError((err as { message?: string })?.message || t('wizard.inviteError'));
      return;
    }
    if (!data) {
      setInviteError(t('wizard.inviteError'));
      return;
    }
    const closing = player.gender === 'female' ? t('wizard.inviteMsgClosingF') : t('wizard.inviteMsgClosingM');
    const msg = [
      t('wizard.inviteMsgGreeting', { name: data.player_name }),
      '',
      t('wizard.inviteMsgOpen'),
      appUrl,
      '',
      t('wizard.inviteMsgCode'),
      data.invite_code,
      '',
      closing,
    ].join('\n');
    setInvites(prev => ({ ...prev, [player.id]: { code: data.invite_code, message: msg } }));
  };

  const handleCopyInvite = (playerId: string, message: string) => {
    navigator.clipboard.writeText(message);
    setCopiedId(playerId);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleShareInvite = (playerName: string, message: string) => {
    navigator.share({ title: t('wizard.inviteSent') + ' — ' + playerName, text: message }).catch(() => {});
  };

  const handleCopyGroupCode = () => {
    if (groupInviteCode) {
      navigator.clipboard.writeText(groupInviteCode);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    }
  };

  const stepInfo: Record<WizardStep, { icon: string; title: string; desc: string }> = {
    welcome: { icon: '🃏', title: t('wizard.welcomeTitle'), desc: t('wizard.welcomeDesc') },
    players: { icon: '👥', title: t('wizard.playersTitle'), desc: t('wizard.playersDesc') },
    game: { icon: '🎮', title: t('wizard.gameTitle'), desc: t('wizard.gameDesc') },
    ai: { icon: '🤖', title: t('wizard.aiTitle'), desc: t('wizard.aiDesc') },
    invites: { icon: '📨', title: t('wizard.invitesTitle'), desc: t('wizard.invitesDesc') },
    done: { icon: '✅', title: t('wizard.doneTitle'), desc: t('wizard.doneDesc') },
  };

  const info = stepInfo[currentStep];
  const otherPlayers = players.filter(p => p.name !== ownerPlayerName);

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'var(--background)',
      display: 'flex', flexDirection: 'column',
      direction: isRTL ? 'rtl' : 'ltr',
    }}>
      {/* Header */}
      <div style={{
        padding: 'max(0.65rem, env(safe-area-inset-top)) max(0.75rem, env(safe-area-inset-right)) 0.65rem max(0.75rem, env(safe-area-inset-left))',
        borderBottom: '1px solid var(--border)',
        background: 'var(--surface)',
        flexShrink: 0,
      }}>
        <div style={{ maxWidth: '26rem', margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
        {(() => {
          const contentSteps = STEPS.filter(s => s !== 'welcome' && s !== 'done');
          const contentIdx = contentSteps.indexOf(currentStep as typeof contentSteps[number]);
          const showProgress = currentStep !== 'welcome' && currentStep !== 'done';
          return (<>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: showProgress ? '0.5rem' : 0 }}>
              <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#a78bfa' }}>
                {t('wizard.title')}
              </span>
              {showProgress && (
                <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  {contentIdx + 1}/{contentSteps.length}
                </span>
              )}
            </div>
            {showProgress && (
              <div style={{ display: 'flex', gap: '0.35rem' }}>
                {contentSteps.map((_, i) => (
                  <div key={i} style={{
                    flex: 1, height: '4px', borderRadius: '2px',
                    background: i <= contentIdx ? '#10B981' : 'rgba(100,100,100,0.3)',
                    transition: 'background 0.3s ease',
                  }} />
                ))}
              </div>
            )}
          </>);
        })()}
        </div>
      </div>

      {/* Content — minHeight:0 so this region can shrink and scroll; otherwise footer is pushed below the viewport */}
      <div style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        WebkitOverflowScrolling: 'touch',
        paddingTop: '0.75rem',
        paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))',
        paddingLeft: 'max(0.75rem, env(safe-area-inset-left))',
        paddingRight: 'max(0.75rem, env(safe-area-inset-right))',
      }}>
        <div style={{
          maxWidth: '26rem',
          margin: '0 auto',
          width: '100%',
          boxSizing: 'border-box',
        }}>
        <div style={{ textAlign: 'center', marginBottom: '1.1rem', paddingInline: '0.15rem' }}>
          <div style={{ fontSize: 'clamp(2rem, 9vw, 2.6rem)', lineHeight: 1, marginBottom: '0.35rem' }}>{info.icon}</div>
          <h2 style={{ color: 'var(--text)', fontSize: 'clamp(1.02rem, 4.2vw, 1.15rem)', margin: '0 0 0.3rem', lineHeight: 1.35 }}>{info.title}</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', margin: 0, lineHeight: 1.5 }}>{info.desc}</p>
        </div>

        {/* ===== WELCOME STEP ===== */}
        {currentStep === 'welcome' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            {[
              { icon: '👥', title: t('wizard.welcomeStep1Title'), desc: t('wizard.welcomeStep1Desc') },
              { icon: '🎮', title: t('wizard.welcomeStep2Title'), desc: t('wizard.welcomeStep2Desc') },
              { icon: '🤖', title: t('wizard.welcomeStep3Title'), desc: t('wizard.welcomeStep3Desc') },
              { icon: '📨', title: t('wizard.welcomeStep4Title'), desc: t('wizard.welcomeStep4Desc') },
            ].map((step, idx, arr) => (
              <div key={idx} style={{ display: 'contents' }}>
                <div style={{
                  display: 'flex', alignItems: 'flex-start', gap: '0.75rem',
                  padding: '0.75rem', borderRadius: '10px',
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  animation: `contentFadeIn 0.3s ease-out ${idx * 0.08}s both`,
                }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: '10px',
                    background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.2)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '1.1rem', flexShrink: 0,
                  }}>
                    {step.icon}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text)', marginBottom: '0.15rem' }}>
                      {step.title}
                    </div>
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                      {step.desc}
                    </div>
                  </div>
                  <span style={{
                    fontSize: '0.7rem', fontWeight: 700, color: 'rgba(16,185,129,0.6)',
                    padding: '0.15rem 0.4rem', borderRadius: '6px',
                    background: 'rgba(16,185,129,0.08)', flexShrink: 0,
                  }}>
                    {idx + 1}
                  </span>
                </div>
                {idx < arr.length - 1 && (
                  <div style={{ textAlign: 'center', fontSize: '0.85rem', color: 'var(--text-muted)', lineHeight: 1 }}>
                    ▼
                  </div>
                )}
              </div>
            ))}

            <p style={{
              fontSize: '0.75rem', color: 'var(--text-muted)', textAlign: 'center',
              marginTop: '0.25rem', lineHeight: 1.5,
            }}>
              {t('wizard.welcomeHint')}
            </p>
          </div>
        )}

        {/* ===== PLAYERS STEP ===== */}
        {currentStep === 'players' && (
          <div>
            {needsSelfCreate ? (
              <div style={{ marginBottom: '1rem' }}>
                <div style={{
                  background: 'var(--surface)', borderRadius: '10px', padding: '1rem',
                  border: '1px solid rgba(16,185,129,0.2)',
                  marginBottom: '0.5rem',
                }}>
                  <label style={{ fontSize: '0.8rem', color: 'var(--text-muted)', display: 'block', marginBottom: '0.5rem' }}>
                    {t('wizard.selfCreateLabel')}
                  </label>
                  <div style={{ display: 'flex', gap: '0.4rem' }}>
                    <input
                      type="text"
                      value={selfName}
                      onChange={e => { setSelfName(e.target.value); setError(''); }}
                      placeholder={t('wizard.selfCreatePlaceholder')}
                      autoFocus
                      onKeyDown={async e => {
                        if (e.key === 'Enter' && selfName.trim() && onSelfCreate) {
                          setSelfCreating(true);
                          await onSelfCreate(selfName.trim());
                          setSelfCreating(false);
                        }
                      }}
                      style={{
                        flex: 1, padding: '0.6rem 0.75rem', borderRadius: '8px',
                        border: '1px solid var(--border)', background: 'var(--background)',
                        color: 'var(--text)', fontSize: '0.9rem', fontFamily: 'Outfit, sans-serif',
                      }}
                    />
                    <button
                      onClick={async () => {
                        if (!selfName.trim() || !onSelfCreate) return;
                        setSelfCreating(true);
                        await onSelfCreate(selfName.trim());
                        setSelfCreating(false);
                      }}
                      disabled={!selfName.trim() || selfCreating}
                      style={{
                        padding: '0.5rem 1rem', borderRadius: '8px', border: 'none',
                        background: selfName.trim() && !selfCreating ? 'var(--primary)' : 'rgba(100,100,100,0.3)',
                        color: 'white', cursor: selfName.trim() && !selfCreating ? 'pointer' : 'default',
                        fontSize: '0.85rem', fontFamily: 'Outfit, sans-serif', fontWeight: 600,
                      }}
                    >
                      {selfCreating ? '...' : t('wizard.selfCreateButton')}
                    </button>
                  </div>
                  {error && <p style={{ color: '#ef4444', fontSize: '0.8rem', marginTop: '0.4rem' }}>{error}</p>}
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                  <input
                    ref={playerInputRef}
                    type="text"
                    value={newName}
                    onChange={e => { setNewName(e.target.value); setError(''); }}
                    placeholder={t('wizard.playerPlaceholder')}
                    onKeyDown={e => e.key === 'Enter' && handleAddPlayer()}
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      padding: '0.5rem 0.65rem', borderRadius: '8px',
                      border: '1px solid var(--border)', background: 'var(--surface)',
                      color: 'var(--text)', fontSize: '0.88rem', fontFamily: 'Outfit, sans-serif',
                    }}
                  />
                  <div style={{ display: 'flex', gap: '0.45rem', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap' }}>
                    <select
                      value={newGender}
                      onChange={e => setNewGender(e.target.value as PlayerGender)}
                      style={{
                        padding: '0.42rem 0.55rem', borderRadius: '8px',
                        border: '1px solid var(--border)', background: 'var(--surface)',
                        color: 'var(--text)', fontSize: '0.8rem', fontFamily: 'Outfit, sans-serif', cursor: 'pointer',
                        minHeight: '2.25rem',
                      }}
                    >
                      <option value="male">{t('wizard.male')}</option>
                      <option value="female">{t('wizard.female')}</option>
                    </select>
                    <button
                      onClick={handleAddPlayer}
                      disabled={!newName.trim()}
                      style={{
                        padding: '0.45rem 1rem', borderRadius: '8px', border: 'none',
                        background: newName.trim() ? 'var(--primary)' : 'rgba(100,100,100,0.3)',
                        color: 'white', cursor: newName.trim() ? 'pointer' : 'default',
                        fontSize: '0.85rem', fontFamily: 'Outfit, sans-serif', fontWeight: 600,
                        minHeight: '2.25rem',
                      }}
                    >
                      +
                    </button>
                  </div>
                </div>
                {error && <p style={{ color: '#ef4444', fontSize: '0.8rem', margin: 0, textAlign: 'center' }}>{error}</p>}

                {otherPlayers.length === 0 ? (
                  <div style={{
                    textAlign: 'center', padding: '1.15rem 0.85rem', borderRadius: '10px',
                    border: '2px dashed var(--border)', color: 'var(--text-muted)', fontSize: '0.82rem',
                    lineHeight: 1.55,
                  }}>
                    {t('wizard.noPlayersYet')}
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', justifyContent: 'center' }}>
                    {otherPlayers.map(p => (
                      <span key={p.id} style={{
                        padding: '0.35rem 0.65rem', borderRadius: '8px',
                        background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.3)',
                        color: '#10B981', fontSize: '0.85rem', fontWeight: 500,
                      }}>
                        {p.name}
                      </span>
                    ))}
                  </div>
                )}

                <div style={{
                  padding: '0.65rem 0.75rem',
                  borderRadius: '10px',
                  background: 'rgba(99,102,241,0.06)',
                  border: '1px solid rgba(99,102,241,0.12)',
                }}>
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0, textAlign: 'center', lineHeight: 1.55 }}>
                    {t('wizard.playersHint', { name: ownerPlayerName || '' })}
                  </p>
                  <p style={{ fontSize: '0.68rem', color: 'var(--text-muted)', margin: '0.5rem 0 0', textAlign: 'center', lineHeight: 1.5, opacity: 0.85 }}>
                    {t('wizard.traitsHint')}
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ===== GAME STEP ===== */}
        {currentStep === 'game' && (
          <div>
            <div style={{
              background: 'var(--surface)', borderRadius: '10px', padding: '0.75rem',
              border: '1px solid var(--border)', marginBottom: '0.75rem',
            }}>
              <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '0.5rem' }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '0.25rem' }}>
                    {t('settings.game.buyinValue')} (₪)
                  </label>
                  <NumericInput
                    value={settings.rebuyValue}
                    onChange={n => handleSettingsChange('rebuyValue', n)}
                    min={1}
                    style={{
                      width: '100%', padding: '0.5rem', borderRadius: '6px',
                      border: '1px solid var(--border)', background: 'var(--background)',
                      color: 'var(--text)', fontSize: '0.9rem', fontFamily: 'Outfit, sans-serif',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '0.25rem' }}>
                    {t('settings.game.chipsPerBuyin')}
                  </label>
                  <NumericInput
                    value={settings.chipsPerRebuy}
                    onChange={n => handleSettingsChange('chipsPerRebuy', n)}
                    min={1}
                    style={{
                      width: '100%', padding: '0.5rem', borderRadius: '6px',
                      border: '1px solid var(--border)', background: 'var(--background)',
                      color: 'var(--text)', fontSize: '0.9rem', fontFamily: 'Outfit, sans-serif',
                      boxSizing: 'border-box',
                    }}
                  />
                </div>
              </div>
              <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', margin: 0 }}>
                {t('settings.game.buyinHelper', {
                  value: String(settings.rebuyValue),
                  chips: (settings.chipsPerRebuy || 10000).toLocaleString(),
                })}
              </p>
            </div>

            {/* Chip values — editable */}
            <div style={{
              background: 'var(--surface)', borderRadius: '10px', padding: '0.75rem',
              border: '1px solid var(--border)', marginBottom: '0.75rem',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                  {t('wizard.chipValues')}
                </label>
                <button
                  onClick={() => setShowAddChip(!showAddChip)}
                  style={{
                    padding: '0.15rem 0.45rem', borderRadius: '5px', border: 'none',
                    background: 'var(--primary)', color: 'white', cursor: 'pointer',
                    fontSize: '0.7rem', fontFamily: 'Outfit, sans-serif', fontWeight: 600,
                  }}
                >+</button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                {chipValues.map(cv => (
                  <div key={cv.id} style={{
                    display: 'flex', alignItems: 'center', gap: '0.4rem',
                  }}>
                    <span style={{
                      width: 12, height: 12, borderRadius: '50%', flexShrink: 0,
                      background: cv.displayColor, border: cv.displayColor === '#FFFFFF' ? '1px solid #888' : 'none',
                    }} />
                    <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', flex: 1, minWidth: 0 }}>
                      {translateChipColor(cv.color, t)}
                    </span>
                    <NumericInput
                      value={cv.value}
                      onChange={n => handleChipValueChange(cv.id, n)}
                      min={1}
                      style={{
                        width: '70px', padding: '0.25rem 0.4rem', borderRadius: '5px',
                        border: '1px solid var(--border)', background: 'var(--background)',
                        color: 'var(--text)', fontSize: '0.78rem', fontFamily: 'Outfit, sans-serif',
                        textAlign: 'center',
                      }}
                    />
                    {chipValues.length > 1 && (
                      <button
                        onClick={() => handleDeleteChip(cv.id)}
                        style={{
                          background: 'none', border: 'none', color: 'var(--text-muted)',
                          cursor: 'pointer', padding: '0.1rem 0.25rem', fontSize: '0.7rem',
                          opacity: 0.6,
                        }}
                      >✕</button>
                    )}
                  </div>
                ))}
              </div>
              {showAddChip && (
                <div style={{
                  marginTop: '0.5rem', padding: '0.5rem', borderRadius: '6px',
                  border: '1px dashed var(--border)', background: 'var(--background)',
                }}>
                  <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
                    <input
                      type="color"
                      value={newChipDisplayColor}
                      onChange={e => setNewChipDisplayColor(e.target.value)}
                      style={{ width: 36, height: 36, padding: 0, border: 'none', cursor: 'pointer', borderRadius: '4px' }}
                    />
                    <input
                      type="text"
                      value={newChipColor}
                      onChange={e => setNewChipColor(e.target.value)}
                      placeholder={t('settings.chips.chipNamePlaceholder')}
                      style={{
                        flex: 1, padding: '0.3rem 0.5rem', borderRadius: '5px',
                        border: '1px solid var(--border)', background: 'var(--surface)',
                        color: 'var(--text)', fontSize: '0.78rem', fontFamily: 'Outfit, sans-serif',
                      }}
                    />
                    <input
                      type="number"
                      value={newChipValue}
                      onChange={e => setNewChipValue(e.target.value)}
                      placeholder={t('settings.chips.chipPointsPlaceholder')}
                      min="1"
                      style={{
                        width: '65px', padding: '0.3rem 0.4rem', borderRadius: '5px',
                        border: '1px solid var(--border)', background: 'var(--surface)',
                        color: 'var(--text)', fontSize: '0.78rem', fontFamily: 'Outfit, sans-serif',
                        textAlign: 'center',
                      }}
                    />
                    <button
                      onClick={handleAddChip}
                      disabled={!newChipColor.trim() || !newChipValue || parseInt(newChipValue) <= 0}
                      style={{
                        padding: '0.3rem 0.55rem', borderRadius: '5px', border: 'none',
                        background: newChipColor.trim() && newChipValue ? 'var(--primary)' : 'rgba(100,100,100,0.3)',
                        color: 'white', cursor: newChipColor.trim() && newChipValue ? 'pointer' : 'default',
                        fontSize: '0.75rem', fontFamily: 'Outfit, sans-serif', fontWeight: 600,
                      }}
                    >+</button>
                  </div>
                </div>
              )}
            </div>

            {/* Locations */}
            <div style={{
              background: 'var(--surface)', borderRadius: '10px', padding: '0.75rem',
              border: '1px solid var(--border)', marginBottom: '0.75rem',
            }}>
              <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '0.4rem' }}>
                📍 {t('wizard.locationsLabel')}
              </label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginBottom: '0.5rem' }}>
                {(settings.locations ?? []).map(loc => (
                  <span key={loc} style={{
                    display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                    padding: '0.3rem 0.55rem', borderRadius: '6px',
                    background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.3)',
                    color: '#10B981', fontSize: '0.8rem',
                  }}>
                    {loc}
                    <button
                      onClick={() => handleSettingsChange('locations', (settings.locations ?? []).filter(l => l !== loc))}
                      style={{
                        background: 'none', border: 'none', color: '#10B981',
                        cursor: 'pointer', padding: 0, fontSize: '0.7rem', lineHeight: 1,
                      }}
                    >✕</button>
                  </span>
                ))}
                {(settings.locations ?? []).length === 0 && (
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                    {t('wizard.noLocations')}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                <input
                  type="text"
                  value={newLocation}
                  onChange={e => setNewLocation(e.target.value)}
                  placeholder={t('wizard.locationPlaceholder')}
                  onKeyDown={e => e.key === 'Enter' && handleAddLocation()}
                  style={{
                    flex: 1, padding: '0.45rem 0.6rem', borderRadius: '6px',
                    border: '1px solid var(--border)', background: 'var(--background)',
                    color: 'var(--text)', fontSize: '0.85rem', fontFamily: 'Outfit, sans-serif',
                  }}
                />
                <button
                  onClick={handleAddLocation}
                  disabled={!newLocation.trim()}
                  style={{
                    padding: '0.45rem 0.7rem', borderRadius: '6px', border: 'none',
                    background: newLocation.trim() ? 'var(--primary)' : 'rgba(100,100,100,0.3)',
                    color: 'white', cursor: newLocation.trim() ? 'pointer' : 'default',
                    fontSize: '0.8rem', fontFamily: 'Outfit, sans-serif', fontWeight: 600,
                  }}
                >+</button>
              </div>
            </div>

            {/* Game night days */}
            <div style={{
              background: 'var(--surface)', borderRadius: '10px', padding: '0.75rem',
              border: '1px solid var(--border)',
            }}>
              <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '0.4rem' }}>
                {t('settings.game.gameNightDays')}
              </label>
              <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                {[
                  { day: 0, label: t('settings.game.sun') },
                  { day: 1, label: t('settings.game.mon') },
                  { day: 2, label: t('settings.game.tue') },
                  { day: 3, label: t('settings.game.wed') },
                  { day: 4, label: t('settings.game.thu') },
                  { day: 5, label: t('settings.game.fri') },
                  { day: 6, label: t('settings.game.sat') },
                ].map(({ day, label }) => {
                  const days = settings.gameNightDays || [4, 6];
                  const isSelected = days.includes(day);
                  return (
                    <button
                      key={day}
                      onClick={() => {
                        const current = settings.gameNightDays || [4, 6];
                        const updated = isSelected
                          ? current.filter(d => d !== day)
                          : [...current, day].sort();
                        if (updated.length > 0) handleSettingsChange('gameNightDays', updated);
                      }}
                      style={{
                        padding: '0.35rem 0.55rem', borderRadius: '6px', fontSize: '0.8rem',
                        fontWeight: isSelected ? 600 : 400,
                        background: isSelected ? 'var(--primary)' : 'transparent',
                        color: isSelected ? 'white' : 'var(--text-muted)',
                        border: `1px solid ${isSelected ? 'var(--primary)' : 'var(--border)'}`,
                        cursor: 'pointer', fontFamily: 'Outfit, sans-serif',
                      }}
                    >{label}</button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ===== AI STEP ===== */}
        {currentStep === 'ai' && (
          <div>
            <div style={{
              background: 'var(--surface)', borderRadius: '10px', padding: '0.75rem',
              border: '1px solid var(--border)', marginBottom: '0.75rem',
            }}>
              <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '0.4rem' }}>
                {t('wizard.geminiKeyLabel')}
              </label>
              <input
                type="password"
                value={geminiKey}
                onChange={e => setGeminiKey(e.target.value)}
                placeholder="AIza..."
                dir="ltr"
                style={{
                  width: '100%', padding: '0.55rem 0.75rem', borderRadius: '8px',
                  border: '1px solid var(--border)', background: 'var(--background)',
                  color: 'var(--text)', fontSize: '0.9rem', fontFamily: 'monospace',
                  boxSizing: 'border-box', marginBottom: '0.5rem',
                }}
              />
              {geminiKey.trim() && geminiKey !== (settings.geminiApiKey || '') && (
                <button
                  onClick={handleSaveAiKey}
                  style={{
                    width: '100%', padding: '0.5rem', borderRadius: '8px', border: 'none',
                    background: 'var(--primary)', color: 'white', cursor: 'pointer',
                    fontSize: '0.85rem', fontFamily: 'Outfit, sans-serif', fontWeight: 600,
                  }}
                >
                  {t('common.save')}
                </button>
              )}
              {settings.geminiApiKey && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '0.4rem',
                  padding: '0.4rem 0.6rem', borderRadius: '6px',
                  background: 'rgba(16,185,129,0.1)', marginTop: '0.5rem',
                }}>
                  <span style={{ color: '#10B981', fontSize: '0.85rem' }}>✓</span>
                  <span style={{ color: '#10B981', fontSize: '0.8rem' }}>{t('wizard.keyConfigured')}</span>
                </div>
              )}
            </div>

            <div style={{
              background: 'var(--surface)', borderRadius: '10px', padding: '0.75rem',
              border: '1px solid rgba(99,102,241,0.2)',
              borderInlineStart: '3px solid #6366f1',
            }}>
              <h3 style={{ margin: '0 0 0.4rem', fontSize: '0.85rem', color: '#a78bfa' }}>
                📖 {t('wizard.howToGetKey')}
              </h3>
              <ol style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: 0, paddingInlineStart: '1.2rem', lineHeight: 1.8 }}>
                <li>
                  <a
                    href="https://aistudio.google.com/apikey"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: '#818cf8', textDecoration: 'underline' }}
                  >
                    {t('wizard.keyStep1')}
                  </a>
                </li>
                <li>{t('wizard.keyStep2')}</li>
                <li>{t('wizard.keyStep3')}</li>
              </ol>
              <p style={{ fontSize: '0.68rem', color: 'var(--text-muted)', margin: '0.4rem 0 0', opacity: 0.7 }}>
                {t('wizard.keyFree')}
              </p>
            </div>
          </div>
        )}

        {/* ===== INVITES STEP ===== */}
        {currentStep === 'invites' && (
          <div>
            {otherPlayers.length > 0 ? (
              <div style={{
                background: 'var(--surface)', borderRadius: '10px', padding: '0.75rem',
                border: '1px solid var(--border)', marginBottom: '0.75rem',
              }}>
                <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '0.5rem' }}>
                  🎯 {t('wizard.personalInvitesLabel')}
                </label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  {otherPlayers.map(player => {
                    const invite = invites[player.id];
                    const isLoading = inviteLoading === player.id;
                    return (
                      <div key={player.id} style={{
                        padding: '0.6rem 0.7rem', borderRadius: '8px',
                        border: `1px solid ${invite ? 'rgba(16,185,129,0.3)' : 'var(--border)'}`,
                        background: invite ? 'rgba(16,185,129,0.05)' : 'var(--background)',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                          <span style={{ fontSize: '0.9rem', fontWeight: 500, color: 'var(--text)' }}>
                            {player.gender === 'female' ? '👩' : '👨'} {player.name}
                          </span>
                          {!invite ? (
                            <button
                              onClick={() => handleGenerateInvite(player)}
                              disabled={isLoading}
                              style={{
                                padding: '0.35rem 0.65rem', borderRadius: '6px', border: 'none',
                                background: isLoading ? 'rgba(100,100,100,0.3)' : 'var(--primary)',
                                color: 'white', cursor: isLoading ? 'default' : 'pointer',
                                fontSize: '0.78rem', fontFamily: 'Outfit, sans-serif', fontWeight: 600,
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {isLoading ? '...' : t('wizard.sendInvite')}
                            </button>
                          ) : (
                            <span style={{ fontSize: '0.75rem', color: '#10B981', fontWeight: 600 }}>
                              ✓ {t('wizard.inviteSent')}
                            </span>
                          )}
                        </div>

                        {invite && (
                          <div style={{ marginTop: '0.5rem' }}>
                            <div style={{
                              padding: '0.5rem', borderRadius: '6px', fontSize: '0.75rem',
                              background: 'var(--surface)', border: '1px solid var(--border)',
                              color: 'var(--text-muted)', lineHeight: 1.5, whiteSpace: 'pre-line',
                              marginBottom: '0.4rem', maxHeight: '6rem', overflowY: 'auto',
                            }}>
                              {invite.message}
                            </div>
                            <div style={{
                              textAlign: 'center', padding: '0.25rem', marginBottom: '0.4rem',
                              letterSpacing: '3px', fontSize: '1.1rem', fontWeight: 700,
                              fontFamily: 'monospace', color: 'var(--text)', direction: 'ltr',
                            }}>
                              {invite.code}
                            </div>
                            <div style={{ display: 'flex', gap: '0.4rem' }}>
                              <button
                                onClick={() => handleCopyInvite(player.id, invite.message)}
                                style={{
                                  flex: 1, padding: '0.4rem', borderRadius: '6px',
                                  border: '1px solid var(--border)', background: 'var(--surface)',
                                  color: 'var(--text)', cursor: 'pointer', fontSize: '0.78rem',
                                  fontFamily: 'Outfit, sans-serif', fontWeight: 500,
                                }}
                              >
                                {copiedId === player.id ? t('wizard.messageCopied') : t('wizard.copyMessage')}
                              </button>
                              {canShare && (
                                <button
                                  onClick={() => handleShareInvite(player.name, invite.message)}
                                  style={{
                                    flex: 1, padding: '0.4rem', borderRadius: '6px', border: 'none',
                                    background: '#25D366', color: 'white', cursor: 'pointer',
                                    fontSize: '0.78rem', fontFamily: 'Outfit, sans-serif', fontWeight: 600,
                                  }}
                                >
                                  {t('wizard.sendWhatsApp')}
                                </button>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {inviteError && (
                  <p style={{ color: '#ef4444', fontSize: '0.78rem', marginTop: '0.5rem' }}>{inviteError}</p>
                )}
              </div>
            ) : (
              <div style={{
                textAlign: 'center', padding: '1.5rem', borderRadius: '10px',
                border: '2px dashed var(--border)', color: 'var(--text-muted)',
                fontSize: '0.85rem', marginBottom: '0.75rem',
              }}>
                {t('wizard.noPlayersToInvite')}
              </div>
            )}

            {/* Generic group code */}
            {groupInviteCode && (
              <div style={{
                background: 'var(--surface)', borderRadius: '10px', padding: '0.75rem',
                border: '1px solid rgba(99,102,241,0.2)',
                borderInlineStart: '3px solid #6366f1',
              }}>
                <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '0.4rem' }}>
                  🔗 {t('wizard.genericCodeTitle')}
                </label>
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  gap: '0.75rem', marginBottom: '0.4rem',
                }}>
                  <span style={{
                    letterSpacing: '4px', fontSize: '1.4rem', fontWeight: 700,
                    fontFamily: 'monospace', color: 'var(--text)', direction: 'ltr',
                  }}>
                    {groupInviteCode}
                  </span>
                  <button
                    onClick={handleCopyGroupCode}
                    style={{
                      padding: '0.3rem 0.6rem', borderRadius: '6px',
                      border: '1px solid var(--border)', background: 'var(--surface)',
                      color: 'var(--text)', cursor: 'pointer', fontSize: '0.75rem',
                      fontFamily: 'Outfit, sans-serif',
                    }}
                  >
                    {codeCopied ? t('wizard.messageCopied') : t('wizard.copyMessage')}
                  </button>
                </div>
                <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', margin: 0, textAlign: 'center' }}>
                  {t('wizard.genericCodeHint')}
                </p>
              </div>
            )}
          </div>
        )}

        {/* ===== DONE STEP ===== */}
        {currentStep === 'done' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {/* Summary card */}
            <div style={{
              background: 'linear-gradient(135deg, rgba(16,185,129,0.06) 0%, rgba(99,102,241,0.06) 100%)',
              borderRadius: '14px', border: '1px solid rgba(16,185,129,0.15)',
              overflow: 'hidden',
            }}>
              {/* Header */}
              {groupName && (
                <div style={{
                  padding: '0.75rem 1rem', textAlign: 'center',
                }}>
                  <div style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text)', letterSpacing: '0.02em' }}>{groupName}</div>
                </div>
              )}

              {/* Info grid */}
              <div style={{ padding: '0 0.85rem 0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {[
                  { icon: '👥', label: t('common.players'), values: players.map(p => p.name), show: true },
                  { icon: '📍', label: t('wizard.locationsLabel'), values: settings.locations ?? [], show: (settings.locations ?? []).length > 0 },
                  { icon: '🤖', label: 'AI', values: ['✓'], show: !!settings.geminiApiKey },
                ].filter(r => r.show).map(row => (
                  <div key={row.icon} style={{
                    background: 'var(--surface)', borderRadius: '10px', padding: '0.55rem 0.7rem',
                    border: '1px solid var(--border)',
                  }}>
                    <div style={{
                      fontSize: '0.65rem', color: 'var(--text-muted)', fontWeight: 600,
                      textTransform: 'uppercase', letterSpacing: '0.05em',
                      marginBottom: '0.3rem',
                    }}>
                      {row.icon} {row.label}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}>
                      {row.values.map((v, i) => (
                        <span key={i} style={{
                          padding: '0.15rem 0.5rem', borderRadius: '6px', fontSize: '0.75rem',
                          background: 'rgba(16,185,129,0.08)', color: 'var(--text)', fontWeight: 500,
                        }}>
                          {v}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              {/* Hint */}
              <div style={{
                padding: '0.55rem 0.85rem',
                borderTop: '1px solid rgba(16,185,129,0.1)',
                background: 'rgba(99,102,241,0.04)',
                fontSize: '0.68rem', color: 'var(--text-muted)', lineHeight: 1.5,
                textAlign: 'center',
              }}>
                📢 {isRTL
                  ? 'בקשו מהשחקנים להירשם עם הקוד שלהם כדי שיוכלו לראות סטטיסטיקות, אימונים ותחזיות אישיות.'
                  : 'Ask players to register with their code so they can see personal stats, training, and forecasts.'}
              </div>
            </div>

            <div style={{
              background: 'var(--surface)', borderRadius: '10px', padding: '0.65rem 0.75rem',
              border: '1px solid var(--border)', textAlign: 'start',
            }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '0.45rem' }}>
                📲 {isRTL ? 'שתפו בקבוצת הוואטסאפ:' : 'Share with your WhatsApp group:'}
              </div>
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                <button
                  onClick={() => setShowWelcomeModal(true)}
                  style={{
                    flex: 1, padding: '0.5rem 0.4rem', borderRadius: '8px',
                    border: '1px solid var(--border)', background: 'var(--surface)',
                    color: 'var(--text)', cursor: 'pointer',
                    fontSize: '0.7rem', fontWeight: 600, fontFamily: 'Outfit, sans-serif',
                  }}
                >
                  📖 {isRTL ? 'מה אפשר לעשות' : 'Features'}
                </button>
                <button
                  onClick={() => setShowGameFlowModal(true)}
                  style={{
                    flex: 1, padding: '0.5rem 0.4rem', borderRadius: '8px',
                    border: '1px solid var(--border)', background: 'var(--surface)',
                    color: 'var(--text)', cursor: 'pointer',
                    fontSize: '0.7rem', fontWeight: 600, fontFamily: 'Outfit, sans-serif',
                  }}
                >
                  🎮 {isRTL ? 'איך מנהלים משחק' : 'Game Flow'}
                </button>
              </div>
            </div>

            <button
              onClick={() => onComplete()}
              style={{
                width: '100%', padding: '0.75rem', borderRadius: '10px', border: 'none',
                background: '#10B981', color: 'white', cursor: 'pointer',
                fontSize: '0.85rem', fontWeight: 600, fontFamily: 'Outfit, sans-serif',
              }}
            >
              {t('wizard.finish')}
            </button>

            <button
              onClick={() => setCurrentStep('invites')}
              style={{
                display: 'block', width: '100%', marginTop: '0.25rem',
                background: 'none', border: 'none', color: 'var(--text-muted)',
                cursor: 'pointer', fontSize: '0.78rem', fontFamily: 'Outfit, sans-serif',
                textAlign: 'center',
              }}
            >
              {t('common.back')}
            </button>
          </div>
        )}
        </div>
      </div>

      {/* Footer — hidden on done step */}
      {currentStep !== 'done' && <div style={{
        paddingTop: '0.65rem',
        paddingLeft: 'max(0.75rem, env(safe-area-inset-left))',
        paddingRight: 'max(0.75rem, env(safe-area-inset-right))',
        paddingBottom: 'max(0.65rem, env(safe-area-inset-bottom))',
        borderTop: '1px solid var(--border)',
        background: 'var(--surface)',
        flexShrink: 0,
      }}>
        <div style={{ maxWidth: '26rem', margin: '0 auto', width: '100%', display: 'flex', gap: '0.5rem', boxSizing: 'border-box' }}>
        {currentIdx > 0 && (
          <button
            onClick={() => setCurrentStep(STEPS[currentIdx - 1])}
            style={{
              padding: '0.65rem 1rem', borderRadius: '10px',
              border: '1px solid var(--border)', background: 'transparent',
              color: 'var(--text)', cursor: 'pointer', fontSize: '0.9rem',
              fontFamily: 'Outfit, sans-serif',
            }}
          >
            {t('common.back')}
          </button>
        )}
        <button
          onClick={goNext}
          disabled={needsSelfCreate && currentStep === 'players'}
          style={{
            flex: 1, padding: '0.65rem', borderRadius: '10px', border: 'none',
            background: (needsSelfCreate && currentStep === 'players') ? 'rgba(100,100,100,0.3)' : 'var(--primary)',
            color: 'white', cursor: (needsSelfCreate && currentStep === 'players') ? 'default' : 'pointer',
            fontSize: '0.95rem', fontWeight: 600, fontFamily: 'Outfit, sans-serif',
          }}
        >
          {currentIdx === 0 ? t('wizard.letsGo') : t('wizard.next')}
        </button>
        </div>
      </div>}
      {/* Welcome / Features Modal — same as SettingsScreen */}
      {showWelcomeModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.6)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem',
        }} onClick={() => setShowWelcomeModal(false)}>
          <div style={{
            background: 'var(--surface)', borderRadius: '16px', padding: '1.5rem',
            maxWidth: '400px', width: '100%', maxHeight: '85vh', overflowY: 'auto',
            border: '1px solid var(--border)',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ textAlign: 'center', marginBottom: '1rem' }}>
              <div style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--text)' }}>{t('settings.setup.welcomeTitle')}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.3rem' }}>{t('settings.setup.welcomeSubtitle')}</div>
            </div>
            {[
              { icon: '📅', text: t('settings.setup.welcomeSchedule') },
              { icon: '🎮', text: t('settings.setup.welcomeNewGame') },
              { icon: '📡', text: t('settings.setup.welcomeLive') },
              { icon: '🧮', text: t('settings.setup.welcomeEnd') },
              { icon: '💰', text: t('settings.setup.welcomeSettlements') },
              { icon: '📜', text: t('settings.setup.welcomeHistory') },
              { icon: '📊', text: t('settings.setup.welcomeStats') },
              { icon: '📈', text: t('settings.setup.welcomeGraphs') },
              { icon: '🏋️', text: t('settings.setup.welcomeTraining') },
              { icon: '📤', text: t('settings.setup.welcomeShare') },
              { icon: '🔔', text: t('settings.setup.welcomeNotify') },
            ].map((item, i, arr) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'flex-start', gap: '0.6rem',
                padding: '0.5rem 0', borderBottom: i < arr.length - 1 ? '1px solid var(--border)' : 'none',
              }}>
                <span style={{ fontSize: '1.1rem', flexShrink: 0 }}>{item.icon}</span>
                <span style={{ fontSize: '0.78rem', color: 'var(--text)', lineHeight: 1.5 }}>{item.text}</span>
              </div>
            ))}
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
              <button
                onClick={() => {
                  const items = [
                    { icon: '📅', key: 'settings.setup.welcomeSchedule' },
                    { icon: '🎮', key: 'settings.setup.welcomeNewGame' },
                    { icon: '📡', key: 'settings.setup.welcomeLive' },
                    { icon: '🧮', key: 'settings.setup.welcomeEnd' },
                    { icon: '💰', key: 'settings.setup.welcomeSettlements' },
                    { icon: '📜', key: 'settings.setup.welcomeHistory' },
                    { icon: '📊', key: 'settings.setup.welcomeStats' },
                    { icon: '📈', key: 'settings.setup.welcomeGraphs' },
                    { icon: '🏋️', key: 'settings.setup.welcomeTraining' },
                    { icon: '📤', key: 'settings.setup.welcomeShare' },
                    { icon: '🔔', key: 'settings.setup.welcomeNotify' },
                  ] as const;
                  const lines = items.map(i => `${i.icon} ${t(i.key)}`).join('\n');
                  shareToWhatsApp(`${t('settings.setup.welcomeTitle')}\n${t('settings.setup.welcomeSubtitle')}\n\n${lines}`);
                }}
                style={{
                  flex: 1, padding: '0.7rem', borderRadius: '10px',
                  border: '1px solid rgba(37,211,102,0.3)', background: 'rgba(37,211,102,0.1)',
                  color: '#25D366', cursor: 'pointer',
                  fontSize: '0.8rem', fontWeight: 700, fontFamily: 'Outfit, sans-serif',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem',
                }}
              >
                <span style={{ fontSize: '1rem' }}>📲</span> WhatsApp
              </button>
              <button
                onClick={() => setShowWelcomeModal(false)}
                style={{
                  flex: 1, padding: '0.7rem', borderRadius: '10px',
                  border: 'none', background: '#10B981', color: '#fff', cursor: 'pointer',
                  fontSize: '0.9rem', fontWeight: 700, fontFamily: 'Outfit, sans-serif',
                }}
              >{t('settings.setup.welcomeClose')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Game Flow Modal — same as SettingsScreen */}
      {showGameFlowModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.6)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem',
        }} onClick={() => setShowGameFlowModal(false)}>
          <div style={{
            background: 'var(--surface)', borderRadius: '14px', padding: '1rem 1rem 0.75rem',
            maxWidth: '400px', width: '100%',
            border: '1px solid var(--border)',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ textAlign: 'center', marginBottom: '0.6rem' }}>
              <div style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text)' }}>🎮 {t('settings.setup.gameFlowTitle')}</div>
              <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>{t('settings.setup.gameFlowSubtitle')}</div>
            </div>
            {[
              { step: 1, icon: '📅', color: '#0ea5e9', title: t('settings.setup.gameFlowScheduleTitle'), desc: t('settings.setup.gameFlowScheduleDesc') },
              { step: 2, icon: '🃏', color: '#6366f1', title: t('settings.setup.gameFlowStep1Title'), desc: t('settings.setup.gameFlowStep1Desc') },
              { step: 3, icon: '📡', color: '#f59e0b', title: t('settings.setup.gameFlowStep2Title'), desc: t('settings.setup.gameFlowStep2Desc') },
              { step: 4, icon: '🧮', color: '#ef4444', title: t('settings.setup.gameFlowStep3Title'), desc: t('settings.setup.gameFlowStep3Desc') },
              { step: 5, icon: '🏆', color: '#10B981', title: t('settings.setup.gameFlowStep4Title'), desc: t('settings.setup.gameFlowStep4Desc') },
              { step: 6, icon: '📊', color: '#a78bfa', title: t('settings.setup.gameFlowStep5Title'), desc: t('settings.setup.gameFlowStep5Desc') },
            ].map((s, i, arr) => (
              <div key={s.step}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: '0.5rem',
                  padding: '0.4rem 0.45rem', borderRadius: '8px',
                  background: `${s.color}10`, border: `1px solid ${s.color}25`,
                }}>
                  <div style={{
                    width: '26px', height: '26px', borderRadius: '50%',
                    background: `${s.color}20`, border: `2px solid ${s.color}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '0.7rem', fontWeight: 800, color: s.color, flexShrink: 0,
                  }}>
                    {s.step}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
                      <span style={{ fontSize: '0.8rem' }}>{s.icon}</span>
                      <span style={{ fontSize: '0.78rem', fontWeight: 700, color: s.color }}>{s.title}</span>
                    </div>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>{s.desc}</div>
                  </div>
                </div>
                {i < arr.length - 1 && (
                  <div style={{ display: 'flex', justifyContent: 'center', padding: '0.1rem 0' }}>
                    <div style={{ width: '2px', height: '10px', background: 'var(--border)', borderRadius: '1px' }} />
                  </div>
                )}
              </div>
            ))}
            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
              <button
                onClick={() => {
                  const steps = [
                    { step: 1, icon: '📅', titleKey: 'settings.setup.gameFlowScheduleTitle', descKey: 'settings.setup.gameFlowScheduleDesc' },
                    { step: 2, icon: '🃏', titleKey: 'settings.setup.gameFlowStep1Title', descKey: 'settings.setup.gameFlowStep1Desc' },
                    { step: 3, icon: '📡', titleKey: 'settings.setup.gameFlowStep2Title', descKey: 'settings.setup.gameFlowStep2Desc' },
                    { step: 4, icon: '🧮', titleKey: 'settings.setup.gameFlowStep3Title', descKey: 'settings.setup.gameFlowStep3Desc' },
                    { step: 5, icon: '🏆', titleKey: 'settings.setup.gameFlowStep4Title', descKey: 'settings.setup.gameFlowStep4Desc' },
                    { step: 6, icon: '📊', titleKey: 'settings.setup.gameFlowStep5Title', descKey: 'settings.setup.gameFlowStep5Desc' },
                  ] as const;
                  const lines = steps.map(s => `${s.icon} ${s.step}. ${t(s.titleKey)}\n   ${t(s.descKey)}`).join('\n\n');
                  shareToWhatsApp(`🎮 ${t('settings.setup.gameFlowTitle')}\n${t('settings.setup.gameFlowSubtitle')}\n\n${lines}`);
                }}
                style={{
                  flex: 1, padding: '0.5rem', borderRadius: '8px',
                  border: '1px solid rgba(37,211,102,0.3)', background: 'rgba(37,211,102,0.1)',
                  color: '#25D366', cursor: 'pointer',
                  fontSize: '0.75rem', fontWeight: 700, fontFamily: 'Outfit, sans-serif',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem',
                }}
              >
                <span style={{ fontSize: '1rem' }}>📲</span> WhatsApp
              </button>
              <button
                onClick={() => setShowGameFlowModal(false)}
                style={{
                  flex: 1, padding: '0.5rem', borderRadius: '8px',
                  border: 'none', background: '#10B981', color: '#fff', cursor: 'pointer',
                  fontSize: '0.85rem', fontWeight: 700, fontFamily: 'Outfit, sans-serif',
                }}
              >{t('common.close')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
