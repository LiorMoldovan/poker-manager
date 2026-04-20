import { useState, useEffect } from 'react';
import { useTranslation } from '../i18n';
import {
  getAllPlayers, addPlayer, getSettings, saveSettings, getChipValues,
} from '../database/storage';
import type { Player, PlayerGender, Settings, ChipValue } from '../types';

interface GroupWizardProps {
  ownerPlayerName: string;
  onComplete: () => void;
  createPlayerInvite: (playerId: string) => Promise<{
    data: { invite_code: string; player_name: string; already_existed: boolean } | null;
    error: unknown;
  }>;
  groupInviteCode: string | null;
}

type WizardStep = 'players' | 'game' | 'ai' | 'invites';
const STEPS: WizardStep[] = ['players', 'game', 'ai', 'invites'];

interface PlayerInviteState {
  code: string;
  message: string;
}

export default function GroupWizard({ ownerPlayerName, onComplete, createPlayerInvite, groupInviteCode }: GroupWizardProps) {
  const { t, isRTL } = useTranslation();
  const [currentStep, setCurrentStep] = useState<WizardStep>('players');
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

  useEffect(() => {
    setPlayers(getAllPlayers());
    const s = getSettings();
    setSettings(s);
    setChipValues(getChipValues());
    setGeminiKey(s.geminiApiKey || '');
  }, []);

  const currentIdx = STEPS.indexOf(currentStep);

  const goNext = () => {
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
    if (data) {
      const msg = [
        `🃏 ${data.player_name}, הוזמנת לקבוצת הפוקר שלנו!`,
        ``,
        `📱 היכנס לאפליקציה:`,
        appUrl,
        ``,
        `🔑 קוד ההצטרפות האישי שלך:`,
        data.invite_code,
        ``,
        `המקום שלך שמור — פשוט היכנס עם הקוד הזה ותהיה מוכן למשחק הבא! 🎯`,
      ].join('\n');
      setInvites(prev => ({ ...prev, [player.id]: { code: data.invite_code, message: msg } }));
    }
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
    players: { icon: '👥', title: t('wizard.playersTitle'), desc: t('wizard.playersDesc') },
    game: { icon: '🎮', title: t('wizard.gameTitle'), desc: t('wizard.gameDesc') },
    ai: { icon: '🤖', title: t('wizard.aiTitle'), desc: t('wizard.aiDesc') },
    invites: { icon: '📨', title: t('wizard.invitesTitle'), desc: t('wizard.invitesDesc') },
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
        padding: '1rem 1.25rem 0.75rem',
        borderBottom: '1px solid var(--border)',
        background: 'var(--surface)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
          <span style={{ fontSize: '0.85rem', fontWeight: 700, color: '#a78bfa' }}>
            {t('wizard.title')}
          </span>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            {currentIdx + 1}/{STEPS.length}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '0.35rem' }}>
          {STEPS.map((_, i) => (
            <div key={i} style={{
              flex: 1, height: '4px', borderRadius: '2px',
              background: i <= currentIdx ? '#10B981' : 'rgba(100,100,100,0.3)',
              transition: 'background 0.3s ease',
            }} />
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={{
        flex: 1, overflowY: 'auto', padding: '1rem 1.25rem',
      }}>
        <div style={{ textAlign: 'center', marginBottom: '1rem' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '0.25rem' }}>{info.icon}</div>
          <h2 style={{ color: 'var(--text)', fontSize: '1.15rem', margin: '0 0 0.25rem' }}>{info.title}</h2>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', margin: 0 }}>{info.desc}</p>
        </div>

        {/* ===== PLAYERS STEP ===== */}
        {currentStep === 'players' && (
          <div>
            <div style={{
              display: 'flex', gap: '0.4rem', marginBottom: '0.75rem',
            }}>
              <input
                type="text"
                value={newName}
                onChange={e => { setNewName(e.target.value); setError(''); }}
                placeholder={t('wizard.playerPlaceholder')}
                onKeyDown={e => e.key === 'Enter' && handleAddPlayer()}
                style={{
                  flex: 1, padding: '0.6rem 0.75rem', borderRadius: '8px',
                  border: '1px solid var(--border)', background: 'var(--surface)',
                  color: 'var(--text)', fontSize: '0.9rem', fontFamily: 'Outfit, sans-serif',
                }}
              />
              <select
                value={newGender}
                onChange={e => setNewGender(e.target.value as PlayerGender)}
                style={{
                  padding: '0.5rem', borderRadius: '8px',
                  border: '1px solid var(--border)', background: 'var(--surface)',
                  color: 'var(--text)', fontSize: '0.8rem', fontFamily: 'Outfit, sans-serif', cursor: 'pointer',
                }}
              >
                <option value="male" style={{ background: '#1a1a2e', color: '#e2e8f0' }}>{t('wizard.male')}</option>
                <option value="female" style={{ background: '#1a1a2e', color: '#e2e8f0' }}>{t('wizard.female')}</option>
              </select>
              <button
                onClick={handleAddPlayer}
                disabled={!newName.trim()}
                style={{
                  padding: '0.5rem 0.85rem', borderRadius: '8px', border: 'none',
                  background: newName.trim() ? 'var(--primary)' : 'rgba(100,100,100,0.3)',
                  color: 'white', cursor: newName.trim() ? 'pointer' : 'default',
                  fontSize: '0.85rem', fontFamily: 'Outfit, sans-serif', fontWeight: 600,
                }}
              >
                +
              </button>
            </div>
            {error && <p style={{ color: '#ef4444', fontSize: '0.8rem', marginBottom: '0.5rem' }}>{error}</p>}

            {otherPlayers.length === 0 ? (
              <div style={{
                textAlign: 'center', padding: '1.5rem', borderRadius: '10px',
                border: '2px dashed var(--border)', color: 'var(--text-muted)', fontSize: '0.85rem',
              }}>
                {t('wizard.noPlayersYet')}
              </div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
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

            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.75rem', textAlign: 'center' }}>
              {t('wizard.playersHint', { name: ownerPlayerName })}
            </p>
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
                  <input
                    type="number"
                    value={settings.rebuyValue}
                    onChange={e => handleSettingsChange('rebuyValue', parseInt(e.target.value) || 0)}
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
                  <input
                    type="number"
                    value={settings.chipsPerRebuy}
                    onChange={e => handleSettingsChange('chipsPerRebuy', parseInt(e.target.value) || 0)}
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

            {/* Chip values summary */}
            <div style={{
              background: 'var(--surface)', borderRadius: '10px', padding: '0.75rem',
              border: '1px solid var(--border)', marginBottom: '0.75rem',
            }}>
              <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '0.4rem' }}>
                {t('wizard.chipValues')}
              </label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                {chipValues.map(cv => (
                  <span key={cv.id} style={{
                    display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                    padding: '0.25rem 0.5rem', borderRadius: '6px',
                    border: '1px solid var(--border)', fontSize: '0.78rem',
                  }}>
                    <span style={{
                      width: 10, height: 10, borderRadius: '50%',
                      background: cv.displayColor, border: cv.displayColor === '#FFFFFF' ? '1px solid #888' : 'none',
                      display: 'inline-block',
                    }} />
                    {cv.value.toLocaleString()}
                  </span>
                ))}
              </div>
              <p style={{ fontSize: '0.65rem', color: 'var(--text-muted)', margin: '0.3rem 0 0' }}>
                {t('wizard.chipValuesHint')}
              </p>
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
                <li>{t('wizard.keyStep1')}</li>
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
      </div>

      {/* Footer */}
      <div style={{
        padding: '0.75rem 1.25rem', borderTop: '1px solid var(--border)',
        background: 'var(--surface)', display: 'flex', gap: '0.5rem',
      }}>
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
          style={{
            flex: 1, padding: '0.65rem', borderRadius: '10px', border: 'none',
            background: 'var(--primary)', color: 'white', cursor: 'pointer',
            fontSize: '0.95rem', fontWeight: 600, fontFamily: 'Outfit, sans-serif',
          }}
        >
          {currentIdx === STEPS.length - 1 ? t('wizard.finish') : t('wizard.next')}
        </button>
      </div>
    </div>
  );
}
