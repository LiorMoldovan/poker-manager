import { useState } from 'react';
import { usePermissions } from '../App';
import { useTranslation } from '../i18n';
import GroupSetupScreen from '../screens/GroupSetupScreen';

export default function GroupSwitcher() {
  const { t, isRTL } = useTranslation();
  const { multiGroup, groupMgmt } = usePermissions();
  const [modalOpen, setModalOpen] = useState(false);
  const [setupMode, setSetupMode] = useState<'create' | 'join' | null>(null);

  if (!multiGroup || multiGroup.memberships.length === 0) {
    return null;
  }

  const currentGroupName = groupMgmt?.groupName ?? '';
  const activeGroupId = multiGroup.memberships.find(
    m => m.groupName === currentGroupName
  )?.groupId;

  const handleSwitch = (groupId: string) => {
    if (groupId === activeGroupId) {
      setModalOpen(false);
      return;
    }
    setModalOpen(false);
    multiGroup.switchGroup(groupId);
  };

  const getRoleBadge = (m: typeof multiGroup.memberships[0]) => {
    if (m.isOwner) return { text: t('groupSwitcher.roleOwner'), color: '#EAB308', bg: 'rgba(234,179,8,0.15)' };
    if (m.role === 'admin') return { text: t('groupSwitcher.roleAdmin'), color: '#3B82F6', bg: 'rgba(59,130,246,0.15)' };
    return { text: t('groupSwitcher.roleMember'), color: '#10B981', bg: 'rgba(16,185,129,0.15)' };
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
            if (!result.error) setSetupMode(null);
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

  return (
    <>
      <button
        onClick={() => setModalOpen(true)}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem',
          width: '100%', padding: '0.4rem 1rem',
          background: 'var(--surface)', borderBottom: '1px solid var(--border)',
          border: 'none', cursor: 'pointer',
          fontFamily: 'Outfit, sans-serif', direction: isRTL ? 'rtl' : 'ltr',
        }}
      >
        <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text)' }}>
          {currentGroupName}
        </span>
        <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>▼</span>
      </button>

      {modalOpen && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 10000,
            background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '1rem',
            animation: 'backdropFadeIn 0.2s ease-out',
          }}
          onClick={() => setModalOpen(false)}
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
            <div style={{
              padding: '1rem 1.25rem 0.75rem',
              borderBottom: '1px solid var(--border)',
            }}>
              <h3 style={{
                margin: 0, fontSize: '1rem', fontWeight: 700,
                color: 'var(--text)',
              }}>
                {t('groupSwitcher.title')}
              </h3>
            </div>

            <div style={{ padding: '0.5rem', maxHeight: '300px', overflowY: 'auto' }}>
              {multiGroup.memberships.map((m, i) => {
                const isActive = m.groupId === activeGroupId;
                const badge = getRoleBadge(m);
                return (
                  <button
                    key={m.groupId}
                    onClick={() => handleSwitch(m.groupId)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '0.75rem',
                      width: '100%', padding: '0.75rem',
                      background: isActive ? 'rgba(99,102,241,0.1)' : 'transparent',
                      border: isActive ? '1px solid rgba(99,102,241,0.3)' : '1px solid transparent',
                      borderRadius: '10px', cursor: 'pointer',
                      fontFamily: 'Outfit, sans-serif',
                      textAlign: isRTL ? 'right' : 'left',
                      transition: 'background 0.2s, transform 0.15s',
                      animation: 'contentFadeIn 0.25s ease-out backwards',
                      animationDelay: `${i * 0.04}s`,
                    }}
                  >
                    <div style={{
                      width: '36px', height: '36px', borderRadius: '10px',
                      background: isActive ? 'var(--primary)' : 'var(--border)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: '1rem', flexShrink: 0,
                      color: isActive ? 'white' : 'var(--text-muted)',
                    }}>
                      {isActive ? '✓' : '🃏'}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontWeight: 600, fontSize: '0.9rem',
                        color: isActive ? 'var(--primary)' : 'var(--text)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {m.groupName}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.15rem' }}>
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
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            <div style={{
              padding: '0.75rem 1rem', borderTop: '1px solid var(--border)',
              display: 'flex', gap: '0.5rem',
            }}>
              <button
                onClick={() => { setModalOpen(false); setSetupMode('create'); }}
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
                onClick={() => { setModalOpen(false); setSetupMode('join'); }}
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
    </>
  );
}
