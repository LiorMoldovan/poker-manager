import { useState, useEffect, useCallback } from 'react';
import { getAllPlayers, getAllGames, getAllGamePlayers } from '../database/storage';
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
  deleteGroup?: () => Promise<{ error: unknown }>;
  leaveGroup?: () => Promise<{ error: unknown }>;
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
  deleteGroup,
  leaveGroup,
  appUrl,
}: GroupManagementTabProps) {
  const { t, isRTL } = useTranslation();
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteCode, setInviteCode] = useState(initialInviteCode);
  const [copied, setCopied] = useState(false);
  const [actionMsg, setActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    type: 'remove' | 'transfer' | 'regenerate' | 'delete_group' | 'leave_group';
    userId?: string;
    name?: string;
  } | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
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

  const handleDeleteGroup = async () => {
    if (!deleteGroup) return;
    const { error } = await deleteGroup();
    setConfirmAction(null);
    setDeleteConfirmText('');
    if (error) {
      showMsg('error', (error as { message?: string })?.message || t('groupMgmt.errorDeleteGroup'));
    }
  };

  const handleLeaveGroup = async () => {
    if (!leaveGroup) return;
    const { error } = await leaveGroup();
    setConfirmAction(null);
    if (error) {
      showMsg('error', (error as { message?: string })?.message || t('groupMgmt.errorLeaveGroup'));
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

  const allPlayers = getAllPlayers();
  const allGames = getAllGames();
  const completedGames = allGames.filter(g => g.status === 'completed');
  const activePlayers = new Set(getAllGamePlayers().filter(gp => {
    const g = allGames.find(ga => ga.id === gp.gameId);
    return g && g.status === 'completed';
  }).map(gp => gp.playerId)).size;
  const firstGameDate = completedGames.length > 0
    ? completedGames.map(g => new Date(g.date || g.createdAt).getTime()).reduce((a, b) => Math.min(a, b))
    : null;
  const playerTypeMap = new Map(allPlayers.map(p => [p.id, p.type]));
  const linkedPlayerIds = new Set(members.map(m => m.playerId).filter(Boolean));
  const typeOrder: Record<string, number> = { permanent: 0, permanent_guest: 1, guest: 2 };
  const unlinkedPlayers = allPlayers
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

      {/* Group Info + Invite Code */}
      <div className="card" style={{ padding: '1rem', marginBottom: '0.75rem' }}>
        <h2 className="card-title" style={{ margin: '0 0 0.75rem 0' }}>{t('groupMgmt.details')}</h2>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{t('groupMgmt.name')}</span>
          <span style={{ fontSize: '0.95rem', fontWeight: 600 }}>{groupName}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{t('groupMgmt.memberCount')}</span>
          <span style={{ fontSize: '0.95rem', fontWeight: 600 }}>{members.length}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{t('groupMgmt.activePlayers')}</span>
          <span style={{ fontSize: '0.95rem', fontWeight: 600 }}>{activePlayers}</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
          <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{t('groupMgmt.totalGames')}</span>
          <span style={{ fontSize: '0.95rem', fontWeight: 600 }}>{completedGames.length}</span>
        </div>
        {firstGameDate && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: isAdmin && inviteCode ? '0.5rem' : 0 }}>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{t('groupMgmt.since')}</span>
            <span style={{ fontSize: '0.95rem', fontWeight: 600 }}>{new Date(firstGameDate).toLocaleDateString(isRTL ? 'he-IL' : 'en-US', { month: 'short', year: 'numeric' })}</span>
          </div>
        )}
        {isAdmin && inviteCode && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{t('groupMgmt.inviteCode')}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', direction: 'ltr' }}>
              <span style={{
                fontSize: '0.95rem', fontWeight: 700, fontFamily: 'monospace',
                color: 'var(--text)', letterSpacing: '2px',
              }}>{inviteCode}</span>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(inviteCode);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
                style={{
                  padding: '0.15rem 0.4rem', borderRadius: '5px', border: '1px solid var(--border)',
                  background: copied ? '#10B981' : 'transparent', color: copied ? 'white' : 'var(--text-muted)',
                  cursor: 'pointer', fontSize: '0.65rem', fontFamily: 'Outfit, sans-serif',
                }}
              >
                {copied ? '✓' : '📋'}
              </button>
              {isOwner && (
                <button
                  onClick={() => setConfirmAction({ type: 'regenerate' })}
                  style={{
                    padding: '0.15rem 0.4rem', borderRadius: '5px',
                    border: '1px solid rgba(239,68,68,0.3)', background: 'transparent',
                    color: '#EF4444', cursor: 'pointer', fontSize: '0.65rem', fontFamily: 'Outfit, sans-serif',
                  }}
                  title={t('groupMgmt.regenerateTooltip')}
                >🔄</button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Member List */}
      <div className="card" style={{ padding: '1rem', marginBottom: '0.75rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
          <h2 className="card-title" style={{ margin: 0 }}>{t('groupMgmt.members')}</h2>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '1.5rem 0' }}>
            <div style={{ fontSize: '1.5rem', animation: 'pulse 1.5s ease-in-out infinite', marginBottom: '0.5rem' }}>👥</div>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{t('common.loading')}</p>
          </div>
        ) : (
          <div>
            {[...members].sort((a, b) => {
              const aIsOwner = isOwner && a.userId === currentUserId ? 1 : 0;
              const bIsOwner = isOwner && b.userId === currentUserId ? 1 : 0;
              if (aIsOwner !== bIsOwner) return bIsOwner - aIsOwner;
              const roleOrder: Record<string, number> = { admin: 0, member: 1 };
              const aRole = roleOrder[a.role] ?? 2;
              const bRole = roleOrder[b.role] ?? 2;
              if (aRole !== bRole) return aRole - bRole;
              const aType = a.playerId ? (playerTypeMap.get(a.playerId) || 'guest') : 'zzz';
              const bType = b.playerId ? (playerTypeMap.get(b.playerId) || 'guest') : 'zzz';
              const tOrder: Record<string, number> = { permanent: 0, permanent_guest: 1, guest: 2, zzz: 3 };
              return (tOrder[aType] ?? 9) - (tOrder[bType] ?? 9);
            }).map((m, idx) => {
              const isMe = m.userId === currentUserId;
              const isMemberOwner = members.length > 0 && isOwner && isMe;
              const displayName = m.playerName || m.displayName || t('groupMgmt.noName');
              const canManage = isAdmin && !isMe && (isOwner || m.role !== 'admin');
              const pType = m.playerId ? playerTypeMap.get(m.playerId) : null;
              const typeIcon = pType === 'permanent' ? '⭐' : pType === 'permanent_guest' ? '🏠' : pType ? '👤' : null;

              return (
                <div
                  key={m.userId}
                  className={`settings-row${isMe ? ' settings-row-highlight' : ''}`}
                  style={{ animation: `contentFadeIn 0.25s ease-out ${idx * 0.03}s both` }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                      <span style={{
                        fontWeight: 600, fontSize: '0.85rem',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {displayName}
                      </span>
                      {typeIcon && (
                        <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>{typeIcon}</span>
                      )}
                      {isMe && (
                        <span style={{
                          fontSize: '0.55rem', background: 'rgba(16,185,129,0.2)', color: '#10B981',
                          padding: '0.1rem 0.3rem', borderRadius: '4px', fontWeight: 600,
                        }}>
                          {t('groupMgmt.you')}
                        </span>
                      )}
                      {isMemberOwner && (
                        <span style={{ fontSize: '0.6rem', color: '#EAB308' }}>👑</span>
                      )}
                    </div>
                    {m.email && (
                      <span style={{
                        fontSize: '0.68rem', color: 'var(--text-muted)', direction: 'ltr',
                        display: 'block', overflow: 'hidden', textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap', marginTop: '0.1rem',
                      }}>
                        {m.email}
                      </span>
                    )}
                    {!m.playerName && m.playerId === null && (
                      <span style={{ fontSize: '0.65rem', color: '#F59E0B', marginTop: '0.1rem', display: 'block' }}>
                        ⚠ {t('groupMgmt.notLinked')}
                      </span>
                    )}
                  </div>

                  {canManage ? (
                    <>
                      <select
                        value={m.role}
                        onChange={e => handleRoleChange(m.userId, e.target.value)}
                        style={{
                          padding: '0.25rem 0.4rem', borderRadius: '8px',
                          border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.06)',
                          color: 'var(--text)', fontSize: '0.7rem',
                          fontFamily: 'Outfit, sans-serif', cursor: 'pointer', flexShrink: 0,
                        }}
                      >
                        <option value="admin" style={{ background: '#1a1a2e', color: '#ffffff' }}>{t('groupMgmt.roleAdmin')}</option>
                        <option value="member" style={{ background: '#1a1a2e', color: '#ffffff' }}>{t('groupMgmt.roleMember')}</option>
                      </select>
                      <button
                        className="row-action row-action-danger"
                        onClick={() => setConfirmAction({ type: 'remove', userId: m.userId, name: m.playerName || m.displayName || '' })}
                        title={t('groupMgmt.removeMember')}
                      >
                        🗑️
                      </button>
                    </>
                  ) : !isMe && (
                    <span style={{
                      fontSize: '0.65rem', color: 'var(--text-muted)', flexShrink: 0,
                      padding: '0.2rem 0.45rem', borderRadius: '6px',
                      background: 'rgba(255,255,255,0.04)',
                    }}>
                      {roleLabel(m.role)}
                    </span>
                  )}

                  {isMemberOwner && members.filter(x => x.userId !== currentUserId).length > 0 && (
                    <select
                      value=""
                      onChange={e => {
                        const target = members.find(x => x.userId === e.target.value);
                        if (target) {
                          setConfirmAction({ type: 'transfer', userId: target.userId, name: target.playerName || target.displayName || '' });
                        }
                      }}
                      style={{
                        padding: '0.25rem 0.4rem', borderRadius: '8px',
                        border: '1px solid rgba(168,85,247,0.15)', background: 'rgba(168,85,247,0.06)',
                        color: '#A855F7', fontSize: '0.65rem', fontFamily: 'Outfit, sans-serif',
                        cursor: 'pointer', flexShrink: 0,
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
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>


      {/* Personal Player Invites — available to all admins */}
      {isAdmin && unlinkedPlayers.length > 0 && (
        <div className="card" style={{ padding: '1rem', marginBottom: '0.75rem' }}>
          <h2 className="card-title" style={{ margin: '0 0 0.5rem 0' }}>{t('groupMgmt.personalInvites')}</h2>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
            {t('groupMgmt.personalInvitesHelp')}
          </p>
          <div>
            {unlinkedPlayers.map((p, i, arr) => {
              const prevType = i > 0 ? arr[i - 1].type : null;
              const showDivider = prevType !== null && prevType !== p.type;
              return (
              <div key={p.id}>
                {showDivider && <div style={{ height: '1px', background: 'var(--border)', margin: '0.15rem 0', opacity: 0.3 }} />}
                <div className="settings-row" style={{ justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                    <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{p.name}</span>
                    <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>
                      {p.type === 'permanent' ? '⭐' : p.type === 'permanent_guest' ? '🏠' : '👤'}
                    </span>
                  </div>
                  <button
                    onClick={() => handleCreateInvite(p.id)}
                    className="btn btn-sm"
                    style={{
                      padding: '0.25rem 0.6rem', fontSize: '0.72rem',
                      background: 'rgba(16,185,129,0.12)', color: '#10B981',
                      border: '1px solid rgba(16,185,129,0.3)',
                      borderRadius: '6px', fontFamily: 'Outfit, sans-serif', fontWeight: 600, cursor: 'pointer',
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
          <div style={{ display: 'flex', gap: '0.4rem' }}>
            {unlinkedPlayers.length > 0 && (
              <select
                value={addEmailPlayer}
                onChange={e => setAddEmailPlayer(e.target.value)}
                style={{
                  flex: 1, padding: '0.5rem 0.6rem', borderRadius: '8px',
                  border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.06)',
                  color: 'var(--text)', fontSize: '0.78rem', fontFamily: 'Outfit, sans-serif',
                  cursor: 'pointer', minWidth: 0,
                }}
              >
                <option value="" style={{ background: '#1a1a2e', color: '#94a3b8' }}>{t('groupMgmt.linkToPlayer')}</option>
                {unlinkedPlayers.map(p => (
                  <option key={p.id} value={p.id} style={{ background: '#1a1a2e', color: '#ffffff' }}>{p.name}</option>
                ))}
              </select>
            )}
            <button
              onClick={handleAddByEmail}
              disabled={addEmailLoading}
              style={{
                flex: unlinkedPlayers.length > 0 ? undefined : 1,
                padding: '0.5rem 0.75rem', borderRadius: '8px',
                border: '1px solid rgba(16,185,129,0.3)', background: 'rgba(16,185,129,0.12)',
                color: '#10B981', cursor: addEmailLoading ? 'not-allowed' : 'pointer',
                fontSize: '0.8rem', fontFamily: 'Outfit, sans-serif', fontWeight: 600,
                opacity: addEmailLoading ? 0.6 : 1, whiteSpace: 'nowrap',
              }}
            >
              {addEmailLoading ? '...' : t('groupMgmt.addToGroup')}
            </button>
          </div>
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

      {/* Danger Zone */}
      <div className="card" style={{
        padding: '1rem', marginBottom: '0.75rem',
        borderInlineStart: '3px solid #EF4444',
        background: 'rgba(239,68,68,0.04)',
      }}>
        <h2 className="card-title" style={{ margin: '0 0 0.5rem 0', color: '#EF4444' }}>
          {t('groupMgmt.dangerZone')}
        </h2>
        {isOwner ? (
          <>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
              {t('groupMgmt.deleteGroupDesc')}
            </p>
            <button
              onClick={() => { setConfirmAction({ type: 'delete_group' }); setDeleteConfirmText(''); }}
              style={{
                width: '100%', padding: '0.6rem', borderRadius: '8px',
                border: '1px solid rgba(239,68,68,0.4)',
                background: 'rgba(239,68,68,0.1)', color: '#EF4444',
                cursor: 'pointer', fontSize: '0.85rem',
                fontFamily: 'Outfit, sans-serif', fontWeight: 600,
              }}
            >
              {t('groupMgmt.deleteGroup')}
            </button>
          </>
        ) : (
          <>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
              {t('groupMgmt.leaveGroupDesc')}
            </p>
            <button
              onClick={() => setConfirmAction({ type: 'leave_group' })}
              style={{
                width: '100%', padding: '0.6rem', borderRadius: '8px',
                border: '1px solid rgba(239,68,68,0.4)',
                background: 'rgba(239,68,68,0.1)', color: '#EF4444',
                cursor: 'pointer', fontSize: '0.85rem',
                fontFamily: 'Outfit, sans-serif', fontWeight: 600,
              }}
            >
              {t('groupMgmt.leaveGroup')}
            </button>
          </>
        )}
      </div>

      {/* Confirmation Modal */}
      {confirmAction && (
        <div className="modal-overlay" onClick={() => { setConfirmAction(null); setDeleteConfirmText(''); }}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">
                {confirmAction.type === 'remove' && t('groupMgmt.removeConfirmTitle')}
                {confirmAction.type === 'transfer' && t('groupMgmt.transferConfirmTitle')}
                {confirmAction.type === 'regenerate' && t('groupMgmt.regenConfirmTitle')}
                {confirmAction.type === 'delete_group' && t('groupMgmt.deleteGroupConfirmTitle')}
                {confirmAction.type === 'leave_group' && t('groupMgmt.leaveGroupConfirmTitle')}
              </h3>
              <button className="modal-close" onClick={() => { setConfirmAction(null); setDeleteConfirmText(''); }}>×</button>
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
            {confirmAction.type === 'delete_group' && (
              <>
                <p style={{ marginBottom: '0.5rem', color: '#EF4444', fontWeight: 600 }}>
                  {t('groupMgmt.deleteGroupConfirmBody', { name: groupName })}
                </p>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
                  {t('groupMgmt.deleteGroupConfirmWarning')}
                </p>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>
                  {t('groupMgmt.deleteGroupTypeConfirm', { name: groupName })}
                </p>
                <input
                  type="text"
                  value={deleteConfirmText}
                  onChange={e => setDeleteConfirmText(e.target.value)}
                  placeholder={groupName}
                  dir="rtl"
                  style={{
                    width: '100%', padding: '0.5rem 0.75rem', borderRadius: '8px',
                    border: '1px solid var(--border)', background: 'var(--background)',
                    color: 'var(--text)', fontSize: '0.9rem', fontFamily: 'Outfit, sans-serif',
                    boxSizing: 'border-box', marginBottom: '1rem',
                  }}
                />
              </>
            )}
            {confirmAction.type === 'leave_group' && (
              <>
                <p style={{ marginBottom: '0.5rem' }}>
                  {t('groupMgmt.leaveGroupConfirmBody', { name: groupName })}
                </p>
                <p style={{ fontSize: '0.8rem', color: '#F59E0B', marginBottom: '1rem' }}>
                  {t('groupMgmt.leaveGroupConfirmWarning')}
                </p>
              </>
            )}

            <div className="actions">
              <button className="btn btn-secondary" onClick={() => { setConfirmAction(null); setDeleteConfirmText(''); }}>
                {t('common.cancel')}
              </button>
              <button
                className={confirmAction.type === 'transfer' ? 'btn' : 'btn btn-danger'}
                style={confirmAction.type === 'transfer' ? { background: '#A855F7', color: 'white', border: 'none', padding: '0.5rem 1rem', borderRadius: '8px', cursor: 'pointer', fontFamily: 'Outfit, sans-serif' } : undefined}
                disabled={confirmAction.type === 'delete_group' && deleteConfirmText !== groupName}
                onClick={() => {
                  if (confirmAction.type === 'remove' && confirmAction.userId) handleRemove(confirmAction.userId);
                  if (confirmAction.type === 'transfer' && confirmAction.userId) handleTransfer(confirmAction.userId);
                  if (confirmAction.type === 'regenerate') handleRegenerate();
                  if (confirmAction.type === 'delete_group') handleDeleteGroup();
                  if (confirmAction.type === 'leave_group') handleLeaveGroup();
                }}
              >
                {confirmAction.type === 'remove' && t('groupMgmt.confirmRemove')}
                {confirmAction.type === 'transfer' && t('groupMgmt.confirmTransfer')}
                {confirmAction.type === 'regenerate' && t('groupMgmt.confirmRegen')}
                {confirmAction.type === 'delete_group' && t('groupMgmt.confirmDeleteGroup')}
                {confirmAction.type === 'leave_group' && t('groupMgmt.confirmLeaveGroup')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
