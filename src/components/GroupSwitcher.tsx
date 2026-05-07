import { useState } from 'react';
import { usePermissions, ViewAsSwitcher } from '../App';
import { useTranslation } from '../i18n';
import { APP_VERSION } from '../version';
import GroupSetupScreen from '../screens/GroupSetupScreen';

export default function GroupSwitcher() {
  const { t, isRTL } = useTranslation();
  const { multiGroup, signOut, viewAs } = usePermissions();
  const [modalOpen, setModalOpen] = useState(false);
  const [setupMode, setSetupMode] = useState<'create' | 'join' | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    type: 'leave' | 'delete';
    groupId: string;
    groupName: string;
  } | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [actionLoading, setActionLoading] = useState(false);

  if (!multiGroup || multiGroup.memberships.length === 0) {
    return null;
  }

  const activeGroupId = multiGroup.activeGroupId;

  const getRoleBadge = (m: typeof multiGroup.memberships[0]) => {
    if (m.isOwner) return { text: t('groupSwitcher.roleOwner'), color: '#EAB308', bg: 'rgba(234,179,8,0.15)' };
    if (m.role === 'admin') return { text: t('groupSwitcher.roleAdmin'), color: '#3B82F6', bg: 'rgba(59,130,246,0.15)' };
    return { text: t('groupSwitcher.roleMember'), color: '#10B981', bg: 'rgba(16,185,129,0.15)' };
  };

  const memberCountLabel = (count: number) =>
    count === 1 ? t('groupSwitcher.oneMember') : t('groupSwitcher.members', { count: String(count) });

  // Super-admin observer entries: every group on the platform that the
  // user isn't a member of. Clicking one switches the active group_id
  // (auth + cache) without ever inserting a group_members row, so the
  // target group's existing members never see the super admin in their
  // own member lists / activity log / push roster (writes to those
  // tables are suppressed via observerMode flag).
  const memberGroupIds = new Set(multiGroup.memberships.map(m => m.groupId));
  const observerGroups = multiGroup.isSuperAdmin
    ? (multiGroup.allGroups ?? []).filter(g => !memberGroupIds.has(g.groupId))
    : [];

  const handleSwitch = (groupId: string) => {
    if (groupId === activeGroupId) {
      setModalOpen(false);
      return;
    }
    setModalOpen(false);
    multiGroup.switchGroup(groupId);
  };

  const handleLeave = async (groupId: string) => {
    setActionLoading(true);
    const { error } = await multiGroup.leaveGroup(groupId);
    setActionLoading(false);
    if (!error) {
      setConfirmAction(null);
      setModalOpen(false);
    }
  };

  const handleDelete = async (groupId: string) => {
    setActionLoading(true);
    const { error } = await multiGroup.deleteGroup(groupId);
    setActionLoading(false);
    if (!error) {
      setConfirmAction(null);
      setDeleteConfirmText('');
      setModalOpen(false);
    }
  };

  if (setupMode) {
    return (
      <div style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        background: 'var(--background)',
      }}>
        <GroupSetupScreen
          userEmail={multiGroup.userEmail}
          onCreateGroup={async (name) => {
            const result = await multiGroup.createGroup(name);
            if (!result.error) {
              multiGroup.triggerGroupWizard();
              setSetupMode(null);
            }
            return result;
          }}
          onJoinGroup={async (code) => {
            const result = await multiGroup.joinGroup(code);
            if (!result.error) setSetupMode(null);
            return result;
          }}
          onJoinByPlayerInvite={async (code) => {
            const result = await multiGroup.joinByPlayerInvite(code);
            if (!result.error) setSetupMode(null);
            return result;
          }}
          onSignOut={() => setSetupMode(null)}
          onContinue={() => {
            multiGroup.refreshMembership();
            setSetupMode(null);
          }}
          onClose={() => setSetupMode(null)}
          initialMode={setupMode}
        />
      </div>
    );
  }

  // Fall back to the observer-groups list when the active group isn't
  // in the user's memberships — happens whenever a super admin has
  // switched into someone else's group. Without this fallback the
  // header chip read as an empty string in observer mode.
  const currentGroupName =
    multiGroup.memberships.find(m => m.groupId === activeGroupId)?.groupName
    ?? observerGroups.find(g => g.groupId === activeGroupId)?.groupName
    ?? '';
  const isCurrentlyObserving = multiGroup.isObservingNonMember;

  return (
    <>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        width: '100%', padding: '0.4rem 1rem',
        background: 'var(--surface)', borderBottom: '1px solid var(--border)',
        direction: isRTL ? 'rtl' : 'ltr',
      }}>
        {/* Visual-start cluster: version label + (super-admin only)
            View-As preview pill. Wrapped together so they share the
            start side and don't break the centered group-name layout. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <span style={{ fontSize: '0.58rem', color: 'var(--text-muted)', opacity: 0.5, fontFamily: 'monospace' }}>
            v{APP_VERSION}
          </span>
          {viewAs && (
            <ViewAsSwitcher current={viewAs.current} onCycle={viewAs.cycle} />
          )}
        </div>
        <button
          onClick={() => setModalOpen(true)}
          style={{
            display: 'flex', alignItems: 'center', gap: '0.4rem',
            background: 'none', border: 'none', cursor: 'pointer',
            fontFamily: 'Outfit, sans-serif',
          }}
        >
          {/* Observer-mode tag in the header bar — only the super
              admin themself sees this, and it's the only way for them
              to remember "I'm not in my own group right now". The
              target group's members never load this component with
              observer state, so they can't see it. */}
          {isCurrentlyObserving && (
            <span
              title={t('groupSwitcher.observerHint')}
              style={{
                fontSize: '0.55rem', fontWeight: 700,
                padding: '0.1rem 0.35rem', borderRadius: '4px',
                background: 'rgba(168,85,247,0.18)', color: '#a855f7',
                letterSpacing: '0.04em', textTransform: 'uppercase',
              }}
            >
              👁 {t('groupSwitcher.observerBadge')}
            </span>
          )}
          <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text)' }}>
            {currentGroupName}
          </span>
          <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>▼</span>
        </button>
        {/* Sign-out anchored to the visual end of the header bar.
            Replaces the previous 3rem balancing spacer so we reclaim
            that whitespace on every screen instead of paying for a
            dedicated sign-out row on the home dashboard. Compact icon
            + label keeps the action discoverable without crowding the
            centered group name. */}
        <button
          onClick={signOut}
          title={t('common.signOut')}
          style={{
            display: 'flex', alignItems: 'center', gap: '0.25rem',
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--text-muted)',
            fontFamily: 'Outfit, sans-serif',
            fontSize: '0.7rem', fontWeight: 500,
            padding: '0.2rem 0.4rem',
            opacity: 0.85,
          }}
        >
          <span aria-hidden style={{ fontSize: '0.8rem', lineHeight: 1 }}>🔓</span>
          <span>{t('common.signOut')}</span>
        </button>
      </div>

      {modalOpen && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 10000,
            background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '1rem',
            animation: 'backdropFadeIn 0.2s ease-out',
          }}
          onClick={() => { setModalOpen(false); setExpandedId(null); }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: 'var(--surface)', borderRadius: '16px',
              width: '100%', maxWidth: '380px',
              boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
              overflow: 'hidden', direction: isRTL ? 'rtl' : 'ltr',
              animation: 'modalSlideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
            }}
          >
            {/* Header with close button */}
            <div style={{
              padding: '1rem 1.25rem 0.75rem',
              borderBottom: '1px solid var(--border)',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <h3 style={{
                margin: 0, fontSize: '1rem', fontWeight: 700,
                color: 'var(--text)',
              }}>
                {t('groupSwitcher.title')}
              </h3>
              <button
                onClick={() => { setModalOpen(false); setExpandedId(null); }}
                style={{
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--text-muted)', fontSize: '1.2rem', padding: '0.2rem',
                  lineHeight: 1,
                }}
              >
                ✕
              </button>
            </div>

            {/* Group list */}
            <div style={{ padding: '0.5rem', maxHeight: '350px', overflowY: 'auto' }}>
              {multiGroup.memberships.map((m, i) => {
                const isActive = m.groupId === activeGroupId;
                const badge = getRoleBadge(m);
                const isExpanded = expandedId === m.groupId;

                return (
                  <div key={m.groupId} style={{
                    animation: 'contentFadeIn 0.25s ease-out backwards',
                    animationDelay: `${i * 0.04}s`,
                  }}>
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: '0.75rem',
                      width: '100%', padding: '0.75rem',
                      background: isActive ? 'rgba(99,102,241,0.1)' : 'transparent',
                      border: isActive ? '1px solid rgba(99,102,241,0.3)' : '1px solid transparent',
                      borderRadius: isExpanded ? '10px 10px 0 0' : '10px',
                      transition: 'background 0.2s',
                    }}>
                      {/* Group icon — click to switch */}
                      <button
                        onClick={() => handleSwitch(m.groupId)}
                        style={{
                          width: '36px', height: '36px', borderRadius: '10px',
                          background: isActive ? 'var(--primary)' : 'var(--border)',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: '1rem', flexShrink: 0, border: 'none', cursor: 'pointer',
                          color: isActive ? 'white' : 'var(--text-muted)',
                        }}
                      >
                        {isActive ? '✓' : '🃏'}
                      </button>

                      {/* Group info — click to switch */}
                      <button
                        onClick={() => handleSwitch(m.groupId)}
                        style={{
                          flex: 1, minWidth: 0, background: 'none', border: 'none',
                          cursor: 'pointer', textAlign: isRTL ? 'right' : 'left',
                          fontFamily: 'Outfit, sans-serif', padding: 0,
                        }}
                      >
                        <div style={{
                          fontWeight: 600, fontSize: '0.9rem',
                          color: isActive ? 'var(--primary)' : 'var(--text)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>
                          {m.groupName}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.15rem', flexWrap: 'wrap' }}>
                          <span style={{
                            fontSize: '0.65rem', padding: '0.1rem 0.35rem', borderRadius: '4px',
                            background: badge.bg, color: badge.color, fontWeight: 600,
                          }}>
                            {badge.text}
                          </span>
                          {m.playerName && (
                            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                              {m.playerName}
                            </span>
                          )}
                          {m.memberCount > 0 && (
                            <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)', opacity: 0.7 }}>
                              · {memberCountLabel(m.memberCount)}
                            </span>
                          )}
                        </div>
                      </button>

                      {/* Expand/collapse menu button */}
                      <button
                        onClick={() => setExpandedId(isExpanded ? null : m.groupId)}
                        style={{
                          background: 'none', border: 'none', cursor: 'pointer',
                          color: 'var(--text-muted)', fontSize: '1rem', padding: '0.3rem',
                          opacity: 0.5, flexShrink: 0, lineHeight: 1,
                          transition: 'opacity 0.2s',
                        }}
                      >
                        ⋯
                      </button>
                    </div>

                    {/* Expanded actions */}
                    {isExpanded && (
                      <div style={{
                        padding: '0.5rem 0.75rem',
                        background: isActive ? 'rgba(99,102,241,0.05)' : 'rgba(255,255,255,0.02)',
                        border: isActive ? '1px solid rgba(99,102,241,0.3)' : '1px solid var(--border)',
                        borderTop: 'none',
                        borderRadius: '0 0 10px 10px',
                        animation: 'contentFadeIn 0.15s ease-out',
                      }}>
                        <button
                          onClick={() => {
                            setExpandedId(null);
                            setConfirmAction({
                              type: m.isOwner ? 'delete' : 'leave',
                              groupId: m.groupId,
                              groupName: m.groupName,
                            });
                          }}
                          style={{
                            width: '100%', padding: '0.45rem 0.75rem', borderRadius: '6px',
                            border: '1px solid rgba(239,68,68,0.3)',
                            background: 'rgba(239,68,68,0.08)', color: '#EF4444',
                            cursor: 'pointer', fontSize: '0.75rem',
                            fontFamily: 'Outfit, sans-serif', fontWeight: 600,
                            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.3rem',
                          }}
                        >
                          {m.isOwner ? t('groupSwitcher.deleteGroup') : t('groupSwitcher.leaveGroup')}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Observer-mode section: every other group on the
                  platform, super-admin only. Rendered as a flat list
                  with a single-line label so there's no chance of a
                  regular member mistaking a "👁 observer" entry for
                  their own group. The selectable rows mirror the
                  membership entries above visually but use a purple
                  accent (vs. the indigo "active" highlight) and skip
                  the role badge / overflow menu (no leave/delete on
                  someone else's group). */}
              {observerGroups.length > 0 && (
                <>
                  <div style={{
                    margin: '0.5rem 0.25rem 0.3rem',
                    display: 'flex', alignItems: 'center', gap: '0.4rem',
                  }}>
                    <span style={{ flex: 1, height: 1, background: 'var(--border)', opacity: 0.5 }} />
                    <span style={{
                      fontSize: '0.55rem', fontWeight: 700, color: '#a855f7',
                      textTransform: 'uppercase', letterSpacing: '0.05em',
                      whiteSpace: 'nowrap',
                    }}>
                      👁 {t('groupSwitcher.observerSection', { count: String(observerGroups.length) })}
                    </span>
                    <span style={{ flex: 1, height: 1, background: 'var(--border)', opacity: 0.5 }} />
                  </div>
                  {observerGroups.map(g => {
                    const isActive = g.groupId === activeGroupId;
                    return (
                      <div key={g.groupId} style={{
                        animation: 'contentFadeIn 0.25s ease-out backwards',
                      }}>
                        <button
                          onClick={() => handleSwitch(g.groupId)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: '0.75rem',
                            width: '100%', padding: '0.6rem 0.75rem',
                            background: isActive ? 'rgba(168,85,247,0.1)' : 'transparent',
                            border: isActive ? '1px solid rgba(168,85,247,0.35)' : '1px solid transparent',
                            borderRadius: '10px',
                            cursor: 'pointer', fontFamily: 'Outfit, sans-serif',
                            textAlign: isRTL ? 'right' : 'left',
                          }}
                        >
                          <span style={{
                            width: '32px', height: '32px', borderRadius: '8px',
                            background: isActive ? '#a855f7' : 'rgba(168,85,247,0.15)',
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: '0.85rem', flexShrink: 0,
                            color: isActive ? 'white' : '#a855f7',
                          }}>
                            {isActive ? '✓' : '👁'}
                          </span>
                          <span style={{ flex: 1, minWidth: 0 }}>
                            <span style={{
                              display: 'block',
                              fontWeight: 600, fontSize: '0.85rem',
                              color: isActive ? '#a855f7' : 'var(--text)',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}>
                              {g.groupName}
                            </span>
                            <span style={{
                              display: 'block',
                              fontSize: '0.6rem', color: 'var(--text-muted)',
                              marginTop: '0.1rem',
                            }}>
                              {memberCountLabel(g.memberCount)}
                            </span>
                          </span>
                        </button>
                      </div>
                    );
                  })}
                </>
              )}
            </div>

            {/* Footer: Create / Join */}
            <div style={{
              padding: '0.75rem 1rem', borderTop: '1px solid var(--border)',
              display: 'flex', gap: '0.5rem',
            }}>
              <button
                onClick={() => { setModalOpen(false); setExpandedId(null); setSetupMode('create'); }}
                style={{
                  flex: 1, padding: '0.6rem', borderRadius: '8px',
                  border: 'none', background: 'var(--primary)', color: 'white',
                  cursor: 'pointer', fontFamily: 'Outfit, sans-serif',
                  fontSize: '0.8rem', fontWeight: 600,
                }}
              >
                {t('groupSwitcher.createNew')}
              </button>
              <button
                onClick={() => { setModalOpen(false); setExpandedId(null); setSetupMode('join'); }}
                style={{
                  flex: 1, padding: '0.6rem', borderRadius: '8px',
                  border: '1px solid var(--border)', background: 'transparent',
                  color: 'var(--text)', cursor: 'pointer',
                  fontFamily: 'Outfit, sans-serif',
                  fontSize: '0.8rem', fontWeight: 600,
                }}
              >
                {t('groupSwitcher.joinGroup')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm leave/delete modal */}
      {confirmAction && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 10001,
            background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '1rem',
            animation: 'backdropFadeIn 0.2s ease-out',
          }}
          onClick={() => { setConfirmAction(null); setDeleteConfirmText(''); }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: 'var(--surface)', borderRadius: '16px',
              width: '100%', maxWidth: '360px', padding: '1.25rem',
              boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
              direction: isRTL ? 'rtl' : 'ltr',
              animation: 'modalSlideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
            }}
          >
            <h3 style={{ margin: '0 0 0.75rem', fontSize: '1rem', fontWeight: 700, color: 'var(--text)' }}>
              {confirmAction.type === 'leave'
                ? t('groupSwitcher.leaveConfirmTitle')
                : t('groupSwitcher.deleteConfirmTitle')}
            </h3>

            {confirmAction.type === 'leave' ? (
              <>
                <p style={{ margin: '0 0 0.5rem', fontSize: '0.85rem', color: 'var(--text)' }}>
                  {t('groupSwitcher.leaveConfirmBody', { name: confirmAction.groupName })}
                </p>
                <p style={{ margin: '0 0 1rem', fontSize: '0.8rem', color: '#F59E0B' }}>
                  {t('groupSwitcher.leaveConfirmWarning')}
                </p>
              </>
            ) : (
              <>
                <p style={{ margin: '0 0 0.5rem', fontSize: '0.85rem', color: '#EF4444', fontWeight: 600 }}>
                  {t('groupSwitcher.deleteConfirmBody', { name: confirmAction.groupName })}
                </p>
                <p style={{ margin: '0 0 0.75rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  {t('groupSwitcher.deleteConfirmWarning')}
                </p>
                <p style={{ margin: '0 0 0.4rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  {t('groupSwitcher.deleteConfirmType', { name: confirmAction.groupName })}
                </p>
                <input
                  type="text"
                  value={deleteConfirmText}
                  onChange={e => setDeleteConfirmText(e.target.value)}
                  placeholder={confirmAction.groupName}
                  dir={isRTL ? 'rtl' : 'ltr'}
                  style={{
                    width: '100%', padding: '0.5rem 0.75rem', borderRadius: '8px',
                    border: '1px solid var(--border)', background: 'var(--background)',
                    color: 'var(--text)', fontSize: '0.9rem', fontFamily: 'Outfit, sans-serif',
                    boxSizing: 'border-box', marginBottom: '1rem',
                  }}
                />
              </>
            )}

            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={() => { setConfirmAction(null); setDeleteConfirmText(''); }}
                style={{
                  flex: 1, padding: '0.55rem', borderRadius: '8px',
                  border: '1px solid var(--border)', background: 'transparent',
                  color: 'var(--text-muted)', cursor: 'pointer',
                  fontFamily: 'Outfit, sans-serif', fontSize: '0.8rem', fontWeight: 600,
                }}
              >
                {t('common.cancel')}
              </button>
              <button
                disabled={actionLoading || (confirmAction.type === 'delete' && deleteConfirmText !== confirmAction.groupName)}
                onClick={() => {
                  if (confirmAction.type === 'leave') handleLeave(confirmAction.groupId);
                  else handleDelete(confirmAction.groupId);
                }}
                style={{
                  flex: 1, padding: '0.55rem', borderRadius: '8px',
                  border: 'none',
                  background: actionLoading || (confirmAction.type === 'delete' && deleteConfirmText !== confirmAction.groupName)
                    ? 'rgba(239,68,68,0.3)' : '#EF4444',
                  color: 'white', fontFamily: 'Outfit, sans-serif',
                  fontSize: '0.8rem', fontWeight: 600,
                  cursor: actionLoading || (confirmAction.type === 'delete' && deleteConfirmText !== confirmAction.groupName)
                    ? 'not-allowed' : 'pointer',
                  opacity: actionLoading ? 0.6 : 1,
                }}
              >
                {actionLoading ? '...' : confirmAction.type === 'leave'
                  ? t('groupSwitcher.confirmLeave')
                  : t('groupSwitcher.confirmDelete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
