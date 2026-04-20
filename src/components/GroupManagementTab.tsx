import { useState, useEffect, useCallback } from 'react';
import { getAllPlayers } from '../database/storage';
import { useTranslation } from '../i18n';
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh';
import type { GroupMember } from '../hooks/useSupabaseAuth';

interface GroupManagementTabProps {
  groupName: string;
  inviteCode: string | null;
  isOwner: boolean;
  isAdmin: boolean;
  currentUserId: string;
  fetchMembers: () => Promise<GroupMember[]>;
  updateMemberRole: (userId: string, role: string) => Promise<{ error: unknown }>;
  removeMember: (userId: string) => Promise<{ error: unknown }>;
  transferOwnership: (userId: string) => Promise<{ error: unknown }>;
  regenerateInviteCode: () => Promise<{ data: string | null; error: unknown }>;
  createPlayerInvite: (playerId: string) => Promise<{ data: { invite_code: string; player_name: string; already_existed: boolean } | null; error: unknown }>;
  addMemberByEmail: (email: string, playerId?: string) => Promise<{ data: { user_id: string; display_name: string; player_id: string | null } | null; error: unknown }>;
  appUrl: string;
}

export default function GroupManagementTab({
  groupName,
  inviteCode: initialInviteCode,
  isOwner,
  isAdmin,
  currentUserId,
  fetchMembers,
  updateMemberRole,
  removeMember,
  transferOwnership,
  regenerateInviteCode,
  createPlayerInvite,
  addMemberByEmail,
  appUrl,
}: GroupManagementTabProps) {
  const { t, isRTL } = useTranslation();
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteCode, setInviteCode] = useState(initialInviteCode);
  const [copied, setCopied] = useState(false);
  const [actionMsg, setActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    type: 'remove' | 'transfer' | 'regenerate';
    userId?: string;
    name?: string;
  } | null>(null);
  const [personalInvite, setPersonalInvite] = useState<{
    playerName: string;
    code: string;
    message: string;
  } | null>(null);
  const [addEmail, setAddEmail] = useState('');
  const [addEmailPlayer, setAddEmailPlayer] = useState('');
  const [addEmailLoading, setAddEmailLoading] = useState(false);

  const loadMembers = useCallback(async () => {
    setLoading(true);
    const data = await fetchMembers();
    setMembers(data);
    setLoading(false);
  }, [fetchMembers]);

  useEffect(() => { loadMembers(); }, [loadMembers]);
  useRealtimeRefresh(loadMembers);

  const showMsg = (type: 'success' | 'error', text: string) => {
    setActionMsg({ type, text });
    setTimeout(() => setActionMsg(null), 3000);
  };

  const handleRoleChange = async (userId: string, newRole: string) => {
    const { error } = await updateMemberRole(userId, newRole);
    if (error) {
      showMsg('error', (error as { message?: string })?.message || t('groupMgmt.errorChangeRole'));
    } else {
      showMsg('success', t('groupMgmt.roleUpdated'));
      loadMembers();
    }
  };

  const handleRemove = async (userId: string) => {
    const { error } = await removeMember(userId);
    setConfirmAction(null);
    if (error) {
      showMsg('error', (error as { message?: string })?.message || t('groupMgmt.errorRemove'));
    } else {
      showMsg('success', t('groupMgmt.memberRemoved'));
      loadMembers();
    }
  };

  const handleTransfer = async (userId: string) => {
    const { error } = await transferOwnership(userId);
    setConfirmAction(null);
    if (error) {
      showMsg('error', (error as { message?: string })?.message || t('groupMgmt.errorTransfer'));
    } else {
      showMsg('success', t('groupMgmt.transferred'));
      loadMembers();
    }
  };

  const handleRegenerate = async () => {
    const { data, error } = await regenerateInviteCode();
    setConfirmAction(null);
    if (error) {
      showMsg('error', (error as { message?: string })?.message || t('groupMgmt.errorRegen'));
    } else if (data) {
      setInviteCode(data);
      showMsg('success', t('groupMgmt.regenSuccess'));
    }
  };

  const handleCreateInvite = async (playerId: string) => {
    const { data, error } = await createPlayerInvite(playerId);
    if (error) {
      showMsg('error', (error as { message?: string })?.message || t('groupMgmt.errorInvite'));
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
      setPersonalInvite({ playerName: data.player_name, code: data.invite_code, message: msg });
    }
  };

  const handleAddByEmail = async () => {
    const email = addEmail.trim();
    if (!email) { showMsg('error', t('groupMgmt.emptyEmail')); return; }
    setAddEmailLoading(true);
    const { error } = await addMemberByEmail(email, addEmailPlayer || undefined);
    setAddEmailLoading(false);
    if (error) {
      const msg = (error as { message?: string })?.message || '';
      if (msg.includes('No registered user')) showMsg('error', t('groupMgmt.noUser'));
      else if (msg.includes('already a member')) showMsg('error', t('groupMgmt.alreadyMember'));
      else showMsg('error', msg || t('groupMgmt.addError'));
    } else {
      showMsg('success', t('groupMgmt.memberAdded'));
      setAddEmail('');
      setAddEmailPlayer('');
      loadMembers();
    }
  };

  const linkedPlayerIds = new Set(members.map(m => m.playerId).filter(Boolean));
  const typeOrder: Record<string, number> = { permanent: 0, permanent_guest: 1, guest: 2 };
  const unlinkedPlayers = getAllPlayers()
    .filter(p => !linkedPlayerIds.has(p.id))
    .sort((a, b) => (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9));

  const roleLabel = (role: string) => {
    switch (role) {
      case 'admin': return t('groupMgmt.roleAdminBadge');
      case 'member': return t('groupMgmt.roleMemberBadge');
      default: return role;
    }
  };

  return (
    <div>
      {/* Action feedback */}
      {actionMsg && (
        <div style={{
          padding: '0.6rem 1rem', borderRadius: '8px', marginBottom: '1rem', fontSize: '0.85rem', fontWeight: 500,
          background: actionMsg.type === 'success' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)',
          color: actionMsg.type === 'success' ? '#10B981' : '#EF4444',
          border: `1px solid ${actionMsg.type === 'success' ? 'rgba(16,185,129,0.3)' : 'rgba(239,68,68,0.3)'}`,
          textAlign: isRTL ? 'right' : 'left',
        }}>
          {actionMsg.text}
        </div>
      )}

      {/* Group Info */}
      <div className="card" style={{ padding: '1rem', marginBottom: '0.75rem' }}>
        <h2 className="card-title" style={{ margin: '0 0 0.75rem 0' }}>{t('groupMgmt.details')}</h2>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{t('groupMgmt.name')}</span>
          <span style={{ fontSize: '0.95rem', fontWeight: 600 }}>{groupName}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{t('groupMgmt.memberCount')}</span>
          <span style={{ fontSize: '0.95rem', fontWeight: 600 }}>{members.length}</span>
        </div>
      </div>

      {/* Member List */}
      <div className="card" style={{ padding: '1rem', marginBottom: '0.75rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <h2 className="card-title" style={{ margin: 0 }}>{t('groupMgmt.members')}</h2>
          <span style={{
            fontSize: '0.7rem', color: 'var(--text-muted)', background: 'var(--surface-light)',
            padding: '0.2rem 0.6rem', borderRadius: '10px', fontWeight: 600,
          }}>
            {members.length}
          </span>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '1.5rem 0' }}>
            <div style={{ fontSize: '1.5rem', animation: 'pulse 1.5s ease-in-out infinite', marginBottom: '0.5rem' }}>👥</div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{t('common.loading')}</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            {members.map((m, idx) => {
              const isMe = m.userId === currentUserId;
              const isMemberOwner = members.length > 0 && isOwner && isMe;
              const displayName = m.playerName || m.displayName || t('groupMgmt.noName');
              const initials = displayName.slice(0, 2);

              const avatarColors = [
                ['#10B981', 'rgba(16,185,129,0.15)'],
                ['#6366F1', 'rgba(99,102,241,0.15)'],
                ['#EC4899', 'rgba(236,72,153,0.15)'],
                ['#F59E0B', 'rgba(245,158,11,0.15)'],
                ['#8B5CF6', 'rgba(139,92,246,0.15)'],
                ['#14B8A6', 'rgba(20,184,166,0.15)'],
                ['#F97316', 'rgba(249,115,22,0.15)'],
                ['#06B6D4', 'rgba(6,182,212,0.15)'],
              ];
              const [avatarColor, avatarBg] = avatarColors[idx % avatarColors.length];

              return (
                <div key={m.userId} style={{
                  padding: '0.65rem 0.75rem', borderRadius: '10px',
                  background: isMe ? 'rgba(16,185,129,0.05)' : 'var(--background)',
                  border: isMe ? '1px solid rgba(16,185,129,0.2)' : '1px solid var(--border)',
                  transition: 'all 0.2s ease',
                  animation: `contentFadeIn 0.3s ease-out ${idx * 0.04}s both`,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                    {/* Avatar */}
                    <div style={{
                      width: 34, height: 34, borderRadius: '50%',
                      background: avatarBg, color: avatarColor,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '0.75rem', fontWeight: 700, flexShrink: 0,
                      border: `1.5px solid ${avatarColor}30`,
                    }}>
                      {initials}
                    </div>

                    {/* Info */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600, fontSize: '0.88rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {displayName}
                        </span>
                        {isMe && (
                          <span style={{
                            fontSize: '0.6rem', background: 'rgba(16,185,129,0.15)', color: '#10B981',
                            padding: '0.1rem 0.35rem', borderRadius: '4px', fontWeight: 600,
                          }}>
                            {t('groupMgmt.you')}
                          </span>
                        )}
                        {isMemberOwner && (
                          <span style={{
                            fontSize: '0.6rem', background: 'rgba(234,179,8,0.15)', color: '#EAB308',
                            padding: '0.1rem 0.35rem', borderRadius: '4px', fontWeight: 600,
                          }}>
                            {t('groupMgmt.owner')}
                          </span>
                        )}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.15rem' }}>
                        {m.email && (
                          <span style={{
                            fontSize: '0.68rem', color: 'var(--text-muted)', direction: 'ltr',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '150px',
                          }}>
                            {m.email}
                          </span>
                        )}
                        {m.email && <span style={{ fontSize: '0.5rem', color: 'var(--border)' }}>•</span>}
                        <span style={{
                          fontSize: '0.68rem', whiteSpace: 'nowrap', fontWeight: 500,
                          color: m.role === 'admin' ? '#A855F7' : 'var(--text-muted)',
                        }}>
                          {roleLabel(m.role)}
                        </span>
                      </div>
                      {!m.playerName && m.playerId === null && (
                        <div style={{
                          fontSize: '0.68rem', color: '#F59E0B', marginTop: '0.2rem',
                          display: 'flex', alignItems: 'center', gap: '0.3rem',
                        }}>
                          <span style={{ fontSize: '0.6rem' }}>⚠</span> {t('groupMgmt.notLinked')}
                        </div>
                      )}
                    </div>

                    {/* Inline actions */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', flexShrink: 0 }}>
                      {isAdmin && !isMe && (isOwner || m.role !== 'admin') && (
                        <select
                          value={m.role}
                          onChange={e => handleRoleChange(m.userId, e.target.value)}
                          style={{
                            padding: '0.25rem 0.35rem', borderRadius: '6px', border: '1px solid var(--border)',
                            background: '#1a1a2e', color: 'var(--text)', fontSize: '0.7rem',
                            fontFamily: 'Outfit, sans-serif', cursor: 'pointer',
                          }}
                        >
                          <option value="admin" style={{ background: '#1a1a2e', color: '#ffffff' }}>{t('groupMgmt.roleAdmin')}</option>
                          <option value="member" style={{ background: '#1a1a2e', color: '#ffffff' }}>{t('groupMgmt.roleMember')}</option>
                        </select>
                      )}
                      {isAdmin && !isMe && (isOwner || m.role !== 'admin') && (
                        <button
                          onClick={() => setConfirmAction({ type: 'remove', userId: m.userId, name: m.playerName || m.displayName || '' })}
                          style={{
                            width: 28, height: 28, borderRadius: '6px',
                            border: '1px solid rgba(239,68,68,0.2)', background: 'rgba(239,68,68,0.06)',
                            color: '#EF4444', cursor: 'pointer', display: 'flex',
                            alignItems: 'center', justifyContent: 'center', fontSize: '0.8rem',
                            transition: 'all 0.15s ease', flexShrink: 0,
                          }}
                          title={t('groupMgmt.removeMember')}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Owner transfer dropdown */}
                  {isMemberOwner && members.filter(x => x.userId !== currentUserId).length > 0 && (
                    <div style={{ marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px solid var(--border)' }}>
                      <select
                        value=""
                        onChange={e => {
                          const target = members.find(x => x.userId === e.target.value);
                          if (target) {
                            setConfirmAction({ type: 'transfer', userId: target.userId, name: target.playerName || target.displayName || '' });
                          }
                        }}
                        style={{
                          padding: '0.3rem 0.5rem', borderRadius: '6px',
                          border: '1px solid rgba(168,85,247,0.3)', background: '#1a1a2e',
                          color: '#A855F7', fontSize: '0.72rem', fontFamily: 'Outfit, sans-serif',
                          cursor: 'pointer',
                        }}
                      >
                        <option value="" style={{ background: '#1a1a2e', color: '#A855F7' }}>
                          👑 {t('groupMgmt.transferOwnership')}
                        </option>
                        {members.filter(x => x.userId !== currentUserId).map(x => (
                          <option key={x.userId} value={x.userId} style={{ background: '#1a1a2e', color: '#ffffff' }}>
                            {x.playerName || x.displayName || x.email || '?'}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Invite Code — visible to admins */}
      {isAdmin && inviteCode && (
        <div className="card" style={{ padding: '1rem', marginBottom: '0.75rem' }}>
          <h2 className="card-title" style={{ margin: '0 0 0.5rem 0' }}>{t('groupMgmt.inviteCode')}</h2>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
            {t('groupMgmt.inviteCodeHelp')}
          </p>
          <div style={{
            background: 'var(--background)', border: '2px dashed var(--border)', borderRadius: '10px',
            padding: '0.6rem', textAlign: 'center', letterSpacing: '5px', fontSize: '1.4rem',
            fontWeight: 700, fontFamily: 'monospace', color: 'var(--text)', direction: 'ltr', marginBottom: '0.75rem',
          }}>
            {inviteCode}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              onClick={() => {
                navigator.clipboard.writeText(inviteCode);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              style={{
                flex: 1, padding: '0.5rem', borderRadius: '8px', border: '1px solid var(--border)',
                background: copied ? '#10B981' : 'var(--surface)', color: copied ? 'white' : 'var(--text)',
                cursor: 'pointer', fontSize: '0.8rem', fontFamily: 'Outfit, sans-serif', fontWeight: 600,
              }}
            >
              {copied ? t('groupMgmt.codeCopied') : t('groupMgmt.copyCode')}
            </button>
            {typeof navigator.share === 'function' && (
              <button
                onClick={() => {
                  navigator.share({
                    title: t('groupMgmt.shareGroupTitle', { name: groupName }),
                    text: t('groupMgmt.shareGroupText', { code: inviteCode }),
                  }).catch(() => {});
                }}
                style={{
                  flex: 1, padding: '0.5rem', borderRadius: '8px', border: '1px solid var(--border)',
                  background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer',
                  fontSize: '0.8rem', fontFamily: 'Outfit, sans-serif', fontWeight: 600,
                }}
              >
                {t('common.share')}
              </button>
            )}
            {isOwner && (
              <button
                onClick={() => setConfirmAction({ type: 'regenerate' })}
                style={{
                  padding: '0.5rem 0.75rem', borderRadius: '8px', border: '1px solid rgba(239,68,68,0.3)',
                  background: 'rgba(239,68,68,0.08)', color: '#EF4444', cursor: 'pointer',
                  fontSize: '0.75rem', fontFamily: 'Outfit, sans-serif',
                }}
                title={t('groupMgmt.regenerateTooltip')}
              >
                🔄
              </button>
            )}
          </div>
        </div>
      )}

      {/* Personal Player Invites — available to all admins */}
      {isAdmin && unlinkedPlayers.length > 0 && (
        <div className="card" style={{ padding: '1rem', marginBottom: '0.75rem' }}>
          <h2 className="card-title" style={{ margin: '0 0 0.5rem 0' }}>{t('groupMgmt.personalInvites')}</h2>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
            {t('groupMgmt.personalInvitesHelp')}
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            {unlinkedPlayers.map((p, i, arr) => {
              const prevType = i > 0 ? arr[i - 1].type : null;
              const showDivider = prevType !== null && prevType !== p.type;
              return (
              <div key={p.id} style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                {showDivider && <div style={{ height: '1px', background: 'var(--border)', margin: '0.2rem 0' }} />}
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '0.55rem 0.75rem', borderRadius: '8px', background: 'var(--background)',
                  border: '1px solid var(--border)',
                }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{p.name}</span>
                  <span style={{
                    fontSize: '0.65rem', padding: '0.1rem 0.4rem', borderRadius: '4px',
                    background: p.type === 'permanent' ? 'rgba(99,102,241,0.12)' : 'rgba(100,100,100,0.12)',
                    color: p.type === 'permanent' ? '#818cf8' : 'var(--text-muted)',
                  }}>
                    {p.type === 'permanent' ? t('groupMgmt.playerTypePermanent') : p.type === 'permanent_guest' ? t('groupMgmt.playerTypeGuest') : t('groupMgmt.playerTypeOccasional')}
                  </span>
                </div>
                <button
                  onClick={() => handleCreateInvite(p.id)}
                  style={{
                    padding: '0.35rem 0.75rem', borderRadius: '8px', border: 'none',
                    background: 'var(--primary)', color: 'white', cursor: 'pointer',
                    fontSize: '0.75rem', fontFamily: 'Outfit, sans-serif', fontWeight: 600,
                  }}
                >
                  {t('groupMgmt.invite')}
                </button>
              </div>
              </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Add Member by Email — available to all admins */}
      {isAdmin && (
        <div className="card" style={{ padding: '1rem', marginBottom: '0.75rem' }}>
          <h2 className="card-title" style={{ margin: '0 0 0.5rem 0' }}>{t('groupMgmt.addByEmail')}</h2>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
            {t('groupMgmt.addByEmailHelp')}
          </p>
          <input
            type="email"
            value={addEmail}
            onChange={e => setAddEmail(e.target.value)}
            placeholder={t('groupMgmt.emailPlaceholder')}
            dir="ltr"
            style={{
              width: '100%', padding: '0.6rem 0.75rem', borderRadius: '8px',
              border: '1px solid var(--border)', background: 'var(--background)',
              color: 'var(--text)', fontSize: '0.9rem', fontFamily: 'Outfit, sans-serif',
              boxSizing: 'border-box', marginBottom: '0.5rem',
            }}
          />
          {unlinkedPlayers.length > 0 && (
            <select
              value={addEmailPlayer}
              onChange={e => setAddEmailPlayer(e.target.value)}
              style={{
                width: '100%', padding: '0.5rem 0.75rem', borderRadius: '8px',
                border: '1px solid var(--border)', background: '#1a1a2e',
                color: '#ffffff', fontSize: '0.8rem', fontFamily: 'Outfit, sans-serif',
                marginBottom: '0.5rem', cursor: 'pointer',
              }}
            >
              <option value="" style={{ background: '#1a1a2e', color: '#ffffff' }}>{t('groupMgmt.linkToPlayer')}</option>
              {unlinkedPlayers.map(p => (
                <option key={p.id} value={p.id} style={{ background: '#1a1a2e', color: '#ffffff' }}>{p.name}</option>
              ))}
            </select>
          )}
          <button
            onClick={handleAddByEmail}
            disabled={addEmailLoading}
            style={{
              width: '100%', padding: '0.6rem', borderRadius: '8px', border: 'none',
              background: 'var(--primary)', color: 'white', cursor: addEmailLoading ? 'not-allowed' : 'pointer',
              fontSize: '0.85rem', fontFamily: 'Outfit, sans-serif', fontWeight: 600,
              opacity: addEmailLoading ? 0.6 : 1,
            }}
          >
            {addEmailLoading ? '...' : t('groupMgmt.addToGroup')}
          </button>
        </div>
      )}

      {/* Personal Invite Share Modal */}
      {personalInvite && (
        <div className="modal-overlay" onClick={() => setPersonalInvite(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '380px' }}>
            <div className="modal-header">
              <h3 className="modal-title">{t('groupMgmt.personalInviteTitle', { name: personalInvite.playerName })}</h3>
              <button className="modal-close" onClick={() => setPersonalInvite(null)}>×</button>
            </div>

            <div style={{
              background: 'var(--background)', borderRadius: '10px', padding: '1rem',
              fontSize: '0.85rem', lineHeight: '1.6', whiteSpace: 'pre-line',
              marginBottom: '1rem', border: '1px solid var(--border)',
            }}>
              {personalInvite.message}
            </div>

            <div style={{
              background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)',
              borderRadius: '8px', padding: '0.6rem', textAlign: 'center', marginBottom: '1rem',
            }}>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>{t('groupMgmt.personalCodeLabel')}</div>
              <div style={{
                letterSpacing: '4px', fontSize: '1.4rem', fontWeight: 700,
                fontFamily: 'monospace', color: 'var(--text)', direction: 'ltr',
              }}>
                {personalInvite.code}
              </div>
            </div>

            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(personalInvite.message);
                  showMsg('success', t('groupMgmt.messageCopied'));
                }}
                style={{
                  flex: 1, padding: '0.65rem', borderRadius: '8px', border: '1px solid var(--border)',
                  background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer',
                  fontSize: '0.85rem', fontFamily: 'Outfit, sans-serif', fontWeight: 600,
                }}
              >
                {t('groupMgmt.copyMessage')}
              </button>
              {typeof navigator.share === 'function' && (
                <button
                  onClick={() => {
                    navigator.share({
                      title: t('groupMgmt.personalInviteTitle', { name: personalInvite.playerName }),
                      text: personalInvite.message,
                    }).catch(() => {});
                  }}
                  style={{
                    flex: 1, padding: '0.65rem', borderRadius: '8px', border: 'none',
                    background: '#25D366', color: 'white', cursor: 'pointer',
                    fontSize: '0.85rem', fontFamily: 'Outfit, sans-serif', fontWeight: 600,
                  }}
                >
                  {t('groupMgmt.sendWhatsApp')}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal */}
      {confirmAction && (
        <div className="modal-overlay" onClick={() => setConfirmAction(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">
                {confirmAction.type === 'remove' && t('groupMgmt.removeConfirmTitle')}
                {confirmAction.type === 'transfer' && t('groupMgmt.transferConfirmTitle')}
                {confirmAction.type === 'regenerate' && t('groupMgmt.regenConfirmTitle')}
              </h3>
              <button className="modal-close" onClick={() => setConfirmAction(null)}>×</button>
            </div>

            {confirmAction.type === 'remove' && (
              <>
                <p style={{ marginBottom: '0.5rem' }}>
                  {t('groupMgmt.removeConfirmBody', { name: confirmAction.name ?? '' })}
                </p>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
                  {t('groupMgmt.removeConfirmNote')}
                </p>
              </>
            )}
            {confirmAction.type === 'transfer' && (
              <>
                <p style={{ marginBottom: '0.5rem' }}>
                  {t('groupMgmt.transferConfirmBody', { name: confirmAction.name ?? '' })}
                </p>
                <p style={{ fontSize: '0.8rem', color: '#F59E0B', marginBottom: '1rem' }}>
                  {t('groupMgmt.transferConfirmWarning')}
                </p>
              </>
            )}
            {confirmAction.type === 'regenerate' && (
              <>
                <p style={{ marginBottom: '0.5rem' }}>
                  {t('groupMgmt.regenConfirmBody')}
                </p>
                <p style={{ fontSize: '0.8rem', color: '#F59E0B', marginBottom: '1rem' }}>
                  {t('groupMgmt.regenConfirmWarning')}
                </p>
              </>
            )}

            <div className="actions">
              <button className="btn btn-secondary" onClick={() => setConfirmAction(null)}>
                {t('common.cancel')}
              </button>
              <button
                className={confirmAction.type === 'transfer' ? 'btn' : 'btn btn-danger'}
                style={confirmAction.type === 'transfer' ? { background: '#A855F7', color: 'white', border: 'none', padding: '0.5rem 1rem', borderRadius: '8px', cursor: 'pointer', fontFamily: 'Outfit, sans-serif' } : undefined}
                onClick={() => {
                  if (confirmAction.type === 'remove' && confirmAction.userId) handleRemove(confirmAction.userId);
                  if (confirmAction.type === 'transfer' && confirmAction.userId) handleTransfer(confirmAction.userId);
                  if (confirmAction.type === 'regenerate') handleRegenerate();
                }}
              >
                {confirmAction.type === 'remove' && t('groupMgmt.confirmRemove')}
                {confirmAction.type === 'transfer' && t('groupMgmt.confirmTransfer')}
                {confirmAction.type === 'regenerate' && t('groupMgmt.confirmRegen')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
